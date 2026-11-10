// 图片翻页判定（电台照片轮播 / 房间图片查看器共用）——纯 Node 单测。
//
// 背景（用户 2026-11-04）：「图片播放的逻辑能不能复用房间里的，加个自动轮播就行」。
// 判定抽到 utils/imagePagerRules 后，两处必须**同一口径**：位移 + 速度惯性预测、
// 12% 屏宽阈值、24px 最小真实位移。这里把这些数字钉死（改手感前先改用例）。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-pager-rules-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'imagePagerRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'imagePagerRules.js').replace(/\\/g, '/')}`);
  const { decidePagerSwipe, MIN_DRAG_PX, PAGE_RATIO } = mod;
  if (typeof decidePagerSwipe !== 'function') throw new Error('编译产物里缺少 decidePagerSwipe');

  const W = 1000;

  await check('几乎没动（<24px）→ 回弹', () => {
    assert.equal(decidePagerSwipe({ dx: 10, vx: 0, width: W, loop: true }), 'settle');
    assert.equal(decidePagerSwipe({ dx: -23, vx: 0, width: W, loop: true }), 'settle');
  });

  await check('左滑过 12% 屏宽 → 下一张；右滑 → 上一张', () => {
    assert.equal(decidePagerSwipe({ dx: -W * PAGE_RATIO - 5, vx: 0, width: W, loop: true }), 'next');
    assert.equal(decidePagerSwipe({ dx: W * PAGE_RATIO + 5, vx: 0, width: W, loop: true }), 'prev');
  });

  await check('轻甩（位移小但速度快）→ 也翻页（惯性预测 110ms）', () => {
    // dx 只有 40px，但 vx=-1.2 px/ms → projected = 40 + 132 = 172 > 120
    assert.equal(decidePagerSwipe({ dx: -40, vx: -1.2, width: W, loop: true }), 'next');
  });

  await check('边界（非循环）：到头了再往那个方向拖 → 回弹', () => {
    assert.equal(decidePagerSwipe({ dx: -400, vx: -1, width: W, canNext: false }), 'settle');
    assert.equal(decidePagerSwipe({ dx: 400, vx: 1, width: W, canPrev: false }), 'settle');
    assert.equal(decidePagerSwipe({ dx: -400, vx: -1, width: W, canNext: true }), 'next');
  });

  await check('循环模式：首尾永远允许翻页（忽略 canPrev/canNext）', () => {
    assert.equal(decidePagerSwipe({ dx: -400, vx: 0, width: W, loop: true, canNext: false }), 'next');
    assert.equal(decidePagerSwipe({ dx: 400, vx: 0, width: W, loop: true, canPrev: false }), 'prev');
  });

  await check('屏宽非法（0/NaN）→ 回弹，不瞎翻', () => {
    assert.equal(decidePagerSwipe({ dx: -500, vx: -2, width: 0 }), 'settle');
    assert.equal(decidePagerSwipe({ dx: -500, vx: -2, width: NaN }), 'settle');
  });

  await check('反向锁：慢拖但位移不足 12% → 回弹（不能被速度 0 的算法误差带过线）', () => {
    assert.equal(decidePagerSwipe({ dx: -W * PAGE_RATIO + 10, vx: 0, width: W, loop: true }), 'settle');
  });

  await check('最小位移常量没被改小', () => {
    assert.equal(MIN_DRAG_PX, 24);
    assert.equal(PAGE_RATIO, 0.12);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    console.error(`  ✗ ${r.name}`);
    console.error(`    ${r.error?.message || r.error}`);
  }
}
console.log(`\nimage-pager-rules: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
