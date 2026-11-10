/**
 * 房间列表轮询的**节流与等价复用**纯规则（无 React / 无网络依赖）。
 *
 * 用户 2026-09-30：「反复切换界面进出房间，不要出现卡顿 / 变灰 / 房间列表消失；提高性能效率」。
 *
 * 真机上「进出房间卡一下」的直接来源：列表页那轮 30s 轮询会打三个接口
 *（`getLiveList(size:100)` + 全量房间最新消息 + 上麦扫描），而它在
 * **每次依赖变化都立刻跑一次** —— 进房 / 退房 / 切 tab 都会让依赖变化，
 * 于是「反复进出房间」=「反复立刻打一整轮请求」，请求互相竞态，列表闪、页面卡。
 *
 * 规则钉在这里（纯函数），`scripts/room-churn-sim.mjs` 能模拟上千次
 * 「进房 / 退房 / 切 tab / 轮询到期」的时序，把请求次数压到可预期的量级。
 */

/** 同一轮全量刷新的最小间隔（毫秒）：进房/退房/切 tab 触发的重复 tick 在这里被吃掉 */
export const TICK_MIN_INTERVAL_MS = 8000;

/**
 * 本次 tick 是否该真的发请求。
 *
 * @param lastAt 上一次真正跑过的时刻（0 = 从没跑过）
 * @param now    当前时刻
 * @param minIntervalMs 最小间隔
 * @param force  true = 无视间隔（用户手动点刷新 / 首次装载）
 */
export function shouldRunTick(
  lastAt: number,
  now: number,
  minIntervalMs: number = TICK_MIN_INTERVAL_MS,
  force: boolean = false,
): boolean {
  if (force) return true;
  const last = Number(lastAt) || 0;
  if (!last) return true;
  const gap = Number(now) - last;
  // 时钟回拨（用户改表 / NTP 校正）不当成"刚跑过"，否则会永久卡住不刷新
  if (gap < 0) return true;
  return gap >= minIntervalMs;
}

/** 跑完一次后要记下的时间戳（与 shouldRunTick 配对使用） */
export function tickStamp(now: number): number {
  return Number(now) || 0;
}
