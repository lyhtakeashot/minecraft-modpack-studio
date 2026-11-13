/**
 * 任务书（FTB Quests）的界面接口。
 *
 * 和 `recipe-api.js` 一样，这里**只返回普通对象**，包装成 HTTP 响应是 `api.js` 的事，
 * 这样单元测试可以直接调函数，不用造 Request。
 *
 * 任务书有一个特殊的坑，决定了这里的整体设计：
 * **结构和文字分开存在两个文件里**。改标题/描述要写 `lang/<语言>.snbt`，
 * 改位置要写 `chapters/<章节>.snbt`。一次操作可能要同时改两个文件，
 * 所以「预览」必须把两个文件都算出来，写盘也必须两件一起成功或一起回滚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { McError } from '../../packages/core/errors.js';
import { resolveInstance } from '../../packages/core/instance.js';
import { lintQuests, lintQuestImages, loadQuests, patchQuestFields, patchQuestText, rewriteEntries, describeEntries, questDisplayName, nameHintOf } from '../../packages/core/quests.js';
import {
  TASK_TYPES, REWARD_TYPES, specFromTask, specFromReward, specFromParams,
} from '../../packages/core/quest-conditions.js';
import { checkWritable, restoreFiles, writeFiles } from '../../packages/core/write.js';
import { commitQuestPlan, planAddChapter, planAddQuest } from '../../packages/core/quest-create.js';
import {
  planCloneQuest, planNodeItems, planSpawnQuest,
} from '../../packages/core/quest-blueprint.js';
import { commitMovePlan, planMoveQuests } from '../../packages/core/quest-move.js';
import { parsePlaceholder, resolveHolders } from '../../packages/core/quest-desc.js';
import { taskTypeTitle } from '../../packages/core/quest-type-title.js';
import { cachedIndex } from './cache.js';
import { openZip } from '../../packages/core/zip.js';

/** 「翻译键 → 中文」名字表的缓存（见 `holderNameTable()`），TTL 跟物品索引一个量级。 */
const holderTableCache = new Map();
const HOLDER_TABLE_TTL_MS = 10 * 60 * 1000;

/**
 * 原版（`minecraft:`）几个常用翻译键的中文名，内置一份。
 *
 * 为什么硬编码而不是去读游戏语言文件：MC 的原版语言文件在
 * `assets/objects/<hash>` 里，而**启动器是按需下载的** —— 实测用户包里
 * 资源索引里有 `minecraft/lang/zh_cn.json` 这个条目，但对应的 object 文件根本没下。
 * 这种情况占位符就永远翻不出来。
 *
 * 这几个键**固定且数量极少**（原版一共就三个维度），硬编码比联网/读盘都可靠。
 * 其它原版键（生物、效果）查不到就原样保留占位符，不影响读句子。
 */
const VANILLA_HOLDER_NAMES = {
  'dimension.minecraft.overworld': '主世界',
  'dimension.minecraft.the_nether': '下界',
  'dimension.minecraft.the_end': '末地',
  'dimension.minecraft.the_end_highlands': '末地高地',
};
import { resolveQuestImages } from '../../packages/core/quest-images.js';
import {
  commitNodeDelete,
  commitNodeEdit,
  planNodeDelete,
  planNodeEdit,
} from '../../packages/core/quest-node.js';
import { commitImagePlan, planImageEdit } from '../../packages/core/quest-image-edit.js';
// 任务级字段的默认值判定（2026-11-13）：和写盘层共用同一张表，
// 免得界面说「这是默认值、会删键」而 core 说「要写」。
import { isDefault as isQuestFieldDefault } from '../../packages/core/quest-defaults.js';
import { asList } from './params.js';

/** 列表一次最多返回多少条，防止「一万个任务」把界面卡死。 */
const MAX_LIMIT = 300;
const DEFAULT_LIMIT = 80;
/** 描述最多多少行（FTB 里太多行会顶出界面）。 */
const MAX_DESC_LINES = 40;
/** 坐标绝对值上限。FTB 画布比这大就没法用了，当输入错误处理。 */
const MAX_COORD = 1e6;

/** 任务书解析一次要几百毫秒，界面会连续请求好几次，缓存 1 分钟。 */
const BOOK_TTL_MS = 60 * 1000;
const bookCache = new Map();

/** 测试用：清掉任务书缓存。 */
export function resetQuestCache() {
  bookCache.clear();
}

// ————————————————————————— 参数 —————————————————————————

async function readParams(request) {
  const url = new URL(request.url, 'http://localhost');
  const out = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  if (request.method === 'POST') {
    let text = '';
    try {
      text = typeof request.text === 'function' ? await request.text() : '';
    } catch {
      text = '';
    }
    if (text) {
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new McError('请求内容不是合法的 JSON', '这是界面自己发出的请求，正常不该出现；刷新页面试试', 'McBadArgs');
      }
      if (body && typeof body === 'object') Object.assign(out, body);
    }
  }
  return out;
}

const has = (params, key) => Object.hasOwn(params, key);

function text(params, key) {
  const v = params[key];
  return v === undefined || v === null ? '' : String(v).trim();
}

/** 找任务书目录：优先用显式给的，否则从实例里推（和 mc_quest_* 工具同一套规则）。 */
function locateQuestDir(params) {
  const explicit = text(params, 'questDir');
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new McError(`目录不存在：${explicit}`, '检查一下路径有没有抄错', 'QuestDirMissing');
    }
    return explicit;
  }
  const dir = text(params, 'dir');
  if (!dir) throw new McError('缺少整合包目录', '先在界面里连一个整合包', 'McBadArgs');
  const instance = resolveInstance(dir, text(params, 'id'));
  const candidates = instance.questDirs.map((d) => (path.isAbsolute(d) ? d : path.join(instance.instanceDir, d)));
  const hit = candidates.find((d) => fs.existsSync(path.join(d, 'chapters')));
  if (!hit) {
    throw new McError(
      `${instance.id} 里没有找到 FTB Quests 任务书`,
      '这个包可能没装 FTB Quests，或者任务书目录不叫 config/ftbquests。',
      'QuestNotFound',
    );
  }
  return hit;
}

/**
 * 界面默认优先看中文。
 *
 * `loadQuests` 的默认语言是 en_us（MCP 工具要的是「原始的、最全的」），但界面是给人看的，
 * 一个中文整合包如果把任务标题显示成英文，用户会以为任务书坏了。所以这里单独兜一层：
 * 没显式指定语言时，包里有 zh_cn 就用 zh_cn。
 */
const PREFERRED_LOCALES = ['zh_cn'];

function pickLocale(questDir, wanted) {
  if (wanted) return wanted;
  let names = [];
  try {
    names = fs.readdirSync(path.join(questDir, 'lang')).filter((n) => n.endsWith('.snbt'));
  } catch {
    names = [];
  }
  return PREFERRED_LOCALES.find((l) => names.includes(`${l}.snbt`)) ?? '';
}

/** 读一整套任务书（带缓存；force=true 时重读）。 */
function openBook(params, force = false) {
  const questDir = locateQuestDir(params);
  const locale = pickLocale(questDir, text(params, 'locale'));
  const key = `${questDir.toLowerCase()}|${locale}`;
  const now = Date.now();
  if (!force) {
    const hit = bookCache.get(key);
    if (hit && now - hit.at < BOOK_TTL_MS) return { store: hit.store, questDir };
  }
  const store = loadQuests(questDir, { locale });
  bookCache.set(key, { at: now, store });
  return { store, questDir };
}

/**
 * 顺手把实例也带出来（有些检查要翻包才能做，比如「装饰图的图在不在」）。
 * 任务书目录是显式给的、或者包里有多个实例时，就不去猜实例了，返回 null。
 */
function locateInstance(params) {
  const dir = text(params, 'dir');
  if (!dir) return null;
  try {
    return resolveInstance(dir, text(params, 'id'));
  } catch {
    return null;
  }
}

// ————————————————————————— 小工具 —————————————————————————

function chapterTitleOf(store, chapterId) {
  return store.chapters.find((c) => c.id === chapterId)?.title ?? chapterId;
}

/**
 * 任务的**显示名**：`questDisplayName()` 的加强版 —— 把「物品 ID 当标题」翻成中文名。
 *
 * ★ 2026-11-12 修的真 bug（用户：「我记得 atm 空岛这个整合包是有中文汉化的啊，
 *   why 很多任务都是英文的，比如 ae2 系列的任务」）。
 *
 * **不是汉化缺失，是标题没翻译。** 实测那个包的 `lang/zh_cn.snbt` 有 1825 条
 * `quest.*.title`，英文有的一条不缺（缺 0 条）—— 中文是全的。
 * 但 3658 个任务里有 **1738 个（47.5%）** 作者压根没写标题，FTB 的规矩是
 * 「就显示要交的那个物品的名字」。core 的 `questDisplayName()` 在
 * `titleSource === 'item'` 时只能返回**物品 ID**（它是纯函数，不碰 jar，查不到名字），
 * 于是界面上就出现了 `ae2:energy_acceptor` 这种东西 —— 看着像没汉化 / 像乱码。
 *
 * 而这个名字**包里就有**：扫 326 个 jar 的 `zh_cn.json` 能翻出 908/1590 个。
 * `cachedIndex().nameOf()` 早就会查（描述里的 `{item.x.y}` 占位符一直在用它，
 * `resolveHolderName()`），只是标题这条路没人调它。
 *
 * 查到就返回中文名，查不到退回 `questDisplayName()`（宁可显示 ID 也不要空）。
 *
 * @param {object} q 任务对象（loadQuests 的 store.quests 里那个）
 * @param {object|null} instance resolveInstance() 的返回；没有就只能退回 ID
 * @returns {string}
 */
function displayNameOf(q, instance) {
  const fallback = questDisplayName(q);
  // 作者写了真标题的（titleSource==='lang'）一律不动 —— 那是作者自己的话。
  if (q?.titleSource === 'lang') return fallback;

  // ① 标题是物品 ID（FTB 的常规做法）：查中文名。
  //    宁可显示 ID 也不显示空 —— 索引坏了不影响列表。
  if (q?.titleSource === 'item') {
    const itemId = String(q?.titleItem ?? q?.title ?? '').trim();
    if (!instance || !itemId.includes(':')) return fallback;
    try {
      const name = cachedIndex(instance).nameOf(itemId);
      // 索引里有名字、而且不是「把 ID 最后一段当名字」那种兜底时才用
      if (name && name !== itemId) return name;
    } catch {
      /* 索引坏了不影响列表显示，退回原样 */
    }
    return fallback;
  }

  // ② 没有标题的任务（2026-11-12）：`questDisplayName()` 会退回
  //    「条件线索的英文尾巴 / 图标名 / untitledN」。这里把能翻译的都翻成中文 ——
  //    实测 ATM10Sky 4118 条前置边里，114 条只会显示 `untitled2` 这种，
  //    其中 27 个任务其实是「击杀苦力怕」「击杀末影人」这种一看就懂的。
  //    翻译不到就原样用 fallback，绝不编名字。
  const hint = nameHintOf(q);
  if (hint) {
    const translated = itemNameOf(instance, hint.what, hint.type);
    // itemNameOf 查不到会原样返回 ID；只有真翻出人话（和 ID 不同）才用
    if (translated && translated !== hint.what) return translated;
    const tail = hint.what.slice(hint.what.lastIndexOf(':') + 1);
    if (tail) return tail;
  }

  // ③ 图标物品的中文名（次优先）：`creeper_spawn_egg` → 「苦力怕刷怪蛋」。
  //    实测有 29 条前置边会显示成 `creeper_spawn_egg` 这种英文尾巴，
  //    而那个物品的中文名索引里**本来就有**，只是这条路上没人去查。
  const icon = String(q?.icon ?? '').trim();
  if (instance && icon.includes(':')) {
    try {
      const name = cachedIndex(instance).nameOf(icon);
      if (name && name !== icon) return name;
    } catch {
      /* 同上 */
    }
  }

  return fallback;
}

function briefQuest(store, q, instance = null) {
  return {
    id: q.id,
    /**
     * 给人看的名字（没标题时退回副标题 / 图标名 / **物品中文名**）。
     * 用户 2026-11-11：「显示前置后置任务的时候用任务标题不要用编号」——
     * 这条列表（左栏搜索命中、MCP 的 quest_list）同样是给人看的，一起按这个规矩走。
     * 2026-11-12：再往上一层 —— 「没标题」时不能只给物品 ID，要给物品的中文名。
     */
    title: displayNameOf(q, instance),
    /** 文件里的真值（没写标题时等于 ID）。要精确值的地方读这个。 */
    rawTitle: q.title,
    chapterId: q.chapterId,
    chapterTitle: chapterTitleOf(store, q.chapterId),
    taskCount: q.tasks.length,
    x: q.x,
    y: q.y,
    /** lang 里有没有显式标题；没有的话游戏里显示的是物品名 */
    titleSource: q.titleSource,
    titleItem: q.titleItem,
    /** 画布/列表上要画的物品（FTB 的 icon，没写就是第一个物品任务的物品） */
    icon: q.icon ?? '',
  };
}

function rewardBrief(r) {
  return {
    type: String(r?.type ?? '?'),
    what: String(r?.item?.id ?? r?.table_id ?? r?.loot_size ?? ''),
    // 顶层 count 优先：core 把数量规整到顶层，item.count 恒为 1（那一摞物品自己的堆叠数）
    count: Number(r?.count ?? r?.item?.count ?? 1),
    // 界面按类型预填表单时用（含类型、字段值与一句人话），改不了的类型给 null
    spec: specFromReward(r),
  };
}

/**
 * 一个「要求 / 奖励」条目里那个 ID → 给人看的中文名。
 *
 * ★ 2026-11-12 用户第二条：「要求里显示需要的物品或到达的维度或检查是否获取过
 *   某个物品时，显示的名字也是中文名保持一致」。
 *
 * 以前 `taskSummary.what` 原样是 ID：物品是 `minecraft:diamond`、维度是
 * `minecraft:the_nether`、生物是 `minecraft:zombie` —— 和刚修好的标题不在一个语言里，
 * 一半中文一半英文，看着像没做完。
 *
 * 数据分两路走（照 `resolveHolderName()` 那套，别另写一套）：
 *   - 物品 → 物品索引 `cachedIndex().nameOf()`（带 CFPA 补全结果）
 *   - 其余（维度 / 生物 / 效果 / 进度 / 流体 …）→ `holderNameTable()` 的 `<type>.<ns>.<path>`
 *
 * **查不到就原样返回 ID** —— 那是那个 mod 真没做汉化，替换成「未知」只会更糟。
 * 界面上 ID 也还能用来搜。
 *
 * @param {object|null} instance resolveInstance() 的返回
 * @param {string} id 条目里的原始 ID（`ns:path`）
 * @param {string} kind 条目类型（item / dimension / kill / advancement / fluid / xp …）
 * @returns {string}
 */
function itemNameOf(instance, id, kind = '') {
  const raw = String(id ?? '').trim();
  if (!instance || !raw.includes(':')) return raw;

  // 物品类先走物品索引（它已经有中文名，而且带 CFPA 补全的结果）
  if (!kind || kind === 'item' || kind === 'check' || kind === 'observation') {
    try {
      const name = cachedIndex(instance).nameOf(raw);
      if (name) return name;
    } catch {
      /* 索引坏了不影响列表显示 */
    }
  }

  // 其余类型走翻译键表。一个 ID 在游戏里可能对应好几个翻译键前缀，挨个试。
  const table = holderNameTable(instance);
  const [ns, ...rest] = raw.split(':');
  const restPath = rest.join(':');

  // ★ 维度是特例（2026-11-12 实测）：原版中文本地化里**根本没有 `dimension.*` 这套键**
  //   （`dimension.minecraft.the_nether` = undefined）。MC 显示维度名用的是别的键：
  //   主世界 → `flat_world_preset.minecraft.overworld`（「主世界」）
  //   末地   → `biome.minecraft.the_end`（「末地」）
  //   下界   → 没有现成键，只能写死（这是原版固定三个维度，写死不违反「版本不写死」）
  //   所以维度先走这张表，查不到再看翻译键，最后退回 ID。
  if (kind === 'dimension') {
    const builtin = { overworld: '主世界', the_nether: '下界', the_end: '末地' }[restPath];
    const probes = [
      `flat_world_preset.${ns}.${restPath}`,
      `biome.${ns}.${restPath}`,
    ];
    for (const k of probes) {
      const hit = table.get(k);
      if (hit) return hit;
    }
    if (ns === 'minecraft' && builtin) return builtin;
  }

  const prefixes = kind === 'dimension' ? ['dimension']
    : kind === 'kill' ? ['entity']
      : kind === 'fluid' ? ['fluid', 'block']
        // ★ 进度是复数：实测原版中文里是 `advancements.<ns>.<path>.title`
        //   （`advancements.husbandry.netherite_hoe.title` = 终极奉献），
        //   单数的 `advancement.*` 一条都没有。进度任务还要看 `.title` 而不是裸键。
        : kind === 'advancement' ? ['advancements', 'advancement']
          : kind === 'effect' ? ['effect']
            // 2026-11-12 实测：生物群系和结构在原版中文里是 `biome.*` / `structure.*`
            // （`biome.minecraft.end_highlands` = 末地高地、`structure.minecraft.fortress` 由 mod 提供）
            : kind === 'biome' ? ['biome']
              : kind === 'structure' ? ['structure']
                : ['item', 'block', 'entity', 'dimension', 'biome', 'structure', 'fluid', 'effect', 'advancement'];
  for (const prefix of prefixes) {
    // 进度/生物群系这类要看带后缀的键（`.title`），先试后缀版再试裸键 ——
    // 顺序不能反：裸键 `advancements.x.y` 通常不存在，试它只是浪费一次查找。
    const suffixes = prefix === 'advancements' || prefix === 'advancement' ? ['.title', ''] : [''];
    // ★ 进度 ID 里的斜杠在翻译键里要变成点：`apotheosis:progression/haven`
    //   → `advancements.apotheosis.progression.haven.title`（值「居所」）。
    //   实测 ATM10Sky 那个包 13 条进度任务全是这种写法，不改就一条都翻不出来。
    const paths = restPath.includes('/') ? [restPath.replace(/\//g, '.'), restPath] : [restPath];
    for (const p of paths) {
      for (const suffix of suffixes) {
        const hit = table.get(`${prefix}.${ns}.${p}${suffix}`);
        if (hit) return hit;
      }
    }
  }

  // 兜底：物品索引里再查一次（有些「维度」其实是个物品，比如 FTB 的自定义）
  try {
    const name = cachedIndex(instance).nameOf(raw);
    if (name) return name;
  } catch {
    /* 同上 */
  }
  return raw;
}

/**
 * 条目的显示名（2026-11-12 第五批，用户拍板的口径）。
 *
 * 游戏里 FTB 对 `dimension` / `biome` / `structure` / `observation` 这几种是
 * `Component.literal(原始字符串)` —— **它自己一个字都不翻译**，
 * 玩家看到的就是 `minecraft:the_nether`。我们上一轮给它们换了中文名，
 * 好看但和游戏不一致，用户拍板要「**原始 ID + （括号补中文名）**」：
 *
 *   游戏里：`访问维度: minecraft:the_nether`
 *   我们这：`minecraft:the_nether（下界）`
 *
 * 物品 / 击杀 / 进度那几种游戏本来就走翻译键，保持原样只给中文名
 * （「钻石」比「minecraft:diamond」好用，这是用户早就确认过的）。
 *
 * @param {object|null} instance 实例
 * @param {string} what 原始 ID
 * @param {string} type 条件/奖励类型
 * @returns {string} 显示名
 */
function labelOf(instance, what, type) {
  const raw = String(what ?? '').trim();
  const name = itemNameOf(instance, raw, type);
  // 这几种游戏里显示原始 ID —— 两边都给出来（顺序按用户拍板：ID 在前）
  const literalTypes = new Set(['dimension', 'biome', 'structure', 'observation']);
  if (literalTypes.has(String(type)) && raw && name && name !== raw) {
    return `${raw}（${name}）`;
  }
  return name;
}

/**
 * 一条要求在游戏里的完整标题（2026-11-12 第五批 B）。
 *
 * 规则全部在 `packages/core/quest-type-title.js`（纯函数，可单测），
 * 这里只负责把「中文名」喂给它 —— 取中文名要碰 jar / 索引，那是有副作用的部分。
 */
function taskTitleOf(instance, task) {
  return taskTypeTitle(task?.type, {
    what: task?.what,
    name: itemNameOf(instance, task?.what, task?.type),
    count: Number(task?.count ?? 1) || 1,
  }).text;
}

/** 同上的分段版本（界面要按游戏那样「前缀白、变量绿」精确上色时用）。 */
function taskTitlePartsOf(instance, task) {
  return taskTypeTitle(task?.type, {
    what: task?.what,
    name: itemNameOf(instance, task?.what, task?.type),
    count: Number(task?.count ?? 1) || 1,
  }).parts;
}

/** 文本字段 → 归一化后的值（和 store 里的形状对齐，方便比较「有没有改」）。 */
function normalizeText(field, value) {
  if (field === 'desc') {
    const lines = Array.isArray(value) ? value.map(String) : String(value ?? '').replace(/\r\n/g, '\n').split('\n');
    const out = lines.map((l) => l.replace(/\s+$/, ''));
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    return out;
  }
  return value === undefined || value === null ? '' : String(value);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 把一组条目折成「友好 spec」列表，专门用来判「用户有没有真改」。
 * 直接比整条条目会踩坑：core 会把数量规整成顶层 count（任务还带 long 后缀 L），
 * 跟文件里读出来的嵌套 item.count 写法字节不同，但意思一样 —— 比 spec 才准。
 * 不认识的类型给一个带原始内容的兜底对象，免得两个不同条目被当成相等。
 */
function specListOf(entries, kind) {
  return (entries ?? []).map((e) => (kind === 'reward' ? specFromReward(e) : specFromTask(e))
    ?? { type: String(e?.type ?? '?'), __raw: JSON.stringify(e) });
}

/** 把空语言文件当起点：改文字时如果包里有语言文件缺这条键，就直接加。 */
const EMPTY_LANG = '{\n}\n';

const readIf = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
};

// ————————————————————————— 策划：算出要改什么 —————————————————————————

/**
 * 算出「这次要改哪些文件、改成什么样」。**不写盘**，预览和真写盘共用。
 *
 * @returns {{
 *   questDir: string, locale: string, questId: string,
 *   before: object, changes: Array<{field: string, label: string, before: any, after: any}>,
 *   files: Array<{kind: string, file: string, name: string, content: string, created: boolean}>,
 *   warnings: string[], summary: string[],
 * }}
 */
export function buildQuestPlan(params) {
  const { store, questDir } = openBook(params, true);
  const questId = text(params, 'questId');
  if (!questId) throw new McError('缺少任务 ID', '先在列表里点一个任务', 'McBadArgs');
  const quest = store.questsById.get(questId);
  if (!quest) throw new McError(`找不到任务 ${questId}`, '任务 ID 抄错了，或者它已经被删掉', 'QuestNotFound');
  const chapter = store.chapters.find((c) => c.id === quest.chapterId);
  if (!chapter) {
    throw new McError(`任务 ${questId} 所属的章节找不到了`, '任务文件可能被改坏了，先跑一次 mc_quest_lint', 'QuestBadChapter');
  }

  const changes = [];
  const warnings = [];

  // ① 文字（写 lang 文件）
  const textFields = {};
  for (const field of ['title', 'subtitle', 'desc']) {
    if (!has(params, field)) continue;
    const after = normalizeText(field, params[field]);
    const before = field === 'desc' ? quest.description : field === 'title' ? quest.title : quest.subtitle;
    if (sameValue(before, after)) continue;
    textFields[field] = after;
    changes.push({
      field,
      label: field === 'title' ? '标题' : field === 'subtitle' ? '副标题' : '描述',
      before: field === 'desc' ? quest.description.join('\n') : before,
      after: field === 'desc' ? after.join('\n') : after,
    });
  }

  if (Object.hasOwn(textFields, 'title')) {
    if (quest.titleSource !== 'lang') {
      warnings.push(
        `这个任务原来没有写标题，游戏里显示的是 ${quest.titleItem ? `物品「${quest.titleItem}」的名字` : '任务 ID'}。改完会显示你填的文字。`,
      );
    }
    if (String(textFields.title).trim() === '') {
      warnings.push('标题清空了，游戏里会退回显示物品名（或任务 ID）。');
    }
  }
  if (Array.isArray(textFields.desc) && textFields.desc.length > MAX_DESC_LINES) {
    warnings.push(`描述有 ${textFields.desc.length} 行，超过 ${MAX_DESC_LINES} 行在游戏里会顶出界面，考虑删短一点。`);
  }

  // ② 位置（写章节文件）
  const layout = {};
  for (const field of ['x', 'y']) {
    if (!has(params, field)) continue;
    const raw = params[field];
    const num = Number(raw);
    if (raw === '' || raw === null || !Number.isFinite(num)) {
      throw new McError(`坐标 ${field} 不是数字：${raw}`, '坐标得是数字，比如 1.5 或 -3', 'McBadArgs');
    }
    if (Math.abs(num) > MAX_COORD) {
      throw new McError(`坐标 ${field} 太大了：${num}`, '游戏里的画布放不下这么远的位置', 'McBadArgs');
    }
    if (num !== quest[field]) {
      layout[field] = num;
      if (!Number.isInteger(num)) warnings.push(`坐标 ${field} 是小数 ${num}，不是不行，但对齐起来会歪。`);
    }
  }

  // ③-b 任务级字段（2026-11-13 默认值改造）
  //
  // 规矩和上面两组一样：**参数没给就完全不碰**（`has()` 判在不在）。
  // 但这里多一个语义 —— 传 `null` 表示「恢复默认」：写盘层看到值等于默认值
  // 就会把这个键从文件里**删掉**（`patchQuestFields` 的新能力）。
  // 界面「任务高级设置」里点 ↩ 之后保存，走的就是这条路。
  const questFieldFields = {};
  const questFieldChanges = [];
  for (const [key, kind] of QUEST_FIELD_EDITABLE) {
    if (!has(params, key)) continue;
    // ★ before 要取**文件里的原始值**，不是 `quest[key]`：
    //   `quest.canRepeat` 是加工过的三态视图，`null` 同时表示「文件里没写」和
    //   「写了但认不出」。而「恢复默认」要删的是**文件里那个键** ——
    //   所以这里必须看 raw 里到底有没有它，否则「文件里写着 can_repeat: false、
    //   用户点 ↩」会被当成「没变化」直接跳过，键永远删不掉（探针当场逮住）。
    const before = quest.raw && Object.hasOwn(quest.raw, key) ? quest.raw[key] : undefined;
    const after = readQuestFieldParam(params, key, kind);
    if (after === undefined) continue; // 认不出的值，当没给
    // 已经是这个值了就别算改动（界面预填会原样发回来）。
    // ★ 「文件里没这个键」+「目标也是默认值」⇒ 没改动；
    //   但「文件里有这个键」+「目标是默认值」⇒ **是改动**（要删掉它）。
    const hadKey = quest.raw && Object.hasOwn(quest.raw, key);
    if (!hadKey && isQuestFieldDefault(key, after)) continue;
    if (hadKey && questFieldSame(before, after, kind)) continue;
    questFieldFields[key] = after;
    questFieldChanges.push({ key, kind, before, after });
  }
  // 只有界面 / MCP 明确给了这一组的字段才动，没给就完全不碰 ——
  // 免得「只改个标题」顺手把人家配好的条件抹掉。
  // taskSpec / rewardSpec 是 JSON 串（能指定任意类型），老字段 taskItem /
  // rewardItem 四件套仍然认；两条路都归一成「友好 spec」再交给 core。
  const conditionFields = {};
  const conditionChanges = [];
  for (const [group, kind, label] of [
    ['tasks', 'task', '完成条件'],
    ['rewards', 'reward', '奖励'],
  ]) {
    const spec = specFromParams(params, kind);
    if (spec === undefined) continue;
    const result = rewriteEntries(quest[group], spec, kind, label);
    warnings.push(...result.warnings);
    // 界面会拿现状预填，用户没动时不该算「有改动」。
    // 比 spec 而不是比整条条目：core 会把数量规整成顶层 count（还带 long 后缀），
    // 跟文件里读出来的嵌套写法字节不同，但意思完全一样。
    if (sameValue(specListOf(quest[group], kind), specListOf(result.entries, kind))) continue;
    conditionFields[group] = result.entries;
    conditionChanges.push({
      field: group,
      label,
      before: describeEntries(quest[group], kind),
      after: describeEntries(result.entries, kind),
    });
  }

  if (!changes.length && !Object.keys(layout).length && !conditionChanges.length
      && !questFieldChanges.length) {
    return { questDir, locale: store.locale, questId, before: quest, changes: [], files: [], warnings, summary: ['没有任何改动'] };
  }

  // ④ 生成两个文件的新内容
  const files = [];
  const langName = `lang/${store.locale}.snbt`;
  const langPath = path.join(questDir, 'lang', `${store.locale}.snbt`);

  if (Object.keys(textFields).length) {
    const original = readIf(langPath);
    if (original === null) {
      warnings.push(`这个包没有 ${langName}，会新建一个（不影响原来的语言文件）。`);
    }
    const result = patchQuestText(original === null ? EMPTY_LANG : original, questId, textFields, langName);
    if (result.changed) {
      files.push({ kind: 'text', file: langPath, name: langName, content: result.source, created: original === null });
    }
  }

  // 位置 + 条件 + 奖励 + 任务级字段都落在同一个章节文件里，必须一次 patchQuestFields
  // 改完：writeFiles 是整份覆盖，分两次调用后一次会把前一次的结果冲掉。
  const chapterFields = { ...layout, ...conditionFields, ...questFieldFields };
  if (Object.keys(chapterFields).length) {
    const chapterName = `chapters/${chapter.file}`;
    const result = patchQuestFields(chapter.source, questId, chapterFields, chapterName);
    if (result.changed) {
      files.push({ kind: 'layout', file: chapter.path, name: chapterName, content: result.source, created: false });
    }
    for (const [field, value] of Object.entries(layout)) {
      changes.push({ field, label: field === 'x' ? '横向位置' : '纵向位置', before: quest[field], after: value });
    }
    changes.push(...conditionChanges);
    // 任务级字段的 diff 用大白话：告诉用户「这个键出现了 / 消失了」，
    // 而不是让他猜「恢复默认」到底写没写进去。
    for (const c of questFieldChanges) {
      const wasDefault = isQuestFieldDefault(c.key, c.before);
      const nowDefault = isQuestFieldDefault(c.key, c.after);
      let before;
      let after;
      if (wasDefault && !nowDefault) { before = '（原来没有，用游戏默认）'; after = describeQuestFieldValue(c.key, c.after); }
      else if (!wasDefault && nowDefault) { before = describeQuestFieldValue(c.key, c.before); after = '（恢复默认，这个键会从文件里删掉）'; }
      else { before = describeQuestFieldValue(c.key, c.before); after = describeQuestFieldValue(c.key, c.after); }
      changes.push({ field: c.key, label: QUEST_FIELD_LABELS[c.key] ?? c.key, before, after });
    }
  }

  const summary = changes.map((c) => {
    const short = (v) => {
      const s = String(v ?? '').replace(/\s*\n\s*/g, ' / ');
      return s.length > 40 ? `${s.slice(0, 40)}…` : s;
    };
    return c.before === '' || c.before === undefined
      ? `${c.label}：留空 → 「${short(c.after)}」`
      : `${c.label}：「${short(c.before)}」→「${short(c.after)}」`;
  });

  return { questDir, locale: store.locale, questId, before: quest, changes, files, warnings, summary, questFieldChanges };
}

// ————————————————————————— 四条接口 —————————————————————————

/** GET /questbook —— 整套任务书的概览。 */
export async function handleQuestBook(request) {
  const params = await readParams(request);
  const force = text(params, 'refresh') === '1' || text(params, 'refresh') === 'true';
  const { store, questDir } = openBook(params, force);
  const lint = lintQuests(store);
  // 装饰图体检要翻包才知道图在不在，所以是异步的（2026-11-03 加）。
  // 拿不到实例就只查书面上看得出的那两条（没写 image / 宽高是 0）。
  const imageLint = await lintQuestImages(store, locateInstance(params));
  const all = [...lint, ...imageLint];
  const groups = new Map(store.chapterGroups.map((g) => [g.id, g.title]));

  return {
    questDir,
    locale: store.locale,
    locales: store.locales,
    questCount: store.quests.length,
    chapterCount: store.chapters.length,
    chapters: store.chapters.map((c) => ({
      id: c.id,
      title: c.title,
      file: c.file,
      group: c.group,
      groupTitle: groups.get(c.group) ?? '',
      icon: c.icon,
      questCount: c.quests.length,
    })),
    groups: store.chapterGroups,
    /** 有显式标题的任务数；其余在游戏里显示物品名 */
    explicitTitles: store.quests.filter((q) => q.titleSource === 'lang').length,
    issues: {
      duplicateIds: store.duplicateQuestIds.slice(0, 20),
      duplicateCount: store.duplicateQuestIds.length,
      dangling: store.danglingDependencies.slice(0, 15),
      danglingCount: store.danglingDependencies.length,
      errorCount: all.filter((i) => i.level === 'error').length,
      warnCount: all.filter((i) => i.level === 'warn').length,
      samples: all.slice(0, 12),
      /** 错误 + 警告（不含「提示」级的那种噪音），界面拿这个显示体检结果 */
      problems: all.filter((i) => i.level !== 'info').slice(0, 40),
      /** 装饰图相关的体检结果（2026-11-03 加）：图缺失 / 宽高为 0 */
      imageIssues: imageLint,
    },
  };
}

/** GET /quests —— 任务列表（可按章节过滤、按关键词搜）。 */
export async function handleQuestList(request) {
  const params = await readParams(request);
  const { store } = openBook(params);
  const chapter = text(params, 'chapter');
  const keyword = text(params, 'q').toLowerCase();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.limit) || DEFAULT_LIMIT));
  // 只有要翻物品名时才用得上实例（标题是物品 ID 的那 47.5% 任务）；
  // 拿不到就当没有，displayNameOf 会退回 ID，不会报错。
  const instance = locateInstance(params);

  const matched = store.quests.filter((q) => {
    if (chapter && q.chapterId !== chapter) return false;
    if (!keyword) return true;
    const hay = [q.title, q.subtitle, q.description.join(' '), q.id, ...q.taskSummary.map((t) => t.what)]
      .join(' ')
      .toLowerCase();
    return hay.includes(keyword);
  });

  return {
    total: matched.length,
    shown: Math.min(matched.length, limit),
    limit,
    chapter: chapter || '',
    items: matched.slice(0, limit).map((q) => briefQuest(store, q, instance)),
  };
}

/**
 * 占位符查名字：`{item.minecraft.diamond}` → 「钻石」。
 *
 * 2026-11-11 用户要求把 `{dimension.x}` / `{item.x}` 这类也做出来。这些是**游戏的
 * 翻译键**，不是 FTB 自己的语法 —— 游戏里会把它们替换成对应对象的本地化名字。
 *
 * 数据分两路走（实测对出来的）：
 *   - `item` / `block` → 物品索引 `cachedIndex().nameOf()`（那里已经有中文名）
 *   - 其余类型（`dimension` / `trait` / `entity` / `effect` / `advancement` …）→
 *     `holderNameTable()`，从所有 mod jar 的 `assets/<ns>/lang/zh_cn.json` 原样收键
 *
 * ★ **查不到就返回空串**，让调用方原样保留占位符。查不到通常意味着那个 mod 没装，
 *   用户看到 `{item.xxx.yyy}` 原样还能自己去搜；换成「未知」或空串反而读不通句子。
 *
 * @param {object} instance resolveInstance() 的返回
 * @param {string} holder 花括号里的内容（不含花括号）
 * @returns {string} 显示名；查不到返回 ''
 */
function resolveHolderName(instance, holder) {
  const parsed = parsePlaceholder(holder);
  if (!parsed) return '';
  const { type, id, ns, path: rest } = parsed;

  // item / block 先走物品索引（它已经有中文名，而且带 CFPA 补全的结果）
  if (type === 'item' || type === 'block') {
    try {
      const name = cachedIndex(instance).nameOf(id);
      if (name) return name;
    } catch {
      /* 索引坏了不影响描述显示，退回原样 */
    }
  }

  // 其余（以及物品表里没有的）走翻译键表：`<type>.<ns>.<path>`
  const full = `${type}.${ns}.${rest}`;
  const table = holderNameTable(instance);
  const fromJars = table.get(full);
  if (fromJars) return fromJars;
  // 原版少数几个键硬编码兜底（游戏语言文件常常没下载到本地）
  return VANILLA_HOLDER_NAMES[full] ?? '';
}

/**
 * 「翻译键 → 中文」的名字表，专门给描述里的占位符用。
 *
 * 为什么不并进 `cachedIndex()` 的物品表：那张表的键必须是 `ns:name` 形式的**物品 ID**，
 * 而这里要的是 `dimension.minecraft.the_end` 这种**任意翻译键**。混进去会把物品网格
 * 污染成几千条「末地」「致盲」这种根本不是物品的东西（`packages/core/index.js` 的
 * `langNames()` 只收 `item.` / `block.` 两个前缀就是这个原因）。
 *
 * 收法：遍历 mods 目录下所有 jar 的 `assets/<ns>/lang/zh_cn.json`，**原样收全部键**，
 * 再加上客户端资源索引里那份原版语言文件。找不到的文件跳过，不报错。
 *
 * 缓存 10 分钟（跟物品索引一个量级）。第一次算要开几百个 jar，第二次就快了。
 *
 * @param {object} instance
 * @returns {Map<string,string>}
 */
function holderNameTable(instance) {
  const key = String(instance?.instanceDir ?? '').toLowerCase();
  const now = Date.now();
  const hit = holderTableCache.get(key);
  if (hit && now - hit.at < HOLDER_TABLE_TTL_MS) return hit.table;

  const table = new Map();
  const put = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string') continue;
      const t = v.trim();
      // `%s` 这类是格式化模板，收进来只会显示出 %s
      if (!t || t.includes('%')) continue;
      if (!table.has(k)) table.set(k, t);
    }
  };

  const modsDir = instance?.modsDir ?? '';
  let files = [];
  try {
    files = fs.readdirSync(modsDir).filter((n) => n.toLowerCase().endsWith('.jar'));
  } catch {
    files = [];
  }
  for (const f of files) {
    let zip;
    try {
      zip = openZip(fs.readFileSync(path.join(modsDir, f)));
    } catch {
      continue; // 坏 jar 跳过，不影响别的
    }
    for (const n of zip.names) {
      if (!/^assets\/[^/]+\/lang\/zh_cn\.json$/.test(n)) continue;
      try {
        put(JSON.parse(zip.read(n).toString('utf8')));
      } catch {
        /* 这个语言文件坏了，跳过 */
      }
    }
  }
  // 原版（minecraft）的翻译：**先读客户端 jar**，它是权威来源。
  //
  // 2026-11-12 补这条的原因：以前只走 `assets/indexes` + `assets/objects` 那条路，
  // 实测在 ATM10Sky 这个包上读不到内容 —— 三个最常见的原版词
  // （`dimension.minecraft.the_nether` / `entity.minecraft.zombie`）全部 MISS，
  // 于是「到达维度 / 击杀生物」这两类要求在界面上还是英文 ID。
  // 客户端 jar 本来就在（`instance.clientJar`），里面 `assets/minecraft/lang/zh_cn.json`
  // 是同一份数据，直接读它比猜资源索引稳得多（索引可能有多个版本、可能缺 objects）。
  try {
    const jarPath = String(instance?.clientJar ?? '');
    if (instance?.hasClientJar && jarPath && fs.existsSync(jarPath)) {
      const zip = openZip(fs.readFileSync(jarPath));
      for (const n of zip.names) {
        if (!/^assets\/minecraft\/lang\/zh_cn\.json$/.test(n)) continue;
        try {
          put(JSON.parse(zip.read(n).toString('utf8')));
        } catch {
          /* 这个语言文件坏了，走下面的资源索引兜底 */
        }
      }
    }
  } catch {
    /* 客户端 jar 读不了（或不是 zip）就走资源索引那条路 */
  }

  // 原版（minecraft）的翻译键不在 jar 里，在资源索引的 objects 里。
  // `dimension.minecraft.the_end`（末地）这类**常用且量小**，值得单独读一次。
  try {
    const assetsDir = path.join(instance.mcRoot, 'assets');
    const objectsDir = path.join(assetsDir, 'objects');
    const idxDir = path.join(assetsDir, 'indexes');
    if (fs.existsSync(objectsDir) && fs.existsSync(idxDir)) {
      for (const f of fs.readdirSync(idxDir)) {
        if (!f.toLowerCase().endsWith('.json')) continue;
        let index = null;
        try {
          index = JSON.parse(fs.readFileSync(path.join(idxDir, f), 'utf8'));
        } catch {
          continue;
        }
        const obj = index?.objects?.['minecraft/lang/zh_cn.json'];
        const hash = String(obj?.hash ?? '');
        if (!/^[0-9a-f]{40}$/i.test(hash)) continue;
        try {
          put(JSON.parse(fs.readFileSync(path.join(objectsDir, hash.slice(0, 2), hash), 'utf8')));
        } catch {
          /* 这个资源读不到就换下一个索引 */
        }
        break; // 读到一份就够
      }
    }
  } catch {
    /* 没有 assets 目录（比如只拷了实例本体）也不影响 mod 那部分 */
  }

  holderTableCache.set(key, { at: now, table });
  return table;
}

/**
 * 一个任务的详情视图。列表/预览/写入后都用同一份，避免三处各写一遍。
 *
 * @param {object} store loadQuests() 的结果
 * @param {string} questId
 * @param {object} [instance] resolveInstance() 的返回；给了才会把描述里的
 *   `{item.minecraft.diamond}` 这类占位符换成中文名。不给就原样保留（测试里有这种调用）。
 */
function detailOf(store, questId, instance = null) {
  const quest = store.questsById.get(questId);
  if (!quest) throw new McError(`找不到任务 ${questId}`, '任务 ID 抄错了，或者它已经被删掉', 'QuestNotFound');

  // 前置 / 后续列表带上「给人看的名字」（2026-11-11 用户：「显示前置后置任务的时候
  // 用任务标题不要用编号」）。`questDisplayName()` 在没标题时会退回副标题 / 图标名，
  // 所以这里不能再写成 `?.title ?? '（不存在的任务）'` —— 那样一半会显示成 16 位编号。
  //
  // 2026-11-12：再往上一层 —— 用 `displayNameOf()`，没标题时能给到**物品中文名**
  // 而不是 `ae2:energy_acceptor` 这种 ID。
  //
  // ★ 两边结构必须**完全对称**（2026-11-12 修复）：以前 `upstream` 有 exists、
  //   `downstream` 连 exists 都没有，两边又都**不带 chapterId** ——
  //   界面点跨章节前置时只能拿到 questId，`jumpToIssue()` 在 canvas 里找不到
  //   那个任务就静默 return，用户看到的现象是「点了没反应」。
  //   实测 ATM10Sky：4109 条前置边**全部**缺 chapterId，其中 43 条是跨章节的。
  // ★ 直接用模块级的 chapterTitleOf(store, chapterId)（第 187 行那个）：
  //   别在这里再定义一个同名的局部函数 —— 那会**遮蔽**它，让本函数后面
  //   `chapterTitleOf(store, quest.chapterId)` 那个调用把 store 当成 chapterId 传进去，
  //   结果 `chapterTitle` 恒为空串（2026-11-12 一脚踩进去过，测试当场逮住）。
  const depEntry = (id) => {
    const q = store.questsById.get(id);
    const exists = Boolean(q);
    const chapterId = q?.chapterId ?? '';
    return {
      id,
      title: q ? displayNameOf(q, instance) : '（不存在的任务）',
      exists,
      /** 它在哪一章 —— 界面靠这个「跨章节也能跳过去」（2026-11-12） */
      chapterId,
      chapterTitle: chapterId ? chapterTitleOf(store, chapterId) : '',
    };
  };
  const upstream = quest.dependencies.map(depEntry);
  const downstream = store.quests.filter((q) => q.dependencies.includes(questId))
    .map((q) => depEntry(q.id));

  return {
    id: quest.id,
    /**
     * 给人看的名字（没标题时退回副标题 / 图标名 / 物品中文名）。
     * 用户 2026-11-11：「显示前置后置任务的时候用任务标题不要用编号」——
     * 这条规矩对「当前这个任务自己」同样适用，否则右栏标题栏还是一串编号。
     */
    title: displayNameOf(quest, instance),
    /** 文件里的真值 (原始标题，没清颜色码)。要精确值的地方读这个。 */
    rawTitle: quest.rawTitle ?? quest.title,
    /** 标题的带样式片段 —— 界面按它渲染出 `&6` 那种颜色（2026-11-11 用户要的） */
    titleSpans: quest.titleSpans,
    titleSource: quest.titleSource,
    titleItem: quest.titleItem,
    /** 这个任务在游戏里显示的那个物品（FTB 的 icon；没写就是第一个物品任务） */
    icon: quest.icon ?? '',
    subtitle: quest.subtitle,
    description: quest.description,
    /**
     * 描述的块化版本（一行一层，每行是文字块/图片块），界面渲染图文混排用。
     *
     * `description` 保持纯字符串数组不动 —— 体检、搜索、MCP 工具都在用那个形状。
     * 解析规则见 `packages/core/quest-desc.js`。
     */
    descriptionBlocks: quest.descriptionBlocks,
    /**
     * 描述按 `{@pagebreak}` 分页后的块数组（2026-11-11 用户：「很多任务需要翻页查看」）。
     * `descriptionPages.length > 1` → 界面出翻页按钮；只有 1 页时和 descriptionBlocks 等价。
     *
     * 有意思的是：这里顺手把 `{item.minecraft.diamond}` 这类占位符
     * **换成了中文名**（只在给了 instance 时）。查不到的占位符原样保留 ——
     * 用户看到 ID 还能自己去搜，换成空串会把句子读断。
     */
    descriptionPages: (() => {
      const pages = quest.descriptionPages ?? [];
      if (!instance) return pages;
      return pages.map((page) => resolveHolders(page, (holder) => resolveHolderName(instance, holder)));
    })(),
    /** 有几页（界面不用自己数 descriptionPages.length） */
    descriptionPageCount: (quest.descriptionPages ?? []).length,
    chapterId: quest.chapterId,
    chapterTitle: chapterTitleOf(store, quest.chapterId),
    chapterFile: quest.chapterFile,
    x: quest.x,
    y: quest.y,
    shape: quest.shape,
    size: quest.size,
    // 要求 / 奖励里的 ID 也翻成中文名（2026-11-12 用户第二条：和标题保持一致）。
    // `what` 保留原始 ID 作为机器可读值，另外加 `label` 给人看 —— 界面优先用 label。
    // 这样「改条件」表单预填还能拿到真正的 ID，不会被中文名污染。
    tasks: quest.taskSummary.map((t) => ({
      ...t,
      label: labelOf(instance, t.what, t.type),
      /**
       * 游戏里这个要求真正显示的样子（2026-11-12 第五批 B）：
       * 带类型前缀、带颜色，和游戏里各 `getAltTitle()` 一致。
       *   `访问维度: minecraft:the_nether（下界）`   深绿
       *   `进度: Minecraft`                          黄
       *   `3x 金锭`                                  白（物品没有前缀）
       * `label` 保留（不带前缀，表单和搜索在用）；界面优先显示 `title`。
       */
      title: taskTitleOf(instance, t),
      /** 分段（前缀白 / 变量上色），界面要精确上色时用 */
      titleParts: taskTitlePartsOf(instance, t),
    })),
    /** 界面按类型预填表单用：和 tasks 一一对应，含类型与字段值 */
    taskSpecs: quest.tasks.map(specFromTask),
    rewards: quest.rewards.map((r) => {
      const brief = rewardBrief(r);
      return { ...brief, label: labelOf(instance, brief.what, brief.type) };
    }),
    upstream,
    downstream,
    /**
     * 依赖的满足方式（2026-11-12 第二批）。
     * 「前置」那一栏的标题要靠它说话 —— 44 处「任意一个完成」的任务
     * 如果还按「与」显示，用户看到的就是假信息。
     */
    dependencyRequirement: quest.dependencyRequirement ?? 'all_completed',
    minRequiredDependencies: Number(quest.minRequiredDependencies ?? 0) || 0,
    /**
     * 三个改变玩家体验的开关（2026-11-12 第五批）。
     * 真包实测 ATM10Sky：optional 633 处、invisible 51 处、can_repeat 1 处。
     * `canRepeat` 是**三态**：true / false / null（null = 跟随章节的 default_repeatable）。
     */
    optional: quest.optional === true,
    invisible: quest.invisible === true,
    canRepeat: quest.canRepeat ?? null,
    locale: store.locale,
    langFile: `lang/${store.locale}.snbt`,
    /** 语言文件在不在；不在的话改文字会新建一个 */
    textFileExists: fs.existsSync(path.join(store.questDir, 'lang', `${store.locale}.snbt`)),
  };
}

/** GET /quest —— 一个任务的详情（含上游/下游）。 */
export async function handleQuestDetail(request) {
  const params = await readParams(request);
  const { store } = openBook(params);
  const questId = text(params, 'questId');
  if (!questId) throw new McError('缺少任务 ID', '先在列表里点一个任务', 'McBadArgs');
  // 传 instance 才能把 `{item.x}` 换成中文名；解析失败也不该让详情打不开
  let instance = null;
  try {
    instance = resolveInstance(text(params, 'dir'), text(params, 'id'));
  } catch {
    instance = null;
  }
  return detailOf(store, questId, instance);
}

/**
 * GET /quest/condition-types —— 界面画「完成条件 / 奖励」表单用。
 * 返回两份类型目录（type / 中文名 / 每种类型要填哪些字段），
 * 唯一真源是 packages/core/quest-conditions.js，界面和模型改都照它来。
 */
export async function handleQuestConditionTypes() {
  return { tasks: TASK_TYPES, rewards: REWARD_TYPES };
}

/** GET /quest/preview —— 预览「会改什么」，**不写盘**、不回传整份文件内容。 */
export async function handleQuestPreview(request) {
  const params = await readParams(request);
  const plan = buildQuestPlan(params);
  return {
    questId: plan.questId,
    locale: plan.locale,
    questDir: plan.questDir,
    changes: plan.changes,
    warnings: plan.warnings,
    summary: plan.summary,
    files: plan.files.map((f) => ({
      kind: f.kind,
      name: f.name,
      path: f.file,
      created: f.created,
      bytes: Buffer.byteLength(f.content, 'utf8'),
    })),
    changed: plan.files.length > 0,
  };
}

/** POST /quest/apply —— 真写进去：先探能不能写、再备份、写完重读复验，不过就整批回滚。 */
export async function handleQuestApply(request) {
  const params = await readParams(request);
  const plan = buildQuestPlan(params);
  if (!plan.files.length) {
    throw new McError('没有任何改动', '先把要改的地方改一下，再点写入', 'McBadArgs');
  }

  for (const f of plan.files) {
    const writable = checkWritable(path.dirname(f.file));
    if (!writable.ok) {
      throw new McError(
        `写不进去：${writable.error}`,
        'DSH 默认只允许改当前工作目录里的文件。要改外面的整合包，得把这次会话的写权限放开到「完全访问」；或者把整合包复制到工作目录下再改。',
        'QuestNotWritable',
      );
    }
  }

  const { backups, done } = writeFiles(
    plan.files.map((f) => ({ file: f.file, content: f.content })),
    '改任务书',
  );

  // 复验：重读整套任务书，确认①还能解析②目标任务的每个字段真的是新值
  let after;
  let fresh;
  try {
    fresh = loadQuests(plan.questDir, { locale: plan.locale });
    after = fresh.questsById.get(plan.questId);
    if (!after) {
      throw new McError(`写完重读找不到任务 ${plan.questId}`, '文件可能写坏了，已回滚', 'QuestVerifyFailed');
    }
    for (const c of plan.changes) {
      // ★ 任务级字段（2026-11-13）不能拿「人话」比：changes 里存的是
      //   「'1.5 倍'」这种给人看的字符串，而重读出来的是数字 1.5 —— 直接比必挂，
      //   还会把好的写入回滚掉（探针当场逮住）。这类字段单独按真实值比。
      const qf = plan.questFieldChanges?.find((x) => x.key === c.field);
      if (qf) {
        const actualRaw = after.raw?.[c.field];
        // 原值本来就没有（= 默认）+ 现在还是默认 ⇒ 通过；否则按「真实值是否等于期望」判
        const expect = qf.after;
        const ok = isQuestFieldDefault(c.field, expect)
          ? isQuestFieldDefault(c.field, actualRaw) || actualRaw === undefined
          : questFieldSame(actualRaw, expect, qf.kind);
        if (!ok) {
          throw new McError(
            `写完重读发现「${c.label}」没变成新值：文件里是 ${JSON.stringify(actualRaw)}，期望 ${JSON.stringify(expect)}`,
            '文件可能写坏了，已回滚；把这次的参数发给开发者看看',
            'QuestVerifyFailed',
          );
        }
        continue;
      }
      // 注意：changes 里的 before/after 是「给人看的字符串」（描述是多行文本），
      // 所以复验时要把重读出来的数组按同样的方式拼回字符串再比。
      const actual = c.field === 'desc' ? after.description.join('\n')
        : c.field === 'tasks' ? describeEntries(after.tasks, 'task')
        : c.field === 'rewards' ? describeEntries(after.rewards, 'reward')
        : after[c.field];
      if (!sameValue(actual, c.after)) {
        throw new McError(
          `写完重读发现「${c.label}」没变成新值：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(c.after)}`,
          '文件可能写坏了，已回滚；把这次的参数发给开发者看看',
          'QuestVerifyFailed',
        );
      }
    }
  } catch (error) {
    restoreFiles(done);
    resetQuestCache();
    if (error instanceof McError) throw error;
    throw new McError(
      `写完重读失败（${error instanceof Error ? error.message : String(error)}）`,
      '已回滚，原文件没变',
      'QuestVerifyFailed',
    );
  }

  resetQuestCache();
  // 写完回显的详情也要能翻中文名（2026-11-12 修）
  // ★ 以前这里是 `detailOf(fresh, plan.questId)` —— 第三个参数没传，instance=null，
  //   于是「标题是物品 ID」的任务在写入后的回显里**一律退回裸 ID**，
  //   而预览/正常打开时是中文名。同一个任务两个名字，用户会以为改名没生效。
  let applyInstance = null;
  try {
    applyInstance = resolveInstance(text(params, 'dir'), text(params, 'id'));
  } catch {
    applyInstance = null; // 解析不出实例也不该让写入结果打不开
  }
  return {
    questDir: plan.questDir,
    locale: plan.locale,
    files: plan.files.map((f) => ({ kind: f.kind, name: f.name, path: f.file, created: f.created })),
    backups,
    changes: plan.changes,
    warnings: plan.warnings,
    summary: plan.summary,
    quest: detailOf(fresh, plan.questId, applyInstance),
  };
}
// ————————————————————————— 新建任务 / 新建章节 —————————————————————————

/** 把界面/MCP 工具传进来的「数字」变成数字；空值返回 undefined。 */
function numberOr(params, key) {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 新建任务时可以从界面上填的**任务级字段**（2026-11-13，默认值改造第一批）。
 *
 * 规矩：**参数没给就一个都不返回** —— 不传 = 不写 = 游戏用它自己的默认。
 * 别在这里填任何默认值，否则前端「没填」会被后端补成「明确写成默认值」，
 * 正好违背这一轮在做的事（VS 原则 1：默认值不写进文件）。
 *
 * 三态字段（`can_repeat` / `hide_dependency_lines` 等）必须保住「没给」和
 * 「明确给了 false」的区别：所以用 `Object.hasOwn` 判在不在，而不是判真假值。
 */
const QUEST_FIELD_PARAMS = [
  // 形状 / 大小
  ['shape', 'text'], ['size', 'number'],
  // 三个玩家能感觉到的开关
  ['optional', 'bool'], ['invisible', 'bool'], ['can_repeat', 'tristate'],
  // 依赖相关
  ['min_required_dependencies', 'number'], ['dependency_requirement', 'text'],
  ['hide_dependency_lines', 'tristate'], ['hide_dependent_lines', 'bool'],
  // 可见性（三态）
  ['hide_until_deps_visible', 'tristate'], ['hide_until_deps_complete', 'tristate'],
  ['hide_text_until_complete', 'tristate'], ['hide_details_until_startable', 'tristate'],
  // 其它
  ['disable_jei', 'tristate'], ['invisible_until_tasks', 'number'],
  ['require_sequential_tasks', 'tristate'], ['icon_scale', 'number'],
  ['min_width', 'number'], ['guide_page', 'text'],
  ['ignore_reward_blocking', 'bool'], ['progression_mode', 'text'],
];

/**
 * 改已有任务时**允许从界面改**的任务级字段（2026-11-13 默认值改造）。
 *
 * 和新建那组（`QUEST_FIELD_PARAMS`）不是同一份：这里是「改已有任务」用的，
 * 只放**界面上真有输入口**的几个，免得接口能改但没人调、又没人测。
 * 要加就把界面那张卡一起改。
 */
const QUEST_FIELD_EDITABLE = [
  ['shape', 'text'], ['size', 'number'],
  ['optional', 'bool'], ['invisible', 'bool'], ['can_repeat', 'tristate'],
];

/** 字段名 → 人话（diff / 预览卡上显示）。 */
const QUEST_FIELD_LABELS = {
  shape: '节点形状',
  size: '节点大小',
  optional: '可选任务（不做也能往下走）',
  invisible: '对玩家不可见',
  can_repeat: '可重复完成',
};

/** 值 → 人话。 */
function describeQuestFieldValue(key, value) {
  if (value === null || value === undefined) return '（没写，跟随章节）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (key === 'shape') return String(value) || '（跟随章节）';
  if (key === 'size') return `${value} 倍${Number(value) === 0 ? '（跟随章节）' : ''}`;
  return String(value);
}

/** 两个任务级字段值算不算一样（三态里 null 和 undefined 都算「没写」）。 */
function questFieldSame(before, after, kind) {
  const norm = (v) => {
    if (v === null || v === undefined) return null;
    if (kind === 'bool') return !!v;
    if (kind === 'number') return Number(v);
    if (kind === 'tristate') return v === true || v === false ? v : null;
    return String(v);
  };
  return norm(before) === norm(after);
}

/**
 * 从请求参数里读一个任务级字段。
 *
 * ★ **传 null 的语义是「恢复默认」**，不是「把值设成 null」：
 *   写盘层看到「等于默认值」就会把这个键删掉（`patchQuestFields` 的新能力）。
 *   界面点 ↩ 之后保存走的就是这条路。
 *
 * @returns {*} 值 / null（恢复默认）/ undefined（这个参数认不出，当没给）
 */
function readQuestFieldParam(params, key, kind) {
  const raw = params[key];
  // 显式 null / 空串 = 恢复默认（用户在界面上点了 ↩，或者清空了输入框）
  if (raw === null || raw === '') return null;
  if (kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === 'bool') {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    return undefined;
  }
  if (kind === 'tristate') {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    return null; // 认不出的三态值 = 跟随上级（最安全的解读）
  }
  return String(raw).trim();
}

function questFieldParams(params) {
  const out = {};
  for (const [key, kind] of QUEST_FIELD_PARAMS) {
    if (!Object.hasOwn(params, key)) continue;
    const raw = params[key];
    if (kind === 'number') {
      const n = numberOr(params, key);
      if (n !== undefined) out[key] = n;
    } else if (kind === 'bool') {
      // 布尔：认 true/false 和字符串 'true'/'false'，只认「明确给了值」
      if (raw === true || raw === 'true') out[key] = true;
      else if (raw === false || raw === 'false') out[key] = false;
    } else if (kind === 'tristate') {
      // 三态：true / false / 空（空 = 不写，交给游戏跟随上级）
      if (raw === true || raw === 'true') out[key] = true;
      else if (raw === false || raw === 'false') out[key] = false;
      else if (raw === null || raw === '') out[key] = null;
    } else {
      // 字符串型：空串等于「没填」—— 比如 shape 空串的意思是「跟随章节」，
      // 那正好等于默认值，不该写进文件（交给默认值判定去剔，这里就别塞空串）。
      const s = text(params, key);
      if (s !== '') out[key] = s;
    }
  }
  return out;
}

/** 描述：可能是数组，也可能是一段带换行的文字。 */
function descLines(params) {
  const raw = params.description ?? params.desc;
  if (raw === undefined || raw === null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/\r?\n/);
  return list.map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_DESC_LINES);
}

/** 把计划整理成界面要的形状（不包含文件正文）。 */
function questPlanPayload(plan, questDir) {
  return {
    kind: plan.kind,
    questId: plan.questId ?? '',
    chapterId: plan.chapterId ?? '',
    title: plan.title ?? plan.chapter?.title ?? '',
    chapter: plan.chapter ?? null,
    group: plan.groupTitle ?? '',
    x: plan.x ?? null,
    y: plan.y ?? null,
    orderIndex: plan.orderIndex ?? null,
    locale: plan.locale,
    questDir,
    diff: plan.diff,
    files: plan.writes.map((w) => ({
      path: w.file,
      name: path.basename(w.file),
      bytes: Buffer.byteLength(w.content, 'utf8'),
      created: !fs.existsSync(w.file),
    })),
  };
}

/** GET|POST /quest/add/preview —— 预览「新任务长什么样、会写哪几个文件」，不写盘。 */
export async function handleQuestAddPreview(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params);
  const plan = planAddQuest({
    questDir,
    store,
    chapter: text(params, 'chapter'),
    title: text(params, 'title'),
    subtitle: text(params, 'subtitle'),
    description: descLines(params),
    dependsOn: asList(params.dependsOn),
    taskItem: text(params, 'taskItem'),
    taskCount: numberOr(params, 'taskCount'),
    taskSpec: params.taskSpec,
    rewardItem: text(params, 'rewardItem'),
    rewardCount: numberOr(params, 'rewardCount'),
    rewardSpec: params.rewardSpec,
    icon: text(params, 'icon'),
    ...questFieldParams(params),
    x: numberOr(params, 'x'),
    y: numberOr(params, 'y'),
  });
  return questPlanPayload(plan, questDir);
}

/** POST /quest/add/apply —— 真加一个任务。写完立刻复查，出问题整体回滚。 */
export async function handleQuestAddApply(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params, true);
  const plan = planAddQuest({
    questDir,
    store,
    chapter: text(params, 'chapter'),
    title: text(params, 'title'),
    subtitle: text(params, 'subtitle'),
    description: descLines(params),
    dependsOn: asList(params.dependsOn),
    taskItem: text(params, 'taskItem'),
    taskCount: numberOr(params, 'taskCount'),
    taskSpec: params.taskSpec,
    rewardItem: text(params, 'rewardItem'),
    rewardCount: numberOr(params, 'rewardCount'),
    rewardSpec: params.rewardSpec,
    icon: text(params, 'icon'),
    ...questFieldParams(params),
    x: numberOr(params, 'x'),
    y: numberOr(params, 'y'),
  });
  // 注意：payload 必须在写盘之前算 —— 里面的 created 是「这文件原来在不在」，
  // 写完之后再算永远是 false，界面上就看不到「（新建）」了。
  const payload = questPlanPayload(plan, questDir);
  const done = commitQuestPlan({ plan, questDir, store });
  resetQuestCache();
  return { ...payload, backups: done.backups, lines: done.lines };
}

/** GET|POST /quest/chapter/preview —— 预览「新章节会叫什么、写哪个文件」，不写盘。 */
export async function handleChapterAddPreview(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params);
  const plan = planAddChapter({
    questDir,
    store,
    title: text(params, 'title'),
    group: text(params, 'group'),
    icon: text(params, 'icon'),
    orderIndex: numberOr(params, 'orderIndex'),
  });
  return questPlanPayload(plan, questDir);
}

/** POST /quest/chapter/apply —— 真新建一个章节。 */
export async function handleChapterAddApply(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params, true);
  const plan = planAddChapter({
    questDir,
    store,
    title: text(params, 'title'),
    group: text(params, 'group'),
    icon: text(params, 'icon'),
    orderIndex: numberOr(params, 'orderIndex'),
  });
  // 同上：先算 payload，再写盘
  const payload = questPlanPayload(plan, questDir);
  const done = commitQuestPlan({ plan, questDir, store });
  resetQuestCache();
  return { ...payload, backups: done.backups, lines: done.lines };
}


// ————————————————————— 拖拽画布 —————————————————————

/**
 * 把 moves 参数解析成 [{questId, x, y}]。
 * 界面直接传数组；走 query 时只能传 JSON 字符串；也允许「单个任务」的简写。
 */
function movesOf(params) {
  const raw = params.moves;
  if (raw === undefined || raw === null || raw === '') {
    if (params.questId !== undefined) {
      return [{ questId: text(params, 'questId'), x: numberOr(params, 'x'), y: numberOr(params, 'y') }];
    }
    return [];
  }
  let list = raw;
  if (typeof raw === 'string') {
    const raw2 = raw.trim();
    if (!raw2) return [];
    try {
      list = JSON.parse(raw2);
    } catch {
      throw new McError('moves 不是合法的 JSON', '应该是 [{"questId":"…","x":1,"y":2}]', 'MoveBadJson');
    }
  }
  if (!Array.isArray(list)) {
    throw new McError('moves 应该是数组', '每个元素是 {questId, x, y}', 'MoveBadJson');
  }
  return list.map((m) => ({ questId: m?.questId, x: m?.x, y: m?.y }));
}

/** 计划 → 界面能直接用的形状。 */
function movePayload(plan, questDir) {
  return {
    kind: plan.kind,
    changedCount: plan.changedCount,
    questDir,
    locale: plan.locale,
    moves: plan.moves,
    diff: plan.diff,
    files: plan.writes.map((w) => ({
      name: path.basename(w.file),
      path: w.file,
      bytes: Buffer.byteLength(w.content, 'utf8'),
      created: false,
    })),
  };
}

/** GET /quest/canvas —— 整本书的画布数据：每章的任务、坐标、依赖边。 */
export async function handleQuestCanvas(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params);
  const groups = new Map(store.chapterGroups.map((g) => [g.id, g.title]));
  // 2026-11-12：画布节点上的标题也要能翻出**物品中文名** ——
  // 那个包 3658 个任务里 1738 个的标题本来就是物品 ID（作者没写标题，
  // FTB 的规矩是显示要交的那个物品名）。不翻的话画布上满屏 `ae2:xxx`。
  const instance = locateInstance(params);

  const chapters = store.chapters.map((c) => {
    const nodes = c.quests.map((q) => ({
      id: q.id,
      /**
       * 画布节点上显示的文字。
       *
       * 用 `displayNameOf()` 而不是 `q.title`：没标题的任务在游戏里会退回
       * 显示物品名 / 副标题，我们在画布上写一串 16 位十六进制既不像游戏、也没法看
       * （2026-11-11 用户：「用任务标题不要用编号」）。2026-11-12 再进一步：
       * 显示物品 ID 的地方改显示物品的**中文名**。`rawTitle` 留着给需要
       * 精确值的地方（比如改名表单预填）。
       */
      title: displayNameOf(q, instance),
      rawTitle: q.title,
      /** 标题的带样式片段（画布节点方块上那行字按它渲染颜色） */
      titleSpans: q.titleSpans ?? null,
      titleSource: q.titleSource,
      titleItem: q.titleItem,
      /**
       * 画布上要画的那个物品。
       *
       * FTB 的规矩：写了 icon 就用 icon，没写就用「第一个物品任务的那个物品」。
       * core/quests.js 已经按这个规矩算好了，这里原样透给界面 ——
       * 界面拿到 ID 之后再去 /item-icons 换图，不用自己再判一遍。
       */
      icon: q.icon ?? '',
      x: Number(q.x) || 0,
      y: Number(q.y) || 0,
      /** 自己写的形状（空 = 继承章节 / 全局默认） */
      shape: q.shape ?? '',
      /**
       * 真正生效的形状（2026-11-03「任务书成品预览」）：
       * 任务自己 → 章节 default_quest_shape → 全局 data.snbt → circle。
       * 界面按这个字段画节点，跟游戏里才对得上。
       */
      shapeEffective: q.shapeEffective ?? q.shape ?? '',
      /** 真正生效的大小倍率（1 / 1.5 / 2 …） */
      size: Number(q.sizeEffective ?? q.size ?? 1) || 1,
      taskCount: q.tasks.length,
      rewardCount: q.rewards?.length ?? 0,
      /** 它依赖谁（画成从依赖指向自己） */
      dependencies: q.dependencies.map((dep) => {
        const target = store.questsById.get(dep);
        return {
          id: dep,
          title: target?.title ?? '',
          chapterId: target?.chapterId ?? '',
          missing: !target,
        };
      }),
      /**
       * 依赖的满足方式（2026-11-12 第二批）。
       * 四种：all_completed（默认）/ one_completed / all_started / one_started。
       * 界面上「前置任意一个完成」这类任务要显示成人话，别一律画成「与」。
       */
      dependencyRequirement: q.dependencyRequirement ?? 'all_completed',
      /** 「至少 N 个前置满足就算过」，0 = 没用这个功能（优先级高于 dependencyRequirement） */
      minRequiredDependencies: Number(q.minRequiredDependencies ?? 0) || 0,
      /** 谁依赖它 —— 界面画线时要成对知道，免得重复画 */
      dependents: store.quests.filter((o) => o.dependencies.includes(q.id)).map((o) => o.id),
    }));
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    // 背景图 / 装饰图的 x/y 是图片正中心，占 ±宽/2、±高/2；报出去的 bounds 要连它
    // 一起算（2026-11-11：以前只按节点算，大图铺出去的范围没算进来）。
    for (const im of c.images ?? []) {
      xs.push((im.x ?? 0) - (im.width ?? 0) / 2, (im.x ?? 0) + (im.width ?? 0) / 2);
      ys.push((im.y ?? 0) - (im.height ?? 0) / 2, (im.y ?? 0) + (im.height ?? 0) / 2);
    }
    return {
      id: c.id,
      title: c.title,
      file: c.file,
      group: c.group,
      groupTitle: groups.get(c.group) ?? '',
      icon: c.icon,
      orderIndex: Number(c.raw?.order_index ?? 0),
      // 章节自己的默认形状 / 默认大小（空 = 继承全局）
      defaultQuestShape: c.defaultQuestShape ?? '',
      defaultQuestSize: Number(c.defaultQuestSize ?? 0) || 0,
      // 章节背景图 / 装饰图（2026-11-02：之前被丢掉，画布上从来没画过）
      images: c.images ?? [],
      nodes,
      bounds: xs.length
        ? { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
        : null,
    };
  });

  return {
    questDir,
    locale: store.locale,
    chapterCount: chapters.length,
    questCount: store.quests.length,
    chapters,
  };
}

/** GET|POST /quest/move/preview —— 预览「挪完之后坐标会变成什么」，不写盘。 */
export async function handleQuestMovePreview(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params);
  const plan = planMoveQuests({ questDir, store, moves: movesOf(params) });
  return movePayload(plan, questDir);
}

/** POST /quest/move/apply —— 真写坐标。写完重读 + 体检，出问题整体回滚。 */
export async function handleQuestMoveApply(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params, true);
  const plan = planMoveQuests({ questDir, store, moves: movesOf(params) });
  // 先算 payload 再写盘（里面的信息是写盘前的状态）
  const payload = movePayload(plan, questDir);
  const done = commitMovePlan({ plan, questDir, store });
  resetQuestCache();
  return { ...payload, backups: done.backups, lines: done.lines };
}

// ————————————————————— 右键编辑节点 —————————————————————
//
// 界面右键一个任务节点，能做三件事：换图标物品、接/断前置依赖、删掉它。
// 改标题/副标题/坐标走的是上面那条老链路（buildQuestPlan + /quest/preview），这里不重复。

/**
 * 从参数里取「改图标」的 target。
 * 没传、传空串都算「不改」（不是「删掉图标」）；给了就原样交给 core 去校验。
 */
function iconOf(params) {
  if (!has(params, 'icon')) return undefined;
  const value = params.icon;
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  return raw || undefined;
}

/**
 * 从参数里取「改前置依赖」的 target。
 * 界面传 JSON 字符串（'["AB12"]'），走 query 时也只能是字符串，所以这里原样透传，
 * 由 core 的 parseDependencies 统一解析 —— 解析规则只有一份。
 */
function dependenciesOf(params) {
  if (!has(params, 'dependencies')) return undefined;
  const value = params.dependencies;
  if (value === undefined || value === null) return undefined;
  // 空串当「不改」，和图标保持一致；要清空就传 [] 或 '[]'
  if (typeof value === 'string' && !value.trim()) return undefined;
  return value;
}

/** 「改图标 / 改依赖」的计划 → 界面能直接吃的形状（不把整份文件内容透给界面）。 */
function nodeEditPayload(plan, questDir) {
  return {
    kind: plan.kind,
    questDir,
    locale: plan.locale,
    questId: plan.questId,
    questTitle: plan.questTitle,
    changedCount: plan.changedCount,
    changes: plan.changes,
    diff: plan.diff,
    warnings: plan.warnings,
    files: plan.writes.map((w) => ({
      name: path.basename(w.file),
      path: w.file,
      bytes: Buffer.byteLength(w.content, 'utf8'),
      created: false,
    })),
  };
}

/** 「删任务」的计划 → 界面能直接吃的形状。 */
function nodeDeletePayload(plan, questDir) {
  return {
    kind: plan.kind,
    questDir,
    locale: plan.locale,
    questId: plan.questId,
    questTitle: plan.questTitle,
    chapterId: plan.chapterId,
    chapterTitle: plan.chapterTitle,
    dependents: plan.dependents,
    affectedCount: plan.affectedCount,
    changedCount: plan.changedCount,
    warnings: plan.warnings,
    diff: plan.diff,
    files: plan.writes.map((w) => ({
      name: path.basename(w.file),
      path: w.file,
      bytes: Buffer.byteLength(w.content, 'utf8'),
      created: false,
    })),
  };
}

/** GET|POST /quest/node/preview —— 预览「换图标 / 改依赖会写成什么样」，不写盘。 */
export async function handleQuestNodePreview(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params);
  const plan = planNodeEdit({
    questDir,
    store,
    questId: text(params, 'questId'),
    icon: iconOf(params),
    dependencies: dependenciesOf(params),
  });
  return nodeEditPayload(plan, questDir);
}

/** POST /quest/node/apply —— 真写图标/依赖。写完重读 + 体检，出问题整体回滚。 */
export async function handleQuestNodeApply(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params, true);
  const plan = planNodeEdit({
    questDir,
    store,
    questId: text(params, 'questId'),
    icon: iconOf(params),
    dependencies: dependenciesOf(params),
  });
  // 先算 payload 再写盘（里面的 before/after 是写盘前的状态）
  const payload = nodeEditPayload(plan, questDir);
  const done = commitNodeEdit({ plan, questDir, store });
  resetQuestCache();
  return { ...payload, backups: done.backups, lines: done.lines };
}

/** GET|POST /quest/node/delete/preview —— 预览「删掉这个任务会动哪些文件」，不写盘。 */
export async function handleQuestNodeDeletePreview(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params);
  const plan = planNodeDelete({ questDir, store, questId: text(params, 'questId') });
  return nodeDeletePayload(plan, questDir);
}

/** POST /quest/node/delete/apply —— 真删。写完重读 + 体检，出问题整体回滚。 */
export async function handleQuestNodeDeleteApply(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params, true);
  const plan = planNodeDelete({ questDir, store, questId: text(params, 'questId') });
  const payload = nodeDeletePayload(plan, questDir);
  const done = commitNodeDelete({ plan, questDir, store });
  resetQuestCache();
  return { ...payload, backups: done.backups, lines: done.lines };
}

/**
 * POST /quest/images —— 章节背景图批量取图。
 *
 * 界面把当前章 images 里出现过的资源 ID 一次发来，这里从 mod jar 里把 PNG
 * 抠成 data URL 返回；jar 里没有的（图丢了、mod 没装）键就不出现，
 * 界面对缺失的图静默跳过 —— 缺背景图不该变成一条报错。
 * 允许 GET 是为了 curl 调试单张；界面走 POST（src 是数组）。
 */
export async function handleQuestImages(request) {
  const params = await readParams(request);
  const dir = text(params, 'dir');
  if (!dir) throw new McError('缺少整合包目录', '先在界面里连一个整合包', 'McBadArgs');
  const instance = resolveInstance(dir, text(params, 'id'));
  const srcs = asList(params.srcs);
  return resolveQuestImages(instance, srcs);
}

// ————————————————————————— 章节装饰图（加 / 挪 / 删） —————————————————————————
// 装饰图指 FTB 章节文件里的 images：贴在画布上的背景图和说明图，不是任务节点。

/**
 * 从参数里收集一张装饰图的字段。
 * 空串按「没给」处理 —— 界面表单里没填的框就是空串，不能把它当成 0 写进文件。
 */
function imageFields(params) {
  const pick = (key) => {
    const raw = params[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'string' && !raw.trim()) return undefined;
    return raw;
  };
  return {
    image: pick('image'),
    x: pick('x'),
    y: pick('y'),
    width: pick('width'),
    height: pick('height'),
    rotation: pick('rotation'),
    index: pick('index') ?? pick('imageIndex'),
  };
}

/** 「装饰图」的计划 → 界面能直接吃的形状（文件正文不透给界面）。 */
function imagePlanPayload(plan, questDir) {
  return {
    kind: plan.kind,
    action: plan.action,
    questDir,
    chapterId: plan.chapterId,
    chapterTitle: plan.chapterTitle,
    chapterFile: plan.chapterFile,
    changedCount: plan.changedCount,
    changes: plan.changes,
    diff: plan.diff,
    warnings: plan.warnings,
    files: plan.writes.map((w) => ({
      name: path.basename(w.file),
      path: w.file,
      bytes: Buffer.byteLength(w.content, 'utf8'),
      created: false,
    })),
  };
}

/** 两个 handler 共用的「把参数算成计划」，保证预览和写入用的是同一套判断。 */
function buildImagePlan(params, store, questDir) {
  const f = imageFields(params);
  return planImageEdit({
    questDir,
    store,
    chapter: text(params, 'chapter') || text(params, 'chapterId'),
    action: text(params, 'action') || 'add',
    index: f.index,
    image: f.image,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    rotation: f.rotation,
  });
}

/** GET|POST /quest/image/preview —— 预览「加/挪/删一张装饰图会写成什么样」，不写盘。 */
export async function handleQuestImagePreview(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params);
  return imagePlanPayload(buildImagePlan(params, store, questDir), questDir);
}

/** POST /quest/image/apply —— 真写。写完重读 + 复查，出问题整体回滚。 */
export async function handleQuestImageApply(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params, true);
  const plan = buildImagePlan(params, store, questDir);
  // 先算 payload 再写盘（里面的 before/after 是写盘前的状态）
  const payload = imagePlanPayload(plan, questDir);
  const done = commitImagePlan({ plan, questDir, store });
  resetQuestCache();
  return { ...payload, backups: done.backups, lines: done.lines };
}

// ————————————————————————— 蓝图式编辑（2026-11-09） —————————————————————————
// 画布上「把物品框拖进任务节点 / 拖到空白处」「Ctrl+C/V 复制节点」三件事，
// 都走 plan → apply 两态，界面和 MCP 工具共用下面这些函数。

/** 「追加物品要求」的计划 → 界面能吃的形状（不把文件正文透出去）。 */
function nodeItemsPayload(plan, questDir) {
  return {
    kind: plan.kind,
    questDir,
    locale: plan.locale,
    questId: plan.questId,
    questTitle: plan.questTitle,
    item: plan.item,
    count: plan.count,
    changedCount: plan.changedCount,
    changes: plan.changes,
    diff: plan.diff,
    warnings: plan.warnings,
    files: plan.files,
  };
}

/** 三个「预览」handler 共用的参数收集，保证预览和写入逐字一致。 */
function nodeItemsParams(params) {
  return {
    questId: text(params, 'questId'),
    item: text(params, 'item'),
    count: numberOr(params, 'count'),
  };
}

/** GET|POST /quest/node/items/preview —— 预览「拖个物品进任务会加哪条要求」，不写盘。 */
export async function handleQuestNodeItemsPreview(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params);
  return nodeItemsPayload(planNodeItems({ ...nodeItemsParams(params), store, questDir }), questDir);
}

/** POST /quest/node/items/apply —— 真追加。写盘后重读 + 体检，出问题整体回滚。 */
export async function handleQuestNodeItemsApply(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params, true);
  const plan = planNodeItems({ ...nodeItemsParams(params), store, questDir });
  const payload = nodeItemsPayload(plan, questDir);
  const done = commitNodeEdit({ plan, questDir, store });
  resetQuestCache();
  return { ...payload, backups: done.backups, lines: done.lines };
}

/** 复制 / 生成任务的共用参数。 */
function blueprintParams(params) {
  return {
    questDir: undefined, // 由 openBook 填
    sourceQuestId: text(params, 'sourceQuestId') || text(params, 'questId'),
    item: text(params, 'item'),
    count: numberOr(params, 'count'),
    x: numberOr(params, 'x'),
    y: numberOr(params, 'y'),
    chapter: text(params, 'chapter'),
  };
}

/** GET|POST /quest/clone/preview —— 预览「复制这个任务会写出什么」，不写盘。 */
export async function handleQuestClonePreview(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params);
  return questPlanPayload(planCloneQuest({ ...blueprintParams(params), store, questDir }), questDir);
}

/** POST /quest/clone/apply —— 真复制一个任务节点。 */
export async function handleQuestCloneApply(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params, true);
  const plan = planCloneQuest({ ...blueprintParams(params), store, questDir });
  // payload 必须在写盘前算：files[].created 是「写之前这文件原来在不在」
  const payload = questPlanPayload(plan, questDir);
  const done = commitQuestPlan({ plan, questDir, store });
  resetQuestCache();
  return { ...payload, backups: done.backups, lines: done.lines };
}

/** GET|POST /quest/spawn/preview —— 预览「把物品拖到空白处会长出什么任务」，不写盘。 */
export async function handleQuestSpawnPreview(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params);
  return questPlanPayload(planSpawnQuest({ ...blueprintParams(params), store, questDir }), questDir);
}

/** POST /quest/spawn/apply —— 真在空白处生成任务节点。 */
export async function handleQuestSpawnApply(request) {
  const params = await readParams(request);
  const { store, questDir } = openBook(params, true);
  const plan = planSpawnQuest({ ...blueprintParams(params), store, questDir });
  const payload = questPlanPayload(plan, questDir);
  const done = commitQuestPlan({ plan, questDir, store });
  resetQuestCache();
  return { ...payload, backups: done.backups, lines: done.lines };
}