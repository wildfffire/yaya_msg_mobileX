// 表情短码 / 弹幕正文归一化测试（纯 Node，零新增依赖）。
//
// 两条都是**真实用户反馈的回归锁**，改动 `utils/emoji.ts` / `utils/danmaku.ts`
// / `services/pocketNim/codec.ts` 前先跑它（`npm run test:core` 已包含）：
//   ① 「房间里有些表情识别不出来，只显示文字」——根因是码表缺 20+ 个高频码；
//   ② 「直播里弹幕有时是一串代码」——根因是云信链路**从没做过**短码替换，
//      且整条是 JSON 的消息被原样糊到屏幕上。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-emoji-'));

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
    `npx tsc "${join(root, 'src', 'utils', 'emoji.ts')}" "${join(root, 'src', 'utils', 'danmaku.ts')}" "${join(root, 'src', 'services', 'pocketNim', 'codec.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const emoji = await import(`file://${join(tmp, 'src', 'utils', 'emoji.js')}`);
  const danmaku = await import(`file://${join(tmp, 'src', 'utils', 'danmaku.js')}`);
  const codec = await import(`file://${join(tmp, 'src', 'services', 'pocketNim', 'codec.js')}`);
  const { replaceEmojiText } = emoji;
  const { parseDanmaku } = danmaku;
  const { parseChatroomMessage } = codec;
  for (const [mod, names] of [
    [emoji, ['replaceEmojiText']],
    [danmaku, ['parseDanmaku']],
    [codec, ['parseChatroomMessage']],
  ]) {
    for (const n of names) {
      if (typeof mod[n] !== 'function') throw new Error(`编译产物里缺少 ${n} —— 拒绝以「通过」结束`);
    }
  }

  // ——————— ① 码表补齐（实测 58 万行弹幕里出现过的码） ———————
  await check('实测高频码全部有映射（旧表漏掉的那批）', () => {
    // 这批是 2026-09-29 抓 299 场直播 LRC 统计出来的、旧 EMOJI_MAP 缺失的码
    const missing = ['流泪', '呲牙', '调皮', '偷笑', '流汗', '爱情', '害羞', '冷汗',
      '抓狂', '大兵', '发呆', '闭嘴', '得意', '惊讶', '难过', '傲慢', '发怒', '飞吻'];
    for (const code of missing) {
      const out = replaceEmojiText(`[${code}]`);
      assert.notEqual(out, `[${code}]`, `[${code}] 没有映射 —— 用户会看到文字而不是表情`);
      assert.equal(out.length > 0 && !out.includes('['), true, `[${code}] 替换结果异常：${out}`);
    }
  });

  await check('经典 96 表情序列无整段漏网（微笑/撇嘴/色/…/右太极）', () => {
    const canonical = ['微笑', '撇嘴', '色', '发呆', '得意', '流泪', '害羞', '闭嘴', '睡', '大哭',
      '尴尬', '发怒', '调皮', '呲牙', '惊讶', '难过', '酷', '冷汗', '抓狂', '吐', '偷笑', '愉快',
      '白眼', '傲慢', '饥饿', '困', '惊恐', '流汗', '憨笑', '悠闲', '奋斗', '咒骂', '疑问', '嘘',
      '晕', '疯了', '衰', '骷髅', '敲打', '再见', '擦汗', '抠鼻', '鼓掌', '糗大了', '坏笑',
      // 「可爱」「折磨」是经典 96 里的成员，2026-11-02 自查才发现此前两边（表 + 本断言）都漏了
      '可爱', '折磨',
      '左哼哼', '右哼哼', '哈欠', '鄙视', '委屈', '快哭了', '阴险', '亲亲', '吓', '可怜',
      '菜刀', '西瓜', '啤酒', '篮球', '乒乓', '咖啡', '饭', '猪头', '玫瑰', '凋谢', '嘴唇',
      '爱心', '心碎', '蛋糕', '闪电', '炸弹', '刀', '足球', '瓢虫', '便便', '月亮', '太阳',
      '礼物', '拥抱', '强', '弱', '握手', '胜利', '抱拳', '勾引', '拳头', '差劲', '爱你',
      'NO', 'OK', '跳跳', '发抖', '怄火', '转圈', '磕头', '回头', '跳绳', '挥手', '激动',
      '街舞', '献吻', '左太极', '右太极'];
    const leaked = canonical.filter((c) => replaceEmojiText(`[${c}]`) === `[${c}]`);
    assert.deepEqual(leaked, [], `这些经典码缺映射：${leaked.join(' ')}`);
  });

  // ——————— ② 不能误伤：非表情的方括号必须原样保留 ———————
  await check('系统文案 / 噪声码不被当表情（回归锁）', () => {
    // `[陈俞希]: 直播间在线人数: 48` 是实测弹幕里真实存在的系统行，方括号里是成员名
    assert.equal(replaceEmojiText('[陈俞希]: 直播间在线人数: 48'), '[陈俞希]: 直播间在线人数: 48');
    assert.equal(replaceEmojiText('[null]'), '[null]');
    assert.equal(replaceEmojiText('[▓▓]'), '[▓▓]');
    // 长文本（>8 字）不进码表查询
    assert.equal(replaceEmojiText('[这是一段很长的话不算表情]'), '[这是一段很长的话不算表情]');
  });

  await check('【】不参与替换（中文强调符号，改了就是误伤）', () => {
    assert.equal(replaceEmojiText('【重要通知】今晚八点开播'), '【重要通知】今晚八点开播');
    // 全角［］要认（输入法全角下很常见）
    assert.equal(replaceEmojiText('［流泪］'), replaceEmojiText('[流泪]'));
  });

  await check('中英混排 / 多个表情连发', () => {
    assert.equal(replaceEmojiText('好可爱[强][强][强]'), `好可爱${replaceEmojiText('[强]').repeat(3)}`);
    assert.equal(replaceEmojiText('apt[擦汗]'), `apt${replaceEmojiText('[擦汗]')}`);
    assert.equal(replaceEmojiText(''), '');
  });

  // ——————— ③ 录播弹幕（LRC）也要替换 ———————
  await check('parseDanmaku：录播弹幕正文替换为 emoji，昵称不受影响', () => {
    const items = parseDanmaku('[00:01:12.410]叫我白菜\t今天好累[流泪][流泪]');
    assert.equal(items.length, 1);
    assert.equal(items[0].nick, '叫我白菜');
    assert.equal(items[0].text.includes('[流泪]'), false, 'LRC 弹幕里仍残留短码');
    assert.equal(items[0].text, `今天好累${replaceEmojiText('[流泪]').repeat(2)}`);
  });

  // ——————— ④ 直播弹幕（云信）— 之前完全没做替换 ———————
  await check('parseChatroomMessage：普通弹幕短码替换（历史 bug 回归锁）', () => {
    const item = parseChatroomMessage({
      type: 'custom',
      text: '[流泪]',
      remoteExtension: { messageType: 'BARRAGE_NORMAL', text: '太好哭了[流泪]', user: { nickName: 'A' } },
    });
    assert.ok(item, '消息不应被丢弃');
    assert.equal(item.text.includes('[流泪]'), false, '直播弹幕里仍残留短码 —— 就是「一串代码」');
    assert.equal(item.text, `太好哭了${replaceEmojiText('[流泪]')}`);
  });

  await check('parseChatroomMessage：整条是 JSON 时还原正文，而不是糊一屏代码', () => {
    // 成因：custom 消息的 attach 偶尔被当成 text 下发
    const item = parseChatroomMessage({
      type: 'custom',
      text: '{"text":"哈哈哈哈","user":{"nickName":"A"}}',
      remoteExtension: { messageType: 'BARRAGE_NORMAL', text: '{"text":"哈哈哈哈"}', user: { nickName: 'A' } },
    });
    assert.ok(item);
    assert.equal(item.text, '哈哈哈哈');
    assert.equal(item.text.startsWith('{'), false);
  });

  await check('parseChatroomMessage：JSON 里没有正文则丢弃该条（不显示乱码）', () => {
    const item = parseChatroomMessage({
      type: 'custom',
      text: '{"giftInfo":{"giftId":1},"module":"live"}',
      remoteExtension: { messageType: 'BARRAGE_NORMAL', text: '{"giftInfo":{"giftId":1},"module":"live"}', user: { nickName: 'A' } },
    });
    assert.equal(item, null, '没有正文的消息不该上屏');
  });

  await check('parseChatroomMessage：以 [ 开头的表情弹幕不会被当成 JSON 吃掉', () => {
    const item = parseChatroomMessage({
      type: 'custom',
      text: '[大哭]',
      remoteExtension: { messageType: 'BARRAGE_NORMAL', text: '[大哭][大哭]', user: { nickName: 'A' } },
    });
    assert.ok(item);
    assert.equal(item.text, replaceEmojiText('[大哭]').repeat(2));
  });

  await check('渲染层收口：飘屏 / 弹幕抽屉 / 弹幕榜 / 房间独占字段 / 私信都过替换', () => {
    // ⚠️ 用户第二次反馈（2026-09-29）：「房间里还是有表情识别不出来，只显示 [示爱]」。
    // 根因：同一份数据有多条渲染路径，只有走 messageText/parseDanmaku 的那条替换了，
    // 引用卡（replyText）、礼物回复、翻牌答案（answerContent，优先级高于正文）漏了。
    // 这组静态断言钉住「每条路径都必须收口」，防止以后再新增支路时漏掉。
    const mustCall = [
      ['src/screens/room/RoomChatMessageRow.tsx', 'replaceEmojiText'],
      ['src/screens/PrivateMessagesScreen.tsx', 'replaceEmojiText(privateMessageTextRaw(msg))'],
      ['src/components/DanmakuOverlay.tsx', 'replaceEmojiText(text)'],
      ['src/components/DanmakuListSheet.tsx', 'replaceEmojiText(item.text)'],
      ['src/components/LiveBarrageBoard.tsx', 'replaceEmojiText(item.text)'],
      ['src/player/session/MediaPlaybackHost.tsx', 'replaceEmojiText(announce.text)'],
      // 2026-11-02 自查补：翻牌页（提问 + 回答）是最后一个没走替换的正文出口
      ['src/screens/FlipScreen.tsx', 'replaceEmojiText(pickText('],
    ];
    for (const [file, needle] of mustCall) {
      const source = readFileSync(join(root, file), 'utf8');
      assert.ok(source.includes(needle), `${file} 缺少「${needle}」—— 该路径会把短码原样显示`);
    }
    // 房间行里三个独占分支必须都替换（引用原文 / 礼物回复 / 翻牌答案）
    const row = readFileSync(join(root, 'src/screens/room/RoomChatMessageRow.tsx'), 'utf8');
    assert.ok(/replyQuoted = replaceEmojiText\(/.test(row), '引用卡原文未替换');
    assert.ok(/giftReplyText = replaceEmojiText\(/.test(row), '礼物回复文案未替换');
    assert.ok(/flipAnswer = replaceEmojiText\(/.test(row), '翻牌答案未替换');
  });

  await check('parseChatroomMessage：礼物/进房拼装文案不受影响', () => {
    const gift = parseChatroomMessage({
      type: 'custom',
      remoteExtension: {
        messageType: 'PRESENT_NORMAL',
        giftInfo: { giftName: '荧光棒-X', giftNum: 1, acceptUser: { userName: 'SNH48-黄子欣' } },
        user: { nickName: '楡' },
      },
    });
    assert.ok(gift);
    assert.equal(gift.kind, 'gift');
    assert.ok(gift.text.includes('荧光棒-X'));

    const enter = parseChatroomMessage({
      type: 'custom',
      remoteExtension: { messageType: 'EVENT_NOHEAD_ENTER', user: { nickName: '小明' } },
    });
    assert.ok(enter);
    assert.equal(enter.text, '小明 进入直播间');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

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
console.log(`\n表情/弹幕文本：${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
