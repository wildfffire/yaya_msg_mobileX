// 单侧「本轮算新」筛选的回归锁（纯 Node，零新增依赖）。
//
// 从 messagePollers.pollRooms 单侧循环抽出 pickFreshSideMessages：
// 这段判新口径最容易在重构时漂移，一旦改错就是「新消息不计数」或「整页历史刷成未读」。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-fresh-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const BASE = 1_700_000_000_000;
const msg = (id, t) => ({ msgIdClient: id, msgTime: t });
const cursor = (keys = [], time = 0) => ({ primed: true, time, keys, preview: '', unread: -1 });

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'roomMessageCursor.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const c = await import(`file://${join(tmp, 'src', 'utils', 'roomMessageCursor.js')}`);
  const { pickFreshSideMessages } = c;

  await check('正常轮：已消费 id 排除；明确早于 countFloor 排除；时间缺失保留', () => {
    const list = [
      msg('old', BASE + 2000),
      msg('a', BASE + 1500),
      msg('b', BASE + 900),
      msg('c', 0),
    ];
    const fresh = pickFreshSideMessages(list, {
      cur: cursor(['old'], BASE + 1000),
      newSideWithFloor: false,
      readFloor: 0,
      countFloor: BASE + 1000,
    });
    assert.deepEqual(fresh.map((m) => m.msgIdClient), ['a', 'c']);
  });

  await check('新出现的侧：严格晚于已读基线才算新；等于基线 / 时间缺失都不算', () => {
    const list = [
      msg('x', BASE + 1000),
      msg('y', BASE + 1001),
      msg('z', 0),
    ];
    const fresh = pickFreshSideMessages(list, {
      cur: cursor([], 0),
      newSideWithFloor: true,
      readFloor: BASE + 1000,
      countFloor: 0,
    });
    assert.deepEqual(fresh.map((m) => m.msgIdClient), ['y']);
  });

  await check('空页 / null 安全；不修改原数组', () => {
    assert.deepEqual(pickFreshSideMessages(null, {
      cur: cursor(), newSideWithFloor: false, readFloor: 0, countFloor: 0,
    }), []);
    assert.deepEqual(pickFreshSideMessages([], {
      cur: cursor(), newSideWithFloor: true, readFloor: 0, countFloor: 0,
    }), []);
    const list = [msg('a', 2000)];
    pickFreshSideMessages(list, {
      cur: cursor(), newSideWithFloor: false, readFloor: 0, countFloor: 0,
    });
    assert.equal(list.length, 1);
  });

  await check('★ 30s 候选筛选：非聊天 / 时间不明（无侧基线）/ 未晚于基线都排除', () => {
    const list = [
      { id: 'a', chat: true, t: BASE + 2000 },
      { id: 'b', chat: false, t: BASE + 2000 },
      { id: 'c', chat: true, t: 0 },
      { id: 'd', chat: true, t: BASE + 500 },
    ];
    const picked = c.pickCountableCandidates(list, {
      isChat: (m) => m.chat,
      timeOf: (m) => m.t,
      isNewer: (t) => c.isCountableUnreadMessage(t, 0, BASE + 1000),
      hasSideBaseline: false,
    });
    assert.deepEqual(picked.map((m) => m.id), ['a']);
    const withBaseline = c.pickCountableCandidates(list, {
      isChat: (m) => m.chat,
      timeOf: (m) => m.t,
      isNewer: (t) => c.isCountableUnreadMessage(t, 0, BASE + 1000),
      hasSideBaseline: true,
    });
    assert.deepEqual(withBaseline.map((m) => m.id), ['a', 'c'], '有侧基线时时间缺失的消息保留');
  });

  /* ── 接线守卫：轮询必须调用纯函数，且关键分支/断言保持原样 ── */
  const pollers = readFileSync(join(root, 'src', 'services', 'messagePollers.ts'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');
  await check('★ 接线：pollRooms 调用 pickFreshSideMessages，原判新分支仍在', () => {
    assert.ok(pollers.includes('pickFreshSideMessages('), 'fresh 过滤走纯函数');
    assert.ok(pollers.includes('newSideWithFloor'), '新侧判据仍保留');
    assert.ok(pollers.includes('(cur.primed || newSideWithFloor)'), '计数分支仍在新侧执行');
    assert.ok(pollers.includes('pendingBackfill.boundary'), '续翻轮时间下限仍来自回溯边界');
    assert.ok(pollers.includes('if (idolIds.has(mid)) countableIdolIds.push(mid);'), '偶像交集计数保持原样');
  });

  await check('本回归锁并入 test:core', () => {
    assert.ok(pkg.includes('room-fresh-rules.test.mjs'));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`room-fresh-rules: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
