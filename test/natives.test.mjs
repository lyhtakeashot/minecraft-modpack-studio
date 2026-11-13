/**
 * natives 解压：这是启动必需的一步，错了就是 lwjgl.dll 找不到、进程秒退。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeZip } from './make-zip.mjs';
import { extractNatives, describeNatives } from '../packages/core/natives.js';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcstudio-natives-${tag}-`));
}

/** 造一个像 lwjgl natives 的 jar：根目录有 dll，子目录也有，还有 META-INF。 */
function makeNativesJar(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, makeZip({
    'lwjgl.dll': 'fake-lwjgl-dll',
    'windows/x64/glfw.dll': 'fake-glfw-dll',
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0',
    'META-INF/versions/9/module-info.class': 'not-a-native',
  }));
  return file;
}

test('把库文件解到根层，并跳过 META-INF', () => {
  const dir = tmpDir('basic');
  const jar = makeNativesJar(dir, 'lwjgl-natives-windows.jar');
  const out = path.join(dir, 'natives');

  const r = extractNatives([jar], out);

  assert.equal(r.jars, 1);
  assert.equal(r.missingJars, 0);
  assert.deepEqual(r.files, ['glfw.dll', 'lwjgl.dll'], '子目录里的 dll 要拍平到根层');
  assert.equal(fs.readFileSync(path.join(out, 'lwjgl.dll'), 'utf8'), 'fake-lwjgl-dll');
  assert.ok(fs.existsSync(path.join(out, 'glfw.dll')), 'java.library.path 不递归，必须平铺');
  assert.equal(fs.existsSync(path.join(out, 'MANIFEST.MF')), false, 'META-INF 里的东西不该落盘');
  assert.equal(fs.existsSync(path.join(out, 'windows')), false, '不该保留子目录');
});

test('重复解压会先清空，不留上一轮的残留', () => {
  const dir = tmpDir('clean');
  const jar = makeNativesJar(dir, 'j.jar');
  const out = path.join(dir, 'natives');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, '旧文件.dll'), 'stale');

  extractNatives([jar], out);

  assert.equal(fs.existsSync(path.join(out, '旧文件.dll')), false, '旧库留着会让 JVM 加载错版本');
});

test('dryRun 只算不写', () => {
  const dir = tmpDir('dry');
  const jar = makeNativesJar(dir, 'j.jar');
  const out = path.join(dir, 'natives');

  const r = extractNatives([jar], out, { dryRun: true });

  assert.equal(r.dryRun, true);
  assert.equal(r.files.length, 2);
  assert.equal(fs.existsSync(out), false, 'dry-run 不该建目录');
});

test('jar 不见了如实报告，不抛异常', () => {
  const dir = tmpDir('missing');
  const out = path.join(dir, 'natives');

  const r = extractNatives([path.join(dir, '没有这个.jar')], out);

  assert.equal(r.jars, 0);
  assert.equal(r.missingJars, 1);
  assert.deepEqual(r.files, []);
  assert.match(describeNatives(r), /没有可解压的 jar/);
});

test('摘要里带上文件数与体积', () => {
  const dir = tmpDir('desc');
  const jar = makeNativesJar(dir, 'j.jar');
  const r = extractNatives([jar], path.join(dir, 'natives'));
  const text = describeNatives(r);
  assert.match(text, /解压 1 个 jar → 2 个文件/);
});