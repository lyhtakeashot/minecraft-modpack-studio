/**
 * 装 mod 的 plan/apply 单测。
 *
 * 这里最要紧的不是「能不能装上」，而是「不该动的东西一个都没动」：
 * 同名不同内容不覆盖、路径穿不出 mods、sha1 不对不落盘、已装过不重复下。
 * 全部走临时目录，不碰真实整合包。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  MAX_DEPTH, applyInstallPlan, buildInstallPlan, describePlan, describeResult,
  indexModsFolder, resolveInside,
} from '../packages/core/mod-install.js';

function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-inst-${tag}-`));
  return dir;
}

function sha1Of(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

function versionOf({ projectId, number = '1.0', type = 'release', gameVersions = ['1.21.1'], loaders = ['neoforge'], fileName, bytes = 'jar-bytes', deps = [], sha1 }) {
  const body = Buffer.from(bytes);
  return {
    id: `${projectId}-${number}`,
    project_id: projectId,
    name: `${projectId} ${number}`,
    version_number: number,
    version_type: type,
    date_published: '2026-09-01T00:00:00Z',
    downloads: 10,
    game_versions: gameVersions,
    loaders,
    files: [{ filename: fileName ?? `${projectId}-${number}.jar`, url: `https://cdn.modrinth.com/${projectId}.jar`, size: body.length, primary: true, hashes: { sha1: sha1 ?? sha1Of(body) } }],
    dependencies: deps,
  };
}

/**
 * 假 http：按 URL 里的工程 ID 返回预设的 project / versions，下载直接写本地字节。
 * 用法和真的 createHttp() 一样（只有 json 和 downloadToFile 两个方法被用到）。
 */
function fakeHttp({ projects = {}, versions = {}, download = () => Buffer.from('jar-bytes'), failDownload = {} } = {}) {
  const calls = [];
  return {
    calls,
    async json(url) {
      const text = String(url);
      calls.push(text);
      const versionMatch = text.match(/\/v2\/project\/([^/]+)\/version/);
      if (versionMatch) {
        const id = decodeURIComponent(versionMatch[1]);
        if (!versions[id]) throw Object.assign(new Error('not found'), { code: 'McHttpNotFound', status: 404 });
        return versions[id];
      }
      const projectMatch = text.match(/\/v2\/project\/([^/]+)$/);
      if (projectMatch) {
        const id = decodeURIComponent(projectMatch[1]);
        if (!projects[id]) throw Object.assign(new Error('not found'), { code: 'McHttpNotFound', status: 404 });
        return projects[id];
      }
      throw new Error(`假的 http 不认这个地址：${text}`);
    },
    async downloadToFile(url, dest) {
      const key = String(url);
      if (failDownload[key]) throw Object.assign(new Error(failDownload[key]), { code: 'McDownloadHttp' });
      const buffer = download(url);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
      return { path: dest, bytes: buffer.length, sha1: sha1Of(buffer), url: key };
    },
  };
}

function projectOf(id, title) {
  return { id, slug: id, title, description: '', categories: [], loaders: ['neoforge'], game_versions: ['1.21.1'], downloads: 1, icon_url: '' };
}

function modsDirOf(tag) {
  const root = tmpDir(tag);
  const modsDir = path.join(root, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  return { root, modsDir };
}

test('indexModsFolder 只数 jar（含 .disabled），不数别的', async () => {
  const { modsDir } = modsDirOf('index');
  fs.writeFileSync(path.join(modsDir, 'a.jar'), 'x');
  fs.writeFileSync(path.join(modsDir, 'b.jar.disabled'), 'x');
  fs.writeFileSync(path.join(modsDir, 'readme.txt'), 'x');
  fs.mkdirSync(path.join(modsDir, 'sub.jar'));
  const index = await indexModsFolder(modsDir);
  assert.equal(index.count, 2);
  assert.ok(index.byName.has('a.jar'));
  assert.ok(index.byName.has('b.jar.disabled'));
});

test('indexModsFolder 遇到不存在的目录不炸', async () => {
  const root = tmpDir('missing');
  const index = await indexModsFolder(path.join(root, 'nope'));
  assert.equal(index.count, 0);
});

test('单 mod 无前置：算出一个要装的文件', async () => {
  const { modsDir } = modsDirOf('single');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', number: '6.0.10' })] },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].title, 'Create');
  assert.equal(plan.items[0].reason, 'requested');
  assert.equal(plan.items[0].fileName, 'create-6.0.10.jar');
  assert.equal(plan.items[0].versionNumber, '6.0.10');
  assert.ok(plan.totalBytes > 0);
});

test('必装前置会跟着进来，optional 不跟', async () => {
  const { modsDir } = modsDirOf('deps');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create'), jei: projectOf('jei', 'JEI'), patchouli: projectOf('patchouli', 'Patchouli') },
    versions: {
      create: [versionOf({
        projectId: 'create',
        deps: [
          { project_id: 'jei', dependency_type: 'required' },
          { project_id: 'patchouli', dependency_type: 'optional' },
        ],
      })],
      jei: [versionOf({ projectId: 'jei' })],
      patchouli: [versionOf({ projectId: 'patchouli' })],
    },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(plan.items.length, 2);
  const dep = plan.items.find((item) => item.projectId === 'jei');
  assert.equal(dep.reason, 'dependency');
  assert.equal(dep.dependencyOf, 'Create');
  assert.equal(plan.items.some((item) => item.projectId === 'patchouli'), false);
});

test('withDeps:false 时不带前置', async () => {
  const { modsDir } = modsDirOf('nodeps');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create'), jei: projectOf('jei', 'JEI') },
    versions: {
      create: [versionOf({ projectId: 'create', deps: [{ project_id: 'jei', dependency_type: 'required' }] })],
      jei: [versionOf({ projectId: 'jei' })],
    },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge', withDeps: false });
  assert.equal(plan.items.length, 1);
});

test('环形依赖不会无限展开', async () => {
  const { modsDir } = modsDirOf('cycle');
  const http = fakeHttp({
    projects: { a: projectOf('a', 'A'), b: projectOf('b', 'B') },
    versions: {
      a: [versionOf({ projectId: 'a', deps: [{ project_id: 'b', dependency_type: 'required' }] })],
      b: [versionOf({ projectId: 'b', deps: [{ project_id: 'a', dependency_type: 'required' }] })],
    },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['a'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(plan.items.length, 2);
  assert.equal(MAX_DEPTH >= 1, true);
});

test('已经装过（同名同内容）就跳过，不再下', async () => {
  const { modsDir } = modsDirOf('already');
  const body = Buffer.from('same-bytes');
  fs.writeFileSync(path.join(modsDir, 'create-1.0.jar'), body);
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', bytes: 'same-bytes' })] },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.skippedExisting.length, 1);
  assert.equal(plan.skippedExisting[0].fileName, 'create-1.0.jar');
});

test('同名但内容不同 -> 报冲突，不覆盖，也不进安装清单', async () => {
  const { modsDir } = modsDirOf('conflict');
  fs.writeFileSync(path.join(modsDir, 'create-1.0.jar'), Buffer.from('old-version'));
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', bytes: 'new-version' })] },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].conflict, true);
  assert.equal(fs.readFileSync(path.join(modsDir, 'create-1.0.jar'), 'utf8'), 'old-version');
});

test('没有兼容版本 -> 进 unresolved，并说清楚为什么', async () => {
  const { modsDir } = modsDirOf('noversion');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', gameVersions: ['1.20.1'] })] },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].reason, 'no-compatible-version');
  assert.match(plan.unresolved[0].message, /1\.21\.1/);
});

test('工程 ID 不存在 -> unresolved 里有 not-found', async () => {
  const { modsDir } = modsDirOf('404');
  const http = fakeHttp({ projects: {}, versions: {} });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['nope'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.unresolved[0].reason, 'not-found');
});

test('没说要装什么 / 没给 mods 目录 -> 直接报错', async () => {
  const { modsDir } = modsDirOf('bad-args');
  const http = fakeHttp();
  await assert.rejects(() => buildInstallPlan({ http, modsDir, requests: [] }), (e) => e.code === 'McNoRequests');
  await assert.rejects(() => buildInstallPlan({ http, modsDir: '', requests: ['a'] }), (e) => e.code === 'McNoModsDir');
});

test('channel=beta 才接受测试版', async () => {
  const { modsDir } = modsDirOf('beta');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', number: '7.0-beta', type: 'beta' })] },
  });
  const strict = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(strict.items.length, 0);
  const loose = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge', channel: 'beta' });
  assert.equal(loose.items.length, 1);
});

// ——————————————— 装 mod 选版本（2026-11-04 第 3 批 A） ———————————————

test('pinned 点名旧版就装旧版，不再自动挑最新（界面选版本能真正生效）', async () => {
  const { modsDir } = modsDirOf('pinned');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [
      versionOf({ projectId: 'create', number: '6.0.10' }),
      versionOf({ projectId: 'create', number: '0.5.1' }),
    ] },
  });
  // 不点名时按发布日期挑最新；点名了就只认那一条。
  const auto = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(auto.items[0].versionNumber, '6.0.10');
  const pinned = await buildInstallPlan({
    http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge',
    pinned: { create: 'create-0.5.1' },
  });
  assert.equal(pinned.items.length, 1);
  assert.equal(pinned.items[0].versionId, 'create-0.5.1');
  assert.equal(pinned.items[0].versionNumber, '0.5.1');
  assert.equal(pinned.items[0].fileName, 'create-0.5.1.jar');
  assert.deepEqual(pinned.pinned, { create: 'create-0.5.1' });
  assert.equal(pinned.unresolved.length, 0, '点名找到时不该有未解决项');
});

test('pinned 用 slug 当 key 也能对上（界面可能勾 slug 也可能勾 projectId）', async () => {
  const { modsDir } = modsDirOf('pinned-slug');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', number: '6.0.10' }), versionOf({ projectId: 'create', number: '0.5.1' })] },
  });
  const plan = await buildInstallPlan({
    http, modsDir, requests: [{ slug: 'create' }], gameVersion: '1.21.1', loader: 'neoforge',
    pinned: { create: 'create-0.5.1' },
  });
  assert.equal(plan.items[0].versionNumber, '0.5.1');
});

test('pinned 的版本找不到就明确报错，不静默退回自动挑最新', async () => {
  const { modsDir } = modsDirOf('pinned-missing');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', number: '6.0.10' })] },
  });
  const plan = await buildInstallPlan({
    http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge',
    pinned: { create: '不存在的版本ID' },
  });
  assert.equal(plan.items.length, 0, '绝不能悄悄装成最新版');
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].reason, 'pinned-version-not-found');
  assert.match(plan.unresolved[0].message, /不存在的版本ID/);
});

test('pinned 只锁用户点名的那一层，前置依赖仍按渠道自动挑（不把前置锁死）', async () => {
  const { modsDir } = modsDirOf('pinned-dep');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create'), jei: projectOf('jei', 'JEI') },
    versions: {
      create: [
        versionOf({ projectId: 'create', number: '6.0.10', deps: [{ project_id: 'jei', dependency_type: 'required' }] }),
        versionOf({ projectId: 'create', number: '0.5.1', deps: [{ project_id: 'jei', dependency_type: 'required' }] }),
      ],
      jei: [versionOf({ projectId: 'jei', number: '19.0' }), versionOf({ projectId: 'jei', number: '18.0' })],
    },
  });
  const plan = await buildInstallPlan({
    http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge',
    pinned: { create: 'create-0.5.1' },
  });
  assert.equal(plan.items.find((i) => i.projectId === 'create').versionNumber, '0.5.1');
  const dep = plan.items.find((i) => i.projectId === 'jei');
  assert.equal(dep.reason, 'dependency');
  assert.equal(dep.versionNumber, '19.0', '依赖不该被点名锁住，仍自动挑最新');
});

test('apply 真的把字节写进 mods，并报出结果', async () => {
  const { modsDir } = modsDirOf('apply');
  const body = Buffer.from('create-jar');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', bytes: 'create-jar' })] },
    download: () => body,
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  const result = await applyInstallPlan({ http, plan, modsDir });
  assert.equal(result.installed.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(fs.readFileSync(path.join(modsDir, 'create-1.0.jar'), 'utf8'), 'create-jar');
});

test('apply 时文件已存在（同内容）-> 跳过，不重写', async () => {
  const { modsDir } = modsDirOf('apply-skip');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', bytes: 'jar-bytes' })] },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  const fakePlan = { ...plan, items: plan.items.map((item) => ({ ...item })) };
  fs.writeFileSync(path.join(modsDir, 'create-1.0.jar'), Buffer.from('jar-bytes'));
  const result = await applyInstallPlan({ http, plan: fakePlan, modsDir });
  assert.equal(result.installed.length, 0);
  assert.equal(result.skipped.length, 1);
});

test('apply 遇到同名不同内容 -> 不覆盖，记失败', async () => {
  const { modsDir } = modsDirOf('apply-conflict');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', bytes: 'new' })] },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  fs.writeFileSync(path.join(modsDir, 'create-1.0.jar'), Buffer.from('old'));
  const result = await applyInstallPlan({ http, plan, modsDir });
  assert.equal(result.installed.length, 0);
  assert.equal(result.failed[0].reason, 'exists-different');
  assert.equal(fs.readFileSync(path.join(modsDir, 'create-1.0.jar'), 'utf8'), 'old');
});

test('apply 时下载失败 -> 记失败但继续装下一个', async () => {
  const { modsDir } = modsDirOf('apply-fail');
  const http = fakeHttp({
    projects: { a: projectOf('a', 'A'), b: projectOf('b', 'B') },
    versions: { a: [versionOf({ projectId: 'a' })], b: [versionOf({ projectId: 'b' })] },
    failDownload: { 'https://cdn.modrinth.com/a.jar': '镜像挂了' },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['a', 'b'], gameVersion: '1.21.1', loader: 'neoforge' });
  const result = await applyInstallPlan({ http, plan, modsDir });
  assert.equal(result.failed.length, 1);
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].title, 'B');
});

test('apply 挡住把文件写到 mods 目录外面', async () => {
  const { modsDir } = modsDirOf('escape');
  const http = fakeHttp();
  const plan = {
    modsDir,
    items: [{ title: 'evil', projectId: 'evil', fileName: '..\\..\\evil.jar', fileUrl: 'https://cdn/x', sha1: '', size: 1, versionNumber: '1' }],
  };
  const result = await applyInstallPlan({ http, plan, modsDir });
  assert.equal(result.installed.length, 0);
  assert.equal(result.failed[0].reason, 'unsafe-name');
  assert.equal(fs.existsSync(path.join(modsDir, '..', '..', 'evil.jar')), false);
});

test('resolveInside 只放行 mods 里的路径', () => {
  const base = path.join(os.tmpdir(), 'base-mods');
  assert.equal(resolveInside(base, 'a.jar'), path.join(base, 'a.jar'));
  assert.equal(resolveInside(base, path.join('sub', 'a.jar')), path.join(base, 'sub', 'a.jar'));
  assert.equal(resolveInside(base, '..\\evil.jar'), null);
  assert.equal(resolveInside(base, path.resolve(base, '..', 'outer.jar')), null);
});

test('describePlan / describeResult 说人话', async () => {
  const { modsDir } = modsDirOf('describe');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create' })] },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  const lines = describePlan(plan);
  assert.ok(lines.some((line) => line.includes('准备安装 1 个文件')));
  assert.ok(lines.some((line) => line.includes('Create')));

  const result = await applyInstallPlan({ http, plan, modsDir });
  const done = describeResult(result);
  assert.ok(done.some((line) => line.includes('装好了 1 个')));
});

test('describePlan 会提醒「同名不同内容没覆盖」', () => {
  const lines = describePlan({
    items: [],
    skippedExisting: [],
    conflicts: [{ title: 'Create', fileName: 'create.jar' }],
    unresolved: [{ title: 'X', message: '没版本' }],
    totalBytes: 0,
  });
  assert.ok(lines.some((line) => line.includes('没有自动覆盖')));
  assert.ok(lines.some((line) => line.includes('X：没版本')));
});

test('指定下载目录：文件下到那个目录，实例的 mods 目录不动', async () => {
  const { root, modsDir } = modsDirOf('target-dir');
  const downloadDir = path.join(root, '下载');
  const body = Buffer.from('create-jar');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', bytes: 'create-jar' })] },
    download: () => body,
  });
  const plan = await buildInstallPlan({
    http, modsDir, targetDir: downloadDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge',
  });
  assert.equal(plan.targetDir, path.resolve(downloadDir));
  const result = await applyInstallPlan({ http, plan });
  assert.equal(result.installed.length, 1);
  assert.equal(fs.readFileSync(path.join(downloadDir, 'create-1.0.jar'), 'utf8'), 'create-jar');
  assert.equal(fs.existsSync(path.join(modsDir, 'create-1.0.jar')), false, '实例的 mods 目录不该被动');
});

test('不指定下载目录：默认下到实例的 mods 目录', async () => {
  const { modsDir } = modsDirOf('target-default');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create', bytes: 'create-jar' })] },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(plan.targetDir, path.resolve(modsDir));
  const result = await applyInstallPlan({ http, plan, modsDir });
  assert.equal(result.installed.length, 1);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-1.0.jar')), true);
});

test('算计划时顺便给整包做体检，把结果带在计划里', async () => {
  const { modsDir } = modsDirOf('plan-compat');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create' })] },
  });
  const plan = await buildInstallPlan({ http, modsDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge' });
  assert.ok(plan.compat, '计划里应该带着体检结果');
  assert.equal(plan.compat.modsDir, path.resolve(modsDir));
  assert.equal(plan.compat.ok, true, '空目录不该报问题');
});

test('describePlan 会说出「文件下到哪儿」和体检结果', async () => {
  const { root, modsDir } = modsDirOf('describe-target');
  const downloadDir = path.join(root, '下载');
  const http = fakeHttp({
    projects: { create: projectOf('create', 'Create') },
    versions: { create: [versionOf({ projectId: 'create' })] },
  });
  const plan = await buildInstallPlan({
    http, modsDir, targetDir: downloadDir, requests: ['create'], gameVersion: '1.21.1', loader: 'neoforge',
  });
  const lines = describePlan(plan);
  assert.ok(lines.some((line) => line.includes('文件会下到') && line.includes(downloadDir)));
  assert.ok(lines.some((line) => line.includes('兼容性体检')));
});