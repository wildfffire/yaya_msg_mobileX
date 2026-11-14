/**
 * 通知失败重试计数（私信 / 房间共用一张表，键 = 类型|目标|批次）。
 *
 * 以前这张 Map 直接放在 messagePollers.ts 模块顶部，私信与房间两段
 * 各自手写 `get / set(tries+1) / delete`，重试上限与「成功才清」的口径
 * 分散在两处。抽出来后两条通道只表达「失败记一次 / 成功清掉」。
 */
/** 同一批通知连续失败多少次后放弃重试（对应原来的 MAX_NOTIFY_ATTEMPTS） */
export const MAX_NOTIFY_ATTEMPTS = 12;

const attempts = new Map<string, number>();

/** 该批次已经连续失败多少次（0 = 没失败过） */
export function notifyAttemptCount(key: string): number {
  return attempts.get(key) || 0;
}

/** 记一次失败，返回累计次数 */
export function markNotifyAttemptFailed(key: string): number {
  const next = notifyAttemptCount(key) + 1;
  attempts.set(key, next);
  return next;
}

/** 发送成功 / 被跳过时清掉计数（下一条消息重新从 0 开始） */
export function clearNotifyAttempt(key: string): void {
  attempts.delete(key);
}

/** 异常账号把表撑大时整体清理（与原来的 size>1000 兜底一致） */
export function clearAllNotifyAttempts(): void {
  attempts.clear();
}

export function notifyAttemptsSize(): number {
  return attempts.size;
}
