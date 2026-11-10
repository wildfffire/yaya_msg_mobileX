/**
 * 「上次看到这里」进房定位的目标解析（纯规则，可单测）。
 *
 * 背景（用户 2026-10-03：「房间里点进去定位到上次看到的地方这个功能不稳定」）：
 * 进房时会快照该房间的旧已读基线（roomEntryBaseline），聊天列表在「基线之后的第一条消息」
 * 上方渲染「上次看到这里」分隔行，定位就是滚到这一行。
 *
 * 稳定性的关键分支在于：**真正的分隔行是否还在已加载数据里**。
 *   · 有未读且未读不超过一页  → 分隔行就在已加载数据中，直接贴顶；
 *   · 未读超过一页（首屏 50 条）→ 分隔行还在更早的历史页里，当前数据中根本找不到。
 *     旧实现在这种情况下会退化成「回到最新」，把整屏未读一次性踩过去 ——
 *     用户感受到的就是「明明有未读却没定位 / 时灵时不灵」。
 *     现在的策略是先停在**已加载数据的最旧端**，并让调用方继续补历史页，
 *     直到真正的分隔行进入已加载数据、再精确贴顶。
 *
 *   · 无基线（从未读过）或全都看过 → 回到最新。
 */

/** 定位目标类型：分隔行贴顶 / 已加载最旧端 / 最新 */
export type LastSeenTargetMode = 'divider' | 'oldest' | 'latest';

export interface LastSeenTarget {
  mode: LastSeenTargetMode;
  /** 定位 index；-1 表示不走 scrollToIndex（回到最新，用 scrollToOffset 0） */
  index: number;
  /**
   * 跨页未读：真正的分隔行还在更早的历史页里（已加载数据整体晚于基线）。
   * 调用方据此决定是否继续自动补历史页。
   */
  dividerBeyondPage: boolean;
}

export interface ResolveLastSeenTargetInput {
  /** 进房快照的旧已读基线（服务器消息时间，0 = 从未读过该房间） */
  baseline: number;
  /** 已加载数据中「上次看到这里」分隔行的 index（-1 = 已加载数据里没有） */
  dividerIndex: number;
  /** 已加载消息条数 */
  loadedCount: number;
  /** 已加载数据中**最旧**一条消息的时间（0 = 未知） */
  oldestMs: number;
}

export function resolveLastSeenTarget(input: ResolveLastSeenTargetInput): LastSeenTarget {
  const baseline = Number(input.baseline) || 0;
  const loadedCount = Math.max(0, Number(input.loadedCount) || 0);
  const dividerIndex = Number(input.dividerIndex);
  const oldestMs = Number(input.oldestMs) || 0;

  // 从未读过该房间（无基线）→ 没有「上次看到这里」的语义，直接看最新
  if (baseline <= 0) return { mode: 'latest', index: -1, dividerBeyondPage: false };

  // 分隔行就在已加载数据里 → 精确贴顶
  if (dividerIndex >= 0 && dividerIndex < loadedCount) {
    return { mode: 'divider', index: dividerIndex, dividerBeyondPage: false };
  }

  /**
   * 已加载数据里找不到分隔行，但**最旧的一条也晚于基线** →
   * 说明整页都在基线之后，真正的分隔行还在更早的历史页里（跨页未读）。
   */
  if (loadedCount > 0 && oldestMs > baseline) {
    return { mode: 'oldest', index: loadedCount - 1, dividerBeyondPage: true };
  }

  // 其余情况（全都看过 / 时间信息不可用）→ 回到最新
  return { mode: 'latest', index: -1, dividerBeyondPage: false };
}
