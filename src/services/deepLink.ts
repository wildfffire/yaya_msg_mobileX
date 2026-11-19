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
import { UPDATE_DOWNLOAD_URL, APP_BUILD, APP_VERSION } from '../constants';
import { navigationRef } from '../navigation';
import { useRoomPresenceStore } from '../store/notice';
import { parseDeepLink, buildDeepLink, type DeepLinkTarget } from '../utils/deepLinkRules';
import { logWarn } from '../utils/runtimeLog';
import { useUpdateStore } from '../store';
import { announceUpdateIfNeeded } from './updateNotice';

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
      case 'update':
        /**
         * 新版本通知（用户 2026-11-19）：系统通知栏点按 → 原生模块用 ACTION_VIEW
         * 构造 `yayamsg://update` 回到 MainActivity，这里统一跳自建下载页。
         * ⚠️ 不能直接把 https 地址塞给通知：原生强制 setClass(MainActivity)，
         *    系统不会交给浏览器，App 内也没有对应路由 → 点了没反应。
         */
        Linking.openURL(UPDATE_DOWNLOAD_URL).catch(() => {});
        return true;
      case 'checkupdate':
        /**
         * 强制检查更新（用户 2026-11-19 要求能复测通知）：
         *   adb shell am start -a android.intent.action.VIEW -d "yayamsg://checkupdate" com.yk1z.yayamsg
         * 绕过 6h 限流与「已提醒过」去重，查到新版本立即弹窗 + 系统通知。
         * 加 `?demo=1` 时不依赖线上 Release，直接模拟「本地 build+1」的新版本：
         *   adb shell am start -a android.intent.action.VIEW -d "yayamsg://checkupdate?demo=1" com.yk1z.yayamsg
         * 用于发版前真机验证弹窗/系统通知链路（不会改真实 Release）。
         */
        if (target.demo) {
          const nextBuild = APP_BUILD + 1;
          useUpdateStore.setState({
            hasUpdate: true,
            latestVersion: `v${APP_VERSION} · Build ${nextBuild}`,
            latestTag: `v${APP_VERSION}-b${nextBuild}`,
            latestBuild: nextBuild,
            latestNotes: '这是一条测试更新提醒：用于验证「发现新版本」弹窗与系统通知链路是否正常。',
            latestUrl: UPDATE_DOWNLOAD_URL,
          });
          announceUpdateIfNeeded({ force: true }).catch(() => {});
          return true;
        }
        useUpdateStore.getState().checkUpdate(true)
          .then((has) => (has ? announceUpdateIfNeeded({ force: true }) : null))
          .catch(() => {});
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
