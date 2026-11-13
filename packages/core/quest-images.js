// 任务书背景图 / 装饰图的资源解析。
//
// FTB Quests 章节文件里的 images: [{image: "ftbquests:textures/end_deep_dark.png", ...}]
// 写的是「资源 ID」（命名空间:路径），真图在 mod jar 的 assets/<ns>/<路径> 里。
// 2026-11-02 用户问「怎么扫不出背景」——之前整条链都没有：章节对象丢 images、
// 画布不画、图也没地方取。本文件补中间那块：给一组资源 ID，从 jar 里把 PNG 抠出来。
//
// 为什么不搭 item-icon.js 的索引车：那份索引（TEXTURE_RE）只认
// assets/<ns>/textures/(item|block|fluid)/<名>.png 三类，而背景图什么路径都有
// （textures/ 根下、gui/、book_images/、particle/……），搭车等于重写正则，
// 还得重建整个索引；背景图一个章节就几张，直接按需开 jar 找更省。
//
// 性能：第一次调用把 mods 目录 + 客户端 jar 的「中央目录文件名」各读一遍
// （不保留缓冲区），建一张「文件名 → 在哪个 jar」的倒排；之后按 jar 分组开包取图。
// 整份索引缓存 10 分钟（跟 item-icon 一个量级），重复调用不重新扫盘。
//
// 2026-11-03 实测补的一条：**章节背景图不一定在 mod jar 里**。真实包
// 「重度机械症」有 12 张章节背景图，其中 6 张放在
// `versions/<实例>/kubejs/assets/ftbquests/textures/` 下（KubeJS 的资源目录，
// 游戏里当资源包加载），6 张在 jar 里。只扫 jar 就有一半取不到，
// 所以这里额外把「资源目录」也纳入索引。

import fs from 'node:fs';
import path from 'node:path';
import { openZip } from './zip.js';

const TTL_MS = 10 * 60 * 1000;
/** 扫资源目录时防跑飞：一个目录最多收这么多文件、最多这么深。 */
const MAX_ASSET_FILES = 20000;
const MAX_ASSET_DEPTH = 8;

/** PNG buffer → data URL（背景图没有动画帧问题，直接转）。 */
function toDataUrl(png) {
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** modsDir(小写) → { at, jars: [{jar, names: Set<entry小写>}] } */
const assetIndexCache = new Map();

/**
 * 候选条目路径：资源 ID → jar 里可能存在的条目。
 *
 * FTB 的 image 字段写法很不统一：多数带全路径（`ns:textures/x.png`），
 * 也有省 textures/ 的（`l2hostility:item/curio/charm` = 贴图在 item/ 下）。
 * 所以按「路径里缺什么补什么」给一串候选，逐个试。
 */
export function assetCandidates(src) {
  const text = String(src ?? '').trim();
  const colon = text.indexOf(':');
  if (colon <= 0) return [];
  const ns = text.slice(0, colon).toLowerCase();
  let p = text.slice(colon + 1).replace(/\\/g, '/');
  if (!ns || !p) return [];
  const out = [];
  const add = (s) => {
    if (s && !out.includes(s)) out.push(s);
  };
  // 原样（带扩展名）
  add(`assets/${ns}/${p}`);
  if (!/\.png$/i.test(p)) {
    // 缺扩展名 → 补 .png（FTB 的 image 大多指 PNG；有些连 textures/ 都省了）
    add(`assets/${ns}/${p}.png`);
    add(`assets/${ns}/textures/${p}.png`);
  }
  return out;
}

/**
 * 扫一个「资源目录」（目录名一般是 assets），把里面的散文件收成
 * 「assets/<相对路径> → 绝对路径」的表。
 *
 * 为什么要单独扫：mod 里的资源都打包在 jar 里，而 KubeJS 的资源目录
 * （`kubejs/assets/...`）是**散文件**，游戏把它当资源包加载，
 * 但 jar 索引里根本没有这些条目。
 */
function scanAssetDir(root) {
  const out = new Map();
  const walk = (dir, depth) => {
    if (depth > MAX_ASSET_DEPTH || out.size >= MAX_ASSET_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= MAX_ASSET_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (!rel) continue;
        out.set(`assets/${rel}`.toLowerCase(), abs);
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * 扫一遍 mods 目录 + 客户端 jar 的中央目录，建「条目路径 → jar」倒排表。
 * 只读文件名，不解压内容，千 mod 的包也是亚秒级。
 *
 * 2026-11-03：除了 jar，还收两样东西 ——
 *   1) `assetDirs`：散装资源目录（KubeJS 的 assets），扫成「条目 → 文件路径」；
 *   2) `resourcepackDirs`：里面的 zip 也是资源包，条目同样叫 assets/...，
 *      当 jar 打开就行（不用解压到内存）。
 */
function buildAssetIndex(modsDir, extraJars, assetDirs, resourcepackDirs) {
  const key = String(modsDir ?? '').toLowerCase();
  const now = Date.now();
  const hit = assetIndexCache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.index;

  const jars = [];
  const seen = new Set();
  const pushJar = (file) => {
    const abs = path.resolve(file);
    const lc = abs.toLowerCase();
    if (seen.has(lc) || !fs.existsSync(abs)) return;
    seen.add(lc);
    try {
      const zip = openZip(fs.readFileSync(abs));
      jars.push({ jar: abs, names: new Set(zip.names.map((n) => n.toLowerCase())) });
    } catch {
      /* 坏 jar 跳过，别拖垮整张表 */
    }
  };
  try {
    for (const name of fs.readdirSync(modsDir ?? '')) {
      if (name.toLowerCase().endsWith('.jar')) pushJar(path.join(modsDir, name));
    }
  } catch {
    /* mods 目录不存在就只有客户端 jar 可搜 */
  }
  for (const jar of extraJars ?? []) pushJar(jar);
  // 资源包里的 zip：条目路径同样是 assets/...，当 jar 用
  for (const dir of resourcepackDirs ?? []) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.toLowerCase().endsWith('.zip')) pushJar(path.join(dir, name));
      }
    } catch {
      /* 没有资源包目录就跳过 */
    }
  }

  // 散装资源目录（KubeJS 的 assets 等）
  const files = new Map();
  for (const dir of assetDirs ?? []) {
    for (const [entry, abs] of scanAssetDir(dir)) {
      if (!files.has(entry)) files.set(entry, abs);
    }
  }

  const index = { jars, files };
  const prev = assetIndexCache.get(key);
  assetIndexCache.set(key, { at: now, index, results: prev?.results ?? new Map() });
  return index;
}

/** 清掉全部缓存（测试用）。 */
export function resetQuestImageCaches() {
  assetIndexCache.clear();
}

/**
 * 从 jar（或散装资源目录）里把背景图抠出来。
 *
 * @param {object} instance resolveInstance 的结果（用 modsDir / clientJar / assetDirs）
 * @param {string[]} srcs 资源 ID 列表（`ns:path`）
 * @returns {Promise<{images: Record<string, string>}>} src → data URL；找不到的键不存在
 */
export async function resolveQuestImages(instance, srcs) {
  const wanted = [...new Set((srcs ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  const images = {};
  if (!wanted.length || !instance) return { images };

  const key = String(instance.modsDir ?? '').toLowerCase();
  const now = Date.now();
  const cached = assetIndexCache.get(key);
  const results = cached && now - cached.at < TTL_MS ? cached.results : new Map();

  // 先吃结果缓存：上次抠出来的图直接回，不开 jar（10 分钟内重复请求免费）
  const missing = wanted.filter((src) => !results.has(src));
  for (const src of wanted) {
    if (results.has(src)) images[src] = results.get(src);
  }
  if (!missing.length) return { images };

  const extraJars = instance.clientJar ? [instance.clientJar] : [];
  const index = buildAssetIndex(
    instance.modsDir,
    extraJars,
    instance.assetDirs,
    instance.resourcepackDirs,
  );

  // 每个 src 的候选 → 命中的 jar（一个 jar 只开一次）
  const byJar = new Map();
  const resolved = new Map(); // src → entry（小写命中时记录原样条目名）
  const fromFiles = new Map(); // src → 绝对路径（散装资源目录里命中的）
  for (const src of missing) {
    for (const candidate of assetCandidates(src)) {
      const lc = candidate.toLowerCase();
      // 先看散装资源目录（KubeJS 的 assets 等），再开 jar
      const loose = index.files.get(lc);
      if (loose) {
        resolved.set(src, candidate);
        fromFiles.set(src, loose);
        break;
      }
      for (const { jar, names } of index.jars) {
        if (!names.has(lc)) continue;
        if (!resolved.has(src)) resolved.set(src, candidate);
        if (!byJar.has(jar)) byJar.set(jar, []);
        byJar.get(jar).push({ src, entry: candidate });
        break;
      }
      if (resolved.has(src)) break;
    }
  }

  for (const [src, file] of fromFiles) {
    if (images[src]) continue;
    try {
      const png = fs.readFileSync(file);
      images[src] = toDataUrl(png);
      results.set(src, images[src]);
    } catch {
      /* 单张读不出来就跳过 */
    }
  }

  for (const [jar, pairs] of byJar) {
    let zip = null;
    try {
      zip = openZip(fs.readFileSync(jar));
    } catch {
      continue;
    }
    for (const { src, entry } of pairs) {
      if (images[src]) continue;
      try {
        const png = zip.read(entry);
        if (png) {
          images[src] = toDataUrl(png);
          results.set(src, images[src]);
        }
      } catch {
        /* 单张读不出来就跳过 */
      }
    }
  }

  // 把查过的（含没找到的，用 null 占位）都记进结果缓存，避免重复开包找不存在的图
  for (const src of wanted) {
    if (!results.has(src)) results.set(src, images[src] ?? null);
  }
  assetIndexCache.set(key, { at: now, index, results });
  return { images };
}

/**
 * 判断某个资源 ID 在这个包里到底存不存在（给体检用）。
 *
 * 跟 resolveQuestImages 用同一套候选和索引，但**只判在不在，不读内容**，
 * 所以便宜得多；也顺带说明「图放在哪」——jar 里、资源包里还是 KubeJS 资源目录。
 *
 * @returns {Promise<{exists: boolean, where: string}>} where 取值：
 *   'jar' / 'resourcepack' / 'assets' / 'missing'
 */
export async function checkQuestImageExists(instance, src) {
  const text = String(src ?? '').trim();
  const empty = { exists: false, where: 'missing' };
  if (!text || !instance) return empty;

  const candidates = assetCandidates(text);
  if (!candidates.length) return empty;

  const key = String(instance.modsDir ?? '').toLowerCase();
  const now = Date.now();
  const cached = assetIndexCache.get(key);
  const index = cached && now - cached.at < TTL_MS
    ? cached.index
    : buildAssetIndex(instance.modsDir, instance.clientJar ? [instance.clientJar] : [], instance.assetDirs, instance.resourcepackDirs);

  for (const candidate of candidates) {
    const lc = candidate.toLowerCase();
    if (index.files.has(lc)) return { exists: true, where: 'assets' };
    for (const { jar, names } of index.jars) {
      if (!names.has(lc)) continue;
      const isPack = (instance.resourcepackDirs ?? []).some((d) => jar.toLowerCase().startsWith(path.resolve(d).toLowerCase()));
      return { exists: true, where: isPack ? 'resourcepack' : 'jar' };
    }
  }
  return empty;
}
