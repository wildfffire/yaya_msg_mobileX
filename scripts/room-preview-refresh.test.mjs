// 房间列表「大/小各一条最新消息」快扫规则与接线回归锁（纯 Node，零新增依赖）。
//
// 用户 2026-11-13：「房间列表里不是会有大小房间各展示一条消息吗，这个有些延迟」。
// 真机 logcat 实证：5s 通知轮询连续 11 轮「查详情=0」，只有每 ~65s 的
// sweep 才「查详情=20」；页面层又订阅整张预览表却没有 FlatList extraData，
// 新正文写进 store 后还要等下一轮 setFollowed 才显示。
// 本测试锁住：分侧任务 / 分片轮转 / 只取房主发言 / 不碰计数 / 接线不回退。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-preview-refresh-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const row = (id, extra = {}) => ({
  memberId: id,
  member: {
    id,
    channelId: `${id}001`,
    serverId: `${id}009`,
    yklzId: `${id}002`,
    ...extra,
  },
});

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'roomPreviewRefreshRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'roomPreviewRefreshRules.js')}`);
  const { buildPreviewSides, previewSidesForRound, pickPreviewMessage } = mod;

  /* ── 分侧任务 ─────────────────────────────────────────── */
  await check('★ 一个房间拆成大/小两侧：大用 channelId，小用 yklzId', () => {
    const sides = buildPreviewSides([row('100')]);
    assert.equal(sides.length, 2);
    assert.deepEqual(sides.map((s) => `${s.id}#${s.side}`), ['100#big', '100#small']);
    assert.equal(sides[0].channelId, '100001');
    assert.equal(sides[1].channelId, '100002');
    assert.equal(sides[1].serverId, '100009');
  });

  await check('去重 / 缺侧 / 无成员 / 上限：不会重复请求也不会撑爆', () => {
    const dup = buildPreviewSides([row('100'), row('100')]);
    assert.equal(dup.length, 2, '同一成员重复行只留一份');
    const onlyBig = buildPreviewSides([row('100', { yklzId: '' })]);
    assert.equal(onlyBig.length, 1);
    assert.equal(onlyBig[0].side, 'big');
    assert.equal(buildPreviewSides([{ memberId: '100' }]).length, 0, '没有 member 直接跳过');
    const many = buildPreviewSides(Array.from({ length: 30 }, (_, i) => row(String(1000 + i))), 5);
    assert.equal(many.length, 5, 'maxSides 是硬上限');
    assert.equal(buildPreviewSides(null).length, 0);
  });

  /* ── 分片轮转 ─────────────────────────────────────────── */
  await check('★ 20 侧分 3 片：每轮请求量摊平，3 轮覆盖全部', () => {
    const sides = Array.from({ length: 20 }, (_, i) => i);
    const seen = new Set();
    for (let round = 0; round < 3; round += 1) {
      const picked = previewSidesForRound(sides, round, 3);
      assert.equal(picked.length, 7, 'ceil(20/3)=7');
      picked.forEach((v) => {
        assert.ok(sides.includes(v), '不能越界或造出不存在的侧');
        seen.add(v);
      });
    }
    assert.equal(seen.size, 20, '3 轮（5s × 3 = 15s）必须覆盖全部侧');
  });

  await check('轮转起点随轮次前移，不会永远饿死末尾的侧', () => {
    const sides = Array.from({ length: 9 }, (_, i) => i);
    assert.deepEqual(previewSidesForRound(sides, 0, 3), [0, 1, 2]);
    assert.deepEqual(previewSidesForRound(sides, 1, 3), [3, 4, 5]);
    assert.deepEqual(previewSidesForRound(sides, 2, 3), [6, 7, 8]);
    assert.deepEqual(previewSidesForRound(sides, 3, 3), [0, 1, 2]);
    assert.deepEqual(previewSidesForRound([], 0, 3), []);
  });

  /* ── 只取房主发言 ─────────────────────────────────────── */
  const opts = (ids) => ({
    isChat: (m) => m.type === 'TEXT' || m.type === 'REPLY',
    isOwner: (m) => ids.includes(m.from),
    timeOf: (m) => m.t || 0,
  });

  await check('★ 页内最新是粉丝 → 取更靠后的偶像发言，绝不拿粉丝顶预览', () => {
    const page = [
      { from: 'fan', type: 'TEXT', t: 1000, text: '粉丝最新' },
      { from: 'owner', type: 'REPLY', t: 900, text: '偶像回复' },
    ];
    const hit = pickPreviewMessage(page, opts(['owner']));
    assert.equal(hit.text, '偶像回复');
  });

  await check('整页没有偶像 / 非聊天类型 → null（保留上一次预览）', () => {
    assert.equal(pickPreviewMessage([{ from: 'fan', type: 'TEXT', t: 10 }], opts(['owner'])), null);
    assert.equal(pickPreviewMessage([{ from: 'owner', type: 'NOTICE', t: 10 }], opts(['owner'])), null);
    assert.equal(pickPreviewMessage(null, opts(['owner'])), null);
  });

  await check('时间乱序取时间最大的偶像；时间全为 0 时取页内最靠前', () => {
    const page = [
      { from: 'owner', type: 'TEXT', t: 100, text: '旧' },
      { from: 'owner', type: 'TEXT', t: 900, text: '新' },
      { from: 'owner', type: 'TEXT', t: 500, text: '中' },
    ];
    assert.equal(pickPreviewMessage(page, opts(['owner'])).text, '新');
    const noTime = [
      { from: 'owner', type: 'TEXT', t: 0, text: '靠前' },
      { from: 'owner', type: 'TEXT', t: 0, text: '靠后' },
    ];
    assert.equal(pickPreviewMessage(noTime, opts(['owner'])).text, '靠前');
    assert.equal(pickPreviewMessage(page, { ...opts(['owner']), scanLimit: 1 }).text, '旧');
  });

  /* ── 静态接线守卫 ─────────────────────────────────────── */
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const screen = read(join('src', 'screens', 'FollowedRoomsScreen.tsx'));
  const listRow = read(join('src', 'screens', 'room', 'RoomListRow.tsx'));
  const service = read(join('src', 'services', 'roomPreviewRefresh.ts'));
  const pkg = read('package.json');

  await check('★ 页面不再订阅整张预览表；行组件按键订阅字符串', () => {
    assert.ok(!screen.includes('useRoomPreviewTextStore((s) => s.map)'),
      '页面层订阅整张表会让每次写入都整屏重渲染');
    assert.ok(listRow.includes("useRoomPreviewTextStore((s) => previewTextOf(s.map, previewId, 'big'))"));
    assert.ok(listRow.includes("useRoomPreviewTextStore((s) => previewTextOf(s.map, previewId, 'small'))"));
    assert.ok(!screen.includes('bigPreviewText={bigPreviewText}'), '预览文本不能再由父级 props 传');
  });

  await check('★ 三条写入通道都在：实时秒级 / 分片快扫 / 首屏·回前台·下拉 force', () => {
    assert.ok(screen.includes('setPreview(hit.id, hit.side'), '圈组实时消息要直接写预览');
    assert.ok(screen.includes('setInterval(run, 5000)'), '列表页 5s 分片快扫');
    assert.ok(screen.includes('refreshRoomListPreviews(followedRows, { force: true })'), '首屏全量');
    assert.ok(screen.includes('refreshRoomListPreviews(followedRef.current, { force: true })'), '回前台/下拉全量');
  });

  await check('★ 快扫只读：不碰计数 / 游标 / 通知，只认 /list/all 页', () => {
    assert.ok(service.includes('fetchAll: true'));
    assert.ok(service.includes("startsWith('all')"), 'owner 回退页会把预览拽回过去');
    assert.ok(service.includes('isDetailFromSide('), '小房间串味防护');
    assert.ok(service.includes('isOwnerMessageStrict('), '只显示房主本人发言');
    assert.ok(service.includes('setPreview(s.id, s.side'));
    assert.ok(!service.includes('claimCountId') && !service.includes('applyUnread')
      && !service.includes('advanceCursor') && !service.includes('notifyMessage'),
      '快扫不得影响角标 / 游标 / 通知');
  });

  await check('本回归锁并入 test:core', () => {
    assert.ok(pkg.includes('room-preview-refresh.test.mjs'));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`room-preview-refresh: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
