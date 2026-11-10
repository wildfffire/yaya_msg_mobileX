/**
 * 原生桥调用超时护栏。
 *
 * 为什么必须有：RN 原生模块的 Promise **只在原生侧主动回调时才结束**。
 * 一旦原生因为异常 / 弱网 / 时序问题**永不回调**，调用方的 await 就永久挂起 ——
 * 用户看到的是「弹幕或消息发不出去，退出重进也没用，只能杀掉 App 重开」。
 * 本项目已经踩过三次同一个坑：QChat（在调用侧修）、PocketIm、PocketNimChatroom。
 *
 * 语义边界（重要，别误解）：
 *  - 超时只让**调用方**能失败退出并重试，**不代表原生侧的连接真的被取消**
 *    （原生模块没有提供取消接口）；
 *  - 原生迟到的回调会被忽略（Promise 已经 settle）；
 *  - 所以超时之后应当走「重连 + 重试」，而不是假定连接已断开、直接放弃。
 *
 * 抽成公共函数而不是各文件复制：重复写 5 遍的教训已经在缓存/去重那类原语上出现过一次
 * （见 docs/修复记录汇总.md 第三节 3.2）——漏改一处就再出 bug。
 */

/** 15s 取值参考口袋48 官方登录耗时上限；弱网下频繁超时优先调大此值。 */
export const NATIVE_CALL_TIMEOUT_MS = 15000;

/**
 * 发送类操作的超时上限（刻意比连接类放宽一倍）。
 *
 * 为什么发送要更宽：原生 `send` 是「**等服务端应答才 resolve**」。若应答本身慢
 * （弱网 / 服务端排队），按 15s 判失败会触发调用方「重连 + 原样重发」的兜底 ——
 * 而原生其实**已经成功了**，结果是房间里出现**两条相同消息**。
 * 放宽到 30s 能把这种误判概率降到很低，同时仍然保住「不会永久挂起」这个核心收益。
 */
export const NATIVE_SEND_TIMEOUT_MS = 30000;

export function withNativeTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms: number = NATIVE_CALL_TIMEOUT_MS,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label}超时（超过 ${Math.round(ms / 1000)} 秒），请重试`)),
        ms,
      );
      // 先到先得：promise 自己结束时清掉计时器，避免每次调用都留一个空转的定时器
      // （发弹幕属于高频路径）。注意**不要**用 timer.unref()：RN/Hermes 下不保证有该方法。
      const clear = () => clearTimeout(timer);
      promise.then(clear, clear);
    }),
  ]);
}
