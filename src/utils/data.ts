import { translate } from '../i18n';
import { replaceEmojiText } from './emoji';
import { flipCardDisplayText, isFlipCard } from './flipCard';
import { getPath, pickText, normalizeUrl } from './pathPick';

/**
 * 三个纯取值函数已搬到 `./pathPick`（唯一实现），这里原样再导出 ——
 * 目的：让**不依赖 react / i18n 的纯规则层**也能复用它们并进单测
 * （`data.ts` 顶部 import i18n，被 scripts 编译后在纯 Node 里会直接崩）。
 */
export { getPath, pickText, normalizeUrl };

export function firstArray(...values: any[]): any[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function unwrapList(res: any, keys: string[] = []): any[] {
  const candidates = keys.map((key) => getPath(res, key));
  const direct = firstArray(
    ...candidates,
    res,
    res?.list,
    res?.data,
    res?.content,
    res?.content?.list,
    res?.content?.data,
    res?.content?.messageList,
    res?.content?.userMessageList,
    res?.content?.questions,
    res?.content?.nftList,
    res?.content?.liveList,
    res?.content?.roomList,
    res?.content?.records,
  );
  if (direct.length) return direct;

  const seen = new Set<any>();
  const queue = [res?.content, res?.data, res];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) return node;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return [];
}

/**
 * 从播放地址里抽 liveId（红播/VOD 地址把 liveId 直接写在路径里）。
 *
 * 实测（2026-09-26 打接口）：成员回放地址形如
 *   https://cychengyuan-vod.48.cn/1/20220216/cy/700777459261181952-ugm0ig8iuan6f6b8xe52.m3u8
 * 其中 `700777459261181952` 就是该场的 liveId。
 *
 * 用途：房间里的**回放**多半是从消息卡片点开的，卡片里不一定带 liveId →
 * `getLiveOne` 拿不到详情 → 「在线人数」永远不显示。有了这个兜底就不依赖卡片内容。
 * 而回放详情的 `onlineNum` 是**真有值**的（实测 2260 / 4289 / 5278），只是需要 liveId 才取得到。
 *
 * 只认 15~20 位的纯数字段，且两侧必须是分隔符：避免把日期（20220216）、
 * 端口号、画质参数等误当成 id。
 */
export function liveIdFromUrl(url: string): string {
  const matched = String(url || '').match(/(?:^|[/=_-])(\d{15,20})(?:[-/._?&#]|$)/);
  return matched ? matched[1] : '';
}

export function parseMaybeJson(value: any): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch {
    const fixed = value.replace(/:\s*([0-9]{15,})/g, ':"$1"');
    try { return JSON.parse(fixed); } catch { return null; }
  }
}

/**
 * 表情短码 → emoji 的码表与替换函数已抽到 `utils/emoji.ts`。
 *
 * 为什么搬走：原表只有 90 条，实测弹幕里最高频的 `[流泪] [呲牙] [调皮]
 * [偷笑] [流汗] [爱情]` 全都不在里面（=「表情显示成文字」的根因）；
 * 且直播弹幕（云信 codec）与录播弹幕（utils/danmaku）都需要它，
 * 放在 data.ts 里会让这两条链路引不到。这里原样再导出，既有调用方不受影响。
 */
export { EMOJI_MAP, replaceEmojiText } from './emoji';

export function messagePayload(item: any): any {
  const raw = item?.bodys ?? item?.body ?? item?.msgContent ?? item?.content ?? item?.message;
  const body = parseMaybeJson(raw);
  if (body?.message) return parseMaybeJson(body.message);
  if (body?.msg) return parseMaybeJson(body.msg);
  if (body) return body;
  if (typeof raw === 'string') return raw;
  return null;
}

/**
 * 房间消息正文。
 *
 * 出口统一过一次表情替换：原先只有部分分支（纯文本 / 带 caption 的媒体消息）替换，
 * 「回复 xxx」「送礼物」等拼装出来的文案漏了 —— 成员发 `[流泪]` 回复时仍是一串代码。
 * 放在出口做一次，任何新增分支都不会再漏。
 */
export function messageText(item: any): string {
  return replaceEmojiText(messageTextInner(item));
}

function messageTextInner(item: any): string {
  const body = messagePayload(item);
  const type = String(item?.msgType || body?.msgType || body?.messageType || body?.type || '').toUpperCase();

  // Media types: don't return raw body (file names, URLs) — let media card handle it
  if (type === 'AUDIO' || type === 'VIDEO' || type === 'IMAGE' || type === 'LIVEPUSH' || type === 'SHARE_LIVE' || type === 'EXPRESSIMAGE' || type === 'EXPRESS') {
    // Only return text if there's a meaningful caption alongside the media
    if (body && typeof body === 'object') {
      const caption = (body as any).text || (body as any).caption || (body as any).description || '';
      if (typeof caption === 'string' && caption.trim() && !/^(https?:\/\/|voice_|video_|img_|live_)/i.test(caption)) {
        return replaceEmojiText(caption);
      }
    }
    return '';
  }

  if (typeof body === 'string') return replaceEmojiText(body);

  if (type === 'TEXT') {
    if (body && typeof body === 'object') {
      const b = body as Record<string, any>;
      const t = b.text || b.bodys || b.body || b.msgContent || b.content;
      if (t) return replaceEmojiText(String(t));
    }
    // Fallback: try raw fields on item directly
    const raw = item?.bodys ?? item?.body ?? item?.msgContent ?? item?.content ?? item?.message ?? '';
    if (typeof raw === 'string' && raw.trim() && !raw.startsWith('{') && !raw.startsWith('[')) {
      return replaceEmojiText(raw);
    }
    if (typeof raw === 'number') return replaceEmojiText(String(raw));
    if (typeof raw === 'object') {
      const r = raw as Record<string, any>;
      const t2 = r.text || r.bodys || r.body || r.msgContent || r.content;
      if (t2) return replaceEmojiText(String(t2));
    }
  }

  /**
   * 翻牌（成员公开翻牌）：用户 2026-09-30 反馈「房间的翻牌消息显示不出来」。
   *
   * 以前没有这个分支 → 既没有回答也没落到文本分支时，末尾兜底会输出字面量 `[FLIPCARD]`；
   * 即使命中 REPLY 分支，也只显示「回复 xxx」而看不到成员的**回答内容**（翻牌最该看的部分）。
   * 放在 REPLY/GIFT 之前：翻牌优先展示回答，字段解析见 utils/flipCard.ts。
   */
  if (isFlipCard(item)) {
    const flip = flipCardDisplayText(item);
    if (flip) return flip;
  }

  const giftInfo = body?.giftInfo || body?.giftReplyInfo?.giftInfo || body?.bodys?.giftInfo;
  const isGift = type.includes('GIFT') || (giftInfo && !type.includes('LIVE')) || String(item?.msgType) === '7';

  const replyInfo = body?.replyInfo || body?.giftReplyInfo || (body?.bodys as any)?.replyInfo || (body?.bodys as any)?.giftReplyInfo;
  const isReply = type.includes('REPLY') || !!replyInfo;
  if (isReply) {
    const rName = replyInfo?.replyName || '';
    const replyText = replyInfo?.text || pickText(body, ['text', 'body.text', 'content', 'replyContent']);
    if (rName && replyText) return `回复 ${rName}：${replyText}`;
    if (replyText) return replyText;
    if (rName) return `回复 ${rName}`;
  }

  if (isGift) {
    const source = giftInfo || body || {};
    const giftName = pickText(source, ['giftName', 'name', 'giftInfo.giftName'], translate('礼物'));
    const giftNum = pickText(source, ['giftNum', 'num', 'count', 'giftInfo.giftNum'], '1');
    const gr = body?.giftReplyInfo || {};
    const replyText = gr.replyName || body?.replyName || body?.text || body?.body || '';
    const prefix = replyText && typeof replyText === 'string' && replyText.trim() ? `${replyText.trim()} · ` : '';
    return `${prefix}${translate('送出礼物')}：${giftName} x${giftNum}`;
  }
  const text = pickText(body, [
    'text',
    'message.text',
    'msg.text',
    'content.text',
    'body.text',
    'bodys.text',
    'title',
  ]);
  if (!text && body && typeof body === 'object') {
    // search deeper for text in nested objects
    for (const [_key, val] of Object.entries(body as Record<string, any>)) {
      if (typeof val === 'string' && val.trim() && !val.startsWith('http') && !val.startsWith('{') && val.length < 500) {
        return replaceEmojiText(val);
      }
      if (val && typeof val === 'object') {
        const t = pickText(val, ['text', 'body', 'content', 'message', 'title', 'description']);
        if (t) return replaceEmojiText(String(t));
        // try first string value of nested object
        for (const [_k2, v2] of Object.entries(val)) {
          if (typeof v2 === 'string' && v2.trim() && !v2.startsWith('http') && v2.length < 500) {
            return replaceEmojiText(v2);
          }
        }
      }
      if (typeof val === 'number') {
        return replaceEmojiText(String(val));
      }
    }
  }
  if (text) return replaceEmojiText(String(text));
  const url = pickText(body, ['url', 'message.url', 'msg.url', 'audioUrl', 'videoUrl', 'imageUrl']);
  if (url) {
    if (type.includes('AUDIO') || /\.(mp3|m4a|aac|amr|wav)(\?|$)/i.test(url)) return translate('[语音消息]');
    if (type.includes('VIDEO') || /\.(mp4|mov|m4v|3gp)(\?|$)/i.test(url)) return translate('[视频消息]');
    if (type.includes('IMAGE') || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) return translate('[图片消息]');
    return translate('[链接消息]');
  }
  return item?.msgType && !/^(LIVE|SHARE|TEXT)$/i.test(String(item.msgType)) ? `[${item.msgType}]` : '';
}

export function messageImageUrl(item: any): string {
  const body = messagePayload(item);
  return normalizeUrl(pickText(body, [
    'url',
    'message.url',
    'msg.url',
    'imageUrl',
    'cover',
  ]));
}

export function errorMessage(error: any): string {
  if (!error) return translate('未知错误');
  if (typeof error === 'string') return error;
  // 统一出口：把工具/网络层抛出的中文错误过一次字典（有 key 则翻译，
  // 无 key 或动态内容原样回退；en/ja/ko 用户不再看到中文报错）
  const raw = error?.message || error?.msg || JSON.stringify(error).slice(0, 240);
  return translate(String(raw));
}
