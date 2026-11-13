/**
 * mc_mod_inspect 的单测 —— 锁的是「拆 jar 时哪些格式差异会导致静默少数据」。
 *
 * 每一条都对应一个真实存在的格式分歧（1.20 与 1.21 的目录名/字段名不同），
 * 写错不会报错，只会让工具安静地少掉一半内容 —— 那种 bug 最难发现。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectJar, findModJar, modConfigFiles } from '../packages/core/mod-inspect.js';
import { McError } from '../packages/core/errors.js';
import { makeZip } from './make-zip.mjs';

/** 把内存 zip 写到临时文件并返回路径。 */
function jarOf(files, name = 'testmod.jar') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcins-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, makeZip(files));
  return file;
}

const TOML = `modLoader="javafml"
loaderVersion="[1,)"
[[mods]]
modId="create"
version="0.5.1"
displayName="Create"
`;

test('items: 中文名优先，缺中文时退回英文名', () => {
  const jar = jarOf({
    'META-INF/neoforge.mods.toml': TOML,
    'assets/create/lang/zh_cn.json': JSON.stringify({
      'item.create.cogwheel': '齿轮',
      'block.create.shaft': '传动轴',
    }),
    'assets/create/lang/en_us.json': JSON.stringify({
      'item.create.cogwheel': 'Cogwheel',
      'item.create.wrench': 'Wrench',
    }),
  });
  const r = inspectJar(jar);
  const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(byId['create:cogwheel'].name, '齿轮');
  assert.equal(byId['create:shaft'].name, '传动轴');
  assert.equal(byId['create:wrench'].name, 'Wrench', '没有中文名时应退回英文');
});

test('items: models/item 的子目录只取第一段，不造变体假 ID', () => {
  const jar = jarOf({
    'META-INF/neoforge.mods.toml': TOML,
    'assets/create/models/item/package/cardboard_12x10.json': '{}',
    'assets/create/models/item/cogwheel.json': '{}',
  });
  const r = inspectJar(jar);
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['create:cogwheel', 'create:package']);
});

test('recipes: 1.21 的 {id,count} 与 1.20 的 {item,count} 都认', () => {
  const jar = jarOf({
    'META-INF/neoforge.mods.toml': TOML,
    'data/create/recipe/new.json': JSON.stringify({
      type: 'minecraft:crafting_shapeless',
      ingredients: [{ id: 'minecraft:iron_ingot' }],
      result: { id: 'create:andesite_alloy', count: 2 },
    }),
    'data/create/recipes/old.json': JSON.stringify({
      type: 'minecraft:crafting_shapeless',
      ingredients: [{ item: 'minecraft:iron_ingot' }],
      result: { item: 'create:brass_ingot', count: 3 },
    }),
  });
  const r = inspectJar(jar);
  const byFile = Object.fromEntries(r.recipes.map((x) => [x.file, x]));
  assert.deepEqual(byFile['data/create/recipe/new.json'].result, { id: 'create:andesite_alloy', count: 2 });
  assert.deepEqual(byFile['data/create/recipes/old.json'].result, { id: 'create:brass_ingot', count: 3 });
});

test('recipes: 只收本 modId 的配方，不串到别的命名空间', () => {
  const jar = jarOf({
    'META-INF/neoforge.mods.toml': TOML,
    'data/create/recipe/mine.json': JSON.stringify({ result: { id: 'create:cogwheel' } }),
    'data/other/recipe/notmine.json': JSON.stringify({ result: { id: 'other:thing' } }),
  });
  const r = inspectJar(jar);
  assert.equal(r.recipes.length, 1);
  assert.equal(r.recipes[0].file, 'data/create/recipe/mine.json');
});

test('recipes: 自定义类型的任意字段都能被收集成材料（base/addition 之类）', () => {
  // 坑：逐字段取（只认 ingredients）会漏掉 mod 自定义类型的输入
  const jar = jarOf({
    'META-INF/neoforge.mods.toml': TOML,
    'data/create/recipe/crank.json': JSON.stringify({
      type: 'create:mechanical_crafting',
      base: { item: 'create:shaft' },
      addition: [{ item: 'minecraft:gold_ingot' }],
      result: { id: 'create:hand_crank', count: 1 },
    }),
  });
  const r = inspectJar(jar);
  const rec = r.recipes[0];
  assert.ok(rec.ingredients.includes('create:shaft'));
  assert.ok(rec.ingredients.includes('minecraft:gold_ingot'));
  assert.ok(!rec.ingredients.includes('create:hand_crank'), '产物不该算进材料');
  assert.ok(!rec.ingredients.includes('create:mechanical_crafting'), 'type 不该算进材料');
});

test('recipes: #标签引用被保留（改一类物品的关键抓手）', () => {
  const jar = jarOf({
    'META-INF/neoforge.mods.toml': TOML,
    'data/create/recipe/planks.json': JSON.stringify({
      type: 'minecraft:crafting_shaped',
      ingredients: ['#minecraft:planks'],
      result: { id: 'create:cogwheel' },
    }),
  });
  const r = inspectJar(jar);
  assert.deepEqual(r.recipes[0].ingredients, ['#minecraft:planks']);
});

test('tags: tags/item 与 tags/items 都认，值可以是字符串或 {id}', () => {
  const jar = jarOf({
    'META-INF/neoforge.mods.toml': TOML,
    'data/create/tags/item/gems.json': JSON.stringify({
      values: ['minecraft:diamond', { id: 'create:polished_rose_quartz' }],
    }),
    'data/create/tags/items/legacy.json': JSON.stringify({ values: ['minecraft:emerald'] }),
  });
  const r = inspectJar(jar);
  assert.equal(r.tags.length, 2);
  const gems = r.tags.find((t) => t.tag === '#create:gems');
  assert.deepEqual(gems.values, ['minecraft:diamond', 'create:polished_rose_quartz']);
});

test('loot: loot_table 与 loot_tables 都认', () => {
  const jar = jarOf({
    'META-INF/neoforge.mods.toml': TOML,
    'data/create/loot_table/blocks/cogwheel.json': JSON.stringify({
      pools: [{ entries: [{ type: 'minecraft:item', name: 'create:cogwheel' }] }],
    }),
    'data/create/loot_tables/blocks/shaft.json': JSON.stringify({
      pools: [{ entries: [{ type: 'minecraft:item', name: 'create:shaft' }] }],
    }),
  });
  const r = inspectJar(jar);
  assert.equal(r.loot.length, 2);
  assert.ok(r.loot.some((l) => l.items.includes('create:cogwheel')));
});

test('recipeTypes 按条数降序，概览能看出这个 mod 主要靠什么合成', () => {
  const jar = jarOf({
    'META-INF/neoforge.mods.toml': TOML,
    'data/create/recipe/a.json': JSON.stringify({ type: 'create:mixing', result: { id: 'create:a' } }),
    'data/create/recipe/b.json': JSON.stringify({ type: 'create:mixing', result: { id: 'create:b' } }),
    'data/create/recipe/c.json': JSON.stringify({ type: 'minecraft:crafting_shaped', result: { id: 'create:c' } }),
  });
  const r = inspectJar(jar);
  assert.equal(r.recipeTypes[0].type, 'create:mixing');
  assert.equal(r.recipeTypes[0].count, 2);
});

test('坏 JSON 不炸，记进 recipeSkipped', () => {
  const jar = jarOf({
    'META-INF/neoforge.mods.toml': TOML,
    'data/create/recipe/broken.json': '{ 这不是 json',
    'data/create/recipe/ok.json': JSON.stringify({ result: { id: 'create:ok' } }),
  });
  const r = inspectJar(jar);
  assert.equal(r.recipes.length, 1);
  assert.equal(r.recipeSkipped, 1);
});

test('没有 mod 元数据时按目录名猜命名空间，不至于整个哑掉', () => {
  const jar = jarOf({
    'assets/weirdmod/lang/zh_cn.json': JSON.stringify({ 'item.weirdmod.thing': '东西' }),
    'data/weirdmod/recipe/x.json': JSON.stringify({ result: { id: 'weirdmod:thing' } }),
  });
  const r = inspectJar(jar);
  assert.equal(r.modId, 'weirdmod');
  assert.ok(r.items.some((i) => i.id === 'weirdmod:thing'));
});

test('findModJar: 文件名、modId、找不到报错三种情况', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcins-mods-'));
  fs.writeFileSync(path.join(dir, 'create-1.21.1-0.5.1.jar'), makeZip({ 'META-INF/neoforge.mods.toml': TOML }));
  fs.writeFileSync(path.join(dir, 'jei.jar'), makeZip({ 'META-INF/mods.toml': 'modId="jei"\ndisplayName="JEI"\n' }));
  const instance = { modsDir: dir, instanceDir: dir, mcRoot: dir };

  assert.ok(findModJar(instance, 'create').endsWith('create-1.21.1-0.5.1.jar'), '按 modId 找');
  assert.ok(findModJar(instance, 'jei.jar').endsWith('jei.jar'), '按文件名找');
  assert.throws(() => findModJar(instance, 'nope'), (e) => e instanceof McError);
});

test('modConfigFiles: 只认 modId 后紧跟 - . / 的文件，不认同前缀的别的 mod', () => {
  // 坑：实测 create 会命中 32 个文件，但 create_central_kitchen-common.toml、
  // createdieselgenerators-server.toml 都属于别的 mod，只是名字以 create 开头
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcins-cfg-'));
  const cfg = path.join(root, 'config');
  fs.mkdirSync(path.join(cfg, 'create'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'create-common.toml'), 'a = 1');
  fs.writeFileSync(path.join(cfg, 'create', 'server.toml'), 'b = 2');
  fs.writeFileSync(path.join(cfg, 'create_central_kitchen-common.toml'), 'c = 3');
  fs.writeFileSync(path.join(cfg, 'createdieselgenerators-server.toml'), 'd = 4');
  fs.writeFileSync(path.join(cfg, 'jei-client.toml'), 'e = 5');
  fs.writeFileSync(path.join(cfg, 'notes.txt'), '不该出现');

  const instance = { instanceDir: root, mcRoot: root, modsDir: path.join(root, 'mods') };
  const all = modConfigFiles(instance, 'create');
  const own = all.filter((c) => c.own).map((c) => c.file);
  assert.deepEqual(own, ['create-common.toml', 'create/server.toml'], '只有这两个是 Create 自己的');
  const others = all.filter((c) => !c.own).map((c) => c.file);
  assert.deepEqual(others, ['create_central_kitchen-common.toml', 'createdieselgenerators-server.toml']);
  assert.equal(all[0].own, true, '自己的配置排在前面');
});
