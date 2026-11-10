/**
 * 队伍应援色 → 主题色预设（用户 2026-11-09：「根据每个队伍的应援色设计主题配色」）
 *
 * 单一数据源是 `src/constants` 的 TEAM_COLORS（与 TeamBadge 完全同源，避免两套色值打架）。
 * 这里只做「预设形状」的派生：id = `team-<队名>`，label = 队名原文（不翻译，队名是专有名词）。
 *
 * 纯数据模块（不依赖 React / zustand），可进 Node 单测。
 */
import { TEAM_COLORS } from '../constants';
import type { AccentPreset } from './themeColors';

/** 展示顺序：按团队归属（SNH48 → GNZ48 → BEJ48 → CKG48 → CGT48 → IDFT） */
export const TEAM_PRESET_IDS = [
  'SII',
  'NII',
  'HII',
  'X',
  'G',
  'NIII',
  'Z',
  'B',
  'E',
  'J',
  'C',
  'K',
  'CII',
  'GII',
  'IDFT',
] as const;

export type TeamPresetId = (typeof TEAM_PRESET_IDS)[number];

/** 主题色第一排默认露出的 6 支队伍（自定义 + 这 6 个 = 一排） */
export const FIRST_ROW_TEAM_IDS: TeamPresetId[] = ['SII', 'NII', 'HII', 'X', 'G', 'NIII'];

/** `team-SII` 形式的主色 id（写进 AppSettings.accentPreset） */
export function teamPresetId(team: TeamPresetId | string): string {
  return `team-${team}`;
}

/** 从预设 id 反解队名；不是队伍色则返回 null */
export function teamOfPresetId(presetId?: string | null): string | null {
  if (!presetId || !presetId.startsWith('team-')) return null;
  const team = presetId.slice(5);
  return team ? team : null;
}

export const TEAM_ACCENT_PRESETS: AccentPreset[] = TEAM_PRESET_IDS.map((team) => ({
  id: teamPresetId(team),
  label: team,
  color: TEAM_COLORS[`TEAM ${team}`] || TEAM_COLORS[team] || '#757575',
}));

export const TEAM_PRESET_BY_ID: Record<string, AccentPreset> = TEAM_ACCENT_PRESETS.reduce(
  (acc, p) => {
    acc[p.id] = p;
    return acc;
  },
  {} as Record<string, AccentPreset>,
);
