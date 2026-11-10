/**
 * 房间页的「时间与文本」基础原语（拆分第 2 步的下沉层）。
 *
 * 为什么单独成文件、而且**一个 import 都不要**：
 *   messageRules.ts 依赖 utils/data → i18n → react/store，最终会拖进 react-native，
 *   在纯 Node 里**加载不起来**，于是它没法自动化测试。
 *   而这里放的是**零依赖**的纯函数 —— 其中「秒/毫秒归一」与「消息排序」恰好是历史上 bug 最多的两处：
 *     · 接口时间单位不统一（云信 ms / 官方接口多为秒）→ 未读永远不亮；
 *     · 19 位 liveId 被当成时间戳 → 排序错乱。
 *   把它们隔离在这一层，就能用 scripts/room-time-rules.test.mjs 钉死，且无需任何测试框架。
 */

/** 时间字段的候选键名（不同接口用不同键，按顺序尝试） */
export const KNOWN_TIME_KEYS = ['msgTime', 'messageTime', 'ctime', 'time'];

/** 通用文本限位（房间名等） */
export function capText(text: string, max = 18) {
  const clean = (text || '').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function deepFindText(value: any, keys: string[], depth = 0): string {
  if (!value || depth > 5) return '';
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindText(item, keys, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of keys) {
    const direct = value[key];
    if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct);
  }
  for (const child of Object.values(value)) {
    const found = deepFindText(child, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

/**
 * 时间戳归一（秒 → 毫秒）。
 * 不同接口的 msgTime / ctime 单位不一致（云信是 ms、部分官方接口是秒），
 * 直接比较会得出「永远早于上次已读」→ 未读永远不显示。
 *
 * ⚠️ 第 2 步搬运时它被一并搬来：`asTimestamp` / `getMessageTime` 以及房间「未读基线」都依赖它，
 *    留在原文件会造成「新模块反向 import 旧文件」的坏依赖，所以把「时间归一」集中在这一层做底座。
 */
export function normMs(t: number): number {
  const n = Number(t) || 0;
  if (n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/** 值像「消息时间戳」才接受：归一后落在 2001-09 ~ 2096 之间（排除 liveId 这类 19 位超大 id） */
export function asTimestamp(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ms = normMs(n);
  return ms >= 1e12 && ms <= 4e12 ? ms : 0;
}

/**
 * 取消息时间（返回**毫秒**，已由 normMs 归一）。
 *
 * ⚠️ 为什么写这么啰嗦：房间列表的「最新消息」来自
 * `/im/api/v1/team/classic/last/message/get`，该接口**官方没有字段文档**
 *（docs/API_RESEARCH.md 标注「未找到确切公开资料」），仓库里另一个消费者
 *（src/services/memberData.ts）也只读 serverId/channelId、不读时间。
 * 以前这里只赌 `msgTime | messageTime | ctime | time` 四个扁平键：
 * 一旦真实键名不同（sendTime/lastTime…）或时间藏在子对象里，就恒返回 0
 * → 未读判据 `lastActivity > lastRead` 永远不成立 → **房间「有新消息」永远不亮**。
 * 现在三层兜底，尽量不依赖猜：
 *   1) 已知扁平键
 *   2) 任意深度 ≤3 内、键名像时间的字段（取其中最大的时间戳 —— 消息自身的
 *      时间通常是整包里最新的时间）
 *   3) 一层子对象（message/lastMsg/content/body/data）里的已知键
 */
export function getMessageTime(item: any): number {
  if (!item || typeof item !== 'object') return 0;
  // 1) 已知扁平键
  for (const key of KNOWN_TIME_KEYS) {
    const t = asTimestamp(item[key]);
    if (t) return t;
  }
  /**
   * 2) 键名像时间的字段（含嵌套），取最大值。
   *
   * ⚠️ 必须排除「区间/截止类」键名并加上界（用户 2026-09-30：「房间也容易刷没消息」）。
   * 以前只要键名含 time/date 就参与取最大 —— 一条带 `endTime/expireTime/startTime` 的卡片
   * （直播卡、预约卡）会把该条消息的时间算成**未来**：排序把它钉在索引 0，
   * 而 15s 静默刷新的「有没有更新」判据是 `新消息时间 > 列表第一条时间`
   *（FollowedRoomsScreen 的 hasFresh）→ 从此**永久为 false**，
   * 表现就是「房间刷不出新消息，切房/下拉才看得到」。
   */
  let best = 0;
  const now = Date.now();
  const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
  /** 区间/截止类键名：不是「这条消息什么时候发的」，不参与取最大 */
  const RANGE_KEY_RE = /^(start|begin|end|expire|expired|deadline)/i;
  const scan = (node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 3) return;
    for (const [key, value] of Object.entries(node)) {
      if (/time|timestamp|date/i.test(key) && !RANGE_KEY_RE.test(key)) {
        const t = asTimestamp(value);
        // 未来时间（容差 5 分钟）不是消息发送时间：宁可退回其它候选，也不要把时间钉在未来
        if (t && t <= now + FUTURE_TOLERANCE_MS && t > best) best = t;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) scan(value, depth + 1);
    }
  };
  scan(item, 0);
  if (best) return best;
  // 3) 一层子对象里的已知键
  for (const holder of ['message', 'lastMsg', 'lastMessage', 'content', 'body', 'data']) {
    const child = item[holder];
    if (child && typeof child === 'object') {
      for (const key of KNOWN_TIME_KEYS) {
        const t = asTimestamp(child[key]);
        if (t) return t;
      }
    }
  }
  return 0;
}

export function sortMessagesNewestFirst<T>(list: T[]): T[] {
  return list.slice().sort((a: any, b: any) => getMessageTime(b) - getMessageTime(a));
}
