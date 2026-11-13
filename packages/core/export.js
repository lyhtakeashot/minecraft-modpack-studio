/**
 * 导出：把实例打成 PCL2 能直接吃的压缩包。
 *
 * 三种形态（§6.5）：
 *  - `offline`  —— 完整实例：`<包名>/versions/<id>/…` + libraries + assets（可选 runtime）。
 *                  PCL 靠 `versions/<名>/<名>.json` 认成「游戏实例」，最稳。
 *  - `standard` —— 轻量包：只要 mods/config/kubejs/defaultconfigs，体积小，靠 PCL 的
 *                  「普通整合包」流程装。**不写 manifest.json**：CurseForge 清单要求
 *                  projectID/fileID，那要联网反查（P8），本地拍不出来，硬写只会让 PCL 去下载失败。
 *  - `launcher` —— `offline` 再套一层：包根放 PCL 本体 + `modpack.zip`。
 *
 * 关键设计：**打包前先算计划，打完再回头自检**。自检是真的重新打开 zip 逐条验，
 * 不是「我觉得应该没问题」—— 坏包要等用户拖进 PCL 才报错，那时已经白等了半小时。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from './zip.js';
import { ZipWriter } from './zipwrite.js';
import { McError } from './errors.js';
import { checkWritable } from './write.js';

export const EXPORT_MODES = ['standard', 'offline', 'launcher'];

/** 永远不进包的目录：日志、崩溃报告、编辑器缓存、备份。 */
const SKIP_DIRS = new Set([
  'logs', 'crash-reports', '.git', '.idea', '.vscode', '.cache', 'backup', 'backups',
  'debug', '.dsh', 'node_modules', '__pycache__',
]);

/** 永远不进包的文件。 */
const SKIP_FILE_RE = /(\.bak-\d+(-\d+)?$)|(^\.dsh-)|(\.log$)|(^\.DS_Store$)/i;

/** PCL 认实例的正则（照抄 PCL 源码 :829）。 */
const PCL_INSTANCE_RE = /^.*\/(?=versions\/(?<ver>[^\/]+)\/(\k<ver>)\.json$)/;

/** 包名里不能出现的字符（PCL :38/:844 直接拒绝 `!` 和 `;`）。 */
function safeName(s) {
  return String(s).replace(/[!;:*?"<>|\\/]+/g, '_').trim() || 'modpack';
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 递归收集要进包的文件。
 * @returns {Array<{name: string, abs: string, size: number}>}
 */
function walkInto(root, prefix, out, opts) {
  if (!dirExists(root)) return;
  const stack = [{ dir: root, rel: prefix }];
  while (stack.length) {
    const { dir, rel } = stack.pop();
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name.toLowerCase())) continue;
        if (it.name.toLowerCase() === 'saves' && !opts.includeSaves) continue;
        stack.push({ dir: abs, rel: r });
      } else if (it.isFile()) {
        if (SKIP_FILE_RE.test(it.name)) continue;
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        out.push({ name: r, abs, size });
      }
    }
  }
}

/**
 * 算导出计划（不写盘）。
 *
 * @param {object} instance resolveInstance 的返回值
 * @param {{mode?: string, packName?: string, includeSaves?: boolean, includeLibraries?: boolean,
 *          includeAssets?: boolean, includeRuntime?: boolean, pclExe?: string}} [opts]
 */
export function planExport(instance, opts = {}) {
  const mode = String(opts.mode ?? 'offline').toLowerCase();
  if (!EXPORT_MODES.includes(mode)) {
    throw new McError(`不认识的导出形态：${mode}`, `可选：${EXPORT_MODES.join(' / ')}`, 'McBadMode');
  }
  const packName = safeName(opts.packName ?? `${instance.id}-${mode}`);
  const wrapper = safeName(opts.packName ?? instance.id);
  const entries = [];
  const warnings = [];

  // 版本隔离标记：PCL 读自己目录下的 Setup.ini，打进包里只是给用户参考
  const setupIni = [
    '[Setup]',
    'VersionArgumentIndie=1',
    'VersionArgumentIndieV2=True',
    '',
  ].join('\r\n');

  // launcher 形态是「壳」：外层只有 PCL 本体 + 内层 offline 包（modpack.zip）。
  // PCL 认 launcher 包的条件就是这两样，所以内层必须是完整 offline 包，不能直接铺文件。
  if (mode === 'launcher') {
    const inner = planExport(instance, { ...opts, mode: 'offline' });
    const pclSize = opts.pclExe && fs.existsSync(opts.pclExe) ? fs.statSync(opts.pclExe).size : 0;
    return {
      mode,
      packName,
      wrapper,
      entries: [{ name: `${wrapper}/PCL.exe`, abs: opts.pclExe ?? '', size: pclSize }],
      fileCount: inner.fileCount + 1,
      totalBytes: inner.totalBytes,
      warnings: [...inner.warnings, 'launcher 形态会先打一个内层 offline 包（modpack.zip），再把 PCL 本体套在外面。'],
      setupIni,
      suggestZip: `${packName}.zip`,
      inner,
    };
  }

  // 三种形态都以实例目录内容为底
  walkInto(instance.instanceDir, '', entries, {
    includeSaves: Boolean(opts.includeSaves),
  });

  if (mode === 'standard') {
    // 只留玩家真正需要搬走的东西
    const keep = new Set(['mods', 'config', 'kubejs', 'defaultconfigs', 'scripts', 'resourcepacks', 'shaderpacks']);
    const filtered = entries.filter((e) => keep.has(e.name.split('/')[0]));
    entries.length = 0;
    entries.push(...filtered);
    warnings.push('standard 形态不带 manifest.json：CurseForge 清单需要 projectID/fileID，得联网反查（P8）。PCL 会按「普通整合包」处理。');
  }

  // versions/<id>/ 结构：实例目录内容整体塞进 versions/<id>/
  if (mode === 'offline') {
    for (const e of entries) e.name = `versions/${instance.id}/${e.name}`;
    // 客户端 jar 也必须在 versions/<id>/<id>.jar，否则 PCL 认不出实例
    if (instance.hasClientJar) {
      const jarName = `versions/${instance.id}/${instance.id}.jar`;
      if (!entries.some((e) => e.name === jarName)) {
        entries.push({ name: jarName, abs: instance.clientJar, size: fs.statSync(instance.clientJar).size });
      }
    } else {
      warnings.push(`实例里找不到客户端 jar（${instance.id}.jar），PCL 可能不认成实例。`);
    }

    const mcRoot = instance.mcRoot;
    if (opts.includeLibraries !== false) {
      walkInto(path.join(mcRoot, 'libraries'), 'libraries', entries, { includeSaves: false });
    } else {
      warnings.push('没带 libraries/：目标机第一次启动要自己下全部依赖库。');
    }
    if (opts.includeAssets !== false) {
      walkInto(path.join(mcRoot, 'assets'), 'assets', entries, { includeSaves: false });
    } else {
      warnings.push('没带 assets/：目标机第一次启动要下约 3,910 个资源对象。');
    }
    if (opts.includeRuntime) {
      walkInto(path.join(mcRoot, 'runtime'), 'runtime', entries, { includeSaves: false });
    }
  }

  // 统一加一层包裹目录（PCL 允许最多一层，且它靠这一层判断类型）
  const wrapPrefix = `${wrapper}/`;
  for (const e of entries) e.name = wrapPrefix + e.name;

  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  const maxName = entries.reduce((m, e) => (e.name.length > m.length ? e.name : m), '');

  if (totalBytes > 4 * 1024 ** 3) {
    warnings.push(`预估 ${fmtSize(totalBytes)}，超过 4 GB：打包会写 ZIP64，且耗时较长。`);
  }
  if (/[!;]/.test(maxName)) {
    warnings.push('包内路径含 `!` 或 `;`，PCL 会拒绝安装。');
  }

  return {
    mode,
    packName,
    wrapper,
    entries,
    fileCount: entries.length,
    totalBytes,
    warnings,
    setupIni,
    suggestZip: `${packName}.zip`,
  };
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * 打包。返回结果里带 `check` —— 打完重新打开 zip 逐条自检。
 */
export async function buildExport(instance, opts = {}) {
  const plan = planExport(instance, opts);
  const outFile = path.resolve(opts.outFile ?? path.join(instance.instanceDir, '..', plan.suggestZip));

  const writable = checkWritable(path.dirname(outFile));
  if (!writable.ok) {
    throw new McError(`输出目录不可写：${path.dirname(outFile)}`, `写盘探测失败 ${writable.error}`, 'McNotWritable');
  }

  const meta = {
    tool: 'dsh-minecraft-modpack-studio',
    mode: plan.mode,
    instance: instance.id,
    mcVersion: instance.mcVersion,
    loader: instance.loader,
    loaderVersion: instance.loaderVersion,
    files: plan.entries.length,
    createdAt: new Date().toISOString(),
  };

  // launcher：内层先打一个完整 offline 包，外层只放 modpack.zip + PCL.exe。
  if (plan.mode === 'launcher') {
    const exe = opts.pclExe;
    if (!exe || !fs.existsSync(exe)) {
      throw new McError('launcher 形态需要 PCL 本体（PCL.exe）', '传 pclExe 指向 PCL.exe；或改用 offline 形态', 'McNeedPcl');
    }
    const pcl = looksLikePcl(exe);
    if (!pcl.ok) {
      throw new McError(`这个 exe 不像 PCL：${pcl.detail}`, '传 PCL 官方发行版 exe（版本信息里带「启动器 / Launcher」标识）；管理员版（Admin Manager）会被排除', 'McBadPcl');
    }
    const innerFile = path.join(path.dirname(outFile), `.dsh-inner-${process.pid}-${Date.now()}.zip`);
    // 内层自己报自己的条目，外层那 3 个再报一遍 —— 两段用 phase 分开，界面各显示各的
    const innerProgress = typeof opts.onProgress === 'function' ? (event) => opts.onProgress({ ...event, phase: 'inner' }) : undefined;
    try {
      const inner = await buildExport(instance, { ...opts, mode: 'offline', outFile: innerFile, onProgress: innerProgress });
      const writer = new ZipWriter(outFile);
      await writer.open();
      let outerDone = 0;
      const outerTotal = 3;
      const outerStep = (name) => {
        outerDone += 1;
        if (typeof opts.onProgress === 'function') opts.onProgress({ done: outerDone, total: outerTotal, bytes: 0, phase: 'outer', name });
      };
      try {
        await writer.addFile(`${plan.wrapper}/modpack.zip`, innerFile);
        outerStep('modpack.zip');
        await writer.addFile(`${plan.wrapper}/PCL.exe`, exe);
        outerStep('PCL.exe');
        await writer.addText(`${plan.wrapper}/dsh-export.json`, JSON.stringify(meta, null, 2));
        outerStep('dsh-export.json');
      } catch (e) {
        try {
          fs.closeSync(writer.fd);
        } catch {
          /* ignore */
        }
        writer.fd = null;
        try {
          fs.unlinkSync(outFile);
        } catch {
          /* ignore */
        }
        throw e;
      }
      const summary = await writer.close();
      // 内层的 offline 自检结果直接并进来 —— 外层 zip 里没有 versions/，不该重复查
      const outer = checkZip(outFile, 'launcher');
      const items = [...outer.items, ...inner.check.items.map((i) => ({ ...i, rule: `内层：${i.rule}` }))];
      return {
        outFile,
        bytes: summary.bytes,
        entries: summary.entries,
        plan,
        check: { ok: items.every((i) => i.ok), items },
        inner,
      };
    } finally {
      try {
        fs.unlinkSync(innerFile);
      } catch {
        /* 内层是临时的，删不掉也不影响外层 */
      }
    }
  }

  const writer = new ZipWriter(outFile);
  await writer.open();
  let done = 0;
  let written = 0;
  // 每 200 个报一次太粗 —— 小包总共也没 200 条，进度条会一直空着。
  // 改成「每 20 条、或距上次超过 150 毫秒」就报一次，够细又不至于把事件刷爆。
  const reportEvery = 20;
  const reportGapMs = 150;
  let lastReportAt = 0;
  try {
    for (const e of plan.entries) {
      const r = await writer.addFile(e.name, e.abs);
      written += r.usize;
      done += 1;
      const now = Date.now();
      if (
        typeof opts.onProgress === 'function' &&
        (done === plan.entries.length || done % reportEvery === 0 || now - lastReportAt >= reportGapMs)
      ) {
        lastReportAt = now;
        opts.onProgress({ done, total: plan.entries.length, bytes: written });
      }
    }
    if (plan.mode !== 'standard') {
      await writer.addText(`${plan.wrapper}/PCL/Setup.ini`, plan.setupIni);
    }
    await writer.addText(`${plan.wrapper}/dsh-export.json`, JSON.stringify(meta, null, 2));
  } catch (e) {
    try {
      fs.closeSync(writer.fd);
    } catch {
      /* ignore */
    }
    writer.fd = null;
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* ignore */
    }
    throw e instanceof McError ? e : new McError(`打包失败：${e && e.message ? e.message : String(e)}`, '已删除半成品 zip', 'McExportFailed');
  }
  const summary = await writer.close();

  const check = checkZip(outFile, plan.mode);
  return {
    outFile,
    bytes: summary.bytes,
    entries: summary.entries,
    plan,
    check,
  };
}

/**
 * 对**已经生成**的 zip 做 PCL 兼容自检（§6.5 九条里可机验的部分）。
 * @param {string} zipFile
 * @param {string} mode
 */
export function checkZip(zipFile, mode) {
  const items = [];
  const add = (rule, ok, detail) => items.push({ rule, ok, detail });

  if (!fs.existsSync(zipFile)) {
    return { ok: false, items: [{ rule: '文件存在', ok: false, detail: zipFile }] };
  }
  add('输出是 zip 不是 rar', /\.zip$/i.test(zipFile), path.basename(zipFile));

  let zip;
  try {
    zip = openZip(fs.readFileSync(zipFile));
  } catch (e) {
    return { ok: false, items: [...items, { rule: 'ZIP 结构可读', ok: false, detail: e.message }] };
  }
  const names = zip.names;
  add('ZIP 结构可读', names.length > 0, `${names.length} 个条目`);

  const bad = names.filter((n) => n.includes('!') || n.includes(';'));
  add('路径不含 ! 和 ;', bad.length === 0, bad.length ? `首个：${bad[0]}` : 'ok');

  const depth = names.map((n) => n.split('/').length);
  const wrapperDepth = Math.min(...depth) - 1;
  add('包裹文件夹最多一层', wrapperDepth <= 1, `最深 ${Math.max(...depth)} 层，包裹 ${wrapperDepth} 层`);

  const hasManifest = names.some((n) => /(^|\/)manifest\.json$/.test(n));
  const hasModrinth = names.some((n) => /(^|\/)modrinth\.index\.json$/.test(n));
  add('不同时存在 manifest.json 与 modrinth.index.json', !(hasManifest && hasModrinth), hasManifest || hasModrinth ? '存在其一' : '都不存在');

  if (mode === 'offline') {
    const hit = names.filter((n) => PCL_INSTANCE_RE.test(n));
    add('存在 versions/<名>/<名>.json', hit.length > 0, hit[0] ?? '没找到');
    const jarHit = names.filter((n) => /(^|\/)versions\/([^/]+)\/\2\.jar$/.test(n));
    add('存在 versions/<名>/<名>.jar', jarHit.length > 0, jarHit[0] ?? '没找到（PCL 可能不认实例）');
    add('写了 PCL/Setup.ini 版本隔离标记', names.some((n) => /(^|\/)PCL\/Setup\.ini$/.test(n)), 'ok');
  }

  if (names.some((n) => /(^|\/)runtime\//.test(n))) {
    add('runtime 里有 bin/java.exe', names.some((n) => /(^|\/)runtime\/[^/]+\/bin\/java\.exe$/.test(n)), 'ok');
  }

  if (mode === 'launcher') {
    add('包根有 modpack.zip / modpack.mrpack', names.some((n) => /^[^/]+\/(modpack\.zip|modpack\.mrpack)$/.test(n)), 'ok');
    add('包根有 PCL.exe', names.some((n) => /^[^/]+\/PCL\.exe$/.test(n)), 'ok');
  }

  return { ok: items.every((i) => i.ok), items };
}

/**
 * 把 n 向上对齐到「以 base 为起点」的 4 字节边界。
 *
 * 关键：PE 的 VS_VERSIONINFO 填充是相对**块起始位置**算的，不是相对文件开头。
 * 早先直接用 `(n + 3) & ~3` 拿绝对偏移对齐，在根块起点 %4 !== 0 的 exe 上
 * 会整体错位（真 PCL 的根块起始于 2289273，%4 === 1，差 3 字节），读出来全是乱码。
 */
const padTo = (n, base) => base + (((n - base) + 3) & ~3);

/**
 * 递归走 VS_VERSIONINFO 的块结构。
 *
 * 布局（每个块都一样）：
 *   WORD wLength; WORD wValueLength; WORD wType; WCHAR szKey[]; <对齐>; Value; <子块…>
 * wType === 1 是**文本**，此时 wValueLength 是 WCHAR 数（含结尾 \0），要乘 2 才是字节数；
 * wType === 0 是**二进制**，wValueLength 就是字节数（根块的 VS_FIXEDFILEINFO 是 52 字节）。
 *
 * 踩过的坑：早先我按「键后面固定跳 2 字节再对齐」硬算，结果在真 PCL 的 exe 上
 * 解析错位，把 `CacheCow.Client` 当成了 ProductName —— 必须真的走到子块里读。
 */
function walkVersionBlock(buf, start, end, out) {
  let p = start;
  while (p + 6 <= end) {
    const wLength = buf.readUInt16LE(p);
    if (wLength === 0) break;
    const blockEnd = p + wLength;
    if (blockEnd > end) break; // 块长越界，说明已经错位了，别再硬读下去
    const wValueLength = buf.readUInt16LE(p + 2);
    const wType = buf.readUInt16LE(p + 4);

    const keyStart = p + 6;
    let q = keyStart;
    while (q + 1 < blockEnd && !(buf[q] === 0 && buf[q + 1] === 0)) q += 2;
    const key = buf.toString('utf16le', keyStart, q);

    // 填充按「块起点」对齐，不是按文件起点 —— 这是之前读出错位乱码的根因。
    const valStart = padTo(q + 2, start);
    // 文本块 wValueLength 是 WCHAR 数（要乘 2），二进制块才是字节数。
    const valueBytes = wType === 1 ? wValueLength * 2 : wValueLength;
    if (wType === 1 && wValueLength > 0) {
      const vEnd = Math.min(valStart + valueBytes, blockEnd);
      const v = buf.toString('utf16le', valStart, vEnd).replace(/\0+$/, '');
      if (key === 'ProductName') out.productName = v;
      if (key === 'FileDescription') out.fileDescription = v;
      if (key === 'Comments') out.comments = v;
      if (key === 'OriginalFilename') out.originalFilename = v;
    }
    const childStart = padTo(valStart + valueBytes, start);
    if (childStart < blockEnd) walkVersionBlock(buf, childStart, blockEnd, out);
    p = blockEnd;
  }
}

/**
 * 从 PE 的资源目录里找到本体自己的 `RT_VERSION`（类型 16）资源，返回文件偏移 + 长度。
 *
 * 为什么必须走资源目录、不能拿 `indexOf('VS_VERSION_INFO')` 撞：PCL 是 .NET 单文件
 * 打包的 exe，里面**内嵌了十几个程序集**（MeloongCore、NAudio、Json.NET、CacheCow…），
 * 每个程序集都各带一份版本资源。实测 2.10.6 的 exe 里有 **14 份** VS_VERSION_INFO，
 * 第一份是 CacheCow 的，撞上去只会读出别人的产品名。
 * 只有 PE 资源目录里那份 RT_VERSION 才是这个 exe 自己的。
 */
function peVersionResource(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const eLfanew = buf.readUInt32LE(0x3c);
  if (eLfanew + 24 > buf.length) return null;
  if (buf.readUInt32LE(eLfanew) !== 0x00004550) return null; // 'PE\0\0'
  const coff = eLfanew + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const isPlus = buf.readUInt16LE(opt) === 0x20b;
  const ddOff = opt + (isPlus ? 112 : 96);
  const rsrcRva = buf.readUInt32LE(ddOff + 2 * 8); // 数据目录第 3 项 = 资源表
  if (!rsrcRva) return null;

  const secOff = opt + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const s = secOff + i * 40;
    sections.push({
      vsize: buf.readUInt32LE(s + 8),
      va: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      rawPtr: buf.readUInt32LE(s + 20),
    });
  }
  const rvaToOff = (rva) => {
    for (const s of sections) {
      const size = Math.max(s.vsize, s.rawSize);
      if (rva >= s.va && rva < s.va + size) return s.rawPtr + (rva - s.va);
    }
    return -1;
  };
  const base = rvaToOff(rsrcRva);
  if (base < 0) return null;

  // 资源树三层：类型 → 名字 → 语言，第四层才是数据项。
  const walkRes = (dirOff, depth, path) => {
    const named = buf.readUInt16LE(dirOff + 12);
    const ids = buf.readUInt16LE(dirOff + 14);
    for (let i = 0; i < named + ids; i++) {
      const e = dirOff + 16 + i * 8;
      const nameField = buf.readUInt32LE(e);
      const dataField = buf.readUInt32LE(e + 4);
      const isDir = (dataField & 0x80000000) !== 0;
      const id = (nameField & 0x80000000) ? -1 : nameField;
      const child = base + (dataField & 0x7fffffff);
      if (isDir) {
        const r = walkRes(child, depth + 1, [...path, id]);
        if (r) return r;
      } else if (path[0] === 16) {
        return { rva: buf.readUInt32LE(child), size: buf.readUInt32LE(child + 4) };
      }
    }
    return null;
  };

  const leaf = walkRes(base, 0, []);
  if (!leaf) return null;
  const offset = rvaToOff(leaf.rva);
  if (offset < 0 || offset + leaf.size > buf.length) return null;
  return { offset, size: leaf.size };
}

/**
 * 读 PE 的版本信息（ProductName / FileDescription / Comments / OriginalFilename）。
 *
 * 优先走资源目录拿「本体」那份；解析不了（非标准 PE、加壳）时再退化成扫全部块，
 * 并按「最像 PCL」打分挑一份。
 */
export function readPeVersionInfo(exePath) {
  const buf = fs.readFileSync(exePath);
  const res = peVersionResource(buf);
  if (res) {
    const out = {};
    walkVersionBlock(buf, res.offset, res.offset + res.size, out);
    if (Object.keys(out).length) return out;
  }

  const needle = Buffer.from('VS_VERSION_INFO', 'utf16le');
  const all = [];
  for (let at = buf.indexOf(needle); at >= 6; at = buf.indexOf(needle, at + 2)) {
    const start = at - 6;
    const wLength = buf.readUInt16LE(start);
    // 合理性校验：块长至少装得下 6 字节头 + 键名 + 结尾 \0，且不能越界。
    if (wLength < 6 + needle.length + 2 || start + wLength > buf.length) continue;
    const out = {};
    walkVersionBlock(buf, start, start + wLength, out);
    if (Object.keys(out).length) all.push(out);
  }
  if (!all.length) return null;
  const score = (o) => {
    const n = `${o.productName ?? ''} ${o.fileDescription ?? ''} ${o.comments ?? ''}`;
    if (/Admin Manager/i.test(n)) return 4; // 管理员版要能被看见，好让上层拒掉
    if (/Plain Craft Launcher/.test(n)) return 3;
    if (/Launcher|启动器|启动/.test(n)) return 2;
    return 0;
  };
  all.sort((a, b) => score(b) - score(a));
  return all[0];
}

/**
 * 判一个 exe 是不是 PCL 本体。
 *
 * 判定规则照抄 PCL 自己的源码（`ref/PCL2-ModModpack.vb:780-790`）：
 * `FileVersionInfo.ProductName` 等于 "Plain Craft Launcher" → 是；
 * 含 `Launcher` / `启动` 且不等于 "Plain Craft Launcher Admin Manager" → 疑似第三方启动器。
 *
 * 但实测 PCL 2.10.6 的单文件版 **ProductName 是空的**，只有 `Comments = "Minecraft 启动器"`，
 * 严格照抄会把真 PCL 判否。所以这里放宽成：版本信息的任一字段带「启动器 / Launcher」都认，
 * 但 **Admin Manager 优先判否**（它的标识里也含 "Plain Craft Launcher"）。
 *
 * 完全读不到版本信息时退化成扫 UTF-16LE 标记字符串，按「非管理员标记的出现次数」判，
 * 因为单文件 exe 内嵌的程序集元数据里可能同时含两种标记（实测正版里两种都有）。
 */
export function looksLikePcl(exePath) {
  let buf = null;
  let info = null;
  try {
    buf = fs.readFileSync(exePath);
    info = readPeVersionInfo(exePath);
  } catch (e) {
    return { ok: true, detail: `读不了版本信息（${e.message}），按文件名放行` };
  }

  const productName = info?.productName ?? '';
  const fileDescription = info?.fileDescription ?? '';
  const comments = info?.comments ?? '';
  const label = `${fileDescription} ${comments}`.trim();

  // 管理员版优先判否 —— 顺序不能反，它的标识里同样含 "Plain Craft Launcher"。
  if ([productName, fileDescription, comments].some((s) => /Admin Manager/i.test(s))) {
    return { ok: false, productName, detail: '这是管理员版（Admin Manager），PCL 会排除它' };
  }
  if (productName === 'Plain Craft Launcher') return { ok: true, productName, detail: 'ok' };
  if (/Launcher|启动/i.test(productName)) return { ok: true, productName, detail: `ok（${productName}）` };
  if (/Launcher|启动器|启动/i.test(label)) {
    return { ok: true, productName, detail: `ok（版本信息：${label}）` };
  }

  if (!productName && !label) {
    // 版本信息里什么都没有 → 退化成扫 UTF-16LE 标记。
    const count = (s) => {
      const n = Buffer.from(s, 'utf16le');
      let c = 0;
      for (let at = buf.indexOf(n); at >= 0; at = buf.indexOf(n, at + 2)) c++;
      return c;
    };
    const pcl = count('Plain Craft Launcher');
    const admin = count('Plain Craft Launcher Admin Manager');
    // 搜 "Plain Craft Launcher" 会连管理员版那串一起命中，所以要用差值。
    if (admin > 0 && pcl - admin <= 0) {
      return { ok: false, detail: '这是管理员版（Admin Manager），PCL 会排除它' };
    }
    if (pcl - admin > 0) {
      return { ok: true, detail: '按 UTF-16LE 标记判定为 PCL（未读到版本信息）' };
    }
    return { ok: false, detail: '既没有版本信息，也没有 PCL 的标记字符串' };
  }

  return { ok: false, productName, detail: `版本信息是「${label}」，不像 PCL` };
}
