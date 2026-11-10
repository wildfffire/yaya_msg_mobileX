/**
 * 房间背景图的双层交叉淡入（从 FollowedRoomsScreen 抽出的自定义 hook，第 6 步）。
 *
 * 抽出的理由：这一组只在「换房间背景图」时工作，与消息、未读、播放器全都无关，
 * 是第 6 步里最独立的一块；抽走后主组件少了 2 个 state、5 个 ref、1 个 effect、1 个 callback。
 *
 * 行为与原实现逐字一致（连同里面记录过的两个历史坑）：
 *   ① 同一张图绝不能动 opacity（归零就是「闪一下」的直接来源）；
 *   ② A→B→A 来回切时，目标槽可能已装着同一张图，setState 同值不触发 onLoad →
 *      此时必须直接交叉淡入，否则背景停在旧房间的图（大小房间切换不过来）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

/**
 * @param bgUri 当前房间的背景图地址（空串 = 无背景，两层一起淡出）
 * @returns 两个槽位的 uri 与透明度，以及给 Image 的 onLoad / onError
 */
export function useRoomBackground(bgUri: string) {
  // 背景图渐显：新背景 uri 变化时重置为 0，ImageBackground onLoad 后淡入到 1，消除「从无到有硬跳变」
  /**
   * 背景图 **双层常驻 crossfade**（用户反馈：大小房间切换底图会闪一下）。
   *
   * 旧做法「新图新挂载一层 + 旧图垫底」的问题是：新挂载的 Image 首帧必然空白
   * （哪怕图在磁盘缓存，解码也要 1-2 帧），垫底层反而来不及兜 → 还是闪。
   *
   * 标准做法：A/B 两层**永远挂载**，换图时把新 uri 写进**当前隐藏的那一层**
   * （隐藏层保留着旧帧，不会白屏），等它 onLoad（解码完成）后两层交叉淡入淡出。
   * 同一张图则什么都不做 —— 对同一 uri 归零 opacity 就是「闪一下」的直接来源。
   */
  const bgOpacityA = useRef(new Animated.Value(0)).current;
  const bgOpacityB = useRef(new Animated.Value(0)).current;
  const [bgLayerA, setBgLayerA] = useState('');
  const [bgLayerB, setBgLayerB] = useState('');
  /** 槽位 uri 镜像 ref：setState 同值不会重渲染/onLoad，必须用 ref 判断「槽里已是什么」 */
  const bgLayerARef = useRef('');
  const bgLayerBRef = useRef('');
  const setBgLayer = (slot: 'A' | 'B', uri: string) => {
    if (slot === 'A') { bgLayerARef.current = uri; setBgLayerA(uri); }
    else { bgLayerBRef.current = uri; setBgLayerB(uri); }
  };
  const bgTopIsARef = useRef(true);
  const bgLastUriRef = useRef('');
  /** 待淡入的槽位（该槽 onLoad 后执行交叉淡入淡出） */
  const bgPendingFadeRef = useRef<'A' | 'B' | null>(null);

  /** 交叉淡入淡出：target 槽 0→1（280ms），另一槽延迟归 0；翻转顶层标记 */
  const crossfadeTo = useCallback((slot: 'A' | 'B') => {
    const inVal = slot === 'A' ? bgOpacityA : bgOpacityB;
    const outVal = slot === 'A' ? bgOpacityB : bgOpacityA;
    Animated.timing(inVal, { toValue: 1, duration: 280, useNativeDriver: true }).start();
    Animated.timing(outVal, { toValue: 0, duration: 280, delay: 120, useNativeDriver: true }).start();
    bgTopIsARef.current = slot === 'A';
  }, []);

  useEffect(() => {
    const next = bgUri;
    const last = bgLastUriRef.current;
    bgLastUriRef.current = next;
    if (next === last) return; // 同一张图：绝不能动 opacity（归零 = 闪）

    if (!next) {
      // 切到无背景房间：两层一起淡出，露出全局底衬。
      // ★ 淡出完成后**清空两个槽位**（用户 2026-10-01「房间里的灰色遮罩，会自己恢复」）：
      // 页面里 scrim 白雾层的显示条件是 `bgLayerA || bgLayerB`（槽位有 uri）——
      // 以前只淡出不清槽，无背景房间里 scrim 独自留在 PageBackdrop 上
      // （浅色 = 粉紫底 + 0.42 白雾 = 一片灰），切回有背景的房间图加载完才被盖住 =「自己恢复」。
      Animated.parallel([
        Animated.timing(bgOpacityA, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(bgOpacityB, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => {
        // ★ 竞态防御：淡出 200ms 期间用户可能又切到有背景的房间（新 uri 已写入隐藏槽），
        // 此时绝不能清槽——只有「当前意图仍是无背景」时才清。
        if (bgLastUriRef.current === '') {
          setBgLayer('A', '');
          setBgLayer('B', '');
        }
      });
      bgPendingFadeRef.current = null;
      return;
    }

    // 换图：写进「非顶层」槽。⚠️ 状态机死角修复：若目标槽**已经装着同一张图**
    //（A→B→A 来回切时必现），setState 同值不触发重渲染/onLoad → 交叉淡入永远不执行，
    // 背景停在旧房间的图（用户反馈「大小切换不过来」）—— 此时该图早已解码完成，直接交叉淡入。
    const targetSlot: 'A' | 'B' = bgTopIsARef.current ? 'B' : 'A';
    const targetUri = targetSlot === 'A' ? bgLayerARef.current : bgLayerBRef.current;
    if (targetUri === next) {
      bgPendingFadeRef.current = null;
      crossfadeTo(targetSlot);
      return;
    }
    setBgLayer(targetSlot, next);
    bgPendingFadeRef.current = targetSlot;
  }, [bgUri, bgOpacityA, bgOpacityB, crossfadeTo]);

  /** 槽位 onLoad：若它是待淡入槽 → 交叉淡入淡出 */
  const onBgSlotLoad = useCallback((slot: 'A' | 'B') => {
    if (bgPendingFadeRef.current === slot) {
      bgPendingFadeRef.current = null;
      crossfadeTo(slot);
    }
  }, [crossfadeTo]);

  /** 槽位加载失败：放弃本次待淡入（保留当前可见背景，不闪不黑） */
  const onBgSlotError = useCallback((slot: 'A' | 'B') => {
    if (bgPendingFadeRef.current === slot) bgPendingFadeRef.current = null;
  }, []);

  return { bgLayerA, bgLayerB, bgOpacityA, bgOpacityB, onBgSlotLoad, onBgSlotError };
}
