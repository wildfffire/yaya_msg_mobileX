import { NativeModules, Platform } from 'react-native';
import { useSettingsStore } from '../store';
import { requestJson } from '../utils/network';
import { md5Hex } from '../utils/md5';
import { logWarn } from '../utils/runtimeLog';

const BILIBILI_WEB_API = 'https://api.bilibili.com';
const BILIBILI_LIVE_API = 'https://api.live.bilibili.com';

function getCookie(): string {
  return useSettingsStore.getState().settings.bilibiliCookie || '';
}

function biliHeaders(cookie = getCookie(), referer = 'https://live.bilibili.com/'): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    Referer: referer,
  };
  if (referer.includes('live.bilibili.com')) headers.Origin = 'https://live.bilibili.com';
  /**
   * Cookie：用户自己的 cookie + 自动获取的 buvid3/buvid4。
   *
   * B站自 **2025-06-27** 起对 getDanmuInfo 等接口**强制要求 WBI 签名 + buvid3 cookie**。
   * 没有 buvid3 时接口会降级返回脱敏数据（甚至空 token）。buvid3 由
   * `/x/frontend/finger/spi` 下发（未登录也能拿到），缓存 12 小时。
   * 注意：用户 cookie 里若已有 buvid3 则不重复追加，避免出现两个 buvid3。
   */
  const parts: string[] = [];
  if (cookie) parts.push(cookie);
  if (buvidCache?.b3 && !/buvid3=/i.test(cookie)) parts.push(`buvid3=${buvidCache.b3}`);
  if (buvidCache?.b4 && !/buvid4=/i.test(cookie)) parts.push(`buvid4=${buvidCache.b4}`);
  if (parts.length) headers.Cookie = parts.join('; ');
  return headers;
}

/**
 * 从用户配置的 B站 Cookie 里解析出真实 uid（DedeUserID）。
 *
 * ★ 这是弹幕认证的**关键前提** ★
 * 本机对照实验已复现真机症状：当认证包里的 `uid` 与票据所属身份**不一致**时，
 * B站会在握手后约 17ms 直接掐断连接（close=1006、**无任何回包**）——
 * 与本项目的失败特征（12~33ms、1006、0 报文）完全吻合；
 * 而 uid 与票据一致时立即返回 op=8 认证回包。
 *
 * 即：**取票据带了登录 Cookie，就必须用对应的 uid 去认证**，
 * 不能一边用登录态票据、一边发 `uid: 0`（游客）。本项目此前正是后者。
 */
export function biliUidFromCookie(cookie?: string): number {
  const raw = String(cookie ?? getCookie() ?? '');
  if (!raw) return 0;
  const m = /(?:^|;\s*)DedeUserID=(\d+)/.exec(raw);
  const uid = m ? Number(m[1]) : 0;
  return Number.isFinite(uid) && uid > 0 ? uid : 0;
}

/**
 * buvid3/buvid4 缓存（B站风控指纹）。
 * buvid 既是接口要求（buvid3 cookie），又是**弹幕 WebSocket 认证包的字段**
 * （bilibili-ws-client / blive-ws / bilibili-live-danmaku 等实现均在 auth body 中带 buvid）。
 */
let buvidCache: { b3: string; b4: string; ts: number } | null = null;
const BUVID_TTL = 12 * 60 * 60 * 1000; // buvid 长期有效，缓存 12 小时足够

/** 取（并缓存）buvid3/buvid4；失败返回空串，不影响主流程 */
async function ensureBuvid(): Promise<{ b3: string; b4: string }> {
  if (buvidCache && Date.now() - buvidCache.ts < BUVID_TTL) {
    return { b3: buvidCache.b3, b4: buvidCache.b4 };
  }
  try {
    const spi = await requestJson<any>(`${BILIBILI_WEB_API}/x/frontend/finger/spi`, {
      headers: biliHeaders(getCookie(), 'https://www.bilibili.com/'),
    });
    const b3 = String(spi?.data?.b_3 || '');
    const b4 = String(spi?.data?.b_4 || '');
    if (b3) {
      buvidCache = { b3, b4, ts: Date.now() };
      try { logWarn(`[bili] buvid3 获取成功 len=${b3.length}`, 'bilibili.danmu'); } catch {}
    }
    return { b3, b4 };
  } catch (err) {
    try { logWarn(`[bili] buvid3 获取失败：${String((err as any)?.message || err)}`, 'bilibili.danmu'); } catch {}
    return { b3: '', b4: '' };
  }
}

function assertBiliOk(res: any, fallback: string) {
  if (res?.code === 0) return res;
  if (res?.code === -412 || /request was banned/i.test(String(res?.message || ''))) {
    throw new Error('B站接口请求被拦截，请登录 B站账号或稍后再试');
  }
  throw new Error(res?.message || res?.msg || fallback);
}

/* ------------------------------------------------------------------ *
 * WBI 签名
 *
 * B站自 2025-06-27 起对 getDanmuInfo 等接口**强制要求 WBI 签名 + buvid3 cookie**。
 * 未签名时接口返回 -352（风控），项目原先只能回退到已废弃的 getConf ——
 * 而 getConf 在部分网络/风控下会返回 **code=0 但 token 为空**的脱敏数据，
 * 空 token 一路传到 WebSocket 认证 → 服务端立刻关闭连接（close 1006、0 字节），
 * 表现为「弹幕永远接不进来」。
 *
 * 签名算法（官方 web 端同款）：
 *   1. 取 nav 接口的 wbi_img.img_url / sub_url，各自取文件名（去掉路径与扩展名）得 img_key / sub_key
 *   2. 按 MIXIN_KEY_ENC_TAB 重排 (img_key + sub_key)，取前 32 位 = mixin_key
 *   3. 参数按 key 升序拼接为 query，追加 wts（秒级时间戳）
 *   4. w_rid = md5(query + mixin_key)，拼到 query 末尾
 * 实测：未登录（nav 返回 -101）时 wbi_img 依然下发，签名可用。
 * ------------------------------------------------------------------ */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const WBI_KEYS_TTL = 60 * 60 * 1000; // 密钥每天更换，缓存 1 小时足够
let wbiKeysCache: { imgKey: string; subKey: string; ts: number } | null = null;

async function getWbiKeys(): Promise<{ imgKey: string; subKey: string } | null> {
  if (wbiKeysCache && Date.now() - wbiKeysCache.ts < WBI_KEYS_TTL) {
    return { imgKey: wbiKeysCache.imgKey, subKey: wbiKeysCache.subKey };
  }
  try {
    const nav = await requestJson<any>(`${BILIBILI_WEB_API}/x/web-interface/nav`, {
      headers: biliHeaders(getCookie(), 'https://www.bilibili.com/'),
    });
    const pickKey = (url: string) => String(url || '').split('/').pop()?.split('.')[0] || '';
    const imgKey = pickKey(nav?.data?.wbi_img?.img_url);
    const subKey = pickKey(nav?.data?.wbi_img?.sub_url);
    if (imgKey.length < 16 || subKey.length < 16) return null;
    wbiKeysCache = { imgKey, subKey, ts: Date.now() };
    return { imgKey, subKey };
  } catch {
    return null; // 取不到密钥不算致命：调用方会回退到未签名/旧接口
  }
}

/** 生成带 w_rid 的查询串（不含前导 ?） */
function encWbi(params: Record<string, string | number>, imgKey: string, subKey: string): string {
  const mixinKey = MIXIN_KEY_ENC_TAB.map((i) => (imgKey + subKey)[i]).join('').slice(0, 32);
  const wts = Math.round(Date.now() / 1000);
  const merged: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(merged)
    .sort()
    .map((k) => {
      const v = String(merged[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5Hex(query + mixinKey)}`;
}

/** 弹幕 token 最短可接受长度（实测合法 token 200+ 字符） */
const MIN_DANMU_TOKEN_LEN = 10;


function candidateScore(item: any): number {
  let score = 0;
  const format = String(item.formatName || '').toLowerCase();
  const protocol = String(item.protocolName || '').toLowerCase();
  const codec = String(item.codecName || '').toLowerCase();

  // 优先级：① 可播放性（HLS fmp4/ts 优先于 http-flv —— 2026-10-02 实测回滚：B站 flv CDN 对
  //          data: 页面的 fetch 强校验 Referer/Origin（WebView 日志 403），flv 优先会让直播整体
  //          打不开；HEVC 档的修复改由「HEVC-only 档直接走原生内核」承担，见 BilibiliLiveScreen）
  //          ② 画质（qn 越高越好，默认即最高可用画质）
  //          ③ 同画质下编码 tie-break：AVC 略优于 HEVC
  // 这样默认拿到「能播的最高画质」；若某线路播放失败，上层静默换到下一条。
  if (format === 'fmp4' || format === 'ts' || protocol.includes('hls')) score += 100000;
  score += Number(item.currentQn || 0) * 2;
  if (codec === 'avc') score += 1;
  return score;
}

function liveCandidates(playInfo: any): any[] {
  const playurl = playInfo?.data?.playurl_info?.playurl;
  const candidates: any[] = [];

  for (const stream of playurl?.stream || []) {
    for (const format of stream.format || []) {
      for (const codec of format.codec || []) {
        const baseUrl = String(codec.base_url || '').trim();
        if (!baseUrl) continue;
        for (const info of codec.url_info || []) {
          const host = String(info.host || '').trim();
          if (!host) continue;
          candidates.push({
            url: `${host}${baseUrl}${String(info.extra || '').trim()}`,
            host,
            protocolName: String(stream.protocol_name || '').trim(),
            formatName: String(format.format_name || '').trim(),
            codecName: String(codec.codec_name || '').trim(),
            currentQn: Number(codec.current_qn || 0),
          });
        }
      }
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter((item) => item.url && !seen.has(item.url) && seen.add(item.url))
    .sort((a, b) => candidateScore(b) - candidateScore(a));
}

export interface BiliQuality {
  qn: number;
  label: string;
}

/** accept_qn 里可能出现但 g_qn_desc 缺失时的兜底标签（对齐 B站官方档位命名） */
const QN_LABEL_FALLBACK: Record<number, string> = {
  30000: '杜比',
  20000: '4K',
  10000: '原画',
  400: '蓝光',
  250: '超清',
  150: '高清',
  80: '流畅',
};

/**
 * 收集本次会话**真正可切换**的画质集合：各 codec 流的 accept_qn（并集）+ 实际授予的 current_qn。
 *
 * ★ 这是画质菜单的**唯一口径**（对齐 PiliPlus：`acceptQnList = item.acceptQn`）——
 * 不能用 g_qn_desc（房间能力全表）直接当菜单：它包含账号/权限**拿不到**的档位
 * （未登录的原画/蓝光、无大会员的 4K/杜比），选了必然被服务端降级。
 */
function collectAcceptQns(playInfo: any): number[] {
  const set = new Set<number>();
  for (const stream of playInfo?.data?.playurl_info?.playurl?.stream || []) {
    for (const format of stream.format || []) {
      for (const codec of format.codec || []) {
        for (const qn of codec.accept_qn || []) {
          const n = Number(qn);
          if (n > 0) set.add(n);
        }
        const cur = Number(codec.current_qn || 0);
        if (cur > 0) set.add(cur);
      }
    }
  }
  return [...set];
}

/**
 * 画质选项：**accept_qn（可切换集合）∩ g_qn_desc（标签）**，按 qn 降序。
 * g_qn_desc 只当「标签字典」用；档位集合一律以 accept_qn 为准（为空才退回 g_qn_desc 兜底）。
 */
function buildQualities(playInfo: any, candidates: any[]): BiliQuality[] {
  const descList = playInfo?.data?.playurl_info?.playurl?.g_qn_desc || [];
  const labelByQn = new Map<number, string>();
  for (const q of descList) {
    const qn = Number(q?.qn || 0);
    if (qn > 0 && !labelByQn.has(qn)) {
      labelByQn.set(qn, String(q.desc || QN_LABEL_FALLBACK[qn] || `qn${qn}`));
    }
  }
  for (const c of candidates) {
    const qn = Number(c.currentQn || 0);
    if (qn > 0 && !labelByQn.has(qn)) {
      labelByQn.set(qn, QN_LABEL_FALLBACK[qn] || `qn${qn}`);
    }
  }
  const acceptQns = collectAcceptQns(playInfo);
  const qns = acceptQns.length ? acceptQns : [...labelByQn.keys()];
  return [...new Set(qns)]
    .filter((qn) => qn > 0)
    .sort((a, b) => b - a)
    .map((qn) => ({ qn, label: labelByQn.get(qn) || QN_LABEL_FALLBACK[qn] || `qn${qn}` }));
}

export const bilibiliApi = {
  headers(roomId?: string) {
    return biliHeaders(getCookie(), roomId ? `https://live.bilibili.com/${roomId}` : 'https://live.bilibili.com/');
  },

  async checkLoginStatus(cookie?: string) {
    const res = await requestJson<any>(`${BILIBILI_WEB_API}/x/web-interface/nav`, {
      headers: biliHeaders(cookie, 'https://www.bilibili.com/'),
    });
    return assertBiliOk(res, 'B站登录状态检查失败');
  },

  async generateQrCode() {
    const res = await requestJson<any>('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
      headers: biliHeaders('', 'https://passport.bilibili.com/'),
    });
    return assertBiliOk(res, 'B站二维码获取失败');
  },

  async pollQrCode(qrcodeKey: string) {
    const res = await requestJson<any>(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
      { headers: biliHeaders('', 'https://passport.bilibili.com/') },
    );
    return assertBiliOk(res, 'B站扫码状态获取失败');
  },

  /** B站 2024+ 新协议：扫码确认后 poll 只回 ticket 型 crossDomain url（如
   *  https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=xxx&gourl=...），
   *  cookie 由访问该 url 时服务端 Set-Cookie 响应头下发。RN fetch 自动跟随 302 拿不到该头，
   *  走原生 BiliLoginModule（followRedirects=false 停在首包读 Set-Cookie）。返回 "k=v; k=v" 串。 */
  async exchangeTicket(crossDomainUrl: string) {
    const M: any = (NativeModules as any)?.BiliLoginModule;
    if (Platform.OS !== 'android' || !M?.fetchTicket) {
      throw new Error('当前环境不支持 B站 ticket 换 cookie（需 Android 原生模块）');
    }
    const raw = await M.fetchTicket(String(crossDomainUrl));
    return String(raw || '');
  },

  async getRoomInit(roomId: string) {
    const res = await requestJson<any>(
      `${BILIBILI_LIVE_API}/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`,
      { headers: biliHeaders(getCookie(), `https://live.bilibili.com/${roomId}`) },
    );
    return assertBiliOk(res, 'B站房间信息获取失败');
  },

  /** 房间详情：标题 + 封面（公演直播行展示用） */
  async getRoomInfo(roomId: string) {
    const res = await requestJson<any>(
      `${BILIBILI_LIVE_API}/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`,
      { headers: biliHeaders(getCookie(), `https://live.bilibili.com/${roomId}`) },
    );
    return assertBiliOk(res, 'B站房间详情获取失败').data || {};
  },

  /**
   * @param opts.qn 目标画质档位。B站 v2 getRoomPlayInfo **只返回所请求档位的流**——
   *   固定 10000 请求则永远只有原画档的线路，切换画质必须带目标 qn 重新请求。
   * @param opts.fourk 是否允许 4K 流，**默认关**（2026-10-02 修闪退）：原先恒带 fourk=1，
   *   房间原画是 4K/HEVC 高码率流时服务端直接下发，设备解码不支持的机型上原生内核
   *   一播就闪退，且每次进房默认请求都命中同一条流 → 「点进去就闪退」。
   *   现在只有用户在清晰度菜单里**显式**选择 4K(20000)/杜比(30001) 档时才带 fourk=1，
   *   默认进房/普通切档永远拿设备可解码的安全流。
   */
  async getRoomPlayInfo(roomId: string, opts?: { qn?: number; fourk?: boolean }) {
    const query = new URLSearchParams({
      room_id: String(roomId),
      protocol: '0,1',
      format: '0,1,2',
      codec: '0,1',
      // 默认 qn=10000(原画)；fourk 默认关（见方法注释），仅显式选 4K/杜比档时打开
      qn: String(Number(opts?.qn) > 0 ? Number(opts?.qn) : 10000),
      fourk: opts?.fourk ? '1' : '0',
      fnval: '4048',
      platform: 'web',
      ptype: '8',
    });
    const res = await requestJson<any>(
      `${BILIBILI_LIVE_API}/xlive/web-room/v2/index/getRoomPlayInfo?${query.toString()}`,
      { headers: biliHeaders(getCookie(), `https://live.bilibili.com/${roomId}`) },
    );
    return assertBiliOk(res, 'B站直播流获取失败');
  },

  /**
   * 取弹幕服务器列表 + 认证 token。
   *
   * ⚠️ 这里必须**校验 token 非空**，否则会以假成功返回、把空 key 带到 WebSocket，
   * 服务端收到空 key 会立刻关闭连接（实测 close 1006、0 字节、约 100ms 内断开）——
   * 这正是「B站弹幕永远接不进来」的根因形态。
   *
   * 顺序：① WBI 签名的 getDanmuInfo（官方支持路径）→ ② 旧版 getConf 兜底。
   */
  /**
   * @param opts.guest 为 true 时**不带用户 Cookie**取票（得到游客票据），
   *   用于「登录态票据认证失败」时退回游客身份重试。
   */
  async getDanmuInfo(roomId: string, opts?: { guest?: boolean }) {
    const referer = `https://live.bilibili.com/${roomId}`;
    const cookie = opts?.guest ? '' : getCookie();
    /** 票据所属 uid：登录态取票则为 DedeUserID，否则 0（游客）。认证包必须与之一致。 */
    const uid = opts?.guest ? 0 : biliUidFromCookie(cookie);
    // 先确保拿到 buvid3：既是接口要求（2025-06-27 起强制），也是弹幕认证包的字段
    const { b3: buvid } = await ensureBuvid();

    // ① WBI 签名版（自 2025-06-27 起官方要求；未签名固定返回 -352 风控）
    try {
      const keys = await getWbiKeys();
      if (keys) {
        const res = await requestJson<any>(
          `${BILIBILI_LIVE_API}/xlive/web-room/v1/index/getDanmuInfo?${encWbi({ id: roomId, type: 0 }, keys.imgKey, keys.subKey)}`,
          { headers: biliHeaders(cookie, referer) },
        );
        assertBiliOk(res, 'B站弹幕信息获取失败');
        const data = res.data || {};
        if (String(data.token || '').length >= MIN_DANMU_TOKEN_LEN) {
          try { logWarn(`[bili] getDanmuInfo(WBI) ok tokenLen=${String(data.token).length} hostList=${(data.host_list || []).length} uid=${uid}`, 'bilibili.danmu'); } catch {}
          return { ...data, buvid, uid };
        }
        // code=0 但 token 为空 = 未登录/风控下的脱敏数据 → 当作失败继续兜底
        try { logWarn(`[bili] getDanmuInfo(WBI) 返回 code=0 但 token 为空（len=${String(data.token || '').length}）→ 回退 getConf`, 'bilibili.danmu'); } catch {}
      } else {
        try { logWarn('[bili] WBI 密钥获取失败（nav 无 wbi_img）→ 回退未签名/getConf', 'bilibili.danmu'); } catch {}
      }
    } catch (err) {
      try { logWarn(`[bili] getDanmuInfo(WBI) 失败：${String((err as any)?.message || err)} → 回退 getConf`, 'bilibili.danmu'); } catch {}
    }

    // ② 旧版 getConf 兜底
    const conf = await requestJson<any>(
      `${BILIBILI_LIVE_API}/room/v1/Danmu/getConf?room_id=${encodeURIComponent(roomId)}&platform=pc&player=web`,
      { headers: biliHeaders(cookie, referer) },
    );
    const data = assertBiliOk(conf, 'B站弹幕配置获取失败').data || {};
    const token = String(data.token || '');
    const hosts = (data.host_server_list || data.server_list || [])
      .map((h: any) => ({ host: h.host, wss_port: Number(h.wss_port) || 443 }))
      .filter((h: any) => h.host);
    try { logWarn(`[bili] getConf tokenLen=${token.length} hostList=${hosts.length}`, 'bilibili.danmu'); } catch {}
    // 两条路都拿不到 token → 明确抛错，让上层记日志并退避重试，而不是拿空 key 去连接
    if (token.length < MIN_DANMU_TOKEN_LEN) {
      throw new Error('B站弹幕 token 获取失败（两条接口都返回空 token）');
    }
    return {
      token,
      host_list: hosts.length ? hosts : [{ host: data.host || 'broadcastlv.chat.bilibili.com', wss_port: 443 }],
      buvid,
      uid,
    };
  },

  /**
   * @param opts.qn 目标画质。B站 v2 接口只下发所请求档位的流：默认 10000（原画），
   *   切换画质时必须带目标 qn 重新调本方法，仅靠本地过滤候选是不够的。
   * @param opts.fourk 仅用户显式选 4K/杜比档时为 true（默认关，防设备不支持的解码档闪退）。
   */
  async resolveLive(roomId: string, opts?: { qn?: number; fourk?: boolean }) {
    const init = await this.getRoomInit(roomId);
    const realRoomId = String(init.data?.room_id || roomId);
    if (Number(init.data?.live_status) !== 1) throw new Error('该直播间当前未开播');

    const playInfo = await this.getRoomPlayInfo(realRoomId, opts);
    const candidates = liveCandidates(playInfo);
    if (!candidates.length) throw new Error('未找到可用的直播播放地址');

    return {
      realRoomId,
      streamUrl: candidates[0].url,
      streamCandidates: candidates,
      qualities: buildQualities(playInfo, candidates),
      title: playInfo.data?.room_info?.title || `B站直播 ${realRoomId}`,
    };
  },

  async resolveLiveUrl(roomId: string): Promise<string | null> {
    const info = await this.resolveLive(roomId);
    return info.streamUrl || null;
  },
};

export default bilibiliApi;
