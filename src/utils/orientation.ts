/**
 * 屏幕方向统一出口。
 *
 * 背景（改造前）：全仓有 18 处裸调用 `ScreenOrientation.lockAsync(PORTRAIT_UP)`，
 * 且没有任何一处 `unlockAsync()` —— 离开页面 / 失焦 / 退后台 / 返回键都会把画面重新压回
 * 竖屏；再叠加 `AndroidManifest` 的 MainActivity `screenOrientation="portrait"`，
 * 结果就是「App 只能竖屏」。多入口散落调用是这次问题的根因，因此收敛到本文件：
 *  - 语义化三个目标：`follow`（跟随系统）/ `landscape`（锁横屏）/ `portrait`（锁竖屏）
 *  - 所有调用 `.catch(() => {})` 静默降级：方向锁定在部分 ROM / 分屏 / 模拟器上会抛错，
 *    绝不能因为锁方向失败把播放页搞崩（历史上此处异常会冒到 native 线程）。
 *
 * ⚠️ `follow` 用 `unlockAsync()` 而不是 `lockAsync(OrientationLock.DEFAULT)`：
 * Android 上 unlock 会把 `requestedOrientation` 置回 UNSPECIFIED，即完全交还系统
 * （尊重用户「旋转锁定」开关）；DEFAULT 在不同版本 expo 模块下语义不一致。
 */
import * as ScreenOrientation from 'expo-screen-orientation';

/** 方向目标：跟随系统 / 锁横屏 / 锁竖屏 */
export type OrientationTarget = 'follow' | 'landscape' | 'portrait';

/** 纯函数：宽度大于高度即为横屏（与 `useIsLandscape` 共用同一判定，便于测试） */
export function isLandscapeSize(width: number, height: number): boolean {
  return Number(width) > Number(height);
}

/** 跟随系统方向自动旋转（交还系统；App 默认策略） */
export function followSystem(): void {
  try {
    ScreenOrientation.unlockAsync().catch(() => {});
  } catch { /* 忽略：方向锁定失败不应影响业务 */ }
}

/** 锁定横屏（播放器全屏等"内容本身是宽的"场景） */
export function lockLandscape(): void {
  try {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
  } catch { /* ignore */ }
}

/** 锁定竖屏（表单页等强制竖屏的例外场景） */
export function lockPortrait(): void {
  try {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  } catch { /* ignore */ }
}

/** 按语义目标统一分派（新增调用点请优先用这个） */
export function applyOrientation(target: OrientationTarget): void {
  if (target === 'landscape') lockLandscape();
  else if (target === 'portrait') lockPortrait();
  else followSystem();
}
