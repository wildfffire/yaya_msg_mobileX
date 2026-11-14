/**
 * 「哪些消息算房主（偶像）发言」的统一筛选 + id 认领（纯规则，可单测）。
 *
 * 背景：5s 单侧处理与 30s 精确计数各有一套偶像筛选：
 *   · 5s：`strict || 服务端 homeowner 表`（始终合并）；
 *   · 30s：本地 strict 命中优先，0 命中才问服务端表（省请求）。
 * 本模块用 `serverOnlyWhenLocalEmpty` 表达这两种策略，但**判定顺序统一**为
 * 「聊天类型 → 本地严格 → 服务端表」，避免两处各写一份 filter 后漂移。
 *
 * 注意：30s 的「0 命中才发请求」策略仍由调用方控制，本模块只负责拿到表之后的选择。
 */

export interface IdolPickOptions {
  /** 本地严格判定（id / 昵称必须明确命中） */
  isOwnerLocal: (msg: any) => boolean;
  /** 服务端 homeowner 表命中（没拿到表时不传） */
  isOwnerByServer?: (msg: any) => boolean;
  /** 是否聊天类型；不传 = 全部参与（调用方已过滤时） */
  isChat?: (msg: any) => boolean;
  /** true = 本地有命中就不再看服务端表（30s 口径）；false = 始终合并（5s 口径） */
  serverOnlyWhenLocalEmpty: boolean;
}

export function pickIdolMessages(list: any[] | null | undefined, opts: IdolPickOptions): any[] {
  const all = Array.isArray(list) ? list : [];
  const candidates = opts.isChat ? all.filter((m) => opts.isChat!(m)) : all;
  const local = candidates.filter((m) => opts.isOwnerLocal(m));
  if (opts.serverOnlyWhenLocalEmpty) {
    if (local.length) return local;
    return opts.isOwnerByServer ? candidates.filter((m) => opts.isOwnerByServer!(m)) : [];
  }
  if (!opts.isOwnerByServer) return local;
  return candidates.filter((m) => opts.isOwnerLocal(m) || opts.isOwnerByServer!(m));
}

/** 逐条认领 id 总账，返回成功条数（与原来的 for + claimCountId 等价） */
export function claimMessageIds(ids: string[], claim: (id: string) => boolean): number {
  let n = 0;
  for (const id of ids) {
    if (claim(id)) n += 1;
  }
  return n;
}
