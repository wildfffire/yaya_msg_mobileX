/**
 * 弹幕设置面板（哔哩哔哩风格）：总开关、显示区域、速度、字号、不透明度、重置。
 * 设置来自 useDanmakuSettings，记忆持久化。
 *
 * 用户 2026-11-09：「弹幕设置这一页的字体、颜色之类的风格和弹幕列表统一一下，都做成这种黑白的」
 * → 全部取值收敛到 ./danmakuSheetTokens（与 DanmakuListSheet 共用同一套黑白阶），
 *   不再用 palette.tint 做选中色（深底上会发灰，且 Modal 里会透出房间背景）。
 */
import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useDanmakuSettings, DanmakuArea } from '../store/danmakuSettings';
import { useI18n } from '../i18n';
import { useIsLandscape } from '../hooks/useIsLandscape';
import { useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import { DANMAKU } from './danmakuSheetTokens';
import { DarkSheetHeader } from './DarkSheetHeader';
import { SoleSwitch } from './SoleSwitch';

interface Props {
  visible: boolean;
  onClose: () => void;
}

const AREAS: { key: DanmakuArea; label: string }[] = [
  { key: 'top', label: '顶部' },
  { key: 'half', label: '半屏' },
  { key: 'full', label: '全屏' },
];
const SPEEDS: { v: number; label: string }[] = [
  { v: 0.5, label: '0.5x' },
  { v: 1, label: '1x' },
  { v: 1.5, label: '1.5x' },
  { v: 2, label: '2x' },
];
const SIZES: { v: number; label: string }[] = [
  { v: 13, label: '小' },
  { v: 16, label: '中' },
  { v: 20, label: '大' },
];
const OPACITIES: { v: number; label: string }[] = [
  { v: 0.4, label: '低' },
  { v: 0.7, label: '中' },
  { v: 1, label: '高' },
];

export default function DanmakuSettingsSheet({ visible, onClose }: Props) {
  const { t } = useI18n();
  const { enabled, area, speed, fontSize, opacity, giftEffect, avoidOverlap, set, reset } = useDanmakuSettings();
  const { width: winW } = useWindowDimensions();
  const isLandscape = useIsLandscape();
  const insets = useSafeAreaInsets();
  /** 横屏：底部抽屉会把画面压没 → 改右侧抽屉（宽 40% 窗口，260~400 夹紧，只圆左侧两角） */
  const drawerW = Math.round(Math.min(400, Math.max(260, winW * 0.4)));

  /** 选项行 = 实心黑白胶囊（选中白底黑字，未选白 0.1 底白字） */
  const chipRow = (items: { key?: string; label: string; active: boolean; onPress: () => void }[]) => (
    <View style={styles.chipWrap}>
      {items.map((item) => (
        <TouchableOpacity
          key={item.key || item.label}
          activeOpacity={0.85}
          onPress={item.onPress}
          style={[styles.chip, { backgroundColor: item.active ? DANMAKU.chipOnBg : DANMAKU.chipBg }]}
        >
          <Text style={[DANMAKU.chipText, { color: item.active ? DANMAKU.chipOnFg : DANMAKU.chipFg }]}>
            {item.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  /**
   * 开关行（字体/配色与面板其余部分统一）。
   * 用户 2026-11-09：「黑色的在黑色背景底下看不清」→ 换成黑白描边开关（SoleSwitch）。
   */
  const switchRow = (label: string, value: boolean, onChange: (v: boolean) => void) => (
    <View style={styles.row}>
      <Text style={DANMAKU.text}>{label}</Text>
      <SoleSwitch value={value} onValueChange={onChange} label={label} />
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={[styles.mask, isLandscape && styles.maskLandscape]} activeOpacity={1} onPress={onClose}>
        {/* 实心深黑底（用户 2026-11-09：玻璃会把房间背景透出来） */}
        <View
          style={[
            styles.sheet,
            isLandscape && { width: drawerW, maxHeight: '100%', height: '100%', paddingTop: insets.top },
            {
              backgroundColor: DANMAKU.bg,
              borderTopLeftRadius: DANMAKU.radius,
              borderTopRightRadius: isLandscape ? 0 : DANMAKU.radius,
              borderBottomLeftRadius: isLandscape ? DANMAKU.radius : 0,
            },
          ]}
          onStartShouldSetResponder={() => true}
        >
          {/* 头与弹幕列表/贡献榜/礼物共用同一个组件；设置面板不要顶部小条（用户 2026-11-12） */}
          <View style={styles.headerTop} />
          <DarkSheetHeader icon="cog-outline" title={t('弹幕设置')} onClose={onClose} />

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
            {switchRow(t('显示弹幕'), enabled, (v) => set({ enabled: v }))}
            {/* 礼物特效独立于弹幕总开关：关掉弹幕仍可看礼物卡片 */}
            {switchRow(t('礼物特效'), giftEffect, (v) => set({ giftEffect: v }))}
            {switchRow(t('防重叠'), avoidOverlap, (v) => set({ avoidOverlap: v }))}

            <View style={[styles.divider, { backgroundColor: DANMAKU.hairline }]} />

            <Text style={[DANMAKU.group, styles.groupLabel]}>{t('显示区域')}</Text>
            {chipRow(AREAS.map((a) => ({ key: a.key, label: t(a.label), active: area === a.key, onPress: () => set({ area: a.key }) })))}

            <Text style={[DANMAKU.group, styles.groupLabel]}>{t('滚动速度')}</Text>
            {chipRow(SPEEDS.map((s) => ({ key: s.label, label: t(s.label), active: speed === s.v, onPress: () => set({ speed: s.v }) })))}

            <Text style={[DANMAKU.group, styles.groupLabel]}>{t('字号')}</Text>
            {chipRow(SIZES.map((s) => ({ key: s.label, label: t(s.label), active: fontSize === s.v, onPress: () => set({ fontSize: s.v }) })))}

            <Text style={[DANMAKU.group, styles.groupLabel]}>{t('不透明度')}</Text>
            {chipRow(OPACITIES.map((o) => ({ key: o.label, label: t(o.label), active: opacity === o.v, onPress: () => set({ opacity: o.v }) })))}

            {/* 恢复默认：白字文本按钮（不用主题色 Button，保持黑白） */}
            <View style={styles.resetWrap}>
              <TouchableOpacity
                onPress={() => reset()}
                activeOpacity={0.7}
                style={[styles.resetBtn, { borderColor: DANMAKU.hairline }]}
              >
                <MaterialCommunityIcons name="restore" size={14} color="rgba(255,255,255,0.75)" />
                <Text style={[styles.resetText, { color: 'rgba(255,255,255,0.75)' }]}>{t('恢复默认')}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: { flex: 1, backgroundColor: DANMAKU.scrim, justifyContent: 'flex-end' },
  /** 横屏：右侧抽屉 —— 底板横排、面板贴右 */
  maskLandscape: { flexDirection: 'row', justifyContent: 'flex-end' },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  /** 细长胶囊（用户 2026-11-12：横向拉长、纵向压薄） */
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 4,
    borderRadius: 999,
    minWidth: 56,
    alignItems: 'center',
  },
  /** 无 handle 时给标题行留一点上边距 */
  headerTop: { height: 10 },
  sheet: { maxHeight: '82%', paddingBottom: 18 },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 4 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  body: { paddingHorizontal: 14 },
  /** 开关行压薄，与细长胶囊同一节奏 */
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 5, minHeight: 34 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
  groupLabel: { marginTop: 10, marginBottom: 6 },
  resetWrap: { marginTop: 18, marginBottom: 6, alignItems: 'center' },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resetText: { fontSize: 12, fontWeight: '700' },
});
