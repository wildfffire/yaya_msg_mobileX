import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type DanmakuArea = 'top' | 'half' | 'full';

export interface DanmakuSettings {
  /** 弹幕总开关 */
  enabled: boolean;
  /** 不透明度 0.2 ~ 1 */
  opacity: number;
  /** 速度倍率：1=正常，2=2倍快，0.5=半速 */
  speed: number;
  /** 显示区域：顶部 / 半屏 / 全屏 */
  area: DanmakuArea;
  /** 字号 12 ~ 24 */
  fontSize: number;
  /**
   * 礼物特效开关（收到送礼公屏时在画面上播放礼物卡片动画）。
   * 与弹幕总开关**相互独立**：关掉弹幕仍可看礼物特效，反之亦然。
   */
  giftEffect: boolean;
  /**
   * 防重叠（用户 2026-11-09）：开 = 每条弹幕等上一条完全离屏 + 安全间隔才复用泳道
   * （默认，画面干净）；关 = 泳道轮转立即入场，弹幕更密集（人多时允许重叠）。
   */
  avoidOverlap: boolean;
  set: (p: Partial<DanmakuSettings>) => void;
  reset: () => void;
}

const DEFAULT: Omit<DanmakuSettings, 'set' | 'reset'> = {
  enabled: true,
  opacity: 0.9,
  speed: 1,
  area: 'full',
  fontSize: 15,
  giftEffect: true,
  avoidOverlap: true,
};

export const useDanmakuSettings = create<DanmakuSettings>()(
  persist(
    (set) => ({
      ...DEFAULT,
      set: (p) => set(p),
      reset: () => set(DEFAULT),
    }),
    {
      name: 'yaya_danmaku_settings_v1',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
