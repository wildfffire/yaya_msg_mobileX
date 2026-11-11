/**
 * 房间「有 N 条新消息」浮标的计数规则（纯函数，可进纯 Node 单测）。
 *
 * 权威源：桌面端 yk1z/yaya_msg `followed-chat-feature.js` 的 followedPending* 系列：
 *   · 待看消息用 **id 集合**累计（`followedPendingMessageIds.size`），
 *     所以同一条消息被实时通道/轮询/重连重放各来一次，只算 1 条；
 *   · 用「历史见过 id」做增量判定，**不是**每次拿当前列表重算 ——
 *     重算是上一版数字不准的根因：消息列表只保留最近 N 条，
 *     新消息把旧消息挤出列表后，按时间重算的数字会**变小甚至归零**。
 *
 * 移动端口径：
 *   · `seenIds`：进过列表的所有消息 id（有上限，超出丢最早的一半）；
 *   · 只有「不在 seenIds 里」的 id 才是候选新消息；
 *   · 用户翻在历史里时，候选里「时间早于锚点」的忽略 —— 那是上拉加载的更早历史页；
 *   · 时间缺失（0）的候选**照常计入**：id 没见过就说明是新出现的，
 *     不能因为服务端没给时间就漏计（这也是数字偏小的另一条原因）；
 *   · **自己发的消息**只记 seen、不计入数字（桌面端自己发的是直接上屏，不进 pending 批）；
 *   · **非聊天类消息**（礼物 / 进房特效 / 系统公告）只记 seen、不计入数字 ——
 *     与房间列表角标的 `isChatMessageType` 同口径，否则有人刷礼物时数字会虚高。
 */
import { isCountableMessageType } from '../../utils/roomMessageCursor';

export interface NewMsgItem {
  id: string;
  /** 消息时间（毫秒，服务器时间域）；未知传 0 */
  time: number;
  /** 自己发的消息（真实判定在页面里做：IMessage.user._id === 'SELF'） */
  self?: boolean;
  /** 聊天类消息（礼物/进房/公告传 false）。缺省按「算」处理，避免漏计 */
  countable?: boolean;
}

export interface PickedNewMessages {
  /** 新出现的全部 id（调用方都要记进 seen，防止之后重复计数） */
  seen: string[];
  /** 其中应当计入浮标数字的 id（排除自己发的 / 非聊天类） */
  counted: string[];
}

/** 记住多少条历史 id（超出丢最早的一半）：够覆盖一次会话的所有上拉历史 */
export const SEEN_ID_MAX = 3000;

/**
 * 从滚动事件里取 y 偏移。
 *
 * ⚠️ 两种形态必须都认（用户 2026-11-09 反馈「数量还是不对」的真因）：
 *   · Reanimated 的 `useAnimatedScrollHandler` 事件是**扁平**的（`event.contentOffset.y`，
 *     库把它 `runOnJS` 转给我们时也一样，`nativeEvent` 根本不存在）；
 *   · 普通 RN 合成事件才是 `event.nativeEvent.contentOffset.y`。
 * 只看 `nativeEvent` 时 y 恒为 0 → 永远判成「贴着最新消息」→ 全部消息都被当成已看过，
 * 浮标永远不涨（或者被误清），数字自然怎么改都不对。
 */
export function scrollOffsetY(event: any): number {
  const native = event?.nativeEvent || event;
  const y = Number(native?.contentOffset?.y);
  return Number.isFinite(y) ? y : 0;
}

/**
 * 聊天类消息类型（文本/回复/表情/图片/语音/视频/直播弹幕/翻牌）。
 *
 * ⚠️ 实现在 `utils/roomMessageCursor.isCountableMessageType`：房间列表角标、5s 通知轮询、
 * 30s 精确计数与这里一共四条链路共用同一份正则 —— 以前各写一份，
 * 改类型口径时必然漏掉其中一处（表现就是「浮标算、角标不算」）。
 */
export const isCountableRoomMessage = isCountableMessageType;

/** 挑出「没见过、且不早于锚点」的新消息：见 / 计入 两份结果（顺序保持列表顺序） */
export function pickNewMessages(items: NewMsgItem[], seenIds: Iterable<string>, anchorTime: number): PickedNewMessages {
  const seen = seenIds instanceof Set ? seenIds : new Set(Array.from(seenIds || []));
  const anchor = Number(anchorTime) || 0;
  const out: PickedNewMessages = { seen: [], counted: [] };
  const local = new Set<string>();
  for (const item of items || []) {
    const id = String(item?.id || '');
    if (!id || seen.has(id) || local.has(id)) continue;
    const t = Number(item?.time) || 0;
    // 时间未知 → 计入；有明确时间且早于锚点 → 是补历史的旧消息，忽略（也不记 seen，
    // 免得它被当成「已看过」而把同一条真新消息误判成旧消息）
    if (anchor > 0 && t > 0 && t < anchor) continue;
    local.add(id);
    out.seen.push(id);
    if (!item?.self && item?.countable !== false) out.counted.push(id);
  }
  return out;
}

/** 兼容旧调用：只要「新出现的 id」 */
export function pickNewIds(items: NewMsgItem[], seenIds: Iterable<string>, anchorTime: number): string[] {
  return pickNewMessages(items, seenIds, anchorTime).seen;
}

/** 维护 seen 顺序表：去重追加 + 超限丢最早一半 */
export function pushSeenIds(order: string[], ids: string[], max = SEEN_ID_MAX): string[] {
  const next = Array.isArray(order) ? order.slice() : [];
  const set = new Set(next);
  for (const id of ids || []) {
    const key = String(id || '');
    if (!key || set.has(key)) continue;
    set.add(key);
    next.push(key);
  }
  if (next.length > max) next.splice(0, next.length - max);
  return next;
}
