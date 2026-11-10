import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { useI18n } from '../i18n';
import { radii } from '../theme';
import { motion } from '../theme/motion';
import { logInfo } from '../utils/runtimeLog';
import { decidePagerSwipe } from '../utils/imagePagerRules';
import { NetworkImage } from './NetworkImage';

function distance(touches: any[]) {
  if (touches.length < 2) return 0;
  const [a, b] = touches;
  const dx = a.pageX - b.pageX;
  const dy = a.pageY - b.pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 去空串 + **全局去重**（同一条消息/贴纸被重复发送时，图库里会出现同一个 URL）。
 * 幻灯片用 `url` 作 React key，重复 URL 会撞 key → 元素错位。
 */
function normalizeList(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const url = String(raw || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * 全屏图片查看器（滚动条式定位 · 2026-11-02 第三版）。
 *
 * ══ 为什么改成「绝对定位 + 位移就是真值」══
 * 旧实现是「三张幻灯片按 (i - idx) 摆放 + 翻页后把位移归零」。
 * 归零这一步和原生动画的收尾存在竞态：`setIdx` 生效了、`setValue(0)` 没生效（或被 native
 * 最后一帧覆盖），画面就停在「邻居那张」上 —— 用户看到的正是
 * 「第 5 页切到第 4 页，却显示第 3 页的照片，序号还是 4，过一会儿又自己回来」。
 *
 * 现在：所有幻灯片固定在 `left = i × 屏宽` 的长条上，**位移 pagerX 本身就是唯一真值**：
 *   · 翻页动画直接把这个长条滚到 -(next × 屏宽)，结束只改 idx（标签），**不再归零**；
 *   · idx 只用于：计数、边界、渲染窗口（当前 ±1）、缩放作用于哪一张。
 * 位置与标签不可能再分叉。
 *
 * 交互：
 *   · 左滑看更早的图、右滑看更新的图（调用方按「新 → 老」传 urls）；
 *   · 单指横滑翻页（慢拖 >25% 屏宽，或快甩速度 >0.8 且位移 >8% 屏宽）；
 *   · 双指缩放 1x~5x，放大后单指平移；捏合过的手势不会误翻页；
 *   · 顶部右侧「保存图片 / 关闭」，多图时顶部中间显示 `当前/总数`。
 */
export default function ZoomImageModal({
  url,
  urls,
  index,
  onIndexChange,
  onClose,
  onSave,
}: {
  url?: string;
  urls?: string[];
  index?: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
  onSave?: (url: string) => void;
}) {
  const { t } = useI18n();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const list = useMemo(() => {
    const fromList = Array.isArray(urls) && urls.length ? urls : [];
    const base = fromList.length ? fromList : url ? [url] : [];
    const normalized = normalizeList(base);
    // 当前图不在列表里（调用方只给了 url）时补进去，避免「看不见图」
    if (url && normalized.indexOf(url) < 0) normalized.unshift(url);
    return normalized;
  }, [url, urls]);
  const listKey = list.join('\u0000');

  const [idx, setIdx] = useState(0);
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  /**
   * 长条位移（真值）：第 i 张在 left = i × 屏宽，pagerX 为长条的 translateX。
   * 翻页 = 把它滚到 -(i × 屏宽)，**不需要归零**。
   */
  const pagerX = useRef(new Animated.Value(0)).current;

  const startScale = useRef(1);
  const startDistance = useRef(0);
  const startOffset = useRef({ x: 0, y: 0 });
  /** 本次手势里出现过双指：松手时不能当成横滑翻页 */
  const pinchedRef = useRef(false);
  /** 本次手势是否真的横向拖过 */
  const horizontalRef = useRef(false);
  /** 上一次「点击」（双击检测：间隔 <320ms、位置相近、两次都没移动） */
  const lastTapRef = useRef({ t: 0, x: 0, y: 0 });
  /** 手指是否还按着（看门狗不能在拖动中纠正位置） */
  const gestureActiveRef = useRef(false);
  /** 正在做翻页动画：期间的重复 release 忽略 */
  const transitioningRef = useRef(false);
  /** 打开时的起始下标：只在「换了一批图」时读一次 */
  const initialIndexRef = useRef(Number(index) || 0);
  initialIndexRef.current = Number(index) || 0;
  /** 手势回调里读最新值（PanResponder 只创建一次） */
  const liveRef = useRef({ idx: 0, len: 0, width: screenWidth });
  liveRef.current = { idx, len: list.length, width: screenWidth };

  const pageX = (i: number) => -i * screenWidth;

  const resetZoom = () => {
    scale.setValue(1);
    translateX.setValue(0);
    translateY.setValue(0);
  };

  // 打开 / 换列表：长条滚到起始页（只在这一刻设定位置真值）
  useEffect(() => {
    gestureActiveRef.current = false;
    transitioningRef.current = false;
    if (!list.length) {
      pagerX.setValue(0);
      resetZoom();
      return;
    }
    const start = clamp(initialIndexRef.current, 0, list.length - 1);
    logInfo(`[img.view] 打开 ${start + 1}/${list.length}`, 'media');
    setIdx(start);
    pagerX.setValue(-start * screenWidth);
    resetZoom();
    // listKey 用字符串身份：只有「换了一批图」才复位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);

  /** 转屏 / 尺寸变化：保持当前页，按新的屏宽重新定位（首次挂载跳过，交给上面的打开逻辑） */
  const firstLayoutRef = useRef(true);
  useEffect(() => {
    if (firstLayoutRef.current) {
      firstLayoutRef.current = false;
      return;
    }
    if (!list.length) return;
    pagerX.setValue(-liveRef.current.idx * liveRef.current.width);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenWidth]);

  // 相邻两张预热
  useEffect(() => {
    if (list.length < 2) return;
    [list[idx - 1], list[idx + 1]].forEach((next) => {
      if (next) Image.prefetch(next).catch(() => {});
    });
  }, [idx, listKey, list]);

  /**
   * 位置看门狗：空闲时若长条没有精确停在「当前 idx × 屏宽」，直接纠正并记日志。
   * 正常流程下永远不会触发；一旦触发，logcat 里会出现 `[img.view] 位置纠正`，
   * 说明有别的路径动过 pagerX。
   */
  useEffect(() => {
    if (!list.length) return undefined;
    const timer = setInterval(() => {
      if (gestureActiveRef.current || transitioningRef.current) return;
      pagerX.stopAnimation((value: number) => {
        const target = -liveRef.current.idx * liveRef.current.width;
        // 阈值放到 4px：native 动画收尾会有 1~3px 的浮点误差，不值得纠正/刷日志
        if (Math.abs(value - target) > 4) {
          logInfo(`[img.view] 位置纠正 ${Math.round(value)} → ${Math.round(target)}（第 ${liveRef.current.idx + 1} 张）`, 'media');
          pagerX.setValue(target);
        }
      });
    }, 800);
    return () => clearInterval(timer);
  }, [list.length, pagerX, idx]);

  const springTo = (i: number) => {
    Animated.spring(pagerX, {
      toValue: -i * liveRef.current.width,
      ...motion.spring.bouncy,
      useNativeDriver: true,
    }).start();
  };

  /** 缩放到指定倍数/位移（双击用） */
  const animateZoom = (s: number, x: number, y: number) => {
    Animated.parallel([
      Animated.spring(scale, { toValue: s, ...motion.spring.bouncy, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: x, ...motion.spring.bouncy, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: y, ...motion.spring.bouncy, useNativeDriver: true }),
    ]).start();
  };

  /** 双击：放大态 → 还原；1x → 以双击点为中心放大到 2x */
  const handleDoubleTap = (pageX: number, pageY: number, currentScale: number) => {
    if (currentScale > 1.01) {
      animateZoom(1, 0, 0);
      logInfo('[img.gesture] 双击还原', 'media');
      return;
    }
    const s = 2;
    const dx = (Number(pageX) || screenWidth / 2) - screenWidth / 2;
    const dy = (Number(pageY) || screenHeight / 2) - screenHeight / 2;
    // 变换顺序是 translate 后 scale，缩放 T 时让双击点不动 → translate = -dx
    const bx = ((s - 1) * screenWidth) / (2 * s);
    const by = ((s - 1) * screenHeight) / (2 * s);
    animateZoom(s, clamp(-dx, -bx, bx), clamp(-dy, -by, by));
    logInfo('[img.gesture] 双击放大 2x', 'media');
  };

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    /**
     * ★ 拒绝被抢手势（2026-11-02 修「双指缩放无效」的根因）。
     * 真机日志：第二根手指落下的同一毫秒就收到 `onPanResponderTerminate`（down → terminate，
     * 一次 move 都没有）—— 说明有别的视图在第二根手指按下时请求接管。
     * PanResponder 默认允许（返回 true），于是我们永远拿不到 `touches.length >= 2` 的 move 事件。
     */
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    /** 捕获阶段就声明（双保险）：图片区域没有别的交互，不会被误伤 */
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderGrant: (event) => {
      pagerX.stopAnimation();
      pinchedRef.current = false;
      horizontalRef.current = false;
      gestureActiveRef.current = true;
      transitioningRef.current = false;
      logInfo(`[img.gesture] down idx=${liveRef.current.idx + 1}/${liveRef.current.len}`, 'media');
      startScale.current = (scale as any).__getValue() || 1;
      startDistance.current = distance(event.nativeEvent.touches);
      startOffset.current = {
        x: (translateX as any).__getValue() || 0,
        y: (translateY as any).__getValue() || 0,
      };
    },
    onPanResponderMove: (event, gesture) => {
      const touches = event.nativeEvent.touches;
      if (touches.length >= 2) {
        pinchedRef.current = true;
        const gap = distance(touches);
        /**
         * ★ 双指缩放基准（2026-11-02 修复「双指缩放没反应」）：
         * grant 时通常只有一根手指，`startDistance` 是 0；若拿 0 去兜底成「当前距离」，
         * 每次 move 的比值恒为 1 → 缩放永远不变。第二根手指落下的那一刻必须重新取基准。
         */
        if (!startDistance.current) {
          startDistance.current = gap;
          startScale.current = (scale as any).__getValue() || 1;
          logInfo(`[img.gesture] pinch start gap=${Math.round(gap)}`, 'media');
        }
        const base = startDistance.current;
        const next = base > 0 ? clamp(startScale.current * (gap / base), 1, 5) : startScale.current;
        scale.setValue(next);
        return;
      }
      const currentScale = (scale as any).__getValue() || 1;
      const { idx: at, len, width } = liveRef.current;
      if (currentScale > 1.01) {
        // 放大后单指平移：限制在图片边界内，别把图拖到屏幕外
        const boundX = ((currentScale - 1) * width) / (2 * currentScale);
        const boundY = ((currentScale - 1) * width) / (2 * currentScale);
        translateX.setValue(clamp(startOffset.current.x + gesture.dx, -boundX, boundX));
        translateY.setValue(clamp(startOffset.current.y + gesture.dy, -boundY, boundY));
        return;
      }
      if (len <= 1) return;
      if (Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.4) return;
      if (Math.abs(gesture.dx) > 12) horizontalRef.current = true;
      let dx = gesture.dx;
      // 首尾方向加阻尼
      if ((at === 0 && dx > 0) || (at === len - 1 && dx < 0)) dx *= 0.35;
      // 一次手势最多拖一页
      dx = clamp(dx, -width, width);
      pagerX.setValue(-at * width + dx);
    },
    onPanResponderRelease: (_event, gesture) => {
      gestureActiveRef.current = false;
      logInfo(`[img.gesture] up idx=${liveRef.current.idx + 1} dx=${Math.round(gesture.dx)} dy=${Math.round(gesture.dy)} vx=${gesture.vx?.toFixed?.(2)} h=${horizontalRef.current ? 1 : 0} pinch=${pinchedRef.current ? 1 : 0}`, 'media');
      const currentScale = (scale as any).__getValue() || 1;
      /**
       * 双击（2026-11-02 用户要求：大小变化之后可以双击还原）：
       * 两次「几乎没有移动」的点击，间隔 <300ms。
       *   · 放大态 → 还原 1x 并居中；
       *   · 1x → 以双击点为中心放大到 2x（顺手也满足「想看清楚」的场景）。
       */
      const tapped = !pinchedRef.current
        && Math.abs(gesture.dx) < 12
        && Math.abs(gesture.dy) < 12;
      if (tapped && !transitioningRef.current) {
        const now = Date.now();
        const { pageX, pageY } = _event?.nativeEvent || ({} as any);
        const px = Number(pageX) || screenWidth / 2;
        const py = Number(pageY) || screenHeight / 2;
        const prev = lastTapRef.current;
        const near = Math.abs(px - prev.x) < 80 && Math.abs(py - prev.y) < 80;
        lastTapRef.current = { t: now, x: px, y: py };
        if (prev.t && now - prev.t < 320 && near) {
          lastTapRef.current = { t: 0, x: 0, y: 0 };
          handleDoubleTap(px, py, currentScale);
          return;
        }
      }
      const wasPinch = pinchedRef.current;
      // 本次手势结束：基准清零，下一次双指重新取基准
      pinchedRef.current = false;
      startDistance.current = 0;
      if (wasPinch || currentScale > 1.01) {
        if (wasPinch) logInfo(`[img.gesture] pinch end scale=${currentScale.toFixed(2)}`, 'media');
        if (currentScale <= 1.02) {
          // 回到 1x：缩放与平移全部归位（此前 drag 带来的位移不必保留）
          Animated.parallel([
            Animated.spring(scale, { toValue: 1, ...motion.spring.bouncy, useNativeDriver: true }),
            Animated.spring(translateX, { toValue: 0, ...motion.spring.bouncy, useNativeDriver: true }),
            Animated.spring(translateY, { toValue: 0, ...motion.spring.bouncy, useNativeDriver: true }),
          ]).start();
        }
        // 缩放态永远不翻页
        return;
      }
      if (transitioningRef.current) return;
      if (!horizontalRef.current) {
        springTo(liveRef.current.idx);
        return;
      }
      const { idx: at, len, width } = liveRef.current;
      /**
       * 灵敏度（2026-11-02 第三轮，用户反馈「切图不够灵敏」）：
       * 用「当前位移 + 速度惯性预测」判定 —— 轻甩也翻页，慢慢拖要拖过 12% 屏宽。
       *   projected = dx + vx × 110ms（vx 单位 px/ms）
       * 同时要求真的移动过（>24px），避免点击/抖动触发。
       *
       * 2026-11-04：判定抽到 `utils/imagePagerRules.decidePagerSwipe`，
       * 电台直播的照片轮播共用同一套口径（不然「房间里好滑、播放器里滑不动」）。
       */
      const dir = decidePagerSwipe({
        dx: gesture.dx,
        vx: Number(gesture.vx) || 0,
        width,
        canPrev: at > 0,
        canNext: at < len - 1,
      });
      if (dir === 'settle') {
        springTo(at);
        return;
      }
      const wantNext = dir === 'next';
      const next = wantNext ? at + 1 : at - 1;
      transitioningRef.current = true;
      // 直接滚到目标页的绝对位置：结束时只改 idx（标签），**不归零**，位置与标签不可能分叉
      Animated.timing(pagerX, {
        toValue: -next * width,
        duration: 150,
        useNativeDriver: true,
      }).start((result) => {
        transitioningRef.current = false;
        if (!result?.finished) {
          // 被新手势打断：回到当前页的绝对位置
          springTo(liveRef.current.idx);
          return;
        }
        if (liveRef.current.idx !== at) {
          springTo(liveRef.current.idx);
          return;
        }
        logInfo(`[img.view] ${at + 1} → ${next + 1}（${wantNext ? '左滑更早' : '右滑更新'}）`, 'media');
        setIdx(next);
        onIndexChange?.(next);
      });
    },
    onPanResponderTerminate: () => {
      logInfo('[img.gesture] terminate（手势被系统/其它视图抢走）', 'media');
      gestureActiveRef.current = false;
      transitioningRef.current = false;
      pinchedRef.current = false;
      startDistance.current = 0;
      springTo(liveRef.current.idx);
    },
  }), [pagerX, scale, translateX, translateY, onIndexChange, screenWidth, screenHeight]);

  const currentUrl = list[idx] || '';
  const showCounter = list.length > 1;
  const slides = [idx - 1, idx, idx + 1].filter((i) => i >= 0 && i < list.length);

  return (
    <Modal visible={!!list.length} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.shade}>
        {/* 顶部右侧按钮组：保存 + 关闭 */}
        <View style={styles.topRight}>
          {onSave && currentUrl ? (
            <TouchableOpacity style={styles.topBtn} onPress={() => onSave(currentUrl)} activeOpacity={0.75}>
              <Text style={styles.closeText}>{t('保存图片')}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.topBtn} onPress={onClose} activeOpacity={0.75}>
            <Text style={styles.closeText}>{t('关闭')}</Text>
          </TouchableOpacity>
        </View>
        {showCounter ? (
          <View style={styles.counter} pointerEvents="none">
            <Text style={styles.counterText}>{`${idx + 1} / ${list.length}`}</Text>
          </View>
        ) : null}
        {list.length ? (
          <View style={styles.stage} {...responder.panHandlers}>
            <Animated.View style={[styles.pager, { transform: [{ translateX: pagerX }] }]}>
              {slides.map((slideIndex) => {
                const isCenter = slideIndex === idx;
                return (
                  <Animated.View
                    key={list[slideIndex]}
                    style={[
                      styles.slide,
                      /* 绝对定位：位置只由下标决定，与「翻到哪一页」这个标签无关 */
                      { width: screenWidth, left: slideIndex * screenWidth },
                      isCenter ? { transform: [{ translateX }, { translateY }, { scale }] } : null,
                    ]}
                  >
                    <NetworkImage
                      source={{ uri: list[slideIndex] }}
                      resizeMode="contain"
                      style={styles.image}
                      fadeDuration={0}
                      localFallback
                    />
                  </Animated.View>
                );
              })}
            </Animated.View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  shade: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' },
  stage: { flex: 1, overflow: 'hidden' },
  pager: { ...StyleSheet.absoluteFillObject },
  slide: { position: 'absolute', top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  topRight: { position: 'absolute', top: 42, right: 18, zIndex: 3, flexDirection: 'row', gap: 8 },
  topBtn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  closeText: { color: '#fff', fontSize: 13, fontWeight: '900' },
  counter: {
    position: 'absolute',
    top: 48,
    alignSelf: 'center',
    zIndex: 3,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  counterText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  image: { width: '100%', height: '100%' },
});
