/**
 * 礼物价格快照的持久化 + 同步（用户 2026-11-09）。
 *
 * 分工：
 *   · 纯规则（解析/合并/折算）在 utils/giftPrice.ts
 *   · 这里：AsyncStorage 落盘 + 可选的远端快照同步（按 updatedAt 合并，新者胜）
 *
 * ⚠️ 远端地址默认留空：没有官方价格源时**不发任何请求**（宁可用接口字段 + 本地快照），
 *    配置 `GIFT_PRICE_SNAPSHOT_URL` 后每次房间/直播打开礼物面板会节流同步一次。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import {
  EMPTY_GIFT_PRICES,
  mergeGiftPrices,
  parseGiftPriceSnapshot,
  type GiftPriceSnapshot,
} from '../utils/giftPrice';
import { logWarn } from '../utils/runtimeLog';

/** 远端价格快照地址（JSON）。留空 = 不同步（只用接口字段 + 本地快照） */
export const GIFT_PRICE_SNAPSHOT_URL = '';
const STORAGE_KEY = 'yaya_gift_prices_v1';
/** 同步节流：10 分钟内不重复拉 */
const SYNC_TTL_MS = 10 * 60 * 1000;

interface GiftPriceState {
  snapshot: GiftPriceSnapshot;
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  sync: (force?: boolean) => Promise<void>;
}

let lastSyncAt = 0;
let loadingPromise: Promise<void> | null = null;

export const useGiftPriceStore = create<GiftPriceState>()((set, get) => ({
  snapshot: EMPTY_GIFT_PRICES,
  loaded: false,
  loading: false,
  load: async () => {
    if (get().loaded || loadingPromise) return loadingPromise || undefined;
    loadingPromise = (async () => {
      set({ loading: true });
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const local = raw ? parseGiftPriceSnapshot(JSON.parse(raw)) : EMPTY_GIFT_PRICES;
        set({ snapshot: local, loaded: true });
      } catch {
        set({ loaded: true });
      } finally {
        set({ loading: false });
        loadingPromise = null;
      }
    })();
    return loadingPromise;
  },
  sync: async (force = false) => {
    if (!GIFT_PRICE_SNAPSHOT_URL) return;
    const now = Date.now();
    if (!force && now - lastSyncAt < SYNC_TTL_MS) return;
    lastSyncAt = now;
    try {
      const res = await fetch(GIFT_PRICE_SNAPSHOT_URL, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const remote = parseGiftPriceSnapshot(await res.json());
      const merged = mergeGiftPrices(get().snapshot, remote);
      set({ snapshot: merged, loaded: true });
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch (error: any) {
      // 同步失败不影响使用（保留本地快照）
      logWarn(`[giftPrice] 价格快照同步失败：${error?.message || String(error)}`, 'gift');
    }
  },
}));

/** 直接读当前快照（非组件环境，如计算总价时） */
export function currentGiftPrices(): GiftPriceSnapshot {
  return useGiftPriceStore.getState().snapshot;
}

/** App 启动时调一次：读本地快照 + 触发一次节流同步 */
export function initGiftPrices() {
  void useGiftPriceStore.getState().load().then(() => useGiftPriceStore.getState().sync());
}
