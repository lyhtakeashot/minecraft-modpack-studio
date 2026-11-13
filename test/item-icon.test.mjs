/**
 * 物品图标的解析测试。
 *
 * 这里造的是「真实形状」的假包：一个 jar 里放 textures/item、textures/block、models/item，
 * 一个原版 mcRoot 里放 assets/indexes + assets/objects —— 全都是 MC 真正的目录结构，
 * 因为这套逻辑最容易错的地方就是「路径拼错了但没人报」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeZip } from './make-zip.mjs';
import { encodePng } from '../packages/core/png-frame.js';
import {
  ICON_LIMIT,
  buildTextureIndex,
  iconCacheSizes,
  normalizeItemId,
  resetIconCaches,
  resolveIcons,
} from '../packages/core/item-icon.js';

/** 1x1 的透明 PNG，够用来验「读出来的是 PNG 字节而不是文本」。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// 上面那张 PNG 的 alpha 是 127（半透明），等轴测渲染会按「透明不画」跳过它，
// 所以「要真的画出形状」的用例必须用一张不透明的贴图。
const PNG_OPAQUE = encodePng(4, 4, Buffer.alloc(4 * 4 * 4, 255));

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcstudio-icon-${tag}-`));
}

/** 造一个「整合包」：mods/ 若干 jar + 客户端本体 jar + mcRoot 的原版资源对象。 */
function makePack() {
  const root = tmpdir('pack');
  const instanceDir = path.join(root, 'versions', 'DemoPack');
  const modsDir = path.join(instanceDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  // 一个 mod：直接有贴图 + 一个「贴图名字和物品名不一样」的走模型反查 + 液体
  fs.writeFileSync(path.join(modsDir, 'create-1.21.1-6.0.10.jar'), makeZip({
    'META-INF/mods.toml': 'modId="create"\ndisplayName="Create"\nversion="6.0.10"\n',
    'assets/create/textures/item/cogwheel.png': PNG,
    'assets/create/textures/block/water_wheel.png': PNG,
    'assets/create/models/item/gearbox.json': JSON.stringify({ textures: { layer0: 'create:item/gearbox_tex' } }),
    'assets/create/textures/item/gearbox_tex.png': PNG,
    'assets/create/models/item/broken_parent.json': JSON.stringify({ parent: 'create:block/nope_cube' }),
    // 液体：贴图叫 honey_still / honey_flow，物品 ID 却是 create:honey
    'assets/create/textures/fluid/honey_still.png': PNG,
    'assets/create/textures/fluid/honey_flow.png': PNG,
    'assets/create/textures/fluid/honey_still.png.mcmeta': '{"animation":{"frametime":2}}',
    // 故意只给 chocolate 的 _flow、不给 _still：没有 still 时就该退到 flow
    'assets/create/textures/fluid/chocolate_flow.png': PNG,
  }));

  // 另一个 mod：故意让「同名」出现两次，验证只认第一份（先扫到的）
  fs.mkdirSync(path.join(modsDir, 'disabled'), { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'aaa-other-1.0.jar'), makeZip({
    'META-INF/mods.toml': 'modId="other"\ndisplayName="Other"\nversion="1.0"\n',
    'assets/other/textures/item/cogwheel.png': PNG,
  }));

  // 第三个 mod：方块物品的模型/贴图全在 block 下，物品名和贴图名对不上。
  // 真实例子是 kaleidoscope_doll（一个包缺 400 多个图标）。
  fs.writeFileSync(path.join(modsDir, 'kdoll-1.0.jar'), makeZip({
    'META-INF/mods.toml': 'modId="kdoll"\ndisplayName="KDoll"\nversion="1.0"\n',
    // 物品模型 → parent 指到 block 模型 → 贴图只在 block 模型里
    'assets/kdoll/models/item/doll_0.json': JSON.stringify({ parent: 'kdoll:block/doll/doll_0' }),
    'assets/kdoll/models/block/doll/doll_0.json': JSON.stringify({ textures: { layer0: 'kdoll:block/doll_0_tex' } }),
    'assets/kdoll/textures/block/doll_0_tex.png': PNG,
    // 只有 block 模型，压根没有 item 模型、也没有同名的 item 贴图
    'assets/kdoll/models/block/doll_machine.json': JSON.stringify({ textures: { layer0: 'kdoll:block/doll_machine_tex' } }),
    'assets/kdoll/textures/block/doll_machine_tex.png': PNG,
    // 模型有、贴图没有：应该如实进 missing，不能编一张图出来
    'assets/kdoll/models/block/ghost.json': JSON.stringify({ textures: { layer0: 'kdoll:block/ghost_tex' } }),
    // 真实形状（kaleidoscope_doll 的玩偶模型）：贴图键不叫 layer0，
    // 而且 particle 指的 `block/glass` 在这个 jar 里不存在 —— 第一个候选落空时要继续往下试
    'assets/kdoll/models/item/doll_multi.json': JSON.stringify({ parent: 'kdoll:block/doll_multi' }),
    'assets/kdoll/models/block/doll_multi.json': JSON.stringify({
      textures: { 0: 'kdoll:block/doll_multi_tex', particle: 'block/glass' },
    }),
    'assets/kdoll/textures/block/doll_multi_tex.png': PNG,
    // 模型在自己的 jar 里，贴图却指向客户端 jar 里的原版贴图
    'assets/kdoll/models/item/doll_vanilla.json': JSON.stringify({ parent: 'kdoll:block/doll_vanilla' }),
    'assets/kdoll/models/block/doll_vanilla.json': JSON.stringify({ textures: { layer0: 'minecraft:block/tnt_side' } }),
    // 传送带（create:belt 的真实形状）：一条平铺贴图 + 一堆零件模型，
    // 既没有 item 模型也没有同名 block 模型 —— 拿那条条纹当图标就是错的
    'assets/kdoll/textures/block/belt.png': PNG,
    'assets/kdoll/models/block/belt/middle.json': JSON.stringify({ textures: { particle: 'kdoll:block/belt' } }),
    'assets/kdoll/models/block/belt/start.json': JSON.stringify({ textures: { particle: 'kdoll:block/belt' } }),
  }));

  // 第四个 mod：贴图只挂在 blockstate 指的模型上（`create:rope` 的真实形状）：
// 既没有 textures/item/rope.png，也没有 models/block/rope.json，
// 只有 blockstates/rope.json → models/block/rope_pulley/rope.json → textures/block/pulley_rope.png。
fs.writeFileSync(path.join(modsDir, 'ropey-1.0.jar'), makeZip({
  'META-INF/mods.toml': 'modId="ropey"\ndisplayName="Ropey"\nversion="1.0"\n',
  'assets/ropey/blockstates/rope.json': JSON.stringify({
    variants: { '': { model: 'ropey:block/rope_pulley/rope' } },
  }),
  'assets/ropey/models/block/rope_pulley/rope.json': JSON.stringify({
    textures: { particle: 'ropey:block/pulley_rope' },
  }),
  'assets/ropey/textures/block/pulley_rope.png': PNG,
  // 零件模型里同时挂着「一块石头」和「漏斗本体」：必须挑名字更像的那个
  'assets/ropey/blockstates/andesite_funnel.json': JSON.stringify({
    variants: { 'facing=north': { model: 'ropey:block/funnel/andesite_funnel' } },
  }),
  'assets/ropey/models/block/funnel/andesite_funnel.json': JSON.stringify({
    textures: { andesite: 'ropey:block/andesite_block', particle: 'ropey:block/funnel/andesite_funnel' },
  }),
  'assets/ropey/textures/block/andesite_block.png': PNG,
  'assets/ropey/textures/block/funnel/andesite_funnel.png': PNG,
  // 一个词根都对不上：宁可不出图，也不能拿石头冒充
  'assets/ropey/blockstates/mystery_torch.json': JSON.stringify({
    variants: { '': { model: 'ropey:block/plain_thing' } },
  }),
  'assets/ropey/models/block/plain_thing.json': JSON.stringify({ textures: { all: 'ropey:block/plain_stone' } }),
  'assets/ropey/textures/block/plain_stone.png': PNG,
  // 有 elements 的方块模型：能整张等轴测画出来（JEI 就是这么显示的），不该再画字母方块
  'assets/ropey/blockstates/chain_rope.json': JSON.stringify({
    variants: { '': { model: 'ropey:block/rope_pulley/chain' } },
  }),
  'assets/ropey/models/block/rope_pulley/chain.json': JSON.stringify({
    textures: { all: 'ropey:block/chain_tex' },
    elements: [
      { from: [6, 0, 6], to: [10, 16, 10], faces: { up: { texture: '#all' }, east: { texture: '#all' }, south: { texture: '#all' } } },
    ],
  }),
  'assets/ropey/textures/block/chain_tex.png': PNG_OPAQUE,
  // 画布告示牌：墙上的那种要借用手持的那种
  'assets/ropey/textures/item/white_canvas_sign.png': PNG,
}));

// 客户端本体 jar：原版方块物品的贴图和父模型全在这里，真实包必须靠它。
  // 注意别往里放 apple/stone —— 那是给「assets/objects 兜底」那条用例留着的。
  const clientJar = path.join(instanceDir, 'DemoPack.jar');
  fs.writeFileSync(clientJar, makeZip({
    'assets/minecraft/textures/block/tnt_side.png': PNG,
    'assets/minecraft/textures/block/tnt_top.png': PNG,
    'assets/minecraft/textures/item/diamond.png': PNG,
    'assets/minecraft/models/item/tnt.json': JSON.stringify({ parent: 'minecraft:block/tnt' }),
    'assets/minecraft/models/block/tnt.json': JSON.stringify({
      textures: { particle: 'block/tnt_side', down: 'block/tnt_top', up: 'block/tnt_side', side: 'block/tnt_side' },
    }),
    // 真·方块模型（带 elements）：应当整张等轴测画出来，而不是挑一张贴图
    'assets/minecraft/models/item/render_cube.json': JSON.stringify({ parent: 'minecraft:block/render_cube' }),
    'assets/minecraft/models/block/render_cube.json': JSON.stringify({
      textures: { all: 'block/render_cube' },
      elements: [
        { from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all' }, east: { texture: '#all' }, south: { texture: '#all' } } },
      ],
    }),
    'assets/minecraft/textures/block/render_cube.png': PNG_OPAQUE,
    // 液体：水/岩浆的贴图叫 xxx_still，物品 ID 却叫 water / lava
    'assets/minecraft/textures/block/water_still.png': PNG,
    'assets/minecraft/textures/block/lava_still.png': PNG,
  }));

  // 原版资源：贴图不在 jar 里，要在 assets/objects/<前2位>/<hash> 里
  const mcRoot = path.join(root, 'mcroot');
  const objectsDir = path.join(mcRoot, 'assets', 'objects');
  const hash = 'ab'.repeat(20);
  fs.mkdirSync(path.join(objectsDir, hash.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(objectsDir, hash.slice(0, 2), hash), PNG);
  fs.mkdirSync(path.join(mcRoot, 'assets', 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(mcRoot, 'assets', 'indexes', '17.json'), JSON.stringify({
    objects: {
      'minecraft/textures/item/apple.png': { hash, size: PNG.length },
      'minecraft/textures/block/stone.png': { hash, size: PNG.length },
      // 坏 hash 要被忽略，不能拿来拼路径
      'minecraft/textures/item/broken.png': { hash: 'not-a-hash', size: 1 },
    },
  }));

  const versionDir = path.join(mcRoot, 'versions', '1.21.1');
  fs.mkdirSync(versionDir, { recursive: true });
  const versionJsonFile = path.join(versionDir, '1.21.1.json');
  fs.writeFileSync(versionJsonFile, JSON.stringify({ id: '1.21.1', assetIndex: { id: '17' } }));

  return {
    root,
    clientJar,
    instance: { id: 'DemoPack', mcRoot, instanceDir, modsDir, versionJsonFile, clientJar },
  };
}

test('normalizeItemId：补命名空间、拒绝非法字符', () => {
  assert.equal(normalizeItemId('cogwheel'), 'minecraft:cogwheel');
  assert.equal(normalizeItemId('Create:CogWheel'), 'create:cogwheel', 'MC 的物品 ID 全小写，用户输入的大小写要归一');
  assert.equal(normalizeItemId('  minecraft:apple  '), 'minecraft:apple');
  assert.equal(normalizeItemId(''), '');
  assert.equal(normalizeItemId(null), '');
  assert.equal(normalizeItemId('bad ns:thing'), '', '命名空间里有空格必须拒掉，否则会拼出奇怪路径');
  assert.equal(normalizeItemId('create:'), '');
});

test('建索引：扫 jar 里的贴图和模型，不碰 disabled 目录', () => {
  resetIconCaches();
  const { instance } = makePack();
  const index = buildTextureIndex(instance.modsDir);

  assert.equal(index.jars, 4, 'mods 目录里四个 .jar 都要算进来（disabled/ 里那个不算，客户端 jar 这次没传 extraJars 也不算）');
  assert.ok(index.byId.has('create:cogwheel'));
  assert.ok(index.byId.has('create:water_wheel'), '方块贴图也要收');
  assert.ok(index.byId.has('create:honey_still'), 'fluid 目录的贴图也要进索引');
  assert.ok(!index.byId.has('other:cogwheel') || index.byId.get('create:cogwheel'),
    '同名物品只保留先扫到的那一份');
  assert.ok(index.modelsById.has('create:gearbox'), '模型要单独建一份表');
  assert.ok(index.blockModelsById.has('kdoll:doll/doll_0'), 'block 模型也要单独建一份表');
  assert.ok(index.blockModelsById.has('kdoll:doll_machine'));
  assert.ok(index.blockModelDirs.has('kdoll:belt'), '目录形式的零件模型要单独记一份目录表');
  assert.ok(index.stillById.has('create:honey'), '液体兜底表：honey 要指到 honey_still');
  assert.match(index.stillById.get('create:honey').entry, /fluid\/honey_still\.png/);
  assert.match(index.stillById.get('create:chocolate').entry, /fluid\/chocolate_flow\.png/,
    '只有 _flow 的液体也要能兜住');
  assert.ok(index.textures >= 3);
});

test('索引：extraJars 里的 jar 也要进索引，缓存键要区分带不带', () => {
  resetIconCaches();
  const { instance } = makePack();
  const plain = buildTextureIndex(instance.modsDir);
  assert.ok(!plain.byId.has('minecraft:diamond'), '没传 extraJars 时不该有客户端 jar 的贴图');

  const withClient = buildTextureIndex(instance.modsDir, { extraJars: [instance.clientJar] });
  assert.ok(withClient.byId.has('minecraft:diamond'), '带上客户端 jar 后要能看到它的 textures/item');
  assert.ok(withClient.modelsById.has('minecraft:tnt'), '客户端 jar 里的 models/item 也要进索引');
  assert.ok(withClient.stillById.has('minecraft:water'), '客户端 jar 里的 water_still 要登记成 minecraft:water');
  assert.equal(withClient.jars, plain.jars + 1, '客户端 jar 也算一个 jar');
  assert.deepEqual(withClient.extraJars, [instance.clientJar]);

  // 再取一次还得是带客户端 jar 的那份 —— 缓存键里必须算上 extraJars
  const again = buildTextureIndex(instance.modsDir, { extraJars: [instance.clientJar] });
  assert.ok(again.byId.has('minecraft:diamond'), '缓存不能把「没带客户端 jar」的索引命中回来');
  assert.ok(again === withClient, '参数一样应该直接命中缓存');
});

test('解析图标：直接命中 / 方块贴图 / 模型反查 三种都能出来', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['create:cogwheel', 'create:water_wheel', 'create:gearbox']);

  assert.equal(r.missing.length, 0, `这三个都该找到，缺的是：${r.missing.join(',')}`);
  for (const id of ['create:cogwheel', 'create:water_wheel', 'create:gearbox']) {
    const icon = r.icons.get(id);
    assert.ok(icon, `缺 ${id}`);
    assert.match(icon.dataUrl, /^data:image\/png;base64,/, `${id} 要回 data URL`);
    assert.equal(Buffer.from(icon.dataUrl.split(',')[1], 'base64').subarray(1, 4).toString(), 'PNG',
      `${id} 解出来的应该是真 PNG`);
  }
  assert.match(r.icons.get('create:cogwheel').source, /create-1\.21\.1-6\.0\.10\.jar/,
    'source 要说清是哪个 jar 的哪个条目，出问题好查');
});

test('原版物品：贴图在 assets/objects 里也能读出来', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['minecraft:apple', 'minecraft:stone']);

  assert.ok(r.icons.get('minecraft:apple'), '原版物品要走资源索引 + 对象存储');
  assert.match(r.icons.get('minecraft:apple').source, /原版资源 item\/apple\.png/);
  assert.ok(r.icons.get('minecraft:stone'), '方块贴图名也算');
});

test('找不到就如实报 missing，不编一个假图标', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['create:definitely_not_here', 'minecraft:broken']);

  assert.equal(r.icons.size, 0);
  assert.deepEqual(r.missing.sort(), ['create:definitely_not_here', 'minecraft:broken']);
});

test('第二次同一批全部命中缓存，不再读 jar', () => {
  resetIconCaches();
  const { instance } = makePack();
  resolveIcons(instance, ['create:cogwheel']);
  const before = iconCacheSizes().icons;
  const again = resolveIcons(instance, ['create:cogwheel', 'create:cogwheel']);

  assert.equal(again.icons.size, 1, '同一个 ID 传两遍只算一个');
  assert.equal(iconCacheSizes().icons, before, '缓存条数不该增长');
  assert.ok(again.elapsedMs <= 50, '命中缓存应该是毫秒级');
});

test('数量上限：一次要太多只取前 ICON_LIMIT 个', () => {
  resetIconCaches();
  const { instance } = makePack();
  const ids = Array.from({ length: ICON_LIMIT + 10 }, (_, i) => `minecraft:fake_${i}`);
  const r = resolveIcons(instance, ids, { limit: ICON_LIMIT });
  assert.equal(r.missing.length, ICON_LIMIT, '超出上限的连 missing 都不该有，直接不处理');
});

test('mods 目录不存在也不炸（纯原版包）', () => {
  resetIconCaches();
  const { instance } = makePack();
  const gone = { ...instance, modsDir: path.join(instance.mcRoot, 'nope') };
  const r = resolveIcons(gone, ['minecraft:apple']);
  assert.ok(r.icons.get('minecraft:apple'), '没有 mods 也该能读原版图标');
});

test('液体①：textures/fluid/<名字>_still.png 能当物品图标', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['create:honey']);

  const icon = r.icons.get('create:honey');
  assert.ok(icon, `create:honey 该有图标，缺的是：${r.missing.join(',')}`);
  assert.match(icon.dataUrl, /^data:image\/png;base64,/);
  assert.match(icon.source, /create-1\.21\.1-6\.0\.10\.jar → assets\/create\/textures\/fluid\/honey_still\.png/,
    '要取 _still 那一帧（同时存在 _flow 时 still 优先），并且让 source 看得出走的是哪条路');

  // 只有 _flow、没有 _still 的液体也要兜住
  const r2 = resolveIcons(instance, ['create:chocolate']);
  const choco = r2.icons.get('create:chocolate');
  assert.ok(choco, 'chocolate 只有 _flow，也该出图');
  assert.match(choco.source, /fluid\/chocolate_flow\.png/);
});

test('液体②：textures/block/<名字>_still.png 能解析（水/岩浆）', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['minecraft:water', 'minecraft:lava']);

  assert.deepEqual(r.missing, [], `水和岩浆都该有图，缺的是：${r.missing.join(',')}`);
  for (const [id, name] of [['minecraft:water', 'water_still'], ['minecraft:lava', 'lava_still']]) {
    const icon = r.icons.get(id);
    assert.match(icon.dataUrl, /^data:image\/png;base64,/, `${id} 要回 data URL`);
    assert.match(icon.source, new RegExp(`DemoPack\\.jar → assets/minecraft/textures/block/${name}\\.png`),
      `${id} 的水/岩浆贴图在客户端 jar 里`);
  }
});

test('客户端 jar：extraJars 提供的 textures/item 与 models/item 都能出图标', () => {
  resetIconCaches();
  const { instance } = makePack();
  // 调用方不传 extraJars：resolveIcons 应该自己去用 instance.clientJar
  const r = resolveIcons(instance, ['minecraft:diamond', 'minecraft:tnt']);

  assert.deepEqual(r.missing, [], `客户端 jar 里的东西该能取到，缺的是：${r.missing.join(',')}`);
  assert.match(r.icons.get('minecraft:diamond').source,
    /DemoPack\.jar → assets\/minecraft\/textures\/item\/diamond\.png/, '直接同名贴图');
  assert.match(r.icons.get('minecraft:tnt').source,
    /DemoPack\.jar → assets\/minecraft\/textures\/block\/tnt_side\.png/,
    'tnt 走 models/item/tnt.json → block/tnt → 贴图，贴图在客户端 jar 里');
});

test('方块外观不当物品图标：没有 item 模型的物品如实进 missing', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['kdoll:doll_machine', 'kdoll:doll_0']);

  // doll_machine 只有 models/block/doll_machine.json —— 那是「放置出来的方块」的样子，
  // 用户明确要求「只显示拿在手上的物品图标」，所以宁可不给图
  assert.equal(r.icons.has('kdoll:doll_machine'), false, '只有 block 模型的不能拿来当物品图标');
  assert.deepEqual(r.missing, ['kdoll:doll_machine']);

  // doll_0 有 item 模型（哪怕只是一行 parent），顺着 parent 追到 block 模型里的贴图 —— 这是 JEI 的画法
  assert.match(r.icons.get('kdoll:doll_0').source,
    /assets\/kdoll\/textures\/block\/doll_0_tex\.png/,
    'item 模型 parent 指到 block 模型，贴图在那边，要顺着追过去');
});

test('模型里第一个贴图候选落空时，继续试下一个（kaleidoscope_doll 的真实形状）', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['kdoll:doll_multi']);

  const icon = r.icons.get('kdoll:doll_multi');
  assert.ok(icon, `该出图，缺的是：${r.missing.join(',')}`);
  assert.match(icon.source, /assets\/kdoll\/textures\/block\/doll_multi_tex\.png/,
    'particle 指的 block/glass 在 jar 里没有，要退到第 2 个候选（贴图键叫 "0" 的那个）');
});

test('模型指向别的 jar 的贴图时，跨 jar 去取（客户端 jar 里的原版贴图）', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['kdoll:doll_vanilla']);

  const icon = r.icons.get('kdoll:doll_vanilla');
  assert.ok(icon, `该出图，缺的是：${r.missing.join(',')}`);
  assert.match(icon.source, /DemoPack\.jar → assets\/minecraft\/textures\/block\/tnt_side\.png/,
    'mod 自己的 jar 里没有这张贴图，应该去客户端 jar 取');
});

test('模型有但贴图对不上时，如实进 missing（不编图标）', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['kdoll:ghost']);

  assert.equal(r.icons.size, 0, 'block 模型里指的贴图不存在，就不该硬出一张图');
  assert.deepEqual(r.missing, ['kdoll:ghost']);
});

test('传送带：只有一条平铺贴图 + 一堆零件模型，不当图标（宁可画字母方块）', () => {
  resetIconCaches();
  const { instance } = makePack();
  // 关键是对照：传送带那种形状不该出图，而且「只有 block 贴图」的方块物品也一律不出图
  const r = resolveIcons(instance, ['kdoll:belt', 'minecraft:tnt', 'kdoll:doll_machine']);

  assert.equal(r.icons.has('kdoll:belt'), false,
    'create:belt 那种「零件模型 + 一条平铺贴图」不能拿条纹冒充图标');
  assert.deepEqual(r.missing, ['kdoll:belt', 'kdoll:doll_machine'],
    '只有 block 形态的两个都不该有图标');

  // 别做宽：有 item 模型的原版方块（tnt）必须有图标
  const tnt = r.icons.get('minecraft:tnt');
  assert.ok(tnt, 'minecraft:tnt 有 item 模型，不能被误判成没有图标');
  assert.match(tnt.source, /DemoPack\.jar → assets\/minecraft\/textures\/block\/tnt_/,
    '模型里没有 elements（纯贴图）时，仍然按贴图给图标');
});

test('物品模型带 elements：整张等轴测画出来（JEI 那种），不再只挑一张贴图', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['minecraft:render_cube']);

  const icon = r.icons.get('minecraft:render_cube');
  assert.ok(icon, `带 elements 的模型必须画出来，缺的是：${r.missing.join(',')}`);
  assert.match(icon.source, /models\/item\/render_cube\.json.*等轴测渲染/,
    '来源要写清是哪个模型渲染的，方便以后追问题');
  assert.ok(String(icon.dataUrl).length > 100, '渲染出来的必须是真 PNG，不是空图');
});

test('只有方块模型时：有 elements 就整张画出来（JEI 那种），纯平面贴图才如实不出图', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['ropey:chain_rope', 'ropey:rope', 'ropey:mystery_torch']);

  const chain = r.icons.get('ropey:chain_rope');
  assert.ok(chain, `方块模型带 elements 时必须画出来，缺的是：${r.missing.join(',')}`);
  assert.match(chain.source, /assets\/ropey\/models\/block\/rope_pulley\/chain\.json.*等轴测渲染/,
    '来源要指向 blockstate 找到的那个模型，并标明是渲染出来的');
  assert.deepEqual(r.missing, ['ropey:rope', 'ropey:mystery_torch'],
    '模型里没有 elements（只有一张平铺贴图）的，仍然不该冒充物品图标');
});

test('item 贴图优先于同名 block 贴图（jar 里 block 条目排在前面）', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['create:cogwheel']);

  const icon = r.icons.get('create:cogwheel');
  assert.ok(icon, 'cogwheel 该出图');
  assert.match(icon.source, /assets\/create\/textures\/item\/cogwheel\.png/,
    '两个位置都有同名贴图时，必须选手持物品那张，不能选方块那张');
});

test('画布告示牌：墙上的借用同名手持那种的图标', () => {
  resetIconCaches();
  const { instance } = makePack();
  const r = resolveIcons(instance, ['ropey:white_wall_canvas_sign']);

  const icon = r.icons.get('ropey:white_wall_canvas_sign');
  assert.ok(icon, `该出图，缺的是：${r.missing.join(',')}`);
  assert.match(icon.source, /assets\/ropey\/textures\/item\/white_canvas_sign\.png/);
  assert.match(icon.source, /借用/, '来源里要写清楚是借的，免得后面误以为 mod 真给了这张图');
});

// 2026-11-06：很多 mod 把别的 mod 整个塞进 `META-INF/jarjar/xxx.jar`。
// 那些内嵌 mod 的物品在游戏里真实存在（实测 Mechanomania 有 145 个），
// 贴图也只在内层 jar 里 —— 不扫内层就永远画不出图标。
// 内层字节只在内存里，没有磁盘路径，所以索引里要记「虚拟键」`<外层>!/<内层条目>`。
test('jarjar 内嵌 mod 的贴图也能出图标（2026-11-06 真缺口）', () => {
  resetIconCaches();
  const root = tmpdir('jarjar');
  const instanceDir = path.join(root, 'versions', 'DemoPack');
  const modsDir = path.join(instanceDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  const inner = makeZip({
    'assets/nested/textures/item/thing.png': PNG,
    'assets/nested/models/item/thing.json': JSON.stringify({ textures: { layer0: 'nested:item/thing' } }),
  });
  const outerJar = path.join(modsDir, 'bundle-1.0.jar');
  fs.writeFileSync(outerJar, makeZip({
    'META-INF/mods.toml': 'modId="bundle"\ndisplayName="Bundle"\nversion="1.0"\n',
    'META-INF/jarjar/nested-mod-1.0.jar': inner,
  }));

  const instance = {
    id: 'DemoPack',
    mcRoot: root,
    instanceDir,
    modsDir,
    versionJsonFile: path.join(instanceDir, 'DemoPack.json'),
    clientJar: '',
  };

  const index = buildTextureIndex(modsDir);
  assert.ok(index.byId.has('nested:thing'), '内层 jar 的贴图要进索引');
  assert.match(index.byId.get('nested:thing').jar, /!\/META-INF\/jarjar\/nested-mod-1\.0\.jar$/,
    '内层的引用要用「虚拟键」记（外层路径 + !/ + 内层条目），因为内层没有磁盘路径');

  const r = resolveIcons(instance, ['nested:thing']);
  assert.equal(r.missing.length, 0, `内层贴图该出图，缺的是：${r.missing.join(',')}`);
  const icon = r.icons.get('nested:thing');
  assert.match(icon.dataUrl, /^data:image\/png;base64,/);
  assert.match(icon.source, /assets\/nested\/textures\/item\/thing\.png/);
});