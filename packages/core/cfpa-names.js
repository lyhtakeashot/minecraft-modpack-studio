/**
 * CFPA 社区汉化包：中文名补全的「核心层」。
 *
 * ## 为什么会有这个文件
 *
 * 整合包里有些 mod 只带了 `en_us.json`（英文），没做 `zh_cn.json`（简中）；
 * 还有不少物品连语言键都没有，界面只能显示 `createdeco:oak_crate` 这种 ID。
 * 用户 2026-11-05 提的：「为什么很多都没有中文名标记，这个项目该有一些基础的
 * 联网功能去查中文名吧」。
 *
 * 数据来源是社区维护的 [CFPAOrg/Minecraft-Mod-Language-Package](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package)
 * （「Minecraft 模组简体中文翻译项目」）。它不是逐条查询的在线服务，而是**每天自动
 * 打包好的一整个资源包 zip**（3.5 MB 左右），所以做法是：一次下载 → 本地解开 →
 * 按物品 ID 对名字 → 存成本地缓存。之后断网也能用。
 *
 * ## 三条硬约束（用户拍板的）
 *
 * 1. **免密钥**：只用 GitHub 的公开 API + 公开 release 直链，零 API key；
 * 2. **多来源自动降级**：下载直链在某些网络里连不上，逐个试公共代理前缀，
 *    一个失败就换下一个，全失败才报错，报错也只影响「补全」这一件事；
 * 3. **零新增依赖**：只用 Node 内置的 fetch / Buffer，连 zip 都复用 `zip.js`。
 *
 * ## 许可证
 *
 * CFPA 汉化包是 **CC BY-NC-SA 4.0**（署名-非商业性使用-相同方式共享）。
 * 所以**绝不打包进安装程序**，只能运行时下载到软件自己的数据目录，界面上必须
 * 标注来源与许可证。下载/落盘策略在 `lib/host/name-completion.js`。
 */
import { openZip } from './zip.js';

/** GitHub 公开 API：取最新一次 release 的 tag 和附件名。 */
export const CFPA_RELEASE_API =
  'https://api.github.com/repos/CFPAOrg/Minecraft-Mod-Language-Package/releases?per_page=1';
export const CFPA_PROJECT = 'https://github.com/CFPAOrg/Minecraft-Mod-Language-Package';
export const CFPA_LICENSE = 'CC BY-NC-SA 4.0';

/**
 * 下载源前缀：实测可用的排前面，直链放最后。
 *
 * 2026-11-05 在本项目沙箱里实测：`gh-proxy.com` 能下到完整 zip（3527805 字节），
 * `ghfast.top` 直接 fetch failed；GitHub 直链也连不上。但用户自己的机器可能直连得上，
 * 所以直链保留在最后一位，不删。
 */
export const CFPA_PROXIES = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://mirror.ghproxy.com/',
  'https://ghproxy.net/',
  'https://hub.gitmirror.com/',
  '', // 直链
];

const USER_AGENT = 'DSH-MCModpackStudio/0.1 (Minecraft modpack studio)';
const API_TIMEOUT_MS = 12_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** 小于这个字节数一定不是汉化整包（整包约 3.5 MB）。 */
const MIN_ZIP_BYTES = 100_000;

/** 测试注入口：换掉底层 fetch，别的模块不用关心网络细节。 */
let customFetch = null;
export function setCfpaFetch(fn) {
  customFetch = fn ?? null;
}

function fetchOf(options) {
  return options?.fetchImpl ?? customFetch ?? globalThis.fetch;
}

/**
 * 语言文件里的一个键 → 物品 ID。
 *
 * 规则和 `packages/core/index.js` 的 `langNames()` 保持一致（同一个坑：
 * 只认正好 3 段的 `item.ns.name` / `block.ns.name`，带 `%` 的是格式化模板不是名字）。
 * 更长的键（`block.foo.bar.too_cold`）值往往是一整句提示，收进来只会显示成错的名字。
 *
 * @returns {[string, string] | null} `[物品ID, 中文名]`
 */
function nameFromLangKey(key, value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.includes('%')) return null;
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  const [kind, ns, name] = parts;
  if (kind !== 'item' && kind !== 'block') return null;
  if (!/^[a-z0-9_-]+$/.test(ns) || !/^[a-z0-9_]+$/.test(name)) return null;
  return [`${ns}:${name}`, text];
}

/**
 * 把 CFPA 整包解成「物品 ID → 中文名」的一张表。纯函数，不碰网络、不碰磁盘。
 *
 * 整包里除了语言文件还有手册 md、pack.png、LICENSE 等，这里只认
 * `assets/<命名空间>/lang/zh_cn.json`，别的条目全部跳过。
 *
 * @param {Buffer} buffer 整个 zip 的字节
 * @returns {{names: Map<string, string>, files: number}} 名字表 + 读到了几份语言文件
 */
export function parseCfpaZip(buffer) {
  const zip = openZip(buffer);
  const names = new Map();
  let files = 0;
  for (const entry of zip.names) {
    if (!/^assets\/[^/]+\/lang\/zh_cn\.json$/.test(entry)) continue;
    const raw = zip.text(entry);
    if (!raw) continue;
    let lang;
    try {
      lang = JSON.parse(raw);
    } catch {
      continue; // 单份语言文件坏了不该毁掉整包
    }
    if (!lang || typeof lang !== 'object') continue;
    files += 1;
    for (const [key, value] of Object.entries(lang)) {
      const pair = nameFromLangKey(key, value);
      if (!pair) continue;
      // 所有键都是 3 段，没有「段数少者赢」的问题，先到为准。
      if (!names.has(pair[0])) names.set(pair[0], pair[1]);
    }
  }
  return { names, files };
}

/** 从 release 的文件名里抠版本号，用来在多个整包里挑最新的那个。 */
function versionOf(name) {
  const m = /-(\d+)-(\d+)\.zip$/i.exec(name) ?? /-(\d+)\.zip$/i.exec(name);
  return m ? Number(m[1]) * 100 + Number(m[2] ?? 0) : 0;
}

/** 问 GitHub 拿「最新 release 的 tag + 整包附件名」。 */
async function readRelease(fetchImpl, options) {
  const res = await fetchImpl(CFPA_RELEASE_API, {
    signal: AbortSignal.timeout(options.apiTimeoutMs ?? API_TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
  const arr = await res.json();
  const rel = Array.isArray(arr) ? arr[0] : null;
  const tag = String(rel?.tag_name ?? '');
  if (!tag) throw new Error('GitHub API 没返回 release 标签');
  const zips = (rel.assets ?? [])
    .map((a) => String(a?.name ?? ''))
    .filter((n) => /^Minecraft-Mod-Language-Modpack-.*\.zip$/i.test(n));
  if (!zips.length) throw new Error('这个 release 里没有汉化整包 zip');
  // 同一个 release 可能同时给几个 MC 版本出包；版本号大的优先（1-21 > 1-20）。
  zips.sort((a, b) => versionOf(b) - versionOf(a));
  return {
    tag,
    asset: zips[0],
    publishedAt: String(rel.published_at ?? ''),
    candidates: zips,
  };
}

/**
 * 把响应体读成 Buffer，顺带按字节数汇报进度。
 *
 * 有流式 body（`res.body.getReader`）就一块一块读，能报出「已下 1.2 MB / 共 3.5 MB」
 * 这种真进度；没有就一次性读完（老环境、测试替身），只报一次终值。
 *
 * `total` 拿 `content-length`；代理不一定给，拿不到就是 0（调用方按「不知道大小」处理）。
 */
async function readBodyWithProgress(res, onProgress, source) {
  const raw = res.headers?.get?.('content-length');
  const total = (raw == null ? 0 : Number(raw)) || 0;
  const reader = res.body?.getReader?.();
  if (!reader) {
    // 没有流式接口：一次性读完，只报一次终值
    const buffer = Buffer.from(await res.arrayBuffer());
    onProgress?.({ loaded: buffer.length, total, source });
    return buffer;
  }
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    loaded += value.length;
    onProgress?.({ loaded, total, source });
  }
  return Buffer.concat(chunks, loaded);
}

/**
 * 真下载：先问 API 拿 tag/附件名，再逐个试代理前缀，命中就停。
 *
 * 每个候选都会校验「HTTP 状态 + 字节数 + zip 魔数 `PK`」—— 有些代理会在失败时
 * 返回一个 200 的 HTML 错误页，光看 status 会把 HTML 当 zip 存下来。
 *
 * 传 `options.onProgress` 就能看到下载进度（界面上的进度条就是靠它）：
 * 回调参数是 `{ loaded, total, source }`，`total` 为 0 表示「代理没报总大小」。
 * 换一个下载源时进度会重新从 0 开始（先报一次 `loaded: 0`）。
 *
 * @param {{fetchImpl?: Function, timeoutMs?: number, apiTimeoutMs?: number,
 *   onProgress?: (info: {loaded: number, total: number, source: string}) => void}} [options]
 * @returns {Promise<{buffer: Buffer, tag: string, asset: string, publishedAt: string,
 *   candidates: string[], source: string, url: string}>}
 */
export async function fetchCfpaZip(options = {}) {
  const fetchImpl = fetchOf(options);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const release = await readRelease(fetchImpl, options);
  const direct =
    `https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/releases/download/` +
    `${encodeURIComponent(release.tag)}/${release.asset}`;

  let lastError = null;
  for (const prefix of CFPA_PROXIES) {
    const source = prefix || '直链';
    const url = prefix ? prefix + direct : direct;
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
      });
      // 换源就先把进度归零，界面上别留着上一个源的下半截
      onProgress?.({ loaded: 0, total: 0, source });
      const buffer = await readBodyWithProgress(res, onProgress, source);
      if (!res.ok || buffer.length < MIN_ZIP_BYTES || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        lastError = new Error(`${source} 返回的不是有效汉化整包（status=${res.status} 字节=${buffer.length}）`);
        continue;
      }
      return { buffer, ...release, source, url };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `汉化包下载失败：${CFPA_PROXIES.length} 个下载源都试过了。最后一次：${lastError?.message ?? String(lastError)}`,
  );
}
