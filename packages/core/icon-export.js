/**
 * 读「游戏自己导出的图标」。
 *
 * 为什么走这条路：任务书里要显示物品长什么样，光靠翻 jar 里的贴图只能拿到
 * 大约 86% 的物品 —— 剩下那些用三维模型（`.obj`）渲染的物品（Create 的水车、
 * 机械钻头、流体管道……）根本没有一张 2D 贴图可拿，模型里引用的往往是
 * 「云杉原木」这种原版方块贴图，拼出来是个立方体，硬贴上去反而误导。
 *
 * 那就别自己画了，让游戏自己画：装上 Icon Exporter（Modrinth 工程 `8KCmS7Bd`，
 * 前置 Cyclops Core `Z9DM0LJ4`）进游戏打一条 `/iconexporter export 64`，
 * 它会把**所有已注册物品**按游戏里的实际外观渲染成 PNG，透明底、64×64。
 *
 * 这个模块只做「读目录、建索引、给出 data URL」，不联网、不启动游戏。
 *
 * 导出的目录与文件名（实测）：
 *   <实例目录>/icon-exports-x64/
 *     create__cogwheel.png                        ← 普通物品：modid__itemid
 *     create__copper_backtank__{'create__banktank_air'__900}.png   ← NBT 变体，尾巴随便长
 *     fluid__create__chocolate.png                ← 流体，不是物品，要跳过
 */
import fs from 'node:fs';
import path from 'node:path';

/** 导出目录名的前缀（实测是 `icon-exports-x64`，不同版本的尺寸后缀不一样）。 */
const DIR_PREFIX = 'icon-exports';

/** 索引缓存时间：导出目录可能被重新导出，10 分钟够新。 */
const TTL_MS = 10 * 60 * 1000;

/** 单个 PNG 上限，超过就不当图标了（正常 64×64 只有几 KB）。 */
const MAX_PNG_BYTES = 1024 * 1024;

/** 目录列表 → 索引。键是「目录们拼起来的小写串」。 */
const cache = new Map();

/**
 * 找导出目录。
 *
 * 会在实例目录和 mcRoot 下各找一层：PCL 开了版本隔离时目录落在
 * `versions/<实例名>/` 里那些 `icon-exports-` 开头的子目录；没开隔离时
 * 就在 `.minecraft/` 下。
 *
 * @param {{instanceDir?: string, mcRoot?: string}} instance
 * @returns {string[]} 目录绝对路径（按名字倒序，尺寸大的排前面）
 */
export function findExportDirs(instance) {
  const roots = [instance?.instanceDir, instance?.mcRoot].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.toLowerCase().startsWith(DIR_PREFIX)) continue;
      const full = path.join(root, entry.name);
      if (!found.includes(full)) found.push(full);
    }
  }
  return found.sort((a, b) => b.localeCompare(a));
}

/**
 * 从导出文件名解出物品 ID。
 *
 * 规则（实测）：`<modid>__<itemid>[...]`，后面可能跟 NBT / meta 变体，
 * 那些变体的尾巴里还会再出现 `__`，所以只取前两段就够，剩下的忽略。
 *
 * @param {string} baseName 不含扩展名的文件名
 * @returns {{id: string, variant: boolean} | null}
 */
export function parseExportName(baseName) {
  const parts = String(baseName ?? '').split('__');
  if (parts.length < 2) return null;
  const ns = parts[0].trim().toLowerCase();
  const name = parts[1].trim().toLowerCase();
  if (!ns || !name) return null;
  // 流体的命名是 fluid__<ns>__<name>，第一段是字面量 fluid，不是命名空间
  if (ns === 'fluid') return null;
  if (!/^[a-z0-9_.-]+$/.test(ns) || !/^[a-z0-9_.\/-]+$/.test(name)) return null;
  return { id: `${ns}:${name}`, variant: parts.length > 2 };
}

/**
 * 扫导出目录，建「物品 ID → PNG 文件」的索引。
 *
 * 同一个物品有多个变体（不同 NBT）时只留第一个，任务书里显示哪种都行。
 *
 * @param {string[]} dirs findExportDirs() 的结果
 * @param {{force?: boolean}} [opts]
 * @returns {{dirs: string[], files: Map<string, {file: string, bytes: number}>, count: number, totalBytes: number, skipped: number, elapsedMs: number, at: number}}
 */
export function buildExportIndex(dirs, opts = {}) {
  const list = (dirs ?? []).filter(Boolean);
  const key = list.join('|').toLowerCase();
  if (!opts.force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.index;
  }

  const started = Date.now();
  const files = new Map();
  let skipped = 0;
  let totalBytes = 0;

  for (const dir of list) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.png')) continue;
      const parsed = parseExportName(entry.name.slice(0, -4));
      if (!parsed) {
        skipped++;
        continue;
      }
      if (files.has(parsed.id)) continue; // 已经有一个变体了，不覆盖
      const full = path.join(dir, entry.name);
      let bytes = 0;
      try {
        bytes = fs.statSync(full).size;
      } catch {
        continue;
      }
      if (bytes <= 0 || bytes > MAX_PNG_BYTES) {
        skipped++;
        continue;
      }
      files.set(parsed.id, { file: full, bytes });
      totalBytes += bytes;
    }
  }

  const index = {
    dirs: list,
    files,
    count: files.size,
    totalBytes,
    skipped,
    elapsedMs: Date.now() - started,
    at: Date.now(),
  };
  cache.set(key, { at: Date.now(), index });
  return index;
}

/**
 * 一次把多个物品 ID 变成 data URL。
 *
 * @param {Map<string, {file: string, bytes: number}>} files buildExportIndex().files
 * @param {string[]} ids 已规范化的物品 ID
 * @returns {{icons: Map<string, {dataUrl: string, bytes: number, source: string}>, missing: string[]}}
 */
export function readExportedIcons(files, ids) {
  const icons = new Map();
  const missing = [];
  for (const id of ids ?? []) {
    const hit = files?.get(id);
    if (!hit) {
      missing.push(id);
      continue;
    }
    let png;
    try {
      png = fs.readFileSync(hit.file);
    } catch {
      missing.push(id);
      continue;
    }
    icons.set(id, {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      bytes: png.length,
      source: `游戏导出 → ${path.basename(hit.file)}`,
    });
  }
  return { icons, missing };
}

/** 人读的一行摘要（面板和工具都用它，别各写一套文案）。 */
export function describeExportIndex(index) {
  if (!index || !index.count) return '还没有游戏导出的图标（会退回直接从 mod jar 里找贴图）';
  const mb = (index.totalBytes / 1048576).toFixed(1);
  return `游戏导出的图标：${index.count} 个（${mb} MB），来源 ${index.dirs.length} 个目录`;
}

/** 测试用：清缓存。 */
export function resetExportCache() {
  cache.clear();
}