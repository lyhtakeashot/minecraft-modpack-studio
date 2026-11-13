/**
 * 把「动图贴图」裁成第一帧。
 *
 * 为什么需要这个：Minecraft 的动态贴图就是把 N 帧竖着排成一张 PNG
 * （`textures/block/lava_still.png` = 16×320，20 帧；`water_still.png` = 16×512，32 帧）。
 * 数据库里那套「按普通方形图标显示」的做法，会把整条竖图挤进 22×22 的框里，
 * 结果是一条糊掉的橙色/蓝色细线 —— 用户看到的就是「这个物品没有图标」。
 *
 * 这里不引入任何第三方库：自己解 PNG（IHDR + IDAT，反滤波），只保留前
 * `宽` 行像素，再重新压一遍。只支持 8 位深、非隔行的常见格式（Minecraft
 * 的贴图全是这一类）；遇到别的格式返回 null，调用方退回原图。
 */

import zlib from 'node:zlib';

/** @type {Uint32Array|null} */
let crcTable = null;

function crcOf(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crcOf(Buffer.concat([Buffer.from(type, 'ascii'), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * 读 PNG 头，拿宽高与格式。
 * @param {Buffer} buf
 * @returns {{width: number, height: number, bitDepth: number, colorType: number, interlace: number}|null}
 */
export function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
  const sig = buf.subarray(0, 8);
  if (sig[0] !== 0x89 || sig.toString('ascii', 1, 4) !== 'PNG') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

/** 每个像素几个通道（按 colorType）。 */
function channelsOf(colorType) {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 3) return 1;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 0;
}

/**
 * 一行像素占多少字节、滤波时「左边一个像素」隔多少字节。
 *
 * 注意调色板图（colorType 3）常常是 4 位甚至 2 位深：一行 `16×4/8 = 8` 字节，
 * 但滤波的 bpp 仍然是 1 字节（PNG 规范：位深不足 8 时按 1 算）。
 * `water_still.png` 就是 4 位调色板图 —— 只按 8 位处理会整片解不出来。
 */
function layoutOf(info) {
  const ch = channelsOf(info.colorType);
  if (!ch) return null;
  const bitsPerPixel = ch * info.bitDepth;
  return {
    bpp: Math.max(1, Math.floor(bitsPerPixel / 8)),
    rowLen: Math.ceil((info.width * bitsPerPixel) / 8),
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 动图贴图很可能就是「竖着排的帧」。判断够不够格裁。
 * @param {Buffer} buf
 * @returns {{frames: number, size: number}|null} 不是动图返回 null
 */
export function animatedFrames(buf) {
  const info = pngInfo(buf);
  if (!info) return null;
  const { width, height } = info;
  if (!width || width < 2 || height <= width) return null;
  if (height % width !== 0) return null;
  const frames = height / width;
  // 帧数太离谱的多半是超长贴图（比如整条菜单），不是动图
  if (frames < 2 || frames > 64) return null;
  return { frames, size: width };
}

/**
 * 取第一帧，返回新的 PNG Buffer。
 * 不是动图、格式不支持、解压失败 → 返回 null（调用方用原图）。
 * @param {Buffer} buf
 */
export function pngFirstFrame(buf) {
  const anim = animatedFrames(buf);
  if (!anim) return null;
  const info = pngInfo(buf);
  if (!info || info.interlace !== 0) return null;
  const layout = layoutOf(info);
  if (!layout) return null;
  const { bpp, rowLen } = layout;

  // 把 IHDR / PLTE / tRNS / IDAT / IEND 拆开
  let off = 8;
  const idats = [];
  let ihdr = null;
  let plte = null;
  let trns = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = body;
    else if (type === 'IDAT') idats.push(body);
    else if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr || idats.length === 0) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idats));
  } catch {
    return null;
  }
  if (raw.length < (rowLen + 1) * info.height) return null;

  // 反滤波前 `width` 行（第一帧）
  const out = Buffer.alloc((rowLen + 1) * info.width);
  let prev = Buffer.alloc(rowLen);
  for (let y = 0; y < info.width; y += 1) {
    const filter = raw[y * (rowLen + 1)];
    const line = raw.subarray(y * (rowLen + 1) + 1, (y + 1) * (rowLen + 1));
    const cur = Buffer.alloc(rowLen);
    for (let x = 0; x < rowLen; x += 1) {
      const left = x >= bpp ? cur[x - bpp] : 0;
      const up = prev[x];
      const upLeft = x >= bpp ? prev[x - bpp] : 0;
      const v = line[x];
      let val;
      if (filter === 0) val = v;
      else if (filter === 1) val = v + left;
      else if (filter === 2) val = v + up;
      else if (filter === 3) val = v + ((left + up) >> 1);
      else if (filter === 4) val = v + paeth(left, up, upLeft);
      else return null;
      cur[x] = val & 0xff;
    }
    out[y * (rowLen + 1)] = 0; // 滤波类型统一写成 0，省得再算
    cur.copy(out, y * (rowLen + 1) + 1);
    prev = cur;
  }

  const newIhdr = Buffer.from(ihdr);
  newIhdr.writeUInt32BE(info.width, 4); // 高度 = 宽度（一帧）

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', newIhdr),
  ];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', zlib.deflateSync(out, { level: 9 })));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** 把 PNG 拆成「IHDR / IDAT / PLTE / tRNS」四样，解码与裁帧都要用。 */
function splitPng(buf) {
  let off = 8;
  const idats = [];
  let ihdr = null;
  let plte = null;
  let trns = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = body;
    else if (type === 'IDAT') idats.push(body);
    else if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr || idats.length === 0) return null;
  return { ihdr, idats, plte, trns };
}

/**
 * 反滤波，返回「每行前面补了一个 0（滤波类型）」的原始字节。
 * @returns {Buffer|null}
 */
function unfilterAll(raw, info, layout) {
  const { bpp, rowLen } = layout;
  if (raw.length < (rowLen + 1) * info.height) return null;
  const out = Buffer.alloc((rowLen + 1) * info.height);
  let prev = Buffer.alloc(rowLen);
  for (let y = 0; y < info.height; y += 1) {
    const filter = raw[y * (rowLen + 1)];
    const line = raw.subarray(y * (rowLen + 1) + 1, (y + 1) * (rowLen + 1));
    const cur = Buffer.alloc(rowLen);
    for (let x = 0; x < rowLen; x += 1) {
      const left = x >= bpp ? cur[x - bpp] : 0;
      const up = prev[x];
      const upLeft = x >= bpp ? prev[x - bpp] : 0;
      const v = line[x];
      let val;
      if (filter === 0) val = v;
      else if (filter === 1) val = v + left;
      else if (filter === 2) val = v + up;
      else if (filter === 3) val = v + ((left + up) >> 1);
      else if (filter === 4) val = v + paeth(left, up, upLeft);
      else return null;
      cur[x] = val & 0xff;
    }
    out[y * (rowLen + 1)] = 0; // 统一成「无滤波」，后面按 stride 直接读
    cur.copy(out, y * (rowLen + 1) + 1);
    prev = cur;
  }
  return out;
}

/**
 * 解码成 RGBA（每像素 4 字节，非预乘）。
 *
 * 为什么需要它：等轴测渲染要把贴图当成「像素画」逐像素取色，光有 PNG 字节没用。
 * 支持 8/16 位灰度、RGB、索引色（1/2/4/8 位深都支持，`water_still.png` 就是 4 位调色板）、
 * 灰度+alpha、RGBA；不支持隔行扫描（贴图基本都不是）。
 *
 * @param {Buffer} buf
 * @returns {{width: number, height: number, rgba: Buffer}|null}
 */
export function pngPixels(buf) {
  const info = pngInfo(buf);
  if (!info || info.interlace !== 0) return null;
  const layout = layoutOf(info);
  if (!layout) return null;
  const parts = splitPng(buf);
  if (!parts) return null;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(parts.idats));
  } catch {
    return null;
  }
  const rows = unfilterAll(raw, info, layout);
  if (!rows) return null;

  const { width, height } = info;
  const stride = layout.rowLen + 1;
  const rgba = Buffer.alloc(width * height * 4);
  const depth = info.bitDepth;
  const type = info.colorType;
  // 调色板
  let palette = null;
  let paletteAlpha = null;
  if (type === 3) {
    if (!parts.plte) return null;
    palette = parts.plte;
    paletteAlpha = parts.trns ?? null;
  }

  for (let y = 0; y < height; y += 1) {
    const rowOff = y * stride + 1;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (type === 3) {
        let idx;
        if (depth === 8) idx = rows[rowOff + x];
        else {
          const bitPer = depth;
          const perByte = 8 / bitPer;
          const byte = rows[rowOff + Math.floor(x / perByte)];
          const shift = 8 - bitPer * ((x % perByte) + 1);
          idx = (byte >> shift) & ((1 << bitPer) - 1);
        }
        const p = idx * 3;
        if (p + 2 >= palette.length) continue;
        rgba[o] = palette[p];
        rgba[o + 1] = palette[p + 1];
        rgba[o + 2] = palette[p + 2];
        rgba[o + 3] = paletteAlpha && idx < paletteAlpha.length ? paletteAlpha[idx] : 255;
        continue;
      }
      if (type === 0) {
        let g;
        if (depth === 8) g = rows[rowOff + x];
        else if (depth === 16) g = rows[rowOff + x * 2];
        else {
          const perByte = 8 / depth;
          const byte = rows[rowOff + Math.floor(x / perByte)];
          const shift = 8 - depth * ((x % perByte) + 1);
          const v = (byte >> shift) & ((1 << depth) - 1);
          g = Math.round((v * 255) / ((1 << depth) - 1));
        }
        rgba[o] = g;
        rgba[o + 1] = g;
        rgba[o + 2] = g;
        rgba[o + 3] = 255;
        continue;
      }
      const ch = channelsOf(type);
      const step = depth === 16 ? 2 : 1;
      const base = rowOff + x * ch * step;
      if (type === 2) {
        rgba[o] = rows[base];
        rgba[o + 1] = rows[base + step];
        rgba[o + 2] = rows[base + step * 2];
        rgba[o + 3] = 255;
      } else if (type === 4) {
        const g = rows[base];
        rgba[o] = g;
        rgba[o + 1] = g;
        rgba[o + 2] = g;
        rgba[o + 3] = rows[base + step];
      } else if (type === 6) {
        rgba[o] = rows[base];
        rgba[o + 1] = rows[base + step];
        rgba[o + 2] = rows[base + step * 2];
        rgba[o + 3] = rows[base + step * 3];
      }
    }
  }
  return { width, height, rgba };
}

/**
 * 把 RGBA 编成 PNG（8 位真彩 + alpha，不隔行）。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须是 width*height*4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowLen + 1)] = 0;
    rgba.copy(raw, y * (rowLen + 1) + 1, y * rowLen, (y + 1) * rowLen);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}