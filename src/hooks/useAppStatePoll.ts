import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * AppState 感知的轮询定时器。
 *
 * - 应用切后台 → **停止**定时器（避免后台空跑，省电省流量；
 *   实测过 App 在后台仍全速轮询同一批接口）
 * - 回到前台 → **立即执行一次**并重启定时器（避免回来看到过期数据，
 *   也修复「启动时网络差失败后一直是错误态、只能手动重试」）
 *
 * 背景：这个模式原先只在 `HomeScreen` 的成员直播轮询里手写过一遍，
 * 其余十余处 `setInterval` 都是后台照跑。统一抽到这里，新增轮询点直接复用。
 *
 * 用 ref 持有回调 → 不会因闭包过期而读到旧 state，调用方也无需把依赖塞进 deps。
 */
export function useAppStatePoll(fn: () => void, intervalMs: number, enabled = true): void {
  // 始终指向最新回调，避免闭包捕获旧值；deps 里只需 intervalMs / enabled
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled || !(intervalMs > 0)) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        // 双保险：即便 AppState 事件因平台差异未送达，也不在后台空跑
        if (AppState.currentState === 'active') fnRef.current();
      }, intervalMs);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        start();
        fnRef.current(); // 回前台立即补一次，避免看到过期数据
      } else {
        stop();
      }
    });

    return () => {
      stop();
      sub.remove();
    };
  }, [intervalMs, enabled]);
}
