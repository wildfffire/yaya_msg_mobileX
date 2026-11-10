// 房间未读「分大/小房间」规则测试（纯 Node，零新增依赖）。
//
// 为什么必须钉住这一层：分侧之后 `counts` / `seenTokens` 的键变成
// `${memberId}#b` / `${memberId}#s`，键拼错**不会抛异常** ——
// 表现是「数字恒为 0」或「两侧串味」（大房间的数字长在小房间那一行），
// 只靠肉眼很难在真机上发现。而且它同时是「房间行角标」与「列表新消息上浮」的判据，
// 口径必须唯一（不一致就会出现「角标亮了但房间没上浮」）。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-unread-'));

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
    `npx tsc "${join(root, 'src', 'utils', 'roomUnreadRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'roomUnreadRules.js')}`);
  const { roomSideKey, roomUnreadKey, roomUnreadCount, roomUnreadTotal, roomUnreadBadge, roomSideHasNew, ROOM_UNREAD_SIDES } = mod;
  for (const fn of ['roomSideKey', 'roomUnreadKey', 'roomUnreadCount', 'roomUnreadTotal', 'roomUnreadBadge', 'roomSideHasNew']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里没有 ${fn} —— 拒绝以「通过」结束`);
  }

  await check('两侧顺序稳定：big 在前、small 在后（渲染顺序不能随键顺序漂移）', () => {
    assert.deepEqual([...ROOM_UNREAD_SIDES], ['big', 'small']);
  });

  await check('roomUnreadKey：大房间 #b / 小房间 #s，空 id 返回空串', () => {
    assert.equal(roomUnreadKey('123', 'big'), '123#b');
    assert.equal(roomUnreadKey('123', 'small'), '123#s');
    assert.equal(roomUnreadKey(456, 'small'), '456#s'); // 数字 id 也要能用
    assert.equal(roomUnreadKey('', 'big'), '');
    assert.equal(roomUnreadKey(undefined, 'big'), '');
    assert.equal(roomUnreadKey(null, 'small'), '');
  });

  await check('roomSideKey 与 roomUnreadKey 同源：消息缓存/归属也用同一套分侧键（防两套键串味）', () => {
    for (const [id, side] of [['123', 'big'], ['123', 'small'], [456, 'small'], ['', 'big'], [null, 'small']]) {
      assert.equal(roomSideKey(id, side), roomUnreadKey(id, side));
    }
    assert.equal(roomSideKey('123', 'big'), '123#b');
    assert.equal(roomSideKey('123', 'small'), '123#s');
  });

  await check('roomUnreadCount：取单侧条数，缺键 / 非法值 / 负数一律 0', () => {
    const counts = { '9#b': 3, '9#s': 5 };
    assert.equal(roomUnreadCount(counts, '9', 'big'), 3);
    assert.equal(roomUnreadCount(counts, '9', 'small'), 5);
    assert.equal(roomUnreadCount(counts, '8', 'big'), 0); // 缺键
    assert.equal(roomUnreadCount(undefined, '9', 'big'), 0); // 表还没 hydrate
    assert.equal(roomUnreadCount({ '9#b': -2 }, '9', 'big'), 0);
    assert.equal(roomUnreadCount({ '9#b': 'abc' }, '9', 'big'), 0);
    assert.equal(roomUnreadCount({ '9#b': '7' }, '9', 'big'), 7); // 字符串数字（磁盘回读）
  });

  await check('串味回归锁：同一 memberId 的两侧互不影响', () => {
    const counts = { '7#b': 2 };
    assert.equal(roomUnreadCount(counts, '7', 'big'), 2);
    assert.equal(roomUnreadCount(counts, '7', 'small'), 0, '大房间有数字时小房间必须仍是 0');
    // 前缀相近的 id 不能互相命中（如 7 vs 70）
    assert.equal(roomUnreadCount({ '70#b': 4 }, '7', 'big'), 0);
  });

  await check('roomUnreadTotal：两侧相加 = 房间总数，容错空表与脏值', () => {
    assert.equal(roomUnreadTotal({ '1#b': 2, '1#s': 3, '2#b': 1 }), 6);
    assert.equal(roomUnreadTotal({}), 0);
    assert.equal(roomUnreadTotal(undefined), 0);
    assert.equal(roomUnreadTotal({ '1#b': '4', '1#s': null, '2#b': -5 }), 4);
  });

  await check('★ 单一数据源：角标只有「数字 / 不显示」，不再有「新」中间态', () => {
    assert.deepEqual(roomUnreadBadge(0), { kind: 'none', text: '' });
    assert.deepEqual(roomUnreadBadge(1), { kind: 'count', text: '1' });
    assert.deepEqual(roomUnreadBadge(99, false), { kind: 'count', text: '99' });
    assert.deepEqual(roomUnreadBadge(100), { kind: 'count', text: '99+' });
    assert.deepEqual(roomUnreadBadge(-3), { kind: 'none', text: '' });
    // 第二参数（旧 hasNew）即使误传 true 也不能再变出「新」
    assert.notEqual(roomUnreadBadge(0, true).kind, 'new');
  });

  await check('★ 单一数据源：roomSideHasNew 只认累计条数', () => {
    assert.equal(roomSideHasNew(0), false);
    assert.equal(roomSideHasNew(-1), false);
    assert.equal(roomSideHasNew(1), true);
    assert.equal(roomSideHasNew('2'), true);
    assert.equal(roomSideHasNew(undefined), false);
  });

  await check('★ 接线：角标 / 上浮 / tab 三处都不再读指纹与时间', () => {
    const rules = readFileSync(join(root, 'src', 'utils', 'roomUnreadRules.ts'), 'utf8');
    const screen = readFileSync(join(root, 'src', 'screens', 'FollowedRoomsScreen.tsx'), 'utf8');
    const row = readFileSync(join(root, 'src', 'screens', 'room', 'RoomListRow.tsx'), 'utf8');
    const nav = readFileSync(join(root, 'src', 'navigation', 'index.tsx'), 'utf8');
    // 纯规则里不能再出现 activity/token/seen 判据
    assert.ok(!rules.includes('token !== seen'), '指纹判据必须退出「有没有新消息」');
    assert.ok(!rules.includes('activity > lastRead'), '时间判据必须退出「有没有新消息」');
    assert.ok(!rules.includes("kind: 'new'"), '角标形态不能再有「新」');
    // 组件：只传数字、只认数字
    assert.ok(screen.includes('bigCount={bigCount}') && screen.includes('smallCount={smallCount}'));
    assert.ok(!screen.includes('bigNew=') && !screen.includes('smallNew='), '行 props 不能再传 hasNew');
    assert.ok(!screen.includes('roomServerFloor'), '服务端未读地板不能作为第二套显示数据源');
    assert.ok(!row.includes("t('新')"), '行内不能再渲染「新」字');
    assert.ok(row.includes('bigCount > 0') && row.includes('smallCount <= 0'), '大小房间行的显示条件也统一到数字');
    // tab 本来就只认 counts，保持
    assert.ok(nav.includes('sumRoomUnread(s.counts)'), 'Rooms tab 必须继续只认 counts');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[room-unread-rules] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
