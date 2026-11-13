/**
 * 任务书「拖拽画布」的算与写。
 *
 * 画布上拖动节点 = 改任务的 x / y 两个数字。FTB 的坐标是半格网格，
 * 所以这里统一吸附到 0.5 的整数倍，拖出来的布局在游戏里也对齐。
 *
 * 节奏和新建任务一致：plan 只算不写，commit 才落盘，写完立刻重读 + 体检，
 * 出现新错误就整体回滚。面板拖拽和模型用工具挪，都走这两个函数。
 */
import path from 'node:path';

import { McError } from './errors.js';
import { patchQuestFields, loadQuests } from './quests.js';
import { newErrorsOf, restoreFiles, writeFiles } from './quest-create.js';

/** 坐标吸附到半格：0.5 的整数倍。FTB 默认布局就是半格一步。 */
export function snapCoord(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // 别让离谱的坐标把画布撑到看不见的地方
  const clamped = Math.max(-1000, Math.min(1000, n));
  return Math.round(clamped * 2) / 2;
}

/** 画布坐标 → 给人看的写法（0.5 也照实写，别显示成 0）。 */
function coordText(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * 算一份「挪动若干任务」的计划。不写盘。
 *
 * @param {object} args
 * @param {string} args.questDir
 * @param {object} args.store   loadQuests 的结果
 * @param {Array<{questId: string, x: number, y: number}>} args.moves
 */
export function planMoveQuests({ questDir, store, moves }) {
  const list = Array.isArray(moves) ? moves : [];
  if (!list.length) {
    throw new McError('没给要挪的任务', '至少给一个 {questId, x, y}', 'MoveEmpty');
  }
  if (list.length > 500) {
    throw new McError(`一次最多挪 500 个任务，这次给了 ${list.length}`, '分两次拖', 'MoveTooMany');
  }

  // 先全部校验，一个不对就整批不动 —— 别写一半
  const seen = new Set();
  const wanted = [];
  for (const [i, raw] of list.entries()) {
    const questId = String(raw?.questId ?? '').trim();
    if (!questId) throw new McError(`第 ${i + 1} 个没给 questId`, '', 'MoveNoId');
    if (seen.has(questId)) throw new McError(`同一个任务给了两次：${questId}`, '一个任务只能出现一次', 'MoveDuplicate');
    seen.add(questId);
    const quest = store.questsById.get(questId);
    if (!quest) {
      throw new McError(
        `这本书里没有任务 ${questId}`,
        '先刷新一下画布，可能这任务刚被别处删了',
        'QuestNotFound',
      );
    }
    const x = snapCoord(raw?.x);
    const y = snapCoord(raw?.y);
    if (x === null || y === null) {
      throw new McError(`任务 ${questId} 的坐标不是数字`, 'x / y 必须是数字', 'MoveBadCoord');
    }
    wanted.push({ questId, quest, x, y });
  }

  // 按章节文件分组：同一个文件里的多次改动要依次叠加上去
  const byFile = new Map();
  for (const item of wanted) {
    const key = item.quest.chapterFile;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(item);
  }

  const writes = [];
  const diff = [];
  const changed = [];
  for (const [file, items] of byFile) {
    const chapter = store.chapters.find((c) => c.file === file);
    if (!chapter) {
      throw new McError(`找不到章节文件 ${file}`, '', 'QuestNoChapter');
    }
    let source = chapter.source;
    for (const item of items) {
      const fromX = snapCoord(item.quest.x) ?? 0;
      const fromY = snapCoord(item.quest.y) ?? 0;
      if (fromX === item.x && fromY === item.y) continue; // 没动就别写，免得白留备份
      const result = patchQuestFields(source, item.questId, { x: item.x, y: item.y }, `chapters/${file}`);
      if (!result.changed) continue;
      source = result.source;
      changed.push(item);
      diff.push(
        `${item.quest.title || item.questId}：(${coordText(fromX)}, ${coordText(fromY)}) → (${coordText(item.x)}, ${coordText(item.y)})`,
      );
    }
    if (source !== chapter.source) writes.push({ file: chapter.path, content: source });
  }

  return {
    kind: 'move',
    changedCount: changed.length,
    moves: changed.map((item) => ({
      questId: item.questId,
      title: item.quest.title,
      chapterId: item.quest.chapterId,
      from: { x: snapCoord(item.quest.x) ?? 0, y: snapCoord(item.quest.y) ?? 0 },
      to: { x: item.x, y: item.y },
    })),
    files: writes.map((w) => path.basename(w.file)),
    diff,
    writes,
    locale: store.locale,
  };
}

/**
 * 真写盘 + 立刻复查。体检出现新错误就整体回滚。
 * @param {{plan: object, questDir: string, store: object}} args
 */
export function commitMovePlan({ plan, questDir, store }) {
  if (!plan.writes.length) {
    return { backups: [], lines: ['坐标没变，什么都没写'] };
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
    throw new McError('这次挪动会让任务书出问题，已全部回滚', detail, 'QuestMoveRejected');
  }

  return {
    backups,
    after,
    lines: [
      `已挪动 ${plan.changedCount} 个任务，写了 ${plan.writes.length} 个章节文件`
        + (backups.length ? `，备份：${backups.join('、')}` : ''),
      `复查：${after.chapters.length} 个章节 / ${after.quests.length} 个任务，0 个新错误，正常`,
    ],
  };
}

/** 把计划说成给人看的一串话（面板和工具共用）。 */
export function describeMovePlan(plan, { apply = false } = {}) {
  if (!plan.changedCount) {
    return ['准备挪动任务：坐标没变', apply ? '模式：真正写盘' : '模式：演练（不写盘）'];
  }
  return [
    `准备挪动 ${plan.changedCount} 个任务（会写 ${plan.files.join('、')}）`,
    apply ? '模式：真正写盘' : '模式：演练（不写盘）',
    ...plan.diff,
  ];
}
