/**
 * 观看历史（用户 2026-09-30 要求：历史记录 + 统计，并在设置页有统一入口）。
 *
 * 与「稍后再看」的分工：
 *   - 稍后再看 = 用户**主动**标记，条目少，语义是「待看」；
 *   - 历史 = **播放器打开时自动**记录（上限 500 条），带观看次数，语义是「看过什么、看过几次」。
 *
 * 记录点在 src/player/PlayerScreen.tsx 的 `open()` 收口处 —— 全项目所有大播放器
 *（直播 / 回放 / 视频库 / 公演 / 房间）都经过它，所以任何入口播放都会自动进历史，不需要逐页埋点。
 *
 * 可回放性：只存 `ref`（PlayerContentRef）与 `liveId`，**不存播放地址** ——
 * 地址带签名/wsSecret 有时效，点击时按 ref/liveId 重新解析（见 screens/watch/resolvePlayUrl.ts）。
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { PlayerContentRef, StreamKind } from '../player/types';

export interface WatchHistoryInput {
  /** 播放器 source.kind：live / vod / audio …（用于列表上的类型标签） */
  kind: StreamKind;
  /** 内容来源引用（可回放的前提） */
  ref?: PlayerContentRef;
  /** 直播/回放的 liveId（无 ref 时的回放依据） */
  liveId?: string;
  title: string;
  cover?: string;
  /** 归属成员昵称 / 队伍（列表卡片展示队伍徽章与成员名） */
  owner?: string;
  team?: string;
  /**
   * 归属成员的**数字 id**（官方条目 `userInfo.userId`，与成员库 `id` 同域）。
   *
   * ⚠️ 这是「历史和稍后再看成员名/队伍经常出问题」的根治字段（用户 2026-09-30）：
   * 只存昵称时，事后要补队伍只能靠字符串匹配 —— 昵称带不带团体前缀、是不是别称、
   * 成员库同步没同步，任何一种偏差都会匹配不上，队伍就永远空着。
   * 存下数字 id 后，列表卡片与后台补全都走「userId → 成员库」，与直播页卡片同一条链路。
   */
  ownerId?: string;
  /** 是否音频形态（电台/上麦）：列表上显示「电台」而不是「视频」 */
  audio?: boolean;
  /** 时长（**秒**，补全时从接口的 endTime-startTime 算出）—— 与直播页录播卡片对齐 */
  duration?: number;
  /** 官方类型码（1 直播 / 2 电台 / 5 游戏 / 6 AI） */
  liveType?: number;
}

export interface HistoryItem extends WatchHistoryInput {
  key: string;
  /** 最近一次观看时间（ms） */
  at: number;
  /** 累计观看次数（统计口径：同一条内容每被打开一次 +1） */
  count: number;
}

/** 单条上限：超出丢最旧（列表是「最近在前」，截断尾部即可） */
const MAX_ITEMS = 500;
/**
 * 去重窗口：同一条内容在这个时间窗内被再次 open **不累加次数**。
 * 为什么需要：直播/回放失败换候选线路（或页面重新解析拿到新地址）时 source.url 会变，
 * PlayerScreen 的 open effect 会重跑 —— 不设窗口的话「看过 1 次」会被算成「看过 3 次」。
 */
const DEDUP_MS = 10_000;

/**
 * 去重键与合并规则已抽到 `utils/watchKeys.ts`（纯函数、无 store 依赖，可被单测钉住 ——
 * 见 `scripts/watch-dedupe.test.mjs`）。这里原样再导出，既有调用方（record / persist migrate）
 * 与页面都不受影响。
 */
import { historyKey, mergeHistoryItems } from '../utils/watchKeys';

export { historyKey, mergeHistoryItems };

interface WatchHistoryState {
  items: HistoryItem[];
  /** 记录一次播放（同一条 → 计数 +1 并置顶） */
  record: (input: WatchHistoryInput) => void;
  /** 补全缺失的展示字段（成员/队伍/封面/时长/类型）：**只补空值**，不覆盖已有内容 */
  patch: (key: string, patch: Partial<Pick<HistoryItem, 'title' | 'cover' | 'owner' | 'team' | 'ownerId' | 'duration' | 'liveType'>>) => void;
  remove: (key: string) => void;
  clear: () => void;
}

export const useWatchHistoryStore = create<WatchHistoryState>()(
  persist(
    (set, get) => ({
      items: [],
      record: (input) => {
        const key = historyKey(input);
        // 既无来源也无标题的记录没有意义（多为「地址解析中」的占位打开）
        if (!key || key === 't:') return;
        const prev = get().items.find((it) => it.key === key);
        const now = Date.now();
        const withinDedup = !!prev && now - Number(prev.at || 0) < DEDUP_MS;
        const next: HistoryItem = {
          ...input,
          key,
          at: now,
          // 窗口内重复 open（换线路/重解析）不算新的一次观看
          count: withinDedup ? (prev?.count || 1) : (prev?.count || 0) + 1,
          // 本次拿不到标题/封面时保留上一次的（meta 是异步到达的，先来的那次往往是空的）
          title: String(input.title || prev?.title || ''),
          cover: input.cover || prev?.cover,
          /**
           * 成员/队伍/音频形态同样「本次没有就沿用上一次」：
           * 从历史/稍后再看点开播放时是跳 Media 页播的（参数里只有 url/liveId/标题），
           * 那一轮的 record 拿不到 nickname/team —— 不保留旧值的话，
           * 卡片上的队伍徽章会在看第二次后消失。
           */
          owner: input.owner || prev?.owner,
          team: input.team || prev?.team,
          ownerId: input.ownerId || prev?.ownerId,
          audio: input.audio ?? prev?.audio,
        };
        set({ items: [next, ...get().items.filter((it) => it.key !== key)].slice(0, MAX_ITEMS) });
      },
      patch: (key, patch) => {
        const cur = get().items.find((it) => it.key === key);
        if (!cur) return;
        const next: HistoryItem = {
          ...cur,
          title: patch.title || cur.title,
          cover: patch.cover || cur.cover,
          owner: patch.owner || cur.owner,
          team: patch.team || cur.team,
          ownerId: patch.ownerId || cur.ownerId,
          // 数字字段用 ??（0 是有效值）
          duration: patch.duration ?? cur.duration,
          liveType: patch.liveType ?? cur.liveType,
        };
        if (
          next.title === cur.title && next.cover === cur.cover
          && next.owner === cur.owner && next.team === cur.team
          && next.ownerId === cur.ownerId
          && next.duration === cur.duration && next.liveType === cur.liveType
        ) return;
        set({ items: get().items.map((it) => (it.key === key ? next : it)) });
      },
      remove: (key) => {
        const next = get().items.filter((it) => it.key !== key);
        if (next.length !== get().items.length) set({ items: next });
      },
      clear: () => set({ items: [] }),
    }),
    {
      name: 'yaya_watch_history_v1',
      storage: createJSONStorage(() => AsyncStorage),
      /**
       * 版本 + 迁移（用户 2026-09-30：「同一个直播多次记录」「信息不全」）。
       *
       * 旧数据的 key 口径不统一（`replay:x` / `live:x` / `t:标题`）→ 同一直播裂成多条，
       * 各条字段还互补。这里在读取持久化数据时**按新口径重新归并**：
       * 合并后字段取并集、liveId 也保留下来，后续补全（封面/成员/队伍/时长）才有依据。
       * ⚠️ 刻意沿用同一个 storage name（不换 key）：换 name 会把用户已有的历史整份丢掉。
       */
      version: 2,
      migrate: (persisted: any) => {
        const items = Array.isArray(persisted?.items) ? persisted.items : [];
        return { ...(persisted || {}), items: mergeHistoryItems(items) };
      },
      partialize: (s) => ({ items: s.items }),
    },
  ),
);

/**
 * 统计（历史页顶部那行汇总用）：
 *   - total = 去重后的内容条数（就是列表长度）
 *   - today = 今天看过的新内容条数（按最近观看时间落在今天算）
 *   - plays = 累计播放次数（各条 count 之和）—— 这才是「看了多少遍」的口径
 */
export function historyStats(items: HistoryItem[]): { total: number; today: number; plays: number } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const dayStart = start.getTime();
  let today = 0;
  let plays = 0;
  for (const it of items) {
    if (Number(it.at) >= dayStart) today += 1;
    plays += Number(it.count) || 0;
  }
  return { total: items.length, today, plays };
}

export default useWatchHistoryStore;
