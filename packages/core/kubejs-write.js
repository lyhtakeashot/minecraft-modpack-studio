/**
 * 生成 KubeJS 脚本片段，并把它落到磁盘上。
 *
 * 只做三件最常见的事，保持简单：
 *   1. 删掉一个/一批配方（event.remove）
 *   2. 加一个有序/无序合成配方（event.shaped / event.shapeless）
 *   3. 加一个 Create 机器配方（event.recipes.create.*）
 *
 * 生成的代码一律带 `.id('kubejs:xxx')`，这样以后要改/要删能按 ID 精确找到，
 * 不用靠位置猜。
 */
import fs from 'node:fs';
import path from 'node:path';
import { McError } from './errors.js';

/** KubeJS ID 必须小写、只含字母数字下划线斜杠点。 */
const NS_RE = /^[a-z0-9_-]+:[a-z0-9_./-]+$/;

function assertId(id, what) {
  if (!NS_RE.test(id)) {
    throw new McError(`${what}「${id}」不是合法的物品 ID`, '格式应该像 create:cogwheel，全小写', 'BadId');
  }
  return id;
}

/** 把 'minecraft:oak_planks' 这种安全地放进单引号字符串里。 */
function q(text) {
  return `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** 有序合成的 3x3 图案：pattern 是长度 1~3 的字符串数组，keys 是 字符→物品。 */
function shapedBody({ output, count, pattern, keys }) {
  const lines = [];
  lines.push(`    event.shaped(${count > 1 ? `${q(`${count}x ${output}`)}` : q(output)}, [`);
  for (const row of pattern) lines.push(`      ${q(row)},`);
  lines.push('    ], {');
  const entries = Object.entries(keys);
  for (const [char, item] of entries) lines.push(`      ${char}: ${q(item)},`);
  lines.push('    })');
  return lines;
}

/**
 * 生成一段脚本内容。
 *
 * @param {object} spec
 * @param {string} spec.sourceFile 写在哪个脚本里（只用于注释抬头）
 * @param {Array<{id?: string, mod?: string}>} [spec.remove] 要删的配方过滤器
 * @param {Array<object>} [spec.recipes] 要加的配方
 * @param {string} [spec.header] 自定义抬头注释
 * @returns {{code: string, summary: string[]}}
 */
export function generateScript(spec) {
  const summary = [];
  const body = [];

  for (const filter of spec.remove ?? []) {
    if (filter.id) {
      assertId(filter.id, '配方 ID');
      body.push(`    // 删掉 ${filter.id}`);
      body.push(`    event.remove({ id: ${q(filter.id)} })`);
      summary.push(`删配方 ${filter.id}`);
    } else if (filter.mod) {
      body.push(`    // 删掉 ${filter.mod} 的全部配方`);
      const extra = filter.type ? `, type: ${q(filter.type)}` : '';
      body.push(`    event.remove({ mod: ${q(filter.mod)}${extra} })`);
      summary.push(`删 ${filter.mod} 的配方${filter.type ? `（只限 ${filter.type} 类型）` : '（全部）'}`);
    } else {
      throw new McError('删配方时必须给 id 或 mod', '比如 {id:"create:xxx"} 或 {mod:"create"}', 'BadRemove');
    }
  }

  for (const recipe of spec.recipes ?? []) {
    const kind = recipe.kind ?? 'shapeless';
    const output = assertId(recipe.output, '产物');
    const count = Math.max(1, recipe.count ?? 1);
    const recipeId = recipe.id ? assertId(recipe.id, '配方 ID') : `kubejs:${output.split(':')[1]}_from_dsh`;

    if (kind === 'shaped') {
      const pattern = recipe.pattern ?? [];
      if (!pattern.length || pattern.length > 3) {
        throw new McError('有序合成的图案必须是 1~3 行', '比如 ["ABA","BCB","ABA"]', 'BadPattern');
      }
      const keys = recipe.keys ?? {};
      // 图案里出现的字符必须在 keys 里有对应物品，否则游戏里会报空指针
      const used = new Set(pattern.join('').replace(/ /g, '').split(''));
      for (const ch of used) {
        if (!keys[ch]) {
          throw new McError(`图案里的 ${ch} 没有指定物品`, 'keys 里要写清每个字母代表什么', 'BadPattern');
        }
        assertId(keys[ch], `图案 ${ch} 的物品`);
      }
      body.push(`    // ${count > 1 ? count + ' 个 ' : ''}${output}`);
      body.push(...shapedBody({ output, count, pattern, keys }));
      body.push(`      .id(${q(recipeId)})`);
      summary.push(`加有序合成 → ${count > 1 ? `${count} 个 ` : ''}${output}（配方 ID ${recipeId}）`);
    } else if (kind === 'shapeless') {
      const inputs = recipe.inputs ?? [];
      if (!inputs.length) {
        throw new McError('无序合成至少要一个材料', 'inputs 里写材料列表', 'BadRecipe');
      }
      for (const item of inputs) assertId(item, '材料');
      body.push(`    // ${count > 1 ? count + ' 个 ' : ''}${output}`);
      body.push(`    event.shapeless(${count > 1 ? `${q(`${count}x ${output}`)}` : q(output)}, [`);
      for (const item of inputs) body.push(`      ${q(item)},`);
      body.push('    ])');
      body.push(`      .id(${q(recipeId)})`);
      summary.push(`加无序合成 → ${count > 1 ? `${count} 个 ` : ''}${output}（配方 ID ${recipeId}）`);
    } else {
      // Create 之类的机器配方：event.recipes.create.pressing(out, in...)
      if (!/^[a-z_]+$/.test(kind)) {
        throw new McError(`不认识这种配方类型「${kind}」`, '常见的有 shaped / shapeless / pressing / mixing / crushing / cutting', 'BadRecipeKind');
      }
      const inputs = recipe.inputs ?? [];
      if (!inputs.length) throw new McError('机器配方至少要一个材料', 'inputs 里写材料', 'BadRecipe');
      for (const item of inputs) assertId(item, '材料');
      // 数量没法像 shaped 那样写成 "2x id" 字符串，必须用 Item.of('id', 2)
      const outExpr = count > 1 ? `Item.of(${q(output)}, ${count})` : q(output);
      body.push(`    // ${count > 1 ? `${count} 个 ` : ''}${output} ← ${inputs.join(' + ')}`);
      body.push(`    event.recipes.create.${kind}(${outExpr}, ${inputs.map(q).join(', ')})`);
      body.push(`      .id(${q(recipeId)})`);
      summary.push(`加 ${kind} 配方 → ${count > 1 ? `${count} 个 ` : ''}${output}（配方 ID ${recipeId}）`);
    }
  }

  if (!body.length) {
    throw new McError('没有任何要生成的内容', '至少给一个 remove 或 recipes', 'EmptyScript');
  }

  const header = spec.header ?? '由 MC 整合包工作室生成';
  const code = [
    `// ${header}`,
    '// 这个文件可以随意改名，KubeJS 会按目录自动加载。',
    '',
    'ServerEvents.recipes((event) => {',
    ...body,
    '})',
    '',
  ].join('\n');

  return { code, summary };
}

/** 生成的目标文件路径：默认单独一个文件，避免和原有的手写脚本混在一起。 */
export function targetFile(kubejsDir, name = 'dsh_magic') {
  const safe = String(name).replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  return path.join(kubejsDir, 'server_scripts', `dsh_${safe}.js`);
}
