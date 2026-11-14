/**
 * 「homeowner 作为第一主计数源」的纯规则（用户 2026-11-13 定版、永久生效）。
 *
 * 用户原话：「以后把 /list/homeowner 的数据作为第一位的，实时 / 5s 轮询 / 30s 指纹
 * 三条通道都是，作为主要计数源。并且保证每次计数都到上一次看到的位置为止」。
 *
 * 含义拆成两件事：
 *   ① 三条通道不再各自从 `/list/all` 里靠本地昵称 / id 表认房主，统一数
 *      `/list/homeowner`（服务端按房主过滤的权威流）的消息；
 *   ② 每次计数都不能只看最新一页 —— 要从最新页按 `nextTime` 一直往前翻，
 *      直到「上一次看到的位置」（房间级 `lastReadAt`）为止，把这段里所有房主
 *      聊天消息按 id 认领，粉丝刷屏 / 50 条分页窗口都不能造成漏计。
 *
 * 零 React / 零网络依赖，可直接编译进 `npm run test:core` 单测。
 */
import { isCountableChatMessage, messageId, messageTime } from './roomMessageCursor';

/**
 * 翻页下限 = 「上次看到的位置」与「上次已完整计数到的位置」中较晚者。
 *
 * `lastReadAt` 进房/退房/一键已读才推进；`countedAt` 是上一次**完整翻到边界**
 * 后记下的最新房主消息时间。取较晚者不会漏：`(lastReadAt, countedAt]` 这段
 * 上一次已经全量处理过，再翻只是白打请求。
 * 两者都为 0（从没读过这个房间）→ 返回 0，调用方只建基线不计数。
 */
export function ownerFeedBoundary(lastReadAt: number, countedAt: number): number {
  const a = Number(lastReadAt) || 0;
  const b = Number(countedAt) || 0;
  return Math.max(a, b);
}

/**
 * 是否还没翻到「上一次看到的位置」。
 *
 * ⚠️ 这里**不含页数预算**：预算由调用方的 while 控制。判据若把「预算用尽」也算成
 * 「到边界」，就会在翻不完时把断点丢掉、且把游标推到最新 —— 更早那段房主消息
 * 从此被时间门槛挡死（正是要保证不漏的地方）。
 */
export function shouldContinueOwnerPage(input: {
  pageLength: number;
  limit: number;
  boundary: number;
  /** 目前累计到的最早消息时间（0 = 全都没时间字段） */
  oldestTime: number;
}): boolean {
  if ((Number(input.pageLength) || 0) < (Number(input.limit) || 0)) return false; // 没有更早的了
  const boundary = Number(input.boundary) || 0;
  if (!(boundary > 0)) return false; // 没有基线：只拉一页建基线，不翻历史
  const oldest = Number(input.oldestTime) || 0;
  if (oldest > 0 && oldest <= boundary) return false; // 已翻到上次看到的位置
  return true;
}

/** 一页里最早的消息时间（全部时间字段缺失时 0） */
export function oldestMessageTime(list: any[] | null | undefined): number {
  let oldest = 0;
  for (const m of Array.isArray(list) ? list : []) {
    const t = messageTime(m);
    if (t > 0 && (!oldest || t < oldest)) oldest = t;
  }
  return oldest;
}

export interface OwnerFeedPick {
  /** 该认领计数的消息 id（去重后） */
  ids: string[];
  /** 全量页里最新的消息时间（用于推进计数游标） */
  newest: number;
  /** 全量页里最早的消息时间（用于判断是否翻到边界） */
  oldest: number;
}

/**
 * 从「翻到上次看到的位置」的全量房主流里挑出该计数的消息。
 * 门槛：聊天类 + 时间有效 + 严格晚于已读基线 + 严格晚于上次完整计数位置；
 * 同一条消息由 `roomCountLedger.claimCountId` 在三条通道间原子去重。
 */
export function pickOwnerFeedMessages(
  list: any[] | null | undefined,
  opts: { readFloor: number; countedAt: number },
): OwnerFeedPick {
  const read = Number(opts?.readFloor) || 0;
  const counted = Number(opts?.countedAt) || 0;
  const msgs = Array.isArray(list) ? list.filter(Boolean) : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  let newest = 0;
  let oldest = 0;
  for (const m of msgs) {
    const t = messageTime(m);
    if (t > newest) newest = t;
    if (t > 0 && (!oldest || t < oldest)) oldest = t;
    if (!(read > 0)) continue;            // 没已读基线 = 首次基线，只建不数
    if (!(t > 0) || t <= read || t <= counted) continue;
    if (!isCountableChatMessage(m)) continue;
    const id = messageId(m);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids, newest, oldest };
}
