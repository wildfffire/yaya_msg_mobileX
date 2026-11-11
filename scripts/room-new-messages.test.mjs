// 房间「有 N 条新消息」浮标的计数回归锁（纯 Node）。
//
// 对标的桌面端实现：yk1z/yaya_msg src/renderer/followed-chat-feature.js
//   queueFollowedPendingBatch()  → followedPendingMessageIds（Set）+ followedPendingCount = set.size
//
// 三轮走过的弯路（都锁在这里，别退回去）：
//   ① 按时间窗重算 → 消息被列表挤出后数字会变小/归零；
//   ② 只认 event.nativeEvent.contentOffset → Reanimated 转过来的事件是**扁平**的，
//      y 恒为 0 → 永远判成「贴底」→ 浮标永远不涨；
//   ③ 自己发的消息、礼物/进房/公告也计数 → 数字虚高。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-newmsg-'));
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const read = (p) => readFileSync(join(root, p), 'utf8');

try {
  execSync(
    `npx tsc "${join(root, 'src', 'screens', 'room', 'newMessagePill.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'screens', 'room', 'newMessagePill.js')}`);
  const { pickNewIds, pickNewMessages, pushSeenIds, scrollOffsetY, isCountableRoomMessage, SEEN_ID_MAX } = mod;

  await check('首次：seen 为空 → 全部算新（调用方贴底时会立刻清空，不会弹数字）', () => {
    const items = [{ id: 'a', time: 100 }, { id: 'b', time: 200 }];
    assert.deepEqual(pickNewIds(items, new Set(), 0), ['a', 'b']);
  });

  await check('增量：见过的 id 不再算（实时 + 轮询 + 重连重放都只算一次）', () => {
    const seen = new Set(['a', 'b']);
    const items = [{ id: 'a', time: 100 }, { id: 'b', time: 200 }, { id: 'c', time: 300 }, { id: 'c', time: 300 }];
    assert.deepEqual(pickNewIds(items, seen, 0), ['c']);
  });

  await check('时间未知（0）的新消息照样计入（上一版会漏）', () => {
    const seen = new Set(['a']);
    assert.deepEqual(pickNewIds([{ id: 'a', time: 500 }, { id: 'x', time: 0 }], seen, 500), ['x']);
  });

  await check('上拉补历史：早于锚点的旧消息不算新消息', () => {
    const seen = new Set(['a']);
    const items = [
      { id: 'old1', time: 100 },
      { id: 'old2', time: 200 },
      { id: 'a', time: 500 },
      { id: 'new1', time: 600 },
    ];
    assert.deepEqual(pickNewIds(items, seen, 500), ['new1']);
  });

  await check('列表裁剪不会让数字倒退（增量口径的核心）', () => {
    let seen = new Set();
    let pending = new Set();
    const take = (items, anchor) => {
      const fresh = pickNewMessages(items, seen, anchor);
      for (const id of fresh.seen) seen.add(id);
      for (const id of fresh.counted) pending.add(id);
    };
    // 第一屏
    take([{ id: 'a', time: 1 }, { id: 'b', time: 2 }], 0);
    // 来 3 条新的
    take([{ id: 'b', time: 2 }, { id: 'c', time: 3 }, { id: 'd', time: 4 }], 2);
    // 再 2 条，同时最早的两条被挤出列表
    take([{ id: 'd', time: 4 }, { id: 'e', time: 5 }, { id: 'f', time: 6 }], 2);
    assert.equal(pending.size, 6, 'a..f 六条各计一次');
    // 补历史把旧消息拉回来：不应重复计数
    take([{ id: 'a', time: 1 }, { id: 'b', time: 2 }], 2);
    assert.equal(pending.size, 6);
  });

  await check('自己发的消息：记 seen 但不进数字（桌面端自己发的是直接上屏）', () => {
    let seen = new Set(['a']);
    const fresh = pickNewMessages([
      { id: 'me1', time: 300, self: true },
      { id: 'peer1', time: 301 },
    ], seen, 200);
    assert.deepEqual(fresh.seen, ['me1', 'peer1']);
    assert.deepEqual(fresh.counted, ['peer1']);
    // 记进 seen 后不会再被算第二次
    seen = new Set(fresh.seen);
    assert.deepEqual(pickNewMessages([{ id: 'me1', time: 300, self: true }], seen, 200).seen, []);
  });

  await check('礼物/进房/公告不计入数字（countable=false），聊天类才计', () => {
    const fresh = pickNewMessages([
      { id: 'gift', time: 300, countable: false },
      { id: 'enter', time: 301, countable: false },
      { id: 'msg', time: 302, countable: true },
      { id: 'legacy', time: 303 },
    ], new Set(), 200);
    assert.deepEqual(fresh.seen, ['gift', 'enter', 'msg', 'legacy']);
    assert.deepEqual(fresh.counted, ['msg', 'legacy'], '缺省（undefined）按「算」处理，避免漏计');
  });

  await check('消息类型判定：与房间列表角标同口径', () => {
    for (const t of ['TEXT', 'REPLY', 'GIFTREPLY', 'IMAGE', 'AUDIO', 'VIDEO', 'EXPRESSIMAGE', 'FLIP_CARD', 'BARRAGE_TEXT', '']) {
      assert.equal(isCountableRoomMessage(t), true, `${t || '(空)'} 应计入`);
    }
    for (const t of ['PRESENT_NORMAL', 'PRESENT_TEXT', 'EVENT_ENTER', 'LIVE_ANNOUNCE', 'VOTE', 'OPEN_LIVE', 'DELETE']) {
      assert.equal(isCountableRoomMessage(t), false, `${t} 不应计入`);
    }
    assert.equal(isCountableRoomMessage('text'), true, '大小写不敏感');
  });

  await check('滚动事件取值：扁平（Reanimated）与 nativeEvent（RN 合成）都要认', () => {
    // ★ 真凶回归锁：Reanimated 的 useAnimatedScrollHandler 事件是扁平的
    assert.equal(scrollOffsetY({ contentOffset: { y: 320 } }), 320);
    // 普通 RN 合成事件
    assert.equal(scrollOffsetY({ nativeEvent: { contentOffset: { y: 96 } } }), 96);
    // 脏数据一律 0，不能 NaN
    for (const bad of [undefined, null, {}, { contentOffset: null }, { nativeEvent: {} }, { contentOffset: { y: 'abc' } }]) {
      assert.equal(scrollOffsetY(bad), 0, `脏数据应得 0：${JSON.stringify(bad)}`);
    }
  });

  await check('seen 上限：超限丢最早的一半，集合与顺序表一致', () => {
    let order = [];
    for (let i = 0; i < SEEN_ID_MAX + 100; i += 1) order = pushSeenIds(order, [`k${i}`]);
    assert.equal(order.length, SEEN_ID_MAX);
    assert.equal(order[order.length - 1], `k${SEEN_ID_MAX + 99}`);
    const again = pushSeenIds(order, [order[order.length - 1]]);
    assert.equal(again.length, SEEN_ID_MAX, '重复 id 不追加');
  });

  // ---- 静态守卫：房间页真的接了增量口径，且阈值与吸底同源 ----
  const rooms = read('src/screens/FollowedRoomsScreen.tsx');
  const styles = read('src/screens/room/roomStyles.ts');
  await check('房间页接线：seen/counted 增量 + 滚动锚点 + 浮标点击回底', () => {
    assert.ok(rooms.includes('pickNewMessages('));
    assert.ok(rooms.includes('pushSeenIds('));
    assert.ok(rooms.includes('seenMsgSetRef'));
    assert.ok(rooms.includes('pendingMsgIdsRef'));
    assert.ok(rooms.includes('onScroll: handleChatListScroll'));
    assert.ok(rooms.includes('jumpToNewestMessages'));
    assert.ok(rooms.includes("t('有 {n} 条新消息'"));
    assert.ok(rooms.includes('scrollToOffset?.({ offset: 0, animated: true })'));
    assert.ok(!rooms.includes('newMsgCount('), '旧的「按时间窗重算」必须彻底移除');
  });
  await check('滚动事件必须走 scrollOffsetY（只读 nativeEvent 会让 y 恒为 0）', () => {
    assert.ok(rooms.includes('scrollOffsetY(event)'), '必须用 scrollOffsetY 取偏移');
    assert.ok(!rooms.includes('nativeEvent?.contentOffset?.y'), '不允许再直接读 nativeEvent');
  });
  await check('计数口径：自己发的 / 非聊天类都要排除，并带上消息类型判定', () => {
    assert.ok(rooms.includes('isCountableRoomMessage('));
    // 「自己发的」判定必须与气泡同侧口径一致（messageRole → 'mine'），不能用 im.user._id === 'SELF'
    assert.ok(rooms.includes("=== 'mine'"), '自己发的消息要单独标记');
  });
  await check('吸底阈值唯一口径 CHAT_STICK_BOTTOM_DP（48）三处同步', () => {
    assert.ok(rooms.includes('const CHAT_STICK_BOTTOM_DP = 48;'));
    assert.ok(rooms.includes('scrollToBottomOffset={CHAT_STICK_BOTTOM_DP}'));
    assert.ok(rooms.includes('autoscrollToTopThreshold: CHAT_STICK_BOTTOM_DP'));
    assert.ok(rooms.includes('y <= CHAT_STICK_BOTTOM_DP'));
  });
  await check('贴底判定必须滞回：离开 48 / 回到 12（真机上 y 会在 48~60 自己抖）', () => {
    assert.ok(rooms.includes('const CHAT_RETURN_BOTTOM_DP = 12;'));
    assert.ok(rooms.includes('wasBottom ? y <= CHAT_STICK_BOTTOM_DP : y <= CHAT_RETURN_BOTTOM_DP'));
  });
  await check('计数数据源：用房间全部消息（只看偶像视图下群聊消息也计数）', () => {
    // 旧版 PILL_COUNT_ALL_ROOM_MESSAGES 恒为 true（false 分支是死代码），已直接收敛为 roomMessages
    assert.ok(!rooms.includes('PILL_COUNT_ALL_ROOM_MESSAGES'), '恒定开关已删除，不要再回来');
    assert.ok(rooms.includes('const pillSource = roomMessages;'), '浮标计数数据源必须是房间全部消息');
    assert.ok(rooms.includes('messageRole(item, selectedRoom as Member, showFanMessages, selfIds, memberIdSet) === \'mine\''));
  });
  await check('清零必须带原因（日志里能看出是谁清的）', () => {
    assert.ok(rooms.includes("clearNewMsg('切房/切视图')"));
    assert.ok(rooms.includes("clearNewMsg('贴底时来了新消息')"));
    assert.ok(rooms.includes("clearNewMsg('点浮标回底')"));
    assert.ok(rooms.includes('（${reason}）'), '清零日志要带原因');
  });
  await check('浮标样式存在（居中、不吃整层触摸）', () => {
    assert.ok(styles.includes('roomNewMsgPill'));
    assert.ok(styles.includes('roomNewMsgWrap'));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`room-new-messages: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
