/**
 * 房间元数据（房间名 + 背景原图地址）的**跨启动**缓存。
 *
 * 为什么需要（进房慢的确定性来源之一）：
 *   `getRoomMeta` 是一次网络往返（`room/info`，小房间还要再串一次塞纳河 `server/detail`
 *   甚至回退大房间 `room/info`），而它此前**串行在首屏消息之后**才发起 ——
 *   冷启动后第一次进某个房间，要连等「消息 RTT + 元数据 RTT ×N」才看到房间背景，
 *   期间背景区是空的（用户体感就是「进房慢、背景半天不出来」）。
 *
 * 现在：
 *   ① 这份表把上次拿到的 name/bg 落盘，冷启动进同一个房间时**同步命中内存镜像**
 *      → 房间名 + 背景图（配合 roomBgCache 的磁盘缓存 → 本地 file://）第一帧就有；
 *   ② 网络结果回来照旧覆盖并更新本表（偶像换了背景能跟上）。
 *
 * 只缓存这两个展示字段：不参与任何业务判定（消息/未读/播放全都不读它）。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const META_KEY = 'yaya_room_meta_cache_v1';
/** 上限：每个成员大 + 小两个 channelId，200 条约覆盖 100 个房间（超出按写入顺序淘汰最旧） */
const MAX_ENTRIES = 200;
/** 落盘节流：连续进房（切换大/小房间、快速点几个房间）只写一次 */
const PERSIST_DEBOUNCE_MS = 1200;

export type RoomMetaEntry = { name: string; bg: string };

type MetaMap = Record<string, RoomMetaEntry & { at: number }>;

let mapCache: MetaMap | null = null;
let mapPromise: Promise<MetaMap> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function loadMap(): Promise<MetaMap> {
  if (mapCache) return mapCache;
  if (mapPromise) return mapPromise;
  mapPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(META_KEY);
      mapCache = raw ? (JSON.parse(raw) as MetaMap) : {};
    } catch {
      mapCache = {};
    }
    return mapCache!;
  })();
  return mapPromise;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = mapCache;
    if (!snapshot) return;
    AsyncStorage.setItem(META_KEY, JSON.stringify(snapshot)).catch(() => {
      /* 落盘失败不影响本次显示，下次进房会再写一次 */
    });
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * App 启动时预载（App.tsx 调用）：让**冷启动后第一次进房**就能同步命中。
 * 不 await 也不阻塞渲染 —— 它只是把 AsyncStorage 读进内存镜像。
 */
export async function initRoomMetaCache(): Promise<void> {
  await loadMap();
}

/**
 * 同步读：命中返回 { name, bg }（bg 是**服务端原图地址**，显示前要过 roomBgCache.getBgDisplayUri），
 * 未命中/空值返回 null（空值不当作命中 —— 否则一次失败会把房间永久钉成「无背景无名字」）。
 */
export function getRoomMetaCached(channelId: string): RoomMetaEntry | null {
  const cid = String(channelId || '');
  if (!cid || !mapCache) return null;
  const hit = mapCache[cid];
  if (!hit) return null;
  if (!hit.name && !hit.bg) return null;
  return { name: String(hit.name || ''), bg: String(hit.bg || '') };
}

/** 网络回来（或已有值）后写入：更新内存镜像并节流落盘 */
export function putRoomMetaCache(channelId: string, meta: RoomMetaEntry): void {
  const cid = String(channelId || '');
  if (!cid) return;
  const name = String(meta.name || '');
  const bg = String(meta.bg || '');
  if (!name && !bg) return; // 空结果不覆盖已有缓存（服务端偶发抽风不该把背景抹掉）
  const map: MetaMap = mapCache || (mapCache = {});
  map[cid] = { name, bg, at: Date.now() };
  // 淘汰：按 at 最旧的整体裁剪（与 roomBgCache 的 trim 语义一致，超限才动）
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (map[a]?.at || 0) - (map[b]?.at || 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => { delete map[k]; });
  }
  schedulePersist();
}

/** 「关于 → 清除缓存」时调用：清掉内存镜像与落盘表 */
export function clearRoomMetaCache(): void {
  mapCache = {};
  mapPromise = null;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  AsyncStorage.removeItem(META_KEY).catch(() => undefined);
}
