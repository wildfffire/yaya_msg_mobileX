/**
 * 房间未读的**第一主计数源**（用户 2026-11-13 定版、永久生效）。
 *
 * 三条通道（QChat 实时 / 5s 通知轮询 / 30s 指纹精确计数）都调这里：
 *   · 只数 `/list/homeowner`（服务端按房主过滤）里的消息；
 *   · 每次都从最新页按 `nextTime` 往前翻，直到翻到**该侧「上次看到的那条消息 id」**
 *     （utils/roomSeenRules.ts，id 为主、时间兜底），粉丝刷屏 / 50 条分页窗口都不漏；
 *   · 常规 8 页预算，翻不完记断点、下轮 5s 续翻；
 *   · **手动下拉刷新 = force**：忽略断点、上限 200 页，一次翻完，且边界严格用
 *     「上次看到的位置」，不吃任何机器进度的短路（用户 2026-11-13 明确要求）；
 *   · 「人看到哪」(roomSeenStore) 与「机器计过哪」(claimCounted 持久化 id 集合)
 *     彻底分开，重启不重计、晚到消息不被时间门槛吞掉；
 *   · 三条通道共享 `roomCountLedger` 的会话内 id 原子认领，谁先认领谁计数。
 *
 * 旧的 `/list/all` 路径全部保留，降级为「homeowner 拉失败时的兜底」：
 * 主层先把房主消息 id 认领掉，旧路径的 `claimCountId` 自然返回 false（幂等）。
 */
import pocketApi from '../api/pocket48';
import { unwrapList } from '../utils/data';
import { logInfo } from '../utils/runtimeLog';
import { isDetailFromSide, messageId, messageTime } from '../utils/roomMessageCursor';
import { messageIdAliases } from '../utils/notifyOwnerRules';
import { oldestMessageTime } from '../utils/ownerFeedRules';
import {
  pickUnreadSinceSeen,
  reachedSeenId,
  shouldContinueToSeen,
  type SeenMark,
} from '../utils/roomSeenRules';
import { claimCountId, markCountConsumed } from './roomCountLedger';
import { advanceOwnerCountedAt, ensureOwnerCountLoaded } from './roomOwnerCount';
import { claimCounted, ensureSeenLoaded, getSeen } from './roomSeenStore';
import { roomChannelId, type RoomMode } from '../screens/room/roomIdentity';

const PAGE_LIMIT = 50;
/** 常规：单次最多 8 页（400 条）；翻不完记断点，下轮接着翻 */
const MAX_PAGES_PER_CALL = 8;
/** 手动刷新：一次翻到「上次看到的位置」为止（200 页只是防异常死循环） */
const FORCE_MAX_PAGES = 200;
const LIST_KEYS = [
  'content.messageList', 'content.message', 'content.messages', 'content.list',
  'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list',
];

interface OwnerFeed {
  msgs: any[];
  newest: number;
  oldest: number;
  pages: number;
  /** 是否真的翻到了「上次看到的位置」（false = 本轮预算用尽，下轮续翻） */
  reached: boolean;
}

interface FeedRequest {
  key: string;
  id: string;
  side: RoomMode;
  member: any;
  /** 旧房间级时间基线：新 store 还没建立该侧时兜底 */
  readFloor: number;
  /** 调用方本轮已经拉到的 homeowner 首页（5s 轮询免费复用，省一个请求） */
  firstPage?: any[] | null;
  /** 手动刷新：一次翻完，不受常规页数预算/断点续翻限制 */
  force?: boolean;
}

/** 同一侧同一时刻三条通道共享一次拉取（force 单独一条，避免复用被预算截断的任务） */
const inflight = new Map<string, Promise<OwnerFeed | null>>();
/** 没翻到「上次看到的位置」→ 记下断点，下轮从 nextTime 继续 */
const pendingPages = new Map<string, { nextTime: number; seen: SeenMark | null }>();

/** 按消息 id 去重（多页/多通道合并时共用；messagePollers 不再保留第二份） */
export function dedupeMessages(list: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const m of list || []) {
    if (!m) continue;
    const id = messageId(m);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(m);
  }
  return out;
}

/** 接口给的下一页游标；没有就用本页最早消息时间兜底（与既有回溯同款） */
function nextTimeOf(res: any, list: any[]): number {
  const c = res?.content ?? res?.data ?? res;
  const direct = Number(c?.nextTime ?? c?.next ?? c?.lastTime ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return oldestMessageTime(list);
}

async function pullOwnerFeed(
  req: FeedRequest,
  seen: SeenMark | null,
  force: boolean,
): Promise<OwnerFeed | null> {
  const member = req.member || {};
  const channelId = roomChannelId(member, req.side);
  if (!channelId) return null;
  const base: any = {
    channelId,
    serverId: String(member.serverId || ''),
    limit: PAGE_LIMIT,
    fetchAll: false, // ★ 只打 /list/homeowner
  };
  if (req.side === 'small' && member.channelId) base.fallbackChannelId = String(member.channelId);

  const maxPages = force ? FORCE_MAX_PAGES : MAX_PAGES_PER_CALL;
  const pending = force ? undefined : pendingPages.get(req.key);
  const stopSeen = pending ? pending.seen : seen;
  let nextTime = pending?.nextTime || 0;
  let msgs: any[] = [];
  let pages = 0;
  let lastPageLen = 0;
  /** 累计所有已翻页消息的 id 别名：用来判断「翻到上次看到的那条了没」 */
  const pageIds = new Set<string>();
  const collect = (list: any[]) => {
    for (const m of list) for (const id of messageIdAliases(m)) pageIds.add(id);
  };
  if (!pending && req.firstPage && req.firstPage.length) {
    msgs = dedupeMessages(req.firstPage);
    collect(req.firstPage);
    pages = 1;
    lastPageLen = req.firstPage.length;
    if (!nextTime) nextTime = oldestMessageTime(req.firstPage);
  }
  let stopped = false;
  while (pages < maxPages) {
    if (pages > 0 && !shouldContinueToSeen({
      pageLength: lastPageLen,
      limit: PAGE_LIMIT,
      seen: stopSeen,
      pageIds,
      oldestTime: oldestMessageTime(msgs),
    })) { stopped = true; break; }
    let res: any;
    try {
      res = await pocketApi.getRoomMessages({ ...base, nextTime });
    } catch (e: any) {
      logInfo(`[unread] homeowner 主计数 ${req.id}#${req.side} 请求失败：${String(e?.message || e || '')}`, 'room.unread');
      return null;
    }
    // 小房间回退到大房间频道时整轮丢弃，防止串味
    if (!isDetailFromSide(res?._request?.payload?.channelId, channelId)) return null;
    const list = unwrapList(res, LIST_KEYS) || [];
    if (!list.length) { stopped = true; break; }
    const before = msgs.length;
    msgs = dedupeMessages(msgs.concat(list));
    collect(list);
    pages += 1;
    lastPageLen = list.length;
    const next = nextTimeOf(res, list);
    if (!(next > 0) || (nextTime > 0 && next >= nextTime)) { stopped = true; break; }
    nextTime = next;
    if (msgs.length === before) { stopped = true; break; }
  }
  const atSeen = stopped
    || reachedSeenId(pageIds, stopSeen)
    || !shouldContinueToSeen({
      pageLength: lastPageLen, limit: PAGE_LIMIT, seen: stopSeen,
      pageIds, oldestTime: oldestMessageTime(msgs),
    });
  if (atSeen) pendingPages.delete(req.key);
  else pendingPages.set(req.key, { nextTime, seen: stopSeen });
  let newest = 0;
  for (const m of msgs) {
    const t = messageTime(m);
    if (t > newest) newest = t;
  }
  return { msgs, newest, oldest: oldestMessageTime(msgs), pages, reached: atSeen };
}

/** 同一侧并发调用共享一次网络拉取 */
function loadOwnerFeed(req: FeedRequest, seen: SeenMark | null, force: boolean): Promise<OwnerFeed | null> {
  const cacheKey = req.key + (force ? ':force' : '');
  const running = inflight.get(cacheKey);
  if (running) return running;
  const task = pullOwnerFeed(req, seen, force)
    .finally(() => { inflight.delete(cacheKey); });
  inflight.set(cacheKey, task);
  return task;
}

export interface OwnerFeedCount {
  counted: number;
  ok: boolean;
  newest: number;
  reached: boolean;
}

/**
 * 三条通道的统一入口：拉全量房主流 → 翻到「上次看到的那条」→ 按 id 认领计数。
 * 返回 null = 本轮 homeowner 不可用，调用方降级到原 `/list/all` 路径（不静默吞消息）。
 */
export async function countOwnerFeedUnread(opts: FeedRequest & {
  presenceId?: string;
  source: string;
}): Promise<OwnerFeedCount | null> {
  await Promise.all([ensureOwnerCountLoaded(), ensureSeenLoaded()]);
  // 新 store 没建立该侧基线时（老用户升级后第一次），退回旧房间级时间基线，
  // 之后进房/退房就会写入分侧消息 id。
  const stored = getSeen(opts.key);
  const seen: SeenMark | null = stored || (opts.readFloor > 0 ? { id: '', time: opts.readFloor } : null);
  const force = opts.force === true;
  const feed = await loadOwnerFeed(opts, seen, force);
  if (!feed || !feed.msgs.length) return null;
  // 正在看的房间：整页标已读，不进角标
  if (opts.presenceId && opts.presenceId === opts.id) {
    for (const m of feed.msgs) markCountConsumed(messageId(m));
    return { counted: 0, ok: true, newest: feed.newest, reached: feed.reached };
  }
  const ids = pickUnreadSinceSeen(feed.msgs, seen);
  let counted = 0;
  for (const id of ids) {
    if (!claimCounted(opts.key, id)) continue;  // 持久化：重启不重计
    if (!claimCountId(id)) continue;           // 会话内：三通道原子去重
    counted += 1;
  }
  // 旧时间游标继续记录进度，但**不再参与边界/过滤**（只作诊断兼容）
  if (feed.reached && feed.newest > 0) advanceOwnerCountedAt(opts.key, feed.newest);
  logInfo(
    `[unread] homeowner 主计数 ${opts.id}#${opts.side} +${counted}`
    + ` 源=${opts.source} 强制=${force ? 1 : 0} 页=${feed.pages} 条=${feed.msgs.length}`
    + ` 上次看到=${seen?.id ? `id:${seen.id.slice(-8)}` : (seen ? `time:${seen.time}` : 'none')}`
    + ` 最早=${feed.oldest} 到上次看到=${feed.reached ? 1 : 0}`
    + ` 下轮续翻=${!feed.reached ? 1 : 0}`,
    'room.unread',
  );
  return { counted, ok: true, newest: feed.newest, reached: feed.reached };
}
