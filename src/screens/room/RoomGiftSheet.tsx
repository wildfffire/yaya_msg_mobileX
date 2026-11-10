/**
 * 房间送礼面板（图片化宫格 + 余额/充值 + 数量与合计）。
 *
 * 为什么单独抽成组件：
 *   ① 面板原来只挂在「房间内播放器」分支里 —— 没起播就点不到。现在工具栏也有入口，
 *      面板必须渲染在播放器之外（同一条 visible 状态），抽出来才能在两处共用一个实例；
 *   ② 借鉴上游 v2.7.6「全新礼物面板：礼物图片化展示」+ v2.7.7 的面板交互修复：
 *      遮罩点击关闭用**独立兄弟节点**（不包面板，否则会抢走面板内滚动手势 → 一滑就关）、
 *      加载态给骨架格（点开不再一片空白）、列表为空给空态。
 */
import React from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { GlassSurface } from '../../components/GlassSurface';
import { NetworkImage } from '../../components/NetworkImage';
import { ScalePressable } from '../../components/Motion';
import { useI18n } from '../../i18n';
import { usePalette } from '../../theme';
import { giftImage, giftName } from '../../utils/gift';
// 礼物价格快照（用户 2026-11-09）：接口没给单价时用快照价，并可按 scorePerUnit 折算贡献
import { useGiftPriceStore } from '../../services/giftPrices';
import { giftChickenTotal, giftContribution, resolveGiftChicken } from '../../utils/giftPrice';
import { styles } from './roomStyles';

export function RoomGiftSheet({
  visible,
  onClose,
  loading,
  gifts,
  balance,
  status,
  selected,
  num,
  onChangeNum,
  onSelect,
  onSend,
  onRecharge,
  landscape,
}: {
  visible: boolean;
  onClose: () => void;
  loading: boolean;
  gifts: any[];
  balance: string;
  status: string;
  selected: any;
  num: number;
  onChangeNum: (next: number) => void;
  onSelect: (gift: any) => void;
  onSend: () => void;
  onRecharge: () => void;
  landscape?: boolean;
}) {
  const { t } = useI18n();
  const palette = usePalette();
  /** 价格快照：接口没给单价时兜底（见 utils/giftPrice 的说明） */
  const giftPrices = useGiftPriceStore((s) => s.snapshot);
  React.useEffect(() => { void useGiftPriceStore.getState().load(); }, []);
  const chicken = selected ? giftChickenTotal(selected, num, giftPrices) : null;
  const total = chicken ? chicken.total : 0;
  /** 贡献值：scorePerUnit 未知时为 null（UI 显示「待核价」而不是猜 1:1） */
  const contribution = selected ? giftContribution(selected, num, giftPrices) : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.roomModalShade}>
        {/* 点遮罩关闭：独立兄弟节点、排在面板之前（包住面板会与内部 ScrollView 抢手势） */}
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <GlassSurface radius={22} role="card" style={[styles.roomRankPanel, landscape ? styles.roomRankPanelLandscape : null, { backgroundColor: 'transparent' }]}>
          <View style={styles.roomRankHandleWrap}>
            <View style={[styles.roomRankHandle, { backgroundColor: palette.fill3 }]} />
          </View>
          <View style={styles.roomRankHeader}>
            <Text style={[styles.roomRankTitle, { color: palette.label }]}>{t('直播送礼')}</Text>
            <ScalePressable onPress={onClose} pressedScale={0.92} activeOpacity={0.8} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <View style={[styles.roomRankClose, { backgroundColor: palette.fill2 }]}>
                <MaterialCommunityIcons name="close" color={palette.labelSecondary} size={18} />
              </View>
            </ScalePressable>
          </View>
          <Text style={[styles.roomRankStatus, { color: palette.danger }]}>{t('直播送礼主播看不到赠送，仅能统计贡献值')}</Text>
          {/* 余额 + 充值入口（余额不足时不用退出房间去找充值页） */}
          <View style={styles.roomGiftBalanceRow}>
            <Text style={[styles.roomRankStatus, { color: palette.labelSecondary, marginBottom: 0 }]}>
              {balance ? t('余额：{balance} 鸡腿', { balance }) : t('余额未知')}
            </Text>
            <TouchableOpacity onPress={onRecharge} activeOpacity={0.8} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Text style={[styles.roomRankStatus, { color: palette.tint, marginBottom: 0, fontWeight: '800' }]}>{t('充值鸡腿')}</Text>
            </TouchableOpacity>
          </View>
          {status ? <Text style={[styles.roomRankStatus, { color: palette.labelSecondary }]}>{status}</Text> : null}
          <ScrollView style={[styles.roomRankList, landscape ? styles.roomRankListLandscape : null]} showsVerticalScrollIndicator={false}>
            {loading && !gifts.length ? (
              <View style={styles.roomGiftGrid}>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <View key={`gift-skeleton-${i}`} style={[styles.roomGiftCell, { backgroundColor: palette.fill2, borderColor: palette.hairline }]}>
                    <View style={[styles.roomGiftCellImg, styles.skeletonBox, { backgroundColor: palette.fill3 }]} />
                    <View style={[styles.skeletonLine, { backgroundColor: palette.fill3 }]} />
                    <View style={[styles.skeletonLineShort, { backgroundColor: palette.fill3 }]} />
                  </View>
                ))}
              </View>
            ) : !gifts.length ? (
              <View style={styles.roomGiftLoadingCenter}>
                {loading ? <ActivityIndicator size="small" color={palette.tint} /> : null}
                <Text style={[styles.roomRankEmpty, { color: palette.labelTertiary }]}>{t('暂无礼物')}</Text>
              </View>
            ) : (
              <View style={styles.roomGiftGrid}>
                {gifts.map((gift, index) => {
                  const gid = String(gift.giftId || gift.id || `gift-${index}`);
                  const active = !!selected && String(selected.giftId || selected.id || '') === gid;
                  const pic = giftImage(gift);
                  const cost = resolveGiftChicken(gift, giftPrices).unit;
                  return (
                    <TouchableOpacity
                      key={gid}
                      style={[
                        styles.roomGiftCell,
                        { backgroundColor: active ? palette.tintSoft : palette.fill2, borderColor: active ? palette.tint : palette.hairline },
                      ]}
                      onPress={() => onSelect(gift)}
                      activeOpacity={0.85}
                    >
                      {pic ? (
                        <NetworkImage source={{ uri: pic }} style={styles.roomGiftCellImg} resizeMode="contain" thumbnail={180} />
                      ) : (
                        <View style={[styles.roomGiftCellImg, styles.roomGiftCellImgFallback, { backgroundColor: palette.fill3 }]}>
                          <MaterialCommunityIcons name="gift" size={22} color={palette.labelTertiary} />
                        </View>
                      )}
                      <Text style={[styles.roomGiftCellName, { color: palette.label }]} numberOfLines={1}>{giftName(gift)}</Text>
                      <Text style={[styles.roomGiftCellCost, { color: palette.tint }]} numberOfLines={1}>
                        {cost > 0 ? t('{count} 鸡腿', { count: cost }) : t('免费')}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </ScrollView>
          <View style={styles.roomGiftFooter}>
            <View style={styles.roomGiftStepper}>
              <ScalePressable style={[styles.liveResolveBtnGhost, { paddingHorizontal: 12, paddingVertical: 6 }]} pressedScale={0.92} activeOpacity={0.8} onPress={() => onChangeNum(Math.max(1, num - 1))}>
                <Text style={[styles.liveResolveBtnGhostText, { color: palette.tint }]}>−</Text>
              </ScalePressable>
              <Text style={[styles.roomRankTitle, { color: palette.label }]}>{num}</Text>
              <ScalePressable style={[styles.liveResolveBtnGhost, { paddingHorizontal: 12, paddingVertical: 6 }]} pressedScale={0.92} activeOpacity={0.8} onPress={() => onChangeNum(Math.min(999, num + 1))}>
                <Text style={[styles.liveResolveBtnGhostText, { color: palette.tint }]}>＋</Text>
              </ScalePressable>
            </View>
            <ScalePressable
              style={[styles.liveResolveBtn, { backgroundColor: '#ff6f91', paddingHorizontal: 18, paddingVertical: 8, opacity: selected ? 1 : 0.7 }]}
              pressedScale={0.95}
              activeOpacity={0.85}
              onPress={onSend}
            >
              <Text style={styles.liveResolveBtnText}>
                {selected
                  ? `${t('送出礼物')} · ${total > 0 ? t('{count} 鸡腿', { count: total }) : t('免费')}${
                    contribution != null ? ` · ${t('贡献 {n}', { n: contribution })}` : ''
                  }`
                  : t('选择礼物')}
              </Text>
            </ScalePressable>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}
