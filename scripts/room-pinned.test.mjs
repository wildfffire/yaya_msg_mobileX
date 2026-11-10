// 房间「精华消息」（偶像/房主置顶）+ 本轮外观收敛的回归锁（纯 Node，零新增依赖）。
//
// 权威源：桌面端 yk1z/yaya_msg
//   src/common/pocket-runtime.mjs        fetchRoomEssenceMessages → /im/api/v1/team/essence/message/list
//   src/renderer/followed-chat-feature.js normalizeFollowedRoomEssenceMessage
//   index.html / style.css                #followed-room-essence 横幅 + 详情弹窗
// 移动端必须只读展示，不允许用户自己置顶、不本地持久化官方数据。
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-essence-'));
const results = [];

// 权威源补充（用户 2026-11-09：精华改成弹窗 + 喇叭入口）：
//   · 已读判定 = 本地阅读状态（services/roomEssenceSeen.ts 落盘），官方数据仍不落盘；
//   · 弹窗内容对齐桌面端 openFollowedRoomEssenceDetail：头像→主页、图片→原图、视频→就地播。

async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const read = (p) => readFileSync(join(root, p), 'utf8');
const rooms = read('src/screens/FollowedRoomsScreen.tsx');
const host = read('src/player/session/MediaPlaybackHost.tsx');
const settings = read('src/screens/SettingsScreen.tsx');
const my = read('src/screens/MyScreen.tsx');
const row = read('src/screens/room/RoomListRow.tsx');
const api = read('src/api/pocket48.ts');
const store = read('src/services/roomPinned.ts');
const seenStore = read('src/services/roomEssenceSeen.ts');
const bar = read('src/components/RoomEssencePopup.tsx');

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'roomPinnedRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'roomPinnedRules.js')}`);
  const { roomPinnedKey, normalizePinnedText, normalizeEssenceList, essenceMessageText, essenceMediaKind, essenceUnseenIds } = mod;
  for (const fn of ['roomPinnedKey', 'normalizePinnedText', 'normalizeEssenceList', 'essenceMessageText', 'essenceMediaKind', 'essenceUnseenIds']) {
    if (typeof mod[fn] !== 'function') throw new Error(`编译产物里没有 ${fn}`);
  }

  await check('频道 key：空值不产生脏键', () => {
    assert.equal(roomPinnedKey(' 123 '), '123');
    assert.equal(roomPinnedKey(456), '456');
    assert.equal(roomPinnedKey(null), '');
  });
  await check('文本归一：折叠空白、限长、非字符串安全', () => {
    assert.equal(normalizePinnedText('  明天  19:00 \n 公演  '), '明天 19:00 公演');
    assert.equal(normalizePinnedText('abcdef', 3), 'abc');
    assert.equal(normalizePinnedText(null), '');
  });
  await check('精华正文：TEXT 直出，媒体类型回落标签，JSON 正文多字段兜底', () => {
    assert.equal(essenceMessageText({ msgType: 'TEXT', bodys: '  明天见  ' }), '明天见');
    assert.equal(essenceMessageText({ msgType: 'IMAGE', bodys: '{"url":"https://x/a.png"}' }), '[图片消息]');
    assert.equal(essenceMessageText({ msgType: 'REPLY', bodys: '{"replyText":"收到"}' }), '收到');
    assert.equal(essenceMessageText({ msgType: 'VIDEO', bodys: '' }), '[视频消息]');
  });
  await check('精华列表：解析 content.essenceMessageList，ext.user 取昵称，脏数据逐条过滤', () => {
    const out = normalizeEssenceList({
      essenceMessageList: [
        { msgIdClient: 'm1', msgType: 'TEXT', bodys: '  公告：今晚八点  ', msgTime: 1700000000000, extInfo: JSON.stringify({ user: { nickName: '小A' } }) },
        { msgIdClient: 'm2', msgType: 'TEXT', bodys: '', msgTime: 1 },
        'oops',
        { msgIdClient: 'm3', msgType: 'IMAGE', bodys: '{"url":"/a.png"}', extInfo: '{}' },
      ],
    });
    assert.equal(out.length, 3);
    assert.equal(out[0].sender, '小A');
    assert.equal(out[0].text, '公告：今晚八点');
    assert.equal(out[0].time, 1700000000000);
    assert.equal(out[2].imageUrl, 'https://source3.48.cn/a.png');
    assert.equal(out[2].text, '[图片消息]');
  });
  await check('精华列表：兼容数组直传 / 其它列表字段 / 空输入', () => {
    assert.equal(normalizeEssenceList([{ msgType: 'TEXT', bodys: 'hi' }]).length, 1);
    assert.equal(normalizeEssenceList({ list: [{ msgType: 'TEXT', bodys: 'hi' }] }).length, 1);
    assert.deepEqual(normalizeEssenceList(null), []);
    assert.deepEqual(normalizeEssenceList({}), []);
  });
  await check('精华列表：发送者 userId / 头像 / 视频封面（详情页三项入口依赖）', () => {
    const out = normalizeEssenceList({
      essenceMessageList: [
        {
          msgIdClient: 'v1',
          msgType: 'VIDEO',
          bodys: JSON.stringify({ url: '/v/a.mp4', coverUrl: '/v/a.jpg' }),
          extInfo: JSON.stringify({ user: { userId: '88001', nickName: '小A', avatar: '/avatar/a.jpg' } }),
        },
        { msgIdClient: 't1', msgType: 'TEXT', bodys: 'hi', extInfo: JSON.stringify({ user: { userId: 88002 } }) },
      ],
    });
    assert.equal(out[0].userId, '88001');
    assert.equal(out[0].avatarUrl, 'https://source.48.cn/avatar/a.jpg');
    assert.equal(out[0].videoUrl, 'https://mp4.48.cn/v/a.mp4');
    assert.equal(out[0].videoPoster, 'https://source3.48.cn/v/a.jpg');
    assert.equal(out[0].msgType, 'VIDEO');
    assert.equal(out[1].userId, '88002');
    assert.equal(out[1].avatarUrl, '');
  });
  await check('媒体类型判定：视频优先于图片，纯文本最后', () => {
    assert.equal(essenceMediaKind({ videoUrl: 'a', imageUrl: 'b' }), 'video');
    assert.equal(essenceMediaKind({ videoUrl: '', imageUrl: 'b' }), 'image');
    assert.equal(essenceMediaKind({ videoUrl: '', imageUrl: '' }), 'text');
    assert.equal(essenceMediaKind(null), 'text');
  });
  await check('已读判重：只挑没见过的 id，空值安全', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(essenceUnseenIds(items, ['a']), ['b', 'c']);
    assert.deepEqual(essenceUnseenIds(items, undefined), ['a', 'b', 'c']);
    assert.deepEqual(essenceUnseenIds(items, ['a', 'b', 'c']), []);
    assert.deepEqual(essenceUnseenIds([], ['a']), []);
  });

  // ---- 静态守卫 ----
  await check('接口层接入桌面端同款 essence 接口', () => {
    assert.ok(api.includes('/im/api/v1/team/essence/message/list'));
    assert.ok(api.includes('getRoomEssenceMessages'));
  });
  await check('房间页进房拉精华消息并只读展示', () => {
    assert.ok(rooms.includes('getRoomEssenceMessages'));
    assert.ok(rooms.includes('normalizeEssenceList'));
    assert.ok(rooms.includes('<RoomPinnedSheet'));
    assert.ok(rooms.includes('setEssenceIndex'));
  });
  await check('弹窗 + 工具栏喇叭：常驻横幅已删除（用户 2026-11-09）', () => {
    assert.ok(rooms.includes('<RoomPinnedBell'));
    assert.ok(!rooms.includes('<RoomPinnedBar'), '旧的常驻横幅不该再渲染');
    assert.ok(bar.includes('export function RoomPinnedBell'));
    assert.ok(bar.includes('export function RoomPinnedSheet'));
    assert.ok(bar.includes("name=\"bullhorn-outline\""), '喇叭入口图标');
  });
  await check('精华条状态：正在加载 / 加载失败 + 重试（对齐桌面端 loadFollowedRoomEssence）', () => {
    assert.ok(store.includes("'loading'"));
    assert.ok(store.includes("'error'"));
    assert.ok(bar.includes('正在加载精华消息'));
    assert.ok(bar.includes('精华消息加载失败'));
    assert.ok(rooms.includes('loadRoomEssence'));
    assert.ok(rooms.includes('onRetry'));
  });
  await check('看过的精华不再主动弹：阅读状态单独落盘，官方数据仍不落盘', () => {
    assert.ok(seenStore.includes('AsyncStorage'), '已读状态必须跨启动记住');
    assert.ok(!store.includes('AsyncStorage'), '官方精华数据不该本地持久化');
    assert.ok(rooms.includes('useRoomEssenceSeenStore'));
    assert.ok(rooms.includes('markSeen'));
    assert.ok(rooms.includes('essenceUnseen'));
  });
  await check('详情三项：头像→房间用户资料卡 / 图片→原图 / 视频就地播', () => {
    // 用户 2026-11-09：成员头像也不跳 ProfileScreen 了，改成与房间内头像完全一致的用户资料卡
    assert.ok(rooms.includes('openSenderProfile({'), '头像点击应走房间用户资料卡');
    assert.ok(!/onOpenSender[\s\S]{0,600}?navigate\('ProfileScreen'/.test(rooms), '精华里不应再跳成员主页');
    assert.ok(rooms.includes('setFullImageUrl(url)'));
    assert.ok(bar.includes("from 'react-native-video'"));
    assert.ok(bar.includes('onOpenImage'));
    assert.ok(bar.includes('onOpenSender'));
    assert.ok(bar.includes('POCKET_MEDIA_HEADERS'), '视频必须带 48 防盗链头');
  });
  await check('不再是「用户自己置顶」：无本地写入 / 无持久化 / 无候选选择', () => {
    assert.ok(!store.includes('AsyncStorage'), '官方数据不该本地持久化');
    assert.ok(!store.includes('pin:'), 'store 不该有用户写入动作');
    assert.ok(!bar.includes('从最近消息选择'), '不该有从消息里挑一条置顶的 UI');
    assert.ok(!bar.includes('onPick'), '不该有用户置顶回调');
  });
  await check('设置分类详情页不再显示 Version / Build', () => {
    assert.ok(!settings.includes("t('Version {v}'"));
    assert.ok(!settings.includes("t('Build {n}'"));
  });
  await check('「我的」hero 仍保留 v{APP_VERSION} 与 Build', () => {
    assert.ok(my.includes('v{APP_VERSION}'));
    assert.ok(my.includes("t('Build {n}'"));
  });
  await check('公告面板写死品牌粉已清除，改用 palette.tint', () => {
    assert.ok(!host.includes('rgba(251,114,153'));
    assert.ok(!host.includes("'#fb7299'"));
    assert.ok(host.includes('withAlpha(palette.tint, 0.32)'));
    assert.ok(host.includes('color={palette.tint}'));
  });
  await check('房间列表徽章 compact 缩小，但 Team 前缀保持 11 号字', () => {
    assert.ok(row.includes('fontSize={10}'));
    assert.ok(row.includes('compact'));
    assert.ok(!row.includes('fontSize: 10'), 'Team 文字前缀不该被缩小');
  });
  await check('进出房间的浮层复位清单包含置顶面板', () => {
    const hits = (rooms.match(/setPinnedSheetVisible\(false\)/g) || []).length;
    assert.ok(hits >= 3, `closeRoom / openRoom / 残留复位 应各有一处，实际 ${hits}`);
  });
  await check('四份字典补齐精华消息文案', () => {
    for (const lang of ['en', 'zh-Hant', 'ja', 'ko']) {
      const dict = read(`src/i18n/${lang}.ts`);
      assert.ok(dict.includes("'精华消息'"), `${lang} 缺 精华消息`);
      assert.ok(dict.includes("'查看精华消息'"), `${lang} 缺 查看精华消息`);
    }
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`room-essence: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
