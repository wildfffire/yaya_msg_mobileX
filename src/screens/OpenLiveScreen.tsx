import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  ActivityIndicator,
  BackHandler,
  Image,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { MediaPlaybackHost, type PlayMedia } from '../player';
import { pickOpenLiveStreamUrl } from './watch/resolvePlayUrl';
import { Member } from '../types';
import MemberPicker from '../components/MemberPicker';
import { useSettingsStore, useUiStore, useMemberStore } from '../store';
import TeamBadge from '../components/TeamBadge';
import { FadeInView, ScalePressable } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { Skeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/StateViews';
import pocketApi from '../api/pocket48';
import { useNavigation } from '@react-navigation/native';
import { translate, useI18n } from '../i18n';
import { enqueueDownload } from '../services/downloads';
import {
  fetchUpcomingPerformances,
  type PerformanceShow,
} from '../services/performanceSchedule';
import { errorMessage, normalizeUrl, parseMaybeJson, pickText, unwrapList } from '../utils/data';
import { buildMemberLookup, pickMemberUserId, resolveTeam, type MemberLookup } from '../utils/memberMatch';
import { formatTimestamp } from '../utils/format';
import { usePalette } from '../theme';
import { GlassSurface } from '../components/GlassSurface';
import PerformanceStrip from '../components/PerformanceStrip';
import { UserProfileSheet, type UserProfileTarget } from '../components/UserProfileSheet';

interface OpenLiveItem {
  key: string;
  liveId: string;
  pageId: string;
  title: string;
  nickname: string;
  /** 成员数字 id（能拿到就存）：队伍反查与「写进历史后仍能补出队伍」的稳定依据 */
  userId: string;
  cover: string;
  msgTime: number;
  raw: any;
}

/** 成员榜一行（`getOpenLiveParticipants` → 归一化 + 成员库补全） */
interface ParticipantRow {
  key: string;
  name: string;
  avatar: string;
  team: string;
  /** 贡献值（接口 `hot`，可能为空） */
  hot: string;
  /** 排名（接口 `rank`，非法值按 null 处理，排最后） */
  rank: number | null;
  userId: string;
  memberId: string;
}

function parseExtInfo(item: any) {
  const raw = item?.extInfo || item?.ext || item?.body || item?.bodys || item?.msgContent || '';
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  const fixed = String(raw).replace(/:\s*([0-9]{16,})/g, ':"$1"');
  return parseMaybeJson(fixed) || {};
}

function normalizeCover(value: string) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `https://source.48.cn${url.startsWith('/') ? '' : '/'}${url}`;
}

function messageTime(item: any) {
  const time = Number(item?.msgTime || item?.ctime || item?.time || 0);
  return Number.isFinite(time) ? time : 0;
}

function normalizeOpenLiveMessage(item: any, index: number): OpenLiveItem | null {
  const info = parseExtInfo(item);
  const liveId = String(info.liveId || info.live_id || info.videoId || '').trim();
  const pageId = String(info.id || info.openLivePageId || liveId || '').trim();
  if (!liveId && !pageId) return null;
  const title = String(info.title || info.liveTitle || item?.title || translate('公演记录'));
  const nickname = String(info.user?.nickname || info.nickname || info.memberName || info.ownerName || '');
  // 成员数字 id：extInfo 里的 user.userId / userId（拿不到就留空，仍可按昵称归一化反查）
  const userId = String(pickMemberUserId(info) || pickMemberUserId(item) || '');
  const msgTime = messageTime(item);
  const msgId = String(item?.msgidClient || item?.msgId || item?.messageId || item?.id || '');
  return {
    key: msgId || `${liveId || pageId}-${msgTime}-${index}`,
    liveId: liveId || pageId,
    pageId: pageId || liveId,
    title,
    nickname,
    userId,
    cover: normalizeCover(String(info.coverUrl || info.coverPath || info.picPath || '')),
    msgTime,
    raw: item,
  };
}

function normalizeOpenLiveList(res: any): OpenLiveItem[] {
  const source = res?.content ?? res?.data ?? res;
  let list = Array.isArray(source?.message) ? source.message
    : Array.isArray(source?.messageList) ? source.messageList
    : unwrapList(res, [
      'content.message',
      'content.messageList',
      'content.list',
      'data.message',
      'data.messageList',
      'message',
      'messageList',
      'list',
    ]);
  return list
    .map((item: any, index: number) => normalizeOpenLiveMessage(item, index))
    .filter(Boolean) as OpenLiveItem[];
}

function nextTimeFrom(res: any) {
  const value = Number(pickText(res, ['content.nextTime', 'data.nextTime', 'nextTime']));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function mergeOpenLive(prev: OpenLiveItem[], next: OpenLiveItem[]) {
  const seen = new Set(prev.map((item) => item.key || item.liveId));
  const merged = [...prev];
  next.forEach((item) => {
    const key = item.key || item.liveId;
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
}

// 公演地址抽取（高清优先）已收口到 screens/watch/resolvePlayUrl.pickOpenLiveStreamUrl：
// 公演页、历史/稍后再看的公演回放共用同一套口径（以前两处各写一份，可能一边高清一边标清）。

function shortMemberName(member?: Member | null) {
  return String(member?.ownerName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/, '');
}

export default function OpenLiveScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const showToast = useUiStore((state) => state.showToast);
  const [member, setMember] = useState<Member | null>(null);
  /**
   * 成员索引（**与写进播放历史的那条链路同一口径**：`utils/memberMatch`）。
   * 以前这里是「昵称字符串精确相等」的 Map，而列表卡片又用 `|| member?.team`（选中成员）兜底 ——
   * 于是卡片永远有队伍、写入历史的 meta.team 却常常是空串（用户反馈的历史页没徽章的来源之一）。
   */
  const allMembers = useMemberStore((s) => s.members);
  const memberLookup: MemberLookup = useMemo(() => buildMemberLookup(allMembers), [allMembers]);
  /** 条目 → 队伍（先 userId、后归一化昵称；当前选中成员作为最后兜底） */
  const teamOfItem = useCallback(
    (item: OpenLiveItem) => resolveTeam(
      memberLookup,
      { userId: item.userId, name: item.nickname },
      '',
    ) || String(member?.team || ''),
    [memberLookup, member],
  );
  const [items, setItems] = useState<OpenLiveItem[]>([]);
  const [query, setQuery] = useState('');
  const [nextTime, setNextTime] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [listError, setListError] = useState('');
  /**
   * 播放中的公演回放：带 liveId 以便「历史 / 稍后再看」能记住来源并重新解析地址，
   * 另带成员昵称与队伍 —— 历史/稍后再看的列表卡片要显示「队伍徽章 + 成员名」。
   */
  const [playing, setPlaying] = useState<{ url: string; title: string; liveId: string; owner: string; team: string; ownerId: string; isLive?: boolean } | null>(null);
  /** 成员榜（公演直播/回放的参与成员） */
  const [membersVisible, setMembersVisible] = useState(false);
  const [memberRows, setMemberRows] = useState<ParticipantRow[]>([]);
  const [memberStatus, setMemberStatus] = useState('');
  const [memberLoading, setMemberLoading] = useState(false);
  const [profileTarget, setProfileTarget] = useState<UserProfileTarget | null>(null);
  const memberReqRef = useRef(0);
  const [upcoming, setUpcoming] = useState<PerformanceShow[]>([]);
  const loadingRef = useRef(false);

  // 播放器生命周期已由统一 PlayerScreen/FullscreenManager 管理（横屏/竖屏/PiP/返回键）

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!playing) return false;
      setPlaying(null);
      return true;
    });
    return () => subscription.remove();
  }, [playing]);

  /**
   * 即将开演的剧场公演（与「公演记录」不同：那份是已发生的回放，这份是未来场次）。
   * 数据源与成员无关，所以进页面就拉一次，失败静默 —— 预告拉不到不应该影响公演记录列表。
   */
  useEffect(() => {
    let alive = true;
    fetchUpcomingPerformances()
      .then((list) => { if (alive) setUpcoming(list); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const reloadUpcoming = useCallback(() => {
    fetchUpcomingPerformances(true)
      .then(setUpcoming)
      .catch(() => {});
  }, []);

  const navigation = useNavigation<any>();

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return items;
    return items.filter((item) => `${item.title} ${item.nickname} ${item.liveId}`.toLowerCase().includes(text));
  }, [items, query]);

  const loadMemberShows = async (nextMember: Member, append = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setMember(nextMember);
    if (!append) {
      setItems([]);
      setNextTime(0);
      setHasMore(false);
    }
    setStatus('');
    setListError('');
    try {
      const cursor = append ? nextTime : 0;
      const res = await pocketApi.getOpenLive({ memberId: nextMember.id, nextTime: cursor });
      const nextItems = normalizeOpenLiveList(res);
      const nextCursor = nextTimeFrom(res);
      const merged = append ? mergeOpenLive(items, nextItems) : nextItems;
      setItems((prev) => (append ? mergeOpenLive(prev, nextItems) : nextItems));
      setNextTime(nextCursor);
      setHasMore(nextItems.length > 0 && !!nextCursor && nextCursor !== cursor);
      const text = merged.length ? t('共 {count} 场', { count: merged.length }) : t('未找到相关记录');
      setStatus(text);
      showToast(text);
    } catch (error) {
      const text = t('加载失败：{error}', { error: errorMessage(error) });
      setListError(errorMessage(error));
      setStatus(text);
      showToast(text);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const loadMore = () => {
    if (!member || loading || loadingRef.current || !hasMore || !nextTime) return;
    loadMemberShows(member, true);
  };

  const resolveStream = async (item: OpenLiveItem) => {
    const detail = await pocketApi.getOpenLiveOne(item.liveId);
    // 公演地址抽取唯一实现（高清优先），历史/稍后再看同一口径
    const url = pickOpenLiveStreamUrl(detail);
    if (!url) throw new Error(t('没有解析到播放地址'));
    return url;
  };

  const playItem = async (item: OpenLiveItem) => {
    setStatus(t('正在解析播放地址...'));
    try {
      const url = await resolveStream(item);
      // 统一走 RN 播放器（PlayerScreen 含小窗按钮 → MiniPlayer），
      // 原先 rtmp/.flv 分支走原生 LivePlayerActivity 完全脱离 RN，找不到小窗按钮
      // （用户反馈「成员直播小窗在软件内点没用」的真因）。RN 端用同内核 LiveExoView
      // 渲染 rtmp/flv，与 native 播放器画面/音频一致，应用内小窗从此可达。
      setPlaying({
        url,
        title: item.title,
        liveId: String(item.liveId || ''),
        owner: String(item.nickname || ''),
        team: teamOfItem(item),
        ownerId: String(item.userId || ''),
      });
      setStatus(t('播放地址已就绪'));
    } catch (error) {
      const text = t('播放失败：{error}', { error: errorMessage(error) });
      setStatus(text);
      showToast(text);
    }
  };

  /**
   * 公演**直播**（应用内信号）就地起播 —— 给「即将开演 / 公演直播」卡条用。
   *
   * 为什么在应用内播而不是跳 B 站（用户 2026-10-04 要求）：柏欣妤生日会这类场次
   * 口袋侧本身就是直播（Seine status=2），getOpenLiveOne 直接给 rtmp 流
   *（cyflv.48.cn 标清/高清），根本不必绕到 B 站；此前卡片一律跳 B 站，
   * 遇到只开了应用内信号的场次就「看不到」。
   *
   * 返回 false 仅表示「这场没有可用 ID」（组件回退 B 站）；解析失败只提示不跳转
   *（status=2 说明口袋侧确实在直播，失败通常是网络/瞬时错误）。
   */
  const playShowLive = useCallback((show: PerformanceShow) => {
    const liveId = String(show.liveId || '');
    if (!liveId) return false;
    setStatus(t('正在解析播放地址...'));
    (async () => {
      try {
        const detail = await pocketApi.getOpenLiveOne(liveId);
        const url = pickOpenLiveStreamUrl(detail);
        if (!url) throw new Error(t('没有解析到播放地址'));
        setPlaying({
          url,
          title: show.title,
          liveId,
          owner: '',
          team: show.teamLabel || '',
          ownerId: '',
          isLive: true,
        });
        setStatus(t('播放地址已就绪'));
      } catch (error) {
        const text = t('播放失败：{error}', { error: errorMessage(error) });
        setStatus(text);
        showToast(text);
      }
    })();
    return true;
  }, [showToast, t]);

  /**
   * 成员榜：公演直播 / 回放的参与成员（`live.48.cn` 首页的成员热力榜）。
   * 数据层与桌面端同源（`getOpenLiveParticipants`），这里只做归一化 + 成员库补全队伍/头像，
   * 并按 `rank` 升序（无 rank 的排最后，显示「—」）。
   */
  const loadParticipants = useCallback(async (liveId: string, title: string, dateHint = '') => {
    const reqId = ++memberReqRef.current;
    setMemberLoading(true);
    setMemberRows([]);
    setMemberStatus(t('正在读取成员榜...'));
    try {
      const res: any = await pocketApi.getOpenLiveParticipants(liveId, title, dateHint);
      if (reqId !== memberReqRef.current) return;
      const list = unwrapList(res, [
        'content.participants', 'content.data', 'content.list',
        'participants', 'data', 'list',
      ]);
      const rows: ParticipantRow[] = [];
      const seen = new Set<string>();
      list.forEach((raw: any, index: number) => {
        const name = String(raw?.name || raw?.memberName || raw?.nickname || raw?.starName || '').trim();
        const userId = pickMemberUserId(raw) || String(raw?.memberId || raw?.userId || raw?.ownerId || '').trim();
        const memberId = String(raw?.memberId || raw?.userId || raw?.ownerId || '').trim();
        const member = userId
          ? allMembers.find((m) => String(m.id) === userId || String((m as any).userId || '') === userId)
          : undefined;
        const avatar = normalizeUrl(raw?.avatar || raw?.avatarUrl || raw?.headImg || (member as any)?.avatar || '');
        const hotRaw = raw?.hot;
        const hot = hotRaw === '' || hotRaw === undefined || hotRaw === null ? '' : String(hotRaw);
        const rankNum = Number(raw?.rank);
        const rank = Number.isInteger(rankNum) && rankNum > 0 ? rankNum : null;
        const team = resolveTeam(memberLookup, { userId, name }, '') || String((member as any)?.team || '');
        if (!name && !avatar) return;
        const key = `${userId || name || 'member'}-${index}`;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({
          key,
          name: name || t('未知成员'),
          avatar,
          team,
          hot,
          rank,
          userId,
          memberId: memberId || userId,
        });
      });
      rows.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
      setMemberRows(rows);
      setMemberStatus(rows.length ? t('共 {count} 位成员', { count: rows.length }) : t('未获取到成员榜'));
    } catch (error) {
      if (reqId !== memberReqRef.current) return;
      setMemberRows([]);
      setMemberStatus(t('成员榜加载失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      if (reqId === memberReqRef.current) setMemberLoading(false);
    }
  }, [allMembers, memberLookup, t]);

  const downloadItem = async (item: OpenLiveItem) => {
    try {
      const url = await resolveStream(item);
      await enqueueDownload({ url, type: 'replay', name: item.title });
      showToast(t('已加入下载管理'));
    } catch (error) {
      showToast(t('下载失败：{error}', { error: errorMessage(error) }));
    }
  };

  if (playing) {
    /**
     * 「外部打开」按钮（用户 2026-10-02：「总是有一个外部打开，点也点不了，还在最顶上占住」）。
     *
     * 根因：它此前是 PlayerScreen 的 children —— children 渲染在画面层之上、PlayerChrome 之下，
     * 而 PlayerChrome 的**屏幕点按层**（`Pressable style={absoluteFill}`，负责单击唤出控制条 /
     * 双击暂停）是在 children **之后**渲染的，等于整个盖在按钮上，把点击全部吃掉（"点也点不了"）；
     * 同时它钉在容器最顶部、不随控制条自动隐藏（"在最顶上占住"）。
     *
     * 现改走 `extraActions`（进右上「…」播放器功能面板）：不再遮挡画面，且真正可点。
     */
    /** 外部打开：地址取宿主解析结果（页面不再自己解析，可能没有 playing.url） */
    const externalAction = (url: string) => ({
      key: 'external',
      icon: 'open-in-new',
      label: t('外部打开'),
      onPress: () => {
        const target = String(url || '');
        if (!target) return;
        Linking.openURL(target).catch(() => showToast(t('这个链接无法直接打开。')));
      },
    });
    /** 成员榜入口（用户 2026-11-08）：只在公演直播/回放里出现，普通成员直播没有这份数据 */
    const membersAction = {
      key: 'participants',
      icon: 'account-group',
      label: t('成员榜'),
      onPress: () => {
        if (!playing.liveId) {
          showToast(t('该场次没有 liveId，无法读取成员榜'));
          return;
        }
        setMembersVisible(true);
        void loadParticipants(playing.liveId, playing.title);
      },
    };
    /**
     * 公演直播/回放 → 统一播放宿主（与直播页/房间/历史同一个播放器）。
     * 地址已经按「高清优先」解析好 → 宿主快速起播；没有地址则由宿主按 liveId 重新解析。
     * 公演没有弹幕/贡献榜数据源：features 关弹幕 + showRank={false}。
     */
    const playMedia: PlayMedia = {
      kind: 'openlive',
      url: playing.url,
      liveId: playing.liveId,
      isLive: !!playing.isLive,
      title: playing.title,
      owner: playing.owner,
      team: playing.team,
      ownerId: playing.ownerId,
      raw: playing,
    };
    return (
      <View style={styles.playerPage}>
        <MediaPlaybackHost
          media={playMedia}
          onClose={() => setPlaying(null)}
          /* 公演没有弹幕源 / 贡献榜数据源 */
          features={{ danmaku: false }}
          showRank={false}
          /* 已经在公演播放页，成员名点击不再跳成员房间 */
          roomLink={false}
          extraActions={(ctx) => [externalAction(ctx.resolved?.url || ''), membersAction]}
        />
        {membersVisible ? (
          <Modal visible transparent animationType="fade" onRequestClose={() => setMembersVisible(false)}>
            <View style={styles.membersMask}>
              <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setMembersVisible(false)} />
              <View style={[styles.membersSheet, { backgroundColor: palette.surface, borderColor: palette.innerStroke }]}>
                <View style={styles.membersHead}>
                  <Text style={[styles.membersTitle, { color: palette.label }]}>{t('成员榜')}</Text>
                  <TouchableOpacity onPress={() => setMembersVisible(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <MaterialCommunityIcons name="close" size={18} color={palette.labelSecondary} />
                  </TouchableOpacity>
                </View>
                <Text style={[styles.membersStatus, { color: palette.labelTertiary }]}>{memberStatus}</Text>
                {memberLoading ? (
                  <View style={styles.membersCenter}><ActivityIndicator color={palette.tint} /></View>
                ) : (
                  <ScrollView style={styles.membersScroll} contentContainerStyle={styles.membersList}>
                    {memberRows.map((row) => (
                      <ScalePressable
                        key={row.key}
                        style={[styles.memberChip, { backgroundColor: palette.fill3 }]}
                        onPress={() => setProfileTarget({ nick: row.name, avatar: row.avatar, userId: row.userId, memberId: row.memberId })}
                        pressedScale={0.97}
                      >
                        <View style={[styles.memberRank, { backgroundColor: row.rank && row.rank <= 3 ? palette.tint : palette.fill2 }]}>
                          <Text style={[styles.memberRankText, { color: row.rank && row.rank <= 3 ? palette.onTint : palette.labelSecondary }]}>
                            {row.rank ? String(row.rank) : '—'}
                          </Text>
                        </View>
                        {row.avatar ? (
                          <Image source={{ uri: row.avatar }} style={styles.memberAvatar} />
                        ) : (
                          <View style={[styles.memberAvatar, { backgroundColor: palette.fill2 }]} />
                        )}
                        <View style={{ flex: 1, minWidth: 0, marginLeft: 10 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={[styles.memberName, { color: palette.label }]} numberOfLines={1}>{row.name}</Text>
                            {row.team ? <View style={{ marginLeft: 6 }}><TeamBadge team={row.team} fontSize={9} /></View> : null}
                          </View>
                          {row.hot ? (
                            <Text style={[styles.memberScore, { color: palette.labelTertiary }]} numberOfLines={1}>
                              {t('贡献值')} {row.hot}
                            </Text>
                          ) : null}
                        </View>
                        <MaterialCommunityIcons name="chevron-right" size={18} color={palette.labelTertiary} />
                      </ScalePressable>
                    ))}
                  </ScrollView>
                )}
              </View>
            </View>
          </Modal>
        ) : null}
        <UserProfileSheet
          visible={!!profileTarget}
          target={profileTarget}
          onClose={() => setProfileTarget(null)}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('公演记录')} right={
        <HeaderAction
          label={t('刷新')}
          // 不再要求先选成员：刷新同时拉「即将开演」，而预告与成员无关
          disabled={loading}
          onPress={() => {
            reloadUpcoming();
            if (member) loadMemberShows(member);
          }}
        />
      } />

      <FadeInView delay={80} duration={300} style={{ flex: 1 }}>
        <View style={styles.controls}>
          <MemberPicker selectedMember={member} onSelect={(next) => loadMemberShows(next, false)} placeholder={t('搜索成员并打开公演记录...')} />
          <View style={[styles.searchBar, { backgroundColor: palette.fill2 }]}>
            <MaterialCommunityIcons name="magnify" size={16} color={palette.labelTertiary} />
            <TextInput
              style={[styles.searchInput, { color: palette.label }]}
              placeholder={t('筛选标题、成员、liveId...')}
              placeholderTextColor={palette.labelTertiary}
              value={query}
              onChangeText={setQuery}
              returnKeyType="search"
            />
            {query ? (
              <ScalePressable onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.7}>
                <MaterialCommunityIcons name="close-circle" size={16} color={palette.labelTertiary} />
              </ScalePressable>
            ) : null}
          </View>
          {member && status ? (
            <Text style={[styles.status, { color: palette.labelSecondary }]}>{loading && !items.length ? '' : status}</Text>
          ) : null}
        </View>

        <PerfFlatList
          data={filtered}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.list}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          onEndReached={loadMore}
          /* 即将开演：横向排开的剧场场次预告（与首页「公演直播」区块共用 PerformanceStrip）。
             放在列表头而不是固定区 —— 用户往下翻历史记录时它应该跟着滚走，否则永久占掉半屏。
             没有未来场次时组件自身返回 null（不显示空状态，避免在「公演记录」里塞一个空盒子）。 */
          ListHeaderComponent={<PerformanceStrip shows={upcoming} showCount onPlayLive={playShowLive} />}
          onEndReachedThreshold={0.35}
          ListEmptyComponent={
            loading ? (
              <View style={styles.skeletonWrap}>
                {Array.from({ length: 4 }).map((_, i) => (
                  <GlassSurface radius={20} role="card" key={i} style={[styles.skeletonCard, { backgroundColor: 'transparent', borderColor: palette.hairline }]}>
                    <Skeleton width={56} height={56} radius={12} />
                    <View style={{ marginLeft: 12, flex: 1 }}>
                      <Skeleton width="70%" height={13} />
                      <Skeleton width="40%" height={10} style={{ marginTop: 8 }} />
                      <Skeleton width="50%" height={10} style={{ marginTop: 8 }} />
                    </View>
                  </GlassSurface>
                ))}
              </View>
            ) : listError ? (
              <ErrorState title={t('加载失败')} hint={listError} onAction={() => member && loadMemberShows(member)} />
            ) : (
              <EmptyState
                icon="playlist-play"
                title={member ? t('暂无公演记录') : t('请搜索选择成员查看公演记录')}
              />
            )
          }
          ListFooterComponent={items.length ? (
            <Text style={[styles.footerText, { color: palette.labelTertiary }]}>
              {loading ? '' : hasMore ? t('上滑加载更多') : t('没有更多了')}
            </Text>
          ) : null}
          renderItem={({ item, index }) => (
            <FadeInView delay={index < 12 ? 60 + index * 25 : 0} duration={360}>
              <ScalePressable
                activeOpacity={0.85}
                pressedScale={0.97}
                onPress={() => playItem(item)}
                onLongPress={() => downloadItem(item)}
              >
              {/* 列表卡不用玻璃：每卡一个 BlurView 滚动会逐帧重算模糊（用户反馈卡顿）——半透明实底卡 */}
              <View
                style={[styles.card, { backgroundColor: palette.surfaceGlassStrong, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, overflow: 'hidden' }]}
              >
                {item.cover ? (
                  <Image source={{ uri: item.cover }} style={[styles.cover, { backgroundColor: palette.fill2 }]} resizeMode="cover" />
                ) : (
                  <View style={[styles.cover, styles.coverPlaceholder, { backgroundColor: palette.tintSoft }]}>
                    <MaterialCommunityIcons name="play" size={24} color={palette.tint} />
                  </View>
                )}
                <View style={styles.cardBody}>
                  <Text style={[styles.cardTitle, { color: palette.label }]} numberOfLines={2}>{item.title}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 }}>
                    <TeamBadge
                      team={teamOfItem(item)}
                      fontSize={11}
                    />
                    <Text style={[styles.meta, { color: palette.labelSecondary }]} numberOfLines={1}>{item.nickname || shortMemberName(member) || t('成员')}</Text>
                  </View>
                  <View style={styles.cardFoot}>
                    <Text style={[styles.time, { color: palette.labelSecondary }]}>{formatTimestamp(item.msgTime)}</Text>
                    <View style={[styles.badge, { backgroundColor: palette.tintSoft }]}>
                      <MaterialCommunityIcons name="play-circle-outline" size={12} color={palette.tint} />
                      <Text style={[styles.badgeText, { color: palette.tint }]}>{t('可看')}</Text>
                    </View>
                  </View>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={palette.labelTertiary} style={styles.chevron} />
              </View>
              </ScalePressable>
            </FadeInView>
          )}
        />
      </FadeInView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  controls: { paddingHorizontal: 14, gap: 8, marginBottom: 8 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    borderRadius: 14,
    paddingHorizontal: 12,
    gap: 6,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0, margin: 0 },
  status: { fontSize: 12, lineHeight: 18 },
  list: { padding: 14, paddingBottom: 112 },
  card: { flexDirection: 'row', alignItems: 'center', padding: 10, marginVertical: 4, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth },
  cover: { width: 56, height: 56, borderRadius: 14 },
  coverPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1, minWidth: 0, paddingLeft: 12 },
  cardTitle: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  meta: { fontSize: 12, marginTop: 3 },
  cardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  time: { fontSize: 11 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
  chevron: { marginLeft: 6 },
  footerText: { marginVertical: 14, textAlign: 'center', fontSize: 12, fontWeight: '700' },
  playerPage: { flex: 1, backgroundColor: '#000000' },
  player: { flex: 1, backgroundColor: '#000000' },
  playerErrorWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  playerErrorText: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  playerRetryBtn: { marginTop: 16, paddingHorizontal: 24, paddingVertical: 9, borderRadius: 18 },
  playerRetryText: { fontSize: 13, fontWeight: '800' },
  skeletonWrap: { padding: 4 },
  skeletonCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    marginVertical: 4,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  // --- 成员榜 ---
  membersMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  membersSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 22,
  },
  membersHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  membersTitle: { fontSize: 16, fontWeight: '700' },
  membersStatus: { fontSize: 12, marginTop: 6 },
  membersCenter: { height: 120, alignItems: 'center', justifyContent: 'center' },
  membersScroll: { marginTop: 8, maxHeight: 380 },
  membersList: { paddingBottom: 8 },
  memberChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    marginBottom: 6,
  },
  memberRank: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  memberRankText: { fontSize: 11, fontWeight: '700' },
  memberAvatar: { width: 34, height: 34, borderRadius: 17 },
  memberName: { fontSize: 14, fontWeight: '600', maxWidth: 150 },
  memberScore: { fontSize: 11, marginTop: 2 },
});
