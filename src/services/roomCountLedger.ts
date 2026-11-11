/**
 * 未读角标的「同一条消息只计一次」总账（跨通道共享）。
 *
 * 背景（2026-11-10 真机日志）：房间消息有三条会重复的通道 ——
 *   ① 云信圈组实时推送（uuid = msgIdClient）；
 *   ② 通知轮询拉到的房间详情一页（msgIdClient / msgIdServer）；
 *   ③ 30s 列表指纹轮询的精确计数（同一页详情）。
 * 旧实现用「实时已计条数 realtimeCountedRef」在轮询里做整数相减：两条通道的
 * 房主判定 / 消息窗口不同源，一减就是 0，而指纹与 seenAt 基线却已推进 →
 * 这批消息**永久不再计数**（用户反馈「部分新消息不提示 / 数字不涨」）。
 *
 * ★ 2026-11-10 第二轮的教训（用户「第一次计数正确，之后有的新消息没有红点」）：
 *   总账只能记录「**确实计进角标**」或「**明确已读**」的消息。
 *   曾把「首次基线」「正在看的房间」也塞进同一个 `claimCountId`，结果
 *   **不计数的决定抢占了总账**：进房会清 sideSeenAt 基线，退房后第一次指纹变化
 *   就把详情整页 20 条 id 全占掉且返回 0，三条通道再也补不回来 → 永久漏红点。
 *   现在拆成两个集合：
 *     · counted  = 已计入角标，别的通道不许重复计；
 *     · consumed = 明确已读（当前正在看的房间），别的通道不许补计；
 *     · 首次基线 **两者都不写**，由 5s 轮询的补偿扫描按 id 补回真正的新消息。
 *
 * id 口径与 utils/roomMessageCursor.messageId 完全一致（实时 uuid 就是 msgIdClient）。
 * 会话内有效（进程被杀后本地 counts 已落盘，重启不需要重放旧消息）。
 */
const CLAIM_MAX = 4000;
const counted = new Set<string>();
const consumed = new Set<string>();
const order: string[] = [];

function trim() {
  while (order.length > CLAIM_MAX) {
    const oldest = order.shift();
    if (!oldest) return;
    counted.delete(oldest);
    consumed.delete(oldest);
  }
}

/** 返回 true = 本会话第一次见到这条消息且未被标成已读（可以计数） */
export function claimCountId(id: string): boolean {
  const key = String(id || '').trim();
  if (!key || consumed.has(key) || counted.has(key)) return false;
  counted.add(key);
  order.push(key);
  trim();
  return true;
}

/** 明确「这条消息用户已经看过」：不计数，且阻止其它通道事后补计 */
export function markCountConsumed(id: string): void {
  const key = String(id || '').trim();
  if (!key || counted.has(key) || consumed.has(key)) return;
  consumed.add(key);
  order.push(key);
  trim();
}

/** 只读查询：已计过 / 明确已读 → true（补偿扫描用它跳过） */
export function isCountClaimed(id: string): boolean {
  const key = String(id || '').trim();
  if (!key) return false;
  return counted.has(key) || consumed.has(key);
}
