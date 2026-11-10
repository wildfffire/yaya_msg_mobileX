// 异步竞态与缓存原语测试（纯 Node，零新增依赖）。
//
// 分两层，各自解决不同问题：
//   A. 行为测试 —— 真实编译并测试 src/utils/cache.ts 的三个原语（淘汰顺序 / 并发去重 / 失败后可重试）。
//      这些原语被歌词索引、房间背景图、R2 音乐、网络层共用，出问题就是「重复下载」「缓存不清理」。
//   B. 静态不变量 —— 断言「异步结果写回 state 之前必须比对请求代次」这道守卫**还存在**。
//
// ⚠️ 诚实说明 B 的边界：它只能防止「守卫被误删 / 回退」，**不能证明时序真的正确**。
//    原因是这些守卫内联在 Screen 组件里，纯 Node 环境跑不了 React。
//    真正的行为验证仍需真机手测（步骤见 docs/优化方案_小白版_2026-09-28.md 的测试方案）。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-async-guards-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

/** 粗略截出某个函数体（用于静态不变量检查；守卫逻辑在函数尾部，截长一点更稳）
 *  ⚠️ openRoom 很长（>8000 字符，2026-11-09 起又加了服务端未读地板），8000 会把
 *  尾部的「比对代次」截掉 → 误报「缺少比对」。放宽到 20000，截断标记不变。 */
function functionBody(source, startMarker, maxLen = 20000) {
  const start = source.indexOf(startMarker);
  if (start < 0) return null;
  const rest = source.slice(start, start + maxLen);
  let end = rest.length;
  for (const marker of ['\n  };', '\n  }, [']) {
    const idx = rest.indexOf(marker);
    if (idx > 0 && idx < end) end = idx;
  }
  return rest.slice(0, end);
}

try {
  execSync(
    // --rootDir 必须显式给，否则单文件输入时产物路径会变成 <tmp>/cache.js（见 network-timeout 里同款注释）
    `npx tsc "${join(root, 'src', 'utils', 'cache.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'cache.js')}`);
  const { trimToMax, trimRecordToMax, createInflight } = mod;
  if (!trimToMax || !trimRecordToMax || !createInflight) {
    throw new Error('未能从编译产物取到 cache 原语 —— 拒绝以「通过」结束');
  }

  // ---------- A. 行为测试 ----------

  await check('trimToMax：按插入顺序淘汰最旧项，压到上限以内', () => {
    const map = new Map();
    for (const k of ['a', 'b', 'c', 'd']) map.set(k, k);
    trimToMax(map, 2);
    assert.equal(map.size, 2);
    // 最旧的 a、b 被淘汰，留下的必须是最近插入的 c、d
    assert.deepEqual([...map.keys()], ['c', 'd']);
    trimToMax(map, 5); // 未超限时不得误删
    assert.equal(map.size, 2);
  });

  await check('trimRecordToMax：返回被淘汰项并真的从 record 删除', () => {
    const rec = { a: 1, b: 2, c: 3 };
    const dropped = trimRecordToMax(rec, 1);
    assert.deepEqual(dropped, [['a', 1], ['b', 2]]);
    assert.deepEqual(Object.keys(rec), ['c']);
  });

  await check('createInflight：同 key 并发只执行一次，且共享同一个结果', async () => {
    const once = createInflight();
    let runs = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const factory = async () => {
      runs += 1;
      await gate;
      return { data: 'x' };
    };
    const p1 = once.run('same', factory);
    const p2 = once.run('same', factory);
    assert.equal(p1, p2, '同 key 在途时必须复用同一个 Promise（这正是「只执行一次」的保证）');
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(runs, 1, `期望只执行 1 次，实际 ${runs} 次`);
    assert.deepEqual(r1, { data: 'x' });
    assert.deepEqual(r2, { data: 'x' });
  });

  await check('createInflight：不同 key 各自执行；settle 后清理、可再次执行', async () => {
    const once = createInflight();
    let runs = 0;
    const factory = async () => { runs += 1; return runs; };
    const [a, b] = await Promise.all([once.run('k1', factory), once.run('k2', factory)]);
    assert.equal(runs, 2, '不同 key 不应互相顶替');
    assert.deepEqual([a, b], [1, 2]);
    assert.equal(once.size, 0, 'settle 后必须清理，否则下次同 key 永远拿到旧结果');
    await once.run('k1', factory);
    assert.equal(runs, 3, '清理后同 key 应能重新执行');
  });

  await check('createInflight：失败后同样清理，允许重试（否则一次失败永久钉死）', async () => {
    const once = createInflight();
    let runs = 0;
    const failing = async () => { runs += 1; throw new Error('boom'); };
    await assert.rejects(() => once.run('bad', failing), /boom/);
    assert.equal(once.size, 0, 'reject 后必须清理');
    const ok = await once.run('bad', async () => { runs += 1; return 'ok'; });
    assert.equal(ok, 'ok');
    assert.equal(runs, 2);
  });

  // ---------- B. 静态不变量 ----------

  /**
   * 每一条都是「await 之后写回 state」的路径，必须同时具备
   * 「捕获代次」与「比对代次」两个动作，所以守卫标识符至少要出现 2 次。
   * 缺少时会发生什么（真实故障）：从 A 切到 B 之后，A 的慢响应把 A 的消息/游标写进 B。
   */
  const guardCases = [
    {
      file: 'src/screens/PrivateMessagesScreen.tsx',
      fn: 'const openConv = async (c: any) => {',
      guard: 'convRequestIdRef.current',
      label: '私信：切换会话（openConv）',
      // openConv 是「开新代次」的入口：必须递增（++），否则后面所有比对都拿不到新代次
      bump: true,
    },
    {
      file: 'src/screens/PrivateMessagesScreen.tsx',
      fn: 'const loadMore = async () => {',
      guard: 'convRequestIdRef.current',
      label: '私信：上拉加载历史（loadMore）',
    },
    {
      file: 'src/screens/FollowedRoomsScreen.tsx',
      fn: "const openRoom = useCallback(async (room: Member, nextMode: RoomMode = 'big', includeFans = showFanMessages, mode: 'internal' | 'enter' = 'enter') => {",
      guard: 'roomSeqRef.current',
      label: '房间：进房/切房（openRoom）',
      // 房间侧所有守卫都建立在这一处递增之上：它不递增，其它比对就永远「相等」
      bump: true,
    },
    {
      file: 'src/screens/FollowedRoomsScreen.tsx',
      fn: 'const loadMoreRoomMessages = useCallback(async () => {',
      guard: 'roomSeqRef.current',
      label: '房间：上拉加载历史（loadMoreRoomMessages）',
    },
    {
      file: 'src/screens/FollowedRoomsScreen.tsx',
      fn: 'const refreshRoomMessages = useCallback(async () => {',
      guard: 'roomSeqRef.current',
      label: '房间：15s 轮询刷新（refreshRoomMessages）',
    },
    {
      file: 'src/screens/FollowedRoomsScreen.tsx',
      fn: 'const handleSendRoomMessage = useCallback(async () => {',
      guard: 'roomSeqRef.current',
      label: '房间：发送成功回来清草稿（handleSendRoomMessage）',
    },
  ];

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const c of guardCases) {
    await check(`代次守卫完整（捕获 + 比对）：${c.label}`, () => {
      const source = readFileSync(join(root, c.file), 'utf8');
      const body = functionBody(source, c.fn);
      assert.ok(body, `未找到函数：${c.fn}（${c.file}）—— 函数被重命名/移动了，请同步更新本测试`);
      const g = escapeRe(c.guard);
      // 必须「捕获」与「比对」两种形态都在。
      // ⚠️ 只统计「出现次数 >= 2」是不够的：删掉捕获那行、只留两处比对，次数照样达标
      //（这是复核本测试时发现的假通过路径，所以改成分别断言两种形态）。
      // 捕获允许两种写法：`const x = ref.current`（普通捕获）与 `const x = ++ref.current`（开新代次）。
      assert.match(
        body,
        new RegExp(`const\\s+\\w+\\s*=\\s*(?:\\+\\+\\s*)?${g}`),
        `缺少「捕获代次」：${c.file} 的 ${c.fn} 内既没有 \`const xxx = ${c.guard}\`，` +
          `也没有 \`const xxx = ++${c.guard}\``,
      );
      assert.match(
        body,
        new RegExp(`[!=]=\\s*${g}`),
        `缺少「比对代次」：${c.file} 的 ${c.fn} 内没有 \`!== ${c.guard}\` 这样的比对语句。` +
          '缺了它会出现「切走后旧数据串进新会话/新房间」。',
      );
      if (c.bump) {
        assert.match(
          body,
          new RegExp(`\\+\\+\\s*${g}`),
          `缺少「递增代次」：${c.file} 的 ${c.fn} 是「开新代次」的入口，必须 \`++${c.guard}\`，` +
            '否则切走后旧的异步结果仍会被当成当前代次而写进新会话/新房间。',
        );
      }
    });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[async-guards] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
