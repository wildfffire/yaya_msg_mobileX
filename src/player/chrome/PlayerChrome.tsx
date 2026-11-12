import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, GestureResponderEvent, Keyboard, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { usePlayerStore } from '../store/playerStore';
import { PlayerFeatures, PlayerExtraActionOption } from '../types';
import { useI18n } from '../../i18n';
import { usePalette } from '../../theme';
import { formatPlayTime } from './FullscreenManager';
import { useSafeAreaInsets } from '../../hooks/useSafeAreaInsets';
import { enqueueDownload } from '../../services/downloads';
import { useUiStore } from '../../store';
import { errorMessage } from '../../utils/data';
import { isLandscapeSize } from '../../utils/orientation';
import { useDanmakuSettings } from '../../store/danmakuSettings';
import { useWatchLaterStore, watchLaterBucket } from '../../services/watchLater';
import TeamBadge from '../../components/TeamBadge';

interface Props {
  features?: PlayerFeatures;
  extraActions?: Array<{
    key: string;
    icon: string;
    label: string;
    active?: boolean;
    /** 选项下拉（B站画质）：带此项时点击「播放器功能」条目 → 关闭面板并从播放器右侧弹出独立小面板 */
    options?: PlayerExtraActionOption[];
    /** 带 options 时可省略（条目仅作展开/收起入口） */
    onPress?: () => void;
  }>;
  /** 顶栏左上按钮（返回键右侧、标题前）：如公告开关，收起后仍可随时点开（2026-09-26） */
  topLeftAction?: {
    icon: string;
    label: string;
    active?: boolean;
    onPress: () => void;
  };
  /** 兼容旧调用点（右侧快捷栏方案已于 2026-11-12 撤销，入口仍留在「…」面板） */
  sideActions?: Array<{
    key: string;
    icon: string;
    label: string;
    active?: boolean;
    onPress?: () => void;
  }>;
  onClose?: () => void;
  /**
   * 右上角「成员名 + 队伍」点击（进入成员房间）：不传 = 只展示不可点。
   * 用户 2026-11-04 定版：进房入口从标题挪到成员名，标题恢复为纯文本。
   */
  memberAction?: () => void;
  /** 内嵌模式：不渲染顶栏（列表页内嵌播放器），仅底坞 + 全屏 */
  inline?: boolean;
  /** 错误重试回调：页面可传「重新解析地址」而非仅重播同 URL（直播流地址有时效） */
  onRetry?: () => void;
  /** 直播弹幕输入条：渲染进底部控制坞，随控制条一起自动隐藏/呼出 */
  barrageInput?: React.ReactNode;
}

/** 控制条自动隐藏间隔 */
const CONTROLS_HIDE_MS = 3500;
/** 可用倍速档（点播/回放）：用户 2026-09-30 要求补上 3x / 4x（回放赶进度用） */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/**
 * 触控色：运行时一律用 palette.tint（用户 2026-11-09 要求弹幕开关等随主题色变化）。
 * 这个常量只留给 StyleSheet 里的静态兜底（错误重试按钮），实际渲染时再用内联色覆盖。
 * 全屏黑底上仍需要亮色：深色主题下 palette.tint 会自动提亮，浅色主题下保持种子色。
 */
const TINT = '#ff6f91';
/** 录播跳转步长（秒）：播放键两侧的圆圈箭头按钮用它 */
const SEEK_STEP_SEC = 10;
/** 双击判定窗口（毫秒）：两次点击间隔小于它算双击 */
const DOUBLE_TAP_MS = 320;
/** 长按快放的倍速（松手恢复原倍速）：用户 2026-09-30 要求从 2x 提到 4x */
const BOOST_RATE = 4;
/**
 * 直播暂停「落后 ≥ 多少秒」才给「回到直播」按钮。
 * 阈值与 PlayerCore 的 LIVE_RESUME_EDGE_MS 保持一致：低于它恢复时不会重建内核，
 * 也就没必要引导用户点（点了也只是原地继续）。
 */
const LIVE_LAG_HINT_SEC = 5;

/**
 * 暂停态「中央提示」的样式变体（用户 2026-09-30 觉得原大白圆钮太丑，要备选）。
 *
 *   glass = 玻璃胶囊（半透明深底 + 播放三角 + 「已暂停」文字）：信息最清楚，默认
 *   ring  = 细线圆环（1.5px 白描边，无填充）：最轻、几乎不挡画面
 *   bare  = 无底大三角（只有带阴影的白色三角）：极简
 *   tint  = 品牌色小圆钮（52px 粉色实心 + 白三角）：与 App 主题呼应
 *
 * 左下角的播放/暂停键**不受影响**（用户明确说那里可以不动）。
 * 变体存放在模块级变量里：本会话内用播放器「…」面板的「暂停钮样式」项循环切换即时对比，
 * 用户选定后把下面的默认值改成那个即可（届时可删掉调试项）。
 */
type CenterPlayVariant = 'glass' | 'ring' | 'bare' | 'tint';
const CENTER_PLAY_VARIANTS: CenterPlayVariant[] = ['glass', 'ring', 'bare', 'tint'];
const CENTER_PLAY_LABELS: Record<CenterPlayVariant, string> = {
  glass: 'Glass',
  ring: 'Ring',
  bare: 'Bare',
  tint: 'Tint',
};
/**
 * 默认 = glass（用户 2026-11-12 定版）。
 * 每次在「…」面板里切换都会写入 AsyncStorage，下次启动沿用上次的选择。
 */
let centerPlayVariant: CenterPlayVariant = 'glass';
const CENTER_PLAY_KEY = 'yaya_center_play_variant_v1';
const isCenterVariant = (v: unknown): v is CenterPlayVariant =>
  typeof v === 'string' && (CENTER_PLAY_VARIANTS as string[]).includes(v);

/**
 * 直播判定：kind 或流形态（rtmp/rtmps/.flv 铁定直播）。
 *
 * ⚠️ 渲染层与手势层必须同源：kind 被误标成 vod 的直播流若走了「录播语义」，
 * 双击会去暂停直播（无意义）、按钮会去 seek（拖直播流会崩原生播放器）。
 */
function sourceIsLive(src?: { kind?: string; url?: string } | null): boolean {
  if (!src) return false;
  const u = String(src.url || '').toLowerCase();
  return src.kind === 'live' || u.startsWith('rtmp://') || u.startsWith('rtmps://') || u.includes('.flv');
}

/**
 * 唯一播放器控制层（重写核心）：渐变遮罩顶栏 + 悬浮底坞（可拖进度/倍速/弹幕/全屏）+ 更多面板。
 * 所有页面共用；能力按 features 声明渲染。
 */
export function PlayerChrome({ features = {}, extraActions = [], topLeftAction, onClose, inline = false, onRetry, barrageInput, memberAction }: Props) {
  const { t } = useI18n();
  const palette = usePalette();
  const meta = usePlayerStore((s) => s.meta);
  const state = usePlayerStore((s) => s.state);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const error = usePlayerStore((s) => s.error);
  const controlsVisible = usePlayerStore((s) => s.controlsVisible);
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const source = usePlayerStore((s) => s.source);
  const useWebKernel = usePlayerStore((s) => s.useWebKernel);
  const rate = usePlayerStore((s) => s.rate);
  const rotateDeg = usePlayerStore((s) => s.rotateDeg);
  const mirrorMode = usePlayerStore((s) => s.mirrorMode);
  // 弹幕显示开关：唯一来源 = 弹幕设置（useDanmakuSettings，AsyncStorage 持久化）。
  // 与 DanmakuSettingsSheet 里的「显示弹幕」总开关是同一个值 —— 两处不会再互相打架。
  const danmakuOn = useDanmakuSettings((s) => s.enabled);
  const [moreVisible, setMoreVisible] = useState(false);
  /** 选项动作（如 B站画质）的右侧独立小面板：非 null 时从右侧弹出（用户 2026-10-02：不内嵌在功能面板里） */
  const [optionSheet, setOptionSheet] = useState<{ title: string; options: PlayerExtraActionOption[] } | null>(null);
  const [rateSheetVisible, setRateSheetVisible] = useState(false);
  const { width: screenW, height: screenH } = useWindowDimensions();
  /** 横屏专用布局开关：横屏走「顶栏压缩 + 底坞单行 + 右侧快捷栏」 */
  const isLandscape = isLandscapeSize(screenW, screenH);
  // 安全区：顶栏保留「系统通知栏」冗余（避免弹幕/标题压到状态栏），底坞避开手势导航条
  const insets = useSafeAreaInsets();
  /**
   * 软键盘高度（仅 Android 用）。
   *
   * ⚠️ 播放器页是 `position:absolute` 的全屏浮层，`adjustResize` 缩的是 Activity 根 View
   * 的高度，而这个 absolute 浮层的高度是「相对父容器」算的 —— 父容器被缩了、浮层不一定跟着缩，
   * 于是底坞的弹幕输入条会被输入法整个盖住（用户反馈「输入框不顶输入法」）。
   * 这里直接量键盘高度，把底坞顶上去，行为与窗口模式无关，最稳。
   */
  const [kbHeight, setKbHeight] = useState(0);
  /**
   * 输入法是否可见。
   * 用 ref 而不是 state：自动隐藏计时器回调里要读它，但不该因为键盘开合重建
   * `showControls`（useCallback([]) 锁首帧，改依赖会连带重建整串回调）。
   */
  const kbVisibleRef = useRef(false);
  /** showControls 的 ref（键盘收起后要重启自动隐藏计时，而 effect 定义在 showControls 之前） */
  const showControlsRef = useRef<(() => void) | null>(null);
  /** 上次单击时间戳（双击判定用）：不再区分左右 —— 双击语义已统一为「暂停/播放」 */
  const tapRef = useRef<{ t: number } | null>(null);
  /** 双击判定 / 长按抑制复位的定时器句柄：卸载时统一清理（见下方 unmount effect） */
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [seekFlash, setSeekFlash] = useState<number | null>(null);
  const seekFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 直播判定（kind 或 rtmp/rtmps/.flv 形态），**在早退之前算好**：
   * 下面「直播暂停计时」是一个 useEffect，而 hooks 绝不能放在 `if (!source) return null` 之后
   *（source 短暂为空时 hook 数变化 → "Rendered more hooks"）。
   */
  const liveSource = sourceIsLive(source);
  /**
   * 长按快放（建议 3，用户 2026-09-30 选定）：按住 350ms → 2x，松手恢复原倍速。
   * boostRef 记住「按住之前的倍速」，active 标记当前是否处于快放中。
   * 仅录播放行：直播 2x 只会让缓冲永远追不上实时。
   */
  const boostRef = useRef<{ prevRate: number; active: boolean }>({ prevRate: 1, active: false });
  /** 长按结束后**紧随其后的 onPress 必须被吞掉**（否则会顺带切控制条 / 进双击判定） */
  const suppressTapRef = useRef(false);
  const [boosting, setBoosting] = useState(false);
  /**
   * 直播暂停时长（秒）：直播暂停期间**服务器时间照走**，所以「落后多少秒」≈ 暂停了多久。
   * PlayerCore 会在恢复时把落后超过 5s 的直播重建内核拉回实时，这里只是让用户看得见。
   */
  const [livePausedSec, setLivePausedSec] = useState(0);
  /** 暂停态中央提示的样式变体（见顶部 CENTER_PLAY_VARIANTS 注释）：可在「…」面板里循环切换，选择会持久化 */
  const [centerVariant, setCenterVariant] = useState<CenterPlayVariant>(centerPlayVariant);
  useEffect(() => {
    AsyncStorage.getItem(CENTER_PLAY_KEY)
      .then((saved) => {
        if (!isCenterVariant(saved)) return;
        centerPlayVariant = saved;
        setCenterVariant(saved);
      })
      .catch(() => undefined);
  }, []);
  /**
   * 「稍后再看」内置动作的状态（用户 2026-09-30：入口从列表行书签挪到播放器的功能面板）。
   *
   * 只对**能事后重新解析地址**的内容开放 —— 也就是带 `source.ref` 的（官方视频库 / 公演回放 /
   * 房间直播回放）。直播没有 ref（地址当场有效、过期作废），所以面板里不显示这个动作，
   * 避免「加了却播不了」。收藏内容由 store 统一管理（见 services/watchLater.ts）。
   */
  const watchLaterRef = source?.ref && source.ref.id ? source.ref : undefined;
  const inWatchLater = useWatchLaterStore((s) =>
    /**
     * 用「同一场内容」桶判定，而不是精确 key（用户 2026-09-30：「同一个直播多次记录」）：
     * openlive / replay 的 id 都是 liveId → 从任一入口收藏过，另一个入口进来也该显示"已收藏"。
     */
    !!watchLaterRef && s.items.some((it) => watchLaterBucket(it.kind, it.id) === watchLaterBucket(watchLaterRef.kind, watchLaterRef.id)),
  );
  useEffect(() => {
    if (!liveSource || state !== 'paused') {
      setLivePausedSec(0);
      return undefined;
    }
    const startedAt = Date.now();
    setLivePausedSec(0);
    const timer = setInterval(() => {
      setLivePausedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [liveSource, state]);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 控制条淡入淡出
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(controlsOpacity, {
      toValue: controlsVisible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [controlsVisible, controlsOpacity]);
  // 进度条拖动：比例 → seek（录播定位；进度条触控区加高避免误触）
  const progTrackRef = useRef<View>(null);
  const progW = useRef(0);
  const progX = useRef(0);
  const dragRatioRef = useRef<number | null>(null);
  /** 正在拖进度条：禁止控制条自动隐藏（防 hide 卸载 responder 目标触发闪退） */
  const dragLockRef = useRef(false);
  // 拖动中本地预览比例（UI 显示用）；松手才写 store/seek 一次——避免每帧 setPosition
  // 高频触发全局订阅组件渲染风暴（实测拖动导致 ANR/闪退、日志来不及落盘）
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  // ⚠️ 拖进度条闪退防护：手势回调任何同步异常都 try/catch 吞掉（冒到 mqt_native_modules 线程 =
  // JS 致命异常直接闪退且无日志）；拖动期间禁止控制条自动隐藏（3s 定时器若在拖动中 hide，
  // responder 目标被卸载 → RN 触控分发内部抛 undefined → 同款闪退）。
  // ⚠️ 关键：PanResponder 由 useRef 只创建一次，闭包锁死「首次渲染作用域」的绑定；
  // 而 seekTo/onProgDown/onProgUp 在 `if (!source) return null`（更早）之后才声明——
  // 若首次渲染 source 为空，它们在该作用域永远处于 TDZ，之后每次触碰都抛
  // "undefined is not a function"（曾导致拖进度条闪退）。解法：回调只经 ref 间接调用，
  // ref 在每次渲染（有 source 时）重新指向当前函数。
  const progCtl = useRef<{ down: (x: number) => void; move: (x: number) => void; up: () => void }>({
    down: () => {},
    move: () => {},
    up: () => {},
  });
  const progPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        try {
          dragLockRef.current = true;
          progCtl.current.down(e.nativeEvent.pageX);
        } catch (err) {
          console.warn('[PlayerChrome] prog grant err', err);
        }
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        try { progCtl.current.move(e.nativeEvent.pageX); } catch (err) { console.warn('[PlayerChrome] prog move err', err); }
      },
      onPanResponderRelease: () => {
        try { dragLockRef.current = false; progCtl.current.up(); } catch (err) { console.warn('[PlayerChrome] prog up err', err); }
      },
      onPanResponderTerminate: () => {
        try { dragLockRef.current = false; progCtl.current.up(); } catch (err) { console.warn('[PlayerChrome] prog terminate err', err); }
      },
    }),
  ).current;

  const showControls = useCallback(() => {
    usePlayerStore.getState().toggleControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // 打字中（输入法可见）绝不自动隐藏：底坞里的弹幕输入条会被一起淡走，
      // 用户正在输入却看不到输入框与已输入内容（需求明确要求「有输入法时不自动隐藏」）
      if (kbVisibleRef.current) {
        showControls();
        return;
      }
      // 播放中才自动隐藏（全屏同样隐藏）；暂停/缓冲保持显示（用户在操作/看画面）
      // 拖动中绝不离场：hide 会把正在被触摸的 responder 视图卸载 → 原生触控分发崩
      if (dragLockRef.current) {
        showControls();
        return;
      }
      const s = usePlayerStore.getState();
      if (s.state === 'playing') s.toggleControls(false);
    }, CONTROLS_HIDE_MS);
  }, []);
  showControlsRef.current = showControls;

  /**
   * 输入法开合 → 控制条显隐。
   *  - 弹出：取消待执行的自动隐藏并保持控制条可见（否则刚点输入框，输入条就淡走了）
   *  - 收起：重启一次自动隐藏计时，恢复「播放中 3s 后隐藏」的既有行为
   */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      kbVisibleRef.current = true;
      setKbHeight(Number(e?.endCoordinates?.height) || 0);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      usePlayerStore.getState().toggleControls(true);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      kbVisibleRef.current = false;
      setKbHeight(0);
      showControlsRef.current?.();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    showControls();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [showControls, source?.url]);

  /**
   * 屏幕点按分流（用户 2026-09-30 定版）：
   *  - 双击 = 暂停 / 继续，**直播与录播一视同仁**（用户后续明确要求「所有直播也要」）
   *  - 单击 = 唤出/隐藏控制条（延迟 DOUBLE_TAP_MS 等双击判定）
   *
   * 历史：最初双击是「左侧 -10s / 右侧 +10s」，按用户要求已移除 ——
   * 那对操作挪到了播放键两侧的圆圈箭头按钮（seekBy），双击让位给暂停/继续。
   * 好处：画面任意处双击都能暂停，不必去够底部那排按钮。
   *
   * 直播暂停由各内核真实执行（不是仅改 UI 状态）：
   *  - Exo(LiveExoView)：paused → 原生 playWhenReady=false；
   *  - RNV(native)：paused prop；
   *  - Web(flv.js/hls.js)：PlayerCore 经 postMessage 下发 setPaused。
   * 恢复直播时 PlayerCore 会把长时间暂停的直播拉回实时边缘（见其「回到直播边缘」注释）。
   */
  const onVideoTap = useCallback(() => {
    /**
     * 单击语义 = 切换沉浸。
     * 以前只做「唤出控制条」，想进沉浸只能干等 CONTROLS_HIDE_MS(3.5s) 自动隐藏
     *（用户反馈「直播中点一下屏幕要进入沉浸状态，现在只有放置一段时间自动进入」）。
     * 现在：控制条可见 → 立刻收起（进沉浸）；已隐藏 → 唤出。
     */
    const flipControls = () => {
      const st = usePlayerStore.getState();
      if (st.controlsVisible) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        st.toggleControls(false);
      } else {
        showControls();
      }
    };
    const now = Date.now();
    const prev = tapRef.current;
    if (prev && now - prev.t < DOUBLE_TAP_MS) {
      tapRef.current = null; // 置空即可让上一次单击的延时回调自动失效（无需额外计时器）
      const st = usePlayerStore.getState();
      // 只在实际可播状态切换（loading/error 期间切态会让内核收到矛盾指令）；
      // 直播与录播走同一分支 —— 直播暂停＝停住画面，继续＝恢复（长时间暂停会被拉回实时）
      if (st.state === 'playing') st.setState('paused');
      else if (st.state === 'paused') st.setState('playing');
      return;
    }
    tapRef.current = { t: now };
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = null;
      if (tapRef.current && tapRef.current.t === now) {
        tapRef.current = null;
        flipControls();
      }
    }, DOUBLE_TAP_MS);
  }, [showControls]);

  /**
   * 卸载时清掉所有「延迟回调」定时器（用户 2026-09-30：「直播退出所有界面都出现卡顿」的普查要求）。
   * 双击判定 / 长按抑制复位 / ±10s 闪示 这三处 setTimeout 以前都没有卸载清理 ——
   * 退出播放器后仍会 fire（写 store / setState），属于"退出后还在动"的残留。
   */
  useEffect(() => () => {
    if (tapTimerRef.current) { clearTimeout(tapTimerRef.current); tapTimerRef.current = null; }
    if (pressResetTimerRef.current) { clearTimeout(pressResetTimerRef.current); pressResetTimerRef.current = null; }
    if (seekFlashTimer.current) { clearTimeout(seekFlashTimer.current); seekFlashTimer.current = null; }
  }, []);

  // 播放器内下载（替代长按）：点播/回放/音频可下载；HLS 分段与直播不提供
  // ⚠️ hooks 必须在 line `if (!source) return null`（更下方）之前：source 短暂为空时
  // 早退会导致 hook 数变化 → "Rendered more hooks"（直播首帧/换源实测触发）
  const showToast = useUiStore((s) => s.showToast);
  const runDownload = useCallback(async () => {
    const s = usePlayerStore.getState();
    const u = String(s.source?.url || '');
    if (!u || /\.m3u8/i.test(u)) {
      showToast(t('该流暂不支持直接下载'));
      return;
    }
    try {
      await enqueueDownload({ url: u, type: 'replay', name: String(s.meta?.title || '视频') });
      showToast(t('已加入下载队列'));
    } catch (e: any) {
      showToast(t('下载失败：{msg}', { msg: errorMessage(e) }));
    }
    showControls();
  }, [showToast, t, showControls]);
  // 「更多」面板动作 = 页面传入 extraActions + 点播下载（放首位）；source 可能为空 → 短路保护
  const downloadAvailable = !!source
    && source.kind !== 'live'
    && !/^rtmps?:/i.test(String(source.url || ''))
    && /^https?:/i.test(source.url)
    && !/\.m3u8/i.test(source.url);
  /**
   * 功能面板条目：点播追加「下载」；**小窗不再进面板**（用户 2026-11-12：
   * 控制坞已有直达按钮，面板里那条重复且不常用）。控制坞的 pip 仍由 extraActions 提供。
   */
  const moreActions = useMemo(() => {
    const base = downloadAvailable
      ? [{ key: 'download', icon: 'download', label: t('下载'), onPress: runDownload }, ...extraActions]
      : extraActions;
    return base.filter((action) => action.key !== 'pip');
  }, [downloadAvailable, extraActions, runDownload, t]);

  if (!source) return null;

  const playing = state === 'playing';
  // 直播判定：kind 或流形态（rtmp/rtmps/.flv 铁定直播）—— 见顶部 sourceIsLive。
  // 防止 kind 误标成 vod 时直播出现可拖进度条（拖动 seek 直播流 → RNV 原生异常闪退）、
  // 出现 ±10s 圆圈箭头与「双击暂停」。渲染层与手势层共用同一函数，避免判定漂移。
  // 值来自早退之前算好的 liveSource（供 hooks 复用，见那里的注释）。
  const isLive = liveSource;
  // 卡片内嵌态（inline 且未全屏）：不叠任何控制坞，点击即进全屏
  const cardMode = inline && !fullscreen;
  /**
   * 长按快放：按住 → 2x；松手 / 手指移出 → 恢复原倍速。
   * 仅录播 + 正在播放时生效（暂停中快放没有意义；卡片态的长按留给拖拽排序语义，不抢）。
   */
  const startBoost = () => {
    if (isLive || cardMode || inline) return;
    const st = usePlayerStore.getState();
    if (st.state !== 'playing' || boostRef.current.active) return;
    boostRef.current = { prevRate: st.rate > 0 ? st.rate : 1, active: true };
    st.setRate(BOOST_RATE);
    setBoosting(true);
  };
  const endBoost = () => {
    if (!boostRef.current.active) return;
    boostRef.current.active = false;
    setBoosting(false);
    // 吞掉紧随其后的 onPress（长按松手 RN 也会派发 onPress）；400ms 后自动复位防残留
    suppressTapRef.current = true;
    if (pressResetTimerRef.current) clearTimeout(pressResetTimerRef.current);
    pressResetTimerRef.current = setTimeout(() => {
      pressResetTimerRef.current = null;
      suppressTapRef.current = false;
    }, 400);
    usePlayerStore.getState().setRate(boostRef.current.prevRate);
  };
  const progRatio = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
  // 拖动中显示本地预览比例与目标时间（跟手），不依赖高频 store 写入
  const shownRatio = dragRatio != null ? dragRatio : progRatio;
  const shownPos = dragRatio != null && duration > 0 ? dragRatio * duration : position;

  const togglePlay = () => {
    const s = usePlayerStore.getState();
    if (s.state === 'playing') s.setState('paused');
    else if (s.state === 'paused' || s.state === 'error') s.setState('playing');
    showControls();
  };

  const toggleFullscreen = () => {
    usePlayerStore.getState().setFullscreen(!fullscreen);
    showControls();
  };

  const pickRate = (r: number) => {
    usePlayerStore.getState().setRate(r);
    setRateSheetVisible(false);
    showControls();
  };

  const toggleDanmaku = () => {
    // 写持久化的弹幕总开关（与设置面板同一来源；原先写 playerStore.danmakuOn 会被 open() 重置）
    const s = useDanmakuSettings.getState();
    s.set({ enabled: !s.enabled });
    showControls();
  };

  const seekTo = (t: number) => {
    if (isLive) return;
    const s = usePlayerStore.getState();
    s.setPosition(t);
    // seek 指令交给 PlayerCore（内核消费后清零）
    s.setSeekTarget(t);
    showControls();
  };

  /**
   * 录播跳转 ±SEEK_STEP_SEC（播放键两侧的圆圈箭头，用户 2026-09-30 要求）。
   * 原先是「双击屏幕左侧 -10s / 右侧 +10s」，已移除 —— 双击改作暂停/播放，
   * 跳转收进控制坞按钮，既能精确点按又不会在拖动画面时误触。
   * 与 seekTo 一样：直接走 store，不依赖闭包（本函数在早退之后定义，闭包锁首帧会 TDZ）。
   */
  const seekBy = (delta: number) => {
    if (isLive) return;
    const s = usePlayerStore.getState();
    if (!(s.duration > 0) || (s.state !== 'playing' && s.state !== 'paused')) return;
    const target = Math.max(0, Math.min(s.duration - 0.3, s.position + delta));
    s.setPosition(target);
    s.setSeekTarget(target);
    // 画面中央闪一下 ±10s（原生播放器 seek 有肉眼可见的滞后，需要即时反馈）
    setSeekFlash(delta);
    if (seekFlashTimer.current) clearTimeout(seekFlashTimer.current);
    seekFlashTimer.current = setTimeout(() => setSeekFlash(null), 900);
    showControls(); // 正在操作：重置自动隐藏计时，别刚点完就把控制坞淡走
  };

  const ratioFromX = (pageX: number): number | null => {
    if (!progW.current || progW.current < 2) return null;
    return Math.max(0, Math.min(1, (pageX - progX.current) / progW.current));
  };
  const onProgDown = (pageX: number) => {
    const st = usePlayerStore.getState();
    if (st.source?.kind === 'live' || st.duration <= 0) return;
    if (st.state !== 'playing' && st.state !== 'paused') return; // loading/error 阶段不可拖（防 seek 未就绪原生崩）
    const r = ratioFromX(pageX);
    if (r == null) return;
    dragRatioRef.current = r;
    setDragRatio(r); // 本地预览（不写 store）
  };
  const onProgMove = (pageX: number) => {
    if (dragRatioRef.current == null) return;
    const r = ratioFromX(pageX);
    if (r == null) return;
    dragRatioRef.current = r;
    setDragRatio(r); // 本地预览
  };
  const onProgUp = () => {
    const r = dragRatioRef.current;
    dragRatioRef.current = null;
    setDragRatio(null);
    if (r != null) {
      const st = usePlayerStore.getState();
      if (st.duration > 0 && (st.state === 'playing' || st.state === 'paused')) seekTo(r * st.duration); // 松手一次写入
    }
  };
  // 让 PanResponder 经 ref 拿到本次渲染的最新实现（须在定义之后、早退之前赋值）
  progCtl.current = { down: onProgDown, move: onProgMove, up: onProgUp };

  /* ==================== 横屏专用布局派生值 ==================== */
  /**
   * 左右安全边：横屏时挖孔/三键导航条会挪到侧边（竖屏它在底部），
   * 顶栏 / 底坞统一按 `insets.left` 内缩。竖屏 `insets.left = 0` → 仍是原来的 16。
   */
  const hPad = isLandscape ? Math.max(insets.left, 16) : 16;
  /**
   * 顶栏顶部留白：横屏全屏是沉浸态（状态栏已隐藏）→ 只需 8；
   * 非沉浸（页面级播放器直接旋转到横屏）仍要避让状态栏，否则返回钮会压进通知栏。
   */
  const topPad = isLandscape ? (fullscreen ? 8 : insets.top + 6) : insets.top + 6;
  /** 底部渐变压暗层高度：横屏窗口矮，竖屏的 200 会糊掉大半个画面 */
  const shadeH = isLandscape ? 120 : 200;

  /**
   * 进度行：竖屏独占一行（底坞第一行）；横屏内联进控制行中段。
   * 抽成变量避免两套布局各写一遍（也避免同时挂载两个 `progTrackRef`）。
   */
  const progressRow = !isLive ? (
    <View style={styles.progressRow}>
      <Text style={styles.timeText}>{formatPlayTime(shownPos)}</Text>
      <View
        ref={progTrackRef}
        style={styles.progressTouch}
        onLayout={(e) => {
          progW.current = e.nativeEvent.layout.width;
          progTrackRef.current?.measureInWindow?.((x) => { progX.current = x; });
        }}
        {...progPan.panHandlers}
      >
        <View style={styles.progressTrackBg}>
          <View style={[styles.progressFill, { width: `${shownRatio * 100}%` }]} />
        </View>
        <View style={[styles.progressThumb, { left: `${shownRatio * 100}%` }]} />
      </View>
      <Text style={styles.timeText}>{formatPlayTime(duration)}</Text>
    </View>
  ) : null;

  /** 控制行右侧功能组（竖屏/横屏共用）：倍速 / 弹幕开关 / 小窗 / 全屏 */
  const rightControls = (
    <>
      {features.rate && !isLive && !useWebKernel ? (
        <TouchableOpacity style={styles.ctrlBtn} onPress={() => setRateSheetVisible(true)} activeOpacity={0.75}>
          <Text style={[styles.rateText, rate !== 1 && { color: palette.tint }]}>{rate}x</Text>
        </TouchableOpacity>
      ) : null}
      {features.danmaku && !useWebKernel ? (
        <TouchableOpacity style={styles.ctrlBtn} onPress={toggleDanmaku} activeOpacity={0.75}>
          <MaterialCommunityIcons
            name={danmakuOn ? 'comment-text-multiple' : 'comment-text-multiple-outline'}
            size={20}
            color={danmakuOn ? palette.tint : 'rgba(255,255,255,0.9)'}
          />
        </TouchableOpacity>
      ) : null}
      {/* 「小窗」按钮直接放 dock（用户反馈「小窗在软件内点没用」真因之一：原 extraActions
          藏在右上「...」二级菜单，用户找不到）。从 extraActions 提 pip 渲染到 dock 直达。 */}
      {(() => {
        const pipAction = extraActions.find((a) => a.key === 'pip');
        if (!pipAction) return null;
        return (
          <TouchableOpacity
            style={styles.ctrlBtn}
            onPress={() => { pipAction.onPress?.(); showControls(); }}
            activeOpacity={0.75}
          >
            <MaterialCommunityIcons name="picture-in-picture-bottom-right-outline" size={20} color="rgba(255,255,255,0.92)" />
          </TouchableOpacity>
        );
      })()}
      {!inline || fullscreen ? (
        <TouchableOpacity style={styles.ctrlBtn} onPress={toggleFullscreen} activeOpacity={0.75}>
          <MaterialCommunityIcons name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={21} color="rgba(255,255,255,0.92)" />
        </TouchableOpacity>
      ) : null}
    </>
  );

  return (
    <>
      {/* 顶栏：常规/卡片全屏均显示（卡片全屏必须有返回钮，否则无法退出） */}
      {!inline || fullscreen ? (
        <Animated.View
          style={[
            styles.topWrap,
            { opacity: controlsOpacity, paddingTop: topPad },
            isLandscape ? styles.topWrapLandscape : null,
            isLandscape ? { paddingHorizontal: hPad } : null,
          ]}
          pointerEvents={controlsVisible ? 'auto' : 'none'}
        >
          <LinearGradient colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0)']} style={StyleSheet.absoluteFill} />
          <TouchableOpacity
            style={[styles.topBtn, isLandscape ? styles.topBtnLandscape : null]}
            onPress={() => {
              // 卡片全屏：返回 = 退出全屏回卡片；页面播放器：返回 = 关闭（onClose）
              if (inline && fullscreen) usePlayerStore.getState().setFullscreen(false);
              else if (onClose) onClose();
              else usePlayerStore.getState().close();
            }}
          >
            <MaterialCommunityIcons name={inline ? 'chevron-down' : 'chevron-down'} size={isLandscape ? 21 : 24} color="#fff" />
          </TouchableOpacity>
          {/* 顶栏左上按钮（如公告开关）：公告收起后仍可随时从这里点开（用户反馈「关闭后看不到」） */}
          {topLeftAction ? (
            <TouchableOpacity
              style={[styles.topBtn, isLandscape ? styles.topBtnLandscape : null]}
              accessibilityLabel={topLeftAction.label}
              onPress={topLeftAction.onPress}
            >
              <MaterialCommunityIcons
                name={topLeftAction.icon as any}
                size={21}
                color={topLeftAction.active ? palette.tint : '#fff'}
              />
            </TouchableOpacity>
          ) : null}
          <View style={styles.titleWrap}>
            <Text style={styles.titleText} numberOfLines={1}>{meta.title}</Text>
            {/* 小指标胶囊：直播=聊天室实时在线；拿不到 / 录播=本场累计观看人次（见 PlayerMeta.stat） */}
            {meta.stat ? (
              <View style={styles.onlinePill}>
                <MaterialCommunityIcons name={meta.stat.icon as any} size={11} color="rgba(255,255,255,0.92)" />
                <Text style={styles.onlineText} numberOfLines={1}>{meta.stat.text}</Text>
              </View>
            ) : null}
          </View>
          {/**
           * 右上角「队伍徽章 + 成员名」（用户 2026-11-04）：
           * 显示口径与直播列表卡片一致（TeamBadge 在前、成员名在后）；
           * 点击进入该成员的房间（直播页 / 历史 / 稍后再看统一）。
           * 房间内播放（roomLink=false）仍展示，但不可点。
           */}
          {meta.owner || meta.team ? (
            <TouchableOpacity
              style={styles.memberChip}
              onPress={memberAction}
              disabled={!memberAction}
              activeOpacity={0.75}
            >
              {meta.team ? <TeamBadge team={meta.team} fontSize={9} /> : null}
              {meta.owner ? (
                <Text style={styles.memberName} numberOfLines={1}>{meta.owner}</Text>
              ) : null}
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={[styles.topBtn, isLandscape ? styles.topBtnLandscape : null]} onPress={() => setMoreVisible(true)}>
            <MaterialCommunityIcons name="dots-horizontal" size={22} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      ) : null}

      {/* 说明（用户 2026-11-12 澄清）：礼物 / 贡献榜的**入口仍留在右上「…」面板**，
          要改的是它们点开后那个面板的观感（黑白 + 简洁），不是把入口搬走。
          右侧竖向快捷栏方案已撤销。 */}

      {/* 错误浮层 */}
      {error ? (
        <View style={styles.errorWrap} pointerEvents="box-none">
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity
            style={[styles.errorBtn, { backgroundColor: palette.tint }]}
            onPress={() => {
              // 有 onRetry（页面重新解析）优先；否则仅重播同 URL
              if (onRetry) onRetry();
              else usePlayerStore.getState().clearError();
              showControls();
            }}
          >
            <Text style={styles.errorBtnText}>{t('重试')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/**
       * 缓冲/加载中：中央转圈。
       *
       * ⚠️ 直播不显示（`!isLive`）：用户在直播开播那一刻要的是"直接出画面"，
       * 大号白转圈闪一下非常割裂。与 2026-09-26 已确定的「解析直播流期间纯黑占位、
       * 不闪加载圈」保持同一观感 —— 直播加载中就是黑屏，出画面即播放。
       * 录播保留转圈（时长较长、黑屏会让用户以为卡死）。
       */}
      {state === 'loading' && !error && !isLive ? (
        <LoadingHint />
      ) : null}

      {/* 暂停态：中央播放钮 —— **纯视觉提示，不可点**（用户 2026-09-30 明确要求「双击恢复」）。
          为什么不能点：它盖在画面正中，自己是可点按钮时，用户双击中央想恢复，
          第一下就被它吃掉变成「单击恢复」，观感正好与需求相反。
          现在触摸穿透到下面的点按层：单击 = 控制条显隐、双击 = 暂停/继续
          （底部播放键仍然可以单击直接恢复，两套入口都保留）。
          录播：非 playing/loading（含播完停在结尾）都显示；
          直播：只在显式暂停时显示（idle/loading 不是「暂停」，给个提示钮只会让人以为卡住）。 */}
      {!error && (isLive ? state === 'paused' : (state !== 'playing' && state !== 'loading')) ? (
        <View style={styles.centerPlayWrap} pointerEvents="none">
          {(() => {
            // 音频源（语音卡/电台）整体小一号：这些形态下列表里没有画面，大提示会盖住文字
            const small = source.kind === 'audio' || !!source.audioOnly;
            if (centerVariant === 'ring') {
              return (
                <View style={[styles.centerPlayRing, small ? styles.centerPlayRingSm : null]}>
                  <MaterialCommunityIcons name="play" size={small ? 22 : 34} color="rgba(255,255,255,0.96)" style={{ marginLeft: small ? 3 : 5 }} />
                </View>
              );
            }
            if (centerVariant === 'bare') {
              return (
                <MaterialCommunityIcons
                  name="play"
                  size={small ? 34 : 62}
                  color="rgba(255,255,255,0.94)"
                  style={[{ marginLeft: small ? 3 : 6 }, styles.centerPlayBareShadow]}
                />
              );
            }
            if (centerVariant === 'tint') {
              return (
                <View style={[styles.centerPlayTint, small ? styles.centerPlayTintSm : null, { backgroundColor: palette.tint }]}>
                  <MaterialCommunityIcons name="play" size={small ? 18 : 24} color="#fff" style={{ marginLeft: 3 }} />
                </View>
              );
            }
            return (
              <View style={[styles.centerPlayGlass, small ? styles.centerPlayGlassSm : null]}>
                <MaterialCommunityIcons name="play" size={small ? 16 : 20} color="#fff" style={{ marginLeft: 2 }} />
                <Text style={[styles.centerPlayGlassText, small ? styles.centerPlayGlassTextSm : null]}>{t('已暂停')}</Text>
              </View>
            );
          })()}
        </View>
      ) : null}

      {/* 长按快放提示（建议 3）：中央偏上，避免压住中央播放钮与底坞 */}
      {boosting ? (
        <View style={styles.boostHint} pointerEvents="none">
          <MaterialCommunityIcons name="fast-forward" size={16} color="#fff" />
          <Text style={styles.boostHintText}>{`${BOOST_RATE}x`}</Text>
        </View>
      ) : null}

      {/* 直播暂停提示（建议 4）：直播暂停期间服务器时间照走，明确告诉用户「落后了多少」；
          落后 ≥ LIVE_LAG_HINT_SEC 时给「回到直播」——点击即恢复，PlayerCore 会重建内核拉回实时。
          卡片态不渲染（那里没有控制坞，长按/双击语义都不同）。 */}
      {isLive && !cardMode && !error && state === 'paused' ? (
        <View style={styles.livePauseWrap} pointerEvents="box-none">
          <Text style={styles.livePauseText}>{t('已暂停 · 落后 {sec} 秒', { sec: livePausedSec })}</Text>
          {livePausedSec >= LIVE_LAG_HINT_SEC ? (
            <Pressable
              style={[styles.livePauseBtn, { backgroundColor: palette.tint }]}
              onPress={() => {
                usePlayerStore.getState().setState('playing');
                showControls();
              }}
            >
              <MaterialCommunityIcons name="broadcast" size={13} color="#fff" />
              <Text style={styles.livePauseBtnText}>{t('回到直播')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* ±10s 跳转反馈：由播放键两侧的圆圈箭头按钮触发（实时显示 seek 后的秒数） */}
      {seekFlash != null ? (
        <View style={styles.seekFlashWrap} pointerEvents="none">
          <MaterialCommunityIcons name={seekFlash > 0 ? 'fast-forward' : 'rewind'} size={22} color="#fff" />
          <Text style={styles.seekFlashText}>{seekFlash > 0 ? `+${seekFlash}s` : `${seekFlash}s`}</Text>
        </View>
      ) : null}

      {/* 底部控制坞：底部渐变压暗层 + 两行（进度行 / 控制行）。
          唤出层始终可点（控制条隐藏后点屏幕任意处唤出）；渐变/坞内容按 controlsVisible 显隐 */}
      {/* 屏幕点按层：双击 = 暂停/播放，单击 = 控制条显隐（分流见 onVideoTap），
          长按 = 2x 快放（录播，松手恢复，见 startBoost/endBoost）。
          inline 卡片态：点击直接进全屏（卡片不叠控制坞） */}
      <Pressable
        style={StyleSheet.absoluteFill}
        delayLongPress={350}
        onLongPress={startBoost}
        onPressOut={endBoost}
        onPress={() => {
          // 长按快放刚结束：这次 onPress 是长按的尾巴，吞掉（否则会顺带切控制条/计入双击）
          if (suppressTapRef.current) { suppressTapRef.current = false; return; }
          if (inline && !fullscreen) {
            // 音频/纯音频源：无画面可全屏——点击即播放/暂停（音频条语义）
            if (source.kind === 'audio' || source.audioOnly) {
              togglePlay();
              return;
            }
            // 视频卡片：点击直接进全屏（卡片态干净无控制坞）
            usePlayerStore.getState().setFullscreen(true);
            return;
          }
          if (inline) { showControls(); return; }
          onVideoTap();
        }}
      />
      {!cardMode ? (
      <View style={StyleSheet.absoluteFill} pointerEvents={controlsVisible ? 'box-none' : 'none'}>
        <Animated.View pointerEvents="none" style={{ opacity: controlsOpacity }}>
          <LinearGradient
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.68)']}
            style={[styles.bottomShade, isLandscape ? { height: shadeH } : null]}
          />
        </Animated.View>
        {/* 底坞：竖屏 = 三行（进度行 / 弹幕输入条 / 控制行）；横屏 = 单行
            （左：播放钮 / 中：录播进度条 或 直播弹幕输入条 / 右：功能组） */}
        <Animated.View
          style={[
            styles.dockWrap,
            {
              opacity: controlsOpacity,
              // 竖屏：底坞要避开底部手势导航条（insets.bottom≈48）。
              // 横屏：导航条已挪到侧边（由 hPad 处理），底部只需一点呼吸空间 ——
              // 再按 48 算会在 400dp 高的横屏窗口里白吃掉 1/8 高度。
              paddingBottom: (isLandscape ? 12 : Math.max(insets.bottom, 12)) + 4 + kbHeight,
            },
            isLandscape ? { paddingHorizontal: hPad } : null,
          ]}
          pointerEvents="box-none"
        >
          {/* 竖屏：进度行独占一行（横屏它内联在下面的控制行中段） */}
          {!isLandscape ? progressRow : null}
          {/* 竖屏：直播弹幕输入条叠在控制行之上（横屏它占据控制行中段） */}
          {!isLandscape && barrageInput ? <View style={styles.dockBarrageRow}>{barrageInput}</View> : null}
          {/* 控制行：录播「-10s」圆圈箭头 + 播放/暂停（主按钮）+ 录播「+10s」圆圈箭头 + 中间区 + 右侧功能 */}
          <View style={styles.ctrlRow}>
            {/* 录播跳转键：原「双击屏幕左侧 -10s / 右侧 +10s」的替身，按用户要求（2026-09-30）
                挪到播放键两侧。直播不渲染 —— 直播没有时间轴可跳，误按只会白闪一下。 */}
            {!isLive ? (
              <TouchableOpacity
                style={[styles.seekBtn, isLandscape ? styles.seekBtnLandscape : null]}
                onPress={() => seekBy(-SEEK_STEP_SEC)}
                activeOpacity={0.75}
              >
                <MaterialCommunityIcons name="rewind-10" size={isLandscape ? 19 : 21} color="rgba(255,255,255,0.95)" />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.playBtn, isLandscape ? styles.playBtnLandscape : null]}
              onPress={togglePlay}
              activeOpacity={0.85}
            >
              <MaterialCommunityIcons name={playing ? 'pause' : 'play'} size={isLandscape ? 22 : 24} color="#16181c" style={!playing ? { marginLeft: 3 } : undefined} />
            </TouchableOpacity>
            {!isLive ? (
              <TouchableOpacity
                style={[styles.seekBtn, isLandscape ? styles.seekBtnLandscape : null]}
                onPress={() => seekBy(SEEK_STEP_SEC)}
                activeOpacity={0.75}
              >
                <MaterialCommunityIcons name="fast-forward-10" size={isLandscape ? 19 : 21} color="rgba(255,255,255,0.95)" />
              </TouchableOpacity>
            ) : null}
            {isLandscape ? (
              <View style={styles.dockCenterLandscape}>
                {barrageInput ? barrageInput : progressRow}
              </View>
            ) : (
              <>
                <Text style={styles.ctrlHintText} numberOfLines={1}>
                  {source.audioOnly ? t('纯音频') : ''}
                </Text>
                <View style={{ flex: 1 }} />
              </>
            )}
            {rightControls}
          </View>
        </Animated.View>
      </View>
      ) : null}

      {/* 倍速抽屉（点播/回放） */}
      {/* 播放速度：右下角下拉菜单（用户 2026-11-12：不要整屏弹出界面） */}
      {rateSheetVisible ? (
        <>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setRateSheetVisible(false)} />
          <View style={[styles.rateDropdown, isLandscape ? styles.rateDropdownLandscape : null]}>
            {RATES.map((r) => {
              const on = rate === r;
              return (
                <TouchableOpacity
                  key={r}
                  style={[styles.rateOption, on && styles.rateOptionOn]}
                  onPress={() => {
                    pickRate(r);
                    setRateSheetVisible(false);
                  }}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={`${r}x`}
                >
                  <Text style={[styles.rateOptionText, on && styles.rateOptionTextOn]}>{r}x</Text>
                  {on ? <MaterialCommunityIcons name="check" size={13} color="#FFFFFF" /> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      ) : null}

      {/* 更多面板 */}
      <Modal visible={moreVisible} transparent animationType="slide" onRequestClose={() => setMoreVisible(false)}>
        {/* 暗幕区 = 点击关闭（用户 2026-10-02：点外部区域能关掉面板） */}
        <Pressable
          style={[styles.modalShade, isLandscape && styles.modalShadeLandscape]}
          onPress={() => setMoreVisible(false)}
        >
          {/* 面板自身接管触摸起点：面板内空白处点击不会冒泡到暗幕（只有点在面板外才关闭） */}
          <View
            style={[
              styles.morePanel,
              isLandscape ? styles.morePanelLandscape : styles.sheetLandscape,
              { backgroundColor: palette.surface },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.moreHeader}>
              <Text style={[styles.moreTitle, { color: palette.label }]}>{t('播放器功能')}</Text>
              <TouchableOpacity onPress={() => setMoreVisible(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialCommunityIcons name="close" size={20} color={palette.labelSecondary} />
              </TouchableOpacity>
            </View>
            <View style={styles.moreGrid}>
              {/* 画面旋转/镜像（桌面 DPlayer 对齐） */}
              <TouchableOpacity
                style={[styles.moreItem, isLandscape && styles.moreItemRow]}
                onPress={() => {
                  const st = usePlayerStore.getState();
                  st.setRotateDeg((st.rotateDeg + 90) % 360);
                  setMoreVisible(false);
                  showControls();
                }}
              >
                <MaterialCommunityIcons name="sync" size={22} color={palette.labelSecondary} />
                <Text style={[styles.moreLabel, isLandscape && styles.moreLabelRow, { color: palette.labelSecondary }]}>
                  {rotateDeg ? t('旋转 {deg}°', { deg: rotateDeg }) : t('旋转')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.moreItem, isLandscape && styles.moreItemRow]}
                onPress={() => {
                  const st = usePlayerStore.getState();
                  const next = st.mirrorMode === 'none' ? 'horizontal' : st.mirrorMode === 'horizontal' ? 'vertical' : 'none';
                  st.setMirrorMode(next);
                  setMoreVisible(false);
                  showControls();
                }}
              >
                <MaterialCommunityIcons name="flip-horizontal" size={22} color={palette.labelSecondary} />
                <Text style={[styles.moreLabel, isLandscape && styles.moreLabelRow, { color: palette.labelSecondary }]}>
                  {mirrorMode === 'none' ? t('镜像') : mirrorMode === 'horizontal' ? t('水平镜像') : t('垂直镜像')}
                </Text>
              </TouchableOpacity>
              {/* 暂停钮样式（对比用临时项，见文件顶部 CENTER_PLAY_VARIANTS 注释）：
                  点一下循环换一种，暂停画面即可对比；用户选定后把默认值改成那个、并删掉本项。 */}
              <TouchableOpacity
                style={[styles.moreItem, isLandscape && styles.moreItemRow]}
                onPress={() => {
                  const idx = CENTER_PLAY_VARIANTS.indexOf(centerVariant);
                  const next = CENTER_PLAY_VARIANTS[(idx + 1) % CENTER_PLAY_VARIANTS.length];
                  centerPlayVariant = next;
                  setCenterVariant(next);
                  void AsyncStorage.setItem(CENTER_PLAY_KEY, next).catch(() => undefined);
                  setMoreVisible(false);
                }}
              >
                <MaterialCommunityIcons name="gesture-tap" size={22} color={palette.labelSecondary} />
                <Text style={[styles.moreLabel, isLandscape && styles.moreLabelRow, { color: palette.labelSecondary }]}>
                  {`${t('暂停钮样式')} · ${CENTER_PLAY_LABELS[centerVariant]}`}
                </Text>
              </TouchableOpacity>
              {/* 稍后再看（用户 2026-09-30：加入入口从列表行书签挪到播放器功能面板）。
                  只在当前内容带 source.ref（可事后重新解析地址）时出现 —— 见上方 watchLaterRef 注释。 */}
              {watchLaterRef ? (
                <TouchableOpacity
                  style={[styles.moreItem, isLandscape && styles.moreItemRow]}
                  onPress={() => {
                    const st = usePlayerStore.getState();
                    const added = useWatchLaterStore.getState().toggle({
                      kind: watchLaterRef.kind,
                      id: watchLaterRef.id,
                      title: String(st.meta?.title || ''),
                      cover: st.meta?.cover,
                      // 成员 / 队伍 / 是否音频：稍后再看列表卡片要显示（页面在 meta 里传）
                      owner: st.meta?.owner,
                      team: st.meta?.team,
                      // 成员数字 id：事后按 id 反查成员库补队伍（见 utils/memberMatch）
                      ownerId: st.meta?.ownerId,
                      audio: st.source?.kind === 'audio' || !!st.source?.audioOnly,
                    });
                    setMoreVisible(false);
                    showToast(added ? t('已加入稍后再看') : t('已移出稍后再看'));
                  }}
                >
                  <MaterialCommunityIcons
                    name={inWatchLater ? 'bookmark' : 'bookmark-outline'}
                    size={22}
                    color={inWatchLater ? palette.tint : palette.labelSecondary}
                  />
                  <Text style={[styles.moreLabel, isLandscape && styles.moreLabelRow, { color: inWatchLater ? palette.tint : palette.labelSecondary }]}>
                    {inWatchLater ? t('已加入稍后再看') : t('稍后再看')}
                  </Text>
                </TouchableOpacity>
              ) : null}
              {moreActions.map((action) => (
                <TouchableOpacity
                  key={action.key}
                  style={[styles.moreItem, isLandscape && styles.moreItemRow]}
                  onPress={() => {
                    // 带选项的动作（如 B站画质）：关闭功能面板，从播放器右侧弹出独立小面板
                    if (action.options?.length) {
                      setOptionSheet({ title: action.label, options: action.options });
                      setMoreVisible(false);
                      return;
                    }
                    setMoreVisible(false);
                    action.onPress?.();
                  }}
                >
                  <MaterialCommunityIcons name={action.icon as any} size={22} color={action.active ? palette.tint : palette.labelSecondary} />
                  <Text style={[styles.moreLabel, isLandscape && styles.moreLabelRow, { color: action.active ? palette.tint : palette.labelSecondary }]}>{action.label}</Text>
                  {action.options?.length ? (
                    <MaterialCommunityIcons name="chevron-right" size={14} color={palette.labelTertiary} />
                  ) : null}
                </TouchableOpacity>
              ))}
              {features.kernelSwitch ? (
                <TouchableOpacity style={[styles.moreItem, isLandscape && styles.moreItemRow]} onPress={() => {
                  const s = usePlayerStore.getState();
                  s.setUseWebKernel(!s.useWebKernel);
                  s.clearError();
                  setMoreVisible(false);
                }}>
                  <MaterialCommunityIcons name="monitor" size={22} color={palette.labelSecondary} />
                  <Text style={[styles.moreLabel, isLandscape && styles.moreLabelRow, { color: palette.labelSecondary }]}>
                    {useWebKernel ? t('切回原生播放器') : t('切换网页播放器')}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* 选项的右侧独立小面板（如 B站画质档位）：点功能面板里的「画质 ›」从右边弹出，
          不内嵌在功能面板里；点面板外任意处关闭。全部颜色取 palette（统一主题）。 */}
      <Modal visible={!!optionSheet} transparent animationType="fade" onRequestClose={() => setOptionSheet(null)}>
        <Pressable style={styles.modalShade} onPress={() => setOptionSheet(null)}>
          <View style={styles.optionSheetWrap} pointerEvents="box-none">
            {optionSheet ? (
              <View style={[styles.optionSheet, { backgroundColor: palette.surface }]}>
                <View style={styles.optionSheetHeader}>
                  <Text style={[styles.optionSheetTitle, { color: palette.label }]} numberOfLines={1}>{optionSheet.title}</Text>
                  <TouchableOpacity onPress={() => setOptionSheet(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <MaterialCommunityIcons name="close" size={18} color={palette.labelSecondary} />
                  </TouchableOpacity>
                </View>
                <ScrollView bounces={false}>
                  {optionSheet.options.map((opt) => (
                    <TouchableOpacity
                      key={opt.key}
                      style={[styles.moreOption, opt.disabled ? styles.moreOptionDisabled : null]}
                      disabled={opt.disabled}
                      onPress={() => { setOptionSheet(null); opt.onPress(); }}
                    >
                      <Text
                        style={[styles.moreOptionText, { color: opt.active ? palette.tint : opt.disabled ? palette.labelTertiary : palette.label }]}
                        numberOfLines={1}
                      >
                        {opt.label}
                      </Text>
                      {opt.active ? (
                        <MaterialCommunityIcons name="check" size={16} color={palette.tint} />
                      ) : opt.hint ? (
                        <Text style={[styles.moreOptionHint, { color: palette.labelTertiary }]}>{opt.hint}</Text>
                      ) : null}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            ) : null}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

/** 加载中指示：长时间未出画面给出弱提示（>15s），避免黑屏永转圈无反馈 */
function LoadingHint() {
  const { t } = useI18n();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View style={styles.loadingWrap} pointerEvents="none">
      <ActivityIndicator size="large" color="#fff" />
      <Text style={styles.loadingText}>{slow ? t('加载时间较长，若仍未出画面请点「重试」或切换网页播放器') : t('加载中…')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  topWrap: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
    flexDirection: 'row', alignItems: 'center',
    paddingBottom: 24, paddingHorizontal: 8,
  },
  /** 横屏：顶栏收紧（横屏窗口矮，竖屏那 24px 底部留白纯浪费） */
  topWrapLandscape: { paddingBottom: 12 },
  topBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(20,20,24,0.34)',
  },
  /** 横屏：36×36（40 在横屏偏大，视觉上会盖住画面） */
  topBtnLandscape: { width: 36, height: 36, borderRadius: 18 },
  titleWrap: { flex: 1, marginHorizontal: 10, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  /** 右上角成员胶囊（队伍徽章 + 名字）：半透明深底，画面再亮也看得清；不参与标题收缩 */
  memberChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
    maxWidth: 168,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.32)',
    marginRight: 6,
  },
  memberName: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
    flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  titleText: {
    color: '#fff', fontSize: 14, fontWeight: '600', flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  /** 在线人数胶囊：贴在标题右侧，不抢标题宽度（flexShrink 保住标题省略号） */
  onlinePill: {
    flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0,
    marginLeft: 8, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999,
    backgroundColor: 'rgba(20,20,24,0.42)',
  },
  onlineText: { color: 'rgba(255,255,255,0.92)', fontSize: 11, fontWeight: '700' },
  bottomShade: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: 200,
  },
  dockWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 31,
    paddingHorizontal: 16, paddingBottom: 16,
  },
  dockBarrageRow: { marginBottom: 10 },
  progressRow: { flexDirection: 'row', alignItems: 'center' },
  timeText: { color: 'rgba(255,255,255,0.92)', fontSize: 11, fontVariant: ['tabular-nums'], marginHorizontal: 8, minWidth: 34, textAlign: 'center' },
  progressTouch: {
    flex: 1, height: 30, justifyContent: 'center',
  },
  progressTrackBg: {
    height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.26)',
  },
  progressFill: { height: 3, borderRadius: 2, backgroundColor: '#fff' },
  progressThumb: {
    position: 'absolute', top: 9.5, width: 11, height: 11, borderRadius: 6,
    marginLeft: -5.5, backgroundColor: '#fff',
  },
  ctrlRow: { flexDirection: 'row', alignItems: 'center', marginTop: 0 },
  /**
   * 横屏底坞中段：录播放「时间 + 进度条 + 时间」，直播放弹幕输入条。
   * flex:1 让它吃掉播放钮与右侧功能组之间的全部宽度。
   */
  dockCenterLandscape: { flex: 1, marginHorizontal: 12, justifyContent: 'center' },
  /**
   * 录播 ±10s 圆圈箭头（播放键两侧）：与「主播放钮」同一套圆形语言，
   * 但用半透明深底 + 白色图标，视觉上不与主按钮抢焦点。
   */
  seekBtn: {
    width: 38, height: 38, borderRadius: 19, marginHorizontal: 7,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(20,20,24,0.34)',
  },
  /** 横屏：34×34（与 36 的顶栏钮同级，底栏整体更薄） */
  seekBtnLandscape: { width: 34, height: 34, borderRadius: 17, marginHorizontal: 6 },
  playBtn: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.94)',
  },
  /** 横屏：播放钮略小（与 36 的顶栏钮同级，底栏整体更薄） */
  playBtnLandscape: { width: 40, height: 40, borderRadius: 20 },
  ctrlHintText: { color: 'rgba(255,255,255,0.6)', fontSize: 11, marginLeft: 8, flexShrink: 1 },
  ctrlBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  rateText: { color: '#fff', fontSize: 12, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  centerPlayWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 15,
    alignItems: 'center', justifyContent: 'center',
  },
  /** 暂停态中央提示 · 变体 glass（玻璃胶囊：半透明深底 + 三角 + 「已暂停」） */
  centerPlayGlass: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999,
    backgroundColor: 'rgba(20,20,24,0.55)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.35)',
  },
  centerPlayGlassSm: { paddingHorizontal: 12, paddingVertical: 6, gap: 4 },
  centerPlayGlassText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  centerPlayGlassTextSm: { fontSize: 11 },
  /** 变体 ring（细线圆环，无填充）—— 用户选定并放大过：环 76、三角 34（小形态 54/22） */
  centerPlayRing: {
    width: 76, height: 76, borderRadius: 38,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  centerPlayRingSm: { width: 54, height: 54, borderRadius: 27 },
  /** 变体 bare（无底大三角，只带一层投影保证浅色画面上也看得见） */
  centerPlayBareShadow: {
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 8,
  },
  /** 变体 tint（品牌色小圆钮） */
  centerPlayTint: {
    width: 52, height: 52, borderRadius: 26,
    alignItems: 'center', justifyContent: 'center',
    elevation: 4,
  },
  centerPlayTintSm: { width: 36, height: 36, borderRadius: 18, elevation: 0 },
  seekFlashWrap: {
    position: 'absolute', left: 0, right: 0, top: '38%', zIndex: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  seekFlashText: { color: '#fff', fontSize: 15, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  /** 长按快放提示（中央偏上：不与中央播放钮、±10s 闪示、底坞抢位） */
  boostHint: {
    position: 'absolute', left: 0, right: 0, top: '30%', zIndex: 17,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
  },
  boostHintText: { color: '#fff', fontSize: 14, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  /** 直播暂停提示 + 「回到直播」按钮（放在中央播放钮下方，两行叠放） */
  livePauseWrap: {
    position: 'absolute', left: 0, right: 0, top: '62%', zIndex: 17,
    alignItems: 'center', gap: 8,
  },
  livePauseText: {
    color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  livePauseBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
  },
  livePauseBtnText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  loadingWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 20,
    alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  loadingText: { color: '#fff', fontSize: 12, opacity: 0.85 },
  rateMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  rateSheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 30, paddingTop: 14, paddingHorizontal: 16 },
  rateSheetTitle: { fontSize: 12, textAlign: 'center', marginBottom: 10 },
  rateGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  rateChip: { width: '30%', paddingVertical: 10, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
  rateChipText: { fontSize: 14, fontWeight: '700' },
  errorWrap: {
    position: 'absolute', left: 24, right: 24, top: '42%', zIndex: 40,
    alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.72)', borderRadius: 12, padding: 14,
  },
  errorText: { color: '#fff', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  errorBtn: {
    marginTop: 10, paddingHorizontal: 18, paddingVertical: 7, borderRadius: 16,
    backgroundColor: TINT,
  },
  errorBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  modalShade: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  /** 横屏：底板横排、面板贴右（与弹幕列表/设置同一套抽屉语言） */
  modalShadeLandscape: { flexDirection: 'row', justifyContent: 'flex-end' },
  morePanel: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 28, paddingTop: 14,
  },
  /** 横屏：底部弹层不再横跨整个宽屏（800px 宽的「更多」菜单很难扫读），收窄居中 */
  sheetLandscape: { maxWidth: 460, width: '100%', alignSelf: 'center' },
  /** 横屏：右侧竖排抽屉（用户 2026-11-12：「三个点点开的功能面板横屏也放右边竖排」） */
  morePanelLandscape: {
    width: 320,
    maxWidth: '86%',
    height: '100%',
    maxHeight: '100%',
    alignSelf: 'auto',
    paddingBottom: 20,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 0,
    borderBottomLeftRadius: 18,
  },
  /** 播放速度下拉：贴在右侧控制组上方的小菜单（黑白） */
  rateDropdown: {
    position: 'absolute',
    right: 52,
    bottom: 104,
    width: 104,
    borderRadius: 14,
    paddingVertical: 6,
    backgroundColor: 'rgba(18,18,20,0.97)',
    zIndex: 40,
  },
  rateDropdownLandscape: { right: 96, bottom: 78 },
  rateOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  rateOptionOn: { backgroundColor: 'rgba(255,255,255,0.14)' },
  rateOptionText: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.82)' },
  rateOptionTextOn: { color: '#FFFFFF', fontWeight: '800' },
  moreHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingBottom: 10,
  },
  moreTitle: { fontSize: 16, fontWeight: '700' },
  moreGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12 },
  moreItem: { width: '25%', alignItems: 'center', paddingVertical: 12 },
  /** 横屏竖排：一条一行，图标左、文字右 */
  moreItemRow: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 12, paddingHorizontal: 18, paddingVertical: 12 },
  moreLabel: { fontSize: 11, marginTop: 5, textAlign: 'center' },
  moreLabelRow: { fontSize: 13, fontWeight: '600', marginTop: 0, textAlign: 'left' },
  // 动作项的右侧独立小面板（如画质）：贴右垂直居中，底色由渲染处传 palette.surface
  optionSheetWrap: { position: 'absolute', top: 0, bottom: 0, right: 0, justifyContent: 'center' },
  optionSheet: {
    width: 224, maxHeight: '72%', borderRadius: 16, paddingVertical: 8, marginRight: 12,
    elevation: 12,
  },
  optionSheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 14, paddingBottom: 6 },
  optionSheetTitle: { fontSize: 13, fontWeight: '800', flexShrink: 1 },
  moreOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  moreOptionDisabled: { opacity: 0.45 },
  moreOptionText: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  moreOptionHint: { fontSize: 11, fontWeight: '600' },
});

export default PlayerChrome;
