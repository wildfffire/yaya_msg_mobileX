// 「消息 id 游标」回归锁（用户 2026-11-10「部分新消息不提示」四轮修复）。
//
// 对标上游 yk1z/yaya_msg：
//   · followed-rooms-feature.js:480-499（getFollowedMessageKey / getFollowedMessageTime）
//   · followed-rooms-feature.js:872-933（previewKey 比较 + recentMessageKeys + msgTime 游标）
//   · private-message-notifications.js:41-47（noreadNum / newestMessagetime 判定）
// 核心：预览指纹只决定「要不要拉详情」，判定新消息必须按详情里的**消息 id 集合**。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-cursor-'));
const results = [];

async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error }); }
}

const msg = (id, t, text, extra = {}) => ({
  msgIdClient: id, msgTime: t, bodys: text, ...extra,
});
const previewMsg = (t, text) => ({ serverId: 1, channelId: 2, msgContent: text, starName: 'A', msgTime: t });

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'roomMessageCursor.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const c = await import(`file://${join(tmp, 'src', 'utils', 'roomMessageCursor.js')}`);

  await check('消息 id：上游全部别名都认，缺 id 才用时间+正文兜底', () => {
    assert.equal(c.messageId({ msgIdClient: 'a' }), 'a');
    assert.equal(c.messageId({ msgidClient: 'b' }), 'b');
    assert.equal(c.messageId({ uuid: 'c' }), 'c');
    assert.equal(c.messageId({ msgIdServer: 'd' }), 'd');
    assert.equal(c.messageId({ messageId: 'e' }), 'e');
    assert.equal(c.messageId({ msgId: 'f' }), 'f');
    assert.equal(c.messageId({ msgIdClient: '0', msgIdServer: 'g' }), 'g');
    assert.equal(c.messageId({ msgTime: 1000, bodys: 'hi' }), `${c.normalizeMessageTime(1000)}:hi`);
    assert.equal(c.messageId(null), '');
  });

  await check('时间：秒/毫秒归一，脏值不算时间', () => {
    assert.equal(c.normalizeMessageTime(1700000000), 1700000000000);
    assert.equal(c.normalizeMessageTime(1700000000000), 1700000000000);
    assert.equal(c.normalizeMessageTime(0), 0);
    assert.equal(c.normalizeMessageTime(-5), 0);
    assert.equal(c.normalizeMessageTime('abc'), 0);
    assert.equal(c.normalizeMessageTime(12345), 0);
    assert.equal(c.messageTime({ newestMessagetime: 1700000000 }), 1700000000000);
  });

  await check('首轮只建基线：不产生 fresh，基线取本页最新时间而不是 Date.now()', () => {
    const list = [msg('a', 1700000000000, '旧'), msg('b', 1700000005000, '新')];
    const r = c.findFreshMessages(list, c.emptyMessageCursor());
    assert.deepEqual(r.fresh, []);
    assert.equal(r.newest, 1700000005000);
    const next = c.advanceCursor(c.emptyMessageCursor(), {
      pageKeys: r.pageKeys, newest: r.newest, preview: 'p1', unread: -1,
    });
    assert.equal(next.primed, true);
    assert.equal(next.time, 1700000005000);
    assert.deepEqual(next.keys, ['a', 'b']);
  });

  await check('★ 同秒连发多条：id 不同就都要算新消息（旧版内容指纹会只留 1 条）', () => {
    const t = 1700000010000;
    const cur = { primed: true, time: t - 1000, keys: [], preview: 'p0', unread: -1 };
    const list = [msg('m1', t, '第一条'), msg('m2', t, '第二条'), msg('m3', t, '第三条')];
    assert.equal(c.findFreshMessages(list, cur).fresh.length, 3);
  });

  await check('★ 内容完全相同但 id 不同：两条都要提示（旧版指纹逐字相同被整轮吞）', () => {
    const t = 1700000020000;
    const cur = { primed: true, time: t - 1, keys: [], preview: 'p0', unread: -1 };
    const list = [msg('x1', t, '一样的话'), msg('x2', t, '一样的话')];
    const r = c.findFreshMessages(list, cur);
    assert.equal(r.fresh.length, 2);
    assert.notEqual(c.freshBatchKey(r.fresh), c.freshBatchKey([list[0]]));
  });

  await check('时间比游标旧的没见过的 id：视为历史补页，不当新消息', () => {
    const cur = { primed: true, time: 1700000050000, keys: [], preview: 'p0', unread: -1 };
    const r = c.findFreshMessages([msg('old', 1700000040000, '旧')], cur);
    assert.equal(r.fresh.length, 0);
  });

  await check('时间缺失（0）但 id 没见过：仍然算新消息', () => {
    const cur = { primed: true, time: 1700000050000, keys: [], preview: 'p0', unread: -1 };
    const r = c.findFreshMessages([{ msgIdClient: 'no-time', bodys: '没时间' }], cur);
    assert.equal(r.fresh.length, 1);
  });

  await check('★ 通知失败的消息不进游标，下一轮还能重试', () => {
    const t = 1700000060000;
    const cur = { primed: true, time: t - 1, keys: [], preview: 'p0', unread: -1 };
    const list = [msg('f1', t, '失败'), msg('f2', t, '成功')];
    const r = c.findFreshMessages(list, cur);
    const failedIds = new Set(['f1']);
    const consumed = r.pageKeys.filter((k) => !failedIds.has(k));
    const next = c.advanceCursor(cur, { pageKeys: consumed, newest: r.newest, preview: 'p1', unread: -1 });
    assert.equal(next.keys.includes('f1'), false);
    assert.equal(next.keys.includes('f2'), true);
    assert.equal(next.time, t);
    const again = c.findFreshMessages(list, next);
    assert.deepEqual(again.fresh.map((m) => c.messageId(m)), ['f1']);
  });

  await check('成功处理过的 id 不再重复，且 keys 有上限', () => {
    const t = 1700000070000;
    const list = [msg('z1', t, '1'), msg('z2', t, '2')];
    let cur = c.emptyMessageCursor();
    let r = c.findFreshMessages(list, cur);
    cur = c.advanceCursor(cur, { pageKeys: r.pageKeys, newest: r.newest, preview: 'p1', unread: -1 });
    r = c.findFreshMessages(list, cur);
    assert.equal(r.fresh.length, 0);
    const many = Array.from({ length: c.MESSAGE_CURSOR_KEY_MAX + 20 }, (_, i) => `k${i}`);
    const capped = c.advanceCursor(cur, { pageKeys: many, newest: t, preview: 'p2', unread: 0 });
    assert.equal(capped.keys.length, c.MESSAGE_CURSOR_KEY_MAX);
    assert.equal(capped.keys[capped.keys.length - 1], `k${c.MESSAGE_CURSOR_KEY_MAX + 19}`);
  });

  await check('预览指纹 / 服务端未读变化才拉详情；定期 force 全量兜底', () => {
    const cur = { primed: true, time: 1, keys: ['a'], preview: 'p1', unread: 3 };
    assert.equal(c.cursorNeedsCheck(cur, 'p1', 3), false, '完全没变不拉');
    assert.equal(c.cursorNeedsCheck(cur, 'p2', 3), true, '内容变了要拉');
    assert.equal(c.cursorNeedsCheck(cur, 'p1', 4), true, '未读数涨了要拉');
    assert.equal(c.cursorNeedsCheck(cur, 'p1', 0), false, '已读清零不拉');
    assert.equal(c.cursorNeedsCheck(cur, 'p1', -1), false, '字段缺失不拉');
    assert.equal(c.cursorNeedsCheck(cur, 'p1', 3, true), true, '定期全扫');
    assert.equal(c.cursorNeedsCheck(c.emptyMessageCursor(), '', -1), true, '首次建基线');
  });

  await check('last/message/get 预览条目（无 id 无时间）只当指纹信号，不冒充消息 id', () => {
    const p = previewMsg(0, '我要使劲穿');
    assert.equal(c.messageTime(p), 0);
    assert.equal(c.messagePreview(p), '我要使劲穿');
    // 预览条目没有稳定 id：兜底键由时间+正文组成，两条同内容会撞 —— 这正是必须拉详情的原因
    assert.equal(c.messageId(p), '0:我要使劲穿');
  });

  await check('★ 小房间详情防串味：回退到大房间频道的响应必须被丢弃', () => {
    assert.equal(c.isDetailFromSide('98765', '98765'), true, '本侧频道');
    assert.equal(c.isDetailFromSide(98765, '98765'), true, '数字/字符串不同形态也要相等');
    assert.equal(c.isDetailFromSide('12345', '98765'), false, '回退到别的频道 → 串味');
    assert.equal(c.isDetailFromSide(undefined, '98765'), true, '拿不到 _request 时不误伤');
    assert.equal(c.isDetailFromSide('', '98765'), true);
  });

  await check('★ 补偿扫描已读边界：消掉的消息不能再补计', () => {
    const T = 1700000000000;
    assert.equal(c.canCompensateUnread(T + 5000, T, T - 10000), true, '真新消息可补');
    assert.equal(c.canCompensateUnread(T, T, 0), false, '时间等于上一轮游标最新 → 已读过，不补');
    assert.equal(c.canCompensateUnread(T - 200, T - 100, 0), false, '早于游标时间 → 不补');
    assert.equal(c.canCompensateUnread(T + 5000, T, T + 4000), true, '晚于已读基线');
    assert.equal(c.canCompensateUnread(T + 5000, T, T + 5000), false, '等于已读基线 → 已读过');
    assert.equal(c.canCompensateUnread(T + 5000, T, T + 9000), false, '早于已读基线 → 已读过');
    assert.equal(c.canCompensateUnread(0, T, 0), false, '没有时间字段 → 交给 fresh 的 id 游标');
  });

  await check('★ 角标时间门槛：已读基线严格排除、侧基线含等于、时间未知放行（用户 2026-11-11）', () => {
    const T = 1700000100000;
    // 已读基线（lastReadAt）是「用户看到的最新一条」→ 等于它的已读，不再计数
    assert.equal(c.isCountableUnreadMessage(T, 0, T), false, '等于已读基线 = 已读');
    assert.equal(c.isCountableUnreadMessage(T + 1, 0, T), true, '晚于已读基线 = 未读');
    assert.equal(c.isCountableUnreadMessage(T - 1, 0, T), false);
    // 侧基线（sideSeenAt）是「上次数到的最新一条」→ 同一毫秒连发不能漏
    assert.equal(c.isCountableUnreadMessage(T, T, 0), true, '等于侧基线要计数（同秒连发）');
    assert.equal(c.isCountableUnreadMessage(T - 1, T, 0), false, '早于侧基线不重复计');
    // 时间未知：交给消息 id 总账去重，不能因为接口缺时间字段整条丢掉
    assert.equal(c.isCountableUnreadMessage(0, T, T), true);
    // 两个基线都没有（从未读过、也从没数过）→ 放行，由调用方决定是否建基线
    assert.equal(c.isCountableUnreadMessage(T, 0, 0), true);
  });

  await check('★ 回溯翻页：整页新消息/首次建游标 才向前翻，翻到「上次消费位置」就停（用户 2026-11-11）', () => {
    const T = 1700000200000;
    const base = { pageLength: 50, limit: 50, freshCount: 50, primed: true, boundary: T, oldestTime: T + 1 };
    assert.equal(c.shouldBackfillOlder(base), true, '满页 + 全是新消息 + 还没到边界 → 必须回溯');
    assert.equal(c.shouldBackfillOlder({ ...base, pageLength: 49 }), false, '不满页说明已经到底');
    assert.equal(c.shouldBackfillOlder({ ...base, boundary: 0 }), false, '不知道边界时不回溯（不知道翻到哪停）');
    assert.equal(c.shouldBackfillOlder({ ...base, oldestTime: T - 1 }), false, '已翻到边界 → 停');
    assert.equal(c.shouldBackfillOlder({ ...base, freshCount: 2 }), false, '正常增量（只有 2 条新消息）不回溯，避免每轮多打请求');
    assert.equal(c.shouldBackfillOlder({ ...base, primed: false }), true, '首次建立该侧游标 → 回溯补齐积压');
    assert.equal(c.shouldBackfillOlder({ ...base, limit: 0 }), false);
    // 边界优先「上次轮询消费到的位置」，没有才退回房间已读基线
    assert.equal(c.backfillBoundary(T, T - 999), T, '有游标时间时用它当边界');
    assert.equal(c.backfillBoundary(0, T), T, '没有游标时间时退回 lastReadAt');
    assert.equal(c.backfillBoundary(0, 0), 0);
    // 跨轮续翻的硬上限（配合每轮页预算）
    assert.ok(c.MESSAGE_BACKFILL_MAX_PAGES >= 10, '页数上限不能只有 3 页（积压可能几百条）');
  });

  await check('私信：自己的消息可排除，对方（sender=targetId）保留', () => {
    assert.equal(c.messageIsSelf({ isSelf: true }), true);
    assert.equal(c.messageIsSelf({ messageId: '1', senderUserId: 'me' }, 'me'), true);
    assert.equal(c.messageIsSelf({ messageId: '2', senderUserId: 'other' }, 'me'), false);
    assert.equal(c.messageSenderId({ user: { userId: '42' } }), '42');
  });

  /* ── 静态接线守卫 ───────────────────────────────────────── */
  const pollers = readFileSync(join(root, 'src', 'services', 'messagePollers.ts'), 'utf8');
  const center = readFileSync(join(root, 'src', 'services', 'notificationCenter.ts'), 'utf8');
  const screen = readFileSync(join(root, 'src', 'screens', 'FollowedRoomsScreen.tsx'), 'utf8');
  const counters = readFileSync(join(root, 'src', 'screens', 'room', 'useRoomUnreadCounters.ts'), 'utf8');

  await check('轮询链路：拉详情按 id 判新 + 通知失败不推进游标 + 开关不影响计数', () => {
    assert.ok(pollers.includes('findFreshMessages('), '必须用消息 id 游标挑新消息');
    assert.ok(pollers.includes('getRoomMessages('), '必须拉房间详情一页');
    assert.ok(pollers.includes('getPrivateMessageDetail('), '私信也要拉详情');
    assert.ok(pollers.includes("outcome === 'failed'"), '通知失败必须保留游标');
    assert.ok(pollers.includes('SWEEP_EVERY_ROUNDS'), '要有定期全量兜底扫描');
    assert.ok(pollers.includes('notifyAllowed'), '通知开关只决定弹不弹');
    assert.ok(pollers.includes('claimCountId('), '通知轮询要参与未读 id 总账');
    assert.ok(pollers.includes('ROOM_CURSOR_STORAGE'), '游标要持久化（冷启动不吞消息）');
    assert.ok(!pollers.includes("prev.split('|')"), '旧版按 | 切大房间指纹的 bug 不能回来');
  });

  await check('通知中心：发送成功才记去重，失败要让调用方重试', () => {
    assert.ok(center.includes("return 'failed'"));
    assert.ok(center.includes('if (dedupeKey) rememberSeen(dedupeKey, now);'));
    assert.ok(!center.includes('rememberSeen(dedupeKey, now);\n  }\n\n  const burstKey'), '不能先记去重再发送');
  });

  await check('★ 大/小房间防串味（用户 2026-11-12）：四个取消息的入口都要校验实际命中频道', () => {
    const hits = (screen.match(/isDetailFromSide\(/g) || []).length;
    assert.ok(hits >= 4, `首屏 / 上拉 / 静默刷新 / 房主采样 都要拦（当前只有 ${hits} 处）`);
    assert.ok(screen.includes('forgetRoomMessages(sideKey)'), '串味命中后要作废该侧快照缓存');
    assert.ok(screen.includes('setRoomSideClosed(true)'), '要标记本侧不可用（不渲染、不自动重试）');
    assert.ok(screen.includes("t('该成员的小房间未开通')"), '小房间不可用要显示明确提示');
    const guardIdx = screen.indexOf('const usedChannelId');
    const rememberIdx = screen.indexOf('rememberRoomMessages(sideKey, sorted)');
    assert.ok(guardIdx > 0 && rememberIdx > guardIdx, '串味拦截必须在写分侧消息缓存之前');
  });

  await check('角标：单一数据源 counts + 三条通道共用 id 总账 + 失败不推进基线', () => {
    // 2026-11-10「只要一套数据源」：服务端 unreadCount / 已读地板已退出显示，只认 counts
    assert.ok(screen.includes('(id: string, side: RoomUnreadSide): number => roomUnreadCount(roomUnreadCounts, id, side)'),
      '角标必须只读 roomUnreadCounts');
    assert.ok(!screen.includes('roomServerFloor'), '服务端未读地板不能再作为显示数据源');
    assert.ok(screen.includes('claimCountId(messageId(m))'), '实时通道要用 id 总账');
    assert.ok(counters.includes('claimCountId('), '精确计数要用 id 总账');
    assert.ok(counters.includes('if (n === null) continue;'), '详情失败不能推进指纹/基线');
    assert.ok(!screen.includes('realtimeCountedRef'), '整数相减口径已删除');
  });

  await check('★ 角标积压回溯：一直翻到「上次消费位置」+ 跨轮续翻 + 0 命中要打样例', () => {
    assert.ok(pollers.includes('shouldBackfillOlder('), '必须有「要不要继续往前翻」的判据');
    assert.ok(pollers.includes('backfillSideDetail('), '必须真的继续翻页（accumulate 多页）');
    assert.ok(pollers.includes('MESSAGE_BACKFILL_MAX_PAGES'), '回溯要有硬上限（防请求放大）');
    assert.ok(pollers.includes('backfillBoundary(cur.time, floor)'), '边界必须是「上次轮询消费到的位置」');
    assert.ok(pollers.includes('BACKFILL_PAGES_PER_ROUND'), '每轮页数预算（防一次打几十个请求）');
    assert.ok(pollers.includes('backfillPending'), '翻不完要记断点，下一轮接着翻');
    assert.ok(pollers.includes('下轮续翻'), '续翻要有日志');
    assert.ok(pollers.includes('pendingBackfill.boundary'), '续翻轮不能被「游标时间」挡成历史消息');
    assert.ok(pollers.includes('房主未识别'), '0 命中时必须打出 sender id/nick，否则只能猜');
    assert.ok(counters.includes('房主未识别'), '30s 精确计数同样要留痕');
  });

  await check('★ 已读消息不再重复提示：小房间防串味 + 补偿扫描已读边界', () => {
    assert.ok(pollers.includes('isDetailFromSide('), '5s 轮询要识别详情回退串味');
    assert.ok(pollers.includes('crossSide'), '串味结果必须整轮跳过（不推进游标/计数/通知）');
    assert.ok(counters.includes('isDetailFromSide('), '30s 精确计数也要防串味');
    assert.ok(pollers.includes('canCompensateUnread('), '补偿扫描要过已读边界');
    assert.ok(pollers.includes('readFloor'), '补偿与通知都要读房间级已读基线');
    assert.ok(pollers.includes('for (const m of list) markCountConsumed(messageId(m))'),
      '进房期间整页消息要标已读，不能只标 fresh');
    assert.ok(!pollers.includes('if (t > 0 && t < cur.time) continue;'), '旧的「等于游标时间也算新」口径必须删掉');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`room-message-cursor: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
