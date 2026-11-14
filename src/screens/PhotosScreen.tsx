/**
 * PhotosScreen · 相册（个人相册 / 房间相册 双 Tab）
 *
 * - 个人相册：成员上传的照片（`getMemberPhotos` + `getStarArchives`），纯图片
 * - 房间相册：房间里的图片与视频，接口 `im/api/v1/team/msg/list/img`
 *   （每条 `bodys` 是 JSON 字符串，媒体地址在 `bodys.url`，`sourceType === 'VIDEO'` 为视频，
 *    游标是 `content.nextTime` —— 与桌面端 room-album-feature.js 同口径）
 * - 选择模式：批量加入下载队列
 * - 入口：房间右上角工具条「相册」（带 memberId + channelId）
 *
 * 页面不显示成员选择器与成员名（用户 2026-11-08 要求：顶栏与照片之间不要任何东西）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';
import { Modal, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { RouteProp, useRoute } from '@react-navigation/native';
import { NetworkImage } from '../components/NetworkImage';
import { useMemberStore, useUiStore } from '../store';
import { FadeInView, ScalePressable } from '../components/Motion';
import { Skeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/StateViews';
import ScreenHeader from '../components/ScreenHeader';
import { Member } from '../types';
import ZoomImageModal from '../components/ZoomImageModal';
import { HeaderAction } from '../components/HeaderAction';
import { GlassSurface } from '../components/GlassSurface';
import { GlassSegmented } from '../components/GlassSegmented';
import PlayerScreen from '../player';
import { errorMessage, normalizeUrl, pickText, unwrapList } from '../utils/data';
import { logInfo } from '../utils/runtimeLog';
import pocketApi from '../api/pocket48';
import { enqueueDownload } from '../services/downloads';
import { POCKET_MEDIA_HEADERS } from '../utils/mediaHeaders';
import { usePalette, radii } from '../theme';
import { typography } from '../theme/typography';
import { useI18n } from '../i18n';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import type { RootStackParamList } from '../navigation/types';

type AlbumTab = 'personal' | 'room';

interface AlbumItem {
  key: string;
  kind: 'image' | 'video';
  url: string;
  thumb: string;
  title: string;
}

/** 房间相册一次翻页上限：多页拼接，弱网时不至于卡死 */
const ROOM_ALBUM_MAX_PAGES = 4;

function normalizeImageUrl(value: any): string {
  const direct = normalizeUrl(value);
  if (!direct) return '';
  if (/^https?:\/\//i.test(direct)) return direct.replace(/^http:\/\//i, 'https://');
  if (/^(backstage|mediasource|202\d|20\d{6})\//i.test(direct)) return `https://source.48.cn/${direct}`;
  return direct;
}

function deepFindImageUrl(value: any, depth = 0): string {
  if (!value || depth > 6) return '';
  if (typeof value === 'string') {
    const direct = normalizeImageUrl(value);
    if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(direct) || direct.includes('source.48.cn') || direct.includes('/image') || direct.includes('backstage')) {
      return direct;
    }
    return '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindImageUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    const direct = normalizeImageUrl(pickText(value, [
      'url', 'imageUrl', 'imgUrl', 'image', 'cover', 'coverUrl', 'picUrl', 'picPath',
      'photoUrl', 'resourceUrl', 'filePath', 'path', 'sourcePath', 'originUrl',
      'thumbnail', 'thumb', 'smallUrl', 'bigUrl', 'imagePath', 'picturePath',
      'fullPhoto1', 'fullPhoto2', 'fullPhoto3', 'fullPhoto4',
      'starInfo.fullPhoto1', 'starInfo.fullPhoto2', 'starInfo.fullPhoto3', 'starInfo.fullPhoto4',
    ]));
    if (direct) return direct;
    for (const item of Object.values(value)) {
      const found = deepFindImageUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

/** 房间相册列表外壳：messageList / message / data / 第一个数组字段 */
function parseAlbumList(content: any): any[] {
  const direct = content?.messageList || content?.message || content?.data;
  if (Array.isArray(direct)) return direct;
  for (const key of Object.keys(content || {})) {
    if (Array.isArray((content as any)[key])) return (content as any)[key];
  }
  return [];
}

/** 房间相册单条的 `bodys`：JSON 字符串（可能带双重转义），也可能已是对象 */
function parseAlbumBody(item: any): any {
  const raw = item?.bodys ?? item?.body;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  let text = String(raw).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  try {
    return JSON.parse(text) || {};
  } catch {
    return {};
  }
}

export default function PhotosScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const route = useRoute<RouteProp<RootStackParamList, 'PhotosScreen'>>();
  const params = route.params;
  const showToast = useUiStore((state) => state.showToast);
  const members = useMemberStore((state) => state.members);

  const [tab, setTab] = useState<AlbumTab>(params?.tab === 'room' ? 'room' : 'personal');
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  /** 房间相册的数据源：入口带过来的 channelId，或成员库里的 channelId */
  const channelId = String(params?.channelId || (selectedMember as any)?.channelId || '');

  const [personal, setPersonal] = useState<AlbumItem[]>([]);
  const [roomItems, setRoomItems] = useState<AlbumItem[]>([]);
  const [previewUrl, setPreviewUrl] = useState('');
  const [playing, setPlaying] = useState<{ url: string; title: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [loadError, setLoadError] = useState('');
  const [roomCursor, setRoomCursor] = useState('0');
  const [roomHasMore, setRoomHasMore] = useState(false);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Record<string, true>>({});

  const runIdRef = useRef(0);
  const roomRunIdRef = useRef(0);

  /** 入口带 memberId：成员库到位后自动选中（冷启动时 members 可能是异步到的） */
  useEffect(() => {
    if (!params?.memberId || selectedMember) return;
    const found = members.find((m) => String(m.id) === String(params.memberId));
    if (found) setSelectedMember(found);
  }, [members, params?.memberId, selectedMember]);

  const loadPersonal = useCallback(async (member: Member) => {
    const runId = ++runIdRef.current;
    setLoading(true);
    setLoadError('');
    setStatus('');
    try {
      const [photoRes, archiveRes] = await Promise.all([
        pocketApi.getMemberPhotos(member.id).catch(() => null),
        pocketApi.getStarArchives(Number(member.id)).catch(() => null),
      ]);
      if (runId !== runIdRef.current) return;
      const list = unwrapList(photoRes, [
        'content.nftList', 'content.photoList', 'content.imageList', 'content.list',
        'content.data.nftList', 'content.data.photoList', 'content.data.imageList', 'content.data.list',
        'data.nftList', 'data.photoList', 'data.imageList', 'data.list',
        'nftList', 'photoList', 'imageList', 'list',
      ]);
      const starInfo = archiveRes?.content?.starInfo || archiveRes?.content || archiveRes?.data?.starInfo || archiveRes?.data || {};
      const archivePhotos = ['fullPhoto1', 'fullPhoto2', 'fullPhoto3', 'fullPhoto4', 'avatar', 'starAvatar']
        .map((key) => starInfo?.[key])
        .filter(Boolean)
        .map((url, index) => ({ id: `archive-${index}`, url }));
      const combined = [...list, ...archivePhotos];
      const seen = new Set<string>();
      const merged: AlbumItem[] = [];
      combined.forEach((raw: any, index: number) => {
        const url = deepFindImageUrl(raw);
        if (!url || seen.has(url)) return;
        seen.add(url);
        merged.push({
          key: String(raw?.id || raw?.nftId || `photo-${index}`) + url.slice(-12),
          kind: 'image',
          url,
          thumb: url,
          title: t('成员照片'),
        });
      });
      setPersonal(merged);
      setStatus(t('共 {count} 张', { count: merged.length }));
    } catch (error) {
      if (runId !== runIdRef.current) return;
      setLoadError(errorMessage(error));
      setPersonal([]);
    } finally {
      if (runId === runIdRef.current) setLoading(false);
    }
  }, [t]);

  /**
   * 房间相册一页：`bodys.url` 是媒体地址，`sourceType === 'VIDEO'` 为视频，
   * 游标取 `content.nextTime`（与桌面端 room-album-feature.js 完全一致）。
   */
  const loadRoomPage = useCallback(async (channel: string, cursor: string) => {
    const res: any = await pocketApi.getRoomAlbum({ channelId: channel, nextTime: Number(cursor) || 0 });
    const content = res?.content ?? {};
    const list = parseAlbumList(content);
    const seen = new Set<string>();
    const items: AlbumItem[] = [];
    list.forEach((raw: any, index: number) => {
      const body = parseAlbumBody(raw);
      const url = String(body?.url || '').trim();
      if (!url || seen.has(url)) return;
      seen.add(url);
      const isVideo = String(raw?.sourceType || '').toUpperCase() === 'VIDEO';
      items.push({
        key: String(raw?.msgIdClient || raw?.msgId || raw?.messageId || raw?.id || `${cursor}-${index}`),
        kind: isVideo ? 'video' : 'image',
        url,
        // 视频封面用首帧（与桌面端 `#t=0.1` 同思路：交给播放器抽帧，这里只放空缩略图位）
        thumb: isVideo ? '' : url,
        title: String(raw?.starName || t('房间相册')),
      });
    });
    if (!items.length) {
      try {
        logInfo(
          `[album] 空页 channel=${channel} next=${cursor} contentKeys=${Object.keys(content || {}).join(',') || '(none)'} list=${list.length} firstKeys=${list[0] ? Object.keys(list[0]).join(',') : '(none)'}`,
          'album',
        );
      } catch {}
    }
    const next = String(content?.nextTime ?? '0');
    return { items, next: next && next !== 'undefined' ? next : '0', rawCount: list.length };
  }, [t]);

  const loadRoom = useCallback(async (channel: string, append = false, cursor = '0') => {
    if (!channel) {
      setRoomItems([]);
      setStatus('');
      return;
    }
    const runId = ++roomRunIdRef.current;
    setLoading(true);
    setLoadError('');
    setStatus('');
    try {
      const collected: AlbumItem[] = [];
      const seen = new Set<string>();
      let nextCursor = cursor;
      let more = true;
      let pages = 0;
      while (more && pages < ROOM_ALBUM_MAX_PAGES) {
        const page = await loadRoomPage(channel, nextCursor);
        if (runId !== roomRunIdRef.current) return;
        pages += 1;
        page.items.forEach((item) => {
          if (seen.has(item.url)) return;
          seen.add(item.url);
          collected.push(item);
        });
        more = !!page.next && page.next !== '0' && page.next !== nextCursor;
        nextCursor = page.next;
      }
      setRoomItems((prev) => {
        if (!append) return collected;
        const merged = [...prev];
        const keys = new Set(prev.map((i) => i.url));
        collected.forEach((item) => { if (!keys.has(item.url)) merged.push(item); });
        return merged;
      });
      setRoomCursor(nextCursor);
      setRoomHasMore(more);
      setStatus(collected.length ? t('共 {count} 项', { count: collected.length }) : '');
    } catch (error) {
      if (runId !== roomRunIdRef.current) return;
      setLoadError(errorMessage(error));
      if (!append) setRoomItems([]);
    } finally {
      if (runId === roomRunIdRef.current) setLoading(false);
    }
  }, [loadRoomPage, t]);

  /** 首次进入：按入口参数决定拉哪个 Tab；房间相册由 channelId 驱动 */
  useEffect(() => {
    if (tab === 'room') loadRoom(channelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, channelId]);

  /** 选中成员变化（含入口带 memberId、成员库异步到位）→ 拉一次个人相册；ref 防重复 */
  const autoLoadedRef = useRef('');
  useEffect(() => {
    if (tab !== 'personal' || !selectedMember) return;
    const id = String(selectedMember.id);
    if (autoLoadedRef.current === id) return;
    autoLoadedRef.current = id;
    loadPersonal(selectedMember);
  }, [tab, selectedMember, loadPersonal]);

  const items = tab === 'personal' ? personal : roomItems;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected({});
  }, []);

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected((prev) => {
      const keys = itemsRef.current.map((i) => i.key);
      const allSelected = keys.length > 0 && keys.every((k) => prev[k]);
      if (allSelected) return {};
      const next: Record<string, true> = {};
      keys.forEach((k) => { next[k] = true; });
      return next;
    });
  }, []);

  const downloadOne = useCallback(async (item: AlbumItem) => {
    try {
      const suffix = item.kind === 'video' ? 'video' : 'photo';
      const name = `${selectedMember?.ownerName || t('房间相册')}-${suffix}-${item.key.slice(-6)}`;
      await enqueueDownload({ url: item.url, type: item.kind, name });
      return true;
    } catch {
      return false;
    }
  }, [selectedMember, t]);

  const downloadSelected = useCallback(async () => {
    const picked = itemsRef.current.filter((i) => selected[i.key]);
    if (!picked.length) return;
    setLoading(true);
    let ok = 0;
    for (const item of picked) {
      if (await downloadOne(item)) ok += 1;
    }
    setLoading(false);
    showToast(ok === picked.length
      ? t('已加入下载管理')
      : t('已加入 {ok}/{total} 项，其余失败', { ok, total: picked.length }));
    exitSelect();
  }, [downloadOne, exitSelect, selected, showToast, t]);

  const photoUrls = useMemo(() => items.map((i) => i.thumb || i.url), [items]);

  const renderItem = useCallback(({ item, index }: { item: AlbumItem; index: number }) => {
    const thumb = photoUrls[index] || item.thumb || item.url;
    const isSelected = !!selected[item.key];
    const delay = index < 12 ? 60 + index * 25 : 0;
    return (
      <FadeInView delay={delay} distance={8} style={{ flex: 1 }}>
        <ScalePressable
          style={styles.cell}
          activeOpacity={0.9}
          pressedScale={0.96}
          onPress={() => {
            if (selectMode) { toggleSelect(item.key); return; }
            if (item.kind === 'video') { setPlaying({ url: item.url, title: item.title }); return; }
            setPreviewUrl(item.url);
          }}
          onLongPress={() => { void downloadOne(item).then((ok) => ok && showToast(t('已加入下载管理'))); }}
        >
          {thumb ? (
            <NetworkImage source={{ uri: thumb }} style={[styles.photo, { backgroundColor: palette.fill3 }]} resizeMode="cover" thumbnail={600} />
          ) : (
            <View style={[styles.photo, styles.photoFallback, { backgroundColor: palette.fill3 }]}>
              <MaterialCommunityIcons name="play-circle-outline" size={26} color={palette.labelTertiary} />
            </View>
          )}
          {item.kind === 'video' ? (
            <View style={styles.videoBadge}>
              <MaterialCommunityIcons name="play" size={14} color="#fff" />
            </View>
          ) : null}
          {selectMode ? (
            <View style={[styles.check, { backgroundColor: isSelected ? palette.tint : 'rgba(0,0,0,0.35)', borderColor: '#fff' }]}>
              {isSelected ? <MaterialCommunityIcons name="check" size={13} color="#fff" /> : null}
            </View>
          ) : null}
        </ScalePressable>
      </FadeInView>
    );
  }, [downloadOne, palette, photoUrls, selectMode, selected, showToast, t, toggleSelect]);

  const renderSkeletonGrid = () => {
    const rows = [0, 1, 2];
    return (
      <View style={styles.skeletonWrap}>
        {rows.map((r) => (
          <View key={r} style={styles.skeletonRow}>
            {[0, 1, 2].map((c) => (
              <Skeleton key={`${r}-${c}`} height={100} radius={radii.sm} style={styles.skeletonCell} />
            ))}
          </View>
        ))}
      </View>
    );
  };

  const selectedCount = Object.keys(selected).length;
  const tabOptions = useMemo(() => ([
    { key: 'personal', label: t('个人相册') },
    { key: 'room', label: t('房间相册') },
  ]), [t]);

  const headerRight = selectMode ? (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <HeaderAction label={t('全选')} onPress={selectAll} />
      <HeaderAction label={t('取消')} onPress={exitSelect} />
    </View>
  ) : (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <HeaderAction label={t('选择')} onPress={() => setSelectMode(true)} disabled={!items.length} />
      <HeaderAction
        label={t('刷新')}
        onPress={() => {
          if (tab === 'room') loadRoom(channelId);
          else if (selectedMember) loadPersonal(selectedMember);
        }}
        disabled={loading || (tab === 'room' ? !channelId : !selectedMember)}
        loading={loading}
      />
    </View>
  );

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('相册')} right={headerRight} />
      <FadeInView delay={60} duration={300} style={{ flex: 1 }}>
        <View style={styles.tabsWrap}>
          <GlassSurface radius={20} role="card" style={styles.tabsRow}>
            <GlassSegmented
              options={tabOptions}
              value={tab}
              onChange={(key) => { setStatus(''); setLoadError(''); setTab(key as AlbumTab); exitSelect(); }}
              height={34}
            />
          </GlassSurface>
          {status ? <Text style={[styles.status, { color: palette.labelTertiary }]}>{status}</Text> : null}
        </View>
        <ZoomImageModal url={previewUrl} onClose={() => setPreviewUrl('')} />
        {loading && items.length === 0 ? (
          renderSkeletonGrid()
        ) : loadError ? (
          <View style={{ flex: 1 }}>
            <ErrorState
              title={t('加载失败')}
              hint={loadError}
              onAction={() => { if (tab === 'room') loadRoom(channelId); else if (selectedMember) loadPersonal(selectedMember); }}
            />
          </View>
        ) : items.length === 0 ? (
          <View style={{ flex: 1 }}>
            <EmptyState
              icon="image-multiple-outline"
              title={t('暂无图片')}
              hint={
                tab === 'room'
                  ? (channelId ? t('该房间暂时没有图片或视频') : t('请从房间右上角进入相册'))
                  : t('该成员暂时没有公开照片')
              }
            />
          </View>
        ) : (
          <PerfFlatList
            data={items}
            numColumns={3}
            keyExtractor={(item) => item.key}
            contentContainerStyle={[styles.list, selectMode ? styles.listWithBar : null]}
            renderItem={renderItem}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews
            onEndReachedThreshold={0.4}
            onEndReached={() => {
              if (tab === 'room' && roomHasMore && !loading) loadRoom(channelId, true, roomCursor);
            }}
            refreshControl={
              <RefreshControl
                refreshing={loading}
                onRefresh={() => { if (tab === 'room') loadRoom(channelId); else if (selectedMember) loadPersonal(selectedMember); }}
                tintColor={palette.tint}
                colors={[palette.tint]}
              />
            }
          />
        )}
      </FadeInView>
      {selectMode ? (
        <View style={[styles.selectBar, { backgroundColor: palette.surface, borderColor: palette.innerStroke }]}>
          <Text style={[styles.selectText, { color: palette.label }]}>{t('已选 {n} 项', { n: selectedCount })}</Text>
          <HeaderAction label={t('下载')} onPress={() => { void downloadSelected(); }} disabled={!selectedCount || loading} />
        </View>
      ) : null}
      {playing ? (
        <Modal visible animationType="fade" onRequestClose={() => setPlaying(null)}>
          <View style={{ flex: 1, backgroundColor: '#000' }}>
            <PlayerScreen
              source={{ kind: 'vod', url: playing.url, headers: POCKET_MEDIA_HEADERS }}
              meta={{ title: playing.title }}
              features={{ kernelSwitch: true, rate: true }}
              /* 相册里的临时视频：没有可回放来源，不进观看历史 */
              recordHistory={false}
              onClose={() => setPlaying(null)}
            />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  tabsWrap: { paddingHorizontal: 16, paddingTop: 2 },
  tabsRow: { padding: 6, backgroundColor: 'transparent' },
  status: { marginTop: 6, fontSize: 12, textAlign: 'center' },
  list: { paddingHorizontal: 6, paddingTop: 8, paddingBottom: 96 },
  listWithBar: { paddingBottom: 150 },
  cell: { flex: 1, margin: 3, borderRadius: radii.sm, overflow: 'hidden', aspectRatio: 1 },
  photo: { width: '100%', height: '100%' },
  photoFallback: { alignItems: 'center', justifyContent: 'center' },
  videoBadge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 18,
    height: 52,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    justifyContent: 'space-between',
  },
  selectText: { ...typography.subhead, fontWeight: '600' },
  skeletonWrap: { paddingHorizontal: 6, paddingTop: 8 },
  skeletonRow: { flexDirection: 'row', marginBottom: 6 },
  skeletonCell: { flex: 1, margin: 3 },
});
