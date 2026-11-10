/**
 * PiliPlus 风格主题色控件。
 *
 * 参考 PiliPlus（lib/pages/setting/pages/color_select.dart、slide_color_picker.dart）：
 *  · AccentSwatch —— 圆形三色分区色板（primary 上半 / tertiary + primaryContainer 下半），选中打勾；
 *  · ThemeColorPicker —— 色块实时预览 + #RRGGBB 输入 + R/G/B 三条 0-255 滑块 + 重置/取消/确定。
 *
 * 本项目没有 Slider 组件依赖，滑块用 PanResponder 自绘（渐变轨道 + 可拖动圆点），
 * 不引入新 npm 包，也不影响外层 ScrollView 的竖向滚动（在 Modal 里，且独吞横向手势）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { usePalette } from '../theme';
import { useI18n } from '../i18n';
import {
  DEFAULT_ACCENT_COLOR,
  deriveAccentColors,
  hexToRgb,
  normalizeHexColor,
  normalizeVariant,
  onColor,
  rgbToHex,
  type AccentVariant,
  type RGB,
} from '../theme/themeColors';

/** PiliPlus 的 ColorPalette：一个种子色展示成三色圆盘，选中态中间一个勾 */
export function AccentSwatch({
  seed,
  variant,
  label,
  selected,
  onPress,
}: {
  seed: string;
  variant: AccentVariant;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  const derived = useMemo(
    () => deriveAccentColors(seed, normalizeVariant(variant), palette.name === 'dark'),
    [seed, variant, palette.name],
  );
  return (
    <TouchableOpacity style={styles.swatchItem} onPress={onPress} activeOpacity={0.8}>
      <View style={[styles.swatchOuter, { backgroundColor: palette.fill3 }]}>
        <View style={styles.swatchClip}>
          <View style={{ flex: 1, backgroundColor: derived.tint }} />
          <View style={{ flex: 1, flexDirection: 'row' }}>
            <View style={{ flex: 1, backgroundColor: derived.tintAlt }} />
            <View style={{ flex: 1, backgroundColor: derived.tintContainer }} />
          </View>
        </View>
        {selected ? (
          <View style={[styles.swatchCheck, { backgroundColor: palette.surface }]}>
            <MaterialCommunityIcons name="check" size={14} color={derived.tint} />
          </View>
        ) : null}
      </View>
      <Text
        style={[styles.swatchLabel, { color: selected ? palette.tint : palette.labelTertiary }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/** R / G / B 单通道滑块：轨道是该通道从 0 到 255 的真实渐变 */
function ChannelSlider({
  label,
  channel,
  value,
  rgb,
  onChange,
}: {
  label: string;
  channel: 0 | 1 | 2;
  value: number;
  rgb: RGB;
  onChange: (v: number) => void;
}) {
  const palette = usePalette();
  const widthRef = useRef(1);
  const pageXRef = useRef(0);
  const trackRef = useRef<any>(null);
  const [width, setWidth] = useState(1);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 用 pageX（绝对屏幕坐标）而不是 locationX：后者是相对「触摸命中的子视图」，
  // 手指落在渐变条 / 圆点上时基准会漂移，滑块会跳。
  const setFromPageX = (pageX: number) => {
    const w = widthRef.current || 1;
    const x = pageX - pageXRef.current;
    onChangeRef.current(Math.max(0, Math.min(255, Math.round((x / w) * 255))));
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => setFromPageX(e.nativeEvent.pageX),
      onPanResponderMove: (e) => setFromPageX(e.nativeEvent.pageX),
    }),
  ).current;

  const from = channel === 0
    ? `rgb(0,${rgb.g},${rgb.b})`
    : channel === 1 ? `rgb(${rgb.r},0,${rgb.b})` : `rgb(${rgb.r},${rgb.g},0)`;
  const to = channel === 0
    ? `rgb(255,${rgb.g},${rgb.b})`
    : channel === 1 ? `rgb(${rgb.r},255,${rgb.b})` : `rgb(${rgb.r},${rgb.g},255)`;
  const thumbLeft = Math.max(0, Math.min(width - 18, (value / 255) * width - 9));

  return (
    <View style={styles.sliderRow}>
      <Text style={[styles.sliderLabel, { color: palette.labelSecondary }]}>{label}</Text>
      <View
        ref={trackRef}
        {...pan.panHandlers}
        collapsable={false}
        style={styles.trackWrap}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          widthRef.current = w;
          setWidth(w);
          trackRef.current?.measure((_x: number, _y: number, _w: number, _h: number, pageX: number) => {
            pageXRef.current = pageX;
          });
        }}
      >
        <LinearGradient
          colors={[from, to]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.track}
        />
        <View
          pointerEvents="none"
          style={[styles.thumb, { left: thumbLeft, borderColor: palette.surface }]}
        />
      </View>
      <Text style={[styles.sliderValue, { color: palette.label }]}>{value}</Text>
    </View>
  );
}

export function ThemeColorPicker({
  visible,
  initialColor,
  onConfirm,
  onReset,
  onClose,
}: {
  visible: boolean;
  /** #RRGGBB：当前生效的种子色，打开时作为取色初值 */
  initialColor: string;
  onConfirm: (hex: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const palette = usePalette();
  const { t } = useI18n();
  const [rgb, setRgb] = useState<RGB>(() => hexToRgb(initialColor));
  const [hexText, setHexText] = useState(() => (normalizeHexColor(initialColor) || DEFAULT_ACCENT_COLOR).slice(1));

  // 每次打开重新对齐当前主题色；关闭期间用户在别处换色也不会带着旧值进弹窗
  useEffect(() => {
    if (!visible) return;
    const hex = normalizeHexColor(initialColor) || DEFAULT_ACCENT_COLOR;
    setRgb(hexToRgb(hex));
    setHexText(hex.slice(1));
  }, [visible, initialColor]);

  const currentHex = rgbToHex(rgb.r, rgb.g, rgb.b);
  const valid = hexText.length === 6;

  const setChannel = (channel: 0 | 1 | 2, value: number) => {
    const next: RGB = { r: rgb.r, g: rgb.g, b: rgb.b };
    if (channel === 0) next.r = value;
    else if (channel === 1) next.g = value;
    else next.b = value;
    setRgb(next);
    setHexText(rgbToHex(next.r, next.g, next.b).slice(1));
  };

  const onHexChange = (raw: string) => {
    const clean = raw.replace(/[^0-9a-fA-F]/g, '').slice(0, 6).toUpperCase();
    setHexText(clean);
    if (clean.length === 6) setRgb(hexToRgb(`#${clean}`));
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <Text style={[styles.title, { color: palette.label }]}>{t('自定义颜色')}</Text>

          {/* 实时预览色块（PiliPlus SlideColorPicker 顶部那块） */}
          <View style={[styles.preview, { backgroundColor: currentHex }]}>
            <Text style={{ color: onColor(currentHex), fontSize: 15, fontWeight: '800', letterSpacing: 1 }}>
              #{hexText}
            </Text>
          </View>

          <View style={styles.hexRow}>
            <Text style={[styles.hexPrefix, { color: palette.labelSecondary }]}>#</Text>
            <TextInput
              value={hexText}
              onChangeText={onHexChange}
              maxLength={6}
              autoCorrect={false}
              autoCapitalize="characters"
              placeholder="RRGGBB"
              placeholderTextColor={palette.labelTertiary}
              style={[styles.hexInput, { color: palette.label, borderColor: palette.hairline }]}
            />
          </View>

          <ChannelSlider label="R" channel={0} value={rgb.r} rgb={rgb} onChange={(v) => setChannel(0, v)} />
          <ChannelSlider label="G" channel={1} value={rgb.g} rgb={rgb} onChange={(v) => setChannel(1, v)} />
          <ChannelSlider label="B" channel={2} value={rgb.b} rgb={rgb} onChange={(v) => setChannel(2, v)} />

          <View style={styles.actions}>
            <TouchableOpacity style={styles.actionBtn} onPress={onReset} activeOpacity={0.8}>
              <Text style={[styles.actionText, { color: palette.labelSecondary }]}>{t('重置')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={onClose} activeOpacity={0.8}>
              <Text style={[styles.actionText, { color: palette.labelSecondary }]}>{t('取消')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.confirmBtn, { backgroundColor: palette.tint, opacity: valid ? 1 : 0.45 }]}
              activeOpacity={0.85}
              onPress={() => {
                if (!valid) return;
                onConfirm(normalizeHexColor(`#${hexText}`) || currentHex);
              }}
            >
              <Text style={[styles.actionText, { color: palette.onTint, fontWeight: '800' }]}>{t('确定')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // 圆形三色分区预设（PiliPlus ColorPalette）
  swatchItem: { width: '20%', alignItems: 'center', marginBottom: 12 },
  swatchOuter: { width: 50, height: 50, borderRadius: 14, padding: 5, alignItems: 'center', justifyContent: 'center' },
  swatchClip: { width: 40, height: 40, borderRadius: 20, overflow: 'hidden', flexDirection: 'column' },
  swatchCheck: { position: 'absolute', width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  swatchLabel: { fontSize: 10, marginTop: 5, textAlign: 'center' },

  // 自定义取色弹窗
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', padding: 20 },
  card: { width: '100%', maxWidth: 380, borderRadius: 20, borderWidth: 1, padding: 16 },
  title: { fontSize: 16, fontWeight: '800', marginBottom: 12 },
  preview: { height: 84, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  hexRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  hexPrefix: { fontSize: 16, fontWeight: '700', marginRight: 6 },
  hexInput: { width: 120, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14, letterSpacing: 1 },
  sliderRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  sliderLabel: { width: 18, fontSize: 13, fontWeight: '800' },
  trackWrap: { flex: 1, height: 28, marginHorizontal: 10, justifyContent: 'center' },
  track: { height: 10, borderRadius: 5 },
  thumb: { position: 'absolute', top: 5, width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF', borderWidth: 2 },
  sliderValue: { width: 32, textAlign: 'right', fontSize: 12, fontWeight: '700' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginTop: 16 },
  actionBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  confirmBtn: { paddingHorizontal: 18 },
  actionText: { fontSize: 13, fontWeight: '600' },
});
