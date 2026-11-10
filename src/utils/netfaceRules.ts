/**
 * 现场互动（口袋「云握手」/ netface）场次解析规则（零依赖，可进纯 Node 单测）。
 *
 * 权威源：桌面端 yk1z/yaya_msg
 *   src/common/netface-model.js      events() / session() / statusText / ticketId
 *   src/renderer/netface-feature.js  renderList() / waitTime() / reservationTime()
 *
 * 移动端只做「看活动 → 看场次 → 预约/取消 → 看排队」这条主线；
 * 握手视频通话（ZEGO RTC）不在本次范围内（需要额外原生 SDK）。
 */

/** 口袋返回的场次状态（桌面端 netface-model.statusText 原样搬过来） */
export const NETFACE_STATUS_TEXT = ['不可预约', '可预约', '排队中', '等待进入', '等待进入', '超时未入场'];

export function netfaceStatusText(status: unknown): string {
  // ⚠️ null/'' 不能当 0：Number(null) === 0 会把「没返回状态」显示成「不可预约」
  if (status === null || status === undefined || status === '') return '状态待确认';
  const n = Number(status);
  if (!Number.isFinite(n) || n < 0 || n >= NETFACE_STATUS_TEXT.length) return '状态待确认';
  return NETFACE_STATUS_TEXT[n];
}

export interface NetfaceTicket {
  ticketId: string;
  ticketName: string;
  raw: any;
}

/** 活动列表：只保留 ticketId 是正整数的条目（脏数据不整批失效） */
export function netfaceTickets(content: unknown): NetfaceTicket[] {
  const list = Array.isArray(content) ? content : [];
  const out: NetfaceTicket[] = [];
  for (const item of list as any[]) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.ticketId ?? '').trim();
    if (!/^\d{1,32}$/.test(id) || id === '0') continue;
    out.push({ ticketId: id, ticketName: String(item.ticketName || item.name || `活动 ${id}`).trim(), raw: item });
  }
  return out;
}

export interface NetfaceEventItem {
  eventId: string;
  /** 原始状态码（1=可预约，2=排队中，3/4=等待进入，5=超时未入场） */
  status: number;
  statusText: string;
  /** 是否已预约（桌面端：出现在 alreadyReservations 里，或状态 >= 2） */
  ordered: boolean;
  starId: string;
  starName: string;
  starAvatar: string;
  teamName: string;
  groupName: string;
  groupId: string;
  /** 开始时间（毫秒字符串，可能为 0/空） */
  startTime: string;
  /** 预约开放时间（毫秒字符串） */
  queueStartTime: string;
  /** 队列人数（未预约时展示） */
  queueSize: string;
  /** 排队号（已预约时展示） */
  queueNumber: string;
  /** 已预约次数 */
  orderedCount: string;
  /** 预计等待（waitTimeStr 优先，其次 waitTime 秒） */
  waitText: string;
  raw: any;
}

function textOf(obj: any, keys: string[]): string {
  for (const key of keys) {
    const value = obj?.[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text && text !== 'undefined' && text !== 'null') return text;
  }
  return '';
}

/**
 * 场次列表：把 `reservations`（可预约）+ `alreadyReservations`（已预约）合并成一份，
 * 并把 `eventIds` 里的排队信息（queueNumber / duration）补进对应场次。
 *
 * 与桌面端 netface-model.events 同口径：
 *   · 同一 eventId 出现两次时后写覆盖（`{...prev, ...item}`）；
 *   · ordered = 在 alreadyReservations 里 || status >= 2；
 *   · eventIds 里的 queueNumber 覆盖成 `queneNumber`（官方字段就是拼错的那个）。
 */
export function netfaceEvents(info: any): NetfaceEventItem[] {
  const reservations = Array.isArray(info?.reservations) ? info.reservations : (info?.netfaceEventInfos || []);
  const already = Array.isArray(info?.alreadyReservations) ? info.alreadyReservations : (info?.orderedEventInfos || []);
  const orderedIds = new Set((already as any[]).map((v) => String(v?.eventId ?? '')));
  const queue = new Map<string, any>();
  for (const item of (Array.isArray(info?.eventIds) ? info.eventIds : []) as any[]) {
    const id = String(item?.eventId ?? '');
    if (id) queue.set(id, item);
  }
  const merged = new Map<string, any>();
  for (const item of [...(reservations as any[]), ...(already as any[])]) {
    const id = String(item?.eventId ?? '');
    if (!id) continue;
    merged.set(id, { ...(merged.get(id) || {}), ...item, eventId: id });
  }
  const groupInfos = Array.isArray(info?.groupInfos) ? info.groupInfos : [];
  const out: NetfaceEventItem[] = [];
  for (const [eventId, item] of merged) {
    const status = Number(item?.status) || 0;
    const star = item?.starInfo || {};
    const position = queue.get(eventId);
    const groupId = String(item?.groupId ?? star?.groupId ?? '');
    const group = groupInfos.find((g: any) => String(g?.groupId ?? '') === groupId);
    const waitText = textOf(item, ['waitTimeStr'])
      || (Number.isFinite(Number(item?.waitTime)) && Number(item?.waitTime) >= 0
        ? `${Math.floor(Number(item.waitTime) / 60)}分${Math.floor(Number(item.waitTime) % 60)}秒`
        : '待更新');
    out.push({
      eventId,
      status,
      statusText: netfaceStatusText(status),
      ordered: orderedIds.has(eventId) || status >= 2,
      starId: String(star?.userId ?? star?.id ?? ''),
      starName: String(star?.name || star?.nickname || '成员'),
      starAvatar: String(star?.avatar || ''),
      teamName: String(star?.teamName || item?.teamName || ''),
      groupName: String(group?.groupName || star?.groupName || ''),
      groupId,
      startTime: String(item?.startTime ?? ''),
      queueStartTime: String(item?.queueStartTime ?? ''),
      queueSize: String(item?.queueSize ?? ''),
      // 官方字段名就是 queneNumber（拼错的），eventIds 里叫 queueNumber
      queueNumber: String(position?.queueNumber ?? item?.queneNumber ?? item?.queueNumber ?? ''),
      orderedCount: String(item?.orderNum ?? item?.orderedTime ?? ''),
      waitText,
      raw: item,
    });
  }
  return out;
}

/** 握手会话（进入房间后才有效）：开始/暂停/剩余秒数 */
export function netfaceSession(info: any, now = Date.now()) {
  const started = Number(info?.joinStatus) === 1;
  const value = Number(info?.remainingTime);
  const remaining = Number.isFinite(value) && value > 0 ? value : 0;
  const paused = started && Number(info?.eventPauseStatus || 0) !== 0;
  return { started, paused, remainingTime: remaining, deadline: started ? now + remaining * 1000 : 0 };
}

/**
 * 毫秒时间戳 → `YYYY-MM-DD HH:mm`（北京时间）。
 * 桌面端用 Intl 指定 Asia/Shanghai；RN 的 Hermes 默认时区就是设备时区，
 * 这里显式换算成 UTC+8，避免「人不在国内时时间全错」。
 */
export function netfaceTimeText(value: unknown): string {
  const ms = Number(value);
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms + 8 * 3600 * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 余额（我的握手资格）：接口可能直接给数字，也可能包一层 */
export function netfaceBalance(content: any): number {
  if (typeof content === 'number' && Number.isFinite(content)) return content;
  const raw = content?.balance ?? content?.tpNum ?? content?.num ?? content?.count;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
