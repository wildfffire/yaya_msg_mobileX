/**
 * 行程（口袋 `trip/api/v1/trip/v1/list`）解析与分组规则。
 *
 * 接口字段多态，且列表外壳有三种形态（数组 / `content.data` / `content.list` / `content.trips`），
 * 这里集中收口，避免页面里再写一遍 `||` 兜底。字段口径与桌面端 `trip-feature.js` 对齐：
 *   title / subTitle / content / showDate / showTime / timestamp /
 *   locationInfo.details | keyword / joinMemberName / ticketInfo.content | url / liveInfo.content
 */

export interface TripItem {
  /** 稳定 key（接口 id 优先，缺失时用「标题 + 时间 + 序号」兜底） */
  key: string;
  title: string;
  subTitle: string;
  content: string;
  /** `YYYY-MM-DD`（缺失时为空串） */
  dateText: string;
  /** `HH:mm`（缺失时为空串） */
  timeText: string;
  /** 毫秒时间戳（0 = 时间不明） */
  timestamp: number;
  location: string;
  members: string;
  ticketText: string;
  ticketUrl: string;
  liveText: string;
}

function text(value: any): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** 列表外壳归一化：数组 / content.data / content.list / content.trips */
export function normalizeTripList(content: any): any[] {
  if (!content) return [];
  if (Array.isArray(content)) return content;
  if (Array.isArray(content.data)) return content.data;
  if (Array.isArray(content.list)) return content.list;
  if (Array.isArray(content.trips)) return content.trips;
  // 部分版本把列表塞在 data.list / data.trips
  if (Array.isArray(content.data?.list)) return content.data.list;
  if (Array.isArray(content.data?.trips)) return content.data.trips;
  return [];
}

/** 下一页游标（'0' / '' = 没有更多） */
export function tripCursor(content: any, list: any[]): string {
  const direct = content?.nextTime || content?.lastTime || content?.next;
  if (direct) return String(direct);
  const last = list[list.length - 1];
  const fallback = last?.timestamp || last?.showTimestamp || last?.showDateTime || '0';
  return String(fallback || '0');
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 时间戳 → `YYYY-MM-DD` + `HH:mm` */
export function tripDateTime(timestamp: number): { dateText: string; timeText: string } {
  if (!timestamp || !Number.isFinite(timestamp)) return { dateText: '', timeText: '' };
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return { dateText: '', timeText: '' };
  return {
    dateText: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    timeText: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** 单条行程归一化；标题为空时用「未命名行程」，整条都空则返回 null */
export function parseTripItem(raw: any, index = 0): TripItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const timestamp = Number(raw.timestamp || raw.showTimestamp || 0) || 0;
  const fromTs = tripDateTime(timestamp);
  const dateText = text(raw.showDate) || fromTs.dateText;
  const timeText = (text(raw.showTime) || fromTs.timeText).slice(0, 5);
  const title = text(raw.title);
  const location = text(raw.locationInfo?.details) || text(raw.locationInfo?.keyword) || text(raw.location);
  const members = text(raw.joinMemberName) || text(raw.memberName);
  const ticketText = text(raw.ticketInfo?.content);
  const ticketUrl = text(raw.ticketInfo?.url);
  const liveText = text(raw.liveInfo?.content);
  const subTitle = text(raw.subTitle);
  const content = text(raw.content) || text(raw.desc) || text(raw.description);
  if (!title && !dateText && !content && !location && !members) return null;
  return {
    key: text(raw.id) || text(raw.tripId) || `${title}|${dateText}${timeText}|${index}`,
    title: title || '未命名行程',
    subTitle,
    content,
    dateText,
    timeText,
    timestamp,
    location,
    members,
    ticketText,
    ticketUrl,
    liveText,
  };
}

export interface TripGroups {
  today: TripItem[];
  upcoming: TripItem[];
  past: TripItem[];
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 按「今天 / 即将到来 / 过往」分组。
 * - 时间不明的（timestamp=0）归到「即将到来」并排在最后（文案会显示「时间待定」）
 * - 今天按时间正序、即将到来正序、过往倒序（越近的越靠前）
 */
export function groupTrips(items: TripItem[], now = Date.now()): TripGroups {
  const todayStart = startOfDay(now);
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  const groups: TripGroups = { today: [], upcoming: [], past: [] };
  for (const item of items) {
    if (!item.timestamp) {
      groups.upcoming.push(item);
    } else if (item.timestamp >= todayStart && item.timestamp < todayEnd) {
      groups.today.push(item);
    } else if (item.timestamp >= todayEnd) {
      groups.upcoming.push(item);
    } else {
      groups.past.push(item);
    }
  }
  groups.today.sort((a, b) => a.timestamp - b.timestamp);
  groups.upcoming.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return a.timestamp - b.timestamp;
  });
  groups.past.sort((a, b) => b.timestamp - a.timestamp);
  return groups;
}
