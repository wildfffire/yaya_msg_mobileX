/**
 * AppTabBar · 扁平化四键底栏（用户 2026-11-09 重绘）
 *
 * 观感对齐 Piliplus / M3 导航栏：
 *  - 实心胶囊条（palette.surface + hairline 描边），无玻璃、无阴影
 *  - 选中指示器 = 一块**跟手滑动的实心胶囊**（tintContainer / 深色 tintSoft）：
 *    按住底栏横向拖动时它跟着手指走，松手 spring 到最近的 tab 并切换
 *  - 图标：选中瞬间「上抬 3dp + 放大 1.14」再并联 spring 回位；按压时整体淡出反馈
 *
 * 实现要点：
 *  - 手势用 PanResponder 且 `onStartShouldSetPanResponder: () => false`，
 *    只有横向位移 > 6px 才接管 → 点击仍然正常落到各 tab 的 Pressable 上
 *  - 指示器位移用 native driver 的 translateX（不触发 JS 帧）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { usePalette } from '../theme';
import { typography } from '../theme/typography';
import { useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import { useIsLandscape } from '../hooks/useIsLandscape';

export interface TabBarItem {
  key: string;
  label: string;
  icon: (props: { color: string; size: number }) => React.ReactNode;
  /** 右上角数字角标（如房间 tab 的未读总数）；<=0 不显示 */
  badge?: number;
}

export interface AppTabBarProps {
  items: TabBarItem[];
  activeKey: string;
  onSelect: (key: string) => void;
}

/** 单格宽度（固定宽 → 指示器位移可直接用 index * CELL_W 算） */
const CELL_W = 76;
/** 底栏左右内边距（与 styles.bar.paddingHorizontal 保持一致） */
const BAR_PAD = 8;

function TabCell({
  item,
  active,
  onSelect,
}: {
  item: TabBarItem;
  active: boolean;
  onSelect: () => void;
}) {
  const palette = usePalette();
  const pop = useRef(new Animated.Value(1)).current;
  /** 选中瞬间的「上跳」（Piliplus 风格：图标先抬 3dp 再弹回） */
  const lift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    pop.stopAnimation();
    lift.stopAnimation();
    if (active) {
      // 1.14 起跳 + 上抬 3dp，两条 spring 并联回位 → 轻盈的「弹一下」
      pop.setValue(1.14);
      lift.setValue(-3);
      const animation = Animated.parallel([
        Animated.spring(pop, { toValue: 1, tension: 240, friction: 18, useNativeDriver: true }),
        Animated.spring(lift, { toValue: 0, tension: 260, friction: 16, useNativeDriver: true }),
      ]);
      animation.start();
      return () => animation.stop();
    }
    pop.setValue(1);
    lift.setValue(0);
  }, [active, pop, lift]);

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      hitSlop={6}
      onPress={onSelect}
      style={({ pressed }) => [styles.cell, pressed && { opacity: 0.72 }]}
    >
      <Animated.View
        style={[styles.cellIcon, { transform: [{ translateY: lift }, { scale: pop }] }]}
      >
        {item.icon({ color: active ? palette.tint : palette.labelSecondary, size: 22 })}
        {typeof item.badge === 'number' && item.badge > 0 ? (
          <View style={[styles.tabBadge, { backgroundColor: palette.danger }]}>
            <Text style={styles.tabBadgeText}>{item.badge > 99 ? '99+' : String(item.badge)}</Text>
          </View>
        ) : null}
      </Animated.View>
      <Text
        style={[
          typography.caption2,
          {
            color: active ? palette.tint : palette.labelSecondary,
            fontWeight: active ? '700' : '600',
            marginTop: 3,
          },
        ]}
      >
        {item.label}
      </Text>
    </Pressable>
  );
}

export function AppTabBar({ items, activeKey, onSelect }: AppTabBarProps) {
  const palette = usePalette();
  const isDark = palette.name === 'dark';
  // 横屏适配：底栏是悬浮胶囊，横屏时窗口高度只有竖屏的一半左右，
  // 保持 16px 底部留白 + 64px 栏高会吃掉太多纵向空间，且离侧边挖孔/三键导航条太近。
  // 这里只调「离底距离」与「左右安全边」，不改变胶囊自身尺寸与指示器位移算法
  //（指示器位移依赖固定 CELL_W，改尺寸会连带影响拖动手势）。
  const insets = useSafeAreaInsets();
  const isLandscape = useIsLandscape();
  const outerPadding = {
    paddingBottom: isLandscape ? 8 : 16,
    paddingHorizontal: Math.max(16, isLandscape ? insets.left : 0),
  };

  const activeIndex = Math.max(0, items.findIndex((it) => it.key === activeKey));
  const maxShift = Math.max(0, (items.length - 1) * CELL_W);

  const indX = useRef(new Animated.Value(activeIndex * CELL_W)).current;
  const indXRef = useRef(activeIndex * CELL_W);
  const startXRef = useRef(0);
  /** 拖动时选中玻璃"液化"：跟随拖动距离横向拉长（苹果/Kyant0 拖动的形变） */
  const dragStretch = useRef(new Animated.Value(1)).current;
  /** 拖动时选中玻璃放大（对应 Apple「按住拖动时玻璃膨起」） */
  const dragScale = useRef(new Animated.Value(1)).current;
  const scaleTo = useCallback(
    (v: number) => {
      Animated.spring(dragScale, { toValue: v, tension: 240, friction: 26, useNativeDriver: true }).start();
    },
    [dragScale],
  );
  /** 拖动中手指当前悬停的格子（用于给「将要选中」的那个 tab 上色） */
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const hoverRef = useRef<number | null>(null);

  // 外部切页（含导航状态变化）时把指示器弹到位
  useEffect(() => {
    if (hoverRef.current != null) return; // 拖动中不要被外部状态拽走
    const target = activeIndex * CELL_W;
    indXRef.current = target;
    Animated.spring(indX, { toValue: target, tension: 240, friction: 26, useNativeDriver: true }).start();
  }, [activeIndex, indX]);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  const settle = useCallback(
    (x: number) => {
      indXRef.current = x;
      Animated.spring(indX, { toValue: x, tension: 240, friction: 26, useNativeDriver: true }).start();
    },
    [indX],
  );

  const pan = useRef(
    PanResponder.create({
      // 点击不抢：只有横向拖动才接管，保证 tab 的点击照常触发
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: () => {
        indX.stopAnimation((v: number) => {
          indXRef.current = v;
          startXRef.current = v;
        });
        hoverRef.current = Math.round(indXRef.current / CELL_W);
        setHoverIndex(hoverRef.current);
        scaleTo(1.12);
        dragStretch.setValue(1.04);
      },
      onPanResponderMove: (_, g) => {
        const limit = Math.max(0, (itemsRef.current.length - 1) * CELL_W);
        const nx = Math.min(limit, Math.max(0, startXRef.current + g.dx));
        indXRef.current = nx;
        indX.setValue(nx);
        // 液化：拖得越远，胶囊沿拖动方向拉得越长（iOS 26 拖动的形变）
        const moved = Math.abs(nx - startXRef.current) / CELL_W;
        dragStretch.setValue(Math.min(1.32, 1.04 + moved * 0.26));
        const h = Math.round(nx / CELL_W);
        if (h !== hoverRef.current) {
          hoverRef.current = h;
          setHoverIndex(h);
        }
      },
      onPanResponderRelease: () => {
        const n = itemsRef.current.length;
        const h = Math.min(n - 1, Math.max(0, Math.round(indXRef.current / CELL_W)));
        hoverRef.current = null;
        setHoverIndex(null);
        settle(h * CELL_W);
        scaleTo(1);
        dragStretch.setValue(1);
        Animated.spring(dragStretch, { toValue: 1, tension: 240, friction: 26, useNativeDriver: true }).start();
        const target = itemsRef.current[h];
        if (target && target.key !== activeKeyRef.current) onSelectRef.current(target.key);
      },
      onPanResponderTerminate: () => {
        hoverRef.current = null;
        setHoverIndex(null);
        settle(activeIndexRef.current * CELL_W);
        scaleTo(1);
        Animated.spring(dragStretch, { toValue: 1, tension: 240, friction: 26, useNativeDriver: true }).start();
      },
    }),
  ).current;

  const litIndex = hoverIndex ?? activeIndex;

  return (
    <View pointerEvents="box-none" style={[styles.outer, outerPadding]}>
      {/* 扁平化重绘（用户 2026-11-09）：实心底栏 + 实心胶囊指示器，不再有玻璃与投影。
          选中胶囊仍是「跟手滑动 + 拖动液化」的那一块，只是材质从玻璃换成纯色。 */}
      <View {...pan.panHandlers}>
        <View
          style={[
            styles.bar,
            { backgroundColor: palette.surface, borderColor: palette.hairline },
          ]}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              styles.indicator,
              {
                width: CELL_W,
                // 选中态 = 主题色的容器色（浅色深一档 / 深色用柔和版），保证与纯色底栏分离
                backgroundColor: isDark ? palette.tintSoft : palette.tintContainer,
                transform: [{ translateX: indX }, { scaleX: dragStretch }, { scaleY: dragScale }],
              },
            ]}
          />
          {items.map((item, i) => (
            <TabCell
              key={item.key}
              item={item}
              active={i === litIndex}
              onSelect={() => onSelect(item.key)}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  bar: {
    flexDirection: 'row',
    borderRadius: 26,
    paddingVertical: 5,
    paddingHorizontal: BAR_PAD,
    minHeight: 62,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  /** 选中指示器：绝对定位 + translateX/scale 驱动（native driver），实心胶囊 */
  indicator: {
    position: 'absolute',
    top: 5,
    bottom: 5,
    left: BAR_PAD,
    borderRadius: 22,
  },
  cell: {
    width: CELL_W,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderRadius: 22,
  },
  cellIcon: { alignItems: 'center', justifyContent: 'center' },
  /** tab 右上角数字角标（房间未读总数等） */
  tabBadge: {
    position: 'absolute',
    top: -6,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tabBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800', textAlign: 'center' },
});

// 辅助：复用项目里的 MaterialCommunityIcons
export function MCI(name: string) {
  return ({ color, size }: { color: string; size: number }) => (
    <MaterialCommunityIcons name={name} color={color} size={size} />
  );
}
