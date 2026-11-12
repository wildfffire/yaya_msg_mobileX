/**
 * 弹幕 overlay —— 在回放 WebView / 原生播放器之上叠加滚动弹幕。
 * 哔哩哔哩风格：
 *   - 多泳道 + 每条「占位到上一条完全离屏 + 安全间隔」才复用泳道，彻底杜绝重叠
 *   - 同屏同刻多条时按泳道最早空闲者排队，未轮到的延迟入场（不会挤在一起）
 *   - 颜色统一白色（弹幕更干净，也避免花花绿绿看不清）
 *   - 设置（不透明度 / 速度 / 显示区域 / 字号 / 总开关）来自 useDanmakuSettings，记忆持久化
 *   - 纯 RN Animated 实现，零额外依赖
 * 性能：单条弹幕抽成 memo 子组件——新弹幕入池只挂载新组件，
 *       旧弹幕（anim/位置均未变）被 memo 拦截不重渲染，避免整屏 4Hz 全量 reconcile 卡顿。
 */
import React, { memo, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, useWindowDimensions } from 'react-native';
import { DanmakuItem } from '../utils/danmaku';
import { replaceEmojiText } from '../utils/emoji';
import { useDanmakuSettings } from '../store/danmakuSettings';
import { useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import { isLandscapeSize } from '../utils/orientation';
import { usePlayerStore } from '../player/store/playerStore';
import { logInfo } from '../utils/runtimeLog';

const BASE_DURATION = 7000; // 基础横穿时长（ms），speed 越大越快
const SAFE_GAP = 600; // 同泳道两条之间的安全间隔（ms），杜绝重叠
// 向前跳转超过此阈值（ms）即视为「拖动/快进」，清空当前屏而不补发历史弹幕，
// 避免「拖一下蹦出一大片之前的弹幕」影响观感。
const SEEK_FORWARD_MS = 1500;
// 同屏弹幕上限：Android 上过密会拖慢合成，40 条足够覆盖主流密度
const MAX_ACTIVE = 40;
/**
 * 「没有消息 id」的直播弹幕去重窗口（ms）。
 *
 * 去重是**双通道**的，别再改回单一集合（两次真实事故各对应一边）：
 *   · **有 id**：用**永久集合**（消息 id 唯一）——
 *     曾经改成 60s 时间窗 → 同一批消息 60s 后被判成新消息重新上屏（用户 2026-09-30：
 *     「直播会出现弹幕重复出现」）；
 *   · **没 id**：用**内容 + 短时间窗**（同一条消息的重放/重复推送要挡住，
 *     但同一个人过一会儿再刷同一句话应当照常飘出）——
 *     曾经用 `i.key &&` 直接把无 id 的条目丢掉 → 列表有、飘屏没有；
 *     后来改成不挡 → 每 250ms 一批都会把它当成新消息重飘一次。
 */
const LIVE_CONTENT_DEDUP_MS = 10_000;
/**
 * 单条弹幕的最大排队延迟（ms）。
 * 泳道被占满时新弹幕会按"最早空闲泳道"排队，弹幕量大或长时间卡顿后 laneFreeAt 会被推到很远的未来，
 * 弹幕于是被排到几十秒之后 —— 看起来就是"不出现"。超过这个上限直接重置泳道表。
 */
const MAX_LANE_DELAY_MS = 2500;

interface ActiveDanmaku {
  key: string;
  text: string;
  lane: number;
  anim: Animated.Value;
  /** 点击进资料卡用（用户 2026-11-12）：直播飘屏带发送者身份，LRC 无 */
  userId?: string;
  nick?: string;
  avatar?: string;
}

/** 单条弹幕：memo 后仅在自身入池/出池时渲染，不被父级 4Hz spawn 连带重渲染 */
const Bullet = memo(function Bullet({
  text,
  top,
  fontSize: fs,
  anim,
  width: w,
  onPress,
}: {
  text: string;
  top: number;
  fontSize: number;
  anim: Animated.Value;
  width: number;
  onPress?: () => void;
}) {
  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [w, -w * 0.72] });
  return (
    <Animated.View style={[styles.bullet, { top, transform: [{ translateX }] }]}>
      <Pressable
        disabled={!onPress}
        onPress={onPress}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={{ fontSize: fs, color: '#ffffff', fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.95)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 3 }}>
          {/* 最后一道防线（用户反馈 2026-09-29：飘屏上仍有 `[示爱]` 这类短码没变成表情）：
              上游各条链路（LRC / 云信 / barrage.list / 房间飘屏）都应替换过，但来源一旦新增
              就会漏 —— 在这里再收一次口，任何来源的 `[xx]` 都能显示成表情。
              替换幂等（emoji 不含方括号），重复调用无副作用。 */}
          {replaceEmojiText(text)}
        </Text>
      </Pressable>
    </Animated.View>
  );
});

export interface DanmakuOverlayProps {
  danmaku: DanmakuItem[];
  /**
   * 播放进度（秒）。**不传则组件自行订阅 `playerStore.position`**。
   *
   * 为什么要支持"不传"：position 是 4Hz 高频字段（progressUpdateInterval=250ms），
   * 若由父级订阅再透传，会把 4Hz 重渲染扩散到整个页面（MediaScreen 2575 行、
   * FollowedRoomsScreen 5184 行）——实测是项目最大的重渲染放大器。
   * 把订阅下沉到本组件后，父级只在真实状态变化时才重渲染。
   */
  currentTime?: number;
  visible: boolean;
  /** 直播模式：实时弹幕立即上屏，不做子秒级错峰（录播才按发送时刻错峰） */
  live?: boolean;
  opacity?: number;
  /**
   * 实时弹幕（直播专用）：外部推来的弹幕，出现即上屏，不走 currentTime 时间窗。
   * 与 danmaku（录播按时间轴）互不影响；直播时传这个、danmaku 传空数组即可。
   * key 必须稳定（同一条消息重复推不会重复上屏）。
   */
  liveItems?: Array<{ key: string; text: string; userId?: string; nick?: string; avatar?: string }>;
  /**
   * 点击飘屏条目（用户 2026-11-12）：
   * 直播飘屏带发送者 userId/avatar，点了直接开用户资料卡；LRC（回放）没有身份 → 不触发。
   * 不传时飘屏层保持 pointerEvents: none（完全不挡播放器手势）。
   */
  onPressItem?: (item: { key: string; text: string; userId?: string; nick?: string; avatar?: string }) => void;
}

export function DanmakuOverlay({ danmaku, currentTime, visible, live = false, opacity: opacityProp, liveItems, onPressItem }: DanmakuOverlayProps) {
  // 弹幕时钟：外部显式传入优先（如直播恒传 0）；否则自行订阅播放器进度（见 props 注释）
  const storeTime = usePlayerStore((s) => s.position);
  const clock = currentTime !== undefined ? currentTime : storeTime;
  const { enabled, opacity: sOpacity, speed, area, fontSize, avoidOverlap } = useDanmakuSettings();
  const [active, setActive] = useState<ActiveDanmaku[]>([]);
  const lastTime = useRef(0);
  const laneFreeAt = useRef<number[]>([]);
  const counter = useRef(0);
  const { width, height: screenH } = useWindowDimensions();
  // 顶部安全区：edge-to-edge 下 overlay 顶到屏幕最上沿，弹幕会压进系统通知栏。
  // 第一条泳道从「状态栏下方 + 8」开始，泳道数也按可用高度重算。
  const insets = useSafeAreaInsets();
  const isLandscape = isLandscapeSize(width, screenH);
  /**
   * 横屏：状态栏仍在顶部（沉浸全屏时状态栏已隐藏，多留 24 也无害且能避开顶栏按钮），
   * 所以这里保留 `insets.top` 而不是按 8 顶格 —— 顶格会让第一泳道与顶栏控件糊在一起。
   */
  const topOffset = (insets?.top || 0) + 8;
  /** 横屏：底部控制坞（播放/进度/功能组）约占 72dp，泳道不要铺到它后面去 */
  const bottomReserve = isLandscape ? 64 : 0;

  // 显示区域 → 泳道数（顶部少、全屏多）
  const rowH = fontSize + 10;
  const usableH = Math.max(rowH, screenH - topOffset - bottomReserve);
  let laneCount = Math.max(isLandscape ? 4 : 8, Math.floor((usableH * 0.92) / rowH));
  if (area === 'top') laneCount = Math.max(4, Math.min(6, Math.floor((usableH * 0.4) / rowH)));
  else if (area === 'half') laneCount = Math.max(6, Math.floor((usableH * 0.55) / rowH));
  // 区域 / 字号变化时同步泳道数组长度
  useEffect(() => {
    if (laneFreeAt.current.length !== laneCount) laneFreeAt.current = new Array(laneCount).fill(0);
  }, [laneCount]);

  useEffect(() => {
    if (!visible || !enabled || !danmaku.length) {
      lastTime.current = clock;
      // 失效时清空残留弹幕：先 stop 动画（防隐藏后 native driver 动画仍在跑）
      setActive((prev) => {
        if (prev.length) prev.forEach((a) => { try { a.anim.stopAnimation(); } catch {} });
        return [];
      });
      laneFreeAt.current = laneFreeAt.current.map(() => 0);
      return;
    }
    const from = lastTime.current;
    const to = clock;
    lastTime.current = to;
    // 拖拽回退：不补发
    if (to <= from) return;
    const deltaMs = (to - from) * 1000;
    // 大步快进 / 拖动：清空当前屏弹幕，不补发历史，避免「拖一下蹦出一大片之前的弹幕」
    if (deltaMs > SEEK_FORWARD_MS) {
      setActive([]);
      return;
    }

    const spawned = danmaku.filter((d) => d.time > from && d.time <= to);
    if (!spawned.length) return;

    const duration = BASE_DURATION / (speed > 0 ? speed : 1);

    const newOnes: ActiveDanmaku[] = spawned.map((d) => {
      // 选「最早空闲」的泳道（min freeAt），保证不重叠；关掉防重叠时按轮转直接入场
      let lane = 0;
      if (avoidOverlap) {
        for (let i = 1; i < laneCount; i++) {
          if (laneFreeAt.current[i] < laneFreeAt.current[lane]) lane = i;
        }
      } else {
        lane = counter.current % laneCount;
      }
      // 1) 泳道空闲延迟：上一条还没离屏则延后入场（防重叠关闭时不等待）
      const laneDelay = avoidOverlap ? Math.max(0, (laneFreeAt.current[lane] - to) * 1000) : 0;
      // 2) 子秒级错峰（仅录播）：按「本条真实发送时刻 - 窗口起点」错峰入场，
      //    解决「同一秒左右发的弹幕被强制同时飘屏」——让它们按真实时刻依次出现。
      const entryDelay = live ? 0 : Math.max(0, (d.time - from) * 1000);
      const startDelay = Math.max(laneDelay, entryDelay);
      // 预留：本条完全离屏 + 安全间隔 后才释放泳道
      laneFreeAt.current[lane] = to + (startDelay + duration + (avoidOverlap ? SAFE_GAP : 0)) / 1000;

      const anim = new Animated.Value(0);
      Animated.sequence([
        Animated.delay(startDelay),
        Animated.timing(anim, { toValue: 1, duration, easing: (t) => t, useNativeDriver: true }),
      ]).start(() => {
        setActive((prev) => prev.filter((a) => a.anim !== anim));
      });
      return {
        key: `d${counter.current++}`,
        text: d.text,
        lane,
        anim,
      };
    });
    setActive((prev) => [...prev, ...newOnes].slice(-MAX_ACTIVE));
  }, [clock, visible, enabled, danmaku, laneCount, speed, live, avoidOverlap]);

  /**
   * 直播实时弹幕：新到的消息立即上屏（不走时间窗）。泳道复用逻辑与录播一致，保证同屏不重叠。
   *
   * ⚠️ 直播**不做暂停抑制**（用户 2026-09-30：「弹幕列表能看到，为什么不出现在屏幕上」）。
   * 之前这里有 `if (playerStore.state === 'paused') return;`：只要 state 被误判或卡在 paused
   *（直播重连、内核切换、双击暂停后没恢复），弹幕列表照样在涨、飘屏却一条都不出 ——
   * 与用户描述完全一致。对直播来说「列表能看到就必须飘出来」远比「暂停时避免两套时间」重要，
   * 所以取消该抑制（顺带少订阅一个高频 store 字段）。
   */
  /** 有 id 的弹幕：**永久**去重（id 唯一，永久集合不会漏也不会重） */
  const seenLiveIdsRef = useRef<Set<string>>(new Set());
  /** 没有 id 的弹幕：内容 → 最近上屏时间（短窗去重，见 LIVE_CONTENT_DEDUP_MS） */
  const seenContentRef = useRef<Map<string, number>>(new Map());
  /** 上一次"全被判已见"诊断日志的时间（节流 60s） */
  const skippedLogAtRef = useRef(0);
  useEffect(() => {
    if (!visible || !enabled || !liveItems || !liveItems.length) return;
    const nowMs = Date.now();
    const seenIds = seenLiveIdsRef.current;
    const seenContent = seenContentRef.current;
    const idOf = (i: { key: string; text: string }) => String(i.key || '');
    const contentOf = (i: { key: string; text: string }) => String(i.text || '');
    /** 无 id 的内容键：文本本身（昵称已含在 text 里：`${nick}：${text}`） */
    const fresh = liveItems.filter((i) => {
      const id = idOf(i);
      if (id) return !seenIds.has(id);
      const content = contentOf(i);
      if (!content) return true; // 连内容都没有：不在这里挡
      const t = seenContent.get(content);
      return !(t && nowMs - t < LIVE_CONTENT_DEDUP_MS);
    });
    if (!fresh.length) {
      // 诊断：整批都被判"已见"时记一条（60s 节流），便于事后区分是去重挡的还是根本没数据
      if (nowMs - skippedLogAtRef.current > 60_000) {
        skippedLogAtRef.current = nowMs;
        logInfo(`[danmaku] live 上屏跳过：${liveItems.length} 条全在去重集合内`, 'player');
      }
      return;
    }
    for (const i of fresh) {
      const id = idOf(i);
      if (id) seenIds.add(id);
      else {
        const content = contentOf(i);
        if (content) seenContent.set(content, nowMs);
      }
    }
    // 上界（防止挂一整天后无限增长）：id 集过大时按当前列表重建；内容表清过期项
    if (seenIds.size > 4000) {
      seenIds.clear();
      for (const i of liveItems) { const id = idOf(i); if (id) seenIds.add(id); }
    }
    if (seenContent.size > 1500) {
      for (const [k, t] of seenContent) if (nowMs - t > LIVE_CONTENT_DEDUP_MS) seenContent.delete(k);
      if (seenContent.size > 1500) seenContent.clear();
    }

    const duration = BASE_DURATION / (speed > 0 ? speed : 1);
    const now = Date.now() / 1000;
    /**
     * 泳道积压保护：若最早空闲泳道也要等超过 MAX_LANE_DELAY_MS，说明队列已积压失控
     *（弹幕量过大 / 之前长时间卡顿把 laneFreeAt 推到很远的未来）→ 重置泳道表；
     * 不重置的话新弹幕会被排到几十秒之后，看起来就是"弹幕不出现"。
     */
    let earliest = Infinity;
    for (let i = 0; i < laneCount; i++) earliest = Math.min(earliest, laneFreeAt.current[i] || 0);
    if (!Number.isFinite(earliest) || earliest > now + MAX_LANE_DELAY_MS / 1000) {
      laneFreeAt.current = [];
    }
    const newOnes: ActiveDanmaku[] = fresh.map((d) => {
      let lane = 0;
      if (avoidOverlap) {
        for (let i = 1; i < laneCount; i++) {
          if ((laneFreeAt.current[i] || 0) < (laneFreeAt.current[lane] || 0)) lane = i;
        }
      } else {
        lane = counter.current % laneCount;
      }
      const laneDelay = avoidOverlap
        ? Math.min(MAX_LANE_DELAY_MS, Math.max(0, ((laneFreeAt.current[lane] || 0) - now) * 1000))
        : 0;
      laneFreeAt.current[lane] = now + (laneDelay + duration + (avoidOverlap ? SAFE_GAP : 0)) / 1000;

      const anim = new Animated.Value(0);
      Animated.sequence([
        Animated.delay(laneDelay),
        Animated.timing(anim, { toValue: 1, duration, easing: (t) => t, useNativeDriver: true }),
      ]).start(() => {
        setActive((prev) => prev.filter((a) => a.anim !== anim));
      });
      return {
        key: `L${counter.current++}`,
        text: d.text,
        lane,
        anim,
        // 点击进资料卡需要发送者身份（直播有，LRC 无）
        userId: d.userId,
        nick: d.nick,
        avatar: d.avatar,
      };
    });
    setActive((prev) => [...prev, ...newOnes].slice(-MAX_ACTIVE));
  }, [liveItems, visible, enabled, laneCount, speed, avoidOverlap]);

  if (!visible || !enabled) return null;
  const opacity = opacityProp ?? sOpacity;

  /**
   * 可点飘屏（用户 2026-11-12）：只有传了 onPressItem 才松开触摸，
   * 否则保持 pointerEvents:none（完全不影响播放器手势）。
   * box-none = 容器自身不吃触摸，只有子弹条目能点。
   */
  const interactive = !!onPressItem;
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { opacity, zIndex: 30 }]}
      pointerEvents={interactive ? 'box-none' : 'none'}
    >
      {active.map((a) => (
        <Bullet
          key={a.key}
          text={a.text}
          top={topOffset + a.lane * (fontSize + 10)}
          fontSize={fontSize}
          anim={a.anim}
          width={width}
          onPress={interactive && a.userId ? () => onPressItem?.({
            key: a.key,
            text: a.text,
            userId: a.userId,
            nick: a.nick,
            avatar: a.avatar,
          }) : undefined}
        />
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  /** 子弹容器（文字样式在 Bullet 内联：字号随设置变化，阴影固定） */
  bullet: {
    position: 'absolute',
    left: 0,
    paddingHorizontal: 6,
  },
});
