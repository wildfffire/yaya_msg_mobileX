/**
 * 房间「谁能弹通知」的纯规则（用户 2026-11-10 明确：**只有偶像消息和私信**横幅通知）。
 *
 * 为什么不直接复用 `isIdolMessage(item, room, false)`：
 *   那个函数的 `includeFans=false` 分支在「拿不到发送者 id、昵称也对不上」时
 *   会 `return true` —— 这是给「只看偶像」视图用的**宁可多显示**兜底，
 *   免得偶像消息因为 extInfo 缺字段被过滤掉。搬到通知上就反过来了：
 *   群里一条没带 `ext.user` 的普通成员消息会被判成偶像 → 弹横幅
 *   （用户反馈「有的群聊里的消息也会横幅通知」里的「有的」正是这批）。
 *
 * 通知的取舍相反：**宁可漏、不可误报**。必须明确识别到房主（id 或昵称）才弹；
 * 认不出来的消息一律不弹，但仍会被消息游标消费掉（不会反复重放）。
 *
 * 零 React / 零网络依赖，可直接编译进 `npm run test:core` 单测。
 */
import { normMemberName } from './memberMatch';
// 消息 id 字段别名：与游标/去重共用同一份键表（见 roomMessageCursor.MESSAGE_ID_KEYS）
import { MESSAGE_ID_KEYS } from './roomMessageCursor';

/** 先 trim 再走统一归一：接口昵称偶尔带首尾空格，带空格时团体前缀正则会失配 */
function norm(raw: unknown): string {
  return normMemberName(String(raw ?? '').trim());
}

export interface OwnerIdentity {
  /** 房主本人 id（room.id / userId / memberId），不含 serverId / channelId */
  ids: Array<string | number | null | undefined>;
  /** 房主昵称（ownerName / nickname） */
  names: Array<string | null | undefined>;
}

/**
 * 严格房主判定：明确匹配 id 或明确匹配昵称才算。
 * 与「只看偶像」视图的宽松口径分开维护，避免两边互相污染。
 */
export function isOwnerSender(
  sender: { id?: string; name?: string } | null | undefined,
  owner: OwnerIdentity,
): boolean {
  if (!sender || !owner) return false;
  const senderId = String(sender.id ?? '').trim();
  if (senderId) {
    const ownerIds = (owner.ids || []).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (ownerIds.includes(senderId)) return true;
  }
  // id 不同域（云信 accid / 口袋 account）时靠昵称兜底，两边都归一后再比
  const senderNameKey = norm(sender.name);
  if (!senderNameKey) return false;
  const ownerNameKeys = (owner.names || []).map(norm).filter(Boolean);
  return ownerNameKeys.includes(senderNameKey);
}

/** 一批新消息里只留下房主本人发的（回调由调用方注入，保持本模块零依赖） */
export function pickOwnerMessages(list: any[] | null | undefined, isOwner: (msg: any) => boolean): any[] {
  if (!Array.isArray(list)) return [];
  return list.filter((msg) => !!msg && isOwner(msg));
}

/**
 * ★ 房主判定的数据源优先级（用户 2026-11-10：「对和漏是在不同房间发生的」）。
 *
 * 本地判定（成员库 ownerName/nickname + 消息 ext.user）天生有房间差异：
 * 不同房间的偶像昵称形态（团体前缀、别名、emoji、空格）与消息里的 nickName 对不上，
 * 于是有的房间每次都能认出房主、有的房间一条都认不出 → 角标/横幅表现按房间分化。
 *
 * 服务端 `im/api/v1/team/message/list/homeowner`（getRoomMessages 的 fetchAll:false）
 * 是按房主过滤的权威数据源 —— 用它的**返回消息 id 集合**补本地判定的漏，
 * 与昵称/id 形态无关：本地认不出的房间，只要服务端表里有这条 id 就仍算房主。
 *
 * ⚠️ 只作**补充阳性信号**，绝不拿它做排除：两个接口的 id 字段、分页窗口未必完全一致，
 * 一旦用「表里没有 → 非房主」就会制造新的「按房间漏」（正是这次要修的问题）。
 * 表里没有 / 接口失败 → 一律回退本地判定。
 */
export function isOwnerByServer(
  ownerIds: Set<string> | null | undefined,
  idOrIds: string | string[],
  localFallback: () => boolean,
): boolean {
  if (ownerIds && ownerIds.size) {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    if (ids.some((id) => ownerIds.has(String(id || '')))) return true;
  }
  return localFallback();
}

/**
 * 消息的所有 id 别名。
 * `/list/all` 与 `/list/homeowner` 是同族接口，但实测 id 字段可能一个给
 * `msgIdClient`、另一个给 `msgIdServer` / `messageId`；只拿主 id 比对会让
 * 服务端房主表整表命中不上（又变成「按房间有的对有的漏」）。
 */
export function messageIdAliases(msg: any): string[] {
  if (!msg || typeof msg !== 'object') return [];
  const out: string[] = [];
  for (const key of MESSAGE_ID_KEYS) {
    const raw = msg[key];
    if (raw === null || raw === undefined) continue;
    const s = String(raw).trim();
    if (!s || s === '0' || s === 'undefined' || s === 'null') continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
