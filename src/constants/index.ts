import { GiftItem } from '../types';

export const API_BASE = 'https://pocketapi.48.cn';

export const BILIBILI_API = 'https://api.bilibili.com';

// 成员数据权威源：数据发布于 data.gnz.hk（GNZ48 团站数据库镜像）。
// 进入软件由 AppNavigator 调用 ensureMemberData() 无条件同步最新。
/**
 * 自建镜像成员库（推荐源）：GitHub Action 每日同步上游 + 应用本地 overrides/extra 后产出。
 * 见 member-db/README.md。换成自建域名时只改这一行。
 */
export const MEMBERS_URL_SELF = 'https://cdn.jsdelivr.net/gh/Xenia0922/yaya_msg_mobile@main/member-db/dist/members.json';

/** 上游 yk1z 库：自建源不可用时的回退（保证不全依赖自建可用性） */
export const MEMBERS_URL = 'https://data.gnz.hk/members.json';

export const APP_VERSION = '3.0.0';

/**
 * 构建号（Build）= Android versionCode。
 *
 * 用户 2026-10-05 要求：设置页在版本名**下面**单独显示一行，显示为 `Build 3000000` ——
 * 同一个 `vX.Y.Z` 常常会有多个修复包（改完就出包），只显示版本名分不清设备上装的是哪一个。
 * （用户明确不要中文「小版本」三个字，统一用英文 Build，四个语言字典同值。）
 *
 * ⚠️ 必须与 `app.json` / `android/app/build.gradle` 的 versionCode 完全一致，
 * `scripts/verify-version.js` 会拦下任何漂移（改版本时三处一起动：versionName 走语义版本，
 * versionCode / APP_BUILD 每出一个包必须递增）。
 */
export const APP_BUILD = 3000046;

// 成员数据原始仓库（yk1z 的牙牙消息电脑版），数据由其维护并发布。
export const MEMBER_DATA_SOURCE_URL = 'https://github.com/yk1z/yaya_msg';

export const BILIBILI_LIVE_CONFIG_URL = 'https://yaya-data.pages.dev/bilibili-live.json';

export const LYRICS_INDEX_URL = 'https://yaya-data.pages.dev/lyrics-index.json';

export const LYRICS_BASE_URL = 'https://yaya-data.pages.dev/lyrics';

export const NOTICE_URL = 'https://yaya-data.pages.dev/notice.json';

export const YK1Z_URL = 'https://yaya-data.pages.dev/yk1z.json';

export const USER_AGENT = 'PocketFans201807/7.0.41 (iPhone; iOS 17.0; Scale/3.00)';

export const USER_AGET_IPAD = 'PocketFans201807/7.0.41 (iPad; iOS 17.0; Scale/2.00)';

export const POCKET_GIFT_DATA: GiftItem[] = [
  { id: '1', name: '荧光棒', cost: 5 },
  { id: '2', name: '荧光棒x2', cost: 10 },
  { id: '3', name: '樱花', cost: 30 },
  { id: '4', name: '樱花x2', cost: 60 },
  { id: '5', name: '玫瑰花', cost: 100 },
  { id: '6', name: '玫瑰花x2', cost: 200 },
  { id: '7', name: '皇冠', cost: 500 },
  { id: '8', name: '皇冠x2', cost: 1000 },
  { id: '9', name: '星梦石', cost: 50 },
  { id: '10', name: '星梦石x2', cost: 100 },
  { id: '11', name: '爱心', cost: 20 },
  { id: '12', name: '鸡腿', cost: 10 },
  { id: '13', name: '火箭', cost: 1500 },
  { id: '14', name: '城堡', cost: 3000 },
  { id: '15', name: '彩虹', cost: 200 },
  { id: '16', name: '钻石', cost: 1000 },
  { id: '17', name: '戒环', cost: 600 },
  { id: '18', name: '比心', cost: 80 },
  { id: '19', name: '蜜桃', cost: 120 },
  { id: '20', name: '流星', cost: 300 },
  { id: '21', name: '锦鲤', cost: 400 },
  { id: '22', name: '独角兽', cost: 800 },
  { id: '23', name: '丘比特', cost: 600 },
  { id: '24', name: '章鱼烧', cost: 40 },
  { id: '25', name: '奶茶', cost: 30 },
  { id: '26', name: '冰淇淋', cost: 20 },
  { id: '27', name: '小fufu', cost: 999 },
  { id: '28', name: '铁锅炖大鹅', cost: 300 },
  { id: '29', name: '火锅', cost: 200 },
  { id: '30', name: '奖杯', cost: 9999 },
  { id: '31', name: '冲鸭', cost: 100 },
  { id: '32', name: '守护', cost: 300 },
  { id: '33', name: '巧克力', cost: 30 },
  { id: '34', name: '柠檬', cost: 40 },
  { id: '35', name: '向日葵', cost: 70 },
  { id: '36', name: '星辰', cost: 500 },
  { id: '37', name: '月光', cost: 600 },
  { id: '38', name: '游轮', cost: 5000 },
  { id: '39', name: '飞机', cost: 999 },
  { id: '40', name: '烟花', cost: 200 },
  { id: '41', name: '星星', cost: 50 },
  { id: '42', name: '雪糕', cost: 19999 },
];

/**
 * 各队应援色（2026-11-09 按桌面端 yk1z/yaya_msg 校正，权威源：
 *   src/renderer/bootstrap-shared.js 的 TEAM_COLORS
 *   src/renderer/database/app.jsx 的 TEAM_COLORS（Tailwind 色值，两处一致）
 * 之前 J / C / K / CII 是「按色名取近似」的旧值，这次全部换成桌面端实际用的色值。
 *
 *   SNH48  SII A1D5ED / NII BE98C7 / HII F8941D / X B1D61B
 *   GNZ48  G 9FBF40 / NIII FFE249 / Z EA617B
 *   BEJ48  B FF4083 / E 0CC8C3 / J 192F6B（深蓝，取浅色主题色）
 *   CKG48  C FEB90D / K FF5043
 *   CGT48  CII D21217 / GII 0061C0
 *   IDFT   900058 / 预备生、荣誉毕业生、海外练习生 7B8493
 *
 * 同时保留不带 `TEAM ` 前缀的别名，方便成员库里各种写法直接命中。
 */
export const TEAM_COLORS: Record<string, string> = {
  'TEAM SII': '#A1D5ED', SII: '#A1D5ED',
  'TEAM NII': '#BE98C7', NII: '#BE98C7',
  'TEAM HII': '#F8941D', HII: '#F8941D',
  'TEAM X': '#B1D61B', X: '#B1D61B',
  'TEAM G': '#9FBF40', G: '#9FBF40',
  'TEAM NIII': '#FFE249', NIII: '#FFE249',
  'TEAM Z': '#EA617B', Z: '#EA617B',
  'TEAM B': '#FF4083', B: '#FF4083',
  'TEAM E': '#0CC8C3', E: '#0CC8C3',
  'TEAM J': '#192F6B', J: '#192F6B',
  'TEAM C': '#FEB90D', C: '#FEB90D',
  'TEAM K': '#FF5043', K: '#FF5043',
  'TEAM CII': '#D21217', CII: '#D21217',
  'TEAM GII': '#0061C0', GII: '#0061C0',
  IDFT: '#900058',
  '预备生': '#7B8493',
  '荣誉毕业生': '#7B8493',
  '海外练习生': '#7B8493',
};

export const GROUP_NAMES = ['SNH48', 'GNZ48', 'BEJ48', 'CKG48', 'CGT48', 'IDFT'];

export const MESSAGE_TYPES = {
  TEXT: ['TEXT'],
  AUDIO: ['AUDIO'],
  IMAGE: ['IMAGE'],
  VIDEO: ['VIDEO'],
  REPLY: ['REPLY', 'GIFTREPLY'],
  LIVE: ['LIVEPUSH', 'SHARE_LIVE'],
  GIFT: ['GIFT_TEXT'],
  FLIPCARD: ['FLIPCARD'],
};
