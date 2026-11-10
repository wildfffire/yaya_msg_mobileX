// 房间「媒体识别」纯规则测试（纯 Node，零新增依赖）。
//
// 为什么先测这一组：它们是「拆分 5000+ 行房间页」的**第一步**抽出来的纯函数，
// 也是后面「抽展示组件」所需要的那张**安全网** —— 先把最底层、最容易被改坏的判断逻辑钉住。
//
// 其中两条是**历史 bug 的回归锁**（注释里都写着根因，别删）：
//   ① `classifyMedia` 必须**扩展名优先** —— 否则像 `xxx_a.mp4?live=1` 这种地址会被误判成直播；
//   ② `roomTapIsVod` 里 `.m3u8` **不能一律当直播** —— 否则消息里的录播卡全都会套上直播播放器（无进度条）。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-media-'));

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
    `npx tsc "${join(root, 'src', 'screens', 'room', 'mediaRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'screens', 'room', 'mediaRules.js')}`);
  const { classifyMedia, mediaLabel, isPlayableMediaUrl, streamNeedsProxy, isLiveStreamUrl, streamScore, extractLiveIdFromText, roomTapIsVod } = mod;
  for (const fn of ['classifyMedia', 'mediaLabel', 'isPlayableMediaUrl', 'streamNeedsProxy', 'isLiveStreamUrl', 'streamScore', 'extractLiveIdFromText', 'roomTapIsVod']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里缺少 ${fn} —— 拒绝以「通过」结束`);
  }

  await check('classifyMedia：扩展名优先（含 live 字样的 mp4 仍是 video）', () => {
    // 这一条是历史 bug 回归锁：扩展名必须压过关键字
    assert.equal(classifyMedia('https://x/a.mp4?live=1&record=1', 'VIDEO', ''), 'video');
    assert.equal(classifyMedia('https://x/a.m3u8', '', ''), 'live');
    assert.equal(classifyMedia('https://x/a.flv', '', ''), 'live');
    assert.equal(classifyMedia('rtmp://x/live/stream', '', ''), 'live');
    assert.equal(classifyMedia('https://x/a.mp3', '', ''), 'audio');
    assert.equal(classifyMedia('https://x/a.jpg', '', ''), 'image');
  });

  await check('classifyMedia：无扩展名时按关键字兜底', () => {
    assert.equal(classifyMedia('https://x/playback?id=1', '', ''), 'live');
    assert.equal(classifyMedia('https://x/voice/abc', '', ''), 'audio');
    assert.equal(classifyMedia('https://x/video/abc', '', ''), 'video');
    assert.equal(classifyMedia('https://x/image/abc', '', ''), 'image');
    assert.equal(classifyMedia('https://x/anything', '', ''), 'link');
  });

  await check('roomTapIsVod：.m3u8 不再一律当直播（历史 bug 回归锁）', () => {
    // 根因注释：回放地址常见 .m3u8；若一律当直播流，消息里的录播卡就会全套上直播播放器（无进度条）
    assert.equal(roomTapIsVod({ url: 'https://x/a.m3u8', replayHint: false, isLive: false }), true);
    // 明确带 isLive 标记才算直播
    assert.equal(roomTapIsVod({ url: 'https://x/a.m3u8', isLive: true }), false);
    // 明示回放 → 即使是 rtmp/flv 也按录播
    assert.equal(roomTapIsVod({ url: 'rtmp://x/s', replayHint: true }), true);
    // rtmp / flv 推流只可能是直播
    assert.equal(roomTapIsVod({ url: 'rtmp://x/s' }), false);
    assert.equal(roomTapIsVod({ url: 'https://x/a.flv' }), false);
  });

  await check('streamScore：优先级排序符合注释（rtmp>flv>m3u8>mp4>未知）', () => {
    const liveRank = ['rtmp://x', 'https://x/a.flv', 'https://x/a.m3u8', 'https://x/a.mp4', 'https://x/x'];
    const scores = liveRank.map((u) => streamScore(u, true));
    for (let i = 1; i < scores.length; i += 1) {
      assert.ok(scores[i - 1] > scores[i], `${liveRank[i - 1]}(${scores[i - 1]}) 应高于 ${liveRank[i]}(${scores[i]})`);
    }
    // 非直播偏好下 rtmp 的分数会掉到 mp4 之下（60 < 80）
    assert.ok(streamScore('rtmp://x', false) < streamScore('https://x/a.mp4', false));
  });

  await check('isPlayableMediaUrl / isLiveStreamUrl / streamNeedsProxy', () => {
    assert.equal(isPlayableMediaUrl('rtmp://x/s'), true);
    assert.equal(isPlayableMediaUrl('https://x/a.m3u8'), true);
    assert.equal(isPlayableMediaUrl('https://x/playstream?id=1'), true);
    assert.equal(isPlayableMediaUrl('https://x/a.txt'), false);

    assert.equal(isLiveStreamUrl('https://x/a.m3u8'), true);
    assert.equal(isLiveStreamUrl('https://x/a.mp4'), false);

    assert.equal(streamNeedsProxy('rtmp://x/s'), true);
    assert.equal(streamNeedsProxy('https://x/a.flv'), true);
    assert.equal(streamNeedsProxy('https://x/a.m3u8'), false);
  });

  await check('extractLiveIdFromText：三种形态都能抠出 liveId', () => {
    assert.equal(extractLiveIdFromText('https://x/p?liveId=12345'), '12345');
    assert.equal(extractLiveIdFromText('{"liveId":"456"}'), '456');
    assert.equal(extractLiveIdFromText('https://x/live/78901'), '78901');
    assert.equal(extractLiveIdFromText('https://x/p?id=67890'), '67890'); // 5 位以上按 id 兜底
    assert.equal(extractLiveIdFromText('https://x/p?id=7'), ''); // 太短不算
    assert.equal(extractLiveIdFromText(''), '');
    assert.equal(extractLiveIdFromText(undefined), '');
  });

  await check('mediaLabel：五种类型的短标签（未走 i18n，与原实现一致）', () => {
    assert.equal(mediaLabel('audio'), '语音');
    assert.equal(mediaLabel('video'), '视频');
    assert.equal(mediaLabel('live'), '直播');
    assert.equal(mediaLabel('image'), '图片');
    assert.equal(mediaLabel('link'), '链接');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[room-media] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
