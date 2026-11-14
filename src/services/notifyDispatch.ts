/**
 * 一次通知发送 + 失败重试计数（私信 / 房间共用）。
 *
 * 两处通道原来各写一遍：
 *   get tries → 超限放弃 → notifyMessage → catch 记 failed → 失败 +1 / 成功清计数
 * 抽出来后调用方只提供「批次键 + 发送动作 + 各自的诊断日志」，
 * 「失败才计数、成功才清理」的口径不会再分叉。
 */
import type { NotifyOutcome } from './notificationCenter';
import {
  MAX_NOTIFY_ATTEMPTS,
  clearNotifyAttempt,
  markNotifyAttemptFailed,
  notifyAttemptCount,
} from './notifyAttempts';

export interface NotifyDispatchInput {
  /** 批次键（pm|target|batch / room|key|batch） */
  attemptKey: string;
  /** 真正调用 notifyMessage 的动作（延迟到确认没超限后再执行） */
  send: () => Promise<NotifyOutcome>;
  /** 连续失败达到上限：调用方打自己的「放弃重试」诊断 */
  onGiveUp?: (tries: number) => void;
  /** 发送抛异常：调用方打自己的「通知异常」日志 */
  onError?: (error: unknown) => void;
}

export interface NotifyDispatchResult {
  outcome: NotifyOutcome;
  /** 本轮成功发送条数（0 或 1） */
  sent: number;
}

export async function dispatchNotify(input: NotifyDispatchInput): Promise<NotifyDispatchResult> {
  const tries = notifyAttemptCount(input.attemptKey);
  if (tries >= MAX_NOTIFY_ATTEMPTS) {
    input.onGiveUp?.(tries);
    return { outcome: 'duplicate', sent: 0 };
  }
  let outcome: NotifyOutcome = 'skipped';
  try {
    outcome = await input.send();
  } catch (error) {
    outcome = 'failed';
    input.onError?.(error);
  }
  if (outcome === 'failed') {
    markNotifyAttemptFailed(input.attemptKey);
    return { outcome, sent: 0 };
  }
  clearNotifyAttempt(input.attemptKey);
  return { outcome, sent: outcome === 'sent' ? 1 : 0 };
}
