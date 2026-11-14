/**
 * 房间未读判定日志的纯格式化（零依赖，回调注入）。
 *
 * 从 messagePollers.pollRooms 单侧循环里抽出：这两行日志是排查
 * 「没判新 / 房主没认出 / 总账拦下」的唯一线索，格式必须逐字稳定，
 * 但计算本身只读消息与几个集合，放在纯函数里更好锁。
 */

export interface UnreadSampleOptions {
  idOf: (msg: any) => string;
  isChat: (msg: any) => boolean;
  isIdol: (msg: any) => boolean;
  isServerOwner: (msg: any) => boolean;
  isClaimed: (msg: any) => boolean;
  /** 最多采样几条，默认 5 */
  max?: number;
}

/**
 * `id后缀:chat|other:idol|fan:server|local:claimed|new`
 * 例：`a1b2c3d4:chat:idol:server:new`
 */
export function formatRoomUnreadSample(
  messages: any[] | undefined | null,
  opts: UnreadSampleOptions,
): string {
  const list = Array.isArray(messages) ? messages : [];
  const max = Number.isFinite(opts.max) && (opts.max as number) > 0 ? Math.floor(opts.max as number) : 5;
  return list.slice(0, max).map((msg) => {
    const mid = opts.idOf(msg);
    return `${String(mid).slice(-8)}:${opts.isChat(msg) ? 'chat' : 'other'}`
      + `:${opts.isIdol(msg) ? 'idol' : 'fan'}`
      + `:${opts.isServerOwner(msg) ? 'server' : 'local'}`
      + `:${opts.isClaimed(msg) ? 'claimed' : 'new'}`;
  }).join(' ');
}

export interface UnreadSenderOptions {
  idOf: (msg: any) => string;
  senderOf: (msg: any) => { id?: string; name?: string } | null | undefined;
  timeOf: (msg: any) => number;
  /** 最多采样几条，默认 3 */
  max?: number;
}

/** `id后缀 id=xxx nick=yyy t=时间`（0 命中时用来区分「真不是房主」与「是房主但没对上」） */
export function formatRoomUnreadSenders(
  messages: any[] | undefined | null,
  opts: UnreadSenderOptions,
): string {
  const list = Array.isArray(messages) ? messages : [];
  const max = Number.isFinite(opts.max) && (opts.max as number) > 0 ? Math.floor(opts.max as number) : 3;
  return list.slice(0, max).map((msg) => {
    const p = opts.senderOf(msg);
    return `${String(opts.idOf(msg)).slice(-8)} id=${p?.id || '-'} nick=${p?.name || '-'} t=${opts.timeOf(msg)}`;
  }).join(' | ');
}
