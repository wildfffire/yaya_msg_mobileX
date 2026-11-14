/** 流分类（对应 FollowedRooms classifyMedia 全量规则） */
export type StreamKind = 'live' | 'vod' | 'audio' | 'image' | 'link';

/**
 * 播放内容的「来源引用」：用于**历史记录**与「稍后再看」在事后重新拿到播放地址。
 *
 * 为什么不直接存 url：口袋的直播/回放地址都带签名或 wsSecret，**有时效**，
 * 存下来第二天必然播不了。存 (kind, id) 再按 kind 走各自的解析链路才是可靠做法
 *（解析入口见 src/screens/watch/resolvePlayUrl.ts）。
 */
export interface PlayerContentRef {
  /** video = 官方视频库（videoId）；openlive = 公演回放（liveId）；replay = 房间里的直播回放（liveId） */
  kind: 'video' | 'openlive' | 'replay';
  /** videoId / liveId */
  id: string;
}

/** 播放源：页面只需声明「播什么」，内核路由由 PlayerCore 决定 */
export interface PlayerSource {
  kind: StreamKind;
  /** 当前播放 URL */
  url: string;
  /** 候选地址（内核切换/失败重试时按序尝试） */
  urls?: string[];
  /** 防盗链头（UA/Referer/Origin/Cookie） */
  headers?: Record<string, string>;
  liveId?: string;
  /**
   * 内容的来源引用（可选，但**强烈建议传**）：
   * 历史记录页/稍后再看页要能重新解析地址就必须靠它。
   * 页面在挂载 PlayerScreen 时声明一次即可（见 VideoLibraryScreen / OpenLiveScreen / 房间回放）。
   */
  ref?: PlayerContentRef;
  /** rtmp/flv → 强制原生 ExoKernel（LiveExoView） */
  needsNativeExo?: boolean;
  /** 纯音频渲染（房间语音/上麦/电台） */
  audioOnly?: boolean;
  /** 音量（B站流响度补偿 1.5 等） */
  volume?: number;
  /** 网页内核音量增益（>1，经 WebAudio GainNode；原生 Exo 音量被系统 clamp ≤1） */
  volumeBoost?: number;
}

export interface PlayerMeta {
  title: string;
  cover?: string;
  /**
   * 归属成员昵称 / 队伍（可选）。
   * 用途：历史记录与稍后再看的**列表卡片**要显示「成员名 + 队伍徽章」——
   * 播放器本身不显示它们，但记录条目需要（见 services/watchHistory.ts、services/watchLater.ts）。
   */
  owner?: string;
  team?: string;
  /**
   * 归属成员的**数字 id**（官方条目的 `userInfo.userId`，与成员库 `id` 同域）。
   *
   * 为什么必须连它一起传（用户 2026-09-30：「历史和稍后再看的成员名/队伍经常出问题」）：
   * 历史与稍后再看是**事后**才补信息的（成员库可能还没同步、昵称形态可能变了），
   * 而昵称是字符串、会漂移；数字 id 是唯一稳定标识 —— 存下它，列表卡片与后台补全
   * 都能像直播页卡片那样「按 userId → 成员库」精确取队伍，不再靠猜。
   * 播放器自身不使用它，只随记录落到 watchHistory / watchLater。
   */
  ownerId?: string;
  /**
   * 标题右侧的小指标胶囊（可选）。
   * 页面按内容自己决定放什么（官方数据的口径差异很大，不宜把字段写死在类型里）：
   *   - 直播：`account-multiple` +「N 人在线」= 云信聊天室**实时**在线；
   *     聊天室拿不到时降级为同一个 `account-multiple` +「累计 N 人看过」
   *   - 回放：`account-multiple` +「累计 N 人看过」（该场结束时的累计，非实时）
   *     （用户 2026-11-01：两个口径都用人数图标，靠文案区分）
   * undefined 时不渲染。
   *
   * ⚠️【产品规则 · 用户 2026-11-01 定版】官方 `getLiveOne.content.onlineNum`
   * 实测是**本场累计观看人次**（2026-11-01 采样：20s 稳定 +6~8 只增不减、
   * 30+ 场次人数 ≈ 开播分钟 × 10~20、结束后冻结），**不是**实时在线：
   *   - 绝不能把它写成「N 人在线」（语义误导）；
   *   - 实时在线只来自云信聊天室（useLiveBarrage().online），且只在真直播里有；
   *   - 回放没有实时在线可言，只能给「累计 N 人看过」。
   * 胶囊由统一宿主 MediaPlaybackHost 生成（四场景同一口径），页面不要再自己拼。
   */
  stat?: { icon: string; text: string };
}

/** 弹幕源（三引擎统一）：poll=口袋直播 HTTP 轮询；lrc=录播 LRC 文件；ws=B站 WebSocket */
export type DanmakuSource =
  | { type: 'none' }
  | { type: 'poll'; liveId: string }
  | { type: 'lrc'; lrcUrl: string; liveId?: string }
  | { type: 'ws'; roomId: string };

/**
 * 功能开关：页面声明需要哪些能力，PlayerChrome 按需渲染。
 *
 * ⚠️ 2026-11-13 清理：`gift / rank / quality / resume` 四个字段**从未被任何组件读取**
 * （礼物/贡献榜已内置宿主；续播由 usePlaybackResume 统一；B站画质走 extraActions.options），
 * 已删除，避免页面以为传了有用。
 */
export interface PlayerFeatures {
  /** 倍速（1/1.5/2） */
  rate?: boolean;
  /** 弹幕开关 + 弹幕设置（宿主还会据此隐藏控制坞的弹幕按钮） */
  danmaku?: boolean;
  /** 内核互切（原生 <-> 网页） */
  kernelSwitch?: boolean;
}

/**
 * 「播放器功能」面板动作的选项行（B站画质档位等）：
 * 点击带 options 的动作条目时，从播放器**右侧弹出独立小面板**列出这些选项
 * （用户 2026-10-02：下拉不要内嵌在功能面板里）。当前档打勾走 palette.tint，
 * 设备不支持的档位禁用并以 hint 标注原因。
 */
export interface PlayerExtraActionOption {
  key: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  /** 不可选原因短文案（如「设备不支持」），禁用行右侧显示 */
  hint?: string;
  onPress: () => void;
}

export interface PlayerScreenProps {
  source: PlayerSource;
  meta: PlayerMeta;
  danmaku?: DanmakuSource;
  features?: PlayerFeatures;
  /** 底部控制坞额外动作（礼物/贡献榜等由外部实现） */
  extraActions?: Array<{
    key: string;
    icon: string;
    label: string;
    active?: boolean;
    /** 选项下拉（B站画质）：带此项时点击条目 → 关闭功能面板并弹出右侧独立小面板 */
    options?: PlayerExtraActionOption[];
    /** 带 options 时可省略（条目仅作小面板入口，不直接触发） */
    onPress?: () => void;
  }>;
  /** 顶栏左上按钮（返回键右侧、标题前）：收起后仍可随时点开（2026-09-26） */
  topLeftAction?: {
    icon: string;
    label: string;
    active?: boolean;
    onPress: () => void;
  };
  onClose?: () => void;
}
