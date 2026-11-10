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
 *   1. **实时累计**：房间列表挂着时订阅全量房间实时消息，按 channelId→(memberId, 侧) 归位 +1
 *      （依赖云信 QChat 通道，未登录/原生不可用时不工作）；
 *      ⚠️ 大房间 channelId 与小房间 yklzId 是**两个不同的键**，正好用来判「消息来自哪一侧」——
 *      即分侧计数的依据（用户 2026-09-30：数字要分别贴在大/小房间那一行）。
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
import { AppState } from 'react-native';
import { ROOM_UNREAD_SIDES, roomUnreadKey, type RoomUnreadSide } from '../utils/roomUnreadRules';
import { logInfo } from '../utils/runtimeLog';

/**
 * v5：**未读分大/小房间两侧**（用户 2026-09-30 要求）→ 又一次语义变更，必须换 key。
 *
 * v4 的 `counts` / `seenTokens` 键是裸 `memberId`（一个房间只有一个总数），
 * 回答不了「这条新消息来自大房间还是小房间」。v5 起这两张表的键都是
 * `roomUnreadKey(memberId, side)`（`#b` / `#s`）；`lastReadAt` 仍是房间级
 *（进房即读全房间，两侧一起清）。
 *
 * 换 key 的历史教训（务必保留）：v2 时代 `lastReadAt` 写的是设备时钟 `Date.now()`；
 * v3 改成服务器时间，但 `seedReadAt` 只补「还没有记录的项」，v2 那些设备时钟基线
 * **永远覆盖不掉** → 角标恒不亮。所以「语义变了就必须换 key，并把旧键清掉」。
 */
const STORAGE_KEY = 'yaya_room_unread_v5';
/** 旧键：hydrate 时顺手清掉，避免占空间与误读 */
const LEGACY_KEYS = [
  'yaya_room_unread_v1',
  'yaya_room_unread_v2',
  'yaya_room_unread_v3',
  'yaya_room_unread_v4',
];
/** 单房间计数上限：避免长期挂着时数字离谱（也防存储膨胀） */
const MAX_PER_ROOM = 999;
/** 指纹长度上限（防极端情况下存储膨胀） */
const MAX_TOKEN = 2000;

interface Stored {
  counts: Record<string, number>;
  lastReadAt: Record<string, number>;
  seenTokens: Record<string, string>;
  /** 分侧键 → 该侧「最后看过的消息时间」（ms）。用于精确计数（见 useRoomUnreadCounters） */
  sideSeenAt?: Record<string, number>;
  /**
   * 分侧键 → 「打开房间那一刻的服务端未读数」（已读地板）。
   * 服务端 unreadCount 不一定因为我们本地读了就清零 —— 打开房间时把它记下来，
   * 角标显示 `max(0, 服务端未读 - 地板)`；服务端自己清零（数值 < 地板）时地板跟着清。
   */
  serverFloor?: Record<string, number>;
}

interface RoomUnreadState {
  /**
   * 未读条数：键 = `roomUnreadKey(memberId, side)`（大房间 `#b` / 小房间 `#s`）。
   * 两侧相加 = 房间总数（统一走 utils/roomUnreadRules.roomUnreadTotal，别再自己遍历）。
   */
  counts: Record<string, number>;
  /** memberId → 已读基线（服务器消息时间 ms）；**房间级**：进房即读全房间，两侧一起推进 */
  lastReadAt: Record<string, number>;
  /** 键 = `roomUnreadKey(memberId, side)` → 该侧已见的「最新消息指纹」；不同即视为有新消息 */
  seenTokens: Record<string, string>;
  /**
   * 键同上 → 该侧「最后看过的消息时间」（服务器 ms）。
   * 用途：`last/message/get` 的返回体**没有时间字段**（实测 keys=serverId,channelId,msgContent,starName），
   * 所以指纹一变只知道「有新消息」，不知道有几条。真机反馈「列表显示 1、实际发了很多」就是这么来的。
   * 30s 轮询在指纹变化时会拉一次该侧最新一页，用这个时间做基线数出**真实条数**。
   */
  sideSeenAt: Record<string, number>;
  /** 键同上 → 「打开房间那一刻的服务端未读数」（见 Stored.serverFloor 的说明） */
  serverFloor: Record<string, number>;
  /** 是否已从磁盘恢复（避免恢复前把空对象写回磁盘） */
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 某房间**某一侧** +n（默认 +1） */
  bump: (memberId: string, side: RoomUnreadSide, n?: number) => void;
  /**
   * **批量提交**（30s 轮询 / 实时通道 / 进房退房收尾用）：一次 setState + 一次落盘。
   *
   * 为什么必须批量：分侧后一轮最多「N 个房间 × 2 侧」= 2N 次计数与指纹推进，
   * 逐次调用就是 2N 次全量 JSON 序列化 + 2N 次 store 通知（每次通知都让房间列表重渲染）——
   * 用户 2026-09-30 反馈的「30s 卡一下、列表闪烁、房间都被卡没了」正是这条。
   * 单条改动（如用户手动操作）继续用 bump/markSeen 即可。
   */
  applyUnread: (patch: {
    /** 分侧键（roomUnreadKey 产物）→ 计数增量 */
    bump?: Record<string, number>;
    /** 分侧键 → 新的「已见指纹」（空值忽略，超长截断） */
    seen?: Record<string, string>;
    /** 分侧键 → 该侧「最后看过的消息时间」（ms，只前进不后退） */
    seenAt?: Record<string, number>;
    /** 分侧键 → 服务端未读「已读地板」（打开房间那一刻的服务端未读数） */
    floor?: Record<string, number>;
    /** memberId → 已读基线（服务器消息时间，**房间级**）；同时清零该房间两侧计数 */
    read?: Record<string, number>;
  }) => void;
  /**
   * 进入/离开房间：清零**两侧**计数，并把「已读到哪」记为该房间**当时的最后活动时间**。
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
  /** 进入/离开房间：把**某一侧**的「已见指纹」更新为该侧当前指纹（传空串则不动） */
  markSeen: (memberId: string, side: RoomUnreadSide, token: string) => void;
  /** 一次推进**两侧**指纹（进房/退房收尾用：两侧都算「看过」，空串那侧不动） */
  markSeenBoth: (memberId: string, bigToken: string, smallToken: string) => void;
  /**
   * 一键已读（建议 10，用户 2026-09-30 选定）：把**所有房间**的未读一次清干净 ——
   * 两侧计数全清 + 已读基线推进到当前活动时间 + 已见指纹推进到当前两侧指纹。
   * 房间多时逐房间调 markRead 会产生 N 次 setState 与 N 次落盘，所以合并成一次提交。
   * ⚠️ baselines 必须是**服务器消息时间**（同「进房即已读」，见文件头时间域铁律）。
   */
  markAllRead: (baselines: Record<string, number>, tokens: Record<string, string>) => void;
  /** 首次基线：给「还没有指纹记录」的键写入当前指纹（只补缺失，不覆盖；键已是分侧键） */
  seedTokens: (observed: Record<string, string>) => void;
  /** 全部清空（如退出登录/切换账号） */
  clearAll: () => void;
}

/**
 * 落盘防抖间隔：大房间刷屏时 applyUnread 可能**每秒多次**，
 * 每次全表 JSON.stringify（counts + lastReadAt + seenTokens，指纹串最长 2000 字符）+ 写 AsyncStorage，
 * 是实时消息路径上最重的一笔同步开销。合并成 800ms 一次。
 */
const PERSIST_DEBOUNCE_MS = 800;
/** 最新待落盘快照：防抖期间只保留最后一份（避免中间态反复序列化） */
let pendingPersist: Stored | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 立即落盘（取消防抖）：退房、一键已读、清空、切后台时调用 ——
 * 这些是「用户认为已经保存了」的时刻，不能等防抖窗口。
 */
export function flushRoomUnreadPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const state = pendingPersist;
  pendingPersist = null;
  if (!state) return;
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
}

/**
 * 防抖落盘（用户 2026-10-01 性能优化）。
 * ⚠️ 语义不变：磁盘上永远是**整份快照**（不是增量），只是把高频写合并到 800ms 一次；
 * 切后台/失活会 flush（见下方 AppState 监听），崩溃最坏只丢 800ms 内的计数增量。
 */
function persist(state: Stored): void {
  pendingPersist = state;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushRoomUnreadPersist();
  }, PERSIST_DEBOUNCE_MS);
}

// App 退到后台/失活立即落盘（按 Home、切应用、锁屏都走这里）
AppState.addEventListener('change', (state) => {
  if (state !== 'active') flushRoomUnreadPersist();
});

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
  sideSeenAt: {},
  serverFloor: {},
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
      const sideSeenAt: Record<string, number> = {};
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
      // 可选字段（v5 后追加）：老的磁盘数据里没有，读到空就用空表
      if (src.sideSeenAt && typeof src.sideSeenAt === 'object') {
        for (const [k, v] of Object.entries(src.sideSeenAt)) {
          const n = Number(v);
          if (k && Number.isFinite(n) && n > 0) sideSeenAt[String(k)] = n;
        }
      }
      const serverFloor: Record<string, number> = {};
      if (src.serverFloor && typeof src.serverFloor === 'object') {
        for (const [k, v] of Object.entries(src.serverFloor)) {
          const n = Number(v);
          if (k && Number.isFinite(n) && n >= 0) serverFloor[String(k)] = n;
        }
      }
      set({ counts, lastReadAt, seenTokens, sideSeenAt, serverFloor, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  bump: (memberId, side, n = 1) => {
    const key = roomUnreadKey(memberId, side);
    if (!key) return;
    void ready().then(() => {
      logInfo(`[unread] bump ${key} +${n}`, 'room.unread');
      set((s) => {
        const next = Math.min(MAX_PER_ROOM, (s.counts[key] || 0) + n);
        if (next === s.counts[key]) return s;
        const counts = { ...s.counts, [key]: next };
        persist({ counts, lastReadAt: s.lastReadAt, seenTokens: s.seenTokens, sideSeenAt: s.sideSeenAt, serverFloor: s.serverFloor });
        return { counts };
      });
    });
  },

  markRead: (memberId, activity) => {
    const id = String(memberId || '');
    if (!id) return;
    const seen = Number(activity) > 0 ? Number(activity) : 0;
    void ready().then(() => {
      logInfo(`[unread] markRead ${id} activity=${seen}`, 'room.unread');
      set((s) => {
      const counts = { ...s.counts };
      // 进房/退房：**两侧**计数一起清零 —— 用户进的是「这个房间」，
      // 大房间和小房间都显示在同一个房间里，只清一侧会留下看不懂的残留数字
      delete counts[roomUnreadKey(id, 'big')];
      delete counts[roomUnreadKey(id, 'small')];
      const lastReadAt = { ...s.lastReadAt };
      /**
       * 拿不到活动时间（0）时保留原基线：写成 0 会让刚进过的房间立刻被判成有新消息。
       *
       * ⚠️ 且**只前进不后退**（2026-10-04 修）：调用方给的是「该房间当时的最后活动时间」，
       * 而房间列表数据可能比本地基线更旧（30s 轮询失败 / 刚退房列表还没刷新 / 刚打开
       * 就是缓存页）—— 无条件赋值会让基线**倒退**，把已经读过的消息重新划进未读区，
       * 于是下次进房「上次看到这里」就落到更早的地方（用户反馈：「房间里上次读到的位置
       * 有的时候会定位回到以前读过的位置」）。
       */
      const prev = Number(lastReadAt[id]) || 0;
      if (seen > prev) lastReadAt[id] = seen;
      persist({ counts, lastReadAt, seenTokens: s.seenTokens, sideSeenAt: s.sideSeenAt });
      return { counts, lastReadAt };
      });
    });
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
      persist({ counts: s.counts, lastReadAt, seenTokens: s.seenTokens, sideSeenAt: s.sideSeenAt, serverFloor: s.serverFloor });
      return { lastReadAt };
    }));
  },

  markSeen: (memberId, side, token) => {
    const key = roomUnreadKey(memberId, side);
    const value = String(token || '').slice(0, MAX_TOKEN);
    // 拿不到指纹（或是空 memberId）时不动原值：写空会让刚进过的房间立刻被判成有新消息
    if (!key || !value) return;
    void ready().then(() => set((s) => {
      if (s.seenTokens[key] === value) return s;
      const seenTokens = { ...s.seenTokens, [key]: value };
      persist({ counts: s.counts, lastReadAt: s.lastReadAt, seenTokens, sideSeenAt: s.sideSeenAt, serverFloor: s.serverFloor });
      return { seenTokens };
    }));
  },

  markSeenBoth: (memberId, bigToken, smallToken) => {
    const bigKey = roomUnreadKey(memberId, 'big');
    const smallKey = roomUnreadKey(memberId, 'small');
    const big = String(bigToken || '').slice(0, MAX_TOKEN);
    const small = String(smallToken || '').slice(0, MAX_TOKEN);
    if (!bigKey || (!big && !small)) return;
    logInfo(`[unread] markSeenBoth ${memberId} big=${big ? 'y' : '-'} small=${small ? 'y' : '-'}`, 'room.unread');
    void ready().then(() => set((s) => {
      const seenTokens = { ...s.seenTokens };
      let changed = false;
      // 空串 = 该侧当前没有消息 → 不动原值（同 markSeen 的理由）
      if (big && seenTokens[bigKey] !== big) { seenTokens[bigKey] = big; changed = true; }
      if (small && seenTokens[smallKey] !== small) { seenTokens[smallKey] = small; changed = true; }
      if (!changed) return s;
      persist({ counts: s.counts, lastReadAt: s.lastReadAt, seenTokens, sideSeenAt: s.sideSeenAt, serverFloor: s.serverFloor });
      return { seenTokens };
    }));
  },

  applyUnread: (patch) => {
    const bumpPatch = patch?.bump || {};
    const seenPatch = patch?.seen || {};
    const seenAtPatch = patch?.seenAt || {};
    const floorPatch = patch?.floor || {};
    const readPatch = patch?.read || {};
    if (
      !Object.keys(bumpPatch).length
      && !Object.keys(seenPatch).length
      && !Object.keys(seenAtPatch).length
      && !Object.keys(floorPatch).length
      && !Object.keys(readPatch).length
    ) return;
    logInfo(
      `[unread] apply bump=${JSON.stringify(bumpPatch)}`
      + ` seen=[${Object.keys(seenPatch).join(',')}]`
      + ` read=[${Object.keys(readPatch).join(',')}]`
      + ` seenAt=${JSON.stringify(seenAtPatch)}`
      + ` floor=${JSON.stringify(floorPatch)}`,
      'room.unread',
    );
    void ready().then(() => set((s) => {
      const counts = { ...s.counts };
      const lastReadAt = { ...s.lastReadAt };
      const seenTokens = { ...s.seenTokens };
      const sideSeenAt = { ...s.sideSeenAt };
      const serverFloor = { ...s.serverFloor };
      let changed = false;

      // ① 已读：清零该房间**两侧**计数 + 推进房间级基线（0 = 调用方不知道 → 不动基线）
      for (const [rawId, value] of Object.entries(readPatch)) {
        const id = String(rawId || '');
        if (!id) continue;
        for (const side of ROOM_UNREAD_SIDES) {
          const key = roomUnreadKey(id, side);
          if (key && counts[key] !== undefined) { delete counts[key]; changed = true; }
        }
        // ⚠️ 同 markRead：基线只前进不后退（批量通道里的活动时间同样可能比本地基线旧）
        const at = Number(value) > 0 ? Number(value) : 0;
        if (at > 0 && at > (Number(lastReadAt[id]) || 0)) { lastReadAt[id] = at; changed = true; }
      }

      // ② 计数：分侧累加（封顶 MAX_PER_ROOM）
      for (const [rawKey, n] of Object.entries(bumpPatch)) {
        const key = String(rawKey || '');
        const delta = Number(n) || 0;
        if (!key || delta <= 0) continue;
        const next = Math.min(MAX_PER_ROOM, (counts[key] || 0) + delta);
        if (next !== counts[key]) { counts[key] = next; changed = true; }
      }

      // ③ 指纹：推进「已见」（空值不动 —— 写空会让刚进过的房间立刻冒「新」）
      for (const [rawKey, token] of Object.entries(seenPatch)) {
        const key = String(rawKey || '');
        const value = String(token || '').slice(0, MAX_TOKEN);
        if (!key || !value || seenTokens[key] === value) continue;
        seenTokens[key] = value;
        changed = true;
      }

      // ④ 单侧「最后看过的消息时间」：只前进不后退（精确计数的基线）。
      // ⚠️ 传 0 = **删除基线**（进房时用：旧基线比房间里已读的消息还旧，
      // 不清掉的话 30s 轮询会把房间里已读的消息再数一遍 —— 用户 2026-11-10「5 条显示 13」）。
      for (const [rawKey, value] of Object.entries(seenAtPatch)) {
        const key = String(rawKey || '');
        const at = Number(value) || 0;
        if (!key) continue;
        if (at <= 0) {
          if (sideSeenAt[key] !== undefined) { delete sideSeenAt[key]; changed = true; }
          continue;
        }
        if (at > (Number(sideSeenAt[key]) || 0)) { sideSeenAt[key] = at; changed = true; }
      }

      // ⑤ 服务端未读「已读地板」：打开房间那一刻的服务端未读数（直接赋值，不做单调）
      for (const [rawKey, value] of Object.entries(floorPatch)) {
        const key = String(rawKey || '');
        const n = Number(value) || 0;
        if (!key || n < 0) continue;
        if (serverFloor[key] !== n) { serverFloor[key] = n; changed = true; }
      }

      if (!changed) return s;
      persist({ counts, lastReadAt, seenTokens, sideSeenAt, serverFloor });
      return { counts, lastReadAt, seenTokens, sideSeenAt, serverFloor };
    }));
  },

  markAllRead: (baselines, tokens) => {
    void ready().then(() => set((s) => {
      const lastReadAt = { ...s.lastReadAt };
      for (const [rawId, value] of Object.entries(baselines || {})) {
        const id = String(rawId || '');
        const at = Number(value) > 0 ? Number(value) : 0;
        // 同样单调（列表活动时间可能比某房间的本地基线旧，不能让「一键已读」把基线拽回去）
        if (id && at > 0 && at > (Number(lastReadAt[id]) || 0)) lastReadAt[id] = at;
      }
      const seenTokens = { ...s.seenTokens };
      for (const [rawKey, token] of Object.entries(tokens || {})) {
        const key = String(rawKey || '');
        const value = String(token || '').slice(0, MAX_TOKEN);
        if (key && value) seenTokens[key] = value;
      }
      // 计数**整体清空**：点「全部已读」的语义就是列表上不再有任何数字/「新」
      const counts: Record<string, number> = {};
      persist({ counts, lastReadAt, seenTokens, sideSeenAt: s.sideSeenAt, serverFloor: s.serverFloor });
      // 用户明确动作（点「全部已读」）→ 立即落盘，不等 800ms 防抖
      flushRoomUnreadPersist();
      return { counts, lastReadAt, seenTokens };
    }));
  },

  seedTokens: (observed) => {
    void ready().then(() => set((s) => {
      let changed = false;
      const seenTokens = { ...s.seenTokens };
      for (const [rawKey, token] of Object.entries(observed || {})) {
        // 键已是分侧键（roomUnreadKey 产物）：这里只负责「只补缺失，不覆盖」
        const key = String(rawKey || '');
        const value = String(token || '').slice(0, MAX_TOKEN);
        if (!key || !value || seenTokens[key]) continue;
        seenTokens[key] = value;
        changed = true;
      }
      if (!changed) return s;
      persist({ counts: s.counts, lastReadAt: s.lastReadAt, seenTokens, sideSeenAt: s.sideSeenAt, serverFloor: s.serverFloor });
      return { seenTokens };
    }));
  },

  clearAll: () => {
    set({ counts: {}, lastReadAt: {}, seenTokens: {}, sideSeenAt: {}, serverFloor: {} });
    persist({ counts: {}, lastReadAt: {}, seenTokens: {}, sideSeenAt: {}, serverFloor: {} });
    // 退出登录/切账号：必须立即落盘（否则下次启动会读到旧账号的未读）
    flushRoomUnreadPersist();
  },
  };
});

// 模块加载即开始恢复磁盘数据：与「首帧就来的写操作」错开，减少它们等待 hydrate 的概率。
void useRoomUnreadStore.getState().hydrate();

export default useRoomUnreadStore;
