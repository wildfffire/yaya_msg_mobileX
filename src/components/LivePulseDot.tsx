import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

/** 直播中呼吸红点（Animated + native driver）：直播页网格与首页成员直播小卡共用，行为与旧版逐字一致。 */
export default function LivePulseDot({ size = 7 }: { size?: number }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: '#ff4d4f',
        marginRight: 4,
        opacity: pulse,
      }}
    />
  );
}
