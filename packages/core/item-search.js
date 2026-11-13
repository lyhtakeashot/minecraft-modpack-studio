/**
 * 物品检索的纯函数层。
 *
 * 为什么放在 core：界面接口（`lib/host/api.js` 的 `/items`）和模型工具（MCP 服务器的
 * `item_search`）用的是同一套排序规则。core 保持「纯 Node、零外部依赖」这条底线，
 * 界面和模型两条路都从这里取同一个函数。
 *
 * 排序规则（rank 越小越靠前）：精确命中 > 路径段前缀 > 路径段包含 > 命名空间包含 > 显示名命中。
 * 这样搜 "diamond" 时 `minecraft:diamond` 排第一，`minecraft:diamond_sword` 排在后面。
 *
 * ── 搜索语法（照抄 JEI 19.x，2026-11-05）────────────────────────────
 *   `@create`     只看某个 mod（写 modId 或 mod 名都行）
 *   `#planks`     按标签搜（物品属于这个 tag）
 *   `$耐久`       搜简介 / tooltip
 *   `-木`         排除含这个字的
 *   `"铁 锭"`     带空格的整词组
 *   `齿轮|机壳`   或（任一组命中就算）
 *   多个词之间是「与」（都得命中），跟 JEI 一致
 *
 * 另外补了 JEI 没有的一层：**拼音**。`zuanshi` / `zs` 都能找到「钻石」，
 * 因为整合包里的物品绝大多数只有中文名，中文输入法切换太麻烦。
 */
import { isPinyinQuery, matchPinyin } from './pinyin.js';

/**
 * 单条命中的排序权重（越小越靠前）。
 *
 * 分两段：先看物品 ID 是否命中，ID 不命中才退到显示名（中文名）。
 * 为什么 ID 优先：用户（和模型）要的是能写进配方的那串英文 ID，
 * 中文名只是帮不熟英文的人找到它。
 */
function rankOf(lower, pathPart, q, nameLower) {
  if (!q) return 8;
  if (lower === q || pathPart === q) return 0;
  if (pathPart.startsWith(q)) return 1;
  if (pathPart.includes(q)) return 2;
  if (lower.includes(q)) return 3;
  if (nameLower) {
    if (nameLower === q) return 4;
    if (nameLower.startsWith(q)) return 5;
    if (nameLower.includes(q)) return 6;
  }
  return -1;
}

/**
 * 把查询串切成「或组 × 与项」。
 *
 * 返回 `{groups: [[token...], ...], exclude: [token...]}`：
 * 物品要满足**任意一个 group 的全部 token**，且**不命中任何 exclude**。
 *
 * token 形状 `{text, prefix, exclude}`，prefix 是 `@ # $` 之一或空串。
 * 引号里的空格和竖线不算分隔符（`"铁 锭"` 是一个词）。
 */
function tokenize(raw) {
  const text = String(raw ?? '');
  const groups = [[]];
  const exclude = [];
  let cur = '';
  let quote = false;

  const flush = () => {
    if (!cur) return;
    let t = cur;
    cur = '';
    let neg = false;
    if (t.length > 1 && t.startsWith('-')) {
      neg = true;
      t = t.slice(1);
    }
    let prefix = '';
    if (/^[@#$^&%]/.test(t)) {
      prefix = t[0];
      t = t.slice(1);
    }
    if (!t) return;
    const tok = { text: t.toLowerCase(), prefix, exclude: neg };
    if (neg) exclude.push(tok);
    else groups[groups.length - 1].push(tok);
  };

  for (const ch of text) {
    if (ch === '"') {
      quote = !quote;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      flush();
      continue;
    }
    if (!quote && ch === '|') {
      flush();
      groups.push([]);
      continue;
    }
    cur += ch;
  }
  flush();
  return { groups: groups.filter((g) => g.length), exclude };
}

/** 标签命中的权重：tag 全名或路径段精确 = 0，前缀 = 1，包含 = 2。 */
function tagRank(tags, q) {
  if (!tags || tags.size === 0) return -1;
  let best = -1;
  for (const tag of tags) {
    const lower = String(tag).toLowerCase();
    const colon = lower.indexOf(':');
    const pathPart = colon >= 0 ? lower.slice(colon + 1) : lower;
    let rank = -1;
    if (lower === q || pathPart === q) rank = 0;
    else if (pathPart.startsWith(q)) rank = 1;
    else if (pathPart.includes(q) || lower.includes(q)) rank = 2;
    if (rank >= 0 && (best < 0 || rank < best)) best = rank;
  }
  return best;
}

/**
 * 一个词对一条物品的命中权重；不命中返回 -1。
 *
 * @param {{text: string, prefix: string}} tok
 * @param {{id: string, lower: string, pathPart: string, name: string, nameLower: string,
 *          mods: string[], modNames: Map<string,string>|null, tags: Set<string>|null, desc: string}} ctx
 */
function termRank(tok, ctx) {
  const q = tok.text;

  // @mod —— 只看某个 mod。modId 和 mod 显示名都认（JEI 就是这样）
  if (tok.prefix === '@') {
    let best = -1;
    for (const mod of ctx.mods) {
      const lower = String(mod).toLowerCase();
      let rank = -1;
      if (lower === q) rank = 0;
      else if (lower.startsWith(q)) rank = 1;
      else if (lower.includes(q)) rank = 2;
      if (rank >= 0 && (best < 0 || rank < best)) best = rank;
    }
    // mod 显示名（「机械动力」这种）只做包含匹配，排在 modId 命中之后
    if (ctx.modNames) {
      for (const mod of ctx.mods) {
        const name = String(ctx.modNames.get(mod) ?? '').toLowerCase();
        if (!name) continue;
        const rank = name === q ? 3 : name.includes(q) ? 4 : -1;
        if (rank >= 0 && (best < 0 || rank < best)) best = rank;
      }
    }
    return best;
  }

  // #tag —— 按标签搜
  if (tok.prefix === '#') return tagRank(ctx.tags, q);

  // $tooltip —— 搜简介。只有「包含」一种命中，权重固定 0
  if (tok.prefix === '$') {
    return ctx.desc && String(ctx.desc).toLowerCase().includes(q) ? 0 : -1;
  }

  // ^ & % 这三类 JEI 默认是关的（颜色 / 资源路径 / 创造栏），我们也没有对应数据。
  // 当成普通词处理，总比「打上去什么都没发生」好。
  const base = rankOf(ctx.lower, ctx.pathPart, q, ctx.nameLower);
  if (base >= 0) return base;

  // 拼音兜底：只有纯字母的查询才值得试（中文查询走上面的名字匹配就够了）
  if (ctx.name && isPinyinQuery(q)) {
    const py = matchPinyin(ctx.name, q);
    // 0/1/2 → 4/5/6，跟「名字精确 / 前缀 / 包含」同一档，
    // 这样拼音命中不会把真正名字命中的物品挤下去
    if (py >= 0) return 4 + py;
  }
  return -1;
}

/**
 * 纯函数：从物品表里筛 + 排，返回**全部命中**（不截断）。
 *
 * 抽出来是因为「物品网格」需要先知道总数才能算页数，再切一页出来。
 * 如果先调 searchItems 算总数、再调一次取这一页，等于把 1 万个物品扫两遍。
 *
 * @param {Iterable<{id: string, from?: string[]}>} entries
 * @param {object} [opts] 见 searchItems 的说明（`limit` / `offset` 在这里不起作用）
 * @returns {Array<{id: string, name: string, from: string[], rank: number}>}
 */
export function rankAll(entries, opts = {}) {
  const raw = String(opts.query ?? '').trim();
  const ns = String(opts.namespace ?? '').trim().toLowerCase();
  const mod = String(opts.modId ?? '').trim().toLowerCase();
  const names = opts.names instanceof Map ? opts.names : null;
  const descs = opts.descriptions instanceof Map ? opts.descriptions : null;
  const tagsOf = opts.tags instanceof Map ? opts.tags : null;
  const modNames = opts.modNames instanceof Map ? opts.modNames : null;

  const { groups, exclude } = tokenize(raw);
  const hasQuery = groups.length > 0 || exclude.length > 0;

  const scored = [];
  for (const e of entries) {
    const id = String(e.id ?? '');
    if (!id) continue;
    const lower = id.toLowerCase();
    const colon = lower.indexOf(':');
    const nsPart = colon >= 0 ? lower.slice(0, colon) : '';
    const pathPart = colon >= 0 ? lower.slice(colon + 1) : lower;

    if (ns && nsPart !== ns) continue;
    const from = Array.isArray(e.from) ? e.from : [];
    if (mod && !from.some((f) => String(f).toLowerCase() === mod)) continue;

    const name = names ? (names.get(id) ?? '') : '';
    const desc = descs ? (descs.get(id) ?? '') : '';
    const tags = tagsOf ? new Set(tagsOf.get(id) ?? []) : null;

    let rank = 8;
    if (hasQuery) {
      const ctx = {
        id,
        lower,
        pathPart,
        name,
        nameLower: name.toLowerCase(),
        mods: from,
        modNames,
        tags,
        desc,
      };
      // 排除项：命中任意一个就整个丢掉
      if (exclude.some((tok) => termRank(tok, ctx) >= 0)) continue;
      // 或组：任意一组全命中即可，取其中最好的那组
      let best = -1;
      for (const group of groups) {
        let worst = 0;
        let ok = true;
        for (const tok of group) {
          const one = termRank(tok, ctx);
          if (one < 0) {
            ok = false;
            break;
          }
          if (one > worst) worst = one;
        }
        if (ok && (best < 0 || worst < best)) best = worst;
      }
      if (best < 0) continue;
      rank = best;
    }

    scored.push({ id, name, from, rank });
  }

  // 同分时短 ID 优先（`minecraft:diamond` 比 `minecraft:diamond_block` 更像用户想找的），再按字典序稳定排序
  scored.sort((a, b) => a.rank - b.rank || a.id.length - b.id.length || a.id.localeCompare(b.id));
  return scored;
}

/**
 * 纯函数：从物品表里筛 + 排 + 截断。抽出来是为了能单测，不必造真实例。
 *
 * @param {Iterable<{id: string, from?: string[]}>} entries
 * @param {object} [opts]
 * @param {string} [opts.query] 查询串（支持 JEI 那套语法，见文件头）
 * @param {string} [opts.namespace] 只要这个命名空间
 * @param {string} [opts.modId] 只要这个 mod 提供的 ID
 * @param {number} [opts.limit] 返回几条（默认 30，上限 200）
 * @param {number} [opts.offset] 从第几条开始（翻页用，默认 0）
 * @param {Map<string,string>} [opts.names] 物品 ID → 显示名；给了就能按中文名/拼音搜
 * @param {Map<string,string>} [opts.descriptions] 物品 ID → 简介；给了才能用 `$` 搜
 * @param {Map<string,string[]>} [opts.tags] 物品 ID → 标签列表；给了才能用 `#` 搜
 * @param {Map<string,string>} [opts.modNames] modId → mod 显示名；给了 `@` 才能按中文 mod 名搜
 * @returns {{total: number, shown: number, offset: number, items: Array<{id: string, from: string[], name: string, rank: number}>}}
 */
export function searchItems(entries, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit ?? 30) || 30, 200));
  const offset = Math.max(0, Number(opts.offset ?? 0) || 0);
  const scored = rankAll(entries, opts);
  return {
    total: scored.length,
    shown: Math.min(limit, Math.max(0, scored.length - offset)),
    offset,
    items: scored.slice(offset, offset + limit),
  };
}

/**
 * 把查询串解析成人能看的说明（界面显示「正在按标签搜 planks」这种提示）。
 *
 * 只做展示用，不参与匹配 —— 匹配永远走 searchItems 内部那一份，
 * 免得「提示说按标签搜、实际按名字搜」这种两套逻辑对不上。
 */
export function describeQuery(raw) {
  const { groups, exclude } = tokenize(raw);
  const label = (tok) => {
    if (tok.prefix === '@') return `mod「${tok.text}」`;
    if (tok.prefix === '#') return `标签「${tok.text}」`;
    if (tok.prefix === '$') return `简介含「${tok.text}」`;
    return `「${tok.text}」`;
  };
  const parts = [];
  if (groups.length > 1) parts.push(`${groups.length} 组任选其一`);
  const first = groups[0] ?? [];
  if (first.length) parts.push(first.map(label).join(' 且 '));
  if (exclude.length) parts.push(`排除 ${exclude.map(label).join('、')}`);
  return parts.join('，') || '全部物品';
}
