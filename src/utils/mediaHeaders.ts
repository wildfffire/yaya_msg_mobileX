/**
 * 口袋48 媒体防盗链请求头（**单一来源**）。
 *
 * ⚠️ 为什么必须共享一份而不是各写各的：CDN 会校验 UA / Referer / Origin，
 * 缺了任何一个都会被拒（表现因场景而异：视频放不出来、封面变白、**时长拿不到**）。
 * 这个坑在「房间语音时长」上刚踩过一次（2026-09-28）：
 *   播放器走 `playerSource()` 带了头 → 能播；
 *   而我新写的「取文件头算时长」用的是裸 `fetch` → 被 CDN 拒绝 → 时长永远拿不到。
 *
 * 所以任何**直接访问 48 媒体地址**的地方（播放、封面、下载、时长探测）都必须带这几个头。
 */
export const POCKET_MEDIA_HEADERS: Record<string, string> = {
  'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
  Referer: 'https://h5.48.cn/',
  Origin: 'https://h5.48.cn',
};

/**
 * 返回一份可安全修改的副本（播放器 source.headers 用）。
 *
 * 用户 2026-11-13：原来播放器侧另有一份 `streamResolver.buildPocketHeaders`，
 * 与本文件三个头逐字相同 —— 改 UA/Referer 时漏一处就是「视频放不出/时长拿不到」。
 * 现在只保留这一份，播放器层直接复用。
 */
export function buildPocketHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = { ...POCKET_MEDIA_HEADERS };
  if (cookie) headers.Cookie = cookie;
  return headers;
}
