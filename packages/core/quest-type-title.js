/**
 * 任务条件在游戏里显示的标题（2026-11-12 第五批 B）。
 *
 * 为什么单独一个文件：这是**纯字符串拼装**，规则全部来自 FTB 源码里各
 * `getAltTitle()` 的实现，和取中文名（要读 jar / 索引）是两件事，
 * 拆开才能单测、也不会让 `lib/host/quest-api.js` 越写越乱。
 *
 * ★ 每一条都标了源码位置，改之前先去读原文核对，别只信这段转述。
 *
 * 一个重要的诚实边界：**中文语言包只覆盖了一半**。从真实包的
 * `ftb-quests-neoforge-2101.1.21.jar` 里读 `assets/ftbquests/lang/zh_cn.json` 实测：
 *   - `ftbquests.task.ftbquests.dimension` = **「访问维度」**（有）
 *   - `biome` / `structure` / `observation` / `kill.title` / `advancement` / `gamestage`
 *     **全是 undefined**（没有）
 * 游戏在这种情况下会**直接把原始键名显示出来**（`ftbquests.task.ftbquests.biome`）。
 * 我们当然不照抄那种丑相，而是自带一份中文兜底表 —— 但要知道
 * **这是我们的翻译，不是游戏里真会显示的字**。
 */

/** 深绿色（`ChatFormatting.DARK_GREEN`）＝ Minecraft 的 `§2`。 */
export const DARK_GREEN = '#00AA00';
/** 黄色（`ChatFormatting.YELLOW`）＝ Minecraft 的 `§e`。 */
export const YELLOW = '#FFFF55';

/**
 * 每种条件类型的前缀。
 *
 * | type | 前缀 | 颜色 | 源码 |
 * |---|---|---|---|
 * | dimension / biome / structure / observation | 见下 | DARK_GREEN | `*Task.java` 的 `getAltTitle()` |
 * | advancement | 进度 | YELLOW | `AdvancementTask.java:87` |
 * | kill | 杀死实体 | 无 | `KillTask.java:94`（模板 `Kill: %sx %s`） |
 * | item | 无（只有 `Nx ` 数量前缀） | 无 | `ItemTask.java:167` |
 * | gamestage | 游戏阶段 | YELLOW | `StageTask` |
 *
 * `zh` 是**我们自己**的中文兜底（见文件头那段说明），`en` 是 jar 里英文模板的真值。
 */
const TYPE_PREFIX = {
  dimension: { zh: '访问维度', en: 'Visit Dimension', color: DARK_GREEN },
  biome: { zh: '生物群系', en: 'Visit Biome', color: DARK_GREEN },
  structure: { zh: '结构', en: 'Find Structure', color: DARK_GREEN },
  observation: { zh: '观察', en: 'Observation', color: DARK_GREEN },
  advancement: { zh: '进度', en: 'Advancement', color: YELLOW },
  kill: { zh: '杀死实体', en: 'Kill Entity', color: '' },
  gamestage: { zh: '游戏阶段', en: 'Stage', color: YELLOW },
};

/**
 * 这些类型在游戏里是 `Component.literal(原始字符串)` —— **FTB 一个字都不翻译**。
 * 所以显示时要先把原始 ID 摆出来（和游戏一致），中文名只能当补充。
 */
const LITERAL_TYPES = new Set(['dimension', 'biome', 'structure', 'observation']);

/**
 * 拼一条要求的显示标题。
 *
 * @param {string} type 条件类型（item / kill / dimension / …）
 * @param {object} opts
 * @param {string} [opts.what]    原始 ID（`minecraft:the_nether` / `minecraft:zombie`）
 * @param {string} [opts.name]    查到的中文名（「下界」/「僵尸」），查不到给空串
 * @param {number} [opts.count]   数量（只对 item / kill 有意义）
 * @param {string} [opts.locale]  'zh'（默认）或 'en' —— 只影响**前缀**，不影响变量翻译
 * @returns {{text: string, color: string, parts: Array<{text: string, color: string}>}}
 *   `parts` 是带颜色的片段，界面照着渲染就能显示出游戏里那种「前缀白、变量绿」的效果。
 */
export function taskTypeTitle(type, opts = {}) {
  const kind = String(type ?? '').trim();
  const what = String(opts.what ?? '').trim();
  const name = String(opts.name ?? '').trim();
  const count = Number(opts.count ?? 1) || 1;
  const zh = String(opts.locale ?? 'zh') !== 'en';
  const meta = TYPE_PREFIX[kind];

  // ① 物品：游戏里只有 `Nx ` 前缀（`ItemTask.java:167`），count > 1 才有
  if (kind === 'item') {
    const shown = name || what;
    if (!shown) return { text: '（没填物品）', color: '', parts: [] };
    const text = count > 1 ? `${count}x ${shown}` : shown;
    return { text, color: '', parts: [] };
  }

  // ② 击杀：模板 `Kill: %sx %s`（`KillTask.java:94`），参数是「数量」和「生物名」
  if (kind === 'kill') {
    const shown = name || what;
    if (!shown) return { text: '（没填生物）', color: '', parts: [] };
    const prefix = meta ? meta[zh ? 'zh' : 'en'] : kind;
    const text = `${prefix}: ${count}x ${shown}`;
    return { text, color: '', parts: [] };
  }

  // ③ 维度 / 群系 / 结构 / 观察：`literal(原始 ID)` + DARK_GREEN。
  //    用户 2026-11-12 拍板：**原始 ID 在前、括号补中文名**。
  if (LITERAL_TYPES.has(kind)) {
    if (!what) return { text: '（没填）', color: '', parts: [] };
    const prefix = meta ? meta[zh ? 'zh' : 'en'] : kind;
    const color = meta?.color ?? '';
    // 中文名和 ID 一样时（查不到）就不重复括号
    const trailing = name && name !== what ? `（${name}）` : '';
    return {
      text: `${prefix}: ${what}${trailing}`,
      color,
      // 给界面用的分段：前缀白、变量上色 —— 和游戏里 `append(literal(..).withStyle(DARK_GREEN))` 一致
      parts: [
        { text: `${prefix}: `, color: '' },
        { text: `${what}${trailing}`, color },
      ],
    };
  }

  // ④ 进度：黄色（`AdvancementTask.java:87`）；拿不到进度真名时游戏退回类型名
  if (kind === 'advancement') {
    const prefix = meta ? meta[zh ? 'zh' : 'en'] : kind;
    const shown = name || what;
    if (!shown) return { text: prefix, color: '', parts: [] };
    return {
      text: `${prefix}: ${shown}`,
      color: YELLOW,
      parts: [
        { text: `${prefix}: `, color: '' },
        { text: shown, color: YELLOW },
      ],
    };
  }

  // ⑤ 游戏阶段：黄色；文本是原始 stage 字符串
  if (kind === 'gamestage') {
    const prefix = meta ? meta[zh ? 'zh' : 'en'] : kind;
    const shown = what || '（没填阶段）';
    return {
      text: `${prefix}: ${shown}`,
      color: YELLOW,
      parts: [
        { text: `${prefix}: `, color: '' },
        { text: shown, color: YELLOW },
      ],
    };
  }

  // ⑥ 其它（xp / stat / checkmark / fluid / location / custom）：
  //    游戏里就是类型名，没有 `变量: ` 这种结构。给了名字就用名字。
  const shown = name || what;
  const prefix = meta ? meta[zh ? 'zh' : 'en'] : kind;
  if (!shown) return { text: prefix, color: '', parts: [] };
  return {
    text: `${prefix}: ${shown}`,
    color: meta?.color ?? '',
    parts: meta?.color
      ? [{ text: `${prefix}: `, color: '' }, { text: shown, color: meta.color }]
      : [],
  };
}

/** 这个类型在游戏里是不是「显示原始 ID、不做翻译」的那几种。 */
export function isLiteralType(type) {
  return LITERAL_TYPES.has(String(type ?? '').trim());
}
