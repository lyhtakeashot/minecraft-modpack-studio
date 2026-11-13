/**
 * 探针 K：验证两个"真算"的规划能力在真实包上是否可行。
 *   A) 配方图：item -> recipe -> item，检测「删掉若干配方后目标物品失去所有获取路径」（断路）
 *   B) 模组重叠度：用离线证据（同后缀物品名 / 同 lang 键形状）估算功能重叠
 *
 * 用法：node tools/probe-planning.js "<versions/<实例> 目录>"
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const instanceDir = process.argv[2];
const log = (...a) => console.log(...a);

// ── ZIP ──
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const count = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nl = buffer.readUInt16LE(off + 28), el = buffer.readUInt16LE(off + 30), cl = buffer.readUInt16LE(off + 32);
    out.push({
      name: buffer.slice(off + 46, off + 46 + nl).toString('utf8'),
      method: buffer.readUInt16LE(off + 10),
      cs: buffer.readUInt32LE(off + 20),
      lo: buffer.readUInt32LE(off + 42),
    });
    off += 46 + nl + el + cl;
  }
  return out;
}
function extract(buffer, e) {
  const o = e.lo, nl = buffer.readUInt16LE(o + 26), el = buffer.readUInt16LE(o + 28);
  const s = o + 30 + nl + el;
  const raw = buffer.slice(s, s + e.cs);
  return e.method === 0 ? raw : zlib.inflateRawSync(raw);
}

// ── 从配方 JSON 抽「输入物品 → 输出物品」 ──
function flattenIngredients(v, out) {
  if (v == null) return;
  if (typeof v === 'string') { out.push(v); return; }
  if (Array.isArray(v)) { v.forEach((x) => flattenIngredients(x, out)); return; }
  if (typeof v === 'object') {
    if (typeof v.item === 'string') { out.push(v.item); return; }
    if (typeof v.id === 'string' && v.id.includes(':')) { out.push(v.id); return; }
    if (typeof v.tag === 'string') { out.push('#' + v.tag); return; }
    for (const val of Object.values(v)) flattenIngredients(val, out);
  }
}

function recipeEdges(json) {
  const ins = [];
  const outs = [];
  const pushOut = (v) => {
    if (typeof v === 'string') outs.push(v);
    else if (v && typeof v === 'object') { if (typeof v.item === 'string') outs.push(v.item); else if (typeof v.id === 'string') outs.push(v.id); }
  };
  if (json?.result !== undefined) pushOut(json.result);
  if (Array.isArray(json?.results)) json.results.forEach(pushOut);
  // 输入
  for (const k of ['ingredients', 'key', 'ingredient', 'input', 'base', 'addition', 'template', 'pattern']) {
    if (k === 'pattern') continue;
    if (json?.[k] !== undefined) flattenIngredients(json[k], ins);
  }
  // 数组型 inputs（create 系列）
  for (const k of ['inputs', 'input_a', 'input_b', 'ingredients']) {
    if (Array.isArray(json?.[k])) flattenIngredients(json[k], ins);
  }
  return { ins: [...new Set(ins)], outs: [...new Set(outs)] };
}

// ═════════════════════════
log(`\n### 规划能力验证：${instanceDir}\n`);
const modsDir = path.join(instanceDir, 'mods');
const jars = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar'));

// ── A. 配方图 ──
log('=== A. 配方图（断路/开环检测） ===');
const t0 = Date.now();
const produces = new Map();  // item -> [recipeId]
const consumes = new Map();  // item -> [recipeId]
const recipeOwner = new Map(); // recipeId -> modId
const itemOwner = new Map();   // item -> Set(modId)
let recipeCount = 0;
const modIds = new Map();      // jar -> modId

for (const f of jars) {
  let buf, entries;
  try { buf = fs.readFileSync(path.join(modsDir, f)); entries = readZip(buf); } catch { continue; }
  const byName = new Map(entries.map((e) => [e.name, e]));
  // modId
  let modId = null;
  for (const tn of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
    const e = byName.get(tn);
    if (e) {
      const m = /modId\s*=\s*"([^"]+)"/.exec(extract(buf, e).toString('utf8'));
      if (m) { modId = m[1]; break; }
    }
  }
  if (!modId) {
    const e = byName.get('fabric.mod.json');
    if (e) { try { modId = JSON.parse(extract(buf, e).toString('utf8')).id; } catch {} }
  }
  modIds.set(f, modId ?? '?');

  for (const [name, e] of byName) {
    if (!/^data\/[^/]+\/(?:recipes|recipe)\/.+\.json$/.test(name)) continue;
    let json;
    try { json = JSON.parse(extract(buf, e).toString('utf8')); } catch { continue; }
    recipeCount++;
    const rid = `${name.replace(/^data\/([^/]+)\/(?:recipes|recipe)\//, '$1:').replace(/\.json$/, '')}`;
    recipeOwner.set(rid, modId);
    const { ins, outs } = recipeEdges(json);
    for (const o of outs) {
      if (!produces.has(o)) produces.set(o, []);
      produces.get(o).push(rid);
      if (!itemOwner.has(o)) itemOwner.set(o, new Set());
      itemOwner.get(o).add(modId ?? '?');
    }
    for (const i of ins) {
      if (i.startsWith('#')) continue;
      if (!consumes.has(i)) consumes.set(i, []);
      consumes.get(i).push(rid);
    }
  }
}
log(`  解析 ${recipeCount} 份配方（${jars.length} 个 jar），耗时 ${Date.now() - t0}ms`);
log(`  有产物的物品 ${produces.size} 个；有消耗记录的物品 ${consumes.size} 个`);

// 断路检测：模拟「删掉 create 的齿轮配方」后，哪些物品失去全部获取路径
const targetMod = 'create';
const removed = [...recipeOwner.entries()].filter(([, m]) => m === targetMod).map(([r]) => r);
log(`\n  模拟：删除 ${targetMod} 的 ${removed.length} 份配方…`);
const removedSet = new Set(removed);
const broken = [];
for (const [item, rids] of produces) {
  if (rids.length === 0) continue;
  const remain = rids.filter((r) => !removedSet.has(r));
  if (remain.length === 0) {
    // 只报"还被别的配方消耗"的物品 = 真断路
    const usedBy = (consumes.get(item) ?? []).filter((r) => !removedSet.has(r));
    if (usedBy.length > 0) broken.push({ item, usedBy: usedBy.length });
  }
}
log(`  → 检测到 ${broken.length} 个「断路」物品（删后无获取路径但仍被别的配方需要）`);
broken.sort((a, b) => b.usedBy - a.usedBy);
for (const b of broken.slice(0, 12)) log(`     ✗ ${b.item}（被 ${b.usedBy} 份配方需要）`);

// ── B. 模组重叠度 ──
log('\n=== B. 模组重叠度（离线启发式） ===');
// 启发式 1：不同 mod 的物品，去掉命名空间后 path 相同或高度相似的
const byPath = new Map();
for (const [item, owners] of itemOwner) {
  const [ns, ...rest] = item.split(':');
  const p = rest.join(':');
  if (!p) continue;
  if (!byPath.has(p)) byPath.set(p, new Set());
  byPath.get(p).add(ns);
}
const collisions = [...byPath.entries()].filter(([, ns]) => ns.size >= 2);
log(`  同名物品（同 path 不同命名空间）：${collisions.length} 组`);
for (const [p, ns] of collisions.slice(0, 12)) log(`     ${p}  ← ${[...ns].join(', ')}`);

// 启发式 2：按物品 path 的词根归组，找"功能族"重叠
const families = [
  { name: '齿轮/传动', re: /(gear|cogwheel|shaft|axle|belt|chain_drive)/ },
  { name: '矿石处理', re: /(crushed|dust|nugget|ingot|raw_)/ },
  { name: '存储', re: /(chest|barrel|storage|drawer|crate|vault)/ },
  { name: '流体', re: /(fluid|tank|pipe|hose|pump)/ },
  { name: '能源', re: /(energy|battery|capacitor|generator|solar|reactor)/ },
  { name: '任务/进度', re: /(quest|advancement|achievement)/ },
];
log('\n  功能族覆盖分布（按 mod 统计该族物品数）：');
const famByMod = new Map();
for (const [item, owners] of itemOwner) {
  const p = item.split(':').slice(1).join(':');
  for (const fam of families) {
    if (!fam.re.test(p)) continue;
    for (const m of owners) {
      if (!famByMod.has(m)) famByMod.set(m, new Map());
      const mm = famByMod.get(m);
      mm.set(fam.name, (mm.get(fam.name) ?? 0) + 1);
    }
  }
}
for (const fam of families) {
  const mods = [...famByMod.entries()]
    .filter(([, mm]) => (mm.get(fam.name) ?? 0) >= 5)
    .map(([m, mm]) => `${m}(${mm.get(fam.name)})`)
    .sort();
  log(`     ${fam.name}: ${mods.length} 个 mod → ${mods.slice(0, 8).join(', ')}${mods.length > 8 ? ' …' : ''}`);
}
log('\n=== 完 ===\n');
