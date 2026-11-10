/**
 * 统一播放会话 · 解析态管理（四场景共用）
 *
 * 页面只给 `media`（PlayMedia），本 hook 负责：
 *   ① 快速起播：地址已可播且直播/回放语义已明确 → **立即就绪**（不等接口）；
 *   ② 后台解析（resolveMedia，含多层兜底）→ 结果到达后无缝替换（同 url 不重开播放器）；
 *   ③ 代次守卫：快速换台/关闭时丢弃在途响应（防幽灵播放）；
 *   ④ 重试：直播流地址带签名有时效，失败重试 = 重新解析（而不是重播同 URL）。
 *
 * ⚠️ m3u8/mp4 二义流**不参与**快速起播（见下）：把直播当录播打开会拖进度条 seek 直播流；
 * 这种流等解析结果（几百 ms）再开，安全性优先。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, liveIdFromUrl } from '../../utils/data';
import { isPlayableMediaUrl, streamNeedsProxy } from '../../screens/room/mediaRules';
import { resolveMedia } from './resolveMedia';
import type { PlaybackStatus, PlayMedia, ResolvedMedia } from './types';

/** 会话标识：media 引用可能每次渲染新建，用内容 key 判定「是否换了要播的东西」 */
export function playMediaKey(m: PlayMedia | null | undefined): string {
  if (!m) return '';
  return [m.kind, m.liveId || m.videoId || '', m.url || '', m.title || ''].join('|');
}

export interface UsePlaybackSessionOptions {
  media: PlayMedia | null;
  /** 解析完成回调（页面拿 detail 做公告等场景逻辑） */
  onResolved?: (resolved: ResolvedMedia) => void;
  /** 关闭后停止解析（页面卸载/未激活） */
  enabled?: boolean;
}

export function usePlaybackSession({ media, onResolved, enabled = true }: UsePlaybackSessionOptions) {
  const [status, setStatus] = useState<PlaybackStatus>('idle');
  const [resolved, setResolved] = useState<ResolvedMedia | null>(null);
  const [error, setError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const seqRef = useRef(0);
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;

  const key = playMediaKey(media);

  useEffect(() => {
    // 关闭 / 未激活：清空并作废在途解析（旧响应回来不再唤醒播放器）
    if (!enabled || !media) {
      seqRef.current += 1;
      setStatus('idle');
      setResolved(null);
      setError('');
      return;
    }
    const seq = ++seqRef.current;
    const alive = () => seq === seqRef.current;
    setError('');

    /**
     * 快速起播（与旧 MediaScreen「列表项自带地址先播起来」/ 房间「卡片自带地址」同口径）：
     * 仅当「rtmp/flv（必为直播）」或「调用方已明确 isLive」或「回放（kind=replay）」时才敢直接播 ——
     * m3u8/mp4 的直播/回放二义必须等解析判定，否则直播被当录播打开后拖进度条会出问题。
     */
    const quickUrl = String(media.url || '');
    const lower = quickUrl.toLowerCase();
    const isRtmpFlv = lower.startsWith('rtmp://') || lower.includes('.flv');
    /** 恒为「点播/直接播放」的形态：不参与直播/回放二义 */
    const alwaysVod = media.kind === 'replay' || media.kind === 'audio' || media.kind === 'direct';
    const quickSafe = isPlayableMediaUrl(quickUrl)
      && (isRtmpFlv || media.isLive !== undefined || alwaysVod);
    if (quickSafe) {
      const quickLiveId = String(media.liveId || liveIdFromUrl(quickUrl) || '');
      setResolved({
        url: quickUrl,
        urls: Array.from(new Set([quickUrl, ...(media.urls || [])].filter(Boolean))),
        title: String(media.title || ''),
        cover: media.cover,
        liveId: quickLiveId,
        isLive: alwaysVod ? false : (media.isLive !== undefined ? !!media.isLive : isRtmpFlv),
        needsExo: streamNeedsProxy(quickUrl),
        audioOnly: !!media.audioOnly,
        ref: alwaysVod && quickLiveId ? { kind: 'replay', id: quickLiveId } : undefined,
        // 电台直播（liveType=2）：首帧就用照片轮播形态（照片由宿主 hook 补拉）
        radio: !!media.radio,
        carouselPhotos: media.carouselPhotos,
        carouselIntervalMs: media.carouselIntervalMs,
      });
      setStatus('ready');
    } else {
      setResolved(null);
      setStatus('resolving');
    }

    (async () => {
      try {
        const r = await resolveMedia(media);
        if (!alive()) return; // 期间已换台/关闭：丢弃过期结果
        setResolved(r);
        setStatus('ready');
        onResolvedRef.current?.(r);
      } catch (e) {
        if (!alive()) return;
        // 快速起播已就绪时：后台解析失败不推翻正在播放的源（能播就播）
        if (quickSafe) return;
        setError(errorMessage(e));
        setStatus('error');
      }
    })();

    // media 内容 key / 重试 / 开关变化才重跑；media 对象引用变化忽略（内容 key 相同 = 同一条）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retryToken, enabled]);

  const retry = useCallback(() => setRetryToken((n) => n + 1), []);

  return { status, resolved, error, retry };
}

export default usePlaybackSession;
