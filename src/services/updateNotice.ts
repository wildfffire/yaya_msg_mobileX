/**
 * 「发现新版本」主动提醒（用户 2026-11-19：发 release 之后，老用户要收到通知）。
 *
 * 没有 FCM/推送通道，能做到的是「用户打开 App 时」通知到：
 *   ① App 内弹窗（最强：版本号 + Build + 更新说明 + 立即下载）；
 *   ② 系统通知栏一条（用户刚退到后台也能看到，点按打开下载页）。
 *
 * 去重：同一个 release 只提醒一次（持久化 build 号；老 tag 没构建号时按 tag）。
 * 通知开关沿用用户已有设置中「系统通知」的权限状态 —— 权限被拒时系统通知静默失败，
 * App 内弹窗仍在，不会出现「什么都没看到」。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { showSystemNotification } from '../native/YayaNotify';
import { useUpdateStore } from '../store';
import { translate } from '../i18n';
import { logInfo, logWarn } from '../utils/runtimeLog';
import { releaseLabel } from '../utils/updateRules';
import { buildDeepLink } from '../utils/deepLinkRules';

const LOG_TAG = 'update';
/** 已提醒过的版本：{ build, tag }（build=0 的老 tag 用 tag 判重） */
const NOTIFIED_KEY = 'yaya_update_notified_v1';
/** 系统通知 id：与消息通知（notifyStableId 的哈希区间）保持区分 */
const UPDATE_NOTIFY_ID = 990001;

let announcing = false;

interface NotifiedState {
  build: number;
  tag: string;
}

async function readNotified(): Promise<NotifiedState> {
  try {
    const raw = await AsyncStorage.getItem(NOTIFIED_KEY);
    if (!raw) return { build: 0, tag: '' };
    const data = JSON.parse(raw);
    return { build: Number(data?.build) || 0, tag: String(data?.tag || '') };
  } catch {
    return { build: 0, tag: '' };
  }
}

/** 这个 release 是否已经提醒过（按构建号优先，其次 tag） */
export function shouldAnnounceUpdate(
  notified: NotifiedState,
  latest: { build: number; tag: string },
): boolean {
  if (!latest.tag && !latest.build) return false;
  if (latest.build > 0) return notified.build < latest.build;
  return notified.tag !== latest.tag;
}

/**
 * 检测到更新后调用：弹窗 + 系统通知，同一个版本只做一次。
 * 返回是否真的提醒了（已提醒/无更新/并发调用 → false）。
 */
export async function announceUpdateIfNeeded(): Promise<boolean> {
  const state = useUpdateStore.getState();
  if (!state.hasUpdate || !state.latestUrl) return false;
  if (announcing) return false;
  announcing = true;
  try {
    const notified = await readNotified();
    const latest = { build: state.latestBuild, tag: state.latestTag };
    if (!shouldAnnounceUpdate(notified, latest)) {
      logInfo(`[update] 已是提醒过的版本 tag=${latest.tag} build=${latest.build}`, LOG_TAG);
      return false;
    }

    const label = releaseLabel(latest.tag) || state.latestVersion;
    // ① App 内弹窗：版本号 + Build + 更新说明摘要 + 立即下载
    useUpdateStore.setState({ promptVisible: true });
    // ② 系统通知栏：失败（Android 13+ 未授权/系统关闭）静默，弹窗仍可见
    const pushed = await showSystemNotification({
      id: UPDATE_NOTIFY_ID,
      title: translate('发现新版本'),
      body: `${label} ${translate('已发布，点按前往下载')}`,
      uri: buildDeepLink({ type: 'update' }),
    });
    if (!pushed) logWarn('[update] 系统通知栏未发出（权限/开关），App 内弹窗仍会展示', LOG_TAG);

    await AsyncStorage.setItem(NOTIFIED_KEY, JSON.stringify(latest)).catch(() => {});
    logInfo(`[update] 已提醒新版本 tag=${latest.tag} build=${latest.build} 系统通知=${pushed ? 1 : 0}`, LOG_TAG);
    return true;
  } finally {
    announcing = false;
  }
}
