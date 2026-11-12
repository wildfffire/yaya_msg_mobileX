/**
 * Hero 账号横幅（2026-11-11 重构定版）。
 *
 * 手机与平板共用同一形态（竖排大横幅）：手机端也要求「那个 hero」，
 * 不再有旧的横排紧凑变体。头像与昵称本身就是「编辑资料」弹窗入口，
 * 所以列表里不再单列「头像 / 昵称 / 改名次数」三行。
 */
import React from 'react';
import { Text, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { Button } from '../../components/Button';
import { GlassSurface } from '../../components/GlassSurface';
import { ScalePressable } from '../../components/Motion';
import { useI18n } from '../../i18n';
import { usePalette, radii } from '../../theme';
import { AccountAvatar } from './AccountPrimitives';
import { accountStyles as s } from './accountStyles';

export interface AccountHeroProps {
  name: string;
  accountId: string;
  avatar: string;
  /** 已翻译的「主号 / 小号」；拿不到账号列表时传 null（不显示胶囊） */
  role: string | null;
  balance: string | null;
  lastCheckin: string;
  onEditProfile: () => void;
  onCopyToken: () => void;
}

export default function AccountHero({
  name, accountId, avatar, role, balance, lastCheckin, onEditProfile, onCopyToken,
}: AccountHeroProps) {
  const { t } = useI18n();
  const palette = usePalette();

  return (
    <GlassSurface role="card" radius={radii.lg} style={s.hero}>
      <View style={s.heroTop}>
        <ScalePressable
          onPress={onEditProfile}
          pressedScale={0.96}
          style={s.heroAvatarBtn}
          accessibilityRole="button"
          accessibilityLabel={t('修改头像与昵称')}
        >
          <AccountAvatar uri={avatar} size={72} name={name} />
          <View style={[s.heroPen, { borderColor: palette.hairline, backgroundColor: palette.surface }]}>
            <MaterialCommunityIcons name="pencil" size={12} color={palette.labelSecondary} />
          </View>
        </ScalePressable>

        <ScalePressable
          onPress={onEditProfile}
          pressedScale={0.97}
          style={s.heroNameBtn}
          accessibilityRole="button"
          accessibilityLabel={t('修改昵称')}
        >
          <Text style={[s.heroName, { color: palette.label }]} numberOfLines={1}>{name}</Text>
          <MaterialCommunityIcons name="pencil" size={14} color={palette.labelTertiary} />
        </ScalePressable>

        <View style={s.heroSub}>
          <Text style={[s.heroId, { color: palette.labelTertiary }]}>
            {t('ID: {id}', { id: accountId || '--' })}
          </Text>
          {role ? (
            <View style={[s.heroBadge, { backgroundColor: palette.tintSoft }]}>
              <Text style={[s.heroBadgeText, { color: palette.tint }]}>{role}</Text>
            </View>
          ) : null}
        </View>

        <View style={s.heroStatus}>
          <View style={[s.heroDot, { backgroundColor: palette.success }]} />
          <Text style={[s.heroStatusText, { color: palette.labelSecondary }]}>
            {t('已登录 · 口袋48')}
          </Text>
        </View>

        <View style={s.heroActions}>
          <Button
            title={t('复制 Token')}
            variant="filled"
            size="sm"
            onPress={onCopyToken}
            style={{ flex: 1 }}
            icon={<MaterialCommunityIcons name="content-copy" size={14} color="#FFFFFF" />}
          />
        </View>
      </View>

      <View style={[s.heroMetrics, { borderTopColor: palette.hairline }]}>
        <View style={s.metric}>
          <Text style={[s.metricNum, { color: palette.label }]} numberOfLines={1}>{balance || '--'}</Text>
          <Text style={[s.metricLabel, { color: palette.labelTertiary }]}>{t('鸡腿余额')}</Text>
        </View>
        <View style={[s.metric, s.metricSecond, { borderLeftColor: palette.hairline }]}>
          <Text style={[s.metricNum, { color: palette.label }]} numberOfLines={1}>{lastCheckin || t('尚未执行')}</Text>
          <Text style={[s.metricLabel, { color: palette.labelTertiary }]}>{t('上次签到')}</Text>
        </View>
      </View>
    </GlassSurface>
  );
}
