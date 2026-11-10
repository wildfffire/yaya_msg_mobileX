import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { BlurTargetProvider, BlurTargetSurface, useBlurTarget } from '../components/BlurTarget';
import { logInfo } from '../utils/runtimeLog';
import { BlurView } from 'expo-blur';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  createNavigationContainerRef,
  useFocusEffect,
  useIsFocused,
  useNavigation,
  useNavigationState,
} from '@react-navigation/native';
import Reanimated, { Easing as ReEasing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useRoomUnreadStore } from '../services/roomUnread';
// 未读分侧后总值必须走统一求和（大 + 小两侧在同一张表里，直接遍历仍然是总数）
import { roomUnreadTotal as sumRoomUnread } from '../utils/roomUnreadRules';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Animated, BackHandler, Easing, ImageBackground, Keyboard, Platform, StyleSheet, View } from 'react-native';
import { useSettingsStore, useUiStore, useUpdateStore } from '../store';
import { setPipEnabled, listenPipToggle } from '../utils/pip';
import { Palettes } from '../theme/colors';
import { fixDataUriMime } from '../utils/dataUri';
import { ensureMemberData } from '../services/memberData';
import { RootStackParamList, TabParamList } from './types';
import { resetChromeScroll } from './chromeScroll';
import { AppTabBar, MCI } from '../components/AppTabBar';
import { PageBackdrop } from '../components/PageBackdrop';
import { MiniPlayer } from '../components/MiniPlayer';
import { useMiniPlayerStore } from '../store/miniPlayerStore';
import { usePlayerStore } from '../player/store/playerStore';
import { usePalette } from '../theme';
import HomeScreen from '../screens/HomeScreen';
import MessagesScreen from '../screens/MessagesScreen';
import MediaScreen from '../screens/MediaScreen';
import FollowedRoomsScreen from '../screens/FollowedRoomsScreen';
import LoginScreen from '../screens/LoginScreen';
import RechargeScreen from '../screens/RechargeScreen';
import FlipScreen from '../screens/FlipScreen';
import ProfileScreen from '../screens/ProfileScreen';
import SettingsScreen from '../screens/SettingsScreen';
import MyScreen from '../screens/MyScreen';
import FetchScreen from '../screens/FetchScreen';
import PhotosScreen from '../screens/PhotosScreen';
import TripScreen from '../screens/TripScreen';
// 现场互动（口袋云握手 netface）：活动场次 / 预约 / 资格兑换
import NetfaceScreen from '../screens/NetfaceScreen';
import RoomRadioScreen from '../screens/RoomRadioScreen';
import OpenLiveScreen from '../screens/OpenLiveScreen';
import OnMicScreen from '../screens/OnMicScreen';
import PrivateMessagesScreen from '../screens/PrivateMessagesScreen';
import BilibiliLiveScreen from '../screens/BilibiliLiveScreen';
import VideoLibraryScreen from '../screens/VideoLibraryScreen';
import MusicLibraryScreen from '../screens/MusicLibraryScreen';
import AudioProgramsScreen from '../screens/AudioProgramsScreen';
import AnalysisScreen from '../screens/AnalysisScreen';
import DownloadScreen from '../screens/DownloadScreen';
import DatabaseScreen from '../screens/DatabaseScreen';
import MeleeRankScreen from '../screens/MeleeRankScreen';
import MemberDynamicScreen from '../screens/MemberDynamicScreen';
import InvoiceScreen from '../screens/InvoiceScreen';
import WatchLaterScreen from '../screens/watch/WatchLaterScreen';
import HistoryScreen from '../screens/watch/HistoryScreen';
import AppToast from '../components/AppToast';
import ErrorBoundary from '../components/ErrorBoundary';
import { ui } from '../theme/ui';
import { useResolvedTheme } from '../hooks/useAppTheme';
import { useI18n } from '../i18n';

const Stack = createStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

/**
 * 全局导航 ref（用户 2026-11-09：深链 / 通知点击要能在**组件树之外**跳页面）。
 * 只给「系统入口」用（Linking、通知栏点击），页面内部仍走 useNavigation。
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

const TAB_LABELS: Record<string, { icon: string; label: string }> = {
  Home: { icon: 'home', label: '主页' },
  Media: { icon: 'video', label: '直播' },
  Rooms: { icon: 'account-group', label: '房间' },
  Settings: { icon: 'account-circle-outline', label: '我的' },
};

/**
 * 页面包装：直接渲染，不做入场动画。
 * 规范依据（emilkowalski/animate-expo）：tab 切换属「100+ 次/天」频次 → 不该有动画；
 * 且入场淡入依赖 native driver，在 New Architecture 下若 native 动画不生效会把
 * opacity 卡在 0（表现：页面内容闪一下就消失 / 整屏空白，只有 tab bar）。
 */
function withPageMotion<T extends object>(
  Screen: React.ComponentType<T>,
  _duration = ui.motion.tabDuration,
  _distance = 8,
  /** 二级屏（root stack 里 Main 之外的屏）传 true：进入即隐藏 dock，离开恢复。
   *  必须用 focus 副作用驱动 —— root stack 的卡片是透明的、Main 仍挂在树上，
   *  单靠 tabBar 自己的状态判断不到「被二级屏盖住」。 */
  hideTabBar = false,
) {
  return function PageMotionScreen(props: T) {
    const setTabBarHidden = useUiStore((state) => state.setTabBarHidden);
    const isFocused = useIsFocused();
    /**
     * 切页入场动画（用户要求 2026-09-28：四个主页面切换要有动画）。
     *
     * ⚠️ 历史教训（见函数上方旧注释）：曾用 RN Animated + native driver 做入场淡入，
     * New Architecture 下动画不生效会把 opacity 永远卡在 0 → 整屏空白（只有 tab bar），
     * 因此当时整体移除。这里改用 Reanimated 共享值：
     *   - 失焦立即归零（场景本就被导航器隐藏，无视觉影响；下次获焦必定从 0 开始）；
     *   - 获焦 0 → 1 淡入 + 轻微上移（240ms，与 tab 切换频次匹配的克制时长）；
     *   - opacity 从 0.35 起步：即便极端时序下动画没跑，也只是「没动画」，不会白屏。
     */
    const enter = useSharedValue(isFocused ? 1 : 0);
    useEffect(() => {
      if (isFocused) {
        enter.value = 0;
        enter.value = withTiming(1, { duration: 240, easing: ReEasing.out(ReEasing.cubic) });
      } else {
        enter.value = 0;
      }
    }, [isFocused, enter]);
    const enterStyle = useAnimatedStyle(() => ({
      /**
       * ⚠️ 这里**不再动画 opacity**（用户反馈 2026-09-28：切页多了会看到上一个页面的内容，
       *   最离谱的一次是「切到直播页却看到房间列表、而且列表是空的」）。
       *
       * 根因：tab 场景是**透明的**（`sceneStyle: { backgroundColor: 'transparent' }`，
       *   为的是让 PageBackdrop / 玻璃折射透出来），而原来的入场动画
       *   `opacity: 0.35 + 0.65 * enter.value` 会让新场景在 240ms 内半透明 ——
       *   这段时间里**下层那个 tab 的场景会直接透上来**（v7 的 tab 场景是叠放布局，
       *   `animation: 'none'` 不会把旧场景立刻移走）。旧场景若正好是空列表，看到的就是"空房间列表"。
       *
       * 现在只动位移：**新场景从第一帧就是完全不透明的**，物理上盖住下层，不可能串台；
       * 同时顺带消掉历史上那类「opacity 被卡在 0 → 整屏空白」的风险（不再有 opacity 动画）。
       */
      transform: [{ translateY: (1 - enter.value) * 6 }],
    }));
    // dock 显隐只由「当前获得焦点的屏」决定：
    // 二级屏 true（隐藏），tab 屏 false（显示）。不做 cleanup，
    // 否则下一屏 focus 之后旧屏的 cleanup 会把状态又拨回去（竞态 → dock 时隐时现）。
    useFocusEffect(
      React.useCallback(() => {
        setTabBarHidden(hideTabBar);
        // 顶栏/底栏的「滚动收起」是全局状态，必须跟着焦点复位（含上次偏移量清零）
        resetChromeScroll();
      }, [hideTabBar, setTabBarHidden]),
    );
    return (
      <ErrorBoundary>
        <Reanimated.View style={[{ flex: 1 }, enterStyle]}>
          <Screen {...props} />
        </Reanimated.View>
      </ErrorBoundary>
    );
  };
}

/** 底部 Tab 顺序：左右横划按这个顺序切换（与 Tab.Screen 声明顺序保持一致） */
const TAB_ORDER: Array<keyof TabParamList> = ['Home', 'Media', 'Rooms', 'Settings'];

/**
 * 给「底部 Tab 场景」套上左右横划切换手势（用户需求：横划能切换页面）。
 *
 * 关键设计：**只包场景内容、不包底栏**。
 * 底栏自己有「按住拖动选中胶囊」的 PanResponder，若把手势圈到整个 Tab.Navigator 上，
 * 横划会把它吃掉（底栏拖动失效）。包在场景里则两者互不干扰。
 *
 * 阈值取舍：横向 48px（或甩动速度 > 800）才切页，且竖向位移必须小于横向 ——
 * 这样列表上下滚动、横向 chips 行的小幅滑动都不会误触发切页。
 */
function withTabSwipe<T extends object>(Screen: React.ComponentType<T>) {
  function TabSwipeScreen(props: T) {
    const navigation = useNavigation<any>();
    // 当前激活的 tab（跟随导航状态，外部跳转/返回也能对上）
    const activeKey = useNavigationState(
      (s) => ((s?.routes?.[s.index]?.name as keyof TabParamList) || 'Home'),
    );
    /**
     * 横划开关：进房间 / 打开播放器时全局锁掉（useUiStore 的计数锁）。
     * 例：房间内页面本身有横向手势；播放器进度条拖动也是横向的 —— 都会被 48px 阈值误判成切页。
     */
    const swipeLocked = useUiStore((s) => s.tabSwipeLocked);
    const gesture = useMemo(
      () =>
        Gesture.Pan()
          // 回调跑在 JS 线程（不引入 worklet，避免与现有逻辑混用出问题）
          .runOnJS(true)
          .enabled(!swipeLocked)
          .activeOffsetX([-48, 48])
          .failOffsetY([-18, 18])
          .onEnd((e) => {
            const dx = e.translationX;
            const flung = Math.abs(e.velocityX) > 800;
            if (!flung && Math.abs(dx) < 48) return;
            if (Math.abs(dx) < Math.abs(e.translationY)) return;
            const idx = TAB_ORDER.indexOf(activeKey);
            if (idx < 0) return;
            const next = TAB_ORDER[idx + (dx < 0 ? 1 : -1)];
            if (next) navigation.navigate(next as never);
          }),
      [activeKey, navigation, swipeLocked],
    );
    return (
      <GestureDetector gesture={gesture}>
        <View style={styles.tabScene}>
          <Screen {...props} />
        </View>
      </GestureDetector>
    );
  }
  TabSwipeScreen.displayName = `withTabSwipe(${Screen.displayName || Screen.name || 'Tab'})`;
  return TabSwipeScreen;
}

// 注：4 个 tab 的入场淡入（opacity+translateY）自项目基线(ed271c0)起就由 withPageMotion 提供，
// 是用户预期的转场观感，非性能负优化。保留 withPageMotion，不做无动画替换。
const HomeTabScreen = withTabSwipe(withPageMotion(HomeScreen));
const MediaTabScreen = withTabSwipe(withPageMotion(MediaScreen));
const RoomsTabScreen = withTabSwipe(withPageMotion(FollowedRoomsScreen));
const SettingsTabScreen = withTabSwipe(withPageMotion(MyScreen));
const MessagesStackScreen = withPageMotion(MessagesScreen, ui.motion.stackDuration, 10, true);
const LoginStackScreen = withPageMotion(LoginScreen, ui.motion.stackDuration, 10, true);
const RechargeStackScreen = withPageMotion(RechargeScreen, ui.motion.stackDuration, 10, true);
const FetchStackScreen = withPageMotion(FetchScreen, ui.motion.stackDuration, 10, true);
const FlipStackScreen = withPageMotion(FlipScreen, ui.motion.stackDuration, 10, true);
const ProfileStackScreen = withPageMotion(ProfileScreen, ui.motion.stackDuration, 10, true);
const PhotosStackScreen = withPageMotion(PhotosScreen, ui.motion.stackDuration, 10, true);
const TripStackScreen = withPageMotion(TripScreen, ui.motion.stackDuration, 10, true);
const NetfaceStackScreen = withPageMotion(NetfaceScreen, ui.motion.stackDuration, 10, true);
const RoomRadioStackScreen = withPageMotion(RoomRadioScreen, ui.motion.stackDuration, 10, true);
const OpenLiveStackScreen = withPageMotion(OpenLiveScreen, ui.motion.stackDuration, 10, true);
const PrivateMessagesStackScreen = withPageMotion(PrivateMessagesScreen, ui.motion.stackDuration, 10, true);
const BilibiliLiveStackScreen = withPageMotion(BilibiliLiveScreen, ui.motion.stackDuration, 10, true);
const VideoLibraryStackScreen = withPageMotion(VideoLibraryScreen, ui.motion.stackDuration, 10, true);
const MusicLibraryStackScreen = withPageMotion(MusicLibraryScreen, ui.motion.stackDuration, 10, true);
const AudioProgramsStackScreen = withPageMotion(AudioProgramsScreen, ui.motion.stackDuration, 10, true);
const AnalysisStackScreen = withPageMotion(AnalysisScreen, ui.motion.stackDuration, 10, true);
const DownloadStackScreen = withPageMotion(DownloadScreen, ui.motion.stackDuration, 10, true);
const DatabaseStackScreen = withPageMotion(DatabaseScreen, ui.motion.stackDuration, 10, true);
const MeleeRankStackScreen = withPageMotion(MeleeRankScreen, ui.motion.stackDuration, 10, true);
const MemberDynamicStackScreen = withPageMotion(MemberDynamicScreen, ui.motion.stackDuration, 10, true);
const InvoiceStackScreen = withPageMotion(InvoiceScreen, ui.motion.stackDuration, 10, true);
// 必须与其他页面一样在模块顶层预包装：withPageMotion 每次调用都返回「新函数」，
// 若写在 <Stack.Screen component={...}> 里，React Navigation 每次比对都视作组件类型变化 →
// 卸载重建页面，页面内状态（输入、滚动位置、选区）会莫名丢失。
const OnMicStackScreen = withPageMotion(OnMicScreen, ui.motion.stackDuration, 10, true);
const WatchLaterStackScreen = withPageMotion(WatchLaterScreen, ui.motion.stackDuration, 10, true);
const HistoryStackScreen = withPageMotion(HistoryScreen, ui.motion.stackDuration, 10, true);
const SettingsDetailStackScreen = withPageMotion(SettingsScreen, ui.motion.stackDuration, 10, true);

/** 底栏滑出屏幕所需的下移距离（栏高 + 安全区 + 上下留白，多给一点无妨，反正已滑出视野） */
const DOCK_TRAVEL = 160;

function MainTabBar({
  state,
  descriptors,
  navigation,
  hidden,
}: BottomTabBarProps & { hidden: boolean }) {
  const { t } = useI18n();
  const palette = usePalette();
  // 房间 tab 未读总数：本地累计的各房间**大 + 小两侧**未读之和
  // （房间列表有新消息时在 tab 右上角显示数量；求和统一走 utils/roomUnreadRules，别再自己遍历）
  const roomUnreadTotal = useRoomUnreadStore((s) => sumRoomUnread(s.counts));
  /**
   * 滚动收起（用户要求）：主页面向上滚动时底栏滑出屏幕，向下滚回时滑回。
   * 与 `hidden` 的分工：`hidden` 是导航驱动的（进二级页/进房/播放），保持原来的「直接不渲染」；
   * 这一个只由滚动方向驱动，做成滑出动画 —— 滚动是高频动作，硬切会很突兀。
   */
  const chromeHiddenByScroll = useUiStore((s) => s.chromeHiddenByScroll);
  const slide = useSharedValue(chromeHiddenByScroll ? 1 : 0);
  useEffect(() => {
    slide.value = withTiming(chromeHiddenByScroll ? 1 : 0, {
      duration: 220,
      easing: ReEasing.out(ReEasing.cubic),
    });
  }, [chromeHiddenByScroll, slide]);
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: slide.value * DOCK_TRAVEL }],
    opacity: 1 - slide.value,
  }));
  if (hidden) return null;

  const items = state.routes.map((route, index) => {
    const tabMeta = TAB_LABELS[route.name];
    const fallback = tabMeta
      ? { icon: MCI(tabMeta.icon), label: t(tabMeta.label) }
      : {
          icon: MCI('circle'),
          label: typeof descriptors[route.key]?.options?.tabBarLabel === 'string'
            ? t(descriptors[route.key]?.options?.tabBarLabel as string)
            : route.name,
        };
    return {
      key: route.name,
      icon: fallback.icon,
      label: fallback.label,
      badge: route.name === 'Rooms' ? roomUnreadTotal : undefined,
      onPress: () => {
        const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
        if (state.index !== index && !event.defaultPrevented) navigation.navigate(route.name);
      },
    };
  });

  const activeKey = state.routes[state.index]?.name || 'Home';
  // 自制玻璃底栏（LiquidGlassView 真折射），透光可调
  return (
    // absoluteFill 包一层只为拿住 transform；AppTabBar 自身仍是 bottom:0 的绝对定位，
    // 所以落点与改动前一致。收起时 pointerEvents=none，避免用户点到已经滑出屏幕的底栏。
    <Reanimated.View
      style={[StyleSheet.absoluteFill, slideStyle]}
      pointerEvents={chromeHiddenByScroll ? 'none' : 'box-none'}
    >
      <AppTabBar
        items={items}
        activeKey={activeKey}
        onSelect={(key) => {
          const target = items.find((it) => it.key === key);
          target?.onPress();
        }}
      />
    </Reanimated.View>
  );
}

function MainTabs() {
  const tabBarHidden = useUiStore((state) => state.tabBarHidden);

  return (
    <Tab.Navigator
      tabBar={(props) => (
        // hidden 由 NavigationContainer.onStateChange 统一驱动：
        // 二级屏（root stack 里 Main 之外的屏）打开时隐藏 dock
        <MainTabBar {...props} hidden={tabBarHidden} />
      )}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: 'transparent' },
        // iPhone 26 底部 tab 切换无水平滑动（瞬切）；靠 TabCell spring pop 主导
        animation: 'none',
      }}
    >
      <Tab.Screen name="Home" component={HomeTabScreen} options={{ tabBarLabel: '主页' }} />
      <Tab.Screen name="Media" component={MediaTabScreen} options={{ tabBarLabel: '直播' }} />
      <Tab.Screen name="Rooms" component={RoomsTabScreen} options={{ tabBarLabel: '房间' }} />
      <Tab.Screen name="Settings" component={SettingsTabScreen} options={{ tabBarLabel: '我的' }} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBarWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: 116,
  },
  /** 横划切页手势的场景容器（必须是 flex:1 的原生视图，GestureDetector 才能接管触摸） */
  tabScene: { flex: 1 },
});

const AppTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: Palettes.light.tint,
    background: Palettes.light.background,
    card: Palettes.light.surface,
    text: Palettes.light.label,
    border: Palettes.light.hairline,
  },
};

const AppDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: Palettes.dark.tint,
    background: Palettes.dark.background,
    card: Palettes.dark.surface,
    text: Palettes.dark.label,
    border: Palettes.dark.hairline,
  },
};

/**
 * 全局「返回先收键盘」桥（Android）。
 *
 * 问题：edge-to-edge + 手势导航下，系统不一定先收起输入法就直接把页面退了 →
 *   ① 用户想关键盘却退出了页面；
 *   ② 更隐蔽的连带伤害：页面已切走、输入法还开着，`keyboardDidHide` 可能不触发，
 *      靠键盘高度做布局的页面（聊天/房间 `paddingBottom: kb`）会**卡在非 0 高度**，
 *      背景图被顶掉一条（「房间背景图显示不完全」就是这么来的）。
 *
 * 这里统一接管：键盘可见时，本次返回只收键盘并消费事件，不进下一步；再返回一次才走页面返回。
 * 注意 BackHandler 是「后注册先执行」，本桥在导航根注册（最早），因此页面自己的返回
 * 处理优先 —— 页面若自行消费返回，建议也先调一次 Keyboard.dismiss()。
 */
function KeyboardBackBridge() {
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (Keyboard.isVisible()) {
        Keyboard.dismiss();
        return true; // 消费本次返回：只收键盘
      }
      return false;
    });
    return () => sub.remove();
  }, []);
  return null;
}

/**
 * 系统 PiP（小窗）⏯ 点击 → 切换"当前正在小窗里播的媒体"的播放/暂停。
 * 优先级：应用内小窗接管中 → 切小窗；否则统一播放器 source 在播 → 切它（store.state
 * 变化驱动 native/exo paused prop 与 web postMessage，PlayerCore 已接 web 指令）。
 * 全局只挂一次（导航根），PiP 期间 JS 存活即可达。
 */
function PipToggleBridge() {
  // 画中画开关 → 原生（默认关：不主动调用不弹 App 外系统小窗；设置页开启后切后台才自动 PiP）
  const pipAuto = useSettingsStore((s) => s.settings.pip_auto);
  useEffect(() => {
    setPipEnabled(!!pipAuto);
  }, [pipAuto]);

  useEffect(() => {
    return listenPipToggle(() => {
      try {
        const mini = useMiniPlayerStore.getState();
        if (mini.visible && mini.info?.url) {
          useMiniPlayerStore.getState().requestSysToggle();
          return;
        }
        const ps = usePlayerStore.getState();
        if (ps.source?.url && (ps.state === 'playing' || ps.state === 'paused')) {
          ps.setState(ps.state === 'playing' ? 'paused' : 'playing');
        }
      } catch {}
    });
  }, []);
  return null;
}

/**
 * 背景模糊层：只模糊 BlurTargetSurface 里那张自定义背景图。
 * 必须渲染在 BlurTargetSurface **外面**（内部放 BlurView 会 RenderNode 嵌套爆栈，见 BlurTarget 注释），
 * 通过 ref（blurTarget）绑定目标；没有 target 时（老包/不支持）直接不渲染，避免白纱盖屏。
 */
function BackgroundBlur({ blur }: { blur: number }) {
  const blurTarget = useBlurTarget();
  if (!blurTarget) return null;
  return (
    <BlurView
      pointerEvents="none"
      intensity={Math.min(100, Math.max(10, Math.round(blur * 5)))}
      tint="default"
      blurTarget={blurTarget}
      blurMethod="dimezisBlurViewSdk31Plus"
      /* 降采样：整屏背景逐帧模糊代价很高，8 与玻璃层同一档（用户 2026-11-09） */
      blurReductionFactor={Platform.OS === 'android' ? 8 : 4}
      style={StyleSheet.absoluteFill}
    />
  );
}

export default function AppNavigator() {
  const theme = useResolvedTheme();
  const palette = usePalette();
  const screenBackdrop = useUiStore((state) => state.screenBackdrop);
  const customBgRaw = useSettingsStore((state) => state.settings.customBackgroundFile?.trim() || '');
  /**
   * 渲染前修正 data URI 的 mime：历史数据里存在「声明 image/png、实际是 JPEG」的脏值，
   * 部分解码路径会信声明而解码失败 → 背景一片黑（用户反馈的「背景图没加载」）。
   * 在这里修可以**顺带修好已保存的旧值**，不用用户重新选图。
   */
  const customBg = useMemo(() => fixDataUriMime(customBgRaw), [customBgRaw]);
  const hasBackground = !!customBg;
  const navTheme = theme === 'dark' ? AppDarkTheme : AppTheme;
  // 导航层永远透明：液态玻璃的透光来源是根层 PageBackdrop/背景图，
  // card 不透明会把底衬完全盖住 → 玻璃无从谈起
  // primary 跟随主题色（PiliPlus 风格种子色），静态 AppTheme 只提供明暗默认值
  const themed = { ...navTheme, colors: { ...navTheme.colors, background: 'transparent', card: 'transparent', primary: palette.tint } };
  /**
   * 自定义背景的暗化遮罩强度 + 模糊（用户 2026-11-09：调了没反应）。
   *
   * ⚠️ 真正被用户看见的背景图在**这一层**（导航层，渲染在 App 那层之上），
   * 以前 App.tsx 里算的 bg_dim/bg_blur 全被这层盖住 → 怎么调都没变化。
   * 遮罩默认 34（= 旧版写死的 0.34），滑到 0/100 能明显看出差别。
   */
  const bgDimRaw = useSettingsStore((state) => state.settings.bg_dim);
  const bgBlurRaw = useSettingsStore((state) => state.settings.bg_blur);
  const bgDimAlpha = Math.max(0, Math.min(100, Number(bgDimRaw ?? 34))) / 100;
  const bgBlur = Math.max(0, Math.min(20, Number(bgBlurRaw ?? 0)));
  const bgScrim = theme === 'dark'
    ? `rgba(11,11,15,${bgDimAlpha.toFixed(2)})`
    : `rgba(245,245,247,${bgDimAlpha.toFixed(2)})`;

  // 启动即自动同步成员数据库（进入软件自动更新；失败静默忽略，不阻塞启动）
  useEffect(() => {
    ensureMemberData().catch(() => {});
  }, []);

  // 启动静默检查版本更新（24h 限流；失败静默，有更新时设置页显示红点）
  useEffect(() => {
    useUpdateStore.getState().checkUpdate().catch(() => {});
  }, []);

  /** 诊断：设置里调完遮罩/模糊后，logcat 应出现 `[bg] dim=… blur=…`（release 包也打） */
  useEffect(() => {
    logInfo(`[bg] dim=${Math.round(bgDimAlpha * 100)} blur=${bgBlur} hasBg=${hasBackground ? 1 : 0}`, 'app');
  }, [bgDimAlpha, bgBlur, hasBackground]);

  return (
    <ErrorBoundary>
    <>
      <BlurTargetProvider>
      <BlurTargetSurface>
        {/* 房间页打开时：blur 目标层挂房间背景图（+遮罩），让房间里的玻璃折射房间背景。
            玻璃只录这一层 —— 房间背景若只渲染在页面里，玻璃折射到的仍是全局背景。 */}
        {screenBackdrop?.uri ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <ImageBackground
              source={{ uri: screenBackdrop.uri }}
              resizeMode="cover"
              style={StyleSheet.absoluteFill}
            />
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: screenBackdrop.scrim }]} />
          </View>
        ) : hasBackground ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <ImageBackground
              source={{ uri: customBg }}
              resizeMode="cover"
              style={StyleSheet.absoluteFill}
            />
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: bgScrim }]} />
          </View>
        ) : (
          <PageBackdrop />
        )}
      </BlurTargetSurface>
      {/*
        背景模糊：必须放在 BlurTargetSurface **外面**（内部放 BlurView 会 RenderNode 嵌套爆栈），
        用 ref 指向那块 surface（blurTarget）→ 只模糊背景图这一层，不影响页面内容。
      */}
      {/* 房间页（screenBackdrop）时这块 surface 里是房间背景，不该套用 App 背景的模糊 */}
      {hasBackground && !screenBackdrop?.uri && bgBlur > 0 ? <BackgroundBlur blur={bgBlur} /> : null}
      {/*
        onStateChange：任何一次导航（含手势返回被 navigator 自己处理掉、不经过
        BackHandler 的情况）都兜底收起输入法 —— 否则键盘可能跟着旧页面留着，
        而靠键盘高度做布局的页面会卡在非 0 高度（背景被顶掉一条）。
      */}
      <NavigationContainer
        ref={navigationRef}
        theme={themed}
        onStateChange={() => { if (Keyboard.isVisible()) Keyboard.dismiss(); }}
      >
      <>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            animation: 'none',
            cardOverlayEnabled: false,
            // ⚠️ 必须保持 true：卡片全是透明背景，false 时下层 Main 会保持渲染并
            // 透到二级屏上 =「界面叠在一起」（2026-10-01 实测翻车，已回滚）。
            detachPreviousScreen: true,
            cardStyle: { backgroundColor: 'transparent' },
          }}
        >
          <Stack.Screen name="Main" component={MainTabs} />
          <Stack.Screen name="MessagesScreen" component={MessagesStackScreen} />
          <Stack.Screen name="LoginScreen" component={LoginStackScreen} />
          <Stack.Screen name="RechargeScreen" component={RechargeStackScreen} />
          <Stack.Screen name="FetchScreen" component={FetchStackScreen} />
          <Stack.Screen name="FlipScreen" component={FlipStackScreen} />
          <Stack.Screen name="ProfileScreen" component={ProfileStackScreen} />
          <Stack.Screen name="PhotosScreen" component={PhotosStackScreen} />
          <Stack.Screen name="TripScreen" component={TripStackScreen} />
          <Stack.Screen name="NetfaceScreen" component={NetfaceStackScreen} />
          <Stack.Screen name="RoomRadioScreen" component={RoomRadioStackScreen} />
          <Stack.Screen name="OpenLiveScreen" component={OpenLiveStackScreen} />
          <Stack.Screen name="OnMicScreen" component={OnMicStackScreen} />
          <Stack.Screen name="PrivateMessagesScreen" component={PrivateMessagesStackScreen} />
          <Stack.Screen name="BilibiliLiveScreen" component={BilibiliLiveStackScreen} />
          <Stack.Screen name="VideoLibraryScreen" component={VideoLibraryStackScreen} />
          <Stack.Screen name="MusicLibraryScreen" component={MusicLibraryStackScreen} />
          <Stack.Screen name="AudioProgramsScreen" component={AudioProgramsStackScreen} />
          <Stack.Screen name="AnalysisScreen" component={AnalysisStackScreen} />
          <Stack.Screen name="DownloadScreen" component={DownloadStackScreen} />
          <Stack.Screen name="DatabaseScreen" component={DatabaseStackScreen} />
          <Stack.Screen name="MeleeRankScreen" component={MeleeRankStackScreen} />
          <Stack.Screen name="MemberDynamicScreen" component={MemberDynamicStackScreen} />
          <Stack.Screen name="InvoiceScreen" component={InvoiceStackScreen} />
          <Stack.Screen name="WatchLaterScreen" component={WatchLaterStackScreen} />
          <Stack.Screen name="HistoryScreen" component={HistoryStackScreen} />
          <Stack.Screen name="SettingsDetailScreen" component={SettingsDetailStackScreen} />
        </Stack.Navigator>
        <AppToast />
        {/* 应用内悬浮小窗播放器（全局挂载，导航上下文内可用） */}
        <MiniPlayer />
        {/* 系统 PiP ⏯ → 当前媒体切换（全局单次监听） */}
        <PipToggleBridge />
        {/* 返回键/手势返回 → 先收输入法（避免「退页了键盘还在」及其连带的布局卡死） */}
        <KeyboardBackBridge />
      </>
      </NavigationContainer>
      </BlurTargetProvider>
    </>
    </ErrorBoundary>
  );
}
