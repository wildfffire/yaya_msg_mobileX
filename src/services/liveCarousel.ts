/**
 * 电台直播「轮播照片」取数层（带短缓存 + 并发合并）。
 *
 * 为什么独立成 service：
 *   - 播放链路里有**两处**可能已经拿到 `getLiveOne` 的详情（解析兜底 / 公告 / 弹窗），
 *     但它们的返回结构只关心自己的字段；轮播照片要的是同一份 `content.carousels`。
 *     统一在这里按 liveId 缓存，避免「主播页 + 播放器」重复打接口（口袋风控敏感）。
 *   - 照片只是锦上添花：任何失败都返回空结果，**绝不抛错**、绝不拖慢开播
 *     （调用方是播放器的边挂 hook，解析完成后才请求）。
 */
import pocketApi from '../api/pocket48';
import { logInfo } from '../utils/runtimeLog';
import { parseLiveCarousel, DEFAULT_CAROUSEL_INTERVAL_MS, type LiveCarousel } from '../utils/liveCarousel';

/** 详情缓存时长（同一场直播短时间内多次进出播放器不重复请求） */
const TTL_MS = 90 * 1000;

const EMPTY: LiveCarousel = { photos: [], intervalMs: DEFAULT_CAROUSEL_INTERVAL_MS, radio: false };

const cache = new Map<string, { t: number; value: LiveCarousel }>();
const inflight = new Map<string, Promise<LiveCarousel>>();

/** 解析链路已经拿到的详情：写进缓存，播放器侧就不用再请求一次 */
export function rememberLiveCarousel(liveId: string, detail: any): LiveCarousel | null {
  const id = String(liveId || '');
  if (!id || !detail) return null;
  const value = parseLiveCarousel(detail);
  if (!value.radio && !value.photos.length) return null;
  cache.set(id, { t: Date.now(), value });
  return value;
}

/** 取某场直播的轮播信息（失败返回空结果，不抛错） */
export async function fetchLiveCarousel(liveId: string): Promise<LiveCarousel> {
  const id = String(liveId || '');
  if (!id) return EMPTY;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.value;

  const running = inflight.get(id);
  if (running) return running;

  const task = (async (): Promise<LiveCarousel> => {
    try {
      const res = await pocketApi.getLiveOne(id);
      const value = parseLiveCarousel(res);
      cache.set(id, { t: Date.now(), value });
      try {
        logInfo(
          `[live.carousel] liveId=${id} radio=${value.radio} photos=${value.photos.length} interval=${value.intervalMs}ms`,
          'live.carousel',
        );
      } catch {}
      return value;
    } catch (error: any) {
      // 电台判定可能来自 detail 以外的信息（列表 liveType），这里只返回空照片；
      // 缓存 20s，避免网络抖动时每次进播放器都重试。
      const value: LiveCarousel = {
        photos: [],
        intervalMs: DEFAULT_CAROUSEL_INTERVAL_MS,
        radio: false,
      };
      cache.set(id, { t: Date.now() - (TTL_MS - 20 * 1000), value });
      try {
        logInfo(`[live.carousel] liveId=${id} 拉取失败：${String(error?.message || error).slice(0, 120)}`, 'live.carousel');
      } catch {}
      return value;
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, task);
  return task;
}

/** 仅做本地判定：已知 liveId 的详情里是否为电台（缓存命中时可直接读） */
export function cachedLiveCarousel(liveId: string): LiveCarousel | null {
  const id = String(liveId || '');
  if (!id) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.value;
  return null;
}
