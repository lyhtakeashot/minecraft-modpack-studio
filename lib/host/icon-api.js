/**
 * 「物品长什么样」的宿主侧接口，给界面画图标用。
 *
 * 一个接口：
 *   /item-icons  给一批物品 ID，回 { id: dataURL }，取不到的进 missing
 *
 * 为什么是「一批」而不是「一个」：画布上一次可能有几百个节点，
 * 逐个请求会打几百次 HTTP，而且每个都走一遍「哪个 jar 有这张贴图」的查找。
 * 批量进来，内部按 jar 分组、一个 jar 只打开一次。
 *
 * 图标是本地读出来的（mod 的 jar、原版 assets/objects），不联网。
 * 这里只返回普通对象，包成 HTTP 响应是 lib/host/api.js 的事。
 */
import { McError } from '../../packages/core/errors.js';
import { resolveInstance } from '../../packages/core/instance.js';
import { ICON_LIMIT, resolveIcons } from '../../packages/core/item-icon.js';
import { buildExportIndex, describeExportIndex, findExportDirs } from '../../packages/core/icon-export.js';
import { resolveWebIcon } from '../../packages/core/icon-web.js';
import { asList, readParams } from './params.js';

/** 解析实例；界面传的是 dir（+ 可选 id）。 */
function instanceOf(params) {
  const dir = String(params.dir ?? '').trim();
  if (!dir) throw new McError('缺少实例目录', '在界面顶部先连一个整合包', 'McBadArgs');
  return resolveInstance(dir, String(params.id ?? ''));
}

/**
 * 一批物品 ID → 图标。
 *
 * 界面传 `ids`（数组，或逗号分隔的字符串）。
 * 超过上限就只取前 ICON_LIMIT 个，并在结果里如实说明截断了多少。
 */
export async function handleItemIcons(params) {
  // readParams 是异步的（要读 POST body），漏了 await 的话拿到的是 Promise，
  // 后面读 request.dir 永远是 undefined —— 会误报成「缺少实例目录」。
  const request = await readParams(params);
  const instance = instanceOf(request);
  const ids = asList(request.ids ?? request.id ?? request.items);
  if (ids.length === 0) {
    throw new McError('没给要取图标的物品', '传 ids，例如 ["minecraft:apple","create:cogwheel"]', 'IconNoIds');
  }

  const limited = ids.slice(0, ICON_LIMIT);
  const result = resolveIcons(instance, limited, { limit: ICON_LIMIT });

  const icons = {};
  for (const [id, icon] of result.icons) icons[id] = icon.dataUrl;

  return {
    ok: true,
    instance: instance.id,
    requested: ids.length,
    truncated: Math.max(0, ids.length - limited.length),
    limit: ICON_LIMIT,
    count: Object.keys(icons).length,
    missing: result.missing,
    icons,
    elapsedMs: result.elapsedMs,
    // 这一批图标里有多少是从「游戏导出」拿到的 —— 界面据此显示「高清」/「够用」
    exported: result.exported ?? null,
  };
}

/**
 * 单个物品去 MC百科 找图标（本地 jar 里没有的那 800 多个）。
 *
 * 为什么是「单个、点一下才查」而不是批量补齐：
 *   mcmod 有反爬。实测同一 IP 每 2.5 秒一次搜索是安全的，350ms 一次十几次就撞
 *   「搜索太频繁」并进 60 秒冷却。一个包缺 800 个图标，批量抓等于自杀式调用，
 *   所以这条路只做「用户点某一张时现查」，查到就落盘缓存（下次直接命中）。
 *
 * 查询关键词用物品的中文名（界面从候选列表里带过来）。没中文名就没法查 ——
 * mcmod 搜的是中文名，不是 mod:item 这种 ID。
 */
export async function handleWebItemIcon(params) {
  const request = await readParams(params);
  const instance = instanceOf(request);
  const itemId = String(request.item ?? request.itemId ?? '').trim();
  if (!itemId) {
    throw new McError('没给要查的物品 ID', '传 item，例如 minecraft:lava', 'IconNoItem');
  }
  const name = String(request.name ?? '').trim();
  const modName = String(request.mod ?? request.modName ?? '').trim();
  const force = request.force === true || String(request.force ?? '') === '1';
  const result = await resolveWebIcon({ itemId, name, modName, mcRoot: instance.mcRoot, force });
  return {
    // 传输本身成功了就是 ok:true；「mcmod 上没找到」是正常业务结果（found:false + reason），
    // 不能回 ok:false —— 界面那层的 apiPost 会把 ok!==true 当成请求失败，把原因吞成「HTTP 200」。
    ok: true,
    found: result.ok === true,
    instance: instance.id,
    item: itemId,
    name,
    source: result.source ?? null,
    title: result.title ?? null,
    dataUrl: result.dataUrl ?? null,
    cached: result.cached === true,
    size: result.size ?? 0,
    // 失败时只回一句人话原因（限流/没匹配/没图），界面照原样显示，不当成异常
    reason: result.ok === true ? '' : (result.reason ?? '没找到'),
  };
}

/** 导出目录现状，给界面显示「图标是哪来的」。 */
function exportStatusOf(instance, force) {
  const dirs = findExportDirs(instance);
  const index = buildExportIndex(dirs, { force });
  return {
    hasExport: index.count > 0,
    dirs: index.dirs,
    count: index.count,
    totalBytes: index.totalBytes,
    skipped: index.skipped,
    elapsedMs: index.elapsedMs,
    text: describeExportIndex(index),
  };
}

/**
 * 导出目录现状。
 *
 * 界面用它在任务书区域显示一行：「图标：游戏导出 1895 个（3.7 MB）」
 * 还是「图标：从 mod jar 里直接找（约 86%）」。
 */
export async function handleIconExportStatus(params) {
  const request = await readParams(params);
  const instance = instanceOf(request);
  return { ok: true, instance: instance.id, ...exportStatusOf(instance, false) };
}

/**
 * 强制重扫导出目录（用户刚在游戏里导完，不想等 10 分钟缓存过期就点这个）。
 */
export async function handleIconExportScan(params) {
  const request = await readParams(params);
  const instance = instanceOf(request);
  const status = exportStatusOf(instance, true);
  return {
    ok: true,
    instance: instance.id,
    ...status,
    lines: status.hasExport
      ? [status.text, `目录：${status.dirs.join('；')}`]
      : ['没找到 icon-exports 目录', '要生成高清图标：装 Icon Exporter（+ 前置 Cyclops Core）→ 进游戏 → 新建世界 → 打 /iconexporter export 64'],
  };
}