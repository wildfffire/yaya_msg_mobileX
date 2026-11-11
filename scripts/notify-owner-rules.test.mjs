// 「只有偶像消息和私信横幅通知」回归锁（用户 2026-11-10）。
//
// 背景：房间通知旧版把详情一页里的**所有**新消息（含群聊里成员/粉丝发言）都送进
// notifyMessage；而且若直接套用 `isIdolMessage(item, room, false)`，它在「拿不到
// 发送者 id 且昵称对不上」时会 return true（那是「只看偶像」视图的宁可多显示兜底），
// 没带 ext.user 的普通成员消息照样会被判成偶像 → 用户看到的「有的群聊消息也弹横幅」。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-notify-owner-'));
const results = [];

async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error }); }
}

const OWNER = {
  ids: [530390, '530390', undefined],
  names: ['SNH48-陈琳', null],
};

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'notifyOwnerRules.ts')}" "${join(root, 'src', 'utils', 'memberMatch.ts')}" "${join(root, 'src', 'services', 'roomCountLedger.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const rules = await import(`file://${join(tmp, 'src', 'utils', 'notifyOwnerRules.js')}`);
  const ledger = await import(`file://${join(tmp, 'src', 'services', 'roomCountLedger.js')}`);

  await check('房主本人 id 命中 → 可通知', () => {
    assert.equal(rules.isOwnerSender({ id: '530390', name: '陈琳' }, OWNER), true);
  });

  await check('房主昵称命中（带团体前缀/空格）→ 可通知（id 不同域兜底）', () => {
    assert.equal(rules.isOwnerSender({ id: 'qchat-accid-999', name: ' SNH48 - 陈琳 ' }, OWNER), true);
  });

  await check('★ 成员消息（id / 昵称都不是房主）→ 不通知', () => {
    assert.equal(rules.isOwnerSender({ id: '888', name: '某粉丝' }, OWNER), false);
    assert.equal(rules.isOwnerSender({ id: '', name: '某成员' }, OWNER), false);
  });

  await check('★ 没有发送者资料（ext.user 缺失）→ 不通知（旧宽松口径会误判成偶像）', () => {
    assert.equal(rules.isOwnerSender({ id: '', name: '未知用户' }, OWNER), false);
    assert.equal(rules.isOwnerSender({ id: '', name: '' }, OWNER), false);
    assert.equal(rules.isOwnerSender(null, OWNER), false);
    assert.equal(rules.isOwnerSender({}, OWNER), false);
  });

  await check('房主资料缺失时安全返回 false，不抛异常', () => {
    assert.equal(rules.isOwnerSender({ id: '530390' }, { ids: [], names: [] }), false);
    assert.equal(rules.isOwnerSender({ name: '陈琳' }, { ids: [], names: [] }), false);
    assert.equal(rules.isOwnerSender({ id: '530390' }, null), false);
  });

  await check('★ 一批混合消息：只留房主，全成员批次为空', () => {
    const batch = [
      { msgIdClient: 'a', bodys: '成员A', senderUserId: '888', nickName: '成员A' },
      { msgIdClient: 'b', bodys: '偶像', senderUserId: '530390', nickName: 'SNH48-陈琳' },
      { msgIdClient: 'c', bodys: '没资料的成员' },
      { msgIdClient: 'd', bodys: '偶像2', nickName: '陈琳' },
    ];
    const isOwner = (m) => rules.isOwnerSender(
      { id: m.senderUserId, name: m.nickName },
      OWNER,
    );
    assert.deepEqual(
      rules.pickOwnerMessages(batch, isOwner).map((m) => m.msgIdClient),
      ['b', 'd'],
    );
    assert.deepEqual(rules.pickOwnerMessages(batch.slice(0, 1), isOwner), []);
    assert.deepEqual(rules.pickOwnerMessages(null, isOwner), []);
  });

  await check('★ 服务端房主表：本地认不出的房间也能认出房主（按房间分化修复）', () => {
    const set = new Set(['owner-1', 'owner-2']);
    assert.equal(rules.isOwnerByServer(set, 'owner-1', () => false), true);
    // 表里没有时仍回退本地，绝不拿服务端表做「排除」→ 不会制造新的按房间漏
    assert.equal(rules.isOwnerByServer(set, 'owner-3', () => true), true);
    assert.equal(rules.isOwnerByServer(null, 'owner-1', () => false), false);
    assert.equal(rules.isOwnerByServer(new Set(), 'owner-1', () => true), true);
  });

  await check('★ 服务端表 id 别名：/list/all 与 homeowner 字段不同源也能命中', () => {
    const set = new Set(['srv-1', 'srv-2']);
    assert.equal(rules.isOwnerByServer(set, ['cli-1', 'srv-1'], () => false), true);
    assert.equal(rules.isOwnerByServer(set, ['cli-9'], () => false), false);
    assert.deepEqual(
      rules.messageIdAliases({ msgIdClient: 'cli-1', msgIdServer: 'srv-1', uuid: 'u-1', msgIdClientDup: 'x' }),
      ['cli-1', 'srv-1', 'u-1'],
    );
    assert.deepEqual(rules.messageIdAliases({ msgIdClient: '0', id: '' }), []);
  });

  await check('★ 计数总账：只有真计数才占用，已读/首次基线不抢占', () => {
    const a = 'ledger-a';
    const b = 'ledger-b';
    const c = 'ledger-c';
    assert.equal(ledger.claimCountId(a), true);
    assert.equal(ledger.claimCountId(a), false, '同一条消息只计一次');
    ledger.markCountConsumed(b);
    assert.equal(ledger.claimCountId(b), false, '已读消息不能被补偿扫描补计');
    assert.equal(ledger.isCountClaimed(b), true);
    assert.equal(ledger.isCountClaimed(c), false, '首次基线不能占总账');
    assert.equal(ledger.claimCountId(c), true, '基线之后这条新消息仍要能计数');
  });

  /* ── 静态接线守卫 ───────────────────────────────────────── */
  const pollers = readFileSync(join(root, 'src', 'services', 'messagePollers.ts'), 'utf8');
  const messageRules = readFileSync(join(root, 'src', 'screens', 'room', 'messageRules.ts'), 'utf8');
  const ownerRules = readFileSync(join(root, 'src', 'utils', 'notifyOwnerRules.ts'), 'utf8');
  const counters = readFileSync(join(root, 'src', 'screens', 'room', 'useRoomUnreadCounters.ts'), 'utf8');
  const screen = readFileSync(join(root, 'src', 'screens', 'FollowedRoomsScreen.tsx'), 'utf8');

  await check('房间通知接线：只有偶像消息能进 notifyMessage', () => {
    assert.ok(pollers.includes('isOwnerMessageStrict('), '必须用严格房主判定（通知/角标/预览同一口径）');
    assert.ok(pollers.includes('pickOwnerMessages('), '必须把整批新消息过滤成偶像子集');
    assert.ok(pollers.includes('if (cur.primed && idolFresh.length)'), '通知触发条件必须是偶像消息');
    assert.ok(pollers.includes('freshBatchKey(idolFresh)'), '去重键只基于偶像消息');
    assert.ok(pollers.includes('consumeCursor(roomCursors, s.key, cur, pageKeys, idolFresh'),
      '失败重试只保留偶像消息，成员消息本轮消费掉');
    assert.ok(!pollers.includes('newestMsg = fresh.reduce'), '横幅文案不能再取全批最新一条');
    assert.ok(!pollers.includes('{ n: fresh.length }'), '横幅条数不能再算全批消息');
  });

  await check('严格判定与「只看偶像」视图宽松兜底分离，发送者解析同源', () => {
    assert.ok(messageRules.includes('export function isOwnerMessageStrict('), '严格判定必须是唯一入口');
    assert.ok(messageRules.includes('isOwnerSender(senderProfile(item, room)'), '必须复用 senderProfile');
    assert.ok(messageRules.includes('if (!includeFans) return true;'), '旧宽松兜底仍留给「只看偶像」视图');
    assert.ok(!ownerRules.includes('if (!includeFans) return true'), '通知规则里不能沿用「认不出就当偶像」的兜底');
  });

  await check('私信通知仍保留（用户要求「偶像消息和私信」两类）', () => {
    assert.ok(pollers.includes("kind: 'pm'"), '私信通知不能被一起关掉');
    assert.ok(pollers.includes('getPrivateMessageDetail('), '私信仍拉详情按 id 判新');
  });

  await check('★ 按房间分化：服务端 homeowner 房主表 + 未覆盖房间/侧可见', () => {
    assert.ok(pollers.includes('fetchSideDetail(s, false)') && pollers.includes('fetchAll,'),
      '必须拉服务端按房主过滤的 homeowner 接口（fetchSideDetail 的 fetchAll=false）');
    assert.ok(pollers.includes('isOwnerByServer('), '房主判定要优先用服务端表补本地漏判');
    assert.ok(pollers.includes('ownerIdSets'), '房主表要按侧缓存');
    assert.ok(pollers.includes('room.coverage'), '关注房间匹配不到的要打日志');
    assert.ok(pollers.includes('room.coverage.sides'), '每侧缺预览/channelId 的要打日志');
    assert.ok(pollers.includes('homeowner='), '每侧判定日志要带服务端表条数');
    assert.ok(pollers.includes('服务端命中='), '要能看出服务端房主表到底命中了几条');
    assert.ok(pollers.includes('messageIdAliases('), '房主表与详情要比对全部 id 别名');
  });

  await check('★ 首次基线不抢总账 / 同秒消息不漏 / 补偿扫描兜底', () => {
    assert.ok(counters.includes('不占总账'), '首次基线不能再 claim 整页 id');
    assert.ok(!counters.includes('for (const m of msgs) claimCountId'), '整页认领代码必须删掉');
    // 时间门槛已抽成纯函数（utils/roomMessageCursor.isCountableUnreadMessage），单测直接钉住边界
    const cursorRules = readFileSync(join(root, 'src', 'utils', 'roomMessageCursor.ts'), 'utf8');
    assert.ok(cursorRules.includes('t < seen'), '同毫秒/同秒连发不能被侧基线挡掉（只有严格早于才跳过）');
    assert.ok(counters.includes('isCountableUnreadMessage('), '精确计数必须走统一时间门槛');
    assert.ok(pollers.includes('补偿计数'), '必须有按 id 的补偿扫描');
    assert.ok(pollers.includes('markCountConsumed(mid)'), '当前房间消息要标已读而不是占用计数名额');
    assert.ok(screen.includes('markCountConsumed(messageId(m))'), '实时通道同样用已读语义');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`notify-owner-rules: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
