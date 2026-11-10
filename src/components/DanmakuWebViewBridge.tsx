/**
 * 弹幕的 **WebView 传输通道**（原生 WebSocket 被服务端拒绝时的兜底，且是更可靠的方案）
 *
 * # 为什么需要它
 *
 * 真机取证链（本机 Node 侧无论如何都能连上，App 100% 失败）：
 *   1. 裸连接（**不发**认证包）能活 **5102ms** → 网络、TLS、RN 的 WebSocket 全都正常；
 *   2. 一发认证包立刻被断（立即发 ~12-33ms，延后 1.2s 发 ~225ms）→ **与发送时机无关**；
 *   3. 认证包字节已逐字节比对过 PiliPlus 与本机可用实现 → **完全一致**；
 *   4. Node 侧换 UA / Origin / Cookie / protover / 帧类型 / 爆发连接 → **全部通过**。
 *
 * ⇒ 排除完所有可控变量后，剩下的差异只有一个：**客户端身份**（TLS 指纹 + 缺失的浏览器请求头）。
 *   RN 走的是 OkHttp，而票据（token）是按「浏览器」那一套签发的 —— 两者不一致。
 *
 * # 本方案的思路
 *
 * 把弹幕连接放到 **WebView** 里跑：浏览器内核自带
 *   - 浏览器的 TLS 指纹
 *   - 浏览器标准的 WebSocket 请求头（User-Agent / Origin / Referer / Accept-Language …）
 * 并且通过 `baseUrl: 'https://live.bilibili.com/'` 把文档 origin 设成 B站直播页，
 * 这样握手时的 `Origin` 就是 `https://live.bilibili.com`，与网页端完全一致。
 *
 * WebView 内部用 `protover: 1`（服务端下发**不压缩**的 JSON），避免依赖浏览器端的解压能力。
 */

import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

const DANMU_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>dm</title></head>
<body><script>
(function () {
  var ws = null, hbTimer = null, hbSeq = 1, idx = 0, servers = [], roomId = 0, token = '', uid = 0;

  function say(obj) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch (e) {}
  }
  function enc(s) { return new TextEncoder().encode(s); }
  function dec(u8) {
    try { return new TextDecoder().decode(u8); } catch (e) {
      var o = ''; for (var i = 0; i < u8.length; i++) o += String.fromCharCode(u8[i]); return o;
    }
  }
  function packet(op, body) {
    var b = body ? enc(body) : new Uint8Array(0);
    var out = new Uint8Array(16 + b.length);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, 16 + b.length);
    dv.setUint16(4, 16);
    dv.setUint16(6, 1);
    dv.setUint32(8, op);
    dv.setUint32(12, 1);
    if (b.length) out.set(b, 16);
    return out;
  }
  function heartbeat() {
    var out = new Uint8Array(16);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, 16); dv.setUint16(4, 16); dv.setUint16(6, 1);
    dv.setUint32(8, 2); dv.setUint32(12, hbSeq++);
    return out;
  }
  function readHeader(u8) {
    if (u8.length < 16) return null;
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { total: dv.getUint32(0), hsize: dv.getUint16(4), ver: dv.getUint16(6), op: dv.getUint32(8) };
  }
  /** 取包体（ver=2 走浏览器的 DecompressionStream 解压）；回调在拿到数据后触发 */
  function getBody(u8, h, cb) {
    var raw = u8.subarray(h.hsize, Math.min(h.total, u8.length));
    if (h.ver === 0 || h.ver === 1) { cb(raw); return; }
    if (h.ver === 2) {
      // B站的 ver=2 是 zlib（服务端按 protover=2 下发）
      if (typeof DecompressionStream === 'undefined') {
        say({ type: 'log', msg: 'web: 无 DecompressionStream，无法解压 ver=2' });
        cb(null);
        return;
      }
      try {
        var ds = new DecompressionStream('deflate');
        var w = ds.writable.getWriter();
        w.write(raw);
        w.close();
        new Response(ds.readable).arrayBuffer().then(function (buf) { cb(new Uint8Array(buf)); }).catch(function () { cb(null); });
      } catch (e) { cb(null); }
      return;
    }
    say({ type: 'log', msg: 'web: 不支持的压缩 ver=' + h.ver });
    cb(null);
  }

  function handle(u8) {
    var h = readHeader(u8);
    if (!h || h.total < 16) return;
    // 同一帧里后续的包
    var next = function () { if (h.total < u8.length) handle(u8.subarray(h.total)); };

    if (h.op === 8) {
      startHeartbeat();
      say({ type: 'status', ok: true });
      say({ type: 'log', msg: 'web: 认证通过 op=8' });
      next();
      return;
    }
    if (h.op === 3) { next(); return; } // 心跳回复（人气值），不处理
    /**
     * ★ 压缩包（ver=2/3）：解压后的内容是「若干个完整数据包」，要递归处理，
     *   不能直接当 JSON 解析 —— 与 PiliPlus 的处理保持一致。
     */
    if (h.ver === 2 || h.ver === 3) {
      getBody(u8, h, function (body) { if (body && body.length) handle(body); next(); });
      return;
    }
    if (h.op === 5) {
      getBody(u8, h, function (body) {
        if (body && body.length) {
          try {
            var json = JSON.parse(dec(body));
            // ★ cmd 必须前缀匹配：真实弹幕是 "DANMU_MSG:4:0:2:2:2:0"（带后缀），精确等值匹配一条都拿不到
            if (json && json.cmd && String(json.cmd).indexOf('DANMU_MSG') === 0 && Array.isArray(json.info)) {
              var t = String(json.info[1] == null ? '' : json.info[1]);
              if (t) say({ type: 'danmaku', text: t });
            }
          } catch (e) {}
        }
        next();
      });
      return;
    }
    next();
  }
  function startHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(function () {
      if (ws && ws.readyState === 1) { try { ws.send(heartbeat()); } catch (e) {} }
    }, 30000);
  }
  function connect() {
    if (idx >= servers.length) {
      say({ type: 'status', ok: false });
      say({ type: 'log', msg: 'web: 全部候选失败' });
      return;
    }
    var url = servers[idx++];
    say({ type: 'log', msg: 'web: 连接 ' + url });
    try { ws = new WebSocket(url); } catch (e) { setTimeout(connect, 300); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      say({ type: 'log', msg: 'web: open ' + url });
      ws.send(packet(7, JSON.stringify({
        roomid: Number(roomId), uid: Number(uid), protover: 1, platform: 'web', type: 2, key: token
      })));
    };
    ws.onmessage = function (ev) { try { handle(new Uint8Array(ev.data)); } catch (e) {} };
    ws.onerror = function () {};
    ws.onclose = function (ev) {
      say({ type: 'log', msg: 'web: close=' + ev.code + ' reason=' + (ev.reason || '') });
      setTimeout(connect, 400);
    };
  }
  function onRnMessage(e) {
    var m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.type === 'start') {
      roomId = m.roomId; token = m.token; servers = m.servers || []; uid = Number(m.uid) || 0; idx = 0;
      say({ type: 'log', msg: 'web: start room=' + roomId + ' uid=' + uid + ' tokenLen=' + String(token || '').length });
      connect();
    } else if (m.type === 'stop') {
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
      if (ws) { try { ws.close(); } catch (err) {} }
      ws = null;
    }
  }
  // 安卓上 react-native-webview 派发到 document，iOS 派发到 window —— 两个都监听
  document.addEventListener('message', onRnMessage);
  window.addEventListener('message', onRnMessage);
  say({ type: 'log', msg: 'web: ready' });
})();
</script></body></html>`;

/** WebView → RN 的桥接单例：让纯类（BilibiliDanmaku）也能驱动这个 React 组件 */
class DanmakuWebBridge {
  private web: any = null;
  private queue: any[] = [];

  onDanmaku: ((text: string) => void) | null = null;
  onStatus: ((ok: boolean) => void) | null = null;
  onLog: ((msg: string) => void) | null = null;

  attach(web: any): void {
    this.web = web;
    const pending = this.queue;
    this.queue = [];
    for (const m of pending) this.post(m);
  }

  detach(): void {
    this.web = null;
  }

  get ready(): boolean {
    return !!this.web;
  }

  start(roomId: string, token: string, servers: string[], uid: number): void {
    this.post({ type: 'start', roomId, token, servers, uid });
  }

  stop(): void {
    this.post({ type: 'stop' });
  }

  private post(msg: any): void {
    if (this.web) {
      try { this.web.postMessage(JSON.stringify(msg)); } catch { /* 忽略 */ }
    } else {
      this.queue.push(msg); // WebView 还没挂载：先排队，attach 后补发
    }
  }
}

export const danmakuWebBridge = new DanmakuWebBridge();

export default function DanmakuWebViewBridge() {
  const ref = useRef<any>(null);

  useEffect(() => {
    danmakuWebBridge.attach(ref.current);
    return () => {
      danmakuWebBridge.stop();
      danmakuWebBridge.detach();
    };
  }, []);

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={ref}
        /**
         * baseUrl 决定了文档 origin —— 设为 B站直播页后，
         * WebView 内 new WebSocket() 的握手会带上 Origin: https://live.bilibili.com，
         * 与网页端行为一致（这也是原生 OkHttp 做不到的部分）。
         */
        source={{ html: DANMU_HTML, baseUrl: 'https://live.bilibili.com/' }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled={false}
        onMessage={(event: any) => {
          try {
            const msg = JSON.parse(event?.nativeEvent?.data || '{}');
            if (msg.type === 'danmaku') danmakuWebBridge.onDanmaku?.(msg.text);
            else if (msg.type === 'status') danmakuWebBridge.onStatus?.(!!msg.ok);
            else if (msg.type === 'log') danmakuWebBridge.onLog?.(msg.msg);
          } catch { /* 忽略 */ }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // 不可见但必须真正挂载（0 尺寸在部分 WebView 上会暂停 JS）
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
});
