/**
 * 房间「精华消息」（偶像/房主置顶）解析规则（零依赖，可进纯 Node 单测）。
 *
 * 权威源：桌面端 yk1z/yaya_msg
 *   src/common/pocket-runtime.mjs        fetchRoomEssenceMessages → /im/api/v1/team/essence/message/list
 *   src/renderer/followed-chat-feature.js normalizeFollowedRoomEssenceMessage / getFollowedRoomEssenceText
 *   index.html                            #followed-room-essence 精华条 + 上一条/下一条 + 详情弹窗
 *
 * 这是**官方数据**：偶像在客户端把消息设为精华（置顶），移动端只负责展示，不提供用户自己置顶。
 */
export interface RoomEssenceMessage {
  id: string;
  /** 发送者口袋 userId（点详情头像跳用户主页用；桌面端 normalizeFollowedRoomEssenceMessage.userId 同款） */
  userId: string;
  sender: string;
  /** 发送者头像（源站 source.48.cn；粉丝头像同样可用） */
  avatarUrl: string;
  text: string;
  time: number;
  imageUrl: string;
  videoUrl: string;
  /** 视频封面（桌面端 getFollowedRoomEssenceVideo.poster 同款） */
  videoPoster: string;
  /** 原始消息类型（TEXT/IMAGE/VIDEO/…），决定详情里渲染文本还是媒体 */
  msgType: string;
}

/** 详情弹窗里该条消息的媒体类型（纯判断，测试可锁） */
export function essenceMediaKind(item: Pick<RoomEssenceMessage, 'imageUrl' | 'videoUrl'> | null | undefined): 'image' | 'video' | 'text' {
  if (item?.videoUrl) return 'video';
  if (item?.imageUrl) return 'image';
  return 'text';
}

/**
 * 未看过的精华消息（按 id 判重）。
 *
 * 用户要求（2026-11-09）：「看过的精华消息不要再主动弹窗」——
 * 桌面端没有自动弹窗（只有常驻横幅），所以这条口径是我们自己定的：
 * 把「已经弹给用户看过的 id」落盘，只有出现**新 id** 才自动弹。
 */
export function essenceUnseenIds(items: RoomEssenceMessage[], seenIds: string[] | undefined): string[] {
  const seen = new Set((seenIds || []).map((v) => String(v)));
  const out: string[] = [];
  for (const item of items || []) {
    const id = String(item?.id || '');
    if (!id || seen.has(id)) continue;
    out.push(id);
  }
  return out;
}

/** 频道 key：精华消息按大房间 channelId / 小房间 yklzId 分别缓存 */
export function roomPinnedKey(channelId: unknown): string {
  return String(channelId ?? '').trim();
}

/** 文本归一：空白折叠 + 限长（精华条只放得下一行） */
export function normalizePinnedText(text: unknown, max = 200): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseObject(value: unknown): any {
  if (value && typeof value === 'object') return value;
  let cur = typeof value === 'string' ? value.trim() : '';
  for (let i = 0; i < 2 && /^[\[{]/.test(cur); i += 1) {
    try {
      const next = JSON.parse(cur);
      if (!next || typeof next !== 'object') return {};
      return next;
    } catch {
      return {};
    }
  }
  return {};
}

function firstText(obj: any, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

function absoluteMediaUrl(raw: string, host: string): string {
  const url = String(raw || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.includes('48.cn')) return `https://${url.replace(/^\/+/, '')}`;
  return `https://${host}${url.startsWith('/') ? '' : '/'}${url}`;
}

const TYPE_LABEL: Record<string, string> = {
  IMAGE: '[图片消息]',
  EXPRESSIMAGE: '[表情消息]',
  AUDIO: '[语音消息]',
  VIDEO: '[视频消息]',
  FLIPCARD: '[翻牌消息]',
  LIVEPUSH: '[直播消息]',
  SHARE_LIVE: '[直播分享]',
  GIFTREPLY: '[礼物回复]',
  REPLY: '[回复消息]',
};

/** 精华消息正文：与桌面端 getFollowedRoomEssenceText 同款多字段兜底 */
export function essenceMessageText(message: any): string {
  const type = String(message?.msgType || message?.messageType || '').toUpperCase();
  const source = message?.bodys ?? message?.msgContent ?? message?.text ?? '';
  const raw = typeof source === 'string' ? source.trim() : '';
  if (!raw && (!source || typeof source !== 'object')) return TYPE_LABEL[type] || `[${type || '消息'}]`;
  if (type === 'TEXT') return normalizePinnedText(raw || firstText(source, ['text', 'content']));
  const body = typeof source === 'object' ? source : parseObject(raw);
  const text = firstText(body, ['text', 'content', 'replyText', 'message', 'title', 'desc']);
  if (text) return normalizePinnedText(text);
  return TYPE_LABEL[type] || `[${type || '消息'}]`;
}

/** 从接口返回的 content（或数组）归一成精华消息列表；脏数据逐条过滤，不整批失效 */
export function normalizeEssenceList(raw: unknown, limit = 50): RoomEssenceMessage[] {
  const content: any = Array.isArray(raw) ? { essenceMessageList: raw } : parseObject(raw);
  const list = Array.isArray(content?.essenceMessageList)
    ? content.essenceMessageList
    : Array.isArray(content?.list) ? content.list
      : Array.isArray(content?.messages) ? content.messages
        : Array.isArray(content?.data?.content?.essenceMessageList) ? content.data.content.essenceMessageList
          : [];
  const out: RoomEssenceMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const ext = parseObject(item.extInfo ?? item.ext);
    const user = ext.user || item.user || {};
    const type = String(item.msgType || item.messageType || '').toUpperCase();
    const body = parseObject(item.bodys ?? item.msgContent);
    const isImage = type === 'IMAGE' || type === 'EXPRESSIMAGE';
    const imageRaw = isImage
      ? (type === 'EXPRESSIMAGE' ? (body.expressImgInfo?.emotionRemote || body.url || '') : (body.url || body.imageUrl || body.imgUrl || ''))
      : '';
    const videoRaw = type === 'VIDEO' ? (body.url || body.videoUrl || body.videoPath || '') : '';
    const videoPosterRaw = type === 'VIDEO'
      ? (body.coverUrl || body.cover || body.firstFrame || body.picUrl || '')
      : '';
    const text = essenceMessageText(item);
    if (!text) continue;
    out.push({
      id: String(item.msgIdClient || item.msgIdServer || item.msgId || item.msgTime || out.length),
      userId: String(user.userId || user.id || item.senderUserId || item.senderId || '').trim(),
      sender: normalizePinnedText(user.nickName || user.nickname || user.userName || item.senderName || '成员', 40),
      // 头像走 source.48.cn（桌面端 normalizeFollowedSourceUrl 同款口径，与图片源站不同）
      avatarUrl: absoluteMediaUrl(String(user.avatar || user.avatarUrl || item.avatar || ''), 'source.48.cn'),
      text,
      time: Number(item.msgTime || item.sendTime || item.createTime) || 0,
      imageUrl: absoluteMediaUrl(imageRaw, 'source3.48.cn'),
      videoUrl: absoluteMediaUrl(videoRaw, 'mp4.48.cn'),
      videoPoster: absoluteMediaUrl(videoPosterRaw, 'source3.48.cn'),
      msgType: type,
    });
    if (out.length >= limit) break;
  }
  return out;
}
