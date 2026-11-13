/**
 * 从零装底座那一层的单元测试（纯逻辑 + 本地文件，不联网）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeZip } from './make-zip.mjs';
import {
  applyItems,
  assetItems,
  buildLoaderPlan,
  buildVanillaPlan,
  copyClientJar,
  describePlan,
  formatBytes,
  libraryItems,
  locateLoaderVersion,
  mavenPath,
  mavenUrl,
  planCore,
  readInstallerProfile,
  writeGameVersionJson,
  writeInstanceVersionJson,
} from '../packages/core/version-install.js';
import { candidateUrlsFor } from '../packages/core/version-manifest.js';

function tmpRoot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mcstudio-${name}-`));
  return dir;
}

function fakeVersionJson() {
  return {
    id: '1.21.1',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    javaVersion: { majorVersion: 21 },
    downloads: {
      client: { size: 1000, sha1: 'c'.repeat(40), url: 'https://piston-data.mojang.com/v1/objects/aa/client.jar' },
    },
    libraries: [
      {
        name: 'org.example:alpha:1.0',
        downloads: { artifact: { path: 'org/example/alpha/1.0/alpha-1.0.jar', size: 100, sha1: 'a'.repeat(40), url: 'https://libraries.minecraft.net/org/example/alpha/1.0/alpha-1.0.jar' } },
      },
      {
        // 同一路径出现两次，只留一份
        name: 'org.example:alpha:1.0',
        downloads: { artifact: { path: 'org/example/alpha/1.0/alpha-1.0.jar', size: 100, sha1: 'a'.repeat(40), url: 'https://libraries.minecraft.net/org/example/alpha/1.0/alpha-1.0.jar' } },
      },
      {
        // 只在 windows 上用
        name: 'org.example:winonly:2.0:natives-windows',
        rules: [{ action: 'allow', os: { name: 'windows' } }],
        downloads: { artifact: { path: 'org/example/winonly/2.0/winonly-2.0-natives-windows.jar', size: 50, sha1: 'b'.repeat(40), url: 'https://libraries.minecraft.net/org/example/winonly/2.0/winonly-2.0-natives-windows.jar' } },
      },
      {
        // 只在 macOS 上用
        name: 'org.example:maconly:2.0',
        rules: [{ action: 'allow', os: { name: 'osx' } }],
        downloads: { artifact: { path: 'org/example/maconly/2.0/maconly-2.0.jar', size: 70, sha1: 'd'.repeat(40), url: 'https://libraries.minecraft.net/org/example/maconly/2.0/maconly-2.0.jar' } },
      },
      {
        // 没有 artifact 的条目直接跳过
        name: 'org.example:noartifact:3.0',
      },
    ],
    assetIndex: { id: '17', size: 500, sha1: 'e'.repeat(40), totalSize: 9000, url: 'https://piston-meta.mojang.com/v1/packages/ff/17.json' },
    logging: { client: { file: { id: 'client-1.12.xml', size: 20, sha1: 'f'.repeat(40), url: 'https://piston-data.mojang.com/v1/objects/bb/client-1.12.xml' } } },
  };
}

test('maven 坐标展开成路径', () => {
  assert.equal(mavenPath('net.neoforged:neoform:1.21.1-20240808.144430'), 'net/neoforged/neoform/1.21.1-20240808.144430/neoform-1.21.1-20240808.144430.jar');
  assert.equal(
    mavenPath('net.neoforged:neoform:1.21.1-20240808.144430:mappings@txt'),
    'net/neoforged/neoform/1.21.1-20240808.144430/neoform-1.21.1-20240808.144430-mappings.txt',
  );
  assert.equal(mavenPath('a.b:c:1.0@zip'), 'a/b/c/1.0/c-1.0.zip');
  assert.throws(() => mavenPath(''), /maven 坐标是空的/);
  assert.throws(() => mavenPath('only:two'), /格式不对/);

  assert.equal(
    mavenUrl('net.neoforged:neoforge:21.1.228:universal'),
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.228/neoforge-21.1.228-universal.jar',
  );
});

test('库清单：按系统过滤、去重、路径落在 libraries 下', () => {
  const root = tmpRoot('lib');
  const items = libraryItems(fakeVersionJson().libraries, { mcRoot: root, mirrorMode: 'auto', env: { os: 'windows', arch: 'x64' } });

  const paths = items.map((item) => item.relPath);
  assert.deepEqual(paths, [
    'org/example/alpha/1.0/alpha-1.0.jar',
    'org/example/winonly/2.0/winonly-2.0-natives-windows.jar',
  ]);
  assert.ok(items[0].absPath.endsWith(path.join('libraries', 'org', 'example', 'alpha', '1.0', 'alpha-1.0.jar')));
  assert.ok(items[0].absPath.startsWith(root));
  // Mojang 的库地址官方优先
  assert.equal(items[0].candidates[0], 'https://libraries.minecraft.net/org/example/alpha/1.0/alpha-1.0.jar');
});

test('原版清单：客户端 jar / 库 / 日志配置 / 资源索引', () => {
  const root = tmpRoot('core');
  const plan = planCore({ versionJson: fakeVersionJson(), mcRoot: root, mirrorMode: 'auto', env: { os: 'windows', arch: 'x64' } });

  assert.equal(plan.counts.clientJar, 1);
  assert.equal(plan.counts.libraries, 2);
  assert.equal(plan.counts.logging, 1);
  assert.equal(plan.counts.assetIndex, 1);
  assert.equal(plan.items.length, 5);
  assert.equal(plan.totalBytes, 1000 + 100 + 50 + 20 + 500);

  const clientItem = plan.items.find((item) => item.kind === 'clientJar');
  assert.equal(clientItem.relPath, 'versions/1.21.1/1.21.1.jar');

  const logItem = plan.items.find((item) => item.kind === 'logging');
  assert.equal(logItem.relPath, 'assets/log_configs/client-1.12.xml');

  const indexItem = plan.items.find((item) => item.kind === 'assetIndex');
  assert.equal(indexItem.relPath, 'assets/indexes/17.json');

  // includeLogging: false 能把日志配置关掉
  const noLog = planCore({ versionJson: fakeVersionJson(), mcRoot: root, includeLogging: false, env: { os: 'windows' } });
  assert.equal(noLog.counts.logging, 0);
});

test('资源清单：按 hash 分桶、官方优先', () => {
  const root = tmpRoot('assets');
  const built = assetItems(
    {
      objects: {
        'a.png': { hash: 'b62ca8ec11111111111111111111111111111111', size: 10 },
        'b.png': { hash: `${'cd'.repeat(20)}`, size: 20 },
      },
    },
    { mcRoot: root, mirrorMode: 'auto' },
  );
  assert.equal(built.count, 2);
  assert.equal(built.totalBytes, 30);
  assert.equal(built.items[0].relPath, 'assets/objects/b6/b62ca8ec11111111111111111111111111111111');
  assert.equal(built.items[0].candidates[0], 'https://resources.download.minecraft.net/b6/b62ca8ec11111111111111111111111111111111');
});

test('applyItems：已有的跳过、新下的写盘、失败的不打断别的', async () => {
  const root = tmpRoot('apply');
  const written = [];
  const http = {
    downloader: {
      async download(candidates, absPath, expect) {
        if (String(absPath).includes('boom')) throw new Error('假装下载失败');
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, 'data');
        written.push(absPath);
        return { path: absPath, bytes: 4, mode: 'sequential' };
      },
    },
  };

  const items = [
    { kind: 'library', relPath: 'a/have.jar', absPath: path.join(root, 'a/have.jar'), size: 4, candidates: ['u1'] },
    { kind: 'library', relPath: 'a/new.jar', absPath: path.join(root, 'a/new.jar'), size: 4, candidates: ['u2'] },
    { kind: 'library', relPath: 'a/boom.jar', absPath: path.join(root, 'a/boom.jar'), size: 4, candidates: ['u3'] },
  ];
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a/have.jar'), 'data');

  const progress = [];
  const result = await applyItems({ http, items, concurrency: 2, onProgress: (p) => progress.push(p) });

  assert.equal(result.skipped.length, 1);
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /假装下载失败/);
  assert.equal(result.failed[0].relPath, 'a/boom.jar');
  assert.deepEqual(written, [path.join(root, 'a/new.jar')]);
  // 进度最后一定是满的
  assert.equal(progress.at(-1).done, 3);
  assert.equal(progress.at(-1).total, 3);
});

test('applyItems：skipExisting 关掉就重下', async () => {
  const root = tmpRoot('apply2');
  fs.mkdirSync(path.join(root, 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'x/y.jar'), 'old');
  let called = 0;
  const http = {
    downloader: {
      async download(candidates, absPath) {
        called += 1;
        fs.writeFileSync(absPath, 'new');
        return { bytes: 3 };
      },
    },
  };
  const items = [{ kind: 'library', relPath: 'x/y.jar', absPath: path.join(root, 'x/y.jar'), size: 3, candidates: ['u'] }];
  const result = await applyItems({ http, items, skipExisting: false });
  assert.equal(called, 1);
  assert.equal(result.downloaded.length, 1);
});

test('applyItems：第一遍失败的会降速补一遍，补上了就不算失败', async () => {
  const root = tmpRoot('apply-retry');
  let calls = 0;
  const http = {
    downloader: {
      async download(candidates, absPath) {
        calls += 1;
        // 第一次假装 429（资源 CDN 在并发高时会这样），第二次成功
        if (calls === 1) throw new Error('下载失败：服务器返回 429');
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, 'data');
        return { bytes: 4 };
      },
    },
  };
  const items = [{ kind: 'asset', relPath: 'o/x', absPath: path.join(root, 'o/x'), size: 4, candidates: ['u'] }];
  const result = await applyItems({ http, items, concurrency: 2 });
  assert.equal(calls, 2, '应该重试过一次');
  assert.equal(result.failed.length, 0, `不该留失败：${JSON.stringify(result.failed)}`);
  assert.equal(result.downloaded.length, 1);
});

test('applyItems：retryFailures=false 时失败就是失败', async () => {
  const root = tmpRoot('apply-noretry');
  let calls = 0;
  const http = {
    downloader: {
      async download() {
        calls += 1;
        throw new Error('就是不通');
      },
    },
  };
  const items = [{ kind: 'asset', relPath: 'o/y', absPath: path.join(root, 'o/y'), size: 4, candidates: ['u'] }];
  const result = await applyItems({ http, items, concurrency: 1, retryFailures: false });
  assert.equal(calls, 1);
  assert.equal(result.failed.length, 1);
});

test('读安装器里的两个 json', () => {
  const root = tmpRoot('installer');
  const file = path.join(root, 'fake-installer.jar');
  fs.writeFileSync(
    file,
    makeZip({
      'install_profile.json': JSON.stringify({
        spec: 1,
        profile: 'neoforge-21.1.228',
        processors: [{ jar: 'a.b:tool:1.0', classpath: ['a.b:tool:1.0', 'c.d:lib:2.0'] }],
        data: { PATCHED: ['net.neoforged:neoforge:21.1.228:client'] },
        libraries: [{ name: 'a.b:tool:1.0', downloads: { artifact: { path: 'a/b/tool/1.0/tool-1.0.jar', size: 1, sha1: 'x', url: 'https://maven.neoforged.net/releases/a/b/tool/1.0/tool-1.0.jar' } } }],
        minecraft: '1.21.1',
      }),
      'version.json': JSON.stringify({ id: 'neoforge-21.1.228', inheritsFrom: '1.21.1', libraries: [] }),
    }),
  );

  const profile = readInstallerProfile(file);
  assert.equal(profile.spec, 1);
  assert.equal(profile.profileId, 'neoforge-21.1.228');
  assert.equal(profile.processors.length, 1);
  assert.equal(profile.libraries.length, 1);
  assert.equal(profile.minecraft, '1.21.1');
  assert.equal(profile.hasVersionJson, true);
  assert.equal(profile.versionJson.inheritsFrom, '1.21.1');

  // 没有 install_profile 的文件要明确报错
  const bad = path.join(root, 'bad.jar');
  fs.writeFileSync(bad, makeZip({ 'other.txt': 'hi' }));
  assert.throws(() => readInstallerProfile(bad), /没有 install_profile\.json/);
});

test('加载器依赖：三个来源合起来且不重复', () => {
  const root = tmpRoot('loader');
  const profile = {
    libraries: [
      { name: 'a.b:tool:1.0', downloads: { artifact: { path: 'a/b/tool/1.0/tool-1.0.jar', size: 10, sha1: 'x', url: 'https://maven.neoforged.net/releases/a/b/tool/1.0/tool-1.0.jar' } } },
    ],
    versionJson: {
      libraries: [
        { name: 'a.b:tool:1.0', downloads: { artifact: { path: 'a/b/tool/1.0/tool-1.0.jar', size: 10, sha1: 'x', url: 'https://maven.neoforged.net/releases/a/b/tool/1.0/tool-1.0.jar' } } },
        { name: 'c.d:runtime:2.0', downloads: { artifact: { path: 'c/d/runtime/2.0/runtime-2.0.jar', size: 20, sha1: 'y', url: 'https://maven.neoforged.net/releases/c/d/runtime/2.0/runtime-2.0.jar' } } },
      ],
    },
    processors: [{ jar: 'e.f:proc:3.0', classpath: ['e.f:proc:3.0', 'g.h:extra:4.0'] }],
  };

  const plan = buildLoaderPlan({ profile, mcRoot: root, mirrorMode: 'auto' });
  const paths = plan.items.map((item) => item.relPath);
  assert.deepEqual(paths, [
    'a/b/tool/1.0/tool-1.0.jar',
    'c/d/runtime/2.0/runtime-2.0.jar',
    'e/f/proc/3.0/proc-3.0.jar',
    'g/h/extra/4.0/extra-4.0.jar',
  ]);
  assert.equal(plan.counts.profileLibraries, 1);
  assert.equal(plan.counts.versionLibraries, 2);
  assert.equal(plan.counts.processors, 1);
  assert.equal(plan.counts.total, 4);
  // neoforge 的库地址镜像优先
  assert.match(plan.items[0].candidates[0], /^https:\/\/bmclapi2\.bangbang93\.com\/maven\//);
});

test('写版本 json 与复制客户端 jar', async () => {
  const root = tmpRoot('write');
  const mcRoot = path.join(root, 'mcroot');
  fs.mkdirSync(mcRoot, { recursive: true });

  const game = await writeGameVersionJson({ versionJsonRaw: fakeVersionJson(), mcRoot });
  assert.equal(game.id, '1.21.1');
  assert.ok(fs.existsSync(path.join(mcRoot, 'versions', '1.21.1', '1.21.1.json')));

  const instanceDir = path.join(mcRoot, 'versions', '我的包');
  const written = await writeInstanceVersionJson({ instanceDir, name: '我的包', inheritsFrom: 'neoforge-21.1.228' });
  const parsed = JSON.parse(fs.readFileSync(written.file, 'utf8'));
  assert.equal(parsed.id, '我的包');
  assert.equal(parsed.inheritsFrom, 'neoforge-21.1.228');
  assert.equal(parsed.type, 'release');

  const from = path.join(mcRoot, 'versions', '1.21.1', '1.21.1.jar');
  fs.writeFileSync(from, 'client-jar');
  const to = path.join(instanceDir, '我的包.jar');
  const first = await copyClientJar({ from, to });
  assert.equal(first.copied, true);
  assert.equal(first.bytes, 10);
  // 第二次不重复复制
  const second = await copyClientJar({ from, to });
  assert.equal(second.copied, false);

  await assert.rejects(() => copyClientJar({ from: path.join(root, 'nope.jar'), to }), /原版客户端 jar 不在/);
});

test('定位加载器版本目录', () => {
  const root = tmpRoot('locate');
  const found = locateLoaderVersion({ mcRoot: root, loader: 'neoforge', loaderVersion: '21.1.228' });
  assert.equal(found.id, 'neoforge-21.1.228');
  assert.equal(found.exists, false);
  assert.equal(found.jarExists, false);

  fs.mkdirSync(found.versionDir, { recursive: true });
  fs.writeFileSync(found.versionJson, '{}');
  const again = locateLoaderVersion({ mcRoot: root, loader: 'neoforge', loaderVersion: '21.1.228' });
  assert.equal(again.exists, true);

  const forge = locateLoaderVersion({ mcRoot: root, loader: 'forge', loaderVersion: '47.2.0' });
  assert.equal(forge.id, 'forge-47.2.0');
});

test('定位加载器版本目录：Forge 1.20.1 的目录带 mc 版本前缀', () => {
  const root = tmpRoot('locate-forge');
  // 安装器实际产出的是 versions/1.20.1-forge-47.4.28，不是 forge-47.4.28
  const realId = '1.20.1-forge-47.4.28';
  fs.mkdirSync(path.join(root, 'versions', realId), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', realId, `${realId}.json`), '{}');

  // 1) 只知道 loader + 版本：靠扫磁盘找到真目录
  const found = locateLoaderVersion({ mcRoot: root, loader: 'forge', loaderVersion: '47.4.28', mcVersion: '1.20.1' });
  assert.equal(found.id, realId);
  assert.equal(found.exists, true);

  // 2) 安装器告诉了我们 id，直接用
  const preferred = locateLoaderVersion({
    mcRoot: root,
    loader: 'forge',
    loaderVersion: '47.4.28',
    preferredId: realId,
  });
  assert.equal(preferred.id, realId);
  assert.equal(preferred.exists, true);
});

test('字节数与计划说明', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.50 GB');

  const root = tmpRoot('desc');
  const plan = planCore({ versionJson: fakeVersionJson(), mcRoot: root, env: { os: 'windows' } });
  const lines = describePlan(plan);
  assert.ok(Array.isArray(lines));
  assert.ok(lines.some((line) => /1\.21\.1/.test(line)));
  assert.ok(lines.some((line) => /libraries/.test(line)));
});

test('buildVanillaPlan：拉资源索引并合并条目', async () => {
  const root = tmpRoot('vanilla');
  const http = {
    async json(url) {
      assert.match(String(url), /17\.json$/);
      return { objects: { 'x.png': { hash: 'ab'.repeat(20), size: 7 } } };
    },
  };
  const plan = await buildVanillaPlan({ http, versionJson: fakeVersionJson(), mcRoot: root, mirrorMode: 'auto', env: { os: 'windows' } });
  assert.equal(plan.assetCount, 1);
  assert.equal(plan.assetBytes, 7);
  assert.equal(plan.allItems.length, plan.items.length + 1);

  // 不要资源时不联网
  const noAssets = await buildVanillaPlan({ http: null, versionJson: fakeVersionJson(), mcRoot: root, includeAssets: false });
  assert.equal(noAssets.assetCount, 0);
  assert.equal(noAssets.allItems.length, noAssets.items.length);
});

test('fetchJsonFrom：一个地址失败会换下一个', async () => {
  const { fetchJsonFrom } = await import('../packages/core/version-install.js');
  const tried = [];
  const http = {
    async json(url) {
      tried.push(url);
      if (url === 'bad') throw new Error('连不上');
      return { ok: true };
    },
  };
  const result = await fetchJsonFrom(http, ['bad', 'good'], { attempts: 2 });
  assert.deepEqual(result, { ok: true });
  // 坏地址试满 2 次才换
  assert.deepEqual(tried, ['bad', 'bad', 'good']);

  await assert.rejects(() => fetchJsonFrom({ json: async () => { throw new Error('全挂'); } }, ['a', 'b'], { attempts: 1 }), /全挂/);
});

test('fetchTextFrom：拿纯文本（XML），也能换地址', async () => {
  const { fetchTextFrom } = await import('../packages/core/version-install.js');
  const tried = [];
  const http = {
    async text(url) {
      tried.push(url);
      if (url === 'bad') throw new Error('连不上');
      return '<metadata><versioning><versions><version>1.20.1-47.4.28</version></versions></versioning></metadata>';
    },
  };
  const xml = await fetchTextFrom(http, ['bad', 'good'], { attempts: 2 });
  assert.match(xml, /<version>1\.20\.1-47\.4\.28<\/version>/);
  assert.deepEqual(tried, ['bad', 'bad', 'good']);

  // 适配器没实现 text 时，退回 json()（老测试桩/老适配器）
  const legacy = await fetchTextFrom({ json: async () => '<x/>' }, ['a'], { attempts: 1 });
  assert.equal(legacy, '<x/>');

  await assert.rejects(() => fetchTextFrom({ text: async () => { throw new Error('全挂'); } }, ['a'], { attempts: 1 }), /全挂/);
});
