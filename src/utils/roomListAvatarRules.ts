/**
 * 房间列表头像（偶像自己给房间设置的那张图标）—— 纯规则层。
 *
 * 为什么单独一层：头像来源一旦取错**不会报错**，只会「看起来都对、其实全是公式照」。
 * 这里把「取哪个字段」「缓存是否还新鲜」「磁盘回读怎么清洗」钉成纯函数，
 * 好让 `scripts/room-list-avatar-rules.test.mjs` 在纯 Node 里锁住。
 *
 * ⚠️ 三套图必须分清（用户 2026-11-09 明确）：
 *   ① 公式照：成员库 `avatar` / 档案接口 `starAvatar`（zp_xxx.jpg）
 *   ② 房间内消息头像：房间消息 `ext.user.avatar`（她发言时带的账号头像）
 *   ③ 房间列表头像：chat server 的 `serverIcon`（偶像自己在口袋里给房间换的图标）
 * 房间列表只能取 ③，既不能从 ①，也不能从 ②（房间消息）里提取。
 *
 * 上游同口径（yk1z/yaya_msg `src/renderer/followed-chat-feature.js`
 * `updateFollowedChatAvatarFromDetail`）：`detail.chatServerInfo.serverIcon`。
 * 注意同一对象里还有 `serverDefaultIcon`（系统默认图）——那是兜底图，**不是自选**。
 */
import { normalizeUrl } from './pathPick';

/** 房间图标的缓存有效期：偶像换头像后最多 3 天在列表里生效（过期后先显示旧图并在后台刷新） */
export const ROOM_AVATAR_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export type RoomAvatarEntry = {
  /** 自选图标 URL；空串表示「拉过、但该房间没有自选图标」（同样要缓存，避免每次进列表重打接口） */
  url: string;
  /** 拉取时间（ms） */
  at: number;
};

/**
 * 把接口给的图标路径补成可用的 http 地址（`/xxx.jpg` → https://source.48.cn/xxx.jpg）。
 * 口径对齐上游 `normalizeFollowedSourceUrl`：绝对地址原样、`//` 补 https、`xxx.48.cn/path` 补 https。
 */
export function normalizeRoomAvatarUrl(raw: any): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (/48\.cn/i.test(value)) return `https://${value.replace(/^\/+/, '')}`;
  const direct = normalizeUrl(value);
  return /^https?:\/\//i.test(direct) ? direct : '';
}

/**
 * 从 `im/api/seine/server/detail` 的 content 里取「偶像自选」房间头像。
 *
 * 只认 `chatServerInfo.serverIcon`：
 *   - `serverIcon` = 当前图标（偶像换过就是她换的那张）
 *   - `serverDefaultIcon` = 系统默认图标（≈公式照），取它等于没修
 */
export function pickRoomAvatarFromDetail(content: any): string {
  const info = content?.chatServerInfo || content?.chatServer || {};
  return normalizeRoomAvatarUrl(info?.serverIcon || '');
}

/** 缓存条目是否还在有效期内（url 为空也算「新鲜的空结果」，不要反复请求） */
export function roomAvatarFresh(entry: RoomAvatarEntry | null | undefined, now = Date.now()): boolean {
  if (!entry) return false;
  const at = Number(entry.at);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at < ROOM_AVATAR_TTL_MS;
}

/** 磁盘回读清洗：坏数据直接丢，绝不让脏 URL 进渲染层 */
export function parseRoomAvatarMap(raw: any): Record<string, RoomAvatarEntry> {
  let source = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      source = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const clean: Record<string, RoomAvatarEntry> = {};
  Object.keys(source).forEach((key) => {
    const id = String(key || '').trim();
    const value = source[key];
    if (!id || !value || typeof value !== 'object') return;
    const at = Number(value.at);
    if (!Number.isFinite(at) || at <= 0) return;
    const url = normalizeRoomAvatarUrl(value.url || '');
    // 非空但不是 http 的一律按「没有自选图标」处理
    clean[id] = { url, at };
  });
  return clean;
}

/** 超出上限时按写入时间丢最旧的（而不是依赖对象键序） */
export function trimRoomAvatarMap(
  map: Record<string, RoomAvatarEntry>,
  max = 500,
): Record<string, RoomAvatarEntry> {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const kept = keys
    .sort((a, b) => Number(map[a]?.at || 0) - Number(map[b]?.at || 0))
    .slice(keys.length - max);
  const next: Record<string, RoomAvatarEntry> = {};
  kept.forEach((key) => { next[key] = map[key]; });
  return next;
}
