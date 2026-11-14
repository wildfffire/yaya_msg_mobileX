// 「上次看到的位置」= 分侧消息 id 边界（用户 2026-11-13「一次性改好」）回归锁。
//
// 旧口径：房间级时间戳 lastReadAt + max(lastReadAt, countedAt) 边界。
// 新口径：每侧记「最后看到的是哪一条消息」{id, time}，判新以 id 为主、时间为兜底；
// 「人看到哪」与「机器计过哪」分开（持久化已认领 id 集合），重启不重计、晚到不吞。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-seen-'));
const results = [];

async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error }); }
}

const T = 1794500000000;
const msg = (id, t, extra = {}) => ({ msgIdClient: id, msgTime: t, bodys: 'hi', ...extra });

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'roomSeenRules.ts')}"`
    + ` "${join(root, 'src', 'utils', 'roomMessageCursor.ts')}"`
    + ` --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const r = await import(`file://${join(tmp, 'src', 'utils', 'roomSeenRules.js')}`);

  await check('seenMarkOf：记的是那一条消息的 id + 服务器时间', () => {
    assert.deepEqual(r.seenMarkOf(msg('a', T)), { id: 'a', time: T });
    assert.deepEqual(r.seenMarkOf({ msgIdServer: 'srv-1', msgTime: T }), { id: 'srv-1', time: T });
    assert.equal(r.seenMarkOf(null), null);
    assert.equal(r.seenMarkOf({}), null);
  });

  await check('mergeSeen：只前进；同时间也更新 id（更精确）；基线倒退不生效', () => {
    const older = { id: 'a', time: T };
    const newer = { id: 'b', time: T + 1000 };
    assert.deepEqual(r.mergeSeen(older, newer), newer);
    assert.deepEqual(r.mergeSeen(newer, older), newer, '旧数据不能把基线推回去');
    assert.deepEqual(r.mergeSeen(older, { id: 'c', time: T }), { id: 'c', time: T }, '同秒也更新到更精确的 id');
    assert.deepEqual(r.mergeSeen(null, newer), newer);
    assert.deepEqual(r.mergeSeen(older, null), older);
    assert.equal(r.mergeSeen(null, null), null);
  });

  await check('★ 找到「上次看到的那条 id」→ 只数它之前的（含同秒连发），非聊天排除', () => {
    const list = [
      msg('n3', T + 3000),
      msg('n2', T + 2000),
      msg('n1', T + 1000),
      msg('same1', T + 1000),                     // 同秒连发不能被时间门槛吞
      msg('gift', T + 2500, { msgType: 'GIFT' }),
      msg('seen', T),
      msg('old', T - 1000),
      msg('n3', T + 3000),                       // 重复 id 去重
    ];
    assert.deepEqual(r.pickUnreadSinceSeen(list, { id: 'seen', time: T }),
      ['n3', 'n2', 'n1', 'same1']);
  });

  await check('★ id 找不到（被清掉/超出窗口/换设备）→ 退回时间比较，时间缺失放行', () => {
    const list = [
      msg('n3', T + 3000),
      msg('n2', T + 2000),
      msg('n1', T + 1000),
      msg('no-time', 0),
      msg('old', T - 1000),
    ];
    const ids = r.pickUnreadSinceSeen(list, { id: 'gone', time: T + 1500 });
    assert.ok(ids.includes('n3') && ids.includes('n2'));
    assert.ok(!ids.includes('n1') && !ids.includes('old'));
    assert.ok(ids.includes('no-time'), '时间字段缺失的消息要交给 id 总账去重，不能整条丢');
  });

  await check('一键已读（只有时间、id 为空）走时间兜底；没有基线时首次不计数', () => {
    const list = [msg('n2', T + 2000), msg('old', T)];
    assert.deepEqual(r.pickUnreadSinceSeen(list, { id: '', time: T + 1000 }), ['n2']);
    assert.deepEqual(r.pickUnreadSinceSeen(list, null), []);
    assert.deepEqual(r.pickUnreadSinceSeen(null, { id: 'x', time: T }), []);
    // ★ 真机事故回归：claimCounted 只建了 id 集合、基线还是空的，绝不能刷出整页历史
    assert.deepEqual(r.pickUnreadSinceSeen(list, { id: '', time: 0 }), []);
  });

  await check('翻页：找到上次看到的那条就停；页不满 / 到时间边界 / 无基线也停', () => {
    const base = { pageLength: 50, limit: 50, oldestTime: T + 5000 };
    const seen = { id: 'seen', time: T };
    assert.equal(r.shouldContinueToSeen({ ...base, seen, pageIds: new Set() }), true, '还没翻到基线');
    assert.equal(r.shouldContinueToSeen({ ...base, seen, pageIds: new Set(['seen']) }), false, '找到 id');
    assert.equal(r.shouldContinueToSeen({ ...base, seen, pageIds: new Set(), pageLength: 12 }), false, '页不满');
    assert.equal(r.shouldContinueToSeen({ ...base, seen, pageIds: new Set(), oldestTime: T }), false, '时间到边界');
    assert.equal(r.shouldContinueToSeen({ ...base, seen: null, pageIds: new Set() }), false, '没基线只拉一页');
    assert.equal(r.reachedSeenId(new Set(['a', 'seen']), seen), true);
    assert.equal(r.reachedSeenId(new Set(['a']), seen), false);
    assert.equal(r.reachedSeenId(new Set(['seen']), null), false);
  });

  /* ── 静态接线守卫 ───────────────────────────────────────── */
  const store = readFileSync(join(root, 'src', 'services', 'roomSeenStore.ts'), 'utf8');
  const feed = readFileSync(join(root, 'src', 'services', 'roomOwnerFeed.ts'), 'utf8');
  const screen = readFileSync(join(root, 'src', 'screens', 'FollowedRoomsScreen.tsx'), 'utf8');
  const pollers = readFileSync(join(root, 'src', 'services', 'messagePollers.ts'), 'utf8');
  const unread = readFileSync(join(root, 'src', 'services', 'roomUnread.ts'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');

  await check('★ 分侧 id 基线落地：进房 / 一键已读 / 持久化已认领 id', () => {
    assert.ok(store.includes('yaya_room_seen_v2'), '基线必须持久化（v2 避开空基线污染）');
    assert.ok(store.includes('claimCounted(') && store.includes('COUNTED_IDS_MAX'), '已计 id 集合要有上限');
    assert.ok(store.includes('if (!s.id && !(s.time > 0)) return null;'),
      '只有 id 集合、没有基线的状态不能遮蔽旧 lastReadAt 兜底（真机 +86 事故）');
    assert.ok(screen.includes('markSeen(roomUnreadKey('), '进房首屏写「实际看到的那条房主消息 id」');
    assert.ok(screen.includes('markSeenAll(key, baselines[id])'), '一键已读同步推进分侧基线');
    assert.ok(unread.includes('yaya_room_unread_v5'), '旧 store 结构与版本一行不动（分隔行/指纹/显示不受影响）');
    assert.ok(screen.includes('markRead('), '旧已读基线仍在（「上次看到这里」分隔行继续用）');
  });

  await check('★ 主计数层按 id 边界，手动刷新一次翻完', () => {
    assert.ok(feed.includes('pickUnreadSinceSeen(') && feed.includes('shouldContinueToSeen('));
    assert.ok(!feed.includes('ownerFeedBoundary(') && !feed.includes('getOwnerCountedAt('),
      '机器进度 countedAt 退出边界');
    assert.ok(feed.includes('FORCE_MAX_PAGES') && feed.includes('force ? FORCE_MAX_PAGES'));
    assert.ok(feed.includes("req.key + (force ? ':force' : '')"), 'force 不能复用常规预算任务');
    assert.ok(pollers.includes('force: true') && screen.includes('flushOwnerFeedUnread(followedRef.current)'));
    assert.ok(screen.includes('claimCountId(messageId(m))'), '实时通道仍用原计数、靠 id 总账幂等');
    assert.ok(pkg.includes('room-seen-rules.test.mjs'), '本回归锁必须进 test:core');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((x) => !x.ok);
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : `\n      ${x.error?.message || x.error}`}`);
console.log(`room-seen-rules: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
