/**
 * 房间回放「上次看到」进度记忆（用户要求：单个偶像房间进入后同步到上次看到的位置）。
 *
 * 按 liveId 记录每场回放的播放进度：
 *   - 房间内回放播放中每 5s 保存一次（FollowedRoomsScreen 的节注定时器调 save）
 *   - 再次点开同一场 → getReplayProgress 命中且进度有效（>15s 且未看完）→ seek 续播 + toast 提示
 * 内存缓存 + 防抖落盘；容量上限 200 条按时间淘汰最旧，防止无限膨胀。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'yaya_room_replay_progress_v1';
const MAX_ENTRIES = 200;

export interface ReplayProgressEntry {
  /** 上次播放位置（秒） */
  position: number;
  /** 该场总时长（秒，可能为 0） */
  duration: number;
  /** 最后观看时间（毫秒，容量淘汰用） */
  at: number;
}

let cache: Record<string, ReplayProgressEntry> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function readAll(): Promise<Record<string, ReplayProgressEntry>> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch {
    cache = {};
  }
  return cache || {};
}

function persist(all: Record<string, ReplayProgressEntry>) {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      // 落盘失败不影响本次播放
    }
  }, 800);
}

export async function getReplayProgress(liveId: string): Promise<ReplayProgressEntry | null> {
  const all = await readAll();
  const entry = all[String(liveId || '')];
  return entry && entry.position > 0 ? entry : null;
}

export async function saveReplayProgress(liveId: string, position: number, duration: number) {
  const key = String(liveId || '');
  if (!key || !(position > 0)) return;
  const all = await readAll();
  all[key] = { position, duration, at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[k];
  }
  persist(all);
}
