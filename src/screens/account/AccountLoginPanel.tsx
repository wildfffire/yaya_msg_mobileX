/**
 * 未登录态：短信 / Token / B站扫码三种登录（2026-11-11 重构）。
 *
 * 宽屏 = 左品牌说明栏 + 右表单栏；窄屏 = 品牌小条 + 分段 + 表单。
 * 三种登录方式与左右横划切换手势沿用旧实现，逻辑全在 usePocketAccount / useBiliLogin。
 */
import React, { useCallback, useRef, useState } from 'react';
import { Animated, PanResponder, ScrollView, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { Button } from '../../components/Button';
import { GlassSegmented } from '../../components/GlassSegmented';
import { GlassSurface } from '../../components/GlassSurface';
import { ScalePressable } from '../../components/Motion';
import { useI18n } from '../../i18n';
import { usePalette, radii } from '../../theme';
import { AccountStatusNote } from './AccountPrimitives';
import { maskToken } from './accountParse';
import { accountStyles as s } from './accountStyles';
import type { PocketAccountApi } from './usePocketAccount';
import type { BiliLoginApi } from './useBiliLogin';

type LoginMode = 'sms' | 'token' | 'bilibili';
const LOGIN_MODES: LoginMode[] = ['sms', 'token', 'bilibili'];

const BENEFITS = [
  '房间消息、私信与未读角标实时同步',
  '大号 / 小号一键切换，凭证只保存在本机',
  'B站账号可单独扫码绑定，看播不串号',
];

function BrandCard({ wide }: { wide: boolean }) {
  const { t } = useI18n();
  const palette = usePalette();
  return (
    <GlassSurface role="card" radius={radii.lg} style={s.brandCard}>
      <View style={[s.brandLogo, { backgroundColor: palette.tintSoft }]}>
        <MaterialCommunityIcons name="message-processing-outline" size={30} color={palette.tint} />
      </View>
      <Text style={[s.brandName, { color: palette.label }]}>{t('牙牙消息')}</Text>
      <Text style={[s.brandDesc, { color: palette.labelSecondary }]}>
        {t('登录口袋48账号后，才能收发私信、进入房间查看偶像动态。')}
      </Text>
      {wide ? BENEFITS.map((item) => (
        <View key={item} style={s.benefitRow}>
          <MaterialCommunityIcons name="check-circle" size={15} color={palette.success} style={{ marginTop: 2 }} />
          <Text style={[s.benefitText, { color: palette.labelSecondary }]}>{t(item)}</Text>
        </View>
      )) : null}
    </GlassSurface>
  );
}

export default function AccountLoginPanel({ account, bili, wide }: {
  account: PocketAccountApi;
  bili: BiliLoginApi;
  wide: boolean;
}) {
  const { t } = useI18n();
  const palette = usePalette();
  const [mode, setMode] = useState<LoginMode>('sms');
  const modeSlide = useRef(new Animated.Value(0)).current;
  const modeRef = useRef<LoginMode>('sms');
  modeRef.current = mode;

  const switchMode = useCallback((next: LoginMode, dir?: 1 | -1) => {
    if (next === modeRef.current) return;
    const from = LOGIN_MODES.indexOf(modeRef.current);
    const to = LOGIN_MODES.indexOf(next);
    const d: 1 | -1 = dir ?? (to > from ? 1 : -1);
    modeSlide.stopAnimation();
    Animated.timing(modeSlide, { toValue: d * -56, duration: 110, useNativeDriver: true }).start(() => {
      setMode(next);
      modeRef.current = next;
      modeSlide.setValue(d * 56);
      Animated.spring(modeSlide, { toValue: 0, tension: 240, friction: 26, useNativeDriver: true }).start();
    });
  }, [modeSlide]);
  const switchModeRef = useRef(switchMode);
  switchModeRef.current = switchMode;

  const modePan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderRelease: (_, g) => {
      if (Math.abs(g.dx) < 40) return;
      const idx = LOGIN_MODES.indexOf(modeRef.current);
      const next = LOGIN_MODES[idx + (g.dx < 0 ? 1 : -1)];
      if (next) switchModeRef.current(next, g.dx < 0 ? 1 : -1);
    },
  })).current;

  const segments: { key: LoginMode; label: string }[] = [
    { key: 'sms', label: t('短信验证码') },
    { key: 'token', label: t('Token') },
    { key: 'bilibili', label: t('B站二维码') },
  ];

  const noteStyle = { marginHorizontal: 0, marginBottom: 0 };

  const smsCard = (
    <GlassSurface role="card" radius={radii.lg} style={s.loginCard}>
      <Text style={[s.cardTitle, { color: palette.label }]}>{t('口袋48验证码登录')}</Text>
      <View style={s.phoneRow}>
        <View style={[s.field, s.areaWrap, { backgroundColor: palette.fill2, borderColor: palette.innerStroke }]}>
          <Text style={[s.areaPlus, { color: palette.label }]}>+</Text>
          <TextInput
            style={[s.areaInput, { color: palette.label }]}
            placeholder="86"
            placeholderTextColor={palette.labelTertiary}
            keyboardType="phone-pad"
            maxLength={5}
            value={account.area}
            onChangeText={(v) => account.setArea(v.replace(/[^0-9]/g, '').slice(0, 5))}
          />
        </View>
        <TextInput
          style={[s.field, s.phoneInput, { backgroundColor: palette.fill2, borderColor: palette.innerStroke, color: palette.label }]}
          placeholder={t('手机号')}
          placeholderTextColor={palette.labelTertiary}
          keyboardType="phone-pad"
          value={account.phone}
          onChangeText={account.setPhone}
        />
      </View>
      <TextInput
        style={[s.field, { backgroundColor: palette.fill2, borderColor: palette.innerStroke, color: palette.label }]}
        placeholder={t('短信验证码')}
        placeholderTextColor={palette.labelTertiary}
        keyboardType="number-pad"
        value={account.code}
        onChangeText={account.setCode}
        maxLength={8}
      />
      {account.verify ? (
        <View style={[s.verifyBox, { backgroundColor: palette.fill2, borderColor: palette.innerStroke }]}>
          <Text style={[s.verifyQuestion, { color: palette.label }]}>{account.verify.question}</Text>
          <View style={s.verifyOptions}>
            {account.verify.options.map((option) => (
              <ScalePressable
                key={option}
                onPress={() => void account.sendSms(option)}
                disabled={account.loading}
                pressedScale={0.94}
                hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
              >
                <View style={[s.verifyOption, { borderColor: palette.innerStroke, backgroundColor: palette.surface }]}>
                  <Text style={[s.verifyOptionText, { color: palette.label }]}>{option}</Text>
                </View>
              </ScalePressable>
            ))}
          </View>
        </View>
      ) : null}
      <View style={s.btnCol}>
        <Button title={t('获取验证码')} variant="tinted" size="md" onPress={() => void account.sendSms()} disabled={account.loading} fullWidth />
        <Button title={t('登录')} variant="filled" size="md" onPress={() => void account.loginByCode()} disabled={account.loading} loading={account.loading} fullWidth />
      </View>
      {account.status ? <AccountStatusNote text={account.status} style={noteStyle} /> : null}
    </GlassSurface>
  );

  const tokenCard = (
    <GlassSurface role="card" radius={radii.lg} style={s.loginCard}>
      <Text style={[s.cardTitle, { color: palette.label }]}>{t('口袋48Token登录')}</Text>
      <TextInput
        style={[s.field, s.tokenInput, { backgroundColor: palette.fill2, borderColor: palette.innerStroke, color: palette.label }]}
        placeholder={t('粘贴口袋token')}
        placeholderTextColor={palette.labelTertiary}
        value={account.manualToken}
        onChangeText={account.setManualToken}
        numberOfLines={1}
      />
      <View style={s.btnCol}>
        <Button title={t('检查Token')} variant="tinted" size="md" onPress={() => void account.checkToken()} disabled={account.loading} fullWidth />
        <Button title={t('保存Token')} variant="filled" size="md" onPress={() => void account.saveManualToken()} disabled={account.loading} loading={account.loading} fullWidth />
      </View>
      {account.token ? (
        <Text style={[s.tokenInfo, { color: palette.labelTertiary }]} numberOfLines={2}>
          {t('已保存Token：{token}', { token: maskToken(account.token) })}
        </Text>
      ) : null}
      {account.status ? <AccountStatusNote text={account.status} style={noteStyle} /> : null}
    </GlassSurface>
  );

  const biliCard = (
    <GlassSurface role="card" radius={radii.lg} style={s.loginCard}>
      <Text style={[s.cardTitle, { color: palette.label }]}>{t('B站登录')}</Text>
      {bili.qrHtml ? (
        <View style={s.qrWrap}>
          <View style={s.qrCard}>
            <WebView source={{ html: bili.qrHtml }} style={s.qr} originWhitelist={['*']} scrollEnabled={false} />
          </View>
        </View>
      ) : (
        <View style={s.qrWrap}>
          <View style={[s.qrPlaceholder, { backgroundColor: palette.fill2 }]}>
            <MaterialCommunityIcons name="qrcode" color={palette.labelTertiary} size={56} />
          </View>
        </View>
      )}
      {bili.biliStatus ? <AccountStatusNote text={bili.biliStatus} style={noteStyle} /> : null}
      <View style={[s.btnCol, { marginTop: 12 }]}>
        <Button
          title={bili.qrHtml ? t('刷新B站二维码') : t('获取B站登录二维码')}
          variant="filled"
          size="md"
          onPress={() => void bili.generateQr()}
          disabled={bili.qrLoading}
          loading={bili.qrLoading}
          fullWidth
        />
      </View>
      {/过期|超时|失败/.test(bili.biliStatus) ? (
        <ScalePressable
          onPress={() => void bili.generateQr()}
          pressedScale={0.96}
          style={s.qrRetry}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <MaterialCommunityIcons name="refresh" color={palette.tint} size={16} />
          <Text style={[s.qrRetryText, { color: palette.tint }]}>{t('二维码已过期，点击刷新')}</Text>
        </ScalePressable>
      ) : null}
    </GlassSurface>
  );

  const form = (
    <>
      <GlassSegmented
        options={segments}
        value={mode}
        onChange={(k) => switchMode(k)}
        height={38}
        style={s.segment}
      />
      <Animated.View style={{ transform: [{ translateX: modeSlide }] }}>
        {mode === 'sms' ? smsCard : null}
        {mode === 'token' ? tokenCard : null}
        {mode === 'bilibili' ? biliCard : null}
      </Animated.View>
    </>
  );

  if (wide) {
    return (
      <ScrollView
        contentContainerStyle={s.loginWide}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        {...modePan.panHandlers}
      >
        <View style={s.brandCol}><BrandCard wide /></View>
        <View style={s.formCol}>{form}</View>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={s.content}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      {...modePan.panHandlers}
    >
      <View style={s.loginBrandRow}>
        <View style={[s.loginBrandLogoSm, { backgroundColor: palette.tintSoft }]}>
          <MaterialCommunityIcons name="message-processing-outline" size={24} color={palette.tint} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.loginBrandTitle, { color: palette.label }]}>{t('登录口袋48')}</Text>
          <Text style={[s.loginBrandSub, { color: palette.labelTertiary }]}>
            {t('登录后可收发私信、进入房间查看偶像动态')}
          </Text>
        </View>
      </View>
      {form}
    </ScrollView>
  );
}
