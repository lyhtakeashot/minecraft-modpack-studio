/**
 * instance / index 的单测。不需要真实例，用内存构造的最小样本。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLoader, detectMcVersion, flattenGameArgs, parseModMeta, inspectInstance } from '../packages/core/instance.js';
import { openZip } from '../packages/core/zip.js';
import { makeZip } from './make-zip.mjs';

test('detectLoader: 从 --fml.neoForgeVersion 认出 NeoForge 版本', () => {
  // 实测：NeoForge 的版本 json 里没有 net.neoforged:neoforge 这条 library
  const json = {
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: [{ name: 'net.neoforged.fancymodloader:loader:4.0.42' }, { name: 'net.neoforged:bus:8.0.5' }],
    arguments: { game: ['--fml.neoForgeVersion', '21.1.228'] },
  };
  const r = detectLoader(json, flattenGameArgs(json));
  assert.equal(r.loader, 'neoforge');
  assert.equal(r.version, '21.1.228');
});

test('detectLoader: Forge 1.20.1 也用 BootstrapLauncher，但 libraries 带 minecraftforge', () => {
  const json = {
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: [{ name: 'net.minecraftforge:forge:47.2.0' }],
    arguments: { game: ['--fml.forgeVersion', '47.2.0'] },
  };
  const r = detectLoader(json, flattenGameArgs(json));
  assert.equal(r.loader, 'forge');
  assert.equal(r.version, '47.2.0');
});

test('detectLoader: 没加载器时是 vanilla', () => {
  assert.equal(detectLoader({ libraries: [] }, []).loader, 'vanilla');
});

test('detectMcVersion: 优先 --fml.mcVersion', () => {
  const json = { arguments: { game: ['--fml.mcVersion', '1.21.1'] } };
  assert.equal(detectMcVersion(json, 'x'), '1.21.1');
});

test('detectMcVersion: 没有参数时从 NeoForge 版本号 21.1.228 反推 1.21.1', () => {
  const json = { libraries: [{ name: 'net.neoforged:neoforge:21.1.228' }] };
  assert.equal(detectMcVersion(json, 'x'), '1.21.1');
});

test('detectMcVersion: 兜底从实例名里抓版本号', () => {
  assert.equal(detectMcVersion({}, 'MyPack-1.20.1-forge'), '1.20.1');
});

test('parseModMeta: 多行 TOML', () => {
  const zip = openZip(makeZip({
    'META-INF/neoforge.mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="create"\ndisplayName="Create"\nversion="6.0.10"\n',
  }));
  const m = parseModMeta(zip);
  assert.equal(m.modId, 'create');
  assert.equal(m.name, 'Create');
  assert.equal(m.version, '6.0.10');
});

test('parseModMeta: 内联表 TOML（Modrinth 导出的数据包写法）', () => {
  // 实测：DnT / lukis-crazy-chambers 用这种一行内联表，且有单引号
  const zip = openZip(makeZip({
    'META-INF/neoforge.mods.toml': "[mods]\n\t{ modId = 'mr_lukis_crazychambers', version = '1.0.2', displayName = \"Luki's Crazy Chambers\" }\n",
  }));
  const m = parseModMeta(zip);
  assert.equal(m.modId, 'mr_lukis_crazychambers');
  assert.equal(m.version, '1.0.2');
  assert.equal(m.name, "Luki's Crazy Chambers");
});

test('parseModMeta: 回退到 fabric.mod.json', () => {
  const zip = openZip(makeZip({ 'fabric.mod.json': JSON.stringify({ id: 'sodium', name: 'Sodium', version: '0.5.8' }) }));
  const m = parseModMeta(zip);
  assert.equal(m.modId, 'sodium');
  assert.equal(m.source, 'fabric');
});

test('parseModMeta: 三者都没有时返回空且不抛', () => {
  const m = parseModMeta(openZip(makeZip({ 'a.txt': 'x' })));
  assert.equal(m.modId, '');
  assert.equal(m.source, '');
});

/**
 * 造一个 versions 布局的临时实例树。shape:
 *   { '子id': {json}, '父id': {json}, ... }
 * 每个值直接就是要写进 <id>/<id>.json 的对象。
 * 返回 { root, mcRoot }。
 */
function fakeVersionTree(tag, shape) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mcstudio-inherit-${tag}-`));
  const mcRoot = path.join(root, 'minecraft');
  for (const [id, json] of Object.entries(shape)) {
    const dir = path.join(mcRoot, 'versions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(json));
  }
  return { root, mcRoot };
}

test('inheritsFrom: 空壳子版本能认出父版本里的加载器与 MC 版本（2026-11-04 真 bug）', () => {
  // 复现 lab/_forge1201：子 json 只有 id/inheritsFrom/type，真正的信息全在父里。
  const { mcRoot } = fakeVersionTree('basic', {
    Forge1201: { id: 'Forge1201', inheritsFrom: '1.20.1-forge-47.4.28', type: 'release' },
    '1.20.1-forge-47.4.28': {
      id: '1.20.1-forge-47.4.28',
      mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
      libraries: [{ name: 'net.minecraftforge:forge:47.4.28' }],
      arguments: { game: ['--fml.forgeVersion', '47.4.28', '--fml.mcVersion', '1.20.1'] },
    },
  });
  const list = inspectInstance(mcRoot);
  const child = list.find((i) => i.id === 'Forge1201');
  assert.ok(child, '应该认出子实例');
  assert.equal(child.mcVersion, '1.20.1');
  assert.equal(child.loader, 'forge');
  assert.equal(child.loaderVersion, '47.4.28');
  assert.equal(child.mainClass, 'cpw.mods.bootstraplauncher.BootstrapLauncher');
  // 父实例本身不能被改坏
  const parent = list.find((i) => i.id === '1.20.1-forge-47.4.28');
  assert.equal(parent.loader, 'forge');
});

test('inheritsFrom: 多层继承（子 → Forge → 原版）逐层合并 libraries 与 game 参数', () => {
  const { mcRoot } = fakeVersionTree('multi', {
    MyPack: { id: 'MyPack', inheritsFrom: 'forge-layer', type: 'release' },
    'forge-layer': {
      id: 'forge-layer', inheritsFrom: '1.20.1',
      libraries: [{ name: 'net.minecraftforge:forge:47.4.28' }],
      arguments: { game: ['--fml.forgeVersion', '47.4.28', '--fml.mcVersion', '1.20.1'] },
    },
    '1.20.1': {
      id: '1.20.1',
      libraries: [{ name: 'com.mojang:minecraft:1.20.1' }],
      arguments: { game: ['--username', 'Dev'] },
    },
  });
  const child = inspectInstance(mcRoot).find((i) => i.id === 'MyPack');
  assert.equal(child.loader, 'forge');
  assert.equal(child.loaderVersion, '47.4.28');
  assert.equal(child.mcVersion, '1.20.1');
  // 父的 libraries 也应该能被看见（三层都合进来了），这里用第二个识别点确认没把父信息丢掉
  const forge = inspectInstance(mcRoot).find((i) => i.id === 'forge-layer');
  assert.equal(forge.loader, 'forge');
});

test('inheritsFrom: 父版本 json 缺失时容错返回当前层，不炸探测', () => {
  const { mcRoot } = fakeVersionTree('missing', {
    Orphan: { id: 'Orphan', inheritsFrom: '不存在的父', mainClass: 'net.minecraft.client.main.Main', libraries: [{ name: 'com.mojang:minecraft:1.20.1' }] },
  });
  const child = inspectInstance(mcRoot).find((i) => i.id === 'Orphan');
  assert.ok(child, '父缺失也要能把实例列出来');
  assert.equal(child.loader, 'vanilla');
  assert.equal(child.mcVersion, '1.20.1');
});

test('inheritsFrom: 成环时 depth 上限保护不栈溢出', () => {
  const { mcRoot } = fakeVersionTree('cycle', {
    A: { id: 'A', inheritsFrom: 'B', libraries: [{ name: 'net.minecraftforge:forge:47.2.0' }] },
    B: { id: 'B', inheritsFrom: 'A', arguments: { game: ['--fml.mcVersion', '1.20.1'] } },
  });
  // 不该抛异常，能列出实例即可
  const list = inspectInstance(mcRoot);
  assert.equal(list.length, 2);
});
