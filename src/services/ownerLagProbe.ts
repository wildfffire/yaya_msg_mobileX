/**
 * homeowner 接口滞后实验 v2（只读诊断，不参与计数 / 游标 / 通知）。
 *
 * 从 messagePollers.ts 整块搬出（用户 2026-11-13「相关信息轮次太多，整合一下」）：
 * 这块实验独立拥有 12 个模块级状态和第 4 套「房主画像」判定，之前混在 5s 轮询主流程里，
 * 让 pollRooms 更难读。搬出后 messagePollers 只保留两处调用：
 *   · 有 homeowner 免费页时 `logOwnerLag(...)`；
 *   · 安静时段的探针 `probeOwnerLag(...)`。
 *
 * ★ 旧实验（v1）错在哪：`all页最新时间 − homeowner页最新时间`。all 页是粉丝+房主混合流，
 *   homeowner 页只有房主消息，这个差值量到的是「房主多久没说话」，不是接口延迟
 *   —— 真机才会打出 平均滞后 6102s / 最大 81941s 这种荒谬数字；旧「覆盖率」的分母
 *   又是 all 页总条数（绝大多数本来就是粉丝消息），恒定 13~20%，同样没有意义。
 *
 * ★ v2 的正确判据（纯规则见 utils/ownerLagRules.ts）：同一条消息 id
 *   「首次在 /list/all 被看到的挂钟时刻」→「首次在 /list/homeowner 被看到的挂钟时刻」
 *   之差。与消息自身的 msgTime 无关，因此不受房主发言间隔污染；同一轮两页都可见
 *   记为「同轮可见」（延迟上界 = 一次采样间隔）。
 *
 * 采样：① 免费样本 = 本轮本来就拉了 homeowner 页（有新消息时）；
 *       ② 探针 = 安静时段每 30s 轮转一个侧，**有待配对消息的侧优先**；
 *       ③ 有待配对消息的侧会被加进本轮 check，每 5s 重拉一次，直到配对或超时。
 * 实验只读消息、只写自己的追踪表与日志，绝不碰计数 / 游标 / 通知。
 */
import { senderProfile } from '../screens/room/messageRules';
import { normMemberName } from '../utils/memberMatch';
import { firstVisibleLagMs, ownerLagSnapshot, summarizeLag } from '../utils/ownerLagRules';
import { logInfo } from '../utils/runtimeLog';
import { logDiag } from './pollerDiag';

/** 探针固定间隔：安静时段每 30s 轮转一个侧 */
export const OWNER_PROBE_GAP_MS = 30_000;
const OWNER_SUMMARY_GAP_MS = 10 * 60_000;
/** 待配对消息最长跟踪 3 分钟：超时记「疑似未收录/非房主」，防追踪表与请求量失控 */
export const OWNER_LAG_PENDING_TTL_MS = 3 * 60_000;

/** 探针只需要房间分侧的最小信息（结构兼容 messagePollers 的 RoomSideTarget） */
export interface OwnerLagSide {
  key: string;
  id: string;
  side: string;
  member: any;
}

export interface OwnerLagPage {
  list: any[] | null;
  crossSide: boolean;
}

let ownerProbeAt = 0;
let ownerProbeCursor = 0;
let ownerSummaryAt = 0;
/** sideKey -> msgId -> 首次在 /list/all 见到的挂钟时刻（ms） */
const ownerLagPending = new Map<string, Map<string, number>>();
/** sideKey -> 房主身份画像（从 homeowner 页历史消息学到，只用来筛选候选，不用来测延迟） */
const ownerLagIdentities = new Map<string, { ids: Set<string>; names: Set<string> }>();
const ownerLagStat = { samples: [] as number[], sameRound: 0, hit: 0, total: 0, missed: 0 };
/** 每侧上次计入统计的时间（60s 内重复样本不重复计数，避免热闹房间把样本刷爆） */
const ownerLagSampledAt = new Map<string, number>();

function hhmm(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** senderProfile 在资料缺失时会造出「未知用户 / 用户 123」这类占位名，不能进房主画像 */
function usableSenderName(raw: string): string {
  const name = String(raw || '').trim();
  if (!name || /^(未知用户|用户\s?\d)/.test(name)) return '';
  return normMemberName(name);
}

/** 从房主流的历史消息里学房主身份（id / 昵称），只用于判断 all 页里哪条「可能是房主」 */
function learnOwnerIdentity(s: OwnerLagSide, ownerPage: any[]): void {
  let identity = ownerLagIdentities.get(s.key);
  if (!identity) {
    identity = { ids: new Set<string>(), names: new Set<string>() };
    ownerLagIdentities.set(s.key, identity);
  }
  for (const m of ownerPage) {
    const p = senderProfile(m, s.member);
    const id = String(p?.id || '').trim();
    if (id && identity.ids.size < 200) identity.ids.add(id);
    const name = usableSenderName(String(p?.name || ''));
    if (name && identity.names.size < 50) identity.names.add(name);
  }
}

function isOwnerByIdentity(msg: any, s: OwnerLagSide): boolean {
  const identity = ownerLagIdentities.get(s.key);
  if (!identity) return false;
  const p = senderProfile(msg, s.member);
  const id = String(p?.id || '').trim();
  if (id && identity.ids.has(id)) return true;
  const name = usableSenderName(String(p?.name || ''));
  return !!name && identity.names.has(name);
}

/** 该侧是否有「已在 all 页出现、但还没在 homeowner 页出现」的待配对消息 */
export function ownerLagWanted(sideKey: string): boolean {
  return (ownerLagPending.get(sideKey)?.size || 0) > 0;
}

/** 同一时刻两页对照 + 跨轮结算（不含消息正文，只打计数与时间） */
export function logOwnerLag(
  s: OwnerLagSide,
  allList: any[],
  ownerList: any[],
  source: string,
  resolutionMs: number,
): void {
  const now = Date.now();
  learnOwnerIdentity(s, ownerList);
  const snap = ownerLagSnapshot(allList, ownerList, (m) => isOwnerByIdentity(m, s));
  // ① 结算：之前挂起的消息本轮出现在房主流里 → 得到端到端可见延迟
  let pending = ownerLagPending.get(s.key);
  let resolved = 0;
  let lastLag = -1;
  if (pending && pending.size) {
    for (const [mid, firstSeenAt] of Array.from(pending.entries())) {
      if (snap.ownerIds.has(mid)) {
        const lag = firstVisibleLagMs(firstSeenAt, now);
        if (lag >= 0) { ownerLagStat.samples.push(lag); lastLag = lag; resolved += 1; }
        pending.delete(mid);
      } else if (now - firstSeenAt > OWNER_LAG_PENDING_TTL_MS) {
        ownerLagStat.missed += 1;
        pending.delete(mid);
      }
    }
  }
  // ② 新候选：混合流里有、房主流里还没有的房主消息，记下首次可见时刻
  if (snap.pendingIds.length) {
    if (!pending) { pending = new Map<string, number>(); ownerLagPending.set(s.key, pending); }
    for (const mid of snap.pendingIds) if (!pending.has(mid)) pending.set(mid, now);
  }
  if (pending && !pending.size) ownerLagPending.delete(s.key);

  if (now - (ownerLagSampledAt.get(s.key) || 0) >= 60_000) {
    ownerLagSampledAt.set(s.key, now);
    ownerLagStat.sameRound += snap.sameRound;
    ownerLagStat.hit += snap.recallHit;
    ownerLagStat.total += snap.recallTotal;
  }
  logDiag(
    `room.homeowner.${s.key}`,
    `[unread] homeowner 滞后实验 v2 ${s.id}#${s.side} 源=${source}`
    + ` 同轮可见=${snap.sameRound} 覆盖率=${snap.recallHit}/${snap.recallTotal}`
    + ` 窗口外=${snap.outsideWindow} homeowner最新=${hhmm(snap.ownerNewest)}`
    + ` 待配对=${pending?.size || 0} 本轮新配对=${resolved}`
    + ` 最近延迟=${lastLag >= 0 ? `${lastLag}ms` : '-'}`
    + ` 分辨率=${source === '探针' ? OWNER_PROBE_GAP_MS : resolutionMs}ms`,
  );
  if (ownerLagStat.samples.length > 500) {
    ownerLagStat.samples.splice(0, ownerLagStat.samples.length - 500);
  }
  if (now - ownerSummaryAt >= OWNER_SUMMARY_GAP_MS) {
    ownerSummaryAt = now;
    const sum = summarizeLag(ownerLagStat.samples);
    const rate = ownerLagStat.total ? Math.round((ownerLagStat.hit / ownerLagStat.total) * 100) : 0;
    logInfo(
      `[unread] homeowner 实验汇总 v2 滞后样本=${sum.count} 平均=${sum.avgMs}ms`
      + ` P50=${sum.p50Ms}ms 最大=${sum.maxMs}ms 同轮可见=${ownerLagStat.sameRound}`
      + ` 覆盖率=${rate}%（${ownerLagStat.hit}/${ownerLagStat.total}）`
      + ` 疑似未收录=${ownerLagStat.missed}`,
      'room.unread',
    );
  }
}

export interface OwnerLagProbeOptions<T extends OwnerLagSide> {
  sides: T[];
  /** 本轮已经免费采样过的侧（不再重复探，省一个请求） */
  alreadySampled: Set<string> | Map<string, unknown>;
  fetchAll: (side: T) => Promise<OwnerLagPage>;
  fetchOwner: (side: T) => Promise<OwnerLagPage>;
}

/**
 * 安静时段探针：每 30s 轮转一个侧，有待配对消息的侧优先。
 * 失败绝不影响轮询本身。
 */
export async function probeOwnerLag<T extends OwnerLagSide>(opts: OwnerLagProbeOptions<T>): Promise<void> {
  const sides = Array.isArray(opts.sides) ? opts.sides : [];
  if (!sides.length) return;
  const now = Date.now();
  if (now - ownerProbeAt < OWNER_PROBE_GAP_MS) return;
  ownerProbeAt = now;
  ownerProbeCursor = (ownerProbeCursor + 1) % sides.length;
  // ★ 有待配对消息的侧优先探：安静时段 20 侧轮转一轮要 10 分钟，测不出秒级延迟
  const pendingSide = sides.find((s) => ownerLagWanted(s.key));
  const probe = pendingSide || sides[ownerProbeCursor];
  if (!probe || opts.alreadySampled.has(probe.key)) return;
  try {
    const [allPage, ownerPage] = await Promise.all([
      opts.fetchAll(probe),
      opts.fetchOwner(probe),
    ]);
    if (allPage.list && ownerPage.list && !allPage.crossSide && !ownerPage.crossSide) {
      logOwnerLag(probe, allPage.list, ownerPage.list, '探针', OWNER_PROBE_GAP_MS);
    }
  } catch {
    /* 实验失败不影响轮询 */
  }
}
