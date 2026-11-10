#!/usr/bin/env node
// Build Android release APK and auto-copy to APK folder with versioned name

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const androidDir = path.join(projectRoot, 'android');
/**
 * APK 落地目录。
 * ⚠️ 以前硬编码成 `E:/yymsg/APK`（原作者机器上的盘符）—— 换台机器没有 E 盘时
 * 会在「构建成功后、拷贝 APK」这一步抛 ENOENT，构建白跑。
 * 现在：优先读环境变量 `YAYA_APK_OUT_DIR`，否则落到用户主目录下的 `yaya-apk`
 *（不写进仓库，避免污染工作区；同时任何机器都能跑通）。
 */
const apkOutputDir = process.env.YAYA_APK_OUT_DIR || path.join(require('os').homedir(), 'yaya-apk');
const pkg = require(path.join(projectRoot, 'package.json'));

/**
 * 读取一个 Gradle 属性（与 Gradle `findProperty()` 的口径保持一致）。
 *
 * ⚠️ 为什么必须读文件而不只看环境变量：Gradle 的 `findProperty()` 会依次查
 * ① `-P` 命令行属性 ② 项目 `android/gradle.properties` ③ **用户级 `~/.gradle/gradle.properties`**，
 * 而 build.gradle 里正是 `propOrEnv()` = 先 findProperty 再 System.getenv。
 * 本机就是把 RELEASE_* 放在**用户级** gradle.properties 里的 ——
 * 如果这里只看 `process.env`，就会误判成「没有正式签名」，
 * 白生成一个用不上的 debug.keystore，还会打印与实际相反的风险提示。
 */
function readGradleProperty(name) {
  const candidates = [
    path.join(androidDir, 'gradle.properties'),
    path.join(require('os').homedir(), '.gradle', 'gradle.properties'),
  ];
  const re = new RegExp(`^\\s*${name}\\s*=`);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => re.test(l));
    if (!line) continue;
    const value = line.slice(line.indexOf('=') + 1).trim();
    if (value) return value;
  }
  return '';
}

/** 与本项目 build.gradle 的 propOrEnv() 同序：gradle.properties 优先，其次环境变量 */
function propOrEnv(name) {
  return readGradleProperty(name) || String(process.env[name] || '').trim();
}

/**
 * 出包前置：确保 debug keystore 存在（**仅在确实没有正式签名时**才需要）。
 *
 * 背景：`.gitignore` 忽略了 `*.keystore`，仓库里没有 debug.keystore；
 * 而 build.gradle 在没有 RELEASE_* 时会退回 `signingConfigs.debug`
 * → 那种情况下缺文件会以 `validateSigningRelease` 失败。
 * CI 里已有同样一步（见 .github/workflows/android-apk.yml 的 Ensure debug keystore），
 * 这里补上，目的是让「克隆下来直接跑」的机器也能一次成功。
 */
function ensureDebugKeystore() {
  const keystorePath = path.join(androidDir, 'app', 'debug.keystore');
  const releaseKeys = ['RELEASE_STORE_FILE', 'RELEASE_STORE_PASSWORD', 'RELEASE_KEY_ALIAS', 'RELEASE_KEY_PASSWORD'];
  const hasReleaseSigning = releaseKeys.every((k) => propOrEnv(k) !== '');
  if (hasReleaseSigning) {
    console.log('🔑 已检测到 RELEASE_* 正式签名（gradle.properties 或环境变量）→ release 包使用正式签名');
    return;
  }
  if (fs.existsSync(keystorePath)) return; // 已有就不覆盖（换签名会导致覆盖安装失败）

  // keytool 与 java 同源：优先用 JAVA_HOME（Android Studio 自带 JBR 里也有），再退回 PATH
  const exe = process.platform === 'win32' ? 'keytool.exe' : 'keytool';
  const fromJavaHome = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', exe) : '';
  const keytool = fromJavaHome && fs.existsSync(fromJavaHome) ? `"${fromJavaHome}"` : 'keytool';

  console.log('🔑 未检测到 RELEASE_* 正式签名 → 生成标准 debug keystore（仅供本地测试装机）');
  console.log('   ⚠️ 该签名与正式发布的包不一致：装到已装过正式版的手机上会提示「签名不一致」，需先卸载旧版。');
  try {
    execSync(
      [
        keytool,
        '-genkeypair',
        '-keystore', `"${keystorePath}"`,
        '-storepass', 'android',
        '-alias', 'androiddebugkey',
        '-keypass', 'android',
        '-dname', '"CN=Android Debug,O=Android,C=US"',
        '-keyalg', 'RSA',
        '-keysize', '2048',
        '-validity', '10000',
      ].join(' '),
      { stdio: 'inherit' },
    );
  } catch (e) {
    console.error('❌ 生成 debug.keystore 失败：', e.message);
    console.error('   请确认 JAVA_HOME 指向 JDK / Android Studio 自带 JBR（需要其中的 keytool）。');
    process.exit(1);
  }
  if (!fs.existsSync(keystorePath)) {
    console.error('❌ keytool 执行后仍未生成：', keystorePath);
    process.exit(1);
  }
  console.log(`✅ debug keystore 已生成：${keystorePath}`);
}

ensureDebugKeystore();

console.log('🔨 Building Android release APK...');
const gradleCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
// 出包铁律：必须 parallel=false（沙箱/部分机器上并行会触发 node_modules 库中间文件锁竞争，随机 AccessDenied）
// ⚠️ 默认只出 arm64-v8a + 不打包 universal（用户 2026-09-29 明确要求，长期约定）：
//   用户设备全是 arm64，多打 v7a / x86_64 / universal 纯属浪费构建时间
//   （全量 4 包 + Compose dexing 约 15 分钟；单 ABI 命中缓存约 1-2 分钟）。
//   需要其它 ABI（如 MuMu 模拟器 x86_64）时显式覆盖：
//     YAYA_ABIS=x86_64 node scripts/build-apk.js
const DEFAULT_ABIS = 'arm64-v8a';
const abisWanted = String(process.env.YAYA_ABIS || DEFAULT_ABIS).trim();
const universalWanted = String(process.env.YAYA_UNIVERSAL || 'false').trim();
/**
 * ⚠️ `-PreactNativeArchitectures` 必须跟 `yaya.abis` 一致（2026-10-06 环境体检修正）：
 *   app 侧的 ABI 由 `-Pyaya.abis` 控制，但 **React Native 库模块的原生编译**只看
 *   `reactNativeArchitectures`。两者不一致时会出现「只出一个 arm64 包，却把 worklets /
 *   reanimated 的 CMake 对 4 个 ABI 全编译一遍」——实测白等 3/4 的编译时间。
 */
const extraProps = `-Pyaya.abis=${abisWanted} -Pyaya.universal=${universalWanted} -PreactNativeArchitectures=${abisWanted}`;
// 并行必须关掉是铁律（见上方注释）。这里从 `-Dorg.gradle.parallel=false` 换成命令行
// `--no-parallel`：语义完全相同，但**命令行开关不会被 android/gradle.properties 里的
// org.gradle.parallel=true 覆盖**（那是给 Android Studio 用的默认值），读脚本时也更直观。
const gradleArgs = ['assembleRelease', '-Dorg.gradle.daemon=true', '--no-parallel', extraProps]
  .filter(Boolean)
  .join(' ');
if (extraProps) console.log(`   （附加 gradle 参数：${extraProps}）`);
try {
  // NODE_ENV=production 与 CI 保持一致：确保打的是生产 JS bundle（不是 dev bundle）
  execSync(`${gradleCmd} ${gradleArgs}`, {
    cwd: androidDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
} catch (e) {
  console.error('❌ Build failed');
  process.exit(1);
}

const version = pkg.version;
/**
 * 构建号（小版本）= Android versionCode，取自 app.json（与 build.gradle / APP_BUILD 由
 * scripts/verify-version.js 强制一致）。
 *
 * 用户 2026-10-05 要求：**每次构建都要能看到小版本** —— 产物文件名带上它，
 * 例如 `yaya-msg-mobile-v3.0.0-b3000000-v8a.apk`。
 * ⚠️ 文件名完全不影响安装：Android 只校验 APK 内部 manifest 的 versionCode / 签名，
 * 与文件名无关（同一 versionName 的多个修复包靠这个后缀区分）。
 */
const appJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'));
const versionCode = Number(appJson?.expo?.android?.versionCode || 0);
const buildTag = versionCode > 0 ? `-b${versionCode}` : '';
if (!buildTag) {
  console.warn('⚠️  未从 app.json 读到 versionCode —— 产物名将不含构建号（小版本）');
}
const apkDir = path.join(androidDir, 'app/build/outputs/apk/release');

// 只复制本次构建**实际要求**的 ABI（默认 arm64-v8a，见上方 DEFAULT_ABIS）：
// 以前写死三个 split 名，默认改单 ABI 后会连打两条「⚠️ Missing split APK」噪声警告。
const abiSplits = abisWanted.split(',').map((s) => s.trim()).filter(Boolean);

// Ensure APK output dir exists
if (!fs.existsSync(apkOutputDir)) {
  fs.mkdirSync(apkOutputDir, { recursive: true });
}

const copied = [];
const fileExists = f => fs.existsSync(f);

for (const abi of abiSplits) {
  const src = path.join(apkDir, `app-${abi}-release.apk`);
  if (!fileExists(src)) {
    console.warn(`⚠️  Missing split APK for ${abi}`);
    continue;
  }
  const abiTag = abi === 'arm64-v8a' ? 'v8a' : abi === 'x86_64' ? 'x64' : 'v7a';
  const destName = `yaya-msg-mobile-v${version}${buildTag}-${abiTag}.apk`;
  const destApk = path.join(apkOutputDir, destName);
  fs.copyFileSync(src, destApk);
  copied.push({ abi, file: destApk });
}

const universalSrc = path.join(apkDir, 'app-universal-release.apk');
if (universalWanted === 'true' && fileExists(universalSrc)) {
  const destName = `yaya-msg-mobile-v${version}${buildTag}.apk`;
  const destApk = path.join(apkOutputDir, destName);
  fs.copyFileSync(universalSrc, destApk);
  copied.push({ abi: 'universal', file: destApk });
}

if (copied.length === 0) {
  console.error('❌ No APK found at', apkDir);
  process.exit(1);
}

for (const c of copied) {
  const sizeMB = (fs.statSync(c.file).size / 1024 / 1024).toFixed(1);
  // 小版本必须出现在输出里：用户要求「每次构建都要告知小版本」
  console.log(`✅ [${c.abi}] APK copied to: ${c.file} (${sizeMB} MB)`);
  console.log(`   版本 v${version} · 小版本(Build) ${versionCode > 0 ? versionCode : '(未知)'} · ABI ${c.abi}`);
}