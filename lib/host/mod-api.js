/**
 * 「找 mod / 装 mod」的宿主侧接口，给界面用。
 *
 * 十一个接口：
 *   /mod-search                  按关键词搜（Modrinth），返回候选列表
 *   /mod-versions                看某个 mod 有哪些版本，手动挑一个
 *   /mod-install/preview         算清单：下哪几个文件、多大、带不带前置（不写盘）
 *   /mod-install/apply           真下载写进 mods/（写前每个文件都校验 sha1）
 *   /mod-compat                  给整包做一次兼容性体检（只读，不写盘）
 *   /mod-update/check            检查更新：按已装 jar 的 sha1 问 Modrinth 谁有新版（只读联网，不写盘）
 *   /mod-update/preview          算升级清单：要下哪些文件、哪些旧 jar 会被停用（不写盘）
 *   /mod-update/apply            真升级：停用旧 jar（改名，不删）+ 下载新 jar（写盘，只收 POST）
 *   /mod-update/locks            锁定名单：GET 只读、POST 才写（add / remove / clear，写在软件数据目录）
 *   /mod-update/rollback/preview 算撤回清单：把哪几个新 jar 停用、哪几个旧 jar 改回原名（不写盘）
 *   /mod-update/rollback/apply   真撤回：新 jar 改名停用 + 旧 jar 改回原名（写盘，只收 POST，绝不删文件）
 *
 * 和 MCP 工具走的是同一批函数（packages/core/mod-*.js），不是另写一套 ——
 * 界面里点的和模型改的必须是同一件事。
 *
 * 这里只返回普通对象，包成 HTTP 响应是 lib/host/api.js 的事。
 */
import { McError } from '../../packages/core/errors.js';
import { resolveInstance } from '../../packages/core/instance.js';
import { createHttp, describeNetworkFailure, isNetworkFailure, readNetOptionsFromEnv } from '../../packages/core/mod-fetch.js';
import { createJob, failJob, finishJob, modInstallReporter, snapshotOf } from './progress.js';
import {
  cfSearchUrl, formatDownloads, formatSize, mrSearchUrl, mrVersionsUrl, normalizeLoader,
  parseMrSearch, parseMrVersions, pickMrVersion, rankCandidates,
} from '../../packages/core/mod-source.js';
import { applyInstallPlan, buildInstallPlan, describePlan, describeResult } from '../../packages/core/mod-install.js';
import { compatReportAsync, mcVersionMatches } from '../../packages/core/mod-compat.js';
import {
  applyRollbackPlan, applyUpdatePlan, buildRollbackPlan, buildUpdatePlan,
  checkModUpdates, describeRollbackResult, describeUpdateResult,
} from '../../packages/core/mod-update.js';
import { applyLockChange, readLocks, saveLocks } from './mod-update-locks.js';
import { asList, readParams } from './params.js';

/** 解析实例；界面传的是 dir（+ 可选 id）。 */
function instanceOf(params) {
  const dir = String(params.dir ?? '').trim();
  if (!dir) throw new McError('缺少实例目录', '在界面顶部先连一个整合包', 'McBadArgs');
  return resolveInstance(dir, String(params.id ?? ''));
}

/** 没给 gameVersion/loader 就用实例的（这是最不容易出错的默认）。 */
function filtersOf(params, instance) {
  const gameVersion = String(params.gameVersion ?? '').trim() || (instance?.mcVersion ?? '');
  const loader = String(params.loader ?? '').trim() || (instance?.loader ?? '');
  return { gameVersion, loader: normalizeLoader(loader) || loader };
}

function netHttp() {
  return createHttp({ ...readNetOptionsFromEnv(), timeoutMs: 20_000 });
}

/**
 * 界面把「这个工程点名要哪个版本」单独用一个参数传过来（JSON 串或对象）。
 * 不能塞进 projects 数组里的对象 —— asList/normalizeList 只认 projectId/slug/title，
 * 会静默丢掉别的字段。这里单独解析，只保留「key → 非空 versionId」。
 */
function parsePinnedMap(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return {}; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, id] of Object.entries(raw)) {
    const k = String(key).trim();
    const v = String(id ?? '').trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/** 网络失败翻译成界面能直接显示的一句话，别把栈丢给前端。 */
function friendly(error) {
  if (isNetworkFailure(error)) {
    const friendlyError = describeNetworkFailure(error);
    return { message: friendlyError.message, hint: friendlyError.hint };
  }
  return { message: error?.message ?? String(error), hint: error?.hint ?? '' };
}

// ————————————————————————— 搜索 —————————————————————————

export async function handleModSearch(request) {
  const params = await readParams(request);
  const query = String(params.q ?? params.query ?? '').trim();
  if (!query) throw new McError('没给搜索词', '在搜索框里输入 mod 名字（英文最准）', 'McBadArgs');

  // 实例可选：连了包就自动带版本和加载器。
  const instance = params.dir ? instanceOf(params) : null;
  const filters = filtersOf(params, instance);
  const source = String(params.source ?? 'modrinth').toLowerCase();
  const limit = Math.max(1, Math.min(Number(params.limit ?? 12) || 12, 40));

  if (source === 'curseforge') {
    const net = readNetOptionsFromEnv();
    if (!net.curseforgeKey) {
      return {
        ok: false,
        source,
        error: 'CurseForge 需要 API Key',
        hint: '界面默认用 Modrinth（不需要 key）。要用 CurseForge 就在环境变量里配 MCSTUDIO_CURSEFORGE_KEY。',
        results: [],
        lines: ['CurseForge 需要 API Key，现在没配。改用 Modrinth 吧（去掉 source 即可）。'],
      };
    }
    const http = netHttp();
    const json = await http.json(cfSearchUrl({
      query, gameVersion: filters.gameVersion, loader: filters.loader, limit,
    }));
    return cfSearchPayload(json, { query, ...filters, source });
  }

  const http = netHttp();
  let json;
  try {
    json = await http.json(mrSearchUrl({ query, gameVersion: filters.gameVersion, loader: filters.loader, limit }));
  } catch (error) {
    const { message, hint } = friendly(error);
    return {
      ok: false,
      source: 'modrinth',
      query,
      error: message,
      hint,
      results: [],
      lines: [`搜不了：${message}`, hint],
    };
  }
  const parsed = parseMrSearch(json);
  const results = rankCandidates(parsed.results).slice(0, limit).map((item) => ({
    ...item,
    downloadsText: formatDownloads(item.downloads),
  }));
  return {
    ok: true,
    source: 'modrinth',
    query,
    gameVersion: filters.gameVersion,
    loader: filters.loader,
    total: parsed.total,
    results,
    lines: results.length
      ? [`Modrinth 搜到 ${parsed.total} 个，前 ${results.length} 个`]
      : [`没搜到「${query}」，换个英文名或放宽版本/加载器`],
  };
}

/** CurseForge 搜索结果的最小映射（列表够用；装 mod 这轮只走 Modrinth）。 */
function cfSearchPayload(json, meta) {
  const data = Array.isArray(json?.data) ? json.data : [];
  const results = data.map((item) => ({
    source: 'curseforge',
    projectId: String(item?.id ?? ''),
    slug: String(item?.slug ?? ''),
    title: String(item?.name ?? ''),
    description: String(item?.summary ?? ''),
    downloads: Number(item?.downloadCount ?? 0),
    downloadsText: formatDownloads(Number(item?.downloadCount ?? 0)),
    categories: (item?.categories ?? []).map((c) => String(c?.name ?? '')),
    loaders: [],
    versions: [],
    updated: String(item?.dateModified ?? ''),
    pageUrl: String(item?.links?.websiteUrl ?? ''),
    iconUrl: String(item?.logo?.thumbnailUrl ?? ''),
  }));
  return {
    ok: true,
    ...meta,
    total: Number(json?.pagination?.totalCount ?? results.length),
    results,
    lines: [`CurseForge 搜到 ${results.length} 个（这一版只能看，装 mod 走 Modrinth）`],
  };
}

// ————————————————————————— 版本列表 —————————————————————————

export async function handleModVersions(request) {
  const params = await readParams(request);
  const project = String(params.project ?? params.projectId ?? '').trim();
  if (!project) throw new McError('缺少工程 ID', '先搜索，拿到 projectId 或 slug', 'McBadArgs');
  const instance = params.dir ? instanceOf(params) : null;
  const filters = filtersOf(params, instance);
  const channel = String(params.channel ?? 'release').toLowerCase();

  const http = netHttp();
  let versions;
  try {
    versions = parseMrVersions(await http.json(mrVersionsUrl(project)));
  } catch (error) {
    const { message, hint } = friendly(error);
    return { ok: false, project, error: message, hint, versions: [], lines: [`拿不到版本列表：${message}`] };
  }

  const list = versions
    .filter((v) => !filters.gameVersion || v.gameVersions.length === 0 || v.gameVersions.includes(filters.gameVersion))
    .map((v) => ({
      versionId: v.id,
      versionNumber: v.versionNumber,
      versionType: v.versionType,
      fileName: v.fileName,
      size: v.size,
      sizeText: formatSize(v.size),
      published: v.published,
      gameVersions: v.gameVersions,
      loaders: v.loaders,
      requiredDeps: v.dependencies.filter((d) => d.type === 'required').length,
      compatible: Boolean(filters.loader) ? v.loaders.includes(filters.loader) : true,
      // 适不适合用户这个 MC 版本（只看 MC 版本这一条，加载器是上面那个 compatible）。
      mcCompatible: mcVersionMatches(v.gameVersions, filters.gameVersion),
    }))
    .sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));

  const auto = pickMrVersion(versions, { gameVersion: filters.gameVersion, loader: filters.loader, channel });
  // 标出「推荐装的那个」：自动挑出来的那一条。界面靠它显示「推荐」标记。
  const autoId = auto?.id ? String(auto.id) : '';
  for (const item of list) {
    item.recommended = Boolean(autoId) && item.versionId === autoId;
  }
  return {
    ok: true,
    project,
    gameVersion: filters.gameVersion,
    loader: filters.loader,
    channel,
    autoVersionNumber: auto?.versionNumber ?? '',
    versions: list,
    lines: [`共 ${list.length} 个版本` + (auto ? `，自动挑的是 ${auto.versionNumber}` : '，没有完全匹配的')],
  };
}

// ————————————————————————— 安装（预览 / 真装） —————————————————————————

async function buildPlanFrom(params) {
  const instance = instanceOf(params);
  const filters = filtersOf(params, instance);
  const projects = asList(params.projects);
  if (projects.length === 0) throw new McError('没说要装哪个 mod', '先搜索，再把 projectId 或 slug 勾上', 'McBadArgs');
  // 下载目录：界面可以指定装到别的地方（PCL 也有这个功能）；不填就装进实例的 mods 目录。
  const targetDir = String(params.targetDir ?? '').trim();
  const plan = await buildInstallPlan({
    http: netHttp(),
    modsDir: instance.modsDir,
    targetDir: targetDir || instance.modsDir,
    requests: projects,
    gameVersion: filters.gameVersion,
    loader: filters.loader,
    channel: String(params.channel ?? 'release').toLowerCase(),
    withDeps: params.withDeps === undefined ? true : Boolean(params.withDeps),
    pinned: parsePinnedMap(params.pinned),
  });
  return { instance, plan, filters };
}

function planPayload(plan, instance) {
  // 这次清单涉及哪些工程（用户勾的 + 自动带上的前置）。
  // 界面多选时靠它把「要装 N 个」原样发回来 —— 只回 projectId 会漏掉前置。
  const projectIds = [];
  for (const item of plan.items) {
    const key = item.projectId ?? item.slug;
    if (key && !projectIds.includes(key)) projectIds.push(key);
  }
  return {
    ok: true,
    modsDir: plan.modsDir,
    // 下载目录：文件到底下到哪儿（绝对路径）。界面原样显示，用户能确认没下错地方。
    targetDir: plan.targetDir || plan.modsDir,
    instanceId: instance?.id ?? '',
    // 单选用：兼容老前端和「只看这个」那条路
    projectId: projectIds[0] ?? '',
    projectIds,
    // 界面「就装这些」会把这份清单原样发回 apply，连点名的版本一起带回去，
    // 保证预览和真装用的是同一批版本，不会预览是旧版、装的是最新。
    pinned: plan.pinned ?? {},
    itemCount: plan.items.length,
    totalBytes: plan.totalBytes,
    totalText: formatSize(plan.totalBytes),
    installedCount: plan.installedCount,
    items: plan.items.map((item) => ({
      title: item.title,
      projectId: item.projectId,
      slug: item.slug,
      versionId: item.versionId,
      versionNumber: item.versionNumber,
      versionType: item.versionType,
      fileName: item.fileName,
      size: item.size,
      sizeText: formatSize(item.size),
      reason: item.reason,
      dependencyOf: item.dependencyOf,
      pageUrl: item.pageUrl,
    })),
    skipped: plan.skippedExisting,
    conflicts: plan.conflicts.map((item) => ({ title: item.title, fileName: item.fileName, projectId: item.projectId })),
    unresolved: plan.unresolved,
    // 装之前的整包体检结果（互斥 / 缺前置 / 装了多份 / 版本对不上）。
    compat: plan.compat ?? null,
    lines: describePlan(plan),
  };
}

export async function handleModInstallPreview(request) {
  const params = await readParams(request);
  const { instance, plan } = await buildPlanFrom(params);
  return planPayload(plan, instance);
}

export async function handleModInstallApply(request) {
  const params = await readParams(request);
  const { instance, plan } = await buildPlanFrom(params);
  if (plan.items.length === 0) {
    return { ...planPayload(plan, instance), applied: false, installed: [], failed: [] };
  }
  const http = netHttp();
  // 建一个进度槽：界面拿 jobId 一边轮询一边看下载条。
  // 总字节先按计划里的估算垫上，真下的时候会用单文件的实际大小修正。
  const job = createJob({
    kind: 'mod-install',
    name: `装 mod（${plan.items.length} 个）`,
    unit: 'bytes',
    done: 0,
    total: Number(plan.totalBytes) || 0,
    count: plan.items.length,
    finished: 0,
    note: '准备下载',
  });
  const report = modInstallReporter(job);
  let result;
  try {
    result = await applyInstallPlan({ http, plan, modsDir: plan.targetDir || instance.modsDir, onProgress: report });
  } catch (error) {
    failJob(job, error);
    throw error;
  }
  finishJob(job, { note: result.failed.length === 0 ? '装完了' : `${result.failed.length} 个没装成` });
  const payload = planPayload(plan, instance);
  // 装完之后再体检一次：看看新装的有没有跟包里别的 mod 互斥、有没有缺前置。
  let after = null;
  try {
    after = await compatReportAsync(instance.modsDir);
  } catch {
    after = null;
  }
  return {
    ...payload,
    ok: result.failed.length === 0,
    applied: true,
    job: snapshotOf(job),
    installed: result.installed,
    failed: result.failed,
    skipped: [...payload.skipped, ...result.skipped],
    compat: after ?? payload.compat ?? null,
    lines: [...payload.lines, '', ...describeResult(result)],
  };
}

// ————————————————————————— 整包兼容性体检 —————————————————————————

/**
 * 给当前实例的 mods 目录做一次体检（只读，一个文件都不写）。
 *
 * 返回互斥、缺前置、装了多份、版本对不上这四类问题，外加几句人话。
 * 界面上的「查兼容」按钮用的就是它。
 */
export async function handleModCompat(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const report = await compatReportAsync(instance.modsDir);
  return {
    ok: true,
    instanceId: instance.id ?? '',
    modsDir: report.modsDir,
    count: report.count,
    failed: report.failed,
    conflicts: report.conflicts,
    missing: report.missing,
    versionMismatch: report.versionMismatch,
    duplicates: report.duplicates,
    mods: report.mods,
    // 「有没有发现问题」：干净就是 true。字段名不叫 ok，免得跟外层的 ok 打架。
    clean: report.ok,
    lines: report.lines,
  };
}

// ————————————————————————— 检查 mod 更新 —————————————————————————

/**
 * 界面把「检查更新」的结果原样回传（JSON 串或对象），
 * 预览和真装就不必再联网问一遍 Modrinth 了，也保证两次看到的清单是同一份。
 */
function checkFromParams(params) {
  let raw = params.check;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
  return raw;
}

/** 拿到检查结果：优先用回传的，没有就现查一次（MCP 单独调预览时走这条）。 */
async function ensureCheck(params, instance, http, locked = []) {
  const cached = checkFromParams(params);
  if (cached) return cached;
  const filters = filtersOf(params, instance);
  const channel = String(params.channel ?? 'release').trim() || 'release';
  return checkModUpdates({ http, modsDir: instance.modsDir, ...filters, channel, locked });
}

/**
 * 界面把升级结果原样回传（JSON 串或对象），撤回预览/真撤回才拿得到
 * installed[] 里记录下来的「旧文件名 / 实际停用名 / 新文件名」。
 * 注意：停用名不能硬拼 .jar.disabled —— 撞车时 core 会生成别的后缀。
 */
function resultFromParams(params) {
  let raw = params.result;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  return raw && typeof raw === 'object' ? raw : null;
}

/** 锁定名单的「一条」：界面 post() 传对象，MCP 走 GET query 时可能是 JSON 串。 */
function lockEntryFromParams(params) {
  let raw = params.entry;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  return raw && typeof raw === 'object' ? raw : null;
}

/** 检查更新：只读联网，返回「谁有更新」的表。一个文件都不写。 */
export async function handleModUpdateCheck(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const filters = filtersOf(params, instance);
  const channel = String(params.channel ?? 'release').trim() || 'release';
  // 锁定名单存在软件自己的数据目录里，后端自己读，界面不用传，天然不会漏。
  const locked = readLocks(params.dir, params.id);
  let check;
  try {
    check = await checkModUpdates({ http: netHttp(), modsDir: instance.modsDir, ...filters, channel, locked });
  } catch (error) {
    // 网络不通是家常便饭，别把整页打成红字：给一张「空结果 + 提示」的表，
    // 界面照常画出来，用户看得懂「这次没查成」。外层 ok() 会统一补 ok:true，
    // 所以这里不能靠 ok:false 报失败，只能把话放进 error / hint / lines。
    const { message, hint } = friendly(error);
    return {
      instanceId: instance.id ?? '',
      modsDir: instance.modsDir,
      gameVersion: filters.gameVersion,
      loader: filters.loader,
      channel,
      scanned: 0, items: [], updates: 0, latest: 0, unknown: 0, locked: 0,
      locks: locked,
      error: message,
      hint,
      lines: [`检查不了更新：${message}`, hint].filter(Boolean),
    };
  }
  return { ok: true, instanceId: instance.id ?? '', locks: locked, ...check };
}

/** 算升级清单：不写盘。传 check 就不联网，没传就现查；锁定项永远进不了清单。 */
export async function handleModUpdatePreview(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const locked = readLocks(params.dir, params.id);
  const check = await ensureCheck(params, instance, netHttp(), locked);
  const plan = await buildUpdatePlan({ check, modsDir: instance.modsDir, selected: params.selected, locked });
  return {
    ok: true,
    instanceId: instance.id ?? '',
    check,
    locks: locked,
    ...plan,
  };
}

/** 真升级：停用旧 jar（改名，不删）+ 下载新 jar。只收 POST，全程带进度。 */
export async function handleModUpdateApply(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const http = netHttp();
  const locked = readLocks(params.dir, params.id);
  const check = await ensureCheck(params, instance, http, locked);
  const plan = await buildUpdatePlan({ check, modsDir: instance.modsDir, selected: params.selected, locked });
  if (plan.items.length === 0) {
    return { ok: true, applied: false, installed: [], failed: [], skipped: plan.skipped, check, ...plan };
  }
  const job = createJob({
    kind: 'mod-update',
    name: `升级 mod（${plan.items.length} 个）`,
    unit: 'bytes',
    done: 0,
    total: Number(plan.totalBytes) || 0,
    count: plan.items.length,
    finished: 0,
    note: '准备下载',
  });
  const report = modInstallReporter(job);
  let result;
  try {
    result = await applyUpdatePlan({ http, plan, modsDir: instance.modsDir, onProgress: report });
  } catch (error) {
    failJob(job, error);
    throw error;
  }
  finishJob(job, { note: result.failed.length === 0 ? '升完了' : `${result.failed.length} 个没升成` });
  let after = null;
  try {
    after = await compatReportAsync(instance.modsDir);
  } catch {
    after = null;
  }
  return {
    ok: result.failed.length === 0,
    applied: true,
    instanceId: instance.id ?? '',
    modsDir: result.modsDir,
    job: snapshotOf(job),
    check,
    locks: locked,
    totalBytes: plan.totalBytes,
    installed: result.installed,
    skipped: [...plan.skipped, ...result.skipped],
    failed: result.failed,
    compat: after,
    lines: [...plan.lines, '', ...describeUpdateResult(result)],
  };
}

// ————————————————————————— 锁定名单 / 一键撤回（2026-11-07 第二轮） —————————————————————————

/**
 * 锁定名单：GET 只读，POST 才写（action = add / remove / clear）。
 * 名单写在软件自己的数据目录（mod-update-locks.json），绝不碰用户整合包。
 * 写失败不抛整页红字，把话放进 error / hint / lines —— 外层 ok() 会补 ok:true。
 */
export async function handleModUpdateLocks(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const method = String(request.method ?? 'GET').toUpperCase();
  const current = readLocks(params.dir, params.id);
  if (method !== 'POST') {
    return {
      ok: true,
      instanceId: instance.id ?? '',
      locks: current,
      lines: [current.length ? `这个包锁定了 ${current.length} 个 mod。` : '这个包还没有锁定任何 mod。'],
    };
  }
  const action = String(params.action ?? 'add').trim() || 'add';
  const entry = lockEntryFromParams(params) ?? {};
  try {
    const next = applyLockChange(current, action, entry);
    const saved = saveLocks(params.dir, params.id, next);
    const label = entry.name || entry.modId || entry.projectId || entry.fileName || '';
    const lines = [];
    if (action === 'clear') lines.push('已清空这个包的锁定名单。');
    else if (action === 'remove') lines.push(`已解除锁定：${label}`);
    else lines.push(`已锁定：${label}（以后不再提示更新，也不会被升级）`);
    lines.push(`名单里现在有 ${saved.length} 个 mod。`);
    return { ok: true, instanceId: instance.id ?? '', action, locks: saved, lines };
  } catch (error) {
    const { message, hint } = friendly(error);
    return {
      instanceId: instance.id ?? '',
      action,
      locks: current,
      error: message,
      hint,
      lines: [`改不了锁定名单：${message}`, hint].filter(Boolean),
    };
  }
}

/**
 * 算撤回清单：只算不写。result 是升级结果（含 installed[] 与记录下来的实际停用名）。
 * 界面把整块结果回传；没回传就明确报错，绝不自己瞎拼 .jar.disabled。
 */
export async function handleModUpdateRollbackPreview(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const result = resultFromParams(params);
  const plan = await buildRollbackPlan({ result, modsDir: instance.modsDir });
  return { ok: true, instanceId: instance.id ?? '', ...plan };
}

/**
 * 真撤回：新 jar 改名停用 + 旧 jar 改回原名，一个文件都不删。只收 POST。
 * 同样优先用回传的 result，再用 buildRollbackPlan 算一遍，保证和预览同一条底线。
 */
export async function handleModUpdateRollbackApply(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const result = resultFromParams(params);
  const plan = await buildRollbackPlan({ result, modsDir: instance.modsDir });
  if (plan.items.length === 0) {
    return { ok: true, applied: false, restored: [], failed: [], skipped: plan.skipped, lines: plan.lines };
  }
  const applied = await applyRollbackPlan({ plan, modsDir: instance.modsDir });
  return {
    ok: applied.failed.length === 0,
    applied: true,
    instanceId: instance.id ?? '',
    modsDir: applied.modsDir,
    restored: applied.restored,
    failed: applied.failed,
    skipped: plan.skipped,
    lines: [...plan.lines, '', ...describeRollbackResult(applied)],
  };
}