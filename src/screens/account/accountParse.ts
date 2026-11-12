/**
 * 账号中心纯解析规则（零依赖 → 可进纯 Node 单测）。
 * 从旧 LoginScreen 原样迁移，并补上角色标记与头像解析给新页面的账号状态卡使用。
 */

export const BILI_COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

/** 从一段 search/hash 裸参数字符串里提取 B站 cookie（仅用 URLSearchParams，不依赖 Hermes 的 new URL） */
export function biliCookiesFromSearch(search = ''): string {
  try {
    const params = new URLSearchParams(search);
    return BILI_COOKIE_KEYS
      .map((key) => {
        const value = params.get(key);
        return value ? `${key}=${value}` : '';
      })
      .filter(Boolean)
      .join('; ');
  } catch {
    return '';
  }
}

/**
 * 从扫码确认回调 url/参数串提取 B站 cookie，兼容几种 B站实测/历史形态：
 *  1) 完整 crossDomain URL：query 里带 cookie
 *  2) hash 里带参数：.../#SESSDATA=..&bili_jct=..
 *  3) 整个 URL 被 encodeURIComponent 嵌了一层
 *  4) 裸 key=value 串（无协议无路径）
 */
export function buildBilibiliCookieFromUrl(rawUrl = ''): string {
  const extract = (source: string): string => {
    let search = source;
    const q = source.indexOf('?');
    if (q >= 0) search = source.slice(q + 1);
    const parts = search.split('#');
    let query = parts[0] || '';
    const hash = parts.length > 1 ? parts[1] : '';
    if (hash) query = query ? `${query}&${hash}` : hash;
    return biliCookiesFromSearch(query);
  };

  let cookie = extract(rawUrl);
  if (cookie.includes('SESSDATA')) return cookie;

  try {
    const decoded = decodeURIComponent(rawUrl);
    if (decoded !== rawUrl && decoded.includes('SESSDATA')) {
      const nested = extract(decoded);
      if (nested.includes('SESSDATA')) return nested;
    }
  } catch {
    /* 非法编码串，忽略 */
  }
  return cookie;
}

/** 从原生模块返回的 "k=v; k=v"（Set-Cookie 头拼串）里挑出 B站 常用键 */
export function pickBiliCookies(raw = ''): string {
  const parts = String(raw)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  return BILI_COOKIE_KEYS
    .map((key) => parts.find((p) => p.startsWith(`${key}=`)) || '')
    .filter(Boolean)
    .join('; ');
}

/** Token 掩码：只显示首 6 + 尾 4 字符，避免完整 Token 常驻屏幕 */
export function maskToken(token: string): string {
  const value = String(token || '');
  if (value.length <= 12) return value.slice(0, 4) + '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/**
 * 状态文案的语义色调（纯函数 → 可进纯 Node 单测）。
 * 账号页所有操作结果（登录/切换/改名/签到/B站）都走它决定提示条图标与颜色，
 * 取代旧页面里散落的「12px 灰字」与登录面板那段一次性正则。
 *
 * 判定顺序有意「先危险后成功」：像「切换失败但已恢复到主号」这种含混文案
 * 必须按失败展示，宁可保守也不要把错误染成绿色。
 */
export type StatusTone = 'success' | 'danger' | 'info';

const STATUS_DANGER_RE = /(失败|无效|错误|异常|超时|过期|未登录|没有拿到|没有返回|取消|请输入|请先|不允许|拒绝|无法)/;
const STATUS_SUCCESS_RE = /(成功|已保存|已更新|已复制|已切换|已注销|已发送|已刷新|Token有效|登录成功|签到成功)/;

export function statusTone(text: string): StatusTone {
  const value = String(text || '').trim();
  if (!value) return 'info';
  if (STATUS_DANGER_RE.test(value)) return 'danger';
  if (STATUS_SUCCESS_RE.test(value)) return 'success';
  return 'info';
}

export function extractPocketToken(value: any): string {
  const seen = new Set<any>();
  const walk = (node: any): string => {
    if (!node || typeof node !== 'object' || seen.has(node)) return '';
    seen.add(node);
    const direct = [
      node.token,
      node.accessToken,
      node.access_token,
      node.p48Token,
      node.sessionToken,
      node?.userInfo?.token,
      node?.userInfo?.accessToken,
      node?.content?.token,
      node?.content?.accessToken,
      node?.content?.userInfo?.token,
      node?.data?.token,
      node?.data?.accessToken,
    ].find((item) => typeof item === 'string' && item.trim().length > 10);
    if (direct) return direct.trim();
    for (const item of Object.values(node)) {
      const found = walk(item);
      if (found) return found;
    }
    return '';
  };
  return walk(value);
}

export function accountId(user: any): string {
  return String(user?.userId || user?.id || user?.userInfo?.userId || user?.userInfo?.id || '');
}

export function accountName(user: any, fallback = '未命名账号'): string {
  return String(
    user?.nickname || user?.nickName || user?.name ||
    user?.userInfo?.nickname || user?.userInfo?.nickName || user?.userInfo?.name ||
    (user?.baseUserInfo?.nickname || user?.baseUserInfo?.nickName || user?.baseUserInfo?.name) ||
    fallback,
  );
}

export function accountRole(user: any, fallback = '账号'): string {
  return String(user?.roleName || user?.typeName || user?.accountType || user?.userInfo?.roleName || fallback);
}

/** 头像字段归一：相对路径补 source.48.cn 域名，绝对地址原样返回 */
export function avatarUrl(raw: unknown): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://source.48.cn${value.startsWith('/') ? '' : '/'}${value}`;
}

/** 账号头像：接口常给相对路径，补 source.48.cn 域名 */
export function accountAvatar(user: any): string {
  const base = user?.baseUserInfo || user?.userInfo || user || {};
  return avatarUrl(base.avatar || base.headImg || base.faceImage || base.avatarUrl || '');
}

export interface AccountInfo {
  current: any;
  users: any[];
}

/**
 * `loginCheckToken` 响应 → 当前账号 + 大小号列表。
 * 与旧版一致：大号在前、按 userId 去重、当前账号排最前；额外给每行标 `__isMain` 供 UI 显示主号/小号。
 */
export function parseAccountInfo(res: any): AccountInfo {
  const content = res?.content || res?.data || res || {};
  const current = content.userInfo || content.user || content;
  const bigSmallInfo = content.bigSmallInfo || content.bigSmall || content.userInfo?.bigSmallInfo || {};
  const bigUsers = [
    bigSmallInfo.bigUserInfo,
    bigSmallInfo.bigUser,
    bigSmallInfo.ownerUserInfo,
  ].filter(Boolean).map((user: any) => ({ ...user, __isMain: true }));
  const smallUsers = [
    ...(Array.isArray(bigSmallInfo.smallUserInfo) ? bigSmallInfo.smallUserInfo : []),
    ...(Array.isArray(bigSmallInfo.smallUserList) ? bigSmallInfo.smallUserList : []),
    ...(Array.isArray(bigSmallInfo.smallUsers) ? bigSmallInfo.smallUsers : []),
  ].map((user: any) => ({ ...user, __isMain: false }));
  const users = [...bigUsers, ...smallUsers].filter((user, index, list) => {
    const id = accountId(user);
    return id && list.findIndex((item) => accountId(item) === id) === index;
  });
  const currentId = accountId(current);
  if (currentId) {
    const idx = users.findIndex((u) => accountId(u) === currentId);
    if (idx > 0) {
      const [cur] = users.splice(idx, 1);
      users.unshift(cur);
    }
  }
  return { current, users };
}
