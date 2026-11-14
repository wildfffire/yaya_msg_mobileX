// 5s / 30s 偶像筛选与 id 认领统一的回归锁（纯 Node，零新增依赖）。
//
// 高风险改造（用户 2026-11-13）：两条计数通道原来各有一套 filter：
//   · 5s：strict || 服务端 homeowner 表（始终合并）；
//   · 30s：本地 strict 优先，0 命中才看服务端表（省请求）。
// 现在统一到 pickIdolMessages，本测试只锁两种策略的结果与两处接线。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-idol-count-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const m = (id, extra = {}) => ({ id, ...extra });

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'roomIdolCountRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'roomIdolCountRules.js')}`);
  const { pickIdolMessages, claimMessageIds } = mod;

  const list = [m('local'), m('server'), m('fan'), m('both')];
  const isOwnerLocal = (x) => x.id === 'local' || x.id === 'both';
  const isOwnerByServer = (x) => x.id === 'server' || x.id === 'both';

  await check('★ 5s 口径：本地严格与「仅服务端命中」求并集（等价原来的 isOwnerMessage）', () => {
    const picked = pickIdolMessages(list, {
      isOwnerLocal,
      isOwnerByServer,
      serverOnlyWhenLocalEmpty: false,
    });
    assert.deepEqual(picked.map((x) => x.id), ['local', 'server', 'both']);
  });

  await check('★ 30s 口径：本地有命中只取本地；本地 0 命中才用服务端表', () => {
    const localHit = pickIdolMessages(list, {
      isOwnerLocal,
      isOwnerByServer,
      serverOnlyWhenLocalEmpty: true,
    });
    assert.deepEqual(localHit.map((x) => x.id), ['local', 'both']);
    const localMiss = pickIdolMessages([m('server'), m('fan')], {
      isOwnerLocal,
      isOwnerByServer,
      serverOnlyWhenLocalEmpty: true,
    });
    assert.deepEqual(localMiss.map((x) => x.id), ['server']);
  });

  await check('isChat 先过滤；空/null 安全', () => {
    const picked = pickIdolMessages([m('a', { chat: false }), m('b', { chat: true })], {
      isChat: (x) => x.chat,
      isOwnerLocal: () => true,
      serverOnlyWhenLocalEmpty: false,
    });
    assert.deepEqual(picked.map((x) => x.id), ['b']);
    assert.deepEqual(pickIdolMessages(null, { isOwnerLocal: () => true, serverOnlyWhenLocalEmpty: false }), []);
  });

  await check('claimMessageIds：只数成功认领的', () => {
    assert.equal(claimMessageIds(['a', 'b', 'c'], (id) => id !== 'b'), 2);
    assert.equal(claimMessageIds([], () => true), 0);
  });

  const pollers = readFileSync(join(root, 'src', 'services', 'messagePollers.ts'), 'utf8');
  const counters = readFileSync(join(root, 'src', 'screens', 'room', 'useRoomUnreadCounters.ts'), 'utf8');
  const rules = readFileSync(join(root, 'src', 'screens', 'room', 'messageRules.ts'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');

  await check('★ 接线：5s/30s 都走统一筛选与统一认领，检查点已清除', () => {
    assert.ok(pollers.includes('const idolMessages: any[] = pickIdolMessages(list, {'), '5s 统一筛选');
    assert.ok(counters.includes('pickIdolMessages('), '30s 统一筛选');
    assert.ok(counters.includes('claimMessageIds('), '30s 统一认领');
    assert.ok(rules.includes('stableMessageId(item)'), 'messageKey 稳定 id 统一');
    for (const src of [pollers, counters, rules]) {
      assert.ok(!src.includes('roomCheck') && !src.includes('checkLog(') && !src.includes('checkSummary('),
        '检查点调用不应残留');
    }
    assert.ok(!pollers.includes('legacyIdolMessages') && !pollers.includes('diffMessageIds('),
      '旧口径只读对账已删除');
    assert.ok(!pollers.includes('count.5s.') && !counters.includes('count.30s.'),
      '决策轨迹检查点已删除');
  });

  await check('本回归锁并入 test:core', () => {
    assert.ok(pkg.includes('room-idol-count-rules.test.mjs'));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`room-idol-count-rules: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
