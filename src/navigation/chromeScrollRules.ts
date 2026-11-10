/**
 * 「滚动收起顶栏与底栏」的纯判定规则（**零依赖**，可纯 Node 单测）。
 *
 * 为什么单独拆出来：2026-09-28 真机连踩两次
 *   ① 「顶栏收起后回不来」—— 根因在动画实现（布局属性进了 worklet），已修；
 *   ② 「拖动中手指停住不放，顶栏一直来回闪」—— 根因就在这个文件要解决的问题，
 *      所以判定逻辑必须能被单测钉死，而不是靠真机反复试。
 *
 * ②的成因是一个**反馈回路**：
 *   收起顶栏 → 列表高度与内容偏移被系统重新计算 → 产生一次反向的偏移变化
 *   → 被方向判定读成「用户往下滚了」→ 展开 → 又变回去 → 无限循环。
 *   真机上表现为「手指不动，顶栏持续出现/消失」。
 *
 * 因此判定分三层（顺序即优先级）：
 *   1) **静默期**：任何一次翻转后的 COOLDOWN_MS 内，只更新基准、不做判定 ——
 *      因为刚翻转完的偏移变化多半是我们自己布局变化的回声；
 *   2) **顶部保护区**：滚到 ≤ TOP_ZONE 无条件显示（保证「拉回最顶」一定拿得回）；
 *   3) **方向 + 滞回**：每帧位移要超过 DIR_THRESHOLD，且相对上次翻转点的**净位移**
 *      要超过 FLIP_MIN_DELTA —— 手指停住时的回弹抖动不足以翻转。
 */

/** 抖动过滤（px）：单帧位移小于它视作手指抖动，忽略 */
export const DIR_THRESHOLD = 8;
/** 顶部保护区（px）：滚到这里无条件显示顶栏与底栏 */
export const TOP_ZONE = 12;
/** 滞回（px）：相对「上次翻转点」的净位移要够大才允许再翻转 */
export const FLIP_MIN_DELTA = 24;
/** 静默期（ms）：翻转后这段时间内不做判定，用于吸收布局变化带来的偏移回声 */
export const COOLDOWN_MS = 320;

export type ChromeScrollState = {
  /** 当前是否收起 */
  hidden: boolean;
  /** 上一次事件的偏移量 */
  lastY: number;
  /** 上一次「翻转」发生时的偏移量（滞回基准） */
  anchorY: number;
  /** 上一次「翻转」的时间戳（ms，静默期基准） */
  lastFlipAt: number;
};

export const initialChromeScrollState: ChromeScrollState = {
  hidden: false,
  lastY: 0,
  anchorY: 0,
  // 0 表示「从未翻转」：now - 0 一定大于静默期，所以初始不会凭空进入静默
  lastFlipAt: 0,
};

/**
 * 处理一次滚动事件，返回新状态。
 * `now` 由调用方传入（而不是内部取 Date.now），这样测试可以完全确定性地驱动时间。
 */
export function stepChromeScroll(state: ChromeScrollState, y: number, now: number): ChromeScrollState {
  const dy = y - state.lastY;

  // 1) 静默期：只更新基准。⚠️ 顶部保护区也一并跳过 ——
  //    否则「回声把 y 打到 0」会再触发一次显示，等于绕过了这道锁。
  if (now - state.lastFlipAt < COOLDOWN_MS) return { ...state, lastY: y };

  // 2) 顶部保护区：无条件显示
  if (y <= TOP_ZONE) {
    if (state.hidden) return { hidden: false, lastY: y, anchorY: y, lastFlipAt: now };
    return { ...state, lastY: y };
  }

  // 3) 滞回：净位移不够大，保持原状（手指停住时的回弹不该让顶栏来回闪）
  if (Math.abs(y - state.anchorY) < FLIP_MIN_DELTA) return { ...state, lastY: y };

  if (dy > DIR_THRESHOLD) return { hidden: true, lastY: y, anchorY: y, lastFlipAt: now };
  if (dy < -DIR_THRESHOLD) return { hidden: false, lastY: y, anchorY: y, lastFlipAt: now };
  return { ...state, lastY: y };
}
