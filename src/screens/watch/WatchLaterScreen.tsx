/**
 * 「稍后再看」页（用户 2026-09-30：统一入口放设置页）。
 *
 * 数据 = useWatchLaterStore —— 三处收藏（官方视频库 / 公演回放 / 房间里的直播回放）的合集，
 * 列表与播放逻辑与「历史」共用 MediaListPage，差别只在数据源与空态文案。
 */
import React, { useCallback, useMemo } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useI18n } from '../../i18n';
import { useWatchLaterStore } from '../../services/watchLater';
import { formatTimestamp } from '../../utils/format';
import { MediaListPage, mediaKindLabel, type MediaListEntry } from './MediaListPage';
import { useEnrichMeta } from './useEnrichMeta';

export default function WatchLaterScreen() {
  const { t } = useI18n();
  /** ★ 页面不可见时停掉后台补全（见 useEnrichMeta.enabled 注释） */
  const isFocused = useIsFocused();
  const items = useWatchLaterStore((s) => s.items);
  const remove = useWatchLaterStore((s) => s.remove);
  const patch = useWatchLaterStore((s) => s.patch);
  // 升级前存下的条目没有成员/队伍：打开列表时后台补一次（见 useEnrichMeta）
  useEnrichMeta(
    useMemo(() => items.map((it) => ({
      key: it.key,
      owner: it.owner,
      team: it.team,
      ownerId: it.ownerId,
      title: it.title,
      duration: it.duration,
      // video 的 id 是 videoId（不是 liveId）：不能拿去查直播详情，改走视频详情接口补成员名
      // （以前直接传空跳过 → 官方视频库收藏**永远**补不到成员名/队伍，正是用户反馈
      //  「多个视频只有一个显示了成员名称和队伍」的那批条目）
      liveId: it.kind === 'video' ? '' : it.id,
      videoId: it.kind === 'video' ? it.id : '',
    })), [items]),
    patch,
    12,
    isFocused,
  );

  /**
   * 列表按「去重键」删除，而 store 的 remove 需要 (kind, id) ——
   * 这里做一次转换（key 就是 `${kind}:${id}`，但不要靠字符串反解，按 items 查更稳）。
   */
  const removeByKey = useCallback((key: string) => {
    const hit = items.find((it) => it.key === key);
    if (hit) remove(hit.kind, hit.id);
  }, [items, remove]);

  const entries = useMemo<MediaListEntry[]>(() => items.map((it) => ({
    key: it.key,
    title: it.title,
    cover: it.cover,
    // 收藏本身就带来源（video / openlive / replay）+ 是否音频（或官方类型码 2=电台），直接用来判类型标签
    label: mediaKindLabel(it.kind, undefined, it.audio || it.liveType === 2, t),
    meta: formatTimestamp(it.at).slice(0, 16),
    owner: it.owner,
    team: it.team,
    ownerId: it.ownerId,
    duration: it.duration,
    liveType: it.liveType,
    refKind: it.kind,
    refId: it.id,
  })), [items, t]);

  return (
    <MediaListPage
      title={t('稍后再看')}
      entries={entries}
      emptyTitle={t('稍后再看为空')}
      emptyHint={t('在列表里长按或点收藏即可加入')}
      onRemove={removeByKey}
    />
  );
}
