/**
 * 未读计数精准化（第 6 步 · 6b-2）。
 *
 * 这批逻辑回答一个问题：**一条新消息该不该让房间角标 +1**。三条口径缺一不可：
 *   ① uuid 去重：QChat 断线重连会**重放最近一批消息**，不去重会反复计数；
 *   ② 类型过滤：礼物 / 进房特效 / 系统公告不是「消息」，计入会让数字虚高；
 *   ③ 自己发言不计：换房间瞬间 activeChannelRef 尚未切换时，自己消息的回声可能漏过跳过。
 *
 * 与实时通道 / 5s 通知轮询的分工（2026-11-10 定版）：三条通道共用
 * `services/roomCountLedger` 的**消息 id 原子认领**，谁先认领谁计数。
 * 旧版用 `realtimeCountedRef` 做整数相减，不同源的两个数一减就归零，
 * 而指纹 / seenAt 基线却已经推进 —— 整批未读永久消失。
 *
 * 返回值与原变量同名，所以主文件里 loadFollowed / refreshLastMessages / 实时回调等调用点零改动。
 */
import { useCallback, useRef } from 'react';
import pocketApi from '../../api/pocket48';
import { unwrapList } from '../../utils/data';
import { logInfo } from '../../utils/runtimeLog';
import { useRoomUnreadStore } from '../../services/roomUnread';
import { claimCountId } from '../../services/roomCountLedger';
import {
  isCountableChatMessage,
  isCountableMessageType,
  isCountableUnreadMessage,
  isDetailFromSide,
  messageId,
  messageTypeOf,
} from '../../utils/roomMessageCursor';
import { messageIdAliases } from '../../utils/notifyOwnerRules';
import { roomChannelId, roomSideMessage, roomSideToken, type RoomMode } from './roomIdentity';
import { getMessageTime, isOwnerMessageStrict, senderProfile } from './messageRules';
import { ROOM_UNREAD_SIDES, roomUnreadKey } from '../../utils/roomUnreadRules';

/**
 * 类型口径（用户 2026-11-10 定版「只计偶像」）：false = 只有聊天类消息参与计数
 * （礼物 / 进房特效 / 系统公告不算），且还要过「只计偶像（房主）发言」的过滤。
 * 2026-11-09 曾按用户要求临时开 true 测试链路（全量消息都计数），验完已关。
 */
export const UNREAD_COUNT_ALL_TYPES = false;

/**
 * ★ 只计偶像（房主）发言，且**走严格判定**（用户 2026-11-10 定口径、2026-11-11 明确「都走严格」）：
 * 与通知 / 列表预览同一个谓词 `isOwnerMessageStrict`（id 或昵称必须明确命中）。
 *
 * ⚠️ 不再用 `isIdolMessage(..., false)`：它在「拿不到发送者 id」时会 return true
 *（那是「只看偶像」视图宁可多显示的兜底），用在计数上会把没带资料子树的粉丝消息算成偶像。
 * 普通成员的群聊消息只推进指纹、不进角标。
 */
const isIdolOnly = (msg: any, member: any): boolean =>
  !!msg && !!member && isOwnerMessageStrict(msg, member);

/**
 * 聊天类型判断：口径统一在 `utils/roomMessageCursor.isCountableChatMessage`
 *（实时 / 5s 轮询 / 30s 精确计数共用同一份取值与正则，避免三处漂移）。
 */
const isChatTypeForCount = isCountableChatMessage;

/**
 * 服务端房主消息 id 表（按侧缓存，10 分钟）。
 *
 * 为什么需要（用户 2026-11-11「房间列表里有的成员有新消息不会计数也不显示」）：
 * 本地房主判定靠成员库 `ownerName/nickname` 与消息里的 `ext.user` 比对 ——
 * 不同房间的昵称形态（团体前缀 / 别名 / emoji / 空格）对不上时**一条都认不出**，
 * 于是这一侧的角标永远数 0（用户此前反馈的「对和漏是在不同房间发生的」正是这个）。
 * `/team/message/list/homeowner`（`getRoomMessages({fetchAll:false})`）是服务端按房主
 * 过滤的权威数据源，用它的消息 id 集合作为**补充阳性信号**（绝不拿它做排除）。
 *
 * 成本控制：只有本轮「本地一条房主消息都没认出」才会请求，并按侧缓存 **60 秒** ——
 * 群聊很热闹但房主没发言的房间不会每轮都多打一个请求；
 * TTL 不能太长：缓存里是「已有的房主消息 id」，房主**刚发**的新消息不在表里，
 * 缓存久了会把这批新消息一直判成「不是房主」（最多延迟到下一次刷新）。
 */
const OWNER_IDS_TTL_MS = 60_000;
const ownerIdCache = new Map<string, { ids: Set<string>; at: number }>();

async function fetchOwnerIdSet(member: any, side: RoomMode, channelId: string): Promise<Set<string> | null> {
  try {
    const params: any = {
      channelId,
      serverId: String(member?.serverId || ''),
      nextTime: 0,
      limit: 50,
      fetchAll: false,
    };
    if (side === 'small' && member?.channelId) params.fallbackChannelId = String(member.channelId);
    const res: any = await pocketApi.getRoomMessages(params);
    // 小房间详情回退到大房间频道时这张表不能用来判本侧房主
    if (!isDetailFromSide(res?._request?.payload?.channelId, channelId)) return null;
    const list = unwrapList(res, [
      'content.messageList', 'content.message', 'content.messages', 'content.list',
      'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list',
    ]);
    if (!list.length) return null;
    const ids = new Set<string>();
    for (const m of list) {
      for (const mid of messageIdAliases(m)) ids.add(mid);
    }
    return ids.size ? ids : null;
  } catch {
    return null;
  }
}

/**
 * ★ 只计偶像（用户 2026-11-10）：精确数出「某一侧从上次看到现在，**偶像（房主）**一共
 * 发了几条消息」。普通成员的群聊消息不算数（只用于把 seenAt 基线推过去）。
 *
 * 为什么要真的拉消息：房间列表的 `last/message/get` 返回体**没有时间/条数字段**，
 * 指纹只能告诉「有变化」。用户 2026-11-09 反馈「显示 1、实际发了很多」就是固定 +1 的锅。
 *
 * 返回 0 表示「没有偶像新消息」（按新口径，成员消息不算数）。
 *
 * ★ 2026-11-11 两条修正（用户「有的成员有新消息不会计数也不显示」）：
 *   ① **基线不再只看 `sideSeenAt`**：它会在每次进房被清零（两侧），于是退房后新到的
 *      消息只要先被 30s 路径撞上就被当「首次基线」整批吞掉（指纹却已推进）→ 永不计数。
 *      现在把房间级已读基线 `lastReadAt` 也当作计数下限：读过这个房间（>0）就照常计数，
 *      只有「既没侧基线也没读过」才建基线。
 *   ② **房主认不出时问服务端**：本地判定 0 条房主消息时，用 homeowner 表（按侧缓存）
 *      的 id 集合补一次 —— 与 5s 通知轮询同源，避免「不同房间有的对有的漏」。
 */
async function countNewMessagesForSide(
  target: { key: string; id: string; side: RoomMode; member: any },
  prevAt: number,
  readFloor: number,
  seenAtPatch: Record<string, number>,
): Promise<number | null> {
  try {
    const member = target.member || {};
    const channelId = roomChannelId(member, target.side);
    if (!channelId) return null;
    const params: any = {
      channelId,
      serverId: String(member?.serverId || ''),
      nextTime: 0,
      limit: 20,
      fetchAll: true,
    };
    if (target.side === 'small' && member?.channelId) params.fallbackChannelId = String(member.channelId);
    const res: any = await pocketApi.getRoomMessages(params);
    /**
     * ★ 小房间详情回退到大房间频道时，`tryPocketPost` 命中的是 fallbackChannelId。
     * 消息体本身不带 channelId，若照单全收就会把「已读的大房间消息」数成小房间未读
     *（用户 2026-11-10：「已经消除过的消息再次提示，并出现在小房间」）。
     * 直接丢弃本轮结果：不计数、不推进 seenAt/指纹，下轮重试。
     */
    if (!isDetailFromSide(res?._request?.payload?.channelId, channelId)) {
      logInfo(
        `[unread] 精确计数 ${target.id}#${target.side} 详情回退到 ch=${res?._request?.payload?.channelId}`
        + `（本侧=${channelId}），丢弃防串味`,
        'room.unread',
      );
      return null;
    }
    const list = unwrapList(res, [
      'content.messageList', 'content.message', 'content.messages', 'content.list',
      'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list',
    ]);
    /**
     * ⚠️ 不要再按 channelId 过滤侧（真机 2026-11-09 22:14：「新消息不计数了」）：
     * `im/api/v1/team/message/list/*` 的消息体里**没有 channelId/serverId**
     *（字段只有 msgIdServer / msgIdClient / bodys / extInfo / msgType / msgTime），
     * 按侧过滤会把整页消息全丢掉 → 数出 0 条 → 角标只闪一下「新」然后消失。
     */
    const msgs = (list || []).filter(Boolean);
    // 空页 / 异常响应不能推进基线：旧版无论成功失败都写 seenPatch + seenAt，
    // 一次 504 就会把整批未读永久吃掉（用户反馈「部分新消息不提示」）。
    if (!msgs.length) {
      logInfo(`[unread] 精确计数 ${target.id}#${target.side} 详情为空，游标不推进`, 'room.unread');
      return null;
    }
    let newest = 0;
    for (const m of msgs) {
      const mt = getMessageTime(m);
      if (mt > newest) newest = mt;
    }
    const floor = Number(readFloor) || 0;
    // ★ 首次基线：只有「侧基线未知 **且** 这个房间没读过」才建。
    // 建基线时**绝不占用计数总账**（旧版把整页 id 认领掉又返回 0，
    // 三条通道此后都判「已处理」→ 用户反馈的「第一次计数正确、之后有的新消息没有红点」）。
    if (!(Number(prevAt) > 0) && !(floor > 0)) {
      if (newest > 0) seenAtPatch[target.key] = newest;
      logInfo(
        `[unread] 精确计数 ${target.id}#${target.side} 首次基线 页=${msgs.length}`
        + ` newest=${newest} 计=0 不占总账`,
        'room.unread',
      );
      return 0;
    }
    // ★ 只数偶像（房主）的消息；同时礼物/进房/公告等非聊天类型也不算
    const hasSideBaseline = Number(prevAt) > 0;
    const candidates = msgs.filter((m: any) => {
      if (!isChatTypeForCount(m)) return false;
      const mt = getMessageTime(m);
      // 只靠「房间已读基线」判新（侧基线为 0）时，时间不明的消息不当新消息 ——
      // 否则一页没有 msgTime 字段的历史消息会被整页刷成未读（「5 条显示 13」的同类）
      if (mt <= 0 && !hasSideBaseline) return false;
      return isCountableUnreadMessage(mt, prevAt, floor);
    });
    let idolMsgs = candidates.filter((m: any) => isIdolOnly(m, member));
    /** 本地认不出房主时的服务端补充（诊断用） */
    let serverOwnerHits = 0;
    if (!idolMsgs.length && candidates.length) {
      const cached = ownerIdCache.get(target.key);
      let ids: Set<string> | null = null;
      if (cached && Date.now() - cached.at < OWNER_IDS_TTL_MS) {
        ids = cached.ids;
      } else {
        ids = await fetchOwnerIdSet(member, target.side, channelId);
        if (ids) ownerIdCache.set(target.key, { ids, at: Date.now() });
      }
      if (ids && ids.size) {
        idolMsgs = candidates.filter((m: any) => messageIdAliases(m).some((mid) => ids!.has(mid)));
        serverOwnerHits = idolMsgs.length;
        logInfo(
          `[unread] 精确计数 ${target.id}#${target.side} 本地认不出房主，`
          + `服务端 homeowner 表命中 ${serverOwnerHits}/${candidates.length}`,
          'room.unread',
        );
      }
    }
    /**
     * ★ 仍是 0 条命中：把候选消息的**发送者**打出来（用户 2026-11-11
     * 「覃柯蒙 15:45 的消息没有角标」）。没有这行就分不清
     * 「真不是房主」和「是房主但 id/昵称对不上」。
     */
    if (!idolMsgs.length && candidates.length) {
      const senders = candidates.slice(0, 3).map((m: any) => {
        const p = senderProfile(m, member);
        return `${String(messageId(m)).slice(-8)} id=${p.id || '-'} nick=${p.name || '-'} t=${getMessageTime(m)}`;
      }).join(' | ');
      logInfo(
        `[unread] 精确计数 ${target.id}#${target.side} 房主未识别 候选=${candidates.length} 样例=${senders}`,
        'room.unread',
      );
    }
    let n = 0;
    for (const m of idolMsgs) {
      // ★ id 总账：实时通道 / 5s 通知轮询已计过的同一条消息不再重复
      if (!claimCountId(messageId(m))) continue;
      n += 1;
    }
    if (newest > 0) seenAtPatch[target.key] = newest;
    logInfo(
      `[unread] 精确计数 ${target.id}#${target.side} prevAt=${prevAt} 已读=${floor} newest=${newest}`
      + ` 页=${msgs.length} 候选=${candidates.length} 偶像=${idolMsgs.length}`
      + ` 服务端=${serverOwnerHits} 新=${n}`,
      'room.unread',
    );
    return n;
  } catch (e: any) {
    logInfo(`[unread] 精确计数 ${target.id}#${target.side} 失败：${String(e?.message || e || '')}`, 'room.unread');
    return null;
  }
}

export function useRoomUnreadCounters(selectedRoom: { id?: any } | null) {
  /**
   * 「当前在哪个房间」的镜像（ref 读）。
   *
   * ⚠️ 为什么不能让 `applyFingerprintCounts` 依赖 `selectedRoom`（用户 2026-09-30：
   * 「反复进出房间会卡」）：它一旦随进出房换引用，订阅了它的**列表轮询 effect 就会整轮重跑**
   * —— 每次进房 / 退房都立刻打一轮 `getLiveList(size:100)` + 全量房间最新消息 + 上麦扫描，
   * 反复进出 = 反复打全量请求，请求互抢、列表闪。
   * 用 ref 读值后这个函数引用恒定（deps 为空），轮询只由「是否聚焦」驱动。
   */
  const selectedRoomRef = useRef(selectedRoom);
  selectedRoomRef.current = selectedRoom;

  /** 指纹计数防重入（loadFollowed 与 30s 轮询会各调一次） */
  const fingerprintBusyRef = useRef(false);
  /** 一轮最多精确计数多少个侧（防关注很多房间时一次打几十个详情请求） */
  const roundRef = useRef(0);

  /* ───────── 未读计数精准化（用户要求 2026-09-28）─────────
   * 消息级去重不在本 hook 里做：实时 / 5s 轮询 / 30s 指纹三条通道统一认领
   * `services/roomCountLedger` 的消息 id 总账（`claimCountId` / `markCountConsumed`），
   * 以前这里额外维护一份 uuid 去重窗口，属于重复实现（且窗口一滑就会漏判）。
   */

  /**
   * 临时口径（用户 2026-11-09 要求，方便测试）：**所有群聊消息都进角标**。
   * true = 礼物 / 进房特效 / 系统公告也算「新消息」（数字会更容易亮起来，便于验证链路）。
   * 验证完改 false 即回到「只有聊天类」的正式口径（正则见下）。
   */
  const isChatMessageType = (type: string): boolean => {
    if (UNREAD_COUNT_ALL_TYPES) return true;
    // FLIP* 也算聊天消息（用户 2026-09-30 反馈翻牌看不到；它不算「聊天」的话
    // 30s 指纹计数会把它当礼物/公告一样跳过 → 有翻牌也没有未读提示）
    return isCountableMessageType(type);
  };

  /**
   * 指纹计数（列表加载与 30s 轮询共用）：指纹变化只作为「去拉详情」的信号，
   * 真正计数交给 `countNewMessagesForSide`（按消息 id 认领 + sideSeenAt 基线）。
   *
   * ★ 2026-11-10 修正三处会静默吞消息的旧行为：
   *   ① 最新一条不是偶像 / 非聊天类型就整轮 `continue` —— 偶像消息夹在成员消息
   *      之间时该侧永远不计数；现在一律拉详情，在详情里逐条判偶像。
   *   ② 服务端 `unreadCount` 存在时直接 `continue` 并短路精确计数 —— 服务端恒 0
   *      （或官方客户端已读同步）时该房间整场不计；现在只更新「已读地板」。
   *   ③ 无论详情成功失败都写 `seenPatch` / `seenAt` —— 一次 504 就把整批未读吃掉；
   *      现在只有详情成功才推进。
   *
   * ⚠️ 分侧（用户 2026-09-30）：大房间与小房间各自比对、各自计数。
   */
  const applyFingerprintCounts = useCallback((rows: any[]) => {
    /**
     * 防重入：loadFollowed 与 30s 轮询的 refreshLastMessages 会先后各调一次，
     * 两轮并发读到同一个「旧指纹」→ 同一批消息被数两遍。上一轮没跑完就直接跳过。
     */
    if (fingerprintBusyRef.current) return;
    fingerprintBusyRef.current = true;
    roundRef.current += 1;
    void useRoomUnreadStore.getState().hydrate().then(async () => {
      const store = useRoomUnreadStore.getState();
      const seenNow = store.seenTokens;
      const seenAtNow = store.sideSeenAt || {};
      /**
       * 房间级已读基线（服务器消息时间 ms）：与 `sideSeenAt` 一起作为精确计数的下限。
       * `sideSeenAt` 会在进房时被清零，只靠它会让「退房后新到的消息」被当成首次基线吞掉。
       */
      const readAtNow = store.lastReadAt || {};
      const seenPatch: Record<string, string> = {};
      const targets: Array<{ key: string; id: string; side: RoomMode; member: any; token: string }> = [];
      for (const row of rows) {
        const id = String(row.memberId || row.member?.id || '');
        if (!id) continue;
        for (const side of ROOM_UNREAD_SIDES) {
          const mode = side as RoomMode;
          const token = roomSideToken(row, mode);
          if (!token) continue;
          const key = roomUnreadKey(id, side);
          const prev = seenNow[key];
          if (!prev || prev === token) continue;
          // 房间开着：进房已清零，本轮只对齐指纹
          if (String(selectedRoomRef.current?.id || '') === id) {
            seenPatch[key] = token;
            continue;
          }
          const msg = roomSideMessage(row, mode);
          const anyChat = isChatMessageType(messageTypeOf(msg));
          if (!anyChat || !isIdolOnly(msg, row.member)) {
            // ★ 不再直接 continue：最新消息是成员/礼物时，详情页里可能还有偶像新消息
            logInfo(
              `[unread] 指纹变化 ${id}#${side} 最新=${anyChat ? '聊天' : '非聊天'}`
              + ` 偶像=${isIdolOnly(msg, row.member) ? 1 : 0}，仍拉详情按 id 精确计数`,
              'room.unread',
            );
          }
          targets.push({ key, id, side: mode, member: row.member, token });
        }
      }
      // 一轮最多 12 个详情请求；超出的保留指纹不变，下一轮继续（不会永久吞）
      let picked = targets;
      if (picked.length > 12) {
        const start = (roundRef.current * 5) % picked.length;
        picked = [...picked.slice(start), ...picked.slice(0, start)].slice(0, 12);
      }
      const bumpPatch: Record<string, number> = {};
      const seenAtPatch: Record<string, number> = {};
      let counted = 0;
      for (const t of picked) {
        const n = await countNewMessagesForSide(
          t,
          seenAtNow[t.key] || 0,
          Number(readAtNow[t.id]) || 0,
          seenAtPatch,
        );
        if (n === null) continue; // 详情失败：指纹/基线都不推进，下轮重试
        if (n > 0) { bumpPatch[t.key] = (bumpPatch[t.key] || 0) + n; counted += n; }
        seenPatch[t.key] = t.token;
      }
      /**
       * ⚠️ 一次提交（不是逐键 bump/markSeen）：分侧后一轮最多 2N 次写入，
       * 逐次调用就是 2N 次全量序列化 + 2N 次列表重渲染。
       */
      useRoomUnreadStore.getState().applyUnread({
        bump: bumpPatch, seen: seenPatch, seenAt: seenAtPatch,
      });
      logInfo(
        `[unread] 本轮 rows=${rows.length} targets=${picked.length} bump=${Object.keys(bumpPatch).length}`
        + ` 计=${counted} 未处理=${targets.length - picked.length}`,
        'room.unread',
      );
    }).finally(() => {
      fingerprintBusyRef.current = false;
    });
    // ⚠️ 依赖必须为空：见上方 selectedRoomRef 的说明（引用不恒定 = 反复进出房间狂打请求）
  }, []);

  return {
    isChatMessageType,
    applyFingerprintCounts,
  };
}
