/**
 * 探针 F2：ftbq-nbt 对 FTB Quests 真实 SNBT 的读写保真度。
 * 关键发现：FTB Quests 的 SNBT 省略逗号（靠换行分隔），必须传 { skipComma: true }。
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const entry = path.resolve(import.meta.dirname, '..', 'probe', 'ftbq-nbt', 'lib', 'cjs', 'index.js');
const nbt = require_(entry);
const { parse, stringify, Byte, Short, Int, Float } = nbt;

// FTB Quests 1.20.1 真实章节文件形状（无逗号 + 制表符缩进 + 类型后缀）
const chapter = `{
\tid: "1A2B3C4D5E6F7081"
\ttitle: "第一章 · 机械启蒙"
\ticon: "create:cogwheel"
\talways_invisible: false
\tgroup: ""
\tdefault_quest_shape: ""
\tdefault_hide_dependency_lines: false
\tquests: [
\t\t{
\t\t\tid: "0F1E2D3C4B5A6978"
\t\t\ttitle: "第一块安山合金"
\t\t\tx: 0.0d
\t\t\ty: 0.0d
\t\t\tshape: "circle"
\t\t\tsize: 1.0d
\t\t\ttasks: [{
\t\t\t\tid: "11223344556677AA"
\t\t\t\ttype: "item"
\t\t\t\titem: "create:andesite_alloy"
\t\t\t\tcount: 4L
\t\t\t}]
\t\t\trewards: [{
\t\t\t\tid: "AABBCCDDEEFF0011"
\t\t\t\ttype: "xp"
\t\t\t\txp: 20
\t\t\t}]
\t\t}
\t\t{
\t\t\tid: "2233445566778899"
\t\t\ttitle: "动力轴"
\t\t\tx: 1.5d
\t\t\ty: 0.0d
\t\t\tshape: "circle"
\t\t\tsize: 1.0d
\t\t\tdependencies: ["0F1E2D3C4B5A6978"]
\t\t\ttasks: [{
\t\t\t\tid: "33445566778899AA"
\t\t\t\ttype: "item"
\t\t\t\titem: "create:shaft"
\t\t\t\tcount: 8L
\t\t\t}]
\t\t}
\t]
}`;

const OPTS = { skipComma: true, useBoolean: true };

console.log('=== A. 解析带跳逗号的 FTB SNBT ===');
const tree = parse(chapter, OPTS);
console.log('顶层键：', Object.keys(tree));
console.log('title =', JSON.stringify(tree.title));
console.log('quests.length =', tree.quests.length);
console.log('q0 =', JSON.stringify(tree.quests[0], (k, v) => (typeof v === 'bigint' ? v + 'n' : v)));
console.log('q0.x 类型 =', typeof tree.quests[0].x, tree.quests[0].x?.constructor?.name ?? '');
console.log('q0.tasks[0].count =', tree.quests[0].tasks[0].count, typeof tree.quests[0].tasks[0].count);
console.log('always_invisible =', tree.always_invisible, typeof tree.always_invisible);

console.log('\n=== B. 增量修改：追加一个任务（带依赖边）===');
tree.quests.push({
  id: '9F8E7D6C5B4A3928',
  title: '齿轮箱的诞生',
  x: 3.0,
  y: 0.0,
  shape: 'circle',
  size: 1.0,
  dependencies: ['2233445566778899'],
  tasks: [{ id: 'A1B2C3D4E5F60718', type: 'item', item: 'create:cogwheel', count: 2n }],
});
console.log('quests.length =', tree.quests.length);

console.log('\n=== C. 序列化（对齐 FTB 风格）===');
const out = stringify(tree, {
  skipComma: true,
  useBoolean: true,
  pretty: true,
  tab: '\t',
  typePostfix: { L: 'L', D: 'd', B: 'b', S: 's', F: 'f' },
  newline: '\n',
  breakLength: 1, // 强制多行，贴近 FTB 的每条一行风格
});
console.log(out);

console.log('=== D. 保真度校验 ===');
const checks = {
  '无逗号分隔': !/,\s*\n/.test(out.replace(/\[[^\]]*\]/g, '[]')),
  '有制表符缩进': /\t/.test(out),
  'double 后缀 d': /\d\.\d+d\b/.test(out) || /\d+\.0d\b/.test(out),
  'long 后缀 L': /\d+L\b/.test(out),
  '键顺序 id→title': out.indexOf('id:') < out.indexOf('title:'),
  '保留中文标题': out.includes('第一章 · 机械启蒙'),
};
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);

console.log('\n=== E. 二次解析（幂等）===');
const back = parse(out, OPTS);
console.log('quests.length =', back.quests.length, '(期望 3)');
console.log('新任务 title =', JSON.stringify(back.quests[2].title));
console.log('新任务 count =', back.quests[2].tasks[0].count, '(期望 2n)');
console.log('依赖边 =', JSON.stringify(back.quests[2].dependencies));

console.log('\n=== F. 坏数据容错（悬空依赖 / 拼错 id 都能读，靠我们自己校验）===');
const bad = `{\n\tid: "1"\n\tquests: [{\n\t\tid: "2"\n\t\tdependencies: ["NOPE"]\n\t\ttasks: [{ id: "3", type: "item", item: "create:not_real", count: 1L }]\n\t}]\n}`;
const badTree = parse(bad, OPTS);
console.log('坏数据也能解析：', badTree.quests[0].dependencies, badTree.quests[0].tasks[0].item);
console.log('→ 结论：parse 只保证语法，语义校验（ID 真实性/环检测）必须我们自己做。');
