/**
 * MCP 服务器（packages/mcp/）的单测。
 *
 * 重点验三件事：
 * ① 握手能不能成 —— 协议版本、工具清单对不对；
 * ② 工具清单规不规范 —— 每个工具都要有 name / description / 标准 JSON Schema；
 * ③ 安全带 —— 写盘类工具在 apply 缺省（false）时绝不能碰用户的文件。
 *
 * 全程在临时目录里造假整合包，不碰任何真实整合包。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ZipWriter } from '../packages/core/zipwrite.js';
import { resetStudioApiCache } from '../lib/host/api.js';
import { handleLine, handleRequest, runSelfTest, SUPPORTED_PROTOCOL_VERSIONS } from '../packages/mcp/protocol.mjs';
import { callTool, toolManifest, WRITE_TOOL_NAMES } from '../packages/mcp/tools.mjs';

const SERVER_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'mcp',
  'server.mjs',
);

/** 造一个假整合包：一个 mod 的 jar（里面几条配方）+ 空的 kubejs 目录。 */
async function makePack({ withKubejs = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-mcp-'));
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
  await w.close();

  if (withKubejs) fs.mkdirSync(path.join(versionDir, 'kubejs', 'server_scripts'), { recursive: true });
  return { root, versionDir };
}

/** 列出目录下的文件（相对路径），用来断言「一个文件都没多」。 */
function listFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

test('自检：--self-test 能跑通，退出码 0，工具数不少于 20 个', () => {
  // 沙箱里管道捕获子进程输出会 EPERM，所以只看退出码（stdout 的内容由下面两条用例在进程内验）。
  const result = spawnSync(process.execPath, [SERVER_SCRIPT, '--self-test'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    stdio: 'ignore',
  });
  assert.equal(result.status, 0, `--self-test 应该退出码 0，实际 ${result.status}（${result.error?.message ?? '没有 stderr'}）`);
});

test('自检：握手能成，协议版本原样回，工具数不少于 20 个', async () => {
  const result = await runSelfTest();
  assert.equal(result.ok, true, `自检没过：${result.error}`);
  assert.ok(result.toolCount >= 20, `工具数太少：${result.toolCount}`);
  assert.equal(result.protocolVersion, '2026-07-28');
});

test('协议：客户端要 2026-07-28 就原样回，不认识的版本退到 2025-06-18', async () => {
  const hit = await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.equal(hit.result.protocolVersion, '2026-07-28');
  assert.equal(hit.result.serverInfo.name, 'mcstudio');
  assert.ok(hit.result.capabilities.tools, '要声明 tools 能力');

  const old = await handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.equal(old.result.protocolVersion, '2024-11-05');
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes('2024-11-05'));

  const unknown = await handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
});

test('协议：不认识的方法回 -32601，坏 JSON 回 -32700', async () => {
  const unknown = await handleRequest({ jsonrpc: '2.0', id: 9, method: 'tools/nope' });
  assert.equal(unknown.error.code, -32601);

  const broken = await handleLine('{ 这不是 JSON');
  assert.equal(broken.error.code, -32700);
});

test('工具清单：每个工具都有 name / description / 标准 JSON Schema', async () => {
  const list = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = list.result.tools;
  assert.ok(tools.length >= 20, `工具数太少：${tools.length}`);
  for (const tool of tools) {
    assert.ok(tool.name, '工具缺 name');
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `工具名要用小写下划线：${tool.name}`);
    assert.ok(tool.description && tool.description.length > 10, `工具 ${tool.name} 的说明太短`);
    assert.equal(tool.inputSchema?.type, 'object', `工具 ${tool.name} 的 inputSchema 不是标准 JSON Schema`);
    assert.ok(tool.inputSchema.properties, `工具 ${tool.name} 缺 properties`);
  }
  // 任务书要求的工具一个都不能少
  const names = new Set(tools.map((t) => t.name));
  for (const want of [
    'instance_info', 'mod_list', 'item_search', 'recipe_find', 'recipe_path', 'recipe_uses',
    'quest_list', 'quest_show', 'quest_lint', 'mod_inspect', 'overlap_report',
    'progression_check', 'kubejs_check', 'export_preview', 'launch_preview',
    'recipe_edit', 'recipe_edit_batch', 'quest_add', 'quest_chapter', 'quest_move', 'quest_patch',
    'quest_remove', 'quest_image',
  ]) {
    assert.ok(names.has(want), `少了工具 ${want}`);
  }
});

test('写盘类工具：都有 apply 参数，缺省是 false', () => {
  const writeTools = toolManifest().filter((t) => WRITE_TOOL_NAMES.includes(t.name));
  assert.ok(writeTools.length >= 7, `写盘类工具太少：${writeTools.length}`);
  for (const tool of writeTools) {
    const apply = tool.inputSchema.properties?.apply;
    assert.ok(apply, `工具 ${tool.name} 缺 apply 参数`);
    assert.equal(apply.type, 'boolean');
    assert.equal(apply.default, false, `工具 ${tool.name} 的 apply 默认值必须是 false`);
  }
});

test('只读工具：调 instance_info 能拿到文字内容', async () => {
  resetStudioApiCache();
  const { versionDir } = await makePack();
  const result = await callTool('instance_info', { dir: versionDir });
  assert.ok(!result.isError, `不该报错：${JSON.stringify(result.content)}`);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.ok(result.content[0].text.length > 0, '内容不能是空的');
  assert.match(result.content[0].text, /TestPack/, '内容里应该能看出包名');
  assert.ok(result.structuredContent, '要带 structuredContent');
  assert.equal(result.structuredContent.instance.id, 'TestPack');
});

test('只读工具：调 recipe_find 能查到配方', async () => {
  resetStudioApiCache();
  const { versionDir } = await makePack();
  const result = await callTool('recipe_find', { dir: versionDir, item: 'testmod:cogwheel' });
  assert.ok(!result.isError, `不该报错：${JSON.stringify(result.content)}`);
  assert.match(result.content[0].text, /cogwheel/);
  assert.ok(result.structuredContent.producerTotal >= 1, '应该查到至少一条能做出来的配方');
});

test('写盘类工具：apply 缺省（false）时一个文件都不写', async () => {
  resetStudioApiCache();
  const { versionDir } = await makePack();
  const before = listFiles(versionDir);
  const scriptsDir = path.join(versionDir, 'kubejs', 'server_scripts');
  assert.deepEqual(fs.readdirSync(scriptsDir), [], '本来应该是空的');

  // 改配方：不写 apply
  const recipe = await callTool('recipe_edit', {
    dir: versionDir,
    recipe_id: 'testmod:cogwheel',
    count: 3,
    inputs: ['minecraft:iron_ingot'],
  });
  assert.ok(!recipe.isError, `不该报错：${JSON.stringify(recipe.content)}`);
  assert.match(recipe.content[0].text, /apply/, '预览结果里要提醒模型怎么真写盘');

  // 挪任务坐标：也没有 apply（这个包没任务书，应该报错而不是写盘）
  const quest = await callTool('quest_move', {
    dir: versionDir,
    moves: [{ quest_id: 'AAAA0001', x: 1, y: 2 }],
  });
  assert.ok(quest.isError, '这个包没有任务书，挪任务应该报错');

  assert.deepEqual(listFiles(versionDir), before, '预览阶段绝不能多出任何文件');
  assert.deepEqual(fs.readdirSync(scriptsDir), [], 'kubejs 脚本目录必须还是空的');
});

test('写盘类工具：apply=true 才会真的写盘', async () => {
  resetStudioApiCache();
  const { versionDir } = await makePack();
  const scriptsDir = path.join(versionDir, 'kubejs', 'server_scripts');
  const result = await callTool('recipe_edit', {
    dir: versionDir,
    recipe_id: 'testmod:cogwheel',
    count: 3,
    inputs: ['minecraft:iron_ingot'],
    apply: true,
  });
  assert.ok(!result.isError, `不该报错：${JSON.stringify(result.content)}`);
  const written = fs.readdirSync(scriptsDir);
  assert.equal(written.length, 1, `应该写出一个脚本，实际：${written.join('、')}`);
  assert.ok(fs.existsSync(path.join(scriptsDir, 'dsh_recipes.js')), '脚本名应该是 dsh_recipes.js');
});

test('工具调错了：要给出中文说明 + 错误码，别只丢一个英文码', async () => {
  const result = await callTool('recipe_edit', { dir: '' });
  assert.ok(result.isError, '缺参数应该报错');
  assert.match(result.content[0].text, /缺少整合包目录/);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.code, 'McBadArgs');
  assert.ok(result.structuredContent.hint, '要给一句可以照着办的提示');

  const noTool = await callTool('没有这个工具', {});
  assert.ok(noTool.isError);
  assert.match(noTool.content[0].text, /没有这个工具/);
});

// ===== 2026-11-08 第 3 条：批量改配方（MCP 侧）=====

test('批量改配方：apply 缺省只预览不写盘，apply=true 才一次写齐', async () => {
  resetStudioApiCache();
  const { versionDir } = await makePack();
  const scriptsDir = path.join(versionDir, 'kubejs', 'server_scripts');
  const before = listFiles(versionDir);

  // 两条一起改：每条给自己的 count / inputs，外层给统一 delta
  const recipes = [
    { recipe_id: 'testmod:cogwheel', count: 3, inputs: ['minecraft:iron_ingot'] },
    { recipe_id: 'testmod:pressing/plate', count: 2, inputs: ['testmod:ingot'] },
  ];

  const preview = await callTool('recipe_edit_batch', { dir: versionDir, recipes });
  assert.ok(!preview.isError, `批量预览不该报错：${JSON.stringify(preview.content)}`);
  assert.match(preview.content[0].text, /apply=true 才落盘/, '预览结果里要提醒模型怎么真写盘');
  assert.equal(preview.structuredContent.items?.length, 2, '预览要列出两条');
  assert.equal(preview.structuredContent.counts?.files, 1, '两条单产物应该合成一份脚本');
  assert.match(preview.structuredContent.files?.[0]?.content ?? '', /event\.remove/, '预览要带上合成后的脚本代码');
  assert.deepEqual(listFiles(versionDir), before, '预览阶段绝不能多出任何文件');
  assert.deepEqual(fs.readdirSync(scriptsDir), [], 'kubejs 脚本目录必须还是空的');

  const applied = await callTool('recipe_edit_batch', { dir: versionDir, recipes, apply: true });
  assert.ok(!applied.isError, `批量写入不该报错：${JSON.stringify(applied.content)}`);
  assert.match(applied.content[0].text, /已经改好并写盘/);
  assert.equal(applied.structuredContent.counts?.files, 1);
  assert.ok(fs.existsSync(path.join(scriptsDir, 'dsh_recipes.js')), '两条改动应该写进同一份 dsh_recipes.js');
  const code = fs.readFileSync(path.join(scriptsDir, 'dsh_recipes.js'), 'utf8');
  assert.match(code, /testmod:cogwheel/, '脚本里该有第一条');
  assert.match(code, /testmod:pressing\/plate/, '脚本里该有第二条（不能互相覆盖）');
});

test('批量改配方：没给 recipes 要报中文错，不能悄悄写成空批', async () => {
  const result = await callTool('recipe_edit_batch', { dir: 'D:\\不存在的目录' });
  assert.ok(result.isError, '没选配方应该报错');
  assert.match(result.content[0].text, /还没选要改的配方/, '报错要说明是没选配方');
  assert.equal(result.structuredContent.code, 'McBadArgs');
});
