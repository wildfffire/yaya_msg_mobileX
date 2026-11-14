// 「homeowner 主计数 + 翻到上一次看到的位置 + 原方案兜底」回归锁
//（用户 2026-11-13 定版：「其他的东西你别动，就是计数这块以后以 /list/homeowner 为主，
//  然后原来的方案兜底，并且保证 /list/homeowner 每次计数都到上一次看到的位置为止」）。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-owner-feed-'));
const results = [];

async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error }); }
}

const READ_FLOOR = 1794484964143; // 上一次看到的位置（11-12 20:02）
const ownerMsg = (id, t, extra = {}) => ({ msgIdClient: id, msgTime: t, bodys: '房主发言', ...extra });

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'ownerFeedRules.ts')}"`
    + ` "${join(root, 'src', 'utils', 'roomMessageCursor.ts')}"`
    + ` --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const rules = await import(`file://${join(tmp, 'src', 'utils', 'ownerFeedRules.js')}`);

  await check('★ 翻页边界至少是「上一次看到的位置」，已完整计到更晚则不重复翻', () => {
    assert.equal(rules.ownerFeedBoundary(READ_FLOOR, 0), READ_FLOOR);
    assert.equal(rules.ownerFeedBoundary(READ_FLOOR, READ_FLOOR - 1000), READ_FLOOR);
    assert.equal(rules.ownerFeedBoundary(READ_FLOOR, READ_FLOOR + 5000), READ_FLOOR + 5000);
    assert.equal(rules.ownerFeedBoundary(0, 0), 0, '从没读过：只建基线，不翻历史');
  });

  await check('★ 没翻到「上一次看到的位置」就必须继续翻（页数预算不能混进判据）', () => {
    const base = { pageLength: 50, limit: 50, boundary: READ_FLOOR };
    assert.equal(rules.shouldContinueOwnerPage({ ...base, oldestTime: READ_FLOOR + 1 }), true);
    assert.equal(rules.shouldContinueOwnerPage({ ...base, oldestTime: READ_FLOOR + 1, pages: 8 }), true,
      '预算用尽也要返回 true，服务层才会记断点下轮续翻');
    assert.equal(rules.shouldContinueOwnerPage({ ...base, oldestTime: READ_FLOOR }), false, '正好到基线');
    assert.equal(rules.shouldContinueOwnerPage({ ...base, oldestTime: READ_FLOOR - 1 }), false);
    assert.equal(rules.shouldContinueOwnerPage({ ...base, pageLength: 12, oldestTime: READ_FLOOR + 1 }), false,
      '页不满 = 没有更早的消息了');
    assert.equal(rules.shouldContinueOwnerPage({ ...base, boundary: 0, oldestTime: READ_FLOOR + 1 }), false,
      '没有基线只拉一页建基线');
  });

  await check('最早/最新时间：脏值与缺时间字段不污染', () => {
    const list = [
      ownerMsg('a', READ_FLOOR + 3000),
      ownerMsg('b', READ_FLOOR + 1000),
      ownerMsg('c', 0),
      ownerMsg('d', 12345),
    ];
    assert.equal(rules.oldestMessageTime(list), READ_FLOOR + 1000);
    assert.equal(rules.oldestMessageTime([]), 0);
    assert.equal(rules.pickOwnerFeedMessages(list, { readFloor: READ_FLOOR, countedAt: 0 }).newest, READ_FLOOR + 3000);
  });

  await check('★ 计数筛选：只数晚于「上次看到」且晚于已计位置的房主聊天消息', () => {
    const list = [
      ownerMsg('new1', READ_FLOOR + 1000),
      ownerMsg('new2', READ_FLOOR + 2000),
      ownerMsg('old', READ_FLOOR - 1000),                    // 已看过
      ownerMsg('counted', READ_FLOOR + 500),                  // 上次完整计过
      ownerMsg('gift', READ_FLOOR + 3000, { msgType: 'GIFT' }),
      ownerMsg('notice', READ_FLOOR + 4000, { msgType: 'NOTICE' }),
      ownerMsg('no-time', 0),
      ownerMsg('new1', READ_FLOOR + 1000),                    // 重复 id
    ];
    const pick = rules.pickOwnerFeedMessages(list, { readFloor: READ_FLOOR, countedAt: READ_FLOOR + 800 });
    assert.deepEqual(pick.ids, ['new1', 'new2']);
    assert.equal(pick.newest, READ_FLOOR + 4000);
    assert.equal(pick.oldest, READ_FLOOR - 1000, '最早值取有效时间的最小值，t=0 不参与');
  });

  await check('★ 首次基线（没读过）：只建基线不计数', () => {
    const pick = rules.pickOwnerFeedMessages([ownerMsg('a', READ_FLOOR + 1000)], { readFloor: 0, countedAt: 0 });
    assert.deepEqual(pick.ids, []);
    assert.equal(pick.newest, READ_FLOOR + 1000);
  });

  await check('空页 / null 安全返回', () => {
    const pick = rules.pickOwnerFeedMessages(null, { readFloor: READ_FLOOR, countedAt: 0 });
    assert.deepEqual(pick.ids, []);
    assert.equal(pick.newest, 0);
    assert.equal(rules.oldestMessageTime(null), 0);
  });

  /* ── 静态接线守卫 ───────────────────────────────────────── */
  const pollers = readFileSync(join(root, 'src', 'services', 'messagePollers.ts'), 'utf8');
  const counters = readFileSync(join(root, 'src', 'screens', 'room', 'useRoomUnreadCounters.ts'), 'utf8');
  const feed = readFileSync(join(root, 'src', 'services', 'roomOwnerFeed.ts'), 'utf8');
  const screen = readFileSync(join(root, 'src', 'screens', 'FollowedRoomsScreen.tsx'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');

  await check('★ 主计数源接在 5s 轮询与 30s 指纹，实时通道与其它功能一行没动', () => {
    assert.ok(pollers.includes('countOwnerFeedUnread('), '5s 轮询要用 homeowner 主源');
    assert.ok(counters.includes('countOwnerFeedUnread('), '30s 指纹要用同一个主源');
    assert.ok(screen.includes('markCountConsumed(messageId(m))'), '实时通道原逻辑保持原样');
    assert.ok(screen.includes('claimCountId(messageId(m))'), '实时通道仍靠 id 总账与主源幂等');
    assert.ok(!screen.includes('countOwnerFeedUnread('), '实时通道不要被改成异步 HTTP 计数');
    assert.ok(pkg.includes('owner-feed-rules.test.mjs'), '本回归锁必须进 test:core');
  });

  await check('★ 每次都翻到「上次看到的那条消息 id」，手动刷新强制一次翻完', () => {
    assert.ok(feed.includes('fetchAll: false'), '只打 /list/homeowner');
    assert.ok(feed.includes('pickUnreadSinceSeen('), '判新按消息 id 边界，不再用时间戳');
    assert.ok(feed.includes('shouldContinueToSeen('), '按「上次看到的那条 id」决定继续翻页');
    assert.ok(!feed.includes('ownerFeedBoundary(') && !feed.includes('getOwnerCountedAt('),
      '机器进度 countedAt 必须退出边界，边界严格由用户基线决定');
    assert.ok(feed.includes('MAX_PAGES_PER_CALL') && feed.includes('FORCE_MAX_PAGES'),
      '常规预算 + 手动刷新一次翻完的独立上限');
    assert.ok(feed.includes('pendingPages.set(') && feed.includes('pendingPages.delete('));
    assert.ok(feed.includes('claimCounted(opts.key, id)'), '已计 id 持久化，重启不重计');
    assert.ok(pollers.includes('force: true'), '手动刷新走 force');
    assert.ok(screen.includes('flushOwnerFeedUnread('), '下拉刷新要触发一次性翻页');
  });

  await check('★ 原来的方案兜底：主源失败时旧路径必须还能计数', () => {
    assert.ok(counters.includes('catch { /* 主源不可用 → 原方案兜底 */ }'), '指纹路径失败要回落');
    assert.ok(pollers.includes('catch { /* 主源异常 → 旧方案兜底 */ }'), '轮询路径失败要回落');
    assert.ok(pollers.includes('if (idolIds.has(mid)) countableIdolIds.push(mid);'), '旧 all 页计数代码保留');
    assert.ok(pollers.includes('补偿计数'), '旧补偿扫描保留');
    assert.ok(counters.includes('isCountableUnreadMessage('), '旧精确计数保留');
    assert.ok(feed.includes('claimCountId('), '主源仍走 id 原子认领，旧路径因此幂等');
    assert.ok(feed.includes('return null'), '主源失败要返回 null 而不是 0');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`owner-feed-rules: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
