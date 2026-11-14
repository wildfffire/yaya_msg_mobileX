/**
 * 圈组 channelId →（成员 id + 大/小侧）反查表（纯函数，可单测）。
 *
 * 从 FollowedRoomsScreen 的 useMemo 里抽出（用户 2026-11-13「继续整合」）：
 * 实时消息的 channelId 到底对应成员的 channelId 还是 serverId，官方没有文档，
 * 所以大房间必须**两个 id 都登记**；小房间用 yklzId。
 * 这张表决定实时消息归到哪个房间/哪一侧，串了就会「A 房间的消息计到 B」。
 */
import type { RoomUnreadSide } from '../../utils/roomUnreadRules';

export interface RoomChannelHit {
  id: string;
  side: RoomUnreadSide;
  member: any;
}

/**
 * @param rows 关注列表（每行 { memberId, member }）
 * @returns channelId/serverId/yklzId → (memberId, side, member)；同键后写覆盖（历史行为）
 */
export function buildChannelToRoomMap(
  rows: any[] | undefined | null,
): Record<string, RoomChannelHit> {
  const map: Record<string, RoomChannelHit> = {};
  for (const it of Array.isArray(rows) ? rows : []) {
    const mid = String(it?.memberId || it?.member?.id || '');
    if (!mid) continue;
    const member = it?.member;
    /**
     * ⚠️ 大房间要同时登记 `channelId` **和** `serverId`（用户 2026-11-09：
     * 「列表显示 1，实际发了很多」）：圈组消息里的 channelId 到底是哪个字段
     * 没有文档，只登记 channelId 时，若推送带的是 serverId → 每条消息都
     * 映射不到房间 → 实时计数全丢。
     */
    const bigIds = [member?.channelId, member?.serverId]
      .map((v) => String(v || ''))
      .filter(Boolean);
    const small = String(member?.yklzId || '');
    for (const id of bigIds) map[id] = { id: mid, side: 'big', member };
    if (small) map[small] = { id: mid, side: 'small', member };
  }
  return map;
}
