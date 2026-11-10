import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import pocketApi from '../../api/pocket48';
import { announcementSeenKey, pushSeenKey } from '../../utils/announcementSeen';

/** 已弹过的公告指纹（进程内缓存，避免每次拉公告都读盘） */
let seenKeysCache: string[] | null = null;
let seenKeysLoading: Promise<string[]> | null = null;

async function loadSeenKeys(): Promise<string[]> {
  if (seenKeysCache) return seenKeysCache;
  if (!seenKeysLoading) {
    seenKeysLoading = AsyncStorage.getItem(PLAYER_ANNOUNCE_SEEN_KEY)
      .then((raw) => {
        try {
          const parsed = raw ? JSON.parse(raw) : [];
          seenKeysCache = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          seenKeysCache = [];
        }
        return seenKeysCache as string[];
      })
      .catch(() => {
        seenKeysCache = [];
        return seenKeysCache as string[];
      });
  }
  return seenKeysLoading;
}

async function rememberSeenKey(key: string) {
  const list = pushSeenKey(await loadSeenKeys(), key);
  seenKeysCache = list;
  try { await AsyncStorage.setItem(PLAYER_ANNOUNCE_SEEN_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

/**
 * 直播间公告（统一播放宿主能力，用户 2026-10-02：房间与观看历史里也要能看公告）。
 *
 * 口径（与旧 MediaScreen 的实现一致，但**四个场景共用**）：
 *   · **直播与录播都拉**：公告挂在直播间/场次上，回放同样显示
 *     （用户 2026-10-02：「录播不显示公告」就是这个判断漏了）；
 *   · 数据源：`getLiveOne` → `getOpenLiveOne` 兜底，取到才显示；
 *   · 进入场次默认展开；用户手动收起后**跨场次/跨启动记忆**（同一 storage key）；
 *   · 换场次即清空旧公告并重拉（防串场）；已过期响应按 liveId 与请求代次双重丢弃。
 */

/** 播放器公告是否收起（'1'=收起）：跨直播间/跨启动记忆（用户要求） */
const PLAYER_ANNOUNCE_COLLAPSED_KEY = 'yaya_player_announce_collapsed_v1';
/**
 * 已弹过的公告指纹（用户 2026-11-09：「同一公告只弹一次」）。
 * 存 `liveId|djb2(正文)` 列表，最多 200 条；见 utils/announcementSeen。
 */
const PLAYER_ANNOUNCE_SEEN_KEY = 'yaya_announce_seen_v1';

export interface PlaybackAnnouncementApi {
  /** 公告正文（空串 = 无公告） */
  text: string;
  /** 面板当前是否应显示（有文本 且 未收起） */
  expanded: boolean;
  /** 是否已拿到公告（顶栏/控制坞按钮的显隐依据之一） */
  hasAnnouncement: boolean;
  /** 展开/收起（同时持久化，跨场次记住） */
  toggle: () => void;
  setExpanded: (v: boolean) => void;
  /** 重新拉取（公告面板「刷新」按钮） */
  refresh: () => Promise<void>;
}

export function usePlaybackAnnouncement(opts: { enabled: boolean; liveId: string }): PlaybackAnnouncementApi {
  const { enabled } = opts;
  const liveId = String(opts.liveId || '');
  const [text, setText] = useState('');
  const [expanded, setExpandedState] = useState(true);
  const prefLoadedRef = useRef(false);
  /** 请求代次：换场次后旧响应直接丢弃（与播放解析同一套守卫思路） */
  const seqRef = useRef(0);
  const liveIdRef = useRef(liveId);
  liveIdRef.current = liveId;

  // 收起状态持久化：挂载时读一次（'1' = 收起）
  useEffect(() => {
    if (prefLoadedRef.current) return;
    prefLoadedRef.current = true;
    AsyncStorage.getItem(PLAYER_ANNOUNCE_COLLAPSED_KEY)
      .then((v: string | null) => setExpandedState(v !== '1'))
      .catch(() => {});
  }, []);

  const setExpanded = useCallback((v: boolean) => {
    setExpandedState(v);
    AsyncStorage.setItem(PLAYER_ANNOUNCE_COLLAPSED_KEY, v ? '0' : '1').catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    setExpandedState((prev) => {
      const next = !prev;
      AsyncStorage.setItem(PLAYER_ANNOUNCE_COLLAPSED_KEY, next ? '0' : '1').catch(() => {});
      return next;
    });
  }, []);

  const fetchAnnouncement = useCallback(async (id: string, autoExpand: boolean) => {
    const lid = String(id || '');
    if (!lid) return;
    const seq = ++seqRef.current;
    try {
      const detail: any = await pocketApi.getLiveOne(lid).catch(() => null);
      let annText = String(detail?.content?.announcement || detail?.announcement || detail?.data?.announcement || '').trim();
      if (!annText) {
        const detail2: any = await pocketApi.getOpenLiveOne(lid).catch(() => null);
        annText = String(detail2?.content?.announcement || detail2?.announcement || detail2?.data?.announcement || '').trim();
      }
      if (seq !== seqRef.current) return; // 已换场次（旧响应）
      if (liveIdRef.current !== lid) return; // 已换场次（liveId 不再匹配）
      setText(annText);
      if (!annText) return;
      /**
       * 「同一公告只弹一次」（用户 2026-11-09）：
       *  · 没弹过的公告 → 展开（并记指纹）；
       *  · 弹过的公告（同一场次 + 同一段文字）→ 收起，只留顶栏按钮，用户想看再点开。
       */
      const key = announcementSeenKey(lid, annText);
      const seen = await loadSeenKeys();
      if (key && seen.includes(key)) {
        setExpandedState(false);
        return;
      }
      if (key) void rememberSeenKey(key);
      if (autoExpand) setExpanded(true);
    } catch { /* 公告拉取失败不影响播放 */ }
  }, [setExpanded]);

  // 场次变化：清空旧公告（防串场）并自动拉取
  useEffect(() => {
    if (!enabled || !liveId) {
      setText('');
      return undefined;
    }
    setText('');
    const timer = setTimeout(() => { void fetchAnnouncement(liveId, true); }, 0);
    return () => clearTimeout(timer);
  }, [enabled, liveId, fetchAnnouncement]);

  const refresh = useCallback(async () => {
    const lid = String(liveIdRef.current || '');
    if (!lid) { setText(''); return; }
    await fetchAnnouncement(lid, true);
  }, [fetchAnnouncement]);

  return {
    text,
    expanded: !!text && expanded,
    hasAnnouncement: !!text,
    toggle,
    setExpanded,
    refresh,
  };
}

export default usePlaybackAnnouncement;
