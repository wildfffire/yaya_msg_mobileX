import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings, Member } from '../types';
import { APP_BUILD, APP_VERSION, UPDATE_DOWNLOAD_URL } from '../constants';
import { DEFAULT_SETTINGS } from '../services/settings';
import { evaluateUpdate, parseReleaseTag } from '../utils/updateRules';

interface SettingsState {
  settings: AppSettings;
  setSettings: (patch: Partial<AppSettings>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  setSettings: (patch) =>
    set((state) => ({ settings: { ...state.settings, ...patch } })),
}));

interface MemberState {
  members: Member[];
  membersLoaded: boolean;
  setMembers: (members: Member[]) => void;
  updateMemberRoomIds: (channelId: string, patch: Partial<Pick<Member, 'serverId' | 'channelId' | 'yklzId'>>) => void;
  /** 按 userId 回写房间映射（seine 解析结果），供 roomMapCache 使用 */
  patchMemberByUserId: (memberId: string, patch: Partial<Pick<Member, 'serverId' | 'channelId' | 'yklzId' | 'roomId' | 'liveRoomId'>>) => void;
}

export const useMemberStore = create<MemberState>((set) => ({
  members: [],
  membersLoaded: false,
  setMembers: (members) => set({ members, membersLoaded: true }),
  updateMemberRoomIds: (channelId, patch) =>
    set((state) => ({
      members: state.members.map((member) =>
        String(member.channelId) === String(channelId) ? { ...member, ...patch } : member,
      ),
    })),
  patchMemberByUserId: (memberId, patch) =>
    set((state) => ({
      members: state.members.map((member) =>
        String(member.id) === String(memberId) ? { ...member, ...patch } : member,
      ),
    })),
}));

interface UiState {
  tabBarHidden: boolean;
  toastMessage: string;
  /**
   * 当前屏幕的「玻璃折射背景」：房间页打开时挂成员房间的背景图（+遮罩色），
   * 让房间里的玻璃折射房间背景而不是全局软件背景；离开屏幕清 null 还原全局。
   */
  screenBackdrop: { uri: string; scrim: string } | null;
  /**
   * 底部 Tab「左右横划切页」的锁定计数（>0 即禁用）。
   *
   * 为什么用**计数**而不是布尔：锁的来源可能重叠（例：房间内且播放器已开 → 两个来源同时锁），
   * 布尔会被其中一个先解锁而误放行。零散场景下计数最省心。
   * 需要锁的场景：
   *   - 进了某个成员的房间（房间页内容会横向手势）
   *   - 打开了统一播放器（进度条拖动是横向的，48px 阈值会被误判成切页）
   */
  tabSwipeLockCount: number;
  tabSwipeLocked: boolean;
  lockTabSwipe: () => void;
  unlockTabSwipe: () => void;
  setTabBarHidden: (hidden: boolean) => void;
  /**
   * 「滚动收起」状态：四个主页面**向上滚动**时，顶栏与底栏一起收起，向下滚回时再出现。
   *
   * 为什么必须与 tabBarHidden 分开：
   *   - `tabBarHidden` 由**导航**驱动（进二级页 / 进房间 / 开始播放时隐藏），生命周期跟着页面焦点；
   *   - 这一个只由**滚动方向**驱动，且离开页面必须复位。
   *   底栏最终可见性 = 两者取「或」。混进同一个布尔会互相覆盖：滚动向下滚回时
   *   会把「进房才该隐藏」的状态一起清掉。
   */
  chromeHiddenByScroll: boolean;
  setChromeHiddenByScroll: (hidden: boolean) => void;
  showToast: (message: string) => void;
  hideToast: () => void;
  setScreenBackdrop: (v: { uri: string; scrim: string } | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  tabBarHidden: false,
  toastMessage: '',
  screenBackdrop: null,
  tabSwipeLockCount: 0,
  tabSwipeLocked: false,
  lockTabSwipe: () => set((s) => {
    const next = s.tabSwipeLockCount + 1;
    return { tabSwipeLockCount: next, tabSwipeLocked: next > 0 };
  }),
  unlockTabSwipe: () => set((s) => {
    const next = Math.max(0, s.tabSwipeLockCount - 1);
    return { tabSwipeLockCount: next, tabSwipeLocked: next > 0 };
  }),
  setTabBarHidden: (hidden) => set({ tabBarHidden: hidden }),
  // 相同值直接返回原 state（不触发订阅者重渲染）——滚动事件很密集，这里必须去抖
  chromeHiddenByScroll: false,
  setChromeHiddenByScroll: (hidden) =>
    set((s) => (s.chromeHiddenByScroll === hidden ? s : { chromeHiddenByScroll: hidden })),
  showToast: (message) => set({ toastMessage: message }),
  hideToast: () => set({ toastMessage: '' }),
  setScreenBackdrop: (v) => set({ screenBackdrop: v }),
}));

// --- v2.6: Announcement store ---

const ANNOUNCEMENT_SEEN_KEY = 'yaya_announcement_seen';

interface AnnouncementState {
  seenIds: string[];
  lastFetched: number;
  hydrated: boolean;
  markSeen: (id: string) => void;
  setLastFetched: (ts: number) => void;
}

export const useAnnouncementStore = create<AnnouncementState>((set) => ({
  seenIds: [],
  lastFetched: 0,
  hydrated: false,
  markSeen: (id) =>
    set((state) => {
      if (state.seenIds.includes(id)) return {};
      const next = [...state.seenIds, id];
      AsyncStorage.setItem(ANNOUNCEMENT_SEEN_KEY, JSON.stringify(next)).catch(() => {});
      return { seenIds: next };
    }),
  setLastFetched: (ts) => set({ lastFetched: ts }),
}));

// Persist seen announcement ids so the modal doesn't re-pop on every cold launch.
AsyncStorage.getItem(ANNOUNCEMENT_SEEN_KEY)
  .then((raw) => {
    const ids: string[] = raw ? JSON.parse(raw) : [];
    if (Array.isArray(ids) && ids.length) {
      useAnnouncementStore.setState({ seenIds: ids });
    }
  })
  .catch(() => {})
  .finally(() => {
    useAnnouncementStore.setState({ hydrated: true });
  });

// --- 版本更新检测 ---

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/wildfffire/yaya_msg_mobileX/releases/latest';
// 降级源：GitHub release 页面 HTML（无 API 匿名限流；共享出口 IP 触发 403 时自动切换）
const GITHUB_RELEASES_PAGE = 'https://github.com/wildfffire/yaya_msg_mobileX/releases/latest';
// 更新跳转链接：统一指向用户自建下载页（见 constants 的 UPDATE_DOWNLOAD_URL）
const UPDATE_TIMEOUT = 8000;
/**
 * 检查结果持久化，6h 内不重复打 GitHub API（未认证限流 60/h，冷启全打会快速耗尽）。
 * ★ 2026-11-19：24h → 6h。发版后最长 6h 内（而不是隔一天）所有用户都能被提示到；
 *   页面降级源不受 API 限流，缓存只是为了省流量与请求量。
 */
const UPDATE_LAST_CHECK_KEY = 'yaya_update_last_check';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
/** release 正文（更新说明）截断长度：弹窗里只展示摘要，避免整篇 changelog 撑爆界面 */
const UPDATE_NOTES_MAX = 600;

/** 兼容旧调用：candidate 是否比 current 新（只比语义版本） */
export function isNewerVersion(candidate: string, current: string): boolean {
  return evaluateUpdate(candidate, current, 0).hasUpdate;
}

interface UpdateState {
  /** 是否有可用更新（本地构建号/版本低于 GitHub 最新 Release） */
  hasUpdate: boolean;
  /** 最新版本文案（`v3.0.0 · Build 3000075`），无更新时为空 */
  latestVersion: string;
  /** 最新 release 原始 tag（如 v3.0.0-b3000075），去重/日志用 */
  latestTag: string;
  /** 最新 release 构建号（0 = tag 里没有构建号） */
  latestBuild: number;
  /** release 正文摘要（GitHub API 才有；页面降级源为空） */
  latestNotes: string;
  /** 新版本下载地址（自建下载页，双渠道） */
  latestUrl: string;
  /** 本次会话已检查的时间戳，0 表示未检查 */
  lastCheckedAt: number;
  /** 「发现新版本」弹窗是否展示（App 层渲染，一次性） */
  promptVisible: boolean;
  checkUpdate: (force?: boolean) => Promise<boolean>;
  /** 关闭弹窗（本版本不再自动弹，设置页红点仍在） */
  dismissUpdatePrompt: () => void;
  /** 手动打开弹窗（设置页版本号点按且已有更新时） */
  showUpdatePrompt: () => void;
}

// 请求互斥：并发/连点只发一个请求
let updateChecking = false;

export const useUpdateStore = create<UpdateState>((set) => ({
  hasUpdate: false,
  latestVersion: '',
  latestTag: '',
  latestBuild: 0,
  latestNotes: '',
  latestUrl: '',
  lastCheckedAt: 0,
  promptVisible: false,
  // 应用启动 / 回前台时静默检测（限流 6h）；失败（网络/无 Release/超时）静默视为无更新，
  // 绝不打扰用户 —— 没有红点就当作没有更新。
  // force=true 为设置页手动「检查更新」：绕过限流立即请求。
  // 任何失败都不抛错、一律视为「无更新」（返回 false），成功/失败都写缓存限流；
  // 手动 force 不受缓存影响，随时可重试。
  checkUpdate: async (force = false) => {
    // 并发锁：静默检查进行中时，普通调用直接跳过；force（手动检查）必须继续，
    // 否则启动静默检查未结束时手动点「检查更新」会被吞 → 误报「已是最新版本」
    if (updateChecking && !force) return false;
    const { lastCheckedAt } = useUpdateStore.getState();
    // 合并内存与持久化的检查时间：非强制且 6h 内已查过则直接跳过（启动静默限流）
    const persisted = await AsyncStorage.getItem(UPDATE_LAST_CHECK_KEY).catch(() => null);
    const persistedTs = persisted ? Number(persisted) || 0 : 0;
    const lastTs = Math.max(lastCheckedAt, persistedTs);
    if (!force && lastTs && Date.now() - lastTs < UPDATE_CHECK_INTERVAL) return false;
    updateChecking = true;
    const finish = (has: boolean, tag: string, notes = '') => {
      const now = Date.now();
      const info = parseReleaseTag(tag);
      set({
        hasUpdate: has,
        latestVersion: has ? `v${info.version}${info.build > 0 ? ` · Build ${info.build}` : ''}` : '',
        latestTag: has ? tag : '',
        latestBuild: has ? info.build : 0,
        latestNotes: has ? notes : '',
        // 有更新时统一跳自建下载页（页内可随时切夸克/GitHub，无需发版）
        latestUrl: has ? UPDATE_DOWNLOAD_URL : '',
        lastCheckedAt: now,
      });
      AsyncStorage.setItem(UPDATE_LAST_CHECK_KEY, String(now)).catch(() => {});
    };
    try {
      // 源1：GitHub API（未认证匿名限流 60/h，共享出口 IP 时可能 403）
      let tag = '';
      let notes = '';
      try {
        const res = await Promise.race([
          fetch(GITHUB_RELEASES_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yaya-msg-mobile' } }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), UPDATE_TIMEOUT)),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: any = await res.json();
        tag = String(data.tag_name || data.name || '');
        notes = String(data.body || '').replace(/\r\n/g, '\n').trim().slice(0, UPDATE_NOTES_MAX);
      } catch {
        // 源2：GitHub release 页面 HTML（无 API 匿名限流）：重定向 URL 提取 tag
        const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';
        const page = await Promise.race([
          fetch(GITHUB_RELEASES_PAGE, { headers: { 'User-Agent': UA } }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), UPDATE_TIMEOUT + 2000)),
        ]);
        if (!page.ok) throw new Error(`HTTP ${page.status}`);
        const finalUrl = page.url || GITHUB_RELEASES_PAGE;
        const tagMatch = finalUrl.match(/\/releases\/tag\/([^/?#]+)/);
        tag = tagMatch ? decodeURIComponent(tagMatch[1]) : '';
        if (!tag) throw new Error('page missing tag');
      }
      // ★ 按构建号判定（tag 里的 -b3000075）：只比语义版本会把「装了最新包的用户」
      //   也永远判成有更新（见 utils/updateRules 的注释）。
      const verdict = evaluateUpdate(tag, APP_VERSION, APP_BUILD);
      finish(verdict.hasUpdate, tag, notes);
      return verdict.hasUpdate;
    } catch {
      // 检查失败（网络不通/两个源都不可用）：视为无更新，不抛错不打扰
      finish(false, '');
      return false;
    } finally {
      updateChecking = false;
    }
  },
  dismissUpdatePrompt: () => set({ promptVisible: false }),
  showUpdatePrompt: () => set((state) => ({ promptVisible: state.hasUpdate && !!state.latestUrl })),
}));
