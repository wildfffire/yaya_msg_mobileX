import { Alert, AppState, PermissionsAndroid, Platform } from 'react-native';
import { translate } from '../i18n';
import {
  openSystemNotificationSettings,
  startMessageKeepAlive,
  stopMessageKeepAlive,
  systemNotificationsEnabled,
} from '../native/YayaNotify';
import { logInfo, logWarn } from './runtimeLog';
import { shouldKeepMessageAlive, type KeepAlivePolicy } from './notifyRules';

/** Android 版本号（Platform.Version 在 Android 上是 number） */
function androidSdk(): number {
  return Platform.OS === 'android' ? Number(Platform.Version) || 0 : 0;
}

const LOG_TAG = 'notify';
/** 引导弹窗的冷却：一次没处理，10 分钟内不反复打扰；回前台仍会重新检测状态 */
const PROMPT_COOLDOWN_MS = 10 * 60_000;

/**
 * Android 13+ 的 POST_NOTIFICATIONS 运行时权限。
 * 先 check 再 request：已授权时不再弹框；勾了「不再询问」由上层引导去系统设置。
 * ⚠️ Android 12 及以下**没有**这个运行时权限概念，系统永远不会弹权限框 ——
 *    这些机型只能靠 App 内主动引导到「系统通知设置」（见 ensureNotificationPermissionOnce）。
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || androidSdk() < 33) return true;
  try {
    const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(perm)) return true;
    const result = await PermissionsAndroid.request(perm);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch (e: any) {
    logWarn(`[perm] POST_NOTIFICATIONS 申请异常：${String(e?.message || e || '')}`, LOG_TAG);
    return false;
  }
}

export interface NotificationCheckResult {
  /** 系统通知栏现在真的能发出通知（总开关 + 运行时权限 + 渠道未被关） */
  enabled: boolean;
  sdk: number;
}

/**
 * 检测系统通知是否可用；Android 13+ 未授权时默认顺手申请一次。
 * `requestPermission: false` 用于「用户已关通知」的静默复查：连系统权限框都不弹。
 */
export async function checkNotificationPermission(
  options: { requestPermission?: boolean } = {},
): Promise<NotificationCheckResult> {
  const sdk = androidSdk();
  if (Platform.OS !== 'android') return { enabled: false, sdk };
  let enabled = await systemNotificationsEnabled();
  if (!enabled && sdk >= 33 && options.requestPermission !== false) {
    const granted = await ensureNotificationPermission();
    logInfo(`[perm] POST_NOTIFICATIONS 申请结果=${granted ? '已授予' : '未授予'} sdk=${sdk}`, LOG_TAG);
    if (granted) enabled = await systemNotificationsEnabled();
  }
  return { enabled, sdk };
}

function promptSystemNotificationSettings() {
  try {
    Alert.alert(
      translate('允许消息通知'),
      translate('请在系统设置里开启「允许通知」并允许后台运行，退出 App 后才能收到新消息。'),
      [
        { text: translate('稍后'), style: 'cancel' },
        { text: translate('去开启'), onPress: () => openSystemNotificationSettings() },
      ],
      { cancelable: true },
    );
  } catch { /* 老包缺原生模块 / Activity 未就绪：不阻塞启动 */ }
}

let startupReady = false;
let lastPromptAt = 0;
let checkInFlight: Promise<boolean> | null = null;

/**
 * 启动/回前台时的一次性检查（用户「也不问我要权限」的正面修复）。
 *
 * 与旧版的三点差别：
 *   ① 不再只看 `PermissionsAndroid`：以原生 `areEnabled()`（系统总开关 + 渠道状态）为准；
 *   ② 检查未通过时**主动在 App 内弹一次引导**，Android 12 这类不会弹系统权限框的机型也会「被问到」；
 *   ③ 只有确认可用才置 `startupReady`，失败不再被一次性短路 —— 回前台会重新检测、必要时重试。
 *
 * `allowPrompt: false` 用于回前台的静默复查（用户刚从系统设置回来时不重复弹框）。
 */
export async function ensureNotificationPermissionOnce(
  options: { allowPrompt?: boolean } = {},
): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (startupReady) return true;
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    const { enabled, sdk } = await checkNotificationPermission({
      requestPermission: options.allowPrompt !== false,
    });
    logInfo(
      `[perm] 系统通知=${enabled ? '可用' : '不可用'} sdk=${sdk}`
      + `（${sdk >= 33 ? '有运行时权限' : '无运行时权限概念，需在系统设置里允许通知'}）`,
      LOG_TAG,
    );
    if (enabled) {
      startupReady = true;
      return true;
    }
    if (options.allowPrompt !== false && Date.now() - lastPromptAt >= PROMPT_COOLDOWN_MS) {
      lastPromptAt = Date.now();
      promptSystemNotificationSettings();
    }
    return false;
  })();
  try {
    return await checkInFlight;
  } finally {
    checkInFlight = null;
  }
}

/**
 * 消息保活前台服务的唯一开关入口（2026-11-10 真机实证）。
 *
 * 没有 FCM，App 退到后台后国产 ROM 会把整个进程冻结：JS 的 5s 轮询 20~35s 零日志，
 * 新消息根本没被拉回来，权限再全也发不出「软件外通知」。前台服务把进程提到前台优先级，
 * 让轮询继续跑。⚠️ 只能在 App 前台调用（Android 12+ 禁止后台启动前台服务）。
 */
export async function syncMessageKeepAlive(wanted: boolean): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (!wanted) {
    stopMessageKeepAlive();
    logInfo('[perm] 已关闭后台（保活服务 + 后台轮询都停），不耗电', LOG_TAG);
    return false;
  }
  const ok = await startMessageKeepAlive();
  logInfo(`[perm] 消息保活前台服务${ok ? '已启动（后台轮询不会被冻结）' : '启动失败（可能被系统限制）'}`, LOG_TAG);
  return ok;
}

export interface NotifySettingsLike {
  notify_system_enabled?: boolean;
  notify_dnd?: boolean;
  notify_pm_enabled?: boolean;
  notify_room_enabled?: boolean;
  notify_room_mode?: string;
}

/**
 * 「关通知 = 关后台」的唯一权威判定（用户 2026-11-10 明确要求）。
 * 系统栏关 / 免打扰 / 私信与房间全关 → 不再需要软件外通知，前台服务与后台轮询一并停。
 */
export function notifyWanted(settings: NotifySettingsLike): boolean {
  return shouldKeepMessageAlive({
    systemEnabled: settings.notify_system_enabled,
    dnd: settings.notify_dnd,
    pmEnabled: settings.notify_pm_enabled,
    roomEnabled: settings.notify_room_enabled,
    roomMode: (settings.notify_room_mode as KeepAlivePolicy['roomMode']) || 'all',
  });
}

/**
 * 设置变更后统一重算：App 启动、前后台切换、设置页任何通知开关都走这里。
 *
 * ★ 用户 2026-11-10 明确不要通知栏常驻那条「消息接收中」。Android 规定前台服务
 *   必须挂一条通知，无法既保活又完全无通知 —— 所以改成**只在退到后台时启动**：
 *   前台立即停（通知消失），后台才拉起服务跑轮询发通知。
 */
export function syncMessageKeepAliveForSettings(settings: NotifySettingsLike): Promise<boolean> {
  const wanted = notifyWanted(settings);
  const foreground = AppState.currentState === 'active';
  return syncMessageKeepAlive(wanted && !foreground);
}
