// 语音时长解析测试（纯 Node，零新增依赖）。
//
// 背景：房间语音的载荷里没有时长字段（真机日志实证），只能按 AMR 定长帧算。
// 这个算错的表现是「显示的秒数不对」，比不显示更容易被当真，所以用合成字节钉死。
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'yaya-audio-dur-'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

/** 造一段 AMR-NB：魔数 + N 帧（每帧 1 字节 TOC + frameBytes-1 载荷） */
const amrNb = (frameType, frames) => {
  const frameBytes = [13, 14, 16, 18, 20, 21, 27, 32, 6, 0, 0, 0, 0, 0, 0, 1][frameType];
  const magic = [0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a];
  const bytes = [...magic];
  for (let i = 0; i < frames; i += 1) {
    bytes.push(frameType << 3); // TOC：FT 放在高 4 位
    for (let j = 1; j < frameBytes; j += 1) bytes.push(0);
  }
  return { bytes, total: bytes.length };
};

const amrWb = (frameType, frames) => {
  const frameBytes = [18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 6, 0, 0, 0, 1, 1][frameType];
  const magic = [0x23, 0x21, 0x41, 0x4d, 0x52, 0x2d, 0x57, 0x42, 0x0a];
  const bytes = [...magic];
  for (let i = 0; i < frames; i += 1) {
    bytes.push(frameType << 3);
    for (let j = 1; j < frameBytes; j += 1) bytes.push(0);
  }
  return { bytes, total: bytes.length };
};

try {
  execSync(
    `npx tsc "${join(root, 'src', 'utils', 'audioDuration.ts')}" --rootDir "${root}" --outDir "${tmp}" --module commonjs --target es2019 --moduleResolution node --lib es2020,dom --skipLibCheck`,
    { cwd: root, stdio: 'inherit' },
  );
  const mod = await import(`file://${join(tmp, 'src', 'utils', 'audioDuration.js')}`);
  const {
    parseAmrDurationSeconds,
    parseAacAdtsDurationSeconds,
    parseAudioDurationSeconds,
    totalBytesFromHeaders,
  } = mod;
  if (typeof parseAudioDurationSeconds !== 'function') {
    throw new Error('编译产物里没有 parseAudioDurationSeconds —— 拒绝以「通过」结束');
  }

  await check('AMR-NB：50 帧 × 20ms = 1.0 秒', () => {
    const { bytes, total } = amrNb(0, 50);
    assert.equal(Number(parseAmrDurationSeconds(bytes, total).toFixed(3)), 1);
  });

  await check('AMR-NB：150 帧 = 3.0 秒（对应常见的 3 秒语音）', () => {
    const { bytes, total } = amrNb(0, 150);
    assert.equal(Number(parseAmrDurationSeconds(bytes, total).toFixed(3)), 3);
  });

  await check('AMR-NB：帧长随 FT 变化（FT=7 是 32 字节/帧）', () => {
    const { bytes, total } = amrNb(7, 100);
    assert.equal(Number(parseAmrDurationSeconds(bytes, total).toFixed(3)), 2);
  });

  await check('AMR-WB：40 帧 = 0.8 秒（魔数更长，必须走 WB 分支）', () => {
    const { bytes, total } = amrWb(0, 40);
    assert.equal(Number(parseAmrDurationSeconds(bytes, total).toFixed(3)), 0.8);
  });

  await check('非 AMR（mp3 头）→ 0，交给 Video 探针兜底', () => {
    const mp3 = [0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    assert.equal(parseAmrDurationSeconds(mp3, 40000), 0);
  });

  await check('总长度缺失/过短 → 0（不猜）', () => {
    const { bytes } = amrNb(0, 50);
    assert.equal(parseAmrDurationSeconds(bytes, 0), 0);
    assert.equal(parseAmrDurationSeconds(bytes, 6), 0);
    assert.equal(parseAmrDurationSeconds([], 1000), 0);
  });

  await check('Content-Range 总长度解析（含服务器忽略 Range 的退路）', () => {
    assert.equal(totalBytesFromHeaders('bytes 0-15/12345', null), 12345);
    assert.equal(totalBytesFromHeaders(null, '12345'), 12345);
    assert.equal(totalBytesFromHeaders('bytes 0-15/*', null), 0);
    assert.equal(totalBytesFromHeaders(null, null), 0);
  });

  // ── AAC(ADTS)：真机实测的房间语音就是这个容器（文件头 ff f9 5c 40 14 c0 00 00）──
  /** 造一份真实形态的 ADTS 文件：首帧头取自真机日志（22050Hz / 166 字节/帧 / 1024 采样点） */
  const aac = (frames) => {
    const header = [0xff, 0xf9, 0x5c, 0x40, 0x14, 0xc0, 0x00];
    const frameLength = 166;
    const bytes = [];
    for (let i = 0; i < frames; i += 1) {
      bytes.push(...header);
      for (let j = header.length; j < frameLength; j += 1) bytes.push(0);
    }
    return { bytes, total: bytes.length, expect: (frames * 1024) / 22050 };
  };

  await check('AAC/ADTS：整份在手时逐帧精确（50 帧 = 2.322 秒）', () => {
    const { bytes, total, expect } = aac(50);
    const got = parseAacAdtsDurationSeconds(Uint8Array.from(bytes), total);
    assert.equal(Number(got.toFixed(3)), Number(expect.toFixed(3)));
  });

  await check('AAC/ADTS：真实大小量级（8885 字节 ≈ 2.5 秒，48158 字节 ≈ 13.5 秒）', () => {
    // 用「首帧长度外推」路径验证量级：只给片段 + 真实总长
    const { bytes } = aac(3);
    const short = parseAacAdtsDurationSeconds(Uint8Array.from(bytes.slice(0, 100)), 8885);
    assert.ok(short > 2 && short < 3, `8885 字节应落在 2~3 秒，实际 ${short}`);
    const longer = parseAacAdtsDurationSeconds(Uint8Array.from(bytes.slice(0, 100)), 48158);
    assert.ok(longer > 12 && longer < 15, `48158 字节应落在 12~15 秒，实际 ${longer}`);
  });

  await check('自动识别：AMR 与 AAC 都认，认不出返回 0', () => {
    const nb = amrNb(0, 50);
    assert.ok(parseAudioDurationSeconds(Uint8Array.from(nb.bytes), nb.total) > 0);
    const cd = aac(50);
    assert.ok(parseAudioDurationSeconds(Uint8Array.from(cd.bytes), cd.total) > 0);
    const junk = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09];
    assert.equal(parseAudioDurationSeconds(Uint8Array.from(junk), 100), 0);
  });

  await check('AAC：采样率非法（index 13~15）→ 0，不瞎算', () => {
    const bad = [0xff, 0xf9, 0x37, 0x40, 0x14, 0xc0, 0x00]; // index=13 → 表中为 0
    assert.equal(parseAacAdtsDurationSeconds(Uint8Array.from(bad), 9999), 0);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n      ${r.error?.message || r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[audio-duration] 结果：${results.length - failed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
