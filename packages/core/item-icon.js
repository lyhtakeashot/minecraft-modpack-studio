/**
 * 墙上的告示牌/画布告示牌 → 同名「能拿在手上」的那种（最保守的一条别名规则）。
 *
 * 规则只有一条：把名字里的 `_wall_` 去掉。`oak_wall_sign` → `oak_sign`、
 * `white_wall_canvas_sign` → `white_canvas_sign`、`wall_hanging_canvas_sign` →
 * `hanging_canvas_sign`（FarmersDelight 那种没有颜色前缀的）。别名不存在就没图，不会乱借。
 */
function signAliasOf(id) {
  const colon = id.indexOf(':');
  if (colon <= 0) return null;
  const ns = id.slice(0, colon);
  const name = id.slice(colon + 1);
  if (!name.endsWith('sign')) return null;
  if (name.includes('_wall_')) return `${ns}:${name.replace('_wall_', '_')}`;
  if (name.startsWith('wall_')) return `${ns}:${name.slice('wall_'.length)}`;
  return null;
}

/**
 * jarjar 内嵌 jar 的条目（ForgeJarJar 机制：把整个 mod 塞进 `META-INF/jarjar/xxx.jar`）。
 */
const JARJAR_RE = /^META-INF\/jarjar\/(.+\.jar)$/;

/**
 * 虚拟 jar 键：`<外层 jar 路径>!/<内层条目路径>`。
 *
 * 为什么需要它：内嵌 jar 的字节在**内存里**，没有磁盘路径，
 * 而索引里每条贴图/模型引用都记着一个 `jar` 路径（读取处统一按路径 `fs.readFileSync`）。
 * 于是给内层 jar 造一个「看起来像路径」的键，读的时候再拆开：
 * 外层按路径读 → 从外层里取出内层字节 → 单独开一个 zip。
 */
function nestedJarKey(outer, entry) {
  return `${outer}!/${entry}`;
}

/** 外层 jar 的 zip 缓存（虚拟键要用）：路径 → {zip, at}。 */
const outerZipCache = new Map();

/** 取外层 jar 的 zip（带 10 分钟缓存，跟索引缓存同期）。 */
function outerZipOf(outer) {
  const hit = outerZipCache.get(outer);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.zip;
  let zip = null;
  try {
    zip = openZip(fs.readFileSync(outer));
  } catch {
    zip = null;
  }
  outerZipCache.set(outer, { zip, at: Date.now() });
  return zip;
}

/**
 * 打开一个 jar 引用：普通路径，或 `<外层>!/<内层条目>` 虚拟键。
 * @param {string} ref
 * @returns {ReturnType<typeof openZip>|null}
 */
function openJarRef(ref) {
  if (!ref) return null;
  const mark = ref.indexOf('!/');
  if (mark < 0) return outerZipOf(ref);
  const outer = outerZipOf(ref.slice(0, mark));
  if (!outer) return null;
  try {
    return openZip(outer.read(ref.slice(mark + 2)));
  } catch {
    return null;
  }
}
/**
 * 物品图标：把「minecraft:crafting_table」这种 ID 变成一张能画的 PNG。
 *
 * 为什么值得单独做一层：任务书在游戏里是「一格一个物品图标」的，
 * 面板上如果只显示文字，用户得靠 ID 认东西 —— 这跟「图形化」的目标是拧着的。
 *
 * 图标从哪来（按优先级，全都在本机，不联网）：
 *   1. 装的 mod 的 jar 里 `assets/<命名空间>/textures/item/<名字>.png`
 *   2. 同上，但走 `textures/block/` —— 很多「方块物品」的贴图就放在 block 下
 *   3. 模型 json：`assets/<ns>/models/item/<名字>.json` 里 textures.layer0 / all / particle
 *      指的贴图，再顺着 parent 往上找一层。有些 mod 的物品贴图不叫物品名，只靠这一层能捞回来。
 *      物品模型没有的话，退而求其次用 `models/block/<名字>.json`。
 *   4. 液体：`textures/(block|fluid)/<名字>_still.png`。水/岩浆、Create 的蜂蜜/巧克力
 *      贴图都叫 `xxx_still`，物品 ID 里可没有 `_still` 这段，得单独登记一张表。
 *   5. 原版物品：1.13 之后客户端 jar 里没有贴图，得查 `assets/indexes/<id>.json`
 *      拿到 hash，再去 `assets/objects/<前2位>/<hash>` 读。
 *
 * 客户端 jar 也要进索引（`opts.extraJars`）：原版方块物品的贴图根本不叫
 * `textures/item/<名字>.png`，而是 tnt.json → block/tnt 这样走模型链，
 * 模型和贴图都在客户端 jar 里。只扫 mods 目录会漏掉整片原版方块。
 *
 * 没有图标是正常情况（有些物品是纯程序生成的贴图），调用方自己画个字母方块就行。
 *
 * 性能：一个千 mod 的包有几百个 jar、几十万个条目，逐个 item 去扫是不可接受的。
 * 所以第一次要图标时建一份「物品 ID → 在哪个 jar 的哪个条目」的索引（读一遍所有 jar 的
 * 中央目录名字，不保留缓冲区），之后按 jar 分组批量取 —— 一个 jar 只打开一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from './zip.js';
import { buildExportIndex, findExportDirs, readExportedIcons } from './icon-export.js';
import { animatedFrames, pngFirstFrame } from './png-frame.js';
import { decodeTexture, loadModelChain, renderModelIcon } from './model-render.js';

/**
 * 贴图 Buffer → 图标对象。
 *
 * 动态贴图（水、岩浆、Create 的流体）是竖着排的 N 帧，直接塞进页面会被挤成一条
 * 细线，看着就像「这个物品没有图标」。这里统一裁成第一帧。
 */
function iconFromPng(png, source) {
  const anim = animatedFrames(png);
  const frame = anim ? pngFirstFrame(png) : null;
  const use = frame ?? png;
  const icon = {
    dataUrl: `data:image/png;base64,${use.toString('base64')}`,
    bytes: use.length,
    source,
  };
  if (anim) icon.frames = anim.frames;
  return icon;
}

/** `assets/<ns>/textures/<item|block|fluid>/<name>.png`（第 2 组是种类，液体兜底要用） */
const TEXTURE_RE = /^assets\/([^/]+)\/textures\/(item|block|fluid)\/(.+)\.png$/;
/** `assets/<ns>/models/item/<name>.json` */
const MODEL_RE = /^assets\/([^/]+)\/models\/item\/(.+)\.json$/;
/** `assets/<ns>/models/block/<name>.json`（物品模型缺失时的兜底） */
/** `assets/<ns>/models/block/<name>.json`：判断「这个 ID 有没有方块形态」用，不再拿它出图标。 */
const BLOCK_MODEL_RE = /^assets\/([^/]+)\/models\/block\/(.+)\.json$/;
/** `assets/<ns>/blockstates/<name>.json`：模型藏在子目录里时，只有它知道该用哪个模型。 */
const BLOCKSTATE_RE = /^assets\/([^/]+)\/blockstates\/(.+)\.json$/;
/** 液体贴图：`<base>_still.png` / `<base>_flow.png` → 物品 ID `<ns>:<base>` */
const FLUID_RE = /^(.+)_(still|flow)$/;

/**
 * 模型 parent 链最多往上追几层。
 *
 * 有些 mod（Create 就是典型）物品模型只有一行 `parent: create:block/shaft`，
 * 贴图定义在方块模型里；再往上还可能接原版的 cube_all。追太深没意义，6 层够用。
 */
const MAX_PARENT_DEPTH = 6;

/** 一次最多解析多少个物品（防止界面一口气要几万个）。 */
export const ICON_LIMIT = 128;
/** 单张贴图上限。MC 贴图都在几十 KB 以内，超过这个尺寸的多半不是图标。 */
const MAX_PNG_BYTES = 1024 * 1024;
/** 索引与结果的过期时间。 */
const TTL_MS = 10 * 60 * 1000;

/** mods 目录 → 纹理索引。键是目录小写形式（Windows 路径不分大小写）。 */
const indexCache = new Map();
/** `${modsDir}|${itemId}` → data URL。图标很小，直接按物品缓存。 */
const iconCache = new Map();
/** mcRoot → 原版资源索引里的贴图表（key 形如 minecraft/textures/item/apple.png）。 */
const vanillaCache = new Map();
/** 客户端 jar 路径 → 打开好的 zip（原版贴图兜底来源）。 */
const jarCache = new Map();

/** 把 ID 规整成 `ns:name`；没写命名空间按 minecraft 算。MC 的物品 ID 全是小写。 */
export function normalizeItemId(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const id = text.includes(':') ? text : `minecraft:${text}`;
  const [ns, ...rest] = id.split(':');
  const name = rest.join(':');
  if (!/^[a-z0-9_.-]+$/i.test(ns) || !name) return '';
  return `${ns.toLowerCase()}:${name.toLowerCase()}`;
}

/**
 * 把 `opts.extraJars` 规整成「绝对路径、去重、排序」的数组。
 *
 * 排序是为了让缓存键稳定：两个调用方传的顺序不一样时，应该共用同一份索引。
 */
function normalizeExtraJars(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    const abs = path.resolve(text);
    const lc = abs.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(abs);
  }
  return out.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
}

/**
 * 索引缓存键。
 *
 * 必须把 extraJars 算进去：先建「只扫 mods 目录」的索引、再建「带上客户端 jar」的，
 * 两者的结果差着几千个原版条目，共用一个键会把后者当成命中，等于白改。
 */
function indexCacheKey(modsDir, extraJars) {
  return `${String(modsDir ?? '').toLowerCase()}||${extraJars.map((p) => p.toLowerCase()).join('|')}`;
}

/**
 * 建（或取缓存的）纹理索引。
 *
 * @param {string} modsDir
 * @param {{force?: boolean, extraJars?: string[]}} [opts]
 *   `extraJars`：额外的 jar 绝对路径（典型是客户端本体 `instance.clientJar`），
 *   里面的贴图和模型跟 mods 目录里的 jar 走完全一样的索引表。
 * @returns {{modsDir: string, extraJars: string[], jars: number, textures: number, models: number, blockModels: number,
 *            elapsedMs: number, at: number,
 *            byId: Map<string, {jar: string, entry: string}>,
 *            byPrefix: Map<string, {jar: string, entry: string}>,
 *            modelsById: Map<string, {jar: string, entry: string}>,
 *            blockModelsById: Map<string, {jar: string, entry: string}>,
 *            stillById: Map<string, {jar: string, entry: string}>}}
 */
export function buildTextureIndex(modsDir, opts = {}) {
  const extraJars = normalizeExtraJars(opts.extraJars);
  const key = indexCacheKey(modsDir, extraJars);
  const hit = indexCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < TTL_MS) return hit.index;

  const started = Date.now();
  const byId = new Map();
  const modelsById = new Map();
  /** `models/block/<名字>.json`：物品模型不存在时的兜底（方块物品常常只有 block 模型）。 */
  const blockModelsById = new Map();
  /** 只以目录形式存在的 block 模型：`create:belt` → `assets/create/models/block/belt/*.json`。 */
  const blockModelDirs = new Set();
  /**
   * `assets/<ns>/blockstates/<名字>.json`：连 block 模型都不叫这个名的东西。
   *
   * 例子是 `create:andesite_belt_funnel` 和 `create:rope`：它们的模型在
   * `models/block/belt_funnel/*.json`、`models/block/rope_pulley/*.json` 这种子目录里，
   * 只有 blockstate 知道该用哪一个。以前靠这条链取「其中一张贴图」，会拿到别的物品的样子；
   * 现在只用它拿到模型，再整张等轴测画出来（跟 JEI 一样）。
   */
  const blockStateById = new Map();
  /**
   * 液体兜底表：`minecraft:water` → `assets/minecraft/textures/block/water_still.png`
   *
   * 为什么要单独一张：液体贴图叫 `water_still` / `water_flow`，物品 ID 却是 `water`，
   * 按同名去找永远找不到。`_still` 比 `_flow` 好看也更稳（静态帧），所以先用 still。
   */
  const stillCandidates = new Map();
  const flowCandidates = new Map();
  /**
   * 子目录贴图的兜底表：`create:water_wheel` → `assets/create/textures/block/water_wheel/0.png`
   *
   * 为什么要这一层：不少 mod 的贴图是「方块名/序号.png」这样放在子目录里的
   * （Create 的水车、齿轮箱都是），贴图根本不叫 `water_wheel.png`。
   * 只按完整文件名找会漏掉整整一批物品。
   */
  const byPrefix = new Map();
  /**
   * 只收「手持物品」的贴图：`textures/item/<名字>.png`（含子目录前缀表）。
   *
   * 为什么要单独一张：同一个 ID 在 `textures/item/` 和 `textures/block/` 里可能各有一张
   * （`tnt`、`furnace`、绝大多数方块物品）。用户要的是**物品图标**（JEI 里那种拿在手上的），
   * 不是放置出来的方块贴图。jar 里的条目顺序里 `textures/block` 排在 `textures/item` 前面，
   * 只留一张 `byId` 的话会先被 block 那张占住 —— 界面上就像「放置出来的样子」。
   */
  const itemTexById = new Map();
  const itemTexByPrefix = new Map();
  let jars = 0;
  let textures = 0;
  let models = 0;

  let entries = [];
  try {
    entries = fs.readdirSync(modsDir).sort();
  } catch {
    // 没有 mods 目录不是错：纯原版包也允许看
  }

  /** 扫一个 jar，把贴图 / 模型 / 液体都记进上面那几张表；读不了就返回 false（别拖垮整个索引）。 */
  const scanJar = (full) => {
    let buffer;
    let zip;
    try {
      buffer = fs.readFileSync(full);
      zip = openZip(buffer);
    } catch {
      return false;
    }
    jars++;
    // 扫一个 zip（顶层或 jarjar 内层）；`jarRef` 是写进索引表的 jar 引用
    // （内层用「虚拟键」`<外层>!/<内层条目>`，因为内层字节只在内存里）。
    const scan = (z, jarRef) => {
      for (const entry of z.names) {
        const tex = TEXTURE_RE.exec(entry);
        if (tex) {
          textures++;
          const ns = tex[1];
          const kind = tex[2];
          const rel = tex[3];
          const id = `${ns}:${rel}`;
          if (!byId.has(id)) byId.set(id, { jar: jarRef, entry, kind });
          // 有子目录的话，再按「第一段」登记一次，给 byPrefix 用
          const slash = rel.indexOf('/');
          if (slash > 0) {
            const prefixId = `${ns}:${rel.slice(0, slash)}`;
            if (!byPrefix.has(prefixId)) byPrefix.set(prefixId, { jar: jarRef, entry, kind });
          }
          // 手持物品的贴图单独记一份：第 1 轮优先用它（见 itemTexById 的注释）
          if (kind === 'item') {
            if (!itemTexById.has(id)) itemTexById.set(id, { jar: jarRef, entry });
            if (slash > 0) {
              const prefixId = `${ns}:${rel.slice(0, slash)}`;
              if (!itemTexByPrefix.has(prefixId)) itemTexByPrefix.set(prefixId, { jar: jarRef, entry });
            }
          }
          // 液体兜底：textures/(block|fluid)/<base>_still.png、<base>_flow.png → <ns>:<base>
          if (kind !== 'item') {
            const fluid = FLUID_RE.exec(rel);
            if (fluid) {
              const table = fluid[2] === 'still' ? stillCandidates : flowCandidates;
              const fluidId = `${ns}:${fluid[1]}`;
              if (!table.has(fluidId)) table.set(fluidId, { jar: jarRef, entry });
            }
          }
          continue;
        }
        const model = MODEL_RE.exec(entry);
        if (model) {
          models++;
          const id = `${model[1]}:${model[2]}`;
          if (!modelsById.has(id)) modelsById.set(id, { jar: jarRef, entry });
          continue;
        }
        const blockModel = BLOCK_MODEL_RE.exec(entry);
        if (blockModel) {
          const id = `${blockModel[1]}:${blockModel[2]}`;
          if (!blockModelsById.has(id)) blockModelsById.set(id, { jar: jarRef, entry });
          // `models/block/belt/middle.json` 这种「目录形式」的多部件模型：记下目录本身。
          // 传送带（create:belt）就是这样 —— 一组零件模型共用同一条平铺贴图配 UV 子区域，
          // 拿那条贴图当物品图标就是一条条纹，看着就是错的（见 isMultipartOnlyBlock）。
          const slash = blockModel[2].indexOf('/');
          if (slash > 0) blockModelDirs.add(`${blockModel[1]}:${blockModel[2].slice(0, slash)}`);
          continue;
        }
        const blockState = BLOCKSTATE_RE.exec(entry);
        if (blockState) {
          const id = `${blockState[1]}:${blockState[2]}`;
          if (!blockStateById.has(id)) blockStateById.set(id, { jar: jarRef, entry });
        }
      }
    };
    scan(zip, full);
    // jarjar 内嵌 mod：那些 mod 的物品在游戏里真实存在，不扫就永远画不出图标。
    // 内层字节在内存里 → 用「虚拟键」记引用，读的时候现拆（见 openJarRef）。
    for (const entry of zip.names) {
      const nested = JARJAR_RE.exec(entry);
      if (!nested) continue;
      let inner;
      try {
        inner = openZip(zip.read(entry));
      } catch {
        continue;
      }
      scan(inner, nestedJarKey(full, entry));
    }
    return true;
  };

  const indexed = new Set(); // 已经扫过的 jar（小写绝对路径），防止 extraJars 和 mods 目录重复
  for (const fileName of entries) {
    if (!fileName.toLowerCase().endsWith('.jar')) continue;
    const full = path.join(modsDir, fileName);
    indexed.add(path.resolve(full).toLowerCase());
    scanJar(full);
  }
  // 额外的 jar（客户端本体）跟 mods 里的 jar 完全一样对待：同一套 byId / byPrefix / 模型表
  for (const jar of extraJars) {
    if (indexed.has(jar.toLowerCase())) continue;
    if (!fs.existsSync(jar)) continue; // 调用方给了路径但文件没了：跳过，不报错
    scanJar(jar);
  }

  // `_still` 优先于 `_flow`：哪怕是别的 jar 里的 still，也比先扫到的 flow 更合适
  const stillById = new Map(stillCandidates);
  for (const [id, ref] of flowCandidates) if (!stillById.has(id)) stillById.set(id, ref);

  const index = {
    modsDir,
    extraJars,
    jars,
    textures,
    models,
    blockModels: blockModelsById.size,
    elapsedMs: Date.now() - started,
    at: Date.now(),
    byId,
    byPrefix,
    itemTexById,
    itemTexByPrefix,
    modelsById,
    blockModelsById,
    blockModelDirs,
    blockStateById,
    stillById,
  };
  indexCache.set(key, { at: index.at, index });
  return index;
}

/** 原版贴图表：`minecraft/textures/item/apple.png` → 对象存储里的 hash。 */
function vanillaTextures(instance) {
  const mcRoot = String(instance.mcRoot ?? '');
  if (!mcRoot) return null;
  const hit = vanillaCache.get(mcRoot.toLowerCase());
  if (hit && Date.now() - hit.at < TTL_MS) return hit.table;

  const assetsDir = path.join(mcRoot, 'assets');
  const idxDir = path.join(assetsDir, 'indexes');
  const table = new Map();
  if (!fs.existsSync(idxDir)) {
    vanillaCache.set(mcRoot.toLowerCase(), { at: Date.now(), table });
    return table;
  }

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };

  // 优先版本 json 指的那个索引，拿不到就把 indexes 目录里的都读一遍
  const ids = [];
  const versionJson = readJson(instance.versionJsonFile ?? '');
  if (versionJson?.assetIndex?.id) ids.push(String(versionJson.assetIndex.id));
  try {
    for (const f of fs.readdirSync(idxDir)) {
      if (f.toLowerCase().endsWith('.json')) ids.push(f.slice(0, -5));
    }
  } catch {
    /* 读不了就只靠版本 json */
  }

  for (const id of [...new Set(ids)]) {
    const index = readJson(path.join(idxDir, `${id}.json`));
    const objects = index?.objects;
    if (!objects || typeof objects !== 'object') continue;
    for (const [key, obj] of Object.entries(objects)) {
      if (!key.startsWith('minecraft/textures/')) continue;
      if (!key.endsWith('.png')) continue;
      const hash = String(obj?.hash ?? '');
      if (!/^[0-9a-f]{40}$/i.test(hash)) continue;
      if (!table.has(key)) table.set(key, hash);
    }
  }
  vanillaCache.set(mcRoot.toLowerCase(), { at: Date.now(), table });
  return table;
}

/** 读原版贴图对象（1.13+ 的贴图不在 jar 里）。 */
function readVanillaPng(instance, itemName) {
  const table = vanillaTextures(instance);
  const mcRoot = String(instance.mcRoot ?? '');
  if (table && table.size > 0) {
    for (const kind of ['item', 'block']) {
      const hash = table.get(`minecraft/textures/${kind}/${itemName}.png`);
      if (!hash) continue;
      try {
        const file = path.join(mcRoot, 'assets', 'objects', hash.slice(0, 2), hash);
        const buf = fs.readFileSync(file);
        if (buf.length > MAX_PNG_BYTES) continue;
        return { png: buf, source: `原版资源 ${kind}/${itemName}.png` };
      } catch {
        continue;
      }
    }
  }
  // 兜底：资源索引里没有贴图（有些安装只装了语言文件那部分对象）时，
  // 直接从客户端 jar 里读 —— 原版贴图在 jar 里一定有，这是最可靠的一份。
  const fromJar = readVanillaFromJar(instance, itemName);
  if (fromJar) return fromJar;
  return null;
}

/**
 * 从客户端 jar 里抠原版贴图。
 *
 * 为什么需要这条：`assets/indexes/<id>.json` 可能不完整（实测有台的索引里
 * 一个 `minecraft/textures/item/` 键都没有），那时按 hash 查资源对象永远查不到；
 * 而 `versions/<ver>/<ver>.jar` 里 `assets/minecraft/textures/item/*.png` 是全的。
 */
function readVanillaFromJar(instance, itemName) {
  const candidates = [];
  if (instance.clientJar) candidates.push(String(instance.clientJar));
  const mcRoot = String(instance.mcRoot ?? '');
  if (mcRoot) {
    try {
      const versionsDir = path.join(mcRoot, 'versions');
      for (const name of fs.readdirSync(versionsDir)) {
        const jar = path.join(versionsDir, name, `${name}.jar`);
        if (fs.existsSync(jar)) candidates.push(jar);
      }
    } catch {
      /* 没有 versions 目录就算了 */
    }
  }

  for (const jar of candidates) {
    if (!jarCache.has(jar) || Date.now() - jarCache.get(jar).at >= TTL_MS) {
      try {
        jarCache.set(jar, { at: Date.now(), zip: openZip(fs.readFileSync(jar)) });
      } catch {
        jarCache.set(jar, { at: Date.now(), zip: null });
      }
    }
    const zip = jarCache.get(jar).zip;
    if (!zip) continue;
    for (const kind of ['item', 'block']) {
      const entry = `assets/minecraft/textures/${kind}/${itemName}.png`;
      if (!zip.has(entry)) continue;
      let png;
      try {
        png = zip.read(entry);
      } catch {
        continue;
      }
      if (!png || png.length > MAX_PNG_BYTES) continue;
      return { png, source: `${path.basename(jar)} → ${entry}` };
    }
  }
  return null;
}

/** 挂在贴图索引上的缓存键：`ns:item/x` → 模型条目。见 makeAssetSource。 */
const BY_REF = Symbol('mcsAssetByRef');

/**
 * 模型/贴图引用不带命名空间时，按 Minecraft 的规矩补 `minecraft:` —— **不是**补模型自己的命名空间。
 *
 * `{"parent": "item/template_spawn_egg"}` 在游戏里找的是原版那个刷怪蛋模型；
 * 以前补成 `<mod>:item/template_spawn_egg`，于是整批刷怪蛋、以及所有
 * 「parent 只写半截」的 mod 模型全都走到了死胡同（2026-11-05 实测：762 个没图标里
 * 有 185 个是这么断的）。
 *
 * 但也确实有 mod 手滑，想指自己的却只写了半截路径。所以这里返回**候选顺序**：
 * 先按游戏规矩（minecraft），再退回本体命名空间，谁真存在谁赢 —— 这样只会多认，不会少认。
 *
 * @param {string} raw 模型里写的原始引用
 * @param {string} ownNs 写这行引用的模型自己的命名空间
 * @returns {string[]} 形如 `['minecraft:item/generated', 'mymod:item/generated']`
 */
function refCandidates(raw, ownNs) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (text.includes(':')) return [text];
  const out = [`minecraft:${text}`];
  if (ownNs && ownNs !== 'minecraft') out.push(`${ownNs}:${text}`);
  return out;
}

/** `assets/<ns>/models/<path>.json` → `ns:path`；不是模型条目就返回空串。 */
function modelRefOf(entry) {
  const m = /^assets\/([^/]+)\/models\/(.+)\.json$/.exec(String(entry ?? ''));
  return m ? `${m[1]}:${m[2]}` : '';
}

/**
 * 跨 jar 的资源读取器：模型要按「父模型可能在别的 jar」来找，贴图也可能在别的 jar。
 *
 * 为什么非要有这一层：一个方块物品的物品模型常常只写
 * `{"parent": "minecraft:block/cube", "textures": {...}}` —— 形状（`elements`）在原版
 * 客户端 jar 的 `models/block/cube.json` 里，贴图在 mod 自己的 jar 里。以前父模型只在
 * 「当前这个 jar」里找，找不到就当链断了，于是整类箱子/袋子/告示牌都画不出来
 * （`cratedelight:ender_dust_bag`、`create:*_nixie_tube` 都是这个原因）。
 *
 * @param {object} index buildTextureIndex 的产物
 * @returns {{readModelJson: (ref: string) => object|null, hasModel: (ref: string) => boolean,
 *            readTexture: (ref: string) => Buffer|null}}
 */
function makeAssetSource(index) {
  // 索引里那两张表是按**条目路径**建的，而模型里写引用用的是一律 `ns:item/x` 的形状
  // （`item/tnt`、`block/cube`）。这里先建一张「引用 → 条目」的表，查找才对得上。
  //
  // 挂在 index 上缓存：resolveIcons 是分批调的（一页 128 个），这张表有几万条，
  // 每批都重建一遍纯属白烧 CPU。
  /** @type {Map<string, {jar: string, entry: string}>} */
  let byRef = index[BY_REF];
  if (!byRef) {
    byRef = new Map();
    for (const table of [index.modelsById, index.blockModelsById]) {
      if (!table) continue;
      for (const hit of table.values()) {
        const ref = modelRefOf(hit?.entry);
        if (ref && !byRef.has(ref)) byRef.set(ref, hit);
      }
    }
    index[BY_REF] = byRef;
  }

  /** jar 引用 → 打开好的 zip（同一个 jar 一轮里只读一次）。 */
  const zips = new Map();
  const zipOf = (jar) => {
    if (!jar) return null;
    if (!zips.has(jar)) {
      zips.set(jar, openJarRef(jar));
    }
    return zips.get(jar);
  };

  return {
    /** ref 形如 `create:block/shaft`（不带 `models/`）。 */
    readModelJson(ref) {
      const hit = byRef.get(ref);
      if (!hit) return null;
      const zip = zipOf(hit.jar);
      if (!zip || !zip.has(hit.entry)) return null;
      const text = zip.text(hit.entry);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    hasModel(ref) {
      return byRef.has(ref);
    },
    /** ref 形如 `create:block/shaft` / `minecraft:item/apple` / `create:shaft`。 */
    readTexture(ref) {
      const [ns, rel] = String(ref ?? '').split(':');
      if (!ns || !rel) return null;
      const key = `${ns}:${rel.replace(/^(?:item|block|fluid)\//, '')}`;
      // 先按引用里写的那一段找（`block/x` 就去 block 目录），再试另外两个目录
      const wanted = [];
      if (/^(?:item|block|fluid)\//.test(rel)) wanted.push(`assets/${ns}/textures/${rel}.png`);
      wanted.push(
        `assets/${ns}/textures/item/${rel}.png`,
        `assets/${ns}/textures/block/${rel}.png`,
        `assets/${ns}/textures/${rel}.png`,
      );
      const hits = [
        index.byId?.get(key),
        index.byPrefix?.get(key),
        index.itemTexById?.get(key),
        index.itemTexByPrefix?.get(key),
      ].filter(Boolean);
      const seen = new Set();
      for (const hit of hits) {
        if (seen.has(hit.jar)) continue;
        seen.add(hit.jar);
        const zip = zipOf(hit.jar);
        if (!zip) continue;
        for (const entry of wanted) {
          if (!zip.has(entry)) continue;
          let png = null;
          try {
            png = zip.read(entry);
          } catch {
            png = null;
          }
          if (png && png.length && png.length <= MAX_PNG_BYTES) return png;
        }
      }
      return null;
    },
  };
}

/**
 * 从模型 json 里找出它**可能**用的贴图引用，按优先级排成一串（会顺着 parent 往上追）。
 *
 * 为什么要给一串而不是一个：`kaleidoscope_doll` 的方块模型写的是
 * `{"0": "kaleidoscope_doll:block/doll/doll_1", "particle": "block/glass"}`，
 * 而 `block/glass` 在它自己的 jar 里根本没有 —— 只取第一个候选就永远拿不到图。
 * 调用方按这个顺序挨个试，第一个真的存在的贴图胜出。
 *
 * 顺序沿用原来的取法：layer0 → all → particle → texture → 其余字符串值。
 * 对原版 `cube_bottom_top` 这类模型没有 layer0/all/particle，会落到 `bottom` 或 `side`，
 * 至少是那个方块自己的贴图，这是可接受的。
 *
 * @param {{readModelJson(ref: string): object|null, hasModel(ref: string): boolean}} source 跨 jar 读取器
 * @param {string} startRef 起点模型引用，形如 `create:item/shaft`（不带 `models/`）
 * @param {number} [depth] 还能往上追几层
 * @param {string[]} [out] 累积结果（递归用）
 * @returns {string[]} 形如 [`create:block/shaft`]，找不到返回空数组
 */
function textureRefsFromModel(source, startRef, depth = MAX_PARENT_DEPTH, out = []) {
  const json = source.readModelJson(startRef);
  if (!json) return out;
  const ns = String(startRef).split(':')[0];

  const add = (t) => {
    if (typeof t !== 'string') return;
    const raw = t.trim();
    if (!raw || raw.startsWith('#')) return; // `#all` 是指向模型里另一个变量，不是贴图路径
    // 不带命名空间的贴图引用按游戏规矩补 `minecraft:`，再把本体命名空间当兜底候选
    for (const ref of refCandidates(raw, ns)) {
      const refPath = ref.slice(ref.indexOf(':') + 1);
      if (!refPath || !refPath.includes('/')) continue;
      if (!out.includes(ref)) out.push(ref);
    }
  };
  // 先按「贴图键名」的常见画法挑：`layer0` 是 2D 图，`side`/`front` 是方块物品最像图标的那张，
  // `base` 是 Create 系机器的本体。最后才按 object 里的出现顺序全收（兜底）。
  // 不这么排的话，`block/cube_bottom_top` 这类模型（tnt / 工作台 / 熔炉）会把底面的
  // 贴图排在第一位，图标就变成一张引信或一块木头。
  for (const key of ['layer0', 'all', 'side', 'front', 'base', 'north', 'top', 'end', 'cross', 'particle', 'texture']) {
    add(json?.textures?.[key]);
  }
  for (const v of Object.values(json?.textures ?? {})) add(v);

  // 三维模型（带 elements）：按「面片总面积」给候选排序。
  //
  // JEI 是把整个模型按等轴测画出来；我们只有一张静态图，就取**占面积最大那面**用的贴图 ——
  // 箱子取到箱面、TNT 取到侧面、漏斗取到本体。不这么做的话拿到的是模型里「第一个存在的
  // 贴图」，箱子会变成一张木板（particle）、TNT 变成底面，看着就是错的。
  if (Array.isArray(json?.elements) && json.elements.length) {
    const score = new Map();
    const refOf = (raw) => {
      let ref = typeof raw === 'string' ? raw.trim() : '';
      for (let guard = 0; ref.startsWith('#') && guard < 4; guard += 1) {
        const key = ref.slice(1);
        ref = typeof json.textures?.[key] === 'string' ? json.textures[key].trim() : '';
      }
      if (!ref || ref.startsWith('#')) return '';
      const full = refCandidates(ref, ns)[0] ?? '';
      return full.includes('/') ? full : '';
    };
    for (const el of json.elements) {
      const from = el?.from;
      const to = el?.to;
      if (!Array.isArray(from) || !Array.isArray(to)) continue;
      const dx = Math.abs(Number(to[0]) - Number(from[0])) || 0;
      const dy = Math.abs(Number(to[1]) - Number(from[1])) || 0;
      const dz = Math.abs(Number(to[2]) - Number(from[2])) || 0;
      for (const [faceName, face] of Object.entries(el?.faces ?? {})) {
        const area =
          faceName === 'north' || faceName === 'south' ? dx * dy
            : faceName === 'east' || faceName === 'west' ? dz * dy
              : dx * dz;
        // 竖着的面（东南西北）比上下两面更接近「看图标时看到的那一面」：
        // `minecraft:tnt` 的模型里 side / top / bottom 面积一模一样，不给竖面加权就会挑到
        // 底面（一张引信图），看着就不像 TNT。
        const weight = faceName === 'up' || faceName === 'down' ? 1 : 1.5;
        const ref = refOf(face?.texture);
        if (!ref) continue;
        score.set(ref, (score.get(ref) ?? 0) + area * weight);
      }
    }
    if (score.size) {
      // 不在这里排序：模型常常是「item 模型只有 textures、父模型才有 elements」，
      // 在父层排序只能挪动父层新加的引用，子层的（particle 之类）还压在前面。
      // 把面积累计到 out.scores 上，由调用方在追完 parent 之后统一排。
      if (!out.scores) out.scores = new Map();
      for (const [ref, area] of score) out.scores.set(ref, (out.scores.get(ref) ?? 0) + area);
    }
  }

  if (depth <= 0) return out;
  const parent = typeof json?.parent === 'string' ? json.parent.trim() : '';
  if (!parent) return out;
  // parent 两种写法都见过：`create:block/shaft`（带命名空间）和 `block/shaft`（按规矩补 minecraft:）。
  // 父模型可能在**别的 jar** 里 —— 原版的 `block/cube`、`item/generated` 全在客户端 jar，
  // 所以这里不能只问当前这个 zip，要走跨 jar 的读取器。
  for (const ref of refCandidates(parent, ns)) {
    if (!source.hasModel(ref)) continue;
    return textureRefsFromModel(source, ref, depth - 1, out);
  }
  return out;
}

/**
 * 把模型里找到的贴图候选排序：① 与物品名共享几个词根；② 面片总面积（大的更像「正面」）。
 *
 * 为什么要这两条：`create:andesite_funnel` 的模型里同时挂着 `funnel/andesite_funnel`（本体）
 * 和 `andesite_block`（搭在漏斗上的那块石头），只按出现顺序会拿成石头；而 `minecraft:tnt`
 * 的模型里 side 面积最大，按名字 + 面积就能挑到侧面而不是底面。
 *
 * @param {string[]} refs 模型里收集到的贴图引用（可能带着 `.scores` 属性）
 * @param {Set<string>|null} words 物品名的词根
 * @returns {string[]} 排好序的新数组（不改原数组）
 */
function sortTextureRefs(refs, words) {
  const scores = refs.scores ?? new Map();
  const matchOf = (ref) => {
    if (!words || !words.size) return 0;
    const parts = String(ref).split(/[:/]/).join('_').split('_');
    let hit = 0;
    for (const p of new Set(parts)) if (p && words.has(p)) hit += 1;
    return hit;
  };
  return refs.slice().sort((a, b) => {
    const ma = matchOf(a);
    const mb = matchOf(b);
    if (ma !== mb) return mb - ma;
    return (scores.get(b) ?? -1) - (scores.get(a) ?? -1);
  });
}

/** 贴图引用（`ns:block/x`）→ jar 里的条目路径（`assets/ns/textures/block/x.png`）。 */
function textureEntryOf(ref) {
  const [refNs, refPath] = String(ref ?? '').split(':');
  return refNs && refPath ? `assets/${refNs}/textures/${refPath}.png` : '';
}

/**
 * 贴图引用 → 索引 `byId` 的键。
 *
 * 索引里的键是「命名空间:贴图名」，**不带** item/block/fluid 那一段
 * （`assets/create/textures/block/shaft.png` → `create:shaft`），
 * 而模型里写的是 `create:block/shaft`，所以查索引前要把这段去掉。
 */
function indexPathKeyOf(ref) {
  const [refNs, refPath] = String(ref ?? '').split(':');
  if (!refNs || !refPath) return '';
  return `${refNs}:${refPath.replace(/^(?:item|block|fluid)\//, '')}`;
}

/**
 * 从 blockstate 里挑第一个模型引用。
 *
 * 只用来「找到是哪个模型」，不用它取贴图 —— `create:andesite_belt_funnel` 的模型藏在
 * `models/block/belt_funnel/*.json`，只有 blockstate 知道入口在哪。
 *
 * @param {object} json blockstate 的 JSON
 * @returns {string} 形如 `create:block/belt_funnel/andesite_north`，找不到返回空串
 */
function firstModelOfBlockState(json) {
  const pick = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      for (const item of v) {
        const got = pick(item);
        if (got) return got;
      }
      return '';
    }
    if (v && typeof v === 'object' && typeof v.model === 'string') return v.model;
    return '';
  };
  if (!json || typeof json !== 'object') return '';
  if (json.variants) {
    for (const value of Object.values(json.variants)) {
      const got = pick(value);
      if (got) return got;
    }
  }
  if (Array.isArray(json.multipart)) {
    for (const part of json.multipart) {
      const got = pick(part?.apply);
      if (got) return got;
    }
  }
  return '';
}

/**
 * 拿一个模型条目，渲染成等轴测图标。
 *
 * 这一步是「和 JEI 显示得差不多」的关键：JEI 是拿游戏里的模型实时画的，
 * 我们照着 `elements` + `textures` 自己画一遍。画不出来（模型没有 elements、
 * 一张贴图都取不到）就返回 null，交给上层退回「取一张贴图」的老办法。
 *
 * @param {object} source 跨 jar 读取器（见 `makeAssetSource`）
 * @param {string} startRef 起点模型引用，形如 `create:item/shaft`
 * @param {string} displayName 物品 ID（只用于 source 里写清楚）
 * @returns {{dataUrl: string, bytes: number, source: string}|null}
 */
function renderIconFromModel(source, startRef, displayName) {
  if (typeof source?.readModelJson !== 'function') return null;
  const ref = String(startRef ?? '');
  const ns = ref.split(':')[0];
  if (!ns || !ref.includes(':') || ref.split(':')[1] === '') return null;

  const head = source.readModelJson(ref);
  if (!head) return null;
  // `builtin/entity`：这种模型在游戏里由方块实体渲染器画（头颅、箱子、告示牌、床……），
  // 模型文件里只有一张 `particle` 贴图。拿它冒充图标会得到一块无关的方块
  // （实测：`cataclysm:aptrgangr_head` 变成了灵魂沙）。放弃，让上层去试方块模型那一轮。
  if (typeof head.parent === 'string' && head.parent.trim().startsWith('builtin/')) return null;

  // 模型里写引用时不带命名空间是常态，按游戏规矩先补 `minecraft:`；个别 mod 其实想指自己，
  // 所以找不到时再退回本体命名空间试一次 —— 只多认，不少认。
  const readJson = (target) => {
    const direct = source.readModelJson(target);
    if (direct) return direct;
    if (String(target).startsWith('minecraft:')) {
      const alt = `${ns}:${String(target).slice('minecraft:'.length)}`;
      if (alt !== target) return source.readModelJson(alt);
    }
    return null;
  };
  const loadTexture = (target) => {
    // 模型里写贴图引用常常不带命名空间（`block/tnt_side`），要先按游戏规矩补 `minecraft:`，
    // 再退回本体命名空间 —— 直接拿去 split(':') 会得到 ns='block' 这样的假命名空间。
    for (const cand of refCandidates(target, ns)) {
      const png = source.readTexture(cand);
      if (!png || !png.length || png.length > MAX_PNG_BYTES) continue;
      // 动图（岩浆那种竖排图）只取第一帧，否则取样会取到别的帧上
      const decoded = decodeTexture(pngFirstFrame(png) ?? png);
      if (decoded) return decoded;
    }
    return null;
  };
  const model = loadModelChain(readJson, ref);
  if (!model || !Array.isArray(model.elements) || !model.elements.length) return null;
  const out = renderModelIcon({ model, loadTexture, size: 48 });
  if (!out) return null;
  // source 里写成 jar 内的条目路径，排错时能直接拿去 grep
  return iconFromPng(out.png, `${displayName} → assets/${ns}/models/${ref.slice(ns.length + 1)}.json（等轴测渲染）`);
}

/**
 * 「只有一条平铺方块贴图、模型却是一堆零件」的物品，拿那条贴图当图标反而是错的。
 * 典型是 `create:belt`：传送带在游戏里根本拿不到手上，blockstate 指向
 * `create:block/belt/particle`，模型是 `models/block/belt/{middle,start,end,…}.json`
 * 一组，全部共用同一条 `textures/block/belt.png` 配 UV 子区域 —— 那条 16×16 的
 * 表面条纹当图标看着就是错的（用户反馈原话：「图标用错了」）。
 *
 * 四个条件**同时**成立才判死：
 * ① 命中的是 block 贴图 —— item 贴图说明这确实是个能拿在手上的物品；
 * ② 没有 item 模型 —— 有的话说明它在物品栏里有正经模型；
 * ③ 没有同名 block 模型 —— 有的话它就是个正常方块，贴图就是它的表面；
 * ④ 存在同名目录形式的多部件模型 —— 说明这条贴图只是零件的纹理。
 *
 * 任何一条不成立就照常给图标：`minecraft:tnt` 有 `models/item/tnt.json`，不会误伤。
 */
function isMultipartOnlyBlock(id, hit, index) {
  if (!hit || hit.kind !== 'block') return false;
  if (index.modelsById?.has(id)) return false;
  if (index.blockModelsById?.has(id)) return false;
  return Boolean(index.blockModelDirs?.has(id));
}

/**
 * 批量拿物品图标。
 *
 * @param {object} instance resolveInstance() 的返回（用 mcRoot / modsDir / versionJsonFile / clientJar）
 * @param {string[]} ids 物品 ID（可带可不带命名空间）
 * @param {{limit?: number, index?: object, force?: boolean}} [opts]
 * @returns {{icons: Map<string, {dataUrl: string, bytes: number, source: string}>, missing: string[], elapsedMs: number}}
 */
export function resolveIcons(instance, ids, opts = {}) {
  const started = Date.now();
  const limit = Math.max(1, Math.min(Number(opts.limit) || ICON_LIMIT, ICON_LIMIT));
  const wanted = [];
  for (const raw of ids ?? []) {
    const id = normalizeItemId(raw);
    if (!id || wanted.includes(id)) continue;
    if (wanted.length >= limit) break;
    wanted.push(id);
  }

  const icons = new Map();
  const missing = [];
  // 客户端 jar 自动带上（调用方不用传）：原版方块物品的贴图和父模型全在里面，
  // 少了这一份，所有走模型链的原版方块都会没图标。
  const clientJar = String(instance.clientJar ?? '');
  const extraJars = clientJar && fs.existsSync(clientJar) ? [clientJar] : [];
  const index = opts.index ?? buildTextureIndex(instance.modsDir, { force: opts.force, extraJars });

  // 先看缓存
  const keyOf = (id) => `${String(instance.modsDir ?? '').toLowerCase()}|${id}`;
  const todo = [];
  for (const id of wanted) {
    const hit = iconCache.get(keyOf(id));
    if (hit && Date.now() - hit.at < TTL_MS) {
      icons.set(id, hit.icon);
      continue;
    }
    todo.push(id);
  }

  // 第 0 轮：游戏自己导出的图标最准 —— 三维模型（.obj）渲染出来的物品只有在
  // 游戏里才能画对，翻 jar 找贴图永远只能拿到约 86%。有导出目录就先吃它。
  let exportInfo = null;
  if (todo.length) {
    try {
      const dirs = findExportDirs(instance);
      if (dirs.length) {
        const exportIndex = buildExportIndex(dirs);
        exportInfo = { count: exportIndex.count, dirs: exportIndex.dirs };
        if (exportIndex.count) {
          const got = readExportedIcons(exportIndex.files, todo);
          for (const [id, icon] of got.icons) {
            icons.set(id, icon);
            iconCache.set(keyOf(id), { at: Date.now(), icon });
          }
        }
      }
    } catch {
      exportInfo = null; // 导出目录读不动就当没有，不影响后面几轮
    }
  }

  // 第 1 轮：只认 `textures/item/<名字>.png`（手持物品的那张 2D 图）。
  //
  // 以前这里还会退回「同名的 block 贴图」，结果是方块物品先被平铺贴图占住，
  // 第 2 轮的模型渲染根本没机会跑（JEI 里那些方块都是整张模型画出来的）。
  // 现在：有 2D 物品图的直接用它（和 JEI 一致），没有的把活留给后面的模型轮。
  const byJar = new Map();
  const needModel = [];
  for (const id of todo) {
    if (icons.has(id)) continue;
    const itemHit = index.itemTexById?.get(id) ?? index.itemTexByPrefix?.get(id);
    if (itemHit) {
      if (!byJar.has(itemHit.jar)) byJar.set(itemHit.jar, []);
      byJar.get(itemHit.jar).push({ id, entry: itemHit.entry });
    } else {
      needModel.push(id);
    }
  }

  const extract = (jar, pairs) => {
    const zip = openJarRef(jar);
    if (!zip) return;
    for (const { id, entry } of pairs) {
      let png;
      try {
        png = zip.read(entry);
      } catch {
        png = null;
      }
      if (!png || png.length === 0 || png.length > MAX_PNG_BYTES) continue;
      const icon = iconFromPng(png, `${path.basename(jar)} → ${entry}`);
      icons.set(id, icon);
      iconCache.set(keyOf(id), { at: Date.now(), icon });
    }
  };

  for (const [jar, pairs] of byJar) extract(jar, pairs);

  // 渲染模型时贴图、父模型都可能不在同一个 jar 里（原版模型/贴图全在客户端 jar），
  // 统一走一个跨 jar 的读取器，别再为「客户端 jar 兜底」单开一条路。
  const source = makeAssetSource(index);

  // 第 2 轮：靠**物品模型** `models/item/<名字>.json` 反查贴图（跟 JEI 的画法一致：
  // JEI 拿到的就是这件物品的 item 模型）。不看 `models/block/` —— 那是「放置出来的方块」
  // 的样子，方块物品都有 item 模型，真没有的就不该拿方块外观冒充（用户明确要求过）。
  const modelByJar = new Map();
  for (const id of needModel) {
    const hit = index.modelsById.get(id);
    if (!hit) continue;
    if (!modelByJar.has(hit.jar)) modelByJar.set(hit.jar, []);
    modelByJar.get(hit.jar).push({ id, entry: hit.entry });
  }
  // 跨 jar 的贴图：模型在自己 jar 里，贴图却指向别的 jar 里的东西（多半是原版贴图）。
  // 攒起来一起取，别为了一个物品反复开关 jar。
  const crossJar = new Map();
  for (const [jar, pairs] of modelByJar) {
    const zip = openJarRef(jar);
    if (!zip) continue;
    const wanted2 = [];
    for (const { id, entry } of pairs) {
      // 物品名切成词根，交给模型贴图排序用（`andesite_funnel` vs `andesite_block`）
      const words = new Set(
        String(id.slice(id.indexOf(':') + 1))
          .split('_')
          .filter(Boolean),
      );
      const refs = sortTextureRefs(textureRefsFromModel(source, modelRefOf(entry)), words);
      // 2a. 先试等轴测渲染（JEI 就是这么画的）：漏斗这种「模型里挂着好几张图」的
      // 只有整张画出来才对，单取一张必然把石头当漏斗。
      const rendered = renderIconFromModel(source, modelRefOf(entry), id);
      if (rendered) {
        icons.set(id, rendered);
        iconCache.set(keyOf(id), { at: Date.now(), icon: rendered });
        continue;
      }
      if (!refs.length) continue;
      // 候选按优先级逐个试，第一个「这个 jar 里真的有」的胜出
      let texEntry = '';
      for (const ref of refs) {
        const candidate = textureEntryOf(ref);
        if (candidate && zip.has(candidate)) {
          texEntry = candidate;
          break;
        }
      }
      if (texEntry) {
        wanted2.push({ id, entry: texEntry });
        continue;
      }
      // 这个 jar 里一张都没有：去索引里找（客户端 jar 里常有原版贴图）
      for (const ref of refs) {
        const key = indexPathKeyOf(ref);
        if (!key) continue;
        const alt = index.byId.get(key) ?? index.byPrefix.get(key);
        if (!alt) continue;
        if (!crossJar.has(alt.jar)) crossJar.set(alt.jar, []);
        crossJar.get(alt.jar).push({ id, entry: alt.entry });
        break;
      }
    }
    if (wanted2.length) extract(jar, wanted2);
  }
  for (const [jar, pairs] of crossJar) extract(jar, pairs);

  // 第 2b 轮：没有 item 模型、但有**方块模型**的物品，把方块模型等轴测画出来。
  //
  // 这是「和 JEI 差不多」这条要求的正解：JEI 里那些漏斗/绳索/告示牌的图标，
  // 就是游戏拿方块模型实时渲染的；我们以前是随便取方块模型里的一张贴图，
  // 于是安山传送带漏斗被画成了普通安山漏斗（用户打回的那条）。现在整张画。
  const blockModelByJar = new Map();
  for (const id of todo) {
    if (icons.has(id)) continue;
    const hit = index.blockModelsById?.get(id) ?? index.blockStateById?.get(id);
    if (!hit) continue;
    if (!blockModelByJar.has(hit.jar)) blockModelByJar.set(hit.jar, []);
    blockModelByJar.get(hit.jar).push({ id, entry: hit.entry, from: index.blockModelsById?.get(id) ? 'model' : 'blockstate' });
  }
  for (const [jar, pairs] of blockModelByJar) {
    const zip = openJarRef(jar);
    if (!zip) continue;
    for (const { id, entry, from } of pairs) {
      if (icons.has(id)) continue;
      let modelRef = modelRefOf(entry);
      if (from === 'blockstate') {
        // blockstate 只用来找模型：模型常常在 `models/block/<目录>/<变体>.json`
        const text = zip.has(entry) ? zip.text(entry) : null;
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        const ref = firstModelOfBlockState(json);
        if (!ref) continue;
        // blockstate 里的 `model` 也可能不写命名空间，按游戏规矩补 minecraft: 再退回本体
        modelRef = refCandidates(ref, id.split(':')[0]).find((r) => source.hasModel(r)) ?? '';
      }
      if (!modelRef) continue;
      const rendered = renderIconFromModel(source, modelRef, id);
      if (!rendered) continue;
      icons.set(id, rendered);
      iconCache.set(keyOf(id), { at: Date.now(), icon: rendered });
    }
  }

  // 第 2c 轮：模型里连 `elements` 都没有（等于「只有一张平铺贴图」）的，退回同名贴图。
  //
  // 放到渲染之后：能画的已经画了，这一步只是兜底（比如 `create:cogwheel` 这种
  // 模型只是一张平面图的东西）。传送带那种「零件模型 + 条纹贴图」仍然排除。
  const flatByJar = new Map();
  for (const id of todo) {
    if (icons.has(id)) continue;
    const hit = index.byId.get(id) ?? index.byPrefix.get(id);
    if (!hit) continue;
    if (isMultipartOnlyBlock(id, hit, index)) continue;
    if (!flatByJar.has(hit.jar)) flatByJar.set(hit.jar, []);
    flatByJar.get(hit.jar).push({ id, entry: hit.entry });
  }
  for (const [jar, pairs] of flatByJar) extract(jar, pairs);

  // 第 3 轮：液体。物品 ID 是 `water` / `honey`，贴图却叫 `water_still` / `honey_still`，
  // 同名匹配永远找不到。索引里单独登记过 `stillById`，这里按它取。
  const stillByJar = new Map();
  for (const id of todo) {
    if (icons.has(id)) continue;
    const hit = index.stillById?.get(id);
    if (!hit) continue;
    if (!stillByJar.has(hit.jar)) stillByJar.set(hit.jar, []);
    stillByJar.get(hit.jar).push({ id, entry: hit.entry });
  }
  for (const [jar, pairs] of stillByJar) extract(jar, pairs);

  // 第 4 轮：原版（贴图在 assets/objects 里）
  for (const id of todo) {
    if (icons.has(id)) continue;
    const [ns, name] = id.split(':');
    if (ns !== 'minecraft') continue;
    const got = readVanillaPng(instance, name);
    if (!got) continue;
    const icon = iconFromPng(got.png, got.source);
    icons.set(id, icon);
    iconCache.set(keyOf(id), { at: Date.now(), icon });
  }

  // 第 5 轮：墙上的告示牌没有独立物品图标（游戏里给的是同名告示牌那张图）。
  // 只按「`<x>_wall_sign` → `<x>_sign`」这一条最保守的规则借用，别的 id 不动。
  const aliasPairs = [];
  for (const id of wanted) {
    if (icons.has(id)) continue;
    const alias = signAliasOf(id);
    if (alias) aliasPairs.push([id, alias]);
  }
  if (aliasPairs.length) {
    const aliasIds = [...new Set(aliasPairs.map(([, a]) => a))].filter((a) => !icons.has(a));
    if (aliasIds.length) {
      // 同名告示牌自己也可能还得靠模型链去找，所以走一次同样的解析
      const sub = resolveIcons(instance, aliasIds, { limit: aliasIds.length, index });
      for (const [id, icon] of sub.icons) {
        icons.set(id, icon);
        iconCache.set(keyOf(id), { at: Date.now(), icon });
      }
    }
    for (const [id, alias] of aliasPairs) {
      const icon = icons.get(alias);
      if (!icon) continue;
      const borrowed = { ...icon, source: `${icon.source}（墙上的告示牌借用 ${alias} 的图标）` };
      icons.set(id, borrowed);
      iconCache.set(keyOf(id), { at: Date.now(), icon: borrowed });
    }
  }

  for (const id of wanted) if (!icons.has(id)) missing.push(id);
  return { icons, missing, elapsedMs: Date.now() - started, exported: exportInfo };
}

/** 测试用：清空所有缓存。 */
export function resetIconCaches() {
  indexCache.clear();
  iconCache.clear();
  vanillaCache.clear();
  jarCache.clear();
}

/** 测试用：看缓存里现在有多少项。 */
export function iconCacheSizes() {
  return { index: indexCache.size, icons: iconCache.size, vanilla: vanillaCache.size, jars: jarCache.size };
}