/**
 * 语音时长解析（房间语音「必须都有秒数」的确定性方案）。
 *
 * ══ 为什么需要它（2026-09-28 真机日志实证）══
 *   房间语音消息的**载荷里没有任何时长字段** —— 项目自带的诊断日志
 *   `[diag:duration:audio] candidates=` 打出来只有 `{"msgTime":...}`。
 *   也就是说时长只能从**音频文件本身**量出来。
 *
 *   原来唯一的手段是卡片里挂一个「隐藏 Video 探针」等 `onLoad`。它对
 *   「已暂停 / 被列表裁剪 / 卡片被复用」都不稳定，表现就是
 *   「有的语音有、有的没有，同一条还忽有忽无」。
 *
 * ══ 这里怎么做 ══
 *   只取**文件头 16 字节**，再用响应里的总长度算时长：不下载整个文件、不放音、不占音频焦点。
 *     · AMR-NB / AMR-WB 是**定长帧**格式（每帧固定 20ms），帧长由首帧 TOC 的 FT 字段决定：
 *         时长 = (总字节 − 魔数长度) ÷ 帧长 × 20ms
 *       误差 < 40ms，足够显示「12s」这种量级。
 *     · 非 AMR（mp3 / m4a / aac 等）返回 0，交给原来的 Video 探针兜底，行为不倒退。
 *
 * 帧长表来自 AMR 规范（RTP/存储格式），单位：字节（含每帧 1 字节的 TOC 头）。
 */

import { POCKET_MEDIA_HEADERS } from './mediaHeaders';

/** AMR-NB 魔数 `#!AMR\n` */
const AMR_NB_MAGIC = [0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a];
/** AMR-WB 魔数 `#!AMR-WB\n` */
const AMR_WB_MAGIC = [0x23, 0x21, 0x41, 0x4d, 0x52, 0x2d, 0x57, 0x42, 0x0a];

/** AMR-NB 各 FT 的帧长（字节，含 TOC）；0 = 该 FT 无效 */
const AMR_NB_FRAME_BYTES = [13, 14, 16, 18, 20, 21, 27, 32, 6, 0, 0, 0, 0, 0, 0, 1];
/** AMR-WB 各 FT 的帧长（字节，含 TOC） */
const AMR_WB_FRAME_BYTES = [18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 6, 0, 0, 0, 1, 1];

const FRAME_MS = 20;

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) if (bytes[i] !== magic[i]) return false;
  return true;
}

/**
 * 从 AMR 文件头 + 总长度算出时长（秒）。
 * @param head 文件开头至少 16 字节
 * @param totalBytes 文件总字节数
 * @returns 秒数（四舍五入前的原值）；无法判定时返回 0
 */
export function parseAmrDurationSeconds(head: Uint8Array | number[], totalBytes: number): number {
  const bytes = head instanceof Uint8Array ? head : Uint8Array.from(head);
  let magicLen = 0;
  let frameBytes = 0;

  if (startsWith(bytes, AMR_WB_MAGIC)) {
    magicLen = AMR_WB_MAGIC.length;
    frameBytes = AMR_WB_FRAME_BYTES[(bytes[magicLen] >> 3) & 0x0f];
  } else if (startsWith(bytes, AMR_NB_MAGIC)) {
    magicLen = AMR_NB_MAGIC.length;
    frameBytes = AMR_NB_FRAME_BYTES[(bytes[magicLen] >> 3) & 0x0f];
  } else {
    return 0;
  }

  if (!frameBytes) return 0;
  const frames = Math.floor((Number(totalBytes) - magicLen) / frameBytes);
  if (!Number.isFinite(frames) || frames <= 0) return 0;
  return (frames * FRAME_MS) / 1000;
}

/**
 * 解析 `Content-Range: bytes 0-15/12345` 里的总长度。
 * 服务器忽略 Range 时改用 `Content-Length`（语音文件小，全量下载也可接受）。
 */
export function totalBytesFromHeaders(contentRange: string | null, contentLength: string | null): number {
  const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(contentRange || '');
  if (m) return Number(m[1]);
  const n = Number(contentLength || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** url → 秒数字符串（'' 表示未解析出）。模块级缓存：卡片被列表复用时不必重新请求 */
const cache = new Map<string, string>();

/** 读缓存（同步，供渲染首帧就用上） */
export function cachedAudioDuration(url: string): string {
  return url ? cache.get(url) || '' : '';
}

/** 写缓存（Video 探针那条路也复用同一份，避免两个缓存各自为政） */
export function rememberAudioDuration(url: string, seconds: string) {
  if (url && seconds) cache.set(url, seconds);
}

/** 诊断日志限频：同一条 url 只打一次，避免刷屏（打进 App 内置运行日志面板） */
const diagLogged = new Set<string>();

/** ADTS 采样率表（sampling_frequency_index → Hz） */
const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0,
];

/**
 * AAC(ADTS) 时长。
 *
 * ⚠️ 为什么必须有它：真机日志实证（2026-09-28）房间语音文件头是
 *   `ff f9 5c 40 14 c0 00 00` —— 这是 **ADTS 封装的 AAC**（同步字 0xFFF + layer 00），
 *   **不是 AMR**。只写 AMR 解析器时一个都算不出来（表现：秒数永远不出现）。
 *
 * ADTS 的每帧带 1024 个采样点（`raw_data_blocks` 不为 0 时按倍数），帧长写在帧头的 13 bit 里。
 * 服务器实测会忽略 Range、把整份文件返回（语音只有几十 KB），所以这里优先**逐帧精确累加**；
 * 只拿到片段时再用首帧长度外推（ADTS 基本定长帧，误差很小）。
 */
export function parseAacAdtsDurationSeconds(bytes: Uint8Array, totalBytes: number): number {
  if (bytes.length < 7) return 0;
  if (bytes[0] !== 0xff || (bytes[1] & 0xf0) !== 0xf0) return 0;
  const sampleRate = AAC_SAMPLE_RATES[(bytes[2] >> 2) & 0x0f];
  if (!sampleRate) return 0;

  let offset = 0;
  let samples = 0;
  let frames = 0;
  while (offset + 7 <= bytes.length && frames < 20000) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf0) !== 0xf0) break;
    const frameLength =
      ((bytes[offset + 3] & 0x03) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
    if (frameLength < 7) break;
    samples += 1024 * ((bytes[offset + 6] & 0x03) + 1);
    frames += 1;
    offset += frameLength;
  }

  // 整份都在手里（服务器没截断）且逐帧走到了尾 → 精确值
  if (frames > 0 && offset >= bytes.length - 8 && bytes.length >= totalBytes) {
    return samples / sampleRate;
  }
  // 否则用首帧长度外推
  const firstFrame = ((bytes[3] & 0x03) << 11) | (bytes[4] << 3) | (bytes[5] >> 5);
  if (firstFrame < 7 || !(totalBytes > 0)) return 0;
  const estimatedFrames = Math.floor((totalBytes - 7) / firstFrame);
  return estimatedFrames > 0 ? (estimatedFrames * 1024) / sampleRate : 0;
}

/**
 * 按文件头自动识别格式算时长（AMR 优先，其次 AAC/ADTS）。
 * 识别不出返回 0，交给卡片里的隐藏 Video 探针兜底。
 */
export function parseAudioDurationSeconds(bytes: Uint8Array, totalBytes: number): number {
  const amr = parseAmrDurationSeconds(bytes, totalBytes);
  if (amr > 0) return amr;
  return parseAacAdtsDurationSeconds(bytes, totalBytes);
}

/**
 * 通过「取文件头」解析时长。失败（网络 / 非 AMR / 无长度）返回 0，不抛错。
 * 只发一次 16 字节的 Range 请求，代价可以忽略。
 *
 * ⚠️⚠️ 必须带 `POCKET_MEDIA_HEADERS`：48 的媒体 CDN 校验 UA / Referer / Origin，
 *    **裸 fetch 会被直接拒**（403）。这正是本功能第一版失败的原因（2026-09-28 实证）：
 *    播放器走 `playerSource()` 带了头所以能播、封面也能出，而这边没带 → 时长永远拿不到。
 */
export async function resolveAudioDurationFromUrl(url: string): Promise<number> {
  if (!url) return 0;
  try {
    const res = await fetch(url, { headers: { ...POCKET_MEDIA_HEADERS, Range: 'bytes=0-15' } });
    const buf = await res.arrayBuffer();
    const head = new Uint8Array(buf).subarray(0, 16);
    const total = totalBytesFromHeaders(
      res.headers.get('content-range'),
      res.headers.get('content-length'),
    );
    const okStatus = res.ok || res.status === 206;
    // 注意：服务器实测会忽略 Range 并把整份返回（got == total），所以这里把完整 buffer 交给解析器，
    // 它会在「整份都在手里」时逐帧精确累加，否则退化为按首帧长度外推。
    const seconds = okStatus ? parseAudioDurationSeconds(new Uint8Array(buf), total) : 0;
    if (!(seconds > 0) && !diagLogged.has(url)) {
      diagLogged.add(url);
      // 真机排障用：status / 总长度 / 实际拿到多少字节 / 头 8 字节 hex / url
      //（若这里 status=403 → 是防盗链头没生效；若 hex 不是 23 21 → 文件不是 AMR，要加别的格式分支）
      // eslint-disable-next-line no-console
      console.log(
        `[audioDur] status=${res.status} total=${total} got=${buf.byteLength} hex=${Array.from(head.slice(0, 8))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')} url=${url.slice(0, 80)}`,
      );
    }
    return seconds;
  } catch (e) {
    if (!diagLogged.has(url)) {
      diagLogged.add(url);
      // eslint-disable-next-line no-console
      console.log(`[audioDur] fetch 失败：${String((e as Error)?.message || e)} url=${url.slice(0, 80)}`);
    }
    return 0;
  }
}
