// 账号中心解析规则 + 接线回归锁（纯 Node）。
// 解析规则来自旧 LoginScreen，迁移到 src/screens/account/accountParse.ts 后行为必须逐字一致。
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-account-'));
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const read = (p) => readFileSync(join(root, p), 'utf8');

try {
  execSync(
    `npx tsc "${join(root, 'src', 'screens', 'account', 'accountParse.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'screens', 'account', 'accountParse.js')}`);
  const {
    maskToken, extractPocketToken, buildBilibiliCookieFromUrl, pickBiliCookies,
    accountId, accountName, accountRole, accountAvatar, parseAccountInfo,
    avatarUrl, statusTone,
  } = mod;

  await check('头像地址归一：相对路径补域名 / 绝对地址原样 / 空值', () => {
    assert.equal(avatarUrl('/a.png'), 'https://source.48.cn/a.png');
    assert.equal(avatarUrl('a.png'), 'https://source.48.cn/a.png');
    assert.equal(avatarUrl('https://x.cn/a.png'), 'https://x.cn/a.png');
    assert.equal(avatarUrl(''), '');
    assert.equal(avatarUrl(undefined), '');
  });

  await check('状态提示语义：成功 / 失败优先 / 中性 / 空串', () => {
    assert.equal(statusTone('登录成功'), 'success');
    assert.equal(statusTone('昵称修改成功'), 'success');
    assert.equal(statusTone('Token 已复制'), 'success');
    assert.equal(statusTone('切换账号失败：超时'), 'danger');
    assert.equal(statusTone('Token无效：401'), 'danger');
    assert.equal(statusTone('二维码已过期请刷新'), 'danger');
    assert.equal(statusTone('正在检查Token'), 'info');
    assert.equal(statusTone('请用B站App扫码'), 'info');
    assert.equal(statusTone(''), 'info');
  });

  await check('Token 掩码：短 token 与长 token 都不泄漏完整值', () => {
    assert.equal(maskToken('abc'), 'abc***');
    assert.equal(maskToken('1234567890abcdef'), '123456...cdef');
    assert.equal(maskToken(''), '***');
  });

  await check('登录/切号 token 提取：别名 + 深找 + 空值', () => {
    assert.equal(extractPocketToken({ content: { accessToken: 'x'.repeat(20) } }), 'x'.repeat(20));
    assert.equal(extractPocketToken({ a: { b: { token: 'y'.repeat(30) } } }), 'y'.repeat(30));
    assert.equal(extractPocketToken({ token: 'short' }), '');
    assert.equal(extractPocketToken(null), '');
  });

  await check('B站扫码 cookie：crossDomain / hash / 嵌套编码 / 原生 Set-Cookie', () => {
    const raw = 'https://passport.bilibili.com/x/passport-login/web/crossDomain?SESSDATA=aaa&bili_jct=bbb&DedeUserID=123';
    assert.match(buildBilibiliCookieFromUrl(raw), /SESSDATA=aaa/);
    assert.match(buildBilibiliCookieFromUrl('https://x/#SESSDATA=ccc&bili_jct=ddd'), /SESSDATA=ccc/);
    assert.match(buildBilibiliCookieFromUrl(encodeURIComponent(raw)), /SESSDATA=aaa/);
    assert.match(pickBiliCookies('foo=1; SESSDATA=zzz; bili_jct=kkk'), /SESSDATA=zzz/);
    assert.doesNotMatch(pickBiliCookies('foo=1; SESSDATA=zzz'), /foo=1/);
  });

  await check('账号字段解析：id / 昵称 / 角色 / 头像补域名', () => {
    assert.equal(accountId({ userId: 88 }), '88');
    assert.equal(accountId({ userInfo: { id: '77' } }), '77');
    assert.equal(accountName({ baseUserInfo: { nickName: '小牙' } }), '小牙');
    assert.equal(accountName({}, '未命名'), '未命名');
    assert.equal(accountRole({ roleName: '主号' }, '账号'), '主号');
    assert.equal(accountAvatar({ avatar: '/a.png' }), 'https://source.48.cn/a.png');
    assert.equal(accountAvatar({ avatar: 'https://x.cn/a.png' }), 'https://x.cn/a.png');
    assert.equal(accountAvatar({}), '');
  });

  await check('大小号列表：按 id 去重、当前账号排最前、主号/小号标记', () => {
    const info = parseAccountInfo({
      content: {
        userInfo: { userId: 2, nickname: '小号B' },
        bigSmallInfo: {
          bigUserInfo: { userId: 1, nickname: '主号A' },
          smallUserInfo: [{ userId: 2, nickname: '小号B' }, { userId: 3, nickname: '小号C' }],
          smallUserList: [{ userId: 2, nickname: '重复的小号B' }],
        },
      },
    });
    assert.equal(info.users.length, 3);
    assert.equal(accountId(info.users[0]), '2', '当前账号应排最前');
    assert.equal(info.users[0].__isMain, false);
    assert.equal(info.users[1].__isMain, true, '大号行标主号');
    assert.equal(accountId(info.current), '2');
  });

  await check('首页成员直播卡：照搬直播页双徽标且只认 liveType===2', () => {
    const home = read('src/screens/HomeScreen.tsx');
    assert.match(home, /homeLiveCellStatusBadge/);
    assert.match(home, /item\.liveType === 2 \? t\('电台'\) : t\('视频'\)/);
    assert.match(home, /<LivePulseDot size=\{6\} \/>/);
    assert.doesNotMatch(home, /styles\.liveBadgeText/);
  });

  await check('账号中心路由：注册新页、删除旧页与旧路由', () => {
    const nav = read('src/navigation/index.tsx');
    const types = read('src/navigation/types.ts');
    assert.match(nav, /import AccountScreen from '\.\.\/screens\/AccountScreen'/);
    assert.match(nav, /const AccountStackScreen = withPageMotion\(AccountScreen/);
    assert.match(nav, /<Stack\.Screen name="AccountScreen"/);
    assert.match(types, /AccountScreen: undefined;/);
    assert.doesNotMatch(nav, /screens\/LoginScreen/);
    assert.doesNotMatch(types, /LoginScreen/);
    assert.ok(!existsSync(join(root, 'src/screens/LoginScreen.tsx')), '旧账号管理页面应已删除');
  });

  await check('入口迁移：侧栏头像 / 我的页 / 首页 / 登录提示 / 房间空态', () => {
    const bar = read('src/components/AppSideBar.tsx');
    assert.match(bar, /onOpenAccount/);
    assert.doesNotMatch(bar, /UserProfileSheet/);
    assert.match(read('src/navigation/index.tsx'), /onOpenAccount=\{\(\) => navigationRef\.navigate\('AccountScreen'\)\}/);
    for (const f of [
      'src/screens/MyScreen.tsx',
      'src/screens/HomeScreen.tsx',
      'src/components/LoginPrompt.tsx',
      'src/screens/FollowedRoomsScreen.tsx',
    ]) {
      const s = read(f);
      assert.match(s, /AccountScreen/, `${f} 未指向账号中心`);
      assert.doesNotMatch(s, /navigate\('LoginScreen'\)|route: 'LoginScreen'/, `${f} 仍指向旧页`);
    }
  });

  await check('设置页：账号入口与自动签到分组已删除、横屏默认分类有效', () => {
    const settings = read('src/screens/SettingsScreen.tsx');
    assert.doesNotMatch(settings, /id="account"/);
    assert.doesNotMatch(settings, /id="checkin"/);
    assert.doesNotMatch(settings, /navigate\('LoginScreen'\)/);
    assert.match(settings, /isLandscape \? 'appearance' : null/);
  });

  await check('账号中心能力：切号刷新 / 充值 / 自动签到 / B站管理 / i18n 门禁', () => {
    const screen = read('src/screens/AccountScreen.tsx');
    const sections = read('src/screens/account/AccountSections.tsx');
    const checkin = read('src/screens/account/AccountCheckinSection.tsx');
    const biliSection = read('src/screens/account/AccountBiliSection.tsx');
    const pocket = read('src/screens/account/usePocketAccount.ts');
    assert.match(screen, /usePocketAccount\(\)/);
    assert.match(screen, /useAccountProfile\(loggedIn\)/);
    assert.match(screen, /useBiliLogin\(\)/);
    assert.match(sections, /t\('刷新账号列表'\)/);
    assert.match(sections, /t\('鸡腿充值'\)/);
    assert.match(checkin, /t\('立即签到'\)/);
    assert.match(biliSection, /t\('B站账号'\)/);
    assert.match(pocket, /loginCheckToken\(\)/);
    assert.match(pocket, /switchBigSmall\(/);
    assert.match(read('scripts/check-i18n-coverage.js'), /src\/screens\/AccountScreen\.tsx/);
  });

  await check('账号中心布局：宽屏双栏（左栏 300） / 窄屏不再 560 窄条', () => {
    const screen = read('src/screens/AccountScreen.tsx');
    const styles = read('src/screens/account/accountStyles.ts');
    const layout = read('src/screens/account/AccountLayout.tsx');
    assert.match(screen, /width >= 840/, '宽屏判据（平板竖屏也要双栏）');
    assert.match(styles, /rail: \{ width: 300 \}/, '左栏固定 300');
    assert.match(layout, /railContent/, '左栏独立滚动');
    assert.match(layout, /paneContent/, '右栏独立滚动');
    assert.doesNotMatch(styles, /maxWidth: 560/, '旧的 560 窄条必须去掉');
  });

  await check('账号中心信息架构：4 分区 + Hero 弹窗改名（不再列表内改名）', () => {
    const styles = read('src/screens/account/accountStyles.ts');
    const sections = read('src/screens/account/AccountSections.tsx');
    const hero = read('src/screens/account/AccountHero.tsx');
    const modal = read('src/screens/account/AccountProfileModal.tsx');
    assert.match(sections, /id: 'switch'[\s\S]*id: 'recharge'[\s\S]*id: 'checkin'[\s\S]*id: 'bili'/, '分区顺序');
    assert.doesNotMatch(sections, /id: 'identity'/, '旧的账号与安全分区已并入账号切换');
    assert.match(hero, /onEditProfile/, 'Hero 是编辑资料入口');
    assert.match(modal, /pickAvatar\(\)/);
    assert.match(modal, /editNickname\(\)/);
    assert.doesNotMatch(styles, /stateRow|accountRow|moneyRow/, '旧版样式已清理');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`account-center: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
