/**
 * 统一播放会话层导出（四场景唯一入口）。
 *
 * 用法（页面只做三件事）：
 *   1) 用 PlayMedia 描述「要播什么」；
 *   2) 渲染 <MediaPlaybackHost media={...} onClose={...} />；
 *   3) 场景特有的按钮/浮层走 extraActions / beforePlayer / afterPlayer 插槽。
 */
export { MediaPlaybackHost, default as MediaPlaybackHostDefault } from './MediaPlaybackHost';
export type { MediaPlaybackHostProps, MediaPlaybackHostHandle, PlaybackScene } from './MediaPlaybackHost';
export { usePlaybackSession, playMediaKey } from './usePlaybackSession';
export { usePlaybackGift } from './usePlaybackGift';
export type { UsePlaybackGiftOptions } from './usePlaybackGift';
export { resolveMedia } from './resolveMedia';
/**
 * 统一播放入口（用户 2026-11-13）：「播什么」只在这里构造。
 * 四场景（直播页 / 房间 / 历史 / 稍后再看）都调用同一组函数 + 同一个宿主，别再各拼一份。
 */
export {
  playMediaFromLiveItem,
  playMediaFromWatchEntry,
  playMediaFromWatchLaterItem,
  playMediaFromHistoryItem,
  playMediaFromRoomMedia,
  playMediaFromRoomReplay,
} from './playEntry';
export type { PlayOwnerHints, RoomPlayHints, WatchRefKind } from './playEntry';
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
