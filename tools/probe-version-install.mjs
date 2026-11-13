/**
 * 探针：从零装一个「原版 1.21.1 + NeoForge」的底座，然后用它建一个实例。
 *
 * 用法：
 *   node tools/probe-version-install.mjs          只算计划（不写盘、不联网下大文件）
 *   node tools/probe-version-install.mjs apply    真下载 + 真装
 *   node tools/probe-version-install.mjs launch   在上面基础上再真启动一次
 *
 * 只用来验证 `packages/core/version-manifest.js` + `packages/core/version-install.js` 这条链路，
 * 不写任何用户目录。产物落在 lab/_scaffold。
 */

import fs from 'node:fs';
import path from 'node:path';

import { createHttp, readNetOptionsFromEnv } from '../packages/core/mod-fetch.js';
import {
  MIRROR_MANIFEST_URL,
  MOJANG_MANIFEST_URL,
  candidateUrlsFor,
  parseManifest,
  pickVersion,
  loaderInstaller,
  loaderListUrl,
  parseLoaderVersions,
  describeTarget,
  toMirror,
} from '../packages/core/version-manifest.js';
import {
  applyItems,
  buildLoaderPlan,
  buildVanillaPlan,
  copyClientJar,
  describePlan,
  fetchJsonFrom,
  formatBytes,
  locateLoaderVersion,
  planCore,
  readInstallerProfile,
  runInstaller,
  writeGameVersionJson,
  writeInstanceVersionJson,
} from '../packages/core/version-install.js';

const MC_VERSION = '1.21.1';
const LOADER = 'neoforge';
const LOADER_VERSION = '21.1.228';
const PACK_NAME = '从零包';

const mode = process.argv[2] ?? 'plan';
const apply = mode === 'apply' || mode === 'launch';
const doLaunch = mode === 'launch';

const labRoot = path.resolve('lab/_scaffold');
const mcRoot = path.join(labRoot, 'mcroot');
const instanceDir = path.join(mcRoot, 'versions', PACK_NAME);

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

const netOptions = readNetOptionsFromEnv(process.env);
const http = createHttp({ ...netOptions, mirrorMode: 'auto' });

log('目标', describeTarget({ mcVersion: MC_VERSION, loader: LOADER, loaderVersion: LOADER_VERSION }));
log('工作目录', labRoot, apply ? '（会真写盘）' : '（只算计划）');

// ── 1. 版本清单 ──
log('拉版本清单…');
const manifestCandidates = [MIRROR_MANIFEST_URL, MOJANG_MANIFEST_URL];
let manifestRaw;
for (const url of manifestCandidates) {
  try {
    manifestRaw = await http.json(url);
    log('  清单来自', url);
    break;
  } catch (error) {
    log('  这个地址不行：', url, error.message);
  }
}
if (!manifestRaw) throw new Error('版本清单一个地址都没拉到');
const manifest = parseManifest(manifestRaw);
log(`  共 ${manifest.versions.length} 个版本，最新正式版 ${manifest.latest.release}`);

const entry = pickVersion(manifest, MC_VERSION);
log('  1.21.1 的 json:', entry.url);

// ── 2. 原版版本 json ──
const versionJsonRaw = await fetchJsonFrom(http, candidateUrlsFor(entry.url, 'auto'));
const vanilla = planCore({ versionJson: versionJsonRaw, mcRoot, mirrorMode: 'auto' });
log(`原版：libraries ${vanilla.counts.libraries} 个，客户端 jar ${formatBytes(vanilla.target.clientJar.size)}，资源索引 ${vanilla.target.assetIndex.id}`);

// ── 3. 加载器版本列表（确认 21.1.228 存在）──
log('查 NeoForge 版本列表…');
const listRaw = await fetchJsonFrom(http, [loaderListUrl(LOADER, MC_VERSION)], { attempts: 5 });
const loaderVersions = parseLoaderVersions(LOADER, MC_VERSION, listRaw);
log(`  对得上 ${MC_VERSION} 的有 ${loaderVersions.length} 个，最新 ${loaderVersions[0]}，我们要 ${LOADER_VERSION}`);
if (!loaderVersions.includes(LOADER_VERSION)) {
  throw new Error(`镜像上没有 NeoForge ${LOADER_VERSION}`);
}

const installerInfo = loaderInstaller(LOADER, MC_VERSION, LOADER_VERSION);
const installerPath = path.join(labRoot, installerInfo.fileName);
log('  安装器地址', toMirror(installerInfo.url));

// ── 4. 完整原版清单（含资源，要拉资源索引）──
log('算完整原版清单（含资源，这一步会拉资源索引）…');
const full = await buildVanillaPlan({ http, versionJson: versionJsonRaw, mcRoot, mirrorMode: 'auto' });
log('  ' + describePlan(full).join('\n  '));
log(`  合计 ${full.allItems.length} 个文件 / ${formatBytes(full.totalBytes + full.assetBytes)}`);

// ── 5. 加载器依赖清单 ──
let loaderPlan = null;
if (fs.existsSync(installerPath)) {
  const profile = readInstallerProfile(installerPath);
  loaderPlan = buildLoaderPlan({ profile, mcRoot, mirrorMode: 'auto' });
  log(`加载器依赖：${loaderPlan.items.length} 个文件 / ${formatBytes(loaderPlan.totalBytes)}（processor ${profile.processors.length} 个）`);
} else {
  log('安装器还没下载，跳过加载器依赖清单');
}

if (!apply) {
  log('');
  log('=== 只算计划，没写盘 ===');
  log('要真装就再跑：node tools/probe-version-install.mjs apply');
  process.exit(0);
}

// ── 6. 真下载 ──
fs.mkdirSync(labRoot, { recursive: true });

// 原版版本 json 要落到 versions/1.21.1/，否则继承链找不到
const gameJson = await writeGameVersionJson({ versionJsonRaw, mcRoot });
log('原版版本 json:', gameJson.file);

log('下载安装器…');
if (!fs.existsSync(installerPath)) {
  await http.downloader.download(candidateUrlsFor(installerInfo.url, 'auto'), installerPath, {});
}
log('  安装器', formatBytes(fs.statSync(installerPath).size));

log('下载原版文件…');
const startedAt = Date.now();
let lastReport = 0;
const vanillaResult = await applyItems({
  http,
  items: full.allItems,
  concurrency: 8,
  onProgress: (p) => {
    const now = Date.now();
    if (now - lastReport < 3000 && p.done !== p.total) return;
    lastReport = now;
    log(`  进度 ${p.done}/${p.total}，已下 ${formatBytes(p.bytes)}`);
  },
});
log(`原版下载完成：新下 ${vanillaResult.downloaded.length}、跳过 ${vanillaResult.skipped.length}、失败 ${vanillaResult.failed.length}，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
if (vanillaResult.failed.length) {
  for (const item of vanillaResult.failed.slice(0, 5)) log('  失败:', item.relPath, '|', item.error);
  throw new Error('原版有文件没下下来，后面不用继续了');
}

// ── 7. 加载器依赖 ──
const profile = readInstallerProfile(installerPath);
loaderPlan = buildLoaderPlan({ profile, mcRoot, mirrorMode: 'auto' });
log(`下载加载器依赖（${loaderPlan.items.length} 个）…`);
const loaderResult = await applyItems({ http, items: loaderPlan.items, concurrency: 8 });
log(`加载器依赖：新下 ${loaderResult.downloaded.length}、跳过 ${loaderResult.skipped.length}、失败 ${loaderResult.failed.length}`);
if (loaderResult.failed.length) {
  for (const item of loaderResult.failed.slice(0, 8)) log('  失败:', item.relPath, '|', item.error);
  throw new Error('加载器依赖有文件没下下来');
}

// ── 8. 跑安装器（离线，只打补丁）──
const javaPath = process.env.MCSTUDIO_JAVA || 'C:\\Users\\lyh\\AppData\\Roaming\\.minecraft\\runtime\\java-runtime-delta\\bin\\java.exe';
log('跑安装器（--offline，只打补丁）…', javaPath);
const installerRun = await runInstaller({ javaPath, installerPath, mcRoot, offline: true, timeoutMs: 900_000 });
log('  安装器结果：', installerRun.ok ? '成功' : '失败');
if (!installerRun.ok) {
  log('  原因：', installerRun.reason);
  log('  日志：', installerRun.logFile);
  process.exit(1);
}

// ── 9. 检查产物 ──
const located = locateLoaderVersion({ mcRoot, loader: LOADER, loaderVersion: LOADER_VERSION });
log('加载器版本目录：', located.versionDir);
log('  version json 存在？', located.exists, '| 自带 jar 存在？', located.jarExists);
if (!located.exists) throw new Error('安装器说成功，但没找到版本 json');

const patched = path.join(mcRoot, 'libraries', 'net/neoforged/neoforge', LOADER_VERSION, `neoforge-${LOADER_VERSION}-client.jar`);
log('  打补丁产物存在？', fs.existsSync(patched), fs.existsSync(patched) ? formatBytes(fs.statSync(patched).size) : '');

// ── 10. 建实例 ──
log('建实例…');
const written = await writeInstanceVersionJson({
  instanceDir,
  name: PACK_NAME,
  inheritsFrom: located.id,
});
log('  版本 json:', written.file);
const copied = await copyClientJar({
  from: path.join(mcRoot, 'versions', MC_VERSION, `${MC_VERSION}.jar`),
  to: path.join(instanceDir, `${PACK_NAME}.jar`),
});
log('  客户端 jar:', copied.copied ? '复制了' : '已经有了', formatBytes(copied.bytes));

for (const dir of ['mods', 'config', 'logs', 'saves', 'resourcepacks', 'shaderpacks']) {
  fs.mkdirSync(path.join(instanceDir, dir), { recursive: true });
}

log('');
log('=== 装完了 ===');
log('实例目录', instanceDir);
if (doLaunch) {
  const { plan: planLaunch } = await import('../packages/core/launch.js');
  const launchPlan = planLaunch({ instanceDir, mcRoot });
  log('启动计划：主类', launchPlan.mainClass, '| classpath', launchPlan.classpath.length, '项 | 缺库', launchPlan.stats.missing.length);
  if (launchPlan.stats.missing.length) {
    log('  缺的库：', launchPlan.stats.missing.slice(0, 10));
  }
} else {
  log('要真启动就再跑：node tools/probe-version-install.mjs launch');
}
