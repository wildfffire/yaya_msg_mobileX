/**
 * 编辑资料弹窗（2026-11-11 定版）。
 *
 * 用户要求：头像与昵称修改不再在列表里单列三行，而是点 Hero 的头像 / 昵称弹这个窗口。
 * 逻辑全部复用 useAccountProfile（pickAvatar / editNickname / renameCountText），
 * 这里只负责版式；保存后不自动关闭 —— 让用户看到成功/失败提示自己关。
 */
import React from 'react';
import {
  KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { Button } from '../../components/Button';
import { GlassSurface } from '../../components/GlassSurface';
import { ScalePressable } from '../../components/Motion';
import { useI18n } from '../../i18n';
import { usePalette, radii } from '../../theme';
import { avatarUrl } from './accountParse';
import { AccountAvatar, AccountStatusNote } from './AccountPrimitives';
import { accountStyles as s } from './accountStyles';
import type { AccountProfileApi } from './useAccountProfile';

export default function AccountProfileModal({ visible, onClose, profile }: {
  visible: boolean;
  onClose: () => void;
  profile: AccountProfileApi;
}) {
  const { t } = useI18n();
  const palette = usePalette();
  const avatar = avatarUrl(profile.profileAvatar);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={s.modalMask}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t('关闭')} />

        <GlassSurface role="modal" radius={radii.sheet} style={s.sheet}>
          <View style={s.sheetHead}>
            <Text style={[s.sheetTitle, { color: palette.label }]}>{t('编辑资料')}</Text>
            <ScalePressable
              onPress={onClose}
              pressedScale={0.92}
              style={[s.sheetClose, { backgroundColor: palette.fill2 }]}
              accessibilityRole="button"
              accessibilityLabel={t('关闭')}
            >
              <MaterialCommunityIcons name="close" size={16} color={palette.labelSecondary} />
            </ScalePressable>
          </View>

          <View style={s.editAvatarRow}>
            <AccountAvatar uri={avatar} size={72} name={profile.profileName} />
            <View style={s.editAvatarMain}>
              <Button
                title={t('更换头像')}
                variant="tinted"
                size="sm"
                onPress={() => void profile.pickAvatar()}
                disabled={profile.loading}
              />
              <Text style={[s.fieldHint, { color: palette.labelTertiary, marginTop: 8 }]}>
                {t('JPG / PNG，建议正方形，上传后在口袋48生效')}
              </Text>
            </View>
          </View>

          <Text style={[s.fieldLabel, { color: palette.labelTertiary }]}>{t('昵称')}</Text>
          <TextInput
            style={[s.input, { color: palette.label, backgroundColor: palette.fill2, borderColor: palette.innerStroke }]}
            value={profile.profileName}
            onChangeText={profile.setProfileName}
            placeholder={t('请输入新昵称')}
            placeholderTextColor={palette.labelTertiary}
            maxLength={24}
            returnKeyType="done"
            onSubmitEditing={() => void profile.editNickname()}
          />
          <Text style={[s.fieldHint, { color: palette.labelTertiary }]}>
            {profile.renameCountText || t('改名次数以口袋48为准')}
          </Text>

          {profile.status ? (
            <AccountStatusNote
              text={profile.status}
              style={{ marginHorizontal: 0, marginTop: 12, marginBottom: 0 }}
            />
          ) : null}

          <View style={s.sheetFoot}>
            <Button title={t('取消')} variant="plain" size="md" onPress={onClose} style={s.sheetBtn} />
            <Button
              title={t('保存')}
              variant="filled"
              size="md"
              onPress={() => void profile.editNickname()}
              disabled={profile.loading}
              loading={profile.loading}
              style={s.sheetBtn}
            />
          </View>
        </GlassSurface>
      </KeyboardAvoidingView>
    </Modal>
  );
}
