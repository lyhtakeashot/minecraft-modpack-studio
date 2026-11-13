/**
 * 「启动验证」的宿主侧接口，给界面用。
 *
 * 两条：
 *   /launch/preview  只算启动计划（classpath / natives / 参数 / 命令行）—— 绝不启动进程
 *   /launch/apply    真启动 JVM，跑到主菜单为止（POST，且必须显式 apply: true）
 *
 * 和模型工具（MCP 服务器的 launch 能力）走的是同一批函数（packages/core/launch.js），
 * 所以界面里点出来的结论和模型验出来的结论是同一条。
 *
 * ok 的语义（这条别改）：**传输本身出错才 ok:false**；
 * 「没启动成功」「找不到客户端 jar」都是业务结论，一律 ok:true + 单独字段。
 * 因为界面的 api()（packages/ui/app.js:94）和 post()（:107）是 body.ok === false 就抛异常，
 * 一抛之后 suspects 那几条最有价值的归因方向就全显示不出来了
 * （同一个教训见 lib/host/icon-api.js:88-90）。
 */
import fs from 'node:fs';
import { plan, describePlan, renderCommand, launch } from '../../packages/core/launch.js';
import { McError } from '../../packages/core/errors.js';
import { resolveInstance } from '../../packages/core/instance.js';
import { boolOr, readParams } from './params.js';

/** 命令行超过这个字符数就截断：一整条 classpath 能有几千字符，整段塞进 JSON 没意义。 */
const CMD_LIMIT = 4000;

/** 真启动时默认等多久（首次启动要下资源，给足 10 分钟）。 */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * 界面传来的参数 → 实例。
 *
 * 和 lib/host/export-api.js:20-25 那个 instanceOf 是同一个写法：
 * 先认 dir / instanceDir 两种名字，再按 id / instanceId 精确挑一个。
 */
function instanceOf(params) {
  const dir = String(params.dir ?? params.instanceDir ?? '').trim();
  if (!dir) throw new McError('缺少整合包目录', '先在①里连一个整合包', 'McBadArgs');
  if (!fs.existsSync(dir)) throw new McError(`目录不存在：${dir}`, '检查路径，或重新连接一次', 'McDirMissing');
  return resolveInstance(dir, String(params.id ?? params.instanceId ?? '').trim() || undefined);
}

/** 界面传来的参数 → plan() 的选项（纯计算那一步用的输入）。 */
function planOptionsOf(params, instance) {
  return {
    instanceDir: instance.instanceDir,
    mcRoot: String(params.mcRoot ?? '').trim() || undefined,
    javaPath: String(params.javaPath ?? '').trim() || undefined,
    username: String(params.username ?? '').trim() || undefined,
  };
}

/** 把完整命令行渲染成可复制的样子，太长就截断并说明截了多少。 */
function commandOf(p) {
  const full = p.argv.length ? renderCommand(p.argv) : '(没找到可用的 Java，组装不出命令行)';
  const truncated = full.length > CMD_LIMIT;
  return {
    command: truncated ? `${full.slice(0, CMD_LIMIT)}… （共 ${full.length} 字符，已截断）` : full,
    commandTruncated: truncated,
  };
}

/**
 * 真启动前必须先拦掉的硬伤。
 *
 * 不拦的话 spawn 出去只会拿到一堆无解的 JVM 报错，用户看不出是「库没下全」还是「mod 冲突」。
 * 这也正是界面「真启动」按钮该禁用的条件，所以直接把结论随 preview 一起回给界面。
 */
function blockersOf(p) {
  const blockers = [];
  if (!p.java) {
    blockers.push('本机没找到可用的 Java：先装一个 JRE，或在参数里指定 javaPath');
  } else if (p.java.warning) {
    blockers.push(p.java.warning);
  }
  if (p.stats.missing.length) {
    blockers.push(`有 ${p.stats.missing.length} 个库文件不在磁盘上：先用启动器把该实例跑一次让库下全`);
  }
  if (!p.hasClientJar) {
    blockers.push(`找不到客户端 jar：${p.clientJar}`);
  }
  return blockers;
}

/** 参数列表里的 Java 版本够不够（requiredMajor 为 0 表示版本 json 没声明，按够算）。 */
function javaMatches(java, requiredMajor) {
  return Boolean(java && (!requiredMajor || java.major >= requiredMajor));
}

/**
 * 把 launch() 的返回值摊平成界面能直接渲染的形状。
 *
 * 单独拆出来 + 导出，是为了测试能在**不启动 JVM** 的前提下验证这里的字段
 * （尤其 started 和 ok 的语义）—— 这个沙箱里真启动一次要几十秒还会弹窗口。
 *
 * @param {object} r launch() 的返回值
 * @param {object} [opts]
 * @param {number} [opts.tailLines] 回带多少行日志尾部，默认 20
 * @param {string[]} [opts.planLines] 启动前算出来的计划报告行
 * @param {string[]} [opts.extraLines] 计划行之后、结论之前要补的几行（比如 natives 解压结果）
 */
export function launchResultPayload(r, opts = {}) {
  const tailLines = Number(opts.tailLines ?? 20) || 20;
  const tail = String(r.tail ?? '').split(/\r?\n/).filter((l) => l.trim()).slice(-tailLines);
  const verdict = r.verdict ?? { status: 'crashed', summary: '', suspects: [] };
  const suspects = verdict.suspects ?? [];

  // 结论行：成功与否都照原样把 verdict.summary 摆出来，失败时再补归因方向。
  const lines = [...(opts.planLines ?? []), ...(opts.extraLines ?? [])];
  lines.push('');
  lines.push(`结论：${verdict.summary}`);
  if (suspects.length) lines.push(`归因方向：${suspects.join('；')}`);
  if ((r.newCrashReports ?? []).length) lines.push(`新增崩溃报告：${r.newCrashReports.join(', ')}`);
  if (r.logFile) lines.push(`日志：${r.logFile}`);
  if (tail.length) {
    lines.push('');
    lines.push(`日志尾部 ${tail.length} 行：`);
    lines.push(...tail.map((l) => `  ${l}`));
  }

  return {
    // 传输成功了就是 true；「没启动到主菜单」是业务结论，不是接口错误
    ok: true,
    started: verdict.status === 'ok',
    status: verdict.status, // ok | crashed | timeout | spawn-failed
    summary: verdict.summary, // 人话结论，界面直接显示
    suspects, // 归因方向，界面直接显示
    durationMs: r.durationMs ?? 0,
    timeoutHit: r.timeoutHit === true,
    exitCode: r.exitCode === null || r.exitCode === undefined ? -1 : r.exitCode,
    signal: r.signal ?? '',
    // core 的 evidence 是**一个字符串**（判定成功的那一行日志），不是数组；
    // 但界面（packages/ui/app.js:2187-2188）按数组用 `.slice(0,6)` 逐行铺，
    // 直接传字符串会被拆成一个个单字。所以这里统一成「0 或 1 行的数组」，
    // 原始字符串另放 evidenceLine，谁需要原文谁拿这个。
    evidence: r.evidence ? [r.evidence] : [],
    evidenceLine: r.evidence ?? '',
    evidenceKind: r.evidenceKind ?? '',
    newCrashReports: r.newCrashReports ?? [],
    natives: r.natives ?? null,
    logFile: r.logFile ?? '',
    captureFile: r.captureFile ?? '',
    tail,
    lines,
  };
}

/**
 * GET/POST /launch/preview —— 只算启动计划，绝不启动进程。
 *
 * 这是「两态」里的第一态：先把 classpath、natives、Java 对不对、缺哪些库全摊开给人看，
 * 确认之后再点真启动。命令行原样回给界面，用户可以直接复制到 cmd 里自己验。
 */
export async function handleLaunchPreview(request) {
  const params = await readParams(request);
  const instance = instanceOf(params);
  const p = plan(planOptionsOf(params, instance));
  const { command, commandTruncated } = commandOf(p);

  return {
    ok: true,
    instance: instance.id,
    instanceDir: p.instanceDir,
    mcRoot: p.mcRoot,
    versionId: p.versionId,
    mainClass: p.mainClass,
    java: p.java
      ? { path: p.java.path, version: p.java.version, major: p.java.major, source: p.java.source, warning: p.java.warning ?? '' }
      : null,
    requiredMajor: p.requiredMajor,
    javaMatches: javaMatches(p.java, p.requiredMajor),
    libraries: {
      ...p.stats,
      // 界面要「几个齐 / 几个缺」两个数，stats 里只有总数和缺失清单，这里补齐
      found: Math.max(0, p.stats.total - p.stats.missing.length),
      missing: p.stats.missing,
    },
    classpath: {
      libs: p.classpathLibs,
      entries: p.classpath.length,
      chars: p.classpathChars,
      hasClientJar: p.hasClientJar,
    },
    natives: { wanted: p.nativesWanted, count: p.natives.length, dir: p.nativesDir },
    clientJar: p.clientJar,
    hasClientJar: p.hasClientJar,
    jvmArgCount: p.jvmArgs.length,
    gameArgCount: p.gameArgs.length,
    missingVars: p.missingVars,
    // 界面「真启动」按钮该不该禁用，看这个（中文，可直接显示）
    blockers: blockersOf(p),
    lines: describePlan(p), // 人话报告（数组行）
    command,
    commandTruncated,
  };
}

/**
 * POST /launch/apply —— 真启动。
 *
 * 安全线（别拆）：**默认不启动**，必须显式传 apply: true。
 * 这条在插件侧写过两次注释，用户也认可：会开一个游戏窗口，误点一次很烦。
 */
export async function handleLaunchApply(request) {
  const params = await readParams(request);
  if (boolOr(params.apply, false) !== true) {
    throw new McError(
      '没有真的启动',
      '要真启动必须传 apply: true，这是安全约定（会开一个游戏窗口，约 20 秒到主菜单）',
      'LaunchNeedApply',
    );
  }

  const instance = instanceOf(params);
  const p = plan(planOptionsOf(params, instance));

  // 真启动前先拦两种硬伤 —— 不拦的话 spawn 出去只会拿到一堆无解的 JVM 报错
  const blockers = blockersOf(p);
  if (!p.java) throw new McError(blockers[0], '装一个 JRE 21，或设置 JAVA_HOME，或在参数里指定 javaPath', 'LaunchNoJava');
  if (p.stats.missing.length) {
    throw new McError(
      `有 ${p.stats.missing.length} 个库文件不在磁盘上（${p.stats.missing.slice(0, 3).join(', ')}）`,
      '先用启动器把该实例跑一次让库下全，或确认 mcRoot 指向正确的 Minecraft 根目录',
      'LaunchLibMissing',
    );
  }
  if (!p.hasClientJar) {
    throw new McError(
      `找不到客户端 jar：${p.clientJar}`,
      'Forge/NeoForge 实例通常自带 <实例名>.jar；缺失时先从启动器补齐再试',
      'LaunchNoClientJar',
    );
  }

  const planLines = describePlan(p);
  planLines.push('');
  planLines.push(`── 真启动（超时 ${(Number(params.timeoutMs) || DEFAULT_TIMEOUT_MS) / 1000}s）──`);

  let r;
  try {
    r = await launch(p, { timeoutMs: Number(params.timeoutMs) || DEFAULT_TIMEOUT_MS });
  } catch (error) {
    // 走到这儿说明「启动这件事本身没做成」（日志目录不可写、spawn 抛错等）。
    // 这依然是**业务结论**，不能回 ok:false —— 否则界面只会显示一行 error。
    // 一律落成 status: 'spawn-failed' + summary + suspects，让归因方向和 hint 都能显示出来。
    if (error instanceof McError) {
      const payload = launchResultPayload(
        {
          verdict: { status: 'spawn-failed', summary: error.message, suspects: error.hint ? [error.hint] : [] },
          tail: '',
          logFile: '',
          durationMs: 0,
        },
        { planLines },
      );
      payload.instance = instance.id;
      payload.versionId = p.versionId;
      payload.code = error.code;
      return payload;
    }
    throw error;
  }

  // natives 是启动前才解压出来的，describePlan 里只有「还没建」，这里补一句实话。
  const extraLines = [];
  const extracted = r.natives?.files?.length ?? 0;
  if (extracted) extraLines.push(`natives 已解压：${extracted} 个文件 → ${p.nativesDir}`);
  // 上一次游戏没退干净时 dll 会被占着，沿用了旧文件 —— 这不算错，但要知道不是这次解的
  if (r.natives?.locked?.length) extraLines.push(`有 ${r.natives.locked.length} 个 dll 被占用，沿用了上一次解压出来的那份`);

  const payload = launchResultPayload(r, { tailLines: params.logTailLines, planLines, extraLines });
  payload.instance = instance.id;
  payload.versionId = p.versionId;
  return payload;
}
