/**
 * 「历史 / 稍后再看」点击条目后的播放地址解析（用户 2026-09-30）。
 *
 * 为什么必须"重新解析"而不是存 url：口袋的直播/回放地址带签名（wsSecret），
 * 公演回放与官方视频库的地址也都可能失效 —— 存下来的地址第二天基本播不了。
 * 所以这两个列表只存 (来源类型, id)，点击时按下表分派：
 *
 *   refKind = 'video'    → 官方视频库：officialMediaApi.getVideo(videoId)
 *   refKind = 'openlive' → 公演回放：pocketApi.getOpenLiveOne(liveId) + pickPlayableUrls
 *   refKind = 'replay'   → 房间里的直播回放：resolveRoomLiveMedia（内部依次试
 *                          getLiveOne / getOpenLiveOne / 直播列表 / 回放列表）
 *   仅 liveId（直播）    → 同样走 resolveRoomLiveMedia（它内部能解析正在进行的直播）
 *
 * ⚠️ 与各页面的实现保持同一口径：官方视频的相对路径统一补 `https://mp4.48.cn`
 *（与 VideoLibraryScreen.mediaUrl 一致），口袋接口统一带防盗链头 buildPocketHeaders()。
 */
import officialMediaApi from '../../api/officialMedia';
import pocketApi from '../../api/pocket48';
import { pickPlayableUrls, resolveRoomLiveMedia } from '../room/mediaResolve';
import { buildPocketHeaders } from '../../player';
import { normalizeUrl } from '../../utils/data';
import { t } from '../../i18n';
import type { WatchLaterKind } from '../../services/watchLater';

/** 解析入参：历史条目与稍后再看条目都能直接传进来（字段是这两者的并集） */
export interface PlayableRef {
  /** 来源类型（决定走哪条解析链路） */
  refKind?: WatchLaterKind;
  /** videoId / liveId */
  refId?: string;
  /** 直播 / 回放的 liveId */
  liveId?: string;
  /** 播放器 source.kind（拿不到 ref 时的兜底判据） */
  kind?: string;
  title?: string;
  cover?: string;
}

export interface ResolvedPlayback {
  url: string;
  headers?: Record<string, string>;
  title: string;
  /** 当前解析所用的来源（原样带回，播放时继续写进历史） */
  refKind?: WatchLaterKind;
  refId?: string;
  liveId?: string;
}

/** 官方媒体相对路径 → 绝对地址（与 VideoLibraryScreen.mediaUrl 同口径） */
function officialMediaUrl(path: string): string {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return path.startsWith('/') ? `https://mp4.48.cn${path}` : normalizeUrl(path);
}

export async function resolvePlayUrl(item: PlayableRef): Promise<ResolvedPlayback> {
  const title = String(item.title || '');
  const refKind = item.refKind;
  const refId = String(item.refId || '');

  // ① 官方视频库
  if (refKind === 'video' && refId) {
    const res = await officialMediaApi.getVideo(refId);
    const data = (res as any)?.content?.data || (res as any)?.content || (res as any)?.data || {};
    const url = officialMediaUrl(String(data.filePath || data.videoPath || data.url || ''));
    if (!url) throw new Error(t('未返回视频文件地址'));
    return { url, headers: buildPocketHeaders(), title, refKind, refId };
  }

  // ② 公演回放
  if (refKind === 'openlive' && refId) {
    const detail = await pocketApi.getOpenLiveOne(refId);
    const url = String(pickPlayableUrls(detail)[0] || '');
    if (!url) throw new Error(t('没有解析到播放地址'));
    return { url, headers: buildPocketHeaders(), title, refKind, refId };
  }

  /**
   * ③ 房间直播回放 / 正在进行的直播：都靠 liveId 重新解析。
   * `replayHint: true` 明示按录播处理（拿该场的 playStreams、isLive=false，
   * 这样播放器会显示进度条、走录播语义），与房间页 playRoomReplay 的调用完全一致。
   */
  const liveId = String(item.liveId || (refKind === 'replay' ? refId : '') || '');
  if (liveId) {
    const resolved = await resolveRoomLiveMedia({
      type: 'video',
      url: '',
      title,
      cover: item.cover,
      liveId,
      replayHint: true,
    } as any);
    const url = String((resolved as any)?.url || '');
    if (!url) throw new Error(t('没有解析到播放地址'));
    return {
      url,
      // 与房间页同一套防盗链头（统一走 buildPocketHeaders，别在这里另写一份）
      headers: buildPocketHeaders(),
      title: String((resolved as any)?.title || title),
      refKind: refKind === 'video' || refKind === 'openlive' ? refKind : 'replay',
      refId: refId || liveId,
      liveId,
    };
  }

  throw new Error(t('这条记录没有可用的播放地址'));
}

export default resolvePlayUrl;
