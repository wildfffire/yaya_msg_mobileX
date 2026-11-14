/**
 * 房间列表「大/小各一条最新消息」快速刷新的纯规则（零依赖，可单测）。
 *
 * 背景（用户 2026-11-13「房间列表里大小房间各展示一条消息，这个有些延迟」）：
 * 列表预览的主通道是 30s 的 `last/message/get`，而真正正确的正文来自详情页；
 * 详情页只在 5s 通知轮询判定「预览指纹变化」或 60s 一次全量 sweep 时才拉，
 * 真机 logcat 实证「查详情=20」每 ~65s 才出现一次，其余轮次全是 0。
 *
 * 这里只负责三件事：分侧目标、分片轮转（把请求摊平，不让某一轮爆量）、
 * 从详情页一页里挑出「最新一条偶像发言」。不碰计数 / 游标 / 通知 / 角标。
 */

export type PreviewSide = 'big' | 'small';

export interface PreviewSideTarget {
  /** 成员 id（与 roomUnreadKey 同一套口径） */
  id: string;
  side: PreviewSide;
  /** 成员库原始对象：房主严格判定要用 */
  member: any;
  /** 本侧频道 id：大房间 channelId / 小房间 yklzId */
  channelId: string;
  /** 圈组 serverId（大房间的；小房间共用同一个） */
  serverId: string;
}

/** 默认最多扫 36 侧（18 个房间 × 大/小），防止关注列表异常膨胀把请求撑爆 */
export const PREVIEW_SIDE_MAX = 36;
/** 默认分 3 片，按 5s 一轮即 15s 覆盖全部侧 */
export const PREVIEW_CHUNK_COUNT = 3;

/** 从关注行生成「房间 + 侧」任务：两侧分开、同键去重、缺 id 跳过 */
export function buildPreviewSides(rows: any[] | undefined | null, maxSides: number = PREVIEW_SIDE_MAX): PreviewSideTarget[] {
  const out: PreviewSideTarget[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(rows)) return out;
  const cap = Number.isFinite(maxSides) && maxSides > 0 ? Math.floor(maxSides) : PREVIEW_SIDE_MAX;
  for (const row of rows) {
    const member = row?.member;
    const id = String(row?.memberId || member?.id || '');
    if (!id || !member || out.length >= cap) continue;
    const serverId = String(member.serverId || '');
    const targets: Array<{ side: PreviewSide; channelId: string }> = [
      { side: 'big', channelId: String(member.channelId || '') },
      { side: 'small', channelId: String(member.yklzId || '') },
    ];
    for (const t of targets) {
      if (!t.channelId || out.length >= cap) continue;
      const key = `${id}#${t.side}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, side: t.side, member, channelId: t.channelId, serverId });
    }
  }
  return out;
}

/**
 * 本轮要扫的侧：按 `round` 轮转取一片，若干轮内覆盖全部。
 * 起点随轮次前移，保证被截掉的侧下一轮优先，不会永远饿死。
 */
export function previewSidesForRound<T>(sides: T[], round: number, chunkCount: number = PREVIEW_CHUNK_COUNT): T[] {
  const n = Array.isArray(sides) ? sides.length : 0;
  if (!n) return [];
  const chunks = Number.isFinite(chunkCount) && chunkCount > 0 ? Math.floor(chunkCount) : PREVIEW_CHUNK_COUNT;
  const size = Math.max(1, Math.ceil(n / chunks));
  const take = Math.min(size, n);
  const r = Number.isFinite(round) && round > 0 ? Math.floor(round) : 0;
  const start = (r * size) % n;
  const out: T[] = [];
  for (let i = 0; i < take; i += 1) out.push(sides[(start + i) % n]);
  return out;
}

export interface PickPreviewOptions<T> {
  /** 是否是可展示的聊天消息（媒体 / 通知等不参与） */
  isChat: (msg: T) => boolean;
  /** 是否房主本人发言（严格判定，粉丝发言不能顶上预览） */
  isOwner: (msg: T) => boolean;
  /** 服务器消息时间（ms；0 = 未知） */
  timeOf: (msg: T) => number;
  /** 只扫页内最近多少条（页是「新 → 老」） */
  scanLimit?: number;
}

/**
 * 从 `/list/all` 一页里挑「最新一条偶像发言」：
 * 时间最大的那条胜出；全都拿不到时间时保留页内最靠前（最新）的那条。
 * 一页里没有偶像发言就返回 null —— 绝不拿粉丝消息把预览拽走。
 */
export function pickPreviewMessage<T>(list: T[] | undefined | null, opts: PickPreviewOptions<T>): T | null {
  if (!Array.isArray(list) || !opts) return null;
  const limit = Number.isFinite(opts.scanLimit) && (opts.scanLimit as number) > 0
    ? Math.floor(opts.scanLimit as number)
    : 80;
  let best: T | null = null;
  let bestTime = -1;
  for (const msg of list.slice(0, limit)) {
    if (!msg || !opts.isChat(msg) || !opts.isOwner(msg)) continue;
    const t = Number(opts.timeOf(msg)) || 0;
    if (!best || t > bestTime) {
      best = msg;
      bestTime = t;
    }
  }
  return best;
}
