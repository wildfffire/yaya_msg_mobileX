/**
 * 内联播放器 / 观看历史口径的静态守卫（纯 Node，随 test:core 一起跑）。
 *
 * 用户 2026-11-13：翻牌答案 / 私信语音视频 / 分析页 / 相册这类**临时播放**
 * 以前直接 `<PlayerScreen inline>`，而 PlayerScreen 会无条件写观看历史 ——
 * 这些内容没有 ref/liveId，历史里落成 `t:标题`，点开必然解析失败。
 *
 * 现在：
 *   · 内联小播放器统一走 `player/InlineMediaPlayer`（inline + recordHistory={false}）；
 *   · 全屏临时播放（相册/分析页视频）显式 `recordHistory={false}`；
 *   · 需要历史的场景（直播/房间/历史/稍后再看/视频库/公演）继续走 host 或默认 true。
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

check('InlineMediaPlayer：内联 + 固定 features + 不写历史', () => {
  const src = read('src/player/InlineMediaPlayer.tsx');
  assert.ok(/\binline\b/.test(src), '缺少 inline');
  assert.ok(src.includes('recordHistory={false}'), '内联播放器必须关闭观看历史');
  assert.ok(src.includes('kernelSwitch: true') && src.includes('rate: true'), '内联播放器应保留倍速/内核切换');
});

check('内联播放调用点：统一组件，不再直接 <PlayerScreen inline>', () => {
  const files = [
    'src/screens/FlipScreen.tsx',
    'src/screens/AudioProgramsScreen.tsx',
    'src/screens/AnalysisScreen.tsx',
    'src/screens/PrivateMessagesScreen.tsx',
  ];
  for (const file of files) {
    const src = read(file);
    assert.ok(src.includes('InlineMediaPlayer'), `${file} 未使用统一内联播放器`);
    assert.ok(!/<PlayerScreen[\s\S]{0,200}?\binline\b/.test(src), `${file} 仍直接使用 <PlayerScreen inline>`);
  }
});

check('临时全屏播放：显式 recordHistory={false}', () => {
  for (const file of ['src/screens/PhotosScreen.tsx', 'src/screens/AnalysisScreen.tsx']) {
    const src = read(file);
    assert.ok(src.includes('recordHistory={false}'), `${file} 的临时播放会污染观看历史`);
  }
});

check('PlayerScreen：recordHistory 默认 true，且受历史白名单约束', () => {
  const src = read('src/player/PlayerScreen.tsx');
  assert.ok(/recordHistory\s*=\s*true/.test(src), '默认值必须是 true（直播/回放/公演仍要记录）');
  assert.ok(
    /if \(recordHistory && shouldRecordHistory\(source\)\) \{/.test(src),
    'record 调用必须同时被 recordHistory 与 shouldRecordHistory 包裹（房间视频/表情不能进历史）',
  );
});

check('播放器入口：只保留一份防盗链头（utils/mediaHeaders）', () => {
  const headers = read('src/utils/mediaHeaders.ts');
  assert.ok(/export function buildPocketHeaders/.test(headers), 'buildPocketHeaders 必须定义在 utils/mediaHeaders');
  const index = read('src/player/index.ts');
  assert.ok(!index.includes("from './resolve/streamResolver'"), 'player/index 不应再导出 streamResolver');
});

check('视频库 / 公演：接统一宿主，不再直连 PlayerScreen', () => {
  for (const file of ['src/screens/VideoLibraryScreen.tsx', 'src/screens/OpenLiveScreen.tsx']) {
    const src = read(file);
    assert.ok(src.includes('MediaPlaybackHost'), `${file} 未接入统一播放宿主`);
    assert.ok(!src.includes('<PlayerScreen'), `${file} 仍在直连 PlayerScreen`);
  }
});

check('公演直播：宿主快捷路径保留 isLive 且来源仍是 openlive', () => {
  const src = read('src/player/session/resolveMedia.ts');
  assert.ok(/media\.kind === 'openlive' && isPlayableMediaUrl/.test(src), '缺少公演已有地址的快捷路径');
  assert.ok(/isLive: !!media\.isLive/.test(src), '公演直播必须保留 isLive=true');
  assert.ok(/ref: \{ kind: 'openlive', id: refId \}/.test(src), '公演来源引用必须保持 openlive');
  assert.ok(/export function pickOpenLiveStreamUrl/.test(read('src/screens/watch/resolvePlayUrl.ts')), '公演地址抽取应只有一处实现');
});

check('宿主按钮门控：贡献榜可关、弹幕能力可关', () => {
  const host = read('src/player/session/MediaPlaybackHost.tsx');
  assert.ok(host.includes('showRank ??'), '贡献榜按钮缺少 showRank 覆盖');
  assert.ok(host.includes('danmakuCapable'), '弹幕按钮缺少能力门控');
  assert.ok(/enabled: danmakuCapable/.test(host), '弹幕数据源也必须跟能力开关联动（公演不建云信连接）');
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${r.name}`);
    console.log(String(r.error?.stack || r.error).split('\n').slice(0, 6).join('\n'));
  }
}
console.log(`\n内联播放/历史口径：${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
