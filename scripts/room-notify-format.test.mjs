// 房间通知文案 + 未读判定日志格式化的回归锁（纯 Node，零新增依赖）。
//
// 这两块是从 messagePollers.pollRooms 单侧循环里抽出来的纯计算：
//   · 通知文案：单条/多条、空正文回退、取时间最新一条；
//   · 判定日志：`id后缀:chat|other:idol|fan:server|local:claimed|new` 的逐字格式，
//     真机排查「没判新 / 房主没认出 / 总账拦下」全靠它，不能漂移。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-notify-format-'));

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
    `npx tsc "${join(root, 'src', 'utils', 'roomNotifyRules.ts')}" "${join(root, 'src', 'utils', 'roomUnreadFormat.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const notify = await import(`file://${join(tmp, 'src', 'utils', 'roomNotifyRules.js')}`);
  const format = await import(`file://${join(tmp, 'src', 'utils', 'roomUnreadFormat.js')}`);
  const { buildRoomNotifyContent } = notify;
  const { formatRoomUnreadSample, formatRoomUnreadSenders } = format;

  const t = (key, vars) => (key === '有 {n} 条新消息' ? `有 ${vars.n} 条新消息` : key);
  const notifyOpts = {
    textOf: (m) => m.text || '',
    previewOf: (m) => m.preview || '',
    timeOf: (m) => m.t || 0,
    t,
  };

  await check('单条：正文原样；空正文回退 preview；都空回退「新消息」', () => {
    const one = buildRoomNotifyContent([{ text: '你好', t: 100 }], notifyOpts);
    assert.equal(one.newest.text, '你好');
    assert.equal(one.body, '你好');
    const media = buildRoomNotifyContent([{ text: '', preview: '[图片]', t: 100 }], notifyOpts);
    assert.equal(media.body, '[图片]');
    const empty = buildRoomNotifyContent([{ text: '', preview: '', t: 100 }], notifyOpts);
    assert.equal(empty.body, '新消息');
  });

  await check('多条：取时间最新一条做正文，并加「有 N 条新消息：」前缀', () => {
    const content = buildRoomNotifyContent([
      { text: '早', t: 100 },
      { text: '晚', t: 300 },
      { text: '中', t: 200 },
    ], notifyOpts);
    assert.equal(content.newest.text, '晚');
    assert.equal(content.body, '有 3 条新消息：晚');
  });

  await check('时间相同保留靠前一条（与原 reduce 口径一致）', () => {
    const content = buildRoomNotifyContent([{ text: '前', t: 100 }, { text: '后', t: 100 }], notifyOpts);
    assert.equal(content.newest.text, '前');
  });

  await check('空数组 / null 安全', () => {
    assert.deepEqual(buildRoomNotifyContent([], notifyOpts), { newest: null, preview: '', body: '' });
    assert.deepEqual(buildRoomNotifyContent(null, notifyOpts), { newest: null, preview: '', body: '' });
  });

  await check('★ 判定样本逐字格式：id后缀:chat|other:idol|fan:server|local:claimed|new', () => {
    const sample = formatRoomUnreadSample([
      { id: '1234567890', chat: true, idol: true, server: true, claimed: false },
      { id: '0987654321', chat: false, idol: false, server: false, claimed: true },
    ], {
      idOf: (m) => m.id,
      isChat: (m) => m.chat,
      isIdol: (m) => m.idol,
      isServerOwner: (m) => m.server,
      isClaimed: (m) => m.claimed,
      max: 5,
    });
    assert.equal(sample, '34567890:chat:idol:server:new 87654321:other:fan:local:claimed');
  });

  await check('判定样本最多 5 条；发送者样本最多 3 条且占位符稳定', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `id-0000000${i}`, chat: true, idol: false, server: false, claimed: false,
    }));
    const sample = formatRoomUnreadSample(many, {
      idOf: (m) => m.id,
      isChat: (m) => m.chat,
      isIdol: (m) => m.idol,
      isServerOwner: (m) => m.server,
      isClaimed: (m) => m.claimed,
    });
    assert.equal(sample.split(' ').length, 5);

    const senders = formatRoomUnreadSenders([
      { id: '1234567890', p: { id: 'u1', name: '昵称' }, t: 100 },
      { id: '1234567891', p: null, t: 200 },
      { id: '1234567892', p: { id: 'u3', name: '第三' }, t: 300 },
      { id: '1234567893', p: { id: 'u4', name: '第四' }, t: 400 },
    ], {
      idOf: (m) => m.id,
      senderOf: (m) => m.p,
      timeOf: (m) => m.t,
    });
    assert.equal(senders, '34567890 id=u1 nick=昵称 t=100 | 34567891 id=- nick=- t=200 | 34567892 id=u3 nick=第三 t=300');
  });

  /* ── 接线守卫：轮询主循环必须调用抽出的纯规则，通知发送收口到一个函数 ── */
  const pollers = readFileSync(join(root, 'src', 'services', 'messagePollers.ts'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');
  await check('★ 接线：pollRooms 调用纯规则，通知发送只剩 notifyRoomSide 一处', () => {
    assert.ok(pollers.includes('buildRoomNotifyContent('), '通知文案走纯规则');
    assert.ok(pollers.includes('formatRoomUnreadSample('), '判定样本走纯规则');
    assert.ok(pollers.includes('formatRoomUnreadSenders('), '发送者样本走纯规则');
    assert.ok(pollers.includes('async function notifyRoomSide('), '单侧通知发送收口');
    assert.ok(pollers.includes('notifyMessage({'), '最终仍由通知中心发送');
    assert.ok(pollers.includes('if (cur.primed && idolFresh.length)'), '发送条件保持原样');
  });

  await check('本回归锁并入 test:core', () => {
    assert.ok(pkg.includes('room-notify-format.test.mjs'));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`room-notify-format: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
