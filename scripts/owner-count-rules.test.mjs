// 「homeowner 页独立补计」回归锁（用户 2026-11-13「覃柯蒙有非常多消息，房间列表计数没有任何提示」）。
//
// 真机 logcat 11-13 09:34~09:44（room=149356897#big）：
//   · 房主 01:42~02:02 连发约 50 条，`/list/homeowner` 一页全有；
//   · 已读基线 11-12 20:02 → 这批消息确实未读；
//   · `/list/all` 最新页被 09 点的粉丝刷满 → `本页偶像=0 服务端命中=0 计=0`；
//   · 回溯边界是 cursor.time(09:25) 翻不到 02:02，补偿扫描又要 t > cursor.time → 永久漏计。
// 修复：homeowner 页不再只当 id 白名单，直接作为独立计数源（双门槛 + 持久化游标 + 总账去重）。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-owner-count-'));
const results = [];

async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error }); }
}

const READ_FLOOR = 1794484964143; // 11-12 20:02:44（真机已读基线）
const OWNER_NEWEST = 1794506525111; // 11-13 02:02:05（房主最新一条）
const FAN_NEWEST = 1794533594749;  // 11-13 09:33:14（all 页最新粉丝消息）

const ownerMsg = (id, t, extra = {}) => ({
  msgIdClient: id,
  msgTime: t,
  bodys: '房主发言',
  ...extra,
});

/** 覃柯蒙现场：房主 50 条（01:42~02:02），all 页最新 50 条全是粉丝 */
const ownerPage = Array.from({ length: 50 }, (_, i) =>
  ownerMsg(`owner-${i}`, OWNER_NEWEST - (49 - i) * 24_000));
const fanIds = new Set(Array.from({ length: 50 }, (_, i) => `fan-${i}`));

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'ownerCountRules.ts')}"`
    + ` "${join(root, 'src', 'utils', 'roomMessageCursor.ts')}"`
    + ` "${join(root, 'src', 'utils', 'notifyOwnerRules.ts')}"`
    + ` "${join(root, 'src', 'utils', 'memberMatch.ts')}"`
    + ` --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const rules = await import(`file://${join(tmp, 'src', 'utils', 'ownerCountRules.js')}`);

  await check('★ 房主整批被粉丝刷出 all 页窗口：homeowner 页仍要一条不漏地补计', () => {
    const r = rules.pickUncountedOwnerMessages(ownerPage, {
      readFloor: READ_FLOOR, countedAt: 0, excludeIds: fanIds,
    });
    assert.equal(r.ids.length, 50, '50 条房主消息都要进角标');
    assert.equal(r.ids[0], 'owner-0');
    assert.equal(r.ids[49], 'owner-49');
    assert.equal(r.newest, OWNER_NEWEST);
  });

  await check('★ all 页已经见过的房主消息不重复计（两通道同 id 只算一次）', () => {
    const seen = new Set(['owner-10', 'owner-11']);
    const r = rules.pickUncountedOwnerMessages(ownerPage, {
      readFloor: READ_FLOOR, countedAt: 0, excludeIds: seen,
    });
    assert.equal(r.ids.length, 48);
    assert.ok(!r.ids.includes('owner-10'));
    assert.ok(!r.ids.includes('owner-11'));
  });

  await check('★ all 页 id 别名不同源也要排除（msgIdClient / msgIdServer / uuid）', () => {
    const seen = new Set(['srv-7', 'uuid-9']);
    const page = [
      ownerMsg('cli-7', OWNER_NEWEST - 1000, { msgIdServer: 'srv-7' }),
      ownerMsg('cli-8', OWNER_NEWEST - 2000),
      ownerMsg('cli-9', OWNER_NEWEST - 3000, { uuid: 'uuid-9' }),
    ];
    const r = rules.pickUncountedOwnerMessages(page, {
      readFloor: READ_FLOOR, countedAt: 0, excludeIds: seen,
    });
    assert.deepEqual(r.ids, ['cli-8']);
  });

  await check('★ 已读基线之后才算：进房/一键已读后旧房主消息不能再次提示', () => {
    const r = rules.pickUncountedOwnerMessages(ownerPage, {
      readFloor: OWNER_NEWEST, countedAt: 0, excludeIds: fanIds,
    });
    assert.equal(r.ids.length, 0);
  });

  await check('★ 持久化游标：进程重启后同一批不能重计', () => {
    const r = rules.pickUncountedOwnerMessages(ownerPage, {
      readFloor: READ_FLOOR, countedAt: OWNER_NEWEST, excludeIds: fanIds,
    });
    assert.equal(r.ids.length, 0);
    // 游标之后房主又发了新的，仍要能补计
    const newer = rules.pickUncountedOwnerMessages(
      [...ownerPage, ownerMsg('owner-new', OWNER_NEWEST + 60_000)],
      { readFloor: READ_FLOOR, countedAt: OWNER_NEWEST, excludeIds: fanIds },
    );
    assert.deepEqual(newer.ids, ['owner-new']);
    assert.equal(newer.newest, OWNER_NEWEST + 60_000);
  });

  await check('没有已读基线（首次基线）：不补计、也不推进游标', () => {
    const r = rules.pickUncountedOwnerMessages(ownerPage, {
      readFloor: 0, countedAt: 0, excludeIds: fanIds,
    });
    assert.deepEqual(r.ids, []);
    assert.equal(r.newest, 0, '首次基线不能把游标推走，否则用户第一次进房后该提示的消息会被挡掉');
  });

  await check('非聊天类型 / 时间缺失不补计（礼物、进房特效、系统公告、脏时间）', () => {
    const page = [
      ownerMsg('text-1', OWNER_NEWEST - 1000),
      ownerMsg('gift-1', OWNER_NEWEST - 2000, { msgType: 'GIFT' }),
      ownerMsg('enter-1', OWNER_NEWEST - 3000, { bodys: { messageType: 'ENTER_ROOM' } }),
      ownerMsg('notice-1', OWNER_NEWEST - 4000, { msgType: 'NOTICE' }),
      ownerMsg('no-time', 0),
      ownerMsg('bad-time', 12345),
      ownerMsg('dup-id', OWNER_NEWEST - 5000),
      ownerMsg('dup-id', OWNER_NEWEST - 5000),
    ];
    const r = rules.pickUncountedOwnerMessages(page, {
      readFloor: READ_FLOOR, countedAt: 0,
    });
    assert.deepEqual(r.ids, ['text-1', 'dup-id'], '同 id 只补一次');
    assert.equal(r.newest, OWNER_NEWEST - 1000);
  });

  await check('空页 / null 安全返回', () => {
    assert.deepEqual(rules.pickUncountedOwnerMessages(null, { readFloor: READ_FLOOR, countedAt: 0 }), { ids: [], newest: 0 });
    assert.deepEqual(rules.pickUncountedOwnerMessages([], { readFloor: READ_FLOOR, countedAt: 0 }), { ids: [], newest: 0 });
  });

  await check('补计游标只前进不后退', () => {
    assert.equal(rules.nextOwnerCountedAt(0, OWNER_NEWEST), OWNER_NEWEST);
    assert.equal(rules.nextOwnerCountedAt(OWNER_NEWEST, OWNER_NEWEST - 1000), OWNER_NEWEST);
    assert.equal(rules.nextOwnerCountedAt(READ_FLOOR, FAN_NEWEST), FAN_NEWEST);
    assert.equal(rules.nextOwnerCountedAt(0, 0), 0);
  });

  /* ── 静态接线守卫 ───────────────────────────────────────── */
  const pollers = readFileSync(join(root, 'src', 'services', 'messagePollers.ts'), 'utf8');
  const counters = readFileSync(join(root, 'src', 'screens', 'room', 'useRoomUnreadCounters.ts'), 'utf8');
  const store = readFileSync(join(root, 'src', 'services', 'roomOwnerCount.ts'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');

  await check('★ 两条计数通道都接上 homeowner 独立补计，且共享持久化游标', () => {
    assert.ok(store.includes('pickUncountedOwnerMessages('), '共享补计必须用纯规则挑选');
    assert.ok(store.includes('advanceOwnerCountedAt('), '共享补计必须推进游标');
    assert.ok(pollers.includes('claimUncountedOwnerPage('), '5s 轮询必须接上共享补计');
    assert.ok(pollers.includes('ensureOwnerCountLoaded()'), '轮询启动必须恢复游标');
    assert.ok(pollers.includes('homeowner 补计'), '真机日志要能一眼看出补计了多少条');
    assert.ok(counters.includes('ownerPageForCount'), '30s 精确计数必须保留 homeowner 原始页');
    assert.ok(counters.includes('claimUncountedOwnerPage('), '30s 精确计数必须接上共享补计');
    assert.ok(store.includes('yaya_room_owner_counted_v1'), '游标必须持久化（重启不重计）');
    assert.ok(pkg.includes('owner-count-rules.test.mjs'), '本回归锁必须进 test:core');
  });

  await check('既有口径不能被顺手改坏：仍只计偶像、仍共用 id 总账', () => {
    assert.ok(pollers.includes('isOwnerMessageStrict('), '房主判定仍是唯一严格入口');
    assert.ok(pollers.includes('claimCountId('), '补计仍走 id 原子认领');
    assert.ok(counters.includes('不占总账'), '首次基线仍不抢总账');
    assert.ok(pollers.includes('ownerChecks'), 'homeowner 表仍按侧按需拉取，0 额外请求');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`owner-count-rules: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
