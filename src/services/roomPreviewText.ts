/**
 * 房间列表「最新消息」预览文本（由**详情页**提供，优先于列表接口的 msgContent）。
 *
 * 为什么需要（用户 2026-11-11：「应籽言的几条回复消息不能在房间列表显示，
 * 而是显示了之前的信息，也就是今天要排占卜师那一句」）：
 * `im/api/v1/team/classic/last/message/get` 只给 `msgContent`（+ channelId/serverId/starName），
 * 对**引用（回复）消息**它给的是被引用的那句原文/结构，而不是这条回复的正文 ——
 * 于是列表看起来"卡"在旧消息上（连着几条回复都是同一个引用原文）。
 * 而 5s 轮询本来就会拉该侧最新一页详情，那一页里最新一条才是真正的「最后一条消息」。
 *
 * 设计：
 *   · 键与未读同一套（`roomUnreadKey(memberId, side)`），大/小房间分开；
 *   · 只写**来自 `/list/all`** 的页（`owner` 回退页可能是很久以前的房主消息，会把预览拽回过去）；
 *   · 存 `text + msgId + msgTime`：空正文（纯图片/语音等）时**清掉**该键，回退到 msgContent。
 *
 * 注意：这里只做「显示用」的文本，不参与未读计数（角标只认 roomUnreadCounts）。
 */
import { create } from 'zustand';
import type { RoomUnreadSide } from '../utils/roomUnreadRules';
import { roomPreviewTextOf, roomUnreadKey } from '../utils/roomUnreadRules';

/** 纯函数版取值（键规则与未读同一套；实现见 utils/roomUnreadRules，可单测） */
export const previewTextOf = roomPreviewTextOf;

export interface RoomPreviewEntry {
  /** 预览正文（已过 emoji 替换） */
  text: string;
  /** 该条消息的 id（同一条重复写入时跳过，避免无谓的列表重渲染） */
  msgId: string;
  /** 该条消息的服务器时间（ms；0 = 未知） */
  msgTime: number;
  /** 写入时刻（本机时间，仅用于诊断） */
  at: number;
}

interface RoomPreviewTextState {
  map: Record<string, RoomPreviewEntry>;
  /** 写某侧的最新预览文本（text 为空 → 删除该键，回退到列表接口的 msgContent） */
  setPreview: (memberId: string, side: RoomUnreadSide, input: { text: string; msgId: string; msgTime: number }) => void;
  /** 取某侧的最新预览文本（没有则空串） */
  previewOf: (memberId: string, side: RoomUnreadSide) => string;
  /** 取关/换账号时清理 */
  clearRoom: (memberId: string) => void;
  clearAll: () => void;
}

export const useRoomPreviewTextStore = create<RoomPreviewTextState>((set, get) => ({
  map: {},

  setPreview: (memberId, side, input) => {
    const id = String(memberId || '');
    const key = roomUnreadKey(id, side);
    if (!key) return;
    const text = String(input?.text || '').trim();
    set((s) => {
      const prev = s.map[key];
      if (!text) {
        if (!prev) return s;
        const map = { ...s.map };
        delete map[key];
        return { map };
      }
      const msgId = String(input?.msgId || '');
      const msgTime = Number(input?.msgTime) || 0;
      // 同一条消息（id 相同）不重复写：轮询每轮都会拿到同一页，避免无谓重渲染
      if (prev && msgId && prev.msgId === msgId) return s;
      // 时间倒退的页（owner 回退 / 回溯页乱序）不能把预览拽回过去
      if (prev && msgTime > 0 && prev.msgTime > 0 && msgTime < prev.msgTime) return s;
      const map = { ...s.map, [key]: { text, msgId, msgTime, at: Date.now() } };
      return { map };
    });
  },

  previewOf: (memberId, side) => previewTextOf(get().map, memberId, side),

  clearRoom: (memberId) => {
    const id = String(memberId || '');
    if (!id) return;
    set((s) => {
      const map = { ...s.map };
      let changed = false;
      for (const side of ['big', 'small'] as RoomUnreadSide[]) {
        const key = roomUnreadKey(id, side);
        if (key && map[key]) { delete map[key]; changed = true; }
      }
      return changed ? { map } : s;
    });
  },

  clearAll: () => set({ map: {} }),
}));
