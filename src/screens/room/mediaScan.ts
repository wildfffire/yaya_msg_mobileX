/**
 * 房间消息「媒体 URL 深扫」—— 从消息对象里捞「消息附件」URL 的唯一实现。
 *
 * 为什么单独成层（2026-10-06）：
 *   原来这段逻辑长在 `messageRules.ts`（引 i18n → 引 react），**纯 Node 单测跑不起来**，
 *   于是「哪些键该跳过」这条规则只能靠人肉 review —— 这正是下面两起同类 bug 的土壤：
 *     · 徐钰涵每条文字消息带公式照（extInfo 序列化 JSON 被正则扫 / ext.user.avatar 被当附件）；
 *     · 陈琳每条文字消息带一张**圆形头像框图**（ext.user.pfUrl 被当附件；用户 2026-10-06 反馈，
 *       真机日志 `[room.media] 跳过发送者资料图片：字段 pfUrl` 实证）。
 *   搬到零依赖模块（只 import utils/pathPick 的 normalizeUrl）之后，规则进
 *   `scripts/room-media-scan.test.mjs` 钉成回归锁，改坏立刻报错。
 *
 * ⚠️ 铁律：**发送者资料子树（user / userInfo / sender / fromUser / acceptUser）里的图片
 *   一律不是消息附件**（头像 avatar / 头像框 pfUrl / 队徽 teamLogo / 徽章 badge / 等级图标…）。
 *   它们只说明「谁在说话」，不属于消息内容 —— 一旦被当附件，这个发送者的**每条**消息
 *   都会多出一张图（且只有成员/房主会多，因为粉丝的资料里这些字段是空的）。
 *   消息附件只可能出现在消息体（bodys / body / ext 的内容字段）里。
 */

import { normalizeUrl } from '../../utils/pathPick';

/** 从任意文本里抠 URL（房间消息把链接写进正文时用） */
const URL_REG = /(https?:\/\/[^\s"'<>，。！？、]+|rtmp:\/\/[^\s"'<>，。！？、]+)/gi;

/** 「发送者资料」子树：整棵不扫（见文件头铁律）。键名统一小写比对 */
const PROFILE_SUBTREE_KEYS = new Set(['user', 'userinfo', 'sender', 'fromuser', 'acceptuser']);

/**
 * 「引用（回复）原文」子树：整棵不扫（用户 2026-10-14 加入引用功能后新增）。
 *
 * 引用卡里的 `replyText` 只是**被引用那条消息的展示文本**，不是本条消息的附件：
 * 不跳过的话，引用一条带链接的消息（或成员引用的媒体地址）会让自己的回复
 * 凭空多出一张链接/图片卡 —— 与「陈琳每条消息多一张头像框」是同一类假附件。
 */
const QUOTED_SUBTREE_KEYS = new Set(['replyinfo', 'giftreplyinfo']);

/** 引用信息的**扁平**字段（官方 extInfo 口径就写在 ext 根上）：字符串值同样不参与扫描 */
const QUOTED_STRING_KEYS = new Set(['replytext', 'replyname', 'replymsgidclient', 'replyuserid']);

/**
 * 「发送者资料 / 装饰 / 元数据」字段：字符串值一律跳过（键名统一小写比对）。
 *
 * 分组说明（三组都必须留）：
 *   ① 头像/昵称图：avatar / headImg / headUrl / headIcon / faceImage / avatarUrl / userAvatar / senderAvatar
 *   ② 成员装饰：teamLogo（队徽，圆形）/ pfUrl（头像框）/ badge / bubbleId / levelIcon / vipIcon
 *   ③ 封面与序列化元数据：picPath / coverPath / coverUrl / picturePath（封面走**显式字段取值**，不走深扫兜底）、
 *      extInfo / msgExtInfo / extMsgInfo / attachInfo（序列化 JSON，里面就是头像/团徽的来源）
 */
const PROFILE_STRING_KEYS = new Set([
  'avatar', 'avatarurl', 'headimg', 'headurl', 'headicon', 'faceimage', 'useravatar', 'senderavatar',
  'teamlogo', 'pfurl', 'badge', 'bubbleid', 'levelicon', 'vipicon',
  'picpath', 'coverpath', 'coverurl', 'picturepath',
  'extinfo', 'msgextinfo', 'extmsginfo', 'attachinfo',
]);

/** 图片 URL 判据（写真机日志/诊断用；不含个人信息，只看形态） */
const IMAGE_URL_REG = /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?|$)/i;

/** 已上报过的「被跳过的发送者资料图片」字段名（每个字段只报一次，避免每行消息刷屏） */
const reportedProfileKeys = new Set<string>();

/**
 * 在发送者资料子树里找出**所有**「图片 URL 字段」并只返回字段名（不返回 URL ——
 * URL 里常含头像等个人信息，不写进日志）。
 *
 * ⚠️ 为什么要「全部」而不是「第一个」：子树里先出现的往往是头像（avatar，老实现就已跳过），
 * 只报第一个的话就看不到**这次真正多出来的那张图**是哪个字段（队徽 teamLogo / 头像框 pfUrl / 徽章）。
 */
function imageKeys(value: any, out: string[] = [], depth = 0): string[] {
  if (!value || depth > 3) return out;
  if (Array.isArray(value)) {
    for (const item of value) imageKeys(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string') {
        if (IMAGE_URL_REG.test(val.trim())) out.push(key);
      } else {
        imageKeys(val, out, depth + 1);
      }
    }
  }
  return out;
}

/**
 * 诊断（真机 logcat 可见，release 也打）：某个「发送者资料」字段里确实带了图片 URL。
 *
 * 为什么留这条：这类图**曾经**被当消息附件渲染（陈琳每条消息带一张圆形头像框 / 徐钰涵带公式照），
 * 现在一律跳过 —— 万一以后又出现「某个人每条消息都多一张图」，看这条日志就知道是哪个字段，
 * 不用再猜（真机验证：`adb logcat -s ReactNativeJS` 里搜 `[room.media]`）。
 */
function noteSkippedProfileImage(fieldName: string) {
  if (!fieldName || reportedProfileKeys.has(fieldName)) return;
  reportedProfileKeys.add(fieldName);
  try {
    // eslint-disable-next-line no-console
    console.log(`[room.media] 跳过发送者资料图片：字段 ${fieldName}（头像/队徽/头像框/徽章不是消息附件）`);
  } catch {
    /* 忽略 */
  }
}

/**
 * 递归收集对象里出现的 URL（媒体兜底扫描用）。
 *
 * 调用方：`mediaResolve.pickPlayableUrls`（挑播放地址）与 `roomMedia`（挑消息附件）。
 * 两边共用同一套跳过规则，避免「一处修好、另一处照旧泄漏」。
 */
export function collectUrls(value: any, result: string[] = [], depth = 0): string[] {
  if (!value || depth > 6) return result;
  if (typeof value === 'string') {
    const matches = value.match(URL_REG) || [];
    matches.forEach((url) => result.push(normalizeUrl(url)));
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, result, depth + 1));
    return result;
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      const k = key.toLowerCase();
      // 发送者资料整棵子树跳过：不递归、不取值
      if (PROFILE_SUBTREE_KEYS.has(k)) {
        for (const field of imageKeys(val)) noteSkippedProfileImage(field);
        continue;
      }
      // 引用（回复）原文：整棵不扫（见 QUOTED_SUBTREE_KEYS 注释）
      if (QUOTED_SUBTREE_KEYS.has(k)) continue;
      // 装饰/元数据字段：只跳字符串值（对象/数组仍递归，保持历史行为）
      if (typeof val === 'string' && (PROFILE_STRING_KEYS.has(k) || QUOTED_STRING_KEYS.has(k))) {
        if (IMAGE_URL_REG.test(val.trim()) && PROFILE_STRING_KEYS.has(k)) noteSkippedProfileImage(key);
        continue;
      }
      collectUrls(val, result, depth + 1);
    }
  }
  return result;
}
