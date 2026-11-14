// 消息 id 口径「统一实现」回归锁（不改变现有行为）。
//
// 背景：聊天列表合并（messageKey）与计数/去重/游标（messageId）曾有
// 两套 id 优先级，可能把同一条消息算成两个键（用户 2026-11-13 统一）。
// 现在 messageKey 直接走 stableMessageId，唯一来源就是
// utils/roomMessageCursor.MESSAGE_ID_KEYS；真机检查点对账 0 分歧后已删除。
// 本测试只锁统一实现，防第二套 direct 优先级回流。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-message-id-'));

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
    `npx tsc "${join(root, 'src', 'utils', 'roomMessageCursor.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const cursor = await import(`file://${join(tmp, 'src', 'utils', 'roomMessageCursor.js')}`);

  await check('messageId 覆盖关键 id 字段：msgIdClient / msgIdServer / uuid', () => {
    assert.equal(cursor.messageId({ msgIdClient: 'c1' }), 'c1');
    assert.equal(cursor.messageId({ msgIdServer: 's1' }), 's1');
    assert.equal(cursor.messageId({ uuid: 'u1' }), 'u1');
  });

  const keyRules = readFileSync(join(root, 'src', 'screens', 'room', 'messageRules.ts'), 'utf8');
  const cursorRules = readFileSync(join(root, 'src', 'utils', 'roomMessageCursor.ts'), 'utf8');
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');

  await check('★ 统一实现：messageKey 只走 stableMessageId，id 优先级由 MESSAGE_ID_KEYS 一处定义', () => {
    assert.ok(keyRules.includes('stableMessageId(item)'), 'messageKey 必须用稳定 id');
    assert.ok(!keyRules.includes('legacyDirect'), '旧 direct 对账已删除');
    assert.ok(!keyRules.includes('id.messageKey'), '分歧检查点已删除');
    assert.ok(!keyRules.includes('roomCheck'), '检查点模块不应再有引用');
    for (const field of ['msgIdClient', 'msgIdServer', 'uuid']) {
      assert.ok(cursor.MESSAGE_ID_KEYS.includes(field), `MESSAGE_ID_KEYS 缺少 ${field}`);
    }
  });

  await check('★ 统一后不再有第二套 id 优先级：msgUuid 不参与 messageKey', () => {
    assert.ok(!keyRules.includes('item.msgUuid'), 'messageKey 不应再有独立的 msgUuid 兜底');
    assert.ok(!cursorRules.includes('msgUuid'), 'MESSAGE_ID_KEYS 仍未纳入 msgUuid');
  });

  await check('★ 优先级同源：MESSAGE_ID_KEYS 仍以 msgIdClient 优先于 uuid', () => {
    const stableIdx = cursorRules.indexOf("'msgIdClient'");
    const uuidIdx = cursorRules.indexOf("'uuid'");
    assert.ok(stableIdx > 0 && uuidIdx > stableIdx, 'MESSAGE_ID_KEYS 仍以 msgIdClient 优先');
  });

  await check('本回归锁并入 test:core', () => {
    assert.ok(pkg.includes('room-message-id-consistency.test.mjs'));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`room-message-id-consistency: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
