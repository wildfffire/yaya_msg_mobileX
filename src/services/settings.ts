import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings } from '../types';
import { logError, logInfo } from '../utils/runtimeLog';

const SETTINGS_KEY = 'yaya_settings';
/** 一次性迁移标记：系统通知默认值从 false 提升为 true（见 loadSettings 里的说明） */
const NOTIFY_MIGRATION_KEY = 'yaya_notify_system_on_v1';
/**
 * 一次性迁移标记 v2（真机 2026-11-10 实证：`[notify] [pm] 跳过：私信通知开关已关` +
 * `[room] 跳过：房间通知开关已关` —— 用户根本没关过）。
 * 与 v1 同根因：旧版把私信/房间通知的默认值固化成 false（saveSettings 整份写回），
 * v1 只迁移了 notify_system_enabled，漏了这三个。只提升一次，之后尊重用户选择。
 */
const NOTIFY_MIGRATION_KEY_V2 = 'yaya_notify_defaults_on_v2';
/**
 * v3（b3000014 真机实测又暴露一层）：免打扰 notify_dnd 也被旧版固化为 true
 *（默认应是 false），同样机制。v3 一并纠正免打扰与房间通知范围。
 */
const NOTIFY_MIGRATION_KEY_V3 = 'yaya_notify_defaults_on_v3';
/**
 * v4（2026-11-10 四轮真机日志实证，b3000016/17）：
 *   `[room] 通知策略：房间开关=false 免打扰=0 范围=all 系统=false 横幅=false`
 *   `[pm] 通知策略：私信开关=false` —— v1/v2/v3 的 marker 都在，但四个开关**又被整份写回固化成 false**，
 *   而免打扰/范围却是 v3 纠正后的值。这不会是用户逐个手动关出来的状态，
 *   是「旧版默认值 + 整份 saveSettings」的残留；结果就是通知决策每一层都判 false，
 *   用户看到的仍然是「消息通知没修好 / 部分新消息不提示」。
 *   只在「四个开关同时为 false」时恢复默认开（用户若真的想全静音，用免打扰或房间范围=无），
 *   一次性执行，之后一律尊重设置页里的手动选择。
 */
const NOTIFY_MIGRATION_KEY_V4 = 'yaya_notify_defaults_on_v4';
let settingsCache: AppSettings | null = null;
let settingsLoadPromise: Promise<AppSettings> | null = null;
let settingsWriteChain: Promise<void> = Promise.resolve();

// 默认设置唯一权威源：store/index.ts 的 useSettingsStore 也从这里取初始值，
// 新增字段只改这一处（此前双源曾漏掉 meet48Auth，导致该字段在 store 有值、持久化默认丢失）。
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  language: 'system',
  p48Token: '',
  bilibiliCookie: '',
  bilibiliUserInfo: null,
  msg_sort_order: 'desc',
  yaya_followed_custom_order: [],
  yaya_music_play_mode: 'sequential',
  yaya_music_volume: 0.7,
  yaya_audio_program_play_mode: 'sequential',
  yaya_auto_checkin_enabled: false,
  yaya_auto_checkin_last_date: '',
  yaya_auto_checkin_last_user: '',
  yaya_trip_show_all: false,
  customBackgroundFile: '',
  customBackgroundUpdatedAt: 0,
  meet48Auth: null,
  pip_auto: false,
  room_avatar_source: 'custom',
  room_list_avatar_source: 'official',
  // 房间列表排序（用户 2026-11-09）：默认「新消息在上」+ 自定义（空序 = 原序），
  // 老用户升级后列表顺序与之前完全一致。
  room_list_unread_first: true,
  room_list_sort: 'custom',
  room_list_custom_order: [],
  // 主题色（PiliPlus 风格）：默认仍是原来的品牌粉，老用户升级后外观不变。
  // 与 src/theme/themeColors.ts 的 DEFAULT_ACCENT_* 保持一致（此处不 import 以免 services → theme → store 成环）。
  accentPreset: 'yaya',
  accentColor: '#FF6F91',
  accentVariant: 'material',
  accentDynamic: false,
  accentDynamicValue: '',
  // 通知（用户 2026-11-09，二轮修正）：系统通知与 App 内横幅**默认都开**。
  // 上一版把系统通知默认关掉，结果「软件外通知」实际上从来没生效过（用户反馈收不到通知）。
  // 现在启动时申请一次 POST_NOTIFICATIONS（Android 13+），用户拒绝后设置页仍有开关与入口；
  // 老用户的旧默认值（false）由 loadSettings 里的一次性迁移提升，见 NOTIFY_MIGRATION_KEY。
  notify_system_enabled: true,
  notify_inapp_enabled: true,
  notify_pm_enabled: true,
  notify_room_enabled: true,
  notify_only_background: true,
  notify_dnd: false,
  notify_room_mode: 'all',
  notify_room_map: {},
  // 背景遮罩/模糊：默认 34 = 旧版导航层写死的 0.34（保持老用户观感不变），模糊默认 0
  bg_dim: 34,
  bg_blur: 0,
};

export async function loadSettings(): Promise<AppSettings> {
  if (settingsCache) return { ...settingsCache };
  if (settingsLoadPromise) return settingsLoadPromise.then((settings) => ({ ...settings }));

  settingsLoadPromise = (async () => {
    let settings = { ...DEFAULT_SETTINGS };
    try {
      const raw = await AsyncStorage.getItem(SETTINGS_KEY);
      if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      /**
       * 一次性迁移（用户 2026-11-09 二轮：「软件外通知收不到」）：
       * 旧版把 notify_system_enabled 默认成 false，而 saveSettings 是**整份**写回 ——
       * 老用户只要改过任意一项设置，这个 false 就被固化下来了，改默认值对他们完全无效。
       * 这里只提升一次（记 marker），之后一律尊重用户在设置页里的选择。
       */
      const migrated = await AsyncStorage.getItem(NOTIFY_MIGRATION_KEY);
      if (!migrated) {
        settings.notify_system_enabled = true;
        // 立刻落盘：只写 marker 不写值的话，用户马上杀进程 → 下次启动 marker 已在、值还是 false
        await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        await AsyncStorage.setItem(NOTIFY_MIGRATION_KEY, '1');
      }
      const migratedV2 = await AsyncStorage.getItem(NOTIFY_MIGRATION_KEY_V2);
      if (!migratedV2) {
        // v2：私信 / 房间 / App 内横幅三个通知开关同样被旧版固化为 false（真机日志实证），
        // 全部提升为默认开，之后设置页里的手动关闭照常生效。
        settings.notify_inapp_enabled = true;
        settings.notify_pm_enabled = true;
        settings.notify_room_enabled = true;
        await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        await AsyncStorage.setItem(NOTIFY_MIGRATION_KEY_V2, '1');
      }
      const migratedV3 = await AsyncStorage.getItem(NOTIFY_MIGRATION_KEY_V3);
      if (!migratedV3) {
        // v3：免打扰被旧版固化为 true（默认 false）、房间通知范围可能被固化为 'none'
        //（默认 'all'）—— b3000014 真机日志实证 `[pm]/[room] 跳过：免打扰开启`。
        settings.notify_dnd = false;
        if (settings.notify_room_mode === 'none') settings.notify_room_mode = 'all';
        await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        await AsyncStorage.setItem(NOTIFY_MIGRATION_KEY_V3, '1');
      }
      const migratedV4 = await AsyncStorage.getItem(NOTIFY_MIGRATION_KEY_V4);
      if (!migratedV4) {
        const allOff = settings.notify_system_enabled === false
          && settings.notify_inapp_enabled === false
          && settings.notify_pm_enabled === false
          && settings.notify_room_enabled === false;
        if (allOff) {
          settings.notify_system_enabled = true;
          settings.notify_inapp_enabled = true;
          settings.notify_pm_enabled = true;
          settings.notify_room_enabled = true;
          await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
          logInfo('[migrate] v4：四个通知开关同时为关（旧版固化残留），已恢复默认开', 'notify');
        }
        // 无论有没有命中都写 marker：以后只尊重设置页里的选择
        await AsyncStorage.setItem(NOTIFY_MIGRATION_KEY_V4, '1');
      }
    } catch (e) {
      logError(e, 'settings.loadSettings');
    }
    settingsCache = settings;
    return { ...settings };
  })();

  try {
    return await settingsLoadPromise;
  } finally {
    settingsLoadPromise = null;
  }
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const operation = settingsWriteChain
    .catch(() => undefined)
    .then(async () => {
      const current = await loadSettings();
      const merged = { ...current, ...settings };
      settingsCache = merged;
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    });
  settingsWriteChain = operation;
  await operation;
}

export async function getSetting<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
  const settings = await loadSettings();
  return settings[key];
}

export async function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
  await saveSettings({ [key]: value });
}

export async function clearSettings(): Promise<void> {
  const operation = settingsWriteChain
    .catch(() => undefined)
    .then(async () => {
      settingsCache = { ...DEFAULT_SETTINGS };
      await AsyncStorage.removeItem(SETTINGS_KEY);
    });
  settingsWriteChain = operation;
  await operation;
}
