/**
 * 软件内通知横幅（用户 2026-11-09）。
 *
 * 与「系统通知栏」是两套独立开关：这里只在 App 前台时出现，
 * 从顶部滑下、4 秒自动消失；点一下跳对应页面（深链）。
 * 连发消息由 store 合并成一条（标题带条数），不堆叠、不刷屏。
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { Animated, Easing, Image, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useNoticeStore } from '../store/notice';
import { usePalette } from '../theme';
import { useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import { openDeepLink } from '../services/deepLink';

const AUTO_HIDE_MS = 4000;

export function InAppNoticeBanner() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const current = useNoticeStore((state) => state.current);
  const dismiss = useNoticeStore((state) => state.dismiss);
  const anim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  }, []);

  const close = useCallback(() => {
    clearTimer();
    Animated.timing(anim, {
      toValue: 0,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => { if (finished) dismiss(); });
  }, [anim, clearTimer, dismiss]);

  useEffect(() => {
    if (!current) return undefined;
    clearTimer();
    Animated.timing(anim, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    hideTimer.current = setTimeout(() => { close(); }, AUTO_HIDE_MS);
    return clearTimer;
  }, [current, anim, clearTimer, close]);

  if (!current) return null;

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [-90, 0] });
  const opacity = anim;
  const countLabel = current.count > 1 ? ` · ${current.count}` : '';
  /** 没有头像时用名字首字占位（用户 2026-11-10：横幅不要显示其他图标） */
  const initial = String(current.title || '').trim().slice(0, 1);

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { top: Math.max(8, (insets?.top || 0) + 6), transform: [{ translateY }], opacity },
      ]}
    >
      <TouchableOpacity
        activeOpacity={0.92}
        style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline }]}
        onPress={() => {
          openDeepLink(current.uri);
          close();
        }}
      >
        {current.avatarUrl ? (
          <Image source={{ uri: current.avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: palette.tintSoft }]}>
            <Text style={[styles.avatarInitial, { color: palette.tint }]}>{initial}</Text>
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.titleLine} numberOfLines={1}>
            <Text style={[styles.title, { color: palette.label }]}>{current.title}</Text>
            {countLabel ? <Text style={[styles.count, { color: palette.labelSecondary }]}>{countLabel}</Text> : null}
          </Text>
          <Text style={[styles.body, { color: palette.labelSecondary }]} numberOfLines={2}>
            {current.body}
          </Text>
        </View>
        <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={close} activeOpacity={0.7}>
          <MaterialCommunityIcons name="close" size={16} color={palette.labelTertiary} />
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

export default InAppNoticeBanner;

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 9999,
    elevation: 12,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    // 扁平化（用户 2026-11-09）：横幅不再投影，靠实心底 + 描边浮在内容之上
  },
  avatar: { width: 30, height: 30, borderRadius: 15 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { fontSize: 13, fontWeight: '800' },
  titleLine: { fontSize: 13 },
  title: { fontSize: 13, fontWeight: '800' },
  count: { fontSize: 12, fontWeight: '500' },
  body: { fontSize: 12, lineHeight: 17, marginTop: 2 },
});
