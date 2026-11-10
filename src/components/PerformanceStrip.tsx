/**
 * PerformanceStrip ·「即将开演」横向公演卡条
 *
 * 公演记录页与首页「公演直播」区块**共用**（用户要求两处同源同行为）：
 *   - 数据由调用方传（fetchUpcomingPerformances：即将 + 进行中的剧场公演，时间正序）
 *   - 60s 心跳：到点把时间徽标从「13:15」自动翻成「直播中」
 *   - 点击：未开演 → toast「还未开演」；已开演 → **B站优先**：该团 B站官方直播间正在播就进 B站，
 *     没在播才回退**应用内信号**（口袋公演直播 getOpenLiveOne → rtmp）
 *     （团名 → roomId 用 externalApi 的 B站配置，内部有 5 分钟缓存；
 *      开播状态用 services/biliLiveStatus 判定，带 TTL 缓存避开 B站风控）
 *
 * 样式可定制：`style` 控制外层（首页用负 margin 抵消 sectionOuter 内边距实现贴边横滑），
 * `contentContainerStyle` 控制滚动内容（首页补 paddingLeft），`cardWidth` 控制卡片宽。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { ScalePressable } from './Motion';
import { NetworkImage } from './NetworkImage';
import { textOnColor } from './TeamBadge';
import { useNavigation } from '@react-navigation/native';
import { useI18n } from '../i18n';
import { usePalette } from '../theme';
import { useUiStore } from '../store';
import { useAppStatePoll } from '../hooks/useAppStatePoll';
import { externalApi } from '../api/external';
import { isGroupBiliLive, prefetchGroupBiliLive } from '../services/biliLiveStatus';
import {
  describeShowTime,
  formatShowWhen,
  PERFORMANCE_FALLBACK_COLOR,
  type PerformanceShow,
} from '../services/performanceSchedule';

/** 该场公演是否已开演（过了开演时间）。配合 60s 心跳重渲染 → 到点这张卡就变成「直播中」且可点进 B站直播 */
function isShowStarted(show: PerformanceShow): boolean {
  return !!show.startTime && Date.now() >= show.startTime;
}

interface Props {
  shows: PerformanceShow[];
  /** 不传则用默认行为（未开演 toast / 已开演：B站优先，没播才走应用内信号） */
  onPressShow?: (show: PerformanceShow) => void;
  /**
   * 接管「该团 B站没开播时」的应用内信号播放（口袋公演直播）。
   *
   * 返回 `false` = 没接住（拿不到 liveId），组件会提示「未找到该团的直播间」；
   * 返回其它值（含 undefined）= 已接管，组件不再做任何跳转。
   *
   * 典型用法：公演记录页就地起播（本页有播放器），首页不传 → 跳直播页播。
   */
  onPlayLive?: (show: PerformanceShow) => boolean | void;
  /** 标题行文案，默认「即将开演」 */
  title?: string;
  /** 是否渲染标题行（首页嵌在「公演直播」区块里时不需要，传 false） */
  showHead?: boolean;
  /** 标题行是否显示「共 N 场」（公演记录页显示，首页不显示） */
  showCount?: boolean;
  /** 卡片宽度，默认 156 */
  cardWidth?: number;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

export default function PerformanceStrip({
  shows,
  onPressShow,
  onPlayLive,
  title,
  showHead = true,
  showCount = false,
  cardWidth = 156,
  style,
  contentContainerStyle,
}: Props) {
  const palette = usePalette();
  const { t } = useI18n();
  const showToast = useUiStore((state) => state.showToast);
  const navigation = useNavigation<any>();

  /**
   * 各团 B站直播间：group 名（SNH48/GNZ48/BEJ48/CKG48/CGT48/TSH48）→ roomId。
   * 用途：已开演的公演点一下直接进对应团的 B站直播间。
   */
  const [biliGroupRooms, setBiliGroupRooms] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    externalApi.fetchBilibiliConfig()
      .then((rooms) => {
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const room of rooms) {
          const name = String(room.name || '').trim().toUpperCase();
          if (name && room.roomId) map[name] = String(room.roomId);
        }
        setBiliGroupRooms(map);
        // 预热各团 B站开播状态：点击时零等待（失败静默，点击时还会再查一次）
        prefetchGroupBiliLive(Object.values(map));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  /**
   * 60s 心跳：`isShowStarted()` 读的是 `Date.now()`。没有心跳的话，公演到点了这张卡也不会
   * 从「13:15」自动变成「直播中」，点了还以为没反应（要等下一次排期刷新才重渲染）。
   */
  const [, setClockTick] = useState(0);
  // 60s 心跳：仅用于"到点翻转徽标"，切后台无意义 → 用 AppState 感知的轮询（后台暂停、回前台补齐）
  useAppStatePoll(() => setClockTick((n) => n + 1), 60000);

  /**
   * 点公演卡（用户 2026-10-04 定口径：**B站优先，没有才走应用内信号**）：
   *   未开演 → 提示「还未开演」
   *   已开演 → ① 该团 B站官方直播间**正在开播** → 进 B站（官方同播，线路更稳）
   *            ② B站没在播 → 应用内信号（口袋公演直播）：父级传了 onPlayLive 就交给父级
   *               （公演记录页就地起播），没传则跳直播页播放
   *            ③ 两边都没有 → 提示「未找到该团的直播间」
   */
  const openShowLive = useCallback(async (show: PerformanceShow) => {
    if (!isShowStarted(show)) {
      showToast(t('还未开演'));
      return;
    }
    const group = String(show.group || '').trim().toUpperCase();
    const roomId = biliGroupRooms[group];
    // ① B站优先：room_init 的 live_status===1 才算在播（结果带 TTL 缓存，未命中时最多等一次请求）
    if (roomId && (await isGroupBiliLive(roomId))) {
      navigation.navigate('BilibiliLiveScreen', { roomId, roomName: show.group || t('B站直播') });
      return;
    }
    // ② 应用内信号：Seine 的 openLiveInfo.status=2 = 口袋侧公演正在直播（getOpenLiveOne 能给 rtmp）。
    // liveId 就是排期的 businessId（精度由 exactBigInts 保住）。
    if (Number(show.status) === 2 && show.liveId) {
      if (onPlayLive) {
        if (onPlayLive(show) !== false) return;
      } else {
        navigation.navigate('Media', {
          mode: 'live',
          playLiveId: show.liveId,
          playTitle: show.title,
          playCover: show.cover,
          playNonce: Date.now(),
          // 从首页看公演直播：退出播放要回首页（用户 2026-10-04）
          playFrom: 'Home',
        });
        return;
      }
    }
    // ③ B站没播、口袋侧也没流
    showToast(t('未找到该团的直播间'));
  }, [biliGroupRooms, navigation, onPlayLive, showToast, t]);

  if (!shows.length) return null;

  return (
    <View style={style}>
      {showHead ? (
        <View style={styles.perfHead}>
          <MaterialCommunityIcons name="calendar-star" size={15} color={palette.tint} />
          <Text style={[styles.perfHeadTitle, { color: palette.label }]}>{title || t('即将开演')}</Text>
          {showCount ? (
            <Text style={[styles.perfHeadCount, { color: palette.labelTertiary }]}>
              {t('共 {count} 场', { count: shows.length })}
            </Text>
          ) : null}
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.perfRow, contentContainerStyle]}
      >
        {shows.map((show) => {
          const ended = (Number(show.status) || 0) === 4;
          /**
           * 公演时间胶囊配色（用户 2026-11-09）：
           * · 有队伍 → 队伍应援色（保持原样）
           * · 没有队伍显示（parseTeamLogo 兜底、show.color 是写死粉）→ 改用当前主题色，
           *   文字色由 textOnColor 按底色亮度自动挑黑/白，换主题色时跟着变
           * · 已结束 → 中性灰
           */
          const whenBg = ended
            ? palette.labelTertiary
            : (!show.teamLabel || show.color === PERFORMANCE_FALLBACK_COLOR ? palette.tint : show.color);
          const whenFg = textOnColor(String(whenBg));
          const teamColor = show.color === PERFORMANCE_FALLBACK_COLOR ? palette.tint : show.color;
          return (
          /* 已结束 → 只提示；已开演 → 进该团 B站直播间；未开演 → 提示还未开演 */
          <ScalePressable
            key={show.id}
            activeOpacity={0.85}
            pressedScale={0.97}
            onPress={() => {
              if (ended) {
                showToast(t('该场已结束'));
                return;
              }
              if (onPressShow) onPressShow(show);
              else openShowLive(show);
            }}
            style={[styles.perfCard, { width: cardWidth, backgroundColor: palette.surfaceGlassStrong, borderColor: palette.hairline }]}
          >
            <View style={styles.perfCoverWrap}>
              {show.cover ? (
                <NetworkImage source={{ uri: show.cover }} style={styles.perfCover} resizeMode="cover" thumbnail={240} />
              ) : (
                <View style={[styles.perfCover, styles.perfCoverFallback, { backgroundColor: palette.tintSoft }]}>
                  <MaterialCommunityIcons name="theater" size={22} color={palette.tint} />
                </View>
              )}
              <View style={[styles.perfWhenBadge, { backgroundColor: whenBg }]}>
                <Text
                  style={[styles.perfWhenText, { color: whenFg }]}
                  numberOfLines={1}
                >
                  {ended
                    ? formatShowWhen(describeShowTime(show.startTime), t)
                    : isShowStarted(show)
                      ? t('直播中')
                      : formatShowWhen(describeShowTime(show.startTime), t)}
                </Text>
              </View>
            </View>
            <Text style={[styles.perfTitle, { color: palette.label }]} numberOfLines={2}>{show.title}</Text>
            {show.teamLabel ? (
              <View style={styles.perfTeamRow}>
                <View style={[styles.perfTeamBar, { backgroundColor: teamColor }]} />
                <Text style={[styles.perfTeam, { color: palette.labelSecondary }]} numberOfLines={1}>{show.teamLabel}</Text>
              </View>
            ) : null}
          </ScalePressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  perfHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  perfHeadTitle: { fontSize: 14, fontWeight: '800' },
  perfHeadCount: { fontSize: 11, fontWeight: '700' },
  perfRow: { gap: 10, paddingVertical: 2, paddingRight: 4 },
  perfCard: { borderRadius: 18, padding: 8, borderWidth: StyleSheet.hairlineWidth },
  perfCoverWrap: { borderRadius: 14, overflow: 'hidden' },
  perfCover: { width: '100%', height: 88 },
  perfCoverFallback: { alignItems: 'center', justifyContent: 'center' },
  perfWhenBadge: { position: 'absolute', left: 6, top: 6, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999 },
  // 文字色由内联 whenFg 决定（textOnColor 按底色亮度自动黑/白），此处不再写死白
  perfWhenText: { fontSize: 11, fontWeight: '800' },
  perfTitle: { fontSize: 13, fontWeight: '700', lineHeight: 18, marginTop: 8 },
  perfTeamRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  perfTeamBar: { width: 3, height: 11, borderRadius: 2 },
  perfTeam: { fontSize: 11, flex: 1 },
});
