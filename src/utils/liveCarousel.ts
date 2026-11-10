/**
 * 电台直播「轮播照片」解析（纯规则，零 React / 零网络 / 零 i18n）。
 *
 * 背景（用户 2026-11-04：「直播里电台直播应该是有轮播的照片的，现在只显示成员离开」）：
 *   口袋的电台直播（`liveType = 2`）没有真正的视频画面，推流里那张「成员离开」只是占位图；
 *   官方客户端在播放器画面上叠的是**成员照片轮播**，数据就在 `getLiveOne` 的返回里：
 *
 *     content: {
 *       liveType: 2,                       // 1=视频直播 2=电台
 *       carousels: {
 *         carouselTime: '5000',            // 每张停留时长（毫秒，字符串）
 *         carousels: ['/2026/1104/xxx.jpg', ...]   // 相对路径，需拼 source.48.cn
 *       }
 *     }
 *
 *   实测（2026-11-04 getLiveOne）：`content.type` 仍是 1（不是电台判据！），
 *   必须用 `liveType` 判电台 —— 这一点容易写错，故在此钉死并附单测。
 *
 * 本模块只做「详情 → { photos, intervalMs, radio }」的纯转换：
 * 字段名、兜底顺序、单位换算都收口在这里，页面 / 播放器 / 房间不要再各写一份。
 */
import { normalizeUrl } from './pathPick';

export interface LiveCarousel {
  /** 轮播照片（已归一为 http(s) 绝对地址，去重、按接口顺序） */
  photos: string[];
  /** 每张停留时长（毫秒） */
  intervalMs: number;
  /** 是否电台直播（liveType=2）—— 决定「用照片轮播取代视频画面」 */
  radio: boolean;
}

/** 官方 `carouselTime` 缺失/非法时的默认间隔 */
export const DEFAULT_CAROUSEL_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 1200;
const MAX_INTERVAL_MS = 30000;

function contentOf(detail: any): any {
  return detail?.content || detail?.data || detail || {};
}

/** 轮播容器可能是 { carousels: [...] } / 数组 / { list|images: [...] } 三种形态 */
function carouselList(bag: any): any[] {
  if (Array.isArray(bag)) return bag;
  if (!bag || typeof bag !== 'object') return [];
  for (const key of ['carousels', 'carouselList', 'list', 'images', 'imageList', 'urls']) {
    const value = (bag as any)[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function photoUrl(item: any): string {
  const raw = typeof item === 'string'
    ? item
    : String(item?.url || item?.picPath || item?.path || item?.imageUrl || item?.imagePath || '');
  const url = normalizeUrl(raw);
  return /^https?:\/\//i.test(url) ? url : '';
}

function intervalOf(bag: any): number {
  const raw = bag?.carouselTime ?? bag?.time ?? bag?.interval ?? bag?.carouselInterval;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CAROUSEL_INTERVAL_MS;
  // 少数接口给秒（5 / 5.0），按「小于 60 视为秒」换算成毫秒
  const ms = n < 60 ? n * 1000 : n;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

/**
 * 详情 → 轮播信息。
 *
 * 判据：
 *   - `liveType === 2` → 电台（**首选**）
 *   - 没有 liveType 时才看 `type === 2`（老接口形态兜底）
 *   - 有轮播照片本身也说明是电台形态（照片轮播只在电台出现）
 */
export function parseLiveCarousel(detail: any): LiveCarousel {
  const d = contentOf(detail) || {};
  const bag = d.carousels ?? d.carousel ?? d.carouselInfo ?? null;
  const photos: string[] = [];
  for (const item of carouselList(bag)) {
    const url = photoUrl(item);
    if (url && !photos.includes(url)) photos.push(url);
  }
  const liveType = Number(d.liveType ?? d.live_type ?? NaN);
  const type = Number(d.type ?? NaN);
  const radio = liveType === 2 || (!Number.isFinite(liveType) && type === 2) || photos.length > 0;
  return { photos, intervalMs: intervalOf(bag), radio };
}

/** 详情里是否明确是电台（不看照片数量；用于「先切形态、照片随后到」的场景） */
export function isRadioLive(detail: any): boolean {
  const d = contentOf(detail) || {};
  const liveType = Number(d.liveType ?? d.live_type ?? NaN);
  if (Number.isFinite(liveType)) return liveType === 2;
  return Number(d.type ?? NaN) === 2;
}
