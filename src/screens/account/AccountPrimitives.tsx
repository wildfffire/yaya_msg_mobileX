/**
 * 账号域基元（2026-11-11 重构）。
 *
 * 与 SettingsScreen 内部的 Section / Row 同源（图标底 + 标题 + 右侧控件 + 分割线），
 * 但不抽改设置页的私有实现，避免波及另一个页面。
 * 描边一律交给 GlassSurface，这里不写 borderWidth / borderColor。
 */
import React from 'react';
import { StyleProp, Text, View, ViewStyle } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { GlassSurface } from '../../components/GlassSurface';
import { ScalePressable } from '../../components/Motion';
import { NetworkImage } from '../../components/NetworkImage';
import { usePalette, radii } from '../../theme';
import { statusTone } from './accountParse';
import { accountStyles as s } from './accountStyles';

const DANGER_SOFT = 'rgba(255,59,48,0.10)';

/** 圆形头像：有图走 NetworkImage（带缩略图省流量），无图用首字母 / 图标兜底 */
export function AccountAvatar({ uri, size = 40, name, icon = 'account' }: {
  uri?: string;
  size?: number;
  name?: string;
  icon?: string;
}) {
  const palette = usePalette();
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (uri) {
    return <NetworkImage source={{ uri }} style={box} resizeMode="cover" thumbnail={Math.round(size * 2)} />;
  }
  const letter = String(name || '').trim().slice(0, 1);
  return (
    <View style={[box, { alignItems: 'center', justifyContent: 'center', backgroundColor: palette.tintSoft }]}>
      {letter ? (
        <Text style={{ color: palette.tint, fontSize: Math.round(size * 0.4), fontWeight: '800' }}>{letter}</Text>
      ) : (
        <MaterialCommunityIcons name={icon} color={palette.tint} size={Math.round(size * 0.5)} />
      )}
    </View>
  );
}

/** 分组：组标题在卡外（14/700），卡内是若干 AccountRow，脚注 11.5/17 */
export function AccountGroup({ title, right, note, first, children }: {
  title: string;
  right?: React.ReactNode;
  note?: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={[s.group, first ? s.groupFirst : null]}>
      <View style={s.groupHead}>
        <Text style={[s.groupTitle, { color: palette.label }]}>{title}</Text>
        {right}
      </View>
      <GlassSurface role="card" radius={radii.lg} style={s.card}>
        {children}
      </GlassSurface>
      {note ? <Text style={[s.groupNote, { color: palette.labelTertiary }]}>{note}</Text> : null}
    </View>
  );
}

export interface AccountRowProps {
  /** MaterialCommunityIcons 图标名 */
  icon: string;
  title: string;
  subtitle?: string;
  /** 右侧纯文本值（单行截断），与 right 互斥 */
  value?: string;
  /** 右侧任意控件（Button / Switch / 头像 …） */
  right?: React.ReactNode;
  onPress?: () => void;
  danger?: boolean;
  /** 分组第一行：不画上分割线 */
  first?: boolean;
  /** 是否显示右箭头，默认「可点且非危险行」 */
  chevron?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}

export function AccountRow({
  icon, title, subtitle, value, right, onPress, danger, first, chevron, disabled, accessibilityLabel,
}: AccountRowProps) {
  const palette = usePalette();
  const showChevron = chevron ?? (!!onPress && !danger);

  const body = (
    <>
      {first ? null : <View style={[s.rowDivider, { borderTopColor: palette.hairline }]} />}
      <View style={[s.rowIcon, { backgroundColor: danger ? DANGER_SOFT : palette.tintSoft }]}>
        <MaterialCommunityIcons name={icon} size={16} color={danger ? palette.danger : palette.tint} />
      </View>
      <View style={s.rowMain}>
        <Text style={[s.rowTitle, { color: danger ? palette.danger : palette.label }]}>{title}</Text>
        {subtitle ? (
          <Text style={[s.rowSub, { color: palette.labelTertiary }]} numberOfLines={2}>{subtitle}</Text>
        ) : null}
      </View>
      {value ? (
        <Text style={[s.rowValue, { color: palette.labelTertiary }]} numberOfLines={1}>{value}</Text>
      ) : null}
      {right ? <View style={s.rowRight}>{right}</View> : null}
      {showChevron ? (
        <MaterialCommunityIcons name="chevron-right" size={20} color={palette.labelTertiary} />
      ) : null}
    </>
  );

  if (!onPress) return <View style={s.row}>{body}</View>;

  return (
    <ScalePressable
      style={s.row}
      onPress={onPress}
      disabled={disabled}
      pressedScale={0.985}
      activeOpacity={0.9}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
    >
      {body}
    </ScalePressable>
  );
}

/** 操作结果提示：按 statusTone 出绿/红/蓝底 + 图标，取代裸灰字状态文本 */
export function AccountStatusNote({ text, style }: { text: string; style?: StyleProp<ViewStyle> }) {
  const palette = usePalette();
  if (!text) return null;
  const tone = statusTone(text);
  const color = tone === 'success' ? palette.success : tone === 'danger' ? palette.danger : palette.info;
  const background = tone === 'success'
    ? 'rgba(52,199,89,0.10)'
    : tone === 'danger'
      ? 'rgba(255,59,48,0.085)'
      : 'rgba(90,200,250,0.13)';
  const icon = tone === 'success' ? 'check-circle' : tone === 'danger' ? 'alert-circle' : 'information-outline';
  return (
    <View style={[s.status, { backgroundColor: background }, style]}>
      <MaterialCommunityIcons name={icon} size={15} color={color} style={{ marginTop: 1 }} />
      <Text style={[s.statusText, { color }]}>{text}</Text>
    </View>
  );
}

/** 分组内的空态行 */
export function AccountEmptyRow({ text }: { text: string }) {
  const palette = usePalette();
  return (
    <View style={s.emptyRow}>
      <Text style={[s.emptyText, { color: palette.labelSecondary }]}>{text}</Text>
    </View>
  );
}
