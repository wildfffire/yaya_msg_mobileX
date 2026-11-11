/**
 * 「新消息游标」纯规则（对齐上游 yk1z/yaya_msg 的 followed-rooms-feature.js
 * 与 private-message-notifications.js，用户 2026-11-10 三轮返工后的定版口径）。
 *
 * 上游的两条硬经验：
 *   · `last/message/get` 的预览条目**没有 msgId / msgTime**（真机实测 keys=
 *     serverId,channelId,msgContent,starName）。只拿「最新一条的内容指纹」判新，
 *     一轮内连发 N 条只剩最后一条、同内容的两条完全撞车 → 「部分新消息不提示」；
 *   · 所以预览只用来决定**要不要去拉消息详情**，真正判定新消息靠详情里的
 *     `msgIdClient / msgIdServer / messageId` 集合 + `msgTime` 时间游标。
 *
 * 这里不 import 任何 React / i18n / 网络模块，便于纯 Node 单测锁定：
 *   · 同秒多条、同内容多条（id 不同）都要能挑出来；
 *   · 通知发送失败的消息 id **不能进游标**，下一轮必须能重试；
 *   · 首轮只建基线（不发通知），基线时间取首屏最新消息、绝不取 Date.now()。
 */
export interface MessageCursor {
  /** 是否已建过基线；false 时本轮只播种，不产生 fresh */
  primed: boolean;
  /** 已见过的最大消息时间（ms；0 = 详情里全都没时间字段） */
  time: number;
  /** 已处理过的消息 id 集合（有上限，见 MESSAGE_CURSOR_KEY_MAX） */
  keys: string[];
  /** 上一轮的预览指纹（last/message/get 条目的内容指纹 / 私信会话预览） */
  preview: string;
  /** 上一轮观测到的服务端未读数（缺失用 -1） */
  unread: number;
}

export const MESSAGE_CURSOR_KEY_MAX = 300;

export function emptyMessageCursor(): MessageCursor {
  return { primed: false, time: 0, keys: [], preview: '', unread: -1 };
}

/** 秒 / 毫秒时间戳统一成毫秒；脏值（0、负数、非数字、过小的广告位数字）一律 0 */
export function normalizeMessageTime(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 小于 10 亿的不是时间戳（广告位 / 计数 / 毫秒片段）；10 亿~1 万亿按「秒」处理
  if (n < 1e9) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

const TIME_KEYS = [
  'msgTime', 'messageTime', 'timestamp', 'ctime', 'time',
  'createTime', 'sendTime', 'newestMessagetime', 'lastTime', 'msgTimestamp',
];

/** 消息时间：认多种别名（HTTP 详情 / 私信详情 / 圈组实时各不一样） */
export function messageTime(msg: any): number {
  if (!msg || typeof msg !== 'object') return 0;
  for (const key of TIME_KEYS) {
    const t = normalizeMessageTime(msg[key]);
    if (t > 0) return t;
  }
  return 0;
}

/**
 * 消息 id 字段别名（按优先级）。
 *
 * ⚠️ 唯一来源：`messageId`（游标/去重）与 `notifyOwnerRules.messageIdAliases`
 *（服务端房主表比对）都从这里取 —— 以前两处各维护一份同样的键表，加字段时必漏一边。
 */
export const MESSAGE_ID_KEYS = [
  'msgidClient', 'msgIdClient', 'msgIdServer', 'msgidServer',
  'uuid', 'clientMsgId', 'messageId', 'msgId', 'messageid', 'id',
];

const ID_KEYS = MESSAGE_ID_KEYS;

function scalarPreview(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return '';
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return scalarPreview(parsed);
      } catch {
        /* 正文不是 JSON：原样返回 */
      }
    }
    return raw.slice(0, 160);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'msg', 'message', 'body', 'caption', 'desc']) {
      const text = scalarPreview((value as any)[key]);
      if (text) return text;
    }
  }
  return '';
}

/** 纯文本预览（无稳定 id 时也参与兜底键） */
export function messagePreview(msg: any): string {
  if (!msg || typeof msg !== 'object') return typeof msg === 'string' ? msg.slice(0, 160) : '';
  for (const key of ['bodys', 'msgContent', 'content', 'text', 'newestMessage', 'message', 'body']) {
    const text = scalarPreview((msg as any)[key]);
    if (text) return text;
  }
  return '';
}

/**
 * 消息类型（各链路字段名不同：`bodys.messageType` / `msgType` / `messageType` / `type`）。
 *
 * ⚠️ 统一入口的原因：以前实时通道、30s 精确计数、5s 轮询各写一份取值+正则，
 * 三份一旦漂移就会出现「某个类型实时算、轮询不算」的角标漏计。
 */
export function messageTypeOf(msg: any): string {
  return String(
    msg?.bodys?.messageType || msg?.msgType || msg?.messageType || msg?.type || 'TEXT',
  ).toUpperCase();
}

/**
 * 哪些消息类型参与「未读角标 / 房间通知」判定（礼物 / 进房特效 / 系统公告不算）。
 * `FLIP*`（翻牌）算聊天消息（用户 2026-09-30：翻牌也要有未读提示）。
 */
export function isCountableMessageType(type: unknown): boolean {
  const t = String(type || 'TEXT').toUpperCase();
  return /^(TEXT|REPLY|GIFTREPLY|EXPRESSIMAGE|IMAGE|AUDIO|VIDEO|BARRAGE_|FLIP)/.test(t);
}

/** 这条消息是否参与「未读角标 / 房间通知」判定（取值 + 正则的唯一实现） */
export function isCountableChatMessage(msg: any): boolean {
  return isCountableMessageType(messageTypeOf(msg));
}

/** 消息唯一键：优先稳定 id（含上游兼容别名），缺 id 才用「时间:正文」兜底 */
export function messageId(msg: any): string {
  if (!msg || typeof msg !== 'object') return '';
  for (const key of ID_KEYS) {
    const raw = (msg as any)[key];
    if (raw === null || raw === undefined) continue;
    const s = String(raw).trim();
    if (s && s !== '0' && s !== 'undefined' && s !== 'null') return s;
  }
  const t = messageTime(msg);
  const preview = messagePreview(msg);
  return t || preview ? `${t}:${preview}` : '';
}

/** 发送者 id（私信详情里用来排除自己发的消息） */
export function messageSenderId(msg: any): string {
  if (!msg || typeof msg !== 'object') return '';
  const raw = msg.senderUserId ?? msg.fromUserId ?? msg.senderId ?? msg.fromAccount
    ?? msg.user?.userId ?? msg.user?.id ?? msg.userId ?? msg.uid ?? '';
  return raw === null || raw === undefined ? '' : String(raw).trim();
}

/** 自己发的消息：显式 self 标记优先，其次与当前用户 id 比对 */
export function messageIsSelf(msg: any, selfId = ''): boolean {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.isSelf === true || msg.self === true || msg.isMe === true) return true;
  if (msg.isSelf === false || msg.self === false || msg.isMe === false) return false;
  const from = messageSenderId(msg);
  return !!from && !!selfId && from === String(selfId);
}

export interface FreshResult {
  /** 本轮应处理（通知 / 计数）的新消息 */
  fresh: any[];
  /** 本页全部消息 id（用于推进游标；失败的那几条由调用方剔除） */
  pageKeys: string[];
  /** 本页最大消息时间（ms） */
  newest: number;
}

/**
 * 从详情一页里挑出新消息。
 *
 * 判据：id 没见过 **且**（时间更新 / 同一秒 / 时间未知）。
 * 时间比游标旧的「没见过的 id」视为历史补页，不算新消息（防止刷新历史时炸出一屏通知）。
 * 未建基线时 fresh 恒为空 —— 冷启动不把历史消息一次性弹出来。
 */
export function findFreshMessages(list: any[] | null | undefined, cursor: MessageCursor): FreshResult {
  const msgs = Array.isArray(list) ? list.filter(Boolean) : [];
  const pageKeys: string[] = [];
  let newest = 0;
  for (const m of msgs) {
    const key = messageId(m);
    if (key) pageKeys.push(key);
    const t = messageTime(m);
    if (t > newest) newest = t;
  }
  if (!cursor.primed) return { fresh: [], pageKeys, newest };
  const known = new Set(cursor.keys);
  const inPage = new Set<string>();
  const fresh: any[] = [];
  for (const m of msgs) {
    const key = messageId(m);
    if (!key || known.has(key) || inPage.has(key)) continue;
    inPage.add(key);
    const t = messageTime(m);
    if (t > 0 && t < cursor.time) continue;
    fresh.push(m);
  }
  return { fresh, pageKeys, newest };
}

export interface AdvanceCursorInput {
  /** 本轮成功处理掉的消息 id（通知失败的那几条不要放进来） */
  pageKeys: string[];
  newest: number;
  preview: string;
  unread: number;
}

/** 推进游标：只前进不后退；keys 保留最近 300 个（与上游 recentMessageKeys 同口径） */
export function advanceCursor(cursor: MessageCursor, input: AdvanceCursorInput): MessageCursor {
  const keys = [...cursor.keys];
  const seen = new Set(keys);
  for (const key of input.pageKeys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return {
    primed: true,
    time: Math.max(cursor.time, input.newest || 0),
    keys: keys.length > MESSAGE_CURSOR_KEY_MAX ? keys.slice(keys.length - MESSAGE_CURSOR_KEY_MAX) : keys,
    preview: String(input.preview || ''),
    unread: Number.isFinite(input.unread) ? input.unread : -1,
  };
}

/** 预览指纹 / 服务端未读变化 → 需要拉详情；force 用于定期全量兜底扫描 */
export function cursorNeedsCheck(cursor: MessageCursor, preview: string, unread: number, force = false): boolean {
  if (force || !cursor.primed) return true;
  if (String(preview || '') !== cursor.preview) return true;
  return unread >= 0 && cursor.unread >= 0 && unread > cursor.unread;
}

/**
 * 详情响应是否真的来自**本侧**的频道。
 *
 * `getRoomMessages` 在小房间（yklzId）请求失败时会按 attempts 顺序回退到
 * `fallbackChannelId`（大房间 channelId）；消息体里又没有 channelId 字段，
 * 调用方会把大房间消息当成小房间消息记进小房间游标/计数 —— 用户反馈的
 * 「已经消除过的消息再次提示，并出现在小房间」。
 * `tryPocketPost` 会把实际命中的 payload 放在 `res._request.payload.channelId`，
 * 用它比对即可识别串味；拿不到 `_request` 时按本侧处理（不误伤）。
 */
export function isDetailFromSide(usedChannelId: unknown, sideChannelId: string): boolean {
  const used = String(usedChannelId ?? '').trim();
  if (!used) return true;
  return used === String(sideChannelId ?? '').trim();
}

/**
 * 一条消息能不能算进「未读角标」（时间维度的门槛）。
 *
 * @param time      本条消息的服务器时间（ms；0 = 该消息没有时间字段）
 * @param sideSeenAt 该侧「上次数到哪」的基线（sideSeenAt；0 = 未知）
 * @param readFloor 房间级已读基线（lastReadAt；0 = 还没读过这个房间）
 *
 * 两个门槛的边界语义不同，不能合并：
 *   · `readFloor`：**严格晚于**才算未读 —— 进房/退房时它被写成「房间内看到的最新一条」，
 *     时间恰好等于它的那条是**用户已经看过的**；
 *   · `sideSeenAt`：**等于也算** —— 它是「上一次数过的页里最新一条」的时间，
 *     同一毫秒/同一秒连发的多条不能因为时间相等被漏掉（去重交给消息 id 总账）。
 *   · 时间未知（0）时放行：宁可让 id 总账去重，也不能因为接口缺时间字段就整条丢掉。
 *
 * ⚠️ 为什么需要它（用户 2026-11-11「有的成员有新消息不会计数也不显示」）：
 * 旧版精确计数在 `prevAt === 0` 时一律走「首次基线」并返回 0 —— 而 `sideSeenAt` 会在
 * **每次进房**被清零（两侧），于是「退房后新到的消息」只要先被 30s 指纹路径撞上，
 * 就会被当成基线整批吞掉（不计数、指纹却已推进）。有了已读基线兜底，
 * 只要这个房间用户读过（lastReadAt > 0），新消息就不会再被吞。
 */
export function isCountableUnreadMessage(time: number, sideSeenAt: number, readFloor: number): boolean {
  const t = Number(time) || 0;
  const floor = Number(readFloor) || 0;
  const seen = Number(sideSeenAt) || 0;
  if (t <= 0) return true;
  if (floor > 0 && t <= floor) return false;
  if (seen > 0 && t < seen) return false;
  return true;
}

/**
 * 回溯翻页硬上限（页）：真正翻多少由「上次消费到的位置」决定，这里只兜底防失控
 *（20 页 ≈ 1000 条；配合每轮页数预算跨轮续翻，不会一次打几十个请求）。
 */
export const MESSAGE_BACKFILL_MAX_PAGES = 20;

/**
 * 回溯的停止边界：**「上次轮询消费到的位置」优先**，没有才退回房间级已读基线。
 *
 * 为什么优先 cursor.time（用户 2026-11-11「一直找到上次看到的地方为止」）：
 * `cursor.time` 是上一次成功轮询那一页的最新时间 —— 它之前的消息都已经进过游标
 *（见过 / 已读 / 已计数），再往前翻没有任何意义，只会白打请求。
 * `lastReadAt` 只在进房/退房时推进，粒度更粗（可能比「上次轮询」早很多），
 * 但房间里刚看完的消息它更准，所以作为没有游标时的兜底。
 */
export function backfillBoundary(cursorTime: number, readFloor: number): number {
  const seen = Number(cursorTime) || 0;
  if (seen > 0) return seen;
  return Number(readFloor) || 0;
}

/**
 * 拉到的这一页详情是否**必须继续往前翻**。
 *
 * 背景（用户 2026-11-11「覃柯蒙 15:45 的消息没有角标」，真机日志实证）：
 * 关通知时后台轮询是停的（用户要求省电），实时通道又恰好 broken pipe，
 * 于是 App 回到前台时这段时间的消息**全部积压**；最新一页 50 条被粉丝刷满，
 * 房主那条已经被挤出窗口 —— 两条通道都数不到，必须一直往前翻到边界为止。
 *
 * 判定（缺一不可）：
 *   · 这一页是**满的**（说明后面还有更早的消息）；
 *   · 知道边界在哪（`boundary > 0`，见 backfillBoundary）；
 *   · 还没翻到边界（`oldestTime > boundary`）；
 *   · 这一页**全是没见过的新消息**、或该侧游标还没建立（`!primed`）——
 *     正常增量（本次只有 1~2 条新消息）不回溯，避免每轮多打请求。
 */
export function shouldBackfillOlder(input: {
  /** 本页条数 */
  pageLength: number;
  /** 单页请求上限 */
  limit: number;
  /** 本页里「游标没见过」的条数 */
  freshCount: number;
  /** 该侧游标是否已建立 */
  primed: boolean;
  /** 回溯停止边界（ms；0 = 不知道边界，不回溯） */
  boundary: number;
  /** 本页最早一条的时间（ms；0 = 都不知道） */
  oldestTime: number;
}): boolean {
  const limit = Number(input.limit) || 0;
  if (limit <= 0) return false;
  if ((Number(input.pageLength) || 0) < limit) return false;
  const boundary = Number(input.boundary) || 0;
  if (boundary <= 0) return false;
  const oldest = Number(input.oldestTime) || 0;
  if (oldest > 0 && oldest <= boundary) return false;
  return input.primed !== true || (Number(input.freshCount) || 0) >= limit;
}

/**
 * 补偿扫描是否允许把这条消息补计为未读。
 *
 * 三个门槛缺一不可（上一轮补偿扫描只挡了 `t < cur.time`，会把「时间恰好等于
 * 上一轮最新消息」的已读消息每轮重扫；进程重启后计数总账清空、已读基线还在，
 * 就会出现「已经消除过的消息再次提示」）：
 *   · 时间字段必须有效（t=0 的消息交给 fresh 的 id 游标处理）；
 *   · 严格晚于上一轮游标时间（等于也不补）；
 *   · 严格晚于房间级已读基线 `lastReadAt`（进房/退房/一键已读都会推进它）。
 */
export function canCompensateUnread(t: number, cursorTime: number, readFloor: number): boolean {
  if (!(t > 0)) return false;
  if (t <= (Number(cursorTime) || 0)) return false;
  if (t <= (Number(readFloor) || 0)) return false;
  return true;
}

/** 一批新消息的稳定去重键（同内容但 id 不同 → 键不同，不会被 10min dedupe 吞掉） */
export function freshBatchKey(fresh: any[]): string {
  if (!fresh.length) return '';
  const first = messageId(fresh[0]);
  const last = messageId(fresh[fresh.length - 1]);
  const newest = Math.max(...fresh.map((m) => messageTime(m)));
  return `${fresh.length}:${newest}:${first}:${last}`;
}
