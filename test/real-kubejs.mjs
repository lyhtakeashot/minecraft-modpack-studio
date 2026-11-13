/**
 * 拿真实包跑一遍 KubeJS 校验，看和 docs/archive/HANDBOFF.md §4.4 记的基线对不对。
 *
 * 用法：node test/real-kubejs.mjs
 */
import path from 'node:path';
import { verifyScripts, describeVerify } from '../packages/core/kubejs.js';
import { resolveInstance } from '../packages/core/instance.js';
import { indexInstance } from '../packages/core/index.js';

const INSTANCE = 'D:\\pcl2\\PCL 下载\\整合包\\重度机械症\\versions\\Mechanomania';

const instance = resolveInstance(INSTANCE);
console.log(`实例：${instance.id} / ${instance.mcVersion ?? '?'}`);

const t0 = Date.now();
const idx = indexInstance(instance);
console.log(`索引：${idx.itemCount} 物品 / ${idx.recipeCount} 配方 / ${idx.indexedMs}ms`);

const kubejsDir = path.join(instance.instanceDir, 'kubejs');
const report = verifyScripts(kubejsDir, {
  mcVersion: instance.mcVersion,
  knownItems: (id) => idx.has(id) || id.startsWith('kubejs:'),
});
console.log(`\n校验用时 ${report.elapsedMs}ms，总 ${Date.now() - t0}ms`);
console.log(describeVerify(report).join('\n'));

console.log('\n— 有调用的脚本明细 —');
for (const s of report.scripts) {
  if (s.status !== 'ok') continue;
  if (!s.recipes && !s.removals) continue;
  console.log(`  ${s.file}: 加配方 ${s.recipes}，删配方 ${s.removals}，引用物品 ${s.itemRefs}，缺 ${s.missingItems}`);
}
