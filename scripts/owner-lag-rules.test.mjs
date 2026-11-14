// 「正确的 homeowner 滞后实验」回归锁（用户 2026-11-13「再进行一次正确的滞后实验」）。
//
// v1 的错误：lagSec = all页最新 msgTime − homeowner页最新 msgTime。
//   all 页是粉丝+房主混合流、homeowner 页只有房主消息 → 量到的是「房主多久没说话」，
//   真机才会打出 平均 6102s / 最大 81941s；旧覆盖率分母是 all 页总条数（几乎全是粉丝），
//   恒定 13~20%，也说明不了召回。
// v2：同一条消息 id「首次在 all 见到」→「首次在 homeowner 见到」的**挂钟时间差**，
//   与消息自身 msgTime 无关；同轮两页都可见记为「同轮可见」；房主召回只看房主候选，
//   并排除被 homeowner 页 50 条分页窗口挤出去的旧消息。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-owner-lag-'));
const results = [];

async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error }); }
}

const T0 = 1794506500000; // 11-13 01:xx（服务器消息时间，仅用于窗口判据）
const ownerMsg = (id, t, extra = {}) => ({
  msgIdClient: id, msgTime: t, ext: { user: { nickName: 'yuki-' } }, ...extra,
});
const fanMsg = (id, t) => ({ msgIdClient: id, msgTime: t, ext: { user: { nickName: '粉丝' } } });
const isOwner = (m) => m?.ext?.user?.nickName === 'yuki-';

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'ownerLagRules.ts')}"`
    + ` "${join(root, 'src', 'utils', 'roomMessageCursor.ts')}"`
    + ` "${join(root, 'src', 'utils', 'notifyOwnerRules.ts')}"`
    + ` "${join(root, 'src', 'utils', 'memberMatch.ts')}"`
    + ` --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const rules = await import(`file://${join(tmp, 'src', 'utils', 'ownerLagRules.js')}`);

  await check('★ 延迟是挂钟时间差，不是两页 msgTime 之差（v1 的致命错误）', () => {
    // 房主隔了 7.5 小时才再发言，v1 会报 27070s；v2 只认首次可见时刻
    const firstSeenAllAt = 1794533500000;
    const firstSeenOwnerAt = firstSeenAllAt + 5000; // 5s 后才进房主流
    assert.equal(rules.firstVisibleLagMs(firstSeenAllAt, firstSeenOwnerAt), 5000);
    const allNewestMsgTime = 1794533594749;
    const ownerNewestMsgTime = 1794506525111;
    assert.notEqual(allNewestMsgTime - ownerNewestMsgTime, 5000, 'msgTime 差与接口延迟无关');
    // 同轮可见（两页同一时刻拿到）→ 延迟上界就是一次采样间隔，记 0
    assert.equal(rules.firstVisibleLagMs(firstSeenAllAt, firstSeenAllAt), 0);
    assert.equal(rules.firstVisibleLagMs(0, firstSeenOwnerAt), -1);
    assert.equal(rules.firstVisibleLagMs(firstSeenAllAt, 0), -1);
    assert.equal(rules.firstVisibleLagMs(firstSeenOwnerAt, firstSeenAllAt), 0, '时钟回拨不能出负数');
  });

  await check('id 别名集合：两个接口字段不同源也能对上', () => {
    const set = rules.aliasSet([
      { msgIdClient: 'cli-1', msgIdServer: 'srv-1', uuid: 'u-1' },
      { messageId: 'm-2' },
      null,
    ]);
    assert.ok(set.has('cli-1') && set.has('srv-1') && set.has('u-1') && set.has('m-2'));
    assert.equal(rules.aliasSet(null).size, 0);
  });

  await check('★ 同轮可见 / 房主召回 / 待配对：分母只算房主候选，不算粉丝', () => {
    const ownerPage = [
      ownerMsg('o1', T0),
      ownerMsg('o2', T0 + 1000),
      ownerMsg('o3', T0 + 2000),
    ];
    const allList = [
      ownerMsg('o1', T0),                       // 两页都有
      ownerMsg('o2', T0 + 1000),                // 两页都有
      ownerMsg('o4', T0 + 3000),                // 混合流先出现，房主流还没收录
      ownerMsg('o-old', T0 - 10000),             // 分页窗口外，不算滞后
      ...Array.from({ length: 50 }, (_, i) => fanMsg(`f-${i}`, T0 + 4000 + i)),
    ];
    const snap = rules.ownerLagSnapshot(allList, ownerPage, isOwner);
    assert.equal(snap.sameRound, 2, '房主流里同时能在混合流找到的条数');
    assert.equal(snap.recallHit, 2);
    assert.equal(snap.recallTotal, 3, '50 条粉丝 + 1 条窗口外都不能进分母');
    assert.deepEqual(snap.pendingIds, ['o4']);
    assert.equal(snap.outsideWindow, 1);
    assert.equal(snap.ownerOldest, T0);
    assert.equal(snap.ownerNewest, T0 + 2000);
  });

  await check('★ 房主流窗口内但 id 字段不同源：仍算已收录（不算滞后）', () => {
    const ownerPage = [ownerMsg('srv-1', T0, { msgIdServer: 'cli-1' })];
    const allList = [ownerMsg('cli-1', T0)];
    const snap = rules.ownerLagSnapshot(allList, ownerPage, isOwner);
    assert.equal(snap.recallHit, 1);
    assert.equal(snap.recallTotal, 1);
    assert.deepEqual(snap.pendingIds, []);
  });

  await check('空页 / 没有房主候选时安全返回', () => {
    const snap = rules.ownerLagSnapshot([fanMsg('f1', T0)], [], isOwner);
    assert.equal(snap.sameRound, 0);
    assert.equal(snap.recallTotal, 0);
    assert.deepEqual(snap.pendingIds, []);
    assert.equal(rules.ownerLagSnapshot(null, null, isOwner).ownerOldest, 0);
  });

  await check('汇总：平均 / P50 / 最大，空样本不报错', () => {
    assert.deepEqual(rules.summarizeLag([1000, 3000, 5000, 9000]), {
      count: 4, avgMs: 4500, maxMs: 9000, p50Ms: 5000,
    });
    assert.deepEqual(rules.summarizeLag([]), { count: 0, avgMs: 0, maxMs: 0, p50Ms: 0 });
    assert.deepEqual(rules.summarizeLag(null), { count: 0, avgMs: 0, maxMs: 0, p50Ms: 0 });
    assert.equal(rules.summarizeLag([5000, -1]).count, 1, '脏样本要剔除');
  });

  /* ── 静态接线守卫 ───────────────────────────────────────── */
  // 实验实现已整体搬到 ownerLagProbe.ts；轮询文件只剩两处调用
  const pollers = [
    readFileSync(join(root, 'src', 'services', 'messagePollers.ts'), 'utf8'),
    readFileSync(join(root, 'src', 'services', 'ownerLagProbe.ts'), 'utf8'),
  ].join('\n');
  const pureRules = readFileSync(join(root, 'src', 'utils', 'ownerLagRules.ts'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');

  await check('★ v1 错误算法已从轮询里删干净', () => {
    assert.ok(!pollers.includes('Math.round((allT - ownerT) / 1000)'), '不能再用两页 msgTime 差当延迟');
    assert.ok(!pollers.includes('ownerLagStat.total += allList.length'), '覆盖率分母不能是 all 页总条数');
    assert.ok(!pollers.includes('覆盖率=${hit}/${allList.length}'), '旧覆盖率日志格式必须换掉');
    assert.ok(!pollers.includes('lagSum'), '旧的按秒累加统计必须删掉');
  });

  await check('★ v2 接线：挂钟配对 + 5s 分辨率 + 探针优先 + 定期汇总', () => {
    assert.ok(pollers.includes('ownerLagSnapshot('), '要按两页 id 对照');
    assert.ok(pollers.includes('firstVisibleLagMs('), '延迟必须按首次可见挂钟时刻结算');
    assert.ok(pollers.includes('summarizeLag('), '要有平均/P50/最大汇总');
    assert.ok(pollers.includes('OWNER_LAG_PENDING_TTL_MS'), '待配对消息要有超时上限');
    assert.ok(pollers.includes('ownerLagPending.get(s.key)'), '采样与探针都要照顾待配对侧');
    assert.ok(pollers.includes('pendingSide || sides[ownerProbeCursor]'), '探针优先待配对侧');
    assert.ok(pollers.includes('同轮可见=') && pollers.includes('覆盖率='), '日志要有零延迟基线与召回');
    assert.ok(pollers.includes('分辨率='), '必须标明采样间隔，不能把同轮可见当成精确 0ms');
    // 旧静态锁（room-unread-rules.test.mjs）要求的字符串一个都不能丢
    assert.ok(pollers.includes('homeowner 滞后实验'));
    assert.ok(pollers.includes('homeowner 实验汇总'));
    assert.ok(pollers.includes('OWNER_PROBE_GAP_MS'));
    assert.ok(pollers.includes("'探针'"));
    assert.ok(pollers.includes('源=${source}'));
    assert.ok(pollers.includes('() => isOwnerMessageStrict(m, s.member)'));
  });

  await check('实验只读：不能碰计数 / 游标 / 通知', () => {
    assert.ok(!pureRules.includes('claimCountId') && !pureRules.includes('bumpPatch'),
      '纯规则模块不得涉及计数');
    assert.ok(pollers.includes('if (idolIds.has(mid)) countableIdolIds.push(mid);'),
      '既有计数链路保持原样');
    assert.ok(pkg.includes('owner-lag-rules.test.mjs'), '本回归锁必须进 test:core');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`owner-lag-rules: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
