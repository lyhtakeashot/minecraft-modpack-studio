/**
 * 任务书节点「右键编辑」的算与写：换图标、接/断前置依赖、删掉任务。
 *
 * 为什么单独开一个文件：改标题/副标题/坐标已经有链路（`lib/host/quest-api.js` 的
 * buildQuestPlan → /quest/preview → /quest/apply），这里只补用户真正缺的三件事。
 * 图标和依赖都写在章节文件的 quest 块里，所以两条改动必须叠在同一个 source 上，
 * 不能各算一遍各写一遍文件 —— 否则后写的那次会把先写的覆盖掉。
 *
 * 节奏和新建任务一致：plan 只算不写，commit 才落盘，写完立刻重读 + 体检，
 * 出现新错误就整体回滚。面板右键和模型用工具改，都走这几个函数。
 */
import path from 'node:path';

import { McError } from './errors.js';
import { loadQuests, patchQuestFields, removeQuest } from './quests.js';
import { newErrorsOf, restoreFiles, writeFiles } from './quest-create.js';

/**
 * 物品 ID 长什么样：`create:cogwheel`、`minecraft:stone`、`ftbquests:block/barrier`。
 * 只认小写（Minecraft 的资源 ID 本来就是小写），大写直接当输入错误顶回去，
 * 免得写进文件之后游戏里认不出来、又没有任何报错。
 */
const ITEM_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** 一次最多挂多少个前置依赖。手抖贴一长串时先在写盘前提醒。 */
const MAX_DEPENDENCIES = 200;

/** 去重、去空白，保留第一次出现的顺序。 */
function cleanIdList(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const id = String(item ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 把界面 / 工具给的 `dependencies` 解析成字符串数组。
 *
 * 面板传的是 JSON 字符串（`'["AB12"]'`），模型可能传数组、也可能传逗号分隔的一串，
 * 三种都认。**没给返回 undefined**（= 不改），给空数组返回 `[]`（= 清空）——
 * 这两件事在界面上是两种操作，不能糊成一样。
 */
export function parseDependencies(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return cleanIdList(value);
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (raw.startsWith('[')) {
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      throw new McError(
        `前置依赖不是合法的 JSON 数组：${raw}`,
        '写成 ["AB12CD34","EF56"] 这样；要清空就写 []',
        'QuestBadDependency',
      );
    }
    if (!Array.isArray(list)) {
      throw new McError(
        `前置依赖不是数组：${raw}`,
        '写成 ["AB12CD34","EF56"] 这样；要清空就写 []',
        'QuestBadDependency',
      );
    }
    return cleanIdList(list);
  }
  return cleanIdList(raw.split(','));
}

/** 任务在文件里当前写的图标（没写就是空串，不算「用第一个物品顶替」那个默认值）。 */
function rawIconOf(quest) {
  return typeof quest.raw?.icon?.id === 'string' ? quest.raw.icon.id : '';
}

/** 任务在文件里当前写的前置依赖。 */
function rawDependenciesOf(quest) {
  const deps = quest.raw?.dependencies;
  return Array.isArray(deps) ? deps.map(String) : [];
}

/** 两个 ID 列表内容是否一致（顺序也算）。 */
function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 算一份「改图标 / 改前置依赖」的计划，不写盘。
 *
 * 两个都没给（或给的都跟原来一样）时返回空计划：`changes: []`、`writes: []`，
 * 不抛错 —— 界面那边会把「没有任何改动」原样显示给用户。
 *
 * @param {{questDir: string, store: object, questId: string,
 *   icon?: string, dependencies?: string[]|string}} args
 */
export function planNodeEdit({ questDir, store, questId, icon, dependencies }) {
  const id = String(questId ?? '').trim();
  if (!id) throw new McError('没给要改的任务 ID', '给 questId（16 位十六进制）', 'QuestNoId');

  const quest = store.questsById.get(id);
  if (!quest) {
    throw new McError(
      `这本书里没有任务 ${id}`,
      '先刷新一下画布，可能这任务刚被别处删了',
      'QuestNotFound',
    );
  }
  const chapter = store.chapters.find((c) => c.file === quest.chapterFile);
  if (!chapter) throw new McError(`找不到章节文件 ${quest.chapterFile}`, '', 'QuestNoChapter');

  // 图标：只支持设置 / 替换。空串 = 不改（不是「删掉图标」），删除图标请直接改文件
  const iconWanted = icon === undefined || icon === null ? '' : String(icon).trim();
  if (iconWanted && !ITEM_ID_RE.test(iconWanted)) {
    throw new McError(
      `图标物品 ID 不像个物品：${iconWanted}`,
      '形如 create:cogwheel（小写、带命名空间冒号）',
      'QuestBadItemId',
    );
  }

  const depsWanted = parseDependencies(dependencies);
  if (depsWanted) {
    if (depsWanted.length > MAX_DEPENDENCIES) {
      throw new McError(
        `一次最多设 ${MAX_DEPENDENCIES} 个前置依赖，这次给了 ${depsWanted.length} 个`,
        '用几个中间任务把它们串起来，别全挂在同一个节点上',
        'QuestDepTooMany',
      );
    }
    if (depsWanted.includes(id)) {
      throw new McError(
        `任务不能依赖自己：${id}`,
        '选别的任务当前置；想拆掉依赖就直接清空',
        'QuestDepSelf',
      );
    }
    const missing = depsWanted.filter((dep) => !store.questsById.has(dep));
    if (missing.length) {
      throw new McError(
        `前置依赖里有这本书不存在的任务：${missing.join('、')}`,
        '先用 mc_quest_search 确认任务 ID，依赖不存在的任务在游戏里会永远锁着',
        'QuestDepMissing',
      );
    }
  }

  const beforeIcon = rawIconOf(quest);
  const beforeDeps = rawDependenciesOf(quest);

  const changes = [];
  const diff = [];
  const fields = {};

  if (iconWanted && iconWanted !== beforeIcon) {
    fields.icon = { id: iconWanted };
    changes.push({ field: 'icon', label: '图标', before: beforeIcon, after: iconWanted });
    // 没写 icon 的任务，游戏里会拿第一个物品任务的物品当图标 —— 说清楚，别让人以为改丢了
    const fallback = beforeIcon ? '' : (quest.icon || '');
    const from = beforeIcon || (fallback ? `（没设置，默认用 ${fallback}）` : '（无）');
    diff.push(`图标：${from} → ${iconWanted}`);
  }

  if (depsWanted && !sameList(depsWanted, beforeDeps)) {
    fields.dependencies = depsWanted;
    changes.push({ field: 'dependencies', label: '前置依赖', before: beforeDeps, after: depsWanted });
    const added = depsWanted.filter((dep) => !beforeDeps.includes(dep));
    const removed = beforeDeps.filter((dep) => !depsWanted.includes(dep));
    let detail = '';
    if (!depsWanted.length) {
      detail = '（全部清空）';
    } else {
      const parts = [];
      if (added.length) parts.push(`新增 ${added.join('、')}`);
      if (removed.length) parts.push(`去掉 ${removed.join('、')}`);
      if (parts.length) detail = `（${parts.join('；')}）`;
    }
    diff.push(`前置依赖：${beforeDeps.length} 个 → ${depsWanted.length} 个${detail}`);
  }

  const writes = [];
  if (changes.length) {
    const rel = `chapters/${chapter.file}`;
    const result = patchQuestFields(chapter.source, id, fields, rel);
    // 解析层说「没变」就老实认：宁可返回空计划，也不要写一遍内容一样的文件、白留备份
    if (result.changed) writes.push({ file: chapter.path, content: result.source });
  }

  const effective = writes.length ? changes : [];

  return {
    kind: 'node-edit',
    questId: id,
    questTitle: quest.title,
    changedCount: effective.length,
    changes: effective,
    diff: writes.length ? diff : [],
    warnings: [],
    files: writes.map((w) => ({
      name: `chapters/${path.basename(w.file)}`,
      path: w.file,
      bytes: Buffer.byteLength(w.content, 'utf8'),
    })),
    writes,
    locale: store.locale,
  };
}

/**
 * 真写盘 + 立刻复查（改图标 / 改依赖）。
 * 写完读不回来、或者体检出现新错误，就把这次写的文件整体还原。
 */
export function commitNodeEdit({ plan, questDir, store }) {
  if (!plan.writes.length) {
    return { backups: [], lines: ['没有任何改动，什么都没写'] };
  }
  const { backups, done } = writeFiles(plan.writes);

  let after;
  try {
    after = loadQuests(questDir, { locale: plan.locale });
  } catch (e) {
    restoreFiles(done);
    throw new McError(`写完读不回来了：${e.message}`, '已回滚，原文件没变', 'QuestBrokenAfterWrite');
  }
  const newErrors = newErrorsOf(store, after);
  if (newErrors.length) {
    restoreFiles(done);
    const detail = newErrors.slice(0, 3).map((e) => `${e.where}：${e.message}`).join('；');
    throw new McError('这次改动会让任务书出问题，已全部回滚', detail, 'QuestNodeRejected');
  }

  return {
    backups,
    after,
    lines: [
      `已改 ${plan.changedCount} 处「${plan.questTitle}」（${plan.questId}），写了 ${plan.writes.length} 个章节文件`
        + (backups.length ? `，备份：${backups.join('、')}` : ''),
      `复查：${after.chapters.length} 个章节 / ${after.quests.length} 个任务，0 个新错误，正常`,
    ],
  };
}

/**
 * 算一份「删掉这个任务」的计划：连它下游对它的依赖一起断掉，不写盘。
 *
 * 为什么要一并断依赖：FTB 里依赖一个不存在的任务，这个任务会**永远锁着**。
 * 删节点的人想的是「这一格不要了」，不是「把下游全废掉」。
 */
export function planNodeDelete({ questDir, store, questId }) {
  const id = String(questId ?? '').trim();
  if (!id) throw new McError('没给要删的任务 ID', '给 questId（16 位十六进制）', 'QuestNoId');

  const quest = store.questsById.get(id);
  if (!quest) {
    throw new McError(
      `这本书里没有任务 ${id}`,
      '先用 mc_quest_search 确认 ID，可能它刚被别处删了',
      'QuestNotFound',
    );
  }
  const chapter = store.chapters.find((c) => c.file === quest.chapterFile);
  if (!chapter) throw new McError(`找不到章节文件 ${quest.chapterFile}`, '', 'QuestNoChapter');

  // 谁把它当前置（可能散在好几个章节文件里）
  const dependents = store.quests.filter((q) => q.id !== id && q.dependencies.includes(id));

  // 按文件分组：同一个文件里先删本体、再逐个摘掉下游的前置，改动依次叠在同一个 source 上
  const byFile = new Map();
  byFile.set(chapter.file, { chapter, removeSelf: true, dependents: [] });
  for (const dep of dependents) {
    const ch = store.chapters.find((c) => c.file === dep.chapterFile);
    if (!ch) throw new McError(`找不到章节文件 ${dep.chapterFile}`, '', 'QuestNoChapter');
    if (!byFile.has(ch.file)) byFile.set(ch.file, { chapter: ch, removeSelf: false, dependents: [] });
    byFile.get(ch.file).dependents.push(dep);
  }

  const writes = [];
  const diff = [];
  for (const [file, group] of byFile) {
    const rel = `chapters/${file}`;
    let source = group.chapter.source;
    if (group.removeSelf) {
      source = removeQuest(source, id, rel).source;
      diff.push(`${rel}: 删掉任务「${quest.title}」（${id}）`);
    }
    for (const dep of group.dependents) {
      const next = dep.dependencies.filter((d) => d !== id);
      const result = patchQuestFields(source, dep.id, { dependencies: next }, rel);
      if (!result.changed) continue;
      source = result.source;
      diff.push(`${rel}: 「${dep.title}」的前置依赖去掉它（还剩 ${next.length} 个）`);
    }
    if (source !== group.chapter.source) writes.push({ file: group.chapter.path, content: source });
  }

  const warnings = dependents.length
    ? [`有 ${dependents.length} 个任务依赖它，删掉后这些任务的前置会少一个（不会锁死，只是门槛变松）`]
    : [];

  return {
    kind: 'node-delete',
    questId: id,
    questTitle: quest.title,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    dependents: dependents.map((q) => ({ id: q.id, title: q.title })),
    affectedCount: dependents.length,
    // 删除本身算一处改动，加上被牵连的下游，界面显示「共动了 N 个任务」才对得上
    changedCount: dependents.length + 1,
    changes: [],
    warnings,
    diff,
    files: writes.map((w) => ({
      name: `chapters/${path.basename(w.file)}`,
      path: w.file,
      bytes: Buffer.byteLength(w.content, 'utf8'),
    })),
    writes,
    locale: store.locale,
  };
}

/** 真写盘 + 立刻复查（删任务）。出问题整体还原。 */
export function commitNodeDelete({ plan, questDir, store }) {
  if (!plan.writes.length) {
    return { backups: [], lines: ['什么都没写（这个任务本来就不在文件里）'] };
  }
  const { backups, done } = writeFiles(plan.writes);

  let after;
  try {
    after = loadQuests(questDir, { locale: plan.locale });
  } catch (e) {
    restoreFiles(done);
    throw new McError(`删完读不回来了：${e.message}`, '已回滚，原文件没变', 'QuestBrokenAfterWrite');
  }
  const newErrors = newErrorsOf(store, after);
  if (newErrors.length) {
    restoreFiles(done);
    const detail = newErrors.slice(0, 3).map((e) => `${e.where}：${e.message}`).join('；');
    throw new McError('这次删除会让任务书出问题，已全部回滚', detail, 'QuestNodeRejected');
  }
  if (after.questsById.has(plan.questId)) {
    restoreFiles(done);
    throw new McError(
      `删完发现任务 ${plan.questId} 还在`,
      '这是软件自身的 bug，已回滚；请把这句话反馈给开发者',
      'QuestNodeRejected',
    );
  }

  return {
    backups,
    after,
    lines: [
      `已删掉任务「${plan.questTitle}」（${plan.questId}），写了 ${plan.writes.length} 个章节文件`
        + (backups.length ? `，备份：${backups.join('、')}` : ''),
      plan.affectedCount
        ? `连带断开 ${plan.affectedCount} 个下游任务对它的前置依赖`
        : '没有任务依赖它，没人受影响',
      `复查：${after.chapters.length} 个章节 / ${after.quests.length} 个任务，0 个新错误，正常`,
    ],
  };
}

/** 把「改图标 / 改依赖」的计划说成给人看的一串话（面板和工具共用）。 */
export function describeNodeEditPlan(plan, { apply = false } = {}) {
  const mode = apply ? '模式：真正写盘' : '模式：演练（不写盘）';
  const head = `任务：${plan.questTitle}（${plan.questId}）`;
  if (!plan.changedCount) {
    return [head, mode, '没有任何改动（值本来就一样）。'];
  }
  const lines = [head, mode, ...plan.diff];
  if (plan.files.length) lines.push(`会写：${plan.files.map((f) => f.name).join('、')}`);
  for (const w of plan.warnings) lines.push(`注意：${w}`);
  return lines;
}

/** 把「删任务」的计划说成给人看的一串话。 */
export function describeNodeDeletePlan(plan, { apply = false } = {}) {
  const mode = apply ? '模式：真正写盘' : '模式：演练（不写盘）';
  const lines = [
    `准备删掉任务「${plan.questTitle}」（${plan.questId}），它在章节「${plan.chapterTitle}」里`,
    mode,
    ...plan.diff,
  ];
  if (plan.dependents.length) {
    lines.push(`依赖它、会被一并断开的任务：${plan.dependents.map((d) => `${d.title}（${d.id}）`).join('、')}`);
  }
  if (plan.files.length) lines.push(`会写：${plan.files.map((f) => f.name).join('、')}`);
  for (const w of plan.warnings) lines.push(`注意：${w}`);
  return lines;
}