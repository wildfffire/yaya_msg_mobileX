export interface Member {
  ownerName: string;
  id: string;
  serverId: string;
  channelId: string;
  yklzId: string;
  roomId?: string;
  liveRoomId?: string;
  team: string;
  pinyin: string;
  isInGroup: boolean;
  avatar: string;
  groupName: string;
  teamId: string;
  /** 官方队伍 Logo（房间头部队伍标签用图；缺失时回退文字） */
  teamLogo?: string;
  /** 成员状态分类（官方源优先）：active 在团 / left 退团 / graduated 毕业 / paused 暂休 / unknown 未知 */
  state?: string;
  /* ── 成员档案字段（用户 2026-11-09：资料卡补齐血型/星座/期数/入团时间/特长）──
   * 官方 starInfo 有就合并进来，本地成员库没有时由 online 档案兜底；
   * 全部可选（缺哪个就不显示哪一行，不用空字符串占位）。 */
  birthday?: string;
  birthplace?: string;
  constellation?: string;
  height?: string | number;
  bloodType?: string;
  hobbies?: string;
  specialty?: string;
  periodName?: string;
  jtime?: string | number;
  ptime?: string | number;
  gtime?: string | number;
  qtime?: string | number;
  rank?: string | number;
  wbName?: string;
  wbUid?: string;
}

export interface RoomMessage {
  id: string;
  msgId: string;
  messageId: string;
  clientMsgId: string;
  msgTime: number;
  msgType: string;
  senderUserId: string;
  senderId: string;
  uid: string;
  senderName: string;
  bodys: string;
  msgContent: string;
  extInfo: string | { user: UserInfo };
  channelId: string;
}

export interface UserInfo {
  nickName: string;
  avatar: string;
  userId: string;
  roleId: string;
}

export interface PrivateMessage {
  user: {
    userId: string;
    nickname: string;
    starName: string;
    realNickName: string;
    avatar: string;
    teamName: string;
    groupName: string;
    isStar: boolean;
    teamLogo: string;
  };
  newestMessage: string;
  newestMessagetime: number;
  noreadNum: number;
  targetUserId: string;
}

export interface FlipRecord {
  questionId: string;
  question: string;
  answer: string | { url: string; time?: number };
  answerType: number;
  status: number;
  type: number;
  cost: number;
  qtime: number;
  answerTime: number;
  memberId: string;
  memberName: string;
}

export interface VODItem {
  liveId: string;
  title: string;
  liveRoomTitle: string;
  screenDirection: number;
  liveType: number;
  startTime: number;
  endTime: number;
  playUrl: string;
  playPath: string;
  liveCover: string;
  coverPath: string;
  nickname: string;
  isRecording: boolean;
  clubId: string;
  groupId: number;
}

export interface GiftItem {
  id: string;
  name: string;
  cost: number;
  description?: string;
}

export interface FlipPrice {
  questionType: number;
  questionTypeDesc: string;
  price: number;
  maxLength: number;
}

export interface LiveGift {
  id: number;
  name: string;
  price: number;
  icon: string;
  type: number;
}

export interface BilibiliLiveRoom {
  roomId: string;
  name: string;
  isLive: boolean;
}

export interface ShowRecord {
  liveId: string;
  title: string;
  startTime: number;
  endTime: number;
  members: string[];
}

export interface NimLoginInfo {
  account: string;
  token: string;
}

export interface MusicItem {
  id: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  url: string;
  lyricIndex?: string;
}

export interface AudioProgram {
  id: string;
  title: string;
  description: string;
  cover: string;
  url: string;
  date: string;
}

export interface VideoItem {
  id: string;
  title: string;
  description: string;
  cover: string;
  url: string;
  date: string;
  group: string;
}

export type MessageFilter = 'all' | 'text' | 'audio' | 'image' | 'video' | 'reply' | 'live-record';

export type Theme = 'light' | 'dark' | 'system';

export type LanguageSetting = 'system' | 'zh-Hans' | 'zh-Hant' | 'en' | 'ja' | 'ko';

export interface TripItem {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  date: string;
  time: string;
  showDate: string;
  showTime: string;
  members: string[];
  location: string;
  liveText: string;
  ticketUrl: string;
  groupId: number;
  memberId: string;
  userId: string;
}

export interface MeleeWeek {
  weekRankId: number;
  weekRankName: string;
}

export interface MeleeRankItem {
  rankNum: number;
  baseUserInfo: {
    userName: string;
    userAvatar: string;
    userId: string;
  };
  topUserInfo: {
    userName: string;
    userAvatar: string;
    userId: string;
  };
  melee: string;
  resId?: number;
  charmInfo?: Array<{
    userName: string;
    userAvatar: string;
    userId: string;
    charm: string;
    isPrivacy: boolean;
  }>;
}

export interface DynamicItem {
  id: string;
  title: string;
  content: string;
  coverUrls: string[];
  time: number;
  ownerId: string;
  ownerName: string;
  ownerAvatar: string;
}

export interface WeiboItem {
  id: string;
  title: string;
  content: string;
  imageUrls: string[];
  jumpUrl: string;
  time: number;
  ownerId: string;
  ownerName: string;
  ownerAvatar: string;
}

export interface InvoiceOrder {
  dataId: string;
  goodsName: string;
  summary: string;
  invoiceStatus: number;
  invoiceNo: string;
  totalFee: string;
  tradeTime: string;
  tradeTimeLong: number;
  companyId: string;
}

export interface InvoiceConfig {
  companyId: string;
  saleName: string;
  maxFee: string;
  defaultFlag: boolean;
}

export interface ConversationItem {
  targetUserId: string;
  userId: string;
  nickname: string;
  avatar: string;
  lastMessage: string;
  lastTime: number;
  unreadNum: number;
  isStar: boolean;
}

export interface VoteStatus {
  voteId: string;
  voteName: string;
  startTime: number;
  endTime: number;
  status: number;
}

export interface PageantryItem {
  id: string;
  name: string;
  icon: string;
  description: string;
}

export interface AnnouncementData {
  id: string;
  header: string;
  title: string;
  fullContent: string;
  imageUrl: string;
  link: string;
  show: boolean;
  version?: string;
}

export interface Meet48Auth {
  token?: string;
  cookie?: string;
  deviceId?: string;
  disabled?: boolean;
}

export interface AppSettings {
  theme: Theme;
  language: LanguageSetting;
  p48Token: string;
  bilibiliCookie: string;
  bilibiliUserInfo: any;
  msg_sort_order: 'asc' | 'desc';
  yaya_followed_custom_order: string[];
  yaya_music_play_mode: 'sequential' | 'random' | 'single';
  yaya_music_volume: number;
  yaya_audio_program_play_mode: 'sequential' | 'random' | 'single';
  yaya_auto_checkin_enabled: boolean;
  yaya_auto_checkin_last_date: string;
  yaya_auto_checkin_last_user: string;
  customBackgroundFile: string;
  customBackgroundUpdatedAt: number;
  yaya_trip_show_all: boolean;
  meet48Auth?: Meet48Auth | null;
  /** 画中画（系统小窗）：视频播放中切后台自动弹系统悬浮窗。默认关——不主动调用不弹 App 外小窗 */
  pip_auto: boolean;
  /**
   * 房间消息头像来源：
   * - `custom`（默认）：偶像自己在客户端设置的头像（消息 ext.user.avatar），取不到才回退公式照
   * - `official`：成员库里的系统公式照（source.48.cn），取不到才回退自选头像
   */
  room_avatar_source?: 'custom' | 'official';
  /**
   * 房间**外**（房间列表等）的成员头像来源，与房间内分开设置：
   * - `official`（默认）：成员库公式照
   * - `custom`：偶像自己给房间设置的图标（`seine/server/detail` 的 `chatServerInfo.serverIcon`），
   *   与公式照、房间内消息头像（`ext.user.avatar`）是三套独立的图；取不到才回退公式照
   */
  room_list_avatar_source?: 'custom' | 'official';
  /* ── 房间列表排序（用户 2026-11-09）───────────────────────────────────────
   * 「新消息在上」默认开（与原行为一致）；关掉后组内按 room_list_sort 排。
   * 置顶房间永远排最前，与这两个字段无关。
   */
  /** 有新消息的房间是否上浮 */
  room_list_unread_first?: boolean;
  /** 组内排序方式：自定义 / 按队伍 / 按字母 */
  room_list_sort?: 'custom' | 'team' | 'alpha';
  /** 自定义顺序（memberId 数组，越靠前越上） */
  room_list_custom_order?: string[];
  /**
   * 主题色（PiliPlus 风格）：预设 id 见 ACCENT_PRESETS，'custom' 表示用 accentColor。
   * 默认 'yaya' = 原有品牌粉，保证老用户升级后外观不变。
   */
  accentPreset?: string;
  /** 自定义主题色 #RRGGBB；同时作为 Color Picker 的初值 */
  accentColor?: string;
  /** 调色板风格：由同一个种子色派生出不同浓度/伴随色 */
  accentVariant?: 'material' | 'soft' | 'vivid' | 'mono';
  /** 动态取色（Android 12+ 系统壁纸色）；开启后覆盖预设与自定义色 */
  accentDynamic?: boolean;
  /** 上次从系统取到的壁纸色（冷启动会重新取一次，壁纸换了能跟上） */
  accentDynamicValue?: string;
  /* ── 通知（用户 2026-11-09）───────────────────────────────────────────────
   * 「软件外」= 系统通知栏；「软件内」= App 内的顶部横幅。两套开关独立，
   * 因为用户可能只想在 App 内看到提醒，不想被系统通知打扰。
   */
  /** 软件外通知（系统通知栏）总开关 */
  notify_system_enabled?: boolean;
  /** 软件内通知（App 内横幅）总开关 */
  notify_inapp_enabled?: boolean;
  /** 私信消息通知 */
  notify_pm_enabled?: boolean;
  /** 房间消息通知 */
  notify_room_enabled?: boolean;
  /** 仅在 App 不在前台时发系统通知（前台只出 App 内横幅） */
  notify_only_background?: boolean;
  /** 免打扰：所有通知静音（含 App 内横幅） */
  notify_dnd?: boolean;
  /**
   * 房间通知三态（对齐桌面版 followed-rooms 的通知按钮）：
   * all = 全部房间开；none = 全部关；custom = 按 notify_room_map 逐房间
   */
  notify_room_mode?: 'all' | 'custom' | 'none';
  /** 逐房间开关（memberId → 是否通知，仅 custom 模式生效） */
  notify_room_map?: Record<string, boolean>;
  /* ── 背景显示（用户 2026-11-09）───────────────────────────────────────── */
  /** 自定义背景上压的遮罩强度 0-100（越大越暗/越不透明） */
  bg_dim?: number;
  /** 自定义背景模糊半径 0-20 */
  bg_blur?: number;
  /* ── 横屏侧边栏（用户 2026-11-11）────────────────────────────────────── */
  /** 默认关：仅当横屏且本开关打开时，底部胶囊导航切换为左侧纯图标侧栏 */
  landscape_sidebar_enabled?: boolean;
  /** 弹幕/房间消息自定义昵称（留空用登录账号昵称） */
  /** 弹幕/房间消息自定义头像 URL（留空用登录账号头像） */
  /** 自定义等级（留空用登录账号） */
  /** 自定义账号身份 roleId（留空用登录账号；1=普通用户 2/3/4/5=成员 999=超管） */
  /** 自定义房间身份 sessionRole（留空=0 普通观众；1=房管 2=房主 3=成员本人 99=超管） */
  /** 自定义 VIP（''=跟随账号 'on'/'off'） */
}
