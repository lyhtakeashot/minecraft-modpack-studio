/**
 * 配方层：把 jar 里的配方 JSON 读成「谁产出什么、谁消耗什么」，并据此建图。
 *
 * 为什么单独一层：物品索引只关心「这个 ID 存不存在」，而规划关心的完全是另一件事
 * ——「删掉这条配方之后，还有没有别的路可以拿到那个物品」。两件事的数据需求不同，
 * 混在一起会让索引变慢（实测索引 10,450 物品只要 400ms，配方全解要再花一倍）。
 *
 * ⚠️ 承接 index.js 的教训：配方目录 1.21.1 是单数 `recipe/`，1.20.1 是复数
 * `recipes/`，正则必须写成 `(?:recipes|recipe)`，否则源会静默失效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from './zip.js';

const RECIPE_FILE_RE = /^data\/([^/]+)\/(?:recipes|recipe)\/(.+)\.json$/;
const ID_RE = /^[a-z0-9_-]+:[a-z0-9_./-]+$/;

/** 只有命名空间和路径都合法才算物品 ID（配方里会混进 `canUse:unknown` 这类垃圾）。 */
function isId(s) {
  return typeof s === 'string' && ID_RE.test(s);
}

/**
 * 从一个「物品表达式」里抽 ID。
 * Minecraft 配方的出入参有十几种形状，这里按优先级抠：
 *   "minecraft:stick"                          → 字符串
 *   {item:"x"} / {id:"x"}                      → 单物品对象
 *   {tag:"minecraft:planks"}                   → 标签（返回 #tag，单独记）
 *   {items:["a","b"]} / [{...},{...}]          → 列举/数组
 *
 * @param {unknown} v
 * @param {(id: string, tag: boolean) => void} take
 */
function eachIngredient(v, take) {
  if (v == null) return;
  if (typeof v === 'string') {
    if (isId(v)) take(v, false);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) eachIngredient(x, take);
    return;
  }
  if (typeof v !== 'object') return;
  const o = v;
  if (typeof o.item === 'string') {
    if (isId(o.item)) take(o.item, false);
    return;
  }
  if (typeof o.id === 'string' && !o.tag) {
    if (isId(o.id)) take(o.id, false);
    return;
  }
  if (typeof o.tag === 'string') {
    // 标签按 "tag:minecraft:planks" 记，和真物品区分开
    take(`tag:${o.tag.replace(/^#/, '')}`, true);
    return;
  }
  if (Array.isArray(o.items)) {
    eachIngredient(o.items, take);
    return;
  }
  if (Array.isArray(o.choices)) {
    eachIngredient(o.choices, take);
    return;
  }
  // {type:"x", ...} 之类的包装：继续往里挖，但别把纯字符串字段都当 ID
  for (const key of ['ingredient', 'ingredients', 'base', 'addition', 'template', 'input', 'output']) {
    if (o[key] !== undefined) eachIngredient(o[key], take);
  }
}

/**
 * 抽产物（result / results[] / output 三种写法）。
 *
 * 第三个参数 chance 是「概率产物」：Create 的结果里可以写 `{"id":"x","chance":0.1}`，
 * 意思是 10% 概率出。概率本身也是一种产物信息，丢了它改配方就会悄悄改掉概率，
 * 所以这里原样带出来。
 */
function eachOutput(v, take) {
  if (v == null) return;
  if (typeof v === 'string') {
    if (isId(v)) take(v, 1, undefined);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) eachOutput(x, take);
    return;
  }
  if (typeof v !== 'object') return;
  const o = v;
  const count = Number.isFinite(o.count) ? o.count : 1;
  const chance = Number.isFinite(o.chance) ? o.chance : undefined;
  if (typeof o.item === 'string') {
    if (isId(o.item)) take(o.item, count, chance);
    return;
  }
  if (typeof o.id === 'string' && !o.tag) {
    if (isId(o.id)) take(o.id, count, chance);
    return;
  }
  if (Array.isArray(o.items)) {
    eachOutput(o.items, take);
    return;
  }
  if (Array.isArray(o.choices)) {
    eachOutput(o.choices, take);
    return;
  }
  if (o.result !== undefined) eachOutput(o.result, take);
  if (o.output !== undefined) eachOutput(o.output, take);
}

/**
 * 把一条配方 JSON 变成 {id, namespace, type, outputs, inputs, tags}。
 *
 * @param {string} fileInJar 形如 `data/create/recipe/pressing/zinc.json`
 * @param {object} json
 * @returns {object|null}
 */
export function parseRecipe(fileInJar, json) {
  const m = RECIPE_FILE_RE.exec(fileInJar);
  if (!m) return null;
  const namespace = m[1];
  const rel = m[2];
  const outputs = [];
  const inputs = [];
  const tags = [];
  eachOutput(json?.result ?? json?.output ?? json?.results, (id, count, chance) => {
    const one = { id, count };
    if (chance !== undefined) one.chance = chance;
    outputs.push(one);
  });
  // 材料和产物经常共用同一个键名（`ingredients` 是材料，`key` 才是图案映射），
  // 所以材料要按「配方类型」分别取，不能无脑挖全部字段。
  const type = typeof json?.type === 'string' ? json.type : 'unknown';
  const takeInput = (id, tag) => (tag ? tags.push(id.slice(4)) : inputs.push(id));
  eachIngredient(json?.ingredients, takeInput);
  eachIngredient(json?.ingredient, takeInput);
  eachIngredient(json?.template, takeInput);
  eachIngredient(json?.base, takeInput);
  eachIngredient(json?.addition, takeInput);
  if (json?.key && typeof json.key === 'object') {
    for (const v of Object.values(json.key)) eachIngredient(v, takeInput);
  }
  // 有些 Create 配方把材料包在 input 里
  eachIngredient(json?.input, takeInput);

  const dedupe = (arr) => [...new Set(arr)];
  return {
    id: `${namespace}:${rel}`,
    namespace,
    type,
    outputs: dedupe(outputs.map((o) => o.id)),
    outputCounts: outputs,
    inputs: dedupe(inputs),
    tags: dedupe(tags),
  };
}

/**
 * 读一个 jar 的全部配方。
 *
 * @param {string} file jar 的绝对路径
 * @returns {{file: string, recipes: object[], error: string}}
 */
export function recipesInJar(file) {
  const out = { file, recipes: [], error: '' };
  let zip;
  try {
    zip = openZip(fs.readFileSync(file));
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }
  for (const name of zip.names) {
    if (!RECIPE_FILE_RE.test(name)) continue;
    let json;
    try {
      json = JSON.parse(zip.text(name));
    } catch {
      continue; // 单个坏文件不该毁掉整个 jar
    }
    const r = parseRecipe(name, json);
    if (r) out.recipes.push(r);
  }
  return out;
}

/**
 * 读整个实例的配方（mods + 原版 jar）。
 *
 * @param {object} instance resolveInstance() 的返回
 * @param {object} [opts]
 * @param {boolean} [opts.includeClientJar]
 * @returns {object}
 */
export function loadRecipes(instance, opts = {}) {
  const started = Date.now();
  const all = [];
  const errors = [];
  let jarCount = 0;

  let files = [];
  try {
    files = fs
      .readdirSync(instance.modsDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.jar'))
      .map((d) => path.join(instance.modsDir, d.name))
      .sort();
  } catch {
    files = [];
  }
  for (const file of files) {
    jarCount++;
    const r = recipesInJar(file);
    if (r.error) errors.push({ file: path.basename(file), error: r.error });
    for (const rec of r.recipes) all.push({ ...rec, jar: path.basename(file) });
  }
  if (opts.includeClientJar !== false && instance.hasClientJar) {
    const r = recipesInJar(instance.clientJar);
    for (const rec of r.recipes) all.push({ ...rec, jar: path.basename(instance.clientJar) });
  }

  return { recipes: all, jarCount, errors, elapsedMs: Date.now() - started };
}

/**
 * 按配方构建图。
 *
 * 两张索引：
 *   producers: 物品 → 能产出它的配方 id 列表
 *   consumers: 物品 → 把它当材料的配方 id 列表
 *
 * @param {object[]} recipes
 */
export function buildGraph(recipes) {
  /** @type {Map<string, string[]>} */
  const producers = new Map();
  /** @type {Map<string, string[]>} */
  const consumers = new Map();
  const byId = new Map();

  const add = (map, key, value) => {
    const list = map.get(key);
    if (list) {
      if (!list.includes(value)) list.push(value);
    } else map.set(key, [value]);
  };

  for (const r of recipes) {
    byId.set(r.id, r);
    for (const item of r.outputs) add(producers, item, r.id);
    for (const item of r.inputs) add(consumers, item, r.id);
  }

  return {
    byId,
    producers,
    consumers,
    producersOf: (item) => (producers.get(item) ?? []).map((id) => byId.get(id)),
    consumersOf: (item) => (consumers.get(item) ?? []).map((id) => byId.get(id)),
  };
}

/**
 * 断路检测：假设删掉某些配方，哪些物品会彻底失去获取途径。
 *
 * 分两档报，因为「拿不到」和「拿不到但还有人要」是两件严重程度不同的事：
 *   broken    所有失去获取途径的物品
 *   critical  其中**还被别的存活配方当材料**的那些 —— 这些才是真的断路，
 *             合成链会在这里断掉。没人用的那些多半是废弃物品，可以不补。
 *
 * 不追踪合成链深度，因为对整合包作者来说「还有别的办法拿到」就够判断了；
 * 真要追链是 `pathsTo()` 的事。
 *
 * @param {object} graph buildGraph() 的返回
 * @param {string[]} removedRecipeIds 会被删掉的配方
 * @param {object} [opts]
 * @param {number} [opts.limit] 最多返回多少条，默认 200
 * @returns {{broken: object[], critical: object[], removedCount: number, checkedItems: number}}
 */
export function findBreaks(graph, removedRecipeIds, opts = {}) {
  const removed = new Set(removedRecipeIds);
  const limit = opts.limit ?? 200;
  const broken = [];
  let checked = 0;

  for (const [item, recipeIds] of graph.producers) {
    const alive = recipeIds.filter((id) => !removed.has(id));
    if (alive.length > 0) continue;
    checked++;
    // 还有多少条「活着」的配方要它当材料 —— 0 说明断了也没人受影响
    const usedBy = (graph.consumers.get(item) ?? []).filter((id) => !removed.has(id));
    broken.push({ item, lostRecipes: recipeIds, usedBy: usedBy.length, usedByRecipes: usedBy });
  }
  // 先排完再截断 —— 否则 limit 会把「被最多配方需要」的那些挡在外面（实测就是这样漏掉了 andesite_alloy）
  broken.sort((a, b) => b.usedBy - a.usedBy || b.lostRecipes.length - a.lostRecipes.length);
  const critical = broken.filter((b) => b.usedBy > 0);
  return {
    broken: broken.slice(0, limit),
    critical: critical.slice(0, limit),
    removedCount: removed.size,
    checkedItems: checked,
  };
}

/**
 * 找一个物品的「怎么来的」完整链条（广度优先，限制深度防爆）。
 *
 * @param {object} graph
 * @param {string} item
 * @param {object} [opts]
 * @param {number} [opts.depth] 最大深度，默认 4
 * @param {number} [opts.maxNodes] 最多展开多少个节点，默认 300
 * @returns {{item: string, levels: object[][], truncated: boolean}}
 */
export function pathsTo(graph, item, opts = {}) {
  const depth = Math.max(1, Math.min(opts.depth ?? 4, 8));
  const maxNodes = Math.max(10, Math.min(opts.maxNodes ?? 300, 2000));
  const levels = [];
  let frontier = [item];
  const seen = new Set([item]);
  let nodes = 0;
  let truncated = false;

  for (let d = 0; d < depth && frontier.length; d += 1) {
    const row = [];
    const next = [];
    for (const want of frontier) {
      for (const recipe of graph.producersOf(want)) {
        if (nodes >= maxNodes) { truncated = true; break; }
        nodes++;
        row.push({
          item: want,
          recipe: recipe.id,
          type: recipe.type,
          from: recipe.inputs.slice(0, 12),
          jar: recipe.jar,
        });
        for (const input of recipe.inputs) {
          if (!seen.has(input)) {
            seen.add(input);
            next.push(input);
          }
        }
      }
      if (truncated) break;
    }
    if (row.length) levels.push(row);
    if (truncated) break;
    frontier = next;
  }
  return { item, levels, truncated };
}

/**
 * 找「谁在用它」—— 常用于判断一个物品能不能安全删。
 *
 * @param {object} graph
 * @param {string} item
 * @returns {{item: string, recipes: object[], count: number}}
 */
export function usesOf(graph, item) {
  const recipes = graph.consumersOf(item).map((r) => ({
    id: r.id,
    type: r.type,
    outputs: r.outputs.slice(0, 4),
    jar: r.jar,
  }));
  return { item, recipes, count: recipes.length };
}

// ————————————————————————— 改配方要用的两件事 —————————————————————————

/**
 * 读一条配方在 jar 里的原始 JSON。
 *
 * 为什么要回头再读一遍：parseRecipe 只抽了「谁产出什么、谁消耗什么」，
 * 而「改配方」需要的是图案（pattern）、图案字符到物品的映射（key）、
 * 每个材料的原样写法 —— 这些在归一化成物品 ID 之后就丢了。
 *
 * 找法是「打开它所在的 jar，逐条比对配方 ID」，而不是拼路径。因为同一命名空间下
 * 单数 `recipe/` 和复数 `recipes/` 可能同时存在，拼路径早晚会拼错。
 *
 * @param {object} instance resolveInstance() 的返回
 * @param {{id: string, jar?: string}} recipe
 * @returns {{json: object|null, entry: string, error: string}}
 */
export function recipeJson(instance, recipe) {
  const out = { json: null, entry: '', error: '' };
  const id = recipe?.id;
  if (!id) {
    out.error = '没给配方 ID';
    return out;
  }

  let file = '';
  try {
    if (recipe.jar && instance.clientJar && recipe.jar === path.basename(instance.clientJar)) {
      file = instance.clientJar;
    } else {
      file = path.join(instance.modsDir, recipe.jar ?? '');
    }
  } catch {
    file = '';
  }
  if (!file || !fs.existsSync(file)) {
    out.error = `找不到配方所在的 jar：${recipe.jar || '未知'}`;
    return out;
  }

  let zip;
  try {
    zip = openZip(fs.readFileSync(file));
  } catch (e) {
    out.error = `打不开 ${path.basename(file)}：${e instanceof Error ? e.message : String(e)}`;
    return out;
  }

  const want = String(id);
  for (const name of zip.names) {
    const m = RECIPE_FILE_RE.exec(name);
    if (!m || `${m[1]}:${m[2]}` !== want) continue;
    try {
      out.json = JSON.parse(zip.text(name));
      out.entry = name;
    } catch (e) {
      out.error = `配方 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`;
    }
    return out;
  }
  out.error = `${path.basename(file)} 里找不到配方 ${want}`;
  return out;
}

/**
 * 配方类型 → 我们这边认的类别。
 *
 * 只认三种：有序合成、无序合成、Create 机器配方。别的一律 unsupported，
 * 界面上会明说「改不了」，而不是假装能改然后写出一段游戏里不生效的代码。
 *
 * @param {string} type 例如 'minecraft:crafting_shaped' / 'create:pressing'
 * @returns {'shaped'|'shapeless'|'machine'|'unsupported'}
 */
export function recipeKindOf(type) {
  const t = String(type ?? '');
  if (t === 'minecraft:crafting_shaped') return 'shaped';
  if (t === 'minecraft:crafting_shapeless') return 'shapeless';
  if (/^create:[a-z0-9_]+$/.test(t)) return 'machine';
  return 'unsupported';
}

/**
 * 把一条配方的原始 JSON 整理成「界面能填的表单」。
 *
 * 只认三种能安全重写的配方：有序合成、无序合成、Create 机器配方。
 * 其余（熔炉、切石机、村民交易式配方……）一律标成不可改并说明原因 ——
 * 假装能改、写完在游戏里失效，比明说改不了糟糕得多。
 *
 * 「用了标签」的配方（比如任意木板都行）也标成不可改：标签没法拆成一个具体物品，
 * 硬拆会悄悄改变玩法。
 *
 * @param {object} recipe parseRecipe 的产物（带 jar 字段）
 * @param {object} json 原始配方 JSON
 * @returns {object} 表单数据 + editable/reason
 */
export function describeRecipe(recipe, json) {
  const type = typeof json?.type === 'string' ? json.type : String(recipe?.type ?? 'unknown');
  const kind = recipeKindOf(type);

  const out = {
    id: recipe?.id ?? '',
    type,
    kind,
    machineKind: kind === 'machine' ? type.slice('create:'.length) : '',
    jar: recipe?.jar ?? '',
    /** 产物物品 ID（只有一种产物才有值） */
    output: '',
    /** 一次产出几个 */
    count: 1,
    /** 全部产物（[{id, count, chance?}]）：多产物时用它 */
    outputs: [],
    /** 是不是多产物（多产物走「照抄原 JSON 只改产物」的改写路径） */
    multi: false,
    /** 有序合成的图案，如 ['AA','AA'] */
    pattern: [],
    /** 图案字符 → 物品 ID，如 {A:'minecraft:stone'} */
    keys: {},
    /** 材料列表（无序合成 / 机器配方直接用它；有序合成只读展示） */
    inputs: [],
    /** 用到的标签（只读展示） */
    tags: [...(recipe?.tags ?? [])],
    /** 能不能在界面上改 */
    editable: false,
    /** 不能改时的原因（人话） */
    reason: '',
  };

  let blocker = '';

  // 产物：单一产物走原来的重写路径；多产物走「照抄原 JSON 只改产物」的改写路径。
  const outputs = (recipe?.outputCounts ?? []).filter((o) => o && o.id);
  out.outputs = outputs.map((o) => {
    const one = { id: o.id, count: Number.isFinite(o.count) && o.count > 0 ? o.count : 1 };
    if (Number.isFinite(o.chance)) one.chance = o.chance;
    return one;
  });
  if (outputs.length === 1) {
    out.output = outputs[0].id;
    out.count = Number.isFinite(outputs[0].count) && outputs[0].count > 0 ? outputs[0].count : 1;
  } else if (outputs.length > 1) {
    out.multi = true;
  } else {
    blocker = '这条配方没读到产物（可能是特殊类型的配方）';
  }

  if (kind === 'shaped') {
    const pattern = Array.isArray(json?.pattern) ? json.pattern.map((s) => String(s)) : [];
    const keyRaw = json?.key && typeof json.key === 'object' ? json.key : {};
    const keys = {};
    for (const [ch, value] of Object.entries(keyRaw)) {
      const material = materialOf(value);
      if (!material) { blocker = blocker || `图案字符 ${ch} 的材料看不懂`; continue; }
      if (material.multi) { blocker = blocker || `图案字符 ${ch} 列了多种可选物品，界面改不了`; continue; }
      if (material.tag) {
        blocker = blocker || `图案字符 ${ch} 用的是标签 ${material.id}（这类物品任意一个都行），界面改不了`;
        continue;
      }
      keys[ch] = material.id;
    }
    out.pattern = pattern;
    out.keys = keys;
    if (!blocker) {
      if (pattern.length < 1 || pattern.length > 3) blocker = '图案行数不是 1~3 行，界面改不了';
      else if (Object.keys(keys).length === 0) blocker = '图案没读到字符映射，界面改不了';
      // 材料列表只给界面看，改的时候按图案 + 字符映射走
      out.inputs = [...new Set(Object.values(keys))];
    }
  } else if (kind === 'shapeless') {
    const list = Array.isArray(json?.ingredients) ? json.ingredients : [];
    const inputs = [];
    for (const value of list) {
      const material = materialOf(value);
      if (!material) { blocker = blocker || '有个材料看不懂'; continue; }
      if (material.multi) { blocker = blocker || '有个材料列了多种可选物品，界面改不了'; continue; }
      if (material.tag) {
        blocker = blocker || `有个材料是标签 ${material.id}（这类物品任意一个都行），界面改不了`;
        continue;
      }
      inputs.push(material.id);
    }
    out.inputs = inputs;
    if (!blocker && inputs.length === 0) blocker = '没读到材料，界面改不了';
  } else if (kind === 'machine') {
    // Create 配方的材料字段名五花八门（ingredients / base / addition / template），
    // 直接用 parseRecipe 已经抽好的结果，别再猜一遍。
    out.inputs = [...(recipe?.inputs ?? [])];
    if (out.tags.length) {
      blocker = blocker || `材料里有标签（${out.tags.slice(0, 3).join('、')}），界面改不了`;
    }
    if (!blocker && out.inputs.length === 0) blocker = '这条机器配方没读到材料，界面改不了';
  } else {
    blocker = blocker || `这种配方类型（${type}）界面上暂时改不了，只能在代码里改`;
  }

  // 多产物时 out.output 是空的，但照样能改（走 JSON 改写路径）。
  //
  // 而且多产物**不挑配方类型**：改写路径是照抄原 JSON 只换产物那一个键，
  // 所以熔炉、切石机、别的 mod 的机器配方都能改 —— 材料不动，只改产物。
  // 因此上面那些「类型不支持」「材料是标签」的拦阻对多产物统统不适用。
  if (out.multi) {
    blocker = '';
    out.inputs = [...(recipe?.inputs ?? [])];
    out.pattern = [];
    out.keys = {};
  }
  out.editable = !blocker && (out.multi ? out.outputs.length > 0 : Boolean(out.output));
  out.reason = out.editable ? '' : blocker || '界面暂时改不了这条配方';
  return out;
}

/**
 * 把配方里的一个「材料写法」还原成 {id, tag, multi}。
 * multi 表示这里列了多个可选物品 —— 界面上表达不了，必须拦下来。
 *
 * @param {unknown} v
 * @returns {{id: string, tag: boolean, multi: boolean}|null}
 */
function materialOf(v) {
  if (v == null) return null;
  if (typeof v === 'string') return isId(v) ? { id: v, tag: false, multi: false } : null;
  if (Array.isArray(v)) {
    if (v.length === 1) return materialOf(v[0]);
    return v.length ? { id: '', tag: false, multi: true } : null;
  }
  if (typeof v !== 'object') return null;
  const o = v;
  if (typeof o.tag === 'string') return { id: `#${o.tag.replace(/^#/, '')}`, tag: true, multi: false };
  if (typeof o.item === 'string') return isId(o.item) ? { id: o.item, tag: false, multi: false } : null;
  if (typeof o.id === 'string') return isId(o.id) ? { id: o.id, tag: false, multi: false } : null;
  if (Array.isArray(o.items)) {
    if (o.items.length === 1) return materialOf(o.items[0]);
    return o.items.length ? { id: '', tag: false, multi: true } : null;
  }
  return null;
}
