// 房间列表「最新消息」预览 ↔ 成员匹配规则测试（纯 Node，零新增依赖）。
//
// 为什么必须钉住这一层（用户 2026-11-11「房间列表里有的成员有新消息不会计数也不显示」）：
// `last/message/get` 的条目只有 serverId/channelId/msgContent/starName，一个 server 下最多两条
//（大房间 channelId + 小房间 yklzId）。成员库的频道一旦漂移，精确匹配恒 null →
// 列表没有预览、指纹恒空 → 30s 指纹计数与 5s 轮询都跳过该成员（既不计数也不显示）。
// 兜底只能「同 server 内消歧」，且**宁缺勿错**：猜错就是把大房间的数字记到小房间。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-preview-match-'));

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error }); }
}
function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

/** 一条 last/message/get 预览条目（真机字段：serverId/channelId/msgContent/starName） */
const entry = (serverId, channelId, text = 'hi') => ({
  serverId, channelId, msgContent: text, starName: '某偶像',
});

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'roomPreviewMatch.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'roomPreviewMatch.js')}`);
  const { pickBigPreview, pickSmallPreview, sameRoomId } = mod;
  for (const fn of ['pickBigPreview', 'pickSmallPreview', 'sameRoomId']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里没有 ${fn} —— 拒绝以「通过」结束`);
  }

  const member = { id: '123', channelId: '111', serverId: '999', yklzId: '222' };

  await check('id 归一：空串 / 0 / undefined / null 都不算 id', () => {
    assert.equal(sameRoomId('111', 111), true);
    assert.equal(sameRoomId('111', ' 111 '), true);
    assert.equal(sameRoomId('0', '0'), false);
    assert.equal(sameRoomId('', ''), false);
    assert.equal(sameRoomId('undefined', 'undefined'), false);
    assert.equal(sameRoomId('null', 'null'), false);
    assert.equal(sameRoomId('111', '222'), false);
  });

  await check('精确命中：大房间取 channelId、小房间取 yklzId', () => {
    const list = [entry(999, 111, '大'), entry(999, 222, '小')];
    assert.equal(pickBigPreview(list, member).msgContent, '大');
    assert.equal(pickSmallPreview(list, member).msgContent, '小');
  });

  await check('★ 大房间 channelId 漂移（库里旧频道）：同 server 排除小房间后仍能认回', () => {
    const list = [entry(999, 333, '新大'), entry(999, 222, '小')];
    assert.equal(pickBigPreview(list, member).msgContent, '新大');
    assert.equal(pickSmallPreview(list, member).msgContent, '小', '小房间仍按 yklzId 精确命中');
  });

  await check('★ 小房间 yklzId 漂移：大房间精确命中时，另一条认成小房间', () => {
    const list = [entry(999, 111, '大'), entry(999, 444, '新小')];
    assert.equal(pickBigPreview(list, member).msgContent, '大');
    assert.equal(pickSmallPreview(list, member).msgContent, '新小');
  });

  await check('★ 防串味：两侧都漂移时宁缺勿错（不能瞎猜哪条是大/小）', () => {
    const list = [entry(999, 333, 'A'), entry(999, 444, 'B')];
    assert.equal(pickBigPreview(list, member), null);
    assert.equal(pickSmallPreview(list, member), null);
  });

  await check('★ 防串味：大房间没精确命中时不能把另一条当小房间', () => {
    const list = [entry(999, 333, '未知'), entry(999, 444, '未知2')];
    assert.equal(pickSmallPreview(list, member), null);
  });

  await check('该 server 下只有一条：大房间没消息（条目是小房间）→ 大房间为 null', () => {
    const list = [entry(999, 222, '只有小')];
    assert.equal(pickBigPreview(list, member), null);
    assert.equal(pickSmallPreview(list, member).msgContent, '只有小');
  });

  await check('该成员没有小房间（库里无 yklzId）：只有一条时按大房间认', () => {
    const noSmall = { id: '123', channelId: '111', serverId: '999' };
    const list = [entry(999, 111, '大')];
    assert.equal(pickBigPreview(list, noSmall).msgContent, '大');
    assert.equal(pickSmallPreview(list, noSmall), null);
  });

  await check('不同 server 的条目互不污染（同 server 兜底只看自己的 serverId）', () => {
    // 别人的频道 id 与我们的都不同：精确与兜底都不能认
    const list = [entry(888, 777, '别人的大'), entry(888, 888, '别人的小')];
    assert.equal(pickBigPreview(list, member), null);
    assert.equal(pickSmallPreview(list, member), null);
  });

  await check('旧口径保留：条目带发送者 id 时按成员 id 认大房间', () => {
    const list = [{ serverId: 999, channelId: 777, userId: 123, msgContent: '按发送者' }];
    assert.equal(pickBigPreview(list, member).msgContent, '按发送者');
  });

  await check('没有 serverId 时不做兜底（无法确认归属）', () => {
    const noServer = { id: '123', channelId: '111', yklzId: '222' };
    const list = [entry(999, 333, 'A')];
    assert.equal(pickBigPreview(list, noServer), null);
    assert.equal(pickSmallPreview(list, noServer), null);
  });

  await check('空输入安全', () => {
    assert.equal(pickBigPreview([], member), null);
    assert.equal(pickBigPreview(null, member), null);
    assert.equal(pickBigPreview([entry(999, 111)], null), null);
    assert.equal(pickSmallPreview([entry(999, 222)], undefined), null);
  });

  /* ── 静态接线守卫 ───────────────────────────────────────── */
  const identity = read('src/screens/room/roomIdentity.ts');
  const counters = read('src/screens/room/useRoomUnreadCounters.ts');
  const pollers = read('src/services/messagePollers.ts');

  await check('接线：房间列表的预览匹配必须走这套纯规则', () => {
    assert.ok(identity.includes('pickBigPreview(') && identity.includes('pickSmallPreview('),
      'findLastMessage/findSmallLastMessage 必须复用 roomPreviewMatch');
    assert.ok(!identity.includes('messages.find((msg) => String(msg.channelId || \'\') === ykid)'),
      '旧的小房间精确匹配（单一路径）不能回退');
  });

  await check('接线：30s 精确计数用「侧基线 + 房间已读基线」双下限，不再整批吞掉', () => {
    assert.ok(counters.includes('isCountableUnreadMessage('), '时间门槛必须走统一纯函数');
    assert.ok(counters.includes('readAtNow'), '必须读 lastReadAt 作为计数下限');
    assert.ok(counters.includes('countNewMessagesForSide(\n          t,'), '调用处要传已读基线');
    assert.ok(!counters.includes('if (!prevAt) {'), '旧的「侧基线为 0 就整批当基线」分支必须消失');
  });

  await check('接线：本地认不出房主时用服务端 homeowner 表补（与 5s 轮询同源）', () => {
    assert.ok(counters.includes('fetchOwnerIdSet('), '30s 精确计数要有服务端房主表兜底');
    assert.ok(counters.includes('messageIdAliases('), '表要按 id 别名匹配');
    assert.ok(counters.includes('OWNER_IDS_TTL_MS'), '房主表要按侧缓存，避免每轮多打请求');
  });

  await check('接线：5s 轮询对「新出现的侧」不能整页当基线吞掉', () => {
    assert.ok(pollers.includes('isNewSideWithFloor'), '要有「新出现的侧 + 已读基线」判据');
    assert.ok(pollers.includes('新出现的侧'), '要留诊断日志');
    assert.ok(pollers.includes('(cur.primed || newSideWithFloor)'), '计数分支要在新侧也执行');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[room-preview-match] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
