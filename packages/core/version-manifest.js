/**
 * 版本清单：查「有哪些 Minecraft 版本 / 哪些加载器版本」，以及把 Mojang 官方地址
 * 换成国内镜像。
 *
 * 这一层**不联网**，只负责拼地址和解析响应；真正发请求的是 `mod-fetch.js` 的 http。
 * 这样测试里可以喂假数据，不用真的连网。
 *
 * 为什么需要镜像：本机实测 `maven.neoforged.net` 直接连超时，Mojang 的
 * `libraries.minecraft.net` 也时快时慢。BMCLAPI 是国内镜像，PCL 也在用同一套。
 */

import { McError, need } from './errors.js';

/** Mojang 的版本清单（v2 带 sha1，比 v1 稳）。 */
export const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

/** 国内镜像根。 */
export const MIRROR_ORIGIN = 'https://bmclapi2.bangbang93.com';

/**
 * 官方域名 → 镜像路径前缀。
 *
 * 只映射「镜像上真有对应路径」的那几条（实测过）：
 * - `libraries.minecraft.net/...` → `/maven/...`
 * - `resources.download.minecraft.net/<2>/<hash>` → `/assets/<2>/<hash>`
 * - `maven.neoforged.net/releases/...` → `/maven/...`
 *
 * **不要**映射 `piston-meta` / `piston-data` / `launchermeta`：BMCLAPI 上没有
 * `/v1/packages/...` 这种路径，映射过去只会先白等一轮连接超时再回退官方。
 * 这几个官方域名本机直连是通的。
 */
const MIRROR_RULES = [
  ['https://libraries.minecraft.net', `${MIRROR_ORIGIN}/maven`],
  ['https://resources.download.minecraft.net', `${MIRROR_ORIGIN}/assets`],
  ['https://maven.neoforged.net/releases', `${MIRROR_ORIGIN}/maven`],
  ['https://maven.neoforged.net', `${MIRROR_ORIGIN}/maven`],
  ['https://maven.minecraftforge.net', `${MIRROR_ORIGIN}/maven`],
  ['https://files.minecraftforge.net/maven', `${MIRROR_ORIGIN}/maven`],
];

/** 镜像上的版本清单（比官方快很多，官方偶尔连不上）。 */
export const MIRROR_MANIFEST_URL = `${MIRROR_ORIGIN}/mc/game/version_manifest_v2.json`;

/**
 * 把一个官方地址换成镜像地址。
 *
 * @param {string} url 原始地址
 * @param {string} [mode] `official` 原样返回 / `mirror` 强制镜像 / 默认 `fallback`（也返回镜像，由调用方决定先后）
 * @returns {string}
 */
export function toMirror(url, mode = 'mirror') {
  const text = String(url ?? '');
  if (!text) return text;
  if (mode === 'official') return text;
  for (const [from, to] of MIRROR_RULES) {
    if (text.startsWith(from)) return to + text.slice(from.length);
  }
  return text;
}

/** 取一个地址的域名，用于按域名决定要不要走镜像。 */
function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 一个地址的候选列表，按「谁快用谁」自动排。
 *
 * 实测数据（2026-10-30，本机）：
 * - `resources.download.minecraft.net` 官方 **7.3 MB/s、24/24 成功**；
 *   镜像 170 KB/s、24 个里挂 11 个 → **资源必须走官方**。
 * - `maven.neoforged.net` 官方**直连超时** → 必须走镜像。
 *
 * 所以默认档 `auto` 是按域名判断：只有官方连不上的仓库才镜像优先。
 *
 * @param {string} url
 * @param {string} [mode] `auto`（默认，按域名）/ `off` 只官方 / `prefer` 镜像优先 / `mirror` 只镜像
 * @returns {string[]}
 */
export function candidateUrlsFor(url, mode = 'auto') {
  const official = String(url ?? '');
  if (!official) return [];
  const mirrored = toMirror(official, 'mirror');
  if (mirrored === official) return [official];

  if (mode === 'off') return [official];
  if (mode === 'mirror') return [mirrored];
  if (mode === 'prefer') return [mirrored, official];

  // auto / fallback：官方连不上的仓库才镜像优先
  const host = hostOf(official);
  const needsMirror = /neoforged\.net|minecraftforge\.net/.test(host);
  return needsMirror ? [mirrored, official] : [official, mirrored];
}

/** 校验版本号长得像不像「1.21.1」。 */
export function normalizeGameVersion(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+\.\d+(\.\d+)?([-_a-zA-Z0-9.]+)?$/.test(text)) {
    throw new McError(`游戏版本号看起来不对：${text || '(空)'}`, '要像 1.21.1 或 1.20.1 这样');
  }
  return text;
}

/** 加载器名归一化。 */
export function normalizeLoader(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'vanilla' || text === '原版') return 'vanilla';
  if (text === 'neoforge' || text === 'neo') return 'neoforge';
  if (text === 'forge') return 'forge';
  if (text === 'fabric') return 'fabric';
  if (text === 'quilt') return 'quilt';
  throw new McError(`不认识的加载器：${value}`, '支持 vanilla / neoforge / forge / fabric / quilt');
}

/**
 * 解析版本清单。
 *
 * @param {any} json
 * @returns {{latest: {release: string, snapshot: string}, versions: Array<{id: string, type: string, url: string, sha1?: string, releaseTime?: string}>}}
 */
export function parseManifest(json) {
  if (!json || typeof json !== 'object') {
    throw new McError('版本清单不是对象', '检查一下拉到的清单是不是被代理页面替换了', 'VersionManifestBad');
  }
  const versions = Array.isArray(json.versions) ? json.versions : [];
  return {
    latest: {
      release: String(json.latest?.release ?? ''),
      snapshot: String(json.latest?.snapshot ?? ''),
    },
    versions: versions
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        type: String(item.type ?? 'release'),
        url: String(item.url ?? ''),
        sha1: item.sha1 ? String(item.sha1) : '',
        releaseTime: item.releaseTime ? String(item.releaseTime) : '',
      })),
  };
}

/**
 * 在清单里找一个版本。找不到就抛，并把相近的候选列出来。
 *
 * @param {ReturnType<typeof parseManifest>} manifest
 * @param {string} id
 */
export function pickVersion(manifest, id) {
  const wanted = normalizeGameVersion(id);
  const hit = manifest.versions.find((item) => item.id === wanted);
  if (hit) return hit;
  const near = manifest.versions
    .filter((item) => item.id.startsWith(wanted.split('.').slice(0, 2).join('.')))
    .slice(0, 6)
    .map((item) => item.id);
  throw new McError(
    `版本清单里没有 ${wanted}`,
    near.length ? `相近的有：${near.join('、')}` : '检查一下版本号，或者清单是不是拉的是快照版',
    'VersionNotFound',
  );
}

/** 列出正式版（给面板做下拉用）。 */
export function listReleases(manifest, limit = 40) {
  return manifest.versions
    .filter((item) => item.type === 'release')
    .slice(0, Math.max(1, limit))
    .map((item) => item.id);
}

/**
 * 从版本 json 里挑出客户端要下的东西。
 *
 * 只挑「客户端跑起来必须的」：客户端 jar、libraries、资源索引本身、log4j 配置。
 * 服务端、混淆映射表这些一律不要。
 *
 * @param {any} versionJson
 * @returns {{id: string, clientJar: object|null, libraries: object[], assetIndex: object|null, logging: object|null, javaMajor: number, mainClass: string}}
 */
export function parseVersionJson(versionJson) {
  if (!versionJson || typeof versionJson !== 'object') {
    throw new McError('版本 json 不是对象', '检查一下拉到的 json 是不是被代理页面替换了', 'VersionJsonBad');
  }
  const id = String(versionJson.id ?? '');
  if (!id) throw new McError('版本 json 里没有 id', '这个 json 不像 Minecraft 的版本文件', 'VersionJsonBad');

  const client = versionJson.downloads?.client;
  const libraries = Array.isArray(versionJson.libraries) ? versionJson.libraries : [];
  const assetIndex = versionJson.assetIndex ?? null;
  const loggingEntry = versionJson.logging?.client?.file ?? null;

  return {
    id,
    mainClass: String(versionJson.mainClass ?? ''),
    javaMajor: Number(versionJson.javaVersion?.majorVersion ?? 0) || 0,
    assets: String(versionJson.assets ?? ''),
    clientJar: client
      ? { path: `versions/${id}/${id}.jar`, size: Number(client.size ?? 0), sha1: String(client.sha1 ?? ''), url: String(client.url ?? '') }
      : null,
    libraries,
    assetIndex: assetIndex
      ? {
          id: String(assetIndex.id ?? ''),
          size: Number(assetIndex.size ?? 0),
          totalSize: Number(assetIndex.totalSize ?? 0),
          sha1: String(assetIndex.sha1 ?? ''),
          url: String(assetIndex.url ?? ''),
        }
      : null,
    logging: loggingEntry
      ? { path: String(loggingEntry.id ?? ''), size: Number(loggingEntry.size ?? 0), sha1: String(loggingEntry.sha1 ?? ''), url: String(loggingEntry.url ?? '') }
      : null,
  };
}

/**
 * 把一个库条目展开成「要下的文件」。
 *
 * 只认 `downloads.artifact`（客户端要的就是它）。带 `natives-*` 分类器的库也算
 * artifact，路径里已经含分类器，所以一视同仁。
 *
 * @param {any} lib
 * @returns {{path: string, size: number, sha1: string, url: string}|null}
 */
export function libraryArtifact(lib) {
  const art = lib?.downloads?.artifact;
  if (!art?.path) return null;
  return {
    path: String(art.path),
    size: Number(art.size ?? 0),
    sha1: String(art.sha1 ?? ''),
    url: String(art.url ?? ''),
  };
}

/**
 * 解析资源索引（assets/<index>.json）里的对象表。
 *
 * @param {any} indexJson
 * @returns {Array<{name: string, hash: string, size: number, path: string}>}
 */
export function assetObjects(indexJson) {
  const objects = indexJson?.objects;
  if (!objects || typeof objects !== 'object') return [];
  const out = [];
  for (const [name, value] of Object.entries(objects)) {
    const hash = String(value?.hash ?? '');
    if (!/^[0-9a-f]{40}$/.test(hash)) continue;
    out.push({
      name,
      hash,
      size: Number(value?.size ?? 0),
      path: `objects/${hash.slice(0, 2)}/${hash}`,
    });
  }
  return out;
}

/** 资源对象的下载地址（官方形式，用的时候再走镜像）。 */
export function assetUrl(hash) {
  const h = String(hash ?? '');
  return `https://resources.download.minecraft.net/${h.slice(0, 2)}/${h}`;
}

/**
 * NeoForge 的版本号跟游戏版本的对应关系。
 *
 * 1.21.1 → `21.1.`；1.20.4 → `20.4.`；1.20.1 是 NeoForge 的 legacy 分支
 * （`1.20.1-47.x`），那边走 forge 的包名，这里只做 1.20.2 及以上的换算。
 *
 * @param {string} mcVersion
 * @returns {string|null}
 */
export function neoforgePrefix(mcVersion) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(mcVersion ?? ''));
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3] ?? 0);
  if (major !== 1) return null;
  // NeoForge 是 1.20.1 之后从 Forge 分出来的，1.20.2 才有正式版；再早只有 legacy 包名
  if (minor < 20) return null;
  if (minor === 20 && patch <= 1) return null;
  return `${minor}.${patch}.`;
}

/**
 * 加载器安装包在 maven 上的坐标。
 *
 * @param {string} loader
 * @param {string} mcVersion
 * @param {string} loaderVersion
 * @returns {{group: string, artifact: string, version: string, fileName: string, path: string, url: string}}
 */
export function loaderInstaller(loader, mcVersion, loaderVersion) {
  const kind = normalizeLoader(loader);
  const version = String(loaderVersion ?? '').trim();
  if (!version) throw new McError('没给加载器版本', '比如 NeoForge 21.1.228 就传 21.1.228', 'LoaderNoVersion');

  if (kind === 'neoforge') {
    const prefix = neoforgePrefix(mcVersion);
    if (!prefix) {
      throw new McError(
        `NeoForge 不支持 ${mcVersion}`,
        '1.20.1 及更早的 NeoForge 属于 legacy 分支，暂时没接；1.20.1 请用 Forge',
        'LoaderNoVersion',
      );
    }
    if (!version.startsWith(prefix)) {
      throw new McError(
        `NeoForge ${version} 对不上 ${mcVersion}`,
        `这个游戏版本要用 ${prefix}x 的 NeoForge`,
        'LoaderVersionMismatch',
      );
    }
    const fileName = `neoforge-${version}-installer.jar`;
    return {
      group: 'net/neoforged/neoforge',
      artifact: 'neoforge',
      version,
      fileName,
      path: `net/neoforged/neoforge/${version}/${fileName}`,
      url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/${fileName}`,
    };
  }

  if (kind === 'forge') {
    const fileName = `forge-${mcVersion}-${version}-installer.jar`;
    return {
      group: 'net/minecraftforge/forge',
      artifact: 'forge',
      version: `${mcVersion}-${version}`,
      fileName,
      path: `net/minecraftforge/forge/${mcVersion}-${version}/${fileName}`,
      url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${version}/${fileName}`,
    };
  }

  throw new McError(`${kind} 不用安装包这条路`, 'Fabric / Quilt 是直接拼版本 json，不需要跑安装器', 'LoaderNoInstaller');
}

/**
 * 解析 maven 目录列表（BMCLAPI 的 `details/releases` 接口）。
 *
 * 注意这个接口返回的**版本号本身也是目录**（`type: "DIRECTORY"`），
 * 所以不能按「排除目录」来过滤，否则一个都不剩（踩过）。
 *
 * @param {any} json
 * @returns {string[]} 版本号，从新到旧
 */
export function parseMavenListing(json) {
  const files = Array.isArray(json?.files) ? json.files : [];
  const names = [];
  const seen = new Set();
  for (const item of files) {
    const name = String(item?.name ?? '').trim();
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.sort(compareVersionDesc);
}

/**
 * 版本号比较：从新到旧。
 *
 * 逐段按数字比，数字相同再看长度。`21.1.9` 要排在 `21.1.10` 后面。
 */
export function compareVersionDesc(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) {
      if (na !== nb) return nb - na;
      continue;
    }
    const sa = String(pa[i] ?? '');
    const sb = String(pb[i] ?? '');
    if (sa !== sb) return sa < sb ? 1 : -1;
  }
  return 0;
}

/**
 * 加载器版本列表的接口地址（走镜像）。
 *
 * Forge 跟 NeoForge 不是一路：BMCLAPI 那个 `neoforge/meta/.../details/releases/`
 * 接口**不代理 Forge**（实测直接 404），Forge 只能去 maven 拿自己的
 * `maven-metadata.xml`——注意它是 **XML**，不是 JSON，所以调用方要用 `http.text()`
 * 而不是 `http.json()`，解析走 `parseMavenMetadataXml()`。
 */
export function loaderListUrl(loader, mcVersion) {
  const kind = normalizeLoader(loader);
  if (kind === 'neoforge') {
    return `${MIRROR_ORIGIN}/neoforge/meta/api/maven/details/releases/net/neoforged/neoforge`;
  }
  if (kind === 'forge') {
    // 官方地址；`candidateUrlsFor(url, 'auto')` 会因为域名匹配 minecraftforge.net 而自动镜像优先
    return 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
  }
  if (kind === 'fabric' || kind === 'quilt') {
    const base = kind === 'fabric' ? 'https://meta.fabricmc.net' : 'https://meta.quiltmc.org';
    return `${base}/v2/versions/loader/${encodeURIComponent(String(mcVersion ?? ''))}`;
  }
  throw new McError(`${kind} 没有版本列表`, '原版不需要加载器', 'LoaderNoList');
}

/**
 * 这个加载器的版本列表是 XML 还是 JSON。
 *
 * @param {string} loader
 * @returns {boolean}
 */
export function loaderListIsXml(loader) {
  return normalizeLoader(loader) === 'forge';
}

/**
 * 解析 maven 的 `maven-metadata.xml`（Forge 专用）。
 *
 * 形状长这样（只挑我们要的部分）：
 * ```xml
 * <metadata><versioning><versions>
 *   <version>1.20.1-47.4.28</version>
 *   <version>1.20.1-47.4.0</version>
 * </versions></versioning></metadata>
 * ```
 * 只取 `<version>` 元素，别的（`<latest>` / `<release>` / `<lastUpdated>`）都不要。
 *
 * @param {string} xml
 * @returns {string[]} 版本号，从新到旧
 */
export function parseMavenMetadataXml(xml) {
  const text = String(xml ?? '');
  const out = [];
  const seen = new Set();
  const re = /<version>\s*([^<\s]+)\s*<\/version>/g;
  let m = re.exec(text);
  while (m) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
    m = re.exec(text);
  }
  return out.sort(compareVersionDesc);
}

/**
 * 从加载器版本列表里挑出属于这个游戏版本的。
 *
 * NeoForge / Forge 的列表是整个 maven 目录，要按前缀过滤；
 * Fabric / Quilt 的接口本身就按游戏版本查好了，直接取 loader.version。
 *
 * Forge 的列表是 XML（`parseMavenMetadataXml`），所以这里也接受**字符串**输入；
 * 传对象的话按 BMCLAPI 的 `details/releases` JSON 形状解析，兼容旧调用。
 *
 * @param {string} loader
 * @param {string} mcVersion
 * @param {any} json JSON 对象或 XML 文本
 * @returns {string[]}
 */
export function parseLoaderVersions(loader, mcVersion, json) {
  const kind = normalizeLoader(loader);

  if (kind === 'neoforge') {
    const prefix = neoforgePrefix(mcVersion);
    if (!prefix) return [];
    return parseMavenListing(json).filter((name) => name.startsWith(prefix));
  }

  if (kind === 'forge') {
    const want = String(mcVersion ?? '');
    const all = typeof json === 'string' ? parseMavenMetadataXml(json) : parseMavenListing(json);
    return all
      .filter((name) => name.startsWith(`${want}-`))
      .map((name) => name.slice(want.length + 1));
  }

  if (kind === 'fabric' || kind === 'quilt') {
    const list = Array.isArray(json) ? json : [];
    return list
      .map((item) => String(item?.loader?.version ?? item?.version ?? ''))
      .filter(Boolean);
  }

  return [];
}

/**
 * 整理一份「要装什么」的说明，给面板和工具直接显示。
 *
 * @param {{mcVersion: string, loader: string, loaderVersion: string}} input
 */
export function describeTarget(input) {
  const loader = normalizeLoader(input.loader);
  const label = { vanilla: '原版', neoforge: 'NeoForge', forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt' }[loader] ?? loader;
  const version = loader === 'vanilla' ? '' : ` ${input.loaderVersion}`;
  return `${input.mcVersion} + ${label}${version}`;
}
