/**
 * 房间列表排序面板（设置 → 房间）
 *
 * 用户 2026-11-09：
 *   · 「新消息在上」加个开关放设置里；
 *   · 关掉后可以自定义房间列表排序，分为自定义、按队伍和按字母；
 *   · 自定义排序加个下拉菜单，列出所有已关注房间，逐个点选决定先后顺序。
 *
 * 排序执行在 `src/utils/roomListSort.ts`（纯函数，有单测）；这里只负责写设置。
 * 置顶房间永远最前，与这些选项无关（既有行为，不改）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import pocketApi from '../api/pocket48';
import { useMemberStore, useSettingsStore } from '../store';
import { saveSettings } from '../services/settings';
import { useI18n } from '../i18n';
import { usePalette, radii } from '../theme';
import { unwrapList } from '../utils/data';
import type { RoomSortMode } from '../utils/roomListSort';

const MODES: { id: RoomSortMode; label: string }[] = [
  { id: 'custom', label: '自定义' },
  { id: 'team', label: '按队伍' },
  { id: 'alpha', label: '按字母' },
];

export function RoomSortPanel() {
  const palette = usePalette();
  const { t } = useI18n();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const members = useMemberStore((s: any) => s.members);

  const unreadFirst = settings.room_list_unread_first !== false;
  const mode: RoomSortMode = (settings.room_list_sort || 'custom') as RoomSortMode;
  const customOrder = useMemo(() => settings.room_list_custom_order || [], [settings.room_list_custom_order]);

  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);

  const update = useCallback(
    (patch: Record<string, any>) => {
      setSettings(patch as any);
      void saveSettings(patch as any);
    },
    [setSettings],
  );

  const loadRooms = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await pocketApi.getFollowedIds();
      setRoomIds(unwrapList(res, ['content.data', 'content', 'data', 'list']).map(String));
    } catch {
      setRoomIds([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 进设置页就拉一次关注列表（数量少、只在设置页发生）
  useEffect(() => {
    if (!roomIds.length) void loadRooms();
  }, [roomIds.length, loadRooms]);

  /** 已关注房间（按成员库补名字与头像；缺成员信息的直接跳过，避免出现空白行） */
  const rooms = useMemo(
    () =>
      roomIds
        .map((id) => (members as any[]).find((m) => String(m?.id || m?.userId || '') === id))
        .filter(Boolean)
        .map((m: any) => ({ id: String(m.id || m.userId), name: String(m.ownerName || m.nickname || m.id), team: String(m.team || '') })),
    [roomIds, members],
  );

  /** 已排的在前（带序号），未排的按关注列表原序排在后面 */
  const orderedRooms = useMemo(() => {
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const picked = customOrder.map((id) => byId.get(String(id))).filter(Boolean) as typeof rooms;
    const pickedIds = new Set(picked.map((r) => r.id));
    return [...picked, ...rooms.filter((r) => !pickedIds.has(r.id))];
  }, [rooms, customOrder]);

  const toggleRoom = useCallback(
    (id: string) => {
      const next = customOrder.includes(id) ? customOrder.filter((x) => x !== id) : [...customOrder, id];
      update({ room_list_custom_order: next });
    },
    [customOrder, update],
  );

  const chip = (label: string, active: boolean, onPress: () => void) => (
    <TouchableOpacity
      key={label}
      activeOpacity={0.85}
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: active ? palette.tint : palette.fill2, borderColor: active ? palette.tint : palette.hairline },
      ]}
    >
      <Text style={[styles.chipText, { color: active ? palette.onTint : palette.labelSecondary }]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.wrap}>
      <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('房间列表排序')}</Text>

      {/* ① 新消息在上 */}
      <View style={styles.switchRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.rowTitle, { color: palette.label }]}>{t('新消息在上')}</Text>
          <Text style={[styles.rowHint, { color: palette.labelTertiary }]}>{t('有新消息的房间排到最前面')}</Text>
        </View>
        <Switch
          value={unreadFirst}
          onValueChange={(v) => update({ room_list_unread_first: v })}
          thumbColor={palette.surface}
          trackColor={{ false: palette.fill2, true: palette.tint }}
        />
      </View>

      {/* ② 排序方式（组内顺序；上浮开关不影响它） */}
      <Text style={[styles.subLabel, { color: palette.labelSecondary }]}>{t('排序方式')}</Text>
      <View style={styles.chipRow}>{MODES.map((m) => chip(t(m.label), mode === m.id, () => update({ room_list_sort: m.id })))}</View>

      {/* ③ 自定义顺序入口（只在自定义模式出现） */}
      {mode === 'custom' ? (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => setPickerVisible(true)}
          style={[styles.orderRow, { borderColor: palette.hairline, backgroundColor: palette.fill2 }]}
        >
          <MaterialCommunityIcons name="sort-variant" size={16} color={palette.tint} />
          <Text style={[styles.orderText, { color: palette.label }]}>{t('自定义顺序')}</Text>
          <Text style={[styles.orderCount, { color: palette.labelTertiary }]}>
            {t('已排 {n} 个', { n: customOrder.length })}
          </Text>
          <MaterialCommunityIcons name="chevron-down" size={18} color={palette.labelTertiary} />
        </TouchableOpacity>
      ) : (
        <Text style={[styles.hint, { color: palette.labelTertiary }]}>
          {mode === 'team' ? t('按队伍排：SNH48 → GNZ48 → BEJ48 → CKG48 → CGT48 → IDFT') : t('按成员名字的拼音首字母排')}
        </Text>
      )}

      {/* 自定义顺序：点选式「下拉菜单」 */}
      <Modal visible={pickerVisible} transparent animationType="fade" onRequestClose={() => setPickerVisible(false)}>
        <View style={styles.mask}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setPickerVisible(false)} />
          <View style={[styles.sheet, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: palette.label }]}>{t('自定义顺序')}</Text>
              <Text style={[styles.sheetHint, { color: palette.labelTertiary }]}>{t('按点选先后排列，再点取消')}</Text>
            </View>

            {loading ? (
              <View style={styles.stateBox}>
                <ActivityIndicator color={palette.tint} />
              </View>
            ) : orderedRooms.length === 0 ? (
              <View style={styles.stateBox}>
                <Text style={[styles.stateText, { color: palette.labelTertiary }]}>{t('还没有已关注的房间')}</Text>
              </View>
            ) : (
              <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
                {orderedRooms.map((room) => {
                  const idx = customOrder.indexOf(room.id);
                  const picked = idx >= 0;
                  return (
                    <TouchableOpacity
                      key={room.id}
                      activeOpacity={0.8}
                      onPress={() => toggleRoom(room.id)}
                      style={[styles.listRow, { borderBottomColor: palette.hairline }]}
                    >
                      <View
                        style={[
                          styles.badge,
                          { backgroundColor: picked ? palette.tint : palette.fill2 },
                        ]}
                      >
                        <Text style={[styles.badgeText, { color: picked ? palette.onTint : palette.labelTertiary }]}>
                          {picked ? String(idx + 1) : '–'}
                        </Text>
                      </View>
                      <Text style={[styles.listName, { color: palette.label }]} numberOfLines={1}>
                        {room.name}
                      </Text>
                      {room.team ? (
                        <Text style={[styles.listTeam, { color: palette.labelTertiary }]} numberOfLines={1}>
                          {room.team.replace(/^TEAM\s+/i, '')}
                        </Text>
                      ) : null}
                      <MaterialCommunityIcons
                        name={picked ? 'check-circle' : 'circle-outline'}
                        size={18}
                        color={picked ? palette.tint : palette.labelTertiary}
                      />
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            <View style={[styles.sheetFooter, { borderTopColor: palette.hairline }]}>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => update({ room_list_custom_order: [] })}
                style={[styles.footerBtn, { backgroundColor: palette.fill2 }]}
              >
                <Text style={[styles.footerText, { color: palette.labelSecondary }]}>{t('清空')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => setPickerVisible(false)}
                style={[styles.footerBtn, { backgroundColor: palette.tint }]}
              >
                <Text style={[styles.footerText, { color: palette.onTint }]}>{t('完成')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 14, paddingBottom: 12 },
  rowLabel: { fontSize: 12, fontWeight: '700', marginBottom: 6 },
  subLabel: { fontSize: 12, fontWeight: '700', marginTop: 12, marginBottom: 6 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  rowTitle: { fontSize: 14, fontWeight: '600' },
  rowHint: { fontSize: 11, marginTop: 2, lineHeight: 15 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  chipText: { fontSize: 12, fontWeight: '700' },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  orderText: { fontSize: 13, fontWeight: '600', flex: 1 },
  orderCount: { fontSize: 11, fontWeight: '600' },
  hint: { fontSize: 11, lineHeight: 16, marginTop: 10 },
  mask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', paddingHorizontal: 18 },
  sheet: {
    maxHeight: '78%',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    paddingTop: 12,
  },
  sheetHeader: { paddingHorizontal: 14, paddingBottom: 8 },
  sheetTitle: { fontSize: 14, fontWeight: '800' },
  sheetHint: { fontSize: 11, marginTop: 3 },
  list: { maxHeight: 420 },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  badge: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 11, fontWeight: '800' },
  listName: { flex: 1, fontSize: 13, fontWeight: '600' },
  listTeam: { fontSize: 10, fontWeight: '700', marginRight: 6 },
  stateBox: { paddingVertical: 28, alignItems: 'center', justifyContent: 'center' },
  stateText: { fontSize: 12 },
  sheetFooter: { flexDirection: 'row', gap: 10, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
  footerBtn: { flex: 1, paddingVertical: 10, borderRadius: 12, alignItems: 'center' },
  footerText: { fontSize: 13, fontWeight: '800' },
});
