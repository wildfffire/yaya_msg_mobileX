/**
 * 分侧「上次看到的位置」+「已计过消息 id」持久化（用户 2026-11-13「一次性改好」）。
 *
 * 与既有 store 的分工：
 *   · `roomUnread.ts`（v5）的 `lastReadAt` / `sideSeenAt` / `counts` **一行不动**，
 *     继续服务「上次看到这里」分隔行、指纹、角标显示 —— 其它功能不受影响；
 *   · 这里单独存 `yaya_room_seen_v1`：每侧 `{id, time, countedIds}`，
 *     只给 homeowner 主计数层用。
 *
 * 为什么把「已计过的 id」也持久化：旧的 `roomCountLedger` / `countedAt` 都是会话内或
 * 时间游标，进程重启后会清空 / 把 `(上次看到, 已计到)` 区间里的晚到消息吞掉或重放。
 * 改成持久化 id 集合后，「人看到哪」和「机器计过哪」彻底分开，重启不会重计、不会漏补。
 * 集合按侧保留最近 500 个（旧消息被挤出后由时间基线兜底，不会无限膨胀）。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mergeSeen, seenMarkOf, type SeenMark } from '../utils/roomSeenRules';

/** v2：v1 在真机上被「空基线」写入过已认领 id，换新 key 从干净状态开始 */
const STORAGE_KEY = 'yaya_room_seen_v2';
const COUNTED_IDS_MAX = 500;

interface SideState extends SeenMark {
  countedIds: string[];
}

const state = new Map<string, SideState>();
let loaded = false;
let loading: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function ensureSeenLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed: any = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        for (const [key, value] of Object.entries(parsed)) {
          const v = value as any;
          if (!key || !v || typeof v !== 'object') continue;
          // 内存里已经有本会话写入的 markSeen / markSeenAll（比磁盘更新）：不能覆盖回去
          if (state.has(key)) continue;
          state.set(key, {
            id: String(v.id || ''),
            time: Number(v.time) || 0,
            countedIds: Array.isArray(v.countedIds)
              ? v.countedIds.filter((x: any) => typeof x === 'string').slice(-COUNTED_IDS_MAX)
              : [],
          });
        }
      })
      .catch(() => { /* 存储坏了就当首次运行 */ })
      .then(() => { loaded = true; });
  }
  return loading;
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const obj: Record<string, SideState> = {};
    for (const [k, v] of state) obj[k] = v;
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(obj)).catch(() => {});
  }, 800);
}

function stateOf(key: string): SideState {
  return state.get(key) || { id: '', time: 0, countedIds: [] };
}

/** 该侧「上次看到的位置」；null = 还没建立（调用方回退旧 lastReadAt 时间基线） */
export function getSeen(key: string): SeenMark | null {
  const s = state.get(key);
  if (!s) return null;
  // ⚠️ claimCounted 会先建一个「只有已认领 id、还没有基线」的状态，
  // 不能把它当成已建立的基线返回：否则主计数层不再回退旧 lastReadAt，
  // 且 time=0 会让时间兜底把整页历史消息一次刷成未读（真机 +86 事故）。
  if (!s.id && !(s.time > 0)) return null;
  return { id: s.id, time: s.time };
}

/** 进房/看到新消息时推进：只前进，且记录的是**那一条消息的 id**，不是时间戳 */
export function markSeen(key: string, msg: any): void {
  const next = seenMarkOf(msg);
  if (!key || !next) return;
  const merged = mergeSeen(getSeen(key), next);
  if (!merged) return;
  const prev = stateOf(key);
  state.set(key, { id: merged.id, time: merged.time, countedIds: prev.countedIds });
  schedulePersist();
}

/** 一键已读：没有具体消息 id 可记，只把时间基线推到该侧最新活动时间 */
export function markSeenAll(key: string, time: number): void {
  const t = Number(time) || 0;
  if (!key || !(t > 0)) return;
  const prev = stateOf(key);
  state.set(key, { id: '', time: Math.max(prev.time, t), countedIds: prev.countedIds });
  schedulePersist();
}

/** 持久化幂等认领：重启后也不会把同一条房主消息再计一次 */
export function claimCounted(key: string, id: string): boolean {
  const mid = String(id || '').trim();
  if (!key || !mid) return false;
  const s = stateOf(key);
  if (s.countedIds.includes(mid)) return false;
  const countedIds = [...s.countedIds, mid];
  if (countedIds.length > COUNTED_IDS_MAX) countedIds.splice(0, countedIds.length - COUNTED_IDS_MAX);
  state.set(key, { ...s, countedIds });
  schedulePersist();
  return true;
}
