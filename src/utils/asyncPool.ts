/**
 * 并发受限的 map（零依赖）。
 *
 * 房间详情 / 预览快扫都不能一次把几十个请求全打出去（风控 + 卡顿），
 * 之前 messagePollers 与 roomPreviewRefresh 各写了一份同构实现：
 * 并发上限一变就得改两处，容易漂移。现在只保留这一份。
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const list = Array.isArray(items) ? items : [];
  const out: R[] = new Array(list.length);
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  let next = 0;
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      out[i] = await worker(list[i]);
    }
  });
  await Promise.all(runners);
  return out;
}
