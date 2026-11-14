/**
 * 直播间贡献榜：数据归一化 + 资料兜底（纯函数）。
 *
 * 用户 2026-11-13：「房间列表头像点进去的直播，三个点里的贡献榜还是老样子，
 * 直播页明明修过了」——根因就是这套逻辑以前有两份：
 *   · MediaScreen 自己一份（含 content.data.list 等新结构 + `profileFromUserRes` 补头像/昵称）
 *   · room/roomIdentity 一份（少了补全，榜单里全是「用户 N」和空头像）
 * 现在只有这一份，`LiveRankSheet`（两个场景共用的面板）与房间域都调它。
 */
import { normalizeUrl, pickText, unwrapList } from './data';

export interface LiveRankRow {
  userId?: string;
  rank?: number;
  name?: string;
  avatar?: string;
  value?: string;
  [key: string]: any;
}

/** 接口返回结构五花八门：先按常见字段路径取列表，取不到再深度扫描「像用户/像数值」的对象 */
export function normalizeLiveRank(res: any): LiveRankRow[] {
  let list = unwrapList(res, [
    'content.rankList',
    'content.userRankList',
    'content.userRankingList',
    'content.contributionList',
    'content.list',
    'content.data',
    'content.data.list',
    'content.data.rankList',
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
    if (content && typeof content === 'object') {
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
  }
  return list.map((item: any, index: number) => ({
    ...item,
    userId: pickText(item, [
      'userId', 'uid', 'id', 'account',
      'userInfo.userId', 'userInfo.id',
      'user.userId', 'user.id', 'user.userIdStr', 'user.userAccount',
      'memberInfo.userId', 'memberInfo.id',
    ]),
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
    ], '\u7528\u6237 ' + (index + 1)),
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

/** 名字是「用户 N」这类兜底占位（接口没给昵称） */
export function rankNameIsFallback(row: any, index: number) {
  const name = String(row?.name || '').trim();
  const fallbackPrefix = '\u7528\u6237';
  return !name || name === `${fallbackPrefix} ${index + 1}` || new RegExp(`^${fallbackPrefix}\\s*\\d+$`).test(name);
}

/** 这条记录是否需要补资料（有 userId，但缺头像或名字是占位） */
export function needsRankProfile(row: any, index: number) {
  return !!row?.userId && (!row?.avatar || rankNameIsFallback(row, index));
}

/** user/info 返回 → 昵称 + 头像（字段路径兼容官方几种包装） */
export function profileFromUserRes(res: any) {
  const info = res?.content?.userInfo || res?.content?.user || res?.content || res?.data?.userInfo || res?.data?.user || res?.data || res || {};
  return {
    name: pickText(info, [
      'nickName', 'nickname', 'userName', 'name',
      'profile.nickName', 'profile.nickname',
      'userInfo.nickName', 'userInfo.nickname',
      'user.nickName', 'user.nickname', 'user.userName',
    ]),
    avatar: normalizeUrl(pickText(info, [
      'avatar', 'headImg', 'headUrl', 'picPath',
      'profile.avatar', 'profile.headImg',
      'userInfo.avatar', 'userInfo.headImg',
      'user.avatar', 'user.headImg', 'user.userAvatar',
    ])),
  };
}
