/**
 * 看三种语言文件的键分布，确认「主语言 vs 翻译」的实际情况。
 * 用法：node test/lang-audit.mjs [questDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSnbt } from '../packages/core/snbt.js';

const dir = process.argv[2]
  ?? 'D:\\pcl2\\PCL 下载\\整合包\\重度机械症\\versions\\Mechanomania\\config\\ftbquests\\quests\\lang';

const files = fs.readdirSync(dir).filter((n) => n.endsWith('.snbt')).sort();
const tables = {};

for (const file of files) {
  const source = fs.readFileSync(path.join(dir, file), 'utf8');
  const value = parseSnbt(source, file);
  const keys = Object.keys(value);
  const counts = {};
  for (const key of keys) {
    const kind = /^(quest|chapter|chapter_group|reward_table)\./.exec(key)?.[1] ?? 'other';
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  tables[file.replace(/\.snbt$/, '')] = value;
  console.log(`${file.padEnd(12)} ${String(Buffer.byteLength(source)).padStart(7)} B  ${String(keys.length).padStart(6)} keys  ${JSON.stringify(counts)}`);
}

const names = Object.keys(tables);
if (names.length >= 2) {
  const [a, b] = names;
  const ka = new Set(Object.keys(tables[a]));
  const kb = new Set(Object.keys(tables[b]));
  const onlyA = [...ka].filter((k) => !kb.has(k));
  const onlyB = [...kb].filter((k) => !ka.has(k));
  const overlap = [...ka].filter((k) => kb.has(k));
  console.log(`\n${a} vs ${b}：重叠 ${overlap.length}，只在 ${a} ${onlyA.length}，只在 ${b} ${onlyB.length}`);
  const sample = onlyA.slice(0, 3).map((k) => `  ${k} = ${JSON.stringify(tables[a][k]).slice(0, 60)}`);
  if (sample.length) console.log(`只在 ${a} 的样例：\n${sample.join('\n')}`);
}
