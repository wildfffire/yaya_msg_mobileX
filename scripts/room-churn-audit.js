/**
 * 「反复进出房间 / 页面」的**静态压力审计**（纯 Node，零依赖，随 npm run test:core 一起跑）。
 *
 * 用户 2026-09-30：「反复进入退出房间，就会有遮罩」「要全方位做压力测试」。
 * 这类问题的本质是**配对失衡**：加了订阅/定时器/浮层，却漏了对应的清理/复位。
 * 逐个人肉 review 会漏，所以把「必须成对出现」的约束写成脚本，每次改完自动检查：
 *   1) 定时器：setInterval 必须有 clearInterval（同文件计数）；
 *   2) 订阅：addEventListener / addListener / observeRoomMessages 必须有 remove/unsubscribe/unsub；
 *   3) 房间浮层复位清单：openRoom 与 closeRoom 必须都包含全部客厅级浮层的复位调用；
 *   4) 铺满层必须声明 pointerEvents（否则会吃掉整个区域的触摸 = "卡住"）；
 *   5) 几条已被反复踩过的关键实现（弹幕双通道去重、播放器 close 判定、web 内核复位）必须保持。
 *
 * 它只做「结构性」检查（存在性/配对），不做运行时断言 —— 运行时的兜底由
 * FollowedRoomsScreen 的"残留层自愈哨兵"负责（见那里的注释）。
 */
const { readFileSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}
function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}
function count(source, re) {
  return (source.match(re) || []).length;
}

const ROOM = 'src/screens/FollowedRoomsScreen.tsx';
const PLAYER_SCREEN = 'src/player/PlayerScreen.tsx';
const PLAYER_STORE = 'src/player/store/playerStore.ts';
const DANMAKU = 'src/components/DanmakuOverlay.tsx';
const BARRAGE_HOOK = 'src/hooks/useLiveBarrage.ts';

// 1) 定时器配对
for (const file of [ROOM, PLAYER_SCREEN, DANMAKU, BARRAGE_HOOK, 'src/player/chrome/PlayerChrome.tsx', 'src/components/GiftEffectOverlay.tsx']) {
  check(`${file}：setInterval 与 clearInterval 配对`, () => {
    const src = read(file);
    const created = count(src, /setInterval\(/g);
    const cleared = count(src, /clearInterval\(/g);
    if (created > cleared) {
      throw new Error(`setInterval ${created} 处，clearInterval 只有 ${cleared} 处 —— 有定时器没有清理路径`);
    }
  });
}

// 2) 订阅配对
for (const file of [ROOM, PLAYER_SCREEN, 'src/player/chrome/FullscreenManager.tsx', 'src/services/pocketNim/qchat.ts', 'src/hooks/useLiveBarrage.ts']) {
  check(`${file}：事件订阅有对应的退订`, () => {
    const src = read(file);
    const subs = count(src, /\.addEventListener\(/g) + count(src, /\.addListener\(/g);
    const offs = count(src, /\.remove\(\)/g) + count(src, /sub\.remove|subscription\.remove|appStateSub\.remove/g);
    if (subs > offs) {
      throw new Error(`订阅 ${subs} 处，remove/unsub 只有 ${offs} 处 —— 存在"订阅了但从不退订"的风险`);
    }
  });
}

// 3) 房间浮层复位清单（openRoom 与 closeRoom 都要有）
//
// ⚠️ 2026-10-02 播放器统一 / 2026-11-13 播放周边面板收口后清单变化：
//   · 解析占位 / 弹幕列表 / 弹幕设置 / **贡献榜** 已收口到统一播放宿主
//     （MediaPlaybackHost 内部 state，随 roomPlaying=null 一起卸载）——
//     房间页不再有这些开关，无法也不需要在 openRoom/closeRoom 里复位；
//   · 礼物面板只剩「未起播时工具栏送礼」这一个本页实例（起播后由宿主内置），
//     所以 setGiftVisible(false) 仍必须复位；
//   · 「房间播放器」本身（roomPlaying）：closeRoom 必须清（退房即停播 + 卸载宿主）。
const ROOM_RESET_CALLS = [
  ['setGiftVisible(false)', '礼物面板 Modal'],
  ['setUserCard(null)', '用户资料卡 Modal'],
  ['setShowRoomReplay(false)', '回放抽屉'],
  ["setFullImageUrl('')", '大图查看 Modal'],
  ['setRoomSearchOpen(false)', '房间内搜索态（残留会把消息全隐藏 = 列表"卡没"）'],
];
const CLOSE_RESET_CALLS = [
  ...ROOM_RESET_CALLS,
  ['setRoomPlaying(null)', '房间播放器（含宿主：解析占位/弹幕面板随卸载收掉）'],
];
check(`${ROOM}：closeRoom 复位全部房间级浮层（漏一个就是一次"遮罩"）`, () => {
  const src = read(ROOM);
  const at = src.indexOf('const closeRoom = useCallback');
  if (at < 0) throw new Error('找不到 closeRoom 定义');
  const body = src.slice(at, at + 4200);
  const missing = CLOSE_RESET_CALLS.filter(([call]) => !body.includes(call)).map(([, label]) => label);
  if (missing.length) throw new Error(`closeRoom 缺少复位：${missing.join('、')}`);
});
check(`${ROOM}：openRoom 复位全部房间级浮层（防止"换房带着上一层的黑幕"）`, () => {
  const src = read(ROOM);
  const at = src.indexOf('const openRoom = useCallback');
  if (at < 0) throw new Error('找不到 openRoom 定义');
  const body = src.slice(at, at + 4200);
  const missing = ROOM_RESET_CALLS.filter(([call]) => !body.includes(call)).map(([, label]) => label);
  if (missing.length) throw new Error(`openRoom 缺少复位：${missing.join('、')}`);
});
check(`${ROOM}：存在"不在房间却有残留层"的自愈哨兵`, () => {
  const src = read(ROOM);
  if (!src.includes('不在房间但仍有残留层')) {
    throw new Error('缺少残留层自愈哨兵 —— 以后新加的浮层一旦漏复位就会永久留在屏幕上（遮罩）');
  }
});

// 4) 铺满层必须声明 pointerEvents（否则吃触摸 = 卡住）
//    2026-11-12：飘屏支持点按开资料卡，pointerEvents 改成条件式
//    （interactive ? 'box-none' : 'none'），所以锁「非交互时必须是 none」这个语义，
//    不再锁字面量写法 —— 否则可点飘屏一上线这条回归锁就误报。
check(`${DANMAKU}：铺满层非交互时 pointerEvents="none"`, () => {
  const src = read(DANMAKU);
  const ok = src.includes("pointerEvents=\"none\"")
    || /pointerEvents=\{[^}]*\?\s*'box-none'\s*:\s*'none'[^}]*\}/.test(src);
  if (!ok) throw new Error('飘屏层是铺满层，非交互时必须声明 pointerEvents="none"');
});
check(`${ROOM}：消息区错误浮层 pointerEvents="box-none"`, () => {
  const src = read(ROOM);
  if (!src.includes('roomErrorWrap} pointerEvents="box-none"')) {
    throw new Error('消息加载失败浮层是 absoluteFill，必须 box-none（否则整片消息区点不动）');
  }
});

// 5) 关键实现回归锁
check('弹幕去重：id 永久集合 + 无 id 内容短窗（双通道，别再退回单一集合）', () => {
  const src = read(DANMAKU);
  if (!src.includes('seenLiveIdsRef') || !src.includes('seenContentRef')) {
    throw new Error('飘屏去重必须是双通道 —— 单一集合会分别造成「重复飘出」或「列表有屏上没有」');
  }
});
check(`${PLAYER_SCREEN}：卸载时按"同一场次"判定再 close（换线路也要能关）`, () => {
  const src = read(PLAYER_SCREEN);
  if (!src.includes('sameSession')) {
    throw new Error('卸载清理必须用 sameSession 判定 —— 用 url 严格相等会在换线路后失效，播放器与弹幕大对象退不掉');
  }
});
check(`${PLAYER_STORE}：close() 复位网页内核开关（不然 B 站播放器会漏到房间）`, () => {
  const src = read(PLAYER_STORE);
  const at = src.indexOf('close: () =>');
  if (at < 0) throw new Error('找不到 close()');
  // 窗口要够大：close() 里带着大段中文注释（说明为什么必须复位），窗口太小会误判成"没复位"
  const body = src.slice(at, at + 2600);
  if (!body.includes('useWebKernel: false') || !body.includes('forceWebOnce: false')) {
    throw new Error('close() 必须同时复位 useWebKernel / forceWebOnce（用户明确要求房间不要用网页播放器）');
  }
});
check(`${BARRAGE_HOOK}：自愈重连不设次数上限 + 看门狗阈值 ≤ 60s`, () => {
  const src = read(BARRAGE_HOOK);
  if (!src.includes('RECONNECT_DELAYS') || src.includes('attempt > RECONNECT_DELAYS.length) return;')) {
    throw new Error('重连不应有次数上限（被服务端反复踢时会永久停住）');
  }
  const m = src.match(/WATCHDOG_IDLE_MS = ([\d_]+)/);
  const ms = m ? Number(m[1].replace(/_/g, '')) : 0;
  if (!ms || ms > 60_000) throw new Error(`看门狗阈值 ${ms}ms 过长（应 ≤60s，否则用户早就以为坏了）`);
});
check(`${ROOM}：点头像开播必须用真实 liveId（禁止把成员库 liveRoomId 当 liveId）`, () => {
  const src = read(ROOM);
  // 2026-11-01 真机 + 接口实证：朱丽娜 member.liveRoomId = 9468252673 是**聊天室号**
  //（= getLiveOne 返回的 content.roomId），该场真 liveId = 1323781527529394176。
  // 拿聊天室号去 getLiveOne → status 10049「该成员直播已被删除」→ 玩家侧表现就是
  // 「点头像进不去直播间」；房间内直播卡 / 直播页带的是真 liveId，所以那两条正常。
  if (src.includes("?.liveRoomId || '') || String(entry?.liveId")) {
    throw new Error('openMemberLive 又把 liveRoomId（聊天室号）排在 liveId 前面 —— 带该字段的成员点头像必然打不开');
  }
  if (!src.includes('/^\\d{15,20}$/')) {
    throw new Error('openMemberLive 缺少 liveId 形态兜底校验（15~20 位纯数字）');
  }
  if (!src.includes('liveEntryForMember(member, liveNowRef.current)')) {
    throw new Error('openMemberLive 必须从「直播中」索引取真实场次 id');
  }
});

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.error(`  ✗ ${r.name}\n${r.error && r.error.message ? r.error.message : r.error}`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n[room-churn-audit] 结果：${passed} 通过 / ${results.length - passed} 失败`);
if (passed !== results.length) process.exitCode = 1;
