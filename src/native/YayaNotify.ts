/**
 * 系统通知栏（软件外通知）的 JS 入口（用户 2026-11-09）。
 *
 * 原生实现：android/app/src/main/java/com/yk1z/yayamsg/YayaNotifyModule.kt（"YayaNotify"）。
 * ⚠️ 这里必须**容错**：老包/未重编的包里没有该模块，任何调用都要静默降级，
 *    绝不能因为缺模块让「发消息/收消息」链路抛错。
 */
import { NativeModules, Platform } from 'react-native';

interface NativeNotify {
  show(id: number, title: string, body: string, uri: string, avatarUrl: string): Promise<boolean>;
  cancel(id: number): void;
  cancelAll(): void;
  areEnabled(): Promise<boolean>;
  openSettings(): void;
  startKeepAlive(): Promise<boolean>;
  stopKeepAlive(): void;
  openAppSettings(): void;
}

const native: NativeNotify | undefined = Platform.OS === 'android'
  ? (NativeModules as any).YayaNotify
  : undefined;

export function hasSystemNotify(): boolean {
  return !!native;
}

/** 发一条系统通知；返回是否真的发出去了（权限被拒/无模块 = false） */
export async function showSystemNotification(input: {
  id: number;
  title: string;
  body: string;
  uri: string;
  /** 偶像头像（房间列表那张）：原生下载后作为通知大图标 */
  avatarUrl?: string;
}): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.show(input.id, input.title, input.body, input.uri, input.avatarUrl || '');
  } catch {
    return false;
  }
}

export function cancelSystemNotification(id: number) {
  try { native?.cancel(id); } catch { /* ignore */ }
}

export function cancelAllSystemNotifications() {
  try { native?.cancelAll(); } catch { /* ignore */ }
}

export async function systemNotificationsEnabled(): Promise<boolean> {
  if (!native) return false;
  try { return await native.areEnabled(); } catch { return false; }
}

export function openSystemNotificationSettings() {
  try { native?.openSettings(); } catch { /* ignore */ }
}

/**
 * 消息保活前台服务（2026-11-10 真机实证）：
 * App 一切后台，国产 ROM 会把进程整个冻结，JS 的 5s 轮询零日志 → 软件外通知不可能发出。
 * 服务只把进程提到前台优先级（静默常驻通知），不联网、不轮询。
 * ⚠️ Android 12+ 禁止从后台启动前台服务，只能在 App 前台 / 刚回前台时调用。
 */
export async function startMessageKeepAlive(): Promise<boolean> {
  if (!native) return false;
  try { return await native.startKeepAlive(); } catch { return false; }
}

export function stopMessageKeepAlive() {
  try { native?.stopKeepAlive(); } catch { /* ignore */ }
}

/** App 详情：电池优化 / 自启动 / 后台活动（国产 ROM 的额外门槛） */
export function openAppNotificationSettings() {
  try { native?.openAppSettings(); } catch { /* ignore */ }
}
