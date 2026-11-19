// 版本更新判定 + 老用户提醒链路回归锁（用户 2026-11-19：
// 「我每次更新 release，我原来的用户会收到通知吗？不能的话增加这个功能」）。
//
// 覆盖两类：
//   ① 纯规则：release tag（v3.0.0-b3000075）与本地 APP_VERSION/APP_BUILD 的判定 ——
//      历史 bug 是只比语义版本，把 tag 里 -b3000075 当第 4 段数字，装了最新包也永远有红点；
//   ② 静态接线：启动/回前台检测 → 提醒服务（弹窗 + 系统通知）→ 同版本只提醒一次。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-update-check-'));
const results = [];

async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error }); }
}

const read = (p) => readFileSync(join(root, p), 'utf8');

/** tsc 编译后的深链模块（下面的静态检查也会用到，故在 try 外声明） */
let linkMod;

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'updateRules.ts')}" "${join(root, 'src', 'utils', 'deepLinkRules.ts')}"`
    + ` --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(pathToFileURL(join(tmp, 'src', 'utils', 'updateRules.js')).href);
  const { parseReleaseTag, evaluateUpdate, compareVersions, releaseLabel, releaseApkAssetName, releaseApkUrl } = mod;
  linkMod = await import(pathToFileURL(join(tmp, 'src', 'utils', 'deepLinkRules.js')).href);

  await check('tag 解析：v3.0.0-b3000075 → 3.0.0 / 3000075', () => {
    const info = parseReleaseTag('v3.0.0-b3000075');
    assert.equal(info.version, '3.0.0');
    assert.equal(info.build, 3000075);
  });

  await check('同 build 不算更新（历史 bug：装了最新包仍提示有更新）', () => {
    assert.equal(evaluateUpdate('v3.0.0-b3000075', '3.0.0', 3000075).hasUpdate, false);
  });

  await check('旧 build 不算更新（本地已更新）', () => {
    assert.equal(evaluateUpdate('v3.0.0-b3000074', '3.0.0', 3000075).hasUpdate, false);
    assert.equal(evaluateUpdate('v3.0.0-b3000067', '3.0.0', 3000075).hasUpdate, false);
  });

  await check('新 build 算更新', () => {
    const res = evaluateUpdate('v3.0.0-b3000076', '3.0.0', 3000075);
    assert.equal(res.hasUpdate, true);
    assert.equal(res.reason, 'build');
  });

  await check('同 build 但版本名更高算更新（补发语义版本）', () => {
    assert.equal(evaluateUpdate('v3.0.1-b3000075', '3.0.0', 3000075).hasUpdate, true);
  });

  await check('老 tag 无构建号：只比语义版本', () => {
    assert.equal(evaluateUpdate('v3.0.0', '3.0.0', 3000075).hasUpdate, false);
    assert.equal(evaluateUpdate('v3.1.0', '3.0.0', 3000075).hasUpdate, true);
    assert.equal(evaluateUpdate('v2.7.6', '3.0.0', 3000075).hasUpdate, false);
  });

  await check('脏数据/空 tag 不误报', () => {
    assert.equal(evaluateUpdate('', '3.0.0', 3000075).hasUpdate, false);
    assert.equal(evaluateUpdate(null, '3.0.0', 3000075).hasUpdate, false);
    assert.equal(evaluateUpdate('latest', '3.0.0', 3000075).hasUpdate, false);
  });

  await check('版本段比较与展示文案', () => {
    assert.equal(compareVersions('3.0.1', '3.0.0') > 0, true);
    assert.equal(compareVersions('3.0', '3.0.0'), 0);
    assert.equal(releaseLabel('v3.0.0-b3000075'), 'v3.0.0 · Build 3000075');
    assert.equal(releaseLabel('v3.1.0'), 'v3.1.0');
  });

  await check('Release 附件直链：点了直接下载 APK（不经过任何第三方页）', () => {
    const base = 'https://github.com/wildfffire/yaya_msg_mobileX/releases/download';
    assert.equal(releaseApkAssetName('v3.0.0-b3000078'), 'yaya-msg-mobile-v3.0.0-b3000078-v8a.apk');
    assert.equal(
      releaseApkUrl('v3.0.0-b3000078', base),
      `${base}/v3.0.0-b3000078/yaya-msg-mobile-v3.0.0-b3000078-v8a.apk`,
    );
    assert.equal(releaseApkUrl('', base), '');
    assert.equal(releaseApkUrl('v3.0.0-b3000078', ''), '');
  });
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

await check('store 用构建号判定（不再只比 APP_VERSION）', () => {
  const store = read('src/store/index.ts');
  assert.match(store, /evaluateUpdate\(tag,\s*APP_VERSION,\s*APP_BUILD\)/);
  assert.match(store, /APP_BUILD/);
  assert.match(store, /APP_VERSION/);
  assert.match(store, /from '\.\.\/constants'/);
});

await check('启动 / 回前台都会检测并提醒', () => {
  const app = read('App.tsx');
  assert.match(app, /function checkUpdateAndAnnounce\(\)/);
  assert.match(app, /announceUpdateIfNeeded\(\)/);
  // 启动时（ready effect）与回前台（AppState=active）各一处
  assert.equal((app.match(/checkUpdateAndAnnounce\(\);/g) || []).length >= 2, true);
});

await check('提醒服务：弹窗 + 系统通知 + 同版本只提醒一次', () => {
  const svc = read('src/services/updateNotice.ts');
  assert.match(svc, /promptVisible:\s*true/);
  assert.match(svc, /showSystemNotification\(/);
  assert.match(svc, /NOTIFIED_KEY/);
  // 判重按 build 优先、老 tag 退化按 tag
  assert.match(svc, /notified\.build < latest\.build/);
  assert.match(svc, /notified\.tag !== latest\.tag/);
  // 模拟提醒（?demo=1）绝不写去重键，否则假 build 会吃掉下一个真实版本的通知
  assert.match(svc, /options\.persist !== false/);
  assert.match(read('src/services/deepLink.ts'), /persist: false/);
});

await check('深链：yayamsg://checkupdate（含 ?demo=1）', () => {
  assert.deepEqual(linkMod.parseDeepLink('yayamsg://checkupdate'), { type: 'checkupdate', demo: false });
  assert.deepEqual(linkMod.parseDeepLink('yayamsg://checkupdate?demo=1'), { type: 'checkupdate', demo: true });
  assert.equal(linkMod.buildDeepLink({ type: 'checkupdate', demo: true }), 'yayamsg://checkupdate?demo=1');
  assert.deepEqual(linkMod.parseDeepLink('yayamsg://update'), { type: 'update' });
  // 未知/非法仍然拒绝
  assert.equal(linkMod.parseDeepLink('yayamsg://checkupdateX'), null);
});

await check('设置页点版本号复用同一条提醒链路（force 可复测）', () => {
  const svc = read('src/services/updateNotice.ts');
  assert.match(svc, /options\.force/);
  const settings = read('src/screens/SettingsScreen.tsx');
  assert.match(settings, /announceUpdateIfNeeded\(\{ force: true \}\)/);
});

await check('系统通知点按走 yayamsg://update（https 塞给原生会点了没反应）', () => {
  const svc = read('src/services/updateNotice.ts');
  assert.match(svc, /buildDeepLink\(\{ type: 'update' \}\)/);
  assert.equal(/uri:\s*state\.latestUrl/.test(svc), false);
  const rules = read('src/utils/deepLinkRules.ts');
  assert.match(rules, /head === 'update'/);
  const link = read('src/services/deepLink.ts');
  // 点按去 GitHub Release（优先 store 的附件直链，冷启动退回 Release 页面）
  assert.match(link, /case 'update'[\s\S]{0,900}latestUrl \|\| UPDATE_RELEASE_PAGE/);
});

await check('更新地址只接 GitHub Release（禁止第三方下载页）', () => {
  const constants = read('src/constants/index.ts');
  assert.match(constants, /UPDATE_RELEASE_DOWNLOAD_BASE/);
  assert.equal(/010push|a23xyz/.test(constants), false);
  for (const f of [
    'src/store/index.ts',
    'src/services/deepLink.ts',
    'src/services/updateNotice.ts',
    'src/components/UpdatePromptModal.tsx',
    'App.tsx',
  ]) {
    assert.equal(/010push|a23xyz/.test(read(f)), false, `${f} 仍引用第三方下载页`);
  }
  const store = read('src/store/index.ts');
  assert.match(store, /browser_download_url/);
  assert.match(store, /releaseApkUrl\(tag, UPDATE_RELEASE_DOWNLOAD_BASE\)/);
});

await check('弹窗组件与四份字典文案齐全', () => {
  const modal = read('src/components/UpdatePromptModal.tsx');
  assert.match(modal, /发现新版本/);
  assert.match(modal, /稍后再说/);
  assert.match(modal, /立即下载/);
  for (const lang of ['zh-Hant', 'en', 'ja', 'ko']) {
    const dict = read(`src/i18n/${lang}.ts`);
    for (const key of ['发现新版本', "'已发布，点按前往下载'", '更新说明', '立即下载', '稍后再说']) {
      assert.equal(dict.includes(key), true, `${lang} 缺少 ${key}`);
    }
  }
});

await check('test:core 已接入本测试', () => {
  assert.match(read('package.json'), /node scripts\/update-check\.test\.mjs/);
});

const failed = results.filter((r) => !r.ok);
console.log('');
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n    ${r.error?.message || r.error}`);
}
console.log(`\nupdate-check：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
