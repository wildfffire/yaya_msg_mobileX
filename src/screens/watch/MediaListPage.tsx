/**
 * 「历史 / 稍后再看」共用的网格列表页（用户 2026-09-30；2026-10-02 改为就地播放）。
 *
 * 展示（用户明确要求）：回放名字 + 队伍徽章 + 成员名称 + 时间 + 类型（视频 / 电台）。
 * 布局：**横屏一行 3~4 个，竖屏 2 个** —— 列数按屏幕宽度算，不写死
 *（同样的 16:10 屏，手机横屏 ~800dp、平板会更宽）。
 *
 * 点击条目**就地全屏播放**（用户 2026-10-02：「以后只调用同一个播放器」）：
 * 不再跳直播页，直接把条目交给统一播放宿主（MediaPlaybackHost，modal 模式）——
 * 解析/续播/弹幕/在线人数/小窗全部由宿主完成，退出回到本列表页。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import NetworkImage from '../../components/NetworkImage';
import ScreenHeader from '../../components/ScreenHeader';
import { HeaderAction } from '../../components/HeaderAction';
import { EmptyState } from '../../components/StateViews';
import TeamBadge from '../../components/TeamBadge';
import { useI18n } from '../../i18n';
import { usePalette } from '../../theme';
import { useMemberStore } from '../../store';
import { buildMemberLookup } from '../../utils/memberMatch';
import { resolveWatchMeta } from '../../utils/watchMeta';
import { formatDuration } from '../../utils/format';
import { MediaPlaybackHost } from '../../player/session';
import type { PlayMedia } from '../../player/session';
import type { WatchLaterKind } from '../../services/watchLater';

export interface MediaListEntry {
  /** 唯一键（删除用） */
  key: string;
  title: string;
  cover?: string;
  /** 类型标签（视频 / 电台 / 回放 / 公演回放） */
  label: string;
  /** 次要信息：时间（历史里还会带「看过 N 次」） */
  meta?: string;
  /** 成员昵称 / 队伍（列表卡片展示队伍徽章与成员名） */
  owner?: string;
  team?: string;
  /** 成员数字 id：播完写回历史/稍后再看时保住「按 id 反查队伍」的依据 */
  ownerId?: string;
  /** 时长（秒）：封面右下角显示（与直播页录播卡片一致） */
  duration?: number;
  /** 官方类型码（1 直播 / 2 电台 / 5 游戏 / 6 AI）：用于把 audio 布尔说不清的形态标成「电台」 */
  liveType?: number;
  /** 播放解析用 */
  refKind?: WatchLaterKind;
  refId?: string;
  liveId?: string;
  kind?: string;
}

/**
 * 类型标签：先看形态（电台/音频优先，用户要求能区分「视频 / 电台」），
 * 再看来源（同是 vod，官方视频库与公演回放链路不同），最后退回播放器 source.kind。
 */
export function mediaKindLabel(
  refKind: WatchLaterKind | undefined,
  kind: string | undefined,
  audio: boolean | undefined,
  // 用宽松签名：i18n 的 t 各版本参数类型不同，这里只关心「key → 文案」
  t: (key: string, vars?: any) => string,
): string {
  if (audio || kind === 'audio') return t('电台');
  if (refKind === 'video') return t('视频');
  if (refKind === 'openlive') return t('公演回放');
  if (refKind === 'replay') return t('回放');
  if (kind === 'live') return t('直播');
  if (kind === 'vod') return t('录播');
  return t('视频');
}

export function MediaListPage({
  title,
  entries,
  emptyTitle,
  emptyHint,
  statsText,
  onRemove,
  onClear,
  clearLabel,
}: {
  title: string;
  entries: MediaListEntry[];
  emptyTitle: string;
  emptyHint?: string;
  statsText?: string;
  onRemove: (key: string) => void;
  onClear?: () => void;
  clearLabel?: string;
}) {
  const { t } = useI18n();
  const palette = usePalette();
  const { width } = useWindowDimensions();
  const members = useMemberStore((s) => s.members);
  /**
   * 卡片上的队伍徽章**本地兜底**（后台补全还没跑完时也要显示）。
   *
   * 口径与直播页卡片完全一致：`utils/memberMatch` 的 `resolveTeam`（先 userId、后归一化昵称）。
   * 以前卡片只显示存储里的 `team` 字段 —— 而该字段在记录时经常是空的（写历史的链路
   * 按昵称字符串硬匹配成员库，恒 miss），于是「直播页有徽章、历史里没有」。
   */
  const memberLookup = React.useMemo(() => buildMemberLookup(members), [members]);
  const rows = React.useMemo(() => entries.map((it) => {
    if (it.team) return it;
    // 与 useEnrichMeta 共用同一个本地兜底（先 ownerId → 成员 id 反查，再昵称，再标题）
    const p = resolveWatchMeta({ key: it.key, owner: it.owner, ownerId: it.ownerId, title: it.title }, memberLookup);
    return p?.team ? { ...it, team: p.team, ...(p.ownerId && !it.ownerId ? { ownerId: p.ownerId } : {}) } : it;
  }), [entries, memberLookup]);
  /**
   * **固定一行 4 个**（用户 2026-09-30 明确：不要按屏宽或条目数量改列数/改大小）。
   * 因此卡片宽度按屏宽算出后**写死在每张卡上**（不再用 flex:1）——
   * 否则最后一行只有 2~3 条时会被拉伸成每个占半屏，尺寸随数量变。
   */
  const COLUMNS = 4;
  const H_PAD = 8;
  const GAP = 8;
  const cardW = Math.max(56, Math.floor((width - H_PAD * 2 - GAP * (COLUMNS - 1)) / COLUMNS));

  /**
   * 点击条目 → 就地全屏播放（用户 2026-10-02）。
   * 解析 / 续播 / 弹幕 / 在线人数 / 小窗全部交给统一播放宿主
   * （MediaPlaybackHost，modal 模式）；退出（返回键/关闭）即回到本列表页。
   */
  const [playEntry, setPlayEntry] = useState<MediaListEntry | null>(null);
  const playItem = useCallback((entry: MediaListEntry) => {
    setPlayEntry(entry);
  }, []);
  const closePlayback = useCallback(() => setPlayEntry(null), []);

  /** 条目 → 统一播放条目（PlayMedia）：按来源分派解析链路（宿主内部处理） */
  const playMedia = useMemo<PlayMedia | null>(() => {
    if (!playEntry) return null;
    const refKind = playEntry.refKind;
    const refId = String(playEntry.refId || '');
    const liveId = String(playEntry.liveId || '');
    const base = {
      title: playEntry.title,
      cover: playEntry.cover,
      owner: playEntry.owner,
      team: playEntry.team,
      ownerId: playEntry.ownerId,
    };
    if (refKind === 'video') return { ...base, kind: 'video', videoId: refId || liveId };
    if (refKind === 'openlive') return { ...base, kind: 'openlive', liveId: refId || liveId };
    if (refKind === 'replay') return { ...base, kind: 'replay', liveId: liveId || refId };
    // 无 refKind：历史里的直播条目（或旧数据）——按直播解析
    return { ...base, kind: 'live', liveId: liveId || refId };
  }, [playEntry]);

  return (
    <View style={styles.container}>
      <ScreenHeader
        title={title}
        right={onClear && entries.length > 0
          ? <HeaderAction label={clearLabel || t('清除')} onPress={onClear} />
          : undefined}
      />
      {statsText ? <Text style={[styles.stats, { color: palette.labelSecondary }]}>{statsText}</Text> : null}
      <FlatList
        /* ⚠️ numColumns 变化必须换 key 重建列表：RN 不支持运行时改列数（会错位/告警） */
        key={`grid-${COLUMNS}`}
        data={rows}
        keyExtractor={(it) => it.key}
        numColumns={COLUMNS}
        columnWrapperStyle={{ paddingHorizontal: H_PAD, gap: GAP }}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<EmptyState icon="history" title={emptyTitle} hint={emptyHint} />}
        renderItem={({ item }) => (
          <TouchableOpacity
            activeOpacity={0.9}
            style={[styles.card, { width: cardW }]}
            onPress={() => playItem(item)}
          >
            <View style={[styles.cover, { backgroundColor: palette.fill2 }]}>
              {item.cover ? (
                /* ⚠️ 用 NetworkImage 而不是原生 Image（用户 2026-09-30：「现在图片也没了」）：
                   口袋的封面地址对部分来源需要特定 header，原生 Image 会 403 → 空白；
                   NetworkImage 带两段兜底（缩略图失败退回原图），直播页封面也是这套。 */
                <NetworkImage
                  source={{ uri: item.cover }}
                  style={styles.coverImg}
                  thumbnail={240}
                />
              ) : (
                <MaterialCommunityIcons name="play-box-multiple-outline" size={22} color={palette.tint} />
              )}
              {/* 类型胶囊（视频 / 电台 / 回放 / 公演回放）：压一层深底保证浅色封面也看得清 */}
              <View style={styles.kindTag}>
                <Text style={styles.kindTagText}>{item.label}</Text>
              </View>
              {/* 时长（封面右下角）：与直播页录播卡片同款信息。补全前旧记录没有时长，补到就显示 */}
              {item.duration ? (
                <View style={styles.durationTag}>
                  <Text style={styles.durationTagText}>{formatDuration(item.duration)}</Text>
                </View>
              ) : null}
              {/* 删除：封面右上角小圆钮（不抢卡片主点击区） */}
              <TouchableOpacity
                onPress={() => onRemove(item.key)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={styles.del}
              >
                <MaterialCommunityIcons name="close" size={12} color="#fff" />
              </TouchableOpacity>
            </View>
            <Text style={[styles.cardTitle, { color: palette.label }]} numberOfLines={2}>
              {item.title || t('无标题')}
            </Text>
            {/* 队伍徽章 + 成员名一行；时间（+ 历史独有的「看过 N 次」）另一行。
                ⚠️ 以前三者挤在一行且 numberOfLines={1}：4 列窄卡上「时间 · 看过 N 次」
                会把成员名整段挤没（用户反馈「只有名字和时间，看不到成员名/队伍徽章」的
                一半原因就是这个 —— 数据有、但被行宽吃掉了）。 */}
            {item.team || item.owner ? (
              <View style={styles.metaRow}>
                {item.team ? <TeamBadge team={item.team} fontSize={10} /> : null}
                {item.owner ? (
                  <Text style={[styles.ownerText, { color: palette.label }]} numberOfLines={1}>{item.owner}</Text>
                ) : null}
              </View>
            ) : null}
            {/* 类型 + 时间（历史还带「看过 N 次」）。
                ⚠️ 类型**同时**出现在这里与封面胶囊上（用户反馈「没有显示类型」）：
                4 列窄卡上胶囊只有拇指盖大，容易被忽略；这里再给一份文字，
                保证「视频 / 电台 / 回放 / 公演回放」一定看得见。 */}
            {(item.label || item.meta) ? (
              <Text style={[styles.metaText, { color: palette.labelTertiary }]} numberOfLines={1}>
                {[item.label, item.meta].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
          </TouchableOpacity>
        )}
      />

      {/* 就地全屏播放：统一播放宿主（解析/续播/弹幕/在线人数/小窗全部由它完成）。
          modal 模式 → 硬件返回键自动关闭并回到本列表页。 */}
      {playMedia ? (
        <MediaPlaybackHost
          modal
          media={playMedia}
          onClose={closePlayback}
          /* 直播间公告（用户 2026-10-02：观看历史/稍后再看里也要能看到）：
             直播与回放都拉，面板/顶栏与控制坞按钮由宿主统一渲染 */
          announcement
          /* 与主直播页同一口径：直播弹幕 HTTP 轮询兜底 + 回放弹幕到达 toast */
          danmakuLivePollMs={5000}
          danmakuVodNotice
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  stats: { marginHorizontal: 16, marginTop: 4, marginBottom: 6, fontSize: 12 },
  list: { paddingTop: 6, paddingBottom: 120 },
  /** 单张卡：封面 16:9 + 标题 2 行 + （队伍徽章 + 成员名 · 时间）；宽度由 cardW 写死，不随数量拉伸 */
  card: { marginBottom: 14 },
  cover: { width: '100%', aspectRatio: 16 / 9, borderRadius: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  coverImg: { width: '100%', height: '100%' },
  kindTag: {
    position: 'absolute', left: 5, bottom: 5,
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7,
    // 底色更实、字号更大：4 列时卡片很小，浅色封面上原来的细字几乎看不见
    //（用户反馈「没有显示类型」—— 实际是太小被忽略，这里再放大一档）
    backgroundColor: 'rgba(0,0,0,0.74)',
  },
  kindTagText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  /** 时长角标（封面右下角）：与直播页录播卡片同款 */
  durationTag: {
    position: 'absolute', right: 5, bottom: 5,
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5,
    backgroundColor: 'rgba(0,0,0,0.66)',
  },
  durationTagText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  del: {
    position: 'absolute', right: 4, top: 4, width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.6)',
  },
  cardTitle: { fontSize: 11, fontWeight: '700', lineHeight: 15, marginTop: 5 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  /** 成员名：比时间更重要的信息，占满剩余宽度、字号略大一点 */
  ownerText: { flex: 1, fontSize: 10, fontWeight: '600' },
  metaText: { fontSize: 9, marginTop: 2 },
});

export default MediaListPage;
