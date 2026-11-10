/**
 * 口袋48 屏蔽词（发言过滤）纯规则。
 *
 * 服务端 `home/api/check/maskword` 返回的**不是词表本身**，而是词表文件地址：
 * `content.url` / `ordinaryUrl` / `starUrl` 指向 `source.48.cn` 上的纯文本，
 * 一行一个词（可能带 UTF-8 BOM）。这里把「解析文本 → 命中检测」做成纯函数，
 * 便于 `scripts/mask-words.test.mjs` 直接跑，也避免 UI 与网络层各写一份。
 */

/** 解析词表文本：去 BOM、按行切（兼容 CRLF / LF）、逐行 trim、丢弃空行 */
export function parseMaskWordsText(text: string): string[] {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * 命中检测：返回命中的词（按词表顺序、去重）。
 *
 * 规则：
 * - 英文忽略大小写；中文按原样匹配（`toLowerCase` 对中文是恒等变换）
 * - 单字符词不参与拦截：官方词表里有大量语气词/标点，命中率过高会误伤正常发言
 * - 空词、纯空白词直接跳过
 */
export function findMaskWords(text: string, words: readonly string[]): string[] {
  const source = String(text || '');
  if (!source || !words || words.length === 0) return [];
  const sourceLower = source.toLowerCase();
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const raw of words) {
    const word = String(raw || '').trim();
    if (!word) continue;
    // 单字符（含 emoji 单码点）不算：`[...word].length` 按码点计数，避免把 emoji 当多字符
    if ([...word].length < 2) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    if (!sourceLower.includes(key)) continue;
    seen.add(key);
    hits.push(word);
  }
  return hits;
}
