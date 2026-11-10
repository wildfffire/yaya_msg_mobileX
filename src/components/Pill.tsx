/**
 * Pill / Chip —— 玻璃胶囊
 *
 * 保留原 API（label / selected / onPress / accent / style），全站调用点无需改动。
 * 实现走 GlassSurface（chip 材质），旧 reactnatively Chip 已移除。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { GlassSurface } from './GlassSurface';
import { usePalette } from '../theme';
import { typography } from '../theme/typography';

export interface PillProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /** 强调填充（实心 tint 底 + 白字），默认 off（玻璃底 + 描边） */
  accent?: boolean;
  style?: StyleProp<ViewStyle>;
  /**
   * 撑满父容器宽度（等宽分栏场景，如鸡腿榜的「周榜 / 成员贡献」两个并排胶囊）。
   *
   * 为什么需要它：玻璃态 Pill 的宽度由**内容**决定 —— 外层 Pressable 被拉宽时，
   * 里面的 GlassSurface 不会跟着变宽；而实心态（selected/accent）用的是 Pressable 自身背景，
   * 会被 `alignSelf: stretch` 拉满。于是并排使用时一个宽一个窄、对不齐。
   * 传 true 让玻璃层同步拉伸，两种形态宽度一致（默认不传 = 全站既有行为不变）。
   */
  fill?: boolean;
}

export function Pill({ label, selected, onPress, accent, style, fill }: PillProps) {
  const palette = usePalette();
  const solid = accent || selected;

  const content = (
    <Text
      numberOfLines={1}
      style={[
        typography.footnote,
        { fontWeight: '600' },
        { color: solid ? '#fff' : palette.label },
      ]}
    >
      {label}
    </Text>
  );

  // 实心强调态不做玻璃（玻璃底下压一层实心色既看不出玻璃，也浪费一次 backdrop 采样）
  if (solid) {
    return (
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        style={[styles.box, fill ? styles.fill : null, { backgroundColor: palette.tint }, style]}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <Pressable onPress={onPress} disabled={!onPress} style={[fill ? styles.fill : null, style]}>
      <GlassSurface
        role="chip"
        radius={999}
        style={[styles.box, fill ? styles.glassFill : null]}
        interactive={!!onPress}
      >
        {content}
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
  },
  /** 横向撑满父容器（交叉轴拉伸） */
  fill: { alignSelf: 'stretch' },
  /** 玻璃层同样撑满 Pressable（宽度写死 100%，不依赖父级 alignItems） */
  glassFill: { alignSelf: 'stretch', width: '100%' },
});
