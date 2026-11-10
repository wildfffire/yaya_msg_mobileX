/**
 * 「直播中」索引的**等价比较**（无 React / 无 i18n / 无网络依赖 → 可被 scripts 编译单测）。
 *
 * 为什么单独成文件：`roomIdentity.ts` 顶部 `import { t } from '../../i18n'`（i18n 又依赖
 * react 与 store），被 `scripts/*.test.mjs` 编译后在纯 Node 里 require 会直接崩；
 * 而 `sameLiveIndex` 是「房间列表 30s 卡一下」的关键判据，必须能进测试。
 */
/** 「直播中」索引里每个直播的可跳转信息（用于「点头像直接进她的直播」） */
export interface LiveEntry {
  liveId: string;
  title: string;
  cover: string;
}

export interface LiveNowIndex {
  ids: Set<string>;
  names: Set<string>;
  /** 多键索引：主播 userId / liveRoomId / account / 去前缀小写昵称 → 直播信息 */
  byOwner: Record<string, LiveEntry>;
}

/**
 * 从 `getLiveList` 结果构建「直播中」索引。
 * 三个字段各自有用途：
 *   - ids / names：判断某个关注成员是否在直播（原逻辑）
 *   - byOwner：拿到 liveId/title/cover，支持「点头像直接进她的直播」
 */
export function buildLiveIndex(liveItems: any[]): LiveNowIndex {
  const ids = new Set<string>();
  const names = new Set<string>();
  const byOwner: Record<string, LiveEntry> = {};
  for (const it of liveItems) {
    const owner = String(it.userId || it.ownerId || it.memberId || it.userInfo?.userId || it.userInfo?.id || it.user?.userId || it.owner?.userId || it.memberInfo?.userId || it.hostId || it.account || '');
    const lr = String(it.liveRoomId || it.roomId || '');
    const nick = String(it.nickname || it.nickName || it.userInfo?.nickname || it.userInfo?.starName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/i, '').trim().toLowerCase();
    if (owner) ids.add(owner);
    if (lr) ids.add(lr);
    if (nick) names.add(nick);
    const liveId = String(it.liveId || it.id || '');
    if (!liveId) continue;
    const entry: LiveEntry = {
      liveId,
      title: String(it.title || it.liveTitle || (it.userInfo?.nickname || it.nickname || '') || ''),
      cover: String(it.coverPath || it.liveCover || it.cover || it.userInfo?.cover || ''),
    };
    for (const key of [owner, lr, nick]) if (key) byOwner[key] = entry;
  }
  return { ids, names, byOwner };
}

/**
 * 两个「直播中」索引是否**内容等价**。
 *
 * ⚠️ 这是「30s 卡一下 / 切房间列表闪一下」的直接来源之一（用户 2026-09-30）：
 * `buildLiveIndex()` 每轮都返回**新对象**（新的 Set / 新的 byOwner），
 * 直接用 `setLiveNow(next)` 会让整个房间页（几十行 RoomListRow + 所有 useMemo）
 * 每 30s 全量重渲染一次 —— 哪怕一个成员的开播状态都没变。
 * 内容等价时返回 true，调用方复用旧引用（`setState(prev)`）→ React 判定无变化，零重渲染。
 */
export function sameLiveIndex(a: LiveNowIndex | null | undefined, b: LiveNowIndex | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.ids.size !== b.ids.size || a.names.size !== b.names.size) return false;
  for (const v of a.ids) if (!b.ids.has(v)) return false;
  for (const v of a.names) if (!b.names.has(v)) return false;
  const ak = Object.keys(a.byOwner);
  const bk = Object.keys(b.byOwner);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const x = a.byOwner[k];
    const y = b.byOwner[k];
    if (!y) return false;
    if (x.liveId !== y.liveId || x.title !== y.title || x.cover !== y.cover) return false;
  }
  return true;
}
