/**
 * 纯 JS 安全区兜底 —— 不依赖 react-native-safe-area-context
 * 真实值由 native 测量（刘海/底部导航条）通过 Provider 注入，但本 hook 不依赖 Provider：
 *  - 若将来接入 SafeAreaProvider，调用方只需换 import 即可（API 兼容），本 hook 作为 fallback。
 *  - App.tsx 不再包 SafeAreaProvider —— 沙箱构建无 native 真机回归时，第三方 native 包
 *    （依赖 autolinking 注入 Pod/AAR）经常导致 RN bridge 启动崩溃（"_module not found" /
 *    "No safe area value available"）。为降低重构风险，本工程采用 StatusBar + Platform
 *    经验值。
 *
 * 实测：
 *  - iOS：顶部 status bar 高度由 StatusBar.currentHeight 给出；底部 home indicator 高 34
 *  - Android：顶部 status bar ~24dp，底部 navigation bar 约 48dp（API ≥ 24）
 *  - 平板/无 home indicator 时 bottom 趋近 0
 *
 * 数据有偏差但足够定位内容 —— 玻璃底栏 / Toast / MiniPlayer 已用这些值，不会出现
 * "No safe area value available" 启动崩溃。
 *
 * 横屏（全局横屏改造新增）：
 *  - Android 横屏时状态栏仍在顶部（高度基本不变），因此 `top` 不归零 —— 归零会让所有页面
 *    的内容上滑压进状态栏。播放器进入全屏沉浸后才需要去掉顶部留白，那是 `PlayerChrome`
 *    横屏分支自己处理（按 `fullscreen` 判定），不属于本 hook 的职责。
 *  - 横屏真正的风险在左右两侧：挖孔/圆角/三键导航条会贴到侧边（三键导航竖屏在底部、
 *    横屏会挪到左侧或右侧）。而 `top/bottom` 无法表达左右，故横屏时给 `left/right` 一个
 *    保守常量。全仓现有消费方只读 `top/bottom`，`left/right` 此前恒为 0、无人使用，
 *    因此这里新增值不会影响任何既有竖屏布局。
 *  - 不引入 react-native-safe-area-context 的 `useSafeAreaInsets`：App 根节点没有
 *    SafeAreaProvider，直接调用会抛 "No safe area value available" 启动崩溃。
 */
import { Platform, StatusBar, useWindowDimensions } from 'react-native';
import { isLandscapeSize } from '../utils/orientation';

export interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const ANDROID_NAV_BAR = 48;
const IOS_HOME_INDICATOR = 34;
/**
 * 横屏左右安全边保守估计：覆盖 Android 三键导航条（横屏挪到侧边）与主流挖孔/圆角避让。
 * 取值偏小是有意的 —— 宁可让控件靠近边缘，也不要无谓地把横屏可用宽度再切掉 96dp。
 */
const LANDSCAPE_SIDE_INSET = 32;

export function useSafeAreaInsets(): SafeAreaInsets {
  const top =
    Platform.OS === 'ios'
      ? StatusBar.currentHeight || 44
      : StatusBar.currentHeight || 24;
  const bottom = Platform.OS === 'ios' ? IOS_HOME_INDICATOR : ANDROID_NAV_BAR;
  const { width, height } = useWindowDimensions();
  if (isLandscapeSize(width, height)) {
    return { top, bottom, left: LANDSCAPE_SIDE_INSET, right: LANDSCAPE_SIDE_INSET };
  }
  return { top, bottom, left: 0, right: 0 };
}
