// 通知发送 / 重试计数回归锁（纯 Node，零新增依赖）。
//
// 私信与房间原来各写一遍「超限放弃 / 发送 / 失败 +1 / 成功清」，
// 现在统一到 services/notifyDispatch.ts；本测试同时锁重试表行为与接线。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-notify-dispatch-'));

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
    `npx tsc "${join(root, 'src', 'services', 'notifyAttempts.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'services', 'notifyAttempts.js')}`);
  const {
    MAX_NOTIFY_ATTEMPTS,
    notifyAttemptCount,
    markNotifyAttemptFailed,
    clearNotifyAttempt,
    clearAllNotifyAttempts,
    notifyAttemptsSize,
  } = mod;

  await check('重试表：失败累加、成功清理、整体清理、上限为 12', () => {
    assert.equal(MAX_NOTIFY_ATTEMPTS, 12);
    clearAllNotifyAttempts();
    assert.equal(notifyAttemptCount('k'), 0);
    markNotifyAttemptFailed('k');
    markNotifyAttemptFailed('k');
    assert.equal(notifyAttemptCount('k'), 2);
    clearNotifyAttempt('k');
    assert.equal(notifyAttemptCount('k'), 0);
    markNotifyAttemptFailed('a');
    markNotifyAttemptFailed('b');
    assert.equal(notifyAttemptsSize(), 2);
    clearAllNotifyAttempts();
    assert.equal(notifyAttemptsSize(), 0);
  });

  const pollers = readFileSync(join(root, 'src', 'services', 'messagePollers.ts'), 'utf8');
  const dispatch = readFileSync(join(root, 'src', 'services', 'notifyDispatch.ts'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');
  await check('★ 接线：两条通道都走 dispatchNotify，轮询层不再手写重试计数', () => {
    assert.ok(pollers.includes('await dispatchNotify({'), '私信/房间都要走统一入口');
    assert.ok(pollers.includes('onGiveUp:'), '超限日志由调用方提供');
    assert.ok(pollers.includes('onError:'), '异常日志由调用方提供');
    assert.ok(pollers.includes('notifyMessage({'), '最终仍由通知中心发送');
    assert.ok(!pollers.includes('notifyAttemptCount('), '轮询层不能再自己读重试次数');
    assert.ok(!pollers.includes('markNotifyAttemptFailed('), '轮询层不能再自己记失败');
    assert.ok(!pollers.includes('clearNotifyAttempt('), '轮询层不能再自己清计数');
    assert.ok(dispatch.includes('MAX_NOTIFY_ATTEMPTS'), '上限判定收口在 dispatch');
    assert.ok(dispatch.includes("outcome === 'failed'"), '失败才计数');
  });

  await check('本回归锁并入 test:core', () => {
    assert.ok(pkg.includes('notify-dispatch-rules.test.mjs'));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`notify-dispatch-rules: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
