/**
 * 联网层：真正出去拿数据的地方（HTTP JSON + 下文件）。
 *
 * 三件事必须做对，否则用户会看到「卡住不动」或者「装了个坏文件」：
 * 1. 每个请求都有超时（30 秒，和 PCL 一致），不能无限等；
 * 2. 限流(429)/服务端错误(5xx)/网络抖动要重试，4xx 这种「你自己写错了」不重试；
 * 3. 下载的文件必须先落临时文件、校验 sha1 通过再改名，半截文件绝不能进 mods。
 *
 * 镜像：官方 Modrinth / CurseForge 在国内时通时不通。PCL 的做法是准备一串
 * 候选地址逐个试（`ref/pcl-ce/ModDownload.cs:2251`），我们照做，顺序由 mirrorMode 决定。
 *
 * 这一层不判断「该装什么」，只负责「把这个地址拿回来」。
 */

import { McError } from './errors.js';
import { createDownloader, getGlobalPool } from './downloader.js';
import { isNetworkFailure, describeNetworkFailure, safeHost, sleep } from './net-errors.js';

// 这几个 helper 原来住在本文件里，为了让 `downloader.js` 也能用又不想循环引用，
// 搬去了 `net-errors.js`；这里转出去，调用方（tools / host / 测试）不用改 import。
export { isNetworkFailure, describeNetworkFailure, safeHost } from './net-errors.js';

/** 默认 UA。Modrinth 对「没有 UA 的请求」会直接 403，必须带。 */
export const DEFAULT_USER_AGENT = 'DSH-MCModpackStudio/0.1 (Minecraft modpack studio)';

/** 单次请求超时（PCL 也是 30 秒）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 失败重试次数（不含首次）。PCL 用随机 300–500ms 退避。 */
export const DEFAULT_RETRIES = 2;

/** 镜像档位：off=只用官方；fallback=官方优先失败退镜像；prefer=镜像优先。 */
export const MIRROR_MODES = ['off', 'fallback', 'prefer'];

/**
 * 从环境变量读联网设置。
 *
 * 工具层和面板接口都读这一份，避免两边对「默认走不走镜像」的理解不一样。
 * - `MCSTUDIO_CURSEFORGE_KEY`：CurseForge API key，不填就只用 Modrinth；
 * - `MCSTUDIO_MIRROR`：off / fallback（默认）/ prefer；
 * - `MCSTUDIO_CONNECTIONS`：全局下载连接数（1–256，默认 64）。
 */
export function readNetOptionsFromEnv(env = process.env) {
  const mode = String(env?.MCSTUDIO_MIRROR ?? 'fallback').toLowerCase();
  const connections = Number(env?.MCSTUDIO_CONNECTIONS ?? 0);
  return {
    curseforgeKey: String(env?.MCSTUDIO_CURSEFORGE_KEY ?? '').trim(),
    mirrorMode: MIRROR_MODES.includes(mode) ? mode : 'fallback',
    connectionLimit: Number.isFinite(connections) && connections > 0 ? Math.min(Math.max(Math.trunc(connections), 1), 256) : 64,
  };
}

/**
 * 建一个「能发请求的对象」。
 *
 * 测试里传一个假的 fetchImpl 就能整段跑，不需要真网 —— 这也是把联网收在一层的原因。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.userAgent]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 * @param {string} [options.curseforgeKey] 用户自填的 CF key；空 = 不走 CurseForge
 * @param {'off'|'fallback'|'prefer'} [options.mirrorMode]
 * @param {string} [options.mirrorBase] 覆盖镜像根地址（测试用）
 */
export function createHttp(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new McError('当前环境没有 fetch，无法联网', '需要 Node 20.18 以上', 'McNoFetch');
  }
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retries = Math.max(0, Number(options.retries ?? DEFAULT_RETRIES));
  const backoffMs = Math.max(0, Number(options.backoffMs ?? 300));
  const curseforgeKey = String(options.curseforgeKey ?? '').trim();
  const mirrorMode = MIRROR_MODES.includes(options.mirrorMode) ? options.mirrorMode : 'fallback';
  const mirrorBase = options.mirrorBase ?? '';

  /** CF 的请求要带 key；没 key 直接给一条能看懂的失败，别发出去被 403 糊一脸。 */
  function headersFor(url) {
    const headers = { 'User-Agent': userAgent, Accept: 'application/json' };
    const host = safeHost(url);
    const needsKey = host.endsWith('curseforge.com') || host.includes('forgecdn.net');
    if (needsKey) {
      if (!curseforgeKey) {
        throw new McError(
          'CurseForge 需要 API Key，但还没配置',
          'Modrinth 不需要 key，可以先只用 Modrinth；要用 CurseForge 就去 https://console.curseforge.com/ 申请免费 key，填进环境变量 MCSTUDIO_CURSEFORGE_KEY。',
          'McNoCurseforgeKey',
        );
      }
      headers['x-api-key'] = curseforgeKey;
    }
    return headers;
  }

  function rewriteMirror(url) {
    const text = String(url ?? '');
    if (!mirrorBase) return toMirrorLike(text);
    return toMirrorLike(text).replace('https://mod.mcimirror.top', mirrorBase);
  }

  /**
   * 同一个地址的候选顺序。
   *
   * 「平衡」档（默认）官方优先、镜像兜底；「镜像优先」档反过来。
   * 两个地址相同时只留一个，免得白试一遍。
   */
  function candidateUrls(url) {
    const official = String(url ?? '');
    if (!official) return [];
    if (mirrorMode === 'off') return [official];
    const mirrored = rewriteMirror(official);
    if (!mirrored || mirrored === official) return [official];
    return mirrorMode === 'prefer' ? [mirrored, official] : [official, mirrored];
  }

  /**
   * 发一次请求，**拿原始文本**。
   *
   * 为什么单独抽出来：Forge 的版本列表是 maven 的 `maven-metadata.xml`（XML），
   * 不是 JSON，`jsonOnce` 会在解析那一步直接报「返回的不是 JSON」。所以要先把
   * 「请求」和「解析」拆开，让调用方自己决定要不要 JSON.parse。
   */
  async function requestOnce(url, { method = 'GET', body, accept = 'application/json' } = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    const headers = { ...headersFor(url), Accept: accept };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw isNetworkFailure(error) ? describeNetworkFailure(error) : error;
    }

    const status = Number(response.status ?? 0);
    const text = await response.text().catch(() => '');

    if (status === 404) {
      throw new McError(`找不到这个页面：${url}`, '工程 ID 或 slug 可能写错了', 'McHttpNotFound');
    }
    if (status === 403 && safeHost(url).endsWith('curseforge.com')) {
      throw new McError(
        'CurseForge 拒绝了这个请求（403）',
        'key 可能无效或已过期，去 https://console.curseforge.com/ 重新生成一个。',
        'McCurseforgeForbidden',
      );
    }
    if (status < 200 || status >= 300) {
      const retryable = status === 429 || status >= 500;
      const error = new McError(
        `服务器返回 ${status}：${text.slice(0, 200) || '（无内容）'}`,
        retryable ? '这类错误通常是临时的，已经自动重试过；还失败就过一会儿再试。' : '这是请求本身有问题，重试没用。',
        retryable ? 'McHttpRetryable' : 'McHttp',
      );
      error.status = status;
      error.retryable = retryable;
      throw error;
    }

    try {
      return text;
    } catch (error) {
      if (error instanceof McError) throw error;
      throw new McError(`读不出返回内容：${error?.message ?? error}`, '过一会儿再试', 'McBadBody');
    }
  }

  /** 发一次请求拿 JSON（带超时；重试与镜像兜底在外层 `json`）。 */
  async function jsonOnce(url, options = {}) {
    const text = await requestOnce(url, options);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new McError(
        `返回的不是 JSON（前 200 字）：${text.slice(0, 200)}`,
        '可能是站点返回了拦截页（比如需要人机验证），稍后再试或改用镜像。',
        'McBadJson',
      );
    }
  }

  /** 带重试的 JSON 请求；镜像按档位兜底。 */
  async function json(url, options = {}) {
    const urls = candidateUrls(url);
    let lastError;
    for (let index = 0; index < urls.length; index += 1) {
      const target = urls[index];
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          return await jsonOnce(target, options);
        } catch (error) {
          lastError = error;
          const retryable = error?.retryable === true || isNetworkFailure(error);
          if (!retryable || attempt === retries) break;
          // 300–500ms 随机退避，别和别的请求一起敲门（PCL 同款）。
          await sleep(backoffMs + Math.random() * (backoffMs > 0 ? 200 : 0));
        }
      }
    }
    throw lastError ?? new McError('请求没有发出', '', 'McNoRequest');
  }

  /**
   * 带重试的纯文本请求；镜像按档位兜底。
   *
   * 用在「返回的不是 JSON」的地方：Forge 的 `maven-metadata.xml` 就是 XML。
   *
   * @param {string} url
   * @param {{method?: string, body?: any, accept?: string}} [options]
   * @returns {Promise<string>}
   */
  async function text(url, options = {}) {
    const urls = candidateUrls(url);
    let lastError;
    for (let index = 0; index < urls.length; index += 1) {
      const target = urls[index];
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          return await requestOnce(target, options);
        } catch (error) {
          lastError = error;
          const retryable = error?.retryable === true || isNetworkFailure(error);
          if (!retryable || attempt === retries) break;
          await sleep(backoffMs + Math.random() * (backoffMs > 0 ? 200 : 0));
        }
      }
    }
    throw lastError ?? new McError('请求没有发出', '', 'McNoRequest');
  }

  /**
   * 把文件下到 destPath。
   *
   * 真正的下载逻辑在 `lib/core/downloader.js`（分段并行 + 全局连接池 + 慢分段分裂，
   * 照 PCL 抄的）。这里只负责「按镜像偏好排候选地址」和「一个地址失败换下一个」。
   *
   * @param {string} url
   * @param {string} destPath
   * @param {{sha1?: string, size?: number, onProgress?: Function, signal?: AbortSignal}} [expect]
   */
  async function downloadToFile(url, destPath, expect = {}) {
    const result = await downloader.download(candidateUrls(url), destPath, expect);
    return { path: result.path, bytes: result.bytes, sha1: result.sha1, url: result.url, mode: result.mode, segments: result.segments, splits: result.splits };
  }

  function headersForDownload(url) {
    const host = safeHost(url);
    if ((host.endsWith('forgecdn.net') || host.includes('minecraftforge')) && curseforgeKey) {
      return { 'x-api-key': curseforgeKey };
    }
    return {};
  }

  // 下载引擎。连接池默认是进程级全局的 —— 这样面板同时下好几个 mod 时，
  // 它们共抢同一个额度，而不是各自开满连接把线路挤死。
  const downloader = createDownloader({
    fetchImpl,
    userAgent,
    timeoutMs,
    retries,
    backoffMs,
    pool: options.pool ?? getGlobalPool(),
    perFileConnections: options.perFileConnections,
    segmentThreshold: options.segmentThreshold,
    enableSegments: options.enableSegments,
    headerForDownload: headersForDownload,
  });

  return {
    json,
    text,
    downloadToFile,
    candidateUrls,
    downloader,
    pool: downloader.pool,
    config: {
      mirrorMode,
      hasCurseforgeKey: Boolean(curseforgeKey),
      timeoutMs,
      retries,
      perFileConnections: downloader.config.perFileConnections,
      segmentThreshold: downloader.config.segmentThreshold,
    },
  };
}



/** 和 mod-source.js 的 toMirror 同一套规则；这里不 import 是为了让本文件能独立被引用。 */
function toMirrorLike(url) {
  return String(url ?? '')
    .replace('https://api.modrinth.com', 'https://mod.mcimirror.top/modrinth')
    .replace('https://api.curseforge.com', 'https://mod.mcimirror.top/curseforge')
    .replace('https://cdn.modrinth.com', 'https://mod.mcimirror.top')
    .replace('https://edge.forgecdn.net', 'https://mod.mcimirror.top')
    .replace('https://mediafilez.forgecdn.net', 'https://mod.mcimirror.top');
}