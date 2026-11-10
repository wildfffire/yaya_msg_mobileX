/**
 * 通知设置面板（用户 2026-11-10 选定「C+A」）。
 *
 * 信息架构：
 *   ① 三张预设卡：标准 / 免打扰（=所有通知关闭）/ 自定义；
 *   ② 状态卡：后台接收运行中/已停止 + 系统通知未授权时的一键入口；
 *   ③ 折叠的「自定义详细设置」：提醒方式 / 提醒内容 / 诊断与系统权限。
 *
 * 底层字段与 notifyRules / notificationCenter 完全不动：
 *   · 预设只是把一组字段一次性写回，改任何开关后 derive 自动变成「自定义」；
 *   · 房间「开关」与「范围三态」合并成一个控件（roomScopePatch 保证两者同步）；
 *   · 原来的单列「免打扰」开关已删除 —— 预设名就是免打扰，语义=所有通知关闭，
 *     不再有第二个同名开关制造歧义。
 *
 * ⚠️ 关通知 = 关后台：任何 update() 都经 syncMessageKeepAliveForSettings(st) 与
 *    syncPollerBackgroundPolicy() 重算，判定只有 notifyWanted() 一处。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import pocketApi from '../api/pocket48';
import { useMemberStore, useSettingsStore } from '../store';
import { saveSettings } from '../services/settings';
import { useI18n } from '../i18n';
import { usePalette } from '../theme';
import {
  openAppNotificationSettings,
  openSystemNotificationSettings,
  showSystemNotification,
  systemNotificationsEnabled,
} from '../native/YayaNotify';
import {
  checkNotificationPermission,
  syncMessageKeepAliveForSettings,
} from '../utils/notifications';
import {
  applyNotifyPreset,
  deriveNotifyPreset,
  roomScopePatch,
  type NotifyPreset,
  type RoomNotifyModePreset,
} from '../utils/notifyPresets';
import { unwrapList } from '../utils/data';
import { resetPollerBaselines, syncPollerBackgroundPolicy } from '../services/messagePollers';

/** 单行开关（定义在组件外：避免每次渲染换组件类型 → Switch 被卸载重建） */
function Row({ title, hint, value, onChange, disabled }: {
  title: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const palette = usePalette();
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.rowTitle, { color: disabled ? palette.labelTertiary : palette.label }]}>{title}</Text>
        {hint ? <Text style={[styles.rowHint, { color: palette.labelTertiary }]}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        thumbColor={value ? palette.tint : palette.onTint}
        trackColor={{ false: palette.fill2, true: palette.tint }}
      />
    </View>
  );
}

const PRESETS: { key: NotifyPreset; label: string; desc: string }[] = [
  { key: 'standard', label: '标准', desc: '标准：系统通知开启，App 内不弹横幅；前台不提醒，退出 App 后走系统通知栏' },
  { key: 'dnd', label: '免打扰', desc: '免打扰：所有通知关闭，后台接收也会一起停止' },
  { key: 'custom', label: '自定义', desc: '自定义：当前配置与预设不同，可继续逐项调整' },
];

export function NotifySettingsPanel() {
  const palette = usePalette();
  const { t } = useI18n();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const members = useMemberStore((s) => s.members);

  const [permission, setPermission] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() => deriveNotifyPreset(settings) === 'custom');
  /**
   * 用户显式点了「自定义」→ 卡片必须亮，哪怕当前字段恰好还符合某个预设。
   * 只在点其他预设时清除；在高级区改任何开关也会置 true（见 update）。
   */
  const [customPicked, setCustomPicked] = useState(() => deriveNotifyPreset(settings) === 'custom');
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [roomLoading, setRoomLoading] = useState(false);

  const preset: NotifyPreset = customPicked ? 'custom' : deriveNotifyPreset(settings);
  const roomMode: RoomNotifyModePreset = (settings.notify_room_mode || 'all') as RoomNotifyModePreset;
  const roomMap = settings.notify_room_map || {};

  const update = useCallback((patch: Parameters<typeof setSettings>[0]) => {
    // 在高级区动任何一项都算自定义（预设卡点击会在之后把标记清回去）
    setCustomPicked(true);
    setSettings(patch);
    void saveSettings(patch as any);
    resetPollerBaselines();
    // ★ 关通知 = 关后台：任何通知开关变化后，按合并后的设置重算保活服务与后台轮询
    const st = useSettingsStore.getState().settings;
    void syncMessageKeepAliveForSettings(st);
    syncPollerBackgroundPolicy();
  }, [setSettings]);

  const choosePreset = useCallback((key: NotifyPreset) => {
    if (key === 'custom') {
      // 只展开详细设置、不改配置，但卡片要立刻亮起（用户 2026-11-10 反馈）
      setCustomPicked(true);
      setAdvancedOpen(true);
      return;
    }
    const patch = applyNotifyPreset(key);
    if (patch) update(patch);
    // update 内部会置 true，这里再清回，保证卡片跟随点击的预设
    setCustomPicked(false);
    setAdvancedOpen(false);
  }, [update]);

  useEffect(() => {
    let alive = true;
    void systemNotificationsEnabled().then((ok) => { if (alive) setPermission(ok); });
    return () => { alive = false; };
  }, [settings.notify_system_enabled]);

  /**
   * 一键验证系统通知栏真的能弹：渠道被降级时原生 show() 会重建渠道。
   * 带一个成员头像，方便直接确认「大图标 + 名字加粗」的样式。
   */
  const sendTest = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    const sampleAvatar = String((members as any[]).find((m) => m?.avatar)?.avatar || '');
    const ok = await showSystemNotification({
      id: 1999999001,
      title: t('通知测试'),
      body: t('看到这条通知说明软件外通知已可用。'),
      uri: 'yayamsg://home',
      avatarUrl: sampleAvatar,
    });
    setTesting(false);
    setPermission(ok);
    if (!ok) openSystemNotificationSettings();
  }, [members, t, testing]);

  const loadRooms = useCallback(async () => {
    if (roomLoading) return;
    setRoomLoading(true);
    try {
      const res: any = await pocketApi.getFollowedIds();
      const ids = unwrapList(res, ['content.data', 'content', 'data', 'list']).map(String);
      setRoomIds(ids);
    } catch {
      setRoomIds([]);
    } finally {
      setRoomLoading(false);
    }
  }, [roomLoading]);

  useEffect(() => {
    if (roomMode === 'custom' && !roomIds.length) void loadRooms();
  }, [roomMode, roomIds.length, loadRooms]);

  const followedRooms = useMemo(
    () => roomIds
      .map((id) => (members as any[]).find((m) => String(m?.id || '') === id))
      .filter(Boolean)
      .slice(0, 80),
    [roomIds, members],
  );

  const activePreset = PRESETS.find((p) => p.key === preset) || PRESETS[2];

  return (
    <View style={{ paddingHorizontal: 14, paddingBottom: 14 }}>
      {/* ① 预设 */}
      <Text style={[styles.group, { color: palette.labelTertiary }]}>{t('预设')}</Text>
      <View style={styles.presetRow}>
        {PRESETS.map((item) => {
          const active = preset === item.key;
          return (
            <TouchableOpacity
              key={item.key}
              onPress={() => choosePreset(item.key)}
              activeOpacity={0.85}
              style={[styles.presetCard, {
                borderColor: active ? palette.tint : palette.hairline,
                backgroundColor: active ? palette.tint : palette.fill2,
              }]}
            >
              <Text style={[styles.presetTitle, { color: active ? palette.onTint : palette.label }]} numberOfLines={1}>
                {t(item.label)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[styles.summary, { color: palette.labelSecondary }]}>{t(activePreset.desc)}</Text>

      {/* ② 只在系统通知未授权时给明确入口（用户 2026-11-10：去掉「消息接收中/后台接收运行中」这类常驻提示） */}
      {permission === false ? (
        <View style={[styles.statusCard, { borderColor: palette.hairline }]}>
          <Text style={{ color: palette.label, fontSize: 12, fontWeight: '600' }}>
            {t('系统里没有授权，点下面去打开')}
          </Text>
          <TouchableOpacity
            style={[styles.linkRow, { borderColor: palette.hairline, marginTop: 6, marginBottom: 0 }]}
            onPress={() => openSystemNotificationSettings()}
            activeOpacity={0.85}
          >
            <MaterialCommunityIcons name="bell-off-outline" size={16} color={palette.tint} />
            <Text style={{ color: palette.tint, fontSize: 12, fontWeight: '700', marginLeft: 6 }}>
              {t('去系统设置里允许通知')}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ③ 高级：自定义详细设置（默认折叠，老用户的自定义配置首次进入即展开） */}
      <TouchableOpacity
        style={[styles.disclosure, { borderColor: palette.hairline }]}
        onPress={() => setAdvancedOpen((v) => !v)}
        activeOpacity={0.85}
      >
        <Text style={{ color: palette.tint, fontSize: 12, fontWeight: '700' }}>
          {t(advancedOpen ? '收起详细设置' : '自定义详细设置')}
        </Text>
        <MaterialCommunityIcons name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={18} color={palette.tint} />
      </TouchableOpacity>

      {advancedOpen ? (
        <View>
          <Text style={[styles.group, { color: palette.labelTertiary, marginTop: 10 }]}>{t('提醒方式')}</Text>
          <Row
            title={t('系统通知栏')}
            hint={permission === false ? t('系统里没有授权，点下面去打开') : t('新消息出现在手机通知栏，点开直达消息')}
            value={settings.notify_system_enabled !== false}
            onChange={(v) => {
              update({ notify_system_enabled: v });
              if (!v) return;
              void checkNotificationPermission().then(({ enabled }) => {
                setPermission(enabled);
                if (!enabled) openSystemNotificationSettings();
              });
            }}
          />
          <Row
            title={t('App 内横幅')}
            hint={t('在页面顶部滑下一条提示，点按直达')}
            value={settings.notify_inapp_enabled !== false}
            onChange={(v) => update({ notify_inapp_enabled: v })}
          />
          <Row
            title={t('仅后台时提醒')}
            hint={t('开着 App 时不弹系统通知栏')}
            value={settings.notify_only_background !== false}
            onChange={(v) => update({ notify_only_background: v })}
            disabled={settings.notify_system_enabled === false}
          />

          <Text style={[styles.group, { color: palette.labelTertiary, marginTop: 12 }]}>{t('提醒内容')}</Text>
          <Row
            title={t('私信消息')}
            value={settings.notify_pm_enabled !== false}
            onChange={(v) => update({ notify_pm_enabled: v })}
          />
          {/* 房间消息开关已并入范围三态：roomScopePatch 保证两者永不矛盾 */}
          <Text style={[styles.group, { color: palette.labelTertiary, marginTop: 6 }]}>{t('房间通知范围')}</Text>
          <View style={styles.chipRow}>
            {([
              { key: 'all', label: t('全部房间') },
              { key: 'custom', label: t('逐房间设置') },
              { key: 'none', label: t('全部关闭') },
            ] as { key: RoomNotifyModePreset; label: string }[]).map((item) => {
              const active = roomMode === item.key;
              return (
                <TouchableOpacity
                  key={item.key}
                  onPress={() => update(roomScopePatch(item.key))}
                  activeOpacity={0.85}
                  style={[styles.chip, { backgroundColor: active ? palette.tint : palette.fill2, borderColor: palette.hairline }]}
                >
                  <Text style={{ color: active ? palette.onTint : palette.labelSecondary, fontSize: 12, fontWeight: '700' }}>
                    {item.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {roomMode === 'custom' ? (
            <View style={[styles.roomList, { borderColor: palette.hairline }]}>
              {roomLoading ? (
                <View style={{ padding: 12, alignItems: 'center' }}><ActivityIndicator size="small" color={palette.tint} /></View>
              ) : followedRooms.length ? followedRooms.map((member: any) => {
                const id = String(member.id || '');
                const on = roomMap[id] !== false;
                return (
                  <View key={id} style={[styles.roomRow, { borderBottomColor: palette.hairline }]}>
                    <Text style={[styles.roomName, { color: palette.label }]} numberOfLines={1}>
                      {member.ownerName || id}
                    </Text>
                    <Switch
                      value={on}
                      onValueChange={(v) => update({ notify_room_map: { ...roomMap, [id]: v } })}
                      thumbColor={on ? palette.tint : palette.onTint}
                      trackColor={{ false: palette.fill2, true: palette.tint }}
                    />
                  </View>
                );
              }) : (
                <Text style={[styles.rowHint, { color: palette.labelTertiary, padding: 12 }]}>{t('还没有关注的房间')}</Text>
              )}
            </View>
          ) : null}

          <Text style={[styles.group, { color: palette.labelTertiary, marginTop: 12 }]}>{t('诊断与系统权限')}</Text>
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.linkRow, { borderColor: palette.hairline, flex: 1 }]}
              onPress={() => { void sendTest(); }}
              disabled={testing}
              activeOpacity={0.85}
            >
              <MaterialCommunityIcons name="bell-ring-outline" size={16} color={palette.tint} />
              <Text style={{ color: palette.tint, fontSize: 12, fontWeight: '700', marginLeft: 6 }} numberOfLines={1}>
                {t('发送测试通知')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.linkRow, { borderColor: palette.hairline, flex: 1 }]}
              onPress={() => openAppNotificationSettings()}
              activeOpacity={0.85}
            >
              <MaterialCommunityIcons name="cog-outline" size={16} color={palette.tint} />
              <Text style={{ color: palette.tint, fontSize: 12, fontWeight: '700', marginLeft: 6 }} numberOfLines={1}>
                {t('允许后台运行')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <Text style={[styles.note, { color: palette.labelTertiary }]}>
        {t('房间只提醒房主本人发言；关闭所有通知时后台接收会一起停止，不额外耗电。')}
      </Text>
      <Text style={[styles.note, { color: palette.labelTertiary }]}>
        {t('移动端没有推送服务：App 被系统彻底杀掉后收不到通知，请保持后台运行或关闭电池优化。')}
      </Text>
    </View>
  );
}

export default NotifySettingsPanel;

const styles = StyleSheet.create({
  group: { fontSize: 11, fontWeight: '700', marginTop: 6, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  rowTitle: { fontSize: 14, fontWeight: '600' },
  rowHint: { fontSize: 11, lineHeight: 16, marginTop: 2 },
  presetRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  presetCard: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, paddingHorizontal: 6, borderRadius: 12, borderWidth: 1,
  },
  presetTitle: { fontSize: 13, fontWeight: '700' },
  summary: { fontSize: 11, lineHeight: 17, marginBottom: 8 },
  statusCard: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 12,
    paddingVertical: 10, paddingHorizontal: 12, marginBottom: 8,
  },
  disclosure: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
  },
  actionRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  linkRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 10,
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, marginBottom: 4,
  },
  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  roomList: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, marginBottom: 10, overflow: 'hidden' },
  roomRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  roomName: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '600' },
  note: { fontSize: 10, lineHeight: 16, marginTop: 10 },
});
