// 房间「翻牌」消息问答解析测试（纯 Node，零新增依赖）。
//
// 为什么必须钉住这一层：翻牌在口袋接口里字段写法**不止一种**
//（顶层 answerContent / flipCardInfo / 官方把 flip 拼错成 filp 的 filpCardInfo / 语音·视频翻牌），
// 且 answer 可能是「字符串 / 对象 / JSON 字符串」。解析错了不会抛异常 ——
// 表现是房间里要么看不到翻牌、要么气泡里显示 `[object Object]` 或 `[FLIPCARD]`（用户 2026-09-30 报的正是这个）。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-flip-card-'));

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
    `npx tsc "${join(root, 'src', 'utils', 'flipCard.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'flipCard.js')}`);
  const { flipCardTexts, flipCardDisplayText, isFlipCard } = mod;
  for (const fn of ['flipCardTexts', 'flipCardDisplayText', 'isFlipCard']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里没有 ${fn} —— 拒绝以「通过」结束`);
  }

  await check('顶层 answerContent 是字符串：回答直接命中', () => {
    const { answer } = flipCardTexts({ msgType: 'REPLY', bodys: { answerContent: '谢谢你的支持' } });
    assert.equal(answer, '谢谢你的支持');
  });

  await check('answer 是对象：取 text，绝不出 [object Object]（回归锁）', () => {
    const { answer } = flipCardTexts({ msgType: 'FLIPCARD', bodys: { answer: { text: '我会加油的' } } });
    assert.equal(answer, '我会加油的');
    assert.ok(!answer.includes('object'), 'answer 被字符串化成了 [object Object]');
  });

  await check('answer 是 JSON 字符串：解析后取正文', () => {
    const { answer } = flipCardTexts({
      msgType: 'FLIPCARD',
      bodys: { answer: '{"text":"早上好呀","other":1}' },
    });
    assert.equal(answer, '早上好呀');
  });

  await check('flipCardInfo：提问与回答都能取到', () => {
    const { question, answer } = flipCardTexts({
      msgType: 'FLIPCARD',
      bodys: { flipCardInfo: { question: '你最喜欢什么颜色？', answer: { content: '粉色' } } },
    });
    assert.equal(question, '你最喜欢什么颜色？');
    assert.equal(answer, '粉色');
  });

  await check('官方拼错的历史写法 filpCardInfo 也要认', () => {
    const { question, answer } = flipCardTexts({
      msgType: 'FLIPCARD',
      bodys: { filpCardInfo: { question: '吃了吗', answer: '吃啦' } },
    });
    assert.equal(question, '吃了吗');
    assert.equal(answer, '吃啦');
  });

  await check('语音/视频翻牌：答案体在 audioInfo / videoInfo 里', () => {
    const audio = flipCardTexts({
      msgType: 'FLIPCARD',
      bodys: { flipCardAudioInfo: { question: '唱一句', audioInfo: { url: 'https://a/1.m4a' } } },
    });
    assert.equal(audio.answer, 'https://a/1.m4a');
    const video = flipCardTexts({
      msgType: 'FLIPCARD',
      bodys: { flipCardVideoInfo: { videoInfo: { url: 'https://a/1.mp4' } } },
    });
    assert.equal(video.answer, 'https://a/1.mp4');
  });

  await check('isFlipCard：类型命中或带翻牌字段才算，普通文本消息不算', () => {
    assert.equal(isFlipCard({ msgType: 'FLIPCARD', bodys: {} }), true);
    assert.equal(isFlipCard({ msgType: 'TEXT', bodys: { filpCardInfo: { answer: 'x' } } }), true);
    assert.equal(isFlipCard({ msgType: 'TEXT', bodys: { text: '普通消息' } }), false);
    assert.equal(isFlipCard({ bodys: { text: '普通消息' } }), false);
  });

  await check('flipCardDisplayText：回答优先，没有回答时退回提问', () => {
    assert.equal(flipCardDisplayText({ bodys: { answerContent: '答案' } }), '答案');
    assert.equal(flipCardDisplayText({ bodys: { question: '提问' } }), '提问');
    assert.equal(flipCardDisplayText({ bodys: { text: '无关' } }), '');
  });
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.error(`  ✗ ${r.name}\n${r.error?.stack || r.error}`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n[flip-card] 结果：${passed} 通过 / ${results.length - passed} 失败`);
if (passed !== results.length) process.exitCode = 1;
