/**
 * 「房主流（homeowner）独立补计」纯规则（用户 2026-11-13 真机日志：覃柯蒙）。
 *
 * 背景（adb logcat 11-13 09:34~09:44，room=149356897）：
 *   · 房主 `yuki-` 在 11-13 01:42~02:02 连发约 50 条，`/list/homeowner` 一页全有；
 *   · 已读基线 `lastReadAt` 还停在 11-12 20:02 → 这批消息确实未读；
 *   · 但 `/list/all` 的最新页被 09 点的粉丝消息刷满（样例全是粉丝昵称），
 *     房主那条连同这一整批都被挤出窗口，`本页偶像=0 服务端命中=0 计=0`；
 *   · 回溯边界是 `cursor.time`（上次轮询位置 09:25），翻不到 02:02；
 *     补偿扫描又要求 `t > cursor.time`，同样挡死 → 角标整场 0。
 *
 * 结论：homeowner 页此前只被当成「all 页里的 id 白名单」，从不是独立计数源。
 * 只要房主消息被粉丝刷出 all 页窗口，就永远数不到（热闹房间 100% 复现）。
 *
 * 这里把「从 homeowner 页里挑出该补计的消息」抽成零依赖纯函数：
 *   · 只认聊天类（礼物 / 进房特效 / 系统公告不计，与三条通道同口径）；
 *   · 严格晚于房间级已读基线 `readFloor`（进房 / 一键已读后的旧消息不再提示）；
 *   · 严格晚于本侧持久化游标 `countedAt`（进程重启后不重计）；
 *   · 与 all 页见过的 id 取差集（all 页路径已经处理过的消息不重复计）。
 *
 * 时间游标按侧持久化在 `services/roomOwnerCount.ts`，与 `roomCountLedger`
 *（会话内 id 总账）互补：总账防同轮三通道重复，时间游标防重启重放。
 */
import { isCountableChatMessage, messageId, messageTime } from './roomMessageCursor';
import { messageIdAliases } from './notifyOwnerRules';

export interface UncountedOwnerResult {
  /** 需要交给 `claimCountId` 认领的消息 id（去重后） */
  ids: string[];
  /** 本页最大消息时间（游标推进用；0 = 没有可用时间） */
  newest: number;
}

/**
 * 从 homeowner 页里挑出「应该补进角标」的消息。
 *
 * @param page        `/team/message/list/homeowner` 的一页（服务端已按房主过滤）
 * @param readFloor   房间级已读基线（lastReadAt，服务器消息时间 ms）
 * @param countedAt   本侧 homeowner 补计游标（持久化，0 = 尚未补计过）
 * @param excludeIds  all 页见过的全部消息 id 别名（避免与既有通道重复计）
 */
export function pickUncountedOwnerMessages(
  page: any[] | null | undefined,
  opts: { readFloor: number; countedAt: number; excludeIds?: Set<string> | null },
): UncountedOwnerResult {
  const read = Number(opts?.readFloor) || 0;
  // 没有已读基线 = 首次基线：既不补计，也不推进游标（否则用户第一次进房后
  // 那批本该提示的房主消息会被 countedAt 提前挡掉）。
  if (!(read > 0)) return { ids: [], newest: 0 };
  const counted = Number(opts?.countedAt) || 0;
  const exclude = opts?.excludeIds;
  const msgs = Array.isArray(page) ? page.filter(Boolean) : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  let newest = 0;
  for (const m of msgs) {
    const t = messageTime(m);
    if (t > newest) newest = t;
    // 时间缺失（0）不补：整页没有 msgTime 时会把老房主消息一次刷成未读
    if (!(t > 0) || t <= read || t <= counted) continue;
    if (!isCountableChatMessage(m)) continue;
    const aliases = messageIdAliases(m);
    if (exclude && exclude.size && aliases.some((id) => exclude.has(id))) continue;
    const id = messageId(m);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids, newest };
}

/** 补计游标只前进不后退（与 lastReadAt 同款单调约束） */
export function nextOwnerCountedAt(current: number, newest: number): number {
  const a = Number(current) || 0;
  const b = Number(newest) || 0;
  return b > a ? b : a;
}
