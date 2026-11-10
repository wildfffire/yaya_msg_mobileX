/**
 * 直播间礼物特效层。
 *
 * 收到「送礼公屏」消息（云信 PRESENT_NORMAL，codec 归一化成 kind === 'gift'）时，
 * 在画面右下角依次播放一张礼物卡片（礼物图 + 名称×数量 + 送礼文案），
 * 与弹幕飘屏互不干扰。
 *
 * 为什么单独做一层而不是塞进飘屏：
 *   ① 礼物是「事件」不是「文字」，需要停留展示（2.6s），飘屏会直接飞过去；
 *   ② 需要礼物图（gift.picPath），飘屏是纯文本；
 *   ③ 用户要求可关（弹幕设置里的「礼物特效」开关）—— 关掉时不能把期间积压的礼物
 *      在下次打开时补播一遍（见下方 seen 记账）。
 *
 * 数据源与弹幕列表同一条连接（useLiveBarrage.items），不额外建连。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { NetworkImage } from './NetworkImage';
import { normalizeUrl } from '../utils/data';
import type { BarrageItem } from '../services/pocketNim/types';

/** 单条礼物的停留时长（ms） */
const HOLD_MS = 2600;
/** 队列上限：连击/刷礼物时只保留最近的若干条，避免越积越多、落后现场太久 */
const MAX_QUEUE = 12;
/** 去重表上限（挂机很久时重置，避免集合无限增长） */
const MAX_SEEN = 500;

export interface GiftEffectOverlayProps {
  /** 弹幕流（与弹幕列表同一份数据；内部只挑 kind === 'gift' 且带 gift 的条目） */
  items: BarrageItem[];
  /** 开关（弹幕设置 → 礼物特效）。关闭时不再播放，但期间到达的礼物仍会被记账 */
  enabled: boolean;
}

export function GiftEffectOverlay({ items, enabled }: GiftEffectOverlayProps) {
  const [current, setCurrent] = useState<BarrageItem | null>(null);
  const queueRef = useRef<BarrageItem[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const playingRef = useRef(false);
  const anim = useRef(new Animated.Value(0)).current;

  /**
   * 卸载守卫（用户 2026-09-30：「直播退出所有界面都出现卡顿」的普查要求）：
   * 以前动画链 `start(() => playNext())` 在卸载后仍会回调 → setCurrent/继续排队，
   * 退出直播间后还在空转。现在卸载即停动画并终止链路。
   */
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
    try { anim.stopAnimation(); } catch { /* 忽略 */ }
    queueRef.current = [];
    playingRef.current = false;
  }, [anim]);

  const playNext = useCallback(() => {
    if (!mountedRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      playingRef.current = false;
      setCurrent(null);
      return;
    }
    playingRef.current = true;
    setCurrent(next);
    anim.setValue(0);
    Animated.sequence([
      Animated.timing(anim, { toValue: 1, duration: 240, useNativeDriver: true }),
      Animated.delay(HOLD_MS),
      Animated.timing(anim, { toValue: 0, duration: 320, useNativeDriver: true }),
    ]).start(() => { if (mountedRef.current) playNext(); });
  }, [anim]);

  useEffect(() => {
    if (!items.length) return;
    const fresh = items.filter((item) => item.kind === 'gift' && !seenRef.current.has(item.id));
    if (!fresh.length) return;
    // ⚠️ 无论开关是否打开都要先记账：否则「关闭期间攒下的礼物」会在下次打开时
    // 一次性补播（用户会以为关不掉）。
    fresh.forEach((item) => seenRef.current.add(item.id));
    if (seenRef.current.size > MAX_SEEN) seenRef.current = new Set(items.map((i) => i.id));
    if (!enabled) return;
    // items 是「最新在前」→ 倒序入队，保证按时间先后播放
    queueRef.current = [...fresh.slice().reverse(), ...queueRef.current].slice(0, MAX_QUEUE);
    if (!playingRef.current) playNext();
  }, [items, enabled, playNext]);

  // 关掉开关：立刻清空队列并收掉当前这张（不是等它播完）
  useEffect(() => {
    if (enabled) return;
    queueRef.current = [];
    playingRef.current = false;
    setCurrent(null);
  }, [enabled]);

  if (!enabled || !current) return null;

  const gift = current.gift;
  const image = normalizeUrl(gift?.picPath || '');
  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [36, 0] });
  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] });

  return (
    <View pointerEvents="none" style={styles.wrap}>
      <Animated.View
        style={[styles.card, { opacity: anim, transform: [{ translateX }, { scale }] }]}
      >
        {image ? (
          <NetworkImage source={{ uri: image }} style={styles.img} resizeMode="contain" thumbnail={200} />
        ) : (
          <View style={styles.imgFallback}>
            <MaterialCommunityIcons name="gift" size={22} color="#FFFFFF" />
          </View>
        )}
        <View style={styles.textWrap}>
          <Text style={styles.title} numberOfLines={1}>
            {gift?.giftName || ''}
            {gift?.giftNum ? ` x${gift.giftNum}` : ''}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>{current.text}</Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  /* zIndex 30 = 与飘屏同层（挂载更晚 → 在飘屏之上），仍在播放器控制层（31）之下：
     特效不挡按钮，且 pointerEvents none，全程不吃触摸 */
  wrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    paddingRight: 12,
    // 避开播放器底坞（弹幕输入条约高 92~104）
    paddingBottom: 104,
    zIndex: 30,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.24)',
    maxWidth: '78%',
  },
  img: { width: 40, height: 40 },
  imgFallback: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,111,145,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrap: { flexShrink: 1 },
  title: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  sub: { color: 'rgba(255,255,255,0.82)', fontSize: 11, marginTop: 1 },
});

export default GiftEffectOverlay;
