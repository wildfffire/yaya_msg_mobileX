/**
 * 房间精华消息（偶像/房主置顶）的会话状态。
 *
 * ⚠️ 这里**不持久化官方数据、不允许用户写入**：置顶是偶像在官方客户端做的，
 * 移动端每次进房从 /team/essence/message/list 拉一次，只做展示。
 * 「关掉的弹窗」只存内存（本次会话收起，冷启动恢复）；
 * 「哪些精华已经看过」是**本地阅读状态**，单独落盘在 services/roomEssenceSeen.ts。
 *
 * 按频道隔离：大房间 channelId / 小房间 yklzId 各一份。
 *
 * 用户口径（2026-11-09）：精华消息做成弹窗（对齐播放器公告），关掉之后
 * 只剩工具栏右侧一个喇叭入口 —— 所以这里同时管 `status`（正在加载 / 加载失败）。
 */
import { create } from 'zustand';
import { roomPinnedKey, type RoomEssenceMessage } from '../utils/roomPinnedRules';

/** 精华条/弹窗的加载态：idle=还没请求，loading=正在加载，ready=拿到了（可能为空），error=请求失败 */
export type RoomEssenceStatus = 'idle' | 'loading' | 'ready' | 'error';

interface RoomEssenceState {
  essence: Record<string, RoomEssenceMessage[]>;
  status: Record<string, RoomEssenceStatus>;
  dismissed: Record<string, boolean>;
  setEssence: (channelId: string, items: RoomEssenceMessage[]) => void;
  /** 写加载态（加载失败时保留旧数据，弹窗里给「重试」） */
  setStatus: (channelId: string, status: RoomEssenceStatus) => void;
  dismiss: (channelId: string) => void;
  show: (channelId: string) => void;
}

export const useRoomPinnedStore = create<RoomEssenceState>((set) => ({
  essence: {},
  status: {},
  dismissed: {},

  setEssence: (channelId, items) => {
    const key = roomPinnedKey(channelId);
    if (!key) return;
    set((s) => ({ essence: { ...s.essence, [key]: items } }));
  },

  setStatus: (channelId, status) => {
    const key = roomPinnedKey(channelId);
    if (!key) return;
    set((s) => ({ status: { ...s.status, [key]: status } }));
  },

  dismiss: (channelId) => {
    const key = roomPinnedKey(channelId);
    if (!key) return;
    set((s) => ({ dismissed: { ...s.dismissed, [key]: true } }));
  },

  show: (channelId) => {
    const key = roomPinnedKey(channelId);
    if (!key) return;
    set((s) => ({ dismissed: { ...s.dismissed, [key]: false } }));
  },
}));
