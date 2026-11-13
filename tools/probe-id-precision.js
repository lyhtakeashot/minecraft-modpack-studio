/**
 * 探针 C：把「物品 ID 证据源」做精化，量化各源的准确率。
 * 关键：1.20.1 的本地化键形状是 `item.<ns>.<path>` / `block.<ns>.<path>`，
 * 多段（clipboard.tooltip.summary）是子键而非 ID —— 必须按「恰好 2 段」过滤。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const JAR = path.resolve(import.meta.dirname, '..', 'probe', 'jar', 'create-1.20.1-6.0.8.jar');
const buf = fs.readFileSync(JAR);

function readZipEntries(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOffset = b.readUInt32LE(p + 42);
    out.push({ name: b.toString('utf8', p + 46, p + 46 + nameLen), method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function readEntry(b, e) {
  const lo = e.localOffset;
  const nameLen = b.readUInt16LE(lo + 26);
  const extraLen = b.readUInt16LE(lo + 28);
  const raw = b.subarray(lo + 30 + nameLen + extraLen, lo + 30 + nameLen + extraLen + e.compSize);
  return e.method === 0 ? raw : zlib.inflateRawSync(raw);
}

const entries = readZipEntries(buf);
const ns = 'create';

// 源 A：lang 严格形状 item.<ns>.<path> / block.<ns>.<path>
const itemsA = new Set();
const blocksA = new Set();
const subkeys = new Set();
for (const e of entries.filter((e) => e.name === `assets/${ns}/lang/en_us.json`)) {
  const json = JSON.parse(readEntry(buf, e).toString('utf8'));
  for (const k of Object.keys(json)) {
    let m = k.match(/^item\.([a-z0-9_]+)\.([a-z0-9_]+)$/);
    if (m && m[1] === ns) { itemsA.add(`${ns}:${m[2]}`); continue; }
    m = k.match(/^block\.([a-z0-9_]+)\.([a-z0-9_]+)$/);
    if (m && m[1] === ns) { blocksA.add(`${ns}:${m[2]}`); continue; }
    if (/^(item|block)\./.test(k)) subkeys.add(k);
  }
}
console.log(`源A lang 严格：item=${itemsA.size} block=${blocksA.size}，被排除的子键=${subkeys.size}`);
console.log('  子键样例：', [...subkeys].slice(0, 5));

// 源 B：assets/<ns>/models/item/<path>.json —— 1.20.1 每个注册物品若走 item 模型必有一份
const itemsB = new Set();
for (const e of entries) {
  const m = e.name.match(new RegExp(`^assets/${ns}/models/item/([a-z0-9_/]+)\\.json$`));
  if (m) itemsB.add(`${ns}:${m[1]}`);
}
console.log(`源B item 模型：${itemsB.size}`);

// 源 C：data/<ns>/recipes 的 result.item
const resultIds = new Set();
const ingredientIds = new Set();
let recipeCount = 0;
for (const e of entries) {
  if (!new RegExp(`^data/${ns}/recipes/.+\\.json$`).test(e.name)) continue;
  recipeCount++;
  let json;
  try { json = JSON.parse(readEntry(buf, e).toString('utf8')); } catch { continue; }
  const collect = (node, sink) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => collect(n, sink)); return; }
    if (typeof node.item === 'string' && node.item.includes(':')) sink.add(node.item);
    for (const v of Object.values(node)) collect(v, sink);
  };
  if (json.result) collect(json.result, resultIds);
  if (json.key) collect(json.key, ingredientIds);
  if (json.ingredients) collect(json.ingredients, ingredientIds);
}
console.log(`源C 配方 ${recipeCount} 份：result.item 去重=${resultIds.size}，ingredient.item 去重=${ingredientIds.size}`);

// 交叉验证：源C 的 result 是否都在源A/B 里
const known = new Set([...itemsA, ...blocksA, ...itemsB]);
const cOnly = [...resultIds].filter((id) => !known.has(id));
console.log(`\n配方产物有 ${resultIds.size} 个，其中 ${resultIds.size - cOnly.length} 个被 A/B 佐证，${cOnly.length} 个只有配方证据`);
console.log('  只有配方证据的样例：', cOnly.slice(0, 12));
const ingOnly = [...ingredientIds].filter((id) => !known.has(id));
console.log(`配料引用 ${ingredientIds.size} 个，其中 ${ingOnly.length} 个缺 A/B 佐证（多为其它 mod / minecraft 原版，属正常）`);
console.log('  样例：', ingOnly.slice(0, 12));

// 三源并集
const union = new Set([...itemsA, ...blocksA, ...itemsB, ...resultIds]);
console.log(`\n并集=${union.size}`);
for (const p of ['create:cogwheel', 'create:shaft', 'create:andesite_alloy', 'create:crushing_wheel', 'create:zinc_ingot', 'create:not_a_real_item']) {
  console.log(`  ${p.padEnd(26)} A=${itemsA.has(p)||blocksA.has(p)} B=${itemsB.has(p)} C=${resultIds.has(p)}`);
}
