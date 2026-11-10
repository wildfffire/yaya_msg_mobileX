/**
 * 通知的**纯规则**（零依赖，可进纯 Node 单测）。
 *
 * 三件事：
 *   ① 该不该通知、走系统通知还是 App 内横幅（notifyDecision）—— 对齐桌面端
 *      「软件外 / 软件内」两套开关 + 房间三态 + 仅后台；
 *   ② 同一条消息只通知一次（去重键）—— 轮询/重连重放会重复喂同一批消息；
 *   ③ 同一会话/房间的连发消息合并成一条（mergeBurst）—— 桌面端「同成员合并一条 toast」。
 */

export type NotifyKind = 'pm' | 'room';

export type RoomNotifyMode = 'all' | 'custom' | 'none';

export interface NotifyPolicy {
  /** 免打扰：全部静音 */
  dnd?: boolean;
  /** 软件外（系统通知）总开关 */
  systemEnabled?: boolean;
  /** 软件内横幅总开关 */
  inappEnabled?: boolean;
  pmEnabled?: boolean;
  roomEnabled?: boolean;
  /** 仅 App 不在前台时发系统通知 */
  onlyBackground?: boolean;
  roomMode?: RoomNotifyMode;
  roomMap?: Record<string, boolean>;
  /** App 当前是否在前台（AppState === 'active'） */
  isForeground: boolean;
  kind: NotifyKind;
  /** 房间消息必传：memberId */
  roomId?: string;
}

export interface NotifyDecision {
  system: boolean;
  inapp: boolean;
}

/** 房间三态 → 该房间是否允许通知 */
export function roomNotifyAllowed(mode: RoomNotifyMode | undefined, map: Record<string, boolean> | undefined, roomId?: string): boolean {
  const m = mode || 'all';
  if (m === 'none') return false;
  if (m === 'all') return true;
  const id = String(roomId || '');
  // custom：没显式设过的房间按「开」处理（与桌面端「默认开、单独关」一致）
  return id ? map?.[id] !== false : true;
}

/** 最终决策：系统通知 / 横幅 各自是否发送 */
export function notifyDecision(policy: NotifyPolicy): NotifyDecision {
  const none: NotifyDecision = { system: false, inapp: false };
  if (policy.dnd) return none;
  if (policy.kind === 'pm' && policy.pmEnabled === false) return none;
  if (policy.kind === 'room') {
    if (policy.roomEnabled === false) return none;
    if (!roomNotifyAllowed(policy.roomMode, policy.roomMap, policy.roomId)) return none;
  }
  const systemWanted = policy.systemEnabled !== false;
  // 仅后台：前台时系统通知不发（只留 App 内横幅）
  const system = systemWanted && (!policy.onlyBackground || !policy.isForeground);
  const inapp = policy.inappEnabled !== false && policy.isForeground;
  return { system, inapp };
}

/** 去重键：同一会话/房间里同一条消息只会通知一次 */
export function notifyDedupeKey(kind: NotifyKind, targetId: string, msgId: string): string {
  const t = String(targetId || '');
  const m = String(msgId || '');
  if (!m) return '';
  return `${kind}|${t}|${m}`;
}

/** 通知 id（Android 用同一个 id 覆盖更新同一条通知） */
export function notifyStableId(kind: NotifyKind, targetId: string): number {
  const s = `${kind}|${String(targetId || '')}`;
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
  // 避开 0（部分 ROM 对 id=0 的行为不一致）且落在 32 位正数内
  return (h % 2000000000) + 1000;
}

export interface BurstState {
  count: number;
  title: string;
  body: string;
  at: number;
}

export const BURST_WINDOW_MS = 30_000;

/**
 * 合并连发：30 秒内同一目标再来的消息只更新正文（「N 条新消息」），不刷屏。
 * 返回新状态；调用方据 `count` 决定标题是否带条数。
 */
export function mergeBurst(
  prev: BurstState | null | undefined,
  next: { title: string; body: string },
  now: number,
  windowMs = BURST_WINDOW_MS,
): BurstState {
  const title = String(next.title || '');
  const body = String(next.body || '');
  if (!prev || now - prev.at > windowMs || now < prev.at) {
    return { count: 1, title, body, at: now };
  }
  return { count: prev.count + 1, title: title || prev.title, body, at: now };
}

/** 合并后的展示文案（桌面端口径：正文只留最新一条，标题补「(N)」） */
export function burstText(state: BurstState): { title: string; body: string } {
  if (state.count <= 1) return { title: state.title, body: state.body };
  return { title: `(${state.count}) ${state.title}`, body: state.body };
}

/**
 * 是否需要「后台保活」（用户 2026-11-10：关通知就必须关后台，别耗电）。
 *
 * 保活 = 前台服务 + 后台 5s 轮询，两者只在**确实可能发出软件外通知**时才允许存在：
 *   · 软件外通知总开关关 → 停；
 *   · 免打扰（含横幅全静音）→ 停；
 *   · 私信与房间都关（房间范围=无也算）→ 停。
 * 前台时轮询照跑（角标需要），所以这个判定只用来决定**后台**行为。
 */
export interface KeepAlivePolicy {
  systemEnabled?: boolean;
  dnd?: boolean;
  pmEnabled?: boolean;
  roomEnabled?: boolean;
  roomMode?: RoomNotifyMode;
}

export function shouldKeepMessageAlive(policy: KeepAlivePolicy): boolean {
  if (policy.systemEnabled === false) return false;
  if (policy.dnd === true) return false;
  const pm = policy.pmEnabled !== false;
  const room = policy.roomEnabled !== false && (policy.roomMode || 'all') !== 'none';
  return pm || room;
}
