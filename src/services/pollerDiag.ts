/**
 * 轮询诊断日志的 60s 节流（messagePollers 与 ownerLagProbe 共用）。
 *
 * 两个模块以前各写一份完全相同的 `diagLastAt` + `logDiag`：
 * 5s 轮询 + 30s 探针会把同一类诊断刷屏，节流逻辑一旦漂移就会出现
 * 「一边刷屏、一边看不到」。现在只保留这一份。
 */
import { logInfo } from '../utils/runtimeLog';

const lastAt = new Map<string, number>();

/**
 * 同一个 key 60s 内只打一条。
 * @param key 诊断分组键（不同侧/不同主题各用各的）
 * @param msg 日志正文
 * @param tag 日志分类（默认 notify，与原实现一致）
 */
export function logDiag(key: string, msg: string, tag: string = 'notify'): void {
  const now = Date.now();
  if (now - (lastAt.get(key) || 0) < 60_000) return;
  lastAt.set(key, now);
  logInfo(msg, tag);
}
