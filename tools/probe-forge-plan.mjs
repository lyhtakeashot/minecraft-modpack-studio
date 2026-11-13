/**
 * 探针：1.20.1 Forge 的「从零装底座」到底能算出什么（默认不下载、不写盘）。
 *
 *   node tools/probe-forge-plan.mjs              只算计划
 *   node tools/probe-forge-plan.mjs apply        真装
 *
 * 产物落在 lab/_forge/mcroot/versions/<包名>。
 * 环境变量可以覆盖：MC_VERSION / LOADER / LOADER_VERSION / PACK_NAME / MC_ROOT
 */

import { createHttp, readNetOptionsFromEnv } from '../packages/core/mod-fetch.js';
import { applyScaffold, describeScaffold, planScaffold } from '../packages/core/scaffold.js';

const mode = process.argv[2] ?? 'plan';
const http = createHttp({ ...readNetOptionsFromEnv(process.env), mirrorMode: 'auto' });

const opts = {
  http,
  mcRoot: process.env.MC_ROOT ?? 'lab/_forge/mcroot',
  name: process.env.PACK_NAME ?? 'Forge测试包',
  mcVersion: process.env.MC_VERSION ?? '1.20.1',
  loader: process.env.LOADER ?? 'forge',
  loaderVersion: process.env.LOADER_VERSION ?? '',
};
if (!opts.loaderVersion) delete opts.loaderVersion;

console.log('== 目标 ==');
console.log(JSON.stringify({ mcVersion: opts.mcVersion, loader: opts.loader, name: opts.name, mcRoot: opts.mcRoot }, null, 2));

const plan = await planScaffold(opts);

console.log('\n== 计划 ==');
console.log(describeScaffold(plan).join('\n'));
console.log('--- Java ---');
console.log(JSON.stringify(plan.java, null, 2));
console.log('--- Java 候选 ---');
for (const c of plan.javaCandidates) {
  console.log(`  ${c.matches ? '✓' : '✗'} ${c.major} ${c.source} ${c.path}`);
}
console.log('--- 安装器 ---');
console.log(JSON.stringify(plan.installer, null, 2));
console.log('--- 步骤 ---');
for (const step of plan.steps) console.log(`  ${step.key} ${step.title} ${step.done ? '(已有)' : ''}`);
if (plan.warnings.length) {
  console.log('--- 警告 ---');
  for (const w of plan.warnings) console.log(`  ! ${w}`);
}

if (mode !== 'apply') {
  console.log('\n只算计划，没写盘。');
  process.exit(0);
}

console.log('\n开始装…');
let lastPhase = '';
const result = await applyScaffold({
  plan,
  http,
  onProgress: (event) => {
    if (event.stage === 'step') {
      console.log(`  [${event.key}] ${event.status} ${event.detail ?? ''}`);
      return;
    }
    if (event.stage === 'files' && event.phase !== lastPhase) {
      lastPhase = event.phase;
      console.log(`  ${event.phase} 开始，共 ${event.total} 个文件`);
      return;
    }
    if (event.stage === 'files' && event.done % 500 === 0) {
      console.log(`  ${event.phase} ${event.done}/${event.total}`);
    }
  },
});

console.log('\n=== 装完了 ===');
console.log(JSON.stringify(result, null, 2));