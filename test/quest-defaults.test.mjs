/**
 * 任务字段默认值（照搬 Visual Studio 原则 1）+ 「等于默认就删键」。
 *
 * 用户 2026-11-13 拍板：「默认值的形式照搬 Visual Studio」，
 * 三条原则里的第一条 = **值等于默认值就不写进文件**。
 *
 * 这个文件守住三件事：
 *   1. `quest-defaults.js` 的判定本身对（尤其三态，false ≠ 没写）；
 *   2. `addQuest()` 新建任务时不把默认值写进去；
 *   3. `patchQuestFields()` 把值改回默认时**能删键**（新能力，以前只会改值）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  QUEST_FIELDS, defaultOf, isDefault, knownField, normalizeForWrite, pickWritable, shouldWrite,
} from '../packages/core/quest-defaults.js';
import { addQuest, loadQuests, patchQuestFields } from '../packages/core/quests.js';

// ————————————————————————— 纯函数：判定 —————————————————————————

test('isDefault：不认识字段一律返回 false（宁可多写，也别悄悄吞数据）', () => {
  assert.equal(isDefault('x', 0), false);
  assert.equal(isDefault('tasks', []), false);
  assert.equal(isDefault('将来新加的字段', 0), false);
  assert.equal(knownField('x'), false);
  assert.equal(knownField('size'), true);
});

test('isDefault：布尔字段 false 和没写等价（游戏读的时候也这么判）', () => {
  for (const key of ['optional', 'invisible', 'hide_dependent_lines', 'ignore_reward_blocking']) {
    assert.equal(isDefault(key, false), true, `${key}: false 该算默认`);
    assert.equal(isDefault(key, undefined), true, `${key}: 没写该算默认`);
    assert.equal(isDefault(key, null), true, `${key}: null 该算默认`);
    assert.equal(isDefault(key, true), false, `${key}: true 不该算默认`);
  }
});

test('★ isDefault：三态字段「false 不等于没写」（2026-11-12 踩过一次的老坑）', () => {
  for (const key of ['can_repeat', 'hide_dependency_lines', 'hide_until_deps_complete', 'disable_jei']) {
    assert.equal(isDefault(key, undefined), true, `${key}: 没写 = 跟随上级，是默认`);
    assert.equal(isDefault(key, null), true, `${key}: null 也是没写`);
    // ★ 这两条是本文件最重要的断言
    assert.equal(isDefault(key, false), false,
      `${key}: 显式 false **不是**默认值 —— 它是「明确关掉」，写回文件时不能删`);
    assert.equal(isDefault(key, true), false, `${key}: true 当然也不是默认`);
  }
});

test('isDefault：数字按各自默认值判（size 的默认是 0 不是 1）', () => {
  // ★ 这条是 2026-11-13 修掉的语义坑：FTB 里 size=0 表示「跟随章节」，
  //   我们旧代码用 !== 1 判，结论碰巧一样但语义是错的。
  assert.equal(defaultOf('size'), 0, 'size 的默认值必须是 0（跟随章节）');
  assert.equal(isDefault('size', 0), true, 'size=0 是默认，不写');
  assert.equal(isDefault('size', 1), false, '★ size=1 是「明确 1 倍」，要写');
  assert.equal(isDefault('size', 1.5), false);

  assert.equal(isDefault('min_required_dependencies', 0), true);
  assert.equal(isDefault('min_required_dependencies', 2), false);
  assert.equal(isDefault('icon_scale', 1), true, 'icon_scale 默认 1');
  assert.equal(isDefault('icon_scale', 1.5), false);
});

test('isDefault：字符串空串是默认，枚举等于默认名是默认', () => {
  assert.equal(isDefault('shape', ''), true);
  assert.equal(isDefault('shape', 'gear'), false);
  assert.equal(isDefault('subtitle', ''), true);
  assert.equal(isDefault('guide_page', 'x.md'), false);
  assert.equal(isDefault('dependency_requirement', 'all_completed'), true);
  assert.equal(isDefault('dependency_requirement', 'one_completed'), false);
  assert.equal(isDefault('progression_mode', 'default'), true);
});

test('pickWritable：剔掉等于默认的，保留非默认的，丢掉 undefined', () => {
  const out = pickWritable({
    optional: false,     // 默认 → 剔
    invisible: true,     // 非默认 → 留
    size: 0,             // 默认 → 剔
    shape: 'gear',       // 非默认 → 留
    can_repeat: false,   // 三态里 false 不是默认 → 留
    min_width: undefined, // 没给 → 丢
    x: 3,                // 不认识的字段 → 原样留
  });
  assert.deepEqual(out, { invisible: true, shape: 'gear', can_repeat: false, x: 3 });
});

test('shouldWrite / normalizeForWrite：三态只认 true/false，其它当没写', () => {
  assert.equal(shouldWrite('optional', true), true);
  assert.equal(shouldWrite('optional', false), false);
  assert.equal(normalizeForWrite('can_repeat', true), true);
  assert.equal(normalizeForWrite('can_repeat', false), false);
  assert.equal(normalizeForWrite('can_repeat', 'true'), true, '字符串 true 也认');
  assert.equal(normalizeForWrite('can_repeat', '乱写'), undefined, '认不出的当没写');
  assert.equal(normalizeForWrite('size', '2.5'), 2.5);
  assert.equal(normalizeForWrite('size', 'abc'), undefined);
  assert.equal(normalizeForWrite('optional', 1), true, '布尔字段归一成真布尔');
});

test('QUEST_FIELDS 表本身：每个字段都写了默认值和写盘规则', () => {
  for (const [key, spec] of Object.entries(QUEST_FIELDS)) {
    assert.ok(Object.hasOwn(spec, 'def'), `${key} 缺 def`);
    assert.ok(spec.write, `${key} 缺 write 规则`);
    assert.ok(spec.note, `${key} 缺说明（这张表是唯一真源，得讲清来历）`);
  }
});

// ————————————————————————— 写盘：addQuest —————————————————————————

function tmpStore(chapterSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-defaults-'));
  const dir = path.join(root, 'quests');
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lang'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chapters', 'CH1.snbt'), chapterSource, 'utf8');
  fs.writeFileSync(path.join(dir, 'lang', 'en_us.snbt'), '{}', 'utf8');
  return dir;
}

const CH1 = '{ \n\tfilename: "CH1"\n\tid: "CH1"\n\tquests: [ ]\n}\n';

test('★ addQuest：默认值一个键都不写（新建「只填名字」的任务就只剩 id/x/y）', () => {
  const out = addQuest(CH1, {
    id: 'Q_NEW', x: 1, y: 2,
    // 下面全是默认值，一个都不该出现在文件里
    shape: '', size: 0, optional: false, invisible: false,
    min_required_dependencies: 0, dependency_requirement: 'all_completed',
    icon_scale: 1, min_width: 0, guide_page: '', progression_mode: 'default',
  }, 'chapters/CH1.snbt');

  for (const key of ['shape', 'size', 'optional', 'invisible', 'min_required_dependencies',
    'dependency_requirement', 'icon_scale', 'min_width', 'guide_page', 'progression_mode']) {
    assert.ok(!out.includes(`${key}:`), `默认值 ${key} 不该写进文件`);
  }
  // 但 id / x / y 必须在（坐标没有「默认值」概念）
  assert.match(out, /id: "Q_NEW"/);
  assert.match(out, /x: 1/);
  assert.match(out, /y: 2/);
});

test('★ addQuest：空的任务/奖励/依赖不写（这就是用户拍板的「空任务」形态）', () => {
  const out = addQuest(CH1, { id: 'Q_EMPTY', x: 0, y: 0, tasks: [], rewards: [], dependencies: [] }, 'c');
  assert.ok(!out.includes('tasks:'), '空 conditions 不该写 tasks 键');
  assert.ok(!out.includes('rewards:'), '空奖励不该写 rewards 键');
  assert.ok(!out.includes('dependencies:'), '空依赖不该写');
});

test('addQuest：非默认值照写（true / 非零 / 非空串 / 非默认枚举）', () => {
  const out = addQuest(CH1, {
    id: 'Q_FULL', x: 0, y: 0,
    optional: true, invisible: true, size: 2, shape: 'gear',
    min_width: 5, guide_page: 'page1', dependency_requirement: 'one_completed',
  }, 'c');
  assert.match(out, /optional: true/);
  assert.match(out, /invisible: true/);
  assert.match(out, /size: 2/);
  assert.match(out, /shape: "gear"/);
  assert.match(out, /min_width: 5/);
  assert.match(out, /guide_page: "page1"/);
  assert.match(out, /dependency_requirement: "one_completed"/);
});

test('★ addQuest：size=1 要写出来（不是默认值），size=0 不写', () => {
  // 这条专门守 2026-11-13 修的语义坑：旧代码用 !== 1 判，size=1 会被吞掉
  const one = addQuest(CH1, { id: 'Q_S1', x: 0, y: 0, size: 1 }, 'c');
  assert.match(one, /size: 1/, 'size=1 是「明确 1 倍」，必须写');
  const zero = addQuest(CH1, { id: 'Q_S0', x: 0, y: 0, size: 0 }, 'c');
  assert.ok(!zero.includes('size:'), 'size=0 是跟随章节，不该写');
});

test('addQuest：三态字段 false 要写出来（不能当「没写」处理）', () => {
  const out = addQuest(CH1, { id: 'Q_TRI', x: 0, y: 0, can_repeat: false }, 'c');
  assert.match(out, /can_repeat: false/, '三态的 false 是「明确不可重复」，必须写');
});

// ————————————————————————— 写盘：patchQuestFields 的删键 —————————————————————————

const CH_WITH_QUEST = `{
	filename: "CH1"
	id: "CH1"
	quests: [ 
		{
			id: "Q_A"
			optional: true
			shape: "gear"
			size: 2.0d
			x: 0
			y: 0
		}
	]
}
`;

test('★ patchQuestFields：把值改回默认 ⇒ 这个键从文件里消失（新能力）', () => {
  const r = patchQuestFields(CH_WITH_QUEST, 'Q_A', { optional: false }, 'c');
  assert.equal(r.changed, true);
  assert.ok(!r.source.includes('optional'), 'optional 该整行消失');
  // 别的字段一个字节都不能动
  assert.match(r.source, /shape: "gear"/);
  assert.match(r.source, /size: 2\.0d/);
  // 改完还得能解析
  assert.doesNotThrow(() => patchQuestFields(r.source, 'Q_A', { x: 1 }, 'c'));
});

test('★ patchQuestFields：删键只删那一行，不留空行、不破坏缩进', () => {
  const r = patchQuestFields(CH_WITH_QUEST, 'Q_A', { shape: '' }, 'c');
  assert.ok(!r.source.includes('shape'), 'shape 该消失');
  assert.ok(!/\n\t*\n/.test(r.source), '不该留下空行');
  assert.match(r.source, /\t\t\toptional: true\n\t\t\tsize: 2\.0d/, '相邻两行要接上');
});

test('patchQuestFields：值改回默认但键本来就不存在 ⇒ 不算改动', () => {
  const r = patchQuestFields(CH_WITH_QUEST, 'Q_A', { invisible: false }, 'c');
  assert.equal(r.changed, false, '键本来没有、值又是默认，不该产生改动');
  assert.equal(r.source, CH_WITH_QUEST);
});

test('patchQuestFields：一次删多个键都删对（从后往前改，位置不能错乱）', () => {
  const r = patchQuestFields(CH_WITH_QUEST, 'Q_A', { optional: false, shape: '', size: 0 }, 'c');
  assert.ok(!r.source.includes('optional'));
  assert.ok(!r.source.includes('shape'));
  assert.ok(!r.source.includes('size'));
  assert.match(r.source, /id: "Q_A"/, 'id 不能被误删');
  assert.match(r.source, /x: 0/, '坐标不能被误删');
});

test('patchQuestFields：三态改回「没写」（传 null）也删键', () => {
  const src = `{
	quests: [ 
		{
			id: "Q_B"
			can_repeat: false
			x: 0
			y: 0
		}
	]
}
`;
  const r = patchQuestFields(src, 'Q_B', { can_repeat: null }, 'c');
  assert.ok(!r.source.includes('can_repeat'), 'null = 跟随上级，该删');
});

test('patchQuestFields：不认识的字段（x / tasks 等）永远不会被当成默认值删掉', () => {
  const r = patchQuestFields(CH_WITH_QUEST, 'Q_A', { x: 0 }, 'c');
  // x 本来是 0，传 0 属于「值没变」，不该产生改动 —— 更不能被删
  assert.equal(r.changed, false);
  assert.match(r.source, /x: 0/);
});

// ————————————————————————— 端到端：写盘后能读回来 —————————————————————————

test('★ 端到端：新建空任务 → 落盘 → 读回来是空条件空奖励', () => {
  const questDir = tmpStore(CH1);
  const out = addQuest(
    fs.readFileSync(path.join(questDir, 'chapters', 'CH1.snbt'), 'utf8'),
    { id: 'Q_E2E', x: 1, y: 1 },
    'chapters/CH1.snbt',
  );
  fs.writeFileSync(path.join(questDir, 'chapters', 'CH1.snbt'), out, 'utf8');

  const store = loadQuests(questDir);
  const q = store.questsById.get('Q_E2E');
  assert.ok(q, '读不回新任务');
  assert.deepEqual(q.tasks, [], '空任务的完成条件该是空表');
  assert.deepEqual(q.rewards, [], '空任务的奖励该是空表');
  assert.equal(q.optional, false, '没写 optional 读出来就是 false');
  assert.equal(q.canRepeat, null, '没写 can_repeat 读出来该是 null（跟随上级）');
});

test('★ 端到端：三态读→写→读，不丢「缺失」这个状态', () => {
  const questDir = tmpStore(CH1);
  let src = fs.readFileSync(path.join(questDir, 'chapters', 'CH1.snbt'), 'utf8');
  // 1. 写一个没有 can_repeat 的任务
  src = addQuest(src, { id: 'Q_T', x: 0, y: 0 }, 'c');
  fs.writeFileSync(path.join(questDir, 'chapters', 'CH1.snbt'), src, 'utf8');
  assert.equal(loadQuests(questDir).questsById.get('Q_T').canRepeat, null, '一开始该是「没写」');

  // 2. 写成 false
  const r1 = patchQuestFields(src, 'Q_T', { can_repeat: false }, 'c');
  fs.writeFileSync(path.join(questDir, 'chapters', 'CH1.snbt'), r1.source, 'utf8');
  assert.equal(loadQuests(questDir).questsById.get('Q_T').canRepeat, false, '显式 false 读回来该是 false');

  // 3. 改回「没写」
  const r2 = patchQuestFields(r1.source, 'Q_T', { can_repeat: null }, 'c');
  fs.writeFileSync(path.join(questDir, 'chapters', 'CH1.snbt'), r2.source, 'utf8');
  assert.equal(loadQuests(questDir).questsById.get('Q_T').canRepeat, null,
    '★ 改回默认后必须重新是 null，不能变成 false');
});
