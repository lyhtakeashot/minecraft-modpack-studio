/**
 * 「改配方」接口（lib/host/recipe-api.js）的单测。
 *
 * 这块跟别的接口不一样：它会真写文件到整合包里。所以测试除了验「数据算得对」，
 * 更重要是验三条安全带：不可改的配方要老实拒绝、预览阶段绝不能碰盘、
 * 写完要留备份。
 *
 * 全程在临时目录里造假包，不碰任何真实整合包。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { McError } from '../packages/core/errors.js';
import { ZipWriter } from '../packages/core/zipwrite.js';
import { resetCaches } from '../lib/host/cache.js';
import {
  buildBatchPlan,
  buildRecipePlan,
  handleItemRecipes,
  handleRecipeApply,
  handleRecipeBatchApply,
  handleRecipeBatchPreview,
  handleRecipeDetail,
  handleRecipePreview,
} from '../lib/host/recipe-api.js';

/** 造一个假整合包：一个 mod 的 jar（里面几条配方）+ 空的 kubejs 目录。 */
async function makePack({ withKubejs = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-recipe-'));
  const versionDir = path.join(root, 'versions', 'TestPack');
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(
    path.join(versionDir, 'TestPack.json'),
    JSON.stringify({ id: 'TestPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
    'utf8',
  );

  const modsDir = path.join(versionDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const jarPath = path.join(modsDir, 'testmod-1.0.jar');
  const w = new ZipWriter(jarPath);
  await w.open();
  await w.addText(
    'data/testmod/recipe/cogwheel.json',
    JSON.stringify({
      type: 'minecraft:crafting_shaped',
      pattern: ['AA', 'AA'],
      key: { A: { item: 'minecraft:iron_ingot' } },
      result: { item: 'testmod:cogwheel', count: 2 },
    }),
  );
  await w.addText(
    'data/testmod/recipe/pressing/plate.json',
    JSON.stringify({
      type: 'create:pressing',
      ingredients: [{ item: 'testmod:ingot' }],
      results: [{ item: 'testmod:plate' }],
    }),
  );
  await w.addText(
    'data/testmod/recipe/with_tag.json',
    JSON.stringify({
      type: 'minecraft:crafting_shapeless',
      ingredients: [{ tag: 'minecraft:planks' }, { item: 'minecraft:stick' }],
      result: { item: 'testmod:thing' },
    }),
  );
  await w.addText(
    'data/testmod/recipe/smelting.json',
    JSON.stringify({
      type: 'minecraft:smelting',
      ingredient: { item: 'testmod:ore' },
      result: 'testmod:ingot',
    }),
  );
  // 多产物：Create 机器配方那种「一次出好几样」的写法
  await w.addText(
    'data/testmod/recipe/pressing/multi.json',
    JSON.stringify({
      type: 'create:pressing',
      processing_time: 50,
      ingredients: [{ item: 'testmod:ingot' }],
      results: [{ id: 'testmod:plate', count: 2 }, { id: 'testmod:dust', chance: 0.1 }],
    }),
  );
  // 流体产物：量写在 amount 里（毫桶），跟物品的 count 不是一回事
  await w.addText(
    'data/testmod/recipe/emptying/honey_bottle.json',
    JSON.stringify({
      type: 'create:emptying',
      ingredients: [{ item: 'minecraft:honey_bottle' }],
      results: [{ id: 'minecraft:glass_bottle' }, { amount: 250, id: 'testmod:honey' }],
    }),
  );
  await w.close();

  if (withKubejs) fs.mkdirSync(path.join(versionDir, 'kubejs', 'server_scripts'), { recursive: true });
  return { root, versionDir };
}

/** 造一个 GET 请求。 */
function get(suffix, params) {
  const qs = new URLSearchParams(params).toString();
  return new Request(`http://localhost/api/mcstudio${suffix}?${qs}`);
}

/** 造一个 POST 请求。 */
function post(suffix, body) {
  return new Request(`http://localhost/api/mcstudio${suffix}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/** 断言某个调用抛出的 McError 的 code。 */
async function throwsCode(fn, code) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof McError, `应该抛 McError，实际是 ${error?.constructor?.name}`);
    assert.equal(error.code, code, `code 不对：${error.message}`);
    return error;
  }
  assert.fail(`应该抛 ${code}，但没有抛`);
}

test('改配方：能列出「谁能做这个物品」和「谁在用这个物品」', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const data = await handleItemRecipes(get('/recipes', { dir: versionDir, item: 'testmod:cogwheel', limit: '10' }));
  assert.equal(data.item, 'testmod:cogwheel');
  assert.equal(data.producers.length, 1);
  assert.equal(data.producers[0].id, 'testmod:cogwheel');
  assert.equal(data.producers[0].kind, 'shaped');
  // 列表里不给「能不能改」——判断要读 jar，几十条全读太慢，点进去才给结论
  assert.equal('editable' in data.producers[0], false);
  assert.deepEqual(data.producers[0].outputs, [{ id: 'testmod:cogwheel', count: 2 }]);
  // 铁锭被 cogwheel 那条配方用着
  const ingot = await handleItemRecipes(get('/recipes', { dir: versionDir, item: 'minecraft:iron_ingot' }));
  assert.ok(ingot.consumerTotal >= 1, '铁锭应该至少被一条配方用着');
});

test('改配方：详情给出可编辑的图案和材料', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const data = await handleRecipeDetail(get('/recipe', { dir: versionDir, recipeId: 'testmod:cogwheel' }));
  assert.equal(data.recipe.id, 'testmod:cogwheel');
  assert.deepEqual(data.recipe.pattern, ['AA', 'AA']);
  assert.deepEqual(data.recipe.keys, { A: 'minecraft:iron_ingot' });
  assert.equal(data.recipe.output, 'testmod:cogwheel');
  assert.equal(data.recipe.count, 2);
  assert.equal(data.recipe.editable, true);
});

test('改配方：机器配方带上具体机器类型，才能生成对应代码', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const data = await handleRecipeDetail(get('/recipe', { dir: versionDir, recipeId: 'testmod:pressing/plate' }));
  assert.equal(data.recipe.kind, 'machine');
  assert.equal(data.recipe.machineKind, 'pressing');
  assert.deepEqual(data.recipe.inputs, ['testmod:ingot']);
});

test('改配方：用了标签的配方老实标成不可改，并说明原因', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const data = await handleRecipeDetail(get('/recipe', { dir: versionDir, recipeId: 'testmod:with_tag' }));
  assert.equal(data.recipe.editable, false);
  assert.ok(data.recipe.reason.includes('标签'), `原因要提标签：${data.recipe.reason}`);
});

test('改配方：熔炉这类配方标成不可改', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const data = await handleRecipeDetail(get('/recipe', { dir: versionDir, recipeId: 'testmod:smelting' }));
  assert.equal(data.recipe.kind, 'unsupported');
  assert.equal(data.recipe.editable, false);
});

test('改配方：预览只算不写盘', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipePreview(get('/recipe/preview', {
    dir: versionDir,
    recipeId: 'testmod:cogwheel',
    count: '4',
  }));
  assert.equal(plan.action, 'edit');
  assert.equal(plan.counts.removed, 1);
  assert.equal(plan.counts.added, 1);
  // 生成的两步：先删原配方，再声明新的
  assert.ok(plan.code.includes('event.remove'), '必须先生成删除原配方的代码');
  assert.ok(plan.code.includes('testmod:cogwheel'), '必须包含产物');
  assert.ok(plan.code.includes('Item.of') || plan.code.includes('4x'), '数量 4 要体现在代码里');
  assert.ok(plan.targetPath.includes(path.join('kubejs', 'server_scripts')));
  assert.equal(fs.existsSync(plan.targetPath), false, '预览阶段绝不能创建文件');
  assert.ok(plan.warnings.some((w) => w.includes('产物数量')), '数量变了要提醒一句');
});

test('改配方：改完之后仍能产出的物品不会被误报成「彻底没了」', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipePreview(get('/recipe/preview', {
    dir: versionDir,
    recipeId: 'testmod:cogwheel',
  }));
  // 铁锭由原版其他配方产生（假包里没有），这里只关心 cogwheel 自己不算断路
  assert.equal(plan.impact.lost.some((b) => b.item === 'testmod:cogwheel'), false);
});

test('改配方：确认写入会真写文件并留备份', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const result = await handleRecipeApply(post('/recipe/apply', {
    dir: versionDir,
    recipeId: 'testmod:cogwheel',
    count: '3',
  }));
  assert.equal(fs.existsSync(result.targetPath), true, '文件应该被写出来了');
  const text = fs.readFileSync(result.targetPath, 'utf8');
  assert.ok(text.includes('event.remove'), '写进去的内容要和预览一致');
  assert.ok(result.backup === '' || fs.existsSync(result.backup), '备份路径要么为空要么真存在');
  assert.equal(result.recipe.id, 'testmod:cogwheel');
});

test('改配方：不可改的配方连预览都直接拒绝，不会生成半成品代码', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  await throwsCode(
    () => handleRecipePreview(get('/recipe/preview', { dir: versionDir, recipeId: 'testmod:smelting' })),
    'RecipeNotEditable',
  );
});

test('改配方：产物数量被夹在 1~64，手滑打 9999 也不会真写进去', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipePreview(get('/recipe/preview', {
    dir: versionDir,
    recipeId: 'testmod:cogwheel',
    count: '9999',
  }));
  assert.ok(!plan.code.includes('9999'), '9999 不该出现在代码里');
  assert.ok(plan.code.includes('64'), '应该被夹到 64');
});

test('改配方：包里有 KubeJS 目录才让改，没有就明说', async () => {
  resetCaches();
  const { versionDir } = await makePack({ withKubejs: false });
  await throwsCode(
    () => handleRecipePreview(get('/recipe/preview', { dir: versionDir, recipeId: 'testmod:cogwheel' })),
    'KubejsNotFound',
  );
});

test('改配方：有序合成换材料，参数按界面那样传 JSON 串也认', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipePreview(get('/recipe/preview', {
    dir: versionDir,
    recipeId: 'testmod:cogwheel',
    // 界面上是这么传的：数组/对象先 JSON.stringify 再塞进查询参数
    keys: JSON.stringify({ A: 'minecraft:gold_ingot' }),
  }));
  assert.ok(plan.code.includes('minecraft:gold_ingot'), '新材料要写进代码');
  assert.equal(plan.code.includes('minecraft:iron_ingot'), false, '旧材料不该残留');
});

test('改配方：无序合成改材料，传 JSON 数组也认', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipePreview(get('/recipe/preview', {
    dir: versionDir,
    recipeId: 'testmod:pressing/plate',
    inputs: JSON.stringify(['testmod:other_ingot']),
  }));
  assert.ok(plan.code.includes('testmod:other_ingot'));
  assert.equal(plan.code.includes('testmod:ingot\.'), false, '旧材料不该残留');
});

test('改配方：确认写入改用 POST body 传参也认', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const result = await handleRecipeApply(post('/recipe/apply', {
    dir: versionDir,
    recipeId: 'testmod:pressing/plate',
    count: 2,
    inputs: ['testmod:other_ingot'],
  }));
  assert.ok(result.code.includes('Item.of'), '机器配方数量 2 要用 Item.of 才能表达');
  assert.ok(result.code.includes('testmod:other_ingot'));
});

test('改配方：删配方只要给的一条指令，不需要填材料', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipePreview(get('/recipe/preview', {
    dir: versionDir,
    recipeId: 'testmod:cogwheel',
    action: 'remove',
  }));
  assert.equal(plan.action, 'remove');
  assert.equal(plan.counts.added, 0, '删配方不该新增配方');
  assert.ok(plan.code.includes('event.remove'));
});

test('改配方：配方 ID 抄错时给出可读的中文报错', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const error = await throwsCode(
    () => handleRecipeDetail(get('/recipe', { dir: versionDir, recipeId: 'testmod:not_here' })),
    'RecipeNotFound',
  );
  assert.ok(error.message.includes('testmod:not_here'));
});

test('改配方：新配方 ID 由原 ID 派生，反复改同一条不会越改越多', () => {
  // 同一条配方预览两次，生成的配方 ID 必须一样
  return makePack().then(async ({ versionDir }) => {
    resetCaches();
    const a = await handleRecipePreview(get('/recipe/preview', { dir: versionDir, recipeId: 'testmod:cogwheel' }));
    const b = await handleRecipePreview(get('/recipe/preview', { dir: versionDir, recipeId: 'testmod:cogwheel' }));
    assert.equal(a.code, b.code, '同样的输入必须生成同样的代码');
  });
});

test('改配方：buildRecipePlan 是纯函数式的，连调两次不改变输入', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const params = { dir: versionDir, recipeId: 'testmod:cogwheel' };
  const p1 = buildRecipePlan(params);
  const p2 = buildRecipePlan(params);
  assert.equal(p1.targetPath, p2.targetPath);
  assert.equal(p1.code, p2.code);
  assert.deepEqual(params, { dir: versionDir, recipeId: 'testmod:cogwheel' }, '不该改动传进来的参数');
});

// ————————————————————— 多产物配方 —————————————————————

test('改配方：多产物配方不再被拦下来，能读出每一种产物', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const data = await handleRecipeDetail(get('/recipe', { dir: versionDir, recipeId: 'testmod:pressing/multi' }));
  assert.equal(data.recipe.multi, true, '这条要认成多产物');
  assert.equal(data.recipe.editable, true, '多产物现在能改了');
  assert.equal(data.recipe.output, '', '多产物没有「唯一那个产物」');
  assert.equal(data.recipe.outputs.length, 2);
  assert.deepEqual(
    data.recipe.outputs.map((o) => o.id),
    ['testmod:plate', 'testmod:dust'],
  );
  assert.equal(data.recipe.outputs[0].count, 2);
  // 概率产物要连概率一起带出来，丢了就等于悄悄改了概率
  assert.equal(data.recipe.outputs[1].chance, 0.1);
});

test('改配方：多产物改完写的是「同名覆盖的数据包文件」，材料和其它设置一字不动', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipePreview(get('/recipe/preview', {
    dir: versionDir,
    recipeId: 'testmod:pressing/multi',
    outputs: JSON.stringify([
      { id: 'testmod:plate', count: 3 },
      { id: 'testmod:dust', count: 1, chance: 0.25 },
      { id: 'testmod:nugget', count: 1 },
    ]),
  }));
  assert.equal(plan.mode, 'json', '多产物走 JSON 改写路径，不是写脚本');
  assert.ok(
    plan.targetPath.endsWith(path.join('kubejs', 'data', 'testmod', 'recipe', 'pressing', 'multi.json')),
    `目标路径不对：${plan.targetPath}`,
  );
  const json = JSON.parse(plan.code);
  // 产物换了
  assert.deepEqual(json.results.map((r) => r.id), ['testmod:plate', 'testmod:dust', 'testmod:nugget']);
  assert.equal(json.results[0].count, 3);
  assert.equal(json.results[1].chance, 0.25);
  // 材料、机器专属参数一个都不能少
  assert.equal(json.type, 'create:pressing');
  assert.equal(json.processing_time, 50);
  assert.deepEqual(json.ingredients, [{ item: 'testmod:ingot' }]);
  assert.equal(fs.existsSync(plan.targetPath), false, '预览阶段绝不能写盘');
});

test('改配方：多产物写进去之后，原文件留备份', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const first = await handleRecipeApply(post('/recipe/apply', {
    dir: versionDir,
    recipeId: 'testmod:pressing/multi',
    outputs: [{ id: 'testmod:plate', count: 5 }],
  }));
  assert.ok(fs.existsSync(first.targetPath), '改完要真的写进去');
  const written = JSON.parse(fs.readFileSync(first.targetPath, 'utf8'));
  assert.deepEqual(written.results.map((r) => r.id), ['testmod:plate']);
  assert.equal(written.results[0].count, 5);
  assert.equal(written.processing_time, 50, '机器专属参数要留着');
  assert.equal(first.backup, '', '第一次写是新建文件，本来就没有可备份的旧文件');

  // 再改一次：这次文件已经在了，必须留备份
  const second = await handleRecipeApply(post('/recipe/apply', {
    dir: versionDir,
    recipeId: 'testmod:pressing/multi',
    outputs: [{ id: 'testmod:plate', count: 9 }],
  }));
  assert.ok(second.backup, '覆盖已有文件时要留备份');
  const again = JSON.parse(fs.readFileSync(second.targetPath, 'utf8'));
  assert.equal(again.results[0].count, 9);
});

test('改配方：多产物删到只剩一种，就退回普通配方的改法', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipePreview(get('/recipe/preview', {
    dir: versionDir,
    recipeId: 'testmod:pressing/multi',
    outputs: JSON.stringify([{ id: 'testmod:plate', count: 1 }]),
  }));
  // 只剩一种产物时仍然是 JSON 改写（产物键名还是 results，数组），
  // 但不能给写成「单产物字符串」那种游戏不认的形状
  const json = JSON.parse(plan.code);
  assert.ok(Array.isArray(json.results), 'results 还得是数组');
  assert.equal(json.results.length, 1);
});

test('改配方：多产物一个都不留就报错，不给写空配方', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  await throwsCode(
    () => handleRecipePreview(get('/recipe/preview', {
      dir: versionDir,
      recipeId: 'testmod:pressing/multi',
      outputs: JSON.stringify([]),
    })),
    'BadRecipe',
  );
});

test('改配方：流体产物的「量」（amount）不能被改没', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipePreview(get('/recipe/preview', {
    dir: versionDir,
    recipeId: 'testmod:emptying/honey_bottle',
    outputs: JSON.stringify([
      { id: 'minecraft:glass_bottle', count: 2 },
      { id: 'testmod:honey', count: 1 },
    ]),
  }));
  const json = JSON.parse(plan.code);
  const honey = json.results.find((r) => r.id === 'testmod:honey');
  assert.ok(honey, '蜂蜜那一项要在');
  // amount 是流体的量（毫桶），丢了这条产物就是 0
  assert.equal(honey.amount, 250, '流体的量要照抄原配方');
  assert.equal('count' in honey, false, '流体不该再写 count（两个都写游戏会挑花眼）');
  const bottle = json.results.find((r) => r.id === 'minecraft:glass_bottle');
  assert.equal(bottle.count, 2, '普通物品的数量照常改');
});

// ————————————————————— 批量改配方 —————————————————————

test('批量改配方：两条单产物合成一份脚本，预览不写盘', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipeBatchPreview(post('/recipe/batch/preview', {
    dir: versionDir,
    items: [
      { recipeId: 'testmod:cogwheel', count: 4 },
      { recipeId: 'testmod:pressing/plate', count: 3 },
    ],
  }));
  assert.equal(plan.items.length, 2);
  assert.equal(plan.counts.removed, 2, '两条原配方都要删');
  assert.equal(plan.counts.added, 2, '两条新配方都要加');
  assert.equal(plan.counts.files, 1, '只合成一份脚本文件');
  assert.equal(plan.files[0].mode, 'script');
  assert.ok(plan.files[0].file.endsWith('dsh_recipes.js'));
  const code = plan.files[0].content;
  assert.equal((code.match(/event\.remove/g) ?? []).length, 2, '脚本里要有两条删除');
  assert.ok(code.includes('testmod:cogwheel'));
  assert.ok(code.includes('testmod:plate'));
  assert.ok(code.includes('4x') || code.includes('4'), '第一条产出改成了 4');
  assert.ok(code.includes('Item.of'), '第二条机器配方数量 3 要用 Item.of 表达');
  for (const f of plan.files) {
    assert.equal(fs.existsSync(f.file), false, '预览阶段绝不能写盘');
  }
  assert.ok(Array.isArray(plan.summary) && plan.summary.length >= 2, '每条都要有一句摘要');
  assert.ok(Array.isArray(plan.warnings), '警告要是数组，界面和 MCP 都按数组读');
});

test('批量改配方：「产出都 +1」用 delta，不必逐条知道原数量', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipeBatchPreview(post('/recipe/batch/preview', {
    dir: versionDir,
    items: [
      { recipeId: 'testmod:cogwheel' },
      { recipeId: 'testmod:pressing/plate' },
    ],
    delta: 1,
  }));
  // cogwheel 原数量 2 → 3，plate 原数量 1 → 2
  assert.ok(plan.files[0].content.includes('3x') || plan.files[0].content.includes('3'));
  assert.ok(plan.files[0].content.includes('Item.of'), 'plate 变成 2 个也要用 Item.of');
  assert.ok(plan.warnings.some((w) => w.includes('产物数量')), '数量变了要提醒');
});

test('批量改配方：删掉选中的，只删不加', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipeBatchPreview(post('/recipe/batch/preview', {
    dir: versionDir,
    items: [
      { recipeId: 'testmod:cogwheel' },
      { recipeId: 'testmod:pressing/plate' },
    ],
    action: 'remove',
  }));
  assert.equal(plan.counts.removed, 2);
  assert.equal(plan.counts.added, 0, '删配方不该新增');
  assert.equal((plan.files[0].content.match(/event\.remove/g) ?? []).length, 2);
});

test('批量改配方：多产物各写各的 JSON 文件，脚本里不误删它', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipeBatchPreview(post('/recipe/batch/preview', {
    dir: versionDir,
    items: [
      { recipeId: 'testmod:pressing/multi', outputs: [{ id: 'testmod:plate', count: 5 }] },
      // 两种产物都留着，流体 honey 那项才能照抄原 amount
      {
        recipeId: 'testmod:emptying/honey_bottle',
        outputs: [{ id: 'minecraft:glass_bottle', count: 2 }, { id: 'testmod:honey', count: 1 }],
      },
    ],
  }));
  assert.equal(plan.counts.files, 2, '两个多产物各一份 JSON 文件');
  assert.equal(plan.counts.added, 2);
  assert.equal(plan.files.every((f) => f.mode === 'json'), true);
  assert.equal(plan.files.every((f) => f.file.endsWith('.json')), true);
  assert.notEqual(plan.files[0].file, plan.files[1].file, '目标路径不能是同一个文件');
  const honeys = plan.files.find((f) => f.file.includes('honey_bottle'));
  const json = JSON.parse(honeys.content);
  assert.equal(json.results.find((r) => r.id === 'testmod:honey').amount, 250, '流体量照抄，别改没');
  for (const f of plan.files) assert.equal(fs.existsSync(f.file), false, '预览不写盘');
});

test('批量改配方：脚本和 JSON 混着改，合成一份脚本 + 各自 JSON 文件', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const plan = await handleRecipeBatchPreview(post('/recipe/batch/preview', {
    dir: versionDir,
    items: [
      { recipeId: 'testmod:cogwheel', count: 4 },
      { recipeId: 'testmod:pressing/multi', outputs: [{ id: 'testmod:plate', count: 5 }] },
    ],
  }));
  assert.equal(plan.counts.files, 2, '一份脚本 + 一份 JSON');
  assert.equal(plan.files.filter((f) => f.mode === 'script').length, 1);
  assert.equal(plan.files.filter((f) => f.mode === 'json').length, 1);
  // 脚本里只能删 cogwheel，不能顺手把多产物那条也删了（它靠同名 JSON 覆盖）
  const script = plan.files.find((f) => f.mode === 'script');
  assert.equal((script.content.match(/event\.remove/g) ?? []).length, 1);
  assert.equal(script.content.includes('testmod:pressing/multi'), false);
});

test('批量改配方：任一条不可改，整批预览直接拒绝，一个文件都不写', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const scriptDir = path.join(versionDir, 'kubejs');
  await throwsCode(
    () => handleRecipeBatchPreview(post('/recipe/batch/preview', {
      dir: versionDir,
      items: [
        { recipeId: 'testmod:cogwheel', count: 4 },
        { recipeId: 'testmod:smelting' },
      ],
    })),
    'RecipeNotEditable',
  );
  // 非法批次不该留下任何半成品
  assert.equal(fs.existsSync(path.join(scriptDir, 'server_scripts', 'dsh_recipes.js')), false);
});

test('批量改配方：上限 40 条、重复 ID 要给中文报错', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  await throwsCode(
    () => handleRecipeBatchPreview(post('/recipe/batch/preview', {
      dir: versionDir,
      items: Array.from({ length: 41 }, () => ({ recipeId: 'testmod:cogwheel' })),
    })),
    'McBadArgs',
  );
  await throwsCode(
    () => handleRecipeBatchPreview(post('/recipe/batch/preview', {
      dir: versionDir,
      items: [{ recipeId: 'testmod:cogwheel' }, { recipeId: 'testmod:cogwheel' }],
    })),
    'McBadArgs',
  );
  await throwsCode(
    () => handleRecipeBatchPreview(post('/recipe/batch/preview', { dir: versionDir, items: [] })),
    'McBadArgs',
  );
});

test('批量改配方：确认写入一次写齐，且 apply 参数与 preview 逐字一致', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const items = [
    { recipeId: 'testmod:cogwheel', count: 4 },
    { recipeId: 'testmod:pressing/plate', count: 3 },
  ];
  const payload = { dir: versionDir, items };
  const plan = await handleRecipeBatchPreview(post('/recipe/batch/preview', payload));
  // 预览算出几个文件，写入就该真写几个
  const result = await handleRecipeBatchApply(post('/recipe/batch/apply', payload));
  assert.equal(result.files.length, plan.files.length);
  assert.equal(result.items.length, 2);
  // 假包里没有物品表，全目录复验会把引用的物品都报成「不认识」，verified 为 false 是夹具限制
  // （单条 /recipe/apply 也一样）。这里只验「写进去了、且没有把文件回滚掉」。
  for (const file of result.files) {
    assert.ok(fs.existsSync(file), `写进去的文件要在：${file}`);
  }
  const written = fs.readFileSync(result.files[0], 'utf8');
  assert.equal((written.match(/event\.remove/g) ?? []).length, 2, '两条都写进同一份脚本了');
  assert.ok(Array.isArray(result.backups), '要有备份记录');
});

test('批量改配方：buildBatchPlan 是纯算的，预览和写入算出的代码逐字一样', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const params = {
    dir: versionDir,
    items: [{ recipeId: 'testmod:cogwheel', count: 4 }, { recipeId: 'testmod:pressing/plate', count: 3 }],
  };
  const a = buildBatchPlan(params);
  const b = buildBatchPlan(params);
  assert.deepEqual(a.files.map((f) => f.content), b.files.map((f) => f.content));
  assert.deepEqual(params.items, [
    { recipeId: 'testmod:cogwheel', count: 4 },
    { recipeId: 'testmod:pressing/plate', count: 3 },
  ], '不该改动传进来的参数');
});

test('批量改配方：多产物写进去之后各自留一份覆盖文件', async () => {
  resetCaches();
  const { versionDir } = await makePack();
  const payload = {
    dir: versionDir,
    items: [
      { recipeId: 'testmod:pressing/multi', outputs: [{ id: 'testmod:plate', count: 5 }] },
      {
        recipeId: 'testmod:emptying/honey_bottle',
        outputs: [{ id: 'minecraft:glass_bottle', count: 2 }, { id: 'testmod:honey', count: 1 }],
      },
    ],
  };
  const result = await handleRecipeBatchApply(post('/recipe/batch/apply', payload));
  assert.equal(result.files.length, 2);
  for (const file of result.files) assert.ok(fs.existsSync(file));
  const multi = JSON.parse(fs.readFileSync(result.files.find((f) => f.includes('multi')), 'utf8'));
  assert.equal(multi.results[0].count, 5);
  const honey = JSON.parse(fs.readFileSync(result.files.find((f) => f.includes('honey')), 'utf8'));
  assert.equal(honey.results.find((r) => r.id === 'testmod:honey').amount, 250);
});