/**
 * 右键编辑任务节点：换图标 / 改前置依赖 / 删掉任务。
 *
 * 覆盖：预览不写盘、写进去的 SNBT 长得对、依赖的加/去/清空、自依赖与不存在的依赖被拒、
 * 删任务时跨章节断掉下游依赖、删完不产生新错误、留备份、描述文案看得出改了啥。
 *
 * 夹具是手写的一本小任务书：2 个章节文件 + 3 个任务 + 1 个 lang 文件。
 * 为什么 BBBB0003 放第二章：删 BBBB0001 时它要跨文件改依赖，这条最容易写漏。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { lintQuests, loadQuests } from '../packages/core/quests.js';
import { newErrorsOf } from '../packages/core/quest-create.js';
import {
  commitNodeDelete,
  commitNodeEdit,
  describeNodeDeletePlan,
  describeNodeEditPlan,
  parseDependencies,
  planNodeDelete,
  planNodeEdit,
} from '../packages/core/quest-node.js';

const CHAPTER1 = `{
	id: "AAAA0001"
	order_index: 0
	filename: "ch1"
	title: "第一章"
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
			x: 2d
			y: 0d
			icon: {
				id: "minecraft:stone"
			}
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

const CHAPTER2 = `{
	id: "AAAA0002"
	order_index: 1
	filename: "ch2"
	title: "第二章"
	quests: [
		{
			id: "BBBB0003"
			x: 0d
			y: 3d
			dependencies: ["BBBB0001", "BBBB0002"]
			tasks: [
				{
					id: "T0000003"
					type: "item"
					item: {
						id: "minecraft:diamond"
						count: 1
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
	"quest.BBBB0003.title": "钻石"
}
`;

function makeBook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-node-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(questDir, 'lang'), { recursive: true });
  const ch1 = path.join(questDir, 'chapters', 'ch1.snbt');
  const ch2 = path.join(questDir, 'chapters', 'ch2.snbt');
  fs.writeFileSync(ch1, CHAPTER1, 'utf8');
  fs.writeFileSync(ch2, CHAPTER2, 'utf8');
  fs.writeFileSync(path.join(questDir, 'lang', 'en_us.snbt'), LANG, 'utf8');
  return { root, questDir, ch1, ch2 };
}

/** 目录里有没有 .bak 备份（备份名带时间戳，只能按前缀找）。 */
function backupsOf(file) {
  return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.bak-`));
}

// ————————————————————————— 改图标 —————————————————————————

test('改图标：预览只算不写，写进去是 FTB 认的 icon: { id }', () => {
  const { questDir, ch1 } = makeBook();
  const before = fs.readFileSync(ch1, 'utf8');
  const store = loadQuests(questDir);

  const plan = planNodeEdit({ questDir, store, questId: 'BBBB0001', icon: 'create:cogwheel' });
  assert.equal(plan.kind, 'node-edit');
  assert.equal(plan.changedCount, 1);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].file, ch1);
  // 原文一个字节都没动
  assert.equal(fs.readFileSync(ch1, 'utf8'), before, '预览不该写盘');
  // before 是文件里真正写的值（没写就是空串，不是「第一个物品」那个兜底值）
  assert.equal(plan.changes[0].field, 'icon');
  assert.equal(plan.changes[0].before, '');
  assert.equal(plan.changes[0].after, 'create:cogwheel');
  // 写进去的形状必须是 icon: { id: "…" }，quests.js 就是按 raw.icon?.id 读的
  assert.match(plan.writes[0].content, /icon\s*:\s*\{[^}]*create:cogwheel/s);
  assert.ok(plan.diff[0].startsWith('图标：'));
  assert.equal(plan.files[0].name, 'chapters/ch1.snbt');
  assert.equal(plan.files[0].bytes, Buffer.byteLength(plan.writes[0].content, 'utf8'));
});

test('改图标：commit 后重读真的变了，并且留了备份', () => {
  const { questDir, ch1 } = makeBook();
  const store = loadQuests(questDir);
  const plan = planNodeEdit({ questDir, store, questId: 'BBBB0002', icon: 'create:cogwheel' });
  assert.equal(plan.changes[0].before, 'minecraft:stone');

  const done = commitNodeEdit({ plan, questDir, store });
  assert.equal(done.backups.length, 1);
  assert.equal(backupsOf(ch1).length, 1, '应该留一份 .bak');

  const after = loadQuests(questDir);
  assert.equal(after.questsById.get('BBBB0002').icon, 'create:cogwheel');
  // 依赖不能被顺手改掉
  assert.deepEqual(after.questsById.get('BBBB0002').dependencies, ['BBBB0001']);
  assert.ok(done.lines.some((l) => l.includes('0 个新错误')));
});

test('图标 ID 不像物品就明确报错，不写盘', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  assert.throws(
    () => planNodeEdit({ questDir, store, questId: 'BBBB0001', icon: 'cogwheel' }),
    (e) => e.code === 'QuestBadItemId',
  );
  assert.throws(
    () => planNodeEdit({ questDir, store, questId: 'BBBB0001', icon: 'Create:Cogwheel' }),
    (e) => e.code === 'QuestBadItemId',
  );
});

test('图标传空串 = 不改（不是删除图标）', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  const plan = planNodeEdit({ questDir, store, questId: 'BBBB0002', icon: '' });
  assert.equal(plan.changedCount, 0);
  assert.equal(plan.writes.length, 0);
  assert.deepEqual(describeNodeEditPlan(plan), [
    '任务：打金（BBBB0002）',
    '模式：演练（不写盘）',
    '没有任何改动（值本来就一样）。',
  ]);
});

// ————————————————————————— 改前置依赖 —————————————————————————

test('改依赖：加一个（原来没有这个键）', () => {
  const { questDir, ch1 } = makeBook();
  const store = loadQuests(questDir);
  const plan = planNodeEdit({ questDir, store, questId: 'BBBB0001', dependencies: ['BBBB0002'] });
  assert.equal(plan.changedCount, 1);
  assert.deepEqual(plan.changes[0].before, []);
  assert.deepEqual(plan.changes[0].after, ['BBBB0002']);
  assert.match(plan.writes[0].content, /dependencies\s*:\s*\[\s*"BBBB0002"\s*\]/);

  commitNodeEdit({ plan, questDir, store });
  assert.deepEqual(loadQuests(questDir).questsById.get('BBBB0001').dependencies, ['BBBB0002']);
  assert.equal(backupsOf(ch1).length, 1);
});

test('改依赖：去掉一个，剩下的保留', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  const plan = planNodeEdit({ questDir, store, questId: 'BBBB0003', dependencies: ['BBBB0002'] });
  assert.deepEqual(plan.changes[0].before, ['BBBB0001', 'BBBB0002']);
  assert.deepEqual(plan.changes[0].after, ['BBBB0002']);
  assert.ok(plan.diff[0].includes('2 个 → 1 个'));
  assert.ok(plan.diff[0].includes('去掉 BBBB0001'));
  commitNodeEdit({ plan, questDir, store });
  assert.deepEqual(loadQuests(questDir).questsById.get('BBBB0003').dependencies, ['BBBB0002']);
});

test('改依赖：传空数组真的写出 dependencies: []（不是「不改」）', () => {
  const { questDir, ch1 } = makeBook();
  const store = loadQuests(questDir);
  const plan = planNodeEdit({ questDir, store, questId: 'BBBB0002', dependencies: [] });
  assert.equal(plan.changedCount, 1);
  assert.deepEqual(plan.changes[0].after, []);
  assert.match(plan.writes[0].content, /dependencies\s*:\s*\[\s*\]/);
  assert.ok(plan.diff[0].includes('全部清空'));

  commitNodeEdit({ plan, questDir, store });
  const after = loadQuests(questDir);
  assert.deepEqual(after.questsById.get('BBBB0002').dependencies, []);
  assert.match(fs.readFileSync(ch1, 'utf8'), /dependencies\s*:\s*\[\s*\]/);
});

test('改依赖：JSON 字符串形式也认（界面就是这么传的）', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  const plan = planNodeEdit({
    questDir, store, questId: 'BBBB0002', dependencies: '["BBBB0001","BBBB0003"]',
  });
  assert.deepEqual(plan.changes[0].after, ['BBBB0001', 'BBBB0003']);
  commitNodeEdit({ plan, questDir, store });
  assert.deepEqual(loadQuests(questDir).questsById.get('BBBB0002').dependencies, ['BBBB0001', 'BBBB0003']);
});

test('改依赖：去重 + 逗号分隔也能认', () => {
  assert.deepEqual(parseDependencies('BBBB0001, BBBB0001,BBBB0002'), ['BBBB0001', 'BBBB0002']);
  assert.deepEqual(parseDependencies('["BBBB0001","BBBB0001"]'), ['BBBB0001']);
  assert.deepEqual(parseDependencies([]), []);
  assert.equal(parseDependencies(undefined), undefined);
  assert.equal(parseDependencies('  '), undefined);
});

test('自依赖 / 依赖不存在的任务 / 坏 JSON，都被拒绝且不写盘', () => {
  const { questDir, ch1, ch2 } = makeBook();
  const store = loadQuests(questDir);
  const before1 = fs.readFileSync(ch1, 'utf8');
  const before2 = fs.readFileSync(ch2, 'utf8');

  assert.throws(
    () => planNodeEdit({ questDir, store, questId: 'BBBB0002', dependencies: ['BBBB0002'] }),
    (e) => e.code === 'QuestDepSelf',
  );
  assert.throws(
    () => planNodeEdit({ questDir, store, questId: 'BBBB0002', dependencies: ['NOPE0001'] }),
    (e) => e.code === 'QuestDepMissing',
  );
  assert.throws(
    () => planNodeEdit({ questDir, store, questId: 'BBBB0002', dependencies: '[{不是 JSON' }),
    (e) => e.code === 'QuestBadDependency',
  );
  assert.equal(fs.readFileSync(ch1, 'utf8'), before1);
  assert.equal(fs.readFileSync(ch2, 'utf8'), before2);
});

// ————————————————————————— 删任务 —————————————————————————

test('删任务：预览列出下游、跨文件算两处写入，但一个字节都没写', () => {
  const { questDir, ch1, ch2 } = makeBook();
  const before1 = fs.readFileSync(ch1, 'utf8');
  const before2 = fs.readFileSync(ch2, 'utf8');
  const store = loadQuests(questDir);

  const plan = planNodeDelete({ questDir, store, questId: 'BBBB0001' });
  assert.equal(plan.kind, 'node-delete');
  assert.equal(plan.questTitle, '打铁');
  assert.equal(plan.chapterTitle, '第一章');
  assert.deepEqual(plan.dependents.map((d) => d.id).sort(), ['BBBB0002', 'BBBB0003']);
  assert.equal(plan.affectedCount, 2);
  // 本体在 ch1，BBBB0003 在 ch2：两个文件各一条 writes
  assert.equal(plan.writes.length, 2);
  assert.deepEqual(plan.files.map((f) => f.name).sort(), ['chapters/ch1.snbt', 'chapters/ch2.snbt']);
  assert.equal(plan.warnings.length, 1);
  assert.ok(plan.warnings[0].includes('2 个任务依赖它'));
  assert.equal(fs.readFileSync(ch1, 'utf8'), before1, '预览不该写盘');
  assert.equal(fs.readFileSync(ch2, 'utf8'), before2, '预览不该写盘');

  const lines = describeNodeDeletePlan(plan);
  assert.equal(lines[1], '模式：演练（不写盘）');
  assert.ok(lines.some((l) => l.includes('打金（BBBB0002）')));
});

test('删任务：真的从列表里消失，下游依赖被清掉，文件还能正常读，留备份', () => {
  const { questDir, ch1, ch2 } = makeBook();
  const store = loadQuests(questDir);
  const plan = planNodeDelete({ questDir, store, questId: 'BBBB0001' });
  const done = commitNodeDelete({ plan, questDir, store });

  assert.equal(done.backups.length, 2);
  assert.equal(backupsOf(ch1).length, 1);
  assert.equal(backupsOf(ch2).length, 1);

  const after = loadQuests(questDir);
  assert.equal(after.questsById.has('BBBB0001'), false, '任务应该没了');
  assert.deepEqual(after.questsById.get('BBBB0002').dependencies, [], '前一个下游的前置要清空');
  assert.deepEqual(after.questsById.get('BBBB0003').dependencies, ['BBBB0002'], '后一个下游只去掉它');
  // 剩下的任务还在，没被误删
  assert.equal(after.quests.length, 2);
  // 文件里也不能留孤立逗号把解析弄坏（能 loadQuests 成功就说明 parse 过了）
  assert.equal(fs.readFileSync(ch1, 'utf8').includes('BBBB0001'), false);
});

test('删任务：删完不产生新错误（体检前后对比）', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  const errorsBefore = lintQuests(store).filter((i) => i.level === 'error').length;

  const plan = planNodeDelete({ questDir, store, questId: 'BBBB0002' });
  const done = commitNodeDelete({ plan, questDir, store });

  const errorsAfter = lintQuests(done.after).filter((i) => i.level === 'error').length;
  assert.ok(errorsAfter <= errorsBefore, `删完不该多出错误：前 ${errorsBefore} 后 ${errorsAfter}`);
  // newErrorsOf 是 commit 里用的那把尺子，这里再量一次确认是空的
  assert.deepEqual(newErrorsOf(store, done.after), []);
});

// ————————————————————————— 边界 —————————————————————————

test('任务 ID 不存在：改和删都抛 QuestNotFound', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  assert.throws(() => planNodeEdit({ questDir, store, questId: 'NOPE0000', icon: 'minecraft:stone' }), (e) => e.code === 'QuestNotFound');
  assert.throws(() => planNodeDelete({ questDir, store, questId: 'NOPE0000' }), (e) => e.code === 'QuestNotFound');
});

test('什么都没给：返回空计划，不抛错，也不写盘', () => {
  const { questDir, ch1 } = makeBook();
  const before = fs.readFileSync(ch1, 'utf8');
  const store = loadQuests(questDir);
  const plan = planNodeEdit({ questDir, store, questId: 'BBBB0002' });
  assert.equal(plan.changedCount, 0);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.writes, []);
  const done = commitNodeEdit({ plan, questDir, store });
  assert.deepEqual(done.backups, [], '没改动就不该建备份');
  assert.deepEqual(done.lines, ['没有任何改动，什么都没写']);
  assert.equal(fs.readFileSync(ch1, 'utf8'), before);
});

test('值和原来一样：算作没有改动', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  const plan = planNodeEdit({ questDir, store, questId: 'BBBB0002', icon: 'minecraft:stone' });
  assert.equal(plan.changedCount, 0);
  assert.deepEqual(plan.writes, []);
});

test('同一份计划里图标和依赖一起改：只写一个文件，两处都生效', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  const plan = planNodeEdit({
    questDir, store, questId: 'BBBB0001', icon: 'create:cogwheel', dependencies: ['BBBB0002'],
  });
  assert.equal(plan.changedCount, 2);
  assert.equal(plan.writes.length, 1, '同一个章节文件只写一次');
  commitNodeEdit({ plan, questDir, store });

  const after = loadQuests(questDir);
  assert.equal(after.questsById.get('BBBB0001').icon, 'create:cogwheel');
  assert.deepEqual(after.questsById.get('BBBB0001').dependencies, ['BBBB0002']);
});

// ————————————————————————— 同一套底层：界面和工具都走 plan → commit —————————————————————————

test('改图标 + 改依赖：只算不写时文件一个字节都没动，commit 之后两处都生效', () => {
  const { questDir, ch1 } = makeBook();
  const before = fs.readFileSync(ch1, 'utf8');
  const store = loadQuests(questDir);

  // 只算不写
  const dry = planNodeEdit({ questDir, store, questId: 'BBBB0001', icon: 'create:cogwheel' });
  assert.equal(dry.kind, 'node-edit');
  assert.equal(dry.changedCount, 1);
  assert.ok(describeNodeEditPlan(dry).includes('模式：演练（不写盘）'));
  assert.equal(fs.readFileSync(ch1, 'utf8'), before, '只算不能写盘');

  // 真写：图标和依赖一起改
  const wet = planNodeEdit({
    questDir, store, questId: 'BBBB0001', icon: 'create:cogwheel', dependencies: '["BBBB0003"]',
  });
  assert.equal(wet.changedCount, 2);
  const done = commitNodeEdit({ plan: wet, questDir, store });
  assert.ok(done.backups.length >= 1);

  const after = loadQuests(questDir);
  assert.equal(after.questsById.get('BBBB0001').icon, 'create:cogwheel');
  assert.deepEqual(after.questsById.get('BBBB0001').dependencies, ['BBBB0003']);
});

test('删任务：只算不写时文件没动，commit 之后任务真的没了', () => {
  const { questDir, ch1 } = makeBook();
  const before = fs.readFileSync(ch1, 'utf8');
  const store = loadQuests(questDir);

  const dry = planNodeDelete({ questDir, store, questId: 'BBBB0001' });
  assert.deepEqual(dry.dependents.map((d) => d.title).sort(), ['打金', '钻石']);
  assert.ok(describeNodeDeletePlan(dry).includes('模式：演练（不写盘）'));
  assert.equal(fs.readFileSync(ch1, 'utf8'), before, '只算不能写盘');

  const wet = planNodeDelete({ questDir, store, questId: 'BBBB0001' });
  const done = commitNodeDelete({ plan: wet, questDir, store });
  assert.ok(done.backups.length >= 1);
  assert.equal(loadQuests(questDir).questsById.has('BBBB0001'), false);
});

test('删不存在的任务：明确报错（带错误码），不是默默成功', () => {
  const { questDir } = makeBook();
  const store = loadQuests(questDir);
  assert.throws(
    () => planNodeDelete({ questDir, store, questId: 'NOPE0000' }),
    (e) => e.code === 'QuestNotFound',
  );
});