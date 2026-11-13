/**
 * 在真实包的副本上验证 KubeJS 那套底层能力（生成脚本 / 真写盘 / 全目录复验），原包一个字节都不动。
 * 跑法：node --import ./test/register.mjs test/real-kubejs-write.mjs
 *
 * 现在直接调 packages/core/ 里的函数：
 *   generateScript / targetFile  →  生成脚本（不写盘）
 *   runScript                   →  沙箱里真跑一遍
 *   writeFiles / restoreFiles   →  带备份的写盘和回滚
 *   verifyScripts               →  全目录复验
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyScripts, runScript } from '../packages/core/kubejs.js';
import { generateScript, targetFile } from '../packages/core/kubejs-write.js';
import { checkWritable, restoreFiles, writeFiles } from '../packages/core/write.js';

const src = 'D:\\pcl2\\PCL 下载\\整合包\\重度机械症\\versions\\Mechanomania';

console.log('=== 准备副本 ===');
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-kjs-w-'));
const kubejs = path.join(copy, 'kubejs');
fs.cpSync(path.join(src, 'kubejs'), kubejs, { recursive: true });
const before = fs.readdirSync(path.join(kubejs, 'server_scripts')).length;
console.log(`副本：${copy}`);
console.log(`原有服务端脚本：${before} 个`);

const spec = {
  remove: [{ id: 'create:crafting/kinetics/cogwheel' }],
  recipes: [
    { kind: 'shaped', output: 'minecraft:diamond', count: 2, pattern: ['AAA', 'ABA', 'AAA'], keys: { A: 'minecraft:coal', B: 'create:andesite_alloy' } },
    { kind: 'shapeless', output: 'minecraft:emerald', inputs: ['minecraft:diamond', 'minecraft:coal'] },
    { kind: 'pressing', output: 'create:zinc_ingot', inputs: ['minecraft:iron_ingot'] },
  ],
  header: '由 MC 整合包工作室生成（端到端测试）',
};

console.log('\n=== 1. plan（不写盘）===');
const { code, summary } = generateScript(spec);
const dest = targetFile(kubejs, 'e2e_test');
console.log('目标路径 =', dest);
console.log('摘要：');
for (const s of summary) console.log('  -', s);
console.log('\n生成的代码：');
console.log(code.split('\n').map((l) => `    ${l}`).join('\n'));
// 生成的代码自己得先能跑通，否则写了也是废的
const self = runScript(code, 'kubejs/server_scripts/preview.js');
console.log('\n生成的代码沙箱自检 =', self.status, self.error || '');
if (self.status !== 'ok') throw new Error('生成的代码自己就跑不通');
console.log('plan 之后文件是否被写？', fs.existsSync(dest) ? '❌ 写了' : '✅ 没写');

console.log('\n=== 2. apply（真写）===');
const writable = checkWritable(path.dirname(dest));
if (!writable.ok) throw new Error(`写不进去：${writable.error}`);
const { backups, done } = writeFiles([{ file: dest, content: code }], '写 KubeJS 脚本');
console.log('写入 =', dest);
console.log('备份 =', backups.length ? backups.join('、') : '（新建文件，无需备份）');
console.log('文件存在 =', fs.existsSync(dest));
if (fs.existsSync(dest)) {
  const saved = fs.readFileSync(dest, 'utf8');
  console.log('落盘内容与 plan 一致 =', saved === code);
}
// 写完立刻复验这个脚本本身
const self2 = runScript(fs.readFileSync(dest, 'utf8'), `kubejs/server_scripts/${path.basename(dest)}`);
console.log('写完单文件复查 =', self2.status, self2.error || '');
if (self2.status !== 'ok') {
  restoreFiles(done);
  throw new Error('写完复查不过，已回滚');
}

console.log('\n=== 3. 写完全目录复验 ===');
const verified = verifyScripts(kubejs);
console.log(`脚本 ${verified.scriptCount} 个 / 能跑 ${verified.breakdown.ok ?? 0} / 语法错 ${verified.breakdown['syntax-error'] ?? 0} / 一跑就报错 ${verified.breakdown['runtime-error'] ?? 0}`);
console.log(`引用了不存在的物品 ${verified.missingItems.length} 个`);
for (const s of verified.scripts.filter((x) => x.status !== 'ok').slice(0, 5)) {
  console.log(`  ❌ ${s.file}：${s.error}`);
}

console.log('\n=== 4. 故意写坏，看会不会被拦下 ===');
let bad = null;
try {
  generateScript({ remove: [], recipes: [{ kind: 'shapeless', output: 'minecraft:stick', inputs: [] }] });
} catch (e) {
  bad = { error: String(e && e.message ? e.message : e), code: e?.code ?? '' };
}
console.log('空材料是否被拒 =', bad ? '✅' : '❌ 没拦住');
if (bad) console.log(`   拒绝原因：${bad.error}（${bad.code}）`);
console.log('坏文件是否存在（应该不存在）=', fs.existsSync(path.join(kubejs, 'server_scripts', 'dsh_e2e_bad.js')) ? '❌ 存在' : '✅ 不存在');

console.log('\n=== 5. 原包未被改动 ===');
const srcScripts = fs.readdirSync(path.join(src, 'kubejs', 'server_scripts'));
console.log(`原包 server_scripts 仍是 ${srcScripts.length} 项，含 dsh_ 文件：${srcScripts.filter((f) => f.startsWith('dsh_')).join('、') || '无'}`);

fs.rmSync(copy, { recursive: true, force: true });
console.log('\n副本已删除。');
