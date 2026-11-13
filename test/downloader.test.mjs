/**
 * 下载引擎单测：一个字节都不出去，全用假 fetch。
 *
 * 重点验四件事：
 * 1. 分段切得对（小文件不分段、大文件按 8 MB 切）；
 * 2. 分段真的按 Range 拼回原文件（sha1 对得上），且服务器不支持 Range 时能退回顺序下载；
 * 3. 连接池不会超发（这是「全局额度」的全部意义）；
 * 4. 慢/失败的分段会被拆开重下，而不是整条下载失败。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  createConnectionPool,
  createDownloader,
  isSignificantlySlow,
  parseContentRange,
  planSegments,
  SMALL_FILE_THRESHOLD,
  TARGET_SEGMENT_SIZE,
  SLOW_SPEED_BPS,
  CLEARLY_FAST_BPS,
} from '../packages/core/downloader.js';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-dl-${tag}-`));
}

function sha1Of(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

/** 造一个确定内容的假文件内容（不要全 0，避免掩盖偏移写错的问题）。 */
function makeBytes(size) {
  const buffer = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (i * 31 + 7) & 0xff;
  return buffer;
}

/**
 * 假服务器：支持 Range。
 * @param {Buffer} buffer
 * @param {{ignoreRange?: boolean, failFirst?: number, onRange?: Function}} [options]
 */
function rangeServer(buffer, options = {}) {
  const ranges = [];
  let remainingFailures = options.failFirst ?? 0;
  const fetchImpl = async (_url, init) => {
    const header = String(init?.headers?.Range ?? '');
    ranges.push(header);
    if (!header || options.ignoreRange) {
      return new Response(buffer, {
        status: 200,
        headers: { 'content-length': String(buffer.length) },
      });
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(header);
    assert.ok(match, `Range 头格式不对：${header}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw Object.assign(new Error('连接被重置'), { code: 'ECONNRESET' });
    }
    const slice = buffer.subarray(start, end + 1);
    options.onRange?.(start, end);
    return new Response(slice, {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${end}/${buffer.length}`,
        'content-length': String(slice.length),
      },
    });
  };
  return { fetchImpl, ranges };
}

test('planSegments：8 MB 一段，小文件不分段', () => {
  assert.deepEqual(planSegments(0), []);
  assert.deepEqual(planSegments(-1), []);
  const one = planSegments(SMALL_FILE_THRESHOLD - 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].start, 0);
  assert.equal(one[0].end, SMALL_FILE_THRESHOLD - 2);

  const total = TARGET_SEGMENT_SIZE * 2 + 1024;
  const many = planSegments(total);
  assert.equal(many.length, 3);
  assert.equal(many[0].start, 0);
  // PCL 的做法是先算段数、再把总长均分（不是「前几段正好 8 MB」），
  // 这样最后一段不会特别小。
  const expectedSize = Math.ceil(total / 3);
  assert.equal(many[0].end, expectedSize - 1);
  assert.equal(many[2].end, total - 1);
  // 首尾相接、不重不漏
  for (let i = 1; i < many.length; i += 1) {
    assert.equal(many[i].start, many[i - 1].end + 1);
  }
  const covered = many.reduce((sum, segment) => sum + (segment.end - segment.start + 1), 0);
  assert.equal(covered, total);
});

test('planSegments：超过上限时按上限切', () => {
  const total = TARGET_SEGMENT_SIZE * 2000;
  const segments = planSegments(total, { maxCount: 16 });
  assert.equal(segments.length, 16);
  assert.equal(segments[15].end, total - 1);
});

test('parseContentRange 解析三段式，坏格式返回 null', () => {
  assert.deepEqual(parseContentRange('bytes 0-99/1234'), { start: 0, end: 99, total: 1234 });
  assert.deepEqual(parseContentRange('  bytes 100-199/200  '), { start: 100, end: 199, total: 200 });
  assert.equal(parseContentRange('bytes */1234'), null);
  assert.equal(parseContentRange(''), null);
  assert.equal(parseContentRange(undefined), null);
});

test('isSignificantlySlow：PCL 那套防抖规则', () => {
  const base = { elapsedSeconds: 10, remaining: 8 * 1024 * 1024, ownRate: 10 * 1024 };

  // 别人都很快，自己只有 10KB/s → 慢
  assert.equal(isSignificantlySlow({ ...base, others: [CLEARLY_FAST_BPS * 4, CLEARLY_FAST_BPS * 5] }), true);
  // 跑的时间太短不判
  assert.equal(isSignificantlySlow({ ...base, elapsedSeconds: 3, others: [CLEARLY_FAST_BPS * 4] }), false);
  // 剩余量太小不判
  assert.equal(isSignificantlySlow({ ...base, remaining: 1024, others: [CLEARLY_FAST_BPS * 4] }), false);
  // 设了限速不判
  assert.equal(isSignificantlySlow({ ...base, speedLimit: 1024, others: [CLEARLY_FAST_BPS * 4] }), false);
  // 大家一样慢（源限速）不判 —— 这就是那条防抖注释要防的事
  assert.equal(isSignificantlySlow({ ...base, others: [12 * 1024, 9 * 1024] }), false);
  // 没有别的采样不判
  assert.equal(isSignificantlySlow({ ...base, others: [] }), false);
  // 自己也不慢
  assert.equal(isSignificantlySlow({ ...base, ownRate: SLOW_SPEED_BPS * 10, others: [CLEARLY_FAST_BPS * 4] }), false);
});

test('连接池：绝不超发，且排队的人最后都能拿到', async () => {
  const pool = createConnectionPool({ limit: 3 });
  const leases = await Promise.all([1, 2, 3].map((n) => pool.acquire(`https://cdn.modrinth.com/${n}`)));
  assert.equal(pool.active, 3);

  let fourth = null;
  const pending = pool.acquire('https://cdn.modrinth.com/4').then((lease) => {
    fourth = lease;
    return lease;
  });
  // 名额满了，第四个必须排队
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fourth, null);
  assert.equal(pool.pending, 1);

  leases[0].release();
  await pending;
  assert.ok(fourth, '释放一个名额后，排队的人应该拿到');
  assert.equal(pool.active, 3);
  assert.equal(pool.peak, 3);

  fourth.release();
  leases[1].release();
  leases[2].release();
  assert.equal(pool.active, 0);
});

test('连接池：同一个 lease 重复 release 不会把计数搞坏', async () => {
  const pool = createConnectionPool({ limit: 2 });
  const lease = await pool.acquire('https://cdn.modrinth.com/a');
  lease.release();
  lease.release();
  assert.equal(pool.active, 0);
});

test('分段下载：按 Range 拼回原文件，sha1 对得上', async () => {
  const dir = tmpDir('seg');
  const body = makeBytes(64 * 1024);
  const server = rangeServer(body);
  const downloader = createDownloader({
    fetchImpl: server.fetchImpl,
    pool: createConnectionPool({ limit: 8 }),
    segmentThreshold: 1024,
    targetSegmentSize: 16 * 1024,
    enableSegments: true,
  });

  const target = path.join(dir, 'mods', 'a.jar');
  const result = await downloader.download(['https://cdn.modrinth.com/a.jar'], target, {
    size: body.length,
    sha1: sha1Of(body),
  });

  assert.equal(result.mode, 'segmented');
  assert.equal(result.segments, 4);
  assert.equal(result.bytes, body.length);
  assert.equal(fs.readFileSync(target).equals(body), true);
  assert.equal(fs.existsSync(`${target}.part`), false);
  // 4 段都走了 Range
  assert.equal(server.ranges.length, 4);
});

test('分段下载：服务器不支持 Range（回 200）时退回顺序下载', async () => {
  const dir = tmpDir('norange');
  const body = makeBytes(48 * 1024);
  const server = rangeServer(body, { ignoreRange: true });
  const downloader = createDownloader({
    fetchImpl: server.fetchImpl,
    pool: createConnectionPool({ limit: 4 }),
    segmentThreshold: 1024,
    targetSegmentSize: 16 * 1024,
  });

  const target = path.join(dir, 'a.jar');
  const result = await downloader.download(['https://cdn.modrinth.com/a.jar'], target, {
    size: body.length,
    sha1: sha1Of(body),
  });

  assert.equal(result.mode, 'sequential');
  assert.equal(fs.readFileSync(target).equals(body), true);
});

test('分段下载：某个分段失败一次会拆开重下，最终仍然完整', async () => {
  const dir = tmpDir('split');
  const body = makeBytes(64 * 1024);
  const server = rangeServer(body, { failFirst: 1 });
  const downloader = createDownloader({
    fetchImpl: server.fetchImpl,
    pool: createConnectionPool({ limit: 8 }),
    segmentThreshold: 1024,
    targetSegmentSize: 32 * 1024,
    splitThreshold: 1024,
  });

  const target = path.join(dir, 'a.jar');
  const result = await downloader.download(['https://cdn.modrinth.com/a.jar'], target, {
    size: body.length,
    sha1: sha1Of(body),
  });

  assert.ok(result.splits >= 1, `应该发生过分裂，实际 splits=${result.splits}`);
  assert.equal(fs.readFileSync(target).equals(body), true);
});

test('分段下载：sha1 不对时不落盘、不留 .part', async () => {
  const dir = tmpDir('badhash');
  const body = makeBytes(64 * 1024);
  const server = rangeServer(body);
  const downloader = createDownloader({
    fetchImpl: server.fetchImpl,
    pool: createConnectionPool({ limit: 8 }),
    segmentThreshold: 1024,
    targetSegmentSize: 16 * 1024,
  });

  const target = path.join(dir, 'a.jar');
  await assert.rejects(
    () => downloader.download(['https://cdn.modrinth.com/a.jar'], target, { size: body.length, sha1: 'deadbeef' }),
    (error) => error.code === 'McDownloadHashMismatch',
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(`${target}.part`), false);
});

test('小文件不分段（走顺序下载，只发一次请求）', async () => {
  const dir = tmpDir('small');
  const body = makeBytes(2048);
  const server = rangeServer(body);
  const pool = createConnectionPool({ limit: 4 });
  const downloader = createDownloader({
    fetchImpl: server.fetchImpl,
    pool,
    segmentThreshold: 1024 * 1024,
  });

  const target = path.join(dir, 'a.jar');
  const result = await downloader.download(['https://cdn.modrinth.com/a.jar'], target, { size: body.length });
  assert.equal(result.mode, 'sequential');
  assert.equal(server.ranges.length, 1);
  assert.equal(server.ranges[0], '');
  // 顺序下载也必须占连接名额，否则并发下小文件时会绕开全局额度。
  assert.equal(pool.acquired, 1);
  assert.equal(pool.active, 0);
});

test('顺序下载也受全局额度限制（并发小文件不会绕开连接池）', async () => {
  const dir = tmpDir('small-pool');
  const body = makeBytes(1024);
  const server = rangeServer(body);
  const pool = createConnectionPool({ limit: 2 });
  const downloader = createDownloader({
    fetchImpl: server.fetchImpl,
    pool,
    segmentThreshold: 1024 * 1024,
  });

  await Promise.all(
    [0, 1, 2, 3, 4].map((n) =>
      downloader.download([`https://cdn.modrinth.com/${n}.jar`], path.join(dir, `${n}.jar`), { size: body.length }),
    ),
  );

  assert.ok(pool.peak <= 2, `峰值 ${pool.peak} 超过了额度 2`);
  assert.equal(pool.active, 0);
  assert.equal(fs.readdirSync(dir).length, 5);
});

test('全局连接池：两个文件同时下，总连接数不超过额度', async () => {
  const pool = createConnectionPool({ limit: 4 });
  const bodyA = makeBytes(64 * 1024);
  const bodyB = makeBytes(64 * 1024);
  const serverA = rangeServer(bodyA);
  const serverB = rangeServer(bodyB);

  const downloaderA = createDownloader({
    fetchImpl: serverA.fetchImpl,
    pool,
    segmentThreshold: 1024,
    targetSegmentSize: 8 * 1024,
    perFileConnections: 4,
  });
  const downloaderB = createDownloader({
    fetchImpl: serverB.fetchImpl,
    pool,
    segmentThreshold: 1024,
    targetSegmentSize: 8 * 1024,
    perFileConnections: 4,
  });

  const dir = tmpDir('pool');
  await Promise.all([
    downloaderA.download(['https://cdn.modrinth.com/a.jar'], path.join(dir, 'a.jar'), { size: bodyA.length }),
    downloaderB.download(['https://cdn.modrinth.com/b.jar'], path.join(dir, 'b.jar'), { size: bodyB.length }),
  ]);

  assert.ok(pool.peak <= 4, `峰值连接数 ${pool.peak} 超过了额度 4`);
  assert.equal(fs.readFileSync(path.join(dir, 'a.jar')).equals(bodyA), true);
  assert.equal(fs.readFileSync(path.join(dir, 'b.jar')).equals(bodyB), true);
});

test('分段下载：分段写错位置会被 sha1 抓出来', async () => {
  // 这个用例防的是「乱序写偏移算错」——那种 bug 不会报错，只会悄悄下坏文件。
  const dir = tmpDir('offset');
  const body = makeBytes(32 * 1024);
  // 故意把每段的响应内容整体错开 1 字节
  const fetchImpl = async (_url, init) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(init?.headers?.Range ?? ''));
    const start = Number(match[1]);
    const end = Number(match[2]);
    const slice = body.subarray(start, end + 1);
    const wrong = Buffer.from(slice);
    if (wrong.length > 1) {
      wrong[0] = (wrong[0] + 1) & 0xff;
    }
    return new Response(wrong, {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': String(wrong.length) },
    });
  };
  const downloader = createDownloader({
    fetchImpl,
    pool: createConnectionPool({ limit: 4 }),
    segmentThreshold: 1024,
    targetSegmentSize: 8 * 1024,
  });

  const target = path.join(dir, 'a.jar');
  await assert.rejects(
    () => downloader.download(['https://cdn.modrinth.com/a.jar'], target, { size: body.length, sha1: sha1Of(body) }),
    (error) => error.code === 'McDownloadHashMismatch',
  );
});
