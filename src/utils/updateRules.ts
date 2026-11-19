/**
 * 版本更新判定（纯函数，零依赖，可直接编译进 Node 单测）。
 *
 * ★ 为什么必须有这层（2026-11-19 修的真实 bug）：
 *   发布 tag 形如 `v3.0.0-b3000075`，旧实现只比较点分版本号
 *   （`isNewerVersion(tag, APP_VERSION)`），把 tag 里的 `-b3000075` 当成
 *   第 4 段数字 → 永远 > `3.0.0`。结果是**装了最新包的用户也会一直看到红点**，
 *   真正的新版本反而被淹没。
 *
 * 定版规则（与出包约定一致：versionName 走语义版本，versionCode 逐包递增）：
 *   ① release tag 带构建号（`-b<build>`）且本地也有构建号 →
 *      **构建号不同就只比构建号**（构建号全局单调递增，比版本名更权威）；
 *   ② 构建号相同 → 再比语义版本（允许「同一构建号、补发更高版本名」的场景）；
 *   ③ release 没有构建号（老的 `v3.0.0` 那种）→ 只比语义版本。
 */

export interface ReleaseTagInfo {
  /** 原始 tag（如 v3.0.0-b3000075） */
  tag: string;
  /** 语义版本（去掉 v 前缀与构建号，如 3.0.0） */
  version: string;
  /** 构建号（-b3000075 → 3000075）；没有则 0 */
  build: number;
}

/** 从 tag 里解析语义版本与构建号；脏数据一律降级为空值，不抛错 */
export function parseReleaseTag(tag: unknown): ReleaseTagInfo {
  const raw = String(tag || '').trim();
  const stripped = raw.replace(/^v/i, '');
  // -b3000075 / -build3000075 / +b3000075 都认
  const buildMatch = stripped.match(/[-+_.]?b(?:uild)?\s*(\d+)/i);
  const build = buildMatch ? Number(buildMatch[1]) || 0 : 0;
  const version = stripped.split(/[-+]/)[0].trim();
  return { tag: raw, version, build };
}

/** 语义版本 → 数字段；非数字段忽略（与旧实现口径一致） */
export function versionSegments(version: unknown): number[] {
  return String(version || '')
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((seg) => parseInt(seg, 10))
    .filter((n) => !Number.isNaN(n));
}

/** a 比 b 新返回 >0，相等返回 0，更旧返回 <0 */
export function compareVersions(a: unknown, b: unknown): number {
  const x = versionSegments(a);
  const y = versionSegments(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) {
    const ax = x[i] || 0;
    const by = y[i] || 0;
    if (ax > by) return 1;
    if (ax < by) return -1;
  }
  return 0;
}

export interface UpdateEvaluation {
  hasUpdate: boolean;
  /** release 解析结果（tag 为空时全空） */
  release: ReleaseTagInfo;
  /** 判定依据，便于日志排查：build / version */
  reason: 'none' | 'build' | 'version';
}

/**
 * 本地版本是否落后于 release tag。
 * `currentVersion` = APP_VERSION（如 3.0.0），`currentBuild` = APP_BUILD（如 3000075）。
 */
export function evaluateUpdate(
  tag: unknown,
  currentVersion: unknown,
  currentBuild: unknown,
): UpdateEvaluation {
  const release = parseReleaseTag(tag);
  const localBuild = Number(currentBuild) || 0;
  if (!release.tag) return { hasUpdate: false, release, reason: 'none' };

  if (release.build > 0 && localBuild > 0) {
    if (release.build !== localBuild) {
      return { hasUpdate: release.build > localBuild, release, reason: 'build' };
    }
    // 构建号相同：只有版本名更高才算新（补发更高语义版本）
    const cmp = compareVersions(release.version, currentVersion);
    return { hasUpdate: cmp > 0, release, reason: cmp > 0 ? 'version' : 'none' };
  }

  const cmp = compareVersions(release.version, currentVersion);
  return { hasUpdate: cmp > 0, release, reason: cmp > 0 ? 'version' : 'none' };
}

/** 展示用标签：`v3.0.0 · Build 3000075`（没有构建号时只显示版本） */
export function releaseLabel(tag: unknown): string {
  const info = parseReleaseTag(tag);
  const version = info.version || info.tag;
  if (!version) return '';
  return info.build > 0 ? `v${version} · Build ${info.build}` : `v${version}`;
}

/**
 * Release 附件名（与出包脚本 scripts/build-apk.js 的命名一致）：
 *   yaya-msg-mobile-v3.0.0-b3000078-v8a.apk
 * 用于在不调 GitHub API 的情况下拼出「点了直接下载」的直链。
 */
export function releaseApkAssetName(tag: unknown): string {
  const info = parseReleaseTag(tag);
  if (!info.tag || !info.version) return '';
  return info.build > 0
    ? `yaya-msg-mobile-v${info.version}-b${info.build}-v8a.apk`
    : `yaya-msg-mobile-v${info.version}-v8a.apk`;
}

/**
 * GitHub Release 附件直链（点击即下载 APK）。
 * `downloadBase` 形如 `https://github.com/<owner>/<repo>/releases/download`。
 * tag/附件名不完整时返回空串，调用方退回 Release 页面。
 */
export function releaseApkUrl(tag: unknown, downloadBase: string): string {
  const info = parseReleaseTag(tag);
  const asset = releaseApkAssetName(tag);
  const base = String(downloadBase || '').replace(/\/+$/, '');
  if (!info.tag || !asset || !base) return '';
  return `${base}/${encodeURIComponent(info.tag)}/${asset}`;
}
