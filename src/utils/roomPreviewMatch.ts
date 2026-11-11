/**
 * 房间列表「最新消息」预览条目与成员的匹配规则（纯函数，零依赖，可进纯 Node 单测）。
 *
 * 背景（用户 2026-11-11：「房间列表里有的成员有新消息不会计数也不显示」）：
 * `im/api/v1/team/classic/last/message/get` 的条目字段（真机实证）只有
 * `serverId / channelId / msgContent / starName`，一个 server 下**最多两条**
 *（大房间 channelId + 小房间 yklzId）。
 *
 * 旧实现只按 `msg.channelId === member.channelId` 精确匹配大房间、`=== member.yklzId`
 * 匹配小房间。成员库是社区维护的：频道一旦漂移（官方换过频道 / 库里写的还是旧频道），
 * 该成员的预览就恒为 null —— 列表里**没有预览文本**，指纹也恒为空串，
 * 于是 30s 指纹计数与 5s 通知轮询的 `sides` 都会直接跳过它 → **既不计数也不显示**。
 *
 * 这里补一条「同 server 内消歧」的兜底（不需要任何额外请求）：
 *   · 同一个 serverId 下的条目必然属于同一位成员的两个频道；
 *   · 大房间：精确 channelId 命中优先，否则取该 server 下**唯一一条不是小房间 yklzId** 的；
 *   · 小房间：精确 yklzId 命中优先，否则**在大房间已精确命中**的前提下，
 *     取该 server 下唯一一条不是大房间的。
 *
 * ⚠️ 宁缺勿错：两条条目里哪条是大房间无法确认（两侧 id 都漂移 / 不知道 yklzId）时一律返回 null ——
 * 猜错的代价是把大房间的预览与未读数字记到小房间（用户 2026-10-01 反馈过的「小房间被大房间消息取代」）。
 * 拿不到 serverId 时不做任何兜底，行为与旧版完全一致。
 */

/** 参与匹配的房间字段（Member 的超集，保持零依赖） */
export interface PreviewMemberLike {
  id?: string | number;
  userId?: string | number;
  channelId?: string | number;
  serverId?: string | number;
  yklzId?: string | number;
}

/** id 归一比较：空串 / '0' / 'undefined' / 'null' 一律视为「没有」，两侧都有值才可能相等 */
export function sameRoomId(a: unknown, b: unknown): boolean {
  const left = String(a ?? '').trim();
  const right = String(b ?? '').trim();
  if (!left || !right) return false;
  if (left === '0' || right === '0') return false;
  if (left === 'undefined' || right === 'undefined') return false;
  if (left === 'null' || right === 'null') return false;
  return left === right;
}

function entryChannel(msg: any): string {
  return String(msg?.channelId ?? '').trim();
}

/** 同一 serverId 下的条目（拿不到 serverId 时返回空表，兜底不生效） */
function sameServerEntries(messages: any[], member: PreviewMemberLike): any[] {
  const serverId = String(member?.serverId ?? '').trim();
  if (!serverId || serverId === '0') return [];
  return (messages || []).filter((msg) => msg && sameRoomId(msg.serverId, serverId));
}

/** 精确 channelId 命中的条目（没有则 null） */
function exactChannelEntry(messages: any[], channelId: unknown): any {
  const id = String(channelId ?? '').trim();
  if (!id || id === '0') return null;
  return messages.find((msg) => sameRoomId(entryChannel(msg), id)) || null;
}

/**
 * 大房间「最新消息」。
 *
 * 顺序：精确 channelId → 条目自带发送者 id（老接口形态）→ 同 server 内消歧（排除小房间）。
 */
export function pickBigPreview(messages: any[], member?: PreviewMemberLike | null): any {
  if (!member) return null;
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (!list.length) return null;
  const exact = exactChannelEntry(list, member.channelId);
  if (exact) return exact;
  const memberId = String(member.id ?? '').trim();
  if (memberId && memberId !== '0') {
    const bySender = list.find((msg) => sameRoomId(msg?.userId ?? msg?.ownerId, memberId));
    if (bySender) return bySender;
  }
  const sameServer = sameServerEntries(list, member);
  if (!sameServer.length) return null;
  const smallId = String(member.yklzId ?? '').trim();
  const smallKnown = !!smallId && smallId !== '0' && smallId !== 'undefined';
  /**
   * 该 server 下只有一条：它可能是小房间（大房间没消息 / 该成员只有小房间），
   * 只有「不知道小房间 id」时才敢认定它就是大房间。
   */
  if (sameServer.length < 2) {
    if (smallKnown) return null;
    return sameServer[0];
  }
  // 两条：只知道小房间 id 时才能可靠地把「不是小房间的那条」认成大房间
  if (!smallKnown) return null;
  const rest = sameServer.filter((msg) => !sameRoomId(entryChannel(msg), smallId));
  return rest.length === 1 ? rest[0] : null;
}

/**
 * 小房间「最新消息」。
 *
 * 顺序：精确 yklzId → 同 server 消歧（**大房间必须已精确命中**，否则无法确认哪条是小房间）。
 */
export function pickSmallPreview(messages: any[], member?: PreviewMemberLike | null): any {
  if (!member) return null;
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (!list.length) return null;
  const ykid = String(member.yklzId ?? '').trim();
  if (!ykid || ykid === '0' || ykid === 'undefined') return null;
  const exact = exactChannelEntry(list, ykid);
  if (exact) return exact;
  /**
   * 小房间频道不在返回体里（库里 yklzId 漂移）：只有在「大房间精确命中」时，
   * 才能把该 server 下另一条认定成小房间 —— 否则两条都可能，猜错就是大/小串味。
   */
  const bigExact = exactChannelEntry(list, member.channelId);
  if (!bigExact) return null;
  const sameServer = sameServerEntries(list, member);
  if (sameServer.length < 2) return null;
  const bigChannel = entryChannel(bigExact);
  const rest = sameServer.filter((msg) => !sameRoomId(entryChannel(msg), bigChannel));
  return rest.length === 1 ? rest[0] : null;
}
