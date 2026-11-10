// 房间列表排序规则回归锁（纯 Node，零新增依赖）。
//
// 为什么必须钉住：排序错不会抛异常，只表现为「房间顺序怪」——
// 尤其是 ① 置顶必须永远最前 ② 「新消息在上」关掉后不能再上浮
// ③ 自定义序里没列出的房间不能丢、也不能插到已列出的前面。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-sort-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const room = (id, ownerName, team = 'TEAM SII', pinyin = '') => ({
  memberId: id,
  member: { id, ownerName, team, pinyin },
});

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'roomListSort.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'roomListSort.js')}`);
  const { sortRooms, teamRank, normalizeTeamName, alphaKey } = mod;
  for (const fn of ['sortRooms', 'teamRank', 'normalizeTeamName', 'alphaKey']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里没有 ${fn} —— 拒绝以「通过」结束`);
  }

  const ids = (list) => list.map((r) => r.memberId);

  await check('置顶永远最前（即使关掉新消息在上、且自定义序把它排在后面）', () => {
    const list = [room('a', 'A'), room('pin', 'PIN'), room('b', 'B')];
    const out = sortRooms(list, {
      hasUnread: (r) => r.memberId === 'a' || r.memberId === 'b',
      pinnedIds: ['pin'],
      unreadFirst: false,
      mode: 'custom',
      customOrder: ['b', 'a', 'pin'],
    });
    assert.equal(ids(out)[0], 'pin');
  });

  await check('新消息在上：有未读的排在无未读之前（自定义序为空时组内保持原序）', () => {
    const list = [room('a', 'A'), room('b', 'B'), room('c', 'C'), room('d', 'D')];
    const out = sortRooms(list, {
      hasUnread: (r) => r.memberId === 'c' || r.memberId === 'd',
      pinnedIds: [],
      unreadFirst: true,
      mode: 'custom',
      customOrder: [],
    });
    assert.deepEqual(ids(out), ['c', 'd', 'a', 'b']);
  });

  await check('关掉新消息在上：不再上浮，整列按自定义序（未列出的排尾部保持原序）', () => {
    const list = [room('a', 'A'), room('b', 'B'), room('c', 'C'), room('d', 'D')];
    const out = sortRooms(list, {
      hasUnread: (r) => r.memberId === 'a',
      pinnedIds: [],
      unreadFirst: false,
      mode: 'custom',
      customOrder: ['d', 'b'],
    });
    assert.deepEqual(ids(out), ['d', 'b', 'a', 'c']);
  });

  await check('自定义序里不存在于列表的 id 被忽略（不产生空洞/崩溃）', () => {
    const list = [room('a', 'A'), room('b', 'B')];
    const out = sortRooms(list, {
      hasUnread: () => false,
      pinnedIds: [],
      unreadFirst: false,
      mode: 'custom',
      customOrder: ['zzz', 'b'],
    });
    assert.deepEqual(ids(out), ['b', 'a']);
  });

  await check('按队伍：队伍编号顺序 SII < NII < HII < X < G < NIII，未知队伍垫底', () => {
    const list = [
      room('g', 'G', 'TEAM G'),
      room('x', 'X', 'TEAM X'),
      room('nii', 'NII', 'TEAM NII'),
      room('unknown', 'U', 'TEAM ZZ'),
      room('sii', 'SII', 'TEAM SII'),
    ];
    const out = sortRooms(list, {
      hasUnread: () => false,
      pinnedIds: [],
      unreadFirst: false,
      mode: 'team',
      customOrder: [],
    });
    assert.deepEqual(ids(out), ['sii', 'nii', 'x', 'g', 'unknown']);
    assert.ok(teamRank('TEAM SII') < teamRank('TEAM G'));
    assert.equal(teamRank('TEAM ZZ'), teamRank(''));
    assert.equal(normalizeTeamName('team hii'), 'HII');
  });

  await check('按字母：优先拼音，无拼音回退昵称（大小写不敏感）', () => {
    const list = [
      room('b', 'Bravo', 'TEAM SII', 'chen'),
      room('a', 'Alpha', 'TEAM SII', 'an'),
      room('c', 'Charlie', 'TEAM SII', ''),
    ];
    const out = sortRooms(list, {
      hasUnread: () => false,
      pinnedIds: [],
      unreadFirst: false,
      mode: 'alpha',
      customOrder: [],
    });
    // an < charlie(cha) < chen(che)
    assert.deepEqual(ids(out), ['a', 'c', 'b']);
    assert.equal(alphaKey(list[2]), 'charlie');
  });

  await check('空列表 / 单元素：不抛错', () => {
    const opts = { hasUnread: () => false, pinnedIds: [], unreadFirst: true, mode: 'team', customOrder: [] };
    assert.deepEqual(sortRooms([], opts), []);
    assert.equal(sortRooms([room('a', 'A')], opts).length, 1);
  });

  await check('不修改入参（列表与对象都保持原样）', () => {
    const list = [room('b', 'B'), room('a', 'A')];
    const snapshot = ids(list);
    sortRooms(list, { hasUnread: () => false, pinnedIds: [], unreadFirst: false, mode: 'alpha', customOrder: [] });
    assert.deepEqual(ids(list), snapshot);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.error(`  ✗ ${r.name}\n    ${r.error?.message || r.error}`);
}
console.log(`\n房间列表排序：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
