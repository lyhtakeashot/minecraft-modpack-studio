/**
 * 纯 Node 的 ZIP 读取（零依赖）。
 *
 * 只做本项目需要的事：列中央目录、按条目名取解压后的字节、按条目名读 UTF-8 文本。
 * 支持 store(0) 与 deflate(8)，ZIP64 不处理（MC 的 jar 都远小于 4 GB）。
 *
 * 为什么手写：本项目要求零外部依赖（§7 的约束），而 adm-zip 之类在目标环境里既没有
 * 也不该为了读 jar 而引入。
 */
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/**
 * 打开一个 ZIP 缓冲区，返回一个只读句柄。
 * @param {Buffer} buffer 整个 zip 文件的字节
 * @returns {{names: string[], has(name: string): boolean, read(name: string): Buffer|null, text(name: string): string|null}}
 */
export function openZip(buffer) {
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到中央目录结尾（EOCD）');

  const count = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  /** @type {Map<string, {name: string, method: number, cs: number, lo: number}>} */
  const index = new Map();
  const names = [];

  for (let i = 0; i < count; i++) {
    if (off + 46 > buffer.length || buffer.readUInt32LE(off) !== CEN_SIG) break;
    const nl = buffer.readUInt16LE(off + 28);
    const el = buffer.readUInt16LE(off + 30);
    const cl = buffer.readUInt16LE(off + 32);
    const name = buffer.toString('utf8', off + 46, off + 46 + nl);
    // 同名条目以先出现的为准（zip 允许重复名，jar 里极少见）
    if (!index.has(name)) {
      index.set(name, {
        name,
        method: buffer.readUInt16LE(off + 10),
        cs: buffer.readUInt32LE(off + 20),
        lo: buffer.readUInt32LE(off + 42),
      });
      names.push(name);
    }
    off += 46 + nl + el + cl;
  }

  const read = (name) => {
    const e = index.get(name);
    if (!e) return null;
    const o = e.lo;
    const nl = buffer.readUInt16LE(o + 26);
    const el = buffer.readUInt16LE(o + 28);
    const start = o + 30 + nl + el;
    const raw = buffer.subarray(start, start + e.cs);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`不支持的压缩方式 ${e.method}（条目 ${name}）`);
  };

  const text = (name) => {
    const b = read(name);
    return b === null ? null : b.toString('utf8');
  };

  return { names, has: (n) => index.has(n), read, text };
}
