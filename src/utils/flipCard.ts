/**
 * 口袋「翻牌」消息的问答提取（用户 2026-09-30 报「房间的翻牌消息显示不出来」）。
 *
 * 背景：成员公开翻牌在房间公屏上是一条普通消息，但**字段写法不止一种**：
 *   - 顶层 `answerContent / answer / answerText / replyContent`
 *   - `flipCardInfo` / `filpCardInfo`（官方历史上就把 flip 拼成了 filp）
 *   - `flipCardAudioInfo` / `flipCardVideoInfo`（语音/视频翻牌，答案藏在 audioInfo/videoInfo 里）
 *   - 提问在 `question / askContent / questionContent / content`
 * 而且 `answer` 可能是**字符串、对象、或 JSON 字符串**（口袋三种都出现过）。
 *
 * ⚠️ 老实现（RoomChatMessageRow）的坑：直接用 pickText 取 answer，
 * 而 `pickText` 对对象会 `String(value)` → 拿到 `"[object Object]"` →
 * JSON.parse 失败后又被当成普通文本 → 气泡里真的显示 `[object Object]`。
 * 这里改成「先看类型再取值」：对象按已知键递归取文本，JSON 串解析后再取。
 *
 * ⚠️ 与 utils/data.ts 的 messagePayload 口径保持一致，但**故意不 import 它**：
 * data.ts 要 import 本模块（messageText 的翻牌兜底），反向引用会形成循环依赖。
 */
import { replaceEmojiText } from './emoji';

/** 消息体（与 utils/data.ts 的 messagePayload 同一套取值顺序；改动请两边同步） */
function payloadOf(item: any): any {
  const raw = item?.bodys ?? item?.body ?? item?.msgContent ?? item?.content ?? item?.message;
  let body: any = raw;
  if (typeof raw === 'string') {
    try { body = JSON.parse(raw); } catch { body = raw; }
  }
  if (body?.message) {
    let inner = body.message;
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { /* 保持原样 */ } }
    return inner;
  }
  if (body?.msg) {
    let inner = body.msg;
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { /* 保持原样 */ } }
    return inner;
  }
  return body;
}

/** 从任意值里挖出可读文本：字符串（含 JSON 串）/ 对象（已知键）/ 数字 */
function asText(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return '';
    // JSON 字符串：解析成功再取里面的文本（口袋的 answer 常是 JSON 串）
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        const inner = asText(JSON.parse(s));
        if (inner) return inner;
      } catch { /* 不是合法 JSON：按普通文本用 */ }
    }
    return s;
  }
  if (typeof value === 'object') {
    // 已知的「文本容器」键，按可能性排序（url/audioUrl/videoUrl 放在最后，避免把文件地址当正文）
    const keys = [
      'text', 'content', 'answer', 'answerContent', 'answerText', 'replyContent',
      'message', 'msg', 'title',
      'url', 'audioUrl', 'videoUrl',
    ];
    for (const key of keys) {
      const inner = asText((value as any)[key]);
      if (inner) return inner;
    }
    return '';
  }
  return String(value);
}

function firstText(candidates: any[]): string {
  for (const c of candidates) {
    const s = asText(c);
    if (s) return s;
  }
  return '';
}

/** 翻牌嵌套体（兼容官方把 flip 拼成 filp 的历史写法 + 语音/视频两种形态） */
function flipInfo(payload: any): any {
  return payload?.flipCardInfo || payload?.filpCardInfo
    || payload?.flipCardAudioInfo || payload?.filpCardAudioInfo
    || payload?.flipCardVideoInfo || payload?.filpCardVideoInfo
    || payload?.flipCard || payload?.filpCard
    || null;
}

export interface FlipCardTexts {
  /** 提问（可能为空） */
  question: string;
  /** 成员的回答（可能为空） */
  answer: string;
}

/** 提取翻牌的「提问 / 回答」（两者都空表示这条消息不是翻牌或字段不认识） */
export function flipCardTexts(item: any): FlipCardTexts {
  const payload: any = payloadOf(item) || {};
  const info: any = flipInfo(payload) || {};
  const question = firstText([
    info.question, info.askContent, info.questionContent, info.content,
    payload.question, payload.askContent, payload.questionContent,
  ]);
  const answer = firstText([
    info.answer, info.answerContent, info.answerText, info.replyContent,
    // 语音/视频翻牌：答案本体在 audioInfo / videoInfo 里
    info.audioInfo, info.videoInfo,
    payload.answerContent, payload.answer, payload.answerText, payload.replyContent,
    item?.answerContent, item?.answer,
  ]);
  return { question, answer };
}

/** 这条消息是不是翻牌（类型命中或带翻牌字段） */
export function isFlipCard(item: any): boolean {
  const payload: any = payloadOf(item) || {};
  const type = String(
    item?.msgType || payload?.msgType || payload?.messageType || payload?.type || '',
  ).toUpperCase();
  if (type.includes('FLIP')) return true;
  return !!flipInfo(payload);
}

/** 直接给出「该显示什么」：回答优先，其次提问（房间气泡用） */
export function flipCardDisplayText(item: any): string {
  const { question, answer } = flipCardTexts(item);
  // 与项目其它拼装文案一致：出口统一过一遍表情替换
  if (answer) return replaceEmojiText(answer);
  if (question) return replaceEmojiText(question);
  return '';
}

export default flipCardTexts;
