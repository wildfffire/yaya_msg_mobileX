/**
 * 房间列表「大/小各一条最新消息」的轻量快扫（用户 2026-11-13：预览有延迟）。
 *
 * 与 5s 通知轮询 / 30s 指纹计数 / 60s sweep **完全解耦**：
 *   · 只拉每侧 `/list/all` 最新一页（limit 20），只写 `useRoomPreviewTextStore`；
 *   · 不碰消息游标、未读计数、id 总账、通知、去重、排序；
 *   · 只在列表页前台可见时由页面驱动，每 5s 扫一片（15s 覆盖全部侧），
 *     首屏 / 回前台 / 下拉刷新走 force 全量一轮。
 *
 * 为什么不能只靠通知轮询：真机 logcat 里 `[room] 本轮 … 查详情=0` 连着 11 轮、
 * `查详情=20` 每 ~65s 才一次 —— `last/message/get` 的 msgContent 对回复消息恒为
 * 「[回复消息]」，指纹长期不变，于是详情正文最长要等 60s 才进列表。
 */
import pocketApi from '../api/pocket48';
import { messageText, unwrapList } from '../utils/data';
import { isOwnerMessageStrict } from '../screens/room/messageRules';
import {
  isCountableChatMessage,
  isDetailFromSide,
  messageId,
  messageTime,
  ROOM_DETAIL_LIST_KEYS,
} from '../utils/roomMessageCursor';
import { mapLimit } from '../utils/asyncPool';
import { logInfo } from '../utils/runtimeLog';
import {
  buildPreviewSides,
  pickPreviewMessage,
  PREVIEW_CHUNK_COUNT,
  previewSidesForRound,
  type PreviewSideTarget,
} from '../utils/roomPreviewRefreshRules';
import { useRoomPreviewTextStore } from './roomPreviewText';

const PREVIEW_PAGE_LIMIT = 20;
const PREVIEW_CONCURRENCY = 4;

let round = 0;
let inflight = false;
let lastDiagAt = 0;

/**
 * 刷新一「片」（或 force 全量）关注房间两侧的最新预览。
 * 返回实际发生变化的侧数；单侧失败静默跳过，不影响其它侧与任何计数链路。
 */
export async function refreshRoomListPreviews(
  rows: any[] | undefined | null,
  opts: { force?: boolean } = {},
): Promise<number> {
  if (inflight || !Array.isArray(rows) || !rows.length) return 0;
  const sides = buildPreviewSides(rows);
  if (!sides.length) return 0;
  const picked: PreviewSideTarget[] = opts.force
    ? sides
    : previewSidesForRound(sides, round, PREVIEW_CHUNK_COUNT);
  round += 1;
  inflight = true;
  const started = Date.now();
  let updated = 0;
  try {
    await mapLimit(picked, PREVIEW_CONCURRENCY, async (s) => {
      try {
        const res: any = await pocketApi.getRoomMessages({
          channelId: s.channelId,
          serverId: s.serverId,
          nextTime: 0,
          limit: PREVIEW_PAGE_LIMIT,
          fetchAll: true,
        });
        /**
         * 只认 `/list/all` 命中页：`owner-fallback` 页可能停在很久以前的房主发言，
         * 拿它当「最新一条」会把列表预览拽回过去（与 60s 详情预览同一条纪律）。
         */
        if (!String(res?._request?.label || '').startsWith('all')) return;
        // 小房间请求若被服务端回退到大房间频道，宁可这轮不写，也不能大小房间串味
        if (!isDetailFromSide(res?._request?.payload?.channelId, s.channelId)) return;
        const list = unwrapList(res, ROOM_DETAIL_LIST_KEYS);
        const hit = pickPreviewMessage(list, {
          isChat: isCountableChatMessage,
          isOwner: (m: any) => isOwnerMessageStrict(m, s.member),
          timeOf: messageTime,
          scanLimit: 80,
        });
        if (!hit) return;
        const text = String(messageText(hit) || '').trim();
        const store = useRoomPreviewTextStore.getState();
        const before = store.previewOf(s.id, s.side);
        // 空正文（纯图片/语音）也照写：store 会清掉该键回退到列表接口 msgContent
        store.setPreview(s.id, s.side, {
          text,
          msgId: messageId(hit),
          msgTime: messageTime(hit),
        });
        if (store.previewOf(s.id, s.side) !== before) updated += 1;
      } catch { /* 单侧失败不影响其它侧 */ }
    });
  } finally {
    inflight = false;
  }
  const now = Date.now();
  if (opts.force || now - lastDiagAt > 60_000) {
    lastDiagAt = now;
    logInfo(
      `[room] 列表预览快扫 本轮=${picked.length}/${sides.length} 更新=${updated}`
      + ` 耗时=${now - started}ms 强制=${opts.force ? 1 : 0}`,
      'room',
    );
  }
  return updated;
}
