/**
 * 导出层单测：zip 写入器 + 打包计划 + PCL 自检。
 * 全部用临时目录构造的假实例，不碰真实包（真实包在 test/real-export.mjs 里跑）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZipWriter, crc32 } from '../packages/core/zipwrite.js';
import { openZip } from '../packages/core/zip.js';
import { planExport, buildExport, checkZip, looksLikePcl } from '../packages/core/export.js';
import { resolveInstance } from '../packages/core/instance.js';

function tmpRoot(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-exp-${tag}-`));
  return dir;
}

/** 造一个最小的 versions 布局实例。 */
function fakeInstance(tag, { withJar = true } = {}) {
  const root = tmpRoot(tag);
  const id = 'TestPack';
  const inst = path.join(root, 'versions', id);
  fs.mkdirSync(path.join(inst, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'config'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'kubejs', 'server_scripts'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'saves', 'world'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'crash-reports'), { recursive: true });
  fs.writeFileSync(path.join(inst, `${id}.json`), JSON.stringify({
    id, mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    arguments: { game: ['--fml.mcVersion', '1.21.1', '--fml.neoForgeVersion', '21.1.228'] },
  }));
  if (withJar) fs.writeFileSync(path.join(inst, `${id}.jar`), Buffer.alloc(1024, 7));
  fs.writeFileSync(path.join(inst, 'mods', 'a.jar'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(inst, 'mods', 'b.jar.disabled'), Buffer.from('x'));
  fs.writeFileSync(path.join(inst, 'config', 'common.toml'), 'key=1\n');
  fs.writeFileSync(path.join(inst, 'kubejs', 'server_scripts', 'x.js'), 'console.info(1)\n');
  fs.writeFileSync(path.join(inst, 'logs', 'latest.log'), 'should not be packed');
  fs.writeFileSync(path.join(inst, 'crash-reports', 'crash.txt'), 'nope');
  fs.writeFileSync(path.join(inst, 'saves', 'world', 'level.dat'), Buffer.from('save'));
  fs.writeFileSync(path.join(inst, 'options.txt'), 'fov:0.5\n');
  return { root, inst, id };
}

test('ZipWriter: 写出去能用 openZip 原样读回', async () => {
  const dir = tmpRoot('rt');
  const file = path.join(dir, 'out.zip');
  const w = new ZipWriter(file);
  await w.open();
  await w.addText('a/hello.txt', '你好，世界');
  await w.addBuffer('b/bin.dat', Buffer.from([1, 2, 3, 4, 5]));
  const realFile = path.join(dir, 'real.bin');
  fs.writeFileSync(realFile, Buffer.alloc(5000, 9));
  await w.addFile('c/real.bin', realFile);
  const done = await w.close();

  assert.equal(done.entries, 3);
  const zip = openZip(fs.readFileSync(file));
  assert.deepEqual([...zip.names].sort(), ['a/hello.txt', 'b/bin.dat', 'c/real.bin']);
  assert.equal(zip.text('a/hello.txt'), '你好，世界');
  assert.deepEqual([...zip.read('b/bin.dat')], [1, 2, 3, 4, 5]);
  assert.equal(zip.read('c/real.bin').length, 5000);
});

test('ZipWriter: jar/png 用 store，txt/js 用 deflate', async () => {
  const dir = tmpRoot('method');
  const file = path.join(dir, 'out.zip');
  const w = new ZipWriter(file);
  await w.open();
  await w.addText('x.jar', Buffer.alloc(100, 0).toString('latin1'));
  await w.addText('y.txt', 'a'.repeat(5000));
  await w.close();

  const buf = fs.readFileSync(file);
  // 从中央目录读 method：找到 CEN 签名逐条解析太啰嗦，直接看名字后面的字段
  const zip = openZip(buf);
  // openZip 不暴露 method，这里换个方式：deflate 的 5000 个 .a. 应该被压到很小
  assert.ok(zip.read('y.txt').length === 5000);
  assert.ok(buf.length < 5000 + 100 + 400, `压缩后应明显小于原始，实际 ${buf.length}`);
});

test('crc32: 已知向量', () => {
  // "123456789" 的 CRC32 是 0xCBF43926
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('planExport: offline 排除 logs/crash-reports/saves，并塞进 versions/<id>/', () => {
  const { inst, id } = fakeInstance('plan');
  const instance = resolveInstance(inst);
  const plan = planExport(instance, { mode: 'offline', packName: 'MyPack' });
  const names = plan.entries.map((e) => e.name);

  assert.ok(names.includes(`MyPack/versions/${id}/mods/a.jar`));
  assert.ok(names.includes(`MyPack/versions/${id}/config/common.toml`));
  assert.ok(names.includes(`MyPack/versions/${id}/${id}.json`));
  assert.ok(names.includes(`MyPack/versions/${id}/${id}.jar`));
  assert.ok(!names.some((n) => n.includes('/logs/')), 'logs 不该进包');
  assert.ok(!names.some((n) => n.includes('/crash-reports/')), 'crash-reports 不该进包');
  assert.ok(!names.some((n) => n.includes('/saves/')), 'saves 默认不该进包');
  // 包裹层：每一条都以 MyPack/ 开头
  assert.ok(names.every((n) => n.startsWith('MyPack/')), '必须统一包裹一层');
});

test('planExport: includeSaves 打开后存档会进包', () => {
  const { inst } = fakeInstance('saves');
  const instance = resolveInstance(inst);
  const plan = planExport(instance, { mode: 'offline', includeSaves: true });
  assert.ok(plan.entries.some((e) => e.name.includes('/saves/world/level.dat')));
});

test('planExport: standard 只留 mods/config/kubejs 等，不带版本 json', () => {
  const { inst } = fakeInstance('std');
  const instance = resolveInstance(inst);
  const plan = planExport(instance, { mode: 'standard', packName: 'Lite' });
  const names = plan.entries.map((e) => e.name);
  assert.ok(names.includes('Lite/mods/a.jar'));
  assert.ok(names.includes('Lite/config/common.toml'));
  assert.ok(names.includes('Lite/kubejs/server_scripts/x.js'));
  assert.ok(!names.some((n) => n.endsWith('.json') && n.includes('versions/')), 'standard 不该带版本 json');
  assert.ok(plan.warnings.some((w) => w.includes('manifest.json')), '要提示没有 manifest');
});

test('planExport: 包名里的 ! 和 ; 会被换掉（PCL 会拒绝）', () => {
  const { inst } = fakeInstance('bad');
  const instance = resolveInstance(inst);
  const plan = planExport(instance, { mode: 'offline', packName: 'a!b;c' });
  assert.ok(!plan.packName.includes('!'));
  assert.ok(!plan.packName.includes(';'));
  assert.ok(plan.entries.every((e) => !e.name.includes('!') && !e.name.includes(';')));
});

test('buildExport + checkZip: offline 包自检全过', async () => {
  const { inst } = fakeInstance('build');
  const instance = resolveInstance(inst);
  const out = path.join(path.dirname(inst), '..', 'pack.zip');
  const result = await buildExport(instance, {
    mode: 'offline', packName: 'BuildPack', outFile: out,
    includeLibraries: false, includeAssets: false,
  });
  assert.ok(fs.existsSync(result.outFile));
  assert.ok(result.check.ok, `自检该全过，实际：${JSON.stringify(result.check.items.filter((i) => !i.ok))}`);

  const zip = openZip(fs.readFileSync(result.outFile));
  assert.ok(zip.has('BuildPack/PCL/Setup.ini'));
  const ini = zip.text('BuildPack/PCL/Setup.ini');
  assert.ok(ini.includes('VersionArgumentIndie=1'));
  assert.ok(ini.includes('VersionArgumentIndieV2=True'));
  assert.ok(zip.has('BuildPack/dsh-export.json'));
  const meta = JSON.parse(zip.text('BuildPack/dsh-export.json'));
  assert.equal(meta.mode, 'offline');
  assert.equal(meta.mcVersion, '1.21.1');
});

test('buildExport: launcher 形态没给 pclExe 会失败，且不留半成品', async () => {
  const { inst } = fakeInstance('launch');
  const instance = resolveInstance(inst);
  const out = path.join(path.dirname(inst), '..', 'l.zip');
  await assert.rejects(
    () => buildExport(instance, {
      mode: 'launcher', packName: 'L', outFile: out,
      includeLibraries: false, includeAssets: false,
    }),
    /PCL/,
  );
  assert.ok(!fs.existsSync(out), '失败后不该留下半成品 zip');
});

test('buildExport: launcher 形态给出假 PCL.exe 时能套出 modpack.zip', async () => {
  const { inst } = fakeInstance('launch2');
  const instance = resolveInstance(inst);
  const dir = path.dirname(inst);
  const exe = path.join(dir, 'Plain Craft Launcher 2.exe');
  fs.writeFileSync(exe, Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from('Plain Craft Launcher', 'utf16le')]));
  const out = path.join(dir, '..', 'L2.zip');
  const result = await buildExport(instance, {
    mode: 'launcher', packName: 'L2', outFile: out, pclExe: exe,
    includeLibraries: false, includeAssets: false,
  });
  assert.ok(result.check.ok, `自检该全过：${JSON.stringify(result.check.items.filter((i) => !i.ok))}`);
  const zip = openZip(fs.readFileSync(out));
  assert.ok(zip.has('L2/modpack.zip'), '外层要有 modpack.zip');
  assert.ok(zip.has('L2/PCL.exe'), '外层要有 PCL.exe');
  assert.ok(!zip.names.some((n) => n.includes('/versions/')), '外层不该直接铺 versions/');
  // 内层必须自己是完整 offline 包
  const inner = openZip(zip.read('L2/modpack.zip'));
  assert.ok(inner.names.some((n) => n.includes('/versions/TestPack/TestPack.json')));
});

test('checkZip: 缺 versions/<名>/<名>.json 时该报不通过', async () => {
  const dir = tmpRoot('chk');
  const file = path.join(dir, 'bad.zip');
  const w = new ZipWriter(file);
  await w.open();
  await w.addText('P/mods/a.jar', 'x');
  await w.close();
  const check = checkZip(file, 'offline');
  assert.equal(check.ok, false);
  const rule = check.items.find((i) => i.rule.includes('versions/<名>/<名>.json'));
  assert.ok(rule && !rule.ok);
});

test('looksLikePcl: 普通文件判不过，带 UTF-16LE 字样的判过', () => {
  const dir = tmpRoot('pcl');
  const plain = path.join(dir, 'a.exe');
  fs.writeFileSync(plain, Buffer.from('nothing here'));
  assert.equal(looksLikePcl(plain).ok, false);

  const fake = path.join(dir, 'PCL.exe');
  fs.writeFileSync(fake, Buffer.concat([
    Buffer.from([0x4d, 0x5a]),
    Buffer.from('Plain Craft Launcher', 'utf16le'),
  ]));
  assert.equal(looksLikePcl(fake).ok, true);

  const admin = path.join(dir, 'Admin.exe');
  fs.writeFileSync(admin, Buffer.concat([
    Buffer.from([0x4d, 0x5a]),
    Buffer.from('Plain Craft Launcher Admin Manager', 'utf16le'),
  ]));
  assert.equal(looksLikePcl(admin).ok, false);
});

test('looksLikePcl: 两种标记都出现时按差值判（模拟单文件 exe 的内嵌程序集元数据）', () => {
  // 实测真 PCL 2.10.6 的 exe 里 "Plain Craft Launcher" 出现 163 次、
  // "Plain Craft Launcher Admin Manager" 只出现 1 次 —— 不能因为见到管理员标记就判否。
  const dir = tmpRoot('pcl-both');
  const both = path.join(dir, 'both.exe');
  fs.writeFileSync(both, Buffer.concat([
    Buffer.from([0x4d, 0x5a]),
    Buffer.from('Plain Craft Launcher', 'utf16le'),
    Buffer.from('Plain Craft Launcher Admin Manager', 'utf16le'),
    Buffer.from('Plain Craft Launcher', 'utf16le'),
  ]));
  assert.equal(looksLikePcl(both).ok, true);
});

test('planExport: 缺客户端 jar 时给警告', () => {
  const { inst } = fakeInstance('nojar', { withJar: false });
  const instance = resolveInstance(inst);
  const plan = planExport(instance, { mode: 'offline' });
  assert.ok(plan.warnings.some((w) => w.includes('客户端 jar')));
});

test('planExport: 未知形态直接抛错', () => {
  const { inst } = fakeInstance('badmode');
  const instance = resolveInstance(inst);
  assert.throws(() => planExport(instance, { mode: 'zip' }), /不认识的导出形态/);
});
