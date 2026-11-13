/**
 * 完整性标签（Mandatory Label）检测 —— 只记录线索，不下因果结论，也不再给修法。
 *
 * ## 背景（2026-11-10~11 观察；低标签与白纸箭头相关，但因果未定案）
 *
 * exe 在资源管理器里有图标（工作台），可快捷方式只显示一个「白纸 + 蓝箭头」的
 * 通用图标。查下来不是我们写的 .lnk 有毛病：
 *
 * - 正规 COM（IShellLinkW）生成的 .lnk 也一样是白纸箭头，连指向记事本都一样；
 * - 桌面上的 Hermes.lnk / Obsidian.lnk / DeepSeek.lnk 三个「原位」文件正常；
 * - 用 `win32security.GetFileSecurity(..., LABEL_SECURITY_INFORMATION)` 读 SACL：
 *   桌面上那三个**没有完整性标签**，而我们写出来的文件（连同它们所在的整个目录树）
 *   都带 **`Mandatory Label\Low Mandatory Level`（sid S-1-16-4096，低完整性）**。
 *
 * 低标签与「白纸箭头」只是**相关**，因果一直没定案：微软 MIC 文档说高完整性进程
 * 读低完整性文件是允许的，而低完整性进程里所有 shell 图标 API 都测不准。
 *
 * ## 2026-11-11 收口：提级修法已被三轮实测证伪，全部删除
 *
 * 曾经据低标签在打包时打印 icacls 提级命令，用户按提示在普通终端跑了三轮，
 * 实测**全部无效**：根目录 /T 一遇上传目录「拒绝访问」就停；单独提级 dist 时
 * 33 个目录全「拒绝访问」（目录没改成 medium，新建文件仍继承 low）；
 * build.mjs 又会先清掉上次产物，把刚提级好的目录删了重建；改标签还需管理员特权。
 * 在桌面用「新建快捷方式」向导也直接报「显示无法创建」。
 * ⇒ 修法属误导，已删除；本机既验不准因果也改不动，这条线到此收口，不需要用户做任何操作。
 *
 * 本模块保留 probeIntegrity() 读标签作为诊断（tryRaiseIntegrity() 仍在、打包流程已不调用）；build.mjs 只打印一句中性说明，
 * 不再调用提级函数、也不再打印任何命令（提级修法已证伪删除）。
 *
 * ## 为什么读标签要绕一圈 PowerShell
 *
 * 标签在 SACL 里，Node 没有读 SACL 的 API。`icacls` 会把标签那一行打印出来，
 * 所以这里让 PowerShell 跑一次 `icacls`，把输出**写进文件**再读回来 ——
 * 这个沙箱里捕获子进程 stdout 会被拦（EPERM），写文件是唯一稳的路子。
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * 从 `icacls` 的输出里认出完整性标签等级。
 *
 * 认得出来的三种：low（低）/ medium（中）/ high（高）。
 * 输出里根本没有 Mandatory Label 那一行 → 'none'（没有标签，默认按 medium 处理）。
 * 其它情况 → 'unknown'（看不懂就别乱说）。
 *
 * @param {string} text `icacls` 的输出文本
 * @returns {'low'|'medium'|'high'|'none'|'unknown'}
 */
export function parseIntegrityLabel(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return 'unknown';
  // 英文系统上长这样：Mandatory Label\Low Mandatory Level:(I)(NW)
  // 中文系统上是「强制标签\低强制级别」，两边都兜住。
  if (/Mandatory Label[\\/]Low Mandatory Level|低强制级别|强制标签[\\/]低/i.test(raw)) return 'low';
  if (/Mandatory Label[\\/]Medium Mandatory Level|中强制级别/i.test(raw)) return 'medium';
  if (/Mandatory Label[\\/]High Mandatory Level|高强制级别/i.test(raw)) return 'high';
  // 「没有 Mandatory Label 这一行」和「有但没认出来」是两回事，别混。
  if (!/Mandatory Label|强制标签/i.test(raw)) return 'none';
  return 'unknown';
}

/** PowerShell 脚本正文里塞一个 UTF-8 字符串（脚本正文保持纯 ASCII）。 */
function psBase64(value) {
  const b64 = Buffer.from(String(value ?? ''), 'utf8').toString('base64');
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`;
}

/**
 * 生成「读 icacls 输出」的 PowerShell 脚本。
 *
 * 输出被写进 outFile（而不是 stdout）—— 沙箱里捕获子进程 stdout 会被拦。
 */
export function buildIntegrityProbeScript(filePath, outFile) {
  return [
    '$ErrorActionPreference = "Continue"',
    `$p = ${psBase64(filePath)}`,
    `$o = ${psBase64(outFile)}`,
    '& icacls.exe $p | Out-File -FilePath $o -Encoding ascii',
    'exit 0',
  ].join('\r\n');
}

/**
 * 生成「提升完整性标签到 Medium」的 PowerShell 脚本。
 *
 * 2026-11-11 收口后打包流程已不再调用它（提级修法被三轮实测证伪）；保留纯函数仅供测试与诊断，不打印、不执行。
 */
export function buildIntegrityRaiseScript(filePath) {
  return [
    '$ErrorActionPreference = "Continue"',
    `$p = ${psBase64(filePath)}`,
    '& icacls.exe $p /setintegritylevel M | Out-Null',
    'exit $LASTEXITCODE',
  ].join('\r\n');
}

/** 用 -EncodedCommand 跑一段 PowerShell（命令体是 base64 的 UTF-16LE，绕开引号转义）。 */
function runPowerShell(script) {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { stdio: 'ignore' },
  );
  return { status: result.status ?? null, error: result.error?.message ?? '' };
}

/**
 * 读一个文件的完整性标签等级。
 *
 * @param {string} filePath 要查的文件
 * @param {string} outFile  icacls 输出的落地文件（调用方给，一般放临时目录）
 * @returns {{level: 'low'|'medium'|'high'|'none'|'unknown', ok: boolean, note: string}}
 */
export function probeIntegrity(filePath, outFile) {
  try {
    fs.rmSync(outFile, { force: true });
  } catch {
    /* 删不掉旧文件不算事，下面照样会重写 */
  }
  const run = runPowerShell(buildIntegrityProbeScript(filePath, outFile));
  let text = '';
  try {
    text = fs.readFileSync(outFile, 'utf8');
  } catch {
    text = '';
  }
  try {
    fs.rmSync(outFile, { force: true });
  } catch {
    /* 临时文件删不掉就算了，不影响判断 */
  }
  if (!text.trim()) {
    return {
      level: 'unknown',
      ok: false,
      note: run.error ? `icacls 跑不起来：${run.error}` : 'icacls 没给出输出',
    };
  }
  return { level: parseIntegrityLabel(text), ok: true, note: '' };
}

/**
 * 尽力把文件的完整性标签提到 Medium。
 *
 * @returns {{ok: boolean, status: number|null, note: string}}
 */
export function tryRaiseIntegrity(filePath) {
  const run = runPowerShell(buildIntegrityRaiseScript(filePath));
  if (run.status === 0) return { ok: true, status: 0, note: '' };
  return {
    ok: false,
    status: run.status,
    note: run.error
      ? `提升标签的命令跑不起来：${run.error}`
      : '提升标签的命令失败（多半是当前进程完整性级别太低，不允许提升）',
  };
}

/**
 * 给用户看的一段中性说明：只陈述「带低标签、可能影响图标观感」，不给任何命令。
 *
 * @param {{label: string, filePath: string}} info
 */
export function integrityNotice(info) {
  const { label, filePath } = info ?? {};
  if (label !== 'low') return '';
  const lines = [
    '⚠ 这个快捷方式在资源管理器里可能显示成「白纸 + 蓝箭头」（不是 .lnk 写错了，也不是 exe 图标资源的问题）',
    `  文件：${filePath}`,
    '  观察：它带着「低完整性标签」（Mandatory Label\\Low Mandatory Level，与白纸箭头相关，因果未定案）。',
    '  这是受限环境的产物，只影响图标观感，不影响软件能否打开。',
    '  exe 本身有图标（工作台），所以看起来像「只有快捷方式没图标」。',
  ];
  lines.push('  图标问题已收口：曾经给的提级命令经三轮实测无效，已删除，不再让你跑任何命令。');
  lines.push('  低标签只是受限环境里量到的相关量，本机既验不准因果、也改不动标签。');
  lines.push('  这只影响图标观感，不影响软件能不能打开。');
  lines.push('  低标签与白纸箭头只是相关，因果未定案，已不再据此给任何修法。');
  lines.push('  这条线到此收口，不需要你做任何操作。');
  lines.push('  （本函数只做说明，不做任何写操作。）');
  return lines.join('\n');
}
