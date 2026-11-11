/**
 * 横屏侧边栏模式的唯一判定口径（零依赖纯规则，可进 Node 单测）。
 *
 * 用户 2026-11-11 要求「保留现有的模式的同时，增加一个横屏有侧边栏的功能」：
 * 只有「设备横屏」且「设置里开关打开」两个条件同时成立才切侧栏；
 * 竖屏或开关关闭时必须像素级回退现有底部胶囊 + 大标题 + 问候语。
 */
export function sidebarModeActive(
  isLandscape: boolean,
  enabled: boolean | undefined | null,
): boolean {
  return isLandscape === true && enabled === true;
}

export interface SidebarMetrics {
  /** 图标/头像所在的内容栏宽度 */
  contentW: number;
  /** 左侧安全留白 */
  inset: number;
  /** 页面内容需要让出的总宽度（sceneStyle.paddingLeft 与侧栏共用） */
  totalW: number;
}

/**
 * 侧栏宽度按屏幕短边自适应（用户 2026-11-11 真机反馈「左侧太宽」）。
 *
 * 旧版固定 64 内容 + 32 安全边 = 96dp：在 1024×640dp 的横屏平板上占了近一成屏宽，
 * 而且手机横屏（851×393dp）占比更高，看起来就是一条又宽又空的白带。
 * 现在以**短边**（横屏时即屏高）为基准缩放：
 *   · 1024×640dp 平板：content 48 + inset 10 = 58dp
 *   · 851×393dp 手机：content 40 + inset 6 = 46dp
 * 夹取区间保证图标（34dp 点击区）与头像始终放得下。
 */
export function sidebarMetrics(width: number, height: number): SidebarMetrics {
  const shortSide = Math.max(1, Math.min(width, height));
  const contentW = Math.round(Math.min(56, Math.max(40, shortSide * 0.075)));
  const inset = Math.round(Math.min(12, Math.max(4, shortSide * 0.015)));
  return { contentW, inset, totalW: contentW + inset };
}

export default sidebarModeActive;
