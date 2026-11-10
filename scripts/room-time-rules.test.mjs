// 房间「时间与文本」原语测试（纯 Node，零新增依赖）。
//
// 为什么优先测这一层：`src/screens/room/timeRules.ts` 是**零依赖**的纯函数层，
// 而且它承载了历史上 bug 最集中的两件事 ——
//   ① **秒 / 毫秒归一**：接口时间单位不统一，比较错就会「未读永远不亮」；
//   ② **消息排序**：排序键与展示时间不一致时，最新一条会跑到列表最上面。
// 另外这里还能钉住一个隐蔽陷阱：19 位的 `liveId` 长得像时间戳，绝不能当时间用。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-time-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const SEC = 1759000000; // 2025-09-27 左右的「秒」级时间戳
const MS = SEC * 1000;

try {
  execSync(
    `npx tsc "${join(root, 'src', 'screens', 'room', 'timeRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'screens', 'room', 'timeRules.js')}`);
  const { normMs, asTimestamp, getMessageTime, sortMessagesNewestFirst, capText, deepFindText, KNOWN_TIME_KEYS } = mod;
  for (const fn of ['normMs', 'asTimestamp', 'getMessageTime', 'sortMessagesNewestFirst', 'capText', 'deepFindText']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里缺少 ${fn} —— 拒绝以「通过」结束`);
  }

  await check('normMs：秒 → 毫秒，已是毫秒则不变，非法值归零', () => {
    assert.equal(normMs(SEC), MS);
    assert.equal(normMs(MS), MS);
    assert.equal(normMs('1759000000'), MS); // 字符串形态（接口常见）
    assert.equal(normMs(0), 0);
    assert.equal(normMs(-1), 0);
    assert.equal(normMs(undefined), 0);
    assert.equal(normMs('abc'), 0);
  });

  await check('asTimestamp：只接受「像消息时间」的值，19 位 liveId 必须被拒', () => {
    assert.equal(asTimestamp(SEC), MS);
    assert.equal(asTimestamp(String(SEC)), MS);
    assert.equal(asTimestamp(MS), MS);
    // 关键回归锁：liveId 是 19 位数字，归一后远超 4e12 → 必须返回 0（否则排序/未读全乱）
    assert.equal(asTimestamp('3456789012345678901'), 0);
    assert.equal(asTimestamp('7000000000000'), 0); // 超出 2096 年上限
    assert.equal(asTimestamp(0), 0);
    assert.equal(asTimestamp(null), 0);
  });

  await check('getMessageTime：四种已知键 + 嵌套 + 深层兜底', () => {
    assert.equal(getMessageTime({ msgTime: SEC }), MS);
    assert.equal(getMessageTime({ messageTime: SEC }), MS);
    assert.equal(getMessageTime({ ctime: SEC }), MS);
    assert.equal(getMessageTime({ time: SEC }), MS);
    // 一层子对象里的已知键
    assert.equal(getMessageTime({ content: { ctime: SEC } }), MS);
    // 键名像时间的字段（无文档接口的兜底路径）
    assert.equal(getMessageTime({ data: { sendTime: SEC } }), MS);
    // 取不到就归零，而不是拿 id 充数
    assert.equal(getMessageTime({ id: '3456789012345678901' }), 0);
    assert.equal(getMessageTime({}), 0);
    assert.equal(getMessageTime(null), 0);
    assert.ok(KNOWN_TIME_KEYS.includes('msgTime'));
  });

  await check('sortMessagesNewestFirst：最新在前（列表首项 = 最新）', () => {
    const list = [
      { id: 'old', msgTime: SEC - 100 },
      { id: 'new', msgTime: SEC },
      { id: 'mid', msgTime: SEC - 50 },
    ];
    const sorted = sortMessagesNewestFirst(list);
    assert.deepEqual(sorted.map((m) => m.id), ['new', 'mid', 'old']);
    // 不得就地修改入参（列表数据常被多处复用）
    assert.deepEqual(list.map((m) => m.id), ['old', 'new', 'mid']);
  });

  await check('capText：超长按 max-1 截断并加省略号', () => {
    assert.equal(capText('短名字'), '短名字');
    assert.equal(capText('  '), '');
    assert.equal(capText('一二三四五六', 4), '一二三…');
    assert.equal(capText('abc', 3), 'abc'); // 正好等于上限不截断
  });

  await check('deepFindText：按 key 深度查找，超深/字符串节点返回空', () => {
    assert.equal(deepFindText({ a: { b: { nickName: '阿丽' } } }, ['nickName']), '阿丽');
    assert.equal(deepFindText({ list: [{ nickName: '小北' }] }, ['nickName']), '小北');
    assert.equal(deepFindText({ nothing: 'x' }, ['nickName']), '');
    // 顶层值是字符串时不参与匹配（README 里记录的语义）
    assert.equal(deepFindText('阿丽', ['nickName']), '');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[room-time] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
