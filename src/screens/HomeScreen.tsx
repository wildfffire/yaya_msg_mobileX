/**
 * HomeScreen · 内容仪表盘 v2.6 布局重做
 * - 问候区（大标题 + 副标题，区块标题统一「4×18 tint 竖条 + headline」）
 * - 未登录提示卡
 * - 正在直播：一行四张小卡网格（可视高度 ≤ 屏高 1/3）
 * - 快捷入口 4 格胶囊
 * - 最近播放续播卡
 * - 工具 chips 横向滚动
 * - 首屏加载 Skeleton 占位
 * 业务逻辑 / API / 数据流 / 路由 / i18n 原文一律不动，仅重组布局结构。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { CompositeNavigationProp } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { StackNavigationProp } from '@react-navigation/stack';
import { useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import { RootStackParamList, TabParamList } from '../navigation/types';
import { useSettingsStore } from '../store';
import { useMusicPlayerStore } from '../store/musicPlayerStore';
import { MusicEngine } from '../services/musicPlayer';
import {
  fetchUpcomingPerformances,
  type PerformanceShow,
} from '../services/performanceSchedule';
import { usePalette, spacing, usePageBackground } from '../theme';
import { makeShadows } from '../theme/shadows';
import { typography } from '../theme/typography';
import ScreenHeader from '../components/ScreenHeader';
import { GlassCard } from '../components/GlassCard';
import { Pill } from '../components/Pill';
import { Button } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import { FadeInView, ScalePressable } from '../components/Motion';
import { NetworkImage } from '../components/NetworkImage';
import { useI18n } from '../i18n';
import { pocketApi } from '../api/pocket48';
import { normalizeUrl, pickText, unwrapList } from '../utils/data';
import { AVATAR_THUMB_WIDTH } from '../utils/imageThumb';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { GlassSurface } from '../components/GlassSurface';
import PerformanceStrip from '../components/PerformanceStrip';
import TeamBadge from '../components/TeamBadge';
import { useMemberStore } from '../store';

type HomeNavProp = CompositeNavigationProp<
  BottomTabNavigationProp<TabParamList, 'Home'>,
  StackNavigationProp<RootStackParamList>
>;

interface NavItem {
  title: string;
  desc: string;
  route: string;
  params?: any;
  icon: string;
}

/** MaterialCommunityIcons 图标（统一视觉语言，替代 emoji） */
const ICONS: Record<string, string> = {
  LiveRoom: 'video', Vod: 'play-box-multiple', RoomRadio: 'radio', Bilibili: 'broadcast',
  Rooms: 'message-text', PrivateMessages: 'email-outline', RoomAlbum: 'image-multiple', OpenLive: 'theater',
  FlipSend: 'comment-question-outline', FlipHistory: 'history', Analysis: 'chart-bar',
  Profile: 'account', MemberDynamic: 'star-circle', MemberWeibo: 'web', Trip: 'briefcase',
  VideoLibrary: 'play-box', MusicLibrary: 'music-note', AudioPrograms: 'podcast',
  MeleeRank: 'trophy', Database: 'database', Login: 'key-variant', Download: 'download', Invoice: 'file-document-outline', Settings: 'cog',
  Community: 'forum', OnMic: 'microphone',
};

const QUICK: NavItem[] = [
  { title: '直播', desc: '', route: 'Media', params: { mode: 'live' }, icon: ICONS.LiveRoom },
  { title: '回放', desc: '', route: 'Media', params: { mode: 'vod' }, icon: ICONS.Vod },
  { title: '音乐', desc: '', route: 'MusicLibraryScreen', icon: ICONS.MusicLibrary },
  { title: '私信', desc: '', route: 'PrivateMessagesScreen', icon: ICONS.PrivateMessages },
];

/** 工具：单行横向 chips（翻牌/统计/下载/账号/设置…） */
const TOOL_CHIPS: NavItem[] = [
  { title: '翻牌', desc: '', route: 'FlipScreen', icon: ICONS.FlipSend },
  { title: '上麦', desc: '', route: 'OnMicScreen', icon: ICONS.OnMic },
  { title: '统计', desc: '', route: 'AnalysisScreen', icon: ICONS.Analysis },
  { title: '下载', desc: '', route: 'DownloadScreen', icon: ICONS.Download },
  { title: '账号', desc: '', route: 'LoginScreen', icon: ICONS.Login },
  { title: '设置', desc: '', route: 'Settings', icon: ICONS.Settings },
  { title: '公演', desc: '', route: 'OpenLiveScreen', icon: ICONS.OpenLive },
  { title: 'B站', desc: '', route: 'BilibiliLiveScreen', icon: ICONS.Bilibili },
  { title: '鸡腿榜', desc: '', route: 'MeleeRankScreen', icon: ICONS.MeleeRank },
  { title: '数据库', desc: '', route: 'DatabaseScreen', icon: ICONS.Database },
  { title: '发票', desc: '', route: 'InvoiceScreen', icon: ICONS.Invoice },
];

interface LiveCardItem {
  liveId: string;
  title: string;
  nickname: string;
  cover: string;
  /** 主播用户 id（用于关注/置顶优先排序；接口字段多态） */
  userId: string;
}

/** 成员直播排序：已关注+置顶 → 已关注未置顶 → 其他（保持原顺序） */
function sortLivesByPreference(list: LiveCardItem[], followedIds: Set<string>, pinnedIds: string[]) {
  if (!followedIds.size && !pinnedIds.length) return list;
  const pinSet = new Set(pinnedIds);
  const rank = (it: LiveCardItem) => {
    if (followedIds.has(it.userId)) return pinSet.has(it.userId) ? 0 : 1;
    return 2;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** 首页直播列表缓存（stale-while-revalidate：冷启动秒显上次内容） */
const LIVES_CACHE_KEY = 'yaya_home_lives_cache_v1';

/** 「最近播放」卡被 ❌ 关掉的曲目：持久化，重启后也不该再冒出来 */
const RECENT_HIDDEN_KEY = 'yaya_home_recent_hidden_v1';

/** Promise 竞速超时：返回 null 表示超时（不 abort，仅放弃等待） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function normalizeLiveList(res: any): LiveCardItem[] {
  const source = unwrapList(res, [
    'content.liveList', 'content.list', 'content.data', 'content.records',
    'data.liveList', 'liveList', 'list', 'data',
  ]);
  return source
    .map((raw: any, index: number) => ({
      liveId: String(pickText(raw, ['liveId', 'id', 'live_id', 'roomId'], String(index))),
      title: pickText(raw, ['title', 'liveTitle', 'liveRoomTitle', 'roomName', 'subject'], ''),
      nickname: pickText(raw, ['nickname', 'nickName', 'userInfo.nickname', 'userInfo.nickName', 'ownerName'], ''),
      cover: normalizeUrl(pickText(raw, ['liveCover', 'coverPath', 'cover', 'coverUrl', 'picPath', 'picturePath', 'imageUrl', 'poster', 'thumb', 'userInfo.avatar'], '')),
      userId: String(pickText(raw, ['userId', 'ownerId', 'memberId', 'hostId', 'account', 'userInfo.userId', 'userInfo.id', 'owner.userId', 'memberInfo.userId', 'user.userId'], '')),
    }))
    .filter((item: LiveCardItem) => item.title);
  // ⚠️ 这里不能再 slice(0,8) 截断：截断发生在「关注优先」排序**之前**，接口原始顺序里
  // 排在后面的关注成员会被直接丢掉（实测只显示 2 个关注成员的根因）。
  // 展示数量由 gridLives 按「屏高 1/3」自限；排序（关注/置顶优先）在 fetchLives 里做。
}

/** 区块标题：4×18 tint 竖条 + headline 标题 + 可选「全部 ›」 */
function SectionHeader({ title, action_label, onAction }: { title: string; action_label?: string; onAction?: () => void }) {
  const palette = usePalette();
  return (
    <View style={styles.sectionHead}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={[styles.sectionDot, { backgroundColor: palette.tint }]} />
        <Text style={[typography.headline, { color: palette.label, marginLeft: 8 }]}>{title}</Text>
      </View>
      {action_label && onAction ? (
        <ScalePressable onPress={onAction} pressedScale={0.94}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[typography.footnote, { color: palette.tint, fontWeight: '700' }]}>{action_label}</Text>
            <MaterialCommunityIcons name="chevron-right" color={palette.tint} size={16} />
          </View>
        </ScalePressable>
      ) : null}
    </View>
  );
}

/** 首页成员直播小卡（一行四张）：方形封面 + 渐变 + 标题/昵称上浮 + 直播中角标 */
function HomeLiveCell({ item, size, onPress, team }: { item: LiveCardItem; size: number; onPress: () => void; team?: string }) {
  const { t } = useI18n();
  const palette = usePalette();
  const [broken, setBroken] = useState(false);
  const retriedRef = useRef(false);
  // 封面失败 3s 后自动重试一次（封面 URL 偶发 403/超时），再次失败才保持兜底
  const handleCoverError = () => {
    if (!retriedRef.current) {
      retriedRef.current = true;
      setBroken(true);
      setTimeout(() => setBroken(false), 3000);
    } else {
      setBroken(true);
    }
  };
  return (
    <ScalePressable onPress={onPress} pressedScale={0.95} style={{ width: size }}>
      <View
        style={[
          styles.homeLiveCell,
          // ⚠️ 必须显式给正方形尺寸：封面 height:'100%' 挂在无高度父级上会塌掉
          //（上一版漏了这里 → 首页卡片不是方格。与直播页格子同一做法：size = 宽 = 高）
          { width: size, height: size, backgroundColor: palette.fill3, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth },
        ]}
      >
        {!broken && item.cover ? (
          <NetworkImage
            source={{ uri: item.cover }}
            style={styles.homeLiveCellCover}
            resizeMode="cover"
            fallback={false}
            thumbnail={300}
            onError={handleCoverError}
          />
        ) : (
          <View style={styles.homeLiveCellFallback}>
            <MaterialCommunityIcons name="video" color={palette.labelTertiary} size={22} />
          </View>
        )}
        {/* 底部平滑渐变（顶部透明 → 底部 0.72 黑）：保证浅色封面下白字可读 */}
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.72)']}
          style={styles.homeLiveCellShade}
        />
        <View style={[styles.liveBadge, styles.homeLiveCellBadge]}>
          <Text style={styles.liveBadgeText}>{t('直播中')}</Text>
        </View>
        <View style={styles.homeLiveCellInfo}>
          <Text style={styles.homeLiveCellTitle} numberOfLines={1}>{item.title}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            {team ? <TeamBadge team={team} fontSize={8} /> : null}
            <Text style={styles.homeLiveCellNick} numberOfLines={1}>{item.nickname}</Text>
          </View>
        </View>
      </View>
    </ScalePressable>
  );
}

export default function HomeScreen() {
  const navigation = useNavigation<HomeNavProp>();
  const settings = useSettingsStore((state) => state.settings);
  const palette = usePalette();
  const shadows = makeShadows(palette.name === 'dark');
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const token = settings.p48Token;
  // 屏幕宽度驱动快捷入口像素宽度：横竖屏切换（如 B 站直播自动横屏后返回）时立即重算，
  // 避免 flexBasis 百分比在旋转后残留横屏宽度（按钮被拉长不恢复）
  const { width: winW, height: winH } = useWindowDimensions();
  const quickCellW = (winW - spacing.md * 2 - 24) / 4;

  const [lives, setLives] = useState<LiveCardItem[]>([]);
  /** 成员库（userId → Member）：小卡上的队伍应援色标注用 */
  const allMembers = useMemberStore((s) => s.members);
  const homeMemberById = useMemo(() => {
    const map = new Map<string, any>();
    for (const m of allMembers) map.set(String(m.id), m);
    return map;
  }, [allMembers]);
  const liveTeamOf = useCallback(
    (live: LiveCardItem) => homeMemberById.get(String(live.userId || ''))?.team || '',
    [homeMemberById],
  );
  const [livesOk, setLivesOk] = useState(false);
  const [livesError, setLivesError] = useState('');
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // 一次性清理孤儿缓存键：旧「公演直播 B站开播检测」机制已删，残留数据永不再读
  useEffect(() => { AsyncStorage.removeItem('yaya_home_gongyan_cache_v1').catch(() => {}); }, []);
  const livesRetryRef = useRef(0);
  /** 最新成员直播列表快照（供失败分支判断"当前是否已有可展示数据"，避免空壳响应误清列表） */
  const livesRef = useRef<LiveCardItem[]>([]);
  useEffect(() => { livesRef.current = lives; }, [lives]);
  const fetchedRef = useRef(false);

  /**
   * 成员直播小卡网格（一行四张，与「直播」页一致）：
   * ⚠️ 硬约束 —— 整个成员直播区块的可视高度不得超过屏高的 1/3（用户要求）。
   * 标题行 + 区块留白约占 52dp，剩余高度决定显示几行；放不下的去「直播」页看（右上「全部」）。
   */
  const LIVE_COLS = 4;
  const LIVE_CELL_GAP = 6;
  const liveCellW = (winW - spacing.md * 2 - LIVE_CELL_GAP * (LIVE_COLS - 1)) / LIVE_COLS;
  const liveGridAvailH = winH / 3 - 52;
  const liveRowH = liveCellW + LIVE_CELL_GAP;
  const liveRows = Math.max(1, Math.floor((liveGridAvailH + LIVE_CELL_GAP) / liveRowH));
  const gridLives = lives.slice(0, liveRows * LIVE_COLS);

  /**
   * 公演排期（即将 + 进行中）——「公演直播」区块改版后不再自己检测 B站开播：
   * 与公演记录页共用同一条排期数据 + 同一个横滑卡组件（PerformanceStrip），
   * 到点/进行中由组件内 60s 心跳翻牌，点击行为（未开演提示 / 进 B站直播）也完全一致。
   * 回前台补拉一次（服务端 10 分钟缓存，非强制），失败保留旧数据。
   */
  const [gongyanShows, setGongyanShows] = useState<PerformanceShow[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetchUpcomingPerformances()
      .then((list) => { if (alive) setGongyanShows(list); })
      .catch(() => { if (alive) setGongyanShows([]); });
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      fetchUpcomingPerformances()
        .then((list) => { if (alive) setGongyanShows(list); })
        .catch(() => {});
    });
    return () => { alive = false; sub.remove(); };
  }, []);

  // 成员直播排序偏好：已关注（getFollowedIds）+ 置顶（yaya_pinned_rooms）优先
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  useEffect(() => {
    AsyncStorage.getItem('yaya_pinned_rooms')
      .then((v) => { try { const a = JSON.parse(v || '[]'); if (Array.isArray(a)) setPinnedIds(a.map(String)); } catch { /* ignore */ } })
      .catch(() => {});
    if (!token) return;
    pocketApi.getFollowedIds()
      .then((res: any) => {
        const ids = unwrapList(res, ['content.data', 'content', 'data', 'list']).map(String);
        setFollowedIds(new Set(ids));
      })
      .catch(() => {});
  }, [token]);

  const fetchLives = useCallback(() => {
    // 秒显上次缓存（stale-while-revalidate）：冷启动立即有内容，后台刷新
    AsyncStorage.getItem(LIVES_CACHE_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const cached = JSON.parse(raw);
          if (Array.isArray(cached) && cached.length && !fetchedRef.current) {
            setLives(sortLivesByPreference(cached, followedIds, pinnedIds));
            setLivesOk(true);
          }
        } catch { /* ignore */ }
      })
      .catch(() => {});
    withTimeout(
      // size:100 —— 默认页只有 15 条，在播成员多时会漏掉排在后面的关注成员
      pocketApi.getLiveList({ groupId: 0, liveType: 0, next: 0, record: false, size: 100 }),
      10000,
    )
      .then((res: any) => {
        if (!res) throw new Error('timeout');
        // 空壳防护：官方接口偶发返回 success/200 但 content 无 liveList 字段（限流/风控/异常），
        // 此时 normalizeLiveList 会解出空数组 → 误把"有直播"显示成"暂无成员直播"。
        // 判定规则：结构里确实没有 liveList 数组 = 视为请求异常（保留旧数据走 catch），
        // 只有结构完整且 liveList 真为空（此时无人开播）才落空态。
        const rawList = (res?.content ?? res?.data ?? res)?.liveList;
        if (!Array.isArray(rawList)) throw new Error('live list empty shell');
        const list = sortLivesByPreference(normalizeLiveList(res), followedIds, pinnedIds);
        if (list.length) {
          setLives(list);
          setLivesOk(true);
          setLivesError('');
          livesRetryRef.current = 0;
          AsyncStorage.setItem(LIVES_CACHE_KEY, JSON.stringify(list)).catch(() => {});
        } else if (livesRef.current.length === 0) {
          // 结构完整但确实无人开播：仅在本地本就无数据时落空态；
          // 已有旧数据时保留旧列表（直播可能刚下播/接口瞬时空，等下一轮轮询纠正）
          setLives([]);
          setLivesOk(true);
          setLivesError('');
          livesRetryRef.current = 0;
        }
      })
      .catch((e: any) => {
        // 有缓存/已有列表时网络失败不打断展示（保留内容，仅静默）；
        // 无任何数据时：记错误态 + 5s 后自动重试（最多 3 次，网络抖动自愈，不必等手动点重试）。
        // ⚠️ 判断依据是"当前无可展示数据"，不是 fetchedRef（后者首屏已置 true，
        // 用它会让首屏失败永不进入错误态/重试，只剩 60s 轮询兜底 → 首页整段空白）。
        if (livesRef.current.length === 0) {
          setLivesError(e?.message || String(e));
          if (livesRetryRef.current < 3) {
            livesRetryRef.current += 1;
            setTimeout(() => {
              if (!mountedRef.current) return;
              if (AppState.currentState === 'active') fetchLives();
            }, 5000);
          }
        }
      });
  }, [followedIds, pinnedIds]);

  // 关注/置顶数据到达后：已有列表立即按新偏好重排（不重新请求，幂等）
  useEffect(() => {
    setLives((prev) => (prev.length ? sortLivesByPreference(prev, followedIds, pinnedIds) : prev));
  }, [followedIds, pinnedIds]);

  // 首屏拉取（fetchedRef 防重复）
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchLives();
  }, [fetchLives]);

  // 成员直播 60s 轮询 + 回前台立即刷新：避免「启动时网络差失败后永久骨架/错误态，只能手动重试」
  useEffect(() => {
    const id = setInterval(() => {
      if (AppState.currentState === 'active') fetchLives();
    }, 60 * 1000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetchLives();
    });
    return () => { clearInterval(id); sub.remove(); };
  }, [fetchLives]);

  // 原子化订阅：queue 引用仅在队列变化时更新，position 高频写入不触发首页重渲染
  const musicQueue = useMusicPlayerStore((s) => s.queue);
  const musicIndex = useMusicPlayerStore((s) => s.currentIndex);
  const musicPlaybackState = useMusicPlayerStore((s) => s.playbackState);
  const currentTrack = musicQueue[musicIndex] || null;

  const handleNav = useCallback((item: NavItem) => {
    if (item.params) (navigation as any).navigate(item.route, item.params);
    else (navigation as any).navigate(item.route);
  }, [navigation]);

  /**
   * 进音乐功能（最近播放卡面/播放中胶囊）：只导航进音乐库，不触发播放——
   *  - 外部正在播 → 保持原声连续（不再二次 resume：重复解析+seekTo 会造成"暂停一下再加载"的中断感）
   *  - 外部暂停/停止 → 保持暂停态进入，不自动开播（用户要求：没在播时进音乐功能不得自动续播）
   */
  const openMusicLibrary = useCallback(() => {
    handleNav({ title: '', desc: '', route: 'MusicLibraryScreen', icon: '' });
  }, [handleNav]);

  /**
   * 继续播放（仅显式点击胶囊时）：从记忆进度续播（position→seekTarget，resume 保留进度）。
   * 播放中/加载中点胶囊只进音乐页（避免重启播放链路）。
   */
  const handleResumeMusic = useCallback(() => {
    const s = useMusicPlayerStore.getState();
    if (!s.queue[s.currentIndex]) return;
    if (s.playbackState === 'playing' || s.playbackState === 'loading') {
      openMusicLibrary();
      return;
    }
    MusicEngine.resume();
    openMusicLibrary();
  }, [openMusicLibrary]);

  /** 关闭音乐：清播放上下文（queue 保留以便再播），idle → 停 Exo 服务与系统媒体通知 */
  const handleStopMusic = useCallback(() => {
    const s = useMusicPlayerStore.getState();
    if (!s.queue.length || s.playbackState === 'idle') return;
    useMusicPlayerStore.setState({
      url: '',
      playbackState: 'idle',
      position: 0,
      duration: 0,
      seekTarget: 0,
      lyrics: [],
    });
  }, []);

  /**
   * 最近播放卡：被 ❌ 关掉的曲目（持久化）。
   *
   * 用户反馈「点 ❌ 只停了播放，卡片还留在首页」——原来 ❌ 只在播放/暂停时出现、
   * 且只调 `handleStopMusic()`（清播放上下文），卡片因为 `currentTrack` 还在而继续显示。
   * 现在的语义：**关闭 = 停播 + 收起卡片，并且重启也不回来**（按曲目记，播放另一首时才再出现，
   * 这样「最近播放」仍然有用）。若要整个区块从首页彻底去掉，另行告知。
   */
  const [hiddenRecentId, setHiddenRecentId] = useState('');
  useEffect(() => {
    AsyncStorage.getItem(RECENT_HIDDEN_KEY)
      .then((v) => { if (v) setHiddenRecentId(v); })
      .catch(() => {});
  }, []);
  const currentTrackKey = String(currentTrack?.musicId || currentTrack?.id || currentTrack?.title || '');
  const dismissRecent = useCallback(() => {
    if (currentTrackKey) {
      setHiddenRecentId(currentTrackKey);
      AsyncStorage.setItem(RECENT_HIDDEN_KEY, currentTrackKey).catch(() => {});
    }
    handleStopMusic();
  }, [currentTrackKey, handleStopMusic]);

  const hour = new Date().getHours();
  const greeting =
    hour < 5 ? t('夜深了') : hour < 11 ? t('早上好') : hour < 14 ? t('中午好') : hour < 18 ? t('下午好') : t('晚上好');

  const quick = QUICK.map((i) => ({ ...i, title: t(i.title) }));
  const toolChips = TOOL_CHIPS.map((i) => ({ ...i, title: t(i.title) }));

  const trackTitle = currentTrack?.title || '';
  const trackArtist = currentTrack?.artist || currentTrack?.joinMemberNames || '';
  // F3 修复：续播卡随播放状态显示「播放中/加载中/继续播放」，R2 曲目 URL 异步解析时用户有反馈
  const resumeLabel = musicPlaybackState === 'playing'
    ? t('播放中')
    : musicPlaybackState === 'loading'
      ? t('加载中')
      : t('继续播放');

  const openLive = useCallback((item: LiveCardItem) => {
    (navigation as any).navigate('Media', {
      mode: 'live',
      playLiveId: item.liveId,
      playTitle: item.title,
      playCover: item.cover,
      playNonce: Date.now(),
    });
  }, [navigation]);

  return (
    <View style={[styles.outer, { backgroundColor: usePageBackground() }]}>
      {/* 顶栏与全站统一：大标题 24/800 左对齐、无返回键（tab 根页） */}
      <ScreenHeader title={t('牙牙消息 X')} hideBack />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: 4,
          // 底部滚动空间：让 footer 可滚动到悬浮 dock 上方完全可见
          paddingBottom: 92 + insets.bottom,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* 问候区：一行问候 */}
        <View style={{ paddingHorizontal: spacing.md }}>
          {/* 问候：随手机当前时间变化（v2.7 字号缩小） */}
          <Text style={[typography.footnote, { color: palette.labelSecondary, marginBottom: spacing.md }]}>
            {greeting}
          </Text>

          {!token ? (
            <ScalePressable style={{ marginBottom: spacing.xl }} onPress={() => handleNav({ title: '', desc: '', route: 'LoginScreen', icon: '' })} pressedScale={0.98}>
              <GlassCard strong padding={14} radius={20} style={{ borderColor: palette.danger }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={[styles.loginBadge, { backgroundColor: palette.tintSoft }]}>
                    <MaterialCommunityIcons name="key-variant" color={palette.tint} size={20} />
                  </View>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={[typography.headline, { color: palette.label }]}>{t('未登录口袋账号')}</Text>
                    <Text style={[typography.footnote, { color: palette.labelSecondary, marginTop: 3, lineHeight: 18 }]}>
                      {t('消息、私信、翻牌需要登录；点此粘贴 token')}
                    </Text>
                  </View>
                  <MaterialCommunityIcons name="chevron-right" color={palette.labelTertiary} size={20} />
                </View>
              </GlassCard>
            </ScalePressable>
          ) : null}
        </View>

        {/* 正在直播：一行四张小卡网格（可视高度 ≤ 屏高 1/3） */}
        <View style={styles.sectionOuter}>
          <SectionHeader
            title={t('成员直播')}
            action_label={t('全部')}
            onAction={() => handleNav({ title: '', desc: '', route: 'Media', icon: '' })}
          />

          {!livesOk && !livesError ? null : livesError && !livesOk ? (
            <GlassSurface
              radius={20}
              role="card"
              style={[styles.liveStateCard, { backgroundColor: 'transparent', borderColor: palette.hairline }]}
            >
              <MaterialCommunityIcons name="wifi-off" size={20} color={palette.labelTertiary} />
              <Text style={[styles.liveStateText, { color: palette.labelSecondary }]} numberOfLines={2}>
                {t('直播列表加载失败')}
              </Text>
              <Button title={t('重试')} variant="tinted" size="sm" onPress={fetchLives} />
            </GlassSurface>
          ) : livesOk && lives.length === 0 ? (
            <GlassSurface
              radius={20}
              role="card"
              style={[styles.liveStateCard, { backgroundColor: 'transparent', borderColor: palette.hairline }]}
            >
              <MaterialCommunityIcons name="video-off" size={20} color={palette.labelTertiary} />
              <Text style={[styles.liveStateText, { color: palette.labelSecondary }]}>{t('此时段暂无成员直播')}</Text>
            </GlassSurface>
          ) : livesOk ? (
            <FadeInView delay={0} duration={320}>
              {/* 一行四张小卡网格：整块可视高度已被 liveRows 预算限制在屏高 1/3 以内 */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: LIVE_CELL_GAP }}>
                {gridLives.map((live) => (
                  <HomeLiveCell
                    key={live.liveId}
                    item={live}
                    size={liveCellW}
                    team={liveTeamOf(live)}
                    onPress={() => openLive(live)}
                  />
                ))}
              </View>
            </FadeInView>
          ) : null}
        </View>

        {/* 公演直播：与公演记录页共用的「即将开演」横滑卡（即将 + 进行中），入口在公演记录页 */}
        <View style={styles.sectionOuter}>
          <SectionHeader
            title={t('公演直播')}
            action_label={t('全部')}
            onAction={() => (navigation as any).navigate('OpenLiveScreen')}
          />
          {gongyanShows === null ? null : gongyanShows.length ? (
            /* 负 margin 抵消 sectionOuter 的水平内边距 → 卡片贴边横滑（与「工具」条同一手法），
               组件内部补 paddingLeft 保证首卡不顶到屏幕边 */
            <PerformanceStrip
              shows={gongyanShows}
              showHead={false}
              style={{ marginHorizontal: -spacing.md }}
              contentContainerStyle={{ paddingLeft: spacing.md }}
            />
          ) : (
            <FadeInView delay={0} duration={320}>
              <GlassSurface
                radius={20}
                role="card"
                style={[styles.liveStateCard, { backgroundColor: 'transparent', borderColor: palette.hairline }]}
              >
                <MaterialCommunityIcons name="broadcast-off" size={20} color={palette.labelTertiary} />
                <Text style={[styles.liveStateText, { color: palette.labelSecondary }]}>{t('此时段暂无公演直播')}</Text>
              </GlassSurface>
            </FadeInView>
          )}
        </View>

        {/* 快捷入口：单行 4 个胶囊 */}
        <View style={styles.sectionOuter}>
          <SectionHeader title={t('快捷入口')} />
          <View style={styles.quickRow}>
            {quick.map((item, index) => (
              // ⚠️【稳定性】这里**故意不再用 FadeInView**：
              // FadeInView 靠「挂载时把 opacity 0 动画到 1」实现进场，一旦动画被打断/不执行，
              // 常驻区块就会永久停在透明（用户反馈「快捷入口经常上下互动后莫名消失」）。
              // 快捷入口是高频常驻内容，不能用「靠动画才可见」的写法。
              <View key={item.title} style={[styles.quickCell, { width: quickCellW }]}>
                <ScalePressable
                  onPress={() => handleNav(item)}
                  pressedScale={0.94}
                  style={styles.quickCellInner}
                >
                    {/* ⚠️【性能】4 个快捷入口逐格玻璃 = 4 个 BlurView 常驻首页，改实底圆角 */}
                    <View
                      style={[styles.chip, shadows.xs, { backgroundColor: palette.surfaceGlassStrong, borderColor: palette.innerStroke, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth }]}
                    >
                      <View style={[styles.chipIcon, { backgroundColor: palette.tintSoft }]}>
                        <MaterialCommunityIcons name={item.icon} color={palette.tint} size={16} />
                      </View>
                      <Text style={[typography.footnote, { color: palette.label, fontWeight: '600' }]} numberOfLines={1}>{item.title}</Text>
                    </View>
                  </ScalePressable>
              </View>
              ))}
            </View>
        </View>

        {/* 最近播放：被 ❌ 关掉的曲目整块不渲染（重启后也不回来） */}
        {currentTrack && trackTitle && currentTrackKey !== hiddenRecentId ? (
          <View style={styles.sectionOuter}>
            <SectionHeader title={t('最近播放')} />
            <FadeInView delay={0} duration={320}>
              <ScalePressable onPress={openMusicLibrary} pressedScale={0.97}>
                <GlassCard strong padding={12} radius={20}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={[styles.musicCover, { backgroundColor: palette.tintSoft }]}>
                      {currentTrack?.coverUrl || currentTrack?.cover ? (
                        <NetworkImage
                          source={{ uri: (currentTrack.coverUrl || currentTrack.cover || '') as string }}
                          style={styles.musicCover}
                          resizeMode="cover"
                          // 52dp 封面 ≈156px（480dpi），按 180 取缩略图（此前下原图）
                          thumbnail={AVATAR_THUMB_WIDTH}
                        />
                      ) : (
                        <MaterialCommunityIcons name="music-note" color={palette.tint} size={24} />
                      )}
                    </View>
                    <View style={{ flex: 1, marginHorizontal: 12, minWidth: 0 }}>
                      <Text style={[typography.headline, { color: palette.label }]} numberOfLines={1}>{trackTitle}</Text>
                      {trackArtist ? (
                        <Text style={[typography.footnote, { color: palette.labelSecondary, marginTop: 2 }]} numberOfLines={1}>
                          {trackArtist}
                        </Text>
                      ) : null}
                    </View>
                    {/* ❌ 关闭：**总是显示**。
                        原来只在「播放中/暂停」时才有 ❌，一旦停止，卡片就再也关不掉、永久留在首页（用户反馈）。
                        ⚠️ 现在关闭 = 停播 + 收起卡片 + 记下这首（重启不再显示）。 */}
                    <ScalePressable
                      onPress={dismissRecent}
                      pressedScale={0.9}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 17,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'rgba(128,128,128,0.12)',
                        marginRight: 10,
                      }}
                    >
                      <MaterialCommunityIcons name="close" color={palette.labelSecondary} size={18} />
                    </ScalePressable>
                    <Pill label={resumeLabel} accent onPress={handleResumeMusic} style={{ alignSelf: 'center' }} />
                  </View>
                </GlassCard>
              </ScalePressable>
            </FadeInView>
          </View>
        ) : null}

        {/* 工具：单行横向 chips */}
        <View style={styles.sectionOuter}>
          <SectionHeader title={t('工具')} />
          {/* ⚠️ 同上：工具条也是常驻内容，不再套 FadeInView（会因动画被打断而整条不可见） */}
          <View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.toolChipsContent}
              style={{ marginHorizontal: -spacing.md }}
            >
              {toolChips.map((item) => (
                <ScalePressable
                  key={item.title}
                  onPress={() => handleNav(item)}
                  pressedScale={0.94}
                >
                  {/* ⚠️【性能】横向工具条逐格玻璃 = N 个 BlurView，改实底圆角 */}
                  <View
                    style={[styles.toolChip, shadows.xs, { backgroundColor: palette.surfaceGlassStrong, borderColor: palette.innerStroke, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth }]}
                  >
                    <View style={[styles.toolChipIcon, { backgroundColor: palette.tintSoft }]}>
                      <MaterialCommunityIcons name={item.icon} color={palette.tint} size={16} />
                    </View>
                    <Text style={[typography.footnote, { color: palette.label, fontWeight: '600' }]} numberOfLines={1}>{item.title}</Text>
                  </View>
                </ScalePressable>
              ))}
            </ScrollView>
          </View>
        </View>

        <Text
          style={[
            typography.caption1,
            { color: palette.labelTertiary, textAlign: 'center', marginTop: spacing.xl, marginBottom: 24 },
          ]}
        >
          {t('Presented by Xenia')}
        </Text>
      </ScrollView>
    </View>
  );
}


const styles = StyleSheet.create({
  outer: { flex: 1 },
  /** 区块外层：统一水平留白 + 区块间距 16（v2.7 压缩，原 24 偏宽） */
  sectionOuter: {
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionDot: { width: 4, height: 18, borderRadius: 2 },
  loginBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 3,
    gap: 4,
  },
  liveBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  // 成员直播小卡（一行四张）
  homeLiveCell: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  homeLiveCellCover: { width: '100%', height: '100%' },
  homeLiveCellFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  homeLiveCellShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '62%' },
  homeLiveCellBadge: { top: 5, left: 5, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 8 },
  homeLiveCellInfo: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 6, paddingBottom: 5 },
  homeLiveCellTitle: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', lineHeight: 14, textShadowColor: 'rgba(0,0,0,0.65)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  homeLiveCellNick: { color: 'rgba(255,255,255,0.85)', fontSize: 9, marginTop: 1, textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  liveList: { gap: 8 },
  liveStateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  liveStateText: { flex: 1, fontSize: 13, lineHeight: 18 },
  // 快捷入口胶囊
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingRight: 12,
    paddingVertical: 7,
  },
  quickRow: { flexDirection: 'row', gap: 8 },
  quickCell: {},
  quickCellInner: { width: '100%' },
  chipIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginLeft: 6,
  },
  musicCover: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  toolChipsContent: {
    paddingRight: 8,
    gap: 8,
    paddingHorizontal: spacing.md,
    // 防横向 ScrollView 高度塌缩：显式 minHeight + 垂直居中，保证图标不被截断
    alignItems: 'center',
    minHeight: 46,
  },
  // 工具 chips：与快捷入口胶囊(chip)完全同参 —— 圆角 20 / 图标 30 / 间距一致（风格统一）
  toolChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingRight: 12,
    paddingVertical: 7,
  },
  toolChipIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginLeft: 6,
  },
});
