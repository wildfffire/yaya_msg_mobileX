/**
 * HomeScreen · 内容仪表盘 v2.6 布局重做
 * - 问候区（大标题 + 副标题，区块标题统一「4×18 tint 竖条 + headline」）
 * - 未登录提示卡
 * - 正在直播：一行四张小卡（竖屏 4 列方格；横屏按「屏高 1/3」硬限高，见 liveCellH 注释）
 * - 快捷入口 4 格胶囊
 * - 最近播放续播卡
 * - 工具 chips 横向滚动
 * - 首屏加载 Skeleton 占位
 * 业务逻辑 / API / 数据流 / 路由 / i18n 原文一律不动，仅重组布局结构。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { CompositeNavigationProp } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { StackNavigationProp } from '@react-navigation/stack';
import { useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import { useSidebarMode, useSidebarMetrics } from '../hooks/useSidebarMode';
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
import { chromeScrollProps } from '../navigation/chromeScroll';
import { GlassCard } from '../components/GlassCard';
import { Pill } from '../components/Pill';
import { Button } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import { FadeInView, ScalePressable } from '../components/Motion';
import { NetworkImage } from '../components/NetworkImage';
import LivePulseDot from '../components/LivePulseDot';
import { useI18n } from '../i18n';
import { pocketApi } from '../api/pocket48';
import { normalizeUrl, pickText, unwrapList } from '../utils/data';
import { buildMemberLookup, resolveTeam } from '../utils/memberMatch';
import { AVATAR_THUMB_WIDTH } from '../utils/imageThumb';
import { isLandscapeSize } from '../utils/orientation';
import { decideLivesUpdate } from '../utils/homeLivesRules';
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
  MeleeRank: 'trophy', Database: 'database', Login: 'key-variant', Download: 'download', Invoice: 'file-document-outline', Settings: 'account-circle-outline',
  Community: 'forum', OnMic: 'microphone', Netface: 'account-voice',
};

const QUICK: NavItem[] = [
  { title: '直播', desc: '', route: 'Media', params: { mode: 'live' }, icon: ICONS.LiveRoom },
  { title: '回放', desc: '', route: 'Media', params: { mode: 'vod' }, icon: ICONS.Vod },
  { title: '音乐', desc: '', route: 'MusicLibraryScreen', icon: ICONS.MusicLibrary },
  { title: '私信', desc: '', route: 'PrivateMessagesScreen', icon: ICONS.PrivateMessages },
];

/** 工具：单行横向 chips（翻牌/统计/下载/账号/设置…） */
const TOOL_CHIPS: NavItem[] = [
  // 现场互动（用户 2026-11-11：从「我的 → 工具」移到首页工具第一位）
  { title: '现场互动', desc: '', route: 'NetfaceScreen', icon: ICONS.Netface },
  { title: '翻牌', desc: '', route: 'FlipScreen', icon: ICONS.FlipSend },
  { title: '上麦', desc: '', route: 'OnMicScreen', icon: ICONS.OnMic },
  { title: '统计', desc: '', route: 'AnalysisScreen', icon: ICONS.Analysis },
  // 行程紧跟在统计后：工具条横向滚动，放末尾在手机上要滑才看得见
  { title: '行程', desc: '', route: 'TripScreen', icon: ICONS.Trip },
  { title: '下载', desc: '', route: 'DownloadScreen', icon: ICONS.Download },
  { title: '账号', desc: '', route: 'AccountScreen', icon: ICONS.Login },
  { title: '我的', desc: '', route: 'Settings', icon: ICONS.Settings },
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
  /** 直播类型：1=视频 2=电台（电台播放时用成员照片轮播，见 player/session/usePlaybackCarousel） */
  liveType?: number;
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

/**
 * 成员直播请求的外层兜底超时。
 * ⚠️ 必须 **大于** requestJson 内层的 15s：外层先超时会让「10~15 秒才回来」的响应
 * 被直接丢弃（静默保留旧数据 = 用户眼里「刷新了却什么都没发生」）。
 */
const LIVES_REQUEST_TIMEOUT_MS = 16000;
/** 下拉刷新整条链的兜底超时：任何一环卡死（原生模块 hang/极端弱网）都必须复位指示器与守卫 */
const REFRESH_TIMEOUT_MS = 20000;
/** 切回主页（tab focus）静默刷新的最小间隔，避免来回切 tab 把接口打爆 */
const FOCUS_FETCH_MIN_GAP_MS = 20000;

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
      /**
       * 电台判定（1=视频 2=电台）：只认 `liveType`。
       * ⚠️ 不要用 `type` —— 直播详情的 `content.type` 在电台场次仍是 1（实测 2026-11-04）。
       */
      liveType: Number(pickText(raw, ['liveType', 'live_type'], '0')) || 0,
    }))
    .filter((item: LiveCardItem) => item.title);
  // ⚠️ 这里不能再 slice(0,8) 截断：截断发生在「关注优先」排序**之前**，接口原始顺序里
  // 排在后面的关注成员会被直接丢掉（实测只显示 2 个关注成员的根因）。
  // 展示数量由 gridLives 固定为「一行 4 张」；横屏时卡片再按屏高 1/3 限高。排序（关注/置顶优先）在 fetchLives 里做。
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

/**
 * 首页成员直播小卡（一行四张）：封面 + 渐变 + 标题/昵称上浮 + 与直播页同款的
 * 左上类型徽标（电台/视频）+ 右上状态徽标（电台/直播中）。
 * `height` 默认等于宽度（竖屏方格）；横屏会传入被「屏高 1/3」压过的较小高度 → 呈横向宽卡。
 */
function HomeLiveCell({
  item,
  size,
  height = size,
  onPress,
  team,
}: {
  item: LiveCardItem;
  size: number;
  height?: number;
  onPress: () => void;
  team?: string;
}) {
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
          // ⚠️ 必须显式给尺寸：封面 height:'100%' 挂在无高度父级上会塌掉
          //（上一版漏了这里 → 首页卡片不是方格。竖屏 size = 宽 = 高，与直播页格子同一做法；
          //  横屏 height 会被「屏高 1/3」压小，此时呈横向宽卡，属预期）
          { width: size, height, backgroundColor: palette.fill3, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth },
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
        {/* 与 MediaScreen 直播网格完全同款的双徽标：判据只认 liveType===2（电台）。
            normalizeLiveList 已带 liveType，不需要改数据链路；小卡更窄，徽标整体缩一档。 */}
        <View style={[styles.liveBadge, styles.homeLiveCellBadge]}>
          <MaterialCommunityIcons
            name={item.liveType === 2 ? 'radio' : 'video'}
            size={8}
            color="#FFFFFF"
          />
          <Text style={styles.homeLiveCellBadgeText}>{item.liveType === 2 ? t('电台') : t('视频')}</Text>
        </View>
        <View style={[styles.liveBadge, styles.homeLiveCellStatusBadge]}>
          {item.liveType === 2 ? (
            <>
              <MaterialCommunityIcons name="radio" size={8} color="#FFFFFF" />
              <Text style={styles.homeLiveCellBadgeText}>{t('电台')}</Text>
            </>
          ) : (
            <>
              <LivePulseDot size={6} />
              <Text style={styles.homeLiveCellBadgeText}>{t('直播中')}</Text>
            </>
          )}
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
  const sidebarMetrics = useSidebarMetrics();
  /** 侧栏模式时场景被 sceneStyle.paddingLeft 挤窄，所有「按屏宽算格子」的区块都要扣掉它 */
  const sidebarMode = useSidebarMode();
  const contentInset = sidebarMode ? sidebarMetrics.totalW : 0;
  const quickCellW = (winW - contentInset - spacing.md * 2 - 24) / 4;

  const [lives, setLives] = useState<LiveCardItem[]>([]);
  /**
   * 成员索引（全仓唯一口径 `utils/memberMatch`）：小卡上的队伍应援色标注用。
   *
   * ⚠️ 以前这里是「只认 `m.id` 一个键」的自建 Map —— 直播列表的 `userId` 一旦
   * 与成员库 `id` 不是同一批值（新旧库混用、官方改 id 域），队伍徽章就整片消失。
   * 现在先 userId、后归一化昵称，与直播页/历史页完全同一条链路。
   */
  const allMembers = useMemberStore((s) => s.members);
  const homeMemberLookup = useMemo(() => buildMemberLookup(allMembers), [allMembers]);
  const liveTeamOf = useCallback(
    (live: LiveCardItem) => resolveTeam(homeMemberLookup, {
      userId: live.userId,
      name: live.nickname,
    }),
    [homeMemberLookup],
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
  /** 服务端连续返回「结构完整但一条直播都没有」的次数（决策规则见 utils/homeLivesRules） */
  const emptyStreakRef = useRef(0);
  const fetchedRef = useRef(false);

  /**
   * 成员直播小卡（与「直播」页同款方格）—— 2026-09-28 按你的要求**重做**：
   *
   * **硬约束：卡片永远是 1:1 方格。** 因为方格「宽 = 高」，边长就不可能既靠宽度调又靠高度调 ——
   * 所以这里改用**列数**来调卡片大小：先定一个「方格边长目标」，据此反算一行放几列，
   * 再让整行刚好被填满（既不留右侧空白，也不会出现压扁的长条）。
   *
   * - **竖屏**：固定 **4 列**、**只显示一行**（不再挤第二排小卡）。手机竖屏下边长约 86dp。
   * - **横屏**：边长目标 = 屏高 × 26%，并夹在 90~220dp 之间（防极端屏幕下过小/过大）。
   *   实测两种机器：
   *     · **16:10 平板横屏（1280×800dp）：目标 208 → 6 列，边长 203，区块总高 ≈ 255（屏高 32%）**
   *     · 手机横屏（851×393dp）：目标 102 → 8 列，边长 97，区块总高 ≈ 149（屏高 38%）
   *   对比历史：改之前手机横屏是「4 列被压成 200×78 的长条」；再之前平板横屏 4 列方格边长高达 307dp（太大）。
   */
  const LIVE_CELL_GAP = 6;
  /** 横屏时「方格边长」的目标值 = 屏高 × 该比例（26% 是「看得清标题、又不吃掉半屏」的折中） */
  const LIVE_CELL_ASPECT_RATIO = 0.26;
  /** 边长夹取区间：过小看不清，过大又回到「图片太大」的老问题 */
  const LIVE_CELL_MIN = 90;
  const LIVE_CELL_MAX = 220;
  // ⚠️ 侧栏模式的 sceneStyle.paddingLeft 会挤窄内容区；不扣掉的话「一行小卡」
  // 算出来的格子总宽大于实际可用宽度，最后一张就会被 flexWrap 挤到第二行（真机反馈）。
  const liveAvailW = winW - contentInset - spacing.md * 2;
  const isLandscape = isLandscapeSize(winW, winH);
  // 横屏按目标边长反算列数（至少 3 列，否则宽屏上会出现 1~2 张巨卡）；竖屏固定 4 列
  const liveCols = isLandscape
    ? Math.max(
        3,
        Math.round(
          (liveAvailW + LIVE_CELL_GAP) /
            (Math.min(LIVE_CELL_MAX, Math.max(LIVE_CELL_MIN, winH * LIVE_CELL_ASPECT_RATIO)) + LIVE_CELL_GAP),
        ),
      )
    : 4;
  /** 1:1 方格：宽度算出来多少，高度就是多少；floor 保证整行不因浮点误差换行 */
  const liveCellW = Math.floor((liveAvailW - LIVE_CELL_GAP * (liveCols - 1)) / liveCols);
  const gridLives = lives.slice(0, liveCols);

  /**
   * 公演排期（即将 + 进行中）——「公演直播」区块改版后不再自己检测 B站开播：
   * 与公演记录页共用同一条排期数据 + 同一个横滑卡组件（PerformanceStrip），
   * 到点/进行中由组件内 60s 心跳翻牌，点击行为（未开演提示 / 进 B站直播）也完全一致。
   * 回前台补拉一次（服务端 10 分钟缓存，非强制），失败保留旧数据。
   */
  const [gongyanShows, setGongyanShows] = useState<PerformanceShow[] | null>(null);
  /** 公演排期拉取（首屏 / 回前台 / 下拉刷新共用）：force=true 跳过 10 分钟 TTL 缓存真正重拉 */
  const refreshPerformances = useCallback((force = false): Promise<void> => {
    return fetchUpcomingPerformances(force)
      .then((list) => { if (mountedRef.current) setGongyanShows(list); })
      .catch(() => {
        // 失败时首次落空态（显示「此时段暂无公演直播」），已有数据则保留旧值
        if (mountedRef.current) setGongyanShows((prev) => prev ?? []);
      });
  }, []);
  useEffect(() => {
    refreshPerformances();
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      refreshPerformances();
    });
    return () => sub.remove();
  }, [refreshPerformances]);

  // 成员直播排序偏好：已关注（getFollowedIds）+ 置顶（yaya_pinned_rooms）优先
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  /** 排序偏好拉取（进页 / token 变化 / 下拉刷新共用）：置顶读本地，关注需登录 */
  const reloadFollowPrefs = useCallback((): Promise<void> => {
    const pinnedTask = AsyncStorage.getItem('yaya_pinned_rooms')
      .then((v) => { try { const a = JSON.parse(v || '[]'); if (Array.isArray(a)) setPinnedIds(a.map(String)); } catch { /* ignore */ } })
      .catch(() => {});
    if (!token) return pinnedTask;
    const followedTask = pocketApi.getFollowedIds()
      .then((res: any) => {
        const ids = unwrapList(res, ['content.data', 'content', 'data', 'list']).map(String);
        setFollowedIds(new Set(ids));
      })
      .catch(() => {});
    return Promise.all([pinnedTask, followedTask]).then(() => undefined);
  }, [token]);
  useEffect(() => { reloadFollowPrefs(); }, [reloadFollowPrefs]);

  /**
   * 拉取成员直播列表。
   *
   * @param options.authoritative 用户主动刷新（下拉）：服务端返回真空列表时按权威结果**立即**采纳
   * @param options.source 日志来源标记（init/poll/foreground/focus/refresh/retry）
   *
   * ★ 2026-10-05 修复（用户反馈：「主页刷新成员直播列表无法刷新」）：
   *   旧实现对「结构完整但列表为空」+「本地已有旧数据」是**空操作**（注释里写着"等下一轮轮询纠正"，
   *   而下一轮同样为空、同样什么都不做）→ 成员下播后已下播的卡片永久钉在主页，
   *   下拉刷新 / 60s 轮询 / 回前台刷新全都清不掉它（点进去才发现直播早结束了）。
   *   现在三态判定统一交给 utils/homeLivesRules.decideLivesUpdate：
   *     有数据→替换；真空→连续两次确认后清空（主动刷新立即清）；解析异常→保留并打日志。
   */
  const fetchLives = useCallback((options?: { authoritative?: boolean; source?: string }): Promise<void> => {
    const authoritative = !!options?.authoritative;
    const source = options?.source || 'auto';
    // 秒显上次缓存（stale-while-revalidate）：冷启动立即有内容，后台刷新
    const cacheTask = AsyncStorage.getItem(LIVES_CACHE_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const cached = JSON.parse(raw);
          /**
           * 只有「界面上此刻一条都没有」时才拿缓存上屏（冷启动秒显的 stale-while-revalidate）。
           *
           * ⚠️ 原来这里写的是 `!fetchedRef.current`，而 fetchedRef 在调用 fetchLives **之前**
           * 就被置成了 true（见下面首屏 effect）→ 这个 `.then` 执行时条件恒为 false，
           * 整段缓存分支从未生效过：冷启动遇上网络慢/失败时主页只能干等，
           * 用户体感就是「列表一直是空的、刷新也出不来」。
           * 改用「当前列表为空」作为判据，同时还天然避免了下拉刷新时被旧缓存覆盖。
           */
          if (Array.isArray(cached) && cached.length && livesRef.current.length === 0) {
            const restored = sortLivesByPreference(cached, followedIds, pinnedIds);
            livesRef.current = restored;
            setLives(restored);
            setLivesOk(true);
          }
        } catch { /* ignore */ }
      })
      .catch(() => {});
    const netTask = withTimeout(
      // size:100 —— 默认页只有 15 条，在播成员多时会漏掉排在后面的关注成员
      pocketApi.getLiveList({ groupId: 0, liveType: 0, next: 0, record: false, size: 100 }),
      LIVES_REQUEST_TIMEOUT_MS,
    )
      .then((res: any) => {
        if (!res) throw new Error('timeout');
        // 空壳防护：官方接口偶发返回 success/200 但 content 无 liveList 字段（限流/风控/异常），
        // 此时 normalizeLiveList 会解出空数组 → 误把"有直播"显示成"暂无成员直播"。
        // 判定规则：结构里确实没有 liveList 数组 = 视为请求异常（保留旧数据走 catch）。
        const rawList = (res?.content ?? res?.data ?? res)?.liveList;
        if (!Array.isArray(rawList)) throw new Error('live list empty shell');
        const list = sortLivesByPreference(normalizeLiveList(res), followedIds, pinnedIds);
        const decision = decideLivesUpdate({
          prevCount: livesRef.current.length,
          rawLen: rawList.length,
          nextLen: list.length,
          emptyStreak: emptyStreakRef.current,
          authoritative,
        });
        emptyStreakRef.current = decision.emptyStreak;
        // release 也打（真机 logcat ReactNativeJS 可见）：下次有成员开播时，一条命令即可看清
        // 「服务端给了几条 / 解析出几条 / 最终采纳还是保留」。
        console.warn(
          `[home.lives] src=${source} raw=${rawList.length} norm=${list.length} prev=${livesRef.current.length}`
          + ` action=${decision.action} reason=${decision.reason}`,
        );
        // 服务端给了条目却一条都没解析出来（字段改名 / 标题为空被过滤）：把原始样本打出来，
        // 下次再出现「有成员开播但主页显示暂无」时，一条 logcat 就能看出真实字段名。release 也打。
        if (rawList.length && !list.length) {
          const sample: any = rawList[0];
          console.warn(
            '[home.lives] 首条原始样本 keys='
            + (sample && typeof sample === 'object' ? Object.keys(sample).join(',') : typeof sample)
            + ' sample=' + JSON.stringify(sample).slice(0, 300),
          );
        }
        if (decision.action === 'replace') {
          livesRef.current = list;
          setLives(list);
          setLivesOk(true);
          setLivesError('');
          livesRetryRef.current = 0;
          AsyncStorage.setItem(LIVES_CACHE_KEY, JSON.stringify(list)).catch(() => {});
        } else if (decision.action === 'clear') {
          livesRef.current = [];
          setLives([]);
          setLivesOk(true);
          setLivesError('');
          livesRetryRef.current = 0;
          // 缓存必须一起清：否则下次冷启动的 stale-while-revalidate 会把已下播的卡片读回来（僵尸卡复活）
          AsyncStorage.removeItem(LIVES_CACHE_KEY).catch(() => {});
        }
        // keep：保留现有列表（首次真空待确认 / 条目解析异常），只留日志
      })
      .catch((e: any) => {
        // 有缓存/已有列表时网络失败不打断展示（保留内容，仅静默）；
        // 无任何数据时：记错误态 + 5s 后自动重试（最多 3 次，网络抖动自愈，不必等手动点重试）。
        // ⚠️ 判断依据是"当前无可展示数据"，不是 fetchedRef（后者首屏已置 true，
        // 用它会让首屏失败永不进入错误态/重试，只剩 60s 轮询兜底 → 首页整段空白）。
        console.warn(`[home.lives] src=${source} 请求失败 err=${e?.message || String(e)} 本地条数=${livesRef.current.length}`);
        if (livesRef.current.length === 0) {
          setLivesError(e?.message || String(e));
          if (livesRetryRef.current < 3) {
            livesRetryRef.current += 1;
            setTimeout(() => {
              if (!mountedRef.current) return;
              if (AppState.currentState === 'active') fetchLives({ source: 'retry' });
            }, 5000);
          }
        }
      });
    // 返回 Promise：下拉刷新要等「缓存链 + 网络链」都结束才关闭指示器
    return Promise.all([cacheTask, netTask]).then(() => undefined);
  }, [followedIds, pinnedIds]);

  // 关注/置顶数据到达后：已有列表立即按新偏好重排（不重新请求，幂等）
  useEffect(() => {
    setLives((prev) => (prev.length ? sortLivesByPreference(prev, followedIds, pinnedIds) : prev));
  }, [followedIds, pinnedIds]);

  // 首屏拉取（fetchedRef 防重复）
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchLives({ source: 'init' });
  }, [fetchLives]);

  // 成员直播 60s 轮询 + 回前台立即刷新：避免「启动时网络差失败后永久骨架/错误态，只能手动重试」
  useEffect(() => {
    const id = setInterval(() => {
      if (AppState.currentState === 'active') fetchLives({ source: 'poll' });
    }, 60 * 1000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetchLives({ source: 'foreground' });
    });
    return () => { clearInterval(id); sub.remove(); };
  }, [fetchLives]);

  /**
   * 切回主页（tab focus）时静默补一次。
   *
   * 用户体感里「主页刷新不了」有一半是这一类：在直播页/房间看到有人开播，
   * 切回主页却发现列表还是旧的（主页只有 60s 轮询，最坏要等一分钟）。
   * 这里带 20s 节流（避免来回切 tab / 关注偏好变化导致 fetchLives 换引用时反复打接口）。
   */
  const lastFocusFetchRef = useRef(0);
  useFocusEffect(
    useCallback(() => {
      if (!fetchedRef.current) return; // 首屏由上面的 effect 负责
      const now = Date.now();
      if (now - lastFocusFetchRef.current < FOCUS_FETCH_MIN_GAP_MS) return;
      lastFocusFetchRef.current = now;
      fetchLives({ source: 'focus' });
    }, [fetchLives]),
  );

  // 原子化订阅：queue 引用仅在队列变化时更新，position 高频写入不触发首页重渲染
  const musicQueue = useMusicPlayerStore((s) => s.queue);
  const musicIndex = useMusicPlayerStore((s) => s.currentIndex);
  const musicPlaybackState = useMusicPlayerStore((s) => s.playbackState);
  const currentTrack = musicQueue[musicIndex] || null;

  /**
   * 下拉刷新（用户 2026-10-04 要求）：并行重拉「成员直播 + 公演排期 + 关注/置顶偏好」。
   * 三个请求各自带降级（直播失败保留旧列表 / 公演失败回退缓存 / 偏好失败保留旧值），
   * 全部结束才关闭指示器；任一路失败不阻塞其它，也不额外弹错误条。
   */
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const handleRefresh = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    // ⚠️ 兜底超时：三条链里任何一条卡住（原生模块 hang / 极端弱网 / 在途请求去重挂住），
    // finally 都不执行 → refreshingRef 永久为 true → **此后所有下拉刷新都被上面那行早退吃掉**，
    // 表现就是「怎么刷都没反应」。这里无论如何都要把指示器与守卫复位。
    withTimeout(
      Promise.all([
        // authoritative：用户主动刷新时，服务端返回真空列表要立即采纳（不等第二次确认）
        fetchLives({ authoritative: true, source: 'refresh' }),
        refreshPerformances(true),
        reloadFollowPrefs(),
      ]),
      REFRESH_TIMEOUT_MS,
    )
      .catch(() => {})
      .finally(() => {
        refreshingRef.current = false;
        if (mountedRef.current) setRefreshing(false);
      });
  }, [fetchLives, refreshPerformances, reloadFollowPrefs]);

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

  /** 侧栏模式下连时段问候语一起隐藏（sidebarMode 已在组件顶部统一计算） */
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
    /**
     * 成员名/队伍/成员 id 必须一起带过去（用户 2026-11-08：「从主页成员直播进直播间
     * 右上角不显示成员名字」）。
     *
     * 播放器右上角的「队伍徽章 + 成员名」胶囊只读 `meta.owner/team`，而 meta 唯一来源是
     * PlayMedia.owner/team（MediaScreen 从路由参数的 playOwner/playTeam 取）。首页这条
     * 直达链路以前只传 liveId/title/cover → owner 为空 → 胶囊整块不渲染；顺带
     * `raw.nickname/userId` 也空，「进入房间」的成员反查（findMemberByHint）同样失效。
     * 卡片上本来就有 nickname/userId，这里原样透传即可（队伍用与卡片徽章同一条 lookup）。
     */
    const team = liveTeamOf(item);
    (navigation as any).navigate('Media', {
      mode: 'live',
      playLiveId: item.liveId,
      playTitle: item.title,
      playCover: item.cover,
      playOwner: item.nickname,
      playTeam: team,
      playOwnerId: item.userId,
      // 电台（liveType=2）：直播页首帧就用成员照片轮播，不闪「成员离开」的推流画面
      playLiveType: Number(item.liveType) || 0,
      playNonce: Date.now(),
      // 从首页看直播：退出播放要回首页（用户 2026-10-04）
      playFrom: 'Home',
    });
  }, [navigation, liveTeamOf]);

  return (
    <View style={[styles.outer, { backgroundColor: usePageBackground() }]}>
      {/* 顶栏与全站统一：大标题 24/800 左对齐、无返回键（tab 根页） */}
      <ScreenHeader title={t('牙牙消息 X')} hideBack />
      <ScrollView
        {...chromeScrollProps}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: 4,
          // 底部滚动空间：让 footer 可滚动到悬浮 dock 上方完全可见
          paddingBottom: 92 + insets.bottom,
        }}
        showsVerticalScrollIndicator={false}
        // 下拉刷新：手势触底即重拉直播列表 / 公演排期 / 关注偏好（下拉时 chromeScroll 判定为「向下滚」→ 顶栏与底栏自动回来）
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={palette.tint}
            colors={[palette.tint]}
          />
        }
      >
        {/* 问候区：一行问候 */}
        <View style={{ paddingHorizontal: spacing.md }}>
          {/* 问候：随手机当前时间变化（v2.7 字号缩小）；侧栏模式整行不渲染，
              只置空内容会残留 18 行高 + spacing.md 的空白 */}
          {!sidebarMode ? (
            <Text style={[typography.footnote, { color: palette.labelSecondary, marginBottom: spacing.md }]}>
              {greeting}
            </Text>
          ) : null}

          {!token ? (
            <ScalePressable style={{ marginBottom: spacing.xl }} onPress={() => handleNav({ title: '', desc: '', route: 'AccountScreen', icon: '' })} pressedScale={0.98}>
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
              {/* 手动重试也按「用户主动」处理：真空列表立即采纳，不留旧卡片 */}
              <Button
                title={t('重试')}
                variant="tinted"
                size="sm"
                onPress={() => { fetchLives({ authoritative: true, source: 'retry-button' }); }}
              />
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
              {/* 一行小卡（1:1 方格）：竖屏 4 列一行；横屏按目标边长自动定列数（见 liveCols） */}
              {/* nowrap 硬锁一行：gridLives 只取 liveCols 张，宽度已按可用宽度算满 */}
              <View style={{ flexDirection: 'row', flexWrap: 'nowrap', gap: LIVE_CELL_GAP }}>
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
          {t('Presented by wildfffire')}
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
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 3,
    gap: 4,
  },
  // 成员直播小卡（一行四张）
  homeLiveCell: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  homeLiveCellCover: { width: '100%', height: '100%' },
  homeLiveCellFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  homeLiveCellShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '62%' },
  // 左上类型 / 右上状态：不能用同一个 left，否则右上徽标会被 left+right 拉伸成整行
  homeLiveCellBadge: { top: 5, left: 5, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 8, gap: 2 },
  homeLiveCellStatusBadge: { top: 5, right: 5, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 8, gap: 2 },
  homeLiveCellBadgeText: { color: '#FFFFFF', fontSize: 8, fontWeight: '700' },
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
