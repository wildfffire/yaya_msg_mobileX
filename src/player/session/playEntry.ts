/**
 * 统一播放入口 —— 「播什么」的唯一构造点（用户 2026-11-13）。
 *
 * 四个场景（直播页 / 房间内直播与回放 / 历史记录 / 稍后再看）以前各自把手上的数据
 * 拼成 `PlayMedia`：直播页一份、房间两份（消息卡 + 回放抽屉）、历史与稍后再看三份
 * （列表页一份 + 「我的」横滑卡两份，逐字抄但已经出现分叉）。
 * 同一场内容从不同入口点开，字段（kind / isLive / owner / liveId）可能不一样，
 * 接上统一宿主后表现就会「同样是回放，这里能拖进度，那里不能」。
 *
 * 现在只有这一份：页面只负责把「条目 / store 记录 / 房间媒体卡」交进来，
 * 解析、续播、弹幕、在线人数、小窗、公告全部由 `MediaPlaybackHost` 完成。
 *
 * 口径（与宿主一致，别再写第二套）：
 *   · 直播页列表卡 → `live`/`replay` + 已抽好的候选地址（快速起播）
 *   · 历史 / 稍后再看 → 只带 id（video/openlive/replay/live），地址**永不落盘**，点开时解析
 *   · 房间消息卡 → `live`/`replay`/`direct`，是否直播由 mediaRules.roomTapIsVod 判定
 *   · 房间回放抽屉 → 恒 `replay`（可拖进度、走 LRC 弹幕）
 */
import { pickPlayableUrls } from '../../utils/playUrls';
import { roomTapIsVod, type RoomMedia } from '../../screens/room/mediaRules';
import type { PlayMedia } from './types';

/** 归属成员信息：写历史记录、列表卡片、右上角「进房间」入口都要用 */
export interface PlayOwnerHints {
  owner?: string;
  team?: string;
  ownerId?: string;
}

/** 房间场景额外带成员 id（在线人数兜底反查 liveId） */
export interface RoomPlayHints extends PlayOwnerHints {
  memberId?: string;
}

/** 历史 / 稍后再看里可重新解析的来源（与 PlayerContentRef 同构） */
export type WatchRefKind = 'video' | 'openlive' | 'replay';

/**
 * 直播页（MediaScreen）列表卡 → PlayMedia（原 `startPlay` 的唯一实现）。
 *
 * @param item       官方直播/录播条目（列表里拿到的原始对象）
 * @param preferLive 当前 tab 是否「直播」（决定候选地址排序与 isLive 预判）
 * @param team       页面已按成员库反查出的队伍（卡片徽章同一条口径）
 */
export function playMediaFromLiveItem(
  item: any,
  opts: { preferLive: boolean; team?: string; fallbackTitle: string },
): PlayMedia {
  const preferLive = !!opts.preferLive;
  const urls = pickPlayableUrls(item, preferLive);
  const owner = String(item?.nickname || item?.ownerName || '');
  const ownerId = String(item?.userInfo?.userId || item?.userId || item?.ownerId || '');
  return {
    kind: preferLive ? 'live' : 'replay',
    url: urls[0] || '',
    urls,
    title: item?.title || item?.liveRoomTitle || opts.fallbackTitle,
    cover: item?.liveCover || item?.coverPath,
    liveId: String(item?.liveId || ''),
    // tab 预判直播/回放（与旧行为一致）：vod tab 一律按录播（可拖进度条）
    isLive: preferLive,
    owner,
    team: opts.team || String(item?.team || ''),
    ownerId,
    /** 电台直播（liveType=2）：首帧就走照片轮播，不闪「成员离开」占位图 */
    radio: preferLive && Number(item?.liveType) === 2,
    raw: item,
  };
}

/**
 * 历史 / 稍后再看列表条目 → PlayMedia。
 *
 * 只带来源 id（地址有时效，点开时由宿主重新解析）：
 *   video → videoId；openlive → liveId；replay → liveId；无来源 → 按直播解析（旧数据兜底）。
 */
export function playMediaFromWatchEntry(entry: {
  refKind?: WatchRefKind;
  refId?: string;
  liveId?: string;
  title?: string;
  cover?: string;
  owner?: string;
  team?: string;
  ownerId?: string;
}): PlayMedia {
  const refId = String(entry.refId || '');
  const liveId = String(entry.liveId || '');
  const base = {
    title: entry.title || '',
    cover: entry.cover,
    owner: entry.owner,
    team: entry.team,
    ownerId: entry.ownerId,
  };
  if (entry.refKind === 'video') return { ...base, kind: 'video', videoId: refId || liveId };
  if (entry.refKind === 'openlive') return { ...base, kind: 'openlive', liveId: refId || liveId };
  if (entry.refKind === 'replay') return { ...base, kind: 'replay', liveId: liveId || refId };
  return { ...base, kind: 'live', liveId: liveId || refId };
}

/** 「稍后再看」store 条目 → PlayMedia（列表页与「我的」横滑卡共用同一条映射） */
export function playMediaFromWatchLaterItem(it: {
  kind: WatchRefKind;
  id: string;
  title?: string;
  cover?: string;
  owner?: string;
  team?: string;
  ownerId?: string;
}): PlayMedia {
  return playMediaFromWatchEntry({
    refKind: it.kind,
    refId: it.id,
    liveId: it.kind === 'video' ? '' : it.id,
    title: it.title,
    cover: it.cover,
    owner: it.owner,
    team: it.team,
    ownerId: it.ownerId,
  });
}

/** 「观看历史」store 条目 → PlayMedia（ref 优先，旧记录没有 ref 时才用 liveId/直播兜底） */
export function playMediaFromHistoryItem(it: {
  ref?: { kind?: WatchRefKind; id?: string };
  liveId?: string;
  title?: string;
  cover?: string;
  owner?: string;
  team?: string;
  ownerId?: string;
}): PlayMedia {
  return playMediaFromWatchEntry({
    refKind: it.ref?.kind,
    refId: it.ref?.id,
    liveId: it.liveId,
    title: it.title,
    cover: it.cover,
    owner: it.owner,
    team: it.team,
    ownerId: it.ownerId,
  });
}

/**
 * 房间消息里的媒体卡 → PlayMedia。
 *
 * 返回 null = 不是「直播/回放/视频」类（图片 / 语音 / 链接由房间页自己处理，
 * 语音仍是气泡内联播放，不进大播放器）。
 */
export function playMediaFromRoomMedia(media: RoomMedia, hints: RoomPlayHints): PlayMedia | null {
  const ownerHints: PlayOwnerHints = {
    owner: String(hints.owner || ''),
    team: String(hints.team || ''),
    ownerId: String(hints.ownerId || ''),
  };
  const memberId = hints.memberId ? String(hints.memberId) : undefined;
  if (media.type === 'live' || media.liveId) {
    return {
      kind: media.replayHint ? 'replay' : 'live',
      url: String(media.url || ''),
      title: String(media.title || ''),
      cover: media.cover,
      liveId: String(media.liveId || ''),
      /**
       * 带地址时按房间既有口径预判直播/回放（rtmp/flv=直播；m3u8/mp4 二义按回放）；
       * 无地址时交给宿主按解析结果判定（与历史/稍后再看同一条链路）。
       */
      ...(media.url ? { isLive: !roomTapIsVod(media) } : {}),
      ...(media.type === 'audio' ? { audioOnly: true } : {}),
      ...(media.radio ? { radio: true } : {}),
      ...(media.carouselPhotos ? { carouselPhotos: media.carouselPhotos } : {}),
      ...(media.carouselIntervalMs ? { carouselIntervalMs: media.carouselIntervalMs } : {}),
      ...ownerHints,
      ...(memberId ? { memberId } : {}),
    };
  }
  if (media.type === 'video') {
    // 房间视频消息：自带地址直接播放（不做任何网络解析）
    return {
      kind: 'direct',
      url: String(media.url || ''),
      title: String(media.title || ''),
      cover: media.cover,
      ...ownerHints,
      ...(memberId ? { memberId } : {}),
    };
  }
  return null;
}

/**
 * 房间「直播回放」抽屉条目 → PlayMedia。
 *
 * kind='replay' 明示录播：解析器按录播处理（拿该场 playStreams、isLive=false）
 * → 可拖进度条、走 LRC 弹幕，不会把回放流误判成直播。
 */
export function playMediaFromRoomReplay(
  item: { liveId?: string; title?: string; cover?: string },
  hints: RoomPlayHints,
): PlayMedia {
  return {
    kind: 'replay',
    url: '',
    title: String(item?.title || ''),
    cover: item?.cover,
    liveId: String(item?.liveId || ''),
    owner: String(hints.owner || ''),
    team: String(hints.team || ''),
    ownerId: String(hints.ownerId || ''),
    ...(hints.memberId ? { memberId: String(hints.memberId) } : {}),
  };
}
