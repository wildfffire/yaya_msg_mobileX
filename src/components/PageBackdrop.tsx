/**
 * PageBackdrop · 全局页面底衬
 *
 * 用户 2026-11-09：「整个软件都要扁平化」——原先的 48 段彩色条带（粉/紫/蓝三层色斑 +
 * rotate(-20deg)）是液态玻璃的「透光来源」，玻璃去掉后它只剩「彩色底衬」这一个副作用，
 * 于是整页统一成**单一纯色**（浅色 #ECEDF1 / 深色 #0B0B0F，纯黑主题 #000000）。
 *
 * 自定义背景图模式不走这里（navigation/index.tsx 渲染 ImageBackground），
 * 那条链路的遮罩 / 模糊设置保持不变。
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { usePalette } from '../theme';

export function PageBackdrop() {
  const palette = usePalette();
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: palette.background }]}
    />
  );
}
