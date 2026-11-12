/**
 * 深色抽屉的公共头（用户 2026-11-12：「贡献榜 / 礼物 / 弹幕设置这几个界面的风格语言
 * 全部和弹幕列表统一」）。
 *
 * 版式数值直接沿用 DanmakuListSheet：拖拽 handle 区 22dp、手柄 40×4、
 * 标题行 paddingH 14 / paddingB 8、标题 13/700 白 0.94、关闭 ×18。
 * 颜色只走 danmakuSheetTokens 的黑白阶，不要在这里引入 palette.tint。
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { DANMAKU } from './danmakuSheetTokens';

/** 顶部拖拽手柄（横屏抽屉同样保留同高占位，标题行才对得齐） */
export function DarkSheetHandle({ show = true }: { show?: boolean }) {
  return (
    <View style={styles.handleArea}>
      {show ? <View style={styles.handle} /> : null}
    </View>
  );
}

export function DarkSheetHeader({ icon, title, meta, onClose }: {
  icon?: string;
  title: string;
  /** 右上角附加信息（条数 / 状态） */
  meta?: string;
  onClose: () => void;
}) {
  return (
    <View style={styles.headerRow}>
      {icon ? (
        <MaterialCommunityIcons name={icon} size={15} color="rgba(255,255,255,0.85)" />
      ) : null}
      <Text style={styles.title} numberOfLines={1}>{title}</Text>
      {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
      <TouchableOpacity
        onPress={onClose}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="close"
      >
        <MaterialCommunityIcons name="close" size={18} color="rgba(255,255,255,0.85)" />
      </TouchableOpacity>
    </View>
  );
}

/** 面板底板：与弹幕列表同一套（实心深黑 + 20 圆角） */
export const DARK_SHEET_BG = DANMAKU.bg;

const styles = StyleSheet.create({
  handleArea: { alignItems: 'center', justifyContent: 'center', height: 22 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: DANMAKU.handle },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  /** flex:1 必须留：否则没有 meta 时「×」会紧贴标题左侧，不是贴右（用户 2026-11-12 反馈） */
  title: { ...DANMAKU.title, flex: 1, minWidth: 0 },
  meta: { ...DANMAKU.meta, marginLeft: 8 },
});
