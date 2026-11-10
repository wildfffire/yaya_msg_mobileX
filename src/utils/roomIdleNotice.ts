/**
 * 房间「N 天内偶像无消息」判定（纯函数，零依赖，便于单测钉住）。
 *
 * 用户要求（2026-10-01）：房间（大/小两侧都算）在窗口期内**房主（偶像）没有发言**时，
 * 消息区只显示「{days} 天内偶像无消息」提示 —— 不再把上一帧/另一侧的消息留在屏幕上。
 *
 * 背景（真机复现的问题）：小房间（yklzId）在偶像长期不发消息时接口返回 0 条，
 * 而页面此前会「保留上一帧消息」，于是小房间里显示的是**大房间的聊天记录**；
 * 叠加「只看偶像但 0 条 → 自动展开群聊」，小房间彻底变成大房间的群聊视图。
 *
 * 为什么单独抽这一层：
 *   判定同时还决定了「要不要清空消息列表 / 显示哪种空态」，
 *   边界（秒/毫秒时间戳、恰好卡在窗口边界、拿不到时间字段）写错不会崩，
 *   只会静默多显示或少显示一整屏消息 —— 只能靠可单测的纯函数兜住。
 */

/** 窗口天数：**唯一的数字来源**（文案里的 {days} 也用它，改这里一处即可） */
export const IDOL_IDLE_WINDOW_DAYS = 7;

/** 窗口毫秒数（判定用） */
export const IDOL_IDLE_WINDOW_MS = IDOL_IDLE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** 消息时间戳归一（秒 → 毫秒）：与 src/screens/room/timeRules.ts 的 normMs 同口径 */
export function normMsgTimeMs(value: unknown): number {
  const n = Number(value) || 0;
  if (n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/** 消息 → 该条消息时间(ms)：runtime 传 getMessageTime（与列表排序/显示同一口径），单测可传简版 */
export type MsgTimeGetter = (msg: any) => number;

/**
 * 是否「窗口期内无偶像发言」。
 *
 * 判定口径（必须与上方注释一致，改一处即改全部）：
 *   · 只要存在**任何**一条「偶像（房主）消息」的时间 > now - windowMs → 返回 false（有消息，正常显示）；
 *   · **时间字段取不到（归一为 0）的偶像消息 → 也返回 false**（无法断言它不在窗口内 → 不提示）；
 *   · 空列表、全是粉丝消息、偶像消息全在窗口之前 → 返回 true（无消息）。
 *
 * ⚠️ 「时间字段取不到」的口径在 2026-10-02 反转过一次（用户反馈误报）：
 *   旧口径按「无消息」处理（宁可提示）；但真机上的表现是**群里明明有偶像发言、
 *   却提示「7 天内偶像无消息」**（时间字段形态多变，取不到时判定就误报）。
 *   现在改为保守：只要存在一条时间不明的偶像消息就不报 idle —— 少提示好过乱提示
 *   （提示的正面场景「房间彻底没有偶像发言」不受影响：那种情况列表里根本没有偶像消息）。
 */
export function isIdolIdle(
  messages: readonly any[] | undefined | null,
  isIdol: (msg: any) => boolean,
  getMs: MsgTimeGetter,
  nowMs: number,
  windowMs: number = IDOL_IDLE_WINDOW_MS,
): boolean {
  const cutoff = Number(nowMs) - Number(windowMs);
  for (const msg of messages || []) {
    if (!msg || !isIdol(msg)) continue;
    const ms = Number(getMs(msg)) || 0;
    if (ms > cutoff) return false;
    // 时间不明：无法证明它在窗口之外 → 不报「无消息」（用户 2026-10-02 误报修复）
    if (ms <= 0) return false;
  }
  return true;
}

/** 窗口内最后一条偶像消息的时间(ms)：没有则 0（日志/诊断用，判定请用 isIdolIdle） */
export function lastIdolMsgMs(
  messages: readonly any[] | undefined | null,
  isIdol: (msg: any) => boolean,
  getMs: MsgTimeGetter,
): number {
  let latest = 0;
  for (const msg of messages || []) {
    if (!msg || !isIdol(msg)) continue;
    const ms = Number(getMs(msg)) || 0;
    if (ms > latest) latest = ms;
  }
  return latest;
}
