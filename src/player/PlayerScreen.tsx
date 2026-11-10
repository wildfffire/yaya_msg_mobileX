import React, { ReactNode, useEffect, useMemo, useRef } from 'react';
import { Modal, PanResponder, StyleSheet, View } from 'react-native';
import { usePlayerStore } from './store/playerStore';
import { useMiniPlayerStore } from '../store/miniPlayerStore';
import { useUiStore } from '../store';
import { PlayerCore } from './core/PlayerCore';
import { PlayerChrome } from './chrome/PlayerChrome';
import { FullscreenManager } from './chrome/FullscreenManager';
import { PlayerScreenProps } from './types';
import { logInfo } from '../utils/runtimeLog';
import { useWatchHistoryStore } from '../services/watchHistory';

interface Props extends PlayerScreenProps {
  /** 弹幕 overlay 等附加层插槽（由页面挂 DanmakuOverlay） */
  children?: ReactNode;
  /** 内嵌模式：容器透明由外部定高，Chrome 无顶栏；点全屏 → Modal 全屏呈现 */
  inline?: boolean;
  /** 视频实际尺寸回调（气泡/列表按内容比例自适应容器） */
  onVideoSize?: (w: number, h: number) => void;
  /** 外部续播位置（秒；如 MediaScreen 的 webResumeTime），优先于内部 position */
  resumeAt?: number;
  /** 错误重试回调（直播流地址时效：页面重新解析而非重播同 URL） */
  onRetry?: () => void;
  /** 直播弹幕输入条：渲染进播放器底部控制坞（随控制条自动隐藏/呼出） */
  barrageInput?: ReactNode;
  /** 右上角成员名点击（进入成员房间）：不传 = 只展示不可点 */
  memberAction?: () => void;
  /**
   * 水平手势转发（电台照片轮播用）：开始 / 拖动 / 松手 / 取消。
   *
   * 只有传了才挂手势识别 —— 录播进度条拖动同样是水平手势，
   * 普通播放器绝不能挂（否则拖进度条会被当成翻页）。
   * 手势落在播放器容器上（而不是照片层），因为照片层在 PlayerChrome 之下收不到触摸。
   */
  swipeHandlers?: {
    onStart?: () => void;
    onMove?: (dx: number) => void;
    onEnd?: (dx: number, vx: number) => void;
    onCancel?: () => void;
  };
}

/** 水平滑动：超过这个位移才接管手势（点击/双击/长按都不受影响） */
const SWIPE_CLAIM_DX = 16;
/** 判定是否为「横向手势」：横向明显大于纵向 */
function isHorizontalDrag(dx: number, dy: number) {
  return Math.abs(dx) > SWIPE_CLAIM_DX && Math.abs(dx) > Math.abs(dy) * 1.4;
}

/**
 * 统一播放器页（重写核心）：页面只声明「播什么、带哪些功能」，
 * 内核路由/控制层/全屏/续播/内核切换全部内部完成。
 *
 * 用法：
 * <PlayerScreen
 *   source={{ kind:'live'|'vod'|'audio', url, urls, liveId, needsNativeExo, headers, audioOnly }}
 *   meta={{ title, cover }}
 *   danmaku={{ type:'poll'|'lrc'|'ws'|'none', ... }}
 *   features={{ rate, danmaku, gift, rank, quality, resume, kernelSwitch }}
 *   extraActions={[{ key:'gift', icon:'gift', label:'礼物', onPress }]}
 *   onClose={() => ...}
 * />
 */
export function PlayerScreen({ source, meta, danmaku = { type: 'none' }, features = {}, extraActions = [], topLeftAction, onClose, children, inline = false, onVideoSize, resumeAt, onRetry, barrageInput, swipeHandlers, memberAction }: Props) {
  // 播放错误自动重解析（假死/URL 失效场景）：RTMP 流 URL 带 wsSecret 且多为单次有效，
  // 原生重连同 URL 只会再拿一帧；有 onRetry（页面重新解析新地址）时自动触发，同源最多 2 次。
  const dbgState = usePlayerStore((s) => s.state);
  const autoRetryLeft = useRef(2);
  useEffect(() => {
    autoRetryLeft.current = 2; // 换源（新 url）重置自动重试额度
  }, [source.url]);
  useEffect(() => {
    if (dbgState !== 'error' || !onRetry) return;
    // 网页内核失败（CORS/容器兼容）重解析拿新地址也救不回来 → 不自动循环，保留错误卡手动重试
    if (usePlayerStore.getState().activeKernel === 'web') return;
    if (autoRetryLeft.current <= 0) return;
    autoRetryLeft.current -= 1;
    try { logInfo(`[player] error → auto re-resolve (fresh url), left=${autoRetryLeft.current}`, 'player.screen'); } catch {}
    const t = setTimeout(() => { try { onRetry(); } catch {} }, 900);
    return () => clearTimeout(t);
  }, [dbgState, onRetry]);
  /**
   * 播放器存在期间锁定「底部 Tab 横划切页」：
   * 进度条拖动是横向手势，48px 阈值一定会被误判成切页（用户体感：拖进度条整页跳走）。
   * 用 useUiStore 的计数锁，与「进房间」的锁互不干扰。
   */
  const lockTabSwipe = useUiStore((s) => s.lockTabSwipe);
  const unlockTabSwipe = useUiStore((s) => s.unlockTabSwipe);
  useEffect(() => {
    lockTabSwipe();
    return () => unlockTabSwipe();
  }, [lockTabSwipe, unlockTabSwipe]);

  // R4: 把页面 onClose 注册进 playerStore，硬件返回键经 FullscreenManager 调它（清理页面状态）
  useEffect(() => {
    if (!onClose) return;
    const prev = usePlayerStore.getState().onClose;
    usePlayerStore.getState().setOnClose(onClose);
    return () => {
      // 仅当自己仍是注册者时才清空（避免覆盖后续挂载的播放器）
      if (usePlayerStore.getState().onClose === onClose) {
        usePlayerStore.getState().setOnClose(prev);
      }
    };
  }, [onClose]);
  const openedFor = useRef('');
  const sourceUrl = source.url || '';
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const rotateDeg = usePlayerStore((s) => s.rotateDeg);
  const mirrorMode = usePlayerStore((s) => s.mirrorMode);
  // 画面旋转/镜像 transform（桌面 DPlayer 对齐：竖屏视频旋转 90° 等）
  const mediaTransform: any = [];
  if (mirrorMode === 'horizontal') mediaTransform.push({ scaleX: -1 });
  if (mirrorMode === 'vertical') mediaTransform.push({ scaleY: -1 });
  if (rotateDeg) mediaTransform.push({ rotate: `${rotateDeg}deg` });

  useEffect(() => {
    if (openedFor.current === sourceUrl) return;
    openedFor.current = sourceUrl;
    // 开大播放器前收起悬浮小窗（独立 store 无互斥 → 否则双路声音）
    const mp = useMiniPlayerStore.getState();
    if (mp && mp.visible) mp.close();
    usePlayerStore.getState().open(source, meta, danmaku);
    /**
     * 观看历史（用户 2026-09-30）：所有大播放器都经这里打开 → 收口记录一次，
     * 不需要每个入口页面各自埋点。只记来源（ref/liveId）与标题，
     * **不记播放地址**（地址有时效，历史页点击时重新解析，见 services/watchHistory.ts）。
     */
    try {
      useWatchHistoryStore.getState().record({
        kind: source.kind,
        ref: source.ref,
        /**
         * liveId 兜底（用户 2026-09-30：「同一个直播多次记录」）：
         * `replay` / `openlive` 的 `ref.id` 就是 liveId —— 带上它，同一直播无论从哪个入口播
         * 都会归到同一条记录（见 services/watchHistory.historyKey 的统一口径）。
         */
        liveId: source.liveId
          || ((source.ref?.kind === 'replay' || source.ref?.kind === 'openlive') ? String(source.ref?.id || '') : '')
          || '',
        title: String(meta?.title || ''),
        cover: meta?.cover,
        // 成员 / 队伍 / 是否音频：历史列表卡片要显示（页面在 meta 里传，拿不到就留空）
        owner: meta?.owner,
        team: meta?.team,
        // 成员数字 id：历史/稍后再看事后补成员名与队伍的**稳定依据**（见 utils/memberMatch）
        ownerId: meta?.ownerId,
        audio: source.kind === 'audio' || !!source.audioOnly,
      });
    } catch {}
    try { logInfo(`[player] PlayerScreen open kind=${source.kind} url=${String(source.url).slice(0, 90)}`, 'player.screen'); } catch {}
    return () => {
      /**
       * 卸载时若全局播放器仍指向本页打开的源 → 关闭（重新解析/换线路后也要清干净，
       * 否则陈旧 source/state 残留可能干扰二次进入播放（首次能进、之后卡首帧））。
       *
       * ⚠️ 判定不能再用 `source.url === sourceUrl` 的严格相等（用户 2026-09-30：「直播退出后
       * 所有界面都出现卡顿」）：直播换线路时 `nextCandidate()` 会把 store 里的 source.url
       * 改成候选地址 → 判定失败 → **close() 永不执行** → 全局单例继续持有 source / meta /
       * danmaku（LRC 可能数千条）以及播放器内核实例，退出后一直占着内存与解码器。
       * 现在按「同一场次」判定：liveId / ref.id 相同（或 url 完全相同）即认为是本页打开的源。
       * 仍然安全：不同场次（liveId 不同）的会话不会被这里关掉。
       */
      const st = usePlayerStore.getState();
      const src: any = st.source;
      if (openedFor.current === sourceUrl && src) {
        const ownLive = String((source as any).liveId || (source as any).ref?.id || '');
        const curLive = String(src.liveId || src.ref?.id || '');
        const sameSession = (!!ownLive && !!curLive && ownLive === curLive) || src.url === sourceUrl;
        if (sameSession) st.close();
      }
      openedFor.current = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl]);

  /**
   * meta 同步：open() 只在 sourceUrl 变化时跑一次，之后页面上**异步到达**的 meta 字段
   * （典型：在线人数 stat —— 详情接口要单独请求几百 ms~数秒后才返回）更新了 meta prop，
   * store 里的 meta 却不会被刷新，PlayerChrome 读 store → 胶囊永远不出现。
   *
   * 这正是「直播板块录播有人数、房间内直播/回放永远没有」的根因：
   *   - Media 页先以 url=''(resolving) 挂载，在线人数先取到、真实流地址后到 →
   *     sourceUrl 变化重新 open 时 meta 刚好已带 stat（时序巧合掩盖了缺陷）
   *   - 房间是解析完一次性挂载（sourceUrl 不再变）→ stat 永远赶不上 open
   * 这里把后续 meta 变化同步进 store（有变化才写，避免无谓渲染）。
   */
  const lastSyncedStatRef = useRef<string>('');
  useEffect(() => {
    if (openedFor.current !== sourceUrl) return;
    const st = usePlayerStore.getState();
    if (!st.source) return;
    const statKey = `${meta?.title || ''}|${meta?.stat?.text || ''}`;
    if (lastSyncedStatRef.current === statKey) return;
    lastSyncedStatRef.current = statKey;
    usePlayerStore.setState({ meta });
  }, [meta, sourceUrl]);

  // 跨页播放互斥：全局播放器同一时刻只播一路。本播放器打开的源被其它页面
  // 的新播放器顶替（store.url ≠ 本组件声明的源）→ 本页自动退出播放器
  //（如 Media tab 后台直播被房间点播顶掉，Media 页自动停止播放态）。
  const storeUrl = usePlayerStore((s) => s.source?.url);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /**
   * 跨页播放互斥：全局播放器同一时刻只播一路 —— 本页的源被**其它页面**的新播放器顶替时，
   * 本页自动退出播放器。
   *
   * ⚠️ 判定必须直读 store 最新值 + 用「同一会话」判据（2026-10-02 真机日志修版）：
   * 旧实现在闭包里比对渲染时的 storeUrl —— 本页**自己换源**（切画质/重新解析/换线路）那一帧，
   * 旧 storeUrl ≠ 新 sourceUrl 会被**误判成「被顶替」→ 立即 onClose() 关掉播放器**
   * （用户体感：切画质后播放器整个退出、「直播根本打不开」；反复重进还会叠成每秒重解析）。
   * 现在直读 getState：同 url / 命中本会话候选列表 / 同 liveId 任一成立即视为同一会话，不关。
   */
  useEffect(() => {
    if (!sourceUrl) return;
    if (openedFor.current !== sourceUrl) return;
    const st = usePlayerStore.getState();
    const cur = String(st.source?.url || '');
    if (!cur) return;
    const ownLive = String((source as any).liveId || (source as any).ref?.id || '');
    const curLive = String(st.source?.liveId || st.source?.ref?.id || '');
    const sameSession =
      cur === sourceUrl
      || (st.candidateUrls || []).some((u) => u === sourceUrl)
      || (!!ownLive && !!curLive && ownLive === curLive);
    if (sameSession) return;
    openedFor.current = '';
    onCloseRef.current?.();
  }, [storeUrl, sourceUrl, source]);

  /**
   * 水平手势识别（仅电台照片轮播：页面传了 swipeHandlers 才挂）。
   *
   * 关键：`onStartShouldSetPanResponder*` 恒 false —— 只有**明确水平移动**超过阈值
   * 才在捕获阶段接管，所以单击/双击/长按/控制条按钮全都保持原行为；
   * 接管后把位移与松手速度原样转发给照片翻页器（跟手 + 惯性判定都在 PhotoPager 内，
   * 与房间图片查看器同一套规则）。
   */
  const swipeResponder = useMemo(
    () => (swipeHandlers
      ? PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_e, g) => isHorizontalDrag(g.dx, g.dy),
        onMoveShouldSetPanResponderCapture: (_e, g) => isHorizontalDrag(g.dx, g.dy),
        onPanResponderGrant: () => swipeHandlers.onStart?.(),
        onPanResponderMove: (_e, g) => swipeHandlers.onMove?.(g.dx),
        onPanResponderRelease: (_e, g) => swipeHandlers.onEnd?.(g.dx, Number(g.vx) || 0),
        onPanResponderTerminate: () => swipeHandlers.onCancel?.(),
        onPanResponderTerminationRequest: () => true,
      })
      : null),
    [swipeHandlers],
  );

  const content = (
    <View
      style={[styles.container, inline && !fullscreen ? styles.inline : null]}
      {...(swipeResponder ? swipeResponder.panHandlers : {})}
    >
      {/* 画面层：旋转/镜像 transform 仅作用于视频（弹幕/控制层不转） */}
      <View style={StyleSheet.absoluteFill}>
        <View style={[StyleSheet.absoluteFill, { transform: mediaTransform }]}>
          <PlayerCore onVideoSize={onVideoSize} resumeAt={resumeAt} />
        </View>
      </View>
      {children}
      <PlayerChrome features={features} extraActions={extraActions} topLeftAction={topLeftAction} onClose={onClose} inline={inline} onRetry={onRetry} barrageInput={barrageInput} memberAction={memberAction} />
      <FullscreenManager />
    </View>
  );

  // 内嵌模式全屏：Modal 覆盖整个屏幕（保留横屏/沉浸管理）
  if (inline && fullscreen) {
    return (
      <Modal visible animationType="fade" onRequestClose={() => usePlayerStore.getState().setFullscreen(false)}>
        <View style={styles.container}>{content}</View>
      </Modal>
    );
  }
  return content;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  inline: { backgroundColor: 'transparent' },
});

export default PlayerScreen;
