/**
 * 探针：在真实整合包上取一遍任务图标。
 *
 * 为什么值得跑：图标解析最容易在「真实包」上出问题 ——
 * 几百个 jar、几十万个条目、原版贴图在 assets/objects 里而不是 jar 里。
 * 这个脚本只看数据，不写任何东西。
 *
 * 用法：node --import ./test/register.mjs tools/probe-quest-icons.mjs [实例目录]
 */
import path from 'node:path';
import { resolveInstance } from '../packages/core/instance.js';
import { loadQuests } from '../packages/core/quests.js';
import { buildTextureIndex, resolveIcons } from '../packages/core/item-icon.js';

const DEFAULT_DIR = path.resolve('lab', '重度机械症 - 实验', 'versions', 'Mechanomania');
const dir = process.argv[2] ?? DEFAULT_DIR;

const instance = resolveInstance(dir);
console.log(`实例：${instance.id}（${instance.mcVersion} / ${instance.loader}）`);
console.log(`mods：${instance.modsCount} 个`);

const questDir = instance.questDirs?.[0];
if (!questDir) {
  console.log('这个包没有任务书，跳过。');
  process.exit(0);
}

const t0 = Date.now();
const book = loadQuests(questDir, {});
console.log(`任务书：${book.chapters.length} 章 / ${book.quests.length} 个任务（${Date.now() - t0}ms）`);

// 画布上会画哪些物品：任务的 icon（没写就是第一个物品任务的物品）
const ids = [];
for (const quest of book.quests) {
  const id = quest.icon || quest.titleItem;
  if (id && !ids.includes(id)) ids.push(id);
}
console.log(`不同的图标物品：${ids.length} 个`);

const t1 = Date.now();
const index = buildTextureIndex(instance.modsDir);
console.log(`纹理索引：${index.jars} 个 jar / ${index.textures} 张贴图 / ${index.models} 个模型，用时 ${index.elapsedMs}ms`);

const t2 = Date.now();
const r = resolveIcons(instance, ids, { index, limit: 128 });
console.log(`解析前 ${Math.min(128, ids.length)} 个：找到 ${r.icons.size} 个，缺 ${r.missing.length} 个，用时 ${Date.now() - t2}ms`);

if (r.missing.length) {
  console.log('缺图标的（前 12 个）：');
  for (const id of r.missing.slice(0, 12)) console.log(`  - ${id}`);
}
const sample = [...r.icons.entries()].slice(0, 5);
for (const [id, icon] of sample) {
  console.log(`  ✓ ${id}  ${icon.bytes} B  ${icon.source}`);
}
const bytes = [...r.icons.values()].reduce((n, i) => n + i.bytes, 0);
console.log(`图标原始字节合计：${(bytes / 1024).toFixed(1)} KB（走 HTTP 会 base64，约 ×1.33）`);