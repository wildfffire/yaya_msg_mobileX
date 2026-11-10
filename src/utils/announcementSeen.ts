/**
 * 「同一公告只弹一次」的判据（纯函数，可单测）。
 *
 * 桌面端 announcement-feature.js 用「id 或内容指纹 hash」去重；移动端公告只拿到正文，
 * 所以指纹 = djb2(正文) 的 8 位十六进制。同一场次同一段文字 → 同一指纹；
 * 主持人改了公告内容 → 指纹变化 → 视为新公告，会再展开一次（符合预期）。
 */

export function announcementHash(text: unknown): string {
  const s = String(text || '');
  if (!s) return '';
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 去重键：场次 + 内容指纹（换场次即使正文相同也算新公告） */
export function announcementSeenKey(liveId: unknown, text: unknown): string {
  const id = String(liveId || '');
  const hash = announcementHash(text);
  if (!id || !hash) return '';
  return `${id}|${hash}`;
}

/** 记忆上限：超出就丢最早的一半（保留最近的，避免无限增长） */
export const ANNOUNCEMENT_SEEN_MAX = 200;

export function pushSeenKey(list: string[] | null | undefined, key: string, max = ANNOUNCEMENT_SEEN_MAX): string[] {
  const next = Array.isArray(list) ? list.slice() : [];
  if (!key) return next;
  const idx = next.indexOf(key);
  if (idx >= 0) next.splice(idx, 1);
  next.push(key);
  if (next.length > max) next.splice(0, next.length - max);
  return next;
}
