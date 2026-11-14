/**
 * 直播间送礼（数据 + 发送）· 播放功能模块的唯一实现（用户 2026-11-13）。
 *
 * 以前直播页与房间各写一份 openGiftPanel / sendGift：礼物列表、余额、数量、
 * 送礼接口、云信公屏广播、错误文案全靠自觉同步，改一处另一处不会变。
 * 现在只在这里：宿主（播放中的直播）与房间工具栏（未起播时）共用同一个 hook，
 * UI 也是同一个组件 `components/LiveGiftSheet.tsx`。
 */
import { useCallback, useState } from 'react';
import { useI18n } from '../../i18n';
import pocketApi from '../../api/pocket48';
import { errorMessage } from '../../utils/data';
import { giftImage, giftName, normalizeGiftList } from '../../utils/gift';
import type { LiveGiftBroadcast } from '../../services/pocketNim/types';

export interface UsePlaybackGiftOptions {
  /** 本场直播 id（空 = 不能送礼） */
  liveId: string;
  /** 主播 userId（礼物入账 + 公屏广播的 toUserId） */
  targetUserId: string;
  /** 主播昵称（公屏广播展示用） */
  targetName?: string;
  /** 公屏广播（走宿主内的云信连接；没有连接时传空函数即可） */
  broadcast?: (gift: LiveGiftBroadcast) => void;
}

export function usePlaybackGift({
  liveId,
  targetUserId,
  targetName,
  broadcast,
}: UsePlaybackGiftOptions) {
  const { t } = useI18n();
  const [gifts, setGifts] = useState<any[]>([]);
  const [balance, setBalance] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<any | null>(null);
  /** 数量输入框原样字符串（与直播页一致：允许用户直接键入） */
  const [num, setNum] = useState('1');

  /**
   * 打开面板时加载：先清空上一场的礼物格（否则新请求返回前会看到上一场的列表）。
   * 返回 false = 没有可送礼的直播（调用方据此决定是否弹面板）。
   */
  const load = useCallback(async () => {
    setStatus('');
    setSelected(null);
    setNum('1');
    setGifts([]);
    const id = String(liveId || '');
    if (!id) {
      setStatus(t('当前没有可送礼的直播'));
      return false;
    }
    try {
      const [giftRes, moneyRes] = await Promise.all([
        pocketApi.getGiftList(id).catch(() => null),
        pocketApi.getUserMoney().catch(() => null),
      ]);
      const list = normalizeGiftList(giftRes);
      setGifts(list);
      const money = moneyRes?.content?.moneyTotal ?? moneyRes?.data?.moneyTotal;
      if (money !== undefined && money !== null && money !== '') setBalance(String(money));
      setStatus(list.length ? t('已加载 {count} 个礼物', { count: list.length }) : t('礼物列表为空'));
      return true;
    } catch (err) {
      setGifts([]);
      setStatus(t('加载礼物失败：{error}', { error: errorMessage(err) }));
      return true;
    }
  }, [liveId, t]);

  /** 送出礼物（HTTP + 云信公屏广播；广播失败静默，不影响「已送出」结果） */
  const send = useCallback(async () => {
    if (!selected) {
      setStatus(t('请先选择礼物'));
      return;
    }
    const id = String(liveId || '');
    if (!id) {
      setStatus(t('当前没有可送礼的直播'));
      return;
    }
    if (!targetUserId) {
      setStatus(t('无法获取主播 ID，不能送礼'));
      return;
    }
    const count = Math.max(1, Math.floor(Number(num) || 1));
    setStatus(t('正在发送...'));
    try {
      await pocketApi.sendGift({
        giftId: String(selected.giftId || selected.id),
        liveId: id,
        acceptUserId: targetUserId,
        giftNum: count,
      });
      /**
       * ⚠️ 礼物公屏广播（用户 2026-09-29：「我送礼物，主播看不到我送的」）：
       * HTTP 接口只扣款/入账，公屏是客户端发到云信聊天室的。
       * 广播失败一律静默：礼物已经送出，公屏失败不该把「已送出」变成失败提示。
       */
      try {
        broadcast?.({
          toUserId: targetUserId,
          toName: String(targetName || ''),
          giftId: String(selected.giftId || selected.id),
          giftName: giftName(selected),
          giftNum: count,
          giftPic: giftImage(selected),
        });
      } catch { /* 公屏失败不影响送礼结果 */ }
      setStatus(t('已送出 {num} 个 {giftName}', { num: count, giftName: giftName(selected) }));
      const money = await pocketApi.getUserMoney().catch(() => null);
      const total = money?.content?.moneyTotal ?? money?.data?.moneyTotal;
      if (total !== undefined && total !== null) setBalance(String(total));
    } catch (err) {
      setStatus(t('送礼失败：{error}', { error: errorMessage(err) }));
    }
  }, [selected, liveId, targetUserId, targetName, num, broadcast, t]);

  return { gifts, balance, status, selected, select: setSelected, num, setNum, load, send };
}

export default usePlaybackGift;
