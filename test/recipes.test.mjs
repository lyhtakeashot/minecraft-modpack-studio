/**
 * 配方层单测（纯内存，不碰真实整合包）。
 *
 * 重点覆盖三件容易错的事：
 *   1. 材料/产物的十几种形状能不能都抠出来
 *   2. 配方目录单复数（1.21.1 单数 recipe/、1.20.1 复数 recipes/）
 *   3. 断路判定——「还有别的配方活着就不算断」
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRecipe, buildGraph, findBreaks, pathsTo, usesOf } from '../packages/core/recipes.js';

const R = (file, json) => parseRecipe(file, json);

test('配方：普通有序合成，材料在 key 里', () => {
  const r = R('data/minecraft/recipes/cogwheel.json', {
    type: 'minecraft:crafting_shaped',
    pattern: ['AA', 'AA'],
    key: { A: { item: 'minecraft:stone' } },
    result: { item: 'minecraft:cobblestone', count: 3 },
  });
  assert.equal(r.id, 'minecraft:cogwheel');
  assert.equal(r.namespace, 'minecraft');
  assert.equal(r.type, 'minecraft:crafting_shaped');
  assert.deepEqual(r.outputs, ['minecraft:cobblestone']);
  assert.deepEqual(r.inputs, ['minecraft:stone']);
});

test('配方：单数 recipe/ 与复数 recipes/ 都要认', () => {
  const a = R('data/create/recipe/pressing/zinc.json', { type: 'create:pressing' });
  const b = R('data/create/recipes/pressing/zinc.json', { type: 'create:pressing' });
  assert.ok(a, '1.21.1 的单数 recipe/ 必须能解析（否则源 C 静默失效）');
  assert.ok(b, '1.20.1 的复数 recipes/ 必须能解析');
  assert.equal(a.id, 'create:pressing/zinc');
});

test('配方：不是配方的路径返回 null', () => {
  assert.equal(R('data/create/loot_tables/blocks/x.json', {}), null);
  assert.equal(R('assets/create/lang/en_us.json', {}), null);
});

test('配方：材料是标签时单独记，不当物品', () => {
  const r = R('data/x/recipe/t.json', {
    type: 'minecraft:crafting_shapeless',
    ingredients: [{ tag: 'minecraft:planks' }, { item: 'minecraft:stick' }],
    result: { item: 'minecraft:torch' },
  });
  assert.deepEqual(r.inputs, ['minecraft:stick']);
  assert.deepEqual(r.tags, ['minecraft:planks']);
});

test('配方：材料是字符串数组', () => {
  const r = R('data/x/recipe/a.json', {
    type: 'minecraft:crafting_shapeless',
    ingredients: ['minecraft:coal', 'minecraft:stick'],
    result: 'minecraft:torch',
  });
  assert.deepEqual(r.inputs, ['minecraft:coal', 'minecraft:stick']);
  assert.deepEqual(r.outputs, ['minecraft:torch']);
});

test('配方：results 数组 + count', () => {
  const r = R('data/x/recipe/b.json', {
    type: 'create:mixing',
    ingredients: [{ item: 'minecraft:iron_ingot' }],
    results: [{ item: 'create:iron_sheet', count: 2 }],
  });
  assert.deepEqual(r.outputs, ['create:iron_sheet']);
});

test('配方：垃圾字符串不当成物品 ID', () => {
  const r = R('data/x/recipe/c.json', {
    type: 'minecraft:crafting_shapeless',
    ingredients: [{ item: 'canUse:unknown' }],
    result: { item: 'minecraft:stick' },
  });
  assert.deepEqual(r.inputs, []);
});

test('配方：outputs/inputs 去重', () => {
  const r = R('data/x/recipe/d.json', {
    type: 'x',
    ingredients: [{ item: 'minecraft:coal' }, { item: 'minecraft:coal' }],
    result: { item: 'minecraft:coal_block' },
  });
  assert.equal(r.inputs.length, 1);
});

test('图：producers / consumers 双向都能查', () => {
  const rs = [
    R('data/minecraft/recipes/plank.json', { type: 'x', ingredients: [{ item: 'minecraft:log' }], result: { item: 'minecraft:planks' } }),
    R('data/minecraft/recipes/stick.json', { type: 'x', ingredients: [{ item: 'minecraft:planks' }], result: { item: 'minecraft:stick' } }),
  ];
  const g = buildGraph(rs);
  assert.equal(g.producersOf('minecraft:planks').length, 1);
  assert.equal(g.consumersOf('minecraft:planks').length, 1);
  assert.equal(g.producersOf('minecraft:nothing').length, 0);
});

test('断路：有替代配方就不算断', () => {
  const rs = [
    R('data/x/recipe/a.json', { type: 'x', ingredients: [{ item: 'minecraft:log' }], result: { item: 'minecraft:planks' } }),
    R('data/x/recipe/b.json', { type: 'x', ingredients: [{ item: 'minecraft:bamboo' }], result: { item: 'minecraft:planks' } }),
  ];
  const g = buildGraph(rs);
  const r = findBreaks(g, ['x:a']);
  assert.equal(r.broken.length, 0, '还有 x:b 能产出，不该报断');
});

test('断路：删掉唯一的配方就断', () => {
  const rs = [
    R('data/x/recipe/a.json', { type: 'x', ingredients: [], result: { item: 'minecraft:bedrock' } }),
  ];
  const g = buildGraph(rs);
  const r = findBreaks(g, ['x:a']);
  assert.equal(r.broken.length, 1);
  assert.equal(r.broken[0].item, 'minecraft:bedrock');
});

test('断路：limit 生效', () => {
  const rs = [];
  for (let i = 0; i < 20; i++) {
    rs.push(R(`data/x/recipe/r${i}.json`, { type: 'x', ingredients: [], result: { item: `x:item${i}` } }));
  }
  const g = buildGraph(rs);
  const r = findBreaks(g, rs.map((x) => x.id), { limit: 5 });
  assert.equal(r.broken.length, 5);
});

test('路径：能追到第二层的材料', () => {
  const rs = [
    R('data/x/recipe/a.json', { type: 'x', ingredients: [{ item: 'minecraft:log' }], result: { item: 'minecraft:planks' } }),
    R('data/x/recipe/b.json', { type: 'x', ingredients: [{ item: 'minecraft:tree' }], result: { item: 'minecraft:log' } }),
  ];
  const g = buildGraph(rs);
  const p = pathsTo(g, 'minecraft:planks', { depth: 2 });
  assert.equal(p.levels.length, 2);
  assert.equal(p.levels[0][0].recipe, 'x:a');
  assert.equal(p.levels[1][0].recipe, 'x:b');
});

test('路径：没配方时返回空 levels', () => {
  const g = buildGraph([]);
  const p = pathsTo(g, 'minecraft:air', { depth: 3 });
  assert.equal(p.levels.length, 0);
});

test('路径：节点上限会截断而不是卡死', () => {
  const rs = [];
  for (let i = 0; i < 50; i++) {
    rs.push(R(`data/x/recipe/r${i}.json`, { type: 'x', ingredients: [{ item: `x:in${i}` }], result: { item: 'x:common' } }));
  }
  const g = buildGraph(rs);
  const p = pathsTo(g, 'x:common', { depth: 2, maxNodes: 5 });
  assert.equal(p.truncated, true);
});

test('用途：返回用到它的配方清单', () => {
  const rs = [
    R('data/x/recipe/a.json', { type: 'minecraft:crafting_shaped', ingredients: [{ item: 'minecraft:stick' }], result: { item: 'minecraft:torch' } }),
    R('data/x/recipe/b.json', { type: 'minecraft:smelting', ingredients: [{ item: 'minecraft:stick' }], result: { item: 'minecraft:charcoal' } }),
  ];
  const g = buildGraph(rs);
  const u = usesOf(g, 'minecraft:stick');
  assert.equal(u.count, 2);
  assert.equal(usesOf(g, 'minecraft:air').count, 0);
});
