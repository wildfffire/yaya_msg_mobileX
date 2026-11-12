/**
 * 账号中心响应式骨架（2026-11-11 重构）。
 *
 *  wide：左栏 300dp「Hero + 分区导航」独立滚动 + 右栏当前分区独立滚动，右栏限宽 760 居中。
 *  narrow：单一 ScrollView，Hero 在前、各分区按顺序堆叠（不再需要导航）。
 *
 * 判据放在 AccountScreen：`width >= 840 && height >= 480`
 * —— 平板竖屏（1200×1600）也算宽屏，手机横屏（844×390）不会硬上双栏。
 */
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { usePalette } from '../../theme';
import { accountStyles as s } from './accountStyles';

export default function AccountLayout({ wide, hero, nav, children }: {
  wide: boolean;
  hero: React.ReactNode;
  nav?: React.ReactNode;
  children: React.ReactNode;
}) {
  const palette = usePalette();

  if (wide) {
    return (
      <View style={s.wideRow}>
        <View style={[s.rail, { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: palette.hairline }]}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={s.railContent}
            keyboardShouldPersistTaps="handled"
          >
            {hero}
            {nav}
          </ScrollView>
        </View>
        <ScrollView
          key="account-wide"
          style={s.container}
          contentContainerStyle={s.paneContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {children}
        </ScrollView>
      </View>
    );
  }

  return (
    <ScrollView
      key="account-narrow"
      style={s.container}
      contentContainerStyle={s.content}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {hero}
      {children}
    </ScrollView>
  );
}
