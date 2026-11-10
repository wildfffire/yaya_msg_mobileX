import React, { useCallback } from 'react';
import { Platform, StatusBar, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useI18n } from '../i18n';
import { screenTitle, usePalette } from '../theme';
import { useUiStore } from '../store';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { ScalePressable } from './Motion';
import { GlassSurface } from './GlassSurface';

/** 收起后保留的高度：0 = 顶栏彻底消失（改成固定值可留一条状态栏留白） */
const COLLAPSE_TO = 0;

interface Props {
  title: string;
  onBack?: () => void;
  right?: React.ReactNode;
  style?: ViewStyle;
  /** 图片背景页（如直播间）传 true：返回键用玻璃胶囊，标题加轻阴影保证可读 */
  overlay?: boolean;
  /** tab 根页传 true：不渲染返回键，但保留左槽位，标题位置与二级页完全一致 */
  hideBack?: boolean;
}

/**
 * 新式大标题页头（iOS 26 风格，主题化）
 *  - 左对齐大标题 + 玻璃圆形返回键，去霓虹发光
 *  - 三栏布局保留：左(返回) | 中(标题占满) | 右(操作位)
 *  - 兼容旧 props（title/onBack/right/style），全站调用点无需改动
 */
export default function ScreenHeader({ title, onBack, right, style, overlay, hideBack }: Props) {
  const navigation = useNavigation();
  const { t } = useI18n();
  const palette = usePalette();
  const goBack = useCallback(onBack || (() => navigation.goBack()), [onBack, navigation]);
  const topPad = Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight || 24) + 10;

  /**
   * 滚动收起（用户要求：主页面向上滚动时顶栏与底栏一起收起，向下滚回再出现）。
   * 状态由 navigation/chromeScroll.ts 写入，这里只负责「表现」。
   *
   * ⚠️ 这里踩过一个真机 bug（2026-09-28 用户反馈：一级页面顶栏收起后**再也不出现**）。
   *    原实现用 Reanimated 的 useAnimatedStyle 同时动画 height + opacity，并且在
   *    「还没量到高度」时返回 `height: undefined`。根因是 —— **布局属性 height 一旦
   *    以 undefined 参与过 worklet，Reanimated 就不再把它当作受控属性，后续数值不会
   *    写回原生视图**，于是高度永远停在上一次的值（0）。同时底栏只动 transform/opacity
   *    却一切正常，正好佐证问题出在布局属性上。
   *
   *    现在的纪律：**布局属性只由状态真值直接决定，绝不交给动画**。
   *      · 展开态：完全不写 height → 交回自然布局，不可能有残留；
   *      · 收起态：直接给 0 —— 不需要测量高度，也不依赖任何动画状态。
   *    代价是收起/展开没有补间动画（与底栏在「导航驱动隐藏」时的表现一致）。
   *    若以后要柔和过渡，另做一版真机验证过的方案，不再把布局压进 worklet。
   *
   * `overlay`（浮在直播/房间背景图上、不在文档流里）不参与收起：收掉只会露出硬边。
   */
  const chromeHiddenByScroll = useUiStore((s) => s.chromeHiddenByScroll);
  const collapsed = chromeHiddenByScroll && !overlay;

  return (
    <View style={[styles.header, { paddingTop: topPad }, style, collapsed && styles.collapsed]}>
      {!hideBack ? (
        <ScalePressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel={t('返回')}
          pressedScale={0.9}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <GlassSurface role="chip" radius={999} style={styles.backBtn}>
            <MaterialCommunityIcons name="chevron-left" color={palette.label} size={26} />
          </GlassSurface>
        </ScalePressable>
      ) : null}
      <Text
        numberOfLines={1}
        style={[styles.title, { color: palette.label }]}
      >
        {title}
      </Text>
      <View style={styles.sideRight}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * 收起态：高度归零 + 淡出（溢出内容被裁掉）。
   * ⚠️ 只有这两个属性，且由 `collapsed` 直接决定 —— 见组件内注释：
   *    布局属性一律不进 worklet，否则会出现「收起后回不来」。
   */
  collapsed: { height: COLLAPSE_TO, opacity: 0, overflow: 'hidden', marginBottom: 0 },
  header: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 12,
    marginBottom: 2,
    gap: 8,
  },
  sideRight: { minWidth: 56, alignItems: 'flex-end', justifyContent: 'center' },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    // 不要 borderWidth：RN 里 borderWidth 不给 borderColor 会画默认黑边，
    // 而描边本来就由 GlassSurface 的材质描边负责（白 0.66），叠黑边会显脏。
  },
  /**
   * 页面大标题 = iOS 26 大标题（用户 2026-11-09 选定）。
   * 已去掉 textShadow（用户同批要求「把阴影去掉」）—— 浮在背景图上的页面
   * 靠标题自身的深色字 + 页面遮罩保证可读，不再用投影补可读性。
   */
  title: {
    flex: 1,
    minWidth: 0,
    textAlign: 'left',
    ...screenTitle,
  },
});
