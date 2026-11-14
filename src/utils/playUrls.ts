/**
 * 直播列表条目的「可播放地址」抽取（纯函数）。
 *
 * 从 MediaScreen 原样搬出（用户 2026-11-13：四处播放器统一调用同一个入口）：
 * 直播页 / 房间 / 历史 / 稍后再看 都要从「官方条目」里挑地址，
 * 以前这份字段表与排序只存在于 MediaScreen，其它页面只能用各自的实现 —— 口径分裂。
 * 现在只有这一份，直播页与统一播放入口（player/session/playEntry）共用。
 *
 * ⚠️ 字段表与评分刻意保持 MediaScreen 原版（不含 cover / imageUrl 等图片字段）：
 * 统一流解析器 player/resolve/streamResolver 的同类函数会把封面也算成候选地址，
 * 直接换过去会让列表卡「播出一张图」。
 */
import { normalizeUrl, pickText, unwrapList } from './data';

export const PLAY_URL_FIELDS = [
  'playStreamPath',
  'playUrlPath',
  'playPathUrl',
  'streamUrl',
  'streamURL',
  'playUrl',
  'urlPath',
  'playPath',
  'streamPath',
  'path',
  'src',
  'pullStreamPath',
  'liveStreamPath',
  'livePlayStreamPath',
  'streamPathHd',
  'streamPathHigh',
  'streamPathNormal',
  'streamPathOrigin',
  'url',
  'liveUrl',
  'm3u8Url',
  'flvUrl',
  'hlsUrl',
  'videoUrl',
  'recordUrl',
  'mediaUrl',
  'filePath',
  'content.playStreamPath',
  'content.playUrlPath',
  'content.playPathUrl',
  'content.streamUrl',
  'content.playUrl',
  'content.playPath',
  'content.streamPath',
  'content.pullStreamPath',
  'content.liveStreamPath',
  'content.livePlayStreamPath',
  'content.url',
  'data.playStreamPath',
  'data.playUrlPath',
  'data.playPathUrl',
  'data.streamUrl',
  'data.playUrl',
  'data.playPath',
  'data.streamPath',
  'data.pullStreamPath',
  'data.liveStreamPath',
  'data.livePlayStreamPath',
  'data.url',
  'content.playStreams.0.streamPath',
  'data.playStreams.0.streamPath',
];

/** 录播地址优先级：HLS 优先（可拖） */
export function streamScore(url: string): number {
  const lower = url.toLowerCase();
  if (lower.includes('.m3u8') || lower.includes('format=hls')) return 100;
  if (lower.startsWith('https://') && lower.includes('.flv')) return 60;
  if (lower.startsWith('http://') && lower.includes('.flv')) return 50;
  if (lower.startsWith('rtmp://')) return 20;
  return 40;
}

/** 直播地址优先级：rtmp / https-flv 优先（低延迟） */
export function liveStreamScore(url: string): number {
  const lower = url.toLowerCase();
  if (lower.startsWith('rtmp://')) return 120;
  if (lower.startsWith('https://') && lower.includes('.flv')) return 105;
  if (lower.startsWith('http://') && lower.includes('.flv')) return 95;
  if (lower.includes('.m3u8') || lower.includes('format=hls')) return 80;
  return streamScore(url);
}

/** 从官方条目里抽取全部候选地址，按「直播/录播」语义排序 */
export function pickPlayableUrls(raw: any, preferLive = false): string[] {
  const candidates: string[] = [];
  const direct = normalizeUrl(pickText(raw, PLAY_URL_FIELDS));
  if (direct) candidates.push(direct);
  const streamList = unwrapList(raw, [
    'streams',
    'playStreams',
    'liveStreams',
    'urls',
    'content.streams',
    'content.playStreams',
    'content.urls',
    'data.streams',
    'data.playStreams',
    'content.liveStreams',
    'content.streamList',
    'content.playStreamList',
    'data.liveStreams',
    'data.streamList',
    'data.playStreamList',
    'data.urls',
  ]);
  for (const stream of streamList) {
    const url = normalizeUrl(pickText(stream, PLAY_URL_FIELDS));
    if (url) candidates.push(url);
  }
  const score = preferLive ? liveStreamScore : streamScore;
  return Array.from(new Set(candidates.filter(Boolean))).sort((a, b) => score(b) - score(a));
}

/** 取最优的一个地址（无则空串） */
export function pickPlayableUrl(raw: any): string {
  return pickPlayableUrls(raw)[0] || '';
}
