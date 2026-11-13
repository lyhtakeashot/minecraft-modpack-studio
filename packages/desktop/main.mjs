/**
 * 桌面版主进程（Electron）。
 *
 * 桌面版是本项目唯一的形态：把界面、接口、核心逻辑全塞进一个 exe 里，
 * 双击就出窗口，用户不需要装 Node、不需要知道「界面从哪来」。
 *
 * ## 三个关键决定
 *
 * 1. **界面走自定义协议 `mcstudio://app/`，不走 HTTP。**
 *    `protocol.js` 直接把 `mcstudio://app/...` 翻译给
 *    `lib/host/api.js` 的 dispatchStudioRequest，没有网络层、不占端口、
 *    不需要防火墙允许。
 *
 * 2. **窗口加载 `mcstudio://app/`。**
 *    界面代码里的 fetch 全是相对路径，协议注册了 `standard: true +
 *    supportFetchAPI: true` 之后，origin 和 fetch 都跟在 http 下一样用。
 *
 * 3. **必须用 `require('electron')` 拿 API，不能写 ESM 具名导入。**
 *    Electron 的内建模块是 CJS。`import { app } from 'electron'` 会在模块加载期抛
 *    `SyntaxError: The requested module 'electron' does not provide an export named 'app'`
 *    —— 这是加载期错误，try/catch 拦不住，整个进程直接死。
 *    动态 `import('electron')` 能成功，但 `default` 上什么属性都没有（Electron 38 实测）。
 *    只有 `createRequire(import.meta.url)('electron')` 能拿到完整 API。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCHEME_PRIVILEGES, handleProtocolRequest, appUrl } from './protocol.js';
import { prepareEnvironment } from './preflight.js';
import {
  clearBootStarted,
  markBootStarted,
  markSafeModeWorks,
  planStartup,
  readBootState,
} from './boot-state.js';
import { boundsOnScreen, planWindowReveal } from './window-focus.js';

/**
 * 【最早期保命检测】这个进程真的是 Electron 吗？
 *
 * ## 为什么（2026-11-01 用户第五次报「还是打不开」）
 *
 * 如果环境里有 `ELECTRON_RUN_AS_NODE=1`（某些软件会全局注入这个变量），
 * 这个 exe 会把自己**当成普通 Node** 运行：`require('electron')` 直接抛错、
 * 我们的代码一行都不执行、不写日志、无崩溃报告 —— 双击表现就是「一闪而过，
 * 什么痕迹都没有」。实测用户场景与此完全吻合。
 *
 * 所以在一切其它逻辑之前，先问一句 `process.versions.electron`：
 * - 有值 = 真的跑在 Electron 里，正常往下走；
 * - 没值 = 被当 Node 跑了，往 exe 旁边写一个「被当Node跑.txt」说明原因
 *   （这是用户能拿到的唯一痕迹），然后退出。
 *
 * 注意：这个文件被当 Node 跑时，ESM 的 import 还是会先执行 —— import 的都是
 * node 内建模块和项目文件，不碰 electron，所以能活到这里。
 */
if (!process.versions.electron) {
  try {
    fs.appendFileSync(
      path.join(path.dirname(process.execPath), '被当Node跑.txt'),
      `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 这个 exe 被当成普通 Node 运行了（环境变量 ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE ?? '（空）'}）。\r\n` +
      `解决办法：右键「启动.cmd」→ 编辑，确认第一行有 set ELECTRON_RUN_AS_NODE=；或者重启电脑清掉残留变量。\r\n`,
      'utf8',
    );
  } catch { /* 写不了就算了 */ }
  process.exit(9);
}

const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, shell, Menu, screen, protocol } = require('electron');

/**
 * 协议特权注册：**必须赶在 app ready 之前**，晚了静默无效 ——
 * 页面里的 fetch 就会全部失败，而且没有任何报错。
 */
try {
  protocol.registerSchemesAsPrivileged([SCHEME_PRIVILEGES]);
} catch {
  // 重复注册会抛（比如测试里模块被加载两次），忽略即可
}

/** protocol.handle 的第一个参数：只要 scheme 名，不带 privileges 包装。 */
const SCHEME_NAME = SCHEME_PRIVILEGES.scheme;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 命令行参数（Electron 会把 exe 之后的东西原样带过来）。
 *
 * 放在最前面是因为下面 `disableHardwareAcceleration` 就要用它 —— 那个调用
 * 必须在 app ready 之前完成，晚一步就没效果了。
 */
const ARGV = process.argv.slice(1);

/** 从命令行里取 `--xxx value` 或 `--xxx=value`。 */
function cliValue(argv, key, fallback) {
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === `--${key}` && i + 1 < argv.length) return argv[i + 1];
    if (item.startsWith(`--${key}=`)) return item.slice(key.length + 3);
  }
  return fallback;
}

/**
 * 安全模式：`整合包工作室.exe --safe-mode`
 *
 * ## 为什么要有（2026-11-01 用户第三次报「还是打不开」）
 *
 * 窗口能不能画出来，很大程度取决于显卡驱动 / 硬件加速 / 远程桌面这些东西。
 * 这些我在这边复现不了 —— 我这台机器的失败和用户那台未必是同一个原因。
 *
 * 所以给一个「把所有花活都关掉」的入口：不碰 GPU、不合成、用软件渲染。
 * 如果安全模式能开、正常模式不能开，那就是显卡这一路的问题，用户至少能先用起来。
 *
 * ## 自动记忆（2026-11-01 第六次排查收官后加）
 *
 * 用户的机器实测：普通模式必崩（0x80000003，GPU 硬件加速不兼容），安全模式稳定。
 * 原来的办法是让用户永远走 启动.cmd（它崩了会自动换 --safe-mode 重试）。
 * 但 cmd 脚本对用户是个负担（黑框、闪一下、不知道是什么）。
 *
 * 所以改成：**进程退出时如果这次是「安全模式成功」，就往用户数据目录写一个
 * 标记文件**；下次启动时模块顶层发现标记存在 → 直接按安全模式起，用户双击
 * exe（或快捷方式）就行，不再依赖 cmd。`--safe-mode` 参数依然有效（覆盖一切）。
 *
 * **必须在 app ready 之前调用**，所以放在模块顶层（不是放进 whenReady）。
 */
const SAFE_MODE_ARG = ARGV.includes('--safe-mode');
/** 逃生门：`--no-safe-mode` 强制按普通模式起（无视标记）。换了显卡/修好驱动后用这个试回普通模式。 */
const FORCE_PLAIN = ARGV.includes('--no-safe-mode');

/**
 * exe 所在目录。痕迹文件和标记文件都放这儿（用户数据目录此刻还没选出来，
 * exe 旁边一定能写 —— 用户能解开压缩包就能写）。
 */
const EXEC_DIR = path.dirname(process.execPath);

/**
 * 「这次启动还没走到加载完成」的痕迹文件。
 *
 * ## 为什么需要（2026-11-02 用户报「快捷方式还是打不开」，第七次）
 *
 * 安全模式标记只在**安全模式成功过一次之后**才有。新打出来的包里它不存在，
 * 于是用户第一次双击一定按普通模式起、一定崩（0x80000003），
 * 而崩溃那一瞬间来不及写任何标记 —— 下次双击还是普通模式、还是崩。
 * 除非用户去双击 启动.cmd（它崩了会自动换 --safe-mode 重试），
 * 但用户明确说过不想用黑框。
 *
 * 所以改成：**启动一开始就写这个痕迹，页面加载成功就删掉。**
 * 下次启动如果发现痕迹还在，说明上次没开成（多半是崩在上面说那条路上）
 * → 自动改走安全模式。这样用户只要双击第二次就能进去，不必懂任何参数。
 *
 * ## 痕迹只由「真正要开窗口的那个进程」写（2026-11-02 第十次排查）
 *
 * 拿不到单实例锁的进程（用户又双击了一次）**不许**写痕迹 —— 否则它一声不响
 * 退出后留下的痕迹还在原地，用户下次双击会被误判成「上次崩过」，白白进安全模式。
 * 写痕迹的动作由 `planStartup()` 决定，见文件末尾的单实例分支。
 */

/** 启动痕迹与安全模式标记的现状（读一次就够）。 */
const BOOT_STATE = readBootState(EXEC_DIR);

/** 痕迹存在 = 上次启动没走到「页面加载完成」。 */
const PREVIOUS_BOOT_CRASHED = BOOT_STATE.pending;

/**
 * 是不是「这台机器只吃安全模式」。
 *
 * ## 为什么必须重新算一遍（2026-11-02 用户报「快捷方式还是打不开」，第九次）
 *
 * 上面那个 `SAFE_MODE_ARG` 只是**命令行里有没有这个参数**，不是「这次实际按安全模式跑」。
 * 而自动切安全模式的分支在下面，它只是往 `ARGV` 里 push 一个
 * `--safe-mode` —— 那个时刻 `SAFE_MODE` 这个 const 已经算完、而且是 const，
 * **后面的代码读到的还是 false**。
 *
 * 结果就是：自动降级这条路的 `if (SAFE_MODE)` 块**从来没执行过** ——
 * 硬件加速没关、sandbox 没关、标记也没写。用户双击 → 崩 → 下次还是崩，
 * 而代码看上去「明明有自动降级逻辑」。
 *
 * 所以这里重新按「最终参数」算一次，后面一律用这个值。
 */
const SAFE_MODE = SAFE_MODE_ARG
  || (!FORCE_PLAIN && (PREVIOUS_BOOT_CRASHED || BOOT_STATE.safeStamp));

if (!SAFE_MODE_ARG && !FORCE_PLAIN && SAFE_MODE) {
  // 要么上次崩过，要么这台机器已知只吃安全模式：直接按安全模式走。
  // 不弹提示不打日志（日志系统还没起来），安静地用能活的方式启动。
  ARGV.push('--safe-mode');
}

if (SAFE_MODE) {
  try {
    app.disableHardwareAcceleration();
  } catch {
    // 老版本 Electron 没这个方法，忽略即可
  }
  // 软件渲染 + 关掉 GPU 合成相关的开关。这些是 chromium 的开关名，改名对不上就静默无效。
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('in-process-gpu');

  /**
   * 安全模式必须连 `--no-sandbox` 一起上。
   *
   * ## 为什么（2026-11-02 用户报「这里的快捷方式打不开应用」，第八次）
   *
   * 逐项实测出来的矩阵（判据：进程活没活 + 启动日志有没有新增行）：
   *
   *   --safe-mode                      → 秒退，退出码 -2147483645（0x80000003）
   *   --safe-mode --no-sandbox         → 活着，日志继续写      ✅
   *   --single-process --no-sandbox    → 活着
   *   --no-sandbox                     → 活着
   *
   * 也就是说：**只给 `--safe-mode` 反而必崩**，而 `启动.cmd` 的第二级是
   * `--safe-mode --no-sandbox`（能活）—— 两者差的就是这个 no-sandbox。
   *
   * 更糟的是这里原本只 append `--safe-mode`（见上面 154 行那个分支），
   * 于是「双击 exe / 双击快捷方式」走的是必崩那条路，而用户眼里就是
   * 「快捷方式怎么点都没反应」—— 进程崩在日志系统起来之前，一行证据都没有。
   *
   * 所以：进安全模式就顺手把 sandbox 关掉。它本来就是「这台机器的正常配置
   * 跑不起来」时的兼容档，不是日常档；换显卡/修驱动后用 --no-safe-mode 回普通模式。
   */
  app.commandLine.appendSwitch('no-sandbox');
}

/**
 * 命名管道探测：判断这台机器允不允许 Chromium 开它的进程间通信管道。
 *
 * ## 为什么要有（2026-11-01 用户第四次报「还是没有打开成功」）
 *
 * Chromium 是多进程架构，主进程和渲染进程之间靠**命名管道**（mojo invitation）
 * 通信。某些受限环境（实测：这台开发机，包括用户双击资源管理器里 exe 的场景）
 * **直接禁止程序创建命名管道**，Electron 一启动就撞死：
 *   FATAL:mojo\public\cpp\platform\platform_channel.cc:82] Check failed: 拒绝访问 (0x5)
 * 退出码 0x80000003，崩得比任何日志都早，四轮修复全部无效 —— 因为这不是代码的错。
 *
 * Chromium 给了逃生门：`--single-process`（整个程序只跑一个进程，不需要管道）。
 * 但正常电脑上不该用它（性能差、稳定性差），所以**运行时探测**：
 * 先真的试着建一个命名管道，建得出来就走正常多进程；建不出来自动切单进程。
 */
function canCreateNamedPipe() {
  try {
    // 探测用的管道名带随机后缀，避免和任何真服务撞车；用完立刻关。
    const name = `\\\\.\\pipe\\mcstudio-probe-${process.pid}-${Date.now()}`;
    const server = require('node:net').createServer();
    return new Promise((resolve) => {
      const done = (ok) => {
        try { server.close(); } catch { /* 关不掉就算了 */ }
        resolve(ok);
      };
      // 1.5 秒拿不到结果就当不允许（宁可误判成受限环境，也不能卡死启动）
      const timer = setTimeout(() => done(false), 1500);
      server.once('error', () => { clearTimeout(timer); done(false); });
      server.listen(name, () => { clearTimeout(timer); done(true); });
    });
  } catch {
    return Promise.resolve(false);
  }
}

const PIPE_OK = await canCreateNamedPipe();
if (!PIPE_OK) {
  // 单进程 + 软件渲染组合，是受限环境下的「最小生存配置」
  app.commandLine.appendSwitch('single-process');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('no-sandbox');
}

/**
 * 把「管道探测结果」先落到文件里 —— 这是整个启动流程**最早**的一批日志。
 *
 * ## 为什么（2026-11-01 用户第四次报「还是没有打开成功」）
 *
 * 用户双击后连启动日志都没有：如果进程崩在 BOOT 日志建好之前
 * （比如 preflight 选目录全失败、或更早），现有日志一行都留不下。
 * 所以这里用最原始的 fs.appendFileSync 直写 exe 旁边一个「管道探测.txt」，
 * 不依赖任何目录选择 —— 哪怕后面全崩了，也能知道程序至少跑到了这一步、
 * 探测结果是什么。文件很小（几行），不影响任何功能。
 */
try {
  const exeDir = path.dirname(process.execPath);
  const probeNote = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 管道探测：${PIPE_OK ? '通过（正常多进程）' : '不通过（切单进程模式）'}`;
  fs.appendFileSync(path.join(exeDir, '管道探测.txt'), probeNote + '\r\n', 'utf8');
} catch {
  // 写不了就算了，后面正式日志再兜
}

/**
 * 启动预检：**必须在 `app.whenReady()` 之前**挑好用户数据目录。
 *
 * ## 为什么（2026-11-01 用户报「双击打不开」，排查了两个小时）
 *
 * Electron 的用户数据目录（默认 `%APPDATA%\<productName>`）如果建不出来，
 * 它**不会报错，直接以 `0xC0000005` 访问冲突崩掉**，而且崩得比任何日志都早 ——
 * 用户看到的就是「双击了，什么都没发生」，我们这边一个字也拿不到。
 *
 * 实测：这台机器的 `%APPDATA%` 根本不让新建目录（`对路径"整合包工作室"的访问被拒绝`），
 * 所以默认路径必然失败、必崩。而只要在 `whenReady` 之前把 `userData` 指到一个
 * 真能写的地方，同样的代码就能正常出窗口。
 *
 * 所以：先探目录 → `app.setPath('userData', ...)` → 再往下走。
 */
const APP_DIR = (() => {
  try {
    return path.dirname(process.execPath);
  } catch {
    return '';
  }
})();

const BOOT = prepareEnvironment({ appDir: APP_DIR });

if (SAFE_MODE) BOOT.log.step('安全模式：已关掉硬件加速，用软件渲染');

if (BOOT.userDataDir) {
  // 接口层（lib/host/api.js）会把「上次打开过的整合包目录」落到这个目录下的
  // remembered-roots.json —— 不设的话它只能退回程序目录旁边，卸载就丢。
  process.env.MCSTUDIO_DATA_DIR = BOOT.userDataDir;
  try {
    app.setPath('userData', BOOT.userDataDir);
    // sessionData（缓存、cookie）默认跟着 userData，显式再说一遍，免得版本差异
    try {
      app.setPath('sessionData', BOOT.userDataDir);
    } catch {
      BOOT.log.step('sessionData 设不上（不影响启动）');
    }
    BOOT.log.step(`用户数据目录已设为 ${BOOT.userDataDir}`);
  } catch (error) {
    BOOT.log.error('设用户数据目录失败，退回默认值（可能崩）', error);
  }
} else {
  BOOT.log.step('没找到可写的用户数据目录 —— 大概率会崩，先把原因记下来');
}

/** 兜底：任何没接住的异常都要落日志，别静默死掉。 */
process.on('uncaughtException', (error) => {
  BOOT.log.step('未捕获异常，进程要退出了');
  BOOT.log.error('', error);
  try {
    dialog.showErrorBox(
      '启动出错',
      `软件启动时出了问题：\n${error?.message ?? error}\n\n`
        + `详细信息记在：\n${BOOT.log.file || '（日志也没写出去）'}`,
    );
  } catch {
    // 这时候连弹窗都可能不可用，日志已经写了就行
  }
});

process.on('unhandledRejection', (reason) => {
  BOOT.log.step('有未处理的 Promise 拒绝');
  BOOT.log.error('', reason);
});

/** 项目根目录。源码跑时是 packages/desktop/../..，打包后是 asar 里的同一层。 */
const ROOT = path.join(HERE, '..', '..');

/** 窗口图标：桌面版自己的 app.ico。 */
const ICON = path.join(ROOT, 'packages', 'desktop', 'app.ico');

/** 全局只留一个窗口。 */
let win = null;

/**
 * 把一个窗口顶到用户眼前。
 *
 * ## 为什么要有这个函数（2026-11-02 第十次排查「快捷方式打不开」）
 *
 * 实测到的真实场景：上一个实例**进程还在**，但窗口被最小化到屏幕外了
 * （`iconic=True`、窗口矩形 `-21333,-21333`）—— 用户在屏幕上什么都看不见，
 * 任务栏里却有个图标。用户再双击快捷方式 → 第二个进程拿不到单实例锁 →
 * 原来的做法是弹一个「已经在运行了」的框，然后退出。用户点掉框，屏幕还是空的。
 *
 * 真正能救场的是**已有那个实例**：它得把窗口拉回来。
 * 「该做哪几个动作」由 `window-focus.js` 里的纯函数算出来（可单测），
 * 这里只负责执行。
 *
 * @param {import('electron').BrowserWindow} target
 * @param {string} why 记进日志的原因
 */
function bringWindowToFront(target, why) {
  if (!target || target.isDestroyed()) return;
  try {
    const box = target.getBounds();
    let displays = [];
    try {
      displays = screen.getAllDisplays();
    } catch {
      displays = [];
    }
    const plan = planWindowReveal({
      destroyed: false,
      visible: target.isVisible(),
      minimized: target.isMinimized(),
      onScreen: boundsOnScreen(box, displays),
    });
    for (const action of plan.actions) {
      if (action === 'show') target.show();
      else if (action === 'restore') target.restore();
      else if (action === 'center') target.center();
      else if (action === 'focus') target.focus();
    }
    const after = target.getBounds();
    // **一定要有日志。** 「可见=true 但坐标在屏幕外」是查不出来的那种坑，
    // 只能靠这行日志里的坐标判断。
    BOOT.log.step(
      `窗口显示出来了（${why}）：${plan.reason}，动作 ${plan.actions.join('+') || '无'}，`
      + `位置 ${after.x},${after.y} 尺寸 ${after.width}x${after.height} 可见=${target.isVisible()}`,
    );
  } catch (error) {
    BOOT.log.error('把窗口顶到前面时出错', error);
  }
}

/**
 * 建窗口。
 *
 * 几个默认值不是随手写的：
 * - **`show: true` —— 建好就显示，不等 `ready-to-show`。**
 *   这里踩过两次坑（2026-11-01 用户连续两次报「窗口没出现」）：
 *   藏起来等 `ready-to-show` 的做法，在 `ready-to-show` 不触发时会让窗口
 *   永远藏着 —— 进程活着、服务跑着、日志也写着，用户却什么都看不见。
 *   而那个事件依赖渲染进程完成首帧绘制，显卡驱动异常/远程桌面/安全软件拦 GPU 的
 *   机器上都可能永远不来。**一个立刻能看见的窗口，比一个「理论上不会白闪」的窗口重要得多。**
 *   白闪用 `backgroundColor` 兜（深色底，加载时看不出跳变）。
 * - `contextIsolation: true` / `nodeIntegration: false` —— 界面不需要 Node 能力，
 *   它要的东西全走本地 http。关了这两项，页面脚本就碰不到文件系统。
 */
function createWindow() {
  /**
   * 算一个「一定在主屏幕上」的位置。
   *
   * 为什么不让 Electron 自己决定：多显示器 / 缩放比例奇怪 / 之前在这里存过
   * 一个不存在的屏幕坐标时，窗口会被放到可见区域之外。用户看到的就是
   * 「进程在跑、任务栏有它、但屏幕上什么都没有」。这是「窗口对象建好了却看不见」
   * 的另一条常见原因（和 ready-to-show 不触发是两回事）。
   */
  const bounds = (() => {
    const width = 1440;
    const height = 900;
    try {
      const area = screen.getPrimaryDisplay().workArea;
      // 屏幕比窗口还小时就贴着屏幕大小走，别超出
      const w = Math.min(width, area.width);
      const h = Math.min(height, area.height);
      return {
        width: w,
        height: h,
        x: Math.round(area.x + (area.width - w) / 2),
        y: Math.round(area.y + (area.height - h) / 2),
      };
    } catch {
      // 拿不到屏幕信息就不指定位置，让系统决定
      return { width, height };
    }
  })();

  BOOT.log.step(`窗口位置：${bounds.x ?? '?'},${bounds.y ?? '?'} 尺寸 ${bounds.width}x${bounds.height}`);

  const created = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: true,
    backgroundColor: '#14161a',
    title: '整合包工作室',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  BOOT.log.step('窗口对象建好了');

  /**
   * 多条路确保窗口真的出现在屏幕上。
   *
   * 现在窗口是 `show: true` 建的，理论上建好就可见。但还是要再确认一次 ——
   * 某些机器上 `show: true` 之后窗口会以极小尺寸/在屏幕外/被最小化地出现。
   * 这里统一做一次「显示 + 居中 + 聚焦」，并把结果写进日志。
   *
   * **一定要有日志。** 上一次排查最痛的就是：看不出问题，因为一切"正常"。
   */
  let revealed = false;
  const reveal = (why) => {
    if (revealed || created.isDestroyed()) return;
    revealed = true;
    bringWindowToFront(created, why);
  };

  reveal('建好就显示');
  created.once('ready-to-show', () => reveal('页面画好了'));
  created.webContents.once('dom-ready', () => reveal('页面骨架就绪'));
  created.webContents.once('did-finish-load', () => reveal('页面加载完'));
  created.webContents.once('did-fail-load', () => reveal('页面加载失败，先给个窗口看'));

  /**
   * 兜底定时器：6 秒。
   *
   * 不指望任何事件 —— 哪怕页面一片空白，一个能看见、能关、
   * 能按 Ctrl+Shift+I 看控制台的窗口，也远远好过「双击了什么都没发生」。
   * 这条同时是排查用的探针：日志里出现「兜底定时器」就说明上面几个事件一个都没来。
   */
  const revealTimer = setTimeout(() => reveal('兜底定时器（等了 6 秒）'), 6000);

  // 站外链接交给系统浏览器：窗口是工作台，不是浏览器
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  created.webContents.on('did-fail-load', (_event, code, desc, url) => {
    BOOT.log.step(`页面加载失败：${code} ${desc} @ ${url}`);
  });

  /**
   * 看门狗：15 秒还没加载完，就当窗口这条路废了，改开浏览器。
   *
   * ## 为什么需要它（2026-11-01 用户第三次报「还是打不开」）
   *
   * 前面那些日志都说「窗口显示出来了，可见=true」，用户还是什么都看不见。
   * 说明失败点不在「窗口对象」这一层，而在更下面 —— 渲染进程没画出东西，
   * 或者画在了看不见的地方。这一层我在开发机上复现不了。
   *
   * 所以换个思路：**不再赌窗口一定能用**。给一个明确的时间上限，
   * 到点还没 did-finish-load，就直接把同一个地址丢进系统浏览器。
   * 用户至少能用上，我们也从日志里知道「卡在加载这一步」。
   */
  let loaded = false;
  let loadWatchdog = null;

  /**
   * 监听器必须在 `loadURL` **之前**挂好。
   *
   * 2026-11-01 实测踩到：原来先 `loadURL` 再 `once('did-finish-load')`，
   * 本地服务响应快得离谱，事件在监听器挂上之前就发完了 —— 日志永远没有
   * 「页面加载完了」，看门狗 15 秒后白跑一趟把浏览器也开了。
   * 这类「注册晚了就永远收不到」的事件，顺序比什么都重要。
   */
  created.webContents.once('did-finish-load', () => {
    loaded = true;
    clearTimeout(loadWatchdog);
    BOOT.log.step('页面加载完了');
    // 走到了这一步说明这次启动是活的：把「启动中」的痕迹删掉，
    // 下次启动就不会误判成「上次崩过」而白白进安全模式。
    clearBootStarted(EXEC_DIR);
    // 安全模式跑通了一次：记住这台机器该用安全模式。
    // 下次双击 exe 直接按安全模式起，不再依赖 启动.cmd 帮忙降级。
    // （写失败就算了 —— 大不了下次还走 cmd 的降级链。）
    if (SAFE_MODE) {
      markSafeModeWorks(EXEC_DIR);
    }
  });

  created.loadURL(appUrl());
  BOOT.log.step(`开始加载页面 ${appUrl()}`);

  loadWatchdog = setTimeout(() => {
    if (created.isDestroyed()) return;
    if (loaded) return;
    BOOT.log.step('15 秒还没加载完，认为窗口这条路不通');
    showLoadFailure('窗口里的页面 15 秒还没加载出来');
  }, 15000);

  created.once('closed', () => {
    clearTimeout(loadWatchdog);
    clearTimeout(revealTimer);
    win = null;
  });

  // 页面崩了要让人知道，不能留个空白窗口
  created.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason ?? '未知';
    BOOT.log.step(`页面进程退出：${reason}`);
    clearTimeout(loadWatchdog);
    showLoadFailure(`界面进程退出了（${reason}）`);
  });

  return created;
}

/**
 * 窗口这条路走不通时，给用户一个明确的说法（原来是「改开浏览器」，协议化之后没有浏览器可退，改成弹窗+日志）。
 *
 * ## 为什么改（2026-11-01 用户拍板「不用做插件模式和 web 模式了」）
 *
 * 原来的兜底是把 `http://127.0.0.1:port` 丢进系统浏览器 —— 界面是普通网页，浏览器也能用。
 * 协议化之后 `mcstudio://app/` 只有我们自己的窗口认识，浏览器打不开，这条路自然就没了。
 * 换成：弹窗说清楚出了什么事 + 让用户把日志发过来。
 *
 * 这是兜底，不是主路径：只在窗口相关环节出问题时才用。
 */
function showLoadFailure(why) {
  try {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: '界面没能加载出来',
      message: '软件窗口出了点问题。',
      detail:
        `${why}\n\n`
        + '可以试着关掉软件再双击「启动.cmd」（它会自动换一种更兼容的方式启动）。\n'
        + `详细日志在：\n${BOOT.log.file || '（日志没写出去）'}`,
      buttons: ['知道了'],
      noLink: true,
    });
  } catch {
    // 弹窗不可用就算了，日志已经写了
  }
}

/**
 * 应用菜单。
 *
 * Electron 默认菜单是英文的（File / Edit / View…），跟软件其它部分对不上。
 * 这里只留真正有用的几项 —— 尤其不把「Toggle DevTools」摆在显眼位置。
 */
function applyMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新', role: 'reload' },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开项目文件夹',
          click: () => {
            void shell.openPath(ROOT);
          },
        },
        {
          label: '开发者工具',
          click: () => {
            win?.webContents?.openDevTools?.({ mode: 'detach' });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 自检模式：不建窗口，只验「进程起来 → 拿到 API → 服务起来 → 页面能取到」，
 * 结果写进文件然后退出。
 *
 * ## 为什么产品代码里要留这么一段
 *
 * 用户报「双击没反应」时，最怕的是没有信息。这时让他跑：
 *
 *   整合包工作室.exe --self-check
 *
 * 就会在当前目录（或 `--out` 指的地方）得到一个 JSON，里面写清楚卡在哪一步：
 * 是入口没找到、API 没拿到、还是端口全被占。比「我这边打不开」有用得多。
 *
 * 我自己的自动化测试也用它 —— 这个开发环境挡了子进程的命名管道，
 * 真窗口起不来（`platform_channel.cc: Check failed ... 拒绝访问`），
 * 但入口链、服务、页面这几段是能验的，必须验。
 */
async function runSelfCheck(outFile) {
  const result = { ok: false, steps: [], checks: [], error: '', versions: {
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  } };

  const step = (name, extra) => {
    result.steps.push(extra === undefined ? name : `${name}：${extra}`);
  };
  const check = (name, pass, detail) => {
    result.checks.push({ name, pass: Boolean(pass), detail: String(detail ?? '') });
  };

  const flush = () => {
    try {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    } catch (error) {
      console.error(`[mcstudio] 自检结果写不出去：${error?.message ?? error}`);
    }
  };

  try {
    step('拿到 Electron API');
    check('app 可用', typeof app?.whenReady === 'function', '');
    check('BrowserWindow 可用', typeof BrowserWindow === 'function', '');

    // 用户数据目录：**这是「双击没反应」的头号原因**，必须单独报出来
    step('用户数据目录', BOOT.userDataDir || '（一个都没建成）');
    if (BOOT.picked?.tried?.length) {
      step('  依次试过', BOOT.picked.tried
        .map((item) => `${item.dir}${item.ok ? '✓' : `✗${item.reason}`}`)
        .join(' | '));
    }
    check('用户数据目录可写', Boolean(BOOT.userDataDir), BOOT.userDataDir);
    check('启动日志写得出去', Boolean(BOOT.log.file), BOOT.log.file);

    // ROOT 算得对不对 —— 打包后最常见的错就是路径差一层
    step('算出来的项目根', ROOT);
    check('图标在', fs.existsSync(ICON), ICON);
    check('界面在', fs.existsSync(path.join(ROOT, 'packages', 'ui', 'index.html')), '');
    check('接口层在', fs.existsSync(path.join(ROOT, 'lib', 'host', 'api.js')), '');

    await app.whenReady();
    step('app.whenReady 触发了');

    // 协议化之后没有「服务起来」这一步了，改为验协议处理器本身：
    // 直接按 protocol.handle 会收到的形状发请求，看静态页和接口是不是都通。
    const res = await handleProtocolRequest(new Request(appUrl()));
    const html = await res.text();
    step('取到首页', `${res.status}，${html.length} 字节`);
    check('首页 200', res.status === 200, String(res.status));
    check('首页引了 app.js', /\/ui\/app\.js/.test(html), '');

    const api = await handleProtocolRequest(new Request(new URL('/api/mcstudio/roots', appUrl()).href));
    const body = await api.json();
    step('接口调通了', `${api.status}`);
    check('接口返回 ok', api.status === 200 && body?.ok === true, JSON.stringify(Object.keys(body ?? {})));
  } catch (error) {
    result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    step('出错了', result.error.split('\n')[0]);
  }

  result.ok = result.checks.length > 0 && result.checks.every((item) => item.pass);
  flush();
  console.log(`[mcstudio] 自检${result.ok ? '通过' : '没过'}，结果在 ${outFile}`);
  return result.ok ? 0 : 1;
}

/**
 * 自检模式要在拿单实例锁**之前**处理。
 *
 * 为什么要抢在前面：用户很可能正开着软件（占着单实例锁），这时跑自检
 * 如果先请求锁会直接退出，什么也验不了。
 */
const SELF_CHECK = ARGV.includes('--self-check');
const GOT_LOCK = SELF_CHECK ? true : app.requestSingleInstanceLock();

/**
 * 这一把到底扮演什么角色（自检 / 主角 / 配角）。
 *
 * 「配角」＝ 已经有一个实例在跑，这一个只是被用户又双击了一次唤出来的。
 * 配角的规矩：**安静退出，别抢焦点，别写启动痕迹**。
 */
const STARTUP = planStartup({ selfCheck: SELF_CHECK, gotLock: GOT_LOCK });

if (SELF_CHECK) {
  const outFile = path.resolve(cliValue(ARGV, 'out', path.join(process.cwd(), 'self-check.json')));
  runSelfCheck(outFile)
    .then((code) => app.exit(code))
    .catch((error) => {
      console.error(`[mcstudio] 自检本身崩了：${error?.message ?? error}`);
      app.exit(2);
    });
} else if (!GOT_LOCK) {
  /**
   * 已经有一个实例在跑，这一个安静退出。
   *
   * ## 为什么改成安静退出（2026-11-02 第十次排查「快捷方式打不开」）
   *
   * 原来这里会弹一个「已经在运行了」的模态框。实测下来那是**帮倒忙**：
   *
   * 1. 那个「已有实例」很可能是个**僵尸**——进程还在、占着锁，但窗口被最小化
   *    到屏幕外了（实测 `iconic=True`、矩形 `-21333,-21333`）。用户双击时
   *    真正需要的是「把那个窗口拉回来」。
   * 2. 已有实例收到 `second-instance` 后会把窗口顶到前面 —— 这时候弹框，
   *    等于在用户眼前抢走焦点，把刚顶出来的窗口又压到后面。
   * 3. 用户点掉框，屏幕还是空的 —— 框什么都没解决。
   *
   * 所以配角只做两件事：记一笔日志（方便我们排查），然后安静退出。
   * **不写启动痕迹** —— 否则用户下次双击会被误判成「上次崩过」，白白进安全模式。
   */
  BOOT.log.step('已经有一个实例在跑，这次退出（已有实例会把窗口顶到前面）');
  app.quit();
} else {
  /**
   * 主角：只有真正要开窗口的这个进程才写「启动中」痕迹。
   *
   * 痕迹的作用是「上次没开成 → 下次自动走安全模式」，所以只有主角该写。
   */
  if (STARTUP.markTrace) {
    markBootStarted(EXEC_DIR, { safe: SAFE_MODE });
  }

  app.on('second-instance', () => {
    BOOT.log.step('用户又双击了一次，把已有窗口顶到前面');
    if (!win || win.isDestroyed()) return;
    // 上一次可能是「进程活着但窗口藏着 / 最小化到屏幕外」的状态 ——
    // 光 focus 没用，用户还是什么都看不见。必须确保它真的显示出来。
    bringWindowToFront(win, '用户又双击了一次');
  });

  app.whenReady().then(async () => {
    BOOT.log.step('Electron 准备好了');
    try {
      // 协议处理器：把 mcstudio://app/... 翻译给 dispatchStudioRequest。
      // 没有端口、没有监听、退出也不需要关任何东西 —— 这就是协议化换来的简单。
      protocol.handle(SCHEME_NAME, (request) => handleProtocolRequest(request));
      BOOT.log.step(`协议处理器装好了（${appUrl()}）`);
    } catch (error) {
      BOOT.log.error('协议处理器装不上', error);
      dialog.showErrorBox(
        '启动出错',
        `界面协议注册失败：${error?.message ?? error}\n\n`
          + `详细信息记在：\n${BOOT.log.file || '（日志也没写出去）'}`,
      );
      app.quit();
      return;
    }

    applyMenu();
    BOOT.log.step('菜单装好了，开始建窗口');
    win = createWindow();

    // macOS 上点程序坞图标会重新激活；Windows 上这段不生效
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
    });
  }).catch((error) => {
    BOOT.log.error('whenReady 之后就挂了', error);
    try {
      dialog.showErrorBox('启动出错', `${error?.message ?? error}\n\n详细日志：\n${BOOT.log.file}`);
    } catch {
      // 弹窗不可用就算了，日志已经写了
    }
  });

  // Windows / Linux：关掉最后一个窗口就退出整个程序
  app.on('window-all-closed', () => {
    app.quit();
  });
}
