// 临时探针：建一个最小包，看看产物对不对（用完就删）。
// 直接调 core 的 pack-create 模块（插件版的 mc_pack_create 工具层已删）。
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPackPlan,
  applyPackPlan,
  describePackPlan,
  describePackResult,
} from '../packages/core/pack-create.js';

const mcRoot = String.raw`D:\Desktop\VibeCoding\minecraft-modpack-studio\lab\重度机械症 - 实验`;

const plan = buildPackPlan({
  mcRoot,
  name: '最小包',
  templateDir: mcRoot + String.raw`\versions\Mechanomania`,
  withQuestBook: true,
  withKubejs: true,
});

let lines = describePackPlan(plan);
let applied = false;
let result = null;
if (process.argv[2] === 'apply') {
  result = applyPackPlan(plan);
  applied = true;
  lines = describePackResult(result, plan);
}

console.log(lines.join('\n'));
console.log('---');
console.log('targetDir =', plan.targetDir);
console.log('applied =', applied, '总大小 =', plan.totalBytes, '字节');
console.log('版本 =', plan.template.mcVersion, '加载器 =', plan.template.loader, plan.template.loaderVersion);

const json = JSON.parse(fs.readFileSync(path.join(plan.targetDir, '最小包.json'), 'utf8'));
console.log('新 json id =', json.id, '| mainClass =', json.mainClass, '| libraries =', json.libraries.length);
console.log('目录里：', fs.readdirSync(plan.targetDir).join(', '));
