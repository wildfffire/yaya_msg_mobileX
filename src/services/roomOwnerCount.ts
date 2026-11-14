/**
 * 「homeowner 页补计」的按侧时间游标（持久化）。
 *
 * 为什么需要独立的持久化游标：
 *   ① `roomCountLedger` 只在会话内有效（进程被杀就清空），单靠它防不住
 *      「重启后把 homeowner 页里的未读房主消息再数一遍 → 角标虚高」；
 *   ② 不能用 `cursor.time`（上次轮询最新时间）当门槛 —— 房主消息常常
 *      **早于**它（被粉丝刷出窗口），那正是这次要修的漏计；
 *   ③ 也不能把 `lastReadAt` 之外的房间级时间拿来当本侧游标：进房会推进它，
 *      但大小房间分侧的房主消息时间各不同。
 *
 * 所以按 `roomUnreadKey(id, side)` 记一个「homeowner 页已补计到的最大消息时间」，
 * 只前进不后退；与 `lastReadAt` 双门槛共同界定「真未读」。
 * 两条计数通道（5s 轮询 / 30s 指纹精确计数）共用这一份游标，配合
 * `roomCountLedger` 的 id 原子认领，谁先补计谁推进。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { nextOwnerCountedAt, pickUncountedOwnerMessages } from '../utils/ownerCountRules';
import { claimCountId } from './roomCountLedger';

const STORAGE_KEY = 'yaya_room_owner_counted_v1';
const countedAt = new Map<string, number>();
let loaded = false;
let loading: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function ensureOwnerCountLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed: any = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        for (const [key, value] of Object.entries(parsed)) {
          const t = Number(value);
          if (key && Number.isFinite(t) && t > 0) countedAt.set(key, t);
        }
      })
      .catch(() => { /* 存储坏了就当首次运行 */ })
      .then(() => { loaded = true; });
  }
  return loading;
}

export function getOwnerCountedAt(key: string): number {
  return countedAt.get(key) || 0;
}

/** 只前进；同一轮多条通道重复推进不会写多次盘 */
export function advanceOwnerCountedAt(key: string, newest: number): void {
  const t = Number(newest) || 0;
  if (!key || !(t > getOwnerCountedAt(key))) return;
  countedAt.set(key, t);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const obj: Record<string, number> = {};
    for (const [k, v] of countedAt) obj[k] = v;
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(obj)).catch(() => {});
  }, 800);
}

export interface OwnerPageCountInput {
  /** 分侧键（roomUnreadKey） */
  key: string;
  /** 本轮拉到的 homeowner 页 */
  page: any[];
  /** 房间级已读基线（服务器消息时间 ms） */
  readFloor: number;
  /** 本轮 all 页里出现过的消息 id 别名集合（与 homeowner 页取差集，防重复） */
  excludeIds: Set<string>;
}

export interface OwnerPageCountResult {
  counted: number;
  newest: number;
  /** 补计前的按侧游标（仅用于诊断日志，保持与原两条通道一致） */
  countedAt: number;
}

/**
 * homeowner 页独立补计的**唯一实现**（5s 轮询 / 30s 精确计数共用）。
 *
 * 用户 2026-11-13「覃柯蒙有非常多消息，房间列表计数没有任何提示」：
 * all 页被粉丝刷满时房主整批被挤出窗口，只有 homeowner 页还能看到；
 * 这里把「晚于已读基线、且不在 all 页里」的房主消息按 id 认领计入。
 *
 * 六步顺序（get 游标 → 差集 → 纯规则挑选 → claim → 累加 → 只前进推进游标）
 * 以前在 messagePollers 与 useRoomUnreadCounters 各写一遍，行为容易漂移；
 * 现在只在这里维护，调用方只负责把 counted 汇进自己的 bumpPatch。
 */
export async function claimUncountedOwnerPage(input: OwnerPageCountInput): Promise<OwnerPageCountResult> {
  await ensureOwnerCountLoaded();
  const countedAt = getOwnerCountedAt(input.key);
  const pick = pickUncountedOwnerMessages(input.page, {
    readFloor: input.readFloor,
    countedAt,
    excludeIds: input.excludeIds,
  });
  let counted = 0;
  for (const mid of pick.ids) {
    if (!claimCountId(mid)) continue;
    counted += 1;
  }
  advanceOwnerCountedAt(input.key, nextOwnerCountedAt(countedAt, pick.newest));
  return { counted, newest: pick.newest, countedAt };
}
