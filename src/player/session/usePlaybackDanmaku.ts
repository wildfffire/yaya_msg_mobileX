/**
 * 统一播放会话 · 弹幕数据源（四场景共用）
 *
 * 三种来源（与旧 MediaScreen / 房间两处实现合并，取超集）：
 *   ① 云信聊天室（直播）：useLiveBarrage —— 飘屏（liveItems）+ 弹幕列表 + 输入条 + 礼物特效，
 *      同一个 source 只建一条连接；
 *   ② HTTP 轮询（直播兜底）：pocketApi.getLiveBarrage —— 时间轴累积（pollItems）。
 *      ⚠️ 默认关闭（livePollMs=0）：房间此前只用云信，若同时启用两条链会**双源重复上屏**
 *      （同一句被云信与 poll 各飘一次）。只有主直播页（历史行为）显式传 5000 启用；
 *   ③ LRC 文件（回放）：pocketApi.getLiveLrc → parseDanmaku → 按播放时间轴上屏。
 *      liveId 兜底：回放地址里带的那段数字就是 liveId（官方回放卡不保证带 liveId）。
 */
import { useEffect, useMemo, useState } from 'react';
import pocketApi from '../../api/pocket48';
import { useLiveBarrage, type UseLiveBarrageResult } from '../../hooks/useLiveBarrage';
import { parseDanmaku, type DanmakuItem } from '../../utils/danmaku';
import { replaceEmojiText } from '../../utils/emoji';
import { errorMessage, liveIdFromUrl } from '../../utils/data';
import { logWarn } from '../../utils/runtimeLog';
import { useI18n } from '../../i18n';
import { useUiStore } from '../../store';
import type { DanmakuListEntry } from '../../components/DanmakuListSheet';
import type { ResolvedMedia } from './types';

export interface PlaybackDanmaku {
  /** 云信数据源（输入条/礼物特效直接消费） */
  barrage: UseLiveBarrageResult;
  /** 直播飘屏 items（云信，出现即上屏） */
  liveItems: Array<{ key: string; text: string }>;
  /** 直播弹幕列表条目（云信） */
  liveEntries: DanmakuListEntry[];
  /** 直播 HTTP 轮询时间轴（livePollMs>0 时才有值） */
  pollItems: DanmakuItem[];
  /** 回放 LRC 时间轴 */
  vodItems: DanmakuItem[];
  /** 回放弹幕列表条目 */
  vodEntries: DanmakuListEntry[];
  /** 归一化 liveId（含 url 兜底） */
  liveId: string;
}

export function usePlaybackDanmaku({
  resolved,
  /** 直播 HTTP 轮询间隔（ms）；0 = 不启用（默认，防双源重复） */
  livePollMs = 0,
  /** 回放 LRC 到达时 toast（「弹幕 N 条」/「该视频暂无弹幕」，主直播页现状） */
  vodNotice = false,
}: {
  resolved: ResolvedMedia | null;
  livePollMs?: number;
  vodNotice?: boolean;
}): PlaybackDanmaku {
  const { t } = useI18n();
  const isLive = !!resolved?.isLive;
  const liveId = String(
    resolved?.liveId
    || (resolved && !resolved.isLive ? liveIdFromUrl(String(resolved.url || '')) : '')
    || '',
  );

  /** ① 云信聊天室（直播）：飘屏 / 列表 / 输入条 / 礼物特效同一条连接 */
  const barrage = useLiveBarrage({
    liveId: isLive && liveId ? liveId : '',
    enabled: isLive && !!liveId,
    module: 'live',
  });
  const liveItems = useMemo(
    () => barrage.items.map((item) => ({
      key: item.id,
      text: item.nick ? `${item.nick}：${item.text}` : item.text,
    })),
    [barrage.items],
  );
  const liveEntries = useMemo<DanmakuListEntry[]>(
    () => barrage.items.map((item) => ({
      id: item.id,
      time: 0,
      nick: item.nick || '',
      text: item.text || '',
      kind: item.kind,
      userId: item.userId || undefined,
      avatar: item.avatar || undefined,
    })),
    [barrage.items],
  );

  /** ② 直播 HTTP 轮询（可选兜底）：时间轴归一化 + 去重 + 800 条上限（照搬主直播页口径） */
  const [pollItems, setPollItems] = useState<DanmakuItem[]>([]);
  useEffect(() => {
    if (!isLive || !livePollMs || !liveId) {
      setPollItems((prev) => (prev.length ? [] : prev));
      return undefined;
    }
    let alive = true;
    const seenMsg = new Set<string>();
    const collect = (infos: any[]): DanmakuItem[] => {
      const flat: DanmakuItem[] = [];
      for (const b of infos) {
        const parsed = parseDanmaku(b.content);
        if (parsed.length) flat.push(...parsed);
        // 无时间标签（直播实时弹幕常态）走这里：正文同样要过表情替换
        else flat.push({ time: Number(b.time) || 0, text: replaceEmojiText(String(b.content || '')), ...(b.user ? { nick: b.user } : {}) });
      }
      let items = flat.filter((d) => d && d.text) as DanmakuItem[];
      if (!items.length) return items;
      // 时间轴归一化：毫秒时间戳 → 秒；绝对秒时间戳 → 以最早为 0 相对偏移；全 0 → 按序均匀分配
      const rangeOf = (arr: DanmakuItem[]) => arr.reduce(
        (acc, d) => ({ max: Math.max(acc.max, d.time), min: Math.min(acc.min, d.time) }),
        { max: 0, min: Infinity },
      );
      let { max: maxT, min: minT } = rangeOf(items);
      if (maxT > 1e6) {
        items.forEach((d) => { d.time = d.time / 1000; });
        ({ max: maxT, min: minT } = rangeOf(items));
      }
      if (maxT > 1e7) {
        const base = minT;
        items.forEach((d) => { d.time = d.time - base; });
        ({ max: maxT } = rangeOf(items));
      }
      if (maxT <= 0) {
        items.forEach((d, i) => { d.time = i * 1.2; });
      }
      items.sort((a, b) => a.time - b.time);
      return items;
    };
    const poll = async () => {
      try {
        const infos = await pocketApi.getLiveBarrage(liveId);
        if (!alive) return;
        const items = collect(infos);
        if (!items.length) return;
        setPollItems((prev) => {
          const merged = [...prev];
          for (const it of items) {
            const key = it.nick ? `${it.nick}:${it.text}` : it.text;
            if (!seenMsg.has(key)) {
              seenMsg.add(key);
              // 长播防泄漏：去重集超出窗口后重建
              if (seenMsg.size > 3000) {
                seenMsg.clear();
                seenMsg.add(key);
              }
              merged.push(it);
            }
          }
          merged.sort((a, b) => a.time - b.time);
          return merged.slice(-800);
        });
      } catch { /* 轮询失败静默，不拖垮播放 */ }
    };
    poll();
    const timer = setInterval(() => { poll(); }, livePollMs);
    return () => { alive = false; clearInterval(timer); };
  }, [isLive, livePollMs, liveId]);

  /** ③ 回放 LRC */
  const [vodItems, setVodItems] = useState<DanmakuItem[]>([]);
  useEffect(() => {
    if (isLive || !liveId) {
      setVodItems((prev) => (prev.length ? [] : prev));
      return undefined;
    }
    let alive = true;
    setVodItems((prev) => (prev.length ? [] : prev));
    pocketApi.getLiveLrc(liveId)
      .then((text) => {
        if (!alive) return;
        if (!text) {
          setVodItems([]);
          if (vodNotice) useUiStore.getState().showToast(t('该视频暂无弹幕'));
          return;
        }
        const items = parseDanmaku(text);
        setVodItems(items);
        if (vodNotice) {
          useUiStore.getState().showToast(items.length > 0 ? t('弹幕 {count} 条', { count: items.length }) : t('该视频暂无弹幕'));
        }
      })
      .catch((e) => {
        if (!alive) return;
        setVodItems([]);
        logWarn('读取回放弹幕失败: ' + errorMessage(e), 'playback.danmaku');
      });
    return () => { alive = false; };
  }, [isLive, liveId, vodNotice, t]);

  const vodEntries = useMemo<DanmakuListEntry[]>(
    () => vodItems.map((d, i) => ({
      id: `vod-${i}-${d.time}`,
      time: d.time,
      nick: d.nick || '',
      text: d.text || '',
    })),
    [vodItems],
  );

  return { barrage, liveItems, liveEntries, pollItems, vodItems, vodEntries, liveId };
}

export default usePlaybackDanmaku;
