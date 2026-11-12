/**
 * SettingsDetailScreen · 分类设置页（2026-11-09 按 PiliPlus 思路从「我的」页拆出）
 *
 * PiliPlus：个人中心（我的）右上角齿轮 → 按类别分组的设置列表。
 * 本页对应地按「外观 / 语言 / 小窗播放 / 房间 / 通知」分组陈列设置项，
 * 账号入口与自动签到已迁至账号中心（AccountScreen），
 * 每组标题带图标；原有主题色预设、RGB 取色、动态取色、纯黑主题、背景图等全部保留。
 * 路由名 SettingsDetailScreen，由「我的」页右上角齿轮进入。
 */
import React, { useEffect, useState } from 'react';
import {
  Alert,
  BackHandler,
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import * as ImagePicker from 'expo-image-picker';
import { RootStackParamList } from '../navigation/types';
import { useMemberStore, useSettingsStore, useUiStore, useUpdateStore } from '../store';
import { saveSettings } from '../services/settings';
// 「我的」页迁入关于：运行日志 + 成员数据（用户 2026-11-11）
import RuntimeLogViewer from '../components/RuntimeLogViewer';
import { getMemberDataMeta, updateMemberData, type MemberDataMeta } from '../services/memberData';
import { toMs } from '../utils/format';
import { APP_VERSION, APP_BUILD } from '../constants';
import { clearAppCache } from '../services/cacheCleaner';
import { setPipEnabled } from '../utils/pip';
import ScreenHeader from '../components/ScreenHeader';
// 通知设置面板（用户 2026-11-09）：软件外/软件内、私信/房间、房间三态、免打扰
import { NotifySettingsPanel } from '../components/NotifySettingsPanel';
// 房间列表排序面板（用户 2026-11-09）：新消息在上开关 + 自定义/按队伍/按字母
import { RoomSortPanel } from '../components/RoomSortPanel';
import { chromeScrollProps } from '../navigation/chromeScroll';
import { FadeInView, ScalePressable } from '../components/Motion';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  usePalette,
  radii,
  radiiAlias,
  usePageBackground,
  ACCENT_PRESETS,
  ACCENT_VARIANTS,
  CUSTOM_ACCENT_PRESET,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_ACCENT_PRESET,
  FIRST_ROW_TEAM_IDS,
  TEAM_ACCENT_PRESETS,
  normalizeVariant,
} from '../theme';
import { fetchSystemAccentColor } from '../utils/systemAccent';
import { AccentSwatch, ThemeColorPicker } from '../components/ThemeColorPicker';
import { useI18n, LANGUAGE_OPTIONS } from '../i18n';
import { GlassSurface } from '../components/GlassSurface';
import { GlassSegmented, GlassSegmentedScroll } from '../components/GlassSegmented';
import { sniffImageBase64Mime } from '../utils/dataUri';

type SettingsNavProp = StackNavigationProp<RootStackParamList>;

/** 分类二级入口：竖屏点进去看详情，横屏左分类 / 右详情 */
type CategoryId = 'appearance' | 'language' | 'pip' | 'room' | 'notify' | 'mine' | 'about';

/**
 * 设置页分组卡：**玻璃常驻 + 内容淡入**。
 *
 * ⚠️ 顺序不能反过来（用户 2026-09-30 反馈「设置页面顶上新增的这一块会闪烁」）：
 * 以前是 `FadeInView`(opacity 0→1) 包着 `GlassSurface`，
 * 而 GlassSurface 在 Android 上是原生模糊（BlurView / RenderEffect）——
 * 把「模糊层」放进一个正在做 alpha 动画的父容器里，模糊结果会逐帧重新合成，
 * 表现就是入场时闪一下 / 整块忽明忽暗。现在玻璃直接挂载不参与动画，
 * 只有里面的内容淡入（distance=0，避免内容位移溢出玻璃圆角）。
 */
function Section({ title, icon, id, activeId, children, delay = 0 }: { title: string; icon?: string; id?: CategoryId; activeId?: CategoryId | null; children: React.ReactNode; delay?: number }) {
  const palette = usePalette();
  // 二级入口：只有当前选中的分类才渲染（横屏右栏 / 竖屏详情页都走这里）
  if (id && activeId !== id) return null;
  return (
    <View>
      {title ? (
        <View style={styles.sectionTitleRow}>
          {icon ? <MaterialCommunityIcons name={icon} size={15} color={palette.tint} /> : null}
          <Text style={[styles.sectionTitle, { color: palette.label }]}>{title}</Text>
        </View>
      ) : null}
      {/*
        ⚠️【描边修复】不要在这里再传 borderWidth / borderColor。
        GlassSurface 内部已有一层随主题走的描边（MATERIAL.stroke：浅色 rgba(255,255,255,0.66)
        / 深色 rgba(255,255,255,0.10)），且渲染在 children 之前；
        外层再叠一道 palette.hairline 会形成「双层描边」——两条线错位、颜色互搏，
        观感就是用户反馈的「描边没描好」（深浅色主题下都明显）。
        玻璃的唯一出口是 GlassSurface，描边交给它统一出。
      */}
      <GlassSurface radius={20} role="card" style={styles.section}>
        {/* 内容淡入（不位移：玻璃边界是固定的，内容上移会溢出色块圆角） */}
        <FadeInView delay={delay} duration={300} distance={0}>
          {children}
        </FadeInView>
      </GlassSurface>
    </View>
  );
}

/** Section 内行式条目：28 圆角图标底 + 标题 15/600 + 右侧 chevron/状态文字 */
function Row({
  icon,
  title,
  value,
  onPress,
  danger,
  withChevron = true,
  wrapValue = false,
}: {
  icon: string;
  title: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  withChevron?: boolean;
  /** value 完整显示（允许换行）——仓库地址等长文本用，默认仍单行截断 */
  wrapValue?: boolean;
}) {
  const palette = usePalette();
  return (
    <ScalePressable
      style={styles.row}
      onPress={onPress}
      pressedScale={0.98}
      activeOpacity={0.9}
      disabled={!onPress}
    >
      <View style={[styles.rowIcon, { backgroundColor: danger ? 'rgba(255,59,48,0.12)' : palette.tintSoft }]}>
        <MaterialCommunityIcons name={icon} color={danger ? palette.danger : palette.tint} size={16} />
      </View>
      <Text style={[styles.rowTitle, { color: danger ? palette.danger : palette.label }]} numberOfLines={1}>{title}</Text>
      {value ? (
        wrapValue ? (
          <Text style={[styles.rowValue, styles.rowValueWrap, { color: palette.labelTertiary }]}>{value}</Text>
        ) : (
          <Text style={[styles.rowValue, { color: palette.labelTertiary }]} numberOfLines={1}>{value}</Text>
        )
      ) : null}
      {withChevron ? (
        <MaterialCommunityIcons name="chevron-right" color={palette.labelTertiary} size={20} />
      ) : null}
    </ScalePressable>
  );
}

/** 成员库更新时间：yyyy-MM-dd HH:mm（从「我的」页原样迁入） */
function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(toMs(ts));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ChipRow<T>({ options, value, onChange }: { options: { label: string; value: T }[]; value: T; onChange: (value: T) => void }) {
  const segs = options.map((o, i) => ({ key: String(i), label: o.label }));
  const idx = String(options.findIndex((o) => o.value === value));
  // 选项多或标签长（如语言：跟随系统/简体中文/繁體中文/English/日本語/한국어）用可滚动版，
  // 等分版会把文字压到看不清
  const needScroll = options.length > 4 || options.some((o) => o.label.length > 4);
  if (needScroll) {
    return (
      <GlassSegmentedScroll
        options={segs}
        value={idx}
        onChange={(k) => onChange(options[Number(k)].value)}
        height={34}
      />
    );
  }
  return (
    <GlassSegmented
      options={segs}
      value={idx}
      onChange={(k) => onChange(options[Number(k)].value)}
      height={34}
    />
  );
}

export default function SettingsScreen() {
  const navigation = useNavigation<SettingsNavProp>();
  const palette = usePalette();
  const settings = useSettingsStore((state) => state.settings);
  const setSettings = useSettingsStore((state) => state.setSettings);
  const showToast = useUiStore((state) => state.showToast);
  const { t } = useI18n();
  const hasUpdate = useUpdateStore((s) => s.hasUpdate);
  const REPO_URL = 'https://github.com/wildfffire/yaya_msg_mobileX';

  /** 版本 chip：有更新直接开下载页，否则主动检查一次（从「我的」页搬来） */
  const checkVersion = () => {
    const { hasUpdate: up, latestUrl } = useUpdateStore.getState();
    if (up && latestUrl) {
      Linking.openURL(latestUrl).catch(() => {});
    } else {
      useUpdateStore.getState().checkUpdate(true).then((has) => {
        const next = useUpdateStore.getState();
        if (has && next.hasUpdate && next.latestUrl) Linking.openURL(next.latestUrl).catch(() => {});
        else showToast(t('已是最新版本'));
      }).catch(() => showToast(t('已是最新版本')));
    }
  };

  const openRepo = () => Linking.openURL(REPO_URL).catch(() => showToast(t('这个链接无法直接打开。')));

  /** 只清可重建缓存，二次确认后执行（白名单见 services/cacheCleaner.ts） */
  const handleClearCache = () => {
    Alert.alert(
      t('清除缓存'),
      t('将清理图片、排期、成员库等可重建缓存；不会删除账号、设置、观看历史、稍后再看与已下载内容。'),
      [
        { text: t('取消'), style: 'cancel' },
        {
          text: t('清除'),
          style: 'destructive',
          onPress: () => {
            clearAppCache()
              .then((res) => showToast(t('已清理 {count} 项缓存', { count: res.keys + res.dirs })))
              .catch((error: any) => showToast(t('清除缓存失败：{msg}', { msg: error?.message || String(error) })));
          },
        },
      ],
    );
  };
  /** PiliPlus 风格自定义颜色弹窗（RGB 滑块 + Hex 输入） */
  const [pickerVisible, setPickerVisible] = useState(false);
  /**
   * 主题色网格展开态（用户 2026-11-09）：默认只露一排 —— 自定义 + 6 支队伍应援色；
   * 其余队伍色与原有 20 个通用预设折叠在「展开全部主题色」之后。
   * 纯 UI 状态，不持久化（每次进设置页都回到简洁状态）。
   */
  const [accentExpanded, setAccentExpanded] = useState(false);
  /** 二级入口：竖屏 null = 分类列表；横屏默认落在第一个分类，右侧同时显示详情 */
  const [activeId, setActiveId] = useState<CategoryId | null>(null);
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const shownId: CategoryId | null = activeId ?? (isLandscape ? 'appearance' : null);

  /** ── 关于内的「维护」块（用户 2026-11-11：从「我的」页迁入） ── */
  const [logVisible, setLogVisible] = useState(false);
  const [memberMeta, setMemberMeta] = useState<MemberDataMeta | null>(null);
  const [memberSyncing, setMemberSyncing] = useState(false);
  const memberCount = useMemberStore((state) => state.members.length);

  useEffect(() => {
    getMemberDataMeta().then(setMemberMeta).catch(() => {});
  }, []);

  /** 手动更新成员数据库（双源: yk1z 库 + 官方接口），与「我的」页原实现一致 */
  const manualSyncMembers = () => {
    if (memberSyncing) return;
    setMemberSyncing(true);
    updateMemberData()
      .then((res) => {
        if (!res?.updated) {
          showToast(t('更新失败：{msg}（已保留本地数据）', { msg: res?.message || '' }));
          return;
        }
        return getMemberDataMeta().then((fresh) => {
          setMemberMeta(fresh);
          showToast(res?.detail ? t('更新成功：{detail}', { detail: res.detail }) : t('成员数据已更新'));
        });
      })
      .catch((e: any) => showToast(t('更新失败：{msg}（已保留本地数据）', { msg: e?.message || String(e) })))
      .finally(() => setMemberSyncing(false));
  };

  const CATEGORY_META: { id: CategoryId; title: string; icon: string }[] = [
    { id: 'appearance', title: t('外观'), icon: 'palette-outline' },
    { id: 'language', title: t('语言'), icon: 'translate' },
    { id: 'pip', title: t('小窗播放'), icon: 'picture-in-picture-bottom-right' },
    { id: 'room', title: t('房间'), icon: 'home-account' },
    // 通知（用户 2026-11-09）：软件外/软件内两套开关 + 私信/房间范围 + 房间三态
    { id: 'notify', title: t('通知'), icon: 'bell-ring-outline' },
    // 「我的」页横滑卡区显示开关（2026-11-11）
    { id: 'mine', title: t('我的页'), icon: 'view-dashboard-outline' },
    // 关于固定放最后一项：图标 / 版本 / 仓库地址 / 清除缓存
    { id: 'about', title: t('关于'), icon: 'information-outline' },
  ];

  const backgroundValue = settings.customBackgroundFile?.trim() || '';
  const backgroundInfo = (() => {
    if (!backgroundValue) return t('未设置');
    if (backgroundValue.startsWith('data:')) return t('本地图片已保存，约 {size}KB', { size: Math.round(backgroundValue.length / 1024) });
    return backgroundValue.length > 60 ? `${backgroundValue.slice(0, 60)}...` : backgroundValue;
  })();

  const THEME_OPTIONS = [
    { label: t('跟随系统'), value: 'system' },
    { label: t('浅色'), value: 'light' },
    { label: t('深色'), value: 'dark' },
  ];

  // PiliPlus 风格主题色：预设 id / 调色板风格 / 动态取色，种子色由 palette 统一派生
  const accentPreset = settings.accentPreset || DEFAULT_ACCENT_PRESET;
  const accentVariant = normalizeVariant(settings.accentVariant);
  const accentIsDynamic = !!settings.accentDynamic;
  const accentSeed = palette.seed;

  /** 第一排：自定义 + 6 支队伍应援色；折叠区：其余队伍色 + 20 个通用预设 */
  const teamFirstRow = TEAM_ACCENT_PRESETS.slice(0, FIRST_ROW_TEAM_IDS.length);
  const teamFolded = TEAM_ACCENT_PRESETS.slice(FIRST_ROW_TEAM_IDS.length);
  /** 当前选中的是不是「被折叠起来」的那个预设（用于提示，避免用户以为选中的丢了） */
  const foldedSelection =
    accentPreset !== CUSTOM_ACCENT_PRESET &&
    !teamFirstRow.some((p) => p.id === accentPreset)
      ? [...teamFolded, ...ACCENT_PRESETS].find((p) => p.id === accentPreset)
      : undefined;

  const update = async (key: string, value: any, extra: any = {}) => {
    const patch = { [key]: value, ...extra };
    setSettings(patch);
    try {
      await saveSettings(patch);
      showToast(t('设置已保存'));
    } catch (error: any) {
      showToast(t('保存失败：{msg}', { msg: error?.message || String(error) }));
    }
  };

  /** PiliPlus「动态取色」：Android 12+ 取系统壁纸色；不支持就提示并保持关闭 */
  const toggleDynamicColor = async (on: boolean) => {
    if (!on) { await update('accentDynamic', false); return; }
    const hex = await fetchSystemAccentColor();
    if (!hex) { showToast(t('设备可能不支持动态取色')); return; }
    await update('accentDynamic', true, { accentDynamicValue: hex });
  };

  const pickBg = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert(t('需要相册权限')); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, base64: true } as any);
      if (result.canceled) return;
      const base64 = result.assets?.[0]?.base64;
      if (!base64) { Alert.alert(t('未获取到图片数据')); return; }
      /**
       * ⚠️ MIME 必须按**真实字节**判定，不能信 picker 给的 `mimeType`。
       * 实测踩坑：用户存的背景图是 `data:image/png;base64,/9j/4AAQSkZJRgAB…`
       * —— 声明 PNG，实际是 JPEG（FFD8FFE0）。部分解码路径会信这个声明，
       * 直接解码失败 → 背景层什么都没画出来，透出下层黑底
       * （用户反馈的「背景图没加载」）。
       * 这里嗅探 base64 头部魔数，写对真实类型。
       */
      const mime = sniffImageBase64Mime(base64) || result.assets?.[0]?.mimeType || 'image/jpeg';
      await update('customBackgroundFile', `data:${mime};base64,${base64}`, { customBackgroundUpdatedAt: Date.now() });
    } catch (error: any) {
      Alert.alert(t('背景图失败'), error?.message || String(error));
    }
  };

  /** 左栏 / 竖屏首页：PiliPlus 风格的分类二级入口列表 */
  const categoryList = (
    <ScrollView style={styles.catList} contentContainerStyle={styles.catListContent} showsVerticalScrollIndicator={false}>
      <Text style={[styles.catTitle, { color: palette.labelSecondary }]}>{t('设置')}</Text>
      <GlassSurface radius={20} role="card" style={styles.catCard}>
        {CATEGORY_META.map((c) => {
          const selected = shownId === c.id;
          return (
            <ScalePressable
              key={c.id}
              style={[styles.catRow, selected && isLandscape && { backgroundColor: palette.tintSoft }]}
              onPress={() => setActiveId(c.id)}
              pressedScale={0.98}
              activeOpacity={0.9}
            >
              <View style={[styles.catRowIcon, { backgroundColor: palette.tintSoft }]}>
                <MaterialCommunityIcons name={c.icon} size={17} color={palette.tint} />
              </View>
              <Text style={[styles.catRowTitle, { color: selected && isLandscape ? palette.tint : palette.label }]} numberOfLines={1}>{c.title}</Text>
              <MaterialCommunityIcons name="chevron-right" size={18} color={palette.labelTertiary} />
            </ScalePressable>
          );
        })}
      </GlassSurface>
    </ScrollView>
  );

  /** 右栏 / 竖屏详情：只渲染当前选中分类的 Section（见 Section 的 id/activeId） */
  const detailScroll = (
        <ScrollView {...chromeScrollProps} style={{ flex: 1 }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* 外观与主题 */}
        <Section id="appearance" activeId={shownId} title={t('外观')} icon="palette-outline" delay={100}>
          <View style={styles.innerPad}>
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('主题')}</Text>
            <ChipRow options={THEME_OPTIONS} value={settings.theme} onChange={(v) => update('theme', v)} />
          </View>
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />

          {/* PiliPlus 风格主题颜色：预设三色圆盘 + 自定义 RGB/Hex 取色 */}
          <View style={styles.innerPad}>
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('主题颜色')}</Text>
            {accentIsDynamic ? (
              <Text style={[styles.note, { color: palette.labelTertiary, marginHorizontal: 0 }]}>
                {t('已跟随系统壁纸色：{hex}', { hex: settings.accentDynamicValue || DEFAULT_ACCENT_COLOR })}
              </Text>
            ) : (
              <>
                <View style={styles.swatchGrid}>
                  <AccentSwatch
                    seed={accentSeed}
                    variant={accentVariant}
                    label={t('自定义')}
                    selected={accentPreset === CUSTOM_ACCENT_PRESET}
                    onPress={() => setPickerVisible(true)}
                  />
                  {/* 第一排：6 支队伍的应援色（队伍名不翻译） */}
                  {teamFirstRow.map((p) => (
                    <AccentSwatch
                      key={p.id}
                      seed={p.color}
                      variant={accentVariant}
                      label={p.label}
                      selected={accentPreset === p.id}
                      onPress={() => update('accentPreset', p.id, { accentColor: p.color })}
                    />
                  ))}
                  {/* 折叠区：其余队伍色 + 原有 20 个通用预设 */}
                  {accentExpanded
                    ? [...teamFolded, ...ACCENT_PRESETS].map((p) => (
                        <AccentSwatch
                          key={p.id}
                          seed={p.color}
                          variant={accentVariant}
                          label={p.id.startsWith('team-') ? p.label : t(p.label)}
                          selected={accentPreset === p.id}
                          onPress={() => update('accentPreset', p.id, { accentColor: p.color })}
                        />
                      ))
                    : null}
                </View>
                {/* 展开 / 收起：一排不够时把其余颜色收起来，保持界面干净 */}
                <ScalePressable
                  onPress={() => setAccentExpanded((v) => !v)}
                  pressedScale={0.97}
                  style={styles.accentToggleRow}
                >
                  <Text style={[styles.accentToggleText, { color: palette.tint }]}>
                    {accentExpanded ? t('收起主题色') : t('展开全部主题色')}
                  </Text>
                  <MaterialCommunityIcons
                    name={accentExpanded ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={palette.tint}
                  />
                </ScalePressable>
                {!accentExpanded && foldedSelection ? (
                  <Text style={[styles.note, { color: palette.labelTertiary, marginHorizontal: 0 }]}>
                    {t('当前主题色：{name}', { name: foldedSelection.label })}
                  </Text>
                ) : null}
              </>
            )}
            {/* 实时预览：PiliPlus 色彩页底部那块界面预览，这里压成一条 */}
            <View style={[styles.accentPreview, { backgroundColor: palette.fill3, borderColor: palette.hairline }]}>
              <View style={styles.accentPreviewRow}>
                <View style={[styles.previewDot, { backgroundColor: palette.tint }]} />
                <View style={[styles.previewBar, { backgroundColor: palette.tintContainer }]} />
                <View style={[styles.previewChip, { backgroundColor: palette.tintAlt }]} />
              </View>
              <View style={[styles.accentPreviewRow, { marginTop: 8 }]}>
                <View style={[styles.previewBtn, { backgroundColor: palette.tint }]}>
                  <Text style={[styles.previewBtnText, { color: palette.onTint }]}>{t('预览')}</Text>
                </View>
                <View style={[styles.previewBtn, { backgroundColor: palette.tintSoft }]}>
                  <Text style={[styles.previewBtnText, { color: palette.tint }]}>{accentSeed}</Text>
                </View>
              </View>
            </View>
          </View>
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />

          <View style={styles.innerPad}>
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('调色板风格')}</Text>
            <ChipRow
              options={ACCENT_VARIANTS.map((v) => ({ label: t(v.label), value: v.id }))}
              value={accentVariant}
              onChange={(v) => update('accentVariant', v)}
            />
          </View>
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />

          <View style={styles.innerPad}>
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('动态取色')}</Text>
            <ChipRow
              options={[{ label: t('关闭'), value: false }, { label: t('开启'), value: true }]}
              value={accentIsDynamic}
              onChange={(v) => toggleDynamicColor(v)}
            />
            <Text style={[styles.note, { color: palette.labelTertiary, marginHorizontal: 0 }]}>
              {t('开启后使用系统壁纸颜色作为主题色（Android 12+）')}
            </Text>
          </View>
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />

          {/* 横屏侧边栏（用户 2026-11-11）：默认关，仅横屏生效，竖屏完全保持原样 */}
          <View style={styles.innerPad}>
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('横屏侧边栏')}</Text>
            <ChipRow
              options={[{ label: t('关闭'), value: false as any }, { label: t('开启'), value: true as any }]}
              value={!!settings.landscape_sidebar_enabled as any}
              onChange={(v) => update('landscape_sidebar_enabled', v)}
            />
            <Text style={[styles.note, { color: palette.labelTertiary, marginHorizontal: 0 }]}>
              {t('开启后仅在横屏时把四个页面入口移到左侧图标栏，并隐藏页面标题与问候语')}
            </Text>
          </View>
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />

          <Row
            icon="image"
            title={t('背景图')}
            value={backgroundInfo}
            onPress={pickBg}
          />
          {backgroundValue ? (
            <>
              <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
              <Row
                icon="restore"
                title={t('恢复默认背景')}
                danger
                withChevron={false}
                onPress={() => {
                  Alert.alert(t('恢复默认背景'), t('将移除当前背景图，确定？'), [
                    { text: t('取消'), style: 'cancel' },
                    { text: t('恢复默认'), style: 'destructive', onPress: () => update('customBackgroundFile', '', { customBackgroundUpdatedAt: Date.now() }) },
                  ]);
                }}
              />
            </>
          ) : null}
          {/* 背景遮罩 / 模糊（用户 2026-11-09）：只在使用自定义背景图时有意义 */}
          {backgroundValue ? (
            <>
              <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
              <View style={styles.innerPad}>
                <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>
                  {`${t('背景遮罩强度')} · ${Number(settings.bg_dim ?? 34)}%`}
                </Text>
                <ChipRow
                  /* 档位拉开（0/20/40/60/80/100）：旧的 40/70/88 三档视觉差别太小，
                     用户会以为「调了没反应」（2026-11-09 反馈） */
                  options={[0, 20, 40, 60, 80, 100].map((v) => ({ label: `${v}%`, value: v as any }))}
                  value={(Number(settings.bg_dim ?? 34)) as any}
                  onChange={(v) => update('bg_dim', Number(v))}
                />
                <Text style={[styles.rowLabel, { color: palette.labelSecondary, marginTop: 10 }]}>
                  {`${t('背景模糊')} · ${Number(settings.bg_blur ?? 0)}`}
                </Text>
                <ChipRow
                  options={[0, 4, 8, 12, 20].map((v) => ({ label: String(v), value: v as any }))}
                  value={(Number(settings.bg_blur ?? 0)) as any}
                  onChange={(v) => update('bg_blur', Number(v))}
                />
              </View>
            </>
          ) : null}
        </Section>

        {/* 语言 */}
        <Section id="language" activeId={shownId} title={t('语言')} icon="translate" delay={140}>
          <View style={styles.innerPad}>
            <ChipRow options={LANGUAGE_OPTIONS.map((o) => ({ ...o, label: o.value === 'system' ? t(o.label) : o.label }))} value={settings.language || 'system'} onChange={(v) => update('language', v)} />
          </View>
        </Section>

        {/* 小窗（画中画） */}
        <Section id="pip" activeId={shownId} title={t('小窗播放')} icon="picture-in-picture-bottom-right" delay={180}>
          <View style={styles.innerPad}>
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('切到后台自动弹出系统小窗')}</Text>
            <ChipRow
              options={[{ label: t('关闭'), value: false as any }, { label: t('开启'), value: true as any }]}
              value={settings.pip_auto}
              onChange={(v) => {
                setPipEnabled(!!v);
                update('pip_auto', v);
              }}
            />
            <Text style={[styles.note, { color: palette.labelTertiary }]}>
              {t('关闭后，播放视频时切到后台不会弹出系统小窗（可用播放器内小窗在应用内继续看）；开启后切后台自动以系统小窗继续播放')}
            </Text>
          </View>
        </Section>

        {/* 房间 */}
        <Section id="room" activeId={shownId} title={t('房间')} icon="home-account" delay={220}>
          <View style={styles.innerPad}>
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('房间内头像')}</Text>
            <ChipRow
              options={[
                { label: t('偶像自选'), value: 'custom' as any },
                { label: t('系统公式照'), value: 'official' as any },
              ]}
              value={(settings.room_avatar_source || 'custom') as any}
              onChange={(v) => update('room_avatar_source', v)}
            />
          </View>
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          <View style={styles.innerPad}>
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('房间外头像')}</Text>
            <ChipRow
              options={[
                { label: t('偶像自选'), value: 'custom' as any },
                { label: t('系统公式照'), value: 'official' as any },
              ]}
              value={(settings.room_list_avatar_source || 'official') as any}
              onChange={(v) => update('room_list_avatar_source', v)}
            />
          </View>
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          {/* 房间列表排序（用户 2026-11-09）：新消息在上开关 + 自定义/按队伍/按字母 */}
          <RoomSortPanel />
        </Section>

        {/* 通知（用户 2026-11-09）：软件外/软件内、私信/房间、房间三态、免打扰 */}
        <Section id="notify" activeId={shownId} title={t('通知')} icon="bell-ring-outline" delay={300}>
          <NotifySettingsPanel />
        </Section>

        {/* 「我的」页横滑卡区开关（默认关） */}
        <Section id="mine" activeId={shownId} title={t('我的页')} icon="view-dashboard-outline" delay={320}>
          <View style={styles.innerPad}>
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('在「我的」页显示稍后再看')}</Text>
            <ChipRow
              options={[{ label: t('关闭'), value: false as any }, { label: t('开启'), value: true as any }]}
              value={!!settings.my_show_watch_later}
              onChange={(v) => update('my_show_watch_later', v)}
            />
            <View style={[styles.divider, { backgroundColor: palette.innerStroke, marginLeft: 0, marginVertical: 12 }]} />
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('在「我的」页显示观看历史')}</Text>
            <ChipRow
              options={[{ label: t('关闭'), value: false as any }, { label: t('开启'), value: true as any }]}
              value={!!settings.my_show_watch_history}
              onChange={(v) => update('my_show_watch_history', v)}
            />
            <Text style={[styles.note, { color: palette.labelTertiary, marginHorizontal: 0 }]}>
              {t('开启后以横滑卡片展示，与首页公演直播同一方式。')}
            </Text>
          </View>
        </Section>

        {/* 关于（设置最后一项）：应用图标 / 版本 / 仓库地址 / 网页端 / 清除缓存 */}
        <Section id="about" activeId={shownId} title={t('关于')} icon="information-outline" delay={360}>
          <View style={styles.aboutHero}>
            <View style={styles.aboutLogoWrap}>
              <Image source={require('../../assets/logo.png')} style={styles.aboutLogoImg} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[styles.aboutName, { color: palette.label }]}>{t('牙牙消息 X')}</Text>
              <Text style={[styles.aboutSub, { color: palette.labelSecondary }]} numberOfLines={2}>
                {t('口袋48 / SNH48 Group 的第三方 Android 客户端')}
              </Text>
            </View>
            <View style={styles.verChipWrap}>
              <ScalePressable onPress={checkVersion} pressedScale={0.94}>
                <View style={[styles.verChip, { backgroundColor: palette.tintSoft }]}>
                  <Text style={[styles.verChipText, { color: palette.tint }]}>v{APP_VERSION}</Text>
                </View>
              </ScalePressable>
              {hasUpdate ? <View style={[styles.verDot, { backgroundColor: palette.danger, borderColor: palette.surface }]} /> : null}
              <Text style={[styles.verBuildText, { color: palette.labelTertiary }]}>
                {t('Build {n}', { n: APP_BUILD })}
              </Text>
            </View>
          </View>
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          <Row
            icon="github"
            title={t('仓库地址')}
            value="github.com/wildfffire/yaya_msg_mobileX"
            wrapValue
            onPress={openRepo}
          />
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          <Row icon="text-box-search-outline" title={t('运行日志')} onPress={() => setLogVisible(true)} />
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          <Row icon="delete-sweep-outline" title={t('清除缓存')} danger onPress={handleClearCache} />
          {/* 成员数据：用户 2026-11-12 要求「永远置于底部」——固定在关于分区最后 */}
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          <View style={styles.memberStatRow}>
            <View style={[styles.memberStatCard, { backgroundColor: palette.fill3 }]}>
              <Text style={[styles.memberStatNum, { color: palette.label }]}>{memberCount}</Text>
              <Text style={[styles.memberStatLabel, { color: palette.labelSecondary }]}>{t('位成员')}</Text>
            </View>
            <View style={[styles.memberStatCard, { backgroundColor: palette.fill3 }]}>
              <Text style={[styles.memberStatNum, { color: palette.label }]} numberOfLines={1}>
                {memberMeta ? formatTime(memberMeta.savedAt) : t('尚未同步')}
              </Text>
              <Text style={[styles.memberStatLabel, { color: palette.labelSecondary }]}>{t('最近更新')}</Text>
            </View>
          </View>
          <Row
            icon="cloud-download"
            title={t('手动更新成员数据')}
            value={memberSyncing ? t('更新中…') : t('立即同步')}
            onPress={manualSyncMembers}
          />
          <Text style={[styles.note, { color: palette.labelTertiary }]}>
            {t('成员数据共 {count} 位，数据来源于 yk1z 数据库（yk1z/yaya_msg），进入软件时自动同步最新。', { count: memberCount })}
          </Text>
        </Section>

        </ScrollView>
  );

  const activeTitle = CATEGORY_META.find((c) => c.id === shownId)?.title;
  const inPortraitDetail = !isLandscape && !!shownId;

  /** 竖屏详情：系统返回键先回分类列表，而不是直接退出设置页（取色弹窗打开时不抢） */
  useEffect(() => {
    if (!inPortraitDetail || pickerVisible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setActiveId(null);
      return true;
    });
    return () => sub.remove();
  }, [inPortraitDetail, pickerVisible]);

  return (
    <>
      <View style={[styles.container, { backgroundColor: usePageBackground() }]}>
        {/* 竖屏进详情时顶栏变分类名 + 返回分类列表；横屏顶栏固定「设置」，左右双栏 */}
        <ScreenHeader
          title={inPortraitDetail ? (activeTitle || t('设置')) : t('设置')}
          onBack={inPortraitDetail ? () => setActiveId(null) : undefined}
        />
        {isLandscape ? (
          <View style={styles.landscapeRow}>
            <View style={[styles.catPane, { borderRightColor: palette.hairline }]}>{categoryList}</View>
            <View style={styles.detailPane}>{detailScroll}</View>
          </View>
        ) : (shownId ? detailScroll : categoryList)}
      </View>
      <ThemeColorPicker
        visible={pickerVisible}
        initialColor={accentSeed}
        onClose={() => setPickerVisible(false)}
        onConfirm={(hex) => {
          setPickerVisible(false);
          update('accentPreset', CUSTOM_ACCENT_PRESET, { accentColor: hex });
        }}
        onReset={() => {
          setPickerVisible(false);
          update('accentPreset', DEFAULT_ACCENT_PRESET, { accentColor: DEFAULT_ACCENT_COLOR });
        }}
      />
      <RuntimeLogViewer visible={logVisible} onClose={() => setLogVisible(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 112, paddingHorizontal: 16 },
  // 分类二级入口（竖屏列表 / 横屏左栏）
  catList: { flex: 1 },
  catListContent: { padding: 16, paddingBottom: 40 },
  catTitle: { fontSize: 13, fontWeight: '700', marginBottom: 10, paddingHorizontal: 4 },
  catCard: { overflow: 'hidden' },
  catRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  catRowIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  catRowTitle: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '600' },
  // 横屏左右双栏
  landscapeRow: { flex: 1, flexDirection: 'row' },
  catPane: { width: 230, borderRightWidth: StyleSheet.hairlineWidth },
  detailPane: { flex: 1 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 20, marginBottom: 8, paddingHorizontal: 4 },
  sectionTitle: { fontSize: 14, fontWeight: '700' },
  // 描边由 GlassSurface 内部统一出（见 Section 注释），此处不再叠 borderWidth/borderColor
  section: { overflow: 'hidden' },
  innerPad: { padding: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600' },
  rowValueWrap: { flex: 1, textAlign: 'right', flexWrap: 'wrap' },
  rowValue: { flexShrink: 1, fontSize: 12, marginRight: 6, maxWidth: '48%', textAlign: 'right' },
  rowLabel: { fontSize: 12, lineHeight: 18, marginBottom: 6 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 54 },
  // 关于 hero
  aboutHero: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  aboutLogoWrap: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aboutLogoImg: { width: 52, height: 52 },
  aboutName: { fontSize: 20, fontWeight: '800' },
  aboutSub: { fontSize: 12, marginTop: 4 },
  verChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radiiAlias.button },
  verChipWrap: { alignItems: 'flex-end' },
  verDot: { position: 'absolute', top: -2, right: -2, width: 9, height: 9, borderRadius: 5, borderWidth: 1.5 },
  verChipText: { fontSize: 12, fontWeight: '800' },
  // 成员数据
  memberStatRow: { flexDirection: 'row', gap: 10, padding: 14 },
  memberStatCard: {
    flex: 1,
    padding: 16,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  memberStatNum: { fontSize: 18, fontWeight: '900', textAlign: 'center' },
  memberStatLabel: { fontSize: 11, marginTop: 4 },
  autoSyncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 14,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radiiAlias.card,
  },
  autoSyncText: { fontSize: 12, marginLeft: 8, fontWeight: '600' },
  note: { marginHorizontal: 14, marginTop: 10, fontSize: 11, lineHeight: 16 },
  footer: { textAlign: 'center', fontSize: 12, marginTop: 24 },
  /** 小版本（构建号）：比版本名更小更浅，跟在版本行下方 */
  footerSub: { textAlign: 'center', fontSize: 10, marginTop: 3 },
  verBuildText: { fontSize: 10, fontWeight: '600', marginTop: 3 },
  // PiliPlus 风格主题色区
  swatchGrid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 4 },
  accentPreview: { marginTop: 4, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  accentPreviewRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  previewDot: { width: 22, height: 22, borderRadius: 11 },
  previewBar: { flex: 1, height: 22, borderRadius: 11 },
  previewChip: { width: 36, height: 22, borderRadius: 11 },
  previewBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  previewBtnText: { fontSize: 10, fontWeight: '800' },
  /** 主题色「展开全部 / 收起」：纯文字 + 箭头，不抢视觉 */
  accentToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 8, alignSelf: 'flex-start' },
  accentToggleText: { fontSize: 12, fontWeight: '700' },
});
