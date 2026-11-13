import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { animatedFrames, pngFirstFrame, pngInfo } from '../packages/core/png-frame.js';

/** 造一张 16×(16*帧数) 的调色板 PNG（1 位/像素太麻烦，用 8 位 + PLTE）。 */
function makeStrip(width, frames) {
  const height = width * frames;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) row[1 + x] = (Math.floor(y / width) + x) % 4;
    rows.push(row);
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    // 简化：用 zlib.crc32 如果存在，否则 0
    const c = typeof zlib.crc32 === 'function' ? zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) : 0;
    crc.writeUInt32BE(c >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('裁第一帧：竖排动图变成方形', () => {
  const strip = makeStrip(16, 20);
  assert.deepEqual(pngInfo(strip).height, 320);
  assert.equal(animatedFrames(strip).frames, 20);
  const one = pngFirstFrame(strip);
  assert.ok(one);
  const info = pngInfo(one);
  assert.equal(info.width, 16);
  assert.equal(info.height, 16);
});

test('静态方形图不动它', () => {
  const square = makeStrip(16, 1);
  assert.equal(animatedFrames(square), null);
  assert.equal(pngFirstFrame(square), null);
});

test('帧数离谱（像整条菜单）不当动图', () => {
  const tall = makeStrip(8, 200);
  assert.equal(animatedFrames(tall), null);
});
