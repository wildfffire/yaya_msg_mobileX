// 网络请求封装的「超时 / 取消 / 去重 / 缓存」行为测试（纯 Node，零新增依赖）。
//
// 为什么值得单独测：这是 P0 级缺陷的高发区 —— 本项目出现过
// 「超时逻辑接错线 → 请求永久挂起，加载圈一直转且不报错，只能杀 App」，
// 也出现过「调用方传了 signal 之后自身超时彻底失效 → 请求可无限挂起」。
// 这里把「能超时、能区分取消、同 URL 只发一次、TTL 内不再发」四条锁进自动化检查。
//
// 做法沿用仓库既有模式：先用本地 typescript 把 TS 编译到临时目录，再 import 编译产物。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-net-timeout-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}
function jsonResponse(body) {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}
/** 一个「永不 settle，但会响应 abort」的 fetch：用来模拟弱网/服务端无响应 */
function neverRespondingFetch() {
  return (_url, options) =>
    new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) return;
      if (signal.aborted) reject(abortError());
      else signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
}

try {
  execSync(
    // --rootDir 必须显式给：只传一个输入文件时，tsc 会把「该文件所在目录」当成根，
    // 产物会落到 <tmp>/network.js 而不是 <tmp>/src/utils/network.js（下面按后者的路径 import）。
    `npx tsc "${join(root, 'src', 'utils', 'network.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );

  const mod = await import(`file://${join(tmp, 'src', 'utils', 'network.js')}`);
  const requestJson = mod.requestJson ?? mod.default?.requestJson;
  if (typeof requestJson !== 'function') {
    throw new Error('未能从编译产物取到 requestJson —— 拒绝以「通过」结束');
  }

  // ① 超时：fetch 永不返回时必须在 timeout 量级内失败，而不是永久挂起
  await check('超时：服务端不响应时在 timeout 内失败（不永久挂起）', async () => {
    globalThis.fetch = neverRespondingFetch();
    const t0 = Date.now();
    await assert.rejects(
      () => requestJson('https://example.test/timeout', { method: 'GET', timeout: 80 }),
      (e) => {
        assert.match(String(e.message), /网络请求超时/);
        return true;
      },
    );
    const used = Date.now() - t0;
    assert.ok(used < 1500, `应在 80ms 量级返回，实际 ${used}ms`);
  });

  // ② 取消：外部 signal 中止时要报「请求已取消」，不能误报成超时（否则切页瞬间凭空冒出超时错误态）
  await check('取消：外部 signal 中止时报「请求已取消」而非「超时」', async () => {
    globalThis.fetch = neverRespondingFetch();
    const controller = new AbortController();
    const p = requestJson('https://example.test/cancel', {
      method: 'GET',
      timeout: 5000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      () => p,
      (e) => {
        assert.match(String(e.message), /请求已取消/);
        return true;
      },
    );
  });

  // ③ 并发去重：同一时刻相同 URL 的 GET 只真正发一次
  await check('去重：同 URL 并发 GET 只真正发一次请求', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    globalThis.fetch = async () => {
      calls += 1;
      await gate;
      return jsonResponse('{"n":1}');
    };
    const p1 = requestJson('https://example.test/dedupe', { method: 'GET' });
    const p2 = requestJson('https://example.test/dedupe', { method: 'GET' });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(calls, 1, `期望只发 1 次，实际 ${calls} 次`);
    assert.deepEqual(r1, { n: 1 });
    assert.deepEqual(r2, { n: 1 });
  });

  // ④ GET TTL 缓存：TTL 内第二次调用不再发请求
  await check('缓存：GET 带 cacheTtl 时 TTL 内不再发请求', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse('{"v":7}');
    };
    const url = 'https://example.test/ttl';
    const r1 = await requestJson(url, { method: 'GET', cacheTtl: 5000 });
    const r2 = await requestJson(url, { method: 'GET', cacheTtl: 5000 });
    assert.equal(calls, 1, `期望 1 次，实际 ${calls} 次`);
    assert.deepEqual(r1, { v: 7 });
    assert.deepEqual(r2, { v: 7 });
  });

  // ⑤ GET 缓存过期后必须重新请求（防「缓存把过期数据永久钉住」）
  await check('缓存：TTL 过期后重新发请求', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(`{"v":${calls}}`);
    };
    const url = 'https://example.test/ttl-expire';
    await requestJson(url, { method: 'GET', cacheTtl: 30 });
    await new Promise((r) => setTimeout(r, 60));
    const r2 = await requestJson(url, { method: 'GET', cacheTtl: 30 });
    assert.equal(calls, 2, `期望过期后重发（共 2 次），实际 ${calls} 次`);
    assert.deepEqual(r2, { v: 2 });
  });
} finally {
  globalThis.fetch = undefined;
  rmSync(tmp, { recursive: true, force: true });
}

// 输出与退出码（仓库既有风格：逐条 ✓/✗ + 汇总 + 失败即非 0）
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[network] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
