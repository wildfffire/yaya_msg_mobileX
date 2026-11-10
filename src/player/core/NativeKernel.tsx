import React, { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import Video from 'react-native-video';
import { PlayerSource } from '../types';
import { logInfo } from '../../utils/runtimeLog';

export interface NativeKernelHandle {
  seek: (t: number) => void;
}

interface Props {
  source: PlayerSource;
  paused: boolean;
  rate: number;
  /** 音量（B站流响度补偿用，默认 1） */
  volume?: number;
  /** 续播起点（onLoad 后 seek） */
  resumeAt?: number;
  onLoad: (duration: number, naturalSize?: { width: number; height: number }) => void;
  onProgress: (t: number) => void;
  onEnd: () => void;
  onError: (detail: string) => void;
  /** 首帧上屏（诊断 + 结束 loading） */
  onFirstFrame?: () => void;
  /** 缓冲开始/结束（诊断卡顿） */
  onBufferChange?: (buffering: boolean) => void;
}

/** RNV 内核：HLS/mp4/mp3/flac 等 ExoPlayer 支持的流 */
const NativeKernelInner = forwardRef<NativeKernelHandle, Props>(function NativeKernel(
  { source, paused, rate, volume = 1, resumeAt, onLoad, onProgress, onEnd, onError, onFirstFrame, onBufferChange },
  ref,
) {
  const videoRef = useRef<any>(null);
  useImperativeHandle(ref, () => ({
    seek: (t: number) => {
      try {
        videoRef.current?.seek?.(t);
      } catch {}
    },
  }));
  /**
   * source 必须记忆化：原先写成行内对象字面量，每次渲染都是新引用 → RN 会跨桥
   * 重新下发一次 source。原生侧 ReactExoplayerView.setSrc() 进入后会先无条件调用
   * clearResumePosition()（在 isSourceEqual 比对**之前**），即每次下发都会清掉续播位置；
   * 虽然值相等时不会 re-init（Source.isEquals 是 data class 值比对），但
   * "清掉续播位置 + 每帧跨桥传对象"都是纯浪费，且一旦紧接着发生 re-init 就丢了续播点。
   */
  const videoSource = useMemo(
    () => ({
      uri: source.url,
      ...(source.headers ? { headers: source.headers } : {}),
      // AWS/CDN 流播放中偶发缓冲耗尽卡顿：加大 Exo 缓冲池 + 30s 回看缓冲
      bufferConfig: {
        minBufferMs: 15000,
        maxBufferMs: 60000,
        bufferForPlaybackMs: 5000,
        bufferForPlaybackAfterRebufferMs: 10000,
        backBufferDurationMs: 30000,
      },
    }),
    [source.url, source.headers],
  );
  return (
    <Video
      ref={videoRef}
      key={source.url}
      source={videoSource}
      style={StyleSheet.absoluteFill}
      resizeMode="contain"
      paused={paused}
      rate={rate}
      volume={volume}
      progressUpdateInterval={250}
      ignoreSilentSwitch="ignore"
      playInBackground
      playWhenInactive
      onLoad={(e) => {
        try { logInfo(`[vod] NativeKernel onLoad dur=${Math.round(e.duration || 0)}`, 'player.native'); } catch {}
        const ns = e?.naturalSize;
        onLoad(
          e.duration || 0,
          ns && Number(ns.width) > 0 && Number(ns.height) > 0
            ? { width: Number(ns.width), height: Number(ns.height) }
            : undefined,
        );
        if (resumeAt && resumeAt > 1) {
          try {
            videoRef.current?.seek?.(resumeAt);
          } catch {}
        }
      }}
      onProgress={(e) => onProgress(e.currentTime || 0)}
      onEnd={onEnd}
      onReadyForDisplay={() => {
        try { logInfo('[vod] first frame onReadyForDisplay', 'player.native'); } catch {}
        onFirstFrame?.();
      }}
      onBuffer={(e) => {
        onBufferChange?.(!!e?.isBuffering);
      }}
      onError={(event: any) => {
        try {
          const raw = event?.error || event;
          const msg = String(raw?.message || raw?.errorType || raw?.type || raw?.code || raw?.cause?.message || '');
          const full = JSON.stringify(raw || {}).slice(0, 1400);
          logInfo(`[vod] onError msg=${msg.slice(0, 260)} full=${full.slice(0, 1000)}`, 'player.native');
        } catch {}
        onError(JSON.stringify(event?.error || event).slice(0, 220));
      }}
    />
  );
});

/**
 * 包 memo：props（paused/rate/volume/onLoad…）未变时不再重渲染 <Video>。
 * 原先没有 memo，父级（PlayerCore/PlayerScreen）任何一次渲染都会穿透到这里。
 */
export const NativeKernel = React.memo(NativeKernelInner);

export default NativeKernel;
