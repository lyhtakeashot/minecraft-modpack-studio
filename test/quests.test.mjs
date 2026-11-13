/**
 * 任务书核心的单测：用内存里的假任务书，覆盖真实数据里出现过的每一种写法。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadQuests, describeQuests, findQuests, relateQuest, lintQuests, lintQuestImages,
  patchQuestText, patchQuestFields, addQuest, removeQuest, questDisplayName, stripMcFormatting,
  parseMcFormatting, hasMcFormatting,
  dependencyStatus, dependencyStatusAll, DEPENDENCY_REQUIREMENTS, dependencyRequirementOf,
} from '../packages/core/quests.js';
import { specFromReward } from '../packages/core/quest-conditions.js';

/** 造一个最小但真实的假任务书目录。 */
function makeStore(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-quest-'));
  const quests = path.join(root, 'quests');
  fs.mkdirSync(path.join(quests, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(quests, 'lang'), { recursive: true });

  const chapter = overrides.chapter ?? `{
	default_quest_shape: ""
	filename: "CH1"
	group: "G1"
	id: "CH1"
	quest_links: [ ]
	quests: [
		{
			id: "Q_ALLOY"
			tasks: [{
				id: "T1"
				item: { count: 4, id: "create:andesite_alloy" }
				type: "item"
			}]
			x: -1.5d
			y: 0.0d
		}
		{
			dependencies: ["Q_ALLOY"]
			id: "Q_GEAR"
			tasks: [{
				id: "T2"
				item: { count: 1, id: "create:cogwheel" }
				type: "item"
			}]
			x: -1.5d
			y: 1.5d
		}
		{
			id: "Q_KILL"
			tasks: [{
				entity: "minecraft:zombie"
				id: "T3"
				type: "kill"
				value: 1L
			}]
			x: 0.0d
			y: 0.0d
		}
	]
}`;
  const lang = overrides.lang ?? `{
	chapter.CH1.title: "第一章"
	chapter_group.G1.title: "分组一"
	quest.Q_GEAR.title: "齿轮"
	quest.Q_GEAR.quest_desc: ["这是描述第一行", "", "第三行"]
	quest.Q_KILL.title: "打僵尸"
}`;
  fs.writeFileSync(path.join(quests, 'chapters', 'CH1.snbt'), chapter, 'utf8');
  fs.writeFileSync(path.join(quests, 'lang', 'en_us.snbt'), lang, 'utf8');
  fs.writeFileSync(path.join(quests, 'chapter_groups.snbt'), '[ { id: "G1" } ]', 'utf8');
  if (overrides.data !== undefined) fs.writeFileSync(path.join(quests, 'data.snbt'), overrides.data, 'utf8');
  return { root, questDir: quests, chapter, lang };
}

test('loadQuests：章节、任务、分组都读得出来', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  assert.equal(store.chapters.length, 1);
  assert.equal(store.quests.length, 3);
  assert.equal(store.chapters[0].title, '第一章');
  assert.equal(store.chapterGroups[0].title, '分组一');
});

test('loadQuests：章节的 images（背景图 / 装饰图）透传出来，坐标数字化，宽高为 0 的丢弃', () => {
  const { questDir } = makeStore({
    chapter: `{
	id: "CH1"
	images: [
		{
			image: "ftbquests:textures/end_deep_dark.png"
			x: 0.0d
			y: 2.0d
			width: 20.36d
			height: 10.24d
			rotation: 0.0d
			corner: true
		}
		{
			image: "jei:textures/jei/atlas/gui/recipe_arrow_filled.png"
			x: 3.0d
			y: 3.0d
			width: 0.0d
			height: 0.0d
		}
	]
	quests: [ ]
}`,
  });
  const store = loadQuests(questDir);
  const images = store.chapters[0].images;
  assert.equal(images.length, 1, '宽高为 0 的图应该被丢弃');
  assert.equal(images[0].image, 'ftbquests:textures/end_deep_dark.png');
  assert.equal(images[0].x, 0);
  assert.equal(images[0].y, 2);
  assert.ok(images[0].width > 20 && images[0].height > 10, '宽高应该转成数字');
  assert.equal(images[0].rotation, 0);
  // 2026-11-11：corner（alignToCorner）是旋转支点开关，要原样透传给界面
  assert.equal(images[0].corner, true, 'SNBT 里的 corner: true 没透传出来');
});

test('loadQuests：标题优先级 lang > 第一个物品任务 > ID', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  // lang 里有标题
  assert.equal(store.questsById.get('Q_GEAR').title, '齿轮');
  assert.equal(store.questsById.get('Q_GEAR').titleSource, 'lang');
  // lang 里没有，但有物品任务 → 用物品 ID 顶替（FTB 的实际行为）
  assert.equal(store.questsById.get('Q_ALLOY').title, 'create:andesite_alloy');
  assert.equal(store.questsById.get('Q_ALLOY').titleSource, 'item');
  // 既没标题也不是物品任务
  assert.equal(store.questsById.get('Q_KILL').titleSource, 'lang'); // 这个有标题
});

test('loadQuests：没有 chapters 目录要给出可理解的错误', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-empty-'));
  assert.throws(() => loadQuests(root), /没有 chapters 目录/);
});

test('loadQuests：描述按行读成数组', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  assert.deepEqual(store.questsById.get('Q_GEAR').description, ['这是描述第一行', '', '第三行']);
});

test('relateQuest：上游/下游方向不能搞反', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  const rel = relateQuest(store, 'Q_ALLOY');
  assert.deepEqual(rel.upstream, []);
  assert.equal(rel.downstream.length, 1);
  assert.equal(rel.downstream[0].id, 'Q_GEAR');
  const rel2 = relateQuest(store, 'Q_GEAR');
  assert.equal(rel2.upstream[0].id, 'Q_ALLOY');
});

test('findQuests：能按物品 ID 搜到任务', () => {
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  const hits = findQuests(store, 'andesite_alloy');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'Q_ALLOY');
  assert.equal(hits[0].matches, 1);
});

test('lintQuests：悬空依赖必须报错（游戏里会永远锁着）', () => {
  const { questDir } = makeStore({
    chapter: '{ id: "CH1" quests: [ { dependencies: ["NOPE"] id: "Q1" tasks: [] x: 0.0d y: 0.0d } ] }',
  });
  const store = loadQuests(questDir);
  const issues = lintQuests(store);
  const dangling = issues.find((i) => i.code === 'QuestDanglingDependency');
  assert.ok(dangling, `实际：${JSON.stringify(issues)}`);
  // 2026-11-11 降级：这不是 error。实测 ATM10Sky 那 9 条全部指向**任务条件的 ID**
  // 而不是任务 ID，而且 FTB 的 `Quest.class` 里有 `removeInvalidDependencies()` ——
  // 查不到的依赖会被直接删掉，任务照常能完成。以前写「永远锁着」是危言耸听。
  assert.equal(dangling.level, 'warn');
  assert.match(dangling.message, /自动忽略/, '文案要说人话，别吓人');
});

test('lintQuests：重复任务 ID 必须报错', () => {
  const { questDir } = makeStore({
    chapter: '{ id: "CH1" quests: [ { id: "DUP" tasks: [] x: 0.0d y: 0.0d } { id: "DUP" tasks: [] x: 1.0d y: 0.0d } ] }',
  });
  const store = loadQuests(questDir);
  assert.deepEqual(store.duplicateQuestIds, ['DUP']);
  assert.ok(lintQuests(store).some((i) => i.code === 'QuestDuplicateId'));
});

test('lintQuests：同一坐标重叠要报警告', () => {
  const { questDir } = makeStore({
    chapter: '{ id: "CH1" quests: [ { id: "A" tasks: [{ id: "t1" item: { id: "x:y" } type: "item" }] x: 2.0d y: 2.0d } { id: "B" tasks: [{ id: "t2" item: { id: "x:z" } type: "item" }] x: 2.0d y: 2.0d } ] }',
  });
  const store = loadQuests(questDir);
  const overlap = lintQuests(store).find((i) => i.code === 'QuestOverlap');
  assert.ok(overlap, '应该报坐标重叠');
});

test('lintQuests：任务级问题要带 questId + chapterId（界面靠它跳转）', () => {
  // 2026-11-12：界面诊断面板一直有「点一条跳到那个任务」的代码，
  // 但后端 push() 从来没产出过 questId —— 那两行代码一次都没生效过。
  // 这条用例就是钉住「每条任务级问题都得带定位」。
  const { questDir } = makeStore({
    chapter: '{ id: "CH1" quests: [ { dependencies: ["NOPE"] id: "Q1" tasks: [] x: 0.0d y: 0.0d } ] }',
  });
  const store = loadQuests(questDir);
  const dangling = lintQuests(store).find((i) => i.code === 'QuestDanglingDependency');
  assert.ok(dangling);
  assert.equal(dangling.questId, 'Q1', '悬空依赖要知道是哪个任务');
  assert.equal(dangling.chapterId, 'CH1', '还要知道在哪一章（跳转时要先切页签）');
});

test('lintQuests：任务级问题一律带 questId，章节级的不带 questId', () => {
  // 用一个问题很全的包一次性验：任务都给了 questId，章节只给 chapterId。
  const { questDir } = makeStore({
    chapter: '{ id: "CH1" group: "NOSUCHGROUP" quests: [ '
      + '{ id: "A" tasks: [] rewards: [] x: 1.0d y: 1.0d } '
      + '{ id: "B" tasks: [{ id: "t1" type: "item" }] rewards: [{ type: "loot" }] x: 1.0d y: 1.0d } '
      + '] }',
  });
  const store = loadQuests(questDir);
  const issues = lintQuests(store);
  assert.ok(issues.length >= 4, `应该有若干条问题，实际 ${JSON.stringify(issues)}`);

  const questLevel = issues.filter((i) => i.code === 'QuestEmpty'
    || i.code === 'ItemTaskNoItem' || i.code === 'TaskMissingField'
    || i.code === 'RewardMissingField' || i.code === 'QuestOverlap');
  assert.ok(questLevel.length >= 3, '这几类任务级问题都该出现');
  for (const i of questLevel) {
    assert.ok(i.questId, `${i.code} 缺 questId：${JSON.stringify(i)}`);
    assert.equal(i.chapterId, 'CH1', `${i.code} 的 chapterId 不对`);
  }

  // 章节级：只有 chapterId，绝不能有 questId（否则界面会跳到一个不存在的任务）。
  // 用 ChapterUnknownGroup 验：这一章的 group 在分组表里不存在。
  const unknown = issues.find((i) => i.code === 'ChapterUnknownGroup');
  assert.ok(unknown, `这一章该报 ChapterUnknownGroup，实际：${JSON.stringify(issues)}`);
  assert.equal(unknown.questId, undefined, '章节级问题不能有 questId');
  assert.equal(unknown.chapterId, 'CH1');
});

test('lintQuests：没写描述不再报（2026-11-11 实测 36.7% 的任务本来就没描述）', () => {
  // 本章有一个任务写了描述
  const { questDir } = makeStore();
  const store = loadQuests(questDir);
  assert.equal(lintQuests(store).filter((i) => i.code === 'ChapterNoDescription').length, 0);

  // 整章都没描述 —— 以前会提示一条，现在**不报了**。
  // 实测 ATM10Sky 3658 个任务里 1341 个（36.7%）根本没描述，52 章里 2 章整章没写；
  // 这不是作者忘了，是很多任务靠标题就说清了。报出来只是噪音。
  const bare = makeStore({
    chapter: '{ id: "CH1" quests: [ { id: "A" tasks: [{ id: "t1" item: { id: "x:y" } type: "item" }] x: 0.0d y: 0.0d } { id: "B" tasks: [{ id: "t2", item: { id: "x:z" }, type: "item" }] x: 1.0d y: 0.0d } ] }',
    lang: '{ chapter.CH1.title: "空章" }',
  });
  const bareStore = loadQuests(bare.questDir);
  assert.equal(lintQuests(bareStore).filter((i) => i.code === 'ChapterNoDescription').length, 0);
});

test('patchQuestText：替换已有键，字节变化等于新值差值', () => {
  const { lang } = makeStore();
  const r = patchQuestText(lang, 'Q_GEAR', { title: '齿轮组' }, 'lang/en_us.snbt');
  assert.equal(r.changed, true);
  assert.equal(Buffer.byteLength(r.source) - Buffer.byteLength(lang), Buffer.byteLength('齿轮组') - Buffer.byteLength('齿轮'));
  assert.ok(r.source.includes('quest.Q_GEAR.title: "齿轮组"'));
});

test('patchQuestText：值没变就不该产生改动', () => {
  const { lang } = makeStore();
  const r = patchQuestText(lang, 'Q_GEAR', { title: '齿轮' }, 'lang/en_us.snbt');
  assert.equal(r.changed, false);
});

test('patchQuestText：数组型描述整体替换', () => {
  const { lang } = makeStore();
  const r = patchQuestText(lang, 'Q_GEAR', { desc: ['新描述'] }, 'lang/en_us.snbt');
  assert.ok(r.source.includes('quest.Q_GEAR.quest_desc: ["新描述"]'));
});

test('patchQuestText：键不存在时新增，原有内容一个字都不动', () => {
  const { lang } = makeStore();
  const r = patchQuestText(lang, 'Q_ALLOY', { title: '合金' }, 'lang/en_us.snbt');
  assert.equal(r.changed, true);
  assert.ok(r.source.includes('quest.Q_ALLOY.title: "合金"'));
  // 原有的每一行都必须还在
  for (const line of lang.split('\n')) {
    if (!line.trim()) continue;
    assert.ok(r.source.includes(line), `丢了这一行：${line}`);
  }
});

test('patchQuestFields：改坐标只动那个任务', () => {
  const { chapter } = makeStore();
  const r = patchQuestFields(chapter, 'Q_GEAR', { x: 5.0 }, 'chapters/CH1.snbt');
  assert.equal(r.changed, true);
  // 原来的写法是 `x: -1.5d`，改完应该保持 d 后缀，只换数字
  assert.ok(r.source.includes('x: 5.0d'), `实际：${r.source.slice(r.source.indexOf('Q_GEAR'), r.source.indexOf('Q_GEAR') + 200)}`);
  // 另一个任务的坐标不能被顺手改掉
  assert.ok(r.source.includes('x: -1.5d'));
});

test('patchQuestFields：任务不存在要抛可读错误', () => {
  const { chapter } = makeStore();
  assert.throws(() => patchQuestFields(chapter, 'NOPE', { x: 1 }, 'chapters/CH1.snbt'), /找不到任务/);
});

test('addQuest：追加到列表末尾后仍可解析，原任务数 +1', () => {
  const { chapter } = makeStore();
  const out = addQuest(chapter, {
    id: 'Q_NEW',
    x: 3,
    y: 4,
    tasks: [{ id: 'T9', type: 'item', item: { id: 'minecraft:stick', count: 1 } }],
    dependencies: ['Q_GEAR'],
  }, 'chapters/CH1.snbt');
  const store2 = loadQuests(makeStoreWith(chapter, out));
  assert.equal(store2.quests.length, 4);
  const added = store2.questsById.get('Q_NEW');
  assert.equal(added.x, 3);
  assert.deepEqual(added.dependencies, ['Q_GEAR']);
});

/** 把改过的章节内容写进一个新临时目录，返回 questDir。 */
function makeStoreWith(chapterSource, quests) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-quest2-'));
  const dir = path.join(root, 'quests');
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lang'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chapters', 'CH1.snbt'), quests, 'utf8');
  fs.writeFileSync(path.join(dir, 'lang', 'en_us.snbt'), '{}', 'utf8');
  return dir;
}

test('describeQuests：摘要里带上章节任务数和语言', () => {
  const { questDir } = makeStore();
  const lines = describeQuests(loadQuests(questDir)).join('\n');
  assert.ok(lines.includes('3 个任务'));
  assert.ok(lines.includes('第一章'));
  assert.ok(lines.includes('en_us'));
});

// ————————————————————————— removeQuest：整块删任务 —————————————————————————

/** 把删过的章节内容写成一本新任务书，返回 loadQuests 的结果。 */
function loadAfterRemove(source) {
  return loadQuests(makeStoreWith(null, source));
}

test('removeQuest：删中间一个，前后都不受影响，且不留孤立逗号', () => {
  const { chapter } = makeStore();
  const r = removeQuest(chapter, 'Q_GEAR', 'chapters/CH1.snbt');
  assert.equal(r.changed, true);
  assert.equal(r.index, 1);

  const store = loadAfterRemove(r.source);
  assert.equal(store.quests.length, 2);
  assert.deepEqual(store.quests.map((q) => q.id), ['Q_ALLOY', 'Q_KILL']);
  // 逗号收拾干净：不能出现 `,,` 也不能出现 `, ]`
  assert.ok(!/,\s*,/.test(r.source), `留下了连续逗号：${r.source.slice(-200)}`);
  assert.ok(!/,\s*\]/.test(r.source), `列表结尾留了逗号：${r.source.slice(-200)}`);
});

test('removeQuest：删第一个（后面的那个逗号要跟着走）', () => {
  const { chapter } = makeStore();
  const r = removeQuest(chapter, 'Q_ALLOY', 'chapters/CH1.snbt');
  const store = loadAfterRemove(r.source);
  assert.deepEqual(store.quests.map((q) => q.id), ['Q_GEAR', 'Q_KILL']);
  assert.ok(!/,\s*,/.test(r.source));
});

test('removeQuest：删最后一个（前面那个逗号要跟着走）', () => {
  const { chapter } = makeStore();
  const r = removeQuest(chapter, 'Q_KILL', 'chapters/CH1.snbt');
  const store = loadAfterRemove(r.source);
  assert.deepEqual(store.quests.map((q) => q.id), ['Q_ALLOY', 'Q_GEAR']);
  assert.ok(!/,\s*\]/.test(r.source), `列表结尾留了逗号：${r.source.slice(-200)}`);
  // 剩下两个任务的字段一个都没掉
  assert.equal(store.questsById.get('Q_GEAR').x, -1.5);
});

test('removeQuest：只剩一个时删掉它，留下空列表也能解析', () => {
  const only = `{
	id: "CH1"
	quests: [
		{
			id: "Q_ONLY"
			x: 0d
			y: 0d
		}
	]
}
`;
  const r = removeQuest(only, 'Q_ONLY', 'chapters/CH1.snbt');
  const store = loadAfterRemove(r.source);
  assert.equal(store.quests.length, 0);
  assert.match(r.source, /quests\s*:\s*\[\s*\]/);
});

test('removeQuest：任务不存在要抛可读错误，不能默默返回', () => {
  const { chapter } = makeStore();
  assert.throws(
    () => removeQuest(chapter, 'NOPE', 'chapters/CH1.snbt'),
    (e) => e.code === 'QuestNotFound',
  );
});

test('removeQuest：没有 quests 列表的文件直接拒绝', () => {
  assert.throws(
    () => removeQuest('{ id: "CH1" }\n', 'Q_ALLOY', 'chapters/CH1.snbt'),
    (e) => e.code === 'QuestBadList',
  );
});

// ------------------------------- 形状 / 大小的继承（2026-11-03「任务书成品预览」）

test('形状继承：任务自己 → 章节 → 全局 → circle', () => {
  // 章节写空（继承全局），全局写 circle
  const { questDir } = makeStore({ data: '{\n\tdefault_quest_shape: "circle"\n}\n' });
  const store = loadQuests(questDir);
  assert.equal(store.chapters[0].defaultQuestShape, '', '章节写空就该是空（表示继承）');
  assert.equal(store.questsById.get('Q_ALLOY').shapeEffective, 'circle', '没写形状的该继承全局 circle');

  // 章节写了自己的形状
  const withChapter = makeStore({
    chapter: '{\n\tdefault_quest_shape: "hexagon"\n\tid: "CH1"\n\tquests: [ { id: "Q_A" x: 0d y: 0d } ]\n}\n',
    data: '{\n\tdefault_quest_shape: "circle"\n}\n',
  });
  const s2 = loadQuests(withChapter.questDir);
  assert.equal(s2.chapters[0].defaultQuestShape, 'hexagon');
  assert.equal(s2.questsById.get('Q_A').shapeEffective, 'hexagon', '章节写的形状该盖过全局');

  // 任务自己写的形状盖过一切
  const own = makeStore({
    chapter: '{\n\tdefault_quest_shape: "hexagon"\n\tid: "CH1"\n\tquests: [ { id: "Q_A" shape: "gear" x: 0d y: 0d } ]\n}\n',
    data: '{\n\tdefault_quest_shape: "circle"\n}\n',
  });
  const s3 = loadQuests(own.questDir);
  assert.equal(s3.questsById.get('Q_A').shapeEffective, 'gear');
  assert.equal(s3.questsById.get('Q_A').shape, 'gear', '自己写的那个字段也得留着');
});

test('大小继承：任务自己 → 章节 → 1', () => {
  const { questDir } = makeStore({
    chapter: '{\n\tdefault_quest_size: 1.5d\n\tid: "CH1"\n\tquests: [ { id: "Q_A" x: 0d y: 0d } { id: "Q_B" size: 2.0d x: 0d y: 0d } ]\n}\n',
  });
  const store = loadQuests(questDir);
  assert.equal(store.chapters[0].defaultQuestSize, 1.5);
  assert.equal(store.questsById.get('Q_A').sizeEffective, 1.5, '该继承章节的 1.5');
  assert.equal(store.questsById.get('Q_B').sizeEffective, 2, '自己写的 2.0 该盖过章节');

  // 什么都没写 → 1
  const plain = makeStore({
    chapter: '{\n\tid: "CH1"\n\tquests: [ { id: "Q_A" x: 0d y: 0d } ]\n}\n',
  });
  const s2 = loadQuests(plain.questDir);
  assert.equal(s2.questsById.get('Q_A').sizeEffective, 1);
});

// ------------------------------- 装饰图体检（2026-11-03）

test('lintQuestImages：没写 image / 宽高为 0 都报出来（warn 级，不算错误）', async () => {
  const { questDir } = makeStore({
    chapter: `{
	id: "CH1"
	images: [
		{
			height: 10.0d
			image: "ftbquests:textures/end_deep_dark.png"
			width: 20.0d
			x: 0.0d
			y: 0.0d
		}
		{
			height: 0.0d
			image: "ftbquests:textures/zero.png"
			width: 0.0d
			x: 0.0d
			y: 0.0d
		}
		{
			height: 4.0d
			width: 4.0d
			x: 0.0d
			y: 0.0d
		}
	]
	quests: [ ]
}`,
  });
  const store = loadQuests(questDir);
  const issues = await lintQuestImages(store, null);
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('ImageBadSize'), '宽高为 0 该报出来');
  assert.ok(codes.includes('ImageNoId'), '没写 image 该报出来');
  assert.ok(!codes.includes('ImageMissing'), '没有实例就不该判「图不存在」');
  assert.ok(issues.every((i) => i.level === 'warn'), '这些都只是警告，不该是错误');
  assert.ok(issues.some((i) => i.where.includes('第一章')), '要说清是哪一章');
});

test('lintQuestImages：给了实例就能判「图在不在」，找得到的不报', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-img-'));
  const assetDir = path.join(root, 'assets', 'ftbquests', 'textures');
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, 'end_deep_dark.png'), Buffer.from([0x89, 0x50]));

  const { questDir } = makeStore({
    chapter: `{
	id: "CH1"
	images: [
		{
			height: 10.0d
			image: "ftbquests:textures/end_deep_dark.png"
			width: 20.0d
			x: 0.0d
			y: 0.0d
		}
		{
			height: 10.0d
			image: "ftbquests:textures/not_there.png"
			width: 20.0d
			x: 0.0d
			y: 0.0d
		}
	]
	quests: [ ]
}`,
  });
  const store = loadQuests(questDir);
  const instance = { modsDir: path.join(root, 'mods'), clientJar: '', assetDirs: [path.join(root, 'assets')] };
  const issues = await lintQuestImages(store, instance);
  const missing = issues.filter((i) => i.code === 'ImageMissing');
  assert.equal(missing.length, 1, '只有找不到的那张该报');
  assert.match(missing[0].message, /not_there\.png/);
  assert.ok(!issues.some((i) => i.code === 'ImageMissing' && /end_deep_dark/.test(i.message)), '找到的不该报');
});

// ------------------------------------------------- 任务「给人看的名字」
// 2026-11-11 用户报障：「显示前置后置任务的时候用任务标题不要用编号」。
// 实测真实包里有一批任务游戏里本来就没标题，前置/后续列表会显示成 16 位十六进制。

test('questDisplayName：有真标题就用真标题', () => {
  assert.equal(questDisplayName({ id: 'A1', title: '打铁', titleSource: 'lang' }), '打铁');
  // 物品名当标题（FTB 的常规做法）也算真标题
  assert.equal(questDisplayName({ id: 'A2', title: 'minecraft:anvil', titleSource: 'item' }), 'minecraft:anvil');
});

test('questDisplayName：没标题时退回副标题（ATM10Sky 里 26 个这种）', () => {
  // 真实样本：36DEA17CBB696CC7 在 lang 里没有标题，只有副标题
  assert.equal(
    questDisplayName({ id: '36DEA17CBB696CC7', title: '36DEA17CBB696CC7', titleSource: 'id', subtitle: 'Becoming a Network Admin!' }),
    'Becoming a Network Admin!',
  );
});

test('questDisplayName：没标题没副标题时退回图标名', () => {
  assert.equal(
    questDisplayName({ id: 'X1', title: 'X1', titleSource: 'id', icon: 'minecraft:creeper_spawn_egg' }),
    'creeper_spawn_egg',
  );
});

test('questDisplayName：三样都没有时用 untitledN（用户拍板的命名，比编号好认）', () => {
  // 实测 ATM10Sky 有 78 个这种「纯打勾」任务，真的没有任何可显示的名字。
  // 用户 2026-11-11：「有些任务没标题是正常的，标记 untitled，按章节分每个章节都重置」。
  assert.equal(
    questDisplayName({ id: '2EB7784D5296F410', title: '2EB7784D5296F410', titleSource: 'id', untitledLabel: 'untitled3' }),
    'untitled3',
  );
  // 连 untitledLabel 都没有时（老调用方自己拼的对象）才退回 ID，且绝不能返回空串
  const name = questDisplayName({ id: '2EB7784D5296F410', title: '2EB7784D5296F410', titleSource: 'id' });
  assert.equal(name, '2EB7784D5296F410');
  assert.ok(name.length > 0, '绝不能返回空串');
});

test('untitled 编号按章节重置：每章都从 untitled1 开始，且按文件里的任务顺序发号', () => {
  // 三章各放两个「没名字」的任务，中间夹一个有名任务（不该占用编号）
  const mk = (chId, prefix) => `{
	id: "${chId}"
	order_index: 0
	filename: "f${chId}"
	quests: [
		{ id: "${prefix}AAA", x: 0d, y: 0d, tasks: [{ id: "t1", type: "checkmark" }] }
		{ id: "${prefix}BBB", x: 1d, y: 0d, tasks: [{ id: "t2", type: "checkmark" }] }
	]
}
`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-untitled-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(questDir, 'lang'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), mk('CH1', 'A1'), 'utf8');
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch2.snbt'), mk('CH2', 'B2'), 'utf8');
  // 第二章的副标题给其中一条，它就不该拿 untitled 号
  fs.writeFileSync(
    path.join(questDir, 'lang', 'en_us.snbt'),
    `{ quest.B2AAA.quest_subtitle: "有副标题的说明" }\n`,
    'utf8',
  );

  const store = loadQuests(questDir, { locale: 'en_us' });
  const byId = (id) => store.questsById.get(id);

  // 第一章：按文件顺序 untitled1、untitled2
  assert.equal(byId('A1AAA').untitledLabel, 'untitled1');
  assert.equal(byId('A1BBB').untitledLabel, 'untitled2');
  // 第二章：计数重置 —— 有副标题的那条不占号，所以另一条拿到 untitled1
  assert.equal(byId('B2AAA').untitledLabel, undefined, '有副标题的说明性任务不该被编号');
  assert.equal(byId('B2BBB').untitledLabel, 'untitled1', '每章重置，第二章该从 untitled1 重新开始');

  // 显示名走的是 untitledN
  assert.equal(questDisplayName(byId('A1AAA')), 'untitled1');
  // 真标题 / 副标题照旧优先
  assert.equal(questDisplayName(byId('B2AAA')), '有副标题的说明');
});

test('questDisplayName：titleSource 是 lang 但标题恰好等于 ID 时，仍继续往下找', () => {
  // 理论上的边界：文件里真把 ID 当标题写了。这种等于没写，继续找副标题。
  assert.equal(
    questDisplayName({ id: 'Y1', title: 'Y1', titleSource: 'lang', subtitle: '真实说明' }),
    '真实说明',
  );
});

// ------------------------------------------------- 颜色码清洗（2026-11-11「任务名字有很多乱码」）

test('stripMcFormatting：标准颜色 / 格式码要去掉', () => {
  assert.equal(stripMcFormatting('&6&lApotheosis Adventure'), 'Apotheosis Adventure');
  assert.equal(stripMcFormatting('&fApothic Spawners'), 'Apothic Spawners');
  assert.equal(stripMcFormatting('&mVials and&r &8Sigils'), 'Vials and Sigils');
  assert.equal(stripMcFormatting('&9Gem Dust'), 'Gem Dust');
});

test('stripMcFormatting：★ 转义的字面 & 绝不能吃掉（实测重度机械症有这种名字）', () => {
  // 真数据：`"Ludicrite \\& Ridiculite"` = 「Ludicrite & Ridiculite」
  assert.equal(stripMcFormatting('Ludicrite \\& Ridiculite'), 'Ludicrite & Ridiculite');
  assert.equal(stripMcFormatting('&6&lForbidden \\& Arcanus'), 'Forbidden & Arcanus');
  // 普通 & 后跟空格也不是颜色码
  assert.equal(stripMcFormatting('A & B'), 'A & B');
});

test('stripMcFormatting：★ 大写 &A 是名字里的字面 &，不是颜色码（实测 1 例）', () => {
  // 真数据：`"Jewelry&Accessories(@Iron's Gems 'n Jewelry)"`
  // MC 的颜色码全是小写；大写是作者拿 & 当连接符。不加 i 标志就是为了这个。
  assert.equal(stripMcFormatting('Jewelry&Accessories'), 'Jewelry&Accessories');
});

test('stripMcFormatting：十六进制颜色 &#rrggbb 要整段吃掉', () => {
  assert.equal(stripMcFormatting('&#ff8800Custom Color'), 'Custom Color');
  assert.equal(stripMcFormatting('&#AABBCCName'), 'Name');
});

test('stripMcFormatting：空值与非字符串不抛', () => {
  assert.equal(stripMcFormatting(''), '');
  assert.equal(stripMcFormatting(null), '');
  assert.equal(stripMcFormatting(undefined), '');
});

test('任务标题与章节名加载时就去掉颜色码，但 rawTitle 保留原样', () => {
  const chapter = `{
	id: "CH1"
	order_index: 0
	filename: "ch1"
	quests: [
		{ id: "Q1", x: 0d, y: 0d, tasks: [{ id: "t1", type: "checkmark" }] }
	]
}
`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-color-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(questDir, 'lang'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), chapter, 'utf8');
  fs.writeFileSync(
    path.join(questDir, 'lang', 'en_us.snbt'),
    `{
	chapter.CH1.title: "&fChapter &6One"
	quest.Q1.title: "&6&lGold Rush"
	quest.Q1.quest_subtitle: "&7a &lsubtle &rsubtitle"
}
`,
    'utf8',
  );

  const store = loadQuests(questDir, { locale: 'en_us' });
  const q = store.questsById.get('Q1');
  assert.equal(q.title, 'Gold Rush', '任务标题该去掉颜色码');
  assert.equal(q.rawTitle, '&6&lGold Rush', 'rawTitle 必须保留文件原样（写盘比对靠它）');
  assert.equal(q.subtitle, 'a subtle subtitle');
  assert.equal(q.rawSubtitle, '&7a &lsubtle &rsubtitle');
  assert.equal(store.chapters[0].title, 'Chapter One', '章节名也要清');
});

test('没标题不再算问题（用户拍板「有些任务没标题是正常的」）', () => {
  const chapter = `{
	id: "CH1"
	order_index: 0
	filename: "ch1"
	quests: [
		{ id: "Q1", x: 0d, y: 0d, tasks: [{ id: "t1", type: "checkmark" }] }
	]
}
`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-notitle-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), chapter, 'utf8');

  const store = loadQuests(questDir, { locale: 'en_us' });
  const issues = lintQuests(store);
  // 实测以前这里会冒一条 info 级 QuestNoExplicitTitle；ATM10Sky 一次刷 110 条，
  // 把真问题全盖住了。现在不报 —— 界面上它显示成 untitledN，已经交代过了。
  assert.ok(!issues.some((i) => i.code === 'QuestNoExplicitTitle'), '没标题不该再报');
});

// ------------------------------------------------- 颜色渲染（2026-11-11「把颜色的显示也做出来」）
// 语义严格照 MC：颜色码换色**并重置样式**；格式码只叠样式不动颜色；&r 全重置。

test('parseMcFormatting：&6&l 出橙色 + 粗体', () => {
  const spans = parseMcFormatting('&6&lApotheosis Adventure');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, 'Apotheosis Adventure');
  assert.equal(spans[0].color, '#ffaa00');
  assert.equal(spans[0].bold, true);
});

test('parseMcFormatting：★ 颜色码会重置样式（MC 的真实行为，最容易写错）', () => {
  // `&6&lGold&2Green` → Gold 是橙色粗体；Green 是绿色**且不粗**（&2 重置了 bold）
  const spans = parseMcFormatting('&6&lGold&2Green');
  assert.equal(spans.length, 2);
  assert.deepEqual({ t: spans[0].text, c: spans[0].color, b: spans[0].bold }, { t: 'Gold', c: '#ffaa00', b: true });
  assert.deepEqual({ t: spans[1].text, c: spans[1].color, b: spans[1].bold }, { t: 'Green', c: '#00aa00', b: false },
    '颜色码必须清掉粗体，否则 Green 会跟着变粗 —— 和游戏里不一样');
});

test('parseMcFormatting：格式码只叠样式，不动颜色', () => {
  const spans = parseMcFormatting('&6Orange&lBold');
  assert.equal(spans.length, 2);
  assert.equal(spans[1].color, '#ffaa00', '&l 不该改颜色');
  assert.equal(spans[1].bold, true);
});

test('parseMcFormatting：&r 全部重置回默认', () => {
  const spans = parseMcFormatting('&2Green&rReset');
  assert.equal(spans[1].text, 'Reset');
  assert.equal(spans[1].color, '', '&r 之后没有颜色（走默认前景色）');
  assert.equal(spans[1].bold, false);
});

test('parseMcFormatting：&m 删除线、&o 斜体、&n 下划线', () => {
  // 每个 &r 后面只有空格级的空档，flush 不会产出空段，所以是 4 段不是 8 段。
  const sp = parseMcFormatting('&mA&r&oB&r&nC&r&lD');
  assert.equal(sp.length, 4);
  assert.equal(sp[0].strike, true, '&m 删除线');
  assert.equal(sp[1].italic, true, '&o 斜体');
  assert.equal(sp[2].underline, true, '&n 下划线');
  assert.equal(sp[3].bold, true, '&l 粗体');
  // 每个 &r 都把上一个样式清干净了
  assert.equal(sp[1].strike, false, '&r 之后不该还有删除线');
  assert.equal(sp[2].italic, false);
  assert.equal(sp[3].underline, false);
});

test('parseMcFormatting：十六进制颜色 &#rrggbb', () => {
  const spans = parseMcFormatting('&#ff8800Custom');
  assert.equal(spans[0].color, '#ff8800');
  assert.equal(spans[0].text, 'Custom');
});

test('parseMcFormatting：&z 彩虹色给个静态紫（FTB 的 Rainbow 系列实测 8 处）', () => {
  const spans = parseMcFormatting('&zRainbow Core');
  assert.equal(spans[0].color, '#ff55ff');
  assert.equal(spans[0].text, 'Rainbow Core');
});

test('parseMcFormatting：&k 乱码码丢掉，文字照常显示', () => {
  const spans = parseMcFormatting('&kObfuscated Text');
  assert.equal(spans[0].text, 'Obfuscated Text');
  assert.equal(spans[0].color, '');
});

test('parseMcFormatting：★ 转义 \\& 与大写 &A 都不能被当成格式码', () => {
  const esc = parseMcFormatting('Ludicrite \\& Ridiculite');
  assert.equal(esc.length, 1);
  assert.equal(esc[0].text, 'Ludicrite & Ridiculite');
  assert.equal(esc[0].color, '');

  const upper = parseMcFormatting('Jewelry&Accessories');
  assert.equal(upper.length, 1, '&A 大写得当字面 &，不许切成两段染绿');
  assert.equal(upper[0].text, 'Jewelry&Accessories');
});

test('parseMcFormatting：纯文字返回一段、没有样式（界面走快路径）', () => {
  const spans = parseMcFormatting('Plain Title');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, 'Plain Title');
  assert.equal(spans[0].color, '');
  assert.equal(hasMcFormatting(spans), false);
  assert.equal(hasMcFormatting(parseMcFormatting('&6Colored')), true);
});

test('stripMcFormatting 和 parseMcFormatting 结果一致（前者是后者的纯文本投影）', () => {
  for (const s of ['&6&lApotheosis', '&9Gem Dust', '&mVials&r &8Sigils', 'Ludicrite \\& Rid', '&zRainbow', '&#ff8800Hex', 'Plain']) {
    assert.equal(stripMcFormatting(s), parseMcFormatting(s).map((x) => x.text).join('').trim(), s);
  }
});

test('标题 / 副标题 / 章节名都带 titleSpans 供界面上色，raw 值仍保留', () => {
  const chapter = `{
	id: "CH1"
	order_index: 0
	filename: "ch1"
	quests: [
		{ id: "Q1", x: 0d, y: 0d, tasks: [{ id: "t1", type: "checkmark" }] }
	]
}
`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-spans-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(questDir, 'lang'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), chapter, 'utf8');
  fs.writeFileSync(
    path.join(questDir, 'lang', 'en_us.snbt'),
    `{
	chapter.CH1.title: "&fChapter &6One"
	quest.Q1.title: "&6&lGold Rush"
	quest.Q1.quest_subtitle: "&7a &lsubtle &rsubtitle"
}
`,
    'utf8',
  );

  const store = loadQuests(questDir, { locale: 'en_us' });
  const q = store.questsById.get('Q1');
  assert.equal(q.title, 'Gold Rush', '纯文本字段仍然干净');
  assert.equal(q.rawTitle, '&6&lGold Rush', 'raw 保留原样');
  assert.equal(q.titleSpans[0].color, '#ffaa00', 'titleSpans 带颜色');
  assert.equal(q.titleSpans[0].bold, true);
  assert.equal(q.subtitleSpans[0].color, '#aaaaaa', '副标题 &7 是灰色');
  assert.equal(store.chapters[0].titleSpans.some((s) => s.color), true, '章节名的 &6 要出颜色');
});

// ------------------------------------------------- 体检降噪（2026-11-11 用户「为什么还有任务在报错」）

test('奖励缺字段降为 warn：游戏里只是这一项拿空，任务照样能完成', () => {
  const chapter = `{
	id: "CH1"
	order_index: 0
	filename: "ch1"
	quests: [
		{
			id: "Q1"
			x: 0d
			y: 0d
			tasks: [{ id: "t1", type: "checkmark" }]
			rewards: [{ id: "r1", type: "loot", exclude_from_claim_all: true }]
		}
	]
}
`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-lint-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), chapter, 'utf8');
  const store = loadQuests(questDir, { locale: 'en_us' });
  const hit = lintQuests(store).find((i) => i.code === 'RewardMissingField');
  assert.ok(hit, '缺 table_id 还是该提一句');
  assert.equal(hit.level, 'warn', '只是这一项拿空，不是任务坏了 —— 不该报 error');
  assert.match(hit.message, /拿空/);
});

test('★ 战利品表的字段名是 table_id（下划线），不是 tableId', () => {
  // 真数据（ATM10Sky apotheosis_2.snbt）：rewards: [{ table_id: 487623848494439020L, type: "random" }]
  // 拿驼峰 tableId 去读会一个都读不到 —— 249 个 loot 奖励会被误判成「全缺 table_id」。
  const chapter = `{
	id: "CH1"
	order_index: 0
	filename: "ch1"
	quests: [
		{
			id: "Q1"
			x: 0d
			y: 0d
			tasks: [{ id: "t1", type: "checkmark" }]
			rewards: [{ id: "r1", type: "random", table_id: 487623848494439020L, exclude_from_claim_all: true }]
		}
	]
}
`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-tableid-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), chapter, 'utf8');
  const store = loadQuests(questDir, { locale: 'en_us' });
  const q = store.questsById.get('Q1');
  const spec = q.rewards[0] && specFromReward(q.rewards[0]);
  assert.ok(spec?.tableId, '抽出来的 spec 该带 tableId');
  // 487623848494439020L 的十六进制是 6C4634E81851A6C（FTB 的 reward_tables/<hex>.snbt 用这个当 ID）
  assert.equal(String(spec.tableId).toUpperCase().replace(/^0+/, ''), '6C4634E81851A6C', '应该还原成十六进制');
  // 有 table_id 的不该报缺字段
  assert.equal(lintQuests(store).filter((i) => i.code === 'RewardMissingField').length, 0);
});

// ===== 2026-11-12 第二批：依赖的四种满足方式 =====
// FTB 的 dependency_requirement 有四种（DependencyRequirement.java），
// 再加一个优先级更高的 min_required_dependencies（「至少 N 个」）。
// 判定逻辑照抄 Quest.checkDependencies()，真包实测 ATM10Sky 有 44 处不是默认值。

test('依赖四种方式都认得，不认识的写法退回默认（游戏 NAME_MAP 查不到也回默认）', () => {
  assert.deepEqual(DEPENDENCY_REQUIREMENTS.map((r) => r.id),
    ['all_completed', 'one_completed', 'all_started', 'one_started']);
  // needOne / needCompletion 这四组值照源码抄，抄错就把「或」当成「与」了
  assert.deepEqual(DEPENDENCY_REQUIREMENTS.map((r) => [r.needOne, r.needCompletion]), [
    [false, true], // all_completed
    [true, true],  // one_completed
    [false, false], // all_started
    [true, false],  // one_started
  ]);
  assert.equal(dependencyRequirementOf('one_completed').needOne, true);
  assert.equal(dependencyRequirementOf('all_started').needCompletion, false);
  // 空串 / 胡写 / undefined 一律退回默认
  for (const bad of ['', '  ', 'one_complete', 'ONE_COMPLETED', undefined, null, 123]) {
    assert.equal(dependencyRequirementOf(bad).id, 'all_completed', `${String(bad)} 应该退回默认`);
  }
});

test('dependencyStatus：all_completed 要全做完、one_completed 一个就够', () => {
  const all = { dependencies: ['A', 'B'], dependencyRequirement: 'all_completed', minRequiredDependencies: 0 };
  assert.equal(dependencyStatus(all, (d) => ['A', 'B'].includes(d)).ok, true);
  const half = dependencyStatus(all, (d) => d === 'A');
  assert.equal(half.ok, false, 'all_completed 只做完一个不行');
  assert.deepEqual(half.unsatisfied, ['B']);
  assert.equal(half.satisfied, 1);
  assert.equal(half.checked, 2);
  assert.equal(half.mode, 'all');

  const one = { ...all, dependencyRequirement: 'one_completed' };
  assert.equal(dependencyStatus(one, (d) => d === 'A').ok, true, 'one_completed 做完一个就够');
  assert.equal(dependencyStatus(one, () => false).ok, false, 'one_completed 一个都没做完不行');
  assert.equal(dependencyStatus(one, (d) => d === 'A').mode, 'one');
});

test('dependencyStatus：min_required_dependencies 优先级最高，连依赖方式都不看', () => {
  const base = { dependencies: ['A', 'B', 'C'], dependencyRequirement: 'all_completed', minRequiredDependencies: 2 };
  // 只做完 1 个 → 不够
  assert.equal(dependencyStatus(base, (d) => d === 'A').ok, false);
  // 做完 2 个 → 够（虽然 all_completed 本来要 3 个）
  const two = dependencyStatus(base, (d) => d === 'A' || d === 'B');
  assert.equal(two.ok, true, 'min=2 时做完 2 个就该过，不该要求全做完');
  assert.equal(two.mode, 'at_least');
  assert.equal(two.minRequired, 2);
  // 连 one_completed 也不能把门槛降到 1
  const oneMode = { ...base, dependencyRequirement: 'one_completed' };
  assert.equal(dependencyStatus(oneMode, (d) => d === 'A').ok, false, 'min=2 压过 one_completed');
});

test('dependencyStatus：空前置的边界照抄 FTB 的 allMatch/anyMatch 语义', () => {
  // 没前置、没 min → allMatch(空流) = true，开局就能做
  const none = { dependencies: [], dependencyRequirement: 'all_completed', minRequiredDependencies: 0 };
  assert.equal(dependencyStatus(none, () => false).ok, true);
  // 没前置但 min=1 → count()==1 对空流是 false（0 != 1），永远开不了
  const impossible = { ...none, minRequiredDependencies: 1 };
  assert.equal(dependencyStatus(impossible, () => false).ok, false);
  // 没前置 + one_completed → anyMatch(空流) = false
  const oneEmpty = { ...none, dependencyRequirement: 'one_completed' };
  assert.equal(dependencyStatus(oneEmpty, () => true).ok, false);
});

test('dependencyStatusAll：看「完成」还是「开始」由每个任务自己的依赖方式决定', () => {
  // A 已完成；B 只开始没完成
  const store = {
    quests: [
      { id: 'Q1', dependencies: ['A'], dependencyRequirement: 'all_completed', minRequiredDependencies: 0 },
      { id: 'Q2', dependencies: ['B'], dependencyRequirement: 'all_started', minRequiredDependencies: 0 },
      { id: 'Q3', dependencies: ['B'], dependencyRequirement: 'one_started', minRequiredDependencies: 0 },
    ],
  };
  const done = new Set(['A']);
  const started = new Set(['A', 'B']);
  const all = dependencyStatusAll(store, done, started);
  assert.equal(all.get('Q1').ok, true, 'A 完成了');
  // Q2 是 all_started：B 已经开始 → 算满足，哪怕没做完
  assert.equal(all.get('Q2').ok, true, 'all_started 只看开始');
  assert.equal(all.get('Q3').ok, true, 'one_started 只看开始');
  // 不传 started 时退回「完成的才算开始」
  const noStarted = dependencyStatusAll(store, done);
  assert.equal(noStarted.get('Q2').ok, false, '没传 started 时 B 不算开始');
});

test('loadQuests 把 dependency_requirement / min_required_dependencies 读进任务对象', () => {
  const chapter = `{
\tid: "CH1"
\tfilename: "ch1"
\tgroup: "G1"
\tquests: [
\t\t{ id: "Q_A", x: 0d, y: 0d, tasks: [{ id: "t1", type: "checkmark" }] }
\t\t{
\t\t\tdependencies: ["Q_A"]
\t\t\tdependency_requirement: "one_completed"
\t\t\tid: "Q_B"
\t\t\tx: 1d
\t\t\ty: 0d
\t\t\ttasks: [{ id: "t2", type: "checkmark" }]
\t\t}
\t\t{
\t\t\tdependencies: ["Q_A"]
\t\t\tid: "Q_C"
\t\t\tmin_required_dependencies: 1
\t\t\tx: 2d
\t\t\ty: 0d
\t\t\ttasks: [{ id: "t3", type: "checkmark" }]
\t\t}
\t]
}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-depreq-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), chapter, 'utf8');
  const store = loadQuests(questDir, { locale: 'en_us' });

  assert.equal(store.questsById.get('Q_A').dependencyRequirement, 'all_completed', '没写就是默认');
  assert.equal(store.questsById.get('Q_A').minRequiredDependencies, 0);
  assert.equal(store.questsById.get('Q_B').dependencyRequirement, 'one_completed', '读到了 one_completed');
  assert.equal(store.questsById.get('Q_C').minRequiredDependencies, 1, '读到了至少 1 个');
  assert.equal(store.questsById.get('Q_C').dependencyRequirement, 'all_completed', 'Q_C 没写方式，回默认');
});

test('loadQuests 读进 optional / invisible / can_repeat（三态，不能归成布尔）', () => {
  // 真包实测 ATM10Sky：optional 633 处、invisible 51 处、can_repeat 1 处。
  // 这三个都会改变玩家实际体验，但以前界面完全看不出来。
  const chapter = `{
\tid: "CH1"
\tfilename: "ch1"
\tgroup: "G1"
\tquests: [
\t\t{ id: "Q_OPT", x: 0d, y: 0d, optional: true, tasks: [{ id: "t1", type: "checkmark" }] }
\t\t{ id: "Q_INV", x: 1d, y: 0d, invisible: true, tasks: [{ id: "t2", type: "checkmark" }] }
\t\t{ id: "Q_REP_T", x: 2d, y: 0d, can_repeat: true, tasks: [{ id: "t3", type: "checkmark" }] }
\t\t{ id: "Q_REP_F", x: 3d, y: 0d, can_repeat: false, tasks: [{ id: "t4", type: "checkmark" }] }
\t\t{ id: "Q_NONE", x: 4d, y: 0d, tasks: [{ id: "t5", type: "checkmark" }] }
\t]
}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-flags-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), chapter, 'utf8');
  const store = loadQuests(questDir, { locale: 'en_us' });

  assert.equal(store.questsById.get('Q_OPT').optional, true);
  assert.equal(store.questsById.get('Q_OPT').invisible, false, '没写就是 false');
  assert.equal(store.questsById.get('Q_INV').invisible, true);

  // ★ can_repeat 是三态：true / false / **null（没写 = 跟随章节 default_repeatable）**。
  //   归成布尔的话，「跟随章节」会被写成「明确不可重复」，读一遍再写回就改了作者的意思。
  assert.equal(store.questsById.get('Q_REP_T').canRepeat, true);
  assert.equal(store.questsById.get('Q_REP_F').canRepeat, false, '写了 false 要能区分出来');
  assert.equal(store.questsById.get('Q_NONE').canRepeat, null, '没写就是 null，不是 false');

  // 没写的任务三个字段都是安全默认
  const none = store.questsById.get('Q_NONE');
  assert.equal(none.optional, false);
  assert.equal(none.invisible, false);
});

test('体检：min_required_dependencies 比实际前置还多会报 error（那个任务永远开不了）', () => {
  const chapter = `{
\tid: "CH1"
\tfilename: "ch1"
\tgroup: "G1"
\tquests: [
\t\t{ id: "Q_A", x: 0d, y: 0d, tasks: [{ id: "t1", type: "checkmark" }] }
\t\t{
\t\t\tdependencies: ["Q_A"]
\t\t\tid: "Q_BAD"
\t\t\tmin_required_dependencies: 3
\t\t\tx: 1d
\t\t\ty: 0d
\t\t\ttasks: [{ id: "t2", type: "checkmark" }]
\t\t}
\t]
}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-mindeps-'));
  const questDir = path.join(root, 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), chapter, 'utf8');
  const store = loadQuests(questDir, { locale: 'en_us' });
  const issues = lintQuests(store).filter((i) => i.code === 'QuestMinDepsTooMany');
  assert.equal(issues.length, 1, '该报一条');
  assert.equal(issues[0].level, 'error', '永远开不了是 error 不是 warn');
  assert.equal(issues[0].questId, 'Q_BAD', '要带定位，界面上能点过去');
  // 3 > 1 个前置 → 永远凑不齐
  assert.match(issues[0].message, /至少 3 个/, '文案要说清是「至少 3 个」');
});
