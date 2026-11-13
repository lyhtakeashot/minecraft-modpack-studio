/**
 * 合成表布局（`packages/core/recipe-layout.js`）和渲染（`packages/ui/recipe-view.js`）的单测。
 *
 * 布局那半边是纯函数，手造 desc / JSON 就能测，不用造整合包；
 * 渲染那半边沿用 `test/ui-app.test.mjs` 那套手写 DOM 替身 ——
 * 这个沙箱起不了真浏览器，而这层最容易犯的错恰恰是「引用了不存在的函数」，
 * 只有真跑一遍才暴露。
 *
 * 用例重点盯三件用户明确要的事：九宫格要对、机械动力的大格子（3x5 / 5x5）不能被压成 9 格、
 * 机器配方要画成流程图而不是九宫格。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ZipWriter } from '../packages/core/zipwrite.js';
import { resetCaches } from '../lib/host/cache.js';
import { layoutRecipe, materialOf } from '../packages/core/recipe-layout.js';
import { handleRecipeView, packRawJson } from '../lib/host/recipe-view-api.js';
import { recipeView } from '../packages/ui/recipe-view.js';

// ------------------------------------------------------------------ DOM 替身

/** 和 test/ui-app.test.mjs 同款的最小节点实现（只留这条用例用得上的部分）。 */
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.attrs = {};
    this._text = '';
    this.style = '';
    this.value = '';
    this.className = '';
    this.dataset = {};
  }

  append(...kids) {
    for (const kid of kids) this.children.push(kid);
  }

  replaceChildren(...kids) {
    this.children = [...kids];
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener() {}

  setAttribute(key, value) {
    this.attrs[key] = String(value);
  }

  getAttribute(key) {
    return this.attrs[key];
  }

  removeAttribute(key) {
    delete this.attrs[key];
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
}

globalThis.Node = FakeNode;
globalThis.HTMLElement = FakeNode;

globalThis.document = {
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (ns, tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const node = new FakeNode('#text');
    node._text = String(text);
    return node;
  },
  addEventListener() {},
  removeEventListener() {},
};

/** 递归收集文字。 */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!(node instanceof FakeNode)) return '';
  return `${node._text}${node.children.map(textOf).join('')}`;
}

/** 深度遍历找所有满足条件的节点。 */
function findAll(root, hit, out = []) {
  if (!(root instanceof FakeNode)) return out;
  if (hit(root)) out.push(root);
  for (const kid of root.children) findAll(kid, hit, out);
  return out;
}

/** 按 class 找节点（className 里含这个词就算）。 */
function byClass(root, cls) {
  return findAll(root, (node) => String(node.className).split(/\s+/).includes(cls));
}

/** 按 class 找第一个。 */
function firstClass(root, cls) {
  return byClass(root, cls)[0] ?? null;
}

// ------------------------------------------------------------------ 造测试数据

/** 一个能改的有序合成 desc（真跑起来是 describeRecipe 的返回，这里只留用得上的字段）。 */
function shapedDesc(over = {}) {
  return {
    id: 'test:cogwheel',
    type: 'minecraft:crafting_shaped',
    kind: 'shaped',
    machineKind: '',
    output: 'test:cogwheel',
    count: 2,
    pattern: ['AA', 'AA'],
    keys: { A: 'minecraft:iron_ingot' },
    inputs: ['minecraft:iron_ingot'],
    tags: [],
    editable: true,
    reason: '',
    ...over,
  };
}

/** 一个 Create 机器配方的 desc。 */
function machineDesc(machineKind, over = {}) {
  return {
    id: `test:${machineKind}`,
    type: `create:${machineKind}`,
    kind: 'machine',
    machineKind,
    output: 'test:plate',
    count: 1,
    pattern: [],
    keys: {},
    inputs: ['test:ingot'],
    tags: [],
    editable: true,
    reason: '',
    ...over,
  };
}

// ------------------------------------------------------------------ ① 有序合成

test('有序合成：4 格 2x2 的铁锭配方，行列和格子位置都对', () => {
  const desc = shapedDesc();
  const json = {
    type: 'minecraft:crafting_shaped',
    pattern: ['AA', 'AA'],
    key: { A: { item: 'minecraft:iron_ingot' } },
    result: { item: 'test:cogwheel', count: 2 },
  };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.kind, 'shaped');
  assert.equal(layout.grid.rows, 2);
  assert.equal(layout.grid.cols, 2);
  assert.equal(layout.gridSize, '2x2');
  assert.equal(layout.grid.cells.length, 4);
  // 四格都在，坐标是 (0,0)(0,1)(1,0)(1,1)
  assert.deepEqual(
    layout.grid.cells.map((c) => `${c.row},${c.col}`),
    ['0,0', '0,1', '1,0', '1,1'],
  );
  for (const cell of layout.grid.cells) {
    assert.equal(cell.kind, 'item');
    assert.equal(cell.id, 'minecraft:iron_ingot');
    assert.equal(cell.count, 1);
  }
  assert.deepEqual(layout.output, { id: 'test:cogwheel', count: 2, name: '' });
  assert.equal(layout.produceTotal, 2);
  assert.deepEqual(layout.blockers, []);
  assert.equal(layout.editable, true);
  // 图案和字符映射原样保留（keys 拍平成「字符 → 物品 ID」，和 describeRecipe 同一种形状）
  assert.deepEqual(layout.pattern, ['AA', 'AA']);
  assert.deepEqual(layout.keys, { A: 'minecraft:iron_ingot' });
});

test('有序合成：空格子不进 cells（3x3 里的十字形，只画 5 格）', () => {
  const desc = shapedDesc({
    id: 'test:cross',
    output: 'test:cross',
    count: 1,
    pattern: [' A ', 'AAA', ' A '],
    keys: { A: 'minecraft:gold_ingot' },
    inputs: ['minecraft:gold_ingot'],
  });
  const json = {
    type: 'minecraft:crafting_shaped',
    pattern: [' A ', 'AAA', ' A '],
    key: { A: { item: 'minecraft:gold_ingot' } },
    result: { item: 'test:cross' },
  };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.grid.rows, 3);
  assert.equal(layout.grid.cols, 3);
  assert.equal(layout.gridSize, '3x3');
  // 3x3 画面上有 9 个位置，但只有 5 个有材料 —— 空格子不该出现在 cells 里
  assert.equal(layout.grid.cells.length, 5);
  assert.deepEqual(
    layout.grid.cells.map((c) => `${c.row},${c.col}`),
    ['0,1', '1,0', '1,1', '1,2', '2,1'],
  );
  // 空格子（0,0 / 0,2 等）一个都不许出现
  const keys = new Set(layout.grid.cells.map((c) => `${c.row},${c.col}`));
  assert.equal(keys.has('0,0'), false);
  assert.equal(keys.has('2,2'), false);
});

test('有序合成：1x1 的单格配方画成 1x1，不是九宫格', () => {
  const desc = shapedDesc({
    id: 'test:block',
    output: 'test:block',
    count: 1,
    pattern: ['A'],
    keys: { A: 'minecraft:iron_block' },
    inputs: ['minecraft:iron_block'],
  });
  const json = {
    type: 'minecraft:crafting_shaped',
    pattern: ['A'],
    key: { A: { item: 'minecraft:iron_block' } },
    result: { item: 'test:block' },
  };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.grid.rows, 1);
  assert.equal(layout.grid.cols, 1);
  assert.equal(layout.gridSize, '1x1');
  assert.equal(layout.grid.cells.length, 1);
  assert.deepEqual(layout.grid.cells[0], {
    row: 0,
    col: 0,
    kind: 'item',
    id: 'minecraft:iron_block',
    count: 1,
    name: '',
    slotCount: 1,
  });
});

// ------------------------------------------------------------------ ① 大格子（机械合成器）

test('图案是 3 行 5 列时给 3x5 / 15 格，绝不压成 3 列 9 格', () => {
  const pattern = ['AABBC', 'AABBC', 'DDEEE'];
  const keys = {
    A: { item: 'minecraft:iron_ingot' },
    B: { item: 'minecraft:gold_ingot' },
    C: { item: 'minecraft:diamond' },
    D: { item: 'minecraft:stick' },
    E: { item: 'minecraft:oak_planks' },
  };
  const desc = shapedDesc({
    id: 'test:big',
    output: 'test:big',
    count: 1,
    pattern,
    keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.item])),
    inputs: Object.values(keys).map((v) => v.item),
  });
  const json = { type: 'minecraft:crafting_shaped', pattern, key: keys, result: { item: 'test:big' } };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.gridSize, '3x5');
  assert.equal(layout.grid.rows, 3);
  assert.equal(layout.grid.cols, 5); // 关键：不能是 3
  assert.equal(layout.grid.cells.length, 15); // 3x5 全满，一格不少
  // 最后一格必须是 (2,4)，说明没有把第 4、5 列截掉
  assert.deepEqual(
    layout.grid.cells.filter((c) => c.row === 2).map((c) => c.col),
    [0, 1, 2, 3, 4],
  );
});

test('机械合成器（mechanical_crafting）5x5 = 25 格，机器名叫机械合成器', () => {
  const pattern = ['AAAAA', 'AAAAA', 'AAAAA', 'AAAAA', 'AAAAA'];
  const desc = machineDesc('mechanical_crafting', {
    pattern,
    keys: { A: 'minecraft:iron_ingot' },
    inputs: ['minecraft:iron_ingot'],
  });
  const json = { type: 'create:mechanical_crafting', pattern, key: { A: { item: 'minecraft:iron_ingot' } }, result: { item: 'test:plate' } };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.kind, 'machine');
  assert.equal(layout.machineKind, 'mechanical_crafting');
  assert.equal(layout.machineName, '机械合成器');
  assert.equal(layout.machineIcon, 'create:mechanical_crafter');
  assert.equal(layout.gridSize, '5x5');
  assert.equal(layout.grid.rows, 5);
  assert.equal(layout.grid.cols, 5);
  assert.equal(layout.grid.cells.length, 25);
});

// ------------------------------------------------------------------ ① 标签

test('材料是标签：kind 是 tag、id 带 #、blockers 有人话说明', () => {
  const desc = shapedDesc({
    output: 'test:planks_block',
    count: 1,
    keys: {},
    inputs: [],
    editable: true, // desc 这边就当它能改，blockers 由布局层补 —— 验证布局层不靠 desc
  });
  const json = {
    type: 'minecraft:crafting_shaped',
    pattern: ['AA', 'AA'],
    key: { A: { tag: 'minecraft:planks' } },
    result: { item: 'test:planks_block' },
  };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.grid.cells.length, 4);
  for (const cell of layout.grid.cells) {
    assert.equal(cell.kind, 'tag');
    assert.equal(cell.id, '#minecraft:planks');
  }
  // 人话：说清「任意一种都行」，别只说「标签」
  assert.ok(layout.blockers.length > 0, '带标签的配方必须有 blockers');
  assert.ok(
    layout.blockers.some((b) => b.includes('标签') && b.includes('任意一种')),
    `blockers 要说人话，实际是：${layout.blockers.join(' / ')}`,
  );
  assert.equal(layout.editable, false);
  assert.ok(layout.notes.some((n) => n.includes('任意一种')));
  // keys 也拍平了：标签写成 #tag，不是原样的 {tag:...} 对象
  assert.deepEqual(layout.keys, { A: '#minecraft:planks' });
});

// ------------------------------------------------------------------ ① 无序合成

test('无序合成：3 个材料按 3x3 从左到右、从上到下依次填', () => {
  const desc = {
    id: 'test:shapeless',
    type: 'minecraft:crafting_shapeless',
    kind: 'shapeless',
    machineKind: '',
    output: 'test:shapeless',
    count: 1,
    pattern: [],
    keys: {},
    inputs: ['minecraft:stick', 'minecraft:iron_ingot'],
    tags: [],
    editable: true,
    reason: '',
  };
  const json = {
    type: 'minecraft:crafting_shapeless',
    ingredients: [{ item: 'minecraft:stick' }, { item: 'minecraft:iron_ingot' }, { item: 'minecraft:redstone' }],
    result: { item: 'test:shapeless' },
  };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.kind, 'shapeless');
  assert.equal(layout.gridSize, '3x3');
  assert.equal(layout.grid.rows, 3);
  assert.equal(layout.grid.cols, 3);
  assert.deepEqual(
    layout.grid.cells.map((c) => [c.row, c.col, c.id]),
    [
      [0, 0, 'minecraft:stick'],
      [0, 1, 'minecraft:iron_ingot'],
      [0, 2, 'minecraft:redstone'],
    ],
  );
  assert.deepEqual(layout.blockers, []);
  assert.equal(layout.editable, true);
});

// ------------------------------------------------------------------ ① Create 机器

test('Create 压片机：kind 是 machine、机器名是中文、图标是 create: 方块、材料横排一行', () => {
  const desc = machineDesc('pressing');
  const json = {
    type: 'create:pressing',
    ingredients: [{ item: 'test:ingot' }],
    results: [{ item: 'test:plate' }],
  };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.kind, 'machine');
  assert.equal(layout.machineKind, 'pressing');
  assert.equal(layout.machineName, '压片机');
  assert.equal(layout.machineIcon, 'create:mechanical_press');
  assert.equal(layout.grid.rows, 1); // 机器配方横排一行，不是九宫格
  assert.equal(layout.grid.cols, 1);
  assert.equal(layout.grid.cells.length, 1);
  assert.equal(layout.grid.cells[0].kind, 'item');
  assert.equal(layout.grid.cells[0].id, 'test:ingot');
  // 机器配方的格子也带坐标，界面照样按 row/col 画
  assert.equal(layout.grid.cells[0].row, 0);
  assert.equal(layout.grid.cells[0].col, 0);
});

test('Create 搅拌盆：机器名是搅拌盆，图标是 create:basin，材料横排多格', () => {
  const desc = machineDesc('mixing', { inputs: ['test:a', 'test:b'] });
  const json = {
    type: 'create:mixing',
    ingredients: [{ item: 'test:a' }, { item: 'test:b' }],
    results: [{ item: 'test:plate' }],
  };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.machineName, '搅拌盆');
  assert.equal(layout.machineIcon, 'create:basin');
  assert.equal(layout.grid.rows, 1);
  assert.equal(layout.grid.cols, 2);
  assert.deepEqual(layout.grid.cells.map((c) => c.id), ['test:a', 'test:b']);
  // 搅拌盆要配机械搅拌器才能用，这条提示得在
  assert.ok(layout.notes.some((n) => n.includes('mechanical_mixer')));
});

test('不认识的 create 类型：machineIcon 是空串，machineName 不是空（退回原 id 去前缀）', () => {
  const desc = machineDesc('frobnication');
  const json = { type: 'create:frobnication', ingredients: [{ item: 'test:ingot' }], result: { item: 'test:plate' } };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.kind, 'machine');
  assert.equal(layout.machineKind, 'frobnication');
  assert.equal(layout.machineIcon, '');
  assert.equal(layout.machineName, 'frobnication'); // 去掉 create: 前缀
  assert.ok(layout.machineName.length > 0);
  // 图标没有要老实说，别让用户以为是界面坏了
  assert.ok(layout.notes.some((n) => n.includes('占位')));
});

// ------------------------------------------------------------------ ① 产物

test('多产物：主产物 + extraOutputs，produceTotal 是全部相加', () => {
  const desc = shapedDesc({
    id: 'test:multi',
    output: 'test:main',
    count: 2,
    pattern: ['A'],
    keys: { A: 'minecraft:iron_ingot' },
  });
  const json = {
    type: 'minecraft:crafting_shaped',
    pattern: ['A'],
    key: { A: { item: 'minecraft:iron_ingot' } },
    result: { item: 'test:main', count: 2 },
    results: [{ item: 'test:by_one', count: 1 }, { item: 'test:by_two', count: 3 }],
  };
  const layout = layoutRecipe(desc, json);

  assert.deepEqual(layout.output, { id: 'test:main', count: 2, name: '' });
  assert.equal(layout.extraOutputs.length, 2);
  assert.deepEqual(
    layout.extraOutputs.map((o) => [o.id, o.count]),
    [
      ['test:by_one', 1],
      ['test:by_two', 3],
    ],
  );
  assert.equal(layout.produceTotal, 6); // 2 + 1 + 3
  assert.ok(layout.notes.some((n) => n.includes('3 种产物')));
});

// ------------------------------------------------------------------ ① 不可编辑

test('熔炉配方：editable 是 false、blockers 非空、材料也照样横排出来', () => {
  const desc = {
    id: 'test:smelt',
    type: 'minecraft:smelting',
    kind: 'unsupported',
    machineKind: '',
    output: 'test:ingot',
    count: 1,
    pattern: [],
    keys: {},
    inputs: ['test:ore'],
    tags: [],
    editable: false,
    reason: '这种配方类型（minecraft:smelting）界面上暂时改不了，只能在代码里改',
  };
  const json = { type: 'minecraft:smelting', ingredient: { item: 'test:ore' }, result: 'test:ingot' };
  const layout = layoutRecipe(desc, json);

  assert.equal(layout.kind, 'unsupported');
  assert.equal(layout.editable, false);
  assert.ok(layout.blockers.length > 0);
  assert.ok(layout.blockers.some((b) => b.includes('改不了')));
  assert.equal(layout.output.id, 'test:ingot');
  assert.equal(layout.grid.rows, 1);
  assert.deepEqual(layout.grid.cells.map((c) => c.id), ['test:ore']);
});

// ------------------------------------------------------------------ ① 纯函数

test('layoutRecipe 是纯函数：同一个输入调两次，结果深相等；也不改入参', () => {
  const desc = shapedDesc();
  const json = {
    type: 'minecraft:crafting_shaped',
    pattern: ['AA', 'AA'],
    key: { A: { item: 'minecraft:iron_ingot' } },
    result: { item: 'test:cogwheel', count: 2 },
  };
  const descCopy = JSON.parse(JSON.stringify(desc));
  const jsonCopy = JSON.parse(JSON.stringify(json));

  const a = layoutRecipe(desc, json);
  const b = layoutRecipe(desc, json);

  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // 入参不许被改（导出的 keys / pattern 必须是副本，否则界面改表单会污染原始数据）
  assert.deepEqual(desc, descCopy);
  assert.deepEqual(json, jsonCopy);
  a.pattern.push('ZZ');
  assert.deepEqual(desc.pattern, ['AA', 'AA']);
  assert.deepEqual(json.pattern, ['AA', 'AA']);
});

test('materialOf 认得各种常见写法，认不出的给 unknown 而不是瞎猜', () => {
  assert.deepEqual(materialOf('minecraft:iron_ingot'), { kind: 'item', id: 'minecraft:iron_ingot', count: 1 });
  assert.deepEqual(materialOf({ item: 'minecraft:stick' }), { kind: 'item', id: 'minecraft:stick', count: 1 });
  assert.deepEqual(materialOf({ tag: 'minecraft:planks' }), { kind: 'tag', id: '#minecraft:planks', count: 1 });
  assert.deepEqual(materialOf({ fluid: 'minecraft:water', count: 250 }), { kind: 'fluid', id: 'minecraft:water', count: 250 });
  // 列了多种可选物品：表达不了就给 unknown
  assert.equal(materialOf([{ item: 'a:b' }, { item: 'a:c' }]).kind, 'unknown');
  // Create 的包装写法要往里挖一层
  assert.equal(materialOf({ base: { item: 'test:base' }, addition: { item: 'test:add' } }).id, 'test:base');
  assert.equal(materialOf(null), null);
});

// ------------------------------------------------------------------ ② 渲染

test('recipeView 画有序合成：找得到 .mcs-rv-grid 和产物节点，格子数对得上', () => {
  const layout = layoutRecipe(shapedDesc(), {
    type: 'minecraft:crafting_shaped',
    pattern: ['AA', 'AA'],
    key: { A: { item: 'minecraft:iron_ingot' } },
    result: { item: 'test:cogwheel', count: 2 },
  });
  const node = recipeView(layout);

  const grid = firstClass(node, 'mcs-rv-grid');
  assert.ok(grid, '必须画出一块 .mcs-rv-grid');
  assert.equal(grid.attrs['data-rows'], '2');
  assert.equal(grid.attrs['data-cols'], '2');
  // 2x2 的 4 格都是材料，没有空格子
  assert.equal(byClass(grid, 'mcs-rv-cell').length, 4);
  assert.equal(byClass(grid, 'mcs-rv-cell-empty').length, 0);

  const out = firstClass(node, 'mcs-rv-out');
  assert.ok(out, '必须有产物节点 .mcs-rv-out');
  assert.ok(byClass(out, 'mcs-rv-out-item').length >= 1);
  assert.match(textOf(out), /×2/);

  // 顶部小字：几乘几
  assert.ok(textOf(node).includes('2x2'));
  // 中间那个箭头是 CSS 画的，不是 emoji
  assert.ok(firstClass(node, 'mcs-rv-arrow'));
});

test('recipeView 画九宫格：空格子渲染成暗色凹槽 .mcs-rv-cell-empty', () => {
  const layout = layoutRecipe(
    shapedDesc({ id: 'test:cross', output: 'test:cross', count: 1, pattern: [' A ', 'AAA', ' A '], keys: { A: 'minecraft:gold_ingot' } }),
    {
      type: 'minecraft:crafting_shaped',
      pattern: [' A ', 'AAA', ' A '],
      key: { A: { item: 'minecraft:gold_ingot' } },
      result: { item: 'test:cross' },
    },
  );
  const node = recipeView(layout);
  const grid = firstClass(node, 'mcs-rv-grid');

  assert.equal(grid.attrs['data-rows'], '3');
  assert.equal(grid.attrs['data-cols'], '3');
  // 9 个位置全铺出来：5 个有货 + 4 个凹槽
  assert.equal(byClass(grid, 'mcs-rv-cell').length, 9);
  assert.equal(byClass(grid, 'mcs-rv-cell-empty').length, 4);
});

test('recipeView 画 3x5 大格子：格子数 15、宽高属性是 3 和 5（不压缩）', () => {
  const pattern = ['AAAAA', 'AAAAA', 'AAAAA'];
  const layout = layoutRecipe(
    shapedDesc({ id: 'test:big', output: 'test:big', count: 1, pattern, keys: { A: 'minecraft:iron_ingot' } }),
    { type: 'minecraft:crafting_shaped', pattern, key: { A: { item: 'minecraft:iron_ingot' } }, result: { item: 'test:big' } },
  );
  const node = recipeView(layout, { size: 'sm' });
  const grid = firstClass(node, 'mcs-rv-grid');

  assert.equal(grid.attrs['data-rows'], '3');
  assert.equal(grid.attrs['data-cols'], '5');
  assert.equal(byClass(grid, 'mcs-rv-cell').length, 15);
  assert.match(String(grid.style), /repeat\(5,/); // CSS 列数也得是 5
  assert.match(textOf(node), /3x5/);
});

test('recipeView 画机器配方：有 .mcs-rv-machine、机器名和材料都在，不是九宫格', () => {
  const layout = layoutRecipe(machineDesc('pressing'), {
    type: 'create:pressing',
    ingredients: [{ item: 'test:ingot' }],
    results: [{ item: 'test:plate' }],
  });
  const node = recipeView(layout);

  const machine = firstClass(node, 'mcs-rv-machine');
  assert.ok(machine, '机器配方必须走 .mcs-rv-machine 这条分支（流程图）');
  assert.equal(firstClass(node, 'mcs-rv-flow'), null); // 不走普通合成那条
  assert.ok(textOf(machine).includes('压片机'));
  // 机器图标位也在（没给 iconUrl 时是占位方块）
  assert.ok(firstClass(machine, 'mcs-rv-machine-box'));
  assert.ok(byClass(machine, 'mcs-rv-machine-label').length === 1);
  assert.ok(byClass(node, 'mcs-rv-out').length === 1);
});

test('recipeView 的图标可注入：给了 iconUrl 就出 img，不给就出占位方块', () => {
  const layout = layoutRecipe(machineDesc('pressing'), {
    type: 'create:pressing',
    ingredients: [{ item: 'test:ingot' }],
    results: [{ item: 'test:plate' }],
  });
  const withIcon = recipeView(layout, { iconUrl: (id) => (id ? `data:image/png;base64,${id}` : '') });
  const img = findAll(withIcon, (n) => n.tagName === 'IMG');
  assert.ok(img.length >= 2, `材料和产物都该出图，实际 ${img.length} 张`);
  assert.match(img[0].attrs.src, /^data:image\/png;base64,/);

  const noIcon = recipeView(layout);
  assert.equal(findAll(noIcon, (n) => n.tagName === 'IMG').length, 0);
  assert.ok(findAll(noIcon, (n) => String(n.className).includes('mcs-rv-icon-ph')).length >= 2);

  // iconUrl 抛异常也不许让整块合成表画不出来
  const boom = recipeView(layout, {
    iconUrl: () => {
      throw new Error('取图挂了');
    },
  });
  assert.ok(firstClass(boom, 'mcs-rv-machine'));
});

test('recipeView 的点击回调：点格子和点产物都回调，传的是对应的数据', () => {
  const layout = layoutRecipe(machineDesc('pressing'), {
    type: 'create:pressing',
    ingredients: [{ item: 'test:ingot' }],
    results: [{ item: 'test:plate' }],
  });
  const cellHits = [];
  const outHits = [];
  const node = recipeView(layout, {
    onCellClick: (cell) => cellHits.push(cell),
    onOutputClick: (item) => outHits.push(item),
  });

  const cell = firstClass(node, 'mcs-rv-cell');
  const handlers = cell.listeners.click ?? [];
  assert.equal(handlers.length, 1);
  handlers[0]();
  assert.equal(cellHits.length, 1);
  assert.equal(cellHits[0].id, 'test:ingot');

  const outItem = firstClass(node, 'mcs-rv-out-item');
  const outHandlers = outItem.listeners.click ?? [];
  assert.equal(outHandlers.length, 1);
  outHandlers[0]();
  assert.equal(outHits.length, 1);
  assert.equal(outHits[0].id, 'test:plate');

  // 不给回调就不许挂 click 监听（否则界面上会出现点了没反应的假手型）
  const plain = recipeView(layout);
  assert.equal((firstClass(plain, 'mcs-rv-cell').listeners.click ?? []).length, 0);
});

test('recipeView 不吐 innerHTML：全部走 createElement/createTextNode，且只调一个根节点', () => {
  const layout = layoutRecipe(shapedDesc(), {
    type: 'minecraft:crafting_shaped',
    pattern: ['AA', 'AA'],
    key: { A: { item: 'minecraft:iron_ingot' } },
    result: { item: 'test:cogwheel', count: 2 },
  });
  // 把 innerHTML 换成会炸的 setter：一旦有人用 innerHTML 拼字符串，这条立刻挂
  const node = recipeView(layout);
  const all = findAll(node, () => true);
  for (const n of all) {
    if ('innerHTML' in n) {
      assert.equal(n.innerHTML === undefined ? '' : n.innerHTML, '', '不许用 innerHTML 拼 DOM');
    }
  }
  // 行为上等价：整棵树里没有一处是「整段 HTML 字符串」
  assert.equal(all.some((n) => String(n._text).includes('<div')), false);
});

// ------------------------------------------------------------------ ② 宿主接口

/** 造一个假整合包：一个 jar 里放几条配方（照 recipe-api.test.mjs 的老写法）。 */
async function makePack() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-rview-'));
  const versionDir = path.join(root, 'versions', 'ViewPack');
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(
    path.join(versionDir, 'ViewPack.json'),
    JSON.stringify({ id: 'ViewPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
    'utf8',
  );
  const modsDir = path.join(versionDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const w = new ZipWriter(path.join(modsDir, 'viewmod-1.0.jar'));
  await w.open();
  await w.addText(
    'data/viewmod/recipe/wheel.json',
    JSON.stringify({
      type: 'minecraft:crafting_shaped',
      pattern: ['AB'],
      key: { A: { item: 'minecraft:iron_ingot' }, B: { tag: 'minecraft:planks' } },
      result: { item: 'viewmod:wheel', count: 3 },
    }),
  );
  await w.addText(
    'data/viewmod/recipe/pressing/plate.json',
    JSON.stringify({
      type: 'create:pressing',
      ingredients: [{ item: 'viewmod:ingot' }],
      results: [{ item: 'viewmod:plate' }],
    }),
  );
  await w.close();
  return { root, versionDir };
}

/** 造一个 GET 请求（参数走 query）。 */
function get(suffix, params) {
  const qs = new URLSearchParams(params).toString();
  return new Request(`http://localhost/api/mcstudio${suffix}?${qs}`);
}

test('/recipe/view 端到端：返回 ok / 实例名 / 布局 / 截断后的原始 JSON', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const data = await handleRecipeView(get('/recipe/view', { dir: versionDir, recipeId: 'viewmod:wheel' }));

  assert.equal(data.ok, true);
  assert.equal(data.instanceId, 'ViewPack');
  assert.equal(data.recipe.id, 'viewmod:wheel');
  // 布局是照 desc + 原始 JSON 算出来的，格子对得上（AB 一行两格）
  assert.equal(data.layout.kind, 'shaped');
  assert.equal(data.layout.gridSize, '1x2');
  assert.equal(data.layout.grid.cells.length, 2);
  assert.equal(data.layout.grid.cells[0].id, 'minecraft:iron_ingot');
  // B 是标签，id 带 # 前缀
  assert.equal(data.layout.grid.cells[1].kind, 'tag');
  assert.equal(data.layout.grid.cells[1].id, '#minecraft:planks');
  // 原始 JSON 是字符串（前端要 text 才能直接显示），且没超上限
  assert.equal(typeof data.rawJson, 'string');
  assert.equal(data.rawJsonTruncated, false);
  assert.match(data.rawJson, /crafting_shaped/);
  assert.equal(typeof data.rawJsonSize, 'number');
});

test('/recipe/view 端到端：Create 机器配方也认，机器名中文', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const data = await handleRecipeView(get('/recipe/view', { dir: versionDir, recipeId: 'viewmod:pressing/plate' }));

  assert.equal(data.recipe.kind, 'machine');
  assert.equal(data.layout.kind, 'machine');
  assert.equal(data.layout.machineName, '压片机');
  assert.equal(data.layout.machineIcon, 'create:mechanical_press');
  assert.equal(data.layout.grid.rows, 1);
});

test('/recipe/view 缺 dir 时报中文错，不是 500', async () => {
  resetCaches();
  await assert.rejects(
    () => handleRecipeView(get('/recipe/view', { recipeId: 'viewmod:wheel' })),
    (error) => String(error.message).includes('缺少实例目录'),
  );
});

test('packRawJson 超过 8KB 会截断并说明截了多少，小 JSON 原样返回', () => {
  const small = packRawJson({ type: 'x' });
  assert.equal(small.truncated, false);
  assert.match(small.text, /"type": "x"/);

  const big = packRawJson({ blob: 'A'.repeat(20000) });
  assert.equal(big.truncated, true);
  assert.ok(big.size > 20000);
  assert.ok(big.text.length < big.size);
  assert.match(big.text, /已截断/);
});
