/**
 * 深链解析（纯函数，可单测）。用户 2026-11-09 要求支持 `yayamsg://`。
 *
 * 支持的形式（host 与 path 两种写法都认，方便二维码/通知自带 uri）：
 *   yayamsg://member/12345          → 成员主页
 *   yayamsg:///member/12345         → 同上
 *   yayamsg://room/12345            → 进该成员的房间（大房间）
 *   yayamsg://video/1234567890123   → 播放该场次（直播/回放，按 Media 页现有深链逻辑）
 *   yayamsg://invoice               → 电子发票
 *   yayamsg://update                → 打开发新版本的下载页（系统更新通知点按用）
 *   yayamsg://checkupdate           → 强制检查更新并弹「发现新版本」（复测通知用）
 *
 * ⚠️ id 一律按**字符串**处理：liveId/channelId 都是长数字，转 Number 会丢精度
 *   （与 Seine 排期 liveId 那个坑同源，见 utils/network 的 parseJsonExact）。
 */
export type DeepLinkTarget =
  | { type: 'member'; id: string }
  | { type: 'room'; id: string }
  | { type: 'pm'; id: string; name?: string }
  | { type: 'video'; id: string; title?: string }
  | { type: 'invoice' }
  | { type: 'update' }
  /** demo=true：不依赖线上 Release，直接模拟一次新版本提醒（真机复测通知用） */
  | { type: 'checkupdate'; demo: boolean }
  | null;

export const DEEP_LINK_SCHEME = 'yayamsg';

export function parseDeepLink(url: unknown): DeepLinkTarget {
  const raw = String(url || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const prefix = `${DEEP_LINK_SCHEME}://`;
  if (!lower.startsWith(prefix)) return null;
  let rest = raw.slice(prefix.length);
  // 去掉查询串/锚点（title 单独解析）
  const queryIndex = rest.search(/[?#]/);
  const query = queryIndex >= 0 ? rest.slice(queryIndex + 1) : '';
  if (queryIndex >= 0) rest = rest.slice(0, queryIndex);
  rest = rest.replace(/^\/+/, '');
  const [headRaw, ...tail] = rest.split('/');
  const head = String(headRaw || '').toLowerCase();
  const id = String(tail[0] || '').trim();
  const params = new Map<string, string>();
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    params.set(part.slice(0, eq).toLowerCase(), decodeURIComponent(part.slice(eq + 1)));
  }
  const validId = /^\d{1,32}$/.test(id) && id !== '0';
  if (head === 'member') return validId ? { type: 'member', id } : null;
  if (head === 'room') return validId ? { type: 'room', id } : null;
  // 私信通知点开 → 直接进该会话（name 可选，用于顶栏标题占位）
  if (head === 'pm') return validId ? { type: 'pm', id, name: params.get('name') || '' } : null;
  if (head === 'video') return validId ? { type: 'video', id, title: params.get('title') || '' } : null;
  if (head === 'invoice') return { type: 'invoice' };
  // 新版本通知：点按直接去下载页（不需要 id）
  if (head === 'update') return { type: 'update' };
  // 强制检查更新（复测用）：adb / 二维码触发，绕过限流与去重
  if (head === 'checkupdate') return { type: 'checkupdate', demo: params.get('demo') === '1' };
  return null;
}

/** 生成深链（分享/通知用，与 parseDeepLink 互为逆运算） */
export function buildDeepLink(target: Exclude<DeepLinkTarget, null>, params?: Record<string, string>): string {
  const base = `${DEEP_LINK_SCHEME}://`;
  if (target.type === 'invoice') return `${base}invoice`;
  if (target.type === 'update') return `${base}update`;
  if (target.type === 'checkupdate') return `${base}checkupdate${target.demo ? '?demo=1' : ''}`;
  const tail = target.type === 'video' && target.title
    ? `?title=${encodeURIComponent(target.title)}`
    : target.type === 'pm' && target.name
      ? `?name=${encodeURIComponent(target.name)}`
      : '';
  return `${base}${target.type}/${target.id}${tail}`;
}
