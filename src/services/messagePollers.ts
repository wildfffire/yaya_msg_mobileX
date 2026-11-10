/**
 * 消息轮询（用户 2026-11-09 / 2026-11-10 定版）。
 *
 * ★ 2026-11-10 四轮修复：对齐上游 `yk1z/yaya_msg` 的
 *   `followed-rooms-feature.js` + `private-message-notifications.js`：
 *
 *   ① **预览只用来决定「要不要拉详情」**：`im/api/v1/team/classic/last/message/get`
 *      的条目实测只有 `serverId,channelId,msgContent,starName`，既没有 msgId 也没有
 *      msgTime。旧版拿「最新一条内容指纹」判新 → 同一轮连发 N 条只剩 1 条、
 *      两条内容一样的消息指纹完全相同被整轮吞掉 —— 「部分新消息不提示」的根因。
 *      现在按侧维护「消息 id 集合 + 时间游标」，详情一页里逐条挑新消息。
 *   ② **通知发送成功才推进游标**：旧版 `roomBaseline.set()` 写在 `notifyMessage()` 之前，
 *      任何 skip（正在看这个房间 / 开关 / dedupe / 权限被拒）都让那条消息永久不再判新。
 *      现在 `notifyMessage` 返回 sent/duplicate/skipped/failed，failed 不进游标、下轮重试。
 *   ③ **游标持久化**（上游用 localStorage）：冷启动不再把历史消息当基线吞掉；
 *      App 被杀期间到达、且预览已变化的消息，重启后仍能提示。
 *   ④ **通知与未读角标共用一份「消息 id 总账」**（roomCountLedger）：
 *      实时 / 5s 轮询 / 30s 指纹三条通道谁先认领谁计数，不再用整数相减把数字扣成 0。
 *      通知开关关掉时轮询照跑（只计数、不弹通知），角标不会因为关通知而停更。
 *
 * 轮询节奏：私信 5s、房间 5s、启动 2s 首轮、回前台立即补一轮（Doze 冻结兜底）。
 * 每个静默分支都留 `[notify] [pm]/[room] 跳过：…` 诊断行（同因 60s 节流）。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, DeviceEventEmitter, type AppStateStatus } from 'react-native';
import pocketApi from '../api/pocket48';
import { useMemberStore, useSettingsStore } from '../store';
import { useRoomPresenceStore } from '../store/notice';
import { unwrapList, pickText, messageText } from '../utils/data';
import { flushStaleWork } from '../utils/network';
import { translate } from '../i18n';
import {
  findLastMessage,
  findSmallLastMessage,
  messageToken,
  roomChannelId,
  roomSideServerUnread,
  type RoomMode,
} from '../screens/room/roomIdentity';
import { isIdolMessage, isOwnerMessageForNotify } from '../screens/room/messageRules';
import { isOwnerByServer, messageIdAliases, pickOwnerMessages } from '../utils/notifyOwnerRules';
import { ROOM_UNREAD_SIDES, roomUnreadKey, type RoomUnreadSide } from '../utils/roomUnreadRules';
import { shouldKeepMessageAlive, type RoomNotifyMode } from '../utils/notifyRules';
import { logInfo, logWarn } from '../utils/runtimeLog';
import { useRoomUnreadStore } from './roomUnread';
import { useRoomListAvatarStore } from './roomListAvatar';
import { claimCountId, isCountClaimed, markCountConsumed } from './roomCountLedger';
import {
  advanceCursor,
  canCompensateUnread,
  cursorNeedsCheck,
  emptyMessageCursor,
  findFreshMessages,
  freshBatchKey,
  isDetailFromSide,
  messageId,
  messageIsSelf,
  messagePreview,
  messageSenderId,
  messageTime,
  normalizeMessageTime,
  type MessageCursor,
} from '../utils/roomMessageCursor';
import { notifyMessage, type NotifyOutcome } from './notificationCenter';

const PM_INTERVAL_MS = 5_000;
const ROOM_INTERVAL_MS = 5_000;
const FIRST_POLL_MS = 2_000;
/** 一轮最多覆盖多少个关注房间（上游不设上限；这里主要防异常账号把请求撑爆） */
const MAX_ROOMS = 200;
/** 一轮最多拉多少个「侧」的详情（并发 4），超出的下一轮继续 */
const MAX_DETAIL_PER_ROUND = 24;
const DETAIL_CONCURRENCY = 4;
/** homeowner（服务端房主过滤）详情并发 */
const OWNER_CHECK_CONCURRENCY = 4;
/** 每 12 轮（约 60s）无条件全量扫一次：兜住「内容完全相同、预览指纹不变」的连发 */
const SWEEP_EVERY_ROUNDS = 12;
/** 同一批通知连续失败多少次后放弃重试（避免权限永久关闭时每 5s 打一次原生调用） */
const MAX_NOTIFY_ATTEMPTS = 12;
/** 后台挂起请求/签名的强制收尾阈值（比前台 15s 超时略长，由原生心跳驱动） */
const BG_STALE_MS = 20_000;
/** 后台 busy 防重入的最长占用时间：Promise 不 settle 时强制解冻 */
const BG_BUSY_MS = 25_000;
/** 每侧每轮最多补计多少条（防时间字段异常时把整页历史一次刷成未读） */
const MAX_COMPENSATE_PER_SIDE = 5;
const LOG_TAG = 'notify';
const ROOM_CURSOR_STORAGE = 'yaya_room_feed_cursors_v1';

function getToken(): string {
  return String(useSettingsStore.getState().settings.p48Token || '');
}

const diagLastAt = new Map<string, number>();
function logDiag(key: string, msg: string) {
  const now = Date.now();
  if (now - (diagLastAt.get(key) || 0) < 60_000) return;
  diagLastAt.set(key, now);
  logInfo(msg, LOG_TAG);
}

function topKeys(res: unknown): string {
  if (!res || typeof res !== 'object') return typeof res;
  return Object.keys(res as Record<string, unknown>).join(',');
}

/** 并发受限的 map（详情请求不能一次全打出去，避免风控） */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/* ── 消息游标（房间侧持久化，私信侧会话内有效） ───────────────────────── */

const roomCursors = new Map<string, MessageCursor>();
const pmCursors = new Map<string, MessageCursor>();
const notifyAttempts = new Map<string, number>();
let cursorsLoaded = false;
let cursorsLoading: Promise<void> | null = null;
let cursorSaveTimer: ReturnType<typeof setTimeout> | null = null;

function ensureCursorsLoaded(): Promise<void> {
  if (cursorsLoaded) return Promise.resolve();
  if (!cursorsLoading) {
    cursorsLoading = AsyncStorage.getItem(ROOM_CURSOR_STORAGE)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        for (const [key, value] of Object.entries(parsed as Record<string, any>)) {
          const v = value as any;
          if (!key || !v || !Array.isArray(v.keys)) continue;
          roomCursors.set(key, {
            primed: v.primed === true,
            time: Number(v.time) || 0,
            keys: v.keys.filter((k: any) => typeof k === 'string').slice(-300),
            preview: String(v.preview || ''),
            unread: Number.isFinite(Number(v.unread)) ? Number(v.unread) : -1,
          });
        }
        logInfo(`[room] 已恢复 ${roomCursors.size} 个消息游标（冷启动不重建基线）`, LOG_TAG);
      })
      .catch(() => { /* 存储坏了就当首次启动 */ })
      .then(() => { cursorsLoaded = true; });
  }
  return cursorsLoading;
}

function scheduleCursorPersist() {
  if (cursorSaveTimer) clearTimeout(cursorSaveTimer);
  cursorSaveTimer = setTimeout(() => {
    cursorSaveTimer = null;
    const obj: Record<string, MessageCursor> = {};
    for (const [key, value] of roomCursors) obj[key] = value;
    void AsyncStorage.setItem(ROOM_CURSOR_STORAGE, JSON.stringify(obj)).catch(() => {});
  }, 800);
}

function cursorOf(map: Map<string, MessageCursor>, key: string): MessageCursor {
  return map.get(key) || emptyMessageCursor();
}

/** 处理通知结果：失败不进游标；成功/重复/主动跳过都算已处理 */
function consumeCursor(
  map: Map<string, MessageCursor>,
  key: string,
  cur: MessageCursor,
  pageKeys: string[],
  fresh: any[],
  newest: number,
  preview: string,
  unread: number,
  outcome: NotifyOutcome,
) {
  const failed = outcome === 'failed';
  const failedIds = new Set(failed ? fresh.map((m) => messageId(m)) : []);
  const consumed = pageKeys.filter((id) => !failedIds.has(id));
  // ★ 失败时连预览指纹 / 未读数都不能推进：否则下一轮 `cursorNeedsCheck` 判「没变」，
  // 这条消息再也不会被拉详情 → 又变成「部分新消息不提示」。
  map.set(key, advanceCursor(cur, {
    pageKeys: consumed,
    newest,
    preview: failed ? cur.preview : preview,
    unread: failed ? cur.unread : unread,
  }));
  return failed;
}

/* ── 私信 ─────────────────────────────────────────────────────────────── */

let pmTimer: ReturnType<typeof setInterval> | null = null;
let pmBusy = false;
let pmBusySince = 0;
let pmPrimed = false;

function convTargetId(conv: any): string {
  return String(conv?.targetUserId || conv?.user?.userId || conv?.userId || '');
}

function convName(conv: any): string {
  return pickText(
    conv,
    ['user.nickname', 'user.nickName', 'user.starName', 'user.realNickName', 'nickname', 'starName'],
    convTargetId(conv) || translate('私信'),
  );
}

function convUnread(conv: any): number {
  return Number(conv?.noreadNum ?? conv?.unreadNum ?? conv?.unread ?? 0) || 0;
}

function convPreview(conv: any): string {
  const newest = pickText(conv, ['newestMessage', 'lastMessageText', 'content', 'text', 'msgContent'], '');
  if (newest) return newest;
  const last = conv?.lastMessage || conv?.latestMessage || conv?.message;
  if (last) {
    const text = messageText(last);
    if (text) return text;
  }
  const unread = convUnread(conv);
  return unread > 1 ? translate('{n} 条未读私信', { n: unread }) : translate('新私信');
}

async function pollPrivateMessages() {
  const settings = useSettingsStore.getState().settings;
  if (!getToken()) { logDiag('pm.token', '[pm] 跳过：未登录（无 token）'); return; }
  // ★ 开关关着也继续跑：保持游标新鲜，下次打开开关不会补弹一堆陈旧私信
  const notifyAllowed = settings.notify_pm_enabled !== false && !settings.notify_dnd;
  if (!notifyAllowed) {
    logDiag('pm.policy', `[pm] 通知策略：私信开关=${settings.notify_pm_enabled} 免打扰=${settings.notify_dnd ? 1 : 0}`);
  }
  if (pmBusy) return;
  pmBusy = true;
  pmBusySince = Date.now();
  try {
    const res: any = await pocketApi.getPrivateMessageList();
    const convs = unwrapList(res, [
      'content.userMessageList',
      'content.list',
      'content.data',
      'data.userMessageList',
      'userMessageList',
      'list',
    ]);
    if (!convs.length) {
      logDiag('pm.empty', `[pm] 会话列表为空/解析失败 topKeys=${topKeys(res)} status=${(res as any)?.status}`);
      return;
    }
    let sent = 0;
    for (const conv of convs) {
      const targetId = convTargetId(conv);
      if (!targetId) continue;
      const unread = convUnread(conv);
      const time = normalizeMessageTime(conv?.newestMessagetime ?? conv?.lastTime ?? conv?.msgTime ?? 0);
      const preview = convPreview(conv);
      const cur = cursorOf(pmCursors, targetId);
      if (unread <= 0) {
        pmCursors.set(targetId, advanceCursor(cur, {
          pageKeys: [], newest: time, preview, unread: 0,
        }));
        continue;
      }
      const changed = cursorNeedsCheck(cur, preview, unread);
      if (!changed) continue;

      // 上游 private-message-notifications.js 同款：会话变化后拉详情，按消息 id 挑真正的新消息
      let list: any[] | null = null;
      try {
        const detail: any = await pocketApi.getPrivateMessageDetail(targetId, 0);
        const parsed = unwrapList(detail, [
          'content.messageList', 'content.messages', 'content.list', 'content.data',
          'messageList', 'messages', 'list',
        ]);
        if (parsed.length) list = parsed;
      } catch (e: any) {
        logDiag('pm.detail', `[pm] 会话详情失败 target=${targetId}：${String(e?.message || e || '')}`);
      }

      const { fresh, pageKeys, newest } = list
        ? findFreshMessages(list, cur)
        : { fresh: [] as any[], pageKeys: [] as string[], newest: time };
      const incoming = fresh.filter((m) => {
        if (messageIsSelf(m)) return false;
        const from = messageSenderId(m);
        return !from || from === targetId;
      });
      let outcome: NotifyOutcome = 'skipped';
      /**
       * ★ 新会话也要提示（上游 private-message-notifications.js 同款：只有**首轮整体**建基线，
       *   之后新出现的会话按 noreadNum / newestMessagetime 直接判新）。
       *   旧版「该会话首次见到 → 只建基线」会让别人第一次私信你时永远不提示。
       * ★ 通知策略只由 notificationCenter.notifyDecision 一处裁决：轮询层再判一次开关，
       *   真机上出现过「某层开关被旧版固化 → 整场静默」且日志看不出是哪一层。
       */
      const newSession = pmPrimed && !cur.primed;
      if (pmPrimed && (cur.primed || newSession)) {
        const batch = freshBatchKey(incoming.length ? incoming : fresh);
        const fallbackKey = `${time}:${unread}:${preview}`;
        const msgKey = batch || fallbackKey;
        const attemptKey = `pm|${targetId}|${msgKey}`;
        const tries = notifyAttempts.get(attemptKey) || 0;
        if (tries >= MAX_NOTIFY_ATTEMPTS) {
          outcome = 'duplicate';
          logDiag('pm.retry', `[pm] 通知连续失败 ${tries} 次，放弃重试 target=${targetId}`);
        } else {
          const newestMsg = incoming.length
            ? incoming.reduce((a, b) => (messageTime(b) > messageTime(a) ? b : a))
            : null;
          const body = (newestMsg && (messageText(newestMsg) || messagePreview(newestMsg))) || preview;
          try {
            outcome = await notifyMessage({
              kind: 'pm', targetId, msgId: msgKey, title: convName(conv), body,
            });
          } catch (e: any) {
            outcome = 'failed';
            logWarn(`[pm] 通知异常：${String(e?.message || e || '')}`, LOG_TAG);
          }
          if (outcome === 'failed') notifyAttempts.set(attemptKey, tries + 1);
          else { notifyAttempts.delete(attemptKey); if (outcome === 'sent') sent += 1; }
        }
      }
      // 详情拉失败时退回「会话预览」单条口径，但游标按会话时间推进（失败可重试）
      const effectiveFresh = list ? fresh : [];
      consumeCursor(pmCursors, targetId, cur, pageKeys, effectiveFresh, Math.max(newest, time), preview, unread, outcome);
    }
    if (!pmPrimed) {
      pmPrimed = true;
      logInfo(`[pm] 基线已建立 会话=${convs.length}（首轮不通知）`, LOG_TAG);
    } else if (sent) {
      logInfo(`[pm] 本轮发出 ${sent} 条私信通知`, LOG_TAG);
    }
  } catch (e: any) {
    logDiag('pm.err', `[pm] 轮询失败：${String(e?.message || e || '')}`);
  } finally {
    pmBusy = false;
    pmBusySince = 0;
  }
}

/* ── 房间 ─────────────────────────────────────────────────────────────── */

let roomTimer: ReturnType<typeof setInterval> | null = null;
let roomBusy = false;
let roomBusySince = 0;
let roomPrimed = false;
let roomRound = 0;
/** 空响应只提示一次，避免每 5s 刷日志 */
let roomLoggedEmpty = false;

/**
 * 通知头像 = **房间列表那一张**（用户 2026-11-10 明确）：
 *   · 设置「房间外头像」= official → 成员库公式照优先，自选房间图标兜底；
 *   · custom → 偶像自己设置的房间图标（`serverIcon` 缓存）优先，公式照兜底。
 * 与 RoomListRow 的 coverAvatar 同一套取值，不另造口径。
 */
function roomAvatarForNotify(member: any): string {
  const id = String(member?.id || member?.userId || '');
  const source = useSettingsStore.getState().settings.room_list_avatar_source || 'official';
  const cached = id ? (useRoomListAvatarStore.getState().map[id]?.url || '') : '';
  const official = String(member?.avatar || '');
  return source === 'custom' ? (cached || official) : (official || cached);
}

function memberOf(list: any[], id: string) {
  const key = String(id || '');
  if (!key) return undefined;
  const same = (v: any) => String(v ?? '') === key;
  // 先用成员主键；关注 id 有时是口袋 account / starId，不能只认 member.id
  const direct = list.find((m) => [m?.id, m?.userId, m?.memberId, m?.starId, m?.ownerId].some(same));
  if (direct) return direct;
  // 再兜底房间侧 id（getFollowedIds 的返回值在少数账号里是房间维度）
  return list.find((m) => [m?.serverId, m?.channelId, m?.yklzId, m?.roomId].some(same));
}

/** 大房间「最新消息」：channelId / userId 不通时再按 serverId 认一次 */
function findBigMessage(lastMsgs: any[], member: any) {
  const hit = findLastMessage(lastMsgs, member);
  if (hit) return hit;
  const serverId = String(member?.serverId || '');
  if (!serverId) return null;
  return lastMsgs.find((msg) => String(msg?.channelId || msg?.serverId || '') === serverId) || null;
}

/** 详情消息的聊天类型判定（与 useRoomUnreadCounters 的正式口径一致） */
function isChatFeedMessage(m: any): boolean {
  const t = String(m?.bodys?.messageType || m?.msgType || m?.messageType || m?.type || 'TEXT').toUpperCase();
  return /^(TEXT|REPLY|GIFTREPLY|EXPRESSIMAGE|IMAGE|AUDIO|VIDEO|BARRAGE_|FLIP)/.test(t);
}

interface RoomSideTarget {
  key: string;
  id: string;
  side: RoomUnreadSide;
  member: any;
  token: string;
  serverUnread: number;
  channelId: string;
  serverId: string;
  fallbackChannelId?: string;
}

const ROOM_DETAIL_LIST_KEYS = [
  'content.messageList', 'content.message', 'content.messages', 'content.list',
  'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list',
];

/**
 * 按**本侧频道**拉房间详情一页。
 *
 * `getRoomMessages` 在小房间请求失败时会自动尝试 `fallbackChannelId`（大房间频道），
 * 而消息体里不带 channelId —— 直接采信就会把已读的大房间消息算成小房间未读。
 * `tryPocketPost` 把实际命中的 payload 留在 `res._request.payload.channelId`，
 * 据此识别串味；命中回退时**去掉 fallback 用本侧频道再试一次**，
 * 既保住小房间的可用性，又不引入串味数据。两次都拿不到本侧数据就整轮丢弃。
 */
async function fetchSideDetail(
  s: RoomSideTarget,
  fetchAll: boolean,
): Promise<{ list: any[] | null; crossSide: boolean }> {
  const base: any = {
    channelId: s.channelId,
    serverId: s.serverId,
    nextTime: 0,
    limit: 50,
    fetchAll,
  };
  try {
    let res: any = await pocketApi.getRoomMessages({
      ...base,
      ...(s.fallbackChannelId ? { fallbackChannelId: s.fallbackChannelId } : {}),
    });
    if (!isDetailFromSide(res?._request?.payload?.channelId, s.channelId)) {
      logDiag('room.crossside', `[room] ${s.id}#${s.side} 详情回退到 ch=${res?._request?.payload?.channelId}（本侧=${s.channelId}），改用本侧频道重试`);
      if (!s.fallbackChannelId) return { list: null, crossSide: true };
      try {
        res = await pocketApi.getRoomMessages(base);
      } catch {
        return { list: null, crossSide: true };
      }
      if (!isDetailFromSide(res?._request?.payload?.channelId, s.channelId)) {
        return { list: null, crossSide: true };
      }
    }
    const list = unwrapList(res, ROOM_DETAIL_LIST_KEYS);
    return { list: list.length ? list : null, crossSide: false };
  } catch (e: any) {
    logDiag('room.detail', `[room] 详情失败 ${s.id}#${s.side}：${String(e?.message || e || '')}`);
    return { list: null, crossSide: false };
  }
}

async function pollRooms() {
  const settings = useSettingsStore.getState().settings;
  if (!getToken()) { logDiag('room.token', '[room] 跳过：未登录（无 token）'); return; }
  // ★ 通知开关只决定「弹不弹」，不决定「跑不跑」：角标必须一直更新
  const notifyAllowed = settings.notify_room_enabled !== false
    && !settings.notify_dnd
    && settings.notify_room_mode !== 'none';
  // 真机排查「一条通知都没有」：把三层开关快照打出来（60s 节流），
  // 最终裁决仍由 notificationCenter.notifyDecision 完成并打 `[skip] … 开关(…)`。
  logDiag(
    'room.policy',
    `[room] 通知策略：房间开关=${settings.notify_room_enabled} 免打扰=${settings.notify_dnd ? 1 : 0}`
    + ` 范围=${String(settings.notify_room_mode || 'all')} 系统=${settings.notify_system_enabled}`
    + ` 横幅=${settings.notify_inapp_enabled} 仅后台=${settings.notify_only_background}`,
  );
  if (roomBusy) return;
  roomBusy = true;
  roomBusySince = Date.now();
  roomRound += 1;
  try {
    await ensureCursorsLoaded();
    const idsRes: any = await pocketApi.getFollowedIds();
    const ids = unwrapList(idsRes, ['content.data', 'content', 'data', 'list']).map(String);
    if (!ids.length) {
      logDiag('room.ids', `[room] 关注 id 列表为空/解析失败 topKeys=${topKeys(idsRes)} status=${idsRes?.status}`);
      return;
    }
    const members = useMemberStore.getState().members || [];
    const matched = ids.map((id) => ({ id, m: memberOf(members as any[], id) }));
    // ★ 按房间分化的第一处差异：某些关注 id 在成员库里匹配不到 / 缺房间侧 id，
    // 旧版静默 filter 掉，那个房间就整场不轮询、不计数、不通知（用户「不同房间一个对一个漏」）。
    const missing = matched.filter((x) => !x.m).map((x) => x.id);
    const noRoomId = matched
      .filter((x) => x.m && !(x.m.serverId || x.m.channelId || x.m.yklzId))
      .map((x) => x.id);
    if (missing.length || noRoomId.length) {
      logDiag('room.coverage', `[room] 未覆盖房间 匹配不到=${missing.length}[${missing.slice(0, 12).join(',')}]`
        + ` 缺房间id=${noRoomId.length}[${noRoomId.slice(0, 12).join(',')}] 成员库=${members.length}`);
    }
    const targets = matched
      .map((x) => x.m)
      .filter((m: any) => m && (m.serverId || m.channelId || m.yklzId))
      .slice(0, MAX_ROOMS);
    if (!targets.length) {
      logDiag('room.targets', `[room] 关注 id=${ids.length} 个但成员库匹配到 0 个（成员库=${members.length} 位）`);
      return;
    }
    if (ids.length > MAX_ROOMS) {
      logDiag('room.cap', `[room] 关注 ${ids.length} 个房间，本轮只覆盖前 ${MAX_ROOMS} 个`);
    }
    const queryIds: number[] = [];
    for (const m of targets as any[]) {
      const bigId = Number(m.serverId) > 0 ? Number(m.serverId) : Number(m.channelId);
      for (const n of [bigId, Number(m.yklzId)]) {
        if (Number.isFinite(n) && n > 0 && !queryIds.includes(n)) queryIds.push(n);
      }
    }
    if (!queryIds.length) {
      logDiag('room.qids', `[room] 无有效查询 id（${targets.length} 个目标都缺 serverId/channelId/yklzId）`);
      return;
    }
    const lastRes: any = await pocketApi.getLastMessages(queryIds);
    const lastMsgs = unwrapList(lastRes, [
      'content.lastMsgList',
      'content.data',
      'data.lastMsgList',
      'lastMsgList',
      'content',
      'data',
      'list',
    ]);
    // 空响应不推进游标：否则会把「本轮失败」写成上一轮指纹，之后真来消息也判不出变化
    if (!lastMsgs.length) {
      if (!roomLoggedEmpty) {
        roomLoggedEmpty = true;
        logInfo(`[room] 最新消息接口返回空（查询 ${queryIds.length} 个 id），本轮不推进基线`, LOG_TAG);
      }
      return;
    }
    roomLoggedEmpty = false;

    const sides: RoomSideTarget[] = [];
    const skippedSides: string[] = [];
    for (const member of targets as any[]) {
      const id = String(member.id || member.userId || '');
      if (!id) continue;
      const big = findBigMessage(lastMsgs, member);
      const small = findSmallLastMessage(lastMsgs, member);
      const row = { lastMessage: big, lastSmallMessage: small };
      for (const side of ROOM_UNREAD_SIDES) {
        const msg = side === 'big' ? big : small;
        if (!msg) { skippedSides.push(`${id}#${side}:无预览`); continue; }
        const token = messageToken(msg);
        if (!token) { skippedSides.push(`${id}#${side}:指纹空`); continue; }
        const channelId = roomChannelId(member, side as RoomMode);
        if (!channelId) { skippedSides.push(`${id}#${side}:无channelId`); continue; }
        sides.push({
          key: roomUnreadKey(id, side),
          id,
          side,
          member,
          token,
          serverUnread: roomSideServerUnread(row, side as RoomMode),
          channelId,
          serverId: String(member.serverId || ''),
          ...(side === 'small' && member.channelId ? { fallbackChannelId: String(member.channelId) } : {}),
        });
      }
    }

    if (skippedSides.length) {
      logDiag('room.coverage.sides', `[room] 本轮未覆盖 ${skippedSides.length} 侧：${skippedSides.slice(0, 18).join(' ')}`);
    }
    const sweep = roomRound % SWEEP_EVERY_ROUNDS === 0;
    let check = sides.filter((s) => {
      const cur = cursorOf(roomCursors, s.key);
      return cursorNeedsCheck(cur, s.token, s.serverUnread, sweep);
    });
    if (check.length > MAX_DETAIL_PER_ROUND) {
      // 轮转起点：保证被截掉的侧下一轮优先被检查，不会永远饿死
      const start = (roomRound * 7) % check.length;
      const rotated = [...check.slice(start), ...check.slice(0, start)];
      check = rotated.slice(0, MAX_DETAIL_PER_ROUND);
      logDiag('room.capdetail', `[room] 本轮待查 ${sides.length} 侧，先查 ${check.length} 侧（其余下轮）`);
    }

    const fetched = await mapLimit(check, DETAIL_CONCURRENCY, async (s) => ({
      s,
      ...(await fetchSideDetail(s, true)),
    }));

    /**
     * ★ 服务端房主表（消除「按房间分化」的核心）。
     *
     * 本地判定靠成员库 ownerName/nickname 与消息 ext.user.nickName 比对，不同房间的
     * 昵称形态（团体前缀 / 别名 / emoji / 空格）对得上就每次都认出房主、对不上就一条都
     * 认不出 —— 用户说的「对和漏是在不同房间发生的」正是这个。
     * `fetchAll:false` 走 `/team/message/list/homeowner`，服务端按房主过滤，
     * 用它的 id 集合作为**补充阳性信号**：本地认不出的房间也能认出房主。
     * 只在本侧确实有新消息时才拉，平时 0 请求；失败/空表自动回退本地判定。
     */
    const ownerChecks = fetched.filter(({ s, list, crossSide }) => {
      if (!list || crossSide) return false;
      const cur = cursorOf(roomCursors, s.key);
      return cur.primed && findFreshMessages(list, cur).fresh.length > 0;
    });
    const ownerIdSets = new Map<string, Set<string> | null>();
    if (ownerChecks.length) {
      await mapLimit(ownerChecks, OWNER_CHECK_CONCURRENCY, async ({ s }) => {
        // homeowner 同样走防串味拉取：回退到别的频道时那张表不能拿来判本侧房主
        const { list, crossSide } = await fetchSideDetail(s, false);
        if (crossSide || !list) {
          ownerIdSets.set(s.key, null);
          return;
        }
        const ids = new Set<string>();
        for (const m of list) {
          // 两个接口可能给不同的 id 字段，别名全收进表，避免整表命中不上
          for (const mid of messageIdAliases(m)) ids.add(mid);
        }
        ownerIdSets.set(s.key, ids);
      });
    }

    const presence = String(useRoomPresenceStore.getState().currentRoomId || '');
    const bumpPatch: Record<string, number> = {};
    let sent = 0;
    let freshTotal = 0;
    let idolTotal = 0;
    let countedTotal = 0;
    let compensatedTotal = 0;
    const readBaselines = useRoomUnreadStore.getState().lastReadAt || {};
    for (const item of fetched) {
      const { s, list, crossSide } = item;
      // 串味结果：游标、计数、通知、房主表全部不动，下轮重试（不能拿它建基线）
      if (crossSide) continue;
      const cur = cursorOf(roomCursors, s.key);
      /** 房间级已读基线（服务器消息时间 ms）：进房/退房/一键已读都会推进 */
      const readFloor = Number(readBaselines[s.id]) || 0;
      if (!list) {
        if (!cur.primed) {
          // 该侧详情为空（房间没消息 / 接口这次没给）：仍按当前预览建基线，
          // 避免每 5s 对同一批空房间重复打请求；真消息一来预览就变，照样能判新。
          roomCursors.set(s.key, advanceCursor(cur, {
            pageKeys: [], newest: 0, preview: s.token, unread: s.serverUnread,
          }));
        }
        // 已建过基线的侧：详情失败不动游标，下轮重试（不能把新消息吞掉）
        continue;
      }
      const { fresh, pageKeys, newest } = findFreshMessages(list, cur);
      freshTotal += fresh.length;
      /** 本侧的服务端房主 id 表；null = 接口失败，空表 = 服务端没返回房主消息 */
      const ownerIds = ownerIdSets.get(s.key) ?? null;
      const ownerHit = (m: any): boolean =>
        !!ownerIds && ownerIds.size > 0
        && messageIdAliases(m).some((mid) => ownerIds.has(mid));
      const isOwnerForCount = (m: any): boolean =>
        isChatFeedMessage(m)
        && isOwnerByServer(ownerIds, messageIdAliases(m), () => isIdolMessage(m, s.member, false));
      const isOwnerForNotice = (m: any): boolean =>
        isChatFeedMessage(m)
        && isOwnerByServer(ownerIds, messageIdAliases(m), () => isOwnerMessageForNotify(m, s.member));
      /**
       * ★ 用户 2026-11-10 定版：**房间通知只认房主本人**。
       * 旧版把 `fresh` 整批（含群聊里成员/粉丝的发言）都送进 notifyMessage，
       * 横幅文案还取「最新一条」→ 看起来就是「群聊消息也弹横幅」。
       * 这里用通知专用严格判定（不是「只看偶像」视图的宽松兜底）挑出偶像消息；
       * 非偶像消息照样被游标消费（不弹、不重放、不补弹）。
       */
      const idolFresh = pickOwnerMessages(fresh, isOwnerForNotice).filter((m) => {
        // 已读基线之前的消息不能再弹横幅（与计数同口径），否则重启/退房后
        // 会出现「已经消除过的消息再次提示」
        const mt = messageTime(m);
        return !(mt > 0 && mt <= readFloor);
      });
      idolTotal += idolFresh.length;
      if (fresh.length > idolFresh.length) {
        logDiag('room.nonidol', `[room] ${s.id}#${s.side} ${fresh.length - idolFresh.length} 条非偶像新消息不弹横幅`);
      }

      const seenHere = !!presence && presence === s.id;
      // ★ 正在看的房间：把本页**全部** id 标成已读。
      // 旧版只在 fresh 循环里标，进房期间游标已消费但没拉详情的那批消息没被标，
      // 退房后（或重启后总账清空）补偿扫描会把它们补计成未读 → 「消除过的消息再次提示」。
      if (seenHere) {
        for (const m of list) markCountConsumed(messageId(m));
      }
      if (cur.primed && fresh.length) {
        let counted = 0;
        for (const m of fresh) {
          const mid = messageId(m);
          if (!mid) continue;
          if (seenHere) {
            // 正在看的房间：明确标成「已读」，阻止 30s 指纹 / 补偿扫描事后补计
            markCountConsumed(mid);
            continue;
          }
          // 已读基线之前的消息（进房时已看过 / 重启后游标回放）一律标已读，不再计数
          const mt = messageTime(m);
          if (mt > 0 && mt <= readFloor) {
            markCountConsumed(mid);
            continue;
          }
          // 非偶像消息不占总账：交给别的通道判定，也不该被补偿扫描补计
          if (!isOwnerForCount(m)) continue;
          if (!claimCountId(mid)) continue; // 实时通道或 30s 指纹已经计过
          counted += 1;
        }
        if (counted) {
          bumpPatch[s.key] = (bumpPatch[s.key] || 0) + counted;
          countedTotal += counted;
        }
        // 逐条判定留痕：真机上一眼看出是「没判新」「房主没认出」还是「总账拦下」
        const sample = fresh.slice(0, 5).map((m) => {
          const mid = messageId(m);
          return `${String(mid).slice(-8)}:${isChatFeedMessage(m) ? 'chat' : 'other'}`
            + `:${isOwnerForCount(m) ? 'idol' : 'fan'}`
            + `:${ownerHit(m) ? 'server' : 'local'}`
            + `:${isCountClaimed(mid) ? 'claimed' : 'new'}`;
        }).join(' ');
        logInfo(
          `[unread] 判定 ${s.id}#${s.side} 新=${fresh.length} 偶像=${idolFresh.length}`
          + ` homeowner=${ownerIds === null ? 'fail' : ownerIds.size}`
          + ` 服务端命中=${fresh.filter(ownerHit).length}`
          + ` 已读基线=${readFloor} 已读=${seenHere ? 1 : 0} 计=${counted} 样本=${sample}`,
          'room.unread',
        );
      }

      /**
       * ★ 按消息 id 的角标补偿扫描（用户 2026-11-10「有的新消息没有红点」）。
       *
       * `fresh` 依赖预览指纹与消息游标，任一环被吞（进房清 sideSeenAt 后 30s 指纹
       * 走首次基线、同内容连发指纹不变、同秒消息被时间基线挡住、详情失败后重试窗口），
       * 就再没有第二条按 id 的通道补回来。这里不依赖 `fresh`：只要本轮成功拉到详情，
       * 就扫整页里「严格晚于上一轮游标时间、且晚于房间已读基线」的偶像聊天消息，
       * 没进总账的补计一次。总账保证与实时通道 / 30s 指纹 / 本轮 fresh 计数互不重复；
       * 已读房间整侧跳过。
       * ⚠️ 已读基线这道门槛是「已经消除过的消息再次提示」的修复：进程重启后
       * `roomCountLedger` 清空但 `lastReadAt` 持久化，没有它就会把已读消息再补一遍。
       */
      let compensated = 0;
      if (cur.primed && !seenHere && cur.time > 0) {
        for (const m of list) {
          const t = messageTime(m);
          if (!canCompensateUnread(t, cur.time, readFloor)) continue;
          if (!isOwnerForCount(m)) continue;
          const mid = messageId(m);
          if (!mid || isCountClaimed(mid)) continue;
          if (!claimCountId(mid)) continue;
          compensated += 1;
          if (compensated >= MAX_COMPENSATE_PER_SIDE) break;
        }
        if (compensated) {
          bumpPatch[s.key] = (bumpPatch[s.key] || 0) + compensated;
          countedTotal += compensated;
          logInfo(`[unread] 补偿计数 ${s.id}#${s.side} +${compensated} floor=${cur.time}`, 'room.unread');
        }
      }
      compensatedTotal += compensated;

      let outcome: NotifyOutcome = 'skipped';
      // 开关 off 时也调用 notifyMessage：由通知中心统一裁决并打 [skip] 原因行，
      // 轮询层不再做第二道静默门控（旧版两道门控叠加，真机上整场收不到通知且无日志）。
      if (cur.primed && idolFresh.length) {
        const batch = freshBatchKey(idolFresh);
        const attemptKey = `room|${s.key}|${batch}`;
        const tries = notifyAttempts.get(attemptKey) || 0;
        if (tries >= MAX_NOTIFY_ATTEMPTS) {
          outcome = 'duplicate';
          logDiag('room.retry', `[room] 通知连续失败 ${tries} 次，放弃重试 ${s.key}`);
        } else {
          const newestMsg = idolFresh.reduce((a, b) => (messageTime(b) > messageTime(a) ? b : a));
          const preview = messageText(newestMsg) || messagePreview(newestMsg) || translate('新消息');
          const body = idolFresh.length > 1
            ? `${translate('有 {n} 条新消息', { n: idolFresh.length })}：${preview}`
            : preview;
          try {
            outcome = await notifyMessage({
              kind: 'room',
              targetId: s.id,
              msgId: `${s.side}|${batch}`,
              title: String(s.member?.ownerName || s.member?.nickname || translate('房间消息')),
              body,
              avatarUrl: roomAvatarForNotify(s.member),
            });
          } catch (e: any) {
            outcome = 'failed';
            logWarn(`[room] 通知异常：${String(e?.message || e || '')}`, LOG_TAG);
          }
          if (outcome === 'failed') notifyAttempts.set(attemptKey, tries + 1);
          else { notifyAttempts.delete(attemptKey); if (outcome === 'sent') sent += 1; }
        }
      }
      // 失败重试只保留偶像消息的 id；成员消息本轮就消费掉，不会下轮再冒出来
      consumeCursor(roomCursors, s.key, cur, pageKeys, idolFresh, newest, s.token, s.serverUnread, outcome);
    }

    if (Object.keys(bumpPatch).length) {
      useRoomUnreadStore.getState().applyUnread({ bump: bumpPatch });
    }
    if (fetched.length) scheduleCursorPersist();
    if (!roomPrimed) {
      roomPrimed = true;
      logInfo(`[room] 消息游标已就绪 房间=${targets.length} 样本=${lastMsgs.length} 恢复=${roomCursors.size}`, LOG_TAG);
    }
    if (notifyAttempts.size > 1000) notifyAttempts.clear();
    logInfo(
      `[room] 本轮 房间=${targets.length} 侧=${sides.length} 查详情=${fetched.length}`
      + ` 新消息=${freshTotal} 偶像=${idolTotal} 通知=${sent} 计数=${countedTotal}`
      + ` 补偿=${compensatedTotal} 通知开关=${notifyAllowed ? 1 : 0}`,
      LOG_TAG,
    );
  } catch (e: any) {
    logDiag('room.err', `[room] 轮询失败：${String(e?.message || e || '')}`);
  } finally {
    roomBusy = false;
    roomBusySince = 0;
  }
}

/* ── 生命周期 ─────────────────────────────────────────────────────────── */

function startPm() {
  if (pmTimer) return;
  pmTimer = setInterval(() => { void pollPrivateMessages(); }, PM_INTERVAL_MS);
}

function startRoom() {
  if (roomTimer) return;
  roomTimer = setInterval(() => { void pollRooms(); }, ROOM_INTERVAL_MS);
}

let appStateSub: { remove: () => void } | null = null;
let pollTickSub: { remove: () => void } | null = null;
let firstPollTimer: ReturnType<typeof setTimeout> | null = null;

function stopPollingTimers() {
  if (pmTimer) { clearInterval(pmTimer); pmTimer = null; }
  if (roomTimer) { clearInterval(roomTimer); roomTimer = null; }
}

/**
 * ★ 后台 fetch 被 abort 后 Promise 仍可能不 settle（RN 的回调在后台不派发），
 *   pollRooms/pollPrivateMessages 的 finally 就永远不执行，busy 防重入永久卡死。
 *   由原生心跳按时间强制解冻，保证下一轮还能继续尝试。
 */
function thawStaleBusy(): number {
  const now = Date.now();
  let thawed = 0;
  if (roomBusy && roomBusySince && now - roomBusySince > BG_BUSY_MS) {
    roomBusy = false;
    roomBusySince = 0;
    thawed += 1;
  }
  if (pmBusy && pmBusySince && now - pmBusySince > BG_BUSY_MS) {
    pmBusy = false;
    pmBusySince = 0;
    thawed += 1;
  }
  return thawed;
}

/** 当前设置是否还需要软件外通知（保活服务与后台轮询共用的唯一判定） */
function notifyWantedNow(): boolean {
  const s = useSettingsStore.getState().settings;
  return shouldKeepMessageAlive({
    systemEnabled: s.notify_system_enabled,
    dnd: s.notify_dnd,
    pmEnabled: s.notify_pm_enabled,
    roomEnabled: s.notify_room_enabled,
    roomMode: s.notify_room_mode as RoomNotifyMode | undefined,
  });
}

/**
 * ★「关通知 = 关后台」（用户 2026-11-10 明确要求，不能只停前台服务还继续跑网络请求）。
 * 前台时轮询照跑（角标需要）；退到后台时，只有确实还会发软件外通知才继续跑。
 * 系统栏关 / 免打扰 / 私信与房间全关 → 后台 5s 轮询整个停掉，不耗电；
 * 回前台立即恢复并补一轮，角标与已读状态不会永久落后。
 */
export function syncPollerBackgroundPolicy(state: AppStateStatus = AppState.currentState) {
  if (state === 'active' || notifyWantedNow()) {
    startPm();
    startRoom();
  } else {
    stopPollingTimers();
    logDiag('bg.pause', '[bg] 通知已关：后台轮询已暂停（回前台自动恢复），不耗电');
  }
}

/**
 * ★ 原生心跳（2026-11-10 真机实证）：RN 的 JavaTimerManager.onHostPause() 会把
 *   isPaused=true 并移除 Choreographer 回调 → 后台所有 JS setInterval 全部停摆。
 *   前台服务只保住进程也救不回定时器，必须由 MessageKeepAliveService 每 5s 发事件
 *   把轮询拉起来。前台交给 JS 定时器（避免双倍请求）；关通知时连心跳都不理（不耗电）。
 */
function startNativePollTick() {
  if (pollTickSub) return;
  pollTickSub = DeviceEventEmitter.addListener('yayaMessagePollTick', () => {
    if (AppState.currentState === 'active') return;
    if (!notifyWantedNow()) return;
    // ★ 后台 setTimeout 不触发：挂起的请求会让 busy 防重入永久卡死，先强制收尾再发新一轮
    const stale = flushStaleWork(BG_STALE_MS);
    if (stale) logDiag('bg.stale', `[bg] 已中止 ${stale} 个挂起请求/签名，解除轮询防重入`);
    const thawed = thawStaleBusy();
    if (thawed) logDiag('bg.thaw', `[bg] 已解冻 ${thawed} 个卡住的轮询（后台 Promise 未 settle）`);
    logDiag('bg.state', `[bg] 心跳 pmBusy=${pmBusy ? 1 : 0} roomBusy=${roomBusy ? 1 : 0}`);
    logDiag('bg.tick', '[bg] 原生心跳驱动后台轮询（RN 后台会暂停 JS setInterval）');
    void pollPrivateMessages();
    void pollRooms();
  });
}

/** 回前台立刻补一轮：Doze / 后台冻结会把 setInterval 拖后甚至停掉 */
function startAppStateWake() {
  if (appStateSub) return;
  appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    syncPollerBackgroundPolicy(state);
    if (state !== 'active') return;
    // 回前台也清一次：后台挂起的请求若不收尾，前台轮询同样会被 busy 标志挡死
    flushStaleWork(BG_STALE_MS);
    thawStaleBusy();
    void pollPrivateMessages();
    void pollRooms();
  });
}

export function stopMessagePollers() {
  stopPollingTimers();
  if (firstPollTimer) { clearTimeout(firstPollTimer); firstPollTimer = null; }
  if (appStateSub) { appStateSub.remove(); appStateSub = null; }
  if (pollTickSub) { pollTickSub.remove(); pollTickSub = null; }
}

/** App 启动时调用一次 */
export function startMessagePollers(): () => void {
  void ensureCursorsLoaded();
  // 房间列表头像缓存：后台通知要用同一张图，冷启动先 hydrate（未进过列表时也没有网络请求）
  useRoomListAvatarStore.getState().ensureHydrated();
  syncPollerBackgroundPolicy();
  startNativePollTick();
  startAppStateWake();
  if (firstPollTimer) clearTimeout(firstPollTimer);
  firstPollTimer = setTimeout(() => {
    firstPollTimer = null;
    roomLoggedEmpty = false;
    void pollPrivateMessages();
    void pollRooms();
  }, FIRST_POLL_MS);
  return stopMessagePollers;
}

/**
 * 设置页每次改开关都会调它。
 * ★ 不再清空游标：旧版 `pmPrimed/roomPrimed=false` + clear() 会让「改完设置后的
 *   第一批新消息」被当成基线整批吞掉（用户反馈「部分新消息不提示」之一）。
 *   现在只复位空响应提示，开关状态每轮实时读取。
 */
export function resetPollerBaselines() {
  roomLoggedEmpty = false;
  logInfo('[notify] 设置已更新：保留消息游标（不再重建基线）', LOG_TAG);
}
