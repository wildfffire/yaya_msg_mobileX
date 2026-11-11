/**
 * 通知中心（用户 2026-11-09）：一条消息进来 → 决定「系统通知栏 / App 内横幅 / 都不发」。
 *
 * 分工：
 *   · 规则判定 → utils/notifyRules（纯函数，单测锁死：开关、房间三态、仅后台、合并）
 *   · 系统通知 → native/YayaNotify（缺模块静默降级）
 *   · 横幅     → store/notice（InAppNoticeBanner 渲染）
 *
 * 关键细节（都是踩过的坑）：
 *   ① **去重**：轮询 / 云信重连重放会把同一批消息喂多次，按 `kind|target|msgId` 去重 10 分钟；
 *   ② **合并**：同一会话 30 秒内的连发合并成一条（正文只留最新，标题补 (N)）——
 *      桌面端 private-message-notifications 与房间通知都是这个口径；
 *   ③ **自己正在看的房间不弹**：presence store 里记着当前房间，跳过；
 *   ④ 权限被拒 / 两个通道都失败时返回 `failed`：调用方**不推进消息游标**，下轮可重试；
 *      成功 / 重复 / 用户主动跳过才允许推进（见 NotifyOutcome）。
 */
import { AppState } from 'react-native';
import { useSettingsStore } from '../store';
import { useNoticeStore, useRoomPresenceStore } from '../store/notice';
import {
  burstText,
  mergeBurst,
  notifyDecision,
  notifyDedupeKey,
  notifyStableId,
  type BurstState,
  type NotifyKind,
} from '../utils/notifyRules';
import { showSystemNotification } from '../native/YayaNotify';
import { logInfo, logWarn } from '../utils/runtimeLog';
import { messageDeepLink } from './deepLink';

export interface NotifyMessageInput {
  kind: NotifyKind;
  /** 私信 = 对方 userId；房间 = 成员 memberId */
  targetId: string;
  /** 消息唯一 id（没有稳定 id 时传「时间+内容」派生的伪 id） */
  msgId: string;
  title: string;
  body: string;
  /** 头像（房间 = 房间列表里的偶像头像；私信 = 对方头像）。系统通知做大图标，横幅做头像位 */
  avatarUrl?: string;
  /** 点击跳转的深链（不传则按 kind/targetId 自动生成） */
  uri?: string;
}

/** 已通知过的消息（10 分钟内不重复） */
const seenAt = new Map<string, number>();
const DEDUPE_TTL_MS = 10 * 60_000;
const DEDUPE_MAX = 400;

/** 每个目标的合并状态（30 秒窗口） */
const bursts = new Map<string, BurstState>();

export function isAppForeground(): boolean {
  return AppState.currentState === 'active';
}

function rememberSeen(key: string, now: number) {
  seenAt.set(key, now);
  if (seenAt.size > DEDUPE_MAX) {
    // 先清过期，仍超限就丢最早的一半（Map 保插入序）
    for (const [k, t] of seenAt) if (now - t > DEDUPE_TTL_MS) seenAt.delete(k);
    if (seenAt.size > DEDUPE_MAX) {
      let drop = Math.floor(seenAt.size / 2);
      for (const k of seenAt.keys()) {
        if (drop <= 0) break;
        seenAt.delete(k);
        drop -= 1;
      }
    }
  }
}

/**
 * 通知结果（2026-11-10 定版）。
 * 轮询层必须据此推进「消息游标」：
 *   · sent / duplicate / skipped → 这条消息已处理，游标可以前进；
 *   · failed（系统通知栏发送失败且没有横幅兜底）→ **不能进游标**，下一轮重试。
 * 旧版无条件先写基线，任何 skip（正在看这个房间 / 开关 / dedupe / 权限被拒）
 * 都会让那条消息永久不再判新 —— 这正是「部分新消息不提示」的头号根因。
 */
export type NotifyOutcome = 'sent' | 'duplicate' | 'skipped' | 'failed';

/** 主入口：来一条新消息（轮询层调用；await 系统通知栏的真实结果） */
export async function notifyMessage(input: NotifyMessageInput): Promise<NotifyOutcome> {
  const settings = useSettingsStore.getState().settings;
  const kind = input.kind;
  const targetId = String(input.targetId || '');
  if (!targetId) return 'skipped';

  const foreground = isAppForeground();
  const decision = notifyDecision({
    dnd: settings.notify_dnd,
    systemEnabled: settings.notify_system_enabled,
    inappEnabled: settings.notify_inapp_enabled,
    pmEnabled: settings.notify_pm_enabled,
    roomEnabled: settings.notify_room_enabled,
    onlyBackground: settings.notify_only_background !== false,
    roomMode: settings.notify_room_mode,
    roomMap: settings.notify_room_map,
    isForeground: foreground,
    kind,
    roomId: targetId,
  });

  // 房间：正在看的那个房间不弹（桌面端口径）
  const inCurrentRoom = kind === 'room' && useRoomPresenceStore.getState().currentRoomId === targetId;
  if (inCurrentRoom && foreground) {
    logInfo(`[skip] ${kind} ${targetId} 正在看这个房间（不打扰）`, 'notify');
    return 'skipped';
  }

  if (!decision.system && !decision.inapp) {
    // 诊断（tag notify）：为什么这条没出去，设置页「运行日志」里一眼能看出来
    logInfo(
      `[skip] ${kind} ${targetId} sys=${decision.system ? 1 : 0} inapp=${decision.inapp ? 1 : 0}`
      + ` 开关(系统=${settings.notify_system_enabled !== false ? 1 : 0} 横幅=${settings.notify_inapp_enabled !== false ? 1 : 0}`
      + ` 仅后台=${settings.notify_only_background !== false ? 1 : 0} 前台=${foreground ? 1 : 0} 免打扰=${settings.notify_dnd ? 1 : 0})`,
      'notify',
    );
    return 'skipped';
  }

  const now = Date.now();
  const dedupeKey = notifyDedupeKey(kind, targetId, input.msgId);
  if (dedupeKey) {
    const at = seenAt.get(dedupeKey);
    // 去重命中 = 已经通知过（或上一轮刚发过），游标可以推进
    if (at && now - at < DEDUPE_TTL_MS) return 'duplicate';
  }

  const burstKey = `${kind}|${targetId}`;
  const merged = mergeBurst(bursts.get(burstKey), { title: input.title, body: input.body }, now);
  bursts.set(burstKey, merged);
  const uri = input.uri || messageDeepLink(kind, targetId, kind === 'pm' ? input.title : undefined);

  let inappOk = false;
  let systemOk = false;
  if (decision.inapp) {
    // 横幅自身会按 30s 窗口合并（只更新文案 + 计数），这里传原文案
    useNoticeStore.getState().push({
      key: burstKey, kind, title: input.title, body: input.body, uri, avatarUrl: input.avatarUrl,
    });
    inappOk = true;
  }
  if (decision.system) {
    const text = burstText(merged);
    // ★ 必须等原生结果：权限没给 / 模块缺失时不能把这批消息记成「已通知」
    systemOk = await showSystemNotification({
      id: notifyStableId(kind, targetId),
      title: text.title,
      body: text.body,
      uri,
      avatarUrl: input.avatarUrl || '',
    });
    if (!systemOk) {
      logWarn(`[sys] 通知栏发送失败（权限未授予或系统关闭），kind=${kind} target=${targetId}`, 'notify');
    }
  }
  if (!inappOk && !systemOk) {
    logWarn(`[fail] ${kind} ${targetId} 两个通道都没发出去，游标不推进（下轮重试）`, 'notify');
    return 'failed';
  }
  // ★ 去重只在「确实发出去」之后才记，失败可重试
  if (dedupeKey) rememberSeen(dedupeKey, now);
  logInfo(
    `[sent] ${kind} ${targetId} sys=${systemOk ? 1 : 0} inapp=${inappOk ? 1 : 0} 前台=${foreground ? 1 : 0}`,
    'notify',
  );
  return 'sent';
}
