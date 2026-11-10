/**
 * 统一播放会话层（四场景共用）· 类型定义
 *
 * 背景（用户 2026-10-02 要求）：
 *   直播页（MediaScreen）/ 房间内（FollowedRoomsScreen）/ 历史记录 / 稍后再看
 *   四个场景以前各自拼装「解析 → 续播 → 弹幕源 → 在线人数 → 小窗 → 关闭」，
 *   同一套逻辑写了两三份（MediaScreen 一份、房间一份、watch 列表一份）。
 *   现在收口到本层：页面只声明 **PlayMedia（播什么）** + 少量插槽，
 *   其余全部由 `MediaPlaybackHost` 统一完成（B 站直播不在统一范围内，保持独立）。
 *
 * 分层（不循环依赖）：
 *   session/types        ← 本文件（纯类型）
 *   session/resolveMedia ← 解析（live/replay/video/openlive/audio 五形态统一入口）
 *   session/use*         ← 会话 hook（解析态 / 在线人数 / 续播 / 弹幕 / 小窗）
 *   session/MediaPlaybackHost ← 唯一宿主组件（解析中/失败态 + PlayerScreen + 通用 overlay）
 */
import type { PlayerContentRef } from '../types';

/**
 * 统一播放形态（决定解析链路与弹幕/进度语义）：
 *   live     正在进行的直播（口袋）
 *   replay   房间/历史里的「直播回放」（liveId 重新解析，可按录播拖进度）
 *   video    官方视频库（videoId）
 *   openlive 公演回放（liveId）
 *   audio    房间语音 / 上麦等纯音频（地址必现，不解析）
 *   direct   自带地址直接播放（房间里的视频消息等，不做任何网络解析）
 */
export type PlayKind = 'live' | 'replay' | 'video' | 'openlive' | 'audio' | 'direct';

/**
 * 一条「要播的东西」：四场景统一入口。
 *
 * 页面只需要声明它是谁、从哪来：
 *   - 已带地址（列表项自带 / 房间消息卡自带）→ 传 `url`，宿主**立即起播**再后台补全；
 *   - 只有 id（历史/稍后再看等）→ 只传 `liveId` / `videoId`，宿主负责解析；
 *   - 已判定是否直播时传 `isLive`（如 MediaScreen 的 tab 预判、房间解析结果）。
 */
export interface PlayMedia {
  kind: PlayKind;
  /** 已有可直接播放的地址（可选；有则快速起播） */
  url?: string;
  /** 候选地址（房间解析结果可带多条，失败自动切换） */
  urls?: string[];
  /** 直播 / 回放 id */
  liveId?: string;
  /** 官方视频 id（kind='video'） */
  videoId?: string;
  title?: string;
  cover?: string;
  /** 归属成员昵称 / 队伍 / 数字 id（写历史与列表卡片用，播放器不显示） */
  owner?: string;
  team?: string;
  ownerId?: string;
  /**
   * 是否直播（调用方的明确判定）：
   *   - MediaScreen：tab 预判（点直播 tab = live）
   *   - 房间：解析结果（!roomTapIsVod）
   *   - 不传：统一按 mediaRules 的口径推断（rtmp/flv → live；m3u8/mp4 需命中直播列表）
   */
  isLive?: boolean;
  /** 纯音频（房间语音/上麦）：不渲染画面 */
  audioOnly?: boolean;
  /**
   * 电台直播（`liveType = 2`）：官方推流画面只有「成员离开」占位图，
   * 播放器要用成员照片轮播盖住画面（照片来自 getLiveOne 的 `carousels`）。
   * 列表项已知类型时传它 → 首帧就是轮播形态，不会先闪一下占位图。
   */
  radio?: boolean;
  /** 已拿到的轮播照片（解析详情顺手带出；没有则由宿主按 liveId 补拉） */
  carouselPhotos?: string[];
  /** 轮播间隔（毫秒，官方 carouselTime） */
  carouselIntervalMs?: number;
  /** 房间成员 id：在线人数兜底（成员反查 liveId）用 */
  memberId?: string | number;
  /** 官方条目原始对象（场景特有信息，如公告字段） */
  raw?: any;
}

/** 解析后的播放结果（宿主内部使用，也通过 onResolved 回调给页面） */
export interface ResolvedMedia {
  url: string;
  urls: string[];
  headers?: Record<string, string>;
  title: string;
  cover?: string;
  liveId: string;
  isLive: boolean;
  /** rtmp/flv → 原生 Exo 内核 */
  needsExo: boolean;
  audioOnly: boolean;
  /** 内容来源引用（历史记录/稍后再看事后重新解析用） */
  ref?: PlayerContentRef;
  /** 解析接口返回的原始详情（公告等场景特有字段） */
  detail?: any;
  /** 电台直播（liveType=2）：播放器渲染照片轮播而不是视频画面 */
  radio?: boolean;
  /** 电台轮播照片（getLiveOne → content.carousels） */
  carouselPhotos?: string[];
  /** 轮播间隔（毫秒） */
  carouselIntervalMs?: number;
}

/** 场景追加的控制坞按钮（与 PlayerChrome.extraActions 同构） */
export interface PlaybackAction {
  key: string;
  icon: string;
  label: string;
  active?: boolean;
  onPress: () => void;
}

/** 宿主顶部左上按钮（公告等） */
export interface PlaybackTopAction {
  icon: string;
  label: string;
  active?: boolean;
  onPress: () => void;
}

/** 会话状态 */
export type PlaybackStatus = 'idle' | 'resolving' | 'ready' | 'error';
