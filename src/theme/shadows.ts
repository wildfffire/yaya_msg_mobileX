/**
 * 阴影体系 —— 用户 2026-11-09：「整个软件都要扁平化，把阴影去掉」。
 *
 * 四级 API 全部返回空对象：全站 40+ 处 `...shadows.md` 展开处零改动即失去投影，
 * 层次改由「纯色底 + 1px 细描边 + 圆角 + 间距」建立。
 * 保留函数签名（isDark 参数）以免调用点报错，也方便以后要恢复时只改这一处。
 */
import type { ViewStyle } from 'react-native';

const EMPTY: ViewStyle = {};

export const makeShadows = (_isDark: boolean) => ({
  xs: EMPTY,
  sm: EMPTY,
  md: EMPTY,
  lg: EMPTY,
});
