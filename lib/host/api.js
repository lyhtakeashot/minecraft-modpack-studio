/**
 * 工作室的接口层。
 *
 * 为什么要有这一层：界面（浏览器里跑的页面）不能直接 require 我们的 packages/core ——
 * 那是宿主进程里的 Node 模块。桌面版的标准通道是 `mcstudio://app/` 协议，
 * 由 `packages/desktop/protocol.js` 把请求转到这里。
 *
 * 设计原则：界面和模型工具走同一套底层。
 * 这里的 handler 全部直接调 packages/core/*，和模型工具（MCP 服务器）调的是同一批函数，
 * 所以「点界面改」和「让模型改」落到磁盘上的结果必然一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McError } from '../../packages/core/errors.js';
import { inspectInstance, resolveInstance } from '../../packages/core/instance.js';
import { searchItems } from '../../packages/core/item-search.js';
import { beginPickFolder, pickFolderStatus } from './pick-folder.js';
import { handleItemGrid, handleItemTags } from './item-grid-api.js';
import { clearTruthCache, handleItemTruthImport, handleItemTruthStatus } from './item-truth.js';
import { handleNameApply, handleNamePreview } from './name-completion.js';
import { cachedIndex, resetCaches } from './cache.js';
import { readParams } from './params.js';
import {
  handleItemRecipes,
  handleRecipeApply,
  handleRecipeBatchApply,
  handleRecipeBatchPreview,
  handleRecipeDetail,
  handleRecipePreview,
} from './recipe-api.js';
// 「这条配方长什么样」：只读，给界面画 JEI 那种合成表（九宫格 / 大格子 / 机器流程图）
import { handleRecipeView } from './recipe-view-api.js';
import {
  handleChapterAddApply,
  handleChapterAddPreview,
  handleQuestAddApply,
  handleQuestAddPreview,
  handleQuestApply,
  handleQuestBook,
  handleQuestCanvas,
  handleQuestCloneApply,
  handleQuestClonePreview,
  handleQuestConditionTypes,
  handleQuestDetail,
  handleQuestImageApply,
  handleQuestImagePreview,
  handleQuestImages,
  handleQuestList,
  handleQuestMoveApply,
  handleQuestMovePreview,
  handleQuestNodeApply,
  handleQuestNodeDeleteApply,
  handleQuestNodeDeletePreview,
  handleQuestNodeItemsApply,
  handleQuestNodeItemsPreview,
  handleQuestNodePreview,
  handleQuestPreview,
  handleQuestSpawnApply,
  handleQuestSpawnPreview,
  resetQuestCache,
} from './quest-api.js';
import {
  handleModCompat,
  handleModInstallApply,
  handleModInstallPreview,
  handleModSearch,
  handleModUpdateApply,
  handleModUpdateCheck,
  handleModUpdateLocks,
  handleModUpdatePreview,
  handleModUpdateRollbackApply,
  handleModUpdateRollbackPreview,
  handleModVersions,
} from './mod-api.js';
import { handlePackApply, handlePackPreview } from './pack-api.js';
import { handleScaffoldApply, handleScaffoldPreview } from './scaffold-api.js';
import { handleExportBuild, handleExportPreview } from './export-api.js';
import { handleLaunchApply, handleLaunchPreview } from './launch-api.js';
import { handleProgress } from './progress-api.js';
// 分析类（只读）：mod 撞车 / 进度曲线 / 拆 mod / 配方来路去向 / KubeJS 脚本体检
import {
  handleKubejsAnalysis,
  handleModAnalysis,
  handleOverlapAnalysis,
  handleProgressAnalysis,
  handleRecipePathAnalysis,
  handleRecipeUsesAnalysis,
} from './analysis-api.js';
import { handleIconExportScan, handleIconExportStatus, handleItemIcons, handleWebItemIcon } from './icon-api.js';
/** 所有路由的前缀。界面那边也用这个常量，改一处就够。 */
export const API_BASE = '/api/mcstudio';

/**
 * 桌面版自己的根目录（= 本文件上两层）。
 *
 * 只用来找项目里的实验室副本 `lab\`，不参与任何写操作。
 * 用文件位置算而不是 process.cwd()：程序从别处启动时 cwd 不是这个目录。
 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 索引缓存住在 lib/host/cache.js 里。
 *
 * 一开始它只给这一个文件用，后来「改配方」那套接口也要读同一份索引和配方图，
 * 各存一份几十兆的 Map 纯属浪费，就搬出去共用了。
 */

/** 把异常翻译成界面能直接显示的结构。 */
function failure(error) {
  if (error instanceof McError) {
    return Response.json(
      { ok: false, error: error.message, hint: error.hint, code: error.code },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return Response.json(
    { ok: false, error: message, hint: '', code: 'McError' },
    { status: 500, headers: { 'cache-control': 'no-store' } },
  );
}

function ok(payload) {
  return Response.json({ ok: true, ...payload }, { headers: { 'cache-control': 'no-store' } });
}

function query(request) {
  return new URL(request.url).searchParams;
}

/** 必填的实例目录参数。 */
function needDir(request) {
  const dir = String(query(request).get('dir') ?? '').trim();
  if (!dir) {
    throw new McError(
      '缺少实例目录',
      '在界面顶部填一个整合包路径，例如 D:\\pcl2\\PCL 下载\\整合包\\xxx\\versions\\yyy',
      'McBadArgs',
    );
  }
  return dir;
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 一个目录里能扫出几个实例，扫不动就当 0。 */
function instancesIn(dir) {
  try {
    return inspectInstance(dir).length;
  } catch {
    return 0;
  }
}

/**
 * 把一个候选目录展开成「真的能扫出实例的目录」列表。
 *
 * 两种布局都要认：
 * - 直接布局：目录下就是 `versions/<实例>`（官方启动器、CurseForge、Prism）。
 * - 嵌套布局：目录下是若干「整合包文件夹」，每个里面有 `versions/<实例>`。
 *   PCL2 就是这种：`PCL 下载\整合包\<包名>\versions\<实例>`，比上面多一层。
 *
 * depth 控制往下挖几层。只有我们自己项目里的 `lab\` 会用 2 ——
 * 那是实验室副本，`lab\<包名>\versions` 比工作目录深两层，一层挖不到。
 * 其它候选（家目录、盘根）一律 1 层，别去扫大目录。
 */
function expandRoot(dir, label, depth = 1) {
  const direct = instancesIn(dir);
  if (direct > 0) return [{ label, dir, instances: direct }];
  if (depth <= 0) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    const count = instancesIn(sub);
    if (count > 0) {
      out.push({ label: `${label} / ${entry.name}`, dir: sub, instances: count });
      continue;
    }
    if (depth > 1) out.push(...expandRoot(sub, `${label} / ${entry.name}`, depth - 1));
  }
  return out;
}

/**
 * 「大概位置」深度搜索：用户选一个上层目录（比如 `D:\pcl2`、整个 `D:\`），
 * 自己往下挖，把所有能扫出实例的目录都翻出来。
 *
 * 和 expandRoot 的区别：
 * - expandRoot 是「已知这一两层里该有包」，层数写死、只往直系子目录看；
 * - 这里是「用户指着一个大目录说这里面肯定有，你帮我找」，必须自己往下走，
 *   同时必须有刹车 —— 否则选到整个 `C:\` 会卡死界面。
 *
 * 三道刹车：层数（depth）、看过的目录数（maxDirs）、总耗时（maxMs）。
 * 任何一个先到就停，并如实告诉用户「没找完，可以再选深一点/换个目录」。
 *
 * 只读：一个文件都不写，纯粹把扫到的目录列出来给界面看。
 */
const SCAN_SKIP_NAMES = new Set([
  'node_modules', '.git', '.gradle', '.cache', '.idea', '.vscode',
  'System Volume Information', '$RECYCLE.BIN', 'Windows', 'ProgramData',
  'libraries', 'assets', 'runtime', 'jre', 'logs', 'crash-reports', 'saves',
]);

function instanceBriefs(dir) {
  try {
    return inspectInstance(dir).map((i) => ({
      id: i.id,
      instanceDir: i.instanceDir,
      mcVersion: i.mcVersion,
      loader: i.loader,
      loaderVersion: i.loaderVersion,
      modsCount: i.modsCount,
    }));
  } catch {
    return [];
  }
}

function deepScan(dir, options = {}) {
  const maxDepth = Math.max(1, Math.min(6, Number(options.depth) || 4));
  const maxDirs = Math.max(50, Math.min(20000, Number(options.maxDirs) || 4000));
  const maxMs = Math.max(500, Math.min(60000, Number(options.maxMs) || 8000));

  const started = Date.now();
  const found = [];
  const seenDirs = new Set();
  let visited = 0;
  let stopped = ''; // 空串 = 正常走完；否则记着是哪道刹车停的

  // 广度优先：先看浅的。用户要找的东西通常不会埋在某条深分支里，
  // 深度优先会把预算耗在一条死路上。
  const queue = [{ dir, depth: 0 }];
  while (queue.length > 0) {
    if (Date.now() - started > maxMs) { stopped = 'time'; break; }
    if (visited >= maxDirs) { stopped = 'count'; break; }
    const item = queue.shift();
    let key;
    try {
      key = fs.realpathSync(item.dir).toLowerCase();
    } catch {
      key = item.dir.toLowerCase();
    }
    if (seenDirs.has(key)) continue; // 软链接成环时靠这个兜住
    seenDirs.add(key);
    visited += 1;

    // 这一层本身就是个能用的整合包根/实例目录？
    //
    // 2026-11-02 起把每个实例的摘要一起带上（instances + list）。
    // 原因：用户拿 `lab/重度机械症 - 实验` 去翻，界面只显示「3 个实例」，
    // 点「打开」却因为没指定 instanceId 被后端顶回来 —— 目录里到底有哪三个包，
    // 得让界面看得见、点得着。
    const list = instanceBriefs(item.dir);
    if (list.length > 0) {
      found.push({ dir: item.dir, instances: list.length, list });
      continue; // 已经是包了，别再往里钻（versions/ 里面全是噪音）
    }

    if (item.depth >= maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue; // 没权限的目录直接跳过，不中断整次搜索
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (SCAN_SKIP_NAMES.has(entry.name)) continue;
      queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 });
    }
  }

  return { roots: found, visited, depth: maxDepth, stopped, ms: Date.now() - started };
}

/**
 * 项目根在哪。
 *
 * 源码环境里 PLUGIN_ROOT 就是项目根；但打包成 exe 之后 api.js 住在
 * `dist/desktop/resources/app/lib/host/`，PLUGIN_ROOT 变成 `.../resources/app`，
 * 那底下没有 lab/ —— 于是桌面版永远扫不到实验室副本（用户 2026-11-02 报的就是这个）。
 *
 * 所以从 PLUGIN_ROOT 往上多找几层，谁底下有 lab/ 谁就是项目根。
 * 只用来「找 lab 目录」，不参与任何写操作。
 */
function projectRoots() {
  const out = [];
  let current = PLUGIN_ROOT;
  for (let i = 0; i < 5; i += 1) {
    if (dirExists(path.join(current, 'lab'))) out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/**
 * 找 PCL2 的下载目录。
 *
 * PCL2 是绿色版 exe，位置随用户放，没有注册表可查。但它的下载目录固定叫
 * `PCL 下载`，就放在 exe 旁边。所以扫几个常见落点下面的一层目录，
 * 看有没有 `PCL 下载` 这个名字。
 */
function pclDownloadDirs() {
  const home = os.homedir();
  const bases = [home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')];
  // 各个盘符的根也算，PCL 常被放在 D:\pcl2 这种位置
  for (const letter of 'CDEFGHIJ') {
    const drive = `${letter}:\\`;
    if (dirExists(drive)) bases.push(drive);
  }

  const found = new Set();
  for (const base of bases) {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const download = path.join(base, entry.name, 'PCL 下载');
      if (dirExists(download)) found.add(download);
    }
    // 少数人直接把「PCL 下载」放在 base 下
    const direct = path.join(base, 'PCL 下载');
    if (dirExists(direct)) found.add(direct);
  }
  return [...found];
}

/**
 * 记住用户成功打开过的整合包目录，下次 /roots 里也能看到。
 *
 * ## 为什么不能只放在内存里（2026-11-01 用户报「整合包识别被改坏了」）
 *
 * 以前这里是个 `Set`，进程一退就全忘。源码环境里无所谓（开发时一直开着），
 * 桌面版每次双击都是新进程 —— 用户上次打开的目录重启后从列表里消失，
 * 观感就是「识别坏了」。
 *
 * 所以落一份 JSON 到磁盘。位置按可靠性排序：
 * 1. 环境变量 `MCSTUDIO_DATA_DIR`（桌面版主进程会把它指到选好的用户数据目录）
 * 2. 程序根目录下的 `.mcstudio\`（源码环境，一定可写 —— 就是我们自己的目录）
 *
 * 写入策略：改了就写，写失败静默忽略（存储坏了不该挡住正常使用，大不了下次重记）。
 */
const rememberedRoots = new Set();

function rememberedStoreFile() {
  // 每次都重算环境变量：测试里 MCSTUDIO_DATA_DIR 会换，桌面版主进程也可能晚设。
  // 代价可忽略（一次字符串拼接），换来「改了环境变量立刻生效」。
  const base = process.env.MCSTUDIO_DATA_DIR || path.join(PLUGIN_ROOT, '.mcstudio');
  try {
    fs.mkdirSync(base, { recursive: true });
    return path.join(base, 'remembered-roots.json');
  } catch {
    return null;
  }
}

/** 启动后第一次用到时把磁盘上的记录读进来。读不到就当空的。 */
function loadRememberedRoots() {
  const file = rememberedStoreFile();
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw.roots)) {
      for (const item of raw.roots) {
        if (typeof item === 'string' && item.trim()) rememberedRoots.add(item.trim());
      }
    }
  } catch {
    /* 没有文件 / 内容坏了：当空的，下次写入会覆盖 */
  }
}

/** 把当前的记住目录写到磁盘。失败静默 —— 存储坏了不挡使用。 */
function saveRememberedRoots() {
  const file = rememberedStoreFile();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ roots: [...rememberedRoots] }, null, 2), 'utf8');
  } catch {
    /* 写不了就算了 */
  }
}

/** 测试和桌面版主进程都能用：忘掉所有记住的目录并删掉存储文件。 */
export function clearRememberedRoots() {
  rememberedRoots.clear();
  const file = rememberedStoreFile();
  if (file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 删不掉就算了 */
    }
  }
}

/**
 * 常见启动器的整合包存放位置。
 *
 * 只探测「存在且真的能扫出实例」的目录，扫不出来的不返回，免得界面上一堆死路径。
 */
function commonRoots() {
  const home = os.homedir();
  const candidates = [
    { label: '官方启动器', dir: path.join(home, 'AppData', 'Roaming', '.minecraft') },
    { label: '.minecraft（用户目录）', dir: path.join(home, '.minecraft') },
    { label: 'CurseForge', dir: path.join(home, 'curseforge', 'minecraft') },
    { label: 'Prism / MultiMC', dir: path.join(home, 'AppData', 'Roaming', 'PrismLauncher', 'instances') },
    { label: 'HMCL', dir: path.join(home, '.hmcl') },
    { label: '当前工作目录', dir: process.cwd() },
    // 我们自己的实验副本：`<项目根>\lab\<包名>\versions\<实例>`，比项目根深两层。
    // 用户第一次打开界面时就问过「怎么没扫到我那个测试包」，所以这条必须有。
    //
    // 2026-11-02 修：以前这里直接写 PLUGIN_ROOT\lab。打包成 exe 后 PLUGIN_ROOT 是
    // `...\resources\app`，那底下没有 lab，桌面版就一条都扫不到（用户报
    // 「几个测试用的整合包都找不到」）。改成往上找几层，谁底下有 lab 用谁。
    ...projectRoots().map((root) => ({
      label: '项目里的 lab（实验副本）',
      dir: path.join(root, 'lab'),
      depth: 2,
    })),
  ];
  for (const dir of pclDownloadDirs()) {
    candidates.push({ label: 'PCL2 下载目录', dir });
    // `PCL 下载\整合包` 是整合包那一层
    const packs = path.join(dir, '整合包');
    if (dirExists(packs)) candidates.push({ label: 'PCL2 整合包', dir: packs });
  }
  // 记住的目录单独打标记：界面靠这个标记显示「✕ 忘掉它」。
  // 注意不能靠 label === '上次打开过' 判断 —— 下面按目录去重时，记住项可能
  // 被排在前面的自动探测项吞掉，label 就变了。
  for (const dir of rememberedRoots) candidates.push({ label: '上次打开过', dir, remembered: true });

  const out = [];
  // key → 已经放进 out 的那个对象。记住项撞上自动项时，回头给已有对象补标记，
  // 而不是丢掉 —— 否则这个「上次打开过」就永远删不掉了（2026-11-04 第 3 批修）。
  const byKey = new Map();
  for (const c of candidates) {
    if (!dirExists(c.dir)) continue;
    for (const root of expandRoot(c.dir, c.label, c.depth ?? 1)) {
      const key = root.dir.toLowerCase();
      const existing = byKey.get(key);
      if (existing) {
        if (c.remembered) {
          existing.remembered = true;
          existing.rememberedDir = c.dir;
        }
        continue;
      }
      // rememberedDir 必须存「原始记住的那个字符串」：expandRoot 可能往下钻一层
      // 才扫到实例，这时 root.dir 是子目录、和记住值不一样，拿它去删会 200 却删不掉。
      if (c.remembered) {
        root.remembered = true;
        root.rememberedDir = c.dir;
      }
      byKey.set(key, root);
      out.push(root);
    }
  }
  return out;
}

/** GET /roots —— 界面启动时先问一句「哪些地方有整合包」。 */
function handleRoots() {
  // 「上次打开过」住磁盘：进程第一次用到时读一次，之后和内存 Set 同步。
  if (rememberedRoots.size === 0) loadRememberedRoots();
  return ok({ roots: commonRoots() });
}

/**
 * GET /roots/scan?dir=&depth=&maxDirs=&maxMs= —— 从一个「大概的位置」往下找整合包。
 *
 * 用户 2026-11-02 提的需求：「用户选一个大概的位置，然后自动往里面深度搜索」。
 * 所以这个接口收一个大目录（`D:\pcl2`、甚至整个 `D:\`），自己往下挖。
 *
 * **只读**：不写盘、不改记住列表。挖出来的目录交给界面展示，
 * 用户点「加进列表」时再走 `/roots/add` —— 让「看一看」和「记下来」分开。
 */
async function handleRootsScan(request) {
  const params = await readParams(request);
  const dir = String(params.dir ?? '').trim();
  if (!dir) throw new McError('缺少目录', '把想搜的那个上层目录传进来（比如 D:\\pcl2）', 'McBadArgs');
  if (!dirExists(dir)) throw new McError(`目录不存在：${dir}`, '确认路径没写错（可以带盘符的完整路径）', 'McBadArgs');

  const result = deepScan(dir, {
    depth: params.depth,
    maxDirs: params.maxDirs,
    maxMs: params.maxMs,
  });

  return ok({
    dir,
    // 每一条都自带 label，和 /roots 里的形状对齐，界面可以直接渲染。
    // list 里是这一处底下每个实例的摘要 —— 界面拿它展开成「一行一个包」，
    // 这样多实例目录（versions/ 里躺着好几个包）也能直接点进去。
    roots: result.roots.map((hit) => ({
      label: `深度搜索 / ${path.basename(hit.dir) || hit.dir}`,
      dir: hit.dir,
      instances: hit.instances,
      list: hit.list ?? [],
    })),
    visited: result.visited,
    depth: result.depth,
    stopped: result.stopped,
    ms: result.ms,
  });
}

/**
 * POST /roots/add —— 手动添加一个整合包目录。
 *
 * ## 为什么要有（2026-11-01 用户报「识别被改坏」的收尾）
 *
 * 自动探测只扫常见位置，用户的包放在别处（自制目录、U 盘、非默认盘符）就看不到。
 * 界面上「浏览…」选一个目录 → 走这个接口 → 存进持久化的记住列表，
 * 以后每次启动都在首屏列表里。目录必须真的能扫出实例，否则报错 —— 不收死路径。
 */
async function handleRootsAdd(request) {
  // 2026-11-02 修：这里原来只读 URL 查询串（`query(request)`），而界面是用
  // POST JSON body 发 `{dir}` 的（`post('/roots/add', {dir})`）—— 于是后端永远
  // 收不到 dir，界面上「全部收进列表」和老的「浏览…」都只会得到「缺少目录」。
  // 全仓其它 handler 早就在用 readParams 合并 query+body，只有这一层没跟上。
  const params = await readParams(request);
  const dir = String(params.dir ?? '').trim();
  if (!dir) throw new McError('缺少目录', '把选好的整合包文件夹路径传进来', 'McBadArgs');
  if (!dirExists(dir)) throw new McError(`目录不存在：${dir}`, '确认路径没写错（可以带盘符的完整路径）', 'McBadArgs');
  // 默认按「上次打开过」同款规则下钻一层，嵌套布局（PCL2）也能收。
  // 传了 depth 就往深处多挖几层（界面「深度搜索」那条路会带上它）。
  const depth = Math.max(1, Math.min(6, Number(params.depth) || 1));
  const expanded = depth > 1
    ? deepScan(dir, { depth }).roots.map((hit) => ({ label: '我添加的目录', dir: hit.dir, instances: hit.instances }))
    : expandRoot(dir, '我添加的目录', 1);
  if (expanded.length === 0) {
    throw new McError(
      '这个目录里找不到 Minecraft 实例',
      '要选包含 versions/ 的目录（比如 PCL 的「整合包」文件夹），或者直接选某个包的文件夹',
      'McBadArgs',
    );
  }
  if (rememberedRoots.size === 0) loadRememberedRoots();
  for (const hit of expanded) {
    rememberedRoots.add(hit.dir);
  }
  saveRememberedRoots();
  return { added: expanded };
}

/** POST /roots/remove —— 从「我添加的目录」里移除一条（自动探测的不受影响）。 */
async function handleRootsRemove(request) {
  // 和 /roots/add 同款修法：界面发 POST body，不能只读查询串。
  const params = await readParams(request);
  const dir = String(params.dir ?? '').trim();
  if (!dir) throw new McError('缺少目录', '把要移除的目录路径传进来', 'McBadArgs');
  if (rememberedRoots.size === 0) loadRememberedRoots();
  rememberedRoots.delete(dir);
  saveRememberedRoots();
  return { removed: dir };
}

/**
 * 解析实例，顺手把它的「整合包根目录」记下来。
 *
 * 记的是 `versions` 的上一级（例如 `PCL 下载\整合包\重度机械症`），
 * 这样用户手填一次路径之后，下次打开界面就能在常见位置里直接点。
 */
function resolveAndRemember(dir, id) {
  const instance = resolveInstance(dir, id);
  const parent = path.dirname(instance.instanceDir);
  const root = path.basename(parent).toLowerCase() === 'versions' ? path.dirname(parent) : parent;
  if (!rememberedRoots.has(root)) {
    rememberedRoots.add(root);
    saveRememberedRoots();
  }
  return instance;
}

/** GET /instances?root= —— 列出一个目录下的所有实例。 */
function handleInstances(request) {
  const root = String(query(request).get('root') ?? '').trim();
  if (!root) throw new McError('缺少目录', '传一个包含 versions/ 的 Minecraft 根目录', 'McBadArgs');
  const list = inspectInstance(root);
  return ok({
    root,
    instances: list.map((i) => ({
      id: i.id,
      instanceDir: i.instanceDir,
      mcVersion: i.mcVersion,
      loader: i.loader,
      loaderVersion: i.loaderVersion,
      modsCount: i.modsCount,
    })),
  });
}

/** GET /summary?dir=&id= —— 实例总览：版本、加载器、物品数、mod 数、命名空间。 */
function handleSummary(request) {
  const instance = resolveAndRemember(needDir(request), String(query(request).get('id') ?? ''));
  const refresh = query(request).get('refresh') === '1';
  const idx = cachedIndex(instance, refresh);
  return ok({
    instance: {
      id: instance.id,
      instanceDir: instance.instanceDir,
      mcVersion: instance.mcVersion,
      loader: instance.loader,
      loaderVersion: instance.loaderVersion,
      modsCount: instance.modsCount,
      disabledModsCount: instance.disabledModsCount,
      presentDirs: instance.presentDirs,
      questDirs: instance.questDirs,
    },
    index: {
      itemCount: idx.itemCount,
      recipeCount: idx.recipeCount,
      jarCount: idx.jarCount,
      jarFailed: idx.jarFailed,
      modIdResolved: idx.modIdResolved,
      indexedMs: idx.indexedMs,
      namespaces: idx.namespaces.slice(0, 20),
    },
  });
}

/** GET /items?dir=&id=&q=&ns=&mod=&limit= —— 物品搜索。 */
function handleItems(request) {
  const q = query(request);
  const keyword = String(q.get('q') ?? '').trim();
  const namespace = String(q.get('ns') ?? '').trim();
  const modId = String(q.get('mod') ?? '').trim();
  const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 40) || 40, 200));

  // 先判参数再解析实例：没给关键字就不必去扫 jar，界面输入框还空着的时候也不会白等一秒
  if (!keyword && !namespace && !modId) {
    return ok({ total: 0, shown: 0, items: [], indexedMs: 0, hint: '输入关键字，或指定命名空间 / mod' });
  }

  const instance = resolveAndRemember(needDir(request), String(q.get('id') ?? ''));
  const idx = cachedIndex(instance, q.get('refresh') === '1');
  const r = searchItems(idx._items.values(), {
    query: keyword,
    namespace,
    modId,
    limit,
    names: idx._names,
  });
  // 简介（语言文件里的 `*.tooltip.summary` / `*.desc` 等）一并带上：
  // 界面要「鼠标停留一会儿显示物品简介，没有简介就不显示」，就靠这个字段判断。
  // 没简介的物品**不加 desc 字段**，省得界面把空字符串当成「有简介」。
  const items = r.items.map((it) => {
    const desc = idx.describe?.(it.id) ?? '';
    return desc ? { ...it, desc } : it;
  });
  return ok({ total: r.total, shown: r.shown, items, indexedMs: idx.indexedMs });
}

/** GET /mods?dir=&id= —— mod 清单（按物品数倒序）。 */
function handleMods(request) {
  const instance = resolveAndRemember(needDir(request), String(query(request).get('id') ?? ''));
  const idx = cachedIndex(instance, query(request).get('refresh') === '1');
  const mods = [...idx.mods]
    .sort((a, b) => b.items - a.items)
    .map((m) => ({
      modId: m.modId,
      name: m.name,
      version: m.version,
      items: m.items,
      recipes: m.recipes,
      file: m.file,
    }));
  return ok({ mods, unresolved: idx.unresolvedMods.slice(0, 30) });
}

/**
 * GET /pick-folder —— 让宿主弹一个系统选文件夹对话框。
 *
 * 界面那边只能拿到文件夹名字、拿不到绝对路径（网页的安全限制），所以这件事
 * 必须在宿主侧做。详见 lib/host/pick-folder.js。
 *
 * 这个接口**立刻返回**，不等用户选完 —— 用户可能把对话框开着翻半天目录。
 * 界面随后轮询 /pick-folder/status 拿结果。
 */
function handlePickFolder() {
  return ok(beginPickFolder());
}

/** GET /pick-folder/status —— 选完了没有、选到了哪个路径。 */
function handlePickFolderStatus() {
  const state = pickFolderStatus();
  return ok({
    status: state.status,
    path: state.path,
    canceled: state.status === 'idle' && !state.path,
    error: state.error,
    hint: state.hint,
    code: state.code,
  });
}

/**
 * GET /mcp/config —— 生成可以直接贴进 DSH 的 MCP 配置。
 *
 * 桌面版自带一个 MCP 服务器（packages/mcp/server.mjs），DSH 侧用
 * @deepseek-ai/dsh-mcp-client 连它；连上之后模型就能直接改这个整合包，
 * 而且走的是和界面点着改完全相同的那套底层函数。
 *
 * 可选参数 dir：当前连着的整合包目录。会写进 env 里的 MCSTUDIO_PACK_DIR，
 * 这样模型调工具时不用每次都报路径。
 */
async function handleMcpConfig(request) {
  const { buildConfig } = await import('../../packages/mcp/config.mjs');
  const packDir = String(query(request).get('dir') ?? '').trim();
  return ok(buildConfig({ packDir }));
}

/**
 * GET /mcp/selftest —— 自己跑一次 MCP 握手，看看服务器是不是好的。
 *
 * 界面上的「自检」按钮调它：握手成功就报工具数，不成功就报原因。
 */
async function handleMcpSelfTest() {
  const { runSelfTest } = await import('../../packages/mcp/protocol.mjs');
  const result = await runSelfTest();
  return ok(result);
}

/**
 * 路由表：`[路径后缀, 处理函数, 允许的方法]`。
 *
 * 方法省略就是 GET。改配方要真写文件，所以那一条是 POST ——
 * 让「看一眼」和「动文件」在 HTTP 层面就分开，而不是靠参数名区分。
 */
const ROUTES = [
  ['/roots', handleRoots],
  // 从一个「大概的位置」往下深度找整合包：只读，不写盘（用户 2026-11-02 提的）
  ['/roots/scan', handleRootsScan],
  // 手动添加 / 移除整合包目录：add 会把目录写进持久化的记住列表（算「动文件」，POST）
  ['/roots/add', handleRootsAdd, ['POST']],
  ['/roots/remove', handleRootsRemove, ['POST']],
  ['/instances', handleInstances],
  ['/summary', handleSummary],
  ['/items', handleItems],
  // 物品网格（JEI 那种 9×16 翻页面板）：不带关键字也要能翻，返回带总数/页码/总页数。
  // 和 /items 分开是因为两者的形状不一样（/items 是「搜到了给我几条」的候选列表）。
  ['/item-grid', handleItemGrid, ['GET', 'POST']],
  // 标签清单：给界面做「# 后面打几个字，提示有哪些标签」
  ['/item-tags', handleItemTags, ['GET', 'POST']],
  // 游戏真值清单：让游戏自己导出 jeidump.json，软件只读不写用户包（2026-11-07 用户要 100% 精确）。
  // status 只回报「有没有 / 哪来的 / 多少条」，import 才把清单存进软件自己的数据目录。
  ['/item-truth/status', handleItemTruthStatus],
  ['/item-truth/import', handleItemTruthImport, ['POST']],
  // 中文名补全：默认完全离线，preview 只读不联网，只有 apply（POST）才真下载。
  // 数据来自 CFPA 社区汉化包，CC BY-NC-SA 4.0，只存软件自己的数据目录，不碰整合包。
  ['/name/preview', handleNamePreview, ['GET', 'POST']],
  ['/name/apply', handleNameApply, ['POST']],
  ['/mods', handleMods],
  ['/pick-folder', handlePickFolder],
  ['/pick-folder/status', handlePickFolderStatus],
  ['/recipes', handleItemRecipes],
  ['/recipe', handleRecipeDetail],
  // 界面 previewRecipe() 用 post() 发 JSON body，之前只登记 GET 会 405（2026-11-08 修）
  ['/recipe/preview', handleRecipePreview, ['GET', 'POST']],
  ['/recipe/apply', handleRecipeApply, ['POST']],
  // 批量改配方：多条合并成一份脚本一次写盘，循环调单条会互相覆盖（2026-11-08 加）
  ['/recipe/batch/preview', handleRecipeBatchPreview, ['GET', 'POST']],
  ['/recipe/batch/apply', handleRecipeBatchApply, ['POST']],
  // 看配方长什么样（JEI 那种合成表）：只读，GET/POST 都收。
  // 单独一条而不是塞进 /recipe，是因为它的返回多了格子布局，形状和编辑表单不一样。
  ['/recipe/view', handleRecipeView, ['GET', 'POST']],
  ['/questbook', handleQuestBook],
  ['/quests', handleQuestList],
  ['/quest', handleQuestDetail],
  // 条件/奖励类型目录：界面画表单用，只读
  ['/quest/condition-types', handleQuestConditionTypes],
  // 改已有任务的预览：界面 previewRename() 用 post() 发 JSON body，之前只登记 GET 会 405（第 4 批 B 修）
  ['/quest/preview', handleQuestPreview, ['GET', 'POST']],
  ['/quest/apply', handleQuestApply, ['POST']],
  // 从零建任务 / 建章节：preview 只算不写，apply 才落盘
  ['/quest/add/preview', handleQuestAddPreview, ['GET', 'POST']],
  ['/quest/add/apply', handleQuestAddApply, ['POST']],
  ['/quest/chapter/preview', handleChapterAddPreview, ['GET', 'POST']],
  ['/quest/chapter/apply', handleChapterAddApply, ['POST']],
  // 拖拽画布：canvas 只读；挪坐标 preview 只算不写，apply 才落盘
  ['/quest/canvas', handleQuestCanvas],
  // 章节背景图批量取图：POST 传 srcs 数组；GET 方便单张调试。只读不写盘
  ['/quest/images', handleQuestImages, ['GET', 'POST']],
  ['/quest/move/preview', handleQuestMovePreview, ['GET', 'POST']],
  ['/quest/move/apply', handleQuestMoveApply, ['POST']],
  // 右键编辑节点：换图标 / 改前置依赖 / 删掉这个任务 —— 同样是 preview 只算、apply 才落盘
  ['/quest/node/preview', handleQuestNodePreview, ['GET', 'POST']],
  ['/quest/node/apply', handleQuestNodeApply, ['POST']],
  ['/quest/node/delete/preview', handleQuestNodeDeletePreview, ['GET', 'POST']],
  ['/quest/node/delete/apply', handleQuestNodeDeleteApply, ['POST']],
  // 蓝图式编辑（2026-11-09）：物品拖进节点＝追加要求；拖到空白＝新建节点；复制整个节点。
  // 三条都是 preview 只算、apply 才写盘，循环调单条会互相覆盖的老坑这里不存在。
  ['/quest/node/items/preview', handleQuestNodeItemsPreview, ['GET', 'POST']],
  ['/quest/node/items/apply', handleQuestNodeItemsApply, ['POST']],
  ['/quest/clone/preview', handleQuestClonePreview, ['GET', 'POST']],
  ['/quest/clone/apply', handleQuestCloneApply, ['POST']],
  ['/quest/spawn/preview', handleQuestSpawnPreview, ['GET', 'POST']],
  ['/quest/spawn/apply', handleQuestSpawnApply, ['POST']],
  // 章节装饰图（贴在画布上的背景图）：加 / 挪 / 删。preview 只算，apply 才落盘
  ['/quest/image/preview', handleQuestImagePreview, ['GET', 'POST']],
  ['/quest/image/apply', handleQuestImageApply, ['POST']],
  // 找 mod / 装 mod：搜索和版本列表是只读的 GET；
  // 算清单（preview）不写盘，但也允许 POST，因为 mod 列表可能一长串；
  // 真下载落盘只有 apply 一条，且是 POST。
  ['/mod-search', handleModSearch],
  ['/mod-versions', handleModVersions],
  ['/mod-install/preview', handleModInstallPreview, ['GET', 'POST']],
  ['/mod-install/apply', handleModInstallApply, ['POST']],
  // 整包兼容性体检（2026-11-06）：只读，一个文件都不写
  ['/mod-compat', handleModCompat, ['GET', 'POST']],
  // 检查 mod 更新（2026-11-07）：check 只读联网、preview 只算清单、apply 才写盘
  ['/mod-update/check', handleModUpdateCheck, ['GET', 'POST']],
  ['/mod-update/preview', handleModUpdatePreview, ['GET', 'POST']],
  ['/mod-update/apply', handleModUpdateApply, ['POST']],
  // 安全增强（2026-11-07 第二轮）：锁定名单 GET 只读 / POST 才写；撤回两态，apply 才写盘
  ['/mod-update/locks', handleModUpdateLocks, ['GET', 'POST']],
  ['/mod-update/rollback/preview', handleModUpdateRollbackPreview, ['GET', 'POST']],
  ['/mod-update/rollback/apply', handleModUpdateRollbackApply, ['POST']],
  // 从零建包：先算计划（GET 也行，参数少），真建只有一条 POST
  ['/pack/preview', handlePackPreview, ['GET', 'POST']],
  ['/pack/apply', handlePackApply, ['POST']],
  // 从零装底座（选版本向导）：preview 会联网查清单但不写盘，apply 会下几百 MB
  ['/scaffold/preview', handleScaffoldPreview, ['GET', 'POST']],
  ['/scaffold/apply', handleScaffoldApply, ['POST']],
  // 打包：预览可以 GET，真打 zip 只能 POST
  ['/export/preview', handleExportPreview, ['GET', 'POST']],
  ['/export/build', handleExportBuild, ['POST']],
  // 物品图标：只读，一批 ID 换一批 data URL。允许 POST 是因为一次可能几十上百个 ID
  ['/item-icons', handleItemIcons, ['GET', 'POST']],
  ['/icon-export/status', handleIconExportStatus, ['GET', 'POST']],
  ['/icon-export/scan', handleIconExportScan, ['POST']],
  // 单个物品去 MC百科 找图标：只做「点一下查一张」，因为对面有反爬频率限制
  ['/item-icon/web', handleWebItemIcon, ['GET', 'POST']],
  // 启动验证：preview 只算命令行、绝不启动进程；真启动只有一条 POST 且必须显式 apply: true
  ['/launch/preview', handleLaunchPreview, ['GET', 'POST']],
  ['/launch/apply', handleLaunchApply, ['POST']],
  // 长任务的进度：只读，界面拿 jobId 隔一会儿问一次（装 mod / 装底座 / 打包都用它）
  ['/progress', handleProgress, ['GET', 'POST']],
  // 分析类：全是只读（一个文件都不写）。以前只以模型工具的形态存在，
  // 插件版删掉之后搬到桌面版：这几条路由 + 界面上的「分析」工具页。
  ['/analysis/overlap', handleOverlapAnalysis, ['GET', 'POST']],
  ['/analysis/progress', handleProgressAnalysis, ['GET', 'POST']],
  ['/analysis/mod', handleModAnalysis, ['GET', 'POST']],
  ['/analysis/recipe-path', handleRecipePathAnalysis, ['GET', 'POST']],
  ['/analysis/recipe-uses', handleRecipeUsesAnalysis, ['GET', 'POST']],
  ['/analysis/kubejs', handleKubejsAnalysis, ['GET', 'POST']],
  // 「让模型帮你改包」：桌面版自带一个 MCP 服务器，DSH 连上它之后模型就能直接改包。
  // 两条都是只读：一条给配置（贴进 DSH 用），一条给自检（握手跑一遍看工具数）。
  ['/mcp/config', handleMcpConfig],
  ['/mcp/selftest', handleMcpSelfTest],
];

/**
 * 把一条请求派发到对应的处理函数上，返回 Web Response。
 *
 * 这里不关心请求从哪来：DSH 的认证通道（registerStudioApi）和独立软件里的
 * 本地 HTTP 服务（packages/server）都走这一条，保证「点界面改」和「独立版改」
 * 是同一套逻辑，不会出现两套行为。
 *
 * @param {{url: string, method?: string, text?: () => Promise<string>}} request
 */
export async function dispatchStudioRequest(request) {
  const url = new URL(request.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname.startsWith(API_BASE)) pathname = pathname.slice(API_BASE.length);
  // 允许带尾部斜杠：/roots 和 /roots/ 都认
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  const method = String(request.method ?? 'GET').toUpperCase();

  const hit = ROUTES.find(([suffix]) => suffix === pathname);
  if (!hit) {
    return Response.json(
      { ok: false, error: `没有这个接口：${pathname}`, hint: '检查路径拼写，或看 docs/archive/HANDOFF-NEXT.md 里的接口清单', code: 'McNoRoute' },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }

  const [suffix, handler, methods] = hit;
  const allowed = methods ?? ['GET'];
  if (!allowed.includes(method)) {
    return Response.json(
      { ok: false, error: `${suffix} 只接受 ${allowed.join(' / ')}，收到 ${method}`, hint: '改配方、写任务书这类会动文件的操作都是 POST', code: 'McBadMethod' },
      { status: 405, headers: { 'cache-control': 'no-store' } },
    );
  }

  try {
    // 用 await 而不是 Promise.resolve：这样 handler 就算是异步的，
    // 抛出的错误也会落进 catch，不会变成一个没人管的 rejected promise。
    const result = await handler(request);
    if (result instanceof Response) return result;
    return ok(result ?? {});
  } catch (error) {
    return failure(error);
  }
}

/**
 * 把界面要用的路由挂到 DSH 的认证通道上。
 *
 * @param {object} connection DSH 的 connection 服务（ctx.connection）
 */
export function registerStudioApi(connection) {
  for (const [suffix, , methods] of ROUTES) {
    connection.fetch.register({
      path: API_BASE + suffix,
      methods: methods ?? ['GET'],
      requestBody: 'buffered',
      fetch: (request) => dispatchStudioRequest(request),
    });
  }
}

/** 测试用：清掉索引缓存、配方图缓存、任务书缓存和记住的目录，避免用例之间互相影响。 */
export function resetStudioApiCache() {
  resetCaches();
  resetQuestCache();
  clearRememberedRoots();
  clearTruthCache();
}