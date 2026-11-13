/**
 * mod 版本兼容层的单测：读依赖声明、判区间、查实例适配、扫已装 mod 查冲突。
 *
 * 这些全是纯逻辑：造几段假的 mods.toml / fabric.mod.json 塞进假 jar 就够了，
 * 不联网、不起游戏。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEP_INCOMPATIBLE, DEP_OPTIONAL, DEP_REQUIRED,
  checkInstalled, compareVersions, compatReport, compatReportAsync, describeCompat,
  isSuitableForInstance, mcVersionMatches,
  parseModToml, readJarMeta, readJarMetaFile, satisfiesRange, scanInstalledMods, scanInstalledModsAsync,
} from '../packages/core/mod-compat.js';
import { makeZip } from './make-zip.mjs';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-compat-${tag}-`));
}

/** 造一个只含 mods.toml 的假 mod jar。 */
function modJar(modId, version, deps = '') {
  const toml = `
modLoader = "javafml"
loaderVersion = "[4,)"

[[mods]]
modId = "${modId}"
version = "${version}"
displayName = "${modId}"

${deps}
`;
  return makeZip({ 'META-INF/neoforge.mods.toml': toml });
}

test('parseModToml 认 [[dependencies.x]] 块：块头是声明方，正文 modId 是目标', () => {
  const { modIds, deps } = parseModToml(`
[[mods]]
modId = "veil"
version = "4.1.4"

[[dependencies.veil]]
modId = "sodium"
type = "incompatible"
versionRange = "(,0.8.12-alpha.2+mc1.21.1]"
side = "CLIENT"
`);
  assert.deepEqual(modIds, [{ modId: 'veil', version: '4.1.4', name: 'veil' }]);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].declarer, 'veil');
  assert.equal(deps[0].target, 'sodium');
  assert.equal(deps[0].type, DEP_INCOMPATIBLE);
  assert.equal(deps[0].versionRange, '(,0.8.12-alpha.2+mc1.21.1]');
  assert.equal(deps[0].side, 'CLIENT');
});

test('parseModToml 认内联数组写法 dependencies.x = [{...}]（引号感知的括号配平）', () => {
  const { deps } = parseModToml(`
[[mods]]
modId = "colorwheel"
version = "1.2.4"

dependencies.colorwheel = [
    { modId = "iris", type = "required", versionRange = "[1.8.0,)" },
    { modId = "sable", type = "optional", versionRange = "[1.0]" },
]
`);
  assert.equal(deps.length, 2);
  const iris = deps.find((d) => d.target === 'iris');
  assert.equal(iris.declarer, 'colorwheel');
  assert.equal(iris.type, DEP_REQUIRED);
  assert.equal(iris.versionRange, '[1.8.0,)');
  const sable = deps.find((d) => d.target === 'sable');
  assert.equal(sable.type, DEP_OPTIONAL);
});

test('parseModToml 认字符串简写 dependencies.x = "target"（当成必需前置）', () => {
  const { deps } = parseModToml(`
[[mods]]
modId = "demo"
version = "1.0"

dependencies.create = "minecraft"
`);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].declarer, 'create');
  assert.equal(deps[0].target, 'minecraft');
  assert.equal(deps[0].type, DEP_REQUIRED);
});

test('parseModToml 里 mandatory="false" 也算可选前置', () => {
  const { deps } = parseModToml(`
[[mods]]
modId = "demo"
version = "1.0"

[[dependencies.demo]]
modId = "jei"
mandatory = "false"
`);
  assert.equal(deps[0].type, DEP_OPTIONAL);
});

test('readJarMeta 从 neoforge.mods.toml 里读出 modId 与依赖', () => {
  const buffer = modJar('sable', '2.0.3', `
[[dependencies.sable]]
modId = "sodium"
type = "incompatible"
versionRange = "(,0.8.12-alpha.2+mc1.21.1]"
`);
  const meta = readJarMeta(buffer);
  assert.equal(meta.error, '');
  assert.equal(meta.modIds[0].modId, 'sable');
  assert.equal(meta.modIds[0].version, '2.0.3');
  assert.equal(meta.deps.length, 1);
  assert.equal(meta.deps[0].target, 'sodium');
});

test('readJarMeta 认老版 META-INF/mods.toml 与 fabric.mod.json', () => {
  const old = makeZip({
    'META-INF/mods.toml': `
[[mods]]
modId = "oldstyle"
version = "3.1"
`,
  });
  assert.equal(readJarMeta(old).modIds[0].modId, 'oldstyle');

  const fabric = makeZip({
    'fabric.mod.json': JSON.stringify({ id: 'fabricdemo', version: '2.0', name: 'Fabric Demo', depends: ['fabric-api'] }),
  });
  const meta = readJarMeta(fabric);
  assert.equal(meta.modIds[0].modId, 'fabricdemo');
  assert.equal(meta.deps[0].target, 'fabric-api');
  assert.equal(meta.deps[0].type, DEP_REQUIRED);
});

test('readJarMeta 遇到坏 zip 不炸，返回空结果带 error', () => {
  const meta = readJarMeta(Buffer.from('not a zip at all'));
  assert.deepEqual(meta.modIds, []);
  assert.ok(meta.error);
});

test('compareVersions 比数字段、预发布次序，数字段大于字母段', () => {
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
  assert.ok(compareVersions('1.2.0', '1.10.0') < 0);
  assert.equal(compareVersions('1.21.1', '1.21.1'), 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0-rc') < 0);
  assert.ok(compareVersions('1.0.0-rc', '1.0.0') < 0);
  // 带 +build 号的当同一版本
  assert.equal(compareVersions('1.0.0+build1', '1.0.0'), 0);
});

test('satisfiesRange 认 Maven 区间、裸版本号、空区间与 $ 占位符', () => {
  assert.equal(satisfiesRange('1.0.0', '[1.0.0]'), true);
  assert.equal(satisfiesRange('1.1.0', '[1.0.0]'), false);
  assert.equal(satisfiesRange('1.5.0', '[1.0.0,2.0.0)'), true);
  assert.equal(satisfiesRange('2.0.0', '[1.0.0,2.0.0)'), false);
  assert.equal(satisfiesRange('1.5.0', '[1.0.0,)'), true);
  assert.equal(satisfiesRange('0.8.12', '(,0.8.12-alpha.2+mc1.21.1]'), false);
  assert.equal(satisfiesRange('0.8.12-alpha.2', '(,0.8.12-alpha.2+mc1.21.1]'), true);
  // 裸版本号 → 当成 [版本,)
  assert.equal(satisfiesRange('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesRange('1.2.4', '1.2.3'), true);
  assert.equal(satisfiesRange('1.2.2', '1.2.3'), false);
  // 空区间 / 占位符 → 没有约束
  assert.equal(satisfiesRange('9.9.9', ''), true);
  assert.equal(satisfiesRange('9.9.9', '${file.jarVersion}'), true);
});

test('satisfiesRange 认得真实包里那些带空格的区间（用户整合包实测）', () => {
  // attributefix / jadeaddons 等 mod 就这么写的，逗号后面带空格
  assert.equal(satisfiesRange('21.1.67', '[21.1, 21.2)'), true);
  assert.equal(satisfiesRange('21.2.5', '[21.1, 21.2)'), false);
  assert.equal(satisfiesRange('21.1.11', '[21.1, 21.2)'), true);
  // 上界留空、只有逗号和空格
  assert.equal(satisfiesRange('15.10.5', '[15.10, )'), true);
  assert.equal(satisfiesRange('15.9.0', '[15.10, )'), false);
  // 下界留空
  assert.equal(satisfiesRange('0.8.1', '(, 0.9)'), true);
  // semver 谓词用空格表示「且」不能被误改
  assert.equal(satisfiesRange('1.5.0', '>=1.0.0 <2.0.0'), true);
  assert.equal(satisfiesRange('2.5.0', '>=1.0.0 <2.0.0'), false);
});

test('satisfiesRange 把末尾单字母当构建标记（1.10.0b 算 1.10.0）', () => {
  // create_dragons_plus 的版本号是 1.10.0b，自己声明依赖 [1.10.0,)
  assert.equal(satisfiesRange('1.10.0b', '[1.10.0,)'), true);
  assert.equal(satisfiesRange('1.10.0', '[1.10.0,)'), true);
  assert.equal(satisfiesRange('1.9.0', '[1.10.0,)'), false);
  // 多字母预发布词不受影响
  assert.equal(satisfiesRange('1.0.0-alpha', '[1.0.0,)'), false);
});

test('satisfiesRange 认得 1.21-1.3 这种「MC版本-起始版本」的怪写法', () => {
  // mynethersdelight 声明 farmersdelight 1.21-1.3，实际装的是 1.3.1 → 应通过
  assert.equal(satisfiesRange('1.3.1', '1.21-1.3'), true);
  assert.equal(satisfiesRange('1.2.9', '1.21-1.3'), false);
});

test('被比较的版本号是占位符时不报版本对不上', () => {
  // jadeaddons / l2hostility 的版本号写成 ${file.jarVersion}，没法比
  assert.equal(satisfiesRange('${file.jarVersion}', '[15.10, )'), true);
  assert.equal(satisfiesRange('${file.jarVersion}', '[0,)'), true);
  assert.equal(satisfiesRange('${file.jarVersion}', '[100,)'), true);
});

test('isSuitableForInstance 按 MC 版本与加载器判适配（PCL IsInstanceSuitableForFile 等价物）', () => {
  const instance = { gameVersion: '1.21.1', loader: 'neoforge' };
  assert.equal(isSuitableForInstance({ gameVersions: ['1.21.1'], loaders: ['neoforge'] }, instance).ok, true);
  // 声明的 MC 版本带点号但没有 1.21.1 → 不适配
  const bad = isSuitableForInstance({ gameVersions: ['1.20.1'], loaders: ['neoforge'] }, instance);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /1\.20\.1/);
  // 加载器对不上 → 不适配
  assert.equal(isSuitableForInstance({ gameVersions: ['1.21.1'], loaders: ['forge'] }, instance).ok, false);
  // 没有点号的（如 "fabric" 这种加载器标记）不参与 MC 版本判定
  assert.equal(isSuitableForInstance({ gameVersions: ['fabric'], loaders: ['neoforge'] }, instance).ok, true);
  // 文件没声明任何信息 → 适配
  assert.equal(isSuitableForInstance({}, instance).ok, true);
});

test('scanInstalledMods 读出 mods 目录里每个 jar 的 modId 与版本', () => {
  const dir = tmpDir('scan');
  fs.writeFileSync(path.join(dir, 'sable-2.0.3.jar'), modJar('sable', '2.0.3'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), '不是 jar');
  const result = scanInstalledMods(dir);
  assert.equal(result.count, 1);
  assert.equal(result.mods[0].modId, 'sable');
  assert.equal(result.mods[0].version, '2.0.3');
  assert.equal(result.mods[0].file, 'sable-2.0.3.jar');
});

test('checkInstalled：sable 声明与 sodium 0.8.12 以下互斥，装了 0.8.12 不算冲突（PCL 语义）', () => {
  const dir = tmpDir('conflict');
  fs.writeFileSync(path.join(dir, 'sable.jar'), modJar('sable', '2.0.3', `
[[dependencies.sable]]
modId = "sodium"
type = "incompatible"
versionRange = "(,0.8.12-alpha.2+mc1.21.1]"
`));
  fs.writeFileSync(path.join(dir, 'sodium.jar'), modJar('sodium', '0.8.12+mc1.21.1'));
  const { mods } = scanInstalledMods(dir);
  const result = checkInstalled(mods);
  // 0.8.12 落在「0.8.12-alpha.2 及以下」区间之外 → 按 PCL 的语义不算冲突
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.ok, true);
});

test('checkInstalled 报出真互斥：装的是 sodium 0.7.3，落在冲突区间内', () => {
  const dir = tmpDir('conflict2');
  fs.writeFileSync(path.join(dir, 'sable.jar'), modJar('sable', '2.0.3', `
[[dependencies.sable]]
modId = "sodium"
type = "incompatible"
versionRange = "(,0.8.12-alpha.2+mc1.21.1]"
`));
  fs.writeFileSync(path.join(dir, 'sodium-old.jar'), modJar('sodium', '0.7.3'));
  const { mods } = scanInstalledMods(dir);
  const result = checkInstalled(mods);
  assert.equal(result.ok, false);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].from, 'sable');
  assert.equal(result.conflicts[0].target, 'sodium');
  assert.equal(result.conflicts[0].hard, true);
  assert.ok(describeCompat(result).some((l) => l.includes('互斥')));
});

test('checkInstalled：版本落在冲突区间之外就不算冲突', () => {
  const dir = tmpDir('norisk');
  fs.writeFileSync(path.join(dir, 'sable.jar'), modJar('sable', '2.0.3', `
[[dependencies.sable]]
modId = "sodium"
type = "incompatible"
versionRange = "(,0.8.12-alpha.2+mc1.21.1]"
`));
  fs.writeFileSync(path.join(dir, 'sodium-old.jar'), modJar('sodium', '0.7.3'));
  const { mods } = scanInstalledMods(dir);
  const result = checkInstalled(mods);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].targetVersion, '0.7.3');
});

test('checkInstalled 报出同一个 modId 装了两份（用户包里两个 sodium 就是这种）', () => {
  const dir = tmpDir('dup');
  fs.writeFileSync(path.join(dir, 'sodium-0.7.3.jar'), modJar('sodium', '0.7.3'));
  fs.writeFileSync(path.join(dir, 'sodium-0.8.12.jar'), modJar('sodium', '0.8.12+mc1.21.1'));
  const { mods } = scanInstalledMods(dir);
  const result = checkInstalled(mods);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].modId, 'sodium');
  assert.equal(result.duplicates[0].files.length, 2);
  assert.equal(result.ok, false);
});

test('checkInstalled：同一个 jar 被重复内嵌不算「装了多份」', () => {
  // 真实包里 fabric_api_base 被 flerovium / iris / sodium 各内嵌了一份同一版本，
  // 那是同一个 jar 被内嵌多次，游戏里只算一份 —— 不该报成问题。
  const dir = tmpDir('dup-same');
  fs.writeFileSync(path.join(dir, 'a.jar'), modJar('shared', '1.0.0'));
  fs.writeFileSync(path.join(dir, 'b.jar'), modJar('shared', '1.0.0'));
  const { mods } = scanInstalledMods(dir);
  const result = checkInstalled(mods);
  assert.equal(result.duplicates.length, 0);
});

test('checkInstalled 报出缺前置与版本对不上，但可选前置与平台依赖不算缺', () => {
  const dir = tmpDir('missing');
  fs.writeFileSync(path.join(dir, 'colorwheel.jar'), modJar('colorwheel', '1.2.4', `
[[dependencies.colorwheel]]
modId = "iris"
type = "required"
versionRange = "[1.8.0,)"

[[dependencies.colorwheel]]
modId = "flywheel"
type = "optional"

[[dependencies.colorwheel]]
modId = "neoforge"
type = "required"
versionRange = "[21.1,)"
`));
  fs.writeFileSync(path.join(dir, 'iris.jar'), modJar('iris', '1.7.0'));
  const { mods } = scanInstalledMods(dir);
  const result = checkInstalled(mods);
  // iris 装了但版本太老 → 版本不符，不是缺前置
  assert.equal(result.missing.length, 0);
  assert.equal(result.versionMismatch.length, 1);
  assert.equal(result.versionMismatch[0].target, 'iris');
  assert.equal(result.versionMismatch[0].versionRange, '[1.8.0,)');
  // 可选前置 flywheel 不报；平台依赖 neoforge 不报
  assert.ok(!result.missing.some((m) => m.target === 'flywheel'));
  assert.ok(!result.missing.some((m) => m.target === 'neoforge'));
});

test('checkInstalled：side="server" 的依赖与客户端无关，跳过', () => {
  const dir = tmpDir('server');
  fs.writeFileSync(path.join(dir, 'demo.jar'), modJar('demo', '1.0', `
[[dependencies.demo]]
modId = "serveronly"
type = "required"
side = "SERVER"
`));
  const { mods } = scanInstalledMods(dir);
  const result = checkInstalled(mods);
  assert.equal(result.missing.length, 0);
});

test('readJarMetaFile 不整包读，也能读出 mods.toml 里的 modId 与依赖', () => {
  const dir = tmpDir('metafile');
  const file = path.join(dir, 'sable-2.0.3.jar');
  fs.writeFileSync(file, modJar('sable', '2.0.3', `
[[dependencies.sable]]
modId = "sodium"
type = "incompatible"
versionRange = "(,0.8.12-alpha.2+mc1.21.1]"
`));
  const meta = readJarMetaFile(file);
  assert.equal(meta.error, '');
  assert.equal(meta.modIds[0].modId, 'sable');
  assert.equal(meta.modIds[0].version, '2.0.3');
  assert.equal(meta.deps.length, 1);
  assert.equal(meta.deps[0].target, 'sodium');
  assert.equal(meta.deps[0].type, DEP_INCOMPATIBLE);
});

test('readJarMetaFile 遇到坏文件不炸，返回空结果带 error', () => {
  const dir = tmpDir('badfile');
  const file = path.join(dir, 'broken.jar');
  fs.writeFileSync(file, 'not a zip at all');
  const meta = readJarMetaFile(file);
  assert.deepEqual(meta.modIds, []);
  assert.ok(meta.error);
});

test('scanInstalledMods 能读出 jarjar 内嵌的 mod（用户包里 sable 内嵌 veil 就是这种）', () => {
  const dir = tmpDir('jarjar');
  const inner = modJar('veil', '4.1.4', `
[[dependencies.veil]]
modId = "sodium"
type = "incompatible"
versionRange = "(,0.8.12-alpha.2+mc1.21.1]"
`);
  const outer = makeZip({
    'META-INF/neoforge.mods.toml': `
[[mods]]
modId = "sable"
version = "2.0.3"
`,
    'META-INF/jarjar/veil-4.1.4.jar': inner,
  });
  fs.writeFileSync(path.join(dir, 'sable.jar'), outer);
  fs.writeFileSync(path.join(dir, 'sodium-old.jar'), modJar('sodium', '0.7.3'));

  const { mods } = scanInstalledMods(dir);
  assert.ok(mods.some((m) => m.modId === 'sable'));
  const veil = mods.find((m) => m.modId === 'veil');
  assert.ok(veil, '内嵌的 veil 应该被读出来');
  assert.equal(veil.embedded, true);
  assert.ok(veil.file.includes('sable.jar'));

  // 内嵌 veil 声明与 sodium 互斥 → 体检要报出来
  const result = checkInstalled(mods);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].from, 'veil');
  assert.equal(result.conflicts[0].target, 'sodium');
});

test('scanInstalledModsAsync 与同步版读出来的结果一致', async () => {
  const dir = tmpDir('async');
  fs.writeFileSync(path.join(dir, 'sable.jar'), modJar('sable', '2.0.3'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), '不是 jar');
  const sync = scanInstalledMods(dir);
  const asyncResult = await scanInstalledModsAsync(dir);
  assert.equal(asyncResult.count, sync.count);
  assert.equal(asyncResult.mods[0].modId, 'sable');
  assert.equal(asyncResult.mods[0].version, '2.0.3');
});

test('describeCompat 没问题时给一句话，有问题时逐条说清楚', () => {
  const clean = describeCompat({ conflicts: [], missing: [], versionMismatch: [], duplicates: [] });
  assert.equal(clean.length, 1);
  assert.match(clean[0], /没发现/);

  const lines = describeCompat({
    conflicts: [{ kind: 'incompatible', hard: true, from: 'a', fromVersion: '1', target: 'b', targetVersion: '2', versionRange: '(,1.0]' }],
    missing: [{ from: 'c', target: 'd', versionRange: '' }],
    versionMismatch: [],
    duplicates: [{ modId: 'sodium', files: [{ file: 'a.jar', version: '1' }, { file: 'b.jar', version: '2' }] }],
  });
  const text = lines.join('\n');
  assert.match(text, /互斥/);
  assert.match(text, /重复|多份/);
  assert.match(text, /缺少/);
  assert.match(text, /sodium/);
});

test('mcVersionMatches 只看 MC 版本这一条', () => {
  // 声明了 MC 版本：必须有一个正好等于用户的版本
  assert.equal(mcVersionMatches(['1.21.1', '1.21'], '1.21.1'), true);
  assert.equal(mcVersionMatches(['1.21.1', '1.21'], '1.20.1'), false);
  // 没声明 MC 版本 → 当全都支持
  assert.equal(mcVersionMatches([], '1.21.1'), true);
  assert.equal(mcVersionMatches(undefined, '1.21.1'), true);
  // 不知道用户的 MC 版本 → 当全都支持
  assert.equal(mcVersionMatches(['1.21.1'], ''), true);
  assert.equal(mcVersionMatches(['1.21.1'], undefined), true);
  // 不带点号的（Forge 那种 "1.21"）不算数，只认精确的
  assert.equal(mcVersionMatches(['1.21'], '1.21.1'), false);
});

test('compatReport 给整包做体检，说人话', () => {
  const dir = tmpDir('report');
  fs.writeFileSync(path.join(dir, 'sable.jar'), modJar('sable', '2.0.3', `
[[dependencies.sable]]
modId = "sodium"
type = "incompatible"
versionRange = "(,0.8.12-alpha.2+mc1.21.1]"
`));
  fs.writeFileSync(path.join(dir, 'sodium-old.jar'), modJar('sodium', '0.7.3'));

  const report = compatReport(dir);
  assert.equal(report.count, 2);
  assert.equal(report.ok, false);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].from, 'sable');
  assert.equal(report.conflicts[0].target, 'sodium');
  assert.match(report.lines.join('\n'), /互斥/);
});

test('compatReportAsync 与同步版结果一致', async () => {
  const dir = tmpDir('report-async');
  fs.writeFileSync(path.join(dir, 'sable.jar'), modJar('sable', '2.0.3'));
  const sync = compatReport(dir);
  const asyncResult = await compatReportAsync(dir);
  assert.equal(asyncResult.count, sync.count);
  assert.equal(asyncResult.ok, sync.ok);
  assert.deepEqual(asyncResult.lines, sync.lines);
});
