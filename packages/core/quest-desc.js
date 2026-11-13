// FTB Quests 任务描述（quest_desc）里的富文本标记解析。
//
// 任务描述存在语言文件里（config/ftbquests/quests/lang/<locale>.snbt 的
// quest.<ID>.quest_desc），是一串字符串。游戏里这些字符串会被 FTB Library 的
// ClientTextComponentUtils 当成 mini-message 解析，里面有几种标记：
//
//   {image:ns:path.png width:160 height:120 align:center}   插一张图
//   {@pagebreak}                                             分页
//   {dimension.minecraft.the_end} {item.ns.id} {trait.ns.id} 变量占位符
//   &e &l &r                                                 颜色 / 粗斜体 / 重置
//
// 2026-11-11 的用户报障是「有的任务不仅有文字说明还有图片辅助，但是现在这个
// 软件上还没有」。实测本地这份「重度机械症」包里，en_us 语言文件就有 11 个
// {@pagebreak} 和 1 个 {image:…}，而全仓 grep `pagebreak` / `{image` 是 0 命中
// —— 也就是说界面一直把这两种标记当普通文字原样贴出来了。
//
// **本文件当前只认 image**（用户 2026-11-11 18:06 拍板「这一轮只做描述里的图」）。
// 翻页、颜色码、变量占位符都还没做，但**解析结果用的是「块数组」结构**，
// 以后加它们只是在本文件里加分支，界面那边一行都不用改。
//
// 语法依据不是猜的，是从 jar 字节码里挖出来的（2026-11-11）：
//   - ftb-library 的 dev/ftb/mods/ftblibrary/util/client/ImageComponent.class
//     字段为 image / width / height / align / fit，有
//     create(String, int, int, ImageAlign, boolean)，toString 拼的是
//     "{image:" + … + " width:" + … + " height:" + … + " align:" + … + " fit:true"
//   - ftb-quests 的 ViewQuestPanel.class 里有 findImageComponent(Component)
//     与 makeImageComponentWidget(…)

/** `{image:… }` 整段的匹配。段内不含花括号，非贪婪到第一个 `}`。 */
const IMAGE_RE = /\{image:(.*?)\}/g;

/** 分页标记。FTB 实测两个包合计 74 处（ATM10Sky 63 / 重度机械症 11）。 */
export const PAGEBREAK_MARKER = '{@pagebreak}';

/**
 * 变量占位符：`{type.namespace.path}` 或 `{type.namespace.path(more)}`。
 *
 * 2026-11-11 实测真包用到的类型：item / block / entity / dimension / effect /
 * advancement / trait / book / biome / enchantment / itemGroup / model /
 * patchouli / curios / container / film …… 外加各 mod 自己的命名空间（`{create.xxx}`、
 * `{l2hostility.xxx}`）。
 *
 * ★ **必须排除的两种「长得像占位符但不是」**（实测都会踩）：
 *   1. `{"action":"open_url","value":"https://…"}` —— ATM10Sky 里是**代码示例原文**，
 *      花括号里是 JSON。特征是含引号。含 `"` 的一律不当占位符。
 *   2. `{End Ice Spikes}` `{Abyssal Carnival}` `{Create Mod}` —— 作者就在正文里
 *      打了个花括号当强调。特征是**含空格、没有点号**。真占位符的点号后面不会跟空格。
 *   所以判据是：花括号内**不含引号、不含空格、至少有一个点、只含 `[A-Za-z0-9_.:-]`**。
 */
const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_.:-]+)+)\}/g;

/**
 * 一行里有没有分页标记。
 *
 * ★ **只有整行恰好等于 `{@pagebreak}` 才算**（2026-11-12 第五批照源码改）。
 *
 * 源码实证（`Quest.java:1103`）：
 * ```java
 * if (rawDescription.get(l2).equals(PAGEBREAK_CODE)) { ... }   // equals，不是 contains
 * ```
 * 以前这里用的是 `includes()` —— 那是**超集**：行里夹着 `{@pagebreak}`
 * （比如 `"点击继续 {@pagebreak}"`）也会被当成切页，而游戏里**不切**，
 * 结果我们会**误报「这个任务能翻页」**，翻过去发现两页内容对不上。
 *
 * 注意比较前**要按 trim 后的值比**：作者手一抖在标记后面留个空格（`"{@pagebreak} "`）
 * 在游戏里其实是**不切**的，但我们若直接原样 equals 就也不切 —— 行为一致。
 * 所以这里严格按原值比，**故意不 trim**（宁可和游戏一样「不认」，也不要自作聪明地多切）。
 */
export function hasPagebreak(text) {
  return String(text ?? '') === PAGEBREAK_MARKER;
}

/**
 * 把一行从分页标记处切开。
 *
 * ★ 和 `hasPagebreak()` 保持同一个口径：**只有整行就是那个标记**才切，
 * 行内夹着的不算。切出来 `before` 一律是空串（因为标记占满整行），
 * 保留这个形状只是为了调用方不用改。
 *
 * @param {string} text
 * @returns {{before: string, rest: string}|null} 不是分页行时返回 null
 */
export function splitAtPagebreak(text) {
  const src = String(text ?? '');
  if (src !== PAGEBREAK_MARKER) return null;
  return { before: '', rest: '' };
}

/**
 * 已知的参数名。
 *
 * ★ 必须先圈出白名单，**不能**用「任何 `字母:值` 都算参数」的正则 —— 资源 ID
 * 自己就是 `命名空间:路径`（`ftbquests:textures/nvpujitian.png`），那种写法会把
 * `ftbquests` 当成参数名，结果 src 被切空、整张图静默消失。这个坑实测踩过。
 */
const KNOWN_PARAMS = new Set(['width', 'height', 'align', 'fit']);

/** 判断一段 token 是不是 `key:value` 且 key 在已知白名单里。 */
function asParam(token) {
  const at = token.indexOf(':');
  if (at <= 0) return null;
  const key = token.slice(0, at).toLowerCase();
  if (!KNOWN_PARAMS.has(key)) return null;
  return { key, value: token.slice(at + 1) };
}

/** 图片默认宽度（FTB 那边不写就是按原图，但我们在网页里得给个上限）。 */
const DEFAULT_WIDTH = 160;
/** 图片默认高度：0 表示「按比例自适应」，交给 CSS。 */
const DEFAULT_HEIGHT = 0;

/**
 * 把 `{image:…}` 的正文切成「资源 ID + 参数」。
 *
 * body 的形状固定是 `<资源ID> key:value key:value …`（空格分隔）。所以：
 *   - 第一个 token 是资源 ID（**它自己含冒号**，靠位置认、不靠正则）；
 *   - 其余每个 token 用 `asParam()` 认，认识的收下、不认识的原样忽略。
 *
 * 这样既不会被 `ns:path` 里的冒号骗到，也能容忍参数顺序乱、缺参、
 * 以及 FTB 以后加的新参数（忽略即可，不影响图本身）。
 *
 * @param {string} body `{image:` 与 `}` 之间的内容
 * @returns {{src: string, width: number, height: number, align: string, fit: boolean}}
 */
export function parseImageBody(body) {
  const text = String(body ?? '').trim();
  const out = { src: '', width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, align: 'center', fit: false };
  if (!text) return out;

  const tokens = text.split(/\s+/).filter(Boolean);
  // 空写法的兜底：`{image: width:160}` —— 第一个 token 就是参数，说明没写资源 ID
  if (!asParam(tokens[0])) out.src = tokens[0] ?? '';

  for (const token of tokens) {
    const p = asParam(token);
    if (!p) continue;
    if (p.key === 'width' || p.key === 'height') {
      const n = Number.parseInt(p.value, 10);
      if (Number.isFinite(n) && n > 0) out[p.key] = n;
    } else if (p.key === 'align') {
      const v = p.value.toLowerCase();
      if (v === 'left' || v === 'center' || v === 'right') out.align = v;
    } else if (p.key === 'fit') {
      out.fit = p.value.toLowerCase() === 'true' || p.value === '1';
    }
  }
  return out;
}

/**
 * MC 的 16 个基础颜色（ChatFormatting 的标准值）。
 *
 * MC 从 1.0 到现在一直是这套色板，和游戏里 `§6` 显示的那个橙色完全一致。
 * `packages/core/quests.js` 里有一份同名常量（那边服务标题/章节名），
 * 值是同一套 —— 两处必须一致，否则同一个任务在标题和描述里颜色不同。
 */
const MC_COLORS = {
  0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa',
  4: '#aa0000', 5: '#aa00aa', 6: '#ffaa00', 7: '#aaaaaa',
  8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff',
  c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff',
};

/** 格式码 → 样式名。这些**不换颜色**，只叠样式。 */
const MC_STYLE_FLAGS = { l: 'bold', o: 'italic', n: 'underline', m: 'strike' };

/**
 * 把带 MC 格式码的文本切成「带样式的片段」。
 *
 * 2026-11-11 用户：「把颜色的显示也做出来吧，这样游戏里和这里看的效果一样」，
 * 然后追问「FTB 的颜色只能在标题上渲染吗，还是说能指定文章和标题中的位置，
 * 比如说指定几个字渲染」—— **能，颜色是行内标记**，`&6A&r普通&B` 里的 A 单独染色。
 * 实测 ATM10Sky 描述 3843 行里有 1757 行（45.7%）带颜色码，所以描述正文必须上色。
 *
 * 语义严格照 MC（这里最容易写错）：
 *   - 颜色码（`&0`~`&f`）换色**并重置所有样式**（`&6&lA&2B` → B 是绿色且**不粗**）
 *   - 格式码（`&l/o/n/m`）只叠样式**不动颜色**
 *   - `&r` 全部重置；`&#rrggbb` 只换色不重置
 *   - `&k`（乱码）丢弃格式码、文字照常显示
 *   - `&z`（FTB 彩虹色）给静态紫 —— 游戏里是流动渐变，网页硬做动画闪得没法看字
 * ★ `\\&` 是转义的字面 `&`，必须原样留下；大写 `&A` 是字面 `&`（MC 只认小写格式码）。
 *
 * @param {string} text
 * @returns {Array<{text: string, color: string, bold: boolean, italic: boolean, underline: boolean, strike: boolean}>}
 */
export function parseMcFormatting(text) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  const initial = () => ({ color: '', bold: false, italic: false, underline: false, strike: false });
  let style = initial();
  const out = [];
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    out.push({ text: buffer, ...style });
    buffer = '';
  };

  for (let i = 0; i < src.length;) {
    const ch = src[i];
    // 转义的字面 &：原样留下，不进格式解析
    if (ch === '\\' && src[i + 1] === '&') {
      buffer += '&';
      i += 2;
      continue;
    }
    if (ch === '&' || ch === '§') {
      const rest = src.slice(i + 1);
      // 十六进制颜色 &#rrggbb（只换颜色，不重置样式）
      const hex = /^#([0-9a-fA-F]{6})/.exec(rest);
      if (hex) {
        flush();
        style = { ...style, color: `#${hex[1].toLowerCase()}` };
        i += 1 + hex[0].length;
        continue;
      }
      // ★ 用**原始大小写**判断：真数据 `"Jewelry&Accessories"` 里 `&A` 是字面 &，
      //   小写化之后会命中 `&a` 把文字染绿。MC 自己渲染也只认小写格式码。
      const code = rest[0];
      if (code && Object.hasOwn(MC_COLORS, code)) {
        flush();
        style = { ...initial(), color: MC_COLORS[code] };
        i += 2;
        continue;
      }
      if (code === 'z') {
        flush();
        style = { ...initial(), color: '#ff55ff' };
        i += 2;
        continue;
      }
      if (code === 'r') {
        flush();
        style = initial();
        i += 2;
        continue;
      }
      if (code === 'k') {
        flush();
        i += 2;
        continue;
      }
      if (code && MC_STYLE_FLAGS[code]) {
        flush();
        style = { ...style, [MC_STYLE_FLAGS[code]]: true };
        i += 2;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  if (!out.length) out.push({ text: '', ...initial() });
  return out;
}

/**
 * 把 FTB 文本里的字面转义还原成真字符。
 *
 * 实测 ATM10Sky 描述里有 **1235 行**含字面的 `\n`（两个字符：反斜杠 + n）——
 * FTB 把它当成换行，我们以前直接塞进 `textContent`，界面上就显示成 `\n\n` 这个样子。
 *
 * 只处理 FTB 真会用的这两个：`\n` 换行、`\\` 反斜杠本身（避免把 `\\n` 误换成换行）。
 * 顺序很重要：**先还原 `\\` 再处理 `\n`**，否则 `"a\\nb"`（表示 a、反斜杠、nb）
 * 会被当成换行。
 *
 * @param {string} text
 * @returns {string}
 */
export function unescapeFtbText(text) {
  const src = String(text ?? '');
  if (!src) return '';
  // 先还原转义的反斜杠（`\\` → `\`），再处理 `\n`。
  // 顺序反了的话 `"a\\nb"`（字面 a\ 后接 nb）会被错当成换行。
  return src
    .replace(/\\\\/g, '\u0000BSLASH\u0000')
    .replace(/\\n/g, '\n')
    .replace(/\u0000BSLASH\u0000/g, '\\');
}

/**
 * 一行描述 → 块数组。
 *
 * 返回的每一块要么是 `{kind:'text', text}`，要么是
 * `{kind:'image', src, width, height, align, fit}`。
 *
 * **不认识的标记一律原样留在文字里**（包括 `{@pagebreak}`、`{dimension.x}`、
 * `&e`）—— 本轮只做图，其它标记保持现状：至少不丢信息，用户还能看见原文。
 * 以后做翻页/颜色码时，在这里加分支把它们切成新 kind 即可。
 *
 * @param {string} line 一行描述
 * @returns {Array<object>}
 */
export function parseDescLine(line) {
  const text = String(line ?? '');
  const blocks = [];
  let cursor = 0;

  // 文字块统一走这个：顺手把 `\n` 转义还原成真换行，并把颜色码切成 spans。
  //
  // ★ 为什么 spans 在**这里**算而不是让界面自己调：颜色码的语义（换色会重置样式
  //   那套）只能有一份实现，界面重算早晚和标题那边不一致。
  const pushText = (raw) => {
    const plain = unescapeFtbText(raw);
    if (!plain) return;
    // 先按占位符切，每段再各自解析颜色码 —— 顺序不能反：占位符里可能有 `&`
    // （虽然目前没见过），先切颜色会把 `{item.x}` 的边界搞乱。
    let cursor2 = 0;
    const parts = [];
    PLACEHOLDER_RE.lastIndex = 0;
    let pm;
    while ((pm = PLACEHOLDER_RE.exec(plain)) !== null) {
      if (pm.index > cursor2) parts.push({ text: plain.slice(cursor2, pm.index), holder: '' });
      parts.push({ text: pm[0], holder: pm[1] });
      cursor2 = pm.index + pm[0].length;
    }
    if (cursor2 < plain.length) parts.push({ text: plain.slice(cursor2), holder: '' });
    if (!parts.length) parts.push({ text: plain, holder: '' });

    for (const part of parts) {
      if (!part.text) continue;
      const spans = parseMcFormatting(part.text);
      const block = { kind: 'text', text: spans.map((s) => s.text).join(''), spans };
      // 占位符单独标出来，界面可以画成小徽章 / 上色，表示「这里是游戏里的名字」
      if (part.holder) block.holder = part.holder;
      blocks.push(block);
    }
  };

  IMAGE_RE.lastIndex = 0;
  let m;
  while ((m = IMAGE_RE.exec(text)) !== null) {
    pushText(text.slice(cursor, m.index));
    const spec = parseImageBody(m[1]);
    // 没有资源 ID 的 {image:} 是坏数据：原样当文字，别吐一张空图出来
    if (spec.src) {
      blocks.push({ kind: 'image', ...spec });
    } else {
      pushText(m[0]);
    }
    cursor = m.index + m[0].length;
  }

  pushText(text.slice(cursor));

  // 整行没内容时给一个空块，保证「一行 = 至少一块」，界面那边不用额外判空
  if (!blocks.length) blocks.push({ kind: 'text', text: '', spans: [{ text: '', color: '', bold: false, italic: false, underline: false, strike: false }] });
  return blocks;
}

/**
 * 整个描述的字符串数组 → 块数组的数组（一行一层）。
 *
 * 为什么保留「行」这一层：FTB 的描述是「一行一段」，界面现在就是一行一个
 * div 渲染的；保持这个形状，界面加图时不用重构布局。以后做 `{@pagebreak}`
 * 就在这一层把行分组即可，块本身不用动。
 *
 * @param {string[]} lines
 * @returns {Array<Array<object>>}
 */
export function parseDescLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => parseDescLine(line));
}

/**
 * 把「行数组」按 `{@pagebreak}` 分组成页。
 *
 * 2026-11-11 用户：「我看 atm10sky 里很多任务还需要翻页查看（描述和讲解很多的任务）」
 * ⇒ 实测 ATM10Sky **46 个任务**、重度机械症 **34 处**用了分页标记。
 * 游戏里一个任务描述是好几页，用 `▶` 翻页；我们以前把 `{@pagebreak}` 原样当文字显示。
 *
 * ★ 三件必须处理的细节（都实测踩过）：
 *   1. **分页标记可能单独占一行**（真包全是这种：行内容就是 `"{@pagebreak}"`），
 *      也可能夹在某行中间。两种都要认。
 *   2. **分页标记前后的空行要去掉** —— 真包里它前面常有一行 `""`，
 *      留着会在两页之间凭空多一段空白，看着像内容丢了。
 *   3. **没有分页标记时返回 `[[...所有行...]]`**（一页），界面不用特判。
 *
 * @param {Array<string>} lines 原始描述行（未解析）
 * @returns {Array<Array<string>>} 每页一组原始行（**还没 parseDescLine**，由调用方决定）
 */
export function groupPageLines(lines) {
  const src = Array.isArray(lines) ? lines.map((l) => String(l ?? '')) : [];
  const pages = [];
  let current = [];

  const trimEmpty = (arr) => {
    let a = 0;
    let b = arr.length;
    while (a < b && !arr[a].trim()) a += 1;
    while (b > a && !arr[b - 1].trim()) b -= 1;
    return arr.slice(a, b);
  };

  for (const line of src) {
    let rest = line;
    let cut = splitAtPagebreak(rest);
    while (cut) {
      // 分页前的部分（可能为空）留在本页
      if (cut.before.trim()) current.push(cut.before);
      pages.push(trimEmpty(current));
      current = [];
      rest = cut.rest;
      cut = splitAtPagebreak(rest);
    }
    current.push(rest);
  }
  pages.push(trimEmpty(current));

  // 全空时给一页空的，保证「至少一页」
  if (!pages.length) pages.push([]);
  return pages;
}

/**
 * 整个描述（行数组）→ 分好页的块数组：`[[块...], [块...]]`。
 *
 * 这是界面直接用的形状：`pages.length > 1` 就出翻页按钮。
 *
 * @param {Array<string>} lines
 * @returns {Array<Array<object>>}
 */
export function parseDescPages(lines) {
  return groupPageLines(lines).map((pageLines) => pageLines.flatMap((line) => parseDescLine(line)));
}

/**
 * 占位符 `item.minecraft.diamond` → 查表用的 ID `minecraft:diamond`。
 *
 * 占位符的形状是 `<类型>.<命名空间>.<路径>`，而语言文件/物品表的键是
 * `<类型>:<命名空间>.<路径>` 或 `<命名空间>:<路径>`。这里只做**键的换算**，
 * 真去查名字的活交给调用方（core 不能读盘）。
 *
 * ★ 有些类型不止两段：`{item.minecraft.potion.effect.apothic_attributes.flying}`
 *   是「物品 + 药水变体」，路径部分是 `potion.effect.apothic_attributes.flying`。
 *   所以只切**前两段**（类型、命名空间），剩下的全算路径。
 *
 * @param {string} holder 花括号里的内容（不含花括号）
 * @returns {{type: string, ns: string, path: string, id: string}|null}
 */
export function parsePlaceholder(holder) {
  const src = String(holder ?? '').trim();
  const parts = src.split('.');
  if (parts.length < 3) return null;
  const type = parts[0];
  const ns = parts[1];
  const rest = parts.slice(2).join('.');
  if (!type || !ns || !rest) return null;
  return { type, ns, path: rest, id: `${ns}:${rest}` };
}

/**
 * 把整页块里的占位符换成查到的名字。
 *
 * 为什么放在 core 而不是界面上：翻译要用到整合包的物品/方块名表（要走接口读盘），
 * 界面没有那套数据；而且「同一个占位符在标题和描述里显示成一样」这条只能有一份实现。
 *
 * ★ **查不到就原样保留**（`{item.xxx.yyy}` 留着），不要替换成空串或「未知」——
 *   查不到通常意味着那个 mod 没装，用户看到原样 ID 还能自己去搜；
 *   换成空串会让句子读不通（「做　就能得到」），反而更糟。
 *
 * @param {Array<object>} blocks 一页的块数组
 * @param {(holder: string) => string} resolve 给占位符内容，返回显示名（查不到返回空串）
 * @returns {Array<object>} 新的块数组（不改原对象）
 */
export function resolveHolders(blocks, resolve) {
  if (typeof resolve !== 'function') return blocks;
  return (Array.isArray(blocks) ? blocks : []).map((b) => {
    if (b?.kind !== 'text' || !b.holder) return b;
    let name = '';
    try {
      name = String(resolve(b.holder) ?? '');
    } catch {
      name = '';
    }
    if (!name) return b; // 查不到：原样留着
    // 换了名字之后颜色码 / 样式按原块继承（占位符本身在真数据里通常不带颜色，
    // 但外面那圈 `&6{item.x}&r` 是带颜色的，颜色在外层的 span 上，这里不动它）
    return {
      ...b,
      text: name,
      spans: b.spans.map((s) => (s.text === b.text ? { ...s, text: name } : s)),
      holderName: name,
    };
  });
}

/**
 * 从块数组里挑出所有图片资源 ID（去重、去空）。
 *
 * 界面拿这串 ID 批量去 `/quest/images` 换 data URL。单独抽出来的原因：
 * 界面和（以后可能的）预取逻辑都要算这一份，别各写一遍。
 *
 * @param {Array<Array<object>>|Array<object>} blocks
 * @returns {string[]}
 */
export function descImageSrcs(blocks) {
  const out = [];
  const seen = new Set();
  // 两种形状都收：`[[块…], [块…]]`（按行分组的 descriptionBlocks）
  // 和 `[块…]`（已经被 flatMap 成一层的一页）。界面两种都会传进来。
  const walk = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (Array.isArray(item)) {
        walk(item);
        continue;
      }
      if (item?.kind !== 'image') continue;
      const src = String(item.src ?? '');
      if (!src || seen.has(src)) continue;
      seen.add(src);
      out.push(src);
    }
  };
  walk(blocks);
  return out;
}
