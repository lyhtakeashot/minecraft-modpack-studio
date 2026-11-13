/**
 * mod 版本兼容：读 jar 里的依赖声明，判「装得装不得」。
 *
 * 为什么单独一层：这是「点界面改」和「让模型改」必须共用的判定依据，
 * 而它最适合纯函数单测 —— 造几段假的 mods.toml 就能覆盖各种边界，
 * 不需要真下载、也不需要真游戏。
 *
 * 事实来源（2026-11-06 照抄 PCL 社区版源码 + 实测用户整合包）：
 * - PCL `ref/pcl-ce/ModLocalComp.cs:919` AddDependency / :905 _AddConflict：
 *   依赖与冲突是**两回事**。`type="incompatible"`（硬冲突）与 `"discouraged"`（劝退）
 *   单独记成冲突声明；其余（required / optional / 没写 type）记成依赖。
 * - `ref/pcl-ce/ModLocalComp.cs:946-952`：版本约束的归一化：
 *   空 / 带 `$` 占位符 → 忽略；裸版本号 → 变成 `[版本,)`；
 *   其余按 Maven 区间语法（`[1.0,2.0)`、`(,1.0]`）原样理解。
 * - `ref/pcl-ce/ModLocalComp.cs:1914-1915`：`side="server"` 的依赖与客户端无关，跳过。
 * - `ref/pcl-ce/ModComp.cs:3745-3767` IsInstanceSuitableForFile：
 *   文件声明的 MC 版本里只要有带点号的，就必须有一个等于实例的 MC 版本；
 *   加载器按 Forge/Cleanroom/Fabric/LegacyFabric/NeoForge/Quilt/LiteLoader 逐个认。
 *
 * 实测依据（用户整合包 lab/重度机械症 - 实验，2026-11-06）：
 *   `sable` 内嵌的 `veil 4.1.4` 声明 `sodium(incompatible (,0.8.12-alpha.2+mc1.21.1])`，
 *   而包里有两个同 modId 的 sodium（0.7.3 与 0.8.12）—— 这类冲突以前软件完全看不见，
 *   起真游戏时连崩三次才定位到。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { openZip } from './zip.js';

/** 依赖类型。分「要装」和「别装」两拨，后者是冲突声明。 */
export const DEP_REQUIRED = 'required';
export const DEP_OPTIONAL = 'optional';
export const DEP_INCOMPATIBLE = 'incompatible';
export const DEP_DISCOURAGED = 'discouraged';

/** 平台伪依赖（加载器 / minecraft 本身）不当作「缺前置」来报。 */
const PLATFORM_IDS = new Set([
  'minecraft', 'neoforge', 'forge', 'fabric', 'quilt', 'java', 'fml', 'minecraftforge', 'javafml',
]);

/** 最多扫多少个 jar（防止离谱目录把进程拖死）。 */
export const MAX_SCAN_JARS = 600;

// ————————————————————————— 解析 mods.toml —————————————————————————

/**
 * 读一个 jar 里的 mod 声明与依赖声明。
 *
 * 同时认三种写法：
 *   - `META-INF/neoforge.mods.toml`（NeoForge 新版）
 *   - `META-INF/mods.toml`（Forge / NeoForge 老版）
 *   - `fabric.mod.json`（Fabric）
 *
 * @param {Buffer} buffer jar 字节
 * @returns {{modIds: Array<{modId: string, version: string, name: string}>, deps: Array<object>, error: string}}
 */
export function readJarMeta(buffer) {
  let zip;
  try {
    zip = openZip(buffer);
  } catch (error) {
    return { modIds: [], deps: [], error: error?.message ?? String(error) };
  }
  const tomlName = zip.names.find((n) => n === 'META-INF/neoforge.mods.toml')
    ?? zip.names.find((n) => n === 'META-INF/mods.toml');
  if (tomlName) {
    const text = zip.text(tomlName);
    if (text) return parseModToml(text);
  }
  const fabric = zip.text('fabric.mod.json');
  if (fabric) return parseFabricMeta(fabric);
  return { modIds: [], deps: [], error: '' };
}

/**
 * 解析 fabric.mod.json（Fabric 的依赖写在 depends 数组里，全当必需前置）。
 *
 * @param {string} text fabric.mod.json 的内容
 * @returns {{modIds: Array<{modId: string, version: string, name: string}>, deps: Array<object>, error: string}}
 */
export function parseFabricMeta(text) {
  try {
    const j = JSON.parse(String(text ?? ''));
    const modIds = [{ modId: String(j?.id ?? ''), version: String(j?.version ?? ''), name: String(j?.name ?? '') }];
    const deps = [];
    for (const dep of Array.isArray(j?.depends) ? j.depends : []) {
      deps.push({
        declarer: modIds[0]?.modId ?? '',
        target: String(dep ?? ''),
        type: DEP_REQUIRED,
        versionRange: '',
        side: 'BOTH',
        ordering: 'NONE',
      });
    }
    return { modIds, deps, error: '' };
  } catch (error) {
    return { modIds: [], deps: [], error: error?.message ?? String(error) };
  }
}

/**
 * 解析 mods.toml 文本。
 *
 * 三种依赖写法都要认（PCL 也都认）：
 *   ① `[[dependencies.xxx]]` 块 —— 块头 xxx 是**声明方**，块正文里的 modId 是**目标**。
 *   ② `dependencies.xxx=[{...}]` 内联数组。
 *   ③ `dependencies.xxx="target"` 简写（字符串，就是 required 依赖）。
 *
 * 注意：块正文里 `ordering` 与 `side` 的先后顺序不固定，不能按顺序假设。
 */
export function parseModToml(text) {
  const src = String(text ?? '');
  const modIds = parseModBlocks(src);
  const deps = [];

  // ① [[dependencies.xxx]] 块
  const blocks = [...src.matchAll(/\[\[dependencies\.([^\]]+)\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)/g)];
  for (const [, declarer, body] of blocks) {
    const target = fieldOf(body, 'modId');
    if (!target) continue;
    deps.push(makeDep(declarer, target, body));
  }

  // ② dependencies.xxx=[{...}] 内联数组（用引号感知的括号配平扫描，别用懒惰正则，
  //    否则 versionRange="[1.21.1]" 里的 ] 会把数组提前截断）
  for (const inline of extractInlineDepArrays(src)) {
    for (const obj of inline.objects) {
      const target = fieldOf(obj, 'modId');
      if (!target) continue;
      deps.push(makeDep(inline.declarer, target, obj));
    }
  }

  // ③ dependencies.xxx="target" 简写
  for (const m of src.matchAll(/^\s*dependencies\.([A-Za-z0-9_\-]+)\s*=\s*"([^"]+)"/gm)) {
    deps.push({
      declarer: m[1],
      target: m[2],
      type: DEP_REQUIRED,
      versionRange: '',
      side: 'BOTH',
      ordering: 'NONE',
    });
  }

  return { modIds, deps, error: '' };
}

/** 读 `[[mods]]` 块：modId / version / displayName。 */
function parseModBlocks(src) {
  const out = [];
  const blocks = [...src.matchAll(/\[\[mods\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)/g)];
  for (const [, body] of blocks) {
    const modId = fieldOf(body, 'modId');
    if (!modId) continue;
    out.push({
      modId,
      version: fieldOf(body, 'version'),
      // 没写 displayName 就回落成 modId —— 界面上至少有个能显示的名字。
      name: fieldOf(body, 'displayName') || fieldOf(body, 'name') || modId,
    });
  }
  return out;
}

/** 把一个依赖块（正文文本）归一成统一形状。 */
function makeDep(declarer, target, body) {
  const rawType = fieldOf(body, 'type').toLowerCase();
  const mandatory = fieldOf(body, 'mandatory').toLowerCase();
  let type = DEP_REQUIRED;
  if (rawType === DEP_INCOMPATIBLE || rawType === DEP_DISCOURAGED) type = rawType;
  else if (rawType === DEP_OPTIONAL || mandatory === 'false') type = DEP_OPTIONAL;
  return {
    declarer: String(declarer ?? ''),
    target: String(target ?? ''),
    type,
    versionRange: fieldOf(body, 'versionRange'),
    side: (fieldOf(body, 'side') || 'BOTH').toUpperCase(),
    ordering: (fieldOf(body, 'ordering') || 'NONE').toUpperCase(),
  };
}

/** 取一个字段的值（双引号 / 单引号都认）。 */
function fieldOf(body, key) {
  const re = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(String(body ?? ''));
  return m ? (m[1] ?? m[2] ?? '') : '';
}

/** 扫出所有 `dependencies.xxx = [ ... ]` 内联数组（引号感知的方括号配平）。 */
function extractInlineDepArrays(src) {
  const out = [];
  const re = /dependencies[.\w""-]*\s*=\s*\[/g;
  for (const m of src.matchAll(re)) {
    const header = m[0].slice(0, m[0].indexOf('=')).trim();
    const declarer = header.slice('dependencies'.length).trim().replace(/^\./, '').replace(/"/g, '');
    const start = m.index + m[0].length;
    let depth = 1;
    let inStr = false;
    let end = -1;
    for (let i = start; i < src.length; i += 1) {
      const ch = src[i];
      if (inStr) {
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    const body = src.slice(start, end);
    const objects = [...body.matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]);
    out.push({ declarer, objects });
  }
  return out;
}

// ————————————————————————— 版本比较与区间 —————————————————————————

/** 预发布标识的次序（比大小用）。 */
const QUALIFIER_RANK = {
  snapshot: 0, dev: 0, alpha: 1, a: 1, beta: 2, b: 2, rc: 3, cr: 3, '': 4, ga: 4, final: 4, release: 4, sp: 5,
};

/**
 * 版本号按分隔符切成 token：数字段与非数字段分开。
 *
 * 两处「现实修正」（都是用户整合包 2026-11-06 实测出来的）：
 * 1. `+` 后面是构建号（1.0.0+mc1.21.1 / 1.0.0+build1），比版本时忽略。
 * 2. 末尾紧跟数字的**单个字母**当构建标记（`1.10.0b` → `1.10.0`）。
 *    真实例子：`create_dragons_plus` 版本号是 `1.10.0b`，它自己声明依赖
 *    `create_dragons_plus [1.10.0,)`；按 Maven 语义 `1.10.0b` 等于 `1.10.0-beta`，
 *    比 `1.10.0` 低，会被误报「版本对不上」—— 但作者那个 `b` 其实是「第 2 个构建」。
 *    `alpha` / `beta` / `rc` 这类多字母预发布词不受影响。
 */
function tokenize(version) {
  const head = String(version ?? '').split('+')[0].trim();
  const cleaned = head.replace(/(\d)([a-z])$/i, '$1');
  return cleaned
    .split(/[.\-_]/)
    .filter((part) => part !== '');
}

/**
 * 比较两个版本号：a < b 返回负数，相等返回 0。
 *
 * 数字段按数值比；非数字段按预发布次序比（alpha < beta < rc < 正式版）。
 * 这不是 Maven 的完整 ComparableVersion，但足以判绝大多数 mod 的版本约束。
 */
export function compareVersions(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i += 1) {
    const x = ta[i] ?? '';
    const y = tb[i] ?? '';
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    if (nx) return 1; // 数字段大于字母段（1.0 > 1.0-alpha）
    if (ny) return -1;
    const rx = QUALIFIER_RANK[x.toLowerCase()] ?? 4;
    const ry = QUALIFIER_RANK[y.toLowerCase()] ?? 4;
    if (rx !== ry) return rx < ry ? -1 : 1;
    const strCmp = x.localeCompare(y);
    if (strCmp !== 0) return strCmp < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * 判某个版本是否落在区间里。
 *
 * 支持三类写法：
 * 1. Maven 区间：`[1.0]`（精确匹配）、`[1.0,2.0)`、`[1.0,)`、`(,1.0]`、`(,1.0)`；
 * 2. Fabric / Quilt 的 semver 谓词：`>=1.0.0`、`<2.0.0`、`~1.2.3`、`^1.2.3`，空格分隔是「且」，`||` 是「或」；
 * 3. 裸版本号：`1.2.3` 当成 `[1.2.3,)`（PCL 同款包装）。
 *
 * 空区间 / 带 `$` 占位符 → 一律当成「没有约束」（PCL 同款处理）。
 * 纯数字或纯词的裸版本号（不含 `.` `-`）→ 也当成没有约束（PCL `ModLocalComp.cs:946-952`）。
 */
export function satisfiesRange(version, range) {
  const raw = String(range ?? '').trim();
  if (!raw) return true;
  if (raw.includes('$')) return true;

  // 被比较的版本号本身是占位符（`${file.jarVersion}`，真实包里 jadeaddons / l2hostility 就是），
  // 没有真版本可比 → 当没有约束，不报「版本对不上」。
  if (String(version ?? '').includes('$')) return true;

  // PCL 同款：既没有点号也没有横杠的裸版本号不算约束（"2"、"beta" 这类）。
  if (!raw.includes('.') && !raw.includes('-') && !raw.includes('[') && !raw.includes('(')) {
    return true;
  }

  // 「或」：任意一段成立即可。
  const orParts = raw.split('||').map((part) => part.trim()).filter(Boolean);
  if (orParts.length > 1) return orParts.some((part) => satisfiesRange(version, part));

  // Maven 区间写法。
  //
  // 区间里允许有空格（真实包里就有 `[21.1, 21.2)`、`[15.10, )` 这种写法，
  // 来自 attributefix / jadeaddons 等 mod），所以只在这里把空格去掉，
  // 不能全局删 —— semver 谓词用空格表示「且」（`>=1.0.0 <2.0.0`）。
  if (raw.startsWith('[') || raw.startsWith('(')) {
    const compact = raw.replace(/\s+/g, '');
    const m = /^([\[\(])([^,\]\)]*)(,?)([^,\]\)]*)([\]\)])$/.exec(compact);
    if (!m) return true;
    const [, left, lower, comma, upper, right] = m;
    // `[1.0]` 是精确匹配（上下界都等于 1.0 且都闭合）。
    if (comma === '') {
      if (left === '[' && right === ']') return compareVersions(version, lower) === 0;
      return true; // `(1.0)` 不是合法写法 → 当没有约束
    }
    if (lower !== '') {
      const c = compareVersions(version, lower);
      if (left === '[' ? c < 0 : c <= 0) return false;
    }
    if (upper !== '') {
      const c = compareVersions(version, upper);
      if (right === ']' ? c > 0 : c >= 0) return false;
    }
    return true;
  }

  // semver 谓词写法：带运算符的按谓词算（Fabric / Quilt 常用）。
  if (/^(>=|<=|>|<|=|~|\^)/.test(raw) || /\s/.test(raw)) {
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    return tokens.every((token) => satisfiesPredicate(version, token));
  }

  // 形如 `1.21-1.3` 的怪写法（真实包里 mynethersdelight → farmersdelight 就是）：
  // 作者想说的是「适配 MC 1.21 的 1.3 系列」，不是版本区间。
  // 取后面那段（mod 自己的版本）当约束，前面那段当 MC 版本标记。
  const mcPrefix = /^(\d+\.\d{2})-(\d+(?:\.\d+)*)$/.exec(raw);
  if (mcPrefix && Number(mcPrefix[1].split('.')[1]) >= 16) {
    return satisfiesRange(version, `[${mcPrefix[2]},)`);
  }

  // 裸版本号 → 当成 [版本,)（PCL `ModLocalComp.cs:946-952` 同款包装）。
  return satisfiesRange(version, `[${raw},)`);
}

/** 判一条 semver 谓词（`>=1.0.0` 之类）。 */
function satisfiesPredicate(version, token) {
  const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(token);
  if (!m) return true;
  const op = m[1] ?? '';
  const target = String(m[2] ?? '').trim();
  if (!target) return true;
  const c = compareVersions(version, target);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '~': {
      // ~1.2.3 → >=1.2.3 且 <1.3.0
      const parts = target.split('.');
      const upper = `${parts[0]}.${Number(parts[1] ?? 0) + 1}.0`;
      return c >= 0 && compareVersions(version, upper) < 0;
    }
    case '^': {
      // ^1.2.3 → >=1.2.3 且 <2.0.0
      const parts = target.split('.');
      const upper = `${Number(parts[0] ?? 0) + 1}.0.0`;
      return c >= 0 && compareVersions(version, upper) < 0;
    }
    case '=': return c === 0;
    default: return c === 0;
  }
}

// ————————————————————————— 实例适配 —————————————————————————

/**
 * 这个版本文件适不适合用户那个 MC 版本（只看 MC 版本，不看加载器）。
 *
 * PCL 的原话（`ModComp.cs:3745-3767`）：文件声明的 MC 版本里只要有带点号的，
 * 就必须有一个正好等于实例版本；一个都没写（空列表）就当全都支持。
 *
 * @param {string[]} gameVersions 文件声明支持的 MC 版本
 * @param {string} mcVersion 用户整合包的 MC 版本（空＝不知道，算支持）
 * @returns {boolean}
 */
export function mcVersionMatches(gameVersions, mcVersion) {
  const list = Array.isArray(gameVersions) ? gameVersions.map((v) => String(v)) : [];
  const want = String(mcVersion ?? '').trim();
  if (!want) return true;
  const dotted = list.filter((v) => v.includes('.'));
  if (dotted.length === 0) return true;
  return dotted.includes(want);
}

/**
 * 判某个版本文件适不适合当前实例（PCL `ModComp.cs:3745-3767` 的等价物）。
 *
 * @param {{gameVersions?: string[], loaders?: string[]}} file
 * @param {{gameVersion?: string, loader?: string}} instance
 * @returns {{ok: boolean, reason: string}}
 */
export function isSuitableForInstance(file, instance) {
  const gameVersions = Array.isArray(file?.gameVersions) ? file.gameVersions.map((v) => String(v)) : [];
  const loaders = Array.isArray(file?.loaders) ? file.loaders.map((v) => String(v).toLowerCase()) : [];
  const mcVersion = String(instance?.gameVersion ?? '').trim();
  const loader = String(instance?.loader ?? '').trim().toLowerCase();

  // PCL 的原话：文件声明的 MC 版本里只要有带点号的，就必须有一个正好等于实例版本。
  const dotted = gameVersions.filter((v) => v.includes('.'));
  if (dotted.length > 0 && mcVersion && !dotted.includes(mcVersion)) {
    return { ok: false, reason: `这个版本只支持 ${dotted.join('、')}，你的整合包是 ${mcVersion}` };
  }

  if (loaders.length > 0 && loader && !loaders.includes(loader)) {
    return { ok: false, reason: `这个版本只支持 ${loaders.join('、')} 加载器，你的整合包是 ${loader}` };
  }
  return { ok: true, reason: '' };
}

// ————————————————————————— 轻量读 jar（不整包解压） —————————————————————————

/** zip 中央目录项的签名。 */
const CEN_SIG = 0x02014b50;
/** zip 中央目录结尾记录（EOCD）的签名。 */
const EOCD_SIG = 0x06054b50;
/** 本地文件头签名。 */
const LOC_SIG = 0x04034b50;
/** EOCD 最多能有多长（注释最长 65535 字节 + 头部 22 字节）。 */
const EOCD_MAX = 65557;

/**
 * 解析 zip 中央目录的字节（纯逻辑，sync/async 两条路共用）。
 *
 * @param {Buffer} cd 中央目录字节
 * @param {number} total 条目数
 * @returns {Array<{name: string, method: number, compressedSize: number, size: number, localOffset: number}>}
 */
export function parseCentralDirectory(cd, total) {
  const entries = [];
  let off = 0;
  for (let i = 0; i < total && off + 46 <= cd.length; i += 1) {
    if (cd.readUInt32LE(off) !== CEN_SIG) break;
    const method = cd.readUInt16LE(off + 10);
    const compressedSize = cd.readUInt32LE(off + 20);
    const size = cd.readUInt32LE(off + 24);
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const localOffset = cd.readUInt32LE(off + 42);
    const name = cd.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compressedSize, size, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 在文件尾里找 EOCD（zip 中央目录结尾记录）。
 *
 * @param {Buffer} tail 文件尾字节
 * @returns {{total: number, cdSize: number, cdOffset: number}}
 */
export function findEocd(tail) {
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      return {
        total: tail.readUInt16LE(i + 10),
        cdSize: tail.readUInt32LE(i + 12),
        cdOffset: tail.readUInt32LE(i + 16),
      };
    }
  }
  return null;
}

/**
 * 把某个条目的压缩字节解成明文（纯逻辑，sync/async 两条路共用）。
 *
 * @param {Buffer} raw 压缩后的字节
 * @param {number} method 压缩方式（0=不压缩，8=deflate）
 * @returns {Buffer|null}
 */
export function decodeJarEntry(raw, method) {
  try {
    if (method === 0) return raw;
    if (method === 8) return zlib.inflateRawSync(raw);
    return null;
  } catch {
    return null;
  }
}

/**
 * 只读一个 jar 的中央目录 —— 不解压、不把整个文件读进内存。
 *
 * 为什么不用 openZip：openZip 要整包 Buffer。用户的整合包 mods 目录动辄几百 MB，
 * 全读进来会把界面卡住；这里只读文件尾（找 EOCD）+ 中央目录（几千字节），
 * 再按偏移单独取那几 KB 元数据。
 *
 * @param {string} filePath jar 路径
 * @returns {{entries: Array<{name: string, method: number, compressedSize: number, size: number, localOffset: number}>, error: string}}
 */
export function readJarDirectory(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.size) return { entries: [], error: '文件是空的' };

    // ① 读文件尾找 EOCD
    const tailLen = Math.min(stat.size, EOCD_MAX);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen);
    const eocd = findEocd(tail);
    if (!eocd) return { entries: [], error: '不是有效的 jar（找不到目录结尾）' };

    // ② 读中央目录
    const cd = Buffer.alloc(eocd.cdSize);
    fs.readSync(fd, cd, 0, eocd.cdSize, eocd.cdOffset);
    return { entries: parseCentralDirectory(cd, eocd.total), error: '' };
  } catch (error) {
    return { entries: [], error: error?.message ?? String(error) };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 关闭失败不影响结果 */ }
    }
  }
}

/**
 * 异步版 readJarDirectory（避免几百个 jar 一起读时卡住界面）。
 *
 * @param {string} filePath jar 路径
 * @returns {Promise<{entries: Array<object>, error: string}>}
 */
export async function readJarDirectoryAsync(filePath) {
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.size) return { entries: [], error: '文件是空的' };
    const tailLen = Math.min(stat.size, EOCD_MAX);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, stat.size - tailLen);
    const eocd = findEocd(tail);
    if (!eocd) return { entries: [], error: '不是有效的 jar（找不到目录结尾）' };
    const cd = Buffer.alloc(eocd.cdSize);
    await handle.read(cd, 0, eocd.cdSize, eocd.cdOffset);
    return { entries: parseCentralDirectory(cd, eocd.total), error: '' };
  } catch (error) {
    return { entries: [], error: error?.message ?? String(error) };
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* 关闭失败不影响结果 */ }
    }
  }
}

/**
 * 按中央目录项取出某个条目的内容（只解压这一条）。
 *
 * @param {string} filePath jar 路径
 * @param {{method: number, compressedSize: number, size: number, localOffset: number}} entry
 * @returns {Buffer|null} 读不出来返回 null
 */
export function readJarEntry(filePath, entry) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(30);
    fs.readSync(fd, header, 0, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== LOC_SIG) return null;
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const raw = Buffer.alloc(entry.compressedSize);
    fs.readSync(fd, raw, 0, entry.compressedSize, start);
    return decodeJarEntry(raw, entry.method);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 关闭失败不影响结果 */ }
    }
  }
}

/**
 * 异步版 readJarEntry。
 *
 * @param {string} filePath jar 路径
 * @param {{method: number, compressedSize: number, size: number, localOffset: number}} entry
 * @returns {Promise<Buffer|null>}
 */
export async function readJarEntryAsync(filePath, entry) {
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== LOC_SIG) return null;
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const raw = Buffer.alloc(entry.compressedSize);
    await handle.read(raw, 0, entry.compressedSize, start);
    return decodeJarEntry(raw, entry.method);
  } catch {
    return null;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* 关闭失败不影响结果 */ }
    }
  }
}

/** 从一个 jar 里取出 mod 声明（元数据那几个文件），整包 buffer 走 readJarMeta。 */
function metaFromDirectory(filePath, entries) {
  const tomlEntry = entries.find((e) => e.name === 'META-INF/neoforge.mods.toml')
    ?? entries.find((e) => e.name === 'META-INF/mods.toml');
  if (tomlEntry) {
    const buf = readJarEntry(filePath, tomlEntry);
    if (buf) {
      const text = buf.toString('utf8');
      if (text.trim()) return parseModToml(text);
    }
  }
  const fabricEntry = entries.find((e) => e.name === 'fabric.mod.json');
  if (fabricEntry) {
    const buf = readJarEntry(filePath, fabricEntry);
    if (buf) {
      const text = buf.toString('utf8');
      if (text.trim()) return parseFabricMeta(text);
    }
  }
  return { modIds: [], deps: [], error: '' };
}

/**
 * 读一个 jar 文件里的 mod 声明（不整包读进内存）。
 *
 * @param {string} filePath jar 路径
 * @returns {{modIds: Array<object>, deps: Array<object>, error: string, nested: Array<{name: string, buffer: Buffer}>}}
 */
export function readJarMetaFile(filePath) {
  const dir = readJarDirectory(filePath);
  if (dir.error) return { modIds: [], deps: [], error: dir.error, nested: [] };
  const meta = metaFromDirectory(filePath, dir.entries);
  // jarjar 内嵌的 mod 也要能看到（用户包里 sable 内嵌 veil 就是这种）。
  const nested = [];
  for (const entry of dir.entries) {
    if (!/^META-INF\/jarjar\/.+\.jar$/.test(entry.name)) continue;
    const buf = readJarEntry(filePath, entry);
    if (buf) nested.push({ name: entry.name, buffer: buf });
  }
  return { ...meta, nested };
}

// ————————————————————————— 扫已装的 mod —————————————————————————

/**
 * 扫一遍 mods 目录，把每个 jar 的 modId / 版本 / 依赖声明读出来。
 *
 * 只读文件头与元数据，不全量解压 —— 几百个 jar 全量解压会把界面卡住。
 * jarjar 内嵌的 mod（`META-INF/jarjar/*.jar`）也会被读出来，
 * 因为用户整合包里 `sable` 就是把 `veil` 塞在内嵌 jar 里声明冲突的。
 *
 * @param {string} modsDir
 * @returns {{modsDir: string, mods: Array<object>, count: number, failed: number}}
 */
export function scanInstalledMods(modsDir) {
  const base = path.resolve(modsDir ?? '');
  const mods = [];
  let failed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return { modsDir: base, mods, count: 0, failed: 0 };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.jar')) continue;
    if (mods.length >= MAX_SCAN_JARS) break;
    const file = path.join(base, entry.name);
    const meta = readJarMetaFile(file);
    if (meta.error && meta.modIds.length === 0) {
      failed += 1;
      continue;
    }
    pushModEntries(mods, {
      file: entry.name,
      path: file,
      modIds: meta.modIds,
      deps: meta.deps,
      embedded: false,
    });
    // 内嵌 jar 里的 mod 也要看：它们的依赖声明正是冲突的来源。
    for (const inner of meta.nested ?? []) {
      const innerMeta = readJarMeta(inner.buffer);
      if (innerMeta.modIds.length === 0) continue;
      pushModEntries(mods, {
        file: `${entry.name} → ${inner.name}`,
        path: file,
        modIds: innerMeta.modIds,
        deps: innerMeta.deps,
        embedded: true,
      });
    }
  }
  return { modsDir: base, mods, count: mods.length, failed };
}

/**
 * 异步版 scanInstalledMods（逐个 await，避免几百个 jar 一起读时卡界面）。
 *
 * @param {string} modsDir
 * @returns {Promise<{modsDir: string, mods: Array<object>, count: number, failed: number}>}
 */
export async function scanInstalledModsAsync(modsDir) {
  const base = path.resolve(modsDir ?? '');
  const mods = [];
  let failed = 0;
  let entries = [];
  try {
    entries = await fs.promises.readdir(base, { withFileTypes: true });
  } catch {
    return { modsDir: base, mods, count: 0, failed: 0 };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.jar')) continue;
    if (mods.length >= MAX_SCAN_JARS) break;
    const file = path.join(base, entry.name);
    const dir = await readJarDirectoryAsync(file);
    if (dir.error) {
      failed += 1;
      continue;
    }
    const tomlEntry = dir.entries.find((e) => e.name === 'META-INF/neoforge.mods.toml')
      ?? dir.entries.find((e) => e.name === 'META-INF/mods.toml');
    let meta = { modIds: [], deps: [] };
    if (tomlEntry) {
      const buf = await readJarEntryAsync(file, tomlEntry);
      if (buf) meta = parseModToml(buf.toString('utf8'));
    }
    if (!meta.modIds.length) {
      const fabricEntry = dir.entries.find((e) => e.name === 'fabric.mod.json');
      if (fabricEntry) {
        const buf = await readJarEntryAsync(file, fabricEntry);
        if (buf) meta = parseFabricMeta(buf.toString('utf8'));
      }
    }
    pushModEntries(mods, {
      file: entry.name,
      path: file,
      modIds: meta.modIds,
      deps: meta.deps,
      embedded: false,
    });
    for (const inner of dir.entries) {
      if (!/^META-INF\/jarjar\/.+\.jar$/.test(inner.name)) continue;
      const buf = await readJarEntryAsync(file, inner);
      if (!buf) continue;
      const innerMeta = readJarMeta(buf);
      if (!innerMeta.modIds.length) continue;
      pushModEntries(mods, {
        file: `${entry.name} → ${inner.name}`,
        path: file,
        modIds: innerMeta.modIds,
        deps: innerMeta.deps,
        embedded: true,
      });
    }
  }
  return { modsDir: base, mods, count: mods.length, failed };
}

/**
 * 把一个 jar 里读到的 modId 列表展开成体检用的条目。
 *
 * @param {Array<object>} out 结果数组（就地 push）
 * @param {{file: string, path: string, modIds: Array<object>, deps: Array<object>, embedded: boolean}} info
 */
function pushModEntries(out, info) {
  const modIds = Array.isArray(info.modIds) ? info.modIds : [];
  if (modIds.length === 0) {
    // 认不出 modId 的 jar（纯库）也要留着，冲突判定用得上它的命名空间。
    out.push({
      file: info.file,
      path: info.path,
      modId: '',
      version: '',
      name: '',
      deps: info.deps ?? [],
      unknown: true,
      embedded: info.embedded,
    });
    return;
  }
  for (const info2 of modIds) {
    const id = String(info2.modId ?? '').toLowerCase();
    out.push({
      file: info.file,
      path: info.path,
      modId: id,
      version: String(info2.version ?? ''),
      name: String(info2.name ?? ''),
      deps: (info.deps ?? []).filter((d) => !d.declarer || String(d.declarer).toLowerCase() === id),
      unknown: false,
      embedded: info.embedded,
    });
  }
}

/**
 * 给已装的 mod 做一次体检：谁跟谁冲突、谁缺前置、谁的版本对不上、谁重复装了。
 *
 * @param {Array<object>} mods scanInstalledMods 得到的列表
 * @returns {{conflicts: Array, missing: Array, versionMismatch: Array, duplicates: Array, ok: boolean}}
 */
export function checkInstalled(mods) {
  const list = Array.isArray(mods) ? mods : [];
  const byId = new Map();
  for (const mod of list) {
    if (!mod?.modId) continue;
    if (!byId.has(mod.modId)) byId.set(mod.modId, []);
    byId.get(mod.modId).push(mod);
  }

  const conflicts = [];
  const missing = [];
  const versionMismatch = [];
  const seenConflict = new Set();

  for (const mod of list) {
    for (const dep of mod.deps ?? []) {
      const target = String(dep.target ?? '').toLowerCase();
      if (!target) continue;
      if (String(dep.side ?? 'BOTH').toUpperCase() === 'SERVER') continue;

      if (dep.type === DEP_INCOMPATIBLE || dep.type === DEP_DISCOURAGED) {
        const installed = byId.get(target) ?? [];
        for (const other of installed) {
          // 区间不匹配就不算冲突（例如「与 sodium 0.8.12 以下不兼容」，装的却是 0.8.12）。
          if (dep.versionRange && !satisfiesRange(other.version, dep.versionRange)) continue;
          const key = `${mod.modId}|${target}|${dep.type}`;
          if (seenConflict.has(key)) continue;
          seenConflict.add(key);
          conflicts.push({
            kind: dep.type,
            hard: dep.type === DEP_INCOMPATIBLE,
            from: mod.modId,
            fromVersion: mod.version,
            fromFile: mod.file,
            target,
            targetVersion: other.version,
            targetFile: other.file,
            versionRange: dep.versionRange ?? '',
          });
        }
        continue;
      }

      if (dep.type === DEP_OPTIONAL) continue;
      if (PLATFORM_IDS.has(target)) continue;
      const installed = byId.get(target) ?? [];
      if (installed.length === 0) {
        missing.push({
          from: mod.modId,
          fromVersion: mod.version,
          fromFile: mod.file,
          target,
          versionRange: dep.versionRange ?? '',
        });
        continue;
      }
      for (const other of installed) {
        if (!dep.versionRange) continue;
        if (satisfiesRange(other.version, dep.versionRange)) continue;
        versionMismatch.push({
          from: mod.modId,
          fromVersion: mod.version,
          fromFile: mod.file,
          target,
          targetVersion: other.version,
          targetFile: other.file,
          versionRange: dep.versionRange,
        });
      }
    }
  }

  // 同一个 modId 装了多份 —— 用户包里两个 sodium 就是这种（0.7.3 与 0.8.12）。
  //
  // 但要排除一种假阳性：同一个 jar 被好几个外层 jar 用 jarjar 重复内嵌，
  // 版本完全一样（例如 fabric_api_base 被 flerovium / iris / sodium 各内嵌一份）。
  // 那种情况游戏里只算一份，不是问题 —— 按版本去重后再看还剩几份。
  const duplicates = [];
  for (const [modId, group] of byId) {
    if (group.length < 2) continue;
    const seenVersions = new Set();
    const picked = [];
    for (const g of group) {
      const version = String(g.version ?? '');
      if (seenVersions.has(version)) continue;
      seenVersions.add(version);
      picked.push(g);
    }
    if (picked.length < 2) continue;
    duplicates.push({
      modId,
      files: picked.map((g) => ({ file: g.file, version: g.version })),
    });
  }

  return {
    conflicts,
    missing,
    versionMismatch,
    duplicates,
    ok: conflicts.length === 0 && missing.length === 0 && versionMismatch.length === 0 && duplicates.length === 0,
  };
}

/**
 * 给整包做一次体检（同步版）。
 *
 * 界面上的「查兼容」按钮用这个；装完 mod 之后也会再跑一次，看新装的有没有惹麻烦。
 *
 * @param {string} modsDir 实例的 mods 目录
 * @returns {{modsDir: string, count: number, failed: number, mods: Array, conflicts: Array, missing: Array, versionMismatch: Array, duplicates: Array, ok: boolean, lines: string[]}}
 */
export function compatReport(modsDir) {
  const scan = scanInstalledMods(modsDir);
  const check = checkInstalled(scan.mods);
  return {
    modsDir: scan.modsDir,
    count: scan.count,
    failed: scan.failed,
    mods: scan.mods,
    ...check,
    lines: describeCompat(check),
  };
}

/**
 * 给整包做一次体检（异步版）。
 *
 * 用异步读盘是为了不卡界面：用户的 mods 目录里可能有几百个 jar，
 * 同步版会把主进程堵住几秒钟。
 *
 * @param {string} modsDir 实例的 mods 目录
 */
export async function compatReportAsync(modsDir) {
  const scan = await scanInstalledModsAsync(modsDir);
  const check = checkInstalled(scan.mods);
  return {
    modsDir: scan.modsDir,
    count: scan.count,
    failed: scan.failed,
    mods: scan.mods,
    ...check,
    lines: describeCompat(check),
  };
}

/** 把体检结果说成人话。 */
export function describeCompat(result) {
  const lines = [];
  const conflicts = result?.conflicts ?? [];
  const missing = result?.missing ?? [];
  const mismatch = result?.versionMismatch ?? [];
  const duplicates = result?.duplicates ?? [];
  if (conflicts.length === 0 && missing.length === 0 && mismatch.length === 0 && duplicates.length === 0) {
    lines.push('没发现版本兼容问题。');
    return lines;
  }
  if (conflicts.length > 0) {
    lines.push(`⚠ 有 ${conflicts.length} 处互斥（装上去游戏可能直接崩）：`);
    for (const c of conflicts) {
      const range = c.versionRange ? `（限制：${c.versionRange}）` : '';
      lines.push(`- ${c.from} ${c.fromVersion} 与 ${c.target} ${c.targetVersion} 不兼容${range}`);
    }
  }
  if (duplicates.length > 0) {
    lines.push(`⚠ 有 ${duplicates.length} 个 mod 装了多份（同 modId，后来那份会顶掉前面那份）：`);
    for (const d of duplicates) {
      lines.push(`- ${d.modId}：${d.files.map((f) => `${f.file}（${f.version}）`).join('、')}`);
    }
  }
  if (missing.length > 0) {
    lines.push(`缺少 ${missing.length} 个前置：`);
    for (const m of missing) {
      const range = m.versionRange ? `（要 ${m.versionRange}）` : '';
      lines.push(`- ${m.from} 需要 ${m.target}${range}`);
    }
  }
  if (mismatch.length > 0) {
    lines.push(`有 ${mismatch.length} 处版本对不上：`);
    for (const m of mismatch) {
      lines.push(`- ${m.from} 要 ${m.target} ${m.versionRange}，装的是 ${m.targetVersion}`);
    }
  }
  return lines;
}
