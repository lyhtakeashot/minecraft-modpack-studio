/**
 * 重叠度与进度分析：帮整合包作者看出「这个包里哪些 mod 在做同一件事」。
 *
 * 为什么需要它：整合包最常见的病不是缺 mod，而是过量 —— 三个 mod 都能存东西、
 * 五个 mod 都能产电。删之前得知道谁和谁撞了，否则删完才发现「任务书里指着它」。
 *
 * 两套启发式（都带置信度，不装成铁证）：
 *   同名  同一个物品路径出现在不同命名空间 → 高置信，几乎一定是同类物品
 *   功能族 按物品路径关键分词根归类 → 中低置信，只用来提示「值得看一眼」
 */

/** 功能族词根表。刻意写得宽 —— 宁可多报几个让人自己判断，也别漏掉。 */
export const FAMILIES = [
  { name: '传动/齿轮', re: /(gear|cogwheel|shaft|axle|belt|chain_drive|sprocket|pulley)/ },
  { name: '矿石处理', re: /(crushed|dust|nugget|ingot|raw_|clump|shard|slurry|ore_)/ },
  { name: '存储', re: /(chest|barrel|storage|drawer|crate|vault|backpack|satchel)/ },
  { name: '流体', re: /(fluid|tank|pipe|hose|pump|reservoir|cistern)/ },
  { name: '能源', re: /(energy|battery|capacitor|generator|solar|reactor|dynamo|wire|cable)/ },
  { name: '任务/进度', re: /(quest|advancement|achievement|trophy)/ },
  { name: '食物', re: /(_food|_stew|_soup|_pie|_bread|_meat|_cooked)/ },
  { name: '工具/武器', re: /(_sword|_pickaxe|_axe|_shovel|_hoe|_bow|_crossbow|_dagger|_spear)/ },
  { name: '护甲', re: /(_helmet|_chestplate|_leggings|_boots)/ },
  { name: '装饰', re: /(_bricks?|_pillar|_wall|_fence|_slab|_stairs|_tiles?)/ },
];

/**
 * 同名物品：同一个路径在不同命名空间下都出现。
 *
 * @param {Map<string, {id: string, from: string[]}>} items indexInstance 的 _items
 * @param {number} [minNamespaces] 至少几个命名空间算撞名，默认 2
 */
export function sameNameCollisions(items, minNamespaces = 2) {
  /** @type {Map<string, Set<string>>} */
  const byPath = new Map();
  for (const id of items.keys()) {
    const cut = id.indexOf(':');
    if (cut <= 0) continue;
    const ns = id.slice(0, cut);
    const p = id.slice(cut + 1);
    if (!p) continue;
    const set = byPath.get(p);
    if (set) set.add(ns);
    else byPath.set(p, new Set([ns]));
  }
  const out = [];
  for (const [pathName, nsSet] of byPath) {
    if (nsSet.size < minNamespaces) continue;
    out.push({
      path: pathName,
      namespaces: [...nsSet].sort(),
      ids: [...nsSet].sort().map((ns) => `${ns}:${pathName}`),
      count: nsSet.size,
    });
  }
  out.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return out;
}

/**
 * 功能族分布：每个族里有哪些 mod、各自多少物品。
 *
 * @param {Map<string, {id: string, from: string[]}>} items
 * @param {number} [minItems] 一个 mod 在某族至少要有几个物品才算「在做这件事」，默认 5
 */
export function familyCoverage(items, minItems = 5) {
  /** @type {Map<string, Map<string, number>>} */
  const famMod = new Map();
  for (const fam of FAMILIES) famMod.set(fam.name, new Map());

  for (const [id, meta] of items) {
    const cut = id.indexOf(':');
    const p = cut > 0 ? id.slice(cut + 1) : id;
    for (const fam of FAMILIES) {
      if (!fam.re.test(p)) continue;
      const mm = famMod.get(fam.name);
      for (const mod of meta.from) mm.set(mod, (mm.get(mod) ?? 0) + 1);
    }
  }

  const out = [];
  for (const fam of FAMILIES) {
    const mm = famMod.get(fam.name);
    const mods = [...mm.entries()]
      .filter(([, n]) => n >= minItems)
      .sort((a, b) => b[1] - a[1])
      .map(([mod, n]) => ({ mod, items: n }));
    out.push({
      family: fam.name,
      modCount: mods.length,
      itemTotal: [...mm.values()].reduce((a, b) => a + b, 0),
      mods,
      /** 有 2 个以上 mod 在做同一件事 → 值得看一眼 */
      crowded: mods.length >= 2,
    });
  }
  out.sort((a, b) => b.modCount - a.modCount);
  return out;
}

/**
 * 进度曲线：按「合成链深度」给物品分层，看这个包的进度是陡还是缓。
 *
 * 深度定义：直接能采/能捡的物品是 0 层；能由 ≤0 层材料合成的物品是 1 层，依此类推。
 * 只用于看形状（前几层堆多少、后面是否断崖），不做精确平衡判断。
 *
 * @param {object} graph buildGraph() 的返回
 * @param {object} [opts]
 * @param {number} [opts.maxDepth] 最多算几层，默认 6
 * @param {number} [opts.maxItems] 参与统计的物品上限，默认 6000
 */
export function progressCurve(graph, opts = {}) {
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 6, 12));
  const maxItems = Math.max(100, opts.maxItems ?? 6000);

  const depth = new Map();
  // 第 0 层 = 基础资源。两种来源：
  //   a) 有配方但配方没有任何可解析材料（材料全是标签/行为数据）→ 直接能拿到
  //   b) 根本没有配方、却出现在别人材料表里（原矿、木头、怪物掉落）→ 只能靠采/捡
  // 少了 (b) 这一半，所有依赖原矿的物品都会永远算不出深度（实测 4,740 个物品全卡住）。
  for (const [item, recipeIds] of graph.producers) {
    if (depth.size >= maxItems) break;
    const anyInput = recipeIds.some((id) => (graph.byId.get(id)?.inputs.length ?? 0) > 0);
    if (!anyInput) depth.set(item, 0);
  }
  for (const item of graph.consumers.keys()) {
    if (depth.size >= maxItems) break;
    if (!graph.producers.has(item)) depth.set(item, 0);
  }

  for (let d = 1; d <= maxDepth; d++) {
    let changed = false;
    for (const [item, recipeIds] of graph.producers) {
      if (depth.has(item)) continue;
      if (depth.size >= maxItems) break;
      for (const rid of recipeIds) {
        const rec = graph.byId.get(rid);
        if (!rec || !rec.inputs.length) continue;
        const allKnown = rec.inputs.every((i) => depth.has(i));
        if (!allKnown) continue;
        const deepest = Math.max(...rec.inputs.map((i) => depth.get(i)));
        // 只有「最深的那个材料正好在第 d-1 层」才算第 d 层；
        // 若最深材料还在更浅层，说明该物品更早就能做出来（等下一轮已经被别的配方抢先赋层）。
        if (deepest !== d - 1) continue;
        depth.set(item, d);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  const buckets = [];
  for (let d = 0; d <= maxDepth; d++) buckets.push({ depth: d, items: 0, samples: [] });
  let unknown = 0;
  for (const [item, d] of depth) {
    const b = buckets[d];
    if (!b) continue;
    b.items++;
    if (b.samples.length < 5) b.samples.push(item);
  }
  for (const item of graph.producers.keys()) if (!depth.has(item)) unknown++;

  const known = depth.size;
  const widest = buckets.reduce((a, b) => (b.items > a.items ? b : a), buckets[0]);
  return {
    buckets,
    knownItems: known,
    unknownItems: unknown,
    widestDepth: widest.depth,
    widestItems: widest.items,
    /** 粗略判断：最宽一层占已知物品的比例 */
    concentration: known ? widest.items / known : 0,
  };
}

/** 人读的重叠报告。 */
export function describeOverlap(collisions, families, limit = 15) {
  const lines = [];
  lines.push(`同名物品（同一路径出现在多个 mod 里）：${collisions.length} 组`);
  for (const c of collisions.slice(0, limit)) {
    lines.push(`  ${c.path}  ←  ${c.namespaces.join('、')}（${c.count} 个 mod）`);
  }
  if (collisions.length > limit) lines.push(`  …还有 ${collisions.length - limit} 组`);

  const crowded = families.filter((f) => f.crowded);
  lines.push('');
  lines.push(`功能撞车（≥2 个 mod 在做同一件事）：${crowded.length} 类`);
  for (const f of crowded) {
    lines.push(`  ${f.family}：${f.mods.slice(0, 6).map((m) => `${m.mod}(${m.items})`).join('、')}${f.mods.length > 6 ? ' …' : ''}`);
  }
  const empty = families.filter((f) => f.modCount === 0);
  if (empty.length) {
    lines.push('');
    lines.push(`一个 mod 都没覆盖的功能：${empty.map((f) => f.family).join('、')}`);
  }
  return lines;
}

/** 人读的进度曲线。 */
export function describeProgress(curve) {
  const lines = [];
  lines.push(`按合成深度分层（参与统计 ${curve.knownItems} 个物品，另有 ${curve.unknownItems} 个算不出深度）：`);
  const max = Math.max(...curve.buckets.map((b) => b.items), 1);
  for (const b of curve.buckets) {
    const bar = '█'.repeat(Math.max(0, Math.round((b.items / max) * 30)));
    lines.push(`  第 ${String(b.depth).padStart(2)} 层  ${String(b.items).padStart(5)} 个  ${bar}`);
    if (b.samples.length) lines.push(`          例：${b.samples.join('、')}`);
  }
  lines.push('');
  lines.push(`最宽的是第 ${curve.widestDepth} 层（${curve.widestItems} 个，占 ${(curve.concentration * 100).toFixed(1)}%）。`);
  lines.push(curve.concentration > 0.5
    ? '形状偏「金字塔」—— 绝大多数物品挤在同一层，说明这个包的加工深度很浅。'
    : '形状比较分散 —— 物品分布在多个深度上，加工链有一定层次。');
  return lines;
}
