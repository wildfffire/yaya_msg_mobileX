/**
 * 深链服务（用户 2026-11-09）：`yayamsg://member/123` 等 → 导航。
 *
 * 两个入口：
 *   · 系统级：Linking（Android intent-filter 见 AndroidManifest 的 MainActivity）
 *   · 系统通知点击：原生模块用 ACTION_VIEW 构造同样的 URI，走同一条 Linking 事件
 *
 * 解析规则在 utils/deepLinkRules（纯函数 + 单测），这里只负责「跳」。
 */
import { Linking } from 'react-native';
import { navigationRef } from '../navigation';
import { useRoomPresenceStore } from '../store/notice';
import { parseDeepLink, buildDeepLink, type DeepLinkTarget } from '../utils/deepLinkRules';
import { logWarn } from '../utils/runtimeLog';

/** 执行跳转；返回是否成功（导航未就绪时 false，调用方可稍后重试） */
export function navigateDeepLink(target: DeepLinkTarget): boolean {
  if (!target) return false;
  if (!navigationRef.isReady()) return false;
  try {
    switch (target.type) {
      case 'member':
        navigationRef.navigate('ProfileScreen', { memberId: target.id });
        return true;
      case 'invoice':
        navigationRef.navigate('InvoiceScreen');
        return true;
      case 'pm':
        navigationRef.navigate('PrivateMessagesScreen', { targetUserId: target.id, targetName: target.name || '' });
        return true;
      case 'video':
        navigationRef.navigate('Main', {
          screen: 'Media',
          params: { mode: 'vod', playLiveId: target.id, playTitle: target.title || '', playNonce: Date.now() },
        } as any);
        return true;
      case 'room':
        // 房间页在 Tab 里：先把目标写进 presence store（房间页消费后自进房）
        useRoomPresenceStore.getState().requestRoom(target.id);
        navigationRef.navigate('Main', { screen: 'Rooms' } as any);
        return true;
      default:
        return false;
    }
  } catch (error: any) {
    logWarn(`[deeplink] 跳转失败：${error?.message || String(error)}`, 'app');
    return false;
  }
}

export function openDeepLink(url: unknown): boolean {
  return navigateDeepLink(parseDeepLink(url));
}

/** 生成消息通知用的深链（私信 → 会话；房间 → 房间） */
export function messageDeepLink(kind: 'pm' | 'room', id: string, name?: string): string {
  return kind === 'pm'
    ? buildDeepLink({ type: 'pm', id, name })
    : buildDeepLink({ type: 'room', id });
}

/**
 * 挂上系统深链监听（App 启动时调用一次）。
 * 返回卸载函数（App 不会卸载，但保留以对齐其它 init 函数的写法）。
 */
export function initDeepLink(): () => void {
  let disposed = false;
  let pending: string | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  const handle = (url?: string | null) => {
    if (!url) return;
    const target = parseDeepLink(url);
    if (!target) return;
    // 冷启动时 NavigationContainer 可能还没就绪：重试几次再放弃
    const attempt = (tries: number) => {
      if (disposed) return;
      if (navigateDeepLink(target)) return;
      if (tries <= 0) {
        logWarn(`[deeplink] 导航未就绪，放弃：${url}`, 'app');
        return;
      }
      readyTimer = setTimeout(() => attempt(tries - 1), 300);
    };
    attempt(10);
  };

  Linking.getInitialURL()
    .then((url) => { pending = url; if (!disposed && url) handle(url); })
    .catch(() => {});

  const sub = Linking.addEventListener('url', (event) => handle(event?.url));

  return () => {
    disposed = true;
    if (readyTimer) clearTimeout(readyTimer);
    pending = null;
    sub.remove();
  };
}
