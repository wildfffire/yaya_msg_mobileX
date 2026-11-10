/**
 * 直播间实时弹幕 Hook（云信聊天室）。
 *
 * 链路：liveId → getLiveOne(content.roomId) + im/userinfo(accid/pwd) → 云信聊天室连接 → 弹幕流。
 * 与录播弹幕（msgFilePath 指向的 LRC 文件，走 parseDanmaku）互不影响：
 *   - 录播：DanmakuOverlay + utils/danmaku
 *   - 直播：本 Hook + LiveBarrageBoard
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import pocketApi from '../api/pocket48';
import { LiveChatroom, type ChatroomStatus } from '../services/pocketNim/chatroom';
import { loadNimCredentials, loadSelfProfile } from '../services/pocketNim/credentials';
import { getNimSessionEpoch, subscribeNimSession } from '../services/pocketNim/session';
import { BarrageItem, LiveGiftBroadcast } from '../services/pocketNim/types';
import { onChatroomOnline } from '../native/PocketNimChatroom';
import { replaceEmojiText } from '../utils/emoji';
import { checkMaskWords } from '../services/maskWords';
import { t } from '../i18n';

/** 弹幕列表上限（超出丢弃最旧的，避免长时间挂直播间内存膨胀） */
const MAX_ITEMS = 300;
/**
 * 弹幕批量上屏间隔（毫秒）。
 *
 * ⚠️ 为什么必须批量（用户 2026-09-30：「房间的性能还是很低，很容易卡住」）：
 * 这个 hook 的 `items` 状态挂在**整个房间页组件**上（175KB，含 Chat 列表、BlurView 工具条、
 * 全部消息行）。直播高峰每秒几十条弹幕 → 以前每条一次 `setItems` → 每秒几十次整屏重渲染。
 * 攒批后最多 4 次/秒，视觉上完全看不出差别。
 */
const BARRAGE_FLUSH_MS = 250;

/**
 * 弹幕通道**自愈**参数。
 *
 * 用户 2026-09-30：「直播看一会就没有弹幕了，必须重新开关一下才能重新有一会」。
 *
 * 根因：`LiveChatroom` 只有**连接时**的多路重试（账号+token → 匿名 → 先 IM 登录），
 * 连上之后一旦被服务端断开、或 SDK 假死（`onStatus` 报 closed/error 且不再回调 onmsgs），
 * 应用层**没有任何重连动作** —— 弹幕就永久停住，直到用户切房 / 重新开关（hook 重跑）才有「一会」。
 *
 * 两层自愈：
 *   ① 状态驱动：收到 closed / error → 按退避延迟重连（3s → 8s → 20s → 45s，最多 4 次）；
 *   ② 看门狗：状态仍是 connected 但连续 150s 收不到任何弹幕 → 主动重连一次（冷却 5 分钟），
 *      覆盖「连着但不再推消息」的假死态（冷清直播间不会被频繁重连）。
 */
const RECONNECT_DELAYS = [3000, 8000, 20000, 45000, 60_000];
/**
 * 看门狗：连续多久没收到弹幕就认为通道假死（毫秒）。
 *
 * ⚠️ 从 150s 收紧到 45s（用户 2026-09-30 第二次反馈「弹幕还是会过一段时间不出现」）：
 * 150s 的阈值在真机上等于"用户早就以为坏了"，自愈再准也来不及。
 * 45s 对热门直播间（正常每秒都有弹幕）足够安全，冷清直播间最多每 90s 被重连一次。
 */
const WATCHDOG_IDLE_MS = 45_000;
/** 看门狗强制重连的冷却（毫秒）：允许反复自愈，而不是"一次不行就放弃" */
const WATCHDOG_COOLDOWN_MS = 90_000;
/** 看门狗检查间隔（毫秒） */
const WATCHDOG_TICK_MS = 15_000;

export interface UseLiveBarrageOptions {
  /** 直播 id；为空则不连接 */
  liveId?: string;
  /** 是否启用（例如只在直播中进行中开启） */
  enabled?: boolean;
  /** 'live' 成员直播（默认）/ 'public' 公开直播 */
  module?: 'live' | 'public';
}

export interface UseLiveBarrageResult {
  items: BarrageItem[];
  status: ChatroomStatus | 'idle' | 'resolving';
  error: string;
  /** 是否已连上聊天室（可发送） */
  ready: boolean;
  /**
   * 聊天室**实时**在线人数（0 = 未知/未连接）。
   *
   * 这是「真实在场人数」的唯一来源：原生 13/13 getChatroomInfo 的 onlineMemberNum，
   * 连上后立即上报一次、之后每 10s 一次。播放器顶栏的「N 人在线」用的就是它
   *（见 MediaPlaybackHost 的 onlineStat）。官方 `getLiveOne.content.onlineNum`
   * 实测是**本场累计观看人次**（只增不减、∝开播时长、结束后定格），
   * 只在聊天室拿不到时降级显示为「累计 N 人看过」。
   *
   * 注意：只统计连着聊天室的观众（App/网页登录观看者），静默看流的不计入。
   */
  online: number;
  send: (text: string) => Promise<void>;
  /**
   * 送礼公屏广播（送礼成功后调用）。
   *
   * ⚠️ 只调 HTTP `/gift/api/v1/gift/send` 不会产生公屏消息 → 主播和观众都看不到
   * 「我送的」礼物（用户反馈 2026-09-29）。这里补发一条云信 PRESENT_NORMAL，
   * 并本地乐观上屏（礼物特效层据此立即播放）。
   */
  sendGift: (gift: LiveGiftBroadcast) => Promise<void>;
  clear: () => void;
  retry: () => void;
}

export function useLiveBarrage(options: UseLiveBarrageOptions): UseLiveBarrageResult {
  const { liveId, enabled = true, module = 'live' } = options;
  const [items, setItems] = useState<BarrageItem[]>([]);
  const [status, setStatus] = useState<ChatroomStatus | 'idle' | 'resolving'>('idle');
  const [error, setError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const [online, setOnline] = useState(0);
  /**
   * 云信会话世代：切号 / 换号后 +1。
   * 连接是用「当时的账号凭证」建立的，换代后必须整条重连
   * （否则新号身份发弹幕会被告知无权限，或仍以旧号身份发出）。
   */
  const [sessionEpoch, setSessionEpoch] = useState(getNimSessionEpoch);
  useEffect(() => subscribeNimSession(setSessionEpoch), []);

  const chatroomRef = useRef<LiveChatroom | null>(null);
  const seqRef = useRef(0);
  // 乐观上屏记录：聊天室不一定回投自己的弹幕，发送成功后本地先插一条；
  // 服务端回投到达时按 昵称+文本 去重（60s 窗口，只吞第一条）
  const lastLocalRef = useRef<{ nick: string; text: string; ts: number; consumed: boolean } | null>(null);

  /** 攒批缓冲 + flush 定时器（见 BARRAGE_FLUSH_MS 的说明） */
  const pendingRef = useRef<BarrageItem[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 自愈用：最后收到弹幕的时间 / 重连尝试次数 / 重连定时器 / 上次看门狗强制重连时间 */
  const lastMsgAtRef = useRef(Date.now());
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastForcedReconnectRef = useRef(0);
  /** 状态镜像：看门狗定时器里读它（避免闭包拿到过期 status） */
  const statusRef = useRef<ChatroomStatus | 'idle' | 'resolving'>('idle');
  statusRef.current = status;
  /** 上一次连接的直播间 id：用于区分「换房」与「自愈重连」（见 effect 里的 setItems 条件） */
  const liveIdRef = useRef('');

  const retry = useCallback(() => setRetryToken((n) => n + 1), []);
  const clear = useCallback(() => {
    pendingRef.current = [];
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    setItems([]);
  }, []);

  useEffect(() => {
    const id = String(liveId || '');
    if (!enabled || !id) {
      setStatus('idle');
      /**
       * 释放残留（最多 300 条弹幕对象）：退房/退出直播后不该继续驻留 ——
       * 用户 2026-09-30 反馈「直播退出所有界面都出现卡顿」，这些对象会被 Rooms/Media
       * 两个常驻 Tab 一直持有（它们不会卸载）。
       */
      setItems([]);
      pendingRef.current = [];
      return undefined;
    }
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    let cancelled = false;

    setError('');
    setStatus('resolving');
    setOnline(0); // 换房间先清零，避免显示上一间的人数
    /**
     * ⚠️【串台修复】换房间清空旧弹幕列表，避免上一间的弹幕残留到新直播间（弹幕列表/飘屏同源）。
     * 但**自愈重连（同一直播间）不清空**（用户 2026-09-30：列表里明明有弹幕、屏幕上却没有）——
     * 以前每次重连都会把列表清空一次，用户看到的是"弹幕突然全没了"。
     */
    if (liveIdRef.current !== id) {
      liveIdRef.current = id;
      setItems([]);
    }
    /**
     * 在线人数：原生聊天室连接后立即上报一次、之后每 10s 一次
     *（NimChatroomClient.handleOnlineCount → PocketNimChatroomModule.emit('online')）。
     * 事件是全局的，这里用 seq 守卫，只认当前这次连接的房间。
     */
    const offOnline = onChatroomOnline((count) => {
      if (cancelled || seqRef.current !== seq) return;
      setOnline(Number(count) > 0 ? Number(count) : 0);
    });

    lastMsgAtRef.current = Date.now();
    /**
     * 连接掉了就自动重连（状态驱动自愈）。
     * ⚠️ 必须定义在 effect 内：它要用本次 effect 的 `cancelled` / `seq` 守卫，
     * 否则旧连接的迟到重连会把新直播间的连接顶掉。
     */
    const scheduleReconnect = () => {
      if (cancelled || seqRef.current !== seq) return;
      if (reconnectTimerRef.current) return;
      /**
       * 重试次数**不设上限**（退避封顶 60s）：聊天室被服务端反复踢（多设备登录 / 限流）时，
       * 以前"4 次后放弃"会让弹幕永久停住、只能手动重新开关 —— 那正是用户的抱怨。
       * 现在改为持续自愈：间隔最长 60s 一次，代价可忽略。
       */
      const attempt = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = attempt;
      // 退避数组用尽后按最后一档（60s）持续重试
      const delay = RECONNECT_DELAYS[Math.min(attempt - 1, RECONNECT_DELAYS.length - 1)];
      // eslint-disable-next-line no-console
      console.log('[nim] barrage reconnect scheduled', attempt, `${delay}ms`);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (cancelled || seqRef.current !== seq) return;
        setRetryToken((n) => n + 1); // 触发连接 effect 重跑 → 重建 LiveChatroom
      }, delay);
    };

    (async () => {
      const [credentials, chatroom] = await Promise.all([
        loadNimCredentials(),
        pocketApi.getLiveChatroom(id).catch(() => null),
      ]);
      if (cancelled || seqRef.current !== seq) return;
      // 诊断：确认聊天室坐标是否解析成功（成员直播弹幕不显示时先看这条）
      // eslint-disable-next-line no-console
      console.log('[nim] live barrage resolve liveId=', id, 'roomId=', chatroom?.roomId || '(none)', 'creds=', credentials ? credentials.accid : '(none)');
      if (!credentials) {
        setStatus('error');
        setError('未取到云信登录凭证，请先登录口袋48账号');
        return;
      }
      if (!chatroom?.roomId) {
        setStatus('error');
        setError('该直播未返回聊天室房间号（可能已结束或为回放）');
        return;
      }

      const instance = new LiveChatroom({
        roomId: chatroom.roomId,
        liveId: chatroom.sourceId || id,
        credentials,
        module,
        onMessages: (incoming) => {
          if (cancelled || seqRef.current !== seq) return;
          // 自愈计时：只要还有消息进来，看门狗就不会误判假死
          lastMsgAtRef.current = Date.now();
          // 吞掉乐观上屏那条的服务端回投（昵称+文本匹配，只吞第一条）
          const lastLocal = lastLocalRef.current;
          const deduped = lastLocal && !lastLocal.consumed
            ? incoming.filter((it) => {
                if (it.text === lastLocal.text && it.nick === lastLocal.nick) {
                  lastLocal.consumed = true;
                  return false;
                }
                return true;
              })
            : incoming;
          // 攒批上屏（见 BARRAGE_FLUSH_MS）：先入缓冲，定时合并提交一次
          pendingRef.current = deduped.concat(pendingRef.current);
          if (flushTimerRef.current == null) {
            flushTimerRef.current = setTimeout(() => {
              flushTimerRef.current = null;
              const batch = pendingRef.current;
              pendingRef.current = [];
              if (!batch.length) return;
              setItems((prev) => {
                /**
                 * 云信聊天室可能重复推送（重连补发）→ 按 id 去重。
                 *
                 * ⚠️ 只对**有 id** 的条目去重：以前是 `new Set(prev.map(i => i.id))`，
                 * 若某些弹幕解析不出 id（id 为空/undefined），它们会全部撞上同一个 `undefined` 键
                 * → 首条之后就**再也上不了屏** —— 用户反馈的「看一会就没有弹幕了」的一种形态。
                 * 宁可偶尔重复显示，也不能静默丢掉弹幕。
                 */
                /**
                 * 去重键：有 id 用 id；**没有 id 用「昵称|文本」兜底**
                 *（用户 2026-09-30：「直播会出现弹幕重复出现」）。
                 * 上一版为了保证"不丢消息"对空 id 完全不去重 → 服务端重放/重复推送时
                 * 同一批会被反复并入列表，飘屏那边看到的就更明显（被重复飘出）。
                 * 代价：同一人短时间内刷完全相同的句子在列表里会合并成一条 —— 相比重复刷屏可接受。
                 */
                const keyOf = (item: BarrageItem) => String(item.id || `${item.nick || ''}|${item.text || ''}`);
                const seen = new Set(prev.map(keyOf));
                const fresh = batch.filter((item) => {
                  const k = keyOf(item);
                  return k ? !seen.has(k) : true;
                });
                if (!fresh.length) return prev;
                const next = fresh.concat(prev);
                return next.length > MAX_ITEMS ? next.slice(0, MAX_ITEMS) : next;
              });
            }, BARRAGE_FLUSH_MS);
          }
        },
        onStatus: (next, detail) => {
          if (cancelled || seqRef.current !== seq) return;
          setStatus(next);
          if (next === 'error' && detail) setError(detail);
          if (next === 'connected') {
            /**
             * 连上就重置退避与「最近有消息」计时：
             * 否则刚重连成功的通道会被看门狗（按旧的 lastMsgAt 判定）立刻再踢一次。
             */
            reconnectAttemptRef.current = 0;
            lastMsgAtRef.current = Date.now();
          } else if (next === 'closed' || next === 'error') {
            // 断开 / 报错 → 自动重连（用户 2026-09-30：以前必须手动重新开关才有弹幕）
            scheduleReconnect();
          }
        },
      });
      chatroomRef.current = instance;
      instance.connect();
    })();

    return () => {
      cancelled = true;
      offOnline();
      // 清掉攒批定时器与缓冲：换直播间/退出后不该再有一次迟到的上屏
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      pendingRef.current = [];
      // 清掉待执行的重连：否则退出直播间后还会被"重连"再拉起来一次
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      const instance = chatroomRef.current;
      chatroomRef.current = null;
      instance?.dispose();
    };
  }, [liveId, enabled, module, retryToken, sessionEpoch]);

  /**
   * 看门狗：连接状态正常（connected）但长时间收不到弹幕 → 判定通道假死，主动重连一次。
   *
   * 覆盖用户反馈的「看一会就没有弹幕了」最常见的形态：SDK 既不报错、也不再推消息，
   * 状态还停在 connected —— 只靠状态驱动的重连（closed/error）救不回来。
   * 阈值 150s + 冷却 5 分钟：热门直播间 2 分半没有一条弹幕必然是异常；
   * 冷清直播间最多每 5 分钟被重连一次，代价可接受（重连期间旧弹幕保留、不断列表）。
   */
  useEffect(() => {
    if (!enabled || !liveId) return undefined;
    const timer = setInterval(() => {
      if (statusRef.current !== 'connected') return; // 断开/重连中交给状态驱动那条路径
      const now = Date.now();
      if (now - lastMsgAtRef.current < WATCHDOG_IDLE_MS) return;
      if (now - lastForcedReconnectRef.current < WATCHDOG_COOLDOWN_MS) return;
      lastForcedReconnectRef.current = now;
      lastMsgAtRef.current = now; // 重置计时，避免下一个 tick 又触发
      // eslint-disable-next-line no-console
      console.log('[nim] barrage watchdog → reconnect（已', Math.round(WATCHDOG_IDLE_MS / 1000), '秒没有弹幕）');
      setRetryToken((n) => n + 1);
    }, WATCHDOG_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled, liveId]);

  const send = useCallback(async (text: string) => {
    const instance = chatroomRef.current;
    if (!instance) throw new Error('弹幕通道尚未就绪');
    const content = String(text || '').trim();
    // 屏蔽词拦截：弹幕发出去会被服务端丢，不如本地先拦下（错误文案由 LiveBarrageBoard 显示）
    const masked = await checkMaskWords(content);
    if (masked.length) {
      throw new Error(t('包含屏蔽词：{words}', { words: masked.join('、') }));
    }
    await instance.send(content);
    // 乐观上屏：立刻显示自己的弹幕（不等服务端回投）
    const self = await loadSelfProfile().catch(() => null);
    /**
     * 发送**必须**用原始短码（官方协议里表情就是 `[流泪]` 这样的文本，
     * 换成 emoji 发出去其它端显示不出来）；本地展示则用替换后的文本，
     * 与服务端回投（经 codec 归一化）保持一致 —— 否则去重比对会对不上。
     */
    const shown = replaceEmojiText(content);
    lastLocalRef.current = { nick: self?.nickName || '', text: shown, ts: Date.now(), consumed: false };
    setItems((prev) => [
      {
        id: `local-${Date.now()}`,
        kind: 'text' as const,
        messageType: 'BARRAGE_NORMAL',
        text: shown,
        nick: self?.nickName || '',
        avatar: self?.avatar || '',
        userId: self?.userId || 0,
        roleId: 0,
        level: self?.level ?? 0,
        time: Date.now(),
      },
      ...prev,
    ].slice(0, MAX_ITEMS));
  }, []);

  /**
   * 送礼公屏广播 + 本地乐观上屏。
   *
   * 用户反馈（2026-09-29）：「我送礼物，主播看不到我送的」——
   * HTTP 送礼接口只负责扣款/入账，直播间里的礼物公屏是客户端发的
   * （官方客户端同款 PRESENT_NORMAL）。不发 → 主播和所有观众都看不到这条礼物。
   *
   * 乐观上屏条目 kind='gift' 且带 gift → 礼物特效层立刻播放；服务端回投同一条时
   * 按「昵称+文案」去重（复用 send 那套 lastLocalRef，只吞第一条）。
   */
  const sendGift = useCallback(async (gift: LiveGiftBroadcast) => {
    const instance = chatroomRef.current;
    if (!instance) throw new Error('弹幕通道尚未就绪');
    await instance.sendGift(gift);
    const self = await loadSelfProfile().catch(() => null);
    const num = Number(gift.giftNum) || 1;
    const text = `${self?.nickName || ''} 送给 ${gift.toName || ''} ${num}个${gift.giftName}`.trim();
    lastLocalRef.current = { nick: self?.nickName || '', text, ts: Date.now(), consumed: false };
    setItems((prev) => [
      {
        id: `local-gift-${Date.now()}`,
        kind: 'gift' as const,
        messageType: 'PRESENT_NORMAL',
        text,
        nick: self?.nickName || '',
        avatar: self?.avatar || '',
        userId: self?.userId || 0,
        roleId: 0,
        level: self?.level ?? 0,
        time: Date.now(),
        gift: {
          giftId: Number(gift.giftId) || 0,
          giftName: gift.giftName,
          giftNum: num,
          tpNum: 0,
          toName: gift.toName || '',
          picPath: gift.giftPic || '',
        },
      },
      ...prev,
    ].slice(0, MAX_ITEMS));
  }, []);

  return {
    items,
    status,
    error,
    ready: status === 'connected',
    online,
    send,
    sendGift,
    clear,
    retry,
  };
}

export default useLiveBarrage;
