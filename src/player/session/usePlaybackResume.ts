/**
 * 统一播放会话 · 续播与进度落盘（四场景共用）
 *
 * 读（进入一场回放时）：
 *   ① services/replayProgress（**统一存储**：房间/历史/稍后再看都在写它，按 liveId）
 *   ② utils/resumePosition（旧 MediaScreen 用的那份，作为兼容兜底）
 *   ③ 太短（≤15s）不续播；距离结尾 <10s 不续播（从头看，房间原有优化）
 *
 * 写（播放中每 5s）：services/replayProgress —— 房间/历史/主直播页从此共用一份进度，
 *   在哪看过的回放，从其它入口点开都能续上（此前 MediaScreen 写自己的存储，两边互不认识）。
 */
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getReplayProgress, saveReplayProgress } from '../../services/replayProgress';
import { getResumePosition } from '../../utils/resumePosition';
import { formatDuration } from '../../utils/format';
import { useUiStore } from '../../store';
import { useI18n } from '../../i18n';
import { usePlayerStore } from '../store/playerStore';
import type { ResolvedMedia } from './types';

export function usePlaybackResume({
  resolved,
  /** 小窗回大窗等场景带入的初始位置（>0 时优先，不读存储） */
  initialPosition = 0,
  /** 续播成功时 toast 提示（房间现状；主直播页静默续播） */
  notice = false,
}: {
  resolved: ResolvedMedia | null;
  initialPosition?: number;
  notice?: boolean;
}) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  const [resumeAt, setResumeAt] = useState(0);

  const key = resolved && !resolved.isLive
    ? (String(resolved.liveId || '') || String(resolved.url || ''))
    : '';

  useEffect(() => {
    if (initialPosition > 0) {
      setResumeAt(initialPosition);
      return undefined;
    }
    if (!key) {
      setResumeAt(0);
      return undefined;
    }
    let alive = true;
    (async () => {
      let pos = 0;
      let dur = 0;
      try {
        const entry = await getReplayProgress(key);
        if (entry) {
          pos = Number(entry.position) || 0;
          dur = Number(entry.duration) || 0;
        }
        if (!(pos > 0)) {
          // 兼容旧存储（统一前只有 MediaScreen 写 resumePosition）
          pos = Number(await getResumePosition(key).catch(() => 0)) || 0;
        }
      } catch {
        pos = 0;
      }
      if (!alive) return;
      if (!(pos > 15)) { setResumeAt(0); return; }
      if (dur > 0 && pos >= dur - 10) { setResumeAt(0); return; }
      setResumeAt(pos);
      if (noticeRef.current) {
        try {
          useUiStore.getState().showToast(
            tRef.current('上次看到 {time}，已自动续播', { time: formatDuration(pos) }),
          );
        } catch { /* 提示失败不影响续播 */ }
      }
    })();
    return () => { alive = false; };
  }, [key, initialPosition]);

  // 进度落盘：播放中每 5s（只在统一播放器仍指向本条流时写，避免小窗/其它页面串台）
  useEffect(() => {
    if (!resolved || resolved.isLive) return undefined;
    const liveId = String(resolved.liveId || '') || String(resolved.url || '');
    const url = String(resolved.url || '');
    if (!liveId || !url) return undefined;
    const timer = setInterval(() => {
      // 后台不写：切后台时进度不会变，写了只是无谓 IO
      if (AppState.currentState !== 'active') return;
      try {
        const st = usePlayerStore.getState();
        if (st.source?.url !== url) return;
        const pos = Number(st.position) || 0;
        if (pos > 1) saveReplayProgress(liveId, pos, Number(st.duration) || 0);
      } catch { /* 落盘失败不影响播放 */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [resolved]);

  return resumeAt;
}

export default usePlaybackResume;
