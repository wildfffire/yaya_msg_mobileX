import { NativeModules, Platform } from 'react-native';
import { normalizeHexColor } from '../theme/themeColors';

/** 原生桥 SystemAccent（Android）；iOS / 旧包 / 不支持的设备一律返回 null */
const SystemAccent = (NativeModules as any)?.SystemAccent;

/**
 * 读取系统壁纸强调色（Android 12+）。
 * 失败不抛错：调用方据此提示「设备可能不支持动态取色」并保持原主题色。
 */
export async function fetchSystemAccentColor(): Promise<string | null> {
  if (Platform.OS !== 'android' || !SystemAccent?.getAccentColor) return null;
  try {
    return normalizeHexColor(await SystemAccent.getAccentColor());
  } catch {
    return null;
  }
}
