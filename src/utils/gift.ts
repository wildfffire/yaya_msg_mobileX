/**
 * 礼物数据归一化（直播页与房间共用同一套口径）。
 *
 * 为什么要单独一处：房间礼物面板此前自己写了一份「平铺数组」的解析
 * （`content.gifts || content.giftList || …`），而官方 `gift/list` 返回的是
 * **分类数组**（每项里再套 `giftList`）—— 房间侧因此经常显示「礼物列表为空」，
 * 直播页却正常。两边共用一份 `normalizeGiftList` 后不会再出现这种口径漂移。
 */
import { unwrapList } from './data';
import { normalizeUrl } from './data';
import { translate } from '../i18n';

/** 官方 `gift/list` → 扁平礼物数组（分类展开 + 按 giftId 去重） */
export function normalizeGiftList(res: any): any[] {
  const categories = unwrapList(res, ['content', 'content.list', 'data.content', 'data.list', 'list']);
  const gifts: any[] = [];
  for (const item of categories) {
    const nested = unwrapList(item, ['giftList', 'gifts', 'list']);
    if (nested.length) gifts.push(...nested);
    else if (item?.giftId || item?.id) gifts.push(item);
  }
  const seen = new Set<string>();
  return gifts.filter((gift) => {
    const id = String(gift.giftId || gift.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function giftName(gift: any): string {
  return String(gift?.giftName || gift?.name || translate('未知礼物'));
}

/** 单价（鸡腿）。官方不同批次字段名不一致，按可能顺序兜底 */
export function giftCost(gift: any): number {
  return Number(gift?.money ?? gift?.cost ?? gift?.price ?? gift?.canSendNum ?? 0) || 0;
}

/** 礼物图片（picPath 是相对路径，需 normalizeUrl 拼 source.48.cn） */
export function giftImage(gift: any): string {
  return normalizeUrl(gift?.picPath || gift?.icon || gift?.giftPic || gift?.url || '');
}
