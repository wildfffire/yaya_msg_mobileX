/**
 * 房间列表头像 = 偶像自己在口袋里给房间设置的图标（`serverIcon`）。
 *
 * ⚠️ 与「房间内消息头像」是**两套独立的图**（用户 2026-11-09 明确）：
 *   - 房间内：消息 `ext.user.avatar`（她发言时带的账号头像）—— 见 RoomChatMessageRow
 *   - 房间列表：`im/api/seine/server/detail` 的 `content.chatServerInfo.serverIcon`
 *     （上游 yk1z/yaya_msg `followed-chat-feature.js` 也是拿这个当房间头像）
 *   - 公式照（成员库 `avatar` / 档案 `starAvatar`）只做最后兜底
 *
 * ⚠️ 已废弃的错误做法（勿回退）：
 *   1) 用 `star/archives` 的 `starInfo.avatar` —— 该接口**没有** avatar/userAvatar 字段，
 *      只有 `starAvatar`（就是公式照）→ 永远取不到，列表看起来和「系统公式照」一模一样；
 *   2) 从房间消息里提取（`ext.user.avatar`）—— 那是房间内头像，且要先看过她发言才有。
 *
 * 缓存：内存 zustand + AsyncStorage（上限 500 条，按写入时间淘汰），进程重启仍有效；
 * 有效期见 `ROOM_AVATAR_TTL_MS`：过期后先返回旧图，同时在后台刷新（stale-while-revalidate）。
 * 请求：并发上限 3、同成员去重，失败静默（回退公式照，不会出现空头像）。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import pocketApi from '../api/pocket48';
import { logWarn } from '../utils/runtimeLog';
import {
  parseRoomAvatarMap,
  pickRoomAvatarFromDetail,
  roomAvatarFresh,
  trimRoomAvatarMap,
  type RoomAvatarEntry,
} from '../utils/roomListAvatarRules';

const STORAGE_KEY = 'yaya_room_list_avatar_v1';
const MAX_ENTRIES = 500;
const MAX_CONCURRENT = 3;

interface RoomListAvatarState {
  /** memberId → { url, at }（url 为空 = 拉过但没有自选图标） */
  map: Record<string, RoomAvatarEntry>;
  hydrated: boolean;
  setEntry: (memberId: string, url: string, at?: number) => void;
  ensureHydrated: () => void;
}

function persist(map: Record<string, RoomAvatarEntry>) {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(map)).catch(() => {});
}

export const useRoomListAvatarStore = create<RoomListAvatarState>((set, get) => ({
  map: {},
  hydrated: false,

  setEntry: (memberId, url, at) => {
    const id = String(memberId || '').trim();
    if (!id) return;
    const current = get().map;
    const prev = current[id];
    const nextAt = Number(at) || Date.now();
    const prevUrl = prev?.url || '';
    if (prev && prevUrl === (url || '')) {
      // 结果没变：只把时间往前推（避免每次进列表都重复请求），不触发额外渲染
      if (nextAt - Number(prev.at || 0) < 1000) return;
      const next = { ...current, [id]: { url: prevUrl, at: nextAt } };
      set({ map: next });
      persist(next);
      return;
    }
    const next = trimRoomAvatarMap({ ...current, [id]: { url: url || '', at: nextAt } }, MAX_ENTRIES);
    set({ map: next });
    persist(next);
  },

  ensureHydrated: () => {
    if (get().hydrated) return;
    set({ hydrated: true });
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        const clean = parseRoomAvatarMap(raw);
        if (!Object.keys(clean).length) return;
        // 内存里已有的（本次会话刚拉到的）优先，不被旧缓存覆盖
        const merged = { ...clean };
        Object.keys(get().map).forEach((key) => { merged[key] = get().map[key]; });
        set({ map: trimRoomAvatarMap(merged, MAX_ENTRIES) });
      })
      .catch(() => {});
  },
}));

/** 取缓存（同步；没有则空串） */
export function getCachedRoomListAvatar(memberId: string): string {
  return useRoomListAvatarStore.getState().map[String(memberId || '').trim()]?.url || '';
}

// --- 并发限流（简单信号量） ---
let active = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active = Math.max(0, active - 1);
}

const inflight = new Map<string, Promise<string>>();

/**
 * 确保拿到该成员「房间列表用的自选头像」。
 *
 * @param memberId 成员 id（成员库 id，也是 star/archives 的 memberId）
 * @param serverId 大房间 serverId（`seine/server/detail` 的入参；缺失时只能用缓存/公式照）
 * @returns 自选图标 URL；空串表示没有自选图标（调用方回退公式照）
 */
export async function ensureRoomListAvatar(
  memberId: string,
  serverId: string | number,
  opts: { force?: boolean } = {},
): Promise<string> {
  const id = String(memberId || '').trim();
  const sid = String(serverId || '').trim();
  if (!id) return '';

  const entry = useRoomListAvatarStore.getState().map[id];
  if (!opts.force && roomAvatarFresh(entry)) return entry?.url || '';
  // 没有 serverId 就无从取自选图标：先用缓存（可能是上次解析到的），否则交给公式照
  if (!sid || sid === '0' || sid === 'undefined' || sid === 'null') return entry?.url || '';

  const key = `${id}:${sid}`;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    await acquire();
    try {
      const res: any = await pocketApi.getSeineServerDetail(Number(sid));
      const content = res?.content ?? res?.data ?? {};
      const url = pickRoomAvatarFromDetail(content);
      // 空结果也要落缓存（at 记下来 = 这段时间内不再重复请求）
      useRoomListAvatarStore.getState().setEntry(id, url);
      return url;
    } catch (e: any) {
      logWarn(`[roomAvatar] 拉取房间图标失败 member=${id} server=${sid}：${e?.message || String(e)}`, 'room');
      return entry?.url || '';
    } finally {
      release();
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}
