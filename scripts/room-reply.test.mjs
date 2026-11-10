// 房间消息「引用（回复）」纯规则测试（纯 Node，零新增依赖）。
//
// 为什么必须钉住这一层（用户 2026-10-14：房间内发消息要能引用别人的消息）：
//   发送侧（services/pocketNim/qchat.buildChannelExt）与展示侧（RoomChatMessageRow / roomReplyInfo）
//   靠**字段名约定**对接 —— 键名写错不会抛异常，表现是「引用发出去了但两边都不显示引用卡」，
//   只能靠肉眼看真机。而且这里同时兼容两种口径（嵌套 replyInfo / 官方扁平 replyName+replyText），
//   一旦把扁平口径放大到 GIFTREPLY，礼物消息会凭空多一张引用卡（反向锁见下）。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-reply-'));

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
    `npx tsc "${join(root, 'src', 'utils', 'roomReply.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'roomReply.js')}`);
  const {
    buildRoomReplyExt, clipReplyQuote, roomReplyInfo, replyBodyText, MAX_REPLY_QUOTE_CHARS,
    resolveRoomReply, rememberOwnReplyQuote, clearOwnReplyQuotes, diagnoseMissingReply,
  } = mod;
  for (const fn of [
    'buildRoomReplyExt', 'clipReplyQuote', 'roomReplyInfo', 'replyBodyText',
    'resolveRoomReply', 'rememberOwnReplyQuote', 'clearOwnReplyQuotes', 'diagnoseMissingReply',
  ]) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里缺少 ${fn} —— 拒绝以「通过」结束`);
  }

  await check('clipReplyQuote：折叠空白 + 超长截断补省略号（引用原文要进 ext，必须控体积）', () => {
    assert.equal(clipReplyQuote('  今天  排练\n到很晚 '), '今天 排练 到很晚');
    assert.equal(clipReplyQuote(''), '');
    assert.equal(clipReplyQuote(null), '');
    const long = 'あ'.repeat(MAX_REPLY_QUOTE_CHARS + 20);
    const clipped = clipReplyQuote(long);
    assert.equal(clipped.length, MAX_REPLY_QUOTE_CHARS + 1);
    assert.ok(clipped.endsWith('…'));
  });

  await check('buildRoomReplyExt：官方口径（ext 上 messageType=REPLY）+ 扁平 + 嵌套三种字段同时写', () => {
    const ext = buildRoomReplyExt({ name: '陈琳', text: '今天排练到很晚', msgId: 'mid-1', userId: '1001' });
    assert.equal(ext.messageType, 'REPLY');
    assert.equal(ext.replyName, '陈琳');
    assert.equal(ext.replyText, '今天排练到很晚');
    assert.deepEqual(ext.replyInfo, {
      replyName: '陈琳',
      replyText: '今天排练到很晚',
      replyMsgIdClient: 'mid-1',
      replyUserId: '1001',
    });
  });

  await check('buildRoomReplyExt：没引用 → 空对象（调用方 spread 后必须与老行为完全一致）', () => {
    assert.deepEqual(buildRoomReplyExt(null), {});
    assert.deepEqual(buildRoomReplyExt(undefined), {});
    assert.deepEqual(buildRoomReplyExt({ name: '', text: '' }), {});
  });

  await check('buildRoomReplyExt：只有名字（被引用的是纯图片消息）也要成立', () => {
    const ext = buildRoomReplyExt({ name: '小粉丝', text: '' });
    assert.equal(ext.messageType, 'REPLY');
    assert.equal(ext.replyInfo.replyName, '小粉丝');
    assert.equal(ext.replyInfo.replyText, '');
    assert.ok(!('replyMsgIdClient' in ext.replyInfo));
  });

  await check('roomReplyInfo：嵌套口径（bodys 是 JSON 字符串，实时回显形态）能读回', () => {
    const item = {
      msgType: 'REPLY',
      bodys: JSON.stringify({
        text: '哈哈哈哈',
        messageType: 'REPLY',
        replyInfo: { replyName: '陈琳', replyText: '今天排练到很晚' },
      }),
      extInfo: {},
    };
    assert.deepEqual(roomReplyInfo(item), { name: '陈琳', text: '今天排练到很晚' });
  });

  await check('roomReplyInfo：嵌套口径在 extInfo 里也能读回（本项目发出的历史消息）', () => {
    const item = {
      msgType: 'REPLY',
      bodys: { text: '哈哈哈哈' },
      extInfo: JSON.stringify({ messageType: 'REPLY', replyInfo: { replyName: '陈琳', replyText: '晚安' } }),
    };
    assert.deepEqual(roomReplyInfo(item), { name: '陈琳', text: '晚安' });
  });

  await check('roomReplyInfo：官方扁平口径（extInfo.messageType=REPLY + replyName/replyText）同样能读回', () => {
    // 官方 App 发出的引用消息：引用信息不在 bodys 里，老实现在这边完全不显示引用卡
    const item = {
      msgType: 'REPLY',
      bodys: { text: '回复的内容' },
      extInfo: JSON.stringify({ module: 'qchat', messageType: 'REPLY', replyName: '陈琳', replyText: '晚安' }),
    };
    assert.deepEqual(roomReplyInfo(item), { name: '陈琳', text: '晚安' });
  });

  await check('反向锁：GIFTREPLY 的 replyName/replyText 不能被当成引用卡（礼物回复走礼物卡渲染）', () => {
    const item = {
      msgType: 'GIFTREPLY',
      bodys: { text: '' },
      extInfo: { messageType: 'GIFTREPLY', replyName: '陈琳', replyText: '生日快乐' },
    };
    assert.equal(roomReplyInfo(item), null);
  });

  await check('普通文本消息不误判为引用（无 replyInfo / 非 REPLY）', () => {
    assert.equal(roomReplyInfo({ msgType: 'TEXT', bodys: { text: '大家好' }, extInfo: { module: 'qchat' } }), null);
    assert.equal(roomReplyInfo(null), null);
    assert.equal(roomReplyInfo({}), null);
  });

  await check('replyBodyText：引用消息的自有正文（不带 data.ts 给 REPLY 拼的「回复 X：」前缀）', () => {
    assert.equal(replyBodyText({ bodys: { text: '哈哈哈哈' } }), '哈哈哈哈');
    assert.equal(replyBodyText({ bodys: JSON.stringify({ text: '答案', content: '备用' }) }), '答案');
    assert.equal(replyBodyText({ bodys: '纯文本正文' }), '纯文本正文');
    assert.equal(replyBodyText({ bodys: { body: { text: '嵌套一层' } } }), '');
  });

  // ── 本机兜底（用户 2026-10-14：「发出消息后没有正常显示引用」）──
  // 引用信息要靠服务端把 ext 带回来；mergeMessages 按消息键去重、**先到的赢**，
  // 所以「自己这条」必须有一份本地兜底，否则服务端没带回来就永远缺引用卡。
  await check('resolveRoomReply：服务端数据优先，服务端没有时用本机发出的兜底（按 msgIdClient 命中）', () => {
    clearOwnReplyQuotes();
    const own = { msgIdClient: 'own-1', uuid: 'own-1', msgType: 'TEXT', bodys: { text: '哈哈哈哈' } };
    // 还没发过 → 没有任何引用信息
    assert.equal(resolveRoomReply(own), null);
    rememberOwnReplyQuote('own-1', { name: '陈琳', text: '今天排练到很晚' });
    assert.deepEqual(resolveRoomReply(own), { name: '陈琳', text: '今天排练到很晚' });
    // 兜底只按消息键命中，别的消息不受影响
    assert.equal(resolveRoomReply({ msgIdClient: 'other-1', bodys: { text: 'x' } }), null);
    // 服务端带回来之后，以服务端数据为准（本地不覆盖）
    const withServer = {
      msgIdClient: 'own-1',
      msgType: 'REPLY',
      bodys: { text: '哈哈哈哈', replyInfo: { replyName: '陈琳', replyText: '晚安' } },
    };
    assert.deepEqual(resolveRoomReply(withServer), { name: '陈琳', text: '晚安' });
    clearOwnReplyQuotes();
  });

  await check('rememberOwnReplyQuote：空 id / 空引用不写缓存，超长原文按引用上限截断', () => {
    clearOwnReplyQuotes();
    rememberOwnReplyQuote('', { name: '陈琳', text: 'x' });
    rememberOwnReplyQuote('id-1', { name: '', text: '' });
    assert.equal(resolveRoomReply({ msgIdClient: 'id-1' }), null);
    rememberOwnReplyQuote('id-2', { name: '陈琳', text: 'あ'.repeat(MAX_REPLY_QUOTE_CHARS + 10) });
    const cached = resolveRoomReply({ msgIdClient: 'id-2' });
    assert.equal(cached.text.length, MAX_REPLY_QUOTE_CHARS + 1);
    // uuid / msgId 任一命中同一个键（HTTP 历史与实时回显的 id 字段名不同）
    assert.deepEqual(resolveRoomReply({ uuid: 'id-2' }), cached);
    assert.deepEqual(resolveRoomReply({ msgId: 'id-2' }), cached);
    clearOwnReplyQuotes();
  });

  await check('诊断消息有引用痕迹但读不到引用信息时会报字段名（不报内容）', () => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.map((a) => String(a)).join(' '));
    try {
      diagnoseMissingReply({
        msgIdClient: 'diag-1',
        msgType: 'REPLY',
        bodys: { text: '哈哈哈哈' },
        extInfo: { module: 'qchat', messageType: 'REPLY', text: '哈哈哈哈' },
      });
      // 普通消息不报（热路径上不刷屏）
      diagnoseMissingReply({ msgIdClient: 'diag-2', msgType: 'TEXT', bodys: { text: '大家好' }, extInfo: { module: 'qchat' } });
      // 礼物回复不报（它的 replyName 属于礼物卡）
      diagnoseMissingReply({ msgIdClient: 'diag-3', msgType: 'GIFTREPLY', extInfo: { replyName: '陈琳' } });
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 1, `应只报 1 条，实际 ${JSON.stringify(lines)}`);
    assert.ok(lines[0].includes('[room.reply]'), '日志 tag 固定为 [room.reply]');
    assert.ok(lines[0].includes('msgIdClient') === false, '日志里不带消息 id/内容');
    assert.ok(lines[0].includes('哈哈哈哈') === false, '日志里不带聊天内容');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[room-reply] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
