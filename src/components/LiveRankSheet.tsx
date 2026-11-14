/**
 * 直播间贡献榜（直播页 / 房间内直播与回放**共用同一个面板**）。
 *
 * 用户 2026-11-13 定版：**以直播页那版为准**（房间以前自己写了一份，少了资料补全）。
 *   · 面板：黑白实心抽屉（rgba(18,18,20,0.97)），横屏贴右 width 420；
 *   · 数据：接口只回「用户 N」/空头像时，用 userId 查 user/info 补昵称与头像；
 *   · 行：名次（前 3 白 0.95，其余 0.5）+ 头像 + 昵称 + 「贡献 X」+ 右侧箭头（点开资料卡）。
 * 房间侧不要再写第二份 —— 以前就是这么分叉的。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { Image } from 'react-native';
import { DarkSheetHandle, DarkSheetHeader } from './DarkSheetHeader';
import { useI18n } from '../i18n';
import { useIsLandscape } from '../hooks/useIsLandscape';
import pocketApi from '../api/pocket48';
import { errorMessage } from '../utils/data';
import { mapLimit } from '../utils/asyncPool';
import {
  needsRankProfile,
  normalizeLiveRank,
  profileFromUserRes,
  type LiveRankRow,
} from '../utils/liveRank';

export interface LiveRankProfileTarget {
  userId?: string;
  name: string;
  avatar?: string;
}

interface Props {
  visible: boolean;
  /** 本场直播 id：为空时显示 missingLiveIdHint，不发请求 */
  liveId: string;
  onClose: () => void;
  /** 点某一行 → 资料卡（直播页传 UserProfileSheet，房间传房间内资料卡） */
  onOpenProfile?: (target: LiveRankProfileTarget) => void;
  /** 拿不到 liveId 时的提示文案（两个场景描述不同） */
  missingLiveIdHint?: string;
}

/** 补资料并发上限：榜单可能有几十人，一次性全打出去容易触发风控 */
const PROFILE_CONCURRENCY = 4;

export function LiveRankSheet({
  visible,
  liveId,
  onClose,
  onOpenProfile,
  missingLiveIdHint,
}: Props) {
  const { t } = useI18n();
  const isLandscape = useIsLandscape();
  const [rows, setRows] = useState<LiveRankRow[]>([]);
  const [status, setStatus] = useState('');
  /** 请求代次：换场次 / 关闭后回来的旧响应一律丢弃（否则串台） */
  const seqRef = useRef(0);

  /**
   * 打开即拉取（与直播页旧行为一致）。
   * 每次打开都先清空上一场的名单 —— 避免新请求返回前显示上一场的贡献榜。
   */
  useEffect(() => {
    if (!visible) return undefined;
    const seq = ++seqRef.current;
    let alive = true;
    const guard = () => alive && seq === seqRef.current;
    setRows([]);
    setStatus('');

    const id = String(liveId || '');
    if (!id) {
      setStatus(missingLiveIdHint || t('当前直播缺少 liveId，不能获取贡献榜'));
      return () => { alive = false; };
    }

    (async () => {
      try {
        const res = await pocketApi.getLiveRank(id);
        if (!guard()) return;
        const list = normalizeLiveRank(res);
        setRows(list);
        if (!list.length) {
          setStatus(t('贡献榜为空'));
          return;
        }
        /** 接口常只回「用户 N」+ 空头像：按 userId 走 user/info 补昵称与头像（直播页口径） */
        const needs = list.map((row, index) => needsRankProfile(row, index));
        if (needs.some(Boolean)) {
          setStatus(t('正在补充 {count} 位贡献用户资料...', { count: list.length }));
          const enriched = await mapLimit(
            list.map((row, index) => ({ row, index })),
            PROFILE_CONCURRENCY,
            async ({ row, index }) => {
              if (!needs[index]) return row;
              try {
                const profile = profileFromUserRes(await pocketApi.getUserProfile(String(row.userId)));
                return { ...row, name: profile.name || row.name, avatar: profile.avatar || row.avatar };
              } catch {
                return row;
              }
            },
          );
          if (!guard()) return;
          setRows(enriched);
          setStatus(enriched.length ? t('已加载 {count} 位贡献用户', { count: enriched.length }) : t('贡献榜为空'));
          return;
        }
        setStatus(t('已加载 {count} 位贡献用户', { count: list.length }));
      } catch (err) {
        if (!guard()) return;
        setRows([]);
        setStatus(t('贡献榜加载失败：{error}', { error: errorMessage(err) }));
      }
    })();

    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, liveId]);

  const handleRowPress = useCallback((row: LiveRankRow) => {
    if (!onOpenProfile) return;
    onClose();
    onOpenProfile({
      userId: row.userId ? String(row.userId) : undefined,
      name: String(row.name || ''),
      avatar: String(row.avatar || ''),
    });
  }, [onOpenProfile, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* 横屏贴右 + 实心黑底（与弹幕列表同风格） */}
      <View style={[styles.shade, isLandscape ? styles.shadeLandscape : null]}>
        {/* 点左侧画面关闭：独立兄弟节点、排在面板之前（包住面板会与内部 ScrollView 抢手势） */}
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.panel, isLandscape ? styles.panelLandscape : null]}>
          <DarkSheetHandle show={!isLandscape} />
          <DarkSheetHeader
            icon="trophy-outline"
            title={t('贡献榜')}
            meta={rows.length ? t('{n} 人', { n: rows.length }) : undefined}
            onClose={onClose}
          />
          {status ? (
            <Text style={styles.status} numberOfLines={1}>{status}</Text>
          ) : null}
          <ScrollView
            style={[styles.list, isLandscape ? styles.listLandscape : null]}
            showsVerticalScrollIndicator={false}
          >
            {rows.map((row, index) => (
              <TouchableOpacity
                key={String(row.userId || row.id || index)}
                style={styles.row}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={row.name}
                onPress={() => handleRowPress(row)}
              >
                {/* 黑白榜：名次不用主题色，前三名白 0.95、其余白 0.5 */}
                <Text style={[styles.no, { color: index < 3 ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)' }]}>
                  {row.rank || index + 1}
                </Text>
                {row.avatar
                  ? <Image source={{ uri: row.avatar }} style={styles.avatar} />
                  : <View style={styles.avatar} />}
                <View style={styles.info}>
                  <Text style={styles.name} numberOfLines={1}>{row.name}</Text>
                  <Text style={styles.value} numberOfLines={1}>
                    {row.value ? t('贡献 {value}', { value: row.value }) : t('贡献用户')}
                  </Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={18} color="rgba(255,255,255,0.4)" />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  shade: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  /** 横屏：底板横排、面板贴右 */
  shadeLandscape: { flexDirection: 'row', justifyContent: 'flex-end' },
  /**
   * 面板必须 `flexShrink: 1`：RN 默认 0，内容超高时不会收缩，
   * 底部内容会被顶出屏幕（横屏尤其明显）。
   */
  panel: {
    maxHeight: '88%',
    flexShrink: 1,
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: 'rgba(18,18,20,0.97)',
  },
  panelLandscape: {
    maxHeight: '100%',
    width: 420,
    maxWidth: '92%',
    flexShrink: 0,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomLeftRadius: 20,
  },
  status: { fontSize: 12, marginBottom: 10, color: 'rgba(255,255,255,0.55)' },
  list: { maxHeight: 430, flexShrink: 1 },
  /** 横屏：与礼物宫格同一口径 —— 榜单吃满剩余高度 */
  listLandscape: { flexGrow: 1, flexShrink: 1, maxHeight: '100%' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)' },
  no: { width: 32, fontSize: 15, fontWeight: '900' },
  avatar: { width: 38, height: 38, borderRadius: 20, marginRight: 10, backgroundColor: 'rgba(255,255,255,0.12)' },
  info: { flex: 1 },
  name: { fontSize: 14, fontWeight: '800', color: 'rgba(255,255,255,0.94)' },
  value: { fontSize: 11, marginTop: 2, color: 'rgba(255,255,255,0.6)' },
});

export default LiveRankSheet;
