/**
 * 检查 mod 更新 / 升级整合包里的 mod。
 *
 * 思路（和 ModMenu 一样）：拿每个已装 jar 的 sha1 去问 Modrinth
 * 「这个文件现在最新是哪一版」。用哈希认 mod 比拿 modId 猜工程精确得多 ——
 * 不会把两个名字相近的 mod 认错，也不用猜「这个 mod 在 Modrinth 上叫什么」。
 *
 * 三步都遵守「先算不写、再真写」：
 *   1. checkModUpdates()  只读联网，算出「谁有更新」的表，不写盘。
 *   2. buildUpdatePlan()  只算清单（要下哪些文件、哪些旧 jar 会被停用），不联网不写盘。
 *   3. applyUpdatePlan()  真下载 + 停用旧 jar，只写盘（下载本身要联网）。
 *
 * 「停用」而不是「覆盖」：装新 mod 的 applyInstallPlan 遇到同名旧文件会拒绝覆盖，
 * 而这个软件的硬约束是不删用户文件。所以升级时把旧 jar 改名成 .jar.disabled
 * （mod 加载器不会读它，用户还留着原件），下载失败再把名字改回来。
 *
 * 2026-11-07 第二轮：加了「锁定名单」（某些 mod 不再提示更新，比如作者魔改过、
 * 或整合包作者故意锁死旧版）与「一键撤回」（把新 jar 停用、旧 jar 改回原名，
 * 全程仍然一个文件都不删）。两件事界面和 MCP 都走这里的同一批函数。
 */

import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { McError } from './errors.js';
import { readJarMetaFile } from './mod-compat.js';
import { fileSha1, indexModsFolder, resolveInside } from './mod-install.js';
import {
  allowedChannels,
  formatSize,
  mrUpdateUrl,
  normalizeLoader,
  sanitizeModFileName,
} from './mod-source.js';

/** 一次最多扫多少个 jar（和 mod-compat.js 的体检上限保持一致）。 */
export const MAX_SCAN_JARS = 600;

/** 一批最多发多少个哈希给 Modrinth，避免请求体太大。 */
export const HASH_BATCH = 100;

/** 同时算几个文件的 sha1。 */
const PARALLEL_HASH = 8;

/** 同时下载几个新 jar。 */
const PARALLEL_DOWNLOAD = 4;

// ————————————————————————— 扫本地 —————————————————————————

/**
 * 扫 mods 目录，给每个启用的 .jar 算出 sha1，顺手读出名字和当前版本号。
 * 只读文件、不联网、不写盘。停用的 .jar.disabled 不参与检查。
 *
 * @param {string} modsDir
 * @param {{ parallel?: number }} [options]
 * @returns {Promise<{modsDir: string, files: Array<object>, skipped: number, failed: number}>}
 */
export async function scanModsForUpdate(modsDir, options = {}) {
  const index = await indexModsFolder(modsDir);
  const jars = [...index.byName.values()].filter((entry) => entry.name.toLowerCase().endsWith('.jar'));
  const picked = jars.slice(0, MAX_SCAN_JARS);
  const parallel = Math.max(1, Math.min(Number(options.parallel ?? PARALLEL_HASH) || PARALLEL_HASH, 16));

  const results = new Array(picked.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(parallel, picked.length) }, async () => {
    while (cursor < picked.length) {
      const at = cursor;
      cursor += 1;
      results[at] = await readOneJar(picked[at]);
    }
  });
  await Promise.all(workers);

  const files = results.filter((entry) => entry && entry.sha1);
  return {
    modsDir,
    files,
    skipped: jars.length - picked.length,
    failed: results.length - files.length,
  };
}

/** 读一个 jar 的哈希与元数据；读不出元数据不算失败，查更新只认哈希。 */
async function readOneJar(entry) {
  try {
    const sha1 = await fileSha1(entry.path);
    let meta = { modIds: [] };
    try {
      meta = readJarMetaFile(entry.path) ?? { modIds: [] };
    } catch {
      // jar 里的声明读不了很常见（老 mod、手工打的包），不影响按哈希查更新。
    }
    const first = Array.isArray(meta.modIds) ? meta.modIds[0] : null;
    return {
      fileName: entry.name,
      path: entry.path,
      sha1,
      modId: String(first?.modId ?? ''),
      name: String(first?.name ?? '') || entry.name.replace(/\.jar$/i, ''),
      currentVersion: String(first?.version ?? ''),
    };
  } catch (error) {
    return { fileName: entry.name, path: entry.path, sha1: '', error: error?.message ?? String(error) };
  }
}

// ————————————————————————— 问 Modrinth —————————————————————————

/**
 * 把一个 Modrinth Version（可能来自 /version_files/update 的旧版字段结构）
 * 摊成我们内部用的形状。自己写兼容层比复用 parseMrVersions 稳：
 * 官方 v2 的这个接口返回的是 LegacyVersion，字段名和版本列表接口略有出入。
 */
function normalizeVersion(raw) {
  const version = raw && typeof raw === 'object' ? raw : {};
  const files = Array.isArray(version.files) ? version.files : [];
  const primary = files.find((file) => file?.primary) ?? files[0] ?? null;
  return {
    id: String(version.id ?? version.versionId ?? ''),
    projectId: String(version.project_id ?? version.projectId ?? ''),
    versionNumber: String(version.version_number ?? version.versionNumber ?? version.name ?? ''),
    versionType: String(version.version_type ?? version.versionType ?? ''),
    published: String(version.date_published ?? version.published ?? ''),
    fileName: String(primary?.filename ?? primary?.fileName ?? ''),
    fileUrl: String(primary?.url ?? primary?.fileUrl ?? ''),
    sha1: String(primary?.hashes?.sha1 ?? ''),
    size: Number(primary?.size ?? 0) || 0,
  };
}

/**
 * 分批问 Modrinth「这些哈希现在最新是哪一版」。
 * 全部查不到时官方会回 404 空 body，这里当「空表」处理，不当崩溃。
 */
async function fetchLatestByHash(http, hashes, { gameVersion, loader, channel }) {
  const versionTypes = allowedChannels(channel);
  const loaders = loader ? [loader] : [];
  const gameVersions = gameVersion ? [gameVersion] : [];
  const merged = {};
  for (let at = 0; at < hashes.length; at += HASH_BATCH) {
    const batch = hashes.slice(at, at + HASH_BATCH);
    let answer = {};
    try {
      answer = await http.json(mrUpdateUrl(), {
        method: 'POST',
        body: { hashes: batch, algorithm: 'sha1', loaders, game_versions: gameVersions, version_types: versionTypes },
      });
    } catch (error) {
      const notFound = error?.code === 'McHttpNotFound' || error?.status === 404;
      if (!notFound) throw error;
      answer = {};
    }
    if (answer && typeof answer === 'object') Object.assign(merged, answer);
  }
  return merged;
}

/** 响应 map 的 key 是旧文件哈希；大小写不敏感地找一遍，免得官方哪天改格式。 */
function findByHash(answer, sha1) {
  if (!answer || typeof answer !== 'object') return null;
  const target = String(sha1 ?? '').toLowerCase();
  for (const [key, value] of Object.entries(answer)) {
    if (String(key).toLowerCase() === target) return value;
  }
  return null;
}

// ————————————————————————— 第一步：检查 —————————————————————————

/**
 * 检查更新：只读联网，返回「谁能升、升到哪版」的表。不写盘。
 *
 * @param {object} options
 * @param {object} options.http        createHttp() 出来的联网对象（可注入替身）
 * @param {string} options.modsDir     mods 目录
 * @param {string} [options.gameVersion]
 * @param {string} [options.loader]
 * @param {string} [options.channel]   release / beta / alpha
 * @param {Array<object>|string} [options.locked]  锁定名单：命中的 mod 标 locked，不计入「能升」
 * @returns {Promise<object>} { modsDir, gameVersion, loader, channel, scanned, items, updates, latest, unknown, locked, lines }
 */
export async function checkModUpdates(options = {}) {
  const { http } = options;
  const modsDir = String(options.modsDir ?? '').trim();
  const gameVersion = String(options.gameVersion ?? '').trim();
  const loader = normalizeLoader(String(options.loader ?? '').trim());
  const channel = String(options.channel ?? 'release').trim() || 'release';
  const lockKeys = normalizeLocks(options.locked);
  if (!modsDir) throw new McError('没给 mods 目录', '先在界面顶部连一个整合包', 'McNoModsDir');
  if (!http || typeof http.json !== 'function') {
    throw new McError('没有可用的联网对象', '这是软件内部错误', 'McNoHttp');
  }

  const scan = await scanModsForUpdate(modsDir);
  const answer = scan.files.length
    ? await fetchLatestByHash(http, scan.files.map((file) => file.sha1), { gameVersion, loader, channel })
    : {};

  const items = [];
  const lines = [];
  let updates = 0;
  let latest = 0;
  let unknown = 0;
  let locked = 0;

  for (const file of scan.files) {
    const raw = findByHash(answer, file.sha1);
    const base = {
      key: file.sha1,
      fileName: file.fileName,
      name: file.name,
      modId: file.modId,
      currentVersion: file.currentVersion,
      projectId: '',
      latestVersion: '',
      versionType: '',
      file: null,
    };
    if (!raw) {
      base.status = 'unknown';
      items.push(base);
      unknown += 1;
      lines.push(`? ${base.name}：查不到（可能不是从 Modrinth 装的，或文件被改过）`);
      continue;
    }
    const version = normalizeVersion(raw);
    base.projectId = version.projectId;
    base.latestVersion = version.versionNumber;
    base.versionType = version.versionType;
    // 没有新文件哈希或没有下载地址时，宁可标「查不到」，也不要拿坏数据去下载。
    if (!version.fileUrl || !version.sha1 || !version.fileName) {
      base.status = 'unknown';
      items.push(base);
      unknown += 1;
      lines.push(`? ${base.name}：Modrinth 没给可用的下载地址`);
      continue;
    }
    if (version.sha1.toLowerCase() === file.sha1.toLowerCase()) {
      base.status = 'latest';
      items.push(base);
      latest += 1;
      lines.push(`✓ ${base.name} 已是最新${base.currentVersion ? ` ${base.currentVersion}` : ''}`);
      continue;
    }
    // 锁定名单优先：即使查到有新版，也不算「能升」，界面会显示「已锁定」。
    if (isLocked(base, lockKeys)) {
      base.status = 'locked';
      base.locked = true;
      items.push(base);
      locked += 1;
      lines.push(`🔒 ${base.name} 已锁定，不再提示更新${base.latestVersion ? `（其实有 ${base.latestVersion}）` : ''}`);
      continue;
    }
    base.status = 'update';
    base.file = {
      fileName: sanitizeModFileName(version.fileName),
      fileUrl: version.fileUrl,
      sha1: version.sha1,
      size: version.size,
      versionNumber: version.versionNumber,
      versionType: version.versionType,
      projectId: version.projectId,
      versionId: version.id,
    };
    items.push(base);
    updates += 1;
    const from = base.currentVersion ? ` ${base.currentVersion}` : '';
    const to = base.latestVersion ? ` → ${base.latestVersion}` : ' → 新版本';
    lines.push(`↑ ${base.name}${from}${to}（${base.file.fileName}，${formatSize(base.file.size)}）`);
  }

  if (scan.failed) lines.unshift(`⚠ 有 ${scan.failed} 个 jar 读不了，已跳过`);
  if (scan.skipped) lines.unshift(`⚠ mods 目录超过 ${MAX_SCAN_JARS} 个 jar，只检查了前 ${MAX_SCAN_JARS} 个`);
  if (!items.length) lines.unshift('mods 目录里没有启用的 .jar，没东西可查。');
  else lines.unshift(`扫到 ${items.length} 个 mod：${updates} 个能升、${latest} 个已最新、${unknown} 个查不到${locked ? `、${locked} 个已锁定` : ''}。`);

  return {
    modsDir,
    gameVersion,
    loader,
    channel,
    scanned: items.length,
    items,
    updates,
    latest,
    unknown,
    locked,
    lines,
  };
}

// ————————————————————————— 第二步：算清单 —————————————————————————

/** 把「勾选」参数摊成字符串数组；空 = 全部能升的。 */
function normalizeSelection(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.map((x) => String(x)).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean);
    } catch {
      // 不是 JSON 就当逗号分隔的普通串。
    }
    return value.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

/** 找一份不会被占用的「停用文件名」，绝不覆盖用户已有的文件。 */
function freeDisabledName(usedNames, oldName) {
  const base = `${oldName}.disabled`;
  if (!usedNames.has(base.toLowerCase())) {
    usedNames.add(base.toLowerCase());
    return base;
  }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${oldName}.disabled-${i}`;
    if (!usedNames.has(candidate.toLowerCase())) {
      usedNames.add(candidate.toLowerCase());
      return candidate;
    }
  }
  return `${oldName}.disabled-${Date.now()}`;
}

/**
 * 算升级清单：不联网、不写盘，只把「要下什么、哪些旧 jar 会被停用」列清楚。
 *
 * @param {object} options
 * @param {object} options.check     checkModUpdates() 的结果（原样传回即可）
 * @param {Array<string>|string} [options.selected] 勾选的 key（sha1）或旧文件名；空 = 全部能升的
 * @param {Array<object>|string} [options.locked]  锁定名单：命中的项不会进清单（双保险）
 * @returns {Promise<object>} { modsDir, items, totalBytes, skipped, lines }
 */
export async function buildUpdatePlan(options = {}) {
  const check = options.check;
  if (!check || !Array.isArray(check.items)) {
    throw new McError('没有检查结果', '先点「检查更新」再看要升哪些', 'McNoUpdateCheck');
  }
  const modsDir = String(options.modsDir || check.modsDir || '').trim();
  if (!modsDir) throw new McError('没给 mods 目录', '先在界面顶部连一个整合包', 'McNoModsDir');

  // 只读扫一次目录，用来避开「停用文件名」撞车和「新文件名」撞车。
  const index = await indexModsFolder(modsDir);
  const usedNames = new Set(index.byName.keys());
  const selected = normalizeSelection(options.selected);
  const wanted = new Set(selected);
  const lockKeys = normalizeLocks(options.locked);
  const items = [];
  const skipped = [];
  const lines = [];
  let totalBytes = 0;

  for (const item of check.items) {
    if (item.status !== 'update') continue;
    // 界面回传的检查表可能是锁定前算的，这里再挡一次，保证界面和 MCP 同一条底线。
    if (isLocked(item, lockKeys)) {
      skipped.push({ fileName: item.fileName, reason: 'locked', message: '这个 mod 已被锁定，不再升级' });
      continue;
    }
    const hit = wanted.size === 0 || wanted.has(String(item.key)) || wanted.has(String(item.fileName));
    if (!hit) continue;
    const newName = sanitizeModFileName(item.file?.fileName ?? '');
    const newPath = resolveInside(modsDir, newName);
    const oldPath = resolveInside(modsDir, item.fileName);
    if (!newPath || !oldPath) {
      skipped.push({ fileName: item.fileName, reason: 'unsafe-name', message: '文件名不合法，已跳过（防止写到 mods 目录外面）' });
      continue;
    }
    // 新文件名和旧文件名不同、而那个名字已经被别的 jar 占了 → 不覆盖，如实跳过。
    if (newName.toLowerCase() !== item.fileName.toLowerCase() && usedNames.has(newName.toLowerCase())) {
      skipped.push({ fileName: item.fileName, reason: 'target-exists', message: `目标文件 ${newName} 已存在，没有覆盖它` });
      continue;
    }
    const disabledName = freeDisabledName(usedNames, item.fileName);
    const size = Number(item.file?.size ?? 0) || 0;
    totalBytes += size;
    items.push({
      key: item.key,
      name: item.name,
      modId: item.modId,
      currentVersion: item.currentVersion,
      latestVersion: item.latestVersion,
      projectId: item.projectId,
      oldName: item.fileName,
      oldPath,
      disabledName,
      newName,
      newPath,
      fileName: newName,
      fileUrl: String(item.file?.fileUrl ?? ''),
      sha1: String(item.file?.sha1 ?? ''),
      size,
      versionId: String(item.file?.versionId ?? ''),
    });
    lines.push(`↑ ${item.name}${item.currentVersion ? ` ${item.currentVersion}` : ''} → ${item.latestVersion || '新版本'}（停用 ${item.fileName} → ${disabledName}）`);
  }

  for (const skip of skipped) lines.push(`⚠ ${skip.fileName}：${skip.message}`);
  lines.unshift(items.length
    ? `准备升级 ${items.length} 个 mod，预计下载 ${formatSize(totalBytes)}。旧 jar 会改名成 .jar.disabled 停用，不会删。`
    : '没有选中可以升级的 mod。');

  return {
    modsDir,
    channel: String(check.channel ?? 'release'),
    items,
    totalBytes,
    skipped,
    lines,
  };
}

// ————————————————————————— 第三步：真写盘 —————————————————————————

async function statSafe(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 找一份不会被占用的停用文件名（apply 时再核一次，plan 算完后目录可能变了）。 */
async function availableDisabledPath(modsDir, preferred) {
  let candidate = preferred;
  for (let i = 2; i < 1000; i += 1) {
    if (!(await statSafe(path.join(modsDir, candidate)))) return candidate;
    candidate = `${preferred}-${i}`;
  }
  return `${preferred}-${Date.now()}`;
}

/**
 * 真升级：先把旧 jar 改名停用，再下载新 jar；下载失败把旧 jar 名字改回来。
 * 全程不删除任何文件（包括下载失败的半成品，只改名留给用户看）。
 *
 * @param {object} options
 * @param {object} options.http   createHttp() 出来的联网对象
 * @param {object} options.plan   buildUpdatePlan() 的结果
 * @param {string} [options.modsDir]
 * @param {(event: object) => void} [options.onProgress]  与 modInstallReporter 兼容的事件
 * @param {number} [options.parallelFiles]
 * @returns {Promise<{modsDir: string, installed: Array<object>, skipped: Array<object>, failed: Array<object>}>}
 */
export async function applyUpdatePlan(options = {}) {
  const { http, plan, onProgress } = options;
  if (!plan || !Array.isArray(plan.items)) {
    throw new McError('没有升级计划', '先预览（plan）再升级', 'McNoPlan');
  }
  const modsDir = path.resolve(String(options.modsDir || plan.modsDir || '').trim());
  if (!String(options.modsDir || plan.modsDir || '').trim()) {
    throw new McError('没给 mods 目录', '先指定整合包', 'McNoModsDir');
  }
  if (!http || typeof http.downloadToFile !== 'function') {
    throw new McError('没有可用的下载对象', '这是软件内部错误', 'McNoHttp');
  }
  await fsp.mkdir(modsDir, { recursive: true });

  const items = plan.items;
  const parallelFiles = Math.max(1, Math.min(Number(options.parallelFiles ?? PARALLEL_DOWNLOAD) || PARALLEL_DOWNLOAD, 8));
  const outcomes = new Array(items.length).fill(null);
  let cursor = 0;
  const emit = (event) => {
    try { onProgress?.(event); } catch { /* 进度条坏了不该让升级失败 */ }
  };

  const runner = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      outcomes[index] = await upgradeOne(http, modsDir, items[index], {
        index,
        count: items.length,
        emit,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallelFiles, items.length) }, () => runner()));

  const installed = [];
  const skipped = [];
  const failed = [];
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (outcome.kind === 'installed') installed.push(outcome);
    else if (outcome.kind === 'skipped') skipped.push(outcome);
    else failed.push(outcome);
  }
  return { modsDir, installed, skipped, failed };
}

/** 升级单个 mod：停用旧 jar → 下载新 jar → 失败回滚。 */
async function upgradeOne(http, modsDir, item, { index, count, emit }) {
  const info = { index, count, title: item.name, fileName: item.fileName };
  const oldPath = resolveInside(modsDir, item.oldName);
  const newPath = resolveInside(modsDir, item.newName);
  if (!oldPath || !newPath) {
    emit({ stage: 'file-done', ...info, kind: 'failed', bytes: 0 });
    return { ...item, kind: 'failed', reason: 'unsafe-name', message: '文件名不合法，已放弃（防止写到 mods 目录外面）' };
  }

  const oldExists = await statSafe(oldPath);
  // 幂等：新文件已经在、而且内容就是目标版本，就不用再动旧文件了。
  const newExists = await statSafe(newPath);
  if (newExists && item.sha1 && newPath !== oldPath) {
    const existingSha1 = await fileSha1(newPath).catch(() => '');
    if (existingSha1 && existingSha1.toLowerCase() === item.sha1.toLowerCase()) {
      emit({ stage: 'file-done', ...info, kind: 'skipped', bytes: 0 });
      return { ...item, kind: 'skipped', reason: 'already-installed', message: '这个版本已经装好了' };
    }
  }
  if (!oldExists) {
    emit({ stage: 'file-done', ...info, kind: 'failed', bytes: 0 });
    return { ...item, kind: 'failed', reason: 'missing-old', message: '旧文件已经不在了，没有动它 —— 可以再检查一次更新' };
  }
  if (newExists && newPath !== oldPath) {
    emit({ stage: 'file-done', ...info, kind: 'failed', bytes: 0 });
    return { ...item, kind: 'failed', reason: 'target-exists', message: `目标文件 ${item.newName} 已存在，没有覆盖它` };
  }

  const disabledName = await availableDisabledPath(modsDir, item.disabledName);
  const disabledPath = path.join(modsDir, disabledName);
  emit({ stage: 'file-start', ...info, size: item.size });
  try {
    // 先停用旧 jar。改名不是删除，用户随时能把 .disabled 去掉换回旧版。
    await fsp.rename(oldPath, disabledPath);
  } catch (error) {
    emit({ stage: 'file-done', ...info, kind: 'failed', bytes: 0 });
    return { ...item, kind: 'failed', reason: 'disable-failed', message: `停用旧文件失败：${error?.message ?? error}` };
  }

  try {
    const result = await http.downloadToFile(item.fileUrl, newPath, {
      sha1: item.sha1,
      size: item.size,
      onProgress: (progress) => emit({ stage: 'progress', ...info, ...progress }),
    });
    const bytes = Number(result?.bytes ?? item.size ?? 0) || 0;
    emit({ stage: 'file-done', ...info, kind: 'installed', bytes });
    return { ...item, kind: 'installed', disabledName, bytes };
  } catch (error) {
    // 回滚：把旧 jar 改回原名；下载残留只改名留着，绝不删。
    await fsp.rename(disabledPath, oldPath).catch(() => {});
    const partial = await statSafe(newPath);
    if (partial) await fsp.rename(newPath, `${newPath}.failed`).catch(() => {});
    emit({ stage: 'file-done', ...info, kind: 'failed', bytes: 0 });
    return {
      ...item,
      kind: 'failed',
      reason: error?.code ?? 'download-failed',
      message: `下载失败，旧文件已经改回原名：${error?.message ?? error}`,
    };
  }
}

/** 把真写盘的结果拼成几行人话，接在计划后面一起显示。 */
export function describeUpdateResult(result) {
  const lines = [];
  const installed = result?.installed ?? [];
  const skipped = result?.skipped ?? [];
  const failed = result?.failed ?? [];
  if (installed.length) {
    lines.push(`升级完成 ${installed.length} 个：`);
    for (const item of installed) {
      lines.push(`  ✓ ${item.name} → ${item.latestVersion || '新版本'}（旧文件停用为 ${item.disabledName}，没有删除）`);
    }
  } else {
    lines.push('没有升级成功的文件。');
  }
  for (const item of skipped) lines.push(`  · ${item.name}：${item.message}`);
  for (const item of failed) lines.push(`  ✗ ${item.name}：${item.message}`);
  if (failed.length) lines.push('旧版都还在（没有被删掉），修好问题后可以再试一次。');
  return lines;
}

// ————————————————————————— 锁定名单（只算匹配，不写盘） —————————————————————————

/**
 * 把锁定名单摊成一堆小写字符串，用来做「任一字段命中」的匹配。
 * 名单项可以是 { modId, projectId, fileName, name } 对象、纯字符串，或 JSON 串。
 * 故意不存 sha1：升级后哈希就变了，靠 modId / projectId / 文件名才锁得住。
 */
function normalizeLocks(value) {
  let list = value;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list)) list = [];
  const keys = new Set();
  for (const entry of list) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      if (entry.trim()) keys.add(entry.trim().toLowerCase());
      continue;
    }
    for (const field of ['modId', 'projectId', 'fileName']) {
      const v = String(entry[field] ?? '').trim().toLowerCase();
      if (v) keys.add(v);
    }
  }
  return keys;
}

/** 这个 mod 在不在锁定名单里：modId / projectId / 旧文件名任一命中即算。 */
function isLocked(item, lockKeys) {
  if (!lockKeys || lockKeys.size === 0) return false;
  for (const field of ['modId', 'projectId', 'fileName']) {
    const v = String(item?.[field] ?? '').trim().toLowerCase();
    if (v && lockKeys.has(v)) return true;
  }
  return false;
}

// ————————————————————————— 一键撤回（也是 plan → apply 两态） —————————————————————————

/** 给「被撤回的新 jar」找一个不撞车的停用名，绝不覆盖用户已有文件。 */
async function freeRollbackName(modsDir, newName) {
  const base = `${newName}.rolled-back`;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (!(await statSafe(path.join(modsDir, candidate)))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 算撤回清单：只算不写。result 是升级结果（含 installed[]，每项带
 * oldName / disabledName / newName —— 用记录下来的实际停用名，不能硬拼
 * .jar.disabled，因为撞车时它可能是 .disabled-2 或带时间戳的后缀）。
 *
 * @param {object} options
 * @param {object} options.result   applyUpdatePlan / handleModUpdateApply 的返回体
 * @param {string} [options.modsDir]
 * @returns {Promise<object>} { modsDir, items, skipped, lines }
 */
export async function buildRollbackPlan(options = {}) {
  const result = options.result;
  if (!result || !Array.isArray(result.installed)) {
    throw new McError('没有升级结果', '先升级一次才能撤回', 'McNoRollbackResult');
  }
  const rawDir = String(options.modsDir || result.modsDir || '').trim();
  if (!rawDir) throw new McError('没给 mods 目录', '先指定整合包', 'McNoModsDir');
  const modsDir = path.resolve(rawDir);

  const index = await indexModsFolder(modsDir);
  const items = [];
  const skipped = [];
  const lines = [];

  for (const done of result.installed) {
    const disabledName = String(done.disabledName ?? '').trim();
    const oldName = String(done.oldName ?? '').trim();
    const newName = String(done.newName ?? done.fileName ?? '').trim();
    if (!disabledName || !oldName || !newName) {
      skipped.push({ fileName: newName || '(未知)', reason: 'missing-info', message: '升级记录里缺文件名，撤回不了这一项' });
      continue;
    }
    const disabledPath = resolveInside(modsDir, disabledName);
    const oldPath = resolveInside(modsDir, oldName);
    const newPath = resolveInside(modsDir, newName);
    if (!disabledPath || !oldPath || !newPath) {
      skipped.push({ fileName: newName, reason: 'unsafe-name', message: '文件名不合法，已跳过（防止动到 mods 目录外面）' });
      continue;
    }
    if (!(await statSafe(disabledPath))) {
      skipped.push({ fileName: newName, reason: 'old-missing', message: `停用的旧文件 ${disabledName} 已经不在了，撤回不了` });
      continue;
    }
    if (await statSafe(oldPath)) {
      skipped.push({ fileName: newName, reason: 'old-name-taken', message: `旧名 ${oldName} 已经被别的文件占了，没有覆盖它` });
      continue;
    }
    const rolledName = await freeRollbackName(modsDir, newName);
    items.push({
      name: String(done.name ?? newName),
      currentVersion: String(done.currentVersion ?? ''),
      latestVersion: String(done.latestVersion ?? ''),
      oldName, oldPath,
      disabledName, disabledPath,
      newName, newPath,
      rolledName,
    });
    lines.push(`↩ ${done.name ?? newName}：把 ${newName} 停用成 ${rolledName}，再把 ${disabledName} 改回 ${oldName}`);
  }

  for (const skip of skipped) lines.push(`⚠ ${skip.fileName}：${skip.message}`);
  lines.unshift(items.length
    ? `准备撤回 ${items.length} 个升级：旧 jar 改回原名，新 jar 改名停用留着，一个文件都不删。`
    : '没有可以撤回的升级。');

  return { modsDir, items, skipped, lines };
}

/**
 * 真撤回：先把新 jar 改名停用（不删），再把旧 .jar.disabled 改回 .jar。
 * 任何一步失败都把刚做的改名退回去，绝不留下「旧版不见了、新版也没了」的局面。
 *
 * @param {object} options
 * @param {object} options.plan   buildRollbackPlan() 的结果
 * @param {string} [options.modsDir]
 * @returns {Promise<{modsDir: string, restored: Array<object>, failed: Array<object>}>}
 */
export async function applyRollbackPlan(options = {}) {
  const plan = options.plan;
  if (!plan || !Array.isArray(plan.items)) {
    throw new McError('没有撤回计划', '先预览（plan）再撤回', 'McNoPlan');
  }
  const rawDir = String(options.modsDir || plan.modsDir || '').trim();
  if (!rawDir) throw new McError('没给 mods 目录', '先指定整合包', 'McNoModsDir');
  const modsDir = path.resolve(rawDir);

  const restored = [];
  const failed = [];
  for (const item of plan.items) {
    const oldPath = resolveInside(modsDir, item.oldName);
    const disabledPath = resolveInside(modsDir, item.disabledName);
    const newPath = resolveInside(modsDir, item.newName);
    const rolledPath = resolveInside(modsDir, item.rolledName);
    if (!oldPath || !disabledPath || !newPath || !rolledPath) {
      failed.push({ ...item, reason: 'unsafe-name', message: '文件名不合法，已放弃' });
      continue;
    }
    // 预览算完后目录可能变了，每个文件再核一次。
    if (!(await statSafe(disabledPath))) {
      failed.push({ ...item, reason: 'old-missing', message: `停用的旧文件 ${item.disabledName} 已经不在了` });
      continue;
    }
    if (await statSafe(oldPath)) {
      failed.push({ ...item, reason: 'old-name-taken', message: `旧名 ${item.oldName} 已经被别的文件占了，没有覆盖它` });
      continue;
    }
    let rolled = false;
    if (await statSafe(newPath)) {
      try {
        await fsp.rename(newPath, rolledPath);
        rolled = true;
      } catch (error) {
        failed.push({ ...item, reason: 'disable-new-failed', message: `停用新文件失败：${error?.message ?? error}` });
        continue;
      }
    }
    try {
      await fsp.rename(disabledPath, oldPath);
    } catch (error) {
      // 回滚：把刚停用的新 jar 改回来，旧 jar 保持停用状态。
      if (rolled) await fsp.rename(rolledPath, newPath).catch(() => {});
      failed.push({ ...item, reason: 'restore-failed', message: `恢复旧文件失败：${error?.message ?? error}` });
      continue;
    }
    restored.push({ ...item, rolled: rolled ? item.rolledName : '' });
  }
  return { modsDir, restored, failed };
}

/** 把撤回结果拼成几行人话。 */
export function describeRollbackResult(result) {
  const lines = [];
  const restored = result?.restored ?? [];
  const failed = result?.failed ?? [];
  if (restored.length) {
    lines.push(`撤回完成 ${restored.length} 个：`);
    for (const item of restored) {
      const what = item.rolled ? `${item.newName} 停用为 ${item.rolled}` : `${item.newName}（新文件已经不在）`;
      lines.push(`  ↩ ${item.name}：${what}；${item.disabledName} 改回 ${item.oldName}（没有删除任何文件）`);
    }
  } else {
    lines.push('没有撤回成功的文件。');
  }
  for (const item of failed) lines.push(`  ✗ ${item.name}：${item.message}`);
  if (failed.length) lines.push('没撤回的那些，新旧文件都还在，可以手动处理。');
  return lines;
}
