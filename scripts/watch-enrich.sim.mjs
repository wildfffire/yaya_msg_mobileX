/**
 * 「观看历史 / 稍后再看」补全管线的**真实形态模拟测试**（纯 Node，零新增依赖）。
 *
 * 用户 2026-09-30 的要求：①「为什么直播/录播能完美匹配成员名称与队伍，历史和稍后再看经常出问题」；
 * ②「模拟真实情况多次测试再交付」。
 *
 * 这里**不 mock React**：补全的决策逻辑已经抽到 `utils/watchMeta`（纯函数），
 * 本脚本直接编译它并按真机上的真实时序跑：
 *   - 成员库是**异步**的（前 N 轮 lookup 为空，模拟"还没同步完"就打开列表）；
 *   - 官方录播表只能覆盖**最近一部分**场次（老直播要靠逐条 getLiveOne）；
 *   - 网络会**随机失败**（抖动 / 接口 200 但字段为空）；
 *   - 条目形态按真实入口分层（带 ownerId / 只带昵称 / 昵称带团体前缀 / 只有标题 / 什么都没有）。
 *
 * 断言：跑完模拟后，每条历史/稍后再看条目的**成员名与队伍必须与真值完全一致**，
 * 并且「旧口径（昵称字符串精确相等）」确实会失败 —— 把根因钉成回归锁，改坏就报错。
 */
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-watch-enrich-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

/** 可复现的伪随机（跑多次测试要能定位到具体种子） */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'watchMeta.ts')}" "${join(root, 'src', 'utils', 'memberMatch.ts')}" "${join(root, 'src', 'utils', 'watchKeys.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const watchMeta = await import(`file://${join(tmp, 'src', 'utils', 'watchMeta.js')}`);
  const memberMatch = await import(`file://${join(tmp, 'src', 'utils', 'memberMatch.js')}`);
  const watchKeys = await import(`file://${join(tmp, 'src', 'utils', 'watchKeys.js')}`);

  const { resolveWatchMeta, planEnrich, patchFromRaw, needsEnrich, patchHasValue } = watchMeta;
  const { buildMemberLookup, resolveTeam, normMemberName } = memberMatch;
  const { historyKey, mergeHistoryItems, watchLaterBucket } = watchKeys;

  for (const fn of ['resolveWatchMeta', 'planEnrich', 'patchFromRaw', 'needsEnrich']) {
    if (typeof watchMeta[fn] !== 'function') throw new Error(`编译产物缺少 ${fn} —— 拒绝以「通过」结束`);
  }

  /* ─────────────────────────── 真实形态的假数据 ─────────────────────────── */

  /** 真值成员表（形态对齐 member-db：ownerName 不带团体前缀，team 是 "TEAM SII" 这类） */
  const TEAMS = ['TEAM SII', 'TEAM NII', 'TEAM HII', 'TEAM X', '预备生', 'TEAM G', 'TEAM Z', 'TEAM B'];
  const SURNAME = ['袁', '王', '李', '张', '刘', '陈', '杨', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡'];
  const GIVEN = ['一琦', '奕', '艺', '思', '梦', '欣', '婷', '佳', '蕊', '晗', '珂', '琳', '蕾', '楠', '茜'];
  function buildMembers(rand, n) {
    const used = new Set();
    const out = [];
    for (let i = 0; i < n; i += 1) {
      let name = '';
      for (let guard = 0; guard < 50; guard += 1) {
        name = `${SURNAME[Math.floor(rand() * SURNAME.length)]}${GIVEN[Math.floor(rand() * GIVEN.length)]}`;
        if (!used.has(name)) break;
      }
      if (used.has(name)) continue;
      used.add(name);
      out.push({
        id: String(100000 + i),
        ownerName: name,
        team: TEAMS[Math.floor(rand() * TEAMS.length)],
        pinyin: `PinYin${i}`,
        channelId: String(6000000 + i),
        yklzId: String(6100000 + i),
        serverId: String(1100000 + i),
      });
    }
    return out;
  }

  /**
   * 生成「真值事件」：每场直播的真实归属 + 真实时长。
   * 标题里**故意塞进另一个成员的名字**（公演/连麦类标题的真实形态），
   * 用来验证「出现位置最靠前 + 名字最长」的选人规则不会配错人。
   */
  function buildEvents(rand, members, n) {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const m = members[Math.floor(rand() * members.length)];
      const other = members[Math.floor(rand() * members.length)];
      const kind = rand() < 0.75 ? 'live' : 'video';
      const liveId = String(700000000000 + i);
      const videoId = kind === 'video' ? String(900000 + i) : '';
      const duration = 600 + Math.floor(rand() * 5400);
      const title = rand() < 0.35
        ? `${m.ownerName}的${rand() < 0.5 ? '公演' : '直播'}（嘉宾：${other.ownerName}）`
        : `${m.ownerName}的房间`;
      out.push({
        liveId,
        videoId,
        kind,
        duration,
        title,
        userId: m.id,
        nickname: m.ownerName,
        team: m.team,
        memberId: m.id,
      });
    }
    return out;
  }

  /**
   * 按真实入口把「真值事件」退化成**存储里的条目**（这就是历史/稍后再看的原始数据）。
   * 各入口携带的信息量不同 —— 正是"有的有成员名、有的只有标题"的来源。
   */
  function degrade(rand, ev) {
    const roll = rand();
    const base = {
      key: ev.liveId ? historyKey({ liveId: ev.liveId }) : historyKey({ ref: { kind: 'video', id: ev.videoId } }),
      liveId: ev.liveId,
      videoId: ev.videoId,
      title: ev.title,
      duration: 0,
    };
    if (roll < 0.18) {
      // ① 修好后的直播页写入：成员名 + 队伍 + 成员 id 全带（最理想，也应是最常见）
      return { ...base, owner: ev.nickname, team: ev.team, ownerId: ev.userId, duration: ev.duration };
    }
    if (roll < 0.36) {
      // ② 只有成员 id（历史页点击后再播一次写回的情形）
      return { ...base, ownerId: ev.userId };
    }
    if (roll < 0.52) {
      // ③ 只有昵称（**不带**团体前缀）
      return { ...base, owner: ev.nickname };
    }
    if (roll < 0.66) {
      // ④ 昵称**带团体前缀**（接口形态之一；旧口径精确匹配必失败）
      return { ...base, owner: `SNH48-${ev.nickname}` };
    }
    if (roll < 0.8) {
      // ⑤ 只有标题（什么成员字段都没有）
      return { ...base };
    }
    // ⑥ 什么展示字段都没有，只有 liveId（解析中就被记录的那一次）
    return { ...base, title: '' };
  }

  /** 官方录播表：只覆盖最近一部分场次（真机行为 —— 老直播查不到） */
  function buildVodTable(events, coverage) {
    const map = new Map();
    const cut = Math.floor(events.length * coverage);
    for (let i = 0; i < cut; i += 1) {
      const ev = events[i];
      map.set(ev.liveId, {
        liveId: ev.liveId,
        title: ev.title,
        liveCover: `https://source.48.cn/${ev.liveId}.jpg`,
        userInfo: { userId: ev.userId, nickname: ev.nickname },
        startTime: String(1700000000000 + i),
        endTime: String(1700000000000 + i + ev.duration * 1000),
        liveType: 1,
      });
    }
    return map;
  }

  /** 逐条详情接口（模拟：随机失败 + 偶发「200 但字段为空」） */
  function makeDetailApi(events, rand, failRate) {
    const byLive = new Map(events.map((e) => [e.liveId, e]));
    return async (liveId) => {
      if (rand() < failRate) throw new Error('network error');
      const ev = byLive.get(String(liveId));
      if (!ev) throw new Error('not found');
      if (rand() < 0.08) return { content: {} }; // 200 但什么都没有
      return {
        content: {
          title: ev.title,
          liveCover: `https://source.48.cn/${ev.liveId}.jpg`,
          userInfo: { userId: ev.userId, nickname: ev.nickname },
          stime: String(1700000000000),
          endTime: String(1700000000000 + ev.duration * 1000),
          type: 1,
        },
      };
    };
  }

  /**
   * 按真机时序跑一次完整补全：
   *   - 成员库延迟 `memberDelayRounds` 轮才就绪（未就绪时 lookup 为空）；
   *   - 每轮计划 → 本地补丁立即写回 → 网络兜底（并发顺序执行，随机失败）；
   *   - 尝试次数上限 3，失败只 +1（不再"永久放弃"）。
   */
  async function simulate({ seed, memberCount, eventCount, coverage, failRate, memberDelayRounds }) {
    const rand = makeRandom(seed);
    const members = buildMembers(rand, memberCount);
    const events = buildEvents(rand, members, eventCount);
    const lookup = buildMemberLookup(members);
    const emptyLookup = buildMemberLookup([]);
    const vod = buildVodTable(events, coverage);
    const detail = makeDetailApi(events, rand, failRate);

    let items = events.map((ev) => degrade(rand, ev));
    const attempts = new Map();
    let rounds = 0;
    let memberReady = false;

    while (rounds < 200) {
      rounds += 1;
      if (!memberReady && rounds > memberDelayRounds) memberReady = true;
      const activeLookup = memberReady ? lookup : emptyLookup;
      if (memberReady) attempts.clear(); // 成员库到位 → 重新给机会（真机同一行为）

      const plan = planEnrich({
        items,
        vod,
        video: new Map(),
        lookup: activeLookup,
        attempts,
        inFlight: [],
        limit: 12,
        maxAttempts: 3,
      });
      if (!plan.active) break;

      for (const { key, patch } of plan.patches) {
        const it = items.find((x) => x.key === key);
        if (!it) continue;
        // store.patch 的语义：**只补空值**
        if (patch.owner && !it.owner) it.owner = patch.owner;
        if (patch.team && !it.team) it.team = patch.team;
        if (patch.ownerId && !it.ownerId) it.ownerId = patch.ownerId;
        if (patch.duration && !it.duration) it.duration = patch.duration;
      }
      for (const key of plan.bumped) attempts.set(key, (attempts.get(key) || 0) + 1);

      for (const key of plan.network) {
        const it = items.find((x) => x.key === key);
        if (!it) continue;
        const used = attempts.get(key) || 0;
        try {
          const res = it.liveId ? await detail(it.liveId) : null;
          // 与 hook 的 runNetwork 一致：先剥掉 content 外壳再交给 patchFromRaw
          const p = res ? patchFromRaw(res?.content ?? res, false, activeLookup) : null;
          if (p && patchHasValue(p)) {
            if (p.owner && !it.owner) it.owner = p.owner;
            if (p.team && !it.team) it.team = p.team;
            if (p.ownerId && !it.ownerId) it.ownerId = p.ownerId;
            if (p.duration && !it.duration) it.duration = p.duration;
            attempts.delete(key);
          } else {
            attempts.set(key, used + 1);
          }
        } catch {
          attempts.set(key, used + 1);
        }
      }
    }

    return { items, events, members, rounds, lookup };
  }

  /* ─────────────────────────── 断言 ─────────────────────────── */

  const truthOf = (events, key) => events.find((e) => historyKey({ liveId: e.liveId }) === key
    || historyKey({ ref: { kind: 'video', id: e.videoId } }) === key);

  await check('根因锁：昵称**带团体前缀**时，旧口径（精确相等）必失败、新口径（归一）必成功', () => {
    const members = [{ id: '100001', ownerName: '袁一琦', team: 'TEAM SII', pinyin: 'YuanYiQi' }];
    const lookup = buildMemberLookup(members);
    // 旧口径：直接拿 ownerName 当键做精确相等
    const oldMap = new Map(members.map((m) => [String(m.ownerName).trim(), m]));
    assert.equal(oldMap.get('SNH48-袁一琦')?.team, undefined, '旧口径本应失败（这条断言保证它确实会失败）');
    // 新口径
    assert.equal(resolveTeam(lookup, { name: 'SNH48-袁一琦' }), 'TEAM SII');
    assert.equal(resolveTeam(lookup, { name: ' 袁一琦 ' }), 'TEAM SII');
    assert.equal(resolveTeam(lookup, { userId: '100001' }), 'TEAM SII');
    assert.equal(normMemberName('SNH48-袁一琦'), '袁一琦');
  });

  await check('根因锁：直播页卡片口径（userId）与写历史的口径（昵称）现在返回同一支队伍', () => {
    const members = [{ id: '100002', ownerName: '王奕', team: 'TEAM HII', pinyin: 'WangYi' }];
    const lookup = buildMemberLookup(members);
    // 直播页卡片：teamOfItem(it) —— 只有 userInfo.userId
    const card = resolveTeam(lookup, { userId: '100002' });
    // 写历史/历史卡片：没有 id，只有昵称
    const historyCard = resolveTeam(lookup, { name: '王奕' });
    assert.equal(card, 'TEAM HII');
    assert.equal(historyCard, card, '两条链路必须一致（不一致 = 「卡片有徽章、历史没有」）');
  });

  await check('标题反查：标题里有两人时取**靠前**那个（旧规则按名字长度取，会配错人）', () => {
    const members = [
      { id: '1', ownerName: '袁一琦', team: 'TEAM SII', pinyin: 'a' },
      { id: '2', ownerName: '王奕', team: 'TEAM HII', pinyin: 'b' },
      { id: '3', ownerName: '张语格', team: 'TEAM NII', pinyin: 'c' },
    ];
    const lookup = buildMemberLookup(members);
    // 「王奕」短（2 字）、「袁一琦」长（3 字）：标题里王奕在前 → 必须选王奕
    const hit = memberMatch.matchMemberByTitle('王奕和袁一琦的连麦', lookup);
    assert.equal(hit?.id, '2', `应命中靠前的成员，实际命中 ${hit?.ownerName}`);
    const hit2 = memberMatch.matchMemberByTitle('袁一琦的房间（嘉宾：王奕）', lookup);
    assert.equal(hit2?.id, '1');
  });

  await check('本地兜底：只有 ownerId / 只有昵称 / 只有标题，都能补出队伍', () => {
    const members = [{ id: '100003', ownerName: '李艺', team: 'TEAM X', pinyin: 'LiYi' }];
    const lookup = buildMemberLookup(members);
    assert.equal(resolveWatchMeta({ key: 'a', ownerId: '100003' }, lookup)?.team, 'TEAM X');
    assert.equal(resolveWatchMeta({ key: 'b', owner: '李艺' }, lookup)?.team, 'TEAM X');
    assert.equal(resolveWatchMeta({ key: 'c', title: '李艺的房间' }, lookup)?.team, 'TEAM X');
    assert.equal(resolveWatchMeta({ key: 'd', title: '今天也很开心' }, lookup), null);
  });

  await check('批量表命中：一条录播项能同时补齐成员名 / 队伍 / 时长 / 封面 / 类型', () => {
    const members = [{ id: '100004', ownerName: '刘欣', team: 'TEAM G', pinyin: 'LiuXin' }];
    const lookup = buildMemberLookup(members);
    const raw = {
      liveId: '7001',
      title: '刘欣的直播',
      liveCover: 'https://source.48.cn/a.jpg',
      userInfo: { userId: '100004', nickname: '刘欣' },
      startTime: '1700000000000',
      endTime: '1700003600000', // +3600s
      liveType: 1,
    };
    const p = patchFromRaw(raw, false, lookup);
    assert.equal(p.owner, '刘欣');
    assert.equal(p.team, 'TEAM G');
    assert.equal(p.ownerId, '100004');
    assert.equal(p.duration, 3600);
    assert.equal(p.cover, 'https://source.48.cn/a.jpg');
    assert.equal(p.liveType, 1);
  });

  await check('规划器：没有网络入口的条目只记一次尝试，绝不空转', () => {
    const lookup = buildMemberLookup([]);
    const items = [{ key: 'x', title: '未知成员的房间', owner: '', team: '', duration: 0 }];
    const p = planEnrich({ items, lookup, limit: 12, maxAttempts: 3 });
    assert.equal(p.network.length, 0, '没有 liveId/videoId 不该产生网络请求');
    assert.deepEqual(p.bumped, ['x'], '应记一次尝试，避免每轮重复扫描');
  });

  await check('规划器：失败不再永久放弃（尝试次数到上限前会重试，成功后清零）', () => {
    const lookup = buildMemberLookup([]);
    const items = [{ key: 'y', liveId: '7002', owner: '', team: '', duration: 0 }];
    const rounds = [];
    const attempts = new Map();
    for (let i = 0; i < 4; i += 1) {
      const p = planEnrich({ items, lookup, attempts, limit: 12, maxAttempts: 3 });
      rounds.push(p.network.length);
      for (const k of p.bumped) attempts.set(k, (attempts.get(k) || 0) + 1);
      // 模拟失败：只 +1
      for (const k of p.network) attempts.set(k, (attempts.get(k) || 0) + 1);
    }
    assert.equal(rounds[0], 1, '第 1 轮应发起请求');
    assert.equal(rounds[1], 1, '第 2 轮仍应重试（旧实现这里已是 0 = 永久放弃）');
    assert.equal(rounds[2], 1, '第 3 轮仍应重试');
    assert.equal(rounds[3], 0, '达到上限后停止，不再无限打扰');
  });

  // ── 多次真实模拟（不同随机种子 / 不同网络与成员库时序）─────────────────
  const SCENARIOS = [
    { seed: 20260930, memberCount: 120, eventCount: 40, coverage: 0.5, failRate: 0.0, memberDelayRounds: 0 },
    { seed: 777, memberCount: 200, eventCount: 80, coverage: 0.3, failRate: 0.2, memberDelayRounds: 2 },
    { seed: 1234, memberCount: 60, eventCount: 25, coverage: 0.0, failRate: 0.35, memberDelayRounds: 3 },
    { seed: 99991, memberCount: 300, eventCount: 120, coverage: 0.8, failRate: 0.1, memberDelayRounds: 1 },
    { seed: 424242, memberCount: 80, eventCount: 60, coverage: 0.15, failRate: 0.45, memberDelayRounds: 4 },
  ];

  for (const sc of SCENARIOS) {
    await check(
      `真实模拟 seed=${sc.seed}（成员 ${sc.memberCount} / 条目 ${sc.eventCount} / 表覆盖 ${Math.round(sc.coverage * 100)}% / 失败率 ${Math.round(sc.failRate * 100)}% / 成员库延迟 ${sc.memberDelayRounds} 轮）`,
      async () => {
        const { items, events, lookup } = await simulate(sc);
        let wrongOwner = 0;
        let wrongTeam = 0;
        let noTeam = 0;
        for (const it of items) {
          const ev = truthOf(events, it.key);
          assert.ok(ev, `找不到条目 ${it.key} 的真值`);
          // 成员名：允许「带团体前缀」这种同义写法，归一化后必须一致
          if (!it.owner || memberMatch.normMemberName(it.owner) !== memberMatch.normMemberName(ev.nickname)) wrongOwner += 1;
          if (!it.team) noTeam += 1;
          else if (it.team !== ev.team) wrongTeam += 1;
        }
        assert.equal(wrongOwner, 0, `${wrongOwner} 条成员名与真值不一致`);
        assert.equal(noTeam, 0, `${noTeam} 条仍然没有队伍（"队伍显示不出来"）`);
        assert.equal(wrongTeam, 0, `${wrongTeam} 条队伍配错人`);
        assert.ok(lookup.size > 0, '成员索引不应为空');
      },
    );
  }

  // ── 高压：连续 60 次随机场景，全部必须达标 ──────────────────────────────
  await check('高压随机 60 次：成员名 / 队伍零错误', async () => {
    let total = 0;
    let bad = 0;
    for (let i = 0; i < 60; i += 1) {
      const sc = {
        seed: 1000 + i * 37,
        memberCount: 60 + Math.floor((i * 13) % 240),
        eventCount: 20 + Math.floor((i * 7) % 90),
        coverage: (i % 5) / 5,
        failRate: (i % 6) * 0.08,
        memberDelayRounds: i % 5,
      };
      const { items, events } = await simulate(sc);
      for (const it of items) {
        const ev = truthOf(events, it.key);
        total += 1;
        if (!it.owner || memberMatch.normMemberName(it.owner) !== memberMatch.normMemberName(ev.nickname)) bad += 1;
        else if (!it.team || it.team !== ev.team) bad += 1;
      }
    }
    assert.equal(bad, 0, `${bad}/${total} 条条目成员名或队伍不对`);
  });

  await check('去重与合并不受影响（旧回归锁仍成立）', () => {
    const merged = mergeHistoryItems([
      { key: 'replay:7009', owner: '袁一琦', duration: 0, at: 100 },
      { key: 'live:7009', team: 'TEAM SII', ownerId: '100001', at: 90 },
    ]);
    assert.equal(merged.length, 1, '同一场直播必须合并成一条');
    assert.equal(merged[0].key, 'live:7009');
    assert.equal(merged[0].owner, '袁一琦');
    assert.equal(merged[0].team, 'TEAM SII');
    assert.equal(merged[0].ownerId, '100001', '合并必须带上成员 id（否则队伍永远补不回来）');
    assert.equal(watchLaterBucket('openlive', '7009'), watchLaterBucket('replay', '7009'));
  });
} catch (error) {
  results.push({ ok: false, name: '编译/载入源码', error });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.error(`  ✗ ${r.name}\n${r.error && r.error.message ? r.error.message : r.error}`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n[watch-enrich.sim] 结果：${passed} 通过 / ${results.length - passed} 失败`);
if (passed !== results.length) process.exitCode = 1;
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
