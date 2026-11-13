/**
 * 任务条件标题拼装的单测（2026-11-12 第五批 B）。
 *
 * 规则全部来自 FTB 源码各 `getAltTitle()` 的实现，每条都钉住「和游戏一致」这一点：
 * 前缀是什么、颜色是哪个、什么情况下不加前缀。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  taskTypeTitle, isLiteralType, DARK_GREEN, YELLOW,
} from '../packages/core/quest-type-title.js';

test('1. 维度 / 群系 / 结构 / 观察：原始 ID 在前、括号补中文名、深绿', () => {
  // 源码 Component.literal(原始 ID).withStyle(DARK_GREEN) —— FTB 一个字都不翻译。
  // 用户 2026-11-12 拍板：原始 ID +（括号补中文名）。
  const dim = taskTypeTitle('dimension', { what: 'minecraft:the_nether', name: '下界' });
  assert.equal(dim.text, '访问维度: minecraft:the_nether（下界）');
  assert.equal(dim.color, DARK_GREEN);
  // 分段：前缀白、变量绿（和游戏 append(...withStyle(DARK_GREEN)) 一致）
  assert.deepEqual(dim.parts, [
    { text: '访问维度: ', color: '' },
    { text: 'minecraft:the_nether（下界）', color: DARK_GREEN },
  ]);

  // 查不到中文名时不加空括号
  const noName = taskTypeTitle('dimension', { what: 'minecraft:the_end' });
  assert.equal(noName.text, '访问维度: minecraft:the_end', '查不到中文名就别加括号');

  // 中文名和 ID 恰好一样时也不重复
  const same = taskTypeTitle('biome', { what: 'minecraft:plains', name: 'minecraft:plains' });
  assert.equal(same.text, '生物群系: minecraft:plains');

  // 四种都是「literal 型」
  for (const t of ['dimension', 'biome', 'structure', 'observation']) {
    assert.equal(isLiteralType(t), true, `${t} 该是 literal 型`);
    assert.equal(taskTypeTitle(t, { what: 'ns:x', name: '中文' }).color, DARK_GREEN);
  }
  assert.equal(isLiteralType('item'), false);
});

test('2. 物品：只有 count > 1 时的 `Nx ` 前缀，没有类型名', () => {
  // 源码 ItemTask.java:167：`count > 1 ? count + "x " + 物品名 : 物品名`。
  assert.equal(taskTypeTitle('item', { what: 'minecraft:gold_ingot', name: '金锭', count: 3 }).text,
    '3x 金锭');
  assert.equal(taskTypeTitle('item', { what: 'minecraft:gold_ingot', name: '金锭', count: 1 }).text,
    '金锭', 'count=1 不要 `1x ` 前缀（游戏也没有）');
  assert.equal(taskTypeTitle('item', { what: 'minecraft:gold_ingot', name: '金锭' }).text,
    '金锭', '不给 count 时按 1');
  // 查不到中文名就用 ID
  assert.equal(taskTypeTitle('item', { what: 'demo:thing', count: 2 }).text, '2x demo:thing');
  // 物品没有分段颜色
  assert.deepEqual(taskTypeTitle('item', { what: 'x:y', name: 'Y', count: 2 }).parts, []);
});

test('3. 击杀：`杀死实体: Nx 生物名`（模板 Kill: %sx %s）', () => {
  // 源码 KillTask.java:94：translatable("ftbquests.task.ftbquests.kill.title", 数量, 生物名)
  assert.equal(taskTypeTitle('kill', { what: 'minecraft:zombie', name: '僵尸', count: 3 }).text,
    '杀死实体: 3x 僵尸');
  assert.equal(taskTypeTitle('kill', { what: 'minecraft:zombie', name: '僵尸' }).text,
    '杀死实体: 1x 僵尸');
  // 查不到中文名就用实体 ID
  assert.equal(taskTypeTitle('kill', { what: 'a:b', count: 5 }).text, '杀死实体: 5x a:b');
  // 没填生物
  assert.equal(taskTypeTitle('kill', {}).text, '（没填生物）');
});

test('4. 进度：黄色（AdvancementTask.java:87），拿不到真名时退回类型名', () => {
  const adv = taskTypeTitle('advancement', { what: 'minecraft:story/root', name: 'Minecraft' });
  assert.equal(adv.text, '进度: Minecraft');
  assert.equal(adv.color, YELLOW, '进度是黄色');
  assert.deepEqual(adv.parts, [
    { text: '进度: ', color: '' },
    { text: 'Minecraft', color: YELLOW },
  ]);
  // 没有名字也没有 ID → 只显示类型名（游戏里 getAltTitle 退回 super 的行为）
  assert.equal(taskTypeTitle('advancement', {}).text, '进度');
});

test('5. 游戏阶段：黄色、显示原始 stage 字符串', () => {
  const gs = taskTypeTitle('gamestage', { what: 'examplemod:stage_1' });
  assert.equal(gs.text, '游戏阶段: examplemod:stage_1');
  assert.equal(gs.color, YELLOW);
  assert.equal(taskTypeTitle('gamestage', {}).text, '游戏阶段: （没填阶段）');
});

test('6. 英文前缀（locale=en）只换前缀，不换变量', () => {
  // 前缀是 jar 里 en_us.json 的真值（Visit Dimension / Kil.. 等），
  // 变量部分（维度 ID / 生物名）游戏里也不翻译，所以两种语言都一样。
  assert.equal(taskTypeTitle('dimension', { what: 'minecraft:the_nether', locale: 'en' }).text,
    'Visit Dimension: minecraft:the_nether');
  assert.equal(taskTypeTitle('advancement', { what: 'x:y', locale: 'en' }).text, 'Advancement: x:y');
});

test('7. 其它类型（checkmark / xp / stat）没有「变量:」结构时不硬拼冒号', () => {
  // checkmark 本来就没有「要什么」，只该是类型名
  assert.equal(taskTypeTitle('checkmark', {}).text, 'checkmark');
  // xp 有值就当名字用
  assert.match(taskTypeTitle('xp', { what: '5', name: '5' }).text, /5/);
});

test('8. 空输入不炸、不产生半个句子', () => {
  assert.equal(taskTypeTitle('', {}).type === undefined, true);
  assert.equal(typeof taskTypeTitle(undefined).text, 'string');
  assert.equal(typeof taskTypeTitle('dimension', { what: '' }).text, 'string');
  assert.equal(taskTypeTitle('dimension', { what: '' }).text, '（没填）');
  assert.equal(taskTypeTitle('item', { what: '' }).text, '（没填物品）');
});
