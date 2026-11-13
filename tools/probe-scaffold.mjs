/**
 * 探针：用 `packages/core/scaffold.js` 从零装一个包（不碰用户目录）。
 *
 *   node tools/probe-scaffold.mjs            只算计划
 *   node tools/probe-scaffold.mjs apply      真装
 *
 * 产物落在 lab/_scaffold/mcroot/versions/<包名>。
 */

import { createHttp, readNetOptionsFromEnv } from '../packages/core/mod-fetch.js';
import { applyScaffold, describeScaffold, planScaffold } from '../packages/core/scaffold.js';

const mode = process.argv[2] ?? 'plan';
const http = createHttp({ ...readNetOptionsFromEnv(process.env), mirrorMode: 'auto' });

const plan = await planScaffold({
  http,
  mcRoot: 'lab/_scaffold/mcroot',
  name: process.env.PACK_NAME ?? '向导装好的包',
  mcVersion: '1.21.1',
  loader: 'neoforge',
  loaderVersion: '21.1.228',
});

console.log(describeScaffold(plan).join('\n'));
console.log('--- 步骤 ---');
for (const step of plan.steps) console.log(' ', step.key, step.title, step.done ? '(已有)' : '');

if (mode !== 'apply') {
  console.log('\n只算计划，没写盘。要真装就再跑：node tools/probe-scaffold.mjs apply');
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
