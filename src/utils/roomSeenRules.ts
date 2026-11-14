/**
 * 「上次看到的位置」= 分侧的消息 id 边界（用户 2026-11-13「一次性改好」）。
 *
 * 旧口径是房间级时间戳 `lastReadAt`，两个语义问题反复制造漏计 / 重复提示：
 *   · 全项目的判新去重都按消息 id（roomCountLedger.claimCountId /
 *     findFreshMessages 的 cursor.keys），只有基线用时间 → 两套语义打架；
 *   · 时间取自 `last/message/get` 预览，项目注释自己写了「官方没有字段文档，
 *     时间字段名一旦对不上角标就永远不亮」，真机日志里 `markRead … activity=0` 反复出现。
 *
 * 新口径：每个 `(memberId, side)` 记「最后看到的是哪一条消息」`{id, time}`。
 *   · 判新优先按 id：全量房主流里找到那条 id，**它之前的（更新的）**都算未读；
 *   · id 找不到（消息被清 / 超出翻页窗口 / 换设备）才退回时间比较；
 *   · 时间只用来决定「翻页翻到哪停」和兜底，不再当判据；
 *   · 大小房间各自一份，互不污染。
 *
 * 零 React / 零网络依赖，可直接编译进 `npm run test:core` 单测。
 */
import { isCountableChatMessage, messageId, messageTime } from './roomMessageCursor';

export interface SeenMark {
  /** 最后看到的那条消息 id（'' = 只有时间基线，如一键已读） */
  id: string;
  /** 该消息的服务器时间（ms；id 找不到时兜底用） */
  time: number;
}

/** 只前进：时间更大的才覆盖；同时间也更新 id（更精确）。基线倒退不会把读过的消息刷成未读 */
export function mergeSeen(prev: SeenMark | null, next: SeenMark | null): SeenMark | null {
  if (!next) return prev;
  if (!prev) return next;
  const a = Number(prev.time) || 0;
  const b = Number(next.time) || 0;
  return b >= a ? next : prev;
}

export function seenMarkOf(msg: any): SeenMark | null {
  const id = String(messageId(msg) || '');
  const time = Number(messageTime(msg)) || 0;
  if (!id && !time) return null;
  return { id, time };
}

/**
 * 翻页是否继续：已经在累计页里找到「上次看到的那条 id」→ 停；
 * 否则按时间边界停（页内最早时间 ≤ 基线）。没有基线只拉一页建基线。
 */
export function shouldContinueToSeen(input: {
  pageLength: number;
  limit: number;
  seen: SeenMark | null;
  /** 已翻到的全部消息 id（累计，不是单页） */
  pageIds: Set<string>;
  oldestTime: number;
}): boolean {
  if ((Number(input.pageLength) || 0) < (Number(input.limit) || 0)) return false;
  const seen = input.seen;
  if (!seen) return false;
  if (seen.id && input.pageIds.has(seen.id)) return false;
  const floor = Number(seen.time) || 0;
  const oldest = Number(input.oldestTime) || 0;
  if (floor > 0 && oldest > 0 && oldest <= floor) return false;
  return true;
}

/** 全量页里是否已经翻到「上次看到的那条 id」 */
export function reachedSeenId(pageIds: Set<string>, seen: SeenMark | null): boolean {
  return !!(seen?.id && pageIds.has(seen.id));
}

/**
 * 从「翻到上次看到的位置为止」的全量房主流里挑出该计数的消息 id。
 *
 * @param list 新 → 旧排列的全量页
 * @param seen 该侧「上次看到的位置」
 *
 * 找到 seen.id → 只取它之前（更新）的那段，精确处理同秒连发 / 缺时间字段 / 乱序；
 * 找不到（或一键已读只有时间）→ 退回 `t > seen.time`，时间缺失的消息放行交给 id 总账去重。
 */
export function pickUnreadSinceSeen(list: any[] | null | undefined, seen: SeenMark | null): string[] {
  // 双保险：没有 id 也没有有效时间的「空基线」= 还没建立，绝不能把整页历史刷成未读
  if (!seen || (!seen.id && !(Number(seen.time) > 0))) return [];
  const msgs = (Array.isArray(list) ? list : []).filter(Boolean);
  let stop = -1;
  if (seen.id) {
    for (let i = 0; i < msgs.length; i += 1) {
      if (String(messageId(msgs[i]) || '') === seen.id) { stop = i; break; }
    }
  }
  const floor = Number(seen.time) || 0;
  const scope = stop >= 0
    ? msgs.slice(0, stop)
    : msgs.filter((m) => {
      const t = messageTime(m);
      // 时间明确且早于/等于基线 → 已读；时间缺失放行（交给 id 总账去重）
      return !(floor > 0 && t > 0 && t <= floor);
    });
  const ids: string[] = [];
  const out = new Set<string>();
  for (const m of scope) {
    if (!isCountableChatMessage(m)) continue;
    const id = String(messageId(m) || '');
    if (!id || out.has(id)) continue;
    out.add(id);
    ids.push(id);
  }
  return ids;
}
