/**
 * 探针 E：验证 ftbq-nbt（零依赖 NBT 编解码）能否作为 FTB Quests SNBT 的读写底座。
 * 下载 tarball → 解到 probe/ftbq-nbt → import 测试 round-trip。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '..', 'probe', 'ftbq-nbt');
fs.mkdirSync(OUT, { recursive: true });

// 1. 取 tarball URL
const meta = await (await fetch('https://registry.npmjs.org/ftbq-nbt')).json();
const ver = meta['dist-tags'].latest;
const tb = meta.versions[ver].dist.tarball;
console.log('ftbq-nbt', ver, tb);

// 2. 下载并解 tar.gz（tar 只需解 .js 文件）
const gz = Buffer.from(await (await fetch(tb, { headers: { 'User-Agent': 'probe' } })).arrayBuffer());
const tar = zlib.gunzipSync(gz);
const blocks = [];
for (let p = 0; p + 512 <= tar.length; ) {
  const name = tar.toString('utf8', p, p + 100).replace(/\0.*$/, '');
  if (!name) break;
  const size = parseInt(tar.toString('utf8', p + 124, p + 136).replace(/\0.*$/, '').trim(), 8);
  const data = tar.subarray(p + 512, p + 512 + size);
  if (name.endsWith('.js') || name.endsWith('.json') || name.endsWith('.md')) blocks.push({ name, data });
  p += 512 + Math.ceil(size / 512) * 512;
}
console.log('解出文件：', blocks.map((b) => b.name).join(', '));
for (const b of blocks) {
  const dest = path.join(OUT, b.name.replace(/^package\//, ''));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, b.data);
}

// 3. 试着 import
const entry = path.join(OUT, 'lib', 'cjs', 'index.js');
console.log('入口存在：', fs.existsSync(entry));
const mod = await import('file://' + entry.replace(/\\/g, '/'));
console.log('导出符号：', Object.keys(mod));

const readme = blocks.find((b) => /readme/i.test(b.name));
if (readme) console.log('\n=== README 摘录 ===\n' + readme.data.toString('utf8').slice(0, 3000));
