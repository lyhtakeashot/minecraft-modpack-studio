/**
 * KubeJS 沙箱与静态校验的单元测试。
 * 跑法：node --import ./test/register.mjs test/kubejs.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  idFromExpression, idsInValue, runScript, analyzeCalls, declaredIds, collectScripts,
  verifyScripts, describeVerify, scriptItems,
} from '../packages/core/kubejs.js';

let pass = 0;
let fail = 0;
const test = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

console.log('idFromExpression');

test('普通 ID', () => {
  assert.equal(idFromExpression('create:cogwheel'), 'create:cogwheel');
});

test('带数量前缀（有空格）', () => {
  assert.equal(idFromExpression('2x create:cogwheel'), 'create:cogwheel');
});

test('带数量前缀（无空格）', () => {
  // KubeJS 里两种写法都有人用，实际包里的 "7xminecraft:ender_pearl" 就是这种
  assert.equal(idFromExpression('7xminecraft:ender_pearl'), 'minecraft:ender_pearl');
});

test('带组件方括号', () => {
  assert.equal(
    idFromExpression('minecraft:potion[potion_contents={potion:"x:y"}]'),
    'minecraft:potion',
  );
});

test('标签不算物品', () => {
  assert.equal(idFromExpression('#minecraft:planks'), '');
});

test('不像 ID 的字符串不认', () => {
  assert.equal(idFromExpression('hello world'), '');
  assert.equal(idFromExpression(''), '');
  assert.equal(idFromExpression(123), '');
});

console.log('\nidsInValue');

test('从数组里翻', () => {
  const ids = idsInValue(['create:a', '2x minecraft:b', 'not an id']);
  assert.deepEqual([...ids].sort(), ['create:a', 'minecraft:b']);
});

test('从对象值里翻', () => {
  const ids = idsInValue({ A: 'minecraft:oak_planks', B: ['create:shaft'] });
  assert.deepEqual([...ids].sort(), ['create:shaft', 'minecraft:oak_planks']);
});

test('从对象键里也翻（event.shaped 的 pattern 映射）', () => {
  const ids = idsInValue({ 'create:andesite_alloy': 2 });
  assert.deepEqual([...ids], ['create:andesite_alloy']);
});

console.log('\nrunScript');

test('正常脚本记录调用', () => {
  const r = runScript(`
    ServerEvents.recipes(event => {
      event.shapeless('create:cogwheel', ['minecraft:iron_ingot'])
    })
  `, 'server_scripts/a.js');
  assert.equal(r.status, 'ok');
  assert.ok(r.calls.length > 0);
  const flat = r.calls.map((c) => c.path);
  assert.ok(flat.some((p) => p.includes('shapeless')), flat.join(','));
});

test('语法错能抓到并给行号', () => {
  const r = runScript(`ServerEvents.recipes(e => {\n  e.shapeless('a:b', ['c:d'\n})`, 'server_scripts/bad.js');
  assert.equal(r.status, 'syntax-error');
  assert.match(r.error, /SyntaxError/);
});

test('运行时错不会把整个校验炸掉', () => {
  const r = runScript(`throw new Error('故意的')`, 'server_scripts/boom.js');
  assert.equal(r.status, 'runtime-error');
  assert.match(r.error, /故意的/);
});

test('未定义的全局会报运行时错（这是真实会炸的情况）', () => {
  const r = runScript(`SomeUnknownApi.doThing()`, 'server_scripts/x.js');
  assert.equal(r.status, 'runtime-error');
  assert.match(r.error, /SomeUnknownApi is not defined/);
});

test('Java.loadClass 不抛异常（真实包里大量使用）', () => {
  const r = runScript(`
    let $Player = Java.loadClass('net.minecraft.world.entity.player.Player')
    let x = $Player
  `, 'startup_scripts/j.js');
  assert.equal(r.status, 'ok');
});

test('LootJS 事件总线可用（真实包里用到）', () => {
  const r = runScript(`
    LootJS.lootTables(event => {
      event.getLootTable('minecraft:entities/zombie').createPool()
    })
  `, 'server_scripts/loot.js');
  assert.equal(r.status, 'ok');
  const flat = r.calls.map((c) => c.path);
  assert.ok(flat.includes('LootJS.lootTables'));
  assert.ok(flat.some((p) => p.endsWith('getLootTable')), flat.join(','));
});

test('链式调用不会断', () => {
  const r = runScript(`
    ItemEvents.rightClicked('minecraft:stick', event => {
      event.player.tell('hello').andThen.more()
    })
  `, 'server_scripts/chain.js');
  assert.equal(r.status, 'ok');
});

console.log('\nanalyzeCalls');

test('拆出加配方', () => {
  const calls = [
    { path: 'event.shaped', args: ['create:cogwheel', ['ABA'], { A: 'minecraft:oak_planks', B: 'create:andesite_alloy' }] },
  ];
  const a = analyzeCalls(calls);
  assert.equal(a.recipes.length, 1);
  assert.equal(a.recipes[0].output, 'create:cogwheel');
  assert.deepEqual([...a.itemRefs].sort(), ['create:andesite_alloy', 'create:cogwheel', 'minecraft:oak_planks']);
});

test('拆出删配方', () => {
  const calls = [{ path: 'event.remove', args: [{ id: 'create:andesite_alloy_from_crafting' }] }];
  const a = analyzeCalls(calls);
  assert.equal(a.removals.length, 1);
  assert.equal(a.removals[0].id, 'create:andesite_alloy_from_crafting');
  assert.ok(a.recipeRefs.has('create:andesite_alloy_from_crafting'));
  assert.equal(a.itemRefs.size, 0, '配方 ID 不该被当成物品');
});

test('remove({mod}) 记下 mod 名', () => {
  const a = analyzeCalls([{ path: 'event.remove', args: [{ mod: 'create_dragons_plus', type: 'create_dragons_plus:sanding' }] }]);
  assert.equal(a.removals[0].mod, 'create_dragons_plus');
  assert.equal(a.removals[0].type, 'create_dragons_plus:sanding');
});

test('战利品表不当成物品', () => {
  const a = analyzeCalls([
    { path: 'event.getLootTable', args: ['minecraft:chests/end_city_treasure'] },
    { path: 'event.create', args: ['touhou_little_maid:entities/fairy'] },
  ]);
  assert.ok(a.lootTables.has('minecraft:chests/end_city_treasure'));
  assert.ok(a.lootTables.has('touhou_little_maid:entities/fairy'));
  assert.equal(a.itemRefs.size, 0, `不该有物品，实际：${[...a.itemRefs].join(',')}`);
});

test('属性名不当成物品', () => {
  const a = analyzeCalls([{ path: 'context.addAttribute', args: ['minecraft:generic.armor', 'x', 4, 'add_value'] }]);
  assert.ok(a.attributes.has('minecraft:generic.armor'));
  assert.equal(a.itemRefs.size, 0);
});

test('replaceInput 的过滤器算配方、后两个算物品', () => {
  const a = analyzeCalls([
    { path: 'event.replaceInput', args: [{ id: 'l2complements:craft/sculkium_ingot' }, 'minecraft:copper_ingot', 'advancednetherite:netherite_gold_ingot'] },
  ]);
  assert.ok(a.recipeRefs.has('l2complements:craft/sculkium_ingot'));
  assert.deepEqual([...a.itemRefs].sort(), ['advancednetherite:netherite_gold_ingot', 'minecraft:copper_ingot']);
});

test('ServerEvents.tags 的第一个参数是标签，不是物品', () => {
  // 真实包里就这一行，曾被误判成「引用了不存在的物品 kubejs:the_end_helmet」
  const a = analyzeCalls([
    { path: 'ServerEvents.tags.callback.event.add', args: ['kubejs:the_end_helmet', 'cataclysm:ignitium_helmet'] },
  ]);
  assert.ok(a.tags.has('kubejs:the_end_helmet'), [...a.tags].join(','));
  assert.deepEqual([...a.itemRefs], ['cataclysm:ignitium_helmet']);
});

test('带 # 的标签写法也认', () => {
  const a = analyzeCalls([
    { path: 'ServerEvents.tags.callback.event.add', args: ['#minecraft:planks', 'minecraft:oak_planks'] },
  ]);
  assert.ok(a.tags.has('minecraft:planks'));
  assert.deepEqual([...a.itemRefs], ['minecraft:oak_planks']);
});

test('event.add 但不在 tags 上下文里，就不能当成标签', () => {
  const a = analyzeCalls([{ path: 'someOtherApi.add', args: ['create:cogwheel'] }]);
  assert.equal(a.tags.size, 0);
  assert.deepEqual([...a.itemRefs], ['create:cogwheel']);
});

test('event.recipes.create.pressing 能认出产物', () => {
  const a = analyzeCalls([{ path: 'event.recipes.create.pressing', args: ['create:iron_sheet', 'minecraft:iron_ingot'] }]);
  assert.equal(a.recipes.length, 1);
  assert.equal(a.recipes[0].kind, 'pressing');
  assert.equal(a.recipes[0].output, 'create:iron_sheet');
  assert.deepEqual(a.recipes[0].inputs, ['minecraft:iron_ingot']);
});

console.log('\ndeclaredIds');

test('认出 StartupEvents.registry 声明的物品', () => {
  const calls = [
    { path: 'registry.item.create', args: ['ticket'] },
    { path: 'registry.item.create', args: ['createages:iron_mechanism'] },
    { path: 'registry.block.create', args: ['compressed_tuff'] },
  ];
  const ids = [...declaredIds(calls)].sort();
  assert.deepEqual(ids, ['createages:iron_mechanism', 'kubejs:compressed_tuff', 'kubejs:ticket']);
});

console.log('\nscriptItems（脚本现造物品：kind 过滤 / 派生桶 / 中文名 / 命名空间）');

const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-kjs-items-'));
const smake = (rel, body) => {
  const full = path.join(sdir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

// 一份尽量贴近用户包真实写法的脚本：跨行链式、带第二参数、注释、单行/双引号混用，
// 别的命名空间（createages / c6c）、流体（派生桶），以及一个「不是物品」的战利品表 create。
smake('startup_scripts/main.js', `
StartupEvents.registry('item', event => {
  event.create('ticket').rarity('epic');
  event
    .create('chlorophyte_sword', 'sword')
    .tier('chlorophyte')
    .maxDamage(1800);
  event.create('createages:iron_mechanism');
  event.create('c6c:utility_belt');
});
// 这行是注释，不该被收：event.create('kubejs:comment_fake')
StartupEvents.registry('block', event => {
  event.create('createages:andesite_machine')
    .displayName('Andesite Machine')
    .hardness(0);
  event.create('warped_stem_chlorophyte').displayName('Chlorophyted Warped Stem');
});
StartupEvents.registry('fluid', event => {
  event.create('coolant', 'thin').tint(0x70BAEA);
  event.create('fine_oil', 'thick');
});
`);
// 战利品表：event.create 但不是 registry.*.create，绝不能混进物品
smake('server_scripts/loots.js', `
LootJS.modifiers((event) => {
  event.create('touhou_little_maid:entities/fairy');
});
`);
// 语言文件：中文优先、按「键里的 ns」建 id（kubejs 目录里放着 c6c 的键）
smake('assets/kubejs/lang/zh_cn.json', JSON.stringify({
  'item.kubejs.ticket': '女仆奖券',
  'item.kubejs.chlorophyte_sword': '叶绿剑',
  'item.kubejs.coolant_bucket': '天然冷却液桶',
  'block.kubejs.warped_stem_chlorophyte': '叶绿矿化诡异菌柄',
  'item.c6c.utility_belt': '多功能腰带',
  'item.kubejs.comment_fake': '注释假物',
  'fluid.kubejs.coolant': '冷却液（不是三段 item/block，别当名字）',
}));
smake('assets/kubejs/lang/en_us.json', JSON.stringify({
  'item.kubejs.ticket': 'Maid Ticket',
  'item.kubejs.fine_oil_bucket': 'Fine Oil Bucket',
}));
smake('assets/createages/lang/zh_cn.json', JSON.stringify({
  'block.createages.andesite_machine': '安山机械',
  'item.createages.iron_mechanism': '铁构件',
}));

test('只收 item / block / fluid 三类，fluid 派生桶、不当流体本身', () => {
  const r = scriptItems(sdir);
  const ids = r.items.map((x) => x.id).sort();
  assert.deepEqual(ids, [
    'c6c:utility_belt',
    'createages:andesite_machine',
    'createages:iron_mechanism',
    'kubejs:chlorophyte_sword',
    'kubejs:coolant_bucket',
    'kubejs:fine_oil_bucket',
    'kubejs:ticket',
    'kubejs:warped_stem_chlorophyte',
  ]);
  // 流体本身不是物品；注释里的假物、战利品表 create 都不能出现
  assert.equal(ids.includes('kubejs:coolant'), false);
  assert.equal(ids.includes('kubejs:fine_oil'), false);
  assert.equal(ids.includes('kubejs:comment_fake'), false);
  assert.equal(ids.some((x) => x.includes('touhou_little_maid')), false);
});

test('中文名按「键里的 ns」映射，中文优先、英文兜底、displayName 再兜底', () => {
  const r = scriptItems(sdir);
  const byId = new Map(r.items.map((x) => [x.id, x]));
  assert.equal(byId.get('kubejs:ticket').name, '女仆奖券', '中文盖过英文');
  assert.equal(byId.get('c6c:utility_belt').name, '多功能腰带', 'c6c 的键放在 kubejs/lang 里也能按「键 ns」认出来');
  assert.equal(byId.get('createages:andesite_machine').name, '安山机械', '三段 block 键');
  assert.equal(byId.get('kubejs:coolant_bucket').name, '天然冷却液桶', '派生桶也有中文名');
  assert.equal(byId.get('kubejs:fine_oil_bucket').name, 'Fine Oil Bucket', '没中文就用英文');
  assert.equal(byId.get('kubejs:warped_stem_chlorophyte').name, '叶绿矿化诡异菌柄');
});

test('displayName() english 兜底：lang 没写的 ID 用它', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-kjs-dn-'));
  const make2 = (rel, body) => {
    const full = path.join(d, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  make2('startup_scripts/a.js', `
StartupEvents.registry('block', e => {
  e.create('compressed_tuff').displayName('Compressed Tuff');
});
`);
  const r = scriptItems(d);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 'kubejs:compressed_tuff');
  assert.equal(r.items[0].name, 'Compressed Tuff');
  fs.rmSync(d, { recursive: true, force: true });
});

test('namespaces 收全脚本物品用到的命名空间', () => {
  const r = scriptItems(sdir);
  assert.deepEqual([...r.namespaces].sort(), ['c6c', 'createages', 'kubejs']);
});

test('空目录不报错', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-kjs-empty2-'));
  const r = scriptItems(empty);
  assert.deepEqual(r.items, []);
  assert.equal(r.namespaces.size, 0);
  fs.rmSync(empty, { recursive: true, force: true });
});

fs.rmSync(sdir, { recursive: true, force: true });

console.log('\nverifyScripts（真跑一批假脚本）');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-kjs-'));
const make = (rel, body) => {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

make('startup_scripts/main.js', `
  StartupEvents.registry('item', item => {
    item.create('kubejs:magic_dust').maxStackSize(64)
  })
`);
make('server_scripts/ok.js', `
  ServerEvents.recipes(event => {
    event.shapeless('kubejs:magic_dust', ['minecraft:redstone'])
  })
`);
make('server_scripts/bad-syntax.js', `ServerEvents.recipes(e => { e.shapeless('a:b', ['c:d' })`);
make('server_scripts/bad-runtime.js', `NotAnApi.whatever()`);
make('server_scripts/missing-id.js', `
  ServerEvents.recipes(event => {
    event.shapeless('minecraft:stick', ['notamod:not_an_item'])
  })
`);
make('client_scripts/tip.js', `ClientEvents.init(() => {})`);

test('扫到全部脚本并按阶段分组', () => {
  const scripts = collectScripts(tmp);
  const stages = scripts.map((s) => s.stage).sort();
  assert.deepEqual(stages, ['client', 'server', 'server', 'server', 'server', 'startup']);
});

test('整体校验：状态分类正确', () => {
  const r = verifyScripts(tmp, { knownItems: (id) => id === 'minecraft:redstone' || id === 'minecraft:stick' });
  assert.equal(r.scriptCount, 6);
  assert.equal(r.breakdown['syntax-error'], 1);
  assert.equal(r.breakdown['runtime-error'], 1);
  assert.equal(r.breakdown.ok, 4);
});

test('脚本自己 new 出来的 ID 不算缺', () => {
  const r = verifyScripts(tmp, { knownItems: (id) => id === 'minecraft:redstone' || id === 'minecraft:stick' });
  assert.ok(r.declared.includes('kubejs:magic_dust'), r.declared.join(','));
  assert.equal(r.missingItems.filter((m) => m.id === 'kubejs:magic_dust').length, 0);
});

test('真的不存在的物品被抓到', () => {
  const r = verifyScripts(tmp, { knownItems: (id) => id === 'minecraft:redstone' || id === 'minecraft:stick' });
  const missing = r.missingItems.map((m) => m.id);
  assert.ok(missing.includes('notamod:not_an_item'), missing.join(','));
});

test('不给索引就不判断缺失（默认放行）', () => {
  const r = verifyScripts(tmp);
  assert.equal(r.missingItems.length, 0);
});

test('describeVerify 能出人读清单', () => {
  const r = verifyScripts(tmp, { knownItems: (id) => id === 'minecraft:redstone' || id === 'minecraft:stick' });
  const lines = describeVerify(r);
  const text = lines.join('\n');
  assert.match(text, /脚本 6 个/);
  assert.match(text, /语法错：1 个/);
  assert.match(text, /bad-syntax\.js/);
});

test('空目录不报错', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-kjs-empty-'));
  const r = verifyScripts(empty);
  assert.equal(r.scriptCount, 0);
  assert.doesNotThrow(() => describeVerify(r));
  fs.rmSync(empty, { recursive: true, force: true });
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${'='.repeat(50)}`);
console.log(`${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
