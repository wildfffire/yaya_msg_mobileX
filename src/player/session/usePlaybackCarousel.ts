/**
 * 播放会话 · 电台直播轮播照片（用户 2026-11-04）。
 *
 * 电台直播（`liveType = 2`）没有视频画面，官方推流里只有一张「成员离开」的占位图；
 * 官方客户端在播放器画面上叠的是 `getLiveOne → content.carousels` 里的成员照片轮播。
 * 本 hook 负责把这份数据补齐，宿主据此渲染 `RadioPhotoCarousel`。
 *
 * 数据来源（按优先级，避免重复请求）：
 *   ① 解析层已经带出的照片（`resolveMedia` 从 `getLiveOne` 详情里顺手取出）；
 *   ② services/liveCarousel 的短缓存（详情/公告等链路先拿到过）；
 *   ③ liveId 现拉一次（90s 缓存 + 并发合并，失败静默）。
 *
 * 电台判定：列表项 `liveType === 2`（hintRadio）或详情 `liveType === 2`（radio）。
 * `content.type` **不是**判据（实测电台时仍是 1），见 utils/liveCarousel 文件头。
 */
import { useEffect, useState } from 'react';
import { DEFAULT_CAROUSEL_INTERVAL_MS, type LiveCarousel } from '../../utils/liveCarousel';
import { cachedLiveCarousel, fetchLiveCarousel } from '../../services/liveCarousel';

export interface UsePlaybackCarouselOptions {
  isLive: boolean;
  liveId: string;
  /** 调用方已知「这是电台」（直播列表项的 liveType===2） */
  hintRadio?: boolean;
  /** 解析层带出的照片（优先，省一次请求） */
  photos?: string[];
  intervalMs?: number;
}

function merge(base: LiveCarousel, remote: LiveCarousel, hintRadio: boolean): LiveCarousel {
  const photos = remote.photos.length ? remote.photos : base.photos;
  return {
    photos,
    intervalMs: remote.photos.length ? remote.intervalMs : base.intervalMs,
    radio: base.radio || remote.radio || hintRadio,
  };
}

export function usePlaybackCarousel({ isLive, liveId, hintRadio, photos, intervalMs }: UsePlaybackCarouselOptions): LiveCarousel {
  const providedKey = (photos || []).join('|');
  const [state, setState] = useState<LiveCarousel>({
    photos: photos || [],
    intervalMs: intervalMs && intervalMs > 0 ? intervalMs : DEFAULT_CAROUSEL_INTERVAL_MS,
    radio: !!hintRadio || (photos || []).length > 0,
  });

  useEffect(() => {
    const provided = providedKey ? providedKey.split('|') : [];
    const base: LiveCarousel = {
      photos: provided,
      intervalMs: intervalMs && intervalMs > 0 ? intervalMs : DEFAULT_CAROUSEL_INTERVAL_MS,
      radio: !!hintRadio || provided.length > 0,
    };
    setState(base);

    if (!isLive || !liveId) return;

    // 解析层已带照片：无需再请求
    if (provided.length) return;

    /**
     * 缓存命中：直接采用并**不再请求** —— 缓存里可能是「确实没有轮播照片」的结论
     * （视频直播 / 拉取失败后的短缓存），再打一次接口纯属浪费（口袋风控敏感）。
     */
    const cached = cachedLiveCarousel(liveId);
    if (cached) {
      setState((prev) => merge(prev, cached, !!hintRadio));
      return;
    }

    let alive = true;
    void fetchLiveCarousel(liveId).then((remote) => {
      if (!alive) return;
      setState((prev) => merge(prev, remote, !!hintRadio));
    });
    return () => { alive = false; };
  }, [isLive, liveId, providedKey, intervalMs, hintRadio]);

  return state;
}

export default usePlaybackCarousel;
