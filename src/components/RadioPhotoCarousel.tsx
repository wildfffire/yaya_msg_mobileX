/**
 * 电台直播 · 成员照片轮播层（用户 2026-11-04）。
 *
 * 为什么需要它：口袋电台直播（`liveType = 2`）没有真正的视频画面，推流里那张静态图
 * 写着「成员离开」；官方客户端在播放器画面上轮播成员照片（`getLiveOne → content.carousels`）。
 *
 * 显示与交互口径（用户 2026-11-04 两次明确）：
 *   · 照片**完整显示**（`contain`）——横屏看竖图也不裁切；留边处用同图 cover + 暗化垫底；
 *   · 翻页**复用房间图片查看器的逻辑**（`components/PhotoPager`：长条定位 + 跟手位移 +
 *     速度惯性判定），并加自动轮播（`autoPlayMs`，官方 `carouselTime`）；
 *   · 手势由播放器容器转发进来（本层在 PlayerChrome 之下，收不到触摸）——
 *     对外暴露 `beginDrag/dragBy/settle/cancelDrag`，向内转给 PhotoPager。
 *
 * 层级：调用方必须把它放在 PlayerScreen 的 `children` 里（在 PlayerChrome 之下），
 * 这样控制层、弹幕、礼物特效仍然正常盖在照片上。
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { NetworkImage } from './NetworkImage';
import { PhotoPager, type PhotoPagerHandle } from './PhotoPager';
import { DEFAULT_CAROUSEL_INTERVAL_MS } from '../utils/liveCarousel';

/** 对外命令：左右滑动由 PlayerScreen 的容器手势回调驱动 */
export interface RadioPhotoCarouselHandle {
  next: () => void;
  prev: () => void;
  beginDrag: () => void;
  dragBy: (dx: number) => void;
  settle: (dx: number, vx: number) => void;
  cancelDrag: () => void;
}

export interface RadioPhotoCarouselProps {
  /** 轮播照片（绝对地址，来自 getLiveOne 的 carousels） */
  photos: string[];
  /** 每张停留时长（毫秒） */
  intervalMs?: number;
  /** 没有照片时的兜底图（直播封面 / 成员头像）：只静态显示，不参与轮播 */
  fallback?: string;
}

export const RadioPhotoCarousel = forwardRef<RadioPhotoCarouselHandle, RadioPhotoCarouselProps>(function RadioPhotoCarousel(
  { photos, intervalMs, fallback },
  ref,
) {
  const photosKey = (photos || []).join('|');
  /** 去重后的照片（空 → 用 fallback 单张兜底） */
  const items = useMemo(() => {
    const list = Array.from(new Set((photos || []).filter(Boolean)));
    if (list.length) return list;
    return fallback ? [fallback] : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photosKey, fallback]);
  const itemsKey = items.join('|');

  const pagerRef = useRef<PhotoPagerHandle>(null);
  const [index, setIndex] = useState(0);

  const interval = Math.max(1500, Number(intervalMs) || DEFAULT_CAROUSEL_INTERVAL_MS);

  // 换台/照片集变化：回到第一张
  useEffect(() => {
    setIndex(0);
  }, [itemsKey]);

  useImperativeHandle(ref, () => ({
    next: () => pagerRef.current?.next(),
    prev: () => pagerRef.current?.prev(),
    beginDrag: () => pagerRef.current?.beginDrag(),
    dragBy: (dx: number) => pagerRef.current?.dragBy(dx),
    settle: (dx: number, vx: number) => pagerRef.current?.settle(dx, vx),
    cancelDrag: () => pagerRef.current?.cancelDrag(),
  }), []);

  const goToIndex = useCallback((next: number) => setIndex(next), []);
  const active = items[index] || items[0] || '';

  /**
   * 没有任何照片（接口还没回来 / 详情没带 carousels）：铺黑底 + 封面兜底（暗化）——
   * 宁可先看到「干净的暗场 + 封面」，也不要露出推流里那张「成员离开」的占位图。
   */
  if (!items.length) {
    return (
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop]}>
        {fallback ? (
          <>
            <NetworkImage
              key={`only-${fallback}`}
              source={{ uri: fallback }}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
              fallback={false}
            />
            <View style={[StyleSheet.absoluteFill, styles.dimSoft]} />
          </>
        ) : null}
      </View>
    );
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* 黑底：图片加载中/失败时不透出底层视频画面（否则又会看到「成员离开」那张图） */}
      <View style={[StyleSheet.absoluteFill, styles.backdrop]} />
      {/**
       * 背景：当前页照片的 cover 版本 + 暗化遮罩。
       * `contain` 完整显示竖图时两侧会留边，有这层同图背景就不会是大片死黑。
       */}
      <NetworkImage
        key={`bg-${active}`}
        source={{ uri: active }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        fadeDuration={300}
        fallback={false}
      />
      <View style={[StyleSheet.absoluteFill, styles.dim]} />
      {/* 翻页器：复用房间图片查看器的长条定位 + 翻页判定，并开启自动轮播 */}
      <PhotoPager
        ref={pagerRef}
        urls={items}
        index={index}
        onIndexChange={goToIndex}
        autoPlayMs={interval}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  backdrop: { backgroundColor: '#08080a' },
  /** 背景暗化：保证 contain 的前景照片（尤其竖图）在控制条/弹幕下依然清晰 */
  dim: { backgroundColor: 'rgba(0,0,0,0.58)' },
  /** 只有封面兜底时压得更暗一点：它不是正片，不该抢注意力 */
  dimSoft: { backgroundColor: 'rgba(0,0,0,0.42)' },
});

export default RadioPhotoCarousel;
