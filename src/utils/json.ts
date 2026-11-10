/**
 * 宽松 JSON 解析与共享正则常量。
 *
 * 背景：口袋48 系列接口会把 15 位以上的超大数字（成员/房间 ID）当 JSON number 返回，
 * Hermes 的 JSON.parse 对该量级整数会丢精度甚至直接失败。项目里曾把
 * 「给超大数字补引号」这段修复正则**写了 3 遍**
 * （utils/network.ts、api/pocket48.ts、api/officialMedia.ts），已统一到这里。
 */

/** 匹配 JSON 中「冒号后的裸超大整数」并补引号：`:"123456789012345"` */
export const BIG_NUMBER_FIX_RE = /:\s*([0-9]{15,})/g;

/**
 * 「今日已签到」判定（用于签到接口的 message 文案）。
 * 原文案：已签到｜重复签到｜已经签到｜已领取｜明天再来
 * 原来在 autoCheckin.ts 与 pocket48.ts 各写了一份完全相同的正则。
 */
export const ALREADY_CHECKED_MESSAGE_RE = /\u5df2\u7b7e\u5230|\u91cd\u590d\u7b7e\u5230|\u5df2\u7ecf\u7b7e\u5230|\u5df2\u9886\u53d6|\u660e\u5929\u518d\u6765/;

/**
 * 「已签到」状态判定（用于签到接口返回体的 JSON 串）。
 * 原文案：已签到｜已经签到｜今日已签
 * 注意与 MESSAGE_RE 的候选词不同（少「重复签到/已领取/明天再来」，多「今日已签」），
 * 是两套独立语义，不要合并。
 */
export const ALREADY_CHECKED_STATE_RE = /\u5df2\u7b7e\u5230|\u5df2\u7ecf\u7b7e\u5230|\u4eca\u65e5\u5df2\u7b7e/;

/**
 * 解析可能含超大数字的 JSON 文本。
 * 先按标准解析；失败则对裸超大整数补引号后重试；仍失败返回原文本（调用方可自行判断）。
 */
export function parseLooseJson(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(BIG_NUMBER_FIX_RE, ':"$1"'));
    } catch {
      return text;
    }
  }
}

/**
 * **精确保留**超大整数的 JSON 解析：先给 15 位以上裸整数补引号，再 parse。
 *
 * ⚠️ 与 parseLooseJson 的关键区别：parseLooseJson 是「先 JSON.parse，失败才补引号」，
 * 而 15~17 位整数（口袋的 liveId / 公演 businessId 都是这个量级）JSON.parse **会成功但丢精度**
 * （1313111009176391680 → 1313111009176391700）——永远不会走到补引号分支。
 *
 * 需要把 ID 当**字符串标识**用的接口（如公演排期 businessId 实为公演 liveId，
 * 见 services/performanceSchedule）必须用它，否则拿到的 ID 差几个数位、查不到详情。
 */
export function parseJsonExact(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text.replace(BIG_NUMBER_FIX_RE, ':"$1"'));
  } catch {
    return parseLooseJson(text);
  }
}

/** 从弹幕/消息正文里挑出「人话」字段的候选路径（按命中率排序） */
const TEXT_PAYLOAD_KEYS = ['text', 'content', 'msg', 'message', 'body', 'bodys', 'title', 'desc', 'description'];

function pickTextDeep(node: any, depth = 0): string {
  if (!node || depth > 2) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node !== 'object') return '';
  if (Array.isArray(node)) {
    return node.map((item) => pickTextDeep(item, depth + 1)).filter(Boolean).join('');
  }
  for (const key of TEXT_PAYLOAD_KEYS) {
    const value = (node as Record<string, any>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const key of ['message', 'data', 'content', 'bodys']) {
    const nested = pickTextDeep((node as Record<string, any>)[key], depth + 1);
    if (nested) return nested;
  }
  return '';
}

/**
 * 弹幕正文偶尔整条是一个 JSON —— 用户看到的就是「一串代码」。
 *
 * 成因：云信聊天室里，custom 消息的 attach（属性 3）有时会被当成 text 下发，
 * 或部分端构造消息时把整个 remoteExtension 塞进了内容字段。
 * 这里尽力把里面的正文还原出来；**还原不出就返回空串**（交给调用方丢弃该条），
 * 也不把原始 JSON 糊到屏幕上。
 *
 * 非 JSON 输入（含 `[流泪]` 这类表情短码 —— JSON.parse 必然失败）**原样返回**。
 */
export function textFromJsonPayload(raw: string): string {
  if (!raw || typeof raw !== 'string') return typeof raw === 'string' ? raw : '';
  const text = raw.trim();
  // 快速排除：不是 JSON 起手式就直接放行（绝大多数弹幕走这条路，零开销）
  if (!text || (text[0] !== '{' && text[0] !== '[')) return raw;
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return raw; // 只是恰好以 [ 开头的普通文本（如 `[流泪]`），别动它
  }
  if (parsed === null || parsed === undefined) return '';
  return pickTextDeep(parsed);
}
