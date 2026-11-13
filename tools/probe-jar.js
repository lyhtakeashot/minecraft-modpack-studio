/**
 * 探针 A：验证「静态解析 Forge 1.20.1 mod jar 提取真实物品 ID」的可行性。
 * 步骤：Modrinth 搜索 → 选版本 → 下载 jar → 解 zip 内存扫描。
 * 只用 node 内置模块（fetch / zlib）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '..', 'probe', 'jar');
fs.mkdirSync(OUT, { recursive: true });

const UA = { 'User-Agent': 'dsh-mc-modpack-probe/0.1 (research)' };

async function j(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// ── 1. 找 Create 的 1.20.1 Forge 版本 ────────────────────────────────────────
const search = await j(
  'https://api.modrinth.com/v2/search?query=' +
    encodeURIComponent('create') +
    '&facets=' +
    encodeURIComponent(JSON.stringify([['project_type:mod'], ['categories:forge'], ['versions:1.20.1']])) +
    '&limit=5',
);
console.log('搜索命中：');
for (const h of search.hits) console.log(`  ${h.slug} | ${h.title} | downloads=${h.downloads}`);

const target = search.hits.find((h) => h.slug === 'create') ?? search.hits[0];
console.log(`\n选定：${target.slug} (${target.project_id})`);

const versions = await j(`https://api.modrinth.com/v2/project/${target.project_id}/version?game_versions=%5B%221.20.1%22%5D&loaders=%5B%22forge%22%5D`);
console.log(`可用 1.20.1+forge 版本数：${versions.length}`);
const ver = versions[0];
const file = ver.files.find((f) => f.primary) ?? ver.files[0];
console.log(`版本：${ver.version_number}  文件：${file.filename}  ${(file.size / 1048576).toFixed(1)} MB`);
console.log(`  依赖：${JSON.stringify(ver.dependencies)}`);

const jarPath = path.join(OUT, file.filename);
if (!fs.existsSync(jarPath)) {
  const r = await fetch(file.url, { headers: UA });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(jarPath, buf);
  console.log(`已下载 ${jarPath} (${buf.length} B)`);
} else {
  console.log(`已存在 ${jarPath}`);
}

// ── 2. 极简 ZIP 中央目录解析 ─────────────────────────────────────────────────
function readZipEntries(buf) {
  // 找 EOCD（End of Central Directory）签名 0x06054b50，从尾部往前扫
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD，不是合法 zip');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录条目 ${i} 签名错误 @${p}`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  // 本地头：签名(4) version(2) flags(2) method(2) time(2) date(2) crc(4) compSize(4) uncompSize(4) nameLen(2) extraLen(2)
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('本地头签名错误: ' + entry.name);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方法 ' + entry.method);
}

const buf = fs.readFileSync(jarPath);
const entries = readZipEntries(buf);
console.log(`\njar 内条目数：${entries.length}`);

// ── 3. 抽取证据 ──────────────────────────────────────────────────────────────
const modsToml = entries.filter((e) => /^META-INF\/mods\.toml$|^META-INF\/MANIFEST\.MF$/i.test(e.name));
console.log('\n=== META-INF/mods.toml ===');
for (const e of modsToml.filter((e) => /mods\.toml$/i.test(e.name))) {
  const text = readEntry(buf, e).toString('utf8');
  console.log(text.slice(0, 2000));
}

const langFiles = entries.filter((e) => /^assets\/[^/]+\/lang\/en_us\.json$/i.test(e.name));
console.log('\n=== lang 文件 ===');
let itemKeysFromLang = new Set();
for (const e of langFiles) {
  const json = JSON.parse(readEntry(buf, e).toString('utf8'));
  const keys = Object.keys(json);
  const itemKeys = keys.filter((k) => k.startsWith('item.') || k.startsWith('block.'));
  console.log(`  ${e.name}: 总键 ${keys.length}，item./block. 键 ${itemKeys.length}`);
  itemKeys.forEach((k) => itemKeysFromLang.add(k));
}
console.log('  item/block 键合计：', itemKeysFromLang.size);

const recipeFiles = entries.filter((e) => /^data\/[^/]+\/recipes?\/.+\.json$/i.test(e.name));
console.log(`\n=== 配方 json：${recipeFiles.length} 个 ===`);
const recipeIds = new Set();
let recipeSample = null;
for (const e of recipeFiles.slice(0, 3)) {
  try {
    const json = JSON.parse(readEntry(buf, e).toString('utf8'));
    if (!recipeSample) recipeSample = { name: e.name, json };
  } catch {}
}
for (const e of recipeFiles) {
  const m = e.name.match(/^data\/[^/]+\/recipes?\/(.+)\.json$/i);
  if (m) recipeIds.add(m[1]);
}
console.log('  配方 id 样例：', [...recipeIds].slice(0, 5));
if (recipeSample) {
  console.log('  首个配方原文：', recipeSample.name);
  console.log(JSON.stringify(recipeSample.json).slice(0, 600));
}

// ── 4. class 常量池里的注册名字符串 ──────────────────────────────────────────
const classEntries = entries.filter((e) => e.name.endsWith('.class'));
console.log(`\n=== class 文件：${classEntries.length} 个 ===`);
const NAMESPACE_HINT = /^[a-z][a-z0-9_]{1,30}:[a-z0-9_./-]{1,60}$/;
const found = new Map(); // id -> 出现次数
let scanned = 0;
for (const e of classEntries) {
  let data;
  try { data = readEntry(buf, e); } catch { continue; }
  scanned++;
  // 粗暴扫描：找 class 常量池里的 CONSTANT_Utf8（长度前缀 + 字节），这里直接正则扫 ASCII 串
  const text = data.toString('latin1');
  const re = /[a-z][a-z0-9_]{1,30}:[a-z0-9_./-]{1,60}/g;
  let m;
  while ((m = re.exec(text))) {
    const id = m[0];
    if (!NAMESPACE_HINT.test(id)) continue;
    found.set(id, (found.get(id) ?? 0) + 1);
  }
}
console.log(`扫描 class ${scanned} 个，抽出形如 namespace:path 的字符串 ${found.size} 个`);
const nsCount = new Map();
for (const id of found.keys()) {
  const ns = id.split(':')[0];
  nsCount.set(ns, (nsCount.get(ns) ?? 0) + 1);
}
console.log('  按 namespace 分布 top10：', [...nsCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
console.log('  样例：', [...found.keys()].slice(0, 20));
