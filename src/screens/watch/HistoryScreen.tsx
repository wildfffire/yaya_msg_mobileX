/**
 * 「观看历史」页（用户 2026-09-30：历史记录 + 统计，统一入口放设置页）。
 *
 * 数据 = useWatchHistoryStore —— 记录点在 PlayerScreen 的 open() 收口处，
 * 所以任何入口（直播 / 回放 / 视频库 / 公演 / 房间）播过的内容都会自动进来，无需逐页埋点。
 *
 * 「统计」口径（三处，见 services/watchHistory.historyStats）：
 *   - 条数 = 去重后的内容数（列表长度）
 *   - 今天 = 今天看过的新内容数（按最近观看时间落今天算）
 *   - 累计播放 = 各条观看次数之和（同一条反复看只+1 条数、但次数会涨）
 */
import React, { useMemo } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useI18n } from '../../i18n';
import { useUiStore } from '../../store';
import { historyStats, useWatchHistoryStore } from '../../services/watchHistory';
import { formatTimestamp } from '../../utils/format';
import { MediaListPage, mediaKindLabel, type MediaListEntry } from './MediaListPage';
import { useEnrichMeta } from './useEnrichMeta';

export default function HistoryScreen() {
  const { t } = useI18n();
  /** ★ 页面不可见时停掉后台补全（见 useEnrichMeta.enabled 注释） */
  const isFocused = useIsFocused();
  const showToast = useUiStore((s) => s.showToast);
  const items = useWatchHistoryStore((s) => s.items);
  const remove = useWatchHistoryStore((s) => s.remove);
  const clear = useWatchHistoryStore((s) => s.clear);
  const patch = useWatchHistoryStore((s) => s.patch);
  // 升级前存下的条目没有成员/队伍：打开列表时后台补一次（见 useEnrichMeta）
  useEnrichMeta(
    useMemo(() => items.map((it) => ({
      key: it.key,
      owner: it.owner,
      team: it.team,
      ownerId: it.ownerId,
      title: it.title,
      duration: it.duration,
      liveId: it.liveId,
    })), [items]),
    patch,
    12,
    isFocused,
  );

  const entries = useMemo<MediaListEntry[]>(() => items.map((it) => ({
    key: it.key,
    title: it.title,
    cover: it.cover,
    // liveType=2（官方类型码：电台）也算音频形态，与 audio 布尔互补
    label: mediaKindLabel(it.ref?.kind, it.kind, it.audio || it.liveType === 2, t),
    meta: [
      formatTimestamp(it.at).slice(0, 16),
      it.count > 1 ? t('看过 {count} 次', { count: it.count }) : '',
    ].filter(Boolean).join(' · '),
    owner: it.owner,
    team: it.team,
    ownerId: it.ownerId,
    duration: it.duration,
    liveType: it.liveType,
    refKind: it.ref?.kind,
    refId: it.ref?.id,
    liveId: it.liveId,
    kind: it.kind,
  })), [items, t]);

  const stats = historyStats(items);
  const statsText = items.length
    ? t('共 {count} 条记录 · 今天 {today} 条 · 累计播放 {plays} 次', {
      count: stats.total,
      today: stats.today,
      plays: stats.plays,
    })
    : '';

  return (
    <MediaListPage
      title={t('观看历史')}
      statsText={statsText}
      entries={entries}
      emptyTitle={t('历史为空')}
      emptyHint={t('播放过的直播与回放会自动记录在这里')}
      onRemove={remove}
      clearLabel={t('清除历史')}
      onClear={() => {
        clear();
        showToast(t('已清除历史'));
      }}
    />
  );
}
