/**
 * searchItems 的单测 —— 纯排序/筛选逻辑，不需要真实例。
 *
 * 这里锁的是「用户能不能一眼看到他想找的那个 ID」：搜 diamond 必须
 * `minecraft:diamond` 排第一，而不是被 `minecraft:diamond_sword` 之类挤下去。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { searchItems, rankAll, describeQuery } from '../packages/core/item-search.js';

const entries = [
  { id: 'minecraft:diamond_sword', from: ['minecraft'] },
  { id: 'minecraft:diamond', from: ['minecraft'] },
  { id: 'minecraft:diamond_block', from: ['minecraft'] },
  { id: 'create:cogwheel', from: ['create'] },
  { id: 'create:large_cogwheel', from: ['create'] },
  { id: 'biomesoplenty:fir_planks', from: ['biomesoplenty'] },
];

test('精确命中排第一（diamond 不能被 diamond_sword 挤下去）', () => {
  const r = searchItems(entries, { query: 'diamond' });
  assert.equal(r.items[0].id, 'minecraft:diamond');
});

test('同分时短 ID 优先（diamond_sword 与 diamond_block 谁短谁在前）', () => {
  const r = searchItems(entries, { query: 'diamond' });
  const rest = r.items.slice(1).map((i) => i.id);
  // diamond_sword(22) < diamond_block(22)？两者等长，按字典序 block 在前
  assert.deepEqual(rest, ['minecraft:diamond_block', 'minecraft:diamond_sword']);
});

test('大小写不敏感', () => {
  const r = searchItems(entries, { query: 'COGWHEEL' });
  assert.deepEqual(r.items.map((i) => i.id), ['create:cogwheel', 'create:large_cogwheel']);
});

test('namespace 过滤', () => {
  const r = searchItems(entries, { namespace: 'create' });
  assert.deepEqual(r.items.map((i) => i.id), ['create:cogwheel', 'create:large_cogwheel']);
  assert.equal(r.total, 2);
});

test('modId 过滤（只看某个 mod 贡献的 ID）', () => {
  const r = searchItems(entries, { modId: 'biomesoplenty' });
  assert.deepEqual(r.items.map((i) => i.id), ['biomesoplenty:fir_planks']);
});

test('limit 截断，但 total 仍是全量匹配数', () => {
  const r = searchItems(entries, { query: 'diamond', limit: 1 });
  assert.equal(r.shown, 1);
  assert.equal(r.total, 3);
  assert.equal(r.items.length, 1);
});

test('无 query 时按 ID 长度排序，不炸', () => {
  const r = searchItems(entries, { namespace: 'minecraft' });
  assert.equal(r.total, 3);
  assert.ok(r.items.every((i) => i.id.startsWith('minecraft:')));
});

test('from 缺失或非数组时不炸', () => {
  const r = searchItems([{ id: 'x:y' }, { id: 'x:z', from: null }], { namespace: 'x' });
  assert.equal(r.total, 2);
  assert.deepEqual(r.items.map((i) => i.from), [[], []]);
});

// ---- 按中文名搜（给不熟英文 ID 的人用）----

const names = new Map([
  ['create:cogwheel', '齿轮'],
  ['create:large_cogwheel', '大齿轮'],
  ['minecraft:diamond', '钻石'],
  ['minecraft:diamond_sword', '钻石剑'],
]);

test('能按中文名搜到物品', () => {
  const r = searchItems(entries, { query: '齿轮', names });
  assert.deepEqual(r.items.map((i) => i.id), ['create:cogwheel', 'create:large_cogwheel']);
});

test('中文名精确命中优先于包含命中', () => {
  const r = searchItems(entries, { query: '齿轮', names });
  // 「齿轮」是精确名，rank 4；「大齿轮」是包含，rank 6
  assert.equal(r.items[0].id, 'create:cogwheel');
});

test('ID 命中排在中文名命中之前', () => {
  // 搜 "diamond" 时 ID 全中（rank ≤3），中文名一个都不含 diamond，顺序不变
  const r = searchItems(entries, { query: 'diamond', names });
  assert.equal(r.items[0].id, 'minecraft:diamond');
});

test('结果里带中文名', () => {
  const r = searchItems(entries, { query: 'diamond', names });
  assert.equal(r.items[0].name, '钻石');
});

test('没给名字表时 name 是空串，不影响搜索', () => {
  const r = searchItems(entries, { query: 'diamond' });
  assert.equal(r.items[0].name, '');
});

test('中文搜不到就是搜不到，不会误报', () => {
  const r = searchItems(entries, { query: '安山合金', names });
  assert.equal(r.total, 0);
});

// ---- 拼音（2026-11-05：整合包里的物品绝大多数只有中文名，切输入法太麻烦）----

test('拼错的拼音不会乱命中', () => {
  const r = searchItems(entries, { query: 'zhuanshi', names });
  assert.equal(r.total, 0, 'zhuan 拼不成「钻」，不该命中');
});

test('全拼 zuanshi 命中「钻石」和「钻石剑」', () => {
  const r = searchItems(entries, { query: 'zuanshi', names });
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['minecraft:diamond', 'minecraft:diamond_sword']);
});

test('首字母 zsj 也能搜到「钻石剑」（多音字/首字母缩写）', () => {
  const r = searchItems(entries, { query: 'zsj', names });
  assert.ok(r.items.some((i) => i.id === 'minecraft:diamond_sword'), '首字母缩写没命中');
});

test('拼音命中不会把真正的名字命中挤下去', () => {
  // 搜 chi 时 create:cogwheel 的 ID 里就有 chi（rank 2），
  // 「齿轮」的拼音 ch 开头的匹配要排在后面
  const r = searchItems(entries, { query: 'chilun', names });
  assert.equal(r.items[0].id, 'create:cogwheel');
});

// ---- JEI 那套搜索语法（2026-11-05）----

const modNames = new Map([['create', '机械动力']]);
const tags = new Map([
  ['minecraft:diamond', ['minecraft:diamond_ores']],
  ['minecraft:diamond_block', ['minecraft:diamond_ores', 'minecraft:beacon_payment']],
  ['create:cogwheel', ['create:cogwheels']],
]);
const descriptions = new Map([
  ['create:cogwheel', '最基础的传动零件，耐久一般'],
  ['minecraft:diamond', '闪着光的硬石头'],
]);

test('@mod 只看某个 mod 的东西', () => {
  const r = searchItems(entries, { query: '@create', names });
  assert.deepEqual(r.items.map((i) => i.id), ['create:cogwheel', 'create:large_cogwheel']);
});

test('@mod 能按 mod 显示名（中文）搜', () => {
  const r = searchItems(entries, { query: '@机械动力', names, modNames });
  assert.deepEqual(r.items.map((i) => i.id), ['create:cogwheel', 'create:large_cogwheel']);
});

test('#tag 按标签搜', () => {
  const r = searchItems(entries, { query: '#diamond_ores', names, tags });
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['minecraft:diamond', 'minecraft:diamond_block']);
});

test('#tag 认全名也认路径段', () => {
  const a = searchItems(entries, { query: '#minecraft:diamond_ores', names, tags });
  const b = searchItems(entries, { query: '#diamond_ores', names, tags });
  assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id));
});

test('#tag 命中排在名字命中之前（0 分 vs 6 分）', () => {
  // 「diamond」既是 ID 命中（rank 0~3）也是标签路径段命中（rank 0）
  const r = searchItems(entries, { query: '#diamond', names, tags });
  assert.equal(r.items[0].id, 'minecraft:diamond');
});

test('$tooltip 搜简介', () => {
  const r = searchItems(entries, { query: '$耐久', names, descriptions });
  assert.deepEqual(r.items.map((i) => i.id), ['create:cogwheel']);
});

test('$tooltip 没给简介表时一条都不命中', () => {
  const r = searchItems(entries, { query: '$耐久', names });
  assert.equal(r.total, 0);
});

test('两个词是「与」（都得命中）', () => {
  const r = searchItems(entries, { query: '@create cogwheel', names });
  assert.deepEqual(r.items.map((i) => i.id), ['create:cogwheel', 'create:large_cogwheel']);
});

test('| 是「或」', () => {
  const r = searchItems(entries, { query: 'fir|cogwheel', names });
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['biomesoplenty:fir_planks', 'create:cogwheel', 'create:large_cogwheel']);
});

test('-词 排除', () => {
  const r = searchItems(entries, { query: 'diamond -sword', names });
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['minecraft:diamond', 'minecraft:diamond_block']);
});

test('引号里带空格算一个整词', () => {
  const two = [
    { id: 'a:iron_ingot', from: ['a'] },
    { id: 'a:iron_nugget', from: ['a'] },
  ];
  const n = new Map([['a:iron_ingot', 'Iron Ingot'], ['a:iron_nugget', 'Iron Nugget']]);
  const r = searchItems(two, { query: '"iron ingot"', names: n });
  assert.deepEqual(r.items.map((i) => i.id), ['a:iron_ingot']);
});

test('带空格的英文名现在能搜到了（老 bug：整个串当子串比）', () => {
  const two = [{ id: 'minecraft:iron_ingot', from: ['minecraft'] }];
  const n = new Map([['minecraft:iron_ingot', 'Iron Ingot']]);
  // 不加引号、两个词分开，也要命中（JEI 就是这个行为）
  const r = searchItems(two, { query: 'iron ingot', names: n });
  assert.deepEqual(r.items.map((i) => i.id), ['minecraft:iron_ingot']);
});

test('offset 翻页：total 是全量，items 只有这一页', () => {
  const r = searchItems(entries, { query: 'diamond', limit: 1, offset: 1 });
  assert.equal(r.total, 3);
  assert.equal(r.shown, 1);
  assert.equal(r.offset, 1);
  assert.equal(r.items.length, 1);
  assert.notEqual(r.items[0].id, 'minecraft:diamond', 'offset 没生效，还是第一页那条');
});

test('offset 超出范围时 items 是空数组，不炸', () => {
  const r = searchItems(entries, { query: 'diamond', offset: 999 });
  assert.equal(r.total, 3);
  assert.equal(r.items.length, 0);
});

test('describeQuery 把语法翻译成人话', () => {
  assert.equal(describeQuery(''), '全部物品');
  assert.match(describeQuery('@create'), /mod「create」/);
  assert.match(describeQuery('#planks'), /标签「planks」/);
  assert.match(describeQuery('$耐久'), /简介含「耐久」/);
  assert.match(describeQuery('齿轮 -木'), /排除/);
  assert.match(describeQuery('a|b'), /2 组任选其一/);
});

test('rankAll 返回全部命中、不截断（网格要拿它算页数）', () => {
  const all = rankAll(entries, { query: 'diamond' });
  assert.equal(all.length, 3);
});
