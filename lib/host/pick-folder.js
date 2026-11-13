/**
 * 弹一个「选文件夹」的原生对话框，拿到真实路径。
 *
 * 为什么要宿主侧做：浏览器里选文件夹（<input type="file" webkitdirectory> 或
 * File System Access API）**拿不到绝对路径**，这是网页的安全限制 —— 只能知道
 * 文件夹叫什么，不知道它在哪个盘下面。而我们要读整合包，必须要完整路径。
 *
 * 所以分两条路，按可靠性排序：
 *
 * 1. Electron 的 dialog.showOpenDialog —— 这是 DSH 桌面版自己的对话框，
 *    最像「原生应用」，还能挂在窗口上。但它只能在主进程用。
 * 2. 退一步 spawn 一个 Windows PowerShell，用 .NET 的 FolderBrowserDialog。
 *    能拿到真实路径，代价是会多一个进程、窗口层级不一定在最前。
 *
 * 两条都拿不到就老实报错，让用户手填路径 —— 不要假装成功。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { McError } from '../../packages/core/errors.js';

/** 对话框标题。 */
export const PICK_TITLE = '选择整合包文件夹';

/** 同一个时间只允许开一个对话框，免得用户连点两下弹出两个。 */
let picking = false;

/** 后台选文件夹的进度，给界面轮询用。 */
const pickState = { status: 'idle', path: '', error: '', hint: '', code: '' };

/**
 * 找 Electron 的 dialog。
 *
 * 注意 `require('electron')` 在纯 Node 里如果装了 electron 这个 npm 包，
 * 返回的是**可执行文件路径字符串**而不是 API 对象。所以必须检查 .dialog。
 */
function defaultLoadElectron() {
  let electron;
  try {
    electron = createRequire(import.meta.url)('electron');
  } catch {
    return null;
  }
  if (!electron || typeof electron.dialog?.showOpenDialog !== 'function') return null;
  return electron;
}

/**
 * 生成 PowerShell 脚本。
 *
 * 几个细节都是踩过才知道的：
 * - 必须 `-STA`，否则 WinForms 的对话框直接抛异常。
 * - 必须设 `[Console]::OutputEncoding`，否则中文路径按 GBK 输出、读回来是乱码。
 * - 用一个最小化的置顶窗体当 owner，对话框才会跑到前面来，不会藏在 DSH 后面。
 * - 取消时不要输出任何东西，用「输出为空」表示取消，比解析文本可靠。
 */
export function pickerScript(title = PICK_TITLE) {
  const safeTitle = String(title).replace(/'/g, "''");
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$owner = New-Object System.Windows.Forms.Form',
    "$owner.FormBorderStyle = 'None'",
    "$owner.StartPosition = 'Manual'",
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    '$owner.Location = New-Object System.Drawing.Point(-4000, -4000)',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.Show()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${safeTitle}'`,
    '$dialog.ShowNewFolderButton = $false',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.SelectedPath)',
    '}',
    '$dialog.Dispose()',
    '$owner.Close()',
    '',
  ].join('\r\n');
}

/** PowerShell 的 -EncodedCommand 吃的是 UTF-16LE 的 base64。 */
export function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/** 用 Electron 的对话框选。返回绝对路径，取消返回 null。 */
async function pickWithElectron(electron) {
  const result = await electron.dialog.showOpenDialog({
    title: PICK_TITLE,
    buttonLabel: '选择这个文件夹',
    properties: ['openDirectory'],
  });
  if (!result || result.canceled) return null;
  const picked = Array.isArray(result.filePaths) ? result.filePaths[0] : '';
  return picked ? String(picked) : null;
}

/** 用 PowerShell 的 FolderBrowserDialog 选。返回绝对路径，取消返回 null。 */
function pickWithPowerShell(spawnImpl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(pickerScript())],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      reject(new McError(`启动选择窗口失败：${error.message}`, '可以直接在输入框里手填整合包路径', 'McPickFolder'));
      return;
    }

    const out = [];
    const err = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      finish(reject, new McError('选择窗口等了太久，已经关掉', '再点一次「选择文件夹」，或者直接手填路径', 'McPickTimeout'));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      finish(reject, new McError(`选择窗口起不来：${error.message}`, '可以直接在输入框里手填整合包路径', 'McPickFolder'));
    });
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8').trim();
      if (text) {
        finish(resolve, text);
        return;
      }
      // 没输出就是用户点了取消。真有错才报错。
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code !== 0 && stderr) {
        finish(reject, new McError(`选择窗口出错：${stderr.split(/\r?\n/)[0]}`, '可以直接在输入框里手填整合包路径', 'McPickFolder'));
        return;
      }
      finish(resolve, null);
    });
  });
}

/**
 * 选一个文件夹。
 *
 * @param {object} [options]
 * @param {string} [options.platform] 平台，测试时可注入
 * @param {() => object|null} [options.loadElectron] 取 Electron API，测试时可注入
 * @param {Function} [options.spawnImpl] spawn 实现，测试时可注入
 * @param {number} [options.timeoutMs] 等多久算超时
 * @returns {Promise<string|null>} 绝对路径；用户取消返回 null
 */
export async function pickFolder(options = {}) {
  const {
    platform = process.platform,
    loadElectron = defaultLoadElectron,
    spawnImpl = spawn,
    timeoutMs = 10 * 60 * 1000,
  } = options;

  if (picking) {
    throw new McError('已经有一个选择窗口开着', '先把它关掉再点一次', 'McPickBusy');
  }
  picking = true;
  try {
    // 1. 先试 Electron 的对话框（桌面版就是这条路）
    let electron = null;
    try {
      electron = loadElectron();
    } catch {
      electron = null;
    }
    if (electron) return await pickWithElectron(electron);

    // 2. 退到 PowerShell（Windows 一定能用）
    if (platform === 'win32') return await pickWithPowerShell(spawnImpl, timeoutMs);

    // 3. 都不是就老实说不行
    throw new McError(
      '这个环境里弹不出系统选文件夹对话框',
      '直接在输入框里粘贴整合包路径就行，例如 D:\\pcl2\\PCL 下载\\整合包\\xxx\\versions\\yyy',
      'McPickUnsupported',
    );
  } finally {
    picking = false;
  }
}

/** 测试用：清掉「正在选」的状态。 */
export function resetPickFolderState() {
  picking = false;
  pickState.status = 'idle';
  pickState.path = '';
  pickState.error = '';
  pickState.hint = '';
  pickState.code = '';
}

// ---------------------------------------------------------------- 后台选文件夹
//
// 为什么不在一个请求里等结果：用户可能把对话框开着去翻半分钟目录，
// 而 HTTP 请求挂着等有超时风险（Node 的 server.requestTimeout 默认就是 5 分钟）。
// 所以拆成两步：/pick-folder 立刻返回「开始选了」，界面再轮询 /pick-folder/status。

/**
 * 开始选文件夹，立刻返回，不等用户选完。
 * @returns {{started: boolean}} started=false 表示已经有一个在选了
 */
export function beginPickFolder(options = {}) {
  if (pickState.status === 'picking') return { started: false };
  pickState.status = 'picking';
  pickState.path = '';
  pickState.error = '';
  pickState.hint = '';
  pickState.code = '';

  pickFolder(options).then(
    (picked) => {
      pickState.status = 'idle';
      pickState.path = picked ?? '';
    },
    (error) => {
      pickState.status = 'failed';
      pickState.error = error instanceof Error ? error.message : String(error);
      pickState.hint = error instanceof McError ? (error.hint ?? '') : '';
      pickState.code = error instanceof McError ? (error.code ?? 'McError') : 'McError';
    },
  );
  return { started: true };
}

/** 当前选文件夹的进度。 */
export function pickFolderStatus() {
  return { ...pickState };
}
