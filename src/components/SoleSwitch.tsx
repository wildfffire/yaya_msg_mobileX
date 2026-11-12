/**
 * 黑白描边开关（用户 2026-11-09 选的 A 方案）
 *
 * 为什么不用系统 Switch：在弹幕设置这种**实心黑底**面板上，系统 Switch 的
 * 「深色轨道 + 深色圆点」几乎看不见（用户原话：「黑色的在黑色背景底下看不清」）。
 *
 * 两态（只用黑白，不加彩色）：
 *   关 = 透明轨道 + 1.5px 白 0.30 描边 + 白 0.55 圆点
 *   开 = 白 0.90 实心轨道 + #121214 圆点
 *
 * 圆点位移用 native driver 的 translateX，颜色瞬时切换（避免颜色动画走 JS 线程）。
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';

interface Props {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  /** 无障碍标签（可选） */
  label?: string;
}

/** 细长胶囊（用户 2026-11-12：弹幕设置里的开关也要和胶囊一致的细长语言） */
const TRACK_W = 52;
const TRACK_H = 22;
const BORDER = 1.2;
const PAD = 2.5;
const THUMB = TRACK_H - PAD * 2;

export function SoleSwitch({ value, onValueChange, disabled, label }: Props) {
  const x = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    const animation = Animated.spring(x, {
      toValue: value ? 1 : 0,
      tension: 260,
      friction: 24,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [value, x]);

  /**
   * 位移区间必须按「内槽有效宽度」算：TRACK_W - 左右各 PAD - 圆点直径。
   * ⚠️ 圆点用 absolute + left:PAD，轨道描边画在**独立的一层**上 ——
   *    如果把 borderWidth 放在 Pressable 上，绝对定位会被内缩一个 border 宽度，
   *    圆点就会偏上偏左（用户 2026-11-09：「中间的圆不在正中」）。
   */
  const translateX = x.interpolate({
    inputRange: [0, 1],
    outputRange: [0, TRACK_W - PAD * 2 - THUMB],
  });

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      hitSlop={8}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={[styles.track, disabled ? { opacity: 0.45 } : null]}
    >
      {/* 轨道（背景 + 描边）：铺满、不参与圆点的定位盒 */}
      <View pointerEvents="none" style={[styles.trackLayer, value ? styles.trackOn : styles.trackOff]} />
      <Animated.View
        style={[
          styles.thumb,
          value ? styles.thumbOn : styles.thumbOff,
          { transform: [{ translateX }] },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { width: TRACK_W, height: TRACK_H },
  trackLayer: { ...StyleSheet.absoluteFillObject, borderRadius: TRACK_H / 2 },
  trackOff: { backgroundColor: 'transparent', borderWidth: BORDER, borderColor: 'rgba(255,255,255,0.30)' },
  trackOn: { backgroundColor: 'rgba(255,255,255,0.90)', borderWidth: BORDER, borderColor: 'rgba(255,255,255,0.90)' },
  thumb: {
    position: 'absolute',
    left: PAD,
    // 垂直居中：上下各留 (28-22)/2 = 3
    top: (TRACK_H - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
  },
  thumbOff: { backgroundColor: 'rgba(255,255,255,0.55)' },
  thumbOn: { backgroundColor: '#121214' },
});
