/**
 * 探针 B：统计「离线可得的物品 ID 证据源」覆盖度。
 * 目标：回答「不解包运行期注册表，能不能可靠地判断一个物品 ID 是否真实存在」。
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

// 证据源 1：lang item./block. 键
const langIds = new Set();
for (const e of entries.filter((e) => e.name === `assets/${ns}/lang/en_us.json`)) {
  const json = JSON.parse(readEntry(buf, e).toString('utf8'));
  for (const k of Object.keys(json)) {
    const m = k.match(/^(?:item|block)\.([a-z0-9_]+)\.([a-z0-9_.]+)$/);
    if (m && m[1] === ns) langIds.add(`${ns}:${m[2]}`);
  }
}

// 证据源 2：models/item/*.json 与 blockstates
const modelIds = new Set();
for (const e of entries) {
  let m = e.name.match(new RegExp(`^assets/${ns}/models/item/(.+)\\.json$`));
  if (m) modelIds.add(`${ns}:${m[1]}`);
  m = e.name.match(new RegExp(`^assets/${ns}/models/block/(.+)\\.json$`));
  if (m) modelIds.add(`${ns}:${m[1]}`);
  m = e.name.match(new RegExp(`^assets/${ns}/blockstates/(.+)\\.json$`));
  if (m) modelIds.add(`${ns}:${m[1]}`);
}

// 证据源 3：textures/item|block/*.png
const texIds = new Set();
for (const e of entries) {
  let m = e.name.match(new RegExp(`^assets/${ns}/textures/(?:item|block)/(.+)\\.png$`));
  if (m) texIds.add(`${ns}:${m[1]}`);
}

// 证据源 4：全部 JSON（recipes/tags/loot_tables/advancements）里出现的 id 引用
const refIds = new Set();
const refByKind = new Map();
const idRe = new RegExp(`"${ns}:[a-z0-9_./-]+"`, 'g');
for (const e of entries) {
  if (!/^data\/.+\.json$/.test(e.name)) continue;
  let text;
  try { text = readEntry(buf, e).toString('utf8'); } catch { continue; }
  const kind = e.name.split('/')[2] ?? 'other';
  let m;
  while ((m = idRe.exec(text))) {
    const id = m[0].slice(1, -1);
    refIds.add(id);
    if (!refByKind.has(kind)) refByKind.set(kind, new Set());
    refByKind.get(kind).add(id);
  }
}

console.log(`=== namespace: ${ns} ===`);
console.log(`lang item/block 键派生：${langIds.size}`);
console.log(`models+blockstates 路径派生：${modelIds.size}`);
console.log(`textures 路径派生：${texIds.size}`);
console.log(`data/**/*.json 中的显式引用：${refIds.size}`);
console.log(`  by kind:`, [...refByKind.entries()].map(([k, v]) => `${k}=${v.size}`).join(', '));

const union = new Set([...langIds, ...modelIds, ...texIds, ...refIds]);
console.log(`并集（可确认存在的候选 ID）：${union.size}`);

// 交叉验证：只在 refIds 里（配方/标签引用过）但不在 lang 里的
const onlyRef = [...refIds].filter((id) => !langIds.has(id));
console.log(`\n只在 data 引用出现、lang 里没有的（可能是中间态/别名/拼写错）：${onlyRef.length}`);
console.log('  样例：', onlyRef.slice(0, 15));

// 反向：lang 有但 data 从未引用（可能是只出现在创造栏的物品，正常）
const onlyLang = [...langIds].filter((id) => !refIds.has(id));
console.log(`\nlang 有但 data 未引用：${onlyLang.length}`);
console.log('  样例：', onlyLang.slice(0, 15));

// 抽查几个知名 ID 是否在各源中都出现
for (const probe of ['create:cogwheel', 'create:shaft', 'create:andesite_alloy', 'create:crushing_wheel', 'create:not_a_real_item']) {
  console.log(
    `  ${probe.padEnd(28)} lang=${langIds.has(probe)} model=${modelIds.has(probe)} tex=${texIds.has(probe)} ref=${refIds.has(probe)}`,
  );
}
