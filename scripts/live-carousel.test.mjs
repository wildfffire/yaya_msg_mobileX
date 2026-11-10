// 电台直播「轮播照片」纯规则测试（纯 Node，零新增依赖）。
//
// 背景（用户 2026-11-04）：「直播里电台直播应该是有轮播的照片的，现在只显示成员离开」——
// 口袋电台直播（liveType=2）的推流画面只有那张「成员离开」占位图，官方客户端轮播的是
// `getLiveOne → content.carousels` 里的成员照片。这里的断言就是那条链路的回归锁。
//
// ⚠️ 两条最容易改错的判据（真机实测 2026-11-04）：
//   ① 电台判据是 **liveType === 2**，不是 `type` —— 实测电台场次的 `content.type` 仍是 1，
//      写成 type 判电台会永远不亮（正是「只显示成员离开」的形态）。
//   ② `carousels` 是 `{ carouselTime, carousels: [...] }` **对象包数组**，
//      直接当数组读会拿到 undefined → 没有照片可轮播。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-live-carousel-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

/** 2026-11-04 真机 getLiveOne 的真实形态（节选） */
const radioDetail = {
  status: 200,
  content: {
    liveId: '1324829593195843584',
    roomId: '12736304085',
    onlineNum: 248,
    type: 1, // ← 注意：电台时也是 1，不能当判据
    liveType: 2, // ← 电台
    coverPath: '/2026/1104/149356905xom55mq2fkgjpppqqq29waz1.jpg',
    title: '十一月…乐！',
    carousels: {
      carouselTime: '5000',
      carousels: [
        '/2026/1104/149356905xmozpt414bv735okhjsw4evf.jpg',
        '/2026/1104/149356905xlfj57kt3l6onmyu6vt442ym.jpg',
        '/2026/1104/149356905xub62hecvuxshcynwgibamsw.jpg',
      ],
    },
  },
};

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'liveCarousel.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'liveCarousel.js').replace(/\\/g, '/')}`);
  const { parseLiveCarousel, isRadioLive, DEFAULT_CAROUSEL_INTERVAL_MS } = mod;
  for (const fn of ['parseLiveCarousel', 'isRadioLive']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里缺少 ${fn} —— 拒绝以「通过」结束`);
  }

  await check('电台场次：liveType=2 判为电台，照片归一成 48 图床绝对地址', () => {
    const r = parseLiveCarousel(radioDetail);
    assert.equal(r.radio, true);
    assert.equal(r.photos.length, 3);
    assert.deepEqual(r.photos[0], 'https://source.48.cn/2026/1104/149356905xmozpt414bv735okhjsw4evf.jpg');
    assert.equal(r.intervalMs, 5000);
  });

  await check('反向锁：type=1 + liveType=2 仍是电台（判据只能是 liveType）', () => {
    const r = parseLiveCarousel({ content: { type: 1, liveType: 2, carousels: { carousels: ['/a.jpg'] } } });
    assert.equal(r.radio, true);
    assert.equal(isRadioLive({ content: { type: 1, liveType: 2 } }), true);
  });

  await check('视频直播：liveType=1 且无照片 → 不是电台', () => {
    const r = parseLiveCarousel({ content: { type: 1, liveType: 1, title: '视频直播' } });
    assert.equal(r.radio, false);
    assert.deepEqual(r.photos, []);
    assert.equal(isRadioLive({ content: { liveType: 1 } }), false);
  });

  await check('老接口形态：没有 liveType 时 type=2 兜底为电台', () => {
    assert.equal(parseLiveCarousel({ content: { type: 2 } }).radio, true);
    assert.equal(isRadioLive({ content: { type: 2 } }), true);
  });

  await check('有轮播照片即视为电台形态（直播间列表缺 liveType 时不至于不轮播）', () => {
    const r = parseLiveCarousel({ content: { carousels: { carousels: ['/b.jpg'] } } });
    assert.equal(r.photos.length, 1);
    assert.equal(r.radio, true);
  });

  await check('裸 content（无外层壳）也能解析', () => {
    const r = parseLiveCarousel(radioDetail.content);
    assert.equal(r.photos.length, 3);
    assert.equal(r.radio, true);
  });

  await check('相对路径去重 + 绝对地址原样保留 + 非法项丢弃', () => {
    const r = parseLiveCarousel({
      content: {
        liveType: 2,
        carousels: {
          carousels: [
            '/dupe.jpg',
            'https://source.48.cn/dupe.jpg',
            '  ',
            'not-a-url',
            '/other.jpg',
          ],
        },
      },
    });
    assert.deepEqual(r.photos, ['https://source.48.cn/dupe.jpg', 'https://source.48.cn/other.jpg']);
  });

  await check('间隔：缺失/非法 → 默认 5000ms；秒值 5 → 5000ms；越界夹紧', () => {
    assert.equal(parseLiveCarousel({ content: {} }).intervalMs, DEFAULT_CAROUSEL_INTERVAL_MS);
    assert.equal(parseLiveCarousel({ content: { carousels: { carouselTime: 'abc' } } }).intervalMs, 5000);
    assert.equal(parseLiveCarousel({ content: { carousels: { carouselTime: '5' } } }).intervalMs, 5000);
    assert.equal(parseLiveCarousel({ content: { carousels: { carouselTime: '0' } } }).intervalMs, 5000);
    assert.equal(parseLiveCarousel({ content: { carousels: { carouselTime: '200' } } }).intervalMs, 1200);
    assert.equal(parseLiveCarousel({ content: { carousels: { carouselTime: '999999' } } }).intervalMs, 30000);
  });

  await check('空/垃圾入参不抛错', () => {
    for (const input of [null, undefined, {}, { content: null }, { content: { carousels: null } }]) {
      const r = parseLiveCarousel(input);
      assert.deepEqual(r.photos, []);
      assert.equal(r.radio, false);
    }
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    console.error(`  ✗ ${r.name}`);
    console.error(`    ${r.error?.message || r.error}`);
  }
}
console.log(`\nlive-carousel: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
