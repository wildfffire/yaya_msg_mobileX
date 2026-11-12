/**
 * 账号中心（2026-11-11 整体重构）。
 *
 * - 未登录：短信 / Token / B站扫码三种登录（宽屏左说明右表单、窄屏单列）
 * - 已登录：Hero 账号横幅（点头像/昵称弹「编辑资料」）+ 4 个分区
 *   「账号切换（含注销）/ 鸡腿充值 / 自动签到 / B站账号」
 * - 平板与横屏：左栏身份 + 分区导航，右栏当前分区（不再是 560 窄条居中）
 *
 * 逻辑层（usePocketAccount / useAccountProfile / useBiliLogin）一行未改，
 * 本次只重排 UI。
 */
import React, { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import ScreenHeader from '../components/ScreenHeader';
import { ScalePressable } from '../components/Motion';
import { useI18n } from '../i18n';
import { usePageBackground, usePalette } from '../theme';
import { useSettingsStore } from '../store';
import AccountHero from './account/AccountHero';
import AccountLayout from './account/AccountLayout';
import AccountLoginPanel from './account/AccountLoginPanel';
import AccountNav, { type AccountSectionId } from './account/AccountNav';
import AccountProfileModal from './account/AccountProfileModal';
import { AccountSectionView, accountNavItems } from './account/AccountSections';
import { accountAvatar, accountId, accountName, avatarUrl } from './account/accountParse';
import { accountStyles as s } from './account/accountStyles';
import { useAccountProfile } from './account/useAccountProfile';
import { useBiliLogin } from './account/useBiliLogin';
import { usePocketAccount } from './account/usePocketAccount';

const SECTION_ORDER: AccountSectionId[] = ['switch', 'recharge', 'checkin', 'bili'];

export default function AccountScreen() {
  const navigation = useNavigation<any>();
  const { t } = useI18n();
  const palette = usePalette();
  const background = usePageBackground();
  const settings = useSettingsStore((state) => state.settings);
  const loggedIn = !!settings.p48Token;

  /** 宽屏判据：平板竖屏（1200×1600）也要双栏，手机横屏（844×390）不硬上 */
  const { width, height } = useWindowDimensions();
  const wide = width >= 840 && height >= 480;

  const account = usePocketAccount();
  const profile = useAccountProfile(loggedIn);
  const bili = useBiliLogin();

  const [section, setSection] = useState<AccountSectionId>('switch');
  const [editing, setEditing] = useState(false);

  const users = account.accountInfo.users;
  const current = account.accountInfo.current;
  const currentId = accountId(current);
  const isMain = !!users.find((user) => accountId(user) === currentId)?.__isMain;
  const role: string | null = users.length ? (isMain ? t('主号') : t('小号')) : null;
  /** Hero 优先用「资料接口」的昵称/头像（改完立即反映），其次账号列表 */
  const name = profile.profileName || accountName(current, t('未命名账号'));
  const avatar = avatarUrl(profile.profileAvatar) || accountAvatar(current);

  const hero = (
    <AccountHero
      name={name}
      accountId={currentId}
      avatar={avatar}
      role={role}
      balance={profile.balance}
      lastCheckin={profile.lastCheckinDate}
      onEditProfile={() => setEditing(true)}
      onCopyToken={account.copyToken}
    />
  );

  const nav = wide ? (
    <AccountNav
      items={accountNavItems(account, t)}
      active={section}
      onChange={setSection}
      footer={t('账号凭证只保存在本机，不会上传到任何第三方服务器。')}
    />
  ) : undefined;

  const renderSections = () => {
    if (wide) {
      return (
        <AccountSectionView
          id={section}
          account={account}
          profile={profile}
          bili={bili}
          wide
          first
          onRecharge={() => navigation.navigate('RechargeScreen')}
        />
      );
    }
    return SECTION_ORDER.map((id) => (
      <AccountSectionView
        key={id}
        id={id}
        account={account}
        profile={profile}
        bili={bili}
        wide={false}
        onRecharge={() => navigation.navigate('RechargeScreen')}
      />
    ));
  };

  return (
    <View style={[s.container, { backgroundColor: background }]}>
      <ScreenHeader
        title={t('账号管理')}
        right={loggedIn ? (
          <ScalePressable
            onPress={() => void account.refreshAccountInfo()}
            accessibilityRole="button"
            accessibilityLabel={t('刷新账号列表')}
            pressedScale={0.9}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <View style={[s.headerIcon, { backgroundColor: palette.fill2 }]}>
              <MaterialCommunityIcons name="refresh" color={palette.tint} size={18} />
            </View>
          </ScalePressable>
        ) : undefined}
      />

      {loggedIn ? (
        <AccountLayout wide={wide} hero={hero} nav={nav}>
          {renderSections()}
        </AccountLayout>
      ) : (
        <AccountLoginPanel account={account} bili={bili} wide={wide} />
      )}

      <AccountProfileModal visible={loggedIn && editing} onClose={() => setEditing(false)} profile={profile} />
    </View>
  );
}
