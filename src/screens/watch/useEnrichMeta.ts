/**
 * 补全列表条目缺失的展示字段（成员 / 队伍 / 标题 / 封面 / 时长 / 类型）。
 *
 * 用户 2026-09-30：「观看历史还是有很多信息显示不全，现在图片也没了，继续重构」
 *               「直播界面和录播就能完美匹配成员名称和队伍，历史和稍后再看经常出问题」。
 *
 * ── 三级补全（越往下越贵，能省则省）────────────────────────────────
 *   ① **本地**（零网络）：条目自带的 `ownerId`（成员数字 id）→ 成员库；
 *      没有 id 则按昵称、再按标题反查（取「出现位置最靠前 + 名字最长」的命中，防配错人）。
 *   ② **批量表**：拉**官方录播列表**（`getLiveList({record:true})`，就是直播页录播 tab 的
 *      同一个数据源，最多翻 3 页）+ 官方视频列表，按 liveId / videoId 建索引，
 *      几个请求就能补几十条，而不是逐条请求。
 *   ③ **兜底**：表里没有、但带 liveId / videoId 的条目，并发（4）逐条 `getLiveOne`。
 *
 * ── 为什么以前「信息一直不全」（本次重写的四个真因）────────────────
 *   A. **一轮被自己的补丁掐断**：主 effect 依赖 `items`，而每补一条都会改 `items` →
 *      effect cleanup 把在途的 `alive` 置 false → 4 个 worker 各只处理 1 条就收工。
 *      上百条历史要几十轮（每轮一次网络往返 + 400ms）才补得完，用户看到的永远是"还没补到"。
 *      → 现在改成**自持循环**（`runningRef` 互斥 + 内部 while 轮次），effect 只负责"启动"。
 *   B. **失败即永久放弃**：旧的 `triedRef` 在请求**发起前**就标记，失败/空结果也永久标记，
 *      且只有成员库变化才清空 → 一次网络抖动 = 这条永远缺字段。
 *      → 现在记**尝试次数**（上限 3），失败/空结果只 +1；成员库更新或重新进页都会再给机会。
 *   C. **批量表只拉一页**（近 20 场），老直播永远不在表里 → 全部退化成逐条请求。
 *      → 现在按 `next` 游标最多翻 3 页。
 *   D. **队伍靠昵称硬匹配**：与直播页卡片「userId → 成员库」的口径不一致。
 *      → 现在统一走 `utils/memberMatch.resolveTeam`（先 id、后归一化昵称）。
 *
 * 决策（这条该本地补 / 查表 / 打网络 / 该不该放弃）全部在 `utils/watchMeta.planEnrich`，
 * 纯函数、可被 `scripts/watch-enrich.sim.mjs` 用真实形态的数据跑上千次钉住。
 * 本文件只负责 IO：拉表、发请求、把结果写回 store。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pocketApi from '../../api/pocket48';
import { useMemberStore } from '../../store';
import { buildMemberLookup } from '../../utils/memberMatch';
import {
  needsEnrich,
  patchFromRaw,
  patchHasValue,
  planEnrich,
  type EnrichPatch,
  type EnrichTarget,
  type WatchMetaLike,
  type WatchMetaPatch,
} from '../../utils/watchMeta';
import { pickText, unwrapList } from '../../utils/data';
import { logInfo } from '../../utils/runtimeLog';

/** 类型原样再导出（页面与 store 的既有 import 不受影响） */
export type { EnrichTarget, EnrichPatch };

/** 批量表缓存有效期（毫秒）：列表页开着不重复拉 */
const TABLE_TTL_MS = 5 * 60 * 1000;
/** 录播表最多翻几页（每页约 20 场；翻太多会拖慢首屏） */
const TABLE_MAX_PAGES = 3;
/** 单条条目最多尝试几次网络补全（失败/空结果各算一次；超出就本轮不再打扰） */
const MAX_ATTEMPTS = 3;
/** 兜底请求并发数 */
const NET_CONCURRENCY = 4;
/** 两轮之间的间隔（补全是后台任务，别把列表滚动卡住） */
const ROUND_GAP_MS = 250;
/** 单页自持循环的最大轮数（兜底防呆：补不完也要收工，不能无限转。
 *  修复死循环后收敛极快：12 条 × 3 次尝试 ÷ 每轮 12 条 ≈ 3-5 轮就自然退出，30 轮绰绰有余） */
const MAX_ROUNDS = 30;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * ★ 模块级共享状态（用户 2026-10-01 真机实锤）：
 * 「观看历史」和「稍后再看」是两个**常驻根栈页面**，各挂一个 useEnrichMeta 实例 ——
 * 实例级的 runningRef 互斥不了对方，两套循环并发空转（日志：2 分钟内两份补全表
 * 59 条 + 20 条各拉一次；每份 0.5s/轮 × 12 请求，退到别的页面也不停）。
 * 全部提为模块级后：无论多少实例，全局只有一个补全循环、一份尝试计数、一张补全表。
 */
let sharedAttempts = new Map<string, number>();
const sharedInFlight = new Set<string>();
let sharedTable: { at: number; vod: Map<string, any>; video: Map<string, any> } | null = null;
let sharedRunning = false;
let sharedTableFetching = false;

export function useEnrichMeta(
  items: EnrichTarget[],
  patch: (key: string, p: EnrichPatch) => void,
  /**
   * 单轮最多补几条（只约束**逐条兜底**那一级）。
   * 12 + 并发 4：打开列表几秒内就能把最近这一批补齐（结果写回 store，二次打开直接完整）。
   */
  limit = 12,
  /**
   * ★ 页面聚焦门控（用户 2026-10-01：「设置又卡住了」）：
   * 历史 / 稍后再看是**常驻根栈页面**——进过一次就永不卸载，人回到房间/直播页，
   * 补全循环还在后台拉 3 页表 + 发请求 + patch 触发重渲染（真机日志实锤：
   * 10:17:41 人在房间里，10:17:55 watch 补全却启动了）。
   * 页面必须传 `useIsFocused()` 进来：不可见 = 卡片根本没人看 = 补全无意义，全部停掉。
   */
  enabled = true,
) {
  const members = useMemberStore((s) => s.members);
  /**
   * 成员索引（缓存）：本地补全每条都要查成员库，若每次重建索引，
   * 历史页几百条 × 上千成员会明显卡顿。
   */
  const lookup = useMemo(() => buildMemberLookup(members), [members]);
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;

  const patchRef = useRef(patch);
  patchRef.current = patch;
  const itemsRef = useRef<WatchMetaLike[]>(items);
  itemsRef.current = items;
  const limitRef = useRef(limit);
  limitRef.current = limit;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  /** 组件是否仍挂载（拉表结果要跨多次渲染保留，不能因重渲染把在途请求作废） */
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  /** key → 已尝试次数（失败/空结果各 +1；达到 MAX_ATTEMPTS 本轮不再打扰）——模块级共享 */
  const attemptsRef = useRef(sharedAttempts);
  /** 正在网络补全中的 key（防重复并发）——模块级共享 */
  const inFlightRef = useRef(sharedInFlight);
  /** 自持补全循环是否在运行（effect 只负责启动）——模块级共享，跨实例互斥 */

  /**
   * 成员库到位 / 更新时**清空尝试计数**（用户 2026-09-30：「队伍名称还是经常刷新不出来」）。
   *
   * 根因：队伍/成员名都靠成员库反查，而成员库是**异步同步**的。补全若跑在成员库到位之前，
   * 那些条目会被记成"试过了" → 之后即使成员库补好，也不会再补一次 → 队伍永远空着。
   */
  useEffect(() => {
    attemptsRef.current.clear();
  }, [lookup]);

  /**
   * ★ 页面重新聚焦时清空尝试计数（用户 2026-10-01 下午「页面内容空白」）：
   * attempts 是模块级共享 + MAX_ATTEMPTS=3 封顶 —— 上午死循环那批条目已经烧光 3 次
   * （详情接口补不出时长但能补成员名），**共享后永不重置** → 这些条目连同
   * 封面/成员名被永久放弃 → 历史/稍后再看大面积卡片空白。
   * 现在每次打开列表（enabled false→true）给一轮完整机会；不可见时依然完全不跑
   * （死循环修复的收敛逻辑不受影响：单次聚焦内仍是最多 3 次尝试）。
   */
  useEffect(() => {
    if (enabled) attemptsRef.current.clear();
  }, [enabled]);

  /** 批量表拉取互斥 ——模块级共享（两页面只拉一份） */
  /** 拉到表后 +1，用于触发一次重算 */
  const [tableVersion, setTableVersion] = useState(0);

  /**
   * 拉「官方录播列表（最多 3 页）+ 官方视频列表」作为批量补全表。
   *
   * ⚠️ 这个 effect **不能**依赖 `items` 本身（用户 2026-09-30：「图片加载非常慢，信息不全…为什么不复用录播」）：
   * 每次 patch 都会改 items → effect 重跑 → 以前 cleanup 里的 `alive = false` 把**在途请求作废**，
   * 表永远拉不回来 → 卡片信息一直不全。现在依赖只到 `items.length`（是否该拉表），
   * 在途结果用 mountedRef 判断，不因重渲染而丢弃。
   */
  useEffect(() => {
    if (!itemsRef.current.length || !enabledRef.current) return undefined;
    const cached = sharedTable;
    if (cached && Date.now() - cached.at < TABLE_TTL_MS) return undefined;
    if (sharedTableFetching) return undefined;
    sharedTableFetching = true;
    (async () => {
      const vod = new Map<string, any>();
      const video = new Map<string, any>();
      try {
        /**
         * 翻页：官方用 `next` 做游标（上一页最后一条的 liveId）。
         * 只拉一页（近 20 场）时，稍微旧一点的直播永远不在表里 → 全部退化成逐条请求，
         * 这是"信息一直不全"的真因之一。
         */
        let next = 0;
        for (let page = 0; page < TABLE_MAX_PAGES; page += 1) {
          if (!mountedRef.current) break;
          // eslint-disable-next-line no-await-in-loop
          const res: any = await pocketApi.getLiveList({ record: true, next } as any).catch(() => null);
          const rawList = unwrapList(res, ['content.liveList', 'content.list', 'content.data', 'data', 'liveList', 'list']);
          if (!rawList.length) break;
          let lastId = '';
          for (const raw of rawList) {
            const lid = String(pickText(raw, ['liveId', 'id', 'live_id', 'roomId']) || '').trim();
            if (lid) { vod.set(lid, raw); lastId = lid; }
          }
          const cursor = Number(pickText(res, ['content.next', 'next', 'content.nextTime']) || 0);
          const nextCursor = cursor > 0 ? cursor : Number(lastId || 0);
          if (!nextCursor || nextCursor === next) break;
          next = nextCursor;
        }
      } catch { /* 忽略 */ }
      try {
        const res: any = await pocketApi.getOfficialVideoList({ limit: 50 } as any).catch(() => null);
        const rawList = unwrapList(res, ['content.data', 'content.list', 'data', 'list', 'content']);
        for (const raw of rawList) {
          const vid = String(pickText(raw, ['id', 'resId', 'videoId', 'vid']) || '').trim();
          if (vid) video.set(vid, raw);
        }
      } catch { /* 忽略 */ }
      sharedTable = { at: Date.now(), vod, video };
      sharedTableFetching = false;
      // 诊断日志（用户可导出运行日志）：一眼看出"补全表到底有没有拉回来"
      logInfo(`[watch] 补全表：录播 ${vod.size} 条 / 视频 ${video.size} 条`, 'watch');
      if (mountedRef.current && (vod.size || video.size)) setTableVersion((v) => v + 1);
    })();
    return undefined;
  }, [items.length, tableVersion]);

  /** ③ 并发兜底：逐条拉详情（决策由 planEnrich 给出） */
  const runNetwork = useCallback(async (targets: WatchMetaLike[]) => {
    let cursor = 0;
    let patched = 0;
    const worker = async () => {
      while (mountedRef.current && cursor < targets.length) {
        const it = targets[cursor++];
        const used = attemptsRef.current.get(it.key) || 0;
        inFlightRef.current.add(it.key);
        try {
          const res: any = it.liveId
            ? await pocketApi.getLiveOne(String(it.liveId))
            : await (pocketApi as any).getOfficialVideo(String(it.videoId));
          if (!mountedRef.current) return;
          /**
           * 与「批量表命中」走**同一个** `patchFromRaw`（先剥掉 content/data 外壳）：
           * 以前这里另写一份字段路径，两条链路口径会逐渐漂移（一处改了另一处没改），
           * 表现就是"从表补到的有成员名、逐条补到的没有"。
           */
          const detail = it.liveId
            ? (res?.content ?? res?.data ?? res)
            : (res?.content?.data ?? res?.content ?? res?.data ?? res);
          const p: WatchMetaPatch = patchFromRaw(detail, !it.liveId, lookupRef.current);
          if (patchHasValue(p)) {
            patchRef.current(it.key, p);
            patched += 1;
            /**
             * ★ 死循环修复（用户 2026-10-01，实锤于真机日志）：
             * 「补全一轮：命中 12/12 条」每 0.5s 一轮、连跑 120 轮兜底才停 ——
             * 真因：详情接口能补出成员/队伍（patch 有值）但**根本不返回时长字段**
             * → needsEnrich 恒 true（duration 缺）→ 旧代码在这里 delete 尝试计数
             * → attempts 恒 0 → 每轮都把这 12 条重新拉一遍 getLiveOne，永不停。
             * 现在：patch 应用后**仍缺字段**（needsEnrich 仍 true）→ 只累计尝试计数，
             * 3 轮后 planEnrich 自动放弃这条；真正补全了（不缺了）才清零给下次机会。
             */
            const merged = { ...it, ...(p as any) } as WatchMetaLike;
            if (needsEnrich(merged)) attemptsRef.current.set(it.key, used + 1);
            else attemptsRef.current.delete(it.key);
          } else {
            // 接口 200 但什么都没有：只算"试过一次"，不永久放弃
            attemptsRef.current.set(it.key, used + 1);
          }
        } catch {
          // 单条失败不影响其它条目：只记一次尝试（网络抖动后还能再补）
          attemptsRef.current.set(it.key, used + 1);
        } finally {
          inFlightRef.current.delete(it.key);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(NET_CONCURRENCY, targets.length) }, () => worker()),
    );
    if (mountedRef.current) {
      logInfo(`[watch] 补全一轮：命中 ${patched}/${targets.length} 条`, 'watch');
    }
  }, []);

  /**
   * 自持补全循环。
   *
   * ⚠️ 关键：轮次由循环自己推进，**不靠 effect 重跑**（effect 重跑会被自己的 patch 打断 ——
   * 那就是"补了半天还是不全"的真因 A）。`runningRef` 做互斥，effect 只负责启动一次。
   */
  const runEnrich = useCallback(async () => {
    if (sharedRunning) return;
    sharedRunning = true;
    let rounds = 0;
    try {
      while (mountedRef.current && enabledRef.current && rounds < MAX_ROUNDS) {
        rounds += 1;
        const table = sharedTable;
        const plan = planEnrich({
          items: itemsRef.current || [],
          vod: table?.vod,
          video: table?.video,
          lookup: lookupRef.current,
          attempts: attemptsRef.current,
          inFlight: inFlightRef.current,
          limit: limitRef.current,
          maxAttempts: MAX_ATTEMPTS,
        });
        if (!plan.active) return;
        for (const entry of plan.patches) patchRef.current(entry.key, entry.patch);
        for (const key of plan.bumped) {
          attemptsRef.current.set(key, (attemptsRef.current.get(key) || 0) + 1);
        }
        if (plan.network.length) {
          const byKey = new Map<string, WatchMetaLike>();
          for (const it of itemsRef.current || []) if (it?.key) byKey.set(it.key, it);
          const targets = plan.network.map((k) => byKey.get(k)).filter(Boolean) as WatchMetaLike[];
          if (targets.length) await runNetwork(targets);
        }
        // 补全是后台任务：留一点间隔，别把列表滚动卡住
        await sleep(ROUND_GAP_MS);
      }
    } finally {
      sharedRunning = false;
    }
  }, [runNetwork]);

  useEffect(() => {
    if (!items.length || !enabled) return;
    if (sharedRunning) return;
    void runEnrich();
  }, [items, limit, enabled, tableVersion, runEnrich]);
}

export default useEnrichMeta;
