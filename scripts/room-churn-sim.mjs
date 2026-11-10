/**
 * 「反复进出房间 / 反复切界面」的**高压模拟测试**（纯 Node，零新增依赖）。
 *
 * 用户 2026-09-30：「仔细全面研究房间界面，模拟高压环境反复切换界面进出房间，
 *                  而不出现卡顿和变灰或者消息、房间列表消失。提高性能效率」。
 *
 * 这里跑的是**真机上最容易出事的时序**，用虚拟时钟压到上千次事件：
 *   · 进出房间（每次退房都会让列表轮询 effect 重跑一次）；
 *   · 切 tab（isFocused 变化同样触发一次）；
 *   · 30s 轮询到期。
 *
 * 断言：
 *   ① 全量刷新（= 一次 getLiveList(size:100) + 全量房间最新消息 + 上麦扫描）的次数
 *      必须被节流压住 —— 否则"反复进出 = 反复全量请求"，请求互抢就是卡顿与列表闪；
 *   ② 直播索引内容没变时必须复用旧引用（否则整页每 30s 全量重渲染）；
 *   ③ 结构性回归锁：轮询 effect 必须走节流、applyFingerprintCounts 必须引用恒定、
 *      进房/退房的浮层复位清单必须完整（漏一个就是用户说的"变灰/遮罩"）。
 */
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-churn-'));

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
    `npx tsc "${join(root, 'src', 'screens', 'room', 'pollThrottle.ts')}" "${join(root, 'src', 'screens', 'room', 'liveIndex.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const throttle = await import(`file://${join(tmp, 'src', 'screens', 'room', 'pollThrottle.js')}`);
  const liveIndex = await import(`file://${join(tmp, 'src', 'screens', 'room', 'liveIndex.js')}`);

  const { shouldRunTick, TICK_MIN_INTERVAL_MS } = throttle;
  const { sameLiveIndex, buildLiveIndex } = liveIndex;

  for (const fn of ['shouldRunTick', 'tickStamp']) {
    if (typeof throttle[fn] !== 'function') throw new Error(`编译产物缺少 ${fn} —— 拒绝以「通过」结束`);
  }
  if (typeof sameLiveIndex !== 'function') throw new Error('编译产物缺少 sameLiveIndex');
  if (typeof buildLiveIndex !== 'function') throw new Error('编译产物缺少 buildLiveIndex');

  /* ───────────────── ① 高压时序模拟（虚拟时钟） ───────────────── */

  /**
   * 模拟「列表页轮询 effect」在一段真实时间里的行为。
   *
   * 触发源（每次都会让 effect 重跑 → 以前每次都立刻 tick 一次）：
   *   - enterRoom / exitRoom：`selectedRoom` 变化
   *   - tabSwitch：`isFocused` 变化
   *   - tick：30s 轮询到期
   * 返回：真正打出去的**全量刷新次数**。
   */
  function simulateChurn({ events, minIntervalMs, throttled }) {
    let lastAt = 0;
    let requests = 0;
    let now = 0;
    for (const ev of events) {
      now += ev.dt;
      if (ev.kind === 'tick30') {
        // 30s 轮询：到期必跑（用户要的就是"列表会自己更新"）
        if (throttled) {
          if (shouldRunTick(lastAt, now, minIntervalMs)) { lastAt = now; requests += 1; }
        } else { requests += 1; }
        continue;
      }
      // 进出房 / 切 tab：effect 重跑 → 立刻 tick（force=false）
      if (throttled) {
        if (shouldRunTick(lastAt, now, minIntervalMs)) { lastAt = now; requests += 1; }
      } else { requests += 1; }
    }
    return requests;
  }

  /**
   * 造一段「疯狂进出房间」的事件流。
   * 每 1.5~4s 完成一次「点进房间 → 看一眼 → 退出」，偶发切 tab，轮询每 30s 到期一次。
   * `dt` = 距上一个事件的毫秒数（虚拟时钟，外层累加）。
   */
  function makeEvents(seed, seconds) {
    let s = seed >>> 0;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const events = [];
    let t = 0;
    let nextPoll = 30000;
    const push = (kind, dt) => events.push({ kind, dt });
    while (t < seconds * 1000) {
      const gap = 1500 + Math.floor(rand() * 2500);
      t += gap;
      // 轮询到期（30s 一次，与"进出"无关）
      while (t >= nextPoll) { push('tick30', 0); nextPoll += 30000; }
      const first = events.length;
      push('enterRoom', 0);
      push('exitRoom', 0);
      if (rand() < 0.25) push('tabSwitch', 0);
      // 把这段耗时记到本批第一个事件上（后面的事件视为同一瞬间连发）
      events[first].dt = gap;
    }
    return events;
  }

  await check('节流：连续 100 次「进房→退房」只打一次全量请求（旧实现是 100 次）', () => {
    const events = [];
    for (let i = 0; i < 100; i += 1) events.push({ kind: i % 2 ? 'exitRoom' : 'enterRoom', dt: 200 });
    const throttled = simulateChurn({ events, minIntervalMs: TICK_MIN_INTERVAL_MS, throttled: true });
    const raw = simulateChurn({ events, minIntervalMs: TICK_MIN_INTERVAL_MS, throttled: false });
    assert.equal(raw, 100, '不加节流时应当每次都打请求（这条断言保证对比有意义）');
    assert.ok(throttled <= 3, `20 秒内 100 次进出最多应 ≤3 次全量请求，实际 ${throttled}`);
    assert.ok(throttled < raw / 10, `节流后应至少降一个数量级（${throttled} vs ${raw}）`);
  });

  await check('节流：30s 轮询不会被节流吞掉（列表仍然会自己更新）', () => {
    const events = [];
    for (let i = 0; i < 10; i += 1) events.push({ kind: 'tick30', dt: 30000 });
    const n = simulateChurn({ events, minIntervalMs: TICK_MIN_INTERVAL_MS, throttled: true });
    assert.equal(n, 10, '每 30s 一次的定时刷新必须全部执行');
  });

  await check('高压：10 分钟疯狂进出（约 300 次）+ 切 tab，请求次数被压在上限内', () => {
    const events = makeEvents(20260930, 600);
    const churn = events.filter((e) => e.kind !== 'tick30').length;
    const throttled = simulateChurn({ events, minIntervalMs: TICK_MIN_INTERVAL_MS, throttled: true });
    const raw = simulateChurn({ events, minIntervalMs: TICK_MIN_INTERVAL_MS, throttled: false });
    const upper = Math.ceil((600 * 1000) / TICK_MIN_INTERVAL_MS) + 2;
    assert.ok(churn > 200, `事件流应足够高压（实际 ${churn} 次进出/切页）`);
    assert.ok(throttled <= upper, `10 分钟内最多 ${upper} 次全量请求，实际 ${throttled}`);
    assert.ok(throttled * 5 < raw, `节流效果不明显（${throttled} vs ${raw}）`);
  });

  await check('时钟回拨不会把轮询永久卡死', () => {
    // 用户改系统时间 / NTP 校正 → now 比 lastAt 还小
    assert.equal(shouldRunTick(5000, 1000, TICK_MIN_INTERVAL_MS), true);
    assert.equal(shouldRunTick(0, 1000, TICK_MIN_INTERVAL_MS), true, '从没跑过必须跑');
    assert.equal(shouldRunTick(1000, 1000 + TICK_MIN_INTERVAL_MS, TICK_MIN_INTERVAL_MS), true);
    assert.equal(shouldRunTick(1000, 1000 + TICK_MIN_INTERVAL_MS - 1, TICK_MIN_INTERVAL_MS), false);
  });

  /* ───────────────── ② 直播索引引用复用 ───────────────── */

  const payload = [
    { liveId: '7001', userId: '1', nickname: '袁一琦', title: '袁一琦的房间', coverPath: 'https://x/1.jpg' },
    { liveId: '7002', userId: '2', nickname: '王奕', title: '王奕的房间', coverPath: 'https://x/2.jpg' },
  ];

  await check('直播状态没变时，两轮索引内容等价（可复用旧引用 → 零重渲染）', () => {
    const a = buildLiveIndex(payload);
    const b = buildLiveIndex(payload.slice().reverse()); // 顺序不同、内容相同
    assert.notEqual(a, b, '两个不同对象（这条断言保证比较有意义）');
    assert.equal(sameLiveIndex(a, b), true, '内容等价必须判为相同');
    assert.equal(sameLiveIndex(a, a), true);
  });

  await check('真有成员开播/下播时能识别出来（不能为了省渲染而漏更）', () => {
    const a = buildLiveIndex(payload);
    const off = buildLiveIndex([payload[0]]);
    assert.equal(sameLiveIndex(a, off), false, '有人下播必须判为不同');
    const changed = buildLiveIndex([payload[0], { ...payload[1], liveId: '7009' }]);
    assert.equal(sameLiveIndex(a, changed), false, '换了场次必须判为不同');
    const empty = buildLiveIndex([]);
    assert.equal(sameLiveIndex(a, empty), false);
    assert.equal(sameLiveIndex(empty, buildLiveIndex([])), true);
  });

  await check('高压：1000 轮「多数没变化、偶发真变化」的索引比较既不错杀也不漏更', () => {
    let s = 42;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    let reuse = 0;
    let miss = 0;
    let falseAlarm = 0;
    let detected = 0;
    /**
     * 每轮生成一个**变体号**：0 = 与上一轮内容相同；非 0 = 这一轮真的有人换了场次。
     * 判据是「本轮变体号与上一轮是否相同」，而不是"这一轮是不是基础内容" ——
     * 否则上一轮是变体、这一轮回到基础内容时会被误算成"没变化"（那是测试写错，不是函数错）。
     */
    let prevVariant = 0;
    let prev = buildLiveIndex(payload);
    for (let i = 0; i < 1000; i += 1) {
      const variant = rand() < 0.08 ? i + 1 : 0;
      const next = variant === 0
        ? buildLiveIndex(payload)
        : buildLiveIndex([payload[0], { ...payload[1], liveId: `700${variant}` }]);
      const same = sameLiveIndex(prev, next);
      const reallyChanged = variant !== prevVariant;
      if (reallyChanged) { if (same) miss += 1; else detected += 1; }
      else if (same) reuse += 1;
      else falseAlarm += 1;
      prev = next;
      prevVariant = variant;
    }
    assert.ok(detected > 40, `变化检测次数过少（${detected}）—— 用例没覆盖到"真变化"分支`);
    assert.equal(falseAlarm, 0, `${falseAlarm} 次「没变化却判成变了」→ 会造成无谓的整页重渲染`);
    assert.equal(miss, 0, `${miss} 次「真变了却判成没变」→ 列表不会更新`);
    assert.ok(reuse > 850, `复用率过低（${reuse}/1000）—— 说明等价比较没生效`);
  });

  /* ───────────────── ③ 结构性回归锁 ───────────────── */

  const ROOM = 'src/screens/FollowedRoomsScreen.tsx';
  const COUNTERS = 'src/screens/room/useRoomUnreadCounters.ts';
  const roomSrc = readFileSync(join(root, ROOM), 'utf8');
  const countersSrc = readFileSync(join(root, COUNTERS), 'utf8');

  await check(`${ROOM}：列表轮询走节流（进出房/切 tab 不再每次全量打接口）`, () => {
    assert.ok(roomSrc.includes('shouldRunTick('), '轮询 tick 必须过 shouldRunTick 节流');
    assert.ok(roomSrc.includes('TICK_MIN_INTERVAL_MS'), '必须引用统一的节流常量');
    assert.ok(roomSrc.includes('lastTickRef'), '必须有"上次真正跑过"的时间戳 ref');
  });

  await check(`${ROOM}：直播索引内容等价时复用旧引用`, () => {
    assert.ok(roomSrc.includes('sameLiveIndex('), '必须比较内容后再 setState，否则每 30s 整页重渲染');
    const hits = (roomSrc.match(/sameLiveIndex\(/g) || []).length;
    assert.ok(hits >= 2, `轮询与 loadFollowed 两处都要复用（当前 ${hits} 处）`);
  });

  await check(`${COUNTERS}：applyFingerprintCounts 引用恒定（依赖数组为空）`, () => {
    // 引用不恒定 = 每次进出房间都让轮询 effect 重跑（用户反馈的进出房卡顿）
    const at = countersSrc.indexOf('const applyFingerprintCounts = useCallback(');
    assert.ok(at > 0, '找不到 applyFingerprintCounts 定义');
    // ⚠️ 2026-11-09 起函数里加了「指纹精确计数」逻辑，4000 字符截不到依赖数组 → 放宽
    const tail = countersSrc.slice(at, at + 8000);
    const depIdx = tail.indexOf('}, [');
    assert.ok(depIdx > 0, '找不到依赖数组');
    const deps = tail.slice(depIdx, tail.indexOf(']);', depIdx));
    assert.equal(deps.replace(/\s|\[|\}/g, ''), ',', `依赖数组必须为空，实际：${deps}`);
    assert.ok(countersSrc.includes('selectedRoomRef'), '必须用 ref 读当前房间，不能把它放进依赖');
  });

  await check('进出房间的浮层复位清单仍完整（漏一个 = 用户说的「变灰/遮罩」）', () => {
    // 与 scripts/room-churn-audit.js 同一份清单，这里再钉一次（两个脚本互相独立，任一处漏都能被抓到）
    //
    // ⚠️ 2026-10-02 播放器统一：解析占位 / 弹幕列表 / 弹幕设置已收口到统一播放宿主
    //（MediaPlaybackHost 内部 state，随 roomPlaying=null 卸载），房间页不再有这三个开关；
    // 新增「房间播放器」本身（roomPlaying）：closeRoom 必须清（退房即停播并卸载宿主）。
    const RESET_OPEN = [
      'setRankVisible(false)',
      'setGiftVisible(false)',
      'setUserCard(null)',
      'setShowRoomReplay(false)',
      "setFullImageUrl('')",
      'setRoomSearchOpen(false)',
    ];
    const RESET_CLOSE = [...RESET_OPEN, 'setRoomPlaying(null)'];
    for (const [marker, RESET] of [['const closeRoom = useCallback', RESET_CLOSE], ['const openRoom = useCallback', RESET_OPEN]]) {
      const at = roomSrc.indexOf(marker);
      assert.ok(at > 0, `找不到 ${marker}`);
      const body = roomSrc.slice(at, at + 5000);
      const missing = RESET.filter((c) => !body.includes(c));
      assert.equal(missing.length, 0, `${marker} 缺少复位：${missing.join('、')}`);
    }
  });

  await check('房间消息：空结果不清空已有消息、失败不清空已有消息（"消息列表消失"的两条路径）', () => {
    assert.ok(roomSrc.includes('const keepPrev = sorted.length === 0'), '进房返回空必须保留旧列表');
    assert.ok(roomSrc.includes("if (mode !== 'internal') setRoomMessages([])"), 'internal 切换失败不能清屏');
    assert.ok(roomSrc.includes('followedMembers.length === 0 && followedRef.current.length > 0'), '关注列表算出空结果不能清掉已有列表');
  });
} catch (error) {
  results.push({ ok: false, name: '编译/载入源码', error });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.error(`  ✗ ${r.name}\n${r.error && r.error.message ? r.error.message : r.error}`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n[room-churn-sim] 结果：${passed} 通过 / ${results.length - passed} 失败`);
if (passed !== results.length) process.exitCode = 1;
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
