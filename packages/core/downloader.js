/**
 * 下载引擎：分段并行 + 全局连接池 + 慢分段自动分裂。
 *
 * 这套设计是照着 PCL 的 `ref/pcl-ce/AdaptiveRangeDownloader.cs` 与
 * `ref/pcl-ce/DownloadResourceManager.cs` 抄的，因为它确实是「快」的来源：
 *
 * 1. **小文件不分段**（< 4 MB）。分段要先发探测请求问「你支持 Range 吗」，
 *    小文件这么干反而多一个来回。PCL 用 `SmallFileThreshold = 4MB`。
 * 2. **大文件切成 8 MB 一段**，最多 8 条连接同时下同一个文件。
 * 3. **慢分段自动分裂**：不预设「开几条连接合适」，而是边下边测——某条连接
 *    速度明显低于其它连接的中位数，就把它的剩余部分一分为二，重新排队给
 *    空闲 worker 抢。所有连接都被源限速时不会一起反复重启（有防抖判断）。
 * 4. **全局连接池**：所有下载任务共抢一个连接额度（默认 64），而不是「每个
 *    文件固定几条」。这样下几百个库文件时吞吐是全局最优的。
 *
 * 落盘策略和原来一致：先写 `.part`，校验大小和 sha1 通过才 rename。
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { McError } from './errors.js';
import { isLocalWriteFailure, asLocalWriteFailure, isNetworkFailure, describeNetworkFailure, safeHost, sleep, stalledDownload } from './net-errors.js';

/** 小于这个大小就不分段（多一个 Range 探测往返反而更慢）。 */
export const SMALL_FILE_THRESHOLD = 4 * 1024 * 1024;

/** 每段的目标大小。 */
export const TARGET_SEGMENT_SIZE = 8 * 1024 * 1024;

/** 初始最多切多少段。 */
export const MAX_SEGMENT_COUNT = 1024;

/** 分裂之后最多允许多少段（防止极端情况无限裂）。 */
export const MAX_EXPANDED_SEGMENT_COUNT = MAX_SEGMENT_COUNT * 2;

/** 分段读的「卡住」阈值：这么久没有新字节就认为这条连接废了。 */
export const READ_TIMEOUT_MS = 15_000;

/** 至少要跑了这么久才判断「慢」（太早判断会误杀正在起步的连接）。 */
export const SLOW_CHECK_SECONDS = 8;

/** 绝对慢：低于这个速度才考虑重开。 */
export const SLOW_SPEED_BPS = 50 * 1024;

/** 「明显更快」的门槛：比这慢的连接才值得比。 */
export const CLEARLY_FAST_BPS = 128 * 1024;

/** 剩余量够大才值得分裂（太小了拆开反而更亏）。 */
export const SLOW_SPLIT_THRESHOLD = 2 * 1024 * 1024;

/** 剩余量低于这个值就不再重启连接。 */
export const MIN_RESTART_REMAINING = 1 * 1024 * 1024;

/** 单个分段最多重试几次。 */
export const MAX_SEGMENT_RETRIES = 2;

/** 全局连接额度默认值（PCL 同款 64）。 */
export const DEFAULT_CONNECTION_LIMIT = 64;

/** 单文件最多几条连接（PCL 硬上限也是 8）。 */
export const DEFAULT_PER_FILE_CONNECTIONS = 8;

/** 连接额度硬上限。 */
export const MAX_CONNECTION_LIMIT = 256;

// ---------------------------------------------------------------------------
// 连接池
// ---------------------------------------------------------------------------

/**
 * 建一个连接池：所有下载任务共抢 `limit` 个名额。
 *
 * 和 PCL 的 `AsyncQuota` 一个意思，只是简单些（没做按主机细分的动态调整，
 * 但留了 `perHostLimit` 这个口子）。
 */
export function createConnectionPool(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit ?? DEFAULT_CONNECTION_LIMIT) || DEFAULT_CONNECTION_LIMIT, MAX_CONNECTION_LIMIT));
  const perHostLimit = Math.max(1, Number(options.perHostLimit ?? MAX_CONNECTION_LIMIT) || MAX_CONNECTION_LIMIT);

  let active = 0;
  let peak = 0;
  let acquired = 0;
  const hostActive = new Map();
  const waiters = [];

  function canStart(host) {
    return active < limit && (hostActive.get(host) ?? 0) < perHostLimit;
  }

  function makeLease(host) {
    let released = false;
    return {
      host,
      release() {
        if (released) return;
        released = true;
        active -= 1;
        const next = (hostActive.get(host) ?? 1) - 1;
        if (next <= 0) hostActive.delete(host);
        else hostActive.set(host, next);
        drain();
      },
    };
  }

  function takeSlot(host) {
    active += 1;
    acquired += 1;
    if (active > peak) peak = active;
    hostActive.set(host, (hostActive.get(host) ?? 0) + 1);
    return makeLease(host);
  }

  function drain() {
    for (let index = 0; index < waiters.length; ) {
      const waiter = waiters[index];
      if (canStart(waiter.host)) {
        waiters.splice(index, 1);
        waiter.resolve(takeSlot(waiter.host));
      } else {
        index += 1;
      }
    }
  }

  return {
    /** 抢一个名额；抢不到就排队，绝不超发。 */
    acquire(url) {
      const host = safeHost(url) || '(unknown)';
      if (canStart(host)) return Promise.resolve(takeSlot(host));
      return new Promise((resolve) => {
        waiters.push({ host, resolve });
      });
    },
    get limit() {
      return limit;
    },
    get active() {
      return active;
    },
    get pending() {
      return waiters.length;
    },
    get peak() {
      return peak;
    },
    get acquired() {
      return acquired;
    },
    stats() {
      return { active, pending: waiters.length, peak, limit, acquired };
    },
  };
}

/** 进程级默认连接池：面板和工具都共用这一个，才叫「全局」。 */
let globalPool = null;

/**
 * 拿全局连接池。
 *
 * 额度可以用环境变量 `MCSTUDIO_CONNECTIONS` 调（1–256）。默认 64 是 PCL 的默认值：
 * 国内宽带下这个数字够用又不会把线路挤死；线路很好可以调到 128，很差不稳定就调小。
 */
export function getGlobalPool() {
  if (!globalPool) {
    const fromEnv = Number(process.env?.MCSTUDIO_CONNECTIONS ?? 0);
    const limit = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_CONNECTION_LIMIT;
    globalPool = createConnectionPool({ limit });
  }
  return globalPool;
}

export function setGlobalPool(pool) {
  globalPool = pool ?? null;
}

export function resetGlobalPool() {
  globalPool = null;
}

// ---------------------------------------------------------------------------
// 纯逻辑（好测）
// ---------------------------------------------------------------------------

/**
 * 把一个文件切成若干段。
 *
 * @param {number} totalSize
 * @param {{targetSize?: number, maxCount?: number}} [options]
 * @returns {Array<{id:number,start:number,end:number,done:number,failureCount:number}>}
 */
export function planSegments(totalSize, options = {}) {
  const total = Number(totalSize);
  if (!Number.isFinite(total) || total <= 0) return [];
  const targetSize = Number(options.targetSize ?? TARGET_SEGMENT_SIZE) || TARGET_SEGMENT_SIZE;
  const maxCount = Number(options.maxCount ?? MAX_SEGMENT_COUNT) || MAX_SEGMENT_COUNT;
  const count = Math.min(Math.max(Math.ceil(total / targetSize), 1), maxCount);
  const size = Math.ceil(total / count);
  const segments = [];
  let id = 0;
  for (let start = 0; start < total; start += size) {
    segments.push({
      id: (id += 1),
      start,
      end: Math.min(total - 1, start + size - 1),
      done: 0,
      failureCount: 0,
    });
  }
  return segments;
}

/**
 * 判断一条连接是不是「明显比别的慢」——慢到值得拆开重下。
 *
 * 直接翻译 PCL 的 `IsSignificantlySlow`（`AdaptiveRangeDownloader.cs:375`）：
 * - 用户设了限速就不判（否则会自己跟自己打架）；
 * - 剩余量太小不判；
 * - 跑的时间太短不判；
 * - 自己的速度不到别人中位数 / 最快值的 1/4，才算慢。
 *
 * 之所以要「有别人明显更快」这个前提：如果整条线路都被源限速，那拆开也没用，
 * 反而会让所有分段一起反复重启。
 */
export function isSignificantlySlow(options = {}) {
  const ownRate = Number(options.ownRate ?? 0);
  const elapsedSeconds = Number(options.elapsedSeconds ?? 0);
  const remaining = Number(options.remaining ?? 0);
  const speedLimit = Number(options.speedLimit ?? 0);

  if (speedLimit > 0) return false;
  if (remaining < MIN_RESTART_REMAINING) return false;
  if (elapsedSeconds < SLOW_CHECK_SECONDS) return false;

  let rates = (options.others ?? []).map(Number).filter((rate) => Number.isFinite(rate) && rate > 0);
  if (rates.length === 0) {
    rates = (options.completedRates ?? []).map(Number).filter((rate) => Number.isFinite(rate) && rate > 0);
  }
  if (rates.length === 0) return false;

  rates = [...rates].sort((a, b) => a - b);
  const median = rates[Math.floor(rates.length / 2)];
  const fastest = rates[rates.length - 1];
  const hasClearlyFaster = fastest >= CLEARLY_FAST_BPS && ownRate * 4 < fastest;
  const relativelySlow = median >= CLEARLY_FAST_BPS && ownRate * 4 < median;
  const absolutelySlow = ownRate < SLOW_SPEED_BPS && hasClearlyFaster;
  return relativelySlow || absolutelySlow;
}

/** 解析 `Content-Range: bytes 0-99/1234`。 */
export function parseContentRange(value) {
  const text = String(value ?? '').trim();
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(text);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

// ---------------------------------------------------------------------------
// 内部错误
// ---------------------------------------------------------------------------

/** 分段这条连接可以重试（超时、慢、读了一半断了）。 */
class SegmentRetry extends Error {
  constructor(message) {
    super(message);
    this.name = 'SegmentRetry';
  }
}

/** 服务器不支持可靠的 Range，整段退回顺序下载。 */
class RangeUnsupported extends Error {
  constructor(message) {
    super(message);
    this.name = 'RangeUnsupported';
  }
}

// ---------------------------------------------------------------------------
// 下载器
// ---------------------------------------------------------------------------

/**
 * 建一个下载器。一个实例通常被一个 `createHttp()` 持有，但连接池默认是全局的。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.userAgent]
 * @param {number} [options.timeoutMs] 顺序下载的卡住阈值
 * @param {number} [options.retries]
 * @param {number} [options.backoffMs]
 * @param {object} [options.pool] 连接池；不传用全局的
 * @param {number} [options.perFileConnections] 单文件最多几条连接
 * @param {(url:string)=>object} [options.headerForDownload]
 * @param {number} [options.segmentThreshold] 超过多大才分段
 * @param {boolean} [options.enableSegments] 总开关（测试用）
 */
export function createDownloader(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new McError('当前环境没有 fetch，无法联网', '需要 Node 20.18 以上', 'McNoFetch');
  }
  const userAgent = options.userAgent ?? 'DSH-MCModpackStudio/0.1 (Minecraft modpack studio)';
  const timeoutMs = Number(options.timeoutMs ?? 30_000);
  const retries = Math.max(0, Number(options.retries ?? 2));
  const backoffMs = Math.max(0, Number(options.backoffMs ?? 300));
  const pool = options.pool ?? getGlobalPool();
  const perFileConnections = Math.max(1, Math.min(Number(options.perFileConnections ?? DEFAULT_PER_FILE_CONNECTIONS) || DEFAULT_PER_FILE_CONNECTIONS, DEFAULT_PER_FILE_CONNECTIONS));
  const headerForDownload = options.headerForDownload ?? (() => ({}));
  const segmentThreshold = Number(options.segmentThreshold ?? SMALL_FILE_THRESHOLD) || SMALL_FILE_THRESHOLD;
  const targetSegmentSize = Number(options.targetSegmentSize ?? TARGET_SEGMENT_SIZE) || TARGET_SEGMENT_SIZE;
  const splitThreshold = Number(options.splitThreshold ?? SLOW_SPLIT_THRESHOLD) || SLOW_SPLIT_THRESHOLD;
  const enableSegments = options.enableSegments !== false;

  /** 顺序下载的卡住阈值：不能按总时长算，18 MB 的 mod 在慢线路上本来就超 30 秒。 */
  const idleMs = Math.max(timeoutMs, 60_000);

  /**
   * 把文件下到 destPath。
   *
   * @param {string[]} urls 候选地址（已按镜像偏好排好序）
   * @param {string} destPath
   * @param {{sha1?:string, size?:number, onProgress?:Function, signal?:AbortSignal}} [expect]
   */
  async function download(urls, destPath, expect = {}) {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    if (list.length === 0) throw new McError('没有可用的下载地址', '', 'McNoDownload');

    let lastError;
    for (const url of list) {
      try {
        return await downloadOne(url, destPath, expect);
      } catch (error) {
        lastError = error;
        // 本地写不进去就立刻放弃，换地址也没用。
        if (isLocalWriteFailure(error)) throw asLocalWriteFailure(error);
        // 用户主动取消，别再试下一个地址。
        if (error?.name === 'AbortError') throw error;
      }
    }
    throw lastError ?? new McError('下载没有开始', '', 'McNoDownload');
  }

  async function downloadOne(url, destPath, expect) {
    const target = path.resolve(destPath);
    const tempPath = `${target}.part`;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rm(tempPath, { force: true });

    const expectedSize = Number(expect.size ?? 0) || 0;
    let result;

    try {
      if (enableSegments && expectedSize >= segmentThreshold) {
        result = await trySegmented(url, tempPath, expectedSize, expect);
      }
      if (!result) {
        result = await sequential(url, tempPath, expect);
      }
    } catch (error) {
      await fsp.rm(tempPath, { force: true });
      throw error;
    }

    // ---- 校验（两种模式共用） ----
    const bytes = result.bytes;
    const digest = result.sha1;

    if (expectedSize && bytes !== expectedSize) {
      await fsp.rm(tempPath, { force: true });
      throw new McError(
        `文件大小不对：应为 ${expectedSize} 字节，实收 ${bytes} 字节`,
        '文件可能被替换或下错版本了。',
        'McDownloadSizeMismatch',
      );
    }
    if (expect.sha1 && String(digest).toLowerCase() !== String(expect.sha1).toLowerCase()) {
      await fsp.rm(tempPath, { force: true });
      throw new McError(
        `下载文件校验失败：应得 sha1 ${expect.sha1}，实得 ${digest}`,
        '文件在传输中坏了，或者源站换了文件。重试一次；再失败就手动下载。',
        'McDownloadHashMismatch',
      );
    }

    await fsp.rename(tempPath, target);
    return {
      path: target,
      bytes,
      sha1: digest,
      url,
      mode: result.mode,
      segments: result.segments ?? 1,
      splits: result.splits ?? 0,
    };
  }

  // ---- 顺序下载（小文件、或不支持 Range 时） ----

  /**
   * 顺序下载也要占一个连接名额 —— 否则同时下几百个小库文件时，
   * 这条路径会绕开全局额度，把线路挤死（PCL 的 DownloadSequentiallyAsync 同样走配额）。
   */
  async function sequential(url, tempPath, expect) {
    const lease = await pool.acquire(url);
    try {
      return await sequentialInner(url, tempPath, expect);
    } finally {
      lease.release();
    }
  }

  async function sequentialInner(url, tempPath, expect) {
    const guard = makeIdleGuard(idleMs, expect.signal);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { 'User-Agent': userAgent, Accept: '*/*', ...headerForDownload(url) },
        signal: guard.signal,
      });
    } catch (error) {
      guard.dispose();
      if (guard.stalled) throw stalledDownload(url, idleMs);
      if (isNetworkFailure(error)) throw describeNetworkFailure(error);
      throw error;
    }
    if (!response.ok) {
      guard.dispose();
      throw new McError(
        `下载失败：服务器返回 ${response.status}`,
        '这个文件可能已经下架，或者镜像不通。可以换官方/镜像再试，或手动下载。',
        'McDownloadHttp',
      );
    }

    const contentLength = Number(response.headers?.get?.('content-length') ?? 0) || 0;
    const total = contentLength || Number(expect.size ?? 0) || 0;
    const hash = createHash('sha1');
    let received = 0;
    try {
      const body = response.body;
      if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
        // 假响应可能只给 arrayBuffer（单测里就这样）。
        const buffer = Buffer.from(await response.arrayBuffer());
        hash.update(buffer);
        received = buffer.length;
        await fsp.writeFile(tempPath, buffer);
      } else {
        const teeing = new Transform({
          transform(chunk, _encoding, callback) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(buffer);
            received += buffer.length;
            guard.touch();
            expect.onProgress?.({ received, total });
            callback(null, buffer);
          },
        });
        await pipeline(Readable.from(body), teeing, createWriteStream(tempPath));
      }
    } catch (error) {
      if (guard.stalled) throw stalledDownload(url, idleMs);
      if (error instanceof McError) throw error;
      if (isLocalWriteFailure(error)) throw asLocalWriteFailure(error);
      if (isNetworkFailure(error)) throw describeNetworkFailure(error);
      throw error;
    } finally {
      guard.dispose();
    }

    if (contentLength > 0 && received !== contentLength) {
      throw new McError(
        `下载不完整：应得 ${contentLength} 字节，实收 ${received} 字节`,
        '网络可能中途断了。重试即可；一直这样就换镜像或手动下载。',
        'McDownloadTruncated',
      );
    }

    return { bytes: received, sha1: hash.digest('hex'), mode: 'sequential', segments: 1, splits: 0 };
  }

  // ---- 分段并行下载 ----

  /** 试一下分段；服务器不支持 Range 就返回 null，让调用方退回顺序下载。 */
  async function trySegmented(url, tempPath, totalSize, expect) {
    const initial = planSegments(totalSize, { targetSize: targetSegmentSize });
    if (initial.length <= 1) return null;

    const handle = await fsp.open(tempPath, 'w+');
    try {
      await handle.truncate(totalSize);

      const ctx = {
        url,
        handle,
        totalSize,
        queue: initial.slice(),
        outstanding: initial.length,
        nextId: initial.length,
        downloaded: 0,
        splits: 0,
        rates: new Map(),
        completedRates: [],
        lastProgressAt: 0,
        onProgress: expect.onProgress,
        signal: expect.signal,
      };

      await runWorkers(ctx);
      await handle.sync().catch(() => {});
      const sha1 = await sha1OfFile(tempPath);
      return { bytes: ctx.downloaded, sha1, mode: 'segmented', segments: initial.length, splits: ctx.splits };
    } catch (error) {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      if (error instanceof RangeUnsupported) return null;
      throw error;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function runWorkers(ctx) {
    const waiters = [];
    const notify = () => {
      const list = waiters.splice(0);
      for (const resolve of list) resolve();
    };
    ctx.notify = notify;

    const take = async () => {
      for (;;) {
        if (ctx.failure) return null;
        if (ctx.queue.length > 0) return ctx.queue.shift();
        if (ctx.outstanding <= 0) return null;
        await new Promise((resolve) => waiters.push(resolve));
      }
    };

    const worker = async () => {
      for (;;) {
        const segment = await take();
        if (!segment) return;
        try {
          await downloadSegment(segment, ctx);
          if (segment.done >= segment.end - segment.start + 1) {
            ctx.outstanding -= 1;
            if (ctx.outstanding === 0) notify();
          }
        } catch (error) {
          if (ctx.failure) return;
          if (error instanceof RangeUnsupported) {
            ctx.failure = error;
            notify();
            return;
          }
          if (!recoverSegment(segment, error, ctx)) {
            ctx.failure = error;
            notify();
            return;
          }
          await sleep(250 + Math.random() * 750);
        }
      }
    };

    const count = Math.min(ctx.queue.length, perFileConnections);
    await Promise.all(Array.from({ length: count }, () => worker()));
    if (ctx.failure) throw ctx.failure;
    if (ctx.downloaded !== ctx.totalSize) {
      throw new McError(
        `分段下载不完整：已写入 ${ctx.downloaded}，应为 ${ctx.totalSize}`,
        '网络可能中途断了。重试即可。',
        'McDownloadTruncated',
      );
    }
  }

  function recoverSegment(segment, error, ctx) {
    if (error?.name === 'AbortError') return false;
    if (segment.failureCount >= MAX_SEGMENT_RETRIES) return false;
    const remaining = segment.end - segment.start - segment.done + 1;
    if (remaining <= 0) return false;
    segment.failureCount += 1;

    if (remaining >= splitThreshold && ctx.nextId < MAX_EXPANDED_SEGMENT_COUNT) {
      const splitStart = segment.start + segment.done + Math.floor(remaining / 2);
      if (splitStart > segment.start + segment.done && splitStart <= segment.end) {
        const split = { id: (ctx.nextId += 1), start: splitStart, end: segment.end, done: 0, failureCount: 0 };
        segment.end = splitStart - 1;
        ctx.queue.push(segment, split);
        ctx.outstanding += 1;
        ctx.splits += 1;
        ctx.notify();
        return true;
      }
    }

    ctx.queue.push(segment);
    ctx.notify();
    return true;
  }

  async function downloadSegment(segment, ctx) {
    const lease = await pool.acquire(ctx.url);
    const guard = makeIdleGuard(READ_TIMEOUT_MS, ctx.signal);
    const startedAt = Date.now();
    let attemptBytes = 0;
    try {
      const from = segment.start + segment.done;
      const headers = {
        ...headerForDownload(ctx.url),
        Range: `bytes=${from}-${segment.end}`,
        'Accept-Encoding': 'identity',
      };
      let response;
      try {
        response = await fetchImpl(ctx.url, { method: 'GET', headers, signal: guard.signal });
      } catch (error) {
        if (guard.stalled) throw new SegmentRetry('等待分段数据超时');
        throw error;
      }

      if (response.status !== 206) {
        throw new RangeUnsupported(`服务器没按 Range 返回（状态码 ${response.status}）`);
      }
      const range = parseContentRange(response.headers?.get?.('content-range'));
      if (!range || range.start !== from || range.end !== segment.end || range.total !== ctx.totalSize) {
        throw new RangeUnsupported('Content-Range 和请求的分段对不上');
      }

      const body = response.body;
      if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
        throw new SegmentRetry('分段响应没有可读的数据流');
      }

      segment.startedAt = startedAt;
      segment.attemptBytes = 0;
      segment.lastSampleAt = startedAt;

      for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = segment.end - segment.start - segment.done + 1;
        if (remaining <= 0) break;
        const take = Math.min(buffer.length, remaining);
        await ctx.handle.write(buffer, 0, take, segment.start + segment.done);
        segment.done += take;
        attemptBytes += take;
        ctx.downloaded += take;
        guard.touch();
        reportProgress(ctx);
        maybeCheckSlow(segment, ctx);
        if (segment.done >= segment.end - segment.start + 1) break;
      }

      if (segment.done < segment.end - segment.start + 1) {
        throw new SegmentRetry(`分段提前结束，还剩 ${segment.end - segment.start - segment.done + 1} 字节`);
      }
      recordRate(ctx, attemptBytes, startedAt);
    } finally {
      guard.dispose();
      lease.release();
    }
  }

  function maybeCheckSlow(segment, ctx) {
    const now = Date.now();
    if (now - (segment.lastSampleAt ?? 0) < 500) return;
    segment.lastSampleAt = now;

    const elapsedSeconds = (now - (segment.startedAt ?? now)) / 1000;
    const ownRate = segment.attemptBytes / Math.max(0.001, elapsedSeconds);
    ctx.rates.set(segment.id, { rate: ownRate, at: now });

    const others = [];
    for (const [id, sample] of ctx.rates) {
      if (id === segment.id) continue;
      if (now - sample.at > 2000) continue;
      others.push(sample.rate);
    }

    const remaining = segment.end - segment.start - segment.done + 1;
    if (isSignificantlySlow({ ownRate, elapsedSeconds, remaining, others, completedRates: ctx.completedRates })) {
      throw new SegmentRetry('这条连接明显比别的慢，拆开重下');
    }
  }

  function recordRate(ctx, attemptBytes, startedAt) {
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    ctx.completedRates.push(attemptBytes / elapsedSeconds);
    while (ctx.completedRates.length > 8) ctx.completedRates.shift();
  }

  function reportProgress(ctx) {
    const now = Date.now();
    if (now - ctx.lastProgressAt < 200) return;
    ctx.lastProgressAt = now;
    ctx.onProgress?.({ received: ctx.downloaded, total: ctx.totalSize });
  }

  return {
    download,
    pool,
    config: { perFileConnections, segmentThreshold, targetSegmentSize, splitThreshold, enableSegments, idleMs, retries },
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 卡住计时器：只要还在来数据就不算超时。
 *
 * 之前踩过的坑：用 `AbortSignal.timeout` 掐「总时长」，18 MB 的 mod 在慢速线路
 * 上必然超时。这里改成每收到一块就重置。
 */
function makeIdleGuard(idleMs, externalSignal) {
  const controller = new AbortController();
  let stalled = false;
  let timer = null;

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, idleMs);
    timer.unref?.();
  };

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener?.('abort', onExternalAbort, { once: true });
  }
  arm();

  return {
    signal: controller.signal,
    touch() {
      if (!stalled) arm();
    },
    get stalled() {
      return stalled;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
    },
  };
}

/** 读文件算 sha1（分段下载是乱序写的，只能写完再读一遍）。 */
async function sha1OfFile(filePath) {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
