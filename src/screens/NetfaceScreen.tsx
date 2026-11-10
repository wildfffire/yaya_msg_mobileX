/**
 * 现场互动（口袋「云握手」netface）· 用户 2026-11-09 要求
 *
 * 对齐桌面端 yk1z/yaya_msg：
 *   src/common/netface-api.mjs      → 接口（本页走 api/pocket48 的 getNetface* 系列）
 *   src/common/netface-model.js     → 场次合并/状态/排队规则（utils/netfaceRules）
 *   src/renderer/netface-feature.js → 页面结构（活动 → 场次卡片 → 预约/取消/排队/资格）
 *
 * ⚠️ 范围：本次只做「看活动 → 看场次 → 预约 / 取消 → 看排队 / 资格兑换 / 兑换记录」。
 * 握手视频通话本身需要 ZEGO RTC 原生 SDK（桌面端走 ZEGO Web SDK），移动端暂无该依赖，
 * 页面底部有明确说明；不要在这里伪造「入场」按钮（会白扣一次握手资格）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { PerfFlatList } from '../components/PerfFlatList';
import { GlassSurface } from '../components/GlassSurface';
import { FadeInView, ScalePressable } from '../components/Motion';
import { EmptyState, ErrorState } from '../components/StateViews';
import { CenterSpinner } from '../components/Loaders';
import { NetworkImage } from '../components/NetworkImage';
import TeamBadge from '../components/TeamBadge';
import { useSettingsStore, useUiStore } from '../store';
import pocketApi from '../api/pocket48';
import { errorMessage, normalizeUrl } from '../utils/data';
import { AVATAR_THUMB_WIDTH } from '../utils/imageThumb';
import {
  netfaceBalance,
  netfaceEvents,
  netfaceTickets,
  netfaceTimeText,
  type NetfaceEventItem,
  type NetfaceTicket,
} from '../utils/netfaceRules';
import { usePalette } from '../theme';
import { typography } from '../theme/typography';
import { useI18n } from '../i18n';

type Filter = 'all' | 'mine';

export default function NetfaceScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const showToast = useUiStore((state) => state.showToast);
  const token = useSettingsStore((state) => state.settings.p48Token);

  const [tickets, setTickets] = useState<NetfaceTicket[]>([]);
  const [ticketId, setTicketId] = useState('');
  const ticketIdRef = useRef('');
  ticketIdRef.current = ticketId;
  const [ticketName, setTicketName] = useState('');
  const [events, setEvents] = useState<NetfaceEventItem[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  /** 正在提交的场次（按钮转圈 + 防重复点） */
  const [busyId, setBusyId] = useState('');

  // 预约弹窗
  const [reserveTarget, setReserveTarget] = useState<NetfaceEventItem | null>(null);
  const [tpNumText, setTpNumText] = useState('1');
  // 兑换资格弹窗
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemKey, setRedeemKey] = useState('');
  const [redeemBusy, setRedeemBusy] = useState(false);
  // 兑换记录弹窗
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<any[]>([]);
  const [historyNext, setHistoryNext] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyHasMore, setHistoryHasMore] = useState(false);
  /** 滚动触底的并发护栏：state 更新是异步的，onScroll 64ms 一帧会重复触发翻页 */
  const historyBusyRef = useRef(false);

  const load = useCallback(async () => {
    if (!token) {
      setTickets([]);
      setEvents([]);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const catalog: any = await pocketApi.getNetfaceTickets();
      const list = netfaceTickets(catalog?.content ?? catalog?.data);
      setTickets(list);
      const preferred = ticketIdRef.current;
      const active = list.find((v) => v.ticketId === preferred) || list[0];
      if (!active) {
        setTicketId('');
        setTicketName('');
        setEvents([]);
        setBalance(null);
        return;
      }
      setTicketId(active.ticketId);
      const info: any = await pocketApi.getNetfaceInfo(active.ticketId);
      const content = info?.content ?? info?.data ?? {};
      setTicketName(String(content?.ticketName || active.ticketName || ''));
      let items = netfaceEvents(content);
      /** 排队人数/预计等待来自单独接口（batch/balancetime），失败不影响主列表 */
      const ids = items.filter((v) => !v.ordered).map((v) => v.eventId).slice(0, 100);
      if (ids.length) {
        try {
          const wait: any = await pocketApi.getNetfaceWait(ids);
          items = netfaceEvents({ ...content, eventIds: wait?.content ?? wait?.data ?? [] });
        } catch { /* 排队信息拿不到就显示「待更新」 */ }
      }
      setEvents(items);
      try {
        const bal: any = await pocketApi.getNetfaceBalance(active.ticketId);
        setBalance(netfaceBalance(bal?.content ?? bal?.data));
      } catch {
        setBalance(null);
      }
    } catch (err) {
      setError(errorMessage(err));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load, reloadKey]);

  const visibleEvents = useMemo(
    () => (filter === 'mine' ? events.filter((item) => item.ordered) : events),
    [events, filter],
  );

  const switchTicket = useCallback((id: string) => {
    if (id === ticketIdRef.current) return;
    setTicketId(id);
    setEvents([]);
    setLoading(true);
    setReloadKey((n) => n + 1);
  }, []);

  const confirmReserve = useCallback(async () => {
    const item = reserveTarget;
    if (!item) return;
    const num = Math.trunc(Number(tpNumText));
    if (!Number.isInteger(num) || num < 1 || num > 999) {
      showToast(t('请输入 1–999 的整数'));
      return;
    }
    setBusyId(item.eventId);
    try {
      await pocketApi.reserveNetface(item.eventId, num);
      setReserveTarget(null);
      showToast(t('预约成功'));
      setReloadKey((n) => n + 1);
    } catch (err) {
      showToast(t('操作失败：{msg}', { msg: errorMessage(err) }));
    } finally {
      setBusyId('');
    }
  }, [reserveTarget, showToast, t, tpNumText]);

  const cancelReserve = useCallback(async (item: NetfaceEventItem) => {
    setBusyId(item.eventId);
    try {
      await pocketApi.cancelNetface(item.eventId);
      showToast(t('已取消预约'));
      setReloadKey((n) => n + 1);
    } catch (err) {
      showToast(t('操作失败：{msg}', { msg: errorMessage(err) }));
    } finally {
      setBusyId('');
    }
  }, [showToast, t]);

  const submitRedeem = useCallback(async () => {
    const key = redeemKey.trim();
    if (!key) {
      showToast(t('请输入兑换码'));
      return;
    }
    if (!ticketId) return;
    setRedeemBusy(true);
    try {
      await pocketApi.activateNetfaceKey(ticketId, key);
      setRedeemOpen(false);
      setRedeemKey('');
      showToast(t('兑换成功'));
      setReloadKey((n) => n + 1);
    } catch (err) {
      showToast(t('操作失败：{msg}', { msg: errorMessage(err) }));
    } finally {
      setRedeemBusy(false);
    }
  }, [redeemKey, showToast, t, ticketId]);

  const loadHistory = useCallback(async (reset: boolean) => {
    if (!ticketId) return;
    if (historyBusyRef.current) return;
    if (!reset && !historyHasMore) return;
    historyBusyRef.current = true;
    setHistoryLoading(true);
    setHistoryError('');
    const cursor = reset ? 0 : historyNext;
    try {
      const res: any = await pocketApi.getNetfaceHistory(ticketId, cursor);
      const content = res?.content ?? res?.data ?? {};
      const records = Array.isArray(content?.data) ? content.data : [];
      const next = Number(content?.next || 0);
      setHistoryItems((prev) => (reset ? records : [...prev, ...records]));
      setHistoryNext(next > 0 ? next : 0);
      setHistoryHasMore(records.length > 0 && next > 0 && (!reset || next !== cursor));
    } catch (err) {
      setHistoryError(errorMessage(err));
    } finally {
      historyBusyRef.current = false;
      setHistoryLoading(false);
    }
  }, [historyHasMore, historyNext, ticketId]);

  const openHistory = useCallback(() => {
    setHistoryOpen(true);
    setHistoryItems([]);
    setHistoryNext(0);
    setHistoryHasMore(false);
    void loadHistory(true);
  }, [loadHistory]);

  const renderEvent = useCallback(({ item }: { item: NetfaceEventItem }) => {
    const avatar = normalizeUrl(item.starAvatar);
    const canReserve = item.status === 1 && !item.ordered;
    const busy = busyId === item.eventId;
    const secondary = item.ordered ? item.queueNumber || '—' : item.queueSize || '—';
    return (
      <GlassSurface radius={16} role="card" style={styles.card}>
        <View style={styles.cardInner}>
          <View style={styles.memberRow}>
            {avatar ? (
              <NetworkImage
                source={{ uri: avatar }}
                style={styles.avatar}
                thumbnail={AVATAR_THUMB_WIDTH}
                fallback
                fallbackIcon="account"
              />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: palette.fill2 }]}>
                <MaterialCommunityIcons name="account" size={20} color={palette.labelTertiary} />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[typography.subhead, { color: palette.label, fontWeight: '700' }]} numberOfLines={1}>
                {item.starName}
              </Text>
              <View style={styles.metaRow}>
                <TeamBadge team={item.teamName || item.groupName} fontSize={10} compact />
                <Text style={[styles.status, { color: item.ordered ? palette.tint : palette.labelTertiary }]} numberOfLines={1}>
                  {t(item.statusText)}
                </Text>
              </View>
            </View>
            {item.orderedCount ? (
              <Text style={[styles.orderCount, { color: palette.labelTertiary }]}>{item.orderedCount}</Text>
            ) : null}
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoCol}>
              <Text style={[styles.infoLabel, { color: palette.labelTertiary }]}>{t('预约时间')}</Text>
              <Text style={[styles.infoValue, { color: palette.label }]} numberOfLines={1}>
                {netfaceTimeText(item.queueStartTime) || t('待公布')}
              </Text>
            </View>
            <View style={styles.infoCol}>
              <Text style={[styles.infoLabel, { color: palette.labelTertiary }]}>{t('开始时间')}</Text>
              <Text style={[styles.infoValue, { color: palette.label }]} numberOfLines={1}>
                {netfaceTimeText(item.startTime) || t('待公布')}
              </Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoCol}>
              <Text style={[styles.infoLabel, { color: palette.labelTertiary }]}>{item.ordered ? t('排队号') : t('队列')}</Text>
              <Text style={[styles.infoValue, { color: palette.label }]} numberOfLines={1}>{secondary}</Text>
            </View>
            <View style={styles.infoCol}>
              <Text style={[styles.infoLabel, { color: palette.labelTertiary }]}>{t('预计等待')}</Text>
              <Text style={[styles.infoValue, { color: palette.label }]} numberOfLines={1}>{item.waitText}</Text>
            </View>
          </View>

          <View style={styles.actions}>
            {item.ordered && item.status === 2 ? (
              <ScalePressable
                style={[styles.btnGhost, { borderColor: palette.hairline, opacity: busy ? 0.6 : 1 }]}
                disabled={busy}
                onPress={() => void cancelReserve(item)}
              >
                {busy ? <ActivityIndicator size="small" color={palette.tint} /> : (
                  <Text style={{ color: palette.labelSecondary, fontSize: 12, fontWeight: '700' }}>{t('取消预约')}</Text>
                )}
              </ScalePressable>
            ) : (
              <ScalePressable
                style={[
                  styles.btnPrimary,
                  { backgroundColor: canReserve ? palette.tint : palette.fill2, opacity: busy ? 0.6 : 1 },
                ]}
                disabled={!canReserve || busy}
                onPress={() => { setReserveTarget(item); setTpNumText('1'); }}
              >
                {busy ? <ActivityIndicator size="small" color={canReserve ? palette.onTint : palette.labelTertiary} /> : (
                  <Text style={{ color: canReserve ? palette.onTint : palette.labelTertiary, fontSize: 12, fontWeight: '800' }}>
                    {item.ordered ? t('已预约') : t('预约')}
                  </Text>
                )}
              </ScalePressable>
            )}
          </View>
        </View>
      </GlassSurface>
    );
  }, [busyId, cancelReserve, palette, t]);

  const header = (
    <View>
      <ScreenHeader
        title={t('现场互动')}
        right={<HeaderAction label={t('刷新')} onPress={() => setReloadKey((n) => n + 1)} disabled={loading} loading={loading} />}
      />
      <FadeInView delay={60} duration={300}>
        {/* 活动切换：同一时间通常只有一个开放活动，多个时横向切 */}
        {tickets.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.ticketRow}>
            {tickets.map((item) => {
              const active = item.ticketId === ticketId;
              return (
                <ScalePressable
                  key={item.ticketId}
                  style={[
                    styles.ticketChip,
                    { backgroundColor: active ? palette.tint : palette.fill2, borderColor: palette.hairline },
                  ]}
                  onPress={() => switchTicket(item.ticketId)}
                >
                  <Text
                    style={{ color: active ? palette.onTint : palette.labelSecondary, fontSize: 12, fontWeight: '700' }}
                    numberOfLines={1}
                  >
                    {item.ticketName}
                  </Text>
                </ScalePressable>
              );
            })}
          </ScrollView>
        ) : null}

        <GlassSurface radius={18} role="card" style={styles.summary}>
          <View style={styles.summaryInner}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.summaryLabel, { color: palette.labelTertiary }]}>{t('当前活动')}</Text>
              <Text style={[typography.subhead, { color: palette.label, fontWeight: '800' }]} numberOfLines={1}>
                {ticketName || t('暂无开放活动')}
              </Text>
              <View style={styles.balanceRow}>
                <Text style={[styles.summaryLabel, { color: palette.labelTertiary }]}>{t('我的握手资格')}</Text>
                <Text style={[styles.balanceValue, { color: palette.tint }]}>
                  {balance === null ? '—' : balance}
                </Text>
                <Text style={[styles.summaryLabel, { color: palette.labelTertiary }]}>{t('次')}</Text>
              </View>
            </View>
            <View style={styles.summaryBtns}>
              <ScalePressable
                style={[styles.smallBtn, { backgroundColor: palette.tint, opacity: ticketId ? 1 : 0.5 }]}
                disabled={!ticketId}
                onPress={() => setRedeemOpen(true)}
              >
                <Text style={{ color: palette.onTint, fontSize: 12, fontWeight: '800' }}>{t('兑换资格')}</Text>
              </ScalePressable>
              <ScalePressable
                style={[styles.smallBtn, { backgroundColor: palette.fill2, opacity: ticketId ? 1 : 0.5 }]}
                disabled={!ticketId}
                onPress={openHistory}
              >
                <Text style={{ color: palette.tint, fontSize: 12, fontWeight: '800' }}>{t('兑换记录')}</Text>
              </ScalePressable>
            </View>
          </View>
        </GlassSurface>

        {/* 全部场次 / 我的预约 */}
        <View style={styles.filterRow}>
          {(['all', 'mine'] as Filter[]).map((key) => {
            const active = filter === key;
            const count = key === 'mine' ? events.filter((v) => v.ordered).length : events.length;
            return (
              <ScalePressable
                key={key}
                style={[
                  styles.filterChip,
                  { backgroundColor: active ? palette.tint : palette.fill2, borderColor: palette.hairline },
                ]}
                onPress={() => setFilter(key)}
              >
                <Text style={{ color: active ? palette.onTint : palette.labelSecondary, fontSize: 12, fontWeight: '700' }}>
                  {key === 'all' ? t('全部场次') : t('我的预约')}{count ? ` ${count}` : ''}
                </Text>
              </ScalePressable>
            );
          })}
        </View>
      </FadeInView>
    </View>
  );

  const emptyNode = !token ? (
    <EmptyState icon="account-key-outline" title={t('需要登录口袋账号')} hint={t('现场互动需要登录后查看，请先在账号设置登录口袋48')} />
  ) : error ? (
    <ErrorState title={t('加载失败')} hint={error} onAction={() => setReloadKey((n) => n + 1)} />
  ) : loading ? (
    <View style={styles.center}><CenterSpinner /></View>
  ) : (
    <EmptyState
      icon="account-voice"
      title={filter === 'mine' ? t('还没有预约') : t('暂无云握手场次')}
      hint={filter === 'mine' ? t('预约成功后会显示在这里') : t('活动开放后，可在这里选择成员并预约。')}
    />
  );

  return (
    <View style={styles.container}>
      {visibleEvents.length === 0 ? (
        <View style={{ flex: 1 }}>
          {header}
          <FadeInView delay={120} duration={300} style={{ flex: 1 }}>{emptyNode}</FadeInView>
        </View>
      ) : (
        <PerfFlatList
          data={visibleEvents}
          keyExtractor={(row) => row.eventId}
          renderItem={renderEvent}
          ListHeaderComponent={header}
          ListFooterComponent={(
            <Text style={[styles.footNote, { color: palette.labelTertiary }]}>
              {t('握手视频通话需在桌面端进行（移动端暂未接入通话 SDK）')}
            </Text>
          )}
          contentContainerStyle={styles.list}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          refreshControl={(
            <RefreshControl
              refreshing={loading}
              onRefresh={() => setReloadKey((n) => n + 1)}
              tintColor={palette.tint}
              colors={[palette.tint]}
            />
          )}
        />
      )}

      {/* 预约：握手资格份数 */}
      <Modal visible={!!reserveTarget} transparent animationType="fade" onRequestClose={() => setReserveTarget(null)}>
        <View style={styles.overlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setReserveTarget(null)} />
          <View style={[styles.modalCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
            <Text style={[styles.modalTitle, { color: palette.label }]}>{t('预约')} · {reserveTarget?.starName || ''}</Text>
            <Text style={[styles.modalHint, { color: palette.labelSecondary }]}>{t('请输入本次预约使用的握手资格数量')}</Text>
            <TextInput
              style={[styles.modalInput, { color: palette.label, borderColor: palette.hairline, backgroundColor: palette.fill2 }]}
              value={tpNumText}
              onChangeText={(v) => setTpNumText(v.replace(/[^0-9]/g, '').slice(0, 3))}
              keyboardType="number-pad"
              placeholder="1"
              placeholderTextColor={palette.labelTertiary}
              maxLength={3}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtnGhost, { borderColor: palette.hairline }]}
                onPress={() => setReserveTarget(null)}
                activeOpacity={0.85}
              >
                <Text style={{ color: palette.labelSecondary, fontSize: 13, fontWeight: '700' }}>{t('取消')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: palette.tint, opacity: busyId ? 0.6 : 1 }]}
                onPress={() => void confirmReserve()}
                activeOpacity={0.85}
              >
                <Text style={{ color: palette.onTint, fontSize: 13, fontWeight: '800' }}>{t('确认预约')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 兑换资格 */}
      <Modal visible={redeemOpen} transparent animationType="fade" onRequestClose={() => setRedeemOpen(false)}>
        <View style={styles.overlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setRedeemOpen(false)} />
          <View style={[styles.modalCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
            <Text style={[styles.modalTitle, { color: palette.label }]}>{t('兑换资格')}</Text>
            <Text style={[styles.modalHint, { color: palette.labelSecondary }]}>{t('输入官方发放的握手资格兑换码')}</Text>
            <TextInput
              style={[styles.modalInput, { color: palette.label, borderColor: palette.hairline, backgroundColor: palette.fill2 }]}
              value={redeemKey}
              onChangeText={setRedeemKey}
              placeholder={t('请输入兑换码')}
              placeholderTextColor={palette.labelTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={256}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtnGhost, { borderColor: palette.hairline }]}
                onPress={() => setRedeemOpen(false)}
                activeOpacity={0.85}
              >
                <Text style={{ color: palette.labelSecondary, fontSize: 13, fontWeight: '700' }}>{t('取消')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: palette.tint, opacity: redeemBusy ? 0.6 : 1 }]}
                onPress={() => void submitRedeem()}
                activeOpacity={0.85}
                disabled={redeemBusy}
              >
                {redeemBusy ? <ActivityIndicator size="small" color={palette.onTint} /> : (
                  <Text style={{ color: palette.onTint, fontSize: 13, fontWeight: '800' }}>{t('确认兑换')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 兑换记录 */}
      <Modal visible={historyOpen} transparent animationType="fade" onRequestClose={() => setHistoryOpen(false)}>
        <View style={styles.overlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setHistoryOpen(false)} />
          <View style={[styles.modalCard, styles.modalTall, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
            <Text style={[styles.modalTitle, { color: palette.label }]}>{t('兑换记录')}</Text>
            <ScrollView
              style={styles.historyList}
              showsVerticalScrollIndicator={false}
              onScroll={({ nativeEvent }) => {
                const distance = nativeEvent.contentSize.height - nativeEvent.contentOffset.y - nativeEvent.layoutMeasurement.height;
                if (distance <= 48) void loadHistory(false);
              }}
              scrollEventThrottle={64}
            >
              {historyItems.length ? historyItems.map((item, index) => (
                <View key={`${item?.id || item?.createTime || index}`} style={[styles.historyRow, { borderBottomColor: palette.hairline }]}>
                  <Text style={[styles.historyMain, { color: palette.label }]}>
                    {`${Number(item?.tpNum ?? item?.num ?? 0) || 0} ${t('次')}`}
                  </Text>
                  <Text style={[styles.historyTime, { color: palette.labelTertiary }]} numberOfLines={1}>
                    {netfaceTimeText(item?.activeTime || item?.actTime || item?.createTime)
                      || String(item?.ticketName || '')}
                  </Text>
                </View>
              )) : historyLoading ? null : (
                <Text style={[styles.historyEmpty, { color: palette.labelTertiary }]}>{t('暂无兑换记录')}</Text>
              )}
              {historyLoading ? <ActivityIndicator style={{ marginVertical: 12 }} color={palette.tint} /> : null}
              {historyError ? (
                <Text style={[styles.historyEmpty, { color: palette.danger }]}>{t('加载失败')}：{historyError}</Text>
              ) : null}
            </ScrollView>
            <TouchableOpacity
              style={[styles.modalBtn, { backgroundColor: palette.tint, marginTop: 10 }]}
              onPress={() => setHistoryOpen(false)}
              activeOpacity={0.85}
            >
              <Text style={{ color: palette.onTint, fontSize: 13, fontWeight: '800' }}>{t('关闭')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { paddingHorizontal: 12, paddingBottom: 28 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  ticketRow: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  ticketChip: {
    maxWidth: 220, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },

  summary: { marginHorizontal: 12, marginBottom: 10 },
  summaryInner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 },
  summaryLabel: { fontSize: 11 },
  balanceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 6 },
  balanceValue: { fontSize: 20, fontWeight: '800' },
  summaryBtns: { gap: 8 },
  smallBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },

  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },

  card: { marginBottom: 10 },
  cardInner: { padding: 13 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  status: { fontSize: 11, fontWeight: '700' },
  orderCount: { fontSize: 11, fontWeight: '700' },
  infoRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  infoCol: { flex: 1, minWidth: 0 },
  infoLabel: { fontSize: 10, marginBottom: 2 },
  infoValue: { fontSize: 12, fontWeight: '700' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  btnPrimary: { minWidth: 92, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  btnGhost: { minWidth: 92, height: 32, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  footNote: { fontSize: 10, lineHeight: 16, textAlign: 'center', paddingHorizontal: 20, marginTop: 6 },

  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', padding: 20 },
  modalCard: { width: '100%', maxWidth: 420, borderRadius: 18, borderWidth: 1, padding: 16 },
  modalTall: { maxHeight: '72%' },
  modalTitle: { fontSize: 16, fontWeight: '800' },
  modalHint: { fontSize: 12, lineHeight: 18, marginTop: 6 },
  modalInput: {
    marginTop: 12, height: 42, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12, fontSize: 14,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
  modalBtn: { minWidth: 88, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  modalBtnGhost: { minWidth: 80, height: 36, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },

  historyList: { maxHeight: 320, marginTop: 10 },
  historyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  historyMain: { fontSize: 13, fontWeight: '700' },
  historyTime: { fontSize: 11, flexShrink: 1 },
  historyEmpty: { fontSize: 12, textAlign: 'center', paddingVertical: 20 },
});
