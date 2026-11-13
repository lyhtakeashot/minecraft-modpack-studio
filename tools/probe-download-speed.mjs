/**
 * 探针：真下一个大文件，看分段并行到底有没有用。
 *
 * 用法：node tools/probe-download-speed.mjs [--off]
 *   --off 表示强制不分段（对照组），不带参数走新引擎。
 *
 * 这个脚本会真联网、真写盘（写到 lab/_download_test/），跑完自己删。
 */

import fs from 'node:fs';
import path from 'node:path';

import { createHttp } from '../packages/core/mod-fetch.js';
import { createConnectionPool } from '../packages/core/downloader.js';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'lab', '_download_test');

const args = new Set(process.argv.slice(2));
const disableSegments = args.has('--off');

const URL_CREATE = 'https://cdn.modrinth.com/data/LNytGWDc/versions/UjX6dr61/create-1.21.1-6.0.10.jar';
const SIZE_CREATE = 19_123_767;
const SHA1_CREATE = '0e97e49837bed766e6f28a4c95b04885d6acc353';

/** 运行时查一个小文件的真实下载地址，避免把 version id 写死（写死会 400）。 */
async function resolveSmallUrl() {
  const response = await fetch('https://api.modrinth.com/v2/project/kubejs/version?include_changelog=false', {
    headers: { 'User-Agent': 'DSH-MCModpackStudio/0.1' },
  });
  if (!response.ok) throw new Error(`查 KubeJS 版本失败：${response.status}`);
  const list = await response.json();
  const pick = list.find((v) => v.game_versions.includes('1.21.1') && v.loaders.includes('neoforge') && v.version_type === 'release');
  if (!pick) throw new Error('没找到 KubeJS 的 1.21.1 NeoForge 正式版');
  return { url: pick.files[0].url, size: pick.files[0].size, sha1: pick.files[0].hashes.sha1 };
}

/**
 * 模拟下整合包底座：一堆小文件同时下，看连接池有没有把并发摁在额度内。
 */
async function manySmall() {
  const small = await resolveSmallUrl();
  console.log(`小文件：${small.url.split('/').pop()}  ${(small.size / 1024).toFixed(0)} KB`);
  const pool = createConnectionPool({ limit: 8 });
  const http = createHttp({ pool });
  const startedAt = Date.now();
  const count = 16;
  let done = 0;

  const jobs = Array.from({ length: count }, async (_unused, index) => {
    const target = path.join(outDir, `small-${index}.jar`);
    await http.downloadToFile(small.url, target, { size: small.size, sha1: small.sha1 });
    done += 1;
    if (done % 8 === 0) console.log(`  完成 ${done}/${count}`);
  });

  await Promise.all(jobs);
  const elapsed = (Date.now() - startedAt) / 1000;
  const totalBytes = small.size * count;
  console.log('');
  console.log(`${count} 个小文件并发：${elapsed.toFixed(2)} 秒，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`连接池峰值：${pool.peak} / 额度 ${pool.limit}`);
  console.log(`实际建立连接：${pool.acquired} 次`);
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log('已清理测试文件');
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  if (args.has('--many')) {
    await manySmall();
    return;
  }
  const target = path.join(outDir, `create-${disableSegments ? 'off' : 'on'}.jar`);

  const pool = createConnectionPool({ limit: 64 });
  const http = createHttp({
    pool,
    enableSegments: !disableSegments,
    mirrorMode: process.env.MCSTUDIO_MIRROR_MODE ?? 'fallback',
  });

  console.log(`模式：${disableSegments ? '不分段（对照）' : '分段并行'}  镜像：${http.config.mirrorMode}`);
  console.log(`目标：${target}`);

  let lastReport = 0;
  const startedAt = Date.now();
  const result = await http.downloadToFile(URL_CREATE, target, {
    size: SIZE_CREATE,
    sha1: SHA1_CREATE,
    onProgress({ received, total }) {
      const now = Date.now();
      if (now - lastReport < 1000) return;
      lastReport = now;
      const pct = total > 0 ? ((received / total) * 100).toFixed(1) : '?';
      const mbps = received / 1024 / 1024 / Math.max(0.001, (now - startedAt) / 1000);
      console.log(`  ${pct}%  ${(received / 1024 / 1024).toFixed(2)} MB  ${mbps.toFixed(2)} MB/s`);
    },
  });

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log('');
  console.log(`耗时：${elapsed.toFixed(2)} 秒`);
  console.log(`平均：${(result.bytes / 1024 / 1024 / elapsed).toFixed(2)} MB/s`);
  console.log(`模式：${result.mode}  段数：${result.segments}  分裂：${result.splits}`);
  console.log(`sha1：${result.sha1}`);
  console.log(`连接池峰值：${pool.peak} / 额度 ${pool.limit}`);

  fs.rmSync(outDir, { recursive: true, force: true });
  console.log('已清理测试文件');
}

main().catch((error) => {
  console.error('失败：', error?.code ?? '', error?.message ?? error);
  if (error?.hint) console.error('提示：', error.hint);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exitCode = 1;
});
