/**
 * 手工跑一个「能力」，打印它的完整输出对象。开发期用，不进产物。
 *
 *   node test/run-tool.mjs <能力名> <参数 json 文件路径>
 *
 * 参数走文件而不是命令行：Windows 上带空格和中文的路径在 PowerShell 里转义后
 * 极易被 shell 吃掉引号（实测过一次 Unterminated string in JSON）。
 *
 * 说明：原来的 `lib/tools/` 工具层（依赖 @deepseek-ai/dsh-tools）已经删掉了，
 * 这里改成「能力名 → packages/core/ 的函数」的手工映射表。行为照旧：
 *   - 写类能力默认只算不写（演练），参数里给 apply: true 才真落盘；
 *   - 统一输出 { ok, action, error, hint, code, lines, ... }。
 * （`node --import ./test/register.mjs` 仍然可以带上，这里已经不需要 dsh-tools 了。）
 */
import fs from 'node:fs';
import path from 'node:path';

import { McError } from '../packages/core/errors.js';

import { resolveInstance, inspectInstance } from '../packages/core/instance.js';
import { indexInstance } from '../packages/core/index.js';
import { searchItems } from '../packages/core/item-search.js';
import { inspectJar, findModJar, modConfigFiles, readTextFile } from '../packages/core/mod-inspect.js';

import { loadQuests, describeQuests, findQuests, relateQuest, lintQuests, lintQuestImages, describeLint, patchQuestText, patchQuestFields } from '../packages/core/quests.js';
import { planAddQuest, planAddChapter, commitQuestPlan, describeQuestPlan } from '../packages/core/quest-create.js';
import { planMoveQuests, commitMovePlan, describeMovePlan } from '../packages/core/quest-move.js';
import { planNodeEdit, commitNodeEdit, planNodeDelete, commitNodeDelete, describeNodeEditPlan, describeNodeDeletePlan } from '../packages/core/quest-node.js';
import { planImageEdit, commitImagePlan, describeImagePlan } from '../packages/core/quest-image-edit.js';

import { runScript, verifyScripts, describeVerify } from '../packages/core/kubejs.js';
import { generateScript, targetFile } from '../packages/core/kubejs-write.js';
import { writeFiles, restoreFiles, checkWritable } from '../packages/core/write.js';

import { loadRecipes, buildGraph, findBreaks, pathsTo, usesOf } from '../packages/core/recipes.js';
import { sameNameCollisions, familyCoverage, progressCurve, describeOverlap, describeProgress } from '../packages/core/overlap.js';

import { planExport, buildExport, EXPORT_MODES, looksLikePcl } from '../packages/core/export.js';
import { plan as planLaunch, describePlan as describeLaunchPlan, renderCommand, launch } from '../packages/core/launch.js';
import { buildPackPlan, applyPackPlan, describePackPlan, describePackResult } from '../packages/core/pack-create.js';
import { planScaffold, applyScaffold, describeScaffold } from '../packages/core/scaffold.js';

import { createHttp, readNetOptionsFromEnv } from '../packages/core/mod-fetch.js';
import { isNetworkFailure, describeNetworkFailure } from '../packages/core/net-errors.js';
import {
  CF_CLASS_ID, cfSearchUrl, mrSearchUrl, parseMrSearch, rankCandidates, formatDownloads, formatSize,
} from '../packages/core/mod-source.js';
import { buildInstallPlan, applyInstallPlan, describePlan as describeInstallPlan, describeResult as describeInstallResult } from '../packages/core/mod-install.js';

// ————————————————————————— 小工具 —————————————————————————

/** 输出要能无损地 JSON 往返：丢 undefined/函数、NaN→null、Map→对象、Set→数组。 */
function toLossless(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value.entries()) {
      const item = toLossless(v);
      if (item !== undefined) out[String(k)] = item;
    }
    return out;
  }
  if (value instanceof Set) return [...value].map((v) => toLossless(v) ?? null);
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : toLossless(v) ?? null));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const item = toLossless(v);
    if (item !== undefined) out[k] = item;
  }
  return out;
}

/** 统一错误包装：McError → 结构化失败，其它异常 → McInternal。 */
async function guarded(action, body) {
  try {
    const value = await body();
    return toLossless({ ok: true, action, error: '', hint: '', code: '', ...value });
  } catch (e) {
    if (e instanceof McError) {
      return toLossless({ ok: false, action, error: e.message, hint: e.hint ?? '', code: e.code ?? 'McError', lines: [e.message] });
    }
    return toLossless({
      ok: false,
      action,
      error: e && e.message ? e.message : String(e),
      hint: '',
      code: 'McInternal',
      lines: [e && e.message ? e.message : String(e)],
    });
  }
}

/** 找出任务书目录：直接给 questDir 就用它，否则从实例里找带 chapters 的那个。 */
function resolveQuestDir(input) {
  const direct = String(input.questDir ?? '').trim();
  if (direct) {
    if (!fs.existsSync(direct)) {
      throw new McError(`任务书目录不存在：${direct}`, '确认路径对不对', 'QuestDirMissing');
    }
    return direct;
  }
  const instanceDir = String(input.instanceDir ?? '').trim();
  if (!instanceDir) {
    throw new McError('没给任务书目录', '给 questDir，或者给 instanceDir 让程序自己找', 'QuestNoTarget');
  }
  const instance = resolveInstance(instanceDir, input.instanceId ?? '');
  const hit = instance.questDirs.find((d) => fs.existsSync(path.join(d, 'chapters')));
  if (!hit) {
    throw new McError('这个实例里没找到 FTB Quests 任务书', '确认包里装了 FTB Quests', 'QuestNotFound');
  }
  return hit;
}

/** 打开任务书：返回目录 + 读好的 store。 */
function openQuests(input) {
  const questDir = resolveQuestDir(input);
  const store = loadQuests(questDir, { locale: input.locale });
  return { questDir, store };
}

/** 找 KubeJS 目录：直接给 kubejsDir 就用它，否则 <instanceDir>/kubejs。 */
function resolveKubejsDir(input) {
  const direct = String(input.kubejsDir ?? '').trim();
  if (direct) {
    if (!fs.existsSync(direct)) {
      throw new McError(`KubeJS 目录不存在：${direct}`, '确认路径对不对', 'KubejsDirMissing');
    }
    return direct;
  }
  const instanceDir = String(input.instanceDir ?? '').trim();
  if (!instanceDir) {
    throw new McError('没给 KubeJS 目录', '给 kubejsDir，或者给 instanceDir', 'KubejsNoTarget');
  }
  const target = path.join(instanceDir, 'kubejs');
  if (!fs.existsSync(target)) {
    throw new McError(`这个实例里没有 kubejs 目录：${target}`, '确认装了 KubeJS', 'KubejsNotFound');
  }
  return target;
}

/** 从实例里取「游戏版本 + 加载器」；没给实例就返回空。 */
function instanceContext(input) {
  const instanceDir = String(input.instanceDir ?? '').trim();
  if (!instanceDir) return { gameVersion: '', loader: '', instance: null };
  const instance = resolveInstance(instanceDir, input.instanceId ?? '');
  return { gameVersion: instance.mcVersion ?? '', loader: instance.loader ?? '', instance };
}

/** 任务条件的中文说法。 */
const TASK_LABEL = {
  item: '交物品', kill: '击杀', xp: '获得经验', dimension: '到达维度', stat: '统计达成',
  location: '到达坐标', checkmark: '手动打勾', advancement: '获得进度', observation: '观察',
  biome: '到达生物群系', structure: '找到结构', gamestage: '游戏阶段', fluid: '流体', custom: '自定义',
};
const REWARD_LABEL = {
  item: '物品', choice: '多选一', xp: '经验', xp_levels: '等级', loot: '战利品表', command: '执行命令',
  toast: '提示', gamestage: '游戏阶段', random: '随机', custom: '自定义',
  currency: '货币', advancement: '进度',
};

const describeTask = (t) => `${TASK_LABEL[t.type] ?? t.type} ${t.what} ×${t.count}`;
const describeReward = (r) => `${REWARD_LABEL[r.type] ?? r.type} ${r.item?.id ?? r.command ?? r.table_id ?? r.gamestage ?? ''} ×${r.count ?? 1}`;

/** bytes → 口语大小。 */
function fmtSize(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** CurseForge 搜索结果的最小解析（够列表展示）。 */
function parseCfSearchMini(json) {
  const data = Array.isArray(json?.data) ? json.data : [];
  const results = data.map((item) => ({
    source: 'curseforge',
    projectId: String(item?.id ?? ''),
    slug: String(item?.slug ?? ''),
    title: String(item?.name ?? ''),
    description: String(item?.summary ?? '').replace(/\r?\n/g, ' ').slice(0, 200),
    downloads: Number(item?.downloadCount ?? 0),
    categories: (item?.categories ?? []).map((c) => String(c?.name ?? '')),
    loaders: [],
    versions: (item?.latestFilesIndexes ?? []).map((f) => String(f?.gameVersion ?? '')).filter(Boolean).slice(0, 8),
    updated: String(item?.dateModified ?? ''),
    pageUrl: item?.links?.websiteUrl ? String(item.links.websiteUrl) : '',
    iconUrl: String(item?.logo?.thumbnailUrl ?? ''),
  }));
  return { total: Number(json?.pagination?.totalCount ?? results.length), results };
}

/** 写类能力的统一收尾：apply 才是真写。 */
function dryRunNote(lines) {
  lines.push('以上是演练结果，没有写任何文件。确认无误后加 apply=true 再跑一次。');
  return lines;
}

// ————————————————————————— 能力实现 —————————————————————————

/** 实例信息。 */
async function instanceInfo(input) {
  const instance = resolveInstance(input.instanceDir, input.instanceId ?? '');
  const info = {
    id: instance.id,
    instanceDir: instance.instanceDir,
    mcRoot: instance.mcRoot,
    layout: instance.layout,
    mcVersion: instance.mcVersion,
    loader: instance.loader,
    loaderVersion: instance.loaderVersion,
    mainClass: instance.mainClass,
    modsDir: instance.modsDir,
    modsCount: instance.modsCount,
    disabledModsCount: instance.disabledModsCount,
    clientJar: instance.clientJar,
    hasClientJar: instance.hasClientJar,
    presentDirs: instance.presentDirs,
    questDirs: instance.questDirs,
    javaMajor: Number(instance.javaVersion?.majorVersion ?? 0),
  };
  const out = { ok: true, action: 'mc_instance_info', instance: info, lines: [] };
  if (input.index) {
    const idx = indexInstance(instance);
    out.index = { itemCount: idx.itemCount, recipeCount: idx.recipeCount, jarCount: idx.jarCount, indexedMs: idx.indexedMs };
    out.lines.push(`索引完成：物品 ${idx.itemCount} 个，配方 ${idx.recipeCount} 条，用时 ${idx.indexedMs}ms`);
  } else {
    out.lines.push(`${instance.id}：MC ${instance.mcVersion} · ${instance.loader} · ${instance.modsCount} 个 mod`);
  }
  return out;
}

/** 实例清单（一次看所有候选实例）。 */
async function instanceList(input) {
  const all = inspectInstance(input.instanceDir);
  return {
    ok: true,
    action: 'mc_instance_list',
    count: all.length,
    instances: all.map((i) => ({ id: i.id, instanceDir: i.instanceDir, mcVersion: i.mcVersion, loader: i.loader, modsCount: i.modsCount })),
    lines: all.map((i) => `${i.id}  ${i.mcVersion}  ${i.loader}  ${i.modsCount} 个 mod`),
  };
}

/** mod 列表。 */
async function modList(input) {
  const instance = resolveInstance(input.instanceDir, input.instanceId ?? '');
  const idx = indexInstance(instance, { includeClientJar: false });
  const sortBy = String(input.sortBy ?? 'items');
  const limit = Math.max(1, Math.min(Number(input.limit ?? 200) || 200, 1000));
  const mods = [...idx.mods].sort((a, b) => {
    if (sortBy === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
    if (sortBy === 'recipes') return (b.recipes ?? 0) - (a.recipes ?? 0);
    return (b.items ?? 0) - (a.items ?? 0);
  }).slice(0, limit);
  return {
    ok: true,
    action: 'mc_mod_list',
    jarCount: idx.jarCount,
    jarFailed: idx.jarFailed,
    modCount: idx.mods.length,
    modIdResolved: idx.modIdResolved,
    unresolvedMods: idx.unresolvedMods,
    mods,
    lines: mods.map((m) => `${m.modId || '(未知)'}  ${m.name || ''}  物品 ${m.items ?? 0} · 配方 ${m.recipes ?? 0}`),
  };
}

/** 物品检索。 */
async function itemSearch(input) {
  const query = String(input.query ?? '').trim();
  const namespace = String(input.namespace ?? '').trim();
  const modId = String(input.modId ?? '').trim();
  if (!query && !namespace && !modId) {
    throw new McError('query / namespace / modId 至少给一个', '比如 query: "diamond"', 'McBadArgs');
  }
  const instance = resolveInstance(input.instanceDir, input.instanceId ?? '');
  const idx = indexInstance(instance, { includeClientJar: true });
  const result = searchItems(idx._items.values(), {
    query, namespace, modId, limit: Number(input.limit ?? 30) || 30, names: idx._names,
  });
  return {
    ok: true,
    action: 'mc_item_search',
    total: result.total,
    shown: result.shown,
    indexedMs: idx.indexedMs,
    items: result.items,
    lines: result.items.map((i) => `${i.id}${i.name ? `   ${i.name}` : ''}`),
  };
}

/** 拆开一个 mod 的 jar。 */
async function modInspect(input) {
  const view = String(input.view ?? 'summary').toLowerCase();
  const VIEWS = ['summary', 'items', 'recipes', 'tags', 'loot', 'config'];
  if (!VIEWS.includes(view)) {
    throw new McError(`view 只能是 ${VIEWS.join(' / ')}，收到「${input.view}」`, '不传默认 summary', 'McBadArgs');
  }
  const limit = Math.max(1, Math.min(Number(input.limit ?? 20) || 20, 300));
  const instance = resolveInstance(input.instanceDir, input.instanceId ?? '');
  const jarPath = findModJar(instance, input.modId);
  const mod = inspectJar(jarPath);
  const configs = modConfigFiles(instance, mod.modId || input.modId);
  const ownConfigs = configs.filter((c) => c.own);
  const otherConfigs = configs.filter((c) => !c.own);

  const notes = [];
  if (mod.recipeSkipped > 0) notes.push(`${mod.recipeSkipped} 条配方读不出来（JSON 损坏或超过上限）`);
  if (!mod.modId) notes.push('这个 jar 没有 mod 元数据，是按目录名猜的命名空间');
  if (otherConfigs.length && (view === 'summary' || view === 'config')) {
    notes.push(`另有 ${otherConfigs.length} 个文件名以 ${mod.modId} 开头的配置，属于别的 mod，不是这个 mod 的`);
  }

  const head = `${mod.modId || '(未知命名空间)'}${mod.name ? ` · ${mod.name}` : ''}${mod.version ? ` @${mod.version}` : ''}`;
  const lines = [];
  let outItems = [];
  let outRecipes = [];
  let outTags = [];
  let outLoot = [];
  let outConfigs = [];

  if (view === 'summary') {
    lines.push(head);
    lines.push(`  jar  ${mod.jarFile}`);
    lines.push(`  物品 ${mod.counts.items} 个 ｜ 配方 ${mod.counts.recipes} 条 ｜ 标签 ${mod.counts.tags} 个 ｜ 掉落表 ${mod.counts.loot} 张 ｜ 配置 ${ownConfigs.length} 个`);
    for (const t of mod.recipeTypes.slice(0, 8)) lines.push(`    ${String(t.count).padStart(5)}  ${t.type}`);
    for (const c of ownConfigs.slice(0, 8)) lines.push(`    ${c.file}  (${fmtSize(c.size)})`);
    lines.push('');
    lines.push('想看细节：view=items / recipes / tags / loot / config');
  }
  if (view === 'items') {
    outItems = mod.items.slice(0, limit).map((i) => ({ id: i.id, name: i.name, en: i.en }));
    lines.push(`${head}：物品 ${mod.counts.items} 个`);
    for (const i of outItems) lines.push(`  ${i.id}${i.name ? `   ${i.name}` : ''}`);
  }
  if (view === 'recipes') {
    const want = String(input.item ?? '').trim();
    let pool = mod.recipes;
    if (want) pool = pool.filter((r) => r.result?.id === want || r.ingredients.includes(want));
    outRecipes = pool.slice(0, limit).map((r) => ({
      file: r.file, type: r.type, resultId: r.result?.id ?? '', resultCount: r.result?.count ?? 0, ingredients: r.ingredients,
    }));
    lines.push(`${head}：配方 ${pool.length} 条${want ? `（涉及 ${want}）` : ''}`);
    outRecipes.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${r.type || '(无 type)'}  →  ${r.resultId || '(无产物)'}${r.resultCount > 1 ? ` ×${r.resultCount}` : ''}`);
      if (r.ingredients.length) lines.push(`     吃：${r.ingredients.join(', ')}`);
      lines.push(`     文件：${r.file}`);
    });
  }
  if (view === 'tags') {
    outTags = mod.tags.slice(0, limit).map((t) => ({ tag: t.tag, values: t.values.slice(0, 40), file: t.file }));
    lines.push(`${head}：标签 ${mod.counts.tags} 个`);
    for (const t of outTags) {
      lines.push(`  ${t.tag}  (${t.values.length} 项)`);
      if (t.values.length) lines.push(`     ${t.values.slice(0, 12).join(', ')}${t.values.length > 12 ? ' …' : ''}`);
    }
  }
  if (view === 'loot') {
    outLoot = mod.loot.slice(0, limit).map((l) => ({ file: l.file, items: l.items }));
    lines.push(`${head}：掉落表 ${mod.counts.loot} 张`);
    for (const l of outLoot) {
      lines.push(`  ${l.file}`);
      if (l.items.length) lines.push(`     掉落：${l.items.join(', ')}`);
    }
  }
  if (view === 'config') {
    outConfigs = ownConfigs.slice(0, limit).map((c) => {
      const r = readTextFile(c.abs, 2500);
      return { file: c.file, size: c.size, preview: r.truncated ? `${r.text}\n…（已截断，共 ${fmtSize(r.size)}）` : r.text };
    });
    lines.push(`${head}：配置文件 ${ownConfigs.length} 个`);
    for (const c of outConfigs) {
      lines.push('');
      lines.push(`── ${c.file}  (${fmtSize(c.size)})`);
      lines.push(c.preview.trimEnd());
    }
  }
  for (const n of notes) lines.push(`⚠️ ${n}`);

  return {
    ok: true, action: 'mc_mod_inspect',
    jarFile: mod.jarFile, modId: mod.modId, name: mod.name, version: mod.version,
    counts: { ...mod.counts, configs: ownConfigs.length },
    items: outItems, recipes: outRecipes, recipeTypes: mod.recipeTypes,
    tags: outTags, loot: outLoot, configs: outConfigs, notes, lines,
  };
}

/** 任务书概览。 */
async function questList(input) {
  const { questDir, store } = openQuests(input);
  return {
    ok: true, action: 'mc_quest_list',
    questDir, locale: store.locale, locales: store.locales,
    questCount: store.quests.length,
    chapterCount: store.chapters.length,
    groupCount: store.chapterGroups.length,
    chapters: store.chapters.map((c) => ({ id: c.id, title: c.title, file: c.file, group: c.group, questCount: c.quests.length })),
    lines: describeQuests(store),
  };
}

/** 看一个任务（按 ID 或关键词）。 */
async function questShow(input) {
  const { store } = openQuests(input);
  const questId = String(input.questId ?? '').trim();
  const keyword = String(input.keyword ?? '').trim();
  let candidates = [];
  let id = questId;
  if (!id) {
    if (!keyword) {
      throw new McError('没说要哪个任务', '给 questId 或 keyword', 'QuestNoTarget');
    }
    const hits = findQuests(store, keyword, 10);
    if (!hits.length) {
      throw new McError(`没找到含「${keyword}」的任务`, '换个词再搜', 'QuestNotFound');
    }
    id = hits[0].id;
    candidates = hits.slice(1).map((h) => `${h.title}（${h.chapterTitle}）${h.id}`);
  }
  const rel = relateQuest(store, id);
  if (!rel) {
    throw new McError(`这本书里没有任务 ${id}`, '先刷新一下任务书', 'QuestNotFound');
  }
  const q = rel.quest;
  return {
    ok: true, action: 'mc_quest_show',
    quest: {
      id: q.id, title: q.title, titleSource: q.titleSource, subtitle: q.subtitle,
      chapterTitle: store.chapters.find((c) => c.id === q.chapterId)?.title ?? q.chapterId,
      file: `chapters/${q.chapterFile}`, x: q.x, y: q.y,
      description: q.description,
      tasks: q.taskSummary.map(describeTask),
      rewards: q.rewards.map(describeReward),
    },
    upstream: rel.upstream.map((u) => u.title),
    downstream: rel.downstream.map((d) => d.title),
    candidates,
    lines: [
      `${q.title}（${q.id}）`,
      `  章节：${store.chapters.find((c) => c.id === q.chapterId)?.title ?? q.chapterId}`,
      `  坐标：(${q.x}, ${q.y})`,
      ...q.taskSummary.map((t) => `  条件：${describeTask(t)}`),
      ...q.rewards.map((r) => `  奖励：${describeReward(r)}`),
      ...(rel.upstream.length ? [`  依赖：${rel.upstream.map((u) => u.title).join('、')}`] : []),
      ...(rel.downstream.length ? [`  被依赖：${rel.downstream.map((d) => d.title).join('、')}`] : []),
    ],
  };
}

/** 搜任务。 */
async function questSearch(input) {
  const { store } = openQuests(input);
  const keyword = String(input.keyword ?? '').trim();
  if (!keyword) {
    throw new McError('没给搜索词', '给 keyword', 'McBadArgs');
  }
  const limit = Math.max(1, Math.min(Number(input.limit ?? 20) || 20, 200));
  const hits = findQuests(store, keyword, limit);
  return {
    ok: true, action: 'mc_quest_search',
    total: hits.length,
    items: hits.map((h) => ({ id: h.id, title: h.title, chapterTitle: h.chapterTitle, taskCount: h.taskCount, matchedItems: h.matches })),
    lines: hits.map((h) => `${h.title}（${h.chapterTitle}）${h.id}  ${h.taskCount} 个条件`),
  };
}

/** 任务书体检。 */
async function questLint(input) {
  const { store } = openQuests(input);
  const issues = [...lintQuests(store)];
  let instance = null;
  try {
    instance = instanceContext(input).instance;
  } catch {
    instance = null;
  }
  issues.push(...await lintQuestImages(store, instance));
  const count = (level) => issues.filter((i) => i.level === level).length;
  return {
    ok: true, action: 'mc_quest_lint',
    errorCount: count('error'), warnCount: count('warn'), infoCount: count('info'),
    issues, lines: describeLint(issues),
  };
}

/** 改任务：文字（lang 文件）、坐标（章节文件）、图标/依赖（章节文件）。 */
async function questPatch(input) {
  const { questDir, store } = openQuests(input);
  const questId = String(input.questId ?? '').trim();
  if (!questId) {
    throw new McError('缺少任务 ID', '先在列表里点一个任务', 'McBadArgs');
  }
  const quest = store.questsById.get(questId);
  if (!quest) {
    throw new McError(`找不到任务 ${questId}`, '任务 ID 抄错了，或者它已经被删掉', 'QuestNotFound');
  }
  const chapter = store.chapters.find((c) => c.file === quest.chapterFile);
  if (!chapter) {
    throw new McError(`任务 ${questId} 所属的章节找不到了`, '先跑一次 mc_quest_lint', 'QuestBadChapter');
  }

  const apply = input.apply === true;
  const diff = [];
  const writes = [];
  const pending = new Map(); // 绝对路径 → { file, content, rel }

  // ① 文字
  const textFields = {};
  if (input.title !== undefined) textFields.title = String(input.title);
  if (input.subtitle !== undefined) textFields.subtitle = String(input.subtitle);
  if (input.description !== undefined) textFields.desc = Array.isArray(input.description)
    ? input.description.map(String)
    : [String(input.description)];

  // ② 坐标
  const fieldFields = {};
  for (const field of ['x', 'y']) {
    if (input[field] === undefined) continue;
    const num = Number(input[field]);
    if (!Number.isFinite(num)) {
      throw new McError(`坐标 ${field} 不是数字：${input[field]}`, '坐标得是数字，比如 1.5 或 -3', 'McBadArgs');
    }
    fieldFields[field] = num;
  }

  // ③ 图标 / 依赖
  const wantsNode = input.icon !== undefined || input.dependencies !== undefined;
  let nodePlan = null;
  if (wantsNode) {
    nodePlan = planNodeEdit({
      questDir, store, questId,
      icon: input.icon,
      dependencies: input.dependencies,
    });
  }

  if (!Object.keys(textFields).length && !Object.keys(fieldFields).length && !(nodePlan && nodePlan.changedCount)) {
    throw new McError('没有任何改动', '至少给 title / x / y / icon / dependencies 之一', 'QuestNothingToDo');
  }

  // 图标/依赖：章节文件
  if (nodePlan && nodePlan.writes.length) {
    for (const w of nodePlan.writes) {
      pending.set(w.file, { file: w.file, content: w.content, rel: `chapters/${path.basename(w.file)}` });
    }
    for (const c of nodePlan.changes ?? []) {
      diff.push(`chapters/${chapter.file}: ${c.label} ${c.before} → ${c.after}`);
    }
  }

  // 坐标：章节文件（叠在同一份内容上）
  if (Object.keys(fieldFields).length) {
    const rel = `chapters/${chapter.file}`;
    const base = pending.get(chapter.path)?.content ?? chapter.source;
    const result = patchQuestFields(base, questId, fieldFields, rel);
    if (result.changed) {
      pending.set(chapter.path, { file: chapter.path, content: result.source, rel });
      for (const [k, v] of Object.entries(fieldFields)) {
        diff.push(`${rel}: ${k} ${quest[k]} → ${v}`);
      }
    }
  }

  // 文字：lang 文件
  if (Object.keys(textFields).length) {
    const rel = `lang/${store.locale}.snbt`;
    const langPath = path.join(questDir, 'lang', `${store.locale}.snbt`);
    const base = pending.get(langPath)?.content
      ?? (fs.existsSync(langPath) ? fs.readFileSync(langPath, 'utf8') : '{\n}\n');
    const result = patchQuestText(base, questId, textFields, rel);
    if (result.changed) {
      pending.set(langPath, { file: langPath, content: result.source, rel });
      for (const [k, v] of Object.entries(textFields)) {
        const before = k === 'title' ? quest.title : (k === 'subtitle' ? quest.subtitle : quest.description.join('\n'));
        diff.push(`${rel}: ${k} 「${before}」→「${Array.isArray(v) ? v.join('\n') : v}」`);
      }
    }
  }

  for (const entry of pending.values()) writes.push({ file: entry.file, content: entry.content });
  const files = [...pending.values()].map((p) => p.rel);

  const lines = [`准备改任务「${quest.title}」（${questId}）`, apply ? '模式：真正写盘' : '模式：演练（不写盘）', ...diff];
  if (!apply) {
    dryRunNote(lines);
    return { ok: true, action: 'mc_quest_patch', apply: false, changed: files.length > 0, changedCount: diff.length, files, diff, backup: '', lines };
  }

  const { backups } = writeFiles(writes, '改任务');
  const after = loadQuests(questDir, { locale: store.locale });
  const newErrors = lintQuests(after).filter((i) => i.level === 'error');
  lines.push('', `已写入 ${writes.length} 个文件${backups.length ? `，备份：${backups.join('、')}` : ''}`);
  lines.push(`复查：${after.chapters.length} 个章节 / ${after.quests.length} 个任务，${newErrors.length} 个错误`);
  return {
    ok: true, action: 'mc_quest_patch', apply: true, changed: files.length > 0, changedCount: diff.length,
    files, diff, backup: backups.join('、'), lines,
  };
}

/** 新建任务。 */
async function questAdd(input) {
  const { questDir, store } = openQuests(input);
  const apply = input.apply === true;
  const plan = planAddQuest({
    questDir, store,
    chapter: input.chapter,
    title: input.title,
    subtitle: input.subtitle,
    description: input.description,
    dependsOn: input.dependsOn,
    taskItem: input.taskItem,
    taskCount: input.taskCount,
    rewardItem: input.rewardItem,
    rewardCount: input.rewardCount,
    x: input.x,
    y: input.y,
  });
  const lines = describeQuestPlan(plan, { apply });
  if (!apply) {
    dryRunNote(lines);
    return { ok: true, action: 'mc_quest_add', apply: false, changed: true, questId: plan.questId, files: plan.files, diff: plan.diff, backup: '', lines };
  }
  const done = commitQuestPlan({ plan, questDir, store });
  lines.push('', ...done.lines);
  return {
    ok: true, action: 'mc_quest_add', apply: true, changed: true, questId: plan.questId,
    files: plan.files, diff: plan.diff, backup: done.backups.join('、'), lines,
  };
}

/** 新建章节。 */
async function questChapter(input) {
  const { questDir, store } = openQuests(input);
  const apply = input.apply === true;
  const plan = planAddChapter({
    questDir, store,
    title: input.title,
    group: input.group,
    icon: input.icon,
    orderIndex: input.orderIndex,
  });
  const lines = describeQuestPlan(plan, { apply });
  if (!apply) {
    dryRunNote(lines);
    return { ok: true, action: 'mc_quest_chapter', apply: false, changed: true, chapterId: plan.chapterId, files: plan.files, diff: plan.diff, backup: '', lines };
  }
  const done = commitQuestPlan({ plan, questDir, store });
  lines.push('', ...done.lines);
  return {
    ok: true, action: 'mc_quest_chapter', apply: true, changed: true, chapterId: plan.chapterId,
    files: plan.files, diff: plan.diff, backup: done.backups.join('、'), lines,
  };
}

/** 挪动任务坐标。 */
async function questMove(input) {
  const { questDir, store } = openQuests(input);
  const apply = input.apply === true;
  let moves = input.moves;
  if (typeof moves === 'string') {
    try {
      moves = JSON.parse(moves);
    } catch (e) {
      throw new McError(`moves 不是合法 JSON：${e.message}`, 'moves 写成数组，或直接给 questId + x + y', 'MoveBadJson');
    }
  }
  if (!Array.isArray(moves) || !moves.length) {
    if (input.questId) {
      moves = [{ questId: input.questId, x: input.x, y: input.y }];
    } else {
      throw new McError('没给要挪的任务', '至少给一个 {questId, x, y}', 'MoveEmpty');
    }
  }
  const plan = planMoveQuests({ questDir, store, moves });
  const lines = describeMovePlan(plan, { apply });
  if (!apply) {
    dryRunNote(lines);
    return { ok: true, action: 'mc_quest_move', apply: false, changed: plan.changedCount > 0, movedCount: plan.changedCount, files: plan.files, diff: plan.diff, backup: '', lines };
  }
  const done = commitMovePlan({ plan, questDir, store });
  lines.push('', ...done.lines);
  return {
    ok: true, action: 'mc_quest_move', apply: true, changed: plan.changedCount > 0, movedCount: plan.changedCount,
    files: plan.files, diff: plan.diff, backup: done.backups.join('、'), lines,
  };
}

/** 删任务。 */
async function questRemove(input) {
  const { questDir, store } = openQuests(input);
  const apply = input.apply === true;
  const plan = planNodeDelete({ questDir, store, questId: input.questId });
  const lines = describeNodeDeletePlan(plan, { apply });
  if (!apply) {
    dryRunNote(lines);
    return {
      ok: true, action: 'mc_quest_remove', apply: false, changed: true, questId: plan.questId,
      dependents: plan.dependents.map((d) => `${d.title}（${d.id}）`),
      files: plan.files.map((f) => f.name), diff: plan.diff, backup: '', lines,
    };
  }
  const done = commitNodeDelete({ plan, questDir, store });
  lines.push('', ...done.lines);
  return {
    ok: true, action: 'mc_quest_remove', apply: true, changed: true, questId: plan.questId,
    dependents: plan.dependents.map((d) => `${d.title}（${d.id}）`),
    files: plan.files.map((f) => f.name), diff: plan.diff, backup: done.backups.join('、'), lines,
  };
}

/** 改图标 / 改依赖（只走节点这一层）。 */
async function questNode(input) {
  const { questDir, store } = openQuests(input);
  const apply = input.apply === true;
  const plan = planNodeEdit({
    questDir, store, questId: input.questId, icon: input.icon, dependencies: input.dependencies,
  });
  const lines = describeNodeEditPlan(plan, { apply });
  if (!apply) {
    dryRunNote(lines);
    return { ok: true, action: 'mc_quest_patch', apply: false, changed: plan.changedCount > 0, changedCount: plan.changedCount, files: plan.files.map((f) => f.name), diff: plan.diff, backup: '', lines };
  }
  const done = commitNodeEdit({ plan, questDir, store });
  lines.push('', ...done.lines);
  return {
    ok: true, action: 'mc_quest_patch', apply: true, changed: plan.changedCount > 0, changedCount: plan.changedCount,
    files: plan.files.map((f) => f.name), diff: plan.diff, backup: done.backups.join('、'), lines,
  };
}

/** 装饰图增删改。 */
async function questImage(input) {
  const { questDir, store } = openQuests(input);
  const apply = input.apply === true;
  const plan = planImageEdit({
    questDir, store,
    chapter: input.chapter,
    action: input.action,
    index: input.index,
    image: input.image,
    x: input.x, y: input.y, width: input.width, height: input.height, rotation: input.rotation,
  });
  const lines = describeImagePlan(plan, { apply });
  if (!apply) {
    dryRunNote(lines);
    return {
      ok: true, action: 'mc_quest_image', apply: false, changed: plan.changedCount > 0,
      chapterTitle: plan.chapterTitle, chapterFile: plan.chapterFile,
      files: plan.files.map((f) => f.name), diff: plan.diff, imageCount: 0, backup: '', lines,
    };
  }
  const done = commitImagePlan({ plan, questDir, store });
  const chapter = done.after?.chapters.find((c) => c.file === plan.chapterFile);
  lines.push('', ...done.lines);
  return {
    ok: true, action: 'mc_quest_image', apply: true, changed: plan.changedCount > 0,
    chapterTitle: plan.chapterTitle, chapterFile: plan.chapterFile,
    files: plan.files.map((f) => f.name), diff: plan.diff,
    imageCount: chapter?.images?.length ?? 0, backup: done.backups.join('、'), lines,
  };
}

/** KubeJS 脚本体检。 */
async function kubejsVerify(input) {
  const kubejsDir = resolveKubejsDir(input);
  const instance = instanceContext(input).instance;
  const knownItems = instance ? (id) => indexInstance(instance).has(id) : undefined;
  const report = verifyScripts(kubejsDir, {
    mcVersion: input.mcVersion,
    includeClient: input.includeClient,
    knownItems,
  });
  const b = report.breakdown ?? {};
  return {
    ok: true, action: 'mc_kubejs_verify',
    kubejsDir,
    scriptCount: report.scriptCount,
    okCount: b.ok ?? 0,
    syntaxErrorCount: b['syntax-error'] ?? 0,
    runtimeErrorCount: b['runtime-error'] ?? 0,
    declaredCount: report.declared.length,
    missingItemCount: report.missingItems.length,
    missingRecipeCount: report.missingRecipes.length,
    elapsedMs: report.elapsedMs,
    scripts: report.scripts,
    missingItems: report.missingItems,
    lines: describeVerify(report, Number(input.limit ?? 15) || 15),
  };
}

/** 生成 KubeJS 脚本（只算不写）。 */
async function kubejsPlan(input) {
  const kubejsDir = resolveKubejsDir(input);
  const remove = [
    ...(Array.isArray(input.removes) ? input.removes.map((id) => ({ id: String(id) })) : []),
    ...(Array.isArray(input.removeMods) ? input.removeMods.map((mod) => ({ mod: String(mod) })) : []),
  ];
  const spec = {
    remove,
    recipes: Array.isArray(input.recipes) ? input.recipes : [],
    header: `由 MC 整合包工作室生成（${new Date().toISOString().slice(0, 10)}）`,
  };
  const { code, summary } = generateScript(spec);
  const check = runScript(code, 'kubejs/server_scripts/preview.js');
  if (check.status !== 'ok') {
    throw new McError(`生成的脚本自己跑不起来：${check.error}`, '配方写法有问题', 'KubejsCodegenBroken');
  }
  const dest = targetFile(kubejsDir, input.fileName ?? 'dsh_magic');
  const warnings = [];
  if (fs.existsSync(dest)) warnings.push('已存在，apply 时会被覆盖（会自动备份）');

  const instance = instanceContext(input).instance;
  if (instance) {
    const idx = indexInstance(instance);
    let checked = 0;
    for (const r of spec.recipes) {
      for (const id of [r.output, ...(r.inputs ?? []), ...(r.keys ?? [])]) {
        if (!id || String(id).includes(':') === false) continue;
        checked += 1;
        if (!idx.has(String(id))) {
          warnings.push(`物品 ${id} 在这个包里不存在（生成的配方会在游戏里失效）`);
        }
      }
    }
    if (checked) warnings.push(`（已按这个包的 ${idx.itemCount} 个物品核对）`);
  }

  return {
    ok: true, action: 'mc_kubejs_plan',
    code, targetPath: dest, summary, warnings,
    lines: [
      `目标文件：${dest}`,
      `脚本长度：${code.length} 字符`,
      ...warnings.map((w) => `⚠️ ${w}`),
      '',
      '以上是演练结果，没有写任何文件。确认无误后加 apply=true 再跑一次。',
    ],
  };
}

/** 真的写 KubeJS 脚本（写完复验，不过就回滚）。 */
async function kubejsApply(input) {
  const kubejsDir = resolveKubejsDir(input);
  const dest = targetFile(kubejsDir, input.fileName ?? 'dsh_magic');
  const probe = checkWritable(path.dirname(dest));
  if (!probe.ok) {
    throw new McError(`目录写不了：${probe.error}`, '检查权限，或者换个目录', 'KubejsNotWritable');
  }
  const remove = [
    ...(Array.isArray(input.removes) ? input.removes.map((id) => ({ id: String(id) })) : []),
    ...(Array.isArray(input.removeMods) ? input.removeMods.map((mod) => ({ mod: String(mod) })) : []),
  ];
  const { code, summary } = generateScript({
    remove,
    recipes: Array.isArray(input.recipes) ? input.recipes : [],
    header: `由 MC 整合包工作室生成（${new Date().toISOString().slice(0, 10)}）`,
  });
  const { backups, done } = writeFiles([{ file: dest, content: code }], '写 KubeJS 脚本');
  const warnings = [];

  const check = runScript(code, `kubejs/server_scripts/${path.basename(dest)}`);
  if (check.status !== 'ok') {
    restoreFiles(done);
    throw new McError(`写完自检没过：${check.error}`, '已回滚，原文件没变', 'KubejsVerifyFailed');
  }

  const instance = instanceContext(input).instance;
  let verified = true;
  if (instance) {
    const idx = indexInstance(instance);
    const report = verifyScripts(kubejsDir, { mcVersion: input.mcVersion, knownItems: (id) => idx.has(id) });
    const broken = report.scripts.filter((s) => s.status !== 'ok');
    if (broken.length) {
      restoreFiles(done);
      throw new McError(`写完复验没过：${broken.length} 个脚本跑不起来`, '已回滚，原文件没变', 'KubejsVerifyFailed');
    }
    if (report.missingItems.length) {
      verified = false;
      warnings.push(`有 ${report.missingItems.length} 个物品在这个包里不存在`);
    }
  }

  return {
    ok: true, action: 'mc_kubejs_apply',
    targetPath: dest, backup: backups[0] ?? '', summary, verified, warnings,
    lines: [
      `已写入：${dest}`,
      backups.length ? `备份：${backups.join('、')}` : '',
      ...warnings.map((w) => `⚠️ ${w}`),
    ].filter(Boolean),
  };
}

/** 配方检索的公共准备。 */
function prepareRecipes(input) {
  const instance = resolveInstance(input.instanceDir, input.instanceId ?? '');
  const loaded = loadRecipes(instance, { includeClientJar: input.includeVanilla !== false });
  return { instance, graph: buildGraph(loaded.recipes), recipeCount: loaded.recipes.length };
}

/** 找配方。 */
async function recipeFind(input) {
  const { graph, recipeCount } = prepareRecipes(input);
  const output = String(input.output ?? '').trim();
  const asInput = String(input.input ?? '').trim();
  const namespace = String(input.namespace ?? '').trim();
  const keyword = String(input.keyword ?? '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(input.limit ?? 30) || 30, 200));

  const hits = graph.byId.values().filter((r) => {
    if (output && !r.outputs.includes(output)) return false;
    if (asInput && !r.inputs.includes(asInput)) return false;
    if (namespace && r.namespace !== namespace) return false;
    if (keyword && !r.id.toLowerCase().includes(keyword)) return false;
    return true;
  }).slice(0, limit);

  const lines = hits.map((r) => `${r.id}  [${r.type}]  → ${r.outputs.join('、')}`);
  if (!hits.length && output) {
    const producers = graph.producersOf(output);
    lines.push(producers.length
      ? `它确实有 ${producers.length} 条产出配方（被 limit 或过滤条件挡掉了）`
      : '这个物品在当前索引里没有任何产出配方（可能是原版硬编码、只能靠掉落/交易，或者是 KubeJS 脚本加的）');
  }
  return {
    ok: true, action: 'mc_recipe_find',
    recipeCount, shown: hits.length,
    recipes: hits.map((r) => ({ id: r.id, type: r.type, outputs: r.outputs, inputs: r.inputs, tags: r.tags, jar: r.jar })),
    lines,
  };
}

/** 某物品的获取路径。 */
async function recipePath(input) {
  const { graph } = prepareRecipes(input);
  const item = String(input.item ?? '').trim();
  if (!item) {
    throw new McError('没给物品 ID', '给 item，比如 create:cogwheel', 'McBadArgs');
  }
  const depth = Math.max(1, Math.min(Number(input.depth ?? 3) || 3, 8));
  const result = pathsTo(graph, item, { depth });
  return {
    ok: true, action: 'mc_recipe_path',
    item: result.item,
    levelCount: result.levels.length,
    truncated: result.truncated,
    levels: result.levels.map((row, i) => ({ depth: i + 1, options: row.map((o) => ({ recipe: o.recipe, type: o.type, from: o.from, jar: o.jar })) })),
    lines: result.levels.flatMap((row, i) => row.map((o) => `第 ${i + 1} 层：${o.recipe}（${o.type}）吃 ${o.from.join('、')}`)),
  };
}

/** 谁在用这个物品。 */
async function recipeUses(input) {
  const { graph } = prepareRecipes(input);
  const item = String(input.item ?? '').trim();
  if (!item) {
    throw new McError('没给物品 ID', '给 item', 'McBadArgs');
  }
  const limit = Math.max(1, Math.min(Number(input.limit ?? 20) || 20, 200));
  const result = usesOf(graph, item);
  const byType = new Map();
  for (const r of result.recipes) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  return {
    ok: true, action: 'mc_recipe_uses',
    item: result.item,
    count: result.count,
    byType: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    recipes: result.recipes.slice(0, limit).map((r) => ({ id: r.id, type: r.type, outputs: r.outputs, jar: r.jar })),
    lines: result.recipes.slice(0, limit).map((r) => `${r.id}  [${r.type}]`),
  };
}

/** 删掉某些配方会断掉什么。 */
async function recipeImpact(input) {
  const { graph } = prepareRecipes(input);
  const targets = new Set();
  for (const id of input.removeRecipes ?? []) targets.add(String(id));
  const removeMod = String(input.removeMod ?? '').trim();
  if (removeMod) {
    for (const r of graph.byId.values()) {
      if (r.namespace === removeMod) targets.add(r.id);
    }
  }
  for (const out of input.removeOutput ?? []) {
    for (const r of graph.producersOf(String(out))) targets.add(r.id);
  }
  if (!targets.size) {
    return {
      ok: false, action: 'mc_recipe_impact',
      error: '没有指定要删什么',
      hint: '给 removeRecipes（配方 ID）、removeMod（模组名）或 removeOutput（物品 ID）之一',
      lines: ['没有指定要删什么。'],
    };
  }
  const limit = Math.max(1, Math.min(Number(input.limit ?? 50) || 50, 500));
  const result = findBreaks(graph, [...targets], { limit });
  return {
    ok: true, action: 'mc_recipe_impact',
    removedCount: result.removedCount,
    brokenCount: result.broken.length,
    criticalCount: result.critical.length,
    broken: result.broken.map((b) => ({ item: b.item, lostRecipes: b.lostRecipes, usedBy: b.usedBy })),
    suggestion: '给断路的物品补配方，或者少删几条',
    lines: result.broken.map((b) => `${b.item}：失去 ${b.lostRecipes.length} 条产出配方，${b.usedBy} 个配方还在用它`),
  };
}

/** mod 撞车报告。 */
async function overlapReport(input) {
  const instance = resolveInstance(input.instanceDir, input.instanceId ?? '');
  const idx = indexInstance(instance, { includeClientJar: false });
  const collisions = sameNameCollisions(idx._items, Math.max(2, Number(input.minNamespaces ?? 2) || 2));
  const families = familyCoverage(idx._items, Math.max(1, Number(input.minItems ?? 5) || 5));
  const limit = Math.max(1, Math.min(Number(input.limit ?? 20) || 20, 100));
  return {
    ok: true, action: 'mc_overlap_report',
    collisionCount: collisions.length,
    collisions: collisions.map((c) => ({ path: c.path, namespaces: c.namespaces, count: c.count })),
    families,
    crowdedFamilies: families.filter((f) => f.crowded).length,
    emptyFamilies: families.filter((f) => f.modCount === 0).length,
    lines: describeOverlap(collisions, families, limit),
  };
}

/** 进度曲线。 */
async function progressionCheck(input) {
  const { graph } = prepareRecipes(input);
  const maxDepth = Math.max(1, Math.min(Number(input.maxDepth ?? 6) || 6, 12));
  const curve = progressCurve(graph, { maxDepth });
  return {
    ok: true, action: 'mc_progression_check',
    knownItems: curve.knownItems,
    unknownItems: curve.unknownItems,
    widestDepth: curve.widestDepth,
    widestItems: curve.widestItems,
    concentration: Math.round(curve.concentration * 10000) / 10000,
    buckets: curve.buckets,
    lines: describeProgress(curve),
  };
}

/** 导出计划。 */
async function exportPlan(input) {
  const instance = resolveInstance(input.instanceDir, input.instanceId ?? '');
  const plan = planExport(instance, {
    mode: input.mode ?? 'offline',
    packName: input.packName,
    includeSaves: input.includeSaves,
    includeLibraries: input.includeLibraries,
    includeAssets: input.includeAssets,
    includeRuntime: input.includeRuntime,
    pclExe: input.pclExe,
  });
  const warnings = [...plan.warnings];
  if (plan.mode === 'launcher') {
    if (!input.pclExe) warnings.push('launcher 形态还没给 pclExe，打包会失败。');
    else warnings.push(`PCL 本体检查：${looksLikePcl(input.pclExe) ? '通过' : '不通过'}`);
  }
  const byDir = new Map();
  for (const e of plan.entries) {
    const dir = e.name.includes('/') ? e.name.split('/')[0] : '(根目录)';
    const cur = byDir.get(dir) ?? { dir, files: 0, bytes: 0 };
    cur.files += 1;
    cur.bytes += e.size ?? 0;
    byDir.set(dir, cur);
  }
  return {
    ok: true, action: 'mc_export_plan',
    mode: plan.mode,
    packName: plan.packName,
    fileCount: plan.fileCount,
    totalBytes: plan.totalBytes,
    totalText: fmtSize(plan.totalBytes),
    suggestZip: plan.suggestZip,
    warnings,
    topDirs: [...byDir.values()].sort((a, b) => b.bytes - a.bytes),
    lines: [
      `导出形态：${plan.mode}，共 ${plan.fileCount} 个文件（${fmtSize(plan.totalBytes)}）`,
      ...warnings.map((w) => `⚠️ ${w}`),
    ],
  };
}

/** 真的导出。 */
async function exportBuild(input) {
  const mode = String(input.mode ?? 'offline').toLowerCase();
  if (!EXPORT_MODES.includes(mode)) {
    return {
      ok: false, action: 'mc_export_build',
      error: `不认识的形态：${mode}`,
      hint: `可选：${EXPORT_MODES.join(' / ')}`,
      lines: [`不认识的形态：${mode}`],
    };
  }
  const instance = resolveInstance(input.instanceDir, input.instanceId ?? '');
  const result = await buildExport(instance, {
    mode,
    packName: input.packName,
    outFile: input.outFile,
    includeSaves: input.includeSaves,
    includeLibraries: input.includeLibraries,
    includeAssets: input.includeAssets,
    includeRuntime: input.includeRuntime,
    pclExe: input.pclExe,
  });
  return {
    ok: true, action: 'mc_export_build',
    mode,
    outFile: result.outFile,
    bytes: result.bytes,
    bytesText: fmtSize(result.bytes),
    entries: result.entries,
    checkOk: result.check?.ok ?? false,
    checkItems: result.check?.items ?? [],
    warnings: result.plan?.warnings ?? [],
    lines: [
      `已导出：${result.outFile}（${fmtSize(result.bytes)}，${result.entries?.length ?? 0} 项）`,
      ...(result.plan?.warnings ?? []).map((w) => `⚠️ ${w}`),
    ],
  };
}

/** 启动验证（默认 dry-run）。 */
async function launchTest(input) {
  const p = planLaunch({
    instanceDir: input.instanceDir,
    mcRoot: input.mcRoot,
    javaPath: input.javaPath,
    username: input.username,
  });
  const lines = describeLaunchPlan(p);
  const dryRun = input.apply !== true;
  const fullCmd = p.argv.length ? renderCommand(p.argv) : '(无 java，无法组装命令行)';
  const CMD_LIMIT = 4000;
  const truncated = fullCmd.length > CMD_LIMIT;
  const shownCmd = truncated ? `${fullCmd.slice(0, CMD_LIMIT)}… （共 ${fullCmd.length} 字符，已截断）` : fullCmd;

  const base = {
    ok: true, action: 'mc_launch_test',
    instanceDir: p.instanceDir, versionId: p.versionId, mainClass: p.mainClass, dryRun,
    java: p.java
      ? { path: p.java.path, version: p.java.version, major: p.java.major, source: p.java.source, warning: p.java.warning ?? '' }
      : { path: '', version: '', major: 0, source: '', warning: '未找到可用 Java' },
    requiredJavaMajor: p.requiredMajor,
    libraries: {
      total: p.stats.total,
      skippedByRules: p.stats.skippedByRules,
      duplicateArtifact: p.stats.duplicateArtifact,
      nativesTotal: p.stats.nativesTotal,
      nativesSelected: p.stats.nativesSelected,
      nativesSkipped: p.stats.nativesSkipped,
      missing: p.stats.missing,
      byClassifier: Object.entries(p.nativesByClassifier).sort().map(([k, v]) => `${k}=${v}`).join(' / '),
    },
    classpath: { libs: p.classpathLibs, entries: p.classpath.length, chars: p.classpathChars, hasClientJar: p.hasClientJar },
    natives: { wanted: p.nativesWanted, count: p.natives.length, dir: p.nativesDir, extracted: 0, missingJars: 0 },
    jvmArgCount: p.jvmArgs.length,
    gameArgCount: p.gameArgs.length,
    missingVars: p.missingVars,
    command: shownCmd,
    commandTruncated: truncated,
    result: { status: '', summary: '', durationMs: 0, exitCode: -1, signal: '', evidence: '', evidenceKind: '', suspects: [], newCrashReports: [], logTail: [], logFile: '' },
  };

  if (dryRun) {
    lines.push('');
    lines.push('── dry-run：未启动任何进程 ──');
    lines.push('命令行：');
    lines.push(shownCmd);
    lines.push('');
    lines.push('要真启动，加 apply: true。');
    base.result.summary = 'dry-run，未启动';
    base.lines = lines;
    return base;
  }

  if (p.stats.missing.length) {
    throw new McError(
      `有 ${p.stats.missing.length} 个库文件不在磁盘上（${p.stats.missing.slice(0, 3).join(', ')}）`,
      '先用启动器把该实例跑一次让库下全，或确认 mcRoot 指向正确的 Minecraft 根目录',
    );
  }
  if (!p.hasClientJar) {
    throw new McError(`找不到客户端 jar：${p.clientJar}`, '缺失时先从启动器补齐再试');
  }

  lines.push('');
  lines.push(`── 真启动（超时 ${(input.timeoutMs ?? 600000) / 1000}s）──`);
  const r = await launch(p, { timeoutMs: input.timeoutMs });
  const tailLines = Number(input.logTailLines ?? 20);
  const tail = r.tail.split(/\r?\n/).filter((l) => l.trim()).slice(-tailLines);

  base.natives.extracted = r.natives?.files?.length ?? 0;
  base.natives.missingJars = r.natives?.missingJars ?? 0;
  base.ok = r.verdict.status === 'ok';
  base.code = base.ok ? '' : `McLaunch${r.verdict.status}`;
  if (!base.ok) base.error = r.verdict.summary;
  if (!base.ok) base.hint = r.verdict.suspects.join('；');
  base.result = {
    status: r.verdict.status,
    summary: r.verdict.summary,
    durationMs: r.durationMs,
    exitCode: r.exitCode === null ? -1 : r.exitCode,
    signal: r.signal ?? '',
    evidence: r.evidence,
    evidenceKind: r.evidenceKind,
    suspects: r.verdict.suspects,
    newCrashReports: r.newCrashReports,
    logTail: tail,
    logFile: r.logFile,
  };
  lines.push(`结论：${r.verdict.summary}`);
  if (r.verdict.suspects.length) lines.push(`归因方向：${r.verdict.suspects.join('；')}`);
  lines.push(`日志尾部 ${tail.length} 行：`);
  lines.push(...tail.map((l) => `  ${l}`));
  base.lines = lines;
  return base;
}

/** 联网搜 mod。 */
async function modSearch(input) {
  const context = instanceContext(input);
  const gameVersion = String(input.gameVersion || context.gameVersion || '').trim();
  const loader = String(input.loader || context.loader || '').trim();
  const source = String(input.source ?? 'modrinth').toLowerCase();
  const query = String(input.query ?? '').trim();
  const limit = Math.max(1, Math.min(Number(input.limit ?? 8) || 8, 30));
  const sort = String(input.sort ?? 'relevance').toLowerCase();

  if (!query) {
    return { ok: false, action: 'mc_mod_search', error: '没给搜索词', hint: '比如 query: "create"', lines: ['没给搜索词，比如 query: "create"'] };
  }
  const net = readNetOptionsFromEnv();
  if (source === 'curseforge' && !net.curseforgeKey) {
    return {
      ok: false, action: 'mc_mod_search',
      error: 'CurseForge 需要 API Key，但没配置',
      hint: '不配也能用：去掉 source 就走 Modrinth（不需要 key，绝大多数 mod 都在上面）。',
      lines: ['CurseForge 需要 API Key，现在没配置。', '不配也能用：不加 source 就走 Modrinth。'],
    };
  }

  const http = createHttp({ ...net, timeoutMs: 20_000 });
  const url = source === 'curseforge'
    ? cfSearchUrl({ query, gameVersion, loader, limit, sort: sort === 'relevance' ? 'follows' : sort, classId: CF_CLASS_ID.mod })
    : mrSearchUrl({ query, gameVersion, loader, limit, sort });

  let parsed;
  try {
    const json = await http.json(url);
    parsed = source === 'curseforge' ? parseCfSearchMini(json) : parseMrSearch(json);
  } catch (error) {
    if (isNetworkFailure(error)) {
      const friendly = describeNetworkFailure(error);
      return {
        ok: false, action: 'mc_mod_search',
        error: friendly.message,
        hint: '现在连不上。可以重试一次，或直接把 jar 手动放进 <整合包>/mods 目录。',
        lines: [`搜不了：${friendly.message}`, '下一步：重试一次；还是不行就手动下载 jar 放进 mods 目录。'],
      };
    }
    throw error;
  }

  const results = rankCandidates(parsed.results).slice(0, limit);
  const lines = [];
  if (!results.length) {
    lines.push(`没搜到「${query}」${gameVersion || loader ? `（${[gameVersion, loader].filter(Boolean).join(' / ')}）` : ''}。`);
    lines.push('可以换个词（用英文名），或者放宽版本/加载器。');
  } else {
    lines.push(`在 ${source === 'curseforge' ? 'CurseForge' : 'Modrinth'} 搜到 ${parsed.total} 个，前 ${results.length} 个：`);
    for (const item of results) {
      const meta = [formatDownloads(item.downloads), item.versions.slice(0, 3).join('/'), item.loaders.join('/')].filter(Boolean).join(' · ');
      lines.push(`- ${item.title}（${item.slug || item.projectId}）${item.description ? `：${item.description}` : ''}`);
      lines.push(`  ${meta}`);
    }
  }
  const first = results[0];
  return {
    ok: true, action: 'mc_mod_search',
    source, query, gameVersion, loader,
    total: parsed.total,
    results: results.map((item) => ({ ...item, downloadsText: formatDownloads(item.downloads) })),
    installHint: first ? `要装就调 mc_mod_install：projects: ["${first.slug || first.projectId}"]，默认只算清单，apply:true 才下载。` : '',
    lines,
  };
}

/** 装 mod（默认只算清单）。 */
async function modInstall(input) {
  const context = instanceContext(input);
  if (!context.instance) {
    return { ok: false, action: 'mc_mod_install', error: '没指定整合包', hint: '给 instanceDir', lines: ['没指定整合包。'] };
  }
  const requested = Array.isArray(input.projects)
    ? input.projects.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
  if (!requested.length) {
    return {
      ok: false, action: 'mc_mod_install',
      error: '没说要装哪个 mod',
      hint: '先用 mc_mod_search 搜，再把工程 ID 或 slug 放进 projects，例如 ["create"]',
      lines: ['没说要装哪个 mod。先用 mc_mod_search 搜，再把工程 ID 或 slug 放进 projects。'],
    };
  }
  const gameVersion = String(input.gameVersion || context.gameVersion || '').trim();
  const loader = String(input.loader || context.loader || '').trim();
  const channel = String(input.channel ?? 'release').toLowerCase();
  const modsDir = context.instance.modsDir;
  // 下载目录：不给就下进实例的 mods 目录，给了就下到那个目录（前置也跟着一块儿下过去）。
  const targetDir = String(input.targetDir ?? '').trim();
  const downloadDir = targetDir ? path.resolve(targetDir) : modsDir;
  const net = readNetOptionsFromEnv();
  const http = createHttp(net);

  const plan = await buildInstallPlan({
    http, modsDir, targetDir: downloadDir, requests: requested, gameVersion, loader, channel,
    withDeps: input.withDeps !== false,
  });

  const lines = [`目标：${downloadDir}（实例 mods 目录现有 ${plan.installedCount} 个 jar）`, '', ...describeInstallPlan(plan)];
  const items = plan.items.map((item) => ({
    title: item.title, projectId: item.projectId, versionNumber: item.versionNumber,
    fileName: item.fileName, size: item.size, reason: item.reason,
    dependencyOf: item.dependencyOf, pageUrl: item.pageUrl,
  }));

  if (input.apply !== true) {
    lines.push('', '这是「只算不写」的清单。确认没问题就再调一次并加 apply:true，我才真下载。');
    return {
      ok: true, action: 'mc_mod_install', applied: false, modsDir, targetDir: downloadDir,
      itemCount: plan.items.length, totalBytes: plan.totalBytes, totalText: formatSize(plan.totalBytes),
      items, skipped: plan.skippedExisting, unresolved: plan.unresolved,
      compat: plan.compat ?? null, lines,
    };
  }
  if (!plan.items.length) {
    lines.push('', '没有要下的文件，就不再动了。');
    return {
      ok: plan.unresolved.length === 0, action: 'mc_mod_install', applied: false, modsDir, targetDir: downloadDir,
      itemCount: 0, totalBytes: 0, totalText: '0 B', items: [],
      skipped: plan.skippedExisting, unresolved: plan.unresolved,
      compat: plan.compat ?? null, lines,
    };
  }
  const result = await applyInstallPlan({ http, plan, modsDir: downloadDir });
  lines.push('', ...describeInstallResult(result));
  return {
    ok: result.failed.length === 0, action: 'mc_mod_install', applied: true, modsDir, targetDir: downloadDir,
    itemCount: plan.items.length, totalBytes: plan.totalBytes, totalText: formatSize(plan.totalBytes),
    items, installed: result.installed, failed: result.failed,
    skipped: [...plan.skippedExisting, ...result.skipped], unresolved: plan.unresolved,
    compat: plan.compat ?? null, lines,
  };
}

/** 从模板建新包。 */
async function packCreate(input) {
  const apply = input.apply === true;
  const plan = buildPackPlan({
    mcRoot: input.mcRoot,
    name: input.name,
    templateDir: input.templateDir,
    templateId: input.templateId,
    withQuestBook: input.withQuestBook,
    withKubejs: input.withKubejs,
  });
  if (!apply) {
    return {
      ok: true, action: 'mc_pack_create', applied: false,
      name: plan.name, targetDir: plan.targetDir, versionsDir: plan.versionsDir,
      templateId: plan.template.id, mcVersion: plan.template.mcVersion,
      loader: plan.template.loader, loaderVersion: plan.template.loaderVersion,
      dirCount: plan.dirs.length, fileCount: plan.files.length,
      totalBytes: plan.totalBytes, totalText: fmtSize(plan.totalBytes),
      warnings: plan.warnings, lines: describePackPlan(plan),
    };
  }
  const result = applyPackPlan(plan);
  return {
    ok: true, action: 'mc_pack_create', applied: true,
    name: plan.name, targetDir: plan.targetDir, versionsDir: plan.versionsDir,
    templateId: plan.template.id, mcVersion: plan.template.mcVersion,
    loader: plan.template.loader, loaderVersion: plan.template.loaderVersion,
    dirCount: plan.dirs.length, fileCount: plan.files.length,
    totalBytes: plan.totalBytes, totalText: fmtSize(plan.totalBytes),
    warnings: plan.warnings,
    createdDirs: result.created?.dirs?.length ?? 0,
    createdFiles: result.created?.files?.length ?? 0,
    lines: describePackResult(result, plan),
  };
}

/** 从零装一个包（要联网）。 */
async function packScaffold(input) {
  const apply = input.apply === true;
  const net = readNetOptionsFromEnv();
  const http = createHttp(net);
  const plan = await planScaffold({
    http,
    mcRoot: input.mcRoot,
    name: input.name,
    mcVersion: input.mcVersion,
    loader: input.loader,
    loaderVersion: input.loaderVersion,
    mirrorMode: input.mirrorMode,
    javaPath: input.javaPath,
  });
  if (!apply) {
    return {
      ok: true, action: 'mc_pack_scaffold', applied: false,
      name: plan.name, targetDir: plan.instanceDir, targetText: plan.targetText,
      mcVersion: plan.mcVersion, loader: plan.loader, loaderVersion: plan.loaderVersion,
      fileCount: plan.counts?.totalFiles ?? 0,
      totalBytes: plan.bytes?.total ?? 0, totalText: fmtSize(plan.bytes?.total ?? 0),
      javaText: plan.java?.version ?? '', steps: plan.steps,
      warnings: plan.warnings, lines: describeScaffold(plan),
    };
  }
  const result = await applyScaffold({
    http,
    mcRoot: input.mcRoot,
    name: input.name,
    mcVersion: input.mcVersion,
    loader: input.loader,
    loaderVersion: input.loaderVersion,
    mirrorMode: input.mirrorMode,
    javaPath: input.javaPath,
  });
  return {
    ok: true, action: 'mc_pack_scaffold', applied: true,
    name: result.name, targetDir: result.instanceDir, targetText: result.name,
    mcVersion: plan.mcVersion, loader: plan.loader, loaderVersion: plan.loaderVersion,
    fileCount: plan.counts?.totalFiles ?? 0,
    totalBytes: plan.bytes?.total ?? 0, totalText: fmtSize(plan.bytes?.total ?? 0),
    javaText: result.java?.version ?? '', steps: plan.steps,
    warnings: plan.warnings, seconds: result.seconds, lines: describeScaffold(plan),
  };
}

// ————————————————————————— 能力表 —————————————————————————

const CAPABILITIES = {
  mc_instance_info: instanceInfo,
  mc_instance_list: instanceList,
  mc_mod_list: modList,
  mc_item_search: itemSearch,
  mc_mod_inspect: modInspect,

  mc_quest_list: questList,
  mc_quest_show: questShow,
  mc_quest_search: questSearch,
  mc_quest_lint: questLint,
  mc_quest_patch: questPatch,
  mc_quest_add: questAdd,
  mc_quest_chapter: questChapter,
  mc_quest_move: questMove,
  mc_quest_remove: questRemove,
  mc_quest_node: questNode,
  mc_quest_image: questImage,

  mc_kubejs_verify: kubejsVerify,
  mc_kubejs_plan: kubejsPlan,
  mc_kubejs_apply: kubejsApply,

  mc_recipe_find: recipeFind,
  mc_recipe_path: recipePath,
  mc_recipe_uses: recipeUses,
  mc_recipe_impact: recipeImpact,

  mc_overlap_report: overlapReport,
  mc_progression_check: progressionCheck,

  mc_export_plan: exportPlan,
  mc_export_build: exportBuild,
  mc_launch_test: launchTest,

  mc_mod_search: modSearch,
  mc_mod_install: modInstall,

  mc_pack_create: packCreate,
  mc_pack_scaffold: packScaffold,
};

// ————————————————————————— 入口 —————————————————————————

const [, , toolName, argsFile] = process.argv;
const fn = CAPABILITIES[toolName];
if (!fn) {
  console.error(`未知能力：${toolName}；可用：${Object.keys(CAPABILITIES).join(', ')}`);
  process.exit(1);
}
const args = argsFile ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : {};
const value = await guarded(toolName, () => fn(args));
console.log(JSON.stringify(value, null, 2));
