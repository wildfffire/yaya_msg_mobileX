// iOS 26 调色板：双主题（light / dark）、玻璃专用 surface
// 命名遵循 Apple HIG 的语义色模式：bg / surface / label / separator / tint / glass.*
//
// 2026-11-09：接入 PiliPlus 风格的「种子色 → 整套语义色」链路。
// tint / tintSoft / onTint 不再是写死的品牌粉，而是由设置里的预设色 / 自定义 RGB / 系统动态取色
// 经 themeColors.ts 派生；usePalette 订阅 settings，改动即时全 app 生效。

import { useMemo } from 'react';
import { useSettingsStore } from '../store';
import { useResolvedTheme } from '../hooks/useAppTheme';
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_ACCENT_PRESET,
  deriveAccentColors,
  normalizeVariant,
  resolveAccentSeed,
  type AccentVariant,
} from './themeColors';

/** 品牌 accent：保留原始常量作为兼容出口与默认种子色 */
export const accent = {
  pink: '#ff6f91',
  pinkDark: '#ff8fa8',
  pinkSoft: 'rgba(255, 111, 145, 0.16)',
  pinkOnDark: '#ff8fa8',
} as const;

/** 官方口袋48风格：白底 + 粉点缀 + 实心卡片（2026-08-15 改版）
 *  2026-09-06 用户嫌「功能选项底色太白了」+「tab 玻璃感不足」
 *  bg #F5F5F7→#ECEDF1、surface 全白 #FFFFFF→#F4F5F9（柔和卡片，非惨白）、
 *  muted/glass 系列同调:卡片白块与背景灰层次舒适,iOS 26 group 卡片观感 */
const neutralLight = {
  background: '#ECEDF1',
  surface: '#F4F5F9',
  surfaceElevated: '#F4F5F9',
  surfaceMuted: '#ECEDF1',
  surfaceGlass: '#F4F5F9',
  surfaceGlassStrong: '#F4F5F9',
  hairline: 'rgba(0,0,0,0.06)',
  separator: 'rgba(60,60,67,0.14)',
  label: '#111114',
  labelSecondary: '#55555C',
  labelTertiary: '#9A9AA1',
  fill1: 'rgba(0,0,0,0.06)',
  fill2: 'rgba(0,0,0,0.05)',
  fill3: 'rgba(0,0,0,0.04)',
  innerStroke: 'rgba(0,0,0,0.06)',
};

const neutralDark = {
  background: '#0B0B0F',
  surface: '#1C1C1F',
  surfaceElevated: '#26262B',
  surfaceMuted: '#17171B',
  surfaceGlass: '#1C1C1F',
  surfaceGlassStrong: '#232327',
  hairline: 'rgba(255,255,255,0.10)',
  separator: 'rgba(84,84,88,0.40)',
  label: '#F5F5F7',
  labelSecondary: '#C9C9CE',
  labelTertiary: '#8E8E93',
  fill1: 'rgba(255,255,255,0.10)',
  fill2: 'rgba(255,255,255,0.08)',
  fill3: 'rgba(255,255,255,0.06)',
  innerStroke: 'rgba(255,255,255,0.09)',
};

export const semantic = {
  success: '#34C759',
  warning: '#FF9F0A',
  danger: '#FF3B30',
  info: '#5AC8FA',
} as const;

export type PaletteName = 'light' | 'dark';

/** 显式声明形状：动态色板字段从字面量类型放宽为 string，消费方用法不变 */
export interface Palette {
  name: PaletteName;
  background: string;
  surface: string;
  surfaceElevated: string;
  surfaceMuted: string;
  surfaceGlass: string;
  surfaceGlassStrong: string;
  hairline: string;
  separator: string;
  label: string;
  labelSecondary: string;
  labelTertiary: string;
  fill1: string;
  fill2: string;
  fill3: string;
  innerStroke: string;
  pink: string;
  pinkDark: string;
  pinkSoft: string;
  pinkOnDark: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  /** 当前明暗主题下由种子色派生的主色 */
  tint: string;
  tintSoft: string;
  /** 自己消息气泡等中等浓度染色 */
  tintMedium: string;
  /** tint 填充之上的前景色（按钮/胶囊文字，亮色底自动转深字） */
  onTint: string;
  /** PiliPlus 色板里的 tertiary 分区 */
  tintAlt: string;
  /** PiliPlus 色板里的 primaryContainer 分区 */
  tintContainer: string;
  onTintContainer: string;
  /** 未经变体调整的原始种子色 */
  seed: string;
}

/** 由「明暗 + 种子色 + 调色板风格」拼出完整色板（纯黑主题已按用户要求删除） */
export function buildPalette(name: PaletteName, seedHex: string, variant: AccentVariant): Palette {
  const dark = name === 'dark';
  const a = deriveAccentColors(seedHex, variant, dark);
  const darkTint = dark ? a.tint : deriveAccentColors(seedHex, variant, true).tint;
  const neutral = dark ? neutralDark : neutralLight;
  return {
    ...neutral,
    ...semantic,
    name,
    pink: a.seed,
    pinkDark: darkTint,
    pinkSoft: a.tintSoft,
    pinkOnDark: darkTint,
    tint: a.tint,
    tintSoft: a.tintSoft,
    tintMedium: a.tintMedium,
    onTint: a.onTint,
    tintAlt: a.tintAlt,
    tintContainer: a.tintContainer,
    onTintContainer: a.onTintContainer,
    seed: a.seed,
  };
}

/** 默认色板（与改造前一致：品牌粉 + material 风格） */
export const Palettes: Record<PaletteName, Palette> = {
  light: buildPalette('light', DEFAULT_ACCENT_COLOR, 'material'),
  dark: buildPalette('dark', DEFAULT_ACCENT_COLOR, 'material'),
};

/** 组件外读取当前种子色（Web HTML 模板等非 hook 场景用；不做响应式） */
export function getAccentSeed(): string {
  const s = useSettingsStore.getState().settings;
  return resolveAccentSeed({
    presetId: s.accentPreset || DEFAULT_ACCENT_PRESET,
    customHex: s.accentColor,
    dynamicHex: s.accentDynamicValue,
    dynamicEnabled: !!s.accentDynamic,
  });
}

/** 当前实际色板：订阅设置里的预设色 / 自定义色 / 调色板风格 / 动态取色 */
export function usePalette(): Palette {
  const name = useResolvedTheme();
  const presetId = useSettingsStore((s) => s.settings.accentPreset);
  const customHex = useSettingsStore((s) => s.settings.accentColor);
  const variant = useSettingsStore((s) => s.settings.accentVariant);
  const dynamic = useSettingsStore((s) => s.settings.accentDynamic);
  const dynamicHex = useSettingsStore((s) => s.settings.accentDynamicValue);

  return useMemo(() => {
    const seed = resolveAccentSeed({
      presetId: presetId || DEFAULT_ACCENT_PRESET,
      customHex,
      dynamicHex,
      dynamicEnabled: !!dynamic,
    });
    return buildPalette(name, seed, normalizeVariant(variant));
  }, [name, presetId, customHex, variant, dynamic, dynamicHex]);
}

/**
 * 页面根容器背景色：始终透明。
 * - 无自定义背景图 → 露出根层 PageBackdrop（柔和色斑，玻璃的「透」来源）
 * - 有自定义背景图 → 露出根层 ImageBackground
 * 页面内容与玻璃卡直接叠在底衬上，获得真实液态玻璃观感。
 */
export function usePageBackground(): string {
  return 'transparent';
}

/** 兼容旧 Colors 引用：返回扁平 token 对象（默认 light）—— 旧 screens 不爆炸 */
export const Colors = {
  ...Palettes.light,
  // 兼容旧字段（其它模块残留引用）
  bgDark: Palettes.dark.background,
  darkTextPrimary: Palettes.dark.label,
  darkTextSecondary: Palettes.dark.labelSecondary,
  darkTextTertiary: Palettes.dark.labelTertiary,
  btnSecondaryBg: Palettes.light.fill3,
  btnSecondaryBgDark: Palettes.dark.fill3,
};

export const DarkColors = Palettes.dark;
