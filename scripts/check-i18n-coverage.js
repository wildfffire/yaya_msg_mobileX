// i18n 覆盖率校验（CI 门禁）。
//
// 作用：扫描源码里实际用到的 t('...') key，逐个比对 4 份字典，有缺失就报错。
// 说明：作为门禁使用时，发现缺失 key 会以非 0 退出码结束，避免「检查通过」是假的。
//
// 历史坑（已修）：早期版本用的是 /t\(['`]([^'`]+)['`]/g，有两处毛病 ——
//   1. 没有词边界，会把 format('Token {mask}')、split('#') 这类调用里的「t(...)」一并吃掉，
//      报出 `#`、`;`、`Token` 等根本不存在的「假 key」→ 假失败会让人不再相信这个检查；
//   2. key 自身带引号时会截断，例如 t('…点\"刷新账号列表\"。') 只截到引号前，
//      报出一个残缺的 key → 假失败（真实的缺失反而被糊掉了）。
//
// 已知局限（不追求完美，但要写下来）：只认「key 是紧跟括号的字面量」的形态，
// 因此 t(cond ? 'a' : 'b')、t(msg)、跨行写法不会被计入 —— 属于漏报而非误报，
// 也就是说这份门禁「宁可漏，不可假红」；动态 key 只能靠人工评审，不是正则的能力范围。
const fs = require('fs');

// 扫描范围：仅覆盖这几个历史高风险的入口。扩到全仓需先补齐 en/ja/ko 缺失的 key，
// 否则门禁会长期处于红色（见 docs/优化方案_小白版_2026-09-28.md 第 4 批）。
const files = ['src/screens/AccountScreen.tsx', 'src/screens/SettingsScreen.tsx', 'src/navigation/index.tsx'];

// 一个完整的字符串字面量：三种引号，且允许内部有 \" \' \\ 这类转义（否则带引号的 key 会被截断）。
// 前面的 (?:^|[^A-Za-z0-9_$]) 保证不是 format(...) / split(...) 这类调用的尾巴。
const T_CALL_RE =
  /(?:^|[^A-Za-z0-9_$])(?:t|translate)\(\s*(?:'((?:[^'\\\n]|\\.)+)'|"((?:[^"\\\n]|\\.)+)"|`([^`\n]+)`)/g;

const used = new Set();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(T_CALL_RE)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw) used.add(raw.replace(/\\(.)/g, '$1')); // 还原 \" 这类转义，得到运行时的真实 key
  }
}

const langs = {};
for (const l of ['zh-Hant', 'en', 'ja', 'ko']) {
  const s = fs.readFileSync('src/i18n/' + l + '.ts', 'utf8');
  const keys = [];
  for (const line of s.split(/\r?\n/)) {
    let m = line.match(/^\s*'([^']*)'\s*:/);
    if (m) { keys.push(m[1]); continue; }
    m = line.match(/^\s*([^'":][^:\n]*?)\s*:/);
    if (m) keys.push(m[1]);
  }
  langs[l] = new Set(keys);
  const dup = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  if (dup.length) console.log('DUP in ' + l + ': ' + dup.join(' | '));
}

console.log('used keys:', used.size);
console.log('missing in some dict:');
let any = false;
for (const k of used) {
  const miss = Object.entries(langs).filter(([, set]) => !set.has(k)).map(([n]) => n);
  if (miss.length) { any = true; console.log(' - ' + k + ' [' + miss.join(',') + ']'); }
}
if (!any) console.log(' (none)');

// 门禁：有缺失 key 即视为失败（用 exitCode 而非 exit()，保证上面的输出能刷完）
if (any) {
  console.log('\n[i18n] 存在缺失翻译 key —— 切到对应语言时会直接显示中文原文。');
  process.exitCode = 1;
}
