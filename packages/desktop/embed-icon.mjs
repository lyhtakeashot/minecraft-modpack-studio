/**
 * 把 app.ico 的帧写进 exe 自己的图标资源（RT_ICON / RT_GROUP_ICON）。
 *
 * ## 为什么不用 Windows 那套资源 API
 *
 * `BeginUpdateResource` / `UpdateResource` / `EndUpdateResource` 在这台机器上是
 * 「假成功」：三个调用都返回 True，但文件一个字节都没变（沙箱把资源写入静默
 * 丢弃了）。对照实验：同一个文件用普通写文件改一个字节，md5 立刻变；
 * 用资源 API 改，md5 前后一模一样。隔离对照是在一个 34 KB 的小 exe 上做的，
 * 排除「文件太大写不进去」这种解释。
 *
 * 所以改成直接改 PE 文件里的 .rsrc 节 —— 纯字节处理，不调用任何 Windows API。
 *
 * ## 做法
 *
 * 1. 解析 PE 头 → 找 .rsrc 节和资源数据目录；
 * 2. 递归解析 .rsrc 资源树，把所有叶子资源抠出来；
 * 3. 丢掉旧的图标资源（RT_ICON=3、RT_GROUP_ICON=14），其余全部（光标、清单、
 *    版本信息……）原样搬回去；
 * 4. 从 app.ico 取每一帧，新建 RT_ICON 条目 + 一个 RT_GROUP_ICON 分组；
 * 5. 整棵资源树重新编码、原地写回 .rsrc 节（节表、数据目录、校验和都不用动）。
 *
 * ## 为什么装得下
 *
 * 旧图标四帧是 DIB（合计 37 KB），新图标六帧里 128/256 换成 PNG 帧，
 * 合计约 34 KB，比旧的还小，所以新树放得进原来的 .rsrc 节（99 KB）。
 * 装不下就当场报错停下，绝不硬写。
 *
 * ## 安全网（每一步都验）
 *
 * - 重定位表若覆盖 .rsrc（.rsrc 里放绝对地址会被重定位改坏），提前报错停下；
 * - 新树比 .rsrc 节还大，报错停下，不写盘；
 * - 写完重新从文件里解析一遍，确认图标资源确实是新的每一帧 + 一个分组，
 *   而且每一帧的字节与 app.ico 里的完全一致。
 *
 * ## 用法
 *
 *   node packages/desktop/embed-icon.mjs [exe 路径] [ico 路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

/** 资源类型：图标 = 3，图标分组 = 14。 */
export const RT_ICON = 3;
export const RT_GROUP_ICON = 14;
/** 语言 ID。1033 = en-US，资源管理器读图标不挑语言，给一个就行。 */
const LANG = 1033;

const DEFAULT_EXE = path.join(ROOT, 'dist', 'desktop', 'mcstudio.exe');
const DEFAULT_ICO = path.join(HERE, 'app.ico');

/* ------------------------------------------------------------------ *
 * PE 基础解析
 * ------------------------------------------------------------------ */

/** PE 文件的最小解析器（只取改图标要用的那几样）。 */
export class Pe {
  constructor(data) {
    this.d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.pe = this.d.readUInt32LE(0x3c);
    if (this.d.toString('latin1', this.pe, this.pe + 4) !== 'PE\0\0') {
      throw new Error('不是 PE 文件');
    }
    const coff = this.pe + 4;
    this.nsec = this.d.readUInt16LE(coff + 2);
    this.optSize = this.d.readUInt16LE(coff + 16);
    this.opt = coff + 20;
    const magic = this.d.readUInt16LE(this.opt);
    this.pe32plus = magic === 0x20b;
    if (!this.pe32plus && magic !== 0x10b) throw new Error('PE 头不对');
    this.imageBase = this.pe32plus
      ? this.d.readBigUInt64LE(this.opt + 24)
      : BigInt(this.d.readUInt32LE(this.opt + 28));
    // 数据目录起点：PE32+ 在可选头 +112，PE32 在 +96
    this.dd = this.opt + (this.pe32plus ? 112 : 96);
    this.ndd = this.d.readUInt32LE(this.dd - 4);
    const secTable = this.opt + this.optSize;
    this.sections = [];
    for (let i = 0; i < this.nsec; i += 1) {
      const o = secTable + i * 40;
      this.sections.push({
        name: this.d.toString('latin1', o, o + 8).replace(/\0+$/, ''),
        vsize: this.d.readUInt32LE(o + 8),
        vaddr: this.d.readUInt32LE(o + 12),
        rawsize: this.d.readUInt32LE(o + 16),
        rawptr: this.d.readUInt32LE(o + 20),
      });
    }
  }

  section(name) {
    const hit = this.sections.find((s) => s.name === name);
    if (!hit) throw new Error(`没有这个节：${name}`);
    return hit;
  }

  /** RVA（相对映像基址）→ 文件内偏移。 */
  rvaToOff(rva) {
    for (const s of this.sections) {
      const span = Math.max(s.vsize, s.rawsize);
      if (rva >= s.vaddr && rva < s.vaddr + span) {
        return s.rawptr + (rva - s.vaddr);
      }
    }
    throw new Error(`RVA 0x${rva.toString(16)} 不在任何节里`);
  }

  /** 第 n 个数据目录（0=导出表，2=资源表，4=证书表…）。 */
  ddEntry(idx) {
    const o = this.dd + idx * 8;
    return { rva: this.d.readUInt32LE(o), size: this.d.readUInt32LE(o + 4) };
  }
}

/* ------------------------------------------------------------------ *
 * 资源树：解析 / 重建 / 编码
 * ------------------------------------------------------------------ */

/**
 * 递归读资源树，返回 Map：键是 `类型/名字/语言`，值是 `{bytes, codepage}`。
 *
 * PE 资源树是四层：类型 → 名字 → 语言 → 数据项。语言 ID 挂在「名字→语言」
 * 那一层的目录项名字上，数据项自己的名字字段是 0（一个语言下就一份数据），
 * 所以键统一写成三段。
 */
export function parseResourceTree(pe, baseRva) {
  const out = new Map();
  const walk = (dirOff, pathKeys) => {
    const o = pe.rvaToOff(baseRva + dirOff);
    const nNamed = pe.d.readUInt16LE(o + 12);
    const nId = pe.d.readUInt16LE(o + 14);
    const count = nNamed + nId;
    for (let i = 0; i < count; i += 1) {
      const eo = o + 16 + i * 8;
      const nameRaw = pe.d.readUInt32LE(eo);
      const off = pe.d.readUInt32LE(eo + 4);
      if (nameRaw & 0x80000000) {
        throw new Error('资源名是字符串，本工具只处理数字 ID');
      }
      const nid = nameRaw & 0xffff;
      if (off & 0x80000000) {
        walk(off & 0x7fffffff, [...pathKeys, nid]);
      } else {
        // ⚠ 目录项里的偏移是「相对资源节起点」的，要加 baseRva；
        //    而数据项 IMAGE_RESOURCE_DATA_ENTRY 里的 OffsetToData 是绝对 RVA。
        //
        // ★ 走到数据项，说明已经到第三层了（类型 → 名字 → 语言）。
        //   **语言 ID 就写在这一层的目录项名字上**（数据项自己的名字字段是 0），
        //   所以键要把这一层的名字（语言）带上。早先这里漏了它，语言被写成 0，
        //   重建出来的树也多了一层目录 —— Windows 认不出来，整个图标组作废，
        //   资源管理器只能退回系统默认的空白文档图标。
        const dataOff = pe.rvaToOff(baseRva + off);
        const rva = pe.d.readUInt32LE(dataOff);
        const size = pe.d.readUInt32LE(dataOff + 4);
        const codepage = pe.d.readUInt32LE(dataOff + 8);
        const start = pe.rvaToOff(rva);
        out.set([...pathKeys, nid].join('/'), {
          bytes: Buffer.from(pe.d.subarray(start, start + size)),
          codepage,
        });
      }
    }
  };
  walk(0, []);
  return out;
}

/** 目录节点。 */
class Dir {
  constructor(children) {
    this.children = children;
    this.off = 0;
  }
}

/** 数据项节点。 */
class Leaf {
  constructor(bytes, codepage) {
    this.bytes = bytes;
    this.codepage = codepage;
    this.entryOff = 0;
    this.blobOff = 0;
  }
}

/**
 * 由 `Map<键, {bytes, codepage}>` 重建四层资源树。
 * 键的格式是 `类型/名字/语言`。
 *
 * ★ 层数必须和 Windows 写出来的一模一样：
 *   根目录（类型）→ 名字目录 → 语言目录 → 数据项。
 *   **语言目录里的条目名字就是语言 ID，它直接指向数据项**，中间不能再套一层目录。
 *   早先把数据项又包了一层目录（多一层），而且解析时没把语言 ID 读出来
 *   （键只剩 `类型/名字`），重建出来的树语言写成了 0、多了一层目录 ——
 *   Windows 认不出来，整个图标组作废，资源管理器退回系统默认的空白图标。
 */
export function buildResourceTree(flat) {
  const types = new Map();
  for (const [key, value] of flat) {
    const [t, n, l] = key.split('/').map((x) => Number(x));
    if (!types.has(t)) types.set(t, new Map());
    const names = types.get(t);
    if (!names.has(n)) names.set(n, new Map());
    names.get(n).set(l, value);
  }
  const root = new Dir([]);
  for (const t of [...types.keys()].sort((a, b) => a - b)) {
    const names = types.get(t);
    const tdir = new Dir([]);
    for (const n of [...names.keys()].sort((a, b) => a - b)) {
      const langs = names.get(n);
      const ndir = new Dir([]);
      for (const l of [...langs.keys()].sort((a, b) => a - b)) {
        const { bytes, codepage } = langs.get(l);
        // 条目名字 = 语言 ID，直接指向数据项（不要再包一层目录）
        ndir.children.push([l, new Leaf(bytes, codepage)]);
      }
      tdir.children.push([n, ndir]);
    }
    root.children.push([t, tdir]);
  }
  return root;
}

/** 给整棵树排偏移：先目录结构，再数据块（每个数据块 4 字节对齐）。 */
function assignOffsets(root) {
  let cur = 0;
  // ⚠ walk 必须把游标带出来：目录结构区的大小决定了数据块从哪儿开始排。
  // 早先这里忘了 return cur，structSize 成了 undefined、cur 被重置成 0，
  // 结果所有位图都写在 .rsrc 节最开头，把资源目录本身盖掉了。
  const walk = (node) => {
    node.off = cur;
    cur += 16 + 8 * node.children.length;
    for (const [, child] of node.children) {
      if (child instanceof Dir) walk(child);
      else {
        child.entryOff = cur;
        cur += 16;
      }
    }
    return cur;
  };
  const structSize = walk(root);
  cur = (structSize + 3) & ~3;
  const walkData = (node) => {
    for (const [, child] of node.children) {
      if (child instanceof Dir) walkData(child);
      else {
        child.blobOff = cur;
        cur += (child.bytes.length + 3) & ~3;
      }
    }
  };
  walkData(root);
  return { structSize, total: cur };
}

/**
 * 把树编码成 .rsrc 节的内容。
 *
 * ⚠ 数据项里的 OffsetToData 存的是 **RVA**（相对映像基址），不是虚拟地址。
 */
export function encodeResourceTree(root, rsrcVaddr) {
  const { structSize, total } = assignOffsets(root);
  const buf = Buffer.alloc(total);
  const rva = (off) => rsrcVaddr + off;
  const writeDir = (node) => {
    const o = node.off;
    const nNamed = node.children.filter(([name]) => name & 0x80000000).length;
    const nId = node.children.length - nNamed;
    buf.writeUInt32LE(0, o);
    buf.writeUInt32LE(0, o + 4);
    buf.writeUInt16LE(0, o + 8);
    buf.writeUInt16LE(0, o + 10);
    buf.writeUInt16LE(nNamed, o + 12);
    buf.writeUInt16LE(nId, o + 14);
    node.children.forEach(([name, child], i) => {
      const eo = o + 16 + i * 8;
      buf.writeUInt32LE(name & 0xffff, eo);
      if (child instanceof Dir) buf.writeUInt32LE((child.off | 0x80000000) >>> 0, eo + 4);
      else buf.writeUInt32LE(child.entryOff, eo + 4);
    });
    for (const [, child] of node.children) {
      if (child instanceof Dir) writeDir(child);
      else {
        buf.writeUInt32LE(rva(child.blobOff), child.entryOff);
        buf.writeUInt32LE(child.bytes.length, child.entryOff + 4);
        buf.writeUInt32LE(child.codepage, child.entryOff + 8);
        buf.writeUInt32LE(0, child.entryOff + 12);
        child.bytes.copy(buf, child.blobOff);
      }
    }
  };
  writeDir(root);
  return { structSize, total, bytes: buf };
}

/* ------------------------------------------------------------------ *
 * ICO 解析
 * ------------------------------------------------------------------ */

/**
 * 读 ICO 文件，返回每一帧 `{w, h, bytes, png}`。
 * 帧数据本身就是能直接塞进 PE 资源的数据（DIB 或 PNG 字节）。
 */
export function parseIco(buf) {
  if (buf.length < 6) throw new Error('ICO 文件太短');
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) throw new Error('不是 ICO 文件');
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const o = 6 + i * 16;
    const w = buf.readUInt8(o) || 256;
    const h = buf.readUInt8(o + 1) || 256;
    const size = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    const data = Buffer.from(buf.subarray(off, off + size));
    const png = data.length > 8 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    frames.push({ w, h, bytes: data, png });
  }
  return frames;
}

/**
 * 造图标分组（GRPICONDIR）：头 6 字节 + 每帧 14 字节的条目。
 * 头：reserved(2)=0、type(2)=1、count(2)=帧数
 *
 * ★ count 是 2 字节小端：低字节在前、高字节在后。
 *   早先写成 [0, 0, 1, 0, 0, frames.length]，帧数落到了 count 的「高字节」，
 *   Windows 读出来是 6 * 256 = 1536，整个图标组被当成坏数据，
 *   资源管理器只能退回系统默认的空白文档图标，快捷方式也跟着没图标。
 */
export function buildGroupIcon(frames) {
  const grp = [
    Buffer.from([
      0x00, 0x00, // reserved = 0
      0x01, 0x00, // type = 1（图标）
      frames.length & 0xff, (frames.length >> 8) & 0xff, // count = 帧数（小端）
    ]),
  ];
  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i];
    const entry = Buffer.alloc(14);
    entry.writeUInt8(f.w < 256 ? f.w : 0, 0); // 宽（256 记成 0）
    entry.writeUInt8(f.h < 256 ? f.h : 0, 1); // 高
    entry.writeUInt8(0, 2); // 颜色数
    entry.writeUInt8(0, 3); // 保留
    entry.writeUInt16LE(1, 4); // 平面数
    entry.writeUInt16LE(32, 6); // 位深
    entry.writeUInt32LE(f.bytes.length, 8); // 字节数
    entry.writeUInt16LE(i + 1, 12); // 对应的 RT_ICON 名字 ID
    grp.push(entry);
  }
  return Buffer.concat(grp);
}

/* ------------------------------------------------------------------ *
 * 重定位表检查
 * ------------------------------------------------------------------ */

/** .rsrc 里若放绝对地址，重定位会把它们改坏 —— 有覆盖就停下。 */
function relocCovers(pe, rsrcVaddr, rsrcSize) {
  let rel;
  try {
    rel = pe.section('.reloc');
  } catch {
    return false;
  }
  let o = rel.rawptr;
  const end = o + rel.rawsize;
  while (o + 8 <= end) {
    const page = pe.d.readUInt32LE(o);
    const size = pe.d.readUInt32LE(o + 4);
    if (size < 8) break;
    const n = (size - 8) >> 1;
    for (let i = 0; i < n; i += 1) {
      const e = pe.d.readUInt16LE(o + 8 + i * 2);
      if ((e >> 12) === 3) {
        const pageRva = page + (e & 0xfff);
        if (pageRva >= rsrcVaddr && pageRva < rsrcVaddr + rsrcSize) return true;
      }
    }
    o += size;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 主流程：把图标写进 exe
 * ------------------------------------------------------------------ */

/**
 * 把 icoPath 的每一帧写进 exePath 的图标资源。返回摘要，失败就抛错。
 * 写完会重新解析文件，逐字节核对每一帧。
 */
export function embedIcon(exePath = DEFAULT_EXE, icoPath = DEFAULT_ICO) {
  if (!fs.existsSync(exePath)) throw new Error(`找不到 exe：${exePath}`);
  if (!fs.existsSync(icoPath)) throw new Error(`找不到图标：${icoPath}`);
  const before = fs.readFileSync(exePath);
  const pe = new Pe(before);
  const rsrc = pe.section('.rsrc');
  const res = pe.ddEntry(2);
  const cert = pe.ddEntry(4);

  const frames = parseIco(fs.readFileSync(icoPath));
  if (!frames.length) throw new Error('图标文件里一帧都没有');

  if (relocCovers(pe, rsrc.vaddr, rsrc.vsize)) {
    throw new Error('重定位表覆盖了 .rsrc，改图标会让 exe 坏掉，停下');
  }
  if (cert.size) {
    throw new Error('这个 exe 有数字签名，改完签名就失效了，停下');
  }

  const flat = parseResourceTree(pe, res.rva);
  for (const key of [...flat.keys()]) {
    const type = Number(key.split('/')[0]);
    if (type === RT_ICON || type === RT_GROUP_ICON) flat.delete(key);
  }

  frames.forEach((f, i) => {
    flat.set(`${RT_ICON}/${i + 1}/${LANG}`, { bytes: f.bytes, codepage: 0 });
  });

  // 图标分组（GRPICONDIR）
  flat.set(`${RT_GROUP_ICON}/1/${LANG}`, {
    bytes: buildGroupIcon(frames),
    codepage: 0,
  });

  const root = buildResourceTree(flat);
  const encoded = encodeResourceTree(root, rsrc.vaddr);
  if (encoded.total > rsrc.rawsize) {
    throw new Error(
      `新图标资源 ${encoded.total} 字节，比 .rsrc 节（${rsrc.rawsize} 字节）还大，装不下`,
    );
  }

  const out = Buffer.from(before);
  encoded.bytes.copy(out, rsrc.rawptr);
  // 剩下的位置补零（原来就是零，保持节大小不变）
  out.fill(0, rsrc.rawptr + encoded.total, rsrc.rawptr + rsrc.rawsize);

  fs.writeFileSync(exePath, out);

  // 读回验证：重新解析文件，确认每一帧都在、内容一致
  const pe2 = new Pe(fs.readFileSync(exePath));
  const flat2 = parseResourceTree(pe2, pe2.ddEntry(2).rva);
  const icons = [...flat2.entries()].filter(([k]) => k.startsWith(`${RT_ICON}/`));
  const groups = [...flat2.entries()].filter(([k]) => k.startsWith(`${RT_GROUP_ICON}/`));
  if (icons.length !== frames.length) {
    throw new Error(`写完读回，图标帧数不对：期望 ${frames.length}，实际 ${icons.length}`);
  }
  if (groups.length !== 1) {
    throw new Error(`写完读回，图标分组数不对：期望 1，实际 ${groups.length}`);
  }
  // ★ 再验一次分组头里的帧数字段本身（这一条能抓住「count 字节序写反」那类错）
  {
    const grpBytes = groups[0][1].bytes;
    const declared = grpBytes.readUInt16LE(4);
    if (declared !== frames.length) {
      throw new Error(
        `写完读回，图标分组里声明的帧数不对：期望 ${frames.length}，实际 ${declared}`,
      );
    }
  }
  frames.forEach((f, i) => {
    const read = flat2.get(`${RT_ICON}/${i + 1}/${LANG}`);
    if (!read || !read.bytes.equals(f.bytes)) {
      throw new Error(`写完读回，第 ${i + 1} 帧内容对不上`);
    }
  });

  return {
    frames: frames.length,
    sizes: frames.map((f) => f.w),
    bytes: encoded.total,
    changed: !before.equals(out),
    exeBytes: out.length,
  };
}

/**
 * 只读地看一眼 exe 里现在的图标资源（不改文件）。
 * 打包自检用这个：确认图标确实写进去了，又不用再动一遍 exe。
 */
export function inspectIcons(exePath = DEFAULT_EXE) {
  if (!fs.existsSync(exePath)) throw new Error(`找不到 exe：${exePath}`);
  const pe = new Pe(fs.readFileSync(exePath));
  const flat = parseResourceTree(pe, pe.ddEntry(2).rva);
  const icons = [...flat.entries()].filter(([k]) => k.startsWith(`${RT_ICON}/`));
  const groups = [...flat.entries()].filter(([k]) => k.startsWith(`${RT_GROUP_ICON}/`));
  return {
    frames: icons.length,
    groups: groups.length,
    // 图标分组头里自己声明的帧数。必须等于 frames —— 不等就说明分组头写坏了
    // （早先就是 count 的字节序写反，Windows 会把整个图标组当坏数据）。
    declared: groups.length
      ? groups[0][1].bytes.readUInt16LE(4)
      : 0,
    sizes: icons
      .map(([k]) => Number(k.split('/')[1]))
      .sort((a, b) => a - b)
      .map((id) => flat.get(`${RT_ICON}/${id}/${LANG}`)?.bytes?.length ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * 命令行入口
 * ------------------------------------------------------------------ */

function main() {
  const exe = process.argv[2] || DEFAULT_EXE;
  const ico = process.argv[3] || DEFAULT_ICO;
  try {
    const r = embedIcon(exe, ico);
    console.log(`图标已写进 ${exe}：${r.frames} 帧（${r.sizes.join('/')}），资源 ${r.bytes} 字节`);
    if (!r.changed) console.log('（文件内容没变 —— 说明已经是这个图标了）');
  } catch (error) {
    console.error(`图标没写进去：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
