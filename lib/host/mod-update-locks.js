/**
 * 「mod 更新锁定名单」：记住这个整合包里哪些 mod 不要再提示更新。
 *
 * 为什么要它（2026-11-07 用户追问「作者已经魔改过的 mod 怎么办」）：
 * 有些 mod 是整合包作者手工改过、或故意锁死旧版的，升级会坏包。
 * 用户把这类 mod 标成「锁定」，检查更新时就不再把它算进「能升」，
 * 升级清单里也绝对不会出现它（core 里还做了第二道保险）。
 *
 * ## 存哪（硬规矩）
 *
 * 和 `lib/host/item-truth.js` 完全同一套：**只写软件自己的数据目录**，
 * 绝不写进用户的整合包、绝不改用户包里任何一个字。位置是环境变量
 * `MCSTUDIO_DATA_DIR`（桌面版主进程指到用户数据目录），没设就退到程序
 * 根目录的 `.mcstudio/`，文件名 `mod-update-locks.json`，按 `dir|id`
 * 分键，一个整合包一份名单。
 *
 * ## 名单里存什么
 *
 * 每条是 `{ modId, projectId, fileName, name, lockedAt }`。
 * **故意不存 sha1**：升级后文件的哈希就变了，靠 modId / projectId /
 * 旧文件名才锁得住下一次。core 的 isLocked() 也是按这三个字段匹配。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McError } from '../../packages/core/errors.js';
import { resolveInstance } from '../../packages/core/instance.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 每次都重算环境变量：测试里 MCSTUDIO_DATA_DIR 会换，桌面版也可能晚设。 */
function storeFile() {
  const base = process.env.MCSTUDIO_DATA_DIR || path.join(PLUGIN_ROOT, '.mcstudio');
  try {
    fs.mkdirSync(base, { recursive: true });
    return path.join(base, 'mod-update-locks.json');
  } catch {
    return null;
  }
}

/**
 * 把界面传的 dir/id 归一成同一个键。照抄 item-truth.js 的踩坑经验：
 * 界面 instanceId 可能是空串、dir 可能是启动器根目录，统一走一次
 * resolveInstance 才能让「写」和「读」落在同一个键上。
 */
function normalize(dir, id) {
  let base = path.resolve(String(dir ?? ''));
  let realId = String(id ?? '').trim();
  try {
    const inst = resolveInstance(base, realId);
    base = inst.instanceDir;
    realId = inst.id;
  } catch {
    /* 目录还不是实例（或没连包）就保持原样，读不到名单自然退回空名单 */
  }
  return `${path.resolve(base).toLowerCase()}|${realId}`;
}

// 名单很小，但每次检查更新都要读一次，缓存起来；写盘后主动让缓存失效。
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

/** 测试用：只清内存缓存，不动磁盘（真实名单不该被测试删掉）。 */
export function clearLocksCache() {
  cachedStamp = -1;
  cachedAll = {};
  cachedFile = '';
}

/** 摊平一条名单项；三个标识字段一个都没有就丢掉（锁不住的东西不存）。 */
export function cleanLock(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const modId = String(item.modId ?? '').trim();
  const projectId = String(item.projectId ?? '').trim();
  const fileName = String(item.fileName ?? '').trim();
  if (!modId && !projectId && !fileName) return null;
  return {
    modId,
    projectId,
    fileName,
    name: String(item.name ?? '').trim(),
    lockedAt: String(item.lockedAt ?? new Date().toISOString()),
  };
}

/** 一条名单项的去重键：优先 modId，其次 projectId，最后旧文件名。 */
function keyOf(entry) {
  const item = cleanLock(entry);
  if (!item) return '';
  const value = item.modId || item.projectId || item.fileName;
  return value.toLowerCase();
}

/** 把一串输入摊成干净的名单（认数组 / JSON 串 / 逗号串），顺手去重。 */
export function cleanLocks(value) {
  let list = value;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list)) list = [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const item = cleanLock(raw);
    if (!item) continue;
    const key = keyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 读这个整合包的锁定名单（只读，不写盘）。
 * @returns {Array<{modId: string, projectId: string, fileName: string, name: string, lockedAt: string}>}
 */
export function readLocks(dir, id) {
  const all = loadAll();
  return cleanLocks(all[normalize(dir, id)] ?? []);
}

/** 整包保存名单；写不进去就明确报错，不假装保存成功。 */
export function saveLocks(dir, id, entries) {
  const out = storeFile();
  if (!out) {
    throw new McError('软件数据目录写不了', '换一个可写的用户数据目录再试', 'McLocksStore');
  }
  const items = cleanLocks(entries);
  const all = loadAll();
  all[normalize(dir, id)] = items;
  fs.writeFileSync(out, JSON.stringify(all), 'utf8');
  cachedStamp = -1;
  return items;
}

/**
 * 在现有名单上加/减一条。action：`add`（同键覆盖）/ `remove`（按同键删）/ `clear`。
 * 返回改完后的完整名单；真正落盘由 saveLocks 负责。
 */
export function applyLockChange(current, action, entry) {
  const items = cleanLocks(current);
  const act = String(action ?? 'add').trim() || 'add';
  if (act === 'clear') return [];
  const target = cleanLock(entry);
  if (!target) return items;
  const key = keyOf(target);
  if (!key) return items;
  const kept = items.filter((item) => keyOf(item) !== key);
  if (act === 'remove') return kept;
  return [...kept, target];
}
