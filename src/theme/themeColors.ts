/**
 * 主题色规则层（PiliPlus 风格，零依赖 —— 可进纯 Node 单测）。
 *
 * PiliPlus 的做法（lib/pages/setting/pages/color_select.dart）：
 *   · 一组预设种子色（colorThemeTypes），每个预设展示成「圆形三色分区色板」；
 *   · 自定义色用 Color Picker：色块实时预览 + #RRGGBB 输入 + R/G/B 三条 0-255 滑块；
 *   · 单个种子色经 SeedColorScheme 生成整套 ColorScheme（本项目用 tint/tintSoft/tintAlt 等语义色承接）；
 *   · 另有「调色板风格」与「动态取色」开关。
 *
 * 这里只放纯函数：颜色解析、HSL 变换、种子色派生、预设表。
 * RN 侧的调色板拼装在 colors.ts，避免把 React / zustand 依赖带进单测。
 */

import { TEAM_ACCENT_PRESETS } from './teamAccentPresets';

export type AccentVariant = 'material' | 'soft' | 'vivid' | 'mono';

export interface AccentPreset {
  id: string;
  /** 中文原文即 i18n key */
  label: string;
  /** #RRGGBB */
  color: string;
}

/** 保留原有品牌粉为默认（不改动用户现有外观），后面是 PiliPlus 的 19 个预设 */
export const DEFAULT_ACCENT_PRESET = 'yaya';
export const DEFAULT_ACCENT_COLOR = '#FF6F91';
/** 自定义预设 id：种子色取 accentColor 字段 */
export const CUSTOM_ACCENT_PRESET = 'custom';

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'yaya', label: '口袋粉', color: '#FF6F91' },
  { id: 'greenDefault', label: '默认绿', color: '#5CB67B' },
  { id: 'pink', label: '粉红色', color: '#FF7299' },
  { id: 'red', label: '红色', color: '#F44336' },
  { id: 'orange', label: '橙色', color: '#FF9800' },
  { id: 'amber', label: '琥珀色', color: '#FFC107' },
  { id: 'yellow', label: '黄色', color: '#FFEB3B' },
  { id: 'lime', label: '酸橙色', color: '#CDDC39' },
  { id: 'lightGreen', label: '浅绿色', color: '#8BC34A' },
  { id: 'green', label: '绿色', color: '#4CAF50' },
  { id: 'teal', label: '青色', color: '#009688' },
  { id: 'cyan', label: '蓝绿色', color: '#00BCD4' },
  { id: 'lightBlue', label: '浅蓝色', color: '#03A9F4' },
  { id: 'blue', label: '蓝色', color: '#2196F3' },
  { id: 'indigo', label: '靛蓝色', color: '#3F51B5' },
  { id: 'purple', label: '紫色', color: '#9C27B0' },
  { id: 'deepPurple', label: '深紫色', color: '#673AB7' },
  { id: 'blueGrey', label: '蓝灰色', color: '#607D8B' },
  { id: 'brown', label: '棕色', color: '#795548' },
  { id: 'grey', label: '灰色', color: '#9E9E9E' },
];

export const ACCENT_VARIANTS: { id: AccentVariant; label: string }[] = [
  { id: 'material', label: '标准' },
  { id: 'soft', label: '柔和' },
  { id: 'vivid', label: '鲜艳' },
  { id: 'mono', label: '单色' },
];

export function normalizeVariant(input: unknown): AccentVariant {
  return input === 'soft' || input === 'vivid' || input === 'mono' ? input : 'material';
}

/** 3/6 位 hex（可带 #）→ 统一 #RRGGBB 大写；非法输入返回 null */
export function normalizeHexColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return `#${s.toUpperCase()}`;
}

export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number }

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }
function clampByte(v: number): number { return Math.max(0, Math.min(255, Math.round(Number(v) || 0))); }

/** 非法 hex 一律回退品牌粉，保证任何脏数据都不会渲染出透明/黑色主题 */
export function hexToRgb(input: string): RGB {
  const hex = normalizeHexColor(input) || DEFAULT_ACCENT_COLOR;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const part = (v: number) => clampByte(v).toString(16).padStart(2, '0').toUpperCase();
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsl(r: number, g: number, b: number): HSL {
  const rn = clampByte(r) / 255;
  const gn = clampByte(g) / 255;
  const bn = clampByte(b) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const hh = (((h % 360) + 360) % 360) / 360;
  const ss = clamp01(s);
  const ll = clamp01(l);
  if (ss === 0) {
    const v = Math.round(ll * 255);
    return { r: v, g: v, b: v };
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const channel = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(channel(hh + 1 / 3) * 255),
    g: Math.round(channel(hh) * 255),
    b: Math.round(channel(hh - 1 / 3) * 255),
  };
}

/** t=0 返回 a，t=1 返回 b */
export function mixHexColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp01(t);
  return rgbToHex(ca.r + (cb.r - ca.r) * k, ca.g + (cb.g - ca.g) * k, ca.b + (cb.b - ca.b) * k);
}

export function withAlpha(hex: string, alpha: number): string {
  const c = hexToRgb(hex);
  const a = Number(clamp01(alpha).toFixed(3));
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

/** WCAG 相对亮度（0 黑 ~ 1 白），用于自动挑黑/白前景色 */
export function relativeLuminance(hex: string): number {
  const c = hexToRgb(hex);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** 亮色底（黄/酸橙等）自动用深色字，暗色底用白字 */
export function onColor(hex: string): string {
  return relativeLuminance(hex) > 0.5 ? '#1B1B1F' : '#FFFFFF';
}

interface VariantConfig {
  /** 浅色主题主色向白色混合的比例 */
  lightMix: number;
  /** 深色主题主色向白色混合的比例（Material 3 深色主色更亮） */
  darkMix: number;
  sat: number;
  lightness: number;
  /** 伴随色（tertiary）的色相偏移 */
  hueShift: number;
  alphaLight: number;
  alphaDark: number;
  mediumLight: number;
  mediumDark: number;
}

const VARIANT_CONFIG: Record<AccentVariant, VariantConfig> = {
  material: { lightMix: 0, darkMix: 0.18, sat: 1, lightness: 1, hueShift: 40, alphaLight: 0.16, alphaDark: 0.2, mediumLight: 0.42, mediumDark: 0.36 },
  soft: { lightMix: 0.16, darkMix: 0.32, sat: 0.8, lightness: 1.04, hueShift: 24, alphaLight: 0.12, alphaDark: 0.16, mediumLight: 0.34, mediumDark: 0.3 },
  /**
   * 鲜艳（用户 2026-11-09：「现在的鲜艳根本没法用，颜色太突兀了，希望它灵动一些」）
   *
   * 旧参数三处叠加才会「炸」：sat×1.25 直接把饱和度顶到 100%、lightMix 0 完全不向白稀释、
   * hueShift 60° 让伴随色跑到隔壁色相族、medium 0.48 又把近半屏涂满饱和色。
   * 现在：饱和度只提 10%、主色向白混 8%（更透气）、伴随色回到 40°（同色系邻色）、
   * 中等浓度回落到 0.40 —— 亮而不刺眼，观感「灵动」而不是「荧光」。
   */
  vivid: { lightMix: 0.08, darkMix: 0.16, sat: 1.1, lightness: 0.97, hueShift: 40, alphaLight: 0.18, alphaDark: 0.22, mediumLight: 0.40, mediumDark: 0.36 },
  mono: { lightMix: 0, darkMix: 0.22, sat: 0.35, lightness: 1, hueShift: 0, alphaLight: 0.14, alphaDark: 0.18, mediumLight: 0.38, mediumDark: 0.34 },
};

export interface DerivedAccent {
  /** 原始种子色（未经变体调整） */
  seed: string;
  /** 当前明暗主题下的主色 */
  tint: string;
  tintSoft: string;
  /** 气泡等中等浓度染色 */
  tintMedium: string;
  onTint: string;
  /** 类似 PiliPlus ColorPalette 的 tertiary 分区 */
  tintAlt: string;
  /** 类似 primaryContainer 分区 */
  tintContainer: string;
  onTintContainer: string;
}

/** 一个种子色 → 一整套语义色（PiliPlus 的 SeedColorScheme 在本项目的最小等价实现） */
export function deriveAccentColors(seedHex: string, variant: AccentVariant, dark: boolean): DerivedAccent {
  const seed = normalizeHexColor(seedHex) || DEFAULT_ACCENT_COLOR;
  const cfg = VARIANT_CONFIG[normalizeVariant(variant)];
  const seedRgb = hexToRgb(seed);
  const base = rgbToHsl(seedRgb.r, seedRgb.g, seedRgb.b);
  const s = clamp01(base.s * cfg.sat);
  const l = clamp01(base.l * cfg.lightness);
  const coreRgb = hslToRgb(base.h, s, l);
  const core = rgbToHex(coreRgb.r, coreRgb.g, coreRgb.b);
  const tint = mixHexColor(core, '#FFFFFF', dark ? cfg.darkMix : cfg.lightMix);
  const altHsl = hslToRgb(base.h + cfg.hueShift, clamp01(s * 0.85), clamp01(dark ? l + 0.12 : l - 0.06));
  const tintAlt = rgbToHex(altHsl.r, altHsl.g, altHsl.b);
  const tintContainer = dark ? mixHexColor(tint, '#0B0B0F', 0.62) : mixHexColor(tint, '#FFFFFF', 0.78);
  return {
    seed,
    tint,
    tintSoft: withAlpha(tint, dark ? cfg.alphaDark : cfg.alphaLight),
    tintMedium: withAlpha(tint, dark ? cfg.mediumDark : cfg.mediumLight),
    onTint: onColor(tint),
    tintAlt,
    tintContainer,
    onTintContainer: onColor(tintContainer),
  };
}

/** 解析当前生效的种子色：动态取色 > 预设 > 自定义 > 品牌粉 */
export function resolveAccentSeed(opts: {
  presetId?: string | null;
  customHex?: string | null;
  dynamicHex?: string | null;
  dynamicEnabled?: boolean;
}): string {
  if (opts.dynamicEnabled) {
    const dyn = normalizeHexColor(opts.dynamicHex);
    if (dyn) return dyn;
  }
  // 预设查找覆盖「20 个通用预设 + 17 支队伍应援色」（队伍色 id 形如 team-SII）
  const preset = opts.presetId
    ? ACCENT_PRESETS.find((p) => p.id === opts.presetId) ||
      TEAM_ACCENT_PRESETS.find((p) => p.id === opts.presetId)
    : undefined;
  if (preset) return preset.color;
  if (opts.presetId === CUSTOM_ACCENT_PRESET) return normalizeHexColor(opts.customHex) || DEFAULT_ACCENT_COLOR;
  return normalizeHexColor(opts.customHex) || DEFAULT_ACCENT_COLOR;
}
