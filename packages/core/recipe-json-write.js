/**
 * 多产物配方的改写：照抄原 JSON，只改产物，写成 kubejs/data 里的同名数据包文件。
 *
 * ## 为什么走这条���，不走 KubeJS 事件 API
 *
 * 一条多产物配方在 KubeJS 里有两条路：
 *   ① `event.custom({type:'create:milling', ingredients:[...], results:[...]})`
 *   ② 直接往 `kubejs/data/<命名空间>/recipe/<路径>.json` 写一份 JSON
 *
 * ① 在原理上能写，但它走的是 KubeJS 自己的 schema 体系：
 * `event.custom` → `RecipeSchema.deserialize` → 需要那个 mod 自己注册过 KubeJS 集成。
 * 实测真实整合包「重度机械症」里 **183 个 jar、11076 条配方、854 条多产物**，
 * 几乎全是 Create 机器配方（emptying 401 / milling 179 / splashing 13 …），
 * 而**这个包压根没装 Create 的 KubeJS 集成** —— `event.custom` 写 `create:milling`
 * 在这个包里多半直接报「类型不认识」。而且 `event.shaped` / `event.shapeless`
 * 本来就只能出一种产物，改多产物还得整个换写法。
 *
 * ② 是数据包机制：KubeJS 6 把 `kubejs/data/` 当成数据包根（KubeJS 自己的说明串原文
 * 「data - Acts as a datapack, you can put any server resources in here, like loot
 * tables, functions, etc. Example: data/kubejs/loot_tables/blocks/test_block.json」），
 * 配合 `KubeFileResourcePack` 扫磁盘目录当资源包。**同一个包自己的作者就在用这条路**：
 * 实测 `kubejs/data/` 下有 1870 个 json、其中配方文件 516 个，
 * 并且有 **106 处直接覆盖 mod jar 里的同名配方**（连 `{"type":"neoforge:none"}`
 * 这种专门用来「禁用同名配方」的写法都有）。
 *
 * 所以这里照着包作者的做法走：文件名和原配方完全一样 → 配方 ID 不变 → 覆盖生效，
 * 不会出现「原配方还在、新配方又来一份」打架的情况。
 *
 * ## 只改产物，别的不动
 *
 * 机器配方的 JSON 里有一堆专属参数（Create 的 `processing_time`、
 * `category`、`neoforge:conditions`……）。少写一个，游戏里就可能整条配方失效或者行为变了。
 * 所以这里的规矩是：**原 JSON 整份复制，只把产物那一个键换掉**，其余字段一个不碰。
 */
import path from 'node:path';
import { McError } from './errors.js';

const ID_RE = /^[a-z0-9_-]+:[a-z0-9_./-]+$/;

/**
 * 原 JSON 里产物用的是哪个键。
 *
 * 各家写法不一样：原版 1.21 用 `result`（对象），Create 用 `results`（数组），
 * 另有 mod 用 `output`（数组）。**改写时必须沿用原来的键名**，换成别的游戏就不认了。
 *
 * @param {object} json
 * @returns {'result'|'results'|'output'}
 */
export function resultKeyOf(json) {
  if (json?.results !== undefined) return 'results';
  if (json?.output !== undefined) return 'output';
  if (json?.result !== undefined) return 'result';
  return 'results';
}

/**
 * 产物项里物品 ID 那个字段叫什么：`item`（1.20 及以前）还是 `id`（1.21 起）。
 *
 * 优先照抄原 JSON 的写法 —— 原配方是哪种就写哪种，最稳。
 * 原配方看不出来时才按游戏版本猜。
 *
 * @param {unknown} value 原 JSON 里的产物值
 * @param {string} [mcVersion]
 * @returns {'item'|'id'}
 */
function itemFieldOf(value, mcVersion) {
  const list = Array.isArray(value) ? value : [value];
  for (const v of list) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof v.item === 'string') return 'item';
      if (typeof v.id === 'string') return 'id';
    }
  }
  if (typeof mcVersion === 'string' && /^1\.(19|20)/.test(mcVersion)) return 'item';
  return 'id';
}

/**
 * 算出同名覆盖文件写到哪儿。
 *
 * 原配方在 jar 里的路径是 `data/<命名空间>/recipe/<相对路径>.json`，
 * 写进 kubejs 之后就是 `kubejs/data/<命名空间>/recipe/<相对路径>.json`。
 * 路径完全一样 → 配方 ID 不变 → 覆盖 mod 自带的那条。
 *
 * @param {string} kubejsDir 实例里的 kubejs 目录
 * @param {string} entry 原配方在 jar 里的路径
 * @returns {string}
 */
export function recipeJsonTargetPath(kubejsDir, entry) {
  const clean = String(entry ?? '').replace(/^[/\\]+/, '');
  if (!clean.toLowerCase().startsWith('data/')) {
    throw new McError(
      '算不出同名覆盖文件的位置',
      '这条配方不在 data 目录里，只能用代码改',
      'RecipeJsonMissing',
    );
  }
  return path.join(kubejsDir, 'data', clean.slice('data/'.length));
}

/**
 * 按用户的改动，写出一份改好的配方 JSON。
 *
 * @param {object} spec
 * @param {object} spec.rawJson 原配方 JSON（整份照抄）
 * @param {string} spec.entry 原配方在 jar 里的路径
 * @param {Array<{id: string, count: number, chance?: number}>} spec.outputs 新的产物清单
 * @param {string} [spec.mcVersion] 游戏版本（判断产物字段用 item 还是 id）
 * @returns {{content: string, summary: string[], warnings: string[], key: string}}
 */
export function buildRecipeJsonRewrite({ rawJson, entry, outputs, mcVersion }) {
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
    throw new McError(
      '读不出这条配方的原始内容',
      '这条配方改不了，只能在代码里手写',
      'RecipeJsonMissing',
    );
  }
  const list = (Array.isArray(outputs) ? outputs : []).filter((o) => o && o.id);
  if (!list.length) {
    throw new McError('至少要留一个产物', '把产物列表删空了就等于没有配方了', 'BadRecipe');
  }
  const bad = list.find((o) => !ID_RE.test(String(o.id)));
  if (bad) {
    throw new McError(
      `产物「${bad.id}」不是合法的物品 ID`,
      '格式应该像 create:cogwheel，全小写',
      'BadId',
    );
  }

  const warnings = [];
  const key = resultKeyOf(rawJson);
  const origValue = rawJson[key];
  const origIsArray = Array.isArray(origValue);
  const field = itemFieldOf(origValue, mcVersion);

  // 原配方里每种产物的原始写法。
  //
  // 产物项里除了物品 ID，还可能有别的字段不能丢 ——
  // 比如 Create 的流体产物 `create:honey` 那一项带 `"amount": 250`（250 毫桶），
  // 丢掉它这条产物就变成 0 了。所以同一种产物要**照抄原写法**，
  // 只把 ID、数量、概率这三样换成用户改的值。
  const origEntries = [];
  for (const v of (origIsArray ? origValue : origValue === undefined ? [] : [origValue])) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const id = typeof v.id === 'string' ? v.id : typeof v.item === 'string' ? v.item : '';
    if (id) origEntries.push({ id, entry: v });
  }

  // 整份深拷贝原 JSON，只换产物那一个键。
  const copy = JSON.parse(JSON.stringify(rawJson));
  const entries = list.map((o) => {
    const id = String(o.id);
    const match = origEntries.find((e) => e.id === id);
    const one = match ? JSON.parse(JSON.stringify(match.entry)) : {};
    // 物品 ID 字段名：原配方怎么写就怎么写（没有原条目才按版本定）
    const idField = match
      ? (typeof match.entry.id === 'string' ? 'id' : 'item')
      : field;
    if (idField !== 'id') delete one.id;
    if (idField !== 'item') delete one.item;
    one[idField] = id;
    const count = Number.isFinite(Number(o.count)) && Number(o.count) > 0 ? Math.floor(Number(o.count)) : 1;
    // 流体的量写在 `amount` 里（毫桶），跟物品的 `count` 是两回事。
    // 两个都写，游戏会按 `amount` 当流体处理，`count` 反而可能让它挑花眼 ——
    // 所以流体产物这里只保留原来的 `amount`，量要改得去游戏里调。
    const isFluid = Number.isFinite(one.amount);
    if (isFluid) {
      delete one.count;
    } else if (count !== 1) {
      one.count = count;
    } else {
      delete one.count;
    }
    const chance = Number(o.chance);
    if (Number.isFinite(chance) && chance > 0 && chance < 1) one.chance = chance;
    else delete one.chance;
    return one;
  });

  if (key === 'result' && !origIsArray && entries.length > 1) {
    // 原版单产物槽位被塞了多个产物：只有认数组的 mod 才吃这套，
    // 老实说出来，别让人以为一定管用。
    warnings.push('原配方只有一个产物位，现在改成了多个（数组写法）；只有支持数组产物的 mod 才认这种写法');
  }

  // 用户换成了原配方里没有的产物：原产物身上那些特殊字段（流体的 amount 之类）
  // 就跟不过去了，提醒一句，别让人以为「换个名字就行」。
  for (const o of list) {
    const id = String(o.id);
    if (origEntries.some((e) => e.id === id)) continue;
    const hadExtra = origEntries.some((e) => Object.keys(e.entry).some((k) => k !== 'id' && k !== 'item' && k !== 'count'));
    if (hadExtra) {
      warnings.push(`「${id}」是原配方里没有的产物，原来那些产物的附加参数（比如流体的量）不会自动跟过来，可能要在游戏里再调`);
    }
  }

  copy[key] = key === 'result' && !origIsArray && entries.length === 1 ? entries[0] : entries;

  const content = `${JSON.stringify(copy, null, 2)}\n`;
  const summary = [
    `把 ${entry} 的产物改成 ${entries.length} 种`,
    ...entries.map((e) => {
      const chance = Number.isFinite(e.chance) ? `（${Math.round(e.chance * 100)}% 概率）` : '';
      const count = e.count && e.count !== 1 ? ` ×${e.count}` : '';
      return `产出 ${e[field]}${count}${chance}`;
    }),
  ];
  return { content, summary, warnings, key };
}
