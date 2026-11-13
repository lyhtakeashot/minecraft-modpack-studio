/**
 * FTB Quests 任务书读写。
 *
 * 任务书在磁盘上就是一叠 .snbt 文本文件：
 *   quests/
 *     data.snbt                    全局设置（默认形状、缩放等）
 *     chapter_groups.snbt          章节分组（可选）
 *     chapters/<章节ID>.snbt        每个章节一个文件，里面是 tasks 数组
 *     lang/<语言>.snbt              文本（标题、描述）单独放这里
 *     reward_tables/<ID>.snbt       奖励表（可选）
 *
 * 关键认知：**任务的结构和任务的文字是分开存的**。chapters/*.snbt 里基本只有
 * id / 坐标 / 依赖 / 任务条件，人看到的中文标题和描述都在 lang/zh_cn.snbt 里。
 * 所以改一个任务的名字，要动 lang 文件；挪一个任务的位置，要动 chapter 文件。
 * 两处都改的时候必须一起改，否则出现「有标题没任务」或「有任务没标题」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSnbt, parseSpans, applyEdits, insertionEdit, formatLiteral, formatLike, formatBlock } from './snbt.js';
import { checkQuestImageExists } from './quest-images.js';
import { parseDescLines, parseDescPages } from './quest-desc.js';
import {
  buildEntry,
  entryCount,
  entryWhat,
  missingFields,
  requiredFields,
  rewardDef,
  summarizeReward,
  summarizeTask,
  taskDef,
  typeLabel,
} from './quest-conditions.js';
import { McError } from './errors.js';
import { isDefault, normalizeForWrite, pickWritable } from './quest-defaults.js';

const LOCALE_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const DEFAULT_LOCALE = 'en_us';

/** 章节节点允许的几种形状（写 SNBT 时 FTB 会校验）。 */
export const QUEST_SHAPES = [
  'circle', 'diamond', 'gear', 'heart', 'hexagon', 'none',
  'octagon', 'pentagon', 'rsquare', 'square',
];

const readIf = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
};

const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * 依赖的四种满足方式与判定 —— 已经搬到 `./quest-deps.js`（2026-11-12 16:45）。
 *
 * ★ **为什么搬**：界面也要用 `dependencyStatus()` 判断节点状态，
 *   而本文件顶部 import 了 `node:fs` / `node:path`，浏览器里加载即报错。
 *   搬出去之后界面引的是 `quest-deps.js`（零 Node 依赖），
 *   这里再 re-export 一遍，老调用方（`test` / `lib/host`）一个字都不用改。
 *
 * **新代码别再把界面要用的纯逻辑写进这个文件。**
 */
export {
  DEPENDENCY_REQUIREMENTS,
  DEFAULT_DEPENDENCY_REQUIREMENT,
  dependencyRequirementOf,
  dependencyStatus,
  dependencyStatusAll,
  normalizeRequirement,
} from './quest-deps.js';

// ★ 光有上面的 `export { ... } from` 还不够：那只把符号**转发**出去，
//   本文件作用域里拿不到它。而下面的 `buildQuest()` 要直接调 `normalizeRequirement()`，
//   所以必须再真 import 一次（漏了这句 = 运行时 ReferenceError，测试会成片挂掉）。
import { normalizeRequirement } from './quest-deps.js';

/**
 * 读 FTB 的三态字段（`can_repeat` / `hide_*` 那类）。
 *
 * 三态是 `true` / `false` / **没写**，第三种表示「跟随上级设置」
 * （`can_repeat` 没写就跟章节的 `default_repeatable`）。
 * ★ **必须把「没写」和「写了 false」区分开** —— 归成布尔的话，
 *   读一遍再写回去会悄悄把「跟随章节」改成「明确不可重复」。
 *
 * @returns {boolean|null} null = 没写，跟随上级
 */
function readTristate(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null; // 认不出来的当没写，别瞎猜
}

/**
 * MC 的 16 个基础颜色（ChatFormatting 的标准值）。
 *
 * 这几组值是 MC 从 1.0 到现在一直没变的固定色板，跟游戏里 `§6` 显示的那个橙色
 * 完全一致。项目里 `probe/ftbqp/lib/minecraft-text.js:1` 早就有一份（那份是
 * Canvas 逐字形渲染用的），这里照抄同一份值 —— 两处必须一致，否则同一个任务
 * 在「任务书预览」和「任务详情」里颜色会不一样。
 */
const MC_COLORS = {
  0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa',
  4: '#aa0000', 5: '#aa00aa', 6: '#ffaa00', 7: '#aaaaaa',
  8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff',
  c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff',
};

/** 格式码 → 样式名。这些**不换颜色**，只叠样式（`&l` 粗体、`&m` 删除线…）。 */
const MC_STYLE_FLAGS = { l: 'bold', o: 'italic', n: 'underline', m: 'strike' };

/**
 * 把带 MC 格式码的文本切成「片段」，交给界面按颜色渲染。
 *
 * 2026-11-11 用户：「把颜色的显示也做出来吧，这样游戏里和这里看的效果一样」。
 * 上一轮只是把 `&6&l` 这类码**删掉**（治乱码），这一轮要**真的画出颜色**。
 *
 * 语义严格照 MC 的规则（这条最容易写错）：
 *   - **`&0`~`&f` 换颜色，并且会把「样式」一起重置**（游戏中 `&6&lA&2B` → B 是绿色且**不粗**）。
 *   - 反过来 `&l` 这类格式码**不动颜色**（`&6A&lB` → B 是橙色且粗）。
 *   - `&r` 全部重置（颜色回白、样式全清）。
 *   - `&#rrggbb` 换自定义颜色（不重置样式 —— 真实的 MC 行为里 hex 只换颜色）。
 *   - `&k`（乱码）没法在静态页面还原，**丢掉这个码、文字照常显示**。
 *   - `&z` 是 FTB 的「彩虹」色（实测 ATM10Sky 8 处，全在 Rainbow 系列物品上）。
 *     游戏里是流动的渐变，网页里还原成**静态的紫色**（`#ff55ff`）已经能表达
 *     「这是个特殊颜色」，硬做动画反而会闪得没法看字。
 *
 * ★ `\\&` 是转义的字面 `&`，必须原样留下（真数据 `"Ludicrite \\& Ridiculite"`）。
 *
 * @param {string} text 原始文本（含格式码）
 * @returns {Array<{text: string, color: string, bold: boolean, italic: boolean, underline: boolean, strike: boolean}>}
 *   片段数组；纯文字（没有格式码）时返回**一段**，界面可以靠 `length===1 && !有样式` 快速判断。
 */
export function parseMcFormatting(text) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  const initial = () => ({ color: '', bold: false, italic: false, underline: false, strike: false });
  let style = initial();
  const out = [];
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    out.push({ text: buffer, ...style });
    buffer = '';
  };

  for (let i = 0; i < src.length;) {
    const ch = src[i];
    // 转义的字面 &：原样留下，不进格式解析
    if (ch === '\\' && src[i + 1] === '&') {
      buffer += '&';
      i += 2;
      continue;
    }
    const isMarker = ch === '&' || ch === '§';
    if (isMarker) {
      const rest = src.slice(i + 1);
      // 十六进制颜色 &#rrggbb（只换颜色，不重置样式）
      const hex = /^#([0-9a-fA-F]{6})/.exec(rest);
      if (hex) {
        flush();
        style = { ...style, color: `#${hex[1].toLowerCase()}` };
        i += 1 + hex[0].length;
        continue;
      }
      // ★ 这里**必须用原始大小写判断，不能 toLowerCase**：
      //   真数据 `"Jewelry&Accessories"` 里作者拿 `&` 当连接符，`&A` 小写化之后
      //   会命中颜色码 `&a`，把「Accessories」染成绿色 —— 名字就毁了。
      //   MC 自己渲染时也只认小写格式码，大写原样显示，所以按小写判和游戏一致。
      const code = rest[0];
      // 颜色码：换色 + 重置样式（MC 的真实行为）
      if (code && Object.hasOwn(MC_COLORS, code)) {
        flush();
        style = { ...initial(), color: MC_COLORS[code] };
        i += 2;
        continue;
      }
      // &z：FTB 的彩虹色 → 静态紫
      if (code === 'z') {
        flush();
        style = { ...initial(), color: '#ff55ff' };
        i += 2;
        continue;
      }
      // &r：全部重置
      if (code === 'r') {
        flush();
        style = initial();
        i += 2;
        continue;
      }
      // &k 乱码：丢掉这个码，后面的字照常显示
      if (code === 'k') {
        flush();
        i += 2;
        continue;
      }
      // &l &o &n &m：只叠样式，不动颜色
      if (code && MC_STYLE_FLAGS[code]) {
        flush();
        style = { ...style, [MC_STYLE_FLAGS[code]]: true };
        i += 2;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();

  // 一段都没有（空字符串）时给一个空段，界面不用额外判空
  if (!out.length) out.push({ text: '', ...initial() });
  return out;
}

/**
 * 片段数组里有没有任何样式 / 颜色（界面用它决定是「纯文字快路径」还是「分段渲染」）。
 * @param {Array<object>} spans
 * @returns {boolean}
 */
export function hasMcFormatting(spans) {
  return Array.isArray(spans) && spans.some((s) => s.color || s.bold || s.italic || s.underline || s.strike);
}

/**
 * 去掉 MC 的颜色 / 格式代码，只留人话。
 *
 * 2026-11-11 用户报障「任务名字有很多乱码，我估计是正则切的不对」——
 * 实测不是切错，是**这些代码本来就在数据里**：ATM10Sky 有 1041 个任务标题带
 * `&6&l` / `&f` / `&r` 这类标记（FTB 用 `&` 当格式前缀，和 `§` 等价），
 * 界面把标记原样画出来就成了「&6&lApotheosis Adventure」这种乱码。
 *
 * 现在这个函数主要用在**不能用富文本的地方**（文件名、搜索匹配、纯文本摘要）；
 * 要显示在界面上的地方改用 `parseMcFormatting()`，那样颜色能画出来。
 *
 * ★ 两个必须躲开的坑（实测踩过）：
 *   1. **`\\&` 是转义的字面 `&`** —— `"Ludicrite \\& Ridiculite"` 表示「Ludicrite & Ridiculite」，
 *      这种 `&` 后面跟的是空格，不是代码。所以只认「`&` + 一个在名单里的字符」，
 *      绝不能写成 `/&./`（那会把真名字里的 `&` 和它后面一个字符一起吃掉）。
 *   2. **`&#rrggbb` 是十六进制颜色**（本项目实测 8 处），要整段吃掉，
 *      否则会剩下 `#rrggbb` 贴在标题里。
 *
 * ★ 还有一处**没法完美区分**的（实测重度机械症 1 例）：
 *   `"Jewelry&Accessories"` —— 作者把 `&` 当普通连接符用，但 `&A` 恰好是
 *   「颜色码」的形状。判据用**大小写**：MC 的颜色/格式码**全是小写**（`&a` `&l` `&r`），
 *   写成大写 `&A` 的必然是名字里的字面 `&`。所以正则**不加 `i` 标志**。
 *   （这条不 100% 严谨 —— 作者理论上可以写大写颜色码，但 FTB 自己渲染时也只认小写，
 *   大写原样显示，所以按小写判和游戏观感一致。）
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMcFormatting(text) {
  if (typeof text !== 'string' || !text) return '';
  return parseMcFormatting(text).map((s) => s.text).join('').replace(/^\s+|\s+$/g, '');
}

/** 任务文字的三个键在 lang 文件里的真实名字。 */
const TEXT_KEYS = { title: 'title', subtitle: 'quest_subtitle', desc: 'quest_desc' };

function textOf(strings, fallback, key, rawValue) {
  return strings[key] ?? fallback[key] ?? rawValue;
}

/**
 * 这个任务自己有没有「像人话的名字」。
 *
 * 用来决定要不要给它编号：真标题 / 物品名标题 / 副标题 / 图标名，四样占一个就算有。
 * 四样全无的才是那种「纯打勾的说明节点」—— 游戏里也显示不出名字。
 *
 * @param {{title?: string, titleSource?: string, subtitle?: string, icon?: string, id?: string}} q
 * @returns {boolean}
 */
function hasOwnName(q) {
  const id = String(q?.id ?? '');
  const title = String(q?.title ?? '');
  if (title && q?.titleSource !== 'id' && title !== id) return true;
  if (String(q?.subtitle ?? '').trim()) return true;
  const icon = String(q?.icon ?? '').trim();
  if (icon && icon.includes(':')) return true;
  return false;
}

/**
 * 从任务的完成条件里挑一个「能当名字」的线索。
 *
 * 背景（2026-11-12 实测 ATM10Sky 3658 个任务）：有些任务作者**既没写标题、
 * 也没有物品条件**，`titleSource === 'id'`，界面上只能显示 `untitledN` 或裸 ID。
 * 但这类任务往往**有条件本身就很说明问题** —— 「击杀苦力怕」「到达下界」
 * 「完成进度 xxx」，比 `untitled7` 有用得多。
 *
 * 这个函数只负责「挑出那条线索」，**不负责翻译**：
 * 返回的是原始 ID（`minecraft:zombie`）+ 类型（`kill`），
 * 由调用方（宿主层 `itemNameOf()`）换成中文名 —— core 是纯函数，
 * 不许碰 jar / fs（界面也 import 它）。
 *
 * 挑选优先级（越具体越优先）：
 *   1. `kill` / `dimension` / `biome` / `structure` / `advancement` / `effect`
 *      —— 这些 ID 本身就是个名词，翻译出来很好读
 *   2. `item` / `fluid` —— 物品名也不错，但它已经被 `titleSource === 'item'` 那条路
 *      优先吃掉了；走到这里说明**没有物品条件**，留作兜底
 *   3. `stat` / `gamestage` —— 名词性差一点，但聊胜于无
 *   ✗ 明确排除：`checkmark`（纯打勾，没有 what）、`xp` / `xp_levels`（数字不是名字）、
 *     `command`（一长串命令，当名字会糊满屏）、`toast` / `observation`（说明性文字）
 *
 * @param {{tasks?: Array<object>, taskSummary?: Array<{type: string, what: string}>}} q
 * @returns {{type: string, what: string}|null} 没挑出来返回 null
 */
export function nameHintOf(q) {
  // 优先用已经算好的 taskSummary（它和界面显示的是同一份 what，不会两处不一致）
  const list = Array.isArray(q?.taskSummary) && q.taskSummary.length
    ? q.taskSummary.map((t) => ({ type: String(t?.type ?? ''), what: String(t?.what ?? '') }))
    : (Array.isArray(q?.tasks) ? q.tasks : []).map((t) => ({ type: String(t?.type ?? 'item'), what: entryWhat(t) }));

  // 分两档挑：先名词类，再物品类 —— 同一档内按原顺序取第一个有 what 的
  const NOUN_KINDS = ['kill', 'dimension', 'biome', 'structure', 'advancement', 'effect', 'fluid'];
  const ITEM_KINDS = ['item', 'stat', 'gamestage'];
  /** 这些类型就算有 what 也不能当名字：数字 / 命令 / 说明文字 */
  const NEVER = new Set(['checkmark', 'xp', 'xp_levels', 'command', 'toast', 'observation']);

  for (const kinds of [NOUN_KINDS, ITEM_KINDS]) {
    for (const t of list) {
      if (NEVER.has(t.type)) continue;
      if (!kinds.includes(t.type)) continue;
      // 必须是个像 ID 的东西：带冒号。`command` 那种整串命令在这里会被挡掉，
      // 但为了保险再判一次长度 —— 名字栏塞不下 200 个字符。
      if (!t.what.includes(':')) continue;
      if (t.what.length > 120) continue;
      return { type: t.type, what: t.what };
    }
  }
  return null;
}

/**
 * 一个任务的「给人看的名字」。
 *
 * 2026-11-11 用户报障：「显示前置后置任务的时候用任务标题不要用编号」。
 * 实测真实包（ATM10Sky 3658 个任务 / 重度机械症 395 个）确实会冒出 16 位十六进制：
 * 因为一部分任务**游戏里本来就没标题**，`titleSource === 'id'`，`title` 就是那个 ID。
 *
 * 所以这里按「越像人话越优先」挑一个：
 *   1. lang 里的真标题
 *   2. 物品名当的标题（FTB 的常规做法，游戏里也这么显示）
 *   3. 副标题（这类说明性任务常常把想说的话写在这儿）
 *   4. 图标指的那个物品 / 资源 ID 的最后一段
 *   5. `untitledN`（2026-11-11 用户：「有些任务没标题是正常的，标记 untitled，
 *      按章节分每个章节都重置标记进度」—— 编号在 loadQuests 里按章节分配）
 *   6. 万一连编号都没有（老调用方直接构造的对象）→ 退回 ID
 *
 * 第 5 档是用户拍板的：这类任务在游戏里确实没有标题，是「正常」的，
 * 与其显示一串十六进制让人以为坏了，不如明说它没标题。
 *
 * @param {{title?: string, titleSource?: string, subtitle?: string, icon?: string, id?: string, untitledLabel?: string}} q
 * @returns {string}
 */
export function questDisplayName(q) {
  const id = String(q?.id ?? '');
  const title = String(q?.title ?? '');
  // 1 / 2：有真标题（lang 写的，或者拿物品名当的）直接用
  if (title && q?.titleSource !== 'id' && title !== id) return title;
  // 3：副标题
  const sub = String(q?.subtitle ?? '').trim();
  if (sub) return sub;
  // 4：条件线索（2026-11-12）——
  //    「击杀苦力怕」比 `untitled10` 有用得多。这里只放**原始 ID 的最后一段**
  //    （`minecraft:zombie` → `zombie`），因为这是纯函数、查不到中文名；
  //    宿主层的 `displayNameOf()` 会先用 `nameHintOf()` 把它换成中文名，
  //    只有拿不到实例（测试 / 离线）时才会看到这个英文尾巴。
  //    ★ 必须排在图标名前面：图标名是「这个任务长什么样」，
  //      条件线索才是「这个任务要干什么」，后者对人更有信息量。
  const hint = nameHintOf(q);
  if (hint) {
    const tail = hint.what.slice(hint.what.lastIndexOf(':') + 1);
    if (tail) return tail;
  }
  // 5：图标 —— 只取最后一段，`minecraft:creeper_spawn_egg` → `creeper_spawn_egg`
  const icon = String(q?.icon ?? '').trim();
  if (icon && icon.includes(':')) {
    const tail = icon.slice(icon.lastIndexOf(':') + 1);
    if (tail) return tail;
  }
  // 6：按章节编的 untitledN（loadQuests 已经算好挂上去了）
  const untitled = String(q?.untitledLabel ?? '').trim();
  if (untitled) return untitled;
  // 7：兜底
  return title || id;
}

/** 一个任务对象 → 汇总视图。 */
function buildQuest(raw, ctx) {
  const { chapterId, chapterFile, strings, fallback } = ctx;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const titleKey = `quest.${id}.${TEXT_KEYS.title}`;
  const subtitleKey = `quest.${id}.${TEXT_KEYS.subtitle}`;
  const descKey = `quest.${id}.${TEXT_KEYS.desc}`;

  const desc = textOf(strings, fallback, descKey, raw.description);
  const tasks = asArray(raw.tasks);
  const rewards = asArray(raw.rewards);
  // 描述原样保留成字符串数组（体检 / 搜索 / 写盘回读比对全都在用这个形状），
  // 旁边再给一份解析成块的结果供界面渲染图文混排。两件事分开，别互相顶掉。
  const descLines = Array.isArray(desc) ? desc.map(String) : desc === undefined ? [] : [String(desc)];

  // 标题优先级：lang 里的键 > 文件里内联的 title: > 第一个物品任务的物品名 > ID
  //
  // 这第三种情况是 FTB 的常规做法，不是缺失：实测这套 396 个任务里 355 个都没有
  // 显式标题，游戏里直接显示「要交的那个物品」的名字。所以缺标题本身不是问题，
  // 只有「既没标题又没有物品可显示」才是问题。
  const explicit = textOf(strings, fallback, titleKey, raw.title);
  const firstItemId = tasks
    .map((t) => (t?.type === 'item' ? t?.item?.id : null))
    .find((v) => typeof v === 'string' && v);
  const titleSource = explicit !== undefined ? 'lang' : firstItemId ? 'item' : 'id';
  const rawTitle = explicit !== undefined
    ? String(explicit)
    : firstItemId ? String(firstItemId) : id;
  // 显示用的标题：去掉 &6&l 这类颜色 / 格式码（2026-11-11「任务名字有很多乱码」）。
  // ★ 但 titleSource 判断、titleItem、rawTitle 都基于**没清洗的那份** ——
  //   物品 ID 里不可能有颜色码，清洗它反而有风险（比如物品 ID 恰好含 `&`）。
  const title = titleSource === 'item' ? rawTitle : stripMcFormatting(rawTitle);

  return {
    id,
    chapterId,
    chapterFile,
    title,
    /** 文件里那个原样的标题（没清洗颜色码）。改名表单预填、写盘比对要用它。 */
    rawTitle,
    /**
     * 标题切成带样式的片段（2026-11-11 用户：「把颜色的显示也做出来吧，
     * 这样游戏里和这里看的效果一样」）。界面按这个渲染就能显示出 `&6` 的橙色。
     * 物品 ID 当标题时不做解析（ID 里不可能有格式码）。
     */
    titleSpans: titleSource === 'item' ? [{ text: title, color: '', bold: false, italic: false, underline: false, strike: false }] : parseMcFormatting(rawTitle),
    titleSource,
    /** 游戏里会拿这个物品的名字当标题 */
    titleItem: titleSource === 'item' ? firstItemId : '',
    /**
     * 这个任务在画布上显示的那个物品（FTB 的 icon 字段）。
     *
     * 没写 icon 的任务，FTB 会退化成「第一个物品任务的那个物品」——
     * 这里跟它保持一致，界面上要画图标时直接取这个值，不用自己再判一遍。
     */
    icon: typeof raw.icon?.id === 'string' ? raw.icon.id : firstItemId ?? '',
    subtitle: stripMcFormatting(String(textOf(strings, fallback, subtitleKey, raw.subtitle ?? ''))),
    /** 副标题原样值（没清洗颜色码），需要精确值的地方用 */
    rawSubtitle: String(textOf(strings, fallback, subtitleKey, raw.subtitle ?? '')),
    /** 副标题的带样式片段（同 titleSpans，界面按它渲染颜色） */
    subtitleSpans: parseMcFormatting(String(textOf(strings, fallback, subtitleKey, raw.subtitle ?? ''))),
    description: descLines,
    /**
     * 描述解析成「块数组的数组」（一行一层，每行是文字块/图片块）。
     *
     * 为什么另给一份而不是把 description 改掉：`description` 是纯字符串数组，
     * 体检（lintQuests）、搜索（findQuests）、MCP 工具、写盘后回读比对全都在用
     * 那个形状，改了会全线崩。界面渲染图文混排时读这个字段。
     * 解析规则见 `packages/core/quest-desc.js`（目前只认 `{image:…}`，
     * `{@pagebreak}` / `&色` / `{变量}` 等仍原样留在文字块里）。
     */
    descriptionBlocks: parseDescLines(descLines),
    /**
     * 描述按 `{@pagebreak}` 分好页（2026-11-11 用户：「很多任务需要翻页查看」）。
     * 每页是块数组；`descriptionPages.length > 1` 就说明这任务在游戏里能翻页。
     */
    descriptionPages: parseDescPages(descLines),
    x: Number(raw.x ?? 0),
    y: Number(raw.y ?? 0),
    /** 自己写的形状（空 = 用章节 / 全局默认）。FTB 的形状名单见 QUEST_SHAPES。 */
    shape: raw.shape ?? '',
    /**
     * 自己写的大小倍率。**0 或没写 = 跟随章节**（FTB 里就是这个语义）。
     *
     * ★ 2026-11-13 修：以前这里是 `Number(raw.size ?? 1)`，把「没写」读成 1 ——
     *   于是界面分不清「用户明确写了 1 倍」和「根本没写、跟着章走」，
     *   「默认值不写进文件」这条原则也没法落地（写回时会把 1 当成用户设置写出去）。
     *   现在如实反映文件：没写就是 0。要「真正生效的值」用下面的 `sizeEffective`。
     */
    size: Number(raw.size ?? 0) || 0,
    /**
     * 真正生效的形状（2026-11-03「任务书成品预览」要按它渲染节点）。
     *
     * FTB 的优先级：任务自己写的 → 章节的 default_quest_shape →
     * 全局的 data.snbt 里 default_quest_shape → circle。
     * 少了这一层，界面画出来的东西跟游戏里不是一回事。
     */
    shapeEffective: String(raw.shape ?? '') || String(ctx.defaultShape ?? '') || 'circle',
    /** 真正生效的大小倍率：自己写的 → 章节 default_quest_size → 1。 */
    sizeEffective: (() => {
      const own = Number(raw.size ?? 0);
      if (own > 0) return own;
      const def = Number(ctx.defaultSize ?? 0);
      return def > 0 ? def : 1;
    })(),
    dependencies: asArray(raw.dependencies).map(String),
    /**
     * 依赖的**满足方式**（2026-11-12 第二批）。
     *
     * FTB 有四种（`DependencyRequirement.java`）：
     *   all_completed（默认）＝ 前置全做完
     *   one_completed        ＝ 前置里任意一个做完
     *   all_started          ＝ 前置全**开始**（不要求做完）
     *   one_started          ＝ 前置里任意一个开始
     * 不认识的写法一律退回默认 —— 游戏那边 NAME_MAP 查不到也是回默认，跟它一致。
     */
    dependencyRequirement: normalizeRequirement(raw.dependency_requirement),
    /**
     * 「至少 N 个前置满足就算过」（`min_required_dependencies`）。
     * 0 表示没用这个功能（游戏里 >0 才写盘）。
     * ★ 优先级最高：Quest.checkDependencies() 里 `minRequiredDependencies > 0` 走第一条分支，
     *   连 `dependency_requirement` 都不看。
     */
    minRequiredDependencies: Math.max(0, Math.floor(Number(raw.min_required_dependencies ?? 0) || 0)),
    /**
     * 三个会改变玩家实际体验的开关（2026-11-12 第五批）。
     *
     * 源码 `Quest.java` 的读写：
     *   - `optional`（:287-289，写 true 才写）＝ **可选任务**：不做也能往下走。
     *     真包实测 ATM10Sky 有 **633 处**，Mechanomania 1 处 —— 这是量最大的一个。
     *   - `invisible`（:297-299）＝ 对玩家**完全不可见**（不是「隐藏前置」那种藏）。
     *     真包实测 ATM10Sky **51 处**。
     *   - `can_repeat`（:295，Tristate 三态）＝ 可重复做。
     *     ★ 三态写法：`true` / `false` / 不写（= 跟随章节的 `default_repeatable`）。
     *     所以这里**不能归成布尔** —— 要把「没写」和「写了 false」区分开，
     *     否则读一遍再写回去会把「跟随章节」变成「明确不可重复」。
     */
    optional: raw.optional === true,
    invisible: raw.invisible === true,
    canRepeat: readTristate(raw.can_repeat),
    tasks,
    rewards,
    taskSummary: tasks.map((t) => ({
      type: String(t?.type ?? '?'),
      // 任务条件里最有用的是「要什么」：item 的 id、kill 的 entity、advancement 的名字
      what: entryWhat(t),
      count: entryCount(t),
    })),
    raw,
  };
}

/**
 * 读一整套任务书。
 * @param {string} questDir
 * @param {{locale?: string}} [opts]
 */
export function loadQuests(questDir, opts = {}) {
  const chaptersDir = path.join(questDir, 'chapters');
  if (!fs.existsSync(chaptersDir)) {
    throw new McError(`没有 chapters 目录：${chaptersDir}`, '这个目录下不是一套 FTB Quests 任务书', 'QuestNoChapters');
  }

  const langDir = path.join(questDir, 'lang');
  const locales = fs.existsSync(langDir)
    ? fs.readdirSync(langDir).filter((n) => n.endsWith('.snbt')).map((n) => n.slice(0, -5)).filter((n) => LOCALE_RE.test(n)).sort()
    : [];
  const available = locales.length ? locales : [DEFAULT_LOCALE];
  const wanted = opts.locale && locales.includes(opts.locale) ? opts.locale : (locales.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : available[0]);

  const readLang = (locale) => {
    const src = readIf(path.join(langDir, `${locale}.snbt`));
    if (src === null) return {};
    return parseSnbt(src, `lang/${locale}.snbt`);
  };
  const strings = readLang(wanted);
  const fallback = wanted === DEFAULT_LOCALE ? strings : readLang(DEFAULT_LOCALE);

  const defaults = readIf(path.join(questDir, 'data.snbt'));
  const data = defaults === null ? {} : parseSnbt(defaults, 'data.snbt');
  // 全局默认形状（2026-11-03「任务书成品预览」）：真实包的 data.snbt 里写着
  // default_quest_shape: "circle"，章节自己写空就继承它。
  const globalShape = String(data.default_quest_shape ?? '');
  const globalSize = Number(data.default_quest_size ?? 0);

  const chapterFiles = fs.readdirSync(chaptersDir).filter((n) => n.endsWith('.snbt')).sort();
  const chapters = [];
  const questsById = new Map();

  for (const file of chapterFiles) {
    const full = path.join(chaptersDir, file);
    const source = fs.readFileSync(full, 'utf8');
    const raw = parseSnbt(source, `chapters/${file}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new McError(`chapters/${file} 不是合法的章节文件`, '根节点必须是 compound（大括号）', 'QuestBadChapter');
    }
    const id = typeof raw.id === 'string' ? raw.id : file.replace(/\.snbt$/, '');
    const chapter = {
      id,
      file,
      path: full,
      group: typeof raw.group === 'string' ? raw.group : '',
      title: stripMcFormatting(String(textOf(strings, fallback, `chapter.${id}.title`, raw.title ?? id))),
      /** 章节名的带样式片段（左栏 / 页签按它渲染颜色） */
      titleSpans: parseMcFormatting(String(textOf(strings, fallback, `chapter.${id}.title`, raw.title ?? id))),
      subtitle: stripMcFormatting(String(textOf(strings, fallback, `chapter.${id}.chapter_subtitle`, raw.subtitle ?? ''))),
      icon: raw.icon?.id ?? '',
      // 章节自己的默认形状 / 默认大小（FTB 写的是 default_quest_shape / default_quest_size）。
      // 章节写空字符串就继承全局（data.snbt 里的 default_quest_shape）。
      defaultQuestShape: String(raw.default_quest_shape ?? ''),
      defaultQuestSize: Number(raw.default_quest_size ?? 0) || 0,
      // 章节画布上的背景图 / 装饰图（2026-11-02 用户问「怎么扫不出背景」）：
      // FTB Quests 的 images: [{image: "ns:path", x, y, width, height, rotation, corner}]，
      // 坐标单位跟任务格子一致；x/y 是图片「正中心」（2026-11-11 对照官方 QuestPanel
      // 源码定案），corner=alignToCorner 决定旋转支点。缺省字段给 0，宽高为 0 的直接丢。
      // corner 只透传、不进过滤条件：quest-image-edit.js 是字段级改写，不认识的键会
      // 原样留在文件里，动了过滤规则反而会让「界面第 N 张」和「文件第 N 个」对不上。
      images: asArray(raw.images)
        .map((im) => ({
          image: String(im?.image ?? ''),
          x: Number(im?.x ?? 0) || 0,
          y: Number(im?.y ?? 0) || 0,
          width: Number(im?.width ?? 0) || 0,
          height: Number(im?.height ?? 0) || 0,
          rotation: Number(im?.rotation ?? 0) || 0,
          corner: Boolean(im?.corner),
        }))
        .filter((im) => im.image && im.width > 0 && im.height > 0),
      quests: [],
      raw,
      source,
    };
    // 每个章节都从 untitled1 重新开始数（见下面循环里的注释）
    let untitledSeq = 0;
    for (const qRaw of asArray(raw.quests)) {
      const quest = buildQuest(qRaw, {
        chapterId: id,
        chapterFile: file,
        strings,
        fallback,
        // 形状 / 大小的继承链：任务自己 → 章节 → 全局 → circle / 1
        defaultShape: chapter.defaultQuestShape || globalShape,
        defaultSize: chapter.defaultQuestSize || globalSize,
      });
      if (!quest.id) continue;
      // 没名字的任务按章节编号（2026-11-11 用户：「有些任务没标题是正常的，标记 untitled，
      // 按章节分每个章节都重置标记进度，比如 untitled1、untitled2」）。
      //
      // ★ 计数器在**每章开头重置**，所以每个章节都有自己的 untitled1。
      //   为什么不全局连着编：用户明确要「按章节分」，而且 52 章连着编到 untitled78
      //   之后，光看名字根本不知道是哪个章节的。
      // ★ 编号按**文件里的任务顺序**发（`asArray(raw.quests)` 的次序），
      //   不是按坐标也不是按 ID 排序 —— 作者写任务的顺序最接近他的思路，
      //   而且这个顺序是稳定的（同一个包反复读编号不变）。
      if (!hasOwnName(quest)) {
        untitledSeq += 1;
        quest.untitledLabel = `untitled${untitledSeq}`;
      }
      chapter.quests.push(quest);
      if (!questsById.has(quest.id)) questsById.set(quest.id, quest);
    }
    chapters.push(chapter);
  }

  const groupsSrc = readIf(path.join(questDir, 'chapter_groups.snbt'));
  const groupsRaw = groupsSrc === null ? null : parseSnbt(groupsSrc, 'chapter_groups.snbt');
  const groupList = Array.isArray(groupsRaw) ? groupsRaw : asArray(groupsRaw?.chapter_groups);
  const chapterGroups = groupList
    .filter((g) => g && typeof g === 'object' && typeof g.id === 'string')
    .map((g) => ({
      id: g.id,
      title: stripMcFormatting(String(textOf(strings, fallback, `chapter_group.${g.id}.title`, g.title ?? g.id))),
    }));

  const quests = chapters.flatMap((c) => c.quests);

  return {
    questDir,
    locale: wanted,
    locales: available,
    chapters,
    chapterGroups,
    quests,
    questsById,
    data,
    /** 所有被任务引用的依赖 ID 是否都真的存在（悬空依赖会导致游戏里任务永远锁着） */
    danglingDependencies: (() => {
      const out = [];
      for (const q of quests) {
        for (const dep of q.dependencies) {
          if (!questsById.has(dep)) out.push({ questId: q.id, questTitle: q.title, chapterId: q.chapterId, missing: dep });
        }
      }
      return out;
    })(),
    /** 重复的任务 ID（FTB 会只认第一个，其余静默失效） */
    duplicateQuestIds: (() => {
      const seen = new Map();
      const dup = [];
      for (const q of quests) {
        if (seen.has(q.id)) dup.push(q.id);
        else seen.set(q.id, true);
      }
      return dup;
    })(),
  };
}

/** 摘要：给「先看一眼有什么」用。 */
export function describeQuests(store) {
  const lines = [];
  lines.push(`任务书：${store.quests.length} 个任务，分 ${store.chapters.length} 个章节（语言 ${store.locale}，可选 ${store.locales.join('/')}）`);
  if (store.chapterGroups.length) {
    lines.push(`分组：${store.chapterGroups.map((g) => g.title).join('、')}`);
  }
  lines.push('');
  for (const chapter of store.chapters) {
    const group = store.chapterGroups.find((g) => g.id === chapter.group);
    lines.push(`· ${chapter.title}${group ? `（${group.title}）` : ''} —— ${chapter.quests.length} 个任务`);
  }
  if (store.duplicateQuestIds.length) {
    lines.push('');
    lines.push(`⚠️ 有 ${store.duplicateQuestIds.length} 个任务 ID 重复：${store.duplicateQuestIds.slice(0, 5).join('、')}`);
  }
  if (store.danglingDependencies.length) {
    lines.push(`⚠️ 有 ${store.danglingDependencies.length} 处依赖指向不存在的任务（游戏里会永远锁住）`);
  }
  return lines;
}

/** 搜索任务：按标题/描述/物品 ID 找。 */
export function findQuests(store, keyword, limit = 20) {
  const kw = String(keyword ?? '').trim().toLowerCase();
  if (!kw) return [];
  const hits = [];
  for (const q of store.quests) {
    const hay = [
      q.title, q.subtitle, q.description.join(' '), q.id,
      ...q.taskSummary.map((t) => t.what),
    ].join(' ').toLowerCase();
    if (!hay.includes(kw)) continue;
    hits.push({
      id: q.id,
      title: q.title,
      chapterTitle: store.chapters.find((c) => c.id === q.chapterId)?.title ?? q.chapterId,
      taskCount: q.tasks.length,
      matches: q.taskSummary.filter((t) => t.what.toLowerCase().includes(kw)).length,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * 找出某个任务的上游（它依赖谁）和下游（谁依赖它）。
 * 改任务链的时候这个最有用：删掉一个任务前先看谁会被卡住。
 */
export function relateQuest(store, questId) {
  const quest = store.questsById.get(questId);
  if (!quest) return null;
  const dependants = store.quests.filter((q) => q.dependencies.includes(questId));
  return {
    quest,
    upstream: quest.dependencies.map((id) => ({
      id,
      title: store.questsById.get(id)?.title ?? '（不存在的任务）',
    })),
    downstream: dependants.map((q) => ({ id: q.id, title: q.title })),
  };
}


/**
 * 改任务文字（标题/副标题/描述）。只改 lang 文件，不碰章节文件。
 *
 * 返回新的文件内容，交给调用方决定要不要落盘。
 */
export function patchQuestText(source, questId, fields, label = 'lang.snbt') {
  const root = parseSpans(source, label);
  if (root.kind !== 'compound') throw new McError(`${label} 的根不是 compound`, '', 'QuestBadLang');
  const edits = [];
  const additions = [];
  for (const field of ['title', 'subtitle', 'desc']) {
    if (!Object.hasOwn(fields, field)) continue;
    const key = `quest.${questId}.${TEXT_KEYS[field]}`;
    const existing = root.entries.get(key)?.node;
    const next = field === 'desc' && Array.isArray(fields[field]) ? fields[field] : fields[field];
    if (existing && JSON.stringify(existing.value) === JSON.stringify(next)) continue;
    if (existing) edits.push({ start: existing.start, end: existing.end, text: formatLiteral(next) });
    else additions.push([key, next]);
  }
  if (Object.hasOwn(fields, 'chapterTitle')) {
    const key = `chapter.${questId}.title`;
    const existing = root.entries.get(key)?.node;
    if (!existing || JSON.stringify(existing.value) !== JSON.stringify(fields.chapterTitle)) {
      if (existing) edits.push({ start: existing.start, end: existing.end, text: formatLiteral(fields.chapterTitle) });
      else additions.push([key, fields.chapterTitle]);
    }
  }
  if (additions.length) {
    const edit = insertionEdit(source, root, additions);
    edits.push({ start: edit.start, end: edit.end, text: edit.text });
  }
  if (!edits.length) return { changed: false, source };
  const out = applyEdits(source, edits);
  parseSnbt(out, `${label}(校验)`); // 改完必须还能解析，否则宁可不写
  return { changed: true, source: out };
}

/**
 * 新 ID：FTB 用的是 16 位大写十六进制。
 * 不用随机数库，直接取 crypto 的随机字节转十六进制。
 */
export function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/**
 * `addQuest()` 里已经单独处理过的字段 —— 默认值那一轮里要跳过，
 * 免得同一份数据被写两遍（一遍原样、一遍归一化后的）。
 */
const SKIP_IN_ADD = new Set(['id', 'x', 'y', 'dependencies', 'tasks', 'rewards', 'icon']);

/**
 * 在章节文件里插入一个任务。
 *
 * ## 原则 1：等于默认值的键不写（2026-11-13）
 *
 * 用户拍板照搬 Visual Studio 三条原则中的第一条 —— 值等于默认值就不写进文件。
 * 那套规矩和 FTB 自己的写盘规则**是同一套**（`Quest.java` 每个字段都是「非默认才写」），
 * 所以我们不是发明规矩，是把早就散在各处的判断集中到 `quest-defaults.js`。
 *
 * 具体哪些字段有默认值、默认值是多少，全在 `packages/core/quest-defaults.js`；
 * 这里只负责「收集调用方给的字段 → 交给 pickWritable 过滤 → 落进 snbt」。
 */
export function addQuest(source, quest, label = 'chapter.snbt') {
  const root = parseSpans(source, label);
  const questsNode = root.entries.get('quests')?.node;
  if (!questsNode) throw new McError(`${label} 里没有 quests 列表`, '', 'QuestNoList');
  if (questsNode.kind !== 'list') throw new McError(`${label} 的 quests 不是列表`, '', 'QuestBadList');

  // id 和坐标无条件写：坐标没有「默认值」概念（不写就落在 0,0），
  // id 更是必须的（不写游戏读不出来）。其余字段全部过一遍默认值判定。
  const payload = { id: quest.id };

  // 列表型：空表就等于「没配」，不写（这是最早就在用的规矩）
  if (quest.dependencies?.length) payload.dependencies = quest.dependencies;
  if (quest.tasks?.length) payload.tasks = quest.tasks;
  if (quest.rewards?.length) payload.rewards = quest.rewards;

  payload.x = quest.x ?? 0;
  payload.y = quest.y ?? 0;

  // 图标：调用方约定传字符串 ID，这里包成 FTB 认的 `{ id: ... }`
  if (quest.icon && typeof quest.icon === 'string') payload.icon = { id: quest.icon };

  // 其余任务级字段（shape / size / optional / invisible / can_repeat …）
  // 逐个过默认值判定。`QUEST_FIELDS` 里没有登记的键（将来新加的字段、
  // 或者调用方自定义的键）会原样保留 —— 宁可多写一个游戏忽略的键，
  // 也不要悄悄吞掉数据。
  for (const [key, value] of Object.entries(pickWritable(quest))) {
    // 已经在上面处理过的、以及不是 snbt 字段的内部键，跳过
    if (SKIP_IN_ADD.has(key)) continue;
    const normalized = normalizeForWrite(key, value);
    if (normalized === undefined) continue;
    payload[key] = normalized;
  }

  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const block = formatBlock(payload).replace(/\n/g, nl);

  // 插到列表末尾。注意要沿用已有元素的行首缩进。
  let at;
  let text;
  if (questsNode.items.length === 0) {
    at = questsNode.end - 1;
    text = `${nl}\t\t${block.split(nl).join(`${nl}\t\t`)}${nl}\t`;
  } else {
    const last = questsNode.items[questsNode.items.length - 1];
    at = last.end;
    const lineStart = source.lastIndexOf('\n', last.start - 1) + 1;
    const indent = source.slice(lineStart, last.start);
    text = `${nl}${indent}${block.split(nl).join(`${nl}${indent}`)}`;
  }
  const out = applyEdits(source, [{ start: at, end: at, text }]);
  parseSnbt(out, `${label}(校验)`);
  return out;
}

/**
 * 生成一个新章节文件的完整文本。
 * 章节文件的基本骨架照抄真实文件（`default_quest_shape` / `filename` / `quest_links` 这些
 * FTB 自己会补，但缺了也能读，写上更贴近原样）。
 */
export function buildChapterFile({ id, filename, group, title, icon, orderIndex = 0, quests = [] }) {
  const body = {
    default_hide_dependency_lines: false,
    default_quest_shape: '',
    filename,
    id,
    order_index: orderIndex,
    quest_links: [],
    quests,
  };
  if (group) body.group = group;
  if (icon) body.icon = { id: icon };
  const nl = '\n';
  return formatBlock(body).replace(/\n/g, nl) + nl;
}

/**
 * 算出「把 compound 里某个键整段删掉」的编辑区间。
 *
 * 两种情况差别很大，必须分开处理（这是本函数唯一容易出错的地方）：
 *
 * 1. **键独占一行**（FTB 手工写出来的文件几乎全是这种）：
 *    ```
 *    \t\t\tshape: "gear"
 *    \t\t\tsize: 2.0d
 *    ```
 *    ⇒ 从「这一行的行首」删到「值结束那一行的行尾 + 换行」，整行消失。
 *    不能像删列表元素那样只收逗号（对象里的键之间根本没有逗号，靠换行分隔）。
 *
 * 2. **挤在一行里**（`{ shape: "gear", x: 1 }`）：
 *    ⇒ 删 `key: value`，再吃掉它后面那个逗号；没有后逗号就吃前面那个。
 *
 * @returns {{start:number,end:number,text:string}|null} 找不到这个键就返回 null
 */
function deletionEdit(source, compoundNode, key) {
  const entry = compoundNode.entries.get(key);
  if (!entry) return null;
  const { key: keyTok, node } = entry;

  const lineStart = source.lastIndexOf('\n', keyTok.start - 1) + 1;
  const prefix = source.slice(lineStart, keyTok.start);
  const onOwnLine = /^[\t ]*$/.test(prefix);

  if (onOwnLine) {
    // 值的收尾必须也在同一行的行尾（或它自己那行的行尾），后面只剩空白 / 逗号，
    // 才敢整行删 —— 否则说明这一行还有别的内容，退回去走「内联」那一支。
    const nlAt = source.indexOf('\n', node.end);
    const lineEnd = nlAt === -1 ? source.length : nlAt;
    const tail = source.slice(node.end, lineEnd);
    if (/^[\t ]*,?[\t ]*$/.test(tail)) {
      const end = nlAt === -1 ? source.length : nlAt + 1; // 连换行一起删
      return { start: lineStart, end, text: '' };
    }
  }

  // 内联写法：删 key: value，再吃掉一个逗号
  let start = keyTok.start;
  let end = node.end;
  const after = /^[\t ]*,/.exec(source.slice(end));
  if (after) {
    end += after[0].length; // 后面有逗号，连它一起删
  } else {
    const before = /,[\t ]*$/.exec(source.slice(0, start));
    if (before) start -= before[0].length; // 没有后逗号，就吃前面那个
  }
  return { start, end, text: '' };
}

/**
 * 改任务在章节文件里的字段（坐标、形状、依赖等）。
 *
 * ## 默认值语义（2026-11-13，照搬 VS 原则 1）
 *
 * `fields` 里每个值的含义分三种，**别混**：
 *
 * | 传什么 | 结果 |
 * |---|---|
 * | `undefined` | **完全不碰**这个键（调用方没提） |
 * | 等于该字段默认值（`null` 也算） | **把这个键从文件里删掉** |
 * | 其它值 | 写入 / 替换成这个值 |
 *
 * 「等于默认就删键」是这一轮新增的能力：以前只会「改值」，
 * 用户把 `optional` 从 true 改回 false 时会写出 `optional: false` ——
 * 而游戏自己的规矩是「false 根本不写」。两边不一致，文件就会越改越脏。
 *
 * ★ 不认识的键（`x` / `y` / `tasks` / 将来新加的）**永远按「写入」处理**，
 *   不会被当成默认值删掉 —— 判断依据只有 `quest-defaults.js` 那张表。
 */
export function patchQuestFields(source, questId, fields, label = 'chapter.snbt') {
  const root = parseSpans(source, label);
  const questsNode = root.entries.get('quests')?.node;
  if (questsNode?.kind !== 'list') throw new McError(`${label} 的 quests 不是列表`, '', 'QuestBadList');
  const target = questsNode.items.find((n) => n.kind === 'compound' && n.entries.get('id')?.node.value === questId);
  if (!target) throw new McError(`在 ${label} 里找不到任务 ${questId}`, '', 'QuestNotFound');

  const edits = [];
  const additions = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const existing = target.entries.get(key)?.node;

    // 等于默认值 ⇒ 该键不该存在。已经不存在就什么都不做。
    if (isDefault(key, value)) {
      if (!existing) continue;
      const del = deletionEdit(source, target, key);
      if (del) edits.push(del);
      continue;
    }

    if (existing && JSON.stringify(existing.value) === JSON.stringify(value)) continue;
    if (existing) {
      // 替换时沿用原写法（`-1.5d` 改完还是带 d 的小数），diff 只体现数字变化
      const original = source.slice(existing.start, existing.end);
      edits.push({ start: existing.start, end: existing.end, text: formatLike(original, value) });
    } else {
      additions.push([key, value]);
    }
  }
  if (additions.length) {
    const edit = insertionEdit(source, target, additions);
    edits.push({ start: edit.start, end: edit.end, text: edit.text });
  }
  if (!edits.length) return { changed: false, source };
  const out = applyEdits(source, edits);
  parseSnbt(out, `${label}(校验)`);
  return { changed: true, source: out };
}

/**
 * 把一组条件/奖励（tasks 或 rewards）按「一个友好 spec」重写成新数组。
 *
 * 多类型版：spec 里写明 type（item / kill / xp / …），按类型目录去构造条目。
 * 规矩（都是为了不悄悄弄坏用户配好的任务）：
 * - 只改「第一条同类型的条目」，沿用它的 id 和别的字段（换 id 会重置玩家已交的进度）；
 * - 同类型的有多条 → 只改第一条，其余原样留着并提醒一句；
 * - 这一组里没有同类型的条目 → 改第一条（等于换类型：原来配的经验变成物品）；
 * - 换类型时旧类型专属的字段不留（icon / tags 留着，那是用户自己配的）；
 * - 物品没填 ID ＝清空这一组（老规矩：界面里清空物品框就是不要这一组了）。
 *
 * @param {object} spec 友好 spec，类型见 quest-conditions.js
 * @param {'task'|'reward'} kind 条件还是奖励（两套类型目录不一样）
 */
export function rewriteEntries(entries, spec, kind, label) {
  const list = Array.isArray(entries) ? entries : [];
  const warnings = [];
  const type = String(spec?.type ?? 'item').trim() || 'item';
  const def = kind === 'reward' ? rewardDef(type) : taskDef(type);
  if (!def) {
    throw new McError(
      `${label}的类型「${type}」还不认识`,
      '换个支持的类型（物品 / 击杀 / 到达维度 / 攒经验 / 完成进度……），或者直接改文件。',
      'QuestUnsupportedCondition',
    );
  }

  // 物品没填 ID ＝清空这一组。上面已经确认类型合法，整组都能安全清掉。
  if (type === 'item' && !String(spec?.item ?? '').trim()) {
    return { entries: [], warnings };
  }
  const missing = requiredFields(kind, type).filter((key) => !String(spec?.[key] ?? '').trim());
  if (missing.length) {
    throw new McError(
      `${label}缺了必填的东西：${missing.join('、')}`,
      '把这一栏填上再改，或者换个类型。',
      'QuestMissingField',
    );
  }

  const same = list.filter((e) => e && String(e.type ?? 'item') === type);
  if (same.length > 1) {
    warnings.push(`${label}有 ${same.length} 条「${typeLabel(kind, type)}」，这里只改第一条，其余原样留着。`);
  }
  const index = list.findIndex((e) => e && String(e.type ?? 'item') === type);
  const old = index >= 0 ? list[index] : (list[0] ?? null);
  const built = buildEntry(kind, spec, old, newId);
  if (!built) {
    throw new McError(
      `${label}的类型「${type}」还不认识`,
      '换个支持的类型，或者直接改文件。',
      'QuestUnsupportedCondition',
    );
  }
  const out = [...list];
  if (index >= 0) out[index] = built;
  else if (out.length) out[0] = built; // 没有同类型条目 = 换类型：把第一条换掉
  else out.push(built);
  return { entries: out, warnings };
}

/** 把一组条件/奖励写成稳定的人话；预览和「写后复验」都用同一句，口径不会打架。 */
export function describeEntries(entries, kind = 'task') {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '（无）';
  return list
    .map((e) => {
      const summary = kind === 'reward' ? summarizeReward(e) : summarizeTask(e);
      return summary.label;
    })
    .join('、');
}

/**
 * 从一个章节文件里整块删掉某个任务（连它前后的逗号与缩进一起收拾干净）。
 *
 * 为什么要自己算区间：SNBT 的列表元素之间靠逗号分隔，而 parseSpans 只记每个元素自己的
 * start/end，没记「逗号在哪」（tokenize 里逗号是被跳过的）。所以删元素有两种情况：
 * - 后面还有兄弟元素：删到「下一个元素的起点」，这样它后面那个逗号跟着一起没了；
 * - 它是最后一个：从「上一个元素的终点」删到自己终点，把前面那个逗号带走。
 * 两种都删完必须还能被 parseSnbt 读出来，读不出来就抛错 —— 宁可这次不删，
 * 也不能把用户的章节文件写成半截。
 *
 * @returns {{changed: boolean, source: string, index: number}} index 是它原来的位置
 */
export function removeQuest(source, questId, label = 'chapter.snbt') {
  const id = String(questId ?? '').trim();
  if (!id) throw new McError('没给要删的任务 ID', '给 questId（16 位十六进制）', 'QuestNoId');

  const root = parseSpans(source, label);
  const questsNode = root.entries.get('quests')?.node;
  if (!questsNode || questsNode.kind !== 'list') {
    throw new McError(`${label} 的 quests 不是列表`, '这个文件可能不是 FTB 任务书的章节文件', 'QuestBadList');
  }

  const index = questsNode.items.findIndex(
    (n) => n.kind === 'compound' && n.entries.get('id')?.node.value === id,
  );
  if (index < 0) throw new McError(`在 ${label} 里找不到任务 ${id}`, '', 'QuestNotFound');

  const item = questsNode.items[index];
  const prev = index > 0 ? questsNode.items[index - 1] : null;
  const next = index + 1 < questsNode.items.length ? questsNode.items[index + 1] : null;

  let start;
  let end;
  if (next) {
    start = item.start;
    end = next.start;
  } else if (prev) {
    start = prev.end;
    end = item.end;
  } else {
    start = item.start;
    end = item.end;
  }

  // 末元素后面还挂了个逗号（手写文件里偶尔有）：连它一起删，不然留下 `{…}, ]` 这种脏东西
  if (!next) {
    const tail = source.slice(end, questsNode.end - 1);
    const comma = tail.indexOf(',');
    if (comma >= 0 && !tail.slice(0, comma).trim()) end += comma + 1;
  }

  const out = applyEdits(source, [{ start, end, text: '' }]);
  parseSnbt(out, `${label}(删任务校验)`);
  return { changed: true, source: out, index };
}

/**
 * 体检：找出会让游戏里任务书出问题的地方。
 * 每条都给出「哪里」和「为什么疼」。
 */
export function lintQuests(store) {
  const issues = [];
  // 第 5 个参数 `ref` 是「这条问题属于哪个任务 / 哪个章节」的机器可读定位
  // （形如 `{questId, chapterId}`），界面靠它实现「点这条跳到那个任务」。
  //
  // 为什么要单独一个字段而不是让界面去 `where` 里抠 ID：
  // `where` 是给人看的文案（「任务 The Storage（4E8A05C3BFA80540）」），
  // 里面同时有标题和 ID、还有个全角括号，用正则抠迟早会抠错。
  // 以前这里只有 4 个参数、没有 ref，所以界面上写了半天的跳转代码
  // （app.js 的 diagnosticsPanel）**一次都没生效过**。
  //
  // `ref` 必须可选：章节级 / 分组级的问题（比如「章节没有 id」）没有具体任务，
  // 硬塞一个 questId 会让界面跳到一个不存在的任务上。
  const push = (level, code, where, message, ref = null) =>
    issues.push({ level, code, where, message, ...(ref ?? {}) });

  for (const id of store.duplicateQuestIds) {
    // 重复 ID 能对上多个任务，跳哪一个都是碰运气 —— 所以只给 questId，
    // 章节等界面自己从任务反查（findNode 是全量扫的）。
    push('error', 'QuestDuplicateId', `任务 ${id}`,
      '同一个任务 ID 出现在多处，游戏只会认第一个，其余会静默消失', { questId: id });
  }
  for (const dep of store.danglingDependencies) {
    // 2026-11-11 查清：这类「依赖不存在」**不是 error，也不会锁死任务**。
    //
    // 两件实证：
    //   ① 实测 ATM10Sky 的 9 条全部指向**任务条件的 ID**（task id），不是任务 ID ——
    //      作者在 `dependencies` 里顺手抄了上面某个 `tasks:[{id:...}]` 的 ID。
    //   ② FTB 自己会清理：`Quest.class` 里有 `removeInvalidDependencies()`，
    //      `Quest$DependencyChecker.check0()` 里也有 `invalid` 分支。
    //      查不到的依赖会被直接删掉，任务照常能完成。
    //
    // 所以降到 warn，文案也说人话（以前写「游戏里会永远锁着」是危言耸听）。
    push('warn', 'QuestDanglingDependency', `任务 ${dep.questTitle}（${dep.questId}）`,
      `依赖的 ${dep.missing} 不是任务 ID（可能是任务条件 / 奖励的 ID），游戏会自动忽略这一条，任务照常能完成`,
      { questId: dep.questId, chapterId: dep.chapterId });
  }

  const taskIds = new Map();
  for (const q of store.quests) {
    // 这一章所有任务级问题的定位信息，循环里反复用
    const ref = { questId: q.id, chapterId: q.chapterId };
    // 没标题**不算问题**（2026-11-11 用户拍板：「有些任务没标题是正常的」）。
    // 以前这里推一条 info 级提示，实测 ATM10Sky 一次就刷出 110 条，把真正的
    // 问题（悬空依赖 9 条、缺字段 12 条）全盖住了 —— 没标题的任务在界面上
    // 现在统一显示成 `untitledN`（见 questDisplayName），已经有交代了，不用再报。
    if (!q.tasks.length && !q.rewards.length) {
      push('warn', 'QuestEmpty', `任务 ${q.title}（${q.id}）`, '既没有完成条件也没有奖励，玩家点了就过', ref);
    }
    // 「至少 N 个前置」写得比实际前置还多 → 永远凑不齐，任务永久锁死（2026-11-12 第二批）
    if (q.minRequiredDependencies > q.dependencies.length) {
      push('error', 'QuestMinDepsTooMany', `任务 ${q.title}（${q.id}）`,
        `设了「至少 ${q.minRequiredDependencies} 个前置满足」，但这个任务只写了 ${q.dependencies.length} 个前置 —— 永远凑不齐，游戏里会一直锁着`,
        ref);
    }
    for (const t of q.tasks) {
      if (t?.id) {
        if (taskIds.has(t.id)) {
          push('error', 'TaskDuplicateId', `任务 ${q.title}`, `任务条件的 ID ${t.id} 与「${taskIds.get(t.id)}」重复`, ref);
        } else taskIds.set(t.id, q.title);
      }
      if (t?.type === 'item' && !t?.item?.id) {
        push('error', 'ItemTaskNoItem', `任务 ${q.title}`, '物品类任务没有写要什么物品', ref);
      }
      // 别的类型（击杀、到维度……）也得检查必填项：漏了「生物 ID」，
      // 游戏里这条条件永远不成立，玩家会一直做不完。
      const taskMiss = missingFields('task', t);
      if (taskMiss.length && String(t?.type ?? '') !== 'item') {
        push('error', 'TaskMissingField', `任务 ${q.title}`, `任务条件缺了 ${taskMiss.join('、')}`, ref);
      }
    }
    for (const r of q.rewards) {
      const rewardMiss = missingFields('reward', r);
      if (rewardMiss.length) {
        // 2026-11-11 查清：这里是**数据残缺**，不是「任务坏了」，所以降到 warn。
        //
        // 实测 ATM10Sky 249 个 loot 奖励里 238 个有 table_id、11 个没有（作者漏写）；
        // 游戏里的表现是**这一次奖励拿空**，任务照样能完成、能领别的奖励。
        // 以前报 error 会让体检卡红成一片，把真问题淹掉。
        //
        // 注意：`table_id` 是**下划线**那个字段名（FTB 的 RandomReward 里就叫这个），
        // 不是 `tableId` —— 拿驼峰去读会一个都读不到，误判成全缺。
        push('warn', 'RewardMissingField', `任务 ${q.title}`, `奖励缺了 ${rewardMiss.join('、')}，游戏里这一项会拿空`, ref);
      }
    }
  }

  // 「没有描述」**不报**（2026-11-11 用户：「为什么现在还有任务在报错」时查出来的）。
  //
  // 以前的判据是「整章都没描述就提一句」，出发点是好的，但实测不成立：
  // ATM10Sky 3658 个任务里 **1341 个（36.7%）根本没有描述**，52 章里有 2 章整章
  // 都没写 —— 这不是作者忘了，是很多任务靠标题就说清了（交個物品、做个机器）。
  // 报出来只是噪音，把悬空依赖 / 缺字段这些真数据问题淹掉。
  //
  // 保留这段注释是为了下次别再把它加回来（判据看着合理，实测不成立）。

  const chapterIds = new Set(store.chapters.map((c) => c.id));
  for (const chapter of store.chapters) {
    // 章节级问题：有 id 就给 chapterId 让界面能跳过去；没 id 的那种
    // （ChapterNoId）本身就没有可跳的目标，只给空 ref。
    const ref = chapter.id ? { chapterId: chapter.id } : null;
    if (chapter.group && !store.chapterGroups.some((g) => g.id === chapter.group)) {
      push('warn', 'ChapterUnknownGroup', `章节 ${chapter.title}`, `归属的分组 ${chapter.group} 不存在，章节会掉到未分组里`, ref);
    }
    if (!chapter.quests.length) {
      push('warn', 'ChapterEmpty', `章节 ${chapter.title}`, '章节里没有任务', ref);
    }
    if (!chapterIds.has(chapter.id)) {
      push('error', 'ChapterNoId', `章节文件 ${chapter.file}`, '章节没有 id');
    }
  }

  // 同一坐标重叠会让节点在游戏里叠在一起看不见
  for (const chapter of store.chapters) {
    const byPos = new Map();
    const ref = chapter.id ? { chapterId: chapter.id } : null;
    for (const q of chapter.quests) {
      const key = `${q.x},${q.y}`;
      if (byPos.has(key)) {
        // 重叠涉及两个任务，跳后出现的那个（用户要找的是「这一格为什么叠了」，
        // 第一个已经被看不见的那个盖住了）—— 同时给 questId 和 chapterId。
        push('warn', 'QuestOverlap', `章节 ${chapter.title}`, `「${byPos.get(key)}」和「${q.title}」站在同一格 (${q.x}, ${q.y})，会互相遮挡`,
          q.id ? { questId: q.id, chapterId: chapter.id } : ref);
      } else byPos.set(key, q.title);
    }
  }

  return issues;
}

/**
 * 体检：章节背景图 / 装饰图有没有问题。
 *
 * 为什么要单开一个异步函数：`lintQuests` 是纯同步的（只看书面），
 * 而「这张图在包里到底存不存在」要去翻 jar 和资源目录，异步才做得了。
 *
 * 规则（都定成 warn 级，不定 error）：
 *   - `ImageNoId`     装饰图没写 image 字段
 *   - `ImageBadSize`  宽或高是 0 / 负数 → 游戏里画不出来
 *   - `ImageMissing`  图在包里找不到 → 游戏里那块就是空的
 *
 * 为什么不定 error：写盘流程（quest-create.js 的 newErrorsOf）会用
 * 「新出现的 error」当回滚信号，图缺失是作者本来的意图（还没放图进去），
 * 不该把用户的正常编辑挡回去。
 *
 * @param {object} store loadQuests 的结果
 * @param {object} [instance] resolveInstance 的结果；没有就只查书面上看得出的两条
 * @returns {Promise<{level, code, where, message}[]>}
 */
export async function lintQuestImages(store, instance = null) {
  const issues = [];
  // 和 lintQuests 一样：第 5 个参数是机器可读定位（`{questId, chapterId}`），
  // 可选。装饰图属于章节，所以这里只给 chapterId。
  const push = (level, code, where, message, ref = null) =>
    issues.push({ level, code, where, message, ...(ref ?? {}) });

  for (const chapter of store.chapters) {
    const raw = asArray(chapter.raw?.images);
    if (!raw.length) continue;
    const ref = chapter.id ? { chapterId: chapter.id } : null;
    // 这里必须用 for 循环而不是 forEach：里面的 await 在 forEach 回调里是非法的
    for (let i = 0; i < raw.length; i += 1) {
      const im = raw[i];
      const at = `章节 ${chapter.title} 装饰图 #${i + 1}`;
      const src = String(im?.image ?? '').trim();
      const width = Number(im?.width ?? 0) || 0;
      const height = Number(im?.height ?? 0) || 0;
      if (!src) {
        push('warn', 'ImageNoId', at, '没写 image（资源 ID），游戏里这块是空的', ref);
        continue;
      }
      if (width <= 0 || height <= 0) {
        push('warn', 'ImageBadSize', at, `宽高是 ${width}×${height}，游戏里画不出来（要大于 0）`, ref);
        continue;
      }
      if (!instance) continue;
      const hit = await checkQuestImageExists(instance, src);
      if (!hit.exists) {
        push('warn', 'ImageMissing', at, `图 ${src} 在包里找不到，游戏里这块会是空的`, ref);
      }
    }
  }
  return issues;
}

/** 把 lint 结果写成好读的几行。 */
export function describeLint(issues, limit = 40) {
  if (!issues.length) return ['体检通过：没发现会让任务书出问题的地方。'];
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.level] - order[b.level]);
  const errors = sorted.filter((i) => i.level === 'error');
  const warns = sorted.filter((i) => i.level === 'warn');
  const infos = sorted.filter((i) => i.level === 'info');
  const lines = [`体检：${errors.length} 个错误、${warns.length} 个警告、${infos.length} 个提示`];
  for (const issue of sorted.slice(0, limit)) {
    const tag = issue.level === 'error' ? '错误' : issue.level === 'warn' ? '警告' : '提示';
    lines.push(`  [${tag}] ${issue.where}：${issue.message}`);
  }
  if (sorted.length > limit) lines.push(`  …还有 ${sorted.length - limit} 条`);
  return lines;
}
