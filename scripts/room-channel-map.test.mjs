// 实时消息「channelId → 房间/分侧」映射回归锁（纯 Node，零新增依赖）。
//
// 这张表决定实时消息计到哪个房间、哪一侧：大房间必须同时登记 channelId 与 serverId
//（圈组推送用哪个字段官方没文档），小房间用 yklzId。映射错了就是「A 房间消息计到 B」。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-channel-map-'));

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
    `npx tsc "${join(root, 'src', 'screens', 'room', 'roomChannelMap.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'screens', 'room', 'roomChannelMap.js')}`);
  const { buildChannelToRoomMap } = mod;

  await check('★ 大房间双 id（channelId + serverId）都映射到 big；小房间 yklzId → small', () => {
    const map = buildChannelToRoomMap([{
      memberId: '100',
      member: { id: '100', channelId: 'c1', serverId: 's1', yklzId: 'k1' },
    }]);
    assert.equal(map.c1.id, '100');
    assert.equal(map.c1.side, 'big');
    assert.equal(map.s1.id, '100');
    assert.equal(map.s1.side, 'big');
    assert.equal(map.k1.side, 'small');
  });

  await check('memberId 缺失时用 member.id；无 id / 无 member 跳过', () => {
    const map = buildChannelToRoomMap([
      { member: { id: '200', channelId: 'c2' } },
      { memberId: '', member: { channelId: 'c3' } },
      { memberId: '300' },
      null,
    ]);
    assert.equal(map.c2.id, '200');
    assert.equal(map.c3, undefined);
    assert.equal(Object.keys(map).length, 1);
  });

  await check('同一个 channel 后写覆盖（历史行为）；空/null 安全', () => {
    const map = buildChannelToRoomMap([
      { memberId: 'a', member: { channelId: 'same' } },
      { memberId: 'b', member: { channelId: 'same' } },
    ]);
    assert.equal(map.same.id, 'b');
    assert.deepEqual(buildChannelToRoomMap(null), {});
    assert.deepEqual(buildChannelToRoomMap([]), {});
  });

  const screen = readFileSync(join(root, 'src', 'screens', 'FollowedRoomsScreen.tsx'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');
  await check('★ 接线：页面用纯函数建表，旧的逐行拼装已删除', () => {
    assert.ok(screen.includes('buildChannelToRoomMap(followed)'), '页面必须调用纯函数');
    assert.ok(!screen.includes('const bigIds = [member?.channelId, member?.serverId]'),
      '旧的 inline 拼装不能再回来');
  });

  await check('本回归锁并入 test:core', () => {
    assert.ok(pkg.includes('room-channel-map.test.mjs'));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`room-channel-map: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
