/**
 * 48 图床防盗链：图片请求必须带官方 UA + Referer。
 *
 * ══ 为什么要有这个文件（2026-11-02 用户反馈「有的照片在房间里显示不出来，但是可以保存」）══
 * 下载（services/downloads.ts）一直带着
 *   `User-Agent: PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)` + `Referer: https://h5.48.cn/`
 * 所以「保存图片」每次都成功；而 RN 的 <Image> 走 OkHttp 默认 UA（okhttp/x.y）且**不带 Referer**，
 * 部分资源会被 source.48.cn / source1.48.cn 直接拒（403/415）→ 同一张图「能存不能看」。
 *
 * 实测对照（真机 logcat + curl 复现）：
 *   · 无 Referer + okhttp UA → 403 / 415；
 *   · 带 Referer + 官方 UA → 200 image/jpeg。
 *
 * 因此：**凡是 48 系域名的图片，source 里都要带上这两个头**。
 * 非 48 域名（B站、GitHub、第三方图床）原样返回，避免把 Referer 发给别人的服务器。
 */

/** 官方客户端 UA（与下载链路保持一致，别再各写一份） */
export const POCKET_IMAGE_UA = 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)';
export const POCKET_IMAGE_REFERER = 'https://h5.48.cn/';

export const POCKET_IMAGE_HEADERS: Record<string, string> = {
  'User-Agent': POCKET_IMAGE_UA,
  Referer: POCKET_IMAGE_REFERER,
};

/** 48 系图床（source/source1..9/former/others.48.cn…） */
const POCKET_IMAGE_HOST_RE = /^https?:\/\/[^/?#]*\b48\.cn([/?#]|$)/i;

export function isPocketImageUrl(url: any): boolean {
  return POCKET_IMAGE_HOST_RE.test(String(url || '').trim());
}

/**
 * 给 48 图床 URL 补上防盗链请求头；其它域名原样返回。
 * 返回可直接塞进 `<Image source={...}>` 的对象。
 */
export function pocketImageSource(url: string, extra?: Record<string, any>) {
  const uri = String(url || '');
  if (!isPocketImageUrl(uri)) return { uri, ...(extra || {}) };
  return { uri, headers: POCKET_IMAGE_HEADERS, ...(extra || {}) };
}
