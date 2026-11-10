/**
 * 「昵称 / 标题 → 成员（含队伍）」的**唯一口径**（纯函数、零 React 依赖）。
 *
 * 为什么必须有这一层（用户 2026-09-30 连续反馈：「直播界面和录播能完美匹配成员名称与队伍，
 * 历史和稍后再看却经常出问题」）：
 *
 * 同一个页面里曾经并存**两套**反查：
 *   · 网格卡片：`teamOfItem(it) = memberById.get(it.userInfo.userId)?.team` —— 用**成员数字 id** 反查，
 *     与接口同源，几乎 100% 命中 → 所以直播页/录播页永远正确；
 *   · 写进播放历史的 `meta.team`：`memberByNickname.get(nickname.trim())?.team` ——
 *     用**昵称字符串精确相等**反查，只要昵称形态与成员库 `ownerName` 有半点差异
 *     （带团体前缀 / 带空格 / 是别称 / 该字段本次为空 / 成员库还没同步）就恒 miss。
 *
 * 于是出现「列表里看得见队伍徽章，播完进历史就没了」—— 这是同一份数据的两条链路口径不一致，
 * 不是接口的问题。这里把口径钉在一处：**任何地方要按人取队伍，都必须走 resolveTeam()**，
 * 且它内部「先 userId、后归一化昵称」，与卡片那条链路完全等价。
 *
 * 可被 `scripts/watch-enrich.sim.mjs` 直接编译单测（无 store / 无网络依赖）。
 */
import type { Member } from '../types';

/** 团体前缀（成员库 wbName / 部分接口昵称会带）：`SNH48-袁一琦` → `袁一琦` */
const GROUP_PREFIX_RE = /^(SNH48|GNZ48|BEJ48|CKG48|CGT48)\s*[-\s·:：]\s*/i;

/**
 * 名字归一：去团体前缀、去所有空白（含全角空格）、统一小写。
 * 两边都过这个函数再比较 —— 精确相等永远对不上的根因就是少了这一步。
 */
export function normMemberName(raw: unknown): string {
  return String(raw ?? '')
    .replace(GROUP_PREFIX_RE, '')
    .replace(/[\s\u3000]+/g, '')
    .trim()
    .toLowerCase();
}

/** 去掉团体前缀但保留可读空白（展示用：`SNH48-袁一琦` → `袁一琦`） */
export function displayMemberName(raw: unknown): string {
  return String(raw ?? '').replace(GROUP_PREFIX_RE, '').trim();
}

/**
 * 成员库里**哪些字段算「成员 id」** —— 全仓唯一实现。
 *
 * ⚠️ 以前各文件自己列一份（有的只认 `id`，有的认 `id/userId/memberId`，
 * 有的还认 `serverId/channelId`），口径漂移的表现是「同一个人在 A 页面认得出来、
 * 在 B 页面认不出来」。这里导出，`screens/room/messageRules` 的
 * `buildMemberIndex` / `buildMemberIdSet` 与所有反查都复用同一份。
 */
export function memberIdKeys(m: any): string[] {
  return [
    m?.id,
    m?.userId,
    m?.serverId,
    m?.channelId,
    m?.yklzId,
    m?.roomId,
    m?.liveRoomId,
    m?.account,
    m?.starId,
  ]
    .map((v) => String(v ?? '').trim())
    // 0 / '0' / 'undefined' 是「没有」的占位值，不能当 id 用（否则会把一堆人错配到同一个空 id 上）
    .filter((v) => v && v !== '0' && v !== 'undefined' && v !== 'null');
}

/** 成员库里的可反查名字（全名 / 去前缀短名 / 昵称 / 拼音） */
function memberNames(m: any): string[] {
  const full = String(m?.ownerName ?? '').trim();
  const nick = String(m?.nickname ?? m?.starName ?? m?.name ?? '').trim();
  const pinyin = String(m?.pinyin ?? '').trim();
  const out: string[] = [];
  for (const raw of [full, displayMemberName(full), nick, displayMemberName(nick)]) {
    const n = normMemberName(raw);
    if (n && !out.includes(n)) out.push(n);
  }
  // 「团体名 + 名字」拆出来的短名（`SNH48-袁一琦` → `袁一琦`）
  const dash = full.indexOf('-');
  if (dash > 0) {
    const n = normMemberName(full.slice(dash + 1));
    if (n && !out.includes(n)) out.push(n);
  }
  if (pinyin) {
    const p = pinyin.toLowerCase();
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export interface MemberLookup {
  /** id 域（userId / serverId / channelId / yklzId / account …）→ 成员 */
  byId: Map<string, Member>;
  /** 归一化名字域（全名 / 短名 / 昵称 / 拼音）→ 成员 */
  byName: Map<string, Member>;
  /** 按名字长度降序（标题反查用：长名优先，避免「张三」先命中「张三丰」） */
  byLength: Member[];
  size: number;
}

const EMPTY_LOOKUP: MemberLookup = { byId: new Map(), byName: new Map(), byLength: [], size: 0 };

/** 构建成员索引（调用方用 useMemo 缓存；成员库上千人，别每次渲染重建） */
export function buildMemberLookup(members: Member[] | undefined | null): MemberLookup {
  if (!Array.isArray(members) || members.length === 0) return EMPTY_LOOKUP;
  const byId = new Map<string, Member>();
  const byName = new Map<string, Member>();
  for (const m of members) {
    if (!m) continue;
    for (const id of memberIdKeys(m)) if (!byId.has(id)) byId.set(id, m);
    for (const name of memberNames(m)) if (!byName.has(name)) byName.set(name, m);
  }
  const byLength = [...members]
    .filter(Boolean)
    .sort((a, b) => String(b.ownerName ?? '').length - String(a.ownerName ?? '').length);
  return { byId, byName, byLength, size: members.length };
}

export interface MemberHint {
  /** 官方条目的成员数字 id（`userInfo.userId` / `userId` / `ownerId` …），最可靠 */
  userId?: unknown;
  /** 昵称（可能带团体前缀、可能是别称、可能为空） */
  name?: unknown;
}

/**
 * 按「id 优先、昵称兜底」反查成员。
 *
 * 顺序与直播页卡片的 `teamOfItem` 完全一致 —— 这就是「同一场内容在直播页有队伍、
 * 在历史里没有」的根治点：以前写历史那条链路只做了第二步（而且没有归一）。
 */
export function findMemberByHint(lookup: MemberLookup, hint: MemberHint): Member | null {
  if (!lookup || lookup.size === 0) return null;
  for (const id of memberIdKeys({ id: hint?.userId })) {
    const hit = lookup.byId.get(id);
    if (hit) return hit;
  }
  const n = normMemberName(hint?.name);
  if (!n) return null;
  return lookup.byName.get(n) || null;
}

/**
 * 取队伍（**全仓唯一入口**）。
 *
 * 三级：① 条目自己带的队伍字段（不依赖本地成员库，最省事）；
 *      ② userId → 成员库；③ 归一化昵称 → 成员库。
 * 拿不到就返回 ''（宁可没有徽章，也不给错的队伍色）。
 */
export function resolveTeam(
  lookup: MemberLookup,
  hint: MemberHint,
  teamFromDetail?: unknown,
): string {
  const direct = String(teamFromDetail ?? '').trim();
  if (direct) return direct;
  const m = findMemberByHint(lookup, hint);
  return m ? String(m.team ?? '').trim() : '';
}

/**
 * 标题反查成员（历史/稍后再看的旧记录只有标题时用）。
 *
 * ⚠️ 选人规则：**出现位置最靠前**优先，位置相同则**名字更长**优先。
 * 以前只按「名字长度降序取第一个命中」：公演类标题（`XX 公演 袁一琦 王奕 …`）里
 * 排在后面的长名会抢在前面的短名前面命中 → 成员名与队伍直接配错人
 * （用户反馈「成员名称、队伍匹配经常出问题」的另一半来源）。
 */
export function matchMemberByTitle(title: unknown, lookup: MemberLookup): Member | null {
  const text = normMemberName(title);
  if (!text || !lookup || lookup.size === 0) return null;
  let best: Member | null = null;
  let bestAt = Number.MAX_SAFE_INTEGER;
  let bestLen = -1;
  for (const m of lookup.byLength) {
    const full = normMemberName(m?.ownerName);
    if (!full || full.length < 2) continue;
    const at = text.indexOf(full);
    const short = normMemberName(displayMemberName(m?.ownerName));
    const atShort = short && short !== full ? text.indexOf(short) : -1;
    const hit = at >= 0 ? at : atShort;
    const used = at >= 0 ? full : atShort >= 0 ? short : '';
    if (hit < 0 || !used) continue;
    const len = used.length;
    if (hit < bestAt || (hit === bestAt && len > bestLen)) {
      best = m;
      bestAt = hit;
      bestLen = len;
    }
  }
  return best;
}

/** 从任意接口条目里挖出「成员数字 id」（字段口径与直播页卡片保持一致） */
export function pickMemberUserId(raw: any): string {
  if (!raw || typeof raw !== 'object') return '';
  const paths = [
    'userInfo.userId',
    'userInfo.id',
    'user.userId',
    'user.id',
    'memberInfo.userId',
    'memberInfo.id',
    'userId',
    'ownerId',
    'memberId',
    'hostId',
    'uid',
  ];
  for (const p of paths) {
    const v = p.split('.').reduce((acc: any, k) => (acc == null ? undefined : acc[k]), raw);
    const s = String(v ?? '').trim();
    if (s && s !== '0' && s !== 'undefined') return s;
  }
  return '';
}

/** 从任意接口条目里挖出昵称（字段口径与 MediaScreen.normalizeLiveList 保持一致） */
export function pickMemberNickname(raw: any): string {
  if (!raw || typeof raw !== 'object') return '';
  const paths = [
    'nickname',
    'nickName',
    'userInfo.nickname',
    'userInfo.nickName',
    'userInfo.starName',
    'user.nickname',
    'user.nickName',
    'memberInfo.nickname',
    'memberInfo.nickName',
    'starName',
    'ownerName',
    'name',
  ];
  for (const p of paths) {
    const v = p.split('.').reduce((acc: any, k) => (acc == null ? undefined : acc[k]), raw);
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}
