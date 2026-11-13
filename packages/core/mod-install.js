/**
 * 装 mod 的「算」和「写」：先算出要下哪几个文件（含必装前置），再真的下进 mods 目录。
 *
 * 为什么拆成 plan / apply 两步：这是整个软件里唯一会改用户整合包的地方。
 * 用户（或者模型）必须先看到「准备下这 3 个文件、共 42 MB、来自 Modrinth」，
 * 点了头才允许落盘。和别的功能（改配方、改任务书）保持同一个节奏。
 *
 * 依赖闭包照 PCL 的做法（`ref/pcl-ce/ModCompDependency.cs`）：
 * 只要 dependency_type = required 的前置，一层层往下找；optional / incompatible /
 * embedded 一律不装（embedded 是已经打进 jar 里的，装了会冲突）。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { McError } from './errors.js';
import { compatReportAsync } from './mod-compat.js';
import {
  formatSize,
  mrProjectUrl,
  mrSearchUrl,
  mrVersionsUrl,
  normalizeLoader,
  parseMrProject,
  parseMrSearch,
  parseMrVersions,
  pickMrVersion,
  sanitizeModFileName,
} from './mod-source.js';

/** 一次最多牵连多少个工程（含前置），防止某个 mod 把整棵树拖进来。 */
export const MAX_PROJECTS = 40;

/** 顺着前置往下找几层。实测 3 层足够覆盖绝大多数 mod。 */
export const MAX_DEPTH = 3;

/**
 * 扫一遍 mods 目录，建「文件名 → 文件信息」索引。
 *
 * 只读文件名和大小，不算 sha1 —— 几百个 mod 全量哈希会把首次调用拖到十几秒，
 * 而绝大多数判断（这个文件是不是已经装过）只看名字就够；真要比内容时再对单个文件算。
 */
export async function indexModsFolder(modsDir) {
  const byName = new Map();
  let entries = [];
  try {
    entries = await fsp.readdir(modsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { modsDir, byName, count: 0 };
    throw new McError(`读不了 mods 目录：${error?.message ?? error}`, '确认整合包路径写对了', 'McModsUnreadable');
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const lower = name.toLowerCase();
    if (!lower.endsWith('.jar') && !lower.endsWith('.jar.disabled')) continue;
    count += 1;
    byName.set(lower, { name, path: path.join(modsDir, name) });
  }
  return { modsDir, byName, count };
}

/** 算单个文件的 sha1（只在需要比对内容时调用）。 */
export async function fileSha1(filePath) {
  const hash = createHash('sha1');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * 算出「要装什么」。不写盘、不下载，只发查询请求。
 *
 * @param {object} options
 * @param {ReturnType<import('./mod-fetch.js').createHttp>} options.http
 * @param {string} options.modsDir 目标 mods 目录
 * @param {Array<string|{projectId?: string, slug?: string, title?: string}>} options.requests
 *        用户点名的 mod，可以给工程 ID、slug 或标题（标题只在搜索过之后才有用）
 * @param {string} [options.gameVersion] 例如 1.21.1；空 = 不按版本过滤（不推荐）
 * @param {string} [options.loader] neoforge / forge / fabric / quilt
 * @param {string} [options.channel] release(默认) / beta / alpha
 * @param {boolean} [options.withDeps] 是否带必装前置，默认 true
 * @param {Object<string,string>} [options.pinned] 界面点名要装的版本：工程 key → versionId。
 *        只作用于用户点名的那一层（depth 0），依赖仍按渠道自动挑，免得把前置也锁死。
 * @param {number} [options.maxDepth]
 * @param {AbortSignal} [options.signal]
 */
export async function buildInstallPlan(options = {}) {
  const {
    http,
    modsDir,
    targetDir = '',
    requests = [],
    gameVersion = '',
    loader = '',
    channel = 'release',
    withDeps = true,
    pinned = {},
    maxDepth = MAX_DEPTH,
    signal,
  } = options;

  if (!http || typeof http.json !== 'function') {
    throw new McError('没有可用的联网对象', '这是软件内部错误', 'McNoHttp');
  }
  if (!modsDir) throw new McError('没给 mods 目录', '先指定整合包（面板第一步「连接整合包」）', 'McNoModsDir');
  const wanted = normalizeList(requests);
  if (wanted.length === 0) {
    throw new McError('没说要装什么', '先搜一下（mc_mod_search），把想要的那个工程 ID 或 slug 填进来', 'McNoRequests');
  }
  // 版本锁定表可能从 JSON 串解出来，容错成普通对象。
  const pins = pinned && typeof pinned === 'object' && !Array.isArray(pinned) ? pinned : {};
  // 下载目录：用户可以指定装到别的地方（PCL 也有这个功能），不填就装进实例的 mods 目录。
  const downloadDir = path.resolve(String(targetDir || modsDir));

  const installed = await indexModsFolder(modsDir);
  const projectCache = new Map();
  const versionCache = new Map();
  const items = [];
  const conflicts = [];
  const unresolved = [];
  const skippedExisting = [];
  const picked = new Map(); // projectId → item，防同一工程装两遍

  /** 拿工程详情（带缓存），失败返回 null。 */
  async function loadProject(projectIdOrSlug) {
    const key = String(projectIdOrSlug ?? '').trim();
    if (!key) return null;
    if (projectCache.has(key)) return projectCache.get(key);
    let project = null;
    try {
      const json = await http.json(mrProjectUrl(key), { signal });
      project = parseMrProject(json);
    } catch (error) {
      // 用户常按「我记得叫 ftb quests」这种写法给名字，直接当 slug 查会 404。
      // 这里退回搜一次：只认 slug 或标题**完全对上**的那条，避免装错东西。
      if (isNotFound(error)) project = await lookupBySearch(key);
      if (!project) {
        unresolved.push({
          projectId: key,
          title: key,
          reason: isNotFound(error) ? 'not-found' : 'network',
          message: isNotFound(error) ? `${key} 在 Modrinth 上没有，也没有名字刚好对上的结果` : (error?.message ?? String(error)),
        });
      }
    }
    projectCache.set(key, project);
    return project;
  }

  /** 用一段词去搜，只返回 slug / 标题完全吻合的工程（拿不准就返回 null）。 */
  async function lookupBySearch(key) {
    const words = key.replace(/[-_]+/g, ' ').trim();
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    try {
      const json = await http.json(mrSearchUrl({ query: words, gameVersion, loader, limit: 5 }), { signal });
      const hit = parseMrSearch(json).results.find((h) => norm(h.slug) === norm(key) || norm(h.title) === norm(key));
      return hit ?? null;
    } catch {
      return null;
    }
  }

  /** 拿版本列表（带缓存）。 */
  async function loadVersions(projectIdOrSlug) {
    const key = String(projectIdOrSlug ?? '').trim();
    if (versionCache.has(key)) return versionCache.get(key);
    let versions = [];
    try {
      const json = await http.json(mrVersionsUrl(key), { signal });
      versions = parseMrVersions(json);
    } catch (error) {
      unresolved.push({
        projectId: key,
        title: key,
        reason: 'versions',
        message: error?.message ?? String(error),
      });
    }
    versionCache.set(key, versions);
    return versions;
  }

  /** 处理一个工程：挑版本 → 记录条目 → 把必装前置排进队列。 */
  async function handleProject(projectIdOrSlug, meta = {}) {
    const project = await loadProject(projectIdOrSlug);
    if (!project) return null;
    if (picked.has(project.projectId)) return picked.get(project.projectId);

    const versions = await loadVersions(projectIdOrSlug);
    // 界面点名了具体版本：只认那一条，找不到就明确报错，**不**悄悄退回自动挑最新。
    // 这是「装 mod 选版本」的关键 —— 静默回退会让用户以为选中的版本装上了，其实没有。
    const pinnedId = String(meta.pinnedVersionId ?? '').trim();
    const version = pinnedId
      ? versions.find((v) => String(v?.id ?? '') === pinnedId)
      : pickMrVersion(versions, { gameVersion, loader, channel });
    if (!version) {
      unresolved.push({
        projectId: project.projectId,
        slug: project.slug,
        title: project.title || meta.title || projectIdOrSlug,
        reason: pinnedId ? 'pinned-version-not-found' : 'no-compatible-version',
        message: pinnedId
          ? `你选的版本 ${pinnedId} 在 ${project.title || projectIdOrSlug} 的版本列表里已经找不到了（可能被删或改了 ID），请重新选一个版本`
          : describeNoVersion(project, { gameVersion, loader, channel, count: versions.length }),
      });
      return null;
    }

    const fileName = sanitizeModFileName(version.fileName, `${project.slug || project.projectId}.jar`);
    const existing = installed.byName.get(fileName.toLowerCase());
    let existsSha1 = '';
    if (existing) existsSha1 = await fileSha1(existing.path).catch(() => '');

    const item = {
      source: 'modrinth',
      projectId: project.projectId,
      slug: project.slug,
      title: project.title || meta.title || project.slug,
      pageUrl: project.pageUrl,
      versionId: version.id,
      versionNumber: version.versionNumber,
      versionType: version.versionType,
      fileName,
      fileUrl: version.fileUrl,
      sha1: version.sha1,
      size: version.size,
      reason: meta.reason ?? 'requested',
      depth: Number(meta.depth ?? 0),
      dependencyOf: meta.dependencyOf ?? '',
      dependencies: version.dependencies,
      existingName: existing?.name ?? '',
      // 同名不同内容 = 版本冲突，不自动覆盖，留给用户决定。
      conflict: Boolean(existing) && Boolean(version.sha1) && Boolean(existsSha1) && existsSha1 !== version.sha1,
    };
    picked.set(project.projectId, item);

    if (item.conflict) {
      // 冲突的不进安装清单，只报给用户。
      conflicts.push(item);
      return item;
    }
    if (existing && (!version.sha1 || !existsSha1 || existsSha1 === version.sha1)) {
      skippedExisting.push({
        projectId: project.projectId,
        title: item.title,
        fileName: existing.name,
        reason: 'already-installed',
      });
      return item;
    }

    items.push(item);
    return item;
  }

  // 广度优先：先用户点名的，再一层层展开前置。
  const queue = wanted.map((request) => ({ request, depth: 0, from: '' }));
  const seenRequest = new Set();
  let steps = 0;
  while (queue.length > 0) {
    if (steps >= MAX_PROJECTS * 2) break;
    steps += 1;
    const { request, depth, from } = queue.shift();
    const key = String(request.projectId || request.slug || request.title || '').trim();
    if (!key) continue;
    let dedupe = key.toLowerCase();
    if (seenRequest.has(dedupe)) continue;
    seenRequest.add(dedupe);

    // 只有用户亲手点名的那一层（depth 0）才吃版本锁定；前置依赖照旧自动挑。
    // key 可能是 projectId 也可能是 slug，两个都查一遍，界面按哪种勾的都能对上。
    const pinnedVersionId = depth === 0
      ? String(pins[key] ?? pins[request.projectId] ?? pins[request.slug] ?? '').trim()
      : '';
    const item = await handleProject(key, { depth, reason: depth === 0 ? 'requested' : 'dependency', dependencyOf: from, pinnedVersionId });
    if (!item) continue;

    if (!withDeps || depth >= maxDepth) continue;
    for (const dep of item.dependencies ?? []) {
      if (dep.type !== 'required' || !dep.projectId) continue;
      if (dep.projectId === item.projectId) continue;
      queue.push({ request: { projectId: dep.projectId }, depth: depth + 1, from: item.title });
    }
    // 顺带把「同一个前置被多个 mod 依赖」的情况去重：picked 里已有就不再加。
  }

  // 装之前先给整包做一次体检：已有的互斥、缺前置、装了多份，用户先看着再决定要不要装。
  // 体检看的是实例的 mods 目录（游戏真正会加载的那一摞），不是下载目录。
  // 扫不出来也不该拦住下载，所以这里吞掉错误，只把体检结果带上。
  let compat = null;
  try {
    compat = await compatReportAsync(modsDir);
  } catch {
    compat = null;
  }

  return {
    modsDir: path.resolve(modsDir),
    targetDir: downloadDir,
    gameVersion,
    loader: normalizeLoader(loader),
    channel,
    withDeps,
    pinned: pins,
    requested: wanted.length,
    items,
    skippedExisting,
    unresolved,
    conflicts,
    compat,
    totalBytes: items.reduce((sum, item) => sum + Number(item.size || 0), 0),
    installedCount: installed.count,
  };
}

/** 把计划写成给用户看的几行字。 */
export function describePlan(plan) {
  const lines = [];
  const items = plan?.items ?? [];
  const skipped = plan?.skippedExisting ?? [];
  const unresolved = plan?.unresolved ?? [];
  const conflicts = plan?.conflicts ?? [];

  if (items.length === 0) {
    lines.push('没有要新装的文件。');
  } else {
    lines.push(`准备安装 ${items.length} 个文件，共 ${formatSize(plan.totalBytes)}：`);
    for (const item of items) {
      const tag = item.reason === 'dependency' ? `（${item.dependencyOf} 的前置）` : '';
      lines.push(`- ${item.title} ${item.versionNumber}${tag} → ${item.fileName} ${formatSize(item.size)}`);
    }
  }
  if (skipped.length > 0) {
    lines.push(`已装过、跳过 ${skipped.length} 个：${skipped.map((s) => s.title).join('、')}`);
  }
  if (conflicts.length > 0) {
    lines.push(`⚠ 同名但内容不同，没有自动覆盖：${conflicts.map((c) => `${c.title}（${c.fileName}）`).join('、')}`);
    lines.push('要先删掉旧文件，或者换成别的版本，再装一次。');
  }
  if (unresolved.length > 0) {
    lines.push(`有 ${unresolved.length} 个没能装：`);
    for (const item of unresolved) {
      lines.push(`- ${item.title}：${item.message}`);
    }
  }
  // 下载目录：告诉用户文件到底会下到哪儿，免得装完不知道去哪找。
  const target = String(plan?.targetDir ?? '').trim();
  if (target && path.resolve(target) !== path.resolve(String(plan?.modsDir ?? ''))) {
    lines.push(`文件会下到：${target}`);
  }
  // 装之前的体检结果：有互斥/缺前置就摆出来，让人自己决定要不要继续装。
  const compat = plan?.compat;
  if (compat && Array.isArray(compat.lines) && compat.lines.length > 0) {
    lines.push('');
    lines.push('装之前给整包做了一次兼容性体检：');
    for (const line of compat.lines) lines.push(`  ${line}`);
  }
  return lines;
}

/**
 * 真的把计划落盘。
 *
 * 每一条都必须过三关才落地：文件名消毒后仍在目标目录内、sha1 对得上、
 * 临时文件改名前不覆盖任何已有文件。
 *
 * @param {{http: any, plan: object, modsDir?: string, targetDir?: string, onProgress?: Function}} options
 */
export async function applyInstallPlan(options = {}) {
  const { http, plan, onProgress } = options;
  // 下到哪儿：优先用调用方给的 targetDir，其次计划里的 targetDir，最后才是实例的 mods 目录。
  // 老计划对象里没有 targetDir 字段，这里必须容错。
  const targetDir = String(options.targetDir || plan?.targetDir || '').trim();
  const modsDir = path.resolve(targetDir || options.modsDir || plan?.modsDir || '');
  if (!plan) throw new McError('没有安装计划', '先算计划（plan）再装', 'McNoPlan');
  if (!modsDir) throw new McError('没给 mods 目录', '先指定整合包', 'McNoModsDir');
  if (!http || typeof http.downloadToFile !== 'function') {
    throw new McError('没有可用的下载对象', '这是软件内部错误', 'McNoHttp');
  }

  await fsp.mkdir(modsDir, { recursive: true });

  const items = plan.items ?? [];
  // 多个文件并行下（PCL 也是这么干的）：每个文件内部还有分段并行，
  // 总连接数由全局连接池兜住，所以这里只需要限制「同时开几个文件」。
  const parallelFiles = Math.max(1, Math.min(Number(options.parallelFiles ?? 4) || 4, 8));
  const outcomes = new Array(items.length).fill(null);

  let cursor = 0;
  async function runner() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      outcomes[index] = await installOne(items[index], index);
    }
  }

  /**
   * 装一个文件，返回 {kind, record}；不抛错（错误也变成 failed 记录）。
   *
   * 进度事件分三种，界面靠 index/count 数「第几个、共几个」：
   *   file-start → 开始弄这个文件；file-progress → 这个文件下了多少；
   *   file-done → 这个文件结束了（装好 / 跳过 / 失败都算，bytes 记它的大小）。
   * 跳过和失败也报「已处理这么多字节」，否则总进度条永远到不了 100%。
   */
  async function installOne(item, index) {
    const info = { index, count: items.length, title: item.title, fileName: item.fileName };
    const target = resolveInside(modsDir, item.fileName);
    if (!target) {
      onProgress?.({ stage: 'file-done', ...info, bytes: 0, kind: 'failed' });
      return {
        kind: 'failed',
        record: { title: item.title, fileName: item.fileName, reason: 'unsafe-name', message: '文件名不合法，已放弃（防止写到 mods 目录外面）' },
      };
    }
    try {
      const exists = await statSafe(target);
      if (exists) {
        const sameSha1 = item.sha1 ? (await fileSha1(target).catch(() => '')) === item.sha1 : true;
        if (sameSha1) {
          onProgress?.({ stage: 'file-done', ...info, bytes: Number(item.size) || 0, kind: 'skipped' });
          return { kind: 'skipped', record: { title: item.title, fileName: path.basename(target), reason: 'already-installed' } };
        }
        onProgress?.({ stage: 'file-done', ...info, bytes: Number(item.size) || 0, kind: 'failed' });
        return {
          kind: 'failed',
          record: {
            title: item.title,
            fileName: path.basename(target),
            reason: 'exists-different',
            message: '同名文件已存在但内容不同。没有覆盖它 —— 先删掉旧文件再装。',
          },
        };
      }

      onProgress?.({ stage: 'download', title: item.title, fileName: item.fileName });
      onProgress?.({ stage: 'file-start', ...info, size: Number(item.size) || 0 });
      const result = await http.downloadToFile(item.fileUrl, target, {
        sha1: item.sha1,
        size: item.size,
        onProgress: (p) => onProgress?.({ stage: 'progress', title: item.title, index, count: items.length, ...p }),
      });
      onProgress?.({ stage: 'file-done', ...info, bytes: result.bytes, kind: 'installed' });
      return {
        kind: 'installed',
        record: {
          title: item.title,
          fileName: path.basename(target),
          bytes: result.bytes,
          sha1: result.sha1,
          versionNumber: item.versionNumber,
          mode: result.mode,
        },
      };
    } catch (error) {
      onProgress?.({ stage: 'file-done', ...info, bytes: Number(item.size) || 0, kind: 'failed' });
      return {
        kind: 'failed',
        record: {
          title: item.title,
          fileName: item.fileName,
          reason: error?.code ?? 'download-failed',
          message: error?.message ?? String(error),
        },
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(parallelFiles, items.length) }, () => runner()));

  // 按计划里的原始顺序归类，这样用户看到的清单顺序和计划一致（不受谁先下完影响）。
  const installed = [];
  const skipped = [];
  const failed = [];
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (outcome.kind === 'installed') installed.push(outcome.record);
    else if (outcome.kind === 'skipped') skipped.push(outcome.record);
    else failed.push(outcome.record);
  }

  return { modsDir, installed, skipped, failed };
}

/** 把计划落成一段给用户看的总结。 */
export function describeResult(result) {
  const lines = [];
  const installed = result?.installed ?? [];
  const skipped = result?.skipped ?? [];
  const failed = result?.failed ?? [];
  if (installed.length > 0) {
    lines.push(`装好了 ${installed.length} 个：`);
    for (const item of installed) {
      lines.push(`- ${item.title} ${item.versionNumber} → ${item.fileName}（${formatSize(item.bytes)}）`);
    }
  } else {
    lines.push('这次没有新装任何文件。');
  }
  if (skipped.length > 0) lines.push(`跳过 ${skipped.length} 个（已经装过）。`);
  if (failed.length > 0) {
    lines.push(`失败 ${failed.length} 个：`);
    for (const item of failed) lines.push(`- ${item.title}：${item.message}`);
  }
  return lines;
}

function normalizeList(requests) {
  const list = Array.isArray(requests) ? requests : [requests];
  return list
    .map((item) => {
      if (typeof item === 'string') return { projectId: item.trim() };
      if (item && typeof item === 'object') {
        return {
          projectId: String(item.projectId ?? item.id ?? '').trim(),
          slug: String(item.slug ?? '').trim(),
          title: String(item.title ?? '').trim(),
        };
      }
      return { projectId: '' };
    })
    .filter((item) => item.projectId || item.slug || item.title);
}

function isNotFound(error) {
  return error?.code === 'McHttpNotFound' || error?.status === 404;
}

function describeNoVersion(project, { gameVersion, loader, channel, count }) {
  const bits = [];
  if (gameVersion) bits.push(`游戏版本 ${gameVersion}`);
  if (normalizeLoader(loader)) bits.push(`加载器 ${normalizeLoader(loader)}`);
  if (channel !== 'alpha') bits.push(`只接受 ${channel === 'beta' ? '正式版/测试版' : '正式版'}`);
  const who = project.title || project.slug || project.projectId;
  if (count === 0) return `${who} 一个版本都没拿到（可能网络没通，或者工程 ID 不对）`;
  return `${who} 有 ${count} 个版本，但没有符合「${bits.join('、')}」的。可以放宽渠道（channel=beta/alpha），或换一个 mod。`;
}

/** 解析出「一定在 modsDir 里面」的绝对路径；越界返回 null。 */
export function resolveInside(baseDir, fileName) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, fileName);
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  if (resolved !== base && !resolved.startsWith(prefix)) return null;
  return resolved;
}

async function statSafe(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}