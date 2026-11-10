/**
 * 统一播放会话层导出（四场景唯一入口）。
 *
 * 用法（页面只做三件事）：
 *   1) 用 PlayMedia 描述「要播什么」；
 *   2) 渲染 <MediaPlaybackHost media={...} onClose={...} />；
 *   3) 场景特有的按钮/浮层走 extraActions / beforePlayer / afterPlayer 插槽。
 */
export { MediaPlaybackHost, default as MediaPlaybackHostDefault } from './MediaPlaybackHost';
export type { MediaPlaybackHostProps, MediaPlaybackHostHandle } from './MediaPlaybackHost';
export { usePlaybackSession, playMediaKey } from './usePlaybackSession';
export { resolveMedia } from './resolveMedia';
/** 官方「本场累计观看人次」（不是实时在线；实时在线见 useLiveBarrage().online 与宿主的 onlineStat） */
export { usePlaybackOnlineStat } from './usePlaybackOnlineStat';
export { usePlaybackResume } from './usePlaybackResume';
export { usePlaybackDanmaku } from './usePlaybackDanmaku';
export type {
  PlayKind,
  PlayMedia,
  ResolvedMedia,
  PlaybackAction,
  PlaybackTopAction,
  PlaybackStatus,
} from './types';
