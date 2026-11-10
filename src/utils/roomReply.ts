/**
 * 房间消息「引用（回复）」的纯规则层（用户 2026-10-14：房间内发消息要能引用别人的消息）。
 *
 * 为什么单独成层：
 *   · **发送侧**在 `services/pocketNim/qchat.ts`（构造云信圈组消息的 ext），
 *     **展示侧**在 `screens/room/RoomChatMessageRow.tsx`（渲染引用卡）——
 *     两处必须用同一套字段名，否则「我发的引用别人看不到 / 别人发的引用我这边不显示」；
 *   · 零依赖（不引 i18n / react / RN），因此能进 `npm run test:core`
 *     被 `scripts/room-reply.test.mjs` 钉成回归锁。
 *
 * 字段口径（官方口袋48：历史消息的 `extInfo.messageType === 'REPLY'`、
 * `extInfo.replyName` / `extInfo.replyText` —— 见 docs/API_RESEARCH.md 第 2.1 节）：
 *   发出的 ext = { messageType: 'REPLY', replyName, replyText,
 *                  replyInfo: { replyName, replyText, replyMsgIdClient, replyUserId } }
 *   读取时**嵌套口径（replyInfo）与扁平口径（replyName/replyText）都认**：
 *     - 嵌套：本项目发出（实时回显 / HTTP 历史）与老客户端；
 *     - 扁平：官方 App 发出的引用消息（引用信息在 extInfo 上，不是在 bodys 里）。
 *
 * ⚠️ 扁平口径只认 `messageType === 'REPLY'` 的消息：`GIFTREPLY`（礼物回复）同样带
 * replyName/replyText，但它走礼物卡渲染 —— 混进来会让礼物消息凭空多一张引用卡。
 */

/** 一条「待引用」的消息（由消息行按当前渲染上下文拼出来） */
export interface RoomReplyTarget {
  /** 被引用消息的发送者昵称（引用卡标题） */
  name: string;
  /** 被引用消息正文（引用卡内容；可能为空，如纯图片消息） */
  text: string;
  /** 被引用消息的客户端 id（云信 msgIdClient / HTTP msgIdClient，尽力而为） */
  msgId?: string;
  /** 被引用消息发送者 userId（尽力而为） */
  userId?: string;
}

/**
 * 引用卡里「被引用原文」的长度上限（字符）。
 * 为什么必须截断：这段文字会**留在 ext 里随消息发给所有人**，
 * 引用一条长公告会把整段原文塞进每条回复的扩展段（体积 + 服务端存储）。
 */
export const MAX_REPLY_QUOTE_CHARS = 80;

/** 归一化 + 截断引用原文（空白折叠成单空格，超长补省略号） */
export function clipReplyQuote(text: any): string {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (raw.length <= MAX_REPLY_QUOTE_CHARS) return raw;
  return `${raw.slice(0, MAX_REPLY_QUOTE_CHARS)}…`;
}

/**
 * 构造引用消息要合并进 ext 的字段（无引用时返回空对象，调用方直接 spread 即可）。
 *
 * `messageType: 'REPLY'` 是**必须**的：官方口径把类型放在 ext 上，
 * 服务端据此把消息记成 REPLY（其他端才会去读 replyName/replyText）。
 */
export function buildRoomReplyExt(reply?: RoomReplyTarget | null): Record<string, any> {
  const name = String(reply?.name || '').trim();
  const text = clipReplyQuote(reply?.text);
  if (!name && !text) return {};
  const msgId = String(reply?.msgId || '').trim();
  const userId = String(reply?.userId || '').trim();
  const nested: Record<string, any> = { replyName: name, replyText: text };
  if (msgId) nested.replyMsgIdClient = msgId;
  if (userId) nested.replyUserId = userId;
  return {
    messageType: 'REPLY',
    // 扁平口径（官方 extInfo 结构）
    replyName: name,
    replyText: text,
    // 嵌套口径（本项目读取路径最稳的一条）
    replyInfo: nested,
  };
}

/**
 * 本机刚发出的引用：`msgIdClient → 引用信息` 的会话内缓存（用户 2026-10-14）。
 *
 * 为什么需要（真机反馈「发出消息后没有正常显示引用」）：
 *   引用信息是写在消息 **ext** 里、由服务端存下来再转发的 —— 自己这条消息能不能显示引用卡，
 *   取决于服务端有没有把它原样带回来（实时回显 / HTTP 历史两条链路都算）。
 *   只要有一条链路没带回来（或先到的那条没带），自己这边就会「发出去却看不到引用」，
 *   而 mergeMessages 是**按消息键去重、先到的赢**，后面拿到完整数据也不会覆盖。
 *   所以发送成功即写一份本地兜底，展示侧（resolveRoomReply）读不到服务端数据时用它。
 * 键用 msgIdClient（原生发送 ACK 返回，与实时回显 / HTTP 历史里的同名字段一致）。
 */
const ownReplyQuotes = new Map<string, { name: string; text: string }>();
/** 上限：只在会话内兜底，聊天久了淘汰最早的一批（Map 保插入序，简单 FIFO） */
const OWN_REPLY_QUOTES_MAX = 200;

export function rememberOwnReplyQuote(msgId: string, reply?: RoomReplyTarget | null): void {
  const key = String(msgId || '').trim();
  const name = String(reply?.name || '').trim();
  const text = clipReplyQuote(reply?.text);
  if (!key || (!name && !text)) return;
  ownReplyQuotes.set(key, { name, text });
  if (ownReplyQuotes.size > OWN_REPLY_QUOTES_MAX) {
    const oldest = ownReplyQuotes.keys().next().value;
    if (oldest !== undefined) ownReplyQuotes.delete(oldest);
  }
}

/** 本机发出的引用兜底查询（键取消息的 msgIdClient / uuid / msgId，任一同值即可命中） */
export function ownReplyQuote(item: any): { name: string; text: string } | null {
  const key = String(item?.msgIdClient || item?.uuid || item?.msgId || '').trim();
  if (!key) return null;
  return ownReplyQuotes.get(key) || null;
}

/** 仅供测试 / 会话重置：清空本机兜底缓存 */
export function clearOwnReplyQuotes(): void {
  ownReplyQuotes.clear();
}

/**
 * 展示侧**唯一入口**：服务端数据（bodys / extInfo）优先，读不到时用本机发出的兜底。
 * 任何渲染引用卡的地方都该走这里，不要再直接调 roomReplyInfo。
 */
export function resolveRoomReply(item: any): { name: string; text: string } | null {
  const server = roomReplyInfo(item);
  if (server) return server;
  // 服务端没带回引用信息：若是「看起来像引用」的消息，报一次字段名（便于真机定位，见下）
  diagnoseMissingReply(item);
  return ownReplyQuote(item);
}

/** 已上报过的「有引用痕迹但读不到引用信息」的消息键（去重，避免每帧刷屏） */
const missingReplyLogged = new Set<string>();

/**
 * 诊断（真机 logcat 可见，release 也打，tag `[room.reply]`）：
 * 这条消息**看起来是引用**（类型 REPLY 或带 reply* 字段）却读不到引用信息时，报一次。
 *
 * 只报**字段名**（不报内容 —— 引用原文、昵称都算聊天内容，不进日志）。
 * 用途：区分「服务端没把 ext 带回来」与「字段名变了」这两类根因；
 * 若自己发的引用消息持续命中这条日志，说明服务端没有原样回报 ext（自己这侧由本地兜底兜住）。
 */
export function diagnoseMissingReply(item: any): void {
  if (!item) return;
  const type = String(item?.msgType || '').toUpperCase();
  // 礼物回复（GIFTREPLY）的 replyName/replyText 属于礼物卡，不算「读不到引用信息」
  if (type.includes('GIFT')) return;
  // 便宜的预筛（消息行是热路径：普通消息在这里就返回，不做 JSON 解析）
  const rawExt = item?.extInfo ?? item?.ext ?? item?.extension;
  const extHint = typeof rawExt === 'string'
    ? rawExt.indexOf('"reply') >= 0
    : !!(rawExt && (rawExt.replyName || rawExt.replyText || rawExt.replyInfo));
  const hasTrace = type === 'REPLY' || extHint
    || !!(item?.replyName || item?.replyText || item?.replyInfo);
  if (!hasTrace) return;
  const body = objectOf(payloadOf(item));
  const ext = objectOf(rawExt);
  const signature = String(item?.msgIdClient || item?.uuid || item?.msgId || '')
    || `${type}:${Object.keys(ext).slice(0, 6).join(',')}`;
  if (missingReplyLogged.has(signature)) return;
  if (missingReplyLogged.size > 300) missingReplyLogged.clear();
  missingReplyLogged.add(signature);
  // eslint-disable-next-line no-console
  console.log(
    `[room.reply] 有引用痕迹但读不到引用信息：type=${type} body键=[${Object.keys(body).join(',')}] ext键=[${Object.keys(ext).join(',')}]`
  );
}

/** 解析 JSON 字符串 / 原样返回对象；纯文本正文原样返回字符串（与 utils/data.ts 的取值顺序一致） */
function parsePayload(raw: any): any {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (text[0] !== '{' && text[0] !== '[') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 消息体（与 utils/data.ts 的 messagePayload 同一套取值顺序 + message/msg 内层下钻） */
function payloadOf(item: any): any {
  const raw = item?.bodys ?? item?.body ?? item?.msgContent ?? item?.content ?? item?.message;
  let body = parsePayload(raw);
  if (body && typeof body === 'object') {
    const inner = parsePayload((body as any).message ?? (body as any).msg);
    if (inner && typeof inner === 'object') body = inner;
  }
  return body;
}

function objectOf(value: any): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  const parsed = parsePayload(value);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : {};
}

/**
 * 从一条消息里读回引用信息（没有引用 → null）。
 *
 * 读取顺序：嵌套（body.replyInfo / ext.replyInfo / giftReplyInfo，含两边）→ 扁平（仅 REPLY 类型）。
 */
export function roomReplyInfo(item: any): { name: string; text: string } | null {
  if (!item) return null;
  const body = objectOf(payloadOf(item));
  const ext = objectOf(item?.extInfo ?? item?.ext ?? item?.extension);
  const type = String(
    item?.msgType || body.messageType || ext.messageType || item?.messageType || ''
  ).toUpperCase();
  const nested = body.replyInfo || ext.replyInfo || body.giftReplyInfo || ext.giftReplyInfo;
  if (nested && typeof nested === 'object') {
    const name = String((nested as any).replyName ?? '').trim();
    const text = String((nested as any).replyText ?? (nested as any).replyContent ?? '').trim();
    if (name || text) return { name, text };
  }
  // 扁平口径只认 REPLY：GIFTREPLY 的 replyName/replyText 属于礼物卡（见文件头 ⚠️）
  if (type === 'REPLY') {
    const name = String(ext.replyName ?? body.replyName ?? '').trim();
    const text = String(ext.replyText ?? body.replyText ?? '').trim();
    if (name || text) return { name, text };
  }
  return null;
}

/**
 * 引用消息**自身**的正文（不含 `utils/data.ts#messageText` 给 REPLY 拼的「回复 X：…」前缀）。
 *
 * 为什么需要：`messageText()` 对 REPLY 类型返回 `回复 名字：正文`，而引用消息在气泡上方
 * 已经有一张引用卡（名字 + 被引用原文），气泡里再带一遍前缀就是**同一信息显示两遍**。
 */
export function replyBodyText(item: any): string {
  const body = payloadOf(item);
  if (typeof body === 'string') return body.trim();
  if (!body || typeof body !== 'object') return '';
  const value = (body as any).text ?? (body as any).content ?? (body as any).body ?? (body as any).msgContent;
  return typeof value === 'string' ? value.trim() : '';
}
