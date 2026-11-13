/**
 * 任务「完成条件 / 奖励」类型目录的单测。
 *
 * 全部断言照 packages/core/quest-conditions.js 的真实行为写：
 * 字段叫什么、数字是不是 SnbtLong、错误码是什么，都按实测来，不凭印象。
 * 遇到「实现和直觉/注释略有出入」的地方，只在这里如实记录真实值并写进给 lead 的报告，
 * 绝不改 core 模块。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TASK_TYPES, REWARD_TYPES,
  taskDef, rewardDef, typeLabel,
  buildTask, buildReward,
  specFromTask, specFromReward, sameSpec, describeSpec,
  summarizeTask, summarizeReward,
  buildEntry, requiredFields, missingFields,
  entryWhat, entryCount,
  parseSpecValue, specFromParams, entryFromSpec,
} from '../packages/core/quest-conditions.js';
import { SnbtLong } from '../packages/core/snbt.js';
import { McError } from '../packages/core/errors.js';

/** 断言某个调用抛出 McError 且 code 相符。 */
function throwsCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof McError, `应该抛 McError，实际是 ${error?.constructor?.name}`);
    assert.equal(error.code, code, `code 不对：${error.message}`);
    return error;
  }
  assert.fail(`应该抛 ${code}，但没有抛`);
}

test('1. TASK_TYPES / REWARD_TYPES 数量与形状，taskDef 查定义、不认识返回 null', () => {
  // 当前目录快照：13 种条件（2026-11-12 第五批补了 fluid / custom）、
  // 9 种奖励（3 种战利品表奖励由同一张表展开）
  assert.equal(TASK_TYPES.length, 13);
  assert.equal(REWARD_TYPES.length, 9);
  for (const t of [...TASK_TYPES, ...REWARD_TYPES]) {
    assert.equal(typeof t.type, 'string', '每项都要有 type');
    assert.equal(typeof t.label, 'string', '每项都要有中文 label');
    assert.ok(Array.isArray(t.fields), '每项都要有 fields 数组');
  }
  const taskNames = TASK_TYPES.map((t) => t.type);
  for (const name of ['item', 'checkmark', 'kill']) {
    assert.ok(taskNames.includes(name), `条件类型里应该有 ${name}`);
  }
  const rewardNames = REWARD_TYPES.map((t) => t.type);
  for (const name of ['item', 'xp', 'xp_levels', 'command', 'choice']) {
    assert.ok(rewardNames.includes(name), `奖励类型里应该有 ${name}`);
  }

  const itemDef = taskDef('item');
  assert.ok(itemDef, "taskDef('item') 应该拿得到定义");
  assert.equal(itemDef.type, 'item');
  assert.equal(typeof itemDef.build, 'function');
  assert.equal(typeof itemDef.extract, 'function');
  assert.equal(typeof itemDef.describe, 'function');
  assert.equal(taskDef('不认识的类型'), null);
  assert.equal(rewardDef('不认识的类型'), null);

  // 顺手：typeLabel 认识就给中文名，不认识原样回显
  assert.equal(typeLabel('task', 'item'), '交物品');
  assert.equal(typeLabel('reward', 'xp'), '给经验点');
  assert.equal(typeLabel('task', '啥玩意'), '啥玩意');
});

test('2. buildTask 顶层 count 是 SnbtLong、item.count 恒为 1；buildReward 顶层 count 是普通数字', () => {
  const t = buildTask({ type: 'item', item: 'minecraft:iron_ingot', count: 8 });
  assert.ok(t.count instanceof SnbtLong, '任务条件的顶层 count 必须是 SnbtLong（带 L）');
  assert.equal(t.count.toString(), '8');
  assert.equal(t.count.toJSON(), '8');
  assert.deepEqual(t.item, { id: 'minecraft:iron_ingot', count: 1 });

  const r = buildReward({ type: 'item', item: 'minecraft:diamond', count: 8 });
  assert.equal(typeof r.count, 'number', '奖励的顶层 count 必须是普通数字');
  assert.equal(r.count, 8);
  assert.equal(r.count instanceof SnbtLong, false, '奖励的 count 不该带 L');
  assert.deepEqual(r.item, { id: 'minecraft:diamond', count: 1 });
});

test('3. kill 的 value、xp 任务的 value/points 都是 SnbtLong / 布尔', () => {
  const k = buildTask({ type: 'kill', entity: 'minecraft:zombie', count: 3 });
  assert.ok(k.value instanceof SnbtLong, 'kill 的 value 是 long');
  assert.equal(k.value.toString(), '3');
  assert.equal(k.entity, 'minecraft:zombie');

  const x = buildTask({ type: 'xp', count: 5, points: true });
  assert.ok(x.value instanceof SnbtLong, 'xp 任务的 value 是 long');
  assert.equal(x.value.toString(), '5');
  assert.equal(x.points, true);
  assert.equal(typeof x.points, 'boolean');

  // 没传 points 时也要落成布尔 false，而不是 undefined
  const x2 = buildTask({ type: 'xp', count: 5 });
  assert.equal(x2.points, false);
  assert.equal(typeof x2.points, 'boolean');
});

test('4. specFromTask / specFromReward 从顶层与嵌套两种写法归一出相同 spec、带人话 label、不认识返回 null', () => {
  const taskTop = { type: 'item', item: { id: 'minecraft:iron_ingot', count: 1 }, count: new SnbtLong('8') };
  const taskNested = { type: 'item', item: { id: 'minecraft:iron_ingot', count: 8 } };
  const a = specFromTask(taskTop);
  const b = specFromTask(taskNested);
  assert.deepEqual(a, b, '顶层 count 和 item.count 两种写法要归一成同一个 spec');
  assert.equal(typeof a.count, 'number', 'spec 里的 count 是普通数字');
  assert.equal(a.count, 8);
  assert.equal(a.label, '交 8 个 minecraft:iron_ingot');

  const rewardTop = { type: 'item', item: { id: 'minecraft:diamond', count: 1 }, count: 8 };
  const rewardNested = { type: 'item', item: { id: 'minecraft:diamond', count: 8 } };
  const c = specFromReward(rewardTop);
  const d = specFromReward(rewardNested);
  assert.deepEqual(c, d);
  assert.equal(typeof c.count, 'number');
  assert.equal(c.label, '给 8 个 minecraft:diamond');

  // kill 从 value（SnbtLong）归一回普通数字 count，并给出人话
  const kill = specFromTask({ type: 'kill', entity: 'minecraft:zombie', value: new SnbtLong('3') });
  assert.equal(kill.count, 3);
  assert.equal(kill.label, '杀 3 只 minecraft:zombie');

  assert.equal(specFromTask({ type: '不认识的类型' }), null);
  assert.equal(specFromReward({ type: '不认识的类型' }), null);

  // 顺手：汇总视图带 spec / label / what / count；不认识的类型 spec 为 null、label 标「改不了」
  const sum = summarizeTask(taskTop);
  assert.equal(sum.type, 'item');
  assert.equal(sum.label, '交 8 个 minecraft:iron_ingot');
  assert.equal(sum.what, 'minecraft:iron_ingot');
  assert.equal(sum.count, 8);
  assert.ok(sum.spec);
  const sumR = summarizeReward({ type: '不认识的类型' });
  assert.equal(sumR.spec, null);
  assert.equal(sumR.label, '不认识的类型（界面还改不了）');
});

test('5. sameSpec 同义归一判等、真改动判不等；describeSpec 出中文人话', () => {
  const base = { type: 'kill', entity: 'minecraft:zombie', count: 3 };
  // 同一个意思，count 写法一个是数字一个是字符串（number 字段按 Number 归一）
  assert.equal(sameSpec(base, { type: 'kill', entity: 'minecraft:zombie', count: '3' }), true);
  // 同一个意思，count 没写、按字段默认值 1 算
  assert.equal(sameSpec({ type: 'item', item: 'x', count: 1 }, { type: 'item', item: 'x' }), true);
  // 真改动：数量
  assert.equal(sameSpec(base, { type: 'kill', entity: 'minecraft:zombie', count: 5 }), false);
  // 真改动：类型
  assert.equal(sameSpec({ type: 'item', item: 'x', count: 1 }, { type: 'kill', entity: 'x', count: 1 }), false);

  assert.equal(describeSpec('task', { type: 'item', item: 'minecraft:iron_ingot', count: 8 }), '交 8 个 minecraft:iron_ingot');
  assert.equal(describeSpec('reward', { type: 'xp', count: 100 }), '给 100 点经验');
  assert.equal(describeSpec('task', { type: 'kill', entity: 'minecraft:zombie', count: 3 }), '杀 3 只 minecraft:zombie');
});

test('6. buildEntry 换类型只留 icon/tags 并沿用旧 id、item 数量规整到顶层、新建用 newId', () => {
  // 换类型：旧类型专属字段（item/count）不留，只留用户自己配的 icon / tags，且沿用旧 id
  const oldItem = {
    id: 'OLD1', type: 'item', item: { id: 'a', count: 1 },
    icon: 'minecraft:stone', tags: ['t1'], count: new SnbtLong('2'),
  };
  const switched = buildEntry('task', { type: 'kill', entity: 'minecraft:zombie', count: 3 }, oldItem,
    () => { throw new Error('沿用旧 id 时不该调 newId'); });
  assert.equal(switched.id, 'OLD1');
  assert.equal(switched.icon, 'minecraft:stone');
  assert.deepEqual(switched.tags, ['t1']);
  assert.equal(switched.type, 'kill');
  assert.equal(switched.entity, 'minecraft:zombie');
  assert.ok(switched.value instanceof SnbtLong);
  assert.equal(switched.item, undefined, '换类型后不该残留旧的 item');

  // 同类型 item：把数量规整到顶层（任务 SnbtLong / 奖励普通数字），物品堆 count 恒 1，
  // 旧 item 里的其它字段（比如 tag）保留
  const oldNested = { id: 'OLD2', type: 'item', item: { id: 'minecraft:iron_ingot', count: 8, tag: '{Damage:0}' } };
  const taskItem = buildEntry('task', { type: 'item', item: 'minecraft:iron_ingot', count: 8 }, oldNested, () => 'NEW');
  assert.equal(taskItem.id, 'OLD2');
  assert.equal(taskItem.item.id, 'minecraft:iron_ingot');
  assert.equal(taskItem.item.count, 1);
  assert.equal(taskItem.item.tag, '{Damage:0}');
  assert.ok(taskItem.count instanceof SnbtLong, '任务条件顶层 count 带 L');
  assert.equal(taskItem.count.toString(), '8');

  const rewardItem = buildEntry('reward', { type: 'item', item: 'minecraft:diamond', count: 8 }, oldNested, () => 'NEW');
  assert.equal(typeof rewardItem.count, 'number', '奖励顶层 count 不带 L');
  assert.equal(rewardItem.count, 8);
  assert.equal(rewardItem.item.count, 1);

  // 数量是 1 时不写顶层 count
  const one = buildEntry('task', { type: 'item', item: 'minecraft:iron_ingot', count: 1 }, oldNested, () => 'NEW');
  assert.equal(one.count, undefined);

  // 新建（oldEntry=null）用 newId 工厂给的 id
  const fresh = buildEntry('task', { type: 'item', item: 'minecraft:iron_ingot', count: 8 }, null, () => 'GEN1');
  assert.equal(fresh.id, 'GEN1');
  assert.ok(fresh.count instanceof SnbtLong);
});

test('7. requiredFields / missingFields：checkmark 无必填、kill 缺 entity、advancement 的 criterion 可选', () => {
  assert.deepEqual(requiredFields('task', 'checkmark'), []);
  assert.deepEqual(requiredFields('task', 'kill'), ['entity']);
  assert.deepEqual(requiredFields('task', 'advancement'), ['advancement'], 'criterion 不算必填');
  assert.deepEqual(requiredFields('reward', 'command'), ['command']);
  assert.deepEqual(requiredFields('task', '不认识的类型'), []);

  assert.deepEqual(missingFields('task', { type: 'kill', value: new SnbtLong('3') }), ['entity']);
  assert.deepEqual(missingFields('task', { type: 'kill', entity: 'minecraft:zombie', value: new SnbtLong('3') }), []);
  assert.deepEqual(missingFields('task', { type: 'checkmark' }), []);
  // 只填了进度 ID、没填 criterion，也算填全了
  assert.deepEqual(missingFields('task', { type: 'advancement', advancement: 'minecraft:story/root' }), []);
});

test('8. parseSpecValue：JSON 串→对象、对象原样、非法 JSON / 数组串抛 McBadArgs、空值 undefined', () => {
  assert.deepEqual(parseSpecValue('{"type":"item","count":3}'), { type: 'item', count: 3 });
  const obj = { type: 'kill', entity: 'minecraft:zombie' };
  assert.equal(parseSpecValue(obj), obj, '对象原样返回（同一个引用）');

  throwsCode(() => parseSpecValue('{这不是 JSON'), 'McBadArgs');
  throwsCode(() => parseSpecValue('[1, 2]'), 'McBadArgs'); // 数组 JSON 串是非法 spec
  throwsCode(() => parseSpecValue('"就一个字符串"'), 'McBadArgs');

  assert.equal(parseSpecValue(''), undefined);
  assert.equal(parseSpecValue('   '), undefined);
  assert.equal(parseSpecValue(undefined), undefined);
  assert.equal(parseSpecValue(null), undefined);

  // 疑点记录：直接传 JS 数组对象（不是 JSON 串）时，parseSpecValue 静默返回 undefined，
  // 与「格式不对就明说」的注释略有出入。这里如实锁定真实行为，不改 core，写进给 lead 的报告。
  assert.equal(parseSpecValue([1, 2]), undefined);
});

test('9. specFromParams：taskSpec 优先、老字段转 item、都没有返回 undefined', () => {
  // 新字段优先（即使同时给了老的 taskItem / taskCount）
  const prefer = specFromParams({
    taskSpec: '{"type":"kill","entity":"minecraft:zombie","count":5}',
    taskItem: 'minecraft:iron_ingot', taskCount: 8,
  }, 'task');
  assert.deepEqual(prefer, { type: 'kill', entity: 'minecraft:zombie', count: 5 });

  // 新字段也收对象
  assert.deepEqual(specFromParams({ rewardSpec: { type: 'xp', count: 100 } }, 'reward'), { type: 'xp', count: 100 });

  // 没有新字段，退回老的 item / count，转成 item 类型 spec
  assert.deepEqual(specFromParams({ taskItem: 'minecraft:iron_ingot', taskCount: 8 }, 'task'),
    { type: 'item', item: 'minecraft:iron_ingot', count: 8 });
  assert.deepEqual(specFromParams({ rewardItem: 'minecraft:diamond', rewardCount: 3 }, 'reward'),
    { type: 'item', item: 'minecraft:diamond', count: 3 });
  // count 没给 / 不合法时按 1
  assert.deepEqual(specFromParams({ taskItem: 'minecraft:iron_ingot' }, 'task'),
    { type: 'item', item: 'minecraft:iron_ingot', count: 1 });

  // 两种都没有 → undefined（这一组不用动）
  assert.equal(specFromParams({}, 'task'), undefined);
  assert.equal(specFromParams(null, 'task'), undefined);
  assert.equal(specFromParams({ rewardCount: 8 }, 'reward'), undefined);
});

test('10. entryFromSpec：空 item 返回 null、不认识抛 QuestUnsupportedCondition、缺必填抛 QuestMissingField、正常返回不带 id', () => {
  assert.equal(entryFromSpec({ type: 'item', item: '', count: 8 }, 'task'), null);
  assert.equal(entryFromSpec({ type: 'item', item: '   ', count: 8 }, 'task'), null);

  throwsCode(() => entryFromSpec({ type: '不认识的类型' }, 'task'), 'QuestUnsupportedCondition');
  throwsCode(() => entryFromSpec({ type: '不认识的类型' }, 'reward'), 'QuestUnsupportedCondition');
  throwsCode(() => entryFromSpec({ type: 'kill', count: 3 }, 'task'), 'QuestMissingField');

  const task = entryFromSpec({ type: 'item', item: 'minecraft:iron_ingot', count: 8 }, 'task');
  assert.equal(task.id, undefined, '新条目不带 id');
  assert.equal(task.type, 'item');
  assert.deepEqual(task.item, { id: 'minecraft:iron_ingot', count: 1 });
  assert.ok(task.count instanceof SnbtLong);

  const reward = entryFromSpec({ type: 'xp', count: 100 }, 'reward');
  assert.equal(reward.id, undefined);
  assert.deepEqual(reward, { type: 'xp', xp: 100 });
});

test('11. entryWhat / entryCount：kill、xp、item 的主要标识与数量', () => {
  const kill = { type: 'kill', entity: 'minecraft:zombie', value: new SnbtLong('3') };
  assert.equal(entryWhat(kill), 'minecraft:zombie');
  assert.equal(entryCount(kill), 3);

  // 任务 xp：主要标识和数量都写在 value（SnbtLong）
  const taskXp = { type: 'xp', value: new SnbtLong('5'), points: true };
  assert.equal(entryWhat(taskXp), '5');
  assert.equal(entryCount(taskXp), 5);

  // 奖励 xp：主要标识写在 xp 字段
  const rewardXp = { type: 'xp', xp: 100 };
  assert.equal(entryWhat(rewardXp), '100');
  assert.equal(entryWhat({ type: 'xp_levels', xp_levels: 5 }), '5');
  // 疑点记录：entryCount 只认 count / item.count / value，不认奖励的 xp / xp_levels，
  // 所以这里如实锁定它返回兜底值 1（和 what 对不上）。不改 core，写进给 lead 的报告。
  assert.equal(entryCount(rewardXp), 1);

  const item = { type: 'item', item: { id: 'minecraft:iron_ingot', count: 1 }, count: new SnbtLong('8') };
  assert.equal(entryWhat(item), 'minecraft:iron_ingot');
  assert.equal(entryCount(item), 8);
  // 顶层 count 优先于物品堆里的 count
  assert.equal(entryCount({ type: 'item', item: { id: 'x', count: 99 }, count: new SnbtLong('2') }), 2);
  // 旧文件把数量塞在 item.count 里也能读出来
  assert.equal(entryCount({ type: 'item', item: { id: 'minecraft:iron_ingot', count: 8 } }), 8);
});

test('13. 【2026-11-12 第五批】item 有两种形态：字符串和复合，都要读得出 ID', () => {
  // 源码 NBTUtils.java:19-44：item 既可以是 String 也可以是 Compound。
  // 以前三处都写 `entry?.item?.id`，遇到字符串形态时 .id 是 undefined → 物品 ID 变空。
  // 真包实测 ATM10Sky 6440 处全是复合、0 处字符串（所以一直没爆），但换个包就中招。

  // ① 字符串形态
  const strForm = { id: 'T1', type: 'item', item: 'minecraft:iron_ingot' };
  assert.equal(entryWhat(strForm), 'minecraft:iron_ingot', '字符串形态要读出 ID');
  const strSpec = specFromTask(strForm);
  assert.equal(strSpec.item, 'minecraft:iron_ingot');
  assert.equal(strSpec.count, 1, '字符串形态没有自己的 count，按 1 算');

  // ② 复合形态（真包里的写法）
  const compound = { id: 'T2', type: 'item', item: { id: 'minecraft:diamond', count: 1 }, count: new SnbtLong('4') };
  assert.equal(entryWhat(compound), 'minecraft:diamond');
  assert.equal(specFromTask(compound).item, 'minecraft:diamond');
  assert.equal(entryCount(compound), 4, '顶层 count 优先');

  // ③ 复合形态、数量塞在 item.count 里（老写法）
  const legacy = { id: 'T3', type: 'item', item: { id: 'minecraft:coal', count: 8 } };
  assert.equal(entryCount(legacy), 8, '数量塞在 item.count 里也要读出来');

  // ④ 两种都不该让 label 变成「（没填物品）」
  assert.match(specFromTask(strForm).label, /minecraft:iron_ingot/);
  assert.match(specFromTask(compound).label, /minecraft:diamond/);
});

test('12. 【防回归】不写游戏不认的假字段：没有 all_table 类型、没有 permission_level', () => {
  // 这两个都是我们自己发明的字段，FTB-Quests-2001.4.9 源码全树 grep 各 0 命中，
  // 两个真实整合包（Mechanomania / ATM10Sky）里也各 0 命中。
  // 写成它们游戏不认识：all_table 退化成 CustomReward（奖励什么都不给），
  // permission_level 游戏根本不读（用户填了没效果也不报错）。

  // ① all_table 这个奖励类型不存在
  assert.equal(rewardDef('all_table'), null, 'all_table 是假类型，不许再出现在类型目录里');
  assert.ok(!REWARD_TYPES.some((t) => t.type === 'all_table'), 'REWARD_TYPES 里不许有 all_table');
  throwsCode(() => entryFromSpec({ type: 'all_table', tableId: '0DA6727500F2701E' }, 'reward'),
    'QuestUnsupportedCondition');

  // 战利品表奖励只剩 game 里真有的三种
  const tableTypes = REWARD_TYPES.filter((t) => ['choice', 'random', 'loot'].includes(t.type)).map((t) => t.type);
  assert.deepEqual(tableTypes, ['choice', 'random', 'loot']);

  // 三种战利品表奖励的「一键领取全部时跳过」默认值不一样，照抄游戏别统一：
  // choice / loot 是 true，random 是 false（不写这个键）
  assert.deepEqual(buildReward({ type: 'choice', tableId: '0DA6727500F2701E' }).exclude_from_claim_all, true);
  assert.deepEqual(buildReward({ type: 'loot', tableId: '0DA6727500F2701E' }).exclude_from_claim_all, true);
  assert.ok(!('exclude_from_claim_all' in buildReward({ type: 'random', tableId: '0DA6727500F2701E' })),
    'random 的 exclude_from_claim_all 默认是 false —— 写 false 进文件是多余的，干脆不写这个键');

  // ② permission_level 这个字段不存在，只有 elevate_perms 布尔
  const plain = buildReward({ type: 'command', command: '/say hi' });
  assert.deepEqual(plain, { type: 'command', command: '/say hi' }, '不提权就只写 command');
  assert.ok(!('permission_level' in plain), '绝不写 permission_level');
  assert.ok(!('permissionLevel' in plain), '也不许用驼峰的 permissionLevel 当字段名');

  const elevated = buildReward({ type: 'command', command: '/say hi', elevatePerms: true });
  assert.deepEqual(elevated, { type: 'command', command: '/say hi', elevate_perms: true },
    '提权写布尔 elevate_perms（游戏源码就是这个名，权限等级游戏写死 2）');
  assert.equal(typeof elevated.elevate_perms, 'boolean', 'elevate_perms 必须是布尔，不是数字等级');

  // 读回来也是这个布尔，不是等级数字
  const spec = specFromReward({ type: 'command', command: '/say hi', elevate_perms: true });
  assert.equal(spec.elevatePerms, true);
  assert.equal(spec.permissionLevel, undefined, '读回来的 spec 里不许有 permissionLevel');

  // ③ 旧文件里万一带了 permission_level 这种脏字段，改类型时不该把它带出去
  const rebuilt = buildEntry('reward', { type: 'command', command: '/say bye', elevatePerms: true },
    { id: 'X1', type: 'command', command: '/say hi', permission_level: 4 }, () => 'GEN');
  assert.ok(!('permission_level' in rebuilt), '改造旧条目时要把 permission_level 清掉');
  assert.equal(rebuilt.elevate_perms, true);
  assert.equal(rebuilt.id, 'X1', 'id 必须沿用，换了 id 玩家进度就没了');
});
