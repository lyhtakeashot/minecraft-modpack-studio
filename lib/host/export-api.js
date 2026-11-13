/**
 * 「打包」的宿主侧接口，给界面用。
 *
 * 两条：
 *   /export/preview  算打包计划（打哪些文件、多大、会缺什么）—— 不写盘
 *   /export/build    真打 zip（POST，用户点了「打这个包」之后）
 *
 * 和 MCP 工具 export_preview / launch_preview 走的是同一对函数（packages/core/export.js），
 * 所以界面打出来的包和模型打出来的包一模一样（同样的结构、同样的 PCL 自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInstance } from '../../packages/core/instance.js';
import { McError } from '../../packages/core/errors.js';
import { EXPORT_MODES, buildExport, planExport } from '../../packages/core/export.js';
import { formatSize } from '../../packages/core/mod-source.js';
import { createJob, exportReporter, failJob, finishJob, snapshotOf } from './progress.js';
import { boolOr, readParams } from './params.js';

/** 界面传来的参数 → resolveInstance 的实例。 */
function instanceOf(params) {
  const dir = String(params.dir ?? params.instanceDir ?? '').trim();
  if (!dir) throw new McError('缺少整合包目录', '先在①里连一个整合包', 'McBadArgs');
  if (!fs.existsSync(dir)) throw new McError(`目录不存在：${dir}`, '检查路径，或重新连接一次', 'McDirMissing');
  return resolveInstance(dir, String(params.id ?? params.instanceId ?? '').trim() || undefined);
}

/** 界面传来的参数 → planExport 的选项。 */
function optionsOf(params) {
  const mode = String(params.mode ?? 'offline').toLowerCase();
  if (!EXPORT_MODES.includes(mode)) {
    throw new McError(`不认识的打包形态：${mode}`, `可选：${EXPORT_MODES.join(' / ')}`, 'McBadMode');
  }
  return {
    mode,
    packName: String(params.packName ?? params.name ?? '').trim() || undefined,
    includeSaves: boolOr(params.includeSaves, false),
    includeLibraries: boolOr(params.includeLibraries, true),
    includeAssets: boolOr(params.includeAssets, true),
    includeRuntime: boolOr(params.includeRuntime, false),
    pclExe: String(params.pclExe ?? '').trim() || undefined,
    outFile: String(params.outFile ?? '').trim() || undefined,
  };
}

/** 把计划摊平成界面能直接渲染的形状（不含 entries 明细，包太大时这数组很长）。 */
function planPayload(plan, instance) {
  const byTop = new Map();
  for (const e of plan.entries) {
    const top = e.name.split('/')[0];
    const cur = byTop.get(top) ?? { name: top, files: 0, bytes: 0 };
    cur.files += 1;
    cur.bytes += e.size || 0;
    byTop.set(top, cur);
  }
  const top = [...byTop.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  // 打在哪：和工具一样落在实例目录上一级
  const willWriteTo = path.resolve(instance.instanceDir, '..', plan.suggestZip);

  return {
    ok: true,
    mode: plan.mode,
    packName: plan.packName,
    wrapper: plan.wrapper,
    suggestZip: plan.suggestZip,
    instanceId: instance.id,
    mcVersion: instance.mcVersion,
    loader: instance.loader,
    fileCount: plan.fileCount,
    totalBytes: plan.totalBytes,
    totalText: formatSize(plan.totalBytes),
    warnings: plan.warnings,
    top: top.map((t) => ({ name: t.name, files: t.files, sizeText: formatSize(t.bytes) })),
    nested: plan.inner ? { fileCount: plan.inner.fileCount, totalText: formatSize(plan.inner.totalBytes) } : null,
    // 打在哪：和工具一样落在实例目录上一级
    outDir: path.dirname(willWriteTo),
    willWriteTo,
  };
}

export async function handleExportPreview(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const plan = planExport(instance, optionsOf(params));
  return planPayload(plan, instance);
}

export async function handleExportBuild(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const opts = optionsOf(params);
  // 打包是本地读写，比下载快得多，但一个包几千个文件也要几秒到几十秒。
  // 条目总数要等 planExport 才算得出来，所以先建一个「不知道总量」的槽，
  // 第一次进度事件进来时会自己把 total 补上。
  const job = createJob({
    kind: 'export',
    name: `打包：${instance.id}`,
    unit: 'files',
    done: 0,
    total: 0,
    count: 0,
    finished: 0,
    indeterminate: true,
    note: '正在算要打哪些文件',
  });
  let result;
  try {
    result = await buildExport(instance, { ...opts, onProgress: exportReporter(job) });
  } catch (error) {
    failJob(job, error);
    throw error;
  }
  finishJob(job, { note: '打好了' });
  return {
    ...planPayload(result.plan, instance),
    built: true,
    job: snapshotOf(job),
    outFile: result.outFile,
    zipBytes: result.bytes,
    zipText: formatSize(result.bytes),
    entries: result.entries,
    check: {
      ok: result.check.ok,
      failed: result.check.items.filter((i) => !i.ok).map((i) => ({ rule: i.rule, detail: i.detail ?? '' })),
      items: result.check.items.map((i) => ({ rule: i.rule, ok: i.ok, detail: i.detail ?? '' })),
    },
  };
}