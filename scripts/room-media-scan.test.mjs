// 房间消息「媒体 URL 深扫」纯规则测试（纯 Node，零新增依赖）。
//
// 为什么先测这一层（用户 2026-10-06 反馈「陈琳的房间她每次说话都附带一个圈的图片」）：
//   房间消息来自两条链路（HTTP 历史 `team/message/list/*` + 云信圈组实时），
//   **两条链路都会把消息的 remoteExtension 带上**，其中 `ext.user` 是「谁在说话」的资料：
//     user.avatar（头像）、user.teamLogo（队徽，圆形）、user.pfUrl（头像框，圆形挂件）、user.badge（徽章）…
//   深扫兜底（collectUrls）曾经只按**字段名白名单**跳过头像，`pfUrl` / `teamLogo` 不在名单里
//   → **成员/房主发言的每条消息都会多挂一张圆形装饰图**（粉丝的资料里这些字段是空的，所以只有她多图）。
//   真机实证（`adb logcat` 的 `[room.media]` 诊断）：陈琳房间泄漏的正是 `ext.user.pfUrl`。
//   这与 2026-09 那次的「徐钰涵每条文字消息带公式照」是同一类 bug，只是泄漏字段不同。
//
// 本测试把规则钉成回归锁：
//   ① 发送者资料（user / userInfo / sender / fromUser / acceptUser）里的图片**永远不是消息附件**；
//   ② 真·媒体消息（bodys.url 图片 / playStreams 流地址）必须仍能被扫到 —— 防「修过头」；
//   ③ 反向锁：老口径（在 ext 上做任意层级的图片 URL 正则扫描）**确实会命中队徽**，
//      说明这条回归锁不是多余的（改回老实现就会红）。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-room-media-scan-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const AVATAR = 'https://source.48.cn/avatar/chenlin_2024.jpg';
const TEAM_LOGO = 'https://source.48.cn/mediasource/teamLogo2/all/snh48_x.png';
const PF_FRAME = 'https://source.48.cn/pf/member_frame_h2.png';

/** 真机形态：成员（房主）在房间里发一条纯文本消息（云信圈组 ext + bodys，字段名与 buildChannelExt/qchatToRoomMessage 一致） */
function ownerTextMessage() {
  const user = {
    userId: 1001,
    nickName: '陈琳',
    avatar: AVATAR,
    teamLogo: TEAM_LOGO,
    pfUrl: PF_FRAME,
    level: 9,
    roleId: 1,
    vip: true,
  };
  return {
    uuid: 'live-uuid-1',
    msgTime: 1759700000000,
    msgType: 'TEXT',
    bodys: { text: '今天排练到很晚，大家晚安', messageType: 'TEXT', user },
    extInfo: { module: 'qchat', channelRole: 3, bubbleId: '0', config: { build: '181022' }, user },
  };
}

/** 真机形态：粉丝在房间里发一条纯文本消息（资料里没有 teamLogo / pfUrl） */
function fanTextMessage() {
  const user = { userId: 2002, nickName: '小粉丝', avatar: 'https://source.48.cn/avatar/fan.jpg', level: 3, roleId: 0 };
  return {
    uuid: 'live-uuid-2',
    msgTime: 1759700001000,
    msgType: 'TEXT',
    bodys: { text: '好耶', messageType: 'TEXT', user },
    extInfo: { module: 'qchat', channelRole: 0, bubbleId: '0', user },
  };
}

try {
  execSync(
    `npx tsc "${join(root, 'src', 'screens', 'room', 'mediaScan.ts')}" "${join(root, 'src', 'screens', 'room', 'mediaRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const scan = await import(`file://${join(tmp, 'src', 'screens', 'room', 'mediaScan.js')}`);
  const rules = await import(`file://${join(tmp, 'src', 'screens', 'room', 'mediaRules.js')}`);
  const { collectUrls } = scan;
  const { classifyMedia } = rules;
  for (const fn of ['collectUrls']) {
    if (typeof scan[fn] !== 'function') throw new Error(`编译产物里缺少 ${fn} —— 拒绝以「通过」结束`);
  }

  /**
   * 模拟 `roomMedia()` 的兜底分支（源码：`url = allUrls.find(u => /^https?:\/\//i.test(u)) || ''`）：
   * 深扫 ext + body，取第一个 http(s) 地址当「消息附件」。
   * 这一步就是「多出一张图」的现场 —— 只要深扫放行队徽，它就必然成为附件。
   */
  const fallbackAttachmentUrl = (item) => {
    const urls = [];
    collectUrls(item.extInfo, urls);
    const body = typeof item.bodys === 'string' ? JSON.parse(item.bodys) : item.bodys;
    collectUrls(body, urls);
    return urls.find((u) => u && /^https?:\/\//i.test(u)) || '';
  };

  await check('成员发言：ext/bodys 里的队徽、头像框、头像一律不当消息附件（陈琳多图回归锁）', () => {
    const item = ownerTextMessage();
    assert.deepEqual(collectUrls(item.extInfo), []);
    assert.deepEqual(collectUrls(item.bodys), []);
    assert.equal(fallbackAttachmentUrl(item), '');
  });

  await check('粉丝发言：同样不产生附件（不能只在成员身上修）', () => {
    assert.equal(fallbackAttachmentUrl(fanTextMessage()), '');
  });

  await check('反向锁：老口径（ext 上任意层级的图片 URL 正则扫描）确实会命中队徽 —— 根因不是猜测', () => {
    // 旧实现等价物：不跳 any 字段，把 ext 里出现的第一个 http 图片地址当附件
    const oldStyleScan = (value, result = []) => {
      if (!value || typeof value !== 'object') return result;
      for (const val of Object.values(value)) {
        if (typeof val === 'string' && /^https?:\/\/\S+\.(png|jpe?g|gif|webp)/i.test(val)) result.push(val);
        else if (val && typeof val === 'object') oldStyleScan(val, result);
      }
      return result;
    };
    const item = ownerTextMessage();
    const leaked = oldStyleScan(item.extInfo);
    assert.ok(leaked.includes(TEAM_LOGO), '老口径本应命中 teamLogo（若这里不红，说明样本已经不是真机形态）');
    // 并且：队徽被当附件后会被 classifyMedia 判成 image → 气泡里多一张图
    assert.equal(classifyMedia(TEAM_LOGO, 'TEXT', ''), 'image');
  });

  await check('真·图片消息仍能扫到（防修过头）：bodys.url 与 ext 里的媒体字段都放行', () => {
    const pic = 'https://source.48.cn/room/2026/10/06/pic_1.jpg';
    const item = {
      msgType: 'IMAGE',
      bodys: { url: pic, messageType: 'IMAGE', user: { userId: 1001, avatar: AVATAR, teamLogo: TEAM_LOGO } },
      extInfo: { messageType: 'IMAGE' },
    };
    assert.equal(fallbackAttachmentUrl(item), pic);
    assert.equal(classifyMedia(pic, 'IMAGE', ''), 'image');
  });

  await check('直播详情对象：只收流地址，不收主播头像/队徽（getLiveOne / getLiveList 形态）', () => {
    const flv = 'https://cyflv.48.cn/live/a_1.flv';
    const detail = {
      content: {
        liveId: '123456789012345678',
        user: { userId: 1001, avatar: AVATAR, teamLogo: TEAM_LOGO },
        playStreams: [{ streamPath: flv, vipShow: false }, { streamPath: '', vipShow: true }],
      },
    };
    const urls = collectUrls(detail);
    assert.ok(urls.includes(flv), `应扫到流地址，实际：${JSON.stringify(urls)}`);
    assert.ok(!urls.includes(AVATAR), '主播头像不是播放地址');
    assert.ok(!urls.includes(TEAM_LOGO), '队徽不是播放地址');
  });

  await check('字段名大小写漂移也要跳过（TeamLogo / HeadImg / USERINFO）', () => {
    const weird = {
      UserInfo: { HeadImg: AVATAR, TeamLogo: TEAM_LOGO, PfUrl: PF_FRAME },
      msgType: 'TEXT',
    };
    assert.deepEqual(collectUrls(weird), []);
  });

  await check('嵌套对象里的媒体地址仍照常收集（对象/数组递归没被误伤）', () => {
    const nested = {
      message: { bodys: { inner: [{ imageUrl: 'https://source.48.cn/room/a.png' }] } },
    };
    const urls = collectUrls(nested);
    assert.deepEqual(urls, ['https://source.48.cn/room/a.png']);
  });

  await check('真机可诊断：被跳过的资料图片会报出**具体字段名**，且日志里不带 URL', () => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.map((a) => String(a)).join(' '));
    try {
      // 用别的用例没出现过的字段名，避开模块内「每个字段只报一次」的去重
      collectUrls({ user: { badgeList: [{ icon: 'https://source.48.cn/badge/level9.png' }] } });
    } finally {
      console.log = original;
    }
    assert.ok(lines.some((l) => l.includes('字段 icon')), `应报出字段 icon，实际：${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => l.includes('http')), `日志里不能带 URL（可能含个人信息），实际：${JSON.stringify(lines)}`);
  });

  await check('序列化 extInfo 字符串（HTTP 历史消息形态）不会被正则捞出头像/队徽', () => {
    const raw = JSON.stringify({ module: 'qchat', user: { avatar: AVATAR, teamLogo: TEAM_LOGO } });
    assert.deepEqual(collectUrls({ extInfo: raw }), []);
  });

  /**
   * 引用（回复）消息（用户 2026-10-14 加入的功能）：引用卡里的原文只是「被引用那条消息的展示文本」，
   * 不是本条消息的附件 —— 不跳过会让「引用了一条带链接的消息」的回复凭空多出一张链接/图片卡。
   */
  await check('引用消息：replyInfo.replyText 里的 URL 不当附件（引用别人的链接不该多出卡片）', () => {
    const quotedLink = 'https://source.48.cn/room/quoted_pic.jpg';
    const item = {
      msgType: 'REPLY',
      bodys: { text: '哈哈哈这个好', messageType: 'REPLY' },
      extInfo: {
        module: 'qchat',
        messageType: 'REPLY',
        replyName: '小粉丝',
        replyText: quotedLink,
        replyInfo: { replyName: '小粉丝', replyText: quotedLink, replyMsgIdClient: 'abc' },
      },
    };
    assert.deepEqual(collectUrls(item.extInfo), []);
    assert.equal(fallbackAttachmentUrl(item), '');
  });

  await check('引用消息仍能识别自身附件（防修过头）：自己的图片消息 + 引用不算冲突', () => {
    const ownPic = 'https://source.48.cn/room/2026/10/14/own.jpg';
    const quotedLink = 'https://source.48.cn/room/quoted_q.jpg';
    const item = {
      msgType: 'IMAGE',
      bodys: { url: ownPic, messageType: 'IMAGE' },
      extInfo: { messageType: 'REPLY', replyText: quotedLink, replyInfo: { replyText: quotedLink } },
    };
    assert.equal(fallbackAttachmentUrl(item), ownPic);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[room-media-scan] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
