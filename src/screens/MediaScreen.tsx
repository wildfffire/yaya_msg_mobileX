import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  DeviceEventEmitter,
  Image,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { applyOrientation, followSystem, isLandscapeSize } from '../utils/orientation';
import { RouteProp, useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { TabParamList } from '../navigation/types';
import { useSettingsStore, useUiStore, useMemberStore } from '../store';
import { setPipPlaying, setPipAspect, isPipActive } from '../utils/pip';
import { useMiniPlayerStore } from '../store/miniPlayerStore';
import { FadeInView } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { chromeScrollProps } from '../navigation/chromeScroll';
import { VODItem, Member } from '../types';
import { formatTimestamp, formatDuration } from '../utils/format';
import { errorMessage, normalizeUrl, pickText, unwrapList } from '../utils/data';
import { thumbUrl } from '../utils/imageThumb';
import { giftCost, giftImage, giftName, normalizeGiftList } from '../utils/gift';
import { logInfo } from '../utils/runtimeLog';
import pocketApi from '../api/pocket48';
import { setLiveImmersiveMode } from '../native/LivePlayer';
import { MediaPlaybackHost, type MediaPlaybackHostHandle, type PlayMedia } from '../player/session';
import { usePlayerStore } from '../player/store/playerStore';
// 弹幕层（DanmakuOverlay / 弹幕列表 / 弹幕设置 / 直播输入条 / 礼物特效）已收口到
// 统一播放宿主（src/player/session/MediaPlaybackHost），本页只保留公告正文的表情替换。
import { memberSearchText } from '../utils/members';
import {
  buildMemberLookup,
  findMemberByHint,
  pickMemberNickname,
  pickMemberUserId,
  resolveTeam,
  type MemberLookup,
} from '../utils/memberMatch';
import TeamBadge from '../components/TeamBadge';
import { EmptyState } from '../components/StateViews';
import { LoginPrompt } from '../components/LoginPrompt';
import { Button } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import { usePalette, radii, radiiAlias } from '../theme';
import { translate, useI18n } from '../i18n';
import { GlassSurface } from '../components/GlassSurface';
import { GlassSegmented, GlassSegmentedScroll } from '../components/GlassSegmented';
import { UserProfileSheet, type UserProfileTarget } from '../components/UserProfileSheet';

/** 回放列表加载占位：居中低调研度指示，无微光闪烁，避免「转圈 + 文字」混排打架 */
type MediaRouteProp = RouteProp<TabParamList, 'Media'>;

/**
 * 网格封面缩略图请求边长（px）。
 *
 * 双列网格每卡宽度 ≈ (360dp - 16) / 2 - 8 ≈ 164dp；480dpi 机型上约 492 物理像素，
 * 取 700 留出余量（服务端按原图比例 contain，`resizeMode="cover"` 再裁切，
 * 不会变形也不会糊）。对比原图（828×1104 / 783KB）体积降到约 1/17。
 */
const GRID_COVER_THUMB = 400;

const PLAY_URL_FIELDS = [
  'playStreamPath',
  'playUrlPath',
  'playPathUrl',
  'streamUrl',
  'streamURL',
  'playUrl',
  'urlPath',
  'playPath',
  'streamPath',
  'path',
  'src',
  'pullStreamPath',
  'liveStreamPath',
  'livePlayStreamPath',
  'streamPathHd',
  'streamPathHigh',
  'streamPathNormal',
  'streamPathOrigin',
  'url',
  'liveUrl',
  'm3u8Url',
  'flvUrl',
  'hlsUrl',
  'videoUrl',
  'recordUrl',
  'mediaUrl',
  'filePath',
  'content.playStreamPath',
  'content.playUrlPath',
  'content.playPathUrl',
  'content.streamUrl',
  'content.playUrl',
  'content.playPath',
  'content.streamPath',
  'content.pullStreamPath',
  'content.liveStreamPath',
  'content.livePlayStreamPath',
  'content.url',
  'data.playStreamPath',
  'data.playUrlPath',
  'data.playPathUrl',
  'data.streamUrl',
  'data.playUrl',
  'data.playPath',
  'data.streamPath',
  'data.pullStreamPath',
  'data.liveStreamPath',
  'data.livePlayStreamPath',
  'data.url',
  'content.playStreams.0.streamPath',
  'data.playStreams.0.streamPath',
];

function streamScore(url: string): number {
  const lower = url.toLowerCase();
  if (lower.includes('.m3u8') || lower.includes('format=hls')) return 100;
  if (lower.startsWith('https://') && lower.includes('.flv')) return 60;
  if (lower.startsWith('http://') && lower.includes('.flv')) return 50;
  if (lower.startsWith('rtmp://')) return 20;
  return 40;
}

function liveStreamScore(url: string): number {
  const lower = url.toLowerCase();
  if (lower.startsWith('rtmp://')) return 120;
  if (lower.startsWith('https://') && lower.includes('.flv')) return 105;
  if (lower.startsWith('http://') && lower.includes('.flv')) return 95;
  if (lower.includes('.m3u8') || lower.includes('format=hls')) return 80;
  return streamScore(url);
}

/**
 * 为直播/录播项构造可搜索文本 + 数字串，支持「时间搜索」。
 * 数字串同时给出「补零」与「不补零」两种形态，使 2026-07-20 / 0720 / 7-20 / 2026/7/20
 * 等自然输入都能命中，解决原先只能匹配 YYYY-MM-DD HH:mm:ss 单一格式的问题。
 */
function buildMediaSearchText(item: any): { text: string; digits: string } {
  const ts = formatTimestamp(item.startTime);
  const d = new Date(String(item.startTime || '').replace(/-/g, '/'));
  let padded = '';
  let loose = '';
  if (!Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const hh = d.getHours();
    const mm = d.getMinutes();
    const ss = d.getSeconds();
    padded = `${y}${String(m).padStart(2, '0')}${String(day).padStart(2, '0')}${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}${String(ss).padStart(2, '0')}`;
    loose = `${y}${m}${day}${hh}${mm}${ss}`;
  }
  const text = [item.title, item.nickname, item.liveRoomTitle, String(item.liveId || ''), ts]
    .filter(Boolean).join(' ').toLowerCase();
  const digits = [ts.replace(/\D/g, ''), padded, loose].filter(Boolean).join('');
  return { text, digits };
}

// 取录制时间的日期键 YYYY-MM-DD，用于日历筛选精确匹配
function dateKeyOf(startTime: any): string {
  let v: any = startTime;
  if (v === null || v === undefined || v === '') return '';
  // 录播接口 startTime 实际是「字符串形式的毫秒时间戳」（如 "1787214699552"），
  // 直接 new Date("1787214699552") 是 Invalid Date → 解析成秒/毫秒数字再 new Date
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{10}$/.test(s)) v = Number(s) * 1000; // 10 位秒
    else if (/^\d{13}$/.test(s)) v = Number(s); // 13 位毫秒
    else v = s.replace(/-/g, '/');
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e10) v *= 1000;
  const d = new Date(v as any);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 录播日历选择弹层（纯 RN 月历，零依赖，对标 pocket48_lite 的 CalendarMonth 按钮 + DatePicker）
function CalendarSheet({
  visible,
  initial,
  onSelect,
  onClose,
}: {  visible: boolean;
  initial: Date | null;
  onSelect: (d: Date) => void;
  onClose: () => void;
}) {
  const palette = usePalette();
  const { t } = useI18n();
  const base = initial || new Date();
  const [view, setView] = useState(() => new Date(base.getFullYear(), base.getMonth(), 1));
  const year = view.getFullYear();
  const month = view.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'].map((w) => t(w));
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.calMask} activeOpacity={1} onPress={onClose}>
        <GlassSurface radius={20} role="card" style={[styles.calSheet, { backgroundColor: 'transparent', borderColor: palette.innerStroke }]} onStartShouldSetResponder={() => true}>
          <View style={styles.calHeader}>
            <TouchableOpacity onPress={() => setView(new Date(year, month - 1, 1))} hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }} activeOpacity={0.7}>
              <MaterialCommunityIcons name="chevron-left" size={24} color={palette.label} />
            </TouchableOpacity>
            <Text style={[styles.calTitle, { color: palette.label }]}>{t('{year} 年 {month} 月', { year, month: month + 1 })}</Text>
            <TouchableOpacity onPress={() => setView(new Date(year, month + 1, 1))} hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }} activeOpacity={0.7}>
              <MaterialCommunityIcons name="chevron-right" size={24} color={palette.label} />
            </TouchableOpacity>
          </View>
          <View style={styles.calWeekRow}>
            {weekdays.map((w) => (
              <Text key={w} style={[styles.calWeek, { color: palette.labelTertiary }]}>{w}</Text>
            ))}
          </View>
          <View style={styles.calGrid}>
            {cells.map((d, i) =>
              d ? (
                <TouchableOpacity key={i} style={styles.calDay} onPress={() => onSelect(new Date(year, month, d))} activeOpacity={0.7}>
                  <Text style={[styles.calDayText, { color: palette.label }]}>{d}</Text>
                </TouchableOpacity>
              ) : (
                <View key={i} style={styles.calDay} />
              ),
            )}
          </View>
          <View style={styles.calFooter}>
            <TouchableOpacity onPress={onClose} style={styles.calCancel}>
              <Text style={[styles.calCancelText, { color: palette.tint }]}>{t('取消')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { onSelect(new Date()); onClose(); }}
              style={[styles.calToday, { backgroundColor: palette.tint }]}
              activeOpacity={0.85}
            >
              <Text style={[styles.calTodayText, { color: palette.onTint }]}>{t('今天')}</Text>
            </TouchableOpacity>
          </View>
        </GlassSurface>
      </TouchableOpacity>
    </Modal>
  );
}

function pickPlayableUrls(raw: any, preferLive = false): string[] {
  const candidates: string[] = [];
  const direct = normalizeUrl(pickText(raw, PLAY_URL_FIELDS));
  if (direct) candidates.push(direct);
  const streamList = unwrapList(raw, [
    'streams',
    'playStreams',
    'liveStreams',
    'urls',
    'content.streams',
    'content.playStreams',
    'content.urls',
    'data.streams',
    'data.playStreams',
    'content.liveStreams',
    'content.streamList',
    'content.playStreamList',
    'data.liveStreams',
    'data.streamList',
    'data.playStreamList',
    'data.urls',
  ]);
  for (const stream of streamList) {
    const url = normalizeUrl(pickText(stream, PLAY_URL_FIELDS));
    if (url) candidates.push(url);
  }
  const score = preferLive ? liveStreamScore : streamScore;
  return Array.from(new Set(candidates.filter(Boolean))).sort((a, b) => score(b) - score(a));
}

function pickPlayableUrl(raw: any): string {
  return pickPlayableUrls(raw)[0] || '';
}

function normalizeLiveList(res: any): VODItem[] {
  const source = unwrapList(res, [
    'content.liveList',
    'content.list',
    'content.data',
    'content.records',
    'data.liveList',
    'liveList',
    'list',
    'data',
  ]);

  return source.map((raw: any, index: number) => ({
    ...raw,
    liveId: String(pickText(raw, ['liveId', 'id', 'live_id', 'roomId'], String(index))),
    title: pickText(raw, ['title', 'liveTitle', 'liveRoomTitle', 'roomName', 'subject'], translate('无标题')),
    liveRoomTitle: pickText(raw, ['liveRoomTitle', 'title', 'liveTitle']),
    nickname: pickText(raw, ['nickname', 'nickName', 'userInfo.nickname', 'userInfo.nickName', 'ownerName']),
    startTime: raw.startTime || raw.stime || raw.start_time || raw.ctime || raw.liveStartTime || raw.beginTime,
    endTime: raw.endTime || raw.etime || raw.end_time || raw.liveEndTime,
    liveCover: normalizeUrl(pickText(raw, [
      'liveCover',
      'coverPath',
      'cover',
      'coverUrl',
      'picPath',
      'picturePath',
      'imageUrl',
      'poster',
      'thumb',
      'userInfo.avatar',
    ])),
    coverPath: normalizeUrl(pickText(raw, ['coverPath', 'cover', 'coverUrl'])),
    playUrl: pickPlayableUrl(raw),
    playPath: normalizeUrl(pickText(raw, ['playPath', 'playUrl', 'url'])),
    liveType: Number(pickText(raw, ['liveType', 'type', 'mediaType'], '1')),
    screenDirection: Number(pickText(raw, ['screenDirection', 'orientation'], '0')),
  })) as VODItem[];
}

// findLiveItemInLists（详情接口失败时按 liveId 在列表首屏兜底查找）已删除：
// 解析兜底统一到会话层 src/player/session/resolveMedia.ts（resolveRoomLiveMediaWithRetry）。

function mergeUniqueLiveItems(prev: VODItem[], next: VODItem[]) {
  const seen = new Set(prev.map((item: any, index) => String(item.liveId || item.id || item.title || index)));
  const merged = [...prev];
  for (const item of next as any[]) {
    const key = String(item.liveId || item.id || item.title || merged.length);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/* 礼物归一化（normalizeGiftList / giftName / giftCost / giftImage）已抽到 utils/gift，
   直播页与房间礼物面板共用同一份口径 —— 官方接口返回的是分类数组，房间侧旧实现按平铺解析会显示空列表。 */

function normalizeLiveRank(res: any): any[] {
  let list = unwrapList(res, [
    'content.rankList',
    'content.userRankList',
    'content.userRankingList',
    'content.contributionList',
    'content.list',
    'content.data',
    'content.data.list',
    'content.data.rankList',
    'data.rankList',
    'data.userRankList',
    'data.userRankingList',
    'data.contributionList',
    'data.list',
    'rankList',
    'userRankList',
    'userRankingList',
    'contributionList',
    'list',
  ]);
  if (!list.length) {
    const content = res?.content || res?.data || res;
    if (content && typeof content === 'object') {
      const found: any[] = [];
      const walk = (node: any, depth = 0) => {
        if (!node || depth > 5) return;
        if (Array.isArray(node)) {
          node.forEach((item) => walk(item, depth + 1));
          return;
        }
        if (typeof node !== 'object') return;
        const hasUser = pickText(node, ['nickName', 'nickname', 'userName', 'name', 'userInfo.nickname', 'userInfo.nickName', 'user.nickname', 'user.nickName']);
        const hasValue = pickText(node, ['score', 'total', 'cost', 'money', 'giftValue', 'value', 'amount', 'contribution', 'count', 'giftNum']);
        if (hasUser || hasValue || node.userInfo || node.user) found.push(node);
        Object.values(node).forEach((value) => walk(value, depth + 1));
      };
      walk(content);
      list = found;
    }
  }
  return list.map((item: any, index: number) => ({
    ...item,
    userId: pickText(item, ['userId', 'uid', 'id', 'account', 'userInfo.userId', 'userInfo.id', 'user.userId', 'user.id', 'user.userIdStr', 'user.userAccount', 'memberInfo.userId', 'memberInfo.id']),
    rank: Number(item.rank || item.no || item.index || index + 1),
    name: pickText(item, [
      'nickName',
      'nickname',
      'userName',
      'name',
      'senderName',
      'userInfo.nickName',
      'userInfo.nickname',
      'userInfo.name',
      'user.nickName',
      'user.nickname',
      'user.userName',
      'user.name',
      'memberInfo.nickName',
      'memberInfo.nickname',
    ], '\u7528\u6237 ' + (index + 1)),
    avatar: normalizeUrl(pickText(item, [
      'avatar',
      'headImg',
      'picPath',
      'userInfo.avatar',
      'userInfo.headImg',
      'user.avatar',
      'user.headImg',
      'user.userAvatar',
      'memberInfo.avatar',
    ])),
    value: pickText(item, ['score', 'total', 'cost', 'money', 'giftValue', 'value', 'amount', 'contribution', 'count', 'giftNum'], ''),
  }));
}

function rankNameIsFallback(row: any, index: number) {
  const name = String(row.name || '').trim();
  const fallbackPrefix = '\u7528\u6237';
  return !name || name === `${fallbackPrefix} ${index + 1}` || new RegExp(`^${fallbackPrefix}\\s*\\d+$`).test(name);
}
function profileFromUserRes(res: any) {
  const info = res?.content?.userInfo || res?.content?.user || res?.content || res?.data?.userInfo || res?.data?.user || res?.data || res || {};
  return {
    name: pickText(info, [
      'nickName', 'nickname', 'userName', 'name',
      'profile.nickName', 'profile.nickname',
      'userInfo.nickName', 'userInfo.nickname',
      'user.nickName', 'user.nickname', 'user.userName',
    ]),
    avatar: normalizeUrl(pickText(info, [
      'avatar', 'headImg', 'headUrl', 'picPath',
      'profile.avatar', 'profile.headImg',
      'userInfo.avatar', 'userInfo.headImg',
      'user.avatar', 'user.headImg', 'user.userAvatar',
    ])),
  };
}

function acceptUserId(item: any): string {
  return String(item?.userInfo?.userId || item?.user?.userId || item?.userId || item?.ownerId || item?.memberId || '');
}


/** 直播中呼吸红点（Animated + native driver） */
function LivePulseDot({ size = 7 }: { size?: number }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: '#ff4d4f',
        marginRight: 4,
        opacity: pulse,
      }}
    />
  );
}

/** 回放/直播列表首屏骨架：banner 块 + 2 列网格块 */
function MediaGridSkeleton() {
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4 }}>
      {[0, 1, 2].map((row) => (
        <View key={row} style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
          {[0, 1, 2, 3].map((col) => (
            <View key={col} style={{ flex: 1 }}><Skeleton width="100%" height={86} radius={12} /></View>
          ))}
        </View>
      ))}
    </View>
  );
}


export default function MediaScreen() {
  const route = useRoute<MediaRouteProp>();
  const navigation = useNavigation<any>();
  const palette = usePalette();
  const { t } = useI18n();
  const setTabBarHidden = useUiStore((state) => state.setTabBarHidden);
  const members = useMemberStore((state) => state.members);
  /**
   * 成员索引（**全仓唯一口径**：`utils/memberMatch`）。
   *
   * ⚠️ 这里以前是「昵称字符串精确相等 → 成员」的 Map（`ownerName` 原样当键），
   * 而网格卡片的 `teamOfItem` 走的是「`userInfo.userId` → 成员库」—— 两条链路口径不同，
   * 于是同一场直播「卡片上有队伍徽章、写进历史后没有」（用户 2026-09-30 反复反馈的点）。
   * 现在两者共用同一个 `resolveTeam(...)`，先 id 后归一化昵称，结果必然一致。
   */
  const memberLookup: MemberLookup = useMemo(() => buildMemberLookup(members), [members]);
  const [tab, setTab] = useState<'live' | 'vod'>(route.params?.mode ?? 'live');
  const token = useSettingsStore((s) => s.settings.p48Token);
  const [showSearch, setShowSearch] = useState(false);
  const [vodList, setVodList] = useState<VODItem[]>([]);
  const [liveList, setLiveList] = useState<VODItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const nextCursorRef = useRef(0); // 翻页游标：避免自动翻页闭包读到旧游标重复拉同一页（唯一来源，state 镜像已删）
  const [pageVersion, setPageVersion] = useState(0); // 每次拉取完成 +1：驱动自动翻页 effect 续链
  const [error, setError] = useState('');
  /**
   * 主直播页当前播放的条目（用户 2026-10-02：四场景统一播放器）。
   *
   * 只存「播什么」（PlayMedia）——解析（含「解析中/失败重试」shell）、续播与进度、
   * 弹幕（云信/HTTP 轮询/LRC）、在线人数、小窗交棒全部由统一播放宿主完成
   *（src/player/session/MediaPlaybackHost）。
   */
  const [media, setMedia] = useState<PlayMedia | null>(null);
  /** 小窗回大窗 / 路由带入的续播位置（秒）：交给宿主作为 initialPosition */
  const [pendingResumeAt, setPendingResumeAt] = useState(0);
  const mediaRef = useRef<PlayMedia | null>(null);
  mediaRef.current = media;
  /** 统一播放宿主 ref：送礼的云信公屏广播走宿主内部同一条聊天室连接 */
  const playbackHostRef = useRef<MediaPlaybackHostHandle | null>(null);
  /**
   * 当前播放内容归属的成员（官方条目 → 全量成员库反查）；找不到 = 非成员直播。
   *
   * ⚠️ 以前这里只用「`String(m.id)` 单键」的自建 Map 且只认 `userInfo.userId` 一条路径，
   * 而卡片队伍用的是另一条 —— 两条口径不一致正是「卡片有队伍徽章、进播放器后
   * 『进入房间』入口时有时无」的来源。现在统一走 `memberMatch` 的多键反查
   *（userId / serverId / channelId / account / 归一化昵称全收）。
   */
  const playingMember = useMemo(() => {
    const raw = media?.raw;
    if (!raw) return null;
    return findMemberByHint(memberLookup, {
      userId: pickMemberUserId(raw),
      name: pickMemberNickname(raw),
    });
  }, [media, memberLookup]);
  // 直播弹幕（云信聊天室连接 · 飘屏 · 输入条）与回放 LRC 弹幕已收口到统一播放宿主：
  // 见 src/player/session/usePlaybackDanmaku.ts —— 本页不再自建任何弹幕连接。
  const [giftVisible, setGiftVisible] = useState(false);
  const [gifts, setGifts] = useState<any[]>([]);
  const [selectedGift, setSelectedGift] = useState<any | null>(null);
  const [giftNum, setGiftNum] = useState('1');
  const [giftStatus, setGiftStatus] = useState('');
  const [balance, setBalance] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [rankVisible, setRankVisible] = useState(false);
  const [rankRows, setRankRows] = useState<any[]>([]);

  // 续播读取与进度落盘已收口到统一播放宿主（services/replayProgress 统一存储，
  // 与房间/历史/稍后再看互通）：见 src/player/session/usePlaybackResume.ts。

  // 弹幕拉取/解析（直播 HTTP 轮询 5s + 回放 LRC）与人数胶囊已收口到统一播放宿主：
  //   · 弹幕：src/player/session/usePlaybackDanmaku.ts（本页传 danmakuLivePollMs=5000 保持历史行为）
  //   · 人数：直播=云信聊天室实时在线；回放=官方累计观看人次
  //     （src/player/session/usePlaybackOnlineStat.ts + MediaPlaybackHost 的 onlineStat）

  const [rankStatus, setRankStatus] = useState('');
  // 公告（拉取 / 面板 / 展开态持久化 / 顶栏与控制坞按钮）已收口到统一播放宿主：
  // 见 src/player/session/usePlaybackAnnouncement.ts + MediaPlaybackHost 的 announcement 开关
  //（用户 2026-10-02：房间与观看历史里也要能看到公告）。
  /**
   * 请求在途标记，**按 tab(live/vod) 分别持有**。
   * 旧实现是一个全局布尔：live 的请求还在飞时切到 vod，新请求会被
   * `if (loadingRef.current) return` 直接吞掉，而旧请求（另一个 tab 的数据）
   * 仍会照常写状态 → 列表串台 / 切 tab 后空白。
   */
  const loadingRef = useRef<Record<'live' | 'vod', boolean>>({ live: false, vod: false });
  // v2.6: group filter + search
  /**
   * 默认选中「全部」（用户 2026-11-04：「切换到直播页面改为进入全部页面而不再是关注」）。
   * -1 仍是「关注」chip（保留筛选能力），只是不再作为进入页面时的默认值。
   */
  const [groupId, setGroupId] = useState(0);
  const [search, setSearch] = useState('');
  // 关注成员 id 集合：「关注」tag 实时筛选（60s 同步一次）
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());

  // 画中画（悬浮窗）状态同步：播放器打开即置位（暂停/内核细节由播放器内部处理），
  // 切后台自动进悬浮窗
  useEffect(() => {
    // 应用内小窗已接管 PiP 标志时不覆盖（防小窗切后台不进悬浮窗）
    if (useMiniPlayerStore.getState().visible) return;
    setPipPlaying(!!media);
  }, [media]);
  // 搜索：选中成员后，搜索框转为「该成员的标题/日期」过滤
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  /**
   * selectedMember 的 ref 镜像（用户 2026-10-01 bug 修复）：
   * 「关注录播并发扫描」（loadFollowVodFast）是个 useCallback，靠 eslint-disable 固定依赖，
   * 若把 selectedMember 放进闭包就会读到旧值 —— 用 ref 让扫描在成员检索模式下**中途也能让位**，
   * 否则扫描结果会 merge 进成员列表（混入关注成员的录播、把成员数据搅乱）。
   */
  const selectedMemberRef = useRef<Member | null>(null);
  selectedMemberRef.current = selectedMember;
  const [dateFilter, setDateFilter] = useState<Date | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);
  /** 弹幕列表点发送者 → 用户资料卡（成员/粉丝同一个界面） */
  const [danmakuProfile, setDanmakuProfile] = useState<UserProfileTarget | null>(null);
  const screen = useWindowDimensions();
  /** 播放器页是否横屏：公告偏移与礼物/贡献榜浮层都要按横屏重算 */
  const isPlayerLandscape = isLandscapeSize(screen.width, screen.height);
  // 公告面板的 top 偏移/动画（与控制条显隐联动）随之收进统一播放宿主。

  const GROUPS: { label: string; id: number; match: string }[] = [
    { label: '全部', id: 0, match: '' },
    { label: 'SNH48', id: 1, match: 'SNH48' },
    { label: 'BEJ48', id: 2, match: 'BEJ48' },
    { label: 'GNZ48', id: 3, match: 'GNZ48' },
    { label: 'CKG48', id: 4, match: 'CKG48' },
    { label: 'CGT48', id: 6, match: 'CGT48' },
  ];
  // 分组 chips：最前面加「关注」（id=-1，按关注成员 id 过滤）
  const groupChips: { label: string; id: number; match: string }[] = [
    { label: t('关注'), id: -1, match: '' },
    ...GROUPS,
  ];
  // 关注成员的昵称集合：录播/直播接口字段不一，id 匹配不到时按昵称兜底（大小写不敏感、去空白）
  const followedNames = useMemo(() => {
    const names = new Set<string>();
    members.forEach((m) => {
      const mid = String((m as any).id || (m as any).userId || '');
      if (mid && followedIds.has(mid) && m.ownerName) names.add(String(m.ownerName).trim().toLowerCase());
    });
    return names;
  }, [members, followedIds]);
  const list = useMemo(() => {
    let raw = tab === 'live' ? liveList : vodList;
    /**
     * ⚠️ 成员检索模式（selectedMember）下**不能再套「关注 / 团体」筛选**（用户 2026-10-01 bug 修复）。
     *
     * 数据已经是服务端按该成员 userId 直查的结果（见 doFetch 的 userId 分支），
     * 而搜索是从**全成员库**里选的 —— 搜到的成员未必在「已关注」里，
     * 而默认分组就是「关注」（groupId === -1）→ 关注筛选会把 TA 的录播整片滤掉，
     * 表现为「选中成员名之后一条都没有 / 还是别人的内容」。
     */
    if (selectedMember) {
      // 成员模式：raw 即该成员数据，只保留日期/标题过滤（见下方 dateFilter / search）
    } else if (groupId === -1) {
      // 关注筛选：命中关注成员 id 或昵称 的在播直播/录播（id 字段因接口而异，昵称兜底保证录播也能打通）
      raw = raw.filter((item: any) => {
        const owner = String(
          item.userId || item.ownerId || item.memberId || item.userInfo?.userId || item.userInfo?.id
          || item.user?.userId || item.owner?.userId || item.memberInfo?.userId || item.hostId || item.account || ''
        );
        if (owner && followedIds.has(owner)) return true;
        const nick = String(item.nickname || item.nickName || '').trim().toLowerCase();
        return !!nick && followedNames.has(nick);
      });
    } else if (groupId !== 0) {
      const g = GROUPS.find((x) => x.id === groupId);
      if (g && g.match) {
        raw = raw.filter((item) =>
          (item.nickname || '').includes(g.match) ||
          (item.title || '').includes(g.match) ||
          (item.liveRoomTitle || '').includes(g.match)
        );
      }
    }
    // 选中成员时数据已在服务端按 userId 直查（见 doFetch），此处无需内存筛选；
    // 保留 selectedMember 依赖以在成员切换时触发重算（raw 源 vodList 已换为成员数据）。
    // 日历日期筛选：按录制日期(YYYY-MM-DD)精确过滤
    if (dateFilter) {
      const key = dateKeyOf(dateFilter);
      raw = raw.filter((item: any) => dateKeyOf(item.startTime) === key);
    }
    if (!search.trim()) return raw;
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/[^0-9]/g, '');
    return raw.filter((item) => {
      const { text, digits } = buildMediaSearchText(item);
      // 数字优先：时间搜索（2026-07-20 / 0720 / 7-20 / 2026/7/20 等自然输入都能命中）
      if (qDigits.length >= 3 && digits.includes(qDigits)) return true;
      if (text.includes(q)) return true;
      return false;
    });
  }, [tab, liveList, vodList, search, groupId, selectedMember, dateFilter, followedIds]);

  // 录播按日期分组（今天/昨天/更早），live tab 不用
  /**
   * 条目 → 队伍名（应援色标注用）：**先 userId、后归一化昵称**，与写进历史的
   * `meta.team` 用同一个 `resolveTeam`（口径分裂 = 「卡片有队伍、历史没有」的根因）。
   */
  const teamOfItem = (it: any): string =>
    resolveTeam(memberLookup, { userId: pickMemberUserId(it), name: pickMemberNickname(it) });
  const vodRows = useMemo(() => {
    if (tab !== 'vod') return null;
    // 纯网格：不再按「今天/昨天/更早」分组（接口 startTime 为字符串毫秒，日期分组易出错），
    // 时间直接显示在卡片内（带年份、缩小字体适配），列表按时间倒序连续排列。
    // 一行四张（用户要求与直播 tab 同款方格）：每行 items 最多 4 个，末行不足 4 个由占位补齐。
    const flat: { type: 'header' | 'row'; key: string; title?: string; items: any[] }[] = [];
    for (let i = 0; i < list.length; i += 4) {
      flat.push({ type: 'row', key: `r-${i}`, items: list.slice(i, i + 4) });
    }
    return flat;
  }, [tab, list]);

  // 成员联想：未选成员时，输入命中成员名/缩写则弹出选择框
  const memberHits = useMemo(() => {
    if (selectedMember || !search.trim()) return [];
    const q = search.trim().toLowerCase();
    return members.filter((m) => memberSearchText(m).includes(q)).slice(0, 8);
  }, [members, search, selectedMember]);
  const selectedGiftTotal = useMemo(
    () => (selectedGift ? giftCost(selectedGift) * (Number(giftNum) || 1) : 0),
    [giftNum, selectedGift],
  );

  /**
   * 深链 / 房间直达播放（v2.6；2026-10-02 起改走统一播放宿主）：
   * 只把路由参数转成 PlayMedia 交给宿主 —— 解析（含公告兜底）、续播、弹幕、在线人数
   * 全部由 MediaPlaybackHost 完成，本页不再手写解析链路（原 130 行 startPlay 逻辑已删）。
   */
  useEffect(() => {
    const lid = route.params?.playLiveId;
    const directUrl = route.params?.playUrl;
    if (!lid && !directUrl) return;
    const isLive = route.params?.mode !== 'vod';
    const title = route.params?.playTitle || t('直播');
    const cover = normalizeUrl(route.params?.playCover || '');
    // 小窗回大窗／播放列表带入的续播位置（宿主 initialPosition 优先用它）
    setPendingResumeAt(Number(route.params?.playPosition) || 0);
    // 来源 tab（首页直达带 playFrom='Home'）：本次播放期间记住，关闭播放器时回跳。
    // 只认这次直达的参数 —— 之后用户从列表点卡片播放（startPlay）会清掉，避免路由上
    // 残留的旧参数把「退出播放」错误地弹回首页。
    mediaFromRef.current = String(route.params?.playFrom || '');
    setMedia({
      kind: isLive ? 'live' : 'replay',
      url: directUrl || '',
      title,
      cover,
      liveId: String(lid || ''),
      // 明确直播/回放语义（与 mode 一致）：避免 m3u8/mp4 二义流再走一次列表探测
      isLive,
      // 电台直播（首页直播卡带过来的 liveType=2）：首帧就用照片轮播，不闪「成员离开」
      radio: isLive && Number(route.params?.playLiveType) === 2,
      // nickname / team 从路由参数带入（历史/稍后再看跳来时）：meta 的 owner/team 靠它取，
      // 记录观看历史时也靠它保留成员名与队伍徽章（成员库还没同步的设备也能保住队伍）
      owner: String(route.params?.playOwner || ''),
      team: String(route.params?.playTeam || ''),
      ownerId: String(route.params?.playOwnerId || ''),
      // raw：供「进入房间」按钮做成员反查（与列表点击同一条 findMemberByHint 链路）
      raw: {
        liveId: String(lid || ''),
        title,
        liveType: Number(route.params?.playLiveType) || undefined,
        liveCover: cover,
        nickname: String(route.params?.playOwner || ''),
        team: String(route.params?.playTeam || ''),
        ownerId: String(route.params?.playOwnerId || ''),
        userId: String(route.params?.playOwnerId || ''),
      },
    });
    /**
     * 录播/回放：顺带把 tab 切到「录播」，让用户退出播放时看到的是录播列表。
     *
     * ⚠️ 但**从历史 / 稍后再看跳进来时不要切**（用户 2026-09-30：「从稍后再看出来还容易
     * 直接卡住」）：切 tab 会触发 doFetch('vod') 拉整页录播列表并渲染整个网格，
     * 而这条路径的用户退出播放是回到列表页，根本不会看这个 tab。
     */
    if (!isLive && tab !== 'vod' && !route.params?.fromWatch) switchTab('vod');
  }, [route.params?.playLiveId, route.params?.playUrl, route.params?.playNonce]);

  useEffect(() => {
    setTabBarHidden(!!media);
    return () => setTabBarHidden(false);
  }, [media, setTabBarHidden]);

  // 从房间导航进来时，房间页失焦会把 tabBarHidden 重置为 false；
  // 这里在获得焦点时兜底一次，确保播放状态下底部导航始终隐藏。
  useFocusEffect(useCallback(() => {
    if (media) setTabBarHidden(true);
  }, [media, setTabBarHidden]));

  /**
   * 硬件 / 手势返回：**必须与左上角关闭按钮走同一条出口**（closePlayer）。
   *
   * 这里以前是直接 `setLiveImmersiveMode(false)` + `setPlaying(null)` —— 只关播放器、
   * 不做任何来源判断，于是从「历史 / 稍后再看」进来时返回键会留在 Media（直播）页，
   * 回不到原列表（用户反馈「历史和稍后再看退出后不要到直播界面」）。
   * closePlayer 定义在下方若干行（普通函数，每次渲染重建）→ 用 ref 转发避免 TDZ。
   */
  const closePlayerRef = useRef<() => void>(() => {});
  /** 本次播放的来源 tab（首页直达带 playFrom）：关闭播放器时回跳（见 closePlayer） */
  const mediaFromRef = useRef('');
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!media) return false;
      closePlayerRef.current();
      return true;
    });
    return () => subscription.remove();
  }, [media]);

  const doFetch = useCallback(async (mode: 'live' | 'vod', cursor = 0, append = false, silent = false, userId?: string | number) => {
    if (loadingRef.current[mode]) {
      // 上一次同 tab 请求还在飞：早退必须顺手把下拉刷新的指示器复位，
      // 否则用户下拉撞上在飞的请求时，转圈会永远留在那里没人关（见 RefreshControl 注释）。
      setRefreshing(false);
      return;
    }
    loadingRef.current[mode] = true;
    if (!silent) setLoading(true);
    setError('');
    try {
      let finalCursor = cursor;
      // 官方坑（桌面基线 fetchLiveList / 48tools 同款修复）：next=0 时带 userId 查询拿不到数据，
      // 需先发一次不带 userId 的请求取列表最新 liveId 作为 next，再按成员直查。
      if (userId !== undefined && userId !== null && userId !== '' && Number(cursor) === 0) {
        const probe = await pocketApi.getLiveList({ next: 0, record: mode === 'vod', debug: true }).catch(() => null);
        if (probe) {
          const probeList = normalizeLiveList(probe);
          const probeNext = Number((probe as any)?.content?.next ?? (probe as any)?.data?.next ?? 0) || 0;
          if (probeList[0]?.liveId) finalCursor = Number(probeList[0].liveId) || probeNext || 0;
          else if (probeNext) finalCursor = probeNext;
        }
      }
      const res = await pocketApi.getLiveList({ next: finalCursor, record: mode === 'vod', debug: true, userId });
      // 空壳防护：官方接口偶发 success/200 但缺 liveList 字段（限流/风控/异常）→
      // normalizeLiveList 会解出空数组，把"有直播/录播"误覆盖成"暂无数据"（用户可感知的概率性空态）。
      // 结构里确实没有 liveList 数组视为请求异常（抛错走 catch 保留旧列表）；仅真为 [] 才落空。
      const shellList = (res?.content ?? res?.data ?? res)?.liveList;
      if (!Array.isArray(shellList)) throw new Error('live list empty shell');
      const next = normalizeLiveList(res);
      const nextToken = Number((res as any)?.content?.next ?? (res as any)?.data?.next ?? (res as any)?.next ?? 0) || 0;
      nextCursorRef.current = nextToken; // 翻页用最新游标，避免闭包读到旧值重复拉同一页
      // 翻页终止条件：本页有数据 且 游标确有前进（nextToken>0 且不等于本次请求的 cursor）。
      // 加 `nextToken !== cursor` 兜底，防止接口返回不变游标却持续吐相同数据导致的死循环。
      setHasMore(next.length > 0 && nextToken > 0 && nextToken !== cursor);
      if (mode === 'live') setLiveList((prev) => (append ? mergeUniqueLiveItems(prev, next) : next));
      else setVodList((prev) => (append ? mergeUniqueLiveItems(prev, next) : next));
    } catch (err) {
      // 静默轮询失败（60s 自动刷新）不弹错误条：保留旧列表继续展示，下一轮自愈；
      // 仅首屏/下拉/切 tab（silent=false）失败才提示（列表为空时不会误显示"暂无数据"）。
      //
      // ⚠️ 这里必须无条件关掉分页（hasMore=false），**不要**只对非静默失败关：
      // 下方自动翻页 effect 的依赖里有 pageVersion，而 doFetch 的 finally 每次都会
      // 递增 pageVersion → 若失败后 hasMore 仍为 true，effect 会立刻再翻下一页、
      // 再失败、再递增……形成重试风暴（搜索/成员筛选分支还没有 60 页上限）。
      if (!silent) setError(errorMessage(err));
      setHasMore(false);
    } finally {
      loadingRef.current[mode] = false;
      if (!silent) setLoading(false);
      setRefreshing(false);
      setPageVersion((v) => v + 1); // 通知自动翻页 effect：本次拉取完成，可继续下一页
    }
  }, []); // stable ref, reads groupId from groupIdRef

  const reloadList = useCallback(() => {
    // 刷新时保留当前列表内容，避免列表被清空导致骨架屏闪一下；
    // 仅当列表本就为空（首屏）时才走骨架屏逻辑。
    nextCursorRef.current = 0;
    setHasMore(true);
    doFetch(tab, 0);
  }, [doFetch, tab]);

  // initial load
  useEffect(() => {
    /**
     * ⚠️ 成员检索模式下**不要**在这里发「不带 userId」的全局请求（用户 2026-10-01 bug 修复）。
     *
     * 点选成员时 `setTab('vod')` 会触发本 effect，它发出的全局请求会先占住
     * `loadingRef['vod']`；紧接着「成员检索 effect」里的 userId 直查
     *   `doFetch('vod', 0, false, false, mid)`
     * 因 doFetch 开头「上一次同 tab 请求还在飞 → 早退」的守卫被**整段吞掉** ——
     * 最终列表里留下的是全局录播，看起来就是「选中成员名没有正确检索」。
     * 成员数据统一交给下面的成员检索 effect 带 userId 直查。
     */
    if (selectedMember && tab === 'vod') return;
    doFetch(tab, 0);
  }, [doFetch, tab, selectedMember]);

  // 选中成员时切到「回放」并重置列表，立即触发首屏加载。
  // 用 setTimeout(0) 让上面的 setState 先提交，避免读到切换前的旧 tab；
  // 覆盖「已在 vod tab 时初始加载 effect 不触发」以及「切 tab 时 loadingRef 把自动翻页挡掉」两种情况。
  // 成员检索改为服务端 userId 直查（对齐桌面基线/48tools）：getLiveList 带 userId 即返回该成员
  // 完整直播/录播，替代「全量加载全局列表再前端筛选」——旧实现只能筛到已加载页面内的数据，
  // 成员较早的录播永远搜不到。
  useEffect(() => {
    if (!selectedMember) return;
    const mid = String(selectedMember.id || (selectedMember as any).userId || (selectedMember as any).memberId || '');
    setVodList([]); setHasMore(true);
    setTab('vod');
    const id = setTimeout(() => doFetch('vod', 0, false, false, mid), 0);
    return () => clearTimeout(id);
  }, [selectedMember, doFetch]);

  // 退出成员筛选（selectedMember 清空）时恢复全局录播列表：成员模式下 vodList 存的是该成员数据，
  // 不恢复会导致后续「全部/团/关注」看到的是残留的成员列表。
  const prevMemberRef = useRef<any>(null);
  useEffect(() => {
    if (prevMemberRef.current && !selectedMember && tab === 'vod') {
      setVodList([]); setHasMore(true);
      doFetch('vod', 0);
    }
    prevMemberRef.current = selectedMember;
  }, [selectedMember, doFetch, tab]);

  // 搜索 / 选中成员 / 「关注」tag：自动翻页补齐更多数据（关注录播常分散在多页，只加载首屏会找不到）
  // 未筛选时（无搜索、无成员、非关注）不自动翻页，仅靠用户上滑 onEndReached 触发。
  const filterPages = useRef(0);
  // 并行翻页可用性（state 驱动：false 时本 effect 接管游标链）
  const [pageModeOk, setPageModeOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (loadingRef.current[tab] || loading) return;
    const haveFilter = !!search.trim() || !!selectedMember || groupId === -1;
    if (!haveFilter || !hasMore) return;
    if (selectedMember && tab !== 'vod') return; // 成员检索固定在录播页，等 tab 切到 vod 再翻
    // 「关注」录播：并行扫描进行中不重复走游标链；扫描完成后从最深处继续兜底补更老录播
    // ⚠️ 成员检索模式必须排除（用户 2026-10-01 bug 修复）：该模式下关注扫描已被跳过
    //（scanDoneRef 永远不为 true），若还在这里 return，成员列表就**永远只加载第一页**
    //—— 直接走游标链翻页即可（loadMore 会带上该成员 userId）。
    if (!selectedMember && groupId === -1 && tab === 'vod' && pageModeOk !== false && !scanDoneRef.current) return;
    // 「关注」tag 翻页上限：最多补 60 页（1200 条），覆盖被新录播挤到深处的关注成员；静默加载不闪控件
    if (groupId === -1) {
      if (filterPages.current >= 60) return;
      filterPages.current += 1;
    }
    // 静默翻页（silent=true）：这是后台补齐数据，不该点亮下拉刷新指示器
    const id = setTimeout(() => loadMore(true), 60);
    return () => clearTimeout(id);
  }, [search, selectedMember, hasMore, loading, tab, groupId, pageVersion, pageModeOk]);

  // 筛选条件变化时重置翻页计数
  useEffect(() => {
    filterPages.current = 0;
  }, [search, selectedMember, groupId]);

  // 「关注」录播快速并行扫描：
  // 实测口袋 getLiveList 的游标 = 上一页最后一条的 liveId，且 liveId 随时间近似线性增长（约 2^22/ms），
  // 因此可按「时间分片」一次性并行拉取近 48 小时的录播（每片约一页），再以相邻真实边界的中点闭合间隙；
  // 游标不可跳（探针失败）时自动退回上面的游标链。
  const followLoadingRef = useRef(false);
  const [followFetching, setFollowFetching] = useState(false);
  const scanDoneRef = useRef(false);
  // 关注成员录播：并发按 userId 服务端直查（用户指定实现）——
  // 不再"扫描全局流 48h 再前端筛选"（慢且命中率低），直接对每个关注成员的 userId 调
  // getLiveList({ userId }) 拿 TA 专属录播，合并去重。桌面基线/48tools 同款能力。
  /**
   * ★ 结果缓存（用户 2026-10-01 性能优化）：每次切到录播 tab 都重扫 8 个成员接口
   * （真机日志：1-2s 的 JS/网络占用）。现在缓存「userId → 最近一页」，3 分钟内
   * 重复进入直接回放缓存（瞬时渲染），过期才重新扫描。下拉刷新走 refreshTick 强制重扫。
   */
  const followVodCacheRef = useRef<{ at: number; data: Array<{ uid: string; items: any[] }> } | null>(null);
  const loadFollowVodFast = useCallback(async () => {
    // 成员检索模式（selectedMember）让位：并发扫描是「关注」视图的能力，不能污染成员直查结果
    if (followLoadingRef.current || groupId !== -1 || tab !== 'vod' || selectedMemberRef.current) return;
    if (!useSettingsStore.getState().settings.p48Token) { scanDoneRef.current = true; return; }
    followLoadingRef.current = true;
    setFollowFetching(true);
    const t0 = Date.now();
    const PAGE_SIZE = 100;
    const startTimeOf = (it: any) => Number(it?.startTime || it?.ctime || 0);
    const merge = (items: any[]) => setVodList((prev) => {
      const merged = mergeUniqueLiveItems(prev, items);
      return merged.sort((a: any, b: any) => (startTimeOf(b) - startTimeOf(a)) || 0);
    });
    try {
      // 0) 缓存命中：3 分钟内直接回放，不碰网络
      const cached = followVodCacheRef.current;
      if (cached && Date.now() - cached.at < 3 * 60 * 1000) {
        for (const { items } of cached.data) merge(items);
        scanDoneRef.current = true;
        return;
      }
      // 1) 关注成员 id 列表
      const idsRes = await pocketApi.getFollowedIds().catch(() => null);
      const ids = idsRes ? unwrapList(idsRes, ['content.data', 'content', 'data', 'list']).map(String) : [];
      // 2) 从成员库提取关注成员 userId（多候选：id/userId/memberId）
      const userIds: string[] = [];
      const seen = new Set<string>();
      for (const m of members) {
        const mid = String((m as any).id || (m as any).userId || (m as any).memberId || '');
        if (mid && ids.includes(mid) && !seen.has(mid)) { seen.add(mid); userIds.push(mid); }
      }
      // 3) 并发按 userId 直查（每批 8 并发，防瞬间打爆接口）
      if (!userIds.length) {
        // 关注列表为空/未匹配到成员：兜底拉全局最新一页，避免"暂无"误导
        const page1 = await pocketApi.getLiveList({ next: 0, record: true, debug: true, size: PAGE_SIZE }).catch(() => null);
        if (page1) merge(normalizeLiveList(page1));
        scanDoneRef.current = true;
        return;
      }
      const BATCH = 8;
      const cacheData: Array<{ uid: string; items: any[] }> = [];
      for (let i = 0; i < userIds.length; i += BATCH) {
        // 中途让位：切换分组 / 用户在扫描期间选中了某个成员 → 立即停止继续 merge
        if (groupId !== -1 || selectedMemberRef.current) return;
        const chunk = userIds.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          chunk.map((uid) => pocketApi.getLiveList({ next: 0, record: true, debug: true, size: PAGE_SIZE, userId: uid })),
        );
        let got = 0;
        for (let k = 0; k < results.length; k += 1) {
          const r = results[k];
          if (r.status !== 'fulfilled') continue;
          const items = normalizeLiveList(r.value);
          if (items.length) { got += 1; merge(items); cacheData.push({ uid: chunk[k], items }); }
        }
        setPageVersion((v) => v + 1);
        console.info(`[FollowVod] userId 直查批次 ${i / BATCH + 1}/${Math.ceil(userIds.length / BATCH)} 命中成员=${got}/${chunk.length}`);
      }
      followVodCacheRef.current = { at: Date.now(), data: cacheData };
      console.info(`[FollowVod] userId 并发直查完成 members=${userIds.length} 耗时=${Date.now() - t0}ms`);
    } catch (e) {
      console.warn('[FollowVod] userId 直查失败，退回游标链', e);
      setPageModeOk(false);
    } finally {
      followLoadingRef.current = false;
      setFollowFetching(false);
      scanDoneRef.current = true;
    }
  }, [groupId, tab, members]);

  // 进入「关注」录播视图或下拉刷新后触发并行扫描
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    // 成员检索模式跳过关注扫描（用户 2026-10-01 bug 修复）：扫描结果会 merge 进 vodList，
    // 把「该成员的录播」掺成「关注成员的录播」
    if (selectedMember) return;
    if (groupId === -1 && tab === 'vod' && token) {
      scanDoneRef.current = false;
      loadFollowVodFast();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, tab, refreshTick, selectedMember]);

  // 关注成员 id 同步（60s 一次；state 声明在组件上部供「关注」tag 筛选使用）
  useEffect(() => {
    let alive = true;
    const load = () => pocketApi.getFollowedIds().then((res) => {
      if (!alive) return;
      const ids = unwrapList(res, ['content.data', 'content', 'data', 'list']).map(String);
      setFollowedIds(new Set(ids));
    }).catch(() => {});
    load();
    // 后台不轮询：省电省流量（原先这些定时器在 App 切后台后仍全速跑）
    const id = setInterval(() => { if (AppState.currentState === 'active') load(); }, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // 直播列表实时自动刷新：浏览直播 tab 且未播放时每 60s 静默重拉（关注成员开播即时可见）
  useEffect(() => {
    if (tab !== 'live' || media) return;
    // 后台不轮询：省电省流量（原先这些定时器在 App 切后台后仍全速跑）
    const id = setInterval(() => { if (AppState.currentState === 'active') doFetch('live', 0, false, true); }, 60000);
    return () => clearInterval(id);
  }, [tab, media, doFetch]);

  useEffect(() => () => {
    setLiveImmersiveMode(false);
    followSystem();
  }, []);

  // 切到后台时释放方向锁（防退到桌面/其它 App 仍锁横屏）；
  // 回到前台时按全局播放器全屏状态重新锁定（后台释放后上方 effect 不会再触发，需在此补锁）。
  // 全屏判定改用 playerStore.fullscreen —— 原先读本地 isFullscreen/isLandscape，
  // 两者都是恒 false 的死状态，导致「回前台永远是竖屏」。
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        // ⚠️ 进系统 PiP 时 AppState 也会报 background（原生 PipEnteredChanged 事件随后才到），
        // 若立即释放方向锁会和 PiP 转场竞争 → 直播黑屏/冻结（用户反馈「系统小窗中断直播」）。
        // 所以延迟确认：600ms 后仍不在 PiP 才按「真退后台」处理。
        setTimeout(() => {
          if (!isPipActive()) followSystem();
        }, 600);
      } else if (media) {
        const wantLandscape = !!usePlayerStore.getState().fullscreen;
        applyOrientation(wantLandscape ? 'landscape' : 'follow');
      }
    });
    return () => sub.remove();
  }, [media]);

  const closePlayer = () => {
    setLiveImmersiveMode(false);
    followSystem();
    // 关闭即卸载宿主（卸载会自动作废在途解析，并停止弹幕/轮询/内核）
    setMedia(null);
    setPendingResumeAt(0);
    /**
     * 从「历史 / 稍后再看」进来的：关闭播放器要回到**那个列表本身**。
     *
     * ⚠️ 必须按页名 navigate（`watchFrom`，由 MediaListPage 带过来）：
     *   · 这两个页面是**根栈页面**（旧注释「它们留在 Settings tab 的栈里」是错的），
     *     入口在设置页只是 navigate 到根栈的 `HistoryScreen` / `WatchLaterScreen`；
     *   · 进播放用的是 `navigate('Main', {screen:'Media'})`，会把根栈上的它们 pop 掉，
     *     所以 `goBack()` 回不去（上一页已经卸载）—— 这正是用户反馈
     *     「退出后跑到直播页/设置页」的原因。
     * 兜底：老调用方只带了 fromWatch（无 watchFrom）→ 回设置 tab，至少不停在直播页。
     */
    const watchFrom = String(route.params?.watchFrom || '');
    // 诊断（用户 2026-10-01「看完回到本来的页面，不要去直播页」）：回跳分支的走向落一条日志
    logInfo(`[watch] closePlayer: fromWatch=${!!route.params?.fromWatch} watchFrom=${watchFrom || '(无)'} fromRoom=${!!route.params?.fromRoom}`, 'watch');
    if (watchFrom) {
      /**
       * ★ 先把 Main 的活跃 tab 恢复到 Settings，再回到列表页（用户 2026-10-01：
       * 「退出观看历史应该回到设置，怎么到直播界面了」）。
       * 根因：进播放器用的是 navigate('Main', {screen:'Media'}) —— 它把 Main 的
       * 活跃 tab 从 Settings 切到了 Media；之后用户在历史页按返回键 goBack 回 Main，
       * Main 显示的是**上次活跃的 tab（Media）**＝「跑到直播界面」。
       * 先 navigate 回 Settings tab，退出历史页后 goBack 落在设置上。
       */
      navigation.navigate('Main', { screen: 'Settings' });
      navigation.navigate(watchFrom as any);
      return;
    }
    if (route.params?.fromWatch) {
      navigation.navigate('Main', { screen: 'Settings' });
      return;
    }
    /**
     * 首页直达（公演直播卡 / 首页直播卡，playFrom='Home'）：关闭播放器 = **回到首页**。
     * 用户 2026-10-04：「生日会退出之后怎么没有留在主页而是到了直播页」——
     * 首页跳转是 tab 切换（不是根栈 push），不走 goBack，不显式切回就会停在 Media（直播页）。
     */
    const playFrom = mediaFromRef.current;
    mediaFromRef.current = '';
    if (playFrom) {
      // 诊断（用户 2026-10-04「生日会退出之后怎么没有留在主页」）：回跳分支的走向落一条日志
      logInfo(`[media] closePlayer: 回来源 ${playFrom}`, 'media');
      navigation.navigate(playFrom as any);
      return;
    }
    // fromRoom 直达（房间点开）：关闭播放器 = 返回房间
    if (route.params?.fromRoom) navigation.goBack();
  };
  // 供硬件返回键调用（见上方 BackHandler 的 closePlayerRef）：始终指向最新的 closePlayer
  closePlayerRef.current = closePlayer;

  // 应用内小窗交棒已收口到统一播放宿主（用户 2026-10-02）：
  // 「小窗」按钮、交棒前重新解析新签名流、位置/宽高透传全部在 MediaPlaybackHost 内，
  // 本页只保留系统画中画（PiP）的比例同步（见下方 onVideoSize）。

  // fromRoom 直达（房间点开）的关闭回跳见 closePlayer（goBack 回房间）。
  // 注意：不能仅凭 playLiveId 判断来源 —— 首页直播卡跳转也带 playLiveId。
  // （旧实现曾用「首帧未播放即 navigate('Rooms')」导致房间点播「第一次必进不去播放器」，已删除。）

  const switchTab = (next: 'live' | 'vod') => {
    setTab(next);
    nextCursorRef.current = 0;
    setHasMore(true);
    // rely on useEffect to trigger fetch
  };

  // 从首页快捷入口二次进入时，React Navigation 可能复用 MediaScreen 实例，
  // useState 初始值不会重算 → 手动切过的 tab 残留。这里用 params.mode 兜底同步，
  // 让用户「点回放进去就是录播、点直播进去就是直播」，与离开前停留的 tab 无关。
  useEffect(() => {
    const mode = route.params?.mode;
    if (mode === 'live' || mode === 'vod') {
      setTab((prev) => (prev === mode ? prev : mode));
      nextCursorRef.current = 0;
      setHasMore(true);
    }
  }, [route.params?.mode]);

  const refreshList = () => {
    setRefreshing(true);
    reloadList();
    // 关注录播下拉刷新后重新触发并行翻页（否则只剩第一页）
    setRefreshTick((v) => v + 1);
  };

  const loadMore = (silent = false) => {
    if (loading || loadingRef.current[tab] || !hasMore) return;
    const mid = selectedMember ? String(selectedMember.id || (selectedMember as any).userId || (selectedMember as any).memberId || '') : undefined;
    doFetch(tab, nextCursorRef.current, true, silent, mid || undefined);
  };

  /**
   * 列表点卡片 → 交给统一播放宿主（用户 2026-10-02）。
   *
   * 这里只做「构造 PlayMedia」+ 清场（公告/沉浸复位）；解析（详情/公开详情/列表兜底、
   * 公告补拉见 handleResolved）、快速起播、失败重试、代次守卫全部在宿主内完成 ——
   * 原来 100 多行的手写解析链与 playSeqRef 竞态守卫已删除。
   */
  const startPlay = (item: VODItem) => {
    const preferLive = tab === 'live';
    setError('');
    setLiveImmersiveMode(false);
    setPendingResumeAt(0);
    // 列表内点播：来源是本站，退出播放留在直播页（清掉可能残留的首页来源标记）
    mediaFromRef.current = '';
    const urls = pickPlayableUrls(item, preferLive);
    setMedia({
      kind: preferLive ? 'live' : 'replay',
      url: urls[0] || '',
      urls,
      title: item.title || item.liveRoomTitle || t('直播 / 回放'),
      cover: item.liveCover || item.coverPath,
      liveId: String(item.liveId || ''),
      // tab 预判直播/回放（与旧行为一致）：vod tab 一律按录播（可拖进度条）
      isLive: preferLive,
      // 成员名 + 队伍 + 数字 id：历史记录/稍后再看列表卡片要用（播放器不显示）
      owner: String((item as any)?.nickname || (item as any)?.ownerName || ''),
      team: resolveTeam(
        memberLookup,
        {
          userId: (item as any)?.userInfo?.userId || (item as any)?.userId || (item as any)?.ownerId || '',
          name: (item as any)?.nickname || (item as any)?.ownerName || '',
        },
        (item as any)?.team || '',
      ),
      ownerId: String((item as any)?.userInfo?.userId || (item as any)?.userId || (item as any)?.ownerId || ''),
      /**
       * 电台直播（liveType=2，用户 2026-11-04）：
       * 官方推流画面只有「成员离开」的占位图，播放器要用成员照片轮播作为画面
       *（照片来自 getLiveOne → content.carousels，由播放宿主补拉）。
       * 列表项已带 liveType → 首帧就是轮播形态，不会先闪一下那张占位图。
       */
      radio: preferLive && Number((item as any)?.liveType) === 2,
      raw: item,
    });
  };

  const openGiftPanel = async () => {
    const cur = mediaRef.current;
    if (!cur?.liveId) {
      setGiftStatus(t('当前直播缺少 liveId，不能送礼'));
      setGiftVisible(true);
      return;
    }
    setGiftVisible(true);
    setGiftStatus('');
    setSelectedGift(null);
    setGifts([]); // ⚠️【串台修复】先清空旧直播间的礼物格，避免新请求返回前显示上一间的列表
    try {
      const [giftRes, moneyRes] = await Promise.all([
        pocketApi.getGiftList(String(cur.liveId)),
        pocketApi.getUserMoney().catch(() => null),
      ]);
      const next = normalizeGiftList(giftRes);
      setGifts(next);
      setBalance(moneyRes?.content?.moneyTotal !== undefined ? String(moneyRes.content.moneyTotal) : '');
      setGiftStatus(next.length ? t('已加载 {count} 个礼物', { count: next.length }) : t('礼物列表为空'));
    } catch (err) {
      setGifts([]);
      setGiftStatus(t('加载礼物失败：{error}', { error: errorMessage(err) }));
    }
  };

  const sendGift = async () => {
    const cur = mediaRef.current;
    if (!cur || !selectedGift) {
      setGiftStatus(t('请先选择礼物'));
      return;
    }
    const num = Math.max(1, Math.floor(Number(giftNum) || 1));
    const targetUserId = acceptUserId(cur.raw);
    if (!targetUserId) {
      setGiftStatus(t('无法获取主播 ID，不能送礼'));
      return;
    }
    setGiftStatus(t('正在发送...'));
    try {
      await pocketApi.sendGift({
        giftId: String(selectedGift.giftId || selectedGift.id),
        liveId: String(cur.liveId || ''),
        acceptUserId: targetUserId,
        giftNum: num,
      });
      /**
       * ⚠️ 礼物公屏广播（用户反馈 2026-09-29：「我送礼物，主播看不到我送的」）。
       * HTTP 送礼接口只扣款/入账；直播间里的礼物公屏**是客户端发到云信聊天室的**
       *（官方客户端同款 PRESENT_NORMAL）—— 别人送的能看到，就是因为对方发了这条。
       * 广播走统一播放宿主内的同一条云信连接（宿主 ref 暴露）。
       * 广播失败一律静默：礼物已经送出，公屏失败不该把「已送出」变成失败提示。
       */
      const toName = pickText(cur.raw, [
        'userInfo.nickName',
        'userInfo.nickname',
        'user.nickName',
        'user.nickname',
        'nickname',
        'nickName',
        'ownerName',
        'title',
      ]) || String((playingMember as any)?.ownerName || '');
      playbackHostRef.current?.sendGiftBroadcast({
        toUserId: targetUserId,
        toName,
        giftId: String(selectedGift.giftId || selectedGift.id),
        giftName: giftName(selectedGift),
        giftNum: num,
        giftPic: giftImage(selectedGift),
      });
      setGiftStatus(t('已送出 {num} 个 {giftName}', { num, giftName: giftName(selectedGift) }));
      const money = await pocketApi.getUserMoney().catch(() => null);
      if (money?.content?.moneyTotal !== undefined) setBalance(String(money.content.moneyTotal));
    } catch (err) {
      setGiftStatus(t('送礼失败：{error}', { error: errorMessage(err) }));
    }
  };

  const openRankPanel = async () => {
    const cur = mediaRef.current;
    if (!cur?.liveId) {
      setRankRows([]);
      setRankStatus(t('当前直播缺少 liveId，不能获取贡献榜'));
      setRankVisible(true);
      return;
    }
    setRankVisible(true);
    setRankStatus('');
    setRankRows([]); // ⚠️【串台修复】先清空旧直播间的榜单，避免新请求返回前显示上一间的贡献榜
    try {
      const res = await pocketApi.getLiveRank(String(cur.liveId));
      const rows = normalizeLiveRank(res);
      setRankRows(rows);
      if (rows.some((row, index) => row.userId && (!row.avatar || rankNameIsFallback(row, index)))) {
        setRankStatus(t('正在补充 {count} 位贡献用户资料...', { count: rows.length }));
        const enriched = await Promise.all(rows.map(async (row, index) => {
          if (!row.userId || (row.avatar && !rankNameIsFallback(row, index))) return row;
          try {
            const profile = profileFromUserRes(await pocketApi.getUserProfile(String(row.userId)));
            return { ...row, name: profile.name || row.name, avatar: profile.avatar || row.avatar };
          } catch {
            return row;
          }
        }));
        setRankRows(enriched);
        setRankStatus(enriched.length ? t('已加载 {count} 位贡献用户', { count: enriched.length }) : t('贡献榜为空'));
      } else {
        setRankStatus(rows.length ? t('已加载 {count} 位贡献用户', { count: rows.length }) : t('贡献榜为空'));
      }
    } catch (err) {
      setRankRows([]);
      setRankStatus(t('贡献榜加载失败：{error}', { error: errorMessage(err) }));
    }
  };

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('LivePlayerGiftRequested', () => {
      const current = mediaRef.current;
      if (!current?.isLive) {
        setGiftStatus(t('当前没有可送礼的直播上下文'));
        setGiftVisible(true);
        return;
      }
      openGiftPanel();
    });
    return () => sub.remove();
  }, []);

  // PiP 退出兜底 remount key：Dimensions 在 Android 上对 windowMode 变化未必刷新，
  // 万一 key 随 winW 没翻也没法触发 FlatList 重挂载 → 直接 bump 这个 nonce 强制 remount。
  // 注意：这只是已知 MediaScreen 直播网格的局部兜底；其他类似 FlatList 屏按需补。
  const [pipRemount, setPipRemount] = useState(0);
  /**
   * 是否处于系统小窗（PiP）。
   * ⚠️ 系统 PiP 的画面 = **整个 Activity 窗口的快照**，不是单独抓媒体层。
   * 所以播放器页上任何浮层（公告面板、弹幕列表抽屉…）都会一起被拍进小窗里
   * —— 用户反馈「小窗会带着直播公告」就是这个原因。
   * 进 PiP 时把播放器浮层全部隐藏，保证小窗里只有画面。
   */
  const [inSystemPip, setInSystemPip] = useState(false);
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('PipEnteredChanged', (entered: boolean) => {
      setInSystemPip(!!entered);
      if (!entered) setPipRemount((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  // 画面实际尺寸 → PiP 窗口比例（切后台悬浮窗跟随内容方向）。
  // 原先这套逻辑挂在未接线的 autoOrient 里（定义后无人引用，纯死代码），
  // 同时它还会写本地 isLandscape 去「自动横竖屏」—— 全局横屏后方向交给系统，
  // 不再由视频比例强制切方向（用户在竖屏看横屏视频是合理需求）。
  const onVideoSize = useCallback((w: number, h: number) => {
    if (!(w > 0) || !(h > 0)) return;
    // 系统 PiP 窗口比例跟随内容（应用内小窗的宽高由宿主自己记录）
    setPipAspect(w, h);
  }, []);

  /**
   * 控制坞按钮（函数形式：礼物只在直播显示，需要解析后的 isLive）：
   * 进入房间 / 礼物 / 贡献榜 —— 公告、弹幕设置、弹幕列表、小窗由宿主统一追加。
   */
  const mediaExtraActions = useCallback((ctx: { isLive: boolean }) => ([
    ...(playingMember ? [{ key: 'room', icon: 'account-group', label: t('进入房间'), onPress: () => (navigation as any).navigate('Rooms', { openMemberId: playingMember.id }) }] : []),
    ...(ctx.isLive ? [{ key: 'gift', icon: 'gift', label: t('礼物'), onPress: () => openGiftPanel() }] : []),
    { key: 'rank', icon: 'trophy', label: t('贡献榜'), onPress: () => openRankPanel() },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ]), [t, playingMember, navigation]);

  if (media) {
    return (
      <View style={styles.playerPage}>
        {/* 统一播放宿主（用户 2026-10-02）：解析（含解析中/失败 shell）、续播与进度、
            弹幕（云信飘屏/输入条/弹幕列表/LRC）、在线人数、公告、小窗交棒全部由它完成。
            本页只保留主直播页特有内容：
              · 礼物 / 贡献榜 / 弹幕资料卡（afterPlayer）
              · 控制坞按钮（extraActions：进入房间 / 礼物 / 贡献榜） */}
        <MediaPlaybackHost
          ref={playbackHostRef}
          media={media}
          /* 点标题进房间：成员库反查到的 id 比 media.ownerId 更可靠（未登录/旧数据也能进） */
          roomMemberId={playingMember ? String(playingMember.id) : undefined}
          onClose={() => { setPipPlaying(false); closePlayer(); }}
          /* 直播间公告（含录播）：宿主统一拉取 + 面板 + 顶栏/控制坞按钮 + 展开态持久化 */
          announcement
          initialPosition={pendingResumeAt}
          /* 与历史行为一致：直播弹幕 HTTP 轮询兜底（5s）+ 回放弹幕到达 toast */
          danmakuLivePollMs={5000}
          danmakuVodNotice
          onOpenDanmakuProfile={(entry) => setDanmakuProfile({ nick: entry.nick, avatar: entry.avatar, userId: entry.userId != null ? String(entry.userId) : undefined })}
          onVideoSize={onVideoSize}
          /* 系统 PiP：快照会拍进浮层 → 隐藏弹幕列表/设置面板/公告面板（宿主统一判断） */
          hideSheets={inSystemPip}
          extraActions={mediaExtraActions}
          afterPlayer={(
            <>
              {/* 弹幕列表点发送者 → 用户资料卡（含关注/取消关注 + 私信） */}
              <UserProfileSheet
                visible={!!danmakuProfile}
                target={danmakuProfile}
                onClose={() => setDanmakuProfile(null)}
                onOpenChat={({ id, name }) => {
                  setDanmakuProfile(null);
                  navigation.navigate('PrivateMessagesScreen', { targetUserId: id, targetName: name });
                }}
              />

              <Modal visible={giftVisible} transparent animationType="slide" onRequestClose={() => setGiftVisible(false)}>
                <View style={styles.modalShade}>
                  <GlassSurface radius={20} role="card" style={[styles.giftPanel, isPlayerLandscape ? styles.giftPanelLandscape : null, { backgroundColor: 'transparent' }]}>
                    <View style={styles.giftHeader}>
                      <Text style={[styles.giftTitle, { color: palette.label }]}>{t('直播送礼')}</Text>
                      <TouchableOpacity onPress={() => setGiftVisible(false)} activeOpacity={0.8}>
                        <Text style={[styles.backBtnText, { color: palette.tint }]}>{t('关闭')}</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={[styles.giftTip, { color: palette.danger }]}>{t('直播送礼主播看不到赠送，仅能统计贡献值')}</Text>
                    <Text style={[styles.giftStatus, { color: palette.labelSecondary }]}>
                      {balance ? `${t('余额：{balance} 鸡腿', { balance })} · ` : ''}{giftStatus}
                    </Text>
                    <ScrollView style={[styles.giftGrid, isPlayerLandscape ? styles.giftGridLandscape : null]}>
                      <View style={styles.giftGridInner}>
                        {gifts.map((gift) => {
                          const active = String(selectedGift?.giftId || selectedGift?.id) === String(gift.giftId || gift.id);
                          return (
                            <TouchableOpacity
                              key={String(gift.giftId || gift.id)}
                              style={[
                                styles.giftItem,
                                active && styles.giftItemActive,
                                { backgroundColor: active ? palette.tintSoft : palette.fill2, borderColor: active ? palette.tint : palette.hairline },
                              ]}
                              onPress={() => setSelectedGift(gift)}
                              activeOpacity={0.85}
                            >
                              {giftImage(gift) ? <Image source={{ uri: giftImage(gift) }} style={styles.giftImage} /> : <View style={[styles.giftImage, { backgroundColor: palette.fill3 }]} />}
                              <Text style={[styles.giftName, { color: palette.label }]} numberOfLines={1}>{giftName(gift)}</Text>
                              <Text style={[styles.giftCost, { color: palette.tint }]}>{t('{count} 鸡腿', { count: giftCost(gift) })}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </ScrollView>
                    <View style={styles.giftFooter}>
                      <TextInput
                        style={[styles.giftNum, { color: palette.label, borderColor: palette.hairline, backgroundColor: palette.fill2 }]}
                        keyboardType="numeric"
                        value={giftNum}
                        onChangeText={setGiftNum}
                      />
                      <TouchableOpacity style={[styles.sendGiftBtn, { backgroundColor: palette.tint }]} onPress={sendGift} activeOpacity={0.85}>
                        <Text style={[styles.sendGiftText, { color: palette.onTint }]}>
                          {selectedGift ? t('送出 · {count}', { count: selectedGiftTotal }) : t('选择礼物')}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    <TouchableOpacity
                      style={styles.rechargeBtn}
                      onPress={() => {
                        setGiftVisible(false);
                        (navigation as any).navigate('RechargeScreen');
                      }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.rechargeText, { color: palette.tint }]}>{t('余额不足？去充值鸡腿')}</Text>
                    </TouchableOpacity>
                  </GlassSurface>
                </View>
              </Modal>
              <Modal visible={rankVisible} transparent animationType="slide" onRequestClose={() => setRankVisible(false)}>
                {/* 横屏贴右 + 实心黑底（与弹幕列表同风格，用户 2026-11-09） */}
                <View style={[styles.modalShade, isPlayerLandscape && styles.modalShadeLandscape]}>
                  <View style={[styles.giftPanel, isPlayerLandscape && styles.giftPanelLandscape, { backgroundColor: 'rgba(15,15,18,0.98)' }]}>
                    <View style={styles.giftHeader}>
                      <Text style={[styles.giftTitle, { color: 'rgba(255,255,255,0.94)' }]}>{t('贡献榜')}</Text>
                      <TouchableOpacity onPress={() => setRankVisible(false)} activeOpacity={0.8}>
                        <Text style={[styles.backBtnText, { color: 'rgba(255,255,255,0.75)' }]}>{t('关闭')}</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={[styles.giftStatus, { color: 'rgba(255,255,255,0.6)' }]}>{rankStatus}</Text>
                    <ScrollView style={[styles.rankList, isPlayerLandscape ? styles.rankListLandscape : null]}>
                      {rankRows.map((row, index) => (
                        <View key={String(row.userId || row.id || index)} style={[styles.rankRow, { borderBottomColor: 'rgba(255,255,255,0.08)' }]}>
                          {/* 黑白榜（用户 2026-11-09）：名次不用主题色，前三名白 0.95、其余白 0.5 */}
                          <Text style={[styles.rankNo, { color: index < 3 ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)' }]}>{row.rank || index + 1}</Text>
                          {row.avatar ? <Image source={{ uri: row.avatar }} style={[styles.rankAvatar, { backgroundColor: 'rgba(255,255,255,0.12)' }]} /> : <View style={[styles.rankAvatar, { backgroundColor: 'rgba(255,255,255,0.12)' }]} />}
                          <View style={styles.rankInfo}>
                            <Text style={[styles.rankName, { color: 'rgba(255,255,255,0.94)' }]} numberOfLines={1}>{row.name}</Text>
                            <Text style={[styles.rankValue, { color: 'rgba(255,255,255,0.6)' }]} numberOfLines={1}>{row.value ? t('贡献 {value}', { value: row.value }) : t('贡献用户')}</Text>
                          </View>
                        </View>
                      ))}
                    </ScrollView>
                  </View>
                </View>
              </Modal>
            </>
          )}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container]}>
      {/* 顶栏刷新按钮已去掉（用户 2026-11-11）：下拉 RefreshControl、60s 静默刷新、
          错误条重试继续复用 refreshList / reloadList，不要连带删掉 */}
      <ScreenHeader title={tab === 'live' ? t('直播') : t('录播')} hideBack />
      {/* 直播/录播分段控件：玻璃轨道 + 滑动玻璃选中胶囊（与底栏同一套） */}
      <GlassSegmented
        options={[
          { key: 'live', label: t('直播') },
          { key: 'vod', label: t('录播') },
        ]}
        value={tab}
        onChange={(k) => switchTab(k as 'live' | 'vod')}
        style={[styles.segmentWrap, { borderColor: palette.innerStroke, borderWidth: StyleSheet.hairlineWidth }]}
      />
      {/* 单行筛选：分组 = 玻璃滑动选中块（与底栏同一套） + 搜索图标 */}
      <View style={styles.filterRow}>
        <View style={{ flex: 1 }}>
          <GlassSegmentedScroll
            options={groupChips.map((item) => ({ key: String(item.id), label: t(item.label) }))}
            value={String(groupId)}
            onChange={(k) => setGroupId(Number(k))}
            height={34}
          />
        </View>
        <TouchableOpacity
          onPress={() => setShowSearch((v) => !v)}
          style={[styles.searchToggle, { backgroundColor: showSearch ? palette.tint : palette.fill2 }]}
          hitSlop={{ top: 8, bottom: 8 }}
          activeOpacity={0.85}
        >
          <MaterialCommunityIcons name={showSearch ? 'close' : 'magnify'} size={18} color={showSearch ? palette.onTint : palette.labelSecondary} />
        </TouchableOpacity>
      </View>
      {/* 搜索展开行 */}
      {showSearch ? (
        <View style={styles.searchWrap}>
          {selectedMember ? (
            <TouchableOpacity onPress={() => setSelectedMember(null)} style={[styles.memberChip, { backgroundColor: palette.tint }]} activeOpacity={0.85}>
              <Text style={[styles.memberChipText, { color: palette.onTint }]}>{selectedMember.ownerName}</Text>
              <MaterialCommunityIcons name="close" size={16} color={palette.onTint} style={{ marginLeft: 6 }} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={() => setShowCalendar(true)} style={[styles.calBtn, dateFilter && styles.calBtnActive]} hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}>
            <MaterialCommunityIcons name="calendar-month" size={20} color={dateFilter ? palette.tint : palette.labelSecondary} />
          </TouchableOpacity>
          <TextInput
            style={[
              styles.searchInput,
              {
                backgroundColor: palette.surfaceGlassStrong,
                borderColor: selectedMember ? palette.tint : palette.innerStroke,
                color: palette.label,
              },
            ]}
            placeholder={selectedMember ? t('搜索该成员的标题 / 日期...') : t('搜索成员名、标题、时间...')}
            placeholderTextColor={palette.labelTertiary}
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
          />
          {search.trim() ? (
            <TouchableOpacity onPress={() => setSearch('')} style={styles.searchClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialCommunityIcons name="close-circle" size={18} color={palette.labelTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      {dateFilter ? (
        <View style={styles.dateChipRow}>
          <TouchableOpacity style={[styles.dateChip, { backgroundColor: palette.tintSoft, borderColor: palette.tint }]} onPress={() => setShowCalendar(true)} activeOpacity={0.85}>
            <MaterialCommunityIcons name="calendar-month" size={14} color={palette.tint} />
            <Text style={[styles.dateChipText, { color: palette.tint }]}>{dateKeyOf(dateFilter)}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setDateFilter(null)} style={styles.dateChipClear} activeOpacity={0.85}>
            <MaterialCommunityIcons name="close-circle" size={16} color={palette.labelTertiary} />
          </TouchableOpacity>
        </View>
      ) : null}
      {memberHits.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.memberHits} contentContainerStyle={styles.memberHitsContent}>
          {memberHits.map((m) => (
            <TouchableOpacity
              key={m.id}
              style={[styles.memberHitChip, { backgroundColor: palette.fill2, borderColor: palette.hairline }]}
              onPress={() => { setSelectedMember(m); setSearch(''); }}
            >
              <Text style={[styles.memberHitText, { color: palette.labelSecondary }]}>{m.ownerName.split('-').pop()}</Text>
              {m.team ? <Text style={[styles.memberHitTeam, { color: palette.labelTertiary }]}>{m.team}</Text> : null}
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}

      {error ? (
        <View style={[styles.errorRow, { backgroundColor: palette.surfaceGlass, borderColor: palette.innerStroke, borderWidth: StyleSheet.hairlineWidth }]}>
          <Text style={[styles.error, { color: palette.labelSecondary }]} numberOfLines={2}>{error}</Text>
          <Button title={t('重试')} variant="tinted" size="sm" onPress={reloadList} />
        </View>
      ) : null}

      <CalendarSheet
        visible={showCalendar}
        initial={dateFilter}
        onSelect={(d) => { setDateFilter(d); setShowCalendar(false); }}
        onClose={() => setShowCalendar(false)}
      />

      <View style={{ flex: 1 }}>
        <PerfFlatList
          {...chromeScrollProps}
          key={tab === 'vod' ? 'vod-1col' : 'live-4col'}
          // 直播页统一四列小卡网格（用户要求「一行能显示四个」，与首页成员直播一致）；录播保持单列分组
          data={tab === 'vod' ? (vodRows ?? []) as any : list}
          keyExtractor={(item: any, index) => {
            const base = String(item?.liveId || item?.key || index);
            // ⚠️ PiP/横竖屏切换后需让 item 重挂以重测 aspectRatio:1(高=宽),
            // 但用 FlatList key 整体 remount 会丢滚动位置 → 改为 keyExtractor 拼
            // 窗口宽 + PiP 退出计数：cell 卸载重挂, VirtualizedList 保留 offset。
            return `${base}_${screen.width}_${pipRemount}`;
          }}
          numColumns={tab === 'vod' ? 1 : 4}
          columnWrapperStyle={tab === 'vod' ? null : styles.vodGridRow}
          // PiP/横竖屏切换后 winW 变化:extraData 不足以让已 measure 的子节点重测(Yoga 不会自动),
          // 关 removeClippedSubviews(grid 仅几行无虚拟化必要,且 Android PiP 后裁剪会留顶部残影)。
          extraData={screen.width}
          removeClippedSubviews={false}
          // 性能（用户反馈「全部」网格滑动严重掉帧）：限制同屏挂载的玻璃卡数量、加快批渲染。
          updateCellsBatchingPeriod={40}
          renderItem={({ item, index }) => {
            // 录播：一行四张小卡（与直播 tab 同款紧凑方格，用户要求）
            if (tab === 'vod') {
              if (item.type === 'header') {
                return (
                  <Text style={[styles.vodGroupTitle, { color: palette.labelTertiary }]}>{item.title}</Text>
                );
              }
              const renderCard = (it: any) => {
                if (!it) return <View style={styles.liveGridItem} />;
                const coverUrl = it.liveCover || it.coverPath;
                const meta = [it.nickname, formatTimestamp(it.startTime).slice(0, 16)].filter(Boolean).join(' · ');
                return (
                  <FadeInView duration={300} style={styles.liveGridItem}>
                    <TouchableOpacity
                      style={[styles.vodGridCard, { backgroundColor: 'transparent', borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}
                      onPress={() => startPlay(it)}
                      activeOpacity={0.88}
                    >
                      <View style={{ borderRadius: 12, overflow: 'hidden', backgroundColor: palette.fill3 }}>
                        <View style={[styles.vodGridCover, { backgroundColor: palette.fill3 }]}>
                          {coverUrl ? (
                            <Image source={{ uri: thumbUrl(coverUrl, GRID_COVER_THUMB) }} style={styles.vodGridCoverImg} resizeMode="cover" />
                          ) : (
                            <View style={styles.vodGridFallback}>
                            <MaterialCommunityIcons name="video" size={22} color={palette.labelTertiary} />
                          </View>
                        )}
                        <View style={[styles.v2Badge, styles.liveGridType, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                          <MaterialCommunityIcons
                            name={it.liveType === 2 ? 'radio' : 'video'}
                            size={9}
                            color="#FFFFFF"
                            style={{ marginRight: 2 }}
                          />
                          <Text style={styles.liveGridBadgeText}>{it.liveType === 2 ? t('电台') : t('视频')}</Text>
                        </View>
                        {/* 右上角徽标：时长（开播时间已显示在标题下方 meta） */}
                        <View style={styles.liveGridBadgeRow}>
                          {it.endTime && it.startTime ? (
                            <View style={[styles.v2Badge, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                              <Text style={styles.liveGridBadgeText}>
                                {formatDuration((it.endTime - it.startTime) / 1000)}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        {/* 底部平滑渐变遮罩（替代两层色阶） */}
                        <LinearGradient
                          pointerEvents="none"
                          colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.55)']}
                          style={styles.liveGridShade}
                        />
                        <View style={styles.liveGridInfo}>
                          <Text style={styles.liveGridTitle} numberOfLines={1}>
                            {it.title || it.liveRoomTitle || t('无标题')}
                          </Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                            {teamOfItem(it) ? <TeamBadge team={teamOfItem(it)} fontSize={8} /> : null}
                            {meta ? (
                              <Text style={styles.liveGridMeta} numberOfLines={1}>{meta}</Text>
                            ) : null}
                          </View>
                        </View>
                      </View>
                    </View>
                    </TouchableOpacity>
                  </FadeInView>
                );
              };
              return (
                <View style={styles.vodRow}>
                  {item.items.map((it: any, idx: number) => (
                    <React.Fragment key={`${item.key}-${idx}`}>{renderCard(it)}</React.Fragment>
                  ))}
                </View>
              );
            }
            // 直播：四列小卡网格（紧凑版样式 liveGrid*，与首页成员直播卡一致的小尺寸）
            const coverUrl = item.liveCover || item.coverPath;
            const meta = [item.nickname, formatTimestamp(item.startTime).slice(0, 16)].filter(Boolean).join(' · ');
            return (
              <FadeInView delay={index < 16 ? 80 + index * 30 : 0} duration={300} style={styles.liveGridItem}>
                <TouchableOpacity
                  style={[styles.vodGridCard, { backgroundColor: 'transparent', borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}
                  onPress={() => startPlay(item)}
                  activeOpacity={0.88}
                >
                  {/* 卡片不套玻璃：网格里每卡一个 BlurView 会逐帧重算模糊（用户反馈滑动掉帧），
                      且封面铺满、玻璃观感等于没有 —— 按设计系统「列表卡不用玻璃」用实底圆角 */}
                  <View style={{ borderRadius: 12, overflow: 'hidden', backgroundColor: palette.fill3 }}>
                  <View style={[styles.vodGridCover, { backgroundColor: palette.fill3 }]}>
                    {coverUrl ? (
                      <Image source={{ uri: thumbUrl(coverUrl, GRID_COVER_THUMB) }} style={styles.vodGridCoverImg} resizeMode="cover" />
                    ) : (
                      <View style={styles.vodGridFallback}>
                        <MaterialCommunityIcons name="video" size={22} color={palette.labelTertiary} />
                      </View>
                    )}
                    <View style={[styles.v2Badge, styles.liveGridType, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                      <MaterialCommunityIcons
                        name={item.liveType === 2 ? 'radio' : 'video'}
                        size={9}
                        color="#FFFFFF"
                        style={{ marginRight: 2 }}
                      />
                      <Text style={styles.liveGridBadgeText}>{item.liveType === 2 ? t('电台') : t('视频')}</Text>
                    </View>
                    {/* 右上角徽标：直播中/电台（开播时间已显示在标题下方 meta） */}
                    <View style={styles.liveGridBadgeRow}>
                      <View style={[styles.v2Badge, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                        {item.liveType === 2 ? (
                          <>
                            <MaterialCommunityIcons name="radio" size={9} color="#FFFFFF" style={{ marginRight: 2 }} />
                            <Text style={styles.liveGridBadgeText}>{t('电台')}</Text>
                          </>
                        ) : (
                          <>
                            <LivePulseDot />
                            <Text style={styles.liveGridBadgeText}>{t('直播中')}</Text>
                          </>
                        )}
                      </View>
                    </View>
                    {/* 底部平滑渐变遮罩（替代两层色阶） */}
                    <LinearGradient
                      pointerEvents="none"
                      colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.55)']}
                      style={styles.liveGridShade}
                    />
                    <View style={styles.liveGridInfo}>
                      <Text style={styles.liveGridTitle} numberOfLines={1}>
                        {item.title || item.liveRoomTitle || t('无标题')}
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                        {teamOfItem(item) ? <TeamBadge team={teamOfItem(item)} fontSize={8} /> : null}
                        {meta ? (
                          <Text style={styles.liveGridMeta} numberOfLines={1}>{meta}</Text>
                        ) : null}
                      </View>
                    </View>
                  </View>
                </View>
                </TouchableOpacity>
              </FadeInView>
            );
          }}
          ListEmptyComponent={
            loading ? (
              <MediaGridSkeleton />
            ) : groupId === -1 && !token ? (
              <LoginPrompt hint={t('查看关注成员的直播/录播需要登录')} />
            ) : followFetching ? (
              <View style={styles.followScanWrap}>
                <ActivityIndicator size="small" color={palette.tint} />
                <Text style={[styles.followScanText, { color: palette.labelSecondary }]}>
                  {t('正在翻找关注成员的录播…')}
                </Text>
              </View>
            ) : (
              <EmptyState
                icon={error ? 'cloud-alert-outline' : 'file-cancel-outline'}
                title={search.trim() ? t('没有匹配的直播/录播') : error ? t('加载失败，请下拉重试') : t('暂无数据')}
              />
            )
          }
          onEndReached={() => loadMore(true)}
          onEndReachedThreshold={0.35}
          refreshControl={
            <RefreshControl
              // ⚠️ 必须接专门的 refreshing，不能接公共 loading：
              // 自动翻页/静默轮询都会把 loading 翻 true，接它会让转圈一直亮着
              //（用户反馈「使用搜索之后界面一直处在向上滑刷新的状态」）。
              refreshing={refreshing}
              onRefresh={refreshList}
              colors={[palette.tint]}
              tintColor={palette.tint}
            />
          }
          ListFooterComponent={null}
          contentContainerStyle={list.length === 0 ? { flex: 1 } : styles.listContent}
          initialNumToRender={tab === 'vod' ? 6 : 8}
          maxToRenderPerBatch={8}
          windowSize={7}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 直播弹幕输入条：叠在播放器底部（避开底部控制坞）
  liveBarrageInputWrap: { position: 'absolute', left: 10, right: 10, bottom: 62, zIndex: 20 },
  liveInputFab: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.42)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveBarrageInput: {},
  container: { flex: 1, backgroundColor: 'transparent' },
  tabRow: { flexDirection: 'row', gap: 8 },
  toolbarRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingBottom: 8, alignItems: 'center' },
  headerSwitch: { fontSize: 13, fontWeight: '800', minWidth: 34, textAlign: 'right' },
  // 直播/录播分段控件
  segmentWrap: {
    // 不要 padding：GlassSegmented 内部已有 3px 内边距，外层再加会让滑动胶囊错位
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: radii.pill,
    // 宽度固定满宽：不受「直播/录播」文字长短影响，切换时胶囊一次滑动到位
    width: 'auto',
    alignSelf: 'stretch',
  },
  segmentCell: {
    flex: 1,
    height: 34,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: { fontSize: 14 },
  filterRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 6 },
  searchToggle: {
    width: 32,
    height: 32,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  playerToolbar: { flexDirection: 'row', paddingHorizontal: 8, paddingTop: 44, paddingBottom: 6, backgroundColor: 'rgba(10,10,10,0.55)', alignItems: 'center' },
  playerToolbarCenter: { flex: 1, flexDirection: 'row', justifyContent: 'center', gap: 6, flexWrap: 'wrap' },
  glassBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.15)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' },
  glassBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  footer: { paddingVertical: 14, alignItems: 'center' },
  followScanWrap: { paddingVertical: 60, alignItems: 'center' },
  followScanText: { marginTop: 10, fontSize: 13 },
  listContent: { paddingBottom: 120 },
  error: { flex: 1, fontSize: 12, lineHeight: 18 },
  errorRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, padding: 10, borderRadius: radiiAlias.input },
  playerPage: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 999, elevation: 999, backgroundColor: '#000' },
  backBtnText: { fontSize: 13, fontWeight: '800' },
  giftBtnText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  switchPlayerBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 14, backgroundColor: '#222', marginLeft: 4 },
  retryPlayerText: { color: '#fff' },
  // 旧公告按钮/胶囊样式已删除：公告统一由 MediaPlaybackHost 渲染并用 palette.tint 上色
  exitFullscreenBtn: { position: 'absolute', top: 28, right: 16, zIndex: 1001, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.62)' },
  exitFullscreenText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  player: { flex: 1, backgroundColor: '#000' },
  nativeVideo: { flex: 1, backgroundColor: '#000' },
  vlcGate: { flex: 1, backgroundColor: '#050505', justifyContent: 'center', padding: 22 },
  vlcGateTitle: { color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 12 },
  vlcGateText: { color: '#d8d8d8', fontSize: 14, lineHeight: 22, marginBottom: 14 },
  vlcGateUrl: { color: '#d8d8d8', fontSize: 11, lineHeight: 16, marginBottom: 18 },
  vlcPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '900' },
  vlcSecondaryBtn: { backgroundColor: '#222', borderRadius: 20, paddingVertical: 13, alignItems: 'center' },
  vlcSecondaryText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  vlcGateError: { color: '#ffb3c2', fontSize: 12, marginTop: 12 },
  playerError: { position: 'absolute', left: 16, right: 16, bottom: 24, padding: 12, borderRadius: 20, backgroundColor: '#1C1C1F' },
  playerErrorText: { color: '#fff', fontSize: 12, lineHeight: 18 },
  // 播放器内解析中/失败视图
  resolvingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  resolvingText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  webFallbackBtn: { marginTop: 10, alignSelf: 'flex-start', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 },
  webFallbackText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  // 哔哩哔哩风格底部控制条（停靠在 bottomDock 内）
  controlsBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: 'rgba(0,0,0,0.55)' },
  ctrlBtn: { paddingHorizontal: 8, paddingVertical: 4, minWidth: 30, alignItems: 'center', justifyContent: 'center' },
  ctrlIcon: { color: '#fff', fontSize: 18, fontWeight: '800' },
  ctrlRate: { color: '#fff', fontSize: 12, fontWeight: '800' },
  ctrlTime: { color: '#fff', fontSize: 11, minWidth: 34, textAlign: 'center' },
  // 进度条：外层是更高的触控区（跟手），内层才是 4px 视觉条
  ctrlTrack: { flex: 1, height: 24, justifyContent: 'center', marginHorizontal: 8, position: 'relative' },
  ctrlBar: { position: 'relative', height: 4, width: '100%', borderRadius: 2, backgroundColor: '#FFFFFF' },
  ctrlKnob: { position: 'absolute', top: -3, width: 10, height: 10, borderRadius: 5, backgroundColor: '#fff', marginLeft: -5 },
  // 底部控制坞（MSG48 风格：半透明黑底，进度/功能图标统一沉浸显隐）
  bottomDock: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20, paddingTop: 10, paddingBottom: 16, paddingHorizontal: 12, backgroundColor: 'rgba(0,0,0,0.55)' },
  funcRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-around', alignItems: 'center', marginTop: 10, gap: 4 },
  funcBtn: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 4, minWidth: 48 },
  funcBtnActive: { opacity: 1 },
  funcBtnText: { color: '#fff', fontSize: 11, fontWeight: '700', marginTop: 3 },
  liveBadgeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 6, gap: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ff4d4f' },
  liveBadgeText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  topChrome: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 44, paddingHorizontal: 12, paddingBottom: 8, pointerEvents: 'box-none' },
  // v2 内容卡：大封面 + 信息区（2026-08-15 布局重建）
  v2Card: {
    marginHorizontal: 12,
    marginVertical: 6,
    borderRadius: 20,
    overflow: 'hidden',
    // 扁平化：卡片不再投影（层次靠底色与圆角）
  },
  v2Cover: { height: 208, overflow: 'hidden' },
  v2CoverImg: { width: '100%', height: '100%' },
  v2CoverFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  v2Shade1: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 108, backgroundColor: 'rgba(0,0,0,0.16)' },
  v2Shade2: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 72, backgroundColor: 'rgba(0,0,0,0.28)' },
  v2Shade3: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 44, backgroundColor: 'rgba(0,0,0,0.48)' },
  v2InfoOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingBottom: 10 },
  v2TitleOverlay: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', lineHeight: 21, textShadowColor: 'rgba(0,0,0,0.65)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  v2MetaRowOverlay: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  v2MetaOverlay: { color: 'rgba(255,255,255,0.88)', fontSize: 12, marginLeft: 4, textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  // 录播 2 列网格卡
  vodGroupTitle: { paddingHorizontal: 14, paddingTop: 18, paddingBottom: 6, fontSize: 13, fontWeight: '700' },
  vodRow: { flexDirection: 'row', paddingHorizontal: 8 },
  vodGridRow: { paddingHorizontal: 8 },
  vodGridCard: {
    flex: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  vodGridCover: { width: '100%', aspectRatio: 1, overflow: 'hidden' },
  vodGridCoverImg: { width: '100%', height: '100%' },
  vodGridFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // 直播/录播四列小卡（紧凑）：与首页成员直播小卡同尺寸语言。固定 25% 宽防止末行奇数项撑满整行
  liveGridItem: { width: '25%', padding: 3 },
  liveGridType: { position: 'absolute', top: 5, left: 5 },
  liveGridBadgeRow: { position: 'absolute', top: 5, right: 5, flexDirection: 'row' },
  liveGridShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 56 },
  liveGridInfo: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 6, paddingBottom: 5 },
  liveGridTitle: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', lineHeight: 14, textShadowColor: 'rgba(0,0,0,0.65)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  liveGridMeta: { color: 'rgba(255,255,255,0.85)', fontSize: 8, marginTop: 1, flexShrink: 1, textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  liveGridBadgeText: { color: '#FFFFFF', fontSize: 9, fontWeight: '700' },
  // 直播首条 banner
  liveBanner: {
    marginHorizontal: 8,
    marginBottom: 8,
    marginTop: 4,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  liveBannerCover: { width: '100%', height: 200, overflow: 'hidden' },
  liveBannerImg: { width: '100%', height: '100%' },
  liveBannerFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  v2Badges: { position: 'absolute', top: 10, left: 10, flexDirection: 'row', gap: 6 },
  v2Badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  v2BadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  v2Duration: { position: 'absolute', right: 10, bottom: 10 },
  // v2.6: group + search
  groupRow: { maxHeight: 44, marginBottom: 4 },
  groupRowContent: { paddingHorizontal: 12, alignItems: 'center', gap: 6 },
  groupChip: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: radii.pill },
  groupChipText: { fontSize: 13, fontWeight: '700' },
  searchWrap: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginBottom: 4 },
  searchInput: {
    flex: 1, padding: 10, borderRadius: radiiAlias.input,
    borderWidth: StyleSheet.hairlineWidth, fontSize: 13,
  },
  searchClear: { paddingHorizontal: 8, paddingVertical: 8 },
  // 成员选择框
  memberChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: radii.pill, marginRight: 8 },
  memberChipText: { fontSize: 12, fontWeight: '700' },
  memberHits: { maxHeight: 52, marginBottom: 2 },
  memberHitsContent: { paddingHorizontal: 12, alignItems: 'center', gap: 6 },
  memberHitChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 7, borderRadius: radii.pill, borderWidth: 1 },
  memberHitText: { fontSize: 12, fontWeight: '700' },
  memberHitTeam: { fontSize: 9, marginLeft: 6, opacity: 0.85 },
  modalShade: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.72)' },
  /** 横屏：底板横排、面板贴右（贡献榜/礼物面板共用） */
  modalShadeLandscape: { flexDirection: 'row', justifyContent: 'flex-end' },
  giftPanel: { maxHeight: '82%', borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet, padding: 14 },
  /**
   * 横屏：底部抽屉可用高度只有 ~400dp 的 82% ≈ 330dp，再叠加内部固定 maxHeight 的
   * 滚动区（360/430）会把「送出 / 去充值」挤出屏幕（RN 默认 flexShrink:0，不会自动让位）。
   * 放宽面板上限 + 配合内部滚动区收窄（见 giftGridLandscape / rankListLandscape）。
   */
  /** 横屏：贡献榜/礼物面板贴右整列（与弹幕列表同一套抽屉，用户 2026-11-09） */
  giftPanelLandscape: {
    maxHeight: '100%', height: '100%', width: 380,
    borderTopRightRadius: 0, borderBottomRightRadius: 0,
    borderBottomLeftRadius: radii.sheet, paddingTop: 18,
  },
  giftHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  giftTitle: { fontSize: 18, fontWeight: '800' },
  giftStatus: { fontSize: 12, marginBottom: 10 },
  giftTip: { fontSize: 11, marginBottom: 6, textAlign: 'center', fontWeight: '600' },
  giftGrid: { maxHeight: 360 },
  /** 横屏：礼物网格收窄 + 允许收缩，把高度让给底部「送出」按钮 */
  giftGridLandscape: { maxHeight: 150, flexShrink: 1 },
  giftGridInner: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  giftItem: { width: '31%', padding: 8, borderRadius: radiiAlias.input, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth },
  giftItemActive: {},
  giftImage: { width: 44, height: 44, borderRadius: radiiAlias.button, backgroundColor: '#ddd', marginBottom: 6 },
  giftName: { fontSize: 11, fontWeight: '700' },
  giftCost: { fontSize: 10, marginTop: 2 },
  giftFooter: { flexDirection: 'row', gap: 10, paddingTop: 12 },
  giftNum: { width: 82, borderRadius: radiiAlias.input, borderWidth: 1, paddingHorizontal: 12 },
  sendGiftBtn: { flex: 1, borderRadius: radiiAlias.button, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  sendGiftText: { fontSize: 14, fontWeight: '800' },
  rechargeBtn: { marginTop: 10, alignItems: 'center', paddingVertical: 10 },
  rechargeText: { fontSize: 13, fontWeight: '800' },
  rankList: { maxHeight: 430 },
  /** 横屏：贡献榜列表收窄 + 允许收缩（同上） */
  rankListLandscape: { maxHeight: 160, flexShrink: 1 },
  rankRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  rankNo: { width: 32, fontSize: 15, fontWeight: '900' },
  rankAvatar: { width: 38, height: 38, borderRadius: 20, marginRight: 10 },
  rankInfo: { flex: 1 },
  rankName: { fontSize: 14, fontWeight: '800' },
  rankValue: { fontSize: 11, marginTop: 2 },
  // 日历筛选
  calBtn: { padding: 6, marginRight: 2, justifyContent: 'center' },
  calBtnActive: { borderRadius: radii.sm },
  dateChipRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginTop: 8 },
  dateChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radii.pill, borderWidth: StyleSheet.hairlineWidth },
  dateChipText: { fontSize: 12, fontWeight: '700' },
  dateChipClear: { marginLeft: 6 },
  calMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  calSheet: { width: '88%', maxWidth: 360, borderRadius: radiiAlias.input, padding: 16 },
  calHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  calTitle: { fontSize: 17, fontWeight: '800' },
  calWeekRow: { flexDirection: 'row', marginBottom: 6 },
  calWeek: { flex: 1, textAlign: 'center', fontSize: 12, color: '#999', fontWeight: '700' },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calDay: { width: '14.28%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  calDayText: { fontSize: 15 },
  calFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#eee' },
  calCancel: { paddingHorizontal: 14, paddingVertical: 6 },
  calCancelText: { fontSize: 14 },
  calToday: { borderRadius: radiiAlias.button, paddingHorizontal: 18, paddingVertical: 6 },
  calTodayText: { fontSize: 14, fontWeight: '800' },
});
