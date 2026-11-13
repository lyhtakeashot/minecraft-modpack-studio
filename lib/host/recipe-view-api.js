/**
 * 「这条配方长什么样」的宿主侧接口：给界面画 JEI 那种合成表。
 *
 * 为什么和 recipe-api.js 分开放：那边管的是「改配方」（生成 KubeJS、写盘、复验），
 * 每一条都带着写风险；这边**只读**，纯查一条配方并整理成画格子用的数据。
 * 混在一起会让「只想看一眼」和「会动文件」共用一套参数，迟早出事。
 *
 * 但「怎么找到一条配方」这件事两边完全一样（找实例 → 读配方图 → 打开 jar
 * 读原始 JSON → 整理成表单），所以定位那段直接复用 recipe-api.js 的 `locate`，
 * 不复制一份 —— 复制的那份迟早会跟原件长歪。
 *
 * 返回的形状（界面按它画，别随便改字段名）：
 *
 *   {
 *     ok: true,
 *     instanceId,            // 实例名，方便界面显示「这是哪个包」
 *     itemName,              // 产物的中文名（查不到就是空串）
 *     recipe: desc,          // describeRecipe() 的原样返回，编辑表单还要用
 *     layout,                // layoutRecipe() 的返回，画格子用这个
 *     rawJson,               // 原始 JSON，界面想看细节时用（超过 8KB 会截断）
 *     rawJsonTruncated,      // 上面那份是不是被截断了
 *     rawJsonSize,           // 截断前的字符数（给界面显示「共 N 字符」）
 *   }
 */
import { McError } from '../../packages/core/errors.js';
import { layoutRecipe } from '../../packages/core/recipe-layout.js';
import { cachedIndex } from './cache.js';
import { locate, needDir, readParams } from './recipe-api.js';

/** 原始 JSON 最多回多少字符：有些 Create 配方（序列组装）能写到几十 KB，全塞给界面会卡。 */
const RAW_LIMIT = 8 * 1024;

/**
 * 把原始 JSON 收成字符串，超过上限就截断。
 *
 * 截断而不是整份丢掉：界面多半只想看「大概是啥结构」，
 * 前 8KB 足够看清 type / pattern / key / result，而这些正是画格子要的。
 *
 * @param {unknown} raw
 * @returns {{text: string, truncated: boolean, size: number}}
 */
export function packRawJson(raw) {
  let text;
  try {
    text = JSON.stringify(raw ?? null, null, 2);
  } catch {
    // 有环或者别的怪情况：退回最朴素的一层，不要让整个接口 500
    try {
      text = String(raw);
    } catch {
      text = '';
    }
  }
  if (typeof text !== 'string') text = '';
  const size = text.length;
  if (size <= RAW_LIMIT) return { text, truncated: false, size };
  return { text: `${text.slice(0, RAW_LIMIT)}\n… （共 ${size} 字符，已截断）`, truncated: true, size };
}

/**
 * GET/POST /recipe/view?dir&id&recipeId —— 一条配方「怎么画」。
 *
 * 参数和 `/recipe` 完全一样（`/recipe` 返回编辑表单，这里返回格子布局），
 * 所以界面从配方列表点进来时不用换参。
 */
export async function handleRecipeView(request) {
  const params = await readParams(request);
  needDir(params); // 缺 dir 时先抛出中文错误，别等 locate 里报得含混
  const { instance, desc, rawJson } = locate(params);

  // 物品中文名：索引里有就用，没有就空串（界面上退回显示 ID）
  let itemName = '';
  let itemNameOf = () => '';
  try {
    const idx = cachedIndex(instance, false);
    itemNameOf = (id) => (id ? idx.nameOf(id) : '');
    itemName = desc.output ? itemNameOf(desc.output) : '';
  } catch {
    // 索引读不出来不该让「看一条配方」失败：名字空着，格子照画
  }

  const layout = layoutRecipe(desc, rawJson, { itemName: itemNameOf });
  const packed = packRawJson(rawJson);

  return {
    ok: true,
    instanceId: instance.id,
    itemName,
    recipe: desc,
    layout,
    rawJson: packed.text,
    rawJsonTruncated: packed.truncated,
    rawJsonSize: packed.size,
  };
}

/**
 * 只给单测用：不经过 HTTP 直接算一份布局。
 *
 * 存在的理由和 recipe-api.js 里的 `buildRecipePlan` 一样 ——
 * 算布局是纯逻辑，测它的用例不该被迫造一个 Request。
 *
 * @param {object} params
 * @returns {{layout: object, recipe: object}}
 */
export function buildRecipeView(params) {
  const { rawJson, desc } = locate(params);
  if (!desc || typeof desc !== 'object') {
    throw new McError('读不出这条配方', '可能 ID 抄错了', 'RecipeNotFound');
  }
  return { layout: layoutRecipe(desc, rawJson), recipe: desc };
}
