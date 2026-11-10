/**
 * 房间消息（云信圈组 / QChat）收发。
 *
 * 为什么单独一条链路：口袋48 的「房间消息」走云信圈组，而云信只有 Android/iOS 官方 SDK
 * 支持圈组的消息收发；Web/RN 版 SDK 里 qchat 仅保留「取接入地址」，没有发送命令。
 * 因此这里经原生桥（NativeModules.PocketIm，见 PocketImModule.java）调用官方 basesdk + qchat。
 *
 * 官方同款参数（口袋48 7.1.39）：
 *   MessageManger#sendTextMessage
 *     new QChatSendMessageParam(serverId, channelId, MsgTypeEnum.text)
 *     setBody(text) + setExtension(ChatMsgUtil.getChannelBaseParams(channelRole, bubbleId))
 *     extension = { channelRole, bubbleId, module: 'QCHAT', user: {...} }
 */

import pocketApi from '../../api/pocket48';
import {
  addPocketImMessageListener,
  isPocketImAvailable,
  pocketImInit,
  pocketImLogin,
  pocketImObserveMessages,
  pocketImSendChannelText,
  type PocketImMessage,
} from '../../native/PocketIm';
import {
  isPocketNimQChatAvailable,
  qchatConnect,
  qchatDisconnect,
  qchatSend,
  onQChatMessage,
  onQChatStatus,
} from '../../native/PocketNimQChat';
import { loadSelfProfile } from './credentials';
import { loadNimCredentials } from './credentials';
import { credentialsToProfile } from './runtime';
// 引用（回复）消息的 ext 片段：字段口径的唯一实现在 utils/roomReply（发送侧与展示侧共用）
import { buildRoomReplyExt, type RoomReplyTarget } from '../../utils/roomReply';
import { logInfo, logWarn } from '../../utils/runtimeLog';
import { NimModule, NimMsgType } from './types';
import type { NimSelfProfile } from './types';

export interface RoomMessageTarget {
  serverId: string | number;
  channelId: string | number;
  /** 频道身份（官方 channelRole，普通用户 0） */
  channelRole?: number;
  /** 气泡 id（官方默认 '0'） */
  bubbleId?: string;
}

/** 原生桥是否可用（非 Android 或未打包该模块时为 false） */
export { isPocketImAvailable };

let loginInFlight: Promise<void> | null = null;
let loggedInAccid = '';

/**
 * 原生 connect / login 的超时上限。
 * 原生侧永不回调时必须能失败退出，否则会造成"永久占位"（见 ensureQChatNativeLogin 注释）。
 * 15s 取值参考口袋48 官方登录耗时上限；若线上反馈弱网下频繁超时，优先调大此值。
 */
export const QCHAT_LOGIN_TIMEOUT_MS = 15000;

/** 原生 commonlink QChat 登录（幂等） */
let qchatNativeLogins = new Map<string, Promise<void>>();
let qchatNativeAccid = '';
/**
 * 原生连接实时状态（来自 PocketNimQChat:status）。
 * ⚠️ 只比对 accid 不足以判断「还连着」：网络切换 / 被服务端踢 / 进程内 TCP 半开时
 * accid 不变，旧逻辑会直接 return 而**不重连** → 用户反馈的「有概率连不上房间」+ 发送失败。
 */
let qchatLiveState = 'idle';
let qchatStatusWatched = false;
/** 房间消息订阅引用计数：多个组件共用同一条原生连接，最后一个退订才允许断开 */
let observeRefCount = 0;
/**
 * 退订后的**延迟断开宽限期**（毫秒）。
 *
 * ⚠️ 为什么需要（用户 2026-09-30 反馈「反复进入多个房间之后容易卡住」）：
 * 以前 refcount 一归零就立刻 `qchatDisconnect()` + 清空 accid，下次进房必须重新
 * `ensureQChatNativeLogin`（真实连接数秒，超时上限 15s，见 ensureQChatNativeLogin）。
 * 于是「连续切几个房间」= 反复 connect → disconnect → 再 connect，
 * 每次都白等重连，弱网下直接表现为卡住/消息迟迟不出现。
 * 现在退订后保留连接 60s：期间再进房间直接复用；真正长时间离开才断（省电省流量）。
 */
const QCHAT_IDLE_DISCONNECT_MS = 60000;
let qchatIdleTimer: ReturnType<typeof setTimeout> | null = null;

function cancelIdleDisconnect(): void {
  if (qchatIdleTimer) {
    clearTimeout(qchatIdleTimer);
    qchatIdleTimer = null;
  }
}

function scheduleIdleDisconnect(): void {
  cancelIdleDisconnect();
  qchatIdleTimer = setTimeout(() => {
    qchatIdleTimer = null;
    if (observeRefCount > 0) return; // 宽限期内又有人订阅 → 保持连接
    try {
      qchatDisconnect();
    } catch {
      /* 忽略 */
    }
    // 断开后复位登录态：否则下次 ensureQChatNativeLogin 见 accid 相同会直接 return，不会真正重连
    qchatNativeAccid = '';
    qchatLiveState = 'idle';
  }, QCHAT_IDLE_DISCONNECT_MS);
}
/**
 * 连接世代：每次 reset（切号）递增。
 * 用于丢弃「reset 之后才完成的旧账号 connect」——否则旧任务会写回 qchatNativeAccid，
 * 让后续发送/订阅误以为已用新账号连上（重置与进行中连接赛跑）。
 */
let qchatGeneration = 0;

function watchQChatStatus(): void {
  if (qchatStatusWatched) return;
  qchatStatusWatched = true;
  try {
    onQChatStatus((status) => {
      const next = status.state || 'idle';
      const prev = qchatLiveState;
      qchatLiveState = next;
      // 诊断（tag nim）：真实时通道有没有接连上，一眼可见（release 也打）
      if (next !== prev) {
        logInfo(`[rt] 圈组连接 ${prev} → ${next}${status.detail ? `（${status.detail}）` : ''}`, 'nim');
      }
      if (next === 'disconnected' || next === 'error') {
        /**
         * ★ 连接重建保护窗（用户 2026-11-10：「通知与未读还是不正常」，真机日志实证）：
         * 原生 `connect()` 每次都先 destroy 旧 client（PocketNimQChatModule.connect 的
         * disconnectInternal），旧 client 会立即上报一次 disconnected —— 这**不是断连**。
         * 之前把它当断连处理（清登录态 + 调度重连）→ 每次重连又销毁刚建的连接 →
         * 又上报 disconnected → 又重连……每 ~6s 一轮永不停止（真机 logcat 实录）。
         * 保护窗内的 disconnected/error 一律忽略：connect 成功会自愈，失败走 catch 主动重连。
         */
        if (Date.now() < qchatConnectGuardUntil) {
          logInfo('[rt] 连接重建保护窗内的断开上报，忽略（防重连风暴）', 'nim');
          return;
        }
        // 连接已死 → 复位登录态，下次发送/进房重新连接
        qchatNativeAccid = '';
        // 房间里还有人订阅时自动重连：否则实时通道永久断掉，只剩 HTTP 轮询
        //（表现就是「房间里消息十几秒才更新」）
        if (observeRefCount > 0) scheduleQChatReconnect();
      }
    });
  } catch {
    /* 事件不可用：退化为纯 accid 判定 */
  }
}

/** 断线自愈：3s → 6s → 12s → 24s（封顶 30s）递增重试，连上后重置 */
let qchatReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let qchatReconnectAttempt = 0;
/**
 * 连接重建保护窗截止时刻（epoch ms）。
 * ensureQChatNativeLogin 发起 connect 时设置（覆盖连接超时 + 事件回调延迟余量），
 * 失败时立即清零（让 scheduleQChatReconnect 走正常重连路径）。见 watchQChatStatus 内注释。
 */
let qchatConnectGuardUntil = 0;
function scheduleQChatReconnect(): void {
  if (qchatReconnectTimer) return;
  const delay = Math.min(3000 * Math.pow(2, qchatReconnectAttempt), 30000);
  qchatReconnectTimer = setTimeout(() => {
    qchatReconnectTimer = null;
    if (observeRefCount <= 0) { qchatReconnectAttempt = 0; return; }
    qchatReconnectAttempt += 1;
    ensureQChatNativeLogin(true)
      .then(() => { qchatReconnectAttempt = 0; })
      .catch(() => { if (observeRefCount > 0) scheduleQChatReconnect(); });
  }, delay);
}

/**
 * 重置圈组会话（切号 / 登出）。断开原生连接并清掉登录态与在途登录，
 * 使下一次发送/订阅按**新账号**重新连接。
 */
export function resetQChatSession(reason = ''): void {
  qchatGeneration += 1;
  loggedInAccid = '';
  qchatNativeAccid = '';
  qchatLiveState = 'idle';
  qchatConnectGuardUntil = 0;
  qchatNativeLogins = new Map();
  // 旧订阅者的 unsub 仍会调用（refcount 已清零 → max(0,-1)=0 不会误断新连接），
  // 这里归零是为了让新订阅从 1 重新计数。
  observeRefCount = 0;
  // 切号/reset：取消挂起的宽限期断开（下面马上就要按新账号重连，别让旧定时器来捣乱）
  cancelIdleDisconnect();
  try {
    qchatDisconnect();
  } catch {
    /* 忽略 */
  }
  // eslint-disable-next-line no-console
  console.log('[nim] qchat session reset', reason ? `(${reason})` : '');
}

async function ensureQChatNativeLogin(force = false): Promise<void> {
  watchQChatStatus();
  const creds = await loadNimCredentials();
  if (!creds) throw new Error('未取到云信登录凭证，请重新登录口袋48账号');
  // 已连接（accid 一致且原生未报断连）→ 复用；force = 发送失败后的强制重连
  if (!force && qchatNativeAccid === creds.accid && qchatLiveState !== 'disconnected' && qchatLiveState !== 'error') {
    return;
  }
  const existing = qchatNativeLogins.get(creds.accid);
  if (existing) return existing;
  const generation = qchatGeneration;
  const task: Promise<void> = (async () => {
    // eslint-disable-next-line no-console
    console.log('[nim] native qchat connect account =', creds.accid);
    /**
     * ⚠️ 必须带超时：原生 connect 永不回调时（弱网/原生异常），若不设上限，
     *   ① await task 永久挂起；② finally 永不执行 → qchatNativeLogins 里的条目永久残留；
     *   ③ 之后所有 ensureQChatNativeLogin 都命中 existing 拿到同一个死 Promise
     *      → 弹幕永久发不出去，只能杀 App 才恢复。
     */
    // 这次 connect 就是「重连」本身 → 取消挂起的重连定时器（否则它到点又 force 一次 connect，
    // 把刚建好的连接销毁——重连风暴的另一半驱动源）
    if (qchatReconnectTimer) {
      clearTimeout(qchatReconnectTimer);
      qchatReconnectTimer = null;
    }
    qchatLiveState = 'connecting';
    // 保护窗 = 连接超时上限 + 事件回调延迟余量：期间原生因销毁旧 client 上报的
    // disconnected 不再触发「清登录态 + 再调度重连」（见 watchQChatStatus 注释）
    qchatConnectGuardUntil = Date.now() + QCHAT_LOGIN_TIMEOUT_MS + 3000;
    try {
      await Promise.race([
        qchatConnect(pocketImAppKeyCompat(), creds.accid, creds.token),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('云信圈组连接超时，请重试')), QCHAT_LOGIN_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // 失败立即解除保护窗：让 catch 侧的 scheduleQChatReconnect 走正常重连路径
      qchatConnectGuardUntil = 0;
      qchatLiveState = 'error';
      throw err;
    }
    // reset（切号）发生在本次连接过程中 → 这条连接属于旧账号，丢弃并立刻断开，
    // 否则会把旧账号写进登录态，之后发送会以旧身份出去
    if (generation !== qchatGeneration) {
      // eslint-disable-next-line no-console
      console.log('[nim] native qchat connect finished after session reset → discard');
      try {
        qchatDisconnect();
      } catch {
        /* 忽略 */
      }
      return;
    }
    qchatNativeAccid = creds.accid;
    qchatLiveState = 'connected';
    // eslint-disable-next-line no-console
    console.log('[nim] native qchat CONNECTED');
  })();
  qchatNativeLogins.set(creds.accid, task);
  try {
    await task;
  } finally {
    qchatNativeLogins.delete(creds.accid);
  }
  return task;
}

/** appKey 兜底（原生侧同样是这个常量） */
function pocketImAppKeyCompat(): string {
  return '632feff1f4c838541ab75195d1ceb3fa';
}

/** 幂等登录：init + login 只做一次（切换账号时自动重登） */
async function ensureLogin(): Promise<void> {
  if (!isPocketImAvailable()) {
    throw new Error('房间发言需要云信圈组通道，当前构建未包含该原生模块');
  }
  const creds = await loadNimCredentials();
  if (!creds) throw new Error('未取到云信登录凭证，请重新登录口袋48账号');
  if (loggedInAccid === creds.accid) return;
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    try {
      // eslint-disable-next-line no-console
      console.log('[nim] qchat ensureLogin accid =', creds.accid, 'tokenLen =', creds.token.length);
      await pocketImInit();
      await pocketImLogin(creds.accid, creds.token);
      loggedInAccid = creds.accid;
      // eslint-disable-next-line no-console
      console.log('[nim] qchat login ok');
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.log('[nim] qchat login FAILED:', String(err?.message || err));
      throw err;
    } finally {
      loginInFlight = null;
    }
  })();
  return loginInFlight;
}

/**
 * 构造圈组消息扩展段（对齐 ChatMsgUtil.getChannelBaseParams）。
 * 服务端会用 user 段渲染昵称/头像，缺失时消息可能显示异常。
 *
 * 第三参 `reply` = 引用（回复）别人的消息（用户 2026-10-14）：字段口径唯一实现在
 * `utils/roomReply.buildRoomReplyExt`（展示侧读回用的也是同一套键）。
 */
export function buildChannelExt(
  target: RoomMessageTarget,
  self: NimSelfProfile,
  reply?: RoomReplyTarget | null
): string {
  // 字段与桌面版 member-room-message.buildExtension 一致（vip/pfUrl/teamLogo 缺了别人那端渲染就缺东西）
  // 官方 getChannelBaseParams：channelRole 是 **Integer**（我们此前发字符串，gson 解析异常时身份就乱了）
  return JSON.stringify({
    module: NimModule.QCHAT,
    channelRole: Math.trunc(Number(self.sessionRole ?? target.channelRole ?? 0)) || 0,
    user: {
      userId: self.userId,
      nickName: self.nickName,
      teamLogo: self.teamLogo || '',
      avatar: self.avatar,
      level: self.level ?? 0,
      roleId: self.roleId ?? 0,
      vip: self.vip === true,
      pfUrl: self.pfUrl || '',
    },
    bubbleId: String(target.bubbleId || '0'),
    // 无引用时是空对象，等价于老行为（不写 messageType → 服务端按 TEXT 记录）
    ...buildRoomReplyExt(reply),
  });
}

/**
 * 发送房间文本消息（带 `reply` 时即为「引用某条消息」的回复）。
 *
 * 返回 **msgIdClient**（原生 ACK 返回的客户端消息 id）：引用消息用它做本机兜底
 * （见 utils/roomReply.rememberOwnReplyQuote —— 服务端没把 ext 带回来时自己这侧仍能显示引用卡）。
 * JS Web SDK 兜底通道没有这个 id，返回空串。
 */
export async function sendRoomTextMessage(
  target: RoomMessageTarget,
  text: string,
  reply?: RoomReplyTarget | null
): Promise<string> {
  const content = String(text || '').trim();
  if (!content) return '';
  const serverId = Number(target.serverId);
  const channelId = Number(target.channelId);
  if (!Number.isFinite(serverId) || !Number.isFinite(channelId) || channelId <= 0) {
    throw new Error('缺少房间 serverId / channelId');
  }
  // 优先走原生 commonlink QChat 通道：官方 SDK 只能带真实包名 → 被服务端拒（实测 414）
  const self = await loadSelfProfile();
  if (!self) throw new Error('未取到云信登录凭证，请重新登录口袋48账号');
  const ext = buildChannelExt(target, self, reply);
  // 诊断：ext 含 userId / 昵称 / 头像等个人信息，仅开发版打印（release 不打，避免日志外泄）
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[nim] qchat send ext =', ext.slice(0, 400));
  }
  if (isPocketNimQChatAvailable()) {
    await ensureQChatNativeLogin();
    try {
      return await qchatSend(String(serverId), String(channelId), content, ext);
    } catch (error: any) {
      // 发送失败最常见的原因是连接已死（TCP 半开 / 被服务端踢 / 刚切过号）：
      // 强制重连一次再发，避免用户看到「发送失败」而其实只是连接需要重建
      // （即用户反馈的「有概率连不上房间 / 发送出错」）。
      const detail = String(error?.message || error || '');
      logWarn(`[nim] qchat 发送失败，重连后重试：${detail}`, 'nim');
      await ensureQChatNativeLogin(true);
      try {
        return await qchatSend(String(serverId), String(channelId), content, ext);
      } catch (retryError: any) {
        // 重连后仍失败：给出可读原因（多为凭证过期 / 房间 serverId 与 channelId 不匹配）
        throw new Error(`房间消息发送失败（已重连重试）：${String(retryError?.message || retryError || detail)}`);
      }
    }
  }
  await ensureLogin();
  await pocketImSendChannelText(serverId, channelId, content, ext);
  return '';
}

/**
 * 删除（撤回）自己在房间发送的消息。官方仅允许删除本人消息（服务端校验 accId）。
 * payload 取自消息项：channelId / msgIdClient / msgTime。
 */
export async function deleteRoomMessage(params: {
  channelId: number | string;
  msgIdClient: string;
  msgTime: number;
}): Promise<void> {
  const creds = await loadNimCredentials();
  if (!creds) throw new Error('未取到云信登录凭证，请重新登录口袋48账号');
  if (!params.msgIdClient) throw new Error('缺少消息 ID');
  if (!params.msgTime || params.msgTime <= 0) throw new Error('缺少消息时间');
  await pocketApi.deleteTeamMsg({
    accId: creds.accid,
    msgIdClient: String(params.msgIdClient),
    channelId: String(params.channelId || ''),
    msgTime: Number(params.msgTime),
  });
}

/** 归一化后的房间消息（与 HTTP 历史消息字段对齐，便于直接拼进列表） */
export interface RoomLiveMessage {
  uuid: string;
  serverId: number;
  channelId: number;
  fromAccount: string;
  fromNick: string;
  time: number;
  text: string;
  messageType: string;
  /** 解析后的 remoteExtension */
  ext: Record<string, any>;
}

function normalizeLiveMessage(msg: PocketImMessage): RoomLiveMessage | null {
  if (!msg || !msg.uuid) return null;
  let ext: Record<string, any> = {};
  try {
    ext = msg.extension ? JSON.parse(msg.extension) : {};
  } catch {
    ext = {};
  }
  const user = (ext.user && typeof ext.user === 'object' ? ext.user : {}) as Record<string, any>;
  return {
    uuid: String(msg.uuid),
    serverId: Number(msg.serverId) || 0,
    channelId: Number(msg.channelId) || 0,
    fromAccount: String(msg.fromAccount || user.accid || ''),
    fromNick: String(msg.fromNick || user.nickName || ''),
    time: Number(msg.time) || Date.now(),
    text: String(msg.content || ext.text || ''),
    messageType: String(ext.messageType || NimMsgType.TEXT),
    ext,
  };
}

/** 订阅房间实时消息（返回取消订阅函数；不支持时为空操作） */
export async function observeRoomMessages(
  handler: (messages: RoomLiveMessage[]) => void
): Promise<() => void> {
  // 原生 commonlink QChat 通道（推荐路径）
  if (isPocketNimQChatAvailable()) {
    /**
     * ⚠️ 登录失败**不能静默返回空操作**（用户 2026-11-09：「房间列表角标永远 1」）。
     * 以前这里 `catch { return () => undefined }` —— 列表页那条常驻未读订阅如果
     * 恰好赶在云信登录就绪之前挂上（冷启动几乎必然），它会**永久收不到任何消息**，
     * 角标只能靠 30s 指纹（一轮最多 +1），数字看着就是「不涨 / 只涨 1」。
     * 现在向上抛，调用方可以重试；房间页自己 .catch，不受影响。
     */
    await ensureQChatNativeLogin();
    observeRefCount += 1;
    // 有人在用 → 取消上次排的「延迟断开」（连续切房时连接保持复用，不重连）
    cancelIdleDisconnect();
    const off = onQChatMessage((message) => {
      let ext: Record<string, any> = {};
      try {
        ext = message.ext ? JSON.parse(message.ext) : {};
      } catch {
        ext = {};
      }
      const user = (ext.user && typeof ext.user === 'object' ? ext.user : {}) as Record<string, any>;
      handler([
        {
          uuid: message.msgIdClient || message.msgIdServer || `${message.time}`,
          serverId: Number(message.serverId) || 0,
          channelId: Number(message.channelId) || 0,
          fromAccount: message.fromAccount,
          fromNick: message.fromNick || String(user.nickName || ''),
          time: message.time || Date.now(),
          text: message.body || String(ext.text || ''),
          messageType: String(ext.messageType || 'TEXT'),
          ext,
        },
      ]);
    });
    return () => {
      off();
      // ⚠️ 引用计数：房间页与其它调用方共用同一条原生连接，
      // 任一方退订就 disconnect 会把另一方的连接一起掐掉
      // （症状：切页/退出再进后收不到实时消息、发送失败）。
      observeRefCount = Math.max(0, observeRefCount - 1);
      if (observeRefCount === 0) {
        // 不立即断开：留 60s 宽限期（反复切房可复用连接，避免每次重连数秒/超时 15s）。
        // 断开时同样要复位登录态：否则下次 ensureQChatNativeLogin 见 accid 相同会直接 return，
        // 不会真正重连 → 房间消息通道「只能连接/发送一次」。
        scheduleIdleDisconnect();
      }
    };
  }
  if (!isPocketImAvailable()) return () => undefined;
  try {
    await ensureLogin();
    await pocketImObserveMessages(true);
  } catch {
    return () => undefined;
  }
  const sub = addPocketImMessageListener((raw) => {
    const items = (raw || [])
      .map((item) => normalizeLiveMessage(item))
      .filter((item): item is RoomLiveMessage => !!item);
    if (items.length) handler(items);
  });
  return () => {
    sub.remove();
    pocketImObserveMessages(false).catch(() => undefined);
  };
}
