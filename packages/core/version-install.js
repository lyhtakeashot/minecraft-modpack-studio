/**
 * 装一个全新的游戏底座：原版文件 + 加载器。
 *
 * 分工是这样的（踩过坑才定下来的）：
 *
 * - **下载归我们**：客户端 jar、libraries、assets、加载器依赖，全部用
 *   `downloader.js` 那套分段并行去下，走 BMCLAPI 镜像。因为本机实测
 *   `maven.neoforged.net` 直连超时，而安装器自己的 `--mirror` 参数对库下载不生效。
 * - **打补丁归安装器**：NeoForge/Forge 的客户端要跑 10 个 processor（拆 jar、
 *   重映射、打二进制补丁）才能产出 `neoforge-<版本>-client.jar`。这些是 Java 程序，
 *   纯 JS 复刻不现实，所以把依赖都摆好之后让安装器用 `--offline` 跑一遍。
 *
 * 所以这个模块只做三件事：算清单、下文件、调安装器。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { McError } from './errors.js';
import { captureCommand } from './proc.js';
import { rulesAllow } from './launch.js';
import { openZip } from './zip.js';
import {
  assetObjects,
  assetUrl,
  candidateUrlsFor,
  libraryArtifact,
  parseVersionJson,
  toMirror,
} from './version-manifest.js';

/** 一次并发下多少个文件（assets 有几千个小文件，靠这个和连接池一起扛）。 */
export const FILE_CONCURRENCY = 8;

/** 老版本 Minecraft 的 java 版本要求，用于提示。 */
const JAVA_HINT = '游戏要 Java 21（1.20.5 以后都是 21），本机 PCL 的 runtime 里有一个可以直接用';

/**
 * maven 坐标 → 仓库里的相对路径。
 *
 * `group:artifact:version[:classifier][@ext]` → `group/artifact/version/artifact-version[-classifier].ext`
 *
 * @param {string} name 例如 `net.neoforged:neoform:1.21.1-20240808.144430@zip`
 * @returns {string}
 */
export function mavenPath(name) {
  const text = String(name ?? '').trim();
  if (!text) throw new McError('maven 坐标是空的', '检查安装器里的 libraries 字段', 'MavenBad');
  const at = text.indexOf('@');
  const coords = at >= 0 ? text.slice(0, at) : text;
  const ext = at >= 0 ? text.slice(at + 1) : 'jar';
  const parts = coords.split(':');
  if (parts.length < 3) throw new McError(`maven 坐标格式不对：${text}`, '要像 group:artifact:version', 'MavenBad');
  const [group, artifact, version, classifier] = parts;
  const groupPath = group.replace(/\./g, '/');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return `${groupPath}/${artifact}/${version}/${file}`;
}

/** maven 坐标 → 官方仓库地址（用的时候再走镜像）。 */
export function mavenUrl(name, base = 'https://maven.neoforged.net/releases/') {
  return base + mavenPath(name);
}

/**
 * 把一批库条目变成「要下的文件」。
 *
 * 同一路径只留一次（安装器的 profile 和 version 会重复列）。
 *
 * @param {any[]} libraries
 * @param {{mcRoot: string, mirrorMode?: string, env?: object}} opts
 * @returns {Array<{kind: string, relPath: string, absPath: string, size: number, sha1: string, url: string, candidates: string[]}>}
 */
export function libraryItems(libraries, opts) {
  const mcRoot = path.resolve(opts.mcRoot);
  const libRoot = path.join(mcRoot, 'libraries');
  const env = opts.env ?? {};
  const mirrorMode = opts.mirrorMode ?? 'fallback';
  const seen = new Set();
  const items = [];

  for (const lib of libraries ?? []) {
    if (!lib) continue;
    if (!rulesAllow(lib.rules, env)) continue;
    const art = libraryArtifact(lib);
    if (!art?.path) continue;
    if (seen.has(art.path)) continue;
    seen.add(art.path);
    items.push({
      kind: 'library',
      relPath: art.path,
      absPath: path.join(libRoot, art.path),
      size: art.size,
      sha1: art.sha1,
      url: art.url,
      candidates: candidateUrlsFor(art.url, mirrorMode),
    });
  }

  return items;
}

/**
 * 算「装一个原版要下什么」。
 *
 * @param {{versionJson: any, mcRoot: string, mirrorMode?: string, includeAssets?: boolean, includeLogging?: boolean, env?: object}} opts
 * @returns {{target: object, items: object[], assetItems: object[], totalBytes: number, assetBytes: number, counts: object}}
 */
export function planCore(opts) {
  const mcRoot = path.resolve(opts.mcRoot);
  const mirrorMode = opts.mirrorMode ?? 'fallback';
  const env = opts.env ?? {};
  const target = parseVersionJson(opts.versionJson);
  const items = [];

  if (target.clientJar) {
    items.push({
      kind: 'clientJar',
      relPath: target.clientJar.path,
      absPath: path.join(mcRoot, target.clientJar.path),
      size: target.clientJar.size,
      sha1: target.clientJar.sha1,
      url: target.clientJar.url,
      candidates: candidateUrlsFor(target.clientJar.url, mirrorMode),
    });
  }

  items.push(...libraryItems(target.libraries, { mcRoot, mirrorMode, env }));

  if (opts.includeLogging !== false && target.logging) {
    const logPath = `assets/log_configs/${target.logging.path}`;
    items.push({
      kind: 'logging',
      relPath: logPath,
      absPath: path.join(mcRoot, logPath),
      size: target.logging.size,
      sha1: target.logging.sha1,
      url: target.logging.url,
      candidates: candidateUrlsFor(target.logging.url, mirrorMode),
    });
  }

  if (target.assetIndex) {
    const indexPath = `assets/indexes/${target.assetIndex.id}.json`;
    items.push({
      kind: 'assetIndex',
      relPath: indexPath,
      absPath: path.join(mcRoot, indexPath),
      size: target.assetIndex.size,
      sha1: target.assetIndex.sha1,
      url: target.assetIndex.url,
      candidates: candidateUrlsFor(target.assetIndex.url, mirrorMode),
    });
  }

  return {
    target,
    items,
    totalBytes: items.reduce((sum, item) => sum + (item.size || 0), 0),
    counts: {
      clientJar: items.filter((item) => item.kind === 'clientJar').length,
      libraries: items.filter((item) => item.kind === 'library').length,
      logging: items.filter((item) => item.kind === 'logging').length,
      assetIndex: items.filter((item) => item.kind === 'assetIndex').length,
    },
  };
}

/**
 * 把资源索引里的对象变成下载条目。
 *
 * @param {any} indexJson
 * @param {{mcRoot: string, mirrorMode?: string}} opts
 */
export function assetItems(indexJson, opts) {
  const mcRoot = path.resolve(opts.mcRoot);
  const mirrorMode = opts.mirrorMode ?? 'fallback';
  const assetsRoot = path.join(mcRoot, 'assets');
  const objects = assetObjects(indexJson);
  const items = objects.map((object) => ({
    kind: 'asset',
    relPath: `assets/${object.path}`,
    absPath: path.join(assetsRoot, object.path),
    size: object.size,
    sha1: object.hash,
    url: assetUrl(object.hash),
    candidates: candidateUrlsFor(assetUrl(object.hash), mirrorMode),
  }));
  return {
    items,
    totalBytes: items.reduce((sum, item) => sum + (item.size || 0), 0),
    count: items.length,
  };
}

/**
 * 按候选顺序拉一个 JSON，每个地址多试几次。
 *
 * 为什么要多重试：BMCLAPI 的域名解析到一组节点，其中个别节点连不上
 * （实测 `bmclapi24.sakura.sld.tw` 必超时），而每次连接会重新选节点，
 * 所以「多试几次」比「换地址」更有效。
 *
 * 为什么不直接用 `http.json`：`mod-fetch.js` 里的镜像规则只认 Modrinth /
 * CurseForge，Mojang 和 neoforge 的地址得用 `version-manifest.js` 自己那套规则。
 *
 * @param {any} http
 * @param {string[]} candidates
 * @param {{attempts?: number}} [opts]
 */
export async function fetchJsonFrom(http, candidates, opts = {}) {
  const attempts = Math.max(1, Number(opts.attempts ?? 3));
  const urls = Array.isArray(candidates) ? candidates : [candidates];
  let lastError;
  for (const url of urls) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await http.json(url);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError ?? new McError('没有可用的地址', '检查网络，或者把镜像档位换成 official', 'McNoRequest');
}

/**
 * 同 `fetchJsonFrom`，但要**纯文本**。
 *
 * Forge 的版本列表是 maven 的 `maven-metadata.xml`（XML），用 `http.json()` 会在
 * 「返回的不是 JSON」那一步就炸掉。所以补一个文本版，重试/换地址的策略完全一致。
 *
 * @param {any} http
 * @param {string[]} candidates
 * @param {{attempts?: number}} [opts]
 * @returns {Promise<string>}
 */
export async function fetchTextFrom(http, candidates, opts = {}) {
  const attempts = Math.max(1, Number(opts.attempts ?? 3));
  const urls = Array.isArray(candidates) ? candidates : [candidates];
  let lastError;
  for (const url of urls) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        // 适配器没实现 text 时（老测试桩）退一步：json() 能解析出对象就转回字符串
        if (typeof http.text === 'function') return await http.text(url);
        const raw = await http.json(url);
        return typeof raw === 'string' ? raw : JSON.stringify(raw);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError ?? new McError('没有可用的地址', '检查网络，或者把镜像档位换成 official', 'McNoRequest');
}

/**
 * 算完整的原版清单（含资源）。资源索引本身要联网拉，所以这是 async。
 *
 * @param {{http: any, versionJson: any, mcRoot: string, mirrorMode?: string, includeAssets?: boolean, env?: object}} opts
 */
export async function buildVanillaPlan(opts) {
  const core = planCore(opts);
  const includeAssets = opts.includeAssets !== false;
  if (!includeAssets || !core.target.assetIndex) {
    return { ...core, assetItems: [], assetBytes: 0, assetCount: 0, allItems: core.items };
  }

  const indexUrl = core.target.assetIndex.url;
  const indexCandidates = candidateUrlsFor(indexUrl, opts.mirrorMode ?? 'fallback');
  const indexJson = await fetchJsonFrom(opts.http, indexCandidates);
  const assets = assetItems(indexJson, { mcRoot: opts.mcRoot, mirrorMode: opts.mirrorMode });
  return {
    ...core,
    assetItems: assets.items,
    assetBytes: assets.totalBytes,
    assetCount: assets.count,
    allItems: [...core.items, ...assets.items],
  };
}

/** 文件已存在且大小一致就算有了（资源有几千个，不逐个算 sha1，太慢）。 */
function alreadyHave(item) {
  try {
    const stat = fs.statSync(item.absPath);
    if (!stat.isFile()) return false;
    if (item.size > 0 && stat.size !== item.size) return false;
    return stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * 真下载。
 *
 * @param {{http: any, items: object[], concurrency?: number, onProgress?: Function, signal?: AbortSignal, skipExisting?: boolean}} opts
 * @returns {Promise<{downloaded: object[], skipped: object[], failed: object[], bytes: number}>}
 */
export async function applyItems(opts) {
  const items = opts.items ?? [];
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency ?? FILE_CONCURRENCY), 16));
  const skipExisting = opts.skipExisting !== false;
  const downloaded = [];
  const skipped = [];
  const failed = [];
  let bytes = 0;
  let done = 0;

  const report = () => {
    opts.onProgress?.({
      stage: 'progress',
      done,
      total: items.length,
      bytes,
      current: downloaded.at(-1)?.relPath ?? '',
    });
  };

  let cursor = 0;
  /**
   * 下单个文件。成功返回 'ok'，跳过返回 'skipped'，失败返回 'failed'（并记进 failed）。
   *
   * 抽出来是为了「慢速补一遍」那次重试用同一套逻辑，不复制粘贴。
   */
  const attempt = async (item) => {
    try {
      if (skipExisting && alreadyHave(item)) {
        skipped.push(item);
        return 'skipped';
      }
      await fsp.mkdir(path.dirname(item.absPath), { recursive: true });
      const expect = { sha1: item.sha1, size: item.size, signal: opts.signal };
      // 有 downloader 就直接喂候选地址列表（镜像优先 + 官方兜底都是我们自己排的）
      const result = opts.http.downloader
        ? await opts.http.downloader.download(item.candidates, item.absPath, expect)
        : await opts.http.downloadToFile(item.candidates[0], item.absPath, expect);
      bytes += result?.bytes ?? item.size ?? 0;
      downloaded.push({ ...item, mode: result?.mode });
      return 'ok';
    } catch (error) {
      failed.push({ ...item, error: error?.message ?? String(error), code: error?.code ?? '' });
      return 'failed';
    }
  };

  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await attempt(items[index]);
      done += 1;
      report();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, worker));

  // 第二遍：失败的重来一次，但降到 2 并发并错开。
  // 实测资源 CDN（resources.download.minecraft.net）在 8 并发下会零星回 429 / fetch failed，
  // 慢一点几乎都能过；不补这一遍的话，装个底座会因为三五个资源文件整体失败。
  const shouldRetry = failed.length > 0 && !opts.signal?.aborted && opts.retryFailures !== false;
  const retryables = shouldRetry ? failed.splice(0, failed.length) : [];
  if (shouldRetry) {
    let retryCursor = 0;
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const retryWorker = async () => {
      for (;;) {
        if (opts.signal?.aborted) return;
        const index = retryCursor;
        retryCursor += 1;
        if (index >= retryables.length) return;
        await pause(1000 + (index % 3) * 700); // 错开一点，别又同时撞上去
        await attempt(retryables[index]);
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, retryables.length) }, retryWorker));
  }

  report();
  return { downloaded, skipped, failed, bytes };
}

/**
 * 读安装器里的两个 json。
 *
 * @param {Buffer|string} installer 安装器内容或路径
 * @returns {{spec: number, profileId: string, versionJson: any, processors: any[], data: object, libraries: any[]}}
 */
export function readInstallerProfile(installer) {
  const buffer = Buffer.isBuffer(installer) ? installer : fs.readFileSync(installer);
  const zip = openZip(buffer);
  if (!zip.has('install_profile.json')) {
    throw new McError('这个安装器里没有 install_profile.json', '可能下错了文件，或者是 fat installer', 'InstallerBad');
  }
  const profile = JSON.parse(zip.text('install_profile.json'));
  const versionJson = zip.has('version.json') ? JSON.parse(zip.text('version.json')) : null;

  return {
    spec: Number(profile.spec ?? 0),
    profileId: String(profile.profile ?? ''),
    versionJson,
    processors: Array.isArray(profile.processors) ? profile.processors : [],
    data: profile.data ?? {},
    libraries: Array.isArray(profile.libraries) ? profile.libraries : [],
    minecraft: String(profile.minecraft ?? ''),
    hasVersionJson: Boolean(versionJson),
  };
}

/**
 * 算加载器要下的依赖。
 *
 * 三个来源合起来：
 * 1. `install_profile.libraries`（70 个左右，含 processor 自己的依赖）；
 * 2. `version.json.libraries`（47 个左右，运行时要的）；
 * 3. 每个 processor 的 `classpath` 里那些（万一前两个没覆盖到）。
 *
 * 第 3 类没有下载地址，只能按 maven 坐标拼，所以都从 neoforge 仓库取。
 *
 * @param {{profile: ReturnType<typeof readInstallerProfile>, mcRoot: string, mirrorMode?: string, env?: object}} opts
 */
export function buildLoaderPlan(opts) {
  const profile = opts.profile;
  const mcRoot = path.resolve(opts.mcRoot);
  const mirrorMode = opts.mirrorMode ?? 'fallback';
  const env = opts.env ?? {};

  const items = [];
  const seen = new Set();

  const push = (item) => {
    if (seen.has(item.relPath)) return;
    seen.add(item.relPath);
    items.push(item);
  };

  // 1 + 2：这两个都带完整下载信息，直接复用 libraryItems 的逻辑
  for (const item of libraryItems(profile.libraries, { mcRoot, mirrorMode, env })) push(item);
  for (const item of libraryItems(profile.versionJson?.libraries ?? [], { mcRoot, mirrorMode, env })) push(item);

  // 3：processor 的 classpath，没有下载信息，按坐标拼
  const libRoot = path.join(mcRoot, 'libraries');
  for (const processor of profile.processors ?? []) {
    const names = [...(processor.classpath ?? []), processor.jar].filter(Boolean);
    for (const name of names) {
      let relPath;
      try {
        relPath = mavenPath(name);
      } catch {
        continue;
      }
      if (seen.has(relPath)) continue;
      const url = mavenUrl(name);
      push({
        kind: 'loaderLibrary',
        relPath,
        absPath: path.join(libRoot, relPath),
        size: 0,
        sha1: '',
        url,
        candidates: candidateUrlsFor(url, mirrorMode),
      });
    }
  }

  return {
    items,
    totalBytes: items.reduce((sum, item) => sum + (item.size || 0), 0),
    counts: {
      profileLibraries: profile.libraries.length,
      versionLibraries: profile.versionJson?.libraries?.length ?? 0,
      processors: profile.processors.length,
      total: items.length,
    },
  };
}

/**
 * 跑安装器（只跑打补丁那一步，所以默认 offline）。
 *
 * @param {{javaPath: string, installerPath: string, mcRoot: string, offline?: boolean, timeoutMs?: number, cwd?: string}} opts
 * @returns {Promise<{ok: boolean, code: number, output: string, logFile: string}>}
 */
export async function runInstaller(opts) {
  const javaPath = String(opts.javaPath ?? '');
  if (!javaPath) throw new McError('没给 java 路径', JAVA_HINT, 'NoJava');
  if (!fs.existsSync(javaPath)) throw new McError(`java 不存在：${javaPath}`, JAVA_HINT, 'NoJava');
  const installerPath = path.resolve(opts.installerPath);
  if (!fs.existsSync(installerPath)) throw new McError(`安装器不存在：${installerPath}`, '先把它下载下来', 'InstallerMissing');

  const mcRoot = path.resolve(opts.mcRoot);
  const args = ['-jar', installerPath, '--installClient', mcRoot];
  if (opts.offline !== false) args.push('--offline');

  // 安装器要求目标目录有 launcher_profiles.json，否则直接拒绝
  const profilesFile = path.join(mcRoot, 'launcher_profiles.json');
  if (!fs.existsSync(profilesFile)) {
    await fsp.writeFile(
      profilesFile,
      JSON.stringify({ profiles: {}, selectedProfile: '', clientToken: '', authenticationDatabase: {}, launcherVersion: { name: '2.1.1', format: 21 } }, null, 2),
      'utf8',
    );
  }

  const cwd = opts.cwd ?? path.dirname(installerPath);
  const timeoutMs = Number(opts.timeoutMs ?? 900_000);

  // 注意：不能改成 execFile —— 沙箱不给管道（stdio:'pipe' 直接 EPERM），
  // 所以用 captureCommand 把 stdout/stderr 重定向到文件再读回来。
  const result = await captureCommand(javaPath, args, {
    cwd,
    timeoutMs,
    maxBytes: 32 * 1024 * 1024,
    logFile: `${installerPath}.out.log`,
  });

  const logFile = `${installerPath}.log`;
  const ok = result.ok && !result.timedOut;
  return {
    ok,
    code: result.code ?? 1,
    output: result.output,
    logFile: fs.existsSync(logFile) ? logFile : '',
    // 安装器失败时最后一两行往往就是原因，直接挑出来
    reason: ok
      ? ''
      : result.timedOut
        ? `安装器跑了 ${(timeoutMs / 1000).toFixed(0)} 秒还没结束，已经强杀`
        : pickInstallerReason(result.output, logFile),
  };
}

/** 从安装器的输出/日志里挑一句人话当失败原因。 */
function pickInstallerReason(output, logFile) {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bad = lines.filter((line) => /error|exception|failed|timed out|拒绝|失败/i.test(line));
  if (bad.length) return bad.slice(-3).join(' | ').slice(0, 400);
  if (logFile && fs.existsSync(logFile)) {
    const tail = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-5).join(' | ');
    if (tail) return tail.slice(0, 400);
  }
  return lines.slice(-3).join(' | ').slice(0, 400);
}

/**
 * 安装器跑完之后，确认它到底产出了什么。
 *
 * 命名坑：不同加载器/版本的目录名不一样 ——
 *   NeoForge 1.21.1  → `versions/neoforge-21.1.228`
 *   Forge 1.20.1     → `versions/1.20.1-forge-47.4.28`（带 mc 版本前缀！）
 * 所以不能凭猜，优先用安装器自己 `version.json` 里的 id（`preferredId`），
 * 拿不到再按几个候选名去磁盘上找，最后才退回猜的那个。
 *
 * @param {{mcRoot: string, loader: string, loaderVersion: string, mcVersion?: string, preferredId?: string}} opts
 * @returns {{versionDir: string, versionJson: string, versionJar: string, exists: boolean, jarExists: boolean, id: string}}
 */
export function locateLoaderVersion(opts) {
  const mcRoot = path.resolve(opts.mcRoot);
  const loader = String(opts.loader ?? 'neoforge').toLowerCase();
  const loaderVersion = String(opts.loaderVersion ?? '');
  const mcVersion = String(opts.mcVersion ?? '');

  const candidates = [];
  if (opts.preferredId) candidates.push(String(opts.preferredId));
  if (mcVersion) candidates.push(`${mcVersion}-${loader}-${loaderVersion}`);
  candidates.push(`${loader}-${loaderVersion}`);
  const unique = [...new Set(candidates.filter(Boolean))];

  const pick = (id) => {
    const versionDir = path.join(mcRoot, 'versions', id);
    const versionJson = path.join(versionDir, `${id}.json`);
    const versionJar = path.join(versionDir, `${id}.jar`);
    return {
      id,
      versionDir,
      versionJson,
      versionJar,
      exists: fs.existsSync(versionJson),
      jarExists: fs.existsSync(versionJar),
    };
  };

  for (const id of unique) {
    const info = pick(id);
    if (info.exists) return info;
  }
  return pick(unique[0]);
}

/**
 * 把原版客户端 jar 复制成实例自己的 jar。
 *
 * 为什么要复制：`launch.js` 和导出都按 `<实例目录>/<实例名>.jar` 找客户端 jar，
 * 而 `inheritsFrom` 的实例自己目录里没有。复制一份 26 MB 最省事，
 * 也跟 PCL 装出来的形状一致。
 *
 * @param {{from: string, to: string}} opts
 */
export async function copyClientJar(opts) {
  const from = path.resolve(opts.from);
  const to = path.resolve(opts.to);
  if (!fs.existsSync(from)) throw new McError(`原版客户端 jar 不在：${from}`, '原版那一步没下成功', 'ClientJarMissing');
  if (fs.existsSync(to)) return { copied: false, bytes: fs.statSync(to).size };
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
  return { copied: true, bytes: fs.statSync(to).size };
}

/**
 * 把原版版本 json 落到 `<mcRoot>/versions/<id>/<id>.json`。
 *
 * 为什么必须落：加载器版本 json 里有 `inheritsFrom: 1.21.1`，
 * `launch.js` 会顺着继承链一路找下去，找不到就报「找不到版本 json」。
 * PCL 装出来的目录里也有这个文件，形状一致。
 *
 * @param {{versionJsonRaw: any, mcRoot: string}} opts
 */
export async function writeGameVersionJson(opts) {
  const raw = opts.versionJsonRaw;
  const id = String(raw?.id ?? '');
  if (!id) throw new McError('版本 json 里没有 id', '版本清单里的 json 拿错了', 'VersionJsonNoId');
  const dir = path.join(path.resolve(opts.mcRoot), 'versions', id);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  await fsp.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return { file, id };
}

/**
 * 写实例的版本 json。
 *
 * 走 `inheritsFrom` 而不是把两个 json 合并 —— 合并要处理 libraries 去重、
 * 参数拼接，容易出错；`launch.js` 本来就支持继承链。
 *
 * @param {{instanceDir: string, name: string, inheritsFrom: string, extra?: object}} opts
 */
export async function writeInstanceVersionJson(opts) {
  const instanceDir = path.resolve(opts.instanceDir);
  const name = String(opts.name ?? '');
  if (!name) throw new McError('实例名是空的', '建包时要有名字', 'PackNoName');
  await fsp.mkdir(instanceDir, { recursive: true });
  const json = {
    id: name,
    inheritsFrom: String(opts.inheritsFrom),
    type: 'release',
    ...(opts.extra ?? {}),
  };
  const file = path.join(instanceDir, `${name}.json`);
  await fsp.writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  return { file, json };
}

/** 把字节数说成人话。 */
export function formatBytes(bytes) {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 整理成给人看的一段话（工具输出和面板都用它）。
 *
 * @param {any} plan
 */
export function describePlan(plan) {
  const lines = [];
  if (plan.target) {
    lines.push(`目标：${plan.target.id}（客户端 jar ${formatBytes(plan.target.clientJar?.size ?? 0)}）`);
  }
  if (plan.counts) {
    const parts = [];
    if (plan.counts.clientJar) parts.push('客户端 jar 1 个');
    if (plan.counts.libraries) parts.push(`libraries ${plan.counts.libraries} 个`);
    if (plan.counts.logging) parts.push('log4j 配置 1 个');
    if (plan.counts.assetIndex) parts.push('资源索引 1 个');
    if (plan.counts.profileLibraries) parts.push(`加载器依赖 ${plan.counts.profileLibraries} 条`);
    if (parts.length) lines.push(parts.join('、'));
  }
  if (plan.assetCount) {
    lines.push(`资源文件 ${plan.assetCount} 个，合计 ${formatBytes(plan.assetBytes)}（已经有的会跳过）`);
  }
  if (plan.totalBytes) lines.push(`原版部分合计 ${formatBytes(plan.totalBytes)}`);
  return lines;
}
