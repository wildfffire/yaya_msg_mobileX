// 时长归一测试入口（纯 Node 运行，不依赖 jest / tsx）。
//
// 为什么需要这层包装：__tests__/mediaDuration.test.ts 头部写的是用 tsx 运行，
// 而本仓库并未安装 tsx，导致它长期是「存在但从不执行」的孤儿测试。
// 这里沿用 scripts/network-request.test.mjs 的既有做法：先用本地 typescript
// 把 TS 编译到临时目录，再交给 Node 内置测试运行器执行，做到
// 「零新增依赖 + 失败即非 0 退出」，可直接挂进 CI。
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const testEntry = join(root, '__tests__', 'mediaDuration.test.ts');
// 期望的用例数下限。用例只会增加不会减少，所以这里写死当前值即可；
// 真正的作用见下方守卫：防止「自动化测试悄悄空掉，CI 却一路绿灯」。
const MIN_EXPECTED_CASES = 9;
const tmp = mkdtempSync(join(tmpdir(), 'yaya-media-duration-'));

try {
  // 用例数守卫（fail-closed）：若用例被删空或被整段注释掉，
  // node --test 会以「0 个用例 + 退出码 0」结束，CI 会显示绿色但实际什么都没验。
  // 这正是本仓库反复踩过的「测试没跑却显示通过」，所以必须自己守住。
  const caseCount = (readFileSync(testEntry, 'utf8').match(/^test\(/gm) || []).length;
  if (caseCount < MIN_EXPECTED_CASES) {
    throw new Error(`用例数异常：${caseCount} < ${MIN_EXPECTED_CASES}（${testEntry}）—— 拒绝以「通过」结束`);
  }

  // esModuleInterop 必须开：测试文件用的是 `import assert from 'node:assert/strict'`（默认导入），
  // 关掉时编译产物会去取 `.default` 而拿到 undefined，用例会以「假失败」告终。
  execSync(
    `npx tsc "${join(root, '__tests__', 'mediaDuration.test.ts')}" "${join(root, 'src', 'utils', 'mediaDuration.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );

  const compiled = join(tmp, '__tests__', 'mediaDuration.test.js');
  if (!existsSync(compiled)) {
    // 编译「成功」却没有产物 = 参数或路径有问题。必须显式失败，
    // 否则会出现最坏的情况：测试一条没跑，CI 却显示绿色。
    throw new Error(`编译产物缺失，未执行任何用例：${compiled}`);
  }

  execSync(`node --test "${compiled}"`, { cwd: root, stdio: 'inherit' });
  console.log('[media-duration] 用例全部通过');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
