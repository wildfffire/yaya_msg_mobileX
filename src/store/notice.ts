/**
 * 通知相关的两个轻量全局状态（zustand）。
 *
 * 1) useNoticeStore —— **软件内通知**横幅队列（App 在前台时用，用户 2026-11-09）。
 *    只保留「最新一条 + 条数」，不做堆叠：消息连发时横幅只更新文案，不刷屏。
 *
 * 2) useRoomPresenceStore —— 当前正在看哪个房间（memberId）。
 *    用途：自己正在看的房间不该再弹通知（桌面端口径）。FollowedRoomsScreen
 *    在 openRoom/closeRoom 写，通知轮询读。
 */
import { create } from 'zustand';

export type NoticeKind = 'pm' | 'room';

export interface InAppNotice {
  /** 去重/合并键：`pm|uid` / `room|memberId` */
  key: string;
  kind: NoticeKind;
  title: string;
  body: string;
  /** 头像（房间 = 房间列表里的偶像头像）；空 = 用名字首字占位，不再显示图标 */
  avatarUrl?: string;
  /** 点击后要跳的深链（yayamsg://...） */
  uri: string;
  count: number;
  at: number;
}

interface NoticeState {
  current: InAppNotice | null;
  push: (notice: Omit<InAppNotice, 'count' | 'at'> & { windowMs?: number }) => void;
  dismiss: () => void;
}

/** 合并窗口：30 秒内同一目标的连发只更新同一条横幅 */
const MERGE_MS = 30_000;

export const useNoticeStore = create<NoticeState>()((set) => ({
  current: null,
  push: (notice) => set((state) => {
    const now = Date.now();
    const prev = state.current;
    if (prev && prev.key === notice.key && now - prev.at <= (notice.windowMs ?? MERGE_MS)) {
      return {
        current: {
          ...prev,
          title: notice.title || prev.title,
          body: notice.body,
          uri: notice.uri,
          avatarUrl: notice.avatarUrl || prev.avatarUrl,
          count: prev.count + 1,
          at: now,
        },
      };
    }
    return {
      current: {
        key: notice.key,
        kind: notice.kind,
        title: notice.title,
        body: notice.body,
        avatarUrl: notice.avatarUrl,
        uri: notice.uri,
        count: 1,
        at: now,
      },
    };
  }),
  dismiss: () => set({ current: null }),
}));

interface RoomPresenceState {
  /** 当前打开的房间（memberId，空串 = 不在房间里） */
  currentRoomId: string;
  setCurrentRoom: (memberId: string) => void;
  /** 深链/通知要「进某个房间」时先放这里，房间页消费后清空 */
  pendingRoomId: string;
  requestRoom: (memberId: string) => void;
  consumePendingRoom: () => string;
}

export const useRoomPresenceStore = create<RoomPresenceState>()((set, get) => ({
  currentRoomId: '',
  setCurrentRoom: (memberId) => set({ currentRoomId: String(memberId || '') }),
  pendingRoomId: '',
  requestRoom: (memberId) => set({ pendingRoomId: String(memberId || '') }),
  consumePendingRoom: () => {
    const id = get().pendingRoomId;
    if (id) set({ pendingRoomId: '' });
    return id;
  },
}));
