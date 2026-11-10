/**
 * 取值 / 取文本 / 归一 URL 的**无依赖纯函数**。
 *
 * 为什么从 `utils/data.ts` 里分出来：`data.ts` 顶部 `import { translate } from '../i18n'`
 * （i18n 又依赖 react 与 store），所以任何被 `scripts/*.test.mjs` 编译后在纯 Node 里
 * 执行的模块只要 import 了 `data.ts`，就会因找不到 react 而直接崩 ——
 * 纯规则层（如 `watchMeta`）为了能进单测必须绕开它。
 * 这三个函数是全仓唯一实现，`data.ts` 原样再导出，既有调用方零改动。
 */

export function getPath(obj: any, path: string): any {
  return path.split('.').reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj);
}

export function pickText(obj: any, paths: string[], fallback = ''): string {
  for (const path of paths) {
    const value = getPath(obj, path);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value);
    }
  }
  return fallback;
}

export function normalizeUrl(value: any): string {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('/')) return `https://source.48.cn${raw}`;
  return raw;
}
