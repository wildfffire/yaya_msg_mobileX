/**
 * B站账号分区。
 * 二维码 WebView 懒挂载：只有点过「获取B站登录二维码」（qrHtml 有值）才渲染，
 * 首屏不会为了一个可能用不到的二维码起 WebView。
 */
import React from 'react';
import { Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Button } from '../../components/Button';
import { useI18n } from '../../i18n';
import { usePalette } from '../../theme';
import { AccountGroup, AccountRow, AccountStatusNote } from './AccountPrimitives';
import { accountStyles as s } from './accountStyles';
import type { BiliLoginApi } from './useBiliLogin';

export default function AccountBiliSection({ bili, first }: {
  bili: BiliLoginApi;
  first?: boolean;
}) {
  const { t } = useI18n();
  const palette = usePalette();
  /** 初始状态「B站未登录」不铺红条 —— 行副标题已经说清楚了 */
  const showNote = !!bili.biliStatus && bili.biliStatus !== t('B站未登录');

  return (
    <AccountGroup
      title={t('B站账号')}
      first={first}
      right={bili.loggedIn ? (
        <View style={[s.heroBadge, { backgroundColor: 'rgba(52,199,89,0.12)' }]}>
          <Text style={[s.heroBadgeText, { color: palette.success }]}>{t('已登录')}</Text>
        </View>
      ) : undefined}
      note={t('扫码后在 App 内确认即可，二维码 2 分钟内有效，过期可点击刷新。')}
    >
      <AccountRow
        first
        icon="television-classic"
        title={t('B站登录状态')}
        subtitle={bili.loggedIn
          ? `${t('已登录')}${bili.biliName ? ` · ${bili.biliName}` : ''}`
          : t('B站未登录')}
        right={(
          <Button
            title={t('刷新状态')}
            variant="tinted"
            size="sm"
            onPress={() => void bili.refreshStatus()}
          />
        )}
      />

      {bili.qrHtml ? (
        <>
          <View style={s.qrWrap}>
            <View style={s.qrCard}>
              <WebView
                source={{ html: bili.qrHtml }}
                style={s.qr}
                originWhitelist={['*']}
                scrollEnabled={false}
              />
            </View>
          </View>
          <AccountRow
            icon="refresh"
            title={t('刷新B站二维码')}
            onPress={() => void bili.generateQr()}
            disabled={bili.qrLoading}
          />
        </>
      ) : (
        <AccountRow
          icon="qrcode"
          title={t('获取B站登录二维码')}
          subtitle={t('用B站App扫码登录')}
          onPress={() => void bili.generateQr()}
          disabled={bili.qrLoading}
        />
      )}

      {showNote ? <AccountStatusNote text={bili.biliStatus} /> : null}

      {bili.loggedIn ? (
        <AccountRow
          icon="logout"
          title={t('退出 B站登录')}
          subtitle={t('清除本地 Cookie')}
          danger
          onPress={() => void bili.logout()}
        />
      ) : null}
    </AccountGroup>
  );
}
