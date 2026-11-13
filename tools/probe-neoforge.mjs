/**
 * 探针：NeoForge 安装器长什么样、能不能跑。
 *
 * 跑法：node tools/probe-neoforge.mjs
 * 会下到 lab/_nf/ 下（约 7 MB），跑完不删，方便反复看。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createHttp } from '../packages/core/mod-fetch.js';
import { openZip } from '../packages/core/zip.js';

const execFileAsync = promisify(execFile);

const root = path.resolve(import.meta.dirname, '..');
const workDir = path.join(root, 'lab', '_nf');
const version = '21.1.228';
const installerName = `neoforge-${version}-installer.jar`;
const installerPath = path.join(workDir, installerName);
const mirrorUrl = `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${version}/${installerName}`;

async function main() {
  fs.mkdirSync(workDir, { recursive: true });

  if (!fs.existsSync(installerPath)) {
    console.log('下载安装器…');
    const http = createHttp({});
    await http.downloadToFile(mirrorUrl, installerPath, {});
  }
  console.log('安装器', installerPath, (fs.statSync(installerPath).size / 1048576).toFixed(2), 'MB');

  const zip = openZip(fs.readFileSync(installerPath));
  const names = zip.names;
  console.log('条目数', names.length);
  console.log('顶层条目', names.filter((n) => !n.includes('/')).join(', '));
  console.log('有 install_profile.json：', zip.has('install_profile.json'));
  console.log('有 version.json：', zip.has('version.json'));
  console.log('有 data/：', names.filter((n) => n.startsWith('data/')).slice(0, 5).join(', '));
  console.log('有 maven/：', names.filter((n) => n.startsWith('maven/')).slice(0, 5).join(', '));

  if (zip.has('install_profile.json')) {
    const text = zip.text('install_profile.json');
    const profile = JSON.parse(text);
    console.log('');
    console.log('spec:', profile.spec);
    console.log('profile 键:', Object.keys(profile.profile ?? {}).join(', '));
    console.log('profile.id:', profile.profile?.id);
    console.log('version 键:', Object.keys(profile.version ?? {}).join(', '));
    console.log('processors 数:', (profile.processors ?? []).length);
    console.log('data 键:', Object.keys(profile.data ?? {}).slice(0, 10).join(', '));
    console.log('libraries 数:', (profile.libraries ?? []).length);
    if (profile.processors?.length) {
      console.log('第一个 processor:', JSON.stringify(profile.processors[0]).slice(0, 400));
    }
  }

  console.log('');
  console.log('看安装器主类：');
  try {
    const manifest = zip.text('META-INF/MANIFEST.MF') ?? '';
    console.log(manifest.split(/\r?\n/).filter((line) => /Main-Class|Implementation/i.test(line)).join('\n'));
  } catch (error) {
    console.log('读不到 MANIFEST:', error.message);
  }
}

main().catch((error) => {
  console.error('失败：', error?.code ?? '', error?.message ?? error);
  process.exitCode = 1;
});
