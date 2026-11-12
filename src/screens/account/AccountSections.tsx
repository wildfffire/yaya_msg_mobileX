/**
 * 账号中心分区视图（2026-11-11 重构定版）。
 *
 * 分区收敛为 4 个：账号切换 / 鸡腿充值 / 自动签到 / B站账号。
 * 旧的「账号与安全」已并入「账号切换」——登录状态、账号 ID、Token 三行按用户要求删除，
 * 头像与昵称改由 Hero 弹窗编辑；资料与余额更名「鸡腿充值」。
 */
import React from 'react';
import { Text, View, type DimensionValue } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { Button } from '../../components/Button';
import { useI18n } from '../../i18n';
import { usePalette } from '../../theme';
import { accountAvatar, accountId, accountName } from './accountParse';
import { AccountAvatar, AccountEmptyRow, AccountGroup, AccountRow } from './AccountPrimitives';
import type { AccountNavItem, AccountSectionId } from './AccountNav';
import AccountBiliSection from './AccountBiliSection';
import AccountCheckinSection from './AccountCheckinSection';
import { accountStyles as s } from './accountStyles';
import type { PocketAccountApi } from './usePocketAccount';
import type { AccountProfileApi } from './useAccountProfile';
import type { BiliLoginApi } from './useBiliLogin';

/** 分区导航项（宽屏左栏用；账号数量作为右侧小徽标） */
export function accountNavItems(account: PocketAccountApi, t: (key: string) => string): AccountNavItem[] {
  const count = account.accountInfo.users.length;
  return [
    { id: 'switch', label: t('账号切换'), icon: 'account-switch', count: count || undefined },
    { id: 'recharge', label: t('鸡腿充值'), icon: 'food-drumstick-outline' },
    { id: 'checkin', label: t('自动签到'), icon: 'calendar-check-outline' },
    { id: 'bili', label: t('B站账号'), icon: 'television-classic' },
  ];
}

function AccountCard({ user, isCurrent, width, switching, onSwitch }: {
  user: any;
  isCurrent: boolean;
  width: DimensionValue;
  switching: boolean;
  onSwitch: () => void;
}) {
  const { t } = useI18n();
  const palette = usePalette();
  const id = accountId(user);
  const name = accountName(user, t('未命名账号'));
  const isMain = !!user?.__isMain;

  return (
    <View
      style={[
        s.accCard,
        { width, borderColor: isCurrent ? palette.tint : palette.hairline, backgroundColor: palette.surface },
      ]}
    >
      <AccountAvatar uri={accountAvatar(user)} size={40} name={name} />
      <View style={s.accMain}>
        <View style={s.accNameRow}>
          <Text style={[s.accName, { color: palette.label }]} numberOfLines={1}>{name}</Text>
          <View style={[s.accRole, { backgroundColor: isMain ? palette.tintSoft : palette.fill3 }]}>
            <Text style={[s.accRoleText, { color: isMain ? palette.tint : palette.labelSecondary }]}>
              {isMain ? t('主号') : t('小号')}
            </Text>
          </View>
        </View>
        <Text style={[s.accId, { color: palette.labelTertiary }]} numberOfLines={1}>ID: {id || '--'}</Text>
      </View>
      {isCurrent ? (
        <View style={s.accCur}>
          <MaterialCommunityIcons name="check" size={14} color={palette.tint} />
          <Text style={[s.accCurText, { color: palette.tint }]}>{t('当前')}</Text>
        </View>
      ) : (
        <Button
          title={switching ? t('切换中') : t('切换')}
          variant="filled"
          size="sm"
          onPress={onSwitch}
          disabled={switching}
          loading={switching}
        />
      )}
    </View>
  );
}

/** 账号切换：主号/小号网格 + 注销（宽屏两列、窄屏单列） */
export function AccountSwitchSection({ account, wide, first }: {
  account: PocketAccountApi;
  wide: boolean;
  first?: boolean;
}) {
  const { t } = useI18n();
  const currentId = accountId(account.accountInfo.current);
  const users = account.accountInfo.users;

  return (
    <AccountGroup
      title={t('账号切换')}
      first={first}
      right={(
        <Button
          title={t('刷新账号列表')}
          variant="tinted"
          size="sm"
          onPress={() => void account.refreshAccountInfo()}
          disabled={account.loading}
          loading={account.loading}
        />
      )}
      note={t('点头像或昵称可修改资料；切换账号会让房间与私信列表一起切换。')}
    >
      {users.length ? (
        <View style={s.accGrid}>
          {users.map((user) => {
            const id = accountId(user);
            return (
              <AccountCard
                key={id || accountName(user, t('未命名账号'))}
                user={user}
                isCurrent={!!id && id === currentId}
                width={wide ? '48%' : '100%'}
                switching={account.switchingUserId === id}
                onSwitch={() => void account.switchAccount(user)}
              />
            );
          })}
        </View>
      ) : (
        <AccountEmptyRow text={t('没有读取到大小号列表；保存 Token 后点「刷新账号列表」。')} />
      )}

      <AccountRow
        icon="logout"
        title={t('注销 / 更换账号')}
        subtitle={t('清除本机 Token 并重建云信会话')}
        danger
        onPress={() => void account.logout()}
      />
    </AccountGroup>
  );
}

/** 鸡腿充值：大幅余额 + 充值 / 刷新 */
export function AccountRechargeSection({ profile, onRecharge, first }: {
  profile: AccountProfileApi;
  onRecharge: () => void;
  first?: boolean;
}) {
  const { t } = useI18n();
  const palette = usePalette();

  return (
    <AccountGroup
      title={t('鸡腿充值')}
      first={first}
      note={t('充值跳转口袋48官方充值页，支付渠道与到账时间以官方为准。')}
    >
      <View style={[s.amountBox, { borderBottomColor: palette.hairline }]}>
        <Text style={[s.amountLabel, { color: palette.labelTertiary }]}>{t('当前余额')}</Text>
        <View style={s.amountRow}>
          <Text style={[s.amountNum, { color: palette.label }]}>{profile.balance ?? '--'}</Text>
          <Text style={[s.amountUnit, { color: palette.labelTertiary }]}>{t('鸡腿')}</Text>
        </View>
        <View style={s.amountActions}>
          <Button
            title={t('鸡腿充值')}
            variant="filled"
            size="sm"
            onPress={onRecharge}
            style={{ flex: 1 }}
            icon={<MaterialCommunityIcons name="food-drumstick" size={14} color="#FFFFFF" />}
          />
          <Button
            title={t('刷新余额')}
            variant="tinted"
            size="sm"
            onPress={() => void profile.refreshBalance()}
          />
        </View>
      </View>
    </AccountGroup>
  );
}

/** 分区路由：宽屏只渲染当前分区，窄屏由容器按顺序全部渲染 */
export function AccountSectionView({ id, account, profile, bili, wide, onRecharge, first }: {
  id: AccountSectionId;
  account: PocketAccountApi;
  profile: AccountProfileApi;
  bili: BiliLoginApi;
  wide: boolean;
  onRecharge: () => void;
  first?: boolean;
}) {
  switch (id) {
    case 'switch':
      return <AccountSwitchSection account={account} wide={wide} first={first} />;
    case 'recharge':
      return <AccountRechargeSection profile={profile} onRecharge={onRecharge} first={first} />;
    case 'checkin':
      return <AccountCheckinSection profile={profile} first={first} />;
    case 'bili':
      return <AccountBiliSection bili={bili} first={first} />;
    default:
      return null;
  }
}
