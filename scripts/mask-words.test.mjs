// 屏蔽词规则测试入口（纯 Node 运行，不依赖 jest / tsx）。
//
// 沿用 scripts/media-duration.test.mjs 的既有做法：先用本地 typescript 把 TS
// 编译到临时目录，再交给 Node 内置测试运行器执行，做到「零新增依赖 + 失败即非 0 退出」。
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const testEntry = join(root, '__tests__', 'maskWords.test.ts');
const utilEntry = join(root, 'src', 'utils', 'maskWords.ts');
// 用例数下限：防止「测试被删空 / 整段注释掉」时 node --test 以 0 个用例退出 0，
// CI 却显示绿色（本仓库踩过的坑，见 media-duration.test.mjs）。
const MIN_EXPECTED_CASES = 10;
const tmp = mkdtempSync(join(tmpdir(), 'yaya-mask-words-'));

try {
  const caseCount = (readFileSync(testEntry, 'utf8').match(/^test\(/gm) || []).length;
  if (caseCount < MIN_EXPECTED_CASES) {
    throw new Error(`用例数异常：${caseCount} < ${MIN_EXPECTED_CASES}（${testEntry}）—— 拒绝以「通过」结束`);
  }

  // esModuleInterop 必须开：测试文件用 `import assert from 'node:assert/strict'`（默认导入）
  execSync(
    `npx tsc "${testEntry}" "${utilEntry}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );

  const compiled = join(tmp, '__tests__', 'maskWords.test.js');
  if (!existsSync(compiled)) {
    throw new Error(`编译产物缺失，未执行任何用例：${compiled}`);
  }

  execSync(`node --test "${compiled}"`, { cwd: root, stdio: 'inherit' });
  console.log('[mask-words] 用例全部通过');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
