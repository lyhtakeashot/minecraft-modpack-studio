/**
 * 拖拽画布的核心：挪任务坐标。
 *
 * 覆盖：吸附半格、没动就不写、批量写同一个文件、校验失败整批不动、
 * 写完能读回新坐标、体检出问题整体回滚。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadQuests } from '../packages/core/quests.js';
import {
  commitMovePlan, describeMovePlan, planMoveQuests, snapCoord,
} from '../packages/core/quest-move.js';

const CHAPTER = `{
	id: "AAAA0001"
	order_index: 0
	filename: "ch1"
	quests: [
		{
			id: "BBBB0001"
			x: 0d
			y: 0d
			tasks: [
				{
					id: "T0000001"
					type: "item"
					item: {
						id: "minecraft:iron_ingot"
						count: 8
					}
				}
			]
		}
		{
			id: "BBBB0002"
			x: 1.5d
			y: 2d
			dependencies: ["BBBB0001"]
			tasks: [
				{
					id: "T0000002"
					type: "item"
					item: {
						id: "minecraft:gold_ingot"
						count: 4
					}
				}
			]
		}
	]
}
`;

const LANG = `{
	"quest.BBBB0001.title": "打铁"
	"quest.BBBB0002.title": "打金"
}
`;

function makeBook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-move-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(questDir, 'lang'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), CHAPTER, 'utf8');
  fs.writeFileSync(path.join(questDir, 'lang', 'en_us.snbt'), LANG, 'utf8');
  return { root, questDir, chapterPath: path.join(questDir, 'chapters', 'ch1.snbt') };
}

test('坐标吸附到半格，离谱的坐标被夹住', () => {
  assert.equal(snapCoord(1.2), 1);
  assert.equal(snapCoord(1.3), 1.5);
  assert.equal(snapCoord(-0.7), -0.5);
  assert.equal(snapCoord(0), 0);
  assert.equal(snapCoord('3.5'), 3.5);
  assert.equal(snapCoord(99999), 1000);
  assert.equal(snapCoord(-99999), -1000);
  assert.equal(snapCoord('abc'), null);
  assert.equal(snapCoord(undefined), null);
});

test('预览只算不写，坐标一个字节都没动', () => {
  const { questDir, chapterPath } = makeBook();
  const before = fs.readFileSync(chapterPath, 'utf8');
  const store = loadQuests(questDir);
  const plan = planMoveQuests({
    questDir,
    store,
    moves: [{ questId: 'BBBB0001', x: 2, y: 3 }],
  });
  assert.equal(plan.changedCount, 1);
  assert.equal(plan.writes.length, 1);
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), before, '预览不该写盘');
  assert.equal(plan.moves[0].from.x, 0);
  assert.equal(plan.moves[0].to.x, 2);
  assert.ok(plan.diff[0].includes('打铁'));
});

test('没动的任务不进计划，全都没动就一个文件都不写', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  const plan = planMoveQuests({
    questDir,
    store,
    moves: [
      { questId: 'BBBB0001', x: 0, y: 0 },
      { questId: 'BBBB0002', x: 1.5, y: 2 },
    ],
  });
  assert.equal(plan.changedCount, 0);
  assert.equal(plan.writes.length, 0);
  assert.deepEqual(describeMovePlan(plan), ['准备挪动任务：坐标没变', '模式：演练（不写盘）']);
});

test('同一章节里一次挪多个：写一次文件，坐标全部生效', () => {
  const { questDir, chapterPath } = makeBook();
  const store = loadQuests(questDir);
  const plan = planMoveQuests({
    questDir,
    store,
    moves: [
      { questId: 'BBBB0001', x: -2, y: -1.5 },
      { questId: 'BBBB0002', x: 4, y: 5 },
    ],
  });
  assert.equal(plan.changedCount, 2);
  assert.equal(plan.writes.length, 1, '同一个章节文件只写一次');

  const done = commitMovePlan({ plan, questDir, store });
  assert.equal(done.backups.length, 1);

  const after = loadQuests(questDir);
  assert.equal(after.questsById.get('BBBB0001').x, -2);
  assert.equal(after.questsById.get('BBBB0001').y, -1.5);
  assert.equal(after.questsById.get('BBBB0002').x, 4);
  assert.equal(after.questsById.get('BBBB0002').y, 5);
  // 依赖关系不能被挪丢
  assert.deepEqual(after.questsById.get('BBBB0002').dependencies, ['BBBB0001']);
  assert.ok(fs.readFileSync(chapterPath, 'utf8').includes('dependencies'));
});

test('任务不存在 / 坐标不是数字 / 重复给同一个任务，都整批拒绝', () => {
  const { questDir, chapterPath } = makeBook();
  const store = loadQuests(questDir);
  const before = fs.readFileSync(chapterPath, 'utf8');

  assert.throws(
    () => planMoveQuests({ questDir, store, moves: [{ questId: 'NOPE', x: 1, y: 1 }] }),
    (e) => e.code === 'QuestNotFound',
  );
  assert.throws(
    () => planMoveQuests({ questDir, store, moves: [{ questId: 'BBBB0001', x: 'a', y: 1 }] }),
    (e) => e.code === 'MoveBadCoord',
  );
  assert.throws(
    () => planMoveQuests({
      questDir,
      store,
      moves: [{ questId: 'BBBB0001', x: 1, y: 1 }, { questId: 'BBBB0001', x: 2, y: 2 }],
    }),
    (e) => e.code === 'MoveDuplicate',
  );
  assert.throws(
    () => planMoveQuests({ questDir, store, moves: [] }),
    (e) => e.code === 'MoveEmpty',
  );
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), before, '校验失败不能留下半个改动');
});

test('写进去的坐标沿用原来的 d 后缀写法', () => {
  const { questDir, chapterPath } = makeBook();
  const store = loadQuests(questDir);
  const plan = planMoveQuests({
    questDir,
    store,
    moves: [{ questId: 'BBBB0001', x: 3.5, y: -2 }],
  });
  commitMovePlan({ plan, questDir, store });
  const text = fs.readFileSync(chapterPath, 'utf8');
  assert.ok(/x:\s*3\.5d/.test(text), `x 应该是 3.5d，实际：${text.slice(0, 200)}`);
  // 整数写法可能是 `-2d` 也可能是 `-2.0d`，两种 SNBT 都合法，只要带 d 就是原写法
  assert.ok(/y:\s*-2(\.0)?d/.test(text), `y 应该是 -2d 或 -2.0d，实际：${text.slice(0, 200)}`);
});

test('描述里能看出从哪挪到哪', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  const plan = planMoveQuests({ questDir, store, moves: [{ questId: 'BBBB0001', x: 2, y: 3 }] });
  const lines = describeMovePlan(plan, { apply: true });
  assert.equal(lines[0], '准备挪动 1 个任务（会写 ch1.snbt）');
  assert.equal(lines[1], '模式：真正写盘');
  assert.ok(lines[2].includes('(0, 0) → (2, 3)'));
});

// ————————————— 同一套底层函数：面板和工具都走 plan → commit 这两步 —————————————

test('只算不写：算完不 commit，文件一个字节都没动', () => {
  const { questDir, chapterPath } = makeBook();
  const before = fs.readFileSync(chapterPath, 'utf8');
  const store = loadQuests(questDir);
  const plan = planMoveQuests({ questDir, store, moves: [{ questId: 'BBBB0001', x: 3, y: 4 }] });
  assert.equal(plan.changedCount, 1);
  // 演练文案明确说「不写盘」
  assert.ok(describeMovePlan(plan, { apply: false }).includes('模式：演练（不写盘）'));
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), before, '演练不能写盘');
});

test('批量挪动：commit 之后坐标全部生效，并且留下备份', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  const plan = planMoveQuests({
    questDir,
    store,
    moves: [
      { questId: 'BBBB0001', x: 2, y: 3 },
      { questId: 'BBBB0002', x: 6, y: 7 },
    ],
  });
  assert.equal(plan.changedCount, 2);
  const done = commitMovePlan({ plan, questDir, store });
  assert.ok(done.backups.length >= 1, '写盘前必须留备份');
  assert.ok(done.after.questsById.get('BBBB0001').x === 2);
  assert.ok(done.after.questsById.get('BBBB0002').y === 7);
});

test('坏数据会明确报错（带错误码），而不是默默不动', () => {
  const { questDir, chapterPath } = makeBook();
  const store = loadQuests(questDir);
  const before = fs.readFileSync(chapterPath, 'utf8');
  // 坐标不是数字
  assert.throws(
    () => planMoveQuests({ questDir, store, moves: [{ questId: 'BBBB0001', x: '不是数字', y: 1 }] }),
    (e) => e.code === 'MoveBadCoord',
  );
  // 同一个任务给了两次
  assert.throws(
    () => planMoveQuests({
      questDir,
      store,
      moves: [{ questId: 'BBBB0001', x: 1, y: 1 }, { questId: 'BBBB0001', x: 2, y: 2 }],
    }),
    (e) => e.code === 'MoveDuplicate',
  );
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), before, '校验失败不能留下半个改动');
});