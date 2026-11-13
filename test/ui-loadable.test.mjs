/**
 * 守护一条规矩：**界面能加载的模块，不许碰 `node:*`**（2026-11-12 白屏事故）。
 *
 * ## 事故经过
 *
 * 我在 `packages/ui/app.js` 里写了
 * ```js
 * import { dependencyStatus } from '../core/quests.js';
 * ```
 * 而 `packages/core/quests.js` 顶部是 `import fs from 'node:fs'`。
 * 浏览器没有 `fs`，**整个模块图在加载阶段就失败** ——
 * `app.js` 一行都没执行，页面一片空白。
 *
 * 症状特别有迷惑性：**窗口能开、进程活着、接口层也正常**，
 * 看起来像「加载慢」或者「渲染卡住」，其实是入口脚本压根没跑起来。
 * 本地所有测试都绿 —— 因为 Node 里 `node:fs` 是有的。
 *
 * ## 这条规矩
 *
 * 界面（`packages/ui/*`）直接或间接 import 的每个模块，
 * 沿途都不许出现 `node:` 开头的内置模块。
 * 需要 Node 能力时，把**纯逻辑**拆到单独文件（例：`packages/core/quest-deps.js`
 * 就是从 `quests.js` 拆出来的），界面引纯逻辑那份。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从某个文件的源码里抽 import 的模块说明符。 */
function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  // 静态 import（含 `export ... from`）
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  // 副作用 import：`import './x.js'`
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

/**
 * 从入口出发沿相对 import 走一遍，返回 { visited, offenders }。
 * offenders 是「哪个文件引了 node: 内置模块」。
 */
function scanFrom(entries) {
  const visited = new Set();
  const offenders = [];
  const walk = (file) => {
    const abs = path.resolve(file);
    if (visited.has(abs)) return;
    visited.add(abs);
    if (!fs.existsSync(abs)) {
      offenders.push({ file: abs, spec: '(文件不存在)' });
      return;
    }
    for (const spec of importsOf(abs)) {
      if (spec.startsWith('node:')) {
        offenders.push({ file: abs, spec });
        continue;
      }
      // 只跟相对路径；裸模块名（比如 @deepseek-ai/...）不是界面能加载的东西，
      // 真出现在界面里本身就是错的，但那是另一条规矩，这里不管。
      if (spec.startsWith('.')) walk(path.join(path.dirname(abs), spec));
    }
  };
  for (const e of entries) walk(e);
  return { visited, offenders };
}

/** 相对项目根的可读路径。 */
const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/');

test('界面入口的整条 import 链里不许出现 node:*（否则桌面版直接白屏）', () => {
  const { visited, offenders } = scanFrom([
    path.join(ROOT, 'packages/ui/app.js'),
    path.join(ROOT, 'packages/ui/stages.js'),
    path.join(ROOT, 'packages/ui/recipe-view.js'),
  ]);

  // 扫到的模块数应该是个合理值（防止路径写错导致「什么都没扫到所以全绿」）
  assert.ok(visited.size >= 5, `只扫到 ${visited.size} 个模块，路径八成写错了`);

  assert.deepEqual(
    offenders.map((o) => `${rel(o.file)} → ${o.spec}`),
    [],
    '界面加载链里出现了 node: 内置模块 —— 浏览器没有它，会让整个 app.js 加载失败、'
    + '窗口打开却一片空白。把纯逻辑拆到不带 node:* 的文件里（做法见 packages/core/quest-deps.js）。',
  );
});

test('依赖判定模块本身必须能被浏览器加载（这是拆分的意义）', () => {
  const { offenders } = scanFrom([path.join(ROOT, 'packages/core/quest-deps.js')]);
  assert.deepEqual(offenders.map((o) => `${rel(o.file)} → ${o.spec}`), []);
});

test('任务类型的标题拼装模块也必须能被浏览器加载', () => {
  const { offenders } = scanFrom([path.join(ROOT, 'packages/core/quest-type-title.js')]);
  assert.deepEqual(offenders.map((o) => `${rel(o.file)} → ${o.spec}`), []);
});

test('对照：quests.js 确实引了 node:fs —— 所以它绝不能出现在界面里', () => {
  // 这条是「反向钉子」：如果哪天有人把 quests.js 的 node 依赖去掉，
  // 这条会失败，提醒把这条注释和上面那条规矩一起更新。
  const specs = importsOf(path.join(ROOT, 'packages/core/quests.js'));
  assert.ok(specs.includes('node:fs'), 'quests.js 该引 node:fs（它是读盘模块）');
  assert.ok(specs.includes('node:path'), 'quests.js 该引 node:path');
});
