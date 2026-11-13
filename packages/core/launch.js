/**
 * 启动一个 Minecraft 实例并判定它是否真的起来了。
 *
 * 整个模块只做四件事，顺序固定：
 *   1. plan()    读版本 json，算出 classpath / natives / 参数（纯计算，绝不启动）
 *   2. dryRun()  plan 的可读报告，打印每条命令，供人确认
 *   3. launch()  spawn JVM，边跑边轮询日志
 *   4. 判定      主菜单证据 / 崩溃 / 超时
 *
 * 设计约束（都是实测逼出来的，见 HANDBOFF §4.9）：
 *   - natives 是**独立 libraries 条目带 classifier**，必须按 OS+arch 精确挑，
 *     x64 Windows 上只认 `natives-windows`，`natives-windows-arm64` / `-x86`
 *     的 rules 也写着 windows，只看 os.name 会把它们全放行 → classpath 虚高。
 *   - 同 artifact 路径会被 NeoForge 与原版各声明一次，必须去重（本包 11 条）。
 *   - `${library_directory}` / `${classpath_separator}` 是 NeoForge 专有占位符，
 *     不替换必然启动失败。
 *   - 启动失败的第一嫌疑是「游戏目录写不进去」，不是 mod 冲突：log4j 起不来时
 *     只会留一行 `Cannot access RandomAccessFile ... logs\latest.log`，然后秒退。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { McError } from './errors.js';
import { collectJavaCandidates, pickJava } from './java.js';
import { extractNatives } from './natives.js';

/** 本机 OS 名，对齐 Mojang 的 rules 命名。 */
function osName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

/** Mojang 的 arch 命名：x86 / x86_64 / arm64。 */
function osArch() {
  const a = process.arch;
  if (a === 'x64') return 'x86_64';
  if (a === 'ia32') return 'x86';
  if (a === 'arm64') return 'arm64';
  return a;
}

/**
 * 判定一组 rules 在本机是否放行。
 *
 * features 一律视为「不满足」：规则里 `features: {is_demo_user: true}` 表示
 * 只有该项为真时才放行，而离线启动这些特性全是 false。
 */
export function rulesAllow(rules, env = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const os = env.os ?? osName();
  const arch = env.arch ?? osArch();
  let allowed = false; // 有 rules 时默认拒绝，靠 allow 打开
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== os) match = false;
      if (r.os.arch && r.os.arch !== arch) match = false;
    }
    if (r.features) {
      // 任一 required feature 为 true 才匹配；离线场景没有一个是 true
      const values = Object.values(r.features);
      if (values.some((v) => v === true)) match = false;
    }
    if (!match) continue;
    allowed = r.action === 'allow';
  }
  return allowed;
}

/**
 * 从 libraries 条目名里取 natives classifier。
 * `org.lwjgl:lwjgl-glfw:3.3.3:natives-windows` → `natives-windows`
 */
function classifierOf(name) {
  const parts = String(name).split(':');
  return parts.length >= 4 ? parts.slice(3).join(':') : '';
}

/** 本机该加载哪个 natives classifier。 */
function wantedNativesClassifier(env = {}) {
  const os = env.os ?? osName();
  const arch = env.arch ?? osArch();
  if (os === 'windows') return arch === 'arm64' ? 'natives-windows-arm64' : arch === 'x86' ? 'natives-windows-x86' : 'natives-windows';
  if (os === 'osx') return arch === 'arm64' ? 'natives-macos-arm64' : 'natives-macos';
  return arch === 'arm64' ? 'natives-linux-arm64' : 'natives-linux';
}

/**
 * 读版本 json 并连同它的目录一起返回。
 * 支持 `inheritsFrom`（Forge 老包会用到）：把父版本合并进来。
 */
function loadVersionJson(instanceDir, versionId, depth = 0) {
  const file = path.join(instanceDir, `${versionId}.json`);
  if (!fs.existsSync(file)) {
    throw new McError(`找不到版本 json：${file}`, '确认传入的是 versions/<实例名> 目录，且 json 与目录同名');
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (json.inheritsFrom && depth < 5) {
    const parentId = json.inheritsFrom;
    const parentDir = path.join(path.dirname(path.dirname(instanceDir)), 'versions', parentId);
    const parent = loadVersionJson(parentDir, parentId, depth + 1);
    return {
      ...parent,
      ...json,
      libraries: [...(parent.libraries ?? []), ...(json.libraries ?? [])],
      arguments: {
        game: [...(parent.arguments?.game ?? []), ...(json.arguments?.game ?? [])],
        jvm: [...(parent.arguments?.jvm ?? []), ...(json.arguments?.jvm ?? [])],
      },
      _parentDir: parentDir,
    };
  }
  return json;
}

/** 参数条目可能是字符串，也可能是 {rules, value}；统一展开成字符串数组。 */
function expandArgEntries(entries, env) {
  const out = [];
  for (const entry of entries ?? []) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      if (!rulesAllow(entry.rules, env)) continue;
      const v = entry.value;
      if (Array.isArray(v)) out.push(...v.map(String));
      else if (typeof v === 'string') out.push(v);
    }
  }
  return out;
}

/**
 * 把 `${x}` 占位符按变量表替换。缺失的变量保留原样并在 `missing` 里报出来，
 * 由上层决定是忽略还是报错（`${resolution_width}` 这类是可选的）。
 */
export function substitute(text, vars) {
  const missing = new Set();
  const out = String(text).replace(/\$\{([a-zA-Z0-9_]+)\}/g, (whole, key) => {
    if (key in vars) return String(vars[key]);
    missing.add(key);
    return whole;
  });
  return { text: out, missing: [...missing] };
}

/** Minecraft 根目录：实例目录的 ../../，或 instances/<名> 的 ../..。 */
function guessMcRoot(instanceDir) {
  // <root>/versions/<id> → <root>
  const versionParent = path.dirname(instanceDir);
  if (path.basename(versionParent) === 'versions') return path.dirname(versionParent);
  return path.dirname(versionParent);
}

/**
 * 算启动计划。纯计算，不碰进程。
 *
 * @param {object} opts
 * @param {string} opts.instanceDir versions/<实例名> 目录
 * @param {string} [opts.mcRoot] Minecraft 根目录（含 libraries/ assets/）
 * @param {string} [opts.javaPath] 显式指定 java
 * @param {string} [opts.username] 离线用户名
 * @param {string} [opts.gameDir] 游戏运行目录（默认实例目录）
 * @param {object} [opts.extraVars] 额外占位符
 * @returns {object} plan
 */
export function plan(opts) {
  const instanceDir = path.resolve(opts.instanceDir);
  if (!fs.existsSync(instanceDir)) {
    throw new McError(`实例目录不存在：${instanceDir}`, '传入 <minecraft 根>/versions/<实例名>');
  }
  const versionId = opts.versionId || path.basename(instanceDir);
  const json = loadVersionJson(instanceDir, versionId);
  const mcRoot = path.resolve(opts.mcRoot || guessMcRoot(instanceDir));
  const gameDir = path.resolve(opts.gameDir || instanceDir);
  const libRoot = path.join(mcRoot, 'libraries');
  const assetsRoot = path.join(mcRoot, 'assets');
  const nativesDir = path.join(instanceDir, `${versionId}-natives`);

  const env = { os: osName(), arch: osArch() };
  const wantedNatives = wantedNativesClassifier(env);

  // ── libraries → classpath / natives ──
  const classpath = [];
  const natives = [];
  const seenArtifact = new Set();
  const stats = { total: 0, skippedByRules: 0, duplicateArtifact: 0, nativesTotal: 0, nativesSelected: 0, nativesSkipped: 0, missing: [] };
  const nativesByClassifier = {};

  for (const lib of json.libraries ?? []) {
    stats.total++;
    if (!rulesAllow(lib.rules, env)) {
      stats.skippedByRules++;
      continue;
    }
    const art = lib.downloads?.artifact;
    if (!art?.path) continue;
    const cls = classifierOf(lib.name);
    if (cls && cls.startsWith('natives-')) {
      stats.nativesTotal++;
      nativesByClassifier[cls] = (nativesByClassifier[cls] ?? 0) + 1;
      if (cls === wantedNatives) {
        stats.nativesSelected++;
        natives.push(path.join(libRoot, art.path));
        if (!fs.existsSync(path.join(libRoot, art.path))) stats.missing.push(art.path);
      } else {
        stats.nativesSkipped++;
      }
      continue;
    }
    if (seenArtifact.has(art.path)) {
      stats.duplicateArtifact++;
      continue;
    }
    seenArtifact.add(art.path);
    const abs = path.join(libRoot, art.path);
    classpath.push(abs);
    if (!fs.existsSync(abs)) stats.missing.push(art.path);
  }

  // 客户端 jar 必须进 classpath —— 那是 Minecraft 本体所在。
  const clientJar = path.join(instanceDir, `${versionId}.jar`);
  const hasClientJar = fs.existsSync(clientJar);
  const cpEntries = hasClientJar ? [clientJar, ...classpath] : [...classpath];

  // ── 占位符变量表 ──
  const sep = process.platform === 'win32' ? ';' : ':';
  const username = opts.username || 'Dev';
  const uuid = '00000000-0000-0000-0000-000000000000';
  const vars = {
    classpath: cpEntries.join(sep),
    classpath_separator: sep,
    library_directory: libRoot,
    natives_directory: nativesDir,
    launcher_name: 'dsh-mc-modpack-studio',
    launcher_version: '0.1.0',
    version_name: versionId,
    version_type: 'release',
    game_directory: gameDir,
    assets_root: assetsRoot,
    assets_index_name: json.assetIndex?.id ?? json.assets ?? '',
    auth_player_name: username,
    auth_uuid: uuid.replace(/-/g, ''),
    auth_access_token: '0',
    auth_xuid: '',
    clientid: '',
    user_type: 'legacy',
    ...(opts.extraVars ?? {}),
  };

  const jvmRaw = expandArgEntries(json.arguments?.jvm, env);
  // 老版本 json 用 minecraftArguments（一整条字符串），新版本用 arguments.game（数组）；
  // 两者不会同时出现在有意义的情形里，但都要能读。
  const legacyGame = json.minecraftArguments ? String(json.minecraftArguments).split(/\s+/).filter(Boolean) : [];
  const gameRaw = [...legacyGame, ...expandArgEntries(json.arguments?.game, env)];

  const missingVars = new Set();
  const expand = (list) =>
    list.map((a) => {
      const r = substitute(a, vars);
      for (const m of r.missing) missingVars.add(m);
      return r.text;
    });

  const jvmArgs = expand(jvmRaw);

  // 离线启动的两个补丁：natives 路径（Forge/NeoForge 的 json 不一定带）与 log4j 配置
  if (!jvmArgs.some((a) => a.startsWith('-Djava.library.path='))) {
    jvmArgs.push(`-Djava.library.path=${nativesDir}`);
  }
  if (!jvmArgs.some((a) => a.startsWith('-Dorg.lwjgl.librarypath='))) {
    jvmArgs.push(`-Dorg.lwjgl.librarypath=${nativesDir}`);
  }

  const gameArgs = expand(gameRaw);

  // ── Java ──
  const requiredMajor = json.javaVersion?.majorVersion ?? 0;
  const candidates = collectJavaCandidates({
    mcRoot,
    instanceDir,
    requiredMajor,
    extra: opts.javaPath ? [opts.javaPath] : [],
  });
  const java = pickJava(candidates, requiredMajor);

  const cpChars = cpEntries.join(sep).length;

  return {
    instanceDir,
    versionId,
    mcRoot,
    gameDir,
    libRoot,
    assetsRoot,
    nativesDir,
    clientJar,
    hasClientJar,
    mainClass: json.mainClass ?? '',
    assetIndex: json.assetIndex?.id ?? json.assets ?? '',
    javaVersionDeclared: json.javaVersion ?? null,
    requiredMajor,
    java,
    javaCandidates: candidates,
    classpath: cpEntries,
    classpathChars: cpChars,
    classpathLibs: classpath.length,
    natives,
    nativesWanted: wantedNatives,
    nativesByClassifier,
    jvmArgs,
    gameArgs,
    vars,
    missingVars: [...missingVars],
    stats,
    sep,
    argv: java ? [java.path, ...jvmArgs, json.mainClass ?? 'net.minecraft.client.main.Main', ...gameArgs] : [],
  };
}

/** 人读的启动计划报告（dry-run 用）。 */
export function describePlan(p) {
  const lines = [];
  lines.push(`实例      ${p.instanceDir}`);
  lines.push(`版本 id   ${p.versionId}   主类 ${p.mainClass}`);
  lines.push(`游戏目录  ${p.gameDir}`);
  lines.push(`资源根    ${p.mcRoot}`);
  lines.push('');
  lines.push(`Java      ${p.java ? `${p.java.path}（${p.java.version}，主版本 ${p.java.major}，来源 ${p.java.source}）` : '未找到'}`);
  if (p.java?.warning) lines.push(`          ⚠️ ${p.java.warning}`);
  lines.push(`声明版本  Java ${p.requiredMajor || '未声明'}`);
  lines.push('');
  lines.push(`libraries 共 ${p.stats.total} 条：`);
  lines.push(`  按 rules 跳过   ${p.stats.skippedByRules}`);
  lines.push(`  重复 artifact   ${p.stats.duplicateArtifact}（NeoForge 与原版各声明一次）`);
  lines.push(`  natives 条目    ${p.stats.nativesTotal}，需要 ${p.nativesWanted} 的 ${p.stats.nativesSelected} 条，排除 ${p.stats.nativesSkipped} 条`);
  const cls = Object.entries(p.nativesByClassifier).sort();
  if (cls.length) lines.push(`  classifier 分布 ${cls.map(([k, v]) => `${k}=${v}`).join(' / ')}`);
  lines.push('');
  lines.push(`classpath   ${p.classpathLibs} 个库 jar${p.hasClientJar ? ' + 1 个客户端 jar' : '（⚠️ 缺客户端 jar）'} = ${p.classpath.length} 项，拼串 ${p.classpathChars} 字符`);
  lines.push(`natives     ${p.natives.length} 个文件 → ${p.nativesDir}`);
  // 只报了「几个 jar」，真正的库文件要等启动前解压才有；这里把当前状态说清楚，
  // 免得看到「磁盘缺失 0」就以为万事俱备。
  try {
    const existing = fs.readdirSync(p.nativesDir).filter((f) => !f.startsWith('.'));
    lines.push(`natives 目录 已解压 ${existing.length} 个文件${existing.length ? '' : '（启动前会自动解压）'}`);
  } catch {
    lines.push('natives 目录 还没建（启动前会自动解压）');
  }
  lines.push(`磁盘缺失    ${p.stats.missing.length} 个${p.stats.missing.length ? `：${p.stats.missing.slice(0, 5).join(', ')}` : ''}`);
  lines.push('');
  lines.push(`JVM 参数    ${p.jvmArgs.length} 条`);
  lines.push(`游戏参数    ${p.gameArgs.length} 条`);
  if (p.missingVars.length) lines.push(`未替换变量  ${p.missingVars.join(', ')}`);
  return lines;
}

/** 完整命令行（用于 dry-run 展示与真正 spawn）。 */
export function commandLine(p) {
  return p.argv;
}

/** 把一条命令渲染成可复制的形式（带引号的规则跟 cmd 一致）。 */
export function renderCommand(argv) {
  return argv
    .map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ');
}

/**
 * 真启动。
 *
 * @param {object} p plan() 的返回值
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 超时（默认 600000，首次启动可能要下资源）
 * @param {number} [opts.settleMs] 判定成功后保持观察的时长（默认 3000）
 * @param {(chunk: string) => void} [opts.onLog] 日志回调（增量，未经缓冲）
 * @returns {Promise<object>} 结果对象
 */
export async function launch(p, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const settleMs = opts.settleMs ?? 3_000;
  if (!p.java) {
    throw new McError('找不到可用的 Java', '装一个 JRE 21，或设置 JAVA_HOME，或在配置里指定 javaPath');
  }
  const startedAt = Date.now();
  const logFile = path.join(p.gameDir, 'logs', 'latest.log');
  const preCrash = listCrashReports(p.gameDir);

  // 目录与日志文件权限预检：这是本机踩过的第一大坑（workspace 沙箱下不可写）
  const writeCheck = checkWritable(path.join(p.gameDir, 'logs'));
  if (!writeCheck.ok) {
    throw new McError(
      `游戏目录的 logs 不可写：${writeCheck.error}`,
      'log4j 起不来会立刻秒退，看起来像崩溃其实只是没权限。换到有写权限的目录，或给工具进程更大权限',
    );
  }

  // natives 必须在 spawn 之前解出来：lwjgl.dll 就在这些 jar 里，
  // 没解压的话 NeoForge 连窗口都画不出来（UnsatisfiedLinkError 秒退）。
  const nativesResult = extractNatives(p.natives, p.nativesDir, { dryRun: opts.dryRun === true });

  // 沙箱不给管道：`spawn(..., { stdio: 'pipe' })` 在这里直接 EPERM。
  // 所以把游戏输出重定向到一个日志文件，再用「读文件新增字节」的方式喂给判定逻辑
  // （等价于原来挂 stdout/stderr 的 data 事件）。
  const captureFile = path.join(p.gameDir, 'logs', 'dsh-launch.log');
  let captureFd = -1;
  try {
    fs.mkdirSync(path.dirname(captureFile), { recursive: true });
    captureFd = fs.openSync(captureFile, 'w');
  } catch (error) {
    throw new McError(
      `建不了启动日志：${error?.message ?? error}`,
      '游戏目录的 logs 不可写，换个有写权限的目录',
      'LaunchNoLog',
    );
  }
  let child;
  try {
    child = spawn(p.java.path, [...p.jvmArgs, p.mainClass, ...p.gameArgs], {
      cwd: p.gameDir,
      stdio: ['ignore', captureFd, captureFd],
      windowsHide: false,
      env: { ...process.env },
    });
  } catch (error) {
    throw new McError(`进程起不来：${error?.message ?? error}`, 'java 路径或参数不对', 'LaunchSpawnFailed');
  } finally {
    // 子进程已经继承了自己的副本
    try {
      fs.closeSync(captureFd);
    } catch {
      /* ignore */
    }
  }

  const state = {
    exitCode: null,
    signal: null,
    error: null,
    sawMainMenu: false,
    evidence: '',
    evidenceKind: '',
    sawOpenAL: false,
    sawLWJGL: false,
    sawAtlas: false,
    tail: '',
    fatal: [],
  };

  const onChunk = (buf) => {
    const text = buf.toString('utf8');
    state.tail = (state.tail + text).slice(-8000);
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      if (/Sound engine started/i.test(line) && !state.sawMainMenu) {
        state.sawMainMenu = true;
        state.evidence = line.trim();
        state.evidenceKind = 'Sound engine started';
      }
      if (/OpenAL initialized/i.test(line)) state.sawOpenAL = true;
      if (/Backend library: LWJGL/i.test(line)) state.sawLWJGL = true;
      if (/Created: .*atlas.*-atlas/.test(line)) state.sawAtlas = true;
      if (/\b(FATAL|Fatal)\b/.test(line) && !/Sound engine started/.test(line)) {
        if (state.fatal.length < 20) state.fatal.push(line.trim());
      }
      opts.onLog?.(line);
    }
  };
  let captureOffset = 0;
  /** 把日志文件里新增的那一段读出来，当成一次 onChunk。 */
  const pumpCapture = () => {
    try {
      const stat = fs.statSync(captureFile);
      if (stat.size <= captureOffset) return;
      const want = Math.min(stat.size - captureOffset, 1 << 20);
      const fd = fs.openSync(captureFile, 'r');
      try {
        const buf = Buffer.alloc(want);
        const read = fs.readSync(fd, buf, 0, want, captureOffset);
        if (read <= 0) return;
        captureOffset += read;
        onChunk(buf.subarray(0, read));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* 文件可能还没落盘 */
    }
  };
  const pumpTimer = setInterval(pumpCapture, 200);
// child.stdout / child.stderr 在这种 stdio 下是 null，别再挂监听

  const done = new Promise((resolve) => {
    child.on('error', (e) => {
      state.error = e;
      resolve();
    });
    child.on('exit', (code, signal) => {
      state.exitCode = code;
      state.signal = signal;
      resolve();
    });
  });

  let timeoutHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }, timeoutMs);

  // 主菜单观察器：看到证据后再稳定 settleMs 才算数（防止因为某行日志误判，
  // 也顺便确认进程没有马上又崩掉）。
  const menuWatcher = new Promise((resolve) => {
    let settleTimer = null;
    const poll = setInterval(() => {
      if (!state.sawMainMenu || settleTimer !== null) return;
      settleTimer = setTimeout(() => {
        clearInterval(poll);
        resolve('menu');
      }, settleMs);
    }, 250);
    // 兜底：进程退出或超时都由 race 覆盖，这里只防 poll 永久悬挂
    setTimeout(() => {
      clearInterval(poll);
      if (settleTimer) clearTimeout(settleTimer);
      resolve('watcher-timeout');
    }, timeoutMs + settleMs + 2_000);
  });

  const outcome = await Promise.race([done.then(() => 'exited'), menuWatcher]);
  clearInterval(pumpTimer);
  pumpCapture(); // 收尾：把最后一段输出也吃掉，判定要看 tail
  clearTimeout(timer);
  if (outcome === 'menu' && state.exitCode === null) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    // 给它一点时间自己收尾，别留僵尸
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
  } else {
    await done;
  }

  const durationMs = Date.now() - startedAt;
  const postCrash = listCrashReports(p.gameDir).filter((f) => !preCrash.includes(f));

  return {
    ...state,
    natives: nativesResult,
    durationMs,
    timeoutHit,
    logFile,
    captureFile,
    newCrashReports: postCrash,
    verdict: judge(state, timeoutHit, durationMs, postCrash),
  };
}

/**
 * 判定：把「看到了什么」翻译成一句结论 + 归因方向。
 * 顺序有意义——先确认外部原因（写了没权限 / 超时），再谈游戏自己的错。
 */
function judge(state, timeoutHit, durationMs, newCrashes) {
  if (state.sawMainMenu) {
    return {
      status: 'ok',
      summary: `启动到主菜单，用时 ${(durationMs / 1000).toFixed(1)}s（证据：${state.evidenceKind}）`,
      suspects: [],
    };
  }
  if (state.error) {
    return { status: 'spawn-failed', summary: `进程起不来：${state.error.message}`, suspects: ['java 路径或参数'] };
  }
  if (timeoutHit) {
    return {
      status: 'timeout',
      summary: `超时未到主菜单（${(durationMs / 1000).toFixed(0)}s）`,
      suspects: ['首次启动要下资源，可加大 timeoutMs', '显卡/OpenGL 初始化卡住', 'mod 在注册阶段死锁'],
    };
  }
  const tail = state.tail;
  const suspects = [];
  if (/Cannot access RandomAccessFile|拒绝访问|Access is denied|Permission denied/.test(tail)) {
    suspects.push('目录写权限（本轮最大嫌疑）');
  }
  if (/MixinPreProcessorException|Mixin apply failed|mixin.*failed/i.test(tail)) {
    suspects.push('mixin 冲突：常见于两个改同一处的 mod（如 iris + sodium + 光影）');
  }
  if (/Failed to locate library|UnsatisfiedLinkError|Failed to load a library/.test(tail)) {
    suspects.push('natives 没解出来（lwjgl.dll 之类找不到）：检查 java.library.path 指向的目录里有没有 dll');
  }
  if (/Missing or unsupported mandatory dependencies|Missing dependency|requires .* which is missing/i.test(tail)) {
    suspects.push('缺少前置 mod');
  }
  if (/Duplicate mods|duplicate mod|already registered/i.test(tail)) {
    suspects.push('同一 mod 装了多个版本');
  }
  if (/Unsupported class file major version|UnsupportedClassVersionError/.test(tail)) {
    suspects.push('Java 主版本不对（Forge/NeoForge 对此非常敏感）');
  }
  if (/java\.lang\.OutOfMemoryError/.test(tail)) {
    suspects.push('内存不足：调大 -Xmx');
  }
  if (newCrashes.length) suspects.push(`新增崩溃报告 ${newCrashes.length} 份`);
  if (suspects.length === 0) suspects.push('日志尾部没有已知特征，需要人工看尾部 40 行');
  return {
    status: 'crashed',
    summary: `进程退出但没到主菜单（exit=${state.exitCode}, signal=${state.signal}）`,
    suspects,
  };
}

/** 列 crash-reports 目录里的文件名。 */
export function listCrashReports(gameDir) {
  const dir = path.join(gameDir, 'crash-reports');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));
  } catch {
    return [];
  }
}

/** 目录可写预检：真的写一个临时文件，不只看 flag。 */
export function checkWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.dsh-write-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
