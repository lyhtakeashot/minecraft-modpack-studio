/**
 * 物品标签索引的单测 —— 纯收集 + 递归展开，不碰磁盘。
 *
 * 这里锁的是三件真实数据包里一定会出的事：
 * 1. 1.21 用 `tags/item/`、1.20 用 `tags/items/`，少认一种那个版本就静默没有标签；
 * 2. 标签可以引用标签（`#minecraft:wooden_slabs`），不展开「木板」就是空的；
 * 3. 标签可以互相引用成环（真实包里出现过），不挡会死循环把界面卡死。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTagDefs, resolveTags, tagPath } from '../packages/core/tag-index.js';

/** 造一个假 zip：只实现 collectTagDefs 用到的那两样（names / text）。 */
function fakeZip(files) {
  return {
    names: Object.keys(files),
    text: (n) => files[n],
  };
}

test('1.21 的 tags/item/ 能收到', () => {
  const defs = new Map();
  const r = collectTagDefs(fakeZip({
    'data/minecraft/tags/item/planks.json': JSON.stringify({ values: ['minecraft:oak_planks'] }),
  }), defs);
  assert.equal(r.files, 1);
  assert.deepEqual([...defs.keys()], ['minecraft:planks']);
  assert.deepEqual(defs.get('minecraft:planks'), ['minecraft:oak_planks']);
});

test('1.20 的 tags/items/ 也能收到（少认一种那个版本就全空）', () => {
  const defs = new Map();
  collectTagDefs(fakeZip({
    'data/minecraft/tags/items/planks.json': JSON.stringify({ values: ['minecraft:spruce_planks'] }),
  }), defs);
  assert.deepEqual(defs.get('minecraft:planks'), ['minecraft:spruce_planks']);
});

test('方块标签加 block: 前缀，不和同名物品标签串味', () => {
  const defs = new Map();
  collectTagDefs(fakeZip({
    'data/minecraft/tags/item/logs.json': JSON.stringify({ values: ['minecraft:oak_log'] }),
    'data/minecraft/tags/block/logs.json': JSON.stringify({ values: ['minecraft:oak_log'] }),
  }), defs);
  assert.ok(defs.has('minecraft:logs'), '物品标签没收到');
  assert.ok(defs.has('block:minecraft:logs'), '方块标签没收到');
  assert.deepEqual(defs.get('minecraft:logs'), ['minecraft:oak_log']);
});

test('values 里没写命名空间的默认补 minecraft:', () => {
  const defs = new Map();
  collectTagDefs(fakeZip({
    'data/minecraft/tags/item/planks.json': JSON.stringify({ values: ['oak_planks'] }),
  }), defs);
  assert.deepEqual(defs.get('minecraft:planks'), ['minecraft:oak_planks']);
});

test('1.20 之前那种 { id, required } 写法也认', () => {
  const defs = new Map();
  collectTagDefs(fakeZip({
    'data/minecraft/tags/items/planks.json': JSON.stringify({
      values: [{ id: 'minecraft:oak_planks', required: false }],
    }),
  }), defs);
  assert.deepEqual(defs.get('minecraft:planks'), ['minecraft:oak_planks']);
});

test('单个标签文件坏了不毁整个索引', () => {
  const defs = new Map();
  const r = collectTagDefs(fakeZip({
    'data/minecraft/tags/item/broken.json': '{ 这不是 json',
    'data/minecraft/tags/item/planks.json': JSON.stringify({ values: ['minecraft:oak_planks'] }),
  }), defs);
  assert.equal(r.files, 1, '坏文件被算进有效文件了');
  assert.ok(defs.has('minecraft:planks'));
});

test('多个 jar 里同名标签会合并（mod 往原版标签里加东西）', () => {
  const defs = new Map();
  collectTagDefs(fakeZip({
    'data/minecraft/tags/item/planks.json': JSON.stringify({ values: ['minecraft:oak_planks'] }),
  }), defs);
  collectTagDefs(fakeZip({
    'data/minecraft/tags/item/planks.json': JSON.stringify({ values: ['biomesoplenty:fir_planks'] }),
  }), defs);
  assert.deepEqual(defs.get('minecraft:planks'), ['minecraft:oak_planks', 'biomesoplenty:fir_planks']);
});

test('嵌套标签会递归展开（不展开「木板」下面一个都没有）', () => {
  const defs = new Map([
    ['minecraft:planks', ['#minecraft:wooden_planks']],
    ['minecraft:wooden_planks', ['minecraft:oak_planks', 'minecraft:birch_planks']],
  ]);
  const r = resolveTags(defs);
  assert.deepEqual([...r.tagItems.get('minecraft:planks')].sort(), ['minecraft:birch_planks', 'minecraft:oak_planks']);
});

test('标签互相引用成环不会死循环', () => {
  const defs = new Map([
    ['a:one', ['#a:two', 'minecraft:oak_planks']],
    ['a:two', ['#a:one', 'minecraft:birch_planks']],
  ]);
  const r = resolveTags(defs);
  // 两个标签都能解析出来，不抛异常不挂住
  assert.ok(r.tagItems.has('a:one'));
  assert.ok(r.tagItems.has('a:two'));
});

test('引用了不存在的标签当空集合，不报错', () => {
  const defs = new Map([
    ['a:one', ['#a:missing', 'minecraft:oak_planks']],
  ]);
  const r = resolveTags(defs);
  assert.deepEqual([...r.tagItems.get('a:one')], ['minecraft:oak_planks']);
});

test('给了物品表就只留表里有的（mod 引用了没装的物品）', () => {
  const defs = new Map([
    ['a:one', ['minecraft:oak_planks', 'ghostmod:not_installed']],
  ]);
  const r = resolveTags(defs, new Set(['minecraft:oak_planks']));
  assert.deepEqual([...r.tagItems.get('a:one')], ['minecraft:oak_planks']);
});

test('反向表「物品 → 标签」能建出来，方块标签不混进去', () => {
  const defs = new Map([
    ['minecraft:planks', ['minecraft:oak_planks']],
    ['block:minecraft:logs', ['minecraft:oak_log']],
  ]);
  const r = resolveTags(defs);
  assert.deepEqual([...r.itemTags.get('minecraft:oak_planks')], ['minecraft:planks']);
  assert.equal(r.itemTags.get('minecraft:oak_log'), undefined, '方块标签混进物品反向表了');
});

test('一个物品属于多个标签时全记下来', () => {
  const defs = new Map([
    ['minecraft:planks', ['minecraft:oak_planks']],
    ['minecraft:wooden', ['minecraft:oak_planks']],
  ]);
  const r = resolveTags(defs);
  assert.deepEqual([...r.itemTags.get('minecraft:oak_planks')].sort(), ['minecraft:planks', 'minecraft:wooden']);
});

test('空定义不炸，计数是 0', () => {
  const r = resolveTags(new Map());
  assert.equal(r.tagCount, 0);
  assert.equal(r.itemCount, 0);
  assert.equal(r.tagItems.size, 0);
});

test('tagPath 取路径段（搜索时优先匹配它）', () => {
  assert.equal(tagPath('minecraft:wooden_slabs'), 'wooden_slabs');
  // 方块标签带 block: 前缀时只切第一个冒号 —— 反正方块标签不参与物品搜索
  assert.equal(tagPath('block:minecraft:logs'), 'minecraft:logs');
  assert.equal(tagPath('nocolon'), 'nocolon');
  assert.equal(tagPath(''), '');
});
