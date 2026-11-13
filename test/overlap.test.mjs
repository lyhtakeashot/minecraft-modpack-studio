/**
 * 重叠度 / 进度曲线单测（纯内存）。
 *
 * 这两个功能都是启发式，所以测试盯的不是「结论对不对」，
 * 而是「机制有没有按设计跑」—— 尤其进度曲线的赋层规则，曾经写成
 * `deepest < d` 导致所有物品都卡在第 0 层。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  sameNameCollisions, familyCoverage, progressCurve, describeOverlap, describeProgress,
} from '../packages/core/overlap.js';
import { parseRecipe, buildGraph } from '../packages/core/recipes.js';

/** 造一个假物品表（indexInstance 的 _items 形状）。 */
function itemsOf(ids) {
  const m = new Map();
  for (const id of ids) m.set(id, { id, from: [id.split(':')[0]] });
  return m;
}

const R = (file, json) => parseRecipe(file, json);

test('同名：同路径不同命名空间会被抓到', () => {
  const items = itemsOf(['a:silver_ingot', 'b:silver_ingot', 'c:iron_ingot']);
  const c = sameNameCollisions(items);
  assert.equal(c.length, 1);
  assert.equal(c[0].path, 'silver_ingot');
  assert.deepEqual(c[0].namespaces, ['a', 'b']);
});

test('同名：只有 1 个 mod 时不算', () => {
  assert.equal(sameNameCollisions(itemsOf(['a:iron_ingot', 'a:gold_ingot'])).length, 0);
});

test('同名：minNamespaces=3 会过滤掉只有 2 个的', () => {
  const items = itemsOf(['a:x', 'b:x', 'a:y', 'b:y', 'c:y']);
  assert.equal(sameNameCollisions(items, 2).length, 2);
  assert.equal(sameNameCollisions(items, 3).length, 1);
});

test('功能族：齿轮/存储能被认出来', () => {
  const items = itemsOf([
    'm1:cogwheel', 'm1:gear', 'm1:shaft', 'm1:axle', 'm1:belt',
    'm2:chest', 'm2:barrel', 'm2:drawer', 'm2:crate', 'm2:vault',
  ]);
  const fams = familyCoverage(items, 1);
  const byName = Object.fromEntries(fams.map((f) => [f.family, f]));
  assert.equal(byName['传动/齿轮'].modCount, 1);
  assert.equal(byName['存储'].modCount, 1);
  assert.equal(byName['传动/齿轮'].crowded, false);
});

test('功能族：两个 mod 都做存储 → crowded', () => {
  const items = itemsOf([
    'm1:chest', 'm1:barrel', 'm1:drawer',
    'm2:chest', 'm2:barrel', 'm2:drawer',
  ]);
  const fams = familyCoverage(items, 2);
  const storage = fams.find((f) => f.family === '存储');
  assert.equal(storage.modCount, 2);
  assert.equal(storage.crowded, true);
});

test('功能族：minItems 阈值生效', () => {
  const items = itemsOf(['m1:chest', 'm1:barrel']);
  assert.equal(familyCoverage(items, 5).find((f) => f.family === '存储').modCount, 0);
  assert.equal(familyCoverage(items, 2).find((f) => f.family === '存储').modCount, 1);
});

test('进度：基础资源在第 0 层，产物逐层递增', () => {
  // ore(无配方) → ingot → gear → machine
  const rs = [
    R('data/x/recipe/ingot.json', { type: 'x', ingredients: [{ item: 'minecraft:iron_ore' }], result: { item: 'x:iron_ingot' } }),
    R('data/x/recipe/gear.json', { type: 'x', ingredients: [{ item: 'x:iron_ingot' }], result: { item: 'x:gear' } }),
    R('data/x/recipe/machine.json', { type: 'x', ingredients: [{ item: 'x:gear' }], result: { item: 'x:machine' } }),
  ];
  const g = buildGraph(rs);
  const c = progressCurve(g, { maxDepth: 5 });
  const at = (d) => c.buckets.find((b) => b.depth === d).items;
  assert.equal(at(0), 1, 'iron_ore 没有配方 → 第 0 层');
  assert.equal(at(1), 1, 'ingot 第 1 层');
  assert.equal(at(2), 1, 'gear 第 2 层');
  assert.equal(at(3), 1, 'machine 第 3 层');
});

test('进度：第 0 层必须包含「没有配方的材料」（曾经漏掉导致全员卡住）', () => {
  const rs = [
    R('data/x/recipe/a.json', { type: 'x', ingredients: [{ item: 'minecraft:raw_iron' }], result: { item: 'x:ingot' } }),
  ];
  const g = buildGraph(rs);
  const c = progressCurve(g, { maxDepth: 3 });
  assert.equal(c.buckets[0].items, 1);
  assert.equal(c.buckets[1].items, 1, '有了第 0 层的原矿，产物才能算到第 1 层');
  assert.equal(c.unknownItems, 0);
});

test('进度：标签材料不影响赋层（不要求标签也有深度）', () => {
  const rs = [
    R('data/x/recipe/a.json', {
      type: 'x',
      ingredients: [{ tag: 'minecraft:planks' }, { item: 'minecraft:stick' }],
      result: { item: 'x:thing' },
    }),
  ];
  const g = buildGraph(rs);
  const c = progressCurve(g, { maxDepth: 3 });
  assert.equal(c.buckets[1].items, 1, '标签被排除在材料外，thing 应该算第 1 层');
});

test('进度：maxDepth 限制生效，不无限递归', () => {
  const rs = [];
  for (let i = 0; i < 20; i++) {
    rs.push(R(`data/x/recipe/r${i}.json`, {
      type: 'x',
      ingredients: [{ item: i === 0 ? 'minecraft:base' : `x:i${i - 1}` }],
      result: { item: `x:i${i}` },
    }));
  }
  const g = buildGraph(rs);
  const c = progressCurve(g, { maxDepth: 3 });
  assert.equal(c.buckets.length, 4, '0..3 共 4 层');
  assert.ok(c.unknownItems > 0, '超出深度的物品算未知，不能报错');
});

test('进度：空图不炸', () => {
  const c = progressCurve(buildGraph([]), { maxDepth: 3 });
  assert.equal(c.knownItems, 0);
  assert.equal(c.widestItems, 0);
});

test('describeOverlap / describeProgress 都能出人读文本', () => {
  const items = itemsOf(['a:silver_ingot', 'b:silver_ingot', 'a:chest', 'a:barrel']);
  const o = describeOverlap(sameNameCollisions(items), familyCoverage(items, 1));
  assert.ok(o.join('\n').includes('同名物品'));
  const p = describeProgress(progressCurve(buildGraph([]), { maxDepth: 2 }));
  assert.ok(p.join('\n').includes('按合成深度分层'));
});
