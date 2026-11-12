// 现场互动（口袋云握手 netface）解析规则 + 接线回归锁（纯 Node）。
//
// 权威源：桌面端 yk1z/yaya_msg
//   src/common/netface-model.js      events() / statusText / session
//   src/common/netface-api.mjs       接口路径
//   src/renderer/netface-feature.js  renderList() / waitTime() / reservationTime()
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-netface-'));
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
    `npx tsc "${join(root, 'src', 'utils', 'netfaceRules.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'netfaceRules.js')}`);
  const {
    netfaceTickets, netfaceEvents, netfaceStatusText, netfaceTimeText, netfaceBalance, netfaceSession,
  } = mod;

  await check('活动列表：过滤无效 ticketId，保留名称', () => {
    const list = netfaceTickets([
      { ticketId: '1001', ticketName: '2026 春季云握手' },
      { ticketId: 0, ticketName: '脏数据' },
      { ticketId: 'abc' },
      null,
      { ticketId: '1002' },
    ]);
    assert.equal(list.length, 2);
    assert.equal(list[0].ticketId, '1001');
    assert.equal(list[0].ticketName, '2026 春季云握手');
    assert.equal(list[1].ticketName, '活动 1002');
    assert.deepEqual(netfaceTickets(null), []);
  });

  await check('场次合并：reservations + alreadyReservations，已预约判定与排队号回填', () => {
    const info = {
      groupInfos: [{ groupId: '9', groupName: 'SNH48' }],
      reservations: [
        { eventId: '501', status: 1, groupId: '9', starInfo: { userId: '77', name: '小A', teamName: 'TEAM HII', avatar: '/a.jpg' }, queueSize: 12, waitTime: 125 },
        { eventId: '502', status: 1, starInfo: { name: '小B' } },
      ],
      alreadyReservations: [
        { eventId: '503', status: 2, starInfo: { name: '小C' }, queneNumber: '8', orderNum: 2, queueStartTime: '1700000000000' },
      ],
      eventIds: [
        { eventId: '503', queueNumber: '15', duration: 60 },
        { eventId: '501', queueNumber: '99' },
      ],
    };
    const list = netfaceEvents(info);
    assert.equal(list.length, 3);
    const a = list.find((v) => v.eventId === '501');
    const c = list.find((v) => v.eventId === '503');
    assert.equal(a.ordered, false);
    assert.equal(a.queueSize, '12');
    assert.equal(a.waitText, '2分5秒');
    assert.equal(a.teamName, 'TEAM HII');
    assert.equal(a.groupName, 'SNH48');
    assert.equal(c.ordered, true);
    // eventIds 里的 queueNumber 优先（桌面端同款）
    assert.equal(c.queueNumber, '15');
    assert.equal(c.orderedCount, '2');
    assert.equal(c.statusText, '排队中');
  });

  await check('场次合并：状态 >= 2 也算已预约，同一 eventId 后写覆盖', () => {
    const list = netfaceEvents({
      reservations: [{ eventId: '9', status: 1, starInfo: { name: '旧' } }, { eventId: '9', status: 3, starInfo: { name: '新' } }],
      alreadyReservations: [],
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].starName, '新');
    assert.equal(list[0].ordered, true);
  });

  await check('状态文案：越界/非数字回落到「状态待确认」', () => {
    assert.equal(netfaceStatusText(1), '可预约');
    assert.equal(netfaceStatusText(5), '超时未入场');
    assert.equal(netfaceStatusText(99), '状态待确认');
    assert.equal(netfaceStatusText(null), '状态待确认');
  });

  await check('时间：按北京时间格式化（UTC+8），非法值返回空串', () => {
    // 2023-11-14T22:13:20Z = 北京时间 2023-11-15 06:13
    assert.equal(netfaceTimeText(1700000000000), '2023-11-15 06:13');
    assert.equal(netfaceTimeText(''), '');
    assert.equal(netfaceTimeText('abc'), '');
  });

  await check('余额：数字直用，包装字段兜底，负数/脏值归零', () => {
    assert.equal(netfaceBalance(3), 3);
    assert.equal(netfaceBalance({ balance: '5' }), 5);
    assert.equal(netfaceBalance({ tpNum: 2 }), 2);
    assert.equal(netfaceBalance({ balance: -1 }), 0);
    assert.equal(netfaceBalance(null), 0);
  });

  await check('握手会话：joinStatus=1 才算开始，剩余秒数是倒计时基准', () => {
    const s = netfaceSession({ joinStatus: 1, remainingTime: 120, eventPauseStatus: 1 }, 1000);
    assert.equal(s.started, true);
    assert.equal(s.paused, true);
    assert.equal(s.remainingTime, 120);
    assert.equal(s.deadline, 1000 + 120000);
    assert.equal(netfaceSession({ joinStatus: 0, remainingTime: 120 }).started, false);
  });

  // ---- 静态守卫 ----
  const api = read('src/api/pocket48.ts');
  const screen = read('src/screens/NetfaceScreen.tsx');
  const nav = read('src/navigation/index.tsx');
  const my = read('src/screens/MyScreen.tsx');
  const home = read('src/screens/HomeScreen.tsx');

  await check('接口层：桌面端同款 netface 路径', () => {
    for (const path of [
      '/netface/api/v1/user/tp/ticket_info',
      '/netface/api/v1/user/reservation/info',
      '/netface/api/v1/user/tp/balance',
      '/netface/api/v1/user/batch/balancetime',
      '/netface/api/v1/user/reservation',
      '/netface/api/v1/user/reservation/cancel',
      '/netface/api/v1/user/act/key',
      '/netface/api/v1/user/act/log',
    ]) {
      assert.ok(api.includes(path), `缺少接口 ${path}`);
    }
    // eventId 必须按字符串传（长数字转 Number 会丢精度）
    assert.ok(api.includes("eventId: String(eventId || '')"));
    assert.ok(api.includes('eventIds: (eventIds || []).map((id) => String(id))'));
    assert.ok(api.includes('appInfo: JSON.stringify(appInfo())'), '兑换码接口要把 appInfo 放进 body');
  });

  await check('页面接线：场次列表 + 预约/取消 + 资格兑换/记录', () => {
    assert.ok(screen.includes('netfaceEvents'));
    assert.ok(screen.includes('netfaceTickets'));
    assert.ok(screen.includes('reserveNetface'));
    assert.ok(screen.includes('cancelNetface'));
    assert.ok(screen.includes('activateNetfaceKey'));
    assert.ok(screen.includes('getNetfaceHistory'));
    assert.ok(screen.includes('getNetfaceWait'));
    assert.ok(screen.includes('getNetfaceBalance'));
    // 不做假入场按钮（移动端没有通话 SDK，会白扣资格）
    assert.ok(!screen.includes('joinNetface'), '移动端不接入入场/通话');
  });

  await check('路由与入口：首页 → 工具第一位 → 现场互动', () => {
    assert.ok(nav.includes("import NetfaceScreen from '../screens/NetfaceScreen'"));
    assert.ok(nav.includes('<Stack.Screen name="NetfaceScreen"'));
    // 用户 2026-11-11：从「我的 → 工具」移到首页工具条第一位
    assert.ok(home.includes("{ title: '现场互动'"), '首页工具条缺少现场互动');
    assert.ok(home.includes("route: 'NetfaceScreen'"));
    assert.ok(home.indexOf("{ title: '现场互动'") < home.indexOf("{ title: '翻牌'"), '必须排在工具第一位');
    assert.ok(!my.includes("navigate('NetfaceScreen')"), '「我的」页不应再保留入口');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message || r.error}`}`);
console.log(`netface: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
