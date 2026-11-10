// 通知 / 深链 / 公告去重 / 礼物价格 的纯规则回归锁（用户 2026-11-09 需求）。
//
// 对标的桌面端实现：
//   · 通知三态、仅后台、同成员合并 → renderer/private-message-notifications.js / system-service.js
//   · 深链 yayamsg:// → common/deep-link.js
//   · 公告只弹一次 → renderer/announcement-feature.js（id/内容 hash 去重）
//   · 礼物价格快照 + scorePerUnit → common/gift-pricing.js + gift-price-sync
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-notify-'));
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const read = (p) => readFileSync(join(root, p), 'utf8');

try {
  const files = ['utils/notifyRules.ts', 'utils/notifyPresets.ts', 'utils/deepLinkRules.ts', 'utils/announcementSeen.ts', 'utils/giftPrice.ts']
    .map((f) => `"${join(root, 'src', f)}"`)
    .join(' ');
  execSync(
    `npx tsc ${files} --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const notify = await import(`file://${join(tmp, 'src', 'utils', 'notifyRules.js')}`);
  const presets = await import(`file://${join(tmp, 'src', 'utils', 'notifyPresets.js')}`);
  const link = await import(`file://${join(tmp, 'src', 'utils', 'deepLinkRules.js')}`);
  const ann = await import(`file://${join(tmp, 'src', 'utils', 'announcementSeen.js')}`);
  const price = await import(`file://${join(tmp, 'src', 'utils', 'giftPrice.js')}`);

  /* ── 通知决策 ─────────────────────────────────────────────── */
  await check('免打扰：任何通知都不发', () => {
    const d = notify.notifyDecision({ dnd: true, systemEnabled: true, inappEnabled: true, isForeground: true, kind: 'pm' });
    assert.deepEqual(d, { system: false, inapp: false });
  });

  await check('总开关全关：系统与横幅都不发', () => {
    const d = notify.notifyDecision({ systemEnabled: false, inappEnabled: false, isForeground: false, kind: 'room', roomId: '1' });
    assert.deepEqual(d, { system: false, inapp: false });
  });

  await check('仅后台：前台只出横幅，后台只出系统通知', () => {
    const base = { systemEnabled: true, inappEnabled: true, onlyBackground: true, kind: 'pm' };
    assert.deepEqual(notify.notifyDecision({ ...base, isForeground: true }), { system: false, inapp: true });
    assert.deepEqual(notify.notifyDecision({ ...base, isForeground: false }), { system: true, inapp: false });
  });

  await check('仅后台关：前后台都发系统通知（横幅仍只在前台）', () => {
    const base = { systemEnabled: true, inappEnabled: true, onlyBackground: false, kind: 'pm' };
    assert.deepEqual(notify.notifyDecision({ ...base, isForeground: true }), { system: true, inapp: true });
    assert.deepEqual(notify.notifyDecision({ ...base, isForeground: false }), { system: true, inapp: false });
  });

  await check('私信/房间分别可关', () => {
    assert.equal(notify.notifyDecision({ systemEnabled: true, pmEnabled: false, isForeground: false, kind: 'pm' }).system, false);
    assert.equal(notify.notifyDecision({ systemEnabled: true, roomEnabled: false, isForeground: false, kind: 'room', roomId: '2' }).system, false);
  });

  await check('关通知 = 关后台：保活规则不得误开', () => {
    const alive = notify.shouldKeepMessageAlive;
    assert.equal(alive({}), true, '默认全开才保活');
    assert.equal(alive({ systemEnabled: false }), false, '软件外通知关 → 停');
    assert.equal(alive({ dnd: true }), false, '免打扰 → 停');
    assert.equal(alive({ pmEnabled: false, roomEnabled: false }), false, '私信与房间全关 → 停');
    assert.equal(alive({ pmEnabled: false, roomMode: 'none' }), false, '房间范围=无 → 停');
    assert.equal(alive({ pmEnabled: false }), true, '还有房间通知就继续保活');
    assert.equal(alive({ roomEnabled: false, roomMode: 'none' }), true, '还有私信通知就继续保活');
    assert.equal(alive({ systemEnabled: false, pmEnabled: true, roomEnabled: true }), false, '总开关优先级最高');
  });

  await check('房间三态：all / custom / none', () => {
    assert.equal(notify.roomNotifyAllowed('all', {}, '9'), true);
    assert.equal(notify.roomNotifyAllowed('none', { 9: true }, '9'), false);
    assert.equal(notify.roomNotifyAllowed('custom', {}, '9'), true, '没单独设过默认开');
    assert.equal(notify.roomNotifyAllowed('custom', { 9: false }, '9'), false);
    assert.equal(notify.roomNotifyAllowed('custom', { 9: false }, '10'), true);
  });

  await check('去重键 / 稳定通知 id', () => {
    assert.equal(notify.notifyDedupeKey('pm', '42', 'm1'), 'pm|42|m1');
    assert.equal(notify.notifyDedupeKey('pm', '42', ''), '');
    const a = notify.notifyStableId('room', '1001');
    const b = notify.notifyStableId('room', '1001');
    const c = notify.notifyStableId('room', '1002');
    assert.equal(a, b, '同目标必须同 id（Android 覆盖更新同一条通知）');
    assert.notEqual(a, c);
    assert.ok(a > 0);
  });

  await check('连发合并：30s 内计数递增，超窗重新开始', () => {
    const t0 = 1_000_000;
    let s = notify.mergeBurst(null, { title: '小A', body: 'hi' }, t0);
    assert.equal(s.count, 1);
    s = notify.mergeBurst(s, { title: '小A', body: 'hi2' }, t0 + 1000);
    assert.equal(s.count, 2);
    assert.equal(notify.burstText(s).title, '(2) 小A');
    assert.equal(notify.burstText(s).body, 'hi2');
    // 窗口从「上一次合并时刻」(t0+1000) 起算
    s = notify.mergeBurst(s, { title: '小A', body: 'late' }, t0 + 1000 + notify.BURST_WINDOW_MS + 1);
    assert.equal(s.count, 1);
  });

  /* ── 深链 ─────────────────────────────────────────────────── */
  await check('深链解析：member / room / pm / video / invoice', () => {
    assert.deepEqual(link.parseDeepLink('yayamsg://member/12345'), { type: 'member', id: '12345' });
    assert.deepEqual(link.parseDeepLink('yayamsg://room/777'), { type: 'room', id: '777' });
    assert.deepEqual(link.parseDeepLink('yayamsg:///pm/888?name=%E5%B0%8FA'), { type: 'pm', id: '888', name: '小A' });
    assert.deepEqual(link.parseDeepLink('yayamsg://video/17000000000000001?title=x'), { type: 'video', id: '17000000000000001', title: 'x' });
    assert.deepEqual(link.parseDeepLink('yayamsg://invoice'), { type: 'invoice' });
  });

  await check('深链解析：非法输入一律 null（不能崩、不能乱跳）', () => {
    for (const url of ['', null, 'https://gnz.hk/member/1', 'yayamsg://member', 'yayamsg://member/abc', 'yayamsg://unknown/1', 'yayamsg://member/0']) {
      assert.equal(link.parseDeepLink(url), null, `应拒绝 ${url}`);
    }
  });

  await check('深链生成：与解析互逆，长数字不丢精度', () => {
    const id = '17000000000000001';
    const url = link.buildDeepLink({ type: 'video', id, title: '公演' });
    const parsed = link.parseDeepLink(url);
    assert.equal(parsed.type, 'video');
    assert.equal(parsed.id, id);
    assert.equal(parsed.title, '公演');
    assert.equal(link.parseDeepLink(link.buildDeepLink({ type: 'pm', id: '9', name: '小B' })).name, '小B');
  });

  /* ── 公告去重 ─────────────────────────────────────────────── */
  await check('公告指纹：同文同场次一致，改内容/换场次即变', () => {
    const h1 = ann.announcementHash('今晚八点直播');
    assert.equal(h1, ann.announcementHash('今晚八点直播'));
    assert.notEqual(h1, ann.announcementHash('今晚九点直播'));
    assert.equal(ann.announcementSeenKey('live1', 'A'), ann.announcementSeenKey('live1', 'A'));
    assert.notEqual(ann.announcementSeenKey('live1', 'A'), ann.announcementSeenKey('live2', 'A'));
    assert.equal(ann.announcementSeenKey('', 'A'), '');
    assert.equal(ann.announcementHash(''), '');
  });

  await check('公告记忆：去重上移 + 上限截断', () => {
    let list = [];
    list = ann.pushSeenKey(list, 'k1');
    list = ann.pushSeenKey(list, 'k1');
    assert.deepEqual(list, ['k1']);
    list = ann.pushSeenKey(list, 'k2');
    assert.deepEqual(list, ['k1', 'k2']);
    let many = [];
    for (let i = 0; i < ann.ANNOUNCEMENT_SEEN_MAX + 20; i += 1) many = ann.pushSeenKey(many, `k${i}`);
    assert.equal(many.length, ann.ANNOUNCEMENT_SEEN_MAX);
    assert.equal(many[many.length - 1], `k${ann.ANNOUNCEMENT_SEEN_MAX + 19}`);
  });

  /* ── 礼物价格 ─────────────────────────────────────────────── */
  await check('价格快照解析：对象/数组/数字三种形态', () => {
    const a = price.parseGiftPriceSnapshot({ updatedAt: 10, prices: { 1: { chicken: 100, scorePerUnit: 2, updatedAt: 10 } } });
    assert.equal(a.prices['1'].chicken, 100);
    assert.equal(a.prices['1'].scorePerUnit, 2);
    const b = price.parseGiftPriceSnapshot({ prices: [{ giftId: '2', money: 50 }] });
    assert.equal(b.prices['2'].chicken, 50);
    const c = price.parseGiftPriceSnapshot({ prices: { 3: 20 } });
    assert.equal(c.prices['3'].chicken, 20);
  });

  await check('价格合并：远端新者胜，缺失保留本地，scorePerUnit 不丢', () => {
    const local = { updatedAt: 5, prices: { 1: { chicken: 10, updatedAt: 5 }, 2: { chicken: 20, scorePerUnit: 3, updatedAt: 5 } } };
    const remote = { updatedAt: 9, prices: { 1: { chicken: 12, updatedAt: 9 }, 2: { chicken: 20, updatedAt: 4 } } };
    const merged = price.mergeGiftPrices(local, remote);
    assert.equal(merged.prices['1'].chicken, 12);
    assert.equal(merged.prices['2'].chicken, 20);
    assert.equal(merged.prices['2'].scorePerUnit, 3);
    assert.equal(merged.updatedAt, 9);
  });

  await check('鸡腿单价：接口优先 → 快照 → 未知（未知不猜 1:1）', () => {
    const snap = { updatedAt: 1, prices: { g1: { chicken: 66, scorePerUnit: 2, updatedAt: 1 } } };
    assert.equal(price.resolveGiftChicken({ giftId: 'g1', money: 88 }, snap).unit, 88);
    assert.equal(price.resolveGiftChicken({ giftId: 'g1' }, snap).unit, 66);
    assert.equal(price.resolveGiftChicken({ giftId: 'g9' }, snap).source, 'unknown');
    assert.equal(price.giftChickenTotal({ giftId: 'g1' }, 3, snap).total, 198);
    assert.equal(price.giftContribution({ giftId: 'g1' }, 3, snap), 396);
    assert.equal(price.giftContribution({ giftId: 'g9' }, 3, snap), null);
  });

  /* ── 静态守卫（接线） ─────────────────────────────────────── */
  const rooms = read('src/screens/FollowedRoomsScreen.tsx');
  const chatRow = read('src/screens/room/RoomChatMessageRow.tsx');
  const settings = read('src/screens/SettingsScreen.tsx');
  const overlay = read('src/components/DanmakuOverlay.tsx');
  const danmakuStore = read('src/store/danmakuSettings.ts');
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const mainApp = read('android/app/src/main/java/com/yk1z/yayamsg/MainApplication.kt');
  const ann1 = read('src/player/session/usePlaybackAnnouncement.ts');
  const pollers = read('src/services/messagePollers.ts');
  const app = read('App.tsx');

  await check('原生：通知模块已注册 + 深链 intent-filter', () => {
    assert.ok(mainApp.includes('add(YayaNotifyPackage())'));
    assert.ok(manifest.includes('android:scheme="yayamsg"'));
    assert.ok(manifest.includes('POST_NOTIFICATIONS'));
  });

  await check('App 接线：深链 + 轮询 + 横幅', () => {
    assert.ok(app.includes('initDeepLink()'));
    assert.ok(app.includes('startMessagePollers()'));
    assert.ok(app.includes('<InAppNoticeBanner />'));
    assert.ok(pollers.includes('notifyMessage('));
    assert.ok(pollers.includes('pmPrimed'), '首次轮询只建基线，不能把历史未读全弹出来');
  });

  await check('通知轮询接线（二轮修复）：serverId 查询 + lastMsgList 解析 + 新会话/回前台不漏报', () => {
    // ① 房间最新消息的入参是 serverIdList：必须把 serverId 带上（旧版只传 channelId → 查不到 → 永不通知）
    assert.ok(pollers.includes('m.serverId'), '必须用 serverId 查询最新消息');
    assert.ok(pollers.includes('m.channelId'), 'channelId 一起带上（两种 id 口径都兼容）');
    assert.ok(pollers.includes('m.yklzId'), '小房间 yklzId 也要带上');
    // ② 响应字段显式写全（房间列表用的是 content.lastMsgList）
    assert.ok(pollers.includes("'content.lastMsgList'"));
    // ③ 私信会话列表的真实字段是这个（见 PrivateMessagesScreen）
    assert.ok(pollers.includes("'content.userMessageList'"));
    // ④ 回前台立即补一轮（后台计时器会被系统拖后/冻结）
    assert.ok(pollers.includes('AppState.addEventListener'));
    // ⑤ 空响应不能推进基线（否则真消息也被吃掉）
    assert.ok(pollers.includes('不推进基线'));
  });

  await check('房间未读精确计数：指纹变了要数真实条数，不能固定 +1', () => {
    const counters = read('src/screens/room/useRoomUnreadCounters.ts');
    const store = read('src/services/roomUnread.ts');
    // 列表接口（last/message/get）没有时间/条数字段，只能靠侧级基线 + 拉一页消息来数
    assert.ok(counters.includes('countNewMessagesForSide('), '必须按侧精确计数');
    assert.ok(counters.includes('sideSeenAt'), '需要「该侧最后看过的消息时间」做基线');
    assert.ok(counters.includes('getRoomMessages'), '精确计数要拉该侧最新一页');
    assert.ok(store.includes('sideSeenAt'), 'store 要持久化侧级已见时间');
    // 旧的固定 +1 必须消失（它就是「显示 1、实际发了很多」的根因）
    assert.ok(!counters.includes('bumpPatch[key] = (bumpPatch[key] || 0) + 1'), '不能再固定 +1');
  });

  await check('未读角标（正式口径）：只计偶像发言 + 类型收窄 + 实时订阅失败会重试', () => {
    const counters = read('src/screens/room/useRoomUnreadCounters.ts');
    const roomsSrc = read('src/screens/FollowedRoomsScreen.tsx');
    const qchat = read('src/services/pocketNim/qchat.ts');
    // 正式口径（用户 2026-11-10「只计偶像的信息」）：临时全量口径必须关闭
    assert.ok(counters.includes('export const UNREAD_COUNT_ALL_TYPES = false;'), '测试期全量口径要关掉');
    assert.ok(counters.includes('if (UNREAD_COUNT_ALL_TYPES) return true;'), '开关结构保留，正式期走聊天类正则');
    // ★ 只计偶像：实时路径与指纹/精确计数都要过严格房主判定
    assert.ok(counters.includes('isIdolMessage'), '计数器要有严格偶像判定');
    assert.ok(counters.includes('isIdolOnly(msg, row.member)'), '指纹路径只计偶像');
    assert.ok(counters.includes('isIdolOnly(m, member)'), '精确计数只数偶像消息');
    assert.ok(roomsSrc.includes('isIdolMessage(m as any, hit.member, false)'), '实时未读只计偶像发言');
    // 实时未读订阅失败必须重试（冷启动时云信还没登录，以前一吞到底 → 整场会话收不到实时消息）
    assert.ok(rooms.includes('setTimeout(attach, 5000)'), '订阅失败要 5s 重试');
    assert.ok(rooms.includes('实时未读订阅已挂上'), '订阅成功要留日志');
    assert.ok(qchat.includes('不能静默返回空操作'), 'observeRoomMessages 不能吞掉登录异常');
  });

  await check('软件外通知默认开启 + 一次性迁移 + 启动申请权限', () => {
    const settingsSvc = read('src/services/settings.ts');
    const notifUtil = read('src/utils/notifications.ts');
    assert.ok(settingsSvc.includes('notify_system_enabled: true'), '系统通知必须默认开');
    assert.ok(settingsSvc.includes('NOTIFY_MIGRATION_KEY'), '老用户的旧默认值需要一次性迁移');
    // v4：真机 b3000016 日志实证「四个通知开关又被整份写回固化成 false」，迁移必须存在且只跑一次
    assert.ok(settingsSvc.includes('NOTIFY_MIGRATION_KEY_V4'), '四开关同时为关的固化残留要有 v4 迁移');
    assert.ok(settingsSvc.includes('const allOff = settings.notify_system_enabled === false'), '只在四开关全关时恢复');
    assert.ok(settingsSvc.includes("await AsyncStorage.setItem(NOTIFY_MIGRATION_KEY_V4, '1')"), 'v4 必须写一次性 marker');
    assert.ok(notifUtil.includes('ensureNotificationPermissionOnce'), '启动要申请一次 POST_NOTIFICATIONS');
    assert.ok(app.includes('ensureNotificationPermissionOnce('), 'App 启动时接上权限申请');
  });

  await check('软件外通知（2026-11-10 真机）：后台保活 + 系统通知状态引导 + 一键自证', () => {
    const notifUtil = read('src/utils/notifications.ts');
    const nativeNotify = read('src/native/YayaNotify.ts');
    const module = read('android/app/src/main/java/com/yk1z/yayamsg/YayaNotifyModule.kt');
    const service = read('android/app/src/main/java/com/yk1z/yayamsg/MessageKeepAliveService.kt');
    const panel = read('src/components/NotifySettingsPanel.tsx');
    // ① 真机实测：App 切后台后进程被整个冻结（20~35s 零 JS 日志），5s 轮询停摆 → 必须有前台服务
    assert.ok(manifest.includes('MessageKeepAliveService'), 'manifest 要注册消息保活服务');
    assert.ok(manifest.includes('FOREGROUND_SERVICE_SPECIAL_USE'), 'Android 14+ 要声明 FGS 类型权限');
    assert.ok(manifest.includes('foregroundServiceType="specialUse"'), 'FGS 必须声明 type');
    // 国产 ROM 即使有 FGS 也会挂起后台网络：必须能一键申请电池优化白名单
    assert.ok(manifest.includes('REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'), '要能申请后台联网白名单');
    assert.ok(module.includes('ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'), '允许后台运行要弹系统白名单');
    assert.ok(service.includes('startForeground('), '服务要真正 startForeground');
    assert.ok(module.includes('fun startKeepAlive('), '原生要暴露保活开关');
    assert.ok(nativeNotify.includes('startMessageKeepAlive'), 'JS 要有保活封装');
    // ★ RN 的 JavaTimerManager.onHostPause() 会停掉全部 JS setInterval：光保活进程不够
    assert.ok(module.includes('emitPollTick()'), '原生要发轮询心跳事件');
    assert.ok(service.includes('POLL_TICK_MS'), '服务端要有原生 5s 心跳');
    assert.ok(pollers.includes("'yayaMessagePollTick'"), 'JS 要监听原生心跳');
    assert.ok(app.includes('syncMessageKeepAliveForSettings('), 'App 启动/回前台要按通知设置拉起/停掉保活');
    // ② Android 12 没有 POST_NOTIFICATIONS 运行时弹框：以原生 areEnabled 为准 + App 内主动引导
    assert.ok(notifUtil.includes('systemNotificationsEnabled()'), '以系统通知真实状态为准');
    assert.ok(notifUtil.includes('promptSystemNotificationSettings()'), '未开启时主动问一次');
    assert.ok(notifUtil.includes('androidSdk() < 33'), '要区分有无运行时通知权限的机型');
    assert.ok(module.includes('IMPORTANCE_NONE'), '渠道被降级要检测/重建，不能静默丢通知');
    // ③ 用户能自己验证链路是否正常
    assert.ok(panel.includes('showSystemNotification('), '设置页要有测试通知');
    assert.ok(panel.includes('syncMessageKeepAliveForSettings(st)'), '开关要联动保活服务');
  });

  await check('关通知后台零耗电：服务自检 + 后台轮询暂停 + 设置变更即重算', () => {
    const module = read('android/app/src/main/java/com/yk1z/yayamsg/YayaNotifyModule.kt');
    const service = read('android/app/src/main/java/com/yk1z/yayamsg/MessageKeepAliveService.kt');
    const pollers = read('src/services/messagePollers.ts');
    const notifUtil = read('src/utils/notifications.ts');
    const panel = read('src/components/NotifySettingsPanel.tsx');
    // ① 服务被 START_STICKY 重建 / 进程被杀后重启，也必须读到「用户已关通知」并自停
    assert.ok(module.includes('KEY_KEEP_ALIVE'), '原生要持久化保活允许标记');
    assert.ok(service.includes('keepAliveAllowed()'), '服务创建与重启都要自检');
    assert.ok(service.includes('return START_NOT_STICKY'), '已关通知不能粘住');
    assert.ok(module.includes('putBoolean(KEY_KEEP_ALIVE, false)'), 'stopKeepAlive 要先落盘');
    // ② 光停服务不够：后台 5s 网络轮询也必须停
    assert.ok(service.includes('onDestroy()') && service.includes('wakeLock?.release()'), '停服务要释放 WakeLock');
    assert.ok(service.includes('WAKE_LOCK_TIMEOUT_MS'), 'WakeLock 要能自动超时释放，不能永久占 CPU');
    assert.ok(pollers.includes('syncPollerBackgroundPolicy'), '后台轮询按通知设置暂停/恢复');
    assert.ok(pollers.includes('stopPollingTimers()'), '暂停要真的清掉定时器');
    assert.ok(pollers.includes('if (!notifyWantedNow()) return;'), '关通知后连原生心跳也不触发轮询');
    assert.ok(notifUtil.includes('notifyWanted(settings)'), '保活判定只有一处');
    assert.ok(panel.includes('syncPollerBackgroundPolicy()'), '设置页变更要同步后台轮询');
  });

  await check('后台看门狗：JS 定时器被 RN 暂停时请求/签名不会永久挂起', () => {
    const network = read('src/utils/network.ts');
    const pocket = read('src/api/pocket48.ts');
    assert.ok(network.includes('registerWatchdog('), '在途请求要登记');
    assert.ok(network.includes('flushStaleWork('), '要有不依赖 setTimeout 的强制收尾');
    assert.ok(network.includes('export function raceWithWatchdog'), '异步签名也要能超时');
    assert.ok(pocket.includes('raceWithWatchdog(generatePaAsync()'), '口袋签名必须接入看门狗');
    assert.ok(pollers.includes('flushStaleWork(BG_STALE_MS)'), '原生心跳要驱动看门狗');
    assert.ok(pollers.includes('thawStaleBusy()'), '后台 Promise 不 settle 时要强制解冻 busy 防重入');
    // ★ WebView 的 JS 在后台被暂停，签名永远回不来 → 后台复用最近一次前台签名
    assert.ok(pocket.includes('PA_CACHE_TTL_MS'), '后台要复用最近签名，请求才发得出去');
    assert.ok(pocket.includes("AppState.currentState !== 'active'"), '签名复用只在后台生效，前台仍每次现签');
  });

  await check('设置页有「通知」分类与面板', () => {
    assert.ok(settings.includes("id: 'notify'"));
    assert.ok(settings.includes('<NotifySettingsPanel />'));
    assert.ok(settings.includes("t('背景遮罩强度')"));
    assert.ok(settings.includes("t('背景模糊')"));
  });

  await check('通知预设（C+A）：标准口径 / 免打扰=所有通知关闭 / 关通知即停后台', () => {
    const std = presets.STANDARD_NOTIFY_PATCH;
    const dnd = presets.DND_NOTIFY_PATCH;
    // 用户 2026-11-10 明确：标准 = 系统通知开、App 内横幅关、私信与房间都开
    assert.equal(std.notify_system_enabled, true);
    assert.equal(std.notify_inapp_enabled, false);
    assert.equal(std.notify_pm_enabled, true);
    assert.equal(std.notify_room_enabled, true);
    // 免打扰 = 所有通知关闭（不是「静音」措辞）
    assert.equal(dnd.notify_system_enabled, false);
    assert.equal(dnd.notify_inapp_enabled, false);
    assert.equal(dnd.notify_pm_enabled, false);
    assert.equal(dnd.notify_room_enabled, false);
    assert.equal(dnd.notify_dnd, true);
    const toKeepAlive = (p) => ({
      systemEnabled: p.notify_system_enabled,
      dnd: p.notify_dnd,
      pmEnabled: p.notify_pm_enabled,
      roomEnabled: p.notify_room_enabled,
      roomMode: p.notify_room_mode,
    });
    assert.equal(notify.shouldKeepMessageAlive(toKeepAlive(std)), true, '标准要保活');
    assert.equal(notify.shouldKeepMessageAlive(toKeepAlive(dnd)), false, '免打扰必须停后台，不耗电');
    assert.equal(presets.deriveNotifyPreset(std), 'standard');
    assert.equal(presets.deriveNotifyPreset(dnd), 'dnd');
    assert.equal(presets.deriveNotifyPreset({}), 'custom', '老用户默认全开归到自定义，不擅自改配置');
    assert.equal(presets.deriveNotifyPreset({ ...std, notify_inapp_enabled: true }), 'custom');
    assert.equal(presets.applyNotifyPreset('custom'), null, '自定义只展开详细设置，不改配置');
    // 房间范围与旧的「房间消息」开关永远同步，不再出现矛盾状态
    assert.equal(presets.roomScopePatch('none').notify_room_enabled, false);
    assert.equal(presets.roomScopePatch('all').notify_room_enabled, true);
    assert.equal(presets.roomScopePatch('custom').notify_room_enabled, true);
  });

  await check('通知设置面板：三预设卡 + 无「静音」措辞 + 房间开关合并', () => {
    const panel = read('src/components/NotifySettingsPanel.tsx');
    assert.ok(panel.includes('applyNotifyPreset('), '预设卡要能写入配置');
    assert.ok(panel.includes('deriveNotifyPreset('), '改过开关要自动归到自定义');
    assert.ok(panel.includes('roomScopePatch('), '房间范围与房间消息开关合并');
    assert.ok(panel.includes("key: 'dnd', label: '免打扰'"), '预设名必须是免打扰');
    assert.ok(!panel.includes('全部静音'), '不能用「全部静音」命名');
    assert.ok(!panel.includes("t('房间消息')"), '不能再有独立的房间消息开关');
    assert.ok(!panel.includes("t('免打扰')"), '不能再有第二个同名免打扰开关');
  });

  await check('通知横幅：偶像头像 + 名字加粗 + 不再显示其他图标', () => {
    const center = read('src/services/notificationCenter.ts');
    const banner = read('src/components/InAppNoticeBanner.tsx');
    const module = read('android/app/src/main/java/com/yk1z/yayamsg/YayaNotifyModule.kt');
    // 头像源 = 房间列表那张（公式照/自选跟随设置）
    assert.ok(pollers.includes('roomAvatarForNotify('), '房间通知要取房间列表头像');
    assert.ok(pollers.includes('room_list_avatar_source'), '跟随公式照/自选设置');
    assert.ok(center.includes('avatarUrl: input.avatarUrl'), '通知中心要透传头像');
    // App 内横幅：头像位 + 首字兜底，不再渲染类型图标
    assert.ok(banner.includes('current.avatarUrl'), '横幅要显示头像');
    assert.ok(banner.includes('avatarInitial'), '无头像时用名字首字占位');
    assert.ok(!banner.includes("'account-group'") && !banner.includes("'message-text-outline'"), '不能再显示其他图标');
    assert.ok(banner.includes("fontWeight: '800'"), '偶像名字加粗');
    // 系统通知：头像大图标 + 标题加粗
    assert.ok(module.includes('setLargeIcon('), '系统通知要用头像做大图标');
    assert.ok(module.includes('SpannableString'), '系统通知标题加粗');
    // 展开态自定义布局：折叠态尺寸系统固定，展开后用 72dp 头像（用户 2026-11-10）
    assert.ok(module.includes('setCustomBigContentView'), '展开态要用自定义布局放大头像');
    assert.ok(module.includes('notification_message_dark'), '深浅色两套布局');
    const layoutLight = read('android/app/src/main/res/layout/notification_message_light.xml');
    assert.ok(layoutLight.includes('72dp'), '展开态头像 72dp');
    assert.ok(layoutLight.includes('textStyle="bold"'), '展开态名字加粗');
  });

  await check('常驻通知：仅退到后台才启动，回前台立即停', () => {
    const notifUtil = read('src/utils/notifications.ts');
    const app = read('App.tsx');
    assert.ok(notifUtil.includes("AppState.currentState === 'active'"), '前台不启动保活服务');
    assert.ok(app.includes('syncMessageKeepAliveForSettings(st)'), '前后台切换都要重算');
  });

  await check('预设卡：点「自定义」立即高亮', () => {
    const panel = read('src/components/NotifySettingsPanel.tsx');
    assert.ok(panel.includes('customPicked'), '需要记录用户显式选择');
    assert.ok(panel.includes('setCustomPicked(true)'), '点自定义要置位');
    assert.ok(panel.includes("customPicked ? 'custom'"), '卡片跟随显式选择而不是只按字段派生');
  });

  await check('通知预设文案：四语言字典齐全', () => {
    const keys = [
      '预设', '标准', '自定义', '后台接收', '运行中', '已停止',
      '自定义详细设置', '收起详细设置', '提醒方式', '提醒内容',
      '诊断与系统权限', '开着 App 时不弹系统通知栏',
      '标准：系统通知开启，App 内不弹横幅；前台不提醒，退出 App 后走系统通知栏',
      '免打扰：所有通知关闭，后台接收也会一起停止',
      '自定义：当前配置与预设不同，可继续逐项调整',
      '房间只提醒房主本人发言；关闭所有通知时后台接收会一起停止，不额外耗电。',
    ];
    for (const lang of ['zh-Hant', 'en', 'ja', 'ko']) {
      const dict = read(`src/i18n/${lang}.ts`);
      for (const key of keys) assert.ok(dict.includes(`'${key}'`), `${lang} 缺通知预设文案 ${key}`);
    }
  });

  await check('房间：60s 后台兜底 + 缓存 2 分钟/120 条 + 当前房间不通知', () => {
    assert.ok(rooms.includes('startBgPoll'), '后台应有 60s 慢轮询兜底');
    assert.ok(rooms.includes('60000'), '兜底间隔必须是 60s');
    assert.ok(rooms.includes('ROOM_MSG_CACHE_TTL_MS'));
    assert.ok(rooms.includes('ROOM_MSG_CACHE_MAX_KEEP = 120'));
    assert.ok(rooms.includes('cachedRoomMessages('));
    assert.ok(rooms.includes('setCurrentRoom('));
  });

  await check('红包卡片：解析 + 渲染', () => {
    assert.ok(chatRow.includes('roomRedPacketInfo'));
    assert.ok(chatRow.includes('styles.redPacketCard'));
    assert.ok(read('src/screens/room/mediaResolve.ts').includes("RED_PACKET"));
  });

  await check('弹幕防重叠：设置项 + 渲染分支', () => {
    assert.ok(danmakuStore.includes('avoidOverlap: true'));
    assert.ok(overlay.includes('avoidOverlap ?'));
    assert.ok(read('src/components/DanmakuSettingsSheet.tsx').includes("t('防重叠')"));
  });

  await check('公告只弹一次：指纹写入与命中收起', () => {
    assert.ok(ann1.includes('announcementSeenKey'));
    assert.ok(ann1.includes('rememberSeenKey'));
    assert.ok(ann1.includes('setExpandedState(false)'));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`notify: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
