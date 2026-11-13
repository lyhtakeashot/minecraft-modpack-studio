/**
 * 启动方式的三件套：降级链、启动.cmd、桌面快捷方式。
 *
 * ## 为什么单独拎出来
 *
 * 这三样都是「字符串拼装 + 一堆踩过坑的约定」，混在 build.mjs 里
 * 会被下一次改包悄悄改坏。所以抽成纯 Node 模块：**能单测**。
 *
 * ## 最重要的一条实测（2026-11-02 第十一次排查）
 *
 * 这台机器（以及用户的机器）上，Electron **不带 `--no-sandbox` 就直接崩**：
 *
 * ```
 * mcstudio.exe --safe-mode              → exit -2147483645 (0x80000003)，一行日志都没写
 * mcstudio.exe --no-sandbox             → 活着，但 20 秒后渲染进程崩
 * mcstudio.exe --safe-mode --no-sandbox → 活着，页面加载完成
 * ```
 *
 * 「一行日志都没写」是关键：**崩溃发生在 Electron 原生启动阶段，比我们的 JS 还早**。
 * 用 `lab/_probe-early.cjs`（第一行就写标记文件、再 require('electron')）验证过：
 * 不带 `--no-sandbox` 时标记文件根本不生成，说明 JS 一行都没跑。
 *
 * 所以 `main.mjs` 里那句 `app.commandLine.appendSwitch('no-sandbox')` **救不了场** ——
 * 它生效的时候崩溃早就发生了。真正的解法是**从命令行层面就必须带 `--no-sandbox`**：
 * 快捷方式的参数里带、`启动.cmd` 的降级链里带。
 */

/**
 * 降级链：一次不行换下一种，直到有一种能起来。
 *
 * 每一档都比上一档更保守：
 * 1. `plain` —— 什么都不加。正常的机器用这一档最快（GPU 加速在）。
 * 2. `safe` —— 关硬件加速 + 关 sandbox。实测唯一稳定能活的一档。
 * 3. `safe-single` —— 再加单进程模式。给那些 sandbox 也不让过的环境兜底。
 */
export const LAUNCH_ATTEMPTS = [
  { label: 'plain', flags: [] },
  { label: 'safe', flags: ['--safe-mode', '--no-sandbox'] },
  { label: 'safe-single', flags: ['--safe-mode', '--no-sandbox', '--single-process', '--in-process-gpu'] },
];

/**
 * 桌面快捷方式用的参数。
 *
 * 为什么不留空：空参数就是 `plain` 档，在这台机器上必崩（见文件头）。
 * 为什么固定带 `--safe-mode`：这台机器的普通模式（硬件加速开着）实测 12 秒后
 * 也会崩，而软件渲染这一档从 20:34 到现在一直稳定。
 *
 * 代价是软件渲染，界面会略慢 —— 对一个表单式的工具完全可以接受。
 */
export const SHORTCUT_ARGS = '--safe-mode --no-sandbox';

/**
 * 生成 `启动.cmd` 的内容。
 *
 * ⚠ 内容必须**纯 ASCII**：cmd.exe 按 GBK/ANSI 读 .cmd 文件，
 * UTF-8 写出来的中文会变乱码，用户双击报「Windows 找不到文件 '...乱码....exe'」。
 * 打包当场会自检（`isAsciiOnly`），混进非 ASCII 直接让打包失败。
 *
 * exe 文件名不写死，用 for 通配符抓目录里那个唯一的 .exe ——
 * 中文名 exe 在代码页 936 下 cmd 会静默拒绝执行（退码 0、毫无反应）。
 */
export function buildLaunchCmd() {
  const lines = [
    '@echo off',
    'rem Clear ELECTRON_RUN_AS_NODE so the exe runs as real Electron (see shuo-ming.txt).',
    'set ELECTRON_RUN_AS_NODE=',
    'rem Trace: prove this cmd really ran and record the env value it sees.',
    'echo cmd ran at %DATE% %TIME%, ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%]>"%~dp0cmd-trace.txt"',
    'cd /d "%~dp0"',
    'set "EXE="',
    'for %%f in ("*.exe") do set "EXE=%%f"',
    'if not defined EXE (',
    '  echo [ERROR] exe not found in this folder.',
    '  echo [ERROR] exe not found.>>"%~dp0cmd-trace.txt"',
    '  pause',
    '  exit /b 1',
    ')',
    'rem Trace the exe name we picked and launch with explicit cd (start inherits cwd).',
    'echo picked EXE=[%EXE%]>>"%~dp0cmd-trace.txt"',
    'rem Fallback chain: if the plain mode crashes (GPU / sandbox-like limits),',
    'rem retry with --safe-mode --no-sandbox; if that crashes too, retry with --single-process.',
    'rem Every attempt and its exit code goes into cmd-trace.txt.',
    'setlocal EnableDelayedExpansion',
    'set "ATTEMPT=1"',
    ':retry',
  ];
  LAUNCH_ATTEMPTS.forEach((attempt, index) => {
    lines.push(`if "%ATTEMPT%"=="${index + 1}" set "FLAGS=${attempt.flags.join(' ')}"`);
  });
  lines.push(
    'echo attempt %ATTEMPT% flags=[%FLAGS%]>>"%~dp0cmd-trace.txt"',
    '"%EXE%" %FLAGS%',
    'set "RC=!ERRORLEVEL!"',
    'echo attempt %ATTEMPT% exit code !RC!>>"%~dp0cmd-trace.txt"',
    `if "%ATTEMPT%"=="${LAUNCH_ATTEMPTS.length}" goto :done`,
    'if "!RC!"=="0" goto :done',
    'set /a ATTEMPT+=1',
    'goto :retry',
    ':done',
    'echo final exit code !RC!>>"%~dp0cmd-trace.txt"',
    '',
  );
  return lines.join('\r\n');
}

/** cmd 内容里混进非 ASCII 字符就是致命的（cmd.exe 按 GBK 读会乱码）。 */
export function isAsciiOnly(text) {
  return !/[^\x00-\x7F]/.test(text);
}

/**
 * 生成创建快捷方式的 PowerShell 脚本（纯 ASCII）。
 *
 * 为什么用 PowerShell 而不是自己拼 .lnk 二进制：Shell Link 文件格式是二进制，
 * 手拼容易错（少一个 CLSID 就变成「无效的快捷方式」），而 `WScript.Shell`
 * 是 Windows 自带的、天天在用的那套。
 *
 * ⚠ 路径里可能有中文（项目装在中文目录下的机器很常见），所以**路径一律用
 * base64 传**：脚本正文里放 base64，运行时用 .NET 解回 UTF-8。
 * 这样脚本正文永远是纯 ASCII，不会再撞上「PowerShell 读 UTF-8 中文乱码」。
 */
export function buildShortcutScript(spec) {
  const {
    linkPath,
    targetPath,
    args = '',
    iconPath = '',
    workingDir = '',
    description = 'Minecraft 整合包工作室（桌面版）',
  } = spec;
  return [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    `$link = $shell.CreateShortcut(${psBase64(linkPath)})`,
    `$link.TargetPath = ${psBase64(targetPath)}`,
    `$link.Arguments = ${psBase64(args)}`,
    `$link.WorkingDirectory = ${psBase64(workingDir)}`,
    `$link.Description = ${psBase64(description)}`,
    `$link.IconLocation = ${psBase64(iconPath)}`,
    '$link.Save()',
  ].join('\r\n');
}

/**
 * PowerShell 脚本正文里的「一个 UTF-8 字符串」——
 * 用 base64 传，脚本正文保持纯 ASCII。
 */
function psBase64(value) {
  const b64 = Buffer.from(String(value ?? ''), 'utf8').toString('base64');
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`;
}

/**
 * 跑脚本的命令行。
 *
 * 用 `-EncodedCommand`：命令体是 base64 的 UTF-16LE，
 * **完全绕开引号转义**——路径里有中文、有空格、有 & 都不会出事。
 */
export function shortcutSpawnPlan(script) {
  return {
    file: 'powershell',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  };
}
