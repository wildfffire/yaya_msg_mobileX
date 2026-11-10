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
import { isDetailFromSide, messageId } from '../../utils/roomMessageCursor';
import { roomChannelId, roomSideMessage, roomSideServerUnread, roomSideToken, type RoomMode } from './roomIdentity';
import { getMessageTime, isIdolMessage } from './messageRules';
import { ROOM_UNREAD_SIDES, roomUnreadKey } from '../../utils/roomUnreadRules';

/**
 * 类型口径（用户 2026-11-10 定版「只计偶像」）：false = 只有聊天类消息参与计数
 * （礼物 / 进房特效 / 系统公告不算），且还要过「只计偶像（房主）发言」的过滤。
 * 2026-11-09 曾按用户要求临时开 true 测试链路（全量消息都计数），验完已关。
 */
export const UNREAD_COUNT_ALL_TYPES = false;

/**
 * ★ 只计偶像（房主）发言（用户 2026-11-10：「群聊里的消息也被列入计数了，
 * 应该只要偶像的信息」）。判定与「只看偶像」视图 / 「偶像无消息」同一套严格口径
 * isIdolMessage(member, includeFans=false)：id 匹配 + 昵称兜底；
 * 普通成员的群聊消息只推进指纹、不进角标。
 */
const isIdolOnly = (msg: any, member: any): boolean =>
  !!msg && !!member && isIdolMessage(msg, member, false);

/** 模块级聊天类型判断（精确计数用；口径与下方 hook 内 isChatMessageType 一致） */
const isChatTypeForCount = (m: any): boolean => {
  const t = String(m?.bodys?.messageType || m?.msgType || m?.messageType || m?.messageType || 'TEXT').toUpperCase();
  return /^(TEXT|REPLY|GIFTREPLY|EXPRESSIMAGE|IMAGE|AUDIO|VIDEO|BARRAGE_|FLIP)/.test(t);
};

/**
 * ★ 只计偶像（用户 2026-11-10）：精确数出「某一侧从上次看到现在，**偶像（房主）**一共
 * 发了几条消息」。普通成员的群聊消息不算数（只用于把 seenAt 基线推过去）。
 *
 * 为什么要真的拉消息：房间列表的 `last/message/get` 返回体**没有时间/条数字段**，
 * 指纹只能告诉「有变化」。用户 2026-11-09 反馈「显示 1、实际发了很多」就是固定 +1 的锅。
 *
 * 返回 0 表示「没有偶像新消息」（按新口径，成员消息不算数）。
 */
async function countNewMessagesForSide(
  target: { key: string; id: string; side: RoomMode; member: any },
  prevAt: number,
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
    // ★ 只数偶像（房主）的消息；同时礼物/进房/公告等非聊天类型也不算
    const idolMsgs = msgs.filter(
      (m: any) => isChatTypeForCount(m) && isIdolOnly(m, member),
    );
    // ★ 首次基线（进房清 sideSeenAt 后必然走到）：只建立时间基线，**绝不占用计数总账**。
    // 旧版在这里把整页 20 条 id 逐条认领掉（claimCountId 全页循环）
    // 却返回 0，同时把 seenAt / seenTokens 推进 —— 三条通道此后都判「已处理」，
    // 用户反馈的「第一次计数正确、之后有的新消息没有红点」就是这么来的。
    // 真正的新消息交给 5s 轮询的按 id 补偿扫描补回（它有自己的消息游标，不依赖这里）。
    if (!prevAt) {
      if (newest > 0) seenAtPatch[target.key] = newest;
      logInfo(
        `[unread] 精确计数 ${target.id}#${target.side} 首次基线 页=${msgs.length}`
        + ` 偶像=${idolMsgs.length} newest=${newest} 计=0 不占总账`,
        'room.unread',
      );
      return 0;
    }
    let n = 0;
    for (const m of idolMsgs) {
      const mt = getMessageTime(m);
      // ★ 同一毫秒 / 同一秒连发的多条消息时间相等：旧版 `<= prevAt` 会把除第一条外
      // 全判成「旧消息」漏掉；改成严格小于，去重交给总账（已计过的一定 claim 失败）。
      if (mt > 0 && mt < prevAt) continue;
      // ★ id 总账：实时通道 / 5s 通知轮询已计过的同一条消息不再重复
      if (!claimCountId(messageId(m))) continue;
      n += 1;
    }
    if (newest > 0) seenAtPatch[target.key] = newest;
    logInfo(
      `[unread] 精确计数 ${target.id}#${target.side} prevAt=${prevAt} newest=${newest}`
      + ` 页=${msgs.length} 偶像=${idolMsgs.length} 新=${n}`,
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
   * ① uuid 去重：QChat 断线重连后会**重放最近一批消息**，不去重会把同一条消息反复计入；
   * ② 类型过滤：礼物（PRESENT_*）、进房特效（EVENT_*_ENTER）、系统公告（LIVE_ANNOUNCE 等）
   *    不是「消息」，计入会让数字虚高；
   * ③ 自己发言不计：换房间瞬间 activeChannelRef 尚未切换时，自己消息的回声可能漏过 opened 跳过。
   */
  const countedUuidsRef = useRef<Set<string>>(new Set());
  const countedUuidOrderRef = useRef<string[]>([]);
  const markCountedUuid = (uuid: string): boolean => {
    if (!uuid) return false;
    if (countedUuidsRef.current.has(uuid)) return false;
    countedUuidsRef.current.add(uuid);
    countedUuidOrderRef.current.push(uuid);
    // 滑动窗口：只保留最近 800 条的去重记录（防长期挂机内存/集合膨胀）
    if (countedUuidOrderRef.current.length > 800) {
      for (const old of countedUuidOrderRef.current.splice(0, 200)) countedUuidsRef.current.delete(old);
    }
    return true;
  };

  /**
   * 临时口径（用户 2026-11-09 要求，方便测试）：**所有群聊消息都进角标**。
   * true = 礼物 / 进房特效 / 系统公告也算「新消息」（数字会更容易亮起来，便于验证链路）。
   * 验证完改 false 即回到「只有聊天类」的正式口径（正则见下）。
   */
  const isChatMessageType = (type: string): boolean => {
    if (UNREAD_COUNT_ALL_TYPES) return true;
    const t = String(type || 'TEXT').toUpperCase();
    // FLIP* 也算聊天消息（用户 2026-09-30 反馈翻牌看不到；它不算「聊天」的话
    // 30s 指纹计数会把它当礼物/公告一样跳过 → 有翻牌也没有未读提示）
    return /^(TEXT|REPLY|GIFTREPLY|EXPRESSIMAGE|IMAGE|AUDIO|VIDEO|BARRAGE_|FLIP)/.test(t);
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
      const seenPatch: Record<string, string> = {};
      const floorPatch: Record<string, number> = {};
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
          // 服务端未读数只用来维护「已读地板」（展示层取 max(本地计数, server-floor)），
          // 不再作为旁路短路 / 整数补计：真机实测该字段长期缺失，且含成员消息口径不一致。
          const serverUnread = roomSideServerUnread(row, mode);
          if (serverUnread >= 0) floorPatch[key] = serverUnread;
          // 房间开着：进房已清零，本轮只对齐指纹
          if (String(selectedRoomRef.current?.id || '') === id) {
            seenPatch[key] = token;
            continue;
          }
          const msg = roomSideMessage(row, mode);
          const anyChat = isChatMessageType(
            String(msg?.bodys?.messageType || msg?.msgType || msg?.messageType || ''),
          );
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
        const n = await countNewMessagesForSide(t, seenAtNow[t.key] || 0, seenAtPatch);
        if (n === null) continue; // 详情失败：指纹/基线都不推进，下轮重试
        if (n > 0) { bumpPatch[t.key] = (bumpPatch[t.key] || 0) + n; counted += n; }
        seenPatch[t.key] = t.token;
      }
      /**
       * ⚠️ 一次提交（不是逐键 bump/markSeen）：分侧后一轮最多 2N 次写入，
       * 逐次调用就是 2N 次全量序列化 + 2N 次列表重渲染。
       */
      useRoomUnreadStore.getState().applyUnread({
        bump: bumpPatch, seen: seenPatch, seenAt: seenAtPatch, floor: floorPatch,
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
    countedUuidsRef,
    countedUuidOrderRef,
    markCountedUuid,
    isChatMessageType,
    applyFingerprintCounts,
  };
}
