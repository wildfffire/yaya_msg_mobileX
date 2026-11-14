/**
 * homeowner「接口延迟」实验的纯规则 v2（用户 2026-11-13「再进行一次正确的滞后实验」）。
 *
 * ★ 旧实验错在哪：
 *   `lagSec = all页最新消息时间 − homeowner页最新消息时间`。all 页是粉丝+房主混合流，
 *   homeowner 页只有房主消息，所以这个差值量到的是「房主多久没说话」，
 *   不是接口延迟 —— 真机上才会出现 6102s / 81941s 这种荒谬数字。
 *   同理旧 `覆盖率 = all 页里命中 homeowner 表的条数 / all 页总条数`，
 *   分母里绝大多数本来就是粉丝消息，恒定很低，也说明不了召回。
 *
 * ★ 正确判据：**同一条消息 id，首次在两个接口被看到的挂钟时刻之差**。
 *   ① 某 id 首次出现在 `/list/all` → 记 `firstSeenAllAt = Date.now()`；
 *   ② 后续轮次它首次出现在 `/list/homeowner` → 记 `firstSeenOwnerAt = Date.now()`；
 *   ③ `lag = firstSeenOwnerAt − firstSeenAllAt`，与消息自身的 msgTime 无关，
 *      因此不会被「房主发言间隔」污染。
 *   ④ 同一轮两页就都可见 → 延迟上界 = 采样间隔（5s 轮询 / 30s 探针），记为同轮可见基线。
 *
 * 分辨率说明：延迟只能按采样间隔取整，日志里必须标明采样间隔，不能把
 * 「同轮可见」当成 0ms 精确值（只是 ≤ 一次采样间隔）。
 *
 * 零 React / 零网络依赖，可直接编译进 `npm run test:core` 单测。
 */
import { messageId, messageTime } from './roomMessageCursor';
import { messageIdAliases } from './notifyOwnerRules';

/** 一批消息的全部 id 别名（两个接口可能给不同的 id 字段） */
export function aliasSet(list: any[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of Array.isArray(list) ? list : []) {
    for (const id of messageIdAliases(m)) out.add(id);
  }
  return out;
}

export interface OwnerLagSnapshot {
  ownerIds: Set<string>;
  allIds: Set<string>;
  /** homeowner 页最早消息时间：更早的房主消息是被 50 条分页窗口挤出去的，不算接口滞后 */
  ownerOldest: number;
  ownerNewest: number;
  /** 同时刻两页都可见的房主消息条数（零延迟基线） */
  sameRound: number;
  /** 房主流召回：all 页里识别为房主、且落在 homeowner 页窗口内的消息，有多少被收录 */
  recallHit: number;
  recallTotal: number;
  /** all 页里有、homeowner 页里还没有的房主消息 id（跨轮追踪候选） */
  pendingIds: string[];
  /** 落在 homeowner 页分页窗口之外、已从召回统计里排除的条数 */
  outsideWindow: number;
}

/**
 * 同一时刻拉到的两页对照。
 * `isOwner` 由调用方注入（用**房主身份画像**：从 homeowner 页历史消息里学到的
 * 发送者 id / 昵称），不依赖当前 homeowner 页的 id 表 —— 否则就成了自己测自己。
 */
export function ownerLagSnapshot(
  allList: any[] | null | undefined,
  ownerPage: any[] | null | undefined,
  isOwner: (msg: any) => boolean,
): OwnerLagSnapshot {
  const all = Array.isArray(allList) ? allList.filter(Boolean) : [];
  const owners = Array.isArray(ownerPage) ? ownerPage.filter(Boolean) : [];
  const ownerIds = aliasSet(owners);
  const allIds = aliasSet(all);
  let ownerOldest = 0;
  let ownerNewest = 0;
  for (const m of owners) {
    const t = messageTime(m);
    if (t > 0 && (!ownerOldest || t < ownerOldest)) ownerOldest = t;
    if (t > ownerNewest) ownerNewest = t;
  }
  let sameRound = 0;
  for (const m of owners) {
    if (messageIdAliases(m).some((id) => allIds.has(id))) sameRound += 1;
  }
  let recallHit = 0;
  let recallTotal = 0;
  let outsideWindow = 0;
  const pendingIds: string[] = [];
  const seen = new Set<string>();
  for (const m of all) {
    if (!isOwner(m)) continue;
    const t = messageTime(m);
    // 分页窗口外的旧房主消息：不是接口滞后，是这一页根本装不下
    if (ownerOldest > 0 && t > 0 && t < ownerOldest) { outsideWindow += 1; continue; }
    const aliases = messageIdAliases(m);
    const id = messageId(m);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    recallTotal += 1;
    if (aliases.some((a) => ownerIds.has(a))) recallHit += 1;
    else pendingIds.push(id);
  }
  return {
    ownerIds, allIds, ownerOldest, ownerNewest,
    sameRound, recallHit, recallTotal, pendingIds, outsideWindow,
  };
}

/**
 * 端到端可见延迟（挂钟 ms）。两个时刻都必须有效；同轮可见时调用方应传同一个时刻，
 * 得到 0 —— 语义是「≤ 一个采样间隔」，不是精确的 0ms。
 */
export function firstVisibleLagMs(firstSeenAllAt: number, firstSeenOwnerAt: number): number {
  const a = Number(firstSeenAllAt) || 0;
  const b = Number(firstSeenOwnerAt) || 0;
  if (!(a > 0) || !(b > 0)) return -1;
  return Math.max(0, b - a);
}

export interface OwnerLagSummary {
  count: number;
  avgMs: number;
  maxMs: number;
  p50Ms: number;
}

export function summarizeLag(values: number[]): OwnerLagSummary {
  const samples = (Array.isArray(values) ? values : [])
    .map((v) => Number(v) || 0)
    .filter((v) => v >= 0)
    .sort((a, b) => a - b);
  if (!samples.length) return { count: 0, avgMs: 0, maxMs: 0, p50Ms: 0 };
  return {
    count: samples.length,
    avgMs: Math.round(samples.reduce((s, v) => s + v, 0) / samples.length),
    maxMs: samples[samples.length - 1],
    p50Ms: samples[Math.floor(samples.length / 2)],
  };
}
