/**
 * 「改配方」的宿主侧接口。
 *
 * 一条配方的原文件在 mod 的 jar 里，那个不能改（改了校验和就不对了，也没法随包更新）。
 * 所以「改配方」在 KubeJS 里是标准做法：**先用 event.remove 删掉原配方，再重新声明一条**。
 * 生成的两行代码就是这个意思，顺序不能反。
 *
 * 三个接口的分工：
 *   /recipes          搜到一个物品后，看「哪些配方能做它」「哪些配方在用它」
 *   /recipe           看某一条配方的细节，并整理成可编辑的表单
 *   /recipe/preview   按你改的内容生成脚本并检查一遍，**不写盘**
 *   /recipe/apply     真写进去（写前自动备份，写完复验，不过就回滚）
 *
 * 这里只返回普通对象，包装成 HTTP 响应是 lib/host/api.js 的事 ——
 * 这样单测可以直接调这些函数，不用造 Request。
 */
import fs from 'node:fs';
import path from 'node:path';
import { McError } from '../../packages/core/errors.js';
import { resolveInstance } from '../../packages/core/instance.js';
import { describeRecipe, findBreaks, recipeJson, recipeKindOf } from '../../packages/core/recipes.js';
import { generateScript, targetFile } from '../../packages/core/kubejs-write.js';
import { buildRecipeJsonRewrite, recipeJsonTargetPath } from '../../packages/core/recipe-json-write.js';
import { runScript, verifyScripts } from '../../packages/core/kubejs.js';
import { checkWritable, restoreFiles, writeFiles } from '../../packages/core/write.js';
import { cachedGraph, cachedIndex } from './cache.js';

/** 最多允许改出多少个产物：防止手滑打成 9999 把经济系统搞崩。 */
const MAX_COUNT = 64;
/** 一条配方最多几个材料（原版合成台 3x3 也就 9 个）。 */
const MAX_INPUTS = 16;
/** 一条配方最多几种产物。 */
const MAX_OUTPUTS = 12;

// ————————————————————————— 参数整理 —————————————————————————

/**
 * 把 query 参数和（POST 时的）JSON body 合到一起。
 *
 * 为什么两边都收：预览走 GET（好调试、能直接在浏览器里试），真写盘走 POST。
 * 用同一套参数结构，省得两边字段名慢慢长歪。
 *
 * 导出同样是给 recipe-view-api.js 用的（和 params.js 里那份行为一致，
 * 但那个接口要的是「和改配方完全同一套参数」）。
 */
export async function readParams(request) {
  const out = {};
  const url = new URL(request.url);
  for (const [k, v] of url.searchParams) out[k] = v;
  if (request.method && request.method.toUpperCase() === 'POST') {
    try {
      const text = await request.text();
      if (text && text.trim()) {
        const body = JSON.parse(text);
        if (body && typeof body === 'object') Object.assign(out, body);
      }
    } catch {
      /* body 读不出来就只用 query 参数，不该因此整个请求失败 */
    }
  }
  return out;
}

/** 必填的实例目录参数。导出给 recipe-view-api.js 复用，别在那边再抄一份。 */
export function needDir(params) {
  const dir = String(params.dir ?? '').trim();
  if (!dir) {
    throw new McError(
      '缺少实例目录',
      '在界面顶部先连一个整合包',
      'McBadArgs',
    );
  }
  return dir;
}

/** 把「数组」这种参数统一成字符串数组。body 里可能是真数组，query 里是 JSON 串或逗号分隔。 */
function asList(value, fallback) {
  const clean = (list) => list.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (Array.isArray(value)) return clean(value);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return clean(parsed);
    } catch {
      /* 不是 JSON 就按逗号分隔处理 */
    }
    return clean(value.split(','));
  }
  return clean(fallback ?? []);
}

/** 把「图案字符 → 物品」这种参数统一成对象。 */
function asKeys(value, fallback) {
  const base = { ...(fallback ?? {}) };
  let source = value;
  if (typeof value === 'string' && value.trim()) {
    try {
      source = JSON.parse(value);
    } catch {
      source = null;
    }
  }
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [k, v] of Object.entries(source)) {
      const ch = String(k).trim();
      const id = String(v ?? '').trim();
      if (ch && id) base[ch] = id;
    }
  }
  return base;
}

/** 产物数量：夹在 1~64 之间，非法值退回原值。 */
function asCount(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), MAX_COUNT));
}

/**
 * 新配方的 ID。
 *
 * 用原配方 ID 派生（而不是随机），这样反复改同一条配方永远是同一个 ID、
 * 同一条脚本条目，不会越改越多条互相打架的记录。
 */
function newRecipeId(originalId) {
  const safe = String(originalId)
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return `kubejs:edit_${safe}`.slice(0, 120);
}

// ————————————————————————— 内部工具 —————————————————————————

/**
 * 一条配方的简报，用于列表。
 *
 * 这里**故意不给「能不能改」**：判断能不能改必须打开 jar 读原始 JSON
 * （要看材料是不是标签、产物是不是多个），列表里几十条全读一遍太慢。
 * 所以列表只报类型，点进去才给结论 —— 宁可让用户多点一下，
 * 也不能在列表里写「可改」然后点开告诉他改不了。
 */
function brief(recipe) {
  const kind = recipeKindOf(recipe.type);
  return {
    id: recipe.id,
    type: recipe.type,
    kind,
    outputs: (recipe.outputCounts ?? []).slice(0, 3).map((o) => ({ id: o.id, count: o.count ?? 1 })),
    inputs: (recipe.inputs ?? []).slice(0, 12),
    tags: (recipe.tags ?? []).slice(0, 4),
    jar: recipe.jar ?? '',
  };
}

/**
 * 定位一条配方：拿实例、拿图、拿原始 JSON、整理成表单。
 *
 * 导出是给 `lib/host/recipe-view-api.js` 用的：那个接口要画「JEI 那样的合成表」，
 * 但定位配方的这条链路（找实例 → 读图 → 读 jar 里的原始 JSON → 整理成表单）
 * 一模一样。复制一份过去早晚会两边长歪，所以这里加 export 给它用。
 *
 * @param {object} params
 * @returns {{instance: object, recipe: object, rawJson: object, rawEntry: string, desc: object, cache: object}}
 */
export function locate(params) {
  const dir = needDir(params);
  const recipeId = String(params.recipeId ?? '').trim();
  if (!recipeId) {
    throw new McError('缺少配方 ID', '先从物品的配方列表里点一条', 'McBadArgs');
  }
  const instance = resolveInstance(dir, String(params.id ?? '').trim());
  const cache = cachedGraph(instance, String(params.refresh ?? '') === '1');
  const recipe = cache.graph.byId.get(recipeId);
  if (!recipe) {
    throw new McError(`找不到配方 ${recipeId}`, '可能 ID 抄错了，或者这个包里没有这条配方', 'RecipeNotFound');
  }
  const raw = recipeJson(instance, recipe);
  if (!raw.json) {
    throw new McError(raw.error || '读不出这条配方的原始内容', '这条配方改不了，只能在代码里手写', 'RecipeJsonMissing');
  }
  const desc = describeRecipe(recipe, raw.json);
  // rawEntry 是这条配方在 jar 里的路径（例如 data/create/recipe/milling/pink_tulip.json），
  // 多产物改写时要按它算出「同名覆盖文件」写到哪儿去。
  return { instance, recipe, rawJson: raw.json, rawEntry: raw.entry, desc, cache };
}

/**
 * 把界面传来的「产物清单」整理成 [{id, count, chance?}]。
 *
 * @param {unknown} value 界面传来的值（数组或 JSON 串）
 * @param {Array<{id: string, count: number, chance?: number}>} fallback 原来的产物
 * @returns {Array<{id: string, count: number, chance?: number}>}
 */
function asOutputs(value, fallback) {
  let list = fallback;
  if (typeof value === 'string' && value.trim()) {
    try {
      list = JSON.parse(value);
    } catch {
      list = fallback;
    }
  } else if (Array.isArray(value)) {
    list = value;
  }
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item) continue;
    const id = String(item.id ?? '').trim();
    if (!id) continue;
    const count = Math.max(1, Math.min(Number(item.count) || 1, MAX_COUNT));
    const one = { id, count };
    const chance = Number(item.chance);
    if (Number.isFinite(chance) && chance > 0 && chance < 1) one.chance = chance;
    out.push(one);
  }
  return out.slice(0, MAX_OUTPUTS);
}

/**
 * 收集一条配方的改动「部件」：要删的配方、要加的新配方、多产物 JSON 改写。
 *
 * 把这一段从 buildRecipePlan 里抽出来，是为了让**单条**和**批量**共用同一套
 * 校验规则（能不能改、图案/材料怎么回填、上限多少）—— 不然两边迟早长歪。
 * 这里只算部件，不生成代码文件、不算影响面，那些由调用方按自己的形状组装。
 *
 * @param {object} params
 * @returns {object}
 */
function collectRecipeParts(params) {
  const { instance, recipe, desc, cache, rawJson, rawEntry } = locate(params);
  const action = String(params.action ?? 'edit').toLowerCase() === 'remove' ? 'remove' : 'edit';
  const warnings = [];

  // 删除原配方这一步两种动作都要做：改 = 删旧 + 加新，删 = 只删
  const remove = [{ id: recipe.id }];
  const recipes = [];

  // 多产物走「照抄原 JSON 只改产物」的改写路径（写 kubejs/data 里的数据包文件），
  // 不用 KubeJS 的事件 API —— 那边既装不下多种产物，很多 mod 也没装 KubeJS 集成。
  const multi = desc.multi === true;
  const outputs = multi ? asOutputs(params.outputs, desc.outputs) : [];

  if (action === 'edit' && !multi) {
    if (!desc.editable) {
      throw new McError(desc.reason, '这条配方暂时只能用代码改', 'RecipeNotEditable');
    }
    // 单条用绝对 count；批量「产出 ±N」用 delta 增量。两者都夹在 1~64，
    // 且单条永远不传 delta，所以老路径算出来的 count 一个字节都没变。
    let countValue = params.count;
    if (params.delta !== undefined && params.delta !== null && params.delta !== '') {
      const d = Number(params.delta);
      if (Number.isFinite(d)) countValue = desc.count + d;
    }
    const count = asCount(countValue, desc.count);
    const id = newRecipeId(recipe.id);
    if (desc.kind === 'shaped') {
      const pattern = asList(params.pattern, desc.pattern);
      const keys = asKeys(params.keys, desc.keys);
      if (!pattern.length) {
        throw new McError('图案不能为空', '有序合成至少要有 1 行图案', 'BadPattern');
      }
      recipes.push({ id, kind: 'shaped', output: desc.output, count, pattern, keys });
    } else {
      const inputs = asList(params.inputs, desc.inputs).slice(0, MAX_INPUTS);
      if (!inputs.length) {
        throw new McError('材料不能为空', '至少要留一个材料', 'BadRecipe');
      }
      recipes.push({
        id,
        kind: desc.kind === 'machine' ? desc.machineKind : 'shapeless',
        output: desc.output,
        count,
        inputs,
      });
    }
    if (count !== desc.count) {
      warnings.push(`产物数量从 ${desc.count} 改成了 ${count}`);
    }
  }

  // ——— 多产物：算一份改写后的 JSON，落到 kubejs/data 里的同名文件 ———
  let jsonRewrite = null;
  if (action === 'edit' && multi) {
    if (!outputs.length) {
      throw new McError('至少要留一个产物', '把产物列表删空了就等于没有配方了', 'BadRecipe');
    }
    jsonRewrite = buildRecipeJsonRewrite({ rawJson, entry: rawEntry, outputs });
    warnings.push(...jsonRewrite.warnings);
  }

  return { instance, recipe, desc, cache, rawJson, rawEntry, action, remove, recipes, outputs, jsonRewrite, warnings };
}

/**
 * 按用户的改动算出「要生成什么代码、会有什么影响」，但**不写盘**。
 *
 * 预览和真写盘都走这个函数，所以「你看到的就是会写进去的」。
 *
 * @param {object} params
 * @returns {object}
 */
export function buildRecipePlan(params) {
  const { instance, recipe, desc, cache, rawEntry, action, remove, recipes, outputs, jsonRewrite, warnings } = collectRecipeParts(params);

  let code = '';
  let summary = [];
  let dest = '';
  if (jsonRewrite) {
    code = jsonRewrite.content;
    summary = jsonRewrite.summary;
  } else {
    const generated = generateScript({
      remove,
      recipes,
      header: `由 MC 整合包工作室生成（${new Date().toISOString().slice(0, 10)}）`,
    });
    code = generated.code;
    summary = generated.summary;
  }

  const kubejsDir = path.join(instance.instanceDir, 'kubejs');
  if (!fs.existsSync(kubejsDir)) {
    throw new McError(
      `${instance.id} 里没有 kubejs 目录`,
      '这个包没装 KubeJS，没有地方放改配方的脚本',
      'KubejsNotFound',
    );
  }
  if (jsonRewrite) {
    dest = recipeJsonTargetPath(kubejsDir, rawEntry);
    if (fs.existsSync(dest)) {
      warnings.push(`${path.basename(dest)} 已经存在，写入时会覆盖它（会自动备份）`);
    }
  } else {
    // 生成的代码自己要先跑得通，否则写了也是废的
    const self = runScript(code, 'kubejs/server_scripts/preview.js');
    if (self.status !== 'ok') {
      throw new McError(
        `生成的代码跑不通：${self.error}`,
        '这是程序生成的 bug，请把这段报错反馈一下',
        'KubejsCodegenBroken',
      );
    }
    // targetFile 自己会加 dsh_ 前缀，所以这里传 'recipes' 而不是 'dsh_recipes'
    dest = targetFile(kubejsDir, String(params.fileName ?? 'recipes'));
    if (fs.existsSync(dest)) {
      warnings.push(`${path.basename(dest)} 已经存在，写入时会覆盖它（会自动备份）`);
    }
  }

  // 影响面：删掉原配方之后，哪些东西会彻底没来源。
  // 改配方的情况要排除「新配方仍然产出」的那些，否则会虚报一堆。
  const breaks = findBreaks(cache.graph, [recipe.id], { limit: 40 });
  const stillProduced = new Set([
    ...recipes.map((r) => r.output),
    ...outputs.map((o) => o.id),
  ]);
  const lost = breaks.broken.filter((b) => !stillProduced.has(b.item));
  const critical = breaks.critical.filter((b) => !stillProduced.has(b.item));
  if (critical.length) {
    warnings.push(
      `有 ${critical.length} 个物品会因此彻底拿不到，而且还有配方在用它（例如 ${critical[0].item}，${critical[0].usedBy} 条配方要用）`,
    );
  }

  return {
    action,
    recipe: desc,
    code,
    targetPath: dest,
    summary,
    warnings,
    mode: jsonRewrite ? 'json' : 'script',
    impact: {
      critical: critical.slice(0, 10).map((b) => ({ item: b.item, usedBy: b.usedBy })),
      lost: lost.slice(0, 20).map((b) => ({ item: b.item, usedBy: b.usedBy })),
      lostTotal: lost.length,
    },
    counts: { removed: remove.length, added: jsonRewrite ? 1 : recipes.length },
  };
}

/** 一次批量最多改几条：和 /recipes 列表的 limit 对齐，防止一口气把整包配方清了。 */
const MAX_BATCH = 40;

/**
 * 读批量参数里的 items：真数组 / JSON 串 / 逗号分隔的 ID 都认。
 *
 * 逗号分隔时只有 ID、没有各自的改动参数，统一动作会套到每条上；
 * 数组里每项可以带自己的 action/count/delta/输出等，逐条覆盖统一值。
 */
function asBatchItems(value) {
  let list = value;
  if (typeof value === 'string' && value.trim()) {
    try {
      list = JSON.parse(value);
    } catch {
      list = value.split(',').map((id) => ({ recipeId: id }));
    }
  }
  if (!Array.isArray(list)) list = [];
  const out = [];
  for (const raw of list) {
    if (!raw) continue;
    const one = typeof raw === 'string' ? { recipeId: raw } : { ...raw };
    const id = String(one.recipeId ?? '').trim();
    if (!id) continue;
    one.recipeId = id;
    out.push(one);
  }
  return out;
}

/**
 * 算一批配方改动的完整计划（**不写盘**）：把多条的「删除项 + 新配方」合并成
 * **一份** KubeJS 脚本，多产物则各自一份 JSON 改写文件。
 *
 * 为什么必须合并：单条改动都落在固定的 dsh_recipes.js，若循环调 /recipe/apply，
 * 后一条会覆盖前一条，最后只剩一条生效。预览和真写盘都走这个函数，
 * 所以「你看到的就是会写进去的」。
 *
 * 参数形状：dir / id 是实例；items 是数组，每项至少 {recipeId}，可带各自的
 * action / count / delta / pattern / keys / inputs / outputs；外层 action、delta、
 * fileName 是统一值，逐条没给时用它们。
 *
 * @param {object} params
 * @returns {object}
 */
export function buildBatchPlan(params) {
  const items = asBatchItems(params.items);
  if (!items.length) {
    throw new McError('还没选要改的配方', '先在配方列表里勾几条，再点批量预览', 'McBadArgs');
  }
  if (items.length > MAX_BATCH) {
    throw new McError(`一次最多改 ${MAX_BATCH} 条`, '少选几条，分两批做', 'McBadArgs');
  }

  const dir = needDir(params);
  const outerAction = String(params.action ?? 'edit').toLowerCase() === 'remove' ? 'remove' : 'edit';
  const parts = [];
  const seen = new Set();
  const allWarnings = [];
  const allSummary = [];
  const allRemove = [];
  const allRecipes = [];
  const allOutputs = [];
  const jsonFiles = [];
  const originalIds = [];
  let graph = null;
  let instance = null;
  let fileName = 'recipes';

  for (const one of items) {
    if (seen.has(one.recipeId)) {
      throw new McError(`配方 ${one.recipeId} 选了两次`, '同一条配方勾一次就够了', 'McBadArgs');
    }
    seen.add(one.recipeId);

    // 每条先继承外层统一动作，再让逐条参数覆盖；delta 只有「编辑」时才用得上。
    const itemParams = {
      dir,
      id: params.id,
      refresh: params.refresh,
      fileName: one.fileName ?? params.fileName,
      recipeId: one.recipeId,
      action: one.action ?? outerAction,
      count: one.count,
      delta: one.delta ?? params.delta,
      pattern: one.pattern,
      keys: one.keys,
      inputs: one.inputs,
      outputs: one.outputs,
    };
    const p = collectRecipeParts(itemParams);
    parts.push(p);
    graph = p.cache.graph;
    instance = p.instance;
    fileName = String(itemParams.fileName ?? 'recipes');
    originalIds.push(p.recipe.id);
    // 多产物走「同名数据包文件覆盖」：和单条 /recipe/apply 一样，
    // 不能顺手在脚本里 event.remove 它，否则覆盖文件刚加的配方又被删掉。
    if (!p.jsonRewrite) allRemove.push(...p.remove);
    allRecipes.push(...p.recipes);
    allOutputs.push(...p.outputs);
    allWarnings.push(...p.warnings.map((w) => `${p.recipe.id}：${w}`));
    allSummary.push(...(
      p.jsonRewrite ? p.jsonRewrite.summary : []
    ));
    if (p.jsonRewrite) {
      jsonFiles.push({
        file: recipeJsonTargetPath(path.join(p.instance.instanceDir, 'kubejs'), p.rawEntry),
        content: p.jsonRewrite.content,
        recipeId: p.recipe.id,
      });
      allSummary.push(`按多产物 JSON 改写 ${p.recipe.id}`);
    }
  }

  const kubejsDir = path.join(instance.instanceDir, 'kubejs');
  if (!fs.existsSync(kubejsDir)) {
    throw new McError(
      `${instance.id} 里没有 kubejs 目录`,
      '这个包没装 KubeJS，没有地方放改配方的脚本',
      'KubejsNotFound',
    );
  }

  const files = [];
  if (allRecipes.length || allRemove.length) {
    // 所有单产物改动（含「删」）合成一份脚本，一次写进 dsh_recipes.js。
    const generated = generateScript({
      remove: allRemove,
      recipes: allRecipes,
      header: `由 MC 整合包工作室批量生成（${items.length} 条，${new Date().toISOString().slice(0, 10)}）`,
    });
    const self = runScript(generated.code, 'kubejs/server_scripts/preview.js');
    if (self.status !== 'ok') {
      throw new McError(
        `生成的代码跑不通：${self.error}`,
        '这是程序生成的 bug，请把这段报错反馈一下',
        'KubejsCodegenBroken',
      );
    }
    allSummary.push(...generated.summary);
    const scriptFile = targetFile(kubejsDir, fileName);
    if (fs.existsSync(scriptFile)) {
      allWarnings.push(`${path.basename(scriptFile)} 已经存在，写入时会覆盖它（会自动备份）`);
    }
    files.push({ file: scriptFile, content: generated.code, mode: 'script' });
  }
  for (const jf of jsonFiles) {
    if (fs.existsSync(jf.file)) {
      allWarnings.push(`${path.basename(jf.file)} 已经存在，写入时会覆盖它（会自动备份）`);
    }
    files.push({ file: jf.file, content: jf.content, mode: 'json' });
  }
  if (!files.length) {
    throw new McError('这批改动没有生成任何文件', '检查一下是不是全选了重复或空的配方', 'McBadArgs');
  }

  // 影响面：把所有原配方一起当「删掉」算，再排除这批新配方仍会产出的物品，
  // 否则会虚报一堆「彻底拿不到」。
  const breaks = findBreaks(graph, originalIds, { limit: 40 });
  const stillProduced = new Set([
    ...allRecipes.map((r) => r.output),
    ...allOutputs.map((o) => o.id),
  ]);
  const lost = breaks.broken.filter((b) => !stillProduced.has(b.item));
  const critical = breaks.critical.filter((b) => !stillProduced.has(b.item));
  if (critical.length) {
    allWarnings.push(
      `有 ${critical.length} 个物品会因此彻底拿不到，而且还有配方在用它（例如 ${critical[0].item}，${critical[0].usedBy} 条配方要用）`,
    );
  }

  return {
    items: parts.map((p) => ({
      recipeId: p.recipe.id,
      action: p.action,
      kind: p.desc.kind,
      multi: p.desc.multi === true,
      output: p.desc.output,
      count: p.desc.count,
    })),
    files,
    summary: allSummary,
    warnings: allWarnings,
    impact: {
      critical: critical.slice(0, 10).map((b) => ({ item: b.item, usedBy: b.usedBy })),
      lost: lost.slice(0, 20).map((b) => ({ item: b.item, usedBy: b.usedBy })),
      lostTotal: lost.length,
    },
    counts: {
      removed: allRemove.length,
      added: allRecipes.length + jsonFiles.length,
      files: files.length,
    },
  };
}

// ————————————————————————— 对外接口 —————————————————————————

/** GET /recipes?dir&id&item= —— 一个物品的配方清单。 */
export async function handleItemRecipes(request) {
  const params = await readParams(request);
  const dir = needDir(params);
  const item = String(params.item ?? '').trim();
  if (!item) {
    throw new McError('缺少物品 ID', '先在搜索结果里点一个物品', 'McBadArgs');
  }
  const instance = resolveInstance(dir, String(params.id ?? '').trim());
  const cache = cachedGraph(instance, String(params.refresh ?? '') === '1');
  const limit = Math.max(1, Math.min(Number(params.limit) || 20, 60));

  const producers = cache.graph.producersOf(item);
  const consumers = cache.graph.consumersOf(item);
  return {
    item,
    producers: producers.slice(0, limit).map(brief),
    consumers: consumers.slice(0, limit).map(brief),
    producerTotal: producers.length,
    consumerTotal: consumers.length,
    recipeCount: cache.graph.byId.size,
    elapsedMs: cache.elapsedMs,
  };
}

/** GET /recipe?dir&id&recipeId= —— 一条配方的可编辑表单。 */
export async function handleRecipeDetail(request) {
  const params = await readParams(request);
  const { desc, cache } = locate(params);
  const usedBy = desc.output ? cache.graph.consumersOf(desc.output) : [];
  return {
    recipe: desc,
    usedBy: { count: usedBy.length, recipes: usedBy.slice(0, 8).map(brief) },
  };
}

/** GET /recipe/preview?... —— 生成代码 + 影响面，不写盘。 */
export async function handleRecipePreview(request) {
  const params = await readParams(request);
  return buildRecipePlan(params);
}

/**
 * POST /recipe/apply —— 真写进去。
 *
 * 三个安全动作缺一不可：写前探一下能不能写、写前备份、写完复验不过就整批回滚。
 */
export async function handleRecipeApply(request) {
  const params = await readParams(request);
  const plan = buildRecipePlan(params);

  const dir = path.dirname(plan.targetPath);
  const writable = checkWritable(dir);
  if (!writable.ok) {
    throw new McError(
      `写不进去：${writable.error}`,
      'DSH 默认只允许改当前工作目录里的文件。要改外面的整合包，得把这次会话的写权限放开到「完全访问」；或者把整合包复制到工作目录下再改。',
      'KubejsNotWritable',
    );
  }

  const { backups, done } = writeFiles([{ file: plan.targetPath, content: plan.code }], '改配方');

  // 复验 1：我们刚写的这段脚本自己能跑通吗
  // （JSON 改写路径写的是数据包文件，不是脚本，跳过这一步）
  if (plan.mode !== 'json') {
    const self = runScript(plan.code, path.basename(plan.targetPath));
    if (self.status !== 'ok') {
      restoreFiles(done);
      throw new McError(
        `写完复查不过（${self.error}），已回滚`,
        '文件已还原成写之前的样子',
        'KubejsVerifyFailed',
      );
    }
  }

  // 复验 2：整个 kubejs 目录跑一遍，重点看我们这份。别人的历史问题只提醒、不回滚。
  const warnings = [...plan.warnings];
  let verified = true;
  try {
    const instance = resolveInstance(String(params.dir ?? '').trim(), String(params.id ?? '').trim());
    const idx = cachedIndex(instance, false);
    const report = verifyScripts(path.join(instance.instanceDir, 'kubejs'), {
      mcVersion: instance.mcVersion,
      knownItems: (id) => idx.has(id),
    });
    const mine = path.basename(plan.targetPath).toLowerCase();
    const own = report.scripts.find((s) => String(s.file).toLowerCase().endsWith(mine));
    if (own && own.status !== 'ok') {
      restoreFiles(done);
      throw new McError(
        `写完复查发现脚本跑不通（${own.error}），已回滚`,
        '文件已还原成写之前的样子',
        'KubejsVerifyFailed',
      );
    }
    for (const m of report.missingItems.slice(0, 5)) {
      warnings.push(`引用了不存在的物品 ${m.id}`);
      verified = false;
    }
  } catch (error) {
    if (error instanceof McError) throw error;
    // 复验本身出错（比如包太大超时）不该把已经写好的东西回滚 —— 记一句提醒就够
    warnings.push(`复验没跑完：${error instanceof Error ? error.message : String(error)}`);
    verified = false;
  }

  return {
    targetPath: plan.targetPath,
    backup: backups[0] ?? '',
    code: plan.code,
    summary: plan.summary,
    recipe: plan.recipe,
    impact: plan.impact,
    mode: plan.mode,
    verified,
    warnings,
  };
}

/** GET/POST /recipe/batch/preview —— 算一批改动会写什么、有什么影响，不写盘。 */
export async function handleRecipeBatchPreview(request) {
  const params = await readParams(request);
  return buildBatchPlan(params);
}

/**
 * POST /recipe/batch/apply —— 把一批改动一次性写进去。
 *
 * 和单条 apply 一样三道安全动作：写前探权限、写前备份、写完复验，
 * 任意一步不过就 restoreFiles(done) **整批**回滚（不会写一半留下中间态）。
 * 注意 apply 内部用同一份 buildBatchPlan 重算，不信任前端传回的预览，
 * 所以界面确认写入时参数必须和预览逐字一致。
 */
export async function handleRecipeBatchApply(request) {
  const params = await readParams(request);
  const plan = buildBatchPlan(params);

  // 每个要写的目录都探一下能不能写，别等写到一半才失败
  for (const f of plan.files) {
    const writable = checkWritable(path.dirname(f.file));
    if (!writable.ok) {
      throw new McError(
        `写不进去：${writable.error}`,
        'DSH 默认只允许改当前工作目录里的文件。要改外面的整合包，得把这次会话的写权限放开到「完全访问」；或者把整合包复制到工作目录下再改。',
        'KubejsNotWritable',
      );
    }
  }

  const { backups, done } = writeFiles(
    plan.files.map((f) => ({ file: f.file, content: f.content })),
    '批量改配方',
  );

  // 复验 1：这批脚本自己能跑通吗（JSON 改写文件不是脚本，跳过）
  for (const f of plan.files) {
    if (f.mode !== 'script') continue;
    const self = runScript(f.content, path.basename(f.file));
    if (self.status !== 'ok') {
      restoreFiles(done);
      throw new McError(
        `写完复查不过（${self.error}），已整批回滚`,
        '文件都还原成写之前的样子了',
        'KubejsVerifyFailed',
      );
    }
  }

  // 复验 2：整个 kubejs 目录跑一遍，重点看我们刚写的脚本文件。
  // 别人的历史问题只提醒、不回滚。
  const warnings = [...plan.warnings];
  let verified = true;
  try {
    const instance = resolveInstance(String(params.dir ?? '').trim(), String(params.id ?? '').trim());
    const idx = cachedIndex(instance, false);
    const report = verifyScripts(path.join(instance.instanceDir, 'kubejs'), {
      mcVersion: instance.mcVersion,
      knownItems: (id) => idx.has(id),
    });
    const mine = plan.files.filter((f) => f.mode === 'script').map((f) => path.basename(f.file).toLowerCase());
    for (const s of report.scripts) {
      const name = String(s.file).toLowerCase();
      if (mine.some((m) => name === m || name.endsWith('/' + m) || name.endsWith('\\' + m)) && s.status !== 'ok') {
        restoreFiles(done);
        throw new McError(
          `写完复查发现脚本跑不通（${s.error}），已整批回滚`,
          '文件都还原成写之前的样子了',
          'KubejsVerifyFailed',
        );
      }
    }
    for (const m of report.missingItems.slice(0, 5)) {
      warnings.push(`引用了不存在的物品 ${m.id}`);
      verified = false;
    }
  } catch (error) {
    if (error instanceof McError) throw error;
    // 复验本身出错不该把已经写好的东西回滚 —— 记一句提醒就够
    warnings.push(`复验没跑完：${error instanceof Error ? error.message : String(error)}`);
    verified = false;
  }

  return {
    files: plan.files.map((f) => f.file),
    backups,
    items: plan.items,
    summary: plan.summary,
    impact: plan.impact,
    counts: plan.counts,
    verified,
    warnings,
  };
}