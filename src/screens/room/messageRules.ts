/**
 * 房间页的「消息解析与身份判定」纯规则（拆分第 2 步）。
 *
 * 与第 1 步同样的纪律：**只搬家、不改行为**。这里全是「不碰 React、不碰状态」的纯函数 ——
 * 输入是接口返回的原始对象，输出是消息文本 / 时间戳 / 身份 / 去重键。
 * 搬出来之后它们终于可以进 `npm run test:core` 跑单元测试（见 scripts/room-message-rules.test.mjs），
 * 而这张网正是后面第 5 步「抽展示组件」的前提。
 *
 * 本文件内容由一次性 codemod 按行切片搬运（逐字一致），随后由 tsc 兜住引用完整性。
 */

import type { Member, RoomMessage } from '../../types';
import type { RoomLiveMessage } from '../../services/pocketNim/qchat';
import { t } from '../../i18n';
import {
  messagePayload,
  normalizeUrl,
  parseMaybeJson,
  pickText,
} from '../../utils/data';
import { memberIdKeys, normMemberName } from '../../utils/memberMatch';
import { isOwnerSender } from '../../utils/notifyOwnerRules';
import { deepFindText, getMessageTime, sortMessagesNewestFirst } from './timeRules';
export { KNOWN_TIME_KEYS, asTimestamp, capText, deepFindText, getMessageTime, normMs, sortMessagesNewestFirst } from './timeRules';

/** 发送者资料（自己 / 偶像 / 粉丝共用） */
type SenderProfile = {
  id: string;
  name: string;
  avatar: string;
};

/** 消息角色：偶像本人 / 自己 / 粉丝 */
type MessageRole = 'idol' | 'mine' | 'fan';

/**
 * URL 深扫（`collectUrls`）已下沉到 ./mediaScan.ts（零依赖层，可纯 Node 单测）。
 *
 * 为什么必须分开：它引 i18n 的话就进不了单测，而「哪些字段不算消息附件」这条规则
 * 已经踩过两次坑（徐钰涵公式照 / 陈琳队徽，见 mediaScan.ts 文件头），必须能被测试钉住。
 * 这里【再导出】保持既有引用方（mediaResolve / 其它）零改动。
 */
export { collectUrls } from './mediaScan';

// 以下 7 项已下沉到 ./timeRules.ts（零依赖层，可纯 Node 单测）：
// 这里【值导入】供本文件内部使用，同时【再导出】以便原有引用方（FollowedRoomsScreen）无需改动。

export function shortName(member?: Member, fallback = '') {
  const raw = member?.ownerName || fallback || t('未知成员');
  return raw.replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/, '');
}


export function parseObject(value: any) {
  const parsed = parseMaybeJson(value);
  if (parsed && typeof parsed === 'object') return parsed;
  return {};
}

export function extraInfo(item: any) {
  return parseObject(item?.extInfo);
}

export function messageBody(item: any) {
  const body = messagePayload(item);
  return body && typeof body === 'object' ? body : {};
}

export function firstTextFrom(objects: any[], paths: string[]) {
  for (const obj of objects) {
    const value = pickText(obj, paths);
    if (value) return value;
  }
  return '';
}


/* collectUrls（URL 深扫 + 跳过规则）见文件顶部 re-export，实现已搬到 ./mediaScan.ts */

/** 发送者资料。`_room` 仅保留签名（调用方按位置传房间，历史上的昵称兜底已不在此函数内） */
export function senderProfile(item: any, _room: Member): SenderProfile {
  if (!item) return { id: '', name: t('未知用户'), avatar: '' };
  const body = messageBody(item);
  // ⚠️ 只把 extraInfo 的 **user 段**当发送者资料（官方 getChannelBaseParams / 我们 buildChannelExt
  // 写入的都是发送者），不要把整个 ext 混进下面的字段查找 —— ext 里还有 replyInfo（被回复者）。
  // 桌面端 v2.13 followed-chat-feature.js:4082 同款：ext.user.roleId / userId / nickName / avatar。
  const extUser: any = ((extraInfo(item) as any)?.user) || {};
  const objects = [item, body];
  const id =
    firstTextFrom(objects, [
      'senderUserId',
      'senderId',
      'fromUserId',
      'fromAccount',
      'userId',
      'uid',
      'account',
      'sender.userId',
      'sender.id',
      'user.userId',
      'user.id',
      'message.userId',
      'message.senderId',
    ])
    || String(extUser.userId ?? extUser.id ?? '').trim()
    || deepFindText(objects, ['senderUserId', 'fromUserId', 'userId', 'uid']);
  const topName = firstTextFrom(objects, [
    'senderName',
    'senderNickName',
    'nickName',
    'nickname',
    'userName',
    'name',
    'fromNickName',
    'sender.nickName',
    'sender.nickname',
    'sender.name',
    'user.nickName',
    'user.nickname',
    'user.name',
    'message.nickName',
    'message.nickname',
  ]) || deepFindText(objects, ['nickName', 'nickname', 'senderName', 'userName', 'name']);
  // 名字/头像：ext.user 优先（桌面端就是用它覆盖顶层 senderName）——消息里带的最新昵称/头像比兜底更准
  const name = String(extUser.nickName || extUser.nickname || '').trim() || topName;
  const topAvatar = firstTextFrom(objects, [
    'avatar',
    'senderAvatar',
    'headImg',
    'headUrl',
    'sender.avatar',
    'sender.headImg',
    'user.avatar',
    'user.headImg',
    'userInfo.avatar',
    'userInfo.headImg',
    'message.avatar',
    'message.headImg',
  ]) || deepFindText(objects, ['senderAvatar', 'avatar', 'headImg', 'headUrl']); // 仅小头像字段，勿深扫 picPath 大图
  const avatar = normalizeUrl(String(extUser.avatar || '').trim() || topAvatar);

  return {
    id,
    name: name || (id ? t('用户 {id}', { id }) : t('未知用户')),
    avatar: avatar || '',
  };
}

export function isIdolMessage(item: any, room: Member, includeFans: boolean) {
  // room 可能为空（房间切走/关闭时 chatRows 的 memo 仍可能重算）：不能直接读 room.id，否则整屏 CRASH
  if (!room) return false;
  const body = messageBody(item);
  const ext = extraInfo(item);
  const profile = senderProfile(item, room);
  const ownerIds = [room.id, (room as any).userId, (room as any).memberId].map(String).filter(Boolean);
  if (profile.id && ownerIds.includes(String(profile.id))) return true;
  /**
   * ★ 房主**昵称兜底**（用户 2026-10-02：「房间群聊里明明能看到偶像发言，却提示 7 天内偶像无消息」）。
   *
   * 根因：消息里的发送者 id 与成员库 id **不同域**（云信 accid / 口袋 account / 字段缺失），
   * 上面的 id 匹配必然失败 → 房主消息被判成粉丝 → 「只看偶像」视图看不到它、
   * 7 天无消息判定跟着误报。
   * 昵称是消息里几乎必带的字段（ext.user.nickName / senderName / nickName），
   * 用 `normMemberName`（去团体前缀/空白/大小写）比对房主名 —— id 之外的稳定兜底。
   */
  const ownerNameKeys = [room.ownerName, (room as any).nickname]
    .map((n) => normMemberName(n))
    .filter(Boolean);
  const senderNameKey = normMemberName(profile.name);
  if (senderNameKey && ownerNameKeys.includes(senderNameKey)) return true;
  // 已识别出发送者 ID 且不是房主（其他成员/粉丝在别人房间发言）：显示自己的名字，不套用房主身份
  if (profile.id) return false;
  // 拿不到发送者 ID：退回原来的判断逻辑
  if (!includeFans) return true;
  const role = firstTextFrom([item, ext, body], ['roleId', 'user.roleId', 'sender.roleId', 'message.roleId']);
  if (role && ['2', '3', '4', 'star', 'idol'].includes(String(role).toLowerCase())) return true;
  return false;
}

/**
 * ★ **唯一**的严格房主判定（用户 2026-11-11 定版：「都走严格判定」）。
 *
 * 服务对象：横幅通知 + 房间列表角标计数 + 列表预览正文（三者必须同一口径，
 * 否则会出现「算了一条、提示另一条」）。解析发送者与「只看偶像」视图同源（都走
 * `senderProfile`），但判定用 `notifyOwnerRules.isOwnerSender`：
 *   · 明确匹配房主 id / 昵称 → true；
 *   · 认不出发送者（无 `ext.user`、昵称对不上） → **false**。
 *
 * ⚠️ `isIdolMessage(..., false)` 里「认不出就当偶像」的宽松兜底**只留给「只看偶像」视图**
 *（那是宁可多显示的展示口径）；用于计数/通知/预览会把没带资料子树的粉丝消息算成偶像。
 */
export function isOwnerMessageStrict(item: any, room: Member): boolean {
  if (!room || !item) return false;
  return isOwnerSender(senderProfile(item, room), {
    ids: [room.id, (room as any).userId, (room as any).memberId],
    names: [room.ownerName, (room as any).nickname],
  });
}

export function currentUserIdFrom(res: any): string {
  return firstTextFrom([res?.content, res?.data, res], [
    'userInfo.userId',
    'userInfo.id',
    'user.userId',
    'user.id',
    'userId',
    'id',
    'account',
  ]);
}

export function messageRole(
  item: any,
  room: Member,
  includeFans: boolean,
  currentUserId: string | string[],
  memberIds?: Set<string>,
  selfNameKeys?: Set<string>,
): MessageRole {
  if (!item) return 'fan';
  const profile = senderProfile(item, room);
  // ★「我发的」判定必须**独立于视图开关**（includeFans）：
  //   旧实现把 mine 的判定挂在「显示粉丝消息」上 —— 大房间默认进房是成员视图（includeFans=false），
  //   自己的消息直接落到 idol/fan 分支 → 气泡跑到别人那侧（用户 2026-10-02：「偶像房间里还是在同侧」）。
  //   现在无论哪个视图，命中即判 mine（右侧、粉色气泡）。
  const myIds = (Array.isArray(currentUserId) ? currentUserId : [currentUserId])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  const pid = String(profile.id || '').trim();
  if (myIds.length > 0 && pid && myIds.includes(pid)) return 'mine';
  // 昵称兜底（仅在消息**没有任何发送者 id** 时启用，防止同名的他人消息误判）：
  // 部分历史数据里自己的消息不带 id，旧逻辑会把它判成 idol（成员视图下无 id 即偶像）。
  const nameKey = normMemberName(profile.name);
  if (!pid && nameKey && selfNameKeys && selfNameKeys.has(nameKey)) return 'mine';
  if (isIdolMessage(item, room, includeFans)) return 'idol';
  // 其他成员（成员库里的成员，但不是本房房主）在别人房间发言 → 也算「成员消息」。
  // 用户要求：切到「成员消息」时，别的成员的消息不能被当成粉丝消息过滤掉。
  if (profile.id && memberIds && memberIds.has(String(profile.id))) return 'idol';
  return 'fan';
}

/**
 * 成员库 id 集合（成员 id / userId / memberId 都可能出现在消息里）。
 *
 * ⚠️ 「哪些字段算成员 id」的口径只有一份 —— `utils/memberMatch.memberIdKeys`。
 * 以前这里自己列 `id / userId / memberId`，而房间页另一处（`utils/memberMatch`）
 * 还认 `serverId / channelId / yklzId / account`，两套口径并存的后果是
 * 「同一个人在消息列表里认得出来、在卡片队伍上认不出来」（用户反馈的队伍不匹配）。
 */
export function buildMemberIdSet(members: any[]): Set<string> {
  const set = new Set<string>();
  (members || []).forEach((m: any) => {
    for (const s of memberIdKeys(m)) set.add(s);
  });
  return set;
}

/**
 * 成员 id → 成员 的速查表（多个 id 字段都可能被消息引用，全部登记同一个成员）。
 *
 * 为什么需要：聊天列表渲染时每条消息都要判断「发送者是不是成员」，
 * 原实现是 `members.find(m => [m.id, m.userId, m.memberId].some(...))` ——
 * 每渲染一条消息就把**整个成员库扫一遍并新建数组**，即 O(消息数 × 成员数)。
 * 成员库几百人、列表一次渲染几十条时开销可观。建成 Map 后为 O(1)。
 */
export function buildMemberIndex(members: any[]): Map<string, any> {
  const map = new Map<string, any>();
  (members || []).forEach((m: any) => {
    for (const s of memberIdKeys(m)) {
      // 先登记者优先：id 命中优于 userId / channelId 等兜底命中
      if (!map.has(s)) map.set(s, m);
    }
  });
  return map;
}

/**
 * 「用户资料卡」信息解析。数据源 = `user/api/v1/user/info/home`（桌面端 fetchUserHomeInfo 同款：
 * Android 头 + `{ userId }` 数字）。结构（对齐桌面 getFollowedProfileContent）：
 *   content.userInfo.baseUserInfo = 头像/昵称…，content.starInfo = 成员信息（若是成员）。
 * 全部多路径兜底，取不到就留空（UI 只显示拿到的行，不再把原始报错文本糊上去）。
 */
export function userCardFromUserRes(res: any) {
  const content = res?.content || res?.data?.content || res?.data || res || {};
  const userInfo = content?.userInfo || content?.user || content?.profile || content || {};
  const base = userInfo?.baseUserInfo || userInfo?.baseInfo || userInfo || {};
  const star = content?.starInfo || content?.memberInfo || userInfo?.starInfo || {};
  const objs = [base, userInfo, star, content];
  const pick = (keys: string[]) => firstTextFrom(objs, keys);
  // 关注态：对齐桌面端 followed-chat-feature.js 的取值口径
  //   relation / relationType / followStatus / friendStatus / isFollow / followed / isFriend
  //     mutual|both|friend|friends|2|3 → 互相关注；true|followed|following|1 → 已关注
  const relationValue = String(
    pick(['relation', 'relationType', 'followStatus', 'friendStatus', 'isFollow', 'followed', 'isFriend', 'relationship']) || '',
  ).trim().toLowerCase();
  const mutual = ['mutual', 'both', 'friend', 'friends', '2', '3'].includes(relationValue);
  const following = mutual || ['true', 'followed', 'following', '1'].includes(relationValue);
  return {
    name: pick(['nickName', 'nickname', 'userName', 'name', 'starName', 'realNickName', 'baseUserInfo.nickName']),
    avatar: normalizeUrl(pick(['avatar', 'avatarUrl', 'faceImage', 'headImg', 'headUrl', 'starAvatar'])),
    level: pick(['level', 'userLevel', 'grade', 'vipLevel', 'userLevelName']),
    signature: pick(['signature', 'sign', 'intro', 'description', 'userSignature']),
    team: pick(['starTeamName', 'teamName', 'team']),
    period: pick(['periodName', 'period']),
    isStar: !!(star && (star.starName || star.starId)) || base?.isStar === true || base?.star === true,
    following,
    mutual,
  };
}

export function messageKey(item: any) {
  if (!item) return `empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  /**
   * ⚠️ `msgIdClient` / `msgIdServer` 必须在内（用户 2026-11-09 反馈「房间新消息数量不对」）：
   * HTTP 历史消息的 id 字段就是 `msgIdClient`（API 文档：msgIdServer / msgIdClient / bodys / …），
   * 而实时通道的 `uuid` 取的是 `message.msgIdClient`（见 services/pocketNim/qchat.ts）。
   * 这里漏了 msgIdClient 时，**同一条消息**在实时通道是 `msgIdClient` 键、在历史/静默刷新里
   * 退化成「时间+发送者+正文」键 → 两条键 → 合并去重失效（列表出现重复行），
   * 浮标也会把它当成一条新消息重复计数。
   * 顺序：客户端 id 优先（两端同源），服务端 id 次之，最后才是 uuid / 近似键。
   */
  const direct = item.id || item.msgId || item.messageId || item.clientMsgId
    || item.msgIdClient || item.uuid || item.msgUuid || item.msgIdServer;
  if (direct) return String(direct);
  const profile = senderProfile(item, {} as Member);
  const body = messageBody(item);
  const text = firstTextFrom([body, item], ['text', 'message', 'msgContent', 'content', 'bodys', 'body']);
  const media = firstTextFrom([body, item], ['url', 'fileUrl', 'pictureUrl', 'coverUrl', 'liveId']);
  // 注意：兜底键【不含 index】—— 同一消息在不同 list 中 index 不同会导致去重失败、重复累积。
  // 无稳定 id 时以 时间+发送者+内容 作近似键，足以区分不同消息并拦截同批重复。
  return String(`${getMessageTime(item)}-${profile.id || profile.name || ''}-${text || media || JSON.stringify(body).slice(0, 120)}`);
}




/** 下一页时间戳。`_list` 仅保留签名（调用方按位置传列表） */
export function getNextTime(res: any, _list: any[]): number {
  const direct = Number(firstTextFrom([res?.content, res?.data, res], ['nextTime', 'next', 'lastTime']));
  if (Number.isFinite(direct) && direct > 0) return direct;
  return 0;
}

export function diagnoseUndefined(list: any[], tag: string) {
  if (!Array.isArray(list)) return;
  const bad = list
    .map((it, i) => (it == null ? i : -1))
    .filter((i) => i >= 0);
  if (bad.length) {
    // 真机/调试时可见：指出是哪个入口首次把 undefined 写进 roomMessages
    // eslint-disable-next-line no-console
    console.warn(`[msgDiag:${tag}] 检出 ${bad.length} 个 null/undefined 元素，下标=[${bad.slice(0, 20).join(',')}]`, {
      rawSample: list.slice(0, 5),
      stack: new Error().stack,
    });
  }
}

export function mergeMessages(prev: RoomMessage[], next: RoomMessage[]) {
  // 根因防御：prev / next 任一含 undefined 都会「累积污染」整个聊天记录（之前只在外层 filter，
  // 但 prev 一旦带毒，后续 merge 永远带毒，最终在 renderChatItem 崩溃）。这里双端都过滤 + 诊断。
  const cleanPrev = prev.filter(Boolean);
  if (cleanPrev.length !== prev.length) diagnoseUndefined(prev, 'MERGE_PREV');
  const seen = new Set(cleanPrev.map((item) => messageKey(item)));
  const merged = [...cleanPrev];
  next.filter(Boolean).forEach((item) => {
    const key = messageKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return sortMessagesNewestFirst(merged);
}


/**
 * 云信圈组实时消息 → 房间列表可渲染结构。
 *
 * 房间消息的「历史」来自 HTTP（im/api/v1/team/message/list/*），「实时」只有云信圈组
 * 一条通道（HTTP 无发送/无推送）。这里把原生桥回来的消息对齐成 HTTP 历史消息的字段形态，
 * 让既有的 renderChatItem / messageKey / mergeMessages 原样复用。
 */
export function qchatToRoomMessage(msg: RoomLiveMessage): any {
  const user = (msg.ext?.user && typeof msg.ext.user === 'object' ? msg.ext.user : {}) as Record<string, any>;
  const nickName = String(user.nickName || user.nickname || msg.fromNick || '');
  /**
   * 引用（回复）信息也要随实时消息进 bodys（用户 2026-10-14）：
   * HTTP 历史那边由 `utils/roomReply.roomReplyInfo` 从 extInfo 里读，而**实时回显**这条链路
   * 是把 ext 折进 bodys 的 —— 不带上就会出现「引用发出去别人看得到、自己这边没有引用卡」
   * （发出后 500ms/1500ms 那次静默刷新拿到的也是同一条实时形态）。
   */
  const reply = msg.ext && typeof msg.ext === 'object' ? (msg.ext as Record<string, any>) : {};
  const hasReply = !!(reply.replyInfo || reply.replyName || reply.replyText);
  return {
    uuid: msg.uuid,
    msgId: msg.uuid,
    msgTime: msg.time,
    time: msg.time,
    msgType: msg.messageType,
    // bodys 沿用 HTTP 消息的「JSON 体」形态：正文 + 类型 + 发送者（+ 引用信息）
    bodys: {
      text: msg.text,
      messageType: msg.messageType,
      user: {
        userId: Number(user.userId || 0),
        nickName,
        avatar: String(user.avatar || ''),
        roleId: Number(user.roleId || 0),
      },
      ...(hasReply
        ? {
            ...(reply.replyInfo ? { replyInfo: reply.replyInfo } : {}),
            ...(reply.replyName || reply.replyText
              ? { replyName: reply.replyName || '', replyText: reply.replyText || '' }
              : {}),
          }
        : {}),
    },
    extInfo: msg.ext,
    fromUserId: Number(user.userId || 0),
    senderUserId: Number(user.userId || 0),
    senderName: nickName,
    nickName,
    userAvatar: String(user.avatar || ''),
    channelId: msg.channelId,
    serverId: msg.serverId,
    /** 标记来源：实时（用于排查），不影响渲染 */
    __live: true,
  };
}
