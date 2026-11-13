/**
 * 界面接口的两份缓存：物品索引 和 配方图。
 *
 * 为什么单独一个模块：这两个东西都挺贵（索引 0.5 秒、配方图 2 秒上下），
 * 而「物品搜索」和「改配方」是两个模块都要用。放在这里一份，别各建一份 ——
 * 一份千 mod 的索引在内存里是几十兆级别，复制两份是纯浪费。
 *
 * 过期策略：10 分钟。界面可以带 refresh=1 强制重算。
 */
import { indexInstance } from '../../packages/core/index.js';
import { loadRecipes, buildGraph } from '../../packages/core/recipes.js';
import { applyCompletion } from './name-completion.js';

const TTL_MS = 10 * 60 * 1000;

const indexCache = new Map();
const graphCache = new Map();

/** 缓存键统一用实例目录的小写形式（Windows 上路径不分大小写）。 */
function keyOf(instance) {
  return instance.instanceDir.toLowerCase();
}

/**
 * 拿物品索引（带缓存）。
 *
 * @param {object} instance
 * @param {boolean} [refresh] true 时忽略缓存重算
 * @returns {object} indexInstance() 的返回
 */
export function cachedIndex(instance, refresh) {
  const key = keyOf(instance);
  const hit = indexCache.get(key);
  // 命中缓存也要套一遍补全表：用户点「补全中文名」之后不必等 10 分钟 TTL，
  // 也不必清掉整份索引重扫。applyCompletion 自己按版本号去重，重复调很便宜。
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return applyCompletion(hit.idx);
  const idx = applyCompletion(indexInstance(instance, { includeClientJar: true }));
  indexCache.set(key, { at: Date.now(), idx });
  return idx;
}

/**
 * 拿配方图（带缓存）。
 *
 * 返回的不只是 graph，还带着 recipes 原数组 —— 因为「改配方」要按 ID 反查
 * 原始 JSON，而 graph.byId 里存的已经是归一化后的对象了（有 jar 名，够用）。
 *
 * @param {object} instance
 * @param {boolean} [refresh]
 * @returns {{graph: object, recipes: object[], jarCount: number, elapsedMs: number}}
 */
export function cachedGraph(instance, refresh) {
  const key = keyOf(instance);
  const hit = graphCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.entry;
  const loaded = loadRecipes(instance, { includeClientJar: true });
  const entry = {
    graph: buildGraph(loaded.recipes),
    recipes: loaded.recipes,
    jarCount: loaded.jarCount,
    errors: loaded.errors,
    elapsedMs: loaded.elapsedMs,
  };
  graphCache.set(key, { at: Date.now(), entry });
  return entry;
}

/** 测试用：清空所有缓存。 */
export function resetCaches() {
  indexCache.clear();
  graphCache.clear();
}

/** 测试用：看缓存里现在有几项。 */
export function cacheSizes() {
  return { index: indexCache.size, graph: graphCache.size };
}