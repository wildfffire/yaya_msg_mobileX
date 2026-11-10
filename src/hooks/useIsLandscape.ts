/**
 * 当前窗口是否处于横屏。
 *
 * 全仓 `Dimensions.get` 已统一替换为 `useWindowDimensions`（见 docs/修复记录汇总.md 第五节 5.4），
 * 本 hook 只是把「宽 > 高」这条判定收敛成一个可复用入口，避免各处各写一份。
 * 旋转时 `useWindowDimensions` 会触发一次重渲染 —— 无额外订阅、无新增定时器。
 */
import { useWindowDimensions } from 'react-native';
import { isLandscapeSize } from '../utils/orientation';

export function useIsLandscape(): boolean {
  const { width, height } = useWindowDimensions();
  return isLandscapeSize(width, height);
}

export default useIsLandscape;
