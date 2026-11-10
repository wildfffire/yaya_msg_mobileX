import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { logWarn } from '../../utils/runtimeLog';
import { NativeKernel, NativeKernelHandle } from './NativeKernel';
import { ExoKernel } from './ExoKernel';
import { WebKernel, WebKernelHandle } from './WebKernel';

/**
 * 直播「暂停后继续」回到实时的阈值（毫秒）：
 * 暂停时长超过它才在恢复时重建内核 —— 只为瞥一眼而短暂暂停时，重建（黑一下）不划算。
 */
const LIVE_RESUME_EDGE_MS = 5000;
/**
 * PlayerCore：内核路由（重写核心）。
 * 按 store.activeKernel 渲染对应内核，并统一回调写回 store。
 * 内核选择规则（由 streamResolver + 用户切换共同决定）：
 *  - rtmp/flv → exo（原生 LiveExoView，自带 5 次重试）
 *  - hls/mp4/audio → native（RNV）
 *  - 用户切网页 / 原生失败 → web（flv.js + hls.js）
 */
export function PlayerCore({ onVideoSize, resumeAt: externalResumeAt }: { onVideoSize?: (w: number, h: number) => void; resumeAt?: number }) {
  const source = usePlayerStore((s) => s.source);
  const state = usePlayerStore((s) => s.state);
  const activeKernel = usePlayerStore((s) => s.activeKernel);
  const useWebKernel = usePlayerStore((s) => s.useWebKernel);
  /**
   * 续播起点用的播放进度：**直读、不订阅**。
   *
   * 原来这里是 `usePlayerStore((s) => s.position)` —— position 是 4Hz 字段
   * （NativeKernel progressUpdateInterval=250ms），订阅它会让 PlayerCore 每 250ms
   * 重渲染一次，并把新 props 透传给 NativeKernel/WebKernel（进而每次重建 source 对象、
   * 跨桥重新下发）。而 `resumeAt` 只在 onLoad 时被读取一次，根本不需要实时性。
   *
   * 直读即可：内核挂载必然伴随一次渲染（source/activeKernel/retryNonce 变化），
   * 那次渲染取到的就是当时的进度，与原行为等价。
   */
  const resumePosition = usePlayerStore.getState().position;
  const nativeRef = useRef<NativeKernelHandle>(null);
  const webRef = useRef<WebKernelHandle>(null);
  /** 诊断去重：记录上次已打日志的内核|源（⚠️ 必须放所有条件 return 之前——Hook 铁律） */
  const lastLogged = useRef('');
  // 公演默认网页失败→原生 的自动回退标记（按源复位）
  const webFallbackDone = useRef(false);
  const sourceChangedRef = useRef('');
  /**
   * 直播断流自动重连（对齐桌面 player-core.installArtLiveRecovery 的目的）：
   * 候选线路全部失败后仍按 1.5s/3s/6s 退避重试，最多 3 次；`retryNonce` 递增 → 内核 key 变化 → 重新拉流。
   */
  const [retryNonce, setRetryNonce] = useState(0);
  const liveRetry = useRef<{ count: number; timer: ReturnType<typeof setTimeout> | null }>({ count: 0, timer: null });
  /**
   * 候选线路轮换退避：连续失败时逐次拉大切换间隔（0/2s/4s/…封顶 15s）。
   * 旧实现失败后立即切下一线路，坏线路多时 1~2 秒打满全部候选（日志实证：
   * 90 秒内换线 18 次），还容易触发平台风控。首次失败仍立即切换保证快速恢复。
   */
  const switchFailStreak = useRef(0);
  const switchBackoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setState = usePlayerStore((s) => s.setState);
  const setPosition = usePlayerStore((s) => s.setPosition);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const setError = usePlayerStore((s) => s.setError);
  const setUseWebKernel = usePlayerStore((s) => s.setUseWebKernel);
  const seekTarget = usePlayerStore((s) => s.seekTarget);

  // seek 指令消费：UI 拖动进度条 → 当前内核 seek（native/exo 直调；web 经 postMessage）→ 清零
  useEffect(() => {
    if (seekTarget <= 0) return;
    const su = String(source?.url || '').toLowerCase();
    const liveShape = source?.kind === 'live' || su.startsWith('rtmp://') || su.startsWith('rtmps://') || su.includes('.flv');
    if (liveShape) {
      // 直播流 seek 无意义且可能原生崩溃（Exo 对直播 HLS/RTMP seek 抛异常）→ 丢弃指令
      usePlayerStore.getState().setSeekTarget(0);
      return;
    }
    // 非有限时长 = 误标 VOD 的直播 HLS（Exo 对其 seek 会在原生线程抛异常闪退）→ 丢弃指令
    const sd = usePlayerStore.getState().duration;
    if (!Number.isFinite(sd) || sd <= 0) {
      usePlayerStore.getState().setSeekTarget(0);
      return;
    }
    // clamp：不得 seek 到流末尾之外（Exo 对末尾边界 seek 行为异常，易触发原生异常）
    const target = Math.max(0, Math.min(sd - 0.3, seekTarget));
    usePlayerStore.getState().setPosition(target);
    usePlayerStore.getState().setSeekTarget(0);
    if (!useWebKernel && activeKernel === 'native' && nativeRef.current) {
      try {
        nativeRef.current.seek(target);
      } catch (err) {
        console.warn('[PlayerCore] native seek err', err);
      }
    } else if (useWebKernel && webRef.current) {
      try {
        webRef.current.seek(target);
      } catch (err) {
        console.warn('[PlayerCore] web seek err', err);
      }
    }
  }, [seekTarget, useWebKernel, activeKernel]);
  // rate 同步：web 内核每次倍速变化下发（native 经 prop 实时生效）
  const rate = usePlayerStore((s) => s.rate);
  useEffect(() => {
    if (useWebKernel && webRef.current && rate > 0) {
      webRef.current.setRate(rate);
    }
  }, [rate, useWebKernel]);

  // 播放/暂停驱动：native/exo 经 paused prop 由 store.state 直达；web 内核的 <video> 不在 RN
  // 控制下（html autoplay 起播），必须显式 postMessage 才能暂停/续播——
  // 修复：网页直播/录播按控制条或系统 PiP ⏯ 暂停时画面继续播/声音不停（控件"失灵"）。
  const kernelForState = useWebKernel ? 'web' : activeKernel;
  const webPauseRef = useRef<boolean | null>(null);
  // 内核切换 / 源变化 → html 整页重载（autoplay 起播），旧暂停指令作废：复位去重哨兵
  useEffect(() => {
    webPauseRef.current = null;
  }, [kernelForState, source?.url]);
  useEffect(() => {
    if (kernelForState !== 'web' || !source?.url || !webRef.current) return;
    if (state !== 'playing' && state !== 'paused') return;
    const wantPaused = state === 'paused';
    if (webPauseRef.current === wantPaused) return;
    webPauseRef.current = wantPaused;
    try {
      webRef.current.setPaused(wantPaused);
    } catch (err) {
      console.warn('[PlayerCore] web pause err', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, kernelForState, source?.url]);

  const handleLoad = useCallback(
    (duration: number, naturalSize?: { width: number; height: number }) => {
      setDuration(duration);
      setState('playing');
      if (onVideoSize && naturalSize) {
        onVideoSize(naturalSize.width, naturalSize.height);
      }
    },
    [setDuration, setState, onVideoSize],
  );

  const handleProgress = useCallback(
    (t: number) => {
      if (state !== 'paused') setPosition(t);
    },
    [state, setPosition],
  );

  // 原生 → 网页兜底（内核互切）
  // ⚠️ 全部 hooks 必须在条件 return 之前（source null 时提前返回会导致
  // hooks 数量变化 → "Rendered more hooks than during the previous render" 崩溃）
  const switchToWeb = useCallback(() => {
    setUseWebKernel(true);
    setError('');
    setState('playing');
  }, [setUseWebKernel, setError, setState]);

  const kernelError = useCallback(
    (msg: string) => {
      // 诊断：内核失败原因写 runtimeLog（设置→日志可导出）
      try { logWarn(`[player] kernel fail ${msg}`, 'player.kernelError'); } catch {}
      // ★ 候选轮换退避：首次失败立即切（快速恢复），连续失败按 2s/4s/…（封顶 15s）延迟切换
      switchFailStreak.current += 1;
      const streak = switchFailStreak.current;
      const backoffMs = streak <= 1 ? 0 : Math.min((streak - 1) * 2000, 15000);
      const tryNext = () => {
        switchBackoffTimer.current = null;
        // 有候选线路 → 自动切换下一线路（B站多线路/官方多备用地址）；全部失败才进 error 态
        const switched = usePlayerStore.getState().nextCandidate();
        if (switched) return;
        // 直播断流：候选线路耗尽后仍自动重连（1.5s/3s/6s 退避，最多 3 次），期间保持加载态；
        // 重连 = 递增 retryNonce → 内核 key 变化 → 重新拉流。录播不动（断流多为文件问题，重试无益）。
        const uNow = String(source?.url || '').toLowerCase();
        const isLive = source?.kind === 'live' || uNow.startsWith('rtmp') || uNow.includes('.flv');
        if (isLive && liveRetry.current.count < 3) {
          liveRetry.current.count += 1;
          const n = liveRetry.current.count;
          const delay = 1500 * Math.pow(2, n - 1);
          try { logWarn(`[player] live reconnect ${n}/3 in ${delay}ms`, 'player.reconnect'); } catch {}
          setError('');
          setState('loading');
          if (liveRetry.current.timer) clearTimeout(liveRetry.current.timer);
          liveRetry.current.timer = setTimeout(() => {
            liveRetry.current.timer = null;
            setRetryNonce((v) => v + 1);
          }, delay);
          return;
        }
        setError(msg);
        setState('error');
      };
      if (backoffMs > 0) {
        try { logWarn(`[player] 候选切换退避 ${backoffMs}ms（连续失败 ${streak} 次）`, 'player.kernelError'); } catch {}
        setError('');
        setState('loading');
        if (switchBackoffTimer.current) clearTimeout(switchBackoffTimer.current);
        switchBackoffTimer.current = setTimeout(tryNext, backoffMs);
        return;
      }
      tryNext();
    },
    [setError, setState, source?.kind, source?.url],
  );

  /**
   * 以下四个内核回调从 JSX 内联箭头提为 useCallback：内联写法每次渲染都是新函数引用，
   * 会让 NativeKernel 的 React.memo 完全失效（等于没有 memo）。
   * 全部定义在条件 return 之前（Hook 铁律）。
   */
  const handleEnd = useCallback(() => setState('paused'), [setState]);
  const handleFirstFrame = useCallback(() => {
    // 首帧上屏：保险起见确保 state 已 playing（加载转圈结束）
    if (usePlayerStore.getState().state === 'loading') setState('playing');
  }, [setState]);
  const handleBufferChange = useCallback((buffering: boolean) => {
    try { logWarn(`[vod] buffer ${buffering ? 'start' : 'end'}`, 'player.native'); } catch {}
  }, []);
  const handleNativeError = useCallback(
    (detail: string) => kernelError(`原生播放器失败：${detail}`),
    [kernelError],
  );
  /**
   * 网页内核的失败回调。提到这里（不再写在 JSX 里）是为了让 WebKernel 的 React.memo 真正生效：
   * 内联箭头每次渲染都是新引用，浅比较必然失败，memo 等于白加。
   * 逻辑与原来逐行一致：公演默认走网页（forceWebOnce）失败 → 自动回退原生一次。
   */
  const handleWebError = useCallback(
    (msg: string) => {
      const st0 = usePlayerStore.getState();
      if (st0.forceWebOnce && !webFallbackDone.current) {
        webFallbackDone.current = true;
        st0.setForceWebOnce(false);
        st0.setUseWebKernel(false);
        return;
      }
      kernelError(msg);
    },
    [kernelError],
  );

  // 开播成功（playing）= 本次重连成功 → 复位计数；换源也要复位
  useEffect(() => {
    if (state === 'playing') {
      liveRetry.current.count = 0;
      switchFailStreak.current = 0;
    }
  }, [state]);
  useEffect(() => {
    liveRetry.current.count = 0;
    switchFailStreak.current = 0;
    if (liveRetry.current.timer) { clearTimeout(liveRetry.current.timer); liveRetry.current.timer = null; }
    if (switchBackoffTimer.current) { clearTimeout(switchBackoffTimer.current); switchBackoffTimer.current = null; }
  }, [source?.url]);
  useEffect(() => () => {
    if (liveRetry.current.timer) clearTimeout(liveRetry.current.timer);
    if (switchBackoffTimer.current) clearTimeout(switchBackoffTimer.current);
  }, []);

  // 内核选择（仅依赖 store，不依赖 source，须在条件 return 前算出）
  const kernel = useWebKernel ? 'web' : activeKernel;

  /**
   * 直播「暂停 → 继续」时回到直播边缘（用户 2026-09-30 要求直播也能双击暂停/继续）。
   *
   * 为什么必须处理：暂停期间**服务器时间照走**，从暂停点继续会让画面落后一大截
   *（暂停一分钟就是落后一分钟，弹幕/内容全错位）。
   * 分内核策略：
   *  - Exo(LiveExoView, rtmp/flv/直播 HLS)：原生**不支持对直播 seek** → 递增 retryNonce
   *    重建内核重新拉流，等价于「回到实时」；
   *  - native(RNV/HLS 直播)：ExoPlayer 的 live targetOffset 会自行追到边缘，不重建
   *   （重建会黑屏一下，得不偿失）；
   *  - web(flv.js)：暂无可靠追赶手段，保持原行为（次要内核，少见）。
   * 短暂暂停（< LIVE_RESUME_EDGE_MS）不重建：只为瞥一眼而黑一下不划算。
   *
   * ⚠️ 必须放在 `kernel` 声明之后：本 effect 要按内核分流（放到前面会 TDZ 报错）。
   */
  const pausedAtRef = useRef(0);
  const prevStateRef = useRef(state);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (state === 'paused') { pausedAtRef.current = Date.now(); return; }
    if (state !== 'playing' || prev !== 'paused') return;
    if (kernel !== 'exo') return;
    const uNow = String(source?.url || '').toLowerCase();
    const liveShape = source?.kind === 'live' || uNow.startsWith('rtmp://') || uNow.startsWith('rtmps://') || uNow.includes('.flv');
    if (!liveShape) return;
    if (Date.now() - pausedAtRef.current < LIVE_RESUME_EDGE_MS) return;
    try { logWarn('[player] live resume after pause → rebuild kernel to live edge', 'player.core'); } catch {}
    // 保持加载态（直播 loading 不显示转圈）→ 首帧 onSize → 回到 playing
    setState('loading');
    setRetryNonce((v) => v + 1);
  }, [state, kernel, source?.url, source?.kind, setState]);

  if (!source || !source.url) return null;
  // 自动回退标记按源复位（source 已判非空）
  if (webFallbackDone.current !== false && sourceChangedRef.current !== source.url) {
    sourceChangedRef.current = source.url;
    webFallbackDone.current = false;
  }

  const paused = state !== 'playing';
  // 诊断：每次开播记录所选内核与源（runtimeLog；非 hook，可放 return 后）
  if (lastLogged.current !== `${kernel}|${source.url}`) {
    lastLogged.current = `${kernel}|${source.url}`;
    try { logWarn(`[player] open kernel=${kernel} state=${state} kind=${source.kind} url=${String(source.url).slice(0, 90)}`, 'player.core'); } catch {}
  }

  // ⚠️ 下面传给 WebKernel 的回调必须是稳定引用，否则它的 React.memo 失效（见 handleWebError 注释）
  if (kernel === 'web') {
    return (
      <WebKernel
        key={`web-${source.url}-${retryNonce}`}
        ref={webRef}
        source={source}
        resumeAt={resumePosition > 1 ? resumePosition : 0}
        onProgress={handleProgress}
        onEnded={handleEnd}
        onFirstFrame={handleFirstFrame}
        onError={handleWebError}
      />
    );
  }
  if (kernel === 'exo') {
    return (
      <ExoKernel
        key={`exo-${source.url}-${retryNonce}`}
        source={source}
        onError={(msg) => {
          kernelError(msg);
          // 网页兜底仅对浏览器可播的 http 流（HLS/mp4）；rtmp/rtmps/flv 是 LiveExoView 专属，
          // 切网页内核必黑屏（23:19 实测成员直播 rtmp fail 后误切 web 加载不出）→ 保留 error 态走重试
          const uWeb = String(source.url || '').toLowerCase();
          const webable = !source.audioOnly
            && /^https?:/i.test(uWeb)
            && !uWeb.startsWith('rtmp')
            && !uWeb.includes('.flv');
          if (webable) switchToWeb();
        }}
      />
    );
  }
  return (
    <NativeKernel
      key={`native-${source.url}-${retryNonce}`}
      ref={nativeRef}
      source={source}
      paused={paused}
      rate={rate}
      volume={source.volume}
      resumeAt={externalResumeAt && externalResumeAt > 1 ? externalResumeAt : resumePosition > 1 ? resumePosition : 0}
      onLoad={handleLoad}
      onProgress={handleProgress}
      onEnd={handleEnd}
      onFirstFrame={handleFirstFrame}
      onBufferChange={handleBufferChange}
      onError={handleNativeError}
    />
  );
}

export default PlayerCore;
