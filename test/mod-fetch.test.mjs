/**
 * 联网层单测：全部用假 fetch，一个字节都不出去。
 *
 * 重点验三件事（真出事就是它们）：
 * 1. 5xx/429/网络抖动会重试，4xx 不重试；
 * 2. 官方不通时能退到镜像；
 * 3. 下载的文件 sha1 不对 / 大小不对时，绝不能留在 mods 目录里。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHttp, isNetworkFailure, safeHost } from '../packages/core/mod-fetch.js';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-net-${tag}-`));
}

/** 造一个可数的假 fetch：按顺序吐出预设的响应。 */
function scriptedFetch(steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = steps.length > 1 ? steps.shift() : steps[0];
    if (typeof step === 'function') return step(url, init);
    if (step instanceof Error) throw step;
    if (step && typeof step === 'object' && 'status' in step) {
      return new Response(step.body ?? '', { status: step.status, headers: step.headers ?? {} });
    }
    return new Response(JSON.stringify(step ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fn, calls };
}

function sha1Of(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

test('json 正常解析', async () => {
  const fake = scriptedFetch([{ hello: 'world' }]);
  const http = createHttp({ fetchImpl: fake.fetch, retries: 0 });
  assert.deepEqual(await http.json('https://api.modrinth.com/v2/search'), { hello: 'world' });
  assert.equal(fake.calls.length, 1);
  // 必须带 UA：Modrinth 没 UA 会 403。
  assert.match(fake.calls[0].init.headers['User-Agent'], /MCModpackStudio/);
});

test('5xx 会重试，最终成功', async () => {
  const fake = scriptedFetch([{ status: 500, body: 'boom' }, { ok: 1 }]);
  const http = createHttp({ fetchImpl: fake.fetch, retries: 2, backoffMs: 1 });
  assert.deepEqual(await http.json('https://api.modrinth.com/v2/search'), { ok: 1 });
  assert.equal(fake.calls.length, 2);
});

test('重试用完后抛 McHttpRetryable，并把状态码带出来', async () => {
  const fake = scriptedFetch([{ status: 503, body: 'down' }]);
  const http = createHttp({ fetchImpl: fake.fetch, retries: 1, backoffMs: 1, mirrorMode: 'off' });
  await assert.rejects(
    () => http.json('https://api.modrinth.com/v2/search'),
    (error) => error.code === 'McHttpRetryable' && error.status === 503,
  );
  assert.equal(fake.calls.length, 2);
});

test('404 不重试，直接给 McHttpNotFound', async () => {
  const fake = scriptedFetch([{ status: 404, body: '' }]);
  const http = createHttp({ fetchImpl: fake.fetch, retries: 3, backoffMs: 1, mirrorMode: 'off' });
  await assert.rejects(() => http.json('https://api.modrinth.com/v2/project/nope'), (error) => error.code === 'McHttpNotFound');
  assert.equal(fake.calls.length, 1);
});

test('网络错误会翻译成有 hint 的 McNetwork', async () => {
  const boom = Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
  const fake = scriptedFetch([boom]);
  const http = createHttp({ fetchImpl: fake.fetch, retries: 0 });
  await assert.rejects(
    () => http.json('https://api.modrinth.com/v2/search'),
    (error) => error.code === 'McNetwork' && error.hint.includes('手动'),
  );
  assert.equal(isNetworkFailure(boom), true);
});

test('官方不通时退到镜像（fallback 档）', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.modrinth.com')) {
      throw Object.assign(new TypeError('fetch failed'), { code: 'ENOTFOUND' });
    }
    return new Response(JSON.stringify({ via: 'mirror' }), { status: 200 });
  };
  const http = createHttp({ fetchImpl, retries: 0, mirrorMode: 'fallback' });
  assert.deepEqual(await http.json('https://api.modrinth.com/v2/search'), { via: 'mirror' });
  assert.equal(calls[0].includes('api.modrinth.com'), true);
  assert.equal(calls[1].includes('mod.mcimirror.top'), true);
});

test('mirrorMode:off 时只用官方，不碰镜像', async () => {
  const fake = scriptedFetch([{ ok: true }]);
  const http = createHttp({ fetchImpl: fake.fetch, retries: 0, mirrorMode: 'off' });
  await http.json('https://api.modrinth.com/v2/search');
  assert.equal(fake.calls.length, 1);
  assert.equal(http.candidateUrls('https://api.modrinth.com/v2/search').length, 1);
});

test('没配 CF key 时不发请求，直接给能看懂的失败', async () => {
  const fake = scriptedFetch([{ ok: true }]);
  const http = createHttp({ fetchImpl: fake.fetch, retries: 0, mirrorMode: 'off' });
  await assert.rejects(
    () => http.json('https://api.curseforge.com/v1/mods/search'),
    (error) => error.code === 'McNoCurseforgeKey' && error.hint.includes('console.curseforge.com'),
  );
  assert.equal(fake.calls.length, 0);
});

test('配了 CF key 才带 x-api-key', async () => {
  const fake = scriptedFetch([{ ok: true }]);
  const http = createHttp({ fetchImpl: fake.fetch, retries: 0, mirrorMode: 'off', curseforgeKey: 'k-123' });
  await http.json('https://api.curseforge.com/v1/mods/search');
  assert.equal(fake.calls[0].init.headers['x-api-key'], 'k-123');
});

test('downloadToFile 校验 sha1 通过才改名，且不留 .part', async () => {
  const dir = tmpDir('ok');
  const body = Buffer.from('fake-jar-bytes');
  const fetchImpl = async () => new Response(body, { status: 200 });
  const http = createHttp({ fetchImpl, retries: 0, mirrorMode: 'off' });
  const target = path.join(dir, 'mods', 'a.jar');
  const result = await http.downloadToFile('https://cdn.modrinth.com/a.jar', target, {
    sha1: sha1Of(body),
    size: body.length,
  });
  assert.equal(fs.readFileSync(target, 'utf8'), 'fake-jar-bytes');
  assert.equal(result.bytes, body.length);
  assert.equal(result.sha1, sha1Of(body));
  assert.equal(fs.existsSync(`${target}.part`), false);
});

test('sha1 不对时抛错，并且不留下任何文件', async () => {
  const dir = tmpDir('bad-hash');
  const body = Buffer.from('corrupted');
  const fetchImpl = async () => new Response(body, { status: 200 });
  const http = createHttp({ fetchImpl, retries: 0, mirrorMode: 'off' });
  const target = path.join(dir, 'a.jar');
  await assert.rejects(
    () => http.downloadToFile('https://cdn.modrinth.com/a.jar', target, { sha1: 'deadbeef' }),
    (error) => error.code === 'McDownloadHashMismatch',
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(`${target}.part`), false);
});

test('大小不对时也拒绝落盘', async () => {
  const dir = tmpDir('bad-size');
  const body = Buffer.from('12345');
  const fetchImpl = async () => new Response(body, { status: 200 });
  const http = createHttp({ fetchImpl, retries: 0, mirrorMode: 'off' });
  const target = path.join(dir, 'a.jar');
  await assert.rejects(
    () => http.downloadToFile('https://cdn.modrinth.com/a.jar', target, { size: 99 }),
    (error) => error.code === 'McDownloadSizeMismatch',
  );
  assert.equal(fs.existsSync(target), false);
});

test('下载 404 时给 McDownloadHttp，不写文件', async () => {
  const dir = tmpDir('404');
  const fetchImpl = async () => new Response('nope', { status: 404 });
  const http = createHttp({ fetchImpl, retries: 0, mirrorMode: 'off' });
  const target = path.join(dir, 'a.jar');
  await assert.rejects(
    () => http.downloadToFile('https://cdn.modrinth.com/a.jar', target),
    (error) => error.code === 'McDownloadHttp',
  );
  assert.equal(fs.existsSync(target), false);
});

test('下载失败会自动换下一个地址（官方挂了走镜像）', async () => {
  const dir = tmpDir('retry-mirror');
  const body = Buffer.from('mirrored');
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes('cdn.modrinth.com')) return new Response('gone', { status: 404 });
    return new Response(body, { status: 200 });
  };
  const http = createHttp({ fetchImpl, retries: 0, mirrorMode: 'fallback' });
  const target = path.join(dir, 'a.jar');
  const result = await http.downloadToFile('https://cdn.modrinth.com/a.jar', target, { sha1: sha1Of(body) });
  assert.equal(result.bytes, body.length);
  assert.equal(seen.length, 2);
  assert.equal(fs.existsSync(target), true);
});

test('safeHost 解析不出时返回空串', () => {
  assert.equal(safeHost('https://api.modrinth.com/x'), 'api.modrinth.com');
  assert.equal(safeHost('not a url'), '');
});