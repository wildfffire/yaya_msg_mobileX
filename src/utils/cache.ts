/**
 * 通用缓存原语。
 *
 * 背景：项目里曾把「Map 超限就淘汰最旧项」这段逻辑**复制了 5 遍**
 * （utils/network.ts、services/musicPlayer.ts 两份、services/roomBgCache.ts、
 *  services/replayProgress.ts、services/downloads.ts），
 * 每份写法还略有差异 → 修一处忘一处。统一到这里。
 */

/** 按插入顺序淘汰最旧项，把 Map 压到 max 以内（Map 迭代顺序 = 插入顺序） */
export function trimToMax<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * 对象版 LRU 裁剪：**从 record 中删除**最旧的若干项，并返回被删的 [key, value] 列表
 * （调用方可据此清理对应外部资源，如已落盘的背景图文件）。
 * 用于以 `Record<K, V>` 而非 Map 存储的缓存（如 roomBgCache / replayProgress）。
 */
export function trimRecordToMax<V>(record: Record<string, V>, max: number): Array<[string, V]> {
  const keys = Object.keys(record);
  if (keys.length <= max) return [];
  const dropped: Array<[string, V]> = [];
  for (const k of keys.slice(0, keys.length - max)) {
    dropped.push([k, record[k]]);
    delete record[k];
  }
  return dropped;
}

/**
 * 「同 key 并发调用只真正执行一次」包装。
 * 解决多处在途去重缺失导致的重复下载 / 重复构建（如歌词索引、房间背景图）。
 *
 * 用法：
 *   const once = createInflight();
 *   const data = await once.run('lyrics-index', () => fetch(...));
 */
export function createInflight() {
  const inflight = new Map<string, Promise<unknown>>();
  return {
    /** 已有同 key 在途则复用；否则执行 fetcher 并登记（settle 后自动清理） */
    run<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
      const existing = inflight.get(key);
      if (existing) return existing as Promise<T>;
      const task = fetcher().finally(() => {
        // 只清理自己登记的那条（避免并发覆盖时把新任务删掉）
        if (inflight.get(key) === task) inflight.delete(key);
      });
      inflight.set(key, task);
      return task;
    },
    /** 当前在途数量（诊断用） */
    get size() {
      return inflight.size;
    },
  };
}
