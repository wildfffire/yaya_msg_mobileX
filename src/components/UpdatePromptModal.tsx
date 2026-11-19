/**
 * 「发现新版本」弹窗（用户 2026-11-19：发 release 之后老用户要收到通知）。
 *
 * 由 services/updateNotice 在检测到新版本时打开一次（同一版本不重复），
 * 内容：版本号 + Build + Release 更新说明摘要 + 「立即下载 / 稍后再说」。
 * 下载统一走自建下载页（夸克网盘 + GitHub 双渠道，页内可改，无需发版）。
 */
import React from 'react';
import { Linking, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { usePalette } from '../theme';
import { useUpdateStore } from '../store';
import { translate } from '../i18n';
import { APP_BUILD } from '../constants';

export function UpdatePromptModal() {
  const palette = usePalette();
  const visible = useUpdateStore((s) => s.promptVisible);
  const label = useUpdateStore((s) => s.latestVersion);
  const notes = useUpdateStore((s) => s.latestNotes);
  const url = useUpdateStore((s) => s.latestUrl);
  const dismiss = useUpdateStore((s) => s.dismissUpdatePrompt);

  if (!visible) return null;

  const download = () => {
    if (url) Linking.openURL(url).catch(() => {});
    dismiss();
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <Text style={[styles.title, { color: palette.label }]}>{translate('发现新版本')}</Text>
          <Text style={[styles.version, { color: palette.tint }]}>{label}</Text>
          <Text style={[styles.current, { color: palette.labelTertiary }]}>
            {translate('Build {n}', { n: APP_BUILD })}
          </Text>
          {notes ? (
            <ScrollView style={styles.notesWrap} showsVerticalScrollIndicator={false}>
              <Text style={[styles.notesTitle, { color: palette.labelSecondary }]}>{translate('更新说明')}</Text>
              <Text style={[styles.notes, { color: palette.labelSecondary }]}>{notes}</Text>
            </ScrollView>
          ) : null}
          <View style={styles.btnRow}>
            <TouchableOpacity
              activeOpacity={0.75}
              style={[styles.btn, { backgroundColor: palette.tintSoft }]}
              onPress={dismiss}
            >
              <Text style={[styles.btnText, { color: palette.label }]}>{translate('稍后再说')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.btn, { backgroundColor: palette.tint }]}
              onPress={download}
            >
              <Text style={[styles.btnText, { color: '#fff' }]}>{translate('立即下载')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default UpdatePromptModal;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '78%',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
  },
  title: { fontSize: 18, fontWeight: '800' },
  version: { fontSize: 15, fontWeight: '700', marginTop: 6 },
  current: { fontSize: 11, fontWeight: '600', marginTop: 2 },
  notesWrap: { marginTop: 14, flexGrow: 0, flexShrink: 1 },
  notesTitle: { fontSize: 12, fontWeight: '700', marginBottom: 6 },
  notes: { fontSize: 12, lineHeight: 19 },
  btnRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  btn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12 },
  btnText: { fontSize: 14, fontWeight: '700' },
});
