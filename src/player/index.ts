/**
 * 播放器统一入口（页面只从这里 import）。
 *
 * 分层：
 *  - PlayerScreen：唯一 UI 组装（控制层/全屏/PiP/内核路由内部完成）
 *  - session/MediaPlaybackHost：四场景（主直播 / 房间 / 历史 / 稍后再看）唯一播放入口
 *      —— 解析、续播、弹幕、在线人数、小窗、公告、礼物、贡献榜都在里面
 *  - session/playEntry：「播什么」的唯一构造点
 *  - store/playerStore：全局单例状态
 *
 * ⚠️ 2026-11-13：原先还从 `resolve/streamResolver.ts` 导出一整套流判定
 *（classifyUrl / pickPlayableUrls / streamScore / needsNativeExo / resolveSource …），
 * 实测**没有任何外部调用方**，真正的实现都在 `screens/room/mediaRules.ts` 与
 * `utils/playUrls.ts`；那份代码已删除，只保留防盗链头并从 `utils/mediaHeaders` 复用。
 */
export { PlayerScreen } from './PlayerScreen';
export { InlineMediaPlayer } from './InlineMediaPlayer';
export { MediaPlaybackHost } from './session';
export type { MediaPlaybackHostProps, MediaPlaybackHostHandle, PlayMedia, ResolvedMedia } from './session';
export { default as usePlayerStore } from './store/playerStore';
/** 口袋防盗链头（唯一来源：utils/mediaHeaders；页面 source.headers 用） */
export { POCKET_MEDIA_HEADERS, buildPocketHeaders } from '../utils/mediaHeaders';
export type {
  StreamKind,
  PlayerSource,
  PlayerMeta,
  DanmakuSource,
  PlayerFeatures,
  PlayerScreenProps,
} from './types';

export { default } from './PlayerScreen';
