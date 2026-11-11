/**
 * 房间「活动时间 / 最新消息指纹」镜像（第 6 步 · 6b-1）。
 *
 * 为什么单独成 hook：这两个镜像表是所有**未读判断**的取值来源，
 * 而它们的产生只依赖关注列表（followed），与消息列表、播放器完全无关 —— 边界很干净。
 *
 * 关键约束（连同原注释一起保留）：这里的值必须是**服务器消息时间**，
 * 进房/退房写已读基线时只能用它们、绝不能用 `Date.now()`（设备时钟快几秒就会让角标永不出现）。
 *
 * 分侧（用户 2026-09-30）：指纹按大/小房间**分开**存（键 = `roomUnreadKey(id, side)`），
 * 进房/退房写「已见」时两侧一起推进（`markSeenBoth`）—— 语义上「这个房间我看过了」，
 * 大房间与小房间都算看过。活动时间仍取两侧更晚的那个（房间级已读基线不分侧）。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Member } from '../../types';
import { ROOM_UNREAD_SIDES, roomUnreadKey, type RoomUnreadSide } from '../../utils/roomUnreadRules';
import { roomLastActivity, roomSideToken } from './roomIdentity';

export function useRoomActivityMirror(followed: any[]) {
  /**
   * 每个房间「当前观测到的最后活动时间」镜像（memberId → 服务器消息时间，两侧取更晚）。
   *
   * 进房/退房写已读基线时必须用**这个值**而不是 `Date.now()`（见 roomUnread.ts 的时间域铁律）。
   * 存成 ref 而不是从 `followed` 现取：避免把 `followed` 塞进 `openRoom` 的依赖数组
   *（那会让 openRoom 每次列表刷新都换引用，进而让 roomSwipeGesture 等一堆东西重建）。
   */
  const roomActivityRef = useRef<Record<string, number>>({});
  /** 每个房间**每一侧**「当前最新消息指纹」镜像（键 = roomUnreadKey(memberId, side)） */
  const roomTokenRef = useRef<Record<string, string>>({});
  /** 退房待收尾的房间：等下一次 loadFollowed 拿到最新指纹后补写「已见」（见 closeRoom/loadFollowed） */
  const pendingSeenRef = useRef('');
  /** 「最新消息」样本只记一次运行日志（用于事后排查真实字段名） */
  const loggedLastMsgSampleRef = useRef(false);
  useEffect(() => {
    for (const item of followed as any[]) {
      const act = roomLastActivity(item);
      for (const key of [item?.memberId, item?.member?.id]) {
        const k = String(key || '');
        if (!k) continue;
        roomActivityRef.current[k] = act;
        for (const side of ROOM_UNREAD_SIDES) {
          const token = roomSideToken(item, side);
          if (token) roomTokenRef.current[roomUnreadKey(k, side)] = token;
        }
      }
    }
  }, [followed]);

  /** 取某房间当前观测到的最后活动时间（0 = 还不知道，调用方按「不动基线」处理） */
  const roomActivityOf = useCallback((room: Member | null | undefined) => {
    const id = String(room?.id || '');
    return Number(roomActivityRef.current[id] || 0);
  }, []);

  /** 取某房间**某一侧**当前最新消息指纹（'' = 还不知道，调用方按「不动」处理） */
  const roomSeenTokenOf = useCallback((room: Member | null | undefined, side: RoomUnreadSide) => {
    const id = String(room?.id || '');
    if (!id) return '';
    return String(roomTokenRef.current[roomUnreadKey(id, side)] || '');
  }, []);

  /**
   * 取某房间**两侧**当前最新消息指纹：进房/退房写「已见」时一次拿齐，
   * 交给 store 的 `markSeenBoth`（避免调用方自己拼两次键）。
   */
  const roomSeenPair = useCallback((room: Member | null | undefined) => ({
    big: roomSeenTokenOf(room, 'big'),
    small: roomSeenTokenOf(room, 'small'),
  }), [roomSeenTokenOf]);

  return {
    roomActivityRef,
    pendingSeenRef,
    loggedLastMsgSampleRef,
    roomActivityOf,
    roomSeenPair,
  };
}
