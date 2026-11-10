// 「滚动收起顶栏/底栏」判定规则测试（纯 Node，零新增依赖）。
//
// 这个文件是两次真机事故的回归锁：
//   ① 「顶栏收起后回不来」—— 判定若写错，表现与动画坏掉完全一样；
//   ② 「拖住手指不动，顶栏一直来回闪」—— 反馈回路必须被静默期 + 滞回摁住。
// 时间是显式传入的（now），所以下面所有场景都是确定性的，不依赖真实时钟。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-chrome-scroll-'));

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
    `npx tsc "${join(root, 'src', 'navigation', 'chromeScrollRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'navigation', 'chromeScrollRules.js')}`);
  const {
    stepChromeScroll,
    initialChromeScrollState,
    DIR_THRESHOLD,
    TOP_ZONE,
    FLIP_MIN_DELTA,
    COOLDOWN_MS,
  } = mod;
  if (typeof stepChromeScroll !== 'function') {
    throw new Error('编译产物里没有 stepChromeScroll —— 拒绝以「通过」结束');
  }

  /** 起始时间取一个大数，保证初始不处于静默期 */
  const T0 = 1_000_000;
  const fresh = () => ({ ...initialChromeScrollState });

  await check('向上滚动 → 收起', () => {
    const s = stepChromeScroll(fresh(), 200, T0);
    assert.equal(s.hidden, true);
  });

  await check('向下滚动 → 出现（「回得来」的核心断言）', () => {
    const hidden = stepChromeScroll(fresh(), 400, T0);
    assert.equal(hidden.hidden, true);
    // 跳过静默期后再往下滚
    const shown = stepChromeScroll(hidden, 300, T0 + COOLDOWN_MS + 1);
    assert.equal(shown.hidden, false);
  });

  await check('抖动（单帧位移 ≤ 阈值）→ 保持原状', () => {
    const hidden = stepChromeScroll(fresh(), 400, T0);
    const stillHidden = stepChromeScroll(hidden, 400 - DIR_THRESHOLD, T0 + COOLDOWN_MS + 1);
    assert.equal(stillHidden.hidden, true);
  });

  await check('静默期：翻转后 320ms 内的偏移变化不改变状态', () => {
    const hidden = stepChromeScroll(fresh(), 400, T0);
    assert.equal(hidden.hidden, true);
    // 回声：偏移被系统改回 0（会被顶部保护区读成「回顶」），静默期内必须不响应
    const echo1 = stepChromeScroll(hidden, 0, T0 + 20);
    assert.equal(echo1.hidden, true, '静默期内不得因回声展开');
    const echo2 = stepChromeScroll(echo1, 380, T0 + 40);
    assert.equal(echo2.hidden, true, '静默期内不得再翻转');
  });

  await check('顶部保护区 → 无条件显示（静默期结束后）', () => {
    const hidden = stepChromeScroll(fresh(), 400, T0);
    const atTop = stepChromeScroll(hidden, TOP_ZONE, T0 + COOLDOWN_MS + 1);
    assert.equal(atTop.hidden, false);
    const hidden2 = stepChromeScroll(fresh(), 400, T0);
    const atZero = stepChromeScroll(hidden2, 0, T0 + COOLDOWN_MS + 1);
    assert.equal(atZero.hidden, false);
  });

  await check('滞回：净位移不足 FLIP_MIN_DELTA 不翻转', () => {
    // 先干净地收起（翻转点 anchorY = 400）
    let s = stepChromeScroll(fresh(), 400, T0);
    assert.equal(s.hidden, true);
    // 静默期后，只往回 10px（> DIR_THRESHOLD 但 < FLIP_MIN_DELTA）→ 不应展开
    s = stepChromeScroll(s, 390, T0 + COOLDOWN_MS + 1);
    assert.equal(s.hidden, true, `净位移 ${10} < ${FLIP_MIN_DELTA} 时不得翻转`);
    // 继续往回，累计净位移够大 → 展开
    s = stepChromeScroll(s, 370, T0 + COOLDOWN_MS + 2);
    assert.equal(s.hidden, false);
  });

  await check('反馈回路回归锁：布局回声不再造成持续闪烁', () => {
    // 模拟真机现象：收起后，系统的布局重算把偏移来回推（回声幅度 100px），
    // 手指其实没动。要求：整个回声期间状态**不再翻转**，而不是来回跳。
    let s = stepChromeScroll(fresh(), 400, T0);
    assert.equal(s.hidden, true);
    const echoes = [0, 400, 0, 400, 0, 400];
    for (let i = 0; i < echoes.length; i += 1) {
      s = stepChromeScroll(s, echoes[i], T0 + 16 * (i + 1)); // 每帧 16ms，全部落在静默期内
      assert.equal(s.hidden, true, `第 ${i + 1} 次回声不得翻转状态`);
    }
    // 静默期结束后，手指真的往回滚：必须能展开（锁不能把功能一起锁死）
    s = stepChromeScroll(s, 360, T0 + COOLDOWN_MS + 100);
    assert.equal(s.hidden, false);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[chrome-scroll] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
