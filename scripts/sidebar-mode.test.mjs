// 「横屏侧边栏模式」回归锁（用户 2026-11-11）。
//
// 口径：只有「设备横屏」且「设置开关打开」两个条件同时成立才切侧栏；
// 竖屏或开关关闭时必须像素级回退现有底部胶囊 + 大标题 + 问候语。
// 纯规则用 tsc 编译成临时 JS 后直接跑；静态接线锁则钉住「单一真值源」与
// 四处消费者的接线，避免以后有人在页面里另写一份判定导致两种模式不同步。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-sidebar-mode-'));
const results = [];

async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error }); }
}

function src(...parts) {
  return readFileSync(join(root, 'src', ...parts), 'utf8');
}

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'sidebarMode.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'sidebarMode.js')}`);
  const { sidebarModeActive, sidebarMetrics } = mod;
  for (const fn of ['sidebarModeActive', 'sidebarMetrics']) {
    if (typeof mod[fn] !== 'function') {
      throw new Error(`编译产物里没有 ${fn} —— 拒绝以「通过」结束`);
    }
  }

  await check('横屏 + 开关打开 → 侧栏生效', () => {
    assert.equal(sidebarModeActive(true, true), true);
  });

  await check('★ 竖屏（哪怕开关开着）→ 保持现有底部胶囊', () => {
    assert.equal(sidebarModeActive(false, true), false);
  });

  await check('★ 横屏但开关关闭 → 保持现有横屏布局', () => {
    assert.equal(sidebarModeActive(true, false), false);
  });

  await check('老用户存档没有该字段（undefined / null）→ 默认关', () => {
    assert.equal(sidebarModeActive(true, undefined), false);
    assert.equal(sidebarModeActive(true, null), false);
  });

  await check('只认严格布尔 true：1 / "true" / 对象都不能误开启', () => {
    assert.equal(sidebarModeActive(true, 1), false);
    assert.equal(sidebarModeActive(true, 'true'), false);
    assert.equal(sidebarModeActive(1, true), false);
  });

  await check('★ 侧栏宽度按屏幕短边自适应，不再是固定 96dp 白带', () => {
    // 真机 1600x2560 @400dpi → 横屏 1024x640dp：旧版 96dp，新版 58dp
    const tablet = sidebarMetrics(1024, 640);
    assert.deepEqual(tablet, { contentW: 48, inset: 10, totalW: 58 });
    // 手机横屏 851x393dp 更窄
    const phone = sidebarMetrics(851, 393);
    assert.deepEqual(phone, { contentW: 40, inset: 6, totalW: 46 });
    // 大平板横屏 1280x800dp 仍在夹取上限内
    const big = sidebarMetrics(1280, 800);
    assert.deepEqual(big, { contentW: 56, inset: 12, totalW: 68 });
    for (const m of [tablet, phone, big]) {
      assert.equal(m.totalW, m.contentW + m.inset);
      assert.ok(m.contentW >= 40 && m.contentW <= 56);
      assert.ok(m.totalW < 96, '不能再退回旧的固定 96dp 宽度');
    }
    // 异常尺寸也不能产出 NaN / 负数
    const weird = sidebarMetrics(0, 0);
    assert.ok(Number.isFinite(weird.totalW) && weird.totalW > 0);
  });

  await check('默认设置：landscape_sidebar_enabled = false，且不新增通知迁移 marker', () => {
    const settings = src('services', 'settings.ts');
    assert.match(settings, /landscape_sidebar_enabled:\s*false/);
    assert.ok(!/SIDEBAR_MIGRATION_KEY/.test(settings));
  });

  await check('统一 hook 复用纯规则，判定只有一处', () => {
    const hook = src('hooks', 'useSidebarMode.ts');
    assert.match(hook, /sidebarModeActive\(isLandscape,\s*enabled\)/);
    assert.match(hook, /landscape_sidebar_enabled/);
  });

  await check('侧栏本体是无底板纯图标：不用 GlassSurface / BlurView', () => {
    const bar = src('components', 'AppSideBar.tsx');
    // 只查真实引用：文件头注释里写了「不用 GlassSurface / BlurView」，不能把它当成命中
    assert.ok(!/from ['"].*GlassSurface|<GlassSurface|<BlurView|from ['"]expo-blur/.test(bar));
    assert.match(bar, /useSidebarMetrics\(\)/);
    assert.match(bar, /totalW/);
    assert.match(bar, /UserProfileSheet/);
    assert.match(bar, /badge/);
  });

  await check('★ 侧栏/场景/首页共用同一个自适应尺寸真值（固定 96dp 已彻底下线）', () => {
    for (const f of [
      ['components', 'AppSideBar.tsx'],
      ['navigation', 'index.tsx'],
      ['screens', 'HomeScreen.tsx'],
    ]) {
      assert.match(src(...f), /useSidebarMetrics\(\)/, `${f.join('/')} 未接尺寸 hook`);
    }
    for (const f of [
      ['components', 'AppSideBar.tsx'],
      ['navigation', 'index.tsx'],
      ['screens', 'HomeScreen.tsx'],
      ['utils', 'sidebarMode.ts'],
    ]) {
      const s = src(...f);
      assert.ok(!/SIDEBAR_TOTAL_W|SIDEBAR_CONTENT_W|SIDEBAR_SAFE_INSET/.test(s), `${f.join('/')} 仍有固定常量`);
    }
  });

  await check('导航层分流：侧栏常驻 + 场景让出左侧宽度 + hidden 仍生效', () => {
    const nav = src('navigation', 'index.tsx');
    assert.match(nav, /if \(sidebarMode\)/);
    assert.match(nav, /<AppSideBar/);
    assert.match(nav, /paddingLeft:\s*sidebarActive \? sidebarWidth : 0/);
    assert.match(nav, /const sidebarActive = sidebarMode && !tabBarHidden/);
    assert.match(nav, /if \(hidden\) return null/);
  });

  await check('标题隐藏收口在 ScreenHeader，一处覆盖全站 32 个调用点', () => {
    const header = src('components', 'ScreenHeader.tsx');
    assert.match(header, /useSidebarMode\(\)/);
    assert.match(header, /titleSpacer/);
    assert.ok(!/sidebarMode \? '' : title/.test(header));
  });

  await check('★ 顶部留白：紧凑页头 + 50dp 呼吸高度，比上一版微微下移、不叠大标题行', () => {
    const header = src('components', 'ScreenHeader.tsx');
    assert.match(header, /headerCompact/);
    assert.match(header, /sidebarTopPad/);
    assert.match(header, /paddingTop:\s*sidebarMode \? sidebarTopPad : topPad/);
    assert.match(header, /minHeight:\s*50/);
    assert.match(header, /paddingBottom:\s*6/);
    assert.ok(!/minHeight:\s*sidebarMode \? 34/.test(header));
    // 滚动收起不能被 minHeight 顶回来
    assert.match(header, /sidebarMode && !collapsed \? styles\.headerCompact : null/);
  });

  await check('★ 左下四个 tab：抬高离底距离 + 单元压紧（真机微调口径）', () => {
    const bar = src('components', 'AppSideBar.tsx');
    assert.match(bar, /bottom:\s*36/);
    assert.match(bar, /gap:\s*2/);
    assert.match(bar, /height:\s*40/);
    // 不能退回「太靠下、太散」的旧参数
    assert.ok(!/bottom:\s*12,\s*\n\s*gap:\s*4/.test(bar));
    assert.ok(!/cell:\s*\{\s*\n\s*height:\s*44/.test(bar));
  });

  await check('首页问候语整行不渲染（只置空会残留 34dp 空白）', () => {
    const home = src('screens', 'HomeScreen.tsx');
    assert.match(home, /useSidebarMode\(\)/);
    assert.match(home, /\{!sidebarMode \? \(/);
    assert.match(home, /\{greeting\}/);
  });

  await check('★ 成员直播只显示一行：按实际可用宽度排版 + nowrap + 宽度取整', () => {
    const home = src('screens', 'HomeScreen.tsx');
    assert.match(home, /const contentInset = sidebarMode \? sidebarMetrics\.totalW : 0/);
    assert.match(home, /winW - contentInset - spacing\.md \* 2 - 24/); // 快捷入口也要扣
    assert.match(home, /const liveAvailW = winW - contentInset - spacing\.md \* 2/);
    assert.match(home, /Math\.floor\(\(liveAvailW - LIVE_CELL_GAP \* \(liveCols - 1\)\) \/ liveCols\)/);
    assert.match(home, /flexWrap: 'nowrap', gap: LIVE_CELL_GAP/);
    assert.match(home, /lives\.slice\(0, liveCols\)/);
  });

  await check('直播页顶栏刷新图标已删，下拉刷新链路仍在', () => {
    const media = src('screens', 'MediaScreen.tsx');
    assert.ok(!/name="refresh"\s+size=\{22\}/.test(media));
    assert.match(media, /onRefresh=\{refreshList\}/);
    assert.match(media, /refreshing=\{refreshing\}/);
  });

  await check('四语言字典补齐设置开关与资料卡文案（i18n 门禁扫描 SettingsScreen）', () => {
    for (const lang of ['en.ts', 'zh-Hant.ts', 'ja.ts', 'ko.ts']) {
      const dict = src('i18n', lang);
      for (const key of [
        '横屏侧边栏',
        '开启后仅在横屏时把四个页面入口移到左侧图标栏，并隐藏页面标题与问候语',
        '我的资料',
        '请先登录',
      ]) {
        assert.ok(dict.includes(`'${key}'`), `${lang} 缺少 ${key}`);
      }
    }
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) console.error(r.error);
}
console.log(`\n[sidebar-mode] ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
