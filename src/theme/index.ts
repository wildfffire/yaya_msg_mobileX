// 统一主题入口：iOS 26 风格 tokens
export { usePalette, usePageBackground, Palettes, Colors, DarkColors, semantic, accent, buildPalette, getAccentSeed } from './colors';
export type { Palette, PaletteName } from './colors';
export {
  ACCENT_PRESETS,
  ACCENT_VARIANTS,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_ACCENT_PRESET,
  CUSTOM_ACCENT_PRESET,
  normalizeHexColor,
  normalizeVariant,
  deriveAccentColors,
  resolveAccentSeed,
  hexToRgb,
  rgbToHex,
  withAlpha,
  mixHexColor,
  onColor,
} from './themeColors';
export type { AccentVariant, AccentPreset, DerivedAccent } from './themeColors';
export {
  TEAM_ACCENT_PRESETS,
  TEAM_PRESET_IDS,
  FIRST_ROW_TEAM_IDS,
  TEAM_PRESET_BY_ID,
  teamPresetId,
  teamOfPresetId,
} from './teamAccentPresets';
export { typography, fontFamily, screenTitle } from './typography';
export type { TypographyToken } from './typography';
export { spacing, insets } from './spacing';
export type { SpacingToken } from './spacing';
export { radii, radiiAlias } from './radii';
export type { RadiusToken } from './radii';
export { makeShadows } from './shadows';
export { motion } from './motion';
