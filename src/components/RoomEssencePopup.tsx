/**
 * 房间「精华消息」弹窗 + 工具栏喇叭入口（用户 2026-11-09）。
 *
 * 口径（对齐播放器里的直播间公告，但换成居中大弹窗）：
 *   · 进房拿到精华消息 → 有**没看过**的自动弹一次；关掉后不再主动弹；
 *   · 关掉之后只留工具栏「大房间/小房间」右侧一个喇叭图标，随时可以点开；
 *   · 弹窗里：发送者头像（点了跳用户主页）、全文、图片（点了看原图）、视频（就地播）；
 *   · 正在加载 / 加载失败（带重试）都有明确状态（桌面端 loadFollowedRoomEssence 同款文案）。
 *
 * 数据来自偶像在官方客户端设置的精华（/team/essence/message/list），**用户不能自己置顶**。
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import Video from 'react-native-video';
import { NetworkImage } from './NetworkImage';
import { usePalette, withAlpha } from '../theme';
import { useI18n } from '../i18n';
import { POCKET_MEDIA_HEADERS } from '../utils/mediaHeaders';
import { AVATAR_THUMB_WIDTH } from '../utils/imageThumb';
import { essenceMediaKind, type RoomEssenceMessage } from '../utils/roomPinnedRules';
import type { RoomEssenceStatus } from '../services/roomPinned';

function formatTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms > 1e12 ? ms : ms * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 工具栏喇叭入口：放在「大房间 / 小房间」分段控件右边一点。
 * 有没看过的精华时右上角一个红点（不显示数字，避免挤坏窄工具条）。
 */
export function RoomPinnedBell({
  onPress,
  hasUnseen,
  active,
  loading,
}: {
  onPress: () => void;
  hasUnseen: boolean;
  active?: boolean;
  loading?: boolean;
}) {
  const palette = usePalette();
  const { t } = useI18n();
  return (
    <TouchableOpacity
      style={[
        styles.bell,
        {
          backgroundColor: active ? palette.tint : palette.fill2,
          borderColor: active ? 'transparent' : palette.hairline,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={t('精华消息')}
    >
      {loading ? (
        <ActivityIndicator size="small" color={active ? palette.onTint : palette.labelSecondary} />
      ) : (
        <MaterialCommunityIcons
          name="bullhorn-outline"
          size={17}
          color={active ? palette.onTint : palette.labelSecondary}
        />
      )}
      {hasUnseen && !loading ? (
        <View style={[styles.bellDot, { backgroundColor: palette.danger, borderColor: palette.surface }]} />
      ) : null}
    </TouchableOpacity>
  );
}

/**
 * 精华消息大弹窗。
 * 一条一条看（i/N + 上一条/下一条），内容区可滚，图片点开看原图、视频就地播。
 */
export function RoomPinnedSheet({
  visible,
  items,
  index,
  status,
  onPrev,
  onNext,
  onClose,
  onRetry,
  onOpenSender,
  onOpenImage,
}: {
  visible: boolean;
  items: RoomEssenceMessage[];
  index: number;
  status: RoomEssenceStatus;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onRetry: () => void;
  /** 点头像：跳用户主页（成员档案页 / 非成员资料卡由页面决定） */
  onOpenSender: (item: RoomEssenceMessage) => void;
  /** 点图片：打开全屏查看器（原图 + 双指缩放） */
  onOpenImage: (url: string) => void;
}) {
  const palette = usePalette();
  const { t } = useI18n();
  const { width: winW, height: winH } = useWindowDimensions();
  const total = items.length;
  const item = total ? items[Math.min(Math.max(0, index), total - 1)] : null;
  const media = essenceMediaKind(item);
  const [videoPaused, setVideoPaused] = useState(true);
  /** 换一条就重新盖住播放（视频不跨条串音） */
  useEffect(() => setVideoPaused(true), [item?.id]);

  const cardMaxH = Math.max(300, Math.round(winH * 0.82));
  const mediaW = Math.min(winW - 96, 420);
  const mediaH = Math.max(150, Math.round((mediaW * 9) / 16));
  const loading = status === 'loading' && !total;
  const failed = status === 'error' && !total;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View
          style={[
            styles.card,
            { maxHeight: cardMaxH, backgroundColor: palette.surface, borderColor: withAlpha(palette.tint, 0.28) },
          ]}
        >
          <View style={[styles.head, { borderBottomColor: palette.hairline }]}>
            <MaterialCommunityIcons name="bullhorn" size={16} color={palette.tint} />
            <Text style={[styles.headTitle, { color: palette.label }]} numberOfLines={1}>
              {t('精华消息')}
            </Text>
            {total ? (
              <Text style={[styles.headCount, { color: palette.labelTertiary }]}>
                {Math.min(Math.max(0, index), total - 1) + 1}/{total}
              </Text>
            ) : null}
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              onPress={loading ? undefined : onRetry}
              disabled={loading}
              style={[styles.headBtn, { backgroundColor: palette.tintSoft, opacity: loading ? 0.5 : 1 }]}
              activeOpacity={0.8}
            >
              <Text style={[styles.headBtnText, { color: palette.tint }]}>{t('刷新')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.headBtn, { backgroundColor: palette.tintSoft }]}
              activeOpacity={0.8}
            >
              <Text style={[styles.headBtnText, { color: palette.tint }]}>{t('收起')}</Text>
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.stateBox}>
              <ActivityIndicator color={palette.tint} />
              <Text style={[styles.stateText, { color: palette.labelSecondary }]}>{t('正在加载精华消息')}</Text>
            </View>
          ) : failed ? (
            <View style={styles.stateBox}>
              <MaterialCommunityIcons name="cloud-off-outline" size={26} color={palette.labelTertiary} />
              <Text style={[styles.stateText, { color: palette.labelSecondary }]}>{t('精华消息加载失败')}</Text>
              <TouchableOpacity style={[styles.retryBtn, { backgroundColor: palette.tint }]} onPress={onRetry} activeOpacity={0.85}>
                <Text style={[styles.retryText, { color: palette.onTint }]}>{t('重试')}</Text>
              </TouchableOpacity>
            </View>
          ) : !item ? (
            <View style={styles.stateBox}>
              <MaterialCommunityIcons name="star-outline" size={26} color={palette.labelTertiary} />
              <Text style={[styles.stateText, { color: palette.labelSecondary }]}>{t('暂无精华消息')}</Text>
            </View>
          ) : (
            <>
              <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false}>
                <TouchableOpacity
                  style={styles.senderRow}
                  activeOpacity={0.8}
                  onPress={() => onOpenSender(item)}
                  accessibilityRole="button"
                  accessibilityLabel={t('查看 {name} 的主页', { name: item.sender })}
                >
                  {item.avatarUrl ? (
                    <NetworkImage
                      source={{ uri: item.avatarUrl }}
                      style={[styles.avatar, { borderColor: palette.hairline }]}
                      thumbnail={AVATAR_THUMB_WIDTH}
                      fallback
                      fallbackIcon="account"
                    />
                  ) : (
                    <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: palette.fill2 }]}>
                      <MaterialCommunityIcons name="account" size={18} color={palette.labelTertiary} />
                    </View>
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.sender, { color: palette.tint }]} numberOfLines={1}>{item.sender}</Text>
                    <Text style={[styles.time, { color: palette.labelTertiary }]} numberOfLines={1}>{formatTime(item.time)}</Text>
                  </View>
                  <MaterialCommunityIcons name="chevron-right" size={18} color={palette.labelTertiary} />
                </TouchableOpacity>

                {media !== 'video' || !item.videoUrl ? (
                  <Text style={[styles.text, { color: palette.label }]}>{item.text}</Text>
                ) : null}

                {media === 'image' ? (
                  <TouchableOpacity onPress={() => onOpenImage(item.imageUrl)} activeOpacity={0.9}>
                    <NetworkImage
                      source={{ uri: item.imageUrl }}
                      style={[styles.image, { height: mediaH, borderColor: palette.hairline }]}
                      resizeMode="cover"
                      localFallback
                    />
                    <View style={styles.imageHintRow}>
                      <MaterialCommunityIcons name="magnify-plus-outline" size={12} color={palette.labelTertiary} />
                      <Text style={[styles.imageHint, { color: palette.labelTertiary }]}>{t('点击查看原图')}</Text>
                    </View>
                  </TouchableOpacity>
                ) : null}

                {media === 'video' && item.videoUrl ? (
                  <View style={[styles.videoWrap, { height: mediaH, borderColor: palette.hairline }]}>
                    <Video
                      source={{ uri: item.videoUrl, headers: POCKET_MEDIA_HEADERS }}
                      style={StyleSheet.absoluteFill}
                      resizeMode="contain"
                      controls
                      paused={videoPaused}
                      poster={item.videoPoster || undefined}
                      posterResizeMode="contain"
                      playInBackground={false}
                      onEnd={() => setVideoPaused(true)}
                      onError={() => setVideoPaused(true)}
                    />
                  </View>
                ) : null}
              </ScrollView>

              <View style={[styles.footer, { borderTopColor: palette.hairline }]}>
                <TouchableOpacity
                  style={[styles.navBtn, { backgroundColor: palette.fill2, opacity: index <= 0 ? 0.4 : 1 }]}
                  onPress={onPrev}
                  disabled={index <= 0}
                  activeOpacity={0.85}
                >
                  <MaterialCommunityIcons name="chevron-left" size={16} color={palette.labelSecondary} />
                  <Text style={[styles.navText, { color: palette.labelSecondary }]}>{t('上一条')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.navBtn, { backgroundColor: palette.fill2, opacity: index >= total - 1 ? 0.4 : 1 }]}
                  onPress={onNext}
                  disabled={index >= total - 1}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.navText, { color: palette.labelSecondary }]}>{t('下一条')}</Text>
                  <MaterialCommunityIcons name="chevron-right" size={16} color={palette.labelSecondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.navBtn, { backgroundColor: palette.tint, marginLeft: 'auto' }]}
                  onPress={onClose}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.navText, { color: palette.onTint }]}>{t('关闭')}</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bell: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, marginLeft: 4,
  },
  bellDot: {
    position: 'absolute', top: 5, right: 5, width: 8, height: 8, borderRadius: 4, borderWidth: 1,
  },

  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: 16 },
  card: { width: '100%', maxWidth: 460, borderRadius: 22, borderWidth: 1, padding: 16, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  headTitle: { fontSize: 16, fontWeight: '800' },
  headCount: { fontSize: 11, fontWeight: '700', marginLeft: 2 },
  headBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 9 },
  headBtnText: { fontSize: 11, fontWeight: '700' },

  stateBox: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 40 },
  stateText: { fontSize: 12, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 10, marginTop: 2 },
  retryText: { fontSize: 12, fontWeight: '800' },

  body: { flexGrow: 0, flexShrink: 1, marginTop: 10 },
  bodyContent: { paddingBottom: 6 },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  avatar: { width: 36, height: 36, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  sender: { fontSize: 13, fontWeight: '800' },
  time: { fontSize: 11, marginTop: 1 },
  text: { fontSize: 14, lineHeight: 22, marginTop: 10 },
  image: { width: '100%', marginTop: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  imageHintRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 5 },
  imageHint: { fontSize: 10 },
  videoWrap: { width: '100%', marginTop: 10, borderRadius: 12, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, backgroundColor: '#000' },

  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  navBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  navText: { fontSize: 12, fontWeight: '800' },
});
