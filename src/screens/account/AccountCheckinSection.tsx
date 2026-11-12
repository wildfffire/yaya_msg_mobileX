/** 自动签到分区：开关 / 上次签到 / 立即签到（逻辑全在 useAccountProfile） */
import React from 'react';
import { Switch } from 'react-native';
import { Button } from '../../components/Button';
import { useI18n } from '../../i18n';
import { usePalette } from '../../theme';
import { AccountGroup, AccountRow, AccountStatusNote } from './AccountPrimitives';
import type { AccountProfileApi } from './useAccountProfile';

export default function AccountCheckinSection({ profile, first }: {
  profile: AccountProfileApi;
  first?: boolean;
}) {
  const { t } = useI18n();
  const palette = usePalette();

  return (
    <AccountGroup
      title={t('自动签到')}
      first={first}
      note={t('自动签到只在打开软件时触发一次，不会在后台消耗流量。')}
    >
      <AccountRow
        first
        icon="calendar-check-outline"
        title={t('开启自动签到')}
        subtitle={t('打开软件时自动完成当日签到')}
        right={(
          <Switch
            value={profile.autoCheckinEnabled}
            onValueChange={profile.setAutoCheckinEnabled}
            trackColor={{ true: palette.tint, false: palette.fill3 }}
            thumbColor="#FFFFFF"
            accessibilityLabel={t('开启自动签到')}
          />
        )}
      />
      <AccountRow
        icon="calendar-clock"
        title={t('上次签到')}
        value={profile.lastCheckinDate || t('尚未执行')}
      />
      <AccountRow
        icon="food-drumstick-outline"
        title={t('立即签到')}
        subtitle={t('每日签到可领鸡腿')}
        right={(
          <Button
            title={t('签到')}
            variant="filled"
            size="sm"
            onPress={() => void profile.checkinNow()}
            disabled={profile.checkinBusy}
            loading={profile.checkinBusy}
          />
        )}
      />
      <AccountStatusNote text={profile.checkinStatus} />
    </AccountGroup>
  );
}
