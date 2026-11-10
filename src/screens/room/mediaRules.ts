/**
 * 房间消息里的「媒体识别」纯规则。
 *
 * 为什么单独成文件：
 *  `FollowedRoomsScreen.tsx` 已经膨胀到 5000+ 行，其中**一大半是模块级的纯函数**
 *  （不碰 React、不碰状态，只做字符串/对象判断）。把它们搬出来是「拆分房间页」的**第一步**，
 *  因为这一步：
 *   ① **零行为风险** —— 只是把函数换个位置，逐字搬运，不改一行逻辑；
 *   ② **立刻可测** —— 纯函数可以在纯 Node 里跑单元测试（见 `scripts/room-media-rules.test.mjs`），
 *      而这一步正是后面「抽展示组件」所需要的那张安全网；
 *   ③ 让巨型文件变小，后续拆分更容易看清边界。
 *
 * ⚠️ 搬运时**刻意保持行为一致**：`mediaLabel` 的中文标签原本就没走 i18n
 *    （用户 2026-09-28 已明确「外语问题不再处理」），所以这里**不顺手改成 `t(...)`** ——
 *    避免把「搬家」变成「改行为」。
 */

export type MediaType = 'audio' | 'video' | 'live' | 'image' | 'link';

export type RoomMedia = {
  type: MediaType;
  url: string;
  title: string;
  duration?: string;
  liveId?: string;
  isLive?: boolean;
  needsVlc?: boolean;
  cover?: string;
  /** 消息/卡片已明示「回放/录播」：播放时应走可拖进度条的录播播放器，而非直播播放器 */
  replayHint?: boolean;
  /**
   * 电台直播（`liveType = 2`）：官方推流画面只有「成员离开」占位图，
   * 播放器应改用成员照片轮播（`getLiveOne → content.carousels`）。
   */
  radio?: boolean;
  /** 电台轮播照片（解析详情顺手带出） */
  carouselPhotos?: string[];
  /** 轮播间隔（毫秒） */
  carouselIntervalMs?: number;
};

/** 流地址优先级打分：数字越大越优先（用于在多个候选地址里挑最合适的那个） */
export function streamScore(url: string, preferLive = false): number {
  const lower = url.toLowerCase();
  if (preferLive && lower.startsWith('rtmp://')) return 130;
  if (lower.includes('.m3u8') || lower.includes('format=hls')) return preferLive ? 100 : 90;
  if (lower.includes('.flv')) return preferLive ? 110 : 70;
  if (lower.startsWith('rtmp://')) return 60;
  if (/\.(mp4|mov)(\?|$)/i.test(lower)) return 80;
  if (/\.(mp3|m4a|aac|amr|wav)(\?|$)/i.test(lower)) return 80;
  return 40;
}

/** 从任意文本/对象里抠出 liveId（查 URL 参数、JSON 字段、路径片段三种形态） */
export function extractLiveIdFromText(value: any): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {}
  const text = `${raw} ${decoded}`;
  return String(
    text.match(/[?&](?:liveId|liveid|live_id)=([0-9]+)/i)?.[1]
    || text.match(/[?&](?:id|live)=([0-9]{5,})/i)?.[1]
    || text.match(/(?:liveId|liveid|live_id)["'\s:=]+([0-9]+)/i)?.[1]
    || text.match(/\/(?:live|playback|record|replay)\/([0-9]+)/i)?.[1]
    || '',
  );
}

/** 这个地址看起来能不能播（各平台/各形态的宽松判断） */
export function isPlayableMediaUrl(url: string) {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://')
    || lower.includes('.m3u8')
    || lower.includes('.flv')
    || /\.(mp4|mov|m4v|3gp|mp3|m4a|aac|amr|wav)(\?|$)/i.test(lower)
    || lower.includes('playstream')
    || lower.includes('stream');
}

/** 需要走代理才能播的地址（rtmp / flv） */
export function streamNeedsProxy(url: string): boolean {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://') || lower.includes('.flv');
}

/** 是否直播流形态（rtmp / flv / m3u8） */
export function isLiveStreamUrl(url: string): boolean {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://') || lower.includes('.flv') || lower.includes('.m3u8');
}

/**
 * 房间点击判「是否录播（可拖进度 vod）」。事实：
 * - 房间消息条目（roomMedia）同步构建、不带 isLive 标记；回放地址常见 HLS(.m3u8)/FLV 形态，
 *   若把 .m3u8 一律当直播流，消息里的录播卡就全部套上直播播放器（无进度条）——本 bug 根因。
 * - rtmp/flv 推流只可能是直播；消息明示回放(replayHint)即使 rtmp/flv 也按录播。
 * - m3u8/mp4 二义：仅当明确带 isLive 标记（直播列表 record:false 命中 / 详情状态位）才直播，否则录播。
 */
export function roomTapIsVod(next: RoomMedia): boolean {
  if (next.replayHint) return true;
  const u = String(next.url || '').toLowerCase();
  if (u.startsWith('rtmp://') || u.includes('.flv')) return false;
  return !next.isLive;
}

/** 由 URL / 消息类型 / 文本判断媒体类型（扩展名优先，其次关键字） */
export function classifyMedia(url: string, msgType: string, text: string): MediaType {
  const lower = `${url} ${msgType} ${text}`.toLowerCase();
  // 先按明确扩展名判定（最高优先级）：避免 url 里含 "live" 字样的普通 .mp4/.m3u8 视频被误判成直播。
  if (/\.(mp4|mov|m4v|3gp)(\?|$)/i.test(url)) return 'video';
  if (/\.(m3u8|flv|ts)(\?|$)/i.test(url) || lower.startsWith('rtmp://')) return 'live';
  if (/\.(mp3|m4a|aac|amr|wav)(\?|$)/i.test(url)) return 'audio';
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url) || lower.includes('image') || lower.includes('expressimage')) return 'image';
  // 扩展名兜底后再按关键字判定（live/playback/record/replay 等无扩展名场景）
  if (lower.includes('live') || lower.includes('playback') || lower.includes('record') || lower.includes('replay')) return 'live';
  if (lower.includes('voice') || lower.includes('audio')) return 'audio';
  if (lower.includes('video')) return 'video';
  return 'link';
}

/** 媒体类型的中文短标签（未走 i18n，与原实现逐字一致） */
export function mediaLabel(type: MediaType) {
  if (type === 'audio') return '\u8bed\u97f3';
  if (type === 'video') return '\u89c6\u9891';
  if (type === 'live') return '\u76f4\u64ad';
  if (type === 'image') return '\u56fe\u7247';
  return '\u94fe\u63a5';
}
