// 富文本（HTML）弹幕清洗测试（纯 Node，零新增依赖）。
//
// 回归锁来源（2026-10-03 真机 adb 实测）：林舒晴直播间弹幕列表 / 画面飘屏
// 里出现 `<div><span style="color:#fffff; vertical-align:middle;">…` 这种「乱码」，
// 根因是官方 H5 / 其他端发出的正文**本身就是 HTML 片段**，而云信 codec 与
// 录播 LRC 解析都只当纯文本渲染。
//
// 改动 `utils/richtext.ts` / `utils/danmaku.ts` / `services/pocketNim/codec.ts` 前先跑它。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-richtext-'));

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
    `npx tsc "${join(root, 'src', 'utils', 'richtext.ts')}" "${join(root, 'src', 'utils', 'emoji.ts')}" "${join(root, 'src', 'utils', 'danmaku.ts')}" "${join(root, 'src', 'services', 'pocketNim', 'codec.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const richtext = await import(`file://${join(tmp, 'src', 'utils', 'richtext.js')}`);
  const danmaku = await import(`file://${join(tmp, 'src', 'utils', 'danmaku.js')}`);
  const codec = await import(`file://${join(tmp, 'src', 'services', 'pocketNim', 'codec.js')}`);
  const { stripRichText, decodeHtmlEntities, RICH_IMAGE_PLACEHOLDER } = richtext;
  const { parseDanmaku } = danmaku;
  const { parseChatroomMessage } = codec;
  for (const [mod, names] of [
    [richtext, ['stripRichText', 'decodeHtmlEntities']],
    [danmaku, ['parseDanmaku']],
    [codec, ['parseChatroomMessage']],
  ]) {
    for (const n of names) {
      if (typeof mod[n] !== 'function') throw new Error(`编译产物里缺少 ${n} —— 拒绝以「通过」结束`);
    }
  }

  // ——————— ① 真机实测原文：官方 H5 的富文本弹幕 ———————
  await check('真机原文：`<div><span style=…>正文</span></div>` 只留正文（乱码回归锁）', () => {
    assert.equal(
      stripRichText('<div><span style="color:#fffff; vertical-align:middle;">Maite 太🐶</span></div>'),
      'Maite 太🐶',
    );
    // 无分号 / 无引号 / 属性顺序不同都要认
    assert.equal(stripRichText('<div><span style=color:#3b0b9a;vertical-align:middle>哈哈</span></div>'), '哈哈');
    assert.equal(stripRichText('<p>好可爱</p>'), '好可爱');
  });

  await check('图片表情弹幕 `<img src="/backstage/…">` → `[表情]` 占位（整条不再消失）', () => {
    assert.equal(RICH_IMAGE_PLACEHOLDER, '[表情]');
    assert.equal(
      stripRichText('<img style="vertical-align:middle;" src="/backstage/2020/emoji/a.png">'),
      RICH_IMAGE_PLACEHOLDER,
    );
    // 图文混排：占位原地插入，不吞掉前后正文
    assert.equal(stripRichText('好可爱<img src="/backstage/a.png">哈哈哈'), `好可爱${RICH_IMAGE_PLACEHOLDER}哈哈哈`);
    // 连发多图
    assert.equal(
      stripRichText('<img src="/a.png"><img src="/b.png">'),
      RICH_IMAGE_PLACEHOLDER + RICH_IMAGE_PLACEHOLDER,
    );
    // 占位符本身不是短码，不能被后续的 emoji 替换吃掉
    assert.equal(stripRichText(RICH_IMAGE_PLACEHOLDER), RICH_IMAGE_PLACEHOLDER);
  });

  await check('占位符落到 codec / LRC 两端的最终文案', () => {
    const barrage = parseChatroomMessage({
      type: 'custom',
      remoteExtension: {
        messageType: 'BARRAGE_NORMAL',
        text: '<div><span style="color:#fffff"><img src="/backstage/a.png"></span></div>',
        user: { nickName: 'A' },
      },
    });
    assert.ok(barrage, '图片表情弹幕不该被丢弃');
    assert.equal(barrage.text, RICH_IMAGE_PLACEHOLDER);
    const lrc = parseDanmaku('[00:00:05.000]某人\t<img src="/backstage/a.png">');
    assert.equal(lrc.length, 1);
    assert.equal(lrc[0].text, RICH_IMAGE_PLACEHOLDER);
  });

  await check('标签内的表情短码仍要换 emoji（剥标签在短码替换之前）', () => {
    assert.equal(
      stripRichText('<div><span style="color:#ff0000">好可爱[流泪]</span></div>'),
      '好可爱[流泪]',
    );
    // 集成：codec 里“剥标签 → 换短码”的顺序不能颠倒
    const item = parseChatroomMessage({
      type: 'custom',
      remoteExtension: {
        messageType: 'BARRAGE_NORMAL',
        text: '<div><span style="color:#fffff">好可爱[流泪]</span></div>',
        user: { nickName: 'A' },
      },
    });
    assert.ok(item);
    assert.equal(item.text, '好可爱😢');
  });

  await check('<br> 折成空格，连续空白收紧', () => {
    assert.equal(stripRichText('第一行<br>第二行'), '第一行 第二行');
    assert.equal(stripRichText('a<br/>b<br />c'), 'a b c');
    assert.equal(stripRichText('<div>\n  正文\n</div>'), '正文');
  });

  // ——————— ② 实体与转义 HTML ———————
  await check('实体解码：&nbsp; &amp; &#数字; &#x十六进制;', () => {
    assert.equal(stripRichText('A&nbsp;&amp;&nbsp;B'), 'A & B');
    assert.equal(stripRichText('&lt;strong&gt;'), '');
    assert.equal(decodeHtmlEntities('&#22909;&#x1F44D;'), '好👍');
    // 不认识的实体不猜、原样保留
    assert.equal(decodeHtmlEntities('&copy;2026'), '&copy;2026');
  });

  await check('转义态 HTML（&lt;div&gt;正文&lt;/div&gt;）也能还原出正文', () => {
    assert.equal(stripRichText('&lt;div&gt;正文&lt;/div&gt;'), '正文');
  });

  // ——————— ③ 绝不能误伤 ———————
  await check('纯文本弹幕一字不动（含 `1 < 3 > 2`、方括号系统文案）', () => {
    assert.equal(stripRichText('怕什么来什么'), '怕什么来什么');
    assert.equal(stripRichText('1 < 3 > 2'), '1 < 3 > 2');
    assert.equal(stripRichText('a<b'), 'a<b');
    assert.equal(stripRichText('[陈俞希]: 直播间在线人数: 48'), '[陈俞希]: 直播间在线人数: 48');
    // 纯文本走快速通道：连首尾空格都不动（保持改动前的既有行为）
    assert.equal(stripRichText('好可爱 '), '好可爱 ');
    // 幂等
    const once = stripRichText('<div>x[流泪]</div>');
    assert.equal(stripRichText(once), once);
  });

  // ——————— ④ 云信直播弹幕链路 ———————
  await check('parseChatroomMessage：HTML 弹幕清洗后上屏', () => {
    const item = parseChatroomMessage({
      type: 'custom',
      remoteExtension: {
        messageType: 'BARRAGE_NORMAL',
        text: '<div><span style="color:#fffff; vertical-align:middle;">Maite 太🐶</span></div>',
        user: { nickName: 'Maite 太🐶' },
      },
    });
    assert.ok(item, '消息不应被丢弃');
    assert.equal(item.text, 'Maite 太🐶');
    assert.equal(item.text.includes('<'), false, '弹幕列表 / 飘屏仍会显示标签');
  });

  await check('parseChatroomMessage：纯图片表情弹幕保留为 `[表情]`（用户反馈「整条消失」的回归锁）', () => {
    const item = parseChatroomMessage({
      type: 'custom',
      remoteExtension: {
        messageType: 'BARRAGE_NORMAL',
        text: '<img style="vertical-align:middle;" src="/backstage/a.png">',
        user: { nickName: 'A' },
      },
    });
    assert.ok(item, '图片表情弹幕被整条丢掉了 —— 用户会在弹幕列表里看不到这条消息');
    assert.equal(item.text, RICH_IMAGE_PLACEHOLDER);
    assert.equal(item.text.includes('backstage'), false, '又把 src 路径糊上屏了');
  });

  // ——————— ⑤ 录播 LRC 链路（与直播同源） ———————
  await check('parseDanmaku：LRC 正文里的 HTML 同样剥净', () => {
    const items = parseDanmaku('[00:01:12.410]叫我白菜\t<div><span style="color:#fffff">今天好累</span></div>');
    assert.equal(items.length, 1);
    assert.equal(items[0].nick, '叫我白菜');
    assert.equal(items[0].text, '今天好累');

    // 图片表情行：折成占位符保留（不再整行丢掉）
    const imgs = parseDanmaku('[00:00:05.000]某人\t<img src="/backstage/a.png">');
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].text, RICH_IMAGE_PLACEHOLDER);
  });

  // ——————— ⑥ 收口断言：清洗必须在解析层，不许散到渲染层 ———————
  await check('解析层收口：codec / parseDanmaku 都调用 stripRichText', () => {
    const codecSrc = readFileSync(join(root, 'src/services/pocketNim/codec.ts'), 'utf8');
    assert.ok(
      /replaceEmojiText\(stripRichText\(textFromJsonPayload\(/.test(codecSrc),
      'codec.ts 的正文归一化未接 stripRichText —— 直播弹幕又会飘标签',
    );
    const danmakuSrc = readFileSync(join(root, 'src/utils/danmaku.ts'), 'utf8');
    assert.ok(
      /replaceEmojiText\(stripRichText\(text\)\)/.test(danmakuSrc),
      'danmaku.ts 的 LRC 正文未接 stripRichText —— 录播弹幕会飘标签',
    );
    // 原始样本必须持续留档（否则「表情图 → emoji」码表永远拿不到依据）
    const chatroomSrc = readFileSync(join(root, 'src/services/pocketNim/chatroom.ts'), 'utf8');
    const sampleCalls = chatroomSrc.match(/logRichSample\(/g) || [];
    assert.ok(sampleCalls.length >= 3, 'chatroom.ts 的两条收信通道都要记 `[rich]` 样本');
    assert.ok(/logInfo\(`\[rich\]/.test(chatroomSrc), 'chatroom.ts 缺少 [rich] 留档实现');
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
console.log(`\n富文本弹幕清洗：${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
