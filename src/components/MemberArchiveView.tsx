/**
 * 成员档案内容（唯一实现，两处共用）：
 *   ① 成员档案页（screens/ProfileScreen）—— 整页浏览；
 *   ② 房间消息头像 → 用户资料卡（FollowedRoomsScreen）—— 点偶像头像**就地**显示档案，
 *      不再"跳一个页面才能看到"（用户 2026-10-02 明确要求）。
 *
 * 为什么抽出来：档案的加载口径（star/archives + star/history）与字段兜底顺序很容易走偏，
 * 两处各写一遍必然出现"同一个成员在两个入口显示不一样"。这里连**渲染**一起收口，
 * 页面与资料卡只负责摆放头部（头像/名字）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { CenterSpinner } from './Loaders';
import { GlassSurface } from './GlassSurface';
import pocketApi from '../api/pocket48';
import { translate, useI18n } from '../i18n';
import { usePalette } from '../theme';
import { toMs } from '../utils/format';
import type { Member } from '../types';

export type MemberArchiveState = {
  data: any;
  history: any[];
  error: string;
};

/** 档案名（官方 starInfo.starName 优先，其次成员库 ownerName 去掉团体前缀） */
export function displayMemberName(member?: Member | null, starInfo?: any) {
  return starInfo?.starName || member?.ownerName?.split('-').pop() || member?.ownerName || translate('未选择成员');
}

/** 取首个非空值（0 / false 也算有效值） */
export function firstText(...values: any[]) {
  const value = values.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  return value === undefined || value === null || value === '' ? '-' : String(value);
}

function normalizeList(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.list)) return value.list;
  if (Array.isArray(value?.content)) return value.content;
  if (Array.isArray(value?.content?.list)) return value.content.list;
  return [];
}

function formatDate(time: any) {
  const d = new Date(toMs(Number(time)));
  if (isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function memberArchiveStarInfo(data: any) {
  return data?.starInfo || data?.star || data || {};
}

export function memberArchiveFanRanks(data: any) {
  return normalizeList(data?.fansRank || data?.rankList);
}

/**
 * 档案数据加载（唯一口径）：star/archives + star/history 并行，失败**不抛**而是转成
 * `error` 文案 —— 页面据此显示「在线档案暂不可用」并回退本地成员库资料。
 * 带请求序号防竞态：快速切换成员时丢弃慢响应。
 */
export function useMemberArchive(memberId?: string) {
  const [state, setState] = useState<MemberArchiveState>({ data: null, history: [], error: '' });
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const id = String(memberId ?? '').trim();

  const load = useCallback(async () => {
    const requestId = ++reqRef.current;
    const numeric = parseInt(id, 10);
    setState({ data: null, history: [], error: '' });
    if (!Number.isFinite(numeric)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [archiveRes, historyRes] = await Promise.all([
        pocketApi.getStarArchives(numeric).catch((e: any) => ({ __error: e?.message || String(e) })),
        pocketApi.getStarHistory(numeric).catch(() => null),
      ]);
      if (requestId !== reqRef.current) return; // 已切换成员，丢弃慢响应
      const data = archiveRes?.content || archiveRes?.data || archiveRes;
      const error = data?.__error ? String(data.__error) : '';
      setState({
        data: error ? null : data,
        history: [
          ...normalizeList(data?.history),
          ...normalizeList(historyRes?.content || historyRes?.data || historyRes),
        ],
        error,
      });
    } finally {
      if (requestId === reqRef.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, loading, reload: load };
}

/**
 * 档案内容（不含头像/名字头部 —— 那是各入口自己的事，用 `header` 插槽塞进第一张卡）。
 *
 * 自身**不带滚动容器**：两个入口都由外层负责滚动 ——
 *   成员档案页 = 整页 ScrollView；房间资料卡 = 卡片内容区 ScrollView（按钮行固定在卡底）。
 *
 * @param inset 卡片水平外边距（成员档案页 16；房间资料卡 0，因为资料卡自带 padding）
 */
export function MemberArchiveContent({
  member,
  data,
  error,
  history,
  loading,
  onRetry,
  header,
  inset = 16,
}: {
  member: Member;
  data: any;
  error: string;
  history: any[];
  loading: boolean;
  onRetry: () => void;
  header?: React.ReactNode;
  inset?: number;
}) {
  const palette = usePalette();
  const { t } = useI18n();
  const fanRanks = memberArchiveFanRanks(data);
  const raw = member as any;
  const cardStyle = [styles.card, { marginHorizontal: inset, backgroundColor: 'transparent', borderColor: palette.hairline }];

  const body = (
    <>
      <GlassSurface radius={20} role="card" style={cardStyle}>
        {header}
        {error ? (
          <View style={[styles.notice, { backgroundColor: palette.fill2, borderLeftColor: palette.warning }]}>
            <Text style={[styles.noticeTitle, { color: palette.tint }]}>{t('在线档案暂不可用')}</Text>
            <Text style={[styles.noticeText, { color: palette.labelSecondary }]}>{t('已显示本地成员库资料；需要口袋签名的排行和经历可能无法加载。')}</Text>
            <View style={styles.retryWrap}>
              <Button title={t('重试')} variant="filled" size="sm" onPress={onRetry} disabled={loading} loading={loading} />
            </View>
          </View>
        ) : null}

        <Text style={[styles.sectionTitle, { color: palette.tint }]}>{t('基本信息')}</Text>
        <View style={styles.infoGrid}>
          <InfoItem label={t('成员 ID')} value={firstText(member.id)} />
          <InfoItem label={t('拼音')} value={firstText(member.pinyin)} />
          {/* 状态分类（官方源优先）：在团/退团/毕业/暂休 */}
          {member.state && member.state !== 'unknown' ? (
            <InfoItem label={t('状态')} value={t({
              active: '在团', left: '退团', graduated: '毕业', paused: '暂休',
            }[member.state] || '未知')} />
          ) : null}
          {raw.birthday ? <InfoItem label={t('生日')} value={firstText(raw.birthday)} /> : null}
          {raw.birthplace ? <InfoItem label={t('出生地')} value={firstText(raw.birthplace)} /> : null}
          {raw.constellation ? <InfoItem label={t('星座')} value={firstText(raw.constellation)} /> : null}
          {raw.height ? <InfoItem label={t('身高')} value={`${raw.height} cm`} /> : null}
          {raw.bloodType ? <InfoItem label={t('血型')} value={t('{type}型', { type: raw.bloodType })} /> : null}
          {raw.hobbies ? <InfoItem label={t('爱好')} value={firstText(raw.hobbies)} /> : null}
          {raw.specialty ? <InfoItem label={t('特长')} value={firstText(raw.specialty)} /> : null}
        </View>

        <Text style={[styles.sectionTitle, { color: palette.tint }]}>{t('生涯历程')}</Text>
        <View style={styles.infoGrid}>
          {raw.periodName ? <InfoItem label={t('期数')} value={firstText(raw.periodName)} /> : null}
          {raw.rank ? <InfoItem label={t('最高排名')} value={firstText(raw.rank)} /> : null}
          {raw.jtime ? <InfoItem label={t('加入时间')} value={formatDate(raw.jtime)} /> : null}
          {raw.ptime ? <InfoItem label={t('升格时间')} value={formatDate(raw.ptime)} /> : null}
          {raw.gtime ? <InfoItem label={t('毕业时间')} value={formatDate(raw.gtime)} /> : null}
          {raw.qtime ? <InfoItem label={t('退团时间')} value={formatDate(raw.qtime)} /> : null}
        </View>

        <Text style={[styles.sectionTitle, { color: palette.tint }]}>{t('技术参数')}</Text>
        <View style={styles.infoGrid}>
          <InfoItem label={t('大房间')} value={firstText(member.channelId)} />
          <InfoItem label={t('服务器')} value={firstText(member.serverId)} />
          {member.yklzId ? <InfoItem label={t('小房间')} value={firstText(member.yklzId)} /> : null}
          {member.roomId ? <InfoItem label={t('房间ID')} value={firstText(member.roomId)} /> : null}
          {member.liveRoomId ? <InfoItem label={t('直播间')} value={firstText(member.liveRoomId)} /> : null}
          {raw.wbName ? <InfoItem label={t('微博')} value={firstText(raw.wbName)} /> : null}
          {raw.wbUid ? <InfoItem label={t('微博UID')} value={firstText(raw.wbUid)} /> : null}
        </View>

        {raw.note ? (
          <View style={[styles.noteBox, { backgroundColor: palette.tintSoft }]}>
            <Text style={[styles.noteLabel, { color: palette.tint }]}>{t('备注')}</Text>
            <Text style={[styles.noteText, { color: palette.labelSecondary }]}>{raw.note}</Text>
          </View>
        ) : null}

        {raw.fullPhoto1 ? (
          <View>
            <Text style={[styles.sectionTitle, { color: palette.tint }]}>{t('公式照')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {['fullPhoto1', 'fullPhoto2', 'fullPhoto3', 'fullPhoto4'].filter((k) => raw[k]).map((k) => (
                <Image key={k} source={{ uri: raw[k] }} style={[styles.photoItem, { backgroundColor: palette.fill2 }]} resizeMode="cover" />
              ))}
            </ScrollView>
          </View>
        ) : null}
      </GlassSurface>

      {fanRanks.length > 0 ? (
        <GlassSurface radius={20} role="card" style={cardStyle}>
          <Text style={[styles.sectionTitle, { color: palette.tint }]}>{t('粉丝排行')}</Text>
          {fanRanks.slice(0, 10).map((fan: any, index: number) => (
            <View key={`${fan.userId || fan.nickName || index}`} style={[styles.rankRow, { borderBottomColor: palette.innerStroke }]}>
              <Text style={[styles.rankNo, { color: palette.tint }]}>{index + 1}</Text>
              <Text style={[styles.rankName, { color: palette.label }]} numberOfLines={1}>
                {firstText(fan.nickName, fan.nickname, fan.userName)}
              </Text>
              <Text style={[styles.rankMeta, { color: palette.labelSecondary }]} numberOfLines={1}>{firstText(fan.userId, fan.level, fan.score)}</Text>
            </View>
          ))}
        </GlassSurface>
      ) : null}

      {history.length > 0 ? (
        <GlassSurface radius={20} role="card" style={cardStyle}>
          <Text style={[styles.sectionTitle, { color: palette.tint }]}>{t('重要经历')}</Text>
          {history.slice(0, 20).map((item: any, index: number) => (
            <View key={`${item.ctime || item.time || index}`} style={[styles.timelineRow, { borderBottomColor: palette.innerStroke }]}>
              <Text style={[styles.timelineTime, { color: palette.tint }]}>{formatDate(item.ctime || item.time)}</Text>
              <Text style={[styles.timelineText, { color: palette.label }]}>
                {firstText(item.content, item.title, item.eventName, item.desc)}
              </Text>
            </View>
          ))}
        </GlassSurface>
      ) : null}

      {loading ? <CenterSpinner /> : null}
    </>
  );

  return <>{body}</>;
}

function InfoItem({ label, value }: { label: string; value: string }) {
  const palette = usePalette();
  return (
    <View style={[styles.infoItem, { backgroundColor: palette.fill2 }]}>
      <Text style={[styles.infoLabel, { color: palette.labelTertiary }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: palette.label }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginVertical: 4, padding: 14, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth },
  notice: { padding: 12, borderRadius: 14, marginBottom: 14, borderLeftWidth: 3 },
  noticeTitle: { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  noticeText: { fontSize: 12, lineHeight: 18 },
  retryWrap: { alignSelf: 'flex-start', marginTop: 10 },
  sectionTitle: { fontSize: 15, fontWeight: '800', marginBottom: 10, marginTop: 14 },
  infoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  infoItem: { width: '48.5%', padding: 10, borderRadius: 14 },
  infoLabel: { fontSize: 11, marginBottom: 4 },
  infoValue: { fontSize: 13, fontWeight: '600' },
  noteBox: { marginTop: 14, padding: 12, borderRadius: 14 },
  noteLabel: { fontSize: 11, fontWeight: '700', marginBottom: 4 },
  noteText: { fontSize: 13, lineHeight: 20 },
  photoItem: { width: 120, height: 160, borderRadius: 14, marginRight: 8 },
  rankRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  rankNo: { width: 28, fontWeight: '800' },
  rankName: { flex: 1, fontSize: 14, fontWeight: '600' },
  rankMeta: { maxWidth: 96, fontSize: 12, textAlign: 'right' },
  timelineRow: { paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  timelineTime: { fontSize: 12, fontWeight: '700', marginBottom: 4 },
  timelineText: { fontSize: 14, lineHeight: 20 },
});
