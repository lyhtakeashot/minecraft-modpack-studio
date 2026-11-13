/**
 * 联网找 mod 的「纯逻辑」层：拼地址、解析返回、挑版本、算落盘文件名。
 *
 * 为什么单独一层：真正联网在 lib/core/mod-fetch.js，真正写盘在 lib/core/mod-install.js。
 * 这一层一个字节都不出去、也不碰磁盘，所以能拿假 JSON 整段单测 —— 联网功能最怕
 * 「只能靠真网验证」，限流一次测试就红了。
 *
 * 事实来源（2026-10-29 核对 PCL 社区版源码 + 实测接口）：
 * - PCL 走 CurseForge v1 + Modrinth v2 双源，搜索/详情/文件三组接口，见
 *   `ref/pcl-ce/ModComp.cs` 的 GetCurseForgeAddress / GetModrinthAddress /
 *   CompFilesGet。
 * - CurseForge 需要 x-api-key；PCL 把 key 编进 exe 里，我们不这么做，改成
 *   「用户自己填 key，没填就只用 Modrinth」。
 * - 挑文件：先按「游戏版本 + 加载器」过滤，再优先 release、其次发布日期最新，
 *   见 `ref/pcl-ce/ModComp.cs:3770` _PickLatestFile。
 */

/** Modrinth v2 根地址（官方）。 */
export const MODRINTH_API = 'https://api.modrinth.com/v2';
/** CurseForge v1 根地址（官方，必须带 x-api-key）。 */
export const CURSEFORGE_API = 'https://api.curseforge.com/v1';
/** PCL 用的国内镜像站（api 前缀和文件 CDN 都代理）。 */
export const MIRROR_BASE = 'https://mod.mcimirror.top';

/** 我们认的四种加载器 → Modrinth 的写法。 */
const CANONICAL_LOADERS = ['neoforge', 'forge', 'fabric', 'quilt'];

/** CurseForge 的类目 ID（PCL `ModComp.cs:1999` 同一套数字）。 */
export const CF_CLASS_ID = {
  mod: 6,
  modpack: 4471,
  datapack: 6945,
  shader: 6552,
  resourcepack: 12,
  world: 17,
};

/** CurseForge 的模组加载器枚举（官方文档 tocSModLoaderType）。 */
export const CF_LOADER_TYPE = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

/**
 * 把各种写法归一成 'neoforge' / 'forge' / 'fabric' / 'quilt' / ''（未知）。
 *
 * 实例探测回来的是小写（见 lib/core/instance.js），用户手填可能是 NeoForge。
 */
export function normalizeLoader(loader) {
  const raw = String(loader ?? '').trim().toLowerCase();
  if (!raw || raw === 'vanilla' || raw === 'none') return '';
  if (raw === 'neo' || raw === 'neoforge' || raw === 'neo-forge') return 'neoforge';
  if (raw.includes('fabric')) return 'fabric';
  if (raw.includes('quilt')) return 'quilt';
  if (raw.includes('forge')) return 'forge';
  return '';
}

/** 排序名 → Modrinth 的 index 参数。 */
const MR_SORT = {
  relevance: 'relevance',
  downloads: 'downloads',
  follows: 'follows',
  newest: 'newest',
  updated: 'updated',
};

/**
 * 拼 Modrinth 搜索地址。
 *
 * facets 的形状是「数组的数组」，同一个数组内是 OR，数组之间是 AND。
 * PCL 也是这么拼的（`ModComp.cs:2132` 的注释直接写了示例）。
 */
export function mrSearchUrl({
  query = '', gameVersion = '', loader = '', limit = 20, offset = 0, sort = 'relevance', projectType = 'mod',
} = {}) {
  const params = new URLSearchParams();
  const wanted = Number(limit);
  params.set('limit', String(wanted > 0 ? Math.min(wanted, 100) : 20));
  params.set('index', MR_SORT[sort] ?? 'relevance');
  if (offset > 0) params.set('offset', String(offset));
  if (query) params.set('query', query);

  const facets = [[`project_type:${projectType}`]];
  const normalized = normalizeLoader(loader);
  if (normalized) facets.push([`categories:${normalized}`]);
  const version = String(gameVersion ?? '').trim();
  if (version) facets.push([`versions:${version}`]);
  params.set('facets', JSON.stringify(facets));

  return `${MODRINTH_API}/search?${params.toString()}`;
}

/** 单个工程的详情（projectId 也能直接传 slug）。 */
export function mrProjectUrl(projectIdOrSlug) {
  return `${MODRINTH_API}/project/${encodeURIComponent(projectIdOrSlug)}`;
}

/** 某个工程的全部版本（不带 changelog，能少一半流量）。 */
export function mrVersionsUrl(projectIdOrSlug) {
  return `${MODRINTH_API}/project/${encodeURIComponent(projectIdOrSlug)}/version?include_changelog=false`;
}

/**
 * 按已装文件的 sha1 批量查「这些 mod 现在最新是哪一版」（检查更新用）。
 *
 * 官方返回的是「旧文件哈希 → 该工程最新版本」的映射，所以用哈希认 mod
 * 比拿 modId 去猜工程精确得多 —— 不会把两个名字相近的 mod 认错。
 * 详见 docs.modrinth.com 的 getlatestversionsfromhashes。
 */
export function mrUpdateUrl() {
  return `${MODRINTH_API}/version_files/update`;
}

/** 批量查工程信息（补前置用）。 */
export function mrProjectsUrl(ids) {
  const list = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  return `${MODRINTH_API}/projects?ids=${encodeURIComponent(JSON.stringify(list))}`;
}

/**
 * 拼 CurseForge 搜索地址。
 *
 * 注意：真正的请求还得由 mod-fetch 加上 x-api-key，这一层只管地址。
 */
export function cfSearchUrl({
  query = '', gameVersion = '', loader = '', limit = 20, offset = 0, sort = 'relevance', classId = CF_CLASS_ID.mod,
} = {}) {
  const params = new URLSearchParams();
  params.set('gameId', '432');
  params.set('classId', String(classId));
  params.set('sortOrder', 'desc');
  params.set('pageSize', String(Math.max(1, Math.min(Number(limit) || 20, 50))));
  // sortField：1=Featured 2=Popularity 3=LastUpdated 4=Name 6=TotalDownloads 11=ReleasedDate
  const sortField = { relevance: '2', downloads: '6', follows: '2', newest: '11', updated: '3' }[sort] ?? '2';
  params.set('sortField', sortField);
  if (offset > 0) params.set('index', String(offset));
  if (query) params.set('searchFilter', query);
  const normalized = normalizeLoader(loader);
  if (normalized) params.set('modLoaderType', String(CF_LOADER_TYPE[normalized]));
  const version = String(gameVersion ?? '').trim();
  if (version) params.set('gameVersion', version);
  return `${CURSEFORGE_API}/mods/search?${params.toString()}`;
}

/** 工程详情。 */
export function cfProjectUrl(projectId) {
  return `${CURSEFORGE_API}/mods/${encodeURIComponent(projectId)}`;
}

/** 某个工程的文件列表（PCL 一次要 10000 条，我们只留最近 50 条）。 */
export function cfFilesUrl(projectId) {
  return `${CURSEFORGE_API}/mods/${encodeURIComponent(projectId)}/files?pageSize=50`;
}

/**
 * CurseForge 不给 downloadUrl 时（作者关掉了第三方下载），按文件 ID 拼 CDN 地址。
 *
 * 这是 PCL 的老办法（`ModComp.cs:2909`）：ID 前 4 位 / 后几位 / 文件名。
 * 拼出来的地址不一定永远有效，但比「没有地址」强，失败还能退回手动下载。
 */
export function cfFileUrl(fileId, fileName) {
  const id = String(fileId ?? '').trim();
  if (!/^\d{6,}$/.test(id)) return '';
  const name = encodeURIComponent(String(fileName ?? '')).replace(/%2B/gi, '%2B');
  return `https://edge.forgecdn.net/files/${id.slice(0, 4)}/${id.slice(4)}/${name}`;
}

/**
 * 把官方地址改写成镜像地址（PCL `ModDownload.cs:2251` / :2262 的同一套替换）。
 *
 * 只做前缀替换，不解析 URL —— 文件名里带 %2B、+ 的情况下重建 URL 更容易出错。
 */
export function toMirror(url) {
  const text = String(url ?? '');
  if (!text) return text;
  return text
    .replace('https://api.modrinth.com', `${MIRROR_BASE}/modrinth`)
    .replace('https://api.curseforge.com', `${MIRROR_BASE}/curseforge`)
    .replace('https://cdn.modrinth.com', MIRROR_BASE)
    .replace('https://edge.forgecdn.net', MIRROR_BASE)
    .replace('https://mediafilez.forgecdn.net', MIRROR_BASE);
}

/** 解析搜索返回。字段名照 Modrinth v2 search 的返回改写成我们自己的驼峰。 */
export function parseMrSearch(json) {
  const hits = Array.isArray(json?.hits) ? json.hits : [];
  const results = hits.map((hit) => ({
    source: 'modrinth',
    projectId: String(hit.project_id ?? ''),
    slug: String(hit.slug ?? ''),
    title: String(hit.title ?? ''),
    description: String(hit.description ?? ''),
    author: String(hit.author ?? ''),
    downloads: Number(hit.downloads ?? 0),
    follows: Number(hit.follows ?? 0),
    updated: String(hit.date_modified ?? ''),
    categories: arr(hit.categories),
    loaders: arr(hit.categories).filter((c) => CANONICAL_LOADERS.includes(c)),
    versions: arr(hit.versions),
    projectType: String(hit.project_type ?? ''),
    iconUrl: String(hit.icon_url ?? ''),
    pageUrl: hit.slug ? `https://modrinth.com/mod/${hit.slug}` : '',
  }));
  return { total: Number(json?.total_hits ?? results.length), results };
}

/** 解析工程详情。 */
export function parseMrProject(json) {
  return {
    source: 'modrinth',
    projectId: String(json?.id ?? ''),
    slug: String(json?.slug ?? ''),
    title: String(json?.title ?? ''),
    description: String(json?.description ?? ''),
    body: String(json?.body ?? ''),
    categories: arr(json?.categories),
    loaders: arr(json?.loaders),
    gameVersions: arr(json?.game_versions),
    downloads: Number(json?.downloads ?? 0),
    pageUrl: json?.slug ? `https://modrinth.com/mod/${json.slug}` : '',
    iconUrl: String(json?.icon_url ?? ''),
  };
}

/**
 * 解析版本列表。每个版本里 files[0] 是主文件，dependencies 里 type=required 是必须的前置。
 *
 * 实测（2026-10-29，Create 1.21.1 版）：
 *   version_number "6.0.10+mc1.21.1"、version_type "release"、
 *   files[0].filename "create-1.21.1-6.0.10.jar"、hashes.sha1 有值。
 */
export function parseMrVersions(json) {
  const list = Array.isArray(json) ? json : [];
  return list.map((item) => {
    const files = Array.isArray(item?.files) ? item.files : [];
    const primary = files.find((f) => f?.primary) ?? files[0];
    return {
      source: 'modrinth',
      id: String(item?.id ?? ''),
      projectId: String(item?.project_id ?? ''),
      name: String(item?.name ?? ''),
      versionNumber: String(item?.version_number ?? ''),
      versionType: normalizeVersionType(item?.version_type),
      published: String(item?.date_published ?? ''),
      downloads: Number(item?.downloads ?? 0),
      gameVersions: arr(item?.game_versions),
      loaders: arr(item?.loaders),
      fileName: primary ? String(primary.filename ?? '') : '',
      fileUrl: primary ? String(primary.url ?? '') : '',
      sha1: primary ? String(primary.hashes?.sha1 ?? '') : '',
      size: primary ? Number(primary.size ?? 0) : 0,
      dependencies: parseMrDependencies(item?.dependencies),
    };
  });
}

function parseMrDependencies(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((dep) => ({
      projectId: String(dep?.project_id ?? ''),
      versionId: dep?.version_id ? String(dep.version_id) : '',
      type: String(dep?.dependency_type ?? dep?.type ?? ''),
    }))
    .filter((dep) => dep.projectId && dep.type !== 'embedded');
}

/** 版本类型统一成 release / beta / alpha 三档。 */
function normalizeVersionType(value) {
  const text = String(value ?? '').toLowerCase();
  if (text === 'release' || text === 'beta' || text === 'alpha') return text;
  return 'alpha';
}

function arr(value) {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** 允许的版本类型（用户体验档位：只正式版 / 带测试版 / 全都要）。 */
export function allowedChannels(channel) {
  switch (String(channel ?? 'release').toLowerCase()) {
    case 'alpha':
      return ['release', 'beta', 'alpha'];
    case 'beta':
      return ['release', 'beta'];
    default:
      return ['release'];
  }
}

const TYPE_RANK = { release: 0, beta: 1, alpha: 2 };

/**
 * 从版本列表里挑一个能用的。
 *
 * 规则和 PCL 一致（`ModComp.cs:3770`）：先按版本 + 加载器过滤，剩下的
 * 优先 release，其次发布日期最新；发布时间缺失的排最后。
 *
 * @param {ReturnType<typeof parseMrVersions>} versions
 * @param {{gameVersion?: string, loader?: string, channel?: string}} want
 */
export function pickMrVersion(versions, { gameVersion = '', loader = '', channel = 'release' } = {}) {
  const allowed = allowedChannels(channel);
  const wantVersion = String(gameVersion ?? '').trim();
  const wantLoader = normalizeLoader(loader);

  const candidates = (versions ?? []).filter((v) => {
    if (!allowed.includes(v.versionType)) return false;
    if (!v.fileName || !v.fileUrl) return false;
    if (wantVersion && v.gameVersions.length > 0 && !v.gameVersions.includes(wantVersion)) return false;
    if (wantLoader && v.loaders.length > 0 && !v.loaders.includes(wantLoader)) return false;
    return true;
  });

  candidates.sort((a, b) => {
    const rank = (TYPE_RANK[a.versionType] ?? 9) - (TYPE_RANK[b.versionType] ?? 9);
    if (rank !== 0) return rank;
    const at = Date.parse(a.published) || 0;
    const bt = Date.parse(b.published) || 0;
    return bt - at;
  });
  return candidates[0] ?? null;
}

/**
 * 文件名消毒：只留一个文件名，去掉路径分隔符和各系统非法字符。
 *
 * 为什么要消毒：文件名来自远端 API，直接 path.join 可能被 `..\\` 顶出 mods 目录。
 * 这一步和落盘前的「结果必须在 modsDir 里」两道一起用，见 mod-install.js。
 */
export function sanitizeModFileName(fileName, fallback = 'mod.jar') {
  const raw = String(fileName ?? '').trim();
  if (!raw) return fallback;
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned.toLowerCase().endsWith('.jar') ? cleaned : `${cleaned}.jar`;
}

/**
 * 把结果归并成「给用户看的候选列表」：同一工程只留一条，按下载量排。
 * 面板和工具都用这一份，避免两边排序不一致。
 */
export function rankCandidates(results) {
  const seen = new Set();
  const out = [];
  for (const item of results ?? []) {
    const key = (item.projectId || item.slug || item.title || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
}

/** 下载量的口语化写法：28,495,125 → 2849 万。 */
export function formatDownloads(count) {
  const n = Number(count ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${Math.round(n / 1e4)} 万`;
  return String(n);
}

/** 字节数的口语化写法。 */
export function formatSize(bytes) {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '未知';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}