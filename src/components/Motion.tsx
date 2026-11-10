/**
 * Apple 流体动效组件（RN Animated + native driver，零 worklet 依赖）
 *
 * 规范来源：WWDC Designing Fluid Interfaces + emilkowalski/animate-expo：
 *  - FadeInView：进场 ease-out 强曲线（0.23,1,0.32,1）+ 轻位移
 *  - ScalePressable：按下即反馈（press-in 即刻 scale 0.97/120ms），松手 spring 回弹
 *  - MotionIcon：图标挂载 spring 浮现（0.92→1，轻微过冲）
 * 只动 transform/opacity（native driver 可动画属性）。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  StyleProp,
  TouchableOpacity,
  TouchableOpacityProps,
  ViewProps,
  ViewStyle,
} from 'react-native';

/**
 * Apple 家族强 ease-out（UI 进出场默认）。
 * ⚠️ 必须用预定义 easing：native driver 无法序列化 Easing.bezier 自定义函数，
 * 一旦用了自定义 bezier，动画可能整体不执行 → opacity 卡在 0 → 页面不可见。
 */
export const EASE_OUT = Easing.out(Easing.cubic);
/** 屏上移动 */
export const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

interface FadeInViewProps extends Pick<ViewProps, 'pointerEvents'> {
  children: React.ReactNode;
  delay?: number;
  duration?: number;
  distance?: number;
  style?: StyleProp<ViewStyle>;
}

export function FadeInView({
  children,
  delay = 0,
  duration = 300,
  distance = 10,
  style,
  pointerEvents,
}: FadeInViewProps) {
  const value = useRef(new Animated.Value(0)).current;
  /**
   * ⚠️ delay / duration 只取**首帧**的值（用户 2026-09-30 报「房间列表闪烁、莫名遮罩、房间全没了」）。
   *
   * 以前依赖数组是 [delay, duration, value]，而列表行的 delay 常由 index 推导
   *（如 RoomListRow 的 `80 + index * 30`）：一旦列表重排（未读上浮 / 搜索 / 置顶变化），
   * index 变 → delay 变 → effect 重跑 → `setValue(0)` → 整行淡入重播。
   * 30s 轮询刷新数据就会触发一轮全列表重播 → 视觉上就是「闪烁 + 像蒙了层遮罩 + 房间不见了」，
   * 叠加 removeClippedSubviews 的回收重挂载后更明显。
   *
   * 语义修正：进场动画属于「挂载时播一次」，之后的任何重渲染/重排都不该重播。
   */
  const firstDelay = useRef(delay).current;
  const firstDuration = useRef(duration).current;
  /**
   * ★ 落定后切静态样式（用户 2026-10-01「设置页下面的内容都消失了」）：
   * native driver 的动画值挂在 **native 视图节点**上，而 root stack 开着
   * detachPreviousScreen —— push 二级屏时本屏被 detach，**动画节点连同 opacity 一起丢**，
   * pop 回来 re-attach 后 opacity 归 0 → 常驻内容（设置页的各个 Section 等）
   * 只剩框架、内容隐形，且三重保险早已执行过、救不回来。
   * 现在：动画落定（含全部兜底路径）后置 settled=true，样式切换成**静态 opacity:1**
   * —— detach/attach 不再影响可见性。组件类型不变（仍是 Animated.View），子树不 remount。
   */
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    value.setValue(0);
    const animation = Animated.timing(value, {
      toValue: 1,
      duration: firstDuration,
      delay: firstDelay,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    /**
     * ⚠️ 三重收尾保险（少一个都可能让整块常驻内容永久不可见）：
     *  1) 动画被中断（native 节点在页面 detach / 列表回收时丢失、被后续动画抢占）
     *     → 完成回调 finished=false，立刻补到 1；
     *  2) native driver 异常时动画可能**整体不执行**（见本文件 EASE_OUT 的注释）
     *     → 定时器兜底；
     *  3) 后台的 JS 定时器会被系统节流/暂停（兜底 2 可能不触发）
     *     → 回到前台再兜一次。
     * 这正是「首页快捷入口/工具上下互动后莫名消失」的根因类问题；
     * 常驻高频内容建议直接用普通 View，别依赖「靠动画才可见」的写法。
     */
    animation.start(({ finished }) => {
      if (!finished) value.setValue(1);
      setSettled(true);
    });
    const guard = setTimeout(() => {
      value.setValue(1);
      setSettled(true);
    }, firstDelay + firstDuration + 150);
    const appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        value.setValue(1);
        setSettled(true);
      }
    });
    return () => {
      animation.stop();
      clearTimeout(guard);
      appStateSub.remove();
    };
  }, [firstDelay, firstDuration, value]);

  return (
    <Animated.View
      pointerEvents={pointerEvents}
      style={[
        style,
        settled
          ? { opacity: 1 }
          : {
              opacity: value,
              transform: [{
                translateY: value.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }),
              }],
            },
      ]}
    >
      {children}
    </Animated.View>
  );
}

interface ScalePressableProps extends TouchableOpacityProps {
  pressedScale?: number;
  children: React.ReactNode;
}

export function ScalePressable({
  pressedScale = 0.97,
  activeOpacity = 0.9,
  onPressIn,
  onPressOut,
  style,
  children,
  ...props
}: ScalePressableProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = (toValue: number, bouncy: boolean) => {
    scale.stopAnimation();
    Animated.spring(scale, {
      toValue,
      // 松手回弹用轻弹（物理感）；按下用快收敛（即时反馈）
      speed: bouncy ? 24 : 32,
      bounciness: bouncy ? 5 : 2,
      useNativeDriver: true,
    }).start();
  };

  return (
    <AnimatedTouchable
      {...props}
      activeOpacity={activeOpacity}
      onPressIn={(event: any) => {
        // 按下即刻反馈：不等松手（Apple: highlight on touch-down）
        animateTo(pressedScale, false);
        onPressIn?.(event);
      }}
      onPressOut={(event: any) => {
        animateTo(1, true);
        onPressOut?.(event);
      }}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedTouchable>
  );
}

/** 图标挂载动画：0.92→1 spring 浮现（用于快捷入口/工具/行内图标） */
export function MotionIcon({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const value = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    value.setValue(0);
    // 同 FadeInView：动画被打断 / 不执行都必须收尾到 1，否则图标永久不可见
    const animation = Animated.spring(value, {
      toValue: 1,
      speed: 20,
      bounciness: 7,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!finished) value.setValue(1);
    });
    const appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') value.setValue(1);
    });
    return () => {
      animation.stop();
      appStateSub.remove();
    };
  }, [value]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: value,
          transform: [{
            scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }),
          }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
