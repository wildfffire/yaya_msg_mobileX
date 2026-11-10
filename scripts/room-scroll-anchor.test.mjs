// 房间消息列表「新消息不再顶走视口」静态回归锁（纯 Node，零新增依赖）。
//
// 背景（用户反馈 2026-10-09）：「房间内有新消息之后，我正在看前面的信息，然后消息不停往上窜」。
// 根因：房间消息列表是 **inverted（倒置）FlatList**（offset 0 = 最新消息那端）。
// 新消息插在数据 index 0 = 倒置坐标的内容起点 → 它之后所有行坐标整体 +h，
// 而滚动 offset 不会自己跟着变 → **视口内容整体上移 h**；来一条推一下，正在读的历史被顶走。
// 聊天库 FlatList 分支的自动吸底只在 `!isInverted` 时生效，倒置列表「本来就贴底」这个
// 假设只在你没往上翻时成立 —— 一旦翻上去，锚点没人管。
//
// 修法：给库下发的 listProps 传 RN 原生 `maintainVisibleContentPosition`
//（Android 端 ReactScrollView + MaintainVisibleScrollPositionHelper，在挂载事务里
// 按锚点子 View 的 frame 差值原子补偿 offset）。
// 真机对照实验（2026-10-09，同场景：进房 → 翻到历史 → 连插 8 条新消息，读 VirtualizedList
// 的 offset）：关掉本 prop 时内容高度每变一次 offset 都一动不动（视口被顶走）；
// 打开后每次内容变化 offset 都同步跟 Δ（视口纹丝不动）。
//
// 这份用例钉住「修法还在、且还配得对」——它没有任何运行时断言，删掉/改错只会在真机上
// 表现为「新消息一来画面就被顶走」，类型检查与其它单测都发现不了：
//   ① listProps 里必须有 MVCP 且 minIndexForVisible: 0（倒置列表从数据第 0 条起找锚点）；
//   ② autoscrollToTopThreshold 必须与 <Chat scrollToBottomOffset> 相同
//      （两者不一致 = 贴底时新消息被挡在屏幕外，或稍微上翻就被拽回底部）；
//   ③ 不能启用 isFlashListEnabled —— FlashList 的 MVCP 是另一套形状
//      （startRenderingFromBottom / autoscrollToBottomThreshold），本项目这份配置会静默失效；
//   ④ 聊天库「倒置列表不自动吸底」这一事实仍成立 —— 库升级后若改了，本修法要重看。
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const ROOM_SCREEN = join(root, 'src', 'screens', 'FollowedRoomsScreen.tsx');
const CHAT_LIB = join(root, 'node_modules', '@kesha-antonov', 'react-native-chat', 'lib', 'MessagesContainer', 'index.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const source = readFileSync(ROOM_SCREEN, 'utf8');

// listProps 里下发的 MVCP（唯一一处，允许带注释换行/空格差异）
// 阈值可以是字面量，也可以是常量（用户 2026-11-09：三个地方统一成 CHAT_STICK_BOTTOM_DP）
const mvcpMatch = source.match(
  /maintainVisibleContentPosition:\s*\{\s*minIndexForVisible:\s*(\d+)\s*,\s*autoscrollToTopThreshold:\s*([A-Za-z_$][\w$]*|\d+)\s*\}/,
);

/** 源码里把 `const NAME = 48;` 这类常量解析成数字（不是常量就返回 null） */
function resolveThreshold(token) {
  if (/^\d+$/.test(String(token))) return Number(token);
  const m = source.match(new RegExp(`const\\s+${token}\\s*=\\s*(\\d+)\\s*;`));
  return m ? Number(m[1]) : null;
}

check('① 房间列表 listProps 下发了 MVCP，且 minIndexForVisible: 0（倒置列表从数据第 0 条找锚点）', () => {
  assert.ok(
    mvcpMatch,
    '没找到 `maintainVisibleContentPosition: { minIndexForVisible: 0, autoscrollToTopThreshold: N }` —— '
      + '删掉它，倒置列表就又没人管锚点，新消息会重新把正在读的历史顶走',
  );
  assert.equal(Number(mvcpMatch[1]), 0, 'minIndexForVisible 必须是 0：倒置列表 index 0 才是最新的那条');
  assert.ok(resolveThreshold(mvcpMatch[2]) !== null, `阈值 ${mvcpMatch[2]} 既不是数字也不是源码里的常量`);
});

check('② autoscrollToTopThreshold 与 <Chat scrollToBottomOffset> 一致（贴底口径单一来源）', () => {
  const threshold = resolveThreshold(mvcpMatch[2]);
  const offMatch = source.match(/<Chat[\s\S]{0,4000}?scrollToBottomOffset=\{([A-Za-z_$][\w$]*|\d+)\}/);
  assert.ok(offMatch, '没找到 <Chat scrollToBottomOffset={N}> —— 贴底阈值必须显式声明');
  const offset = resolveThreshold(offMatch[1]);
  assert.ok(offset !== null, `scrollToBottomOffset 的值 ${offMatch[1]} 解析不出数字`);
  assert.equal(
    offset,
    threshold,
    `两处阈值必须相同：MVCP autoscrollToTopThreshold=${threshold} 而 scrollToBottomOffset=${offset}；`
      + '不一致会出现「贴着底新消息不冒头」或「稍微上翻就被拽回底部」',
  );
});

check('③ <Chat> 未启用 isFlashListEnabled（否则 MVCP 要换成 FlashList 那套形状，本配置静默失效）', () => {
  // 只在 <Chat …/> 这段 JSX 里查，且先剥掉注释 —— 上面说明文字里就写着这个 prop 名
  const jsxStart = source.indexOf('<Chat');
  assert.ok(jsxStart >= 0, '找不到 <Chat ...> 挂载点');
  const jsx = source
    .slice(jsxStart, source.indexOf('/>', jsxStart))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !/isFlashList(Enabled)?\b/.test(jsx),
    '<Chat> 启用了 FlashList 分支：MVCP 形状要改成 { startRenderingFromBottom, autoscrollToBottomThreshold }，'
      + '并按库文档重测「上翻看历史时新消息是否顶走视口」',
  );
});

check('④ 聊天库「倒置列表不自动吸底」这一前提仍成立（库升级后本修法要重看）', () => {
  assert.ok(existsSync(CHAT_LIB), `聊天库 MessagesContainer 源码不在预期位置：${CHAT_LIB}`);
  const lib = readFileSync(CHAT_LIB, 'utf8');
  assert.ok(
    /if \(isInverted\) \{\s*previousLatestMessageId\.current = latestMessageId;\s*return;/.test(lib),
    '聊天库的自动吸底不再是「倒置列表直接 return」：请重新确认倒置/非倒置各自的吸底行为，'
      + '以及本项目的 MVCP 配置是否仍然必要、是否冲突',
  );
  assert.ok(
    /isFlashList\s*=\s*isFlashListEnabled\s*&&\s*isFlashListAvailable/.test(lib),
    '聊天库的 FlatList/FlashList 分支判据变了：本项目走哪条分支要重新确认',
  );
});

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ✓ ${r.name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${r.name}`);
    console.log(String(r.error?.stack || r.error).split('\n').slice(0, 8).join('\n'));
  }
}
console.log(`\n房间消息滚动锚点：${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
