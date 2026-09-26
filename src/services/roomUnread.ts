/**
 * 房间未读（本地累计 + 「已读到哪」基线）。
 *
 * ⚠️ 官方**没有**房间级未读接口 —— 实测确认：
 *   - `pocketApi.getUnreadMessageCount()` 只有全 App 未读总数（且无房间入参）；
 *   - 云信服务层（src/services/pocketNim/*）、原生模块（PocketIm / NimChatroomClient）
 *     与 docs/API_MAP.md 里都没有 per-room 未读；
 *   - 私信有会话级 `noreadNum`，但那是私信、不能用于房间。
 * 用户已知悉该限制并选择「本地累计」近似方案。
 *
 * 三条互补的数据通道（**任一**命中即出角标，避免「什么都看不到」）：
 *   1. **实时累计**：房间列表挂着时订阅全量房间实时消息，按 channelId→memberId 归位 +1
 *      （依赖云信 QChat 通道，未登录/原生不可用时不工作）；
 *   2. **时间比对**：房间列表每 30s 拉一次每个房间的「最新消息」，
 *      用 `最新消息时间 > 已读基线` 判断（`lastReadAt`）；
 *   3. **指纹比对**：把「最新消息」压成一个短字符串（`seenTokens`），只要内容变了就算有新消息。
 *
 * ⚠️ 为什么要有第 3 条（指纹）：`/im/api/v1/team/classic/last/message/get`
 * **官方没有字段文档**，仓库里另一个消费者（src/services/memberData.ts）也只读
 * serverId/channelId、从不读时间 —— 时间字段名对不上时第 2 条就会恒为 false
 * （这正是用户反馈两次「房间列表无任何标注」的另一半原因）。
 * 指纹只关心「这条最新消息和上次看到的是不是同一个」，与字段名、时间格式、时区都无关。
 *
 * ⚠️⚠️【时间域铁律】`lastReadAt` 存的是**服务器消息时间**（该房间当时的最后活动时间），
 * **绝不是设备当前时间 `Date.now()`**。改造前用 `Date.now()` 当基线，只要设备时钟比服务器
 * 快哪怕几秒，之后的消息就永远 `< 基线` → 角标永不出现，而且**重启也救不回来**（基线在磁盘里）。
 *
 * 局限（用户已知悉）：App 未运行期间收到的消息不计；重装/升级会丢；不做已读上报（官方无接口）。
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * v4：**换 key 是为了丢弃中毒数据**（历史教训：语义变了就必须换 key）。
 *
 * v2 时代 `lastReadAt` 写的是设备时钟 `Date.now()`；v3 才改成服务器时间，但 `seedReadAt`
 * 只补「还没有记录的项」，v2 那些设备时钟基线**永远覆盖不掉** → 角标恒不亮。
 * v4 同时引入 `seenTokens`（指纹），并清掉 v1~v3 旧键，保证两条判据都是从零开始的干净基线。
 * ⚠️ 以后再改「已读」的语义，也必须换 key。
 */
const STORAGE_KEY = 'yaya_room_unread_v4';
/** 旧键：hydrate 时顺手清掉，避免占空间与误读 */
const LEGACY_KEYS = [
  'yaya_room_unread_v1',
  'yaya_room_unread_v2',
  'yaya_room_unread_v3',
];
/** 单房间计数上限：避免长期挂着时数字离谱（也防存储膨胀） */
const MAX_PER_ROOM = 999;
/** 指纹长度上限（防极端情况下存储膨胀） */
const MAX_TOKEN = 2000;

interface Stored {
  counts: Record<string, number>;
  lastReadAt: Record<string, number>;
  seenTokens: Record<string, string>;
}

interface RoomUnreadState {
  /** memberId → 未读条数（本地累计，0 表示没累计到） */
  counts: Record<string, number>;
  /** memberId → 已读基线（服务器消息时间 ms）；与房间最新消息时间比较 */
  lastReadAt: Record<string, number>;
  /** memberId → 已见「最新消息指纹」；与当前指纹不同即视为有新消息（不依赖字段名） */
  seenTokens: Record<string, string>;
  /** 是否已从磁盘恢复（避免恢复前把空对象写回磁盘） */
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 某房间 +n（默认 +1） */
  bump: (memberId: string, n?: number) => void;
  /**
   * 进入/离开房间：清零计数，并把「已读到哪」记为该房间**当时的最后活动时间**。
   * @param activity 服务器消息时间（房间当前最后活动时间）；传 0 表示调用方不知道
   *   —— 此时**不动已有基线**（写 0 会让刚进过的房间立刻冒「新」）。
   */
  markRead: (memberId: string, activity: number) => void;
  /**
   * 首次基线：给「还没有已读记录」的房间写入该房间**当时的最后活动时间**（0 = 当时没有消息）。
   * 只在拉到房间列表后调用 —— 否则升级后所有房间会被判成「有未读」，一片红点。
   * ⚠️ 必须传服务器活动时间，不能传 `Date.now()`（见文件头「时间域铁律」）。
   */
  seedReadAt: (observed: Record<string, number>) => void;
  /** 进入/离开房间：把「已见指纹」更新为该房间当前的指纹（传空串则不动） */
  markSeen: (memberId: string, token: string) => void;
  /** 首次基线：给「还没有指纹记录」的房间写入当前指纹（只补缺失，不覆盖） */
  seedTokens: (observed: Record<string, string>) => void;
  /** 全部清空（如退出登录/切换账号） */
  clearAll: () => void;
}

function persist(state: Stored): void {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
}

export const useRoomUnreadStore = create<RoomUnreadState>((set, get) => {
  /**
   * 写操作前先确保磁盘数据已恢复。
   * ⚠️ 不这么做的话，「首帧就来的写操作」（例如列表一加载完就 seedReadAt）
   * 会在 hydrate 之前落盘，把磁盘上的已读时间/计数**覆盖成空表**。
   * hydrate 自身幂等，已加载时这里是一个微任务，几乎无开销。
   */
  const ready = () => get().hydrate();

  return {
  counts: {},
  lastReadAt: {},
  seenTokens: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      // 顺手清掉历史旧键：语义已废（设备时钟基线等），留着只会占地方/误导排查
      AsyncStorage.multiRemove(LEGACY_KEYS).catch(() => {});
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const counts: Record<string, number> = {};
      const lastReadAt: Record<string, number> = {};
      const seenTokens: Record<string, string> = {};
      const src = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<Stored>;
      if (src.counts && typeof src.counts === 'object') {
        for (const [k, v] of Object.entries(src.counts)) {
          const n = Number(v);
          if (k && Number.isFinite(n) && n > 0) counts[String(k)] = Math.min(MAX_PER_ROOM, Math.floor(n));
        }
      }
      if (src.lastReadAt && typeof src.lastReadAt === 'object') {
        for (const [k, v] of Object.entries(src.lastReadAt)) {
          const n = Number(v);
          if (k && Number.isFinite(n) && n > 0) lastReadAt[String(k)] = n;
        }
      }
      if (src.seenTokens && typeof src.seenTokens === 'object') {
        for (const [k, v] of Object.entries(src.seenTokens)) {
          const token = String(v || '');
          if (k && token) seenTokens[String(k)] = token.slice(0, MAX_TOKEN);
        }
      }
      set({ counts, lastReadAt, seenTokens, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  bump: (memberId, n = 1) => {
    const id = String(memberId || '');
    if (!id) return;
    void ready().then(() => set((s) => {
      const next = Math.min(MAX_PER_ROOM, (s.counts[id] || 0) + n);
      if (next === s.counts[id]) return s;
      const counts = { ...s.counts, [id]: next };
      persist({ counts, lastReadAt: s.lastReadAt, seenTokens: s.seenTokens });
      return { counts };
    }));
  },

  markRead: (memberId, activity) => {
    const id = String(memberId || '');
    if (!id) return;
    const seen = Number(activity) > 0 ? Number(activity) : 0;
    void ready().then(() => set((s) => {
      const counts = { ...s.counts };
      delete counts[id];
      const lastReadAt = { ...s.lastReadAt };
      // 拿不到活动时间（0）时保留原基线：写成 0 会让刚进过的房间立刻被判成有新消息
      if (seen > 0) lastReadAt[id] = seen;
      persist({ counts, lastReadAt, seenTokens: s.seenTokens });
      return { counts, lastReadAt };
    }));
  },

  seedReadAt: (observed) => {
    void ready().then(() => set((s) => {
      let changed = false;
      const lastReadAt = { ...s.lastReadAt };
      for (const [raw, value] of Object.entries(observed || {})) {
        const id = String(raw || '');
        if (!id || lastReadAt[id]) continue;
        lastReadAt[id] = Number(value) > 0 ? Number(value) : 0;
        changed = true;
      }
      if (!changed) return s;
      persist({ counts: s.counts, lastReadAt, seenTokens: s.seenTokens });
      return { lastReadAt };
    }));
  },

  markSeen: (memberId, token) => {
    const id = String(memberId || '');
    const value = String(token || '').slice(0, MAX_TOKEN);
    // 拿不到指纹时不动原值：写空会让刚进过的房间立刻被判成有新消息
    if (!id || !value) return;
    void ready().then(() => set((s) => {
      if (s.seenTokens[id] === value) return s;
      const seenTokens = { ...s.seenTokens, [id]: value };
      persist({ counts: s.counts, lastReadAt: s.lastReadAt, seenTokens });
      return { seenTokens };
    }));
  },

  seedTokens: (observed) => {
    void ready().then(() => set((s) => {
      let changed = false;
      const seenTokens = { ...s.seenTokens };
      for (const [raw, token] of Object.entries(observed || {})) {
        const id = String(raw || '');
        const value = String(token || '').slice(0, MAX_TOKEN);
        if (!id || !value || seenTokens[id]) continue;
        seenTokens[id] = value;
        changed = true;
      }
      if (!changed) return s;
      persist({ counts: s.counts, lastReadAt: s.lastReadAt, seenTokens });
      return { seenTokens };
    }));
  },

  clearAll: () => {
    set({ counts: {}, lastReadAt: {}, seenTokens: {} });
    persist({ counts: {}, lastReadAt: {}, seenTokens: {} });
  },
  };
});

// 模块加载即开始恢复磁盘数据：与「首帧就来的写操作」错开，减少它们等待 hydrate 的概率。
void useRoomUnreadStore.getState().hydrate();

export default useRoomUnreadStore;
