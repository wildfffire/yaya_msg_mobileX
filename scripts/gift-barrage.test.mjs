// 送礼公屏广播测试（纯 Node，零新增依赖）。
//
// 背景（用户反馈 2026-09-29）：「我送礼物，主播看不到我送的」。
// 根因：送礼只有 HTTP `/gift/api/v1/gift/send`（扣款+入账），而**礼物公屏消息是
// 客户端自己发到云信聊天室的** —— 别人送的能看到，正是因为官方客户端发了
// PRESENT_NORMAL 这条。我们没发 → 主播与所有观众都看不到。
//
// 这组用例钉住三件事：
//   ① 广播 ext 的字段与官方结构一致（messageType / giftInfo / text / user）；
//   ② **闭环**：自己发出的 ext 能被自家解析器 parseChatroomMessage 原样读回
//      （发出去的和收回来的同构 —— 官方端也按同一套字段渲染）；
//   ③ 两个送礼入口（直播页 MediaScreen / 房间页 FollowedRoomsScreen）都调用了 sendGift。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-gift-'));

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
    `npx tsc "${join(root, 'src', 'services', 'pocketNim', 'codec.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const codec = await import(`file://${join(tmp, 'src', 'services', 'pocketNim', 'codec.js')}`);
  const { buildLiveGiftExt, parseChatroomMessage } = codec;
  for (const n of ['buildLiveGiftExt', 'parseChatroomMessage']) {
    if (typeof codec[n] !== 'function') throw new Error(`编译产物里缺少 ${n} —— 拒绝以「通过」结束`);
  }

  const self = { userId: 123, nickName: '牙牙', avatar: 'https://x/a.png', level: 3, roleId: 0 };
  const gift = { toUserId: '456', toName: '刘增艳', giftId: 1001, giftName: '荧光棒-X', giftNum: 2, giftPic: 'https://x/g.png' };
  const build = () => buildLiveGiftExt({ roomId: '999', sourceId: 'live1', self, module: 'live', ...gift });

  await check('buildLiveGiftExt：messageType / giftInfo / 公屏文案', () => {
    const ext = build();
    assert.equal(ext.messageType, 'PRESENT_NORMAL');
    assert.equal(ext.module, 'live');
    assert.equal(ext.roomId, '999');
    assert.equal(ext.sourceId, 'live1');
    assert.equal(ext.text, '牙牙 送给 刘增艳 2个荧光棒-X');
    assert.equal(ext.giftInfo.giftId, 1001);
    assert.equal(ext.giftInfo.giftNum, 2);
    assert.equal(ext.giftInfo.picPath, 'https://x/g.png');
    assert.equal(ext.giftInfo.acceptUser.userName, '刘增艳');
    assert.equal(ext.giftInfo.acceptUser.userId, 456);
    assert.equal(ext.user.nickName, '牙牙');
    assert.equal(ext.fromApp, '201811');
  });

  await check('闭环：自己发的礼物 ext 能被自家解析器读回（官方端同构）', () => {
    const ext = build();
    const item = parseChatroomMessage({ type: 'custom', text: ext.text, remoteExtension: ext });
    assert.ok(item, '消息不应被丢弃');
    assert.equal(item.kind, 'gift');
    assert.equal(item.text, '牙牙 送给 刘增艳 2个荧光棒-X');
    assert.equal(item.gift.giftName, '荧光棒-X');
    assert.equal(item.gift.giftNum, 2);
    assert.equal(item.gift.toName, '刘增艳');
    assert.equal(item.gift.picPath, 'https://x/g.png');
    assert.equal(item.nick, '牙牙');
  });

  await check('缺图/缺昵称不炸：仍产出可用 ext', () => {
    const ext = buildLiveGiftExt({
      roomId: '1',
      sourceId: '2',
      self: { userId: 1, nickName: '', avatar: '' },
      toUserId: '',
      toName: '',
      giftId: '7',
      giftName: '礼物',
      giftNum: 0,
    });
    assert.equal(ext.messageType, 'PRESENT_NORMAL');
    assert.equal(ext.giftInfo.giftNum, 1, '数量 0 应兜底成 1');
    assert.equal(ext.giftInfo.picPath, '');
    const item = parseChatroomMessage({ type: 'custom', text: ext.text, remoteExtension: ext });
    assert.ok(item && item.kind === 'gift');
  });

  await check('静态守卫：两个送礼入口都补发了公屏广播', () => {
    // ⚠️ 2026-10-02 播放器统一：送礼公屏广播改走统一播放宿主暴露的
    // sendGiftBroadcast（宿主内部持有唯一一条云信连接），两个页面分别经宿主 ref 调用。
    for (const file of ['src/screens/MediaScreen.tsx', 'src/screens/FollowedRoomsScreen.tsx']) {
      const source = readFileSync(join(root, file), 'utf8');
      assert.ok(/sendGiftBroadcast\(\{\s*\n?\s*toUserId/.test(source), `${file} 送礼后没有调用公屏广播 —— 主播又会看不到`);
    }
    // 宿主把 sendGiftBroadcast 转成云信 sendGift（唯一实现处）
    const host = readFileSync(join(root, 'src/player/session/MediaPlaybackHost.tsx'), 'utf8');
    assert.ok(host.includes('sendGiftBroadcast') && /sendGift\?\.\(gift\)/.test(host), '宿主未把 sendGiftBroadcast 接到云信 sendGift');
    const chatroom = readFileSync(join(root, 'src/services/pocketNim/chatroom.ts'), 'utf8');
    assert.ok(chatroom.includes('buildLiveGiftExt'), 'chatroom 未使用 buildLiveGiftExt');
    assert.ok(chatroom.includes('async sendGift('), 'chatroom 缺少 sendGift');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ✓ ${r.name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${r.name}`);
    console.log(String(r.error?.stack || r.error).split('\n').slice(0, 8).join('\n'));
  }
}
console.log(`\n礼物公屏广播：${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
