// 「观看历史 / 稍后再看」去重与合并规则测试（纯 Node，零新增依赖）。
//
// 为什么必须钉住：同一直播会按入口产生不同标识（replay:<id> / live:<id> / openlive:<id>）——
// 口径不统一就会「同一个直播多次记录」，而且各条字段互补（一条有封面、一条有成员名），
// 卡片看起来就是「信息不全」（用户 2026-09-30 连续两次反馈的点）。
// 这里把口径与迁移合并逻辑一起锁死：改坏任何一条都会在这里报错。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-watch-dedupe-'));

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
    `npx tsc "${join(root, 'src', 'utils', 'watchKeys.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'watchKeys.js')}`);
  const { historyKey, mergeHistoryItems, watchLaterBucket, watchLaterKey, mergeWatchLaterItems } = mod;
  for (const fn of ['historyKey', 'mergeHistoryItems', 'watchLaterBucket', 'watchLaterKey', 'mergeWatchLaterItems', 'shouldRecordHistory', 'isReplayableHistoryItem']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里没有 ${fn} —— 拒绝以「通过」结束`);
  }

  await check('历史：同一直播的 replay 入口与 liveId 入口 → 同一个 key（不再记两条）', () => {
    const a = historyKey({ ref: { kind: 'replay', id: 'L123' }, liveId: 'L123' });
    const b = historyKey({ liveId: 'L123' });
    const c = historyKey({ ref: { kind: 'openlive', id: 'L123' } });
    assert.equal(a, 'live:L123');
    assert.equal(b, 'live:L123');
    assert.equal(c, 'live:L123');
  });

  await check('历史：官方视频库（video:<videoId>）不与直播场次混在一起', () => {
    assert.equal(historyKey({ ref: { kind: 'video', id: 'V9' } }), 'video:V9');
    assert.notEqual(historyKey({ ref: { kind: 'video', id: 'V9' } }), historyKey({ liveId: 'V9' }));
  });

  await check('历史白名单（2026-11-13）：只记录直播 / 直播回放 / 公演', () => {
    const { shouldRecordHistory, isReplayableHistoryItem } = mod;
    assert.equal(shouldRecordHistory({ kind: 'live' }), true, '直播要记');
    assert.equal(shouldRecordHistory({ kind: 'vod', ref: { kind: 'replay' } }), true, '直播回放要记');
    assert.equal(shouldRecordHistory({ kind: 'vod', ref: { kind: 'openlive' } }), true, '公演要记');
    assert.equal(shouldRecordHistory({ kind: 'direct' }), false, '房间视频消息不该进历史');
    assert.equal(shouldRecordHistory({ kind: 'audio' }), false, '语音/电台节目不进历史');
    assert.equal(shouldRecordHistory({ kind: 'vod', ref: { kind: 'video' } }), false, '官方视频库不进历史');
    assert.equal(shouldRecordHistory({ kind: 'vod' }), false, '无来源的临时播放不进历史');
    // 旧数据清理：无 ref / 无 liveId 的 `t:标题` 条目（房间视频、表情、私信媒体）要删掉
    assert.equal(isReplayableHistoryItem({ key: 't:视频' }), false);
    assert.equal(isReplayableHistoryItem({ key: 't:表情' }), false);
    assert.equal(isReplayableHistoryItem({ key: 't:消息媒体' }), false);
    assert.equal(isReplayableHistoryItem({ key: 'live:L1', liveId: 'L1' }), true);
    assert.equal(isReplayableHistoryItem({ key: 'live:L2', ref: { kind: 'replay', id: 'L2' } }), true);
    assert.equal(isReplayableHistoryItem({ key: 'video:V1', ref: { kind: 'video', id: 'V1' } }), true);
  });

  await check('历史：拿不到 id 时按归一化标题兜底（空白/大小写不同也算同一条）', () => {
    const a = historyKey({ title: '  Hello   World ' });
    const b = historyKey({ title: 'hello world' });
    assert.equal(a, 't:hello world');
    assert.equal(a, b);
  });

  await check('历史迁移：同一直播两条碎片合并成一条，字段取并集、count 取大值', () => {
    const merged = mergeHistoryItems([
      { key: 'replay:L123', kind: 'vod', title: '回放A', cover: 'http://c/1.jpg', at: 100, count: 2 },
      { key: 'live:L123', kind: 'vod', title: '', owner: '袁一琦', team: 'SNH48 Team HII', liveId: 'L123', at: 200, count: 3 },
    ]);
    assert.equal(merged.length, 1, '同一直播应当只剩一条');
    assert.equal(merged[0].key, 'live:L123');
    assert.equal(merged[0].cover, 'http://c/1.jpg');           // 旧条目的封面保住
    assert.equal(merged[0].owner, '袁一琦');                     // 新条目的成员名保住
    assert.equal(merged[0].team, 'SNH48 Team HII');
    assert.equal(merged[0].liveId, 'L123');
    assert.equal(merged[0].at, 200);
    assert.equal(merged[0].count, 3, 'count 取较大值（两次其实是同一次观看的分裂记录）');
  });

  await check('历史迁移：无 key 的脏数据被丢弃，不同场次不会被合并', () => {
    const merged = mergeHistoryItems([
      { key: 't:', title: '', at: 1, count: 1 },
      { key: 'live:L1', liveId: 'L1', title: 'A', at: 10, count: 1 },
      { key: 'live:L2', liveId: 'L2', title: 'B', at: 20, count: 1 },
    ]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((m) => m.key), ['live:L2', 'live:L1']); // 按 at 倒序
  });

  await check('稍后再看：openlive 与 replay 同 id → 同一个「同一场内容」桶', () => {
    assert.equal(watchLaterBucket('openlive', 'L7'), watchLaterBucket('replay', 'L7'));
    assert.notEqual(watchLaterBucket('video', 'L7'), watchLaterBucket('replay', 'L7'));
    assert.equal(watchLaterKey('replay', 'L7'), 'replay:L7');
  });

  await check('稍后再看迁移：同一场直播的两条收藏合并成一条，字段取并集', () => {
    const merged = mergeWatchLaterItems([
      { key: 'openlive:L7', kind: 'openlive', id: 'L7', title: '公演回放', cover: 'http://c/7.jpg', at: 100 },
      { key: 'replay:L7', kind: 'replay', id: 'L7', title: '', owner: '宋昕冉', team: 'SNH48 Team SII', at: 300 },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'L7');
    assert.equal(merged[0].kind, 'replay', '保留较新那条的 kind（更可能解析成功）');
    assert.equal(merged[0].key, 'replay:L7');
    assert.equal(merged[0].cover, 'http://c/7.jpg');
    assert.equal(merged[0].owner, '宋昕冉');
    assert.equal(merged[0].team, 'SNH48 Team SII');
    assert.equal(merged[0].at, 300);
  });

  await check('稍后再看：空 id 的脏数据被丢弃', () => {
    const merged = mergeWatchLaterItems([
      { key: 'video:', kind: 'video', id: '', title: 'x', at: 1 },
      { key: 'video:V1', kind: 'video', id: 'V1', title: 'y', at: 2 },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'V1');
  });
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.error(`  ✗ ${r.name}\n${r.error?.stack || r.error}`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n[watch-dedupe] 结果：${passed} 通过 / ${results.length - passed} 失败`);
if (passed !== results.length) process.exitCode = 1;
