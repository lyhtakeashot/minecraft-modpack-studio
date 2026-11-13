/**
 * indexJar 的单测 —— 这里每一条都对应一个实测踩过的坑，别删。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexJar, indexInstance } from '../packages/core/index.js';
import { makeZip } from './make-zip.mjs';

/** 把内存 zip 写到临时文件，indexJar 走的是文件路径。 */
function writeTemp(buf, name = 'test.jar') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcidx-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
}

function indexOf(files) {
  return indexJar(writeTemp(makeZip(files)));
}

/** 造一个只有 mods/ 的实例对象，够 indexInstance 跑起来。 */
function instanceOf(jars) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcinst-'));
  const versions = path.join(root, 'versions', 'DemoPack');
  const modsDir = path.join(versions, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  let i = 0;
  for (const jar of jars) {
    fs.writeFileSync(path.join(modsDir, `mod-${i}.jar`), makeZip(jar));
    i += 1;
  }
  return {
    id: 'DemoPack',
    instanceDir: versions,
    mcRoot: root,
    modsDir,
    hasClientJar: false,
    clientJar: '',
    versionJsonPath: path.join(versions, 'DemoPack.json'),
  };
}

test('幽灵物品：包里有它的数据引用、但没有任何 jar 给它资源、也没有 mod 认领它 → 标出来', () => {
  // 真实形状：别的 mod 的配方/战利品表里提到 `ae2:certus_quartz_dust`，
  // 但 AE2 根本没装 —— 游戏里不存在这个东西，界面上却会占一格而且永远没图标。
  const inst = instanceOf([
    {
      'META-INF/mods.toml': 'modId="create"\ndisplayName="Create"\nversion="1"\n',
      'data/create/recipe/mixer.json': JSON.stringify({ result: 'ae2:certus_quartz_dust' }),
      'assets/create/lang/en_us.json': JSON.stringify({ 'item.create.cogwheel': 'Cogwheel' }),
      'assets/create/models/item/cogwheel.json': JSON.stringify({ textures: { layer0: 'create:item/cogwheel' } }),
      'assets/create/textures/item/cogwheel.png': 'png',
    },
    {
      // 数据包风格：只加物品、不给任何资源，但 jar 认领了这个命名空间 → 不算幽灵
      'META-INF/mods.toml': 'modId="scripted"\ndisplayName="Scripted"\nversion="1"\n',
      'data/scripted/recipe/x.json': JSON.stringify({ result: 'scripted:magic_wand' }),
      'assets/scripted/lang/en_us.json': JSON.stringify({ 'item.scripted.magic_wand': 'Magic Wand' }),
    },
  ]);
  const idx = indexInstance(inst);

  assert.equal(idx.has('create:cogwheel'), true);
  assert.equal(idx._ghostItems.has('create:cogwheel'), false, '有资源的真物品不能被当幽灵');
  assert.equal(idx._ghostItems.has('scripted:magic_wand'), false,
    '命名空间有 jar 认领（哪怕没有任何贴图）也不能算幽灵 —— 那是脚本现造的真物品');
  assert.equal(idx._ghostItems.has('minecraft:lava'), false, '原版命名空间一律不动');
  assert.ok(idx.ghostCount >= 1);
});

test('幽灵物品：命名空间既没资源也没 mod 认领（ae2 那种装不上的 mod）', () => {
  const inst = instanceOf([
    {
      'META-INF/mods.toml': 'modId="create"\ndisplayName="Create"\nversion="1"\n',
      'data/create/recipe/mixer.json': JSON.stringify({ result: 'ae2:certus_quartz_dust' }),
      'assets/create/lang/en_us.json': JSON.stringify({ 'item.create.cogwheel': 'Cogwheel' }),
      'assets/create/models/item/cogwheel.json': JSON.stringify({ textures: { layer0: 'create:item/cogwheel' } }),
      'assets/create/textures/item/cogwheel.png': 'png',
    },
  ]);
  const idx = indexInstance(inst);

  assert.equal(idx._ghostItems.has('ae2:certus_quartz_dust'), true,
    'AE2 没装：这个 ID 是别的 mod 数据文件里带进来的残留，要标成幽灵');
  assert.equal(idx.has('ae2:certus_quartz_dust'), true,
    '但物品表本身不动 —— 幽灵只是「界面别显示」，不是「假装它不存在」');
});

test('脚本现造物品：补进 _items、中文名按 lang 键、createages 命名空间不再被标幽灵', () => {
  // 真实形状（Mechanomania 2026-11-07）：StartupEvents.registry 声明的 19 个物品
  // 在 mods/*.jar 里根本不存在，indexInstance 只扫 jar 就会全漏。
  // 这里造一个「只有 create 一个 jar」的实例 + kubejs 脚本，验证补进链路。
  const inst = instanceOf([
    {
      'META-INF/mods.toml': 'modId="create"\ndisplayName="Create"\nversion="1"\n',
      'assets/create/lang/en_us.json': JSON.stringify({ 'item.create.cogwheel': 'Cogwheel' }),
      'assets/create/models/item/cogwheel.json': JSON.stringify({ textures: { layer0: 'create:item/cogwheel' } }),
    },
  ]);
  // 往实例的 kubejs 目录写脚本 + 语言文件（instanceDir 就是 versions/DemoPack）
  const put = (rel, body) => {
    const full = path.join(inst.instanceDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  put('kubejs/startup_scripts/main.js', `
StartupEvents.registry('item', event => {
  event.create('chlorophyte_ingot');
  event.create('createages:iron_mechanism');
  event.create('c6c:utility_belt');
});
StartupEvents.registry('block', event => {
  event.create('createages:andesite_machine').displayName('Andesite Machine');
});
StartupEvents.registry('fluid', event => {
  event.create('coolant', 'thin');
});
`);
  put('kubejs/assets/kubejs/lang/zh_cn.json', JSON.stringify({
    'item.kubejs.chlorophyte_ingot': '叶绿锭',
    'item.kubejs.coolant_bucket': '天然冷却液桶',
    'item.c6c.utility_belt': '多功能腰带',
  }));
  put('kubejs/assets/createages/lang/zh_cn.json', JSON.stringify({
    'block.createages.andesite_machine': '安山机械',
    'item.createages.iron_mechanism': '铁构件',
  }));

  const idx = indexInstance(inst);

  // jar 里的东西照旧
  assert.equal(idx.has('create:cogwheel'), true);
  // 脚本现造的 5 个（3 item + 1 block + 1 流体派生桶）全补进来了
  assert.equal(idx.has('kubejs:chlorophyte_ingot'), true);
  assert.equal(idx.has('kubejs:coolant_bucket'), true, 'fluid 自动派生的桶也要补');
  assert.equal(idx.has('kubejs:coolant'), false, '流体本身不是物品');
  assert.equal(idx.has('createages:andesite_machine'), true);
  assert.equal(idx.has('createages:iron_mechanism'), true);
  assert.equal(idx.has('c6c:utility_belt'), true);
  // 中文名按 lang 键（键里的 ns 才是真命名空间）
  assert.equal(idx.nameOf('kubejs:chlorophyte_ingot'), '叶绿锭');
  assert.equal(idx.nameOf('kubejs:coolant_bucket'), '天然冷却液桶');
  assert.equal(idx.nameOf('createages:andesite_machine'), '安山机械');
  assert.equal(idx.nameOf('c6c:utility_belt'), '多功能腰带');
  // ★ 最大的坑：createages 既没 modId 认领也没 assets，不能被标成幽灵
  assert.equal(idx._ghostItems.has('createages:andesite_machine'), false);
  assert.equal(idx._ghostItems.has('createages:iron_mechanism'), false);
  assert.equal(idx._ghostItems.has('kubejs:chlorophyte_ingot'), false);
  assert.equal(idx._ghostItems.has('c6c:utility_belt'), false);
  // 返回体字段
  assert.equal(idx.scriptItemCount, 5);
  assert.deepEqual(idx.scriptNamespaces, ['c6c', 'createages', 'kubejs']);
  assert.equal(idx.scriptItems.length, 5);
});

test('没有 kubejs 目录时脚本物品为 0，索引照常', () => {
  const inst = instanceOf([
    {
      'META-INF/mods.toml': 'modId="create"\ndisplayName="Create"\nversion="1"\n',
      'assets/create/lang/en_us.json': JSON.stringify({ 'item.create.cogwheel': 'Cogwheel' }),
      'assets/create/models/item/cogwheel.json': JSON.stringify({ textures: { layer0: 'create:item/cogwheel' } }),
    },
  ]);
  const idx = indexInstance(inst);
  assert.equal(idx.scriptItemCount, 0);
  assert.deepEqual(idx.scriptItems, []);
  assert.equal(idx.has('create:cogwheel'), true);
});

test('幻影方块去重：只有 blockstate 没有手持形态、且同名有真物品时删掉（create:belt 的形状）', () => {
  // 用户报「传送带图标用错」：搜「传送带」出来的是 `create:belt`（放置出来的方块），
  // 它跟真正的 `create:belt_connector`（能拿在手上）同名，但没有任何 item 形态的证据。
  const inst = instanceOf([
    {
      'META-INF/mods.toml': 'modId="create"\ndisplayName="Create"\nversion="1"\n',
      'assets/create/lang/en_us.json': JSON.stringify({
        'item.create.belt_connector': 'Mechanical Belt',
        'block.create.belt': 'Mechanical Belt',
        'block.minecraft.lava': 'Lava',
        'block.minecraft.obsidian': 'Obsidian',
      }),
      // 真正能拿在手上的传送带：有 item 模型 + item 贴图
      'assets/create/models/item/belt_connector.json': JSON.stringify({ textures: { layer0: 'create:item/belt_connector' } }),
      'assets/create/textures/item/belt_connector.png': 'png',
      // 放置出来的那个：只有 blockstate + 方块模型
      'assets/create/blockstates/belt.json': JSON.stringify({ variants: { '': { model: 'create:block/belt/middle' } } }),
      'assets/create/models/block/belt/middle.json': JSON.stringify({ textures: { particle: 'create:block/belt' } }),
      'assets/create/textures/block/belt.png': 'png',
    },
  ]);
  const idx = indexInstance(inst);

  assert.equal(idx.has('create:belt_connector'), true, '能拿在手上的那个必须留着');
  assert.equal(idx.has('create:belt'), false, '同名、又没有 item 形态的方块不能留在物品表里');
  assert.equal(idx.droppedAlias, 1);
  assert.deepEqual(idx.droppedAliases.map((one) => one.id), ['create:belt']);
  assert.equal(idx.droppedAliases[0].aliasOf, 'create:belt_connector');
});

test('幻影方块去重：没有同名真物品的方块要留着（熔岩不能被删，它还要当图标来源）', () => {
  const inst = instanceOf([
    {
      'META-INF/mods.toml': 'modId="minecraft"\ndisplayName="Vanilla"\nversion="1"\n',
      'assets/minecraft/lang/en_us.json': JSON.stringify({
        'block.minecraft.lava': 'Lava',
        'block.minecraft.obsidian': 'Obsidian',
      }),
      'assets/minecraft/blockstates/lava.json': JSON.stringify({ variants: { '': { model: 'minecraft:block/lava' } } }),
      'assets/minecraft/models/block/lava.json': JSON.stringify({ textures: { particle: 'minecraft:block/lava_still' } }),
      'assets/minecraft/blockstates/obsidian.json': JSON.stringify({ variants: { '': { model: 'minecraft:block/obsidian' } } }),
      'assets/minecraft/models/block/obsidian.json': JSON.stringify({ textures: { all: 'minecraft:block/obsidian' } }),
    },
  ]);
  const idx = indexInstance(inst);

  assert.equal(idx.has('minecraft:lava'), true, '熔岩没有同名的手持物品，删了就没法给液体找图标');
  assert.equal(idx.has('minecraft:obsidian'), true);
  assert.equal(idx.droppedAlias, 0);
});

test('幻影方块去重：跨命名空间只是撞名，一个都不能删', () => {
  // 实测踩到：`irons_spellbooks:voidstone` 和 `cataclysm:void_stone` 都叫「虚空石」，
  // 按名字去重会误删一个真物品。
  const inst = instanceOf([
    {
      'META-INF/mods.toml': 'modId="aaa"\ndisplayName="A"\nversion="1"\n',
      'assets/aaa/lang/en_us.json': JSON.stringify({ 'block.aaa.voidstone': 'Void Stone' }),
      'assets/aaa/blockstates/voidstone.json': JSON.stringify({ variants: { '': { model: 'aaa:block/voidstone' } } }),
      'assets/aaa/models/block/voidstone.json': JSON.stringify({ textures: { all: 'aaa:block/voidstone' } }),
    },
    {
      'META-INF/mods.toml': 'modId="bbb"\ndisplayName="B"\nversion="1"\n',
      'assets/bbb/lang/en_us.json': JSON.stringify({ 'item.bbb.void_stone': 'Void Stone' }),
      'assets/bbb/models/item/void_stone.json': JSON.stringify({ textures: { layer0: 'bbb:item/void_stone' } }),
      'assets/bbb/textures/item/void_stone.png': 'png',
    },
  ]);
  const idx = indexInstance(inst);

  assert.equal(idx.has('aaa:voidstone'), true, '不同 mod 的同名方块不该被别家的物品顶掉');
  assert.equal(idx.has('bbb:void_stone'), true);
  assert.equal(idx.droppedAlias, 0);
});

test('lang: item.minecraft.coal_ore 解析成 minecraft:coal_ore，不能切成 minecraft.coal:ore', () => {
  // 坑：命名空间若写成 [a-z0-9_.-]+ 会贪婪回溯，把 1,927 个原版物品切成一堆假 ID
  const r = indexOf({
    'assets/minecraft/lang/en_us.json': JSON.stringify({ 'item.minecraft.coal_ore': 'Coal Ore' }),
  });
  assert.ok(r.items.has('minecraft:coal_ore'));
  assert.equal(r.items.size, 1);
});

test('lang: 变体后缀既不算物品、也不当名字（不再造 minecraft:banner 幽灵 ID）', () => {
  // 2026-10-31 改：以前「段数>3 只取第三段」，会造出 `minecraft:banner` 这种游戏里不存在的物品，
  // 而且在界面里是一行没有图标的空白项。现在只认正名形状（正好 3 段）。
  const r = indexOf({
    'assets/minecraft/lang/en_us.json': JSON.stringify({
      'block.minecraft.banner.base.black': 'Black Banner',
      'item.minecraft.filled_map.monument': 'Monument Map',
    }),
  });
  assert.equal(r.items.size, 0, '变体键不该造物品');
  assert.equal(r.names.size, 0, '变体键也不该给名字');
});

test('lang: 变体键不能盖掉正名（用户反馈「有些物品的中文是错的」的根因）', () => {
  // 实测 Mechanomania：296 个物品被变体键覆盖，277 个名字直接变成 tooltip 原文，例如
  //   block.create.flywheel            = 飞轮
  //   block.create.flywheel.tooltip.summary = 使用壮观的黄铜轮子_装饰_你的_机器_。
  // 以前后者会盖掉前者，界面上「飞轮」显示成一整段说明。
  const r = indexOf({
    'assets/create/lang/zh_cn.json': JSON.stringify({
      'block.create.flywheel': '飞轮',
      'block.create.flywheel.tooltip.summary': '使用壮观的黄铜轮子_装饰_你的_机器_。',
      'block.mynethersdelight.blazier': '烈焰炉',
      'block.mynethersdelight.blazier.too_cold': 'The temperature is too low for this.',
    }),
    'assets/create/lang/en_us.json': JSON.stringify({
      'block.create.flywheel': 'Flywheel',
      'block.create.flywheel.tooltip.summary': 'Decorate your machines.',
      'block.mynethersdelight.blazier': 'Blazier',
      'block.mynethersdelight.blazier.too_cold': 'The temperature is too low for this.',
    }),
  });
  assert.equal(r.names.get('create:flywheel'), '飞轮');
  assert.equal(r.names.get('mynethersdelight:blazier'), '烈焰炉');
  assert.ok(!r.names.get('create:flywheel')?.includes('_'), '中文名里不该出现 tooltip 的 markdown 斜体记号');
});

test('lang: 带 %s 的值不当名字（item.minecraft.firework_rocket 曾被显示成 "%s"）', () => {
  const r = indexOf({
    'assets/minecraft/lang/zh_cn.json': JSON.stringify({
      'item.minecraft.firework_rocket': '%s',
      'item.minecraft.clock': '时钟',
    }),
    'assets/minecraft/lang/en_us.json': JSON.stringify({
      'item.minecraft.firework_rocket': 'Firework Rocket',
      'item.minecraft.clock': 'Clock',
    }),
  });
  // 中文是格式化模板 → 用英文正名兜底；正常的中文名照旧
  assert.equal(r.names.get('minecraft:firework_rocket'), 'Firework Rocket');
  assert.equal(r.names.get('minecraft:clock'), '时钟');
});

test('lang: tooltip 子键不算物品，也不当名字', () => {
  const r = indexOf({
    'assets/create/lang/en_us.json': JSON.stringify({
      'item.create.cogwheel': 'Cogwheel',
      'item.create.cogwheel.tooltip.summary': 'A cog',
    }),
  });
  assert.deepEqual([...r.items], ['create:cogwheel']);
  assert.equal(r.names.get('create:cogwheel'), 'Cogwheel');
});

test('简介：tooltip.summary / desc / tip 都收，markdown 斜体去掉，且只有真物品才留', () => {
  // 用户 2026-10-31 提的「鼠标停在图标条目上要显示物品简介」。
  // 实测 Mechanomania 里简介藏在 *.tooltip.summary(137) / *.desc(104) / *.tip(35) / *.guide(10) 这些长键下。
  const r = indexOf({
    'assets/create/lang/zh_cn.json': JSON.stringify({
      'item.create.cogwheel': '齿轮',
      'item.create.cogwheel.tooltip.summary': '用于_传递旋转_的零件',
      'item.create.cogwheel.tooltip.condition1': '空手右击时',
      'item.create.cogwheel.tooltip.behaviour1': '切换是否_常亮_',
      'item.create.brass_casing': '黄铜机壳',
      'item.create.brass_casing.desc': '外壳',
      // 这条的 ID 不在物品表里（没有对应的名字/模型），不该留下简介
      'item.create.ghost_only_desc.desc': '幽灵物品的说明',
      // %s 是格式化模板，不是简介
      'item.create.brass_casing.tip': '耐久 %s',
    }),
    // ⚠️ 中文语言文件**不造物品** —— 物品 ID 来自 en_us 或模型，所以这里必须有 en_us 才有 create:cogwheel
    'assets/create/lang/en_us.json': JSON.stringify({
      'item.create.cogwheel': 'Cogwheel',
      'item.create.brass_casing': 'Brass Casing',
    }),
  });
  assert.ok(r.items.has('create:cogwheel'));
  assert.equal(r.descriptions.get('create:cogwheel'), '用于传递旋转的零件\n空手右击时：切换是否常亮');
  assert.equal(r.descriptions.get('create:brass_casing'), '外壳');
  assert.ok(!r.descriptions.has('create:ghost_only_desc'), '不在物品表里的 ID 不该留简介');
  assert.ok(!r.descriptions.get('create:brass_casing')?.includes('%s'), '%s 模板不该进简介');
});

test('简介：中文没有就退英文；一个都没有的物品不进简介表', () => {
  const r = indexOf({
    'assets/create/lang/zh_cn.json': JSON.stringify({ 'item.create.shaft': '传动轴' }),
    'assets/create/lang/en_us.json': JSON.stringify({
      'item.create.shaft': 'Shaft',
      'item.create.shaft.tooltip.summary': 'A rotating shaft',
      'item.create.cogwheel': 'Cogwheel',
    }),
    'assets/create/models/item/cogwheel.json': '{}',
  });
  assert.equal(r.descriptions.get('create:shaft'), 'A rotating shaft');
  assert.ok(!r.descriptions.has('create:cogwheel'), '没有说明的物品不该在简介表里');
});

test('models: 子目录是变体，物品只取第一段（package/cardboard_12x10 → create:package）', () => {
  // 坑：实测 create 有 163 个 models/item/<sub>/<variant>.json，全收会造 163 个假 ID
  const r = indexOf({
    'assets/create/models/item/package/cardboard_12x10.json': '{}',
    'assets/create/models/item/cogwheel.json': '{}',
  });
  assert.ok(r.items.has('create:package'));
  assert.ok(r.items.has('create:cogwheel'));
  assert.equal(r.items.size, 2);
});

test('recipes: 单数 recipe/ 与复数 recipes/ 都要收（1.21.1 全是单数）', () => {
  // 坑：只写复数会让源 C 完全静默失效 —— 不报错，只是少掉全部 1 万份配方
  const r = indexOf({
    'data/create/recipe/andesite.json': JSON.stringify({ result: { id: 'create:andesite_alloy' } }),
    'data/create/recipes/brass.json': JSON.stringify({ result: { item: 'create:brass_ingot' } }),
  });
  assert.equal(r.recipes, 2);
  assert.ok(r.items.has('create:andesite_alloy'));
  assert.ok(r.items.has('create:brass_ingot'));
});

test('recipes: results[] 数组写法也要收', () => {
  const r = indexOf({
    'data/minecraft/recipes/foo.json': JSON.stringify({ results: [{ item: 'minecraft:stick' }, { id: 'minecraft:planks' }] }),
  });
  assert.ok(r.items.has('minecraft:stick'));
  assert.ok(r.items.has('minecraft:planks'));
});

test('recipes: result 里不是合法 ID 的字符串要丢掉（实测遇到 canUse:unknown）', () => {
  const r = indexOf({
    'data/curios/recipes/bad.json': JSON.stringify({ result: 'canUse:unknown' }),
  });
  assert.equal(r.items.size, 0);
});

test('损坏的 jar 返回 error 而不是抛异常', () => {
  const r = indexJar(writeTemp(Buffer.from('not a zip at all'), 'broken.jar'));
  assert.ok(r.error.length > 0);
  assert.equal(r.items.size, 0);
});

test('坏掉的语言文件不影响同 jar 内其它文件', () => {
  const r = indexOf({
    'assets/create/lang/en_us.json': '{ this is not json',
    'assets/create/models/item/cogwheel.json': '{}',
  });
  assert.ok(r.items.has('create:cogwheel'));
});

test('blockstates 兜底：无 models/item 时用 blockstates + models/block 补', () => {
  const r = indexOf({
    'assets/create/blockstates/andesite_casing.json': '{}',
    'assets/create/models/block/andesite_casing.json': '{}',
  });
  assert.ok(r.items.has('create:andesite_casing'));
});

test('blockstates 兜底：没有对应 block 模型时不加（避免变体假 ID）', () => {
  const r = indexOf({ 'assets/create/blockstates/ghost.json': '{}' });
  assert.equal(r.items.size, 0);
});

// ---- 原版中文名（assets/objects 那一层）----
//
// 坑：从 1.13 起客户端 jar 里只有 en_us.json，中文被拆成资源包对象放在
// <mcRoot>/assets/objects/<hash前2位>/<hash>，靠 assets/indexes/<id>.json 反查。
// 不读这层，搜「钻石镐」命中 0，搜 diamond 只能看到英文名。

const HASH = 'a'.repeat(40);

/** 造一个带 assets 的假实例目录。 */
function makeAssetsInstance({ withIndex = true, withObject = true, indexId = '17', versionAssetId = '17' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcassets-'));
  const versions = path.join(root, 'versions', 'DemoPack');
  fs.mkdirSync(versions, { recursive: true });
  const versionFile = path.join(versions, 'DemoPack.json');
  fs.writeFileSync(
    versionFile,
    JSON.stringify({ id: 'DemoPack', assetIndex: versionAssetId ? { id: versionAssetId } : undefined }),
  );
  const clientJar = path.join(versions, 'DemoPack.jar');
  fs.writeFileSync(
    clientJar,
    makeZip({
      'assets/minecraft/lang/en_us.json': JSON.stringify({ 'item.minecraft.diamond_pickaxe': 'Diamond Pickaxe' }),
    }),
  );

  if (withIndex) {
    const idxDir = path.join(root, 'assets', 'indexes');
    fs.mkdirSync(idxDir, { recursive: true });
    fs.writeFileSync(
      path.join(idxDir, `${indexId}.json`),
      JSON.stringify({ objects: { 'minecraft/lang/zh_cn.json': { hash: HASH, size: 10 } } }),
    );
  }
  if (withObject) {
    const objDir = path.join(root, 'assets', 'objects', HASH.slice(0, 2));
    fs.mkdirSync(objDir, { recursive: true });
    fs.writeFileSync(path.join(objDir, HASH), JSON.stringify({ 'item.minecraft.diamond_pickaxe': '钻石镐' }));
  }

  return {
    id: 'DemoPack',
    instanceDir: versions,
    mcRoot: root,
    modsDir: path.join(versions, 'mods'),
    versionJsonFile: versionFile,
    clientJar,
    hasClientJar: true,
  };
}

test('assets：从资源包读到原版中文名，盖掉 jar 里的英文名', () => {
  const inst = makeAssetsInstance();
  const idx = indexInstance(inst, { includeClientJar: true });
  assert.ok(idx._items.has('minecraft:diamond_pickaxe'), '物品本身应来自 jar');
  assert.equal(idx._names.get('minecraft:diamond_pickaxe'), '钻石镐');
  assert.equal(idx.assetsNames.zh, 1);
});

test('assets：没有 assets 目录时安静跳过，不影响索引', () => {
  const inst = makeAssetsInstance({ withIndex: false, withObject: false });
  const idx = indexInstance(inst, { includeClientJar: true });
  assert.deepEqual(idx.assetsNames, { zh: 0, en: 0 });
  // 读不到中文就退回 jar 里的英文名，不能变成没名字
  assert.equal(idx._names.get('minecraft:diamond_pickaxe'), 'Diamond Pickaxe');
});

test('assets：索引里有记录但对象文件缺失时不炸', () => {
  const inst = makeAssetsInstance({ withObject: false });
  const idx = indexInstance(inst, { includeClientJar: true });
  assert.deepEqual(idx.assetsNames, { zh: 0, en: 0 });
  assert.equal(idx._names.get('minecraft:diamond_pickaxe'), 'Diamond Pickaxe');
});

test('assets：版本 json 没写 assetIndex 时退化成扫 indexes 目录', () => {
  const inst = makeAssetsInstance({ versionAssetId: '' });
  const idx = indexInstance(inst, { includeClientJar: true });
  assert.equal(idx._names.get('minecraft:diamond_pickaxe'), '钻石镐');
});

test('assets：不抢 mod 自己命名空间的译名', () => {
  const inst = makeAssetsInstance();
  // 往 mods 里塞一个 mod，自己给了中文名
  const modsDir = path.join(inst.instanceDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(
    path.join(modsDir, 'demo.jar'),
    makeZip({
      'META-INF/neoforge.mods.toml': 'modId="demo"\ndisplayName="Demo"\nversion="1.0"\n',
      'assets/minecraft/lang/zh_cn.json': JSON.stringify({ 'item.minecraft.diamond_pickaxe': '模组改的镐子' }),
    }),
  );
  const idx = indexInstance(inst, { includeClientJar: true });
  // minecraft: 命名空间以资源包官方译名为准
  assert.equal(idx._names.get('minecraft:diamond_pickaxe'), '钻石镐');
});

// —— 物品表去重（2026-11-05 用户报「第 19 页看到 7 个钻石胸甲」）——

test('盔甲纹饰变体不算独立物品：有本体、没译名的 _trim 假 ID 要删', () => {
  const inst = instanceOf([
    {
      'assets/demo/lang/en_us.json': JSON.stringify({
        'item.demo.diamond_chestplate': '钻石胸甲',
        // 这个纹饰变体自己带译名 → 说明是真注册的物品，不能删
        'item.demo.diamond_chestplate_netherite_trim': '特别版胸甲',
      }),
      'assets/demo/models/item/diamond_chestplate.json': JSON.stringify({ parent: 'item/generated' }),
      'assets/demo/models/item/diamond_chestplate_gold_trim.json': '{}',
      'assets/demo/models/item/diamond_chestplate_diamond_darker_trim.json': '{}',
      'assets/demo/models/item/diamond_chestplate_netherite_trim.json': '{}',
    },
  ]);
  const idx = indexInstance(inst, { includeClientJar: false });
  assert.equal(idx.has('demo:diamond_chestplate'), true, '本体不能动');
  assert.equal(idx.has('demo:diamond_chestplate_gold_trim'), false, '无译名的纹饰变体该删');
  assert.equal(
    idx.has('demo:diamond_chestplate_diamond_darker_trim'),
    false,
    '`_diamond_darker_trim` 要去两段才认得出来',
  );
  assert.equal(idx.has('demo:diamond_chestplate_netherite_trim'), true, '有译名的纹饰是真物品，别删');
  assert.ok(idx.droppedTrim >= 2);
});

test('盔甲纹饰变体：找不到本体的不要乱删（可能是另一个 mod 的独立物品）', () => {
  const inst = instanceOf([
    {
      'assets/demo/lang/en_us.json': JSON.stringify({ 'item.demo.orphan_gold_trim': '孤儿' }),
      'assets/demo/models/item/orphan_gold_trim.json': '{}',
    },
  ]);
  const idx = indexInstance(inst, { includeClientJar: false });
  assert.equal(idx.has('demo:orphan_gold_trim'), true);
  assert.equal(idx.droppedTrim, 0);
});

test('原版改名残留清掉：只有 lang 键、连模型都没有的 minecraft ID 不算物品', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mclegacy-'));
  const versions = path.join(root, 'versions', 'DemoPack');
  const modsDir = path.join(versions, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const clientJar = path.join(versions, 'DemoPack.jar');
  fs.writeFileSync(
    clientJar,
    makeZip({
      'assets/minecraft/lang/en_us.json': JSON.stringify({
        'item.minecraft.diamond_pickaxe': 'Diamond Pickaxe',
        'item.minecraft.scute': 'Scute',
        'item.minecraft.milk': 'Milk',
      }),
      'assets/minecraft/models/item/diamond_pickaxe.json': '{}',
    }),
  );
  const inst = {
    id: 'DemoPack',
    instanceDir: versions,
    mcRoot: root,
    modsDir,
    hasClientJar: true,
    clientJar,
    versionJsonPath: path.join(versions, 'DemoPack.json'),
  };
  const idx = indexInstance(inst, { includeClientJar: true });
  assert.equal(idx.has('minecraft:diamond_pickaxe'), true, '有模型的真物品不能删');
  assert.equal(idx.has('minecraft:scute'), false, '1.21 改叫 turtle_scute 了');
  assert.equal(idx.has('minecraft:milk'), false, '牛奶一直是 milk_bucket');
  assert.equal(idx.droppedLegacyCount, 2);
});

test('原版改名残留：客户端 jar 是个空壳（一个模型都没有）时整条规则跳过', () => {
  // 防止「用户把客户端 jar 抽走了」的时候把原版物品全删光
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mclegacy2-'));
  const versions = path.join(root, 'versions', 'DemoPack');
  const modsDir = path.join(versions, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const clientJar = path.join(versions, 'DemoPack.jar');
  fs.writeFileSync(
    clientJar,
    makeZip({
      'assets/minecraft/lang/en_us.json': JSON.stringify({ 'item.minecraft.scute': 'Scute' }),
    }),
  );
  const inst = {
    id: 'DemoPack',
    instanceDir: versions,
    mcRoot: root,
    modsDir,
    hasClientJar: true,
    clientJar,
    versionJsonPath: path.join(versions, 'DemoPack.json'),
  };
  const idx = indexInstance(inst, { includeClientJar: true });
  assert.equal(idx.has('minecraft:scute'), true, '没有模型证据时不该乱删');
  assert.equal(idx.droppedLegacyCount, 0);
});

// —— 模型动画帧去重（2026-11-05 用户报「钟、指针会有多个物品」）——

test('动画帧不算独立物品：模型 overrides 引用到的兄弟模型该删', () => {
  const inst = instanceOf([
    {
      'assets/demo/lang/en_us.json': JSON.stringify({ 'item.demo.clock': '时钟' }),
      'assets/demo/models/item/clock.json': JSON.stringify({
        parent: 'item/generated',
        textures: { layer0: 'item/clock_00' },
        overrides: [
          { predicate: { time: 0 }, model: 'item/clock' },
          { predicate: { time: 0.0078125 }, model: 'item/clock_01' },
          { predicate: { time: 0.015625 }, model: 'item/clock_63' },
        ],
      }),
      'assets/demo/models/item/clock_01.json': '{}',
      'assets/demo/models/item/clock_63.json': '{}',
      'assets/demo/models/item/compass.json': JSON.stringify({
        parent: 'item/generated',
        textures: { layer0: 'item/compass_16' },
        overrides: [
          { predicate: { time: 0 }, model: 'item/compass' },
          { predicate: { time: 0.0078125 }, model: 'item/compass_00' },
          { predicate: { time: 0.015625 }, model: 'item/compass_31' },
        ],
      }),
      'assets/demo/models/item/compass_00.json': '{}',
      'assets/demo/models/item/compass_31.json': '{}',
    },
  ]);
  const idx = indexInstance(inst, { includeClientJar: false });
  assert.equal(idx.has('demo:clock'), true, '本体不能动');
  assert.equal(idx.has('demo:compass'), true, '本体不能动');
  assert.equal(idx.has('demo:clock_01'), false, '指针角度帧该删');
  assert.equal(idx.has('demo:clock_63'), false);
  assert.equal(idx.has('demo:compass_00'), false);
  assert.equal(idx.has('demo:compass_31'), false);
  assert.equal(idx.droppedFrame, 4);
});

test('动画帧：有译名的真变体、找不到本体的编号物品都不能乱删', () => {
  const inst = instanceOf([
    {
      'assets/demo/lang/en_us.json': JSON.stringify({
        'item.demo.screen': '任务屏幕',
        'item.demo.screen_1': '任务屏幕 1×1',
        'item.demo.screen_3': '任务屏幕 3×3',
        'item.demo.seastone_1': '雕纹蔚蓝海石(斯库拉 1)',
      }),
      'assets/demo/models/item/screen.json': '{}',
      'assets/demo/models/item/screen_1.json': '{}',
      'assets/demo/models/item/screen_3.json': '{}',
      'assets/demo/models/item/seastone_1.json': '{}',
      // 本体不在表里：这种编号物品不该猜成动画帧
      'assets/demo/models/item/vigor_bow_pulling_0.json': '{}',
      'assets/demo/models/item/vigor_bow_pulling_2.json': '{}',
    },
  ]);
  const idx = indexInstance(inst, { includeClientJar: false });
  assert.equal(idx.has('demo:screen_1'), true, '有译名的是真物品');
  assert.equal(idx.has('demo:screen_3'), true);
  assert.equal(idx.has('demo:seastone_1'), true, '有译名、本体不在表也保留');
  assert.equal(idx.has('demo:vigor_bow_pulling_0'), true, '本体不在表不乱删');
  assert.equal(idx.has('demo:vigor_bow_pulling_2'), true);
  assert.equal(idx.droppedFrame, 0);
});

// 2026-11-06：旧判据（「_数字 + 无译名 + 本体在表」）把游戏里真注册的物品整片删掉了。
// 实测 `kaleidoscope_doll:doll_0`…`doll_639` 在游戏 ITEM 注册表里真有 640 条、
// JEI 里也全部可见，可它们没有 `item.` 前缀的翻译键（旧判据据此全删了，误删 631 个）。
test('动画帧：没有译名的独立编号物品不能当成帧删掉（2026-11-06 真 bug）', () => {
  const inst = instanceOf([
    {
      // 语言文件里全是数字键（不是 item. 前缀），所以读不到译名
      'assets/demo/lang/en_us.json': JSON.stringify({ '0': 'Doll 0', '1': 'Doll 1' }),
      'assets/demo/models/item/doll.json': '{}',
      'assets/demo/models/item/doll_0.json': '{}',
      'assets/demo/models/item/doll_1.json': '{}',
    },
  ]);
  const idx = indexInstance(inst, { includeClientJar: false });
  assert.equal(idx.has('demo:doll_0'), true, '游戏里真注册的编号物品不能删');
  assert.equal(idx.has('demo:doll_1'), true);
  assert.equal(idx.droppedFrame, 0);
});

test('动画帧：动画本体的兄弟模型（本体带 overrides）该删', () => {
  const inst = instanceOf([
    {
      'assets/demo/models/item/gauge.json': JSON.stringify({
        parent: 'item/generated',
        overrides: [{ predicate: { time: 0 }, model: 'item/gauge_0' }],
      }),
      'assets/demo/models/item/gauge_0.json': '{}',
      'assets/demo/models/item/gauge_1.json': '{}',
    },
  ]);
  const idx = indexInstance(inst, { includeClientJar: false });
  assert.equal(idx.has('demo:gauge_0'), false, '被 overrides 引用的该删');
  assert.equal(idx.has('demo:gauge_1'), false, '动画本体的兄弟该删');
  assert.equal(idx.droppedFrame, 2);
});

test('动画帧：overrides 引用子目录变体时不能把本体当成帧（2026-11-06）', () => {
  const inst = instanceOf([
    {
      'assets/demo/lang/en_us.json': JSON.stringify({ 'item.demo.package': '包裹' }),
      // 真实包里的 create:package 就是这么写的：overrides 指向 item/package/cardboard_12x10
      'assets/demo/models/item/package.json': JSON.stringify({
        parent: 'item/generated',
        overrides: [{ predicate: { custom_model_data: 12 }, model: 'item/package/cardboard_12x10' }],
      }),
    },
  ]);
  const idx = indexInstance(inst, { includeClientJar: false });
  assert.equal(idx.has('demo:package'), true, '子目录变体引用不该动本体');
  assert.equal(idx.droppedFrame, 0);
});

// 2026-11-06：很多 mod 把别的 mod 整个塞进 `META-INF/jarjar/xxx.jar`（ForgeJarJar 机制）。
// 那些内嵌 mod 的物品在游戏里**真实存在**（实测 Mechanomania：simulated 86 个、
// aeronautics 46 个、offroad 7 个、l2magic 4 个、pandora 2 个 = 145 个），
// 我们以前只扫顶层 jar → 全漏掉，还会被「幽灵物品」规则误删。
test('jarjar 内嵌 mod 的物品要算进来（2026-11-06 真缺口）', () => {
  const inner = makeZip({
    'assets/simulated/models/item/sim_seat.json': JSON.stringify({ textures: { layer0: 'simulated:item/sim_seat' } }),
    'assets/simulated/lang/en_us.json': JSON.stringify({ 'item.simulated.sim_seat': 'Sim Seat' }),
    'assets/simulated/textures/item/sim_seat.png': 'png',
  });
  const inst = instanceOf([
    {
      'META-INF/mods.toml': 'modId="bundle"\ndisplayName="Bundle"\nversion="1"\n',
      'META-INF/jarjar/simulated-neoforge-1.21.1.jar': inner,
    },
  ]);
  const idx = indexInstance(inst, { includeClientJar: false });
  assert.equal(idx.has('simulated:sim_seat'), true, '内嵌 mod 的物品要进索引');
  assert.equal(idx.nameOf('simulated:sim_seat'), 'Sim Seat', '内嵌 mod 的语言文件也要读');
  assert.equal(idx._ghostItems.has('simulated:sim_seat'), false,
    '内嵌 mod 的命名空间要被认领，否则会被幽灵规则删掉');
});

test('jarjar 内嵌 mod 的命名空间归属外层 mod（来源可追溯）', () => {
  const inner = makeZip({
    'assets/l2magic/models/item/ai_wand.json': '{}',
    'assets/l2magic/lang/zh_cn.json': JSON.stringify({ 'item.l2magic.ai_wand': 'AI 魔杖' }),
  });
  const inst = instanceOf([
    {
      'META-INF/mods.toml': 'modId="l2hostility"\ndisplayName="L2"\nversion="1"\n',
      'META-INF/jarjar/l2magic-3.0.2.jar': inner,
    },
  ]);
  const idx = indexInstance(inst, { includeClientJar: false });
  assert.equal(idx.has('l2magic:ai_wand'), true);
  assert.equal(idx.nameOf('l2magic:ai_wand'), 'AI 魔杖', '内层的中文名也要读');
  assert.deepEqual(idx.lookup('l2magic:ai_wand').from, ['l2hostility'],
    '内层物品的来源记外层 modId');
});

test('jarjar 内嵌的纯代码库（没有物品资源）不能造出假物品', () => {
  const inner = makeZip({
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n',
    'com/example/Lib.class': 'x',
  });
  const inst = instanceOf([
    {
      'META-INF/mods.toml': 'modId="bundle"\ndisplayName="Bundle"\nversion="1"\n',
      'META-INF/jarjar/just-a-lib.jar': inner,
    },
  ]);
  const idx = indexInstance(inst, { includeClientJar: false });
  assert.equal(idx.itemCount, 0, '纯代码库不该造出任何物品');
});
