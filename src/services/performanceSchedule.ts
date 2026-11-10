import AsyncStorage from '@react-native-async-storage/async-storage';
import pocketApi from '../api/pocket48';
import { TEAM_COLORS } from '../constants';
import { normalizeUrl } from '../utils/data';

/**
 * 公演排期（剧场演出预告）。
 *
 * 数据源：Seine 互动列表 `snhapi-v1.ckg48.cn/home/api/seine/home/interaction/list`
 *（`pocketApi.getSeinePerformanceList`，type=2），**不需要 token**。
 *
 * 实测（2026-09-26）返回 `content.liveList[]`：每页 50 条、按开演时间倒序，
 * 未来场次能排到 10 天以后。字段含义：
 *   - `businessId`  场次 ID。⚠️ **不是 liveId** —— 拿去调 `getLiveOne` 会返回
 *                   「该成员直播已被删除」，所以不能凭它直接取回放/播放地址。
 *   - `startTime`   开演时间（13 位毫秒）
 *   - `title`       「《赫兹共振》2.0公演」/「GNZ48剧场公演」/「《…》BEJ48中秋联合公演第2场」
 *   - `cover`       封面（绝对地址与 `/xxx` 相对路径两种形态都有）
 *   - `teamLogo`    队徽 `/mediasource/teamLogo2/all/snh48_h2.png`
 *                   → 文件名后缀可反推「团 + 队」（见 TEAM_CODE），是接口里唯一的团体信息
 *   - `openLiveInfo.status`  1 = 未开演（预告态）、4 = 已结束（此时 `viewNum` 才开始有值）
 *
 * ⚠️ 已实测确认**拿不到**的字段，不要在本文件里假装有：
 *   - 成员阵容：未来场次在 `live.48.cn` / `getOpenLiveParticipants` 里都没有 participants
 *   - 场馆名：接口不给，只能由团体反推城市（SNH48→上海 星梦剧院、GNZ48→广州、BEJ48→北京…）
 *   - 票务信息：接口无任何票务字段
 */

export interface PerformanceShow {
  /** 场次 ID（businessId，已按字符串保精度） */
  id: string;
  /**
   * 公演直播 liveId —— **与 businessId 是同一个值**（实测 2026-10-04：
   * 「柏欣妤 生日会」businessId = liveId = 1313111009176391680）。
   *
   * 拿到它就能用应用内信号看这场公演：
   *   `pocketApi.getOpenLiveOne(liveId)` → content.playStreams[].streamPath（rtmp，标清/高清）。
   * 未开演的场次该 ID 暂时取不到流，开演（status=2）后即可播。
   *
   * ⚠️ 为保精度，本字段依赖 getSeinePerformanceList 的 `exactBigInts` 解析；
   * 少了它 JSON 大整数会丢成 …9176391700，接口查不到任何东西。
   */
  liveId: string;
  title: string;
  /** 封面绝对地址，可能为空 */
  cover: string;
  /** 开演时间（毫秒） */
  startTime: number;
  /** SNH48 / GNZ48 / BEJ48 / CKG48 / CGT48（队徽认不出时退回标题里的团名），识别不出时为空串 */
  group: string;
  /** 队名缩写 HII / NIII / B / E / C …，识别不出时为空串 */
  team: string;
  /** 「SNH48 Team HII」；只知道团不知道队时退化成团名；都识别不出时为空串 */
  teamLabel: string;
  /** 队伍主色（复用 TEAM_COLORS），兜底品牌粉 */
  color: string;
  /** 接口原始状态：1 未开演、4 已结束 */
  status: number;
}

/** 排期缓存：排期变化很慢，10 分钟内直接复用，避免每次进页面都打接口。
 *  ⚠️ v2：v1 缓存里持久化了旧的（未校正的）队伍颜色，换 key 丢弃 —— 颜色一律用新 TEAM_COLORS 重算。
 *  ⚠️ v3：v2 缓存里的 id 是 JSON 大整数丢精度后的值（…9176391700），拿去解析公演直播必失败；
 *          换 key 丢弃，强制重拉一次拿到精确的 businessId/liveId。
 *  ⚠️ v4：v3 缓存里持久化了按 yk1z/yaya_msg 校正之前的队伍色（J/C/K/CII/GII 是近似值），
 *          换 key 丢弃，强制用新 TEAM_COLORS 重算。 */
const CACHE_KEY = 'yaya_performance_schedule_v4';
const CACHE_TTL = 10 * 60 * 1000;
/** 缓存最多留 100 场（一页 50，足够覆盖「最近几场」的筛选需求） */
const CACHE_MAX = 100;

/** 队伍信息缺失 / 查不到应援色时的占位色；UI 会把它替换成当前主题色（见 PerformanceStrip） */
export const PERFORMANCE_FALLBACK_COLOR = '#ff6f91';

/** 队徽文件名后缀 → 队伍缩写（键与 TEAM_COLORS 对齐） */
const TEAM_CODE: Record<string, string> = {
  s2: 'SII', n2: 'NII', h2: 'HII', x: 'X',
  g: 'G', n3: 'NIII', z: 'Z',
  b: 'B', e: 'E', j: 'J',
  c: 'C', k: 'K', cii: 'CII', gii: 'GII',
};

/** 队徽文件名前缀 → 团体（接口里两种写法都出现过：`snh48_h2.png` 带 48、`ckg_c.png` 不带） */
const GROUP_CODE: Record<string, string> = {
  snh48: 'SNH48',
  snh: 'SNH48',
  gnz48: 'GNZ48',
  gnz: 'GNZ48',
  bej48: 'BEJ48',
  bej: 'BEJ48',
  ckg48: 'CKG48',
  ckg: 'CKG48',
  cgt48: 'CGT48',
  cgt: 'CGT48',
  idft: 'IDFT',
};

/** 标题里直接写团名的场景（「GNZ48剧场公演」「CKG48剧场公演」「《…》BEJ48中秋联合公演第2场」） */
const GROUP_IN_TITLE = /(SNH48|GNZ48|BEJ48|CKG48|CGT48|IDFT)/;

interface TeamInfo {
  group: string;
  team: string;
  teamLabel: string;
  color: string;
}

/**
 * `/mediasource/teamLogo2/all/snh48_h2.png` → SNH48 / HII。
 * 认不出来的（例如接口偶尔返回的 hash 文件名）返回空团体，UI 侧只显示标题。
 */
export function parseTeamLogo(logo: string): TeamInfo {
  const file = String(logo || '').split('/').pop() || '';
  const matched = file.match(/^([a-z]+[0-9]*)_([a-z0-9]+)\.(?:png|jpe?g|webp)$/i);
  if (!matched) return { group: '', team: '', teamLabel: '', color: PERFORMANCE_FALLBACK_COLOR };
  const group = GROUP_CODE[matched[1].toLowerCase()] || matched[1].toUpperCase();
  const team = TEAM_CODE[matched[2].toLowerCase()] || '';
  const teamLabel = team ? `${group} Team ${team}` : group;
  // 先按 `TEAM X` 查，再按别名 `X` 查（TEAM_COLORS 两套键都保留了）
  const color = (team && (TEAM_COLORS[`TEAM ${team}`] || TEAM_COLORS[team])) || PERFORMANCE_FALLBACK_COLOR;
  return { group, team, teamLabel, color };
}

function normalizePerformance(item: any): PerformanceShow | null {
  const startTime = Number(item?.startTime) || 0;
  const title = String(item?.title || '').trim();
  // 没有标题或开演时间的条目在预告里没有任何意义（无法排序也无法展示）
  if (!startTime || !title) return null;
  const team = parseTeamLogo(String(item?.teamLogo || ''));
  // 联合公演 / 各团「剧场公演」这类场次的 teamLogo 常常是空或 hash 文件，
  // 但团名就写在标题里（实测「GNZ48剧场公演」「《帅瓜美花降临》BEJ48中秋联合公演第2场」）
  // → 队徽认不出来时用标题里的团名兜底，至少能显示是哪个团
  const titleGroup = (title.match(GROUP_IN_TITLE) || [])[1] || '';
  const group = team.group || titleGroup;
  // Seine 的 businessId 就是公演 liveId（见接口注释）：留成字符串，禁止再走 Number()。
  const businessId = String(item?.businessId || '').trim();
  return {
    id: businessId || `${startTime}-${title}`,
    liveId: businessId,
    title,
    cover: normalizeUrl(item?.cover),
    startTime,
    group,
    team: team.team,
    teamLabel: team.teamLabel || group,
    color: team.color,
    status: Number(item?.openLiveInfo?.status) || 0,
  };
}

async function readCache(): Promise<{ at: number; shows: PerformanceShow[] } | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.shows) || !parsed.shows.length) return null;
    return { at: Number(parsed.at) || 0, shows: parsed.shows };
  } catch {
    return null;
  }
}

async function writeCache(shows: PerformanceShow[]) {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), shows: shows.slice(0, CACHE_MAX) }));
  } catch {
    // 缓存写失败不影响本次展示
  }
}

let inflight: Promise<PerformanceShow[]> | null = null;

/**
 * 拉取整页公演排期（未来 + 已结束混排），按开演时间**正序**返回。
 * 带 10 分钟 TTL 缓存与在飞去重；网络失败回退旧缓存（与 r2Music 同款兜底），无缓存才抛错。
 */
export async function fetchPerformanceSchedule(force = false): Promise<PerformanceShow[]> {
  if (!force) {
    const cached = await readCache();
    if (cached && Date.now() - cached.at < CACHE_TTL) return cached.shows;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res: any = await pocketApi.getSeinePerformanceList(0, 0);
      const raw = res?.content?.liveList ?? res?.data?.liveList ?? [];
      const shows = (Array.isArray(raw) ? raw : [])
        .map(normalizePerformance)
        .filter(Boolean)
        .sort((a, b) => (a as PerformanceShow).startTime - (b as PerformanceShow).startTime) as PerformanceShow[];
      if (shows.length) await writeCache(shows);
      return shows;
    } catch (error) {
      const cached = await readCache();
      if (cached) return cached.shows;
      throw error;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 公演序列（首页「公演直播」与公演记录页共用）：**按天保留**。
 * 用户要求：当天的场次即使开演时间已过也不要删掉，一天一更新（过了当天才随日期翻篇）。
 * 所以判据只有「开演时间 ≥ 今天 0 点」：未来场次、正在演的、今天已结束的全部保留；
 * 已结束的（status 4）由 UI 层显示原时间、点击提示已结束，不再冒充「直播中」。
 */
export async function fetchUpcomingPerformances(force = false): Promise<PerformanceShow[]> {
  const shows = await fetchPerformanceSchedule(force);
  const now = Date.now();
  const dayStart = (ts: number) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return shows.filter((show) => show.startTime >= dayStart(now));
}

/** 开演时间的结构化描述：语义 token 交给 UI 翻译，避免把中文写进数据层 */
export interface ShowWhen {
  /** today / tomorrow / dayAfter / date —— 前三个是「相对今天」，UI 各自有专属文案 */
  token: 'today' | 'tomorrow' | 'dayAfter' | 'date';
  /** 'HH:MM' */
  time: string;
  month: number;
  day: number;
}

export function describeShowTime(startTime: number, now = Date.now()): ShowWhen {
  const date = new Date(startTime);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const dayStart = (ts: number) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const diffDays = Math.round((dayStart(startTime) - dayStart(now)) / 86400000);
  const token = diffDays <= 0 ? 'today' : diffDays === 1 ? 'tomorrow' : diffDays === 2 ? 'dayAfter' : 'date';
  return { token, time, month: date.getMonth() + 1, day: date.getDate() };
}

/** 把 describeShowTime 的结果翻成展示文案（t 由调用方传入，保持数据层不依赖 i18n） */
export function formatShowWhen(when: ShowWhen, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (when.token === 'today') return t('今天 {time}', { time: when.time });
  if (when.token === 'tomorrow') return t('明天 {time}', { time: when.time });
  if (when.token === 'dayAfter') return t('后天 {time}', { time: when.time });
  return t('{month}月{day}日 {time}', { month: when.month, day: when.day, time: when.time });
}
