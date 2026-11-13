/**
 * 探针 I：真实整合包端到端可行性验证。
 * 目标：不启动游戏，在真实整合包上跑通
 *   1) 全量 mods/*.jar 索引（耗时/内存/物品 ID 规模）
 *   2) 真实 kubejs/server_scripts/*.js 的语法 + 沙箱执行 + ID 引用核对
 *   3) 真实 config/ftbquests/quests 的读取 + lint（环/悬空/重复 ID）
 *
 * 用法：node tools/probe-real-pack.js "<整合包 versions 目录>"
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';

const instanceDir = process.argv[2];
if (!instanceDir) {
  console.error('用法: node tools/probe-real-pack.js "<versions/<实例> 目录>"');
  process.exit(1);
}
const log = (...a) => console.log(...a);

// ─────────────────────────────────────────────────────────────
// 1. ZIP 读取（纯 Node，解析中央目录）
// ─────────────────────────────────────────────────────────────
function readZipEntries(buffer) {
  // 找 EOCD
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(off) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(off + 10);
    const crc = buffer.readUInt32LE(off + 16);
    const compSize = buffer.readUInt32LE(off + 20);
    const uncompSize = buffer.readUInt32LE(off + 24);
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    const localOff = buffer.readUInt32LE(off + 42);
    const name = buffer.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, crc, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extract(buffer, entry) {
  const off = entry.localOff;
  if (buffer.readUInt32LE(off) !== 0x04034b50) throw new Error('bad local header');
  const nameLen = buffer.readUInt16LE(off + 26);
  const extraLen = buffer.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const raw = buffer.slice(start, start + entry.compSize);
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

function openJar(file) {
  const buffer = fs.readFileSync(file);
  const entries = readZipEntries(buffer);
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    entries,
    byName,
    read(name) {
      const e = byName.get(name);
      return e ? extract(buffer, e) : null;
    },
    text(name) {
      const b = this.read(name);
      return b ? b.toString('utf8') : null;
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 2. 单 jar 索引：modId + 物品 ID 三源
// ─────────────────────────────────────────────────────────────
function indexJar(file) {
  const jar = openJar(file);
  const names = jar.entries.map((e) => e.name);

  // neoforge.mods.toml → mods.toml → fabric.mod.json（顺序回退）
  // 注意：1.21.1 NeoForge 包绝大多数只有 META-INF/neoforge.mods.toml，
  // 只读旧的 mods.toml 会让 modId 解析率掉到 12/183。
  let modId = null, modVersion = null;
  const toml = jar.text('META-INF/neoforge.mods.toml') ?? jar.text('META-INF/mods.toml');
  if (toml) {
    // 引号单双都要认：有的 mod（如 DnT-ancient-city-overhaul）用 `modId = 'xxx'` 单引号
    const m = /modId\s*=\s*['"]([^'"]+)['"]/.exec(toml);
    if (m) modId = m[1];
    const v = /version\s*=\s*['"]([^'"]+)['"]/.exec(toml);
    if (v) modVersion = v[1];
  }
  if (!modId) {
    const fj = jar.text('fabric.mod.json');
    if (fj) { try { const j = JSON.parse(fj); modId = j.id; modVersion = j.version; } catch {} }
  }

  const items = new Set();
  // 源 A: lang item./block. 恰好两段
  for (const name of names) {
    if (!/^assets\/[^/]+\/lang\/(en_us|zh_cn)\.json$/.test(name)) continue;
    let lang;
    try { lang = JSON.parse(jar.text(name)); } catch { continue; }
    for (const key of Object.keys(lang)) {
      const m = /^(item|block)\.([a-z0-9_.-]+)\.([a-z0-9_./-]+)$/i.exec(key);
      if (!m) continue;
      if (m[3].includes('.')) continue; // 排除 tooltip 子键
      items.add(`${m[2]}:${m[3]}`);
    }
  }
  // 源 B: models/item/*.json
  for (const name of names) {
    const m = /^assets\/([^/]+)\/models\/item\/(.+)\.json$/.exec(name);
    if (m) items.add(`${m[1]}:${m[2]}`);
  }
  // 源 C: 配方产物（1.20.1 用复数 recipes/，1.21.1 用单数 recipe/，两个都认）
  for (const name of names) {
    if (!/^data\/[^/]+\/(?:recipes|recipe)\/.+\.json$/.test(name)) continue;
    let r;
    try { r = JSON.parse(jar.text(name)); } catch { continue; }
    const result = r?.result;
    if (typeof result === 'string') items.add(result);
    else if (result && typeof result === 'object') {
      if (typeof result.item === 'string') items.add(result.item);
      else if (typeof result.id === 'string') items.add(result.id);
    }
    if (Array.isArray(r?.results)) {
      for (const x of r.results) {
        if (typeof x === 'string') items.add(x);
        else if (x && typeof x.item === 'string') items.add(x.item);
        else if (x && typeof x.id === 'string') items.add(x.id);
      }
    }
  }
  return { file: path.basename(file), modId, modVersion, items, sizeMB: (fs.statSync(file).size / 1048576).toFixed(1) };
}

// ─────────────────────────────────────────────────────────────
// 3. KubeJS 沙箱：真跑脚本，记录调用
// ─────────────────────────────────────────────────────────────
function runKubejs(source, filename) {
  const calls = [];
  const chain = (p) => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then' || prop === 'toJSON') return undefined;
      const np = `${p}.${String(prop)}`;
      return (...args) => { calls.push({ path: np, args }); return chain(np); };
    },
    apply(_t, _this, args) { return chain(p); },
  });
  const event = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      const np = `event.${String(prop)}`;
      if (prop === 'recipes') {
        return new Proxy(function () {}, {
          get(_t2, p2) { return (...a) => { calls.push({ path: `event.recipes.${String(p2)}`, args: a }); return chain(`event.recipes.${String(p2)}`); }; },
        });
      }
      return (...args) => { calls.push({ path: np, args }); return chain(np); };
    },
  });
  const noop = () => {};
  const handler = {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      return (...a) => { calls.push({ path: `ServerEvents.${String(prop)}`, args: [] }); return undefined; };
    },
  };
  const sandbox = {
    ServerEvents: new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        return (cb) => { calls.push({ path: `ServerEvents.${String(prop)}`, args: [] }); try { cb(event); } catch (e) { calls.push({ path: `ERROR:${e.message}`, args: [] }); } };
      },
    }),
    StartupEvents: { registry: (cb) => { try { cb(event); } catch (e) { calls.push({ path: `ERROR:${e.message}`, args: [] }); } } },
    ClientEvents: { init: noop },
    onEvent: noop,
    console: { log: noop, warn: noop, error: noop, info: noop },
    Platform: { isClientEnvironment: () => false, isServerEnvironment: () => true, getMinecraftVersion: () => '1.20.1', getModVersion: () => '1.0' },
    Java: new Proxy({}, { get: () => () => { throw new Error('offline'); } }),
    Utils: { id: (ns, p) => `${ns}:${p}`, isEmpty: (v) => !v, getModVersion: () => '1.0' },
    Item: { of: (id) => ({ id }) },
    JsonIO: { write: noop, read: () => ({}) },
    global: {},
    fromObject: () => ({}),
    JsonObject: function () {},
    setTimeout: noop, setInterval: noop,
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  let status = 'ok';
  try {
    new vm.Script(source, { filename });
  } catch (e) {
    return { status: 'syntax-error', error: `${e.name}: ${e.message}`, line: String(e.stack).split('\n')[0], calls };
  }
  try {
    vm.runInContext(source, ctx, { filename, timeout: 5000 });
  } catch (e) {
    status = 'runtime-error';
    return { status, error: `${e.name}: ${e.message}`, calls };
  }
  return { status, calls };
}

function harvestIds(calls) {
  const ids = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = /^(?:\d+x )?([a-z0-9_.-]+:[a-z0-9_./-]+)$/.exec(v);
      if (m) ids.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) { walk(k); walk(val); }
    }
  };
  for (const c of calls) walk(c.args);
  return ids;
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────
const modsDir = path.join(instanceDir, 'mods');
const kubejsDir = path.join(instanceDir, 'kubejs');
const questDir = path.join(instanceDir, 'config', 'ftbquests', 'quests');

log(`\n### 整合包实例：${instanceDir}\n`);

// ---- 1. 索引 ----
const t0 = Date.now();
const jarFiles = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar'));
log(`=== 1. 索引 ${jarFiles.length} 个 jar ===`);
const allItems = new Set();
const mods = [];
let failed = 0;
for (const f of jarFiles) {
  try {
    const idx = indexJar(path.join(modsDir, f));
    mods.push(idx);
    for (const id of idx.items) allItems.add(id);
  } catch (e) {
    failed++;
    if (failed <= 3) log(`  [skip] ${f}: ${e.message}`);
  }
}
const ms = Date.now() - t0;
log(`  耗时 ${ms}ms（${(ms / jarFiles.length).toFixed(1)}ms/jar），失败 ${failed}`);
log(`  物品 ID 总数：${allItems.size}`);
log(`  modId 可识别：${mods.filter((m) => m.modId).length}/${mods.length}`);
log(`  RSS: ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);

// 抽样核对
const samples = [...allItems].filter((i) => !i.startsWith('minecraft:')).slice(0, 5);
log(`  抽样：${samples.join(', ')}`);
for (const s of samples.slice(0, 3)) {
  const hit = mods.find((m) => m.items.has(s));
  log(`    ${s} → 来自 ${hit?.file ?? '?'} (modId=${hit?.modId ?? '?'})`);
}

// ---- 2. KubeJS ----
log(`\n=== 2. KubeJS 脚本校验 ===`);
const jsFiles = [];
const walkJs = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p);
    else if (e.name.endsWith('.js')) jsFiles.push(p);
  }
};
walkJs(path.join(kubejsDir, 'server_scripts'));
log(`  找到 ${jsFiles.length} 个 server_scripts/*.js`);
const results = { ok: 0, syntax: 0, runtime: 0 };
const refIds = new Set();
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const r = runKubejs(src, path.relative(instanceDir, f));
  results[r.status === 'ok' ? 'ok' : r.status === 'syntax-error' ? 'syntax' : 'runtime']++;
  for (const id of harvestIds(r.calls)) refIds.add(id);
  if (r.status !== 'ok') log(`  [${r.status}] ${path.relative(instanceDir, f)} :: ${r.error}`);
}
log(`  结果：ok=${results.ok} syntax-error=${results.syntax} runtime-error=${results.runtime}`);
log(`  脚本引用到的命名空间 ID：${refIds.size} 个`);

// ---- 3. ID 引用核对 ----
log(`\n=== 3. 脚本引用的物品 ID 是否真实存在 ===`);
const unknown = [...refIds].filter((id) => !allItems.has(id));
// 配方 id 形如 create:xxx_from_crafting 会误报，单独归类
const looksLikeRecipeId = (id) => {
  const p = id.split(':')[1] ?? '';
  return /(_from_|_to_|crafting|smelting|pressing|mixing|cutting|blasting|blasting)/.test(p);
};
const unknownItem = unknown.filter((id) => !looksLikeRecipeId(id));
log(`  未命中总数 ${unknown.length}，其中疑似配方 ID ${unknown.length - unknownItem.length}`);
log(`  疑似「引用了不存在的物品」${unknownItem.length} 个：`);
for (const id of unknownItem.slice(0, 20)) log(`    ✗ ${id}`);

// ---- 4. FTB Quests ----
log(`\n=== 4. FTB Quests 读取 + lint ===`);
if (!fs.existsSync(questDir)) {
  log('  无 config/ftbquests/quests 目录');
} else {
  const { QuestStore } = await import('file://' + path.join(process.cwd(), 'probe', 'ftbqp', 'server', 'store.mjs').replace(/\\/g, '/'));
  const { lintStore, } = await import('file://' + path.join(process.cwd(), 'probe', 'ftbqp', 'server', 'lint.mjs').replace(/\\/g, '/'));
  const t1 = Date.now();
  const store = await QuestStore.load({ questDir, locale: 'zh_cn' });
  log(`  加载耗时 ${Date.now() - t1}ms`);
  log(`  章节 ${store.chapters.length}，任务 ${store.questsById.size}，分组 ${store.chapterGroups.length}`);
  const issues = lintStore(store) ?? [];
  const bySev = {};
  for (const i of (Array.isArray(issues) ? issues : [])) bySev[i.severity] = (bySev[i.severity] ?? 0) + 1;
  log(`  lint：${JSON.stringify(bySev)}`);
  const shown = (Array.isArray(issues) ? issues : []).slice(0, 8);
  for (const i of shown) log(`    [${i.severity}] ${i.code}: ${i.message}`);
}
log('\n=== 完 ===\n');
