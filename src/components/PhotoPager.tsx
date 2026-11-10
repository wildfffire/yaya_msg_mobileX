/**
 * 图片翻页器（可内嵌 · 复用房间图片查看器的翻页手感 · 支持自动轮播）。
 *
 * 用户 2026-11-04：「图片播放的逻辑能不能复用房间里的，加个自动轮播就行」——
 * 房间里的图片查看器是 `components/ZoomImageModal`（全屏 Modal + 横滑跟手 + 双指缩放）。
 * 这里把它的**翻页渲染与判定**抽成可内嵌组件：
 *   · 长条式定位：第 i 张固定在 `left = i × 屏宽`，位移就是真值（不会出现「序号对了图片错」）；
 *   · 首尾各补一张副本（`[最后一张, ...全部, 第一张]`）→ 循环轮播、滑动无缝；
 *   · 翻页判定共用 `utils/imagePagerRules.decidePagerSwipe`（位移 + 速度惯性预测）；
 *   · `autoPlayMs` 自动轮播；用户拖动/缩放期间自动暂停，松手后重新计时。
 *
 * 手势由外部驱动（`ref.beginDrag/dragBy/settle/cancelDrag`），因为电台场景它是铺在
 * 播放器画面层（PlayerChrome 之下）、收不到触摸，必须由播放器容器把水平手势转发进来。
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';
import { NetworkImage } from './NetworkImage';
import { decidePagerSwipe } from '../utils/imagePagerRules';

/** 翻页动画时长（与房间查看器一致的手感） */
const SLIDE_MS = 220;

export interface PhotoPagerHandle {
  next: () => void;
  prev: () => void;
  /** 开始拖动（外部手势层调用）：停掉动画、暂停自动轮播 */
  beginDrag: () => void;
  /** 拖动中：把累计位移应用到长条（跟手） */
  dragBy: (dx: number) => void;
  /** 松手：按共用规则决定翻页或回弹 */
  settle: (dx: number, vx: number) => void;
  /** 手势被系统/其它视图抢走：回弹到当前页 */
  cancelDrag: () => void;
}

export interface PhotoPagerProps {
  urls: string[];
  /** 当前页（受控） */
  index: number;
  onIndexChange: (index: number) => void;
  /** 自动轮播间隔（毫秒）；不传/0 = 不自动 */
  autoPlayMs?: number;
  style?: StyleProp<ViewStyle>;
}

export const PhotoPager = forwardRef<PhotoPagerHandle, PhotoPagerProps>(function PhotoPager(
  { urls, index, onIndexChange, autoPlayMs = 0, style },
  ref,
) {
  const urlsKey = (urls || []).join('|');
  const items = useMemo(
    () => Array.from(new Set((urls || []).filter(Boolean))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [urlsKey],
  );
  const len = items.length;
  /** 首尾副本：>=2 张时循环滑动需要 */
  const slides = useMemo(
    () => (len > 1 ? [items[len - 1], ...items, items[0]] : items),
    [items, len],
  );

  const [width, setWidth] = useState(0);
  const pageWidth = Math.max(1, Math.round(width));
  /** 当前页在长条里的位置（首尾副本占了一位） */
  const paddedIndex = len > 1 ? index + 1 : 0;

  const pagerX = useRef(new Animated.Value(0)).current;
  const draggingRef = useRef(false);
  const animatingRef = useRef(false);
  /** 手势回调里读最新值，避免闭包过期 */
  const liveRef = useRef({ index, len, pageWidth });
  liveRef.current = { index, len, pageWidth };

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w > 0) setWidth((prev) => (prev === w ? prev : w));
  }, []);



  /** 滚到长条上的某个位置，落定后同步 index（跨首尾时瞬间对齐副本，画面相同不可见） */
  const slideTo = useCallback((targetPadded: number, nextIndex: number) => {
    const w = liveRef.current.pageWidth;
    animatingRef.current = true;
    Animated.timing(pagerX, {
      toValue: -targetPadded * w,
      duration: SLIDE_MS,
      useNativeDriver: true,
    }).start(({ finished }) => {
      animatingRef.current = false;
      if (!finished) return;
      const { len: n, index: cur } = liveRef.current;
      const base = -((n > 1 ? nextIndex + 1 : 0)) * liveRef.current.pageWidth;
      pagerX.setValue(base);
      if (nextIndex !== cur) onIndexChange(nextIndex);
    });
  }, [pagerX, onIndexChange]);

  const next = useCallback(() => {
    const { index: cur, len: n } = liveRef.current;
    if (n <= 1) return;
    slideTo(cur + 2, (cur + 1) % n);
  }, [slideTo]);

  const prev = useCallback(() => {
    const { index: cur, len: n } = liveRef.current;
    if (n <= 1) return;
    slideTo(cur, (cur - 1 + n) % n);
  }, [slideTo]);

  const beginDrag = useCallback(() => {
    pagerX.stopAnimation();
    draggingRef.current = true;
    animatingRef.current = false;
  }, [pagerX]);

  const dragBy = useCallback((dx: number) => {
    const { index: cur, len: n, pageWidth: w } = liveRef.current;
    if (n <= 1) return;
    const base = -((cur + 1) * w);
    // 循环模式最多拖一格，避免把两侧副本外的空白拖进画面
    const offset = Math.max(-w, Math.min(w, Number(dx) || 0));
    pagerX.setValue(base + offset);
  }, [pagerX]);

  const settle = useCallback((dx: number, vx: number) => {
    draggingRef.current = false;
    const { index: cur, len: n, pageWidth: w } = liveRef.current;
    if (n <= 1) return;
    const dir = decidePagerSwipe({ dx, vx, width: w, loop: n > 1 });
    if (dir === 'next') slideTo(cur + 2, (cur + 1) % n);
    else if (dir === 'prev') slideTo(cur, (cur - 1 + n) % n);
    else slideTo(cur + 1, cur);
  }, [slideTo]);

  const cancelDrag = useCallback(() => {
    draggingRef.current = false;
    const { index: cur, len: n } = liveRef.current;
    if (n <= 1) return;
    slideTo(cur + 1, cur);
  }, [slideTo]);

  useImperativeHandle(ref, () => ({ next, prev, beginDrag, dragBy, settle, cancelDrag }), [
    next, prev, beginDrag, dragBy, settle, cancelDrag,
  ]);

  /** 受控定位：外部 index / 尺寸变化时对齐（动画或拖动中不打断） */
  useEffect(() => {
    if (draggingRef.current || animatingRef.current) return;
    pagerX.setValue(-paddedIndex * pageWidth);
  }, [index, paddedIndex, pageWidth, pagerX]);

  /**
   * 自动轮播：**setInterval + 运行时自检**，而不是「依赖 index 的 setTimeout」。
   *
   * 为什么（2026-11-04 真机踩坑）：
   *   - 依赖 `index`/`next` 的 setTimeout 会随父级任何一次渲染重排 —— 只要依赖引用抖动，
   *     定时器就被清理重建，永远等不到 5s（表现就是「自动轮播完全不动」）；
   *   - 用户滑动回弹（index 不变）时，那次清理也恢复不回来。
   * 现在定时器只跟 `autoPlayMs/len` 走，tick 时自己看是否正在拖动/翻页动画 ——
   * 拖动期间跳过，松手后自然继续。
   */
  const nextRef = useRef(next);
  nextRef.current = next;
  useEffect(() => {
    if (!(autoPlayMs > 0) || len <= 1) return undefined;
    const timer = setInterval(() => {
      if (draggingRef.current || animatingRef.current) return;
      nextRef.current();
    }, autoPlayMs);
    return () => clearInterval(timer);
  }, [autoPlayMs, len]);

  return (
    <View style={[styles.stage, style]} onLayout={handleLayout}>
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: pagerX }] }]}>
        {slides.map((url, i) => (
          <View key={`${i}-${url}`} style={[styles.slide, { width: pageWidth, left: i * pageWidth }]}>
            <NetworkImage
              source={{ uri: url }}
              style={styles.image}
              resizeMode="contain"
              fadeDuration={0}
              localFallback
            />
          </View>
        ))}
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  stage: { overflow: 'hidden' },
  slide: { position: 'absolute', top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
});

export default PhotoPager;
