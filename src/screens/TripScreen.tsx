/**
 * TripScreen · 行程（口袋 `trip/api/v1/trip/v1/list`）
 *
 * 入口：首页「工具」区「行程」chip。
 * 交互：默认看全部行程，可搜索选择成员只看某一位；分「今天 / 即将到来 / 过往」三段。
 * 字段口径见 utils/trip.ts（与桌面端 trip-feature.js 对齐）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, RefreshControl, StyleSheet, Text, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import MemberPicker from '../components/MemberPicker';
import { PerfFlatList } from '../components/PerfFlatList';
import { GlassSurface } from '../components/GlassSurface';
import { FadeInView, ScalePressable } from '../components/Motion';
import { EmptyState, ErrorState } from '../components/StateViews';
import { CenterSpinner } from '../components/Loaders';
import { useSettingsStore, useUiStore } from '../store';
import { Member } from '../types';
import pocketApi from '../api/pocket48';
import { errorMessage } from '../utils/data';
import { groupTrips, normalizeTripList, parseTripItem, tripCursor, type TripItem } from '../utils/trip';
import { usePalette, radii } from '../theme';
import { typography } from '../theme/typography';
import { useI18n } from '../i18n';

/** 最多翻几页（每页 20 条左右；避免弱网时无限翻页把页面卡住） */
const MAX_PAGES = 6;

type Row =
  | { kind: 'header'; key: string; title: string; empty: string; count: number }
  | { kind: 'trip'; key: string; item: TripItem };

export default function TripScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const showToast = useUiStore((state) => state.showToast);
  const token = useSettingsStore((state) => state.settings.p48Token);

  const [member, setMember] = useState<Member | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [items, setItems] = useState<TripItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** 每次请求递增，丢弃过期响应（快速切成员时） */
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async (target: Member | null) => {
    if (!token) {
      setItems([]);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    const collected: TripItem[] = [];
    const seen = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = '0';
    let isMore = false;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        if (seenCursors.has(cursor)) break;
        seenCursors.add(cursor);
        const res: any = await pocketApi.getTripList({
          memberId: target ? String(target.id) : '',
          groupId: 0,
          lastTime: cursor,
          isMore,
        });
        const list = normalizeTripList(res?.content ?? res?.data);
        list.forEach((raw: any, index: number) => {
          const parsed = parseTripItem(raw, collected.length + index);
          if (!parsed || seen.has(parsed.key)) return;
          seen.add(parsed.key);
          collected.push(parsed);
        });
        const next = tripCursor(res?.content, list);
        if (!list.length || !next || next === cursor || next === '0') break;
        cursor = next;
        isMore = true;
      }
      setItems(collected);
    } catch (err) {
      setError(errorMessage(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load(member);
  }, [load, member, reloadKey]);

  const rows = useMemo<Row[]>(() => {
    const groups = groupTrips(items);
    const out: Row[] = [];
    const pushHeader = (key: string, title: string, empty: string, list: TripItem[]) => {
      // 空分组不占位（整页无行程时由 EmptyState 兜底）
      if (!list.length) return;
      out.push({ kind: 'header', key, title, empty, count: list.length });
      list.forEach((item) => out.push({ kind: 'trip', key: `trip-${key}-${item.key}`, item }));
    };
    pushHeader('today', t('今天'), t('今天暂无行程'), groups.today);
    pushHeader('upcoming', t('即将到来'), t('暂无即将到来的行程'), groups.upcoming);
    pushHeader('past', t('过往'), t('暂无过往行程'), groups.past);
    return out;
  }, [items, t]);

  const openTicket = useCallback((url: string) => {
    if (!url) return;
    Linking.openURL(url).catch(() => showToast(t('这个链接无法直接打开。')));
  }, [showToast, t]);

  const renderRow = useCallback(({ item }: { item: Row }) => {
    if (item.kind === 'header') {
      return (
        <View style={styles.sectionHead}>
          <Text style={[typography.subhead, { color: palette.label, fontWeight: '700' }]}>{item.title}</Text>
          {item.count ? (
            <Text style={[styles.sectionCount, { color: palette.labelTertiary }]}>{item.count}</Text>
          ) : null}
        </View>
      );
    }
    const trip = item.item;
    return (
      <GlassSurface radius={16} role="card" style={styles.card}>
        <View style={styles.cardInner}>
          <View style={[styles.dateBox, { backgroundColor: palette.tintSoft }]}>
            <Text style={[styles.dateText, { color: palette.tint }]} numberOfLines={1}>{trip.dateText || '—'}</Text>
            {trip.timeText ? <Text style={[styles.timeText, { color: palette.tint }]}>{trip.timeText}</Text> : null}
          </View>
          <View style={styles.body}>
            <Text style={[styles.title, { color: palette.label }]}>{trip.title}</Text>
            {trip.subTitle ? <Text style={[styles.sub, { color: palette.labelSecondary }]}>{trip.subTitle}</Text> : null}
            {trip.content ? <Text style={[styles.desc, { color: palette.labelSecondary }]}>{trip.content}</Text> : null}
            {trip.location ? <InfoRow icon="map-marker-outline" text={trip.location} /> : null}
            {trip.members ? <InfoRow icon="account-multiple-outline" text={trip.members} /> : null}
            {trip.liveText ? <InfoRow icon="broadcast" text={trip.liveText} /> : null}
            {trip.ticketText || trip.ticketUrl ? (
              <View style={styles.ticketRow}>
                {trip.ticketText ? (
                  <Text style={[styles.ticketText, { color: palette.labelSecondary }]} numberOfLines={2}>{trip.ticketText}</Text>
                ) : <View style={{ flex: 1 }} />}
                {trip.ticketUrl ? (
                  <ScalePressable
                    style={[styles.ticketBtn, { backgroundColor: palette.tintSoft }]}
                    onPress={() => openTicket(trip.ticketUrl)}
                  >
                    <Text style={[styles.ticketBtnText, { color: palette.tint }]}>{t('票务')}</Text>
                  </ScalePressable>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </GlassSurface>
    );
  }, [openTicket, palette, t]);

  const header = (
    <>
      <ScreenHeader
        title={t('行程')}
        right={<HeaderAction label={t('刷新')} onPress={() => setReloadKey((n) => n + 1)} disabled={loading} loading={loading} />}
      />
      <FadeInView delay={60} duration={300}>
        <View style={styles.pickerCard}>
          <GlassSurface radius={20} role="card" style={styles.pickerRow}>
            <View style={[styles.pickerIcon, { backgroundColor: palette.tintSoft }]}>
              <MaterialCommunityIcons name="briefcase-outline" size={18} color={palette.tint} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[styles.pickerName, { color: palette.label }]} numberOfLines={1}>
                {member ? member.ownerName : t('全部成员')}
              </Text>
              <Text style={[styles.pickerSub, { color: palette.labelTertiary }]} numberOfLines={1}>
                {t('行程与票务')}
              </Text>
            </View>
            {member ? (
              <ScalePressable
                style={[styles.clearBtn, { backgroundColor: palette.fill3 }]}
                onPress={() => { setMember(null); setPickerOpen(false); }}
              >
                <Text style={{ color: palette.labelSecondary, fontSize: 12 }}>{t('全部')}</Text>
              </ScalePressable>
            ) : null}
            <ScalePressable
              style={[styles.clearBtn, { backgroundColor: palette.tintSoft, marginLeft: 8 }]}
              onPress={() => setPickerOpen((v) => !v)}
            >
              <MaterialCommunityIcons name={pickerOpen ? 'chevron-up' : 'chevron-down'} size={18} color={palette.tint} />
            </ScalePressable>
          </GlassSurface>
          {pickerOpen ? (
            <View style={styles.pickerBody}>
              <MemberPicker
                selectedMember={member}
                onSelect={(next) => { setMember(next); setPickerOpen(false); }}
                placeholder={t('搜索成员查看行程...')}
              />
            </View>
          ) : null}
        </View>
      </FadeInView>
    </>
  );

  const emptyNode = !token ? (
    <EmptyState
      icon="account-key-outline"
      title={t('需要登录口袋账号')}
      hint={t('行程需要登录后查看，请先在账号设置登录口袋48')}
    />
  ) : error ? (
    <ErrorState title={t('加载失败')} hint={error} onAction={() => setReloadKey((n) => n + 1)} />
  ) : loading ? (
    <View style={styles.center}><CenterSpinner /></View>
  ) : (
    <EmptyState icon="briefcase-outline" title={t('暂无行程')} hint={member ? t('该成员暂时没有行程') : t('请稍后刷新试试')} />
  );

  return (
    <View style={styles.container}>
      {header}
      {items.length === 0 ? (
        <FadeInView delay={120} duration={300} style={{ flex: 1 }}>{emptyNode}</FadeInView>
      ) : (
        <PerfFlatList
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={renderRow}
          contentContainerStyle={styles.list}
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={7}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={() => setReloadKey((n) => n + 1)}
              tintColor={palette.tint}
              colors={[palette.tint]}
            />
          }
        />
      )}
    </View>
  );
}

function InfoRow({ icon, text }: { icon: string; text: string }) {
  const palette = usePalette();
  return (
    <View style={styles.infoRow}>
      <MaterialCommunityIcons name={icon} size={13} color={palette.labelTertiary} />
      <Text style={[styles.infoText, { color: palette.labelSecondary }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  pickerCard: { paddingHorizontal: 16, paddingTop: 4 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 },
  pickerIcon: { width: 40, height: 40, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  pickerName: { fontSize: 15, fontWeight: '600' },
  pickerSub: { fontSize: 12, marginTop: 2 },
  clearBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radii.pill },
  pickerBody: { marginTop: 6 },
  list: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 96 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingTop: 12, paddingBottom: 6 },
  sectionCount: { fontSize: 12, marginLeft: 6 },
  card: { marginBottom: 8 },
  cardInner: { flexDirection: 'row', padding: 12 },
  // 宽度按 `2026-11-08` 全串给足（68 会把年份裁掉，用户 2026-11-08 反馈「日期显示不全」）
  dateBox: { width: 92, borderRadius: radii.sm, paddingVertical: 8, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  dateText: { fontSize: 11, fontWeight: '700' },
  timeText: { fontSize: 12, marginTop: 2 },
  body: { flex: 1, minWidth: 0, marginLeft: 12 },
  title: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 4 },
  desc: { fontSize: 12, marginTop: 6, lineHeight: 18 },
  infoRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  infoText: { fontSize: 12, marginLeft: 6, flex: 1 },
  ticketRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  ticketText: { fontSize: 12, flex: 1, marginRight: 8 },
  ticketBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radii.pill },
  ticketBtnText: { fontSize: 12, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
