/**
 * 官方 Java 运行时：从 Mojang 的运行时清单里把一个 JRE 下到本地。
 *
 * 为什么需要这个：跑 Forge / NeoForge 安装器要对应主版本的 Java。
 * 本机只有一个 Java 21，而 MC 1.20.1 的 Forge 安装器要 Java 17 —— 少了它就装不了。
 * 好在 Mojang 官方启动器本来就是这么干的：一份运行时清单（all.json）指向几百个
 * 小文件，逐个下到 `<mcRoot>/runtime/<组件名>/`，入口是 `bin/java.exe`。
 *
 * 目录名必须正好用组件名（`java-runtime-gamma` 之类），因为 `lib/core/java.js`
 * 是靠「扫 `<mcRoot>/runtime` 的子目录」来自动发现 JRE 的，名字换了它就找不到。
 *
 * 这一层分三段：`planJavaRuntime` 只算不写（纯函数，方便测），
 * `applyJavaRuntime` 才真下真写，`describeJavaRuntime` 给人和面板看。
 *
 * 只用清单里的 `downloads.raw`。`lzma` 是压缩体（Mojang 自己解压用的），
 * 我们不解压，用了反而会得到一堆打不开的文件。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { McError } from './errors.js';

/** Mojang 官方运行时索引（顶层键是平台，平台下面是组件名）。 */
export const JAVA_RUNTIME_INDEX_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

/**
 * 主版本 → 组件名（取自官方清单里实际存在的组件，PCL 也是这么对应的）。
 *
 * 8 是 1.8 时代的老 JRE，16/17/21 是后来几个 LTS。
 * 查表查不到就返回空串，由调用方决定怎么办。
 */
export const COMPONENT_BY_MAJOR = {
  8: 'jre-legacy',
  16: 'java-runtime-alpha',
  17: 'java-runtime-gamma',
  21: 'java-runtime-delta',
};

/** 一次并发下几个文件（运行时是几百个小文件，靠并发压延迟）。 */
export const FILE_CONCURRENCY = 8;

/**
 * Node 的 platform / arch → 官方清单里的平台键。
 *
 * 官方只提供这几档：windows-x64 / windows-x86 / windows-arm64 / linux /
 * linux-i386 / mac-os / mac-os-arm64。认不出来的组合宁可报错，也别乱下
 * 一个架构不对的 JRE（能下下来但一启动就崩，排查起来更费劲）。
 *
 * @param {string} [platform] 默认 `process.platform`
 * @param {string} [arch] 默认 `process.arch`
 * @returns {'windows-x64'|'windows-x86'|'windows-arm64'|'linux'|'linux-i386'|'mac-os'|'mac-os-arm64'}
 */
export function platformKey(platform = process.platform, arch = process.arch) {
  const os = String(platform ?? '').toLowerCase();
  const cpu = String(arch ?? '').toLowerCase();

  if (os === 'win32' || os === 'windows') {
    if (cpu === 'x64') return 'windows-x64';
    if (cpu === 'ia32' || cpu === 'x86') return 'windows-x86';
    if (cpu === 'arm64') return 'windows-arm64';
    throw new McError(
      `官方运行时清单里没有 Windows/${cpu || '未知'} 的 Java`,
      '这种架构很少见，可以自己装一个 Java 17 或 21，再把路径填进设置里',
      'JavaRuntimePlatform',
    );
  }

  if (os === 'darwin' || os === 'macos' || os === 'mac') {
    return cpu === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  }

  if (os === 'linux') {
    if (cpu === 'ia32' || cpu === 'x86') return 'linux-i386';
    if (cpu === 'arm64' || cpu === 'arm') {
      // 官方清单里没有 Linux ARM 的条目；硬套 linux（x86）会下到跑不起来的二进制。
      throw new McError(
        '官方运行时清单里没有 Linux ARM 版的 Java',
        '用系统包管理器装一个（比如 apt install openjdk-17-jre），再把路径填进设置里',
        'JavaRuntimePlatform',
      );
    }
    return 'linux';
  }

  throw new McError(
    `官方运行时清单里没有 ${os || '未知系统'} 的 Java`,
    '目前只支持 Windows、macOS、Linux；其它系统请自己装 Java',
    'JavaRuntimePlatform',
  );
}

/**
 * 主版本号 → 组件名。
 *
 * @param {number|string} majorVersion 例如 17
 * @returns {string} 查不到返回空串（不抛错，让调用方决定换成什么）
 */
export function componentForMajor(majorVersion) {
  const major = Number(majorVersion);
  if (!Number.isFinite(major)) return '';
  return COMPONENT_BY_MAJOR[major] ?? '';
}

/**
 * 从运行时索引里挑出一个具体条目。
 *
 * 索引的形状：`allJson[平台][组件名] = [条目, ...]`，同一组件可能有多个版本，
 * 官方启动器取第一个，我们也取第一个（第一个就是它自己推荐的那个）。
 *
 * @param {any} allJson 索引 JSON
 * @param {{component: string, platform?: string}} opts
 * @returns {{component: string, version: string, manifestUrl: string, manifestSha1: string, manifestSize: number}}
 */
export function pickRuntimeEntry(allJson, opts = {}) {
  const component = String(opts.component ?? '').trim();
  if (!component) {
    throw new McError(
      '没给 Java 运行时组件名，不知道要下哪一个',
      '可以按主版本查表：Java 17 是 java-runtime-gamma，Java 21 是 java-runtime-delta',
      'JavaRuntimeNoComponent',
    );
  }

  const platform = String(opts.platform ?? platformKey());
  const table = allJson && typeof allJson === 'object' ? allJson[platform] : undefined;
  const raw = table && typeof table === 'object' ? table[component] : undefined;
  const entry = Array.isArray(raw) ? raw[0] : raw;

  if (!entry || !entry.manifest || !entry.manifest.url) {
    throw new McError(
      `官方运行时清单里没有 ${component}`,
      '可以换一个 Java 主版本，或者手动装 Java',
      'JavaRuntimeMissing',
    );
  }

  return {
    component,
    version: String(entry.version?.name ?? ''),
    manifestUrl: String(entry.manifest.url),
    manifestSha1: String(entry.manifest.sha1 ?? ''),
    manifestSize: Number(entry.manifest.size ?? 0) || 0,
  };
}

/**
 * 运行时装在哪儿：`<mcRoot>/runtime/<组件名>`。
 *
 * 目录名必须是组件名本身 —— `lib/core/java.js` 会扫 `<mcRoot>/runtime` 的
 * 子目录来自动发现 JRE。
 *
 * @param {string} mcRoot Minecraft 根目录
 * @param {string} component 组件名，如 java-runtime-gamma
 * @returns {string}
 */
export function runtimeDir(mcRoot, component) {
  const root = String(mcRoot ?? '').trim();
  const name = String(component ?? '').trim();
  if (!root) {
    throw new McError('不知道要把 Java 装到哪个目录', '要传 Minecraft 根目录（含 runtime/ 的那种）', 'JavaRuntimeNoRoot');
  }
  if (!name) {
    throw new McError('不知道要把 Java 装成哪个目录名', '目录名要用官方清单里的组件名，比如 java-runtime-gamma', 'JavaRuntimeNoComponent');
  }
  return path.join(path.resolve(root), 'runtime', name);
}

/** 文件已存在且大小一致就算有了（和 `version-install.js` 里的 alreadyHave 同思路）。 */
function alreadyHave(file) {
  try {
    const stat = fs.statSync(file.absPath);
    if (!stat.isFile()) return false;
    if (file.size > 0 && stat.size !== file.size) return false;
    return stat.size > 0;
  } catch {
    return false;
  }
}

/** 把字节数说成人话（本模块自己一份，不从别的模块 import）。 */
export function formatBytes(bytes) {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 算「装这个 JRE 要下什么」。纯函数：不联网、不写盘。
 *
 * 去重的原因很实际：官方清单里同一个 sha1 会出现在好几个路径下（比如符号链接
 * 被展开成了真文件），1.20.1 那个 JRE 一共 403 个文件，其中几十个是这种重复的，
 * 不处理就白下一遍。
 *
 * @param {object} opts
 * @param {any} [opts.index] 运行时索引（这里只为对齐调用方参数，不参与计算）
 * @param {any} opts.manifest 组件自己的 manifest.json（`{ files: {...} }`）
 * @param {string} [opts.component] 组件名；不给就取 manifest 里的名字
 * @param {string} opts.mcRoot Minecraft 根目录
 * @param {string} [opts.platform] 平台键；决定入口是 java.exe 还是 java
 * @param {string} [opts.version] 版本号，例如 "17.0.15"
 */
export function planJavaRuntime(opts = {}) {
  const manifest = opts.manifest;
  const files = manifest && typeof manifest === 'object' ? manifest.files : null;
  if (!files || typeof files !== 'object') {
    throw new McError(
      '官方运行时清单的内容不对（没有 files）',
      '可能是下到的 manifest.json 不对或者被截断了，重试一次',
      'JavaRuntimeBadManifest',
    );
  }

  const component = String(opts.component ?? '').trim();
  const dir = runtimeDir(opts.mcRoot, component);
  const platform = String(opts.platform ?? platformKey());
  const exe = platform.startsWith('windows') ? 'java.exe' : 'java';

  const entries = [];
  for (const [relPath, raw] of Object.entries(files)) {
    const kind = String(raw?.type ?? '');

    // 目录：只建目录，没有下载内容
    if (kind === 'directory') {
      entries.push({
        relPath,
        absPath: path.join(dir, relPath),
        type: 'directory',
        sha1: '',
        size: 0,
        url: '',
        candidates: [],
        executable: false,
      });
      continue;
    }

    // 没有 raw 下载地址的条目下不了（官方清单里目前没见过，但别让它炸整单）
    const rawDownload = raw?.downloads?.raw;
    if (!rawDownload || !rawDownload.url) continue;

    const sha1 = String(rawDownload.sha1 ?? '');
    const size = Number(rawDownload.size ?? 0) || 0;
    const url = String(rawDownload.url);
    entries.push({
      relPath,
      absPath: path.join(dir, relPath),
      type: 'file',
      sha1,
      size,
      url,
      candidates: [url],
      executable: raw?.executable === true,
    });
  }

  const fileEntries = entries.filter((entry) => entry.type === 'file');
  const dirCount = entries.length - fileEntries.length;

  // 按「sha1 + 大小」分组：同一份内容只真下一次，其余用复制。
  const groups = new Map();
  for (const entry of fileEntries) {
    if (!entry.sha1) continue; // 没 sha1 的没法判断是不是同一份，各下各的
    const key = `${entry.sha1}:${entry.size}`;
    const list = groups.get(key);
    if (list) list.push(entry.relPath);
    else groups.set(key, [entry.relPath]);
  }
  const dedupeGroups = [];
  let downloadBytes = 0;
  for (const [key, relPaths] of groups) {
    const [sha1, sizeText] = key.split(':');
    downloadBytes += Number(sizeText) || 0;
    if (relPaths.length > 1) dedupeGroups.push({ sha1, size: Number(sizeText) || 0, relPaths });
  }
  // 没有 sha1 的文件没人替它去重，单独计一份
  for (const entry of fileEntries) {
    if (!entry.sha1) downloadBytes += entry.size;
  }

  return {
    component,
    version: String(opts.version ?? ''),
    dir,
    javaPath: path.join(dir, 'bin', exe),
    entries,
    files: fileEntries,
    dedupeGroups,
    totalBytes: fileEntries.reduce((sum, entry) => sum + entry.size, 0),
    downloadBytes,
    fileCount: fileEntries.length,
    dirCount,
  };
}

/**
 * 联网算计划：拉索引 → 挑条目 → 拉组件清单 → 组装计划。
 *
 * @param {object} opts
 * @param {any} opts.http `lib/core/mod-fetch.js` 的 createHttp() 返回对象
 * @param {string} [opts.component] 组件名；不给就按 majorVersion 查表
 * @param {number} [opts.majorVersion] Java 主版本，例如 17
 * @param {string} opts.mcRoot Minecraft 根目录
 * @param {string} [opts.platform] 平台键；不给就用本机
 * @param {AbortSignal} [opts.signal] 取消信号（http.json 内部有自己的超时，这里只留给调用方）
 */
export async function loadJavaRuntimePlan(opts = {}) {
  const http = opts.http;
  if (!http || typeof http.json !== 'function') {
    throw new McError(
      '没有联网能力，装不了官方 Java 运行时',
      '需要一个 createHttp() 返回的对象（带 json 和 downloadToFile）',
      'JavaRuntimeNoHttp',
    );
  }

  const majorVersion = opts.majorVersion;
  const component = String(opts.component ?? '').trim() || componentForMajor(majorVersion);
  if (!component) {
    throw new McError(
      `不知道该装哪个 Java 运行时（主版本 ${majorVersion ?? '未知'}）`,
      '可以自己指定组件名，比如 Java 17 用 java-runtime-gamma',
      'JavaRuntimeNoComponent',
    );
  }

  const platform = String(opts.platform ?? platformKey());
  const index = await http.json(JAVA_RUNTIME_INDEX_URL);
  const entry = pickRuntimeEntry(index, { component, platform });
  const manifest = await http.json(entry.manifestUrl);

  return planJavaRuntime({
    index,
    manifest,
    component,
    mcRoot: opts.mcRoot,
    platform,
    version: entry.version,
  });
}

/**
 * 真下载、真写盘。
 *
 * 不抛异常：网络抖一下、某个文件 404，都收进 `failed` 里交回上层决定怎么报。
 * 上层拿到 `ok: false` 还能看到「哪一个文件没下来、为什么」。
 *
 * @param {object} opts
 * @param {any} opts.plan `planJavaRuntime` 的结果
 * @param {any} opts.http createHttp() 返回对象
 * @param {(p: {stage: string, done: number, total: number, bytes: number, current: string}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.concurrency] 并发数，默认 8
 */
export async function applyJavaRuntime(opts = {}) {
  const plan = opts.plan;
  if (!plan || !plan.dir) {
    throw new McError(
      '没有可安装的 Java 运行时计划',
      '先调 loadJavaRuntimePlan 算出「要下什么」，再把结果传进来',
      'JavaRuntimeNoPlan',
    );
  }
  const http = opts.http;
  const hasDownloader = typeof http?.downloader?.download === 'function';
  const hasDownloadToFile = typeof http?.downloadToFile === 'function';
  if (!hasDownloader && !hasDownloadToFile) {
    throw new McError(
      '没有下载能力，装不了官方 Java 运行时',
      '需要一个 createHttp() 返回的对象（带 downloader 或 downloadToFile）',
      'JavaRuntimeNoHttp',
    );
  }

  const signal = opts.signal;
  const entries = Array.isArray(plan.entries) ? plan.entries : [];
  const files = entries.filter((entry) => entry.type === 'file');
  const dirs = entries.filter((entry) => entry.type === 'directory');
  const downloaded = [];
  const copied = [];
  const skipped = [];
  const failed = [];
  let bytes = 0;
  let done = 0;
  const total = files.length;

  const report = (current = '') => {
    opts.onProgress?.({ stage: 'progress', done, total, bytes, current });
  };

  await fsp.mkdir(plan.dir, { recursive: true });

  // 目录条目（里面如果还有别的目录，后面建文件时也会自动补上）
  for (const dir of dirs) {
    try {
      await fsp.mkdir(dir.absPath, { recursive: true });
    } catch (error) {
      failed.push({ relPath: dir.relPath, error: error?.message ?? String(error) });
    }
  }

  // 去重：同「sha1 + 大小」只下第一条，其余从它复制。
  const leaderOf = new Map();
  for (const file of files) {
    if (!file.sha1) continue;
    const key = `${file.sha1}:${file.size}`;
    if (!leaderOf.has(key)) leaderOf.set(key, file);
  }
  const leaders = [];
  const followers = [];
  for (const file of files) {
    const leader = file.sha1 ? leaderOf.get(`${file.sha1}:${file.size}`) : null;
    if (leader && leader !== file) followers.push({ file, leader });
    else leaders.push(file);
  }

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= leaders.length) return;
      const file = leaders[index];

      try {
        if (alreadyHave(file)) {
          skipped.push(file.relPath);
        } else {
          await fsp.mkdir(path.dirname(file.absPath), { recursive: true });
          const expect = { sha1: file.sha1, size: file.size, signal };
          const result = hasDownloader
            ? await http.downloader.download(file.candidates, file.absPath, expect)
            : await http.downloadToFile(file.candidates[0], file.absPath, expect);
          bytes += Number(result?.bytes ?? file.size ?? 0) || 0;
          downloaded.push(file.relPath);
        }
      } catch (error) {
        failed.push({ relPath: file.relPath, error: error?.message ?? String(error) });
      }
      done += 1;
      report(file.relPath);
    }
  };

  const limit = Math.max(1, Math.min(Number(opts.concurrency ?? FILE_CONCURRENCY) || FILE_CONCURRENCY, 16));
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(leaders.length, 1)) }, worker));

  // 去重组里剩下的路径：从已经下好的那份复制过去（清单里它们内容一样）。
  for (const { file, leader } of followers) {
    if (signal?.aborted) break;
    try {
      await fsp.mkdir(path.dirname(file.absPath), { recursive: true });
      await fsp.copyFile(leader.absPath, file.absPath);
      copied.push(file.relPath);
    } catch (error) {
      failed.push({ relPath: file.relPath, error: error?.message ?? String(error) });
    }
    done += 1;
    report(file.relPath);
  }

  let ok = failed.length === 0;
  // 兜底：清单里要是没有 bin/java.exe 这个入口（换个组件或官方改布局时可能发生），
  // 别让上层以为装成功了。
  if (ok && plan.javaPath && !fs.existsSync(plan.javaPath)) {
    failed.push({ relPath: 'bin/java.exe', error: '清单里没有 Java 入口文件，装出来的运行时不完整' });
    ok = false;
  }

  return {
    ok,
    javaPath: plan.javaPath ?? '',
    version: plan.version ?? '',
    downloaded,
    copied,
    skipped,
    bytes,
    failed,
    aborted: Boolean(signal?.aborted),
  };
}

/**
 * 整理成给人看的几行中文（工具输出和面板都用它）。
 *
 * @param {any} plan `planJavaRuntime` 的结果
 * @returns {string[]}
 */
export function describeJavaRuntime(plan) {
  if (!plan) return [];
  const version = String(plan.version ?? '').trim();
  const lines = [`Java：官方运行时 ${plan.component}${version ? ` ${version}` : ''}`];
  if (plan.dir) lines.push(`  装到：${plan.dir}`);

  const fileCount = Number(plan.fileCount ?? plan.files?.length ?? 0);
  const totalBytes = Number(plan.totalBytes ?? 0);
  const downloadBytes = Number(plan.downloadBytes ?? totalBytes);
  // 有去重才提「去重后」，没有就不写，免得一行里两个一样的数字
  const dedupe = downloadBytes > 0 && downloadBytes < totalBytes
    ? `（去重后 ${formatBytes(downloadBytes)}）`
    : '';
  lines.push(`  要下 ${fileCount} 个文件、${formatBytes(totalBytes)}${dedupe}`);

  return lines;
}