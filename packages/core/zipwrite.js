/**
 * 纯 Node 的 ZIP 写入（零依赖，流式）。
 *
 * 为什么要手写：和 `zip.js` 一样，本项目不许引外部依赖，而导出整合包必须能写 zip。
 *
 * 设计取舍：
 *  - **流式**：整包动辄几个 GB，不能一次读进内存。每个文件「写头 → 流式压 → 回填头」。
 *  - **先写占位头再回填**：crc32 和压缩后大小只有读完才知道，用 `writeSync` 按偏移回填，
 *    比先压缩到临时文件再拼要省一次全量 IO。
 *  - **按扩展名选压缩方式**：jar/png/ogg 这类已经压过的直接 store(0)，省 CPU 且体积几乎不变。
 *  - **ZIP64**：条目 > 4 GiB 或偏移越界时写 ZIP64 扩展字段。虽然导出通常到不了，
 *    但整合包带 assets 时很容易超，写错了整个包就是坏包，不能赌。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const U32_MAX = 0xffffffff;

/** 已经压缩过的格式：再压没意义，直接存。 */
const STORE_EXT = new Set([
  '.jar', '.zip', '.png', '.jpg', '.jpeg', '.ogg', '.oga', '.mp3', '.zst', '.gz',
  '.mrpack', '.webp', '.gif', '.mp4', '.7z', '.rar',
]);

let CRC_TABLE = null;
function crcTable() {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  return CRC_TABLE;
}

/** 增量 CRC32 的起点（内部约定：用 -1 表示「还没开始」）。 */
export const crc32Init = () => -1;

export function crc32Update(crc, buf) {
  const t = crcTable();
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff];
  return c;
}

export const crc32Final = (crc) => (crc ^ -1) >>> 0;

/** 一次性算一段数据的 crc32。 */
export function crc32(buf) {
  return crc32Final(crc32Update(crc32Init(), buf));
}

function dosDateTime(d = new Date()) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** ZIP64 扩展字段（header id 0x0001）。values 按 usize/csize/offset 的次序给。 */
function zip64Extra(values) {
  const body = Buffer.alloc(8 * values.length);
  values.forEach((v, i) => body.writeBigUInt64LE(BigInt(v), i * 8));
  const head = Buffer.alloc(4);
  head.writeUInt16LE(0x0001, 0);
  head.writeUInt16LE(body.length, 2);
  return Buffer.concat([head, body]);
}

function shouldStore(name) {
  return STORE_EXT.has(path.extname(name).toLowerCase());
}

/**
 * 流式写一个 zip。
 *
 * 用法：
 *   const w = new ZipWriter('out.zip');
 *   await w.open();
 *   await w.addFile('mods/x.jar', 'D:/.../x.jar');
 *   await w.addText('manifest.json', '{...}');
 *   await w.close();
 */
export class ZipWriter {
  constructor(file) {
    this.file = file;
    this.fd = null;
    this.offset = 0;
    this.entries = [];
    this.needZip64 = false;
    this.bytesWritten = 0;
  }

  async open() {
    fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    this.fd = fs.openSync(this.file, 'w');
    this.offset = 0;
    return this;
  }

  _write(buf) {
    fs.writeSync(this.fd, buf, 0, buf.length, this.offset);
    this.offset += buf.length;
    this.bytesWritten += buf.length;
  }

  _patch(buf, at) {
    fs.writeSync(this.fd, buf, 0, buf.length, at);
  }

  /**
   * 加一个磁盘文件。name 是包内路径（用 `/` 分隔）。
   * @param {string} name
   * @param {string} absPath
   * @param {{method?: number}} [opts]
   */
  async addFile(name, absPath, opts = {}) {
    const st = fs.statSync(absPath);
    const usize = st.size;
    const method = opts.method ?? (shouldStore(name) ? 0 : 8);
    const { time, date } = dosDateTime(st.mtime);
    return this._add(name, usize, method, time, date, async (onChunk) => {
      const rs = fs.createReadStream(absPath, { highWaterMark: 1 << 20 });
      await this._pump(rs, method, onChunk);
    });
  }

  /** 加一段内存数据（小文件用，比如 manifest）。 */
  async addBuffer(name, data, opts = {}) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const method = opts.method ?? (shouldStore(name) ? 0 : 8);
    const { time, date } = dosDateTime();
    return this._add(name, raw.length, method, time, date, async (onChunk) => {
      if (method === 0) onChunk(raw);
      else onChunk(zlib.deflateRawSync(raw, { level: 6 }));
    });
  }

  async addText(name, text) {
    return this.addBuffer(name, text);
  }

  /** 把可读流喂给 deflate/store，逐块回调。 */
  async _pump(rs, method, onChunk) {
    if (method === 0) {
      for await (const chunk of rs) onChunk(chunk);
      return;
    }
    const deflate = zlib.createDeflateRaw({ level: 6 });
    rs.pipe(deflate);
    for await (const chunk of deflate) onChunk(chunk);
  }

  async _add(name, usize, method, time, date, producer) {
    const nameBuf = Buffer.from(name, 'utf8');
    const headerOffset = this.offset;
    const need64 = usize >= U32_MAX;
    if (need64) this.needZip64 = true;

    const extra = need64 ? zip64Extra([usize, 0]) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(need64 ? 45 : 20, 4);
    header.writeUInt16LE(0x0800, 6); // bit 11 = 文件名 UTF-8
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14); // crc，回填
    header.writeUInt32LE(need64 ? U32_MAX : 0, 18);
    header.writeUInt32LE(need64 ? U32_MAX : 0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extra.length, 28);

    this._write(header);
    this._write(nameBuf);
    if (extra.length) this._write(extra);

    let crc = crc32Init();
    let csize = 0;
    await producer((chunk) => {
      crc = crc32Update(crc, chunk);
      this._write(chunk);
      csize += chunk.length;
    });
    const crcVal = crc32Final(crc);

    if (csize >= U32_MAX) {
      // 极少见（单文件压完还超 4 GiB），此时本地头也要按 zip64 处理
      throw new Error(`文件过大，超过 4 GiB 的条目暂不支持：${name}`);
    }

    const fix = Buffer.alloc(12);
    fix.writeUInt32LE(crcVal, 0);
    fix.writeUInt32LE(csize, 4);
    fix.writeUInt32LE(usize, 8);
    this._patch(fix, headerOffset + 14);

    if (need64) {
      // 本地头 extra 的值区：header(30) + name + id(2) + size(2)
      const valAt = headerOffset + 30 + nameBuf.length + 4;
      const v = Buffer.alloc(8);
      v.writeBigUInt64LE(BigInt(usize), 0);
      this._patch(v, valAt);
      const v2 = Buffer.alloc(8);
      v2.writeBigUInt64LE(BigInt(csize), 0);
      this._patch(v2, valAt + 8);
    }

    this.entries.push({ name, method, time, date, crc: crcVal, csize, usize, headerOffset, need64 });
    return { name, usize, csize };
  }

  /** 写中央目录 + 结尾记录，然后关闭。 */
  async close() {
    const cenStart = this.offset;
    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const z64 = [];
      if (e.need64) {
        z64.push(e.usize, e.csize, e.headerOffset);
      }
      const extra = z64.length ? zip64Extra(z64) : Buffer.alloc(0);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4);
      cen.writeUInt16LE(e.need64 ? 45 : 20, 6);
      cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(e.method, 10);
      cen.writeUInt16LE(e.time, 12);
      cen.writeUInt16LE(e.date, 14);
      cen.writeUInt32LE(e.crc, 16);
      cen.writeUInt32LE(e.need64 ? U32_MAX : e.csize, 20);
      cen.writeUInt32LE(e.need64 ? U32_MAX : e.usize, 24);
      cen.writeUInt16LE(nameBuf.length, 28);
      cen.writeUInt16LE(extra.length, 30);
      cen.writeUInt16LE(0, 32);
      cen.writeUInt16LE(0, 34);
      cen.writeUInt16LE(0, 36);
      cen.writeUInt32LE(0, 38);
      cen.writeUInt32LE(e.need64 ? U32_MAX : e.headerOffset, 42);
      this._write(cen);
      this._write(nameBuf);
      if (extra.length) this._write(extra);
    }
    const cenSize = this.offset - cenStart;

    const tooMany = this.entries.length >= 0xffff;
    const needZ64End = this.needZip64 || tooMany || cenStart >= U32_MAX || cenSize >= U32_MAX;

    if (needZ64End) {
      const z64End = Buffer.alloc(56);
      z64End.writeUInt32LE(0x06064b50, 0);
      z64End.writeBigUInt64LE(44n, 4);
      z64End.writeUInt16LE(45, 12);
      z64End.writeUInt16LE(45, 14);
      z64End.writeUInt32LE(0, 16);
      z64End.writeUInt32LE(0, 20);
      z64End.writeBigUInt64LE(BigInt(this.entries.length), 24);
      z64End.writeBigUInt64LE(BigInt(this.entries.length), 32);
      z64End.writeBigUInt64LE(BigInt(cenSize), 40);
      z64End.writeBigUInt64LE(BigInt(cenStart), 48);
      this._write(z64End);

      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(cenStart + cenSize), 8);
      loc.writeUInt32LE(1, 16);
      this._write(loc);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(this.entries.length, 0xffff), 8);
    end.writeUInt16LE(Math.min(this.entries.length, 0xffff), 10);
    end.writeUInt32LE(Math.min(cenSize, U32_MAX), 12);
    end.writeUInt32LE(Math.min(cenStart, U32_MAX), 16);
    end.writeUInt16LE(0, 20);
    this._write(end);

    fs.closeSync(this.fd);
    this.fd = null;
    return { file: this.file, entries: this.entries.length, bytes: this.offset };
  }
}
