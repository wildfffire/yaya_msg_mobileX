/**
 * 手动下拉刷新的「本轮共享页」（用户 2026-11-14：计数 / 角标 / 列表新消息 / 预览
 * 要在短时间内同时到位）。
 *
 * 一次下拉里，原本 force 主计数、预览快扫、5s 轮询、30s 指纹会把同一侧最新的
 * `/list/all` 页和 `/list/homeowner` 页各拉一遍，甚至各起一条 homeowner 翻页链。
 * 这里把它们收敛成「本轮一份」：预热阶段按侧各拉一次，三条链只读这一份数据。
 *
 * 纪律：
 *   · 零 React / 零网络 / 零业务依赖，纯数据 + 纯规则，可直接编译进 Node 单测；
 *   · 只在本轮刷新生命周期内有效（begin → end），不持久化、不参与任何计数口径判定；
 *   · 代次隔离：跨轮的写入/读取一律无效，避免上一次刷新的旧页污染下一轮；
 *   · 只共享「消息页」，绝不共享已算好的计数数值 —— 下游仍要走
 *     pickUnreadSinceSeen 与两级消息 id 认领重算，否则会重复累加角标。
 */
export interface SharedAllPage {
  /** 已 unwrap 的 /list/all 最新一页 */
  list: any[];
  /** 原始响应：预览要校验 _request.label 与 _request.payload.channelId（防串味） */
  res: any;
}

export interface SharedOwnerFirstPage {
  /** 已 unwrap 的 /list/homeowner 首页 */
  list: any[];
  /** 该页实际请求的 limit，必须与 force 翻页 limit 一致，否则「页不满」会误判提前停 */
  limit: number;
}

/** 与 roomOwnerFeed.ts 的 OwnerFeed 同构（这里不 import 业务模块，避免循环依赖） */
export interface SharedForceFeed {
  msgs: any[];
  newest: number;
  oldest: number;
  pages: number;
  reached: boolean;
}

const MAX_SIDE_KEYS = 400; // 200 房间 × 大/小两侧

let roundSeq = 0;
let activeRound = 0;
let allPages = new Map<string, SharedAllPage>();
let ownerFirstPages = new Map<string, SharedOwnerFirstPage>();
let forceFeeds = new Map<string, SharedForceFeed>();
/** 每侧预热的完成信号：消费者按侧等，慢的一侧只拖自己、不拖整轮 */
let sideReady = new Map<string, Promise<void>>();

/** 开一轮刷新：清空上一轮残留并返回代次（0 表示「当前没有刷新轮」） */
export function beginRefreshRound(): number {
  roundSeq += 1;
  activeRound = roundSeq;
  allPages = new Map();
  ownerFirstPages = new Map();
  forceFeeds = new Map();
  sideReady = new Map();
  return activeRound;
}

export function activeRefreshRound(): number {
  return activeRound;
}

/** 只清自己的代次：迟到的旧轮结束不能把新轮的数据一起清掉 */
export function endRefreshRound(round: number): void {
  if (!(round > 0) || round !== activeRound) return;
  activeRound = 0;
  allPages = new Map();
  ownerFirstPages = new Map();
  forceFeeds = new Map();
  sideReady = new Map();
}

function usable(round: number, key: string): boolean {
  return round > 0 && round === activeRound && !!key;
}

/** 预热开始前先登记按侧信号，消费者才不会在共享页尚未落地时抢跑回落 */
export function putSharedSideReady(round: number, key: string, task: Promise<unknown>): void {
  if (!usable(round, key)) return;
  sideReady.set(key, task.then(() => undefined, () => undefined));
}

/** 等这一侧的两组预热请求落地；不在刷新轮内时立即返回 */
export async function waitSharedSideReady(round: number, key: string): Promise<void> {
  if (!usable(round, key)) return;
  const p = sideReady.get(key);
  if (p) await p;
}

export function putSharedAllPage(round: number, key: string, list: any[], res: any): void {
  if (!usable(round, key) || !Array.isArray(list) || !list.length) return;
  if (!res) return;
  if (allPages.size >= MAX_SIDE_KEYS && !allPages.has(key)) return;
  allPages.set(key, { list, res });
}

export function sharedAllPage(round: number, key: string): SharedAllPage | null {
  if (!usable(round, key)) return null;
  return allPages.get(key) || null;
}

export function putSharedOwnerFirstPage(round: number, key: string, list: any[], limit: number): void {
  if (!usable(round, key) || !Array.isArray(list) || !list.length || !(limit > 0)) return;
  if (ownerFirstPages.size >= MAX_SIDE_KEYS && !ownerFirstPages.has(key)) return;
  ownerFirstPages.set(key, { list, limit });
}

export function sharedOwnerFirstPage(round: number, key: string): SharedOwnerFirstPage | null {
  if (!usable(round, key)) return null;
  return ownerFirstPages.get(key) || null;
}

/** force 翻完的房主流：本轮内给 5s 轮询 / 30s 指纹复用，省掉第二条翻页链 */
export function putSharedForceFeed(round: number, key: string, feed: SharedForceFeed): void {
  if (!usable(round, key) || !feed || !Array.isArray(feed.msgs) || !feed.msgs.length) return;
  if (forceFeeds.size >= MAX_SIDE_KEYS && !forceFeeds.has(key)) return;
  forceFeeds.set(key, feed);
}

export function sharedForceFeed(round: number, key: string): SharedForceFeed | null {
  if (!usable(round, key)) return null;
  return forceFeeds.get(key) || null;
}

/**
 * 首页能否作为 force 翻页的第一页。
 *
 * ⚠️ 最易踩的坑：shouldContinueToSeen 用「pageLength < limit」判「没有更早的了」。
 * 若首页是 50 条而 force 每页 100 条，第一轮循环就会误判页不满、直接 break 漏计。
 */
export function sharedPageLimitMatches(page: SharedOwnerFirstPage | null, limit: number): boolean {
  return !!page
    && Array.isArray(page.list)
    && page.list.length > 0
    && Number(page.limit) === Number(limit);
}

/* ── 翻页增量去重（供 roomOwnerFeed.ts 使用，单独抽出来才能上纯 Node 单测） ── */

export interface PageAccumulator {
  msgs: any[];
  ids: Set<string>;
  newest: number;
  oldest: number;
}

export function newPageAccumulator(): PageAccumulator {
  return { msgs: [], ids: new Set(), newest: 0, oldest: 0 };
}

/**
 * 增量追加一页：按消息 id 去重（无 id 的消息一律保留，与旧 dedupeMessages 同语义），
 * 同时增量维护 newest / oldest。
 *
 * 旧实现每页 `dedupeMessages(msgs.concat(list))` 会全量重建数组，200 页时 O(P²×limit)；
 * 这里每页只扫新页一次，O(P×limit)，且结果与旧全量去重逐条等价。
 * 返回本页实际新增的条数（调用方据此判断「整页重复」并停止翻页）。
 */
export function appendPageMessages(
  acc: PageAccumulator,
  list: any[] | null | undefined,
  idOf: (m: any) => string,
  timeOf: (m: any) => number,
): number {
  const before = acc.msgs.length;
  for (const m of Array.isArray(list) ? list : []) {
    if (!m) continue;
    const id = String(idOf(m) || '');
    if (id && acc.ids.has(id)) continue;
    if (id) acc.ids.add(id);
    acc.msgs.push(m);
    const t = Number(timeOf(m)) || 0;
    if (t > acc.newest) acc.newest = t;
    if (t > 0 && (!acc.oldest || t < acc.oldest)) acc.oldest = t;
  }
  return acc.msgs.length - before;
}

/* ── 串味侧负缓存（跨轮，带 TTL） ─────────────────────────────
 *
 * 真机 b3000068：部分侧的请求会被服务端回退到大房间频道（实际 ch 不是本侧），
 * tryPocketPost 串行试 4~6 次、3.4~3.9s，结果仍被 isDetailFromSide 丢弃。
 * 预热 / force 主计数 / 预览三条链都会各自踩一次，所以这个集合放在共享模块统一判定。
 * 带 TTL 且拿到本侧页就自愈，避免房间频道后续开通时被永久跳过。
 */
/** 24 小时：覆盖「很久没打开」（隔夜 / 一天）的场景；到期后首轮自动重新探测，成功即自愈 */
export const CROSS_SIDE_TTL_MS = 24 * 60 * 60 * 1000;
const crossSideChannels = new Map<string, number>();

export function isCrossSideChannel(channelId: string, now: number = Date.now()): boolean {
  if (!channelId) return false;
  const until = crossSideChannels.get(channelId) || 0;
  if (until > now) return true;
  if (until) crossSideChannels.delete(channelId);
  return false;
}

export function markCrossSideChannel(channelId: string, now: number = Date.now()): void {
  if (!channelId) return;
  if (crossSideChannels.size > 200) crossSideChannels.clear();
  crossSideChannels.set(channelId, now + CROSS_SIDE_TTL_MS);
}

export function clearCrossSideChannel(channelId: string): void {
  if (channelId) crossSideChannels.delete(channelId);
}

/** 导出未过期的条目供宿主持久化；顺手淘汰过期项，避免存储无限增长 */
export function exportCrossSideChannels(now: number = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ch, until] of crossSideChannels) {
    if (until > now) out[ch] = until;
    else crossSideChannels.delete(ch);
  }
  return out;
}

/** 冷启动恢复：只接受仍有效的绝对过期时间，脏数据一律忽略 */
export function restoreCrossSideChannels(data: unknown, now: number = Date.now()): number {
  if (!data || typeof data !== 'object') return 0;
  let restored = 0;
  for (const [ch, until] of Object.entries(data as Record<string, unknown>)) {
    const t = Number(until) || 0;
    if (ch && t > now) { crossSideChannels.set(ch, t); restored += 1; }
  }
  return restored;
}
