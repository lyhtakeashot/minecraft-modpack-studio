/**
 * 物品 ID 索引：把 mods/*.jar 解包成「这个包里到底有哪些物品/配方」的真相。
 *
 * 三个来源（见 HANDBOFF §4.2，数字是 Mechanomania 实测）：
 *   A 语言文件   assets/<ns>/lang/en_us.json 里 item./block. 的键
 *   B 模型文件   assets/<ns>/models/item/<path>.json
 *   C 配方产物   data/<ns>/recipe(s)/*.json 的 result
 * A∪B 是主口径，C 只补漏（在本包上只净增 676 个，但少了会漏掉纯配方引入的物品）。
 *
 * ⚠️ 1.21.1 的配方目录是单数 `recipe/`，1.20.1 是复数 `recipes/`。
 * 只写复数会让源 C 完全静默失效 —— 不报错，只是少掉全部配方。这是本项目踩过
 * 最贵的坑，所以正则必须写成 (?:recipes|recipe)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from './zip.js';
import { parseModMeta } from './instance.js';
import { collectTagDefs, resolveTags } from './tag-index.js';
import { scriptItems } from './kubejs.js';

const RECIPE_RE = /^data\/([^/]+)\/(?:recipes|recipe)\/.+\.json$/;
const LANG_RE = /^assets\/([^/]+)\/lang\/(en_us|zh_cn)\.json$/;
// `lang/default/*.json`、`lang/builtin/*.json`：拆开的补充语言文件（Create 系 mod 的 tooltip 都在这里）
const LANG_SPLIT_RE = /^assets\/[^/]+\/lang\/(?:default|builtin)\/[^/]+\.json$/;
const MODEL_RE = /^assets\/([^/]+)\/models\/item\/(.+)\.json$/;

/**
 * 合法物品 ID 的形状：`namespace:path`。
 * 为什么必须校验：配方里的 `result` 有时是行为数据（实测遇到 `canUse:unknown`
 * 这种从 curios 的属性表里混进来的字符串），不校验就会凭空多出「物品」。
 */
const ID_RE = /^[a-z0-9_-]+:[a-z0-9_./-]+$/;

function isId(s) {
  return typeof s === 'string' && ID_RE.test(s);
}

/** 从一条配方 json 里抽所有产出物品 ID（result 与 results[] 两种写法）。 */
function resultIds(recipe, into) {
  const push = (v) => {
    if (typeof v === 'string') {
      if (isId(v)) into.add(v);
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (typeof v.item === 'string') {
      if (isId(v.item)) into.add(v.item);
    } else if (typeof v.id === 'string') {
      if (isId(v.id)) into.add(v.id);
    } else if (Array.isArray(v.items)) v.items.forEach(push);
    else if (Array.isArray(v.choices)) v.choices.forEach(push);
  };
  push(recipe?.result);
  if (Array.isArray(recipe?.results)) recipe.results.forEach(push);
}

/**
 * 语言文件里的 item./block. 键 → 物品 ID。
 *
 * 两个必须处理的坑（都实测踩过）：
 * 1. 命名空间**不含点**。若写成 `[a-z0-9_.-]+` 贪婪回溯会把
 *    `item.minecraft.coal_ore` 切成 ns=`minecraft.coal` + name=`ore`，
 *    凭空造一堆假 ID（实测把原版物品从 2,817 降到 1,834）。
 * 2. 原版有些键是「物品 + 变体后缀」，如 `block.minecraft.banner.base.black`
 *    （真 ID 是 `minecraft:banner`）、`item.minecraft.filled_map.monument`。
 *    所以段数 > 3 时只取第二段，丢掉变体后缀 —— 否则会造出
 *    `minecraft:banner.base.black` 这种永远匹配不上 jar 的幽灵 ID。
 *
 * @param {Record<string,string>} lang
 * @param {Set<string>} into
 * @param {Set<string>} allowedNs 允许的命名空间（本 jar 的 modId + 其模型/配方里出现过的 ns）
 */
function langIds(lang, into) {
  for (const key of Object.keys(lang)) {
    const parts = key.split('.');
    if (parts.length < 3) continue;
    // 只认正名的形状 `item.ns.name` / `block.ns.name`（正好 3 段）。
    // 更长的键（`.tooltip.summary`、`.effect.swiftness`、`banner.base.black`）都是变体，
    // 拿它们造 ID 只会得到 `minecraft:banner` 这种游戏里不存在的幽灵物品 ——
    // 在选择列表里表现为「一行没有图标的东西」，比没有更糟。
    if (parts.length !== 3) continue;
    const kind = parts[0];
    if (kind !== 'item' && kind !== 'block') continue;
    const ns = parts[1];
    if (!ns || !/^[a-z0-9_-]+$/.test(ns)) continue;
    // 第三段才是物品名；更长的部分是变体/tooltip 后缀
    const name = parts[2];
    if (!name || !/^[a-z0-9_]+$/.test(name)) continue;
    into.add(`${ns}:${name}`);
  }
}

/**
 * 模型里的 `overrides` 指向的「另一个模型」→ 它是同一个物品的另一种渲染状态。
 *
 * 游戏里 `clock.json` 用 overrides 引用 `clock_01.json`…`clock_63.json`
 * （指针转到某个角度）；指南针、拉弓、光照等级同理。
 *
 * 判读方式：overrides 里的 `model` 值是**相对资源位置**，形如 `item/clock_01`
 * —— 没有命名空间、没有 `models/item/` 前缀、不带 `.json` 后缀。
 * 要还原成物品 ID：去掉 `.json` → 去掉 `item/` 前缀 → 取**第一段**（子目录变体早合并了）。
 *
 * @param {string} text 模型 json 原文
 * @param {string} ns 这个模型所在的命名空间
 * @param {string} baseId 这个模型自己的物品 ID（用来防止把本体当成帧）
 * @param {Set<string>} into 收集「被 overrides 引用的模型 ID」
 */
function collectOverrideFrames(text, ns, baseId, into) {
  if (!text.includes('overrides')) return;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return; // 单个模型文件坏了不该毁掉整个 jar
  }
  const overrides = obj?.overrides;
  if (!Array.isArray(overrides)) return;
  for (const one of overrides) {
    let ref = one?.model;
    if (typeof ref !== 'string' || !ref) continue;
    ref = ref.replace(/\.json$/, '');
    let refNs = ns;
    const colon = ref.indexOf(':');
    if (colon >= 0) {
      refNs = ref.slice(0, colon);
      ref = ref.slice(colon + 1);
    }
    if (!ref.startsWith('item/')) continue; // 只关心手持形态的模型
    const under = ref.slice('item/'.length);
    // 带子目录的引用是「同一个物品的变体」（`item/package/cardboard_12x10`），
    // 它指向的仍然是物品本体，不是渲染帧 —— 这种情况必须放过，
    // 否则会把真的物品当成帧删掉。
    if (under.includes('/')) continue;
    const first = under;
    if (!first) continue;
    const id = `${refNs}:${first}`;
    if (id === baseId) continue; // 本体被自己引用（子目录变体），不是帧
    into.add(id);
  }
}

/** 从模型路径取物品 ID：`models/item/a/b.json` 的真实物品是 `a`（子目录都是变体）。 */
function modelItemId(pathUnderItem) {
  const first = pathUnderItem.split('/')[0];
  return first || '';
}

/**
 * 每个「名字表」记一份「这个 ID 现在的名字来自几段键」。
 *
 * 为什么必须记：语言文件里同一个物品不止一个键 ——
 *   `block.create.flywheel`                    = 「飞轮」        （3 段，正式名）
 *   `block.create.flywheel.tooltip.summary`    = 「使用壮观的黄铜轮子_装饰_…」（5 段，说明文字）
 *   `block.minecraft.banner.base.black`        = 「黑色旗帜」    （5 段，变体）
 *   `item.minecraft.potion.effect.swiftness`   = 「迅捷药水」    （5 段，变体）
 * 按「段数 > 3 只取第二段」的规则，它们会落到同一个物品 ID 上，
 * 后出现的会把正式名覆盖掉 —— 实测 Mechanomania 里 296 个物品中招、277 个名字直接变成 tooltip。
 * 所以：**段数越少越可信**，长键只能在没有短键时兜底。
 */
const NAME_DEPTHS = new WeakMap();

/** 取（必要时创建）某张名字表对应的「键段数」表。 */
function depthOf(into) {
  let d = NAME_DEPTHS.get(into);
  if (!d) {
    d = new Map();
    NAME_DEPTHS.set(into, d);
  }
  return d;
}

/**
 * 语言文件里的 item./block. 键 → 物品 ID 对应的**显示名**。
 *
 * 键的解析规则和 langIds 完全一致（同一套坑：命名空间不含点、段数 > 3 只取第二段），
 * 区别只在于这里留下的是名字本身。
 *
 * 两条额外纪律（2026-10-31 修「有些中文名是错的」）：
 * 1. **段数少的赢**：`item.create.flywheel` 盖不掉 `...tooltip.summary`，反过来一定盖掉；
 * 2. **带 `%` 的值不是名字**：`%s`、`飞行时间：%s` 这种是格式化模板，收进来只会显示成「%s」。
 *
 * @param {Record<string,string>} lang
 * @param {Map<string,string>} into 物品 ID → 显示名
 */
function langNames(lang, into) {
  const depths = depthOf(into);
  for (const [key, value] of Object.entries(lang)) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text) continue;
    // `%s` / `%1$s` / `飞行时间：%s` 都是格式化模板，不是名字
    if (text.includes('%')) continue;
    const parts = key.split('.');
    if (parts.length < 3) continue;
    // 只认正名的形状：`item.ns.name` / `block.ns.name`，正好 3 段。
    // 更长的键一律**不当名字**（连兜底都不当）——`block.mynethersdelight.blazier.too_cold`
    // 的值是「The temperature is too low for this.」，`create.flywheel.tooltip.summary`
    // 的值是一整段说明。实测这类键会把 277 个物品的名字换成垃圾。
    // 宁可没有名字（界面显示 ID），也不要显示错的。
    if (parts.length !== 3) continue;
    const kind = parts[0];
    if (kind !== 'item' && kind !== 'block') continue;
    const ns = parts[1];
    if (!ns || !/^[a-z0-9_-]+$/.test(ns)) continue;
    const name = parts[2];
    if (!name || !/^[a-z0-9_]+$/.test(name)) continue;
    const id = `${ns}:${name}`;
    const depth = parts.length;
    const old = depths.get(id);
    // 一样长就保留先到的；只有更短的键才允许覆盖
    if (old !== undefined && depth >= old) continue;
    depths.set(id, depth);
    into.set(id, text);
  }
}

/**
 * 「物品简介」藏在语言文件的哪些长键下（Mechanomania 实测的分布，94 份 zh_cn）：
 *   `*.tooltip.summary`   137 条  Create 系 mod 的主说明，例如
 *                                 `block.bits_n_bobs.brass_lamp.tooltip.summary` = "_不只是个灯泡_, 它有精致的黄铜外壳"
 *   `*.tooltip.behaviourN` 104 条  和 `tooltip.conditionN` 配对：「空手右击时」→「切换是否常亮」
 *   `*.tooltip.conditionN` 104 条  条件半句
 *   `*.desc`               104 条  通用说明（音乐唱片、书）
 *   `*.tip`                 35 条  一句话提示
 *   `*.guide`               10 条  用法说明
 *   `*.tooltip`             19 条  不带 summary 的简易说明
 * 药水的 `item.minecraft.potion.effect.*`、`*.generation.*`、`*.page_*` 这些**不算简介**
 * （它们是变体名或自定义书页），所以这里只白名单几个后缀，别的长键一律忽略。
 */
const DESC_PLAIN = new Set(['tooltip.summary', 'tooltip', 'desc', 'tip', 'guide']);
const DESC_NUMBERED = /^desc\d+$/;
const DESC_PAIRED = /^tooltip\.(condition|behaviour)(\d+)$/;

/**
 * 清理一段说明文字：Create 用 `_文字_` 表示斜体，`\n` 表示换行。
 * 把这些标记去掉，但保留文字本身 —— 界面上要显示的是人话，不是模板。
 */
function cleanDesc(text) {
  return String(text)
    .replace(/_/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 语言文件 → 物品 ID 对应的简介行。
 *
 * 和名字解析（langNames）分开收集，因为这里的键**必须**是长键：
 * `item.ns.name` 是名字，`item.ns.name.tooltip.summary` 才是简介。
 *
 * @param {Record<string,string>} lang
 * @param {Map<string,string[]>} into 物品 ID → 简介行（每次 push 一行）
 */
function langDescriptions(lang, into) {
  /** 条件半句：`${id}|${n}` → 文字（等 behaviour 配到一起再用） */
  const conds = new Map();
  const add = (id, line) => {
    if (!line) return;
    const list = into.get(id);
    if (!list) into.set(id, [line]);
    else if (!list.includes(line)) list.push(line);
  };

  for (const [key, raw] of Object.entries(lang)) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    // `%s` 这类是格式化模板，显示出来只是「%s」
    if (!text || text.includes('%')) continue;
    const parts = key.split('.');
    if (parts.length < 4) continue;
    const kind = parts[0];
    if (kind !== 'item' && kind !== 'block') continue;
    const ns = parts[1];
    const name = parts[2];
    if (!ns || !/^[a-z0-9_-]+$/.test(ns)) continue;
    if (!name || !/^[a-z0-9_]+$/.test(name)) continue;
    const rest = parts.slice(3).join('.');
    const id = `${ns}:${name}`;
    const line = cleanDesc(text);
    if (!line) continue;

    if (DESC_PLAIN.has(rest) || DESC_NUMBERED.test(rest)) {
      add(id, line);
      continue;
    }
    const pair = DESC_PAIRED.exec(rest);
    if (pair) {
      const shift = pair[1] === 'condition' ? 'cond' : 'beh';
      const slot = `${id}|${pair[2]}|${shift}`;
      conds.set(slot, line);
    }
  }

  // 把 conditionN + behaviourN 合成一行「条件：结果」；只剩半边也要输出
  for (const [slot, line] of conds) {
    const [id, n, shift] = slot.split('|');
    const other = `${id}|${n}|${shift === 'cond' ? 'beh' : 'cond'}`;
    const partner = conds.get(other);
    if (shift === 'cond' && partner) add(id, `${line}：${partner}`);
    else if (shift === 'beh' && partner) continue; // 已经由 condition 那半边拼好了
    else add(id, line);
  }
}

/**
 * 简介太长会把界面撑爆，也会让悬停气泡盖住整屏。
 * 每件物品最多留 6 行 / 400 字，超了截断并加省略号。
 */
const DESC_MAX_LINES = 6;
const DESC_MAX_CHARS = 400;

/** 多行简介 → 一段用 `\n` 连接的文本（界面按行显示）。 */
function joinDesc(lines) {
  if (!lines || !lines.length) return '';
  const kept = lines.slice(0, DESC_MAX_LINES);
  let text = kept.join('\n');
  if (text.length > DESC_MAX_CHARS) text = `${text.slice(0, DESC_MAX_CHARS - 1)}…`;
  return text;
}

/**
 * 扫一个 zip（顶层 jar 或 jarjar 内嵌 jar），把资源收进 out。
 *
 * 抽出来是为了能**递归扫 jarjar 内嵌的 mod**：
 * 很多 mod 会把别的 mod 整个塞进 `META-INF/jarjar/xxx.jar`（ForgeJarJar 机制），
 * 那些内嵌 mod 的物品在游戏里是**真实存在**的（实测 Mechanomania：
 * `simulated` 86 个、`aeronautics` 46 个、`offroad` 7 个、`l2magic` 4 个、`pandora` 2 个），
 * 但我们以前只扫顶层 jar → 这些物品全被漏掉，还会被「幽灵物品」规则误删。
 *
 * 内层 jar 的资源路径跟顶层完全一样（`assets/<ns>/...`），所以正则直接复用。
 *
 * @param {{names: string[], has: (n: string) => boolean, read: (n: string) => Buffer, text: (n: string) => string}} zip
 * @param {object} out indexJar 的返回体
 * @param {{zhNames: Map<string,string>, enNames: Map<string,string>, zhDesc: Map<string,string>, enDesc: Map<string,string>}} ctx 名字/简介表（顶层与内层共用）
 */
function scanZip(zip, out, ctx) {
  const { zhNames, enNames, zhDesc, enDesc } = ctx;
  for (const name of zip.names) {
    const assetNs = /^assets\/([^/]+)\//.exec(name);
    if (assetNs) out.assetNamespaces.add(assetNs[1]);
    const lang = LANG_RE.exec(name);
    if (lang) {
      let parsed;
      try {
        parsed = JSON.parse(zip.text(name));
      } catch {
        continue; // 单个语言文件坏了不该毁掉整个 jar
      }
      if (lang[2] === 'zh_cn') {
        langNames(parsed, zhNames);
        langDescriptions(parsed, zhDesc);
        continue;
      }
      langIds(parsed, out.items);
      langNames(parsed, enNames);
      langDescriptions(parsed, enDesc);
      continue;
    }
    // Create 系 mod 把物品说明拆到 `lang/default/tooltips.json`、`lang/builtin/interface.json`：
    // 这些文件里**只有长键**（tooltip.summary / condition1 / behaviour1 / desc…），没有正名。
    // 实测 Mechanomania：17 个这样的文件、311 条 item./block. 键 —— 不读它们，
    // 整个 Create 家族的物品在界面上就全都没有简介。
    // 只当英文简介的来源，绝不拿它们造物品或起名字。
    const split = LANG_SPLIT_RE.exec(name);
    if (split) {
      let parsed;
      try {
        parsed = JSON.parse(zip.text(name));
      } catch {
        continue;
      }
      langDescriptions(parsed, enDesc);
      continue;
    }
    const model = MODEL_RE.exec(name);
    if (model) {
      // `models/item/package/cardboard_12x10.json` 的真实物品是 `create:package`，
      // 子目录全部是变体（custom model data）。取第一段，否则会造出 163 个假 ID。
      const id = modelItemId(model[2]);
      if (id) out.items.add(`${model[1]}:${id}`);
      if (id) out.itemModels.add(`${model[1]}:${id}`);
      // 模型里的 overrides 指向的兄弟模型 = 同一个物品的另一种渲染状态（钟的指针角度等）
      const selfId = id ? `${model[1]}:${id}` : '';
      if (selfId) {
        const text = zip.text(name);
        if (text.includes('overrides')) {
          out.animatedBases.add(selfId);
          collectOverrideFrames(text, model[1], selfId, out.overrideFrames);
        }
      }
      continue;
    }
    // `textures/item/<名字>.png` 同样算「手里真有这个东西」的证据
    const texture = /^assets\/([^/]+)\/textures\/item\/(.+)\.png$/.exec(name);
    if (texture) {
      const id = modelItemId(texture[2]);
      if (id) out.itemTextures.add(`${texture[1]}:${id}`);
      continue;
    }
    const recipe = RECIPE_RE.exec(name);
    if (recipe) {
      out.recipes++;
      try {
        resultIds(JSON.parse(zip.text(name)), out.items);
      } catch {
        /* 同上 */
      }
    }
  }
  // 兜底：有些包只有 models/block/ 而没有 models/item/，用 blockstates 补一层
  for (const name of zip.names) {
    const m = /^assets\/([^/]+)\/blockstates\/(.+)\.json$/.exec(name);
    if (!m) continue;
    const id = modelItemId(m[2]);
    if (!id) continue;
    out.blockStates.add(`${m[1]}:${id}`);
    // 只有确实存在同名方块模型时才加（避免把纯 blockstate 变体当成物品）
    if (zip.has(`assets/${m[1]}/models/block/${m[2]}.json`) || zip.has(`assets/${m[1]}/models/block/${id}.json`)) {
      out.items.add(`${m[1]}:${id}`);
    }
  }
  // 标签：只收原始定义，不在这里展开（可能引用别的 jar 里的标签，见 tag-index.js）
  try {
    collectTagDefs(zip, out.tagDefs);
  } catch {
    /* 标签坏了不影响物品索引 */
  }
}

/**
 * 索引一个 jar。
 * @returns {{file: string, size: number, entries: number, mod: object, items: Set<string>, recipes: number, error: string}}
 */
export function indexJar(file) {
  const out = {
    file,
    size: 0,
    entries: 0,
    mod: { modId: '', name: '', version: '', updateJson: '', source: '' },
    items: new Set(),
    /** @type {Map<string,string>} 物品 ID → 显示名（中文优先，退英文） */
    names: new Map(),
    /**
     * @type {Map<string,string>} 物品 ID → 简介（多行用 `\n` 连接）。
     * 没有简介的物品不会出现在这张表里 —— 界面上「没有简介就不显示气泡」就靠这个。
     */
    descriptions: new Map(),
    recipes: 0,
    /**
     * 有 `models/item/<名字>.json` 的 ID（「能拿在手上」最硬的证据之一）。
     * @type {Set<string>}
     */
    itemModels: new Set(),
    /** 有 `textures/item/<名字>.png` 的 ID（同上）。 @type {Set<string>} */
    itemTextures: new Set(),
    /** 有 `blockstates/<名字>.json` 的 ID（「放置出来的方块」的证据）。 @type {Set<string>} */
    blockStates: new Set(),
    /**
     * 这个 jar 里 `assets/<命名空间>/` 出现过的命名空间。
     *
     * 用来识别「幽灵物品」：整合包里常有别的 mod 的数据文件提到某个物品
     * （`ae2:certus_quartz_dust`、`thermal:*`），但那个 mod 根本没装 —— 这些 ID 在游戏里
     * 不存在，界面上却会占格子并且永远没有图标（2026-11-05 实测 418 个，占没图标的七成）。
     * @type {Set<string>}
     */
    assetNamespaces: new Set(),
    /**
     * 被某个模型的 `overrides` 引用过的模型 ID（`minecraft:clock_01` 这种）。
     * 它们是同一个物品的另一种渲染状态，**不是独立物品**。
     * @type {Set<string>}
     */
    overrideFrames: new Set(),
    /**
     * 自己带 `overrides` 的模型 ID（`minecraft:clock` 这种「动画本体」）。
     * 它的 `_数字` 兄弟都是帧。
     * @type {Set<string>}
     */
    animatedBases: new Set(),
    /**
     * 标签原始定义（**未展开**）：标签名 → values 列表。
     * 不在这里展开是因为一个标签可能引用别的 jar 里的标签，
     * 必须等全部 jar 都扫完才能算（见 indexInstance 里的 resolveTags）。
     * @type {Map<string, string[]>}
     */
    tagDefs: new Map(),
    /** 内嵌 jarjar mod 的个数（0 = 没有内嵌 mod）。 @type {number} */
    nestedJars: 0,
    error: '',
  };
  let zip;
  try {
    const buf = fs.readFileSync(file);
    out.size = buf.length;
    zip = openZip(buf);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }
  out.entries = zip.names.length;
  try {
    out.mod = parseModMeta(zip);
  } catch {
    /* 元数据坏了不影响索引物品 */
  }

  // 名字分语言收：中文优先，没中文的退英文。最后只保留确实是物品的键。
  const zhNames = new Map();
  const enNames = new Map();
  // 简介同样分语言收：中文优先，没中文退英文
  const zhDesc = new Map();
  const enDesc = new Map();
  const ctx = { zhNames, enNames, zhDesc, enDesc };
  scanZip(zip, out, ctx);

  // jarjar 内嵌 mod：把整个 mod 塞在 `META-INF/jarjar/xxx.jar` 里的那些（ForgeJarJar 机制）。
  // 它们的物品在游戏里是真实存在的，不读就等于漏掉一整批（实测漏 145 个）。
  // 内层的命名空间也必须认领，否则会被「幽灵物品」规则误删。
  const nested = [];
  for (const name of zip.names) {
    if (!name.startsWith('META-INF/jarjar/')) continue;
    if (!name.endsWith('.jar')) continue;
    nested.push(name);
  }
  for (const name of nested) {
    let inner;
    try {
      inner = openZip(zip.read(name));
    } catch {
      continue; // 内嵌 jar 坏了不影响外层
    }
    try {
      scanZip(inner, out, ctx);
    } catch {
      /* 单个内嵌 jar 坏了不该毁掉整个外层 */
    }
  }
  if (nested.length) out.nestedJars = nested.length;

  // 只给真物品留名字：语言文件里还会有一堆不是物品的键（生物、界面文字等），
  // 前面 langNames 是按同样的键规则收的，这里用 out.items 做一次交集。
  const zhDepth = depthOf(zhNames);
  const enDepth = depthOf(enNames);
  const nameDepth = depthOf(out.names);
  for (const id of out.items) {
    const zh = zhNames.get(id);
    const en = enNames.get(id);
    const zd = zhDepth.get(id);
    const ed = enDepth.get(id);
    // 中文优先 —— 但「中文只有一个 5 段的说明文字、英文有 3 段正名」时，英文正名更像名字
    const useZh = zh !== undefined && (en === undefined || (zd ?? 99) <= (ed ?? 99));
    const name = useZh ? zh : (en ?? zh);
    const depth = useZh ? zd : ed;
    if (!name) continue;
    out.names.set(id, name);
    if (depth !== undefined) nameDepth.set(id, depth);
  }

  // 简介也要过一遍「必须真的是物品」这道筛：语言文件里 `item.ns.x.desc` 不少，
  // 但其中有些键对应的 ID 根本不在物品表里（自定义书页、成就文字），别留给界面。
  for (const id of out.items) {
    const text = joinDesc(zhDesc.get(id) ?? enDesc.get(id));
    if (text) out.descriptions.set(id, text);
  }
  return out;
}

/**
 * 原版（Minecraft 本体）物品的中文名，不在 jar 里。
 *
 * 从 1.13 起，客户端 jar 里只有 `assets/minecraft/lang/en_us.json` 一份语言文件，
 * 其余语言（含 zh_cn）被拆成「资源包对象」放在 `<mcRoot>/assets/objects/<hash前2位>/<hash>`，
 * 靠 `<mcRoot>/assets/indexes/<资源索引id>.json` 里的 `objects` 表反查。
 *
 * 不读这一层会怎样：搜「钻石镐」命中 0 个，搜「diamond」却能看到 `minecraft:diamond_pickaxe`
 * 只挂着英文名 Diamond Pickaxe —— 对不熟英文的用来说等于原版物品全都没名字。
 *
 * @param {object} instance resolveInstance() 的返回
 * @param {{zh: Map<string,string>, en: Map<string,string>}} into 收集到的名字表
 * @returns {boolean} 是否真的读到了至少一份语言文件
 */
export function assetsLang(instance, into) {
  const assetsDir = path.join(instance.mcRoot, 'assets');
  const objectsDir = path.join(assetsDir, 'objects');
  const idxDir = path.join(assetsDir, 'indexes');
  if (!fs.existsSync(objectsDir)) return false;

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };

  // 优先用版本 json 里指定的资源索引（最准），拿不到就退化成扫 indexes 目录里的全部
  const ids = [];
  const versionJson = readJson(instance.versionJsonFile ?? '');
  const wanted = versionJson?.assetIndex?.id;
  if (wanted) ids.push(String(wanted));
  if (fs.existsSync(idxDir)) {
    try {
      for (const f of fs.readdirSync(idxDir)) {
        if (f.toLowerCase().endsWith('.json')) ids.push(f.slice(0, -5));
      }
    } catch {
      /* 读不了目录就当没有 */
    }
  }

  for (const id of ids) {
    const index = readJson(path.join(idxDir, `${id}.json`));
    if (!index || typeof index.objects !== 'object' || !index.objects) continue;
    let found = false;
    for (const [key, obj] of Object.entries(index.objects)) {
      const m = /^minecraft\/lang\/(zh_cn|en_us)\.json$/.exec(key);
      if (!m) continue;
      const hash = String(obj?.hash ?? '');
      if (!/^[0-9a-f]{40}$/i.test(hash)) continue;
      const lang = readJson(path.join(objectsDir, hash.slice(0, 2), hash));
      if (!lang) continue;
      langNames(lang, m[1] === 'zh_cn' ? into.zh : into.en);
      found = true;
    }
    if (found) return true;
  }
  return false;
}

/**
 * 索引整个实例的 mods 目录（外加客户端 jar 里的原版物品）。
 *
 * @param {object} instance resolveInstance() 的返回
 * @param {object} [opts]
 * @param {boolean} [opts.includeClientJar] 是否把原版 jar 也算进来，默认 true
 * @returns {object} 索引结果（可直接塞进 tool 输出）
 */
export function indexInstance(instance, opts = {}) {
  const includeClientJar = opts.includeClientJar !== false;
  const started = Date.now();
  const jars = [];
  let failed = 0;

  const modFiles = (() => {
    try {
      return fs
        .readdirSync(instance.modsDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.jar'))
        .map((d) => path.join(instance.modsDir, d.name))
        .sort();
    } catch {
      return [];
    }
  })();

  /** @type {Map<string, {id: string, from: string[]}>} 物品 → 来源 mod */
  const items = new Map();
  /** @type {Map<string, string>} 物品 → 显示名（中文优先） */
  const names = new Map();
  const namesDepth = depthOf(names);
  /** @type {Map<string, string>} 物品 → 简介（多行 `\n` 连接；没有就不进表） */
  const descs = new Map();
  /**
   * 有「item 形态」证据的 ID（`models/item/*.json` 或 `textures/item/*.png`）。
   * 用来判断某个 ID 到底是「能拿在手上的物品」还是「只存在于世界里的方块」。
   * @type {Set<string>}
   */
  const itemForm = new Set();
  /** 有 blockstate 的 ID（「放置出来的方块」）。 @type {Set<string>} */
  const blockStates = new Set();
  /** 全部 jar 里 `assets/<命名空间>/` 出现过的命名空间（判断幽灵物品用）。 @type {Set<string>} */
  const assetNamespaces = new Set();
  /** 全部 jar 自己声称的 modId（判断幽灵物品用：有 jar 认领就说明这个 mod 装了）。 @type {Set<string>} */
  const modIds = new Set();
  /** 被某个模型的 overrides 引用过的模型 ID（是渲染帧，不是独立物品）。 @type {Set<string>} */
  const overrideFrames = new Set();
  /** 自己带 overrides 的模型 ID（动画本体，它的 `_数字` 兄弟都是帧）。 @type {Set<string>} */
  const animatedBases = new Set();
  /**
   * 全部 jar 的标签原始定义合并（标签名 → values 列表）。
   * 合并而不是覆盖：多个 mod 可以往同一个标签里加东西，这是 MC 的正常玩法。
   * @type {Map<string, string[]>}
   */
  const tagDefs = new Map();
  const mods = [];
  let recipeTotal = 0;

  const addItems = (set, source, jarNames, jarDescs) => {
    const jarDepth = jarNames ? depthOf(jarNames) : null;
    for (const id of set) {
      const hit = items.get(id);
      if (hit) {
        if (!hit.from.includes(source)) hit.from.push(source);
      } else {
        items.set(id, { id, from: [source] });
      }
      // 同一个 ID 被多个 mod 声明时：名字越「正经」的越优先。
      // 判据是「键段数」—— `item.ns.x`（3 段）比 `item.ns.x.tooltip.summary`（5 段）可信得多，
      // 否则先扫到的 jar 里一句 tooltip 就能把后扫到的正经译名顶掉。
      if (jarNames && jarNames.has(id)) {
        const name = jarNames.get(id);
        if (!name) continue;
        const depth = jarDepth?.get(id) ?? 3;
        const oldDepth = namesDepth.get(id);
        if (names.has(id) && oldDepth !== undefined && oldDepth <= depth) continue;
        names.set(id, name);
        namesDepth.set(id, depth);
      }
      // 简介：先扫到的先用（后面同 ID 的覆盖没意义，说明文字都是一样的）
      if (jarDescs && jarDescs.has(id) && !descs.has(id)) {
        const text = jarDescs.get(id);
        if (text) descs.set(id, text);
      }
    }
  };

  for (const file of modFiles) {
    const r = indexJar(file);
    if (r.error) {
      failed++;
      jars.push({ file: path.basename(file), error: r.error, items: 0, recipes: 0, modId: '' });
      continue;
    }
    recipeTotal += r.recipes;
    const source = r.mod.modId || path.basename(file);
    addItems(r.items, source, r.names, r.descriptions);
    // 「能拿在手上」的证据：有 item 模型或 item 贴图才算
    for (const id of r.itemModels) itemForm.add(id);
    for (const id of r.itemTextures) itemForm.add(id);
    for (const id of r.blockStates) blockStates.add(id);
    for (const ns of r.assetNamespaces) assetNamespaces.add(ns);
    for (const id of r.overrideFrames) overrideFrames.add(id);
    for (const id of r.animatedBases) animatedBases.add(id);
    if (r.mod.modId) modIds.add(r.mod.modId);
    // 标签原始定义先攒着，等所有 jar 都扫完再统一展开
    for (const [tag, values] of r.tagDefs) {
      const list = tagDefs.get(tag);
      if (list) list.push(...values);
      else tagDefs.set(tag, [...values]);
    }
    mods.push({ file: path.basename(file), modId: r.mod.modId, name: r.mod.name, version: r.mod.version, items: r.items.size, recipes: r.recipes, size: r.size });
    jars.push({ file: path.basename(file), error: '', items: r.items.size, recipes: r.recipes, modId: r.mod.modId });
  }

  // 脚本现造物品（2026-11-07）：StartupEvents.registry 声明的 item / block，
  // 以及 fluid 自动派生的桶，在 mods/*.jar 里根本不存在，是游戏启动后才注册的。
  // 不补的话网格对照游戏 ITEM 注册表会「漏」掉这些（Mechanomania 实测 19 个）。
  // 中文名在 kubejs/assets/*/lang/{zh_cn,en_us}.json 里，scanZip 读不到，
  // 所以交给 packages/core/kubejs.js 的 scriptItems() 一起收好，再复用 addItems() 塞进索引，
  // 别在 index.js 里另起一套「脚本物品」的数据结构。
  let scriptItemCount = 0;
  let scriptItemList = [];
  const scriptNamespaces = new Set();
  try {
    const scriptDir = path.join(instance.instanceDir, 'kubejs');
    const found = scriptItems(scriptDir, { mcVersion: instance.mcVersion });
    const scriptIds = new Set();
    const scriptNames = new Map();
    for (const one of found.items) {
      scriptIds.add(one.id);
      if (one.name) scriptNames.set(one.id, one.name);
    }
    addItems(scriptIds, 'kubejs', scriptNames);
    scriptItemCount = scriptIds.size;
    scriptItemList = found.items;
    for (const ns of found.namespaces) scriptNamespaces.add(ns);
  } catch {
    // kubejs 目录里有什么奇怪东西，也不能拖垮整个索引；当作「没有脚本物品」继续。
  }

  // 原版 jar：Mechanomania 这类实例把本体放在 <实例>/<实例名>.jar
  let vanilla = { file: '', items: 0, added: 0 };
  /** 原版 jar 里有多少「物品外形」证据（模型 + blockstate）。0 说明这个 jar 是个壳，下面那条清理规则不能用。 */
  let vanillaShapes = 0;
  if (includeClientJar && instance.hasClientJar) {
    const v = indexJar(instance.clientJar);
    if (!v.error) {
      const before = items.size;
      addItems(v.items, 'minecraft', v.names, v.descriptions);
      for (const id of v.itemModels) itemForm.add(id);
      for (const id of v.itemTextures) itemForm.add(id);
      for (const id of v.blockStates) blockStates.add(id);
      vanillaShapes = v.itemModels.size + v.blockStates.size;
      for (const ns of v.assetNamespaces) assetNamespaces.add(ns);
      for (const id of v.overrideFrames) overrideFrames.add(id);
      for (const id of v.animatedBases) animatedBases.add(id);
      // 原版 jar 里的标签（`minecraft:planks`、`minecraft:logs` 这些基础标签全在这儿）
      for (const [tag, values] of v.tagDefs) {
        const list = tagDefs.get(tag);
        if (list) list.push(...values);
        else tagDefs.set(tag, [...values]);
      }
      vanilla = { file: path.basename(instance.clientJar), items: v.items.size, added: items.size - before };
      recipeTotal += v.recipes;
    }
  }

  // 原版中文名：jar 里只有 en_us，中文得去 assets/objects 翻。
  // 对 `minecraft:` 命名空间直接盖掉（资源包的官方译名比 jar 里的英文名有用），
  // 其它命名空间只补空缺，不抢 mod 自己给的译名。
  let assetsNames = { zh: 0, en: 0 };
  if (includeClientJar) {
    const zh = new Map();
    const en = new Map();
    if (assetsLang(instance, { zh, en })) {
      const zhDepth = depthOf(zh);
      const enDepth = depthOf(en);
      for (const id of items.keys()) {
        const z = zh.get(id);
        const e = en.get(id);
        if (!z && !e) continue;
        // 中文优先；但「中文只有 5 段说明文字、英文有 3 段正名」时用英文（见 langNames 的注释）
        const zd = zhDepth.get(id);
        const ed = enDepth.get(id);
        const useZh = z !== undefined && (e === undefined || (zd ?? 99) <= (ed ?? 99));
        const name = useZh ? z : (e ?? z);
        const depth = useZh ? zd : ed;
        const ns = id.slice(0, Math.max(0, id.indexOf(':')));
        // 非 minecraft 命名空间只补空缺，不抢 mod 自己给的译名
        if (ns !== 'minecraft' && names.has(id)) continue;
        // 别用一句 tooltip（长键）盖掉已有的正经名字（短键）
        if (names.has(id) && (depth ?? 99) > (namesDepth.get(id) ?? 99)) continue;
        names.set(id, name);
        if (depth !== undefined) namesDepth.set(id, depth);
      }
      assetsNames = { zh: zh.size, en: en.size };
    }
  }

  // 幻影方块去重（2026-10-31）。
  //
  // 问题：`block.create.belt`（传送带）这种「放置出来的方块」的中文键会被 langIds 当成物品，
  // 于是物品表里多出一条 `create:belt`，跟真正的 `create:belt_connector`（拿在手上的传送带）
  // 显示名一模一样。用户在搜索框里挑到前者，就得到一个没有图标的「传送带」。
  //
  // 判据（两条都要满足才删）：
  // 1. 这个 ID 没有任何「item 形态」的证据（没有 models/item/<名字>.json，也没有 textures/item/<名字>.png）；
  // 2. 同名的另一个 ID 有 item 形态（那才是能拿到手上的那个）。
  // 只满足「有 blockstate」不算，因为 `minecraft:lava` 这类方块本身就该留在物品表里当图标来源。
  const itemFormName = new Map();
  for (const id of itemForm) {
    const name = names.get(id);
    if (!name) continue;
    // 只认同命名空间内的「同名替身」：跨 mod 撞名的情况太多
    // （`irons_spellbooks:voidstone` 和 `cataclysm:void_stone` 都叫「虚空石」，
    // 但它们是两个完全不同的东西，谁都不该被删）。
    const key = `${id.split(':')[0]}\u0000${name}`;
    if (!itemFormName.has(key)) itemFormName.set(key, id);
  }
  const droppedAlias = [];
  for (const id of [...items.keys()]) {
    if (itemForm.has(id)) continue;
    if (!blockStates.has(id)) continue;
    const name = names.get(id);
    if (!name) continue;
    const keeper = itemFormName.get(`${id.split(':')[0]}\u0000${name}`);
    if (!keeper || keeper === id) continue;
    droppedAlias.push({ id, aliasOf: keeper, name });
  }
  for (const one of droppedAlias) {
    items.delete(one.id);
    names.delete(one.id);
    descs.delete(one.id);
  }

  // 盔甲纹饰变体不是独立物品（2026-11-05 用户报「第 19 页看到 7 个钻石胸甲」）。
  //
  // 游戏给每种「盔甲 + 纹饰材质」都生成一个模型文件
  // `assets/minecraft/models/item/diamond_chestplate_gold_trim.json`，
  // 它不是注册出来的物品：游戏里仍然只有 `minecraft:diamond_chestplate` 一个物品，
  // 纹饰只是渲染时叠的一层。我们按模型文件枚举物品，于是把它们全当成了新物品 ——
  // **实测真实包里 502 个**，全部没有译名（游戏没给它们 lang 键），
  // 而且在网格里跟本体长得一模一样，看起来就是「同一个胸甲重复十几遍」。
  //
  // 判据（要同时满足）：① ID 以 `_trim` 结尾；② 去掉 `_<材质>` 后能对上物品表里的另一个 ID；
  // ③ 自己没有译名（有译名的说明真注册了，别动）。
  const trimBaseOf = (id) => {
    if (!id.endsWith('_trim')) return '';
    const cut = id.indexOf(':');
    if (cut < 0) return '';
    const ns = id.slice(0, cut);
    const parts = id.slice(cut + 1).split('_');
    // `x_gold_trim` 去 1 段；`x_diamond_darker_trim` 要能去 2 段
    for (let n = 1; n <= Math.min(3, parts.length - 1); n += 1) {
      const base = `${ns}:${parts.slice(0, parts.length - n).join('_')}`;
      if (items.has(base)) return base;
    }
    return '';
  };
  const droppedTrims = [];
  for (const id of [...items.keys()]) {
    if (names.has(id)) continue;
    const base = trimBaseOf(id);
    if (base) droppedTrims.push(id);
  }
  for (const id of droppedTrims) items.delete(id);

  // 原版的「改名残留」清掉（2026-11-05，配合上面那条一起修「重复」）。
  //
  // 真实包里的语言文件是**新旧混装**的（整合包自带的旧资源包、老版本 mod 的 lang 都会带上
  // 已经删掉的键），于是物品表里出现 `minecraft:angler_pottery_shard`（1.20 的写法，
  // 1.21 改叫 `*_pottery_sherd`）、`minecraft:milk`（早就是 `milk_bucket` 了）、
  // `minecraft:grass`（改叫 `short_grass`）这种游戏里根本不存在的 ID。
  // 它们在网格里表现为「同一个东西并排出现两次」（陶片 47 对全部同页），
  // 而且永远没有图标。
  //
  // 判据：**只处理 `minecraft:` 命名空间**，且三样证据（item 模型 / item 贴图 / blockstate）
  // 一样都没有。原版物品是封闭集合，1.21.1 里每个真物品都至少有一个模型 —
  // 实测这样正好挑出 32 个残留，不会误伤（`minecraft:lava` 这类有 blockstate，保留）。
  // mod 的物品不套这条：有些 mod 真就不带模型。
  //
  // 前提检查：这条规则建立在「原版 jar 是完整的」之上。测试里那种只有语言文件的
  // 假 jar、或者用户把客户端 jar 抽走了，`vanillaShapes === 0`，就整条跳过 ——
  // 否则会把 `minecraft:diamond_pickaxe` 这种只有 lang 键的（测试里的）物品误删。
  const droppedLegacy = [];
  if (vanillaShapes > 0) {
    for (const id of items.keys()) {
      if (!id.startsWith('minecraft:')) continue;
      if (itemForm.has(id) || blockStates.has(id)) continue;
      droppedLegacy.push(id);
    }
  }
  for (const id of droppedLegacy) items.delete(id);

  // 模型动画帧不算独立物品（2026-11-05，用户报「钟、指针怎么会有多个物品」）。
  //
  // 游戏里 `clock.json` 会用 overrides 引用 `clock_01.json`…`clock_63.json` 这些
  // 「指针转到某个角度」的模型；指南针、自然罗盘、拉弓、光照等级同理。它们只是
  // 同一个物品的渲染状态，不是注册物品。可我们枚举 `assets/<ns>/models/item/*.json`
  // 时把每个平铺文件都当成一个 ID 收了进来，于是网格里「一个钟出现 64 次」。
  // （子目录里的变体早就在 modelItemId 里合并了，平铺的没做，属于漏网。）
  //
  // ⚠️ 判据在 2026-11-06 改过一次（原来判错，误删了 631 个游戏里真存在的物品）：
  //   旧判据＝「ID 以 `_数字` 结尾 + 没有译名 + 本体在表里」→ 全删。
  //   问题：`kaleidoscope_doll:doll_0`…`doll_639` 是**真的注册了 640 个物品**
  //   （游戏 ITEM 注册表里 640 条，JEI 里也全部可见），可它们没有 `item.` 前缀的
  //   翻译键（lang 文件里全是数字键），于是被当成帧整片删掉 —— 用户就少了 631 个物品。
  //
  // 新判据（只删「有硬证据是渲染帧」的，两条任一命中即删）：
  //   ① 这个模型被别的模型的 `overrides` 引用过（`clock_01` 就是被 `clock` 引用来的）；
  //   ② 它的本体是个「动画本体」（本体自己带 overrides），所以 `_数字` 兄弟都是帧。
  // 有译名的一律不动 —— `ftbquests:screen_1/3/5`（1×1/3×3/5×5 屏幕）、
  // `cataclysm:..._scylla_1..9`（雕纹蔚蓝海石）这些是真正不同的物品。
  //
  // 对照游戏 ITEM 注册表实测（Mechanomania，2026-11-06）：
  //   旧判据：删 819 条，其中 **632 条是游戏里真存在的物品**（误删）。
  //   新判据：删 206 条，**误删 0 条**；漏删 5 条（`railways:large_create_styled_0_*`，
  //   它们有译名，按「有译名不动」保留是对的）。
  const droppedFrames = [];
  for (const id of items.keys()) {
    if (names.has(id)) continue;
    // ① 被别的模型 overrides 引用过
    if (overrideFrames.has(id)) {
      droppedFrames.push(id);
      continue;
    }
    // ② 本体是动画本体 → 它的 `_数字` 兄弟都是帧
    const cut = id.indexOf(':');
    if (cut < 0) continue;
    const ns = id.slice(0, cut);
    const m = /^(.+)_(\d{1,4})$/.exec(id.slice(cut + 1));
    if (!m) continue;
    if (!animatedBases.has(`${ns}:${m[1]}`)) continue;
    droppedFrames.push(id);
  }
  for (const id of droppedFrames) items.delete(id);

  const namespaces = new Map();
  for (const id of items.keys()) {
    const ns = id.split(':')[0];
    namespaces.set(ns, (namespaces.get(ns) ?? 0) + 1);
  }

  // 幽灵物品：包里有它的数据文件（配方 / 战利品表 / 别的 mod 的引用），
  // 但**没有任何 jar 为它提供资源**，而且这个命名空间也没有对应的 mod 装着 ——
  // 那它在游戏里根本不存在，列出来只会是一格永远空着的位置。
  //
  // 判据故意留宽：①命名空间有 assets、②有 jar 声称自己是这个 modId、
  // ③是脚本现造物品的命名空间（`createages` 这种既没 modId 认领也没 assets，
  //  但 StartupEvents.registry 确实注册了它 —— 2026-11-07 实测漏标会白补 7 个）。
  // 只要命中一条就认为它是真物品（`kubejs:` 这种脚本现造的物品没有贴图，但确实存在，不能删）。
  const ghostItems = new Set();
  for (const id of items.keys()) {
    const ns = id.split(':')[0];
    if (ns === 'minecraft') continue; // 原版的旧 ID 靠别的判据，这里不动
    if (assetNamespaces.has(ns) || modIds.has(ns) || scriptNamespaces.has(ns)) continue;
    ghostItems.add(id);
  }

  // 标签展开必须放在「幻影方块去重」之后：去重会把一些 ID 从物品表里删掉，
  // 展开时按最终物品表过滤，才不会留下指向已删 ID 的标签成员。
  const tagResult = resolveTags(tagDefs, items);

  const unresolvedMods = jars.filter((j) => !j.error && !j.modId).map((j) => j.file);

  return {
    instanceId: instance.id,
    instanceDir: instance.instanceDir,
    modsDir: instance.modsDir,
    jarCount: modFiles.length,
    jarFailed: failed,
    indexedMs: Date.now() - started,
    recipeCount: recipeTotal,
    itemCount: items.size,
    /** 脚本现造物品（StartupEvents.registry 的 item/block + fluid 派生桶）条数 */
    scriptItemCount,
    /** 脚本现造物品清单：`{id,name,kind,file}`（数量很小，给界面/诊断用） */
    scriptItems: scriptItemList,
    /** 脚本物品用到的命名空间（幽灵判据放过它们），排好序 */
    scriptNamespaces: [...scriptNamespaces].sort(),
    vanilla,
    /** 从 assets/objects 读到的原版语言条数（读不到就是 0/0） */
    assetsNames,
    modIdResolved: `${mods.filter((m) => m.modId).length}/${mods.length}`,
    unresolvedMods,
    namespaces: [...namespaces.entries()].sort((a, b) => b[1] - a[1]).map(([ns, n]) => ({ namespace: ns, items: n })),
    mods,
    /** 内部用：完整物品表（不进 JSON 输出，太大） */
    _items: items,
    /** 内部用：物品 ID → 显示名（同样不进 JSON 输出） */
    _names: names,
    /** 内部用：物品 ID → 简介（多行 `\n`；没有简介的物品不在表里） */
    _descriptions: descs,
    /**
     * 内部用：物品 ID → 所属标签集合（`minecraft:planks` 这种）。
     * 给 `#标签` 搜索用，见 tag-index.js。
     * @type {Map<string, Set<string>>}
     */
    _itemTags: tagResult.itemTags,
    /** 内部用：标签 → 成员物品集合（已递归展开嵌套标签） @type {Map<string, Set<string>>} */
    _tagItems: tagResult.tagItems,
    /** 展开后一共有多少个标签、多少个物品带标签 */
    tagCount: tagResult.tagCount,
    taggedItems: tagResult.itemCount,
    /** 有简介的物品数量（给界面提示「这个包有多少物品带说明」用） */
    descriptionCount: descs.size,
    /** 去重掉的「幻影方块」（只有 blockstate、没有手持形态，且同名有真物品）：`{id, aliasOf, name}` */
    droppedAliases: droppedAlias,
    droppedAlias: droppedAlias.length,
    /** 去重掉的「盔甲纹饰变体」（`x_gold_trim` 这种只有渲染模型、游戏里不是独立物品的假 ID） */
    droppedTrims,
    droppedTrim: droppedTrims.length,
    /** 清掉的「原版改名残留」（只有旧版语言文件的键，1.21 里已经没有这个物品） */
    droppedLegacy,
    droppedLegacyCount: droppedLegacy.length,
    /** 清掉的「模型动画帧」（`clock_01` 这种只是同一物品的不同渲染状态，不是独立物品） */
    droppedFrames,
    droppedFrame: droppedFrames.length,
    /**
     * 内部用：幽灵物品（包里有它的数据引用，但没有任何 jar 为它提供资源，也没有 mod 认领它）。
     * 游戏里根本不存在，界面上不该占格子。
     * @type {Set<string>}
     */
    _ghostItems: ghostItems,
    ghostCount: ghostItems.size,
    has: (id) => items.has(id),
    lookup: (id) => items.get(id),
    nameOf: (id) => names.get(id) ?? '',
    describe: (id) => descs.get(id) ?? '',
    /** 某个物品属于哪些标签（排好序，给界面显示用） */
    tagsOf: (id) => [...(tagResult.itemTags.get(id) ?? [])].sort(),
    /** 某个标签包含哪些物品（已展开嵌套标签） */
    itemsOfTag: (tag) => [...(tagResult.tagItems.get(String(tag ?? '').toLowerCase()) ?? [])],
  };
}
