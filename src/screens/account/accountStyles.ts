import { StyleSheet } from 'react-native';
import { radii, radiiAlias } from '../../theme';

/**
 * 账号中心版式（2026-11-11 整体重构）。
 *
 * 视觉语言沿用全站 iOS 26 扁平：卡片只由 GlassSurface 出底与 hairline 描边，
 * 本文件只管「尺寸 / 间距 / 字重」，不写 borderWidth / borderColor
 * （GlassSurface 已接管描边，再叠一层会双层描边错位）。
 */
export const accountStyles = StyleSheet.create({
  // ── 骨架 ─────────────────────────────────
  container: { flex: 1 },
  /** 窄屏单列：限宽 760 居中（旧版 maxWidth 560 在平板上两侧全空） */
  content: { paddingHorizontal: 16, paddingBottom: 40, width: '100%', maxWidth: 760, alignSelf: 'center' },
  wideRow: { flex: 1, flexDirection: 'row' },
  /** 宽屏左栏：身份 + 分区导航，独立滚动 */
  rail: { width: 300 },
  railContent: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24 },
  /** 宽屏右栏：当前分区，限宽 760 居中避免被拉成长条 */
  paneContent: { paddingHorizontal: 24, paddingTop: 4, paddingBottom: 40, width: '100%', maxWidth: 760, alignSelf: 'center' },

  /** 页面头部右侧图标按钮（刷新账号信息） */
  headerIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },

  // ── Hero 身份横幅 ─────────────────────────
  hero: { padding: 18, borderRadius: radii.lg, overflow: 'hidden' },
  heroTop: { alignItems: 'center' },
  heroAvatarBtn: { position: 'relative' },
  heroAvatar: { width: 72, height: 72, borderRadius: 36 },
  heroAvatarFallback: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  /** 头像右下角的铅笔角标：提示「点头像可编辑」 */
  heroPen: {
    position: 'absolute', right: -3, bottom: -3,
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#FFFFFF',
  },
  heroNameBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, paddingHorizontal: 6, paddingVertical: 2 },
  heroName: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, flexShrink: 1 },
  heroSub: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  heroId: { fontSize: 12.5 },
  heroBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radii.pill },
  heroBadgeText: { fontSize: 10.5, fontWeight: '800' },
  heroStatus: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  heroDot: { width: 7, height: 7, borderRadius: 4 },
  heroStatusText: { fontSize: 12 },
  heroActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, alignSelf: 'stretch' },
  heroMetrics: { flexDirection: 'row', marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  metric: { flex: 1 },
  metricSecond: { borderLeftWidth: StyleSheet.hairlineWidth, paddingLeft: 14 },
  metricNum: { fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  metricLabel: { fontSize: 11, marginTop: 2 },

  // ── 分区导航（仅宽屏） ─────────────────────
  nav: { marginTop: 18 },
  navTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4, paddingHorizontal: 10, paddingBottom: 8 },
  navItem: {
    position: 'relative', flexDirection: 'row', alignItems: 'center', gap: 10,
    height: 46, paddingHorizontal: 12, borderRadius: 12,
  },
  navBar: { position: 'absolute', left: 0, top: 13, bottom: 13, width: 3, borderRadius: 2 },
  navLabel: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '600' },
  navCount: { fontSize: 11, fontWeight: '700' },
  railFoot: { marginTop: 'auto', paddingTop: 18, paddingHorizontal: 10, fontSize: 11, lineHeight: 17 },

  // ── 分组 ─────────────────────────────────
  group: { marginTop: 24 },
  groupFirst: { marginTop: 0 },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 4, paddingBottom: 8 },
  groupTitle: { fontSize: 14, fontWeight: '700' },
  groupNote: { marginTop: 8, paddingHorizontal: 4, fontSize: 11.5, lineHeight: 17 },
  card: { borderRadius: radii.lg, overflow: 'hidden' },

  // ── 行 ───────────────────────────────────
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: 58 },
  rowDivider: { position: 'absolute', left: 56, right: 16, top: 0, borderTopWidth: StyleSheet.hairlineWidth },
  rowIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 15, fontWeight: '600', letterSpacing: -0.1 },
  rowSub: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  rowValue: { fontSize: 13, maxWidth: '55%', textAlign: 'right' },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },

  // ── 状态提示条 ────────────────────────────
  status: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginHorizontal: 16, marginTop: 12, marginBottom: 14, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12 },
  statusText: { flex: 1, fontSize: 12, lineHeight: 18 },

  // ── 账号切换网格 ──────────────────────────
  accGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16 },
  accCard: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12, borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth },
  accMain: { flex: 1, minWidth: 0 },
  accNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  accName: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  accRole: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: radii.pill },
  accRoleText: { fontSize: 10, fontWeight: '800' },
  accId: { fontSize: 11.5, marginTop: 3 },
  accCur: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  accCurText: { fontSize: 12, fontWeight: '700' },
  accAvatar: { width: 40, height: 40, borderRadius: 20 },
  accAvatarFallback: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  emptyRow: { paddingHorizontal: 16, paddingVertical: 18 },
  emptyText: { fontSize: 12.5, lineHeight: 19 },

  // ── 鸡腿余额块 ────────────────────────────
  amountBox: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  amountLabel: { fontSize: 12 },
  amountRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 4 },
  amountNum: { fontSize: 34, fontWeight: '800', letterSpacing: -1.2 },
  amountUnit: { fontSize: 13 },
  amountActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },

  // ── B站二维码 ─────────────────────────────
  qrWrap: { alignItems: 'center', paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16 },
  qrCard: { width: 176, height: 176, borderRadius: 18, backgroundColor: '#FFFFFF', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  qr: { width: 156, height: 156 },
  qrPlaceholder: { width: 176, height: 176, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  qrEmptyBtn: { marginBottom: 16, alignSelf: 'center' },

  // ── 编辑资料弹窗 ──────────────────────────
  modalMask: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, backgroundColor: 'rgba(10,10,14,0.42)' },
  sheet: { width: '100%', maxWidth: 360, borderRadius: radii.sheet, padding: 18, overflow: 'hidden' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  sheetTitle: { fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  sheetClose: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  editAvatarRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18 },
  editAvatar: { width: 72, height: 72, borderRadius: 36 },
  editAvatarFallback: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  editAvatarMain: { flex: 1, minWidth: 0 },
  fieldLabel: { fontSize: 12, marginBottom: 6 },
  input: {
    height: 42, paddingHorizontal: 12, borderRadius: radiiAlias.input,
    fontSize: 14, borderWidth: StyleSheet.hairlineWidth,
  },
  fieldHint: { fontSize: 11.5, lineHeight: 17, marginTop: 8 },
  sheetFoot: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20 },
  sheetBtn: { flex: 1 },

  // ── 未登录：品牌 + 表单 ───────────────────
  loginWide: { flexGrow: 1, flexDirection: 'row', paddingHorizontal: 24, paddingTop: 4, paddingBottom: 40, gap: 24, alignItems: 'flex-start', justifyContent: 'center' },
  loginBrandRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  loginBrandLogoSm: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  loginBrandTitle: { fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  loginBrandSub: { fontSize: 12, lineHeight: 18, marginTop: 2 },
  brandCol: { width: 300, maxWidth: 340, flex: 1 },
  brandCard: { padding: 20, borderRadius: radii.lg, overflow: 'hidden' },
  brandLogo: { width: 64, height: 64, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  brandName: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3, marginTop: 14 },
  brandDesc: { fontSize: 13, lineHeight: 21, marginTop: 8 },
  benefitRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 12 },
  benefitText: { flex: 1, fontSize: 12.5, lineHeight: 19 },
  formCol: { flex: 1, maxWidth: 460 },
  segment: { marginBottom: 12 },
  loginCard: { padding: 16, borderRadius: radii.lg, overflow: 'hidden' },
  cardTitle: { fontSize: 16, fontWeight: '800', marginBottom: 12 },
  field: {
    height: 42, paddingHorizontal: 12, borderRadius: radiiAlias.input,
    marginBottom: 10, fontSize: 14, borderWidth: StyleSheet.hairlineWidth,
  },
  tokenInput: { minHeight: 46, textAlignVertical: 'center', paddingVertical: 8 },
  btnCol: { gap: 10, marginTop: 4 },
  btnRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  phoneRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  areaWrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginBottom: 10 },
  areaPlus: { fontWeight: '700', fontSize: 15, marginRight: 2 },
  areaInput: { minWidth: 44, paddingVertical: 12, paddingHorizontal: 0, fontSize: 14 },
  phoneInput: { flex: 1 },
  verifyBox: { padding: 12, borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, marginBottom: 10 },
  verifyQuestion: { fontSize: 13, fontWeight: '700', marginBottom: 8 },
  verifyOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  verifyOption: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radii.pill, borderWidth: StyleSheet.hairlineWidth },
  verifyOptionText: { fontSize: 13, fontWeight: '600' },
  qrRetry: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8, paddingVertical: 8 },
  qrRetryText: { fontSize: 13, fontWeight: '700' },
  tokenInfo: { fontSize: 12, lineHeight: 18, marginTop: 12 },
  loginStatus: { marginTop: 10 },
});
