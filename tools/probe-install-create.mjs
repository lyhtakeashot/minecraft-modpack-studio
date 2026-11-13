/**
 * 只装 Create 一个（18 MB），验证「大文件下载不再被总时长掐断」。
 * 跑法：node tools/probe-install-create.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { createHttp } from '../packages/core/mod-fetch.js';
import { buildInstallPlan, describePlan, applyInstallPlan, describeResult } from '../packages/core/mod-install.js';
import { resolveInstance } from '../packages/core/instance.js';
import { formatSize } from '../packages/core/mod-source.js';

const instanceDir = String.raw`D:\Desktop\VibeCoding\minecraft-modpack-studio\lab\重度机械症 - 实验\versions\最小包`;
const instance = resolveInstance(instanceDir);
const modsDir = path.join(instanceDir, 'mods');
console.log('实例：', instance.id, instance.mcVersion, instance.loader, 'mods=', instance.modsCount);

const http = createHttp({});
const plan = await buildInstallPlan({
  http,
  modsDir,
  requests: ['create'],
  gameVersion: instance.mcVersion,
  loader: instance.loader,
  channel: 'release',
  withDeps: true,
});
console.log(describePlan(plan));
for (const it of plan.items) console.log(`  → ${it.fileName}  ${formatSize(it.size)}`);

const t0 = Date.now();
let last = 0;
const applied = await applyInstallPlan({
  http,
  plan,
  modsDir,
  onProgress: (p) => {
    const pct = p.total ? Math.floor((p.received / p.total) * 100) : 0;
    if (pct >= last + 20 || pct === 100) {
      last = pct;
      console.log(`  下载中 ${pct}%（${formatSize(p.received)} / ${formatSize(p.total)}）`);
    }
  },
});
console.log(describeResult(applied));
console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const after = resolveInstance(instanceDir);
console.log('装完 mods=', after.modsCount);
for (const f of fs.readdirSync(modsDir)) console.log('  ', f, formatSize(fs.statSync(path.join(modsDir, f)).size));