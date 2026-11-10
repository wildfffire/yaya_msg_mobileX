import { NavigatorScreenParams } from '@react-navigation/native';

export type RootStackParamList = {
  Main: NavigatorScreenParams<TabParamList>;
  MessagesScreen: undefined;
  LoginScreen: undefined;
  RechargeScreen: undefined;
  FetchScreen: undefined;
  FlipScreen: { mode?: 'view' | 'send' } | undefined;
  // 成员档案：支持从房间/消息点头像直接带成员进来（自动加载档案，无需再搜索）
  ProfileScreen: { memberId?: string; member?: any; nonce?: number } | undefined;
  /**
   * 相册（个人相册 / 房间相册双 Tab）：
   * - `memberId`：直接打开某位成员的相册（房间菜单入口带上当前成员）
   * - `channelId`：房间相册的数据源（房间消息图片列表）
   * - `tab`：默认落哪个 Tab
   */
  PhotosScreen: { memberId?: string; channelId?: string; tab?: 'personal' | 'room' } | undefined;
  /** 行程（首页工具区入口） */
  TripScreen: undefined;
  /** 现场互动（口袋云握手 netface）：活动场次 / 预约 / 资格兑换 */
  NetfaceScreen: undefined;
  RoomRadioScreen: { member?: any; initialMode?: 'big' | 'small'; streamUrl?: string } | undefined;
  OpenLiveScreen: undefined;
  OnMicScreen: undefined;
  PrivateMessagesScreen: { targetUserId?: string; targetName?: string } | undefined;
  BilibiliLiveScreen: { roomId?: string; roomName?: string } | undefined;
  VideoLibraryScreen: undefined;
  MusicLibraryScreen: undefined;
  AudioProgramsScreen: undefined;
  AnalysisScreen: undefined;
  DownloadScreen: undefined;
  DatabaseScreen: undefined;
  MeleeRankScreen: undefined;
  MemberDynamicScreen: undefined;
  InvoiceScreen: undefined;
  /** 稍后再看（用户 2026-09-30：统一入口放设置页） */
  WatchLaterScreen: undefined;
  /** 观看历史（含统计） */
  HistoryScreen: undefined;
  /** 分类设置页（「我的」页右上角齿轮进入，PiliPlus 思路） */
  SettingsDetailScreen: undefined;
};

export type TabParamList = {
  Home: undefined;
  Media: { mode?: 'live' | 'vod'; playLiveId?: string; playTitle?: string; playCover?: string; playUrl?: string; /** 直播类型（1=视频 2=电台）：电台要用照片轮播取代「成员离开」的推流画面，首帧就得知道 */ playLiveType?: number; playNonce?: number; fromRoom?: boolean; playPosition?: number; /** 来自「历史 / 稍后再看」：关闭播放器要回到那两个列表 */ fromWatch?: boolean; /**
   * 来源页路由名（`HistoryScreen` / `WatchLaterScreen`）。
   *
   * ⚠️ 必须带具体页名，不能只靠 fromWatch 布尔值：这两个页面是**根栈页面**，
   * 进播放用的是 `navigate('Main', {screen:'Media'})`，它会把根栈上的历史页 pop 掉 ——
   * 关闭播放器时 `goBack()` 回不去（上一页已经卸载），只能按页名 navigate 重新进入。
   * 以前 fromWatch 只切到 Settings tab（注释里「它们留在 Settings tab 的栈里」是错的），
   * 用户看到的就是「退出播放跑到直播页/设置页」。
   */ watchFrom?: string; /** 成员昵称（历史/稍后再看带过来）：写入观看历史时要跟着存，否则队伍徽章会丢 */ playOwner?: string; /** 队伍（历史/稍后再看带过来）：成员库还没同步时也能保住队伍徽章 */ playTeam?: string; /**
   * 成员数字 id（历史/稍后再看带过来）。
   *
   * ⚠️ 与 playOwner/playTeam 一起传才完整：昵称会漂移（团体前缀/别称/空值），
   * 而数字 id 是唯一稳定标识 —— 带着它，播完后写回历史的条目能像直播页卡片那样
   * 「按 userId → 成员库」取队伍，不再靠昵称硬匹配（见 utils/memberMatch）。
   */ playOwnerId?: string; /**
   * 来源 tab 名（当前只有首页直达 `'Home'`：公演直播卡 / 首页直播卡）。
   *
   * 用途：关闭播放器时**回到来源 tab**。首页跳转是 tab 切换（不是根栈 push），
   * 不显式切回就会停在直播页 —— 用户 2026-10-04：「生日会退出之后怎么没有留在主页
   * 而是到了直播页」。历史/稍后再看走 watchFrom，房间直达走 fromRoom，互不冲突。
   */ playFrom?: string } | undefined;
  Rooms: undefined;
  Settings: undefined;
};
