/**
 * 「分析类」接口：只读，帮整合包作者看清这个包内部的情况。
 *
 * 这批能力以前只以模型工具的形态存在。现在搬进桌面版：core 里的函数一个没改，
 * 只是给它们各配一条宿主路由 + 界面上的一个工具页。
 *
 * 六条：
 *   /analysis/overlap      mod 撞车：同名物品 + 功能族分布
 *   /analysis/progress     进度深度曲线：加工链是陡还是平
 *   /analysis/mod          拆开一个 mod 看里面有什么
 *   /analysis/recipe-path   这个物品怎么来的（往上追）
 *   /analysis/recipe-uses   谁在用它（往下查）
 *   /analysis/kubejs       KubeJS 脚本体检：跑不跑得通、引用的东西在不在
 *
 * 全部只读：一个文件都不写。
 */
import path from 'node:path';
import { McError } from '../../packages/core/errors.js';
import { resolveInstance } from '../../packages/core/instance.js';
import { describeOverlap, describeProgress, familyCoverage, progressCurve, sameNameCollisions } from '../../packages/core/overlap.js';
import { findModJar, inspectJar, modConfigFiles, readTextFile } from '../../packages/core/mod-inspect.js';
import { pathsTo, usesOf } from '../../packages/core/recipes.js';
import { describeVerify, verifyScripts } from '../../packages/core/kubejs.js';
import { cachedGraph, cachedIndex } from './cache.js';
import { readParams } from './params.js';

/** 解析实例；界面传的是 dir（+ 可选 id）。 */
function instanceOf(params) {
  const dir = String(params.dir ?? '').trim();
  if (!dir) throw new McError('缺少实例目录', '在界面顶部先连一个整合包', 'McBadArgs');
  return resolveInstance(dir, String(params.id ?? ''));
}

/** 数字参数：夹在区间里，非法就退回默认。 */
function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.round(n), max));
}

/** 只要一个物品 ID。 */
function itemOf(params) {
  const item = String(params.item ?? '').trim();
  if (!item) {
    throw new McError('没给物品 ID', '先在上面搜一个物品，选中之后再看它的来路和去向', 'McBadArgs');
  }
  return item;
}

// --------------------------------------------------------------- mod 撞车

/**
 * GET /analysis/overlap —— 哪些 mod 在做同一件事。
 *
 * 两套启发式：同名物品（高置信）和功能族（中低置信）。
 * 返回里同时给结构化数据和「人能读的清单」，界面两种都用得上。
 */
export async function handleOverlapAnalysis(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const minNamespaces = num(params.minNamespaces, 2, 2, 10);
  const minItems = num(params.minItems, 5, 1, 500);
  const limit = num(params.limit, 20, 1, 200);

  const idx = cachedIndex(instance, params.refresh === '1');
  const collisions = sameNameCollisions(idx._items, minNamespaces);
  const families = familyCoverage(idx._items, minItems);
  const crowded = families.filter((f) => f.crowded);
  const empty = families.filter((f) => f.modCount === 0);

  return {
    collisionCount: collisions.length,
    collisions: collisions.slice(0, limit).map((c) => ({
      path: c.path,
      namespaces: c.namespaces,
      ids: c.ids,
      count: c.count,
    })),
    families: families.map((f) => ({
      family: f.family,
      modCount: f.modCount,
      itemTotal: f.itemTotal,
      crowded: f.crowded,
      mods: f.mods.slice(0, 12),
    })),
    crowdedFamilies: crowded.map((f) => f.family),
    emptyFamilies: empty.map((f) => f.family),
    lines: describeOverlap(collisions, families, limit),
  };
}

// --------------------------------------------------------------- 进度曲线

/**
 * GET /analysis/progress —— 按合成链深度给物品分层，看进度形状。
 */
export async function handleProgressAnalysis(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const maxDepth = num(params.maxDepth, 6, 1, 12);
  const cache = cachedGraph(instance, params.refresh === '1');
  const curve = progressCurve(cache.graph, { maxDepth });
  return {
    ...curve,
    recipeCount: cache.recipes.length,
    elapsedMs: cache.elapsedMs,
    lines: describeProgress(curve),
  };
}

// --------------------------------------------------------------- 拆 mod

/** 能看哪几块。 */
const MOD_VIEWS = ['summary', 'items', 'recipes', 'tags', 'loot', 'config'];

/**
 * GET /analysis/mod —— 把一个 mod 的 jar 拆开看。
 *
 * view=summary 给概览；其余逐项展开。config 要读实例的 config 目录
 * （配置不在 jar 里，是启动时生成的）。
 */
export async function handleModAnalysis(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const key = String(params.modId ?? params.key ?? '').trim();
  if (!key) {
    throw new McError('没给 mod', '先在 mod 列表里选一个，或者直接填 modId', 'McBadArgs');
  }
  const view = String(params.view ?? 'summary').trim();
  if (!MOD_VIEWS.includes(view)) {
    throw new McError(`看不懂 ${view}`, `能看的有：${MOD_VIEWS.join('、')}`, 'McBadArgs');
  }
  const limit = num(params.limit, 60, 1, 300);
  const filter = String(params.item ?? '').trim().toLowerCase();

  const jarPath = findModJar(instance, key);
  const mod = inspectJar(jarPath);
  const configs = modConfigFiles(instance, mod.modId ?? key);

  const out = {
    jarFile: mod.jarFile,
    modId: mod.modId,
    name: mod.name,
    version: mod.version,
    counts: { ...mod.counts, configs: configs.length },
    view,
  };

  if (view === 'items') {
    const items = mod.items.filter((it) => !filter || it.id.toLowerCase().includes(filter));
    out.items = items.slice(0, limit);
    out.itemTotal = items.length;
  } else if (view === 'recipes') {
    const recipes = mod.recipes.filter((r) => !filter || r.file.toLowerCase().includes(filter));
    out.recipes = recipes.slice(0, limit);
    out.recipeTotal = recipes.length;
    out.recipeTypes = mod.recipeTypes;
  } else if (view === 'tags') {
    out.tags = mod.tags.slice(0, limit);
    out.tagTotal = mod.tags.length;
  } else if (view === 'loot') {
    out.loot = mod.loot.slice(0, limit);
    out.lootTotal = mod.loot.length;
  } else if (view === 'config') {
    out.configs = configs.slice(0, limit).map((c) => {
      const read = readTextFile(c.abs, 2500);
      return { file: c.file, size: c.size, own: c.own, text: read.text, truncated: read.truncated };
    });
    out.configTotal = configs.length;
  } else {
    // summary：概览 + 配方类型分布 + 配置文件列表
    out.recipeTypes = mod.recipeTypes;
    out.recipeSkipped = mod.recipeSkipped;
    out.configs = configs.slice(0, 20).map((c) => ({ file: c.file, size: c.size, own: c.own }));
    out.configTotal = configs.length;
    out.notes = [
      '想看细节可以切：items（物品）/ recipes（配方）/ tags（标签）/ loot（掉落）/ config（配置）',
      `这个 mod 一共有 ${mod.counts.items} 个物品、${mod.counts.recipes} 条配方。`,
      configs.length
        ? `配置文件在实例的 config 目录里，一共 ${configs.length} 个（own=true 的是它自己的）。`
        : '没找到属于它的配置文件（config 是启动时生成的，装上并启动过一次才会有）。',
    ];
  }
  return out;
}

// --------------------------------------------------------------- 配方追溯

/**
 * GET /analysis/recipe-path —— 这个物品是怎么来的（往上追几层）。
 */
export async function handleRecipePathAnalysis(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const item = itemOf(params);
  const depth = num(params.depth, 4, 1, 8);
  const cache = cachedGraph(instance, params.refresh === '1');
  const result = pathsTo(cache.graph, item, { depth });
  return {
    item: result.item,
    depth,
    truncated: result.truncated,
    levelCount: result.levels.length,
    levels: result.levels.map((row) => row.map((r) => ({
      item: r.item,
      recipe: r.recipe,
      type: r.type,
      from: r.from,
      jar: r.jar,
    }))),
  };
}

/**
 * GET /analysis/recipe-uses —— 谁在用它（往下查）。
 */
export async function handleRecipeUsesAnalysis(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const item = itemOf(params);
  const limit = num(params.limit, 40, 1, 200);
  const cache = cachedGraph(instance, params.refresh === '1');
  const result = usesOf(cache.graph, item);
  const byType = new Map();
  for (const r of result.recipes) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  return {
    item: result.item,
    count: result.count,
    byType: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    recipes: result.recipes.slice(0, limit),
  };
}

// --------------------------------------------------------------- 脚本体检

/**
 * GET /analysis/kubejs —— KubeJS 脚本体检。
 *
 * 跑一遍所有脚本：语法对不对、运行时报不报错、引用���物品/配方在不在这个包里。
 * 只读 —— 脚本本身不会被改。
 */
export async function handleKubejsAnalysis(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const limit = num(params.limit, 15, 1, 100);
  const kubejsDir = path.join(instance.instanceDir, 'kubejs');

  const idx = cachedIndex(instance, params.refresh === '1');
  const cache = cachedGraph(instance, params.refresh === '1');
  const report = verifyScripts(kubejsDir, {
    knownItems: new Set(idx._items.keys()),
    knownRecipes: new Set(cache.graph.byId.keys()),
    mcVersion: instance.mcVersion,
  });

  return {
    ok: report.ok,
    kubejsDir,
    scriptCount: report.scriptCount,
    breakdown: report.breakdown,
    declared: report.declared,
    missingItems: report.missingItems.slice(0, limit),
    missingRecipes: report.missingRecipes.slice(0, limit),
    byModule: report.byModule,
    scripts: report.scripts.slice(0, limit).map((s) => ({
      file: s.file,
      stage: s.stage,
      status: s.status,
      error: s.error ?? '',
      line: s.line ?? 0,
      recipes: (s.recipes ?? []).length,
      removals: (s.removals ?? []).length,
      missingItems: (s.missingItems ?? []).length,
      missingRecipes: (s.missingRecipes ?? []).length,
    })),
    elapsedMs: report.elapsedMs,
    lines: describeVerify(report, limit),
  };
}
