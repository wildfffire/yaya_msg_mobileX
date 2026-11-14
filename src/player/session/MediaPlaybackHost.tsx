/**
 * MediaPlaybackHost · 统一播放宿主（四场景唯一入口，用户 2026-10-02）
 *
 * 覆盖场景：主直播页（MediaScreen）/ 房间内（FollowedRoomsScreen）/
 *           历史记录（HistoryScreen）/ 稍后再看（WatchLaterScreen）。
 * 不覆盖：B 站直播（BilibiliLiveScreen，内核/弹幕源/画质体系独立，保持现状）。
 *
 * 页面只需要：
 *   <MediaPlaybackHost
 *     media={要播的东西}
 *     onClose={关闭与导航}
 *     extraActions={场景按钮}               // 可选
 *     beforePlayer / afterPlayer={场景浮层} // 可选（公告面板 / 礼物 Modal …）
 *     onResolved={解析完成回调}             // 可选
 *   />
 *
 * 宿主内部统一完成（这些以前在三个页面各写一份）：
 *   · 解析（快速起播 + 多层兜底 + 代次守卫 + 失败重试）
 *   · 解析中 / 解析失败 shell（黑底 + 重试 / 返回）
 *   · 人数胶囊（用户 2026-11-01 口径）：直播=云信聊天室实时在线 →「N 人在线」；
 *     拿不到实时 / 回放=官方累计观看人次 →「累计 N 人看过」（累计不等于在线，见 usePlaybackOnlineStat）
 *   · 续播读取与进度落盘（replayProgress 统一存储）
 *   · 弹幕：云信飘屏 + LRC 时间轴 + 弹幕列表 / 设置面板 / 直播输入条 / 礼物特效
 *   · 小窗交棒（重新解析新签名流 + 位置/宽高透传 + backTo）
 *   · PlayerScreen 的 source/meta/danmaku/features 组装
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useNavigation } from '@react-navigation/native';
import { useI18n } from '../../i18n';
import { usePalette, withAlpha } from '../../theme';
import { usePlayerStore } from '../store/playerStore';
import { PlayerScreen } from '../PlayerScreen';
import type { PlayerFeatures } from '../types';
import { buildPocketHeaders } from '../../utils/mediaHeaders';
import { DanmakuOverlay } from '../../components/DanmakuOverlay';
import { GiftEffectOverlay } from '../../components/GiftEffectOverlay';
import { RadioPhotoCarousel, type RadioPhotoCarouselHandle } from '../../components/RadioPhotoCarousel';
import DanmakuListSheet, { type DanmakuListEntry } from '../../components/DanmakuListSheet';
import DanmakuSettingsSheet from '../../components/DanmakuSettingsSheet';
import { LiveBarrageBoard } from '../../components/LiveBarrageBoard';
// 播放周边抽屉（礼物 / 贡献榜）：四场景共用同一份 UI
import { LiveGiftSheet } from '../../components/LiveGiftSheet';
import { LiveRankSheet } from '../../components/LiveRankSheet';
import { useDanmakuSettings } from '../../store/danmakuSettings';
import { useMiniPlayerStore } from '../../store/miniPlayerStore';
import type { LiveGiftBroadcast } from '../../services/pocketNim/types';
import { replaceEmojiText } from '../../utils/emoji';
import { isLandscapeSize } from '../../utils/orientation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { resolveMedia } from './resolveMedia';
import { usePlaybackSession } from './usePlaybackSession';
import { usePlaybackOnlineStat } from './usePlaybackOnlineStat';
import { usePlaybackResume } from './usePlaybackResume';
import { usePlaybackDanmaku } from './usePlaybackDanmaku';
import { usePlaybackAnnouncement } from './usePlaybackAnnouncement';
import { usePlaybackCarousel } from './usePlaybackCarousel';
import { usePlaybackGift } from './usePlaybackGift';
import type { PlaybackAction, PlaybackTopAction, PlayMedia, ResolvedMedia } from './types';

/** extraActions 函数形式拿到的会话上下文 */
export interface PlaybackActionContext {
  /** 当前是否直播（解析前按调用方预判） */
  isLive: boolean;
  /** 解析结果（未就绪时 null） */
  resolved: ResolvedMedia | null;
}

export interface MediaPlaybackHostProps {
  /** 要播的条目；null = 不渲染 */
  media: PlayMedia | null;
  /** 关闭（页面负责导航与收尾：退房清理 / watchFrom 回跳 / 沉浸复位…） */
  onClose: () => void;
  /** 解析完成回调（公告等场景逻辑用） */
  onResolved?: (resolved: ResolvedMedia) => void;
  /**
   * 场景附加控制坞按钮（通用按钮由宿主追加在其后）。
   *
   * 支持函数形式：按钮可能需要「解析后才确定的直播/回放状态」
   * （典型：房间的礼物按钮只在直播显示），宿主把当前会话上下文传进来。
   */
  extraActions?: PlaybackAction[] | ((ctx: PlaybackActionContext) => PlaybackAction[]);
  /**
   * 直播间公告能力（用户 2026-10-02：主直播页之外，**房间 / 历史 / 稍后再看也要能看到公告**）。
   *
   * 开启后宿主自动完成：拉取（直播与录播都拉，getLiveOne → getOpenLiveOne 兜底）、
   * 面板渲染（含控制条联动位移、刷新/收起）、顶栏与控制坞按钮、展开态持久化。
   *
   * ⚠️ 2026-11-12 用户澄清：「只把播放器功能（…面板）里的公告入口去掉，公告能力不要拆」。
   * 所以顶栏按钮、公告面板、拉取与持久化全部保留；控制坞那一条不再追加（见 mergedActions）。
   */
  announcement?: boolean;
  /** 顶栏左上按钮（announcement 开启时由宿主接管） */
  topLeftAction?: PlaybackTopAction;
  /** PlayerScreen 之前的场景浮层（公告面板等，位于宿主容器内） */
  beforePlayer?: ReactNode;
  /** PlayerScreen 之后的场景浮层（礼物 / 贡献榜 Modal 等） */
  afterPlayer?: ReactNode;
  /** 额外 children（渲染进 PlayerScreen 内，与弹幕层同层） */
  children?: ReactNode;
  /** features 覆盖（默认：rate=非直播 / danmaku / kernelSwitch / resume=非直播） */
  features?: PlayerFeatures;
  /** 宿主容器样式（默认 flex:1 黑底；房间/主直播页可传绝对定位样式） */
  style?: StyleProp<ViewStyle>;
  /** 直播 HTTP 轮询间隔（主直播页传 5000 保持历史行为；房间不传） */
  danmakuLivePollMs?: number;
  /** 回放弹幕到达 toast（主直播页现状） */
  danmakuVodNotice?: boolean;
  /** 弹幕列表点发送者 → 资料卡 */
  onOpenDanmakuProfile?: (entry: DanmakuListEntry) => void;
  /** 续播成功 toast（房间现状；主直播页静默） */
  resumeNotice?: boolean;
  /** 小窗回大窗 / 路由带入的续播位置（秒） */
  initialPosition?: number;
  /** 小窗交棒 backTo 的附加字段（房间带 roomMemberId） */
  miniPlayerBackTo?: Record<string, any>;
  /** 是否提供小窗按钮（默认 true） */
  showMiniPlayer?: boolean;
  /** 隐藏弹幕列表/设置面板（系统 PiP 拍快照时用，主直播页） */
  hideSheets?: boolean;
  /** 视频尺寸回调 */
  onVideoSize?: (w: number, h: number) => void;
  /** modal 模式：整页 Modal 覆盖（历史 / 稍后再看就地播放，硬件返回键自动关闭） */
  modal?: boolean;
  /**
   * 场景预设（用户 2026-11-13「四场景统一调用直播页的入口」）。
   *
   * 只提供**默认值**，页面显式传的同名 prop 优先（undefined 才用场景默认）：
   *   · live  —— 主直播页：公告开、直播弹幕 HTTP 轮询 5s、回放弹幕到达提示
   *   · watch —— 历史 / 稍后再看 /「我的」横滑卡：与 live 同口径（页面自己加 modal）
   *   · room  —— 房间内直播与回放：公告开、续播提示、不显示「进房间」（已在房间里）
   *
   * 页面因此只需声明「播什么 + 哪个场景」，能力清单不再各页抄一遍。
   */
  scene?: PlaybackScene;
  /**
   * 顶栏标题点击进成员房间（用户 2026-11-04：直播 / 历史 / 稍后再看都要能进）。
   * 房间内播放传 false —— 已经在房间里，再跳一次会重复打开。
   */
  roomLink?: boolean;
  /** 成员 id 覆盖：页面已从成员库反查到更可靠的 id（如直播页的 playingMember）时传 */
  roomMemberId?: string;
  /**
   * 直播送礼 —— 播放周边能力全部内置宿主（用户 2026-11-13：
   * 「四个场景的播放功能以后改一次全生效」）。
   * 传主播 userId 即启用「礼物」按钮；空值不显示（回放 / 拿不到主播 id）。
   */
  giftTargetUserId?: string;
  /** 主播昵称（礼物公屏广播展示用） */
  giftTargetName?: string;
  /**
   * 贡献榜用的 liveId 覆盖（房间：`roomLiveId()`，含「未起播但成员正在直播」的索引兜底）。
   * 不传则用解析结果的 liveId。
   */
  rankLiveId?: string;
  /** 贡献榜点某行 → 资料卡（页面决定弹哪一种卡；不传则不可点） */
  onOpenUserProfile?: (target: { userId?: string; name: string; avatar?: string }) => void;
  /**
   * 是否显示「贡献榜」按钮（默认：直播 / 回放 / 传了 rankLiveId 时显示）。
   * 公演（openlive）等没有贡献榜数据源的场景显式传 false。
   */
  showRank?: boolean;
}

/** 宿主场景预设（见 MediaPlaybackHostProps.scene） */
export type PlaybackScene = 'live' | 'room' | 'watch';

/** 宿主对外的命令式接口（场景需要时用：如房间工具栏的礼物入口） */
export interface MediaPlaybackHostHandle {
  /** 发送礼物公屏广播（送礼成功后调用；无云信连接时静默忽略） */
  sendGiftBroadcast: (gift: LiveGiftBroadcast) => void;
  /** 当前解析结果快照（未就绪时 null） */
  getResolved: () => ResolvedMedia | null;
  /** 打开送礼面板（房间工具栏在播放中时用；未起播由页面自己的面板接管） */
  openGift: () => void;
  /** 打开贡献榜 */
  openRank: () => void;
}

export const MediaPlaybackHost = forwardRef<MediaPlaybackHostHandle, MediaPlaybackHostProps>(function MediaPlaybackHost({
  media,
  onClose,
  onResolved,
  extraActions = [],
  topLeftAction,
  beforePlayer,
  afterPlayer,
  children,
  features,
  style,
  danmakuLivePollMs,
  danmakuVodNotice,
  onOpenDanmakuProfile,
  resumeNotice,
  initialPosition = 0,
  miniPlayerBackTo,
  showMiniPlayer = true,
  hideSheets = false,
  onVideoSize,
  modal = false,
  announcement,
  roomLink,
  roomMemberId,
  scene,
  giftTargetUserId,
  giftTargetName,
  rankLiveId,
  onOpenUserProfile,
  showRank,
}: MediaPlaybackHostProps, ref) {
  const { t } = useI18n();
  const palette = usePalette();
  const session = usePlaybackSession({ media, onResolved });
  /**
   * 场景预设 → 实际能力开关（显式 prop 优先，undefined 才取场景默认）。
   * 四场景的差异只剩这些默认值，页面不再各写一份宿主配置。
   */
  const sceneDefaults = useMemo(() => ({
    /** 公告：三个场景都开（用户 2026-10-02 明确「房间和观看历史里也要能看到」） */
    announcement: scene !== undefined,
    /** 直播弹幕 HTTP 轮询：主直播页 / 历史 / 稍后再看 5s（房间走云信，不轮询） */
    danmakuLivePollMs: scene === 'live' || scene === 'watch' ? 5000 : 0,
    /** 回放弹幕到达 toast：主直播页与 watch 场景保留 */
    danmakuVodNotice: scene === 'live' || scene === 'watch',
    /** 续播提示：只有房间需要（其它场景静默续播） */
    resumeNotice: scene === 'room',
    /** 标题/成员名进房间：房间内点自己会重复进房 → 关闭 */
    roomLink: scene !== 'room',
  }), [scene]);
  const announceEnabled = announcement ?? sceneDefaults.announcement;
  const danmakuPollMs = danmakuLivePollMs ?? sceneDefaults.danmakuLivePollMs;
  const danmakuVodToast = danmakuVodNotice ?? sceneDefaults.danmakuVodNotice;
  const resumeToast = resumeNotice ?? sceneDefaults.resumeNotice;
  const allowRoomLink = roomLink ?? sceneDefaults.roomLink;
  const { resolved, status, error } = session;
  const isLive = !!resolved?.isLive;

  /**
   * 官方「本场累计观看人次」（不是实时在线，见 usePlaybackOnlineStat 文件头实测记录）：
   * 直播 30s 轮询 / 回放取一次定值 + 成员回放反查兜底。
   */
  /** 官方视频库（kind=video）的 id 不是 liveId：不要拿去查直播详情（否则每次开视频白打一次失败请求） */
  const statLiveId = media?.kind === 'video' ? '' : String(resolved?.liveId || '');
  const accumulatedViews = usePlaybackOnlineStat({
    isLive,
    liveId: statLiveId,
    url: media?.kind === 'video' ? undefined : resolved?.url,
    title: resolved?.title,
    memberId: media?.memberId,
  });

  /** 续播（统一存储 replayProgress） */
  const resumeAt = usePlaybackResume({ resolved, initialPosition, notice: resumeToast });

  /** 弹幕能力：视频库/公演传 `{ danmaku:false }` 时**不建连接、不轮询、不拉 LRC** */
  const danmakuCapable = features?.danmaku !== false;
  /** 弹幕（云信 + LRC + 可选 HTTP 轮询） */
  const danmaku = usePlaybackDanmaku({
    resolved,
    livePollMs: danmakuPollMs,
    vodNotice: danmakuVodToast,
    enabled: danmakuCapable,
  });
  /**
   * 云信连接引用（送礼公屏广播 / 房间工具栏礼物入口共用）。
   * 放在这里是因为送礼 hook 要用它发广播，而 useImperativeHandle 也要用它。
   */
  const barrageRef = useRef(danmaku.barrage);
  barrageRef.current = danmaku.barrage;

  /* ── 播放周边能力：礼物 / 贡献榜（用户 2026-11-13：全部内置宿主）─────────
     以前这两个面板和它们的数据逻辑分散在 MediaScreen / FollowedRoomsScreen，
     改一处另一处不生效（「房间点头像进的直播，贡献榜还是没有直播页修好的样子」）。
     现在：数据逻辑 = usePlaybackGift / utils/liveRank，UI = LiveGiftSheet / LiveRankSheet，
     入口 = 宿主控制坞按钮 + 下面的两个抽屉，页面只传「主播 id / 资料卡回调」。 */
  const [giftVisible, setGiftVisible] = useState(false);
  const [rankVisible, setRankVisible] = useState(false);
  const gift = usePlaybackGift({
    liveId: String(resolved?.liveId || media?.liveId || ''),
    targetUserId: String(giftTargetUserId || ''),
    targetName: giftTargetName,
    // 广播走宿主内同一条云信连接；没有连接时 sendGift 内部静默忽略
    broadcast: (g) => {
      try {
        barrageRef.current?.sendGift?.(g)?.catch?.(() => undefined);
      } catch { /* 公屏失败不影响送礼结果 */ }
    },
  });
  /** gift.load 的 ref 镜像：让命令式接口保持稳定引用 */
  const giftLoadRef = useRef(gift.load);
  giftLoadRef.current = gift.load;
  /** 打开送礼面板（控制坞按钮 / 房间工具栏共用同一条路径） */
  const openGift = useCallback(() => {
    setGiftVisible(true);
    void giftLoadRef.current();
  }, []);
  /** 打开贡献榜（与直播页同一个面板组件） */
  const openRank = useCallback(() => setRankVisible(true), []);
  /** 贡献榜 liveId：房间可显式给（含「未起播但成员在播」的索引兜底），其它场景用解析结果 */
  const rankId = String(rankLiveId || resolved?.liveId || media?.liveId || '');

  /**
   * 电台直播（`liveType = 2`）：官方推流画面只有「成员离开」占位图，
   * 官方客户端用 `getLiveOne → content.carousels` 的成员照片轮播填充画面。
   * 列表项已知类型时（media.radio）首帧就走轮播形态；否则解析完成/详情到达后切换。
   */
  const carousel = usePlaybackCarousel({
    isLive,
    liveId: String(resolved?.liveId || media?.liveId || ''),
    // 解析层也可能判出电台（列表项缺 liveType / 详情里才有）—— 不能只看 media.radio
    hintRadio: !!media?.radio || !!resolved?.radio,
    photos: resolved?.carouselPhotos,
    intervalMs: resolved?.carouselIntervalMs,
  });
  /** 照片轮播的命令式接口：左右滑动由 PlayerScreen 的容器手势回调驱动 */
  const carouselRef = useRef<RadioPhotoCarouselHandle | null>(null);
  /**
   * 照片翻页手势 → 翻页器（跟手位移与惯性判定都在 PhotoPager 内，
   * 与房间图片查看器 ZoomImageModal 同一套规则）。
   */
  const swipeHandlers = useMemo(() => ({
    onStart: () => carouselRef.current?.beginDrag(),
    onMove: (dx: number) => carouselRef.current?.dragBy(dx),
    onEnd: (dx: number, vx: number) => carouselRef.current?.settle(dx, vx),
    onCancel: () => carouselRef.current?.cancelDrag(),
  }), []);

  /**
   * 右上角「队伍徽章 + 成员名」点击 → 进入该成员的房间（用户 2026-11-04 第二次调整：
   * 入口从**标题**挪到**成员名**，标题恢复纯文本、不再带房间图标）。
   *
   * 覆盖直播 / 历史 / 稍后再看（都走本宿主）：成员 id 优先用页面反查到的 `roomMemberId`，
   * 其次 `media.memberId`（房间）/ `media.ownerId`（官方条目 userInfo.userId，与成员库同域）。
   * 拿不到 id（如官方视频库条目）时只展示不可点。
   *
   * 顺序：先关播放器（历史/稍后再看是 Modal，不关会盖住房间），再切到房间 tab。
   */
  const navigation = useNavigation<any>();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const roomOpenMemberId = String(roomMemberId || media?.memberId || media?.ownerId || '');
  const memberAction = useMemo(() => {
    if (!allowRoomLink || !roomOpenMemberId) return undefined;
    return () => {
      try { onCloseRef.current?.(); } catch { /* 关播放器失败不阻塞进房 */ }
      setTimeout(() => {
        try {
          navigation.navigate('Main', { screen: 'Rooms', params: { openMemberId: roomOpenMemberId } });
        } catch { /* 导航失败时播放器已关闭，用户仍可手动进房间 */ }
      }, 0);
    };
  }, [allowRoomLink, roomOpenMemberId, navigation]);

  /**
   * 顶栏人数胶囊（用户 2026-11-01 定版口径）：
   *   · 直播：优先**云信聊天室实时在线**（`barrage.online`，原生连上即报 + 每 10s 一次）
   *     →「N 人在线」；聊天室还没连上（未登录 / 连接中 / 失败）时退回官方累计
   *     →「累计 N 人看过」—— 两者量纲不同，文案必须跟着换，绝不把累计标成「人在线」。
   *   · 回放：聊天室随直播结束关闭，只有官方累计（该场结束时的定值）→「累计 N 人看过」。
   */
  const onlineStat = useMemo<{ icon: string; text: string } | undefined>(() => {
    const chatroomOnline = isLive ? Number(danmaku.barrage.online) || 0 : 0;
    if (chatroomOnline > 0) {
      return { icon: 'account-multiple', text: t('{n} 人在线', { n: chatroomOnline }) };
    }
    if (accumulatedViews > 0) {
      return { icon: 'account-multiple', text: t('累计 {n} 人看过', { n: accumulatedViews }) };
    }
    return undefined;
  }, [isLive, danmaku.barrage.online, accumulatedViews, t]);
  const danmakuOn = useDanmakuSettings((s) => s.enabled);
  const giftEffectOn = useDanmakuSettings((s) => s.giftEffect);
  const [showDanmakuList, setShowDanmakuList] = useState(false);
  const [showDanmakuSettings, setShowDanmakuSettings] = useState(false);

  /** 直播间公告（直播与录播都拉；四场景同一份实现，见 usePlaybackAnnouncement） */
  const announce = usePlaybackAnnouncement({
    enabled: announceEnabled,
    liveId: String(resolved?.liveId || media?.liveId || ''),
  });

  /** 视频真实宽高（小窗交棒按比例适配） */
  const videoSizeRef = useRef<{ w: number; h: number } | null>(null);
  const handleVideoSize = useCallback((w: number, h: number) => {
    if (!(w > 0) || !(h > 0)) return;
    videoSizeRef.current = { w, h };
    onVideoSize?.(w, h);
  }, [onVideoSize]);

  /**
   * 小窗交棒（合并 MediaScreen / 房间两处实现）：
   * 直播交棒前**重新解析一条新签名流**（大窗内核关闭即销毁，复用旧 URL 小窗大概率黑屏）。
   */
  const openMiniPlayer = useCallback(async () => {
    const cur = resolved;
    if (!cur?.url) return;
    let url = cur.url;
    if (cur.isLive && cur.liveId) {
      try {
        const fresh = await resolveMedia({ kind: 'live', liveId: cur.liveId, title: cur.title, cover: cur.cover, isLive: true });
        if (fresh?.url) url = fresh.url;
      } catch { /* 解析失败退回原 URL（聊胜于无） */ }
    }
    let pos = 0;
    if (!cur.isLive) {
      try {
        const st = usePlayerStore.getState();
        if (st.source && st.source.url === cur.url && (st.state === 'playing' || st.state === 'paused')) {
          pos = Math.max(0, Number(st.position) || 0);
        }
      } catch { /* 忽略 */ }
    }
    useMiniPlayerStore.getState().open({
      url,
      title: cur.title,
      cover: cur.cover,
      isLive: !!cur.isLive,
      /**
       * 电台直播（liveType=2）必须按「纯音频胶囊」交棒：
       * 小窗没有轮播层，展示视频就是那张「成员离开」的占位画面（用户 2026-11-04 的问题）。
       */
      audioOnly: !!cur.audioOnly || carousel.radio,
      position: pos,
      aspectW: videoSizeRef.current?.w,
      aspectH: videoSizeRef.current?.h,
      backTo: {
        mode: cur.isLive ? 'live' : 'vod',
        playUrl: url,
        playTitle: cur.title,
        playCover: cur.cover,
        playPosition: pos,
        /**
         * 成员名 / 队伍 / 成员 id 一并交给小窗：小窗点开回大窗时走的是 MediaScreen 的
         * `playUrl` 直达分支（重建 PlayMedia），没有这三个字段右上角成员胶囊就空了
         *（用户 2026-11-08：「小窗回大窗丢成员名」）。
         */
        playOwner: media?.owner || '',
        playTeam: media?.team || '',
        playOwnerId: media?.ownerId || '',
        ...(miniPlayerBackTo || {}),
      },
    });
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, miniPlayerBackTo, onClose, carousel.radio]);

  /**
   * 控制坞按钮 = 场景追加 + **宿主内置**（礼物 / 贡献榜 / 弹幕设置 / 弹幕列表 / 小窗）。
   *
   * 礼物与贡献榜由宿主统一提供（用户 2026-11-13）：页面不再各自传 extraActions，
   * 四个场景（直播页 / 房间 / 历史 / 稍后再看）改一次就全生效。
   */
  const mergedActions = useMemo<PlaybackAction[]>(() => {
    const sceneActions = typeof extraActions === 'function'
      ? extraActions({ isLive, resolved })
      : (extraActions || []);
    const list: PlaybackAction[] = [...sceneActions];
    if (isLive && giftTargetUserId) {
      list.push({ key: 'gift', icon: 'gift', label: t('礼物'), onPress: openGift });
    }
    /**
     * 贡献榜：默认对「直播 / 回放」显示（房间可传 rankLiveId 兜底未起播的场景）；
     * 官方视频库（video）/ 公演（openlive）没有贡献榜数据源 —— 页面可传 showRank={false}。
     */
    const rankOn = showRank ?? (isLive || media?.kind === 'replay' || !!rankLiveId);
    if (rankOn) {
      list.push({ key: 'rank', icon: 'trophy', label: t('贡献榜'), onPress: openRank });
    }
    /** 弹幕能力由 features 决定：视频库/公演传 `{ danmaku:false }` 时不显示这两个入口 */
    if (danmakuCapable) {
      list.push({ key: 'danmaku', icon: 'cog', label: t('弹幕设置'), onPress: () => setShowDanmakuSettings(true) });
      list.push({ key: 'danmakuList', icon: 'format-list-bulleted', label: t('弹幕列表'), active: showDanmakuList, onPress: () => setShowDanmakuList((v) => !v) });
    }
    if (showMiniPlayer) {
      list.push({ key: 'pip', icon: 'picture-in-picture-bottom-right-outline', label: t('小窗'), onPress: openMiniPlayer });
    }
    return list;
  }, [extraActions, isLive, resolved, media?.kind, giftTargetUserId, rankLiveId, showRank, danmakuCapable, openGift, openRank, showDanmakuList, showMiniPlayer, openMiniPlayer, t]);

  /** 弹幕飘屏数据：直播=云信即时条目（+可选 HTTP 轮询时间轴）；回放=LRC 时间轴 */
  const overlayDanmaku = isLive ? danmaku.pollItems : danmaku.vodItems;
  const overlayLiveItems = isLive && danmaku.liveItems.length ? danmaku.liveItems : undefined;
  /** 飘屏可见（房间与直播页统一口径：只看持久化总开关；回放无弹幕时不挂） */
  const danmakuVisible = danmakuOn && (isLive || danmaku.vodItems.length > 0);

  /** 命令式接口（房间工具栏礼物入口 / 公屏广播等需要宿主内部状态的能力） */
  const resolvedRef = useRef<ResolvedMedia | null>(null);
  resolvedRef.current = resolved;
  useImperativeHandle(ref, () => ({
    sendGiftBroadcast: (g: LiveGiftBroadcast) => {
      try {
        barrageRef.current?.sendGift?.(g)?.catch?.(() => undefined);
      } catch { /* 公屏失败不影响送礼结果 */ }
    },
    getResolved: () => resolvedRef.current,
    openGift,
    openRank,
  }), [openGift, openRank]);

  /* ── 直播间公告（可选能力，四场景共用）────────────────────────────────
     用户 2026-10-02：「房间和观看历史里还是没有（公告）」——
     公告本来就是播放器周边能力，收进宿主后主直播页 / 房间 / 历史 / 稍后再看
     由同一个开关（announcement）打开，面板样式与位移逻辑也只剩一份。
     hook 调用必须在 mergedActions 之前（那里要读它构造控制坞按钮）。
     ⚠️ 2026-11-12：控制坞里的公告入口按用户要求去掉，顶栏按钮与面板保留。 */
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const isLandscape = isLandscapeSize(screen.width, screen.height);
  const controlsVisible = usePlayerStore((s) => s.controlsVisible);
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  /** 与 PlayerChrome 顶栏同一套公式（见 src/player/chrome/PlayerChrome.tsx 的 topPad） */
  const announceTopPad = isLandscape ? (fullscreen ? 8 : insets.top + 6) : insets.top + 6;
  /** 顶栏盒底 = paddingTop + 按钮 40 + 6 余量 */
  const ANNOUNCE_TOP_WITH_BAR = announceTopPad + 46;
  /**
   * 控制条隐藏时的目标位置：只比 WITH_BAR 高一点点，**不回到屏幕最上沿** ——
   * 玩家一点屏幕顶栏就回来了，若面板此刻在最上沿，180ms 动画期间必然与「…」重叠。
   */
  const ANNOUNCE_TOP_NO_BAR = Math.max(announceTopPad + 6, insets.top + 10);
  const announceTopAnim = useRef(new Animated.Value(96)).current;
  useEffect(() => {
    Animated.timing(announceTopAnim, {
      toValue: controlsVisible ? ANNOUNCE_TOP_WITH_BAR : ANNOUNCE_TOP_NO_BAR,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [controlsVisible, ANNOUNCE_TOP_WITH_BAR, ANNOUNCE_TOP_NO_BAR, announceTopAnim]);

  /**
   * 公告按钮（顶栏左上，唯一入口；控制坞那条已按用户要求删除）：
   * 有公告 → 展开/收起；无公告但直播 → 点一次拉取。
   */
  const announceTopAction = useMemo<PlaybackTopAction | undefined>(() => (
    announceEnabled && (announce.hasAnnouncement || isLive)
      ? {
        icon: 'bullhorn',
        label: t('公告'),
        active: announce.expanded,
        onPress: () => {
          if (announce.hasAnnouncement) announce.toggle();
          else void announce.refresh();
        },
      }
      : undefined
  ), [announceEnabled, announce.hasAnnouncement, announce.expanded, announce.toggle, announce.refresh, isLive, t]);

  const handleRetry = useCallback(() => { session.retry(); }, [session]);

  const shell = (
    <View style={styles.shell}>
      {status === 'error' ? (
        <>
          <Text style={styles.shellText}>{error || t('解析失败，请重试')}</Text>
          <View style={styles.shellBtns}>
            <TouchableOpacity style={[styles.shellBtn, { backgroundColor: palette.tint }]} activeOpacity={0.85} onPress={handleRetry}>
              <Text style={styles.shellBtnText}>{t('重试')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.shellBtnGhost} activeOpacity={0.85} onPress={onClose}>
              <Text style={styles.shellBtnGhostText}>{t('返回')}</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text style={styles.shellText}>{t('正在解析播放地址…')}</Text>
          <TouchableOpacity style={styles.shellBtnGhost} activeOpacity={0.85} onPress={onClose}>
            <Text style={styles.shellBtnGhostText}>{t('取消')}</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );

  const body = !media ? null : (status !== 'ready' || !resolved) ? shell : (
    <>
      {/* 内置公告面板（announcement 开启时）：系统 PiP 快照会拍进浮层 → hideSheets 时隐藏 */}
      {announceEnabled && announce.expanded && !hideSheets ? (
        <Animated.View
          style={[
            styles.announcePanel,
            // 横屏：挖孔/导航条在侧边，面板不能还贴 10px 边（会压到圆角/挖孔）
            isLandscape ? { left: Math.max(10, insets.left), right: Math.max(10, insets.right) } : null,
            // 公告强调色统一跟随主题色（面板仍是深色半透明底，正文白字不动）
            { borderColor: withAlpha(palette.tint, 0.32), transform: [{ translateY: announceTopAnim }] },
          ]}
        >
          <View style={[styles.announcePanelTop, { borderBottomColor: withAlpha(palette.tint, 0.18) }]}>
            {/* ⚠️ 标题组必须 flex:1 + minWidth:0，否则内层 title 的 flex:1 失效
                （它撑的是这个 wrapper，而 wrapper 默认按内容宽）→ wrapper 撑满整行，
                把右侧「刷新/收起」两个按钮顶出屏幕（用户截图：收起按钮跑到屏幕外）。 */}
            <View style={styles.announcePanelTitleRow}>
              <MaterialCommunityIcons name="bullhorn" size={15} color={palette.tint} style={{ marginRight: 5 }} />
              <Text style={styles.announcePanelTitle} numberOfLines={1}>{t('公告')}</Text>
            </View>
            <View style={styles.announcePanelBtns}>
              <TouchableOpacity onPress={() => { void announce.refresh(); }} style={[styles.announceSmallBtn, { backgroundColor: palette.tintSoft }]}>
                <Text style={[styles.announceSmallBtnText, { color: palette.tint }]}>{t('刷新')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => announce.setExpanded(false)} style={[styles.announceSmallBtn, { backgroundColor: palette.tintSoft }]}>
                <Text style={[styles.announceSmallBtnText, { color: palette.tint }]}>{t('收起')}</Text>
              </TouchableOpacity>
            </View>
          </View>
          <ScrollView style={styles.announcePanelBody}>
            {/* 公告正文也过表情替换：官方公告里同样会出现 `[示爱]` 这类短码 */}
            <Text style={styles.announcePanelText}>{replaceEmojiText(announce.text)}</Text>
          </ScrollView>
        </Animated.View>
      ) : null}
      {beforePlayer}
      <PlayerScreen
        source={{
          kind: resolved.isLive ? 'live' : 'vod',
          url: resolved.url,
          urls: resolved.urls,
          liveId: resolved.liveId,
          ref: resolved.ref,
          needsNativeExo: resolved.needsExo,
          audioOnly: resolved.audioOnly,
          // 统一防盗链头（与房间/公演/历史同源）
          headers: resolved.headers || buildPocketHeaders(),
        }}
        meta={{
          title: resolved.title,
          cover: resolved.cover,
          owner: media?.owner,
          team: media?.team,
          ownerId: media?.ownerId,
          // 人数胶囊：直播=聊天室实时在线（拿不到则累计）；回放=累计观看人次
          stat: onlineStat,
        }}
        danmaku={resolved.isLive
          ? { type: 'poll', liveId: resolved.liveId }
          : { type: 'lrc', lrcUrl: '' }}
        features={{
          kernelSwitch: true,
          danmaku: true,
          rate: !resolved.isLive,
          ...(features || {}),
        }}
        resumeAt={resumeAt}
        extraActions={mergedActions}
        /* 公告按钮走宿主内置（顶栏唯一入口；控制坞入口已按用户要求删除） */
        topLeftAction={announceTopAction || topLeftAction}
        barrageInput={resolved.isLive ? (
          <LiveBarrageBoard
            source={danmaku.barrage}
            liveId={danmaku.liveId}
            module="live"
            variant="plain"
            inputOnly
          />
        ) : undefined}
        onClose={onClose}
        onRetry={handleRetry}
        onVideoSize={handleVideoSize}
        /* 电台照片轮播：左右滑动翻页（普通直播/录播不传 → 不挂手势，进度条拖动不受影响） */
        swipeHandlers={carousel.radio && carousel.photos.length > 1 ? swipeHandlers : undefined}
        /* 点成员名进房间（直播 / 历史 / 稍后再看统一；房间内播放器由页面关掉） */
        memberAction={memberAction}
      >
        {/* 电台直播（liveType=2）：照片轮播盖住「成员离开」的推流占位画面。
            层级：视频 → 照片轮播 → 页面 children → 弹幕/礼物（控制层在 PlayerChrome）。 */}
        {carousel.radio ? (
          <RadioPhotoCarousel
            ref={carouselRef}
            photos={carousel.photos}
            intervalMs={carousel.intervalMs}
            fallback={resolved.cover}
          />
        ) : null}
        {children}
        <DanmakuOverlay
          /* key 绑定这一场：换台强制重挂载，重置去重窗口与泳道占用表（跨场次残留修复） */
          key={resolved.liveId || resolved.url || 'danmaku'}
          danmaku={overlayDanmaku}
          visible={danmakuVisible}
          live={resolved.isLive}
          liveItems={overlayLiveItems}
          /* 点飘屏 → 同一个用户资料卡（用户 2026-11-12）；LRC 无 userId 时不触发 */
          onPressItem={onOpenDanmakuProfile ? (item) => onOpenDanmakuProfile({
            id: item.key,
            time: 0,
            nick: item.nick || '',
            text: item.text,
            userId: item.userId,
            avatar: item.avatar,
          }) : undefined}
        />
        {/* 礼物特效层：与弹幕同一条云信连接 */}
        <GiftEffectOverlay items={danmaku.barrage.items} enabled={giftEffectOn} />
        <DanmakuListSheet
          visible={showDanmakuList && !hideSheets}
          onClose={() => setShowDanmakuList(false)}
          entries={resolved.isLive ? danmaku.liveEntries : danmaku.vodEntries}
          onSeek={resolved.isLive ? undefined : (sec) => usePlayerStore.getState().setSeekTarget(sec)}
          live={!!resolved.isLive}
          loading={resolved.isLive
            ? (danmaku.barrage.status === 'connecting' || danmaku.barrage.status === 'resolving')
            : false}
          onOpenProfile={onOpenDanmakuProfile}
        />
        <DanmakuSettingsSheet visible={showDanmakuSettings} onClose={() => setShowDanmakuSettings(false)} />
      </PlayerScreen>
      {/* 播放周边抽屉（控制坞「礼物 / 贡献榜」打开）：四场景同一份 UI 与数据逻辑 */}
      <LiveGiftSheet
        visible={giftVisible && !hideSheets}
        onClose={() => setGiftVisible(false)}
        gifts={gift.gifts}
        balance={gift.balance}
        status={gift.status}
        selected={gift.selected}
        num={gift.num}
        onChangeNum={gift.setNum}
        onSelect={gift.select}
        onSend={() => { void gift.send(); }}
        onRecharge={() => {
          setGiftVisible(false);
          try { navigation.navigate('RechargeScreen'); } catch { /* 导航失败时面板已关闭 */ }
        }}
      />
      <LiveRankSheet
        visible={rankVisible && !hideSheets}
        liveId={rankId}
        onClose={() => setRankVisible(false)}
        missingLiveIdHint={t('当前直播缺少 liveId，不能获取贡献榜')}
        onOpenProfile={onOpenUserProfile}
      />
      {afterPlayer}
    </>
  );

  if (!media) return null;
  if (modal) {
    return (
      <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
        <View style={[styles.host, style]}>{body}</View>
      </Modal>
    );
  }
  return <View style={[styles.host, style]}>{body}</View>;
});

const styles = StyleSheet.create({
  host: { flex: 1, backgroundColor: '#000' },
  shell: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 24, backgroundColor: '#000' },
  shellText: { color: '#FFFFFF', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  shellBtns: { flexDirection: 'row', gap: 12 },
  shellBtn: { paddingHorizontal: 26, paddingVertical: 10, borderRadius: 10, backgroundColor: '#ff6f91' },
  shellBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  shellBtnGhost: { paddingHorizontal: 26, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.55)' },
  shellBtnGhostText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  /* ── 公告面板（从 MediaScreen 原样迁入；四个场景共用这一份样式） ── */
  // zIndex 必须**高于**播放器控制层（PlayerChrome 顶栏 30 / 底坞 31）：
  // 它已经被 translateY 抬到顶栏下方，这里再高一层保证「刷新/收起」永远点得到
  //（历史 bug：zIndex 29 < 30 → 「收起」被「…」压住且触摸被顶栏抢走）。
  // 描边 / 分隔线 / 小按钮色一律由内联 palette.tint 提供，这里不再写死品牌粉
  announcePanel: { position: 'absolute', top: 0, left: 10, right: 10, zIndex: 45, borderRadius: 16, backgroundColor: 'rgba(18,18,20,0.92)', borderWidth: 1, marginHorizontal: 0, overflow: 'hidden' },
  announcePanelTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  /** 标题组：占据剩余宽度并允许收缩（配合 title 的 numberOfLines=1 出省略号），按钮永远留在屏内 */
  announcePanelTitleRow: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0, marginRight: 8 },
  announcePanelTitle: { color: '#fff', fontSize: 13, fontWeight: '800', flexShrink: 1 },
  /** 按钮组：不参与收缩，保证「刷新/收起」始终完整可见 */
  announcePanelBtns: { flexDirection: 'row', gap: 8, flexShrink: 0 },
  announceSmallBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14 },
  announceSmallBtnText: { fontSize: 11, fontWeight: '700' },
  announcePanelBody: { paddingHorizontal: 14, paddingVertical: 10, maxHeight: 150 },
  announcePanelText: { color: '#f2f2f2', fontSize: 12.5, lineHeight: 21 },
});

export default MediaPlaybackHost;
