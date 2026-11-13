/**
 * 新建章节 / 新建任务的「算」和「写」。
 *
 * 面板点着建和模型用工具建，必须走同一套逻辑（硬约束：两条路调同一批 core 函数）。
 *
 * 节奏仍然是 plan → apply：
 *   planAddQuest / planAddChapter 只算「要写哪几个文件、写什么」，一个字节都不落盘；
 *   commitQuestPlan 才真写，写完立刻重读 + 体检，出现新错误就整体回滚。
 */
import fs from 'node:fs';
import path from 'node:path';

import { McError } from './errors.js';
import {
  addQuest, buildChapterFile, lintQuests, loadQuests, newId, patchQuestText,
} from './quests.js';
import { describeSpec, entryFromSpec, specFromParams } from './quest-conditions.js';
import { parseSnbt } from './snbt.js';

/** 按 ID / 标题 / 文件名找章节。 */
export function findChapter(store, key) {
  const wanted = String(key ?? '').trim();
  return store.chapters.find((c) => c.id === wanted)
    ?? store.chapters.find((c) => c.title === wanted)
    ?? store.chapters.find((c) => c.file.replace(/\.snbt$/, '') === wanted)
    ?? null;
}

/** 按 ID / 标题找分组。 */
export function findGroup(store, key) {
  const wanted = String(key ?? '').trim();
  return store.chapterGroups.find((g) => g.id === wanted)
    ?? store.chapterGroups.find((g) => g.title === wanted)
    ?? null;
}

/**
 * 备份 + 写一批文件。
 * @param {Array<{file: string, content: string}>} writes
 */
export function writeFiles(writes) {
  const backups = [];
  const done = [];
  try {
    for (const w of writes) {
      const existed = fs.existsSync(w.file);
      const backup = existed ? `${w.file}.bak-${Date.now()}` : null;
      if (backup) { fs.copyFileSync(w.file, backup); backups.push(path.basename(backup)); }
      fs.mkdirSync(path.dirname(w.file), { recursive: true });
      fs.writeFileSync(w.file, w.content, 'utf8');
      done.push({ file: w.file, backup });
    }
  } catch (e) {
    restoreFiles(done);
    throw new McError(`写盘失败：${e.message}`, '已回滚，原文件没变', 'QuestWriteFailed');
  }
  return { backups, done };
}

/** 把已经写过的文件还原回去（有备份就覆盖，没备份就是新建的，直接删）。 */
export function restoreFiles(done) {
  for (const d of [...done].reverse()) {
    try {
      if (d.backup) fs.copyFileSync(d.backup, d.file);
      else fs.rmSync(d.file, { force: true });
    } catch { /* 还原尽力而为，不能因为还原失败再抛新错盖住真相 */ }
  }
}

/** 对比改动前后的体检错误，找出「这次新引入的」。 */
export function newErrorsOf(store, after) {
  const key = (i) => `${i.code}|${i.where}`;
  const before = new Set(lintQuests(store).filter((i) => i.level === 'error').map(key));
  return lintQuests(after).filter((i) => i.level === 'error' && !before.has(key(i)));
}

function langPathOf(questDir, locale) {
  return path.join(questDir, 'lang', `${locale}.snbt`);
}

/**
 * 读语言文件。
 *
 * 文件不存在时**不当错误**：从零建出来的新包，任务书是空的，FTB 还没写过任何
 * 语言文件，这时候「加第一个章节」是正常需求。给它一个空的 compound 当底子，
 * 后面 patchQuestText 会把新键插进去，写出来就是合法的 snbt。
 */
function readLangOrThrow(questDir, locale) {
  const langPath = langPathOf(questDir, locale);
  if (!fs.existsSync(langPath)) {
    return { langPath, source: '{\n}\n', created: true };
  }
  return { langPath, source: fs.readFileSync(langPath, 'utf8'), created: false };
}

// ————————————————————————— 新建任务 —————————————————————————

/**
 * 新建任务时可以从界面上填的任务级字段（2026-11-13，默认值改造第一批）。
 *
 * 这些全部是 FTB `Quest` 里真实存在、且 `quest-defaults.js` 登记过默认值的字段。
 * 调用方**不传就不写**（= 游戏用它自己的默认），所以这里的白名单只是
 * 「允许哪些自由字段透传」，不代表「必须写」。
 *
 * 为什么用白名单而不是 `...input` 全透：`input` 里混着 `questDir` / `store` /
 * `chapter` / `title` 这些**不是 snbt 字段**的东西，全透会把它们写进文件。
 */
const QUEST_FIELD_INPUTS = [
  'shape', 'size', 'optional', 'invisible', 'can_repeat',
  'min_required_dependencies', 'dependency_requirement',
  'hide_dependency_lines', 'hide_dependent_lines', 'hide_until_deps_visible',
  'hide_until_deps_complete', 'hide_text_until_complete', 'hide_details_until_startable',
  'disable_jei', 'invisible_until_tasks', 'require_sequential_tasks',
  'icon_scale', 'min_width', 'guide_page', 'ignore_reward_blocking', 'progression_mode',
];

/** 从 input 里挑出任务级字段（没给的一个都不带）。 */
function questFieldsOf(input) {
  const out = {};
  for (const key of QUEST_FIELD_INPUTS) {
    if (Object.hasOwn(input, key)) out[key] = input[key];
  }
  return out;
}

/**
 * 算一个新任务要写什么，不落盘。
 *
 * ★ 2026-11-13（默认值改造第一批）：除了老的条件/奖励，现在也认任务级字段
 *   （`shape` / `size` / `optional` / `invisible` / `can_repeat` …）。
 *   **不传就不写** —— 等于默认值的东西一个键都不会出现在章节文件里。
 *
 * @param {{questDir: string, store: object, chapter: string, title: string,
 *   subtitle?: string, description?: string[], dependsOn?: string[],
 *   taskItem?: string, taskCount?: number, rewardItem?: string, rewardCount?: number,
 *   icon?: string, shape?: string, size?: number, optional?: boolean, invisible?: boolean,
 *   can_repeat?: boolean|null,
 *   x?: number, y?: number}} input
 */
export function planAddQuest(input) {
  const { questDir, store } = input;
  const chapter = findChapter(store, input.chapter);
  if (!chapter) {
    const names = store.chapters.slice(0, 12).map((c) => `${c.title}(${c.id})`).join('、');
    throw new McError(`找不到章节「${input.chapter}」`, `现有章节：${names}`, 'ChapterNotFound');
  }
  const title = String(input.title ?? '').trim();
  if (!title) throw new McError('新任务得有标题', '给 title，比如「做一台压片机」', 'QuestNoTitle');

  // 依赖必须真实存在，否则新任务会永远锁着
  for (const dep of input.dependsOn ?? []) {
    if (!store.questsById.has(dep)) {
      throw new McError(
        `依赖的 ${dep} 不存在`,
        '先确认任务 ID，或者先建任务再连依赖',
        'QuestBadDependency',
      );
    }
  }

  const questId = newId();
  // 自动坐标：放在本章最下方，避免和已有节点重叠
  const autoY = Math.round((Math.max(-1, ...chapter.quests.map((q) => q.y)) + 2) * 2) / 2;
  const x = input.x ?? 0;
  const y = input.y ?? autoY;

  // 条件与奖励都走同一套类型目录（packages/core/quest-conditions.js）——
  // 点界面改和让模型改只是参数长相不同，落到文件里的结构必须一模一样。
  const taskSpec = specFromParams(input, 'task');
  const rewardSpec = specFromParams(input, 'reward');
  const taskEntry = entryFromSpec(taskSpec, 'task');
  const rewardEntry = entryFromSpec(rewardSpec, 'reward');
  const tasks = taskEntry ? [{ id: newId(), ...taskEntry }] : [];
  const rewards = rewardEntry ? [{ id: newId(), ...rewardEntry }] : [];

  const chapterSource = fs.readFileSync(chapter.path, 'utf8');
  const nextChapter = addQuest(chapterSource, {
    id: questId, x, y, tasks, rewards, dependencies: input.dependsOn,
    // 任务级字段：只带调用方真的给了的，等于默认值的由 addQuest 那一层剔掉
    icon: input.icon,
    ...questFieldsOf(input),
  }, `chapters/${chapter.file}`);

  // 中文标题不能写进 en_us，否则中英混在一个文件里
  const locale = store.locale;
  const lang = readLangOrThrow(questDir, locale);
  const textFields = { title };
  if (input.subtitle) textFields.subtitle = input.subtitle;
  if (input.description?.length) textFields.desc = input.description;
  const langResult = patchQuestText(lang.source, questId, textFields, `lang/${locale}.snbt`);

  const relChapter = `chapters/${chapter.file}`;
  const relLang = `lang/${locale}.snbt`;
  const files = [relChapter];
  const diff = [
    `${relChapter}: 新任务 ${questId}「${title}」放在 (${x}, ${y})`,
    `  完成条件：${taskEntry ? describeSpec('task', taskSpec) : '（无，玩家点了就过）'}`,
    `  奖励：${rewardEntry ? describeSpec('reward', rewardSpec) : '（无）'}`,
    `  依赖：${input.dependsOn?.length ? input.dependsOn.join('、') : '（无，开局就能做）'}`,
  ];
  if (langResult.changed) {
    files.push(relLang);
    diff.push(`${relLang}: 写标题「${title}」`);
  }

  return {
    kind: 'quest',
    questId,
    chapter: { id: chapter.id, title: chapter.title },
    x,
    y,
    tasks,
    rewards,
    files,
    diff,
    writes: [
      { file: chapter.path, content: nextChapter },
      ...(langResult.changed ? [{ file: lang.langPath, content: langResult.source }] : []),
    ],
    locale,
  };
}

// ————————————————————————— 新建章节 —————————————————————————

/**
 * 算一个新章节要写什么，不落盘。
 * @param {{questDir: string, store: object, title: string, group?: string,
 *   icon?: string, orderIndex?: number}} input
 */
export function planAddChapter(input) {
  const { questDir, store } = input;
  const title = String(input.title ?? '').trim();
  if (!title) throw new McError('新章节得有标题', '给 title，比如「第一章 起步」', 'ChapterNoTitle');

  let groupId = '';
  if (input.group) {
    const g = findGroup(store, input.group);
    if (!g) {
      const names = store.chapterGroups.map((x) => `${x.title}(${x.id})`).join('、') || '（这个包没有分组）';
      throw new McError(`找不到分组「${input.group}」`, `现有分组：${names}；不挂分组就别传 group`, 'GroupNotFound');
    }
    groupId = g.id;
  }

  const chapterId = newId();
  const filename = chapterId; // FTB 的惯例：文件名就是章节 ID
  const orderIndex = input.orderIndex
    ?? (Math.max(-1, ...store.chapters.map((c) => Number(c.raw.order_index ?? 0))) + 1);

  const content = buildChapterFile({
    id: chapterId, filename, group: groupId, title, icon: input.icon, orderIndex, quests: [],
  });
  // 生成的东西必须自己读得回来，否则宁可不写
  parseSnbt(content, `chapters/${filename}.snbt(新建)`);

  const chapterPath = path.join(questDir, 'chapters', `${filename}.snbt`);
  const locale = store.locale;
  const lang = readLangOrThrow(questDir, locale);
  const langResult = patchQuestText(lang.source, chapterId, { chapterTitle: title }, `lang/${locale}.snbt`);

  const relChapter = `chapters/${filename}.snbt`;
  const relLang = `lang/${locale}.snbt`;
  const groupTitle = groupId ? store.chapterGroups.find((g) => g.id === groupId).title : '（不分组）';
  const diff = [
    `${relChapter}: 新章节「${title}」，ID ${chapterId}`,
    `  分组：${groupTitle}`,
    `  排序：${orderIndex}`,
    `  图标：${input.icon || '（无）'}`,
    `${relLang}: 写章节标题「${title}」`,
  ];

  return {
    kind: 'chapter',
    chapterId,
    title,
    groupId,
    groupTitle,
    orderIndex,
    files: [relChapter, relLang],
    diff,
    writes: [
      { file: chapterPath, content },
      { file: lang.langPath, content: langResult.source },
    ],
    locale,
  };
}

/**
 * 真写盘 + 立刻复查。体检出现新错误就整体回滚，原文件一个字不变。
 * @param {{plan: object, questDir: string, store: object}} args
 */
export function commitQuestPlan({ plan, questDir, store }) {
  // 章节文件重名只可能是 ID 撞了，正常不会；先挡一下，别覆盖别人的章节
  if (plan.kind === 'chapter') {
    const target = plan.writes[0].file;
    if (fs.existsSync(target)) {
      throw new McError(
        `章节文件已存在：${path.basename(target)}`,
        '换个标题重试（ID 是随机生成的，正常不会撞）',
        'ChapterExists',
      );
    }
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
    throw new McError(
      plan.kind === 'chapter' ? '新章节会让任务书出问题，已全部回滚' : '新任务会让任务书出问题，已全部回滚',
      detail,
      plan.kind === 'chapter' ? 'ChapterAddRejected' : 'QuestAddRejected',
    );
  }

  return {
    backups,
    after,
    lines: [
      `已写入 ${plan.writes.length} 个文件` + (backups.length ? `，备份：${backups.join('、')}` : ''),
      `复查：${after.chapters.length} 个章节 / ${after.quests.length} 个任务，0 个新错误，正常`,
    ],
  };
}

/** 把计划说成给人看的一串话（面板和工具共用）。 */
export function describeQuestPlan(plan, { apply = false } = {}) {
  const head = plan.kind === 'chapter'
    ? `准备新建章节「${plan.title}」`
    : `准备在「${plan.chapter?.title ?? ''}」里新建任务`;
  return [head, apply ? '模式：真正写盘' : '模式：演练（不写盘）', ...plan.diff];
}