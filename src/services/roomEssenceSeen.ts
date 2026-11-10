/**
 * 房间精华消息：「已经看过哪些」的本地阅读状态（用户 2026-11-09）。
 *
 * 口径：精华消息首次出现时自动弹窗；**看过的（id 进过弹窗）之后不再主动弹**，
 * 只有偶像新设了精华（出现新 id）才会再弹一次。关掉弹窗后工具栏留一个喇叭入口。
 *
 * 为什么单独一个文件（没并进 services/roomPinned.ts）：
 * roomPinned 只放「官方数据的内存镜像」，明确不落盘（scripts/room-pinned.test.mjs 有静态锁）；
 * 而「我看过哪几条」是本机阅读状态，必须跨启动记住 —— 两者生命周期不同，不能混。
 *
 * 键按频道隔离（大房间 channelId / 小房间 yklzId），每频道最多记 200 个 id（防无限增长）。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const STORAGE_KEY = 'yaya_room_essence_seen_v1';
const MAX_IDS_PER_ROOM = 200;

interface RoomEssenceSeenState {
  seen: Record<string, string[]>;
  hydrated: boolean;
  hydrate: () => void;
  /** 标记这些 id 已经给用户看过（自动弹窗/手动打开详情都算） */
  markSeen: (channelKey: string, ids: string[]) => void;
}

let hydrating: Promise<void> | null = null;

function persist(seen: Record<string, string[]>) {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(seen)).catch(() => undefined);
}

export const useRoomEssenceSeenStore = create<RoomEssenceSeenState>((set, get) => ({
  seen: {},
  hydrated: false,

  hydrate: () => {
    if (get().hydrated || hydrating) return;
    hydrating = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw: string | null) => {
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const seen: Record<string, string[]> = {};
        if (parsed && typeof parsed === 'object') {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!key || !Array.isArray(value)) continue;
            seen[key] = value.map((v) => String(v)).filter(Boolean).slice(-MAX_IDS_PER_ROOM);
          }
        }
        set({ seen, hydrated: true });
      })
      .catch(() => set({ hydrated: true }));
  },

  markSeen: (channelKey, ids) => {
    const key = String(channelKey || '').trim();
    const fresh = (ids || []).map((v) => String(v || '').trim()).filter(Boolean);
    if (!key || !fresh.length) return;
    const prev = get().seen[key] || [];
    const merged = Array.from(new Set([...prev, ...fresh])).slice(-MAX_IDS_PER_ROOM);
    if (merged.length === prev.length) return;
    const seen = { ...get().seen, [key]: merged };
    set({ seen });
    persist(seen);
  },
}));
