/**
 * 把桌面版打包成一个能双击运行的 exe。
 *
 * ## 为什么手写，不用 electron-builder / @electron/packager
 *
 * 那两个包都依赖 npm 装一堆东西，而这个项目的开发环境里 `npm install` 的子进程
 * 管道会被拦（EPERM）—— electron 本体都得 `--ignore-scripts` 装上再手动跑 install.js。
 * 再引两个打包器，等于把「能不能出成品」绑在了一堆装不上的依赖上。
 *
 * 而 Electron 的官方分发目录本身就是**开箱可用的**：`dist/` 里那个 electron.exe
 * 换掉 resources 里的 app 就是你的程序。手写这一段只要几十行，且零依赖。
 *
 * ## 打出来的目录长什么样
 *
 * ```
 * 整合包工作室-桌面版/
 *   mcstudio.exe            ← 原来叫 electron.exe（名字必须纯英文，见 APP_NAME 注释）
 *   启动.cmd                ← ASCII 内容，通配符抓上面的 exe
 *   *.dll, *.pak, *.bin     ← Electron 运行时，原样不动
 *   locales/                ← 语言包（可以删，删了会退成英文）
 *   resources/
 *     app/                  ← 我们的代码，保持和源码一致的相对路径
 *       package.json
 *       packages/desktop|ui/...   （mcstudio:// 协议层 + 界面）
 *       lib/host/...
 *       packages/core/...
 * ```
 *
 * 为什么 `resources/app/` 用**目录**而不是 `app.asar`：asar 需要额外的打包器。
 * 目录形式 Electron 一样认（优先级还更高），而且用户想改一行代码可以直接改，
 * 出问题时也好排查 —— 对一个还在迭代的工具来说，这比省几百毫秒启动值。
 *
 * ## 用法
 *
 *   node packages/desktop/build.mjs                  # 打到 dist/desktop/
 *   node packages/desktop/build.mjs --out D:\xxx     # 换输出目录
 *   node packages/desktop/build.mjs --name mystudio  # 换 exe 名字（必须纯英文）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { restoreUserData, stashUserData } from './keep.mjs';
import { buildLaunchCmd, buildShortcutScript, isAsciiOnly, shortcutSpawnPlan, SHORTCUT_ARGS } from './launch-plan.js';
import { embedIcon, inspectIcons } from './embed-icon.mjs';
import { integrityNotice, probeIntegrity } from './integrity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

/** 极简参数解析，只认 `--key value` 和 `--key=value`。 */
function argOf(argv, key, fallback) {
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === `--${key}` && i + 1 < argv.length) return argv[i + 1];
    if (item.startsWith(`--${key}=`)) return item.slice(key.length + 3);
  }
  return fallback;
}

const args = process.argv.slice(2);

/** 输出目录。默认放项目根的 dist/desktop，和 lab/ 那些临时产物分开。 */
const OUT_DIR = path.resolve(argOf(args, 'out', path.join(ROOT, 'dist', 'desktop')));

/**
 * exe 名字（不带 .exe）。
 *
 * ⚠ 编码血的教训（2026-11-01 实测）：cmd.exe 在控制台代码页 936 下**静默拒绝
 * 运行中文文件名的 exe** —— `dir` 里名字显示正常，但 CreateProcess 执行时
 * 编码出错，不报错、退出码 0、直接跳过，表现就是「双击启动.cmd 毫无反应」。
 * 而且这毛病用户机器上同样发生。所以 exe 名字**必须纯英文**（mcstudio），
 * 中文名只留给说明书等非可执行文件。窗口标题、菜单里的中文不受影响。
 */
const APP_NAME = argOf(args, 'name', 'mcstudio');

/**
 * Electron 的 dist 在哪儿。
 *
 * 优先用 `--electron` 传进来的；否则从 node_modules 找。
 * 本项目的开发环境里 electron 是装在 `.tools/electron-probe` 下的
 * （因为工作区外的 npm 缓存会 EPERM），所以那里也当候选。
 */
function findElectronDist() {
  const explicit = argOf(args, 'electron', '');
  const candidates = [
    explicit,
    path.join(ROOT, 'node_modules', 'electron', 'dist'),
    path.join(ROOT, '.tools', 'electron-probe', 'node_modules', 'electron', 'dist'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'electron.exe'))) return dir;
  }
  throw new Error(
    '找不到 Electron 的 dist 目录。先装一次：\n'
      + '  npm install electron@38 --ignore-scripts --prefix .tools/electron-probe\n'
      + '  $env:electron_config_cache="<项目>/.tools/electron-cache"\n'
      + '  node .tools/electron-probe/node_modules/electron/install.js\n'
      + '然后用 --electron <dist 路径> 指给我。',
  );
}

/**
 * 打包时要带上的源码目录（相对项目根）。
 *
 * 只带真正会被 import 到的：主进程、协议层、界面、宿主接口、核心逻辑。
 * 不带 test / lab / tools / ref / probe / docs / dist —— 那些是开发期的东西，
 * 加起来几十 MB，放进成品只会让用户困惑。
 *
 * 2026-11-01 协议化：界面不再走本地 HTTP 服务，`packages/server/server.js` 和
 * `packages/desktop/port.js` 已从打包清单移除（main.mjs 改走 mcstudio:// 协议），
 * web 线源文件已整体删除；`packages/server/` 目录已清空退役。
 *
 * 2026-11-04 去插件化：`locale/` 语言包随 DSH 插件版一起删了（界面文案现在
 * 直接写在 packages/ui/ 里），所以清单里的 'locale' 也要跟着去掉。
 */
const INCLUDE = [
  'packages/desktop/main.mjs',
  // 协议层：mcstudio://app/ 的请求处理（静态文件 + 接口分发），main.mjs 直接 import。
  'packages/desktop/protocol.js',
  // 启动预检：挑一个可写的用户数据目录 + 开启动日志。
  // **漏了它主进程起不来**（main.mjs 一开头就 import './preflight.js'）。
  'packages/desktop/preflight.js',
  // 启动痕迹与安全模式标记（纯 Node，逻辑在 boot-state.js，main.mjs 只接线）。
  // **漏了它主进程起不来**（main.mjs import './boot-state.js'）。
  'packages/desktop/boot-state.js',
  // 窗口「顶到前面」的动作编排（纯 Node，main.mjs import './window-focus.js'）。
  // **漏了它主进程起不来**。
  'packages/desktop/window-focus.js',
  // 带上冒烟脚本：成品自带自检能力（纯 Node，不碰窗口）
  'packages/desktop/smoke.mjs',
  'packages/desktop/app.ico',
  // 换 exe 内嵌图标的工具（纯 Node，改 .rsrc 节）。打包时在 build.mjs 里 import，
  // 放进清单是为了让成品里也带着（用户可以自己重新换一个图标）。
  'packages/desktop/embed-icon.mjs',
  // 完整性标签检测与提示（纯 Node，build.mjs 打包时 import）。
  // 检测「快捷方式带低完整性标签 → 资源管理器不显示图标」这个环境坑。
  'packages/desktop/integrity.js',
  'packages/ui',
  'packages/core',
  'lib/host',
  // 内置 MCP 服务器（stdio）：模型工具层由它提供。
  // **它现在是硬依赖** —— lib/host/api.js 会动态 import 它的 config.mjs 与 protocol.mjs
  // （/mcp/config、/mcp/selftest 两条路由），缺了成品里那两条路由直接报错。
  // 所以它进了 INCLUDE（缺了就当场打包失败），不再当可选项。
  'packages/mcp',
];

/**
 * 可选的打包内容：目录存在才带，不存在就跳过（不报错）。
 *
 * 目前是空的 —— 之前 `packages/mcp` 挂在这儿，因为它还在开发中；
 * 2026-11-04 它做完了、而且成了 api.js 的硬依赖，所以挪进 INCLUDE 了。
 * 以后再有「可有可无」的东西（比如额外的诊断脚本）再往这儿加。
 */
const OPTIONAL_INCLUDE = [];

/**
 * 打包时不带的文件（按文件名匹配）。
 *
 * - `package.json` 必须排除：成品里的那份是 build.mjs 第 6 步专门写的
 *   （`main` 指向 packages/desktop/main.mjs，跟源码里那个不一样），
 *   照抄源码那份会让 Electron 找不到入口。
 * - 探测脚本是开发期诊断用的，带进成品没意义。
 * - `build.mjs` 自己也不需要。
 *
 * **`smoke.mjs` 特意保留**：它是纯 Node 脚本（不 import electron），
 * 带上之后成品自带一次自检能力 —— 出问题时可以在成品目录里跑它，
 * 确认「协议处理器能取到页面、接口通」，不用回头找源码。
 */
const EXCLUDE_FILES = new Set(['build.mjs', 'probe-api.cjs', 'probe-api.mjs', 'package.json']);

/** 递归复制，带上过滤。 */
function copyTree(from, to, stats) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (EXCLUDE_FILES.has(name)) continue;
      copyTree(path.join(from, name), path.join(to, name), stats);
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  stats.files += 1;
  stats.bytes += stat.size;
}

/** 目录有多大。用来在结束时报一句「成品 300 多 MB，别奇怪」。 */
function sizeOf(dir) {
  let total = 0;
  let files = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        total += fs.statSync(abs).size;
        files += 1;
      }
    }
  };
  walk(dir);
  return { total, files };
}

/** 人话大小。 */
function fmt(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(n) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function main() {
  const electronDist = findElectronDist();
  console.log(`Electron 运行时：${electronDist}`);
  console.log(`输出目录：${OUT_DIR}`);
  console.log(`程序名：${APP_NAME}.exe`);
  console.log('');

  // 1. 清空输出目录（只清自己建的那个，避免手滑删掉别的东西）
  //
  // ⚠ 用户数据必须活过重打包（2026-11-02 用户报「快捷方式还是打不开」）。
  //
  // `safe-mode.stamp` 是主进程在「安全模式成功加载过页面」时写下的标记，
  // 下次启动看到它就自动按安全模式起（见 main.mjs 顶部）。这台机器普通模式
  // 必崩 0x80000003、只有安全模式能活，所以那个标记就是「这台机器能用」本身。
  //
  // 而重打包会把整个 OUT_DIR 删掉 —— 标记没了，用户双击就是立刻崩，
  // 表现为「又打不开了」，而且和代码改了什么毫无关系。所以清理前先留一份，
  // 复制完运行时再放回去。用户数据目录（用户数据/）同理。
  //
  // 具体逻辑在 packages/desktop/keep.mjs（单独拎出来是为了能单测）。
  const saved = stashUserData(OUT_DIR, os.tmpdir());

  if (fs.existsSync(OUT_DIR)) {
    const entries = fs.readdirSync(OUT_DIR);
    if (entries.length > 0 && !fs.existsSync(path.join(OUT_DIR, 'electron.exe')) && !fs.existsSync(path.join(OUT_DIR, `${APP_NAME}.exe`))) {
      throw new Error(`输出目录 ${OUT_DIR} 里已经有别的东西，我不动它。换个 --out 或者先自己清理。`);
    }
    console.log('清掉上次的产物…');
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const brought = [...saved.files, ...saved.dirs];
  if (brought.length) console.log(`  顺带保住用户数据：${brought.join('、')}`);

  // 2. 复制 Electron 运行时
  console.log('复制 Electron 运行时…');
  const runtime = { files: 0, bytes: 0 };
  copyTree(electronDist, OUT_DIR, runtime);
  console.log(`  ${runtime.files} 个文件，${fmt(runtime.bytes)}`);

  // 3. 把 electron.exe 换成我们的名字
  const runtimeExe = path.join(OUT_DIR, 'electron.exe');
  const appExe = path.join(OUT_DIR, `${APP_NAME}.exe`);
  fs.renameSync(runtimeExe, appExe);
  console.log(`  改名为 ${path.basename(appExe)}`);

  // 3.1 把 exe 自己的图标换成我们的（不然在资源管理器里还是 Electron 的默认图标）
  //
  // 为什么不走 Windows 的 BeginUpdateResource/UpdateResource：
  // 在这台机器上那套 API 会「假成功」——句柄打开成功、返回码全是 True，
  // 但文件一个字节都没变（实测 md5 前后一致；同一进程里普通写文件却生效）。
  // 所以这里改成纯 Node 直接改 .rsrc 节（见 embed-icon.mjs）。
  console.log('换 exe 图标…');
  const iconSource = path.join(ROOT, 'packages', 'desktop', 'app.ico');
  const iconResult = embedIcon(appExe, iconSource);
  console.log(`  ${iconResult.frames} 帧（${iconResult.sizes.join('/')}），资源 ${iconResult.bytes} 字节`);
  if (!iconResult.changed) console.log('  （已经是这个图标了，内容没变）');

  // 4. 干掉默认的 default_app.asar —— 留着它，Electron 找不到我们的 app 时会退回去跑那个欢迎页
  const defaultApp = path.join(OUT_DIR, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultApp)) {
    fs.rmSync(defaultApp);
    console.log('  删掉 default_app.asar（不然会退回欢迎页）');
  }

  // 5. 我们的代码放进 resources/app/
  console.log('复制我们的代码…');
  const appDir = path.join(OUT_DIR, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const ours = { files: 0, bytes: 0 };
  for (const rel of INCLUDE) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) {
      throw new Error(`打包清单里的 ${rel} 不存在 —— 是不是改名了？`);
    }
    copyTree(from, path.join(appDir, rel), ours);
  }
  for (const rel of OPTIONAL_INCLUDE) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) {
      console.log(`  跳过 ${rel}（目录还没建好）`);
      continue;
    }
    copyTree(from, path.join(appDir, rel), ours);
  }
  console.log(`  ${ours.files} 个文件，${fmt(ours.bytes)}`);

  // 6. 写 resources/app/package.json
  //
  // 这份不是项目根那个（根上那份是给 npm/发布用的）。Electron 读它来知道「入口在哪」。
  // `type: module` 必须写：我们的源码全是 ESM（import/export），
  // 不写的话 .js 会被当 CommonJS 解析，`import` 直接 SyntaxError。
  const appPackage = {
    name: 'mcstudio-desktop',
    productName: APP_NAME,
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'packages/desktop/main.mjs',
    description: 'Minecraft 整合包工作室（桌面版）',
  };
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify(appPackage, null, 2)}\n`,
    'utf8',
  );
  console.log('  写了 resources/app/package.json');

  // 6.5. 放一个「启动.cmd」双保险。
  //
  // 为什么要有：有些环境（比如某些启动器、终端、被注入过变量的软件）会把
  // ELECTRON_RUN_AS_NODE=1 塞进环境里。这个变量一旦存在，Electron 的 exe 会把自己
  // 当成普通 Node 跑 —— 窗口相关代码一个字都不会执行，双击就是「什么都没发生」，
  // 而且连日志都没有（因为我们的代码根本没跑）。实测退出码 9。
  //
  // 这个 cmd 先把变量清空再启动 exe，保证走的是真正的 Electron。
  //
  // ⚠ 编码血的教训（2026-11-01 实测）：cmd.exe 按 GBK/ANSI 读 .cmd 文件，
  // 而 writeFileSync utf8 写出来的中文是 UTF-8 字节 —— exe 的中文名一进 cmd 就变乱码，
  // 用户双击报「Windows 找不到文件 '...乱码....exe'」。所以内容**只用 ASCII**，
  // exe 文件名不写死，用 for 通配符抓目录里那个唯一的 .exe。
  //
  // 降级链的正文在 launch-plan.js 里（那边能单测），这里只负责写盘 + 自检。
  const LAUNCH_CMD = buildLaunchCmd();
  // 打包当场自检：只要混进一个非 ASCII 字符，cmd 一跑就乱码，宁可现在炸
  if (!isAsciiOnly(LAUNCH_CMD)) {
    console.error('自检没过：启动.cmd 里混进了非 ASCII 字符（cmd.exe 按 GBK 读会乱码）');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(path.join(OUT_DIR, '启动.cmd'), LAUNCH_CMD, 'utf8');

  // 6.6. 生成桌面快捷方式。
  //
  // 为什么现在才做（2026-11-02 用户第三次报「快捷方式打不开」）：
  // 之前只有根目录那个手搓的 .lnk，参数只带 `--safe-mode`。实测这台机器上
  // **不带 `--no-sandbox` 就必崩 0x80000003，而且崩在 JS 之前**（日志一行都没写），
  // 所以 main.mjs 里那句 appendSwitch('no-sandbox') 根本来不及救。
  // → 快捷方式的参数必须从命令行层面就带全：`--safe-mode --no-sandbox`。
  //
  // 两个位置都放：成品目录里一份（跟着 exe 走），仓库根一份（用户之前双击的那个）。
  const shortcutTargets = [
    { linkPath: path.join(OUT_DIR, '整合包工作室.lnk'), label: '成品目录' },
    { linkPath: path.join(ROOT, '整合包工作室.lnk'), label: '项目根目录' },
  ];
  for (const target of shortcutTargets) {
    const script = buildShortcutScript({
      linkPath: target.linkPath,
      targetPath: appExe,
      args: SHORTCUT_ARGS,
      // 图标直接指 exe 自己，不再指外部 app.ico。
      //
      // 原因：快捷方式里的 IconLocation 只是一个「外部文件路径指针」，
      // 资源管理器显示时要现场去解析那个路径；解析不到就退回通用快捷方式图标。
      // 之前指包内那个 app.ico，实测解析不出图标（快捷方式没图标、exe 却有）。
      // 改成指 exe 后（Obsidian 就是这么干的），图标跟着 exe 走，
      // 而 exe 的内嵌图标是打包第 3.1 步刚写进去的，必定能取到。
      iconPath: appExe,
      workingDir: OUT_DIR,
    });
    if (!isAsciiOnly(script)) {
      console.error(`自检没过：快捷方式脚本里混进了非 ASCII 字符（${target.label}）`);
      process.exitCode = 1;
      return;
    }
    const plan = shortcutSpawnPlan(script);
    // stdio 必须 'ignore'：在这个沙箱里捕获子进程管道会被拦（EPERM）。
    const result = spawnSync(plan.file, plan.args, { stdio: 'ignore' });
    if (result.status === 0 && fs.existsSync(target.linkPath)) {
      console.log(`  写了快捷方式（${target.label}）：${target.linkPath}`);
    } else {
      // 快捷方式不是必需品，生成失败只提醒，不让整次打包失败。
      console.warn(`  快捷方式没写成（${target.label}）：退出码 ${result.status ?? 'null'}`);
      continue;
    }

    // 6.7. 只做诊断：读一下快捷方式的完整性标签，低标签时记一句中性说明。
    //
    // 2026-11-10~11 观察：本沙箱写出的文件都带「低完整性标签」
    // （Low Mandatory Level，sid S-1-16-4096），桌面上正常的 Hermes.lnk /
    // Obsidian.lnk 却没有标签；两者与「白纸 + 蓝箭头」只是相关，因果未定案
    // （微软 MIC 文档说高完整性进程读低完整性文件是允许的）。
    //
    // 2026-11-11 收口：曾经在这里尝试提级并打印 icacls 修法命令，用户按提示
    // 在普通终端跑了三轮，实测全部无效 —— 根目录 /T 一遇上传目录「拒绝访问」
    // 就停；单独提级 dist 时 33 个目录全「拒绝访问」（目录没改成 medium，
    // 新建文件仍继承 low），而本脚本第一件事又是「清掉上次的产物」，会把刚
    // 提级好的目录删了重建；改标签还需要管理员特权。桌面「新建快捷方式」
    // 向导也报「显示无法创建」。⇒ 提级修法属误导，已删除；这里不再尝试提级、
    // 不再打印任何让用户跑的命令。低标签只是受限环境里的一个相关量，本机既
    // 验不准因果也改不动；图标观感是环境层面的事，与软件功能无关。
    // 这条线到此收口，不需要用户做实验、跑命令或回来告知。
    const probeFile = path.join(OUT_DIR, `_integrity-${target.label}.txt`);
    const probe = probeIntegrity(target.linkPath, probeFile);
    if (probe.ok && probe.level === 'low') {
      console.log(integrityNotice({ label: probe.level, filePath: target.linkPath }));
    }
    //
    // 上面这段只在 probe 成功且 level 为 low 时打印；probe 跑不起来就安静跳过，
    // 不因为诊断失败影响整次打包（快捷方式本身已经写好了）。
    // 详见 packages/desktop/integrity.js 与 docs/HANDOFF.md 的 §11 收口纪要。
  }

  // 7. 顺手放一个说明文件，用户点进目录能看懂这是什么
  fs.writeFileSync(
    path.join(OUT_DIR, '说明.txt'),
    [
      `Minecraft 整合包工作室（桌面版）`,
      '',
      `日常使用：双击这个目录里的「整合包工作室」快捷方式就行（已经帮你建好了）。`,
      `不需要装 Node，也不需要开浏览器。`,
      '',
      `关于「第一次可能闪一下就没反应」：`,
      `  有些机器的显卡和 Chromium 的硬件加速不兼容（表现就是双击后窗口不出来）。`,
      `  这台机器上还有一层更硬的限制：不开 sandbox 的话 Electron 会在启动阶段直接崩，`,
      `  连日志都来不及写。所以快捷方式里已经写好了「兼容模式 + 关 sandbox」两个参数，`,
      `  双击就能起来。`,
      `  实在想手动指定：双击 启动.cmd（它会一级级试出能用的模式），`,
      `  或者命令行跑 ${APP_NAME}.exe ${SHORTCUT_ARGS}。`,
      `  想回到普通模式试一试（比如换了显卡/修好了驱动）：`,
      `  在地址栏输 cmd 回车，然后执行： ${APP_NAME}.exe --no-safe-mode`,
      '',
      '启动日志在哪里：',
      '  正常情况在 %APPDATA%\\mcstudio\\启动日志.txt；',
      '  如果那个位置写不进去，会写在 exe 旁边的 启动日志.txt（两处是同一份内容的镜像）。',
      '  报问题时把这份日志发过来，一眼就能看出卡在哪一步。',
      '',
      '这个目录里除了 resources/app/ 是软件本身的代码，',
      '其余都是 Electron 运行时（Chromium + Node），别删也别动。',
      '',
      'safe-mode.stamp / boot.pending / 用户数据\\ 是软件自己记的账，',
      '（这台机器该用哪种模式、Electron 的本地存储），别手动删。',
      '重新打包也不会再把它们清掉。',
      '',
      `整个目录可以整个复制到别的地方用，不依赖安装过程。`,
      '',
      '数据都写在你操作的那个整合包目录里，不在这。',
      '卸载 = 删掉这个目录。',
      '',
    ].join('\r\n'),
    'utf8',
  );

  // 8. 把保住的用户数据放回去（见第 1 步的说明）。
  //
  // 必须放在最后：前面第 2 步复制运行时、第 5 步复制代码都可能覆盖同名路径。
  if (saved.files.length || saved.dirs.length) {
    const { restored, failed } = restoreUserData(saved, OUT_DIR);
    for (const item of failed) {
      console.warn(`  没放回 ${item.name}（${item.message}）`);
    }
    if (restored.length) console.log(`  用户数据已归位：${restored.join('、')}`);
  } else if (saved.savedRoot) {
    fs.rmSync(saved.savedRoot, { recursive: true, force: true });
  }

  // 9. 报个数
  const final = sizeOf(OUT_DIR);
  console.log('');
  console.log('打好了：');
  console.log(`  ${appExe}`);
  console.log(`  整个目录 ${final.files} 个文件，${fmt(final.total)}`);
  console.log('');
  console.log('双击那个 exe 就能开。第一次开可能被 Windows 拦一下（未签名），点「更多信息 → 仍要运行」。');

  // 10. 自检：目录结构对不对。打错了要当场知道，别等用户双击才发现
  const problems = [];
  if (!fs.existsSync(appExe)) problems.push('exe 不在');
  // exe 名字必须纯英文：cmd 在代码页 936 下会静默拒绝运行中文文件名的 exe
  // （实测：`dir` 显示正常，CreateProcess 编码出错，退码 0 直接跳过）。
  if (/[^\x00-\x7F]/.test(APP_NAME)) problems.push(`exe 名字「${APP_NAME}」含非 ASCII 字符（cmd 会静默拒绝运行，双击启动.cmd 毫无反应）`);
  if (!fs.existsSync(path.join(OUT_DIR, '启动.cmd'))) problems.push('启动.cmd 不在（防 ELECTRON_RUN_AS_NODE 的双保险缺了）');
  if (!fs.existsSync(path.join(OUT_DIR, '整合包工作室.lnk'))) problems.push('成品目录的快捷方式不在');
  if (!fs.existsSync(path.join(ROOT, '整合包工作室.lnk'))) problems.push('项目根目录的快捷方式不在');
  if (!fs.existsSync(path.join(appDir, 'package.json'))) problems.push('resources/app/package.json 不在');
  if (!fs.existsSync(path.join(appDir, 'packages', 'desktop', 'main.mjs'))) problems.push('主进程入口不在');
  if (!fs.existsSync(path.join(appDir, 'packages', 'desktop', 'protocol.js'))) problems.push('协议层不在（窗口会加载 mcstudio:// 失败）');
  if (!fs.existsSync(path.join(appDir, 'packages', 'desktop', 'preflight.js'))) problems.push('启动预检模块不在（主进程会 import 失败）');
  if (!fs.existsSync(path.join(appDir, 'packages', 'desktop', 'boot-state.js'))) problems.push('启动痕迹模块不在（主进程会 import 失败）');
  if (!fs.existsSync(path.join(appDir, 'packages', 'desktop', 'window-focus.js'))) problems.push('窗口聚焦模块不在（主进程会 import 失败）');
  if (!fs.existsSync(path.join(appDir, 'packages', 'ui', 'index.html'))) problems.push('界面首页不在');
  if (!fs.existsSync(path.join(appDir, 'lib', 'host', 'api.js'))) problems.push('接口层不在');
  // 内置 MCP 服务器：lib/host/api.js 会动态 import 它（/mcp/config、/mcp/selftest），
  // 缺了这两条路由在成品里直接报错，界面的「让模型帮你改包」页用不了。
  if (!fs.existsSync(path.join(appDir, 'packages', 'mcp', 'server.mjs'))) problems.push('内置 MCP 服务器不在（/mcp/config 与 /mcp/selftest 会 import 失败）');
  if (!fs.existsSync(path.join(appDir, 'packages', 'mcp', 'tools.mjs'))) problems.push('MCP 工具清单不在');
  if (!fs.existsSync(path.join(appDir, 'packages', 'mcp', 'protocol.mjs'))) problems.push('MCP 协议层不在');
  if (!fs.existsSync(path.join(appDir, 'packages', 'mcp', 'config.mjs'))) problems.push('MCP 配置生成器不在');
  if (fs.existsSync(defaultApp)) problems.push('default_app.asar 还在');
  // exe 自己的图标：读回来确认资源树里真的有我们的六帧，别等用户双击才发现还是 Electron 图标。
  try {
    const iconCheck = inspectIcons(appExe);
    if (iconCheck.frames !== 6) problems.push(`exe 里的图标帧数不对（${iconCheck.frames}，应该是 6）`);
    if (iconCheck.groups !== 1) problems.push(`exe 里的图标分组数不对（${iconCheck.groups}，应该是 1）`);
    // ★ 分组头里自己声明的帧数也要对。早先就是这里没查出来：
    // count 字段的字节序写反了（被读成 1536），Windows 直接把整个图标组
    // 当坏数据，资源管理器退回默认空白图标，快捷方式跟着没图标。
    if (iconCheck.declared !== iconCheck.frames) {
      problems.push(`exe 里的图标分组声明的帧数不对（${iconCheck.declared}，应该是 ${iconCheck.frames}）`);
    }
  } catch (error) {
    problems.push(`exe 图标没写进去：${error?.message ?? error}`);
  }
  if (problems.length > 0) {
    console.error('');
    console.error(`自检没过：${problems.join('；')}`);
    process.exitCode = 1;
    return;
  }
  console.log('自检通过：exe、入口、界面、接口层、内置 MCP 服务器、default_app 都符合预期。');
}

try {
  main();
} catch (error) {
  console.error('');
  console.error(`打包失败：${error?.message ?? error}`);
  if (process.env.MCSTUDIO_BUILD_DEBUG) console.error(error?.stack ?? '');
  process.exitCode = 1;
}
