/**
 * 通知预设（用户 2026-11-10 选定「C+A」方案）。
 *
 * 背景：设置页原有 8 个 notify_* 字段交叉出「通道 × 消息类型」两个维度，
 * 「房间消息开关」与「房间范围=全部关闭」还能配出互相矛盾的状态。
 * 这里用三个预设把用户认知收敛成一张卡，底层字段与 notifyRules / notificationCenter
 * 全部保持原样 —— 不加迁移、不改决策函数，避免重演「整份写回固化 false」导致通知整场静默。
 *
 * 口径（用户明确）：
 *   · 标准 = 系统通知开、App 内横幅关、私信与房间消息都开；
 *   · 免打扰 = **所有通知关闭**（不是「静音」措辞，是真的全关，后台接收也一起停）；
 *   · 自定义 = 不符合上面两种 preset 的任何配置，逐项调整。
 */
export type NotifyPreset = 'standard' | 'dnd' | 'custom';
export type RoomNotifyModePreset = 'all' | 'custom' | 'none';

export interface NotifyPresetSettings {
  notify_system_enabled?: boolean;
  notify_inapp_enabled?: boolean;
  notify_pm_enabled?: boolean;
  notify_room_enabled?: boolean;
  notify_only_background?: boolean;
  notify_dnd?: boolean;
  notify_room_mode?: RoomNotifyModePreset;
  notify_room_map?: Record<string, boolean>;
}

interface Normalized {
  notify_system_enabled: boolean;
  notify_inapp_enabled: boolean;
  notify_pm_enabled: boolean;
  notify_room_enabled: boolean;
  notify_only_background: boolean;
  notify_dnd: boolean;
  notify_room_mode: RoomNotifyModePreset;
}

/** 标准（推荐）：只走系统通知栏，前台安静；私信与房主房间消息都提醒 */
export const STANDARD_NOTIFY_PATCH: NotifyPresetSettings = {
  notify_system_enabled: true,
  notify_inapp_enabled: false,
  notify_pm_enabled: true,
  notify_room_enabled: true,
  notify_only_background: true,
  notify_dnd: false,
  notify_room_mode: 'all',
};

/** 免打扰 = 所有通知关闭；notifyWanted() 会据此停掉前台服务与后台轮询 */
export const DND_NOTIFY_PATCH: NotifyPresetSettings = {
  notify_system_enabled: false,
  notify_inapp_enabled: false,
  notify_pm_enabled: false,
  notify_room_enabled: false,
  notify_dnd: true,
  notify_room_mode: 'none',
};

/** undefined 视作默认值（与 DEFAULT_SETTINGS / notifyRules 的 `!== false` 判定一致） */
function normalize(s: NotifyPresetSettings): Normalized {
  return {
    notify_system_enabled: s.notify_system_enabled !== false,
    notify_inapp_enabled: s.notify_inapp_enabled !== false,
    notify_pm_enabled: s.notify_pm_enabled !== false,
    notify_room_enabled: s.notify_room_enabled !== false,
    notify_only_background: s.notify_only_background !== false,
    notify_dnd: s.notify_dnd === true,
    notify_room_mode: s.notify_room_mode || 'all',
  };
}

function same(a: Normalized, b: Normalized): boolean {
  return (Object.keys(a) as (keyof Normalized)[]).every((k) => a[k] === b[k]);
}

/** 当前设置属于哪个预设；不改动用户的既有配置（老用户会显示为「自定义」） */
export function deriveNotifyPreset(settings: NotifyPresetSettings): NotifyPreset {
  const cur = normalize(settings);
  // 「免打扰」= 所有通知关闭。判据只看四个通道：用户在高级区逐个关掉也应归一到免打扰，
  // 不依赖 notify_dnd 这个内部字段，也不受 only_background 旧值影响。
  const allOff = !cur.notify_system_enabled && !cur.notify_inapp_enabled
    && !cur.notify_pm_enabled && !cur.notify_room_enabled;
  if (allOff) return 'dnd';
  if (same(cur, normalize(STANDARD_NOTIFY_PATCH))) return 'standard';
  return 'custom';
}

/** 点预设卡要写入的字段；custom 只是展开详细设置，不改配置 */
export function applyNotifyPreset(preset: NotifyPreset): NotifyPresetSettings | null {
  if (preset === 'standard') return { ...STANDARD_NOTIFY_PATCH };
  if (preset === 'dnd') return { ...DND_NOTIFY_PATCH };
  return null;
}

/**
 * 房间范围与「房间消息」开关合并成一个控件后，两者永远同步，
 * 不再出现 `room_enabled=false` 但 `mode='all'` 这种矛盾状态。
 */
export function roomScopePatch(mode: RoomNotifyModePreset): NotifyPresetSettings {
  return {
    notify_room_mode: mode,
    notify_room_enabled: mode !== 'none',
  };
}
