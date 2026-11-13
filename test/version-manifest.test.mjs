/**
 * 版本清单那一层的单元测试（纯函数，不联网）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIRROR_ORIGIN,
  assetObjects,
  assetUrl,
  candidateUrlsFor,
  compareVersionDesc,
  describeTarget,
  libraryArtifact,
  loaderInstaller,
  loaderListIsXml,
  loaderListUrl,
  neoforgePrefix,
  normalizeGameVersion,
  normalizeLoader,
  parseLoaderVersions,
  parseManifest,
  parseMavenListing,
  parseMavenMetadataXml,
  parseVersionJson,
  pickVersion,
  toMirror,
} from '../packages/core/version-manifest.js';

test('镜像：库和资源走镜像，piston 保持官方', () => {
  assert.equal(toMirror('https://libraries.minecraft.net/ca/weblite/x.jar'), `${MIRROR_ORIGIN}/maven/ca/weblite/x.jar`);
  assert.equal(toMirror('https://resources.download.minecraft.net/ab/abcdef'), `${MIRROR_ORIGIN}/assets/ab/abcdef`);
  assert.equal(toMirror('https://maven.neoforged.net/releases/net/neoforged/x.jar'), `${MIRROR_ORIGIN}/maven/net/neoforged/x.jar`);

  // 这三条镜像上没有对应路径，映射过去只会白等一轮超时
  const piston = 'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json';
  assert.equal(toMirror(piston), piston);
  assert.equal(toMirror('https://piston-data.mojang.com/v1/objects/x/client.jar'), 'https://piston-data.mojang.com/v1/objects/x/client.jar');
  assert.equal(toMirror('https://launchermeta.mojang.com/mc/game/x.json'), 'https://launchermeta.mojang.com/mc/game/x.json');
});

test('镜像：候选顺序按档位与域名', () => {
  const mojang = 'https://libraries.minecraft.net/a/b.jar';
  assert.deepEqual(candidateUrlsFor(mojang, 'off'), [mojang]);
  // auto（默认）：Mojang 的域名官方快得多，官方优先
  assert.deepEqual(candidateUrlsFor(mojang, 'auto'), [mojang, `${MIRROR_ORIGIN}/maven/a/b.jar`]);
  assert.deepEqual(candidateUrlsFor(mojang, 'fallback'), [mojang, `${MIRROR_ORIGIN}/maven/a/b.jar`]);
  assert.deepEqual(candidateUrlsFor(mojang, 'prefer'), [`${MIRROR_ORIGIN}/maven/a/b.jar`, mojang]);
  assert.deepEqual(candidateUrlsFor(mojang, 'mirror'), [`${MIRROR_ORIGIN}/maven/a/b.jar`]);

  // auto：neoforge 官方直连超时，必须镜像优先
  const neo = 'https://maven.neoforged.net/releases/net/neoforged/x.jar';
  assert.deepEqual(candidateUrlsFor(neo, 'auto'), [`${MIRROR_ORIGIN}/maven/net/neoforged/x.jar`, neo]);

  // 镜像不了的地址只留一个，免得白试
  const piston = 'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json';
  assert.deepEqual(candidateUrlsFor(piston, 'prefer'), [piston]);
  assert.deepEqual(candidateUrlsFor('', 'prefer'), []);
});

test('游戏版本号校验', () => {
  assert.equal(normalizeGameVersion('1.21.1'), '1.21.1');
  assert.equal(normalizeGameVersion(' 1.20.1 '), '1.20.1');
  assert.equal(normalizeGameVersion('1.21'), '1.21');
  assert.throws(() => normalizeGameVersion(''), /版本号看起来不对/);
  assert.throws(() => normalizeGameVersion('最新版'), /版本号看起来不对/);
});

test('加载器名归一化', () => {
  assert.equal(normalizeLoader('NeoForge'), 'neoforge');
  assert.equal(normalizeLoader('neo'), 'neoforge');
  assert.equal(normalizeLoader('原版'), 'vanilla');
  assert.equal(normalizeLoader(''), 'vanilla');
  assert.equal(normalizeLoader('Fabric'), 'fabric');
  assert.throws(() => normalizeLoader('optifine'), /不认识的加载器/);
});

test('解析版本清单 + 挑版本', () => {
  const raw = {
    latest: { release: '1.21.4', snapshot: '1.22-snapshot' },
    versions: [
      { id: '1.21.4', type: 'release', url: 'u1' },
      { id: '1.21.1', type: 'release', url: 'u2', sha1: 'abc' },
      { id: '1.21.1-pre1', type: 'snapshot', url: 'u3' },
      { id: 'bad' },
    ],
  };
  const manifest = parseManifest(raw);
  assert.equal(manifest.latest.release, '1.21.4');
  assert.equal(manifest.versions.length, 4);
  assert.equal(manifest.versions[1].sha1, 'abc');

  const hit = pickVersion(manifest, '1.21.1');
  assert.equal(hit.url, 'u2');

  assert.throws(() => pickVersion(manifest, '1.19.9'), /版本清单里没有 1\.19\.9/);
});

test('挑版本失败时给出相近候选', () => {
  const manifest = parseManifest({
    versions: [
      { id: '1.21.1', type: 'release', url: 'u' },
      { id: '1.21.4', type: 'release', url: 'u' },
      { id: '1.20.1', type: 'release', url: 'u' },
    ],
  });
  try {
    pickVersion(manifest, '1.21.9');
    assert.fail('应该抛错');
  } catch (error) {
    assert.match(error.hint, /1\.21\.1/);
    assert.match(error.hint, /1\.21\.4/);
    assert.doesNotMatch(error.hint, /1\.20\.1/);
  }
});

test('解析版本 json', () => {
  const parsed = parseVersionJson({
    id: '1.21.1',
    mainClass: 'net.minecraft.client.main.Main',
    javaVersion: { majorVersion: 21 },
    assets: '17',
    downloads: { client: { size: 100, sha1: 'sha', url: 'https://x/client.jar' } },
    libraries: [{ name: 'a:b:1' }],
    assetIndex: { id: '17', size: 449557, totalSize: 826260776, sha1: 'idx', url: 'https://x/17.json' },
    logging: { client: { file: { id: 'client-1.12.xml', size: 10, sha1: 'l', url: 'https://x/log.xml' } } },
  });

  assert.equal(parsed.id, '1.21.1');
  assert.equal(parsed.javaMajor, 21);
  assert.equal(parsed.clientJar.path, 'versions/1.21.1/1.21.1.jar');
  assert.equal(parsed.clientJar.size, 100);
  assert.equal(parsed.assetIndex.totalSize, 826260776);
  assert.equal(parsed.logging.path, 'client-1.12.xml');
  assert.equal(parsed.libraries.length, 1);

  assert.throws(() => parseVersionJson(null), /版本 json 不是对象/);
  assert.throws(() => parseVersionJson({}), /没有 id/);
});

test('库条目展开：没有 artifact 就跳过', () => {
  assert.deepEqual(libraryArtifact({ downloads: { artifact: { path: 'a/b.jar', size: 5, sha1: 's', url: 'u' } } }), {
    path: 'a/b.jar',
    size: 5,
    sha1: 's',
    url: 'u',
  });
  assert.equal(libraryArtifact({ name: 'a:b:1' }), null);
  assert.equal(libraryArtifact(null), null);
});

test('资源索引解析：坏 hash 丢掉', () => {
  const objects = assetObjects({
    objects: {
      'icons/icon_16x16.png': { hash: 'b62ca8ec11111111111111111111111111111111', size: 9101 },
      'bad/hash': { hash: 'xyz', size: 1 },
      'no/hash': { size: 2 },
    },
  });
  assert.equal(objects.length, 1);
  assert.equal(objects[0].name, 'icons/icon_16x16.png');
  assert.equal(objects[0].path, 'objects/b6/b62ca8ec11111111111111111111111111111111');
  assert.equal(assetObjects(null).length, 0);
  assert.equal(assetObjects({}).length, 0);
});

test('资源下载地址按 hash 前两位分桶', () => {
  assert.equal(assetUrl('b62ca8ec'), 'https://resources.download.minecraft.net/b6/b62ca8ec');
});

test('NeoForge 版本前缀', () => {
  assert.equal(neoforgePrefix('1.21.1'), '21.1.');
  assert.equal(neoforgePrefix('1.21'), '21.0.');
  assert.equal(neoforgePrefix('1.20.4'), '20.4.');
  assert.equal(neoforgePrefix('1.20.1'), null);
  assert.equal(neoforgePrefix('1.19.2'), null);
  assert.equal(neoforgePrefix('bogus'), null);
});

test('加载器安装包坐标', () => {
  const neo = loaderInstaller('neoforge', '1.21.1', '21.1.228');
  assert.equal(neo.fileName, 'neoforge-21.1.228-installer.jar');
  assert.equal(neo.path, 'net/neoforged/neoforge/21.1.228/neoforge-21.1.228-installer.jar');
  assert.match(neo.url, /^https:\/\/maven\.neoforged\.net\/releases\//);

  const forge = loaderInstaller('forge', '1.20.1', '47.2.0');
  assert.equal(forge.fileName, 'forge-1.20.1-47.2.0-installer.jar');
  assert.equal(forge.path, 'net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar');

  // 版本对不上要拦下来，别装错
  assert.throws(() => loaderInstaller('neoforge', '1.21.1', '20.4.100'), /对不上 1\.21\.1/);
  assert.throws(() => loaderInstaller('neoforge', '1.20.1', '47.1.0'), /不支持 1\.20\.1/);
  assert.throws(() => loaderInstaller('neoforge', '1.21.1', ''), /没给加载器版本/);
  assert.throws(() => loaderInstaller('fabric', '1.21.1', '0.16.0'), /不用安装包这条路/);
});

test('maven 目录列表：版本号本身也是目录，不能过滤掉', () => {
  const listing = {
    name: 'neoforge',
    files: [
      { name: '21.1.9', type: 'DIRECTORY' },
      { name: '21.1.10', type: 'DIRECTORY' },
      { name: '21.1.228', type: 'DIRECTORY' },
      { name: '20.4.1-beta', type: 'DIRECTORY' },
    ],
  };
  const names = parseMavenListing(listing);
  assert.equal(names.length, 4);
  // 从新到旧：21.1.228 > 21.1.10 > 21.1.9 > 20.4.1-beta
  assert.deepEqual(names, ['21.1.228', '21.1.10', '21.1.9', '20.4.1-beta']);
  assert.deepEqual(parseMavenListing(null), []);
  assert.deepEqual(parseMavenListing({ files: [{ name: 'a' }, { name: 'a' }] }), ['a']);
});

test('版本号比较：按数字段比，不是字符串比', () => {
  assert.ok(compareVersionDesc('21.1.10', '21.1.9') < 0); // 10 更新，排前面
  assert.ok(compareVersionDesc('21.1.9', '21.1.10') > 0);
  assert.equal(compareVersionDesc('21.1.1', '21.1.1'), 0);
  assert.ok(compareVersionDesc('21.1.228', '21.1.99') < 0);
});

test('加载器版本列表地址', () => {
  assert.match(loaderListUrl('neoforge', '1.21.1'), /\/neoforge\/meta\/api\/maven\/details\/releases\/net\/neoforged\/neoforge$/);
  // Forge 走 maven 的 maven-metadata.xml：BMCLAPI 那个 neoforge 接口不代理 Forge（实测 404）
  assert.match(loaderListUrl('forge', '1.20.1'), /^https:\/\/maven\.minecraftforge\.net\/net\/minecraftforge\/forge\/maven-metadata\.xml$/);
  assert.equal(loaderListUrl('fabric', '1.21.1'), 'https://meta.fabricmc.net/v2/versions/loader/1.21.1');
  assert.throws(() => loaderListUrl('vanilla', '1.21.1'), /没有版本列表/);
});

test('哪个加载器的列表是 XML', () => {
  assert.equal(loaderListIsXml('forge'), true);
  assert.equal(loaderListIsXml('Forge'), true);
  assert.equal(loaderListIsXml('neoforge'), false);
  assert.equal(loaderListIsXml('fabric'), false);
  assert.equal(loaderListIsXml('vanilla'), false);
});

test('解析 maven-metadata.xml 只取 <version>，并从新到旧', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>net.minecraftforge</groupId>
  <artifactId>forge</artifactId>
  <versioning>
    <latest>1.20.1-47.4.28</latest>
    <release>1.20.1-47.4.28</release>
    <versions>
      <version>1.20.1-47.1.0</version>
      <version>1.20.1-47.4.28</version>
      <version>1.20.1-47.4.9</version>
      <version>1.20.1-47.4.28</version>
      <version>1.19.2-43.0.0</version>
    </versions>
    <lastUpdated>20261030010101</lastUpdated>
  </versioning>
</metadata>`;
  const all = parseMavenMetadataXml(xml);
  // <latest> / <release> 不算版本，重复的只留一个，47.4.28 排最前（数字比，不是字符串比）
  assert.deepEqual(all, ['1.20.1-47.4.28', '1.20.1-47.4.9', '1.20.1-47.1.0', '1.19.2-43.0.0']);
  assert.deepEqual(parseMavenMetadataXml(''), []);
  assert.deepEqual(parseMavenMetadataXml('不是 xml'), []);
});

test('从列表里挑出属于这个游戏版本的加载器', () => {
  const neoListing = {
    files: [
      { name: '21.1.228' },
      { name: '21.1.229' },
      { name: '20.4.100' },
      { name: '1.20.1-47.1.0' },
    ],
  };
  assert.deepEqual(parseLoaderVersions('neoforge', '1.21.1', neoListing), ['21.1.229', '21.1.228']);
  assert.deepEqual(parseLoaderVersions('neoforge', '1.20.1', neoListing), []);

  const forgeListing = { files: [{ name: '1.20.1-47.2.0' }, { name: '1.20.1-47.1.0' }, { name: '1.19.2-43.0.0' }] };
  assert.deepEqual(parseLoaderVersions('forge', '1.20.1', forgeListing), ['47.2.0', '47.1.0']);

  // Forge 的真实输入是 XML 文本，不是 JSON 对象
  const forgeXml = '<metadata><versioning><versions>'
    + '<version>1.20.1-47.1.0</version><version>1.20.1-47.4.28</version>'
    + '</versions></versioning></metadata>';
  assert.deepEqual(parseLoaderVersions('forge', '1.20.1', forgeXml), ['47.4.28', '47.1.0']);

  const fabric = [{ loader: { version: '0.16.9' } }, { loader: { version: '0.16.10' } }];
  assert.deepEqual(parseLoaderVersions('fabric', '1.21.1', fabric), ['0.16.9', '0.16.10']);
  assert.deepEqual(parseLoaderVersions('vanilla', '1.21.1', {}), []);
});

test('目标说明文字', () => {
  assert.equal(describeTarget({ mcVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.228' }), '1.21.1 + NeoForge 21.1.228');
  assert.equal(describeTarget({ mcVersion: '1.21.1', loader: 'vanilla' }), '1.21.1 + 原版');
});
