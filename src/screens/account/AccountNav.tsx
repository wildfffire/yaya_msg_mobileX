/**
 * 分区导航（仅宽屏左栏渲染）。
 * 选中项 = tintSoft 底 + 左侧 3dp tint 竖条 + 图标/文字转 tint，
 * 右侧可带账号数量这类小徽标。
 */
import React from 'react';
import { Text, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { ScalePressable } from '../../components/Motion';
import { useI18n } from '../../i18n';
import { usePalette } from '../../theme';
import { accountStyles as s } from './accountStyles';

export type AccountSectionId = 'switch' | 'recharge' | 'checkin' | 'bili';

export interface AccountNavItem {
  id: AccountSectionId;
  label: string;
  icon: string;
  /** 例如账号数量 */
  count?: number;
}

export default function AccountNav({ items, active, onChange, footer }: {
  items: AccountNavItem[];
  active: AccountSectionId;
  onChange: (id: AccountSectionId) => void;
  footer?: string;
}) {
  const { t } = useI18n();
  const palette = usePalette();

  return (
    <>
      <View style={s.nav}>
        <Text style={[s.navTitle, { color: palette.labelTertiary }]}>{t('账号设置')}</Text>
        {items.map((item) => {
          const isOn = item.id === active;
          return (
            <ScalePressable
              key={item.id}
              onPress={() => onChange(item.id)}
              style={[s.navItem, isOn ? { backgroundColor: palette.tintSoft } : null]}
              pressedScale={0.98}
              activeOpacity={0.9}
              accessibilityRole="button"
              accessibilityState={{ selected: isOn }}
              accessibilityLabel={item.label}
            >
              {isOn ? <View style={[s.navBar, { backgroundColor: palette.tint }]} /> : null}
              <MaterialCommunityIcons
                name={item.icon}
                size={18}
                color={isOn ? palette.tint : palette.labelSecondary}
              />
              <Text
                style={[s.navLabel, { color: isOn ? palette.tint : palette.labelSecondary }]}
                numberOfLines={1}
              >
                {item.label}
              </Text>
              {item.count ? (
                <Text style={[s.navCount, { color: isOn ? palette.tint : palette.labelTertiary }]}>
                  {item.count}
                </Text>
              ) : null}
            </ScalePressable>
          );
        })}
      </View>
      {footer ? (
        <Text style={[s.railFoot, { color: palette.labelTertiary }]}>{footer}</Text>
      ) : null}
    </>
  );
}
