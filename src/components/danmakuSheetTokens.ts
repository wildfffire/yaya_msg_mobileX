/**
 * 弹幕面板共用视觉 token（黑白两色体系）
 *
 * 用户 2026-11-09：「弹幕设置这一页的字体、颜色之类的风格和弹幕列表统一一下，都做成这种黑白的」。
 *
 * 两个面板（DanmakuSettingsSheet / DanmakuListSheet）此前各写一套 StyleSheet：
 * 背景 15,15,18 vs 18,18,20、圆角 22 vs 20、标题 17/600 vs 13/700、选中胶囊
 * 主题色 vs 白底黑字 —— 观感明显不是一家人。这里收敛成唯一常量源。
 *
 * 纪律：**不要在这里用 palette.tint**。弹幕面板是「浮在视频/房间画面上」的深色抽屉，
 * 整套保持黑白色阶，避免主题色在深底上发灰、也避免 Modal 里透出房间背景。
 */
import type { TextStyle } from 'react-native';

export const DANMAKU = {
  /** 遮罩：比列表页稍暗一点，视觉上「压住」视频 */
  scrim: 'rgba(0,0,0,0.5)',
  /** 面板底：实心深黑（不用玻璃/模糊，否则会透出房间画面） */
  bg: 'rgba(18,18,20,0.97)',
  /** 面板圆角（与弹幕列表一致） */
  radius: 20,
  /** 顶部拖拽手柄 */
  handle: 'rgba(255,255,255,0.35)',
  /** 分组之间的分隔线 / 细描边 */
  hairline: 'rgba(255,255,255,0.08)',

  /** 标题：13/700 白 0.94（弹幕列表同款） */
  title: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: 'rgba(255,255,255,0.94)' } as TextStyle,
  /** 右上角附加信息（条数） */
  meta: { fontSize: 11, fontWeight: '600', color: 'rgba(255,255,255,0.45)' } as TextStyle,
  /** 分组小标题 */
  group: { fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.5)' } as TextStyle,
  /** 行主文字（开关行标签） */
  text: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.94)' } as TextStyle,
  /** 次级说明文字 */
  sub: { fontSize: 11, lineHeight: 16, fontWeight: '500', color: 'rgba(255,255,255,0.45)' } as TextStyle,

  /** 未选胶囊 */
  chipBg: 'rgba(255,255,255,0.1)',
  chipFg: 'rgba(255,255,255,0.75)',
  /** 选中胶囊：白底黑字（全站弹幕面板唯一的「强调」方式） */
  chipOnBg: 'rgba(255,255,255,0.9)',
  chipOnFg: '#111111',
  /** 胶囊字号（弹幕列表 tab 同款 11/700） */
  chipText: { fontSize: 11, fontWeight: '700' } as TextStyle,

  // 开关已换成 SoleSwitch（黑白描边开关）：系统 Switch 的深色滑块压在这个黑底上看不清，
  // 两态颜色定义在 src/components/SoleSwitch.tsx 里，这里不再保留重复 token。

  /** 输入 / 搜索框底 */
  fieldBg: 'rgba(255,255,255,0.1)',
  /** 行按压高亮 */
  rowPressed: 'rgba(255,255,255,0.1)',
  /** 行选中底（当前播放位置等），不再用主题色 */
  rowActive: 'rgba(255,255,255,0.14)',
  /** 强调（当前播放位置竖条 / 清除筛选文字） */
  accent: 'rgba(255,255,255,0.92)',
  onAccent: '#111111',
} as const;
