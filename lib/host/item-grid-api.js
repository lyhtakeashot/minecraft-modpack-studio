/**
 * 「物品网格」的宿主接口 —— 界面上那个 JEI 式的物品面板。
 *
 * 为什么单独一条接口，不复用 `/items`：
 *   `/items` 是「搜到了给我几条」（默认 40、最多 200），给下拉候选列表用；
 *   物品网格要的是**翻页浏览全部物品**，还必须知道「一共多少条、现在第几页」，
 *   并且不带关键字时也要能翻（JEI 不搜索时就是按 mod 顺序列全部物品）。
 *   两件事的参数和返回都不一样，混在一条上会让两边都别扭。
 *
 * 页大小照抄 JEI 19.x 的默认配置：9 列 × 16 行 = 144 个
 * （`config/jei/jei-client.ini` 里 `[ingredientList] maxRows = 16` / `maxColumns = 9`）。
 */
import { McError } from '../../packages/core/errors.js';
import { resolveInstance } from '../../packages/core/instance.js';
import { rankAll, describeQuery } from '../../packages/core/item-search.js';
import { cachedIndex } from './cache.js';
import { boolOr, readParams } from './params.js';
import { truthInfoOf } from './item-truth.js';

/** 一页多少格：JEI 默认 9 列 × 16 行。 */
export const GRID_COLS = 9;
export const GRID_ROWS = 16;
export const GRID_PAGE = GRID_COLS * GRID_ROWS;

function instanceOf(params) {
  const dir = String(params.dir ?? '').trim();
  if (!dir) throw new McError('缺少实例目录', '在界面顶部先连一个整合包', 'McBadArgs');
  return resolveInstance(dir, String(params.id ?? ''));
}

/** modId → mod 显示名（`@机械动力` 能搜到 `@create` 的东西）。 */
function modNameMap(idx) {
  const map = new Map();
  for (const m of idx.mods ?? []) {
    if (m.modId && m.name) map.set(m.modId, m.name);
  }
  return map;
}

/**
 * 一页物品。
 *
 * 参数：
 *   dir / id      实例（必填 dir）
 *   q             查询串，支持 JEI 那套语法（见 packages/core/item-search.js 文件头）
 *   page          第几页，从 1 开始（默认 1）
 *   pageSize      一页多少格（默认 144，上限 400 —— 别让界面一次要一万个）
 *   refresh=1     忽略 10 分钟缓存重新索引
 *   showAll=1     不管有没有游戏真值清单，都显示全部（幽灵仍硬过滤）
 *
 * 返回里带 `pages`（总页数）和 `page`（校正后的当前页）：
 * 用户在第 5 页搜了一个只有 2 页的关键字，不能让界面停在空白的第 5 页。
 *
 * 显示口径（2026-11-07 用户要 100% 精确）：导入过游戏清单就只显示清单里
 * 真的注册过的物品；没导入过（或 showAll=1）退回「显示全部」，绝不空白、
 * 也绝不拿离线猜测冒充精确。
 */
export async function handleItemGrid(params) {
  const request = await readParams(params);
  const instance = instanceOf(request);
  const idx = cachedIndex(instance, String(request.refresh ?? '') === '1');

  const keyword = String(request.q ?? '').trim();
  const pageSize = Math.max(1, Math.min(Number(request.pageSize ?? GRID_PAGE) || GRID_PAGE, 400));
  const wantedPage = Math.max(1, Number(request.page ?? 1) || 1);

  const total = idx._items.size;
  // 幽灵物品（包里没有它、游戏里也不存在）不进网格：它们永远是一格空位。
  // 搜索「`@ae2`」这种已经装不上的 mod 时，给了也是白给。
  const ghosts = idx._ghostItems ?? new Set();
  const pool0 = ghosts.size ? [...idx._items.values()].filter((it) => !ghosts.has(it.id)) : [...idx._items.values()];
  // 游戏真值清单：导入过就只留清单里注册过的，没导入/点「显示全部」就全放。
  const showAll = boolOr(request.showAll, false);
  const truth = truthInfoOf(instance);
  const filter = !showAll && truth ? 'truth' : 'all';
  const pool = filter === 'truth' ? pool0.filter((it) => truth.set.has(it.id)) : pool0;
  // 只排一遍：先拿到全部命中，再按页切 —— 扫两遍的话 1 万个物品要算两次拼音
  const modNames = modNameMap(idx);
  const ranked = rankAll(pool, {
    query: keyword,
    names: idx._names,
    descriptions: idx._descriptions,
    tags: idx._itemTags,
    modNames,
  });
  // 没搜索时按「mod 分组」排，照 JEI 的 `sorting.ingredientSortStages`
  // （MOD_NAME → INGREDIENT_TYPE → CREATIVE_MENU）。我们没有「创造模式物品栏」
  // 那份顺序数据，就用「名字 → ID」兜底。
  //
  // **原版固定排最前面**：用户找附魔书、钻石胸甲这种原版东西时，
  // 不该在第 60 多页的字母堆里翻（2026-11-05 用户报「原版的东西好像都没找齐」，
  // 其实就是按 ID 字母序排，`minecraft:` 夹在中间）。
  // 有关键字时不重排：搜索结果就该按相关度。
  if (!keyword) {
    const groupOf = (id) => {
      const ns = id.slice(0, Math.max(0, id.indexOf(':')));
      if (ns === 'minecraft') return '';
      return String(modNames.get(ns) ?? ns).toLowerCase();
    };
    ranked.sort((a, b) => {
      const ka = groupOf(a.id);
      const kb = groupOf(b.id);
      if (ka !== kb) return ka < kb ? -1 : 1;
      const na = idx.nameOf(a.id) ?? '';
      const nb = idx.nameOf(b.id) ?? '';
      if (!na && nb) return 1;
      if (na && !nb) return -1;
      if (na && nb) {
        const byName = na.localeCompare(nb, 'zh');
        if (byName) return byName;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  const pages = Math.max(1, Math.ceil(ranked.length / pageSize));
  const page = Math.min(wantedPage, pages);
  const offset = (page - 1) * pageSize;

  const items = ranked.slice(offset, offset + pageSize).map((it) => {
    const name = idx.nameOf(it.id) ?? '';
    const ns = it.id.slice(0, Math.max(0, it.id.indexOf(':')));
    // 悬停气泡要显示「这东西来自哪个 mod」—— 排序已经是按 mod 分组了，
    // 不标出来的话用户只知道「一堆图排在一起」，不知道分组边界在哪。
    const out = { id: it.id, name, mods: it.from, mod: modNames.get(ns) ?? ns };
    // 没简介的物品**不加 desc 字段**，省得界面把空字符串当成「有简介」
    const desc = idx.describe(it.id) ?? '';
    if (desc) out.desc = desc;
    return out;
  });

  return {
    ok: true,
    instance: instance.id,
    query: keyword,
    // 「正在按标签搜 planks」这种人话，界面显示在搜索框下面
    queryHint: keyword ? describeQuery(keyword) : '',
    total: ranked.length,
    indexTotal: total - ghosts.size,
    /** 显示口径：truth=照游戏清单（100% 精确） / all=显示全部（索引里非幽灵的都算） */
    showAll,
    filter,
    hasTruth: !!truth,
    truthSource: truth?.source ?? '',
    /** 清单口径下被藏起来的条数（界面可以说「已按游戏清单藏起 N 条」） */
    hiddenCount: filter === 'truth' ? pool0.length - pool.length : 0,
    /** 进入本次筛选前的候选总数（幽灵已剔除） */
    poolTotal: pool0.length,
    /** 被藏起来的幽灵物品数（界面可以提示一句，免得用户以为物品少了） */
    ghostCount: ghosts.size,
    page,
    pages,
    pageSize,
    cols: GRID_COLS,
    rows: GRID_ROWS,
    offset,
    items,
    indexedMs: idx.indexedMs,
    tagCount: idx.tagCount ?? 0,
  };
}

/**
 * 标签清单：给界面做「`#` 后面打几个字，提示有哪些标签」。
 *
 * JEI 没有这个（它只有纯文本搜索），但我们的用户不熟标签名，
 * 不给提示的话 `#` 这个功能等于不存在。
 */
export async function handleItemTags(params) {
  const request = await readParams(params);
  const instance = instanceOf(request);
  const idx = cachedIndex(instance, String(request.refresh ?? '') === '1');

  const q = String(request.q ?? '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(request.limit ?? 30) || 30, 200));

  const rows = [];
  for (const [tag, set] of idx._tagItems ?? []) {
    if (tag.startsWith('block:')) continue;
    if (q && !tag.includes(q)) continue;
    rows.push({ tag, items: set.size });
  }
  // 物品多的标签更可能是用户想找的（`minecraft:planks` 比某个 mod 的单例标签有用）
  rows.sort((a, b) => b.items - a.items || a.tag.localeCompare(b.tag));

  return {
    ok: true,
    instance: instance.id,
    query: q,
    total: rows.length,
    shown: Math.min(limit, rows.length),
    tags: rows.slice(0, limit),
    tagCount: idx.tagCount ?? 0,
  };
}
