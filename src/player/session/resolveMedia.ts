/**
 * 统一媒体解析（四场景唯一入口）：
 *   live / replay → resolveRoomLiveMediaWithRetry（多层兜底：详情/公开详情/直播列表/回放列表）
 *   video         → 官方视频库（officialMediaApi.getVideo，经 watch/resolvePlayUrl）
 *   openlive      → 公演回放（pocketApi.getOpenLiveOne，经 watch/resolvePlayUrl）
 *   audio         → 地址必现，不做网络解析
 *
 * 为什么收口到这一层（用户 2026-10-02「只调用同一个或两个播放器」）：
 *   以前 MediaScreen 的 startPlay / 房间的 useLiveResolve / watch 的 resolvePlayUrl
 *   是三份互相抄但各有细节分叉的解析实现（快速起播、直播/回放判定、兜底顺序都不完全一样）。
 *   现在只有这里一份，页面传 `PlayMedia` 即可。
 *
 * isLive 判定口径（与 mediaRules.roomTapIsVod 完全一致，别再写第二套）：
 *   ① 调用方明确传了 isLive → 用它（MediaScreen 的 tab 预判 / 房间的解析结果）
 *   ② kind='replay' → 恒 false（回放要能拖进度条）
 *   ③ rtmp/flv → live（推流只可能是直播）
 *   ④ m3u8/mp4 二义：查直播列表命中才算 live，否则按录播（录播可拖，防录播套直播控件）
 */
import { t } from '../../i18n';
import { liveIdFromUrl } from '../../utils/data';
import { buildPocketHeaders } from '../resolve/streamResolver';
import { cachedLiveList, resolveRoomLiveMediaWithRetry } from '../../screens/room/mediaResolve';
import { isPlayableMediaUrl, roomTapIsVod, streamNeedsProxy } from '../../screens/room/mediaRules';
import { findLiveItem } from '../../screens/room/roomIdentity';
import { resolvePlayUrl } from '../../screens/watch/resolvePlayUrl';
import type { PlayMedia, ResolvedMedia } from './types';

/** m3u8/mp4 二义：查直播列表（record:false）命中 liveId 才视为正在直播 */
async function probeIsLive(liveId: string): Promise<boolean> {
  if (!liveId) return false;
  try {
    const found = await findLiveItem(await cachedLiveList(false, 0, 0), liveId);
    return !!found;
  } catch {
    return false;
  }
}

export async function resolveMedia(media: PlayMedia): Promise<ResolvedMedia> {
  if (!media) throw new Error(t('没有可播放的内容'));
  const title = String(media.title || '');
  const liveId = String(media.liveId || '');
  const headers = buildPocketHeaders();

  // ① 纯音频（房间语音/上麦）/ 自带地址直播（房间视频消息）：地址必现，不解析
  if (media.kind === 'audio' || media.kind === 'direct') {
    const url = String(media.url || (media.urls && media.urls[0]) || '');
    if (!url) throw new Error(t('没有解析到播放地址'));
    return {
      url,
      urls: Array.from(new Set([url, ...(media.urls || [])].filter(Boolean))),
      headers,
      title,
      cover: media.cover,
      liveId,
      isLive: false,
      needsExo: streamNeedsProxy(url),
      audioOnly: media.kind === 'audio',
    };
  }

  // ② 官方视频库 / 公演回放：复用 watch 的解析实现（地址可能失效，永远重新解析）
  if (media.kind === 'video' || media.kind === 'openlive') {
    const refId = String(media.videoId || media.liveId || '');
    if (!refId) throw new Error(t('这条记录没有可用的播放地址'));
    const r = await resolvePlayUrl({
      refKind: media.kind,
      refId,
      liveId,
      title,
      cover: media.cover,
    });
    return {
      url: r.url,
      urls: [r.url],
      headers: buildPocketHeaders(),
      title: r.title || title,
      cover: media.cover,
      liveId: String(r.liveId || liveId || refId),
      isLive: false,
      needsExo: streamNeedsProxy(r.url),
      audioOnly: false,
      ref: { kind: media.kind, id: refId },
    };
  }

  // ③ 直播 / 房间回放
  const ownUrl = String(media.url || '');
  const quickUrl = isPlayableMediaUrl(ownUrl) ? ownUrl : '';

  /** 统一判定（口径见文件头注释） */
  const decideLive = (resolvedIsLive: boolean): boolean => {
    if (media.kind === 'replay') return false;
    if (media.isLive !== undefined) return !!media.isLive;
    return resolvedIsLive;
  };

  if (quickUrl) {
    const lower = quickUrl.toLowerCase();
    const isRtmpFlv = lower.startsWith('rtmp://') || lower.includes('.flv');
    // rtmp/flv 无需查询；m3u8/mp4 且调用方未明确判定时才查一次列表
    const resolvedIsLive = isRtmpFlv
      ? true
      : (media.kind === 'live' && media.isLive === undefined && liveId)
        ? await probeIsLive(liveId)
        : false;
    const isLive = decideLive(resolvedIsLive);
    return {
      url: quickUrl,
      urls: Array.from(new Set([quickUrl, ...(media.urls || [])].filter(Boolean))),
      headers,
      title: title || t('直播 / 录播'),
      cover: media.cover,
      // 回放地址里常带 liveId（消息卡抽不到时的兜底，与房间/在线人数同一策略）
      liveId: liveId || liveIdFromUrl(quickUrl),
      isLive,
      needsExo: streamNeedsProxy(quickUrl),
      audioOnly: false,
      ref: isLive ? undefined : { kind: 'replay', id: liveId || liveIdFromUrl(quickUrl) },
      // 电台直播：列表项已判定的类型与照片（解析层没跑详情时由宿主补拉，见 usePlaybackCarousel）
      radio: !!media.radio,
      carouselPhotos: media.carouselPhotos,
      carouselIntervalMs: media.carouselIntervalMs,
    };
  }

  // 无地址：多层兜底解析（含瞬时失败自动重试）
  const resolved = await resolveRoomLiveMediaWithRetry({
    type: 'live',
    url: '',
    title: title || t('直播 / 录播'),
    cover: media.cover || '',
    liveId,
    replayHint: media.kind === 'replay',
  } as any);
  const url = String((resolved as any)?.url || '');
  if (!url) throw new Error(t('没有解析到播放地址'));

  const isLive = decideLive(!roomTapIsVod(resolved as any));
  const finalLiveId = String((resolved as any)?.liveId || liveId || liveIdFromUrl(url) || '');
  return {
    url,
    urls: Array.from(new Set([url, ...((resolved as any)?.urls || [])].filter(Boolean))),
    headers,
    title: String((resolved as any)?.title || title || t('直播 / 录播')),
    cover: String((resolved as any)?.cover || media.cover || '') || undefined,
    liveId: finalLiveId,
    isLive,
    needsExo: !!(resolved as any)?.needsVlc || streamNeedsProxy(url),
    audioOnly: false,
    ref: isLive ? undefined : { kind: 'replay', id: finalLiveId },
    detail: (resolved as any)?.detail,
    // 电台直播（liveType=2）：详情里带出的轮播照片（mediaResolve.parseLiveCarousel）
    radio: !!(resolved as any)?.radio || !!media.radio,
    carouselPhotos: (resolved as any)?.carouselPhotos || media.carouselPhotos,
    carouselIntervalMs: (resolved as any)?.carouselIntervalMs || media.carouselIntervalMs,
  };
}

export default resolveMedia;
