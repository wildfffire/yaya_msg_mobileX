/**
 * 团 B 站官方直播间的**开播状态**（「公演直播」卡点击时的判据）。
 *
 * 产品口径（用户 2026-10-04 明确）：
 *   点已开演的公演卡 → **有 B 站信号就走 B 站**（官方同播、线路更稳）；
 *   B 站没在播才回退**应用内信号**（口袋公演直播 getOpenLiveOne → rtmp）。
 *
 * 为什么单独成文件：卡片组件挂载预热 + 点击即时判定都要用，而 B 站 room_init
 * 有风控（高频请求会被拒），所以必须有 TTL 缓存与并发合并 —— 组件侧不要各自实现。
 */
import bilibiliApi from '../api/bilibili';

/** 状态缓存 TTL：公演开播/下播是低频事件，几分钟内复用完全够用（也避开 B 站风控） */
const TTL = 3 * 60 * 1000;
const cache = new Map<string, { at: number; live: boolean }>();
const inflight = new Map<string, Promise<boolean>>();

/**
 * 该 B 站直播间是否正在开播（`room_init.data.live_status === 1`）。
 * 接口失败时沿用上次结果（没有则按「未开播」）——失败要让位给应用内信号，不能卡住点击。
 */
export async function isGroupBiliLive(roomId: string): Promise<boolean> {
  const key = String(roomId || '').trim();
  if (!key) return false;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.live;
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = (async () => {
    try {
      const res: any = await bilibiliApi.getRoomInit(key);
      const live = Number(res?.data?.live_status) === 1;
      cache.set(key, { at: Date.now(), live });
      return live;
    } catch {
      return hit ? hit.live : false;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/** 预热：提前把各团结果放进缓存，点击时零等待（失败静默，点击时还有一次机会） */
export function prefetchGroupBiliLive(roomIds: string[]) {
  for (const id of roomIds) {
    if (id) void isGroupBiliLive(id);
  }
}
