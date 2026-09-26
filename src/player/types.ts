/** 流分类（对应 FollowedRooms classifyMedia 全量规则） */
export type StreamKind = 'live' | 'vod' | 'audio' | 'image' | 'link';

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
   * 标题右侧的小指标胶囊（可选）。
   * 页面按内容自己决定放什么（官方数据的口径差异很大，不宜把字段写死在类型里）：
   *   - 直播：在线人数 `account-multiple`（官方直播接口**没有**热度/人气字段，
   *     见 docs/BUG_LIST_2026-09-18.md 的实测结论，在线人数是最近替代）
   *   - 回放/录播：**不传 stat**（详见下）
   * undefined 时不渲染。
   *
   * ⚠️【产品规则】在线人数只在**真正的直播**里显示：
   *   - `getLiveOne` 虽然对已结束的场次也能读到 `onlineNum`（该场结束时的值），
   *     但那是历史数字，写成「N 人在线」属语义误导 → 回放一律不显示
   *   - 持有 `stat` 能力的有两处：MediaScreen（`playerIsLive` 守卫）与
   *     BilibiliLiveScreen；**房间内直播/回放**（FollowedRoomsScreen）已按要求完全不传
   * 改动这里前，先确认这三处口径一致。
   */
  stat?: { icon: string; text: string };
}

/** 弹幕源（三引擎统一）：poll=口袋直播 HTTP 轮询；lrc=录播 LRC 文件；ws=B站 WebSocket */
export type DanmakuSource =
  | { type: 'none' }
  | { type: 'poll'; liveId: string }
  | { type: 'lrc'; lrcUrl: string; liveId?: string }
  | { type: 'ws'; roomId: string };

/** 功能开关：页面声明需要哪些能力，PlayerChrome 按需渲染 */
export interface PlayerFeatures {
  /** 倍速（1/1.5/2） */
  rate?: boolean;
  /** 弹幕开关 + 弹幕设置 */
  danmaku?: boolean;
  /** 直播送礼面板（口袋） */
  gift?: boolean;
  /** 贡献榜（口袋） */
  rank?: boolean;
  /** 画质切换（B站） */
  quality?: boolean;
  /** 续播记忆 */
  resume?: boolean;
  /** 内核互切（原生 <-> 网页） */
  kernelSwitch?: boolean;
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
    onPress: () => void;
  }>;
  /** 顶栏左上按钮（返回键右侧、标题前）：如公告开关 —— 收起后仍可随时点开（2026-09-26） */
  topLeftAction?: {
    icon: string;
    label: string;
    active?: boolean;
    onPress: () => void;
  };
  onClose?: () => void;
}
