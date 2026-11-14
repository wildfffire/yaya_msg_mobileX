/**
 * 房间通知文案的纯规则（零依赖，回调注入，可单测）。
 *
 * 从 messagePollers.pollRooms 单侧循环里抽出（用户 2026-11-13「逐步拆 pollRooms」）：
 * 通知文案只跟「这一批偶像新消息」有关，和计数 / 游标 / 总账无关，
 * 放在纯函数里能单独锁住「多条文案」「空正文回退」「取最新一条」三个口径。
 */
export interface RoomNotifyContentOptions {
  /** 消息正文（调用方传 messageText，保留项目统一的 emoji 替换） */
  textOf: (msg: any) => string;
  /** 正文为空时的兜底预览（调用方传 messagePreview） */
  previewOf: (msg: any) => string;
  /** 服务器消息时间（ms） */
  timeOf: (msg: any) => number;
  /** 翻译函数（调用方传 i18n 的 translate） */
  t: (key: string, vars?: any) => string;
}

export interface RoomNotifyContent {
  /** 这批消息里时间最新的一条（时间相等时保留靠前的那条，与原 reduce 一致） */
  newest: any | null;
  preview: string;
  body: string;
}

/** 组装房间通知文案：单条用正文，多条用「有 N 条新消息：正文」 */
export function buildRoomNotifyContent(
  messages: any[] | undefined | null,
  opts: RoomNotifyContentOptions,
): RoomNotifyContent {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return { newest: null, preview: '', body: '' };
  let newest = list[0];
  let newestTime = Number(opts.timeOf(newest)) || 0;
  for (const msg of list) {
    const t = Number(opts.timeOf(msg)) || 0;
    if (t > newestTime) {
      newest = msg;
      newestTime = t;
    }
  }
  const preview = opts.textOf(newest) || opts.previewOf(newest) || opts.t('新消息');
  const body = list.length > 1
    ? `${opts.t('有 {n} 条新消息', { n: list.length })}：${preview}`
    : preview;
  return { newest, preview, body };
}
