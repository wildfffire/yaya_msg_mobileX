/**
 * AppSideBar · 横屏侧边栏模式导航（用户 2026-11-11 选「③ 无底板纯图标」）
 *
 * 只在「设备横屏 + 设置开关打开」时由 MainTabBar 分流渲染，其余情况仍走底部胶囊 AppTabBar。
 * 设计约束（用户明确否决玻璃材质）：
 *  - 完全透明、无底板、无阴影、无 BlurView / GlassSurface，只保留一条 hairline 细竖线
 *  - 屏幕左侧窄栏：上方用户头像，左下四个 tab 竖排（主页 / 直播 / 房间 / 我的）
 *  - 选中图标变主题色，房间入口保留未读数字角标
 *  - 点头像打开现有 UserProfileSheet（组件自身的玻璃样式不属于「侧栏本体」）
 *
 * 布局与 MainTabs 的 sceneStyle.paddingLeft 配套：宽度由 useSidebarMetrics() 按屏幕短边算出，
 * 侧栏本体、场景留白、首页网格三处共用同一个真值，避免留白对不齐或卡片换行。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { usePalette } from '../theme';
import { useI18n } from '../i18n';
import { useSettingsStore, useUiStore } from '../store';
import { useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import { useSidebarMetrics } from '../hooks/useSidebarMode';
import { POCKET_MEDIA_HEADERS } from '../utils/mediaHeaders';
import { loadSelfProfile } from '../services/pocketNim/credentials';
import type { NimSelfProfile } from '../services/pocketNim/types';
import { UserProfileSheet, type UserProfileTarget } from './UserProfileSheet';
import type { AppTabBarProps, TabBarItem } from './AppTabBar';

export interface AppSideBarProps extends AppTabBarProps {
  /** 资料卡「私信」：由导航层决定跳转方式 */
  onOpenChat?: (target: { id: string; name: string }) => void;
}

/** 单个 tab：纯图标 + 可选角标，选中用主题色点亮并轻微弹一下（不铺任何底板） */
function SideCell({
  item,
  active,
  onSelect,
  width,
}: {
  item: TabBarItem;
  active: boolean;
  onSelect: () => void;
  width: number;
}) {
  const palette = usePalette();
  const pop = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    pop.stopAnimation();
    if (active) {
      pop.setValue(1.16);
      const animation = Animated.spring(pop, {
        toValue: 1,
        tension: 240,
        friction: 18,
        useNativeDriver: true,
      });
      animation.start();
      return () => animation.stop();
    }
    pop.setValue(1);
  }, [active, pop]);

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={item.label}
      hitSlop={6}
      onPress={onSelect}
      style={({ pressed }) => [styles.cell, { width }, pressed && { opacity: 0.68 }]}
    >
      <Animated.View style={[styles.iconWrap, { transform: [{ scale: pop }] }]}>
        {item.icon({ color: active ? palette.tint : palette.labelSecondary, size: 23 })}
        {typeof item.badge === 'number' && item.badge > 0 ? (
          <View style={[styles.badge, { backgroundColor: palette.danger }]}>
            <Text style={styles.badgeText}>{item.badge > 99 ? '99+' : String(item.badge)}</Text>
          </View>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

export function AppSideBar({ items, activeKey, onSelect, onOpenChat }: AppSideBarProps) {
  const palette = usePalette();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const { contentW, inset, totalW } = useSidebarMetrics();
  const avatarSize = Math.min(36, contentW - 4);
  const p48Token = useSettingsStore((state) => state.settings.p48Token);
  const [self, setSelf] = useState<NimSelfProfile | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [profileVisible, setProfileVisible] = useState(false);

  // 自身资料：loadSelfProfile 内有模块级缓存 + inflight + 切号自愈；
  // 只在侧栏挂载（或换号）时取一次，不做轮询、不打印头像 URL。
  useEffect(() => {
    let alive = true;
    loadSelfProfile()
      .then((profile) => {
        if (alive) setSelf(profile);
      })
      .catch(() => {
        if (alive) setSelf(null);
      });
    return () => {
      alive = false;
    };
  }, [p48Token]);

  const avatarUri = String(self?.avatar || '').trim();
  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUri]);

  const target: UserProfileTarget | null = self
    ? {
        nick: self.nickName,
        avatar: self.avatar,
        userId: self.userId ? String(self.userId) : undefined,
      }
    : null;

  const showToast = useUiStore((state) => state.showToast);
  const openProfile = useCallback(() => {
    // 未登录时资料卡没有可加载的 id，弹出来只会是一张空卡 —— 直接给出提示
    if (!self) {
      showToast(t('请先登录'));
      return;
    }
    setProfileVisible(true);
  }, [self, showToast, t]);
  const closeProfile = useCallback(() => setProfileVisible(false), []);

  return (
    <View pointerEvents="box-none" style={[styles.outer, { width: totalW }]}>
      {/* 唯一的视觉分区：一条 hairline 细竖线，上下留白，不铺底色 */}
      <View
        pointerEvents="none"
        style={[
          styles.hairline,
          { backgroundColor: palette.hairline, top: insets.top + 8, bottom: 12 },
        ]}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('我的资料')}
        hitSlop={6}
        onPress={openProfile}
        style={({ pressed }) => [
          styles.avatarWrap,
          { top: insets.top + 4, left: inset, width: contentW },
          pressed && { opacity: 0.68 },
        ]}
      >
        {avatarUri && !avatarFailed ? (
          <Image
            source={{ uri: avatarUri, headers: POCKET_MEDIA_HEADERS }}
            style={[styles.avatar, { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }]}
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          <MaterialCommunityIcons name="account" size={Math.min(30, contentW - 10)} color={palette.labelSecondary} />
        )}
      </Pressable>

      <View pointerEvents="box-none" style={[styles.navGroup, { left: inset, width: contentW }]}>
        {items.map((item) => (
          <SideCell
            key={item.key}
            item={item}
            active={item.key === activeKey}
            onSelect={() => onSelect(item.key)}
            width={contentW}
          />
        ))}
      </View>

      <UserProfileSheet
        visible={profileVisible}
        target={target}
        onClose={closeProfile}
        onOpenChat={onOpenChat}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  /** 宽度由 useSidebarMetrics().totalW 在渲染时注入（按屏幕短边自适应） */
  outer: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
  },
  hairline: {
    position: 'absolute',
    right: 0,
    width: StyleSheet.hairlineWidth,
  },
  avatarWrap: {
    position: 'absolute',
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {},
  /** 四个入口贴左下：bottom 抬高到 36，避开横屏底部系统条；
   *  cell 40 + gap 2 让四个键更紧凑（用户 2026-11-11 真机反馈「太靠下、不够紧」） */
  navGroup: {
    position: 'absolute',
    bottom: 36,
    gap: 2,
  },
  cell: {
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrap: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  badgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800', textAlign: 'center' },
});

export default AppSideBar;
