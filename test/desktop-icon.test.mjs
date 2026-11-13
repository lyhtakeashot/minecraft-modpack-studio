/**
 * exe 内嵌图标测（2026-11-10 新增）。
 *
 * ## 背景
 *
 * 以前 exe 在资源管理器里显示的还是 Electron 的默认图标。Windows 那套
 * `BeginUpdateResource` / `UpdateResource` / `EndUpdateResource` 在这台机器上
 * 是「假成功」——三个调用都返回 True，但文件一个字节都没变（沙箱把资源写入
 * 静默丢弃了；对照实验：同一文件用普通写文件改一个字节，md5 立刻变）。
 *
 * 所以改成纯 Node 直接改 PE 的 `.rsrc` 节（`packages/desktop/embed-icon.mjs`），
 * 这里测的就是那套纯逻辑。
 *
 * ## 为什么最要紧的是「编码完能读回来」这一圈
 *
 * 早先排偏移时忘了把游标带出来（`walk` 没有 `return cur`），结果所有位图都
 * 写在 `.rsrc` 节最开头，**把资源目录本身盖掉了**。那次写完照样报成功、
 * 读回校验才抓到，留下了坏 exe。所以这里必须有「编码 → 解析 → 内容一致」
 * 的往返测试，不能只测函数不报错。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RT_GROUP_ICON,
  RT_ICON,
  buildGroupIcon,
  buildResourceTree,
  encodeResourceTree,
  parseIco,
  parseResourceTree,
} from '../packages/desktop/embed-icon.mjs';
import {
  buildIntegrityProbeScript,
  buildIntegrityRaiseScript,
  integrityNotice,
  parseIntegrityLabel,
} from '../packages/desktop/integrity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ICO_PATH = path.join(ROOT, 'packages', 'desktop', 'app.ico');

/** 造一个假 PE：数据都从 encoded.bytes 里按 RVA 取。 */
function fakePe(encoded) {
  return { d: encoded.bytes, rvaToOff: (rva) => rva - 0x1000 };
}

test('图标文件：六帧（16/32/48/64 用 DIB，128/256 用 PNG），尺寸对得上', () => {
  const frames = parseIco(fs.readFileSync(ICO_PATH));
  assert.equal(frames.length, 6, '应该是六帧');
  assert.deepEqual(frames.map((f) => f.w), [16, 32, 48, 64, 128, 256]);
  assert.deepEqual(frames.map((f) => f.h), [16, 32, 48, 64, 128, 256]);
  // 小尺寸用 DIB（兼容老系统，PE 资源也最稳），大尺寸用 PNG（省体积）
  assert.deepEqual(frames.map((f) => f.png), [false, false, false, false, true, true]);
});

test('图标文件：帧数据不能空，且加起来不能太大（.rsrc 节只有 99 KB）', () => {
  const frames = parseIco(fs.readFileSync(ICO_PATH));
  for (const [i, f] of frames.entries()) {
    assert.ok(f.bytes.length > 0, `第 ${i + 1} 帧是空的`);
  }
  const total = frames.reduce((n, f) => n + f.bytes.length, 0);
  assert.ok(total < 99 * 1024, `图标数据 ${total} 字节，塞不进 .rsrc 节`);
});

test('ICO 解析：不是 ICO 就得当场报错，不能默默解析出空结果', () => {
  assert.throws(() => parseIco(Buffer.from([1, 2, 3])), /太短/);
  const bad = Buffer.alloc(6);
  bad.writeUInt16LE(0, 0);
  bad.writeUInt16LE(2, 2); // type=2 是光标，不是图标
  bad.writeUInt16LE(0, 4);
  assert.throws(() => parseIco(bad), /不是 ICO/);
});

test('资源树：编码完能原样读回来（这一圈能抓住「位图盖住目录」的坑）', () => {
  const iconBytes = Buffer.from([1, 2, 3, 4, 5]);
  const groupBytes = Buffer.from([0, 0, 1, 0, 0, 1]);
  const flat = new Map();
  flat.set(`${RT_ICON}/1/1033`, { bytes: iconBytes, codepage: 0 });
  flat.set(`${RT_GROUP_ICON}/1/1033`, { bytes: groupBytes, codepage: 0 });

  const encoded = encodeResourceTree(buildResourceTree(flat), 0x1000);
  assert.ok(encoded.total > 0, '编码结果不能是空的');
  assert.equal(encoded.total % 4, 0, '总长度要 4 字节对齐');

  // 假装 .rsrc 节从 RVA 0x1000 开始
  const back = parseResourceTree(fakePe(encoded), 0x1000);
  assert.equal(back.size, 2, '两个资源');
  assert.ok(back.get(`${RT_ICON}/1/1033`)?.bytes.equals(iconBytes), '图标那一项没读回来');
  assert.ok(back.get(`${RT_GROUP_ICON}/1/1033`)?.bytes.equals(groupBytes), '分组那一项没读回来');
});

test('资源树：目录结构排在前面、数据块排在后面（目录不能被数据盖掉）', () => {
  const flat = new Map();
  for (let i = 1; i <= 5; i += 1) {
    flat.set(`${RT_ICON}/${i}/1033`, { bytes: Buffer.alloc(64, i), codepage: 0 });
  }
  const encoded = encodeResourceTree(buildResourceTree(flat), 0x1000);
  // 读回来五个都在、内容没串
  const back = parseResourceTree(fakePe(encoded), 0x1000);
  assert.equal(back.size, 5);
  for (let i = 1; i <= 5; i += 1) {
    const got = back.get(`${RT_ICON}/${i}/1033`);
    assert.ok(got, `第 ${i} 项丢了`);
    assert.equal(got.bytes[0], i, `第 ${i} 项内容串了`);
  }
});

test('资源树：资源名是字符串的那种（不按数字 ID）要报错停下', () => {
  // 造一棵两层的树：根目录 → 子目录 → 名字是字符串的目录项
  const buf = Buffer.alloc(96);
  // 根目录：0 个命名 + 1 个 ID
  buf.writeUInt16LE(0, 12);
  buf.writeUInt16LE(1, 14);
  buf.writeUInt32LE(3, 16); // 名字 ID = 3
  buf.writeUInt32LE((0x80000000 | 32) >>> 0, 20); // 偏移带高位 = 指向子目录
  // 子目录（偏移 32）：1 个命名项，名字是字符串（名字字段最高位为 1）
  buf.writeUInt16LE(1, 32 + 12);
  buf.writeUInt16LE(0, 32 + 14);
  buf.writeUInt32LE((0x80000000 | 64) >>> 0, 32 + 16);
  const fake = { d: buf, rvaToOff: (rva) => rva };
  assert.throws(() => parseResourceTree(fake, 0), /字符串/);
});

/**
 * 直接读原始字节里的目录项（不经过 parseResourceTree），看某一层指向的是
 * 子目录还是数据项 —— 这才能看出「层数对不对」。
 */
function readDirEntries(buf, off) {
  const nNamed = buf.readUInt16LE(off + 12);
  const nId = buf.readUInt16LE(off + 14);
  const count = nNamed + nId;
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const eo = off + 16 + i * 8;
    const nameRaw = buf.readUInt32LE(eo);
    const offRaw = buf.readUInt32LE(eo + 4);
    items.push({
      name: nameRaw & 0xffff,
      isDir: !!(offRaw & 0x80000000),
      off: offRaw & 0x7fffffff,
    });
  }
  return items;
}

test('资源树：层数必须是「类型 → 名字 → 语言 → 数据项」三层目录到底', () => {
  // ★ 这条对着 2026-11-10 那个「快捷方式没图标」的坑：
  //   早先把语言当成了「名字」层的子目录，整棵树多了一层，
  //   Windows 认不出来，整个图标组作废，资源管理器退回系统默认空白图标。
  //   正确的形状：类型目录 → 名字目录 → 语言目录（条目名字就是语言 ID，
  //   直接指向数据项，中间不能再套一层目录）。
  const flat = new Map();
  flat.set(`${RT_ICON}/1/1033`, { bytes: Buffer.alloc(64, 7), codepage: 0 });
  flat.set(`${RT_GROUP_ICON}/1/1033`, { bytes: Buffer.alloc(32, 9), codepage: 0 });

  const encoded = encodeResourceTree(buildResourceTree(flat), 0x1000);
  const buf = encoded.bytes;

  const root = readDirEntries(buf, 0);
  assert.equal(root.length, 2, '根目录两项：RT_ICON 和 RT_GROUP_ICON');
  assert.deepEqual(
    root.map((r) => r.name).sort((a, b) => a - b),
    [RT_ICON, RT_GROUP_ICON],
    '根目录两项的类型 ID 要对',
  );
  assert.ok(root.every((r) => r.isDir), '根目录的条目必须都指向子目录');

  for (const typeEntry of root) {
    const typeDir = readDirEntries(buf, typeEntry.off);
    assert.equal(typeDir.length, 1, `类型 ${typeEntry.name} 下面应该只有一个名字`);
    assert.ok(typeDir[0].isDir, `类型 ${typeEntry.name} 的条目必须指向子目录`);

    const nameDir = readDirEntries(buf, typeDir[0].off);
    assert.equal(nameDir.length, 1, `类型 ${typeEntry.name} 的名字目录下面应该只有一个语言`);
    assert.equal(nameDir[0].name, 1033, '语言 ID 就写在这一层的条目名字上');
    assert.ok(
      !nameDir[0].isDir,
      `类型 ${typeEntry.name} 的语言这一层必须直接指向数据项，不能再包一层目录（多一层 Windows 就认不出来）`,
    );
  }
});

test('资源树：解析回来的键要带语言（早先漏了语言，写出去就成了 0）', () => {
  const flat = new Map();
  flat.set(`${RT_ICON}/1/1033`, { bytes: Buffer.alloc(64, 7), codepage: 0 });
  const encoded = encodeResourceTree(buildResourceTree(flat), 0x1000);
  const back = parseResourceTree(fakePe(encoded), 0x1000);
  assert.ok(
    back.has(`${RT_ICON}/1/1033`),
    `键应该是 类型/名字/语言 三段，实际是：${[...back.keys()].join(' | ')}`,
  );
});

test('图标分组：头里的帧数字段是小端，写错了 Windows 整个图标组都作废', () => {
  // ★ 2026-11-10 那个坑：count 写成 [0,0,1,0,0,N]，帧数落到高字节，
  //   Windows 读成 6 * 256 = 1536，资源管理器退回系统默认空白图标。
  const frames = parseIco(fs.readFileSync(ICO_PATH));
  const grp = buildGroupIcon(frames);
  assert.equal(grp.readUInt16LE(0), 0, 'reserved 必须是 0');
  assert.equal(grp.readUInt16LE(2), 1, 'type 必须是 1（图标）');
  assert.equal(
    grp.readUInt16LE(4),
    frames.length,
    `分组头里声明的帧数必须是 ${frames.length}（小端），不是 ${frames.length * 256}`,
  );
  assert.equal(grp.length, 6 + 14 * frames.length, '分组长度 = 头 6 字节 + 每帧 14 字节');
});

test('图标分组：每帧条目要写对宽高、位深、字节数和对应的 RT_ICON 名字', () => {
  const frames = parseIco(fs.readFileSync(ICO_PATH));
  const grp = buildGroupIcon(frames);
  frames.forEach((f, i) => {
    const o = 6 + i * 14;
    assert.equal(grp.readUInt8(o), f.w < 256 ? f.w : 0, `第 ${i + 1} 帧宽度写错了`);
    assert.equal(grp.readUInt8(o + 1), f.h < 256 ? f.h : 0, `第 ${i + 1} 帧高度写错了`);
    assert.equal(grp.readUInt16LE(o + 4), 1, '平面数必须是 1');
    assert.equal(grp.readUInt16LE(o + 6), 32, '位深必须是 32');
    assert.equal(grp.readUInt32LE(o + 8), f.bytes.length, `第 ${i + 1} 帧字节数写错了`);
    assert.equal(grp.readUInt16LE(o + 12), i + 1, `第 ${i + 1} 帧对应的 RT_ICON 名字 ID 写错了`);
  });
});

test('快捷方式的图标要指向 exe 自己，别指向外部 ico（2026-11-10 14:00 修）', () => {
  // ★ 为什么改：快捷方式里的 IconLocation 只是一个「外部文件路径指针」，
  //   资源管理器显示时要现场去解析那个路径，解析不到就用通用快捷方式图标。
  //   之前指包内那个 app.ico，实测解析不出图标（exe 有图标、快捷方式没有）。
  //   改成指 exe 之后（Obsidian 就是这么干的），图标跟着 exe 走，
  //   而 exe 的内嵌图标是打包第 3.1 步刚写进去的，必定取得到。
  const src = fs.readFileSync(path.join(ROOT, 'packages', 'desktop', 'build.mjs'), 'utf8');
  const shortcutBlock = src.slice(src.indexOf('const shortcutTargets'), src.indexOf('// 7.'));
  assert.ok(shortcutBlock, 'build.mjs 里找不到快捷方式生成段');
  assert.match(
    shortcutBlock,
    /iconPath:\s*appExe/,
    '快捷方式的 iconPath 必须指向 exe 自己（appExe）',
  );
  assert.ok(
    !/iconPath:\s*path\.join\(appDir/.test(shortcutBlock),
    '快捷方式不该再指向包内的 app.ico（那样解析不出图标）',
  );
});

// ─────────────────────────────────────────────────────────────────────
// 完整性标签（2026-11-11 收口：相关但未定案，提级修法已证伪删除）。
// exe 有图标但快捷方式是「白纸 + 蓝箭头」，与 Low Mandatory Level 只是相关；
// 这里只测纯逻辑：认标签、造脚本、给中性说明（提示里不含任何让用户跑的命令）。
// ─────────────────────────────────────────────────────────────────────

test('完整性标签：从 icacls 输出里认出 low / medium / high / none', () => {
  assert.equal(
    parseIntegrityLabel('BUILTIN\\Users:(I)(RX)\nMandatory Label\\Low Mandatory Level:(I)(NW)'),
    'low',
  );
  assert.equal(parseIntegrityLabel('Mandatory Label\\Medium Mandatory Level:(I)(NW)'), 'medium');
  assert.equal(parseIntegrityLabel('Mandatory Label\\High Mandatory Level:(I)(NW)'), 'high');
  assert.equal(parseIntegrityLabel('BUILTIN\\Users:(I)(RX)\nNT AUTHORITY\\SYSTEM:(I)(F)'), 'none');
});

test('完整性标签：中文系统的「低强制级别」也要认得，空输出不能瞎猜', () => {
  assert.equal(parseIntegrityLabel('强制标签\\低强制级别:(I)(NW)'), 'low');
  assert.equal(parseIntegrityLabel(''), 'unknown');
  assert.equal(parseIntegrityLabel(null), 'unknown');
});

test('完整性标签：探针脚本把 icacls 输出写进文件，正文不能带中文', () => {
  const script = buildIntegrityProbeScript('C:\\中文目录\\整合包工作室.lnk', 'C:\\out\\a.txt');
  assert.match(script, /icacls\.exe/);
  assert.match(script, /Out-File/);
  assert.match(script, /FromBase64String/);
  // 路径用 base64 传，脚本正文必须纯 ASCII（PowerShell 读 UTF-8 中文会乱码）。
  assert.ok(/^[\x00-\x7F]*$/.test(script), '探针脚本正文混进了非 ASCII 字符');
});

test('完整性标签：提升脚本用 /setintegritylevel M，正文纯 ASCII', () => {
  const script = buildIntegrityRaiseScript('C:\\中文目录\\整合包工作室.lnk');
  assert.match(script, /\/setintegritylevel M/);
  assert.ok(/^[\x00-\x7F]*$/.test(script), '提升脚本正文混进了非 ASCII 字符');
});

test('完整性标签：只有 low 才给提示，提示里不再带任何命令', () => {
  assert.equal(integrityNotice({ label: 'medium', filePath: 'x.lnk' }), '');
  assert.equal(integrityNotice({ label: 'none', filePath: 'x.lnk' }), '');
  const text = integrityNotice({ label: 'low', filePath: 'C:/x/整合包工作室.lnk' });
  assert.match(text, /低完整性|低强制|低标签/);
  assert.match(text, /白纸/);
  // 提级修法已被用户三轮实测证伪并删除，提示不能再让用户去跑命令。
  assert.doesNotMatch(text, /icacls|setintegritylevel|node packages/);
});
