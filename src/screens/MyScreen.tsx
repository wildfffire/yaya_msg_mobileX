/**
 * MyScreen · 「我的」（原设置 tab，2026-11-09 按 PiliPlus 思路拆分）
 *
 * PiliPlus 的「我的」页是个人中心：右上角放设置齿轮图标，点进去才是分门别类的设置列表。
 * 本页对应地：
 *  - 右上角两个**纯图标**入口：账号管理（LoginScreen）在左、设置（SettingsDetailScreen）在右，无文字；
 *  - 本页只保留「关于 hero（稍后再看 / 观看历史 / 牙牙消息网页端）」「工具」「成员数据」三个板块；
 *  - 原「账号 / 外观 / 语言 / 小窗播放 / 房间 / 自动签到」全部搬去 SettingsDetailScreen 分类陈列。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toMs } from '../utils/format';
import {
  Image,
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
import { useUiStore, useMemberStore, useUpdateStore } from '../store';
import ScreenHeader from '../components/ScreenHeader';
import { chromeScrollProps } from '../navigation/chromeScroll';
import { FadeInView, ScalePressable } from '../components/Motion';
import RuntimeLogViewer from '../components/RuntimeLogViewer';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { APP_VERSION, APP_BUILD } from '../constants';
import { getMemberDataMeta, MemberDataMeta, updateMemberData } from '../services/memberData';
import { usePalette, radii, radiiAlias, usePageBackground } from '../theme';
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

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(toMs(ts));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function MyScreen() {
  const navigation = useNavigation<MyNavProp>();
  const palette = usePalette();
  const showToast = useUiStore((state) => state.showToast);
  const memberCount = useMemberStore((state) => state.members.length);
  const { t } = useI18n();
  const hasUpdate = useUpdateStore((s) => s.hasUpdate);
  const [meta, setMeta] = useState<MemberDataMeta | null>(null);
  const [logVisible, setLogVisible] = useState(false);
  const [memberSyncing, setMemberSyncing] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    getMemberDataMeta().then(setMeta).catch(() => {});
  }, []);

  /** 手动更新成员数据库（双源: yk1z 库 + 官方接口） */
  const manualSyncMembers = useCallback(async () => {
    if (memberSyncing || !mountedRef.current) return;
    setMemberSyncing(true);
    try {
      const res = await updateMemberData();
      if (!mountedRef.current) return;
      if (!res?.updated) {
        showToast(t('更新失败：{msg}（已保留本地数据）', { msg: res?.message || '' }));
        return;
      }
      const fresh = await getMemberDataMeta();
      if (!mountedRef.current) return;
      setMeta(fresh);
      showToast(res?.detail ? t('更新成功：{detail}', { detail: res.detail }) : t('成员数据已更新'));
    } catch (e: any) {
      if (!mountedRef.current) return;
      showToast(t('更新失败：{msg}（已保留本地数据）', { msg: e?.message || String(e) }));
    } finally {
      if (mountedRef.current) setMemberSyncing(false);
    }
  }, [memberSyncing, t, showToast]);

  const checkVersion = () => {
    const { hasUpdate: up, latestUrl } = useUpdateStore.getState();
    if (up && latestUrl) {
      Linking.openURL(latestUrl).catch(() => {});
    } else {
      useUpdateStore.getState().checkUpdate(true).then((has) => {
        const next = useUpdateStore.getState();
        if (has && next.hasUpdate && next.latestUrl) Linking.openURL(next.latestUrl).catch(() => {});
        else showToast(t('已是最新版本'));
      }).catch(() => showToast(t('已是最新版本')));
    }
  };

  return (
    <>
      <View style={[styles.container, { backgroundColor: usePageBackground() }]}>
        {/* 2026-11-09：账号管理在左、设置放它右边，两个都只显示图标 */}
        <ScreenHeader
          title={t('我的')}
          hideBack
          right={
            <View style={styles.headerActions}>
              <TouchableOpacity
                onPress={() => navigation.navigate('LoginScreen')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={t('进入账号管理')}
              >
                <MaterialCommunityIcons name="account-key-outline" size={22} color={palette.label} />
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

          {/* 关于 hero：稍后再看 / 观看历史 / 牙牙消息网页端（用户要求保留的板块） */}
          <Section title="" delay={60}>
            <View style={styles.aboutHero}>
              <View style={styles.aboutLogoWrap}>
                <Image source={require('../../assets/logo.png')} style={styles.aboutLogoImg} />
              </View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={[styles.aboutName, { color: palette.label }]}>{t('牙牙消息 X')}</Text>
                <Text style={[styles.aboutSub, { color: palette.labelSecondary }]} numberOfLines={1}>{t('Yaya Message X · 口袋48 第三方客户端')}</Text>
              </View>
              <View style={styles.verChipWrap}>
                <TouchableOpacity style={[styles.verChip, { backgroundColor: palette.tintSoft }]} onPress={checkVersion} activeOpacity={0.85}>
                  <Text style={[styles.verChipText, { color: palette.tint }]}>v{APP_VERSION}</Text>
                </TouchableOpacity>
                {hasUpdate ? <View style={[styles.verDot, { backgroundColor: palette.danger, borderColor: palette.surface }]} /> : null}
                <Text style={[styles.verBuildText, { color: palette.labelTertiary }]}>
                  {t('Build {n}', { n: APP_BUILD })}
                </Text>
              </View>
            </View>
            <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
            <Row
              icon="bookmark-multiple-outline"
              title={t('稍后再看')}
              value={t('视频 / 公演回放 / 直播回放')}
              onPress={() => navigation.navigate('WatchLaterScreen')}
            />
            <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
            <Row
              icon="history"
              title={t('观看历史')}
              value={t('播放记录与统计')}
              onPress={() => navigation.navigate('HistoryScreen')}
            />
            <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
            <Row
              icon="open-in-new"
              title={t('牙牙消息网页端')}
              value="gnz.hk"
              onPress={() => Linking.openURL('https://gnz.hk/').catch(() => showToast(t('这个链接无法直接打开。')))}
            />
          </Section>

          {/* 工具（用户要求保留） */}
          <Section title={t('工具')} delay={100}>
            {/* 现场互动（口袋云握手）：活动场次 / 预约 / 资格兑换（用户 2026-11-09） */}
            <Row icon="account-voice" title={t('现场互动')} onPress={() => navigation.navigate('NetfaceScreen')} />
            <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
            <Row icon="download" title={t('下载管理')} onPress={() => navigation.navigate('DownloadScreen')} />
            <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
            <Row icon="text-box-search-outline" title={t('运行日志')} onPress={() => setLogVisible(true)} />
          </Section>

          {/* 成员数据（用户要求保留） */}
          <Section title={t('成员数据')} delay={140}>
            <View style={styles.memberStatRow}>
              <View style={[styles.memberStatCard, { backgroundColor: palette.fill3 }]}>
                <Text style={[styles.memberStatNum, { color: palette.label }]}>{memberCount}</Text>
                <Text style={[styles.memberStatLabel, { color: palette.labelSecondary }]}>{t('位成员')}</Text>
              </View>
              <View style={[styles.memberStatCard, { backgroundColor: palette.fill3 }]}>
                <Text style={[styles.memberStatNum, { color: palette.label }]}>{meta ? formatTime(meta.savedAt) : t('尚未同步')}</Text>
                <Text style={[styles.memberStatLabel, { color: palette.labelSecondary }]}>{t('最近更新')}</Text>
              </View>
            </View>
            <View style={[styles.autoSyncRow, { backgroundColor: palette.tintSoft }]}>
              <MaterialCommunityIcons name="sync" size={16} color={palette.tint} />
              <Text style={[styles.autoSyncText, { color: palette.labelSecondary }]}>{t('进入软件时自动同步成员数据')}</Text>
            </View>
            <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
            <Row
              icon="cloud-download"
              title={t('手动更新成员数据')}
              value={memberSyncing ? t('更新中…') : t('立即同步')}
              onPress={manualSyncMembers}
            />
            <Text style={[styles.note, { color: palette.labelTertiary }]}>
              {t('成员数据共 {count} 位，数据来源于 yk1z 数据库（yk1z/yaya_msg），进入软件时自动同步最新。', { count: memberCount })}
            </Text>
          </Section>

        </ScrollView>
      </View>
      <RuntimeLogViewer visible={logVisible} onClose={() => setLogVisible(false)} />
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
  aboutHero: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  aboutLogoWrap: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  aboutLogoImg: { width: 52, height: 52 },
  aboutName: { fontSize: 20, fontWeight: '800' },
  aboutSub: { fontSize: 12, marginTop: 4 },
  verChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radiiAlias.button },
  verChipWrap: { alignItems: 'flex-end' },
  verDot: { position: 'absolute', top: -2, right: -2, width: 9, height: 9, borderRadius: 5, borderWidth: 1.5 },
  verChipText: { fontSize: 12, fontWeight: '800' },
  verBuildText: { fontSize: 10, fontWeight: '600', marginTop: 3 },
  memberStatRow: { flexDirection: 'row', gap: 10, padding: 14 },
  memberStatCard: { flex: 1, padding: 16, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  memberStatNum: { fontSize: 18, fontWeight: '900', textAlign: 'center' },
  memberStatLabel: { fontSize: 11, marginTop: 4 },
  autoSyncRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radiiAlias.card },
  autoSyncText: { fontSize: 12, marginLeft: 8, fontWeight: '600' },
  note: { marginHorizontal: 14, marginTop: 10, fontSize: 11, lineHeight: 16 },
  footer: { textAlign: 'center', fontSize: 12, marginTop: 24 },
  footerSub: { textAlign: 'center', fontSize: 10, marginTop: 3 },
});
