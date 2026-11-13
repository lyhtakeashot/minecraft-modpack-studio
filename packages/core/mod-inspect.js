/**
 * mod 体检：把单个 mod 的 jar 拆开，读出「配方 / 物品+中文名 / 标签 / 掉落表」，
 * 再从实例的 config 目录里找属于它的配置文件。
 *
 * 为什么值得单独做一层：`mc_recipe_find` 只能回答「这个配方存在」，回答不了
 * 「这台机器怎么摆、要几个、吃不吃标签、掉落概率多少」。而改整合包真正需要的
 * 是后者 —— 尤其标签和 config 数值，那才是平衡性的开关。
 *
 * ⚠️ 三组目录名在 1.20 与 1.21 之间改成了单数，写死一个就会**静默少一半数据**：
 *   配方   1.20 `recipes/`      1.21 `recipe/`
 *   标签   1.20 `tags/items/`   1.21 `tags/item/`
 *   掉落   1.20 `loot_tables/`  1.21 `loot_table/`
 * 产物字段同理：1.20 是 `{item,count}`，1.21 是 `{id,count}`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from './zip.js';
import { parseModMeta } from './instance.js';
import { McError } from './errors.js';

const ID_RE = /^[a-z0-9_-]+:[a-z0-9_./-]+$/;
const TAG_RE = /^#[a-z0-9_-]+:[a-z0-9_./-]+$/;

const RECIPE_RE = /^data\/([^/]+)\/(?:recipes|recipe)\/(.+)\.json$/;
const LANG_RE = /^assets\/([^/]+)\/lang\/(zh_cn|en_us)\.json$/;
const MODEL_RE = /^assets\/([^/]+)\/models\/item\/(.+)\.json$/;
const TAGFILE_RE = /^data\/([^/]+)\/tags\/(?:items?|blocks?)\/(.+)\.json$/;
const LOOT_RE = /^data\/([^/]+)\/loot_tables?\/(.+)\.json$/;

/** 单个 jar 里最多解析多少条配方，防止极端包把工具拖死。 */
const MAX_RECIPE_PARSE = 4000;

/**
 * 递归收集 JSON 里的「引用」：物品 ID 和 `#标签`。
 *
 * 为什么用全量递归而不是逐字段取：mod 自定义配方类型的字段名五花八门
 * （`base` / `addition` / `catalyst` / `template` / `inputs` …），逐字段取
 * 一定会漏。全量递归再把 `type` 和产物剔掉，得到的就是「这条配方吃进去什么」。
 */
function collectRefs(node, out, depth = 0) {
  if (depth > 12) return;
  if (typeof node === 'string') {
    if (ID_RE.test(node) || TAG_RE.test(node)) out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, out, depth + 1);
    return;
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectRefs(v, out, depth + 1);
  }
}

/** 取产物：兼容 1.20 的 `{item}` 与 1.21 的 `{id}`，count 可能是数字也可能是 {min,max}。 */
function pickResult(json) {
  const one = (v) => {
    if (!v || typeof v !== 'object') return null;
    const id = typeof v.item === 'string' ? v.item : typeof v.id === 'string' ? v.id : '';
    if (!id || !ID_RE.test(id)) return null;
    let count = 1;
    if (typeof v.count === 'number') count = v.count;
    else if (v.count && typeof v.count === 'object' && typeof v.count.min === 'number') count = v.count.min;
    return { id, count };
  };
  const r = one(json?.result);
  if (r) return r;
  if (Array.isArray(json?.results)) {
    for (const v of json.results) {
      const x = one(v);
      if (x) return x;
    }
  }
  return null;
}

/** 把一条配方 JSON 压成「类型 + 产物 + 吃进去什么」，够用来判断怎么改。 */
function recipeBrief(file, json) {
  const type = typeof json?.type === 'string' ? json.type : '';
  const result = pickResult(json);
  const refs = new Set();
  collectRefs(json, refs);
  if (result) refs.delete(result.id);
  if (type) refs.delete(type);
  return { file, type, result, ingredients: [...refs] };
}

function readJson(zip, name) {
  const txt = zip.text(name);
  if (txt === null) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * 从 jar 里猜命名空间：modId 解析不出来时（loader 层 jar），用出现最多的目录名兜底，
 * 否则整个工具对这类 jar 就完全哑掉。
 */
function guessNamespace(zip) {
  const tally = new Map();
  for (const n of zip.names) {
    const m = RECIPE_RE.exec(n) ?? LANG_RE.exec(n) ?? MODEL_RE.exec(n);
    if (m) tally.set(m[1], (tally.get(m[1]) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [ns, c] of tally) {
    if (c > bestN) {
      best = ns;
      bestN = c;
    }
  }
  return best;
}

/** 读某个命名空间的物品 + 中文名（zh_cn 优先，缺了退回 en_us）。 */
function readItems(zip, ns) {
  const zh = readJson(zip, `assets/${ns}/lang/zh_cn.json`);
  const en = readJson(zip, `assets/${ns}/lang/en_us.json`);
  /** @type {Map<string, {id: string, name: string, en: string}>} */
  const out = new Map();

  const addLang = (lang, key) => {
    if (!lang || typeof lang !== 'object') return;
    for (const [k, v] of Object.entries(lang)) {
      const parts = k.split('.');
      if (parts.length < 3) continue;
      if (parts[0] !== 'item' && parts[0] !== 'block') continue;
      const lns = parts[1];
      if (lns !== ns) continue;
      const name = parts[2];
      if (!name || !/^[a-z0-9_]+$/.test(name)) continue;
      const id = `${ns}:${name}`;
      const cur = out.get(id) ?? { id, name: '', en: '' };
      if (key === 'zh' && typeof v === 'string') cur.name = v;
      if (key === 'en' && typeof v === 'string') {
        cur.en = v;
        if (!cur.name) cur.name = v;
      }
      out.set(id, cur);
    }
  };
  addLang(en, 'en');
  addLang(zh, 'zh');

  // 模型文件兜底：有些物品没有语言条目（隐藏物品），但一定有模型
  for (const n of zip.names) {
    const m = MODEL_RE.exec(n);
    if (!m || m[1] !== ns) continue;
    const first = m[2].split('/')[0];
    if (!first) continue;
    const id = `${ns}:${first}`;
    if (!out.has(id)) out.set(id, { id, name: '', en: '' });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 拆一个 jar，返回它的全部可读内容。
 * @param {string} jarPath
 */
export function inspectJar(jarPath) {
  if (!fs.existsSync(jarPath)) {
    throw new McError(`找不到 jar：${jarPath}`, '确认 mods 目录和文件名', 'McNotFound');
  }
  const zip = openZip(fs.readFileSync(jarPath));
  const meta = parseModMeta(zip);
  const modId = meta.modId || guessNamespace(zip);

  const items = modId ? readItems(zip, modId) : [];
  /** @type {Array<{file: string, type: string, result: {id: string, count: number}|null, ingredients: string[]}>} */
  const recipes = [];
  /** @type {Array<{tag: string, values: string[], file: string}>} */
  const tags = [];
  /** @type {Array<{file: string, items: string[]}>} */
  const loot = [];
  const typeTally = new Map();
  let recipeSkipped = 0;

  for (const n of zip.names) {
    const r = RECIPE_RE.exec(n);
    if (r) {
      if (modId && r[1] !== modId) continue;
      if (recipes.length >= MAX_RECIPE_PARSE) {
        recipeSkipped++;
        continue;
      }
      const json = readJson(zip, n);
      if (!json) {
        recipeSkipped++;
        continue;
      }
      const brief = recipeBrief(n, json);
      recipes.push(brief);
      const t = brief.type || '(无 type)';
      typeTally.set(t, (typeTally.get(t) ?? 0) + 1);
      continue;
    }
    const t = TAGFILE_RE.exec(n);
    if (t) {
      if (modId && t[1] !== modId) continue;
      const json = readJson(zip, n);
      if (!json) continue;
      const values = [];
      for (const v of Array.isArray(json.values) ? json.values : []) {
        if (typeof v === 'string') values.push(v);
        else if (v && typeof v.id === 'string') values.push(v.id);
      }
      tags.push({ tag: `#${t[1]}:${t[2]}`, values, file: n });
      continue;
    }
    const l = LOOT_RE.exec(n);
    if (l) {
      if (modId && l[1] !== modId) continue;
      const json = readJson(zip, n);
      if (!json) continue;
      const refs = new Set();
      collectRefs(json.pools ?? json, refs);
      loot.push({ file: n, items: [...refs].filter((x) => !x.startsWith('#')).slice(0, 30) });
    }
  }

  const recipeTypes = [...typeTally.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  return {
    jarPath,
    jarFile: path.basename(jarPath),
    modId,
    name: meta.name || '',
    version: meta.version || '',
    items,
    recipes,
    tags,
    loot,
    recipeTypes,
    recipeSkipped,
    counts: { items: items.length, recipes: recipes.length, tags: tags.length, loot: loot.length },
  };
}

/** 按 jar 的元数据找 modId（慢路径，只在文件名没匹配上时才走）。 */
function byModId(files, modsDir, key) {
  const want = key.toLowerCase();
  for (const f of files.slice(0, 500)) {
    try {
      const zip = openZip(fs.readFileSync(path.join(modsDir, f)));
      const meta = parseModMeta(zip);
      if (meta.modId && meta.modId.toLowerCase() === want) return f;
    } catch {
      /* 坏 jar 跳过 */
    }
  }
  return '';
}

/**
 * 找到用户说的那个 jar：先按文件名，再按 modId。
 * @param {{modsDir: string}} instance
 * @param {string} key modId 或 jar 文件名
 */
export function findModJar(instance, key) {
  const k = String(key ?? '').trim();
  if (!k) throw new McError('要给 modId 或 jar 文件名', '先用 mc_mod_list 看有哪些 mod', 'McBadArgs');

  const files = fs.readdirSync(instance.modsDir).filter((n) => n.toLowerCase().endsWith('.jar'));
  const lower = k.toLowerCase();

  let hit = files.find((n) => n.toLowerCase() === lower);
  if (!hit) hit = files.find((n) => n.toLowerCase() === `${lower}.jar`);
  if (!hit) {
    const cands = files.filter((n) => n.toLowerCase().includes(lower));
    if (cands.length === 1) hit = cands[0];
    else if (cands.length > 1) hit = byModId(cands, instance.modsDir, k) || cands[0];
  }
  if (!hit) hit = byModId(files, instance.modsDir, k);

  if (!hit) {
    throw new McError(
      `在 mods 目录里没找到「${k}」对应的 jar`,
      '用 mc_mod_list 看实际的 modId / 文件名，或直接传 jar 文件名',
      'McNotFound',
    );
  }
  return path.join(instance.modsDir, hit);
}

/**
 * 找属于这个 mod 的配置文件。
 *
 * config 不在 jar 里 —— 它是启动时生成的。所以只能扫实例的 config 目录，
 * 用文件名认领。
 *
 * ⚠️ 不能简单用「路径里含 modId」：实测 `create` 会命中 32 个文件，但其中
 * 绝大多数是 `create_central_kitchen-common.toml`、`createdieselgenerators-server.toml`
 * 这种**别的 mod** 的配置 —— 它们只是名字以 create 开头。真正属于 Create 的
 * 只有 `create-client/common/server.toml` 三个。认错了会把用户引去改错的文件，
 * 所以这里按「modId 后面紧跟 - . / 或结尾」来判定，`_` 和下划线开头的不算。
 *
 * @returns {Array<{file: string, abs: string, size: number, own: boolean}>}
 *   own=true 是本 mod 自己的配置；own=false 只是名字里含 modId，供工具提示「另有 N 个」。
 */
export function modConfigFiles(instance, modId) {
  const roots = [
    path.join(instance.instanceDir, 'config'),
    path.join(instance.mcRoot, 'config'),
  ];
  const seen = new Set();
  const out = [];
  const id = String(modId).toLowerCase();
  const ownRe = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([-./]|$)`);

  const walk = (dir, rel, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, relPath, depth + 1);
        continue;
      }
      if (!/\.(toml|json|cfg|properties|yaml|yml)$/i.test(e.name)) continue;
      if (!relPath.toLowerCase().includes(id)) continue;
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* 忽略 */
      }
      out.push({ file: relPath, abs: full, size, own: ownRe.test(relPath.toLowerCase()) });
    }
  };

  for (const root of roots) {
    if (fs.existsSync(root)) walk(root, '', 0);
  }
  // 自己的配置排前面
  return out.sort((a, b) => Number(b.own) - Number(a.own) || a.file.localeCompare(b.file));
}

/** 读文本文件并截断，避免一个巨大的 toml 把返回撑爆。 */
export function readTextFile(file, maxBytes = 4000) {
  try {
    const buf = fs.readFileSync(file);
    const text = buf.subarray(0, maxBytes).toString('utf8');
    return { text, truncated: buf.length > maxBytes, size: buf.length };
  } catch {
    return { text: '', truncated: false, size: 0 };
  }
}
