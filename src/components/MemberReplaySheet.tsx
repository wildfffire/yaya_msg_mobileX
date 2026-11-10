import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import pocketApi from '../api/pocket48';
import { GlassSurface } from './GlassSurface';
import { NetworkImage } from './NetworkImage';
import { useI18n } from '../i18n';
import { errorMessage, normalizeUrl, pickText, unwrapList } from '../utils/data';
import { formatDuration, formatTimestamp } from '../utils/format';
import { getReplayProgress } from '../services/replayProgress';
import { usePalette, radii } from '../theme';
import { useIsLandscape } from '../hooks/useIsLandscape';

/**
 * 成员直播回放列表（房间内「直播回放」入口）。
 *
 * 数据源：`pocketApi.getLiveList({ record: true, userId })` —— 口袋服务端**原生支持按成员过滤**
 *（`src/api/pocket48.ts` 里该方法的注释即为此写：桌面基线 fetchLiveList / 48tools requestLiveList
 * 都透传 userId，避免「拉全量再前端筛」导致的历史缺失）。
 *
 * ⚠️ 官方坑（必读）：**`next=0` 且带 `userId` 时查不到任何数据**。
 *   必须先发一次**不带 userId** 的探针请求，用返回列表里最新一条的 `liveId` 当游标，
 *   再带上 userId 去查。`MediaScreen.doFetch` 里已有同样的处理，这里照抄同一套逻辑，
 *   否则表现就是「永远空列表」。
 *
 * 播放交给调用方（房间页复用自己既有的 roomPlayer 链路），本组件只负责列表与分页。
 */

export interface MemberReplayItem {
  liveId: string;
  title: string;
  cover: string;
  /** 开播时间（毫秒） */
  startTime: number;
  /** 结束时间（毫秒，可能为 0） */
  endTime: number;
  /** 该场的可播放地址（若有）：用于「房间内在播的流 ↔ 回放列表条目」对号入座 */
  url: string;
}

export interface MemberReplayTarget {
  /** 成员 userId（Member.id 即口袋 userId） */
  id: string;
  name: string;
  avatar?: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  member: MemberReplayTarget | null;
  onPick: (item: MemberReplayItem) => void;
}

const LIST_KEYS = [
  'content.liveList',
  'content.list',
  'content.data',
  'data.liveList',
  'data.list',
  'liveList',
  'list',
];
const ID_KEYS = ['liveId', 'id', 'live_id'];
const TITLE_KEYS = ['title', 'liveRoomTitle', 'liveTitle', 'nickname', 'name'];
const COVER_KEYS = ['liveCover', 'coverPath', 'cover', 'coverUrl', 'picPath', 'liveRoomCover'];
const START_KEYS = ['startTime', 'stime', 'ctime', 'liveStartTime', 'beginTime'];
const END_KEYS = ['endTime', 'etime', 'liveEndTime', 'end_time'];

/** 官方录播条目的可播放地址键（与 OpenLiveScreen 的抽取键保持同一套口径） */
const URL_KEYS = ['playStreamPath', 'playUrl', 'playUrlHls', 'recordUrl', 'streamPath', 'url'];

function pickReplayUrl(raw: any): string {
  for (const key of URL_KEYS) {
    const v = raw?.[key];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  // playStreams 可能是数组/嵌套对象：兜底从 JSON 文本里抓第一个流地址
  const text = JSON.stringify(raw?.playStreams ?? raw?.playList ?? '');
  const m = text.match(/https?:(?:\\\/|\/){2}[^\"]+?\.(?:m3u8|mp4|flv)/i);
  return m ? m[0].replace(/\\\//g, '/') : '';
}

function normalizeReplay(raw: any, _index: number): MemberReplayItem | null {
  const liveId = pickText(raw, ID_KEYS);
  if (!liveId) return null;
  return {
    liveId: String(liveId),
    title: String(pickText(raw, TITLE_KEYS) || '').trim() || String(liveId),
    cover: normalizeUrl(pickText(raw, COVER_KEYS)),
    startTime: Number(pickText(raw, START_KEYS)) || 0,
    endTime: Number(pickText(raw, END_KEYS)) || 0,
    url: pickReplayUrl(raw),
  };
}

/** 拉一页：返回条目 + 下一页游标（0 = 没有下一页）。房间内在线人数反查也用同一份（勿改签名） */
export async function fetchReplayPage(memberId: string, cursor: number): Promise<{ items: MemberReplayItem[]; next: number }> {
  let finalCursor = Number(cursor) || 0;
  if (finalCursor === 0) {
    // ⚠️ 见文件头「官方坑」：先探针取最新 liveId 当游标
    const probe: any = await pocketApi.getLiveList({ next: 0, record: true, debug: true }).catch(() => null);
    const probeList = unwrapList(probe, LIST_KEYS);
    const probeNext = Number(probe?.content?.next ?? probe?.data?.next ?? probe?.next ?? 0);
    const firstId = Number(probeList[0]?.liveId ?? probeList[0]?.id ?? 0);
    finalCursor = firstId || probeNext || 0;
  }
  const res: any = await pocketApi.getLiveList({
    next: finalCursor,
    record: true,
    debug: true,
    userId: memberId,
  });
  const list = unwrapList(res, LIST_KEYS);
  const items = list
    .map((raw: any, index: number) => normalizeReplay(raw, index))
    .filter(Boolean) as MemberReplayItem[];
  const nextToken = Number(res?.content?.next ?? res?.data?.next ?? res?.next ?? 0);
  return {
    items,
    next: items.length > 0 && nextToken > 0 && nextToken !== finalCursor ? nextToken : 0,
  };
}

/**
 * 按「正在播的地址 / 标题」在成员回放列表里反查 liveId（房间内在线人数的兜底来源）。
 *
 * 与直播板块的录播**同源**：同一个 `getLiveList({ record: true, userId })`。
 * 场景：房间里的回放是从聊天消息卡点开的，卡的 JSON/URL 里抽不出可靠的 liveId
 * （18-19 位数字十有八九是云信 msgIdClient，拿去查 getLiveOne 必然查空）——
 * 这时拿播放地址（去 query 后按路径/文件名比对，签名参数每请求都变不能直接比）
 * 或标题在回放列表里对号入座，命中即拿到真 liveId。
 * 列表带 5 分钟模块级缓存：同一成员反复回看不重复打接口。
 */
const replayIdCache = new Map<string, { at: number; items: MemberReplayItem[] }>();
const REPLAY_ID_TTL = 5 * 60 * 1000;

export async function findReplayLiveId(
  memberId: string,
  hint: { url?: string; title?: string },
): Promise<string> {
  const key = String(memberId || '');
  if (!key) return '';
  let entry = replayIdCache.get(key);
  if (!entry || Date.now() - entry.at > REPLAY_ID_TTL) {
    const page = await fetchReplayPage(key, 0);
    entry = { at: Date.now(), items: page.items };
    replayIdCache.set(key, entry);
  }
  const hintPath = String(hint.url || '').split('?')[0];
  const hintFile = hintPath.split('/').pop() || '';
  if (hintPath) {
    for (const item of entry.items) {
      const itemPath = String(item.url || '').split('?')[0];
      if (!itemPath) continue;
      if (itemPath === hintPath || (hintFile && itemPath.split('/').pop() === hintFile)) {
        return item.liveId;
      }
    }
  }
  const hintTitle = String(hint.title || '').trim();
  if (hintTitle) {
    const hit = entry.items.find((item) => String(item.title || '').trim() === hintTitle);
    if (hit) return hit.liveId;
  }
  return '';
}

export default function MemberReplaySheet({ visible, onClose, member, onPick }: Props) {
  const palette = usePalette();
  const { t } = useI18n();
  const isLandscape = useIsLandscape();
  const [items, setItems] = useState<MemberReplayItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [next, setNext] = useState(0);
  /** liveId → 观看进度（房间内「上次看到」记忆的展示端）：条目就绪后批量读取 */
  const [progress, setProgress] = useState<Record<string, { position: number; duration: number }>>({});
  /** 当前已加载的成员 id：成员变了才重新拉（同一成员重复打开直接复用） */
  const loadedForRef = useRef('');
  const busyRef = useRef(false);

  // 条目就绪 / 抽屉每次打开时重读进度（刚看完一场回来，数字要更新）
  useEffect(() => {
    if (!items.length || !visible) return;
    let alive = true;
    (async () => {
      const map: Record<string, { position: number; duration: number }> = {};
      for (const it of items) {
        const entry = await getReplayProgress(it.liveId).catch(() => null);
        if (entry) map[it.liveId] = { position: entry.position, duration: entry.duration };
      }
      if (alive) setProgress(map);
    })();
    return () => { alive = false; };
  }, [items, visible]);

  const load = useCallback(async (memberId: string, cursor = 0) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const append = cursor !== 0;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setItems([]);
      setNext(0);
      setError('');
    }
    try {
      const page = await fetchReplayPage(memberId, cursor);
      setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      setNext(page.next);
      loadedForRef.current = memberId;
    } catch (e) {
      setError(errorMessage(e));
      if (!append) setItems([]);
    } finally {
      busyRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!visible || !member?.id) return;
    // 同一成员已有数据就不重复拉（避免每次开关都打网络）
    if (loadedForRef.current === member.id && items.length) return;
    load(member.id, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, member?.id]);

  const loadMore = useCallback(() => {
    if (!member?.id || !next || loading || loadingMore || busyRef.current) return;
    load(member.id, next);
  }, [member?.id, next, loading, loadingMore, load]);

  const renderItem = ({ item }: { item: MemberReplayItem }) => {
    const duration = item.endTime > item.startTime ? formatDuration((item.endTime - item.startTime) / 1000) : '';
    const when = item.startTime ? formatTimestamp(item.startTime).slice(0, 16) : '';
    const prog = progress[item.liveId];
    const totalSec = prog?.duration > 0
      ? prog.duration
      : item.endTime > item.startTime
        ? (item.endTime - item.startTime) / 1000
        : 0;
    const pct = prog && totalSec > 0 ? Math.min(1, Math.max(0, prog.position / totalSec)) : 0;
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        style={[styles.row, { borderBottomColor: palette.hairline }]}
        onPress={() => onPick(item)}
      >
        <View style={[styles.thumb, { backgroundColor: palette.fill2 }]}>
          {item.cover ? (
            <NetworkImage source={{ uri: item.cover }} style={styles.thumb} resizeMode="cover" thumbnail={240} />
          ) : (
            <MaterialCommunityIcons name="play-box-multiple-outline" size={20} color={palette.tint} />
          )}
          {pct > 0 ? (
            <View pointerEvents="none" style={styles.thumbProgressTrack}>
              <View style={[styles.thumbProgressFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: palette.tint }]} />
            </View>
          ) : null}
        </View>
        <View style={styles.rowBody}>
          <Text style={[styles.rowTitle, { color: palette.label }]} numberOfLines={2}>{item.title}</Text>
          <Text style={[styles.rowMeta, { color: palette.labelSecondary }]} numberOfLines={1}>
            {when}{duration ? ` · ${duration}` : ''}
            {prog ? ` · ${t('上次看到 {time}', { time: formatDuration(prog.position) })}` : ''}
          </Text>
        </View>
        <MaterialCommunityIcons name="play-circle-outline" size={22} color={palette.tint} />
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.mask} activeOpacity={1} onPress={onClose}>
        <GlassSurface
          radius={22}
          role="card"
          style={[
            styles.sheet,
            isLandscape ? styles.sheetLandscape : null,
            { backgroundColor: 'transparent', borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet },
          ]}
        >
          {/* 手势条 + 标题 */}
          <View style={styles.handleArea}>
            <View style={[styles.handle, { backgroundColor: palette.innerStroke }]} />
          </View>
          <View style={styles.header}>
            <MaterialCommunityIcons name="history" size={17} color={palette.tint} />
            <Text style={[styles.headerTitle, { color: palette.label }]} numberOfLines={1}>
              {t('直播回放')}
            </Text>
            {member?.name ? (
              <Text style={[styles.headerSub, { color: palette.labelTertiary }]} numberOfLines={1}>{member.name}</Text>
            ) : null}
          </View>

          {error && !items.length ? (
            <View style={styles.stateBox}>
              <MaterialCommunityIcons name="alert-circle-outline" size={22} color={palette.danger} />
              <Text style={[styles.stateText, { color: palette.labelSecondary }]} numberOfLines={3}>{error}</Text>
              <TouchableOpacity
                style={[styles.retryBtn, { backgroundColor: palette.tintSoft }]}
                onPress={() => member?.id && load(member.id, 0)}
              >
                <Text style={[styles.retryText, { color: palette.tint }]}>{t('重试')}</Text>
              </TouchableOpacity>
            </View>
          ) : loading ? (
            <View style={styles.stateBox}>
              <ActivityIndicator color={palette.tint} />
              <Text style={[styles.stateText, { color: palette.labelSecondary }]}>{t('加载中…')}</Text>
            </View>
          ) : !items.length ? (
            <View style={styles.stateBox}>
              <MaterialCommunityIcons name="play-box-multiple-outline" size={22} color={palette.labelTertiary} />
              <Text style={[styles.stateText, { color: palette.labelSecondary }]}>{t('暂无直播回放')}</Text>
            </View>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(item) => item.liveId}
              renderItem={renderItem}
              contentContainerStyle={styles.listContent}
              onEndReached={loadMore}
              onEndReachedThreshold={0.4}
              initialNumToRender={10}
              maxToRenderPerBatch={10}
              windowSize={7}
              removeClippedSubviews
              ListFooterComponent={
                <Text style={[styles.footer, { color: palette.labelTertiary }]}>
                  {loadingMore ? t('加载中…') : next ? t('上滑加载更多') : t('没有更多了')}
                </Text>
              }
            />
          )}
        </GlassSurface>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '66%', paddingBottom: 16 },
  /** 横屏窗口矮：放宽上限，否则列表只剩两行可见 */
  sheetLandscape: { maxHeight: '92%', width: '100%' },
  handleArea: { alignItems: 'center', paddingTop: 8, paddingBottom: 2 },
  handle: { width: 40, height: 4, borderRadius: 2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10 },
  headerTitle: { fontSize: 15, fontWeight: '800' },
  headerSub: { flex: 1, fontSize: 12, fontWeight: '600' },
  listContent: { paddingHorizontal: 12, paddingBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thumb: { width: 76, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  thumbProgressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(0,0,0,0.35)' },
  thumbProgressFill: { height: '100%' },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 13, fontWeight: '700', lineHeight: 18 },
  rowMeta: { fontSize: 11, marginTop: 3 },
  stateBox: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 34, paddingHorizontal: 24 },
  stateText: { fontSize: 12, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 18, paddingVertical: 7, borderRadius: 999, marginTop: 2 },
  retryText: { fontSize: 12, fontWeight: '800' },
  footer: { textAlign: 'center', fontSize: 11, fontWeight: '700', paddingVertical: 12 },
});
