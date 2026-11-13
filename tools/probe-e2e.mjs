/**
 * 端到端走一遍：真装 mod → 真打包（offline / standard）。
 * 用实验室里的「最小包」，不碰用户的真包。
 *
 * 跑法：node tools/probe-e2e.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { createHttp } from '../packages/core/mod-fetch.js';
import { buildInstallPlan, describePlan, applyInstallPlan, describeResult } from '../packages/core/mod-install.js';
import { buildExport, planExport } from '../packages/core/export.js';
import { resolveInstance } from '../packages/core/instance.js';
import { formatSize } from '../packages/core/mod-source.js';

const LAB = String.raw`D:\Desktop\VibeCoding\minecraft-modpack-studio\lab\重度机械症 - 实验`;
const instanceDir = path.join(LAB, 'versions', '最小包');
const instance = resolveInstance(instanceDir);
console.log('实例：', instance.id, instance.mcVersion, instance.loader, 'mods=', instance.modsCount);

const http = createHttp({});
const plan = await buildInstallPlan({
  http,
  modsDir: path.join(instanceDir, 'mods'),
  requests: ['create', 'kubejs', 'ftb-quests'],
  gameVersion: instance.mcVersion,
  loader: instance.loader,
  channel: 'release',
  withDeps: true,
});
console.log(describePlan(plan));
for (const it of plan.items) {
  console.log(`  - ${it.title}  ${it.fileName}  ${formatSize(it.size)}  sha1=${String(it.sha1 ?? '').slice(0, 8)}`);
}
for (const u of plan.unresolved) console.log('  未解决：', u.title ?? u.slug ?? JSON.stringify(u));
for (const c of plan.conflicts) console.log('  冲突：', JSON.stringify(c));

if (plan.items.length === 0) {
  console.log('清单是空的，后面不用跑了');
  process.exit(1);
}

const applied = await applyInstallPlan({
  http,
  plan,
  modsDir: path.join(instanceDir, 'mods'),
  onProgress: (p) => {
    if (p.done === p.total || p.done % 1 === 0) console.log(`  下载 ${p.done}/${p.total} ${formatSize(p.bytes ?? 0)}`);
  },
});
console.log(describeResult(applied));

const after = resolveInstance(instanceDir);
console.log('装完 mods=', after.modsCount, after.disabledModsCount);
for (const f of fs.readdirSync(path.join(instanceDir, 'mods'))) {
  console.log('  mods/', f, formatSize(fs.statSync(path.join(instanceDir, 'mods', f)).size));
}

// 真打两个包：standard 只打内容，offline 连游戏本体
for (const mode of ['standard', 'offline']) {
  const p = planExport(after, { mode, packName: `最小包-${mode}` });
  console.log(`\n[${mode}] ${p.fileCount} 个文件，约 ${formatSize(p.totalBytes)} → ${p.suggestZip}`);
  if (p.warnings.length) console.log('  提醒：', p.warnings.join('；'));
  const t0 = Date.now();
  const r = await buildExport(after, { mode, packName: `最小包-${mode}` });
  console.log(`  打好：${r.outFile}`);
  console.log(`  ${formatSize(r.bytes)}，${r.entries} 个条目，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，自检 ok=${r.check.ok}`);
  for (const item of r.check.items) console.log(`   - ${item.ok ? '过' : '不过'} ${item.rule}${item.detail ? `：${item.detail}` : ''}`);
}