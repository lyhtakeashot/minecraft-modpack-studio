/**
 * 从零装一个能启动的底座：原版 + 加载器，全部从网上下。
 *
 * 分工（这是实测逼出来的结论，别改）：
 * - **下载归我们**：用 `downloader.js` 那套（分段并行 + 连接池）把原版和加载器
 *   依赖摆到位，Mojang 的地址走官方、`maven.neoforged.net` 走 BMCLAPI 镜像。
 * - **打补丁归安装器**：NeoForge 的 processor 是 Java 程序（installertools /
 *   AutoRenamingTool / binarypatcher / jarsplitter），纯 JS 复刻不现实。
 *   所以最后跑一次 `java -jar installer --installClient <dir> --offline`。
 *
 * 为什么不让安装器自己下：它的 `--mirror` 参数对库下载**不生效**，实测照样去连
 * `maven.neoforged.net` 然后全部超时。我们先把文件摆好，它就只跑 processor。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { McError } from './errors.js';
import { collectJavaCandidates, pickJava } from './java.js';
import {
  applyJavaRuntime,
  componentForMajor,
  describeJavaRuntime,
  loadJavaRuntimePlan,
} from './java-runtime.js';
import { PACK_DIRS, validatePackName } from './pack-create.js';
import {
  MIRROR_MANIFEST_URL,
  MOJANG_MANIFEST_URL,
  candidateUrlsFor,
  describeTarget,
  loaderInstaller,
  loaderListIsXml,
  loaderListUrl,
  normalizeGameVersion,
  normalizeLoader,
  parseLoaderVersions,
  parseManifest,
  pickVersion,
} from './version-manifest.js';
import {
  applyItems,
  buildLoaderPlan,
  buildVanillaPlan,
  copyClientJar,
  fetchJsonFrom,
  fetchTextFrom,
  formatBytes,
  locateLoaderVersion,
  planCore,
  readInstallerProfile,
  runInstaller,
  writeGameVersionJson,
  writeInstanceVersionJson,
} from './version-install.js';

/** 安装器临时放在这儿（相对 mcRoot），别塞进 versions/ 里污染实例列表。 */
const CACHE_DIR = '.dsh-installers';

/**
 * 算「从零装一个包」要做什么。不写盘（只有一次联网查清单）。
 *
 * @param {object} opts
 * @param {any} opts.http `createHttp()` 的返回值
 * @param {string} opts.mcRoot Minecraft 根目录（会和别人的 libraries/assets 共用）
 * @param {string} opts.name 新包的名字
 * @param {string} opts.mcVersion 游戏版本，如 1.21.1
 * @param {string} [opts.loader] neoforge / forge / vanilla
 * @param {string} [opts.loaderVersion] 加载器版本；不给就用最新的
 * @param {string} [opts.mirrorMode] auto / off / prefer / mirror
 * @param {object} [opts.env] 覆盖系统判断（测试用）
 * @param {string} [opts.javaPath] 显式指定 java
 */
export async function planScaffold(opts) {
  const mcRoot = path.resolve(String(opts.mcRoot ?? ''));
  if (!mcRoot) throw new McError('没给 Minecraft 根目录', '要一个已经有 libraries/ 的根目录，或者让软件从零建一个');
  const checked = validatePackName(opts.name);
  if (!checked.ok) throw new McError(checked.error, '换一个名字再试', 'PackBadName');
  const name = checked.name;
  const mcVersion = normalizeGameVersion(opts.mcVersion);
  const loader = normalizeLoader(opts.loader ?? 'neoforge');
  const mirrorMode = opts.mirrorMode ?? 'auto';
  const env = opts.env ?? {};
  const http = opts.http;

  const warnings = [];

  // 1) 版本清单
  const manifest = await fetchManifest(http);
  const entry = pickVersion(manifest, mcVersion);
  const versionJsonRaw = await fetchJsonFrom(http, candidateUrlsFor(entry.url, mirrorMode));
  const target = planCore({ versionJson: versionJsonRaw, mcRoot, mirrorMode, env });

  // 2) 原版（含资源，要拉资源索引）
  const vanilla = await buildVanillaPlan({ http, versionJson: versionJsonRaw, mcRoot, mirrorMode, env });

  // 3) 加载器
  let loaderPlan = null;
  let installerInfo = null;
  let installerPath = '';
  let resolvedLoaderVersion = '';

  if (loader !== 'vanilla') {
    const listUrl = loaderListUrl(loader, mcVersion);
    // Forge 的列表是 maven-metadata.xml（XML），得走文本那条路
    const listRaw = loaderListIsXml(loader)
      ? await fetchTextFrom(http, candidateUrlsFor(listUrl, 'auto'), { attempts: 5 })
      : await fetchJsonFrom(http, [listUrl], { attempts: 5 });
    const available = parseLoaderVersions(loader, mcVersion, listRaw);
    if (available.length === 0) {
      throw new McError(
        `镜像上没有 ${mcVersion} 能用的 ${loader} 版本`,
        '换一个游戏版本，或者先把加载器版本号确认一下',
        'LoaderNoVersion',
      );
    }
    resolvedLoaderVersion = String(opts.loaderVersion ?? '').trim() || available[0];
    if (!available.includes(resolvedLoaderVersion)) {
      throw new McError(
        `${loader} ${resolvedLoaderVersion} 对不上 ${mcVersion}`,
        `这个版本可用的有：${available.slice(0, 8).join('、')}`,
        'LoaderVersionMismatch',
      );
    }

    installerInfo = loaderInstaller(loader, mcVersion, resolvedLoaderVersion);
    installerPath = path.join(mcRoot, CACHE_DIR, installerInfo.fileName);

    // 安装器已经下过就能把依赖清单算准；没下过就先报个「等 apply 时再算」
    if (fs.existsSync(installerPath)) {
      const profile = readInstallerProfile(installerPath);
      loaderPlan = buildLoaderPlan({ profile, mcRoot, mirrorMode, env });
    } else {
      warnings.push('加载器依赖要等安装器下下来才算得准，apply 时会先下安装器再算');
    }
  } else {
    resolvedLoaderVersion = '';
  }

  // 4) 目标目录
  const instanceDir = path.join(mcRoot, 'versions', name);
  const versionDir = loader === 'vanilla' ? path.join(mcRoot, 'versions', mcVersion) : path.join(mcRoot, 'versions', loader === 'neoforge' ? `neoforge-${resolvedLoaderVersion}` : `forge-${resolvedLoaderVersion}`);

  const conflicts = [];
  if (fs.existsSync(instanceDir)) {
    const entries = fs.readdirSync(instanceDir);
    if (entries.length > 0) conflicts.push(`versions/${name} 已经有东西了`);
  }
  if (loader === 'vanilla' && fs.existsSync(path.join(mcRoot, 'versions', mcVersion))) {
    // 原版版本目录已存在说明底座装过了，不是错，只是要说明白
    warnings.push(`versions/${mcVersion} 已经有了，会沿用（已有的文件跳过）`);
  }

  // 5) Java（本机版本对不上就顺手装一个官方运行时；apply 时才真下）
  const requiredMajor = Number(versionJsonRaw?.javaVersion?.majorVersion ?? 0) || 0;
  const javaCandidates = collectJavaCandidates({ mcRoot, requiredMajor, extra: opts.javaPath ? [opts.javaPath] : [] });
  const java = pickJava(javaCandidates, requiredMajor);
  const javaMatches = Boolean(java && requiredMajor && java.major === requiredMajor);
  let javaRuntime = null;

  if (!javaMatches) {
    const component = String(versionJsonRaw?.javaVersion?.component ?? '').trim()
      || componentForMajor(requiredMajor);
    if (!component) {
      warnings.push(`版本 json 没说要用哪个 Java（主版本 ${requiredMajor || '未知'}），安装器那一步会失败，得先手动装一个`);
    } else {
      try {
        javaRuntime = await loadJavaRuntimePlan({ http, component, majorVersion: requiredMajor, mcRoot });
        if (java) {
          warnings.push(
            `本机只有 Java ${java.major}（${java.path}），这个版本要求 Java ${requiredMajor}，`
            + `apply 时会先装官方运行时 ${component} ${javaRuntime.version}`,
          );
        } else {
          warnings.push(`本机没找到 Java ${requiredMajor}，apply 时会先装官方运行时 ${component} ${javaRuntime.version}`);
        }
      } catch (error) {
        warnings.push(`查不到官方 Java 运行时（${error?.message ?? error}），安装器那一步会失败，得先手动装一个 Java ${requiredMajor}`);
        javaRuntime = null;
      }
    }
  }

  const vanillaFiles = vanilla.allItems.length;
  const loaderFiles = loaderPlan?.items.length ?? 0;
  const javaFiles = javaRuntime?.fileCount ?? 0;
  const vanillaBytes = vanilla.totalBytes + vanilla.assetBytes;
  const loaderBytes = loaderPlan?.totalBytes ?? 0;
  const javaBytes = javaRuntime?.downloadBytes ?? 0;

  return {
    kind: 'scaffold',
    name,
    mcRoot,
    mcVersion,
    loader,
    loaderVersion: resolvedLoaderVersion,
    targetText: describeTarget({ mcVersion, loader, loaderVersion: resolvedLoaderVersion }),
    instanceDir,
    versionDir,
    versionJsonUrl: entry.url,
    versionJsonSha1: entry.sha1 ?? '',
    installer: installerInfo
      ? { fileName: installerInfo.fileName, url: installerInfo.url, path: installerPath, size: installerInfo.size ?? 0 }
      : null,
    java: java ? { path: java.path, version: java.version, major: java.major, source: java.source } : null,
    javaRequiredMajor: requiredMajor,
    javaMatches,
    javaRuntime,
    javaCandidates: javaCandidates.map((c) => ({ path: c.path, version: c.version, major: c.major, source: c.source, matches: c.matches })),
    counts: {
      // vanillaFiles 是「原版那一批」的总数，里面已经含了资源对象文件；
      // coreFiles 把资源摘出来，界面上才能说清「本体几个、资源几个」，
      // 否则用户会以为资源被算了两遍。
      vanillaFiles,
      assetFiles: vanilla.assetCount,
      coreFiles: Math.max(0, vanillaFiles - vanilla.assetCount),
      loaderFiles,
      javaFiles,
      totalFiles: vanillaFiles + loaderFiles + javaFiles,
    },
    bytes: {
      vanilla: vanillaBytes,
      assets: vanilla.assetBytes,
      loader: loaderBytes,
      java: javaBytes,
      total: vanillaBytes + loaderBytes + javaBytes,
    },
    clientJar: { size: target.target.clientJar?.size ?? 0, path: target.target.clientJar?.path ?? '' },
    assetIndex: target.target.assetIndex ? { id: target.target.assetIndex.id, totalSize: target.target.assetIndex.totalSize } : null,
    steps: buildSteps({ loader, hasInstaller: Boolean(installerPath && fs.existsSync(installerPath)), needsJava: Boolean(javaRuntime) }),
    warnings,
    conflicts,
  };
}

/** 拉版本清单：先镜像后官方，每个地址给三次机会（BMCLAPI 偶尔 ECONNRESET，官方偶尔掐 TLS）。 */
async function fetchManifest(http) {
  const errors = [];
  for (const url of [MIRROR_MANIFEST_URL, MOJANG_MANIFEST_URL]) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return parseManifest(await http.json(url));
      } catch (error) {
        errors.push(`${url}: ${error?.message ?? error}`);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
  }
  throw new McError('版本清单一个地址都没拉到', errors.join(' | ').slice(0, 400), 'ManifestUnreachable');
}

function buildSteps({ loader, hasInstaller, needsJava = false }) {
  const steps = [
    { key: 'installer', title: loader === 'vanilla' ? '' : '下加载器安装器', done: hasInstaller },
    { key: 'gameJson', title: '记下原版版本信息', done: false },
    { key: 'vanilla', title: '下原版（库 + 客户端 + 资源）', done: false },
    { key: 'loader', title: loader === 'vanilla' ? '' : '下加载器依赖', done: false },
    { key: 'java', title: needsJava ? '装 Java 运行时' : '', done: false },
    { key: 'patch', title: loader === 'vanilla' ? '' : '打加载器补丁', done: false },
    { key: 'instance', title: '建实例目录', done: false },
  ];
  return steps.filter((step) => step.title);
}

/**
 * 真装。
 *
 * 会按顺序做：下安装器 → 记版本 json → 下原版 → 下加载器依赖 → 跑安装器打补丁 →
 * 建实例目录 + 复制客户端 jar。
 *
 * @param {object} opts
 * @param {any} opts.plan `planScaffold()` 的结果
 * @param {any} opts.http
 * @param {string} [opts.javaPath] 覆盖 plan 里挑出来的 java
 * @param {Function} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function applyScaffold(opts) {
  const plan = opts.plan;
  const http = opts.http;
  const onProgress = opts.onProgress ?? (() => {});
  const signal = opts.signal;
  const mcRoot = plan.mcRoot;
  const startedAt = Date.now();
  const stages = [];

  const step = (key, status, detail) => {
    const stage = { key, status, detail: detail ?? '', at: Date.now() - startedAt };
    stages.push(stage);
    onProgress({ stage: 'step', ...stage });
  };

  // 0) 目标目录能不能写
  if (plan.conflicts?.length) {
    throw new McError(`这个包已经存在了：${plan.conflicts.join('；')}`, '换个名字，或者先把旧的那个挪走', 'PackExists');
  }
  await fsp.mkdir(path.join(mcRoot, 'versions'), { recursive: true });

  // 1) 安装器
  let profile = null;
  if (plan.installer) {
    step('installer', 'running', '');
    if (!fs.existsSync(plan.installer.path)) {
      await fsp.mkdir(path.dirname(plan.installer.path), { recursive: true });
      await http.downloader.download(candidateUrlsFor(plan.installer.url, 'auto'), plan.installer.path, {});
    }
    profile = readInstallerProfile(plan.installer.path);
    step('installer', 'ok', formatBytes(fs.statSync(plan.installer.path).size));
  }

  // 2) 原版版本 json 落到 versions/<id>/
  step('gameJson', 'running', '');
  const versionJsonRaw = await fetchJsonFrom(http, candidateUrlsFor(plan.versionJsonUrl, 'auto'));
  const gameJson = await writeGameVersionJson({ versionJsonRaw, mcRoot });
  step('gameJson', 'ok', gameJson.id);

  // 3) 原版
  step('vanilla', 'running', '');
  const vanilla = await buildVanillaPlan({ http, versionJson: versionJsonRaw, mcRoot, mirrorMode: 'auto' });
  const vanillaResult = await applyItems({
    http,
    items: vanilla.allItems,
    signal,
    onProgress: (p) => onProgress({ stage: 'files', phase: 'vanilla', ...p }),
  });
  if (vanillaResult.failed.length) {
    const first = vanillaResult.failed.slice(0, 3).map((item) => `${item.relPath}（${item.error}）`).join('；');
    throw new McError(`原版有 ${vanillaResult.failed.length} 个文件没下下来`, `${first}`, 'VanillaIncomplete');
  }
  step('vanilla', 'ok', `新下 ${vanillaResult.downloaded.length}、跳过 ${vanillaResult.skipped.length}`);

  // 4) 加载器依赖
  let loaderResult = null;
  if (profile) {
    step('loader', 'running', '');
    const loaderPlan = buildLoaderPlan({ profile, mcRoot, mirrorMode: 'auto' });
    loaderResult = await applyItems({
      http,
      items: loaderPlan.items,
      signal,
      onProgress: (p) => onProgress({ stage: 'files', phase: 'loader', ...p }),
    });
    if (loaderResult.failed.length) {
      const first = loaderResult.failed.slice(0, 3).map((item) => `${item.relPath}（${item.error}）`).join('；');
      throw new McError(`加载器依赖有 ${loaderResult.failed.length} 个没下下来`, `${first}`, 'LoaderIncomplete');
    }
    step('loader', 'ok', `新下 ${loaderResult.downloaded.length}、跳过 ${loaderResult.skipped.length}`);
  }

  // 5) Java 运行时：本机主版本对不上就先把官方运行时装下来
  let javaRuntimeResult = null;
  let javaPath = opts.javaPath || plan.java?.path || '';
  if (!opts.javaPath && plan.javaRuntime) {
    step('java', 'running', plan.javaRuntime.version);
    javaRuntimeResult = await applyJavaRuntime({
      plan: plan.javaRuntime,
      http,
      signal,
      onProgress: (p) => onProgress({ stage: 'files', phase: 'java', ...p }),
    });
    if (!javaRuntimeResult.ok) {
      const first = javaRuntimeResult.failed.slice(0, 3).map((item) => `${item.relPath}（${item.error}）`).join('；');
      throw new McError(
        `Java 运行时没装成，${javaRuntimeResult.failed.length} 个文件没下下来`,
        `${first}；也可以手动装一个 Java ${plan.javaRequiredMajor}，再用 javaPath 指过去`,
        'JavaRuntimeIncomplete',
      );
    }
    javaPath = javaRuntimeResult.javaPath;
    step('java', 'ok', `Java ${javaRuntimeResult.version}`);
  }

  // 6) 打补丁
  let patchResult = null;
  if (profile) {
    step('patch', 'running', '');
    if (!javaPath) {
      throw new McError(
        `本机没有可用的 Java，打不了补丁`,
        `装一个 Java ${plan.javaRequiredMajor || ''}，或者把 javaPath 指过去`,
        'NoJava',
      );
    }
    patchResult = await runInstaller({
      javaPath,
      installerPath: plan.installer.path,
      mcRoot,
      offline: true,
      timeoutMs: 900_000,
    });
    if (!patchResult.ok) {
      throw new McError(`加载器安装器跑失败了`, patchResult.reason || '看安装器日志', 'InstallerFailed');
    }
    step('patch', 'ok', '补丁打好');
  }

  // 7) 建实例
  step('instance', 'running', '');
  const inheritsFrom = profile
    ? locateLoaderVersion({
      mcRoot,
      loader: plan.loader,
      loaderVersion: plan.loaderVersion,
      mcVersion: plan.mcVersion,
      // 安装器自己写进 versions/ 的那个 id 最可靠（Forge 1.20.1 是 1.20.1-forge-x.y.z）
      preferredId: profile.versionJson?.id,
    }).id
    : plan.mcVersion;
  await writeInstanceVersionJson({ instanceDir: plan.instanceDir, name: plan.name, inheritsFrom });
  const clientJar = await copyClientJar({
    from: path.join(mcRoot, 'versions', plan.mcVersion, `${plan.mcVersion}.jar`),
    to: path.join(plan.instanceDir, `${plan.name}.jar`),
  });
  for (const dir of PACK_DIRS) {
    await fsp.mkdir(path.join(plan.instanceDir, dir), { recursive: true });
  }
  step('instance', 'ok', `${clientJar.copied ? '复制了' : '沿用了'}客户端 jar`);

  return {
    ok: true,
    instanceDir: plan.instanceDir,
    name: plan.name,
    inheritsFrom,
    stages,
    files: {
      vanilla: vanillaResult.downloaded.length,
      vanillaSkipped: vanillaResult.skipped.length,
      loader: loaderResult?.downloaded.length ?? 0,
      loaderSkipped: loaderResult?.skipped.length ?? 0,
      java: javaRuntimeResult ? javaRuntimeResult.downloaded.length + javaRuntimeResult.copied.length : 0,
      javaSkipped: javaRuntimeResult?.skipped.length ?? 0,
    },
    java: javaPath ? { path: javaPath, version: javaRuntimeResult?.version ?? plan.java?.version ?? '' } : null,
    javaRuntime: javaRuntimeResult
      ? { component: plan.javaRuntime.component, version: javaRuntimeResult.version, javaPath: javaRuntimeResult.javaPath, bytes: javaRuntimeResult.bytes }
      : null,
    clientJar,
    patchOutput: patchResult?.output?.slice(-2000) ?? '',
    seconds: (Date.now() - startedAt) / 1000,
  };
}

/**
 * 整理成给人看的一段话。
 *
 * @param {any} plan
 * @returns {string[]}
 */
export function describeScaffold(plan) {
  const lines = [];
  lines.push(`目标：${plan.targetText}`);
  lines.push(`新包名：${plan.name}`);
  lines.push(`建在：${plan.instanceDir}`);
  lines.push(`共用底座：${plan.mcRoot}`);
  lines.push(
    `要下：本体 ${plan.counts.coreFiles ?? plan.counts.vanillaFiles} 个`
    + ` + 资源 ${plan.counts.assetFiles} 个`
    + ` + 加载器 ${plan.counts.loaderFiles} 个`
    + (plan.counts.javaFiles ? ` + Java ${plan.counts.javaFiles} 个` : '')
    + `，合计 ${formatBytes(plan.bytes.total)}`,
  );
  if (plan.assetIndex) {
    lines.push(`  资源索引 ${plan.assetIndex.id}，占 ${formatBytes(plan.bytes.assets)}`);
  }
  lines.push(`Java：${plan.java ? `${plan.java.path}（${plan.java.version}，来源 ${plan.java.source}）` : '本机没找到'}`);
  if (plan.javaRuntime) {
    for (const line of describeJavaRuntime(plan.javaRuntime)) lines.push(`  ${line.replace(/^Java：/, '')}`);
  } else if (plan.java && plan.javaRequiredMajor && plan.java.major !== plan.javaRequiredMajor) {
    lines.push(`  注意：这个版本要 Java ${plan.javaRequiredMajor}，本机是 ${plan.java.major}，安装器可能跑不起来`);
  }
  if (plan.installer) lines.push(`加载器安装器：${plan.installer.fileName}`);
  for (const warning of plan.warnings ?? []) lines.push(`注意：${warning}`);
  for (const conflict of plan.conflicts ?? []) lines.push(`冲突：${conflict}`);
  return lines;
}
