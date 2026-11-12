/**
 * MyScreen · 「我的」（原设置 tab，2026-11-09 按 PiliPlus 思路拆分）
 *
 * PiliPlus 的「我的」页是个人中心：右上角放设置齿轮图标，点进去才是分门别类的设置列表。
 * 本页对应地（2026-11-11 改版）：
 *  - 右上角**纯图标**入口：深浅色切换 + 设置（SettingsDetailScreen），无文字
 *    （2026-11-12 按用户要求删掉「账号管理」图标入口，账号中心统一从顶部的账号头像进）；
 *  - 顶部是账号头像 / 用户名 / 等级（点头像进账号中心），不展示无官方接口的数字；
 *  - 稍后再看 / 观看历史改为贴边横滑卡区，由设置里的两个开关控制，默认关；
 *  - 工具与成员数据板块保留；应用图标、版本号、网页端入口、仓库地址与清除缓存移到设置最后一项「关于」。
 */
import React, { useEffect, useState } from 'react';
import { formatTimestamp } from '../utils/format';
import { useWatchLaterStore } from '../services/watchLater';
import { useWatchHistoryStore } from '../services/watchHistory';
import WatchCardStrip, { type WatchStripItem } from '../components/WatchCardStrip';
import { MediaPlaybackHost } from '../player/session';
import type { PlayMedia } from '../player/session';
import {
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CompositeNavigationProp, useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList, TabParamList } from '../navigation/types';
import { useUiStore, useSettingsStore } from '../store';
import { saveSettings } from '../services/settings';
import type { Theme } from '../types';
import ScreenHeader from '../components/ScreenHeader';
import { chromeScrollProps } from '../navigation/chromeScroll';
import { FadeInView, ScalePressable } from '../components/Motion';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { loadSelfProfile } from '../services/pocketNim/credentials';
import type { NimSelfProfile } from '../services/pocketNim/types';
import { accountAvatar } from './account/accountParse';
import { NetworkImage } from '../components/NetworkImage';
import { usePalette, radii, usePageBackground } from '../theme';
import { useI18n } from '../i18n';
import { GlassSurface } from '../components/GlassSurface';

type MyNavProp = CompositeNavigationProp<
  BottomTabNavigationProp<TabParamList, 'Settings'>,
  StackNavigationProp<RootStackParamList>
>;

/** 分组卡：玻璃常驻 + 内容淡入（与设置详情页同一套观感） */
function Section({ title, children, delay = 0 }: { title: string; children: React.ReactNode; delay?: number }) {
  const palette = usePalette();
  return (
    <View>
      {title ? (
        <Text style={[styles.sectionTitle, { color: palette.label }]}>{title}</Text>
      ) : null}
      <GlassSurface radius={20} role="card" style={styles.section}>
        <FadeInView delay={delay} duration={300} distance={0}>
          {children}
        </FadeInView>
      </GlassSurface>
    </View>
  );
}

/** 行式条目：28 圆角图标底 + 标题 + 右侧状态文字 / chevron */
function Row({ icon, title, value, onPress }: { icon: string; title: string; value?: string; onPress?: () => void }) {
  const palette = usePalette();
  return (
    <ScalePressable style={styles.row} onPress={onPress} pressedScale={0.98} activeOpacity={0.9} disabled={!onPress}>
      <View style={[styles.rowIcon, { backgroundColor: palette.tintSoft }]}>
        <MaterialCommunityIcons name={icon} color={palette.tint} size={16} />
      </View>
      <Text style={[styles.rowTitle, { color: palette.label }]} numberOfLines={1}>{title}</Text>
      {value ? <Text style={[styles.rowValue, { color: palette.labelTertiary }]} numberOfLines={1}>{value}</Text> : null}
      <MaterialCommunityIcons name="chevron-right" color={palette.labelTertiary} size={20} />
    </ScalePressable>
  );
}

export default function MyScreen() {
  const navigation = useNavigation<MyNavProp>();
  const palette = usePalette();
  const showToast = useUiStore((state) => state.showToast);
  const { t } = useI18n();
  const settings = useSettingsStore((state) => state.settings);
  const setSettings = useSettingsStore((state) => state.setSettings);
  const token = settings.p48Token;
  const watchLaterItems = useWatchLaterStore((state) => state.items);
  const historyItems = useWatchHistoryStore((state) => state.items);
  /** 自身资料（头像/昵称/等级）：loadSelfProfile 内有模块级缓存 + inflight + 切号自愈 */
  const [self, setSelf] = useState<NimSelfProfile | null>(null);
  /** 横滑卡点按后就地起播（与历史/稍后再看列表页同一套 modal 播放宿主） */
  const [playMedia, setPlayMedia] = useState<PlayMedia | null>(null);

  useEffect(() => {
    if (!token) {
      setSelf(null);
      return;
    }
    let alive = true;
    loadSelfProfile()
      .then((profile) => { if (alive) setSelf(profile); })
      .catch(() => { if (alive) setSelf(null); });
    return () => { alive = false; };
  }, [token]);

  /** 头像/昵称/等级：拿不到一律走占位，不编造数字（成长值、粉丝数官方无接口，已按用户要求不展示） */
  const avatarUri = accountAvatar({ avatar: self?.avatar || '' });
  const nickname = String(self?.nickName || (token ? t('未命名账号') : t('未登录口袋账号')));
  const level = Number(self?.level || 0);

  /**
   * 横滑区数据：只取最近 12 条。
   * media 的 kind/id 分派与 MediaListPage 的 playMedia 逐字一致，
   * 点卡片直接交给统一播放宿主解析直播/回放，不跳列表页。
   */
  const laterStripItems: WatchStripItem[] = watchLaterItems.slice(0, 12).map((it) => {
    const kind = String(it.kind || '');
    const base = { title: it.title, cover: it.cover, owner: it.owner, team: it.team, ownerId: it.ownerId };
    const media: PlayMedia = it.kind === 'video'
      ? { ...base, kind: 'video', videoId: it.id }
      : it.kind === 'openlive'
        ? { ...base, kind: 'openlive', liveId: it.id }
        : { ...base, kind: 'replay', liveId: it.id };
    return {
      key: it.key,
      title: it.title,
      cover: it.cover,
      label: it.audio || it.liveType === 2 ? t('电台') : kind === 'openlive' ? t('公演回放') : kind === 'replay' ? t('回放') : t('视频'),
      meta: formatTimestamp(it.at).slice(0, 16),
      media,
    };
  });
  const historyStripItems: WatchStripItem[] = historyItems.slice(0, 12).map((it) => {
    const kind = String(it.ref?.kind || it.kind || '');
    const base = { title: it.title, cover: it.cover, owner: it.owner, team: it.team, ownerId: it.ownerId };
    const refKind = it.ref?.kind;
    const refId = String(it.ref?.id || '');
    const liveId = String(it.liveId || '');
    const media: PlayMedia = refKind === 'video'
      ? { ...base, kind: 'video', videoId: refId || liveId }
      : refKind === 'openlive'
        ? { ...base, kind: 'openlive', liveId: refId || liveId }
        : refKind === 'replay'
          ? { ...base, kind: 'replay', liveId: liveId || refId }
          : { ...base, kind: 'live', liveId: liveId || refId };
    return {
      key: it.key,
      title: it.title,
      cover: it.cover,
      label: it.audio || it.liveType === 2 ? t('电台') : kind === 'openlive' ? t('公演回放') : kind === 'replay' ? t('回放') : t('视频'),
      meta: `${formatTimestamp(it.at).slice(0, 16)}${it.count > 1 ? ` · ${t('看过 {count} 次', { count: it.count })}` : ''}`,
      media,
    };
  });

  return (
    <>
      <View style={[styles.container, { backgroundColor: usePageBackground() }]}>
        {/* 2026-11-12：用户要求删掉右上角的「账号管理」入口（点头像仍进账号中心）——
            这里只留深浅色切换与设置齿轮 */}
        <ScreenHeader
          title={t('我的')}
          hideBack
          right={
            <View style={styles.headerActions}>
              {/* 深浅色切换（用户 2026-11-12）：单按钮循环「跟随系统 → 浅色 → 深色」，
                  只用图标表示，不留文字；设置里的主题入口继续保留。 */}
              <TouchableOpacity
                onPress={() => {
                  const order: Theme[] = ['system', 'light', 'dark'];
                  const next = order[(order.indexOf(settings.theme) + 1) % order.length];
                  setSettings({ theme: next });
                  void saveSettings({ theme: next });
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`${t('主题')}：${settings.theme === 'light' ? t('浅色') : settings.theme === 'dark' ? t('深色') : t('跟随系统')}`}
              >
                <MaterialCommunityIcons
                  name={settings.theme === 'light' ? 'weather-sunny' : settings.theme === 'dark' ? 'weather-night' : 'theme-light-dark'}
                  size={22}
                  color={palette.label}
                />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => navigation.navigate('SettingsDetailScreen')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={t('设置')}
              >
                <MaterialCommunityIcons name="cog-outline" size={22} color={palette.label} />
              </TouchableOpacity>
            </View>
          }
        />
        <ScrollView {...chromeScrollProps} style={{ flex: 1 }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

          {/* 账号头部：头像 + 用户名 + 等级（等级拿不到就不显示徽章），点击进账号中心 */}
          <Section title="" delay={60}>
            <ScalePressable
              onPress={() => navigation.navigate('AccountScreen')}
              pressedScale={0.985}
              activeOpacity={0.9}
            >
              <View style={styles.accountHero}>
                {avatarUri ? (
                  <NetworkImage
                    source={{ uri: avatarUri }}
                    style={styles.accountHeroAvatar}
                    resizeMode="cover"
                    thumbnail={160}
                  />
                ) : (
                  <View style={[styles.accountHeroAvatarFallback, { backgroundColor: palette.fill2 }]}>
                    <MaterialCommunityIcons name="account" color={palette.tint} size={30} />
                  </View>
                )}
                <View style={styles.accountHeroText}>
                  <View style={styles.accountHeroNameRow}>
                    <Text style={[styles.accountHeroName, { color: palette.label }]} numberOfLines={1}>
                      {nickname}
                    </Text>
                    {level > 0 ? (
                      <View style={[styles.levelBadge, { backgroundColor: palette.tint }]}>
                        <Text style={styles.levelBadgeText}>LV{level}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={[styles.accountHeroSub, { color: palette.labelSecondary }]} numberOfLines={1}>
                    {t('登录 / 切换 / 修改资料')}
                  </Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" color={palette.labelTertiary} size={20} />
              </View>
            </ScalePressable>
          </Section>

          {/* 用户信息下面三个入口：图标在上、文字在下（对齐样图） */}
          <View style={styles.quickCardWrap}>
            <Section title="" delay={80}>
              <View style={styles.quickEntries}>
                {[
                  { icon: 'bookmark-multiple-outline', label: t('稍后再看'), route: 'WatchLaterScreen' },
                  { icon: 'history', label: t('观看历史'), route: 'HistoryScreen' },
                  { icon: 'download-outline', label: t('下载管理'), route: 'DownloadScreen' },
                ].map((entry) => (
                  <ScalePressable
                    key={entry.label}
                    onPress={() => navigation.navigate(entry.route as any)}
                    pressedScale={0.94}
                    style={styles.quickEntry}
                  >
                    <MaterialCommunityIcons name={entry.icon} size={24} color={palette.label} />
                    <Text style={[styles.quickEntryText, { color: palette.labelSecondary }]} numberOfLines={1}>
                      {entry.label}
                    </Text>
                  </ScalePressable>
                ))}
              </View>
              <View style={[styles.divider, { backgroundColor: palette.innerStroke, marginLeft: 0 }]} />
              <Row
                icon="open-in-new"
                title={t('牙牙消息网页端')}
                value="gnz.hk"
                onPress={() => Linking.openURL('https://gnz.hk/').catch(() => showToast(t('这个链接无法直接打开。')))}
              />
            </Section>
          </View>
          <View style={[styles.sectionLine, { backgroundColor: palette.innerStroke }]} />

          {/* 稍后再看 / 观看历史：设置里打开开关后，按首页公演直播的横滑卡样式展示；点卡片直接起播 */}
          {settings.my_show_watch_later ? (
            <WatchCardStrip
              title={t('稍后再看')}
              count={watchLaterItems.length}
              items={laterStripItems}
              emptyText={t('稍后再看为空')}
              onPressAll={() => navigation.navigate('WatchLaterScreen')}
              onPressItem={(item) => { if (item.media) setPlayMedia(item.media); }}
            />
          ) : null}
          {settings.my_show_watch_history ? (
            <WatchCardStrip
              title={t('观看历史')}
              count={historyItems.length}
              items={historyStripItems}
              emptyText={t('历史为空')}
              onPressAll={() => navigation.navigate('HistoryScreen')}
              onPressItem={(item) => { if (item.media) setPlayMedia(item.media); }}
            />
          ) : null}

        </ScrollView>
      </View>
      {/* 横滑卡点按后就地全屏播放：与历史/稍后再看列表页同一套 modal 播放宿主 */}
      {playMedia ? (
        <MediaPlaybackHost
          modal
          media={playMedia}
          onClose={() => setPlayMedia(null)}
          announcement
          danmakuLivePollMs={5000}
          danmakuVodNotice
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 112, paddingHorizontal: 16 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginTop: 20, marginBottom: 8, paddingHorizontal: 4 },
  section: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12 },
  rowIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600' },
  rowValue: { flexShrink: 1, fontSize: 12, marginRight: 6, maxWidth: '48%', textAlign: 'right' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 54 },
  accountHero: { flexDirection: 'row', alignItems: 'center', padding: 16 },
  accountHeroAvatar: { width: 60, height: 60, borderRadius: 30 },
  accountHeroAvatarFallback: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  accountHeroText: { flex: 1, minWidth: 0, marginLeft: 14 },
  accountHeroNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  accountHeroName: { fontSize: 20, fontWeight: '800', flexShrink: 1 },
  levelBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radii.pill },
  levelBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  accountHeroSub: { fontSize: 12, marginTop: 5 },
  // 账号信息下方三个入口：图标在上、文字在下，等宽横排（对齐样图）
  quickCardWrap: { marginTop: 16 },
  quickEntries: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16 },
  quickEntry: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 7 },
  quickEntryText: { fontSize: 12, fontWeight: '600' },
  sectionLine: { height: StyleSheet.hairlineWidth, marginTop: 18 },
});
