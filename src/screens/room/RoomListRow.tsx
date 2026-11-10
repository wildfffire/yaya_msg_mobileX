/**
 * 房间列表的一行（从 FollowedRoomsScreen 搬出的展示层 · 收尾第 3 步）。
 *
 * 与原实现逐字一致；两个依赖处理方式说明：
 *   · `FollowedRoom` 是页面文件里的局部类型 → 用 **import type**（编译期擦除，
 *     不会产生「组件 ↔ 页面文件」的运行时循环依赖）；
 *   · `LiveNowIndex` 已随第 3 步拆分移到 roomIdentity。
 */
import React, { useEffect } from 'react';
import { ActivityIndicator, Alert, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { ScalePressable } from '../../components/Motion';
import { useI18n } from '../../i18n';
import { usePalette } from '../../theme';
import { useSettingsStore } from '../../store';
import { ensureRoomListAvatar, useRoomListAvatarStore } from '../../services/roomListAvatar';
import type { Member } from '../../types';
import { messageText } from '../../utils/data';
import { AVATAR_THUMB_WIDTH, thumbUrl } from '../../utils/imageThumb';
import { avatarInitial } from './roomIdentity';
import { shortName } from './messageRules';
import { styles } from './roomStyles';
// 队伍名按直播列表口径渲染成应援色徽章（TEAM X → 绿底黑字 X）
import TeamBadge from '../../components/TeamBadge';
import type { FollowedRoom } from '../FollowedRoomsScreen';
// 未读分侧角标（用户 2026-09-30：数字显示在「大」/「小」房间的边上）
import { roomUnreadBadge, type RoomUnreadBadge } from '../../utils/roomUnreadRules';

/**
 * 队伍名 → 「Team 文字前缀 + 队色徽章」。
 * 用户 2026-11-09：房间列表要保留 Team 文字前缀，例如 `TEAM X` → `Team ` + 绿底黑字 `X`。
 * 成员库里的 team 可能是 'TEAM X' / 'SNH48 Team HII' / 'GNZ48' / '荣誉毕业生'；
 * 只有能提取出队伍字母的才做徽章，其余保留纯文本，避免中文队名被塞进灰底小方块。
 */
function toTeamBadge(raw: string): { prefix: string; badgeTeam: string } | null {
  const m = /^(.*?\s)?TEAM\s+([A-Za-z0-9]+)$/i.exec(String(raw || '').trim());
  if (!m) return null;
  const group = (m[1] || '').trim();
  return {
    prefix: group ? `${group} Team ` : 'Team ',
    badgeTeam: `TEAM ${m[2].toUpperCase()}`,
  };
}

/**
 * 房间列表的一行（封面 + 名字/状态点 + 大/小房间预览 + 置顶/关注按钮）。
 *
 * 与 RoomChatMessageRow 同一套纪律：
 *   主组件状态极多（未读轮询每 30s 就换一批引用），留在 renderItem 里会让**整屏行全部重画**。
 *   抽成 React.memo 后，只有 props 真的变了的行才重渲染。
 *
 * ⚠️ props 只传「值」或「稳定引用」：语言与主题由本组件自己订阅（useI18n / usePalette），
 *    不放进 props；未读也由父级算成 `bigCount/smallCount` 两个基本类型传进来
 *   （传 store 表会让每次未读写入都重渲染所有行）；回调由父级 useCallback 稳定。
 *
 * ⚠️ 不用 FadeInView 包裹（用户 2026-09-30 报「列表闪烁 / 莫名遮罩 / 房间全没了」）：
 *    长列表 + 30s 重排 + removeClippedSubviews 回收，与进场动画叠加就会出现整行短暂不可见。
 */
type RoomListRowProps = {
  /** 关注列表的一行数据（成员 + 大/小房间最新消息） */
  item: FollowedRoom;
  /**
   * 行状态一律**基本类型**（用户 2026-10-01 性能优化）。
   *
   * 以前这里传的是 followedIds / followBusy / pinned / liveNow / onMicMap 五个**容器**：
   * 直播状态每 30s 换一个新索引对象、上麦扫描写回也会换 onMicMap 引用 ——
   * React.memo 的浅比较必然不等 → **所有可见行全部重渲染**
   *（行内昵称正则、消息文本、四路索引查找都不便宜）。
   * 现在由父级 renderItem 统一算成布尔传入，只有真正状态变化的那几行才会重渲染。
   * ⚠️ 「直播中」的四路命中口径与未读判定一样必须唯一，别再搬回行内重算。
   */
  isFollowing: boolean;
  isBusy: boolean;
  isPinned: boolean;
  isLiveNow: boolean;
  isOnMic: boolean;
  /**
   * 该房间「大房间侧」的未读条数（唯一数据源 = roomUnreadCounts）。
   *
   * ⚠️ 由**父级算好**再以基本类型传入（不是传整张 store 表）：
   * 本行是 React.memo，只有传值类型才能让「未读没变」的行跳过重渲染；
   * 传 store 表会让任何一次未读写入都重渲染全部可见行（用户 2026-09-30 反馈的卡顿主因之一）。
   * 2026-11-10 起不再传「是否有新消息」布尔 —— 指纹/时间判据已退出角标，
   * 有数字就渲染角标，没数字就不渲染（含该侧行的显示条件）。
   */
  bigCount: number;
  /** 该房间「小房间侧」的未读条数（与大房间各自独立） */
  smallCount: number;
  onOpenRoom: (member: Member) => void;
  /** 点封面右上角的「直播中」角标 → 直接开播（看直播）；点封面/整行仍是进房间 */
  onOpenLive?: (member: Member) => void;
  onTogglePin: (memberId: string) => void;
  onToggleFollow: (member: Member) => void;
  /** 长按 → 交给拖拽列表开始拖动（用户要求 2026-09-28：长按拖动排序） */
  /** 正在被拖动：抬起视觉（放大 + 阴影 + 略透明） */
};

export const RoomListRow = React.memo(function RoomListRow({
  item,
  isFollowing,
  isBusy,
  isPinned,
  isLiveNow,
  isOnMic,
  bigCount,
  smallCount,
  onOpenRoom,
  onOpenLive,
  onTogglePin,
  onToggleFollow,
}: RoomListRowProps) {
  const { t } = useI18n();
  const palette = usePalette();
  /**
   * 房间外头像（设置页「房间外头像」，与房间内那套**不是同一张图**）：
   * - `official`（默认）：本地成员库的公式照
   * - `custom`：**偶像自己给房间设置的头像** —— `seine/server/detail` 的
   *   `chatServerInfo.serverIcon`（见 services/roomListAvatar），取不到才回退公式照
   *
   * ⚠️ 不要再用 `star/archives` 的 starInfo.avatar（那接口只有 starAvatar = 公式照），
   *    也不要从房间消息 `ext.user.avatar` 提取（那是房间内头像，用户 2026-11-09 明确）。
   */
  const listAvatarSource = useSettingsStore((s) => s.settings.room_list_avatar_source || 'official');
  const memberIdKey = String((item.member as any)?.id || item.memberId || '');
  const serverIdKey = String((item.member as any)?.serverId || '');
  const cachedAvatar = useRoomListAvatarStore((s) => s.map[memberIdKey]?.url || '');
  const officialAvatar = String(item.member?.avatar || '');

  useEffect(() => {
    useRoomListAvatarStore.getState().ensureHydrated();
  }, []);

  useEffect(() => {
    if (listAvatarSource !== 'custom' || !memberIdKey) return;
    // 缓存新鲜时同步返回（不闪图）；过期时先返回旧图并在后台刷新，刷新后由 store 订阅更新
    ensureRoomListAvatar(memberIdKey, serverIdKey).catch(() => {});
  }, [listAvatarSource, memberIdKey, serverIdKey]);

  const coverAvatar = listAvatarSource === 'custom'
    ? (cachedAvatar || officialAvatar)
    : (officialAvatar || cachedAvatar);
    const name = shortName(item.member, item.memberId);
    const team = item.member?.team || item.member?.groupName || '';
    const teamBadge = toTeamBadge(team);
    const lastText = item.lastMessage ? messageText(item.lastMessage) : '';
    /**
     * 未读展示（**分大/小房间两侧**，用户 2026-09-30 要求）：
     * 数字/「新」贴在该侧那一行的「大」/「小」标签旁边（房间名后面不再挂角标）。
     *
     * 值由父级算好传进来（`bigCount/smallCount`）：
     * 角标、上浮排序、tab 总数三处只认这一份 `roomUnreadCounts`，
     * 有数字就显示数字，没数字就不渲染 —— 不再有「先『新』后数字」的中间态。
     */
    const bigBadge = roomUnreadBadge(bigCount) as RoomUnreadBadge;
    const smallBadge = roomUnreadBadge(smallCount) as RoomUnreadBadge;
    return (
    /**
     * ⚠️ 这里刻意用**普通 View** 而不是 FadeInView（用户 2026-09-30 报列表闪烁/遮罩/房间消失）。
     * 房间列表是长列表 + 每 30s 重排的热点，进场动画一旦与虚拟列表的回收/重排叠加，
     * 就会出现「整行 0.x 秒不可见」（看起来像蒙了层遮罩、房间不见了）。
     * 动效留给真正需要的页面，列表行要的是稳定可见。
     */
    <View style={styles.roomRow}>
      {/* ⚠️ 逐卡禁止 GlassSurface（长列表滚动逐帧重算模糊 → 掉帧）。
          实底 surfaceGlassStrong + hairline，观感与玻璃卡一致但不进模糊管线。 */}
      <View style={[styles.roomRowCard, { backgroundColor: palette.surfaceGlassStrong, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
        <ScalePressable
          style={styles.roomRowMain}
          onPress={() => item.member && onOpenRoom(item.member)}
          /* 用户要求（2026-09-28）：长按不再弹选项菜单，改为**开始拖动排序**。
             200ms 比默认 500ms 短 —— 长按即进入拖动，手感更接近 iOS 列表重排。 */
          pressedScale={0.98}
          activeOpacity={0.9}
        >
          {/* 封面 56 圆角 12：直播中时挂「直播」角标。
              ⚠️ 点封面一律**进房间**（用户 2026-09-30 明确）：以前直播中点封面会跳到直播页，
              从直播页退出就留在直播页、回不到这位偶像的房间；现在统一进房间 ——
              房间内的播放器本来就能看她的直播（大/小房间切换、弹幕、礼物都在房间里）。 */}
          <TouchableOpacity
            activeOpacity={0.85}
            style={[styles.roomCover, { backgroundColor: palette.tintSoft, borderColor: palette.hairline }]}
            /* 点封面（头像）：**正在直播 → 进房间并自动开播她的直播**（用户 2026-09-30：
               「房间列表有直播的主播，点头像直接进直播，进的是房间里的那个直播」）；
               未直播 → 普通进房。注意：不进直播页（Media tab），始终留在房间里。
               整行其余区域（名字/消息预览）点击仍是普通进房，不自动播放。 */
            onPress={() => {
              if (!item.member) return;
              if (isLiveNow) { onOpenLive?.(item.member); return; }
              onOpenRoom(item.member);
            }}
          >
            {coverAvatar ? (
              <Image source={{ uri: thumbUrl(coverAvatar, AVATAR_THUMB_WIDTH) }} style={styles.roomCoverImg} />
            ) : (
              <Text style={[styles.roomCoverText, { color: palette.tint }]} numberOfLines={1}>{avatarInitial(name)}</Text>
            )}
            {isLiveNow ? (
              /**
               * 「正在直播」角标 = **直接进直播**的入口（用户 2026-09-30：「点头像进不了直播了」）。
               *
               * 背景：上一轮按要求把「点封面」改成了**一律进房间**（避免从直播页退出回不到她的房间），
               * 于是列表上就没有任何"看直播"的点了。这里把封面右上角的直播角标做成可点按钮：
               * 点角标 → 直接开播（进直播页播放这一场）；点封面/整行 → 仍进房间。
               * 两种意图各有一个入口，互不冲突。
               */
              <TouchableOpacity
                activeOpacity={0.85}
                style={[styles.coverLiveBadge, { backgroundColor: palette.tint }]}
                onPress={() => { if (item.member) onOpenLive?.(item.member); }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <MaterialCommunityIcons name="broadcast" size={9} color={palette.onTint} />
              </TouchableOpacity>
            ) : null}
          </TouchableOpacity>
          <View style={styles.roomInfo}>
            <View style={styles.roomNameRow}>
              <Text style={[styles.roomName, { color: palette.label }]} numberOfLines={1}>{name}</Text>
              {/* 状态点：绿色 = 正在直播（isLiveNow），灰色 = 未在播 */}
              <View style={[styles.statusDot, { backgroundColor: isLiveNow ? palette.success : palette.labelTertiary }]} />
              {isLiveNow ? (
                <View style={[styles.liveBadgeChip, { backgroundColor: palette.tint }]}>
                  <MaterialCommunityIcons name="broadcast" size={10} color={palette.onTint} />
                  <Text style={styles.liveBadgeChipText}>{t('直播中')}</Text>
                </View>
              ) : isOnMic ? (
                <View style={[styles.liveBadgeChip, { backgroundColor: palette.tint }]}>
                  <MaterialCommunityIcons name="microphone" size={10} color={palette.onTint} />
                  <Text style={styles.liveBadgeChipText}>{t('上麦中')}</Text>
                </View>
              ) : null}
              {isPinned ? (
                <View style={[styles.pinTagChip, { backgroundColor: palette.tintSoft }]}>
                  <MaterialCommunityIcons name="pin" size={10} color={palette.tint} />
                  <Text style={[styles.pinTagChipText, { color: palette.tint }]}>{t('置顶')}</Text>
                </View>
              ) : null}
              {/* 未读角标已按用户要求（2026-09-30）挪到下面「大」/「小」两行 —— 房间名后面只留状态 */}
            </View>
            {/* 房间列表信息区恢复原版布局：team 独立行 + 大房间预览 + 小房间预览（各一行）。
                卡片总高用 minHeight 拉齐：行少成员内容靠底部留白补足 */}
            {team ? (
              teamBadge ? (
                <View style={styles.roomTeamBadgeRow}>
                  <Text style={[styles.roomTeam, { color: palette.labelTertiary, marginTop: 0 }]} numberOfLines={1}>{teamBadge.prefix}</Text>
                  <TeamBadge team={teamBadge.badgeTeam} fontSize={10} compact />
                </View>
              ) : (
                <Text style={[styles.roomTeam, { color: palette.labelTertiary }]} numberOfLines={1}>{team}</Text>
              )
            ) : null}
            {/* 大房间行：「大」标签 + 该侧未读数字 + 大房间最新消息。
                ⚠️ 即使没有预览文本，只要该侧有未读数字就要渲染 —— 否则数字没地方放 */}
            {lastText || bigCount > 0 ? (
              <View style={styles.lastRow}>
                <View style={[styles.lastTag, { backgroundColor: palette.tintSoft }]}>
                  <Text style={[styles.lastTagText, { color: palette.tint }]}>{t('大')}</Text>
                </View>
                <SideUnreadBadge badge={bigBadge} />
                {lastText ? (
                  <Text style={[styles.roomLast, { color: palette.labelSecondary, marginTop: 0, flex: 1 }]} numberOfLines={1}>
                    {lastText}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {/* 小房间行：同上，未读数字贴在「小」标签旁（与大房间各自独立计数） */}
            {(() => {
              const sMsg = item.lastSmallMessage;
              const sText = sMsg ? messageText(sMsg) : '';
              const showText = !!sText && sText !== lastText;
              if (!showText && smallCount <= 0) return null;
              return (
                <View style={styles.lastRow}>
                  <View style={[styles.lastTag, { backgroundColor: palette.fill2 }]}>
                    <Text style={[styles.lastTagText, { color: palette.labelSecondary }]}>{t('小')}</Text>
                  </View>
                  <SideUnreadBadge badge={smallBadge} />
                  {showText ? (
                    // flex:1 + marginTop:0：与上一行（大房间）对齐，且多出一个数字角标后文本要能收缩换省略号
                    <Text style={[styles.roomLast, { color: palette.labelTertiary, marginTop: 0, flex: 1 }]} numberOfLines={1}>
                      {sText}
                    </Text>
                  ) : null}
                </View>
              );
            })()}
          </View>
        </ScalePressable>
        <View style={styles.roomActions}>
          <ScalePressable
            style={[styles.roomPinBtn, { backgroundColor: isPinned ? palette.tintSoft : palette.fill2 }]}
            onPress={() => onTogglePin(item.memberId)}
            pressedScale={0.9}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <MaterialCommunityIcons
              name={isPinned ? 'pin' : 'pin-outline'}
              size={15}
              color={isPinned ? palette.tint : palette.labelTertiary}
            />
          </ScalePressable>
          <ScalePressable
            style={[styles.roomFollowBtn, { backgroundColor: isFollowing ? palette.tintSoft : palette.fill2 }]}
            disabled={isBusy}
            pressedScale={0.9}
            activeOpacity={0.85}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            onPress={() => {
              if (isFollowing) {
                Alert.alert(
                  t('取消关注'),
                  t('确定不再关注 {name} 吗？', { name: shortName(item.member, item.memberId) }),
                  [
                    { text: t('保留'), style: 'cancel' },
                    { text: t('取消关注'), style: 'destructive', onPress: () => item.member && onToggleFollow(item.member) },
                  ],
                );
              } else if (item.member) {
                onToggleFollow(item.member);
              }
            }}
          >
            {isBusy ? (
              <ActivityIndicator color={palette.tint} size="small" />
            ) : (
              <MaterialCommunityIcons
                name={isFollowing ? 'heart' : 'heart-outline'}
                size={17}
                color={isFollowing ? palette.tint : palette.labelTertiary}
              />
            )}
          </ScalePressable>
        </View>
      </View>
    </View>
    );
});

/**
 * 分侧未读角标（用户 2026-09-30：数字显示在「大」/「小」房间的边上）。
 *
 * 几何与行内其它角标同一套视觉：粉色胶囊 + 白字；只显示数字（没有「新」这个中间态）。
 * 单独成组件的理由：大/小两行都要用，且它是这块唯一需要读主题色的小片，
 * 内联会让本来就很长的 renderItem JSX 再膨胀一截（这行是 memo 掉的重渲染热点）。
 */
function SideUnreadBadge({ badge }: { badge: RoomUnreadBadge }) {
  const palette = usePalette();
  if (badge.kind === 'none') return null;
  return (
    <View style={[styles.sideBadge, { backgroundColor: palette.tint }]}>
      <Text style={styles.sideBadgeText}>{badge.text}</Text>
    </View>
  );
}
