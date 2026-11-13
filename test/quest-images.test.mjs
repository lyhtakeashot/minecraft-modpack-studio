// quest-images：任务书章节背景图的资源解析（jar 里抠 PNG）。
//
// FTB Quests 章节 images 写的是资源 ID（`ns:path`），真图在 mod jar 的
// assets/<ns>/<路径> 里。这里用一个手工 zip（openZip 能读的最小 zip）
// 验证：候选路径展开、命中读取、找不到的静默丢弃、缓存生效。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetCandidates, resolveQuestImages, resetQuestImageCaches } from '../packages/core/quest-images.js';
import { openZip } from '../packages/core/zip.js';

/** 造一个最小可用 zip：local file header + central directory 都能被 openZip 读。 */
export function makeZip(entries) {
  // 偷懒：借助 zip 本身的格式，把「一个条目」的 zip 手工拼出来有点长 ——
  // 这里用现成工具思路：node 没内置 zip，测试桩直接用已压缩的 22 字节 empty zip + append。
  // 更省事的路子：用 openZip 自己验证 round-trip 太绕，直接手拼一个 store（不压缩）zip。
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date（随便给个合法值）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    chunks.push(local, data);
    central.push({ nameBytes, crc, size: data.length, offset });
    offset += local.length + data.length;
  }
  const centralStart = offset;
  for (const c of central) {
    const cd = Buffer.alloc(46 + c.nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(c.crc, 16);
    cd.writeUInt32LE(c.size, 20);
    cd.writeUInt32LE(c.size, 24);
    cd.writeUInt16LE(c.nameBytes.length, 28);
    cd.writeUInt32LE(c.offset, 42);
    c.nameBytes.copy(cd, 46);
    chunks.push(cd);
    offset += cd.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12);
  eocd.writeUInt32LE(centralStart, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** 一张 1x1 红色 PNG（最小合法 PNG，手写常量）。 */
export const RED_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080200000090775' +
    '3de0000000c4944415408d763f8cfc00000030101' + '00cb5e3b6c0000000049454e44ae426082',
  'hex',
);

function makeInstance(tmp) {
  const modsDir = path.join(tmp, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  return { modsDir, clientJar: '', instanceDir: tmp };
}

test('assetCandidates：全路径 / 缺扩展名 / 缺 textures/ 的候选都展开到', () => {
  assert.deepEqual(assetCandidates('ftbquests:textures/end.png'), ['assets/ftbquests/textures/end.png']);
  assert.deepEqual(assetCandidates('l2hostility:item/curio/charm'), [
    'assets/l2hostility/item/curio/charm',
    'assets/l2hostility/item/curio/charm.png',
    'assets/l2hostility/textures/item/curio/charm.png',
  ]);
  assert.deepEqual(assetCandidates('没有冒号'), []);
  assert.deepEqual(assetCandidates(''), []);
});

test('resolveQuestImages：jar 里的图抠成 data URL，找不到的静默丢弃，缓存生效', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-img-'));
  const modsDir = path.join(tmp, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(
    path.join(modsDir, 'ftbquests.jar'),
    makeZip({ 'assets/ftbquests/textures/end_deep_dark.png': RED_PNG }),
  );

  const instance = makeInstance(tmp);
  const r1 = await resolveQuestImages(instance, [
    'ftbquests:textures/end_deep_dark.png',
    'othermod:textures/missing.png',
  ]);
  assert.equal(Object.keys(r1.images).length, 1, '只有 jar 里有的那张该回来');
  assert.match(r1.images['ftbquests:textures/end_deep_dark.png'], /^data:image\/png;base64,/);
  assert.equal(r1.images['othermod:textures/missing.png'], undefined);

  // 第二次走缓存：即使 jar 删了也照样能回（10 分钟缓存）
  fs.rmSync(path.join(modsDir, 'ftbquests.jar'));
  const r2 = await resolveQuestImages(instance, ['ftbquests:textures/end_deep_dark.png']);
  assert.ok(r2.images['ftbquests:textures/end_deep_dark.png'], '缓存没生效');

  // 空入参不炸
  assert.deepEqual((await resolveQuestImages(instance, [])).images, {});
  resetQuestImageCaches();
});

test('zip round-trip：手拼的 zip openZip 能读（测试桩自检）', () => {
  const zip = openZip(makeZip({ 'a/b.png': RED_PNG }));
  assert.ok(zip.has('a/b.png'));
  assert.deepEqual(zip.read('a/b.png'), RED_PNG);
});
