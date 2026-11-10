/**
 * 「观看历史 / 稍后再看」条目补全的**纯规则层**（无 React、无网络、无 store）。
 *
 * 为什么把规划逻辑从 hook 里抽出来（用户 2026-09-30 要求「模拟真实情况多次测试再交付」）：
 * 补全的难点全在**决策**（这条该本地补、该查批量表、还是该打网络请求、试过几次该不该放弃），
 * 而决策错了的表现是「信息一直不全 / 队伍永远空着」，在真机上极难复现与定位。
 * 抽成纯函数后，`scripts/watch-enrich.sim.mjs` 能拿真实形态的假数据（昵称带不带团体前缀、
 * 接口空结果、网络失败、成员库延迟就绪）跑上千次，把命中率钉死。
 *
 * `useEnrichMeta` 只负责 IO（拉表、发请求、写 store），决策一律问这里。
 */
import { getPath, normalizeUrl, pickText } from './pathPick';
import {
  findMemberByHint,
  matchMemberByTitle,
  pickMemberNickname,
  pickMemberUserId,
  resolveTeam,
  type MemberLookup,
} from './memberMatch';

/** 条目（历史 / 稍后再看条目都能直接传进来） */
export interface WatchMetaLike {
  key: string;
  owner?: string;
  team?: string;
  /** 成员数字 id：本地反查队伍的首选依据 */
  ownerId?: string;
  title?: string;
  /** 时长（秒） */
  duration?: number;
  liveId?: string;
  videoId?: string;
}

/** 页面侧的原名（`EnrichTarget`），保持既有 import 可用 */
export type EnrichTarget = WatchMetaLike;

/** 可写回的展示字段 */
export interface WatchMetaPatch {
  owner?: string;
  team?: string;
  ownerId?: string;
  title?: string;
  cover?: string;
  duration?: number;
  liveType?: number;
}

/** 页面侧的原名（`EnrichPatch`），保持既有 import 可用 */
export type EnrichPatch = WatchMetaPatch;

/** 官方录播列表字段路径（= 直播页录播 tab 的数据源） */
const VOD_TITLE = ['title', 'liveTitle', 'liveRoomTitle', 'roomName', 'subject'];
const VOD_COVER = ['liveCover', 'coverPath', 'cover', 'coverUrl', 'picPath', 'poster', 'thumb'];
const VOD_START = ['startTime', 'stime', 'start_time', 'ctime', 'liveStartTime', 'beginTime'];
const VOD_END = ['endTime', 'etime', 'end_time', 'liveEndTime'];

/** 官方视频列表字段路径 */
const VIDEO_TITLE = ['title', 'name', 'videoTitle'];
const VIDEO_COVER = ['cover', 'coverUrl', 'videoCover', 'picPath', 'thumb'];
const VIDEO_DURATION = ['duration', 'videoDuration', 'videoTime', 'videoLength', 'playTime'];

function pickMs(source: any, paths: string[]): number {
  for (const path of paths) {
    const n = Number(getPath(source, path));
    if (!Number.isFinite(n) || n <= 0) continue;
    const ms = n < 1e12 ? n * 1000 : n;
    if (ms >= 1e12 && ms <= 4e12) return ms;
  }
  return 0;
}

function pickSeconds(source: any, paths: string[]): number {
  for (const path of paths) {
    const n = Number(getPath(source, path));
    if (!Number.isFinite(n) || n <= 0) continue;
    return n > 1e6 ? Math.round(n / 1000) : Math.round(n);
  }
  return 0;
}

/** 封面：只接受能归一成 http(s) 的地址（坏地址写进去 = 图片变空白，宁可不写） */
export function pickWatchCover(source: any, paths: string[]): string {
  for (const path of paths) {
    const raw = String(getPath(source, path) || '').trim();
    if (!raw) continue;
    const url = normalizeUrl(raw);
    if (/^https?:\/\//i.test(url)) return url;
  }
  return '';
}

/**
 * ① 本地兜底（零网络）：`ownerId` → 成员库；没有则按昵称；再没有则按标题反查。
 *
 * 这一级就是「历史列表卡片上队伍徽章」的主要来源 —— 直播页卡片也是同一条链路
 * （`utils/memberMatch.resolveTeam`），所以两边结果必然一致。
 */
export function resolveWatchMeta(it: WatchMetaLike, lookup: MemberLookup): WatchMetaPatch | null {
  const m = findMemberByHint(lookup, { userId: it.ownerId, name: it.owner })
    || matchMemberByTitle(it.title, lookup);
  if (!m) return null;
  const owner = String(it.owner || '').trim() || String(m.ownerName || '').trim();
  const team = String(it.team || '').trim() || String(m.team || '').trim();
  const ownerId = String(it.ownerId || '').trim() || String(m.id || '').trim();
  if (!owner && !team && !ownerId) return null;
  return { owner: owner || undefined, team: team || undefined, ownerId: ownerId || undefined };
}

/** 是否还需要补全（成员名 / 队伍 / 时长 缺任一个都要补） */
export function needsEnrich(it: WatchMetaLike): boolean {
  return !String(it.owner || '').trim()
    || !String(it.team || '').trim()
    || !Number(it.duration || 0);
}

/** 补丁里是否真的有东西可写（没有就别触发 state 更新） */
export function patchHasValue(p: WatchMetaPatch): boolean {
  return !!(p.owner || p.team || p.ownerId || p.title || p.cover || p.duration || p.liveType);
}

/**
 * 把一条接口原始项（录播列表 / 视频列表 / 详情）压成可写回的补丁。
 *
 * 队伍走 `resolveTeam`：**先 userInfo.userId、后归一化昵称、再退回条目自带的队伍字段** ——
 * 与直播页卡片 `teamOfItem` 完全同一条链路（"尤其队伍显示不出来"的根治点）。
 */
export function patchFromRaw(raw: any, isVideo: boolean, lookup: MemberLookup): WatchMetaPatch {
  if (!raw || typeof raw !== 'object') return {};
  const nickname = pickMemberNickname(raw);
  const title = String(pickText(raw, isVideo ? VIDEO_TITLE : VOD_TITLE) || '').trim();
  const cover = pickWatchCover(raw, isVideo ? VIDEO_COVER : VOD_COVER);
  /**
   * 时长：只认**明确是时长**的字段。
   *
   * ⚠️ 旧实现把 `endTime` 也放进秒数候选（`pickSeconds(raw, ['duration','endTime'])`）：
   * 录播列表的 `endTime` 是**毫秒时间戳**（1.7e12），被当成"秒"读出来会算出
   * 几十万小时的荒谬时长 —— 卡片右下角的时长角标因此显示成天文数字。
   * 现在只从 duration 类字段取，取不到再用 (endTime - startTime) / 1000 计算。
   */
  let duration = pickSeconds(raw, isVideo ? VIDEO_DURATION : ['duration', 'videoDuration', 'playTime', 'length']);
  if (!isVideo && !duration) {
    // 录播口径与直播页录播卡一致：(endTime - startTime) / 1000
    const start = pickMs(raw, VOD_START);
    const end = pickMs(raw, VOD_END);
    if (start && end && end > start) duration = Math.round((end - start) / 1000);
  }
  const liveTypeRaw = Number(getPath(raw, 'liveType') ?? getPath(raw, 'type') ?? 0);
  const teamFromDetail = String(pickText(raw, [
    'userInfo.team', 'userInfo.teamName', 'userInfo.groupName',
    'team', 'teamName', 'groupName',
  ]) || '').trim();
  const team = resolveTeam(lookup, { userId: pickMemberUserId(raw), name: nickname }, teamFromDetail || undefined);
  return {
    owner: nickname || undefined,
    team: team || undefined,
    ownerId: pickMemberUserId(raw) || undefined,
    title: title || undefined,
    cover: cover || undefined,
    duration: duration || undefined,
    liveType: Number.isFinite(liveTypeRaw) && liveTypeRaw > 0 ? liveTypeRaw : undefined,
  };
}

export interface EnrichPlanInput {
  items: WatchMetaLike[];
  /** 批量表：liveId → 官方录播原始项 */
  vod?: Map<string, any> | Record<string, any>;
  /** 批量表：videoId → 官方视频原始项 */
  video?: Map<string, any> | Record<string, any>;
  lookup: MemberLookup;
  /** key → 已尝试次数 */
  attempts?: Record<string, number> | Map<string, number>;
  /** 正在请求中的 key（防重复并发） */
  inFlight?: Iterable<string>;
  /** 单轮网络兜底上限 */
  limit?: number;
  /** 单条最多尝试次数 */
  maxAttempts?: number;
}

export interface EnrichPlan {
  /** 可以立刻写回的补丁（本地命中 / 批量表命中） */
  patches: Array<{ key: string; patch: WatchMetaPatch }>;
  /** 需要打网络请求的条目 key */
  network: string[];
  /** 尝试次数需要 +1 的条目 key（失败/无入口，都不是"永久放弃"） */
  bumped: string[];
  /** 本轮是否还有事可做 */
  active: boolean;
}

function mapGet(src: Map<string, any> | Record<string, any> | undefined, key: string): any {
  if (!src || !key) return undefined;
  if (src instanceof Map) return src.get(key);
  return (src as Record<string, any>)[key];
}

function attemptOf(attempts: EnrichPlanInput['attempts'], key: string): number {
  if (!attempts) return 0;
  if (attempts instanceof Map) return Number(attempts.get(key) || 0);
  return Number((attempts as Record<string, number>)[key] || 0);
}

/**
 * 规划一轮补全（**纯函数**）。
 *
 * 优先级：批量表 > 本地成员库 > 网络兜底；没有网络入口的条目只记一次尝试，
 * 绝不空转（旧实现里它们会每轮都被扫一遍，把整条流水线拖住）。
 */
export function planEnrich(input: EnrichPlanInput): EnrichPlan {
  const {
    items, vod, video, lookup, attempts, inFlight,
    limit = 12, maxAttempts = 3,
  } = input;
  const patches: Array<{ key: string; patch: WatchMetaPatch }> = [];
  const network: string[] = [];
  const bumped: string[] = [];
  const flying = new Set<string>(inFlight ? Array.from(inFlight) : []);

  for (const it of items || []) {
    if (!it || !it.key) continue;
    if (!needsEnrich(it)) continue;
    if (attemptOf(attempts, it.key) >= maxAttempts) continue;
    if (flying.has(it.key)) continue;

    // ② 批量表命中：一次性补齐（1 个请求能补几十条，比逐条请求便宜得多）
    const raw = it.liveId ? mapGet(vod, String(it.liveId)) : mapGet(video, String(it.videoId));
    if (raw) {
      const p = patchFromRaw(raw, !it.liveId, lookup);
      if (patchHasValue(p)) patches.push({ key: it.key, patch: p });
      bumped.push(it.key);
      continue;
    }

    // ① 本地：成员 id → 昵称 → 标题（零网络，立刻就能把队伍徽章补上）
    const lp = resolveWatchMeta(it, lookup);
    if (lp && patchHasValue(lp)) patches.push({ key: it.key, patch: lp });

    // ③ 网络兜底
    if (it.liveId || it.videoId) {
      if (network.length < limit) network.push(it.key);
      continue;
    }
    // 既没本地命中、也没网络入口：记一次尝试，避免每轮空转
    bumped.push(it.key);
  }

  return { patches, network, bumped, active: patches.length > 0 || network.length > 0 };
}
