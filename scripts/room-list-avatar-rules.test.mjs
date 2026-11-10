// 房间列表头像规则测试（纯 Node，零新增依赖）。
//
// 为什么必须钉住这一层（用户 2026-11-09）：
//   房间列表头像 = 偶像自己给房间设置的图标（serverIcon），
//   与「公式照」「房间内消息头像（ext.user.avatar）」是三套独立的图。
//   取错字段**不会抛异常**，只会「列表看起来和公式照一模一样」——
//   历史上就错在用了 star/archives 的 starInfo.avatar（该字段根本不存在）。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-list-avatar-'));

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
    `npx tsc "${join(root, 'src', 'utils', 'roomListAvatarRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'roomListAvatarRules.js')}`);
  const {
    pickRoomAvatarFromDetail,
    normalizeRoomAvatarUrl,
    roomAvatarFresh,
    parseRoomAvatarMap,
    trimRoomAvatarMap,
    ROOM_AVATAR_TTL_MS,
  } = mod;
  for (const fn of ['pickRoomAvatarFromDetail', 'normalizeRoomAvatarUrl', 'roomAvatarFresh', 'parseRoomAvatarMap', 'trimRoomAvatarMap']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里没有 ${fn} —— 拒绝以「通过」结束`);
  }

  await check('取的是 chatServerInfo.serverIcon（偶像自选的房间图标）', () => {
    assert.equal(
      pickRoomAvatarFromDetail({ chatServerInfo: { serverIcon: 'https://source.48.cn/abc.jpg' } }),
      'https://source.48.cn/abc.jpg',
    );
    assert.equal(
      pickRoomAvatarFromDetail({ chatServerInfo: { serverIcon: '/2024/0101/icon.jpg' } }),
      'https://source.48.cn/2024/0101/icon.jpg',
    );
  });

  await check('反向锁：serverDefaultIcon（系统默认图 ≈ 公式照）绝不能当自选返回', () => {
    const detail = { chatServerInfo: { serverDefaultIcon: 'https://www.snh48.com/images/member/zp_10081.jpg' } };
    assert.equal(pickRoomAvatarFromDetail(detail), '', '只有默认图时必须返回空，交给公式照兜底');
  });

  await check('没有 serverIcon / 结构异常 → 空串（不崩、不乱取字段）', () => {
    assert.equal(pickRoomAvatarFromDetail(null), '');
    assert.equal(pickRoomAvatarFromDetail({}), '');
    assert.equal(pickRoomAvatarFromDetail({ chatServerInfo: {} }), '');
    assert.equal(pickRoomAvatarFromDetail({ chatServerInfo: { serverIcon: '' } }), '');
  });

  await check('normalizeRoomAvatarUrl：绝对地址原样、相对路径补 source.48.cn、非法值丢弃', () => {
    assert.equal(normalizeRoomAvatarUrl('https://x.test/a.png'), 'https://x.test/a.png');
    assert.equal(normalizeRoomAvatarUrl('//x.test/a.png'), 'https://x.test/a.png');
    assert.equal(normalizeRoomAvatarUrl('/a/b.png'), 'https://source.48.cn/a/b.png');
    // 上游 normalizeFollowedSourceUrl 同款：不带协议的 48.cn 地址补 https
    assert.equal(normalizeRoomAvatarUrl('source.48.cn/a/b.png'), 'https://source.48.cn/a/b.png');
    assert.equal(normalizeRoomAvatarUrl('  https://x.test/a.png  '), 'https://x.test/a.png');
    assert.equal(normalizeRoomAvatarUrl('not-a-url'), '');
    assert.equal(normalizeRoomAvatarUrl(undefined), '');
  });

  await check('新鲜度：TTL 内有效、过期失效；空 URL 的「无自选图标」结果也算新鲜（避免反复请求）', () => {
    const now = Date.now();
    assert.equal(roomAvatarFresh({ url: 'https://x.test/a.png', at: now }), true);
    assert.equal(roomAvatarFresh({ url: 'https://x.test/a.png', at: now - ROOM_AVATAR_TTL_MS + 1000 }), true);
    assert.equal(roomAvatarFresh({ url: 'https://x.test/a.png', at: now - ROOM_AVATAR_TTL_MS - 1000 }), false);
    assert.equal(roomAvatarFresh({ url: '', at: now }), true, '空结果也要缓存一段时间');
    assert.equal(roomAvatarFresh(null), false);
    assert.equal(roomAvatarFresh({ url: 'x', at: 0 }), false);
  });

  await check('磁盘回读：坏 JSON / 数组 / 非法 at 全部丢弃，空 URL 条目保留', () => {
    assert.deepEqual(parseRoomAvatarMap(''), {});
    assert.deepEqual(parseRoomAvatarMap('not json'), {});
    assert.deepEqual(parseRoomAvatarMap('[]'), {});
    const parsed = parseRoomAvatarMap(JSON.stringify({
      '1': { url: 'https://x.test/a.png', at: 1000 },
      '2': { url: '', at: 2000 },
      '3': { url: 'https://x.test/b.png', at: 0 },
      '4': 'https://x.test/c.png',
    }));
    assert.deepEqual(parsed, {
      '1': { url: 'https://x.test/a.png', at: 1000 },
      '2': { url: '', at: 2000 },
    });
  });

  await check('淘汰：超过上限按 at 丢最旧的，保留最新', () => {
    const map = {
      a: { url: '', at: 100 },
      b: { url: '', at: 300 },
      c: { url: '', at: 200 },
    };
    const trimmed = trimRoomAvatarMap(map, 2);
    assert.deepEqual(Object.keys(trimmed).sort(), ['b', 'c']);
    assert.equal(trimRoomAvatarMap(map, 5), map, '未超限时原样返回');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[room-list-avatar-rules] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
