/**
 * 检查 mod 更新 / 升级整合包里 mod 的单测。
 *
 * 这里最要紧的三件事：
 *   1. 用 jar 的哈希去问 Modrinth，认 mod 不认错、也不会拿名字乱猜；
 *   2. 升级是「停用旧 jar」而不是删除或覆盖 —— 用户原来的文件一个都不能少；
 *   3. 下载失败要把旧 jar 名字改回来，半成品也只改名留着，绝不删。
 *
 * 全部走临时目录，不碰真实整合包；联网和下载都用替身，不发外网。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  HASH_BATCH,
  MAX_SCAN_JARS,
  applyRollbackPlan,
  applyUpdatePlan,
  buildRollbackPlan,
  buildUpdatePlan,
  checkModUpdates,
  describeRollbackResult,
  describeUpdateResult,
  scanModsForUpdate,
} from '../packages/core/mod-update.js';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-upd-${tag}-`));
}

function sha1Of(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

function modsDirOf(tag) {
  const root = tmpDir(tag);
  const modsDir = path.join(root, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  return { root, modsDir };
}

/** 造一个 Modrinth /version_files/update 返回的「最新版本」对象。 */
function versionOf({ projectId = 'create', number = '2.0', fileName = `${projectId}-2.0.jar`, bytes = 'new-bytes', sha1, type = 'release' } = {}) {
  const body = Buffer.from(bytes);
  return {
    id: `${projectId}-${number}`,
    project_id: projectId,
    name: `${projectId} ${number}`,
    version_number: number,
    version_type: type,
    date_published: '2026-10-01T00:00:00Z',
    files: [{
      primary: true,
      filename: fileName,
      url: `https://cdn.modrinth.com/${fileName}`,
      size: body.length,
      hashes: { sha1: sha1 ?? sha1Of(body) },
    }],
  };
}

/**
 * 假联网对象：按 options.body.hashes 回一张「旧哈希 → 最新版本」的表。
 * 下载按 url 写本地字节，可指定某个 url 失败（并留下半成品测回滚）。
 */
function fakeHttp({ answers = {}, notFound = false, download = () => Buffer.from('new-bytes'), failDownload = {} } = {}) {
  const calls = [];
  return {
    calls,
    async json(url, options = {}) {
      calls.push({ url: String(url), options });
      if (notFound) throw Object.assign(new Error('not found'), { code: 'McHttpNotFound', status: 404 });
      const hashes = options?.body?.hashes ?? [];
      const out = {};
      for (const hash of hashes) {
        const hit = answers[hash] ?? answers[String(hash).toLowerCase()];
        if (hit) out[hash] = hit;
      }
      return out;
    },
    async downloadToFile(url, dest, expect = {}) {
      const key = String(url);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (failDownload[key]) {
        // 故意留一个半成品，验证失败后只改名、不删除
        fs.writeFileSync(dest, Buffer.from('partial'));
        throw Object.assign(new Error(failDownload[key]), { code: 'McDownloadHttp' });
      }
      const buffer = download(key);
      expect.onProgress?.({ received: buffer.length, total: buffer.length });
      fs.writeFileSync(dest, buffer);
      return { path: dest, bytes: buffer.length, sha1: sha1Of(buffer), url: key };
    },
  };
}

/** 直接造一份「检查结果」喂给 buildUpdatePlan，省掉联网那一步。 */
function checkOf(items, modsDir) {
  return {
    modsDir, gameVersion: '1.21.1', loader: 'neoforge', channel: 'release',
    scanned: items.length, items,
    updates: items.filter((it) => it.status === 'update').length,
    latest: 0, unknown: 0, lines: [],
  };
}

function updateItem({ key = 'key1', fileName = 'create.jar', name = 'Create', currentVersion = '1.0', latestVersion = '2.0', newFileName = 'create-2.0.jar', newSha1 = sha1Of(Buffer.from('new-bytes')), size = 9 } = {}) {
  return {
    key, fileName, name, modId: 'create', currentVersion, latestVersion,
    projectId: 'create', versionType: 'release', status: 'update',
    file: {
      fileName: newFileName,
      fileUrl: `https://cdn.modrinth.com/${newFileName}`,
      sha1: newSha1,
      size,
      versionNumber: latestVersion,
      versionType: 'release',
      projectId: 'create',
      versionId: 'create-2.0',
    },
  };
}

// ————————————————————————— 扫本地 —————————————————————————

test('scanModsForUpdate 只认启用的 .jar，排除停用的和别的后缀', async () => {
  const { modsDir } = modsDirOf('scan');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('old-create'));
  fs.writeFileSync(path.join(modsDir, 'jei.jar.disabled'), Buffer.from('disabled'));
  fs.writeFileSync(path.join(modsDir, 'readme.txt'), Buffer.from('text'));
  const scan = await scanModsForUpdate(modsDir);
  assert.equal(scan.files.length, 1);
  assert.equal(scan.files[0].fileName, 'create.jar');
  assert.equal(scan.files[0].sha1, sha1Of(Buffer.from('old-create')));
  assert.equal(scan.skipped, 0);
  assert.equal(scan.failed, 0);
  assert.equal(MAX_SCAN_JARS, 600);
  assert.equal(HASH_BATCH, 100);
});

test('scanModsForUpdate 空目录不炸', async () => {
  const { modsDir } = modsDirOf('scan-empty');
  const scan = await scanModsForUpdate(modsDir);
  assert.equal(scan.files.length, 0);
});

// ————————————————————————— 检查更新 —————————————————————————

test('checkModUpdates 有新版本 -> status=update，POST 参数按实例过滤', async () => {
  const { modsDir } = modsDirOf('check-update');
  const old = Buffer.from('old-create');
  const oldSha1 = sha1Of(old);
  const newBody = Buffer.from('new-create');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), old);
  const http = fakeHttp({
    answers: { [oldSha1]: versionOf({ bytes: 'new-create', fileName: 'create-2.0.jar' }) },
  });
  const result = await checkModUpdates({ http, modsDir, gameVersion: '1.21.1', loader: 'neoforge', channel: 'release' });
  assert.equal(result.scanned, 1);
  assert.equal(result.updates, 1);
  assert.equal(result.items[0].status, 'update');
  assert.equal(result.items[0].key, oldSha1);
  assert.equal(result.items[0].latestVersion, '2.0');
  assert.equal(result.items[0].file.fileName, 'create-2.0.jar');
  assert.equal(result.items[0].file.sha1, sha1Of(newBody));
  // 联网参数必须带齐，而且渠道只放正式版
  assert.equal(http.calls.length, 1);
  assert.match(http.calls[0].url, /\/version_files\/update$/);
  const body = http.calls[0].options.body;
  assert.equal(http.calls[0].options.method, 'POST');
  assert.equal(body.algorithm, 'sha1');
  assert.deepEqual(body.hashes, [oldSha1]);
  assert.deepEqual(body.loaders, ['neoforge']);
  assert.deepEqual(body.game_versions, ['1.21.1']);
  assert.deepEqual(body.version_types, ['release']);
});

test('checkModUpdates 新旧哈希相同 -> 已是最新，不进升级清单', async () => {
  const { modsDir } = modsDirOf('check-latest');
  const old = Buffer.from('same');
  const oldSha1 = sha1Of(old);
  fs.writeFileSync(path.join(modsDir, 'create.jar'), old);
  const http = fakeHttp({ answers: { [oldSha1]: versionOf({ bytes: 'same', sha1: oldSha1 }) } });
  const result = await checkModUpdates({ http, modsDir });
  assert.equal(result.items[0].status, 'latest');
  assert.equal(result.latest, 1);
  assert.equal(result.updates, 0);
  assert.equal(result.items[0].file, null);
});

test('checkModUpdates 查不到的哈希 -> 如实标 unknown，不假装最新', async () => {
  const { modsDir } = modsDirOf('check-unknown');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('private-mod'));
  const http = fakeHttp({ answers: {} });
  const result = await checkModUpdates({ http, modsDir });
  assert.equal(result.items[0].status, 'unknown');
  assert.equal(result.unknown, 1);
  assert.equal(result.updates, 0);
});

test('checkModUpdates 官方回 404 空 body -> 当空表，不崩', async () => {
  const { modsDir } = modsDirOf('check-404');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('private-mod'));
  const http = fakeHttp({ notFound: true });
  const result = await checkModUpdates({ http, modsDir });
  assert.equal(result.scanned, 1);
  assert.equal(result.unknown, 1);
  assert.equal(result.items[0].status, 'unknown');
});

test('checkModUpdates 没给目录 / 没给联网对象 -> 明确报错', async () => {
  const http = fakeHttp();
  await assert.rejects(() => checkModUpdates({ http, modsDir: '' }), (e) => e.code === 'McNoModsDir');
  await assert.rejects(() => checkModUpdates({ modsDir: tmpDir('no-http') }), (e) => e.code === 'McNoHttp');
});

test('checkModUpdates 一个文件都不写', async () => {
  const { modsDir } = modsDirOf('check-readonly');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('old'));
  const http = fakeHttp({ answers: {} });
  await checkModUpdates({ http, modsDir });
  assert.deepEqual(fs.readdirSync(modsDir), ['create.jar']);
});

// ————————————————————————— 算清单（不写盘） —————————————————————————

test('buildUpdatePlan 空 selected = 全部能升，停用名不撞车', async () => {
  const { modsDir } = modsDirOf('plan-all');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('old'));
  const plan = await buildUpdatePlan({ check: checkOf([updateItem()], modsDir), modsDir });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].oldName, 'create.jar');
  assert.equal(plan.items[0].disabledName, 'create.jar.disabled');
  assert.equal(plan.items[0].newName, 'create-2.0.jar');
  assert.ok(plan.lines.some((line) => line.includes('不会删')));
  // 只算清单，一个文件都不写
  assert.deepEqual(fs.readdirSync(modsDir), ['create.jar']);
});

test('buildUpdatePlan selected 按 key 过滤（界面传 JSON 串）', async () => {
  const { modsDir } = modsDirOf('plan-key');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('old'));
  fs.writeFileSync(path.join(modsDir, 'jei.jar'), Buffer.from('old'));
  const check = checkOf([
    updateItem({ key: 'k-create', fileName: 'create.jar', newFileName: 'create-2.jar' }),
    updateItem({ key: 'k-jei', fileName: 'jei.jar', newFileName: 'jei-2.jar' }),
  ], modsDir);
  const plan = await buildUpdatePlan({ check, modsDir, selected: JSON.stringify(['k-jei']) });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].oldName, 'jei.jar');
});

test('buildUpdatePlan selected 也能按旧文件名匹配', async () => {
  const { modsDir } = modsDirOf('plan-name');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('old'));
  fs.writeFileSync(path.join(modsDir, 'jei.jar'), Buffer.from('old'));
  const check = checkOf([
    updateItem({ key: 'k1', fileName: 'create.jar', newFileName: 'create-2.jar' }),
    updateItem({ key: 'k2', fileName: 'jei.jar', newFileName: 'jei-2.jar' }),
  ], modsDir);
  const plan = await buildUpdatePlan({ check, modsDir, selected: 'create.jar' });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].oldName, 'create.jar');
});

test('buildUpdatePlan 停用名已被占用 -> 自动加后缀，绝不覆盖', async () => {
  const { modsDir } = modsDirOf('plan-disabled');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('old'));
  fs.writeFileSync(path.join(modsDir, 'create.jar.disabled'), Buffer.from('别的旧版'));
  const plan = await buildUpdatePlan({ check: checkOf([updateItem()], modsDir), modsDir });
  assert.equal(plan.items[0].disabledName, 'create.jar.disabled-2');
});

test('buildUpdatePlan 新文件名已被占用 -> 跳过并说明，不覆盖', async () => {
  const { modsDir } = modsDirOf('plan-target');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('old'));
  fs.writeFileSync(path.join(modsDir, 'create-2.0.jar'), Buffer.from('别的 mod'));
  const plan = await buildUpdatePlan({ check: checkOf([updateItem()], modsDir), modsDir });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.skipped[0].reason, 'target-exists');
  assert.match(plan.skipped[0].message, /没有覆盖/);
});

test('buildUpdatePlan 没给检查结果 -> 明确报错', async () => {
  const { modsDir } = modsDirOf('plan-nocheck');
  await assert.rejects(() => buildUpdatePlan({ check: null, modsDir }), (e) => e.code === 'McNoUpdateCheck');
});

// ————————————————————————— 真升级（写盘） —————————————————————————

test('applyUpdatePlan 停用旧 jar（不删）+ 下载新 jar + 报进度', async () => {
  const { modsDir } = modsDirOf('apply-ok');
  const old = Buffer.from('old-create');
  const newBody = Buffer.from('brand-new');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), old);
  const item = updateItem({ newSha1: sha1Of(newBody) });
  const plan = await buildUpdatePlan({ check: checkOf([item], modsDir), modsDir });
  const http = fakeHttp({ download: () => newBody });
  const events = [];
  const result = await applyUpdatePlan({ http, plan, modsDir, onProgress: (e) => events.push(e) });

  assert.equal(result.installed.length, 1);
  assert.equal(result.failed.length, 0);
  // 旧文件改名停用，内容原封不动还在
  assert.equal(fs.readFileSync(path.join(modsDir, 'create.jar.disabled'), 'utf8'), 'old-create');
  assert.equal(fs.existsSync(path.join(modsDir, 'create.jar')), false);
  // 新文件下载到位
  assert.equal(fs.readFileSync(path.join(modsDir, 'create-2.0.jar'), 'utf8'), 'brand-new');
  // 进度事件与 modInstallReporter 兼容
  assert.ok(events.some((e) => e.stage === 'file-start'));
  assert.ok(events.some((e) => e.stage === 'progress'));
  assert.ok(events.some((e) => e.stage === 'file-done' && e.kind === 'installed' && e.bytes === newBody.length));
});

test('applyUpdatePlan 下载失败 -> 旧 jar 改回原名，半成品改名留着，绝不删', async () => {
  const { modsDir } = modsDirOf('apply-rollback');
  const old = Buffer.from('old-create');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), old);
  const plan = await buildUpdatePlan({ check: checkOf([updateItem()], modsDir), modsDir });
  const http = fakeHttp({ failDownload: { 'https://cdn.modrinth.com/create-2.0.jar': '镜像挂了' } });
  const result = await applyUpdatePlan({ http, plan, modsDir });

  assert.equal(result.installed.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, 'McDownloadHttp');
  assert.match(result.failed[0].message, /旧文件已经改回原名/);
  // 旧文件回来且内容没变，停用名不存在，半成品改名 .failed 留着
  assert.equal(fs.readFileSync(path.join(modsDir, 'create.jar'), 'utf8'), 'old-create');
  assert.equal(fs.existsSync(path.join(modsDir, 'create.jar.disabled')), false);
  assert.equal(fs.readFileSync(path.join(modsDir, 'create-2.0.jar.failed'), 'utf8'), 'partial');
});

test('applyUpdatePlan 新版本已经在且内容对得上 -> 跳过，不动旧文件', async () => {
  const { modsDir } = modsDirOf('apply-idempotent');
  const old = Buffer.from('old');
  const newBody = Buffer.from('new-bytes');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), old);
  fs.writeFileSync(path.join(modsDir, 'create-2.0.jar'), newBody);
  const item = updateItem({ newSha1: sha1Of(newBody) });
  const plan = await buildUpdatePlan({
    check: { ...checkOf([item], modsDir), items: [item] },
    modsDir,
  });
  // 手造计划绕过 buildUpdatePlan 的「目标名已占用」检查，专测 apply 的幂等分支
  const rawPlan = {
    modsDir,
    items: [{
      ...item, oldName: 'create.jar', oldPath: path.join(modsDir, 'create.jar'),
      disabledName: 'create.jar.disabled', newName: 'create-2.0.jar',
      newPath: path.join(modsDir, 'create-2.0.jar'),
      fileName: 'create-2.0.jar', fileUrl: 'https://cdn.modrinth.com/create-2.0.jar',
      sha1: sha1Of(newBody), size: newBody.length, versionId: 'create-2.0',
    }],
    totalBytes: newBody.length, skipped: [], lines: [],
  };
  const http = fakeHttp();
  const result = await applyUpdatePlan({ http, plan: rawPlan, modsDir });
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'already-installed');
  assert.equal(fs.readFileSync(path.join(modsDir, 'create.jar'), 'utf8'), 'old');
  assert.equal(plan.items.length, 0, 'buildUpdatePlan 本来就会因目标名已占用跳过');
});

test('applyUpdatePlan 旧文件不在了 -> 记失败，不瞎动别的', async () => {
  const { modsDir } = modsDirOf('apply-missing');
  const plan = {
    modsDir,
    items: [{
      name: 'Create', oldName: 'create.jar', oldPath: path.join(modsDir, 'create.jar'),
      disabledName: 'create.jar.disabled', newName: 'create-2.0.jar',
      newPath: path.join(modsDir, 'create-2.0.jar'), fileName: 'create-2.0.jar',
      fileUrl: 'https://cdn/create-2.0.jar', sha1: 'abc', size: 1,
    }],
    totalBytes: 1, skipped: [], lines: [],
  };
  const result = await applyUpdatePlan({ http: fakeHttp(), plan, modsDir });
  assert.equal(result.failed[0].reason, 'missing-old');
});

test('applyUpdatePlan 没给计划 / 没给下载对象 -> 明确报错', async () => {
  const { modsDir } = modsDirOf('apply-badargs');
  const http = fakeHttp();
  await assert.rejects(() => applyUpdatePlan({ http, plan: null, modsDir }), (e) => e.code === 'McNoPlan');
  await assert.rejects(() => applyUpdatePlan({ plan: { items: [] }, modsDir }), (e) => e.code === 'McNoHttp');
});

test('applyUpdatePlan 挡住把文件写到 mods 目录外面', async () => {
  const { root, modsDir } = modsDirOf('apply-escape');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('old'));
  const plan = {
    modsDir,
    items: [{
      name: 'evil', oldName: 'create.jar', oldPath: path.join(modsDir, 'create.jar'),
      disabledName: 'create.jar.disabled', newName: '..\\..\\evil.jar',
      newPath: path.resolve(modsDir, '..', '..', 'evil.jar'), fileName: 'evil.jar',
      fileUrl: 'https://cdn/evil.jar', sha1: '', size: 1,
    }],
    totalBytes: 1, skipped: [], lines: [],
  };
  const result = await applyUpdatePlan({ http: fakeHttp(), plan, modsDir });
  assert.equal(result.installed.length, 0);
  assert.equal(result.failed[0].reason, 'unsafe-name');
  assert.equal(fs.existsSync(path.join(root, 'evil.jar')), false);
});

// ————————————————————————— 人话 —————————————————————————

test('describeUpdateResult 说清楚「停用没删」和「旧版还在」', () => {
  const lines = describeUpdateResult({
    installed: [{ name: 'Create', latestVersion: '2.0', disabledName: 'create.jar.disabled' }],
    skipped: [],
    failed: [{ name: 'JEI', message: '镜像挂了' }],
  });
  assert.ok(lines.some((line) => line.includes('升级完成 1 个')));
  assert.ok(lines.some((line) => line.includes('没有删除')));
  assert.ok(lines.some((line) => line.includes('旧版都还在')));
});

// ————————————————————————— 锁定名单（2026-11-07 第二轮） —————————————————————————
// 锁定的 mod 照旧能查出来，但不算「能升」，也绝不会进升级清单。

test('checkModUpdates 锁定的 mod 标成 locked，不计入「能升」', async () => {
  const { modsDir } = modsDirOf('lock-check');
  const old = Buffer.from('old-create');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), old);
  const sha1 = sha1Of(old);
  const http = fakeHttp({ answers: { [sha1]: versionOf({ projectId: 'create', number: '2.0', bytes: 'new-bytes' }) } });
  const result = await checkModUpdates({
    http, modsDir, gameVersion: '1.21.1', loader: 'neoforge', channel: 'release',
    locked: [{ modId: 'create', projectId: 'create', fileName: 'create.jar' }],
  });
  assert.equal(result.scanned, 1);
  assert.equal(result.updates, 0, '锁定的 mod 不该算成「能升」');
  assert.equal(result.locked, 1);
  assert.equal(result.items[0].status, 'locked');
  assert.equal(result.items[0].locked, true);
  assert.ok(result.lines.some((line) => line.includes('已锁定')));
});

test('checkModUpdates 没锁的照旧能升', async () => {
  const { modsDir } = modsDirOf('lock-check-open');
  const old = Buffer.from('old-create');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), old);
  const sha1 = sha1Of(old);
  const http = fakeHttp({ answers: { [sha1]: versionOf({ projectId: 'create', number: '2.0', bytes: 'new-bytes' }) } });
  const result = await checkModUpdates({
    http, modsDir, gameVersion: '1.21.1', loader: 'neoforge', channel: 'release',
    locked: [{ modId: 'other-mod' }],
  });
  assert.equal(result.updates, 1);
  assert.equal(result.locked, 0);
  assert.equal(result.items[0].status, 'update');
});

test('buildUpdatePlan 锁定的 mod 直接跳过，理由写「已被锁定」', async () => {
  const { modsDir } = modsDirOf('lock-plan');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('old'));
  const item = updateItem();
  const plan = await buildUpdatePlan({
    check: checkOf([item], modsDir),
    modsDir,
    locked: [{ modId: 'create' }],
  });
  assert.equal(plan.items.length, 0, '锁定的 mod 不该进升级清单');
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, 'locked');
  assert.ok(plan.skipped[0].message.includes('已被锁定'));
});

test('锁定按 modId / projectId / 旧文件名都能认出来', async () => {
  const { modsDir } = modsDirOf('lock-match');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('old'));
  const item = updateItem();
  for (const lock of [
    { modId: 'create' },
    { projectId: 'create' },
    { fileName: 'create.jar' },
    { modId: 'CREATE' },
  ]) {
    const plan = await buildUpdatePlan({ check: checkOf([item], modsDir), modsDir, locked: [lock] });
    assert.equal(plan.items.length, 0, `这份锁定应该认出来：${JSON.stringify(lock)}`);
  }
});

// ————————————————————————— 一键撤回（2026-11-07 第二轮） —————————————————————————
// 撤回 = 新 jar 改名停用 + 旧 jar 改回原名，一个文件都不删。

test('buildRollbackPlan 用记录下来的停用名，不硬拼 .jar.disabled', async () => {
  const { modsDir } = modsDirOf('rb-plan');
  fs.writeFileSync(path.join(modsDir, 'create.jar.disabled-2'), Buffer.from('old'));
  fs.writeFileSync(path.join(modsDir, 'create-2.0.jar'), Buffer.from('new'));
  const result = {
    modsDir,
    installed: [{
      name: 'Create', oldName: 'create.jar', disabledName: 'create.jar.disabled-2',
      newName: 'create-2.0.jar',
    }],
  };
  const plan = await buildRollbackPlan({ result, modsDir });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].disabledName, 'create.jar.disabled-2');
  assert.equal(plan.items[0].oldName, 'create.jar');
  assert.ok(plan.lines.some((line) => line.includes('都不删')));
  // 只算不写
  assert.equal(fs.existsSync(path.join(modsDir, 'create.jar.disabled-2')), true);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-2.0.jar')), true);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-2.0.jar.rolled-back')), false);
});

test('buildRollbackPlan 缺升级结果 / 缺目录 -> 明确报错', async () => {
  await assert.rejects(() => buildRollbackPlan({ modsDir: 'x' }), (e) => e.code === 'McNoRollbackResult');
  await assert.rejects(() => buildRollbackPlan({ result: { installed: [] } }), (e) => e.code === 'McNoModsDir');
});

test('buildRollbackPlan 旧名被占了就跳过，绝不覆盖别人的文件', async () => {
  const { modsDir } = modsDirOf('rb-taken');
  fs.writeFileSync(path.join(modsDir, 'create.jar'), Buffer.from('别人的'));
  fs.writeFileSync(path.join(modsDir, 'create.jar.disabled'), Buffer.from('old'));
  fs.writeFileSync(path.join(modsDir, 'create-2.0.jar'), Buffer.from('new'));
  const plan = await buildRollbackPlan({
    result: { installed: [{ name: 'Create', oldName: 'create.jar', disabledName: 'create.jar.disabled', newName: 'create-2.0.jar' }] },
    modsDir,
  });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.skipped[0].reason, 'old-name-taken');
  assert.equal(fs.readFileSync(path.join(modsDir, 'create.jar'), 'utf8'), '别人的');
});

test('buildRollbackPlan 停用的旧文件不见了 -> 撤回不了，如实说', async () => {
  const { modsDir } = modsDirOf('rb-missing');
  fs.writeFileSync(path.join(modsDir, 'create-2.0.jar'), Buffer.from('new'));
  const plan = await buildRollbackPlan({
    result: { installed: [{ name: 'Create', oldName: 'create.jar', disabledName: 'create.jar.disabled', newName: 'create-2.0.jar' }] },
    modsDir,
  });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.skipped[0].reason, 'old-missing');
});

test('applyRollbackPlan 旧 jar 改回原名，新 jar 改名停用，一个文件都不删', async () => {
  const { modsDir } = modsDirOf('rb-apply');
  fs.writeFileSync(path.join(modsDir, 'create.jar.disabled'), Buffer.from('old'));
  fs.writeFileSync(path.join(modsDir, 'create-2.0.jar'), Buffer.from('new'));
  const result = {
    modsDir,
    installed: [{
      name: 'Create', oldName: 'create.jar', disabledName: 'create.jar.disabled',
      newName: 'create-2.0.jar', newPath: path.join(modsDir, 'create-2.0.jar'),
    }],
  };
  const plan = await buildRollbackPlan({ result, modsDir });
  const applied = await applyRollbackPlan({ plan, modsDir });
  assert.equal(applied.restored.length, 1);
  assert.equal(applied.failed.length, 0);
  // 旧 jar 回原名，内容还在
  assert.equal(fs.readFileSync(path.join(modsDir, 'create.jar'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(modsDir, 'create.jar.disabled')), false);
  // 新 jar 改名停用，没被删
  assert.equal(fs.existsSync(path.join(modsDir, 'create-2.0.jar')), false);
  assert.equal(fs.readFileSync(path.join(modsDir, 'create-2.0.jar.rolled-back'), 'utf8'), 'new');
  // 磁盘上文件总数没少
  assert.equal(fs.readdirSync(modsDir).length, 2);
});

test('applyRollbackPlan 没给计划 -> 明确报错', async () => {
  const { modsDir } = modsDirOf('rb-badargs');
  await assert.rejects(() => applyRollbackPlan({ plan: null, modsDir }), (e) => e.code === 'McNoPlan');
});

test('describeRollbackResult 说清楚「恢复了几个」和「没删文件」', () => {
  const lines = describeRollbackResult({
    restored: [{ name: 'Create', oldName: 'create.jar' }],
    failed: [{ name: 'JEI', message: '旧文件不见了' }],
  });
  assert.ok(lines.some((line) => line.includes('撤回完成 1 个')));
  assert.ok(lines.some((line) => line.includes('没有删除')));
  assert.ok(lines.some((line) => line.includes('还在')));
});
