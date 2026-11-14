/**
 * 「观看历史 / 稍后再看」的**去重与合并纯规则**。
 *
 * 为什么单独成文件（用户 2026-09-30：「同一个直播多次记录」「信息不全，彻底解决」）：
 * 同一直播会按入口产生不同标识 —— 房间/回放入口带 `ref`（`replay:<liveId>`）、
 * 直播页入口只有 `liveId`（`live:<liveId>`）、公演入口是 `openlive:<liveId>` ——
 * 口径不统一就会**同一直播记/收藏成多条**，而且各条字段互补（一条有封面、一条有成员名），
 * 卡片看起来就是"信息不全"。
 *
 * 这里把口径钉在一处：liveId 优先（replay/openlive 的 ref.id 就是 liveId），
 * 标题只在拿不到任何 id 时兜底；另提供迁移用的 merge*（把已有的碎片合并成一条）。
 * 纯函数、无 React/无 store 依赖 → `scripts/watch-dedupe.test.mjs` 直接钉住。
 */

/** 历史条目上限（与 services/watchHistory 的 MAX_ITEMS 保持一致） */
const HISTORY_MAX = 500;
/** 稍后再看条目上限（与 services/watchLater 的 MAX_ITEMS 保持一致） */
const LATER_MAX = 200;

export interface WatchKeyInput {
  ref?: { kind?: string; id?: string } | null;
  liveId?: string;
  title?: string;
}

/** 标题归一：去空白、折叠连续空格、统一小写（同一直播不同入口的标题常有细微差异） */
export function normTitle(raw: string): string {
  return String(raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 观看历史的去重键（**统一口径**）：
 *   1) liveId 优先（最稳的场次标识）；
 *   2) `replay` / `openlive` 的 `ref.id` 就是 liveId → 也归一到 `live:<id>`；
 *   3) 其它 ref（官方视频库 `video:<videoId>`）保持独立；
 *   4) 都没有 → 归一化标题兜底。
 */
export function historyKey(input: WatchKeyInput): string {
  const liveId = String(input.liveId || '').trim();
  const refKind = String(input.ref?.kind || '');
  const refId = String(input.ref?.id || '').trim();
  if (liveId) return `live:${liveId}`;
  if (refId && (refKind === 'replay' || refKind === 'openlive')) return `live:${refId}`;
  if (refId) return `${refKind}:${refId}`;
  /**
   * ⚠️ 旧数据自带的 key 也要归一（迁移时必须走这一步）：
   * 升级前的记录 key 是 `replay:<liveId>` / `openlive:<liveId>` / `live:<liveId>`，
   * 且**字段里可能没有 ref / liveId** —— 只看字段就会退化成按标题算，
   * 与"带 liveId 的新记录"合并不到一起（这正是"同一直播两条"在迁移后仍然存在的原因）。
   */
  const oldKey = String((input as any).key || '').trim();
  if (oldKey && !oldKey.startsWith('t:')) {
    const sep = oldKey.indexOf(':');
    const kind = sep > 0 ? oldKey.slice(0, sep).toLowerCase() : '';
    const id = sep > 0 ? oldKey.slice(sep + 1).trim() : '';
    if (id && (kind === 'replay' || kind === 'openlive' || kind === 'live')) return `live:${id}`;
    if (id && /^[a-z]+$/.test(kind)) return oldKey; // video:V9 等其它来源保持独立
  }
  return `t:${normTitle(input.title || '')}`;
}

/**
 * 该播放源要不要写观看历史（用户 2026-11-13 定版）。
 *
 * **只有直播 / 直播回放 / 公演进历史**：
 *   · 直播：`kind === 'live'`（口袋直播、公演直播、B 站直播）
 *   · 直播回放：`ref.kind === 'replay'`
 *   · 公演回放：`ref.kind === 'openlive'`
 *
 * 明确排除：房间视频消息（`kind === 'direct'`）、房间语音/电台节目（`audio`）、
 * 官方视频库（`video`）、以及任何没有来源的临时播放 —— 这些内容没有「场次」概念，
 * 记进历史既回放不了，也会把历史刷成「视频 / 表情 / 消息媒体」。
 */
export function shouldRecordHistory(source: {
  kind?: string;
  ref?: { kind?: string } | null;
}): boolean {
  const refKind = String(source?.ref?.kind || '');
  if (refKind === 'replay' || refKind === 'openlive') return true;
  return String(source?.kind || '') === 'live';
}

/**
 * 历史条目是否**至少可回放一次**（迁移清理用）。
 *
 * 旧版本会把房间视频 / 表情 / 私信媒体记成 `t:标题`（无 ref、无 liveId），
 * 点开必然解析失败。这里只保留带来源的条目：
 *   · `ref.id` 存在（replay / openlive / video 都能按 id 重新解析）
 *   · 或 `liveId` 存在（直播）
 * 用户 2026-11-13：「房间里发的视频和表情包不要进入历史记录」——
 * 新记录已由 shouldRecordHistory 拦住，这里负责把旧垃圾清掉。
 */
export function isReplayableHistoryItem(item: { ref?: { kind?: string; id?: string } | null; liveId?: string; key?: string }): boolean {
  const refId = String(item?.ref?.id || '').trim();
  const refKind = String(item?.ref?.kind || '').trim();
  if (refId && (refKind === 'replay' || refKind === 'openlive' || refKind === 'video')) return true;
  if (String(item?.liveId || '').trim()) return true;
  // 旧数据的 key 里也可能带来源（replay:x / openlive:x / live:x / video:x）
  const key = String(item?.key || '').trim();
  return /^(replay|openlive|live|video):[^:]+$/i.test(key);
}

/** 历史条目的最小形状（避免这里 import store：保持纯模块） */
export interface WatchHistoryLike {
  key?: string;
  [k: string]: any;
}

/**
 * 合并历史条目（**数据迁移用**）：按新口径 key 归并同一直播的多条记录。
 * 字段取并集（哪条有就用哪条），at 取更晚，count 取较大值
 *（两条其实是同一次观看的分裂记录，相加会把「看过 N 次」算虚高）。
 */
export function mergeHistoryItems<T extends WatchHistoryLike>(items: T[], maxItems = HISTORY_MAX): T[] {
  const map = new Map<string, any>();
  for (const raw of items || []) {
    if (!raw || typeof raw !== 'object') continue;
    const key = historyKey(raw as any);
    if (!key || key === 't:') continue;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ...raw, key });
      continue;
    }
    map.set(key, {
      ...cur,
      key,
      kind: cur.kind || raw.kind,
      title: cur.title || raw.title,
      cover: cur.cover || raw.cover,
      owner: cur.owner || raw.owner,
      team: cur.team || raw.team,
      ownerId: cur.ownerId || raw.ownerId,
      liveId: cur.liveId || raw.liveId,
      ref: cur.ref || raw.ref,
      duration: cur.duration ?? raw.duration,
      liveType: cur.liveType ?? raw.liveType,
      audio: cur.audio ?? raw.audio,
      at: Math.max(Number(cur.at) || 0, Number(raw.at) || 0),
      count: Math.max(Number(cur.count) || 1, Number(raw.count) || 1),
    });
  }
  return Array.from(map.values())
    .sort((a: any, b: any) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, maxItems) as T[];
}

export type WatchLaterKindLike = 'video' | 'openlive' | 'replay';

/** 稍后再看的分来源复合键（空 id → ''，调用方据此跳过） */
export function watchLaterKey(kind: WatchLaterKindLike | string, id: string | number | undefined | null): string {
  const raw = String(id ?? '');
  return raw ? `${kind}:${raw}` : '';
}

/**
 * 「同一场内容」的合并桶：`openlive` 与 `replay` 的 id 都是 liveId → 视为同一场直播。
 * 不合并的话：公演入口收藏是 `openlive:<id>`、房间/录播入口是 `replay:<id>`，
 * 同一场直播会在「稍后再看」里出现两条，字段还互补。
 */
export function watchLaterBucket(kind: WatchLaterKindLike | string, id: string | number | undefined | null): string {
  const raw = String(id ?? '');
  if (!raw) return '';
  return (kind === 'openlive' || kind === 'replay') ? `live:${raw}` : `${kind}:${raw}`;
}

/** 稍后再看条目的最小形状 */
export interface WatchLaterLike {
  key?: string;
  kind?: string;
  id?: string;
  [k: string]: any;
}

/**
 * 合并收藏条目（**数据迁移用**）：按「同一场内容」桶归并，字段取并集（较新那条优先），
 * at 取更晚；kind 保留较新那条 —— 更可能来自用户最近用过、能解析成功的入口。
 */
export function mergeWatchLaterItems<T extends WatchLaterLike>(items: T[], maxItems = LATER_MAX): T[] {
  const map = new Map<string, any>();
  for (const raw of items || []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    if (!id) continue;
    const kind = String(raw.kind || 'video');
    const bucket = watchLaterBucket(kind, id);
    const cur = map.get(bucket);
    if (!cur) {
      map.set(bucket, { ...raw, key: watchLaterKey(kind, id) });
      continue;
    }
    const newer = (Number(raw.at) || 0) >= (Number(cur.at) || 0) ? raw : cur;
    const mergedKind = String(newer.kind || cur.kind || kind);
    map.set(bucket, {
      ...cur,
      ...newer,
      key: watchLaterKey(mergedKind, id),
      kind: mergedKind,
      title: newer.title || cur.title,
      cover: newer.cover || cur.cover,
      owner: newer.owner || cur.owner,
      team: newer.team || cur.team,
      ownerId: newer.ownerId || cur.ownerId,
      audio: newer.audio ?? cur.audio,
      duration: newer.duration ?? cur.duration,
      liveType: newer.liveType ?? cur.liveType,
      at: Math.max(Number(cur.at) || 0, Number(raw.at) || 0),
    });
  }
  return Array.from(map.values())
    .sort((a: any, b: any) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, maxItems) as T[];
}
