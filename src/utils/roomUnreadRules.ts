/**
 * 房间未读的「大房间 / 小房间」分侧规则（纯函数，零依赖，便于单测钉住）。
 *
 * 用户要求（2026-09-30）：房间列表里的新消息必须**区分大房间与小房间**，
 * 数字显示在该侧那一行的「大」/「小」标签旁边 —— 以前是一个房间一个总数挂在房间名后面，
 * 看不出新消息来自哪一侧（大房间多是公开聊天，小房间更像成员私语，处理优先级不同）。
 *
 * 为什么单独抽出这一层：分侧之后 `counts` 与 `seenTokens` 都换成
 * `${memberId}#b` / `${memberId}#s` 这种复合键。键拼错不会抛异常，
 * 只会静默显示「数字恒为 0」或「两侧串味」—— 这类错误只能靠可单测的纯函数兜住。
 *
 * ★ 2026-11-10 定版：**单一数据源**。房间行角标、新消息上浮排序、Rooms tab 总数
 * 全部只认 `roomUnreadCounts`；`seenTokens` / `lastReadAt` 仍服务 30s 精确计数与
 * 「上次看到这里」，但不再参与「有没有新消息 / 显示什么」的判定。
 */

/** 未读的一侧：大房间（channelId）/ 小房间（yklzId） */
export type RoomUnreadSide = 'big' | 'small';

/** 两侧的稳定遍历顺序（渲染与遍历都用它，避免 Object.keys 顺序不稳） */
export const ROOM_UNREAD_SIDES: RoomUnreadSide[] = ['big', 'small'];

/**
 * 分侧复合键（**通用**）：`${memberId}#b` / `${memberId}#s`。
 *
 * 未读计数、已见指纹、以及房间消息的内存缓存/归属都共用这一套键规则：
 * 用两个不同前缀（或某处用裸 memberId）只会增加「两侧串味」的机会 ——
 * 用户 2026-10-01 反馈的「小房间被大房间消息取代」其中一条根因就是
 * 消息缓存此前用裸 roomId 当键，小房间的首屏被写进了大房间的缓存槽。
 *
 * 空 memberId 返回空串（调用方据此跳过，避免写出 `#b` 这种「无主键」）。
 */
export function roomSideKey(memberId: string | number | undefined | null, side: RoomUnreadSide): string {
  const id = String(memberId ?? '');
  if (!id) return '';
  return `${id}#${side === 'small' ? 's' : 'b'}`;
}

/**
 * 未读分侧键：与 roomSideKey 完全同源（保留旧名，调用处不必改）。
 *
 * 说明：`counts` 与 `seenTokens` 共用同一套键空间 —— 两侧语义（计数/已见指纹）
 * 必须一一对应，用两个不同前缀只会增加拼错的机会。
 */
export function roomUnreadKey(memberId: string | number | undefined | null, side: RoomUnreadSide): string {
  return roomSideKey(memberId, side);
}

/** 取某一侧的未读条数（键不存在 = 0；非法值同样归 0） */
export function roomUnreadCount(
  counts: Record<string, number> | undefined | null,
  memberId: string | number | undefined | null,
  side: RoomUnreadSide,
): number {
  const key = roomUnreadKey(memberId, side);
  if (!key || !counts) return 0;
  const n = Number(counts[key] || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 未读总数（所有房间、两侧相加）：tab 角标与「新消息上浮排序」用。
 * 键空间换成复合键后**必须继续用这个函数**求和，不要再自己遍历 ——
 * 两侧键都在同一张表里，直接求和就是总数，逻辑上不会漏。
 */
export function roomUnreadTotal(counts: Record<string, number> | undefined | null): number {
  if (!counts) return 0;
  let sum = 0;
  for (const value of Object.values(counts)) {
    const n = Number(value) || 0;
    if (n > 0) sum += n;
  }
  return sum;
}

/** 单侧角标展示形态：只有「数字」或「不显示」两种（单一数据源） */
export interface RoomUnreadBadge {
  kind: 'count' | 'none';
  /** kind === 'count' 时为数字文案（超过 99 转 '99+'） */
  text: string;
}

/**
 * ★ 单一数据源（用户 2026-11-10：「用了两套数据源、两个时刻，那能不能只要一套」）。
 *
 * 旧版角标有两套判据：本地累计条数 `count` + `hasNew`（最新消息时间 > 已读基线 /
 * 指纹 != 已见指纹）。后者来自 30s 列表刷新，**比计数通道早到**，于是先显示「新」，
 * 几秒后计数到达又换成数字 —— 用户看到的「先一个新字再出现数字」。
 * 而且 Rooms tab 只认 `counts`，「新」阶段行亮了、tab 还是 0，看起来像提示了两次。
 *
 * 现在角标 / 列表上浮 / tab 总数全部只认 `roomUnreadCounts`：
 * 计数没到就不渲染，到了直接显示数字（由 5s 轮询驱动，通常早于 30s 列表刷新）。
 * 指纹 / 时间 / 已读基线仍服务其它功能（30s 精确计数的信号、进房「上次看到这里」、
 * 一键已读），但**不再参与任何「有没有新消息」的判定**。
 */
export function roomUnreadBadge(count: number): RoomUnreadBadge {
  const n = Number(count) || 0;
  if (n > 0) return { kind: 'count', text: n > 99 ? '99+' : String(Math.floor(n)) };
  return { kind: 'none', text: '' };
}

/** 单侧「有新消息吗」= 只看该侧累计条数（与角标、tab 同一套数据） */
export function roomSideHasNew(count: number): boolean {
  return Number(count) > 0;
}
