/**
 * 直播间送礼面板（直播页 / 房间内直播共用**直播页那版**）。
 *
 * 用户 2026-11-13：面板统一时以**直播页版本**为准（房间以前那份是另一套交互，
 * 价格快照/步进器都跟直播页不一致）。所以这里逐字沿用直播页原实现：
 *   · 黑白实心抽屉 rgba(18,18,20,0.97)，横屏贴右 width 420（与弹幕列表/贡献榜同一套）；
 *   · 头部右侧显示余额；宫格是礼物图片 + 名称 + 单份鸡腿价；
 *   · 底部「数量输入框 + 送出 · 合计」+「余额不足？去充值鸡腿」。
 * 房间侧不要再写第二份（以前就是两份，修一处另一处不生效）。
 */
import React from 'react';
import {
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { DarkSheetHandle, DarkSheetHeader } from './DarkSheetHeader';
import { useI18n } from '../i18n';
import { useIsLandscape } from '../hooks/useIsLandscape';
import { giftCost, giftImage, giftName } from '../utils/gift';

export interface LiveGiftSheetProps {
  visible: boolean;
  onClose: () => void;
  gifts: any[];
  balance: string;
  status: string;
  selected: any;
  /** 数量（输入框原样字符串，发送时由调用方取整） */
  num: string;
  onChangeNum: (text: string) => void;
  onSelect: (gift: any) => void;
  onSend: () => void;
  /** 去充值（点击后关闭面板并跳充值页，由调用方决定导航） */
  onRecharge: () => void;
}

export function LiveGiftSheet({
  visible,
  onClose,
  gifts,
  balance,
  status,
  selected,
  num,
  onChangeNum,
  onSelect,
  onSend,
  onRecharge,
}: LiveGiftSheetProps) {
  const { t } = useI18n();
  const isLandscape = useIsLandscape();
  const total = selected ? giftCost(selected) * (Number(num) || 1) : 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* 黑白实心抽屉：与贡献榜同一套深色面板，横屏贴右侧并吃满高度 */}
      <View style={[styles.shade, isLandscape ? styles.shadeLandscape : null]}>
        {/* 点左侧画面（竖屏则是面板上方的空白）关闭：
            独立兄弟节点、排在面板之前 —— 包住面板会与内部 ScrollView 抢手势（一滑就关）。 */}
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.panel, isLandscape ? styles.panelLandscape : null]}>
          {/* 与弹幕列表同一套头：handle + 图标标题 + 关闭 × */}
          <DarkSheetHandle show={!isLandscape} />
          <DarkSheetHeader
            icon="gift-outline"
            title={t('直播送礼')}
            meta={balance ? t('余额 {balance}', { balance }) : undefined}
            onClose={onClose}
          />
          {status ? (
            <Text style={styles.status} numberOfLines={1}>{status}</Text>
          ) : null}
          <ScrollView
            style={[styles.grid, isLandscape ? styles.gridLandscape : null]}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.gridInner}>
              {gifts.map((gift) => {
                const active = String(selected?.giftId || selected?.id) === String(gift.giftId || gift.id);
                return (
                  <TouchableOpacity
                    key={String(gift.giftId || gift.id)}
                    style={[
                      styles.item,
                      {
                        backgroundColor: active ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)',
                        borderColor: active ? 'rgba(255,255,255,0.9)' : 'transparent',
                      },
                    ]}
                    onPress={() => onSelect(gift)}
                    activeOpacity={0.85}
                  >
                    {giftImage(gift)
                      ? <Image source={{ uri: giftImage(gift) }} style={styles.image} />
                      : <View style={styles.image} />}
                    <Text style={styles.name} numberOfLines={1}>{giftName(gift)}</Text>
                    <Text style={styles.cost}>{t('{count} 鸡腿', { count: giftCost(gift) })}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <View style={styles.footer}>
            <TextInput
              style={styles.num}
              keyboardType="numeric"
              value={num}
              onChangeText={onChangeNum}
              placeholderTextColor="rgba(255,255,255,0.4)"
            />
            <TouchableOpacity style={styles.sendBtn} onPress={onSend} activeOpacity={0.85}>
              <Text style={styles.sendText}>
                {selected ? t('送出 · {count}', { count: total }) : t('选择礼物')}
              </Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.rechargeBtn} onPress={onRecharge} activeOpacity={0.8}>
            <Text style={styles.rechargeText}>{t('余额不足？去充值鸡腿')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  shade: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  /** 横屏：底板横排、面板贴右（贡献榜/礼物面板共用） */
  shadeLandscape: { flexDirection: 'row', justifyContent: 'flex-end' },
  /**
   * 面板必须 `flexShrink: 1`（RN 默认 0，内容超高时不会收缩 → 底部按钮被顶出屏幕）。
   * 上限 88%，配合内部滚动区的 flexShrink 把高度让给底部操作行。
   */
  panel: {
    maxHeight: '88%',
    flexShrink: 1,
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: 'rgba(18,18,20,0.97)',
  },
  /** 横屏：贴右整列；内部滚动区 flexGrow 吃满剩余高度，底部固定行贴底 */
  panelLandscape: {
    maxHeight: '100%',
    width: 420,
    maxWidth: '92%',
    flexShrink: 0,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomLeftRadius: 20,
  },
  status: { fontSize: 12, marginBottom: 10, color: 'rgba(255,255,255,0.55)' },
  grid: { maxHeight: 360, flexShrink: 1 },
  gridLandscape: { flexGrow: 1, flexShrink: 1, maxHeight: '100%' },
  gridInner: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  item: { width: '31%', padding: 8, borderRadius: 12, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth },
  image: { width: 44, height: 44, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.12)', marginBottom: 6 },
  name: { fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.9)' },
  cost: { fontSize: 10, marginTop: 2, color: 'rgba(255,255,255,0.55)' },
  footer: { flexDirection: 'row', gap: 10, paddingTop: 12 },
  num: {
    width: 82,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    color: '#fff',
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  sendBtn: { flex: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', minHeight: 44, backgroundColor: '#fff' },
  sendText: { fontSize: 14, fontWeight: '800', color: '#111114' },
  rechargeBtn: { marginTop: 10, alignItems: 'center', paddingVertical: 10 },
  rechargeText: { fontSize: 13, fontWeight: '800', color: 'rgba(255,255,255,0.6)' },
});

export default LiveGiftSheet;
