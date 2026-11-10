/**
 * 「稍后再看」本地收藏（建议 12，用户 2026-09-30 选定）。
 *
 * 为什么单独一个 store：官方接口没有「收藏 / 稍后再看」，只能本地存一份**条目快照**
 *（id + 标题 + 封面），点击时再按 `kind` 交回对应页面重新解析播放地址 ——
 * 流地址有时效（口袋的地址带签名、公演回放地址带 wsSecret），**绝不能把 url 存下来当播放依据**。
 *
 * 持久化：zustand persist + AsyncStorage（与音乐收藏同一套写法，见 store/musicPlayerStore.ts）。
 * 容量：最多 MAX_ITEMS 条，列表是「最近加入在前」，超出直接截断尾部（= 丢最旧）。
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * 收藏来源：官方视频库 / 公演回放 / 房间直播回放。
 * 三种来源的播放地址解析链路完全不同（见 screens/watch/resolvePlayUrl.ts），
 * 所以必须分 kind 存 —— 只存 id，点击时按 kind 重新解析（地址有时效）。
 */
export type WatchLaterKind = 'video' | 'openlive' | 'replay';

export interface WatchLaterItem {
  /** 去重键 = `kind:id`（同一数字 id 在两类来源里语义不同，必须带 kind 才不会串） */
  key: string;
  kind: WatchLaterKind;
  /** video = videoId；openlive = liveId */
  id: string;
  title: string;
  cover?: string;
  /** 归属成员昵称 / 队伍（列表卡片展示队伍徽章与成员名） */
  owner?: string;
  team?: string;
  /**
   * 归属成员的**数字 id**（与成员库 `id` 同域）。
   * 用途与 `watchHistory.ownerId` 完全一致：收藏条目事后补成员名/队伍时，
   * 按 id 反查成员库（与直播页卡片同一链路），而不是靠昵称字符串硬匹配。
   */
  ownerId?: string;
  /** 是否音频形态（电台/上麦）：列表上显示「电台」而不是「视频」 */
  audio?: boolean;
  /**
   * 时长（**秒**，由补全时从接口的 endTime-startTime 算出）。
   * 用户 2026-09-30：「观看历史还是有很多信息显示不全」—— 直播页录播卡片有的时长/类型，
   * 这里以前一条都没有（存储侧根本没这些字段），所以卡片只剩标题+时间。
   */
  duration?: number;
  /** 官方类型码（1 直播 / 2 电台 / 5 游戏 / 6 AI）：比 audio 布尔更细 */
  liveType?: number;
  /** 加入时间（ms）：列表本身已按加入先后排序，这里留作后续展示/排查用 */
  at: number;
}

/** 单条上限（本地小数据，够用即可；超出丢最旧） */
const MAX_ITEMS = 200;

/**
 * 去重键 / 「同一场内容」合并桶 / 迁移用合并规则都在 `utils/watchKeys.ts`
 * （纯函数、无 store 依赖，见 `scripts/watch-dedupe.test.mjs` 的回归锁）。
 * 这里原样再导出，既有调用方（add/remove/toggle、播放器面板、页面）都不受影响。
 */
import { watchLaterKey, watchLaterBucket, mergeWatchLaterItems } from '../utils/watchKeys';

export { watchLaterKey, watchLaterBucket, mergeWatchLaterItems };



interface WatchLaterState {
  items: WatchLaterItem[];
  add: (item: Omit<WatchLaterItem, 'key' | 'at'>) => void;
  remove: (kind: WatchLaterKind, id: string | number | undefined | null) => void;
  /** 切换收藏：返回 true = 本次**加入**了，false = 本次**移出**了（直接拿去拼 toast 文案） */
  toggle: (item: Omit<WatchLaterItem, 'key' | 'at'>) => boolean;
  /** 补全缺失的展示字段（成员/队伍/封面/时长/类型）：**只补空值**，不覆盖已有内容 */
  patch: (key: string, patch: Partial<Pick<WatchLaterItem, 'title' | 'cover' | 'owner' | 'team' | 'ownerId' | 'duration' | 'liveType'>>) => void;
  clear: () => void;
}

export const useWatchLaterStore = create<WatchLaterState>()(
  persist(
    (set, get) => ({
      items: [],
      add: (item) => {
        const key = watchLaterKey(item.kind, item.id);
        const bucket = watchLaterBucket(item.kind, item.id);
        if (!key || !bucket) return;
        // 同一场内容（openlive / replay 同 id）视为一条：重复加入 = 置顶刷新，不产生第二条
        const rest = get().items.filter((it) => watchLaterBucket(it.kind, it.id) !== bucket);
        set({ items: [{ ...item, key, at: Date.now() }, ...rest].slice(0, MAX_ITEMS) });
      },
      remove: (kind, id) => {
        const bucket = watchLaterBucket(kind, id);
        if (!bucket) return;
        const next = get().items.filter((it) => watchLaterBucket(it.kind, it.id) !== bucket);
        if (next.length !== get().items.length) set({ items: next });
      },
      toggle: (item) => {
        const key = watchLaterKey(item.kind, item.id);
        const bucket = watchLaterBucket(item.kind, item.id);
        if (!key || !bucket) return false;
        if (get().items.some((it) => watchLaterBucket(it.kind, it.id) === bucket)) {
          set({ items: get().items.filter((it) => watchLaterBucket(it.kind, it.id) !== bucket) });
          return false;
        }
        set({ items: [{ ...item, key, at: Date.now() }, ...get().items].slice(0, MAX_ITEMS) });
        return true;
      },
      patch: (key, patch) => {
        const cur = get().items.find((it) => it.key === key);
        if (!cur) return;
        const next: WatchLaterItem = {
          ...cur,
          title: patch.title || cur.title,
          cover: patch.cover || cur.cover,
          owner: patch.owner || cur.owner,
          team: patch.team || cur.team,
          ownerId: patch.ownerId || cur.ownerId,
          // 数字字段用 ??（0 也是有效值：时长为 0 的极短内容不该被当空）
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
      clear: () => set({ items: [] }),
    }),
    {
      name: 'yaya_watch_later_v1',
      storage: createJSONStorage(() => AsyncStorage),
      /**
       * 版本 + 迁移（用户 2026-09-30：「同一个直播多次记录」）：
       * 旧数据里同一场直播可能同时存在 `openlive:<id>` 与 `replay:<id>` 两条，
       * 读取时按「同一场内容」桶归并成一条（字段取并集）。
       * ⚠️ 沿用同一个 storage name（不换 key），避免丢掉用户已有收藏。
       */
      version: 2,
      migrate: (persisted: any) => {
        const items = Array.isArray(persisted?.items) ? persisted.items : [];
        return { ...(persisted || {}), items: mergeWatchLaterItems(items) };
      },
      // 只持久化条目本体（actions 不进磁盘）
      partialize: (s) => ({ items: s.items }),
    },
  ),
);

export default useWatchLaterStore;
