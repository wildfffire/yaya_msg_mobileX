/**
 * 图片翻页判定（纯规则，零 React / 零依赖）。
 *
 * 为什么单独成文件（用户 2026-11-04：「图片播放的逻辑能不能复用房间里的，加个自动轮播就行」）：
 *   房间成员图片的全屏查看器（`components/ZoomImageModal`）已经有一套调好的翻页手感 ——
 *   位移 + 速度惯性预测（`projected = dx + vx × 110ms`）、12% 屏宽阈值、24px 最小真实位移。
 *   电台直播的照片轮播必须用**同一套口径**，否则「房间里好滑、播放器里滑不动」。
 *   判定抽到这里后，两处都只调 `decidePagerSwipe`（纯函数，可单测）。
 */

/** 松手时位移小于它 = 抖动/点击，不算翻页 */
export const MIN_DRAG_PX = 24;
/** 速度惯性预测窗口（毫秒）：手工调过的手感值，与房间查看器一致 */
export const PROJECTION_MS = 110;
/** 需要拖过屏宽的这个比例（结合速度预测）才翻页 */
export const PAGE_RATIO = 0.12;

export type PagerSwipeResult = 'prev' | 'next' | 'settle';

export interface PagerSwipeInput {
  /** 本次手势总位移（右为正、左为负） */
  dx: number;
  /** 松手时的水平速度（px/ms，右为正） */
  vx?: number;
  /** 一屏宽度（px） */
  width: number;
  /** 是否允许往上一张（非循环模式用；循环时不看） */
  canPrev?: boolean;
  /** 是否允许往下一张 */
  canNext?: boolean;
  /** 循环轮播：首尾相接，永远允许翻页 */
  loop?: boolean;
}

/**
 * 返回：
 *   - `'next'`：翻到下一张（左滑）；
 *   - `'prev'`：翻到上一张（右滑）；
 *   - `'settle'`：回弹到当前页（位移太小 / 速度不够 / 已到边界）。
 */
export function decidePagerSwipe({ dx, vx = 0, width, canPrev, canNext, loop }: PagerSwipeInput): PagerSwipeResult {
  const pageWidth = Number(width) || 0;
  if (!(pageWidth > 0)) return 'settle';
  if (Math.abs(Number(dx) || 0) < MIN_DRAG_PX) return 'settle';

  const projected = Math.abs(Number(dx) + (Number(vx) || 0) * PROJECTION_MS);
  if (projected < pageWidth * PAGE_RATIO) return 'settle';

  const wantNext = Number(dx) < 0;
  if (!loop) {
    if (wantNext && canNext === false) return 'settle';
    if (!wantNext && canPrev === false) return 'settle';
  }
  return wantNext ? 'next' : 'prev';
}
