import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { styles } from './room/roomStyles';
import { useRoomBackground } from './room/useRoomBackground';
import { useRoomActivityMirror } from './room/useRoomActivityMirror';
import { useRoomUnreadCounters } from './room/useRoomUnreadCounters';
// 「有 N 条新消息」浮标的计数规则（纯函数，可与桌面端口径一起被单测锁住）
import {
  isCountableRoomMessage,
  pickNewMessages,
  pushSeenIds,
  scrollOffsetY,
  type NewMsgItem,
} from './room/newMessagePill';
import { resolveRoomLiveMedia, roomMedia } from './room/mediaResolve';
// 媒体卡片组件（VideoCoverCard / LiveCoverImage / AudioMediaCard）只在 RoomChatMessageRow 内使用
import { RoomChatMessageRow } from './room/RoomChatMessageRow';
import { RoomListRow } from './room/RoomListRow';
// 房间工具栏送礼用同一个抽屉组件（播放中的礼物/贡献榜由宿主内置）
import { LiveGiftSheet } from '../components/LiveGiftSheet';
import { buildChannelToRoomMap } from './room/roomChannelMap';
import { Animated, AppState, RefreshControl, useWindowDimensions } from 'react-native';
import Reanimated, { Easing as ReEasing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { PerfFlatList } from '../components/PerfFlatList';
import { Chat } from '@kesha-antonov/react-native-chat';
import { setLiveImmersiveMode } from '../native/LivePlayer';
import { deleteRoomMessage, observeRoomMessages, sendRoomTextMessage } from '../services/pocketNim/qchat';
import { loadSelfProfile } from '../services/pocketNim/credentials';
import { getNimSessionEpoch, subscribeNimSession } from '../services/pocketNim/session';
import { NetworkImage } from '../components/NetworkImage';
import MemberReplaySheet, { type MemberReplayItem } from '../components/MemberReplaySheet';
import { isPipActive } from '../utils/pip';
// 引用（回复）消息：字段口径/截断规则唯一实现在 utils/roomReply（发送侧与消息行共用）
import { rememberOwnReplyQuote, type RoomReplyTarget } from '../utils/roomReply';
import { flushRoomUnreadPersist, useRoomUnreadStore } from '../services/roomUnread';
// 三条计数通道（实时 / 5s 通知轮询 / 30s 指纹）共用同一份消息 id 总账
import { claimCountId, markCountConsumed } from '../services/roomCountLedger';
// 分侧「上次看到的位置」：进房 / 一键已读写消息 id，下拉刷新一次性翻到该位置
import { markSeen, markSeenAll } from '../services/roomSeenStore';
import { flushOwnerFeedUnread } from '../services/messagePollers';
// 列表预览快扫：与 5s 通知轮询解耦，15s 内把大/小房间真实最新正文拉回列表
import { refreshRoomListPreviews } from '../services/roomPreviewRefresh';
// isDetailFromSide：识别「小房间请求回退到大房间频道」的串味数据（三处：首屏/上拉/静默刷新）
import { isDetailFromSide, messageId, messageTime as cursorMessageTime } from '../utils/roomMessageCursor';
import { fetchMemberRadioUrl } from '../services/radio';
import { checkMaskWords } from '../services/maskWords';
import { usePalette } from '../theme';
// 房间精华消息（参考 yk1z/yaya_msg：popup 大卡片 + 工具栏喇叭入口，用户 2026-11-09）
import { RoomPinnedBell, RoomPinnedSheet } from '../components/RoomEssencePopup';
import { useRoomPinnedStore, type RoomEssenceStatus } from '../services/roomPinned';
import { useRoomEssenceSeenStore } from '../services/roomEssenceSeen';
// 深链/通知「进房间」的待处理目标 + 当前房间（通知去重依据，用户 2026-11-09）
import { useRoomPresenceStore } from '../store/notice';
import { essenceUnseenIds, normalizeEssenceList, type RoomEssenceMessage } from '../utils/roomPinnedRules';
import { useResolvedTheme } from '../hooks/useAppTheme';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
// 拆分第一步：媒体识别的纯函数与类型已移到独立模块（可单独跑单元测试）
import type { RoomMedia } from './room/mediaRules';
import {
  buildMemberIdSet,
  buildMemberIndex,
  capText,
  currentUserIdFrom,
  diagnoseUndefined,
  getMessageTime,
  getNextTime,
  isIdolMessage,
  isOwnerMessageStrict,
  mergeMessages,
  messageBody,
  messageKey,
  messageRole,
  normMs,
  qchatToRoomMessage,
  senderProfile,
  shortName,
  sortMessagesNewestFirst,
  userCardFromUserRes,
} from './room/messageRules';
import {
  avatarInitial,
  buildLiveIndex,
  findLastMessage,
  findSmallLastMessage,
  liveEntryForMember,
  messageToken,
  roomChannelId,
  roomLastActivity,
  roomSideToken,
  sameLiveIndex,
  type LiveNowIndex,
  type RoomMode,
} from './room/roomIdentity';
import { shouldRunTick, TICK_MIN_INTERVAL_MS } from './room/pollThrottle';
// 未读分侧规则（大房间 / 小房间）：键构造、总数、单侧判定 —— 见 utils/roomUnreadRules.ts
import {
  ROOM_UNREAD_SIDES,
  roomSideKey,
  roomSideHasNew,
  roomUnreadCount,
  roomUnreadKey,
  type RoomUnreadSide,
} from '../utils/roomUnreadRules';
// 「{days} 天内偶像无消息」判定（用户 2026-10-01）：纯函数见 utils/roomIdleNotice.ts
import { IDOL_IDLE_WINDOW_DAYS, IDOL_IDLE_WINDOW_MS, isIdolIdle } from '../utils/roomIdleNotice';
import { normMemberName } from '../utils/memberMatch';
import { playerSource } from './room/mediaResolve';

import {
  ActivityIndicator,
  Alert,
  BackHandler,
  ImageBackground,
  Linking,
  Modal,
  PanResponder,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { followSystem } from '../utils/orientation';
import Video from 'react-native-video';
import { useFocusEffect, useIsFocused, useNavigation, useRoute } from '@react-navigation/native';
import { useSettingsStore, useMemberStore, useUiStore } from '../store';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import { FadeInView, ScalePressable } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { chromeScrollProps, resetChromeScroll } from '../navigation/chromeScroll';
import { Member, RoomMessage } from '../types';
import { useOnMicStore } from '../store/onMicStore';
import {
  errorMessage,
  messageText,
  unwrapList,
} from '../utils/data';
// 注：i18n 的 t 在组件内部经 useI18n() 取（顶层 import 的 t 已无用）
import { useI18n } from '../i18n';
import { logInfo, logWarn } from '../utils/runtimeLog';
import pocketApi from '../api/pocket48';
import {
  MediaPlaybackHost,
  playMediaFromRoomMedia,
  playMediaFromRoomReplay,
  usePlaybackGift,
  type MediaPlaybackHostHandle,
  type PlayMedia,
} from '../player/session';
import { useMiniPlayerStore } from '../store/miniPlayerStore';
import ZoomImageModal from '../components/ZoomImageModal';
// 成员档案内容（与「成员档案」页同一份实现）：点偶像头像后**就地**显示在资料卡里
import { MemberArchiveContent, useMemberArchive } from '../components/MemberArchiveView';
import { enqueueDownload } from '../services/downloads';
import { memberSearchText } from '../utils/members';
import { getBgDisplayUri, ensureBgCached } from '../services/roomBgCache';
// 房间元数据（房间名/背景原图地址）跨启动缓存：冷启动首进房也能第一帧显示背景（用户 2026-11-12 进房提速）
import { getRoomMetaCached, putRoomMetaCache } from '../services/roomMetaCache';
import { useRoomPreviewTextStore } from '../services/roomPreviewText';
import { resolveLastSeenTarget } from '../utils/roomLastSeen';
// 房间列表排序（用户 2026-11-09）：置顶 → 新消息在上（可关）→ 自定义/按队伍/按字母
import { sortRooms, type RoomSortMode } from '../utils/roomListSort';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { GlassSurface } from '../components/GlassSurface';
import { GlassSegmented } from '../components/GlassSegmented';
/**
 * 「房主发言采样」：某侧 homeowner 接口（服务端按房主过滤 = 「只看偶像」的数据源）的返回统计。
 * `sampled` 必须区分「已采样但 0 条」与「从未采样」：
 *   · 已采样且 0 条 → 服务端确认该侧 7 天内没有房主发言 → 该提示就提示；
 *   · 从未采样 → 判定退回兜底路径。
 */
type OwnerSample = { sampled: boolean; count: number; latestMs: number };
const EMPTY_OWNER_SAMPLE: OwnerSample = { sampled: false, count: 0, latestMs: 0 };

export type FollowedRoom = {
  memberId: string;
  member?: Member;
  lastMessage?: any;
  /** 小房间（yklzId）最新消息，与大房间分开显示 */
  lastSmallMessage?: any;
};

// 房间标识 / 直播索引 / 活动时间等纯函数与类型（共 18 项）已移到 ./room/roomIdentity.ts，文件顶部统一 import。
// MediaType / RoomMedia 已随「媒体识别」那组纯函数移到 ./room/mediaRules.ts

// 消息解析相关纯函数与类型（共 27 项）已移到 ./room/messageRules.ts，文件顶部统一 import。



// 媒体与流地址解析（共 7 项）已移到 ./room/mediaResolve.ts，文件顶部统一 import。


// 气泡内嵌播放器（RoomMediaPlayer）已删除（用户 2026-10-02）：
// 它是「内嵌小播放器」的遗留实现，全仓无引用；四场景统一走新的播放会话层
//（src/player/session/MediaPlaybackHost），不再有第二套内嵌播放器。
















/** 已知的消息时间字段名（最先尝试，保持原行为） */




// （诊断标记 __msgDiagTag 已删除：只声明、从未被读取）







// normMs（时间戳归一）已随第 2 步搬到 ./room/messageRules.ts







// streamScore（流地址优先级打分）已移到 ./room/mediaRules.ts


// 媒体识别相关纯函数（extractLiveIdFromText / isPlayableMediaUrl / streamNeedsProxy /
// isLiveStreamUrl / roomTapIsVod）已移到 ./room/mediaRules.ts，文件顶部统一 import。


// classifyMedia（媒体类型判定）已移到 ./room/mediaRules.ts





// mediaLabel（媒体类型短标签）已移到 ./room/mediaRules.ts



// 三个媒体卡片组件（VideoCoverCard / LiveCoverImage / AudioMediaCard）已移到 ./room/RoomMediaCards.tsx





// 时长归一逻辑：详见 src/utils/mediaDuration.ts（findMediaDurationSeconds）。
// 该工具按字段名区分秒/毫秒，过滤掉「time」「seconds」等与时长无关的宽泛字段。

// 气泡染色常量与消息行组件已移到 ./room/RoomChatMessageRow.tsx（收尾第 2 步）

// 房间列表行组件已移到 ./room/RoomListRow.tsx（收尾第 3 步）

/**
 * 进房秒开缓存（用户 2026-10-01 性能优化）：**分侧键** → 最近一页消息。
 * 进房先用它立即渲染（接口 400-800ms 期间列表不再空白），网络回来后原逻辑覆盖/合并。
 * 内存级（进程生命周期）；引用复用 → chatRowCache 直接命中、渲染零成本。
 *
 * ⚠️ 键必须是 `roomSideKey(memberId, side)`（`#b` / `#s`），**不能**用裸 roomId：
 * 用户 2026-10-01 反馈「小房间被大房间消息取代」，其中一条根因就是大小房间
 * 共用同一个缓存槽 —— 小房间的首屏被写进去后，下次进大房间会先渲染出小房间的消息
 *（反向同理：小房间切侧时复用大房间的缓存槽直接顶上整屏大房间消息）。
 */
/**
 * 房间消息内存缓存：分侧键 → { 最近一页, 写入时刻 }。
 *
 * 用户 2026-11-09（对齐桌面端 followed-chat 的快照口径）：**只保留 2 分钟内、最多 120 条**。
 * 以前只按房间数（80）淘汰、不按时间 —— 切回一个几小时没进的房间，会先把「过期快照」
 * 铺满屏幕再被网络结果覆盖，看起来像消息时间倒流。
 */
const ROOM_MSG_CACHE_TTL_MS = 2 * 60 * 1000;
const ROOM_MSG_CACHE_MAX_KEEP = 120;
const roomMsgMemCache = new Map<string, { msgs: any[]; at: number }>();
/** 稳定空数组：「{days} 天内偶像无消息」时传给 <Chat messages>，避免每次渲染新引用触发整列表重算 */
const EMPTY_CHAT_IMS: any[] = [];
/**
 * 「{days} 天内偶像无消息」提示卡片的文字色（用户 2026-10-01：加遮罩 + **黑字**）。
 * 卡片自带浅色遮罩（见 roomStyles.roomIdleCard），所以文字固定深色、不跟主题走 ——
 * 房间背景图是用户自定图/视频帧，跟主题走反而会在深色主题下又变浅色、再次看不清。
 */
const IDLE_CARD_FG = 'rgba(20,20,22,0.92)';
const IDLE_CARD_FG_MUTED = 'rgba(60,60,67,0.72)';
/**
 * 传给 `<Chat>` 的模块级稳定引用（用户 2026-10-01 性能优化）。
 * 以前 theme / darkTheme / user / onSend / renderInputToolbar 都是**内联字面量**：
 * 房间内打字（roomDraft 每击键）、键盘高度变化都会让消息列表 props 全变 →
 * 库内部无法 bail-out → 可见的几十行消息整屏重渲染。提成常量后彻底稳定。
 * 两个颜色槽都给透明背景的原因见下方 colorScheme 的长注释（深浅色主题不串槽）。
 */
const CHAT_TRANSPARENT_THEME = { colors: { background: 'transparent' } };
const CHAT_SELF_USER = { _id: 'SELF' };
/** 房间消息用页面自己的输入栏，库内发送/输入栏一律空实现（也不能每次渲染新建函数） */
const CHAT_ON_SEND = () => {};
const CHAT_NO_INPUT_TOOLBAR = () => null;
/**
 * 引用（回复）条：用户 2026-10-14 要求「加一层白底，和正常的消息一样」；
 * 2026-11-09 起与输入栏一起改走 `GlassSurface frost`（局部毛玻璃），底色/白纱由材质统一给，
 * 不再各自写一套 tint 常量。
 */
/**
 * 「还算贴着最新消息」的距离（dp）——**唯一口径**。
 * 三个地方必须同步：库的 scrollToBottomOffset、maintainVisibleContentPosition.autoscrollToTopThreshold、
 * 以及「有 N 条新消息」浮标的判定（用户 2026-11-09）。
 */
const CHAT_STICK_BOTTOM_DP = 48;
/**
 * 「翻历史」之后回到「贴底」的滞回阈值（dp）。
 *
 * 为什么必须比 CHAT_STICK_BOTTOM_DP 小：真机日志（2026-11-09）里 y 会在 48~60 之间**自己抖**
 *（MVCP 内容补偿 + 行高重测），用同一个阈值来回翻 → 每翻回一次就清零浮标，数字永远涨不起来。
 * 现在离开贴底用 48、回到贴底要 ≤ 12（真的滑回最新端），抖动区间里状态保持稳定。
 */
const CHAT_RETURN_BOTTOM_DP = 12;
/**

/**
 * 房间内 HTTP 静默刷新间隔（毫秒）。
 * 这是**兜底**通道（实时走云信圈组推送）；15s 太慢（用户 2026-11-09：「单个房间里消息更新得太慢」），
 * 与房间列表 / 通知轮询统一成 5s。后台另有 60s 慢轮询兜底（startBgPoll）。
 */
const ROOM_MESSAGE_POLL_MS = 5000;
/** 写入缓存：最多 120 条 + 2 分钟有效期（见 ROOM_MSG_CACHE_TTL_MS 的说明）。sideKey 由调用方按侧拼好 */
function rememberRoomMessages(sideKey: string, msgs: any[]) {
  if (!sideKey || !msgs.length) return;
  if (roomMsgMemCache.size > 80) {
    const first = roomMsgMemCache.keys().next().value;
    if (first !== undefined) roomMsgMemCache.delete(first);
  }
  roomMsgMemCache.delete(sideKey);
  roomMsgMemCache.set(sideKey, { msgs: msgs.slice(0, ROOM_MSG_CACHE_MAX_KEEP), at: Date.now() });
}

/** 读缓存：过期即丢弃并返回 null（返回命中消息数组） */
function cachedRoomMessages(sideKey: string): any[] | null {
  const entry = roomMsgMemCache.get(sideKey);
  if (!entry) return null;
  if (Date.now() - entry.at > ROOM_MSG_CACHE_TTL_MS) {
    roomMsgMemCache.delete(sideKey);
    return null;
  }
  return entry.msgs;
}

/**
 * 丢弃某一侧的进房快照（分侧键）。
 *
 * 用途（用户 2026-11-12「大房间和小房间串了」）：小房间请求被服务端回退到大房间频道时，
 * 缓存里可能已经存着「被当成小房间」的大房间消息 —— 必须就地作废，
 * 否则下次进小房间仍会先铺一屏大房间内容（缓存优先于网络渲染）。
 */
function forgetRoomMessages(sideKey: string) {
  if (!sideKey) return;
  roomMsgMemCache.delete(sideKey);
}

/**
 * 已确认「服务端不可用」的分侧键（小房间未开通/已关闭）。
 *
 * 这些侧的快照缓存一律**不读**：缓存里可能是上一版写进来的串味数据（大房间消息被当成
 * 小房间首屏存下来），读它就会先铺一屏大房间内容再被网络结果清掉 —— 用户看到的仍是「串了」。
 * 该侧之后只要成功拉回**本侧**数据，就把它从集合里移除（成员开通小房间后自动恢复）。
 */
const roomSideUnavailable = new Set<string>();

export default function FollowedRoomsScreen() {
  const palette = usePalette();
  const resolvedTheme = useResolvedTheme();
  const { t } = useI18n();
  const token = useSettingsStore((state) => state.settings.p48Token);
  /**
   * 房间列表排序设置（用户 2026-11-09）：只订阅这三个字段 ——
   * 不要订阅整个 settings，否则改任何设置项都会让这个 175KB 的页面整屏重渲染。
   */
  const roomUnreadFirst = useSettingsStore((state) => state.settings.room_list_unread_first);
  const roomSortMode = useSettingsStore((state) => state.settings.room_list_sort);
  const roomCustomOrder = useSettingsStore((state) => state.settings.room_list_custom_order);
  const setTabBarHidden = useUiStore((state) => state.setTabBarHidden);
  const showToast = useUiStore((state) => state.showToast);
  const setScreenBackdrop = useUiStore((state) => state.setScreenBackdrop);
  const navigation = useNavigation<any>();
  /** 本页（Rooms Tab）是否在前台：30s 轮询只在聚焦时跑（见下方轮询 effect） */
  const isFocused = useIsFocused();
const route = useRoute<any>();
  const members = useMemberStore((state) => state.members);
  // 成员库 id 集合：「成员消息」视图要把别的成员（非房主）也算成员消息（用户要求）
  const memberIdSet = useMemo(() => buildMemberIdSet(members), [members]);
  /**
   * 成员库的**归一化昵称**集合（昵称兜底用，用户 2026-10-02 误报修复）。
   * 消息里的发送者 id 与成员库 id 不同域（云信 accid / 口袋 account / 字段缺失）时，
   * 只能靠名字认人 —— 见 isIdolRowMessage 的说明。
   */
  const memberNameKeys = useMemo(() => {
    const set = new Set<string>();
    (members || []).forEach((m: any) => {
      for (const raw of [m?.ownerName, m?.nickname, m?.starName]) {
        const key = normMemberName(raw);
        if (key) set.add(key);
      }
    });
    return set;
  }, [members]);
  /** 发送者 → 成员 的 O(1) 速查表（替代聊天行渲染里的 members.find，见 buildMemberIndex 注释） */
  const memberIndex = useMemo(() => buildMemberIndex(members), [members]);
  const onMicMap = useOnMicStore((state) => state.onMic);
  const [followed, setFollowed] = useState<FollowedRoom[]>([]);
  const followedRef = useRef<FollowedRoom[]>([]);
  followedRef.current = followed;
  const [followedLoading, setFollowedLoading] = useState(false);
  // 直播状态：ids=直播中主播 id 集合，names=直播中昵称集合（接口字段不一，昵称兜底）
  const [liveNow, setLiveNow] = useState<LiveNowIndex>({ ids: new Set(), names: new Set(), byOwner: {} });
  /** 「直播中」索引的 ref 镜像：给事件回调/useCallback 读取，避免它们因 liveNow 变化而换引用 */
  const liveNowRef = useRef(liveNow);
  liveNowRef.current = liveNow;
  const [pinned, setPinned] = useState<string[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<Member | null>(null);
  const [roomMessages, setRoomMessages] = useState<RoomMessage[]>([]);
  /** 房间内「精华消息」：偶像/房主在官方客户端置顶，移动端只读展示（按频道隔离） */
  const [pinnedSheetVisible, setPinnedSheetVisible] = useState(false);
  const [essenceIndex, setEssenceIndex] = useState(0);
  const roomEssenceMap = useRoomPinnedStore((s) => s.essence);
  const roomEssenceStatusMap = useRoomPinnedStore((s) => s.status);
  const roomPinnedDismissed = useRoomPinnedStore((s) => s.dismissed);
  /** 深链/通知要求「进某个房间」的 memberId（消费后清空） */
  const pendingRoomId = useRoomPresenceStore((s) => s.pendingRoomId);
  /** 「我已经看过哪些精华」的本地阅读状态（用户 2026-11-09：看过的不要再主动弹） */
  const roomEssenceSeenMap = useRoomEssenceSeenStore((s) => s.seen);
  const roomEssenceSeenHydrated = useRoomEssenceSeenStore((s) => s.hydrated);
  /**
   * 「服务端认定的房主发言」消息键集合（用户 2026-10-02 误报修复，与 isIdolRowMessage 配套）。
   *
   * 进房默认走的是 homeowner 接口（`fetchAll=false` → `/team/message/list/homeowner`），
   * **服务端返回的就是房主本人的发言** —— 这批消息的身份不需要我们再猜；
   * 但 `messageRole`/昵称兜底在「消息里的发送者 id 与成员库 id 不同域」时可能全判失败
   *（云信 accid / 口袋 account / 字段缺失），于是 7 天 idle 判定误报「偶像无消息」。
   * 这里把 homeowner 数据里的消息键记下来：之后切到群聊（all 接口含粉丝）时，
   * 只要这条消息的键在集合里 → 一律认作偶像发言（服务端说过它是）。
   * 集合在真正换房（openRoom）时清空。
   */
  const ownerMsgKeysRef = useRef<Set<string>>(new Set());
  /**
   * ★「房主发言采样」（**分大/小侧**）= 该侧 homeowner 接口拿到的房主发言统计，
   * **7 天 idle 判定的真正数据源**（用户 2026-10-02 真机日志实证的修复）。
   *
   * 为什么不能只看当前视图的 roomMessages：切到群聊后数据来自 all 接口，
   * 只有**最新 50 条** —— 粉丝刷屏时这 50 条里可以一条偶像消息都没有
   *（真机日志：fans=0 时「消息=50 偶像=50 窗口内=50」；fans=1 时「消息=50 偶像=0」，
   *  两批数据时间范围几乎不重叠，房主发言全被挤出窗口）→ 判定误报「7 天内偶像无消息」。
   *
   * ⚠️ 两条踩过的坑（2026-10-02 连续两轮返工）：
   *   · 采样**不能**在 openRoom 里无条件清空 —— openRoom 同时承担「切大/小侧、切只看偶像/群聊」
   *     （internal 模式），一清就再也补不回来（切群聊后 wantFans=true 不会请求 homeowner）→
   *     真机日志里 `房主采样=0条` 就是这么来的。只有**换房（房主变了）**才清。
   *   · 采样必须**分侧**：大/小房间是两个 channel，房主发言在两侧各自独立。
   *   · 群聊状态下切侧/进群聊时若该侧还没有采样 → `ensureOwnerSample` 后台补一次 homeowner。
   */
  const [ownerSampleBySide, setOwnerSampleBySide] = useState<{ big: OwnerSample; small: OwnerSample }>({
    big: EMPTY_OWNER_SAMPLE,
    small: EMPTY_OWNER_SAMPLE,
  });
  /** 采样 state 的 ref 镜像：ensureOwnerSample（useCallback 稳定引用）里读最新值，避免闭包过期 */
  const ownerSampleBySideRef = useRef(ownerSampleBySide);
  ownerSampleBySideRef.current = ownerSampleBySide;
  /** 后台补采样的在途标记（按侧），避免重复请求 */
  const ownerSampleInflightRef = useRef<Record<RoomMode, boolean>>({ big: false, small: false });
  /** 当前房间 id 的 ref 镜像：openRoom 里判断「是否真的换房」（闭包里的 selectedRoom 可能是旧值） */
  const selectedRoomIdRef = useRef('');
  selectedRoomIdRef.current = String(selectedRoom?.id || '');
  // 持有一份最新 roomMessages 引用，供 refreshRoomMessages 预判「是否有新消息」而无需把 roomMessages 列入 deps（避免定时器频繁重建）
  const roomMessagesRef = useRef<RoomMessage[]>([]);
  roomMessagesRef.current = roomMessages;
  /**
   * 当前 `roomMessages` **属于哪一侧**：`roomSideKey(memberId, side)`（`#b` / `#s`）。
   *
   * 用途：`keepPrev`（空结果保护）的守卫 —— 只有「请求的侧 == 列表当前所属的侧」
   * 才允许保留上一帧。否则会出现「小房间接口返回 0 条 → 保留的却是大房间那一帧」
   *（用户 2026-10-01 反馈的「小房间被大房间消息取代」）。
   */
  const roomMsgSideRef = useRef('');
  // 键盘高度：edge-to-edge 下 adjustResize 失效，手动抬升房间容器 —— 消息列表 + 输入框整体上移
  const roomKeyboardHeight = useKeyboardHeight();
  const [loading, setLoading] = useState(false);
  // 标记「房间消息已成功加载过一次」。仅用它来压制进房/切房间切换瞬间的「暂无消息」空态——
  // 比单纯依赖 loading 更可靠（不依赖 React 批处理时序）。切换/进房期间恒为 false，绝不闪空态；
  // 加载成功返回（即便为空数组）才置 true，此时才允许显示「暂无消息」真实空态。
  const [roomLoadedOnce, setRoomLoadedOnce] = useState(false);
  // 切换房间瞬间的「干净中间态」：true 时列表区只渲染骨架，既不显示旧房间残留消息、也不显示空态。
  // 进新房间的第一帧立刻置 true，新消息 setRoomMessages 后置 false → 彻底消除旧房间内容闪一帧。
  const [followedError, setFollowedError] = useState('');
  const [roomMsgError, setRoomMsgError] = useState('');
  /**
   * 该成员的小房间在服务端不可用（未开通/已关闭/无权限）。
   *
   * 判据不是「请求报错」，而是**详情回退到了大房间频道**（见 openRoom 的串味拦截）：
   * 小房间请求失败时 `getRoomMessages` 会回退 fallbackChannelId 并成功返回大房间消息，
   * 以前这批数据会被当成小房间内容渲染（用户 2026-11-12「大房间和小房间串了」）。
   * 现在置 true = 本侧没有自己的数据，消息区显示明确提示，且不参与 idle 判定。
   */
  const [roomSideClosed, setRoomSideClosed] = useState(false);
  /** 串味诊断日志节流键（`房间id#侧`）：静默刷新 5s 一轮，同一侧只打一条 */
  const sideClosedLogRef = useRef('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  /**
   * 成员搜索的**防抖值**（用户 2026-10-01 性能优化，与房间内搜索同一套做法）。
   *
   * 成员搜索此前是即时过滤：每敲一个字符都会对**整个关注列表**（几百个房间）跑
   * filter + 未读 rank 预计算 + sort，同时对**整个成员库**（几百人）跑 filter + sort + slice。
   * 输入框本身仍即时回显（受控于 searchQuery），只是过滤/排序不再每字符跑一次。
   */
  const [searchDebounced, setSearchDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setSearchDebounced(searchQuery), 200);
    return () => clearTimeout(id);
  }, [searchQuery]);
  const [roomSearchQuery, setRoomSearchQuery] = useState('');
  /**
   * 房间内搜索的**防抖值**（用户 2026-09-30：「房间性能继续优化」）。
   *
   * 房间搜索是即时过滤：每敲一个字符都会对**全部已加载消息**跑一遍 `messageText` +
   * `senderProfile`（几百条消息时输入明显卡手）。这里把过滤真正用的值延迟 200ms 同步，
   * 输入框本身仍即时回显（受控于 roomSearchQuery），只是过滤不再每字符跑一次。
   */
  const [roomSearchDebounced, setRoomSearchDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setRoomSearchDebounced(roomSearchQuery), 200);
    return () => clearTimeout(id);
  }, [roomSearchQuery]);
  const [roomSearchOpen, setRoomSearchOpen] = useState(false);
  const [roomMode, setRoomMode] = useState<RoomMode>('big');
  const [showFanMessages, setShowFanMessages] = useState(false);
  /**
   * 精华消息的频道 key：大房间 channelId / 小房间 yklzId（两个不同的 channelId）。
   * ⚠️ 这里是**唯一推导处**，拉取 / 弹窗 / 工具栏喇叭 / 已读记录全部用它。
   */
  const roomEssenceKey = useMemo(() => {
    if (!selectedRoom) return '';
    const anyRoom = selectedRoom as any;
    return roomMode === 'small'
      ? String(anyRoom?.yklzId || anyRoom?.channelId || '')
      : String(anyRoom?.channelId || '');
  }, [selectedRoom, roomMode]);
  const roomEssenceServerId = String((selectedRoom as any)?.serverId || '');
  const essenceItems = roomEssenceMap[roomEssenceKey] || [];
  const roomEssenceStatus: RoomEssenceStatus = roomEssenceStatusMap[roomEssenceKey] || 'idle';
  const essenceUnseen = useMemo(
    () => essenceUnseenIds(essenceItems, roomEssenceSeenMap[roomEssenceKey]),
    [essenceItems, roomEssenceSeenMap, roomEssenceKey],
  );
  /** 请求代次：切房间/刷新时旧响应直接丢弃（与播放解析同一套守卫） */
  const essenceReqSeqRef = useRef(0);
  const loadRoomEssence = useCallback((key: string, serverId: string) => {
    const channelKey = String(key || '').trim();
    if (!channelKey) return;
    const store = useRoomPinnedStore.getState();
    store.setStatus(channelKey, 'loading');
    const seq = ++essenceReqSeqRef.current;
    pocketApi.getRoomEssenceMessages(channelKey, String(serverId || ''))
      .then((res: any) => {
        if (seq !== essenceReqSeqRef.current) return;
        const content = res?.content ?? res?.data?.content ?? {};
        store.setEssence(channelKey, normalizeEssenceList(content));
        store.setStatus(channelKey, 'ready');
      })
      .catch(() => {
        if (seq !== essenceReqSeqRef.current) return;
        // 失败保留上一次数据（弹窗里给「刷新/重试」），只把状态置为 error
        store.setStatus(channelKey, 'error');
      });
  }, []);
  /** 进房 / 切大小房间：拉一次偶像设置的精华消息（官方置顶），只展示不写入 */
  useEffect(() => {
    if (!roomEssenceKey) return;
    setEssenceIndex(0);
    loadRoomEssence(roomEssenceKey, roomEssenceServerId);
  }, [roomEssenceKey, roomEssenceServerId, loadRoomEssence]);
  /** 阅读状态：本地「看过哪些精华」的落盘数据（只读一次） */
  useEffect(() => { useRoomEssenceSeenStore.getState().hydrate(); }, []);
  /**
   * 每次进房 / 切大小房间都解除「本次会话不再自动弹」——
   * 否则上一次关掉弹窗后，新进房即使有**没看过**的精华也不会再弹。
   * 真正拦住「看过的重复弹」的是 roomEssenceSeen（按消息 id 落盘），不是这里的 dismissed。
   */
  useEffect(() => {
    if (!roomEssenceKey) return;
    useRoomPinnedStore.getState().show(roomEssenceKey);
  }, [roomEssenceKey]);
  /**
   * 自动弹窗（用户 2026-11-09）：「有**没看过**的精华才弹」。
   *  · 已读判定走 roomEssenceSeen（跨启动）；本轮会话手动关掉（dismissed）就不再弹；
   *  · 打开时把当前这批 id 记成已看过 —— 之后偶像没新设精华就不会再打扰。
   */
  useEffect(() => {
    if (!roomEssenceKey || !essenceItems.length) return;
    if (roomPinnedDismissed[roomEssenceKey]) return;
    if (!roomEssenceSeenHydrated) return;
    if (!essenceUnseen.length) return;
    const firstUnseen = essenceItems.findIndex((it) => essenceUnseen.indexOf(it.id) >= 0);
    setEssenceIndex(firstUnseen > 0 ? firstUnseen : 0);
    setPinnedSheetVisible(true);
  }, [roomEssenceKey, essenceItems, essenceUnseen, roomEssenceSeenHydrated, roomPinnedDismissed]);
  /** 弹窗展示过 = 这批精华算看过了（手动点喇叭打开的也一样） */
  useEffect(() => {
    if (!pinnedSheetVisible || !roomEssenceKey || !essenceItems.length) return;
    useRoomEssenceSeenStore.getState().markSeen(roomEssenceKey, essenceItems.map((it) => it.id));
  }, [pinnedSheetVisible, roomEssenceKey, essenceItems]);
  const [playingMedia, setPlayingMedia] = useState<RoomMedia | null>(null);
  const [roomNextTime, setRoomNextTime] = useState(0);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  // 房间内展示：房间名（channelInfo.channelName）+ 背景图（channelInfo.bgImg）
  const [roomMeta, setRoomMeta] = useState<{ name: string; bg: string }>({ name: '', bg: '' });
  const roomMetaCache = useRef<Record<string, { name: string; bg: string }>>({});
  /**
   * 在途的房间元数据请求（channelId 集合）：进房时元数据与消息**并行**发起，
   * 同房间内切大/小侧、切群聊视图会再次走到 openRoom，这里防重复请求。
   */
  const roomMetaInflightRef = useRef<Set<string>>(new Set());
  /**
   * 房间背景双层交叉淡入：实现已抽到 ./room/useRoomBackground.ts
   *（那里的注释记录了「同图不动 opacity」与「A→B→A 死锁」两个历史坑）。
   */
  const { bgLayerA, bgLayerB, bgOpacityA, bgOpacityB, onBgSlotLoad, onBgSlotError } =
    useRoomBackground(roomMeta.bg);
  const activeChannelRef = useRef('');
  /**
   * 当前房间的「发言坐标」配对（channelId + serverId + 房主 id）。
   * ⚠️ 发言必须整体取自这里，不能 activeChannelRef（新房间）配 selectedRoom（旧房间）：
   * 切房那一瞬间两者不同步，拼出来的 serverId(旧)+channelId(新) 会把消息发到**错误的房间**
   * ——用户反馈的「有概率发送错误信息」。
   */
  const activeRoomRef = useRef<{ channelId: string; serverId: string; memberId: string }>({
    channelId: '',
    serverId: '',
    memberId: '',
  });
  const roomSeqRef = useRef(0); // Y22: 进房序号（快速切房丢弃慢响应）
  /**
   * 进房消息加载的自动重试计数（0 = 本次进房还没失败过）。
   * 见 openRoom 的 catch：1s → 3s → 8s，最多 3 次静默重试。
   * 以前房间消息**没有任何跨次重试**（tryPocketPost 只在单次请求内换 attempt），
   * 网络抖一下就是「空列表 + 一条瞬逝 toast」—— 用户体感「经常加载不出消息」。
   */
  const roomMsgRetryRef = useRef(0);
  /**
   * 「进房后自动开播」的**直播场次 liveId**（'' = 无）。由 openMemberLive 置位、由消费它的 effect 读一次就清。
   * ⚠️ 存 liveId 而不是布尔：必须带「直播中」索引里查到的真实场次 id。
   *   成员库的 `liveRoomId` 是直播间（聊天室）号、不是 liveId，不能拿来播放
   *   （2026-11-01 朱丽娜「点头像进不去直播间」的根因，详见 openMemberLive）。
   */
  const pendingAutoLiveRef = useRef('');
  // 消息列表 ref：开房/大小房间切换数据到位后滚回最新（见「进房定位 effect」）——
  // 否则旧房间滚动 offset 套到新房间数据上「滑动位置不对」（用户反馈）
  // 注：旧的 msgListRef / scrollPosCache / onMsgScroll 三件套已删除，它们从未接线（死代码）。

  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const loadingMoreMessagesRef = useRef(false);
  // 实时刷新进行中标志：与 loadMore 互斥，避免两者同时 setRoomMessages 造成列表重排/滚动弹回
  const refreshingRef = useRef(false);
  const [currentUserId, setCurrentUserId] = useState('');
  /**
   * 我的身份 id 集合（口袋数字 userId + 云信 accid，2026-10-02）：
   * 消息里携带的发送者 id 可能是其中任何一种，单一 id 比对在某一路身份缺失/不同域时
   * 失效 → 自己的消息被判成别人（气泡同侧，用户反馈）。判定时逐个比对（见 messageRole）。
   */
  const [selfIds, setSelfIds] = useState<string[]>([]);
  /** 我的昵称（自身的资料卡昵称，用于「消息不带发送者 id」时的兜底判定） */
  const [selfName, setSelfName] = useState('');
  /** 我自己的头像 URL（自己发言的右侧头像，用户 2026-10-02：大小房间都要显示） */
  const [selfAvatar, setSelfAvatar] = useState('');
  /**
   * 云信会话世代：切号 / 换号后 +1。
   * 换号后「我是谁」也变了 —— 旧的 currentUserId 会让自己的消息被判成别人
   * （气泡左右、身份徽标全错），同时实时通道要按新账号重连。
   */
  const [nimEpoch, setNimEpoch] = useState(getNimSessionEpoch);
  useEffect(
    () =>
      subscribeNimSession((epoch) => {
        setNimEpoch(epoch);
        setCurrentUserId('');
      }),
    [],
  );
  // 会话重置（切号）清空 currentUserId 后补拉一次：否则「自己的消息」判定没有 id，
  // 房间里自己发的消息会被排到左侧（气泡方向/身份徽标全错）
  useEffect(() => {
    if (!selectedRoom || currentUserId) return;
    let alive = true;
    pocketApi
      .getNimLoginInfo()
      .then((res: any) => {
        if (!alive) return;
        const id = currentUserIdFrom(res);
        if (id) setCurrentUserId(id);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selectedRoom, currentUserId, nimEpoch]);
  // 自己的身份 id 集合：口袋数字 userId（getNimLoginInfo）+ 云信 accid（loadSelfProfile 兜底）。
  // 多来源并集 —— 任一接口失败或 id 不同域时仍能认出自己的消息（修「气泡同侧」）。
  useEffect(() => {
    if (!currentUserId) return;
    setSelfIds((prev) => (prev.includes(currentUserId) ? prev : [...prev, currentUserId]));
  }, [currentUserId]);
  useEffect(() => {
    if (!selectedRoom) return;
    let alive = true;
    loadSelfProfile()
      .then((self) => {
        if (!alive || !self) return;
        const ids = [String(self.userId || ''), String(self.accid || '')]
          .map((v) => v.trim())
          .filter(Boolean);
        if (self.nickName) setSelfName(String(self.nickName));
        if (self.avatar) setSelfAvatar(String(self.avatar));
        if (!ids.length) return;
        setSelfIds((prev) => Array.from(new Set([...prev, ...ids])));
        const numeric = ids.find((v) => /^\d+$/.test(v) && v !== '0');
        if (numeric && !currentUserId) setCurrentUserId(numeric);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selectedRoom, nimEpoch, currentUserId]);
  /** 我的昵称 key 集合（归一化）：消息**无任何发送者 id** 时的「我发的」兜底判定 */
  const selfNameKeys = useMemo(() => {
    const set = new Set<string>();
    const key = normMemberName(selfName);
    if (key) set.add(key);
    return set;
  }, [selfName]);
  const [fullImageUrl, setFullImageUrl] = useState('');
  /**
   * 大图查看器的「同一次浏览」图片列表（用户 2026-11-02：房间里要能左右滑动切换图片）。
   * 点开某张图时，收集会话里最近的 N 张图作为翻页序列 —— 只在点开那一刻算一次，
   * 不放进 memo，避免每条新消息都全量重解析媒体。
   */
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  /**
   * 房间内当前播放的条目（用户 2026-10-02：播放器统一）。
   *
   * 只存「播什么」（PlayMedia）；解析（含解析中/失败重试占位）、续播与进度、
   * 弹幕（云信/LRC）、在线人数、小窗交棒全部由统一播放宿主完成
   *（src/player/session/MediaPlaybackHost）——本页不再自己维护任何播放器内核状态。
   */
  const [roomPlaying, setRoomPlaying] = useState<PlayMedia | null>(null);
  /** 统一播放宿主 ref：礼物面板（宿主内置）/ 公屏广播等命令式入口都从这里走 */
  const playbackHostRef = useRef<MediaPlaybackHostHandle | null>(null);

  /**
   * ⚠️【玻璃折射】把房间背景图挂进 blur 目标层。
   * 玻璃（BlurView）只折射 BlurTargetSurface 那一层（全局软件背景），
   * 而房间自己的背景图渲染在页面里、在那层之外 —— 不挂的话房间里的玻璃
   * 折射的是全局背景图而不是房间背景（用户反馈）。
   * 失焦（切 tab）/ 关房间时清 null，还原全局背景。
   */
  useFocusEffect(
    useCallback(() => {
      setScreenBackdrop(
        // 深色主题不再压黑幕（用户反馈 2026-09-26：夜间房间背景像蒙了层黑纱）——
        // 深色下不叠遮罩直接露出背景原图，浅色仍用白雾保证文字可读
        selectedRoom && roomMeta.bg
          ? { uri: roomMeta.bg, scrim: resolvedTheme === 'dark' ? 'transparent' : 'rgba(255,255,255,0.42)' }
          : null,
      );
      return () => setScreenBackdrop(null);
    }, [selectedRoom, roomMeta.bg, resolvedTheme]),
  );
  /** 房间内「直播回放」抽屉（该成员的历史直播回放列表，点条目就地用房间播放器播放） */
  const [showRoomReplay, setShowRoomReplay] = useState(false);
  const { height: winH } = useWindowDimensions();
  /**
   * 资料卡高度 = **固定接近满屏**（用户 2026-10-02：「哪里明显变大了，就是你不要管顶栏，全遮了也没事」）。
   *
   * 前两版为什么"看不出变大"，两个坑都在：
   *   ① `maxHeight: '86%'` 百分比无效（卡片父容器高度 auto，百分比无从解析）；
   *   ② 改成"内容区数值上限"后，卡片高度依旧是**内容自适应** —— 上限只是"最多这么高"，
   *      内容不足时卡片就矮，所以视觉上压根没变。
   * 现在给卡片一个**确定的固定高度**（接近屏高），内容区 `flex: 1` 吃满剩余空间：
   *   内容少 → 卡片照样满屏（下方留白）；内容多 → 内容区可滚动。
   * 顶部只留 16dp（仍是可点关闭区，其余"顶栏被全遮"用户已明确认可），底部留 28dp
   * （关闭区 + 把按钮抬离系统手势条）。
   */
  const userCardHeight = Math.max(320, Math.round(winH) - 44);
  // 贡献榜列表高度上限已随面板组件迁到 components/LiveRankSheet（两场景共用）。
  // 直播弹幕（云信飘屏/输入条/列表）、回放 LRC 弹幕、弹幕设置面板、礼物特效层：
  // 已全部收口到统一播放宿主（见 JSX 的 MediaPlaybackHost），本页不再自建弹幕连接。

  /* ==================== 房间未读（本地累计） ==================== */
  /**
   * 官方**没有**房间级未读接口（详见 src/services/roomUnread.ts 顶部说明），
   * 按用户确认的方案做本地累计：进房清零、列表挂着时收到其它房间的实时消息 +1、落 AsyncStorage。
   */
  /**
   * 未读条数表：键 = `roomUnreadKey(memberId, side)`（大房间 `#b` / 小房间 `#s`）。
   * 取某一侧请走 `roomUnreadCount(counts, id, side)`，不要自己拼键（用户 2026-09-30 分侧）。
   */
  /**
   * ⚠️ **房间打开时不要跟着未读表重渲染**（用户 2026-09-30：「房间性能还是低，很容易卡住」）。
   *
   * 未读表是全局的，而常驻实时订阅会对**任意关注房间**的消息 `applyUnread({bump})`
   * （见下面 observeRoomMessages 那段）—— 只要订阅它，人在房间里时别人房间来一条消息，
   * 这个 175KB 的页面组件（含 Chat 列表、BlurView 工具条、全部消息行）就会整屏重渲染一次。
   *
   * 做法：房间打开（selectedRoom 非空）时让 selector 返回**同一个稳定的空对象**，
   * zustand 比较到结果未变 → 不触发重渲染；退出房间恢复真实值。
   * 房间分支本身不需要未读表（那是列表分支的展示物）。
   */
  const EMPTY_UNREAD_MAP = useMemo(() => ({} as Record<string, any>), []);
  /** ★ 角标 / 上浮 / tab 的唯一数据源（用户 2026-11-10「只要一套」） */
  const roomUnreadCounts = useRoomUnreadStore((s) => (selectedRoom ? EMPTY_UNREAD_MAP : s.counts));
  /**
   * ⚠️ 列表预览正文不在页面层订阅整张表（用户 2026-11-13「预览有延迟」）：
   * 以前页面顶层订阅整张预览表，store 一变就整屏重渲染，
   * 而 FlatList 既没有 extraData、30s tick 指纹不变时又复用行对象引用 ——
   * 新正文写进 store 后最长要等下一轮 setFollowed 才会被 renderItem 读到。
   * 现在由 `RoomListRow` 按「成员 id + 侧」直接订阅字符串：写入即刻到那一行，
   * 且只有文本真变了的那一行重渲染（React.memo 语义不变）。
   */
  // 「上次看到这里」与 30s 精确计数直接读 store（getState()），不需要订阅这两张表，
  // 否则每次 markSeen / 推进基线都会让整个列表重排一次。
  useEffect(() => { useRoomUnreadStore.getState().hydrate(); }, []);
  /**
   * 「上次看到」进房快照：打开房间那一刻的旧已读基线（服务器消息时间）。
   * 聊天列表在「基线之后的第一条消息」上方渲染「上次看到这里」分隔行；
   * 0 = 该房间从未读过（无基线）→ 不显示分隔行。退房后 markRead 会推进基线，
   * 下次进房分隔行自然前移到新收到的消息处。
   */
  const [roomEntryBaseline, setRoomEntryBaseline] = useState(0);
  /** 聊天列表引用：用于「上次看到」自动定位（滚到分隔行处） */
  const chatListRef = useRef<any>(null);
  /**
   * 进房定位的「一轮运行」状态。
   *
   * ⚠️ 为什么必须是 ref 而不是跟着 effect 走：
   * 定位要等列表渲染完、且 scrollToIndex 在行高未测出时会静默失效，所以要分几轮重试。
   * 而聊天列表的 `chatIms` **每次有新消息都会换引用**（房间每 15s 刷新一次、直播弹幕更频繁）。
   * 若把重试挂在 effect 的 cleanup 上，消息一到 effect 就重跑 → **cleanup 会把计时器取消掉**
   * → 定位被静默打断。这正是用户反馈的「偶尔定位失效 / 进房不在顶端」的真实原因。
   *
   * 现在：一轮定位启动后**不再受 chatIms 变化影响**，只有「换房间」或「卸载」才作废。
   * key = 房间+基线；openRoom 会把 key 清空，保证每次真正进房都重新定位一次。
   */
  const posRunRef = useRef<{
    key: string;
    cancelled: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    /** 本轮定位的目标 index（-1 = 无目标 → 回到最新） */
    target: number;
    /**
     * 「迭代逼近」已推进到的**最高已测量行** index。
     * 目标行没被测量时，先跳到这个位置逼列表把中间行渲染出来（见 onScrollToIndexFailed），
     * 单调递增 —— 防止在同一位置上原地打转。
     */
    advancedTo: number;
    /** 跨页未读（分隔行还在更早的历史页里）时，还剩几次自动补历史页的机会 */
    autoLoadLeft: number;
  }>({
    key: '',
    cancelled: true,
    timer: null,
    target: -1,
    advancedTo: -1,
    autoLoadLeft: 3,
  });
  /**
   * 用户是否**操作过**消息列表（本次进房内触摸过一次即算）。
   * 一旦操作就彻底停掉自动定位 —— 否则后面几轮重试会把用户刚翻到的地方硬拽回去，
   * 这正是「定位跟手打架 / 一进房就被弹走」的来源之一。
   */
  const posUserScrolledRef = useRef(false);
  /**
   * 未读计数精准化（类型过滤 + 指纹计数）：实现见 ./room/useRoomUnreadCounters.ts。
   * 消息级去重统一由 services/roomCountLedger 的 id 总账负责（实时/轮询/指纹共用），
   * 这里不再维护第二份 uuid 去重窗口。
   */
  const {
    isChatMessageType,
    applyFingerprintCounts,
  } = useRoomUnreadCounters(selectedRoom);

  /**
   * 房间活动时间 / 最新消息指纹镜像：实现已抽到 ./room/useRoomActivityMirror.ts。
   * 返回值与原变量同名，下面的 openRoom / closeRoom / loadFollowed 一行都不用改。
   */
  const {
    pendingSeenRef,
    loggedLastMsgSampleRef,
    roomActivityOf,
    roomSeenPair,
  } = useRoomActivityMirror(followed);

  /**
   * 房间**打开期间**见过的最大消息时间。
   *
   * 房间打开时实时累计会主动跳过该房间（见 channelToMember 的 opened 判断），
   * 而 roomActivityRef 只跟着列表刷新（30s）更新 —— 两者合起来会导致：
   * 「在房间里看着消息进来 → 退房 → 下次刷新判成未读 → 刚看完的房间又冒角标」。
   * 退房时用这个值把基线推到「我确实看过的最新那条」，才能消掉这个假角标。
   */
  const roomMaxSeenRef = useRef(0);
  useEffect(() => {
    if (!selectedRoom) return;
    for (const msg of roomMessages as any[]) {
      const t = normMs(getMessageTime(msg));
      if (t > roomMaxSeenRef.current) roomMaxSeenRef.current = t;
    }
  }, [roomMessages, selectedRoom]);
  /**
   * channelId → (memberId, 大/小侧) 反查表（大房间 channelId + 小房间 yklzId 都收）：
   * 把全量实时消息按房间**并按侧**归位 —— 用户要求（2026-09-30）新消息数字要区分大小房间。
   *
   * ⚠️ 大房间 channelId 与小房间 yklzId 是**两个不同的 channelId**，正好用来判「消息来自哪一侧」；
   * 两者都不可能为空时才分别登记。同一 channelId 同时被两条记录占用时后写覆盖（历史行为）。
   */
  /**
   * channelId/serverId/yklzId →（成员 + 大/小侧）反查表：
   * 实现与「大房间双 id 登记」的坑见 room/roomChannelMap.ts（纯函数，可单测）。
   */
  const channelToRoom = useMemo(() => buildChannelToRoomMap(followed), [followed]);
  const channelToRoomRef = useRef(channelToRoom);
  channelToRoomRef.current = channelToRoom;
  /** 「实时消息映射不到房间」的诊断节流（tag room.unread） */
  const lastUnreadMissLogRef = useRef(0);

  const isChatLiveMessage = (m: any): boolean => isChatMessageType(m?.messageType);
  const isOwnLiveMessage = (m: any): boolean => {
    const uid = Number(m?.ext?.user?.userId || 0);
    const me = Number(currentUserId || 0);
    return uid > 0 && me > 0 && uid === me;
  };
  /**
   * 订阅全量房间实时消息，用于累计未读。
   *
   * ⚠️ 这里**不能**按 selectedRoom 退订：`observeRoomMessages` 是引用计数的，
   * 进房瞬间「列表退订(1→0) + 房间订阅(0→1)」会触发一次 disconnect / 重登录，
   * 正好把刚进房那几秒的实时消息丢掉（而且房间侧要等 accid 复位后重连）。
   * 保持常驻订阅 + 用 activeChannelRef 跳过「当前正打开的房间」即可，两边共享同一条连接。
   */
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    /** 实时消息处理（订阅挂上后由原生事件驱动） */
    const handler = (messages: any[]) => {
      if (disposed) return;
      // 诊断（tag room.unread）：每批实时消息都打一行 —— 没有这行 = 原生根本没推送
      if (messages.length) {
        const s0: any = messages[0];
        logInfo(
          `[unread] 实时批 ${messages.length} 条 首条 cid=${s0?.channelId} sid=${s0?.serverId}`
          + ` nick=${s0?.fromNick} type=${s0?.messageType}`,
          'room.unread',
        );
      }
      const map = channelToRoomRef.current;
      // 正在看的房间（按 memberId 判，不按 channelId：同一房间的大房间键可能是 serverId，
      // 用 channelId 比较会漏掉 → 自己正看的房间也被计入未读）
      const presence = String(useRoomPresenceStore.getState().currentRoomId || '');
      /** 分侧键 → 该「房间 + 侧」本轮收到的条数（一次 setState 批量提交） */
      const deltas: Record<string, { id: string; side: RoomUnreadSide; n: number }> = {};
      for (const m of messages) {
        // 类型与自己发言的过滤先于 opened 跳过：当前房间收到的消息也要走后面的
        // 「已读」标注（markCountConsumed），否则重连重放时它们会被当成新消息误计
        if (!isChatLiveMessage(m)) continue;
        if (isOwnLiveMessage(m)) continue;
        /**
         * ⚠️ id 口径必须多路兜底（用户 2026-11-09：「房间列表显示 1，实际发了很多」）：
         * 圈组消息里的 channelId 到底是成员的 `channelId` 还是 `serverId`，官方没有文档
         *（房间列表就是拿 serverId 去查、返回体里按 channelId 匹配）。以前只 `map[channelId]`，
         * 一旦口径不一致 → 每条实时消息都映射不到房间 → 实时计数全丢，
         * 角标只能靠 30s 指纹「一轮 +1」，数字自然永远停在 1~2。
         */
        const cid = String((m as any).channelId || '');
        const sid = String((m as any).serverId || '');
        const hit = (cid && map[cid]) || (sid && map[sid]) || undefined;
        if (!hit) {
          if (Date.now() - lastUnreadMissLogRef.current > 10000) {
            lastUnreadMissLogRef.current = Date.now();
            logWarn(
              `[unread] 实时消息映射不到房间 cid=${cid} sid=${sid} 映射键=${Object.keys(map).slice(0, 6).join(',')}`,
              'room.unread',
            );
          }
          continue;
        }
        /**
         * ★ 列表预览走实时通道（用户 2026-11-13「房间列表两条消息有延迟」）：
         * 圈组推送一到就把房主本人这句写进预览 store，不必等 30s 列表 tick 或
         * 60s 详情 sweep。只写严格判定的偶像发言，粉丝消息不顶预览；
         * 正在看的房间也写（退房回到列表时应当是最新一句）。
         * 这里只碰展示文本，不碰角标 / 游标 / id 总账。
         */
        if (hit.member && isOwnerMessageStrict(m as any, hit.member)) {
          useRoomPreviewTextStore.getState().setPreview(hit.id, hit.side, {
            text: messageText(qchatToRoomMessage(m as any)),
            msgId: messageId(m),
            msgTime: cursorMessageTime(m),
          });
        }
        // 正在看这个房间：不进角标，但要把这条消息认领掉
        // （退房后 5s 轮询拉到同一条详情时不能再补计一次）
        if (presence && hit.id === presence) {
          // 明确「已读」而不是「已计数」：不能抢占总账，否则退房后 5s 轮询的
          // 补偿扫描会把房间里看过的消息补成未读；标成已读则两边都不会再计。
          markCountConsumed(messageId(m));
          continue;
        }
        /**
         * ★ 只计偶像（房主）发言，且**走严格判定**（用户 2026-11-10 定口径、
         * 2026-11-11 明确「都走严格判定」）：与 5s 轮询 / 30s 精确计数 / 通知 / 预览
         * 共用 `isOwnerMessageStrict`（id 或昵称必须明确命中）。
         * ⚠️ 不要退回 `isIdolMessage(..., false)`：它在拿不到发送者 id 时会 return true，
         * 那是「只看偶像」视图的展示兜底，用在计数上会把没带资料子树的粉丝消息算成偶像。
         */
        if (hit.member && !isOwnerMessageStrict(m as any, hit.member)) {
          if (Date.now() - lastUnreadMissLogRef.current > 10000) {
            lastUnreadMissLogRef.current = Date.now();
            logInfo(
              `[unread] 非偶像发言不计角标 nick=${m?.fromNick} 房间=${hit.id}#${hit.side}`,
              'room.unread',
            );
          }
          continue;
        }
        /**
         * ★ 跨通道原子认领（2026-11-10）：uuid 就是 HTTP 详情里的 msgIdClient。
         * 5s 通知轮询 / 30s 指纹精确计数若已计过同一条，这里直接跳过；
         * 反过来也一样 —— 不再用「实时已计条数」整数相减（会把数字扣成 0 且基线已推进）。
         */
        if (!claimCountId(messageId(m))) continue;
        const key = roomUnreadKey(hit.id, hit.side);
        if (!key) continue;
        const cur = deltas[key];
        if (cur) cur.n += 1;
        else deltas[key] = { id: hit.id, side: hit.side, n: 1 };
      }
      if (Object.keys(deltas).length) {
        const detail = Object.values(deltas).map((d) => `${d.id}#${d.side}=+${d.n}`).join(' ');
        logInfo(`[unread] 实时计入 ${detail}`, 'room.unread');
      }
      /** 一次提交（不是逐条 bump）：一次 setState + 一次落盘；去重已由 id 总账完成 */
      const bumpPatch: Record<string, number> = {};
      for (const [key, d] of Object.entries(deltas)) bumpPatch[key] = d.n;
      useRoomUnreadStore.getState().applyUnread({ bump: bumpPatch });
    };
    const attach = () => {
      if (disposed || unsubscribe) return;
      observeRoomMessages(handler)
      .then((unsub) => {
        if (disposed) { unsub(); return; }
        unsubscribe = unsub;
        logInfo('[unread] 实时未读订阅已挂上', 'room.unread');
      })
      .catch((error: any) => {
        /**
         * ⚠️ 订阅失败必须重试（用户 2026-11-09：「列表数字永远 1」）：
         * 云信登录在冷启动时通常还没就绪，`observeRoomMessages` 会 reject ——
         * 以前这里 `.catch(() => undefined)` 一吞到底，这条常驻订阅**整场会话都不再生效**，
         * 角标只剩 30s 指纹（一轮 +1）。现在 5s 重试，直到挂上为止。
         */
        if (disposed) return;
        logWarn(`[unread] 实时未读订阅失败，5s 后重试：${String(error?.message || error || '')}`, 'room.unread');
        retryTimer = setTimeout(attach, 5000);
      });
    };
    attach();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (unsubscribe) unsubscribe();
    };
  }, [nimEpoch]);
  /* ==================== 房间弹幕（已收口到统一播放宿主） ==================== */
  // 直播：云信聊天室（飘屏/输入条/弹幕列表/礼物特效）—— 见 MediaPlaybackDanmaku
  // 回放：LRC 时间轴（含 liveId 从 URL 兜底）—— 同上
  // 本页只保留「弹幕列表 / 弹幕设置」的按钮，由宿主内部统一渲染面板。
  // 回放弹幕（LRC 时间轴，含 liveId 从回放地址兜底）已收口到统一播放宿主：
  // 见 src/player/session/usePlaybackDanmaku.ts（与主直播页录播同一条链路）。
  /**
   * 房间内人数胶囊与「上次看到」续播：均由统一播放宿主完成
   *（人数：直播=聊天室实时在线「N 人在线」，拿不到 / 回放=官方累计「累计 N 人看过」；
   *  续播：读/写 services/replayProgress，房间场景带「上次看到 mm:ss」toast）。
   */
  // 房间发言（云信圈组）：草稿 + 发送中 + 错误提示
  const [roomDraft, setRoomDraft] = useState('');
  const [roomSending, setRoomSending] = useState(false);
  const [roomSendHint, setRoomSendHint] = useState('');
  /**
   * 引用（回复）态（用户 2026-10-14）：长按**别人的**消息即进入，输入框上方出现引用条；
   * 下次发送会把这条消息的「昵称 + 原文摘要 + msgId」写进消息 ext（见 utils/roomReply）。
   */
  const [replyTarget, setReplyTarget] = useState<RoomReplyTarget | null>(null);
  /** 房间发言输入框引用：进入引用态后自动聚焦（否则用户还要多点一下才看见光标） */
  const roomInputRef = useRef<TextInput>(null);

  /**
   * 房间礼物面板的可见性。
   * ⚠️ 只用于「**未起播**时从工具栏送礼」这一种情况：起播后礼物/贡献榜面板
   * 由统一播放宿主内置（MediaPlaybackHost），房间不再自己维护那套状态。
   */
  const [giftVisible, setGiftVisible] = useState(false);
  /**
   * 用户资料卡：房间内点「非成员」头像（粉丝）时弹出。
   * 成员（含房主）直接跳「成员档案」页 —— 见 openSenderProfile。
   */
  const [userCard, setUserCard] = useState<null | {
    id: string;
    name: string;
    avatar: string;
    loading: boolean;
    error: string;
    /** 关注态（口袋48 用户间可互相关注：friendships/friends/add|remove, toType=1） */
    following: boolean;
    /** 互相关注（桌面端文案口径：mutual/both/friend/2/3） */
    mutual: boolean;
    followBusy: boolean;
    /** 成员（含房主）走同一个资料卡界面，只是多加身份/队伍行 */
    isMember: boolean;
    /**
     * 成员库档案对象（只有成员/房主头像才有；粉丝为 null）。
     * 「成员档案」入口用它直接带对象进 ProfileScreen —— 成员库尚未加载完时也能立刻渲染名字/队伍。
     */
    member: Member | null;
    detail: { name: string; avatar: string; level: string; signature: string; team: string; period: string; isStar: boolean };
  }>(null);
  /** 资料卡请求序号：连点不同头像时丢弃旧响应（避免慢响应覆盖新卡） */
  const userCardSeqRef = useRef(0);
  /**
   * 资料卡里**内嵌**的成员档案数据（用户 2026-10-02：点偶像头像后，档案内容要直接显示在
   * 这张资料卡上，而不是只放一个"去别的页面看"的按钮）。
   *
   * 加载口径与「成员档案」页完全一致（同一个 hook：star/archives + star/history、竞态防护）。
   * 非成员（粉丝）传空 id —— hook 不发请求，资料卡也不渲染档案区。
   */
  const memberArchive = useMemberArchive(userCard?.member?.id || (userCard?.isMember ? userCard.id : ''));
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [followBusy, setFollowBusy] = useState<Set<string>>(new Set());
  // 用 ref 持有最新值，避免 toggleFollow 的 useCallback 闭包捕获到过期的 followedIds/followBusy
  const followedIdsRef = useRef(followedIds);
  const followBusyRef = useRef(followBusy);
  followedIdsRef.current = followedIds;
  followBusyRef.current = followBusy;
  // loadFollowed 定义在 toggleFollow 之后，用 ref 持有以避免前向引用报错
  const loadFollowedRef = useRef<(silent?: boolean) => void>(() => {});
  /** 退房收尾经 ref 调用（BackHandler effect 定义在 closeRoom 之前，避免时序/闭包问题） */
  const closeRoomRef = useRef<() => void>(() => {});


  /** 关注房间主列表 ref：切进「房间」页时滚回顶部（Tab 常驻挂载，滚动位置会被保留） */
  const roomsListRef = useRef<any>(null);

  useFocusEffect(useCallback(() => {
    setTabBarHidden(!!selectedRoom || !!roomPlaying);
    return () => {
      setTabBarHidden(false);
      setLiveImmersiveMode(false);
      followSystem();
    };
  }, [roomPlaying, selectedRoom, setTabBarHidden]));

  // 切进「房间」页永远从顶部开始（用户要求 2026-09-28）：Tab 屏是常驻挂载的，
  // 原生为 FlatList 会保留上次的滚动位置。用 navigation focus 事件而不是
  // useFocusEffect —— 后者的回调会随 selectedRoom/roomPlaying 变化重跑，
  // 进出房间时也会触发；这里只在真正获得 Tab 焦点时回顶。
  useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      if (selectedRoom || roomPlaying) return;
      try { roomsListRef.current?.scrollToOffset({ offset: 0, animated: false }); } catch {}
    });
    return unsub;
  }, [navigation, selectedRoom, roomPlaying]);

  /**
   * 房间内锁定「底部 Tab 横划切页」（用户要求：在个人的房间内不要侧滑切换页面）。
   * 房间页自身有横向手势（大/小房间滑动、消息横向操作），不锁会被切页手势抢走。
   * 计数锁：与「播放器打开」的锁可叠加，互不干扰。
   */
  const lockTabSwipe = useUiStore((s) => s.lockTabSwipe);
  const unlockTabSwipe = useUiStore((s) => s.unlockTabSwipe);
  const roomLocked = !!selectedRoom;
  useEffect(() => {
    if (!roomLocked) return undefined;
    lockTabSwipe();
    return () => unlockTabSwipe();
  }, [roomLocked, lockTabSwipe, unlockTabSwipe]);

  useEffect(() => {
    setTabBarHidden(!!selectedRoom);
    // 进/退房间时把「滚动收起」复位：房间列表滚动会把重栏收起，
    // 若不复位，进房后房间自己的页头（非 overlay 时）会是收起状态。
    resetChromeScroll();
    if (!selectedRoom) {
      setRoomPlaying(null);
      setLiveImmersiveMode(false);
      followSystem();
    }
    return () => {
      setTabBarHidden(false);
      setLiveImmersiveMode(false);
      followSystem();
    };
  }, [selectedRoom, setTabBarHidden]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      /**
       * ⚠️ 只有本页处于焦点时才拦硬件返回（用户 2026-11-09：「退出相册会直接回到房间列表」）。
       *
       * 房间页是**常驻**的 tab 屏，相册（PhotosScreen）是根栈上的二级页。
       * 这条监听以前无条件生效：在相册里按返回时它先跑，先把房间 closeRoom 掉并吃掉事件，
       * 再退一次就落到房间列表（还伴随列表 focus 回顶）—— 看起来就是「退出相册掉回列表」。
       * 加上焦点判断后，返回键在相册里只关相册，房间原样保留。
       */
      if (!isFocused) return false;
      if (roomPlaying) {
        setRoomPlaying(null);
        setLiveImmersiveMode(false);
        followSystem();
        setTabBarHidden(!!selectedRoom);
        return true;
      }
      if (selectedRoom) {
        // ⚠️ 退房必须走 closeRoom（推进「上次看到/已读」基线 + 收尾）——
        // 之前这里直接 setSelectedRoom(null) 绕过了它 → lastReadAt 永远是 0，
        // 「上次看到」分隔行永不触发（实测日志：每次进房 baseline=0）
        closeRoomRef.current();
        setLiveImmersiveMode(false);
        followSystem();
        setTabBarHidden(false);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [roomPlaying, selectedRoom, setTabBarHidden, isFocused]);

  /** 关闭房间内播放器（宿主 onClose / 硬件返回共用）：复位沉浸、恢复系统方向 */
  const closeRoomPlayer = useCallback(() => {
    setRoomPlaying(null);
    setLiveImmersiveMode(false);
    followSystem();
    setTabBarHidden(!!selectedRoom);
  }, [selectedRoom, setTabBarHidden]);

  /**
   * 房间送礼/礼物榜可用的直播场次 id（大小房间共用）。
   *
   * 优先取「房间里正在播的那一场」；没有在播时退回「直播中」索引里的真实 liveId ——
   * 这样在房间里没起播也能送礼/看贡献榜（用户 2026-11-02：借鉴上游「房间内可直接送礼」）。
   * ⚠️ 成员库的 `liveRoomId` 是直播间（聊天室）号、**不是** liveId，绝不能拿来送礼。
   */
  const roomLiveId = useCallback((): string => {
    const playing = String(roomPlaying?.liveId || '');
    if (playing) return playing;
    const entry = liveEntryForMember(selectedRoom, liveNowRef.current);
    return String(entry?.liveId || '');
  }, [roomPlaying, selectedRoom]);

  /**
   * 房间送礼：数据 + 面板与直播页**完全同一套**（usePlaybackGift + LiveGiftSheet）。
   * 起播中 → 宿主内置面板（ref.openGift）；未起播 → 用本页这个实例（工具栏入口）。
   */
  const roomGift = usePlaybackGift({
    liveId: roomLiveId(),
    targetUserId: String((selectedRoom as any)?.id || ''),
    targetName: String((selectedRoom as any)?.ownerName || ''),
    // 起播后宿主连接已在；未起播时没有连接，广播自然静默
    broadcast: (g) => playbackHostRef.current?.sendGiftBroadcast(g),
  });
  const openRoomGiftPanel = useCallback(() => {
    if (roomPlaying) {
      playbackHostRef.current?.openGift();
      return;
    }
    setGiftVisible(true);
    void roomGift.load();
  }, [roomPlaying, roomGift.load]);

  /**
   * 进入引用（回复）态：长按别人消息时由 `RoomChatMessageRow` 回传「昵称 + 原文摘要 + msgId」。
   * 顺手聚焦输入框并把上一次的发送错误提示清掉（用户 2026-10-14）。
   */
  const startReply = useCallback((target: RoomReplyTarget) => {
    if (!target) return;
    setReplyTarget(target);
    setRoomSendHint('');
    // 输入框是原生控件：等这一帧布局完成再 focus（立即 focus 在部分机型上会被输入法抢掉）
    requestAnimationFrame(() => roomInputRef.current?.focus());
  }, []);

  /**
   * 房间发言（云信圈组 QChat）。
   *
   * 口袋48 的「房间消息」= 云信圈组频道消息：HTTP 侧只有历史列表，没有发送接口
   * （已实测 /im/api/v1/team/message/send 等候选全部 404），发送只能走云信。
   * 圈组仅官方 Android/iOS SDK 支持 → 走原生桥 PocketIm（PocketImModule.java）。
   */
  const handleSendRoomMessage = useCallback(async () => {
    const text = roomDraft.trim();
    if (!text || roomSending) return;
    // 屏蔽词拦截（口袋官方词表）：命中就不发，提示命中的词，避免发出去被服务端吞掉/风控
    const masked = await checkMaskWords(text);
    if (masked.length) {
      setRoomSendHint(t('包含屏蔽词：{words}', { words: masked.join('、') }));
      return;
    }
    // 发送坐标整体取自 activeRoomRef（channelId 与 serverId 配对的唯一来源）
    const target = activeRoomRef.current;
    const channelId = target.channelId;
    if (!channelId) {
      setRoomSendHint(t('房间未就绪'));
      return;
    }
    setRoomSending(true);
    setRoomSendHint('');
    // 发送也一样可能「跨房间返回」：在 A 房间发消息（在途）→ 切到 B → A 成功后
    // 绝不能去清 B 的草稿（原实现无条件 setRoomDraft('')，会把新房间刚输入的内容清空）。
    const sendSeq = roomSeqRef.current;
    // 引用快照：await 期间用户可能取消引用，这里取的是「点发送那一刻」的值，保证发送内容与所见一致
    const reply = replyTarget;
    try {
      // 圈组发送必须带 serverId：成员库缺失时先按 channelId 解析（否则云信返回 414 参数错误）
      let serverId = target.serverId;
      if (!serverId || serverId === '0') {
        serverId = await pocketApi.resolveRoomServerId(channelId).catch(() => '');
      }
      if (!serverId || serverId === '0') {
        throw new Error(t('缺少房间 serverId，无法发言'));
      }
      // 带 reply 时这条消息就是「引用某条消息的回复」（ext 里写 messageType: REPLY + 引用原文）
      const msgId = await sendRoomTextMessage({ serverId, channelId }, text, reply);
      /**
       * 引用消息的**本机兜底**（用户 2026-10-14「发出消息后没有正常显示引用」）：
       * 引用信息要等服务端把 ext 带回来才显示，而实时回显 / HTTP 历史两条链路里
       * 只要先到的那条没带（mergeMessages 按消息键去重、先到赢），自己这边就会缺引用卡。
       * 这里用 ACK 返回的 msgIdClient 记一份，展示侧读不到服务端数据时用它（见 resolveRoomReply）。
       */
      if (reply && msgId) rememberOwnReplyQuote(msgId, reply);
      if (sendSeq === roomSeqRef.current) {
        setRoomDraft('');
        // 引用只用一条：发出去就收起引用条（否则下一条又会重复引用同一条消息）
        setReplyTarget(null);
      }
      // ⚠️ 自己发的消息立即上屏：QChat 回显链路不稳定，等 15s 轮询太久（用户反馈）。
      // 发送成功即静默拉最新页合并（mergeMessages 按 msgId 去重，与轮询同路径、不会重复）。
      setTimeout(() => refreshRoomMessagesRef.current?.(), 500);
      setTimeout(() => refreshRoomMessagesRef.current?.(), 1500);
    } catch (err) {
      if (sendSeq === roomSeqRef.current) setRoomSendHint(errorMessage(err));
    } finally {
      // roomSending 是全局在途锁（openRoom 不复位它），所以必须无条件清，
      // 否则切房后发送按钮会永久禁用
      setRoomSending(false);
    }
  }, [roomDraft, roomSending, replyTarget, t]);

  // 应用内小窗交棒（重新解析新签名流 + 位置/宽高/回跳参数）已收口到统一播放宿主：
  // 见 MediaPlaybackHost 的「小窗」按钮实现（房间通过 miniPlayerBackTo 带 roomMemberId）。

  const closeRoom = useCallback(() => {
    /**
     * 退房也算「已读」：把基线推到此刻（列表镜像值 vs 房间内实际看到的最新一条，取更晚的）。
     * 房间打开期间的实时累计会跳过本房间，所以不在这里补一次的话，
     * 刚看完的消息会被下一次列表刷新判成未读 → 一退房就冒角标。
     */
    if (selectedRoom) {
      const closingId = String(selectedRoom.id || '');
      useRoomUnreadStore
        .getState()
        .markRead(closingId, Math.max(roomActivityOf(selectedRoom), roomMaxSeenRef.current));
      // 两侧「已见」一起推进（大/小房间都算看过）：分侧后不能再只推房间级那一个指纹
      const closingSeen = roomSeenPair(selectedRoom);
      useRoomUnreadStore.getState().markSeenBoth(closingId, closingSeen.big, closingSeen.small);
      /**
       * 收尾：房间开着时到达的消息走不了实时累计，而列表镜像要等下一次刷新（≤30s）——
       * 不在退房后补一次「已见」，就会出现「刚看完的房间又冒『新』」。
       * 这里记下待收尾的房间，紧接着静默刷一次列表，拿到最新指纹后写回（见 loadFollowed）。
       */
      pendingSeenRef.current = closingId;
      /**
       * 退房后的静默刷新**节流 2s**（用户 2026-09-30：「房间之间切换容易卡没房间列表」）：
       * 以前每次退房都打 3 个接口，快速来回切房间时请求互相竞态（seq 反复作废）→
       * 列表更容易出现空白/闪烁；2s 内的多次退房只拉一次，30s 轮询本来也会兜底。
       */
      const nowTs = Date.now();
      if (nowTs - lastCloseRefreshRef.current > 2000) {
        lastCloseRefreshRef.current = nowTs;
        loadFollowedRef.current?.(true);
      }
    }
    setRoomPlaying(null);
    setPlayingMedia(null);
    setSelectedRoom(null);
    // 退房：通知轮询恢复对「所有房间」的通知
    useRoomPresenceStore.getState().setCurrentRoom('');
    setScreenBackdrop(null); // 玻璃折射背景还原全局
    setRoomMsgError('');     // 消息错误态（含超时/失败浮层）也随退房清掉，别留给下一个房间
    setRoomMeta({ name: '', bg: '' });
    activeChannelRef.current = '';
    activeRoomRef.current = { channelId: '', serverId: '', memberId: '' };
    setRoomDraft('');
    setRoomSendHint('');
    // 引用态随退房清掉（被引用的那条消息已经离开当前房间，留着会引用到别的房间的消息）
    setReplyTarget(null);
    /**
     * 房间内搜索态也要随退房复位（用户 2026-09-30：「房间之间切换容易卡没房间列表」）：
     * 搜索态是**页面级**的，列表分支与房间分支共用 —— 在房间 A 里开过搜索、退房后
     * 这些 state 还挂着，再次进房间（尤其换到消息很少的房间）时，过滤会把仅有的消息全部隐藏，
     * 看起来就是"消息列表没了"。
     */
    setRoomSearchQuery('');
    setRoomSearchOpen(false);
    setLiveImmersiveMode(false);
    followSystem();
    setTabBarHidden(false);
    /**
     * ⚠️ 退房必须复位**所有全屏浮层 / 弹窗开关**（用户 2026-09-30 反馈
     * 「房间刷多了之后出现遮罩，覆盖整个顶栏以下的区域，反复进多个房间后容易卡住」）。
     *
     * 这些都是绝对定位铺满、且**吃触摸**的层：
     *   · roomPlaying 黑幕：`roomPlayerPage` 是 zIndex/elevation 1000 的纯黑全屏层；
     *   · 贡献榜 / 礼物 / 用户资料三个 Modal：各带一层 0.45 黑幕。
     * 以前只清 roomPlaying / playingMedia，上面这些**一个都不复位** ——
     * 在 A 房间打开过再切到 B 房间，黑幕与弹窗会跟过去：画面被盖住 + 整片触摸被吃掉，
     * 表现出来就是「遮罩 + 卡死」。
     *
     * ⚠️ 弹幕列表 / 弹幕设置 / 解析占位 现在都在统一播放宿主内部（随 roomPlaying=null 卸载），
     * 无需（也无法）在这里单独复位。
     */
    setGiftVisible(false);
    setUserCard(null);
    setShowRoomReplay(false);
    setPinnedSheetVisible(false);
    setFullImageUrl('');
    setImageUrls([]);
    // 清掉「进房后自动开播」标记：退房后不该再被一次迟到的进房触发自动播放
    pendingAutoLiveRef.current = '';
    /**
     * 释放房间消息本身（几百~上千条含 ext JSON 的消息会一直留在常驻的 Rooms Tab 上）。
     * ⚠️ 但**行缓存（chatRowCache / chatImCache）不再 clear**（用户 2026-10-01：
     * 「房间里的消息又卡没了」+ 真机日志 VirtualizedList 单次提交 4080ms）——
     * 以前每次退房清缓存 → 每次进房 50 条消息全量重建 IMessage → 首屏渲染 4 秒
     * （列表空白/卡死，正是"消息卡没了"的体感）。缓存 key 是 messageKey（跨房间唯一），
     * 复用安全；无界增长由 chatIms 里的 1500 上限修剪兜底。
     */
    setRoomMessages([]);
    // ⚠️ selectedRoom 必须进依赖：此前依赖数组漏了它，闭包里永远是首帧的 null，
    // `if (selectedRoom)` 恒 false → 退房基线推进从未执行（实测日志：baseline=0）
  }, [selectedRoom, setTabBarHidden]);
  closeRoomRef.current = closeRoom;

  /**
   * 「反复进出房间后出现遮罩」的**自愈哨兵**（用户 2026-09-30 第三次反馈）。
   *
   * 遮罩的本质就是：**人已经不在房间里，却还有房间级的浮层/黑幕层挂着**。
   * 逐层复位（openRoom/closeRoom 里那两处清单）已经做了，但"以后新加一层忘了复位"无法避免 ——
   * 这里做兜底：不在房间时若发现任何残留层，1.5s 内强制复位，并记一条运行日志（便于定位是哪一层）。
   * 幂等、只在确实有残留时才动手，正常路径零开销。
   */
  useEffect(() => {
    if (selectedRoom) return undefined;
    const timer = setTimeout(() => {
      const stale = [
        giftVisible && '礼物面板',
        !!userCard && '用户资料卡',
        showRoomReplay && '回放抽屉',
        !!fullImageUrl && '大图查看',
        !!roomPlaying && '房间播放器',
        !!playingMedia && '内联媒体',
      ].filter(Boolean);
      if (!stale.length) return;
      logInfo(`[room] 不在房间但仍有残留层（${stale.join('、')}）→ 强制复位`, 'room');
      setGiftVisible(false);
      setUserCard(null);
      setShowRoomReplay(false);
      setPinnedSheetVisible(false);
      setFullImageUrl('');
      setImageUrls([]);
      setRoomPlaying(null);
      setPlayingMedia(null);
    }, 1500);
    return () => clearTimeout(timer);
  }, [
    selectedRoom, giftVisible, userCard, showRoomReplay,
    fullImageUrl, roomPlaying, playingMedia,
  ]);

  const togglePin = async (memberId: string) => {
    const next = pinned.includes(memberId) ? pinned.filter((id) => id !== memberId) : [...pinned, memberId];
    setPinned(next);
    try {
      await AsyncStorage.setItem('yaya_pinned_rooms', JSON.stringify(next));
    } catch (error: any) {
      showToast(t('置顶保存失败：{msg}', { msg: error?.message || String(error) }));
    }
  };

  // （movePin「置顶上移/下移」已删除：列表 UI 已无该入口，函数只声明从未被调用）

  const toggleFollow = useCallback(async (member: Member) => {
    if (!token) { showToast(t('请先登录后再关注成员')); return; }
    const id = String((member as any).id || (member as any).userId || '');
    if (!id || id === '0') { showToast(t('该成员缺少可关注的 ID')); return; }
    if (followBusyRef.current.has(id)) return;
    // 关键：用 ref 读取最新关注状态，避免 useCallback 闭包捕获到过期的 followedIds，
    // 否则「已关注」状态下再次点击会误判为未关注而重复调用 followMember（表现为取消关注无效）
    const isFollowing = followedIdsRef.current.has(id);
    setFollowedIds((prev) => { const n = new Set(prev); if (isFollowing) n.delete(id); else n.add(id); return n; });
    setFollowBusy((prev) => { const b = new Set(prev); b.add(id); return b; });
    try {
      if (isFollowing) await pocketApi.unfollowMember(id);
      else await pocketApi.followMember(id);
      showToast(isFollowing ? t('已取消关注 {name}', { name: member.ownerName }) : t('已关注 {name}', { name: member.ownerName }));
      // 让房间里的关注/取关结果立即反映到关注列表（无需回列表手动刷新）
      setFollowed((prev) => {
        const exists = prev.some((p) => String(p.memberId) === id);
        if (isFollowing) return prev.filter((p) => String(p.memberId) !== id);
        if (exists) return prev;
        return [{ memberId: id, member }, ...prev];
      });
      // 与电脑版一致：操作后延迟从服务器拉取最新关注列表，保证状态权威同步
      setTimeout(() => { loadFollowedRef.current(true); }, 600);
    } catch (e) {
      setFollowedIds((prev) => { const r = new Set(prev); if (isFollowing) r.add(id); else r.delete(id); return r; });
      showToast(t('操作失败：{msg}', { msg: errorMessage(e) }));
    } finally {
      setFollowBusy((prev) => { const b = new Set(prev); b.delete(id); return b; });
    }
  }, [showToast, t, token]);

  useEffect(() => {
    AsyncStorage.getItem('yaya_pinned_rooms').then((v) => {
      if (v) { try { setPinned(JSON.parse(v)); } catch { setPinned([]); } }
    });
  }, []);


  /** 关注列表请求序号：迟到的响应据此丢弃（见 loadFollowed 里的 seq 判断） */
  const followedSeqRef = useRef(0);
  /** 关注列表自动重试计数与定时器（1s → 3s → 8s，最多 3 次） */
  const followedRetryRef = useRef(0);
  const followedRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 列表 loading 的超时兜底定时器（10s：弱网悬挂时也不让列表一直停在骨架，见 loadFollowed） */
  const followedLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 上一次「退房后静默刷新列表」的时间（节流 2s，见 closeRoom） */
  const lastCloseRefreshRef = useRef(0);

  /**
   * 关注列表自动重试。
   *
   * 为什么需要（用户反馈 2026-09-28）：从偶像房间退出来后，房间列表偶发整片空白
   * （用户描述为"白屏"），以前只能手动点右上角「重新加载」才回来。
   * 现在失败或算出空结果时自动补拉三次 —— 用户看到的是"自己会回来"，而不是"又坏了"。
   */
  const scheduleFollowedRetry = useCallback(() => {
    if (followedRetryRef.current >= 3) return;
    followedRetryRef.current += 1;
    const delay = [1000, 3000, 8000][followedRetryRef.current - 1] ?? 8000;
    if (followedRetryTimerRef.current) clearTimeout(followedRetryTimerRef.current);
    followedRetryTimerRef.current = setTimeout(() => loadFollowedRef.current(true), delay);
  }, []);

  const loadFollowed = useCallback(async (silent = false) => {
    if (!token) {
      // 与下面「空结果不清空」同一条纪律：登录态短暂缺失时也不要把已有列表清掉
      if (followedRef.current.length === 0) setFollowed([]);
      return;
    }
    const seq = ++followedSeqRef.current;
    setFollowedLoading(true);
    /**
     * 「房间列表被卡没」的超时兜底（用户 2026-09-30）：
     * 请求若因弱网悬挂而既不 resolve 也不 reject，loading 会一直为 true →
     * 列表只剩骨架转圈，看起来就是"被卡没了"。10s 后强制结束 loading，
     * 交回「有数据就显示数据 / 没数据就显示空态或错误态」。
     */
    if (followedLoadingTimerRef.current) clearTimeout(followedLoadingTimerRef.current);
    followedLoadingTimerRef.current = setTimeout(() => {
      followedLoadingTimerRef.current = null;
      if (seq === followedSeqRef.current) setFollowedLoading(false);
    }, 10_000);
    try {
      const idsRes = await pocketApi.getFollowedIds();
      // 迟到的响应直接丢弃：避免「旧请求最后返回」把新结果覆盖（列表忽多忽少的经典成因）
      if (seq !== followedSeqRef.current) return;
      const idsArr = unwrapList(idsRes, ['content.data', 'content', 'data', 'list']).map(String);
      setFollowedIds(new Set(idsArr));
      const followedMembers = idsArr.map((id: string) => {
        const member = members.find((item: any) => String(item.id || item.userId) === id);
        return { memberId: id, member };
      }).filter((item: any) => item.member?.channelId);
      /**
       * ⚠️ 防御：**不要把「空结果」当成「真的没有关注房间」**。
       *
       * 用户反馈（2026-09-28）：从偶像房间退出来后，房间列表偶发整片空白
       * （看着像白屏），必须点右上角「重新加载」才回来。
       *
       * 本列表是「接口返回的关注 id」×「本地成员库」现算的，两种情况下会算成空：
       *   ① 接口偶发成功但返回空列表；
       *   ② 成员库还没就绪（`members.find` 全落空 → 被下面 filter 掉）。
       * 这两种都不是用户取消了关注，直接 `setFollowed([])` 会把**已有的好数据清空**，
       * 而且走的是成功分支、不报错 → 落到「暂无关注房间」空态，只能手动救。
       * 所以：之前有数据、这次算空 → 保留旧列表 + 自动重试，绝不清空。
       */
      if (followedMembers.length === 0 && followedRef.current.length > 0) {
        scheduleFollowedRetry();
        return;
      }
      const serverIds = followedMembers.map((item: any) => Number(item.member?.serverId || 0)).filter((id: number) => id > 0);
      // 小房间没有独立 serverId，用 yklzId（小房间 channelId）一起查询最新消息，
      // 否则小房间在列表里永远显示「暂无消息」
      const smallRoomIds = followedMembers.map((item: any) => Number(item.member?.yklzId || 0)).filter((id: number) => id > 0);
      const queryIds = Array.from(new Set([...serverIds, ...smallRoomIds]));
      const lastMsgsRes = queryIds.length ? await pocketApi.getLastMessages(queryIds) : null;
      const lastMsgs = unwrapList(lastMsgsRes, ['content.lastMsgList', 'content.data', 'data', 'lastMsgList']);
      /**
       * 一次性诊断：把首个「最新消息」样本写进运行日志。
       * 该接口官方无字段文档（见 roomToken 说明），未读判据靠猜字段名时非常难定位 ——
       * 有这一行，出问题用户可在「设置 → 运行日志」把样本发来，一眼就能看出真实字段名。
       */
      if (!loggedLastMsgSampleRef.current && lastMsgs.length) {
        loggedLastMsgSampleRef.current = true;
        logInfo(`[unread] 最新消息样本 keys=${Object.keys(lastMsgs[0]).join(',')} json=${JSON.stringify(lastMsgs[0]).slice(0, 240)}`, 'room');
        // 关键诊断：`unreadCount` / `msgTime` 到底有没有（上游桌面端角标就靠它）
        logInfo(
          `[unread] 各条目未读数 ${lastMsgs.slice(0, 8).map((m: any) => (
            `${m.channelId}:unread=${m.unreadCount ?? '-'} time=${m.msgTime ?? '-'}`
          )).join(' | ')}`,
          'room',
        );
      }
      const followedRows = followedMembers.map((item: any) => ({
        ...item,
        lastMessage: findLastMessage(lastMsgs, item.member),
        lastSmallMessage: findSmallLastMessage(lastMsgs, item.member),
      }));
      setFollowed(followedRows);
      /**
       * 首屏/重拉后立刻补一轮真实正文：列表接口的 msgContent 对回复消息只给
       * 「[回复消息]」，等 60s 详情 sweep 才变就是用户看到的「预览延迟」。
       */
      void refreshRoomListPreviews(followedRows, { force: true });
      // 上麦检测：扫描关注成员房间语音状态（静默，失败忽略）。结果写入 onMicStore 供
      // 房间列表「上麦中」徽标与房间内上麦按钮共用。
      const onMicInputs = followedMembers
        .map((item: any) => ({
          memberId: item.memberId,
          name: String(item.member?.ownerName || item.member?.name || item.memberId),
          channelId: String(item.member?.channelId || ''),
          serverId: String(item.member?.serverId || ''),
          smallChannelId: String(item.member?.yklzId || ''),
          state: String(item.member?.state || ''),
        }))
        .filter((m: any) => m.channelId);
      if (onMicInputs.length) useOnMicStore.getState().scan(onMicInputs);
      // 直播状态：拉取首页直播列表（非阻塞），按主播 id / liveRoomId / 昵称匹配关注成员点亮状态点
      pocketApi.getLiveList({ record: false, next: 0, size: 100 }).then((res: any) => {
        const liveItems = unwrapList(res, ['content.liveList', 'content.list', 'data.liveList', 'liveList', 'list', 'data']);
        // 同轮询分支：内容等价就复用旧引用，避免整页（几十行）无谓重渲染
        setLiveNow((prev) => {
          const next = buildLiveIndex(liveItems);
          return sameLiveIndex(prev, next) ? prev : next;
        });
      }).catch(() => {});
      /**
       * 未读基线：首次见到某个房间时，把它记成「已读到这里」——
       * 值是该房间**当时的最后活动时间**（服务器消息时间），**不是 `Date.now()`**。
       *
       * ⚠️ 改造前用设备时间当基线，正是「房间列表新消息一直不显示」的根因：
       * 设备时钟只要比服务器快几秒，之后到达的消息（服务器时间）就永远 `< 基线`
       * → `hasUnread` 恒 false、角标永不出现，而且基线已落盘，重启也救不回来。
       * 只补缺失项，不覆盖已有的已读记录。
       */
      const unreadBaseline: Record<string, number> = {};
      /** 分侧指纹基线：键 = `roomUnreadKey(id, side)`（大房间 `#b` / 小房间 `#s`） */
      const unreadTokens: Record<string, string> = {};
      for (const row of followedRows) {
        const id = String(row.memberId || row.member?.id || '');
        if (!id) continue;
        // 已读基线是**房间级**的（进房即读全房间）：取大/小两侧更晚的那条
        unreadBaseline[id] = roomLastActivity(row);
        for (const side of ROOM_UNREAD_SIDES) {
          const token = roomSideToken(row, side as RoomMode);
          const key = roomUnreadKey(id, side);
          if (token && key) unreadTokens[key] = token;
        }
      }
      useRoomUnreadStore.getState().seedReadAt(unreadBaseline);
      /**
       * 指纹计数：上一轮已见过指纹、这一轮指纹变了 ≈ 有新消息 → 计数 +1 并推进指纹。
       * 这让**没有云信实时通道**（实时 bump 恒 0）的设备上，房间列表也能显示「更新的消息数量」
       * 而不是只有「新」——一轮轮询（约 30s）里爆发的多条消息只计 1 条，是本地口径的近似。
       * 实时通道计过的房间本轮跳过计数（只对齐指纹），防止同一条消息被两条通道各计一次。
       * （逻辑抽在 applyFingerprintCounts，30s 轮询的 refreshLastMessages 也复用它）
       */
      applyFingerprintCounts(followedRows);
      // 指纹基线：只补缺失项 —— 首载把「当前这条最新消息」记为已见，之后再变才算有新消息
      useRoomUnreadStore.getState().seedTokens(unreadTokens);
      // 退房收尾（见 closeRoom）：此刻已拿到最新指纹，把它写成「已见」，
      // 避免「在房间里看完的消息」退房后又被判成未读
      /**
       * 退房收尾（见 closeRoom）。
       *
       * ⚠️ 用户反馈（2026-09-28）：「在房间里**看着到达**的消息，退回列表仍显示为新消息」。
       * 修复前的漏点：这里只在 fresh 行有 token 时才写**指纹**基线，
       * **时间基线（markRead）从来没按最新一页推进** —— 而列表行的未读判据是
       * `lastActivity > lastRead || token !== seenToken`（任一成立即亮「新」）。
       * 于是只要时间那条成立（房间里看到的新消息把 lastActivity 推高了），
       * 退房后照样亮「新」，与指纹基线是否推进无关。
       *
       * 现在**两条基线一起推到最新一页的值**：都是服务器时间域/服务端指纹，
       * 绝不引入设备时间（时间域铁律，见 roomUnread.ts）。
       */
      const pendingSeen = pendingSeenRef.current;
      if (pendingSeen) {
        const freshActivity = Number(unreadBaseline[pendingSeen] || 0);
        const freshBig = String(unreadTokens[roomUnreadKey(pendingSeen, 'big')] || '');
        const freshSmall = String(unreadTokens[roomUnreadKey(pendingSeen, 'small')] || '');
        // 一次提交：清零两侧计数 + 推进房间级已读基线 + 两侧「已见」一起推进
        //（退房的语义是「这个房间我看过了」，大/小房间都算看过）
        useRoomUnreadStore.getState().applyUnread({
          read: freshActivity > 0 ? { [pendingSeen]: freshActivity } : {},
          seen: {
            ...(freshBig ? { [roomUnreadKey(pendingSeen, 'big')]: freshBig } : {}),
            ...(freshSmall ? { [roomUnreadKey(pendingSeen, 'small')]: freshSmall } : {}),
          },
        });
        /**
         * ★ 退房收尾立即落盘（用户 2026-10-01 性能优化配套）：
         * 未读落盘已改成 800ms 防抖，而「进房即已读/退房清零」是用户认为**已经生效**的状态 ——
         * 若这期间直接杀进程，重启后未读会「复活」。这里强制 flush，其余高频 bump 仍走防抖。
         */
        flushRoomUnreadPersist();
        // 房间已不在列表（取关/被过滤）→ 也要清掉待收尾，否则会一直挂着
        if (freshActivity > 0 || freshBig || freshSmall || followedRows.length > 0) pendingSeenRef.current = '';
      }
      if (!silent) showToast(t('已加载 {count} 个房间', { count: followedMembers.length }));
      setFollowedError('');
      followedRetryRef.current = 0; // 成功即清零重试计数
    } catch (e) {
      if (seq !== followedSeqRef.current) return;
      setFollowedError(errorMessage(e));
      if (!silent) showToast(t('加载失败：{msg}', { msg: errorMessage(e) }));
      // 失败不再"等用户点重新加载"：自动补拉（1s → 3s → 8s，最多 3 次）
      scheduleFollowedRetry();
    }
    finally {
      /**
       * ⚠️ loading 只由**当前这次请求**关闭（用户 2026-09-30：「房间列表经常被卡没」）。
       * 旧请求（seq 已过期）的 finally 会把新请求刚打开的 loading 提前关掉 →
       * 骨架消失、新数据还没到 → 列表瞬间只剩「暂无关注房间」的空态（看起来就是被卡没了）。
       */
      if (followedLoadingTimerRef.current) { clearTimeout(followedLoadingTimerRef.current); followedLoadingTimerRef.current = null; }
      if (seq === followedSeqRef.current) setFollowedLoading(false);
    }
  }, [members, showToast, t, token, applyFingerprintCounts, scheduleFollowedRetry]);
  loadFollowedRef.current = loadFollowed;

  /* ───────── 房间列表下拉刷新（用户 2026-11-11）─────────
   * 一次「关注列表 + 最新消息 + 指纹计数」的完整重拉，不用干等 30s 定时轮询。
   *
   * ⚠️ refreshing 必须是**独立状态**，不能复用 followedLoading：
   * 30s 轮询 / 失败自动重试也会翻动 followedLoading，复用会让转圈一直亮着
   * （MediaScreen 踩过同一个坑，注释也留在那边）。
   * ⚠️ 弱网悬挂兜底：12s 内一定收圈，否则下拉一次之后转圈永远挂在那里。
   */
  const roomsRefreshBusyRef = useRef(false);
  const [roomsRefreshing, setRoomsRefreshing] = useState(false);
  const handlePullRefresh = useCallback(() => {
    if (roomsRefreshBusyRef.current) return; // 连拉两次只跑一轮
    roomsRefreshBusyRef.current = true;
    setRoomsRefreshing(true);
    const timer = setTimeout(() => {
      roomsRefreshBusyRef.current = false;
      setRoomsRefreshing(false);
    }, 12_000);
    void loadFollowed(true).finally(() => {
      clearTimeout(timer);
      roomsRefreshBusyRef.current = false;
      setRoomsRefreshing(false);
    });
    /**
     * ★ 手动刷新（用户 2026-11-13「一定要一次性翻到上次看到的位置为止」）：
     * 对每一侧跑 force 主计数 —— 忽略常规 8 页预算与跨轮断点，一次翻到该侧
     * 「上次看到的那条消息 id」；与列表刷新并行，不阻塞 12s 收圈。
     */
    void flushOwnerFeedUnread(followedRef.current).catch(() => {});
    // 手动刷新同时把大/小房间两条预览一次性拉到最新（不等分片轮转）
    void refreshRoomListPreviews(followedRef.current, { force: true });
  }, [loadFollowed]);

  /**
   * 直播页「进入房间」入口：Media 的直播/录播播放器带上 openMemberId 跳到本 tab 时，
   * 自动打开该成员的房间（已关注直接用列表行；未关注从全量成员库找，房间页本身不要求关注）。
   */
  useEffect(() => {
    const openId = String((route.params as any)?.openMemberId || '');
    if (!openId) return;
    (navigation as any).setParams?.({ openMemberId: undefined });
    if (String(selectedRoom?.id || '') === openId) return;
    const row = followed.find((r) => String(r.memberId) === String(openId));
    const member = row?.member || members.find((m) => String(m.id) === openId);
    if (member) openRoom(member);
    else showToast(t('未找到该成员的房间'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(route.params as any)?.openMemberId]);

  /** 上一次真正跑过全量刷新的时刻（0 = 从没跑过）：进出房 / 切 tab / 回前台的重复 tick 在这里被吃掉 */
  const lastTickRef = useRef(0);

  /**
   * 回到前台立刻刷新一次房间列表。
   *
   * 下面的 30s tick 只在**页面挂载期间**跑，而 App 切到后台时 JS 定时器会被挂起：
   * 「切出去一会儿再回来」时列表与未读要等下一轮 tick（最坏 30s+）才有变化 —— 用户体感就是
   * 「有新消息但列表里什么都不显示」。回前台补一次静默刷新，让未读/预览立刻对上。
   * 用 ref 调用，避免把 loadFollowed 放进依赖引发无谓重建。
   *
   * ★ 用户 2026-10-01 性能优化：以前这里**无视节流**直接全量刷新 ——
   * 快速切前后台（看一眼消息就切走）会反复触发一整轮
   *（getLiveList + 全量房间最新消息 + 上麦扫描），请求互相竞态（列表闪、卡）。
   * 现在复用 30s tick 的同一套 shouldRunTick（8s 内刚刷过就跳过）：
   * 最坏「回前台晚 8s 更新」，与 30s 轮询口径一致。
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      // activeChannelRef 非空即「当前在房间里」（openRoom 写入、closeRoom 清空）——房间里自带轮询，列表不必刷
      if (activeChannelRef.current) return;
      // 回前台立即把两条预览拉到最新：快扫不受 8s 全量 tick 节流限制（自身有 inflight 保护）
      void refreshRoomListPreviews(followedRef.current, { force: true });
      if (!shouldRunTick(lastTickRef.current, Date.now(), TICK_MIN_INTERVAL_MS)) return;
      loadFollowedRef.current?.(true);
    });
    return () => sub.remove();
  }, []);

  /**
   * 列表预览分片快扫（用户 2026-11-13「两条消息有些延迟」）：
   * 5s 扫一片、3 片 = 15s 覆盖全部关注房间的大/小两侧；只在列表页前台可见时跑。
   * 与 30s tick / 5s 通知轮询彼此独立：不拉直播列表、不做指纹计数、不推进消息游标。
   */
  useEffect(() => {
    if (selectedRoom || !isFocused) return undefined;
    let active = true;
    const run = () => {
      if (!active || AppState.currentState !== 'active') return;
      void refreshRoomListPreviews(followedRef.current);
    };
    const id = setInterval(run, 5000);
    return () => { active = false; clearInterval(id); };
  }, [selectedRoom, isFocused]);

  // 列表页实时刷新：关注成员的直播状态 + 上麦状态，每 30s 静默刷新（仅列表视图时）
  // 列表页实时刷新：关注成员的直播状态 + 上麦状态 + 最新消息，每 30s 静默刷新（仅列表视图时）。
  // 之前直播状态 60s、最新消息完全不刷新（只有 loadFollowed 手动拉一次）→ 卡片「最新消息」长期静止。
  // 现在合并到一个 tick：直播/上麦 + 最新消息一起 30s 刷新；followedRef 持最新列表避免闭包过期。
  useEffect(() => {
    if (selectedRoom) return;
    let active = true;
    /**
     * ⚠️ 用户 2026-09-30：「反复切换界面进出房间会卡顿」。
     * 这个 effect 的依赖里原本有 `applyFingerprintCounts`（它随进出房换引用），
     * 加上 `isFocused`，于是**每进一次房、每退一次房、每切一次 tab 都立刻跑一整轮**：
     * getLiveList(size:100) + 全量房间最新消息 + 上麦扫描。反复进出 = 反复全量请求，
     * 请求互相竞态（seq 反复作废）→ 列表闪、页面卡、"看起来像卡没了"。
     * 现在：函数引用恒定 + 8s 节流，只有真正到期（或首次装载）才打请求。
     */
    const refreshLiveAndMic = () => {
      if (!active) return;
      pocketApi.getLiveList({ record: false, next: 0, size: 100 }).then((res: any) => {
        if (!active) return;
        const liveItems = unwrapList(res, ['content.liveList', 'content.list', 'data.liveList', 'liveList', 'list', 'data']);
        /**
         * ⚠️ 内容等价时**复用旧引用**（用户 2026-09-30：「30s 卡一下 / 列表闪一下」）：
         * `buildLiveIndex` 每轮都造新对象，直接 setLiveNow 会让整个房间页
         *（几十行 RoomListRow + 所有 useMemo）每 30s 全量重渲染，哪怕一个成员都没开播。
         */
        setLiveNow((prev) => {
          const next = buildLiveIndex(liveItems);
          return sameLiveIndex(prev, next) ? prev : next;
        });
      }).catch(() => {});
      const cur = followedRef.current;
      if (cur.length) {
        const onMicInputs = cur
          .map((item: any) => ({
            memberId: item.memberId,
            name: String(item.member?.ownerName || item.member?.name || item.memberId),
            channelId: String(item.member?.channelId || ''),
            serverId: String(item.member?.serverId || ''),
            smallChannelId: String(item.member?.yklzId || ''),
            state: String(item.member?.state || ''),
          }))
          .filter((m: any) => m.channelId);
        if (onMicInputs.length) useOnMicStore.getState().scan(onMicInputs);
      }
    };
    const refreshLastMessages = () => {
      if (!active) return;
      const cur = followedRef.current;
      if (!cur.length) return;
      const serverIds = cur.map((item: any) => Number(item.member?.serverId || 0)).filter((id: number) => id > 0);
      const smallRoomIds = cur.map((item: any) => Number(item.member?.yklzId || 0)).filter((id: number) => id > 0);
      const queryIds = Array.from(new Set([...serverIds, ...smallRoomIds]));
      if (!queryIds.length) return;
      pocketApi.getLastMessages(queryIds).then((res: any) => {
        if (!active) return;
        const lastMsgs = unwrapList(res, ['content.lastMsgList', 'content.data', 'data', 'lastMsgList']);
        /**
         * ⚠️ 指纹没变就**复用原行对象引用**（用 messageToken 比较两条最新消息）。
         * RoomListRow 是 React.memo：以前这里每 30s 给所有行新建对象 → 全部行失效重渲染
         *（房间多时表现为「定时卡一下 + 列表闪一下」）；
         * 复用引用后只有真的来了新消息那几行才重渲染。
         */
        const updatedRows = cur.map((f) => {
          const nextBig = findLastMessage(lastMsgs, f.member);
          const nextSmall = findSmallLastMessage(lastMsgs, f.member);
          if (
            messageToken(f.lastMessage) === messageToken(nextBig)
            && messageToken((f as any).lastSmallMessage) === messageToken(nextSmall)
          ) return f;
          return { ...f, lastMessage: nextBig, lastSmallMessage: nextSmall };
        });
        setFollowed(updatedRows);
        // ⚠️ 指纹计数必须挂在 30s 轮询上（此前只在 loadFollowed 里跑 → 未读数字长期不增长）
        applyFingerprintCounts(updatedRows);
      }).catch(() => {});
    };
    const tick = (force = false) => {
      const now = Date.now();
      if (!shouldRunTick(lastTickRef.current, now, TICK_MIN_INTERVAL_MS, force)) return;
      lastTickRef.current = now;
      refreshLiveAndMic();
      refreshLastMessages();
    };
    tick();
    /**
     * 后台不轮询（省电省流量）——**且必须在页面失焦时也停**（用户 2026-09-30：
     * 「直播退出所有界面都出现卡顿」的普查要求）：
     * 以前只要没进房间就每 30s 全速跑一轮 `getLiveList(size:100)` + 全量房间最新消息
     * + 成员上麦扫描（`useOnMicStore.scan`，每人 2 个任务）——人在设置页/私信页/直播页时
     * 也照跑不误，是"退出直播/退房后仍卡"的最大后台负载来源。
     */
    if (!isFocused) return () => { active = false; };
    const id = setInterval(() => { if (AppState.currentState === 'active') tick(); }, 30000);
    return () => { active = false; clearInterval(id); };
  }, [selectedRoom, applyFingerprintCounts, isFocused]);

  // Y23: 关注列表在 members 就绪后只拉一次（loadFollowed 依赖 members，随其变化会反复重拉）
  const followedFetchedRef = useRef(false);
  useEffect(() => {
    if (!members.length || followedFetchedRef.current) return;
    followedFetchedRef.current = true;
    loadFollowed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.length]);

  /**
   * 确保「某侧的房主发言采样」存在：缺失时后台补一次 homeowner 请求
   * （**只用于采样与消息键集合，不覆盖当前视图的 roomMessages**）。
   *
   * 为什么必须补：群聊视图的数据来自 all 接口（最新 50 条，可能不含房主发言），
   * 若用户在群聊状态下切大/小侧，就没有任何一次 homeowner 请求 → 采样为空 →
   * 7 天 idle 判定拿不到"房主最近何时发言" → 又回误报。
   */
  const ensureOwnerSample = useCallback(async (channelId: string, room: Member, side: RoomMode) => {
    if (ownerSampleBySideRef.current[side].sampled) return; // 该侧已有采样（含"已采样但 0 条"）
    if (ownerSampleInflightRef.current[side]) return; // 在途，避免重复请求
    ownerSampleInflightRef.current[side] = true;
    try {
      const res = await pocketApi.getRoomMessages({
        channelId,
        serverId: String((room as any).serverId || ''),
        nextTime: 0,
        fetchAll: false,
        fallbackChannelId: side === 'small' ? String((room as any).channelId || '') : undefined,
      });
      /**
       * 串味拦截（同首屏/上拉）：小房间不可用时这里拿回的是**大房间**的房主发言。
       * 不拦的话会被记成「小房间采样」→「7 天内偶像无消息」判定与房主发言键集合全都串侧
       *（真机日志里的 `采样小=36` 就可能来自回退数据）。
       */
      if (!isDetailFromSide((res as any)?._request?.payload?.channelId, channelId)) {
        logWarn(`[room] 房主采样：小房间详情回退到大房间（本侧=${channelId}），不记采样`, 'room');
        return;
      }
      const list = unwrapList(res, ['content.messageList', 'content.message', 'content.messages', 'content.list', 'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list']);
      const sorted = sortMessagesNewestFirst(list.filter(Boolean));
      let latest = 0;
      for (const m of sorted) {
        const ms = getMessageTime(m);
        if (ms > latest) latest = ms;
        ownerMsgKeysRef.current.add(messageKey(m));
      }
      // 已有采样就不覆盖（正常不会发生：进函数已判）
      setOwnerSampleBySide((prev) => (prev[side].sampled ? prev : { ...prev, [side]: { sampled: true, count: sorted.length, latestMs: latest } }));
    } catch { /* 采样失败不影响消息与播放；下次切侧/进房会再试 */ }
    finally { ownerSampleInflightRef.current[side] = false; }
  }, []);

  // mode: 'internal' = 同房间内切换大/小房间或成员/粉丝发言（同一成员，标题/背景不变，必须秒切、无骨架）
  //       'enter'    = 从房间列表点成员进入（跨成员/跨房间，保留骨架隔离旧房间残留）
  const openRoom = useCallback(async (room: Member, nextMode: RoomMode = 'big', includeFans = showFanMessages, mode: 'internal' | 'enter' = 'enter') => {
    /**
     * 进房（'enter'）**一律重置为「只看偶像消息」**，不由上一次的开关状态决定。
     *
     * 用户反馈：「点进房间应该是只显示偶像的信息，而不是根据是否点击群聊按钮来判断」。
     * 根因：`showFanMessages` 是组件级 state，退房后不清；从列表进下一个房间时
     * `includeFans = showFanMessages` 会把上一个房间的群聊状态继承过来
     * → 于是「进房看到什么」取决于上次有没有点过群聊按钮。
     * 开关属于**房间内的临时视图切换**，不应跨房间继承。
     * 'internal'（同房间内切大/小房间、点群聊按钮、左右滑手势）保留当前状态。
     */
    const wantFans = mode === 'enter' ? false : includeFans;
    // D3：进房耗时诊断（runtimeLog 可查看；真机反馈卡顿时据此定位是消息接口慢还是渲染慢）
    const roomOpenStart = Date.now();
    const channelId = roomChannelId(room, nextMode);
    if (!channelId) {
      showToast(nextMode === 'small' ? t('这个成员缺少小房间 channelId，无法打开小房间。') : t('这个成员缺少大房间 channelId，无法打开房间。'));
      return;
    }
    /**
     * 进房前先复位所有全屏浮层 / 弹窗开关（同 closeRoom 的理由）。
     * 覆盖「不经过 closeRoom 直接换房」的路径（例如从房间内点另一个成员/直播卡）：
     * 这些开关不会自己关，黑幕 + 弹窗会跟着用户到新房间 ——
     * 视觉上就是「遮罩盖住顶栏以下、点哪儿都没反应」（用户 2026-09-30 反馈）。
     */
    setGiftVisible(false);
    setUserCard(null);
    setShowRoomReplay(false);
    setPinnedSheetVisible(false);
    setFullImageUrl('');
    setImageUrls([]);
    // 进新房间也复位搜索态（同 closeRoom 的理由：过滤会把消息全隐藏）
    setRoomSearchQuery('');
    setRoomSearchOpen(false);
    /**
     * 只有**换房（房主变了）**才清空「房主发言」键集合与采样。
     * ⚠️ 不能无条件清：openRoom 也承担 internal 的「切大/小侧、切只看偶像/群聊」，
     * 一清就再也补不回来（切群聊后 wantFans=true 不会请求 homeowner）——真机日志里
     * `房主采样=0条` 导致误报就是这么来的（用户 2026-10-02 第二轮返工）。
     */
    if (selectedRoomIdRef.current && selectedRoomIdRef.current !== String(room.id || '')) {
      ownerMsgKeysRef.current.clear();
      setOwnerSampleBySide({ big: EMPTY_OWNER_SAMPLE, small: EMPTY_OWNER_SAMPLE });
      ownerSampleInflightRef.current = { big: false, small: false };
    }
    setSelectedRoom(room);
    // 通知轮询用：记下「正在看哪个房间」，这个房间不弹通知（用户 2026-11-09）
    useRoomPresenceStore.getState().setCurrentRoom(String(room.id || ''));
    /**
     * 进房即视为已读：清零本地累计 + 把「已读到哪」记为该房间**当前的最后活动时间**。
     * ⚠️ 必须是服务器消息时间（roomActivityRef 的镜像值），不能用 `Date.now()`
     * —— 见 src/services/roomUnread.ts 的「时间域铁律」。
     */
    // 「上次看到」快照：必须在 markRead **之前**取出旧基线（markRead 马上会把它覆盖成
    // 当前的最后活动时间）。聊天列表用它定位「上次看到这里」分隔行：
    // 基线之后的第一条消息挂分隔符；0 = 该房间从未读过 → 不显示分隔行。
    const lastSeenBaseline = Number(useRoomUnreadStore.getState().lastReadAt[String(room.id || '')] || 0);
    setRoomEntryBaseline(lastSeenBaseline);
    // 每次真正进房都允许「进房定位 effect」重新定位一次：
    // 作废上一轮的 key 与在途计时器，保证「从别的页面切回房间」一定重新定位到分隔行/最新
    posRunRef.current.cancelled = true;
    if (posRunRef.current.timer) clearTimeout(posRunRef.current.timer);
    posRunRef.current = { key: '', cancelled: true, timer: null, target: -1, advancedTo: -1, autoLoadLeft: 3 };
    posUserScrolledRef.current = false; // 新一轮进房：重新允许自动定位
    logInfo(`[lastseen] open room=${String(room.id || '')} baseline=${lastSeenBaseline}`, 'room');
    useRoomUnreadStore.getState().markRead(String(room.id || ''), roomActivityOf(room));
    // 指纹基线：把「进房这一刻的最新消息」记为已见（不依赖时间字段名的第二条判据）。
    // 分侧后要**两侧都推进**，否则另一侧的旧指纹会让刚进过的房间立刻冒「新」。
    const openSeen = roomSeenPair(room);
    useRoomUnreadStore.getState().markSeenBoth(String(room.id || ''), openSeen.big, openSeen.small);
    /**
     * 精确计数基线随进房清零（用户 2026-11-10「5 条显示 13」）：
     * `sideSeenAt`（该侧最后看过的消息时间）若还是几小时前的旧值，30s 轮询拉最新一页时
     * 会把**房间里已经读过**的消息再数一遍。清零后：房间内 5s 刷新会用当前最新消息重播种，
     * 退房后只会数「退房之后」新到的消息。
     */
    useRoomUnreadStore.getState().applyUnread({
      seenAt: {
        [roomUnreadKey(String(room.id || ''), 'big')]: 0,
        [roomUnreadKey(String(room.id || ''), 'small')]: 0,
      },
    });
    roomMaxSeenRef.current = 0;
    const openSeq = ++roomSeqRef.current;
    const channelChanged = activeChannelRef.current !== channelId;
    activeChannelRef.current = channelId;
    // 发送坐标同步刷新（与 channelId 同一事务，保证 serverId 与 channelId 永远配对）
    activeRoomRef.current = {
      channelId,
      serverId: String((room as any).serverId || ''),
      memberId: String(room.id || ''),
    };
    // internal：同房间内切换大/小房间或成员/粉丝发言（同一成员、同一背景）。
    // 不清 meta、不进骨架，上一帧消息直接被新数据覆盖 → 标题/背景秒切、无割裂（fix7 回归修复点）。
    // enter：从列表点成员进入房间（跨成员/跨房间），保留骨架隔离旧房间残留 + 清 meta 让本地缓存瞬时显示。
    if (mode === 'internal') {
      // 同房间内切换：不清 meta、不进骨架 —— 标题/背景秒切、无割裂（fix7 回归修复点）
    } else {
      if (channelChanged) {
        setRoomMeta({ name: '', bg: '' });
        // 跨房间：清掉上一房间的草稿与错误提示 —— 否则草稿会跟着进新房间，
        // 一点发送就把给 A 房间的话发到了 B 房间（「发送错误信息」的另一条路径）
        setRoomDraft('');
        setRoomSendHint('');
      }
    }
    // 切房/切侧先清「小房间不可用」标记：由本次请求的实际命中频道重新判定（见下方串味拦截）
    setRoomSideClosed(false);
    setRoomSearchQuery('');
    setPlayingMedia(null);
    /**
     * 分侧键：消息缓存 / 保留上一帧 / keepPrev 守卫全部以它为准（`#b` / `#s`）。
     * 键规则与未读分侧同一套（roomSideKey），避免「两套键各写各的」再次串味。
     */
    const sideKey = roomSideKey(String(room.id || ''), nextMode);
    roomMsgSideRef.current = sideKey;
    // internal 同侧切换（群聊 ⇄ 只看偶像）：保留上一帧消息直接覆盖（秒切，不闪、无割裂）；
    // internal 切侧（大 ↔ 小）：**绝不保留上一侧的消息**；
    // enter 跨房间：★ 先用**内存缓存**立即渲染（用户 2026-10-01 性能优化：
    // 进房接口 400-800ms 期间列表全空 = "进房慢"的主要体感），网络回来后原逻辑覆盖/合并；
    // 无缓存才进骨架屏。缓存按**分侧键**存最近一页，引用复用 → chatRowCache 直接命中，渲染快。
    if (mode === 'internal') {
      if (channelChanged) {
        /**
         * ★ 切侧必须丢掉上一侧消息（用户 2026-10-01：「长期不发小房间的偶像房间」
         * 切进小房间，屏幕上是大房间的聊天记录）。
         *
         * 以前这里刻意不清（为了"秒切不闪"），但两侧是**不同的频道**：
         * 小房间接口返回 0 条时，保留的那一帧就成了「小房间里显示大房间消息」；
         * 再叠加「只看偶像 0 条 → 自动展开群聊」，小房间彻底被大房间内容取代。
         * 现在：有该侧缓存先秒开（确定同侧、不会串），没有就清空进 loading。
         */
        // ⚠️ 已确认不可用的一侧不读缓存（里面可能是串味数据，见 roomSideUnavailable）
        const cached = roomSideUnavailable.has(sideKey) ? null : cachedRoomMessages(sideKey);
        if (cached && cached.length) {
          setRoomMessages(cached);
          setRoomLoadedOnce(true);
          setLoading(false);
        } else {
          setRoomMessages([]);
          setLoading(true);
          setRoomLoadedOnce(false);
        }
      }
      // 同侧切换不设 loading/roomLoadedOnce=false：
      // 否则切换粉丝/成员发言时 loading 态会让消息区闪转圈、整段请求期间卡住（用户实测切换慢）。
    } else if (channelChanged) {
      const cached = roomSideUnavailable.has(sideKey) ? null : cachedRoomMessages(sideKey);
      if (cached && cached.length) {
        setRoomMessages(cached);
        setRoomLoadedOnce(true);
        setLoading(false);
      } else {
        setRoomMessages([]);
        setLoading(true);
        setRoomLoadedOnce(false);
      }
    }
    setRoomMsgError('');
    setRoomNextTime(0);
    setHasMoreMessages(false);
    // 复位「在途」标志：本函数刚 `++roomSeqRef`，任何在途的 loadMore / refresh 都已作废，
    // 而它们的 finally 现在带代次守卫（不会再去清标志）→ 必须在这里复位，
    // 否则新房间的上拉会被上一房间遗留的 true 标志吞掉（表现为「切房后第一次上拉没反应」）。
    loadingMoreMessagesRef.current = false;
    setLoadingMoreMessages(false);
    refreshingRef.current = false;
    setRoomMode(nextMode);
    setShowFanMessages(wantFans);
    /**
     * ★ 进房并行化（用户 2026-11-12「进入房间的速度比较慢」）：
     * 房间元数据（名字/背景）与上麦扫描**不再等首屏消息返回后才发起**。
     * 旧链路是 `await getRoomMessages` 成功之后才 `.then(getRoomMeta)` ——
     * 冷启动第一次进房要连等「消息 RTT + 元数据 RTT」（小房间的 room/info 还会串塞纳河
     * 兜底，最坏 2~3 个串行请求）才看到背景图，期间背景区一片空白。
     * 现在两者与消息请求同时起步，背景/标题与消息一起到达。
     *
     * 元数据来源优先级：本次会话内存缓存 → 跨启动持久化缓存（services/roomMetaCache）
     * → 网络。命中缓存 = 第一帧就有房间名 + 本地背景图（图文件由 roomBgCache 落盘）。
     */
    const cachedMeta = roomMetaCache.current[channelId] || getRoomMetaCached(channelId);
    if (cachedMeta && (cachedMeta.name || cachedMeta.bg)) {
      roomMetaCache.current[channelId] = cachedMeta;
      setRoomMeta({ ...cachedMeta, bg: getBgDisplayUri(cachedMeta.bg) });
      if (cachedMeta.bg) ensureBgCached(cachedMeta.bg); // 后台补齐/校验本地副本
    } else if (!roomMetaInflightRef.current.has(channelId)) {
      // 无缓存（或上次只拿到空值）：立刻发起，与消息请求并行；同一 channelId 不重复发
      if (Object.keys(roomMetaCache.current).length > 80) roomMetaCache.current = {};
      roomMetaInflightRef.current.add(channelId);
      // 小房间 room/info 服务端 2001 无权限（实测）→ getRoomMeta 内部回退塞纳河 server/detail
      pocketApi.getRoomMeta(channelId, nextMode === 'small' ? room.channelId : undefined, room.serverId)
        .then((meta) => {
          putRoomMetaCache(channelId, meta);
          // Y22: 期间已切房（seq 过期或 channelId 变化）则丢弃，避免旧房间标题/背景覆盖
          if (openSeq !== roomSeqRef.current || activeChannelRef.current !== channelId) return;
          if (meta.name || meta.bg) roomMetaCache.current[channelId] = meta;
          setRoomMeta({ ...meta, bg: getBgDisplayUri(meta.bg) });
          if (meta.bg) ensureBgCached(meta.bg); // 后台落盘，下次进房间直接本地显示
        })
        .catch(() => undefined)
        .finally(() => { roomMetaInflightRef.current.delete(channelId); });
    }
    // 上麦状态检测（驱动房间内上麦按钮；单成员扫描不影响其它成员）：同样与消息并行
    const ocChannel = roomChannelId(room, nextMode);
    if (ocChannel) {
      useOnMicStore.getState().scan([{
        memberId: String(room.id || ''),
        name: String(room.ownerName || room.id || ''),
        channelId: ocChannel,
        serverId: String(room.serverId || ''),
        smallChannelId: String(nextMode === 'small' ? (room.yklzId || '') : (room.channelId || '')),
      }]);
    }
    /** 同步准备阶段耗时（点击 → 所有 state/store 就位，即进房那一帧提交之前） */
    const prepMs = Date.now() - roomOpenStart;
    try {
      /**
       * ⚠️ 这两件事**并行**（用户反馈「进入房间很慢」）：
       *   · getNimLoginInfo：只为拿到自己的 userId（认自己发的消息、气泡右对齐）；
       *   · getRoomMessages：真正的首屏消息。
       * 以前是串行 `await` —— 首次进房（currentUserId 还没缓存时）要白等一次网络往返，
       * 而两者互不依赖（userId 不参与消息请求参数），没理由排队。
       * 用 allSettled：登录信息失败不该拖垮消息加载，反之亦然。
       */
      const [userInfoRes, msgRes] = await Promise.allSettled([
        currentUserId
          ? Promise.resolve(null as any)
          : pocketApi.getNimLoginInfo().catch(() => null),
        pocketApi.getRoomMessages({
          channelId,
          serverId: room.serverId,
          nextTime: 0,
          fetchAll: wantFans,
          fallbackChannelId: nextMode === 'small' ? room.channelId : undefined,
        }),
      ]);
      const userInfo = userInfoRes.status === 'fulfilled' ? userInfoRes.value : null;
      const nextCurrentUserId = currentUserId || currentUserIdFrom(userInfo);
      if (nextCurrentUserId) setCurrentUserId(nextCurrentUserId);
      // 消息是主任务：失败必须走 catch（哪怕登录信息那一路成功了）
      if (msgRes.status === 'rejected') throw msgRes.reason;
      const res = msgRes.value;
      const list = unwrapList(res, ['content.messageList', 'content.message', 'content.messages', 'content.list', 'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list']);
      const sorted = sortMessagesNewestFirst(list.filter(Boolean));
      diagnoseUndefined(sorted, 'OPEN');
      // Y22: 进房竞态——用户已切到别的房间/模式，丢弃慢响应，避免旧房间消息覆盖新房间
      if (openSeq !== roomSeqRef.current) return;
      /**
       * ★ 大／小房间串味拦截（用户 2026-11-12：「陈琳的小房间是不是关了，现在大房间和小房间串了」）。
       *
       * 小房间（yklzId）在服务端没有权限 / 已关闭时（实测 2001），`getRoomMessages` 会按
       * attempts 顺序**回退到 fallbackChannelId（= 同成员的大房间频道）并成功返回**；
       * 而消息体里根本没有 channelId 字段 → 大房间的聊天记录被当成小房间内容渲染。
       * 这就是「大小房间串了」：小房间点开是大房间的聊天记录。
       *
       * `tryPocketPost` 把实际命中的 payload 放在 `_request.payload.channelId`，比对即可识别
       * （与未读精确计数/服务端房主表同一判据，见 utils/roomMessageCursor.isDetailFromSide）。
       *
       * 命中回退时：**不渲染、不写分侧缓存、不推进分页游标、不记房主采样**，
       * 并标记「本侧不可用」交给消息区提示 —— 且**绝不走 1s/3s/8s 自动重试**
       *（重试只会一遍遍拿回大房间数据）。
       */
      const usedChannelId = String((res as any)?._request?.payload?.channelId ?? '');
      if (!isDetailFromSide(usedChannelId, channelId)) {
        setRoomMessages([]);
        setRoomNextTime(0);
        setHasMoreMessages(false);
        setRoomLoadedOnce(true);
        setRoomMsgError('');
        roomMsgRetryRef.current = 0;
        roomSideUnavailable.add(sideKey);
        forgetRoomMessages(sideKey);
        setRoomSideClosed(true);
        logWarn(
          `[room] 小房间不可用：详情回退到大房间 ch=${usedChannelId}（本侧=${channelId}）→ 不渲染、不缓存、不重试`,
          'room',
        );
        return;
      }
      /**
       * 空结果保护（用户 2026-09-30：「房间也容易刷没消息」）。
       *
       * 接口返回 200 但解析出 0 条（字段形态变化 / 服务端限流 / 频道刚建）时，
       * 以前会直接 `setRoomMessages([])` 把整屏消息抹掉、只剩空列表。
       * 现在：本地已有消息就**保留旧列表** + 静默重试一次；
       * 同时**不动** roomNextTime / hasMoreMessages —— 空的下一页游标会毁掉上拉加载。
       */
      const keepPrev = sorted.length === 0
        && roomMessagesRef.current.length > 0
        && roomMsgSideRef.current === sideKey;
      if (keepPrev) {
        setRoomLoadedOnce(true);
        setRoomMsgError('');
        setTimeout(() => {
          if (openSeq !== roomSeqRef.current) return;
          refreshRoomMessagesRef.current?.();
        }, 1200);
      } else {
        setRoomMessages(sorted);
      }
      // 本次确实拿到了**本侧**频道的数据 → 该侧恢复正常（成员后来开通小房间能自动恢复）
      roomSideUnavailable.delete(sideKey);
      // ★ 进房秒开缓存：成功拉到的首屏写**分侧**内存缓存，下次进同一侧先渲染它（见 roomMsgMemCache）
      if (!keepPrev && sorted.length) rememberRoomMessages(sideKey, sorted);
      /**
       * ★ homeowner 数据 = 服务端认定的房主发言：把消息键记入集合（见 ownerMsgKeysRef）。
       * 之后切群聊（all 接口）时，即使 id/昵称判定失败也能认出这批消息 → 7 天 idle 判定不再误报。
       */
      if (!wantFans) {
        // ★ 刷新**该侧**的「房主发言采样」（7 天 idle 判定的唯一权威数据源，见 ownerSampleBySide）。
        // ⚠️ 0 条也要记（sampled=true, count=0）：服务端确认"该侧没有房主发言"，
        //    与"从未采样"必须区分 —— 否则 0 条时会退回宽松判定而永不提示。
        let latestSample = 0;
        let newestOwner: any = null;
        for (const m of sorted) {
          ownerMsgKeysRef.current.add(messageKey(m));
          const ms = getMessageTime(m);
          if (ms > latestSample) latestSample = ms;
          if (!newestOwner || ms >= getMessageTime(newestOwner)) newestOwner = m;
        }
        /**
         * ★ 分侧「上次看到的位置」（用户 2026-11-13 一次性改好）：
         * 进房默认「只看偶像」→ `sorted` 就是 homeowner 页的房主消息，
         * 记下用户实际看到的最新**那一条的 id**（不是列表预览时间戳）。
         * 主计数层据此翻页到该 id 为止，同秒连发 / 缺时间字段 / 粉丝刷屏都不会漏。
         */
        if (newestOwner) markSeen(roomUnreadKey(String(room.id || ''), nextMode), newestOwner);
        setOwnerSampleBySide((prev) => ({ ...prev, [nextMode]: { sampled: true, count: sorted.length, latestMs: latestSample } }));
      } else if (wantFans) {
        /**
         * 群聊数据（all 接口）只有最新 50 条、可能一条房主发言都没有 →
         * 后台补一次 homeowner 只用于「房主发言采样」与消息键集合（不覆盖当前 roomMessages）。
         */
        void ensureOwnerSample(channelId, room, nextMode);
      }
      /**
       * 进房定位统一交给下方「进房定位 effect」处理（它同时负责：
       * 有未读 → 把「上次看到这里」分隔行贴到视口顶部；无未读 → 回到最新一条）。
       *
       * ⚠️ 这里原先有一段「恢复该房间上次滑动位置」的代码，但它是**死代码**：
       *   - 它写 `msgListRef.current.scrollToOffset(...)`，而 msgListRef **从未挂到任何列表上**
       *     （列表用的是 chatListRef）→ 永远不生效；
       *   - 记录位置的 `onMsgScroll` 也**从未传给 Chat 列表** → scrollPosCache 永远为空。
       * 两段死代码叠在一起，导致"进房后位置不对"长期无法定位。已删除。
       */
      setRoomLoadedOnce(true);
      setRoomMsgError('');
      roomMsgRetryRef.current = 0; // 成功即清零：下次进房/下次失败从 1s 重新退避
      logInfo(`[room] 进房 ${room.ownerName || channelId} ${nextMode} 消息加载耗时 ${Date.now() - roomOpenStart}ms (${sorted.length}条)`, 'room');
      if (!keepPrev) {
        const nextTime = getNextTime(res, list);
        setRoomNextTime(nextTime);
        setHasMoreMessages(nextTime > 0 && list.length > 0);
      }
      /**
       * 房间名 + 背景图 + 上麦扫描：已在进房**同步阶段**发起（见上方「进房并行化」），
       * 与消息请求并行、不再串行等消息返回 —— 这里不再重复请求。
       */
      /**
       * 进房分段耗时（用户 2026-11-12「进入房间的速度比较慢」）：
       * 「点击 → 首屏数据到 → 首帧渲染完成」三段分开打，真机 logcat（tag room）能直接看出
       * 慢在网络（消息 RTT）还是渲染（数据到了却迟迟出不了画面）。
       */
      const msgDoneMs = Date.now() - roomOpenStart;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (openSeq !== roomSeqRef.current) return;
          const nowMs = Date.now() - roomOpenStart;
          logInfo(
            `[room] 进房耗时 点击→首帧=${nowMs}ms（准备=${prepMs}ms 消息=${msgDoneMs}ms ${sorted.length}条 渲染=${nowMs - msgDoneMs}ms）`,
            'room',
          );
        });
      });
    } catch (error) {
      /**
       * Y22 竞态修复（补齐失败路径）：成功路径已有 `openSeq !== roomSeqRef.current` 守卫，
       * 但 catch 原先没有 —— 用户从 A 房间快速切到 B 房间、A 的请求失败时，
       * 会弹出 A 的「加载失败」提示并**清空 B 房间的消息列表**（串台 / 白屏）。
       * 期间已切房则整体放弃本次失败处理。
       */
      if (openSeq !== roomSeqRef.current) return;
      const msg = errorMessage(error);
      /**
       * ⚠️ 失败**不要**无条件清空消息（用户 2026-09-30：「房间也容易刷没消息」）。
       * `mode === 'internal'`（房间内切大/小房间、切「只看偶像/群聊」）时上面特意保留上一帧
       * 消息（避免闪转圈），但只要这一次请求失败，以前就会走到这里把整屏抹掉 ——
       * 现在 internal 模式保留旧消息（配合错误浮层 + 1s/3s/8s 自动重试恢复）。
       */
      if (mode !== 'internal') setRoomMessages([]);
      setRoomMsgError(msg);
      /**
       * 自动重试 1s → 3s → 8s（最多 3 次），走**静默刷新**而不是重进房间：
       * 不清空已渲染内容、不重放骨架。重试期间消息区显示「加载失败 + 重试」浮层
       *（roomMsgError 的消费者，见消息区 JSX），一旦拉成功会被 setRoomMsgError('') 清掉。
       * toast 只在第一次失败时弹一次，避免重试刷屏。
       */
      if (roomMsgRetryRef.current === 0) {
        showToast(t('加载失败：{msg}', { msg }));
      }
      const attempt = roomMsgRetryRef.current + 1;
      if (attempt <= 3) {
        roomMsgRetryRef.current = attempt;
        const delay = attempt === 1 ? 1000 : attempt === 2 ? 3000 : 8000;
        setTimeout(() => {
          if (openSeq !== roomSeqRef.current) return; // 已切房：放弃本轮重试
          refreshRoomMessagesRef.current?.();
        }, delay);
      }
    } finally {
      // 同理：旧请求的 setLoading(false) 会让新房间还在加载时就提前结束 loading，也要守卫
      if (openSeq === roomSeqRef.current) setLoading(false);
    }
  }, [currentUserId, roomMode, showFanMessages, showToast, t]);

  /**
   * 点封面（头像）/「直播中」角标 → **进房间并自动开播她的直播**。
   *
   * 用户 2026-09-30 明确：「房间列表有直播的主播，点头像直接进直播 ——
   * 注意，进的是**房间里的那个直播**，不要给我转到那个直播页面去」。
   *
   * 所以这里**不再 navigate 到 Media 页**（上一版是跳直播页，被否了），
   * 而是：进房间 + 置一个标记，进房后自动解析并开播 —— 走的是房间内同一条链路
   * （resolveLiveAndOpen → roomPlayer → 房间内的播放器），用户看到的始终是房间界面。
   */
  const openMemberLive = useCallback((member: Member) => {
    if (!member) return;
    /**
     * 场次 id 只能取「直播中」索引里的**真实 liveId**（byOwner 多键查找：userId / liveRoomId /
     * account / 去前缀小写昵称 —— 列表行常按昵称命中，所以必须走索引而不是成员库字段）。
     *
     * ⚠️【2026-11-01 修复 · 用户「朱丽娜点头像进直播间进不去」】
     * `member.liveRoomId` **不是 liveId，而是直播间（云信聊天室）号**，绝不能直接拿去播放：
     *   朱丽娜 member.liveRoomId = 9468252673，该场真实 liveId = 1323781527529394176；
     *   getLiveOne(9468252673) → status 10049「该成员直播已被删除」→ 解析失败 → 播放器打不开。
     *   对照：getLiveOne(真实 liveId) 返回 content.roomId = 9468252673（与成员库字段完全一致）。
     * 所以旧实现 `member.liveRoomId || entry.liveId` 的优先级是反的：凡是成员库里带这个字段的
     * 成员（少部分人有）点头像必然打不开；房间内直播卡 / 直播页带的是真 liveId，所以正常。
     * 现在只把它当「形如场次 id（15~20 位纯数字）」时的兜底，正常一律用索引里的 liveId；
     * 都拿不到 → 退化为普通进房（房间里的直播卡同样能看）。
     */
    const entry = liveEntryForMember(member, liveNowRef.current);
    const fallback = String((member as any)?.liveRoomId || '');
    const lid = String(entry?.liveId || '') || (/^\d{15,20}$/.test(fallback) ? fallback : '');
    if (!lid) {
      void openRoom(member, 'big', false, 'enter');
      return;
    }
    pendingAutoLiveRef.current = lid;
    void openRoom(member, 'big', false, 'enter');
  }, [openRoom]);

  /**
   * 消费「进房后自动开播」：进房后立即开播该场直播（走统一播放宿主）。
   * 依赖 selectedRoom：只在真正进了房间后跑一次。
   * 经 ref 调用 playMedia（其定义在本 effect 之后，直接引用会 TDZ）。
   */
  useEffect(() => {
    if (!selectedRoom) return;
    const lid = pendingAutoLiveRef.current;
    if (!lid) return;
    pendingAutoLiveRef.current = '';
    playMediaRef.current({
      type: 'live',
      url: '',
      title: String(selectedRoom.ownerName || ''),
      liveId: lid,
    } as RoomMedia);
  }, [selectedRoom]);

  /** 供声明顺序在前的发送逻辑调用（发送成功后立即刷新，不再等 15s 轮询） */
  const refreshRoomMessagesRef = useRef<(() => void) | null>(null);
  const loadMoreRoomMessages = useCallback(async () => {
    if (!selectedRoom || loading || loadingMoreMessages || loadingMoreMessagesRef.current || refreshingRef.current || !hasMoreMessages || !roomNextTime) return;
    const channelId = roomChannelId(selectedRoom, roomMode);
    if (!channelId) return;
    // 房间代次（只捕获、不递增 —— 递增代表「进了另一个房间」，那是 openRoom 的职责）。
    // 缺这道守卫时的真实故障：上拉加载更多（await 中）→ 切到另一个房间 →
    // 旧房间的历史被 mergeMessages 并进新房间（用户看到「B 房间里是 A 的消息」），
    // 且旧的 roomNextTime / hasMoreMessages 会覆盖新房间的分页状态。
    const openSeq = roomSeqRef.current;
    loadingMoreMessagesRef.current = true;
    setLoadingMoreMessages(true);
    try {
      const res = await pocketApi.getRoomMessages({
        channelId,
        serverId: selectedRoom.serverId,
        nextTime: roomNextTime,
        fetchAll: showFanMessages,
        fallbackChannelId: roomMode === 'small' ? selectedRoom.channelId : undefined,
      });
      if (openSeq !== roomSeqRef.current) return; // 已切换房间，丢弃慢响应
      /**
       * 串味拦截（同首屏）：小房间回退到大房间频道时返回的是大房间历史，
       * 合并进小房间列表就是「大小房间串了」。丢弃本页，也不推进分页游标。
       */
      if (!isDetailFromSide((res as any)?._request?.payload?.channelId, channelId)) {
        logWarn(`[room] 上拉：小房间详情回退到大房间（本侧=${channelId}），丢弃本页`, 'room');
        return;
      }
      const list = unwrapList(res, ['content.messageList', 'content.message', 'content.messages', 'content.list', 'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list']);
      const nextTime = getNextTime(res, list);
      setRoomMessages((prev) => {
        const merged = mergeMessages(prev, list as RoomMessage[]);
        diagnoseUndefined(merged, 'LOADMORE');
        return merged;
      });
      setRoomNextTime(nextTime);
      setHasMoreMessages(nextTime > 0 && list.length > 0);
    } catch (error) {
      if (openSeq !== roomSeqRef.current) return; // 旧房间的失败不该弹在新房间上
      showToast(t('继续加载失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      // 同样只在「仍是当前房间」时才清标志：旧房间的收尾不该解开新房间的上拉锁。
      // （切房时 openRoom 已复位过，所以这里不清也不会把标志卡死）
      if (openSeq === roomSeqRef.current) {
        loadingMoreMessagesRef.current = false;
        setLoadingMoreMessages(false);
      }
    }
  }, [hasMoreMessages, loading, loadingMoreMessages, roomMode, roomNextTime, selectedRoom, showFanMessages, showToast, t]);
  /**
   * 供「跨页未读」的进房定位调用（进房定位 effect 在其后声明）。
   * 用 ref 转发而不是把它写进 effect 依赖：loadMoreRoomMessages 每次渲染都是新引用，
   * 直接依赖会让定位 effect 被无关渲染反复打断。
   */
  const loadMoreRoomMessagesRef = useRef<(() => void) | null>(null);
  useEffect(() => { loadMoreRoomMessagesRef.current = loadMoreRoomMessages; }, [loadMoreRoomMessages]);

  // 房间内实时刷新：静默拉取最新消息并合并（不提示、不清空），供轮询调用
  const refreshRoomMessages = useCallback(async () => {
    if (!selectedRoom || refreshingRef.current) return;
    const channelId = roomChannelId(selectedRoom, roomMode);
    if (!channelId) return;
    // 房间代次守卫：这条是 15s 轮询走的路径，最容易命中「快速切房 + 慢响应」。
    // 没有它时，A 房间的轮询结果会把 A 的消息合并进 B 房间（用户反馈的「串台」）。
    const openSeq = roomSeqRef.current;
    refreshingRef.current = true;
    try {
      const res = await pocketApi.getRoomMessages({
        channelId,
        serverId: selectedRoom.serverId,
        nextTime: 0, // 实时刷新永远拉「最新页」，只用于把新消息合并进顶部
        fetchAll: showFanMessages,
        /**
         * ★ 静默刷新只要最新一页（用户 2026-10-01 性能优化）。
         * 以前不传 limit → 接口默认 100 条，每 15s 拉回整页再全量
         * sortMessagesNewestFirst + mergeMessages（含去重 Set 构造）——
         * 「15s 一次」的流量/解析/合并体量是现在（20 条）的 5 倍。
         * 首屏（openRoom）与上拉（loadMoreRoomMessages）仍用 100 条，保证历史完整。
         */
        limit: 20,
        fallbackChannelId: roomMode === 'small' ? selectedRoom.channelId : undefined,
      });
      if (openSeq !== roomSeqRef.current) return; // 已切换房间，丢弃慢响应
      /**
       * 串味拦截（同首屏/上拉）：小房间不可用时服务端会把大房间频道的数据返回过来。
       * 静默刷新每 5s 一次 → 不拦住就会把大房间消息不断并进小房间列表。
       * 日志按「房间#侧」节流（否则 5s 一条刷屏）。
       */
      if (!isDetailFromSide((res as any)?._request?.payload?.channelId, channelId)) {
        setRoomSideClosed(true);
        const logKey = `${String(selectedRoom.id || '')}#${roomMode}`;
        if (sideClosedLogRef.current !== logKey) {
          sideClosedLogRef.current = logKey;
          logWarn(`[room] 静默刷新：小房间详情回退到大房间（本侧=${channelId}），丢弃本批`, 'room');
        }
        return;
      }
      /**
       * 静默刷新**成功** = 消息链路已恢复 → 清掉「消息加载失败」浮层。
       * ⚠️ 以前 roomMsgError 只在「进房首屏成功」时清，轮询路径永不清：
       * 首屏失败一次（例如进房瞬间网络抖）后，即使 15s 后消息正常拉回来，
       * 那层浮层也会一直盖在消息区（absoluteFill）—— 看起来就是「遮罩」，
       * 而且会把整片触摸吃掉（用户 2026-09-30 反馈的「卡住」）。
       */
      setRoomMsgError('');
      const list = unwrapList(res, ['content.messageList', 'content.message', 'content.messages', 'content.list', 'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list']);
      if (!list || list.length === 0) return;
      const sorted = sortMessagesNewestFirst(list.filter(Boolean));
      // A 优化：无新消息时完全不触发 state 更新（零渲染开销轮询）。
      // 预判当前列表最新消息时间，若服务端最新条不比它新，直接 return，连 reducer 都不跑。
      const prevMsgs = roomMessagesRef.current;
      const prevNewest = prevMsgs.length ? getMessageTime(prevMsgs[0]) : 0;
      const hasFresh = sorted.some((m: any) => getMessageTime(m) > prevNewest);
      if (!hasFresh) return;
      // 关键：实时刷新【绝不改写 roomNextTime】—— roomNextTime 是「上拉加载更多」往前翻的游标，
      // 只能由 loadMoreRoomMessages 更新。否则会被反复重置成最新页游标，导致上拉加载更多拉回重叠/重复内容。
      setRoomMessages((prev) => {
        // 只合并比当前列表最新消息更新的条目，避免重复累积（双保险，配合 messageKey 去重）
        const newest = prev.length ? getMessageTime(prev[0]) : 0;
        const fresh = sorted.filter((m: any) => getMessageTime(m) >= newest || messageKey(m) === messageKey(prev[0]));
        if (!fresh.length) return prev;
        const merged = mergeMessages(prev, fresh);
        diagnoseUndefined(merged, 'REFRESH');
        return merged;
      });
      /**
       * 单侧「最后看过的消息时间」跟着推进（用户 2026-11-09）：
       * 房间开着时收到的消息算「已看过」，否则退出后 30s 轮询的精确计数
       * 会把它们重新算成未读（数字刚清完又冒出来）。
       */
      const newestAt = getMessageTime(sorted[0]);
      const seenKey = roomUnreadKey(String(selectedRoom.id || ''), roomMode);
      if (newestAt > 0 && seenKey) {
        useRoomUnreadStore.getState().applyUnread({ seenAt: { [seenKey]: newestAt } });
      }
    } catch {
      // 静默失败：实时刷新不打扰用户
    } finally {
      // 同上：只在仍是当前房间时解锁（切房时 openRoom 已复位）
      if (openSeq === roomSeqRef.current) refreshingRef.current = false;
    }
  }, [roomMode, selectedRoom, showFanMessages]);
  refreshRoomMessagesRef.current = refreshRoomMessages;


  /**
   * 深链 / 通知点击「进某个房间」（用户 2026-11-09）：`yayamsg://room/<memberId>`。
   * 由 store 里的 pendingRoomId 传递（导航层不直接依赖本页内部的 openRoom）。
   */
  useEffect(() => {
    if (!pendingRoomId || !members.length) return;
    if (String(selectedRoom?.id || '') === pendingRoomId) {
      useRoomPresenceStore.getState().consumePendingRoom();
      return;
    }
    const member = (members as any[]).find((m) => String(m?.id || '') === pendingRoomId);
    if (!member || !member.channelId) return;
    useRoomPresenceStore.getState().consumePendingRoom();
    openRoom(member as Member, 'big', false, 'enter');
  }, [pendingRoomId, members, selectedRoom, openRoom]);

  // 房间内实时刷新：打开房间后定时静默拉取最新消息（成员 + 粉丝）
  // B 优化：App 退到后台/锁屏时暂停轮询（避免后台空转耗电耗流量），回前台恢复。
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!selectedRoom) return;
    const startPoll = () => {
      if (pollTimerRef.current) return;
      /**
       * ★ 15s → 5s（用户 2026-11-09：「单个房间里消息更新得太慢」）。
       *
       * 这条 HTTP 轮询是**兜底**（实时走云信圈组 QChat 推送）；圈组没连上 / 被服务端限速 /
       * 弱网重连的那段时间里，房间消息就只靠它更新 —— 15s 一拍意味着「别人说完十几秒才冒出来」，
       * 加上进房定位/合并的耗时，体感就是「消息不刷新」。5s 与房间列表、通知轮询同一节奏。
       */
      pollTimerRef.current = setInterval(() => { refreshRoomMessages(); }, ROOM_MESSAGE_POLL_MS);
    };
    const stopPoll = () => {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    };
    /**
     * 后台**慢轮询兜底**（用户 2026-11-09 对齐桌面端：隐藏时 60s 一次）。
     * 以前后台是「完全停轮询」，回到前台第一眼看到的是离开时的旧消息，
     * 且 15s 的那一拍可能还要再等十几秒 —— 体感就是「回来半天不刷新」。
     */
    let bgTimer: ReturnType<typeof setInterval> | null = null;
    const startBgPoll = () => {
      if (bgTimer) return;
      bgTimer = setInterval(() => {
        if (AppState.currentState !== 'active') refreshRoomMessages();
      }, 60000);
    };
    const stopBgPoll = () => {
      if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
    };
    // 初始按当前前后台状态决定
    if (AppState.currentState === 'active') startPoll();
    else startBgPoll();
    // 前后台切换：前台启动、后台暂停。
    // ⚠️ 进系统 PiP 时 AppState 也报 background → 延迟确认豁免（PiP 事件随后才到），
    // 否则小窗里聊天/弹幕轮询被掐停，展开回 App 前消息全断（用户反馈「系统小窗中断直播」之一）。
    /**
     * ⚠️ 这个 600ms 的「停轮询」判定必须可取消、且与 effect 生命周期绑定：
     * 以前是裸 `setTimeout` 且共用 `pollTimerRef` —— 后台→前台 600ms 内切房的时序下，
     * 旧房间遗留的回调会把**新房间刚启动的 15s 轮询清掉**，表现为「新房间消息不再刷新」
     *（用户反馈的「加载不出消息」的其中一条路径）。回前台时也要主动取消未决的判定。
     */
    let bgCheckTimer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        if (bgCheckTimer) { clearTimeout(bgCheckTimer); bgCheckTimer = null; }
        stopBgPoll();
        startPoll();
      } else {
        if (bgCheckTimer) clearTimeout(bgCheckTimer);
        bgCheckTimer = setTimeout(() => {
          bgCheckTimer = null;
          if (!isPipActive()) { stopPoll(); startBgPoll(); }
        }, 600);
      }
    });
    return () => {
      sub.remove();
      if (bgCheckTimer) clearTimeout(bgCheckTimer);
      stopPoll();
      stopBgPoll();
    };
  }, [selectedRoom, refreshRoomMessages]);

  /**
   * 房间消息「实时」接收：云信圈组（QChat）推送。
   *
   * HTTP 轮询只是兜底；圈组才是真正的实时推送（官方同款通道）。
   * 原生桥不可用 / 未登录 / 非 Android 时 observeRoomMessages 内部静默降级，
   * 房间仍按轮询工作，不影响既有行为。
   */
  /** 「实时消息被 id 口径过滤掉」的诊断节流（tag room.rt） */
  const lastRtDropLogRef = useRef(0);
  useEffect(() => {
    if (!selectedRoom) return undefined;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    observeRoomMessages((messages) => {
      if (disposed) return;
      const coord = activeRoomRef.current;
      const cid = String(coord.channelId || activeChannelRef.current || '');
      if (!cid) return;
      /**
       * ★ 匹配口径必须放宽（用户 2026-11-09：「单个房间里消息更新得太慢」的可能真因之一）：
       * 圈组消息里的 `channelId` 与房间查询用的 `channelId` 是否同一个 id，官方没有文档
       *（房间列表就是拿 serverId 去查、返回体里却按 channelId 匹配）。只比 channelId 时，
       * 一旦两者不是同一个值 → **实时消息整批被丢掉** → 房间只剩 15s 轮询，
       * 表现为「别人说完十几秒才冒出来」。现在 channelId / serverId 任一命中即收，
       * 且两者都取自同一份 activeRoomRef，不会串房。
       */
      const ids = new Set([cid, String(coord.serverId || '')].filter(Boolean));
      const accepted = messages.filter((m) => (
        ids.has(String((m as any).channelId)) || ids.has(String((m as any).serverId))
      ));
      const fresh = accepted.map(qchatToRoomMessage);
      if (!fresh.length) {
        // 诊断（tag room.rt）：有推送却全被过滤 = id 口径不匹配，10s 最多打一条
        if (messages.length && Date.now() - lastRtDropLogRef.current > 10000) {
          lastRtDropLogRef.current = Date.now();
          const sample = messages
            .slice(0, 3)
            .map((m: any) => `${m.channelId}/${m.serverId}`)
            .join(',');
          logWarn(
            `[rt] 实时消息被过滤 ${messages.length} 条（本房间 channelId=${cid} serverId=${coord.serverId}；收到=${sample}）`,
            'room.rt',
          );
        }
        return;
      }
      setRoomMessages((prev) => {
        const merged = mergeMessages(prev, fresh);
        diagnoseUndefined(merged, 'QCHAT');
        return merged;
      });
    })
      .then((unsub) => {
        if (disposed) unsub();
        else unsubscribe = unsub;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (unsubscribe) unsubscribe();
    };
  }, [selectedRoom, nimEpoch]);


  /**
   * 房间内点媒体卡 → 交给统一播放宿主（用户 2026-10-02：四场景只调用同一个播放器）。
   *
   * 分派：
   *   · live（含带 liveId 的回放卡）→ kind 'live'/'replay'，由宿主解析并开播
   *     （解析中/失败重试的黑底占位也在宿主内，不再是本页的第二套 shell）；
   *   · video（房间视频消息，自带地址）→ kind 'direct'，直接播放；
   *   · audio（语音消息）→ 仍是气泡内联隐藏 Video（点击播放/再点停止的原交互不变）；
   *   · image/link → 展开大图 / 打开外链。
   */
  const playMedia = useCallback((media: RoomMedia) => {
    if (media.type === 'link') {
      const url = media.url || media.title;
      if (url) Linking.openURL(url).catch(() => showToast(t('这个链接无法直接打开。')));
      return;
    }
    // 语音消息：气泡内联播放（再次点击停止）
    if (playingMedia?.url && playingMedia.url === media.url) {
      setPlayingMedia(null);
      return;
    }
    /**
     * 「播什么」交给统一播放入口（`player/session/playEntry`）——
     * 与直播页 / 历史 / 稍后再看同一套构造，本页不再自己拼 PlayMedia。
     * 返回 null = 语音 / 图片：保持原有气泡内联播放 / 大图查看，不进大播放器。
     */
    const next = playMediaFromRoomMedia(media, {
      owner: String(selectedRoom?.ownerName || ''),
      team: String((selectedRoom as any)?.team || ''),
      ownerId: String(selectedRoom?.id || ''),
      memberId: String(selectedRoom?.id || ''),
    });
    if (next) setRoomPlaying(next);
    else setPlayingMedia(media);
  }, [playingMedia, selectedRoom, showToast, t]);
  /** playMedia 的 ref 镜像：声明在前的 effect（进房自动开播）经它调用，避免 TDZ */
  const playMediaRef = useRef(playMedia);
  playMediaRef.current = playMedia;

  /**
   * 房间内「直播回放」：点了某一场 → 交给统一播放宿主就地播放。
   *
   * kind='replay' 明示录播，解析器会按录播处理（拿该场的 playStreams、isLive=false）
   * → 可拖进度条、走 LRC 弹幕，不会把回放流误判成直播（判据见 roomTapIsVod）。
   */
  const playRoomReplay = useCallback((item: MemberReplayItem) => {
    setShowRoomReplay(false);
    // 构造交给统一播放入口：kind='replay' 明示录播（与历史/稍后再看里同一条回放链路）
    setRoomPlaying(playMediaFromRoomReplay(item, {
      owner: String(selectedRoom?.ownerName || ''),
      team: String((selectedRoom as any)?.team || ''),
      ownerId: String(selectedRoom?.id || ''),
      memberId: String(selectedRoom?.id || ''),
    }));
  }, [selectedRoom]);

  /** 小窗回大窗回跳参数：带上成员 id，回大窗落回她的房间（而不是直播 tab） */
  const miniPlayerBackTo = useMemo(
    () => ({ roomMemberId: String(selectedRoom?.id || '') }),
    [selectedRoom?.id],
  );

  /**
   * 房间工具栏「礼物」入口的可见性（用户 2026-11-02：房间内可直接送礼，大小房间都能用）。
   * 判据 = 有可送礼的直播场次：房间内正在播（roomPlaying.liveId）或「直播中」索引命中该成员。
   * 都没有就不显示 —— 送礼必须有 businessId（liveId），凭空展示只会点了报错。
   */
  const roomGiftAvailable = useMemo(
    () => !!(roomPlaying?.liveId || liveEntryForMember(selectedRoom, liveNow)?.liveId),
    [roomPlaying, selectedRoom, liveNow],
  );

  // 「…」面板里的礼物 / 贡献榜入口由统一播放宿主内置（MediaPlaybackHost 的 mergedActions），
  // 房间不再传 extraActions —— 与直播页同一份实现（用户 2026-11-13）。

  const downloadMedia = useCallback(async (media: RoomMedia) => {
    try {
      let next = media;
      if ((media.type === 'live' || media.liveId) && !media.url) {
        next = await resolveRoomLiveMedia(media);
      }
      const url = next.url || media.url;
      if (!url) {
        showToast(t('没有可下载地址'));
        return;
      }
      await enqueueDownload({
        url,
        type: next.type === 'live' ? 'replay' : next.type === 'audio' ? 'voice' : next.type === 'image' ? 'image' : next.type === 'video' ? 'video' : 'file',
        name: next.title,
      });
      showToast(t('已加入下载管理'));
    } catch (error) {
      showToast(t('下载失败：{msg}', { msg: errorMessage(error) }));
    }
  }, [showToast, t]);

  /**
   * 房间大图查看：点任意一张图 → 收集会话里最近的一批图片作为翻页序列。
   *
   * 口径（用户 2026-11-02，方向按用户第二轮要求调整）：
   *   · 序列按 **新 → 老** 排（下标递增 = 更早），所以**左滑看更早的图、右滑看更新的图**；
   *   · 只回溯 80 张（够用且点开瞬间完成，不会因为几百条消息的媒体解析卡住）；
   *   · 相邻重复（同一个表情贴纸连发）只留一张，避免一页页划同一张图。
   */
  const ROOM_IMAGE_GALLERY_LIMIT = 80;
  const openRoomImage = useCallback((url: string) => {
    const target = String(url || '');
    if (!target) return;
    const picked: string[] = [];
    /**
     * **全局去重**（不只去相邻）：查看器用 URL 作 React key，重复 URL 会撞 key →
     * 元素错位，表现就是「切到某张时自己跳到下一张、过一会又回来」（2026-11-02 反馈）。
     */
    const seen = new Set<string>();
    const items = filteredRoomMessagesRef.current || [];
    // 扫描上限：房间可能挂了几千条文本消息，媒体解析有成本 —— 只回溯 240 条（够滑很久）
    const scanFrom = Math.max(0, items.length - 240);
    for (let i = items.length - 1; i >= scanFrom && picked.length < ROOM_IMAGE_GALLERY_LIMIT; i -= 1) {
      const media = roomMedia(items[i]);
      if (!media || media.type !== 'image' || !media.url) continue;
      if (seen.has(media.url)) continue;
      seen.add(media.url);
      picked.push(media.url);
    }
    // 从最新往回扫，picked 天然是「新 → 老」，**不要再 reverse**（reverse 会让左滑变新）
    const list = picked.indexOf(target) >= 0 ? picked : picked.concat(target);
    setImageUrls(list);
    setFullImageUrl(target);
    logInfo(`[room] 大图 ${list.indexOf(target) + 1}/${list.length}（左滑更早 / 右滑更新）`, 'room');
  }, []);

  /**
   * 单侧未读**条数**——唯一定义处（房间行角标 / 上浮排序 / Rooms tab 共用）。
   *
   * ★ 2026-11-10 定版「只要一套数据源」：直接读 `roomUnreadCounts`，
   *   不再叠加服务端 `unreadCount - 已读地板` 的下限兜底（那是第二套数据源，
   *   真机实测该字段长期缺失，且官方客户端同步已读时会把数字抹成 0）。
   *   counts 本身已由三条计数通道按消息 id 去重累加完成。
   */
  const roomSideCountOf = useCallback(
    (id: string, side: RoomUnreadSide): number => roomUnreadCount(roomUnreadCounts, id, side),
    [roomUnreadCounts],
  );

  /**
   * 「这个房间是否有新消息」——**唯一定义处**：任一侧的累计条数 > 0。
   * 房间行角标、列表分组（新消息"临时置顶"）、Rooms tab 总数三处共用这一个来源，
   * 不再有「指纹/时间先亮『新』、几秒后计数到达再换数字」的两个时刻。
   */
  const roomHasUnread = useCallback(
    (item: any): boolean => {
      const id = String(item?.memberId || item?.member?.id || '');
      if (!id) return false;
      return ROOM_UNREAD_SIDES.some((side) => roomSideHasNew(roomSideCountOf(id, side)));
    },
    [roomSideCountOf],
  );

  /**
   * 一键已读（建议 10，用户 2026-09-30 选定）：把列表里所有房间的未读一次清掉。
   *
   * 基线取列表行当前的**服务器活动时间**（roomLastActivity）+ 两侧当前指纹，
   * 与「进房即已读」同一套口径 —— 绝不能塞 Date.now()（时间域铁律见 roomUnread.ts，
   * 设备时钟快几秒就会让之后的消息永远判不出未读）。
   * 计数在 store 里整体清空，所以这里不需要逐房间跑。
   */
  const markAllRoomsRead = useCallback(() => {
    const rows = (followedRef.current || []) as any[];
    const baselines: Record<string, number> = {};
    const tokens: Record<string, string> = {};
    for (const row of rows) {
      const id = String(row?.memberId || row?.member?.id || '');
      if (!id) continue;
      baselines[id] = roomLastActivity(row);
      for (const side of ROOM_UNREAD_SIDES) {
        const token = roomSideToken(row, side as RoomMode);
        const key = roomUnreadKey(id, side);
        if (token && key) tokens[key] = token;
        // ★ 一键已读没有具体消息 id 可记：把该侧时间基线推到列表活动时间（id 置空后主计数层走时间兜底）
        markSeenAll(key, baselines[id]);
      }
    }
    useRoomUnreadStore.getState().markAllRead(baselines, tokens);
    showToast(t('已全部标记为已读'));
  }, [showToast, t]);

  const filtered = useMemo(() => {
    // 用防抖后的值（searchDebounced）过滤：输入框即时回显，但不再每敲一个字符重跑全量过滤+排序
    const q = searchDebounced.trim().toLowerCase();
    let list = followed;
    if (q) {
      list = followed.filter((item) => {
        const member = item.member;
        if (!member) return false;
        return memberSearchText(member).includes(q);
      });
    }
    /**
     * 分组与排序交给纯函数 `sortRooms`（用户 2026-11-09）：
     *   rank 0 = 置顶 → 1 = 有新消息（room_list_unread_first 打开时）→ 2 = 其余；
     *   组内再按 自定义 / 按队伍 / 按字母 排。
     * 未读判据仍是组件级 `roomHasUnread`（唯一定义处）——分组与行角标共用它，避免判据漂移。
     *
     * ⚠️ rank **必须预计算一次**（用户 2026-09-30：「房间之间切换容易卡没房间列表」）：
     * 以前把 `roomHasUnread`（内部要跑 roomUnreadCount + roomSideHasNew×2 侧）
     * 塞进 sort 比较器，每次比较调 2 次 → O(N log N) 次查表；几百个关注房间时，
     * 退房回到列表这一下（同时还要重排 + 重渲染）就是最明显的卡顿点。
     * sortRooms 内部同样是「先预计算键、再纯数值比较」，不要改回回调式比较器。
     */
    return sortRooms(list, {
      hasUnread: roomHasUnread,
      pinnedIds: pinned,
      unreadFirst: roomUnreadFirst !== false,
      mode: (roomSortMode || 'custom') as RoomSortMode,
      customOrder: roomCustomOrder || [],
    });
  }, [
    followed,
    searchDebounced,
    pinned,
    roomUnreadCounts,
    roomHasUnread,
    roomUnreadFirst,
    roomSortMode,
    roomCustomOrder,
  ]);


  /**
   * 「这条消息算不算偶像/成员发言」的**统一判定**（用户 2026-10-02 误报修复）。
   *
   * 两层：
   *   ① messageRole === 'idol'（id 域匹配：房主 / 成员库成员）；
   *   ② **昵称兜底**：消息里的发送者 id 与成员库 id 不同域（云信 accid / 口袋 account /
   *      字段缺失）时按归一化昵称命中成员库 —— 否则房主/成员消息会被判成粉丝，
   *      表现就是「群聊里明明能看到偶像发言，却提示 7 天内偶像无消息」，
   *      以及「只看偶像」视图看不到这些消息。
   *
   * ⚠️ 用途：**只服务「只看偶像」视图的过滤**（视图要把房主 + 其他成员都显示出来）。
   * 7 天 idle 判定**不要**用这个宽松判定 —— 它会把其他成员的消息也算成偶像发言，
   * 导致提示永不出现（用户 2026-10-02）；判定只认「房主本人」，见 idolIdleNow。
   */
  const isIdolRowMessage = useCallback((item: any): boolean => {
    if (!selectedRoom) return false;
    const room = selectedRoom as Member;
    if (messageRole(item, room, false, selfIds, memberIdSet, selfNameKeys) === 'idol') return true;
    const prof = senderProfile(item, room);
    const key = normMemberName(prof?.name);
    if (key && memberNameKeys.has(key)) return true;
    // ③ 服务端认定的房主发言（homeowner 接口见过这条消息 → 键在集合里）→ 直接算偶像
    return ownerMsgKeysRef.current.has(messageKey(item));
  }, [selectedRoom, selfIds, selfNameKeys, memberIdSet, memberNameKeys]);

  // 搜索时从全量成员库匹配（未关注的成员可直接在此关注）
  const memberHits = useMemo(() => {
    // 同样用防抖值：成员库几百人，每击键 filter + sort 一次是纯浪费
    const q = searchDebounced.trim().toLowerCase();
    if (!q) return [];
    return members
      .filter((m) => memberSearchText(m).includes(q))
      .sort((a, b) => {
        // 已关注排前，方便快速打开房间
        const af = followedIds.has(String((a as any).id || (a as any).userId || '')) ? 0 : 1;
        const bf = followedIds.has(String((b as any).id || (b as any).userId || '')) ? 0 : 1;
        return af - bf;
      })
      .slice(0, 10);
    /**
     * ⚠️ 依赖必须是 `searchDebounced`（过滤真正用的值），不能写 `searchQuery`。
     * 历史 bug（用户 2026-10-10「打完全称反而搜不到」）：
     *   依赖挂在即时值上 → 每次击键用**上一次**的 debounced 重算一次，
     *   而 debounced 真正更新（防抖 200ms 后）时**依赖没变 → 不重算**。
     *   现象：单次整词上屏（或打字快于 200ms）时搜索框里明明是完整名字，
     *   结果却停在「空 / 上一次前缀」——打全称反而什么都搜不到。
     */
  }, [members, searchDebounced, followedIds]);

  /**
   * 搜索诊断（用户 2026-10-10「打完全称反而搜不到」）：
   * 搜索态且有关键词时打印一行，真机 logcat 里按 tag `rooms.search` 过滤即可确认
   * 「关键词 → 成员库命中数」的对应关系（release 包也打）。
   */
  useEffect(() => {
    if (!searchOpen) return;
    const q = searchDebounced.trim();
    if (!q) return;
    console.log(`[rooms.search] q=${q} 关注命中=${filtered.length} 成员库命中=${memberHits.length} 成员库总数=${members.length}`);
  }, [searchOpen, searchDebounced, filtered.length, memberHits.length, members.length]);

  const filteredRoomMessages = useMemo(() => {
    if (!selectedRoom) return roomMessages;
    // ① 关闭「所有人发言」时，粉丝消息必须从列表里剔除。
    //    —— 服务端 fetchAll 只影响「新拉的」数据，之前拉过的粉丝消息会留在本地：
    //    既会被显示出来，又会把同一位成员的连续发言「隔开」（用户反馈的老问题）。
    const base = showFanMessages
      ? roomMessages
      : roomMessages.filter((item) => messageRole(item, selectedRoom, false, selfIds, memberIdSet) !== 'fan' || isIdolRowMessage(item));
    // 用防抖后的查询（见 roomSearchDebounced 的说明），避免每敲一个字符全量过滤几百条消息
    const q = roomSearchDebounced.trim().toLowerCase();
    if (!q) return base;
    return base.filter((item) => {
      const profile = senderProfile(item, selectedRoom);
      const text = messageText(item);
      return [
        text,
        profile.name,
        profile.id,
        selectedRoom.ownerName,
        selectedRoom.team,
        selectedRoom.groupName,
      ].some((value) => String(value || '').toLowerCase().includes(q));
    });
  }, [roomMessages, roomSearchDebounced, selectedRoom, showFanMessages, selfIds, selfNameKeys, memberIdSet, isIdolRowMessage]);


  /**
   * 行对象缓存（messageKey → row 对象）：同一条消息**复用同一个 row 引用**。
   *
   * ⚠️ 这不是可选优化（用户 2026-09-30：「房间的性能还是很低，很容易卡住」）：
   * 下面的 `chatIms` 缓存是按 `cached.__row === row` 判定的，而这里以前每次都 push 全新对象
   * → 判定**永远不成立** → 每来一条新消息就为**全部**消息重建 IMessage 对象和 Map。
   * 房间消息几百条时，每条新消息都产生一次 O(N) 垃圾 + 库内整表重渲染。
   *
   * index 变化（前面插入新消息）时**原地更新** `row.index`，不重建对象 ——
   * 否则 index 一变又会让所有行失效，等于没缓存。
   */
  const chatRowCacheRef = useRef<Map<string, any>>(new Map());

  // 消息流按日期分组：今天/昨天/月日 分隔条（消息是新→旧排序，分隔条插在换日处）
  const chatRows = useMemo(() => {
    // 房间已切走/关闭时不能算：messageRole → isIdolMessage 会读 room.id（null 崩）
    if (!selectedRoom) return [];
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const fmt = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const now = new Date();
    const todayStr = fmt(now.getTime());
    const yestStr = fmt(now.getTime() - 86400000);
    const rows: { type: 'date' | 'msg'; key: string; label?: string; item?: any; index?: number; groupStart?: boolean }[] = [];
    let lastDay = '';
    filteredRoomMessages.filter(Boolean).forEach((item, index) => {
      const day = fmt(Number((item as any)?.msgTime || (item as any)?.ctime || 0) * (Number((item as any)?.msgTime) > 1e12 ? 1 : 1000));
      if (day !== lastDay) {
        lastDay = day;
        const label = day === todayStr ? t('今天') : day === yestStr ? t('昨天') : `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
        rows.push({ type: 'date', key: `d-${day}`, label });
      }
      // 用户要求（A）：**取消「同发送者 + 3 分钟」的时间叠加合并**——
      // 每条消息都独立成组：都带头像、名字（含队伍标签）和时间。
      // （此前 groupStart = !sameSender || !withinGap，会把连续发言并成一组只显一次身份。）
      const rowKey = messageKey(item);
      const cachedRow = chatRowCacheRef.current.get(rowKey);
      if (cachedRow && cachedRow.item === item) {
        cachedRow.index = index; // 原位更新下标，保持对象引用不变（下游 chatIms 缓存据此命中）
        rows.push(cachedRow);
      } else {
        const row = { type: 'msg' as const, key: rowKey, item, index, groupStart: true };
        chatRowCacheRef.current.set(rowKey, row);
        rows.push(row);
      }
    });
    // 缓存修剪：长时间挂房间 + 不断翻页时避免 Map 无界增长（重建成本可接受）
    if (chatRowCacheRef.current.size > 1500) chatRowCacheRef.current.clear();
    return rows;
  }, [filteredRoomMessages, selectedRoom, t]);

  /** 点开大图时要按「当前可见会话」收集图片，回调里读这份最新列表（避免把回调挂进依赖） */
  const filteredRoomMessagesRef = useRef<any[]>([]);
  filteredRoomMessagesRef.current = filteredRoomMessages;

  /**
   * 聊天库接线（A+B）：把 chatRows 映射成 IMessage，`__row` 带回原始行，
   * renderBubble 直接复用 renderChatItem —— 头像/名字/回复/礼物/媒体全保留。
   * ⚠️ user._id 必须按真实发送者（库按它决定左右），createdAt 必须毫秒。
   */
  /**
   * 文字可读性遮罩色（用户反馈：房间里「每条消息的时间」和「今天」这两个字容易看不清）。
   *
   * 房间背景是用户自定义图/视频帧（`<ImageBackground>` + roomScrim），纯文字直接压上去，
   * 遇到亮底/花底就糊掉。这里统一给这类**小字元信息**垫一层半透明底 + 提高字色对比：
   *   - 深色主题：半透明黑底 + 亮字
   *   - 浅色主题：半透明白底 + 深字
   * 与 roomScrim 同向（深色压暗、浅色提亮），不会出现「深色主题里垫白底」的割裂感。
   * 用两个字符串常量而不是对象：它们进 useCallback 依赖数组，对象每次渲染都是新引用，
   * 会让 renderDayLabel/renderChatItem 的 memo 完全失效。
   */
  const labelMaskBg = palette.name === 'dark' ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.78)';
  const labelMaskFg = palette.name === 'dark' ? 'rgba(255,255,255,0.88)' : 'rgba(60,60,67,0.92)';
  /**
   * 消息时间（HH:mm）专用遮罩：用户反馈浅色主题下 0.78 的白底偏重（「今天」日期分隔那种可以，
   * 时间这种每条消息都出现的小底更轻一些才不显脏）→ 浅色下降到 0.55；深色主题沿用同一套。
   */
  const timeMaskBg = palette.name === 'dark' ? labelMaskBg : 'rgba(255,255,255,0.55)';
  const timeMaskFg = palette.name === 'dark' ? labelMaskFg : 'rgba(60,60,67,0.82)';

  /**
   * 日期分隔：统一纯数字 yyyy/mm/dd（库自带的 zh 输出是「14 9月」这种不符合中文习惯的格式）
   */
  const renderDayLabel = useCallback(({ date, createdAt }: any) => {
    // ⚠️ 库回调传的是 createdAt（不是 date）——只读 date 会 undefined → NaN → null，
    // 于是「日期分隔根本不显示」（私信页同一个 bug）。
    const d = new Date(createdAt ?? date);
    if (Number.isNaN(d.getTime())) return null;
    const p2 = (n: number) => (n < 10 ? `0${n}` : String(n));
    const dayStr = `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
    const now = new Date();
    const todayStr = `${now.getFullYear()}/${p2(now.getMonth() + 1)}/${p2(now.getDate())}`;
    const yest = new Date(now.getTime() - 86400000);
    const yestStr = `${yest.getFullYear()}/${p2(yest.getMonth() + 1)}/${p2(yest.getDate())}`;
    const label =
      dayStr === todayStr ? '今天' : dayStr === yestStr ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`;
    // 用户要求：日期分隔**居中**显示（库的 Day 容器是居中的，但自定义 renderDay 会被塞进
    // 一个无 alignItems 的普通 View → 文字被拉伸满宽、默认左对齐）→ 靠 alignSelf 居中。
    // 加遮罩：房间底图是自定义图，纯文字压上去会糊（见 labelMaskBg/labelMaskFg）
    return (
      <Text style={[styles.daySepText, styles.labelMaskPill, { color: labelMaskFg, backgroundColor: labelMaskBg }]}>
        {label}
      </Text>
    );
  }, [palette, labelMaskBg, labelMaskFg]);

  /* 旧「椭圆玻璃气泡」renderBubble 与空壳 renderDay 已删除：
     聊天库现在整行走 renderMessage（见下方 <Chat renderMessage={chatRenderMessage}>），
     这两段只声明从未被引用（lib 的 renderBubble 路线已废弃 —— 会把发送者名字塞进气泡里）。 */

  /**
   * 行对象缓存 + 基线世代：新消息到达时**只重建变化的那几条**，其余沿用上一次的对象引用。
   *
   * 为什么要（用户反馈 2026-09-28：滑动消息时「没碰它也在跳」，且与新消息有关）：
   *   chatIms 每次刷新都会重建**全部** IMessage 对象 → 所有行的 props 引用都变
   *   → 长列表整表重渲染 + 逐行重新布局，滚动中就表现为可见的位置跳动。
   *   原始行引用没变（`__row` 相同）时复用旧对象，跳动来源立刻少一个。
   *
   * 基线世代（roomEntryBaseline）变化时（换房 / 重进房间）**整轮不复用**：
   * 「上次看到这里」标记会随之移动，若复用旧对象，标记会滞留在旧行上（且 memo 不会重渲染）。
   */
  const chatImCacheRef = useRef(new Map<string, any>());
  const chatImEpochRef = useRef<number | null>(null);
  const chatIms = useMemo(() => {
    if (!selectedRoom) return [];
    const sameEpoch = chatImEpochRef.current === roomEntryBaseline;
    chatImEpochRef.current = roomEntryBaseline;
    const cache = chatImCacheRef.current;
    const nextCache = new Map<string, any>();
    const ims = chatRows
      .filter((row: any) => row.type === 'msg' && row.item)
      .map((row: any) => {
        const item = row.item;
        const cacheKey = String(row.key);
        const cached = cache.get(cacheKey);
        if (sameEpoch && cached && cached.__row === row) {
          nextCache.set(cacheKey, cached);
          return cached;
        }
        const room = selectedRoom as Member;
        const role = messageRole(item, room, showFanMessages, selfIds, memberIdSet);
        const mine = role === 'mine';
        const sec = Number(item?.msgTime || item?.ctime || item?.timestamp || 0);
        const ms = sec > 1e12 ? sec : sec * 1000;
        const senderId = String(
          item?.user?.userId || item?.user?.id || item?.senderUserId || item?.senderId ||
          item?.fromUserId || item?.userId || senderProfile(item, room)?.id ||
          (mine ? currentUserId : 'peer'),
        );
        const prof = senderProfile(item, room);
        const built: any = {
          _id: String(row.key),
          // 带回原始行：renderMessage 整行渲染要用（groupStart 决定是否显示头像/名字）
          __row: row,
          text: messageText(item) || '',
          createdAt: new Date(ms),
          user: {
            // 固定常量 SELF：与 <Chat user={{_id:'SELF'}}> 严格相等，库才判成右侧
            _id: mine ? 'SELF' : senderId,
            ...(mine ? {} : { avatar: (prof as any)?.avatar || (room as any)?.avatar, name: (prof as any)?.name }),
          },
        };
        nextCache.set(cacheKey, built);
        return built;
      });
    chatImCacheRef.current = nextCache;
    /**
     * 「上次看到这里」分隔行：进房时快照的旧基线（roomEntryBaseline）之后的**第一条**消息。
     * 取「基线之后最早的一条」，加载更早历史（loadMore）后分隔行仍锚在同一条消息上。
     * 基线为 0（从未读过该房间）→ 不显示。
     */
    // 复用的对象上可能残留上一轮标记：先统一清掉再按当前基线重标（否则标记会同时留在两处）
    for (const im of ims) if ((im as any).__lastSeen) delete (im as any).__lastSeen;
    if (roomEntryBaseline > 0 && ims.length) {
      let first: (typeof ims)[number] | null = null;
      for (const im of ims) {
        const ms = (im.createdAt as Date).getTime();
        if (ms > roomEntryBaseline && (!first || ms < (first.createdAt as Date).getTime())) first = im;
      }
      if (first) (first as any).__lastSeen = true;
    }
    return ims;
  }, [chatRows, selectedRoom, showFanMessages, selfIds, selfNameKeys, memberIdSet, roomEntryBaseline]);

  /**
   * 进房定位（本屏唯一的定位入口，替换掉原先两段互相打架的滚动逻辑）：
   *
   *   ① 有未读 → 把「上次看到这里」分隔行贴到**视口顶部**，它下面的新消息自然都在眼前；
   *   ② 无未读（首次进房 / 已读完）→ 回到**最新一条**。
   *
   * ⚠️ 三个已修的关键点：
   *   1. `viewPosition` 必须是 **1 而不是 0**。本列表是 **inverted（倒置）** 的
   *      （@kesha-antonov/react-native-chat 的 Chat 默认 isInverted=true，库内注释也写明
   *      "An inverted list is flipped, so its content-container start is the visual bottom"）。
   *      倒置列表里 viewPosition:0 对齐的是**视觉底部** → 分隔行会落到屏幕下方，
   *      这正是用户反馈的「定位到之后位置偏低」。viewPosition:1 才是贴顶。
   *
   *   2. 加了**多轮重试**。scrollToIndex 在目标行高度尚未测出时会静默无效或抛错，
   *      原来只试一次且把异常吞掉 → 表现为「偶尔定位失效」。
   *
   *   3. 用 `chatIms.length` 作为"数据到位"的判据再标记已完成，避免数据未到时
   *      就把 done 标记置上导致本次进房再也不定位。
   *
   * ⚠️ 2026-10-03 稳定性修复（用户反馈「点进去定位到上次看到的地方不稳定」）：
   *
   *   4. **跨页未读**：未读超过一页时真正的分隔行还在更早的历史里，旧实现找不到
   *      就直接「回到最新」，整屏未读被一次踩过。现在识别这种情况 → 先停在已加载数据的
   *      最旧端，并自动补历史页（最多 3 页）继续找，找到后再精确贴顶。
   *
   *   5. **重试窗口 1.4s → ~3.4s**，且失败不再只做一次像素粗估：见 onScrollToIndexFailed 的
   *      「迭代逼近」（先推进到已测量的最远行，逼列表渲染中间行，再精确命中目标）。
   *
   *   6. **用户手动滚动即彻底取消**本次进房的自动定位（posUserScrolledRef）——
   *      否则后面几轮重试会把用户刚翻到的地方硬拽回去。
   */
  useEffect(() => {
    if (!selectedRoom) return;
    if (!chatIms.length) return; // 数据未到位：不启动，等列表有数据后本 effect 会再跑
    if (posUserScrolledRef.current) return; // 用户已手动滚动：本次进房不再自动定位

    const idx = chatIms.findIndex((im: any) => im.__lastSeen);
    /**
     * 定位目标解析走纯规则 `resolveLastSeenTarget`（回归锁：scripts/room-lastseen.test.mjs）：
     *   ① 有分隔行 → 分隔行贴顶；
     *   ② **跨页未读**（整页都晚于基线，真正的分隔行还在更早的历史页里）→ 已加载数据的最旧端，
     *      并由下面的 autoLoad 继续补历史页；
     *   ③ 无基线 / 全都看过 → 回最新。
     * ★ 分支 ② 是用户 2026-10-03 反馈的「不稳定」主因：未读超过一页时旧实现在这里
     *   直接退化成「回到最新」，把整屏未读一次性踩过去。
     */
    const oldestMs = chatIms.length
      ? (chatIms[chatIms.length - 1].createdAt as Date).getTime()
      : 0;
    const { mode, index: targetIndex } = resolveLastSeenTarget({
      baseline: roomEntryBaseline,
      dividerIndex: idx,
      loadedCount: chatIms.length,
      oldestMs,
    });

    const key = `${String(selectedRoom.id || '')}-${roomEntryBaseline}-${mode}-${targetIndex}`;
    if (posRunRef.current.key === key && !posRunRef.current.cancelled) return; // 本目标已启动过

    // 换房 / 重进 / 目标变化：作废上一轮（只在这里作废，绝不因 chatIms 变化而中断）
    if (posRunRef.current.timer) clearTimeout(posRunRef.current.timer);
    /**
     * 跨页未读：顺带把更早的历史页补进来（下一轮 chatIms 变化会带着新目标重跑本 effect，
     * 直到真正的分隔行进入已加载数据、被精确定位）。
     * autoLoadLeft 递减向下传递：不清零，否则每补一页都会重新触发 → 无限拉历史。
     */
    const canAutoLoad = mode === 'oldest' && hasMoreMessages && posRunRef.current.autoLoadLeft > 0;
    const autoLoadLeft = canAutoLoad ? posRunRef.current.autoLoadLeft - 1 : 0;
    if (canAutoLoad) loadMoreRoomMessagesRef.current?.();
    posRunRef.current = {
      key,
      cancelled: false,
      timer: null,
      target: targetIndex,
      advancedTo: -1,
      autoLoadLeft,
    };

    /**
     * 递增延时多试几轮：
     *   · 前几轮等首屏渲染完成；
     *   · 后几轮兜底「目标行高度未测出 → scrollToIndex 失败」的情况，
     *     配合 onScrollToIndexFailed 的「迭代逼近」逐步把目标行逼进渲染窗口。
     * 窗口由 1.4s 放宽到 ~3.4s：真机日志里首屏 50 条 + 图片解码常要 2s 以上，
     * 旧窗口在第 4 轮就放弃，正是「偶尔定位失效」的来源。
     *
     * ★ `latest`（无未读 → 回最新）只需要 2 轮（用户 2026-11-12 真机日志）：
     *   inverted 列表的「最新端」就是 offset 0，首屏数据一换列表本来就贴在这一端；
     *   旧实现照样跑满 8 轮（日志里进房后 9 秒内反复 scrollToOffset(0) + 每轮一条日志），
     *   纯属无谓的原生滚动调用与布局开销。保留 2 轮只为兜住「从上一个房间残留滚动位置」。
     */
    const delays = mode === 'latest'
      ? [0, 120]
      : [0, 120, 300, 600, 1000, 1600, 2400, 3400];
    const attempt = (n: number) => {
      const run = posRunRef.current;
      if (run.cancelled || run.key !== key || posUserScrolledRef.current || n >= delays.length) return;
      run.timer = setTimeout(() => {
        const cur = posRunRef.current;
        if (cur.cancelled || cur.key !== key || posUserScrolledRef.current) return;
        try {
          if (cur.target >= 0) {
            // inverted 列表：viewPosition 1 = 贴**视觉顶部**
            chatListRef.current?.scrollToIndex?.({ index: cur.target, viewPosition: 1, animated: false });
          } else {
            // 无未读：回到最新一条（inverted 列表 offset 0 = 最新所在端）
            chatListRef.current?.scrollToOffset?.({ offset: 0, animated: false });
          }
          try {
            logWarn(
              `[lastseen] 进房定位 ${mode} idx=${cur.target} 第${n + 1}轮 room=${String(selectedRoom.id || '')}`,
              'room',
            );
          } catch {}
        } catch (err) {
          try { logWarn(`[lastseen] 定位第${n + 1}轮抛错：${String((err as any)?.message || err)}`, 'room'); } catch {}
        }
        attempt(n + 1);
      }, delays[n]);
    };
    attempt(0);
    // ⚠️ 刻意不在 cleanup 里取消计时器：chatIms 每次新消息都会换引用，
    //    若在此取消，消息一到定位就被打断（这正是"进房不在顶端"的根因）。
    //    作废统一由 ①换房（上面的 key 变化）②卸载（下面的独立 effect）负责。
  }, [chatIms, selectedRoom, roomEntryBaseline, roomMode, showFanMessages, hasMoreMessages]);

  // 卸载时清理在途的定位计时器
  useEffect(() => () => {
    posRunRef.current.cancelled = true;
    if (posRunRef.current.timer) clearTimeout(posRunRef.current.timer);
  }, []);

  /**
   * ⚠️ 这里原先有一条「只看偶像但偶像 0 发言 → **自动展开全部（群聊）** + toast」的兜底
   *（2026-10-01 早先版本）。用户 2026-10-01 明确取消该行为：
   *
   *   偶像在窗口期（{IDOL_IDLE_WINDOW_DAYS} 天）内没有发言时，房间**只显示
   *   「{days} 天内偶像无消息」提示** —— 不自动切群聊、不把粉丝/另一侧消息顶上屏。
   *   「长期不发小房间消息的偶像房间」正是靠这条自动展开 + 上面的 keepPrev，
   *   最终被大房间的群聊内容整屏取代（真机复现：林舒晴小房间）。
   *
   * 群聊仍可**手动**切换（工具栏 account-group 按钮）：切过去正常显示全部消息，
   * 只在列表顶部保留一条「{days} 天内偶像无消息」提示（见下方 JSX）。
   */
  /**
   * 「{days} 天内偶像无消息」判定（用户 2026-10-01 口径；2026-10-02 三轮真机修复后的最终版）：
   *   · 大、小房间都适用，**分侧**判定；
   *   · 只看偶像视图命中 → 消息列表传空，只留居中提示；群聊视图命中 → 顶部提示条 3 秒；
   *   · 首屏未就绪 / 拉取失败 / 搜索态不判定。
   *
   * ★ 判定数据源 = 「只看偶像」视图的 homeowner 采样（服务端按房主过滤，唯一权威）。
   * ⚠️ 不要改成「当前数据 + 成员/昵称兜底」：那会把**其他成员**的消息也算成偶像发言，
   * 房间里只要有成员说话，提示就永不出现（用户 2026-10-02：「无论怎么样都不显示」）。
   * 「7 天内偶像无消息」问的是**房主本人**有没有发言。
   */
  const idolIdleNow = useMemo(() => {
    if (!selectedRoom || !roomLoadedOnce || loading) return false;
    // 本侧在服务端不可用（小房间关了）：没有自己的数据，不能断言「N 天内偶像无消息」，
    // 否则会和「小房间未开通」提示同时出现（用户 2026-11-12）
    if (roomSideClosed) return false;
    if (roomMsgError && roomMessages.length === 0) return false;
    if (roomSearchOpen && !!roomSearchQuery.trim()) return false;
    const nowMs = Date.now();
    const room = selectedRoom as Member;
    const sample = ownerSampleBySide[roomMode];
    if (sample.sampled) {
      // 房主窗口内有发言 → 不提示
      if (sample.latestMs > nowMs - IDOL_IDLE_WINDOW_MS) return false;
      /**
       * 采样是「进房那一刻」的快照：房间内可能刚有**房主实时发言**（云信推送）。
       * 用**严格房主判定**（isIdolMessage：房主 id / 房主昵称，不含其他成员兜底）扫一遍当前数据。
       */
      const hasFreshOwner = roomMessages.some((m) => (
        getMessageTime(m) > nowMs - IDOL_IDLE_WINDOW_MS && isIdolMessage(m, room, false)
      ));
      return !hasFreshOwner;
    }
    // 采样缺失（该侧还没请求过 homeowner）：退回严格房主判定
    return isIdolIdle(roomMessages, (m) => isIdolMessage(m, room, false), getMessageTime, nowMs);
  }, [selectedRoom, roomLoadedOnce, loading, roomMsgError, roomMessages, roomSearchOpen, roomSearchQuery, ownerSampleBySide, roomMode, roomSideClosed]);

  /**
   * 诊断（用户 2026-10-02「群里明明有偶像发言却提示 7 天无消息」）：
   * **判定条件变化时**打一条摘要（房间/视图/idle 结果 + 消息总数 + 判为偶像的条数 +
   * 其中窗口内的条数 + 时间不明的条数 + 偶像/列表的最新最早时间）。
   * 真机上一眼能看出是「身份判定失败」还是「时间取不到」——排查这类误报不必再猜。
   *
   * ⚠️ 依赖用 key（房间|侧|加载态|视图|idle 结果）而不是 roomMessages：
   * 后者每 15s 静默刷新/每条实时消息都会变 → 日志会被刷爆。
   */
  const idleDiagKey = `${String(selectedRoom?.id || '')}|${roomMode}|${roomLoadedOnce ? 1 : 0}|${showFanMessages ? 'f' : 'i'}|${idolIdleNow ? 1 : 0}`;
  useEffect(() => {
    if (!selectedRoom || !roomLoadedOnce || roomMessages.length === 0) return;
    const nowMs = Date.now();
    const cutoff = nowMs - IDOL_IDLE_WINDOW_MS;
    let idolCount = 0;
    let ownerCount = 0;
    let windowCount = 0;
    let unknownTime = 0;
    let latestIdolMs = 0;
    const diagRoom = selectedRoom as unknown as import('../types').Member;
    for (const m of roomMessages) {
      // 严格房主判定（idle 判定实际用的口径）与宽松偶像判定（视图过滤用的口径）分开统计
      if (isIdolMessage(m, diagRoom, false)) ownerCount += 1;
      if (!isIdolRowMessage(m)) continue;
      idolCount += 1;
      const ms = getMessageTime(m);
      if (ms > cutoff) windowCount += 1;
      if (ms <= 0) unknownTime += 1;
      if (ms > latestIdolMs) latestIdolMs = ms;
    }
    const fmt = (ms: number) => (ms > 0 ? new Date(ms).toISOString().slice(5, 16).replace('T', ' ') : '无时间');
    logInfo(
      `[idle] room=${String(selectedRoom.id)} mode=${roomMode} fans=${showFanMessages ? 1 : 0} idle=${idolIdleNow ? 1 : 0}`
      + ` 消息=${roomMessages.length} 宽松偶像=${idolCount} 严格房主=${ownerCount} 窗口内=${windowCount} 时间不明=${unknownTime}`
      + ` 偶像最新=${fmt(latestIdolMs)} 列表最新=${fmt(getMessageTime(roomMessages[0]))} 列表最早=${fmt(getMessageTime(roomMessages[roomMessages.length - 1]))}`
      + ` 采样大=${ownerSampleBySide.big.sampled ? ownerSampleBySide.big.count : '-'}@${fmt(ownerSampleBySide.big.latestMs)}`
      + ` 采样小=${ownerSampleBySide.small.sampled ? ownerSampleBySide.small.count : '-'}@${fmt(ownerSampleBySide.small.latestMs)}`,
      'room.idle',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idleDiagKey, roomLoadedOnce]);
  /** 只看偶像 + 命中 idle：列表传空数组（居中提示接管消息区），避免任何消息残留 */
  const displayIms = useMemo(
    () => (!showFanMessages && idolIdleNow ? EMPTY_CHAT_IMS : chatIms),
    [showFanMessages, idolIdleNow, chatIms],
  );
  /* ── 「有 N 条新消息」浮标 + 滚动中暂停自动贴底（用户 2026-11-09）─────────────
   *
   * 计数口径（对照桌面端 followed-chat-feature.queueFollowedPendingBatch）：
   *   **待看消息 = 没见过的新 id 集合**，与桌面 `followedPendingMessageIds.size` 一致。
   *
   * ⚠️ 上一版「每次按时间窗重算」会算错（用户 2026-11-09 反馈数量仍不对）：
   *    房间列表只保留最近 N 条，新消息把旧消息挤出列表后，重算的数字会**变小甚至归零**；
   *    而且服务端没给 msgTime 的消息会被时间过滤直接漏掉（数字偏少）。
   *    现在改成 **增量**：见过的 id 记进 seen（上限 3000），只有新出现的 id 才 +1；
   *    唯一的过滤是「上拉补历史」—— 那些 id 的时间早于离开底部时的锚点，忽略。
   */
  const [roomNewMsgCount, setRoomNewMsgCount] = useState(0);
  const chatAtBottomRef = useRef(true);
  /** 进过列表的消息 id（顺序表 + Set，超限丢最早一半） */
  const seenMsgOrderRef = useRef<string[]>([]);
  const seenMsgSetRef = useRef<Set<string>>(new Set());
  /** 待看（= 浮标数字）：只在翻在历史里时累计 */
  const pendingMsgIdsRef = useRef<Set<string>>(new Set());
  /** 离开底部那一刻的最新消息时间：用来识别「补历史页」 */
  const newMsgAnchorTimeRef = useRef(0);
  /**
   * 浮标计数数据源 = **房间全部消息**（与桌面端 yk1z/yaya_msg 同口径：浮标语义是
   * 「没看到的行数」，不是「当前过滤视图里的行数」；只看偶像视图下群聊新消息也算。
   * ⚠️ 与房间列表角标口径不同（角标只计偶像发言），不要混改。
   */
  const pillSource = roomMessages;
  const pillSourceRef = useRef<any[]>(pillSource);
  pillSourceRef.current = pillSource;
  /** 原始消息 → 计数用纯数据（id/时间/自己/聊天类），规则见 ./room/newMessagePill.ts */
  const newMsgItemsOf = useCallback((list: any[]): NewMsgItem[] => (
    (list || []).map((item: any) => {
      const sec = Number(item?.msgTime || item?.ctime || item?.timestamp || 0);
      return {
        id: messageKey(item),
        time: sec > 1e12 ? sec : sec * 1000,
        // 自己发的消息：只记「见过」、不计入数字（判定与气泡同侧口径一致，见 messageRole）
        self: !!selectedRoom
          && messageRole(item, selectedRoom as Member, showFanMessages, selfIds, memberIdSet) === 'mine',
        // 礼物 / 进房特效 / 系统公告不算「消息」（与房间列表角标同口径）
        countable: isCountableRoomMessage(
          String(item?.msgType || (messageBody(item) as any)?.messageType || ''),
        ),
      };
    })
  ), [selectedRoom, showFanMessages, selfIds, memberIdSet]);
  /** 清零（reason 会进日志：真机上能看出「是谁把数字清掉的」） */
  const clearNewMsg = useCallback((reason: string) => {
    const had = pendingMsgIdsRef.current.size;
    pendingMsgIdsRef.current.clear();
    newMsgAnchorTimeRef.current = 0;
    setRoomNewMsgCount((n) => (n ? 0 : n));
    if (had) logInfo(`[pill] 清零 ${had} → 0（${reason}）`, 'room.pill');
  }, []);
  /** 列表滚动：库会把消费方的 onScroll 一并调用（MessagesContainer notifyConsumerScroll） */
  const handleChatListScroll = useCallback((event: any) => {
    /**
     * ⚠️ 必须走 scrollOffsetY：库的这个 onScroll 来自 Reanimated 的 worklet 事件（**扁平**的
     * `contentOffset`，经 runOnJS 转给我们时也没有 `nativeEvent`）。
     * 上一版只读 `event.nativeEvent.contentOffset.y` → y 恒为 0 → 永远判成「贴着最新消息」
     * → 新消息一律被当成已看过，浮标数字怎么都不对（用户 2026-11-09 反馈）。
     */
    const y = scrollOffsetY(event);
    /**
     * inverted 列表：offset 0 = 最新消息那一端。
     *
     * ★ 滞回（用户 2026-11-09 真机日志）：y 会在 48~60 之间**自己来回抖**
     *（MVCP 内容补偿 + 行高重测），同一个阈值来回翻 → 每次翻回「贴底」都 clearNewMsg，
     * 数字刚涨就被清掉，看起来就是「怎么都不对」。
     * 现在：离开贴底用 48dp，回到贴底要 ≤ 12dp（真的回到最新端）才认。
     */
    const wasBottom = chatAtBottomRef.current;
    const atBottom = wasBottom ? y <= CHAT_STICK_BOTTOM_DP : y <= CHAT_RETURN_BOTTOM_DP;
    if (wasBottom === atBottom) return;
    chatAtBottomRef.current = atBottom;
    logInfo(`[pill] ${atBottom ? '回到贴底' : '翻到历史'} y=${Math.round(y)}`, 'room.pill');
    if (atBottom) { clearNewMsg(`回到底部 y=${Math.round(y)}`); return; }
    let newest = 0;
    for (const item of pillSourceRef.current || []) {
      const sec = Number((item as any)?.msgTime || (item as any)?.ctime || (item as any)?.timestamp || 0);
      const ms = sec > 1e12 ? sec : sec * 1000;
      if (ms > newest) newest = ms;
    }
    newMsgAnchorTimeRef.current = newest;
  }, [clearNewMsg]);
  /** 新消息到达：**增量**收集（见上面注释，不能每次都按时间窗重算） */
  useEffect(() => {
    const items = newMsgItemsOf(pillSource);
    const fresh = pickNewMessages(items, seenMsgSetRef.current, newMsgAnchorTimeRef.current);
    if (!fresh.seen.length) return;
    // 全部记入「见过」：之后即使被列表挤出、再被补历史拉回来，也不会重复计数
    const nextOrder = pushSeenIds(seenMsgOrderRef.current, fresh.seen);
    seenMsgOrderRef.current = nextOrder;
    seenMsgSetRef.current = new Set(nextOrder);
    // 诊断（tag room.pill）：新消息被识别到了多少、当时是否贴底
    logInfo(
      `[pill] 新增 seen=${fresh.seen.length} counted=${fresh.counted.length}`
      + ` 贴底=${chatAtBottomRef.current ? 1 : 0} 已有=${pendingMsgIdsRef.current.size}`,
      'room.pill',
    );
    if (chatAtBottomRef.current) {
      clearNewMsg('贴底时来了新消息');
      return;
    }
    // 只有「该计数的」才进待看集合：自己发的 / 礼物进房公告都不加数字
    for (const id of fresh.counted) pendingMsgIdsRef.current.add(id);
    const count = pendingMsgIdsRef.current.size;
    setRoomNewMsgCount((prev) => (prev === count ? prev : count));
  }, [pillSource, newMsgItemsOf, clearNewMsg]);
  /** 诊断（tag room.pill）：数字变化时打一行，真机上看得出「为什么涨 / 为什么不涨」 */
  useEffect(() => {
    logInfo(
      `[pill] 新消息=${roomNewMsgCount} 贴底=${chatAtBottomRef.current ? 1 : 0}`
      + ` 锚点=${newMsgAnchorTimeRef.current || 0} seen=${seenMsgSetRef.current.size}`,
      'room.pill',
    );
  }, [roomNewMsgCount]);
  /** 换房间 / 切大·小房间 / 切群聊视图：浮标与锚点一起作废（seen 保留，消息 id 全局唯一） */
  useEffect(() => {
    clearNewMsg('切房/切视图');
    chatAtBottomRef.current = true;
  }, [selectedRoom?.id, roomMode, showFanMessages, clearNewMsg]);
  /** 点浮标：回到底部（offset 0 即最新端）并清零 */
  const jumpToNewestMessages = useCallback(() => {
    clearNewMsg('点浮标回底');
    chatAtBottomRef.current = true;
    chatListRef.current?.scrollToOffset?.({ offset: 0, animated: true });
  }, [clearNewMsg]);
  /**
   * 群聊视图顶部提示条：**显示 3 秒后自动消失**（用户 2026-10-01）。
   *
   * 计时口径：
   *   · 「切到群聊」或「切大/小房间」（epoch 变化）→ 重新计时显示 3 秒；
   *   · idle 条件持续成立期间不重复弹（idolIdleNow 值不变 → effect 不重跑）；
   *   · 偶像一发新消息（idle 变 false）→ 立即隐藏（effect 走 else 分支）。
   */
  const [idleBannerVisible, setIdleBannerVisible] = useState(false);
  const idleBannerEpoch = `${roomSideKey(String(selectedRoom?.id || ''), roomMode)}|${showFanMessages ? 'fans' : 'idol'}`;
  useEffect(() => {
    if (!showFanMessages || !idolIdleNow) {
      setIdleBannerVisible(false);
      return undefined;
    }
    setIdleBannerVisible(true);
    const timer = setTimeout(() => setIdleBannerVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [showFanMessages, idolIdleNow, idleBannerEpoch]);

  /**
   * 房间内「上麦」直接收听（用户要求：不跳转，当前页直接播放）。
   * 秒开：上麦扫描已拿到 streamUrl 就直接播；否则现取一次。
   * 复用房间内联播放器（roomPlayer → PlayerScreen）。
   */
  const playRoomRadioInline = useCallback(async () => {
    const room = selectedRoom;
    if (!room) return;
    const key = String((room as any).id || (room as any).userId || '');
    const entry: any = onMicMap[key];
    const mode: 'big' | 'small' = entry?.smallVoice ? 'small' : 'big';
    let url = String(entry?.streamUrl || '');
    if (!url) {
      try { url = (await fetchMemberRadioUrl(room as Member, mode)) || ''; } catch { url = ''; }
    }
    if (!url) { showToast(t('该房间当前没有开启语音电台')); return; }
    // 用户要求：点「上麦」按钮**直接以小胶囊（纯音频）播放**，
    // 不要走房间内联那个「直播播放器」（视频播放器样式，观感不对）。
    const memberName = shortName(room, key);
    const title = `${memberName} · ${t('上麦')}`;
    useMiniPlayerStore.getState().open({
      url,
      title,
      cover: (room as any).avatar,
      isLive: true,
      audioOnly: true,
      // 成员名/队伍/成员 id：胶囊点开回大窗时右上角成员胶囊要用（用户 2026-11-08）
      backTo: {
        mode: 'live',
        playUrl: url,
        playTitle: title,
        playCover: (room as any).avatar,
        playOwner: memberName,
        playTeam: (room as any).team || '',
        playOwnerId: String((room as any).id || ''),
      },
    });
  }, [selectedRoom, onMicMap, showToast, t]);

  /**
   * 房间内点消息头像 → 弹「用户资料卡」（用户要求：成员/非成员**都用这一个界面**，不再跳成员档案）。
   *  - 资料源：`user/api/v1/user/info/home`（桌面端同款写法，Android 头 + userId 数字）
   *  - 成员先用成员库信息立即渲染（队伍/名字），线上资料回来后再补等级/签名等
   */
  const openSenderProfile = useCallback(
    (opts: { id: string; name: string; avatar: string; member?: Member | null; userIds?: string[] }) => {
      const m = opts.member || null;
      // 候选 id：**消息 ext.user.userId 优先**（官方 getChannelBaseParams / 我们自己 buildChannelExt 都写的是发送者的口袋 userId），
      // 再退成员库的 userId / id，最后退消息里取到的发送者字段（可能是云信 accid，查不到就会自动换下一个）。
      const candidates = Array.from(
        new Set(
          [...(opts.userIds || []), m ? String((m as any).userId || '') : '', m?.id, opts.id]
            .map((v) => String(v ?? '').trim())
            .filter((v) => /^\d+$/.test(v) && v !== '0'),
        ),
      );
      const cardId = candidates[0] || String(opts.id || '').trim();
      const seq = ++userCardSeqRef.current;
      const apply = (patch: any) =>
        setUserCard((c) => (c && userCardSeqRef.current === seq ? { ...c, ...patch } : c));
      setUserCard({
        id: cardId,
        name: opts.name || m?.ownerName || '',
        avatar: opts.avatar || (m as any)?.avatar || '',
        loading: candidates.length > 0,
        error: '',
        following: false,
        mutual: false,
        followBusy: false,
        isMember: !!m,
        member: m || null,
        detail: {
          name: '',
          avatar: '',
          level: '',
          signature: '',
          team: m ? String((m as any).groupName || (m as any).team || '') : '',
          period: '',
          isStar: !!m,
        },
      });
      if (!candidates.length) {
        apply({ loading: false, error: t('该用户没有可加载的口袋48资料') });
        return;
      }
      // 依次尝试候选 id：命中第一个能查到资料的即用（查不到再换下一个）
      void (async () => {
        for (const id of candidates) {
          try {
            const res = await pocketApi.getUserProfile(id);
            if (userCardSeqRef.current !== seq) return;
            const detail = userCardFromUserRes(res);
            // 合并而非覆盖：成员先用成员库填了队伍/成员标记，线上资料只补能拿到的字段
            setUserCard((c) =>
              c && userCardSeqRef.current === seq
                ? { ...c, id, loading: false, error: '', following: detail.following, mutual: detail.mutual, detail: { ...c.detail, ...detail } }
                : c,
            );
            return;
          } catch {
            // 该 id 查不到（如非口袋 userId）→ 试下一个
          }
        }
        if (userCardSeqRef.current !== seq) return;
        apply({ loading: false, error: t('未获取到更多资料') });
      })();
    },
    [t],
  );

  /** 资料卡「关注 / 取消关注」：口袋48 用户间可互关（v2/friendships/friends/add|remove，toType=1） */
  const toggleFollowUser = useCallback(
    async (card: { id: string; following: boolean }) => {
      const id = String(card?.id || '').trim();
      if (!/^\d+$/.test(id)) {
        showToast(t('该用户不支持关注'));
        return;
      }
      const next = !card.following;
      setUserCard((c) => (c && c.id === id ? { ...c, followBusy: true } : c));
      try {
        if (next) await pocketApi.followMember(id);
        else await pocketApi.unfollowMember(id);
        setUserCard((c) => (c && c.id === id ? { ...c, following: next, mutual: next ? c.mutual : false, followBusy: false } : c));
        showToast(next ? t('已关注') : t('已取消关注'));
      } catch (err) {
        setUserCard((c) => (c && c.id === id ? { ...c, followBusy: false } : c));
        showToast(t('操作失败：{msg}', { msg: errorMessage(err) }));
      }
    },
    [showToast, t],
  );

  /** 资料卡「私信」：带 targetUserId 进私信页（对方不是成员 → 无翻牌，纯私信会话） */
  const openUserPrivateMessage = useCallback(
    (card: { id: string; name: string }) => {
      const id = String(card?.id || '').trim();
      if (!id) return;
      setUserCard(null);
      navigation.navigate('PrivateMessagesScreen', { targetUserId: id, targetName: card.name || '' });
    },
    [navigation],
  );

  // 注：「跳成员档案页」的入口已按用户要求删除（2026-10-02）——
  // 档案内容直接内嵌在资料卡里（见 MemberArchiveContent），不再需要跳转到 ProfileScreen。

  /**
   * 房间卡片长按 → 快捷操作菜单（对齐桌面 followed-rooms-feature.executeQuickAction）。
   * ⚠️ 用自研 Modal 而不是 Alert：**Android 的 Alert 只渲染前 3 个按钮**，
   * 放不下「大/小房间 + 置顶 + 上移下移 + 关注 + 未读提醒」这么多操作。
   */

  // 列表项渲染提取为 useCallback：避免每次 render 重建内联函数，配合 PerfFlatList 的 memo 提升长列表滚动性能
  /** 长按自己的消息 → 撤回删除（官方 im/api/v1/team/msg/delete，服务端校验只能删本人的） */
  const confirmDeleteMessage = useCallback(
    (item: any) => {
      const msgIdClient = String(item?.msgIdClient || item?.uuid || item?.msgId || '');
      const msgTime = getMessageTime(item);
      const channelId = Number(item?.channelId || activeChannelRef.current || 0);
      if (!msgIdClient || !msgTime || !channelId) {
        showToast(t('该消息不支持撤回'));
        return;
      }
      Alert.alert(t('删除消息'), t('撤回并删除这条你发送的消息？'), [
        { text: t('取消'), style: 'cancel' },
        {
          text: t('删除'),
          style: 'destructive',
          onPress: () => {
            deleteRoomMessage({ channelId, msgIdClient, msgTime })
              .then(() => {
                setRoomMessages((prev) => prev.filter((m) => messageKey(m) !== messageKey(item)));
                showToast(t('已删除'));
              })
              .catch((err) => showToast(errorMessage(err)));
          },
        },
      ]);
    },
    [currentUserId],
  );

  /**
   * 消息行渲染：真正的 UI 已抽成模块级 `RoomChatMessageRow`（React.memo）。
   * 这里只负责把「当前渲染上下文」拼成 props。
   *
   * ⚠️ 两个纪律（否则 memo 白做）：
   *   ① props 只放「值」或「稳定引用」—— 所以传 playingUrl / roomPlayerUrl 两个字符串，
   *      而不是 playingMedia / roomPlayer 对象（对象每次渲染都是新引用，memo 必失效）；
   *   ② 这个打包对象必须 useMemo 稳定：它一变，整屏消息都会重渲染。
   */
  const chatRowProps = useMemo(
    () => ({
      room: selectedRoom as Member,
      showFanMessages,
      selfIds,
      selfNameKeys,
      selfAvatar,
      memberIdSet,
      memberIndex,
      playingUrl: playingMedia?.url || '',
      roomPlayerUrl: roomPlaying?.url || '',
      timeMaskFg,
      timeMaskBg,
      onOpenSenderProfile: openSenderProfile,
      onDeleteMessage: confirmDeleteMessage,
      onReplyMessage: startReply,
      onPlayMedia: playMedia,
      onDownloadMedia: downloadMedia,
      onOpenImage: openRoomImage,
    }),
    [
      selectedRoom,
      showFanMessages,
      selfIds,
      selfNameKeys,
      selfAvatar,
      memberIdSet,
      memberIndex,
      playingMedia?.url,
      roomPlaying?.url,
      timeMaskFg,
      timeMaskBg,
      openSenderProfile,
      confirmDeleteMessage,
      startReply,
      playMedia,
      downloadMedia,
      openRoomImage,
    ],
  );

  const renderChatItem = useCallback(
    ({ item: row }: { item: any }) => (
      <RoomChatMessageRow item={row.item} groupStart={!!row.groupStart} {...chatRowProps} />
    ),
    [chatRowProps],
  );

  /**
   * ★ `<Chat>` 的稳定 props（用户 2026-10-01 性能优化）。
   *
   * 背景：这些 prop 以前全是**内联对象 / 内联箭头**（`theme={{...}}`、`onSend={() => {}}`、
   * `loadEarlierMessagesProps={{...}}`、`listProps={{...}}`…）—— 引用每次渲染都变。
   * 房间内打字（roomDraft 每击键）、搜索、键盘高度、播放器状态、在线人数（30s）
   * 任一变化 → 整个消息列表组件的 props 全变 → 库内部 props 比较必然不等 →
   * 可见的几十行消息全部重渲染（`RoomChatMessageRow` 的 memo 白做）。
   *
   * 规则：凡是对象/数组/函数 prop 一律提成模块常量或 useMemo/useCallback，
   * 只让**真正影响它的值**进 deps。改这里时不要再把 `{{ }}` / `() => {}` 写回 JSX。
   */
  const chatRenderMessage = useCallback(
    ({ currentMessage }: any) => {
      const row = (currentMessage as any)?.__row;
      // 库要求必须返回元素（null 不合法）
      if (!row) return <View />;
      const im = currentMessage as any;
      // 「上次看到这里」分隔行：锚在该条消息上方（chatIms 标记 __lastSeen）
      if (!im.__lastSeen) return renderChatItem({ item: row });
      return (
        <View>
          <View style={{ alignItems: 'center', marginVertical: 6 }}>
            <Text style={[styles.daySepText, styles.labelMaskPill, { color: labelMaskFg, backgroundColor: labelMaskBg }]}>
              {t('上次看到这里')}
            </Text>
          </View>
          {renderChatItem({ item: row })}
        </View>
      );
    },
    [renderChatItem, labelMaskFg, labelMaskBg, t],
  );
  /** 「回到底部」圆钮内容：只跟品牌色变化 */
  const chatScrollToBottomComponent = useCallback(
    () => <MaterialCommunityIcons name="chevron-double-down" size={18} color={palette.onTint} />,
    [palette.onTint],
  );
  const chatScrollToBottomContentStyle = useMemo(
    () => ({ backgroundColor: palette.tint }),
    [palette.tint],
  );
  /** 上拉加载更多按钮：只跟「有没有更多/是否在加载」变 */
  const chatLoadEarlierProps = useMemo(
    () => ({
      isAvailable: hasMoreMessages,
      onPress: loadMoreRoomMessages,
      isLoading: loading,
      /**
       * ⚠️ 上划到顶自动加载（用户反馈：到顶只出现按钮、还要再点一下，太别扭）。
       * 库的 FlatList 已挂 onEndReached（threshold 0.1），inverted 列表的数据末端
       * 正好是视觉顶部（最旧消息）—— 打开这个开关后，上划接近顶部就会自动调
       * onPress（即 loadMoreRoomMessages），按钮保留作为兜底。
       * 防重入/去重由 loadMoreRoomMessages 自己的护栏保证，可安全重复触发。
       */
      isInfiniteScrollEnabled: true,
    }),
    [hasMoreMessages, loadMoreRoomMessages, loading],
  );
  /**
   * 列表底层参数 —— ⚠️ 本列表实际跑在 **FlatList**（库的 AnimatedFlatList 分支）上，不是 FlashList：
   * 聊天库 `MessagesContainer` 的 `isFlashListEnabled` **默认 false**，项目没有传这个 prop
   *（`isFlashList = isFlashListEnabled && isFlashListAvailable`）→ 走 FlatList。
   * 所以这里**只放 FlatList 认识的 props**（`estimatedItemSize: 96` 那类 FlashList 专有项已删）。
   *（库的 FlatList 分支本身没有自动吸底逻辑，见下面 maintainVisibleContentPosition 一节。）
   */
   const chatListProps = useMemo(
    () => ({
      /**
       * ★ 保持阅读位置（用户 2026-10-09：「房间内有新消息之后，我正在看前面的消息，消息不停往上窜」）。
       *
       * 根因：本列表是 **inverted（倒置）FlatList**。新消息插在数据 index 0（视觉最底部那条），
       * 在倒置列表的内容坐标里就是插在**内容起点** → 它之后的所有行坐标整体 +h，
       * 而滚动 offset 不会自己跟着变 → 视口内容整体**上移 h**。来一条推一下，
       * 正在读的历史就被一条条顶走（同一现象在 15s 静默刷新合并进来多条时更明显）。
       *
       * 为什么以前一直没有：库 FlatList 分支的自动吸底只在 `!isInverted` 时生效
       *（`MessagesContainer` 里 `if (isInverted) return`），倒置列表“本来就贴底”这个假设
       * 只在你**没往上翻**时成立；一旦翻上去，锚点就没人管了。
       *
       * 修法：交给 RN 原生的 `maintainVisibleContentPosition`（Android 端
       * `ReactScrollView` + `MaintainVisibleScrollPositionHelper`，在挂载事务里
       * 原子地按锚点子 View 的 frame 差值补偿 offset，不是先跳再拉回来，无闪动）：
       *   · `minIndexForVisible: 0` —— 锚点从数据第 0 条（最新那条）开始找。
       *     注意库会把 ListHeaderComponent（倒置时是打字指示器，落在视觉底部）算进来，
       *     真正下发原生的是 `minIndexForVisible + 1`，正好跳过它从第一条消息找起；
       *   · `autoscrollToTopThreshold: 48` —— offset ≤ 48（即「还贴着最新消息」）时不做保持、
       *     直接平滑回到 offset 0（最新端）。语义与下面 `scrollToBottomOffset={48}` 一致，
       *     否则贴底时新消息会被挡在屏幕外、底部露白。
       *     ⚠️ 这个值必须与 `scrollToBottomOffset` 保持一致，改一个要同步另一个。
       *
       * ★ 2026-10-09 真机对照实验（同场景：进房 → 翻到历史 → 连插 8 条新消息，读 VirtualizedList 的 offset）：
       *   · 关掉本 prop：内容高度每变一次（Δ=±70 抖动 / 新消息 +76 / 补历史页 +400~1600），
       *     offset **一动不动**（日志 `内容 28404→28335 Δ=-69 offset 27764→27764`）→ 视口被顶走；
       *   · 打开本 prop：每次内容变化 offset 都同步跟 Δ（`Δ=68 offset 3734→3802`）→ 视口纹丝不动。
       *   注意：那串 ±70 的「内容高度抖动」（无用户触摸时也在跑，约 7Hz）**与本 prop 无关**——
       *   关掉它照样抖（窗口边缘行反复挂载/卸载、以及行高重测）。它以前是**直接推视口**的
       *   （offset 不变 = 画面跳 ±70），现在被本 prop 吸收成 offset 的等量补偿，画面不动。
       *   若哪天又出现「房间消息自己上下跳」，先按这个思路查那串抖动，而不是回退本 prop。
       */
      maintainVisibleContentPosition: { minIndexForVisible: 0, autoscrollToTopThreshold: CHAT_STICK_BOTTOM_DP },
      /**
       * 「有 N 条新消息」浮标靠它判断用户是不是翻到了历史里（库会链式调用消费方的 onScroll）。
       * 阈值与 scrollToBottomOffset / autoscrollToTopThreshold 同源（CHAT_STICK_BOTTOM_DP）。
       */
      onScroll: handleChatListScroll,
      /**
       * 渐进渲染（真机日志：VirtualizedList 单次提交 4080ms → 首屏卡 4 秒）：
       * 限批先出 10 条、其余分批补齐。
       */
      initialNumToRender: 10,
      maxToRenderPerBatch: 10,
      windowSize: 7,
      /**
       * ⚠️ Android 上聊天库 FlatList 分支默认开 `removeClippedSubviews`（Platform.OS === 'android'）。
       * 它与 scrollToIndex 组合有已知问题：被裁掉的行测不到高度/位置，定位会随机落偏或落空 ——
       * 而房间消息列表正是「一进房就要 scrollToIndex 定位」的场景，所以显式关掉，
       * 以可控的性能代价换定位可靠性。
       */
      removeClippedSubviews: false,
      /**
       * 进房定位用 scrollToIndex，但目标行高度尚未测出时 VirtualizedList 会抛
       * 「scrollToIndex should be used in conjunction with getItemLayout or onScrollToIndexFailed」。
       *
       * ★ 迭代逼近（2026-10-03 稳定性修复）：
       *   旧实现只用「平均行高 × index」做一次像素粗估 —— 而房间消息行高差异极大
       * （纯文字约 60、带头像+名字约 120、媒体卡/礼物卡 200+），平均后误差累积，
       *   未读几十条时能偏出好几屏，这正是「定位位置不准」的主因。
       *   现在分两步：
       *     ① 目标行还没被测量 → 先跳到**已测量的最远行**（它一定滚得动），把它贴顶后
       *        更旧的行会进入渲染窗口被测量，下一轮 scrollToIndex 才能真正命中；
       *     ② 推进不动（已测最远不再增长）→ 才退化为像素估算兜底，保证至少滚到大致位置。
       */
      onScrollToIndexFailed: (info: any) => {
        try {
          const run = posRunRef.current;
          const target = Number(run.target);
          if (!(target >= 0)) return;
          const measured = Number(info?.highestMeasuredFrameIndex);
          const avg = Number(info?.averageItemLength) || 96;

          // ① 迭代逼近：目标未测量 → 推进到已测量的最远行，逼列表渲染中间行
          if (Number.isFinite(measured) && measured >= 0 && measured < target && measured > run.advancedTo) {
            run.advancedTo = measured;
            chatListRef.current?.scrollToIndex?.({ index: measured, viewPosition: 1, animated: false });
            logWarn(`[lastseen] 目标 idx=${target} 未测量→推进到已测量最远 idx=${measured}`, 'room');
            return;
          }
          // ② 兜底：推进受阻时用像素估算（至少让用户看到大致位置）
          const approx = Math.max(0, Math.round(avg * target));
          chatListRef.current?.scrollToOffset?.({ offset: approx, animated: false });
          logWarn(`[lastseen] 推进受阻→像素估算 idx=${target} avg=${Math.round(avg)} offset=${approx}`, 'room');
        } catch {}
      },
      /**
       * 用户一上手操作列表就停掉本次进房的自动定位（配合定位 effect 的 posUserScrolledRef），
       * 否则后面几轮重试会把用户刚翻到的地方硬拽回去。
       *
       * ⚠️ 这里用 `onTouchStart` 而不是 `onScrollBeginDrag`（2026-10-03 真机实测）：
       *    后者在库的 reanimated 包装列表（AnimatedFlatList）上**根本不触发** ——
       *    自动化滑动能让列表正常滚动，但回调一条日志都没有；而 onTouchStart 是更基础的
       *    触摸事件，实测必然透传。代价是「点开某条消息」也算一次交互，
       *    定位（进房后 ~3.4s 内）会立即让位给用户操作 —— 这正是期望语义。
       */
      onTouchStart: () => {
        const run = posRunRef.current;
        if (run.cancelled) return;
        run.cancelled = true;
        if (run.timer) clearTimeout(run.timer);
        posUserScrolledRef.current = true;
        logWarn('[lastseen] 用户触摸列表→取消本次自动定位', 'room');
      },
    } as any),
    // 全部走 ref / 常量，不需要依赖；onScroll 用的 handleChatListScroll 本身是空依赖的稳定回调
    [],
  );

  /**
   * 房间内横划手势：**向左滑 = 进小房间，向右滑 = 回大房间**（用户要求 2026-09-28）。
   *
   * 为什么改：上一版是「左滑进群聊 / 右滑回只看偶像」，与顶部「大房间 / 小房间」分段控件语义重叠，
   * 且用户反馈**有时会失效**。复核后确认失效来自判据叠了三层 —— 既要「甩得够快」（|vx|>0.35）
   * 又要「位移够大」（|dx|≥44），末尾还再来一次 `|dx| ≥ |dy|` 否决；慢速小幅的横滑会被整条丢掉。
   * 现在放宽为「甩得快」**或**「拖得够远」任一达标即可，二次否决也放宽成 1.2 倍。
   * 「群聊 / 只看偶像」改由工具栏那个圆形按钮（account-group）切换，不再占用横滑。
   *
   * ⚠️ 这里用 RN 自带的 `PanResponder`，**不是** RNGH 的 `Gesture.Pan`。
   * 上一版用 RNGH（`GestureDetector` + `activeOffsetX/failOffsetY`）实测**完全没反应**：
   * 它包住的正是 `@kesha-antonov/react-native-chat` 的列表，触摸被列表的原生滚动先接走，
   * 手势拿不到事件。改成 PanResponder 的「只认横向」判据（项目里 `GlassSegmented`
   * 就是这么做的，且已验证能在可滚动内容上工作）：
   *   - `onMoveShouldSetPanResponder` 只在 `|dx| > 14 且 |dx| > |dy| * 1.4` 时才接管 →
   *     竖向滑动（上划翻历史消息）完全不受影响；
   *   - 一旦接管，RN 会自动 `requestDisallowInterceptTouchEvent`，列表不会再抢回去。
   *
   * 只包消息区、不包整个房间：顶部「大/小房间」分段控件自己用 PanResponder 处理横拖
   *（GlassSegmented），包整屏会跟它抢触摸；房间内 Tab 横划已被 lockTabSwipe 全局锁掉，不冲突。
   *
   * PanResponder 只在首帧创建一次，回调通过 ref 读最新实现（与 PlayerChrome 的
   * `progCtl.current` 同一套写法，避免手势闭包里拿到过期的 selectedRoom/roomMode）。
   */
  const roomSwipeRef = useRef<(dx: number, vx: number, dy: number) => void>(() => {});
  roomSwipeRef.current = (dx, vx, dy) => {
    if (!selectedRoom) return;
    // 竖向位移明显更大 → 判定为在滑消息列表，不切房间（放宽到 1.2 倍：斜着划也能切）
    if (Math.abs(dy) > Math.abs(dx) * 1.2) return;
    const flung = Math.abs(vx) > 0.25; // 甩动：轻快一划就切（原 0.35 偏严）
    const dragged = Math.abs(dx) >= 32; // 拖拽：慢速拖过 32dp 也算（原要 44dp）
    if (!flung && !dragged) return;
    const nextMode: RoomMode = dx < 0 ? 'small' : 'big'; // 左滑 = 下一个（与分段控件顺序一致）
    // 已在目标房间就不再发请求，但仍然给一句反馈 —— 否则用户会以为「手势又失效了」
    if (nextMode !== roomMode) openRoom(selectedRoom, nextMode, showFanMessages, 'internal');
    showToast(nextMode === 'small' ? t('小房间') : t('大房间'));
  };
  const roomSwipePan = useRef(
    PanResponder.create({
      // 起手不抢；只有横向位移明显大于纵向时才接管（竖向滚动交给列表）
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4,
      onPanResponderTerminationRequest: () => true,
      onPanResponderRelease: (_e, g) => roomSwipeRef.current(g.dx, g.vx, g.dy),
    }),
  ).current;

  /**
   * 房间内视图切换动画（用户要求 2026-09-28：偶像房间切换和群聊切换要有动画）。
   * 覆盖：大房间 ⇄ 小房间（分段控件 / 左右滑手势）、群聊 ⇄ 只看偶像（工具栏按钮）、跨成员进房。
   * 键 = 成员 + 模式 + 群聊开关，任一变化就把消息区做一次 240ms 淡入 + 轻微上移。
   * 容器不重挂载（Chat 保持实例，滚动位置与输入框状态不受影响），纯视觉层动画。
   */
  const roomSwitchKey = `${String((selectedRoom as any)?.id || '')}|${roomMode}|${showFanMessages ? 'fans' : 'idol'}`;
  const roomSwitchPrevRef = useRef(roomSwitchKey);
  const roomSwitchEnter = useSharedValue(1);
  useEffect(() => {
    if (roomSwitchPrevRef.current === roomSwitchKey) return;
    roomSwitchPrevRef.current = roomSwitchKey;
    roomSwitchEnter.value = 0;
    roomSwitchEnter.value = withTiming(1, { duration: 240, easing: ReEasing.out(ReEasing.cubic) });
  }, [roomSwitchKey, roomSwitchEnter]);
  /**
   * 房间 / 大小房间 / 群聊⇄只看偶像 一换，被引用的那条消息可能已不在当前列表里 ——
   * 引用态跟着清掉（用户 2026-10-14：引用别人的消息）。
   */
  useEffect(() => {
    setReplyTarget(null);
  }, [roomSwitchKey]);
  const roomSwitchStyle = useAnimatedStyle(() => ({
    /**
     * ⚠️ 这里**不做 opacity 动画**（用户 2026-09-30 反馈「房间刷多了出现遮罩，覆盖顶栏以下」）。
     *
     * 原先 opacity = `0.4 + 0.6 * enter`：只要这个 shared value 因为动画被打断 / 未执行 /
     * 容器在动画中途重挂载而停在 0，消息区就会**永久停在 40% 半透明** ——
     * 视觉上正是「顶栏以下蒙了一层纱」，而且没有任何自愈路径（越切房越容易命中）。
     * 现在只保留位移（位移卡住最多是位置偏 12dp，不会造成"遮罩"这种破坏性状态）。
     */
    transform: [{ translateY: (1 - roomSwitchEnter.value) * 12 }],
  }));

  if (selectedRoom) {
    // 精华消息的频道 key / 列表在页面顶部统一推导（roomEssenceKey / essenceItems），这里不再重复算
    const fid = String(selectedRoom.id || '');
    const isFollowingRoom = followedIds.has(fid);
    const followBusyRoom = followBusy.has(fid);
    // 房间名加载前用中性占位「房间」，不回退成员名 —— 避免「先显示成员名再被真实房间名替换」的闪烁
    const headerTitle = roomMeta.name ? capText(roomMeta.name, 18) : t('房间');
    const roomBgUri = roomMeta.bg || '';
    // 深色不压黑幕（用户反馈 2026-09-26：夜间房间背景像蒙了层黑纱）；浅色保留白雾
    const roomScrim = resolvedTheme === 'dark' ? 'transparent' : 'rgba(255,255,255,0.42)';
    return (
      /*
       * ⚠️【背景图修复】背景层必须放在**键盘 padding 容器之外**。
       * 原结构：<容器 style={{paddingBottom: 键盘高度}}> 里放 absolute 背景层 ——
       * React Native（Yoga）会把父容器的 padding 也作用到 absolute 子节点上，
       * 于是键盘高度一旦非 0（含「手势返回没触发 keyboardDidHide」导致卡住的旧值），
       * 背景层 bottom 就被抬高，屏幕下方露出一条没有背景的黑边
       * —— 用户反馈的「房间背景图显示不完全」。
       * 现在背景铺在整屏外层，padding 只影响内容，背景永远满幅。
       */
      <View style={styles.roomRoot}>
        {/* 背景双层常驻 crossfade（两层永不卸载，换图写隐藏槽 → onLoad 交叉淡入淡出，不闪底） */}
        {bgLayerA || bgLayerB ? (
          <>
            {bgLayerA ? (
              <Animated.View pointerEvents="none" style={[styles.roomBgLayer, { opacity: bgOpacityA }]}>
                <ImageBackground
                  source={{ uri: bgLayerA }}
                  resizeMode="cover"
                  style={StyleSheet.absoluteFill}
                  onLoad={() => onBgSlotLoad('A')}
                  onError={() => onBgSlotError('A')}
                />
              </Animated.View>
            ) : null}
            {bgLayerB ? (
              <Animated.View pointerEvents="none" style={[styles.roomBgLayer, { opacity: bgOpacityB }]}>
                <ImageBackground
                  source={{ uri: bgLayerB }}
                  resizeMode="cover"
                  style={StyleSheet.absoluteFill}
                  onLoad={() => onBgSlotLoad('B')}
                  onError={() => onBgSlotError('B')}
                />
              </Animated.View>
            ) : null}
            <View pointerEvents="none" style={[styles.roomBgLayer, { backgroundColor: roomScrim }]} />
          </>
        ) : null}
        <View style={[styles.container, { paddingBottom: roomPlaying ? 0 : roomKeyboardHeight }]}>
        {roomPlaying ? (
          /* 房间内播放：统一播放宿主（用户 2026-10-02）。
             解析（黑底解析中/失败重试占位）、弹幕（云信飘屏/输入条/列表/LRC）、
             在线人数、续播与进度、小窗交棒、PlayerScreen 组装全部由宿主完成 ——
             本页只声明「播什么」+ 房间特有的按钮与浮层。 */
          <View style={[styles.roomPlayerPage, { backgroundColor: '#000' }]}>
            <MediaPlaybackHost
              ref={playbackHostRef}
              /* 场景预设（用户 2026-11-13）：公告 + 续播提示默认开、不显示「进房间」（已在房间里） */
              scene="room"
              media={roomPlaying}
              onClose={closeRoomPlayer}
              /* 送礼对象 = 房间主人（主播）：宿主据此显示「礼物」按钮并发公屏广播 */
              giftTargetUserId={String((selectedRoom as any)?.id || '')}
              giftTargetName={String((selectedRoom as any)?.ownerName || '')}
              /* 贡献榜 liveId：房间口径（在播这一场 → 直播中索引兜底） */
              rankLiveId={roomLiveId()}
              /* 弹幕列表 / 飘屏点发送者 → 房间内用户资料卡（用户 2026-11-12） */
              onOpenDanmakuProfile={(entry) => openSenderProfile({
                id: entry.userId != null ? String(entry.userId) : '',
                name: entry.nick,
                avatar: entry.avatar || '',
              })}
              /* 贡献榜点某行 → 同一个房间内资料卡 */
              onOpenUserProfile={(target) => openSenderProfile({
                id: String(target.userId || ''),
                name: target.name,
                avatar: target.avatar || '',
              })}
              /* 小窗回大窗回跳：带上成员 id，落回她的房间 */
              miniPlayerBackTo={miniPlayerBackTo}
            />
          </View>
        ) : null}
        {/* 直播解析占位层已删除（用户 2026-10-02）：
            解析中 / 解析失败的「黑底 + 重试 / 取消」现在是统一播放宿主的 shell
            （见 MediaPlaybackHost），房间与其它三个场景共用同一套，不再各写一份。 */}
        {/* 直播回放抽屉：挂在播放器覆盖层**之外** —— 播放器关闭时（在房间里浏览）也要能打开 */}
        <MemberReplaySheet
          visible={showRoomReplay}
          onClose={() => setShowRoomReplay(false)}
          member={selectedRoom ? { id: String(selectedRoom.id || ''), name: shortName(selectedRoom, String(selectedRoom.id || '')), avatar: selectedRoom.avatar } : null}
          onPick={playRoomReplay}
        />
        {/* 语音消息实际播放器：页面级隐藏 Video（仅气泡卡片交互，不渲染任何可见控件） */}
        {playingMedia && playingMedia.type === 'audio' && playingMedia.url ? (
          <Video
            key={playingMedia.url}
            source={playerSource(playingMedia.url)}
            style={styles.hiddenAudioVideo}
            paused={false}
            playInBackground
            ignoreSilentSwitch="ignore"
            onEnd={() => setPlayingMedia(null)}
            onError={() => setPlayingMedia(null)}
          />
        ) : null}
        {/* 房间精华消息弹窗（用户 2026-11-09）：大卡片 + 头像/原图/视频，关掉后只剩工具栏喇叭 */}
        <RoomPinnedSheet
          visible={pinnedSheetVisible}
          items={essenceItems}
          index={essenceIndex}
          status={roomEssenceStatus}
          onPrev={() => setEssenceIndex((i) => Math.max(0, i - 1))}
          onNext={() => setEssenceIndex((i) => Math.min(Math.max(0, essenceItems.length - 1), i + 1))}
          onRetry={() => loadRoomEssence(roomEssenceKey, roomEssenceServerId)}
          onClose={() => {
            useRoomPinnedStore.getState().dismiss(roomEssenceKey);
            setPinnedSheetVisible(false);
          }}
          onOpenSender={(item: RoomEssenceMessage) => {
            const uid = String(item.userId || '').trim();
            const member = uid ? memberIndex.get(uid) : undefined;
            setPinnedSheetVisible(false);
            if (!member && !uid) {
              showToast(t('这条消息没有发送者资料'));
              return;
            }
            /**
             * 与房间内点消息头像**完全同一条路径**（用户 2026-11-09）：
             * 成员也弹房间用户资料卡（含成员档案/关注/私信），不再跳 ProfileScreen ——
             * 跳页会离开房间，和房间里的头像行为不一致。
             */
            openSenderProfile({
              id: uid || String((member as any)?.userId || (member as any)?.id || ''),
              name: item.sender || String((member as any)?.ownerName || ''),
              avatar: item.avatarUrl || String((member as any)?.avatar || ''),
              member: member || null,
              userIds: uid ? [uid] : [],
            });
          }}
          onOpenImage={(url: string) => {
            setImageUrls([url]);
            setFullImageUrl(url);
          }}
        />
        <ZoomImageModal
          url={fullImageUrl}
          /* 同一次浏览的图片序列（左滑更早 / 右滑更新，用户 2026-11-02） */
          urls={imageUrls}
          index={Math.max(0, imageUrls.indexOf(fullImageUrl))}
          /* 刻意不传 onIndexChange：翻页时若回写 `fullImageUrl`，这个 3800 行的房间页
             每滑一张就整体重渲染一次（聊天列表、索引全跟着算）—— 真机上就是卡一下 + 闪一下。
             当前张由查看器内部维护，保存时通过 onSave(url) 回传即可。 */
          onClose={() => {
            setFullImageUrl('');
            setImageUrls([]);
          }}
          onSave={(target) => {
            const url = target || fullImageUrl;
            if (!url) return;
            // 保存 = 原图入下载管理并自动进系统相册「牙牙消息」（用户 2026-10-02：房间图片没法保存）
            downloadMedia({ type: 'image', url, title: '' } as any);
          }}
        />
        {/* 房间工具栏送礼：**只在没起播时**用这个实例（起播后由宿主内置面板接管，
            与直播页同一份 UI + 同一份数据逻辑 usePlaybackGift）。 */}
        {!roomPlaying ? (
          <LiveGiftSheet
            visible={giftVisible}
            onClose={() => setGiftVisible(false)}
            gifts={roomGift.gifts}
            balance={roomGift.balance}
            status={roomGift.status}
            selected={roomGift.selected}
            num={roomGift.num}
            onChangeNum={roomGift.setNum}
            onSelect={roomGift.select}
            onSend={() => { void roomGift.send(); }}
            onRecharge={() => {
              setGiftVisible(false);
              (navigation as any).navigate('RechargeScreen');
            }}
          />
        ) : null}
        {/* 用户资料卡（房间内点非成员头像）：口袋48 user/info 拉昵称/头像/等级/签名 */}
        <Modal visible={!!userCard} transparent animationType="slide" onRequestClose={() => setUserCard(null)}>
          <View style={styles.roomModalShade}>
            {/* 关闭区（卡片上方的空白）：点它才关闭资料卡。
                ⚠️ 卡片**不能再**包在 TouchableOpacity 里"防穿透"（旧写法）——Touchable 会成为
                响应者并与卡片内的 ScrollView 抢手势，档案内容用手指**根本拖不动**
                （用户 2026-10-02 反馈）。
                改成兄弟节点后：卡片是普通 View，不参与响应者竞争 → 拖动顺畅；
                点卡片上也不会误关（不是父子关系，事件不会冒泡到关闭区）。 */}
            <TouchableOpacity style={styles.userCardDismiss} activeOpacity={1} onPress={() => setUserCard(null)} />
            <View style={styles.userCardWrap}>
              <GlassSurface radius={22} role="card" style={[styles.userCardPanel, { height: userCardHeight, backgroundColor: 'transparent' }]}>
                <View style={styles.roomRankHandleWrap}>
                  <View style={[styles.roomRankHandle, { backgroundColor: palette.fill3 }]} />
                </View>
                {/* 内容区整体可滚（头部 + 提示 + 成员档案）：底部操作行固定在卡片底部。
                    `flex: 1` = 吃满"卡片固定高度 − 固定元素"的全部剩余空间 —— 卡片高度确定后，
                    内容区高度也确定，内容超出必定可滚（不会出现"拖不动"）。 */}
                <ScrollView style={styles.userCardBody} showsVerticalScrollIndicator={false}>
                <View style={styles.userCardHead}>
                  {(() => {
                    const cardAvatar = userCard?.detail?.avatar || userCard?.avatar || '';
                    const cardName = userCard?.detail?.name || userCard?.name || t('未知用户');
                    return (
                      <>
                        {cardAvatar ? (
                          <NetworkImage source={{ uri: cardAvatar }} style={[styles.userCardAvatar, { backgroundColor: palette.fill2 }]} thumbnail={180} />
                        ) : (
                          <View style={[styles.userCardAvatar, { backgroundColor: palette.fill2, alignItems: 'center', justifyContent: 'center' }]}>
                            <MaterialCommunityIcons name="account" size={30} color={palette.labelTertiary} />
                          </View>
                        )}
                        <View style={styles.userCardTitleWrap}>
                          <Text style={[styles.userCardName, { color: palette.label }]} numberOfLines={1}>{cardName}</Text>
                          <Text style={[styles.userCardMeta, { color: palette.labelSecondary }]} numberOfLines={1}>
                            {/* 只在拿到「数字 userId」时展示 ID 行：云信 accid 等内部 id 不露给用户看 */}
                            {userCard?.id && /^\d+$/.test(userCard.id) ? `${t('用户 ID')}：${userCard.id}` : ''}
                            {userCard?.detail?.level ? ` · ${t('等级 {level}', { level: userCard.detail.level })}` : ''}
                          </Text>
                          {userCard?.isMember || userCard?.detail?.team || userCard?.detail?.period ? (
                            <Text style={[styles.userCardMeta, { color: palette.tint }]} numberOfLines={1}>
                              {[
                                userCard?.isMember ? t('成员') : '',
                                userCard?.detail?.team || '',
                                userCard?.detail?.period || '',
                              ].filter(Boolean).join(' · ')}
                            </Text>
                          ) : null}
                        </View>
                      </>
                    );
                  })()}
                </View>
                {userCard?.loading ? (
                  <View style={styles.userCardStatus}>
                    <ActivityIndicator color={palette.tint} />
                    <Text style={[styles.userCardTip, { color: palette.labelSecondary }]}>{t('正在加载用户资料…')}</Text>
                  </View>
                ) : null}
                {userCard?.error ? (
                  <View style={[styles.userCardNotice, { backgroundColor: palette.fill2 }]}>
                    <Text style={[styles.userCardTip, { color: palette.labelSecondary }]}>{userCard.error}</Text>
                  </View>
                ) : null}
                {userCard?.detail?.signature ? (
                  <View style={[styles.userCardNotice, { backgroundColor: palette.fill2 }]}>
                    <Text style={[styles.userCardTip, { color: palette.labelSecondary }]}>{userCard.detail.signature}</Text>
                  </View>
                ) : null}
                {/* 成员档案**就地显示**（用户 2026-10-02）：成员/房主的头像点开后，档案内容
                    （基本信息 / 生涯历程 / 技术参数 / 粉丝排行 / 重要经历）直接出现在这张卡上，
                    不再需要跳页面。内容与「成员档案」页同源同渲染（MemberArchiveContent）。
                    非成员（粉丝）不渲染这一段，资料卡行为与以前完全一致。 */}
                {userCard?.member ? (
                  <View style={styles.userCardArchive}>
                    <Text style={[styles.userCardArchiveTitle, { color: palette.tint }]}>{t('成员档案')}</Text>
                    {/* 不再自带滚动：整个内容区（上面的 ScrollView）一起滚 —— 避免"滚动区里套滚动区"，
                        也保证底部操作行始终固定可见 */}
                    <MemberArchiveContent
                      member={userCard.member}
                      data={memberArchive.data}
                      error={memberArchive.error}
                      history={memberArchive.history}
                      loading={memberArchive.loading}
                      onRetry={memberArchive.reload}
                      /* inset 0：资料卡自带 padding，档案卡片不再二次缩进 */
                      inset={0}
                    />
                  </View>
                ) : null}
                </ScrollView>
                <View style={styles.userCardActions}>
                  <ScalePressable
                    style={[styles.userCardBtn, { backgroundColor: userCard?.following ? palette.fill2 : palette.tint }]}
                    pressedScale={0.95}
                    activeOpacity={0.85}
                    disabled={!userCard || userCard.followBusy}
                    onPress={() => userCard && void toggleFollowUser(userCard)}
                  >
                    <MaterialCommunityIcons
                      name={userCard?.following ? 'account-check' : 'account-plus'}
                      size={14}
                      color={userCard?.following ? palette.labelSecondary : palette.onTint}
                    />
                    <Text style={[styles.userCardBtnText, { color: userCard?.following ? palette.labelSecondary : palette.onTint }]}>
                      {userCard?.mutual ? t('互相关注') : userCard?.following ? t('已关注') : t('关注')}
                    </Text>
                  </ScalePressable>
                  <ScalePressable
                    style={[styles.userCardBtn, { backgroundColor: palette.fill2 }]}
                    pressedScale={0.95}
                    activeOpacity={0.85}
                    disabled={!userCard}
                    onPress={() => userCard && openUserPrivateMessage(userCard)}
                  >
                    <MaterialCommunityIcons name="message-text-outline" size={14} color={palette.tint} />
                    <Text style={[styles.userCardBtnText, { color: palette.tint }]}>{t('私信')}</Text>
                  </ScalePressable>
                  {/* 成员档案入口已删除（用户 2026-10-02）：档案内容已经**就地**显示在卡片里，
                      再放一个"跳完整页"的入口是重复入口 —— 卡内只见内容，不见跳转 */}
                  <ScalePressable
                    style={[styles.liveResolveBtnGhost, { paddingHorizontal: 16, paddingVertical: 8, borderColor: palette.hairline }]}
                    pressedScale={0.95}
                    activeOpacity={0.85}
                    onPress={() => setUserCard(null)}
                  >
                    <Text style={[styles.liveResolveBtnGhostText, { color: palette.labelSecondary }]}>{t('关闭')}</Text>
                  </ScalePressable>
                </View>
              </GlassSurface>
              {/* 卡片**下方**的留白同样可点关闭（用户 2026-10-02：「现在点上方可以退出，我需要下方也可以」）。
                  这段留白还顺带把底部操作行从系统手势条/导航条上抬起来，避免按钮被压住点不到。 */}
              <TouchableOpacity style={styles.userCardDismissBottom} activeOpacity={1} onPress={() => setUserCard(null)} />
            </View>
          </View>
        </Modal>
        <ScreenHeader title={headerTitle} onBack={closeRoom} overlay={!!roomBgUri} right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity
              style={[styles.followBtn, { backgroundColor: isFollowingRoom ? palette.tintSoft : palette.tint }]}
              disabled={followBusyRoom}
              onPress={() => toggleFollow(selectedRoom)}
              activeOpacity={0.85}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            >
              {followBusyRoom ? (
                <ActivityIndicator color={isFollowingRoom ? palette.tint : palette.onTint} size="small" />
              ) : (
                <Text style={[styles.followBtnText, { color: isFollowingRoom ? palette.tint : palette.onTint }]}>{isFollowingRoom ? t('已关注') : t('关注')}</Text>
              )}
            </TouchableOpacity>
          </View>
        } />

          {/* 聊天工具条：扁平化（用户 2026-11-09）—— 纯色条 + 细描边，不再有模糊玻璃 */}
          <View style={[styles.chatToolsClip, { borderColor: palette.innerStroke, backgroundColor: palette.surface }]}>
            <View style={styles.chatTools}>
          {roomSearchOpen ? (
            /* 搜索态：输入框原位替换分段切换（房间内搜索 = 搜消息） */
            <>
              <MaterialCommunityIcons name="magnify" size={17} color={palette.labelTertiary} />
              <TextInput
                style={{ flex: 1, fontSize: 14, color: palette.label, padding: 0, height: 34, alignSelf: 'center' }}
                placeholder={t('搜索聊天记录...')}
                placeholderTextColor={palette.labelTertiary}
                value={roomSearchQuery}
                onChangeText={setRoomSearchQuery}
                autoFocus
                returnKeyType="search"
              />
              {!!roomSearchQuery ? (
                <TouchableOpacity onPress={() => setRoomSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.7}>
                  <MaterialCommunityIcons name="close-circle" size={16} color={palette.labelTertiary} />
                </TouchableOpacity>
              ) : null}
            </>
          ) : (
            <>
              {/* 分段切换：大房间 / 小房间（玻璃滑动选中） */}
              <GlassSegmented
                options={[
                  { key: 'big', label: t('大房间') },
                  { key: 'small', label: t('小房间') },
                ]}
                value={roomMode}
                onChange={(k) => selectedRoom && openRoom(selectedRoom, k as 'big' | 'small', showFanMessages, 'internal')}
                height={34}
                /* 150 而不是 168：给右边新增的精华喇叭腾出位置（用户 2026-11-09），
                   否则窄屏上工具栏最后两个按钮会被挤出屏幕（本行按钮本来就多）。 */
                style={{ width: 150 }}
              />
              {/* 精华消息入口（用户 2026-11-09）：就在「大房间/小房间」右边一点。
                  弹窗关掉后只剩这个喇叭；有没看过的精华时右上角红点。 */}
              <RoomPinnedBell
                active={pinnedSheetVisible}
                hasUnseen={essenceUnseen.length > 0}
                loading={roomEssenceStatus === 'loading' && !essenceItems.length}
                onPress={() => {
                  if (roomEssenceStatus === 'idle' || roomEssenceStatus === 'error') {
                    loadRoomEssence(roomEssenceKey, roomEssenceServerId);
                  }
                  useRoomPinnedStore.getState().show(roomEssenceKey);
                  setPinnedSheetVisible(true);
                }}
              />
              <View style={{ flex: 1 }} />
            </>
          )}
          <ScalePressable
            style={[styles.chatToolCircle, { backgroundColor: roomSearchOpen ? palette.tint : palette.fill2 }]}
            onPress={() => setRoomSearchOpen((v) => !v)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            pressedScale={0.9}
          >
            <MaterialCommunityIcons
              name={roomSearchOpen ? 'close' : 'magnify'}
              size={18}
              color={roomSearchOpen ? palette.onTint : palette.labelSecondary}
            />
          </ScalePressable>
          <ScalePressable
            style={[styles.chatToolCircle, { backgroundColor: showFanMessages ? palette.tint : palette.fill2 }]}
            onPress={() => openRoom(selectedRoom, roomMode, !showFanMessages, 'internal')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            pressedScale={0.9}
          >
            <MaterialCommunityIcons
              name="account-group"
              size={18}
              color={showFanMessages ? palette.onTint : palette.labelSecondary}
            />
          </ScalePressable>
          {/* 送礼：该成员正在直播时直接开面板（不用先进播放器）；大/小房间同一入口。
              用户 2026-11-02：房间内可直接送礼，不要只能从播放器控制坞进。 */}
          {roomGiftAvailable ? (
            <ScalePressable
              style={[styles.chatToolCircle, { backgroundColor: giftVisible ? palette.tint : palette.fill2 }]}
              onPress={() => openRoomGiftPanel()}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              pressedScale={0.9}
            >
              <MaterialCommunityIcons
                name="gift"
                size={18}
                color={giftVisible ? palette.onTint : palette.labelSecondary}
              />
            </ScalePressable>
          ) : null}
          {/* 直播回放：该成员的历史直播（点条目就地用房间播放器播放）。
              入口放工具栏而不是「更多」二级菜单 —— 用户要的是「进房间就能看到」 */}
          <ScalePressable
            style={[styles.chatToolCircle, { backgroundColor: showRoomReplay ? palette.tint : palette.fill2 }]}
            onPress={() => setShowRoomReplay(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            pressedScale={0.9}
          >
            <MaterialCommunityIcons
              name="history"
              size={18}
              color={showRoomReplay ? palette.onTint : palette.labelSecondary}
            />
          </ScalePressable>
          {/* 相册：房间消息里的图片与视频（个人相册 / 房间相册 双 Tab，用户 2026-11-08）。
              channelId 必须按当前侧取：大房间用 channelId、小房间用 yklzId（两个不同的 channel）。 */}
          <ScalePressable
            style={[styles.chatToolCircle, { backgroundColor: palette.fill2 }]}
            onPress={() => {
              const ch = roomMode === 'small'
                ? String((selectedRoom as any)?.yklzId || (selectedRoom as any)?.channelId || '')
                : String((selectedRoom as any)?.channelId || '');
              navigation.navigate('PhotosScreen', {
                memberId: String(selectedRoom?.id || ''),
                channelId: ch,
                tab: 'room',
              });
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            pressedScale={0.9}
          >
            <MaterialCommunityIcons name="image-multiple" size={18} color={palette.labelSecondary} />
          </ScalePressable>
          {!!onMicMap[String(selectedRoom.id || (selectedRoom as any).userId || '')] ? (
            <ScalePressable
              style={[styles.chatToolCircle, { backgroundColor: palette.tint }]}
              onPress={() => { void playRoomRadioInline(); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              pressedScale={0.9}
            >
              <MaterialCommunityIcons name="microphone" size={18} color={palette.onTint} />
            </ScalePressable>
          ) : null}
            </View>
          </View>

          {/* 房间精华消息的弹窗渲染在页面底部（与其它 Modal 同层），
              工具栏里只留一个喇叭入口 —— 见 RoomPinnedBell。 */}

        <FadeInView delay={80} duration={300} style={{ flex: 1 }}>
          {/* 左滑进小房间 / 右滑回大房间（2026-09-28 由「切群聊」改为「切大小房间」）：
              手势只包**消息区** —— 顶部的「大房间/小房间」分段控件自己用 PanResponder 处理横拖，
              包整屏会抢触摸；房间内 Tab 横划已被 lockTabSwipe 全局锁掉。详见上方 roomSwipePan。
              Reanimated 层：大小房间 / 群聊 ⇄ 只看偶像 / 跨成员切换时的淡入动画（见 roomSwitchKey）。 */}
            <Reanimated.View style={[{ flex: 1 }, roomSwitchStyle]} {...roomSwipePan.panHandlers}>
              {/* 官方 demo 用法：messages / user / onSend + 官方 loadEarlierMessagesProps */}
              <Chat
                /**
                 * ⚠️ 传 displayIms 而不是 chatIms：只看偶像 + 窗口期内偶像无消息时
                 * 传**空数组**，由下方居中提示整屏接管（用户 2026-10-01：
                 * 偶像无消息的房间不许显示任何消息 —— 不显示粉丝消息、更不显示另一侧残留）。
                 */
                messages={displayIms}
                messagesContainerRef={chatListRef}
                /* ⚠️ colorScheme 必须跟 App 的 resolvedTheme：库内部自己读系统深浅色
                   （react-native-chat/lib/index.js useColorScheme），夜间系统进深色后
                   库走 darkTheme 分支，而下面 theme 是浅色槽 → 透明背景覆盖被丢弃，
                   消息列表区显示库默认深色黑底、整块盖住房间背景图（用户反馈 2026-09-26）。
                   跟随 App 主题后，浅色下永远走浅色槽；theme/darkTheme 两槽都给透明背景。 */
                colorScheme={resolvedTheme}
                theme={CHAT_TRANSPARENT_THEME}
                darkTheme={CHAT_TRANSPARENT_THEME}
                locale="zh"
                // 日期分隔：纯数字「今天/昨天/x月x日」，居中显示（renderDayLabel）
                // 整行自定义：用页面既有的 renderChatItem —— 头像、气泡外的发送者名字、
                // 回复卡片、礼物、媒体全都保留；气泡本身是玻璃（GlassSurface）。
                // 不再用 renderBubble：它只能改气泡内部，名字被迫塞进气泡里（与设计不符）。
                renderMessage={chatRenderMessage}
                renderDay={renderDayLabel}
                isDayAnimationEnabled={false}
                user={CHAT_SELF_USER}
                onSend={CHAT_ON_SEND}
                renderInputToolbar={CHAT_NO_INPUT_TOOLBAR}
                // 一键回到底部（用户要求：群聊/只看偶像/大小房间全模式生效 —— 它们共用本组件）。
                // 库内置实现：滚离最新消息超过 scrollToBottomOffset 时浮现圆形↓按钮，点击动画回底。
                // 配色用品牌粉（palette.tint），与软件整体风格一致。
                isScrollToBottomEnabled
                /**
                 * ⚠️ 用户反馈（2026-09-28）：「在偶像房间里向上划消息，有时会突然回到底部，多次触发」。
                 *
                 * 根因就在这个阈值：聊天库（`MessagesContainer` 内部）在
                 * **「距最新消息的滚动距离 < scrollToBottomOffset」时会自动把列表拉回底部**
                 * （见库内 `distanceFromNewest > scrollToBottomOffset` 与依赖 latestMessageId 的自动回底 effect）。
                 * 原来给的是 **300px** —— 也就是说你往上划但还没超过 300px 时，
                 * 房间里 15 秒一次的静默刷新 / 实时消息一进来，就把你拽回底部；
                 * 「有时」正是因为只有 300px 内才会被拽（超过 300px 就安全了）。
                 *
                 * 现在收紧到 48px：**只要你有意义地往上划一下，就脱离了自动吸底**
                 *（代价是「回到底部」圆钮会出现得早一点 —— 与 iOS 一致：一离开底部就出现 ↓）。
                 */
                scrollToBottomOffset={CHAT_STICK_BOTTOM_DP}
                scrollToBottomComponent={chatScrollToBottomComponent}
                scrollToBottomContentStyle={chatScrollToBottomContentStyle}
                loadEarlierMessagesProps={chatLoadEarlierProps}
                // listProps：库会把它 spread 在**最后**（优先级最高）。
                // 内容（关闭自动吸底 / 渐进渲染 / scrollToIndex 失败兜底）与原因见组件内 chatListProps。
                listProps={chatListProps}
              />
              {/* 房间内搜索（工具栏放大镜）无结果时明确提示，避免用户以为列表坏了。
                  只在**搜索中且确实 0 条**时出现：房间本身没消息时交给列表自身空态表达。 */}
              {roomSearchOpen && !!roomSearchQuery.trim() && chatIms.length === 0 ? (
                <View style={styles.roomSearchEmpty} pointerEvents="none">
                  <MaterialCommunityIcons name="magnify-close" size={26} color={palette.labelTertiary} />
                  <Text style={[styles.roomSearchEmptyText, { color: palette.labelTertiary }]}>{t('没有找到匹配的消息')}</Text>
                </View>
              ) : null}
              {/* ★ 小房间在服务端不可用（未开通 / 已关闭 / 无权限，用户 2026-11-12）：
                  以前这类房间会被「回退到大房间频道」的数据填满 —— 小房间里显示大房间聊天记录
                  （用户原话「大房间和小房间串了」）。现在 openRoom 已拦截并标记，
                  这里只显示明确提示：不给「重试」（重试永远只会拿回大房间数据），
                  也不参与「N 天内偶像无消息」判定（那会误报）。 */}
              {!roomSearchOpen && roomMode === 'small' && roomSideClosed ? (
                <View style={styles.roomSearchEmpty} pointerEvents="none">
                  <View style={styles.roomIdleCard}>
                    <MaterialCommunityIcons name="door-closed" size={26} color={IDLE_CARD_FG} />
                    <Text style={[styles.roomSearchEmptyText, { color: IDLE_CARD_FG }]}>
                      {t('该成员的小房间未开通')}
                    </Text>
                    <Text style={[styles.roomErrorHint, { color: IDLE_CARD_FG_MUTED }]}>
                      {t('点「大房间」查看大房间消息')}
                    </Text>
                  </View>
                </View>
              ) : null}
              {/* ★ 「{days} 天内偶像无消息」（用户 2026-10-01 口径，大/小房间通用）：
                  只看偶像视图下，窗口期内偶像没有任何发言 → 消息区**只显示这一条提示**，
                  不显示任何消息（含另一侧的残留消息），也不再自动展开群聊。 */}
              {!roomSearchOpen && !showFanMessages && idolIdleNow ? (
                <View style={styles.roomSearchEmpty} pointerEvents="none">
                  {/* 用户 2026-10-01：提示压在房间背景图上 → 自带浅色遮罩卡片 + 黑字，保证看得清 */}
                  <View style={styles.roomIdleCard}>
                    <MaterialCommunityIcons name="clock-outline" size={26} color={IDLE_CARD_FG} />
                    <Text style={[styles.roomSearchEmptyText, { color: IDLE_CARD_FG }]}>
                      {t('{days} 天内偶像无消息', { days: IDOL_IDLE_WINDOW_DAYS })}
                    </Text>
                    <Text style={[styles.roomErrorHint, { color: IDLE_CARD_FG_MUTED }]}>{t('点群聊按钮可查看全部')}</Text>
                  </View>
                </View>
              ) : null}
              {/* 群聊视图命中 idle：消息正常显示，列表顶部提示条**显示 3 秒后自动消失**
                  （用户 2026-10-01：手动切群聊可以看粉丝消息，提示知道一下即可，不用常驻） */}
              {!roomSearchOpen && showFanMessages && idolIdleNow && idleBannerVisible ? (
                <View style={[styles.roomIdleBanner, { backgroundColor: labelMaskBg }]} pointerEvents="none">
                  <MaterialCommunityIcons name="clock-outline" size={13} color={labelMaskFg} />
                  <Text style={[styles.roomIdleBannerText, { color: labelMaskFg }]} numberOfLines={1}>
                    {t('{days} 天内偶像无消息', { days: IDOL_IDLE_WINDOW_DAYS })}
                  </Text>
                </View>
              ) : null}
              {/* 「只看偶像」过滤后为空（且非 idle 场景）：兜底提示，而不是留一片空白（用户 2026-09-30：
                  房间内消息列表"卡没"的一种形态 —— 消息其实都在，只是全被过滤隐藏了） */}
              {!roomSearchOpen && !showFanMessages && !idolIdleNow && roomMessages.length > 0 && chatIms.length === 0 ? (
                <View style={styles.roomSearchEmpty} pointerEvents="none">
                  <MaterialCommunityIcons name="eye-off-outline" size={26} color={palette.labelTertiary} />
                  <Text style={[styles.roomSearchEmptyText, { color: palette.labelTertiary }]}>{t('当前只显示偶像发言')}</Text>
                  <Text style={[styles.roomErrorHint, { color: palette.labelTertiary }]}>{t('点群聊按钮可查看全部')}</Text>
                </View>
              ) : null}
              {/* 消息加载失败：常驻提示 + 一键重试。
                  `roomMsgError` 以前只有 setter、没有任何消费者 —— 失败时只剩一条瞬逝 toast
                  + 空列表，用户体感就是「进房间经常加载不出消息」（现在还有 1s/3s/8s 自动重试兜底）。 */}
              {!!roomMsgError && roomMessages.length === 0 ? (
                /* ⚠️ box-none 必需（用户 2026-09-30 反馈「房间刷多了出现遮罩 + 卡住」）：
                   这层是 absoluteFill，若让它自己接收触摸，消息区就被整片盖住、无法滚动/点击；
                   box-none = 层本身不吃触摸，只有里面的「重试」按钮吃。 */
                <View style={styles.roomErrorWrap} pointerEvents="box-none">
                  <MaterialCommunityIcons name="cloud-off-outline" size={26} color={palette.labelTertiary} />
                  <Text style={[styles.roomSearchEmptyText, { color: palette.labelTertiary }]}>{t('消息加载失败')}</Text>
                  <Text style={[styles.roomErrorHint, { color: palette.labelTertiary }]} numberOfLines={2}>{roomMsgError}</Text>
                  <TouchableOpacity
                    style={[styles.roomErrorRetry, { backgroundColor: palette.tint }]}
                    onPress={() => refreshRoomMessagesRef.current?.()}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.roomErrorRetryText, { color: palette.onTint }]}>{t('重试')}</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {/* 「有 N 条新消息」浮标（用户 2026-11-09）：翻在历史里时新消息只计数、不抢滚动；
                  点一下回到底部并清零。计数口径见 handleChatListScroll 上方的长注释。 */}
              {roomNewMsgCount > 0 ? (
                <View style={styles.roomNewMsgWrap} pointerEvents="box-none">
                  <TouchableOpacity
                    style={[styles.roomNewMsgPill, { backgroundColor: palette.tint }]}
                    onPress={jumpToNewestMessages}
                    activeOpacity={0.9}
                  >
                    <MaterialCommunityIcons name="arrow-down" size={13} color={palette.onTint} />
                    <Text style={[styles.roomNewMsgText, { color: palette.onTint }]} numberOfLines={1}>
                      {t('有 {n} 条新消息', { n: roomNewMsgCount > 99 ? '99+' : roomNewMsgCount })}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </Reanimated.View>
        </FadeInView>

        {/* 房间消息区上方的实时弹幕板已删除（用户 2026-10-02「只调用同一个播放器」）：
            它只在 roomPlayer 打开时渲染，而播放器是全屏覆盖层 —— 实际永远被盖住看不见
            （用户可见的实时弹幕都在播放器里，由统一播放宿主提供）。 */}

        {/* 房间发言（云信圈组）：HTTP 侧只有历史，发送必须走云信 */}
        {roomSendHint ? (
          <Text style={[styles.roomSendHint, { color: palette.tint }]} numberOfLines={2}>
            {roomSendHint}
          </Text>
        ) : null}
        {/* 引用（回复）条（用户 2026-10-14）：长按别人的消息后出现，发送时随 ext 一起发出。
            文案与原文都来自消息行（见 RoomChatMessageRow 的 onReplyMessage），这里只负责展示与取消。 */}
        {replyTarget ? (
          /* 白底玻璃（与消息气泡同一套材质）：房间底图花/亮时，只有 fill2 那么淡的底会看不清 */
          <GlassSurface
            role="chip"
            radius={12}
            noHighlight
            frost
            style={[styles.roomReplyBar, { borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}
          >
            <View style={[styles.roomReplyBarAccent, { backgroundColor: palette.tint }]} />
            <View style={styles.roomReplyBarBody}>
              <Text style={[styles.roomReplyBarName, { color: palette.tint }]} numberOfLines={1}>
                {t('回复 {name}', { name: replyTarget.name })}
              </Text>
              {replyTarget.text ? (
                <Text style={[styles.roomReplyBarText, { color: palette.labelSecondary }]} numberOfLines={1}>
                  {replyTarget.text}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity
              style={styles.roomReplyBarClose}
              onPress={() => setReplyTarget(null)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.85}
            >
              <MaterialCommunityIcons name="close" size={16} color={palette.labelSecondary} />
            </TouchableOpacity>
          </GlassSurface>
        ) : null}
        <GlassSurface
          role="chip"
          radius={16}
          frost
          style={[styles.roomInputBar, { backgroundColor: 'transparent', borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}
        >
          <TextInput
            ref={roomInputRef}
            style={[styles.roomInput, { color: palette.label }]}
            value={roomDraft}
            onChangeText={(next) => {
              setRoomDraft(next);
              if (roomSendHint) setRoomSendHint('');
            }}
            placeholder={replyTarget ? t('回复 {name}…', { name: replyTarget.name }) : t('说点什么…')}
            placeholderTextColor={palette.labelTertiary}
            maxLength={200}
            returnKeyType="send"
            onSubmitEditing={handleSendRoomMessage}
          />
          <TouchableOpacity
            onPress={handleSendRoomMessage}
            disabled={roomSending || !roomDraft.trim()}
            activeOpacity={0.85}
            style={[
              styles.roomSendBtn,
              { backgroundColor: roomDraft.trim() ? palette.tint : palette.fill3 },
            ]}
          >
            <Text style={[styles.roomSendBtnText, { color: roomDraft.trim() ? palette.onTint : palette.labelTertiary }]}>
              {roomSending ? '··' : t('发送')}
            </Text>
          </TouchableOpacity>
        </GlassSurface>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container]}>
      <ScreenHeader title={t('房间')} hideBack right={
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => { if (searchOpen) setSearchQuery(''); setSearchOpen((v) => !v); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.85}>
            <MaterialCommunityIcons
              name={searchOpen ? 'close' : 'magnify'}
              size={22}
              color={palette.label}
            />
          </TouchableOpacity>
          {/* 一键已读（建议 10）：把所有房间的未读数字/「新」一次清掉 */}
          <TouchableOpacity onPress={markAllRoomsRead} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.85}>
            <MaterialCommunityIcons name="check-all" size={22} color={palette.label} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => loadFollowed()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.85}>
            <MaterialCommunityIcons name="refresh" size={22} color={palette.label} />
          </TouchableOpacity>
        </View>
      } />


      {searchOpen ? (
        <View style={[styles.searchBar, { backgroundColor: palette.fill2, borderColor: palette.hairline }]}>
          <MaterialCommunityIcons name="magnify" size={18} color={palette.labelTertiary} />
          <TextInput
            style={[styles.searchInput, { color: palette.label }]}
            placeholder={t('搜索成员...')}
            placeholderTextColor={palette.labelTertiary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
            returnKeyType="search"
          />
          {searchQuery ? (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.85}>
              <MaterialCommunityIcons name="close-circle" size={16} color={palette.labelTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <FadeInView delay={80} duration={300} style={{ flex: 1 }}>
        {searchOpen && searchDebounced.trim() ? (
          /* 搜索态：成员库结果直接走 FlatList（可滚动、虚拟化）。
             单列整行卡（原来是 2 列竖排大卡，一屏只容 3 行、信息密度太低） */
          memberHits.length === 0 ? (
            <Text style={[styles.memberHitsEmpty, { color: palette.labelTertiary }]}>{t('没有匹配的成员')}</Text>
          ) : (
          <PerfFlatList
            {...chromeScrollProps}
            data={memberHits}
            keyExtractor={(member: any) => String((member as any).id || (member as any).userId || member.ownerName)}
            contentContainerStyle={styles.memberHitsListContent}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item: member, index }) => {
              const mid = String((member as any).id || (member as any).userId || '');
              const isFollowing = followedIds.has(mid);
              const busy = followBusy.has(mid);
              const name = shortName(member, mid);
              const team = member.team || member.groupName || t('成员');
              return (
                <FadeInView delay={index < 12 ? 80 + index * 30 : 0} duration={300} style={styles.memberGridItem}>
                  {/* ⚠️ 列表/网格逐卡禁止 GlassSurface（滚动逐帧重算模糊 → 掉帧）。
                      这里用实底卡 + hairline 描边，观感与玻璃卡一致但不参与模糊管线。 */}
                  <TouchableOpacity
                    style={[
                      styles.memberHitCard,
                      { backgroundColor: palette.surfaceGlassStrong, borderColor: palette.hairline },
                    ]}
                    onPress={() => openRoom(member)}
                    activeOpacity={0.88}
                  >
                    <View style={[styles.memberHitAvatar, { backgroundColor: palette.tintSoft, borderColor: palette.hairline }]}>
                      {member.avatar ? (
                        <NetworkImage source={{ uri: member.avatar }} style={styles.memberHitAvatarImg} thumbnail={180} />
                      ) : (
                        <Text style={[styles.memberHitAvatarText, { color: palette.tint }]}>{avatarInitial(name)}</Text>
                      )}
                    </View>
                    <View style={styles.memberHitMeta}>
                      {/* 名字与团队分行但左对齐成一组：横向排版比居中竖排更省高度、信息密度更高。
                          团队色用 labelSecondary（不是 labelTertiary）—— 深色卡上 tertiary 灰会糊掉。 */}
                      <Text style={[styles.memberHitName, { color: palette.label }]} numberOfLines={1}>{name}</Text>
                      <Text style={[styles.memberHitTeam, { color: palette.labelSecondary }]} numberOfLines={1}>{team}</Text>
                    </View>
                    <TouchableOpacity
                      style={[styles.memberHitBtn, { backgroundColor: isFollowing ? 'transparent' : palette.tint, borderColor: isFollowing ? palette.tint : 'transparent' }]}
                      disabled={busy}
                      onPress={() => toggleFollow(member)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      activeOpacity={0.85}
                    >
                      {busy ? (
                        <ActivityIndicator color={isFollowing ? palette.tint : palette.onTint} size="small" />
                      ) : (
                        <Text style={[styles.memberHitBtnText, { color: isFollowing ? palette.tint : palette.onTint }]}>
                          {isFollowing ? t('已关注') : t('关注')}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </TouchableOpacity>
                </FadeInView>
              );
            }}
          />
          )
        ) : (
          <PerfFlatList
            {...chromeScrollProps}
            ref={roomsListRef}
            key="rooms-list"
            /* 回退（用户要求 2026-09-28）：放弃「长按拖动排序」，回到普通虚拟列表。
               排序语义仍在（filtered 的 groupRank）：置顶恒在最上 → 有新消息临时置顶 → 其余。 */
            /* 数据兜底（用户 2026-09-30：「房间之间切换容易卡没房间列表」）：
               非搜索态下若 filtered 意外为空但有 followed，直接退回 followed ——
               宁可顺序不完美，也不能出现整片空白（这是"被卡没"最刺眼的形态）。 */
            data={!searchDebounced.trim() && !filtered.length && followed.length ? followed : filtered}
            /* 滚动锚点（B6）：30s 静默刷新替换数据 / 置顶重排时保持用户当前可见位置，不被弹回顶部 */
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            /* 下拉刷新（用户 2026-11-11）：手动触发一次完整重拉，不必等 30s 轮询 */
            refreshControl={(
              <RefreshControl
                refreshing={roomsRefreshing}
                onRefresh={handlePullRefresh}
                tintColor={palette.tint}
                colors={[palette.tint]}
              />
            )}
          /* key 兜底：memberId 可能为空（少数关注条目没有 memberId），空 key 会生成重复键
             → 行错乱/丢行（列表"少了几行"的一种形态） */
          keyExtractor={(item: any, index) => String(item.memberId || item.member?.id || index)}
          /* flexGrow: 空列表/报错态也要能下拉（内容比屏幕短时，不加它拉不动 RefreshControl） */
          contentContainerStyle={[styles.listContent, { flexGrow: 1 }]}
          renderItem={({ item }: any) => {
            /**
             * 未读徽标在**父级**算好，只把值（数字 / 布尔）传进这一行：
             * 行是 React.memo，传整张 store 表（counts/lastReadAt/seenTokens）会让
             * 任何一次未读写入都重渲染**所有可见行** —— 用户 2026-09-30 反馈的
             * 「列表卡顿 + 闪烁」主因之一。传值后只有未读真变的那几行才重渲染。
             */
            const id = String(item?.memberId || item?.member?.id || '');
            // ★ 单一数据源：只把两侧的累计条数传进行；指纹/时间判据不再参与渲染
            const bigCount = roomSideCountOf(id, 'big');
            const smallCount = roomSideCountOf(id, 'small');
            // 预览正文由 RoomListRow 按「成员 id + 侧」自己订阅 store：
            // 快扫 / 实时一写入即刻到行，不必等 setFollowed 换 data 引用
            /**
             * ★ 行状态在这里算成**基本类型**再传下去（用户 2026-10-01 性能优化）：
             * `liveNow` 每 30s、`onMicMap` 每次上麦扫描写回都会换新对象 ——
             * 以前整对象传进行 → React.memo 浅比较必失败 → **全部可见行重渲染**
             *（行内昵称正则 + 消息文本 + 四路索引查找都不便宜）。
             * 「直播中」四路命中口径（id / liveRoomId / account / 归一昵称）与行内原实现逐字一致：
             * 改这里必须同步改 RoomListRow 的 props 注释，别把容器再传回去。
             */
            const mid = String(item?.member?.id || item?.memberId || '');
            const mroom = String((item?.member as any)?.liveRoomId || '');
            const macct = String((item?.member as any)?.account || '');
            const mnick = String(item?.member?.ownerName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/i, '').trim().toLowerCase();
            const isLiveNow = liveNow.ids.has(mid) || (!!mroom && liveNow.ids.has(mroom)) || (!!macct && liveNow.ids.has(macct)) || (!!mnick && liveNow.names.has(mnick));
            return (
              <RoomListRow
              item={item}
              isFollowing={followedIds.has(mid)}
              isBusy={followBusy.has(mid)}
              isPinned={pinned.includes(String(item?.memberId || ''))}
              isLiveNow={isLiveNow}
              isOnMic={!isLiveNow && !!onMicMap[mid]}
              bigCount={bigCount}
              smallCount={smallCount}
              onOpenRoom={openRoom}
              onOpenLive={openMemberLive}
              onTogglePin={togglePin}
              onToggleFollow={toggleFollow}
              />
            );
          }}
          ListEmptyComponent={
            searchOpen && searchDebounced.trim() ? null : followedLoading ? (
            <CenterSpinner />
          ) : !token ? (
            <EmptyState
              icon="account-key-outline"
              title={t('登录后可查看关注房间和最新消息')}
              actionLabel={t('去登录')}
              onAction={() => navigation.navigate('AccountScreen')}
            />
          ) : followedError ? (
            <ErrorState title={t('加载失败')} hint={followedError} onAction={() => loadFollowed(true)} />
          ) : (
            <EmptyState icon="heart-outline" title={t('暂无关注房间')} />
          )}
          /* ⚠️ 关闭 removeClippedSubviews（Android 默认开，PerfFlatList 里也默认开）：
             Android 上「裁剪掉不可见子项」是著名的空白/闪烁来源（滚动或数据重排后整屏内容发白），
             与本列表「每 30s 重排 + 未读上浮」叠加时尤其容易触发 ——
             用户 2026-09-30 反馈的「莫名遮罩、房间都被卡没了」正是这类现象。
             虚拟化仍由 windowSize / initialNumToRender / maxToRenderPerBatch 生效，代价可接受。 */
          removeClippedSubviews={false}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          /* 注意：这里原先还有一个裸写的 `removeClippedSubviews`（=true），
             它会覆盖上面那条 false —— 已删除，只保留上面带说明的显式关闭。 */
          />
        )}
      </FadeInView>
    </View>
  );
}

// 空弹幕数组常量（NO_DANMAKU）已删除：弹幕层收口到统一播放宿主后，本页不再直接渲染
// DanmakuOverlay（宿主内部按「直播走云信 liveItems / 回放走 LRC 时间轴」处理）。
