/**
 * 成员房间消息（云信 QChat / 圈组）原生桥 —— commonlink 协议版。
 *
 * 原生实现：android/app/src/main/java/com/yk1z/yayamsg/nim/
 *   NimCommonlinkSession.kt（TCP + RSA 握手 + RC4 + 请求应答）
 *   NimQChatClient.kt（NIM 会话 → 24/1 取 QChat 地址 → QChat 会话 → 收 24/11 / 发 24/10）
 *
 * 关键：登录鉴权属性里包名自己填（白名单包 `com.seine48.app`），
 * 官方 SDK 只能带真实包名 → 服务端拒（实测 414）。
 */

import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { NATIVE_SEND_TIMEOUT_MS, withNativeTimeout } from './timeout';

interface PocketNimQChatNative {
  connect(appKey: string, account: string, token: string): Promise<boolean>;
  send(serverId: string, channelId: string, text: string, extJson: string): Promise<string>;
  disconnect(): void;
}

const native: PocketNimQChatNative | undefined = (NativeModules as any)?.PocketNimQChat;

export function isPocketNimQChatAvailable(): boolean {
  return Platform.OS === 'android' && !!native;
}

export interface QChatNativeMessage {
  serverId: string;
  channelId: string;
  fromAccount: string;
  fromNick: string;
  time: number;
  /** 0 = 文本，100 = 自定义 */
  type: number;
  body: string;
  attachment: string;
  /** remoteExtension 的 JSON 字符串 */
  ext: string;
  msgIdClient: string;
  msgIdServer: string;
}

export async function qchatConnect(appKey: string, account: string, token: string): Promise<void> {
  if (!native) throw new Error('当前平台不支持原生房间消息通道');
  await native.connect(appKey, account, token);
}

/**
 * 返回 msgIdClient（发送成功由服务端应答确认，这里 await 到应答后返回）。
 *
 * ⚠️ 必须带超时：原生若不回应答，await 永久挂起 → 发送按钮永远转圈，
 * 且 qchat.ts 里那段「失败就重连重试」的兜底**根本不会触发**（它只在 reject 时跑）。
 * 注：`qchatConnect` 的超时已在调用侧（services/pocketNim/qchat.ts 的 Promise.race）处理，
 * 这里不重复包一层，避免两个超时语义叠在一起难以排查。
 */
export async function qchatSend(
  serverId: string,
  channelId: string,
  text: string,
  extJson: string
): Promise<string> {
  if (!native) throw new Error('当前平台不支持原生房间消息通道');
  // 用发送专用的 30s（比连接类宽）：超时会触发调用方「重连 + 重发」，
  // 而原生 send 是「等服务端应答才 resolve」—— 15s 判失败可能造成重复发消息。
  return withNativeTimeout(native.send(serverId, channelId, text, extJson), '房间消息发送', NATIVE_SEND_TIMEOUT_MS);
}

export function qchatDisconnect(): void {
  native?.disconnect?.();
}

export function onQChatStatus(listener: (status: { state: string; detail: string }) => void): () => void {
  const sub = DeviceEventEmitter.addListener('PocketNimQChat:status', (e: any) => {
    listener({ state: String(e?.state || 'idle'), detail: String(e?.detail || '') });
  });
  return () => sub.remove();
}

export function onQChatMessage(listener: (message: QChatNativeMessage) => void): () => void {
  const sub = DeviceEventEmitter.addListener('PocketNimQChat:message', (e: any) => {
    listener({
      serverId: String(e?.serverId || ''),
      channelId: String(e?.channelId || ''),
      fromAccount: String(e?.fromAccount || ''),
      fromNick: String(e?.fromNick || ''),
      time: Number(e?.time) || Date.now(),
      type: Number(e?.type ?? 0),
      body: String(e?.body || ''),
      attachment: String(e?.attachment || ''),
      ext: String(e?.ext || '{}'),
      msgIdClient: String(e?.msgIdClient || ''),
      msgIdServer: String(e?.msgIdServer || ''),
    });
  });
  return () => sub.remove();
}
