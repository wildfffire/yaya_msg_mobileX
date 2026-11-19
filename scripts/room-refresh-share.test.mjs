// 「手动下拉刷新合并加速」回归锁（用户 2026-11-14：计数 / 预览 / 角标短时间内同时到位）。
//
// 涵盖：本轮共享页的代次隔离、按侧就绪信号、force 房主流复用表的只读语义、
// 首页 limit 对齐（50 条首页配 100 条 force 判停会漏计）、翻页增量去重与旧全量去重等价，
// 以及静态接线守卫（口径文件、一次提交、force 一次翻完、进房链路零改动）。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-refresh-share-'));
const results = [];

async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error }); }
}

const T = 1794500000000;
const m = (id, t, extra = {}) => ({ msgIdClient: id, msgTime: t, ...extra });
const idOf = (x) => String(x?.msgIdClient || x?.msgIdServer || '');
const timeOf = (x) => Number(x?.msgTime) || 0;
const read = (p) => readFileSync(join(root, p), 'utf8');

/** 旧实现：每页 dedupeMessages(msgs.concat(list)) 全量重建 + 末尾全量扫时间 */
function oldMerge(pages) {
  let msgs = [];
  for (const list of pages) {
    const seen = new Set();
    const out = [];
    for (const x of msgs.concat(list)) {
      if (!x) continue;
      const id = idOf(x);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(x);
    }
    msgs = out;
  }
  let newest = 0;
  let oldest = 0;
  for (const x of msgs) {
    const t = timeOf(x);
    if (t > newest) newest = t;
    if (t > 0 && (!oldest || t < oldest)) oldest = t;
  }
  return { msgs, newest, oldest };
}

try {
  execSync(
    `npx tsc "${join(root, 'src', 'services', 'roomRefreshShare.ts')}"`
    + ` --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const r = await import(`file://${join(tmp, 'src', 'services', 'roomRefreshShare.js')}`);

  await check('★ 本轮代次：begin/end、错误代次不清新轮、结束后读不到数据', () => {
    const r1 = r.beginRefreshRound();
    assert.ok(r1 > 0);
    assert.equal(r.activeRefreshRound(), r1);
    r.putSharedOwnerFirstPage(r1, 'u1#b', [m('a', T)], 100);
    assert.ok(r.sharedOwnerFirstPage(r1, 'u1#b'));

    const r2 = r.beginRefreshRound();
    assert.ok(r2 > r1, '新轮代次必须递增');
    assert.equal(r.activeRefreshRound(), r2);
    assert.equal(r.sharedOwnerFirstPage(r1, 'u1#b'), null, '旧轮数据不能带进新轮');
    assert.equal(r.sharedOwnerFirstPage(r2, 'u1#b'), null, '新轮不复用上一轮的页');

    r.endRefreshRound(r1);
    assert.equal(r.activeRefreshRound(), r2, '迟到的旧轮结束不能清掉新轮');
    r.putSharedAllPage(r1, 'u2#b', [m('b', T)], { _request: {} });
    assert.equal(r.sharedAllPage(r2, 'u2#b'), null, '旧轮写入必须被拒绝');

    r.endRefreshRound(r2);
    assert.equal(r.activeRefreshRound(), 0);
  });

  await check('共享页：两侧分键、空页/无原始响应不入池、原始 res 保留给串味校验', () => {
    const round = r.beginRefreshRound();
    const res = { _request: { label: 'all num ch=1', payload: { channelId: 'ch1' } } };
    r.putSharedAllPage(round, 'u1#b', [m('a', T)], res);
    assert.equal(r.sharedAllPage(round, 'u1#b').res, res);
    assert.equal(r.sharedAllPage(round, 'u1#s'), null, '大/小房间不能串页');
    r.putSharedAllPage(round, 'u1#s', [], res);
    assert.equal(r.sharedAllPage(round, 'u1#s'), null, '空页不入池');
    r.putSharedAllPage(round, 'u2#b', [m('b', T)], null);
    assert.equal(r.sharedAllPage(round, 'u2#b'), null, '没有原始 res 的页不入池（无法做 all / 本侧校验）');
    r.putSharedOwnerFirstPage(round, 'u1#b', [m('c', T)], 100);
    assert.equal(r.sharedOwnerFirstPage(round, 'u1#b').limit, 100);
    r.endRefreshRound(round);
  });

  await check('★ 首页 limit 校验：50 条首页配 100 条 force 判停必须被拒绝（否则整页漏计）', () => {
    assert.equal(r.sharedPageLimitMatches({ list: [m('a', T)], limit: 100 }, 100), true);
    assert.equal(r.sharedPageLimitMatches({ list: [m('a', T)], limit: 50 }, 100), false,
      '50 条首页会被 shouldContinueToSeen 判成「页不满」提前 break');
    assert.equal(r.sharedPageLimitMatches({ list: [], limit: 100 }, 100), false);
    assert.equal(r.sharedPageLimitMatches(null, 100), false);
  });

  await check('force 房主流复用表：只存消息页与 reached，不存 counted 数值', () => {
    const round = r.beginRefreshRound();
    r.putSharedForceFeed(round, 'u1#b', {
      msgs: [m('a', T + 1), m('b', T)], newest: T + 1, oldest: T, pages: 3, reached: true,
    });
    const feed = r.sharedForceFeed(round, 'u1#b');
    assert.equal(feed.msgs.length, 2);
    assert.equal(feed.reached, true);
    assert.equal(feed.counted, undefined, '共享 counted 会让两条 applyUnread 路径重复 bump');
    r.endRefreshRound(round);
    assert.equal(r.sharedForceFeed(round, 'u1#b'), null);
  });

  await check('按侧就绪：等自己那一侧；失败也不抛；不在刷新轮内立即返回', async () => {
    const round = r.beginRefreshRound();
    let release;
    const task = new Promise((resolve) => { release = resolve; });
    r.putSharedSideReady(round, 'u1#b', task);
    let done = false;
    const waiting = r.waitSharedSideReady(round, 'u1#b').then(() => { done = true; });
    await Promise.resolve();
    assert.equal(done, false, '预热没完成时必须等着，不能抢跑回落独立拉取');
    release();
    await waiting;
    assert.equal(done, true);

    r.putSharedSideReady(round, 'u1#s', Promise.reject(new Error('预热失败')));
    await r.waitSharedSideReady(round, 'u1#s'); // 失败也要放行，让调用方回落到原路径
    await r.waitSharedSideReady(round, 'u2#b'); // 没登记的侧不阻塞
    r.endRefreshRound(round);
    await r.waitSharedSideReady(round, 'u1#b'); // 轮次结束后立即返回
  });

  await check('★ 串味侧负缓存：登记后跳过、TTL 到期自动重试、成功即自愈', () => {
    assert.ok(r.CROSS_SIDE_TTL_MS >= 24 * 60 * 60 * 1000,
      'TTL 要覆盖「很久没打开」（隔夜/一天）的冷启动场景');
    const now = 1800000000000;
    const ch = '41095746';
    assert.equal(r.isCrossSideChannel(ch, now), false);
    r.markCrossSideChannel(ch, now);
    assert.equal(r.isCrossSideChannel(ch, now + 1000), true);
    assert.equal(r.isCrossSideChannel(ch, now + r.CROSS_SIDE_TTL_MS + 1), false,
      'TTL 到期要恢复重试，不能永久跳过');
    r.markCrossSideChannel(ch, now);
    r.clearCrossSideChannel(ch);
    assert.equal(r.isCrossSideChannel(ch, now + 1000), false, '拿到本侧页立即自愈');
    r.markCrossSideChannel('', now);
    assert.equal(r.isCrossSideChannel('', now + 1000), false, '空频道不登记');

    // 冷启动持久化：导出 → 清空 → 恢复，首轮就能跳过
    r.markCrossSideChannel('ch-persist', now);
    const snapshot = r.exportCrossSideChannels(now);
    assert.equal(snapshot['ch-persist'], now + r.CROSS_SIDE_TTL_MS);
    r.clearCrossSideChannel('ch-persist');
    assert.equal(r.isCrossSideChannel('ch-persist', now + 1000), false);
    assert.equal(r.restoreCrossSideChannels(snapshot, now), 1);
    assert.equal(r.isCrossSideChannel('ch-persist', now + 1000), true, '冷启动恢复后首轮就能跳过');
    assert.equal(r.restoreCrossSideChannels(snapshot, now + r.CROSS_SIDE_TTL_MS + 1), 0,
      '过期快照不能被恢复');
    assert.equal(r.restoreCrossSideChannels(null, now), 0);
    assert.equal(r.restoreCrossSideChannels({ bad: 'x' }, now), 0);
    r.clearCrossSideChannel('ch-persist');
  });

  await check('★ 增量去重与旧全量去重的 msgs / newest / oldest 逐条等价', () => {
    const pages = [
      [m('a', T + 500), m('b', T + 400), m('no-time', 0)],
      [m('b', T + 400), m('c', T + 300), m('d', T + 200)],
      [m('e', T + 100), m('a', T + 500)],
      [{ msgTime: T + 50 }, { msgTime: T + 40 }], // 无 id 消息一律保留
    ];
    const expected = oldMerge(pages);
    const acc = r.newPageAccumulator();
    const added = pages.map((p) => r.appendPageMessages(acc, p, idOf, timeOf));
    assert.deepEqual(added, [3, 2, 1, 2], '每页新增条数（重复 id 不重复计）');
    assert.deepEqual(acc.msgs.map(idOf), expected.msgs.map(idOf));
    assert.deepEqual(acc.msgs.map(timeOf), expected.msgs.map(timeOf));
    assert.equal(acc.newest, expected.newest);
    assert.equal(acc.oldest, expected.oldest);
    assert.equal(r.appendPageMessages(acc, [m('a', T + 500)], idOf, timeOf), 0,
      '整页重复要返回 0，供翻页循环停止');
    assert.equal(r.appendPageMessages(acc, null, idOf, timeOf), 0);
  });

  /* ── 静态接线守卫 ───────────────────────────────────────── */
  const share = read('src/services/roomRefreshShare.ts');
  const feed = read('src/services/roomOwnerFeed.ts');
  const pollers = read('src/services/messagePollers.ts');
  const preview = read('src/services/roomPreviewRefresh.ts');
  const screen = read('src/screens/FollowedRoomsScreen.tsx');
  const seenStore = read('src/services/roomSeenStore.ts');
  const unread = read('src/services/roomUnread.ts');
  const counters = read('src/screens/room/useRoomUnreadCounters.ts');
  const pkg = read('package.json');

  await check('共享模块零网络零业务依赖，不参与任何计数状态', () => {
    for (const forbidden of ['pocketApi', 'AsyncStorage', 'react-native', 'useRoomUnreadStore',
      'applyUnread', 'claimCountId', 'notifyMessage']) {
      assert.ok(!share.includes(forbidden), `共享模块不能出现 ${forbidden}`);
    }
    assert.ok(share.includes('endRefreshRound(') && share.includes('sideReady'));
  });

  await check('★ force 翻页：100 条、两处判停 limit 对齐、一次翻完与口径全部保留', () => {
    assert.ok(feed.includes('FORCE_PAGE_LIMIT = 100'));
    assert.ok(feed.includes('limit: pageLimit') && feed.includes('limit: curLimit'));
    assert.ok((feed.match(/limit: curLimit/g) || []).length >= 2, 'while 判停与 atSeen 判停都要对齐');
    assert.ok(feed.includes('firstLimit === pageLimit'), '首页条数不匹配必须回落');
    assert.ok(feed.includes('appendPageMessages('), '翻页走增量去重');
    assert.ok(feed.includes('FORCE_MAX_PAGES') && feed.includes('force ? FORCE_MAX_PAGES'));
    assert.ok(feed.includes("req.key + (force ? ':force' : '')"), 'force 不能复用常规预算任务');
    assert.ok(feed.includes('pendingPages.set(') && feed.includes('pendingPages.delete('));
    assert.ok(feed.includes('fetchAll: false'), '只数 /list/homeowner');
    assert.ok(feed.includes('pickUnreadSinceSeen(') && feed.includes('shouldContinueToSeen('));
    assert.ok(feed.includes('claimCounted(opts.key, id)') && feed.includes('claimCountId('));
    assert.ok(feed.includes('return null'), '主源失败要返回 null 让旧路径兜底');
    assert.ok(!feed.includes('ownerFeedBoundary(') && !feed.includes('getOwnerCountedAt('),
      '机器进度不能回到边界判定');
  });

  await check('★ 本轮 force 结果只共享消息页，常规轮询/指纹不再各起一条翻页链', () => {
    assert.ok(feed.includes('sharedForceFeed(') && feed.includes('putSharedForceFeed('));
    assert.ok(feed.includes('!force && round > 0'), '只有非 force 通道复用');
    assert.ok(pollers.includes('FORCE_CONCURRENCY = 8') && pollers.includes('DETAIL_CONCURRENCY = 4'),
      '只放大 force 链，常规并发不变');
    assert.ok(pollers.includes('prefetchRefreshSharePages(') && pollers.includes('putSharedSideReady('));
    assert.ok(pollers.includes('waitSharedSideReady(round, t.key)'), 'force 按侧等预热');
    assert.ok(pollers.includes('firstPageLimit: shared.limit'), '共享首页要带实际 limit');
    assert.ok(pollers.includes('force: true'), '手动刷新走 force');
    assert.ok(pollers.includes('applyUnread({ bump })'), '角标仍一次提交');
    assert.ok(counters.includes('countOwnerFeedUnread('), '30s 指纹仍用同一个主源');
  });

  await check('★ 预览消费共享页，回落路径与既有校验不变', () => {
    assert.ok(preview.includes('sharedAllPage(') && preview.includes('waitSharedSideReady('));
    assert.ok(preview.includes('fetchAll: true') && preview.includes("startsWith('all')"));
    assert.ok(preview.includes('isDetailFromSide(') && preview.includes('setPreview(s.id, s.side'));
    assert.ok(!preview.includes('claimCountId') && !preview.includes('applyUnread')
      && !preview.includes('advanceCursor') && !preview.includes('notifyMessage'),
      '快扫不得影响角标 / 游标 / 通知');
  });

  await check('★ 一轮统一刷新：三链路并行、完成才解锁、不让路不补跑', () => {
    assert.ok(screen.includes('beginRefreshRound(') && screen.includes('endRefreshRound(round)'));
    assert.ok(screen.includes('prefetchRefreshSharePages(followedRef.current)'));
    assert.ok(screen.includes('flushOwnerFeedUnread(followedRef.current)'));
    assert.ok(screen.includes('refreshRoomListPreviews(followedRef.current, { force: true })'));
    assert.ok(screen.includes('refreshRoomListPreviews(followedRows, { force: true })'));
    assert.ok(screen.includes('Promise.allSettled(['), '三链路真正完成才收圈');
    assert.ok(screen.includes('setTimeout(() => { setRoomsRefreshing(false); }, 12_000)'),
      '12s 只收 UI 圈，不提前解业务锁');
    assert.ok(!screen.includes('roomRefreshGate') && !share.includes('markYielded'),
      '让路 / 延后补跑方案已被用户否决，不能残留');
  });

  await check('★ 既有口径与进房链路零改动', () => {
    assert.ok(seenStore.includes('yaya_room_seen_v2'));
    assert.ok(seenStore.includes('if (!s.id && !(s.time > 0)) return null;'), '空基线三层防护之一');
    assert.ok(feed.includes('claimCounted(') && feed.includes('claimCountId('));
    assert.ok(unread.includes('yaya_room_unread_v5'));
    assert.ok(screen.includes('markSeen(roomUnreadKey(') && screen.includes('markRead('));
    assert.ok(screen.includes('markSeenAll(key, baselines[id])'));
    assert.ok(counters.includes('applyUnread({') && counters.includes('seenAt: seenAtPatch'),
      '指纹仍一次提交');
    assert.ok(!screen.includes('roomFirstScreenCache') && !screen.includes('roomNetPrefs'),
      '跨启动首屏缓存已被用户否决');
  });

  await check('★ 真机串味侧：三条链共用负缓存，列表内部预览不抢跑', () => {
    assert.ok(share.includes('CROSS_SIDE_TTL_MS') && share.includes('clearCrossSideChannel('));
    assert.ok(pollers.includes('isCrossSideChannel(channelId)')
      && pollers.includes('markCrossSideChannel(s.channelId)'), '预热要登记并跳过串味侧');
    assert.ok(pollers.includes('skippedCrossSide') && pollers.includes('跳过串味侧='),
      '真机要能看出跳过多少侧');
    assert.ok(pollers.includes('if (!channelId || isCrossSideChannel(channelId)) continue;'),
      'force 主计数也要跳过');
    assert.ok(preview.includes('isCrossSideChannel(s.channelId)'), '预览回落路径也要跳过');
    assert.ok(screen.includes(
      'if (activeRefreshRound() <= 0) void refreshRoomListPreviews(followedRows, { force: true })'),
      '本轮刷新期间列表内部不再重复跑全量预览');
    assert.ok(pollers.includes('ensureCrossSideLoaded()') && pollers.includes('scheduleCrossSidePersist()')
      && pollers.includes('yaya_room_cross_side_v1'),
      '串味侧负缓存要落盘，冷启动首轮才能跳过');
    assert.ok(pollers.includes('if (isCrossSideChannel(s.channelId)) return { list: null, crossSide: true };'),
      '5s 轮询 / 滞后探针的详情入口也要拦掉串味侧');
    assert.ok(feed.includes('isCrossSideChannel(roomChannelId(opts.member || {}, opts.side))'),
      '主计数入口统一拦截串味侧（覆盖 force / 轮询 / 指纹）');
    assert.ok(counters.includes('isCrossSideChannel(channelId)'),
      '30s 指纹旧路径（房主表 / 详情兜底）也要拦掉串味侧');
  });

  await check('本回归锁并入 test:core', () => {
    assert.ok(pkg.includes('room-refresh-share.test.mjs'));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((x) => !x.ok);
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : `\n      ${x.error?.message || x.error}`}`);
console.log(`room-refresh-share: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
