import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import ScreenHeader from '../components/ScreenHeader';
import { CenterSpinner } from '../components/Loaders';
import { ScalePressable } from '../components/Motion';
import { ErrorState } from '../components/StateViews';
import { usePalette, radii } from '../theme';
import { useI18n } from '../i18n';

const RECHARGE_URL = 'https://live.48.cn/Recharge/';

/**
 * 鸡腿充值：直接铺官方充值页。
 *
 * 用户 2026-11-11 要求「把进去里面网页上面那一块删掉」——原来的余额卡整块删除；
 * 2026-11-12 补充「保留一个刷新按钮」：页头右侧一个刷新图标（重载官方充值页），
 * 余额仍在「我的 → 账号 → 鸡腿充值」看。
 */
export default function RechargeScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const [webError, setWebError] = useState('');
  const webViewRef = useRef<WebView>(null);

  const reloadWeb = () => {
    setWebError('');
    webViewRef.current?.reload();
  };

  return (
    <View style={styles.container}>
      <ScreenHeader
        title={t('鸡腿充值')}
        right={(
          <ScalePressable
            onPress={reloadWeb}
            accessibilityRole="button"
            accessibilityLabel={t('刷新')}
            pressedScale={0.9}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <View style={[styles.headerIcon, { backgroundColor: palette.fill2 }]}>
              <MaterialCommunityIcons name="refresh" color={palette.tint} size={18} />
            </View>
          </ScalePressable>
        )}
      />

      <View style={[styles.webCard, { borderColor: palette.hairline, overflow: 'hidden' }]}>
        <WebView
          ref={webViewRef}
          source={{ uri: RECHARGE_URL }}
          style={styles.web}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          mixedContentMode="always"
          startInLoadingState
          userAgent="Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 PocketFans201807"
          renderLoading={() => (
            <View style={styles.webLoading}>
              <CenterSpinner text={t('正在打开官方充值页...')} />
            </View>
          )}
          onError={(event) => setWebError(t('充值页加载失败：{msg}', { msg: String(event.nativeEvent.description).slice(0, 160) }))}
        />
        {webError ? (
          <View style={[styles.webErrorWrap, { backgroundColor: palette.background }]}>
            <ErrorState
              icon="web-off"
              title={t('充值页加载失败')}
              hint={webError}
              onAction={reloadWeb}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  /** 页头右侧刷新按钮（36 圆形，与账号页同一套） */
  headerIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  webCard: {
    flex: 1,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 12,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  web: { flex: 1, backgroundColor: '#FFFFFF' },
  webLoading: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  webErrorWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    padding: 32,
  },
});
