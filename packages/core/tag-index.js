/**
 * 物品标签（tag）索引。
 *
 * 标签是什么：Minecraft 里给一组物品起的「集体名字」，写在数据包的
 * `data/<命名空间>/tags/item/<名字>.json` 里，内容形如
 *   { "values": ["minecraft:planks", "#minecraft:wooden_slabs", "create:cogwheels"] }
 * 游戏里「木板」不是一种物品，而是一个标签；所有木板都算它的成员。
 *
 * 为什么要建这个索引：JEI 19.x 的 `#` 就是按标签搜（`#planks` 列出所有木板）。
 * 用户装了几百个 mod，同一个东西在不同 mod 里叫不同名字，按标签找比按名字找靠谱得多。
 *
 * 两个必须处理的坑（实测）：
 * 1. **目录名分版本**：1.21.1 是 `tags/item/`，1.20.1 是 `tags/items/`。
 *    只写一种会让另一版本的包静默失去全部标签。方块同理（`block` / `blocks`）。
 * 2. **标签可以嵌套标签**：`values` 里 `#minecraft:wooden_slabs` 是引用另一个标签。
 *    不递归展开的话，「木板」下面一个物品都没有。
 *
 * 本文件只做「收集 + 递归展开」两件纯事，不碰磁盘 —— 读 jar 由 index.js 负责，
 * 这样同一份数据既能给界面接口用，也能给 MCP 工具用。
 */

/** 标签文件路径：1.21 单数 / 1.20 复数都认。 */
const TAG_RE = /^data\/([^/]+)\/tags\/(items?|blocks?)\/(.+)\.json$/;

/** 把 `values` 里的一项补全成完整 ID（没写命名空间的默认是 minecraft）。 */
function fullId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.includes(':')) return s.toLowerCase();
  return `minecraft:${s.toLowerCase()}`;
}

/**
 * 从一个 zip 里收集标签定义（**不展开**，因为可能引用别的 jar 里的标签）。
 *
 * @param {{names: string[], text: (n: string) => string}} zip
 * @param {Map<string, string[]>} into 标签名 → 原始 values 列表（多个 jar 的同名标签会合并）
 * @returns {{files: number, entries: number}} 读到几个标签文件、多少条定义
 */
export function collectTagDefs(zip, into) {
  let files = 0;
  let entries = 0;
  for (const name of zip.names) {
    const m = TAG_RE.exec(name);
    if (!m) continue;
    const kind = m[2];
    // 方块标签和物品标签分开存，但统一挂在 `tag:类型` 前缀下，
    // 否则 `minecraft:logs`（方块）和 `minecraft:logs`（物品）会互相污染
    const prefix = kind.startsWith('block') ? 'block:' : '';
    const tag = `${prefix}${m[1]}:${m[3]}`.toLowerCase();
    let parsed;
    try {
      parsed = JSON.parse(zip.text(name));
    } catch {
      continue; // 单个标签文件坏了不该毁掉整个索引
    }
    const values = Array.isArray(parsed?.values) ? parsed.values : [];
    const kept = [];
    for (const v of values) {
      // 1.20 之前的写法：{ "id": "minecraft:planks", "required": false }
      const raw = typeof v === 'string' ? v : (v && typeof v === 'object' ? v.id : '');
      const s = String(raw ?? '').trim();
      if (!s) continue;
      if (s.startsWith('#')) kept.push(`#${fullId(s.slice(1))}`);
      else kept.push(fullId(s));
    }
    if (!kept.length) continue;
    files++;
    entries += kept.length;
    const list = into.get(tag);
    if (list) list.push(...kept);
    else into.set(tag, kept);
  }
  return { files, entries };
}

/**
 * 递归展开标签，得到「物品 → 属于哪些标签」和「标签 → 包含哪些物品」。
 *
 * 环保护：标签互相引用（A 引用 B、B 又引用 A）在真实数据包里出现过，
 * 不挡会死循环。做法是记「正在解析中」的集合，遇到就跳过。
 *
 * @param {Map<string, string[]>} rawDefs collectTagDefs 收集的原始定义
 * @param {Set<string>} [knownItems] 只保留这些物品（不给就全留）
 * @returns {{tagItems: Map<string, Set<string>>, itemTags: Map<string, Set<string>>, tagCount: number, itemCount: number}}
 */
export function resolveTags(rawDefs, knownItems) {
  /** 标签 → 展开后的物品集合 */
  const tagItems = new Map();
  /** 正在解析的标签（环保护） */
  const resolving = new Set();

  const expand = (tag) => {
    const hit = tagItems.get(tag);
    if (hit) return hit;
    if (resolving.has(tag)) return new Set(); // 环：这一层先当空，外层继续
    const values = rawDefs.get(tag);
    if (!values) {
      // 引用了不存在的标签（mod 之间的可选依赖），当空集合缓存起来，
      // 免得每次遇到都重算
      const empty = new Set();
      tagItems.set(tag, empty);
      return empty;
    }
    resolving.add(tag);
    const out = new Set();
    for (const v of values) {
      if (v.startsWith('#')) {
        for (const id of expand(v.slice(1))) out.add(id);
        continue;
      }
      // 方块标签里可能写的是方块 ID，物品索引里没有的就先留着 ——
      // 反正界面按物品表搜，多出来的 ID 不会显示
      if (!knownItems || knownItems.has(v)) out.add(v);
    }
    resolving.delete(tag);
    tagItems.set(tag, out);
    return out;
  };

  for (const tag of rawDefs.keys()) expand(tag);

  // 反向表：物品 → 标签。用 `block:` 前缀的方块标签不参与物品搜索
  /** @type {Map<string, Set<string>>} */
  const itemTags = new Map();
  for (const [tag, set] of tagItems) {
    if (tag.startsWith('block:')) continue;
    for (const id of set) {
      const list = itemTags.get(id);
      if (list) list.add(tag);
      else itemTags.set(id, new Set([tag]));
    }
  }

  return { tagItems, itemTags, tagCount: tagItems.size, itemCount: itemTags.size };
}

/** 标签名的「路径段」（`minecraft:wooden_slabs` → `wooden_slabs`），搜索时优先匹配它。 */
export function tagPath(tag) {
  const s = String(tag ?? '');
  const colon = s.indexOf(':');
  return colon >= 0 ? s.slice(colon + 1) : s;
}
