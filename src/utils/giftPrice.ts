/**
 * 礼物价格快照 + 鸡腿换算（纯函数，可单测）。用户 2026-11-09。
 *
 * 背景（对齐桌面端 common/gift-pricing.js + gift-price-sync）：
 *   · 官方 `gift/list` 的单价字段批次之间不一致（money/cost/price），**有时缺失**；
 *   · 桌面端把「礼物 id → 鸡腿单价 / scorePerUnit」存成**快照文件**，并按 `updatedAt`
 *     与远端价格同步（新者覆盖旧者、缺失的保留本地）；
 *   · 展示时按 `单价 × 数量` 算合计数，`scorePerUnit` 用来把鸡腿换算成贡献值
 *     （房间/榜单口径是「1 鸡腿 = N 贡献」，N 由运营配置）。
 *
 * 这里只做纯计算 + 合并；持久化与网络同步见 services/giftPrices.ts。
 */

export interface GiftPriceEntry {
  /** 单份鸡腿价 */
  chicken: number;
  /** 1 鸡腿折多少贡献值（缺失 = 未知，UI 标「待核价」） */
  scorePerUnit?: number;
  /** 该条价格的更新时间（毫秒）；合并时新者胜 */
  updatedAt: number;
}

export interface GiftPriceSnapshot {
  updatedAt: number;
  prices: Record<string, GiftPriceEntry>;
}

export const EMPTY_GIFT_PRICES: GiftPriceSnapshot = { updatedAt: 0, prices: {} };

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 解析远端/本地快照（容错：允许 prices 是数组或对象，字段名多种写法） */
export function parseGiftPriceSnapshot(raw: any): GiftPriceSnapshot {
  const src = raw?.prices ?? raw?.data?.prices ?? raw?.gifts ?? raw;
  const prices: Record<string, GiftPriceEntry> = {};
  if (Array.isArray(src)) {
    for (const item of src) {
      const id = String(item?.giftId ?? item?.id ?? '').trim();
      if (!id) continue;
      prices[id] = {
        chicken: num(item?.chicken ?? item?.money ?? item?.cost ?? item?.price),
        scorePerUnit: item?.scorePerUnit != null ? num(item.scorePerUnit) : undefined,
        updatedAt: num(item?.updatedAt ?? item?.updated ?? 0),
      };
    }
  } else if (src && typeof src === 'object') {
    for (const [key, item] of Object.entries(src as Record<string, any>)) {
      const id = String(key || '').trim();
      if (!id) continue;
      if (typeof item === 'number') {
        prices[id] = { chicken: num(item), updatedAt: num(raw?.updatedAt ?? 0) };
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      prices[id] = {
        chicken: num(item.chicken ?? item.money ?? item.cost ?? item.price),
        scorePerUnit: item.scorePerUnit != null ? num(item.scorePerUnit) : undefined,
        updatedAt: num(item.updatedAt ?? item.updated ?? raw?.updatedAt ?? 0),
      };
    }
  }
  return { updatedAt: num(raw?.updatedAt ?? raw?.updated ?? 0), prices };
}

/** 合并两份快照：逐礼物按 updatedAt 取新；本地有、远端没有的保留 */
export function mergeGiftPrices(local: GiftPriceSnapshot, remote: GiftPriceSnapshot): GiftPriceSnapshot {
  const prices: Record<string, GiftPriceEntry> = { ...(local?.prices || {}) };
  for (const [id, entry] of Object.entries(remote?.prices || {})) {
    const prev = prices[id];
    if (!prev || (Number(entry.updatedAt) || 0) >= (Number(prev.updatedAt) || 0)) {
      prices[id] = { ...entry, scorePerUnit: entry.scorePerUnit ?? prev?.scorePerUnit };
    }
  }
  return {
    updatedAt: Math.max(Number(local?.updatedAt) || 0, Number(remote?.updatedAt) || 0),
    prices,
  };
}

/** 礼物 id（官方 giftId / id 两种写法） */
export function giftIdOf(gift: any): string {
  return String(gift?.giftId ?? gift?.id ?? '').trim();
}

/**
 * 单价（鸡腿）：接口字段优先（实时最准），缺失时用快照；
 * 返回 source 便于 UI 区分「官方价 / 快照价 / 未知（待核价）」。
 */
export function resolveGiftChicken(gift: any, snapshot?: GiftPriceSnapshot | null): { unit: number; source: 'api' | 'snapshot' | 'unknown' } {
  const api = num(gift?.money ?? gift?.cost ?? gift?.price);
  if (api > 0) return { unit: api, source: 'api' };
  const entry = snapshot?.prices?.[giftIdOf(gift)];
  if (entry && entry.chicken > 0) return { unit: entry.chicken, source: 'snapshot' };
  return { unit: 0, source: 'unknown' };
}

/** 合计鸡腿 = 单价 × 数量 */
export function giftChickenTotal(gift: any, count: number, snapshot?: GiftPriceSnapshot | null): { unit: number; total: number; source: 'api' | 'snapshot' | 'unknown' } {
  const { unit, source } = resolveGiftChicken(gift, snapshot);
  const n = Math.max(1, Math.trunc(Number(count) || 1));
  return { unit, total: unit * n, source };
}

/**
 * 贡献值（鸡腿 × scorePerUnit）。
 * scorePerUnit 未知时返回 null —— 调用方**不要**猜 1:1，显示「待核价」即可
 * （桌面端 gift-pricing 对未核价礼物也是不计入合计）。
 */
export function giftContribution(gift: any, count: number, snapshot?: GiftPriceSnapshot | null): number | null {
  const entry = snapshot?.prices?.[giftIdOf(gift)];
  const per = num(gift?.scorePerUnit) || num(entry?.scorePerUnit);
  if (per <= 0) return null;
  const { total } = giftChickenTotal(gift, count, snapshot);
  if (total <= 0) return null;
  return total * per;
}
