/**
 * 「读游戏导出的图标」核心逻辑测试。
 *
 * 这一段最容易错的是**文件名解析**（真实导出目录里有一堆变体）和
 * **优先级**（有导出目录时必须先用它，不能还去翻 jar）。
 * 所以夹具照真实目录的样子造：普通物品、NBT 变体、流体、非 png。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildExportIndex,
  describeExportIndex,
  findExportDirs,
  parseExportName,
  readExportedIcons,
  resetExportCache,
} from '../packages/core/icon-export.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcstudio-xport-${tag}-`));
}

/** 造一个实例目录 + 一个导出目录。 */
function fixture(files, dirName = 'icon-exports-x64') {
  const instanceDir = path.join(tmp('inst'));
  const outDir = path.join(instanceDir, dirName);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(outDir, name), body ?? PNG);
  }
  return { instanceDir, outDir, instance: { instanceDir, mcRoot: instanceDir } };
}

test('parseExportName：普通 / NBT 变体 / 流体 / 非法名', () => {
  assert.deepEqual(parseExportName('create__cogwheel'), { id: 'create:cogwheel', variant: false });
  assert.deepEqual(parseExportName('minecraft__copper_ingot'), { id: 'minecraft:copper_ingot', variant: false });

  // NBT 变体的尾巴里还会再出现 __，只取前两段
  assert.deepEqual(
    parseExportName("create__copper_backtank__{.create__banktank_air.__900}"),
    { id: 'create:copper_backtank', variant: true },
  );

  // 流体的第一段是字面量 fluid，不是命名空间
  assert.equal(parseExportName('fluid__create__chocolate'), null);
  assert.equal(parseExportName('nounderscores'), null);
  assert.equal(parseExportName('__name'), null);
  assert.equal(parseExportName('bad ns__thing'), null);
});

test('findExportDirs 同时看实例目录和 mcRoot，且认得不同尺寸后缀', () => {
  resetExportCache();
  const { instanceDir, outDir } = fixture({ 'demo__a.png': PNG });
  fs.mkdirSync(path.join(instanceDir, 'icon-exports-128'), { recursive: true });

  const dirs = findExportDirs({ instanceDir, mcRoot: instanceDir });
  assert.equal(dirs.length, 2, '两个尺寸都该认出来');
  assert.ok(dirs.includes(outDir));
  assert.ok(dirs.every((d) => path.basename(d).startsWith('icon-exports')));
});

test('findExportDirs 没有导出目录时返回空数组，不抛异常', () => {
  resetExportCache();
  const instanceDir = path.join(tmp('empty'), 'nope');
  assert.deepEqual(findExportDirs({ instanceDir }), []);
  assert.deepEqual(findExportDirs({}), []);
});

test('buildExportIndex：多文件、跳过流体、变体只留一个、统计字节', () => {
  resetExportCache();
  const { outDir, instance } = fixture({
    'create__cogwheel.png': PNG,
    "create__cogwheel__{.x.__1}.png": PNG, // 变体，不该覆盖也不该多算
    'minecraft__dirt.png': PNG,
    'fluid__create__water.png': PNG,
    'readme.txt': 'ignore me',
  });
  const index = buildExportIndex(findExportDirs(instance));

  assert.equal(index.count, 2, 'cogwheel + dirt');
  assert.ok(index.files.has('create:cogwheel'));
  assert.ok(index.files.has('minecraft:dirt'));
  assert.equal(index.skipped, 1, '流体那张算跳过');
  assert.equal(index.totalBytes, PNG.length * 2);
  assert.equal(index.dirs[0], outDir);
  assert.ok(index.elapsedMs >= 0);
});

test('buildExportIndex 走缓存；force 强制重扫', () => {
  resetExportCache();
  const { outDir, instance } = fixture({ 'demo__a.png': PNG });
  const dirs = findExportDirs(instance);
  assert.equal(buildExportIndex(dirs).count, 1);

  fs.writeFileSync(path.join(outDir, 'demo__b.png'), PNG);
  assert.equal(buildExportIndex(dirs).count, 1, '没过期就走缓存');
  assert.equal(buildExportIndex(dirs, { force: true }).count, 2, 'force 要重新扫');
});

test('readExportedIcons 出 data URL，缺的进 missing', () => {
  resetExportCache();
  const { instance } = fixture({ 'demo__a.png': PNG });
  const index = buildExportIndex(findExportDirs(instance));
  const r = readExportedIcons(index.files, ['demo:a', 'demo:missing']);

  assert.equal(r.icons.size, 1);
  assert.match(r.icons.get('demo:a').dataUrl, /^data:image\/png;base64,/);
  assert.equal(r.icons.get('demo:a').bytes, PNG.length);
  assert.match(r.icons.get('demo:a').source, /游戏导出/);
  assert.deepEqual(r.missing, ['demo:missing']);
});

test('describeExportIndex 两种状态都说人话', () => {
  assert.match(describeExportIndex(null), /还没有游戏导出的图标/);
  assert.match(describeExportIndex({ count: 0 }), /还没有游戏导出的图标/);
  const text = describeExportIndex({ count: 1895, totalBytes: 3.7 * 1048576, dirs: ['x'] });
  assert.match(text, /1895 个/);
  assert.match(text, /3\.7 MB/);
});