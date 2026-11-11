/**
 * 横屏侧边栏模式统一 hook：导航层 / ScreenHeader / HomeScreen 共用同一个真值。
 * 不往 store 里写派生字段：useIsLandscape 在旋转时让已挂载的消费者各重渲染一次，
 * 数量等于可见页面数、非高频，换来无需同步 effect 的简单实现。
 */
import { useWindowDimensions } from 'react-native';
import { useSettingsStore } from '../store';
import { useIsLandscape } from './useIsLandscape';
import { sidebarModeActive, sidebarMetrics, type SidebarMetrics } from '../utils/sidebarMode';

export function useSidebarMode(): boolean {
  const enabled = useSettingsStore((state) => state.settings.landscape_sidebar_enabled);
  const isLandscape = useIsLandscape();
  return sidebarModeActive(isLandscape, enabled);
}

/**
 * 侧栏/场景留白/首页网格共用的尺寸真值：旋转后三者一起重算，
 * 避免「侧栏变窄了但页面还按旧宽度让位」或首页卡片被挤到第二行。
 */
export function useSidebarMetrics(): SidebarMetrics {
  const { width, height } = useWindowDimensions();
  return sidebarMetrics(width, height);
}

export default useSidebarMode;
