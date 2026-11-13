/**
 * 探针：在干净目录里真装一批 mod，量一下新下载引擎的实际耗时。
 *
 * 用法：node tools/probe-install-speed.mjs
 * 会写到 lab/_install_test/mods，跑完自己删。
 */

import fs from 'node:fs';
import path from 'node:path';

import { createHttp } from '../packages/core/mod-fetch.js';
import { buildInstallPlan, describePlan, applyInstallPlan, describeResult } from '../packages/core/mod-install.js';
import { formatSize } from '../packages/core/mod-source.js';

const root = path.resolve(import.meta.dirname, '..');
const modsDir = path.join(root, 'lab', '_install_test', 'mods');

const requests = ['create', 'kubejs', 'better-advanced-tooltips'];

async function main() {
  fs.rmSync(path.join(root, 'lab', '_install_test'), { recursive: true, force: true });
  fs.mkdirSync(modsDir, { recursive: true });

  const http = createHttp({});
  const plan = await buildInstallPlan({
    http,
    modsDir,
    requests,
    gameVersion: '1.21.1',
    loader: 'neoforge',
    channel: 'release',
    withDeps: true,
  });
  console.log(describePlan(plan));
  for (const item of plan.items) console.log(`  → ${item.fileName}  ${formatSize(item.size)}`);
  console.log(`合计 ${formatSize(plan.totalBytes)}，${plan.items.length} 个文件`);
  console.log('');

  const startedAt = Date.now();
  const applied = await applyInstallPlan({
    http,
    plan,
    modsDir,
    onProgress: (p) => {
      if (p.stage !== 'progress') return;
      const pct = p.total ? Math.floor((p.received / p.total) * 100) : 0;
      if (pct % 25 === 0 && pct > 0) console.log(`  ${p.title} ${pct}%`);
    },
  });

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log('');
  console.log(describeResult(applied));
  console.log('');
  console.log(`总耗时：${elapsed.toFixed(2)} 秒`);
  console.log(`平均：${(applied.installed.reduce((sum, item) => sum + item.bytes, 0) / 1024 / 1024 / Math.max(0.001, elapsed)).toFixed(2)} MB/s`);
  console.log(`连接池峰值：${http.pool.peak} / 额度 ${http.pool.limit}`);
  for (const item of applied.installed) console.log(`  ${item.fileName}  模式=${item.mode ?? '?'}  ${formatSize(item.bytes)}`);

  fs.rmSync(path.join(root, 'lab', '_install_test'), { recursive: true, force: true });
  console.log('已清理测试目录');
}

main().catch((error) => {
  console.error('失败：', error?.code ?? '', error?.message ?? error);
  if (error?.hint) console.error('提示：', error.hint);
  fs.rmSync(path.join(root, 'lab', '_install_test'), { recursive: true, force: true });
  process.exitCode = 1;
});
