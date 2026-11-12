import { useMemberStore, useSettingsStore } from '../store';
import { generatePa, generatePaAsync, getWasmError, initWasm } from '../auth';
import { requestJson, xhrPost, fetchWithTimeout, raceWithWatchdog } from '../utils/network';
import { unwrapList, normalizeUrl } from '../utils/data';
import { parseLooseJson, ALREADY_CHECKED_MESSAGE_RE } from '../utils/json';
import { parseMaskWordsText } from '../utils/maskWords';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
// 进房耗时诊断（tag room）：只打首屏那一次请求，轮询/上拉不打
import { logInfo } from '../utils/runtimeLog';

// E2 记录：移动端 API 方法数少于桌面端 v2.11 通道（100+）——未移植的桌面通道：
// 选举计分（score-*）、花漾（pageantry-*）、QR 登录（login-*-qr）、部分 Area48 话题接口；
// 移动端无对应 UI，历史确认不在范围。新增接口时以桌面 pocket-runtime.mjs 为参数/头权威源。

const BASE = 'https://pocketapi.48.cn';
const APP_VERSION = '7.0.41';
const APP_BUILD = '24011601';

type HeadersMap = Record<string, string>;

function createDeviceId(): string {
  const chars = 'QWERTYUIOPASDFGHJKLZXCVBNM1234567890';
  const rand = (length: number) => {
    let result = '';
    for (let i = 0; i < length; i += 1) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
  };
  return `${rand(8)}-${rand(4)}-${rand(4)}-${rand(4)}-${rand(12)}`;
}

// 设备指纹持久化：DEVICE_ID 不再每次冷启动随机（随机 id 会被服务端风控判定为异常设备，
// 也破坏「同一账号同一设备」的连续性）。首次生成后写入 AsyncStorage，后续启动复用；
// 进程内同步先落一个临时 id 保证早期请求可用，AsyncStorage 读回后以持久值替换。
const DEVICE_ID_KEY = 'yaya_device_id_v1';
let DEVICE_ID = createDeviceId();
let deviceIdLoaded = false;

/**
 * 设备指纹「一次性初始化」Promise（模块级单例）。
 *
 * 旧实现是 `while (!deviceIdLoaded) await sleep(40)` 忙等，最多阻塞 800ms ——
 * 而 createSignedHeaders 每次签名都要走一遍，冷启动十几个请求会串行叠加成几秒。
 *
 * 另外旧实现有个隐藏 bug：**正常路径从不写回 AsyncStorage**（setItem 只存在于
 * 800ms 超时兜底分支里，而该分支基本不会触发）→ 首次运行生成的 id 从未落盘，
 * 每次冷启动都重新随机，正是注释里说要避免的「被服务端风控判定为异常设备」。
 */
let deviceIdReady: Promise<string> | null = null;

function initDeviceId(): Promise<string> {
  if (deviceIdReady) return deviceIdReady;
  deviceIdReady = (async () => {
    try {
      const saved = await AsyncStorage.getItem(DEVICE_ID_KEY);
      if (saved) {
        DEVICE_ID = saved;
      } else {
        // 首次运行：把本次生成的 id 落盘，保证后续启动复用同一设备指纹
        await AsyncStorage.setItem(DEVICE_ID_KEY, DEVICE_ID);
      }
    } catch {
      /* 读写失败：沿用内存临时 id，不阻塞请求 */
    }
    deviceIdLoaded = true;
    return DEVICE_ID;
  })();
  return deviceIdReady;
}

// 模块加载即开始读盘：早期请求直接 await 这个已在途的 Promise，无需各自等待
initDeviceId();

/** 等待持久化 DEVICE_ID 就绪（所有调用方复用同一个 Promise，不再忙等） */
function ensureDeviceId(): Promise<string> {
  if (deviceIdLoaded) return Promise.resolve(DEVICE_ID);
  return initDeviceId();
}

// --- App Info / Headers factories ---

function appInfo(modern = false, deviceId = DEVICE_ID) {
  if (modern) {
    return {
      vendor: 'apple',
      deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
      appVersion: '7.1.35',
      appBuild: '25101021',
      osVersion: '16.3.0',
      osType: 'ios',
      deviceName: 'iPhone 14 Pro',
      os: 'ios',
    };
  }
  return {
    vendor: 'apple',
    deviceId,
    appVersion: APP_VERSION,
    appBuild: APP_BUILD,
    osVersion: '16.3.1',
    osType: 'ios',
    deviceName: 'iPhone XR',
    os: 'ios',
  };
}

function createHeaders(token?: string, pa?: string | null, modern = false, deviceId = DEVICE_ID): HeadersMap {
  const headers: HeadersMap = {
    'Content-Type': 'application/json;charset=utf-8',
    'User-Agent': modern
      ? 'PocketFans201807/7.1.35 (iPhone; iOS 16.3; Scale/3.00)'
      : `PocketFans201807/${APP_VERSION} (iPhone; iOS 16.3.1; Scale/2.00)`,
    Host: 'pocketapi.48.cn',
    'Accept-Language': 'zh-Hans-CN;q=1',
    Accept: '*/*',
    appInfo: JSON.stringify(appInfo(modern, deviceId)),
  };
  if (token) headers.token = token;
  if (pa) headers.pa = pa;
  return headers;
}

function createModernHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers = createHeaders(token, pa, true);
  headers.appInfo = JSON.stringify({
    vendor: 'apple',
    deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
    appVersion: '7.1.35',
    appBuild: '25101021',
    osVersion: '16.3.0',
    osType: 'ios',
    deviceName: 'iPhone 14 Pro',
    os: 'ios',
  });
  headers['User-Agent'] = 'PocketFans201807/7.1.35 (iPhone; iOS 16.3; Scale/3.00)';
  headers['Content-Type'] = 'application/json;charset=utf-8';
  delete (headers as any).Origin;
  delete (headers as any).Referer;
  return headers;
}

function createCheckinHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers = createModernHeaders(token, pa);
  headers['P-Sign-Type'] = 'V0';
  return headers;
}

/** Android 客户端头（posts 相册/视频/动态、私信删除等） */
function createPocketAndroidHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers: HeadersMap = {
    'Content-Type': 'application/json; charset=UTF-8',
    'User-Agent': 'PocketFans201807/7.1.43_26070701 (SM-G9730:Android 12;Samsung V417IR release-keys)',
    'Accept-Language': 'zh-Hans-CN;q=1',
    Accept: '*/*',
    Host: 'pocketapi.48.cn',
    appInfo: JSON.stringify({
      IMEI: '7b93dfd0472f4736a628e85fae086486',
      appBuild: '26070701',
      appName: 'pocket48',
      appVersion: '7.1.43',
      deviceId: '7b93dfd0472f4736a628e85fae086486',
      deviceName: 'SM-G9730',
      osType: 'android',
      osVersion: '12',
      phoneName: 'SM-G9730',
      phoneSystemVersion: '12',
      vendor: 'Samsung',
    }),
  };
  if (token) headers.token = token;
  if (pa) headers.pa = pa;
  return headers;
}

/** Seine（ckg48 新版客户端）Android 头 */
function createSeineHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers = createPocketAndroidHeaders(token, pa);
  headers.appInfo = JSON.stringify({
    appVersion: '1.0.0',
    appBuild: 26061101,
    osType: 'android',
    appName: 'seine48',
    deviceId: '7b93dfd0472f4736a628e85fae086486',
    deviceName: 'SM-G9730',
    osVersion: '12',
    vendor: 'Samsung',
    IMEI: '7b93dfd0472f4736a628e85fae086486',
    phoneName: 'SM-G9730',
    phoneSystemVersion: '12',
  });
  headers['X-Custom-Device-Type'] = 'ANDROID';
  headers['User-Agent'] = 'PocketFans201807/1.0.0_26061101 (SM-G9730:Android 12;Samsung V417IR release-keys)';
  return headers;
}

/** Seine iOS 头（公演列表走 ckg48 域名） */
function createSeineIosHeaders(): HeadersMap {
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    Accept: '*/*',
    'Accept-Language': 'zh-Hans-CN;q=1',
    'User-Agent': 'Seina/1.2.0 (com.seine48.app; build:26072902; iOS 27.0.0) Alamofire/5.8.0',
    appInfo: JSON.stringify({
      deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
      appVersion: '1.2.0',
      deviceName: 'iPhone 16 Pro',
      osType: 'ios',
      appBuild: '26072902',
      osVersion: '27.0',
      appName: 'seine48',
      vendor: 'apple',
    }),
  };
}

/** Area48 社区头（老版 Android 客户端 6.0.22） */
function createArea48Headers(token?: string, pa?: string | null): HeadersMap {
  const headers: HeadersMap = {
    'Content-Type': 'application/json; charset=UTF-8',
    Accept: '*/*',
    'Accept-Language': 'zh-Hans-CN;q=1',
    'User-Agent': 'PocketFans201807/6.0.22_201128 (SM-G9730:Android 12;Samsung V417IR release-keys)',
    Host: 'pocketapi.48.cn',
    appInfo: JSON.stringify({
      IMEI: '6172656134383a303030303030',
      appBuild: '201128',
      appVersion: '6.0.22',
      deviceId: '6172656134383a303030303030',
      deviceName: 'SM-G9730',
      osType: 'android',
      osVersion: '12',
      phoneName: 'SM-G9730',
      phoneSystemVersion: '12',
      vendor: 'Samsung',
    }),
  };
  if (token) headers.token = token;
  if (pa) headers.pa = pa;
  return headers;
}

function createWeiboHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers = createModernHeaders(token, pa);
  headers.appInfo = JSON.stringify({
    vendor: 'apple',
    deviceId: '7B93DFD0-472F-4736-A628-E85FAE086487',
    appVersion: '7.1.38',
    appBuild: '26042402',
    osVersion: '26.5.0',
    osType: 'ios',
    deviceName: 'iPhone17,1',
    os: 'ios',
  });
  headers['User-Agent'] = 'PocketFans201807/7.1.38 (iPhone; iOS 26.5; Scale/3.00)';
  headers['P-Sign-Type'] = 'V0';
  return headers;
}

function createInvoiceHeaders(token?: string, options?: { tokenHeader?: boolean }): HeadersMap {
  const headers: HeadersMap = {
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'application/json, text/plain, */*',
    Host: 'pocketapi.48.cn',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  };
  if (options?.tokenHeader && token) headers.token = token;
  return headers;
}

function createPfileHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers = createModernHeaders(token, pa);
  delete headers['Content-Type'];
  delete headers.Host;
  return headers;
}


function createMeet48Headers(): HeadersMap {
  const settings = useSettingsStore.getState().settings;
  const storedAuth = settings.meet48Auth;
  const authDisabled = storedAuth?.disabled === true;
  const deviceId = (!authDisabled && storedAuth?.deviceId) || createDeviceId();
  const headers: HeadersMap = {
    'content-type': 'application/json',
    accept: '*/*',
    'accept-language': 'zh_TW',
    'user-agent': 'Meet48/2.0.3 (com.dapp.meet48; build:2602062; iOS 26.4.2) Alamofire/5.8.0',
    'x-versioncode': '2.0.3',
    'x-app-id': '2e63a31eac9d056755b0f83b89ef6674',
    'x-device-info': JSON.stringify({
      appVersion: '2.0.3',
      deviceId,
      osType: 'ios',
      appName: 'Meet48',
      vendor: 'apple',
      osVersion: '26.4.2',
      appBuildId: '2602062',
      osLoginType: 'common',
      bundleId: 'com.dapp.meet48',
      deviceName: 'iPhone17,1',
    }),
    'x-web-type': '1',
    'x-deviceid': deviceId,
    'x-custom-device-type': 'IOS',
  };
  const token = authDisabled ? '' : (storedAuth?.token || '');
  const cookie = authDisabled ? '' : (storedAuth?.cookie || '');
  if (token) headers.token = token;
  if (cookie) headers.cookie = cookie;
  return headers;
}

function tokenFromStore(): string {
  return useSettingsStore.getState().settings.p48Token || '';
}

function requireToken(): string {
  const token = tokenFromStore();
  if (!token) throw new Error('缺少 Token，请先登录口袋48或粘贴 Token');
  return token;
}

function responseOk(data: any): boolean {
  if (!data) return false;
  if (data.success === false) return false;
  if (typeof data.status === 'number' && data.status !== 200) return false;
  if (typeof data.code === 'number' && data.code !== 0) return false;
  if (data.success === true) return true;
  if (data.status === 200) return true;
  if (data.code === 0) return true;
  if (data.content !== undefined || data.data !== undefined || data.list !== undefined) return true;
  return false;
}

function responseMessage(data: any, fallback: string): string {
  return data?.message || data?.msg || data?.error || data?.statusDesc || fallback;
}

function assertPocketOk(data: any, fallback = 'pocket api request failed') {
  if (responseOk(data)) return data;
  const detail = responseMessage(data, fallback);
  const status = data?.status ?? data?.code;
  throw new Error(status !== undefined ? `${detail} (${status})` : detail);
}

/**
 * 后台签名（2026-11-10 真机实证）：App 退后台后 WebView 的 JS 被系统暂停，
 * `generatePaViaWebView()` 发过去永远收不到回包（日志：`签名超时（后台心跳兜底）`），
 * 后台轮询因此一条请求都发不出去。WASM 的 pa 函数无参数 → 签名只与时间/随机有关，
 * 不与请求体绑定，所以后台复用「最近一次前台成功生成的签名」（5 分钟内）即可，
 * 前台仍每次现签，行为完全不变；没有缓存时才走原链路并由看门狗兜底。
 */
let lastPa = '';
let lastPaAt = 0;
let lastPaCacheLogAt = 0;
const PA_CACHE_TTL_MS = 5 * 60_000;
/**
 * 前台签名复用窗口（用户 2026-11-12「进入房间的速度比较慢」）。
 *
 * `pa` 无参数（只与时间/随机有关、不与请求体绑定），服务端只看「签名是否有效」，
 * 因此同一瞬间发出的多个请求共用一个签名是安全的 —— 后台路径复用 5 分钟早已验证可用。
 *
 * 为什么前台也要复用：Hermes 上没有原生 WebAssembly，签名实际走 **WebView 往返**
 *（`generatePaAsync` → WebView signer），每次几十毫秒。而进房瞬间是并发的：
 * 首屏消息 + 房间元数据 + 精华消息 + 上麦扫描 同时发 4 个请求 → 旧实现要签 4 次名，
 * 全部串在同一段主线程/WebView 通信上，直接把首屏消息往后推。
 * 800ms 是很保守的窗口（同一个交互手势内），跨手势/跨轮询仍会现签。
 */
const PA_FRONT_REUSE_MS = 800;
/** 在途签名（并发合并用）：多个请求同时需要签名时只签一次 */
let paInflight: Promise<string | null> | null = null;

async function createSignedHeaders(token?: string, modern = false, patch: HeadersMap = {}) {
  const foreground = AppState.currentState === 'active';
  const ttl = foreground ? PA_FRONT_REUSE_MS : PA_CACHE_TTL_MS;
  const cached = lastPa && Date.now() - lastPaAt < ttl ? lastPa : '';
  const useCache = !!cached;
  let pa: string | null = null;
  if (useCache) {
    pa = cached;
    if (!foreground && Date.now() - lastPaCacheLogAt > 60_000) {
      lastPaCacheLogAt = Date.now();
      console.debug('[notify] [bg] 后台复用最近一次签名（WebView JS 在后台被暂停）');
    }
  } else {
    await initWasm();
    /**
     * ★ 并发合并：进房瞬间多个请求会**同时**走到这里（此时 lastPa 还是空的），
     * 旧实现各自现签一次 → WebView 上排队往返 N 次。共享同一个 in-flight Promise，
     * 一次签名供所有并发请求使用（pa 与请求体无关，见上方 PA_FRONT_REUSE_MS）。
     */
    if (!paInflight) {
      // 签名的超时同样依赖 JS setTimeout，后台会被 RN 暂停 → 用原生心跳看门狗兜底，
      // 否则一次挂起的签名会把整条后台轮询链路永久卡死。
      paInflight = raceWithWatchdog(generatePaAsync(), '签名')
        .finally(() => { paInflight = null; });
    }
    pa = await paInflight;
    if (pa) { lastPa = pa; lastPaAt = Date.now(); }
  }
  if (!pa) {
    const reason = getWasmError();
    throw new Error(reason ? `签名模块未就绪：${reason}` : '签名模块未就绪，无法请求口袋接口');
  }
  const deviceId = await ensureDeviceId();
  return {
    ...createHeaders(token, pa, modern, deviceId),
    ...patch,
  };
}

async function rawPost(url: string, data: any, options: { token?: string; modern?: boolean; headers?: HeadersMap; signed?: boolean } = {}) {
  const token = options.token ?? tokenFromStore();
  const headers = options.signed === false
    ? { ...createHeaders(token, null, !!options.modern, await ensureDeviceId()), ...(options.headers || {}) }
    : await createSignedHeaders(token, !!options.modern, options.headers || {});
  return xhrPost(url, data, headers);
}

function parsePocketJson(text: string): any {
  // 复用统一的宽松解析（超大整数补引号逻辑原在 3 处各写一份）；
  // 解析失败时 parseLooseJson 原样返回字符串，这里保持本模块既有的"包成错误对象"语义。
  const parsed = parseLooseJson(text);
  if (typeof parsed === 'string') {
    return { status: 500, success: false, message: parsed.replace(/\s+/g, ' ').slice(0, 180) };
  }
  return parsed;
}

async function signedHeaders(token?: string, modern = false, patch: HeadersMap = {}) {
  return createSignedHeaders(token ?? tokenFromStore(), modern, patch);
}

async function pocketPost(url: string, data: any, options: { tokenRequired?: boolean; modern?: boolean; headers?: HeadersMap; fallback?: string; signed?: boolean } = {}) {
  const token = options.tokenRequired === false ? tokenFromStore() : requireToken();
  const res = await rawPost(url, data, {
    token,
    modern: options.modern,
    headers: options.headers,
    signed: options.signed !== false,
  });
  return assertPocketOk(res, options.fallback);
}

async function publicMediaPost(url: string, data: any, fallback: string) {
  const res = await requestJson<any>(url, {
    method: 'POST',
    body: data,
    timeout: 15000,
    headers: {
      'app-info': JSON.stringify({
        vendor: 'google',
        deviceId: '123',
        appVersion: '6.0.0',
        appBuild: '123',
        osType: 'android',
        osVersion: '10.0.0',
        deviceName: 'pixel',
      }),
    },
  });
  return assertPocketOk(res, fallback);
}

function pushUniqueId(target: string[], value: any) {
  const text = String(value || '');
  if (!text || text === '0' || target.includes(text)) return;
  target.push(text);
}

function collectServerIdsForChannel(node: any, channelId: string, target: string[], depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectServerIdsForChannel(item, channelId, target, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;

  const nodeChannel = String(
    node.channelId
      || node.roomId
      || node.teamInfo?.channelId
      || node.teamInfo?.roomId
      || '',
  );
  if (nodeChannel === String(channelId)) {
    pushUniqueId(target, node.serverId || node.serverID || node.teamInfo?.serverId || node.teamInfo?.serverID);
  }

  Object.entries(node).forEach(([key, value]) => {
    if (String(key) === String(channelId)) pushUniqueId(target, value);
    collectServerIdsForChannel(value, channelId, target, depth + 1);
  });
}

async function resolveServerIds(channelId: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    const res = await pocketPost(`${BASE}/im/api/v1/im/team/room/info`, { channelId: String(channelId) });
    pushUniqueId(ids, res?.content?.serverId || res?.content?.teamInfo?.serverId || res?.data?.serverId || res?.serverId);
  } catch {
    // Fall through to the server map; some large rooms have stale local serverId values.
  }
  try {
    const res = await pocketPost(`${BASE}/im/api/v1/team/star/server/map/get`, {}, {
      modern: true,
      fallback: 'get room server map failed',
    });
    collectServerIdsForChannel(res, channelId, ids);
  } catch {
    // The map is a fallback only.
  }
  return ids;
}

/**
 * serverId 解析结果缓存（进程内，channelId → serverId）。
 *
 * 为什么需要（用户 2026-11-12「进入房间的速度比较慢」）：`resolveServerIds` 会**串行**打两次
 * 网络请求（`room/info` → `team/star/server/map/get`），而它只在成员库缺 serverId 时才被调用 ——
 * 偏偏这种房间每次进房都要先白等这两个串行往返，才开始请求首屏消息（以及并行的房间元数据）。
 * serverId 对同一个频道是恒定的，拿到就记住；没拿到（空串）不缓存，下次重试。
 */
const resolvedServerIdCache = new Map<string, string>();
const RESOLVED_SERVER_ID_MAX = 500;

async function resolveServerId(channelId: string): Promise<string> {
  const key = String(channelId || '');
  const hit = key ? resolvedServerIdCache.get(key) : '';
  if (hit) return hit;
  const ids = await resolveServerIds(channelId);
  const first = ids[0] || '';
  if (key && first) {
    if (resolvedServerIdCache.size > RESOLVED_SERVER_ID_MAX) resolvedServerIdCache.clear();
    resolvedServerIdCache.set(key, first);
  }
  return first;
}

function rememberServerId(channelId: string, serverId: string) {
  if (!channelId || !serverId || serverId === '0') return;
  useMemberStore.getState().updateMemberRoomIds(channelId, { serverId });
}

async function tryPocketPost(
  attempts: Array<{ url: string; payload: any; modern?: boolean; tokenRequired?: boolean; signed?: boolean; headers?: HeadersMap; label: string }>,
  fallback: string,
  /** 逐次尝试的耗时回调（性能诊断用；不传则零开销） */
  onAttempt?: (info: { label: string; ms: number; ok: boolean }) => void,
) {
  const errors: string[] = [];
  for (const attempt of attempts) {
    const at = Date.now();
    try {
      const res = await pocketPost(attempt.url, attempt.payload, {
        modern: attempt.modern,
        tokenRequired: attempt.tokenRequired,
        signed: attempt.signed,
        headers: attempt.headers,
        fallback: `${fallback}: ${attempt.label}`,
      });
      onAttempt?.({ label: attempt.label, ms: Date.now() - at, ok: true });
      return {
        ...res,
        _request: {
          label: attempt.label,
          payload: attempt.payload,
        },
      };
    } catch (error: any) {
      onAttempt?.({ label: attempt.label, ms: Date.now() - at, ok: false });
      errors.push(`${attempt.label}: ${error?.message || String(error)}`);
    }
  }
  throw new Error(errors.join('\n') || fallback);
}

function safeNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 房间消息接口的**参数形态偏好**（用户 2026-11-12「进入房间的速度比较慢」）。
 *
 * 该接口对参数类型挑剔（数字/字符串/新版头三种形态，见 getRoomMessages 的 attempts），
 * 而 `tryPocketPost` 是**串行** for 循环 —— 候选里排在前面的形态一旦不被接受，
 * 每多一种就要多付一次完整网络往返。进房链路上这就是「点进去等好几秒」。
 * 服务端挑哪种形态对所有房间是一致的，所以记住上次成功的形态并排到最前即可。
 */
const ROOM_MSG_SHAPES = ['num', 'str', 'mod'] as const;
type RoomMsgShape = (typeof ROOM_MSG_SHAPES)[number];
const roomMsgShapePref = new Map<string, RoomMsgShape>();

/** 从成功响应的 `_request.label`（`<mode> <shape> ch=… srv=…`）反查通路并记住形态 */
function rememberRoomMsgShape(res: any, urls: Array<{ url: string; mode: string }>) {
  const label = String(res?._request?.label || '');
  if (!label) return;
  const [mode, shape] = label.split(' ');
  if (!mode || !shape) return;
  if (shape !== 'num' && shape !== 'str' && shape !== 'mod') return;
  const hit = urls.find((item) => item.mode === mode);
  if (hit && roomMsgShapePref.get(hit.url) !== shape) roomMsgShapePref.set(hit.url, shape);
}

export const pocketApi = {
  initWasm,
  generatePa,
  generatePaAsync,

  async loginSendSms(mobile: string, area = '86', answer?: string) {
    const payload: any = { mobile, area };
    if (answer) payload.answer = answer;
    const data = await rawPost(`${BASE}/user/api/v1/sms/send2`, payload, { signed: false });
    if (data.status === 200 || data.success) return { success: true };
    if (data.status === 2001) {
      try {
        const verificationData = JSON.parse(data.message);
        return {
          success: false,
          needVerification: true,
          question: verificationData.question,
          options: verificationData.answer,
        };
      } catch {
        return { success: false, msg: data.message || '需要安全验证' };
      }
    }
    return { success: false, msg: responseMessage(data, '验证码发送失败') };
  },

  async loginByCode(mobile: string, code: string) {
    const res = await rawPost(`${BASE}/user/api/v1/login/app/mobile/code`, { mobile, code }, { token: '', signed: true });
    return assertPocketOk(res, '登录失败');
  },

  async loginCheckToken() {
    return pocketPost(`${BASE}/user/api/v1/user/info/reload`, { from: 'appstart' }, { fallback: 'Token 无效' });
  },

  /** 删除（撤回）自己在成员房间大/小房间发送的消息（官方 im/api/v1/team/msg/delete） */
  async deleteTeamMsg(params: { accId: string; msgIdClient: string; channelId: string; msgTime: number }) {
    return pocketPost(
      `${BASE}/im/api/v1/team/msg/delete`,
      {
        accId: String(params.accId || ''),
        msgIdClient: String(params.msgIdClient || ''),
        channelId: String(params.channelId || ''),
        msgTime: Number(params.msgTime) || 0,
      },
      { fallback: '删除消息失败' },
    );
  },

  async editUserInfo(params: { key?: string; value?: string; nickName?: string; avatar?: string }) {
    const changes: Array<{ key: string; value: string }> = [];
    if (params.key) {
      changes.push({ key: String(params.key), value: String(params.value ?? '') });
    } else {
      if (params.nickName?.trim()) changes.push({ key: 'nickname', value: params.nickName.trim() });
      if (params.avatar?.trim()) changes.push({ key: 'avatar', value: params.avatar.trim() });
    }
    if (!changes.length) throw new Error('缺少修改字段');

    const results = [];
    for (const change of changes) {
      const res = await pocketPost(`${BASE}/user/api/v1/user/info/edit`, change, {
        modern: true,
        fallback: '修改资料失败',
      });
      results.push(res);
    }
    return results[results.length - 1];
  },

  async getUserRenameCount() {
    return pocketPost(`${BASE}/user/api/v1/user/rename/count`, {}, {
      modern: true,
      fallback: '获取改名次数失败',
    });
  },

  async uploadUserAvatar(params: { uri: string; fileName?: string; mimeType?: string }) {
    const token = requireToken();
    const headers = await signedHeaders(token, true);
    delete headers['Content-Type'];
    delete headers.Host;
    const mimeType = params.mimeType || 'image/jpeg';
    const fileName = params.fileName || `avatar-${Date.now()}.${mimeType.includes('png') ? 'png' : 'jpg'}`;
    const formData = new FormData();
    formData.append('fromType', 'avatar');
    formData.append('file', {
      uri: params.uri,
      name: fileName,
      type: mimeType,
    } as any);
    // FormData 上传无法走 requestJson（其会 JSON.stringify body），这里保留 fetch 但补超时取消，防无限挂起
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await fetch('https://pfile.48.cn/filesystem/upload/image', {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });
    } catch (error: any) {
      throw new Error(error?.name === 'AbortError' ? '上传头像超时' : '上传头像网络失败');
    } finally {
      clearTimeout(timer);
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json().catch(() => null) : null;
    if (response.ok && data && (data.status === 200 || data.success)) {
      const item = Array.isArray(data.content) ? data.content[0] : data.content;
      const path = item?.path || item?.url || item?.filePath || '';
      if (!path) throw new Error('上传头像成功但没有返回图片路径');
      return { success: true, content: item, path };
    }
    const source = data || response;
    throw new Error((source as any)?.message || (source as any)?.msg || `上传失败 HTTP ${response.status}`);
  },

  async checkIn() {
    const res = await rawPost(`${BASE}/user/api/v1/checkin`, {}, {
      token: requireToken(),
      modern: true,
      headers: { 'P-Sign-Type': 'V0' },
      signed: true,
    });
    if (responseOk(res)) return res;
    const message = responseMessage(res, '签到失败');
    if (ALREADY_CHECKED_MESSAGE_RE.test(message)) {
      return { success: true, status: res?.status ?? res?.code ?? 200, message, content: res?.content || null, alreadyChecked: true };
    }
    throw new Error(res?.status !== undefined || res?.code !== undefined ? `${message} (${res?.status ?? res?.code})` : message);
  },

  async getCheckinToday() {
    return pocketPost(`${BASE}/user/api/v1/checkin/check/today`, {}, {
      modern: true,
      fallback: '获取今日签到状态失败',
    });
  },

  async getNimLoginInfo() {
    // E1：优先走桌面 v2.11 同款新通道 im/api/v1/im/userinfo（P-Sign-Type V0）——
    // 官方云信凭证新接口，返回 content.accid/accId/imUserId + pwd/token/imPwd + userId；
    // 失败再回退旧路径（user/info/reload / user/info/home）多路兜底，防旧接口下线后私信/签到失效。
    try {
      const res = await pocketPost(`${BASE}/im/api/v1/im/userinfo`, {}, {
        headers: createCheckinHeaders(),
        fallback: '获取云信凭证失败',
      });
      if (res?.content) return res;
    } catch {
      /* 落到旧多路兜底 */
    }
    return tryPocketPost([
      {
        url: `${BASE}/user/api/v1/user/info/reload`,
        payload: { from: 'appstart' },
        modern: true,
        label: 'reload modern',
      },
      {
        url: `${BASE}/user/api/v1/user/info/reload`,
        payload: { from: 'appstart' },
        label: 'reload legacy',
      },
      {
        url: `${BASE}/user/api/v1/user/info/home`,
        payload: {},
        modern: true,
        label: 'info home modern',
      },
      {
        url: `${BASE}/user/api/v1/user/info/home`,
        payload: {},
        label: 'info home legacy',
      },
    ], 'get self user info failed');
  },

  async getUserProfile(userId: string) {
    const id = Number(String(userId || '').trim());
    if (!Number.isFinite(id) || id <= 0) throw new Error('missing userId');
    // 桌面端（pocket-service.fetchUserHomeInfo）已验证可用的写法：
    //   POST /user/api/v1/user/info/home  body { userId: <number> }  + **Android 头**
    // 之前移动端用 iOS/modern 头 + 字符串 userId 依次试 info/detail/home，服务端全部
    // 返回「No message available」（404）→ 资料卡只显示出错文本（用户反馈加载不出来）。
    return tryPocketPost([
      {
        url: `${BASE}/user/api/v1/user/info/home`,
        payload: { userId: id },
        headers: createPocketAndroidHeaders(),
        label: 'user home',
      },
      {
        url: `${BASE}/user/api/v1/user/info/home`,
        payload: { userId: id },
        modern: true,
        label: 'user home(ios)',
      },
      {
        url: `${BASE}/user/api/v1/user/info`,
        payload: { userId: id },
        label: 'user info',
      },
    ], 'get user profile failed');
  },

  async switchBigSmall(targetUserId: string) {
    return pocketPost(`${BASE}/user/api/v1/bigsmall/switch/user`, { toUserId: String(targetUserId) }, { fallback: '切换账号失败' });
  },

  async getStarServerMap() {
    return pocketPost(`${BASE}/im/api/v1/team/star/server/map/get`, {}, {
      modern: true,
      fallback: '获取成员房间映射失败',
    });
  },

  async getUserMoney() {
    return pocketPost(`${BASE}/user/api/v1/user/money`, {}, { fallback: '获取余额失败' });
  },

  async getGroupTeamStar(payload?: any) {
    return pocketPost(`${BASE}/user/api/v1/client/update/group_team_star`, payload || {}, {
      modern: true,
      tokenRequired: false,
      fallback: '获取官方成员列表失败',
    });
  },

  async getFollowedIds() {
    return pocketPost(`${BASE}/user/api/v1/friendships/friends/id`, {}, { fallback: '获取关注房间失败' });
  },

  async followMember(memberId: string) {
    // 对齐桌面端 pocket-runtime.followMember：v2/friendships/friends/add + { toSourceId:<number>, toType:1 }
    // + **P-Sign-Type: V0** 头（createFriendshipHeaders 同款），否则可能被判签名类型不符
    return pocketPost(`${BASE}/user/api/v2/friendships/friends/add`, { toSourceId: safeNumber(memberId), toType: 1 }, { headers: createCheckinHeaders(), fallback: '关注失败' });
  },

  async unfollowMember(memberId: string) {
    return pocketPost(`${BASE}/user/api/v2/friendships/friends/remove`, { toSourceId: safeNumber(memberId), toType: 1 }, { headers: createCheckinHeaders(), fallback: '取消关注失败' });
  },

  async getLastMessages(serverIdList: number[]) {
    return pocketPost(`${BASE}/im/api/v1/team/classic/last/message/get`, {
      serverIdList: serverIdList.map(Number).filter((item) => Number.isFinite(item) && item > 0),
    }, { fallback: '获取最新消息失败' });
  },

  async getRoomMessages(params: { channelId: string; serverId: string; nextTime?: number; fetchAll?: boolean; limit?: number; fallbackChannelId?: string }) {
    const channelId = String(params.channelId || '');
    const fallbackCid = params.fallbackChannelId ? String(params.fallbackChannelId) : '';
    const originalServerId = String(params.serverId || '');
    if (!channelId) throw new Error('missing channelId');
    // v2.4.2 logic: resolve serverId when original is empty, and remember it
    const resolvedServerId = (originalServerId && originalServerId !== '0') ? '' : await resolveServerId(channelId);
    const serverIds = [originalServerId, resolvedServerId]
      .map((item) => String(item || ''))
      .filter((item, index, arr) => item && item !== '0' && arr.indexOf(item) === index);
    if (serverIds.length) rememberServerId(channelId, serverIds[0]);

    const urls = params.fetchAll
      ? [
        { url: `${BASE}/im/api/v1/team/message/list/all`, mode: 'all' },
        { url: `${BASE}/im/api/v1/team/message/list/homeowner`, mode: 'owner-fallback' },
      ]
      : [{ url: `${BASE}/im/api/v1/team/message/list/homeowner`, mode: 'owner' }];
    const attempts: Array<{ url: string; payload: any; modern?: boolean; signed?: boolean; label: string }> = [];
    const limit = params.limit || 100;
    const next = params.nextTime || 0;
    // Try both channelId and fallbackChannelId
    const cids = [channelId, ...(fallbackCid && fallbackCid !== channelId ? [fallbackCid] : [])];
    for (const cid of cids) {
      const svrs = cid === channelId ? serverIds : [params.serverId || ''].filter(s => s && s !== '0');
      for (const serverId of svrs.length ? svrs : ['']) {
        const sid = String(serverId || '');
        if (!sid || sid === '0') continue;
        for (const entry of urls) {
          /**
           * ★ 参数形态**记忆化**（用户 2026-11-12「进入房间的速度比较慢」）：
           * 三种形态（num 数字/str 字符串/mod 新版头）是**串行**尝试的，
           * 而这里还会再乘 cid × serverId —— 最坏 12 个候选全部串行打完才报错/命中。
           * 服务端挑哪种形态对所有房间是一致的，记住上次成功的那种并排到最前，
           * 正常情况第一次就命中（进房少等 1~N 个 RTT）。
           */
          const pref = roomMsgShapePref.get(entry.url) || 'num';
          const shapes = [pref, ...ROOM_MSG_SHAPES.filter((s) => s !== pref)];
          for (const shape of shapes) {
            if (shape === 'num') {
              attempts.push({
                url: entry.url,
                payload: { channelId: safeNumber(cid), serverId: safeNumber(sid), nextTime: next, limit },
                label: `${entry.mode} num ch=${cid} srv=${sid}`,
              });
            } else if (shape === 'str') {
              attempts.push({
                url: entry.url,
                payload: { channelId: String(cid), serverId: String(sid), nextTime: next, limit },
                label: `${entry.mode} str ch=${cid} srv=${sid}`,
              });
            } else {
              attempts.push({
                url: entry.url,
                payload: { channelId: safeNumber(cid), serverId: safeNumber(sid), nextTime: next, limit },
                modern: true,
                label: `${entry.mode} mod ch=${cid} srv=${sid}`,
              });
            }
          }
        }
      }
    }
    if (!attempts.length) throw new Error('missing serverId');
    /**
     * 首屏（nextTime=0 且 limit≥50）打一条耗时诊断（tag room）：
     * 「尝试=1/12」= 一次命中（理想）；「尝试=3/12 [num:860ms× str:420ms]」= 形态不对在串行回退，
     * 那才是进房等 1 秒以上的元凶。轮询/上拉不打，避免刷日志。
     */
    const firstScreen = next === 0 && limit >= 50;
    const reqAt = Date.now();
    const trace: string[] = [];
    const res: any = await tryPocketPost(attempts, 'get room messages failed', firstScreen
      ? (info) => {
        if (trace.length < 6) {
          const [mode, shape] = info.label.split(' ');
          trace.push(`${mode}/${shape}:${info.ms}ms${info.ok ? '' : '×'}`);
        }
      }
      : undefined);
    if (firstScreen) {
      logInfo(
        `[room.net] 首屏消息 ${Date.now() - reqAt}ms 尝试=${trace.length}/${attempts.length}`
        + ` ch=${channelId} srv=${serverIds[0] || '-'}`
        // 实际命中的频道：与本侧不同 = 服务端回退到了 fallbackChannelId（大小房间串味的判据）
        + ` 实际ch=${String((res as any)?._request?.payload?.channelId ?? '-')}`
        + ` [${trace.join(' ')}]`,
        'room',
      );
    }
    rememberRoomMsgShape(res, urls);
    return res;
  },

  /**
   * 解析房间的圈组 serverId（房间消息通道必需）。
   *
   * 房间消息历史接口在 serverId 为空时会内部兜底解析并写回成员库，但**发送**必须显式拿到
   * serverId —— 为空会直接变成 0，云信圈组返回 414「参数错误」。这里把兜底逻辑暴露出来，
   * 供发送前调用。
   */
  async resolveRoomServerId(channelId: string | number): Promise<string> {
    const cid = String(channelId || '');
    if (!cid) return '';
    try {
      const sid = await resolveServerId(cid);
      if (sid && sid !== '0') {
        rememberServerId(cid, sid);
        return sid;
      }
    } catch {
      /* 解析失败返回空串，由调用方提示 */
    }
    return '';
  },

  async getRoomInfo(channelId: string) {    return pocketPost(`${BASE}/im/api/v1/im/team/room/info`, { channelId: String(channelId) }, { tokenRequired: false, fallback: '获取房间信息失败' });
  },

  /**
   * 房间精华消息 = 偶像/房主在官方客户端置顶的消息（不是用户自己置顶）。
   * 对齐桌面端 yk1z/yaya_msg 的 fetchRoomEssenceMessages / `fetch-room-essence-messages` 通道：
   *   POST /im/api/v1/team/essence/message/list
   *   返回 content.essenceMessageList，元素与普通房间消息同构（bodys/msgType/extInfo/msgTime …）。
   * 与 getRoomMessages 一样准备数字/字符串/新版头三种尝试，接口对参数类型挑剔时自动兜底。
   */
  async getRoomEssenceMessages(channelId: string | number, serverId: string | number, nextTime = 0, limit = 50) {
    const cid = String(channelId || '');
    if (!cid) throw new Error('missing channelId');
    let sid = String(serverId || '');
    if (!sid || sid === '0') sid = await resolveServerId(cid);
    if (!sid || sid === '0') throw new Error('missing serverId');
    const url = `${BASE}/im/api/v1/team/essence/message/list`;
    // 与 getRoomMessages 同一套形态记忆（见 ROOM_MSG_SHAPES）：进房时它与首屏消息**并行**发出，
    // 若每次都从 num 开始串行试三种形态，会白占一轮网络、拖慢并行的消息请求。
    const pref = roomMsgShapePref.get(url) || 'num';
    const shapes = [pref, ...ROOM_MSG_SHAPES.filter((s) => s !== pref)];
    const attempts = shapes.map((shape) => (
      shape === 'str'
        ? { url, payload: { channelId: cid, serverId: sid, nextTime, limit }, label: 'essence str' }
        : shape === 'mod'
          ? { url, payload: { channelId: safeNumber(cid), serverId: safeNumber(sid), nextTime, limit }, modern: true, label: 'essence mod' }
          : { url, payload: { channelId: safeNumber(cid), serverId: safeNumber(sid), nextTime, limit }, label: 'essence num' }
    ));
    const res: any = await tryPocketPost(attempts, 'get room essence messages failed');
    const shape = String(res?._request?.label || '').split(' ')[1];
    if (shape === 'num' || shape === 'str' || shape === 'mod') roomMsgShapePref.set(url, shape);
    return res;
  },

  /** 解析房间信息（大/小房间通用）：
   *  1) room/info → content.channelInfo（单数，FollowedRooms 同款字段）
   *  2) 小房间（yklzId）实测 room/info 返回 2001 无权限 → 回退【塞纳河接口】
   *     im/api/seine/server/detail（seine48 头）：返回 channelInfoList（大/小房间 channelId+channelName）
   *     + chatServerInfo.serverBgWallImg（背景墙图）+ serverName。
   *  serverId 必须传入（成员数据里有），否则无法走塞纳河兜底。 */
  async getRoomMeta(channelId: string | number, fallbackChannelId?: string | number, serverId?: string | number) {
    const cid = String(channelId);
    /** 进房耗时诊断（tag room）：这条与首屏消息并行，看它是不是反而成了「背景迟迟不出」的那个 */
    const metaAt = Date.now();
    let usesSeine = false;
// 传入 serverId 为空时（成员数据缺 serverId）自动解析，否则无法走塞纳河兜底 → name/bg 全空。
    // 复刻 getRoomMessages 的 v2.4.2 逻辑：resolveServerId 从 room/info 的 content.serverId 提取并写回 store。
    let resolvedSid = serverId;
    if (!resolvedSid || String(resolvedSid) === '0' || String(resolvedSid) === '') {
      try {
        const s = await resolveServerId(cid);
        if (s && s !== '0') { resolvedSid = s; rememberServerId(cid, s); }
      } catch { /* 解析失败保持空，下方兜底流程自然跳过塞纳河 */ }
    }
    // 背景字段候选链（对齐桌面 _ref_yk1z normalizeFollowedSourceUrl 的消费端）：
    // bgImg|bgImgUrl|backgroundImg|backgroundImgUrl|backImg|backImgUrl|homeBgImg|homeBgImgUrl|bannerUrl
    const pickBg = (o: any): string => {
      if (!o) return '';
      return String(
        o.bgImg || o.bgImgUrl || o.backgroundImg || o.backgroundImgUrl
        || o.backImg || o.backImgUrl || o.homeBgImg || o.homeBgImgUrl
        || o.bannerUrl || o.serverBgWallImg || ''
      );
    };
    const tryRoomInfo = async (target: string): Promise<{ name: string; bg: string }> => {
      const res = await this.getRoomInfo(target).catch(() => null);
      const content = (res as any)?.content || (res as any)?.data || {};
      if ((res as any)?.status && Number((res as any)?.status) !== 200) return { name: '', bg: '' };
      const ci = content.channelInfo || {};
      let name = String(ci.channelName || '');
      let bg = pickBg(ci);
      if (!name && Array.isArray(content.channelInfoList)) {
        const hit = content.channelInfoList.find((c: any) => String(c?.channelId) === target);
        if (hit) {
          name = String(hit.channelName || '');
          bg = pickBg(hit);
        }
      }
      if (!bg) bg = pickBg(content.userChatConfig || {});
      if (!bg && Array.isArray(content.channelInfoList)) {
        const anyHit = content.channelInfoList.find((c: any) => String(c?.channelId) === target);
        if (anyHit) bg = pickBg(anyHit);
      }
      return { name, bg: bg ? normalizeUrl(bg) : '' };
    };
    let meta = await tryRoomInfo(cid);
    // 兜底补位（对齐桌面）：房间有名字但缺背景 → 塞纳河 server/detail 的 channelInfoList/chatServerInfo 补背景
    if ((!meta.bg || (!meta.name && !meta.bg)) && resolvedSid !== undefined && resolvedSid !== null && String(resolvedSid) !== '' && String(resolvedSid) !== '0') {
      try {
        usesSeine = true;
        const res = await this.getSeineServerDetail(Number(resolvedSid)).catch(() => null);
        const content = (res as any)?.content || (res as any)?.data || {};
        const list = Array.isArray(content.channelInfoList) ? content.channelInfoList : [];
        const hit = list.find((c: any) => String(c?.channelId) === cid)
          || (fallbackChannelId !== undefined && fallbackChannelId !== null ? list.find((c: any) => String(c?.channelId) === String(fallbackChannelId)) : undefined);
        const si = content.chatServerInfo || {};
        const bg = meta.bg || pickBg(hit) || pickBg(si);
        if (hit || bg) {
          meta = {
            name: meta.name || (hit ? String(hit.channelName || '') : ''),
            bg: bg ? normalizeUrl(String(bg)) : meta.bg || '',
          };
        }
      } catch { /* 塞纳河兜底失败忽略 */ }
    }
    // 最终兜底：回退同成员大房间背景
    if (!meta.name && !meta.bg && fallbackChannelId !== undefined && fallbackChannelId !== null && String(fallbackChannelId) !== cid) {
      const fb = await tryRoomInfo(String(fallbackChannelId)).catch(() => ({ name: '', bg: '' }));
if (fb.bg) meta = { name: meta.name || fb.name, bg: fb.bg };
    }
    logInfo(
      `[room.net] 房间元数据 ${Date.now() - metaAt}ms ch=${cid}`
      + ` name=${meta.name ? 1 : 0} bg=${meta.bg ? 1 : 0} 塞纳河兜底=${usesSeine ? 1 : 0}`,
      'room',
    );
    return meta;
  },

  async getRoomAlbum(params: { channelId: string; nextTime?: number }) {
    return pocketPost(`${BASE}/im/api/v1/team/msg/list/img`, {
      channelId: String(params.channelId),
      nextTime: params.nextTime || 0,
    }, { fallback: '获取房间相册失败' });
  },

  async getOfficialTalkList(params: { ctime?: number; groupId?: number; limit?: number } = {}) {
    return publicMediaPost(`${BASE}/media/api/media/v1/talk/list`, {
      ctime: params.ctime || 0,
      groupId: params.groupId ?? 0,
      limit: params.limit || 20,
    }, 'get talk list failed');
  },

  async getOfficialTalk(talkId: string) {
    return publicMediaPost(`${BASE}/media/api/media/v1/talk`, {
      resId: String(talkId),
    }, 'get talk audio failed');
  },

  async getOfficialMusicList(params: { ctime?: number; limit?: number } = {}) {
    return publicMediaPost(`${BASE}/media/api/media/v1/music/list`, {
      ctime: params.ctime || 0,
      limit: params.limit || 20,
    }, 'get music list failed');
  },

  async getOfficialMusic(musicId: string) {
    return publicMediaPost(`${BASE}/media/api/media/v1/music`, {
      resId: String(musicId),
    }, 'get music url failed');
  },

  async getOfficialVideoList(params: { ctime?: number; typeId?: number; groupId?: number; limit?: number } = {}) {
    return publicMediaPost(`${BASE}/media/api/media/v1/video/list`, {
      ctime: params.ctime || 0,
      typeId: params.typeId ?? 0,
      groupId: params.groupId ?? 0,
      limit: params.limit || 20,
    }, 'get video list failed');
  },

  async getOfficialVideo(videoId: string) {
    return publicMediaPost(`${BASE}/media/api/media/v1/video`, {
      resId: String(videoId),
    }, 'get video url failed');
  },

  async getPrivateMessageList(lastTime?: number) {
    return pocketPost(`${BASE}/message/api/v1/user/message/list`, {
      lastTime: Number(lastTime) || Date.now(),
    }, { modern: true, fallback: '获取私信列表失败' });
  },

  async getPrivateMessageDetail(targetUserId: string, lastTime = 0) {
    return pocketPost(`${BASE}/message/api/v1/user/message/info`, {
      lastTime: Number(lastTime) || 0,
      targetUserId: String(targetUserId),
    }, { modern: true, fallback: '获取私信详情失败' });
  },

  async sendPrivateMessageReply(targetUserId: string, text: string) {
    return pocketPost(`${BASE}/message/api/v1/user/message/reply`, {
      messageType: 'TEXT',
      text: String(text),
      targetUserId: String(targetUserId),
    }, { modern: true, fallback: '发送私信失败' });
  },

  async getFlipList(beginLimit = 0, limit = 20) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v1/user/question/list`, {
      status: 0,
      beginLimit,
      limit,
      memberId: '',
    }, { fallback: '获取翻牌记录失败' });
  },

  async getFlipPrices(memberId: string) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v2/custom/index`, {
      memberId: String(memberId),
    }, { fallback: '获取翻牌类型失败' });
  },

  async sendFlipQuestion(payload: any) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v1/user/question`, payload, { fallback: '发送翻牌失败' });
  },

  async operateFlipQuestion(questionId: string, operateType = 1) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v1/user/question/operate`, {
      questionId: String(questionId),
      operateType,
    }, { fallback: '操作翻牌失败' });
  },

  async getStarArchives(memberId: number) {
    return pocketPost(`${BASE}/user/api/v1/user/star/archives`, { memberId: Number(memberId) }, { tokenRequired: false, fallback: '获取成员档案失败' });
  },

  async getStarHistory(memberId: number) {
    return pocketPost(`${BASE}/user/api/v1/user/star/history`, {
      memberId: Number(memberId),
      limit: 100,
      lastTime: 0,
    }, { tokenRequired: false, fallback: '获取成员历史失败' });
  },

  async getOpenLive(params: { memberId: string; nextTime?: number }) {
    const memberId = String(params.memberId || '');
    if (!memberId) throw new Error('missing memberId');
    return tryPocketPost([
      { url: `${BASE}/im/api/v1/chatroom/msg/list/aim/type`, payload: { extMsgType: 'OPEN_LIVE', roomId: '', ownerId: memberId, nextTime: Number(params.nextTime) || 0 }, label: 'openlive' },
      { url: `${BASE}/im/api/v1/chatroom/msg/list/aim/type`, payload: { extMsgType: 'OPEN_LIVE', roomId: '', ownerId: memberId, nextTime: Number(params.nextTime) || 0 }, signed: false, label: 'openlive unsigned' },
    ], '获取成员公演失败');
  },

  async getOpenLiveOne(liveId: string) {
    const id = String(liveId);
    return tryPocketPost([
      // v2.7.3 语义：默认请求即返回 rtmp（与桌面/官方一致的原始流）
      {
        url: `${BASE}/live/api/v1/live/getOpenLiveOne`,
        payload: { liveId: id },
        tokenRequired: false,
        label: 'open live one',
      },
      {
        url: `${BASE}/live/api/v1/live/getOpenLiveOne`,
        payload: { liveId: id, streamProtocol: 'FLV' },
        tokenRequired: false,
        label: 'open live one flv',
      },
      {
        url: `${BASE}/live/api/v1/live/getOpenLiveOne`,
        payload: { liveId: id, streamProtocol: 'HLS' },
        tokenRequired: false,
        label: 'open live one hls',
      },
    ], '获取公演详情失败');
  },

  async getLiveOne(liveId: string) {
    const id = String(liveId);
    return tryPocketPost([
      // v2.7.3 语义：默认请求即返回 rtmp（与桌面/官方一致的原始流）
      {
        url: `${BASE}/live/api/v1/live/getLiveOne`,
        payload: { liveId: id },
        tokenRequired: false,
        label: 'live one',
      },
      {
        url: `${BASE}/live/api/v1/live/getLiveOne`,
        payload: { liveId: id, streamProtocol: 'FLV' },
        tokenRequired: false,
        label: 'live one flv',
      },
      {
        url: `${BASE}/live/api/v1/live/getLiveOne`,
        payload: { liveId: id, streamProtocol: 'HLS' },
        tokenRequired: false,
        label: 'live one hls',
      },
    ], '获取直播详情失败');
  },

  /**
   * 直播弹幕（实时）用的云信聊天室坐标。
   *
   * 官方 7.1.39 直播弹幕走云信聊天室，房间号 = getLiveOne 的 content.roomId
   * （LivePlayActivity 里 `m58828(live.getRoomId(), liveId)`），sourceId = liveId。
   * 这里一次取齐，避免调用方再解析一遍返回结构。
   */
  async getLiveChatroom(liveId: string): Promise<{ roomId: string; sourceId: string; title: string } | null> {
    const id = String(liveId || '');
    if (!id) return null;
    try {
      const res = await pocketApi.getLiveOne(id);
      const content = (res && (res.content || res.data)) || {};
      const roomId = String(content.roomId || content.chatroomId || content.chatRoomId || '');
      if (!roomId) return null;
      return {
        roomId,
        sourceId: id,
        title: String(content.title || content.liveTitle || ''),
      };
    } catch {
      return null;
    }
  },

  /**
   * 获取直播间弹幕（录播回放）。接口失败/无数据返回空数组，绝不抛错，
   * 保证弹幕只是「锦上添花」，不会拖垮播放。
   */
  async getLiveBarrage(liveId: string): Promise<Array<{ messageId: string; content: string; color: string; time: number; user: string }>> {
    const id = String(liveId || '');
    if (!id) return [];
    try {
      const res = await tryPocketPost([
        { url: `${BASE}/live/api/v1/live/barrage/list`, payload: { liveId: id, time: 0 }, tokenRequired: false, label: 'barrage' },
        { url: `${BASE}/live/api/v1/live/barrage/list`, payload: { liveId: id, lastTime: 0 }, tokenRequired: false, label: 'barrage lastTime' },
      ], '获取弹幕失败');
      const infos = unwrapList(res, [
        'content.barrageInfos',
        'content.list',
        'content.data',
        'barrageInfos',
        'data.barrageInfos',
        'list',
      ]);
      return infos.map((b: any) => ({
        messageId: String(b.messageId || b.id || ''),
        content: String(b.content || b.msg || b.text || ''),
        color: String(b.color || ''),
        time: Number(b.time || b.t || 0) || 0,
        user: String(b.user || b.nickName || b.userName || b.name || ''),
      }));
    } catch {
      return [];
    }
  },

  /**
   * 获取录播弹幕的 LRC 文本。
   * 关键：录播弹幕不在 barrage/list，而在 getLiveOne 返回的 content.msgFilePath（或 lrcUrl）
   * 指向的 LRC 文件（纯文本，格式 [hh:mm:ss.fff]昵称\t内容）。参考 pocket48_lite 实现。
   * 拉到 LRC 文本后由 parseDanmaku 解析（已支持该格式）。
   * 失败/无数据返回 null，弹幕只是锦上添花，绝不拖垮播放。
   */
  async getLiveLrc(liveId: string): Promise<string | null> {
    const id = String(liveId || '');
    if (!id) return null;
    try {
      const one: any = await pocketApi.getLiveOne(id);
      const content = (one && one.content) || one || {};
      const lrcUrl: string = content.msgFilePath || content.lrcUrl || '';
      if (!lrcUrl) return null;
      const url = /^https?:\/\//i.test(lrcUrl)
        ? lrcUrl
        : `${BASE}${lrcUrl.startsWith('/') ? '' : '/'}${lrcUrl}`;
      const res = await fetchWithTimeout(url, {}, 10000);
      if (!res.ok) return null;
      const text = await res.text();
      return text && text.trim() ? text : null;
    } catch {
      return null;
    }
  },

  async getOpenLivePublicList(params: { groupId?: number; next?: number; record?: boolean }) {
    return pocketPost(`${BASE}/live/api/v1/live/getOpenLiveList`, {
      groupId: params.groupId ?? 0,
      debug: false,
      next: params.next ?? 0,
      record: !!params.record,
    }, { tokenRequired: false, fallback: '获取公演列表失败' });
  },

  async getMemberPhotos(memberId: string, page = 0, size = 20) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v1/user/nft/user_nft_list`, {
      starId: safeNumber(memberId),
      size,
      page,
    }, { tokenRequired: false, fallback: '获取个人相册失败' });
  },

  async getLiveList(params: { groupId?: number; liveType?: number; page?: number; record?: boolean; debug?: boolean; next?: number; size?: number; userId?: number | string }) {
    const payload: any = {
      groupId: params.groupId ?? 0,
      debug: params.debug ?? false,
      liveType: params.liveType ?? 0,
      next: params.next ?? 0,
      record: params.record ?? false,
    };
    // 按成员（userId）服务端直查：桌面基线 fetchLiveList / 48tools requestLiveList 均透传 userId，
    // 服务端原生支持按成员过滤直播/录播，避免「全量加载全局列表再前端筛选」导致的历史数据缺失。
    // 注意官方坑：next=0 时带 userId 查不到数据，首次查询需先取列表最新 liveId 作为 next（调用方处理）。
    if (params.userId !== undefined && params.userId !== null && params.userId !== '') {
      payload.userId = Number(params.userId) || String(params.userId);
    }
    if (params.page !== undefined) payload.page = params.page;
    if (params.size !== undefined) payload.size = params.size;
    return pocketPost(`${BASE}/live/api/v1/live/getLiveList`, payload, { tokenRequired: false, fallback: '获取直播列表失败' });
  },

  /** 服务端搜索（房间/成员/话题，48tools 同款 im/server/search）：返回 content.serverApiList[]，
   *  每项含 serverId/serverName/serverIcon/serverOwner/followStatus。需登录 token。 */
  async serverSearch(searchContent: string) {
    return pocketPost(`${BASE}/im/api/v1/im/server/search`, { searchContent: String(searchContent || '').trim() }, { fallback: '搜索失败' });
  },

  /** 服务端跳转：由 starId 获取 serverId/channelId（进入房间/会话定位用，48tools 同款 im/server/jump） */
  async serverJump(starId: number | string) {
    return pocketPost(`${BASE}/im/api/v1/im/server/jump`, { starId: Number(starId), targetType: 1 }, { fallback: '获取房间信息失败' });
  },

  async operateRoomVoice(params: { channelId: string; serverId: string }) {
    const channelId = String(params.channelId || '');
    let serverId = String(params.serverId || '');
    if (!serverId || serverId === '0') serverId = await resolveServerId(channelId);
    rememberServerId(channelId, serverId);
    return pocketPost(`${BASE}/im/api/v1/team/voice/operate`, {
      channelId: safeNumber(channelId),
      serverId: safeNumber(serverId),
      operateCode: 2,
    }, { fallback: '获取房间电台失败' });
  },

  async sendGift(params: { giftId: string; liveId: string; acceptUserId: string; giftNum?: number }) {
    return pocketPost(`${BASE}/gift/api/v1/gift/send`, {
      giftId: String(params.giftId),
      businessId: String(params.liveId),
      acceptUserId: String(params.acceptUserId),
      giftNum: Number(params.giftNum) || 1,
      isPocketGift: 0,
      businessCode: 0,
      zip: 0,
      isCombo: 0,
      ruleId: 0,
      giftType: 1,
      crm: `${Date.now()}${Math.random().toString().slice(2)}`,
    }, { modern: true, fallback: '送礼失败' });
  },

  async getGiftList(liveId: string) {
    return pocketPost(`${BASE}/gift/api/v1/gift/list`, {
      businessId: String(liveId),
      giftType: 1,
    }, { fallback: '获取礼物列表失败' });
  },

  async getLiveRank(liveId: string) {
    return pocketPost(`${BASE}/live/api/v2/live/getLiveRank`, {
      type: 1,
      liveId: String(liveId),
    }, { fallback: '获取直播榜单失败' });
  },

  // --- v2.6 New APIs ---

  async getLiveResult(liveId: string) {
    return pocketPost(`${BASE}/live/api/v1/live/result`, {
      liveId: String(liveId),
    }, { tokenRequired: false, fallback: '获取直播结果失败' });
  },

  async getTripList(params: { groupId?: number; memberId?: string; userId?: string; lastTime?: string; isMore?: boolean } = {}) {
    const payload: any = {
      lastTime: String(params.lastTime || '0'),
      groupId: Number(params.groupId) || 0,
      isMore: !!params.isMore,
    };
    if (params.memberId) payload.memberId = String(params.memberId);
    if (params.userId) payload.userId = String(params.userId);
    return pocketPost(`${BASE}/trip/api/trip/v1/list`, payload, { fallback: '获取行程失败' });
  },

  async getMeleeWeekRank(rankId: number, nextId?: string) {
    const payload: any = { rankId: Number(rankId) || 0 };
    if (nextId) payload.nextId = nextId;
    return pocketPost(`${BASE}/gift/api/v1/melee/rank/getMeleeWeekRank`, payload, { fallback: '获取乱斗周榜失败' });
  },

  async getMeleeRankPage(rankId?: number, nextId?: string) {
    const payload: any = {};
    if (rankId !== undefined && rankId !== null) payload.rankid = Number(rankId) || 0;
    if (nextId) payload.nextId = nextId;
    return pocketPost(`${BASE}/gift/api/v1/melee/rank/getMeleeRankPage`, payload, { fallback: '获取乱斗榜单失败' });
  },

  async getMeleeYearRankPage(rankId?: number, nextId?: string) {
    const payload: any = {};
    if (rankId !== undefined && rankId !== null) payload.rankid = Number(rankId) || 0;
    if (nextId) payload.nextId = nextId;
    return pocketPost(`${BASE}/gift/api/v1/melee/rank/getMeleeYearRankPage`, payload, { fallback: '获取乱斗年榜失败' });
  },

  async getPersonMeleeRankPage(resId: number) {
    return pocketPost(`${BASE}/gift/api/v1/melee/rank/getPersonMeleeRankPage`, {
      resId: Number(resId) || 0,
    }, { fallback: '获取成员鸡腿贡献榜失败' });
  },

  async getMemberDynamic(params: { ownerId: string; nextTime?: number; roomId?: string }) {
    return pocketPost(`${BASE}/im/api/v1/chatroom/msg/list/aim/type`, {
      extMsgType: 'POST_INFO',
      roomId: String(params.roomId || ''),
      ownerId: String(params.ownerId),
      nextTime: Number(params.nextTime) || 0,
    }, { fallback: '获取成员动态失败', headers: createWeiboHeaders(requireToken()) });
  },

  async getMemberWeibo(params: { ownerId: string; nextTime?: number; roomId?: string }) {
    return pocketPost(`${BASE}/im/api/v1/chatroom/msg/list/aim/type`, {
      extMsgType: 'WEI_BO',
      roomId: String(params.roomId || ''),
      ownerId: String(params.ownerId),
      nextTime: Number(params.nextTime) || 0,
    }, { fallback: '获取成员微博失败', headers: createWeiboHeaders(requireToken()) });
  },

  async getMemberPostImages(userId: string, nextTime = 0) {
    return pocketPost(`${BASE}/posts/api/v1/posts/img/list`, {
      userId: String(userId),
      nextTime: Number(nextTime) || 0,
    }, { fallback: '获取成员图片动态失败' });
  },

  async getConversationPage(nextTime = 0, limit = 20) {
    return pocketPost(`${BASE}/im/api/v1/conversation/page`, {
      nextTime: Number(nextTime) || 0,
      limit: Number(limit) || 20,
    }, { modern: true, fallback: '获取会话列表失败' });
  },

  async getUserHomeInfo(userId?: string) {
    const payload: any = {};
    if (userId) payload.userId = String(userId);
    return pocketPost(`${BASE}/user/api/v1/user/info/home`, payload, {
      modern: true,
      fallback: '获取用户主页信息失败',
    });
  },

  async getUnreadMessageCount() {
    return pocketPost(`${BASE}/message/api/v1/unread/message/num`, {}, {
      modern: true,
      fallback: '获取未读消息数失败',
    });
  },

  async getUserPictureFrames() {
    return pocketPost(`${BASE}/user/api/v1/user/get/picture/frame`, {}, {
      modern: true,
      fallback: '获取头像框失败',
    });
  },

  async getMediaCollectionTotalCount() {
    return pocketPost(`${BASE}/media/api/media/v1/getCollectionTotalCount`, {}, {
      modern: true,
      fallback: '获取收藏统计失败',
    });
  },

  async getFlipCustomIndexV1(memberId: string) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v1/custom/index`, {
      memberId: String(memberId),
    }, { tokenRequired: false, fallback: '获取翻牌配置失败' });
  },

  // --- Invoice APIs ---

  async getInvoiceTips() {
    const res = await requestJson<any>(`${BASE}/invoice/api/v1/invoice/tips`, {
      method: 'GET',
      headers: createInvoiceHeaders(),
    });
    return assertPocketOk(res, '获取开票提示失败');
  },

  async getInvoiceConfig() {
    return pocketPost(`${BASE}/invoice/api/v1/invoice/config`, {}, {
      headers: createInvoiceHeaders(requireToken(), { tokenHeader: true }),
      fallback: '获取开票配置失败',
    });
  },

  async getInvoiceOrderList(nextTime = '', yearMonth = '') {
    const token = requireToken();
    return pocketPost(`${BASE}/invoice/api/v1/order/list`, {
      nextTime: String(nextTime || '0'),
      token,
      yearMonth: String(yearMonth || ''),
    }, {
      headers: createInvoiceHeaders(),
      fallback: '获取可开票订单失败',
    });
  },

  async applyElectronicInvoice(params: {
    buyerType?: number;
    buyerName?: string;
    buyerTaxNo?: string;
    buyerAddress?: string;
    buyerPhone?: string;
    buyerBankName?: string;
    buyerBankAccount?: string;
    notifyEmail?: string;
    notifyMobile?: string;
    orderDataId?: string[];
  }) {
    const token = requireToken();
    const ids = (params.orderDataId || []).map(item => String(item || '').trim()).filter(Boolean);
    if (!ids.length) throw new Error('请选择要开票的订单');
    const payload: any = {
      buyerType: Number(params.buyerType) === 1 ? 1 : 0,
      buyerName: String(params.buyerName || '').trim(),
      notifyEmail: String(params.notifyEmail || '').trim(),
      notifyMobile: String(params.notifyMobile || '').trim(),
      orderDataId: ids,
      token,
    };
    if (payload.buyerType === 1) {
      Object.assign(payload, {
        buyerAddress: String(params.buyerAddress || '').trim(),
        buyerBankAccount: String(params.buyerBankAccount || '').trim(),
        buyerBankName: String(params.buyerBankName || '').trim(),
        buyerPhone: String(params.buyerPhone || '').trim(),
        buyerTaxNo: String(params.buyerTaxNo || '').trim(),
      });
    }
    return pocketPost(`${BASE}/invoice/api/v1/invoice/apply/electronic`, payload, {
      headers: createInvoiceHeaders(),
      fallback: '提交开票申请失败',
    });
  },

  // --- Meet48 APIs ---

  async getMeet48LiveList(params: { next?: number; record?: boolean } = {}) {
    const res = await requestJson<any>('https://meetapi-v2.meet48.xyz/meet48-api/live/api/v1/live/getLiveList', {
      method: 'POST',
      body: { title: null, next: params.next || 0, record: !!params.record },
      headers: createMeet48Headers(),
    });
    return assertPocketOk(res, 'Meet48 API 错误');
  },

  async getMeet48LiveOne(liveId: string) {
    const res = await requestJson<any>('https://meetapi-v2.meet48.xyz/meet48-api/live/api/v1/live/getLiveOne', {
      method: 'POST',
      body: { liveId: String(liveId), streamProtocol: 'RTMP' },
      headers: createMeet48Headers(),
    });
    return assertPocketOk(res, 'Meet48 API 错误');
  },

  // --- v2.7 New APIs (同步自 yk1z/yaya_msg 电脑版, 2026-08-16) ---

  /** 删除单条私信 */
  async deletePrivateMessage(msgId: string) {
    return pocketPost(`${BASE}/message/api/v1/user/message/delete/msg`, {
      msgId: String(msgId),
    }, { fallback: '删除私信失败', headers: createPocketAndroidHeaders() });
  },

  /** 私信发送图片消息 */
  async sendPrivateImageMessage(targetUserId: string, image: { imgUrl: string; imgWidth?: number; imgHeight?: number; imgSize?: number; text?: string }) {
    return pocketPost(`${BASE}/message/api/v1/user/message/reply`, {
      messageType: 'IMAGE',
      imgUrl: String(image.imgUrl),
      imgWidth: Number(image.imgWidth || 0),
      imgHeight: Number(image.imgHeight || 0),
      imgSize: Number(image.imgSize || 0),
      targetUserId: String(targetUserId),
      text: String(image.text || ''),
    }, { modern: true, fallback: '发送图片私信失败' });
  },

  /** 上传图片到口袋（私信图片等，fromType 为空） */
  async uploadPocketImage(params: { uri: string; fileName?: string; mimeType?: string; fromType?: string }) {
    const token = requireToken();
    const headers = await signedHeaders(token, true);
    delete headers['Content-Type'];
    delete headers.Host;
    const mimeType = params.mimeType || 'image/jpeg';
    const fileName = params.fileName || `image-${Date.now()}.${mimeType.includes('png') ? 'png' : 'jpg'}`;
    const formData = new FormData();
    if (params.fromType) formData.append('fromType', params.fromType);
    formData.append('file', {
      uri: params.uri,
      name: fileName,
      type: mimeType,
    } as any);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await fetch('https://pfile.48.cn/filesystem/upload/image', {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });
    } catch (error: any) {
      throw new Error(error?.name === 'AbortError' ? '上传图片超时' : '上传图片网络失败');
    } finally {
      clearTimeout(timer);
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json().catch(() => null) : null;
    if (response.ok && data && (data.status === 200 || data.success)) {
      const item = Array.isArray(data.content) ? data.content[0] : data.content;
      const path = item?.path || item?.url || item?.filePath || '';
      if (!path) throw new Error('上传成功但没有返回图片路径');
      return { success: true, content: item, path };
    }
    const source = data || response;
    throw new Error((source as any)?.message || (source as any)?.msg || `上传失败 HTTP ${response.status}`);
  },

  /** 主页相册（图片动态，Android 头） */
  async getPostImageList(userId: string, nextId = 0, limit = 20) {
    return pocketPost(`${BASE}/posts/api/v1/posts/img/list`, {
      nextId: Number(nextId || 0),
      limit: Number(limit) || 20,
      userId: Number(userId) || 0,
    }, { fallback: '获取主页相册失败', headers: createPocketAndroidHeaders() });
  },

  /** 主页视频（v2） */
  async getPostVideoList(userId: string, nextId = 0, limit = 20) {
    return pocketPost(`${BASE}/posts/api/v2/posts/video/list`, {
      nextId: Number(nextId) || 0,
      limit: Number(limit) || 20,
      userId: Number(userId) || 0,
    }, { fallback: '获取主页视频失败', headers: createPocketAndroidHeaders() });
  },

  /** 主页动态时间线 */
  async getPostTimelineHome(userId: string, nextId = 0, limit = 20) {
    return pocketPost(`${BASE}/posts/api/v1/posts/timeline/home`, {
      nextId: Number(nextId) || 0,
      limit: Number(limit) || 20,
      userId: Number(userId) || 0,
    }, { fallback: '获取主页动态失败', headers: createPocketAndroidHeaders() });
  },

  /**
   * Seine 公演列表（ckg48 域名，iOS Seine 头）。
   *
   * ⚠️ `exactBigInts: true` 必须保留：`businessId` 是 17 位整数，**它同时就是公演直播
   * 的 liveId**（实测 2026-10-04：「柏欣妤 生日会」businessId/liveId = 1313111009176391680）。
   * 默认解析会让 JSON.parse 把它变成不精确的 1313111009176391700 —— 拿着这个 ID 去
   * getOpenLiveOne 永远查不到，公演直播就只剩「跳 B 站」一条路。
   */
  async getSeinePerformanceList(groupId = 0, next = 0) {
    return requestJson<any>('https://snhapi-v1.ckg48.cn/home/api/seine/home/interaction/list', {
      method: 'POST',
      body: {
        type: 2,
        groupId: String(groupId || 0),
        next: String(next || 0),
      },
      headers: createSeineIosHeaders(),
      timeout: 15000,
      exactBigInts: true,
    }).then((res: any) => assertPocketOk(res, '获取公演列表失败'));
  },

  /** Seine 频道详情（serverId → 房间名映射） */
  async getSeineServerDetail(serverId: number) {
    return pocketPost(`${BASE}/im/api/seine/server/detail`, {
      serverId: Number(serverId),
    }, { fallback: '获取频道详情失败', headers: createSeineHeaders() });
  },

  /** 单成员最新消息（team/last/message，push 服务同款） */
  async getLastMessageByServerId(serverId: number) {
    return pocketPost(`${BASE}/im/api/v1/team/last/message/get`, {
      serverId: Number(serverId),
    }, { fallback: '获取最新消息失败' });
  },

  /** 社区动态（Area48 最新） */
  async getArea48Newest(nextId = 0) {
    return pocketPost(`${BASE}/posts/api/v1/area48/data/newest/new`, {
      nextId: Number(nextId) || 0,
    }, { fallback: '获取社区动态失败', headers: createArea48Headers() });
  },

  /** 社区推荐 */
  async getArea48Recommend(nextId = 0) {
    return pocketPost(`${BASE}/posts/api/v1/area48/data/recommend/new`, {
      nextId: Number(nextId) || 0,
    }, { fallback: '获取社区推荐失败', headers: createArea48Headers() });
  },

  /** 帖子详情 */
  async getArea48PostDetails(postId: string) {
    return pocketPost(`${BASE}/posts/api/v1/posts/details`, {
      needViewer: true,
      needComment: true,
      postId: String(postId),
    }, { fallback: '获取帖子详情失败', headers: createArea48Headers() });
  },

  /** 帖子评论列表 */
  async getArea48Comments(resourceId: string, next = 0) {
    return pocketPost(`${BASE}/comment/api/v1/comment/level1/getCommentList`, {
      next: next ? String(next) : 0,
      resourceId: String(resourceId),
      resourceMd: 'md',
      resourceType: 1002,
    }, { fallback: '获取评论失败', headers: createArea48Headers() });
  },

  /** 发表评论 */
  async addArea48Comment(resourceId: string, commentMsg: string, commentUrl = '') {
    return pocketPost(`${BASE}/comment/api/v1/comment/addComment`, {
      resourceId: String(resourceId),
      commentMsg: String(commentMsg).trim(),
      commentUrl: String(commentUrl || ''),
      resourceMd: 'md',
      resourceType: 1002,
    }, { fallback: '发送评论失败', headers: createArea48Headers() });
  },

  /** 社区发帖 */
  async createArea48Post(params: { title?: string; content: string; topicArray?: string; extInfo?: string }) {
    return pocketPost(`${BASE}/posts/api/v1/posts/create`, {
      topicArray: String(params.topicArray || ''),
      postSource: '1',
      title: String(params.title || '').trim(),
      content: String(params.content).trim(),
      extInfo: String(params.extInfo || ''),
    }, { fallback: '发布动态失败', headers: createArea48Headers() });
  },

  /**
   * 屏蔽词列表（发言前过滤）。
   *
   * ⚠️ 两段式：配置接口只给词表**文件地址**（url / ordinaryUrl / starUrl），
   * 词表本体在 `source.48.cn` 上的纯文本（一行一词，可能带 BOM）。
   * 这里直接把第二段也取完，对外返回 `content.words`（词数组）与 `count`，
   * 供 services/maskWords 缓存——否则调用方拿到的 `content` 里根本没有词。
   */
  async getPocketMaskWords(clientTime = 0) {
    try {
      const res = await requestJson<any>(`${BASE}/home/api/check/maskword?clientTime=${Number(clientTime) || 0}`, {
        method: 'GET',
        headers: createArea48Headers(),
        timeout: 10000,
      });
      if (!(res?.status === 200 || res?.success)) return { success: false, content: {} };
      const content = res?.content || {};
      const url = String(content.url || content.ordinaryUrl || content.starUrl || '').trim();
      if (!url) return { success: true, content: { ...content, words: [], count: 0 } };
      let words: string[] = [];
      try {
        const text = await requestJson<any>(url, { method: 'GET', timeout: 10000 });
        words = parseMaskWordsText(typeof text === 'string' ? text : '');
      } catch {
        // 词表文件拉取失败：返回空词表，调用方走兜底地址或旧缓存（不抛错）
        words = [];
      }
      return { success: true, content: { ...content, url, words, count: words.length } };
    } catch {
      return { success: false, content: {} };
    }
  },


  // --- Open Live Participants (web scraping) ---

  async getOpenLiveParticipants(liveId: string, title = '', dateHint = '') {
    const pageHeaders: HeadersMap = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      Referer: 'https://live.48.cn/',
    };

    try {
      // Try the memberhot API first
      const livePageUrl = `https://live.48.cn/Index/inlive/id/${encodeURIComponent(liveId)}`;
      const html = await requestJson<string>(livePageUrl, {
        method: 'GET',
        headers: pageHeaders,
      }) as any; // Returns raw HTML as string

      // Extract hidden input values
      const extractInput = (inputId: string) => {
        const pattern = new RegExp(`<input[^>]+id=["']${inputId}["'][^>]+value=["']([^"']*)["']`, 'i');
        const match = String(html || '').match(pattern);
        return match ? String(match[1] || '').trim() : '';
      };

      const videoId = extractInput('vedio_id');
      const clubId = extractInput('club_id');
      const pageToken = extractInput('param');

      if (videoId && clubId && pageToken) {
        try {
          const payload = new URLSearchParams({
            act: 'default',
            video_id: videoId,
            token: pageToken,
            club_id: clubId,
          }).toString();

          const memberRes = await requestJson<any>(
            'https://live.48.cn/Index/ajax_getmemberhot/',
            {
              method: 'POST',
              body: payload,
              bodyType: 'raw',
              headers: {
                ...pageHeaders,
                Origin: 'https://live.48.cn',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
              },
            },
          );

          const rows = Array.isArray(memberRes?.desc) ? memberRes.desc : [];
          const participants = rows
            .map((item: any) => ({
              name: String(item?.memberName || '').trim(),
              memberId: String(item?.memberId || '').trim(),
              avatar: String(item?.avatar || '').trim(),
              hot: item?.hot ?? '',
            }))
            .filter((item: any) => item.name);

          if (participants.length) {
            return { success: true, content: { participants, source: 'memberhot' } };
          }
        } catch {
          // Fall through to HTML parsing
        }
      }

      // Fallback: extract names from HTML
      const nameMatches = String(html || '').matchAll(/<p class="listname">\s*([^<\r\n]+?)\s*(?:<em|<\/p>)/gi);
      const names: string[] = [];
      for (const match of nameMatches) {
        const name = String(match[1] || '').replace(/\s+/g, ' ').trim();
        if (name && !names.includes(name)) names.push(name);
      }
      const htmlParticipants = names.map(name => ({ name, memberId: '', avatar: '', hot: '' }));
      if (htmlParticipants.length) {
        return { success: true, content: { participants: htmlParticipants, source: 'html' } };
      }
    } catch {
      // All attempts failed
    }

    return { success: false, msg: '未找到参与成员' };
  },

  /* ── 现场互动（口袋「云握手」netface）───────────────────────────────────────
   * 对齐桌面端 yk1z/yaya_msg `src/common/netface-api.mjs`（base = /netface/api/v1/）：
   *   · 全部 POST + 签名头（token / pa / appInfo），与官方客户端一致；
   *   · `user/act/key`（兑换码）额外把 appInfo 塞进 body（桌面端同款），否则服务端判设备不符；
   *   · **id 一律传字符串**：eventId / ticketId 都是长数字，先转 Number 再序列化会丢精度
   *     （与 Seine 排期 liveId 那个坑同源，见 utils/network 的 parseJsonExact）。
   * 场次 status：1=可预约、2=排队中、3/4=等待进入、5=超时未入场（见 utils/netfaceRules）。
   */
  async getNetfaceTickets() {
    return pocketPost(`${BASE}/netface/api/v1/user/tp/ticket_info`, {}, { fallback: '获取现场互动活动失败' });
  },
  async getNetfaceInfo(ticketId: string) {
    return pocketPost(`${BASE}/netface/api/v1/user/reservation/info`, { ticketId: String(ticketId || '0') }, { fallback: '获取现场互动场次失败' });
  },
  async getNetfaceBalance(ticketId: string) {
    return pocketPost(`${BASE}/netface/api/v1/user/tp/balance`, { ticketId: String(ticketId || '0') }, { fallback: '获取握手资格失败' });
  },
  async getNetfaceWait(eventIds: string[]) {
    return pocketPost(`${BASE}/netface/api/v1/user/batch/balancetime`, {
      eventIds: (eventIds || []).map((id) => String(id)).filter(Boolean),
    }, { fallback: '获取排队信息失败' });
  },
  async reserveNetface(eventId: string, tpNum = 1) {
    return pocketPost(`${BASE}/netface/api/v1/user/reservation`, {
      eventId: String(eventId || ''),
      tpNum: Math.max(1, Math.min(999, Math.trunc(Number(tpNum) || 1))),
    }, { fallback: '预约失败' });
  },
  async cancelNetface(eventId: string) {
    return pocketPost(`${BASE}/netface/api/v1/user/reservation/cancel`, { eventId: String(eventId || '') }, { fallback: '取消预约失败' });
  },
  async activateNetfaceKey(ticketId: string, tpKey: string) {
    return pocketPost(`${BASE}/netface/api/v1/user/act/key`, {
      ticketId: String(ticketId || '0'),
      tpKey: String(tpKey || '').trim(),
      appInfo: JSON.stringify(appInfo()),
    }, { fallback: '兑换握手资格失败' });
  },
  async getNetfaceHistory(ticketId: string, next = 0) {
    return pocketPost(`${BASE}/netface/api/v1/user/act/log`, {
      ticketId: String(ticketId || '0'),
      next: Math.max(0, Math.trunc(Number(next) || 0)),
    }, { fallback: '获取兑换记录失败' });
  },
};

export default pocketApi;
