/**
 * 房间页的「房间标识、直播索引与活动时间」纯规则（拆分第 3 步）。
 *
 * 这批函数直接服务两件最容易出错的事：
 *   ① **未读角标**：靠 roomLastActivity（最新消息时间，服务器时间域）与本地「上次看到」比较；
 *   ② **正在直播**判定：靠 buildLiveIndex / liveEntryForMember 把直播列表索引成三张查询表。
 * 历史上这两处的坑都记在 docs/修复记录汇总.md 里（时间基线用设备时钟 → 角标永不消；
 * 指纹超长导致去重失败等），搬到这里之后它们终于可以被单测钉住。
 *
 * 内容由一次性 codemod 按行切片搬运（逐字一致），随后由 tsc 兜住引用完整性。
 */

import type { Member } from '../../types';
import { normalizeUrl, pickText, unwrapList } from '../../utils/data';
import { t } from '../../i18n';
import { getMessageTime, normMs } from './timeRules';
import type { LiveEntry, LiveNowIndex } from './liveIndex';

export type RoomMode = 'big' | 'small';

/**
 * 大房间最新消息：只认 channelId===大房间 或 成员本人发言。
 * 注意不能按 serverId 兜底——小房间与大房间共用 serverId，兜底会把小房间消息冒充大房间预览。
 */
export function findLastMessage(messages: any[], member?: Member) {
  if (!member) return null;
  const bigId = String(member.channelId || '');
  return messages.find((msg) => (
    (bigId && String(msg.channelId || '') === bigId)
    || String(msg.userId || msg.ownerId || '') === String(member.id || '')
  ));
}

/** 小房间（yklzId）最新消息：只认 channelId 精确匹配小房间 */
export function findSmallLastMessage(messages: any[], member?: Member) {
  if (!member) return null;
  const ykid = String(member.yklzId || '');
  if (!ykid || ykid === '0' || ykid === 'undefined') return null;
  return messages.find((msg) => String(msg.channelId || '') === ykid)
    || null;
}

export function roomChannelId(member: Member, mode: RoomMode) {
  return String(mode === 'small' ? (member.yklzId || '') : (member.channelId || ''));
}

/**
 * 房间的「最后活动时间」：大房间/小房间两条最新消息里更晚的那个（统一成毫秒）。
 *
 * ⚠️ 字段口径必须与 `getMessageTime` 一致（`msgTime / messageTime / ctime / time`）——
 * 改造前这里只读 `msgTime || ctime`，而 `/team/classic/last/message/get` 的字段没有文档
 * （docs/API_RESEARCH.md 标注「未找到确切公开资料」）：万一实际用的是 `time`/`messageTime`，
 * 这里就会恒得 0 → 未读判据永远不成立。走统一 helper 就不会有第二个口径。
 *
 * 这个值同时是**未读基线**的写入值（进房 markRead / 首载 seedReadAt），
 * 所以它必须来自服务器的消息时间，绝不能混进设备时钟（见 roomUnread.ts 的时间域铁律）。
 */
export function roomLastActivity(item: any): number {
  return Math.max(
    normMs(getMessageTime(item?.lastMessage)),
    normMs(getMessageTime(item?.lastSmallMessage)),
  );
}

/**
 * 单侧「最新消息」：大房间 = `lastMessage`，小房间 = `lastSmallMessage`。
 *
 * 用户要求（2026-09-30）：新消息要**区分大/小房间**（数字贴在该侧那一行的「大」/「小」标签旁）。
 * 于是「时间」「指纹」都必须能按侧单独取 —— 改造前只有房间级的合并值，
 * 这正是「看不出新消息来自哪一侧」的根因。
 */
export function roomSideMessage(item: any, side: RoomMode): any {
  return side === 'small' ? item?.lastSmallMessage : item?.lastMessage;
}

/** 单侧「最后活动时间」（服务器消息时间 ms；0 = 该侧没有消息） */
export function roomSideActivity(item: any, side: RoomMode): number {
  return normMs(getMessageTime(roomSideMessage(item, side)));
}

/**
 * 单侧「服务端未读数」（上游 yk1z/yaya_msg 同款字段，followed-rooms-feature.js 1527 行）：
 * `last/message/get` 的返回体里带 `unreadCount` / `msgTime`（官方自己维护的未读）。
 *
 * ⚠️ 返回 **-1 表示接口没给这个字段**（调用方回退本地计数）——
 * 字段缺失和「未读为 0」必须区分，否则有未读的房间会被显示成 0。
 */
export function roomSideServerUnread(item: any, side: RoomMode): number {
  const msg = roomSideMessage(item, side);
  const raw = msg?.unreadCount ?? msg?.unread ?? msg?.noreadNum;
  if (raw === undefined || raw === null || raw === '') return -1;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : -1;
}

/**
 * 单侧「最新消息指纹」。
 *
 * ⚠️ 与房间级 `roomToken` 共用**同一个 tokenPart 实现**：两边口径一旦不一致，
 * 「某些房间永远不亮 / 永远亮」这类问题就会以极隐蔽的方式出现（且不报错）。
 */
export function roomSideToken(item: any, side: RoomMode): string {
  return tokenPart(roomSideMessage(item, side));
}

/**
 * 房间「最新消息指纹」：把列表返回的一对最新消息（大房间 + 小房间）压成一个短字符串。
 *
 * ⚠️ 为什么需要指纹（用户反馈两次「房间列表无任何标注」的另一半原因）：
 * `/im/api/v1/team/classic/last/message/get` **官方没有字段文档**，仓库里另一个消费者
 * （src/services/memberData.ts）也只读 serverId/channelId、从不读时间 ——
 * 时间字段名一旦对不上，`最新消息时间 > 已读基线` 就恒为 false，角标永远不亮。
 * 指纹只判断「这条最新消息和上次看到的是不是同一条」：与字段名、时间格式、时区统统无关。
 *
 * 实现：递归收集消息对象里的**标量字段**（深度 ≤2，键名排序后拼接）。
 * 新消息到达时正文/时间/消息 id 必有变化 → 指纹变化 → 判为有新消息。
 */
export function roomToken(item: any): string {
  const big = tokenPart(item?.lastMessage);
  const small = tokenPart(item?.lastSmallMessage);
  return big || small ? `${big}##${small}` : '';
}

/**
 * 单条消息的指纹（`tokenPart` 的公开版）。
 *
 * 用途：轮询刷新时要判断「这条『最新消息』到底变没变」——
 * 没变就复用上一轮的行对象引用，让 React.memo 的房间行整行跳过重渲染
 *（每次轮询都新建对象会让全部行失效，房间多时就是用户反馈的「30s 卡一下」）。
 */
export function messageToken(msg: any): string {
  return tokenPart(msg);
}

/**
 * 把一条「最新消息」压成指纹：递归收集**标量字段**（深度 ≤2，键名排序后拼接）。
 *
 * 房间级 `roomToken`（大+小拼接）与单侧 `roomSideToken` 都用它 —— 只能有一份实现。
 */
function tokenPart(msg: any): string {
  if (!msg || typeof msg !== 'object') return '';
  const flat: string[] = [];
  const walk = (node: any, path: string, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 2) return;
    for (const key of Object.keys(node).sort()) {
      const value = node[key];
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') { walk(value, `${path}.${key}`, depth + 1); continue; }
      flat.push(`${path}.${key}=${String(value)}`);
    }
  };
  walk(msg, '', 0);
  return flat.join('|');
}

/**
 * 「直播中」索引的构建与等价比较已整块搬到 ./liveIndex.ts
 * （无 i18n / 无 react 依赖 → 能被 scripts 编译后进单测）。
 * 这里原样再导出，既有 import（`FollowedRoomsScreen` 等）一行都不用改。
 */
export {
  buildLiveIndex,
  sameLiveIndex,
  type LiveEntry,
  type LiveNowIndex,
} from './liveIndex';

/**
 * 按成员从「直播中」索引里取直播信息。
 * 与房间行「点头像直接进她的直播」用的是**同一套多键查找**（userId / liveRoomId / account / 去前缀小写昵称），
 * 抽成函数是为了给「房间内直播的在线人数」复用（那里常常拿不到 liveId，需要按成员反查）。
 */
export function liveEntryForMember(room: Member | null | undefined, index: LiveNowIndex): LiveEntry | undefined {
  if (!room) return undefined;
  const mid = String(room.id || '');
  const mroom = String((room as any).liveRoomId || '');
  const macct = String((room as any).account || '');
  const mnick = String(room.ownerName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/i, '').trim().toLowerCase();
  return index.byOwner[mid]
    || (mroom ? index.byOwner[mroom] : undefined)
    || (macct ? index.byOwner[macct] : undefined)
    || (mnick ? index.byOwner[mnick] : undefined);
}

/** 从已拉取的直播/录播详情判断当前状态。
 *  口袋 48 接口的事实字段：录播详情带 content.msgFilePath / content.lrcUrl（LRC 弹幕文件，
 *  见 pocket48.getLiveLrc 的既有用法），直播详情带 isLiving / living / isEnd 等状态位。
 *  无法确定时返回 'unknown'，交由上层按 URL 形态兜底。 */
export function detailLiveState(detail: any): 'live' | 'replay' | 'unknown' {
  const d = detail?.content || detail?.data || detail || {};
  if (d.isLiving === true || d.living === true || d.isLive === true) return 'live';
  if (d.isLiving === false || d.living === false || d.isLive === false
    || d.isEnd === true || d.isEnded === true || d.isFinished === true
    || d.isRecord === 1 || d.isRecord === true || d.record === 1 || d.record === true
    || d.isReplay === 1 || d.isReplay === true || d.isPlayback === true
    || Boolean(d.msgFilePath) || Boolean(d.lrcUrl)) return 'replay';
  return 'unknown';
}

export function findLiveItem(listRes: any, liveId: string) {
  const list = unwrapList(listRes, [
    'content.liveList',
    'content.list',
    'content.data',
    'data.liveList',
    'data.list',
    'liveList',
    'list',
  ]);
  return list.find((item: any) => String(item.liveId || item.id || item.live_id || '') === String(liveId));
}

export function normalizeLiveRank(res: any): any[] {
  let list = unwrapList(res, [
    'content.rankList',
    'content.userRankList',
    'content.userRankingList',
    'content.contributionList',
    'content.list',
    'content.data',
    'data.rankList',
    'data.userRankList',
    'data.userRankingList',
    'data.contributionList',
    'data.list',
    'rankList',
    'userRankList',
    'userRankingList',
    'contributionList',
    'list',
  ]);
  if (!list.length) {
    const content = res?.content || res?.data || res;
    const found: any[] = [];
    const walk = (node: any, depth = 0) => {
      if (!node || depth > 5) return;
      if (Array.isArray(node)) {
        node.forEach((item) => walk(item, depth + 1));
        return;
      }
      if (typeof node !== 'object') return;
      const hasUser = pickText(node, ['nickName', 'nickname', 'userName', 'name', 'userInfo.nickname', 'userInfo.nickName', 'user.nickname', 'user.nickName']);
      const hasValue = pickText(node, ['score', 'total', 'cost', 'money', 'giftValue', 'value', 'amount', 'contribution', 'count', 'giftNum']);
      if (hasUser || hasValue || node.userInfo || node.user) found.push(node);
      Object.values(node).forEach((value) => walk(value, depth + 1));
    };
    walk(content);
    list = found;
  }
  return list.map((item: any, index: number) => ({
    ...item,
    userId: pickText(item, ['userId', 'uid', 'id', 'account', 'userInfo.userId', 'userInfo.id', 'user.userId', 'user.id', 'user.userIdStr', 'memberInfo.userId', 'memberInfo.id']),
    rank: Number(item.rank || item.no || item.index || index + 1),
    name: pickText(item, [
      'nickName',
      'nickname',
      'userName',
      'name',
      'senderName',
      'userInfo.nickName',
      'userInfo.nickname',
      'userInfo.name',
      'user.nickName',
      'user.nickname',
      'user.userName',
      'user.name',
      'memberInfo.nickName',
      'memberInfo.nickname',
    ], t('用户 {id}', { id: index + 1 })),
    avatar: normalizeUrl(pickText(item, [
      'avatar',
      'headImg',
      'picPath',
      'userInfo.avatar',
      'userInfo.headImg',
      'user.avatar',
      'user.headImg',
      'user.userAvatar',
      'memberInfo.avatar',
    ])),
    value: pickText(item, ['score', 'total', 'cost', 'money', 'giftValue', 'value', 'amount', 'contribution', 'count', 'giftNum'], ''),
  }));
}

export function avatarInitial(name: string) {
  return (name || t('用')).trim().slice(0, 1).toUpperCase();
}
