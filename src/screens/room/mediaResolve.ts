/**
 * 房间页的「媒体与流地址解析」（拆分第 4 步）。
 *
 * `roomMedia` 是「一条房间消息 → 一张可播放卡片」的唯一入口，负责时长归一、封面回退、
 * 直播/录播判定；`pickPlayableUrls` 决定从几十个候选字段里挑哪个流地址。
 * 这两处历史上出过「把封面图当视频」「录播被套上直播播放器（没有进度条）」等问题，
 * 单独成层后才有地方把规则钉死。
 *
 * 依赖方向：本层 → mediaRules(第1步) / messageRules(第2步) / timeRules / utils —— 不反向依赖。
 */

import {
  classifyMedia,
  extractLiveIdFromText,
  isLiveStreamUrl,
  isPlayableMediaUrl,
  streamNeedsProxy,
  streamScore,
  type RoomMedia,
} from './mediaRules';
import {
  collectUrls,
  deepFindText,
  extraInfo,
  firstTextFrom,
  messageBody,
} from './messageRules';
import { detailLiveState, findLiveItem } from './roomIdentity';
import pocketApi from '../../api/pocket48';
import { parseLiveCarousel } from '../../utils/liveCarousel';
import { rememberLiveCarousel } from '../../services/liveCarousel';
import { findMediaDurationSeconds } from '../../utils/mediaDuration';
import { POCKET_MEDIA_HEADERS } from '../../utils/mediaHeaders';
import { t } from '../../i18n';
import { messageText, normalizeUrl, pickText, unwrapList } from '../../utils/data';

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
  'audioUrl',
  'voiceUrl',
  'recordUrl',
  'mediaUrl',
  'filePath',
  'imageUrl',
  'imagePath',
  'picPath',
  'picturePath',
  'cover',
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
  'content.imageUrl',
  'content.imagePath',
  'content.picPath',
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
  'data.imageUrl',
  'data.imagePath',
  'data.picPath',
];

export function pickPlayableUrls(raw: any, preferLive = false): string[] {
  const candidates: string[] = [];
  const direct = normalizeUrl(pickText(raw, PLAY_URL_FIELDS));
  if (direct) candidates.push(direct);
  const nested = unwrapList(raw, [
    'streams',
    'playStreams',
    'liveStreams',
    'urls',
    'content.streams',
    'content.playStreams',
    'content.liveStreams',
    'content.streamList',
    'content.playStreamList',
    'content.urls',
    'data.streams',
    'data.playStreams',
    'data.liveStreams',
    'data.streamList',
    'data.playStreamList',
    'data.urls',
  ]);
  nested.forEach((item) => {
    const url = normalizeUrl(pickText(item, PLAY_URL_FIELDS));
    if (url) candidates.push(url);
  });
  collectUrls(raw).forEach((url) => candidates.push(url));
  return Array.from(new Set(candidates.filter(Boolean))).sort((a, b) => streamScore(b, preferLive) - streamScore(a, preferLive));
}

// 诊断：收集媒体消息里所有「疑似时长」的数字字段，用于定位真实 duration 字段名。
// 仅在 duration 取不到（返回空）时打印；限频每 30s 最多一次。
// 注意：release 包也打印（去掉 __DEV__ 守卫），便于真机实跑反馈音频时长字段名；低频无碍。
const __diagThrottle: { last: number } = { last: 0 };

function diagDurationFields(label: string, sources: any[]) {
  const now = Date.now();
  if (now - __diagThrottle.last < 30000) return;
  __diagThrottle.last = now;
  const candidates: Record<string, any> = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (!/duration|time|length|second|ms$/i.test(k)) continue;
      if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
        candidates[k] = v;
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[diag:duration:${label}] candidates=`, JSON.stringify(candidates), 'type=', String(sources[0]?.msgType || ''));
}

export function roomMedia(item: any): RoomMedia | null {
  if (!item) return null;
  const body = messageBody(item);
  const ext = extraInfo(item);
  const text = messageText(item);
  const msgType = String(item.msgType || item.extMsgType || body.msgType || body.extMsgType || '').toUpperCase();
  if (msgType.includes('GIFT') || String(item.msgType) === '7') return null;

  /**
   * 48 自带表情（贴纸）。
   *
   * ⚠️ 用户反馈（2026-09-28）：「有些 48 自己的表情识别不出来」。
   * 旧实现只认 `msgType === 'EXPRESSIMAGE' || 'EXPRESS'` 两个值 —— 一旦服务端换了类型名
   * （EXPRESSION / EMOTION / EMOJI / STICKER…），或该消息**根本没带类型、只有表情字段**，
   * 就会漏判 → 表情被当普通图片显示（尺寸/缩略图/点击行为全不对）。
   *
   * 现在两条判据任一成立即算表情：
   *   ① 类型名里含 EXPRESS / EMOTION / EMOJI / STICKER（大小写不敏感）；
   *   ② 消息里确实带表情字段（`expressImgInfo` 等）—— 与类型名解耦，最可靠。
   * 取图仍旧按 emotionRemote → url → image 的顺序兜底。
   */
  const expressInfo =
    body?.expressImgInfo || ext?.expressImgInfo || body?.expressInfo || body?.emotionInfo || item?.expressImgInfo;
  const isExpressType = /EXPRESS|EMOTION|EMOJI|STICKER/i.test(msgType);
  if (isExpressType || expressInfo) {
    const exprUrl = normalizeUrl(
      expressInfo?.emotionRemote || expressInfo?.url || expressInfo?.image || body?.url || '',
    );
    if (exprUrl) return { type: 'image' as const, url: exprUrl, title: t('表情') };
  }

  const liveId = firstTextFrom([item, ext, body], [
    'liveId',
    'liveid',
    'live_id',
    'message.liveId',
    'msg.liveId',
    'content.liveId',
    'data.liveId',
  ]) || deepFindText([item, ext, body], ['liveId', 'liveid', 'live_id']) || extractLiveIdFromText([item, ext, body, text]);
  const urls = pickPlayableUrls([item, ext, body], !!liveId || msgType.includes('LIVE'));
  let url = urls[0] || '';
  // Fallback: try collecting all URLs from parsed media containers.
  // ⚠️ 不再扫描原始 item：其中 extInfo 是序列化 JSON 字符串，正则会把 ext.user.avatar
  // （成员公式照等）误当图片附件——徐钰涵每条文字消息带公式照的根因。
  // ext/body 的扫描规则统一收口在 ./mediaScan.ts：**发送者资料子树（ext.user 等）整棵不扫**，
  // 头像 avatar / 头像框 pfUrl / 队徽 teamLogo / 徽章 badge 一律不算消息附件
  //（陈琳每条文字消息多一张圆形头像框图的根因 —— 真机日志实证泄漏字段是 ext.user.pfUrl，
  //  用户 2026-10-06 反馈）。
  if (!url && !liveId) {
    const allUrls: string[] = [];
    collectUrls(ext, allUrls);
    collectUrls(body, allUrls);
    url = allUrls.find(u => u && /^https?:\/\//i.test(u)) || '';
  }
  // Fallback: if still no url but body/text itself contains a URL (typed link), use it
  if (!url && !liveId) {
    const rawUrls: string[] = [];
    collectUrls(ext, rawUrls);
    collectUrls(body, rawUrls);
    const textMatch = String(text || '').match(/(https?:\/\/[^\s]+)/i);
    if (textMatch) rawUrls.push(textMatch[1]);
    url = rawUrls.find(u => u && /^https?:\/\//i.test(u)) || '';
  }
  // Still no URL? Check if text IS a media indicator
  if (!url && !liveId) {
    const t = String(text || '').toLowerCase();
    if (t.includes('[图片]') || t.includes('[语音]') || t.includes('[视频]') || t.includes('[链接]') || t.includes('[直播]')) {
      // Y20: 占位文本不是可播放媒体——return null 走普通文本气泡，
      // 不再把 '[图片]'/'[直播]' 当 url（此前 classifyMedia 后渲染成破图/误调 Linking）
      return null;
    }
  }
  if (!url && !liveId) return null;
  const type = liveId ? 'live' : classifyMedia(url, msgType, text);
  const durationSec = [item, ext, body].reduce((best, src) => best || findMediaDurationSeconds(src), 0);
  const duration = durationSec > 0 ? String(Math.round(durationSec)) : '';
  // 诊断：audio/video 取不到时长时，dump 真实字段名（DEV 限频）
  if ((type === 'audio' || type === 'video') && !duration) {
    diagDurationFields(type, [item, ext, body]);
  }
  // Audio/video 在房间里只用两个字前缀，避免「语音 语音消息」这种重复；live 保留完整标签
  const title = type === 'audio' ? t('语音')
    : type === 'video' ? t('视频')
    : type === 'live' ? t('直播 / 录播')
    : type === 'image' ? t('图片')
    : text && !text.startsWith('[') && text !== url ? text
    : t('链接');
  // 封面：对齐电脑版 _ref_yk1z —— 优先用服务端关键帧缩略图 thumbPath（口袋48给视频/音频的关键帧图），
  // 拼 https://source.48.cn 前缀（thumbPath 是相对路径，normalizeUrl 不会拼，需单独处理）。
  // 退而求其次再用 coverUrl/coverPath/cover/liveCover/picPath 等绝对地址字段。
  const rawCover = firstTextFrom([item, ext, body], [
    'thumbPath', 'coverUrl', 'coverPath', 'cover', 'liveCover', 'picPath', 'picturePath', 'imageUrl', 'poster',
    'videoCover', 'videoPoster', 'thumbnail', 'thumbUrl',
    'message.coverUrl', 'message.cover', 'content.coverUrl', 'data.coverUrl',
  ]) || deepFindText([item, ext, body], [
    'thumbPath', 'coverUrl', 'cover', 'liveCover', 'picPath', 'coverPath', 'imageUrl', 'poster', 'thumb',
  ]) || '';
  let cover = '';
  if (rawCover) {
    const s = String(rawCover).trim();
    if (/^https?:\/\//i.test(s)) cover = normalizeUrl(s);
    else if (s.startsWith('/')) cover = `https://source.48.cn${s}`;
    else if (!s.startsWith('[')) cover = normalizeUrl(s); // 非占位文本
  }
  // 封面字段已在上方优先 thumbPath/cover 等绝对地址字段；fix7u 已确认服务端对房间视频消息不回独立 cover 字段
  // （fix7t 的 [diag:cover2] 全量扫描证明 finalCover 恒为空，仅 ext.user.avatar 误命中），故无 cover 时一律走首帧。

  // 消息/卡片本身已明示「回放/录播」时，播放器应走「可拖进度条的录播模式」，
  // 而不是仅凭 .flv/.m3u8 后缀误判成直播（回放地址常见 HLS/FLV 形态）。
  const replayHint = !!(msgType.match(/RECORD|PLAYBACK|VOD|REPLAY|回放/)
    || /(回放|录播|replay|playback)/i.test(`${String(text || '')} ${String(body?.title || '')} ${String(body?.content || '')} ${String(body?.desc || '')} ${String(item?.title || '')}`)
    || /(replayUrl|playbackUrl|recordUrl|\/replay\/|\/record\/|\/playback\/)/i.test(`${url} ${String(body?.replayUrl || '')} ${String(body?.playbackUrl || '')} ${String(body?.recordUrl || '')}`));
  const mediaResult = { type, url, title, duration, liveId, cover, replayHint };
  return mediaResult;
}

export function roomGiftInfo(item: any): { name: string; num: number; image: string; total: string } | null {
  if (!item) return null;
  const body = messageBody(item);
  const ext = extraInfo(item);
  const msgType = String(item.msgType || item.extMsgType || body.msgType || body.extMsgType || body.messageType || '').toUpperCase();
  const giftReplyInfo = body.giftReplyInfo || ext.giftReplyInfo || {};
  const giftInfo = body.giftInfo || giftReplyInfo.giftInfo || ext.giftInfo || item.giftInfo || null;
  if (!giftInfo && !msgType.includes('GIFT') && String(item.msgType) !== '7') return null;
  if (msgType.includes('LIVE') && !giftInfo) return null;
  const name = firstTextFrom([giftInfo, giftReplyInfo, body], ['giftName', 'replyName', 'name']) || t('礼物');
  const num = Number(firstTextFrom([giftInfo, giftReplyInfo, body], ['giftNum', 'replyNum', 'num', 'count']) || '1') || 1;
  const image = normalizeUrl(firstTextFrom([giftInfo, giftReplyInfo, body], ['picPath', 'giftPic', 'image', 'icon']));
  const money = Number(firstTextFrom([giftInfo, giftReplyInfo, body], ['money', 'replyMoney', 'cost', 'price']) || '0') || 0;
  return { name, num, image, total: money ? t('{count} 鸡腿', { count: money * num }) : '' };
}

/**
 * 红包消息（用户 2026-11-09 要求补的卡片）。
 *
 * 口径对齐桌面端 followed-chat-feature.js（`jsonType.startsWith('RED_PACKET')`）：
 *   · 判据：正文/扩展里的 jsonType 以 RED_PACKET 开头（官方有 RED_PACKET / RED_PACKET_OPEN 等）；
 *   · 字段：blessMessage（祝福语）、creatorName（发红包的人）、starName（成员名）、
 *           openImgUrl / coverUrl（红包封面图，相对路径要拼 source.48.cn）。
 * 不是红包返回 null（调用方据此决定是否渲染卡片）。
 */
export function roomRedPacketInfo(item: any): { bless: string; creator: string; star: string; image: string } | null {
  if (!item) return null;
  const body = messageBody(item);
  const ext = extraInfo(item);
  const jsonType = String(
    body.jsonType || ext.jsonType || body.messageType || body.msgType || item.msgType || '',
  ).toUpperCase();
  const msgType = String(item.msgType || item.extMsgType || '').toUpperCase();
  if (!jsonType.includes('RED_PACKET') && !msgType.includes('RED_PACKET')) return null;
  const bless = firstTextFrom([body, ext], ['blessMessage', 'bless', 'title', 'content']) || t('送来了红包祝福');
  const creator = firstTextFrom([body, ext], ['creatorName', 'senderName', 'nickName']) || '';
  const star = firstTextFrom([body, ext], ['starName', 'memberName']) || '';
  const image = normalizeUrl(firstTextFrom([body, ext], ['openImgUrl', 'coverUrl', 'packetImg', 'image']) || '');
  return { bless, creator, star, image };
}

export function playerSource(url: string) {
  // 与小窗 MiniPlayer 完全一致的防盗链 headers（含 Origin）——fix7u：统一播放器配置，消除封面/放大视频与小窗的方向差异
  // 头本身抽到 utils/mediaHeaders，任何直接访问 48 媒体地址的地方（含"取文件头算时长"）都必须复用同一份。
  return { uri: url, headers: POCKET_MEDIA_HEADERS };
}

/* ------------------------------------------------------------------ *
 * 房间直播流地址解析（从 FollowedRoomsScreen 搬入，拆分第 6 步前置）
 *
 * 为什么必须搬到这里：第 6 步要把「解析并开播」抽成 hook，
 * 而 hook 若继续从页面文件 import 这两个函数，就形成 hook → 页面文件的反向依赖，
 * 页面文件又 import 该 hook = 循环。搬到这一层后依赖方向恢复单向（hook → mediaResolve）。
 * ------------------------------------------------------------------ */
/** 直播/回放列表短缓存：同一房间短时间内的多次「抓流比对」只打一次接口 */
const LIVE_LIST_CACHE_TTL = 40 * 1000;
const liveListCache: Record<string, { t: number; res: any }> = {};
export async function cachedLiveList(record: boolean, page = 0, next = 0): Promise<any> {
  const key = `r:${record ? 1 : 0}:p:${page}:n:${next}`;
  const hit = liveListCache[key];
  if (hit && Date.now() - hit.t < LIVE_LIST_CACHE_TTL) return hit.res;
  const res = await pocketApi.getLiveList({ record, debug: true, page, next });
  liveListCache[key] = { t: Date.now(), res };
  return res;
}




export async function resolveRoomLiveMedia(media: RoomMedia): Promise<RoomMedia> {
  const liveId = String(media.liveId || extractLiveIdFromText(media) || '');
  const title = media.title || t('直播 / 录播');
  // 消息里已带可播放地址：直接返回，不再请求任何接口（直播分享/录播卡片通常自带 URL）
  const ownUrl = isPlayableMediaUrl(media.url) ? media.url : '';
  if (ownUrl) {
    const lower = ownUrl.toLowerCase();
    const isRtmp = lower.startsWith('rtmp://') || lower.includes('.flv');
    if (isRtmp) {
      // rtmp/flv 推流只可能是直播
      return { ...media, liveId, title, url: ownUrl, isLive: true, needsVlc: streamNeedsProxy(ownUrl) };
    }
    if (media.replayHint) {
      // 消息明示回放（录播卡）
      return { ...media, liveId, title, url: ownUrl, isLive: false, needsVlc: streamNeedsProxy(ownUrl) };
    }
    // m3u8/mp4 二义：默认按「回放」（录播可拖进度条）；直播列表(record:false)命中才视为直播。
    // 直播(rtmp/flv) 已在上方直接返回 live；Exo 直播状态已修复可正常出画面，因此不再为防黑屏牺牲录播判定
    let isLive = false;
    if (liveId) {
      try {
        const found = await findLiveItem(await cachedLiveList(false, 0, 0), liveId);
        isLive = !!found;
      } catch {
        isLive = false; // 查询失败按回放处理（录播优先，进度条可用；真直播多为 rtmp/flv 不受影响）
      }
    }
    return { ...media, liveId, title, url: ownUrl, isLive, needsVlc: streamNeedsProxy(ownUrl) };
  }
  const attempts: Array<{ label: 'live' | 'replay' | 'detail'; run: () => Promise<any> }> = [];
  if (liveId) {
    attempts.push({ label: 'detail', run: () => pocketApi.getLiveOne(liveId) });
    attempts.push({ label: 'detail', run: () => pocketApi.getOpenLiveOne(liveId) });
    attempts.push({ label: 'live', run: async () => findLiveItem(await cachedLiveList(false, 0, 0), liveId) });
    attempts.push({ label: 'replay', run: async () => findLiveItem(await cachedLiveList(true, 0, 0), liveId) });
    attempts.push({ label: 'replay', run: async () => findLiveItem(await pocketApi.getOpenLivePublicList({ record: true, next: 0 }), liveId) });
  }
  // 并行发起全部候选接口，按优先级取第一个出 URL 的结果；
  // 原来 6 个接口串行（最坏每个 15s 超时），是「解析卡死、第一次点击无响应」的根因。
  const ATTEMPT_TIMEOUT = 4000;
  const settled = await Promise.allSettled(
    attempts.map((attempt) => Promise.race([
      attempt.run(),
      new Promise<any>((resolve) => setTimeout(() => resolve(null), ATTEMPT_TIMEOUT)),
    ])),
  );
  // 先分辨直播还是录播，再决定播放器：
  // 回放列表（record:true）命中的结果确定是录播，优先采用；
  // 其余（正在直播列表 / 详情）按接口状态位或 URL 形态兜底判断，避免把回放流误当直播播放。
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < attempts.length; i += 1) {
      if ((pass === 0) !== (attempts[i].label === 'replay')) continue;
      const result = settled[i];
      if (result.status !== 'fulfilled' || !result.value) continue;
      const detail = result.value;
      const urls = pickPlayableUrls(detail, true).filter(isPlayableMediaUrl);
      if (urls[0]) {
        const d = detail?.content || detail?.data || detail || {};
        const cover = normalizeUrl(
          d.liveCover || d.coverPath || d.cover || d.coverUrl || d.picPath || d.liveRoomCover || ''
        ) || media.cover;
        let isLive: boolean;
        if (attempts[i].label === 'replay') {
          isLive = false;
        } else if (attempts[i].label === 'live') {
          isLive = true;
        } else {
          const state = detailLiveState(detail);
          if (state === 'replay') isLive = false;
          else if (state === 'live') isLive = true;
          else {
            // 详情无明确状态位：rtmp/flv 视为直播；m3u8/mp4 一律按回放（录播可拖，防录播套直播控件）
            const u0 = String(urls[0] || '').toLowerCase();
            isLive = u0.startsWith('rtmp://') || u0.includes('.flv');
          }
        }
        /**
         * 电台直播（liveType=2）的轮播照片：官方客户端在电台时用成员照片轮播取代视频画面
         *（推流画面只有「成员离开」占位图）。详情已经在手上，顺手解析出来并写进缓存，
         * 播放器侧（usePlaybackCarousel）就不用再打一次 getLiveOne。
         */
        const carousel = parseLiveCarousel(detail);
        if (carousel.radio || carousel.photos.length) rememberLiveCarousel(liveId, detail);
        return {
          ...media,
          type: 'live',
          liveId,
          title,
          url: urls[0],
          cover,
          isLive,
          needsVlc: streamNeedsProxy(urls[0]),
          radio: carousel.radio || media.radio,
          carouselPhotos: carousel.photos.length ? carousel.photos : media.carouselPhotos,
          carouselIntervalMs: carousel.photos.length ? carousel.intervalMs : media.carouselIntervalMs,
        };
      }
    }
  }
  return { ...media, liveId, title, url: ownUrl, isLive: isLiveStreamUrl(ownUrl), needsVlc: streamNeedsProxy(ownUrl) };
}

/**
 * 解析直播地址 + 瞬时失败自动重试：首轮全部候选接口都拿不到地址、且是「快速失败」
 * （网络抖动/接口偶发 500，几秒内就结束）时，稍候 600ms 整轮重试一次。
 * 若首轮是慢超时（已等满 5s+）则不再重试——慢网重试无意义，避免把点击拖成 20s。
 */
export async function resolveRoomLiveMediaWithRetry(media: RoomMedia): Promise<RoomMedia> {
  const started = Date.now();
  const first = await resolveRoomLiveMedia(media);
  if (first.url) return first;
  if (Date.now() - started > 2500) return first;
  await new Promise((resolve) => setTimeout(resolve, 400));
  return resolveRoomLiveMedia(media);
}
