// 房间「上次看到这里」进房定位目标解析测试（纯 Node，零新增依赖）。
//
// 锁的是用户 2026-10-03 反馈的「点进去定位到上次看到的地方不稳定」里**规则层**的那部分：
//   ① 未读超过一页时，真正的分隔行还在更早的历史页里 ——
//      旧实现会退化成「回到最新」，把整屏未读一次踩过去（本次修复的核心）；
//   ② 无基线 / 全都看过时必须回最新，不能因为「找不到分隔行」就乱定位；
//   ③ 时间边界（oldestMs 恰好等于基线）不能误判成跨页。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-lastseen-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const BASE = 1759000000000; // 进房基线（毫秒）

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'roomLastSeen.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'roomLastSeen.js')}`);
  const { resolveLastSeenTarget } = mod;
  if (typeof resolveLastSeenTarget !== 'function') {
    throw new Error('编译产物里缺少 resolveLastSeenTarget —— 拒绝以「通过」结束');
  }

  await check('从未读过（baseline=0）→ 回最新，不显示分隔行', () => {
    const t = resolveLastSeenTarget({ baseline: 0, dividerIndex: -1, loadedCount: 50, oldestMs: BASE + 1000 });
    assert.equal(t.mode, 'latest');
    assert.equal(t.index, -1);
    assert.equal(t.dividerBeyondPage, false);
  });

  await check('分隔行在已加载数据里 → 精确贴顶到该 index', () => {
    const t = resolveLastSeenTarget({ baseline: BASE, dividerIndex: 7, loadedCount: 50, oldestMs: BASE - 60000 });
    assert.equal(t.mode, 'divider');
    assert.equal(t.index, 7);
    assert.equal(t.dividerBeyondPage, false);
  });

  await check('★跨页未读：整页都晚于基线 → 定位到已加载最旧端并标记需要补历史', () => {
    const t = resolveLastSeenTarget({ baseline: BASE, dividerIndex: -1, loadedCount: 50, oldestMs: BASE + 5000 });
    assert.equal(t.mode, 'oldest');
    assert.equal(t.index, 49); // loadedCount - 1
    assert.equal(t.dividerBeyondPage, true);
  });

  await check('全都看过（最旧一条早于基线，且无分隔行）→ 回最新', () => {
    const t = resolveLastSeenTarget({ baseline: BASE, dividerIndex: -1, loadedCount: 50, oldestMs: BASE - 1 });
    assert.equal(t.mode, 'latest');
    assert.equal(t.index, -1);
    assert.equal(t.dividerBeyondPage, false);
  });

  await check('边界：oldestMs 恰好等于基线 → 不算跨页（严格大于才成立）', () => {
    const t = resolveLastSeenTarget({ baseline: BASE, dividerIndex: -1, loadedCount: 50, oldestMs: BASE });
    assert.equal(t.mode, 'latest');
    assert.equal(t.dividerBeyondPage, false);
  });

  await check('边界：无已加载数据 → 回最新（不乱定位）', () => {
    const t = resolveLastSeenTarget({ baseline: BASE, dividerIndex: -1, loadedCount: 0, oldestMs: 0 });
    assert.equal(t.mode, 'latest');
    assert.equal(t.index, -1);
  });

  await check('边界：dividerIndex 越界（脏数据）→ 按跨页/最新规则回落，不产生非法 index', () => {
    const beyond = resolveLastSeenTarget({ baseline: BASE, dividerIndex: 99, loadedCount: 50, oldestMs: BASE + 1 });
    assert.equal(beyond.mode, 'oldest');
    assert.equal(beyond.index, 49);
    const latest = resolveLastSeenTarget({ baseline: BASE, dividerIndex: 99, loadedCount: 50, oldestMs: BASE - 1 });
    assert.equal(latest.mode, 'latest');
    assert.equal(latest.index, -1);
  });

  await check('边界：只有一条消息且它是未读 → 跨页分支仍给合法 index 0', () => {
    const t = resolveLastSeenTarget({ baseline: BASE, dividerIndex: -1, loadedCount: 1, oldestMs: BASE + 1 });
    assert.equal(t.mode, 'oldest');
    assert.equal(t.index, 0);
  });

  await check('边界：时间信息缺失（oldestMs=0）时不得误判为跨页', () => {
    const t = resolveLastSeenTarget({ baseline: BASE, dividerIndex: -1, loadedCount: 20, oldestMs: 0 });
    assert.equal(t.mode, 'latest');
    assert.equal(t.dividerBeyondPage, false);
  });
} catch (error) {
  results.push({ ok: false, name: '编译 / 加载纯函数模块', error });
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.error(`  ✗ ${r.name}\n    ${r.error?.stack || r.error}`);
}
console.log(`\nroom-lastseen: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
