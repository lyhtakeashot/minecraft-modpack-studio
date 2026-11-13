/**
 * 依赖的四种满足方式 + 判定（2026-11-12 第二批；16:45 从 quests.js 拆出来）。
 *
 * ★ **为什么单独一个文件**：这个模块必须能**在浏览器里直接被 import**。
 *
 * 这些判定本来是写在 `packages/core/quests.js` 里的，界面也确实想用它
 * （判断「这个节点现在能不能开工」）。但 `quests.js` 顶部 import 了
 * `node:fs` / `node:path` —— 那是**只有 Node 才有的内置模块**，
 * 浏览器里 `import fs from 'node:fs'` 会直接抛错，把整棵模块树拖死。
 *
 * 2026-11-12 我犯过一次这个错：在 `packages/ui/app.js` 里
 * `import { dependencyStatus } from '../core/quests.js'`，
 * 结果**桌面版一开就白屏**（窗口出来了，但 app.js 一行都没执行）。
 *
 * 所以规矩是：**界面要用的 core 逻辑，必须放在不 import `node:*` 的文件里**。
 * 有副作用的部分（读盘 / 解析 snbt）留在 quests.js，纯逻辑放这儿，
 * quests.js 反过来从这里 import，两边共用同一份判定。
 *
 * 判定语义严格照抄 `Quest.checkDependencies()`（Quest.java:1077）。
 */

/**
 * FTB 的四种依赖满足方式（`DependencyRequirement.java`）。
 *
 * | id            | needOnlyOne | needCompletion | 含义                     |
 * |---------------|-------------|----------------|--------------------------|
 * | all_completed | false       | true           | 前置全做完（默认）       |
 * | one_completed | true        | true           | 前置里任意一个做完       |
 * | all_started   | false       | false          | 前置全开始（不要求做完） |
 * | one_started   | true        | false          | 前置里任意一个开始       |
 *
 * 前两个看「完成」，后两个看「开始」—— 别把 all_started 当成 all_completed。
 */
export const DEPENDENCY_REQUIREMENTS = [
  { id: 'all_completed', label: '前置全部完成（默认）', needOne: false, needCompletion: true },
  { id: 'one_completed', label: '前置任意一个完成', needOne: true, needCompletion: true },
  { id: 'all_started', label: '前置全部开始（不用做完）', needOne: false, needCompletion: false },
  { id: 'one_started', label: '前置任意一个开始', needOne: true, needCompletion: false },
];

/** 默认的依赖方式（游戏里不写这个键时就是这个）。 */
export const DEFAULT_DEPENDENCY_REQUIREMENT = 'all_completed';

/**
 * 把文件里那个字符串归一成四种之一。
 * 不认识的写法（含空串）一律退回默认 —— 游戏那边 NAME_MAP 查不到也回默认，跟它保持一致。
 */
export function normalizeRequirement(value) {
  const want = String(value ?? '').trim();
  return DEPENDENCY_REQUIREMENTS.some((r) => r.id === want) ? want : DEFAULT_DEPENDENCY_REQUIREMENT;
}

/** 取某种依赖方式的定义（永远有返回值，最差是默认那条）。 */
export function dependencyRequirementOf(id) {
  const want = normalizeRequirement(id);
  return DEPENDENCY_REQUIREMENTS.find((r) => r.id === want) ?? DEPENDENCY_REQUIREMENTS[0];
}

/**
 * 这个任务的依赖满足了吗。
 *
 * **严格照抄 `Quest.checkDependencies()` 的三层优先级**（Quest.java:1077）：
 *   1. `minRequiredDependencies > 0` → 前置里至少有 N 个满足（最高优先级，连 dependency_requirement 都不看）
 *   2. 否则 `dependencyRequirement.needOnlyOne()` → 任意一个满足
 *   3. 否则 → 全部满足
 *
 * 「满足」是什么意思由 `isSatisfied` 决定：调用方按 needCompletion
 * 传「已完成」或「已开始」的判定。
 *
 * ★ 空依赖怎么办：FTB 的 `allMatch` / `anyMatch` 在空流上分别是 true / false，
 *   但 `minRequiredDependencies > 0` 时 `count() == N` 对空流是 false（0 != N）。
 *   一律照抄，别自作聪明统一成 true。
 *
 * @param {object} quest 至少要有 dependencies / dependencyRequirement / minRequiredDependencies
 * @param {(depId: string) => boolean} isSatisfied 某个前置满不满足
 * @returns {{ok: boolean, mode: string, needOne: boolean, needCompletion: boolean,
 *            requirement: string, minRequired: number, checked: number,
 *            satisfied: number, unsatisfied: string[]}}
 */
export function dependencyStatus(quest, isSatisfied) {
  const deps = Array.isArray(quest?.dependencies) ? quest.dependencies.map(String) : [];
  const minRequired = Math.max(0, Math.floor(Number(quest?.minRequiredDependencies ?? 0) || 0));
  const req = dependencyRequirementOf(quest?.dependencyRequirement);

  // 逐条问一遍，顺便记哪些算满足了（界面要显示「3/5 个前置」这种）
  const satisfied = [];
  const unsatisfied = [];
  for (const dep of deps) {
    if (isSatisfied(dep)) satisfied.push(dep);
    else unsatisfied.push(dep);
  }

  let ok;
  let mode;
  if (minRequired > 0) {
    // 第一优先级：「至少 N 个」。FTB 用 limit(N).count() == N，
    // 等价于「满足的个数 >= N」；空依赖时 N>0 恒不成立。
    ok = satisfied.length >= minRequired;
    mode = 'at_least';
  } else if (req.needOne) {
    ok = satisfied.length > 0;
    mode = 'one';
  } else {
    // allMatch：空依赖算满足（没前置就是能直接做）
    ok = unsatisfied.length === 0;
    mode = 'all';
  }

  return {
    ok,
    mode,
    needOne: req.needOne,
    needCompletion: req.needCompletion,
    requirement: req.id,
    minRequired,
    checked: deps.length,
    satisfied: satisfied.length,
    unsatisfied,
  };
}

/**
 * 一批任务里哪些现在能做（依赖都满足了）。
 *
 * 用途：预览窗口画「锁定」标记、体检报「这个任务永远开不了」、画布判节点状态。
 *
 * @param {object} store 有 quests 数组的对象（loadQuests() 的返回，或界面自己拼的）
 * @param {Set<string>} completed 已完成的任务 id
 * @param {Set<string>} [started] 已开始的任务 id（不给就当成「完成的才算开始」）
 * @returns {Map<string, ReturnType<typeof dependencyStatus>>}
 */
export function dependencyStatusAll(store, completed, started = null) {
  const done = completed instanceof Set ? completed : new Set(Array.isArray(completed) ? completed : []);
  const begin = started instanceof Set ? started : done;
  const out = new Map();
  const quests = Array.isArray(store?.quests) ? store.quests : [];
  for (const quest of quests) {
    // 看「完成」还是「开始」，由这个任务自己的依赖方式决定
    const needCompletion = dependencyRequirementOf(quest.dependencyRequirement).needCompletion;
    const pool = needCompletion ? done : begin;
    out.set(quest.id, dependencyStatus(quest, (depId) => pool.has(depId)));
  }
  return out;
}
