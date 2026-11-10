// PiliPlus 风格主题色规则回归锁（纯 Node，零新增依赖）。
//
// 钉住这一层的原因：主题色由「预设 / 自定义 RGB / 系统动态取色」三处入口写入，
// 任何一个 hex 解析或 HSL 变换写错都不会抛异常，表现是「选了颜色但界面没变」
// 或「亮黄色按钮上还是白字看不见」。规则必须只有一份，改一处就要过这里。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-theme-colors-'));

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
    `npx tsc "${join(root, 'src', 'theme', 'themeColors.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'theme', 'themeColors.js')}`);
  const {
    ACCENT_PRESETS, ACCENT_VARIANTS, DEFAULT_ACCENT_COLOR, DEFAULT_ACCENT_PRESET, CUSTOM_ACCENT_PRESET,
    normalizeVariant, normalizeHexColor, hexToRgb, rgbToHex, rgbToHsl, hslToRgb,
    mixHexColor, withAlpha, relativeLuminance, onColor, deriveAccentColors, resolveAccentSeed,
  } = mod;
  for (const fn of ['normalizeHexColor', 'rgbToHex', 'deriveAccentColors', 'resolveAccentSeed']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里没有 ${fn} —— 拒绝以「通过」结束`);
  }

  await check('预设表：品牌粉为默认，且完整保留 PiliPlus 的 19 个预设', () => {
    assert.equal(ACCENT_PRESETS.length, 20);
    assert.equal(ACCENT_PRESETS[0].id, DEFAULT_ACCENT_PRESET);
    assert.equal(ACCENT_PRESETS[0].color, DEFAULT_ACCENT_COLOR);
    assert.equal(ACCENT_PRESETS[1].color, '#5CB67B'); // 默认绿
    assert.equal(ACCENT_PRESETS[1].label, '默认绿');
    const labels = ACCENT_PRESETS.map((p) => p.label);
    for (const label of ['粉红色', '红色', '橙色', '琥珀色', '黄色', '酸橙色', '浅绿色', '绿色', '青色', '蓝绿色', '浅蓝色', '蓝色', '靛蓝色', '紫色', '深紫色', '蓝灰色', '棕色', '灰色']) {
      assert.ok(labels.includes(label), `缺少预设 ${label}`);
    }
    for (const p of ACCENT_PRESETS) assert.equal(normalizeHexColor(p.color), p.color, `${p.label} 不是 #RRGGBB`);
    assert.equal(new Set(ACCENT_PRESETS.map((p) => p.id)).size, ACCENT_PRESETS.length, '预设 id 重复');
    assert.equal(ACCENT_VARIANTS.length, 4);
  });

  await check('变体归一化：非法值一律回退标准', () => {
    assert.equal(normalizeVariant('soft'), 'soft');
    assert.equal(normalizeVariant('vivid'), 'vivid');
    assert.equal(normalizeVariant('mono'), 'mono');
    assert.equal(normalizeVariant(undefined), 'material');
    assert.equal(normalizeVariant('不存在'), 'material');
  });

  await check('hex 解析：3 位缩写、缺 #、非法字符、非字符串', () => {
    assert.equal(normalizeHexColor('#abc'), '#AABBCC');
    assert.equal(normalizeHexColor('ff6f91'), '#FF6F91');
    assert.equal(normalizeHexColor(' #FF6F91 '), '#FF6F91');
    assert.equal(normalizeHexColor('#12345'), null);
    assert.equal(normalizeHexColor('#GGGGGG'), null);
    assert.equal(normalizeHexColor('#12345678'), null);
    assert.equal(normalizeHexColor(null), null);
  });

  await check('RGB ↔ Hex 往返与越界钳制', () => {
    assert.deepEqual(hexToRgb('#FF6F91'), { r: 255, g: 111, b: 145 });
    assert.equal(rgbToHex(255, 111, 145), '#FF6F91');
    assert.equal(rgbToHex(-10, 300, 0), '#00FF00');
    for (const hex of ['#000000', '#FFFFFF', '#5CB67B', '#FFEB3B', '#03A9F4']) {
      const c = hexToRgb(hex);
      assert.equal(rgbToHex(c.r, c.g, c.b), hex);
    }
    // 脏数据不能渲染成透明/黑色主题：一律回退品牌粉
    assert.deepEqual(hexToRgb('oops'), hexToRgb(DEFAULT_ACCENT_COLOR));
  });

  await check('HSL 往返（允许四舍五入 ±2）', () => {
    for (const hex of ['#FF6F91', '#5CB67B', '#FFEB3B', '#03A9F4', '#9E9E9E']) {
      const c = hexToRgb(hex);
      const hsl = rgbToHsl(c.r, c.g, c.b);
      const back = hslToRgb(hsl.h, hsl.s, hsl.l);
      assert.ok(Math.abs(back.r - c.r) <= 2 && Math.abs(back.g - c.g) <= 2 && Math.abs(back.b - c.b) <= 2, `${hex} HSL 往返偏差过大`);
    }
  });

  await check('混色 / alpha / 亮度 / 前景色', () => {
    assert.equal(mixHexColor('#000000', '#FFFFFF', 0), '#000000');
    assert.equal(mixHexColor('#000000', '#FFFFFF', 1), '#FFFFFF');
    assert.equal(mixHexColor('#000000', '#FFFFFF', 0.5), '#808080');
    assert.equal(withAlpha('#FF6F91', 0.16), 'rgba(255, 111, 145, 0.16)');
    assert.equal(withAlpha('#FF6F91', 9), 'rgba(255, 111, 145, 1)');
    assert.ok(relativeLuminance('#FFFFFF') > 0.99);
    assert.ok(relativeLuminance('#000000') < 0.01);
    // 亮黄底必须自动用深字，蓝底用白字（PiliPlus ColorScheme 的 onPrimary 语义）
    assert.equal(onColor('#FFEB3B'), '#1B1B1F');
    assert.equal(onColor('#2196F3'), '#FFFFFF');
  });

  await check('种子色派生：四种风格互不相同，深色主色更亮，亮色底自动换深字', () => {
    const tints = ACCENT_VARIANTS.map((v) => deriveAccentColors('#FF6F91', v.id, false).tint);
    assert.equal(new Set(tints).size, 4, '四种调色板风格派生出了相同主色');
    const light = deriveAccentColors('#FF6F91', 'material', false);
    const dark = deriveAccentColors('#FF6F91', 'material', true);
    assert.equal(light.seed, '#FF6F91');
    assert.equal(light.seed, dark.seed);
    assert.ok(relativeLuminance(dark.tint) > relativeLuminance(light.tint), '深色主题主色应比浅色更亮');
    assert.ok(light.tintSoft.startsWith('rgba(') && light.tintMedium.startsWith('rgba('));
    assert.notEqual(light.tintAlt, light.tintContainer);
    const yellow = deriveAccentColors('#FFEB3B', 'material', false);
    assert.equal(yellow.onTint, '#1B1B1F');
  });

  await check('种子色解析优先级：动态取色 > 预设 > 自定义 > 品牌粉', () => {
    assert.equal(resolveAccentSeed({ presetId: 'blue', dynamicHex: '#00BCD4', dynamicEnabled: true }), '#00BCD4');
    assert.equal(resolveAccentSeed({ presetId: 'blue', customHex: '#123456' }), '#2196F3');
    assert.equal(resolveAccentSeed({ presetId: CUSTOM_ACCENT_PRESET, customHex: '#abcdef' }), '#ABCDEF');
    // 注意 'bad' 其实是合法的 3 位 hex（#BBAADD），非法输入要用真正不含 3/6 位 hex 的字符串
    assert.equal(resolveAccentSeed({ presetId: CUSTOM_ACCENT_PRESET, customHex: 'oops' }), DEFAULT_ACCENT_COLOR);
    assert.equal(resolveAccentSeed({ presetId: '未知预设' }), DEFAULT_ACCENT_COLOR);
    // 动态取色开关开着但没取到色：退回预设，不能变空
    assert.equal(resolveAccentSeed({ presetId: 'green', dynamicHex: null, dynamicEnabled: true }), '#4CAF50');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`theme-colors: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
