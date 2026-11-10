/**
 * 云信消息（直播弹幕 / 会话消息）编解码。
 *
 * 逆向依据（口袋48 7.1.39）：
 *   com.pocket.snh48.lib.yunxin.model.ChatMsgUtil#getBaseParams   → fromApp/roomId/sourceId/session/bubbleId/user/config
 *   com.pocket.snh48.lib.yunxin.model.ChatMsgBuilder#createBarrageNomalMessageMap
 *                                    #createBarrageMemberMessageMap
 *                                    #createTextMessageMap
 *   com.pocket.snh48.lib.yunxin.im.IMChatRoom#sendTextMessage      → type 判定 + setContent + setRemoteExtension
 */

import {
  BarrageItem,
  BarrageKind,
  NimModule,
  NimMsgType,
  NimSelfProfile,
} from './types';
import { replaceEmojiText } from '../../utils/emoji';
import { textFromJsonPayload } from '../../utils/json';
import { stripRichText } from '../../utils/richtext';

/**
 * 弹幕正文归一化：先解「整条是 JSON」的异常情况，再剥掉官方 H5 / 其他端发出的
 * HTML 富文本标签，最后把 `[流泪]` 这类口袋48 文本表情短码换成 emoji。
 *
 * 三步的顺序不能换：
 *   ① JSON 拆包要在最前（拆出来的 text 字段本身就是给用户看的内容）；
 *   ② 剥标签必须在短码替换之前 —— 否则标签内容会被当成普通文本一起送上屏
 *      （2026-10-03 林舒晴直播间实测：弹幕列表与飘屏都在飘 `<div><span style=…>`）；
 *      图片表情（`<img src="/backstage/…">`）剥成 `[表情]` 占位，消息不整条消失。
 *
 * ⚠️ 这一步**必须**做在解析层而不是渲染层：直播弹幕有三个消费方
 * （弹幕列表 LiveBarrageBoard / 画面飘屏 DanmakuOverlay / 弹幕列表抽屉），
 * 只有在这里统一处理，三处才不会各漏一处。
 *
 * 原始富文本样本由 `chatroom.ts` 的 `[rich]` 日志留档（这里刻意不引 runtimeLog：
 * 本文件的编译产物会被 `scripts/richtext.test.mjs` 在 Node 里直接 import，
 * 引 RN 依赖会让单测起不来）。
 */
function normalizeBarrageText(raw: string): string {
  if (!raw) return '';
  return replaceEmojiText(stripRichText(textFromJsonPayload(String(raw))));
}

/** 官方手机端 config 段（DialogConfig：build 固定 181022，其余为设备信息，服务端只做统计） */
function buildConfig() {
  return {
    build: '181022',
    mobileOperators: '',
    phoneName: 'Android',
    phoneSystemVersion: 'Android',
    version: '7.1.39',
  };
}

/**
 * 从云信消息里取出 remoteExtension（官方 SDK 里叫 remoteExtension，Web SDK 里叫 ext / custom）。
 * 版本差异较大，这里按候选字段依次兜底，字符串形态自动 JSON.parse。
 */
export function readExt(msg: any): Record<string, any> {
  if (!msg) return {};
  const candidates = [
    msg.remoteExtension,
    msg.ext,
    msg.custom,
    msg.localCustom,
    msg.content,
    msg.msg_setting_ && msg.msg_setting_.ext_,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    if (typeof raw === 'object') return raw as Record<string, any>;
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (!text || text[0] !== '{') continue;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        /* 非法 JSON 继续尝试下一个候选 */
      }
    }
  }
  return {};
}

/** 官方 roleId：1 成员 / 2 超管（其余为普通用户），仅在收到 ext.user 时可用 */
function toKind(messageType: string, ext: Record<string, any>): BarrageKind {
  switch (messageType) {
    case NimMsgType.BARRAGE_MEMBER:
      return 'member';
    case NimMsgType.BARRAGE_SUPERMAN:
      return 'superman';
    case NimMsgType.BARRAGE_PAY:
      return 'pay';
    case NimMsgType.BARRAGE_STARWO:
      return 'starwo';
    case NimMsgType.BARRAGE_NORMAL:
    case NimMsgType.TEXT:
    case NimMsgType.REPLY:
      return 'text';
    case NimMsgType.PRESENT:
    case NimMsgType.PRESENT_TEXT:
    case NimMsgType.PRESENT_GLOBAL:
    case NimMsgType.GENERAL_SEND_GIFT:
      return 'gift';
    case NimMsgType.EVENT_HAVEHEAD_ENTER:
    case NimMsgType.EVENT_NOHEAD_ENTER:
    case NimMsgType.EVENT_VIP_ENTER:
      return 'enter';
    default:
      break;
  }
  if (ext && ext.giftInfo) return 'gift';
  if (messageType === NimMsgType.LIVE_ANNOUNCE || messageType === NimMsgType.KTV_SONG_MSG) return 'system';
  return 'other';
}

function firstString(...values: any[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function toNumber(...values: any[]): number {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return 0;
}

/** 归一化一条云信聊天室消息；不认识的消息返回 null（例如协议层通知） */
export function parseChatroomMessage(msg: any): BarrageItem | null {
  if (!msg) return null;
  const type: string = String(msg.type || '');
  // 聊天室只关心 text / custom 两类（image、audio、file 等暂不展示）
  if (type && type !== 'text' && type !== 'custom' && type !== 'tip') return null;

  const ext = readExt(msg);
  const messageType: string = firstString(ext.messageType, type === 'text' ? NimMsgType.TEXT : '');
  const user = (ext.user && typeof ext.user === 'object' ? ext.user : {}) as Record<string, any>;
  const kind = toKind(messageType, ext);

  const nick = firstString(user.nickName, user.nickname, msg.fromNick, msg.from);
  const avatar = firstString(user.avatar, msg.fromAvatar);
  const userId = toNumber(user.userId, user.id, user.uid);
  const roleId = toNumber(user.roleId);
  const level = toNumber(user.level);

  let text = normalizeBarrageText(firstString(ext.text, msg.text));
  let gift: BarrageItem['gift'];

  if (kind === 'gift') {
    const giftInfo = (ext.giftInfo || {}) as Record<string, any>;
    const acceptUser = (giftInfo.acceptUser || {}) as Record<string, any>;
    const giftName = firstString(giftInfo.giftName, giftInfo.name);
    const giftNum = toNumber(giftInfo.giftNum, 1);
    const tpNum = toNumber(giftInfo.tpNum);
    const toName = firstString(acceptUser.userName, acceptUser.nickName);
    gift = {
      giftId: toNumber(giftInfo.giftId),
      giftName,
      giftNum,
      tpNum,
      toName,
      picPath: firstString(giftInfo.picPath, giftInfo.icon),
    };
    if (!text) {
      text = toName ? `${nick} 送给 ${toName} ${giftNum}个${giftName}` : `${nick} 送出 ${giftNum}个${giftName}`;
    }
  } else if (kind === 'enter' && !text) {
    text = `${nick} 进入直播间`;
  }

  if (!text && kind !== 'gift') return null;

  return {
    id: firstString(msg.idClient, msg.idServer, msg.uuid, `${nick}-${msg.time}-${text}`),
    kind,
    messageType: messageType || type,
    text,
    nick,
    avatar,
    userId,
    roleId,
    level,
    time: toNumber(msg.time, Date.now()),
    ...(gift ? { gift } : {}),
  };
}

export interface BuildLiveBarrageOptions {
  /** 聊天室 id（= getLiveOne 返回的 content.roomId） */
  roomId: string | number;
  /** 直播 id（官方 sourceId） */
  sourceId: string | number;
  text: string;
  self: NimSelfProfile;
  /** 'live' 成员直播 / 'public' 公开直播（官方 ModuleType） */
  module?: string;
  /** 弹幕类型，默认 BARRAGE_NORMAL */
  messageType?: string;
  /** 进房榜单内（inTop） */
  inTop?: boolean;
  /** 官方 IM 防伪签名 key（来自启动配置 klbrmk），有则带上 */
  imKey?: string;
  /** 消息 uuid（签名用，缺省由 SDK 生成，此处仅官方同款兼容） */
  uuid?: string;
}

/**
 * 构造直播弹幕 remoteExtension（对齐 ChatMsgBuilder.createBarrageNomalMessageMap
 * + ChatMsgUtil.getBaseParams，字段顺序/取值与官方一致）。
 */
export function buildLiveBarrageExt(options: BuildLiveBarrageOptions): Record<string, any> {
  const { roomId, sourceId, text, self } = options;
  const ext: Record<string, any> = {
    fromApp: '201811',
    roomId: String(roomId),
    sourceId: String(sourceId),
    session: 0,
    bubbleId: '0',
    user: {
      userId: self.userId,
      nickName: self.nickName,
      avatar: self.avatar,
      level: self.level ?? 0,
      roleId: self.roleId ?? 0,
      // 桌面版同款：其他客户端渲染徽章/VIP 标时会读这几个字段
      vip: self.vip === true,
      pfUrl: self.pfUrl || '',
      teamLogo: self.teamLogo ?? null,
      badge: Array.isArray(self.badge) ? self.badge : [],
    },
    config: buildConfig(),
    text,
    messageType: options.messageType || NimMsgType.BARRAGE_NORMAL,
    module: options.module || NimModule.LIVE,
    inTop: options.inTop === true,
    // 官方 getBaseParams 放的是 int（0=普通观众 1=房管 2=房主 3=成员本人 99=超管）
    sessionRole: self.sessionRole ?? 0,
  };
  if (options.imKey) {
    // 官方 IMChatRoom#sendMsg 会把 md5 塞进 remoteExtension，供其他客户端校验消息真伪
    ext.md5 = md5Hex(`${options.uuid || ''}${self.accid || ''}${options.imKey}`);
  }
  return ext;
}

export interface BuildLiveGiftOptions {
  /** 聊天室 id（= getLiveOne 返回的 content.roomId） */
  roomId: string | number;
  /** 直播 id（官方 sourceId） */
  sourceId: string | number;
  self: NimSelfProfile;
  /** 'live' 成员直播 / 'public' 公开直播 */
  module?: string;
  /** 收礼人（主播）口袋 userId */
  toUserId: string | number;
  /** 收礼人昵称（公屏文案与 giftInfo.acceptUser 都用它） */
  toName: string;
  giftId: string | number;
  giftName: string;
  giftNum: number;
  /** 礼物图（官方端按 picPath 取图；缺省不显示图但文案仍在） */
  giftPic?: string;
  /** 礼物总价值（鸡腿），未知传 0 */
  tpNum?: number;
}

/**
 * 构造「送礼公屏」remoteExtension（ChatMsgBuilder 的 PRESENT_NORMAL 分支）。
 *
 * ⚠️ 为什么必须有它（用户反馈 2026-09-29：「我送礼物，主播看不到」）：
 *   之前的送礼**只调了 HTTP `/gift/api/v1/gift/send`**（扣款 + 入账），
 *   而礼物公屏消息**是客户端自己往云信聊天室发的** —— 别人送的在直播间能看到，
 *   正是因为他们（官方客户端）发了这条 PRESENT_NORMAL。我们没发 → 主播和所有
 *   观众都看不到「我送的」礼物，只有我自己账单里少了鸡腿。
 *
 * 结构与我们自己的解析器 `parseChatroomMessage` 对齐（发出去的和收回来的同构，
 * 官方端也按同一套字段渲染）：giftInfo.acceptUser 用 userName/nickName，
 * 图片字段 picPath，数量 giftNum。
 */
export function buildLiveGiftExt(options: BuildLiveGiftOptions): Record<string, any> {
  const giftNum = Number(options.giftNum) || 1;
  const toName = String(options.toName || '');
  const text = `${options.self.nickName || ''} 送给 ${toName} ${giftNum}个${options.giftName}`.trim();
  const ext = buildLiveBarrageExt({
    roomId: options.roomId,
    sourceId: options.sourceId,
    text,
    self: options.self,
    module: options.module,
    messageType: NimMsgType.PRESENT,
  });
  const pic = options.giftPic || '';
  ext.giftInfo = {
    giftId: Number(options.giftId) || 0,
    giftName: options.giftName,
    giftNum,
    tpNum: Number(options.tpNum) || 0,
    picPath: pic,
    icon: pic,
    acceptUser: {
      userId: Number(options.toUserId) || 0,
      userName: toName,
      nickName: toName,
    },
  };
  return ext;
}

export interface BuildSessionTextOptions {
  /** 会话房间 id（官方 getRoomInfo().realRoomId） */
  roomId: string | number;
  /** 会话 sourceId（官方传 sessionId/fromAccount，TEXT 场景传自身 id） */
  sourceId: string | number;
  text: string;
  self: NimSelfProfile;
  /** 气泡 id，官方默认 '0' */
  bubbleId?: string;
}

/** 构造会话（私信/房间）文本消息 remoteExtension（ChatMsgBuilder.createTextMessageMap） */
export function buildSessionTextExt(options: BuildSessionTextOptions): Record<string, any> {
  const { roomId, sourceId, text, self } = options;
  return {
    fromApp: '201811',
    roomId: String(roomId),
    sourceId: String(sourceId),
    session: 0,
    bubbleId: options.bubbleId || '0',
    user: {
      userId: self.userId,
      nickName: self.nickName,
      avatar: self.avatar,
      level: self.level ?? 0,
      roleId: self.roleId ?? 0,
    },
    config: buildConfig(),
    text,
    messageType: NimMsgType.TEXT,
    module: NimModule.SESSION,
  };
}

/**
 * MD5（官方 MessageMD5Util.Md5 的等价实现）。仅用于消息防伪标记，非安全用途。
 * 说明：RN 无 node:crypto，这里用标准 RFC1321 实现，避免新增依赖。
 */
/** MD5 已抽到 src/utils/md5.ts（B站 WBI 签名也要用）；此处 import + 原样导出，既有调用方不受影响 */
import { md5Hex } from '../../utils/md5';
export { md5Hex };
