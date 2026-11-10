/**
 * 统一播放会话 · 官方「累计观看人次」（四场景共用）
 *
 * ⚠️【语义定版 · 用户 2026-11-01】本 hook 返回的**不是实时在线人数**。
 *
 * 官方 `getLiveOne.content.onlineNum`（列表页同名字段叫 `onlineUserNum`）实测是
 * **本场累计观看人次**，证据（2026-11-01 直接打接口，非推测）：
 *   - 直播中只增不减且增速恒定：同一场 20s 采样 1488 → 1496 → 1504 → 1521 → …
 *     （每 20s 稳定 +6~8，4 分钟内一次都没下降）；
 *   - 人数 ≈ 开播分钟 × 10~20：30+ 个在播场次里 7min/73、15min/348、145min/2103，
 *     人气场（60min/9639）同样线性 —— 实时在线不可能与开播时长严格成正比；
 *   - 结束后**冻结**：回放里仍是该场结束时的值（349 / 665，30s 后复采完全一致），
 *     若是「当前在线」结束时应归零。
 *
 * 所以：
 *   - 本 hook 只负责「累计」这一路（直播 30s 轮询 / 回放取一次定值 + 成员回放反查兜底）；
 *   - **实时在线**由云信聊天室提供（`useLiveBarrage().online`，原生 13/13 每 10s 一次），
 *     由 `MediaPlaybackHost` 合并成最终胶囊：有实时 → 「N 人在线」，否则 → 「累计 N 人看过」。
 *   - 任何情况下都**不能**把这里的数值标成「N 人在线」。
 *
 * 合并自两处旧实现（口径完全一致，只是兜底细节不同，现在统一为超集）：
 *   - MediaScreen 的 liveOnlineNum（直播轮询 + 回放一次）
 *   - 房间的 useRoomOnlineStat（多一层 findReplayLiveId 成员回放兜底 + liveIdFromUrl 兜底）
 *
 * ⚠️ 换场次先清零（防串台）：旧直播间的累计值不残留到新场次数据返回。
 */
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import pocketApi from '../../api/pocket48';
import { liveIdFromUrl } from '../../utils/data';
import { findReplayLiveId } from '../../components/MemberReplaySheet';

/** 官方 onlineNum = 该场累计观看人次（不是在线人数，见文件头） */
async function fetchAccumulatedViews(liveId: string): Promise<number> {
  try {
    const res: any = await pocketApi.getLiveOne(liveId);
    const c = res?.content || res?.data || {};
    return Number(c?.onlineNum || 0) || 0;
  } catch {
    return 0;
  }
}

export function usePlaybackOnlineStat({
  isLive,
  liveId,
  url,
  title,
  memberId,
}: {
  isLive: boolean;
  liveId: string;
  /** 当前播放地址（回放地址里常带 liveId，作为兜底） */
  url?: string;
  title?: string;
  /** 房间成员 id（回放兜底：成员回放列表反查 liveId） */
  memberId?: string | number;
}) {
  /** 本场累计观看人次（0 = 无数据） */
  const [accumulated, setAccumulated] = useState(0);
  const statLiveId = String(liveId || '') || liveIdFromUrl(String(url || ''));
  const memberKey = String(memberId || '');

  useEffect(() => {
    // ⚠️【串台修复】换直播/回放先清零：旧场次的数值不残留到新场次数据返回
    setAccumulated((prev) => (prev ? 0 : prev));
    if (!statLiveId) return undefined;
    let disposed = false;

    if (isLive) {
      const pull = () => {
        fetchAccumulatedViews(statLiveId).then((n) => { if (!disposed) setAccumulated(n); });
      };
      pull();
      const timer = setInterval(() => {
        if (AppState.currentState === 'active') pull();
      }, 30000);
      return () => { disposed = true; clearInterval(timer); };
    }

    // 回放：定值，取一次即可；查空用成员回放列表反查
    (async () => {
      const first = await fetchAccumulatedViews(statLiveId);
      if (disposed) return;
      if (first > 0) { setAccumulated(first); return; }
      if (!memberKey) { setAccumulated(0); return; }
      const matchId = await findReplayLiveId(memberKey, { url, title }).catch(() => '');
      if (disposed || !matchId) { if (!disposed) setAccumulated(0); return; }
      const second = await fetchAccumulatedViews(matchId);
      if (!disposed) setAccumulated(second);
    })();
    return () => { disposed = true; };
  }, [statLiveId, isLive, memberKey, url, title]);

  return accumulated;
}

export default usePlaybackOnlineStat;
