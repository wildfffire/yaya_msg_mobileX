/**
 * 「关于 → 清除缓存」：只清可重建的派生缓存。
 *
 * ⚠️ 绝不用 AsyncStorage.clear() / clearSettings()：账号 token、B站登录态、全部设置、
 * 通知迁移 marker、观看历史、稍后再看、下载记录、播放器队列、弹幕设置、续播/回放进度、
 * 未读角标与指纹、公告已读都在同一存储里，误清会当成"丢数据"。
 * 这里用显式白名单 + 三个明确的 cacheDirectory 子目录，并同步清掉进程内内存索引，
 * 避免清完文件后内存还留着指向已删除 file:// 的映射。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { clearLocalImageCache } from '../components/NetworkImage';
import { clearCoverFileCache } from '../utils/coverToFile';
import { clearRoomBgMemoryCache } from './roomBgCache';

/** 可安全删除、下次使用会自动重建的缓存键（含历史版本遗留键） */
const SAFE_KEYS: string[] = [
  'yaya_member_data_cache_v6', 'yaya_member_data_cache_bak',
  'yaya_member_data_cache_v1', 'yaya_member_data_cache_v2', 'yaya_member_data_cache_v3',
  'yaya_member_data_cache_v4', 'yaya_member_data_cache_v5',
  'yaya_member_room_map_v2',
  'yaya_performance_schedule_v4',
  'yaya_home_lives_cache_v1', 'yaya_home_gongyan_cache_v1',
  'yaya_room_bg_cache_v1',
  'yaya_room_list_avatar_v1',
  'yaya_gift_prices_v1',
  'yaya_mask_words_v1',
  'yaya_lyric_cache_v1', 'yaya_lyrics_index_v1',
  'yaya_r2_music_cache_v1',
  'yaya_official_site_music_cache_v6',
  'yaya_update_last_check',
];

/** 只删缓存目录；documentDirectory/downloads/ 是用户主动下载，绝不碰 */
const CACHE_DIRS = ['img-fallback/', 'cover/', 'roombg/'];

export interface CacheClearResult {
  /** 清理的 AsyncStorage 键数量 */
  keys: number;
  /** 实际删掉的缓存目录数量 */
  dirs: number;
  /** 删掉的文件字节数（尽力统计，失败按 0） */
  bytes: number;
}

async function dirSize(dir: string): Promise<number> {
  try {
    const info: any = await FileSystem.getInfoAsync(dir);
    if (!info?.exists) return 0;
    if (!info.isDirectory) return Number(info.size || 0);
    const names = await FileSystem.readDirectoryAsync(dir);
    let total = 0;
    for (const name of names) total += await dirSize(`${dir}${name}`);
    return total;
  } catch {
    return 0;
  }
}

export async function clearAppCache(): Promise<CacheClearResult> {
  await AsyncStorage.multiRemove(SAFE_KEYS);
  let dirs = 0;
  let bytes = 0;
  for (const name of CACHE_DIRS) {
    const dir = `${FileSystem.cacheDirectory || ''}${name}`;
    bytes += await dirSize(dir);
    try {
      const info = await FileSystem.getInfoAsync(dir);
      if (info.exists) {
        await FileSystem.deleteAsync(dir, { idempotent: true });
        dirs += 1;
      }
    } catch {
      /* 单个目录删不掉不影响其它缓存清理 */
    }
  }
  clearLocalImageCache();
  clearCoverFileCache();
  clearRoomBgMemoryCache();
  return { keys: SAFE_KEYS.length, dirs, bytes };
}
