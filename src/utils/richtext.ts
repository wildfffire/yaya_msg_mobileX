/**
 * 富文本（HTML）正文归一化。
 *
 * 背景（2026-10-03 真机实测，林舒晴直播间）：官方 H5 / 其他端发出的弹幕正文
 * **是 HTML 片段**，不是纯文本，例如：
 *   `<div><span style="color:#fffff; vertical-align:middle;">Maite 太🐶</span></div>`
 *   `<img style="vertical-align:middle;" src="/backstage/xxx/emoji.png">`
 * 我们三条链路（云信 codec → 弹幕列表抽屉 / 飘屏、LRC → 录播弹幕）都按纯文本渲染，
 * 用户看到的就是「一串乱码标签」。
 *
 * 处理策略（**尽力而为，绝不猜内容**）：
 *   ① `<img>` → 占位符 `[表情]`（见 RICH_IMAGE_PLACEHOLDER 的说明）；
 *   ② `<br>` 折成空格（弹幕/消息都是单行，不需要真换行）；
 *   ③ 剥掉其余标签；只认「像标签」的 `<` 后跟字母或 `/`，避免误伤 `1 < 3 > 2` 这种正文；
 *   ④ 解常见实体（`&nbsp;` `&amp;` `&lt;` … 与 `&#123;` / `&#x1F4A5;`）；
 *   ⑤ 再剥一次标签 —— 覆盖「正文本身是转义过的 HTML」(`&lt;div&gt;正文&lt;/div&gt;`)；
 *   ⑥ 收紧空白；清洗后若仍为空串则返回空串，由调用方丢弃该条（宁可不显示，也不显示标签）。
 *
 * ⚠️ 收口位置必须是**解析层**（`services/pocketNim/codec.ts` 的 normalizeBarrageText
 * 与 `utils/danmaku.ts` 的 parseDanmaku），不要散到各个渲染组件里 ——
 * 同一份弹幕有「列表 / 飘屏 / 弹幕榜」多个消费方，散着写必然漏。
 */

/**
 * 图片占位符。
 *
 * 为什么是占位符而不是把图渲染出来（2026-10-03 三处求证，别重复踩）：
 *   ① **RN 新架构渲染不了 Text 内联图片** —— 本项目 `newArchEnabled=true`，
 *      而 Fabric 的 `ReactCommon/react/renderer/components/text` 里**没有** ImageSpan
 *      （只有旧架构的 `ReactTextView.java` 有 TextInlineImageSpan），`<Text><Image/></Text>`
 *      不会显示；要显示得把弹幕行改成「文本 + 图片 + 文本」兄弟视图，
 *      而列表行是**单行省略号**（ROW_LINES=1 + getItemLayout 固定行高），改了必崩版式；
 *   ② 我们也**没有官方的「表情图 URL → emoji」码表** —— 富文本弹幕是爆发式出现、
 *      窗口只留最近 300 条，真机蹲不到样本；官方 H5 分享页（memberLiveShare）只有播放器、
 *      没有聊天代码。样本由 `codec.ts` 的 `[rich]` 诊断日志持续留档，攒够即可补码表。
 * 因此先给一个**明确且不猜**的占位：消息不再整条消失，也不会把 src 路径糊到屏幕上。
 */
export const RICH_IMAGE_PLACEHOLDER = '[表情]';

/** 只认「像标签」的形态：`<div>` `</span>` `<!-- -->` 之外的都放过 */
const TAG_LIKE_RE = /<\/?[a-zA-Z][^>]*>/g;
const IMG_RE = /<img\b[^>]*>/gi;
const BR_RE = /<br\s*\/?>/gi;

/**
 * 命名实体表。只收**正文里真会出现**的这几个：
 * 官方消息里最常见的排版符号 + 转义字符，其余（如 `&copy;`）原样保留不猜。
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
};

/** 码点安全转换：越界/非法直接返回原样，不抛异常 */
function fromCodePoint(code: number, raw: string): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return raw;
  try {
    return String.fromCodePoint(code);
  } catch {
    return raw;
  }
}

/** 解 HTML 实体（`&nbsp;` / `&amp;` / `&#123;` / `&#x1F4A5;`）。无可解内容时零开销返回原串 */
export function decodeHtmlEntities(text: string): string {
  if (!text || text.indexOf('&') < 0) return text;
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (match, dec, hex, name) => {
    if (dec) return fromCodePoint(parseInt(dec, 10), match);
    if (hex) return fromCodePoint(parseInt(hex, 16), match);
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? match;
  });
}

/** 去掉标签（图片折成占位符、换行折成空格），不动实体 */
function stripTags(text: string): string {
  return text.replace(IMG_RE, RICH_IMAGE_PLACEHOLDER).replace(BR_RE, ' ').replace(TAG_LIKE_RE, '');
}

/**
 * 富文本 → 纯文本。纯文本入参（绝大多数弹幕）走「不含 `<` 且不含 `&`」的快速通道，零开销。
 * @returns 清洗后的正文；图片表情变成 `[表情]` 占位；内容全是标签且无图片时返回空串（调用方丢弃）
 */
export function stripRichText(text: string): string {
  if (!text) return '';
  const raw = String(text);
  if (raw.indexOf('<') < 0 && raw.indexOf('&') < 0) return raw;
  const once = stripTags(decodeHtmlEntities(raw));
  // 二次剥标签：输入本身是转义 HTML（`&lt;div&gt;正文&lt;/div&gt;`）时上面那步才刚把它变成真标签
  const twice = stripTags(decodeHtmlEntities(once));
  return twice.replace(/\s+/g, ' ').trim();
}
