/**
 * 房间页样式表（拆分第 5 步前置搬出）。
 *
 * 为什么单独成文件：第 5 步要把消息行抽成独立组件（RoomChatMessageRow），
 * 它用到约 45 处 styles.*。复制一份样式会让两份立刻开始漂移（改一处忘另一处 = 气泡变样），
 * 所以搬成共享模块：主文件与行组件 `import { styles }` 用的是同一份，
 * 而主文件里几百处 `styles.xxx` 一行都不用改。
 *
 * 内容由一次性 codemod 按行切片搬运（逐字一致），仅把 `const` 改为 `export const`。
 */
import { StyleSheet } from 'react-native';
import { radii, radiiAlias } from '../../theme';

export const styles = StyleSheet.create({
  // 直播弹幕面板（房间页内嵌直播时挂载）
  // 房间发言条（云信圈组）
  roomInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  roomInput: { flex: 1, minHeight: 36, maxHeight: 96, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, textAlignVertical: 'center', includeFontPadding: false },
  roomSendBtn: { height: 34, borderRadius: 18, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  roomSendBtnText: { fontSize: 13, fontWeight: '700' },
  roomSendHint: { fontSize: 11, marginHorizontal: 16, marginBottom: 4 },
  /**
   * 引用（回复）条：输入框上方那一条（用户 2026-10-14）。
   * 与发言条左右对齐（marginHorizontal 12），一条引用只占一行高度（原文 numberOfLines=1）。
   */
  roomReplyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  roomReplyBarAccent: { width: 3, alignSelf: 'stretch', borderRadius: 2 },
  roomReplyBarBody: { flex: 1, minWidth: 0 },
  roomReplyBarName: { fontSize: 12, fontWeight: '700' },
  roomReplyBarText: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  roomReplyBarClose: { padding: 2 },
  container: { flex: 1, backgroundColor: 'transparent' },
  /** 房间详情根容器：背景层与 padding 容器分离，保证背景满幅（见 return 处注释） */
  roomRoot: { flex: 1 },
  roomBgLayer: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  ellipseBubble: { paddingVertical: 9, paddingHorizontal: 14, maxWidth: '78%', marginVertical: 2 },
  ellipseText: { fontSize: 15, lineHeight: 21 },
  ellipseTime: { fontSize: 11, marginTop: 3, alignSelf: 'flex-end' },
  /**
   * 小字元信息（消息时间 HH:mm、日期分隔「今天」）的遮罩胶囊。
   * 底色不写死在这里 —— 由行内按主题给（见 labelMaskBg/Fg），浅深主题各一套。
   * 房间背景是用户自定义图，没有这层底这些小字会直接糊在花底上。
   */
  labelMaskPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  daySepText: { fontSize: 11, fontWeight: '600', alignSelf: 'center' },
  chatToolsClip: { marginHorizontal: 12, marginBottom: 8, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  chatTools: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 6, borderRadius: 18 },
  segment: {
    flexDirection: 'row',
    borderRadius: radii.pill,
    padding: 3,
    gap: 2,
  },
  segmentItem: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
  },
  segmentText: { fontSize: 12, fontWeight: '800' },
  chatToolCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: { flex: 1, padding: 10, borderRadius: radiiAlias.input, borderWidth: StyleSheet.hairlineWidth },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: radiiAlias.input,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  memberHitsListContent: { paddingHorizontal: 0, paddingBottom: 112 },
  memberHitBtnText: { fontSize: 13, fontWeight: '800' },
  memberHitsEmpty: { textAlign: 'center', marginTop: 40, fontSize: 14 },
  memberGridItem: { paddingVertical: 5 },
  // 搜索结果卡：横向一行（头像 + 名字/团队 + 关注按钮），左对齐。
  // 原竖排居中版把 2 列卡片撑到 ~210dp 高，一屏只能看到 3 行；横排后约 84dp。
  memberHitCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingLeft: 10,
    paddingRight: 12,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  memberHitAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  memberHitAvatarImg: { width: 56, height: 56, borderRadius: 28 },
  memberHitAvatarText: { fontSize: 20, fontWeight: '800' },
  // flex:1 + minWidth:0 → 长名字/长队名正常省略，不会把关注按钮挤出卡外
  memberHitMeta: { flex: 1, minWidth: 0 },
  memberHitName: { fontSize: 15, fontWeight: '700' },
  memberHitTeam: { fontSize: 12, marginTop: 3 },
  memberHitBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 62,
    borderWidth: StyleSheet.hairlineWidth,
  },
  memberAvatar: {
    width: 76,
    height: 76,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  memberAvatarText: { fontSize: 26, fontWeight: '800' },
  memberInfo: { alignSelf: 'stretch', marginTop: 12 },
  memberName: { fontSize: 17, fontWeight: '800', flexShrink: 1 },
  listContent: { paddingBottom: 112, paddingTop: 4 },
  /** 房间行卡：封面 56 圆角 12 + 房间名 + 状态点 + 直播中徽标 */
  roomRow: { paddingHorizontal: 16, marginBottom: 8 },
  roomRowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    // 等高：内容行数少(仅大消息/无小房间/无 team)的成员也拉到与多行成员一致高度
    minHeight: 112,
  },
  roomRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    // 内容垂直居中：行少成员(无小房间/无 team)不再堆顶部, 视觉上跟行多成员一样
    padding: 12,
  },
  roomCover: {
    width: 56,
    height: 56,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  roomCoverImg: { width: 56, height: 56, borderRadius: radii.md },
  roomCoverText: { fontSize: 22, fontWeight: '800' },
  /**
   * 头像（封面）上的「直播中」角标。
   * ⚠️ roomCover 带 overflow:'hidden'，角标必须贴在四角**内侧**（right/bottom: 0），
   * 用负偏移会被裁掉。
   */
  coverLiveBadge: {
    position: 'absolute', right: 0, bottom: 0,
    width: 20, height: 20, borderTopLeftRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  roomInfo: { flex: 1, minWidth: 0, marginLeft: 12 },
  roomNameRow: { flexDirection: 'row', alignItems: 'center' },
  roomName: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 6 },
  liveBadgeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  liveBadgeChipText: { color: '#FFFFFF', fontSize: 9, fontWeight: '800' },
  roomTeam: { fontSize: 11, marginTop: 3, fontWeight: '600' },
  /** 队伍徽章行：与直播列表 TeamBadge 同一套应援色（如 TEAM X 绿底黑字 X） */
  roomTeamBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  roomLast: { fontSize: 12, marginTop: 4, lineHeight: 16 },
  lastRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  lastTag: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 18,
    height: 16,
    borderRadius: 5,
    marginRight: 6,
    paddingHorizontal: 3,
  },
  lastTagText: { fontSize: 10, fontWeight: '800', lineHeight: 14 },
  pinTagChip: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    marginLeft: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
  },
  pinTagChipText: { fontSize: 9, fontWeight: '800' },
  roomActions: { marginLeft: 6, gap: 6, alignItems: 'center', paddingRight: 12, paddingVertical: 10 },
  /* 排序胶囊：单个圆角方块内竖向排列 ↑ / ↓ */
  roomPinBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  roomFollowBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  /** 房间内搜索无结果提示（覆盖消息区居中，不影响触摸） */
  roomSearchEmpty: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  roomSearchEmptyText: { fontSize: 13, fontWeight: '600' },
  /**
   * 消息加载失败浮层（与搜索空态同位置，覆盖消息区居中）。
   * ⚠️ 不加 pointerEvents:none —— 里面的「重试」要能点。
   * 只在**一条消息都没有**时显示（有消息时失败交给 15s 轮询/重试静默恢复，不打扰阅读）。
   */
  roomErrorWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 28,
  },
  roomErrorHint: { fontSize: 11, textAlign: 'center' },
  roomErrorRetry: { marginTop: 6, paddingHorizontal: 18, paddingVertical: 7, borderRadius: 999 },
  roomErrorRetryText: { fontSize: 12, fontWeight: '700' },
  /**
   * 「{days} 天内偶像无消息」顶部提示条（群聊视图专用，用户 2026-10-01）：
   * 胶囊样式、压在消息区顶部居中，pointerEvents=none（不吃触摸、不影响滚动）。
   * 底色由 JSX 按主题传 labelMaskBg（深色半透明黑 / 浅色半透明白），与其它元信息一致。
   */
  roomIdleBanner: {
    position: 'absolute', top: 6, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
  },
  roomIdleBannerText: { fontSize: 11, fontWeight: '600' },
  /**
   * 「有 N 条新消息」浮标（用户 2026-11-09）：悬浮在消息区底部居中，
   * 不挡输入栏（输入栏在消息区之外）；外层 wrap 只吃胶囊本身的触摸。
   */
  roomNewMsgWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 10,
    alignItems: 'center',
  },
  roomNewMsgPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    // 扁平化：浮标不再投影
  },
  roomNewMsgText: { fontSize: 11, fontWeight: '800' },
  /**
   * 「{days} 天内偶像无消息」居中提示的遮罩卡片（用户 2026-10-01：加遮罩 + 黑字）。
   * 提示压在房间背景图/视频帧上，纯文字在花底/亮底上会糊掉 ——
   * 给一层浅色半透明卡片（深色主题同样吃），文字固定深色（见 IDLE_CARD_FG）。
   */
  roomIdleCard: {
    alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingHorizontal: 24, paddingVertical: 18, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.86)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.06)',
  },
  followBtn: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: radiiAlias.button, alignItems: 'center', justifyContent: 'center', minWidth: 52, height: 26 },
  followBtnText: { fontSize: 11, fontWeight: '800' },
  // 消息发送者名字后面的队伍标签
  msgTeamChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, maxWidth: 128 },
  msgTeamLogo: { width: 11, height: 11, marginRight: 3 },
  msgTeamText: { fontSize: 10, fontWeight: '700' },
  chatRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 12, marginTop: 7, marginBottom: 2 },
  chatRowTight: { marginTop: 2, marginBottom: 1 },
  chatRowMine: { justifyContent: 'flex-end' },
  avatar: { width: 40, height: 40, borderRadius: 20, marginRight: 9 },
  /** 自己发言的头像（右侧）：间距由 wrapper 的 marginLeft 提供 */
  avatarMineWrap: { marginLeft: 9 },
  avatarMineImg: { marginRight: 0 },
  avatarPlaceholder: { width: 40, height: 40, marginRight: 9 },
  avatarFallback: { width: 40, height: 40, borderRadius: 20, marginRight: 9, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: '900', fontSize: 15 },
  msgBlock: { maxWidth: '78%', minWidth: 48 },
  msgBlockMine: { alignItems: 'flex-end' },
  replyCard: { marginBottom: 6, padding: 8, borderRadius: radii.sm, borderLeftWidth: 3, borderLeftColor: '#ff6f91' },
  replyName: { fontSize: 12, fontWeight: '700', marginBottom: 2 },
  replyText: { fontSize: 13, lineHeight: 18 },
  // 名字行不要水平内边距：否则名字比气泡左边缘缩进一截（截图中名字与气泡左对齐）
  msgMetaLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  msgMetaLineMine: { justifyContent: 'flex-end' },
  msgSender: { fontSize: 12, fontWeight: '600', maxWidth: 150 },
  msgTime: { fontSize: 10 },
  msgBubble: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 20 },
  msgBody: { fontSize: 15, lineHeight: 22 },
  msgBodyHighlight: {},
  giftCard: { marginTop: 8, minWidth: 210, padding: 10, borderRadius: radiiAlias.cardCompact, backgroundColor: 'rgba(255,240,246,0.88)', borderWidth: 1, borderColor: 'rgba(255,111,145,0.24)', flexDirection: 'row', alignItems: 'center', gap: 10 },
  giftCardCompact: { minWidth: 0, padding: 8, gap: 0 } as any,
  giftImage: { width: 34, height: 34, borderRadius: radii.xs, backgroundColor: '#fff' },
  giftImageFallback: { width: 34, height: 34, borderRadius: radii.xs, backgroundColor: '#ff6f91', alignItems: 'center', justifyContent: 'center' },
  giftTextWrap: { flex: 1, minWidth: 0 },
  giftName: { fontSize: 13, fontWeight: '800' },
  giftMeta: { marginTop: 3, fontSize: 11 },
  /**
   * 红包消息卡（用户 2026-11-09）：与礼物卡同一视觉重量，但用红金配色区分。
   * 文字固定深色 —— 卡片自带浅色底，深色主题下也读得清。
   */
  redPacketCard: {
    marginTop: 8, minWidth: 210, maxWidth: 240, padding: 10,
    borderRadius: radiiAlias.cardCompact,
    backgroundColor: 'rgba(255,244,240,0.94)',
    borderWidth: 1, borderColor: 'rgba(255,120,117,0.35)',
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  redPacketImage: { width: 34, height: 34, borderRadius: radii.xs, backgroundColor: '#fff' },
  redPacketImageFallback: { backgroundColor: '#ff7875', alignItems: 'center', justifyContent: 'center' },
  redPacketBody: { flex: 1, minWidth: 0 },
  redPacketTitle: { fontSize: 13, fontWeight: '800', color: 'rgba(20,20,22,0.92)' },
  redPacketMeta: { marginTop: 3, fontSize: 11, color: 'rgba(60,60,67,0.75)' },
  mediaCard: { marginTop: 8, minWidth: 214, padding: 10, borderRadius: radiiAlias.cardCompact, borderWidth: StyleSheet.hairlineWidth },
  liveCover: { width: '100%', height: 130, borderRadius: 10, marginBottom: 8, backgroundColor: 'rgba(128,128,128,0.1)' },
  liveCardWrap: { marginTop: 8, width: 228, borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.1)' },
  liveCardImg: { width: 228, height: 228, borderRadius: 14 },
  liveCardOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 36, alignItems: 'center', justifyContent: 'center' },
  videoCoverWrap: { marginTop: 8, width: '100%', maxWidth: 228, aspectRatio: 1, borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center' },
  videoCoverImg: { width: '100%', aspectRatio: 1, borderRadius: 14 },
  videoCoverOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  videoCoverDuration: { position: 'absolute', right: 8, bottom: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.5)' },
  videoCoverDurationText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  livePlayCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  liveCardTitleBar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: 'rgba(0,0,0,0.5)' },
  liveCardTitle: { color: '#fff', fontSize: 13, fontWeight: '700' },
  mediaMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mediaIcon: { fontSize: 12, fontWeight: '900' },
  mediaTitle: { flex: 1, fontSize: 13, fontWeight: '800', lineHeight: 18 },
  mediaDuration: { fontSize: 11, fontWeight: '700' },
  mediaPlayBtn: { marginTop: 9, minHeight: 38, paddingVertical: 9, borderRadius: radiiAlias.button, alignItems: 'center', justifyContent: 'center' },
  mediaPlayText: { fontSize: 13, fontWeight: '900' },
  inlineAudio: { height: 52, minWidth: 224, marginTop: 8 },
  // 内联视频已交给 <AdaptiveAspectVideo /> 处理真实宽高比，不再用固定 height/minWidth。
  // （保留 inlineImage / inlineSticker 等其它媒体类型的固定尺寸样式。）
  inlineImage: { width: '100%', maxWidth: 228, aspectRatio: 1, marginTop: 8, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.10)' },
  inlineSticker: { width: 120, height: 120, marginTop: 6, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.05)' },
  openLinkBtn: { marginTop: 8, padding: 8, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.10)', maxWidth: '100%', alignSelf: 'flex-start' },
  openLinkText: { color: '#ff6f91', fontSize: 11, fontWeight: '800' },
  roomPlayerPage: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 1000, elevation: 1000, backgroundColor: '#000' },
  liveResolveBtn: { paddingHorizontal: 26, paddingVertical: 10, borderRadius: 22 },
  liveResolveBtnText: { color: '#fff', fontSize: 14, fontWeight: '900' },
  liveResolveBtnGhost: { paddingHorizontal: 26, paddingVertical: 10, borderRadius: 22, borderWidth: 1 },
  liveResolveBtnGhostText: { color: 'rgba(255,255,255,0.9)', fontSize: 14, fontWeight: '800' },
  roomModalShade: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  /** 横屏：底板横排、面板贴右（与弹幕列表 / 弹幕设置同一套抽屉） */
  roomModalShadeLandscape: { flexDirection: 'row', justifyContent: 'flex-end' },
  /** 横屏：房间菜单列表收窄 + 允许收缩（同上） */
  /**
   * 分侧未读角标：贴在大/小房间那一行的「大」/「小」标签**旁边**（用户 2026-09-30 要求）。
   * 小圆角胶囊 + 白字，最多显示 99+（本地累计，见 utils/roomUnreadRules.ts 与 services/roomUnread.ts）。
   * 左侧不再留 margin：标签自带 marginRight 6，数字要紧跟标签（各留 6 会显得数字飘着）。
   */
  sideBadge: { minWidth: 18, height: 16, borderRadius: 8, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', marginRight: 6 },
  sideBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800', lineHeight: 13 },
  /** flexShrink:1 必须有：RN 默认 0，内容超高时面板不收缩 → 底部操作行被顶出屏幕（用户 2026-11-11 报「显示不全」） */
  roomRankPanel: { maxHeight: '88%', flexShrink: 1, paddingHorizontal: 14, paddingBottom: 14, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  /**
   * 横屏：底部抽屉可用高度 ≈ 400dp×82% ≈ 330dp，而内部滚动区固定 maxHeight 420/360，
   * RN 默认 flexShrink:0 → 内容从面板盒体溢出到屏幕外（「送出」按钮点不到）。
   * 放宽面板上限 + 内部滚动区收窄并允许收缩（见 roomRankListLandscape / roomMenuListLandscape）。
   */
  /**
   * 横屏：贡献榜贴右整列（用户 2026-11-09「横屏时也改为在右侧显示」）。
   * 只有左两角圆角 —— 右侧贴屏幕边缘。
   */
  roomRankPanelLandscape: {
    /** 高度按内容自适应（去掉 height:'100%'）：榜单只有几条时底部不再留一大片空白 */
    maxHeight: '100%', width: 420, maxWidth: '92%', flexShrink: 0,
    borderTopRightRadius: 0, borderBottomRightRadius: 0,
    borderBottomLeftRadius: 20,
  },
  // 用户资料卡（房间内点头像）
  /** 关闭区 · 上方：卡片上方的空白（flex:1 吃掉剩余空间）。卡片本身是普通 View，不参与手势竞争 */
  userCardDismiss: { flex: 1 },
  /**
   * 关闭区 · 下方：卡片底部的留白（点它同样关闭资料卡）。
   * 高度 28 既够点，又能把底部操作行从系统手势条/导航条上抬起来。
   */
  userCardDismissBottom: { height: 28 },
  userCardWrap: { width: '100%' },
  /**
   * 用户资料卡面板。
   * `marginHorizontal: 18`：两侧留白 —— 卡片不再全宽贴边（用户 2026-10-02 要求，
   * 后来嫌 12dp 局促，加到 1.5 倍 = 18dp）；圆角四角都露出来更像一张浮起来的卡；
   * 下方留白（userCardDismissBottom）仍横跨整宽，所以点卡片下方任意处都能关闭。
   *
   * ⚠️ 高度**不在这里**定：卡片高度由调用方按屏高算成数值（userCardHeight，接近满屏）传进来。
   */
  userCardPanel: { marginHorizontal: 18, padding: 14, paddingBottom: 18, borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet },
  /**
   * 资料卡内容区（头部 + 提示 + 成员档案）。
   * `flex: 1` = 吃满"卡片固定高度（JS 按屏高算）− 固定元素"的全部剩余空间：
   * 卡片高度确定 → 内容区高度确定 → 内容超出必定可滚（不会出现"拖不动"），
   * 底部操作行也始终固定在卡底。
   */
  userCardBody: { flex: 1 },
  /** 资料卡里的成员档案区：标题 + 可滚动内容（渲染实现见 components/MemberArchiveView） */
  userCardArchive: { marginTop: 12 },
  userCardArchiveTitle: { fontSize: 15, fontWeight: '800', marginBottom: 6 },
  userCardHead: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  userCardAvatar: { width: 64, height: 64, borderRadius: 32 },
  userCardTitleWrap: { flex: 1, marginLeft: 14 },
  userCardName: { fontSize: 19, fontWeight: '800' },
  userCardMeta: { marginTop: 5, fontSize: 12 },
  userCardStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  userCardNotice: { marginTop: 12, padding: 10, borderRadius: 12 },
  userCardTip: { fontSize: 13, lineHeight: 19 },
  userCardActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 14 },
  userCardBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  userCardBtnText: { fontSize: 13, fontWeight: '700' },
  roomRankHandleWrap: { alignItems: 'center', paddingTop: 2, paddingBottom: 10 },
  roomRankHandle: { width: 40, height: 5, borderRadius: 3 },
  roomRankHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  roomRankClose: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  roomRankTitle: { fontSize: 18, fontWeight: '900' },
  roomRankStatus: { fontSize: 12, marginBottom: 10 },
  roomRankList: { maxHeight: 420, flexShrink: 1 },
  /** 横屏：面板高度已定（100%），列表 flexGrow 吃满剩余空间 —— 固定 maxHeight 会只显示半屏 */
  roomRankListLandscape: { flexShrink: 1 },
  roomRankRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  roomRankNo: { width: 24, fontSize: 13, fontWeight: '900', textAlign: 'center' },
  roomRankAvatar: { width: 34, height: 34, borderRadius: 17 },
  roomRankInfo: { flex: 1, minWidth: 0 },
  roomRankName: { fontSize: 13, fontWeight: '800' },
  roomRankProgressTrack: { height: 4, borderRadius: 2, marginTop: 6, overflow: 'hidden' },
  roomRankProgressFill: { height: 4, borderRadius: 2 },
  roomRankValue: { fontSize: 11, fontWeight: '700', marginLeft: 6, flexShrink: 1 },
  /** 榜单加载态：转圈 + 文案一行（用户 2026-11-02：点开不能是一片空白） */
  roomRankLoadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10 },
  /** 骨架块（榜单行 / 礼物格共用） */
  skeletonBox: { borderRadius: 6 },
  skeletonLine: { height: 10, borderRadius: 5, width: '78%', marginTop: 2 },
  skeletonLineShort: { height: 8, borderRadius: 4, width: '42%', marginTop: 6 },
  roomRankEmpty: { textAlign: 'center', fontSize: 12, paddingVertical: 26 },
  /** 礼物面板：图片化宫格（借鉴上游 v2.7.6「礼物图片化展示」） */
  roomGiftGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 4 },
  roomGiftCell: { width: '31%', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 6, borderRadius: radiiAlias.cardCompact, borderWidth: 1 },
  roomGiftCellImg: { width: 52, height: 52 },
  roomGiftCellImgFallback: { alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  roomGiftCellName: { marginTop: 8, fontSize: 12, fontWeight: '800', maxWidth: '100%' },
  roomGiftCellCost: { marginTop: 2, fontSize: 11, fontWeight: '700' },
  roomGiftBalanceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  roomGiftLoadingCenter: { alignItems: 'center', justifyContent: 'center' },
  roomGiftFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  roomGiftStepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  empty: { textAlign: 'center', marginTop: 60, fontSize: 14, paddingHorizontal: 24, lineHeight: 20 },
  hiddenAudioVideo: { width: 1, height: 1, position: 'absolute', top: -9999, left: -9999, opacity: 0 },
});
