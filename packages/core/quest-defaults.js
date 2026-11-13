/**
 * 任务字段的「默认值」唯一真源 —— 照搬 Visual Studio 的第一条原则。
 *
 * ## 为什么要有这个文件
 *
 * 用户 2026-11-13 拍板：「默认值的形式照搬 Visual Studio」。
 * [微软官方文档](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-properties-overview) 的原话：
 *
 *   "Properties set on a control are serialized into the designer's code-behind file.
 *    This happens when the value of a property is **set to something other than its default value**."
 *
 * 也就是：**值等于默认值 ⇒ 这个键根本不写进文件**。
 *
 * ★ 关键发现：**这跟 FTB Quests 自己的写盘规则是同一套，不冲突。**
 *   实测 FTB 源码 `Quest.java` 每个字段的写盘分支都是「非默认才写」，
 *   `Chapter.java:162-164` 也是 `if (defaultQuestSize != 1D) { nbt.putDouble(...) }`。
 *   我们 `quest-conditions.js:497` 早就在用这个原则（`exclude_from_claim_all` 只有 true 才写）。
 *   所以这不是发明新规矩，是**把已经有的一条规矩系统化、集中到一处**。
 *
 * ## 三条原则里这个文件负责哪条
 *
 * | VS 原则 | 谁负责 |
 * |---|---|
 * | 1. 默认值不写进文件 | **本文件**（`pickWritable` / `shouldWrite`） |
 * | 2. 面板标出「哪些改过」 | 界面（引本文件的 `isDefault`，纯函数所以浏览器能加载） |
 * | 3. 一键 Reset 回默认 | 界面 + `patchQuestFields` 的「改回默认就删键」 |
 *
 * ## ★ 硬约束：本文件**不许引 `node:*`**
 *
 * 界面（`packages/ui/app.js`）要直接 import 它来判断「这个字段是不是默认值」。
 * 引了 `node:fs` 之类就重演 2026-11-12 的白屏事故（见 `test/ui-loadable.test.mjs`）。
 *
 * ## 字段真值来源
 *
 * 全部来自 FTB Quests 源码 `Quest.java:81-114`（构造函数里的初始值）+ 各字段的写盘分支。
 * 「写盘规则」那一列写的是**游戏自己怎么判**，我们照着抄，而不是自己发明。
 */

/**
 * 字段的类型。决定「什么算默认值」怎么判 —— 四种情况的判法完全不同，别混。
 *
 * - `bool`     —— 只有 true 才写。false 和「没写」在游戏里等价。
 * - `tristate` —— **三态**：true / false / 没写（= 跟随上级）。★ false **不**等于没写。
 * - `number`   —— 按各自的规则判（见 `write`）。
 * - `string`   —— 空串就是默认。
 * - `enum`     —— 等于那个默认枚举名就是默认。
 */
export const FIELD_KINDS = {
  BOOL: 'bool',
  TRISTATE: 'tristate',
  NUMBER: 'number',
  STRING: 'string',
  ENUM: 'enum',
};

/**
 * 每个字段的默认值与写盘规则。
 *
 * `write` 取值：
 * - `true-only`    —— 只有 true 才写（`bool` 专用）
 * - `non-null`     —— 只要不是「没写」就写（`tristate` 专用：false 也要写！）
 * - `positive`     —— > 0 才写
 * - `nonzero`      —— != 0 才写
 * - `nonempty`     —— 非空串才写
 * - `nondefault`   —— 不等于默认枚举值才写
 */
export const QUEST_FIELDS = {
  // —— 我们已经支持读写的 9 个字段 ——
  subtitle: {
    def: '', kind: FIELD_KINDS.STRING, write: 'nonempty',
    note: '副标题。空串不写。',
  },
  shape: {
    def: '', kind: FIELD_KINDS.STRING, write: 'nonempty',
    note: '节点形状。空 = 跟随章节 default_quest_shape。',
  },
  size: {
    // ★★ 这里曾经有个语义坑（2026-11-13 修）：
    //   FTB 的默认值是 **0D**（= 跟随章节），写盘条件是 `size != 0D`。
    //   我们旧代码写的是 `Number(size) !== 1` —— 把「1 倍」也当成默认跳过了。
    //   巧合的是结果碰巧对（size=1 不写、size=0 也不写），但**语义是错的**：
    //   游戏里「显式写 size: 1.0d」和「完全不写」是两回事
    //   （前者是「我就要 1 倍」，后者是「让章节决定」）。
    //   现在按 FTB 的 `!= 0` 重写。
    def: 0, kind: FIELD_KINDS.NUMBER, write: 'nonzero',
    note: '节点大小倍率。0 = 跟随章节 default_quest_size。',
  },
  min_required_dependencies: {
    def: 0, kind: FIELD_KINDS.NUMBER, write: 'positive',
    note: '「至少 N 个前置满足就算过」。0 = 没启用。',
  },
  dependency_requirement: {
    def: 'all_completed', kind: FIELD_KINDS.ENUM, write: 'nondefault',
    note: '前置的满足方式。默认 = 全部完成。',
  },
  optional: {
    def: false, kind: FIELD_KINDS.BOOL, write: 'true-only',
    note: '可选任务：不做也能往下走。真包 ATM10Sky 有 633 处。',
  },
  invisible: {
    def: false, kind: FIELD_KINDS.BOOL, write: 'true-only',
    note: '对玩家完全不可见。真包 ATM10Sky 有 51 处。',
  },
  can_repeat: {
    // ★ 三态：true / false / 不写（= 跟随章节 default_repeatable）
    def: null, kind: FIELD_KINDS.TRISTATE, write: 'non-null',
    note: '可重复做。三态，false 也**要**写 —— 那不是默认值，是「明确不可重复」。',
  },
  hide_dependent_lines: {
    def: false, kind: FIELD_KINDS.BOOL, write: 'true-only',
    note: '隐藏指向下游任务的连线。',
  },
  icon_scale: {
    def: 1, kind: FIELD_KINDS.NUMBER, write: 'nonzero',
    note: '图标缩放。FTB 默认 1d。',
  },
  min_width: {
    def: 0, kind: FIELD_KINDS.NUMBER, write: 'positive',
    note: '节点最小宽度。',
  },
  guide_page: {
    def: '', kind: FIELD_KINDS.STRING, write: 'nonempty',
    note: '关联的指导书页面。',
  },
  ignore_reward_blocking: {
    def: false, kind: FIELD_KINDS.BOOL, write: 'true-only',
    note: '忽略奖励阻塞。',
  },
  invisible_until_tasks: {
    def: 0, kind: FIELD_KINDS.NUMBER, write: 'positive',
    note: '完成 N 个条件前不可见。',
  },
  hide_dependency_lines: {
    def: null, kind: FIELD_KINDS.TRISTATE, write: 'non-null',
    note: '隐藏指向上游的连线。三态。',
  },
  hide_until_deps_visible: {
    def: null, kind: FIELD_KINDS.TRISTATE, write: 'non-null',
    note: '前置不可见时自己也藏着。三态。',
  },
  hide_until_deps_complete: {
    def: null, kind: FIELD_KINDS.TRISTATE, write: 'non-null',
    note: '前置没做完时自己也藏着。三态。',
  },
  hide_text_until_complete: {
    def: null, kind: FIELD_KINDS.TRISTATE, write: 'non-null',
    note: '做完之前不显示标题文字。三态。',
  },
  hide_details_until_startable: {
    def: null, kind: FIELD_KINDS.TRISTATE, write: 'non-null',
    note: '能开始之前不显示详情。三态。',
  },
  disable_jei: {
    def: null, kind: FIELD_KINDS.TRISTATE, write: 'non-null',
    note: '查看任务时禁用 JEI。三态。',
  },
  require_sequential_tasks: {
    def: null, kind: FIELD_KINDS.TRISTATE, write: 'non-null',
    note: '条件必须按顺序做。三态。',
  },
  progression_mode: {
    def: 'default', kind: FIELD_KINDS.ENUM, write: 'nondefault',
    note: '进度模式。',
  },
};

/** 字段名列表（界面遍历 / 测试用）。 */
export const QUEST_FIELD_KEYS = Object.keys(QUEST_FIELDS);

/**
 * 这个字段名认不认识。
 * 不认识的键**故意放行**（`isDefault` 返回 false、`pickWritable` 原样保留）——
 * 别因为一张表不全就把调用方的数据悄悄吞掉。
 */
export function knownField(key) {
  return Object.hasOwn(QUEST_FIELDS, key);
}

/** 某个字段的默认值。不认识的字段返回 `undefined`。 */
export function defaultOf(key) {
  const spec = QUEST_FIELDS[key];
  return spec ? spec.def : undefined;
}

/** 「没写」的统一判法。注意 `0` / `''` / `false` 都不算没写。 */
function isMissing(value) {
  return value === undefined || value === null;
}

/**
 * 这个值算不算「等于默认值」（= 不该写进文件）。
 *
 * ★ 三态字段最容易在这里出错：
 *   `can_repeat: false` **不是**默认值 —— 它是「明确不可重复」，游戏里必须写出来。
 *   只有「没写」（undefined / null）才是默认。这一条 2026-11-12 已经踩过一次。
 *
 * @param {string} key 字段名（snbt 里那个键，例如 `size`）
 * @param {*} value
 * @returns {boolean} true = 等于默认值 / 认不出的字段也返回 false
 */
export function isDefault(key, value) {
  const spec = QUEST_FIELDS[key];
  if (!spec) return false; // 不认识的字段：一律当作「要写」，原样保留

  if (spec.kind === FIELD_KINDS.TRISTATE) {
    // 只有「没写」才是默认；true 和 false 都是显式设置
    return isMissing(value);
  }
  if (spec.kind === FIELD_KINDS.BOOL) {
    // false 和没写等价（游戏读的时候也这么判）
    return isMissing(value) || value === false;
  }
  if (isMissing(value)) return true;

  if (spec.kind === FIELD_KINDS.NUMBER) {
    const n = Number(value);
    if (!Number.isFinite(n)) return true; // 不是数字，别写进去
    return n === Number(spec.def);
  }
  if (spec.kind === FIELD_KINDS.ENUM) {
    return String(value) === String(spec.def);
  }
  // STRING
  return String(value) === String(spec.def);
}

/**
 * 这个键现在该不该写进文件。
 *
 * 和 `isDefault` 的关系：`shouldWrite = !isDefault`，但**多一层**「值本身是不是空」的判断
 * （例如 `size: 'abc'` 这种非数字，`isDefault` 当默认、`shouldWrite` 也当不写）。
 */
export function shouldWrite(key, value) {
  return !isDefault(key, value);
}

/**
 * 从一份「字段 → 值」里剔掉所有等于默认值的键。
 *
 * 这是原则 1 的执行点：`addQuest()` 就用它决定往 snbt 里写哪几个键。
 *
 * ★ 不认识的键**原样保留**：宁可多写一个游戏会忽略的键，也不要悄悄丢掉调用方的数据。
 *
 * @param {Record<string, *>} fields
 * @returns {Record<string, *>} 只留需要写的
 */
export function pickWritable(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue; // undefined 一律当「没给」，不写
    if (knownField(key) && isDefault(key, value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 把一个值整理成「写进文件的样子」。认不出的字段原样返回。
 * 主要用途：三态字段把 `undefined` 归一成「不写」。
 */
export function normalizeForWrite(key, value) {
  if (isMissing(value)) return undefined;
  const spec = QUEST_FIELDS[key];
  if (!spec) return value;
  if (spec.kind === FIELD_KINDS.BOOL) return !!value;
  if (spec.kind === FIELD_KINDS.NUMBER) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (spec.kind === FIELD_KINDS.TRISTATE) {
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
    return undefined; // 认不出来的当没写
  }
  return value;
}
