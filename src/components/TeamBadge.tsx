/**
 * 队伍应援色小标注（用户要求：直播/录播/主页/公演各处成员名旁按队伍应援色显示，
 * 预备生用灰色 —— TEAM_COLORS 已内置 '预备生': '#757575'）。
 * 2026-09-26：样式改为**应援色实底色块 + 自动黑/白字**（方案 A，用户确认），
 * 解决旧版淡遮罩在直播封面黑渐变上对比度过低、预备生几乎隐形的问题。
 *
 * - `team` 支持官方多种写法：'TEAM HII' / 'HII' / '预备生' / 'CII'
 * - label 统一去掉 'TEAM ' 前缀显示短名（HII / NII / X / 预备生 …）
 * - 颜色查不到时兜底灰（宁可不亮也不给错色）
 */
import React from 'react';
import { Text } from 'react-native';
import { TEAM_COLORS } from '../constants';

export function teamBadgeInfo(team?: string | null): { label: string; color: string } | null {
  const raw = String(team || '').trim();
  if (!raw) return null;
  const label = raw.replace(/^TEAM\s+/i, '').toUpperCase();
  const color =
    TEAM_COLORS[raw]
    || TEAM_COLORS[`TEAM ${label}`]
    || TEAM_COLORS[label]
    || '#757575';
  return { label: raw.includes('预备') ? '预备生' : label, color };
}

interface Props {
  team?: string | null;
  /** 字号（四列小卡里用 8，列表行里用 11） */
  fontSize?: number;
}

/** 相对亮度（0~1）：SII 浅蓝 / NIII 鲜黄这类亮色做文字时需要加深 */
function luminanceOf(hex: string): number | null {
  const m = String(hex || '').replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  if (full.length !== 6) return null;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 在某底色上取可读文字色：亮色底（如 SII 浅蓝 / NIII 鲜黄）用深字，其余白字 */
export function textOnColor(hex: string): string {
  const lum = luminanceOf(hex);
  if (lum === null) return '#FFFFFF';
  return lum > 0.62 ? '#1A1A1A' : '#FFFFFF';
}

/** 队伍标注统一样式：**应援色实底色块 + 自动黑/白字**（2026-09-26 用户确认方案 A）。
 *  旧版「同色半透明遮罩(alpha 0.18)+同色文字」叠在直播封面黑渐变上对比度过低（预备生灰底
 *  深灰字几乎隐形），改为实底后任何背景下可辨；文字用 textOnColor 自动配字，
 *  亮色底（SII/X/NIII/K）配深字、深色底（Z/B/J/C/CII/预备生）配白字。 */
export default function TeamBadge({ team, fontSize = 9 }: Props) {
  const info = teamBadgeInfo(team);
  if (!info) return null;
  // 预备生：灰底白字对比度已足够，减少加粗（900→600）避免三个字过于厚重（用户反馈 2026-09-26）
  const isPrep = String(team || '').includes('预备');
  return (
    <Text
      style={{
        color: textOnColor(info.color),
        fontSize,
        fontWeight: isPrep ? '600' : '900',
        backgroundColor: info.color,
        paddingHorizontal: 4,
        paddingVertical: 1,
        borderRadius: 5,
        overflow: 'hidden',
      }}
      numberOfLines={1}
    >
      {info.label}
    </Text>
  );
}
