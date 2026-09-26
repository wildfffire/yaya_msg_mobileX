import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Platform } from 'react-native';
import { PerfFlatList } from '../components/PerfFlatList';
import { Chat } from '@kesha-antonov/react-native-chat';
import { setLiveImmersiveMode } from '../native/LivePlayer';
import { deleteRoomMessage, observeRoomMessages, sendRoomTextMessage, type RoomLiveMessage } from '../services/pocketNim/qchat';
import { getNimSessionEpoch, subscribeNimSession } from '../services/pocketNim/session';
import { LiveBarrageBoard } from '../components/LiveBarrageBoard';
import { NetworkImage } from '../components/NetworkImage';
import { useLiveBarrage } from '../hooks/useLiveBarrage';
import DanmakuListSheet, { type DanmakuListEntry } from '../components/DanmakuListSheet';
import { DanmakuOverlay } from '../components/DanmakuOverlay';
import DanmakuSettingsSheet from '../components/DanmakuSettingsSheet';
import MemberReplaySheet, { findReplayLiveId, type MemberReplayItem } from '../components/MemberReplaySheet';
import { useIsLandscape } from '../hooks/useIsLandscape';
import { useDanmakuSettings } from '../store/danmakuSettings';
import { parseDanmaku, type DanmakuItem } from '../utils/danmaku';
import { isPipActive } from '../utils/pip';
import { useRoomUnreadStore } from '../services/roomUnread';
import { fetchMemberRadioUrl, isRtmpRadioUrl } from '../services/radio';
import { usePalette, radii, radiiAlias } from '../theme';
import { useResolvedTheme } from '../hooks/useAppTheme';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';

import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
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
import { BlurView } from 'expo-blur';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { followSystem } from '../utils/orientation';
import Video from 'react-native-video';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { useSettingsStore, useMemberStore, useUiStore } from '../store';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import { FadeInView, ScalePressable } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { Member, RoomMessage } from '../types';
import { formatDuration, formatTimestamp } from '../utils/format';
import { getReplayProgress, saveReplayProgress } from '../services/replayProgress';
import { findMediaDurationSeconds } from '../utils/mediaDuration';
import { useMiniPlayerStore } from '../store/miniPlayerStore';
import { usePlayerStore } from '../player/store/playerStore';
import { useOnMicStore } from '../store/onMicStore';
import {
  errorMessage,
  liveIdFromUrl,
  messagePayload,
  messageText,
  normalizeUrl,
  parseMaybeJson,
  pickText,
  unwrapList,
} from '../utils/data';
import { t, useI18n } from '../i18n';
import { logInfo } from '../utils/runtimeLog';
import pocketApi from '../api/pocket48';
import PlayerScreen from '../player';
import ZoomImageModal from '../components/ZoomImageModal';
import { enqueueDownload } from '../services/downloads';
import { memberSearchText } from '../utils/members';
import { getBgDisplayUri, ensureBgCached } from '../services/roomBgCache';
import { thumbUrl, AVATAR_THUMB_WIDTH } from '../utils/imageThumb';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { GlassSurface } from '../components/GlassSurface';
import { useBlurTarget } from '../components/BlurTarget';
import { GlassSegmented } from '../components/GlassSegmented';
type FollowedRoom = {
  memberId: string;
  member?: Member;
  lastMessage?: any;
  /** 小房间（yklzId）最新消息，与大房间分开显示 */
  lastSmallMessage?: any;
};

type RoomMode = 'big' | 'small';
type MediaType = 'audio' | 'video' | 'live' | 'image' | 'link';


type RoomMedia = {
  type: MediaType;
  url: string;
  title: string;
  duration?: string;
  liveId?: string;
  isLive?: boolean;
  needsVlc?: boolean;
  cover?: string;
  /** 消息/卡片已明示「回放/录播」：播放时应走可拖进度条的录播播放器，而非直播播放器 */
  replayHint?: boolean;
};

type SenderProfile = {
  id: string;
  name: string;
  avatar: string;
};

type MessageRole = 'idol' | 'mine' | 'fan';

const URL_REG = /(https?:\/\/[^\s"'<>，。！？、]+|rtmp:\/\/[^\s"'<>，。！？、]+)/gi;

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
  'audioUrl',
  'voiceUrl',
  'recordUrl',
  'mediaUrl',
  'filePath',
  'imageUrl',
  'imagePath',
  'picPath',
  'picturePath',
  'cover',
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
  'content.imageUrl',
  'content.imagePath',
  'content.picPath',
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
  'data.imageUrl',
  'data.imagePath',
  'data.picPath',
];

function shortName(member?: Member, fallback = '') {
  const raw = member?.ownerName || fallback || t('未知成员');
  return raw.replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/, '');
}

/** 房间消息气泡内嵌媒体播放器（统一 PlayerScreen）：
 *  音频 → 隐藏小容器；视频 → 按内容比例自适应高度（maxHeight 340，与旧 AdaptiveAspectVideo 一致） */
function RoomMediaPlayer({ media }: { media: RoomMedia }) {
  const [aspect, setAspect] = useState(16 / 9);
  const [boxW, setBoxW] = useState(0);
  const isAudio = media.type === 'audio';
  const height = isAudio ? 48 : boxW > 0 && aspect > 0 ? Math.min(boxW / aspect, 340) : 200;
  return (
    <View
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0) setBoxW(w);
      }}
      style={{
        height,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: isAudio ? 'transparent' : '#000',
        marginTop: 6,
      }}
    >
      <PlayerScreen
        inline
        source={{
          kind: isAudio ? 'audio' : 'vod',
          url: media.url,
          headers: { 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)', Referer: 'https://h5.48.cn/' },
        }}
        meta={{ title: media.title || '' }}
        onVideoSize={(w, h) => {
          if (w > 0 && h > 0) setAspect(w / h);
        }}
        persistent
      />
    </View>
  );
}

/** 通用文本限位（房间名等） */
function capText(text: string, max = 18) {
  const clean = (text || '').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function parseObject(value: any) {
  const parsed = parseMaybeJson(value);
  if (parsed && typeof parsed === 'object') return parsed;
  return {};
}

function extraInfo(item: any) {
  return parseObject(item?.extInfo);
}

function messageBody(item: any) {
  const body = messagePayload(item);
  return body && typeof body === 'object' ? body : {};
}

function firstTextFrom(objects: any[], paths: string[]) {
  for (const obj of objects) {
    const value = pickText(obj, paths);
    if (value) return value;
  }
  return '';
}

function deepFindText(value: any, keys: string[], depth = 0): string {
  if (!value || depth > 5) return '';
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindText(item, keys, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of keys) {
    const direct = value[key];
    if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct);
  }
  for (const child of Object.values(value)) {
    const found = deepFindText(child, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function collectUrls(value: any, result: string[] = [], depth = 0) {
  if (!value || depth > 6) return result;
  if (typeof value === 'string') {
    const matches = value.match(URL_REG) || [];
    matches.forEach((url) => result.push(normalizeUrl(url)));
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, result, depth + 1));
    return result;
  }
  if (typeof value === 'object') {
    const skipKeys = new Set(['avatar', 'headImg', 'headUrl', 'picPath', 'coverPath', 'coverUrl', 'avatarUrl', 'userAvatar', 'senderAvatar',
      // extInfo/msgExtInfo = 序列化元数据（module/channelRole/user 头像/bubbleId），其中 JSON 字符串会被正则
      // 捞出头像等非媒体 URL——徐钰涵公式照泄漏主因，一律跳过（真正的媒体在 body/已解析 ext 中另扫）
      'extInfo', 'msgExtInfo', 'extMsgInfo', 'attachInfo']);
    for (const [key, val] of Object.entries(value)) {
      if (skipKeys.has(key) && typeof val === 'string') continue;
      collectUrls(val, result, depth + 1);
    }
  }
  return result;
}

function senderProfile(item: any, room: Member): SenderProfile {
  if (!item) return { id: '', name: t('未知用户'), avatar: '' };
  const body = messageBody(item);
  // ⚠️ 只把 extraInfo 的 **user 段**当发送者资料（官方 getChannelBaseParams / 我们 buildChannelExt
  // 写入的都是发送者），不要把整个 ext 混进下面的字段查找 —— ext 里还有 replyInfo（被回复者）。
  // 桌面端 v2.13 followed-chat-feature.js:4082 同款：ext.user.roleId / userId / nickName / avatar。
  const extUser: any = ((extraInfo(item) as any)?.user) || {};
  const objects = [item, body];
  const id =
    firstTextFrom(objects, [
      'senderUserId',
      'senderId',
      'fromUserId',
      'fromAccount',
      'userId',
      'uid',
      'account',
      'sender.userId',
      'sender.id',
      'user.userId',
      'user.id',
      'message.userId',
      'message.senderId',
    ])
    || String(extUser.userId ?? extUser.id ?? '').trim()
    || deepFindText(objects, ['senderUserId', 'fromUserId', 'userId', 'uid']);
  const topName = firstTextFrom(objects, [
    'senderName',
    'senderNickName',
    'nickName',
    'nickname',
    'userName',
    'name',
    'fromNickName',
    'sender.nickName',
    'sender.nickname',
    'sender.name',
    'user.nickName',
    'user.nickname',
    'user.name',
    'message.nickName',
    'message.nickname',
  ]) || deepFindText(objects, ['nickName', 'nickname', 'senderName', 'userName', 'name']);
  // 名字/头像：ext.user 优先（桌面端就是用它覆盖顶层 senderName）——消息里带的最新昵称/头像比兜底更准
  const name = String(extUser.nickName || extUser.nickname || '').trim() || topName;
  const topAvatar = firstTextFrom(objects, [
    'avatar',
    'senderAvatar',
    'headImg',
    'headUrl',
    'sender.avatar',
    'sender.headImg',
    'user.avatar',
    'user.headImg',
    'userInfo.avatar',
    'userInfo.headImg',
    'message.avatar',
    'message.headImg',
  ]) || deepFindText(objects, ['senderAvatar', 'avatar', 'headImg', 'headUrl']); // 仅小头像字段，勿深扫 picPath 大图
  const avatar = normalizeUrl(String(extUser.avatar || '').trim() || topAvatar);

  return {
    id,
    name: name || (id ? t('用户 {id}', { id }) : t('未知用户')),
    avatar: avatar || '',
  };
}

function isIdolMessage(item: any, room: Member, includeFans: boolean) {
  // room 可能为空（房间切走/关闭时 chatRows 的 memo 仍可能重算）：不能直接读 room.id，否则整屏 CRASH
  if (!room) return false;
  const body = messageBody(item);
  const ext = extraInfo(item);
  const profile = senderProfile(item, room);
  const ownerIds = [room.id, (room as any).userId, (room as any).memberId].map(String).filter(Boolean);
  if (profile.id && ownerIds.includes(String(profile.id))) return true;
  // 已识别出发送者 ID 且不是房主（其他成员/粉丝在别人房间发言）：显示自己的名字，不套用房主身份
  if (profile.id) return false;
  // 拿不到发送者 ID：退回原来的判断逻辑
  if (!includeFans) return true;
  const role = firstTextFrom([item, ext, body], ['roleId', 'user.roleId', 'sender.roleId', 'message.roleId']);
  if (role && ['2', '3', '4', 'star', 'idol'].includes(String(role).toLowerCase())) return true;
  return false;
}

function currentUserIdFrom(res: any): string {
  return firstTextFrom([res?.content, res?.data, res], [
    'userInfo.userId',
    'userInfo.id',
    'user.userId',
    'user.id',
    'userId',
    'id',
    'account',
  ]);
}

function messageRole(
  item: any,
  room: Member,
  includeFans: boolean,
  currentUserId: string,
  memberIds?: Set<string>,
): MessageRole {
  if (!item) return 'fan';
  const profile = senderProfile(item, room);
  if (includeFans && currentUserId && profile.id && String(profile.id) === String(currentUserId)) return 'mine';
  if (isIdolMessage(item, room, includeFans)) return 'idol';
  // 其他成员（成员库里的成员，但不是本房房主）在别人房间发言 → 也算「成员消息」。
  // 用户要求：切到「成员消息」时，别的成员的消息不能被当成粉丝消息过滤掉。
  if (profile.id && memberIds && memberIds.has(String(profile.id))) return 'idol';
  return 'fan';
}

/** 成员库 id 集合（成员 id / userId / memberId 都可能出现在消息里） */
function buildMemberIdSet(members: any[]): Set<string> {
  const set = new Set<string>();
  (members || []).forEach((m: any) => {
    [m?.id, m?.userId, m?.memberId].forEach((v) => {
      const s = String(v ?? '').trim();
      if (s) set.add(s);
    });
  });
  return set;
}

/**
 * 「用户资料卡」信息解析。数据源 = `user/api/v1/user/info/home`（桌面端 fetchUserHomeInfo 同款：
 * Android 头 + `{ userId }` 数字）。结构（对齐桌面 getFollowedProfileContent）：
 *   content.userInfo.baseUserInfo = 头像/昵称…，content.starInfo = 成员信息（若是成员）。
 * 全部多路径兜底，取不到就留空（UI 只显示拿到的行，不再把原始报错文本糊上去）。
 */
function userCardFromUserRes(res: any) {
  const content = res?.content || res?.data?.content || res?.data || res || {};
  const userInfo = content?.userInfo || content?.user || content?.profile || content || {};
  const base = userInfo?.baseUserInfo || userInfo?.baseInfo || userInfo || {};
  const star = content?.starInfo || content?.memberInfo || userInfo?.starInfo || {};
  const objs = [base, userInfo, star, content];
  const pick = (keys: string[]) => firstTextFrom(objs, keys);
  // 关注态：对齐桌面端 followed-chat-feature.js 的取值口径
  //   relation / relationType / followStatus / friendStatus / isFollow / followed / isFriend
  //     mutual|both|friend|friends|2|3 → 互相关注；true|followed|following|1 → 已关注
  const relationValue = String(
    pick(['relation', 'relationType', 'followStatus', 'friendStatus', 'isFollow', 'followed', 'isFriend', 'relationship']) || '',
  ).trim().toLowerCase();
  const mutual = ['mutual', 'both', 'friend', 'friends', '2', '3'].includes(relationValue);
  const following = mutual || ['true', 'followed', 'following', '1'].includes(relationValue);
  return {
    name: pick(['nickName', 'nickname', 'userName', 'name', 'starName', 'realNickName', 'baseUserInfo.nickName']),
    avatar: normalizeUrl(pick(['avatar', 'avatarUrl', 'faceImage', 'headImg', 'headUrl', 'starAvatar'])),
    level: pick(['level', 'userLevel', 'grade', 'vipLevel', 'userLevelName']),
    signature: pick(['signature', 'sign', 'intro', 'description', 'userSignature']),
    team: pick(['starTeamName', 'teamName', 'team']),
    period: pick(['periodName', 'period']),
    isStar: !!(star && (star.starName || star.starId)) || base?.isStar === true || base?.star === true,
    following,
    mutual,
  };
}

function messageKey(item: any) {
  if (!item) return `empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const direct = item.id || item.msgId || item.messageId || item.clientMsgId || item.uuid || item.msgUuid;
  if (direct) return String(direct);
  const profile = senderProfile(item, {} as Member);
  const body = messageBody(item);
  const text = firstTextFrom([body, item], ['text', 'message', 'msgContent', 'content', 'bodys', 'body']);
  const media = firstTextFrom([body, item], ['url', 'fileUrl', 'pictureUrl', 'coverUrl', 'liveId']);
  // 注意：兜底键【不含 index】—— 同一消息在不同 list 中 index 不同会导致去重失败、重复累积。
  // 无稳定 id 时以 时间+发送者+内容 作近似键，足以区分不同消息并拦截同批重复。
  return String(`${getMessageTime(item)}-${profile.id || profile.name || ''}-${text || media || JSON.stringify(body).slice(0, 120)}`);
}

/** 已知的消息时间字段名（最先尝试，保持原行为） */
const KNOWN_TIME_KEYS = ['msgTime', 'messageTime', 'ctime', 'time'];

/** 值像「消息时间戳」才接受：归一后落在 2001-09 ~ 2096 之间（排除 liveId 这类 19 位超大 id） */
function asTimestamp(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ms = normMs(n);
  return ms >= 1e12 && ms <= 4e12 ? ms : 0;
}

/**
 * 取消息时间（返回**毫秒**，已由 normMs 归一）。
 *
 * ⚠️ 为什么写这么啰嗦：房间列表的「最新消息」来自
 * `/im/api/v1/team/classic/last/message/get`，该接口**官方没有字段文档**
 *（docs/API_RESEARCH.md 标注「未找到确切公开资料」），仓库里另一个消费者
 *（src/services/memberData.ts）也只读 serverId/channelId、不读时间。
 * 以前这里只赌 `msgTime | messageTime | ctime | time` 四个扁平键：
 * 一旦真实键名不同（sendTime/lastTime…）或时间藏在子对象里，就恒返回 0
 * → 未读判据 `lastActivity > lastRead` 永远不成立 → **房间「有新消息」永远不亮**。
 * 现在三层兜底，尽量不依赖猜：
 *   1) 已知扁平键
 *   2) 任意深度 ≤3 内、键名像时间的字段（取其中最大的时间戳 —— 消息自身的
 *      时间通常是整包里最新的时间）
 *   3) 一层子对象（message/lastMsg/content/body/data）里的已知键
 */
function getMessageTime(item: any): number {
  if (!item || typeof item !== 'object') return 0;
  // 1) 已知扁平键
  for (const key of KNOWN_TIME_KEYS) {
    const t = asTimestamp(item[key]);
    if (t) return t;
  }
  // 2) 键名像时间的字段（含嵌套），取最大值
  let best = 0;
  const scan = (node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 3) return;
    for (const [key, value] of Object.entries(node)) {
      if (/time|timestamp|date/i.test(key)) {
        const t = asTimestamp(value);
        if (t > best) best = t;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) scan(value, depth + 1);
    }
  };
  scan(item, 0);
  if (best) return best;
  // 3) 一层子对象里的已知键
  for (const holder of ['message', 'lastMsg', 'lastMessage', 'content', 'body', 'data']) {
    const child = item[holder];
    if (child && typeof child === 'object') {
      for (const key of KNOWN_TIME_KEYS) {
        const t = asTimestamp(child[key]);
        if (t) return t;
      }
    }
  }
  return 0;
}

function getNextTime(res: any, list: any[]): number {
  const direct = Number(firstTextFrom([res?.content, res?.data, res], ['nextTime', 'next', 'lastTime']));
  if (Number.isFinite(direct) && direct > 0) return direct;
  return 0;
}

// 诊断标记：undefined/null 元素究竟是「首次进入就带毒」还是「merge 累积污染」由这里打印栈标记区分
let __msgDiagTag = 'INIT';
function diagnoseUndefined(list: any[], tag: string) {
  if (!Array.isArray(list)) return;
  const bad = list
    .map((it, i) => (it == null ? i : -1))
    .filter((i) => i >= 0);
  if (bad.length) {
    // 真机/调试时可见：指出是哪个入口首次把 undefined 写进 roomMessages
    // eslint-disable-next-line no-console
    console.warn(`[msgDiag:${tag}] 检出 ${bad.length} 个 null/undefined 元素，下标=[${bad.slice(0, 20).join(',')}]`, {
      rawSample: list.slice(0, 5),
      stack: new Error().stack,
    });
  }
}

function mergeMessages(prev: RoomMessage[], next: RoomMessage[]) {
  // 根因防御：prev / next 任一含 undefined 都会「累积污染」整个聊天记录（之前只在外层 filter，
  // 但 prev 一旦带毒，后续 merge 永远带毒，最终在 renderChatItem 崩溃）。这里双端都过滤 + 诊断。
  const cleanPrev = prev.filter(Boolean);
  if (cleanPrev.length !== prev.length) diagnoseUndefined(prev, 'MERGE_PREV');
  const seen = new Set(cleanPrev.map((item) => messageKey(item)));
  const merged = [...cleanPrev];
  next.filter(Boolean).forEach((item) => {
    const key = messageKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return sortMessagesNewestFirst(merged);
}

function sortMessagesNewestFirst<T>(list: T[]): T[] {
  return list.slice().sort((a: any, b: any) => getMessageTime(b) - getMessageTime(a));
}

/**
 * 云信圈组实时消息 → 房间列表可渲染结构。
 *
 * 房间消息的「历史」来自 HTTP（im/api/v1/team/message/list/*），「实时」只有云信圈组
 * 一条通道（HTTP 无发送/无推送）。这里把原生桥回来的消息对齐成 HTTP 历史消息的字段形态，
 * 让既有的 renderChatItem / messageKey / mergeMessages 原样复用。
 */
function qchatToRoomMessage(msg: RoomLiveMessage): any {
  const user = (msg.ext?.user && typeof msg.ext.user === 'object' ? msg.ext.user : {}) as Record<string, any>;
  const nickName = String(user.nickName || user.nickname || msg.fromNick || '');
  return {
    uuid: msg.uuid,
    msgId: msg.uuid,
    msgTime: msg.time,
    time: msg.time,
    msgType: msg.messageType,
    // bodys 沿用 HTTP 消息的「JSON 体」形态：正文 + 类型 + 发送者
    bodys: {
      text: msg.text,
      messageType: msg.messageType,
      user: {
        userId: Number(user.userId || 0),
        nickName,
        avatar: String(user.avatar || ''),
        roleId: Number(user.roleId || 0),
      },
    },
    extInfo: msg.ext,
    fromUserId: Number(user.userId || 0),
    senderUserId: Number(user.userId || 0),
    senderName: nickName,
    nickName,
    userAvatar: String(user.avatar || ''),
    channelId: msg.channelId,
    serverId: msg.serverId,
    /** 标记来源：实时（用于排查），不影响渲染 */
    __live: true,
  };
}

/**
 * 大房间最新消息：只认 channelId===大房间 或 成员本人发言。
 * 注意不能按 serverId 兜底——小房间与大房间共用 serverId，兜底会把小房间消息冒充大房间预览。
 */
function findLastMessage(messages: any[], member?: Member) {
  if (!member) return null;
  const bigId = String(member.channelId || '');
  return messages.find((msg) => (
    (bigId && String(msg.channelId || '') === bigId)
    || String(msg.userId || msg.ownerId || '') === String(member.id || '')
  ));
}

/** 小房间（yklzId）最新消息：只认 channelId 精确匹配小房间 */
function findSmallLastMessage(messages: any[], member?: Member) {
  if (!member) return null;
  const ykid = String(member.yklzId || '');
  if (!ykid || ykid === '0' || ykid === 'undefined') return null;
  return messages.find((msg) => String(msg.channelId || '') === ykid)
    || null;
}

function roomChannelId(member: Member, mode: RoomMode) {
  return String(mode === 'small' ? (member.yklzId || '') : (member.channelId || ''));
}

/**
 * 时间戳归一（秒 → 毫秒）。
 * 不同接口的 msgTime / ctime 单位不一致（云信是 ms、部分官方接口是秒），
 * 直接比较会得出「永远早于上次已读」→ 未读永远不显示。
 */
function normMs(t: number): number {
  const n = Number(t) || 0;
  if (n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * 房间的「最后活动时间」：大房间/小房间两条最新消息里更晚的那个（统一成毫秒）。
 *
 * ⚠️ 字段口径必须与 `getMessageTime` 一致（`msgTime / messageTime / ctime / time`）——
 * 改造前这里只读 `msgTime || ctime`，而 `/team/classic/last/message/get` 的字段没有文档
 * （docs/API_RESEARCH.md 标注「未找到确切公开资料」）：万一实际用的是 `time`/`messageTime`，
 * 这里就会恒得 0 → 未读判据永远不成立。走统一 helper 就不会有第二个口径。
 *
 * 这个值同时是**未读基线**的写入值（进房 markRead / 首载 seedReadAt），
 * 所以它必须来自服务器的消息时间，绝不能混进设备时钟（见 roomUnread.ts 的时间域铁律）。
 */
function roomLastActivity(item: any): number {
  return Math.max(
    normMs(getMessageTime(item?.lastMessage)),
    normMs(getMessageTime(item?.lastSmallMessage)),
  );
}

/**
 * 房间「最新消息指纹」：把列表返回的一对最新消息（大房间 + 小房间）压成一个短字符串。
 *
 * ⚠️ 为什么需要指纹（用户反馈两次「房间列表无任何标注」的另一半原因）：
 * `/im/api/v1/team/classic/last/message/get` **官方没有字段文档**，仓库里另一个消费者
 * （src/services/memberData.ts）也只读 serverId/channelId、从不读时间 ——
 * 时间字段名一旦对不上，`最新消息时间 > 已读基线` 就恒为 false，角标永远不亮。
 * 指纹只判断「这条最新消息和上次看到的是不是同一条」：与字段名、时间格式、时区统统无关。
 *
 * 实现：递归收集消息对象里的**标量字段**（深度 ≤2，键名排序后拼接）。
 * 新消息到达时正文/时间/消息 id 必有变化 → 指纹变化 → 判为有新消息。
 */
function roomToken(item: any): string {
  const part = (msg: any) => {
    if (!msg || typeof msg !== 'object') return '';
    const flat: string[] = [];
    const walk = (node: any, path: string, depth: number) => {
      if (!node || typeof node !== 'object' || depth > 2) return;
      for (const key of Object.keys(node).sort()) {
        const value = node[key];
        if (value === null || value === undefined) continue;
        if (typeof value === 'object') { walk(value, `${path}.${key}`, depth + 1); continue; }
        flat.push(`${path}.${key}=${String(value)}`);
      }
    };
    walk(msg, '', 0);
    return flat.join('|');
  };
  const big = part(item?.lastMessage);
  const small = part(item?.lastSmallMessage);
  return big || small ? `${big}##${small}` : '';
}

/** 「直播中」索引里每个直播的可跳转信息（用于「点头像直接进她的直播」） */
export interface LiveEntry {
  liveId: string;
  title: string;
  cover: string;
}
export interface LiveNowIndex {
  ids: Set<string>;
  names: Set<string>;
  /** 多键索引：主播 userId / liveRoomId / account / 去前缀小写昵称 → 直播信息 */
  byOwner: Record<string, LiveEntry>;
}

/**
 * 从 `getLiveList` 结果构建「直播中」索引。
 * 三个字段各自有用途：
 *   - ids / names：判断某个关注成员是否在直播（原逻辑）
 *   - byOwner：拿到 liveId/title/cover，支持「点头像直接进她的直播」
 */
function buildLiveIndex(liveItems: any[]): LiveNowIndex {
  const ids = new Set<string>();
  const names = new Set<string>();
  const byOwner: Record<string, LiveEntry> = {};
  for (const it of liveItems) {
    const owner = String(it.userId || it.ownerId || it.memberId || it.userInfo?.userId || it.userInfo?.id || it.user?.userId || it.owner?.userId || it.memberInfo?.userId || it.hostId || it.account || '');
    const lr = String(it.liveRoomId || it.roomId || '');
    const nick = String(it.nickname || it.nickName || it.userInfo?.nickname || it.userInfo?.starName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/i, '').trim().toLowerCase();
    if (owner) ids.add(owner);
    if (lr) ids.add(lr);
    if (nick) names.add(nick);
    const liveId = String(it.liveId || it.id || '');
    if (!liveId) continue;
    const entry: LiveEntry = {
      liveId,
      title: String(it.title || it.liveTitle || (it.userInfo?.nickname || it.nickname || '') || ''),
      cover: String(it.coverPath || it.liveCover || it.cover || it.userInfo?.cover || ''),
    };
    for (const key of [owner, lr, nick]) if (key) byOwner[key] = entry;
  }
  return { ids, names, byOwner };
}

/**
 * 按成员从「直播中」索引里取直播信息。
 * 与房间行「点头像直接进她的直播」用的是**同一套多键查找**（userId / liveRoomId / account / 去前缀小写昵称），
 * 抽成函数是为了给「房间内直播的在线人数」复用（那里常常拿不到 liveId，需要按成员反查）。
 */
function liveEntryForMember(room: Member | null | undefined, index: LiveNowIndex): LiveEntry | undefined {
  if (!room) return undefined;
  const mid = String(room.id || '');
  const mroom = String((room as any).liveRoomId || '');
  const macct = String((room as any).account || '');
  const mnick = String(room.ownerName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/i, '').trim().toLowerCase();
  return index.byOwner[mid]
    || (mroom ? index.byOwner[mroom] : undefined)
    || (macct ? index.byOwner[macct] : undefined)
    || (mnick ? index.byOwner[mnick] : undefined);
}

function roomLabel(member: Member, mode: RoomMode) {
  return mode === 'small'
    ? t('小房间 {id}', { id: member.yklzId || t('未配置') })
    : t('大房间 {id}', { id: member.channelId || t('未配置') });
}

function streamScore(url: string, preferLive = false): number {
  const lower = url.toLowerCase();
  if (preferLive && lower.startsWith('rtmp://')) return 130;
  if (lower.includes('.m3u8') || lower.includes('format=hls')) return preferLive ? 100 : 90;
  if (lower.includes('.flv')) return preferLive ? 110 : 70;
  if (lower.startsWith('rtmp://')) return 60;
  if (/\.(mp4|mov)(\?|$)/i.test(lower)) return 80;
  if (/\.(mp3|m4a|aac|amr|wav)(\?|$)/i.test(lower)) return 80;
  return 40;
}

function pickPlayableUrls(raw: any, preferLive = false): string[] {
  const candidates: string[] = [];
  const direct = normalizeUrl(pickText(raw, PLAY_URL_FIELDS));
  if (direct) candidates.push(direct);
  const nested = unwrapList(raw, [
    'streams',
    'playStreams',
    'liveStreams',
    'urls',
    'content.streams',
    'content.playStreams',
    'content.liveStreams',
    'content.streamList',
    'content.playStreamList',
    'content.urls',
    'data.streams',
    'data.playStreams',
    'data.liveStreams',
    'data.streamList',
    'data.playStreamList',
    'data.urls',
  ]);
  nested.forEach((item) => {
    const url = normalizeUrl(pickText(item, PLAY_URL_FIELDS));
    if (url) candidates.push(url);
  });
  collectUrls(raw).forEach((url) => candidates.push(url));
  return Array.from(new Set(candidates.filter(Boolean))).sort((a, b) => streamScore(b, preferLive) - streamScore(a, preferLive));
}

function extractLiveIdFromText(value: any): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {}
  const text = `${raw} ${decoded}`;
  return String(
    text.match(/[?&](?:liveId|liveid|live_id)=([0-9]+)/i)?.[1]
    || text.match(/[?&](?:id|live)=([0-9]{5,})/i)?.[1]
    || text.match(/(?:liveId|liveid|live_id)["'\s:=]+([0-9]+)/i)?.[1]
    || text.match(/\/(?:live|playback|record|replay)\/([0-9]+)/i)?.[1]
    || '',
  );
}

function isPlayableMediaUrl(url: string) {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://')
    || lower.includes('.m3u8')
    || lower.includes('.flv')
    || /\.(mp4|mov|m4v|3gp|mp3|m4a|aac|amr|wav)(\?|$)/i.test(lower)
    || lower.includes('playstream')
    || lower.includes('stream');
}

function streamNeedsProxy(url: string): boolean {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://') || lower.includes('.flv');
}

function isLiveStreamUrl(url: string): boolean {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://') || lower.includes('.flv') || lower.includes('.m3u8');
}

/**
 * 房间点击判「是否录播（可拖进度 vod）」。事实：
 * - 房间消息条目（roomMedia）同步构建、不带 isLive 标记；回放地址常见 HLS(.m3u8)/FLV 形态，
 *   若把 .m3u8 一律当直播流，消息里的录播卡就全部套上直播播放器（无进度条）——本 bug 根因。
 * - rtmp/flv 推流只可能是直播；消息明示回放(replayHint)即使 rtmp/flv 也按录播。
 * - m3u8/mp4 二义：仅当明确带 isLive 标记（直播列表 record:false 命中 / 详情状态位）才直播，否则录播。
 */
function roomTapIsVod(next: RoomMedia): boolean {
  if (next.replayHint) return true;
  const u = String(next.url || '').toLowerCase();
  if (u.startsWith('rtmp://') || u.includes('.flv')) return false;
  return !next.isLive;
}

/** 直播/回放列表短缓存：同一房间短时间内的多次「抓流比对」只打一次接口 */
const LIVE_LIST_CACHE_TTL = 40 * 1000;
const liveListCache: Record<string, { t: number; res: any }> = {};
async function cachedLiveList(record: boolean, page = 0, next = 0): Promise<any> {
  const key = `r:${record ? 1 : 0}:p:${page}:n:${next}`;
  const hit = liveListCache[key];
  if (hit && Date.now() - hit.t < LIVE_LIST_CACHE_TTL) return hit.res;
  const res = await pocketApi.getLiveList({ record, debug: true, page, next });
  liveListCache[key] = { t: Date.now(), res };
  return res;
}

/** 从已拉取的直播/录播详情判断当前状态。
 *  口袋 48 接口的事实字段：录播详情带 content.msgFilePath / content.lrcUrl（LRC 弹幕文件，
 *  见 pocket48.getLiveLrc 的既有用法），直播详情带 isLiving / living / isEnd 等状态位。
 *  无法确定时返回 'unknown'，交由上层按 URL 形态兜底。 */
function detailLiveState(detail: any): 'live' | 'replay' | 'unknown' {
  const d = detail?.content || detail?.data || detail || {};
  if (d.isLiving === true || d.living === true || d.isLive === true) return 'live';
  if (d.isLiving === false || d.living === false || d.isLive === false
    || d.isEnd === true || d.isEnded === true || d.isFinished === true
    || d.isRecord === 1 || d.isRecord === true || d.record === 1 || d.record === true
    || d.isReplay === 1 || d.isReplay === true || d.isPlayback === true
    || Boolean(d.msgFilePath) || Boolean(d.lrcUrl)) return 'replay';
  return 'unknown';
}

function isRawJsonText(value: string) {
  const text = String(value || '').trim();
  return (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'));
}

function findLiveItem(listRes: any, liveId: string) {
  const list = unwrapList(listRes, [
    'content.liveList',
    'content.list',
    'content.data',
    'data.liveList',
    'data.list',
    'liveList',
    'list',
  ]);
  return list.find((item: any) => String(item.liveId || item.id || item.live_id || '') === String(liveId));
}

async function resolveRoomLiveMedia(media: RoomMedia): Promise<RoomMedia> {
  const liveId = String(media.liveId || extractLiveIdFromText(media) || '');
  const title = media.title || t('直播 / 录播');
  // 消息里已带可播放地址：直接返回，不再请求任何接口（直播分享/录播卡片通常自带 URL）
  const ownUrl = isPlayableMediaUrl(media.url) ? media.url : '';
  if (ownUrl) {
    const lower = ownUrl.toLowerCase();
    const isRtmp = lower.startsWith('rtmp://') || lower.includes('.flv');
    if (isRtmp) {
      // rtmp/flv 推流只可能是直播
      return { ...media, liveId, title, url: ownUrl, isLive: true, needsVlc: streamNeedsProxy(ownUrl) };
    }
    if (media.replayHint) {
      // 消息明示回放（录播卡）
      return { ...media, liveId, title, url: ownUrl, isLive: false, needsVlc: streamNeedsProxy(ownUrl) };
    }
    // m3u8/mp4 二义：默认按「回放」（录播可拖进度条）；直播列表(record:false)命中才视为直播。
    // 直播(rtmp/flv) 已在上方直接返回 live；Exo 直播状态已修复可正常出画面，因此不再为防黑屏牺牲录播判定
    let isLive = false;
    if (liveId) {
      try {
        const found = await findLiveItem(await cachedLiveList(false, 0, 0), liveId);
        isLive = !!found;
      } catch {
        isLive = false; // 查询失败按回放处理（录播优先，进度条可用；真直播多为 rtmp/flv 不受影响）
      }
    }
    return { ...media, liveId, title, url: ownUrl, isLive, needsVlc: streamNeedsProxy(ownUrl) };
  }
  const attempts: Array<{ label: 'live' | 'replay' | 'detail'; run: () => Promise<any> }> = [];
  if (liveId) {
    attempts.push({ label: 'detail', run: () => pocketApi.getLiveOne(liveId) });
    attempts.push({ label: 'detail', run: () => pocketApi.getOpenLiveOne(liveId) });
    attempts.push({ label: 'live', run: async () => findLiveItem(await cachedLiveList(false, 0, 0), liveId) });
    attempts.push({ label: 'replay', run: async () => findLiveItem(await cachedLiveList(true, 0, 0), liveId) });
    attempts.push({ label: 'replay', run: async () => findLiveItem(await pocketApi.getOpenLivePublicList({ record: true, next: 0 }), liveId) });
  }
  // 并行发起全部候选接口，按优先级取第一个出 URL 的结果；
  // 原来 6 个接口串行（最坏每个 15s 超时），是「解析卡死、第一次点击无响应」的根因。
  const ATTEMPT_TIMEOUT = 4000;
  const settled = await Promise.allSettled(
    attempts.map((attempt) => Promise.race([
      attempt.run(),
      new Promise<any>((resolve) => setTimeout(() => resolve(null), ATTEMPT_TIMEOUT)),
    ])),
  );
  // 先分辨直播还是录播，再决定播放器：
  // 回放列表（record:true）命中的结果确定是录播，优先采用；
  // 其余（正在直播列表 / 详情）按接口状态位或 URL 形态兜底判断，避免把回放流误当直播播放。
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < attempts.length; i += 1) {
      if ((pass === 0) !== (attempts[i].label === 'replay')) continue;
      const result = settled[i];
      if (result.status !== 'fulfilled' || !result.value) continue;
      const detail = result.value;
      const urls = pickPlayableUrls(detail, true).filter(isPlayableMediaUrl);
      if (urls[0]) {
        const d = detail?.content || detail?.data || detail || {};
        const cover = normalizeUrl(
          d.liveCover || d.coverPath || d.cover || d.coverUrl || d.picPath || d.liveRoomCover || ''
        ) || media.cover;
        let isLive: boolean;
        if (attempts[i].label === 'replay') {
          isLive = false;
        } else if (attempts[i].label === 'live') {
          isLive = true;
        } else {
          const state = detailLiveState(detail);
          if (state === 'replay') isLive = false;
          else if (state === 'live') isLive = true;
          else {
            // 详情无明确状态位：rtmp/flv 视为直播；m3u8/mp4 一律按回放（录播可拖，防录播套直播控件）
            const u0 = String(urls[0] || '').toLowerCase();
            isLive = u0.startsWith('rtmp://') || u0.includes('.flv');
          }
        }
        return {
          ...media,
          type: 'live',
          liveId,
          title,
          url: urls[0],
          cover,
          isLive,
          needsVlc: streamNeedsProxy(urls[0]),
        };
      }
    }
  }
  return { ...media, liveId, title, url: ownUrl, isLive: isLiveStreamUrl(ownUrl), needsVlc: streamNeedsProxy(ownUrl) };
}

/**
 * 解析直播地址 + 瞬时失败自动重试：首轮全部候选接口都拿不到地址、且是「快速失败」
 * （网络抖动/接口偶发 500，几秒内就结束）时，稍候 600ms 整轮重试一次。
 * 若首轮是慢超时（已等满 5s+）则不再重试——慢网重试无意义，避免把点击拖成 20s。
 */
async function resolveRoomLiveMediaWithRetry(media: RoomMedia): Promise<RoomMedia> {
  const started = Date.now();
  const first = await resolveRoomLiveMedia(media);
  if (first.url) return first;
  if (Date.now() - started > 2500) return first;
  await new Promise((resolve) => setTimeout(resolve, 400));
  return resolveRoomLiveMedia(media);
}

function classifyMedia(url: string, msgType: string, text: string): MediaType {
  const lower = `${url} ${msgType} ${text}`.toLowerCase();
  // 先按明确扩展名判定（最高优先级）：避免 url 里含 "live" 字样的普通 .mp4/.m3u8 视频被误判成直播。
  if (/\.(mp4|mov|m4v|3gp)(\?|$)/i.test(url)) return 'video';
  if (/\.(m3u8|flv|ts)(\?|$)/i.test(url) || lower.startsWith('rtmp://')) return 'live';
  if (/\.(mp3|m4a|aac|amr|wav)(\?|$)/i.test(url)) return 'audio';
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url) || lower.includes('image') || lower.includes('expressimage')) return 'image';
  // 扩展名兜底后再按关键字判定（live/playback/record/replay 等无扩展名场景）
  if (lower.includes('live') || lower.includes('playback') || lower.includes('record') || lower.includes('replay')) return 'live';
  if (lower.includes('voice') || lower.includes('audio')) return 'audio';
  if (lower.includes('video')) return 'video';
  return 'link';
}

// 诊断：收集媒体消息里所有「疑似时长」的数字字段，用于定位真实 duration 字段名。
// 仅在 duration 取不到（返回空）时打印；限频每 30s 最多一次。
// 注意：release 包也打印（去掉 __DEV__ 守卫），便于真机实跑反馈音频时长字段名；低频无碍。
const __diagThrottle: { last: number } = { last: 0 };
function diagDurationFields(label: string, sources: any[]) {
  const now = Date.now();
  if (now - __diagThrottle.last < 30000) return;
  __diagThrottle.last = now;
  const candidates: Record<string, any> = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (!/duration|time|length|second|ms$/i.test(k)) continue;
      if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
        candidates[k] = v;
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[diag:duration:${label}] candidates=`, JSON.stringify(candidates), 'type=', String(sources[0]?.msgType || ''));
}

function roomMedia(item: any): RoomMedia | null {
  if (!item) return null;
  const body = messageBody(item);
  const ext = extraInfo(item);
  const text = messageText(item);
  const msgType = String(item.msgType || item.extMsgType || body.msgType || body.extMsgType || '').toUpperCase();
  if (msgType.includes('GIFT') || String(item.msgType) === '7') return null;

  if (msgType === 'EXPRESSIMAGE' || msgType === 'EXPRESS') {
    const exprUrl = normalizeUrl(body?.expressImgInfo?.emotionRemote || body?.url || '');
    if (exprUrl) return { type: 'image' as const, url: exprUrl, title: t('表情') };
  }

  const liveId = firstTextFrom([item, ext, body], [
    'liveId',
    'liveid',
    'live_id',
    'message.liveId',
    'msg.liveId',
    'content.liveId',
    'data.liveId',
  ]) || deepFindText([item, ext, body], ['liveId', 'liveid', 'live_id']) || extractLiveIdFromText([item, ext, body, text]);
  const urls = pickPlayableUrls([item, ext, body], !!liveId || msgType.includes('LIVE'));
  let url = urls[0] || '';
  // Fallback: try collecting all URLs from parsed media containers.
  // ⚠️ 不再扫描原始 item：其中 extInfo 是序列化 JSON 字符串，正则会把 ext.user.avatar
  // （成员公式照等）误当图片附件——徐钰涵每条文字消息带公式照的根因。
  // ext 已 parseObject（avatar/headImg/picPath 等键被 collectUrls 跳过），body 是消息正文，
  // 两者都不会泄漏头像。
  if (!url && !liveId) {
    const allUrls: string[] = [];
    collectUrls(ext, allUrls);
    collectUrls(body, allUrls);
    url = allUrls.find(u => u && /^https?:\/\//i.test(u)) || '';
  }
  // Fallback: if still no url but body/text itself contains a URL (typed link), use it
  if (!url && !liveId) {
    const rawUrls: string[] = [];
    collectUrls(ext, rawUrls);
    collectUrls(body, rawUrls);
    const textMatch = String(text || '').match(/(https?:\/\/[^\s]+)/i);
    if (textMatch) rawUrls.push(textMatch[1]);
    url = rawUrls.find(u => u && /^https?:\/\//i.test(u)) || '';
  }
  // Still no URL? Check if text IS a media indicator
  if (!url && !liveId) {
    const t = String(text || '').toLowerCase();
    if (t.includes('[图片]') || t.includes('[语音]') || t.includes('[视频]') || t.includes('[链接]') || t.includes('[直播]')) {
      // Y20: 占位文本不是可播放媒体——return null 走普通文本气泡，
      // 不再把 '[图片]'/'[直播]' 当 url（此前 classifyMedia 后渲染成破图/误调 Linking）
      return null;
    }
  }
  if (!url && !liveId) return null;
  const type = liveId ? 'live' : classifyMedia(url, msgType, text);
  const durationSec = [item, ext, body].reduce((best, src) => best || findMediaDurationSeconds(src), 0);
  const duration = durationSec > 0 ? String(Math.round(durationSec)) : '';
  // 诊断：audio/video 取不到时长时，dump 真实字段名（DEV 限频）
  if ((type === 'audio' || type === 'video') && !duration) {
    diagDurationFields(type, [item, ext, body]);
  }
  // Audio/video 在房间里只用两个字前缀，避免「语音 语音消息」这种重复；live 保留完整标签
  const title = type === 'audio' ? t('语音')
    : type === 'video' ? t('视频')
    : type === 'live' ? t('直播 / 录播')
    : type === 'image' ? t('图片')
    : text && !text.startsWith('[') && text !== url ? text
    : t('链接');
  // 封面：对齐电脑版 _ref_yk1z —— 优先用服务端关键帧缩略图 thumbPath（口袋48给视频/音频的关键帧图），
  // 拼 https://source.48.cn 前缀（thumbPath 是相对路径，normalizeUrl 不会拼，需单独处理）。
  // 退而求其次再用 coverUrl/coverPath/cover/liveCover/picPath 等绝对地址字段。
  const rawCover = firstTextFrom([item, ext, body], [
    'thumbPath', 'coverUrl', 'coverPath', 'cover', 'liveCover', 'picPath', 'picturePath', 'imageUrl', 'poster',
    'videoCover', 'videoPoster', 'thumbnail', 'thumbUrl',
    'message.coverUrl', 'message.cover', 'content.coverUrl', 'data.coverUrl',
  ]) || deepFindText([item, ext, body], [
    'thumbPath', 'coverUrl', 'cover', 'liveCover', 'picPath', 'coverPath', 'imageUrl', 'poster', 'thumb',
  ]) || '';
  let cover = '';
  if (rawCover) {
    const s = String(rawCover).trim();
    if (/^https?:\/\//i.test(s)) cover = normalizeUrl(s);
    else if (s.startsWith('/')) cover = `https://source.48.cn${s}`;
    else if (!s.startsWith('[')) cover = normalizeUrl(s); // 非占位文本
  }
  // 封面字段已在上方优先 thumbPath/cover 等绝对地址字段；fix7u 已确认服务端对房间视频消息不回独立 cover 字段
  // （fix7t 的 [diag:cover2] 全量扫描证明 finalCover 恒为空，仅 ext.user.avatar 误命中），故无 cover 时一律走首帧。

  // 消息/卡片本身已明示「回放/录播」时，播放器应走「可拖进度条的录播模式」，
  // 而不是仅凭 .flv/.m3u8 后缀误判成直播（回放地址常见 HLS/FLV 形态）。
  const replayHint = !!(msgType.match(/RECORD|PLAYBACK|VOD|REPLAY|回放/)
    || /(回放|录播|replay|playback)/i.test(`${String(text || '')} ${String(body?.title || '')} ${String(body?.content || '')} ${String(body?.desc || '')} ${String(item?.title || '')}`)
    || /(replayUrl|playbackUrl|recordUrl|\/replay\/|\/record\/|\/playback\/)/i.test(`${url} ${String(body?.replayUrl || '')} ${String(body?.playbackUrl || '')} ${String(body?.recordUrl || '')}`));
  const mediaResult = { type, url, title, duration, liveId, cover, replayHint };
  return mediaResult;
}


function roomGiftInfo(item: any): { name: string; num: number; image: string; total: string } | null {
  if (!item) return null;
  const body = messageBody(item);
  const ext = extraInfo(item);
  const msgType = String(item.msgType || item.extMsgType || body.msgType || body.extMsgType || body.messageType || '').toUpperCase();
  const giftReplyInfo = body.giftReplyInfo || ext.giftReplyInfo || {};
  const giftInfo = body.giftInfo || giftReplyInfo.giftInfo || ext.giftInfo || item.giftInfo || null;
  if (!giftInfo && !msgType.includes('GIFT') && String(item.msgType) !== '7') return null;
  if (msgType.includes('LIVE') && !giftInfo) return null;
  const source = giftInfo || giftReplyInfo || body;
  const name = firstTextFrom([giftInfo, giftReplyInfo, body], ['giftName', 'replyName', 'name']) || t('礼物');
  const num = Number(firstTextFrom([giftInfo, giftReplyInfo, body], ['giftNum', 'replyNum', 'num', 'count']) || '1') || 1;
  const image = normalizeUrl(firstTextFrom([giftInfo, giftReplyInfo, body], ['picPath', 'giftPic', 'image', 'icon']));
  const money = Number(firstTextFrom([giftInfo, giftReplyInfo, body], ['money', 'replyMoney', 'cost', 'price']) || '0') || 0;
  return { name, num, image, total: money ? t('{count} 鸡腿', { count: money * num }) : '' };
}

function mediaLabel(type: MediaType) {
  if (type === 'audio') return '\u8bed\u97f3';
  if (type === 'video') return '\u89c6\u9891';
  if (type === 'live') return '\u76f4\u64ad';
  if (type === 'image') return '\u56fe\u7247';
  return '\u94fe\u63a5';
}

// 限频诊断日志：同 key 在 intervalMs 内只打印一次，便于在 release 包观察真实数据而不刷屏
const __diagStamps: Record<string, number> = {};
function __diagStamp(key: string, intervalMs: number): boolean {
  const now = Date.now();
  if (__diagStamps[key] && now - __diagStamps[key] < intervalMs) return false;
  __diagStamps[key] = now;
  return true;
}

function playerSource(url: string) {
  // 与小窗 MiniPlayer 完全一致的防盗链 headers（含 Origin）——fix7u：统一播放器配置，消除封面/放大视频与小窗的方向差异
  return {
    uri: url,
    headers: {
      'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
      Referer: 'https://h5.48.cn/',
      Origin: 'https://h5.48.cn',
    },
  };
}

// 自适应宽高比的视频容器：监听 react-native-video onLoad 取 naturalSize，
// 用真实宽高比驱动容器 aspectRatio，避免硬编码高度把竖屏 9:16 / 横屏 16:9 / 方屏 1:1 视频全部压扁或上下拉黑出现"上下两条"。
// - 默认 16:9，避免第一帧 onLoad 之前视觉塌陷
// - maxHeight 防止异常长方形视频挤爆消息气泡
// - borderRadius / backgroundColor 与 inlineVideo 旧样式一致
//     ExoPlayer 解析的真实 duration（秒）回填角标。探测 Video 不显示画面，不受旋转影响。
function VideoCoverCard({ media, onPress, onLongPress }: { media: RoomMedia; onPress: () => void; onLongPress: () => void }) {
  const palette = usePalette();
  const [resolvedDur, setResolvedDur] = useState(media.duration || '');
  const [coverError, setCoverError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const hasCover = !!media.cover && !coverError;
  // 封面（fix7y 回退）：放弃自动播放/方向修正实验，恢复原始静止首帧封面（paused <Video> 首帧 + 灰占位过渡态）。
  // 服务端不回独立封面字段这一事实未变，且 Android ExoPlayer 对带方向元数据的视频在暂停首帧下会镜像——
  // 用户确认「修不好」，故回退到「有画面、静止、不播放」的原始行为，不再尝试修正方向。
  return (
    <TouchableOpacity style={styles.videoCoverWrap as any} onPress={onPress} onLongPress={onLongPress} activeOpacity={0.9}>
      {hasCover ? (
        <Image
          source={{ uri: media.cover }}
          style={styles.videoCoverImg as any}
          resizeMode="cover"
          onError={() => setCoverError(true)}
        />
      ) : (
        <View style={styles.videoCoverImg as any}>
          <Video
            source={playerSource(media.url)}
            style={StyleSheet.absoluteFill}
            paused
            controls={false}
            resizeMode="cover"
            muted
            playWhenInactive={false}
            playInBackground={false}
            onLoad={() => setLoaded(true)}
          />
          {!loaded ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.fill2, alignItems: 'center', justifyContent: 'center' }]}>
              <MaterialCommunityIcons name="play-circle-outline" size={40} color={palette.labelTertiary} />
            </View>
          ) : null}
        </View>
      )}
      <View style={styles.videoCoverOverlay}>
        <View style={styles.livePlayCircle}>
          <MaterialCommunityIcons name="play" size={22} color="#FFFFFF" style={{ marginLeft: 3 }} />
        </View>
      </View>
      {resolvedDur ? (
        <View style={styles.videoCoverDuration}>
          <Text style={styles.videoCoverDurationText}>{resolvedDur}s</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

// 直播/录播封面图：加载失败（source.48.cn 移动端偶发被拒）时回退灰底，避免破图/空白块
function LiveCoverImage({ uri, palette }: { uri: string; palette: any }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.fill2, alignItems: 'center', justifyContent: 'center' }]}>
        <MaterialCommunityIcons name="play-circle-outline" size={34} color={palette.labelTertiary} />
      </View>
    );
  }
  return (
    <NetworkImage
      source={{ uri }}
      style={styles.liveCardImg}
      resizeMode="cover"
      onError={() => setErr(true)}
      thumbnail={700}
    />
  );
}

// 音频消息卡片。消息体里没有 duration 字段（实测只有 msgTime 时间戳），时长只能靠播放器解析。
// 内部用隐藏探测 Video（1px 透明、不可见）拿 ExoPlayer 真实 duration 回填角标，与 VideoCoverCard 同机制。
function AudioMediaCard({
  media, palette, onPlay, onLongPress, playing,
}: {
  media: RoomMedia; palette: any;
  onPlay: () => void; onLongPress: () => void; playing: boolean;
}) {
  const [resolvedDur, setResolvedDur] = useState(media.duration || '');
  const card = (
    <TouchableOpacity
      // 语音播放卡玻璃化（用户要求，2026-09-19）：任何人（含房主/自己）一律 GlassSurface，
      // 与房间文本气泡同语言；此前「idol/mine 粉实底」分支让房主语音卡与深色气泡割裂，已废
      style={[styles.mediaCard, { backgroundColor: 'transparent', borderWidth: 0, marginTop: 0 }]}
      activeOpacity={0.92}
      onLongPress={onLongPress}
    >
      {media.cover ? (
        <NetworkImage source={{ uri: media.cover }} style={styles.liveCover} resizeMode="cover" thumbnail={700} />
      ) : null}
      <View style={styles.mediaMeta}>
        <Text style={[styles.mediaIcon, { color: palette.tint }]}>{t(mediaLabel(media.type))}</Text>
        {media.type !== 'audio' && media.type !== 'video' && media.title ? (
          <Text style={[styles.mediaTitle, { color: palette.label }]} numberOfLines={2}>{media.title}</Text>
        ) : null}
        {resolvedDur ? <Text style={[styles.mediaDuration, { color: palette.labelSecondary }]}>{resolvedDur}s</Text> : null}
      </View>
      <TouchableOpacity
        style={[styles.mediaPlayBtn, { backgroundColor: palette.tint, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }]}
        onPress={onPlay}
        activeOpacity={0.85}
      >
        <MaterialCommunityIcons
          name={playing ? 'pause' : 'play'}
          size={14}
          color={palette.onTint}
        />
        <Text style={[styles.mediaPlayText, { color: palette.onTint }]}>
          {playing ? t('暂停') : resolvedDur ? `${resolvedDur}s` : t('播放')}
        </Text>
      </TouchableOpacity>
      {/* 隐藏探测 Video：仅用于拿真实时长，不渲染可见画面 */}
      <Video
        source={playerSource(media.url)}
        style={{ width: 1, height: 1, opacity: 0, position: 'absolute', top: -9999, left: -9999 }}
        paused
        controls={false}
        resizeMode="cover"
        muted
        onLoad={(data: any) => {
          const d = Number(data?.duration || 0);
          if (d > 0) setResolvedDur(String(Math.round(d)));
        }}
      />
    </TouchableOpacity>
  );
  return (
    <GlassSurface radius={14} role="card" style={{ marginTop: 8, alignSelf: 'flex-start' }}>
      {card}
    </GlassSurface>
  );
}

function normalizeLiveRank(res: any): any[] {
  let list = unwrapList(res, [
    'content.rankList',
    'content.userRankList',
    'content.userRankingList',
    'content.contributionList',
    'content.list',
    'content.data',
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
  return list.map((item: any, index: number) => ({
    ...item,
    userId: pickText(item, ['userId', 'uid', 'id', 'account', 'userInfo.userId', 'userInfo.id', 'user.userId', 'user.id', 'user.userIdStr', 'memberInfo.userId', 'memberInfo.id']),
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
    ], t('用户 {id}', { id: index + 1 })),
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

function avatarInitial(name: string) {
  return (name || t('用')).trim().slice(0, 1).toUpperCase();
}

// 时长归一逻辑：详见 src/utils/mediaDuration.ts（findMediaDurationSeconds）。
// 该工具按字段名区分秒/毫秒，过滤掉「time」「seconds」等与时长无关的宽泛字段。

export default function FollowedRoomsScreen() {
  const palette = usePalette();
  /** 模糊背板（房间工具条的 BlurView 需要它才有真模糊） */
  const blurTarget = useBlurTarget();
  const resolvedTheme = useResolvedTheme();
  const { t } = useI18n();
  const token = useSettingsStore((state) => state.settings.p48Token);
  const setTabBarHidden = useUiStore((state) => state.setTabBarHidden);
  const showToast = useUiStore((state) => state.showToast);
  const setScreenBackdrop = useUiStore((state) => state.setScreenBackdrop);
  const navigation = useNavigation<any>();
const route = useRoute<any>();
  const members = useMemberStore((state) => state.members);
  // 成员库 id 集合：「成员消息」视图要把别的成员（非房主）也算成员消息（用户要求）
  const memberIdSet = useMemo(() => buildMemberIdSet(members), [members]);
  const onMicMap = useOnMicStore((state) => state.onMic);
  const [followed, setFollowed] = useState<FollowedRoom[]>([]);
  const followedRef = useRef<FollowedRoom[]>([]);
  followedRef.current = followed;
  const [followedLoading, setFollowedLoading] = useState(false);
  // 直播状态：ids=直播中主播 id 集合，names=直播中昵称集合（接口字段不一，昵称兜底）
  const [liveNow, setLiveNow] = useState<LiveNowIndex>({ ids: new Set(), names: new Set(), byOwner: {} });
  const [pinned, setPinned] = useState<string[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<Member | null>(null);
  const [roomMessages, setRoomMessages] = useState<RoomMessage[]>([]);
  // 持有一份最新 roomMessages 引用，供 refreshRoomMessages 预判「是否有新消息」而无需把 roomMessages 列入 deps（避免定时器频繁重建）
  const roomMessagesRef = useRef<RoomMessage[]>([]);
  roomMessagesRef.current = roomMessages;
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
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [roomSearchQuery, setRoomSearchQuery] = useState('');
  const [roomSearchOpen, setRoomSearchOpen] = useState(false);
  const [roomMode, setRoomMode] = useState<RoomMode>('big');
  const [showFanMessages, setShowFanMessages] = useState(false);
  const [playingMedia, setPlayingMedia] = useState<RoomMedia | null>(null);
  const [roomNextTime, setRoomNextTime] = useState(0);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  // 房间内展示：房间名（channelInfo.channelName）+ 背景图（channelInfo.bgImg）
  const [roomMeta, setRoomMeta] = useState<{ name: string; bg: string }>({ name: '', bg: '' });
  const roomMetaCache = useRef<Record<string, { name: string; bg: string }>>({});
  // 背景图渐显：新背景 uri 变化时重置为 0，ImageBackground onLoad 后淡入到 1，消除「从无到有硬跳变」
  /**
   * 背景图 **双层常驻 crossfade**（用户反馈：大小房间切换底图会闪一下）。
   *
   * 旧做法「新图新挂载一层 + 旧图垫底」的问题是：新挂载的 Image 首帧必然空白
   * （哪怕图在磁盘缓存，解码也要 1-2 帧），垫底层反而来不及兜 → 还是闪。
   *
   * 标准做法：A/B 两层**永远挂载**，换图时把新 uri 写进**当前隐藏的那一层**
   * （隐藏层保留着旧帧，不会白屏），等它 onLoad（解码完成）后两层交叉淡入淡出。
   * 同一张图则什么都不做 —— 对同一 uri 归零 opacity 就是「闪一下」的直接来源。
   */
  const bgOpacityA = useRef(new Animated.Value(0)).current;
  const bgOpacityB = useRef(new Animated.Value(0)).current;
  const [bgLayerA, setBgLayerA] = useState('');
  const [bgLayerB, setBgLayerB] = useState('');
  /** 槽位 uri 镜像 ref：setState 同值不会重渲染/onLoad，必须用 ref 判断「槽里已是什么」 */
  const bgLayerARef = useRef('');
  const bgLayerBRef = useRef('');
  const setBgLayer = (slot: 'A' | 'B', uri: string) => {
    if (slot === 'A') { bgLayerARef.current = uri; setBgLayerA(uri); }
    else { bgLayerBRef.current = uri; setBgLayerB(uri); }
  };
  const bgTopIsARef = useRef(true);
  const bgLastUriRef = useRef('');
  /** 待淡入的槽位（该槽 onLoad 后执行交叉淡入淡出） */
  const bgPendingFadeRef = useRef<'A' | 'B' | null>(null);

  /** 交叉淡入淡出：target 槽 0→1（280ms），另一槽延迟归 0；翻转顶层标记 */
  const crossfadeTo = useCallback((slot: 'A' | 'B') => {
    const inVal = slot === 'A' ? bgOpacityA : bgOpacityB;
    const outVal = slot === 'A' ? bgOpacityB : bgOpacityA;
    Animated.timing(inVal, { toValue: 1, duration: 280, useNativeDriver: true }).start();
    Animated.timing(outVal, { toValue: 0, duration: 280, delay: 120, useNativeDriver: true }).start();
    bgTopIsARef.current = slot === 'A';
  }, []);

  useEffect(() => {
    const next = roomMeta.bg;
    const last = bgLastUriRef.current;
    bgLastUriRef.current = next;
    if (next === last) return; // 同一张图：绝不能动 opacity（归零 = 闪）

    if (!next) {
      // 切到无背景房间：两层一起淡出，露出全局底衬
      Animated.parallel([
        Animated.timing(bgOpacityA, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(bgOpacityB, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
      bgPendingFadeRef.current = null;
      return;
    }

    // 换图：写进「非顶层」槽。⚠️ 状态机死角修复：若目标槽**已经装着同一张图**
    //（A→B→A 来回切时必现），setState 同值不触发重渲染/onLoad → 交叉淡入永远不执行，
    // 背景停在旧房间的图（用户反馈「大小切换不过来」）—— 此时该图早已解码完成，直接交叉淡入。
    const targetSlot: 'A' | 'B' = bgTopIsARef.current ? 'B' : 'A';
    const targetUri = targetSlot === 'A' ? bgLayerARef.current : bgLayerBRef.current;
    if (targetUri === next) {
      bgPendingFadeRef.current = null;
      crossfadeTo(targetSlot);
      return;
    }
    setBgLayer(targetSlot, next);
    bgPendingFadeRef.current = targetSlot;
  }, [roomMeta.bg, bgOpacityA, bgOpacityB, crossfadeTo]);

  /** 槽位 onLoad：若它是待淡入槽 → 交叉淡入淡出 */
  const onBgSlotLoad = useCallback((slot: 'A' | 'B') => {
    if (bgPendingFadeRef.current === slot) {
      bgPendingFadeRef.current = null;
      crossfadeTo(slot);
    }
  }, [crossfadeTo]);

  /** 槽位加载失败：放弃本次待淡入（保留当前可见背景，不闪不黑） */
  const onBgSlotError = useCallback((slot: 'A' | 'B') => {
    if (bgPendingFadeRef.current === slot) bgPendingFadeRef.current = null;
  }, []);
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
  const msgListRef = useRef<any>(null);
  // 大/小房间滑动位置【各自分开记忆】：key = channelId（大小房间 channelId 不同 → 天然分离），
  // 切回某房间数据到位后恢复到该房间上次位置；无记忆（首次）才停在顶部最新。
  const scrollPosCache = useRef<Record<string, number>>({});
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMsgScroll = useCallback((e: any) => {
    const y = Number(e?.nativeEvent?.contentOffset?.y);
    const cid = activeChannelRef.current;
    if (!cid || !Number.isFinite(y)) return;
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    scrollSaveTimer.current = setTimeout(() => {
      scrollSaveTimer.current = null;
      scrollPosCache.current[cid] = y;
    }, 200);
  }, []);
  // 消息列表 ref：开房/大小房间切换数据到位后滚回顶部（最新消息）——
  // 否则旧房间滚动 offset 套到新房间数据上「滑动位置不对」（用户反馈）

  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const loadingMoreMessagesRef = useRef(false);
  // 实时刷新进行中标志：与 loadMore 互斥，避免两者同时 setRoomMessages 造成列表重排/滚动弹回
  const refreshingRef = useRef(false);
  const [currentUserId, setCurrentUserId] = useState('');
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
  const [fullImageUrl, setFullImageUrl] = useState('');
  const [roomPlayer, setRoomPlayer] = useState<RoomMedia | null>(null);
  /** 房间播放器视频真实宽高（PlayerScreen onVideoSize）：交棒小窗时带上，小窗立即按比例适配 */
  const roomVideoAspectRef = useRef<{ w: number; h: number } | null>(null);

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
        selectedRoom && roomMeta.bg
          ? { uri: roomMeta.bg, scrim: resolvedTheme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.42)' }
          : null,
      );
      return () => setScreenBackdrop(null);
    }, [selectedRoom, roomMeta.bg, resolvedTheme]),
  );
  // 直播弹幕：页面浮层 + 播放器底坞输入条共用同一条云信连接（避免重复建连）
  const roomBarrageLiveId = roomPlayer?.isLive && roomPlayer.liveId ? String(roomPlayer.liveId) : '';
  const roomBarrage = useLiveBarrage({ liveId: roomBarrageLiveId, enabled: !!roomBarrageLiveId, module: 'live' });
  /** 弹幕列表抽屉（房间内直播弹幕）：与飘屏/输入条共用同一条云信连接的数据 */
  const [showRoomDanmakuList, setShowRoomDanmakuList] = useState(false);
  /** 房间内「直播回放」抽屉（该成员的历史直播回放列表，点条目就地用房间播放器播放） */
  const [showRoomReplay, setShowRoomReplay] = useState(false);
  const roomDanmakuEntries = useMemo<DanmakuListEntry[]>(
    () =>
      roomBarrage.items.map((item) => ({
        id: item.id,
        time: 0,
        nick: item.nick || '',
        text: item.text || '',
        kind: item.kind,
      })),
    [roomBarrage.items],
  );
  /** 飘屏弹幕开关：与弹幕设置面板的总开关同一来源（持久化） */
  const roomDanmakuOn = useDanmakuSettings((s) => s.enabled);
  /** 当前是否横屏：房间内的送礼/贡献榜/菜单浮层要按横屏收窄内部滚动区 */
  const isRoomLandscape = useIsLandscape();

  /* ==================== 房间未读（本地累计） ==================== */
  /**
   * 官方**没有**房间级未读接口（详见 src/services/roomUnread.ts 顶部说明），
   * 按用户确认的方案做本地累计：进房清零、列表挂着时收到其它房间的实时消息 +1、落 AsyncStorage。
   */
  const roomUnreadCounts = useRoomUnreadStore((s) => s.counts);
  /** 每个房间的「已读基线」（服务器消息时间域）：和房间最新消息时间比对，实时通道不可用时也能出未读 */
  const roomLastReadAt = useRoomUnreadStore((s) => s.lastReadAt);
  /** 每个房间「已见的最新消息指纹」：与当前指纹不同即视为有新消息（不依赖时间字段名） */
  const roomSeenTokens = useRoomUnreadStore((s) => s.seenTokens);
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
  /** 每次进房只自动定位一次（按 room+基线 记账） */
  const lastSeenScrollDoneRef = useRef('');
  /**
   * 本轮列表刷新前、实时通道已计过数的房间（memberId 集合）。
   * 用途见 loadFollowed 里的「指纹计数」：实时通道计过的房间本轮只对齐指纹、不重复计数。
   */
  const realtimeBumpedRef = useRef<Set<string>>(new Set());

  /**
   * 每个房间「当前观测到的最后活动时间」镜像（memberId → 服务器消息时间）。
   *
   * 进房/退房写已读基线时必须用**这个值**而不是 `Date.now()`（见 roomUnread.ts 的时间域铁律）。
   * 存成 ref 而不是从 `followed` 现取：避免把 `followed` 塞进 `openRoom` 的依赖数组
   *（那会让 openRoom 每次列表刷新都换引用，进而让 roomSwipeGesture 等一堆东西重建）。
   */
  const roomActivityRef = useRef<Record<string, number>>({});
  /** 每个房间「当前最新消息指纹」镜像（memberId → token）：进房/退房写已见指纹用 */
  const roomTokenRef = useRef<Record<string, string>>({});
  /** 退房待收尾的房间：等下一次 loadFollowed 拿到最新指纹后补写「已见」（见 closeRoom/loadFollowed） */
  const pendingSeenRef = useRef('');
  /** 「最新消息」样本只记一次运行日志（用于事后排查真实字段名） */
  const loggedLastMsgSampleRef = useRef(false);
  useEffect(() => {
    for (const item of followed as any[]) {
      const act = roomLastActivity(item);
      const token = roomToken(item);
      for (const key of [item?.memberId, item?.member?.id]) {
        const k = String(key || '');
        if (!k) continue;
        roomActivityRef.current[k] = act;
        if (token) roomTokenRef.current[k] = token;
      }
    }
  }, [followed]);

  /** 取某房间当前观测到的最后活动时间（0 = 还不知道，调用方按「不动基线」处理） */
  const roomActivityOf = useCallback((room: Member | null | undefined) => {
    const id = String(room?.id || '');
    return Number(roomActivityRef.current[id] || 0);
  }, []);

  /** 取某房间当前最新消息指纹（'' = 还不知道，调用方按「不动」处理） */
  const roomTokenOf = useCallback((room: Member | null | undefined) => {
    const id = String(room?.id || '');
    return String(roomTokenRef.current[id] || '');
  }, []);

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
   * channelId → memberId 反查表（大房间 channelId + 小房间 yklzId 都收）：
   * 把全量实时消息按房间归位。
   */
  const channelToMember = useMemo(() => {
    const map: Record<string, string> = {};
    for (const it of followed) {
      const mid = String(it.memberId || (it.member as any)?.id || '');
      if (!mid) continue;
      const big = String((it.member as any)?.channelId || '');
      const small = String((it.member as any)?.yklzId || '');
      if (big) map[big] = mid;
      if (small) map[small] = mid;
    }
    return map;
  }, [followed]);
  const channelToMemberRef = useRef(channelToMember);
  channelToMemberRef.current = channelToMember;
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
    observeRoomMessages((messages) => {
      if (disposed) return;
      const map = channelToMemberRef.current;
      const opened = activeChannelRef.current;
      const deltas: Record<string, number> = {};
      for (const m of messages) {
        const cid = String(m.channelId || '');
        if (!cid || (opened && cid === opened)) continue;
        const mid = map[cid];
        if (mid) deltas[mid] = (deltas[mid] || 0) + 1;
      }
      // 批量提交：逐条 bump 会引发 N 次重渲染。
      // 同时记下「实时通道计过数的房间」：列表轮询的指纹计数要为它让位（防同一条消息计两次）
      for (const [mid, n] of Object.entries(deltas)) {
        realtimeBumpedRef.current.add(mid);
        useRoomUnreadStore.getState().bump(mid, n);
      }
    })
      .then((unsub) => { if (disposed) unsub(); else unsubscribe = unsub; })
      .catch(() => undefined);
    return () => { disposed = true; if (unsubscribe) unsubscribe(); };
  }, [nimEpoch]);
  /**
   * 飘屏弹幕（直播）：与列表 / 输入条共用同一条云信连接的数据。
   * 改造前房间页只有弹幕列表 + 输入条，没有飘屏层 —— 「房间里看不到飘屏弹幕」。
   */
  const roomLiveDanmakuItems = useMemo(
    () => roomBarrage.items.map((item) => ({ key: item.id, text: item.nick ? `${item.nick}：${item.text}` : item.text })),
    [roomBarrage.items],
  );
  /* ==================== 房间回放（录播）弹幕 ==================== */
  /**
   * 回放弹幕：与 MediaScreen 录播**同一条链路** —— `getLiveLrc(liveId)` → `parseDanmaku`
   * → 按播放时间轴飘屏（`DanmakuOverlay` 的 currentTime 时间窗）。
   * 改造前房间页只有直播飘屏，回放完全没有弹幕（用户反馈「房间里的回放没有弹幕」）。
   * `liveId` 取自回放卡解析结果；解析不出（官方回放卡不保证带 liveId）就自然为空 → 不显示弹幕。
   */
  const [roomVodDanmaku, setRoomVodDanmaku] = useState<DanmakuItem[]>([]);
  const roomVodLiveId = roomPlayer && !roomPlayer.isLive ? String(roomPlayer.liveId || '') : '';
  useEffect(() => {
    if (!roomVodLiveId) {
      setRoomVodDanmaku((prev) => (prev.length ? [] : prev));
      return undefined;
    }
    let disposed = false;
    setRoomVodDanmaku((prev) => (prev.length ? [] : prev));
    pocketApi.getLiveLrc(roomVodLiveId)
      .then((text) => {
        if (disposed || !text) return;
        setRoomVodDanmaku(parseDanmaku(text));
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [roomVodLiveId]);
  /**
   * 房间**录播**的弹幕列表条目（时间轴来自 LRC 解析结果）。
   * 录播没有实时聊天室，列表数据只能用 LRC —— 这样录播也有「弹幕列表」入口，
   * 而不是只有直播才有（用户反馈「房间内直播有弹幕设置了但还是没有弹幕列表」）。
   */
  const roomVodDanmakuEntries = useMemo<DanmakuListEntry[]>(
    () => roomVodDanmaku.map((d, i) => ({
      id: `vod-${i}-${d.time}`,
      time: d.time,
      nick: d.nick || '',
      text: d.text || '',
    })),
    [roomVodDanmaku],
  );
  /** 录播弹幕时钟：与 MediaScreen 一致，取全局播放器进度 */
  const roomDanmakuClock = usePlayerStore((s) => s.position);
  /** 房间弹幕设置面板：与直播页共用同一套 DanmakuSettingsSheet */
  const [showRoomDanmakuSettings, setShowRoomDanmakuSettings] = useState(false);
  /**
   * 在线人数（官方 `getLiveOne.content.onlineNum`）。
   *
   * ⚠️【产品规则】在线人数**任何情况都要显示**（用户明确要求，2026-09-26 纠正）：
   *   - 主直播页：直播 + 回放都显示（见 MediaScreen 的 liveOnlineNum）
   *   - **房间内**：直播 + 回放**也都要显示** —— 所以本页同样拉取并渲染胶囊
   *   - B站：无该数据源（roomId ≠ 口袋 liveId；B站 `get_info` 的 online 恒为 0），
   *     见 BilibiliLiveScreen 里的说明
   * 直播中每 30s 刷新；回放取到的是「该场结束时的 onlineNum」，是定值，取一次即可。
   *
   * ⚠️ 实测结论（2026-09-26 直接打接口核实，不是猜的）：
   *   - `getLiveOne` **没有** playNum / praiseNum 字段（上一版按文档猜的名字 → 所以胶囊不显示）
   *   - 它返回 `onlineNum`：直播时是实时在线人数，回放能读到该场结束时的值
   *   - 直播列表接口不带该字段，必须单独取详情（所以这里自己请求）
   * ⚠️ 以后任何「直播」相关改动都要同步检查房间内直播/回放这条线，别只改主直播页。
   */
  const [roomOnlineNum, setRoomOnlineNum] = useState(0);
  /**
   * 房间内直播的 liveId **兜底**。
   *
   * ⚠️ 用户反馈「房间内直播无法显示人数」的根因就在这里：房间里的直播是从**消息卡片**点开的
   *（`playMedia` → `resolveRoomLiveMedia`），liveId 只能从消息 JSON / 文本里抽
   *（`extractLiveIdFromText`）——**经常抽不到**。liveId 一空，下面那个 effect 直接 return，
   * 详情的 `onlineNum` 也就永远拿不到、胶囊永远不出现。
   * 兜底：用「直播中」索引按成员反查（`liveNow` 每 30s 随列表刷新，与房间行点头像进直播同源）。
   */
  const roomLiveEntry = useMemo(
    () => (roomPlayer?.isLive ? liveEntryForMember(selectedRoom, liveNow) : undefined),
    [roomPlayer?.isLive, selectedRoom, liveNow],
  );
  const roomStatLiveId = String(roomPlayer?.liveId || '')
    // 回放兜底：VOD 地址里就带 liveId（消息卡里常常抽不到 → 这是「房间内回放看不到人数」的真因）
    || liveIdFromUrl(String(roomPlayer?.url || ''))
    || String(roomLiveEntry?.liveId || '');
  const roomIsLiveForStat = !!roomPlayer?.isLive;
  /** 直播：实时在线人数，30s 轮询 */
  useEffect(() => {
    // ⚠️【串台修复】换直播/回放先清零：旧场次的「N 人在线」不再残留到新场次数据返回
    setRoomOnlineNum((prev) => (prev ? 0 : prev));
    if (!roomIsLiveForStat) return undefined;
    if (!roomStatLiveId) {
      setRoomOnlineNum((prev) => (prev ? 0 : prev));
      return undefined;
    }
    let disposed = false;
    const pull = () => {
      pocketApi.getLiveOne(roomStatLiveId)
        .then((res: any) => {
          if (disposed) return;
          const c = res?.content || res?.data || {};
          setRoomOnlineNum(Number(c?.onlineNum || 0) || 0);
        })
        .catch(() => undefined);
    };
    pull();
    const timer = setInterval(pull, 30000);
    return () => { disposed = true; clearInterval(timer); };
  }, [roomStatLiveId, roomIsLiveForStat]);
  /**
   * 回放：显示该场结束时的 onlineNum（getLiveOne 对已结束场次也返回该值——
   * 与「直播板块」录播**同一个来源、同一个字段、同一个口径**，用户明确要求两处共用）。
   *
   * ⚠️ 之前一直不显示的根因：sync 链抽到的 liveId 不可靠——
   *   a) 消息卡 JSON/文本里抽到的 18-19 位数字很可能是云信 msgIdClient（也是 18-19 位），
   *      拿去查 getLiveOne 必然查空 → onlineNum 恒为 0；
   *   b) 卡片 URL 若不含 15-20 位数字段，`liveIdFromUrl` 也抽不到。
   * 兜底：先信 sync 链（查到 onlineNum>0 就用），查空再用**成员回放列表**（与房间内
   * 「直播回放」面板、直播板块录播完全同源：getLiveList record:true + userId）
   * 按播放地址/标题反查真 liveId，再查一次详情。
   */
  useEffect(() => {
    // ⚠️【串台修复】换回放（回放→回放）先清零：旧回放场次的人数不残留到新场次数据返回
    setRoomOnlineNum((prev) => (prev ? 0 : prev));
    if (!roomPlayer || roomPlayer.isLive) {
      setRoomOnlineNum((prev) => (prev ? 0 : prev));
      return undefined;
    }
    let disposed = false;
    const tryId = async (id: string): Promise<number> => {
      try {
        const res: any = await pocketApi.getLiveOne(id);
        const c = res?.content || res?.data || {};
        return Number(c?.onlineNum || 0) || 0;
      } catch {
        return 0;
      }
    };
    (async () => {
      const syncId = String(roomPlayer.liveId || '') || liveIdFromUrl(String(roomPlayer.url || ''));
      if (syncId) {
        const first = await tryId(syncId);
        if (disposed) return;
        if (first > 0) {
          setRoomOnlineNum(first);
          return;
        }
      }
      const memberId = String(selectedRoom?.id || '');
      if (!memberId) {
        setRoomOnlineNum(0);
        return;
      }
      const matchId = await findReplayLiveId(memberId, { url: roomPlayer.url, title: roomPlayer.title }).catch(() => '');
      if (disposed || !matchId) {
        if (!disposed) setRoomOnlineNum(0);
        return;
      }
      const second = await tryId(matchId);
      if (!disposed) setRoomOnlineNum(second);
    })();
    return () => { disposed = true; };
  }, [roomPlayer, selectedRoom]);
  // 统一播放器的状态/时长订阅：用于「上次看到」在播放器就绪后注入 seek
  const playerState = usePlayerStore((s) => s.state);
  const playerDuration = usePlayerStore((s) => s.duration);
  /**
   * 「上次看到」进度保存：回放播放中每 5s 把 position/duration 写进 replayProgress（按 liveId）。
   * 只在统一播放器仍指向当前这条流时记录，避免小窗/其它页面的播放进度串台。
   */
  useEffect(() => {
    const cur = roomPlayer;
    if (!cur || cur.isLive || !String(cur.liveId || '')) return undefined;
    const liveId = String(cur.liveId);
    const url = String(cur.url || '');
    const timer = setInterval(() => {
      try {
        const st = usePlayerStore.getState();
        if (st.source?.url !== url) return;
        const pos = Number(st.position) || 0;
        if (pos > 5) saveReplayProgress(liveId, pos, Number(st.duration) || 0);
      } catch {}
    }, 5000);
    return () => clearInterval(timer);
  }, [roomPlayer]);
  /** 「上次看到」读取：打开一场回放时取出进度（>15s 才算看过，太短没必要续播） */
  const lastSeenRef = useRef<{ liveId: string; position: number } | null>(null);
  useEffect(() => {
    const cur = roomPlayer;
    if (!cur || cur.isLive || !String(cur.liveId || '')) {
      lastSeenRef.current = null;
      return undefined;
    }
    let alive = true;
    getReplayProgress(String(cur.liveId))
      .then((entry) => {
        if (!alive || !entry) return;
        if (entry.position > 15) lastSeenRef.current = { liveId: String(cur.liveId), position: entry.position };
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [roomPlayer]);
  /**
   * 「上次看到」注入：播放器就绪（source 已开 + 拿到时长/开播）后一次性 seek 到上次位置，
   * 并 toast 提示「上次看到 mm:ss」。快看完（距结尾 <10s）就不续了，直接从头看。
   * 时机必须等 open() 之后再写 seekTarget——open() 会把 seekTarget 清零。
   */
  useEffect(() => {
    const pending = lastSeenRef.current;
    const cur = roomPlayer;
    if (!pending || !cur) return;
    try {
      const st = usePlayerStore.getState();
      if (st.source?.url !== String(cur.url || '')) return;
      if (st.state !== 'playing' && !(st.duration > 0)) return;
      lastSeenRef.current = null;
      const dur = Number(st.duration) || Number(playerDuration) || 0;
      if (dur > 0 && pending.position >= dur - 10) return;
      usePlayerStore.getState().setSeekTarget(pending.position);
      showToast(t('上次看到 {time}，已自动续播', { time: formatDuration(pending.position) }));
    } catch {}
  }, [roomPlayer, playerState, playerDuration, showToast, t]);
  // 房间发言（云信圈组）：草稿 + 发送中 + 错误提示
  const [roomDraft, setRoomDraft] = useState('');
  const [roomSending, setRoomSending] = useState(false);
  const [roomSendHint, setRoomSendHint] = useState('');
  /** 直播解析占位：点击无流地址的直播卡 → 立即弹全屏「解析中」，不再干等无反馈（连击才加载进去的元凶） */
  const [liveResolve, setLiveResolve] = useState<null | { key: string; error: string; media: RoomMedia }>(null);
  const liveResolveToken = useRef(0);

  const [rankVisible, setRankVisible] = useState(false);
  // 房间直播送礼（与 Media 页同 API；roomPlayer 面板此前漏接）
  const [giftVisible, setGiftVisible] = useState(false);
  const [giftStatus, setGiftStatus] = useState('');
  const [giftBalance, setGiftBalance] = useState('');
  const [giftList, setGiftList] = useState<any[]>([]);
  const [giftSel, setGiftSel] = useState<any>(null);
  const [giftNum, setGiftNum] = useState(1);
  const [rankRows, setRankRows] = useState<any[]>([]);
  const [rankStatus, setRankStatus] = useState('');
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
    detail: { name: string; avatar: string; level: string; signature: string; team: string; period: string; isStar: boolean };
  }>(null);
  /** 资料卡请求序号：连点不同头像时丢弃旧响应（避免慢响应覆盖新卡） */
  const userCardSeqRef = useRef(0);
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


  useFocusEffect(useCallback(() => {
    setTabBarHidden(!!selectedRoom || !!roomPlayer);
    return () => {
      setTabBarHidden(false);
      setLiveImmersiveMode(false);
      followSystem();
    };
  }, [roomPlayer, selectedRoom, setTabBarHidden]));

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
    if (!selectedRoom) {
      setRoomPlayer(null);
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
      if (roomPlayer) {
        setRoomPlayer(null);
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
  }, [roomPlayer, selectedRoom, setTabBarHidden]);

  const closeRoomPlayer = useCallback(() => {
    setRoomPlayer(null);
    setLiveImmersiveMode(false);
    followSystem();
    setTabBarHidden(!!selectedRoom);
  }, [selectedRoom, setTabBarHidden]);

  // 应用内小窗：房间播放器交棒给悬浮小窗
  const openRoomGiftPanel = useCallback(async () => {
    if (!roomPlayer?.liveId) {
      setGiftStatus(t('当前直播缺少 liveId，不能送礼'));
      setGiftVisible(true);
      return;
    }
    setGiftVisible(true);
    setGiftStatus('');
    setGiftSel(null);
    setGiftNum(1);
    try {
      const [giftRes, moneyRes] = await Promise.all([
        pocketApi.getGiftList(String(roomPlayer.liveId)).catch(() => null),
        pocketApi.getUserMoney().catch(() => null),
      ]);
      const rawGifts = (giftRes as any)?.content?.gifts || (giftRes as any)?.content?.giftList
        || (giftRes as any)?.data?.gifts || (giftRes as any)?.data?.giftList || (giftRes as any)?.content?.list || [];
      const gifts = Array.isArray(rawGifts) ? rawGifts : [];
      setGiftList(gifts);
      const money = moneyRes?.content?.moneyTotal ?? moneyRes?.data?.moneyTotal ?? '';
      if (money !== '' && money !== undefined && money !== null) setGiftBalance(String(money));
      setGiftStatus(gifts.length ? t('已加载 {count} 个礼物', { count: gifts.length }) : t('礼物列表为空'));
    } catch (err) {
      setGiftList([]);
      setGiftStatus(t('加载礼物失败：{error}', { error: errorMessage(err) }));
    }
  }, [roomPlayer, t]);

  const sendRoomGift = useCallback(async () => {
    if (!roomPlayer || !giftSel) {
      setGiftStatus(t('请先选择礼物'));
      return;
    }
    const num = Math.max(1, Math.floor(Number(giftNum) || 1));
    // 主播 = 房间主人（member.id）；礼物入账到主播账号
    const ownerId = String((selectedRoom as any)?.id || '');
    const liveId = String(roomPlayer.liveId || '');
    setGiftStatus(t('正在发送...'));
    try {
      await pocketApi.sendGift({
        giftId: String(giftSel.giftId || giftSel.id),
        liveId,
        acceptUserId: ownerId,
        giftNum: num,
      });
      setGiftStatus(t('已送出 {num} 个 {giftName}', { num, giftName: String(giftSel.giftName || giftSel.name || '') }));
      const money = await pocketApi.getUserMoney().catch(() => null);
      if (money?.content?.moneyTotal !== undefined) setGiftBalance(String(money.content.moneyTotal));
    } catch (err) {
      setGiftStatus(t('送礼失败：{error}', { error: errorMessage(err) }));
    }
  }, [roomPlayer, selectedRoom, giftSel, giftNum, t]);

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
    // 发送坐标整体取自 activeRoomRef（channelId 与 serverId 配对的唯一来源）
    const target = activeRoomRef.current;
    const channelId = target.channelId;
    if (!channelId) {
      setRoomSendHint(t('房间未就绪'));
      return;
    }
    setRoomSending(true);
    setRoomSendHint('');
    try {
      // 圈组发送必须带 serverId：成员库缺失时先按 channelId 解析（否则云信返回 414 参数错误）
      let serverId = target.serverId;
      if (!serverId || serverId === '0') {
        serverId = await pocketApi.resolveRoomServerId(channelId).catch(() => '');
      }
      if (!serverId || serverId === '0') {
        throw new Error(t('缺少房间 serverId，无法发言'));
      }
      await sendRoomTextMessage({ serverId, channelId }, text);
      setRoomDraft('');
      // ⚠️ 自己发的消息立即上屏：QChat 回显链路不稳定，等 15s 轮询太久（用户反馈）。
      // 发送成功即静默拉最新页合并（mergeMessages 按 msgId 去重，与轮询同路径、不会重复）。
      setTimeout(() => refreshRoomMessagesRef.current?.(), 500);
      setTimeout(() => refreshRoomMessagesRef.current?.(), 1500);
    } catch (err) {
      setRoomSendHint(errorMessage(err));
    } finally {
      setRoomSending(false);
    }
  }, [roomDraft, roomSending, t]);

  const handleRoomMiniPlayer = useCallback(async () => {
    const cur = roomPlayer;
    if (!cur?.url) return;
    // 成员直播（口袋48 房间流 = rtmp/flv，见 resolveRoomLiveMedia）也能进小窗：
    // MiniPlayer 对 rtmp/.flv + isLive 的 url 渲染原生 LiveExoView（与大播放器同内核），
    // 录播/HLS 走 RNV Video —— 全部交 MiniPlayer 内部路由，不再全屏拦截。
    //
    // ⚠️ 交棒前**重新解析一条新流地址**（用户反馈「切小窗后直播中断」根因）：
    // 口袋的 rtmp/flv 与录播 m3u8 都带 wsSecret 签名，且大窗的 LiveExoView 关闭即销毁播放器；
    // 小窗挂的是新实例，若复用大窗这条 URL，签名流重连大概率已被服务端拒绝 → 小窗黑屏/中断。
    // 有 liveId 的直播交给解析器重新拿一条新签名流；解析失败才退回原 URL（聊胜于无）。
    let url = cur.url;
    if (cur.isLive && cur.liveId) {
      try {
        const fresh = await resolveRoomLiveMedia({ ...cur, url: '' });
        if (fresh?.url) url = fresh.url;
      } catch {}
    }
    // 录播转小窗续播：读取当前播放位置（统一播放器 store 实时 position），
    // 传给小窗做 onLoad seek + backTo 供回大窗 Media 续播（此前写死 0 = 重头放）
    let pos = 0;
    if (!cur.isLive) {
      try {
        const pst = usePlayerStore.getState();
        if (pst.source && pst.source.url === cur.url && (pst.state === 'playing' || pst.state === 'paused')) {
          pos = Math.max(0, Number(pst.position) || 0);
        }
      } catch {}
    }
    useMiniPlayerStore.getState().open({
      url,
      title: cur.title,
      cover: cur.cover,
      isLive: !!cur.isLive,
      // 上麦/电台：小窗渲染为紧凑音频胶囊（不显示视频框）
      audioOnly: cur.type === 'audio',
      position: pos,
      // ⚠️ 带上大窗已知的视频宽高：小窗挂载即按比例适配，不再等 onLoad（拿不到就停在默认条）
      aspectW: roomVideoAspectRef.current?.w,
      aspectH: roomVideoAspectRef.current?.h,
      // ⚠️ mode 必须跟流形态一致（直播='live' / 录播='vod'）：小窗「返回全屏」按它导航 Media，
      // MediaScreen 用 mode !== 'vod' 判定直播语义 —— 之前写死 'vod'，房间直播回大窗会被当录播播放
      backTo: { mode: cur.isLive ? 'live' : 'vod', playUrl: url, playTitle: cur.title, playCover: cur.cover, playPosition: pos },
    });
    closeRoomPlayer();
  }, [roomPlayer, closeRoomPlayer, showToast, t]);

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
      useRoomUnreadStore.getState().markSeen(closingId, roomTokenOf(selectedRoom));
      /**
       * 收尾：房间开着时到达的消息走不了实时累计，而列表镜像要等下一次刷新（≤30s）——
       * 不在退房后补一次「已见」，就会出现「刚看完的房间又冒『新』」。
       * 这里记下待收尾的房间，紧接着静默刷一次列表，拿到最新指纹后写回（见 loadFollowed）。
       */
      pendingSeenRef.current = closingId;
      loadFollowedRef.current?.(true);
    }
    setRoomPlayer(null);
    setPlayingMedia(null);
    setSelectedRoom(null);
    setScreenBackdrop(null); // 玻璃折射背景还原全局
    setRoomMeta({ name: '', bg: '' });
    activeChannelRef.current = '';
    activeRoomRef.current = { channelId: '', serverId: '', memberId: '' };
    setRoomDraft('');
    setRoomSendHint('');
    setLiveImmersiveMode(false);
    followSystem();
    setTabBarHidden(false);
    // ⚠️ selectedRoom 必须进依赖：此前依赖数组漏了它，闭包里永远是首帧的 null，
    // `if (selectedRoom)` 恒 false → 退房基线推进从未执行（实测日志：baseline=0）
  }, [selectedRoom, setTabBarHidden]);
  closeRoomRef.current = closeRoom;

  const togglePin = async (memberId: string) => {
    const next = pinned.includes(memberId) ? pinned.filter((id) => id !== memberId) : [...pinned, memberId];
    setPinned(next);
    try {
      await AsyncStorage.setItem('yaya_pinned_rooms', JSON.stringify(next));
    } catch (error: any) {
      showToast(t('置顶保存失败：{msg}', { msg: error?.message || String(error) }));
    }
  };

  /** 置顶成员调换：dir=-1 上移 / 1 下移（交换相邻置顶位） */
  const movePin = async (memberId: string, dir: -1 | 1) => {
    const idx = pinned.indexOf(memberId);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= pinned.length) return;
    const next = [...pinned];
    [next[idx], next[to]] = [next[to], next[idx]];
    setPinned(next);
    try {
      await AsyncStorage.setItem('yaya_pinned_rooms', JSON.stringify(next));
    } catch (error: any) {
      showToast(t('置顶保存失败：{msg}', { msg: error?.message || String(error) }));
    }
  };

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

  /**
   * 指纹计数（列表加载与 30s 轮询共用）：上一轮已见过指纹、这一轮指纹变了 ≈ 有新消息
   * → 计数 +1 并推进指纹。让没有云信实时通道的设备也能显示「更新的消息数量」。
   * 一轮轮询里爆发的多条消息只计 1 条（本地口径的近似）；
   * 实时通道计过的房间本轮只对齐指纹，防止同一条消息被两条通道各计一次。
   */
  const applyFingerprintCounts = useCallback((rows: any[]) => {
    const tokens: Record<string, string> = {};
    for (const row of rows) {
      const id = String(row.memberId || row.member?.id || '');
      const token = roomToken(row);
      if (id && token) tokens[id] = token;
    }
    void useRoomUnreadStore.getState().hydrate().then(() => {
      const seenNow = useRoomUnreadStore.getState().seenTokens;
      for (const row of rows) {
        const id = String(row.memberId || row.member?.id || '');
        const token = tokens[id];
        if (!id || !token) continue;
        const prev = seenNow[id];
        if (!prev || prev === token) continue; // 首次见到 → 交给 seedTokens 补基线；没变 → 无新消息
        if (String(selectedRoom?.id || '') === id) continue; // 房间开着：进房已清零，只对齐指纹
        if (realtimeBumpedRef.current.has(id)) {
          useRoomUnreadStore.getState().markSeen(id, token);
          continue;
        }
        useRoomUnreadStore.getState().bump(id, 1);
        useRoomUnreadStore.getState().markSeen(id, token);
      }
      realtimeBumpedRef.current.clear();
    });
  }, [selectedRoom]);

  const loadFollowed = useCallback(async (silent = false) => {
    if (!token) {
      setFollowed([]);
      return;
    }
    setFollowedLoading(true);
    try {
      const idsRes = await pocketApi.getFollowedIds();
      const idsArr = unwrapList(idsRes, ['content.data', 'content', 'data', 'list']).map(String);
      setFollowedIds(new Set(idsArr));
      const followedMembers = idsArr.map((id: string) => {
        const member = members.find((item: any) => String(item.id || item.userId) === id);
        return { memberId: id, member };
      }).filter((item: any) => item.member?.channelId);
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
      }
      const followedRows = followedMembers.map((item: any) => ({
        ...item,
        lastMessage: findLastMessage(lastMsgs, item.member),
        lastSmallMessage: findSmallLastMessage(lastMsgs, item.member),
      }));
      setFollowed(followedRows);
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
        setLiveNow(buildLiveIndex(liveItems));
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
      const unreadTokens: Record<string, string> = {};
      for (const row of followedRows) {
        const id = String(row.memberId || row.member?.id || '');
        if (!id) continue;
        unreadBaseline[id] = roomLastActivity(row);
        const token = roomToken(row);
        if (token) unreadTokens[id] = token;
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
      const pendingSeen = pendingSeenRef.current;
      if (pendingSeen && unreadTokens[pendingSeen]) {
        useRoomUnreadStore.getState().markSeen(pendingSeen, unreadTokens[pendingSeen]);
        pendingSeenRef.current = '';
      }
      if (!silent) showToast(t('已加载 {count} 个房间', { count: followedMembers.length }));
      setFollowedError('');
    } catch (e) {
      setFollowedError(errorMessage(e));
      if (!silent) showToast(t('加载失败：{msg}', { msg: errorMessage(e) }));
    }
    finally { setFollowedLoading(false); }
  }, [members, showToast, t, token, applyFingerprintCounts]);
  loadFollowedRef.current = loadFollowed;

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

  /**
   * 回到前台立刻刷新一次房间列表。
   *
   * 下面的 30s tick 只在**页面挂载期间**跑，而 App 切到后台时 JS 定时器会被挂起：
   * 「切出去一会儿再回来」时列表与未读要等下一轮 tick（最坏 30s+）才有变化 —— 用户体感就是
   * 「有新消息但列表里什么都不显示」。回前台补一次静默刷新，让未读/预览立刻对上。
   * 用 ref 调用，避免把 loadFollowed 放进依赖引发无谓重建。
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      // activeChannelRef 非空即「当前在房间里」（openRoom 写入、closeRoom 清空）——房间里自带轮询，列表不必刷
      if (activeChannelRef.current) return;
      loadFollowedRef.current?.(true);
    });
    return () => sub.remove();
  }, []);

  // 列表页实时刷新：关注成员的直播状态 + 上麦状态，每 60s 静默刷新（仅列表视图时）
  // 列表页实时刷新：关注成员的直播状态 + 上麦状态 + 最新消息，每 30s 静默刷新（仅列表视图时）。
  // 之前直播状态 60s、最新消息完全不刷新（只有 loadFollowed 手动拉一次）→ 卡片「最新消息」长期静止。
  // 现在合并到一个 tick：直播/上麦 + 最新消息一起 30s 刷新；followedRef 持最新列表避免闭包过期。
  useEffect(() => {
    if (selectedRoom) return;
    let active = true;
    const refreshLiveAndMic = () => {
      if (!active) return;
      pocketApi.getLiveList({ record: false, next: 0, size: 100 }).then((res: any) => {
        if (!active) return;
        const liveItems = unwrapList(res, ['content.liveList', 'content.list', 'data.liveList', 'liveList', 'list', 'data']);
        setLiveNow(buildLiveIndex(liveItems));
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
        const updatedRows = cur.map((f) => ({
          ...f,
          lastMessage: findLastMessage(lastMsgs, f.member),
          lastSmallMessage: findSmallLastMessage(lastMsgs, f.member),
        }));
        setFollowed(updatedRows);
        // ⚠️ 指纹计数必须挂在 30s 轮询上（此前只在 loadFollowed 里跑 → 未读数字长期不增长）
        applyFingerprintCounts(updatedRows);
      }).catch(() => {});
    };
    const tick = () => { refreshLiveAndMic(); refreshLastMessages(); };
    tick();
    const id = setInterval(tick, 30000);
    return () => { active = false; clearInterval(id); };
  }, [selectedRoom, applyFingerprintCounts]);

  // Y23: 关注列表在 members 就绪后只拉一次（loadFollowed 依赖 members，随其变化会反复重拉）
  const followedFetchedRef = useRef(false);
  useEffect(() => {
    if (!members.length || followedFetchedRef.current) return;
    followedFetchedRef.current = true;
    loadFollowed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.length]);

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
     * 'internal'（同房间内切大/小房间、点群聊按钮、右划手势）保留当前状态。
     */
    const wantFans = mode === 'enter' ? false : includeFans;
    // D3：进房耗时诊断（runtimeLog 可查看；真机反馈卡顿时据此定位是消息接口慢还是渲染慢）
    const roomOpenStart = Date.now();
    const channelId = roomChannelId(room, nextMode);
    if (!channelId) {
      showToast(nextMode === 'small' ? t('这个成员缺少小房间 channelId，无法打开小房间。') : t('这个成员缺少大房间 channelId，无法打开房间。'));
      return;
    }
    setSelectedRoom(room);
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
    logInfo(`[lastseen] open room=${String(room.id || '')} baseline=${lastSeenBaseline}`, 'room');
    useRoomUnreadStore.getState().markRead(String(room.id || ''), roomActivityOf(room));
    // 指纹基线：把「进房这一刻的最新消息」记为已见（不依赖时间字段名的第二条判据）
    useRoomUnreadStore.getState().markSeen(String(room.id || ''), roomTokenOf(room));
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
    setRoomSearchQuery('');
    setPlayingMedia(null);
    // internal 切换：保留上一帧消息直接覆盖（秒切，不闪「暂无消息」、无割裂）；
    // enter 跨房间：清空上一帧避免旧成员消息残影，由 ListEmptyComponent 的「加载中」转圈替代骨架。
    if (mode === 'internal') {
      // 不清 roomMessages；且【不设 loading/roomLoadedOnce=false】——
      // 否则切换粉丝/成员发言时 loading 态会让消息区闪转圈、整段请求期间卡住（用户实测切换慢）。
      // 上一帧消息持续可见，网络回来直接静默替换，最顺滑。仅更新模式类状态。
    } else if (channelChanged) {
      setRoomMessages([]);
      setLoading(true);
      setRoomLoadedOnce(false);
    }
    setRoomMsgError('');
    setRoomNextTime(0);
    setHasMoreMessages(false);
    setRoomMode(nextMode);
    setShowFanMessages(wantFans);
    try {
      // 只要还没拿到自己的 userId 就取（原来被 includeFans 挡住 → 非粉丝模式下认不出自己发的消息，
      // 气泡全部左对齐）。getNimLoginInfo 与模式无关，取到一次即可复用。
      const userInfo = !currentUserId
        ? await pocketApi.getNimLoginInfo().catch(() => null)
        : null;
      const nextCurrentUserId = currentUserId || currentUserIdFrom(userInfo);
      if (nextCurrentUserId) setCurrentUserId(nextCurrentUserId);
      const res = await pocketApi.getRoomMessages({
        channelId,
        serverId: room.serverId,
        nextTime: 0,
        fetchAll: wantFans,
        fallbackChannelId: nextMode === 'small' ? room.channelId : undefined,
      });
      const list = unwrapList(res, ['content.messageList', 'content.message', 'content.messages', 'content.list', 'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list']);
      const sorted = sortMessagesNewestFirst(list.filter(Boolean));
      diagnoseUndefined(sorted, 'OPEN');
      // Y22: 进房竞态——用户已切到别的房间/模式，丢弃慢响应，避免旧房间消息覆盖新房间
      if (openSeq !== roomSeqRef.current) return;
      setRoomMessages(sorted);
      // 恢复该房间（大/小）各自上次滑动位置；无记忆则停留顶部（最新）
      const cidNow = activeChannelRef.current;
      const saved = cidNow ? scrollPosCache.current[cidNow] || 0 : 0;
      setTimeout(() => {
        if (openSeq !== roomSeqRef.current) return; // 期间已切房则放弃
        msgListRef.current?.scrollToOffset?.({ offset: saved, animated: false });
      }, 60);
      setRoomLoadedOnce(true);
      setRoomMsgError('');
      logInfo(`[room] 进房 ${room.ownerName || channelId} ${nextMode} 消息加载耗时 ${Date.now() - roomOpenStart}ms (${sorted.length}条)`, 'room');
      const nextTime = getNextTime(res, list);
      setRoomNextTime(nextTime);
      setHasMoreMessages(nextTime > 0 && list.length > 0);
      // 房间名 + 背景图：room/info -> channelInfo.channelName / channelInfo.bgImg（按 channelId 缓存，异步拉取不阻塞消息）
      const cachedMeta = roomMetaCache.current[channelId];
      if (cachedMeta !== undefined) {
        // 背景优先走本地缓存（瞬时显示，避免二次进房间重新联网/解码跳变）
        setRoomMeta({ ...cachedMeta, bg: getBgDisplayUri(cachedMeta.bg) });
        if (cachedMeta.bg) ensureBgCached(cachedMeta.bg); // 后台补齐/校验本地副本
      } else {
        roomMetaCache.current[channelId] = { name: '', bg: '' };
        // 小房间 room/info 服务端 2001 无权限（实测）→ 塞纳河 server/detail 拿 channelInfoList 房间名 + 背景墙图
        pocketApi.getRoomMeta(channelId, nextMode === 'small' ? room.channelId : undefined, room.serverId)
          .then((meta) => {
            // Y22: 期间已切房（seq 过期或 channelId 变化）则丢弃，避免旧房间标题/背景覆盖
            if (openSeq !== roomSeqRef.current || activeChannelRef.current !== channelId) return;
            roomMetaCache.current[channelId] = meta;
            setRoomMeta({ ...meta, bg: getBgDisplayUri(meta.bg) });
            if (meta.bg) ensureBgCached(meta.bg); // 后台落盘，下次进房间直接本地显示
          })
          .catch(() => { roomMetaCache.current[channelId] = { name: '', bg: '' }; });
      }
      // 进入房间后立即检测该成员上麦状态（驱动房间内上麦按钮；单成员扫描不影响其它成员）
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
    } catch (error) {
      showToast(t('加载失败：{msg}', { msg: errorMessage(error) }));
      setRoomMessages([]);
      setRoomMsgError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [currentUserId, roomMode, showFanMessages, showToast, t]);

  /** 供声明顺序在前的发送逻辑调用（发送成功后立即刷新，不再等 15s 轮询） */
  const refreshRoomMessagesRef = useRef<(() => void) | null>(null);
  const loadMoreRoomMessages = useCallback(async () => {
    if (!selectedRoom || loading || loadingMoreMessages || loadingMoreMessagesRef.current || refreshingRef.current || !hasMoreMessages || !roomNextTime) return;
    const channelId = roomChannelId(selectedRoom, roomMode);
    if (!channelId) return;
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
      showToast(t('继续加载失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      loadingMoreMessagesRef.current = false;
      setLoadingMoreMessages(false);
    }
  }, [hasMoreMessages, loading, loadingMoreMessages, roomMode, roomNextTime, selectedRoom, showFanMessages, showToast, t]);

  // 房间内实时刷新：静默拉取最新消息并合并（不提示、不清空），供轮询调用
  const refreshRoomMessages = useCallback(async () => {
    if (!selectedRoom || refreshingRef.current) return;
    const channelId = roomChannelId(selectedRoom, roomMode);
    if (!channelId) return;
    refreshingRef.current = true;
    try {
      const res = await pocketApi.getRoomMessages({
        channelId,
        serverId: selectedRoom.serverId,
        nextTime: 0, // 实时刷新永远拉「最新页」，只用于把新消息合并进顶部
        fetchAll: showFanMessages,
        fallbackChannelId: roomMode === 'small' ? selectedRoom.channelId : undefined,
      });
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
    } catch {
      // 静默失败：实时刷新不打扰用户
    } finally {
      refreshingRef.current = false;
    }
  }, [roomMode, selectedRoom, showFanMessages]);
  refreshRoomMessagesRef.current = refreshRoomMessages;


  // 房间内实时刷新：打开房间后每 15s 静默拉取一次最新消息（成员 + 粉丝）
  // B 优化：App 退到后台/锁屏时暂停轮询（避免后台空转耗电耗流量），回前台恢复。
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!selectedRoom) return;
    const startPoll = () => {
      if (pollTimerRef.current) return;
      pollTimerRef.current = setInterval(() => { refreshRoomMessages(); }, 15000);
    };
    const stopPoll = () => {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    };
    // 初始按当前前后台状态决定
    if (AppState.currentState === 'active') startPoll();
    // 前后台切换：前台启动、后台暂停。
    // ⚠️ 进系统 PiP 时 AppState 也报 background → 延迟确认豁免（PiP 事件随后才到），
    // 否则小窗里聊天/弹幕轮询被掐停，展开回 App 前消息全断（用户反馈「系统小窗中断直播」之一）。
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') startPoll();
      else setTimeout(() => { if (!isPipActive()) stopPoll(); }, 600);
    });
    return () => {
      sub.remove();
      stopPoll();
    };
  }, [selectedRoom, refreshRoomMessages]);

  /**
   * 房间消息「实时」接收：云信圈组（QChat）推送。
   *
   * 上面的 15s 轮询只是 HTTP 兜底；圈组才有真正的实时推送（官方同款通道）。
   * 原生桥不可用 / 未登录 / 非 Android 时 observeRoomMessages 内部静默降级，
   * 房间仍按轮询工作，不影响既有行为。
   */
  useEffect(() => {
    if (!selectedRoom) return undefined;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    observeRoomMessages((messages) => {
      if (disposed) return;
      const cid = activeChannelRef.current;
      if (!cid) return;
      const fresh = messages
        .filter((m) => String(m.channelId) === String(cid))
        .map(qchatToRoomMessage);
      if (!fresh.length) return;
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

  /** 直播解析并开播（占位式）：点击即反馈，出地址后无缝换正式播放器 */
  const resolveLiveAndOpen = useCallback(async (media: RoomMedia) => {
    const key = String(media.liveId || media.url || 'live');
    // 同一路正在解析中：忽略重复点击（防连击并发网络风暴）
    if (liveResolve?.key === key && !liveResolve.error) return;
    const token = ++liveResolveToken.current;
    setLiveResolve({ key, error: '', media });
    try {
      const resolved = await resolveRoomLiveMediaWithRetry(media);
      if (token !== liveResolveToken.current) return; // 期间已关闭/改点其它：丢弃过期结果
      if (!resolved.url) {
        setLiveResolve({ key, error: t('解析直播地址失败，请检查网络后重试'), media });
        return;
      }
      setLiveResolve(null);
      // 统一按「是否录播」判定（见 roomTapIsVod：replayHint 回放 / m3u8-mp4 无 live 标记 → vod 可拖）
      const isVod = roomTapIsVod(resolved);
      setRoomPlayer({ ...resolved, isLive: !isVod, needsVlc: resolved.needsVlc || streamNeedsProxy(resolved.url) });
      // 不自动进全屏/横屏：保持窗口方向跟随系统，用户手动点全屏才锁横屏（由 FullscreenManager 处理）
    } catch (e) {
      if (token === liveResolveToken.current) {
        setLiveResolve({ key, error: errorMessage(e) || t('解析直播地址失败，请检查网络后重试'), media });
      }
    }
  }, [liveResolve, t]);

  const cancelLiveResolve = useCallback(() => {
    liveResolveToken.current += 1; // 使在途解析结果失效
    setLiveResolve(null);
  }, []);

  // 直播解析占位期间：Android 硬件返回 = 取消解析（不退出房间）
  useEffect(() => {
    if (!liveResolve) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      cancelLiveResolve();
      return true;
    });
    return () => sub.remove();
  }, [liveResolve, cancelLiveResolve]);

  const playMedia = useCallback(async (media: RoomMedia) => {
    if (media.type === 'link') {
      const url = media.url || media.title;
      if (url) Linking.openURL(url).catch(() => showToast(t('这个链接无法直接打开。')));
      return;
    }
    if (playingMedia?.url && playingMedia.url === media.url) {
      setPlayingMedia(null);
      return;
    }
    let next = media;
    try {
      if (media.type === 'live' || media.liveId) {
        // 已带可播地址：直接开播（零等待，不弹解析占位）
        if (media.url) {
          const isVod = roomTapIsVod(media);
          setRoomPlayer({ ...media, isLive: !isVod, needsVlc: media.needsVlc || streamNeedsProxy(media.url) });
          return;
        }
        if (!media.liveId) {
          showToast(t('无法解析直播地址，请重试'));
          return;
        }
        // 无流地址：交给占位式解析（立即弹「解析中」全屏层，首击即有反馈；失败留层内重试）。
        // 修复「有概率点不进去、连击多点才能加载」——此前 await 解析数秒无任何反馈，
        // 瞬时网络失败又只弹一次 toast，用户只能反复点卡片碰运气。
        resolveLiveAndOpen(media);
        return;
      }
      if (next.type === 'video') {
        // 视频点击进入播放器，但默认不强制全屏（用户可手动点全屏按钮）
        setRoomPlayer({ ...next, needsVlc: streamNeedsProxy(next.url) });
        return;
      }
      setPlayingMedia(next);
    } catch (error) {
      Alert.alert(t('播放失败'), errorMessage(error));
    }
  }, [playingMedia, showToast, navigation, t, resolveLiveAndOpen]);

  /**
   * 房间内「直播回放」：点了某一场 → 复用房间自己的播放链路（roomPlayer）就地播放。
   *
   * 传 `replayHint: true` 明示录播，解析器（resolveRoomLiveMedia）会按录播处理：
   * 拿该场的 `playStreams`、`isLive=false` → 可拖进度条、走 LRC 弹幕，
   * 不会把回放流误判成直播（判据见 roomTapIsVod）。
   */
  const playRoomReplay = useCallback((item: MemberReplayItem) => {
    setShowRoomReplay(false);
    playMedia({
      type: 'video',
      url: '',
      title: item.title,
      cover: item.cover,
      liveId: item.liveId,
      replayHint: true,
    });
  }, [playMedia]);

  const openRoomRankPanel = useCallback(async () => {
    if (!roomPlayer?.liveId) {
      setRankRows([]);
      setRankStatus(t('该直播来源暂不支持贡献榜（如快捷开播/分享卡）'));
      setRankVisible(true);
      return;
    }
    setRankVisible(true);
    setRankStatus('');
    setRankRows([]); // ⚠️【串台修复】先清空旧场次的榜单，避免新请求返回前显示上一场的贡献榜
    try {
      const res = await pocketApi.getLiveRank(String(roomPlayer.liveId));
      const rows = normalizeLiveRank(res);
      setRankRows(rows);
      setRankStatus(rows.length ? t('已加载 {count} 位贡献用户', { count: rows.length }) : t('贡献榜为空'));
    } catch (error) {
      setRankRows([]);
      setRankStatus(t('贡献榜加载失败：{msg}', { msg: errorMessage(error) }));
    }
  }, [roomPlayer, t]);

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

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = followed;
    if (q) {
      list = followed.filter((item) => {
        const member = item.member;
        if (!member) return false;
        return memberSearchText(member).includes(q);
      });
    }
    const pinnedIds = new Set(pinned);
    // 置顶成员按 pinned 数组顺序排列（可调换），未置顶保持原序
    const pinIdx = (id: string) => pinned.indexOf(id);
    /**
     * 未读判据必须与房间行的角标**完全一致**（实时计数 / 时间 / 指纹），
     * 否则会出现「角标亮了但房间没上浮」这种自相矛盾的状态。
     */
    const roomHasUnread = (item: any): boolean => {
      const key = String(item?.memberId || item?.member?.id || '');
      if (!key) return false;
      if (Number(roomUnreadCounts[key] || 0) > 0) return true;
      const activity = roomLastActivity(item);
      if (activity > 0 && activity > Number(roomLastReadAt[key] || 0)) return true;
      const token = roomToken(item);
      const seen = String(roomSeenTokens[key] || '');
      return !!token && !!seen && token !== seen;
    };
    /**
     * 排序分组（用户要求「有新消息的偶像置顶」）：
     *   0 = 有新消息（最高优先）→ 1 = 手动置顶 → 2 = 其余
     * 组内：置顶组按 pinned 顺序，其余保持原序（不干扰用户自己排的顺序）。
     */
    const groupRank = (item: any) =>
      roomHasUnread(item) ? 0 : pinnedIds.has(item.memberId) ? 1 : 2;
    return list
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const ga = groupRank(a.item);
        const gb = groupRank(b.item);
        if (ga !== gb) return ga - gb;
        if (ga === 1) {
          const pa = pinIdx(a.item.memberId);
          const pb = pinIdx(b.item.memberId);
          if (pa !== pb) return pa - pb;
        }
        return a.index - b.index;
      })
      .map((entry) => entry.item);
  }, [followed, searchQuery, pinned, roomUnreadCounts, roomLastReadAt, roomSeenTokens]);


  // 搜索时从全量成员库匹配（未关注的成员可直接在此关注）
  const memberHits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
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
  }, [members, searchQuery, followedIds]);

  const filteredRoomMessages = useMemo(() => {
    if (!selectedRoom) return roomMessages;
    // ① 关闭「所有人发言」时，粉丝消息必须从列表里剔除。
    //    —— 服务端 fetchAll 只影响「新拉的」数据，之前拉过的粉丝消息会留在本地：
    //    既会被显示出来，又会把同一位成员的连续发言「隔开」（用户反馈的老问题）。
    const base = showFanMessages
      ? roomMessages
      : roomMessages.filter((item) => messageRole(item, selectedRoom, false, currentUserId, memberIdSet) !== 'fan');
    const q = roomSearchQuery.trim().toLowerCase();
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
  }, [roomMessages, roomSearchQuery, selectedRoom, showFanMessages, currentUserId, memberIdSet]);


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
      rows.push({ type: 'msg', key: messageKey(item), item, index, groupStart: true });
    });
    return rows;
  }, [filteredRoomMessages, selectedRoom, t]);

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

  const _unusedRenderChineseDay = useCallback(({ date }: any) => date, []);

  /** 纯椭圆玻璃气泡（材质 = 全站同一套 GlassSurface）；左右分列由库的 position 决定 */
  const renderEllipseGlassBubble = useCallback(({ currentMessage, position }: any) => {
    const msg = currentMessage as any;
    const mine = position === 'right';
    const d = msg.createdAt instanceof Date ? msg.createdAt : new Date(msg.createdAt);
    const hh = Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return (
      <GlassSurface
        role="chip"
        radius={22}
        tintColor={mine ? palette.tint : undefined}
        style={styles.ellipseBubble}
      >
        {msg.user?.name && !mine ? (
          <Text style={[styles.ellipseName, { color: palette.tint }]} numberOfLines={1}>{msg.user.name}</Text>
        ) : null}
        {msg.text ? (
          <Text style={[styles.ellipseText, { color: mine ? palette.onTint : palette.label }]}>{msg.text}</Text>
        ) : null}
        {hh ? (
          <Text style={[styles.ellipseTime, { color: mine ? 'rgba(255,255,255,0.75)' : palette.labelTertiary }]}>{hh}</Text>
        ) : null}
      </GlassSurface>
    );
  }, [palette]);

  const chatIms = useMemo(() => {
    if (!selectedRoom) return [];
    const ims = chatRows
      .filter((row: any) => row.type === 'msg' && row.item)
      .map((row: any) => {
        const item = row.item;
        const room = selectedRoom as Member;
        const role = messageRole(item, room, showFanMessages, currentUserId, memberIdSet);
        const mine = role === 'mine';
        const sec = Number(item?.msgTime || item?.ctime || item?.timestamp || 0);
        const ms = sec > 1e12 ? sec : sec * 1000;
        const senderId = String(
          item?.user?.userId || item?.user?.id || item?.senderUserId || item?.senderId ||
          item?.fromUserId || item?.userId || senderProfile(item, room)?.id ||
          (mine ? currentUserId : 'peer'),
        );
        const prof = senderProfile(item, room);
        return {
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
      });
    /**
     * 「上次看到这里」分隔行：进房时快照的旧基线（roomEntryBaseline）之后的**第一条**消息。
     * 取「基线之后最早的一条」，加载更早历史（loadMore）后分隔行仍锚在同一条消息上。
     * 基线为 0（从未读过该房间）→ 不显示。
     */
    if (roomEntryBaseline > 0 && ims.length) {
      let first: (typeof ims)[number] | null = null;
      for (const im of ims) {
        const ms = (im.createdAt as Date).getTime();
        if (ms > roomEntryBaseline && (!first || ms < (first.createdAt as Date).getTime())) first = im;
      }
      if (first) (first as any).__lastSeen = true;
    }
    return ims;
  }, [chatRows, selectedRoom, showFanMessages, currentUserId, memberIdSet, roomEntryBaseline]);

  /**
   * 「上次看到」自动定位（用户要求）：进房后自动滚到分隔行 —— 分隔行贴视口顶部，
   * 它之后（更新的）消息自然都在眼前。每次进房只定位一次；列表晚于本 effect 渲染时
   * 由 350ms 延时兜底。
   */
  useEffect(() => {
    if (!selectedRoom || roomEntryBaseline <= 0) return;
    const idx = chatIms.findIndex((im: any) => im.__lastSeen);
    if (idx < 0) return;
    const key = `${String(selectedRoom.id || '')}-${roomEntryBaseline}`;
    if (lastSeenScrollDoneRef.current === key) return;
    lastSeenScrollDoneRef.current = key;
    const timer = setTimeout(() => {
      try {
        chatListRef.current?.scrollToIndex?.({ index: idx, viewPosition: 0, animated: false });
      } catch {
        // 高度未估出时 FlatList 可能抛错：忽略，停留在最新消息处
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [chatIms, selectedRoom, roomEntryBaseline]);

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
    const title = `${shortName(room, key)} · ${t('上麦')}`;
    useMiniPlayerStore.getState().open({
      url,
      title,
      cover: (room as any).avatar,
      isLive: true,
      audioOnly: true,
      backTo: { mode: 'live', playUrl: url, playTitle: title, playCover: (room as any).avatar },
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

  /**
   * 房间卡片长按 → 快捷操作菜单（对齐桌面 followed-rooms-feature.executeQuickAction）。
   * ⚠️ 用自研 Modal 而不是 Alert：**Android 的 Alert 只渲染前 3 个按钮**，
   * 放不下「大/小房间 + 置顶 + 上移下移 + 关注 + 未读提醒」这么多操作。
   */
  const [roomMenu, setRoomMenu] = useState<any | null>(null);
  const closeRoomMenu = useCallback(() => setRoomMenu(null), []);
  const roomMenuActions = useMemo(() => {
    const item = roomMenu;
    if (!item) return [] as { key: string; icon: string; label: string; danger?: boolean; onPress: () => void }[];
    const member = item.member;
    const name = shortName(member, item.memberId);
    const isPinned = pinned.includes(item.memberId);
    const pIdx = pinned.indexOf(item.memberId);
    const fid = String(member?.id || item.memberId);
    const isFollowing = followedIds.has(fid);
    const run = (fn: () => void) => () => { setRoomMenu(null); fn(); };
    const rows: { key: string; icon: string; label: string; danger?: boolean; onPress: () => void }[] = [
      { key: 'big', icon: 'home-city-outline', label: t('进入大房间'), onPress: run(() => member && openRoom(member, 'big', showFanMessages)) },
      { key: 'small', icon: 'home-outline', label: t('进入小房间'), onPress: run(() => member && openRoom(member, 'small', showFanMessages)) },
      { key: 'pin', icon: isPinned ? 'pin-off-outline' : 'pin-outline', label: isPinned ? t('取消置顶') : t('置顶'), onPress: run(() => togglePin(item.memberId)) },
    ];
    if (isPinned && pIdx > 0) rows.push({ key: 'up', icon: 'arrow-up', label: t('置顶上移'), onPress: run(() => movePin(item.memberId, -1)) });
    if (isPinned && pIdx >= 0 && pIdx < pinned.length - 1) rows.push({ key: 'down', icon: 'arrow-down', label: t('置顶下移'), onPress: run(() => movePin(item.memberId, 1)) });
    rows.push({
      key: 'follow',
      icon: isFollowing ? 'account-remove-outline' : 'account-plus-outline',
      label: isFollowing ? t('取消关注') : t('关注'),
      danger: isFollowing,
      onPress: run(() => member && toggleFollow(member)),
    });
    return rows;
  }, [roomMenu, pinned, followedIds, openRoom, showFanMessages, t, togglePin, movePin, toggleFollow]);

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

  const renderChatItem = useCallback(
    ({ item: row }: { item: any }) => {
      const item = row.item;
      const rowKey = String(row.key);
      // 最后一道防线：服务端偶发脏数据（undefined/null 元素）直接渲染空行，不崩
      if (!item) return <View />;
      const room = selectedRoom as Member;
      const role = messageRole(item, room, showFanMessages, currentUserId, memberIdSet);
      const mine = role === 'mine';
      const idol = role === 'idol';
      const msgProfile = senderProfile(item, room);
      // 发送者是否是「本房房主」：皇冠（房主标）只给房主（用户要求：别的成员不带皇冠）
      const isRoomOwner = isIdolMessage(item, room, showFanMessages);
      // 发送者若是「成员库里的成员」（**不一定是房主**），就用他自己的档案 + 他自己的队伍标签。
      // 此前非房主成员在别人房间发言，被 isIdolMessage 直接判成 fan
      //（只要 profile.id 存在且 ≠ 房主就 return false）→ 没名字/没头像/没队标。
      // ⚠️ senderMember 必须优先于「房主房间档案」：否则其他成员发言会套用房主的名字/头像。
      const senderId = String(msgProfile.id || '').trim();
      const senderMember = senderId
        ? (members.find((m: any) => [m.id, m.userId, m.memberId].some((v) => String(v ?? '').trim() === senderId)) as Member | undefined)
        : undefined;
      const isMemberSender = !!senderMember
        // 兜底（桌面端语义 followed-chat-feature.js:4087）：ext.user.roleId > 1 即成员
        || (Number((extraInfo(item) as any)?.user?.roleId ?? 0) || 0) > 1;
      // 成员发言头像：优先用 API（消息携带）的真实头像；成员库 avatar 多为公式照，仅兜底
      const profile = senderMember
        ? { id: senderMember.id, name: (msgProfile.name || '').trim() || senderMember.ownerName, avatar: msgProfile.avatar || senderMember.avatar }
        : (isRoomOwner
          ? { id: room.id, name: (msgProfile.name || '').trim() || shortName(room), avatar: msgProfile.avatar || room.avatar }
          : msgProfile);
      // 队伍标签：其他成员用他自己的档案，房主用房间档案（用户要求：放每条消息名字后面）
      const tagSource: any = senderMember || (isRoomOwner ? room : undefined);
      const teamGroup = String(tagSource?.groupName || '').trim();
      const teamName = String(tagSource?.team || '').trim();
      // 用户要求：队标「分团区分去掉」—— 只显示队伍（Team X），不再拼团名前缀
      const teamText = teamName || '';
      const teamLogo = String(tagSource?.teamLogo || '').trim();
      const media = roomMedia(item);
      const gift = roomGiftInfo(item);
      const payload = messagePayload(item) as any;
      const replyInfo = payload?.replyInfo || payload?.giftReplyInfo;
      const replyName = replyInfo?.replyName || '';
      const replyQuoted = replyInfo?.replyText || '';
      const body = messageText(item);
      let giftReplyText = '';
      if (gift) {
        const gr = payload?.giftReplyInfo || {};
        giftReplyText = gr.text || payload.text || payload.body || gr.replyName || gr.replyText || '';
        if (typeof giftReplyText === 'string') giftReplyText = giftReplyText.trim();
        else giftReplyText = '';
      }
      // 成员公开翻牌回复：正文应是「回答」，提问放在 replyInfo 引用卡里。
      // 历史 bug（#10）：正文只取到 content（=提问）→ 房间内看不到成员回复内容。
      const flipAnswerRaw = firstTextFrom([payload, item, body], ['answerContent', 'answer', 'answerText', 'replyContent']);
      let flipAnswer = '';
      if (flipAnswerRaw) {
        try {
          const j = typeof flipAnswerRaw === 'string' ? JSON.parse(flipAnswerRaw) : flipAnswerRaw;
          flipAnswer = j && typeof j === 'object' ? String((j as any).text || (j as any).content || '') : String(flipAnswerRaw);
        } catch {
          flipAnswer = String(flipAnswerRaw);
        }
      }
      const baseText = flipAnswer || body;
      const isMediaLabel = /^\[(语音|图片|视频|链接|直播)\]/.test(baseText);
      const looksLikeFile = !media && /^https?:\/\//i.test(String(baseText || '')) || /\.(amr|mp3|m4a|aac|mp4|mov|jpg|jpeg|png|gif|webp)(\?|$)/i.test(String(baseText || ''));
      const bubbleText = gift ? giftReplyText : (media ? (!isMediaLabel ? baseText : '') : (looksLikeFile ? '' : baseText));
      const canInlinePlay = media?.type === 'audio' || media?.type === 'video' || media?.type === 'live';
      // 点头像能打开什么：成员（房主 / 成员库里的其他成员）→ 资料卡（带成员信息）；否则按发送者 id 试用户资料
      const avatarMember: Member | null = senderMember || (isRoomOwner ? room : null);
      // 消息 ext.user.userId = 发送者的口袋 userId（官方 getChannelBaseParams 结构）→ 查资料最靠谱的 id
      const extUser: any = (extraInfo(item) as any)?.user || {};
      const extUserId = String(extUser?.userId ?? extUser?.user_id ?? extUser?.id ?? '').trim();
      const canOpenProfile = !!avatarMember || !!senderId || !!extUserId;

      return (
        <View style={[styles.chatRow, mine && styles.chatRowMine, !row.groupStart && styles.chatRowTight]}>
          {!mine ? (
            row.groupStart ? (
              /* 点头像 → 加载对方个人资料：成员进「成员档案」，非成员弹「用户资料卡」 */
              <TouchableOpacity
                activeOpacity={0.8}
                disabled={!canOpenProfile}
                onPress={() => openSenderProfile({ id: senderId, name: profile.name, avatar: profile.avatar, member: avatarMember, userIds: [extUserId] })}
              >
                {profile.avatar ? (
                  <Image source={{ uri: thumbUrl(profile.avatar, AVATAR_THUMB_WIDTH) }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatarFallback, { backgroundColor: palette.fill2 }]}><Text style={[styles.avatarText, { color: palette.tint }]}>{avatarInitial(profile.name)}</Text></View>
                )}
              </TouchableOpacity>
            ) : (
              /* 组内连排：占位保持气泡左对齐 */
              <View style={styles.avatarPlaceholder} />
            )
          ) : null}
          <View style={[styles.msgBlock, mine && styles.msgBlockMine]}>
            {/* 组首显示名字 + HH:mm；组内不重复 */}
            {row.groupStart ? (
              <View style={[styles.msgMetaLine, mine && styles.msgMetaLineMine]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {/* 皇冠 = 房主标：只给本房房主（用户要求：别的成员不带皇冠） */}
                  {isRoomOwner ? <MaterialCommunityIcons name="crown" size={11} color={palette.tint} /> : null}
                  <Text style={[styles.msgSender, { color: (isRoomOwner || isMemberSender) ? palette.tint : mine ? palette.tint : palette.labelSecondary }]} numberOfLines={1}>
                    {profile.name}
                  </Text>
                  {/* 队伍标签：紧跟发送者名字（成员消息，**含其他成员在别人房间发言**）；有官方队标显示图，否则文字 */}
                  {(isRoomOwner || isMemberSender) && (teamText || teamLogo) ? (
                    <View style={[styles.msgTeamChip, { backgroundColor: palette.tintSoft }]}>
                      {teamLogo ? <NetworkImage source={{ uri: teamLogo }} style={styles.msgTeamLogo} resizeMode="contain" thumbnail={120} /> : null}
                      {teamText ? <Text style={[styles.msgTeamText, { color: palette.tint }]} numberOfLines={1}>{teamText}</Text> : null}
                    </View>
                  ) : null}
                </View>
                {/* 时间加遮罩：房间底图花/亮时「HH:mm」会糊掉。浅色主题用更轻的 timeMask（见上） */}
                <Text style={[styles.msgTime, styles.labelMaskPill, { color: timeMaskFg, backgroundColor: timeMaskBg }]}>
                  {formatTimestamp(item.msgTime).slice(11, 16)}
                </Text>
              </View>
            ) : null}
            {/* 气泡 = 玻璃（内容进玻璃）。「自己」用 tint 染色玻璃（实心强调），
                主播/他人走默认白深纱玻璃 —— 与底栏同一套材质 */}
            <GlassSurface
              role="chip"
              radius={18}
              onLongPress={mine ? () => confirmDeleteMessage(item) : undefined}
              tintColor={mine ? palette.tint : undefined}
              style={[
                styles.msgBubble,
                // 用户要求：气泡统一纯椭圆，不做「贴头像侧方角」的尾巴变体。
                // 也不再叠自己的 hairline 描边 —— 全部交给 GlassSurface 的材质描边，
                // 这样气泡与底栏/卡片是同一套玻璃（描边不会双重叠、不会显得“另一个材质”）。

              ]}
            >
              {replyName || replyQuoted ? (
                <View style={[styles.replyCard, { backgroundColor: mine ? 'rgba(255,255,255,0.18)' : idol ? palette.tintSoft : palette.fill2, borderLeftColor: mine ? 'rgba(255,255,255,0.85)' : palette.tint }]}>
                  {replyName ? <Text style={[styles.replyName, { color: mine ? palette.onTint : idol ? palette.tint : palette.tint }]} numberOfLines={1}>{replyName}</Text> : null}
                  {replyQuoted ? <Text style={[styles.replyText, { color: mine ? 'rgba(255,255,255,0.85)' : idol ? palette.labelSecondary : palette.labelSecondary }]} numberOfLines={3}>{replyQuoted}</Text> : null}
                </View>
              ) : null}
              {bubbleText ? (
                <Text style={[styles.msgBody, (mine || idol) && styles.msgBodyHighlight, { color: mine ? palette.onTint : idol ? palette.label : palette.labelSecondary }]}>
                  {bubbleText}
                </Text>
              ) : null}
              {gift && !giftReplyText ? (
                <View style={[styles.giftCard, { backgroundColor: palette.fill2, borderColor: palette.tintSoft }, giftReplyText ? styles.giftCardCompact : null]}>
                  {!giftReplyText ? (gift.image ? <NetworkImage source={{ uri: gift.image }} style={[styles.giftImage, { backgroundColor: palette.surfaceGlassStrong }]} thumbnail={180} /> : <View style={[styles.giftImageFallback, { backgroundColor: palette.tint }]}><MaterialCommunityIcons name="gift" size={16} color={palette.onTint} /></View>) : null}
                  <View style={styles.giftTextWrap}>
                    <Text style={[styles.giftName, { color: palette.label }]} numberOfLines={1}>{isRoomOwner ? t('感谢礼物') : t('送出礼物')}：{gift.name}</Text>
                    <Text style={[styles.giftMeta, { color: palette.labelSecondary }]}>{t('数量')} x{gift.num}{gift.total ? ` · ${gift.total}` : ''}</Text>
                  </View>
                </View>
              ) : null}
              {media ? (
                media.type === 'image' && media.url ? (
                <>
                  <TouchableOpacity onPress={() => setFullImageUrl(media.url)} onLongPress={() => downloadMedia(media)} activeOpacity={0.9}>
                    {/* ⚠️ 房间图片消息走缩略图：原图动辄 1-3MB/张（1080-3000px），显示仅 228dp。
                        缩略图失败自动退回原图（NetworkImage 两段兜底）；点开大图仍是原图。 */}
                    <NetworkImage
                      source={{ uri: media.url }}
                      style={media.title === t('表情') ? styles.inlineSticker : styles.inlineImage}
                      resizeMode="cover"
                      thumbnail={media.title === t('表情') ? 400 : 700}
                    />
                  </TouchableOpacity>
                </>
              ) : media.type === 'live' && media.cover ? (
                <TouchableOpacity style={styles.liveCardWrap} onPress={() => playMedia(media)} onLongPress={() => downloadMedia(media)} activeOpacity={0.9}>
                  <LiveCoverImage uri={media.cover} palette={palette} />
                  <View style={styles.liveCardOverlay}>
                    <View style={styles.livePlayCircle}>
                      <MaterialCommunityIcons name="play" size={22} color="#FFFFFF" style={{ marginLeft: 3 }} />
                    </View>
                  </View>
                  <View style={styles.liveCardTitleBar}>
                    <Text style={styles.liveCardTitle} numberOfLines={1}>{media.title}</Text>
                  </View>
                </TouchableOpacity>
              ) : media.type === 'video' && media.url ? (
                (roomPlayer?.url === media.url || playingMedia?.url === media.url) ? null : (
                  <VideoCoverCard media={media} onPress={() => playMedia(media)} onLongPress={() => downloadMedia(media)} />
                )
              ) : media.type === 'audio' ? (
                // 音频播放时不返回 null（否则整张卡片塌缩成小方块）：AudioMediaCard 自带播放中态（暂停按钮）。
                // 隐藏探测 Video 在 AudioMediaCard 内部，无需外部 inlineAudio 撑高。
                <AudioMediaCard
                  media={media}
                  palette={palette}
                  playing={!!(playingMedia?.url && media.url && playingMedia.url === media.url)}
                  onPlay={() => playMedia(media)}
                  onLongPress={() => downloadMedia(media)}
                />
              ) : (
                <TouchableOpacity style={[styles.mediaCard, { backgroundColor: (idol || mine) ? palette.tint : palette.surfaceGlass, borderColor: (idol || mine) ? 'rgba(255,255,255,0.38)' : palette.innerStroke, borderWidth: StyleSheet.hairlineWidth }]} activeOpacity={0.92} onLongPress={() => downloadMedia(media)}>
                  {media.cover ? (
                    <NetworkImage source={{ uri: media.cover }} style={styles.liveCover} resizeMode="cover" thumbnail={700} />
                  ) : null}
                  <View style={styles.mediaMeta}>
                    <Text style={[styles.mediaIcon, (idol || mine) ? { color: palette.onTint } : { color: palette.tint }]}>{t(mediaLabel(media.type))}</Text>
                    {media.type !== 'video' && media.title ? (
                      <Text style={[styles.mediaTitle, (idol || mine) ? { color: palette.onTint } : { color: palette.label }]} numberOfLines={2}>{media.title}</Text>
                    ) : null}
                    {media.duration ? <Text style={[styles.mediaDuration, (idol || mine) ? { color: palette.onTint } : { color: palette.labelSecondary }]}>{media.duration}s</Text> : null}
                  </View>
                  <TouchableOpacity
                    style={[styles.mediaPlayBtn, { backgroundColor: palette.tint, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }]}
                    onPress={() => playMedia(media)}
                    activeOpacity={0.85}
                  >
                    <MaterialCommunityIcons
                      name={playingMedia?.url && media.url && playingMedia.url === media.url ? 'pause' : 'play'}
                      size={14}
                      color={palette.onTint}
                    />
                    <Text style={[styles.mediaPlayText, { color: palette.onTint }]}>
                      {playingMedia?.url && media.url && playingMedia.url === media.url ? t('暂停') : media.duration ? `${media.duration}s` : t('播放')}
                    </Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              )) : (!bubbleText && !gift) ? (
                <Text style={[styles.msgBody, (idol || mine) && styles.msgBodyHighlight, (idol || mine) ? { color: palette.onTint } : { color: palette.labelSecondary }]}>{t('[空消息]')}</Text>
              ) : null}
              {media?.url && playingMedia?.url === media.url && media.type === 'link' ? (
                <TouchableOpacity style={styles.openLinkBtn} onPress={() => Linking.openURL(media.url).catch(() => {})} activeOpacity={0.85}>
                  <Text style={[styles.openLinkText, { color: palette.tint }]} numberOfLines={1}>{media.url}</Text>
                </TouchableOpacity>
              ) : null}
            </GlassSurface>
          </View>
        </View>
      );
    },
    [selectedRoom, showFanMessages, currentUserId, memberIdSet, members, openSenderProfile, confirmDeleteMessage, roomPlayer, playingMedia, palette, t, playMedia, downloadMedia, setFullImageUrl, setPlayingMedia, labelMaskBg, labelMaskFg, timeMaskBg, timeMaskFg]
  );

  /**
   * 房间内横划手势：**向左滑 = 进群聊**（显示全部发言），向右滑 = 回到「只看偶像消息」。
   *
   * ⚠️ 这里用 RN 自带的 `PanResponder`，**不是** RNGH 的 `Gesture.Pan`。
   * 上一版用 RNGH（`GestureDetector` + `activeOffsetX/failOffsetY`）实测**完全没反应**：
   * 它包住的正是 `@kesha-antonov/react-native-chat` 的列表，触摸被列表的原生滚动先接走，
   * 手势拿不到事件。改成 PanResponder 的「只认横向」判据（项目里 `GlassSegmented`
   * 就是这么做的，且已验证能在可滚动内容上工作）：
   *   - `onMoveShouldSetPanResponder` 只在 `|dx| > 14 且 |dx| > |dy| * 1.6` 时才接管 →
   *     竖向滑动（上划翻历史消息）完全不受影响；
   *   - 一旦接管，RN 会自动 `requestDisallowInterceptTouchEvent`，列表不会再抢回去。
   *
   * 只包消息区、不包整个房间：顶部「大/小房间」分段控件自己用 PanResponder 处理横拖
   *（GlassSegmented），包整屏会跟它抢触摸；房间内 Tab 横划已被 lockTabSwipe 全局锁掉，不冲突。
   *
   * PanResponder 只在首帧创建一次，回调通过 ref 读最新实现（与 PlayerChrome 的
   * `progCtl.current` 同一套写法，避免手势闭包里拿到过期的 selectedRoom/showFanMessages）。
   */
  const roomSwipeRef = useRef<(dx: number, vx: number, dy: number) => void>(() => {});
  roomSwipeRef.current = (dx, vx, dy) => {
    if (!selectedRoom) return;
    const flung = Math.abs(vx) > 0.35;
    if (!flung && Math.abs(dx) < 44) return;
    // 竖向位移更大 → 当成在滑列表，不切视图
    if (Math.abs(dx) < Math.abs(dy)) return;
    const toGroup = dx < 0; // 左滑进群聊
    if (toGroup === showFanMessages) return; // 已经在目标视图，不重复请求
    openRoom(selectedRoom, roomMode, toGroup, 'internal');
    showToast(toGroup ? t('已切到群聊，显示全部发言') : t('已切回只看偶像消息'));
  };
  const roomSwipePan = useRef(
    PanResponder.create({
      // 起手不抢；只有横向位移明显大于纵向时才接管（竖向滚动交给列表）
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
      onPanResponderTerminationRequest: () => true,
      onPanResponderRelease: (_e, g) => roomSwipeRef.current(g.dx, g.vx, g.dy),
    }),
  ).current;

  if (selectedRoom) {
    const fid = String(selectedRoom.id || '');
    const isFollowingRoom = followedIds.has(fid);
    const followBusyRoom = followBusy.has(fid);
    // 房间名加载前用中性占位「房间」，不回退成员名 —— 避免「先显示成员名再被真实房间名替换」的闪烁
    const headerTitle = roomMeta.name ? capText(roomMeta.name, 18) : t('房间');
    const roomBgUri = roomMeta.bg || '';
    const roomScrim = resolvedTheme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.42)';
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
        <View style={[styles.container, { paddingBottom: roomPlayer ? 0 : roomKeyboardHeight }]}>
        {roomPlayer ? (
          /* 统一播放器（重写）：房间直播/录播 → PlayerScreen（控制条/全屏/内核路由/小窗/贡献榜） */
          <View style={[styles.roomPlayerPage, { backgroundColor: '#000' }]}>
            <PlayerScreen
              source={{
                kind: roomPlayer.isLive ? 'live' : 'vod',
                url: roomPlayer.url,
                liveId: roomPlayer.liveId,
                needsNativeExo: roomPlayer.needsVlc,
                // 上麦/电台（type='audio'）走纯音频：不渲染画面，省一层黑屏
                audioOnly: roomPlayer.type === 'audio',
                headers: { 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)', Referer: 'https://h5.48.cn/' },
              }}
              // 标题右侧：官方在线人数（直播实时 / 回放为该场结束时的值 —— **都要显示**）
              meta={{
                title: roomPlayer.title,
                cover: roomPlayer.cover,
                stat: roomOnlineNum > 0
                  ? { icon: 'account-multiple', text: t('{n} 人在线', { n: roomOnlineNum }) }
                  : undefined,
              }}
              onVideoSize={(w, h) => { if (w > 0 && h > 0) roomVideoAspectRef.current = { w, h }; }}
              features={{ kernelSwitch: true, rate: !roomPlayer.isLive }}
              extraActions={[
                ...(roomPlayer.isLive
                  ? [{ key: 'gift', icon: 'gift', label: t('礼物'), onPress: () => openRoomGiftPanel() }]
                  : []),
                // 弹幕设置：原先房间直播只有列表、没有设置入口（用户反馈「房间内的直播有弹幕，但没弹幕相关的设置」）
                { key: 'danmaku', icon: 'cog', label: t('弹幕设置'), onPress: () => setShowRoomDanmakuSettings(true) },
                // 弹幕列表：直播用聊天室实时条目、录播用 LRC 时间轴条目（都能开）
                { key: 'danmakuList', icon: 'format-list-bulleted', label: t('弹幕列表'), active: showRoomDanmakuList, onPress: () => setShowRoomDanmakuList((v) => !v) },
                { key: 'pip', icon: 'picture-in-picture-bottom-right-outline', label: t('小窗'), onPress: handleRoomMiniPlayer },
                { key: 'rank', icon: 'trophy', label: t('贡献榜'), onPress: openRoomRankPanel },
              ]}
              barrageInput={roomPlayer.isLive ? (
                <LiveBarrageBoard source={roomBarrage} liveId={roomBarrageLiveId} module="live" inputOnly variant="plain" />
              ) : undefined}
              onClose={closeRoomPlayer}
              persistent
            >
              {/* 飘屏弹幕：覆盖在画面上（zIndex 30，低于控制层 31；pointerEvents none 不挡按钮）。
                  visible 只看开关，不等「有弹幕了」才挂载 —— 否则首条到达时会把连接建立以来
                  攒下的整批弹幕一次性喷上屏。 */}
              <DanmakuOverlay
                // 直播走 liveItems（到即上屏）；回放走 danmaku（按播放时间轴）
                danmaku={roomPlayer.isLive ? NO_DANMAKU : roomVodDanmaku}
                currentTime={roomPlayer.isLive ? 0 : roomDanmakuClock}
                visible={roomDanmakuOn}
                live={!!roomPlayer.isLive}
                liveItems={roomPlayer.isLive ? roomLiveDanmakuItems : undefined}
              />
              {/* 弹幕列表抽屉：房间直播弹幕（列表 + 搜索 + 按发送者筛选） */}
              <DanmakuListSheet
                visible={showRoomDanmakuList}
                onClose={() => setShowRoomDanmakuList(false)}
                // 直播 = 聊天室实时条目（无时间轴）；录播 = LRC 时间轴条目（可点击跳转）
                entries={roomPlayer.isLive ? roomDanmakuEntries : roomVodDanmakuEntries}
                currentTime={roomPlayer.isLive ? 0 : roomDanmakuClock}
                onSeek={roomPlayer.isLive ? undefined : (sec) => usePlayerStore.getState().setSeekTarget(sec)}
                live={!!roomPlayer.isLive}
                loading={roomPlayer.isLive
                  ? (roomBarrage.status === 'connecting' || roomBarrage.status === 'resolving')
                  : false}
              />
              {/* 弹幕设置：与直播页共用同一套面板（总开关/区域/速度/字号/不透明度） */}
              <DanmakuSettingsSheet
                visible={showRoomDanmakuSettings}
                onClose={() => setShowRoomDanmakuSettings(false)}
              />
            </PlayerScreen>
            <Modal visible={rankVisible} transparent animationType="slide" onRequestClose={() => setRankVisible(false)}>
              <View style={styles.roomModalShade}>
                <GlassSurface radius={22} role="card" style={[styles.roomRankPanel, isRoomLandscape ? styles.roomRankPanelLandscape : null, { backgroundColor: 'transparent' }]}>
                  {/* 顶部 handle */}
                  <View style={styles.roomRankHandleWrap}>
                    <View style={[styles.roomRankHandle, { backgroundColor: palette.fill3 }]} />
                  </View>
                  <View style={styles.roomRankHeader}>
                    <Text style={[styles.roomRankTitle, { color: palette.label }]}>{t('贡献榜')}</Text>
                    <ScalePressable onPress={() => setRankVisible(false)} pressedScale={0.92} activeOpacity={0.8} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                      <View style={[styles.roomRankClose, { backgroundColor: palette.fill2 }]}>
                        <MaterialCommunityIcons name="close" color={palette.labelSecondary} size={18} />
                      </View>
                    </ScalePressable>
                  </View>
                  <Text style={[styles.roomRankStatus, { color: palette.labelSecondary }]}>{rankStatus}</Text>
                  <ScrollView style={[styles.roomRankList, isRoomLandscape ? styles.roomRankListLandscape : null]} showsVerticalScrollIndicator={false}>
                    {(() => {
                      // 归一化进度条：取最高贡献值作为基准
                      const maxValue = rankRows.reduce((max, r) => Math.max(max, Number(r.value) || 0), 0);
                      return rankRows.map((row, index) => {
                        const valNum = Number(row.value) || 0;
                        const progress = maxValue > 0 ? Math.max(0, Math.min(1, valNum / maxValue)) : 0;
                        return (
                          <View key={String(row.userId || row.id || index)} style={[styles.roomRankRow, { borderBottomColor: palette.hairline }]}>
                            <Text style={[styles.roomRankNo, { color: palette.tint }]}>{row.rank || index + 1}</Text>
                            {row.avatar ? <NetworkImage source={{ uri: row.avatar }} style={[styles.roomRankAvatar, { backgroundColor: palette.fill3 }]} thumbnail={180} /> : <View style={[styles.roomRankAvatar, { backgroundColor: palette.fill3 }]} />}
                            <View style={styles.roomRankInfo}>
                              <Text style={[styles.roomRankName, { color: palette.label }]} numberOfLines={1}>{row.name}</Text>
                              <View style={[styles.roomRankProgressTrack, { backgroundColor: palette.fill3 }]}>
                                <View style={[styles.roomRankProgressFill, { width: `${progress * 100}%`, backgroundColor: palette.tint }]} />
                              </View>
                            </View>
                            <Text style={[styles.roomRankValue, { color: palette.labelSecondary }]} numberOfLines={1}>{row.value ? t('贡献 {value}', { value: row.value }) : t('贡献用户')}</Text>
                          </View>
                        );
                      });
                    })()}
                  </ScrollView>
                </GlassSurface>
              </View>
            </Modal>
            <Modal visible={giftVisible} transparent animationType="slide" onRequestClose={() => setGiftVisible(false)}>
              <View style={styles.roomModalShade}>
                <GlassSurface radius={22} role="card" style={[styles.roomRankPanel, isRoomLandscape ? styles.roomRankPanelLandscape : null, { backgroundColor: 'transparent' }]}>
                  <View style={styles.roomRankHandleWrap}>
                    <View style={[styles.roomRankHandle, { backgroundColor: palette.fill3 }]} />
                  </View>
                  <View style={styles.roomRankHeader}>
                    <Text style={[styles.roomRankTitle, { color: palette.label }]}>{t('直播送礼')}</Text>
                    <ScalePressable onPress={() => setGiftVisible(false)} pressedScale={0.92} activeOpacity={0.8} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                      <View style={[styles.roomRankClose, { backgroundColor: palette.fill2 }]}>
                        <MaterialCommunityIcons name="close" color={palette.labelSecondary} size={18} />
                      </View>
                    </ScalePressable>
                  </View>
                  <Text style={[styles.roomRankStatus, { color: palette.danger }]}>{t('直播送礼主播看不到赠送，仅能统计贡献值')}</Text>
                  <Text style={[styles.roomRankStatus, { color: palette.labelSecondary }]}>
                    {giftBalance ? `${t('余额：{balance} 鸡腿', { balance: giftBalance })} · ` : ''}{giftStatus}
                  </Text>
                  <ScrollView style={[styles.roomRankList, isRoomLandscape ? styles.roomRankListLandscape : null]} showsVerticalScrollIndicator={false}>
                    {giftList.map((g, index) => {
                      const gid = String(g.giftId || g.id || '');
                      const gname = String(g.giftName || g.name || t('礼物 {n}', { n: index + 1 }));
                      const cost = g.cost ?? g.price ?? g.money ?? 0;
                      return (
                        <TouchableOpacity
                          key={gid || index}
                          style={[styles.roomRankRow, { borderBottomColor: palette.hairline, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
                          onPress={() => { setGiftSel(g); setGiftNum(1); }}
                          activeOpacity={0.85}
                        >
                          <Text style={[styles.roomRankName, { color: palette.label, flex: 1 }]} numberOfLines={1}>{gname}</Text>
                          {Number(cost) > 0 ? (
                            <Text style={[styles.roomRankValue, { color: palette.labelSecondary }]}>{t('{cost} 鸡腿/个', { cost })}</Text>
                          ) : null}
                          {giftSel && String(giftSel.giftId || giftSel.id || '') === gid ? <MaterialCommunityIcons name="check-circle" color={palette.tint} size={18} /> : null}
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <ScalePressable style={[styles.liveResolveBtnGhost, { paddingHorizontal: 12, paddingVertical: 6 }]} pressedScale={0.92} activeOpacity={0.8} onPress={() => setGiftNum((n) => Math.max(1, n - 1))}>
                        <Text style={[styles.liveResolveBtnGhostText, { color: palette.tint }]}>−</Text>
                      </ScalePressable>
                      <Text style={[styles.roomRankTitle, { color: palette.label }]}>{giftNum}</Text>
                      <ScalePressable style={[styles.liveResolveBtnGhost, { paddingHorizontal: 12, paddingVertical: 6 }]} pressedScale={0.92} activeOpacity={0.8} onPress={() => setGiftNum((n) => Math.min(999, n + 1))}>
                        <Text style={[styles.liveResolveBtnGhostText, { color: palette.tint }]}>＋</Text>
                      </ScalePressable>
                    </View>
                    <ScalePressable style={[styles.liveResolveBtn, { backgroundColor: '#ff6f91', paddingHorizontal: 18, paddingVertical: 8 }]} pressedScale={0.95} activeOpacity={0.85} onPress={sendRoomGift}>
                      <Text style={styles.liveResolveBtnText}>{t('发送')}</Text>
                    </ScalePressable>
                  </View>
                </GlassSurface>
              </View>
            </Modal>
          </View>
        ) : null}
        {liveResolve ? (
          /* 直播解析占位：无流地址直播卡点击后立即反馈（转圈/失败重试），出地址后由正式播放器接管 */
          <View style={[styles.roomPlayerPage, { backgroundColor: '#000' }]}>
            <TouchableOpacity style={styles.liveResolveClose} onPress={cancelLiveResolve} activeOpacity={0.8} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <View style={styles.liveResolveCloseBtn}>
                <MaterialCommunityIcons name="close" color="#fff" size={20} />
              </View>
            </TouchableOpacity>
            <View style={styles.liveResolveWrap}>
              {liveResolve.error ? (
                <>
                  <MaterialCommunityIcons name="alert-decagram-outline" color="#ff8fa3" size={46} />
                  <Text style={styles.liveResolveTitle}>{t('直播地址解析失败')}</Text>
                  <Text style={styles.liveResolveText}>{liveResolve.error}</Text>
                  <View style={styles.liveResolveBtns}>
                    <ScalePressable style={[styles.liveResolveBtn, { backgroundColor: '#ff6f91' }]} pressedScale={0.96} activeOpacity={0.85} onPress={() => resolveLiveAndOpen(liveResolve.media)}>
                      <Text style={styles.liveResolveBtnText}>{t('重试')}</Text>
                    </ScalePressable>
                    <ScalePressable style={[styles.liveResolveBtnGhost, { borderColor: 'rgba(255,255,255,0.35)' }]} pressedScale={0.96} activeOpacity={0.85} onPress={cancelLiveResolve}>
                      <Text style={styles.liveResolveBtnGhostText}>{t('关闭')}</Text>
                    </ScalePressable>
                  </View>
                </>
              ) : (
                /* 解析中：只转圈不给过程说明（用户反馈「没必要写明出来」；40s 列表缓存+4s 超时已大幅提速） */
                <ActivityIndicator color="#ff6f91" size="large" />
              )}
            </View>
          </View>
        ) : null}
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
        <ZoomImageModal url={fullImageUrl} onClose={() => setFullImageUrl('')} />
        {/* 用户资料卡（房间内点非成员头像）：口袋48 user/info 拉昵称/头像/等级/签名 */}
        <Modal visible={!!userCard} transparent animationType="slide" onRequestClose={() => setUserCard(null)}>
          <TouchableOpacity style={styles.roomModalShade} activeOpacity={1} onPress={() => setUserCard(null)}>
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.userCardWrap}>
              <GlassSurface radius={22} role="card" style={[styles.userCardPanel, { backgroundColor: 'transparent' }]}>
                <View style={styles.roomRankHandleWrap}>
                  <View style={[styles.roomRankHandle, { backgroundColor: palette.fill3 }]} />
                </View>
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
            </TouchableOpacity>
          </TouchableOpacity>
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

          {/* 聊天工具条：高斯模糊玻璃（按深浅色 tint，不挡房间背景）*/}
          <View style={[styles.chatToolsClip, { borderColor: palette.innerStroke }]}>
            <BlurView
              intensity={70}
              tint={resolvedTheme === 'dark' ? 'dark' : 'light'}
              blurTarget={blurTarget ?? undefined}
              blurMethod="dimezisBlurViewSdk31Plus"
              /* ⚠️【功耗/卡顿】必须给降采样系数：不传 = 全分辨率模糊，
                 这条工具条常驻且叠在滚动消息列表上方，逐帧按原分辨率算 RenderEffect
                 是房间页掉帧/发热的大头（尤其三星）。6 与 GlassSurface 保持同一档。 */
              blurReductionFactor={Platform.OS === 'android' ? 6 : 4}
              style={styles.chatTools}
            >
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
                style={{ width: 168 }}
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
            </BlurView>
          </View>


        <FadeInView delay={80} duration={300} style={{ flex: 1 }}>
          {/* 左滑进群聊 / 右滑回「只看偶像」：手势只包**消息区** ——
              顶部的「大房间/小房间」分段控件自己用 PanResponder 处理横拖，包整屏会抢触摸；
              房间内 Tab 横划已被 lockTabSwipe 全局锁掉。详见上方 roomSwipePan。 */}
            <View style={{ flex: 1 }} {...roomSwipePan.panHandlers}>
              {/* 官方 demo 用法：messages / user / onSend + 官方 loadEarlierMessagesProps */}
              <Chat
                messages={chatIms}
                messagesContainerRef={chatListRef}
                // 背景透明：露出页面/房间背景图（库默认灰底会把它整块盖住）
                theme={{ colors: { background: 'transparent' } }}
                locale="zh"
                // 日期分隔：纯数字「今天/昨天/x月x日」，居中显示（renderDayLabel）
                // 整行自定义：用页面既有的 renderChatItem —— 头像、气泡外的发送者名字、
                // 回复卡片、礼物、媒体全都保留；气泡本身是玻璃（GlassSurface）。
                // 不再用 renderBubble：它只能改气泡内部，名字被迫塞进气泡里（与设计不符）。
                renderMessage={({ currentMessage }: any) => {
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
                }}
                renderDay={renderDayLabel}
                isDayAnimationEnabled={false}
                user={{ _id: 'SELF' }}
                onSend={() => {}}
                renderInputToolbar={() => null}
                // 一键回到底部（用户要求：群聊/只看偶像/大小房间全模式生效 —— 它们共用本组件）。
                // 库内置实现：滚离最新消息超过 scrollToBottomOffset 时浮现圆形↓按钮，点击动画回底。
                // 配色用品牌粉（palette.tint），与软件整体风格一致。
                isScrollToBottomEnabled
                scrollToBottomOffset={300}
                scrollToBottomComponent={() => (
                  <MaterialCommunityIcons name="chevron-double-down" size={18} color={palette.onTint} />
                )}
                scrollToBottomContentStyle={{ backgroundColor: palette.tint }}
                loadEarlierMessagesProps={{
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
                }}
              />
            </View>
        </FadeInView>

        {/* 直播中的实时弹幕（云信聊天室）：与录播弹幕（LRC）是两条独立链路 */}
        {roomPlayer?.isLive && roomPlayer.liveId ? (
          <LiveBarrageBoard
            source={roomBarrage}
            liveId={roomBarrageLiveId}
            module="live"
            height={128}
            hideInput
            style={styles.roomBarrageBoard}
          />
        ) : null}

        {/* 房间发言（云信圈组）：HTTP 侧只有历史，发送必须走云信 */}
        {roomSendHint ? (
          <Text style={[styles.roomSendHint, { color: palette.tint }]} numberOfLines={2}>
            {roomSendHint}
          </Text>
        ) : null}
        <GlassSurface
          role="chip"
          radius={16}
          style={[styles.roomInputBar, { backgroundColor: 'transparent', borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}
        >
          <TextInput
            style={[styles.roomInput, { color: palette.label }]}
            value={roomDraft}
            onChangeText={(next) => {
              setRoomDraft(next);
              if (roomSendHint) setRoomSendHint('');
            }}
            placeholder={t('说点什么…')}
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
          <TouchableOpacity onPress={() => loadFollowed()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.85}>
            <MaterialCommunityIcons name="refresh" size={22} color={palette.label} />
          </TouchableOpacity>
        </View>
      } />

      {/* 房间长按快捷菜单（自研 Modal：Android 的 Alert 只显示前 3 个按钮） */}
      <Modal visible={!!roomMenu} transparent animationType="fade" onRequestClose={closeRoomMenu}>
        <TouchableOpacity style={styles.roomModalShade} activeOpacity={1} onPress={closeRoomMenu}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.roomMenuWrap}>
            <GlassSurface radius={22} role="card" style={[styles.roomMenuPanel, { backgroundColor: 'transparent' }]}>
              <View style={styles.roomRankHandleWrap}>
                <View style={[styles.roomRankHandle, { backgroundColor: palette.fill3 }]} />
              </View>
              <Text style={[styles.roomMenuTitle, { color: palette.label }]} numberOfLines={1}>
                {roomMenu?.member ? shortName(roomMenu.member, roomMenu.memberId) : ''}
              </Text>
              <ScrollView style={[styles.roomMenuList, isRoomLandscape ? styles.roomMenuListLandscape : null]} showsVerticalScrollIndicator={false}>
                {roomMenuActions.map((act) => (
                  <TouchableOpacity
                    key={act.key}
                    style={[styles.roomMenuItem, { borderTopColor: palette.hairline }]}
                    onPress={act.onPress}
                    activeOpacity={0.85}
                  >
                    <MaterialCommunityIcons name={act.icon as any} size={18} color={act.danger ? palette.danger : palette.label} />
                    <Text style={[styles.roomMenuItemText, { color: act.danger ? palette.danger : palette.label }]}>{act.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </GlassSurface>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

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
        {searchOpen && searchQuery.trim() ? (
          /* 搜索态：成员库结果直接走 FlatList（可滚动、虚拟化）。
             单列整行卡（原来是 2 列竖排大卡，一屏只容 3 行、信息密度太低） */
          memberHits.length === 0 ? (
            <Text style={[styles.memberHitsEmpty, { color: palette.labelTertiary }]}>{t('没有匹配的成员')}</Text>
          ) : (
          <PerfFlatList
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
          key="rooms-list"
          data={filtered}
          // 滚动锚点（B6）：30s 静默刷新替换数据 / 置顶重排时保持用户当前可见位置，不被弹回顶部
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          keyExtractor={(item: any, index) => String(item.memberId)}
          contentContainerStyle={styles.listContent}
          renderItem={({ item, index }) => {
            const fid = String(item.member?.id || item.memberId);
            const isFollowing = followedIds.has(fid);
            const busy = followBusy.has(fid);
            const isPinned = pinned.includes(item.memberId);
            const name = shortName(item.member, item.memberId);
            const team = item.member?.team || item.member?.groupName || '';
            const lastText = item.lastMessage ? messageText(item.lastMessage) : '';
            // 直播中判定：以直播列表接口为准（id / liveRoomId / account / 昵称命中关注成员）
            const mid = String(item.member?.id || item.memberId);
            const mroom = String((item.member as any)?.liveRoomId || '');
            const macct = String((item.member as any)?.account || '');
            const mnick = String(item.member?.ownerName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/i, '').trim().toLowerCase();
            const isLiveNow = liveNow.ids.has(mid) || (mroom && liveNow.ids.has(mroom)) || (macct && liveNow.ids.has(macct)) || (mnick && liveNow.names.has(mnick));
            /**
             * 该成员直播间的可跳转信息（liveId/标题/封面）。
             * 用于「点头像直接进她的直播」；取不到时点头像仍退回「进房间」，不会变成死按钮。
             */
            const liveEntry = isLiveNow
              ? (liveNow.byOwner[mid]
                || (mroom ? liveNow.byOwner[mroom] : undefined)
                || (macct ? liveNow.byOwner[macct] : undefined)
                || (mnick ? liveNow.byOwner[mnick] : undefined))
              : undefined;
            // 上麦中：与直播中互斥（一个房间不可能同时直播和上麦），复用直播中徽标槽位
            const isOnMic = !isLiveNow && !!onMicMap[mid];
            /**
             * 未读展示（三条通道，任一命中即出角标）：
             *   - 数字 = 列表挂着时收到的实时消息条数（本地累计，依赖云信通道）
             *   - 「新」= ① 最新消息时间晚于已读基线（服务器时间域）**或**
             *            ② 最新消息**指纹**与已见指纹不同（见 roomToken）
             * ✅ 必须保留 ② ：`/im/api/v1/team/classic/last/message/get` 官方无字段文档，
             *    时间字段名一旦对不上，①就恒为 false —— 用户反馈两次「无任何标注」的另一半原因。
             *    指纹只比较「还是不是同一条最新消息」，与字段名/时间格式无关。
             */
            const unreadCount = Number(roomUnreadCounts[fid] || 0);
            const lastActivity = roomLastActivity(item);
            const lastRead = Number(roomLastReadAt[fid] || 0);
            const token = roomToken(item);
            const seenToken = String(roomSeenTokens[fid] || '');
            const hasUnreadByTime = lastActivity > 0 && lastActivity > lastRead;
            const hasUnreadByToken = !!token && !!seenToken && token !== seenToken;
            const hasUnread = unreadCount === 0 && (hasUnreadByTime || hasUnreadByToken);
            return (
            <FadeInView delay={index < 12 ? 80 + index * 30 : 0} duration={300} style={styles.roomRow}>
              {/* ⚠️ 逐卡禁止 GlassSurface（长列表滚动逐帧重算模糊 → 掉帧）。
                  实底 surfaceGlassStrong + hairline，观感与玻璃卡一致但不进模糊管线。 */}
              <View style={[styles.roomRowCard, { backgroundColor: palette.surfaceGlassStrong, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
                <ScalePressable
                  style={styles.roomRowMain}
                  onPress={() => item.member && openRoom(item.member)}
                  onLongPress={() => setRoomMenu(item)}
                  delayLongPress={400}
                  pressedScale={0.98}
                  activeOpacity={0.9}
                >
                  {/* 封面 56 圆角 12：直播中时挂「直播」角标，且**点封面直接进她的直播**
                      （点卡片其它区域仍是进房间；直播标识也按用户要求放在头像上） */}
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={[styles.roomCover, { backgroundColor: palette.tintSoft, borderColor: palette.hairline }]}
                    onPress={() => {
                      if (!liveEntry) {
                        if (item.member) openRoom(item.member);
                        return;
                      }
                      (navigation as any).navigate('Media', {
                        mode: 'live',
                        playLiveId: liveEntry.liveId,
                        playTitle: liveEntry.title || name,
                        playCover: liveEntry.cover,
                        playNonce: Date.now(),
                      });
                    }}
                  >
                    {item.member?.avatar ? (
                      <Image source={{ uri: thumbUrl(item.member.avatar, AVATAR_THUMB_WIDTH) }} style={styles.roomCoverImg} />
                    ) : (
                      <Text style={[styles.roomCoverText, { color: palette.tint }]} numberOfLines={1}>{avatarInitial(name)}</Text>
                    )}
                    {isLiveNow ? (
                      <View style={[styles.coverLiveBadge, { backgroundColor: palette.tint }]}>
                        <MaterialCommunityIcons name="broadcast" size={9} color={palette.onTint} />
                      </View>
                    ) : null}
                  </TouchableOpacity>
                  <View style={styles.roomInfo}>
                    <View style={styles.roomNameRow}>
                      <Text style={[styles.roomName, { color: palette.label }]} numberOfLines={1}>{name}</Text>
                      {/* 状态点：绿色 = 正在直播（isLiveNow），灰色 = 未在播 */}
                      <View style={[styles.statusDot, { backgroundColor: isLiveNow ? palette.success : palette.labelTertiary }]} />
                      {isLiveNow ? (
                        <View style={[styles.liveBadgeChip, { backgroundColor: palette.tint }]}>
                          <MaterialCommunityIcons name="broadcast" size={10} color={palette.onTint} />
                          <Text style={styles.liveBadgeChipText}>{t('直播中')}</Text>
                        </View>
                      ) : isOnMic ? (
                        <View style={[styles.liveBadgeChip, { backgroundColor: palette.tint }]}>
                          <MaterialCommunityIcons name="microphone" size={10} color={palette.onTint} />
                          <Text style={styles.liveBadgeChipText}>{t('上麦中')}</Text>
                        </View>
                      ) : null}
                      {isPinned ? (
                        <View style={[styles.pinTagChip, { backgroundColor: palette.tintSoft }]}>
                          <MaterialCommunityIcons name="pin" size={10} color={palette.tint} />
                          <Text style={[styles.pinTagChipText, { color: palette.tint }]}>{t('置顶')}</Text>
                        </View>
                      ) : null}
                      {/* 未读（本地口径，官方无房间级未读接口；进房即清零 + 记已读时间） */}
                      {unreadCount > 0 || hasUnread ? (
                        <View style={[styles.unreadBadge, { backgroundColor: palette.tint }]}>
                          <Text style={styles.unreadBadgeText}>
                            {unreadCount > 99 ? '99+' : (unreadCount > 0 ? String(unreadCount) : t('新'))}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    {/* 房间列表信息区恢复原版布局：team 独立行 + 大房间预览 + 小房间预览（各一行）。
                        卡片总高用 minHeight 拉齐：行少成员内容靠底部留白补足 */}
                    {team ? (
                      <Text style={[styles.roomTeam, { color: palette.labelTertiary }]} numberOfLines={1}>{team}</Text>
                    ) : null}
                    {lastText ? (
                      <View style={styles.lastRow}>
                        <View style={[styles.lastTag, { backgroundColor: palette.tintSoft }]}>
                          <Text style={[styles.lastTagText, { color: palette.tint }]}>{t('大')}</Text>
                        </View>
                        <Text style={[styles.roomLast, { color: palette.labelSecondary, marginTop: 0, flex: 1 }]} numberOfLines={1}>
                          {lastText}
                        </Text>
                      </View>
                    ) : null}
                    {(() => {
                      const sMsg = item.lastSmallMessage;
                      if (!sMsg) return null;
                      const sText = messageText(sMsg);
                      if (!sText || sText === lastText) return null;
                      return (
                        <View style={styles.lastRow}>
                          <View style={[styles.lastTag, { backgroundColor: palette.fill2 }]}>
                            <Text style={[styles.lastTagText, { color: palette.labelSecondary }]}>{t('小')}</Text>
                          </View>
                          <Text style={[styles.roomLast, { color: palette.labelTertiary }]} numberOfLines={1}>
                            {sText}
                          </Text>
                        </View>
                      );
                    })()}
                  </View>
                </ScalePressable>
                <View style={styles.roomActions}>
                  <ScalePressable
                    style={[styles.roomPinBtn, { backgroundColor: isPinned ? palette.tintSoft : palette.fill2 }]}
                    onPress={() => togglePin(item.memberId)}
                    pressedScale={0.9}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <MaterialCommunityIcons
                      name={isPinned ? 'pin' : 'pin-outline'}
                      size={15}
                      color={isPinned ? palette.tint : palette.labelTertiary}
                    />
                  </ScalePressable>
                  <ScalePressable
                    style={[styles.roomFollowBtn, { backgroundColor: isFollowing ? palette.tintSoft : palette.fill2 }]}
                    disabled={busy}
                    pressedScale={0.9}
                    activeOpacity={0.85}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    onPress={() => {
                      if (isFollowing) {
                        Alert.alert(
                          t('取消关注'),
                          t('确定不再关注 {name} 吗？', { name: shortName(item.member, item.memberId) }),
                          [
                            { text: t('保留'), style: 'cancel' },
                            { text: t('取消关注'), style: 'destructive', onPress: () => item.member && toggleFollow(item.member) },
                          ],
                        );
                      } else if (item.member) {
                        toggleFollow(item.member);
                      }
                    }}
                  >
                    {busy ? (
                      <ActivityIndicator color={palette.tint} size="small" />
                    ) : (
                      <MaterialCommunityIcons
                        name={isFollowing ? 'heart' : 'heart-outline'}
                        size={17}
                        color={isFollowing ? palette.tint : palette.labelTertiary}
                      />
                    )}
                  </ScalePressable>
                </View>
              </View>
            </FadeInView>
            );
          }}
          ListEmptyComponent={
            searchOpen && searchQuery.trim() ? null : followedLoading ? (
            <CenterSpinner />
          ) : !token ? (
            <EmptyState
              icon="account-key-outline"
              title={t('登录后可查看关注房间和最新消息')}
              actionLabel={t('去登录')}
              onAction={() => navigation.navigate('LoginScreen')}
            />
          ) : followedError ? (
            <ErrorState title={t('加载失败')} hint={followedError} onAction={() => loadFollowed(true)} />
          ) : (
            <EmptyState icon="heart-outline" title={t('暂无关注房间')} />
          )}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
        />
        )}
      </FadeInView>
    </View>
  );
}

/**
 * 空弹幕数组常量（房间页走 liveItems 实时通道，不走时间轴）。
 * 用常量而不是 `danmaku={[]}`：数组字面量每帧都是新引用，会让 DanmakuOverlay
 * 的时间窗 effect 每帧重跑一次（虽然会 Early return，但没必要）。
 */
const NO_DANMAKU: DanmakuItem[] = [];

const styles = StyleSheet.create({
  // 直播弹幕面板（房间页内嵌直播时挂载）
  roomBarrageBoard: { marginHorizontal: 12, marginBottom: 6 },
  // 房间发言条（云信圈组）
  roomInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  roomInput: { flex: 1, minHeight: 36, maxHeight: 96, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, textAlignVertical: 'center', includeFontPadding: false },
  roomSendBtn: { height: 34, borderRadius: 18, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  roomSendBtnText: { fontSize: 13, fontWeight: '700' },
  roomSendHint: { fontSize: 11, marginHorizontal: 16, marginBottom: 4 },
  container: { flex: 1, backgroundColor: 'transparent' },
  /** 房间详情根容器：背景层与 padding 容器分离，保证背景满幅（见 return 处注释） */
  roomRoot: { flex: 1 },
  roomBgLayer: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  ellipseBubble: { paddingVertical: 9, paddingHorizontal: 14, maxWidth: '78%', marginVertical: 2 },
  ellipseName: { fontSize: 11, fontWeight: '700', marginBottom: 2 },
  ellipseText: { fontSize: 15, lineHeight: 21 },
  ellipseTime: { fontSize: 11, marginTop: 3, alignSelf: 'flex-end' },
  daySepWrap: { alignItems: 'center', marginVertical: 10 },
  /**
   * 小字元信息（消息时间 HH:mm、日期分隔「今天」）的遮罩胶囊。
   * 底色不写死在这里 —— 由行内按主题给（见 labelMaskBg/Fg），浅深主题各一套。
   * 房间背景是用户自定义图，没有这层底这些小字会直接糊在花底上。
   */
  labelMaskPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  daySep: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  daySepText: { fontSize: 11, fontWeight: '600', alignSelf: 'center' },
  chatToolsClip: { marginHorizontal: 12, marginBottom: 8, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  chatTools: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 6, borderRadius: 18 },
  segment: {
    flexDirection: 'row',
    borderRadius: radii.pill,
    padding: 3,
    gap: 2,
  },
  segmentItem: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
  },
  segmentText: { fontSize: 12, fontWeight: '800' },
  chatToolCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatDateRow: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  chatDatePill: {
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radii.pill,
  },
  chatDateText: { fontSize: 11, fontWeight: '600' },
  roomSearchWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  roomSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: radiiAlias.input,
    borderWidth: StyleSheet.hairlineWidth,
  },
  roomSearchInput: { flex: 1, fontSize: 14, padding: 0, height: 40 },
  input: { flex: 1, padding: 10, borderRadius: radiiAlias.input, borderWidth: StyleSheet.hairlineWidth },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: radiiAlias.input,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  memberHitsListContent: { paddingHorizontal: 0, paddingBottom: 112 },
  memberHitBtnText: { fontSize: 13, fontWeight: '800' },
  memberHitsEmpty: { textAlign: 'center', marginTop: 40, fontSize: 14 },
  memberGridRow: { paddingHorizontal: 12 },
  memberGridItem: { paddingVertical: 5 },
  // 搜索结果卡：横向一行（头像 + 名字/团队 + 关注按钮），左对齐。
  // 原竖排居中版把 2 列卡片撑到 ~210dp 高，一屏只能看到 3 行；横排后约 84dp。
  memberHitCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingLeft: 10,
    paddingRight: 12,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  memberHitAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  memberHitAvatarImg: { width: 56, height: 56, borderRadius: 28 },
  memberHitAvatarText: { fontSize: 20, fontWeight: '800' },
  // flex:1 + minWidth:0 → 长名字/长队名正常省略，不会把关注按钮挤出卡外
  memberHitMeta: { flex: 1, minWidth: 0 },
  memberHitName: { fontSize: 15, fontWeight: '700' },
  memberHitTeam: { fontSize: 12, marginTop: 3 },
  memberHitBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 62,
    borderWidth: StyleSheet.hairlineWidth,
  },
  memberCard: {
    flex: 1,
    padding: 14,
    borderRadius: 18,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 1,
  },
  memberPin: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  memberAvatar: {
    width: 76,
    height: 76,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  memberAvatarImg: { width: 76, height: 76, borderRadius: 36 },
  memberAvatarText: { fontSize: 26, fontWeight: '800' },
  memberInfo: { alignSelf: 'stretch', marginTop: 12 },
  memberNameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  memberName: { fontSize: 17, fontWeight: '800', flexShrink: 1 },
  memberTeam: { fontSize: 12, fontWeight: '700', textAlign: 'center', marginTop: 4 },
  memberLast: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 6 },
  memberFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  memberTime: { fontSize: 12 },
  listContent: { paddingBottom: 112, paddingTop: 4 },
  /** 房间行卡：封面 56 圆角 12 + 房间名 + 状态点 + 直播中徽标 */
  roomRow: { paddingHorizontal: 16, marginBottom: 8 },
  sectionHeaderWrap: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  sectionHeaderText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  roomRowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    // 等高：内容行数少(仅大消息/无小房间/无 team)的成员也拉到与多行成员一致高度
    minHeight: 112,
  },
  roomRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    // 内容垂直居中：行少成员(无小房间/无 team)不再堆顶部, 视觉上跟行多成员一样
    padding: 12,
  },
  roomCover: {
    width: 56,
    height: 56,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  roomCoverImg: { width: 56, height: 56, borderRadius: radii.md },
  roomCoverText: { fontSize: 22, fontWeight: '800' },
  /**
   * 头像（封面）上的「直播中」角标。
   * ⚠️ roomCover 带 overflow:'hidden'，角标必须贴在四角**内侧**（right/bottom: 0），
   * 用负偏移会被裁掉。
   */
  coverLiveBadge: {
    position: 'absolute', right: 0, bottom: 0,
    width: 20, height: 20, borderTopLeftRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  roomInfo: { flex: 1, minWidth: 0, marginLeft: 12 },
  roomNameRow: { flexDirection: 'row', alignItems: 'center' },
  roomName: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 6 },
  liveBadgeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  liveBadgeChipText: { color: '#FFFFFF', fontSize: 9, fontWeight: '800' },
  roomTeam: { fontSize: 11, marginTop: 3, fontWeight: '600' },
  roomTeamInline: { fontSize: 11, fontWeight: '600' },
  roomLast: { fontSize: 12, marginTop: 4, lineHeight: 16 },
  lastRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  lastTag: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 18,
    height: 16,
    borderRadius: 5,
    marginRight: 6,
    paddingHorizontal: 3,
  },
  lastTagText: { fontSize: 10, fontWeight: '800', lineHeight: 14 },
  roomLastSmall: { fontSize: 11, lineHeight: 15, flex: 1 },
  lastTimeSmall: { fontSize: 10, marginLeft: 6 },
  roomFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  roomTime: { fontSize: 11 },
  roomPinTag: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  pinTagChip: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    marginLeft: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
  },
  pinTagChipText: { fontSize: 9, fontWeight: '800' },
  roomActions: { marginLeft: 6, gap: 6, alignItems: 'center', paddingRight: 12, paddingVertical: 10 },
  /* 排序胶囊：单个圆角方块内竖向排列 ↑ / ↓ */
  sortCapsule: {
    width: 32, height: 32, borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden',
  },
  sortHalfV: { width: 32, height: 15, alignItems: 'center', justifyContent: 'center' },
  sortDividerV: { width: 14, height: StyleSheet.hairlineWidth, alignSelf: 'center' },
  roomPinBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  roomFollowBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  chatContent: { paddingBottom: 132, paddingTop: 4 },
  followBtn: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: radiiAlias.button, alignItems: 'center', justifyContent: 'center', minWidth: 52, height: 26 },
  followBtnText: { fontSize: 11, fontWeight: '800' },
  // 消息发送者名字后面的队伍标签
  msgTeamChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, maxWidth: 128 },
  msgTeamLogo: { width: 11, height: 11, marginRight: 3 },
  msgTeamText: { fontSize: 10, fontWeight: '700' },
  chatFooter: { paddingVertical: 16, alignItems: 'center' },
  chatRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 12, marginTop: 7, marginBottom: 2 },
  chatRowTight: { marginTop: 2, marginBottom: 1 },
  chatRowMine: { justifyContent: 'flex-end' },
  avatar: { width: 40, height: 40, borderRadius: 20, marginRight: 9 },
  avatarPlaceholder: { width: 40, height: 40, marginRight: 9 },
  avatarFallback: { width: 40, height: 40, borderRadius: 20, marginRight: 9, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: '900', fontSize: 15 },
  msgBlock: { maxWidth: '78%', minWidth: 48 },
  msgBlockMine: { alignItems: 'flex-end' },
  replyCard: { marginBottom: 6, padding: 8, borderRadius: radii.sm, borderLeftWidth: 3, borderLeftColor: '#ff6f91' },
  replyName: { fontSize: 12, fontWeight: '700', marginBottom: 2 },
  replyText: { fontSize: 13, lineHeight: 18 },
  // 名字行不要水平内边距：否则名字比气泡左边缘缩进一截（截图中名字与气泡左对齐）
  msgMetaLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  msgMetaLineMine: { justifyContent: 'flex-end' },
  msgSender: { fontSize: 12, fontWeight: '600', maxWidth: 150 },
  msgTime: { fontSize: 10 },
  msgBubble: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 20 },
  msgBody: { fontSize: 15, lineHeight: 22 },
  msgBodyHighlight: {},
  giftCard: { marginTop: 8, minWidth: 210, padding: 10, borderRadius: radiiAlias.cardCompact, backgroundColor: 'rgba(255,240,246,0.88)', borderWidth: 1, borderColor: 'rgba(255,111,145,0.24)', flexDirection: 'row', alignItems: 'center', gap: 10 },
  giftCardCompact: { minWidth: 0, padding: 8, gap: 0 } as any,
  giftImage: { width: 34, height: 34, borderRadius: radii.xs, backgroundColor: '#fff' },
  giftImageFallback: { width: 34, height: 34, borderRadius: radii.xs, backgroundColor: '#ff6f91', alignItems: 'center', justifyContent: 'center' },
  giftEmoji: { color: '#fff', fontSize: 13, fontWeight: '800' },
  giftTextWrap: { flex: 1, minWidth: 0 },
  giftName: { fontSize: 13, fontWeight: '800' },
  giftMeta: { marginTop: 3, fontSize: 11 },
  mediaCard: { marginTop: 8, minWidth: 214, padding: 10, borderRadius: radiiAlias.cardCompact, borderWidth: StyleSheet.hairlineWidth },
  liveCover: { width: '100%', height: 130, borderRadius: 10, marginBottom: 8, backgroundColor: 'rgba(128,128,128,0.1)' },
  liveCardWrap: { marginTop: 8, width: 228, borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.1)' },
  liveCardImg: { width: 228, height: 228, borderRadius: 14 },
  liveCardOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 36, alignItems: 'center', justifyContent: 'center' },
  videoCoverWrap: { marginTop: 8, width: '100%', maxWidth: 228, aspectRatio: 1, borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center' },
  videoCoverImg: { width: '100%', aspectRatio: 1, borderRadius: 14 },
  videoCoverOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  videoCoverDuration: { position: 'absolute', right: 8, bottom: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.5)' },
  videoCoverDurationText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  videoCoverPlaceholder: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.05)' },
  videoCoverPlaceholderText: { color: '#ff6f91', fontSize: 13, fontWeight: '800' },
  livePlayCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  livePlayIcon: { color: '#fff', fontSize: 24, marginLeft: 4 },
  liveCardTitleBar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: 'rgba(0,0,0,0.5)' },
  liveCardTitle: { color: '#fff', fontSize: 13, fontWeight: '700' },
  mediaMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mediaIcon: { fontSize: 12, fontWeight: '900' },
  mediaTitle: { flex: 1, fontSize: 13, fontWeight: '800', lineHeight: 18 },
  mediaDuration: { fontSize: 11, fontWeight: '700' },
  mediaPlayBtn: { marginTop: 9, minHeight: 38, paddingVertical: 9, borderRadius: radiiAlias.button, alignItems: 'center', justifyContent: 'center' },
  mediaPlayText: { fontSize: 13, fontWeight: '900' },
  inlineAudio: { height: 52, minWidth: 224, marginTop: 8 },
  inlineAudioWrap: { height: 0, overflow: 'hidden' },
  inlineAudioHidden: { height: 0, width: 0 },
  // 内联视频已交给 <AdaptiveAspectVideo /> 处理真实宽高比，不再用固定 height/minWidth。
  // （保留 inlineImage / inlineSticker 等其它媒体类型的固定尺寸样式。）
  inlineImage: { width: '100%', maxWidth: 228, aspectRatio: 1, marginTop: 8, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.10)' },
  inlineSticker: { width: 120, height: 120, marginTop: 6, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.05)' },
  openLinkBtn: { marginTop: 8, padding: 8, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.10)', maxWidth: '100%', alignSelf: 'flex-start' },
  openLinkText: { color: '#ff6f91', fontSize: 11, fontWeight: '800' },
  roomPlayerPage: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 1000, elevation: 1000, backgroundColor: '#000' },
  roomPlayerHeader: { flexDirection: 'row', alignItems: 'center', paddingTop: 44, paddingHorizontal: 10, paddingBottom: 8, backgroundColor: '#080808' },
  roomPlayerBack: { padding: 8 },
  roomPlayerBackText: { color: '#ff6f91', fontSize: 14, fontWeight: '900' },
  roomPlayerTitle: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '800' },
  roomPlayerTool: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.12)', marginLeft: 6 },
  roomPlayerToolText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  exitRoomFullscreenBtn: { position: 'absolute', top: 14, right: 14, zIndex: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.58)' },
  exitRoomFullscreenText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  roomNativeVideo: { flex: 1, backgroundColor: '#000' },
  liveResolveClose: { position: 'absolute', top: 48, right: 14, zIndex: 10 },
  liveResolveCloseBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' },
  liveResolveWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 12 },
  liveResolveTitle: { color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  liveResolveText: { color: 'rgba(255,255,255,0.72)', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  liveResolveBtns: { flexDirection: 'row', gap: 12, marginTop: 10 },
  liveResolveBtn: { paddingHorizontal: 26, paddingVertical: 10, borderRadius: 22 },
  liveResolveBtnText: { color: '#fff', fontSize: 14, fontWeight: '900' },
  liveResolveBtnGhost: { paddingHorizontal: 26, paddingVertical: 10, borderRadius: 22, borderWidth: 1 },
  liveResolveBtnGhostText: { color: 'rgba(255,255,255,0.9)', fontSize: 14, fontWeight: '800' },
  roomModalShade: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  roomMenuWrap: { width: '100%' },
  roomMenuPanel: { padding: 10, paddingBottom: 16, borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet },
  roomMenuTitle: { fontSize: 16, fontWeight: '800', paddingHorizontal: 12, paddingBottom: 8 },
  roomMenuList: { maxHeight: 360 },
  /** 横屏：房间菜单列表收窄 + 允许收缩（同上） */
  roomMenuListLandscape: { maxHeight: 180, flexShrink: 1 },
  /** 房间未读角标：小圆角胶囊，最多显示 99+（本地累计，见 src/services/roomUnread.ts） */
  unreadBadge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', marginLeft: 6 },
  unreadBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800', lineHeight: 13 },
  roomMenuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 13, borderTopWidth: StyleSheet.hairlineWidth },
  roomMenuItemText: { fontSize: 15, fontWeight: '600' },
  roomRankPanel: { maxHeight: '82%', padding: 14, paddingBottom: 24, borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet },
  /**
   * 横屏：底部抽屉可用高度 ≈ 400dp×82% ≈ 330dp，而内部滚动区固定 maxHeight 420/360，
   * RN 默认 flexShrink:0 → 内容从面板盒体溢出到屏幕外（「送出」按钮点不到）。
   * 放宽面板上限 + 内部滚动区收窄并允许收缩（见 roomRankListLandscape / roomMenuListLandscape）。
   */
  roomRankPanelLandscape: { maxHeight: '94%' },
  // 用户资料卡（房间内点非成员头像）
  userCardWrap: { width: '100%' },
  userCardPanel: { padding: 14, paddingBottom: 18, borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet },
  userCardHead: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  userCardAvatar: { width: 64, height: 64, borderRadius: 32 },
  userCardTitleWrap: { flex: 1, marginLeft: 14 },
  userCardName: { fontSize: 19, fontWeight: '800' },
  userCardMeta: { marginTop: 5, fontSize: 12 },
  userCardStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  userCardNotice: { marginTop: 12, padding: 10, borderRadius: 12 },
  userCardTip: { fontSize: 13, lineHeight: 19 },
  userCardActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 14 },
  userCardBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  userCardBtnText: { fontSize: 13, fontWeight: '700' },
  roomRankHandleWrap: { alignItems: 'center', paddingTop: 2, paddingBottom: 10 },
  roomRankHandle: { width: 40, height: 5, borderRadius: 3 },
  roomRankHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  roomRankClose: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  roomRankTitle: { fontSize: 18, fontWeight: '900' },
  roomRankStatus: { fontSize: 12, marginBottom: 10 },
  roomRankList: { maxHeight: 420 },
  /** 横屏：贡献榜/送礼列表收窄 + 允许收缩，把高度让给面板底部的操作行 */
  roomRankListLandscape: { maxHeight: 160, flexShrink: 1 },
  roomRankRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  roomRankNo: { width: 24, fontSize: 13, fontWeight: '900', textAlign: 'center' },
  roomRankAvatar: { width: 34, height: 34, borderRadius: 17 },
  roomRankInfo: { flex: 1, minWidth: 0 },
  roomRankName: { fontSize: 13, fontWeight: '800' },
  roomRankProgressTrack: { height: 4, borderRadius: 2, marginTop: 6, overflow: 'hidden' },
  roomRankProgressFill: { height: 4, borderRadius: 2 },
  roomRankValue: { fontSize: 11, fontWeight: '700', marginLeft: 6, flexShrink: 1 },
  empty: { textAlign: 'center', marginTop: 60, fontSize: 14, paddingHorizontal: 24, lineHeight: 20 },
  hiddenAudioVideo: { width: 1, height: 1, position: 'absolute', top: -9999, left: -9999, opacity: 0 },
});
