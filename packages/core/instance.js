/**
 * 实例探测：从一个目录认出「这是哪个 Minecraft 实例、什么版本、什么加载器、装了什么」。
 *
 * 不猜、不乱扫：只认 Minecraft 的标准布局
 *   <root>/versions/<id>/<id>.json + <id>.jar + mods/
 * 也认 PCL/HMCL 的 instances/<id>/ 布局（mods 在实例根）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { McError } from './errors.js';

/** 读 JSON，失败返回 null（配置文件坏了不该炸掉整个探测）。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 目录下某后缀的文件名（不递归）。 */
function filesWithExt(dir, exts) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && exts.some((e) => d.name.toLowerCase().endsWith(e)))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 从版本 json 的 mainClass / libraries / 启动参数推断加载器。
 *
 * 依据是实测过的真实结构，不做模糊猜测：
 *   - NeoForge 1.20.5+ 的入口是 `cpw.mods.bootstraplauncher.BootstrapLauncher`，
 *     但 Forge 1.20.1 也用同一个 BootstrapLauncher，所以光看主类判不出来。
 *   - 真正的判据是 `net.neoforged:` / `net.minecraftforge:` / `net.fabricmc:` 前缀。
 *   - ⚠️ 实测坑：NeoForge 的版本 json 里**没有** `net.neoforged:neoforge:<ver>` 这条
 *     library（有的是 fancymodloader、bus、coremods 等子模块），加载器版本只出现在
 *     `arguments.game` 的 `--fml.neoForgeVersion 21.1.228` 里。所以必须两处都找。
 */
export function detectLoader(versionJson, flatGameArgs = []) {
  const main = String(versionJson?.mainClass ?? '');
  const libs = (versionJson?.libraries ?? []).map((l) => String(l.name ?? ''));
  const hasNeo = libs.some((n) => n.startsWith('net.neoforged:') || n.startsWith('net.neoforged.'));
  const hasForge = libs.some((n) => n.startsWith('net.minecraftforge:'));
  const hasFabric = libs.some((n) => n.startsWith('net.fabricmc:'));

  const argValue = (flag) => {
    const i = flatGameArgs.indexOf(flag);
    if (i >= 0 && flatGameArgs[i + 1]) return flatGameArgs[i + 1];
    const eq = flatGameArgs.find((a) => a.startsWith(`${flag}=`));
    return eq ? eq.slice(flag.length + 1) : '';
  };

  if (hasNeo || /neoforge/i.test(main) || argValue('--fml.neoForgeVersion')) {
    const fromLib = libs.find((n) => n.startsWith('net.neoforged:neoforge:'))?.split(':')[2] ?? '';
    return { loader: 'neoforge', version: argValue('--fml.neoForgeVersion') || fromLib };
  }
  if (hasForge || argValue('--fml.forgeVersion')) {
    const fromLib = libs.find((n) => n.startsWith('net.minecraftforge:forge:'))?.split(':')[2] ?? '';
    return { loader: 'forge', version: argValue('--fml.forgeVersion') || fromLib };
  }
  if (hasFabric) return { loader: 'fabric', version: libs.find((n) => n.startsWith('net.fabricmc:fabric-loader:'))?.split(':')[2] ?? '' };
  if (libs.some((n) => n.startsWith('org.quiltmc:'))) return { loader: 'quilt', version: '' };
  return { loader: 'vanilla', version: '' };
}

/** 把 `arguments.game` 里所有字符串形式的参数摊平（对象形式的按 value 展开）。 */
export function flattenGameArgs(versionJson) {
  const out = [];
  for (const a of versionJson?.arguments?.game ?? []) {
    if (typeof a === 'string') out.push(a);
    else if (Array.isArray(a?.value)) out.push(...a.value.map(String));
    else if (typeof a?.value === 'string') out.push(a.value);
  }
  return out;
}

/**
 * 推断 Minecraft 版本。
 *
 * 实测：NeoForge 的版本 json 里**没有** `com.mojang:minecraft:` 这条 library，
 * 版本号只出现在 `arguments.game` 的 `--fml.mcVersion 1.21.1` 里，以及
 * NeoForge 自身版本号 `21.1.228` 的第一段能反推出 `1.21.1`。
 * 所以按「显式参数 > 加载器版本反推 > 目录名里找 1.x.y」的顺序试。
 */
export function detectMcVersion(versionJson, instanceId = '') {
  const flatArgs = flattenGameArgs(versionJson);
  const idx = flatArgs.findIndex((a) => a === '--fml.mcVersion');
  if (idx >= 0 && flatArgs[idx + 1]) return flatArgs[idx + 1];
  const eq = flatArgs.find((a) => a.startsWith('--fml.mcVersion='));
  if (eq) return eq.split('=')[1];

  const libs = (versionJson?.libraries ?? []).map((l) => String(l.name ?? ''));
  const mojangMc = libs.find((n) => n.startsWith('com.mojang:minecraft:'));
  if (mojangMc) return mojangMc.split(':')[2];

  // NeoForge 21.1.228 → 1.21.1；Forge 47.2.0 → 1.20.1（后者对不上，只能靠参数）
  const neo = libs.find((n) => n.startsWith('net.neoforged:neoforge:'));
  if (neo) {
    const v = neo.split(':')[2] ?? '';
    const m = /^(\d+)\.(\d+)/.exec(v);
    if (m) return `1.${m[1]}.${m[2]}`;
  }

  const fromId = /(\d+\.\d+(?:\.\d+)?)/.exec(instanceId);
  if (fromId) return fromId[1];

  return '';
}

/**
 * 从 mods/*.jar 的元数据里抽 modId（三种回退，见 HANDBOFF §9-5b）。
 * 只读中央目录 + 三个候选文件，不做全量解压。
 */
export function parseModMeta(zip) {
  const toml = zip.text('META-INF/neoforge.mods.toml') ?? zip.text('META-INF/mods.toml');
  if (toml) {
    // 两种写法都要认：
    //   多行    modId = 'xxx'
    //   内联表  { modId = 'xxx', version = '1-v2', ... }   ← Modrinth 导出的数据包常见
    // 所以不能把 ^ 锚定行首。
    //
    // 引号必须分两种匹配：`displayName = "Luki's Crazy Chambers"` 里外层是双引号、
    // 内容含单引号。若写成 ['"]([^'"]+)['"] 会在第一个单引号处截断成 `Luki`。
    const field = (key) => {
      const re = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
      const m = re.exec(toml);
      return m ? (m[1] ?? m[2] ?? '') : '';
    };
    return {
      modId: field('modId'),
      name: field('displayName'),
      version: field('version'),
      updateJson: field('updateJSONURL'),
      source: 'toml',
    };
  }
  const fabric = zip.text('fabric.mod.json');
  if (fabric) {
    try {
      const j = JSON.parse(fabric);
      return {
        modId: j.id ?? '',
        name: j.name ?? '',
        version: j.version ?? '',
        updateJson: '',
        source: 'fabric',
      };
    } catch {
      /* 落到下面的空值 */
    }
  }
  return { modId: '', name: '', version: '', updateJson: '', source: '' };
}

/**
 * 探测一个实例。
 *
 * @param {string} input 可以是 <root>/versions/<id>、<root>、或 instances/<id>
 * @returns {object}
 */
export function inspectInstance(input) {
  if (!input) throw new McError('缺少实例路径', '传 <minecraft 根>/versions/<实例名>');
  const abs = path.resolve(input);
  if (!dirExists(abs)) throw new McError(`目录不存在：${abs}`, '确认路径拼写，或先在启动器里装好这个实例');

  const candidates = [];

  // 情形 A：传的就是 versions/<id>
  if (path.basename(path.dirname(abs)) === 'versions') {
    candidates.push({ instanceDir: abs, mcRoot: path.dirname(path.dirname(abs)), layout: 'versions' });
  }
  // 情形 B：传的是 <root>，里面有 versions/
  if (dirExists(path.join(abs, 'versions'))) {
    for (const d of fs.readdirSync(path.join(abs, 'versions'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      candidates.push({ instanceDir: path.join(abs, 'versions', d.name), mcRoot: abs, layout: 'versions' });
    }
  }
  // 情形 C：PCL/HMCL 的 instances/<id>，mods 直接在实例根
  if (dirExists(path.join(abs, 'mods')) || dirExists(path.join(abs, '.minecraft'))) {
    candidates.push({ instanceDir: abs, mcRoot: dirExists(path.join(abs, '.minecraft')) ? path.join(abs, '.minecraft') : abs, layout: 'instance' });
  }

  if (candidates.length === 0) {
    throw new McError(
      `在 ${abs} 里找不到 Minecraft 实例`,
      '期望布局是 <minecraft 根>/versions/<实例名>/，或含 mods/ 的实例目录',
    );
  }

  // 三种情形会互相重叠（versions/<id> 自己也可能带 mods/），必须按真实路径去重，
  // 否则同一个实例会被当成两个、误报「需要指定 instanceId」。
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    let key;
    try {
      key = fs.realpathSync(c.instanceDir).toLowerCase();
    } catch {
      key = c.instanceDir.toLowerCase();
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  return unique.map((c) => describeInstance(c)).filter(Boolean);
}

/**
 * 沿 `inheritsFrom` 把父版本合并进当前版本 json（返回新对象，不改入参）。
 *
 * 启动器（PCL2 / HMCL）生成的实例常是这个形状：自己的 json 只有
 * `{ id, inheritsFrom, type }`，真正的 mainClass / libraries / arguments.game
 * 全在 `<mcRoot>/versions/<父 id>/<父 id>.json` 里，而父版本自己可能还带一层
 * inheritsFrom（Forge → 1.20.1 → 原版）。不合并的话 detectLoader / detectMcVersion
 * 拿到空壳，会把 Forge 认成 vanilla、MC 版本认成空串（2026-11-04 实测复现）。
 *
 * 合并规则与 `packages/core/launch.js:99` 的 loadVersionJson 对齐：父在前、子在后，
 * libraries 与 arguments.game / jvm 累加，其余字段子覆盖父。两点差别：
 *   ① 父版本读不到时**容错返回当前层**（探测不该因父 json 缺失就整份炸掉）；
 *   ② 用 mcRoot 推父目录，同时兼容「父 json 就放在当前目录」的摆法。
 * depth 上限 5 防 inheritsFrom 成环。
 */
function mergeVersionInheritance(json, mcRoot, jsonFile, depth = 0) {
  if (!json || !json.inheritsFrom || depth >= 5) return json;
  const parentId = String(json.inheritsFrom);
  const candidates = [
    path.join(mcRoot, 'versions', parentId, `${parentId}.json`),
    path.join(path.dirname(jsonFile), `${parentId}.json`),
  ];
  let parent = null;
  for (const f of candidates) {
    const raw = readJson(f);
    if (!raw) continue;
    parent = mergeVersionInheritance(raw, mcRoot, f, depth + 1);
    break;
  }
  if (!parent) return json;
  return {
    ...parent,
    ...json,
    libraries: [...(parent.libraries ?? []), ...(json.libraries ?? [])],
    arguments: {
      game: [...(parent.arguments?.game ?? []), ...(json.arguments?.game ?? [])],
      jvm: [...(parent.arguments?.jvm ?? []), ...(json.arguments?.jvm ?? [])],
    },
  };
}

/** 把候选目录展开成完整描述；认不出来就返回 null 由上层过滤。 */
function describeInstance({ instanceDir, mcRoot, layout }) {
  const id = path.basename(instanceDir);
  let versionJson = null;
  let jsonFile = '';

  // versions 布局：<id>/<id>.json；instance 布局可能叫 version.json / mmc-pack.json
  for (const name of [`${id}.json`, 'version.json', 'mmc-pack.json']) {
    const f = path.join(instanceDir, name);
    const j = readJson(f);
    if (j) {
      versionJson = j;
      jsonFile = f;
      break;
    }
  }
  if (!versionJson) return null;

  // 空壳 json（只有 id + inheritsFrom）必须把父版本合并进来，否则加载器和 MC 版本全认不出。
  versionJson = mergeVersionInheritance(versionJson, mcRoot, jsonFile);

  const loader = detectLoader(versionJson, flattenGameArgs(versionJson));
  const mcVersion = detectMcVersion(versionJson, id);

  // mods 目录：versions 布局在实例目录；instance 布局可能在 .minecraft 下
  const modsDirs = [path.join(instanceDir, 'mods'), path.join(mcRoot, 'mods'), path.join(instanceDir, '.minecraft', 'mods')].filter(dirExists);
  const modsDir = modsDirs[0] ?? path.join(instanceDir, 'mods');
  const jars = filesWithExt(modsDir, ['.jar']);
  const disabled = filesWithExt(modsDir, ['.jar.disabled', '.disabled']);

  const clientJar = [`${id}.jar`, 'client.jar', path.join(mcRoot, 'versions', id, `${id}.jar`)]
    .map((n) => (path.isAbsolute(n) ? n : path.join(instanceDir, n)))
    .find((p) => fs.existsSync(p)) ?? '';

  const dirs = ['config', 'kubejs', 'scripts', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'saves', 'logs', 'crash-reports']
    .filter((d) => dirExists(path.join(instanceDir, d)));
  const questDirs = ['config/ftbquests/quests', 'config/betterquesting', 'config/ftbquests']
    .map((d) => path.join(instanceDir, d))
    .filter(dirExists);

  // 散装资源目录（2026-11-03 实测补的）：KubeJS 的 `kubejs/assets/` 里可以放
  // 章节背景图这类资源，游戏当资源包加载，但它们**不在任何 jar 里**。
  // 只扫 jar 的话，真实包「重度机械症」12 张章节背景图里有 6 张取不到。
  const assetDirs = [
    path.join(instanceDir, 'kubejs', 'assets'),
    path.join(instanceDir, '.minecraft', 'kubejs', 'assets'),
    path.join(mcRoot, 'kubejs', 'assets'),
  ].filter(dirExists);
  // 资源包目录：里面的 zip 条目也叫 assets/...，跟 jar 一样处理
  const resourcepackDirs = [
    path.join(instanceDir, 'resourcepacks'),
    path.join(mcRoot, 'resourcepacks'),
  ].filter(dirExists);

  return {
    id,
    instanceDir,
    mcRoot,
    layout,
    versionJsonFile: jsonFile,
    mainClass: String(versionJson.mainClass ?? ''),
    mcVersion,
    loader: loader.loader,
    loaderVersion: loader.version,
    javaVersion: versionJson.javaVersion ?? null,
    modsDir,
    modsCount: jars.length,
    disabledModsCount: disabled.length,
    clientJar,
    hasClientJar: Boolean(clientJar),
    presentDirs: dirs,
    questDirs,
    assetDirs,
    resourcepackDirs,
  };
}

/**
 * 选一个实例：传目录时若匹配到多个，用 instanceId 精确挑；只有一个就直接用。
 * 这是所有 mc_* 工具的统一入口，所以错误话术要能直接指导用户。
 */
export function resolveInstance(instanceDir, instanceId = '') {
  const all = inspectInstance(instanceDir);
  if (all.length === 0) {
    throw new McError(`在 ${path.resolve(instanceDir)} 下没找到可识别的实例（缺版本 json）`, '确认传的是含 <实例名>.json 的目录');
  }
  if (instanceId) {
    const hit = all.find((i) => i.id === instanceId);
    if (!hit) {
      throw new McError(
        `没找到实例 ${instanceId}；可选：${all.map((i) => i.id).join(', ')}`,
        '修正 instanceId，或不传让它自动选中唯一实例',
      );
    }
    return hit;
  }
  if (all.length > 1) {
    throw new McError(
      `这个目录下有 ${all.length} 个实例，需要指定 instanceId：${all.map((i) => i.id).join(', ')}`,
      '传 instanceId 精确指定',
      'McAmbiguous',
    );
  }
  return all[0];
}
