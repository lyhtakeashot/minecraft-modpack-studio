/**
 * 「从零装底座（选版本向导）」的宿主侧接口，给界面用。
 *
 * 两条：
 *   /scaffold/preview  算计划（下什么、多大、用哪个 java）—— 会联网查清单，不写盘
 *   /scaffold/apply    真下载真安装（POST，只有在用户点了「开始装」之后）
 *
 * 和 MCP 工具的 pack_scaffold 走同一对函数（packages/core/scaffold.js），
 * 所以界面里点出来的包和模型装出来的包长得一模一样。
 */
import { createHttp, readNetOptionsFromEnv } from '../../packages/core/mod-fetch.js';
import { formatSize } from '../../packages/core/mod-source.js';
import { applyScaffold, describeScaffold, planScaffold } from '../../packages/core/scaffold.js';
import { scaffoldReporter, createJob, failJob, finishJob, snapshotOf } from './progress.js';
import { boolOr, readParams } from './params.js';

/** 每次请求新建一个 http（连接池是进程级单例，不会被丢掉）。 */
function netHttp() {
  return createHttp({ ...readNetOptionsFromEnv(process.env), mirrorMode: 'auto' });
}

function planFrom(params) {
  return {
    mcRoot: String(params.mcRoot ?? params.root ?? '').trim(),
    name: String(params.name ?? '').trim(),
    mcVersion: String(params.mcVersion ?? params.version ?? '').trim(),
    loader: String(params.loader ?? 'neoforge').trim(),
    loaderVersion: String(params.loaderVersion ?? '').trim(),
    javaPath: String(params.javaPath ?? '').trim(),
  };
}

/** 把计划摊平成界面能直接渲染的形状。 */
function planPayload(plan) {
  return {
    ok: true,
    name: plan.name,
    mcRoot: plan.mcRoot,
    targetDir: plan.instanceDir,
    targetText: plan.targetText,
    mcVersion: plan.mcVersion,
    loader: plan.loader,
    loaderVersion: plan.loaderVersion,
    fileCount: plan.counts.totalFiles,
    vanillaFiles: plan.counts.coreFiles ?? plan.counts.vanillaFiles,
    assetFiles: plan.counts.assetFiles,
    loaderFiles: plan.counts.loaderFiles,
    javaFiles: plan.counts.javaFiles ?? 0,
    totalBytes: plan.bytes.total,
    totalText: formatSize(plan.bytes.total),
    assetsText: formatSize(plan.bytes.assets),
    loaderText: formatSize(plan.bytes.loader),
    javaText: formatSize(plan.bytes.java ?? 0),
    clientJarText: formatSize(plan.clientJar.size),
    java: plan.java,
    javaRequiredMajor: plan.javaRequiredMajor ?? 0,
    javaMatches: plan.javaMatches !== false,
    // 本机 Java 版本对不上时，apply 会先把官方运行时装上；界面要能提前说清这件事
    javaRuntime: plan.javaRuntime
      ? {
        component: plan.javaRuntime.component,
        version: plan.javaRuntime.version,
        dir: plan.javaRuntime.dir,
        fileCount: plan.javaRuntime.fileCount,
        bytes: plan.javaRuntime.downloadBytes,
        text: formatSize(plan.javaRuntime.downloadBytes),
      }
      : null,
    javaCandidates: plan.javaCandidates,
    installer: plan.installer,
    steps: plan.steps,
    warnings: plan.warnings,
    conflicts: plan.conflicts,
    lines: describeScaffold(plan),
  };
}

export async function handleScaffoldPreview(request) {
  const params = await readParams(request);
  const http = netHttp();
  const plan = await planScaffold({ http, ...planFrom(params) });
  return planPayload(plan);
}

export async function handleScaffoldApply(request) {
  const params = await readParams(request);
  const http = netHttp();
  const plan = await planScaffold({ http, ...planFrom(params) });
  // 建进度槽：装底座要下几百 MB、好几分钟，界面得能一边看条一边等。
  // total 直接取计划里算出来的总字节数，所以进度条的满格就是真实总量。
  const job = createJob({
    kind: 'scaffold',
    name: `从零装底座：${plan.name ?? planFrom(params).name}`,
    unit: Number(plan.bytes?.total) > 0 ? 'bytes' : 'files',
    done: 0,
    total: Number(plan.bytes?.total) || Number(plan.counts?.totalFiles) || 0,
    count: Number(plan.counts?.totalFiles) || 0,
    finished: 0,
    note: '准备开始',
  });
  let result;
  try {
    result = await applyScaffold({
      plan,
      http,
      javaPath: planFrom(params).javaPath,
      onProgress: scaffoldReporter(job, plan),
    });
  } catch (error) {
    failJob(job, error);
    throw error;
  }
  finishJob(job, { note: '装好了' });
  const payload = planPayload(plan);
  // 装完之后界面会把 payload 整个换成这一份，所以步骤的勾必须按「真的做了哪些阶段」重算，
  // 否则界面上会一直显示「☐ 要装」，看着像什么都没干。
  const doneKeys = new Set(
    (result.stages ?? []).filter((s) => s.status === 'ok').map((s) => s.key),
  );
  return {
    ...payload,
    steps: payload.steps.map((s) => ({ ...s, done: s.done || doneKeys.has(s.key) })),
    applied: true,
    job: snapshotOf(job),
    seconds: result.seconds,
    inheritsFrom: result.inheritsFrom,
    filesVanilla: result.files.vanilla,
    filesLoader: result.files.loader,
    filesJava: result.files.java ?? 0,
    java: result.java ?? payload.java,
    javaRuntime: result.javaRuntime ?? payload.javaRuntime,
    stages: result.stages,
    lines: [
      ...payload.lines,
      '',
      `装好了：${result.instanceDir}`,
      `用时 ${result.seconds.toFixed(1)} 秒；原版新下 ${result.files.vanilla} 个、加载器依赖新下 ${result.files.loader} 个`
      + (result.files.java ? `、Java 运行时新下 ${result.files.java} 个` : ''),
    ],
  };
}
