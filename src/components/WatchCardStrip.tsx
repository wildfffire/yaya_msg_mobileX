/**
 * 「我的」页横滑卡条：稍后再看 / 观看历史。
 * 视觉与首页「公演直播」横滑卡同款（贴边横滑 + 封面 + 类型胶囊 + 标题 + 时间），
 * 由设置里的两个开关决定是否渲染；不改动任何 store，只读传入的条目。
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { NetworkImage } from './NetworkImage';
import { ScalePressable } from './Motion';
import { useI18n } from '../i18n';
import { usePalette } from '../theme';
import type { PlayMedia } from '../player/session';

export interface WatchStripItem {
  key: string;
  title: string;
  cover?: string;
  /** 类型标签：视频 / 电台 / 回放 / 公演回放 */
  label: string;
  /** 时间 / 观看次数等次要信息 */
  meta?: string;
  /** 点卡片直接起播：与观看历史/稍后再看列表页同一套 PlayMedia 口径 */
  media: PlayMedia | null;
}

interface Props {
  title: string;
  count: number;
  items: WatchStripItem[];
  emptyText: string;
  onPressAll: () => void;
  onPressItem: (item: WatchStripItem) => void;
}

export default function WatchCardStrip({ title, count, items, emptyText, onPressAll, onPressItem }: Props) {
  const { t } = useI18n();
  const palette = usePalette();
  return (
    <View style={styles.wrap}>
      {/* 标题行整行可点进「全部」；按用户要求标题前不再放图标 */}
      <ScalePressable onPress={onPressAll} pressedScale={0.985} activeOpacity={0.9}>
        <View style={styles.head}>
          <Text style={[styles.headTitle, { color: palette.label }]}>{title}</Text>
          <Text style={[styles.headCount, { color: palette.labelTertiary }]}>{count}</Text>
          <View style={styles.allRow}>
            <Text style={[styles.allText, { color: palette.tint }]}>{t('全部')}</Text>
            <MaterialCommunityIcons name="chevron-right" size={14} color={palette.tint} />
          </View>
        </View>
      </ScalePressable>
      {items.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.row}
          contentContainerStyle={styles.rowContent}
        >
          {items.map((item) => (
            <ScalePressable
              key={item.key}
              onPress={() => onPressItem(item)}
              pressedScale={0.97}
              activeOpacity={0.88}
              style={[styles.card, { backgroundColor: palette.fill3, borderColor: palette.hairline }]}
            >
              <View style={styles.coverWrap}>
                {item.cover ? (
                  <NetworkImage source={{ uri: item.cover }} style={styles.cover} resizeMode="cover" thumbnail={240} />
                ) : (
                  <View style={[styles.cover, styles.coverFallback, { backgroundColor: palette.tintSoft }]}>
                    <MaterialCommunityIcons name="play-box-outline" size={24} color={palette.tint} />
                  </View>
                )}
                <View style={[styles.typeBadge, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                  <Text style={styles.typeBadgeText}>{item.label}</Text>
                </View>
              </View>
              <Text style={[styles.cardTitle, { color: palette.label }]} numberOfLines={2}>{item.title}</Text>
              {item.meta ? (
                <Text style={[styles.cardMeta, { color: palette.labelTertiary }]} numberOfLines={1}>{item.meta}</Text>
              ) : null}
            </ScalePressable>
          ))}
        </ScrollView>
      ) : (
        <View style={[styles.empty, { backgroundColor: palette.fill3, borderColor: palette.hairline }]}>
          <MaterialCommunityIcons name="inbox-outline" size={20} color={palette.labelTertiary} />
          <Text style={[styles.emptyText, { color: palette.labelSecondary }]}>{emptyText}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 20 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, marginBottom: 10 },
  headTitle: { fontSize: 14, fontWeight: '800' },
  headCount: { fontSize: 11, fontWeight: '700', marginRight: 'auto' },
  allRow: { flexDirection: 'row', alignItems: 'center' },
  allText: { fontSize: 12, fontWeight: '700' },
  // 负 margin 贴边横滑：与首页公演直播同一手法，首卡由 paddingLeft 让出安全边距
  row: { marginHorizontal: -16 },
  rowContent: { gap: 10, paddingLeft: 16, paddingRight: 16, paddingVertical: 2 },
  card: { width: 150, padding: 8, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  coverWrap: { borderRadius: 12, overflow: 'hidden' },
  cover: { width: '100%', height: 88 },
  coverFallback: { alignItems: 'center', justifyContent: 'center' },
  typeBadge: { position: 'absolute', left: 6, top: 6, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  typeBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
  cardTitle: { fontSize: 12, fontWeight: '700', lineHeight: 17, marginTop: 8, minHeight: 34 },
  cardMeta: { fontSize: 10, marginTop: 3 },
  empty: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 14, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
  },
  emptyText: { fontSize: 12, flexShrink: 1 },
});
