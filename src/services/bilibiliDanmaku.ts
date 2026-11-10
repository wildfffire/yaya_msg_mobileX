/**
 * bilibiliDanmaku · B站直播弹幕（WebSocket 直连弹幕服务器）
 *
 * # 本文件是**整体照 PiliPlus 的 lib/tcp/live.dart 重写**的版本
 *
 * 之前这个模块被反复打补丁（诊断日志 + 各种猜测性兜底），膨胀到 700+ 行且逻辑互相打架。
 * 现在按 PiliPlus（Flutter 实现的 B站第三方客户端，弹幕功能已验证可用）的结构重写：
 *
 *   PiliPlus 结构                      →  本文件对应
 *   ──────────────────────────────────────────────────────────
 *   PackageHeader(ver, op, seq)        →  encodeHeader()
 *   PackageHeaderRes.fromBytesData     →  readHeader()
 *   AuthMessage / AuthPackage          →  buildAuthPacket()
 *   HeartbeatPackage(内容为空!)         →  buildHeartbeatPacket()
 *   LiveMessageStream.init()           →  BilibiliDanmaku#run()
 *   LiveMessageStream.onData()         →  tryServer 的 onmessage
 *   LiveMessageStream._heartBeat()     →  #startHeartbeat()
 *   LiveMessageStream._processingData  →  extractDanmaku()
 *
 * 与 PiliPlus 一致的**关键行为**（这些恰是之前我们做错/缺失的）：
 *   1. 封包头 16 字节，`operationCode` 是 **32 位**（大端）
 *   2. 认证包字段与顺序：roomid, uid, protover, platform, type, key
 *   3. **心跳包内容为空**（只发 16 字节头，不带 `{}`）—— 之前我们带了一个 `{}` body
 *   4. **收到 op=8（认证回包）后才启动心跳**，而不是连上就发
 *   5. 逐个候选服务器试连，成功即止；全部失败才退避重连（不再"1 秒打满 8 个"）
 *
 * 与 PiliPlus 的**唯一有意差异**：
 *   - PiliPlus 用 `protover: 3`（brotli），依赖 `package:brotli` 解压；
 *     RN/Hermes **没有 WASM**、项目也没有 brotli 解码库，所以这里用 `protover: 2`（zlib，pako 可解）。
 *     这是官方支持的取值（1=不压缩 / 2=zlib / 3=brotli），Node 侧实测 2 稳定可用。
 *   - 候选服务器把通用入口 `wss://broadcastlv.chat.bilibili.com:443/sub` 排在最前，
 *     这也是 PiliPlus / Minteea 实现里的默认地址；接口下发的区域节点（zj-cn- / bd-sz-live-comet-*）在后。
 */
import bilibiliApi from '../api/bilibili';
/**
 * ★ pako 3 只有命名导出、没有 default ★
 * 之前写 `import pako from 'pako'` → 拿到 undefined → `pako.inflate` 抛 TypeError
 * → 被 unpackBody 的 catch 静默吞掉 → 「认证通过、op=5 都到了，但一条弹幕都解不出」。
 * 必须用命名导入（本机 Node 已实锤：pako 3.0.1 `default: undefined`）。
 */
import { inflate as pakoInflate } from 'pako';
import { logWarn } from '../utils/runtimeLog';
import { danmakuWebBridge } from '../components/DanmakuWebViewBridge';

/* ───────────────────────────── 协议常量 ───────────────────────────── */

/** 封包头定长 16 字节 */
const HEADER_SIZE = 0x10;

const OP_HEARTBEAT = 2;       // 客户端心跳
const OP_HEARTBEAT_REPLY = 3; // 心跳回复（人气值）
const OP_MESSAGE = 5;         // 业务消息（弹幕 / 礼物等）
const OP_AUTH = 7;            // 认证（进房）
const OP_AUTH_REPLY = 8;      // 认证回包

/** 封包头里的 ver 字段，固定 1（与认证包里的 protover 不是一回事） */
const PACKET_PROTO_VER = 1;

/**
 * 认证包里的 protover：2 = 服务端用 zlib 下发（pako 可解）。
 * 见文件头说明：RN 无 brotli，故不采用 PiliPlus 的 3。
 */
const AUTH_PROTOVER = 2;

const HEARTBEAT_INTERVAL_MS = 30000;
const RECONNECT_BASE_MS = 30000;
/** 认证通过后的意外掉线：基础退避可以更短（链路本身验证过是好的） */
const RECONNECT_DROP_BASE_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 300000;
const RECONNECT_MAX_ATTEMPTS = 5;

/** 认证等待窗口（实测服务端约 5 秒没收到认证就断开） */
const AUTH_TIMEOUT_MS = 6000;

const LOG_CTX = 'bilibili.danmaku';

/** 通用入口（PiliPlus / Minteea 实现里的默认地址） */
const GENERIC_SERVER = 'wss://broadcastlv.chat.bilibili.com:443/sub';

/* ───────────────────────────── 最小日志 ───────────────────────────── */

/**
 * 最小日志：弹幕静默失败极难排查，出问题时可从「设置 → 日志」取到线索。
 * 诊断期用过的「★裸连接探针」已完成使命（判决 = uid 与票据身份不一致），已整段删除。
 */
function dmLog(msg: string): void {
  try { logWarn(`[bili-dm] ${msg}`, LOG_CTX); } catch { /* 忽略 */ }
}

export interface BiliDanmakuHandlers {
  onMessage: (text: string) => void;
  onStatus?: (connected: boolean) => void;
}

/* ───────────────────────────── 封包 / 解包 ───────────────────────────── */

function utf8Encode(str: string): Uint8Array {
  const out: number[] = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}

/**
 * UTF-8 解码。
 *
 * ⚠️ 不要用 `decodeURIComponent(escape(s))` 那套写法：escape/unescape 早已废弃，
 * Hermes 上随时可能被移除（一旦失效，中文弹幕会全变乱码）。
 * 这里按 UTF-8 规则逐字节解，不依赖任何废弃 API。
 */
function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i];
    let cp: number;
    let extra = 0;
    if (b1 < 0x80) {
      cp = b1;
    } else if ((b1 & 0xe0) === 0xc0) {
      cp = b1 & 0x1f;
      extra = 1;
    } else if ((b1 & 0xf0) === 0xe0) {
      cp = b1 & 0x0f;
      extra = 2;
    } else if ((b1 & 0xf8) === 0xf0) {
      cp = b1 & 0x07;
      extra = 3;
    } else {
      // 非法首字节：跳过，避免整条弹幕解析失败
      i += 1;
      continue;
    }
    if (i + extra >= bytes.length) break; // 字节不完整
    for (let k = 1; k <= extra; k += 1) cp = (cp << 6) | (bytes[i + k] & 0x3f);
    i += extra + 1;
    if (cp <= 0xffff) out += String.fromCharCode(cp);
    else {
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
  }
  return out;
}

/** 生成 16 字节封包头（对应 PiliPlus 的 PackageHeader.toBytes） */
function encodeHeader(contentSize: number, operation: number, seq: number): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE);
  const dv = new DataView(buf);
  dv.setUint32(0, HEADER_SIZE + contentSize); // 总包长
  dv.setUint16(4, HEADER_SIZE);               // 头长
  dv.setUint16(6, PACKET_PROTO_VER);          // 协议版本
  dv.setUint32(8, operation);                 // 操作码（32 位）
  dv.setUint32(12, seq);                      // 序号
  return buf;
}

interface PacketHeader {
  totalSize: number;
  headerSize: number;
  protoVer: number;
  operation: number;
  seq: number;
}

/** 解析封包头（对应 PiliPlus 的 PackageHeaderRes.fromBytesData） */
function readHeader(data: Uint8Array): PacketHeader | null {
  if (data.length < HEADER_SIZE) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    totalSize: dv.getUint32(0),
    headerSize: dv.getUint16(4),
    protoVer: dv.getUint16(6),
    operation: dv.getUint32(8),
    seq: dv.getUint32(12),
  };
}

/** 头 + 可选 body 拼成完整包 */
function buildPacket(header: ArrayBuffer, body?: Uint8Array): Uint8Array {
  const out = new Uint8Array(header.byteLength + (body ? body.length : 0));
  out.set(new Uint8Array(header), 0);
  if (body) out.set(body, header.byteLength);
  return out;
}

/** 认证包（对应 PiliPlus 的 AuthPackage） */
function buildAuthPacket(roomId: number, uid: number, key: string): Uint8Array {
  const json = utf8Encode(
    JSON.stringify({
      roomid: roomId,
      uid,
      protover: AUTH_PROTOVER,
      platform: 'web',
      type: 2,
      key,
    }),
  );
  return buildPacket(encodeHeader(json.length, OP_AUTH, 1), json);
}

/** 心跳包（对应 PiliPlus 的 HeartbeatPackage —— **内容为空**，只发 16 字节头） */
function buildHeartbeatPacket(seq: number): Uint8Array {
  return buildPacket(encodeHeader(0, OP_HEARTBEAT, seq));
}

/** 按 protoVer 取出包体；null = 无法处理（如 brotli，本项目无解码库） */
function unpackBody(data: Uint8Array, header: PacketHeader): Uint8Array | null {
  const start = header.headerSize;
  const end = Math.min(header.totalSize, data.length);
  if (end <= start) return new Uint8Array(0);
  const raw = data.subarray(start, end);
  switch (header.protoVer) {
    case 0:
    case 1:
      return raw; // 未压缩
    case 2:
      try {
        return new Uint8Array(pakoInflate(raw)); // zlib
      } catch (err) {
        // 不再静默：解压失败 = 弹幕全丢且无任何线索，必须落日志
        try { logWarn(`[bili-dm] zlib 解压失败 rawLen=${raw.length} head=${Array.from(raw.subarray(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' ')} err=${String((err as any)?.message || err)}`, LOG_CTX); } catch { /* 忽略 */ }
        return null;
      }
    case 3:
      return null; // brotli：本项目不支持
    default:
      return null;
  }
}

/**
 * 从一帧数据里递归解出所有弹幕文本（对应 PiliPlus 的 _processingData）。
 * 一帧可能含多个包，压缩后的包体里还会再套完整数据包。
 */
function extractDanmaku(data: Uint8Array, out: string[]): void {
  const header = readHeader(data);
  if (!header || header.totalSize < HEADER_SIZE) return;

  /**
   * ★ 压缩包（ver=2 zlib / ver=3 brotli）★
   * 这是 PiliPlus 的关键处理：`onData` 里先按 protoVer 解压，再把解压结果
   * **当作数据包递归处理**（因为压缩的是"若干个完整数据包"，不是直接 JSON）。
   *
   * 我们之前的写法对 op=5 一律直接 JSON.parse —— 而 protover=2 时 op=5 的包体
   * 是压缩数据，解析必然失败，于是「连接已认证、报文也收到了，但一条弹幕都出不来」。
   */
  if (header.protoVer === 2 || header.protoVer === 3) {
    const inner = unpackBody(data, header);
    if (inner && inner.length > 0) extractDanmaku(inner, out);
    if (header.totalSize < data.length) extractDanmaku(data.subarray(header.totalSize), out);
    return;
  }

  // 未压缩（ver=0/1）：包体就是 JSON
  const body = unpackBody(data, header);
  if (body && body.length > 0 && header.operation === OP_MESSAGE) {
    try {
      const json = JSON.parse(utf8Decode(body)) as any;
      /**
       * ★ cmd 必须用前缀匹配 ★
       * 真实弹幕的 cmd 是带后缀的，如 `DANMU_MSG:4:0:2:2:2:0`；
       * 精确等值匹配一条都匹配不上（合成验证包用的是裸 "DANMU_MSG"，所以当时没暴露）。
       * PiliPlus 同样用 startsWith。
       */
      if (String(json?.cmd || '').startsWith('DANMU_MSG') && Array.isArray(json?.info)) {
        const text = String(json.info[1] ?? '');
        if (text) out.push(text);
      }
    } catch {
      /* 单条解析失败不影响其它 */
    }
  }
  // 同一帧里后续的包
  if (header.totalSize < data.length) {
    extractDanmaku(data.subarray(header.totalSize), out);
  }
}

/** 把接口下发的 host_list 展开成候选地址列表（通用入口排最前） */
function buildServerUrls(hostList: any[] | undefined): string[] {
  const urls: string[] = [GENERIC_SERVER];
  const seen = new Set<string>([GENERIC_SERVER]);
  for (const h of hostList || []) {
    const host = String(h?.host || '');
    if (!host) continue;
    for (const port of [Number(h?.wss_port) || 443, 2245]) {
      const url = `wss://${host}:${port}/sub`;
      if (!seen.has(url)) { seen.add(url); urls.push(url); }
    }
  }
  return urls;
}

export class BilibiliDanmaku {
  private roomId = '';
  private token = '';
  private uid = 0;
  private servers: string[] = [];
  private handlers: BiliDanmakuHandlers | null = null;

  private ws: WebSocket | null = null;
  private active = false;

  /** 心跳：收到 op=8 之后才启动（PiliPlus 行为） */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatSeq = 1;

  private authWatchdog: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  /**
   * WebView 通道归属标记：bridge 是全局单例，回调字段只有一份。
   * 只有**自己**通过 startWebTransport() 挂上回调时才允许在 disconnect() 里清掉，
   * 否则「弹幕自检」等第二个实例 connect() 时会把播放页正在用的通道杀掉。
   */
  private ownsWebBridge = false;

  connect(roomId: string, handlers: BiliDanmakuHandlers): void {
    this.disconnect();
    this.roomId = String(roomId);
    this.handlers = handlers;
    this.active = true;
    this.reconnectAttempt = 0;
    this.heartbeatSeq = 1;
    void this.run();
  }

  disconnect(): void {
    this.active = false;
    this.stopHeartbeat();
    this.clearAuthWatchdog();
    // 若本实例正在用 WebView 通道，一并停掉（bridge 是全局单例：只清本实例挂上去的回调）
    if (this.ownsWebBridge) {
      this.ownsWebBridge = false;
      try { danmakuWebBridge.stop(); } catch { /* 忽略 */ }
      danmakuWebBridge.onDanmaku = null;
      danmakuWebBridge.onStatus = null;
      danmakuWebBridge.onLog = null;
    }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try {
        this.ws.onopen = null as any;
        this.ws.onmessage = null as any;
        this.ws.onerror = null as any;
        this.ws.onclose = null as any;
        this.ws.close();
      } catch { /* 忽略 */ }
      this.ws = null;
    }
    this.handlers = null;
  }

  /* ───────────────── 取票据 → 按顺序试连 ───────────────── */

  private async run(): Promise<void> {
    if (!this.active) return;
    try {
      const info: any = await bilibiliApi.getDanmuInfo(this.roomId);
      this.token = String(info?.token || '');
      /**
       * ★ uid 必须与票据所属身份一致 ★
       * 取票时若带登录 Cookie，票据就是登录态的，此时必须传对应 uid（DedeUserID）；
       * 传 0（游客）会被服务端立刻掐断（实测 close=1006、约 17ms、无任何回包）。
       * 详见 api/bilibili.ts 的 biliUidFromCookie 注释。
       */
      this.uid = Number(info?.uid) || 0;
      this.servers = buildServerUrls(info?.host_list);
    } catch (err) {
      dmLog(`取弹幕票据失败：${String((err as any)?.message || err)}`);
      this.scheduleReconnect();
      return;
    }
    if (!this.token || this.servers.length === 0) {
      dmLog(`弹幕票据/服务器为空（tokenLen=${this.token.length}）`);
      this.scheduleReconnect();
      return;
    }
    dmLog(`票据就绪 tokenLen=${this.token.length} 候选=${this.servers.length} 首选=${this.servers[0]}`);

    // 逐个试连，成功即止（不再爆发式打满）
    for (const url of this.servers) {
      if (!this.active) return;
      const ok = await this.tryServer(url);
      if (ok) return;
    }
    if (!this.active) return;

    /**
     * ★ 兜底一：登录态失败 → 退回游客身份重取票据再试一次 ★
     *
     * 依据：uid 与票据身份不一致会导致「握手后十几毫秒被掐断」。
     * 若用户配置的 B站 Cookie 已过期/失效，取到的可能仍是"登录态"票据，
     * 但对应 uid 拿不到或不匹配 —— 此时用**游客票据 + uid=0** 往往能通。
     */
    if (this.uid !== 0) {
      dmLog(`以 uid=${this.uid} 认证失败 → 退回游客身份重取票据`);
      try {
        const guest: any = await bilibiliApi.getDanmuInfo(this.roomId, { guest: true });
        const guestToken = String(guest?.token || '');
        if (guestToken && guestToken !== this.token) {
          this.token = guestToken;
          this.uid = 0;
          this.servers = buildServerUrls(guest?.host_list);
          dmLog(`游客票据就绪 tokenLen=${guestToken.length}`);
          for (const url of this.servers) {
            if (!this.active) return;
            const ok = await this.tryServer(url);
            if (ok) return;
          }
        }
      } catch (err) {
        dmLog(`游客票据获取失败：${String((err as any)?.message || err)}`);
      }
      if (!this.active) return;
    }

    /**
     * ★ 兜底二：转 WebView 通道 ★
     *
     * 依据：裸连接能存活到服务端 5s 认证窗口（链路没问题），但一发认证包就立刻被断，
     * 且认证包字节与 PiliPlus / 本机可用实现逐字节一致 —— 排除完可控变量后，
     * 剩下的只有**客户端身份**（OkHttp 的 TLS 指纹 + 缺失的浏览器请求头）。
     * WebView 走浏览器内核，能补上这部分，见 components/DanmakuWebViewBridge.tsx。
     */
    if (danmakuWebBridge.ready) {
      this.startWebTransport();
      return;
    }
    dmLog('原生通道失败，且 WebView 通道未就绪 → 退避重连');
    this.scheduleReconnect();
  }

  private startWebTransport(): void {
    dmLog('原生通道全部失败 → 转 WebView 通道（浏览器身份）');
    this.ownsWebBridge = true;
    danmakuWebBridge.onDanmaku = (text: string) => {
      try { this.handlers?.onMessage(text); } catch { /* 忽略 */ }
    };
    danmakuWebBridge.onStatus = (ok: boolean) => {
      try { this.handlers?.onStatus?.(ok); } catch { /* 忽略 */ }
    };
    danmakuWebBridge.onLog = (msg: string) => dmLog(msg);
    danmakuWebBridge.start(this.roomId, this.token, this.servers, this.uid);
  }

  /** 连一个候选并完成认证；成功返回 true */
  private tryServer(url: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let ws: WebSocket | null = null;
      /** 本连接是否已通过认证（op=8）—— 用于区分「认证前被拒」和「认证后掉线」 */
      let authOk = false;
      const finish = (ok: boolean, note: string) => {
        if (settled) return;
        settled = true;
        dmLog(`${ok ? '✅' : '❌'} ${url} → ${note}`);
        if (ok) {
          this.handlers?.onStatus?.(true);
        } else {
          try { ws?.close(); } catch { /* 忽略 */ }
        }
        resolve(ok);
      };

      try {
        ws = new WebSocket(url);
      } catch (err) {
        finish(false, `构造失败 ${String((err as any)?.message || err)}`);
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (!this.active) { finish(false, '已停止'); return; }
        try {
          ws!.send(buildAuthPacket(Number(this.roomId) || 0, this.uid, this.token));
        } catch (err) {
          finish(false, `发送认证包失败 ${String((err as any)?.message || err)}`);
          return;
        }
        this.startAuthWatchdog(() => finish(false, `${AUTH_TIMEOUT_MS}ms 内未收到 op=8`));
      };

      ws.onmessage = (event: any) => {
        const data: Uint8Array | null =
          event?.data instanceof Uint8Array ? event.data
          : event?.data instanceof ArrayBuffer ? new Uint8Array(event.data)
          : null;
        if (!data) return;
        const header = readHeader(data);
        if (!header) return;

        if (header.operation === OP_AUTH_REPLY) {
          // ★ PiliPlus：收到认证回包后才启动心跳
          authOk = true;
          this.reconnectAttempt = 0; // 认证通过 → 本次连接算成功，后续掉线重连从头退避
          this.clearAuthWatchdog();
          this.startHeartbeat();
          finish(true, '认证通过（op=8）');
          return;
        }
        if (header.operation === OP_HEARTBEAT_REPLY) return; // 人气值，忽略

        const texts: string[] = [];
        extractDanmaku(data, texts);
        for (const text of texts) {
          try { this.handlers?.onMessage(text); } catch { /* 忽略 */ }
        }
      };

      ws.onerror = () => {
        // RN 失败时给的是裸 Event（无任何字段），信息以下面的 onclose 为准
      };

      ws.onclose = (ev: any) => {
        if (this.ws === ws) this.ws = null;
        this.stopHeartbeat();
        this.clearAuthWatchdog();
        if (settled) {
          /**
           * ★ 认证通过后的意外掉线 → 自动重连（对齐 PiliPlus LiveMessageStream 的行为）★
           * 之前的实现里 finish 有 settled 守卫，认证成功后连接被服务端/网络断掉时
           * 这里什么都不做 → 弹幕永久静默，只能退出直播间重进。
           */
          if (authOk && this.active) {
            dmLog('连接断开（此前认证已通过）→ 自动重连');
            this.scheduleReconnect(RECONNECT_DROP_BASE_MS);
          }
          return;
        }
        finish(false, `close=${ev?.code ?? '-'} reason=${String(ev?.reason || '(空)')}`);
      };
    });
  }

  /* ───────────────── 心跳 / 看门狗 / 重连 ───────────────── */

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(buildHeartbeatPacket(this.heartbeatSeq)); // 内容为空，seq 递增
        this.heartbeatSeq += 1;
      } catch { /* 忽略 */ }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private startAuthWatchdog(onTimeout: () => void): void {
    this.clearAuthWatchdog();
    this.authWatchdog = setTimeout(onTimeout, AUTH_TIMEOUT_MS);
  }

  private clearAuthWatchdog(): void {
    if (this.authWatchdog) { clearTimeout(this.authWatchdog); this.authWatchdog = null; }
  }

  private scheduleReconnect(baseMs: number = RECONNECT_BASE_MS): void {
    if (!this.active) return;
    // 已有重连在排队时不重复排（掉线回调与失败路径可能同时触发）
    if (this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > RECONNECT_MAX_ATTEMPTS) {
      dmLog(`重连 ${RECONNECT_MAX_ATTEMPTS} 次仍失败，停止重试`);
      this.handlers?.onStatus?.(false);
      return;
    }
    const delay = Math.min(baseMs * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_DELAY_MS);
    dmLog(`${Math.round(delay / 1000)}s 后第 ${this.reconnectAttempt} 次重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.run();
    }, delay);
  }
}

export default BilibiliDanmaku;
