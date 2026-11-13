/**
 * 「游戏真值清单」：软件自己存一份「这个整合包里游戏真的注册了哪些物品」。
 *
 * ## 为什么要它（2026-11-07 用户拍板「要 100% 精确」）
 *
 * 物品网格原来是「把索引里扫到的东西全列出来」，里面混着兼容配方残留、
 * 内嵌 assets 残留等游戏里其实不存在的条目（真实包里多出 1384 条）。
 * 离线猜哪些该留怎么都猜不准，所以改成**让游戏自己说**：
 * 用户在游戏里装探针 mod（lab/jeidump/）导出一份 `jeidump.json`，
 * 里面 `registries.item` 就是游戏 ITEM 注册表的全集。软件只读这份清单，
 * 网格默认只显示清单里有的，做到 100% 精确。
 *
 * ## 清单放哪（硬规矩）
 *
 * **只写软件自己的数据目录**，绝不写进用户的整合包、绝不打包进成品、
 * 绝不写死任何用户包路径。位置跟 `lib/host/api.js:345` 的 remembered-roots
 * 完全同一套：环境变量 `MCSTUDIO_DATA_DIR`（桌面版主进程指到用户数据目录），
 * 没有就退到程序根目录的 `.mcstudio/`。按 `dir|id` 分键，一个包一份。
 *
 * ## 没清单怎么办（兜底钉死）
 *
 * 读不到 → 一律返回 `null`，网格那边就「显示全部」（老行为），
 * 界面明写「还没导入游戏清单，当前显示全部」，不假装精确也不空白。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McError } from '../../packages/core/errors.js';
import { resolveInstance } from '../../packages/core/instance.js';
import { readParams } from './params.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 每次都重算环境变量：测试里 MCSTUDIO_DATA_DIR 会换，桌面版也可能晚设。 */
function storeFile() {
  const base = process.env.MCSTUDIO_DATA_DIR || path.join(PLUGIN_ROOT, '.mcstudio');
  try {
    fs.mkdirSync(base, { recursive: true });
    return path.join(base, 'item-truth.json');
  } catch {
    return null;
  }
}

/**
 * 把界面传的 dir/id 和后端 instance 对象归一成同一个键。
 *
 * ★ 两个坑，都是「导入写键」和「网格读键」对不上：
 *   ① 界面 `state.instanceId` 可能是空串（`connect(dir)` 没传 id），
 *      而 `resolveInstance(dir, '')` 选出的实例 `.id` 是目录名（如 `DemoPack`）；
 *   ② 界面传的 dir 可能是启动器根目录 `<root>`，而网格侧 `truthInfoOf(instance)`
 *      用的是解析后的 `instance.instanceDir`（`<root>/versions/DemoPack`）。
 * 所以这里**统一**走一次 resolveInstance：能解析就用它的 instanceDir/id 当键，
 * 两边自然落在同一个键上；解析不了（还没连包/目录不是实例）就保持原样，
 * 后面读不到清单自然退回「显示全部」。
 */
function normalize(dir, id) {
  let base = path.resolve(String(dir ?? ''));
  let realId = String(id ?? '').trim();
  try {
    const inst = resolveInstance(base, realId);
    base = inst.instanceDir;
    realId = inst.id;
  } catch {
    /* 目录还不是实例（或没连包）就保持原样，读不到清单自然走「显示全部」 */
  }
  return `${path.resolve(base).toLowerCase()}|${realId}`;
}

// 清单文件不大（约 200 KB），但翻页/搜索每条请求都要用，读一次盘缓存起来；
// 用「文件路径 + 修改时间」判断失效，导入写盘后会主动把 stamp 置 -1。
let cachedFile = '';
let cachedStamp = -1;
let cachedAll = {};

function loadAll() {
  const file = storeFile();
  if (!file) return {};
  let stamp;
  try {
    stamp = fs.statSync(file).mtimeMs;
  } catch {
    cachedFile = file; cachedStamp = -1; cachedAll = {};
    return cachedAll;
  }
  if (file === cachedFile && stamp === cachedStamp) return cachedAll;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    cachedAll = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    cachedAll = {};
  }
  cachedFile = file;
  cachedStamp = stamp;
  return cachedAll;
}

/** 测试用：只清内存缓存，不动磁盘（真实数据不该被测试删掉）。 */
export function clearTruthCache() {
  cachedStamp = -1;
  cachedAll = {};
  cachedFile = '';
}

/**
 * 读一份清单的内部表示。
 * @returns {{set: Set<string>, source: string, count: number}|null}
 */
function readEntry(dir, id) {
  const all = loadAll();
  const entry = all[normalize(dir, id)];
  if (!entry || !Array.isArray(entry.ids)) return null;
  return {
    set: new Set(entry.ids.map((x) => String(x ?? '').trim()).filter(Boolean)),
    source: String(entry.source ?? ''),
    count: Number(entry.count ?? entry.ids.length) || entry.ids.length,
  };
}

/** 界面 `/item-truth/status` 用：只回报有没有、来自哪、多少条，不回传 8000 个 ID。 */
export function statusOf(dir, id) {
  const hit = readEntry(dir, id);
  return hit
    ? { has: true, source: hit.source, count: hit.count }
    : { has: false, source: '', count: 0 };
}

/**
 * 网格用：拿到「这个实例」的清单集合。
 * `instance` 是 `resolveInstance()` 的返回（带 instanceDir / id）。
 * 返回 `null` 表示没导入过清单 —— 调用方必须退回「显示全部」。
 */
export function truthInfoOf(instance) {
  if (!instance) return null;
  return readEntry(instance.instanceDir, instance.id);
}

/** 施工单里点名的别名：只要一个 Set，没有就 null。 */
export function truthSetOf(instance) {
  return truthInfoOf(instance)?.set ?? null;
}

/**
 * 导入清单。`file` 既可以是 jeidump.json 的完整路径，也可以是**它所在的目录**
 * （界面用现成的「选文件夹」对话框选游戏目录，后端自动拼上 jeidump.json）。
 * 想换 JEI 显示口径（types[item_stack].ingredients）只改这里取哪个数组即可。
 */
export function importTruth({ dir, id, file } = {}) {
  const raw = String(file ?? '').trim();
  if (!raw) {
    throw new McError('没给清单文件', '选一下游戏目录（里面有 jeidump.json 的那个），或直接给 jeidump.json 的路径', 'McBadArgs');
  }
  if (!String(dir ?? '').trim()) {
    throw new McError('缺少实例目录', '先在界面顶部连一个整合包，再导入清单', 'McBadArgs');
  }
  let target = path.resolve(raw);
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'jeidump.json');
  } catch {
    /* 文件不存在就照原路径走，下面 readFileSync 会给出中文报错 */
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new McError(
      `读不了清单文件：${error instanceof Error ? error.message : String(error)}`,
      '确认选的是游戏探针 mod 导出的 jeidump.json（一般在游戏目录下）',
      'McBadTruth',
    );
  }
  const ids = data?.registries?.item;
  if (!Array.isArray(ids)) {
    throw new McError('这份文件里没有 registries.item 清单', '要选游戏探针 mod 导出的 jeidump.json，不是别的文件', 'McBadTruth');
  }
  const clean = [...new Set(ids.map((x) => String(x ?? '').trim()).filter(Boolean))];
  if (!clean.length) {
    throw new McError('清单里一条物品都没有', '重新在游戏里导出一次 jeidump.json', 'McBadTruth');
  }
  const out = storeFile();
  if (!out) throw new McError('软件数据目录写不了', '换一个可写的用户数据目录再试', 'McTruthStore');
  const all = loadAll();
  all[normalize(dir, id)] = {
    source: target,
    count: clean.length,
    ids: clean,
    importedAt: new Date().toISOString(),
  };
  fs.writeFileSync(out, JSON.stringify(all), 'utf8');
  cachedStamp = -1; // 刚写完，强制下次重读
  return { has: true, source: target, count: clean.length };
}

/** GET /item-truth/status —— 界面问「这个包导过清单没」。 */
export async function handleItemTruthStatus(request) {
  const p = await readParams(request);
  const dir = String(p.dir ?? '').trim();
  if (!dir) throw new McError('缺少实例目录', '先在界面顶部连一个整合包', 'McBadArgs');
  return { instance: String(p.id ?? ''), ...statusOf(dir, p.id) };
}

/** POST /item-truth/import —— 导入游戏导出的 jeidump.json（写软件数据目录，不写用户包）。 */
export async function handleItemTruthImport(request) {
  const p = await readParams(request);
  return importTruth({ dir: p.dir, id: p.id, file: p.file });
}
