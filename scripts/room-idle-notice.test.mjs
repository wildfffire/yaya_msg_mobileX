// 房间「{days} 天内偶像无消息」判定测试（纯 Node，零新增依赖）。
//
// 为什么必须钉住这一层（用户 2026-10-01 真机复现的问题）：
//   「长期不发小房间消息的偶像」切进小房间时，页面此前保留上一帧（大房间）消息，
//   再叠加「只看偶像 0 条 → 自动展开群聊」，小房间被大房间的群聊内容整屏取代。
//   修复后：窗口期内偶像无发言 → 该侧只显示提示。判定本身（秒/毫秒时间戳、
//   恰好卡窗口边界、拿不到时间字段）写错不会抛异常，只会静默多显示/少显示一整屏消息，
//   只能靠这份可单测的纯函数兜住。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-idle-'));

const DAY = 24 * 60 * 60 * 1000;
/** 固定「现在」（2026-10-01 前后），避免测试随时钟漂移 */
const NOW = 1790851200000;

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
    `npx tsc "${join(root, 'src', 'utils', 'roomIdleNotice.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'roomIdleNotice.js')}`);
  const { isIdolIdle, lastIdolMsgMs, normMsgTimeMs, IDOL_IDLE_WINDOW_DAYS, IDOL_IDLE_WINDOW_MS } = mod;
  for (const fn of ['isIdolIdle', 'lastIdolMsgMs', 'normMsgTimeMs']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里没有 ${fn} —— 拒绝以「通过」结束`);
  }

  // 测试用的极简消息形态：idol=是否偶像（房主）发言，ms=时间
  const isIdol = (m) => !!m?.idol;
  const getMs = (m) => Number(m?.ms) || 0;

  await check('常量：窗口 7 天，且毫秒数与天数同源（文案里的 {days} 用它）', () => {
    assert.equal(IDOL_IDLE_WINDOW_DAYS, 7);
    assert.equal(IDOL_IDLE_WINDOW_MS, 7 * DAY);
  });

  await check('空列表 / 全是粉丝消息 → 判定「无消息」（小房间 0 条正是这个场景）', () => {
    assert.equal(isIdolIdle([], isIdol, getMs, NOW), true);
    assert.equal(isIdolIdle(undefined, isIdol, getMs, NOW), true);
    assert.equal(isIdolIdle([
      { idol: false, ms: NOW - 1000 },
      { idol: false, ms: NOW },
    ], isIdol, getMs, NOW), true);
  });

  await check('窗口内有偶像发言（1 分钟前 / 1 天前）→ 不算无消息', () => {
    assert.equal(isIdolIdle([{ idol: true, ms: NOW - 60000 }], isIdol, getMs, NOW), false);
    assert.equal(isIdolIdle([{ idol: true, ms: NOW - DAY }], isIdol, getMs, NOW), false);
  });

  await check('偶像发言全在窗口外（8 天前 / 恰好 7 天前）→ 判定「无消息」', () => {
    assert.equal(isIdolIdle([{ idol: true, ms: NOW - 8 * DAY }], isIdol, getMs, NOW), true);
    // 边界：严格「大于 cutoff」才算窗口内；正好 7 天前 = 已超出窗口
    assert.equal(isIdolIdle([{ idol: true, ms: NOW - IDOL_IDLE_WINDOW_MS }], isIdol, getMs, NOW), true);
  });

  await check('混合列表：粉丝刷屏不算数，偶像 8 天前 + 昨天有一条 → 不算无消息', () => {
    assert.equal(isIdolIdle([
      { idol: false, ms: NOW - 1000 },
      { idol: true, ms: NOW - 8 * DAY },
      { idol: true, ms: NOW - DAY },
      { idol: false, ms: NOW - 2 * DAY },
    ], isIdol, getMs, NOW), false);
    assert.equal(isIdolIdle([
      { idol: false, ms: NOW - 1000 },
      { idol: true, ms: NOW - 8 * DAY },
      { idol: false, ms: NOW - 2 * DAY },
    ], isIdol, getMs, NOW), true);
  });

  await check('时间字段取不到（0）的偶像消息按「有消息」处理（保守不提示，防误报）', () => {
    // 用户 2026-10-02：「房间群聊中明明有偶像发言却提示 7 天内无偶像消息」——
    // 时间字段取不到时无法断言它在窗口之外，判定改为**不报 idle**（少提示好过乱提示）。
    assert.equal(isIdolIdle([{ idol: true, ms: 0 }], isIdol, getMs, NOW), false);
    assert.equal(isIdolIdle([{ idol: true }], isIdol, getMs, NOW), false);
    // 反过来：时间明确的偶像消息（8 天前）仍照旧 → 无消息
    assert.equal(isIdolIdle([{ idol: true, ms: NOW - 8 * DAY }], isIdol, getMs, NOW), true);
  });

  await check('默认窗口 = 7 天：6 天前算「有」、7 天零 1 毫秒前算「无」', () => {
    assert.equal(isIdolIdle([{ idol: true, ms: NOW - 6 * DAY }], isIdol, getMs, NOW), false);
    assert.equal(isIdolIdle([{ idol: true, ms: NOW - 7 * DAY - 1 }], isIdol, getMs, NOW), true);
  });

  await check('runtime 口径：getMessageTime 吃秒/毫秒两种 msgTime', () => {
    const fromMsgTime = (m) => normMsgTimeMs(m?.msgTime);
    const nowSec = Math.floor(NOW / 1000);
    assert.equal(isIdolIdle([{ idol: true, msgTime: nowSec - 60 }], isIdol, fromMsgTime, NOW), false);
    assert.equal(isIdolIdle([{ idol: true, msgTime: nowSec - 8 * 86400 }], isIdol, fromMsgTime, NOW), true);
    assert.equal(isIdolIdle([{ idol: true, msgTime: NOW - DAY }], isIdol, fromMsgTime, NOW), false);
  });

  await check('normMsgTimeMs：秒 → 毫秒，非法值归 0', () => {
    assert.equal(normMsgTimeMs(1790851200), 1790851200000);
    assert.equal(normMsgTimeMs(1790851200000), 1790851200000);
    assert.equal(normMsgTimeMs('1790851200'), 1790851200000);
    assert.equal(normMsgTimeMs(''), 0);
    assert.equal(normMsgTimeMs('abc'), 0);
    assert.equal(normMsgTimeMs(0), 0);
    assert.equal(normMsgTimeMs(-5), 0);
  });

  await check('lastIdolMsgMs：取最新的偶像发言时间，没有则 0（诊断用）', () => {
    assert.equal(lastIdolMsgMs([{ idol: true, ms: 1 }, { idol: false, ms: 999 }, { idol: true, ms: 5 }], isIdol, getMs), 5);
    assert.equal(lastIdolMsgMs([{ idol: false, ms: 999 }], isIdol, getMs), 0);
    assert.equal(lastIdolMsgMs([], isIdol, getMs), 0);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[room-idle-notice] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
