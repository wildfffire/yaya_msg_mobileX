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
import { buildPocketHeaders } from '../resolve/streamResolver';
import { DanmakuOverlay } from '../../components/DanmakuOverlay';
import { GiftEffectOverlay } from '../../components/GiftEffectOverlay';
import { RadioPhotoCarousel, type RadioPhotoCarouselHandle } from '../../components/RadioPhotoCarousel';
import DanmakuListSheet, { type DanmakuListEntry } from '../../components/DanmakuListSheet';
import DanmakuSettingsSheet from '../../components/DanmakuSettingsSheet';
import { LiveBarrageBoard } from '../../components/LiveBarrageBoard';
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
   * 顶栏标题点击进成员房间（用户 2026-11-04：直播 / 历史 / 稍后再看都要能进）。
   * 房间内播放传 false —— 已经在房间里，再跳一次会重复打开。
   */
  roomLink?: boolean;
  /** 成员 id 覆盖：页面已从成员库反查到更可靠的 id（如直播页的 playingMember）时传 */
  roomMemberId?: string;
}

/** 宿主对外的命令式接口（场景需要时用：如房间送礼的云信公屏广播） */
export interface MediaPlaybackHostHandle {
  /** 发送礼物公屏广播（送礼成功后调用；无云信连接时静默忽略） */
  sendGiftBroadcast: (gift: LiveGiftBroadcast) => void;
  /** 当前解析结果快照（未就绪时 null） */
  getResolved: () => ResolvedMedia | null;
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
  danmakuLivePollMs = 0,
  danmakuVodNotice = false,
  onOpenDanmakuProfile,
  resumeNotice = false,
  initialPosition = 0,
  miniPlayerBackTo,
  showMiniPlayer = true,
  hideSheets = false,
  onVideoSize,
  modal = false,
  announcement = false,
  roomLink = true,
  roomMemberId,
}: MediaPlaybackHostProps, ref) {
  const { t } = useI18n();
  const palette = usePalette();
  const session = usePlaybackSession({ media, onResolved });
  const { resolved, status, error } = session;
  const isLive = !!resolved?.isLive;

  /**
   * 官方「本场累计观看人次」（不是实时在线，见 usePlaybackOnlineStat 文件头实测记录）：
   * 直播 30s 轮询 / 回放取一次定值 + 成员回放反查兜底。
   */
  const accumulatedViews = usePlaybackOnlineStat({
    isLive,
    liveId: String(resolved?.liveId || ''),
    url: resolved?.url,
    title: resolved?.title,
    memberId: media?.memberId,
  });

  /** 续播（统一存储 replayProgress） */
  const resumeAt = usePlaybackResume({ resolved, initialPosition, notice: resumeNotice });

  /** 弹幕（云信 + LRC + 可选 HTTP 轮询） */
  const danmaku = usePlaybackDanmaku({ resolved, livePollMs: danmakuLivePollMs, vodNotice: danmakuVodNotice });

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
    if (!roomLink || !roomOpenMemberId) return undefined;
    return () => {
      try { onCloseRef.current?.(); } catch { /* 关播放器失败不阻塞进房 */ }
      setTimeout(() => {
        try {
          navigation.navigate('Main', { screen: 'Rooms', params: { openMemberId: roomOpenMemberId } });
        } catch { /* 导航失败时播放器已关闭，用户仍可手动进房间 */ }
      }, 0);
    };
  }, [roomLink, roomOpenMemberId, navigation]);

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
    enabled: announcement,
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

  /** 控制坞按钮 = 场景按钮 + 通用（弹幕设置 / 弹幕列表 / 小窗）—— 与旧直播页/房间顺序一致 */
  const mergedActions = useMemo<PlaybackAction[]>(() => {
    const sceneActions = typeof extraActions === 'function'
      ? extraActions({ isLive, resolved })
      : (extraActions || []);
    const list: PlaybackAction[] = [...sceneActions];
    list.push({ key: 'danmaku', icon: 'cog', label: t('弹幕设置'), onPress: () => setShowDanmakuSettings(true) });
    list.push({ key: 'danmakuList', icon: 'format-list-bulleted', label: t('弹幕列表'), active: showDanmakuList, onPress: () => setShowDanmakuList((v) => !v) });
    if (showMiniPlayer) {
      list.push({ key: 'pip', icon: 'picture-in-picture-bottom-right-outline', label: t('小窗'), onPress: openMiniPlayer });
    }
    return list;
  }, [extraActions, isLive, resolved, showDanmakuList, showMiniPlayer, openMiniPlayer, t]);

  /** 弹幕飘屏数据：直播=云信即时条目（+可选 HTTP 轮询时间轴）；回放=LRC 时间轴 */
  const overlayDanmaku = isLive ? danmaku.pollItems : danmaku.vodItems;
  const overlayLiveItems = isLive && danmaku.liveItems.length ? danmaku.liveItems : undefined;
  /** 飘屏可见（房间与直播页统一口径：只看持久化总开关；回放无弹幕时不挂） */
  const danmakuVisible = danmakuOn && (isLive || danmaku.vodItems.length > 0);

  /** 命令式接口（房间送礼「云信公屏广播」等需要宿主内部连接的能力） */
  const resolvedRef = useRef<ResolvedMedia | null>(null);
  resolvedRef.current = resolved;
  const barrageRef = useRef(danmaku.barrage);
  barrageRef.current = danmaku.barrage;
  useImperativeHandle(ref, () => ({
    sendGiftBroadcast: (gift: LiveGiftBroadcast) => {
      try {
        barrageRef.current?.sendGift?.(gift)?.catch?.(() => undefined);
      } catch { /* 公屏失败不影响送礼结果 */ }
    },
    getResolved: () => resolvedRef.current,
  }), []);

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
    announcement && (announce.hasAnnouncement || isLive)
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
  ), [announcement, announce.hasAnnouncement, announce.expanded, announce.toggle, announce.refresh, isLive, t]);

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
      {announcement && announce.expanded && !hideSheets ? (
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
          resume: !resolved.isLive,
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
