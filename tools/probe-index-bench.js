/**
 * 探针 D：给「整个整合包建物品索引」计时，判断可行性。
 * 只对已下载的 jar 计时；同时报告内存峰值。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DIR = path.resolve(import.meta.dirname, '..', 'probe', 'jar');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jar'));

function readZipEntries(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no eocd');
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

function indexJar(file) {
  const t0 = performance.now();
  const buf = fs.readFileSync(path.join(DIR, file));
  const t1 = performance.now();
  const entries = readZipEntries(buf);
  const t2 = performance.now();
  const ids = new Set();
  let modId = null;
  for (const e of entries) {
    const m = e.name.match(/^assets\/([^/]+)\/models\/item\/(.+)\.json$/);
    if (m) ids.add(`${m[1]}:${m[2]}`);
    if (e.name === 'META-INF/mods.toml') {
      try {
        const t = readEntry(buf, e).toString('utf8');
        const mm = t.match(/modId\s*=\s*"([^"]+)"/);
        if (mm) modId = mm[1];
      } catch {}
    }
  }
  const t3 = performance.now();
  return { file, bytes: buf.length, entries: entries.length, ids: ids.size, modId,
    readMs: Math.round(t1 - t0), zipMs: Math.round(t2 - t1), scanMs: Math.round(t3 - t2), totalMs: Math.round(t3 - t0) };
}

console.log('开始计时…');
let total = 0;
for (const f of files) {
  const r = indexJar(f);
  total += r.totalMs;
  console.log(`  ${r.file} ${(r.bytes / 1048576).toFixed(1)}MB entries=${r.entries} itemModels=${r.ids} modId=${r.modId} | read=${r.readMs}ms zip=${r.zipMs}ms scan=${r.scanMs}ms total=${r.totalMs}ms`);
}
console.log(`\n合计 ${files.length} 个 jar，总耗时 ${total} ms，平均 ${Math.round(total / files.length)} ms/jar`);
console.log(`内存 RSS=${(process.memoryUsage().rss / 1048576).toFixed(1)}MB heap=${(process.memoryUsage().heapUsed / 1048576).toFixed(1)}MB`);
console.log(`推算：200 个 jar 的整合包约 ${Math.round((total / files.length) * 200 / 1000)} 秒`);
