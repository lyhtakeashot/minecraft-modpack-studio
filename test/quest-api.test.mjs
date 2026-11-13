/**
 * 「任务书」接口（lib/host/quest-api.js）的单测。
 *
 * 这块最容易出错的地方是「一个操作要改两个文件」：文字在 lang/*.snbt，位置在
 * chapters/*.snbt。所以测试重点有三条：
 *   1. 改标题只该动 lang 文件，改位置只该动章节文件，两样都改就该两个都动；
 *   2. 预览阶段绝对不能碰盘；
 *   3. 写盘要留备份，写完重读必须真的是新值。
 *
 * 全程在临时目录里造假包，不碰任何真实整合包。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { McError } from '../packages/core/errors.js';
// 造 jar 用（2026-11-12：验证「标题里的物品 ID 要翻成中文名」那条链路）
import { makeZip } from './make-zip.mjs';
import {
  buildQuestPlan,
  handleChapterAddApply,
  handleChapterAddPreview,
  handleQuestAddApply,
  handleQuestAddPreview,
  handleQuestApply,
  handleQuestBook,
  handleQuestCanvas,
  handleQuestDetail,
  handleQuestImageApply,
  handleQuestImagePreview,
  handleQuestList,
  handleQuestNodeApply,
  handleQuestNodeDeleteApply,
  handleQuestNodeDeletePreview,
  handleQuestNodePreview,
  handleQuestPreview,
  // 蓝图式编辑（2026-11-09）：拖进节点 / 复制节点 / 空白处生成节点
  handleQuestNodeItemsPreview,
  handleQuestNodeItemsApply,
  handleQuestClonePreview,
  handleQuestCloneApply,
  handleQuestSpawnPreview,
  handleQuestSpawnApply,
  resetQuestCache,
} from '../lib/host/quest-api.js';

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
			rewards: [
				{
					id: "R0000001"
					type: "xp"
					xp: 10
				}
			]
		}
	]
}
`;

const LANG_ZH = `{
	"quest.BBBB0001.title": "打铁"
	"quest.BBBB0001.quest_desc": ["先把铁矿烧了", "再做铁锭"]
}
`;

const LANG_EN = `{
	"quest.BBBB0001.title": "Iron"
}
`;

/**
 * 造一个假整合包：一个实例 + 一套最小的 FTB Quests 任务书。
 * @param {{config?: boolean, lang?: string[], groups?: boolean, chapter?: string}} [opts]
 */
function makePack(opts = {}) {
  const { config = true, lang = ['zh_cn', 'en_us'], groups = false, chapter = CHAPTER } = opts;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-quest-'));
  const versionDir = path.join(root, 'versions', 'TestPack');
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(
    path.join(versionDir, 'TestPack.json'),
    JSON.stringify({ id: 'TestPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
    'utf8',
  );
  if (!config) return { root, versionDir };

  const questDir = path.join(versionDir, 'config', 'ftbquests', 'quests');
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), chapter, 'utf8');
  if (groups) {
    fs.writeFileSync(
      path.join(questDir, 'chapter_groups.snbt'),
      `{\n\tchapter_groups: [\n\t\t{\n\t\t\tid: "G1"\n\t\t\ttitle: "起步"\n\t\t}\n\t]\n}\n`,
      'utf8',
    );
  }
  if (lang.length) {
    fs.mkdirSync(path.join(questDir, 'lang'), { recursive: true });
    if (lang.includes('zh_cn')) fs.writeFileSync(path.join(questDir, 'lang', 'zh_cn.snbt'), LANG_ZH, 'utf8');
    if (lang.includes('en_us')) fs.writeFileSync(path.join(questDir, 'lang', 'en_us.snbt'), LANG_EN, 'utf8');
  }
  return { root, versionDir, questDir };
}

function get(suffix, params) {
  const qs = new URLSearchParams(params).toString();
  return new Request(`http://localhost/api/mcstudio${suffix}?${qs}`);
}

function post(suffix, body) {
  return new Request(`http://localhost/api/mcstudio${suffix}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function throwsCode(fn, code) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof McError, `应该抛 McError，实际是 ${error?.constructor?.name}`);
    assert.equal(error.code, code, `code 不对：${error.message}`);
    return error;
  }
  assert.fail(`应该抛 ${code}，但没有抛`);
}

const read = (file) => fs.readFileSync(file, 'utf8');

// ————————————————————————— 看 —————————————————————————

test('任务书：概览能列出章节、任务数、语言', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));
  assert.equal(book.questCount, 2);
  assert.equal(book.chapterCount, 1);
  assert.equal(book.locale, 'zh_cn');
  assert.deepEqual(book.locales, ['en_us', 'zh_cn']);
  assert.equal(book.chapters[0].questCount, 2);
  // 只有 BBBB0001 在 lang 里有标题，BBBB0002 在游戏里显示的是物品名
  assert.equal(book.explicitTitles, 1);
  assert.equal(book.issues.errorCount, 0);
  assert.ok(book.questDir.endsWith(path.join('config', 'ftbquests', 'quests')));
});

test('任务书：概览能报出悬空依赖和分组', async () => {
  resetQuestCache();
  const bad = CHAPTER.replace('dependencies: ["BBBB0001"]', 'dependencies: ["NOSUCH0000000001"]');
  const { versionDir } = makePack({ groups: true, chapter: bad });
  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));
  assert.equal(book.issues.danglingCount, 1);
  assert.equal(book.issues.dangling[0].missing, 'NOSUCH0000000001');
  assert.deepEqual(book.groups, [{ id: 'G1', title: '起步' }]);
  // 2026-11-11：悬空依赖降为 warn（不是 error）—— 实测那 9 条全指向任务条件 ID，
  // 而且 FTB 会 removeInvalidDependencies()，任务照常能完成。
  assert.equal(book.issues.errorCount, 0);
  assert.ok(book.issues.warnCount >= 1, '该计入警告');
});

test('任务书：/questbook 的 problems 每条都透出 questId/chapterId（界面靠它跳转）', async () => {
  // 2026-11-12：界面「点警告跳到对应任务」靠的就是这两个字段。
  // core 的 lintQuests 现在给了，接口层是原样透传的 —— 这条钉子钉在接口边界上，
  // 防止以后有人给 problems 加一层字段白名单、把定位悄悄过滤掉。
  resetQuestCache();
  const bad = CHAPTER.replace('dependencies: ["BBBB0001"]', 'dependencies: ["NOSUCH0000000001"]');
  const { versionDir } = makePack({ groups: true, chapter: bad });
  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));

  const dangling = book.issues.problems.find((p) => p.code === 'QuestDanglingDependency');
  assert.ok(dangling, `problems 里该有悬空依赖，实际：${JSON.stringify(book.issues.problems)}`);
  // 这个包里写坏依赖的是 BBBB0002（它的 dependencies 里那句被替换成了 NOSUCH…）
  assert.equal(dangling.questId, 'BBBB0002', '任务级问题必须带 questId');
  assert.equal(dangling.chapterId, 'AAAA0001', '还要带 chapterId（跳转前要先切章节页签）');

  // 章节级问题只带 chapterId，不能带 questId —— 带了界面就会跳到不存在的任务上
  const chapterLevel = book.issues.problems.filter((p) => p.code === 'ChapterUnknownGroup' || p.code === 'ChapterEmpty');
  for (const p of chapterLevel) {
    assert.equal(p.questId, undefined, `${p.code} 不该有 questId`);
  }
});

test('任务书：列表能按章节过滤、按关键词搜', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const all = await handleQuestList(get('/quests', { dir: versionDir }));
  assert.equal(all.total, 2);
  const byChapter = await handleQuestList(get('/quests', { dir: versionDir, chapter: 'AAAA0001' }));
  assert.equal(byChapter.total, 2);
  const none = await handleQuestList(get('/quests', { dir: versionDir, chapter: 'NOSUCH' }));
  assert.equal(none.total, 0);
  // 搜中文标题
  const hit = await handleQuestList(get('/quests', { dir: versionDir, q: '打铁' }));
  assert.equal(hit.total, 1);
  assert.equal(hit.items[0].id, 'BBBB0001');
  // 搜任务要求里的物品
  const byItem = await handleQuestList(get('/quests', { dir: versionDir, q: 'minecraft:gold_ingot' }));
  assert.equal(byItem.total, 1);
  assert.equal(byItem.items[0].id, 'BBBB0002');
});

test('任务书：没写标题的任务，标题要给物品的**中文名**而不是物品 ID（2026-11-12 真 bug）', async () => {
  // 用户原话：「我记得 atm 空岛这个整合包是有中文汉化的啊，为什么你这边很多任务
  // 都是英文的，比如 ae2 系列的任务」。
  //
  // 实测根因：那个包 3658 个任务里 1738 个（47.5%）作者没写标题，
  // FTB 的规矩是「显示要交的那个物品的名字」。core 是纯函数不碰 jar，
  // 只能给出物品 ID（`ae2:energy_acceptor`）→ 界面上看着像没汉化。
  // 中文名其实就在 jar 的 zh_cn.json 里。
  //
  // 这条用例钉住：接口层要把 ID 翻成中文名。
  resetQuestCache();
  const { versionDir } = makePack();
  // 造一个带中文名的 jar 放进 mods/
  const modsDir = path.join(versionDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'demo.jar'), makeZip({
    'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="demo"\nversion="1.0"\ndisplayName="演示 Mod"\n',
    // ★ 必须给物品模型：索引是按 `assets/<ns>/models/item/<名字>.json` 枚举物品的，
    //   只写 lang 文件的话这个物品根本不会进索引（nameOf 一律空串）。
    //   2026-11-12 第一次写这条用例就踩了，白折腾一轮。
    //
    //   要造的是 `minecraft:gold_ingot`（测试包里任务 BBBB0002 要交的物品），
    //   所以模型和 lang 都挂在 `minecraft` 命名空间下。
    'assets/minecraft/models/item/gold_ingot.json': '{"parent":"item/generated","textures":{"layer0":"minecraft:item/gold_ingot"}}',
    'assets/minecraft/textures/item/gold_ingot.png': 'stub',
    'assets/minecraft/lang/zh_cn.json': JSON.stringify({ 'item.minecraft.gold_ingot': '金锭' }),
  }));

  // BBBB0002 没写标题，FTB 会拿它要交的物品（minecraft:gold_ingot）当标题
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0002' }));
  assert.equal(detail.titleSource, 'item', '前提：这个任务确实是「拿物品名当标题」那种');
  assert.equal(detail.titleItem, 'minecraft:gold_ingot');
  assert.equal(detail.title, '金锭', `★ 标题该是物品中文名，实际是「${detail.title}」`);

  // 画布节点上的标题同理（不然画布上满屏 ae2:xxx）
  const canvas = await handleQuestCanvas(get('/quest/canvas', { dir: versionDir }));
  const nodes = canvas.chapters.flatMap((c) => c.nodes ?? []);
  const node = nodes.find((n) => n.id === 'BBBB0002');
  assert.ok(node, '画布上该有 BBBB0002');
  assert.equal(node.title, '金锭', '画布节点标题也要中文名');
  // rawTitle 保持原值（改名表单要拿它预填，不能被中文名污染）
  assert.equal(node.rawTitle, 'minecraft:gold_ingot', 'rawTitle 必须是文件里的真值');

  // 任务列表（左栏搜索 / MCP 工具走这条）也一样
  const list = await handleQuestList(get('/quests', { dir: versionDir }));
  const brief = (list.items ?? []).find((i) => i.id === 'BBBB0002');
  assert.ok(brief, '列表里该有 BBBB0002');
  assert.equal(brief.title, '金锭', '列表里的标题也要中文名');
});

// ===== 2026-11-12 第二批：依赖的满足方式要透到接口层 =====
// 真包实测 ATM10Sky 有 44 处不是默认的 all_completed，界面要能说出「任意一个完成」
// 还是「全部完成」—— 不然用户看到一串前置会理所当然是「与」。
test('任务书：/quest 和 /quest/canvas 都透出依赖方式与「至少 N 个」', async () => {
  resetQuestCache();
  // 给 BBBB0002 加上「任意一个完成」，再造一个用了「至少 2 个」的任务
  const withReq = CHAPTER.replace(
    'dependencies: ["BBBB0001"]',
    'dependencies: ["BBBB0001"]\n\t\t\tdependency_requirement: "one_completed"',
  );
  const { versionDir } = makePack({ chapter: withReq });

  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0002' }));
  assert.equal(detail.dependencyRequirement, 'one_completed', '/quest 要带依赖方式');
  assert.equal(detail.minRequiredDependencies, 0, '没写就是 0');

  const canvas = await handleQuestCanvas(get('/quest/canvas', { dir: versionDir }));
  const node = canvas.chapters.flatMap((c) => c.nodes ?? []).find((n) => n.id === 'BBBB0002');
  assert.ok(node, '画布上该有 BBBB0002');
  assert.equal(node.dependencyRequirement, 'one_completed', '画布节点也要带');
  assert.equal(node.minRequiredDependencies, 0);

  // 没写方式的任务必须有兜底值，不能是 undefined（界面靠它判断要说哪句话）
  const plain = canvas.chapters.flatMap((c) => c.nodes ?? []).find((n) => n.id === 'BBBB0001');
  assert.equal(plain.dependencyRequirement, 'all_completed', '没写就该是默认值');
  assert.equal(plain.minRequiredDependencies, 0);
});

test('任务书：查不到中文名时退回原来的显示名，不能变成空白', async () => {
  // 那个包里有 682/1590 个物品查不到中文名（mod 自己没做汉化）。
  // 这种要退回 questDisplayName()（副标题 / 图标名 / ID），不能返回空串。
  resetQuestCache();
  const { versionDir } = makePack();
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0002' }));
  assert.equal(detail.titleSource, 'item');
  // 这个包里根本没有 mods 目录 → 索引为空 → 查不到中文名
  assert.equal(detail.title, 'minecraft:gold_ingot', '查不到中文名时该原样退回物品 ID，不能空');
});

test('任务书：要求和奖励里的 ID 也要给中文名（2026-11-12 用户第二条）', async () => {
  // 用户原话：「要求里显示需要的物品或到达的维度或检查是否获取过某个物品时，
  // 显示的名字也是中文名保持一致」。
  //
  // 接口层现在返回 `label`（中文名），`what` 保留原始 ID ——
  // 界面显示 label，「改条件」表单预填 still 用 what。
  resetQuestCache();
  const { versionDir } = makePack();
  const modsDir = path.join(versionDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'demo.jar'), makeZip({
    'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="demo"\nversion="1.0"\ndisplayName="演示 Mod"\n',
    'assets/minecraft/models/item/gold_ingot.json': '{"parent":"item/generated"}',
    'assets/minecraft/textures/item/gold_ingot.png': 'stub',
    'assets/minecraft/lang/zh_cn.json': JSON.stringify({ 'item.minecraft.gold_ingot': '金锭' }),
  }));

  const q = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0002' }));
  assert.equal(q.tasks.length, 1);
  // what 必须还是原始 ID（表单预填靠它）
  assert.equal(q.tasks[0].what, 'minecraft:gold_ingot', 'what 要保留原始 ID');
  // label 才是给人看的
  assert.equal(q.tasks[0].label, '金锭', `★ 要求里该给中文名，实际「${q.tasks[0].label}」`);

  // 奖励也一样（这个包里 BBBB0002 的奖励是经验，没有物品 ID，label 原样为空）
  assert.ok(Array.isArray(q.rewards), '奖励该是数组');
  for (const r of q.rewards) {
    assert.ok('label' in r, '每条奖励都该有 label 字段（查不到就是原 ID）');
  }
});

test('任务书：维度 / 生物 / 群系 / 进度这几类要求也要中文名（2026-11-12 用户点名「到达的维度」）', async () => {
  // 实测踩到的四个坑，全在这条用例里钉死：
  //   ① 原版中文里**没有** `dimension.*` 这套键 —— 维度名得走固定映射/别的键
  //   ② 进度的键是复数 `advancements.` 且带 `.title` 后缀
  //   ③ 进度 ID 里的斜杠在键里要变点：`x:progression/haven` → `advancements.x.progression.haven.title`
  //   ④ 生物 / 群系是 `entity.*` / `biome.*`
  resetQuestCache();
  const { versionDir } = makePack({
    chapter: '{ id: "AAAA0001" quests: [\n'
      + '{ id: "Q_DIM" tasks: [ { id: "t1" type: "dimension" dimension: "minecraft:the_nether" } ] x: 0.0d y: 0.0d }\n'
      + '{ id: "Q_KILL" tasks: [ { id: "t2" type: "kill" entity: "minecraft:zombie" value: 1L } ] x: 1.0d y: 0.0d }\n'
      + '{ id: "Q_BIOME" tasks: [ { id: "t3" type: "biome" biome: "minecraft:end_highlands" } ] x: 2.0d y: 0.0d }\n'
      + '{ id: "Q_ADV" tasks: [ { id: "t4" type: "advancement" advancement: "apotheosis:progression/haven" } ] x: 3.0d y: 0.0d }\n'
      + '] }',
  });
  // 造一个 jar，把这几类的翻译键放进去（原版那份语言文件实测就是这么写的）
  const modsDir = path.join(versionDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'vanilla.jar'), makeZip({
    'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="demo"\nversion="1.0"\n',
    'assets/minecraft/lang/zh_cn.json': JSON.stringify({
      // 注意：**故意不放** dimension.* —— 原版中文里真的没有这套键
      'entity.minecraft.zombie': '僵尸',
      'biome.minecraft.end_highlands': '末地高地',
      'advancements.apotheosis.progression.haven.title': '居所',
    }),
  }));

  const labelOf = async (questId) => {
    const r = await handleQuestDetail(get('/quest', { dir: versionDir, questId }));
    return (r.tasks ?? []).map((t) => `${t.type}:${t.label}`);
  };

  // ★ 2026-11-12 第五批：用户拍板「原始 ID +（括号补中文名）」。
  //   游戏里 FTB 对 dimension/biome/structure/observation 是 Component.literal(原始 ID)，
  //   它自己一个字都不翻译；所以我们要先把 ID 摆出来（和游戏一致），括号里补中文名。
  assert.deepEqual(await labelOf('Q_DIM'), ['dimension:minecraft:the_nether（下界）'],
    '★ 维度该显示「原始 ID（中文名）」，和游戏里一致再补中文');
  assert.deepEqual(await labelOf('Q_BIOME'), ['biome:minecraft:end_highlands（末地高地）'],
    '生物群系同理');
  // 击杀 / 进度游戏本来就走翻译键，保持只给中文名
  assert.deepEqual(await labelOf('Q_KILL'), ['kill:僵尸'], '击杀生物该显示「僵尸」');
  assert.deepEqual(await labelOf('Q_ADV'), ['advancement:居所'], '★ 进度的斜杠要变点、要带 .title 后缀');
});

test('任务书：查不到中文名时要求的 label 原样等于 ID，不能变空', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const q = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0002' }));
  // 这个包没有 mods 目录 → 索引为空 → 查不到中文名
  assert.equal(q.tasks[0].label, 'minecraft:gold_ingot', '查不到时该退回 ID，不能空串');
});

test('任务书：详情给出文字、任务要求、奖励、上游下游', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const q = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0002' }));
  assert.equal(q.chapterTitle, 'AAAA0001');
  assert.equal(q.titleSource, 'item');
  assert.equal(q.titleItem, 'minecraft:gold_ingot');
  assert.equal(q.x, 1.5);
  assert.equal(q.y, 2);
  // 2026-11-12：每条要求多了 `label`（给人看的中文名）；第五批又多了 `title` /
  // `titleParts`（带类型前缀和颜色的「游戏里真会显示的样子」）。
  // 这个测试包里没有 jar，索引为空 → 查不到中文名 → label 原样等于 what。
  // 物品类型没有前缀（`ItemTask.java:167` 只有 count>1 时的 `Nx `），数量 4 → `4x minecraft:gold_ingot`。
  assert.deepEqual(q.tasks, [{
    type: 'item',
    what: 'minecraft:gold_ingot',
    count: 4,
    label: 'minecraft:gold_ingot',
    title: '4x minecraft:gold_ingot',
    titleParts: [],
  }]);
  assert.equal(q.rewards.length, 1);
  assert.equal(q.rewards[0].type, 'xp');
  // 2026-11-12：前置多带 chapterId / chapterTitle（界面跨章节跳转要靠它），
  // 后续结构改成和前置**完全对齐**（以前连 exists 都没有）。
  assert.deepEqual(q.upstream, [{
    id: 'BBBB0001', title: '打铁', exists: true, chapterId: 'AAAA0001', chapterTitle: 'AAAA0001',
  }]);

  const first = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(first.title, '打铁');
  assert.equal(first.titleSource, 'lang');
  assert.deepEqual(first.description, ['先把铁矿烧了', '再做铁锭']);
  assert.equal(first.langFile, 'lang/zh_cn.snbt');
  assert.equal(first.textFileExists, true);
  // 下游：BBBB0002 依赖它
  assert.deepEqual(first.downstream.map((d) => d.id), ['BBBB0002']);
  // 下游必须和上游同构：也带 exists / chapterId / chapterTitle（2026-11-12）
  // 名字仍是 `minecraft:gold_ingot` 是对的 —— 这个测试包没有 mods 目录，
  // 索引为空、查不到中文名，`displayNameOf()` 只能退回物品 ID。
  assert.deepEqual(first.downstream, [{
    id: 'BBBB0002', title: 'minecraft:gold_ingot', exists: true, chapterId: 'AAAA0001', chapterTitle: 'AAAA0001',
  }]);
});

// ————————————————————————— 前置/后续的体验（2026-11-12 §3.1.9 第 1、2 件） —————————————————————————
//
// 用户原话：「查看前置后置的时候还是不符合人的使用直觉」+「前置定位的功能和前置
// 显示名字的功能也有问题」。真实包实测（ATM10Sky，3658 任务 / 4118 条前置边）：
//   · 337 条前置指向「作者没写标题」的任务 → 只会显示 `untitled7` 这种
//   · 4109 条前置边**全部**缺 chapterId → 界面跨章节跳转时没有任何定位线索
// 下面三条用例把修法钉死。

/** 一套「没有标题」的任务书：A 有 kill 条件、B 只有图标、C 什么都没有。 */
const CHAPTER_NOTITLE = `{
\tid: "AAAA0001"
\torder_index: 0
\tfilename: "ch1"
\tquests: [
\t\t{
\t\t\tid: "CCCC0001"
\t\t\tx: 0d
\t\t\ty: 0d
\t\t\ttasks: [
\t\t\t\t{
\t\t\t\t\tid: "T0000001"
\t\t\t\t\ttype: "kill"
\t\t\t\t\tentity: "minecraft:zombie"
\t\t\t\t\tvalue: 5L
\t\t\t\t}
\t\t\t]
\t\t}
\t\t{
\t\t\tid: "CCCC0002"
\t\t\tx: 1d
\t\t\ty: 0d
\t\t\ticon: {
\t\t\t\tid: "minecraft:creeper_spawn_egg"
\t\t\t}
\t\t\ttasks: [
\t\t\t\t{
\t\t\t\t\tid: "T0000002"
\t\t\t\t\ttype: "checkmark"
\t\t\t\t}
\t\t\t]
\t\t}
\t]
}
`;

test('前置名字：没标题的任务优先用「完成条件」当名字，不再只显示 untitledN', async () => {
  resetQuestCache();
  const { versionDir } = makePack({ chapter: CHAPTER_NOTITLE });
  // 造一个「所有任务都依赖那两个」的下游任务书不方便，这里直接查 CCCC0001 自己的详情 ——
  // displayNameOf() 走的是同一条路，名字怎么算才是被测的东西。
  const q = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'CCCC0001' }));
  assert.equal(q.titleSource, 'id', '这个任务本来就该是「没标题」那种');
  // 这个测试包没有 jar → 查不到「僵尸」的中文名 → 只能退回条件 ID 的最后一段。
  // ★ 关键是**不再是 untitledN / 裸十六进制**：`zombie` 至少说明了要做啥。
  assert.equal(q.title, 'zombie', `★ 该拿条件当名字，实际「${q.title}」`);
  assert.notEqual(q.title, 'untitled1', '不能还是 untitled 编号');
});

test('前置名字：没条件时退回图标物品的中文名（creeper_spawn_egg → 苦力怕刷怪蛋）', async () => {
  resetQuestCache();
  const { versionDir } = makePack({ chapter: CHAPTER_NOTITLE });
  const modsDir = path.join(versionDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'demo.jar'), makeZip({
    'META-INF/mods.toml': 'modLoader="javafml"\\n[[mods]]\\nmodId="demo"\\nversion="1.0"\\ndisplayName="演示 Mod"\\n',
    'assets/minecraft/models/item/creeper_spawn_egg.json': '{"parent":"item/generated"}',
    'assets/minecraft/textures/item/creeper_spawn_egg.png': 'stub',
    'assets/minecraft/lang/zh_cn.json': JSON.stringify({ 'item.minecraft.creeper_spawn_egg': '苦力怕刷怪蛋' }),
  }));

  const q = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'CCCC0002' }));
  assert.equal(q.titleSource, 'id');
  // 这个任务只有一个 checkmark（没有条件可当名字）→ 退到图标物品
  // ★ 改之前这里是 `creeper_spawn_egg`（英文尾巴），而中文名索引里本来就有。
  assert.equal(q.title, '苦力怕刷怪蛋', `★ 该用图标物品的中文名，实际「${q.title}」`);
});

test('前置定位：upstream 带 chapterId / chapterTitle，跨章节跳转才有线索', async () => {
  resetQuestCache();
  // 第一章有 BBBB0002 依赖 BBBB0001；再造第二章，让 BBBB0002 依赖第二章的 DDDD0001 ——
  // 这就是真实包里那 43 条跨章节前置的形状。
  const { versionDir, questDir } = makePack();
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch2.snbt'), `{
\tid: "AAAA0002"
\torder_index: 1
\tfilename: "ch2"
\tquests: [
\t\t{
\t\t\tid: "DDDD0001"
\t\t\tx: 5d
\t\t\ty: 5d
\t\t\ttasks: [
\t\t\t\t{
\t\t\t\t\tid: "T0000009"
\t\t\t\t\ttype: "checkmark"
\t\t\t\t}
\t\t\t]
\t\t}
\t]
}
`, 'utf8');
  // 把第一章改成 BBBB0002 依赖跨章的 DDDD0001
  const ch1 = fs.readFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), 'utf8')
    .replace('dependencies: ["BBBB0001"]', 'dependencies: ["BBBB0001", "DDDD0001"]');
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), ch1, 'utf8');

  const q = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0002' }));
  const cross = q.upstream.find((u) => u.id === 'DDDD0001');
  assert.ok(cross, '跨章节那条前置该在列表里');
  assert.equal(cross.chapterId, 'AAAA0002', '★ 必须带 chapterId，界面靠它切页签');
  assert.equal(cross.exists, true);
  // 同章那条也不能缺字段
  const same = q.upstream.find((u) => u.id === 'BBBB0001');
  assert.equal(same.chapterId, 'AAAA0001');
});

test('前置列表里的悬空依赖：exists=false 且不编造章节', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const ch1 = fs.readFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), 'utf8')
    .replace('dependencies: ["BBBB0001"]', 'dependencies: ["BBBB0001", "FFFF9999"]');
  fs.writeFileSync(path.join(questDir, 'chapters', 'ch1.snbt'), ch1, 'utf8');

  const q = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0002' }));
  const gone = q.upstream.find((u) => u.id === 'FFFF9999');
  assert.ok(gone, '悬空前置也要列出来（用户得知道这里断了一条线）');
  assert.equal(gone.exists, false);
  assert.equal(gone.chapterId, '', '不存在的任务不该编造章节');
  assert.equal(gone.chapterTitle, '');
});

test('任务书：缺 ID、抄错 ID、包里没有任务书，都给出能看懂的错', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  await throwsCode(() => handleQuestDetail(get('/quest', { dir: versionDir })), 'McBadArgs');
  await throwsCode(() => handleQuestDetail(get('/quest', { dir: versionDir, questId: 'NOPE' })), 'QuestNotFound');

  const empty = makePack({ config: false });
  await throwsCode(() => handleQuestBook(get('/questbook', { dir: empty.versionDir })), 'QuestNotFound');
});

// ————————————————————————— 预览（绝不能碰盘） —————————————————————————

test('任务书：改标题只动语言文件，预览阶段不碰盘', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const langPath = path.join(questDir, 'lang', 'zh_cn.snbt');
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const langBefore = read(langPath);
  const chapterBefore = read(chapterPath);

  const plan = await handleQuestPreview(get('/quest/preview', { dir: versionDir, questId: 'BBBB0001', title: '炼铁' }));
  assert.equal(plan.changed, true);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].kind, 'text');
  assert.equal(plan.files[0].name, 'lang/zh_cn.snbt');
  assert.equal(plan.changes[0].field, 'title');
  assert.equal(plan.changes[0].before, '打铁');
  assert.equal(plan.changes[0].after, '炼铁');

  // 预览之后两个文件都必须原封不动
  assert.equal(read(langPath), langBefore);
  assert.equal(read(chapterPath), chapterBefore);
  assert.equal(fs.existsSync(path.join(langPath)), true);
});

test('任务书：改位置只动章节文件', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const langPath = path.join(questDir, 'lang', 'zh_cn.snbt');
  const langBefore = read(langPath);

  const plan = await handleQuestPreview(get('/quest/preview', { dir: versionDir, questId: 'BBBB0001', x: '3', y: '-1.5' }));
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].kind, 'layout');
  assert.ok(plan.files[0].name.endsWith('ch1.snbt'));
  assert.equal(read(langPath), langBefore);
  assert.deepEqual(
    plan.changes.map((c) => [c.field, c.after]),
    [['x', 3], ['y', -1.5]],
  );
});

test('任务书：文字和位置一起改，两个文件都进计划', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const plan = await handleQuestPreview(
    get('/quest/preview', { dir: versionDir, questId: 'BBBB0002', title: '金锭', desc: '第一行\n第二行', x: '5' }),
  );
  assert.deepEqual(plan.files.map((f) => f.kind).sort(), ['layout', 'text']);
  // 原来没标题（显示物品名），改标题时要提醒一句
  assert.ok(plan.warnings.some((w) => w.includes('物品')), `应该提醒标题原来来自物品名，实际：${plan.warnings}`);
});

test('任务书：什么都没改时预览说「没有任何改动」，apply 直接拒绝', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const plan = await handleQuestPreview(get('/quest/preview', { dir: versionDir, questId: 'BBBB0001', title: '打铁' }));
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.summary, ['没有任何改动']);
  await throwsCode(() => handleQuestApply(post('/quest/apply', { dir: versionDir, questId: 'BBBB0001', title: '打铁' })), 'McBadArgs');
});

test('任务书：坐标写错了要拒绝，不能写进去', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  await throwsCode(
    () => handleQuestPreview(get('/quest/preview', { dir: versionDir, questId: 'BBBB0001', x: 'abc' })),
    'McBadArgs',
  );
  await throwsCode(
    () => handleQuestPreview(get('/quest/preview', { dir: versionDir, questId: 'BBBB0001', x: '99999999' })),
    'McBadArgs',
  );
});

// ————————————————————————— 写入 —————————————————————————

test('任务书：写入后文本真是新值，并且留了备份', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const langPath = path.join(questDir, 'lang', 'zh_cn.snbt');
  const before = read(langPath);

  const result = await handleQuestApply(post('/quest/apply', { dir: versionDir, questId: 'BBBB0001', title: '炼铁' }));
  assert.equal(result.quest.title, '炼铁');
  assert.equal(result.files.length, 1);
  assert.equal(result.questDir, questDir);
  assert.equal(result.backups.length, 1);
  assert.ok(result.backups[0].startsWith('zh_cn.snbt.bak-'));
  // 备份里是旧内容
  assert.equal(read(path.join(path.dirname(langPath), result.backups[0])), before);
  // 新文件里是新内容，且还是合法 SNBT（能重新读出来）
  assert.ok(read(langPath).includes('炼铁'));
  const again = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(again.title, '炼铁');
});

test('任务书：写入坐标后重读是新坐标，语言文件不受影响', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const langPath = path.join(questDir, 'lang', 'zh_cn.snbt');
  const langBefore = read(langPath);

  const result = await handleQuestApply(post('/quest/apply', { dir: versionDir, questId: 'BBBB0002', x: 4, y: -2 }));
  assert.equal(result.quest.x, 4);
  assert.equal(result.quest.y, -2);
  assert.equal(result.backups.length, 1);
  assert.ok(result.backups[0].startsWith('ch1.snbt.bak-'));
  assert.equal(read(langPath), langBefore);
  // 别的任务不能被动到
  const other = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(other.x, 0);
});

test('任务书：描述多行会存成多行，重读还是多行', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const result = await handleQuestApply(
    post('/quest/apply', { dir: versionDir, questId: 'BBBB0002', desc: '第一步\n第二步\n第三步' }),
  );
  assert.deepEqual(result.quest.description, ['第一步', '第二步', '第三步']);
});

test('任务书：包里有语言目录但没有当前语言文件时会新建一个', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack({ lang: [] });
  const langPath = path.join(questDir, 'lang', 'en_us.snbt');
  assert.equal(fs.existsSync(langPath), false);

  const plan = await handleQuestPreview(get('/quest/preview', { dir: versionDir, questId: 'BBBB0001', title: 'Iron Age' }));
  assert.equal(plan.files[0].created, true);
  assert.ok(plan.warnings.some((w) => w.includes('新建')), `应该提醒会新建语言文件，实际：${plan.warnings}`);

  const result = await handleQuestApply(post('/quest/apply', { dir: versionDir, questId: 'BBBB0001', title: 'Iron Age' }));
  assert.equal(fs.existsSync(langPath), true);
  assert.ok(read(langPath).includes('Iron Age'));
  assert.equal(result.quest.title, 'Iron Age');
  // 新建文件没有旧内容，所以不该有备份
  assert.deepEqual(result.backups, []);
});

test('任务书：buildQuestPlan 只算不写，改两次同一个任务不会叠加', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);

  const plan = buildQuestPlan({ dir: versionDir, questId: 'BBBB0001', x: '7' });
  assert.equal(plan.files.length, 1);
  assert.equal(read(chapterPath), before, 'buildQuestPlan 不该写盘');

  await handleQuestApply(post('/quest/apply', { dir: versionDir, questId: 'BBBB0001', x: 7 }));
  await handleQuestApply(post('/quest/apply', { dir: versionDir, questId: 'BBBB0001', y: 8 }));
  const q = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(q.x, 7);
  assert.equal(q.y, 8);
  // 章节文件里 BBBB0001 只该出现一次（改两次不能写出两条任务）
  const text = read(chapterPath);
  assert.equal(text.split('id: "BBBB0001"').length - 1, 1);
});

test('任务书：改英文语言时看的是英文文件', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const enPath = path.join(questDir, 'lang', 'en_us.snbt');
  const q = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001', locale: 'en_us' }));
  assert.equal(q.title, 'Iron');
  const result = await handleQuestApply(post('/quest/apply', { dir: versionDir, questId: 'BBBB0001', locale: 'en_us', title: 'Iron Ingot' }));
  assert.equal(result.quest.title, 'Iron Ingot');
  assert.ok(read(enPath).includes('Iron Ingot'));
  // 中文语言文件不能被动
  assert.ok(read(path.join(questDir, 'lang', 'zh_cn.snbt')).includes('打铁'));
});
// ————————————————————————— 从零建任务 / 建章节 —————————————————————————

test('新建任务：预览不写盘，apply 才真加进去，且标题写进语言文件', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const langPath = path.join(questDir, 'lang', 'zh_cn.snbt');
  const before = read(chapterPath);
  const langBefore = read(langPath);

  const plan = await handleQuestAddPreview(get('/quest/add/preview', {
    dir: versionDir, chapter: 'AAAA0001', title: '做一台压片机', taskItem: 'create:cogwheel', taskCount: 2,
  }));
  assert.equal(plan.kind, 'quest');
  assert.ok(plan.questId);
  assert.equal(read(chapterPath), before, '预览不该写盘');
  assert.equal(read(langPath), langBefore, '预览不该动语言文件');

  const done = await handleQuestAddApply(post('/quest/add/apply', {
    dir: versionDir, chapter: 'AAAA0001', title: '做一台压片机', taskItem: 'create:cogwheel', taskCount: 2,
  }));
  assert.ok(done.backups.length >= 1, '改已有文件应该留备份');
  const text = read(chapterPath);
  assert.equal(text.split(`id: "${done.questId}"`).length - 1, 1);
  assert.ok(read(langPath).includes('做一台压片机'));

  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: done.questId }));
  assert.equal(detail.title, '做一台压片机');
  assert.equal(detail.tasks.length, 1);
});

test('新建任务：按界面那套 POST body 填完成条件/奖励/副标题/简介，全字段都落地（2026-11-04）', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  // 界面走 post() 的 JSON body，不是 GET 查询串 —— 测试必须用同一条路，
  // 否则「测试全绿、界面照坏」（2026-11-02 /roots/add 那次教训）。
  const body = {
    dir: versionDir, chapter: 'AAAA0001', title: '做一台压片机',
    subtitle: '把锭压成板',
    description: '第一行说明\n第二行说明',
    taskItem: 'minecraft:iron_ingot', taskCount: 3,
    rewardItem: 'minecraft:diamond', rewardCount: 2,
  };
  const plan = await handleQuestAddPreview(post('/quest/add/preview', body));
  assert.match(plan.diff.join('\n'), /完成条件：交 3 个 minecraft:iron_ingot/, 'diff 里没写对完成条件');
  assert.match(plan.diff.join('\n'), /奖励：给 2 个 minecraft:diamond/, 'diff 里没写对奖励（用户 2026-11-04 点名补的）');

  const done = await handleQuestAddApply(post('/quest/add/apply', body));
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: done.questId }));
  assert.equal(detail.title, '做一台压片机');
  assert.equal(detail.subtitle, '把锭压成板', '副标题没写进语言文件');
  assert.deepEqual(detail.description, ['第一行说明', '第二行说明'], '简介没写进语言文件');
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0].what, 'minecraft:iron_ingot', '完成条件物品不对');
  assert.equal(detail.tasks[0].count, 3, '完成条件数量不对');
  assert.equal(detail.rewards.length, 1);
  assert.equal(detail.rewards[0].what, 'minecraft:diamond', '奖励物品不对');
  assert.equal(detail.rewards[0].count, 2, '奖励数量不对');

  // 回归防线：界面以前发的 item/count 是后端完全不认的旧名，
  // 发了就变成「点一下就过的空任务、啥也不给」。这条断言盯死字段名别再退化。
  const legacy = await handleQuestAddPreview(post('/quest/add/preview', {
    dir: versionDir, chapter: 'AAAA0001', title: '旧字段', item: 'minecraft:iron_ingot', count: 3,
  }));
  assert.match(legacy.diff.join('\n'), /完成条件：（无，玩家点了就过）/, '发旧字段 item/count 竟然还生效，说明字段名又串了');
});

// ————— 新建任务的任务级字段（2026-11-13 默认值改造第一批） —————
// 以前 /quest/add 只认「标题 + 条件 + 奖励 + 坐标」，任务级字段（形状 / 大小 /
// optional / invisible …）一个都传不进来，只能建完再手改文件。

test('新建任务：任务级字段走 POST body 能透传，且默认值一个都不写进文件', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');

  // 只看「新加的那个任务块」—— 章节里本来就有别的任务，整份文件 grep 会串味
  const blockOf = (text, questId) => {
    const at = text.indexOf(`id: "${questId}"`);
    assert.ok(at >= 0, `文件里找不到任务 ${questId}`);
    // 从任务块开头（上一个 {）到下一个任务块的 id 之前
    const start = text.lastIndexOf('{', at);
    const next = text.indexOf('\n\t\t{\n', at);
    return text.slice(start, next === -1 ? text.length : next);
  };

  // ① 只填名字 → 新任务块里除了 id/x/y 什么都不该有
  const plain = await handleQuestAddApply(post('/quest/add/apply', {
    dir: versionDir, chapter: 'AAAA0001', title: '只有名字',
  }));
  const plainBlock = blockOf(read(chapterPath), plain.questId);
  for (const key of ['shape', 'size', 'optional', 'invisible', 'can_repeat',
    'min_required_dependencies', 'icon_scale', 'min_width', 'guide_page']) {
    assert.ok(!plainBlock.includes(`${key}:`), `默认值 ${key} 不该出现在新任务块里`);
  }
  assert.ok(!plainBlock.includes('tasks:'), '没填条件就不该有 tasks 键');
  assert.ok(!plainBlock.includes('rewards:'), '没填奖励就不该有 rewards 键');

  // ② 明确给非默认值 → 每个都要落地
  const full = await handleQuestAddApply(post('/quest/add/apply', {
    dir: versionDir, chapter: 'AAAA0001', title: '带一堆开关',
    shape: 'gear', size: 1.5, optional: true, invisible: true,
    can_repeat: false, min_width: 40, guide_page: 'readme',
  }));
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: full.questId }));
  assert.equal(detail.shape, 'gear', 'shape 没透传');
  assert.equal(detail.size, 1.5, 'size 没透传');
  assert.equal(detail.optional, true, 'optional 没透传');
  assert.equal(detail.invisible, true, 'invisible 没透传');
  assert.equal(detail.canRepeat, false, '★ 三态的 false 没透传（最容易被当成默认丢掉）');

  const fullBlock = blockOf(read(chapterPath), full.questId);
  assert.match(fullBlock, /min_width: 40/, 'min_width 没写进文件');
  assert.match(fullBlock, /guide_page: "readme"/, 'guide_page 没写进文件');
  assert.notEqual(plain.questId, full.questId);
});

test('新建任务：不传任务级字段时，planAddQuest 不给它们补默认值（等于游戏自己决定）', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  // 界面「新建任务」不带任何开关 —— 后端不能自作主张填 optional: false 之类
  const done = await handleQuestAddApply(post('/quest/add/apply', {
    dir: versionDir, chapter: 'AAAA0001', title: '干净的空任务',
  }));
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: done.questId }));
  assert.equal(detail.tasks.length, 0, '没填条件就该是空任务');
  assert.equal(detail.rewards.length, 0, '没填奖励就该是空任务');
});

// ————— 改已有任务的任务级字段（2026-11-13 默认值改造，VS 原则 1 / 3） —————
// 这里守的是两个真 bug —— 都是端到端探针（lab/_probe-defaults-e2e.mjs）当场逮住的：
//   ① 写后复验拿「人话」比数字，好的写入被自己回滚掉；
//   ② 「文件里写着某键、用户点 ↩ 恢复默认」被当成「没变化」跳过，键永远删不掉。

test('★ 改任务级字段：写进去能复验、改回默认键真删掉、语义不丢（2026-11-13）', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');

  // 先建一个干净的空任务
  const added = await handleQuestAddApply(post('/quest/add/apply', {
    dir: versionDir, chapter: 'AAAA0001', title: '被改的任务级字段',
  }));
  assert.ok(added.ok !== false, '新建失败');
  const id = added.questId;

  // ① 给非默认值 —— 写后复验不能挂（bug ①：以前会把好的写入回滚）
  const set = await handleQuestApply(post('/quest/apply', {
    dir: versionDir, questId: id,
    shape: 'gear', size: 1.5, optional: true, can_repeat: false,
  }));
  assert.ok(set.changes.length >= 4, `该有 4 处改动，实际 ${set.changes.length}`);
  const text1 = read(chapterPath);
  const block1 = text1.slice(text1.indexOf(`id: "${id}"`));
  assert.match(block1, /shape: "gear"/, 'shape 没写进去');
  assert.match(block1, /size: 1\.5/, 'size 没写进去');
  assert.match(block1, /optional: true/, 'optional 没写进去');
  assert.match(block1, /can_repeat: false/, '★ 三态的 false 没写进去');

  // ② 全部改回默认（发 null = 恢复默认）—— 四个键都该消失
  const reset = await handleQuestApply(post('/quest/apply', {
    dir: versionDir, questId: id,
    shape: null, size: null, optional: null, can_repeat: null,
  }));
  assert.ok(reset.changes.length >= 4, '「恢复默认」该被算成改动');
  const text2 = read(chapterPath);
  const block2 = text2.slice(text2.indexOf(`id: "${id}"`));
  for (const key of ['shape', 'size', 'optional', 'can_repeat']) {
    assert.ok(!block2.includes(`${key}:`), `★ ${key} 该从文件里消失（bug ②）`);
  }

  // ③ 语义没丢：读回来是「跟随章节」，不是「明确 false」
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: id }));
  assert.equal(detail.canRepeat, null,
    '★ can_repeat 读回来必须是 null（跟随章节），不能变 false —— 那会悄悄改掉玩家体验');
  assert.equal(detail.optional, false);
  assert.equal(Number(detail.size), 0, 'size 读回来该是 0（文件里没写）');
});

test('★ 改任务级字段：文件里本来就写着该键、且值等于默认 ⇒ 也算改动（要把它删掉）', async () => {
  resetQuestCache();
  // 造一个「文件里写着 can_repeat: false」的任务 —— 这正是 bug ② 的场景
  const { versionDir, questDir } = makePack({
    chapter: `{
	filename: "ch1"
	id: "AAAA0001"
	quests: [ 
		{
			id: "BBBB0009"
			can_repeat: false
			x: 0
			y: 0
		}
	]
}
`,
  });
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');

  // 读出来确实是 false（不是 null）
  const before = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0009' }));
  assert.equal(before.canRepeat, false, '前提：文件里该是明确 false');

  // 点 ↩ 恢复默认 → 键要消失
  const reset = await handleQuestApply(post('/quest/apply', {
    dir: versionDir, questId: 'BBBB0009', can_repeat: null,
  }));
  assert.equal(reset.changes.length, 1, '★ 这必须是「一处改动」（bug ②：以前被当成没变化跳过）');
  assert.ok(!read(chapterPath).includes('can_repeat'), '键没删掉');

  const after = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0009' }));
  assert.equal(after.canRepeat, null, '恢复默认后该是 null（跟随章节）');
});

// ————— 改已有任务的完成条件 / 奖励（2026-11-04 第 2 批 B） —————
// 以前 /quest/preview|apply 只认文字和坐标，界面「改名」卡也只发 title/subtitle，
// 所以任务建出来以后「要交什么、给几个、发什么奖励」根本改不了。现在跟新建任务
// 共用 taskItem/taskCount/rewardItem/rewardCount 四个字段名，走同一套章节文件改写。

test('改已有任务：完成条件和奖励写进章节文件，预览不写盘、apply 写完复验真的变了', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);
  const body = {
    dir: versionDir, questId: 'BBBB0001',
    taskItem: 'minecraft:copper_ingot', taskCount: 5,
    rewardItem: 'minecraft:diamond', rewardCount: 2,
  };

  const plan = await handleQuestPreview(post('/quest/preview', body));
  assert.equal(read(chapterPath), before, '预览不该写盘');
  const fields = plan.changes.map((c) => c.field);
  assert.ok(fields.includes('tasks'), 'changes 里没有完成条件');
  assert.ok(fields.includes('rewards'), 'changes 里没有奖励');
  const taskChange = plan.changes.find((c) => c.field === 'tasks');
  assert.match(taskChange.before, /交 8 个 minecraft:iron_ingot/);
  assert.match(taskChange.after, /交 5 个 minecraft:copper_ingot/);
  const rewardChange = plan.changes.find((c) => c.field === 'rewards');
  assert.match(rewardChange.after, /给 2 个 minecraft:diamond/);
  assert.equal(plan.files.length, 1, '只该动章节文件一个');
  assert.match(plan.files[0].path, /ch1\.snbt/);

  const done = await handleQuestApply(post('/quest/apply', body));
  assert.ok(done.backups.length >= 1, '写章节文件该留备份');
  // 没抛 QuestVerifyFailed 就说明写后复验过了；再自己重读一次双保险
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0].what, 'minecraft:copper_ingot');
  assert.equal(detail.tasks[0].count, 5);
  assert.equal(detail.rewards.length, 1);
  assert.equal(detail.rewards[0].what, 'minecraft:diamond');
  assert.equal(detail.rewards[0].count, 2);
  assert.ok(read(chapterPath).includes('T0000001'), '沿用原条目 id，别把玩家已交的进度重置了');
});

test('改已有任务：只给完成条件时，奖励那一组完全不动', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const body = { dir: versionDir, questId: 'BBBB0001', taskItem: 'minecraft:gold_ingot', taskCount: 3 };
  const plan = await handleQuestPreview(post('/quest/preview', body));
  assert.ok(plan.changes.some((c) => c.field === 'tasks'));
  assert.ok(!plan.changes.some((c) => c.field === 'rewards'), '没给 rewardItem 就不该碰奖励');

  await handleQuestApply(post('/quest/apply', body));
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(detail.tasks[0].what, 'minecraft:gold_ingot');
  assert.equal(detail.rewards.length, 0, '原本没奖励，不该凭空冒出来');
});

test('改已有任务：非物品条目也能按类型改（不再一刀切拒绝）', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  // BBBB0002 的奖励是 { type:"xp", xp:10 }。以前界面只会改「给物品」，碰到经验
  // 奖励就直接抛错挡住；现在支持多类型，发旧字段 rewardItem 就是「把第一条奖励换成物品」。
  const body = {
    dir: versionDir, questId: 'BBBB0002', rewardItem: 'minecraft:diamond', rewardCount: 1,
  };
  const plan = await handleQuestPreview(post('/quest/preview', body));
  const rewardChange = plan.changes.find((c) => c.field === 'rewards');
  assert.ok(rewardChange, '换类型应该算一次奖励改动');
  assert.match(rewardChange.before, /给 10 点经验/, '改之前那句人话该是经验奖励');
  assert.match(rewardChange.after, /给 1 个 minecraft:diamond/, '改之后该是物品奖励');

  await handleQuestApply(post('/quest/apply', body));
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0002' }));
  assert.equal(detail.rewards[0].type, 'item', '奖励应该真换成物品类型');
  assert.equal(detail.rewards[0].what, 'minecraft:diamond');
  assert.ok(read(chapterPath).includes('R0000001'), '沿用原奖励 id，别把玩家进度重置了');
});

test('改已有任务：物品 ID 留空＝清空这一组条件', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const body = { dir: versionDir, questId: 'BBBB0001', taskItem: '', taskCount: 1 };
  const plan = await handleQuestPreview(post('/quest/preview', body));
  const taskChange = plan.changes.find((c) => c.field === 'tasks');
  assert.match(taskChange.before, /交 8 个 minecraft:iron_ingot/);
  assert.equal(taskChange.after, '（无）');

  await handleQuestApply(post('/quest/apply', body));
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(detail.tasks.length, 0, '条件该被清空');
});

test('改已有任务：界面把现状预填回来时算「没改动」，不写盘也不误伤章节文件', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);
  // 「改名」卡会拿详情预填 4 个字段；用户只改标题、其余原样发回来，
  // 不该因为多了这 4 个字段就去重写章节文件。
  const body = {
    dir: versionDir, questId: 'BBBB0001', title: '打铁（改名）', subtitle: '',
    taskItem: 'minecraft:iron_ingot', taskCount: 8,
    rewardItem: '', rewardCount: 1,
  };
  const plan = await handleQuestPreview(post('/quest/preview', body));
  assert.deepEqual(plan.changes.map((c) => c.field), ['title'], '只该有标题一处改动');
  assert.equal(plan.files.length, 1, '只该动语言文件');
  await handleQuestApply(post('/quest/apply', body));
  assert.equal(read(chapterPath), before, '章节文件一个字节都不该变');
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(detail.title, '打铁（改名）');
  assert.equal(detail.tasks[0].what, 'minecraft:iron_ingot', '条件被误改了');
});

test('改已有任务：界面把「简介现状」也预填回来（desc）时算没改动，不重写章节文件（2026-11-04 第 4 批 A）', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);
  // 第 4 批 A 之后「改名」卡会多带一个 desc（详情数组拼成换行文本）。用户只改标题、
  // 简介原样发回来，不该因为多了这个字段就把简介算成「改动」或去碰章节文件。
  const body = {
    dir: versionDir, questId: 'BBBB0001', title: '打铁（改名）', subtitle: '',
    desc: '先把铁矿烧了\n再做铁锭',
    taskItem: 'minecraft:iron_ingot', taskCount: 8,
    rewardItem: '', rewardCount: 1,
  };
  const plan = await handleQuestPreview(post('/quest/preview', body));
  assert.deepEqual(plan.changes.map((c) => c.field), ['title'], '只该有标题一处改动，desc 原样不该算改动');
  assert.equal(plan.files.length, 1, '只该动语言文件');
  await handleQuestApply(post('/quest/apply', body));
  assert.equal(read(chapterPath), before, '章节文件一个字节都不该变');
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.deepEqual(detail.description, ['先把铁矿烧了', '再做铁锭'], '简介被误改了');
});

test('改已有任务：POST body 里的 desc 多行文本写进语言文件，重读是新数组且写后复验不回滚（2026-11-04 第 4 批 A）', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const result = await handleQuestApply(post('/quest/apply', {
    dir: versionDir, questId: 'BBBB0001', title: '打铁', subtitle: '',
    desc: '新的第一步\n新的第二步\n新的第三步',
  }));
  // 能走到这里（没抛 QuestVerifyFailed）就说明 lib/host/quest-api.js:538 那段
  // 「把重读出的数组 join 回去跟 changes.after 比」的复验通过了，没回滚。
  assert.deepEqual(result.quest.description, ['新的第一步', '新的第二步', '新的第三步']);
  assert.ok(result.backups.length >= 1, '应该真的写过语言文件并留了备份');
});

test('新建任务：章节不存在、标题空、依赖不存在，都给能看懂的错', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  await throwsCode(() => handleQuestAddPreview(get('/quest/add/preview', { dir: versionDir, chapter: '没有这一章', title: 'x' })), 'ChapterNotFound');
  await throwsCode(() => handleQuestAddPreview(get('/quest/add/preview', { dir: versionDir, chapter: 'AAAA0001', title: '' })), 'QuestNoTitle');
  await throwsCode(
    () => handleQuestAddPreview(get('/quest/add/preview', { dir: versionDir, chapter: 'AAAA0001', title: 'x', dependsOn: 'DEADBEEF' })),
    'QuestBadDependency',
  );
});

test('新建章节：预览不写盘，apply 真建出文件、能读回、标题进语言文件', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chaptersDir = path.join(questDir, 'chapters');
  const countBefore = fs.readdirSync(chaptersDir).length;

  const plan = await handleChapterAddPreview(get('/quest/chapter/preview', {
    dir: versionDir, title: '第一章 起步', icon: 'create:cogwheel',
  }));
  assert.equal(plan.kind, 'chapter');
  assert.equal(fs.readdirSync(chaptersDir).length, countBefore, '预览不该建文件');

  const done = await handleChapterAddApply(post('/quest/chapter/apply', {
    dir: versionDir, title: '第一章 起步', icon: 'create:cogwheel',
  }));
  assert.equal(fs.readdirSync(chaptersDir).length, countBefore + 1);
  assert.ok(read(path.join(chaptersDir, `${done.chapterId}.snbt`)).includes('order_index'));
  assert.ok(read(path.join(questDir, 'lang', 'zh_cn.snbt')).includes('第一章 起步'));

  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));
  assert.ok(book.chapters.some((c) => c.id === done.chapterId));
});

test('新建章节：包里连语言文件都没有，也能建（自动补一个）', async () => {
  resetQuestCache();
  // 从零建出来的新包就是这样：任务书是空的，FTB 还没写过任何语言文件
  const { versionDir, questDir } = makePack({ lang: [] });
  assert.equal(fs.existsSync(path.join(questDir, 'lang')), false);

  const done = await handleChapterAddApply(post('/quest/chapter/apply', {
    dir: versionDir, title: '第一章 起步',
  }));
  const langPath = path.join(questDir, 'lang', 'en_us.snbt');
  assert.ok(fs.existsSync(langPath), '应该自动补出语言文件');
  assert.ok(read(langPath).includes('第一章 起步'));

  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));
  assert.ok(book.chapters.some((c) => c.id === done.chapterId));
});

test('新建章节：标题空、分组不存在，都挡住', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  await throwsCode(() => handleChapterAddPreview(get('/quest/chapter/preview', { dir: versionDir, title: '  ' })), 'ChapterNoTitle');
  await throwsCode(
    () => handleChapterAddPreview(get('/quest/chapter/preview', { dir: versionDir, title: 'x', group: '没有这个组' })),
    'GroupNotFound',
  );
});

// ————————————————————————— 右键编辑节点（图标 / 依赖 / 删除） —————————————————————————
//
// 面板右键一个任务节点时打的就是这四条。界面要直接照着 payload 渲染，
// 所以这里除了「写没写盘」，还要钉住「字段叫什么、是不是数组、内容别太大」。

test('右键改图标：preview 不写盘，payload 是界面要的形状（不带文件正文）', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);

  const plan = await handleQuestNodePreview(get('/quest/node/preview', {
    dir: versionDir, questId: 'BBBB0001', icon: 'create:cogwheel',
  }));
  assert.equal(plan.kind, 'node-edit');
  assert.equal(plan.questId, 'BBBB0001');
  assert.equal(plan.questTitle, '打铁');
  assert.equal(plan.changedCount, 1);
  assert.deepEqual(plan.changes, [{ field: 'icon', label: '图标', before: '', after: 'create:cogwheel' }]);
  assert.ok(plan.diff[0].startsWith('图标：'));
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].name, 'ch1.snbt');
  assert.equal(plan.files[0].path, chapterPath);
  assert.ok(plan.files[0].bytes > 0);
  // 整份文件正文不能透给界面（太大，也不该在界面里拼）
  assert.equal(plan.files[0].content, undefined);
  assert.equal(plan.writes, undefined);
  assert.equal(read(chapterPath), before, 'preview 不能写盘');
});

test('右键改图标 + 清空依赖：apply 真写盘、返回 backups 和 lines', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');

  const done = await handleQuestNodeApply(post('/quest/node/apply', {
    dir: versionDir,
    questId: 'BBBB0002',
    icon: 'minecraft:diamond',
    // 界面就是传 JSON 字符串的
    dependencies: '[]',
  }));
  assert.equal(done.kind, 'node-edit');
  assert.equal(done.changedCount, 2);
  assert.equal(done.backups.length, 1);
  assert.ok(done.lines.some((l) => l.includes('0 个新错误')));
  assert.equal(done.files[0].name, 'ch1.snbt');

  const text = read(chapterPath);
  assert.ok(text.includes('minecraft:diamond'));
  assert.match(text, /dependencies\s*:\s*\[\s*\]/);

  // 缓存要清掉，下一次读必须是新的
  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));
  assert.equal(book.issues.errorCount, 0);
});

test('右键删除：preview 列出 dependents，一个字节都不写', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);

  const plan = await handleQuestNodeDeletePreview(get('/quest/node/delete/preview', {
    dir: versionDir, questId: 'BBBB0001',
  }));
  assert.equal(plan.kind, 'node-delete');
  assert.equal(plan.questId, 'BBBB0001');
  assert.equal(plan.questTitle, '打铁');
  assert.equal(plan.chapterId, 'AAAA0001');
  assert.equal(plan.chapterTitle, 'AAAA0001');
  assert.deepEqual(plan.dependents.map((d) => d.id), ['BBBB0002']);
  assert.equal(plan.affectedCount, 1);
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].content, undefined);
  assert.equal(read(chapterPath), before, 'preview 不能写盘');
});

test('右键删除：apply 真删掉，下游依赖被断开，留备份', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');

  const done = await handleQuestNodeDeleteApply(post('/quest/node/delete/apply', {
    dir: versionDir, questId: 'BBBB0001',
  }));
  assert.equal(done.kind, 'node-delete');
  assert.equal(done.affectedCount, 1);
  assert.equal(done.backups.length, 1);
  assert.ok(done.lines.some((l) => l.includes('已删掉任务')));
  assert.ok(done.files[0].path.endsWith('ch1.snbt'));

  const text = read(chapterPath);
  assert.equal(text.includes('BBBB0001'), false, '任务应该没了');
  assert.equal(fs.readdirSync(path.join(questDir, 'chapters')).filter((n) => n.includes('.bak-')).length, 1);

  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));
  assert.equal(book.questCount, 1);
  assert.equal(book.issues.danglingCount, 0);
});

test('右键删除：任务 ID 不存在要报 QuestNotFound，别默默成功', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  await throwsCode(
    () => handleQuestNodeDeletePreview(get('/quest/node/delete/preview', { dir: versionDir, questId: 'NOPE0000' })),
    'QuestNotFound',
  );
  await throwsCode(
    () => handleQuestNodePreview(get('/quest/node/preview', { dir: versionDir, questId: 'NOPE0000', icon: 'minecraft:stone' })),
    'QuestNotFound',
  );
});

test('右键改图标：什么都给不出来时返回「没改动」，不是报错', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  const plan = await handleQuestNodePreview(get('/quest/node/preview', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(plan.changedCount, 0);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.files, []);
});

// ————————————————————————— 章节装饰图（加 / 挪 / 删） —————————————————————————
//
// 装饰图是贴在画布上的背景图（章节文件里的 images），不是任务节点。
// 界面拖一下背景图就打一次 move apply，所以这里要钉住：只动那一张的 x/y、
// 别的字节一个不动、预览阶段绝不写盘。

/** 带一张装饰图的章节：用来验证「加/挪/删」不会顺手改坏别的排版。 */
const CHAPTER_WITH_IMAGE = `{
	id: "AAAA0001"
	order_index: 0
	filename: "ch1"
	images: [
		{
			height: 7.0d
			image: "umapyoi:textures/book_images/book_filler.png"
			rotation: 0.0d
			width: 7.0d
			x: 2.0d
			y: -1.0d
		}
	]
	quests: [
		{
			id: "BBBB0001"
			x: 0d
			y: 0d
		}
	]
}
`;

test('装饰图：preview 算加一张，payload 是界面要的形状，不写盘', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack({ chapter: CHAPTER_WITH_IMAGE });
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);

  const plan = await handleQuestImagePreview(get('/quest/image/preview', {
    dir: versionDir,
    chapter: 'AAAA0001',
    action: 'add',
    image: 'minecraft:textures/block/stone.png',
    x: 5,
    y: 5,
    width: 2,
    height: 1.5,
  }));
  assert.equal(plan.kind, 'image');
  assert.equal(plan.action, 'add');
  assert.equal(plan.chapterId, 'AAAA0001');
  assert.equal(plan.changedCount, 1);
  assert.deepEqual(plan.changes, [{ field: 'images', label: '装饰图', before: '1 张', after: '2 张' }]);
  assert.ok(plan.diff[0].includes('minecraft:textures/block/stone.png'));
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].name, 'ch1.snbt');
  // 文件正文和 writes 都不能透给界面
  assert.equal(plan.files[0].content, undefined);
  assert.equal(plan.writes, undefined);
  assert.equal(read(chapterPath), before, 'preview 不能写盘');
});

test('装饰图：apply 真写进去，重读多了一张，留了备份', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack({ chapter: CHAPTER_WITH_IMAGE });
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');

  const done = await handleQuestImageApply(post('/quest/image/apply', {
    dir: versionDir,
    chapter: 'AAAA0001',
    action: 'add',
    image: 'minecraft:textures/block/stone.png',
    x: 5,
    y: 5,
    width: 2,
    height: 1.5,
  }));
  assert.equal(done.action, 'add');
  assert.equal(done.backups.length, 1);
  assert.ok(done.lines.some((l) => l.includes('现在这一章有 2 张')));
  assert.ok(done.lines.some((l) => l.includes('0 个新错误')));

  const text = read(chapterPath);
  assert.ok(text.includes('minecraft:textures/block/stone.png'));
  // FTB 的坐标/宽高是 double，必须带 d 后缀，否则游戏里读成 int
  assert.match(text, /width: 2\.0d/);
  assert.match(text, /height: 1\.5d/);
  // 原来那张图一个字节都不能动
  assert.match(text, /image: "umapyoi:textures\/book_images\/book_filler\.png"/);

  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));
  assert.equal(book.issues.errorCount, 0);
});

test('装饰图：挪坐标只改那一张的 x/y，值没变时说「没改动」', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack({ chapter: CHAPTER_WITH_IMAGE });
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');

  const moved = await handleQuestImageApply(post('/quest/image/apply', {
    dir: versionDir, chapter: 'AAAA0001', action: 'move', index: 0, x: 3.5, y: 0,
  }));
  assert.equal(moved.changedCount, 1);
  assert.ok(moved.diff[0].includes('(2, -1) → (3.5, 0)'));
  const text = read(chapterPath);
  assert.match(text, /x: 3\.5d/);
  assert.match(text, /y: 0\.0d/);
  assert.equal(text.includes('x: 2.0d'), false);

  // 再挪到同一个地方：算出来是空计划，一个文件都不写
  const again = await handleQuestImagePreview(get('/quest/image/preview', {
    dir: versionDir, chapter: 'AAAA0001', action: 'move', index: 0, x: 3.5, y: 0,
  }));
  assert.equal(again.changedCount, 0);
  assert.deepEqual(again.files, []);
});

test('装饰图：删掉最后一张，文件还能读、任务不受影响', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack({ chapter: CHAPTER_WITH_IMAGE });
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');

  const done = await handleQuestImageApply(post('/quest/image/apply', {
    dir: versionDir, chapter: 'AAAA0001', action: 'remove', index: 0,
  }));
  assert.equal(done.action, 'remove');
  assert.ok(done.lines.some((l) => l.includes('现在这一章有 0 张')));
  const text = read(chapterPath);
  assert.equal(text.includes('book_filler.png'), false);
  // 别把收尾的 ] 缩进吃掉（老 bug：删除末元素时整行塌到行首）
  assert.match(text, /\n\t\]/);

  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));
  assert.equal(book.questCount, 1);
  assert.equal(book.issues.errorCount, 0);
});

test('装饰图：章节不存在、序号越界、操作名不认识，都报得看得懂', async () => {
  resetQuestCache();
  const { versionDir } = makePack({ chapter: CHAPTER_WITH_IMAGE });
  await throwsCode(
    () => handleQuestImagePreview(get('/quest/image/preview', {
      dir: versionDir, chapter: '没有这一章', action: 'add', image: 'a:b.png', width: 1, height: 1,
    })),
    'QuestNoChapter',
  );
  await throwsCode(
    () => handleQuestImagePreview(get('/quest/image/preview', {
      dir: versionDir, chapter: 'AAAA0001', action: 'remove', index: 99,
    })),
    'QuestImageNotFound',
  );
  await throwsCode(
    () => handleQuestImagePreview(get('/quest/image/preview', {
      dir: versionDir, chapter: 'AAAA0001', action: 'explode',
    })),
    'QuestBadImageAction',
  );
  // 宽高必填：0 尺寸的图在游戏里等于不存在
  await throwsCode(
    () => handleQuestImagePreview(get('/quest/image/preview', {
      dir: versionDir, chapter: 'AAAA0001', action: 'add', image: 'a:b.png', width: 0, height: 3,
    })),
    'QuestBadImageSize',
  );
});

// ------------------------------- 画布数据里的形状 / 大小（2026-11-03「任务书成品预览」）

test('画布数据：节点带真正生效的形状和大小，章节带自己的默认形状', async () => {
  resetQuestCache();
  const chapter = `{
\tid: "AAAA0001"
\tdefault_quest_shape: "hexagon"
\tquests: [
\t\t{
\t\t\tid: "BBBB0001"
\t\t\tx: 0d
\t\t\ty: 0d
\t\t\tshape: "gear"
\t\t\tsize: 2.0d
\t\t\ttasks: [ { id: "T1" type: "item" item: { id: "minecraft:iron_ingot" count: 1 } } ]
\t\t}
\t\t{
\t\t\tid: "BBBB0002"
\t\t\tx: 1d
\t\t\ty: 0d
\t\t\ttasks: [ { id: "T2" type: "item" item: { id: "minecraft:gold_ingot" count: 1 } } ]
\t\t}
\t]
}
`;
  const { versionDir, questDir } = makePack({ chapter });
  // 全局默认形状写 circle：章节自己写了 hexagon，任务自己写了 gear
  fs.writeFileSync(path.join(questDir, 'data.snbt'), '{\n\tdefault_quest_shape: "circle"\n}\n', 'utf8');

  const r = await handleQuestCanvas(get('/quest/canvas', { dir: versionDir }));
  assert.equal(r.chapters.length, 1);
  const ch = r.chapters[0];
  assert.equal(ch.defaultQuestShape, 'hexagon', '章节的默认形状没带出来');
  const own = ch.nodes.find((n) => n.id === 'BBBB0001');
  const inherit = ch.nodes.find((n) => n.id === 'BBBB0002');
  assert.equal(own.shapeEffective, 'gear', '任务自己写的形状没生效');
  assert.equal(own.size, 2, '任务自己写的大小没生效');
  assert.equal(inherit.shapeEffective, 'hexagon', '没写形状的该继承章节的 hexagon');
  // ★ 2026-11-13：画布给出的 `size` 是**真正生效的值**（sizeEffective），
  //   没写 size 的任务跟着章节走，这里是 1（章节没写 default_quest_size）。
  //   文件里那个「用户自己写没写」的原始值在详情接口的 `size` 里（没写 = 0）。
  assert.equal(inherit.size, 1, '没写大小的该沿用生效值 1');
});

// ————— 蓝图式编辑（2026-11-09）：拖进节点 / 复制节点 / 空白处生成节点 —————
// 三条都走 plan → apply 两态。重点盯三件最容易翻车的事：
//   ① 追加要求「往末尾加一条」，不能像 rewriteEntries 那样改掉原第一条；
//   ② 复制节点时条目 id 必须换新（FTB 靠它记玩家进度，两任务共用会一起亮）；
//   ③ 预览阶段绝对不碰盘，apply 写完重读真的是新值。

test('蓝图：把物品拖进任务节点＝追加一条要求，原有要求一条不动，预览不写盘', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);
  // 界面走 post() 的 JSON body，apply 和 preview 用逐字一致的同一份 body
  const body = { dir: versionDir, questId: 'BBBB0001', item: 'minecraft:diamond', count: 3 };

  const plan = await handleQuestNodeItemsPreview(post('/quest/node/items/preview', body));
  assert.equal(read(chapterPath), before, '预览不该写盘');
  assert.equal(plan.changedCount, 1);
  assert.match(plan.diff.join('\n'), /追加「交 3 个 minecraft:diamond」/);

  const done = await handleQuestNodeItemsApply(post('/quest/node/items/apply', body));
  assert.ok(done.backups.length >= 1, '写章节文件该留备份');
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(detail.tasks.length, 2, '应该变成两条要求');
  assert.equal(detail.tasks[0].what, 'minecraft:iron_ingot', '原来那条别动');
  assert.equal(detail.tasks[1].what, 'minecraft:diamond', '新加的那条要在末尾');
  assert.equal(detail.tasks[1].count, 3);
  assert.ok(read(chapterPath).includes('T0000001'), '原条目 id 要留着，别把玩家已交的进度重置了');
});

test('蓝图：同一个物品拖第二次要跳过，不能手抖拖出十条重复', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);
  // BBBB0001 本来就要求交铁锭，再拖一次铁锭进来应该什么都不干
  const body = { dir: versionDir, questId: 'BBBB0001', item: 'minecraft:iron_ingot' };
  const plan = await handleQuestNodeItemsPreview(post('/quest/node/items/preview', body));
  assert.equal(plan.changedCount, 0);
  assert.match(plan.warnings.join('\n'), /已经有/);

  await handleQuestNodeItemsApply(post('/quest/node/items/apply', body));
  assert.equal(read(chapterPath), before, '跳过时一个字都不该写');
  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(detail.tasks.length, 1);
});

test('蓝图：复制整个任务节点，标题 / 简介 / 要求都带过来，条目换新 id', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);
  const body = { dir: versionDir, sourceQuestId: 'BBBB0001', x: 5, y: 3 };

  const plan = await handleQuestClonePreview(post('/quest/clone/preview', body));
  assert.equal(read(chapterPath), before, '预览不写盘');
  const done = await handleQuestCloneApply(post('/quest/clone/apply', body));
  assert.ok(done.questId && done.questId !== 'BBBB0001', '新任务该换个 ID');
  assert.ok(done.backups.length >= 1);

  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: done.questId }));
  assert.equal(detail.title, '打铁', '标题要带过来');
  assert.deepEqual(detail.description, ['先把铁矿烧了', '再做铁锭'], '简介数组要原样带过来');
  assert.equal(detail.x, 5);
  assert.equal(detail.y, 3);
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0].what, 'minecraft:iron_ingot');
  assert.equal(detail.tasks[0].count, 8);
  // 条目的 id 是 FTB 记玩家进度的钥匙：复制时换了新 id，T0000001 就只该剩原任务那一处
  assert.equal((read(chapterPath).match(/T0000001/g) ?? []).length, 1,
    '新任务的条目 id 不能和原任务一样，否则完成一个另一个也亮');
  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));
  assert.equal(book.questCount, 3, '应该真的多了一个任务');
});

test('蓝图：把物品拖到空白处＝真的新建一个任务节点，预览不写盘', async () => {
  resetQuestCache();
  const { versionDir, questDir } = makePack();
  const chapterPath = path.join(questDir, 'chapters', 'ch1.snbt');
  const before = read(chapterPath);
  const body = { dir: versionDir, item: 'minecraft:copper_ingot', count: 5, x: 4, y: 2 };

  const plan = await handleQuestSpawnPreview(post('/quest/spawn/preview', body));
  assert.equal(read(chapterPath), before, '预览不写盘');
  const done = await handleQuestSpawnApply(post('/quest/spawn/apply', body));
  assert.ok(done.questId);
  assert.ok(done.backups.length >= 1);

  const detail = await handleQuestDetail(get('/quest', { dir: versionDir, questId: done.questId }));
  assert.equal(detail.x, 4);
  assert.equal(detail.y, 2);
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0].what, 'minecraft:copper_ingot');
  assert.equal(detail.tasks[0].count, 5);
  // 故意不写标题，FTB 会拿要交的物品名当标题（游戏里显示「铜锭」而不是一串 ID）
  assert.equal(detail.titleSource, 'item');
  const book = await handleQuestBook(get('/questbook', { dir: versionDir }));
  assert.equal(book.questCount, 3, '应该真的多了一个任务');
});

test('蓝图：没给物品 / 没给要复制的任务要报中文错，不能悄悄写成空任务', async () => {
  resetQuestCache();
  const { versionDir } = makePack();
  await throwsCode(
    () => handleQuestSpawnPreview(post('/quest/spawn/preview', { dir: versionDir })),
    'QuestBadItemId',
  );
  await throwsCode(
    () => handleQuestClonePreview(post('/quest/clone/preview', { dir: versionDir })),
    'QuestNotFound',
  );
  await throwsCode(
    () => handleQuestNodeItemsPreview(post('/quest/node/items/preview', {
      dir: versionDir, questId: 'BBBB0001',
    })),
    'QuestBadItemId',
  );
  await throwsCode(
    () => handleQuestNodeItemsPreview(post('/quest/node/items/preview', {
      dir: versionDir, item: 'minecraft:diamond',
    })),
    'QuestNoId',
  );
});

test('画布 bounds：背景图按「中心 ±宽/2、±高/2」算进范围，不只按节点（2026-11-11）', async () => {
  resetQuestCache();
  // CHAPTER_WITH_IMAGE：1 个节点 (0,0)，1 张图中心 (2,-1)、宽高 7 ⇒
  // 图占 x[-1.5, 5.5]、y[-4.5, 2.5]；只按节点算会错成全 0。
  const { versionDir } = makePack({ chapter: CHAPTER_WITH_IMAGE });
  const r = await handleQuestCanvas(get('/quest/canvas', { dir: versionDir }));
  const b = r.chapters[0].bounds;
  assert.equal(b.minX, -1.5, '左边界没算进背景图左半边');
  assert.equal(b.maxX, 5.5, '右边界没算进背景图右半边');
  assert.equal(b.minY, -4.5, '上边界没算进背景图上半边');
  assert.equal(b.maxY, 2.5, '下边界没算进背景图下半边');
});



test('前置/后续用标题不用编号：没标题的任务退回副标题，绝不把 16 位 ID 塞进列表（2026-11-11 用户报障）', async () => {
  // 真包场景（ATM10Sky 实测）：一个「纯打勾」的任务在 lang 里既没 title 也没
  // 第一个物品可以拿来当标题，只有副标题。它在别人的前置列表里以前显示成
  // `36DEA17CBB696CC7` 这种 16 位编号，用户看不懂。
  const chapter = `{
	id: "AAAA0001"
	order_index: 0
	filename: "ch1"
	quests: [
		{
			id: "NOTITLE00000001"
			x: 0d
			y: 0d
			tasks: [{ id: "T1", type: "checkmark" }]
		}
		{
			id: "BBBB0001"
			x: 1d
			y: 0d
			dependencies: ["NOTITLE00000001"]
			tasks: [
				{
					id: "T2"
					type: "item"
					item: { id: "minecraft:iron_ingot", count: 8 }
				}
			]
		}
	]
}
`;
  resetQuestCache();
  const { versionDir, questDir } = makePack({ chapter });
  // 副标题就是那个任务唯一的人话
  fs.writeFileSync(
    path.join(questDir, 'lang', 'zh_cn.snbt'),
    `{
	quest.BBBB0001.title: "打铁"
	quest.NOTITLE00000001.quest_subtitle: "成为网络管理员！"
}
`,
    'utf8',
  );

  const q = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'BBBB0001' }));
  assert.equal(q.upstream.length, 1);
  assert.equal(q.upstream[0].id, 'NOTITLE00000001', 'id 字段要保持原样，别改成显示名');
  assert.equal(q.upstream[0].title, '成为网络管理员！', '前置该显示副标题，不是编号');

  // 反过来看那个没标题任务自己的详情：标题栏也该是人话，但 rawTitle 要保留真值
  const up = await handleQuestDetail(get('/quest', { dir: versionDir, questId: 'NOTITLE00000001' }));
  assert.equal(up.title, '成为网络管理员！', '标题栏不该显示编号');
  assert.equal(up.rawTitle, 'NOTITLE00000001', 'rawTitle 必须是文件里的真值（改名表单靠它预填）');
  assert.equal(up.titleSource, 'id');
});
