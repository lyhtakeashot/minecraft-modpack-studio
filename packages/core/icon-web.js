/**
 * 图标来源之「MC百科（mcmod.cn）」联网兜底。
 *
 * 为什么要有这一层：本地拆 jar 拿贴图能覆盖 Mechanomania 那 10405 个物品里的约 92%，
 * 剩下的 866 个不是「jar 里没模型/没同名贴图」，就是 `builtin/entity`（靠实体渲染，
 * 根本不存在一张 2D 贴图可用）。这类物品在 MC百科上往往有现成的 32×32 / 128×128 图标，
 * 拿来当「实在没别的办法时」的最后一档，比在面板上画个字母方块好看得多。
 *
 * 这个模块只做纯逻辑：搜索、解析、保守匹配、缓存、下载。不碰 jar、不碰 UI、
 * 不写进任何别的模块 —— 接线（面板开关、优先级）由调用方决定。
 *
 * 三条硬规矩（用户被「图标用错」坑过一次，这比「缺图标」严重得多）：
 *   1. 匹配宁可漏，不给错：标题必须**完全等于**物品名，或**完整包含**物品名且能对上 mod 名；
 *      任何时候有两个以上同等候选，一律返回 null，让调用方画占位图。
 *   2. 任何失败都不抛异常，只返回 `{ ok: false, reason }`。联网的东西不能把面板带崩。
 *   3. 对 mcmod 的请求全程串行、间隔 ≥ 350ms，且单次 8 秒超时。本站有反爬
 *      （实测短时间内连发会返回「搜索太频繁，请稍后再试」），被限流时也要如实报告。
 *
 * 实测记录（2026-10-31，Node 24 自带 fetch）：
 *   - `https://search.mcmod.cn/s?key=熔岩` 默认排序的头一页全是**模组**（/class/），
 *     物品/方块资料要加 `filter=3` 才出得来，所以 searchUrl() 默认带 filter=3。
 *   - 物品详情页**没有** `<meta property="og:image">`（og:image 分支留着当兜底，
 *     但实测走不到；测试里用一份人造页面覆盖它）。
 *   - 图标真实地址形如 `//i.mcmod.cn/item/icon/128x128/52/524057.png`：
 *     路径里的数字和物品 ID 相同，这是「哪张图标属于本物品」的唯一可靠依据
 *     （详情页里还混着「相关物品」「主资料变体」的缩略图，看位置会认错）。
 *   - 只存在 `32x32` 和 `128x128` 两种路径（16/64/256/512 实测全是 404）；
 *     而且 `32x32` 路径有时直接返回 128×128 的真图，尺寸要以 PNG 头为准。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** mcmod 各站点的固定地址。调用方只该用 searchUrl()/itemUrl()，别自己拼。 */
export const MCMOD = Object.freeze({
  /** 图标 CDN（协议相对 URL 都在它上面） */
  iconHost: 'https://i.mcmod.cn',
  /**
   * 搜索地址。
   *
   * `filter=3` 是「资料（物品/方块）」这个分类 —— 不带它的话默认页前十来个结果全是模组，
   * 压根抽不到 /item/ 链接（实测）。`filter=1` 是模组、`filter=3` 是资料。
   */
  searchUrl(key) {
    return `https://search.mcmod.cn/s?key=${encodeURIComponent(String(key ?? ''))}&filter=3`;
  },
  /** 物品/方块详情页 */
  itemUrl(id) {
    return `https://www.mcmod.cn/item/${encodeURIComponent(String(id ?? ''))}.html`;
  },
});

/** 同一进程内对 mcmod 的最小请求间隔（毫秒）。低于这个值容易撞反爬。 */
const MIN_INTERVAL_MS = 600;
/**
 * 搜索接口要单独再慢一档。
 *
 * 实测：350ms 连打十几次就撞「搜索太频繁」并进 60 秒冷却；2.5 秒一次连打四轮都正常。
 * 详情页与图标 CDN 比搜索宽松，用 MIN_INTERVAL_MS 就够 —— 给搜索单独一条线，
 * 免得把「查一张图标」拖成十几秒。
 */
const SEARCH_GAP_MS = 2500;
/** 单次请求默认超时。 */
const DEFAULT_TIMEOUT_MS = 8000;
/** 单张图标上限。128×128 的 PNG 一般几 KB，超过 1 MB 的多半不是图标。 */
const MAX_ICON_BYTES = 1024 * 1024;
/** 图标尺寸候选，从大到小（实测只有这两种路径存在）。 */
const ICON_SIZES = ['128x128', '32x32'];
/** 伪装成普通浏览器：默认的 node UA 在这类站上更容易被限流。 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 上一次请求 mcmod 的时间戳（模块级，整个进程共用一条节流线）。 */
let lastRequestAt = 0;
/** 串行闸门：所有请求排队走这一条链，保证「一个接一个」。 */
let gate = Promise.resolve();
/** 撞上限流后到什么时候为止不再发搜索请求（时间戳，毫秒）。 */
let cooldownUntil = 0;
/** 撞限流后冷静多久。实测连发十几轮后要等一阵才恢复，60 秒是保守值。 */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * 睡一会儿。
 *
 * **定时器不能 unref**：这个 sleep 是「等够节流间隔」的唯一活动句柄。unref 掉之后，
 * 事件循环一看没别的事干就直接退出 —— CLI 探针会以「Detected unsettled top-level await」
 * 收场（真踩过）。350ms 的等待不影响进程退出速度，别省。
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 排队执行一次请求，并保证与上一次的间隔 ≥ MIN_INTERVAL_MS。
 *
 * 为什么要串行而不是「并发 + 限速」：mcmod 的反爬是按来源 IP 记频率的，
 * 并发打过去只会更快被限流；串行慢一点但稳定，且图标本来就是兜底，不急。
 */
function serialRun(task) {
  const run = gate.then(task, task);
  // 闸门本身不能因为某次失败而断掉，否则后续请求全部拒绝
  gate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 等够最小间隔。 */
async function throttle(gap = MIN_INTERVAL_MS) {
  const wait = lastRequestAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/** 取 fetch 实现：默认用 Node 自带的全局 fetch。 */
function pickFetch(fetchImpl) {
  return typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
}

/**
 * 带超时的一次 HTTP 请求。返回 `{ ok, status, text(), bytes() }`，失败时抛错由调用方接住。
 *
 * 自己用 setTimeout + AbortController 控超时，不用 AbortSignal.timeout：
 * 测试里的假 fetch 不认 signal，但至少要能保证「真 fetch 不会吊死 8 秒以上」。
 */
async function httpGet(url, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, referer } = {}) {
  const doFetch = pickFetch(fetchImpl);
  if (typeof doFetch !== 'function') throw new Error('当前环境没有 fetch，无法联网');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        'accept-language': 'zh-CN,zh;q=0.9',
        accept: '*/*',
        ...(referer ? { referer } : {}),
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 排队 + 节流的一次请求。**所有**对 mcmod / i.mcmod.cn 的请求都必须走这里：
 * 串行保证一个接一个，节流保证间隔 ≥ MIN_INTERVAL_MS（搜索是 SEARCH_GAP_MS），两条一起才不容易撞反爬。
 */
async function serialGet(url, opts = {}) {
  const { gap = MIN_INTERVAL_MS, ...rest } = opts;
  return serialRun(async () => {
    await throttle(gap);
    return httpGet(url, rest);
  });
}

/** HTML 实体解码（只处理 html 里真会出现的那些，够用且不引依赖）。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * 去标签 + 解实体 + 压空白。搜索页标题里到处是 `<em>` 高亮，必须先去掉。
 *
 * 标签替换成**空串**而不是空格：`<em>熔岩</em>风蛇` 是一个词，中间插空格会变成「熔岩 风蛇」，
 * 标题和中文名就对不上了（早期的真 bug）。标签两侧该有的空格，原始 HTML 里本来就写着。
 */
export function cleanText(text) {
  return decodeEntities(String(text ?? '').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 匹配用的规范化：全角转半角（NFKC）、小写、去掉所有空白。
 *
 * 「去全角半角差异」靠 NFKC：`（` → `(`、`Ａ` → `A`、全角空格 → 空格，然后再把空格删掉。
 * 不做繁简转换 —— 那需要一张几百字的表，且 mcmod 标题里简体名一定在括号前面，
 * 用「括号前的主名」比较就绕开了繁体别名。
 */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** 标题里「括号前的主名」：`改良无线虚能节点 (Improved Wireless Imag Node)` → `改良无线虚能节点`。 */
export function primaryTitle(title) {
  const text = String(title ?? '');
  const cut = text.search(/[（(]/);
  const head = cut > 0 ? text.slice(0, cut) : text;
  return head.trim() || text.trim();
}

/**
 * 解析搜索页 HTML，抽出所有 `/item/<数字>.html` 结果。
 *
 * 真实结构（2026-10-31 实测，filter=3）：
 *   <div class="result-item">
 *     <div class="head">(物品/方块) <a target="_blank" href="https://www.mcmod.cn/item/524057.html">
 *       <em>熔岩</em>地狱方块 (<em>熔岩</em>地獄方塊) - [M3] 魔法金属 (ManaMetalMod)</a></div>
 *     <div class="body">…摘要…</div>
 *     <div class="foot">…地址（这里也有一个 item 链接！）…</div>
 *   </div>
 *
 * 坑：每个结果块里 `/item/<id>.html` 会出现两次 —— head 里是标题链接，foot 里是「地址」。
 * 只取 head 那一个，否则标题会变成一串网址。
 *
 * @param {string} html
 * @returns {Array<{pageUrl: string, itemId: string, title: string, modName: string, category: string, rawTitle: string}>}
 */
export function parseSearchHtml(html) {
  const text = typeof html === 'string' ? html : '';
  if (!text) return [];

  const out = [];
  const seen = new Set();
  // 按结果块切开：每个块从 class="result-item" 开始
  for (const chunk of text.split(/<div class="result-item">/).slice(1)) {
    const bodyAt = chunk.indexOf('<div class="body">');
    const head = bodyAt > 0 ? chunk.slice(0, bodyAt) : chunk;

    // head 里第一个 item 链接就是本条结果的标题
    const anchor = /<a\b[^>]*href=["']([^"']*?\/item\/(\d+)\.html)["'][^>]*>([\s\S]*?)<\/a>/i.exec(head);
    if (!anchor) continue;
    const itemId = anchor[2];
    if (seen.has(itemId)) continue; // 同一物品偶尔重复出现，去重
    seen.add(itemId);

    const linkTitle = cleanText(anchor[3]);
    if (!linkTitle) continue; // 没有可见标题的结果没法做保守匹配，直接丢

    // 分类标记在链接外面：(物品/方块) / (生物/实体) / (多方块结构) …
    const beforeAnchor = head.slice(0, anchor.index);
    const categoryMatch = /\(([^()]{2,12})\)\s*$/.exec(cleanText(beforeAnchor));
    const category = categoryMatch ? categoryMatch[1].trim() : '';

    // 「名称 - [简称] mod 名 (ModName)」：用最后一个 " - " 切，物品名里带空格的可能性远高于带 " - "
    const cut = linkTitle.lastIndexOf(' - ');
    const title = cut > 0 ? linkTitle.slice(0, cut).trim() : linkTitle;
    const modPart = cut > 0 ? linkTitle.slice(cut + 3).trim() : '';
    const modName = modPart.replace(/^\[[^\]]*\]\s*/, '').trim();

    out.push({
      pageUrl: MCMOD.itemUrl(itemId),
      itemId,
      title,
      modName,
      category,
      rawTitle: linkTitle,
    });
  }
  return out;
}

/**
 * 从页面里抽所有 `i.mcmod.cn/item/icon/<尺寸>/…/<数字>.png` 图标。
 *
 * 末尾那个数字就是「这张图标属于哪个物品」，是唯一可靠的归属依据：
 * 详情页里同时混着相关物品、主资料变体的缩略图，按位置找一定认错。
 *
 * @returns {Array<{url: string, id: string, size: number}>}
 */
function collectItemIcons(html) {
  const found = [];
  const seen = new Set();
  const re = /((?:https?:)?\/\/i\.mcmod\.cn\/item\/icon\/(\d+)x(\d+)\/(?:\d+\/)?(\d+)\.png)/gi;
  for (const m of String(html ?? '').matchAll(re)) {
    const id = m[4];
    if (id === '0' || seen.has(m[1])) continue; // 0.png 是「没有图标」的占位图
    seen.add(m[1]);
    found.push({ url: m[1], id, size: Number(m[2]) || 0 });
  }
  return found;
}

/** 把 `//i.mcmod.cn/...`、`/item/...` 统一补成 https 绝对地址；不像图片就返回 ''。 */
function absoluteIconUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text || /^data:/i.test(text)) return '';
  if (text.startsWith('//')) return `https:${text}`;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return `${MCMOD.iconHost}${text}`;
  return '';
}

/** 从地址里读声明的尺寸（`/128x128/` → 128）；读不到按 0。 */
function sizeFromUrl(url) {
  const m = /\/(\d+)x(\d+)\//.exec(String(url ?? ''));
  return m ? Number(m[1]) || 0 : 0;
}

/** 抽 `<meta property="og:image" content="…">`（属性顺序两种都认）。 */
function findOgImage(html) {
  const text = String(html ?? '');
  const patterns = [
    /<meta\b[^>]*property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return absoluteIconUrl(m[1]);
  }
  return '';
}

/**
 * 解析物品详情页。
 *
 * 返回 `{ title, iconUrl, size }`；拿不到就是 `iconUrl: null, size: 0`（不编图）。
 *
 * 取图顺序：
 *   1. 路径末尾数字 == 本页物品 ID 的那张（最准：实测 32x32 和 128x128 两份，
 *      取大的；两张都会出现在页面上）。本页 ID 从 `/item/edit/<id>/` 里读，
 *      实测每个物品页都有这个编辑链接。
 *   2. `<meta property="og:image">`（实测物品页没有，但留作兜底：换版式时不至于全瞎）。
 *   3. 都没有 → null。
 *
 * 绝对不能退化成「页面上随便找一张 icon」：详情页里塞满了相关物品的缩略图，
 * 取错了就是「图标用错」，比没图标糟糕得多。
 *
 * @param {string} html
 * @param {{itemId?: string|number}} [opts]
 * @returns {{title: string, iconUrl: string|null, size: number}}
 */
export function parseItemPage(html, opts = {}) {
  const text = typeof html === 'string' ? html : '';

  // 1) 标题：物品页正文里的 <h5> 最可靠；没有就退回 <title>
  let title = '';
  const h5 = /<div class="itemname">[\s\S]{0,600}?<h5>([\s\S]*?)<\/h5>/i.exec(text);
  if (h5) title = cleanText(h5[1]);
  if (!title) {
    const t = /<title>([\s\S]*?)<\/title>/i.exec(text);
    if (t) {
      // 「熔岩地狱方块 (…) - [M3]魔法金属 (…) - MC百科|最大的Minecraft中文MOD百科」
      title = cleanText(t[1]).replace(/\s*-\s*MC百科.*$/i, '').trim();
      const cut = title.lastIndexOf(' - ');
      if (cut > 0) title = title.slice(0, cut).trim();
    }
  }

  // 2) 本页物品 ID
  let itemId = String(opts.itemId ?? '').trim();
  if (!itemId) {
    const edit = /\/item\/edit\/(\d+)\//.exec(text) ?? /\/item\/tab\/add\/(\d+)\//.exec(text);
    if (edit) itemId = edit[1];
  }

  // 3) 先找「自己的」图标，按尺寸从大到小。
  //    读不到本页 ID 就**不猜**：页面上全是别人（相关物品/变体）的图，猜一定出错。
  let iconUrl = null;
  let size = 0;
  if (itemId) {
    const own = collectItemIcons(text)
      .filter((icon) => icon.id === itemId)
      .sort((a, b) => b.size - a.size);
    if (own.length) {
      iconUrl = absoluteIconUrl(own[0].url) || null;
      size = own[0].size;
    }
  }

  // 4) og:image 兜底（并把尺寸从地址里读出来）
  if (!iconUrl) {
    iconUrl = findOgImage(text) || null;
    if (iconUrl) size = sizeFromUrl(iconUrl);
  }

  return { title, iconUrl, size };
}

/**
 * 从搜索结果里挑出「最可能是同一个物品」的那一条。
 *
 * 保守到什么程度：只要有两个以上同等级的候选，就返回 null —— 宁可让面板画占位图，
 * 也不把一个长得像的东西的图标贴上去。注释里的每条规则都对应一次「差点给错」。
 *
 * 命中规则：
 *   A. 规范化后标题**完全等于**物品名 → 候选；只有一个候选就直接命中（不再看 mod）；
 *      有多个（比如好几个模组都有「齿轮」）才拿 mod 名收窄，收窄后仍不唯一就放弃。
 *   B. 标题「括号前的主名」完全等于物品名 → 与 A 同一等级（括号里通常是英文/繁体别名）。
 *   C. 标题**完整包含**物品名（且物品名规范化后 ≥ 2 个字，避免单字乱撞），
 *      并且 mod 名对得上（modName 为空时视为不限制）→ 候选；唯一才算命中。
 *   D. 其余一律 null。
 *
 * 为什么 A/B 不强制 mod 名：实测 mcmod 的 mod 字段写的是中文全名（「灾变 (L_Ender's Cataclysm)」），
 * 而调用方手里只有命名空间（`cataclysm`）。硬套 mod 名会把「末影傀儡刷怪蛋」这种
 * 中文名一模一样、100% 命中的结果也拒掉（实测 24 条样本里误伤 2 条）。名字完全一样时
 * 才放弃 mod 校验；「只是包含」时仍然必须 mod 对得上。
 *
 * mod 名怎么算「对得上」：标题、括号后的 mod 段、或搜索结果里带的 modName，
 * 任一处包含调用方给的 modName 就算（两个方向都试，因为调用方可能传 modId `create`，
 * 也可能传显示名 `机械动力 (Create)`）。modName 为空 = 不校验，风险由调用方承担。
 *
 * @param {ReturnType<typeof parseSearchHtml>} results
 * @param {{name?: string, modName?: string}} want
 * @returns {null | (ReturnType<typeof parseSearchHtml>[number] & {match: 'exact'|'contains'})}
 */
export function pickBestMatch(results, want = {}) {
  const list = Array.isArray(results) ? results : [];
  const name = normalizeForMatch(want.name);
  if (!name) return null;
  const modName = normalizeForMatch(want.modName);

  /** mod 名是否对得上：wantMod 为空算「未限制」。 */
  const modOk = (item) => {
    if (!modName) return true;
    const haystack = normalizeForMatch(`${item?.rawTitle ?? ''} ${item?.modName ?? ''} ${item?.title ?? ''}`);
    if (!haystack) return false;
    return haystack.includes(modName) || (haystack.length >= 3 && modName.includes(normalizeForMatch(item?.modName ?? '')));
  };

  const exact = [];
  const contains = [];
  for (const item of list) {
    if (!item || !item.title) continue;
    const full = normalizeForMatch(item.title);
    const primary = normalizeForMatch(primaryTitle(item.title));
    if (full === name || primary === name) {
      exact.push(item);
      continue;
    }
    if (name.length >= 2 && (full.includes(name) || primary.includes(name)) && modOk(item)) {
      contains.push(item);
    }
  }

  // 名字完全一样（含括号前主名一样）：只有一个候选就命中；多个才用 mod 名收窄，收窄后仍不唯一就放弃
  if (exact.length) {
    if (exact.length === 1) return { ...exact[0], match: 'exact' };
    if (!modName) return null;
    const narrowed = exact.filter(modOk);
    return narrowed.length === 1 ? { ...narrowed[0], match: 'exact' } : null;
  }

  if (contains.length === 1) return { ...contains[0], match: 'contains' };
  return null;
}

/**
 * 缓存目录：`<mcRoot>/.dsh-icon-cache/mcmod`。
 *
 * 跟 `.dsh-installers` 一个风格 —— 包内的隐藏目录，不污染 versions/，
 * 用户换包时也不会把别人的图标带过去。
 */
export function cacheDir(mcRoot) {
  return path.join(path.resolve(String(mcRoot ?? '')), '.dsh-icon-cache', 'mcmod');
}

/**
 * 读缓存索引。坏文件 / 条目形状不对一律当空 —— 缓存坏了只该「重新下载」，
 * 不该让面板报错。
 *
 * @param {string} dir
 * @returns {Record<string, {file: string, title: string, source: string, at: number}>}
 */
export function readWebCache(dir) {
  if (!dir) return {};
  const file = path.join(String(dir ?? ''), 'index.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};

  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key || !value || typeof value !== 'object') continue;
    if (typeof value.file !== 'string' || !value.file.trim()) continue;
    // 文件名的安全阀：缓存目录里的文件名只能是纯文件名，防止索引被改写后越界读盘
    if (/[\\/]|\.\./.test(value.file)) continue;
    out[key] = {
      file: value.file,
      title: typeof value.title === 'string' ? value.title : '',
      source: typeof value.source === 'string' ? value.source : '',
      at: Number.isFinite(value.at) ? Number(value.at) : 0,
    };
  }
  return out;
}

/**
 * 写缓存索引（先写临时文件再改名，中途断电不会留下半个 JSON）。
 *
 * @returns {boolean} 写成功与否；失败**不抛**（缓存写不进去不影响本次出图）。
 */
export function writeWebCache(dir, map) {
  const target = path.join(String(dir ?? ''), 'index.json');
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(map ?? {}, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件删不掉就算了，下次改名会覆盖 */
    }
    return false;
  }
}

/**
 * 读 PNG 的 IHDR，拿真实宽高。
 *
 * 为什么不能信地址里的 `32x32`：实测 `/item/icon/32x32/…` 有时直接返回 128×128 的真图，
 * 只有读文件头才知道到底多大。
 *
 * @returns {{w: number, h: number} | null}
 */
export function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** 是不是 PNG（签名 + 至少一个完整的 IHDR）。 */
function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47;
}

/** 缓存键：`lava` / `minecraft:lava` / `Minecraft:Lava` 都归到 `minecraft:lava`。 */
export function cacheKeyOf(itemId) {
  const text = String(itemId ?? '').trim();
  if (!text) return '';
  const id = text.includes(':') ? text : `minecraft:${text}`;
  const [ns, ...rest] = id.split(':');
  const name = rest.join(':');
  if (!/^[a-z0-9_.-]+$/i.test(ns) || !name) return '';
  return `${ns.toLowerCase()}:${name.toLowerCase()}`;
}

/** Buffer → data URL。 */
function toDataUrl(buf) {
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/**
 * 返回统一的失败形状：调用方只需看 `ok` / `reason`，永远不用 try/catch。
 */
function fail(reason) {
  return { ok: false, dataUrl: null, source: null, title: null, cached: false, reason: String(reason ?? '') };
}

/**
 * 从结果里拿「搜到的图标能到多大」这类诊断信息时用：把 `128x128` 换成 `32x32` 之类。
 * 目前只在 resolveWebIcon 内部用。
 */
function replaceIconSize(url, sizeText) {
  return String(url ?? '').replace(/\/(\d+)x(\d+)\//, `/${sizeText}/`);
}

/**
 * 解析一个物品的联网图标：缓存 → 搜索 → 保守匹配 → 详情页 → 下载 → 缓存。
 *
 * 每一步失败都返回 `{ ok: false, reason }`，**不抛异常**。失败原因给的是中文短句，
 * 面板可以直接拿去显示（或者只在日志里记）。
 *
 * 可能的失败原因（调用方据此决定要不要给开关/提示）：
 *   - `没有物品 ID`：连缓存键都算不出来；
 *   - `没有中文名，无法在 mcmod 搜索`：物品名缺失或只有 ID；
 *   - `mcmod 提示搜索太频繁，请稍后再试`：被反爬限流；
 *   - `搜索请求失败：…` / `详情页读取失败：…` / `图标下载失败：…`：网络、超时、DNS；
 *   - `搜索没有结果`；
 *   - `没有标题完全匹配的资料（宁可不给也不给错）`：搜到东西但名字/模组对不上；
 *   - `详情页没有物品图标`：mcmod 自己也没图（实测存在，比如 524057）；
 *   - `下载到的内容不是 PNG`：拿到的是错误页而不是图片；
 *   - `内部错误：…`：兜底，理论上不该出现。
 *
 * @param {object} opts
 * @param {string} opts.itemId 物品 ID（`minecraft:lava`，可省 `minecraft:` 前缀）
 * @param {string} [opts.name] 物品在游戏里显示的名字（中文名，搜索关键词）
 * @param {string} [opts.modName] 所属 mod 名/ID，用来收紧匹配；**强烈建议传**
 * @param {string} [opts.mcRoot] Minecraft 根目录（缓存落在它下面的隐藏目录）
 * @param {Function} [opts.fetchImpl] 替换 fetch（测试/代理用）
 * @param {boolean} [opts.force] 无视缓存重新抓
 * @returns {Promise<{ok: boolean, dataUrl: string|null, source: string|null, title: string|null,
 *                    cached: boolean, size?: number, reason?: string}>}
 */
export async function resolveWebIcon(opts = {}) {
  const { itemId, name, modName, mcRoot, fetchImpl, force = false } = opts;
  try {
    const key = cacheKeyOf(itemId);
    if (!key) return fail('没有物品 ID');

    const dir = mcRoot ? cacheDir(mcRoot) : '';
    /** @type {Record<string, {file: string, title: string, source: string, at: number}>} */
    let index = dir ? readWebCache(dir) : {};

    // 1) 缓存命中：索引里有、文件在、且确实是 PNG 才认
    if (dir && !force && index[key]) {
      const entry = index[key];
      try {
        const cached = fs.readFileSync(path.join(dir, entry.file));
        if (isPng(cached)) {
          const dim = pngSize(cached);
          return {
            ok: true,
            dataUrl: toDataUrl(cached),
            source: entry.source || null,
            title: entry.title || null,
            cached: true,
            size: dim ? dim.w : 0,
          };
        }
      } catch {
        /* 文件丢了就按未命中继续走联网 */
      }
      // 索引还在但文件坏了/没了：清掉这一条，继续联网
      delete index[key];
    }

    // 2) 搜索
    const keyword = String(name ?? '').trim();
    if (!keyword) return fail('没有中文名，无法在 mcmod 搜索');

    const searched = await searchMcmod(keyword, { fetchImpl });
    if (!searched.ok) return fail(searched.reason ?? '搜索失败');
    if (!searched.results.length) return fail('搜索没有结果');

    // 3) 保守匹配
    const hit = pickBestMatch(searched.results, { name: keyword, modName });
    if (!hit) return fail('没有标题完全匹配的资料（宁可不给也不给错）');

    // 4) 详情页（走同一条串行 + 节流线）
    let page;
    try {
      page = await serialGet(hit.pageUrl, { fetchImpl });
      if (!page.ok) return fail(`详情页读取失败：HTTP ${page.status}`);
    } catch (error) {
      return fail(`详情页读取失败：${error?.message ?? error}`);
    }
    let pageHtml;
    try {
      pageHtml = await page.text();
    } catch (error) {
      return fail(`详情页读取失败：${error?.message ?? error}`);
    }
    const parsed = parseItemPage(pageHtml, { itemId: hit.itemId });
    if (!parsed.iconUrl) return fail('详情页没有物品图标');

    // 5) 尽量拿大图：先按已声明的尺寸取，再试更大的（实测 32x32 那档经常直接返回 128 的真图）
    let bytes = null;
    let iconUrlUsed = parsed.iconUrl;
    const declared = parsed.size || sizeFromUrl(parsed.iconUrl);
    // 只有地址里真的带 `/32x32/` 这种尺寸段时才谈「升档」，否则替换出来还是同一个地址
    const bigger =
      declared > 0 && /\/\d+x\d+\//.test(parsed.iconUrl)
        ? ICON_SIZES.filter((s) => Number(s.split('x')[0]) > declared).map((s) => replaceIconSize(parsed.iconUrl, s))
        : [];
    for (const candidate of [parsed.iconUrl, ...bigger]) {
      try {
        const res = await serialGet(candidate, { fetchImpl, referer: hit.pageUrl });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (!isPng(buf) || buf.length > MAX_ICON_BYTES) continue;
        bytes = buf;
        iconUrlUsed = candidate;
        break;
      } catch {
        /* 这个尺寸拿不到就试下一个 */
      }
    }
    if (!bytes) return fail('图标下载失败');

    const dim = pngSize(bytes);

    // 6) 存缓存（存不进去也照样返回，本次出图不受影响）
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12);
        const file = `${hash}.png`;
        fs.writeFileSync(path.join(dir, file), bytes);
        index = { ...index, [key]: { file, title: parsed.title || hit.title, source: hit.pageUrl, at: Date.now() } };
        // 顺手清掉索引里指向「不存在的文件」的老条目，避免 index.json 越长越假
        writeWebCache(dir, index);
      } catch {
        /* 缓存失败忽略 */
      }
    }

    return {
      ok: true,
      dataUrl: toDataUrl(bytes),
      source: hit.pageUrl,
      title: parsed.title || hit.title,
      cached: false,
      size: dim ? dim.w : 0,
      iconUrl: iconUrlUsed,
    };
  } catch (error) {
    return fail(`内部错误：${error?.message ?? error}`);
  }
}

/**
 * 在 mcmod 上搜关键词，抽出物品/方块结果。
 *
 * 不抛异常：坏网页、超时、限流、非 200 全部折成 `{ ok: false, results: [], reason }`。
 *
 * 被限流后会进入一段**冷却期**（60 秒），期间所有搜索直接返回限流原因、不再发请求。
 * 为什么要有冷却：实测反爬看的是「一段时间内的总频率」，不是单纯单次间隔 —— 以 1.1 秒
 * 间隔连跑三轮批量探测照样会触发「搜索太频繁」。触发之后继续硬发只会把封禁时间拖长。
 *
 * @param {string} keyword
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, results: Array<{pageUrl: string, itemId: string, title: string, modName: string, category: string, rawTitle: string}>, reason?: string}>}
 */
export async function searchMcmod(keyword, opts = {}) {
  const key = String(keyword ?? '').trim();
  if (!key) return { ok: false, results: [], reason: '搜索词为空' };
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  // 冷却期内不发请求：既省时间，也免得把限流越喂越久
  const waitLeft = cooldownUntil - Date.now();
  if (waitLeft > 0) {
    return { ok: false, results: [], reason: `mcmod 提示搜索太频繁，请稍后再试（约 ${Math.ceil(waitLeft / 1000)} 秒后可再试）` };
  }

  try {
    const res = await serialGet(MCMOD.searchUrl(key), { fetchImpl: opts.fetchImpl, timeoutMs, gap: SEARCH_GAP_MS });
    if (!res.ok) return { ok: false, results: [], reason: `搜索请求失败：HTTP ${res.status}` };

    const html = await res.text();
    // 反爬：HTTP 200，但正文里是「搜索太频繁」。这个必须单独认出来，
    // 否则会被误判成「mcmod 上没有这件东西」。
    if (/搜索太频繁/.test(html)) {
      cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      return { ok: false, results: [], reason: 'mcmod 提示搜索太频繁，请稍后再试' };
    }
    const results = parseSearchHtml(html);
    if (!results.length) {
      return { ok: false, results: [], reason: '搜索没有结果' };
    }
    return { ok: true, results };
  } catch (error) {
    const message = error?.name === 'AbortError' ? `搜索超时（${Math.round(timeoutMs / 1000)} 秒）` : String(error?.message ?? error);
    return { ok: false, results: [], reason: `搜索请求失败：${message}` };
  }
}

/**
 * 清掉限流冷却期。
 *
 * 只给测试和探针用：正常调用方碰上冷却就该老实等，别绕过去继续打。
 */
export function resetCooldown() {
  cooldownUntil = 0;
}