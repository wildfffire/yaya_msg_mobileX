/**
 * 内联小播放器（聊天气泡 / 翻牌答案 / 分析页 / 列表内的音频视频）。
 *
 * 用户 2026-11-13：这类「就地展开的小播放器」以前在 5 个页面各写一遍
 * `<PlayerScreen inline features={{kernelSwitch:true, rate:true}} …>`，
 * 而且**会写观看历史**（这些内容没有 ref/liveId，历史里点开必然解析失败）。
 * 现在统一到这里：
 *   · inline 模式 + 固定 features（倍速 / 内核互切）；
 *   · `recordHistory={false}`（没有可回放来源，不进历史）；
 *   · 不提供小窗（小窗属于大播放器场景）。
 *
 * 需要全屏/续播/弹幕/小窗的场景请用 `MediaPlaybackHost`，不要用这个。
 */
import React from 'react';
import type { ReactNode } from 'react';
import { PlayerScreen } from './PlayerScreen';
import type { PlayerMeta, PlayerSource } from './types';

/** 内联播放器的固定能力：能切倍速、能切内核，其余（弹幕/小窗/续播）不挂 */
const INLINE_FEATURES = { kernelSwitch: true, rate: true } as const;

export interface InlineMediaPlayerProps {
  source: PlayerSource;
  meta?: PlayerMeta;
  onClose?: () => void;
  onVideoSize?: (w: number, h: number) => void;
  /** 场景附加层（如电台节目的「切换线路」按钮） */
  children?: ReactNode;
}

export function InlineMediaPlayer({ source, meta, onClose, onVideoSize, children }: InlineMediaPlayerProps) {
  return (
    <PlayerScreen
      inline
      source={source}
      meta={meta || { title: '' }}
      features={INLINE_FEATURES}
      recordHistory={false}
      onClose={onClose}
      onVideoSize={onVideoSize}
    >
      {children}
    </PlayerScreen>
  );
}

export default InlineMediaPlayer;
