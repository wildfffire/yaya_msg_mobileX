/**
 * 屏蔽词（口袋48 发言过滤）缓存与检测。
 *
 * 链路（与上游一致）：
 *   1. `home/api/check/maskword` 只返回**词表文件地址**（url / ordinaryUrl / starUrl）；
 *   2. 再拉那个地址，得到一行一词的纯文本（`source.48.cn` 静态文件）；
 *   3. 解析成词数组后本地缓存 24h，发送前做一次命中检测。
 *
 * 约定：
 * - 词表是全平台通用的，与账号无关，所以不随 token 变化作废；
 * - 任何一步失败都不抛错（宁可放过，不可把发送功能卡死），失败时沿用旧缓存；
 * - 无 token / 配置接口不可用时直连官方兜底词表（上游同款地址）。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import pocketApi from '../api/pocket48';
import { requestJson } from '../utils/network';
import { logInfo, logWarn } from '../utils/runtimeLog';
import { findMaskWords, parseMaskWordsText } from '../utils/maskWords';

const CACHE_KEY = 'yaya_mask_words_v1';
/** 词表变更频率很低，一天一刷足够 */
const TTL_MS = 24 * 60 * 60 * 1000;
/** 配置接口拿不到地址时的官方兜底词表 */
const FALLBACK_URL = 'https://source.48.cn/app_mask_words/2023110101.utf8';

type MaskWordsCache = { at: number; words: string[] };

let memory: MaskWordsCache | null = null;
let cacheLoaded = false;
let inflight: Promise<string[]> | null = null;

function isFresh(at: number): boolean {
  return Number.isFinite(at) && Date.now() - at < TTL_MS;
}

async function readCache(): Promise<MaskWordsCache | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const words = Array.isArray(parsed?.words) ? parsed.words.filter((w: unknown) => typeof w === 'string') : [];
    const at = Number(parsed?.at) || 0;
    if (!words.length) return null;
    return { at, words };
  } catch {
    return null;
  }
}

async function writeCache(words: string[]): Promise<void> {
  const payload: MaskWordsCache = { at: Date.now(), words };
  memory = payload;
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // 存储失败不影响本次使用（memory 里已有）
  }
}

async function fetchFromFallback(): Promise<string[]> {
  try {
    const text = await requestJson<any>(FALLBACK_URL, { method: 'GET', timeout: 10000 });
    return parseMaskWordsText(typeof text === 'string' ? text : '');
  } catch {
    return [];
  }
}

/** 取词表（默认走缓存；force 强制刷新）。永不 reject。 */
export async function loadMaskWords(force = false): Promise<string[]> {
  if (!cacheLoaded) {
    memory = await readCache();
    cacheLoaded = true;
  }
  if (!force && memory && isFresh(memory.at)) return memory.words;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await pocketApi.getPocketMaskWords(0);
      const words: string[] = Array.isArray((res as any)?.content?.words) ? (res as any).content.words : [];
      if (words.length) {
        await writeCache(words);
        logInfo(`[mask] 词表已更新：${words.length} 条`, 'mask');
        return words;
      }
    } catch (err) {
      logWarn(`[mask] 配置接口失败，改用兜底词表：${String((err as any)?.message || err)}`, 'mask');
    }
    const fallback = await fetchFromFallback();
    if (fallback.length) {
      await writeCache(fallback);
      logInfo(`[mask] 已使用兜底词表：${fallback.length} 条`, 'mask');
      return fallback;
    }
    // 全失败：沿用旧缓存（哪怕过期），没有就当作「无屏蔽词」
    return memory?.words ?? [];
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/**
 * 发送前检测：返回命中的词（空数组 = 可以发）。
 * 只做本地匹配，不产生网络等待（除首次拉词表外）。
 */
export async function checkMaskWords(text: string): Promise<string[]> {
  try {
    const words = await loadMaskWords();
    return findMaskWords(text, words);
  } catch {
    return [];
  }
}
