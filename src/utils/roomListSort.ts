/**
 * 房间列表排序规则（纯函数，零 React 依赖 —— 可进 Node 单测）
 *
 * 用户 2026-11-09：「房间列表新消息在上的功能加个开关，关掉的话可以自定义房间列表排序，
 * 分为自定义、按队伍和按字母」。
 *
 * 分组口径（不可变）：
 *   rank 0 = 置顶（永远最前，与开关无关）
 *   rank 1 = 有新消息（仅当 unreadFirst 打开）
 *   rank 2 = 其余
 * 组内再按所选模式（自定义 / 按队伍 / 按字母）排；最后用原始下标兜底保证稳定。
 *
 * ⚠️ 性能纪律：rank / 排序键**必须在这里一次预计算**。
 *   绝不能在比较器里调 `hasUnread`（O(N log N) 次查表 → 退房回列表时肉眼可见卡顿，
 *   历史 bug 见 FollowedRoomsScreen 里 `filtered` 的注释）。
 */

export type RoomSortMode = 'custom' | 'team' | 'alpha';

export interface RoomSortEntry {
  memberId: string;
  member?: any;
}

export interface RoomSortOptions {
  /** 唯一未读判据（由页面传入 roomHasUnread，保证角标与上浮同源） */
  hasUnread: (item: any) => boolean;
  /** 置顶成员 id（永远 rank 0） */
  pinnedIds: string[];
  /** 「新消息在上」开关 */
  unreadFirst: boolean;
  /** 组内排序方式 */
  mode: RoomSortMode;
  /** 自定义顺序（memberId 数组）；未列出的排在已列出的后面，保持原序 */
  customOrder: string[];
}

/** 队伍展示顺序（与主题色里的队伍预设一致，按团队归属） */
export const TEAM_SORT_ORDER = [
  'SII',
  'NII',
  'HII',
  'X',
  'G',
  'NIII',
  'Z',
  'B',
  'E',
  'J',
  'C',
  'K',
  'CII',
  'GII',
  'IDFT',
  '预备生',
  '荣誉毕业生',
  '海外练习生',
] as const;

/** 归一化队名：'TEAM SII' / 'team sii' / 'SII' → 'SII' */
export function normalizeTeamName(team: unknown): string {
  return String(team ?? '')
    .trim()
    .replace(/^team\s+/i, '')
    .toUpperCase();
}

/** 队伍排序号（未知队伍排最后，保持彼此原序） */
export function teamRank(team: unknown): number {
  const key = normalizeTeamName(team);
  if (!key) return TEAM_SORT_ORDER.length;
  const idx = (TEAM_SORT_ORDER as readonly string[]).indexOf(key);
  return idx >= 0 ? idx : TEAM_SORT_ORDER.length;
}

/** 字母序键：优先成员库的 pinyin，其次昵称 */
export function alphaKey(item: RoomSortEntry): string {
  const member = item.member || {};
  const pinyin = typeof member.pinyin === 'string' ? member.pinyin.trim() : '';
  if (pinyin) return pinyin.toLowerCase();
  return String(member.ownerName || '').trim().toLowerCase();
}

/**
 * 稳定排序（不改入参）。
 * @returns 排好序的新数组
 */
export function sortRooms<T extends RoomSortEntry>(list: T[], opts: RoomSortOptions): T[] {
  const pinned = new Set((opts.pinnedIds || []).map(String));
  const orderIndex = new Map<string, number>();
  (opts.customOrder || []).forEach((id, i) => {
    if (!orderIndex.has(String(id))) orderIndex.set(String(id), i);
  });
  const customTail = orderIndex.size;

  const rows = list.map((item, index) => {
    const id = String(item.memberId || item.member?.id || '');
    const rank = pinned.has(id) ? 0 : opts.unreadFirst && opts.hasUnread(item) ? 1 : 2;
    // 组内排序键：自定义 = 序号，队伍 = 队序号，字母 = 字符串
    const pos =
      opts.mode === 'custom'
        ? orderIndex.has(id)
          ? (orderIndex.get(id) as number)
          : customTail + index
        : opts.mode === 'team'
          ? teamRank(item.member?.team)
          : 0;
    return { item, index, id, rank, pos, key: opts.mode === 'alpha' ? alphaKey(item) : '' };
  });

  rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (opts.mode === 'alpha') {
      // Hermes / JSC 对中文 localeCompare 支持不一，用 try 兜底到码位比较（至少是稳定全序）
      let cmp = 0;
      try {
        cmp = a.key.localeCompare(b.key, 'zh-Hans-CN');
      } catch {
        cmp = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      }
      if (cmp !== 0) return cmp;
    } else if (a.pos !== b.pos) {
      return a.pos - b.pos;
    }
    return a.index - b.index;
  });

  return rows.map((r) => r.item);
}
