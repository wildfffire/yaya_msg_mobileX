import { create } from 'zustand';

/** 应用内悬浮小窗播放信息 */
export interface MiniPlayerInfo {
  url: string;
  title: string;
  cover?: string;
  isLive: boolean;
  /** 纯音频源（上麦/电台）：小窗渲染为紧凑胶囊（扁 pill）而非视频框 */
  audioOnly?: boolean;
  /** 交棒给小窗时的播放位置（秒），小窗 onLoad 后 seek 续播 */
  position?: number;
  /** ⚠️ 大窗已知的视频宽高（PlayerCore onVideoSize 上报）：小窗用它**立刻**按比例适配容器。
   *  部分流（rtmp/flv 原生视图、部分录播）onLoad/onVideoSizeChanged 拿不到尺寸，
   *  此前小窗一直停在默认 180×104，竖屏内容被 cover 裁得只剩中间（用户反馈「没自适应/空间不对」）。 */
  aspectW?: number;
  aspectH?: number;
  /** 公演/B站直播走网页内核播放（去 LIVE 标 + WebAudio 增益） */
  web?: { headers?: Record<string, string>; volumeBoost?: number };
  /** 点击小窗回放（全屏）参数：直接传回 MediaScreen 路由参数 */
  backTo: {
    mode: 'live' | 'vod';
    playUrl: string;
    playTitle?: string;
    playCover?: string;
    /** 小窗→大窗续播位置（仅录播；MediaScreen 直接按此 seek） */
    playPosition?: number;
    /**
     * 成员名 / 队伍 / 成员数字 id。
     *
     * ⚠️ 必须跟着 backTo 走：小窗期间大窗（MediaScreen）已卸载，回大窗是**新的一次
     * 路由直达**（走 `playUrl` 分支重新构造 PlayMedia），不带这三个字段 →
     * 播放器右上角「队伍徽章 + 成员名」胶囊又变空（用户 2026-11-08）。
     */
    playOwner?: string;
    playTeam?: string;
    playOwnerId?: string;
    /**
     * 来源成员 id（房间内拉起的直播/回放才带）：
     * 「返回全屏」时优先回**她的房间**而不是直播 tab ——
     * 用户 2026-09-30 明确要求「从房间进的直播，退出也要留在房间里」。
     */
    roomMemberId?: string;
  };
}

interface MiniPlayerState {
  info: MiniPlayerInfo | null;
  visible: boolean;
  playing: boolean;
  /** 小窗实时播放位置（秒）：点小窗回大窗时据此续播（大小窗切换不丢进度） */
  currentPos: number;
  /**
   * 系统 PiP ⏯ 点击触发序号：外部（PipToggleBridge）无法直接碰 MiniPlayer 的 WebView ref，
   * 只能经 store 发信号，MiniPlayer 组件监听序号变化后执行与点小窗暂停键相同的切换逻辑。
   */
  sysToggleSeq: number;
  open: (info: MiniPlayerInfo) => void;
  close: () => void;
  setPlaying: (p: boolean) => void;
  setCurrentPos: (p: number) => void;
  requestSysToggle: () => void;
}

export const useMiniPlayerStore = create<MiniPlayerState>((set) => ({
  info: null,
  visible: false,
  playing: true,
  currentPos: 0,
  sysToggleSeq: 0,
  open: (info) => set({ info, visible: true, playing: true, currentPos: 0 }),
  close: () => set({ visible: false, info: null, currentPos: 0 }),
  setPlaying: (playing) => set({ playing }),
  setCurrentPos: (currentPos) => set({ currentPos }),
  requestSysToggle: () => set((s) => ({ sysToggleSeq: s.sysToggleSeq + 1 })),
}));
