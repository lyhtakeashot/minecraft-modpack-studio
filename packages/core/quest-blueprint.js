/**
 * 蓝图式编辑（2026-11-09）：画布上「把物品框拖进任务节点」「复制整个任务节点」
 * 「把物品框拖到空白处长出一个新节点」背后共用的 core 逻辑。
 *
 * 和 quest-create.js / quest-node.js 一样只算不写（plan），写盘交给
 * commitQuestPlan / commitNodeEdit —— 界面点着改和模型用工具改，落出来的
 * 文件结构必须一模一样（硬约束）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { McError } from './errors.js';
import {
  addQuest, describeEntries, newId, patchQuestFields, patchQuestText,
} from './quests.js';
import { parseSpans } from './snbt.js';
import {
  buildEntry, requiredFields, rewardDef, taskDef,
} from './quest-conditions.js';

/** 物品 ID 长什么样：小写、带命名空间冒号。写错游戏里认不出来。 */
const ITEM_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/**
 * 从语言文件里读出某个任务的原始文案（标题 / 副标题 / 简介），供复制用。
 *
 * 用 parseSpans 而不是重新拼字符串：lang 里的 description 可能是数组，
 * 值原样搬过去，别把「一行一段」压成一整句。
 */
export function readQuestText(source, questId, label = 'lang.snbt') {
  const root = parseSpans(source, label);
  if (root.kind !== 'compound') throw new McError(`${label} 的根不是 compound`, '', 'QuestBadLang');
  const out = {};
  for (const [field, suffix] of Object.entries({
    title: 'title', subtitle: 'quest_subtitle', desc: 'quest_desc',
  })) {
    const node = root.entries.get(`quest.${questId}.${suffix}`)?.node;
    if (node && node.value !== undefined) out[field] = node.value;
  }
  return out;
}

/**
 * 给一组条件 / 奖励「追加」一条，原有的一条都不动。
 *
 * 和 rewriteEntries 的区别：那边是「改第一条同类型的」，这边是「往末尾加一条」。
 * 蓝图里把物品椭圆框拖到任务节点上 = 多一条「交这个物品」的要求，
 * 不是把原来那条改掉（悄悄换掉会让玩家已经交的进度清零）。
 * 同一个物品挂过了就跳过并给一句人话，别让人手抖拖出十条重复的。
 *
 * @returns {{entries: object[], warnings: string[], added: boolean}}
 */
export function appendEntries(entries, spec, kind, label) {
  const list = Array.isArray(entries) ? entries : [];
  const warnings = [];
  const type = String(spec?.type ?? 'item').trim() || 'item';
  const def = kind === 'reward' ? rewardDef(type) : taskDef(type);
  if (!def) {
    throw new McError(
      `${label}的类型「${type}」还不认识`,
      '换个支持的类型，或者直接改文件。',
      'QuestUnsupportedCondition',
    );
  }
  const itemId = String(spec?.item ?? '').trim();
  if (type === 'item' && !itemId) {
    return { entries: list, warnings: [`${label}没给物品 ID，什么都没加。`], added: false };
  }
  const missing = requiredFields(kind, type).filter((key) => !String(spec?.[key] ?? '').trim());
  if (missing.length) {
    throw new McError(
      `${label}缺了必填的东西：${missing.join('、')}`,
      '把这一栏填上再改。',
      'QuestMissingField',
    );
  }
  if (type === 'item' && list.some((e) => e && String(e.type ?? 'item') === 'item'
    && String(e.item?.id ?? '') === itemId)) {
    return { entries: list, warnings: [`${label}里已经有「${itemId}」了，没重复添加。`], added: false };
  }
  const built = buildEntry(kind, spec, null, newId);
  if (!built) {
    throw new McError(
      `${label}的类型「${type}」还不认识`,
      '换个支持的类型，或者直接改文件。',
      'QuestUnsupportedCondition',
    );
  }
  return { entries: [...list, built], warnings, added: true };
}

/**
 * 算一份「给任务追加一条物品要求」的计划，不写盘。
 * 空计划（这个物品已经挂过 / 没给物品）由 warnings 说明，界面照常显示即可。
 */
export function planNodeItems({ questDir, store, questId, item, count }) {
  const id = String(questId ?? '').trim();
  if (!id) throw new McError('没给要改的任务 ID', '给 questId（16 位十六进制）', 'QuestNoId');
  const itemId = String(item ?? '').trim();
  if (!itemId || !ITEM_ID_RE.test(itemId)) {
    throw new McError(
      `物品 ID 不像个物品：${itemId || '（空）'}`,
      '形如 minecraft:iron_ingot（小写、带命名空间冒号）',
      'QuestBadItemId',
    );
  }
  const quest = store.questsById.get(id);
  if (!quest) throw new McError(`这本书里没有任务 ${id}`, '先刷新一下画布', 'QuestNotFound');
  const chapter = store.chapters.find((c) => c.file === quest.chapterFile);
  if (!chapter) throw new McError(`找不到章节文件 ${quest.chapterFile}`, '', 'QuestNoChapter');

  const n = Math.max(1, Math.min(64, Math.floor(Number(count) || 1)));
  const { entries, warnings, added } = appendEntries(
    quest.tasks, { type: 'item', item: itemId, count: n }, 'task', '完成条件',
  );

  const writes = [];
  const changes = [];
  if (added) {
    const rel = `chapters/${chapter.file}`;
    const result = patchQuestFields(chapter.source, id, { tasks: entries }, rel);
    if (result.changed) {
      writes.push({ file: chapter.path, content: result.source });
      changes.push({
        field: 'tasks',
        label: '完成条件',
        before: describeEntries(quest.tasks, 'task'),
        after: describeEntries(entries, 'task'),
      });
    }
  }

  return {
    kind: 'node-items',
    questId: id,
    questTitle: quest.title,
    item: itemId,
    count: n,
    changedCount: changes.length,
    changes,
    diff: changes.length ? [`完成条件：追加「交 ${n} 个 ${itemId}」，原有要求一条不动`] : [],
    warnings,
    locale: store.locale,
    files: writes.map((w) => ({
      name: `chapters/${path.basename(w.file)}`,
      path: w.file,
      bytes: Buffer.byteLength(w.content, 'utf8'),
      created: false,
    })),
    writes,
    questDir,
  };
}

/** 找章节（ID / 标题 / 文件名都认）；没指定就回落到源任务所在章 / 第一章。 */
function chapterOf(store, key, fallbackFile) {
  if (key) {
    const wanted = String(key).trim();
    const hit = store.chapters.find((c) => c.id === wanted)
      ?? store.chapters.find((c) => c.title === wanted)
      ?? store.chapters.find((c) => c.file.replace(/\.snbt$/, '') === wanted);
    if (!hit) throw new McError(`找不到章节「${wanted}」`, '先刷新一下画布', 'ChapterNotFound');
    return hit;
  }
  const hit = store.chapters.find((c) => c.file === fallbackFile) ?? store.chapters[0];
  if (!hit) throw new McError('这个任务书里还没有章节', '先建一个章节再拖物品', 'ChapterNotFound');
  return hit;
}

/** 把「章节文件 + 语言文件」都算好，交给 commitQuestPlan 一次写盘、写完复查。 */
function finishQuestPlan({
  questDir, store, chapter, questId, x, y, payload, sourceText, sourceQuestId, sourceTitle,
}) {
  const chapterSource = fs.readFileSync(chapter.path, 'utf8');
  const relChapter = `chapters/${chapter.file}`;
  const nextChapter = addQuest(chapterSource, payload, relChapter);

  const locale = store.locale;
  const langPath = path.join(questDir, 'lang', `${locale}.snbt`);
  const langName = `lang/${locale}.snbt`;
  const langSource = fs.existsSync(langPath) ? fs.readFileSync(langPath, 'utf8') : '{\n}\n';
  const langResult = patchQuestText(langSource, questId, sourceText, langName);

  const diff = [
    sourceQuestId
      ? `复制自任务 ${sourceQuestId}「${sourceTitle}」：标题 / 图标 / 要求 / 奖励都带过来`
      : '把物品拖到空白处，长出一个新任务节点（标题跟物品名）',
    `${relChapter}: 新任务 ${questId} 放在 (${x}, ${y})`,
    `  完成条件：${describeEntries(payload.tasks ?? [], 'task')}`,
    `  奖励：${describeEntries(payload.rewards ?? [], 'reward')}`,
  ];
  if (langResult.changed) diff.push(`${langName}: 写入任务文案`);

  return {
    kind: 'quest',
    questId,
    sourceQuestId: sourceQuestId ?? '',
    chapter: { id: chapter.id, title: chapter.title },
    x,
    y,
    tasks: payload.tasks ?? [],
    rewards: payload.rewards ?? [],
    files: [relChapter, ...(langResult.changed ? [langName] : [])],
    diff,
    writes: [
      { file: chapter.path, content: nextChapter },
      ...(langResult.changed ? [{ file: langPath, content: langResult.source }] : []),
    ],
    locale,
  };
}

/**
 * 复制一组条件 / 奖励：**内容照抄，但每条换新 ID**。
 *
 * 条目的 id 是 FTB 用来记「这个玩家交过没有」的钥匙，全书不能重复；
 * 直接把原任务的数组塞进新任务，等于两个任务共用一把钥匙，玩家完成一个
 * 另一个也会跟着亮。换 id 才叫真的「复制了一份」。
 */
function cloneEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((e) => (e && typeof e === 'object' ? { ...e, id: newId() } : e));
}

/**
 * 复制一个任务节点：标题 / 副标题 / 简介 / 图标 / 完成条件 / 奖励 / 形状大小全带过来，
 * 换个新 ID，放到指定坐标（默认往右挪两格，免得压在原节点上）。
 *
 * 前置依赖**不复制**：新任务是独立的一支，挂上原任务的前置反而容易连错线，
 * 想连让用户自己右键「改前置依赖」。
 */
export function planCloneQuest({ questDir, store, sourceQuestId, x, y, chapter }) {
  const src = store.questsById.get(String(sourceQuestId ?? '').trim());
  if (!src) {
    throw new McError('找不到要复制的任务', '先在画布上点一个任务，再按 Ctrl+C', 'QuestNotFound');
  }
  const target = chapterOf(store, chapter, src.chapterFile);
  const questId = newId();
  const raw = src.raw ?? {};
  const nx = Number.isFinite(Number(x)) && x !== undefined && x !== null && x !== '' ? Number(x) : src.x + 2;
  const ny = Number.isFinite(Number(y)) && y !== undefined && y !== null && y !== '' ? Number(y) : src.y;

  const payload = {
    id: questId,
    x: nx,
    y: ny,
    tasks: cloneEntries(raw.tasks),
    rewards: cloneEntries(raw.rewards),
  };
  if (typeof raw.icon?.id === 'string' && raw.icon.id) payload.icon = raw.icon.id;
  if (raw.shape) payload.shape = raw.shape;
  // ★ 2026-11-13：判定改成 `!= 0`，和 FTB 源码（`Quest.java` 写盘段）一致。
  //   0 = 跟随章节 → 不写。以前的 `!== 1` 只是碰巧对。
  if (raw.size && Number(raw.size) !== 0) payload.size = Number(raw.size);

  const langPath = path.join(questDir, 'lang', `${store.locale}.snbt`);
  const langSource = fs.existsSync(langPath) ? fs.readFileSync(langPath, 'utf8') : '{\n}\n';
  const sourceText = readQuestText(langSource, src.id, `lang/${store.locale}.snbt`);

  return finishQuestPlan({
    questDir, store, chapter: target, questId, x: nx, y: ny, payload,
    sourceText, sourceQuestId: src.id, sourceTitle: src.title,
  });
}

/**
 * 把物品椭圆框拖到画布空白处：新建一个「只要求交这个物品」的任务节点。
 *
 * 故意不写标题 —— FTB 遇到没标题的任务会自动拿要交的物品名当标题，
 * 游戏里显示的是「铁锭」而不是一串 ID，比我们硬塞一个字符串好看得多。
 */
export function planSpawnQuest({ questDir, store, item, count, x, y, chapter }) {
  const itemId = String(item ?? '').trim();
  if (!itemId || !ITEM_ID_RE.test(itemId)) {
    throw new McError(
      `物品 ID 不像个物品：${itemId || '（空）'}`,
      '形如 minecraft:iron_ingot（小写、带命名空间冒号）',
      'QuestBadItemId',
    );
  }
  const target = chapterOf(store, chapter, store.chapters[0]?.file);
  const questId = newId();
  const n = Math.max(1, Math.min(64, Math.floor(Number(count) || 1)));
  const built = buildEntry('task', { type: 'item', item: itemId, count: n }, null, newId);
  if (!built) {
    throw new McError('这个物品建不出任务要求', '换个物品试试', 'QuestUnsupportedCondition');
  }

  const px = Number.isFinite(Number(x)) && x !== undefined && x !== null && x !== '' ? Number(x) : 0;
  const py = Number.isFinite(Number(y)) && y !== undefined && y !== null && y !== '' ? Number(y) : 0;
  const payload = { id: questId, x: px, y: py, tasks: [built], rewards: [] };

  return finishQuestPlan({
    questDir, store, chapter: target, questId, x: px, y: py, payload, sourceText: {},
  });
}
