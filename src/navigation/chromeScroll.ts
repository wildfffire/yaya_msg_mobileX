/**
 * 「滚动收起顶栏与底栏」的驱动逻辑。
 *
 * 需求（用户 2026-09-28）：四个主页面**向上滚动**时，顶栏和底部切换栏一起收起；
 * **向下滚回**时再出现（iOS 原生 App 的常见行为）。
 *
 * 用法 —— 把 `chromeScrollProps` 铺给页面的**主滚动容器**即可（ScrollView / FlatList /
 * 项目自有的 PerfFlatList 都行）：
 *
 *   import { chromeScrollProps } from '../navigation/chromeScroll';
 *   <ScrollView {...chromeScrollProps} …>
 *
 * 为什么不是 hook：
 *   这几个主页面都存在「提前 return」（未登录/加载中先返回别的界面），
 *   在它们中间插 hook 有踩到「条件调用 hook」的风险；而这里本来也不需要 React 状态
 *   —— 需要的只是「跨事件保存上一次偏移量」。所以做成**模块级状态 + 稳定 props 对象**：
 *     1) 无 hook → 调用点怎么放都安全；
 *     2) props 对象引用恒定 → 列表不会因为回调变化而重渲染（长列表很在意这点）。
 *
 * 为什么用「方向 + 双阈值」而不是「位置」：
 *   - 位置判定（滚过某条线就收起）在长列表里会让底栏几乎永远在外面，用户找不到切页入口；
 *   - 8px 抖动阈值过滤手指微动，避免收起到一半来回闪；
 *   - 顶部 12px 内强制显示：保证「拉回最上面」一定能拿回顶栏和底栏。
 *
 * 状态写在 useUiStore（不是各页面本地 state）：底栏在导航层、顶栏在各页面的 ScreenHeader，
 * 两者互不知情，只有共享状态能同时收起它们；store 已做「同值不通知」，
 * 所以滚动事件再密集也只在**方向真正翻转**时引起两次小组件重渲染。
 */
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useUiStore } from '../store';
import {
  initialChromeScrollState,
  stepChromeScroll,
  type ChromeScrollState,
} from './chromeScrollRules';

/** 判定状态（上次偏移 / 滞回基准 / 静默期基准）：模块级，切页时由 resetChromeScroll 清零 */
let scrollState: ChromeScrollState = initialChromeScrollState;

// 注：曾为「拖动列表行」加过一个 setChromeScrollSuppressed（拖动期间冻结收起）。
// 拖拽排序功能已按用户要求（2026-09-28）整体回退，这个开关也一并移除。

function onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
  const y = event.nativeEvent.contentOffset.y;
  const store = useUiStore.getState();
  // 判定全在 chromeScrollRules（零依赖，可单测：scripts/chrome-scroll.test.mjs）。
  // ⚠️ 用 store 的真值覆盖 state.hidden：模块状态与真实状态必须一致
  //（别处可能复位过；不一致会造成「明明已展开却又被判成要收起」）。
  const next = stepChromeScroll({ ...scrollState, hidden: store.chromeHiddenByScroll }, y, Date.now());
  scrollState = next;
  if (next.hidden !== store.chromeHiddenByScroll) store.setChromeHiddenByScroll(next.hidden);
}

/** 铺给主滚动容器：引用恒定，直接 `{...chromeScrollProps}` */
export const chromeScrollProps = { onScroll, scrollEventThrottle: 16 };

/**
 * 复位（页面焦点变化时调用）。
 * 必须做：这是全局状态，不复位的话「在主页收起 → 切到设置」会看到设置页顶栏凭空缺失、
 * 底栏也不见；同时把 lastY 清零，避免上一个页面残留的偏移量让新页面第一次滚动方向判错。
 */
export function resetChromeScroll() {
  scrollState = initialChromeScrollState;
  useUiStore.getState().setChromeHiddenByScroll(false);
}
