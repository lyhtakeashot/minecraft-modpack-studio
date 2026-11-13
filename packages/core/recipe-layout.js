/**
 * 配方「怎么画」：把一条配方整理成格子布局数据。
 *
 * 为什么单独一层：用户要的是「JEI 那种合成表」——九宫格、箭头、产物。
 * 但 `describeRecipe()` 给的是「表单要填的字段」（产物数量、图案、材料列表），
 * 里面没有「第几行第几列放什么」这种画图专用的信息，也没算总产出。
 * 两件事拆开，界面就只管照 `grid.rows/cols` 画格子，不用自己理解配方。
 *
 * 这个模块是**纯函数**：不读盘、不发请求、不改入参。
 * 所以单测可以拿手造的 desc / json 直接调，不用造整合包。
 *
 * 三个容易画错的点，这里都处理了：
 *   1. 有序合成按图案真实宽高画。1x1 / 2x2 / 3x3 都可能，别一律画九宫格。
 *   2. 机械动力的大格子（机械合成器）可能是 3x5 = 15 格、5x5 = 25 格，
 *      **不能硬塞进 9 格**，否则材料会「消失」，用户看到的是错的。
 *   3. 材料是标签（`#minecraft:planks`，任意一种木板都行）时不能当成具体物品画，
 *      要如实标成 tag，并且告诉用户「这条界面上改不了」。
 */
import { recipeKindOf } from './recipes.js';

/**
 * Create 机器类型 → 中文名 + 机器方块物品 ID。
 *
 * 为什么要有这张表：`create:pressing` 这种类型名对不熟 mod 的用户等于没有信息，
 * 界面上要显示「压片机」和那张机器贴图，用户才知道是哪台机器。
 * 不认识的类型不瞎猜：名字退回原 id，图标留空，界面画占位方块。
 */
const MACHINE_TABLE = {
  pressing: { name: '压片机', icon: 'create:mechanical_press' },
  compacting: { name: '压块机', icon: 'create:mechanical_press' },
  mixing: { name: '搅拌盆', icon: 'create:basin' },
  milling: { name: '粉碎轮', icon: 'create:crushing_wheel' },
  cutting: { name: '机械锯', icon: 'create:mechanical_saw' },
  sawing: { name: '机械锯', icon: 'create:mechanical_saw' },
  filling: { name: '注液器', icon: 'create:spout' },
  emptying: { name: '注液器', icon: 'create:spout' },
  spouting: { name: '注液器', icon: 'create:spout' },
  deploying: { name: '机械手', icon: 'create:deployer' },
  item_application: { name: '机械手', icon: 'create:deployer' },
  splashing: { name: '鼓风机', icon: 'create:encased_fan' },
  haunting: { name: '鼓风机', icon: 'create:encased_fan' },
  smoking: { name: '鼓风机', icon: 'create:encased_fan' },
  blasting: { name: '鼓风机', icon: 'create:encased_fan' },
  sequenced_assembly: { name: '序列组装', icon: 'create:mechanical_press' },
  mechanical_crafting: { name: '机械合成器', icon: 'create:mechanical_crafter' },
  crafting: { name: '机械合成器', icon: 'create:mechanical_crafter' },
};

/**
 * 这些机器配方自己带 `pattern`，格子必须按图案真实宽高画。
 *
 * 机械合成器（mechanical_crafter）是「任意格子布局」，3x5、5x5 都合法 ——
 * 用户说的「18 格、25 格」就是它。这里不能走「材料横排一行」那条路。
 * 序列组装（sequenced_assembly）本身是「一步步过机器」，但它也可能带图案，
 * 带了就照样按真实宽高画；没带就退回横排（下面的判断会按 pattern 有没有来分）。
 */
const PATTERN_MACHINES = new Set(['mechanical_crafting', 'crafting', 'sequenced_assembly']);

/** 机器配方横排材料时最多画几格（再多界面就挤了，超出的写进 notes）。 */
const MAX_MACHINE_COLS = 6;

// ————————————————————————— 小工具 —————————————————————————

/** 拿一个「物品 ID → 中文名」的查询函数；调用方没给就返回空串。 */
function nameGetter(opts) {
  const fn = opts && typeof opts.itemName === 'function' ? opts.itemName : null;
  if (!fn) return () => '';
  return (id) => {
    if (!id) return '';
    try {
      return String(fn(id) ?? '');
    } catch {
      // 查名字失败不该让整条配方画不出来
      return '';
    }
  };
}

/** 正整数，非法值退回 fallback。 */
function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 数组里最长的那个字符串有多长（图案列数）。 */
function widest(list) {
  let width = 0;
  for (const row of list) width = Math.max(width, String(row).length);
  return width;
}

// ————————————————————————— 材料 / 产物解析 —————————————————————————

/**
 * 把配方里的一种「材料写法」还原成格子要用的形状。
 *
 * 常见写法有十几种（字符串 / {item} / {tag} / {id} / 数组 / {items:[]} /
 * Create 的 {base}/{ingredient}），这里只认我们画得出来的，认不出就给 unknown ——
 * 假装认识然后画错，比老实画个问号糟糕得多。
 *
 * @param {unknown} value
 * @returns {{kind:'item'|'tag'|'fluid'|'unknown', id:string, count:number}|null}
 */
export function materialOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const id = value.trim();
    return id ? { kind: 'item', id, count: 1 } : null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return materialOf(value[0]);
    // 列了好几种可选物品：界面上没法表达「任选其一」，标成 unknown
    return { kind: 'unknown', id: '', count: 1 };
  }
  if (typeof value !== 'object') return null;
  const o = value;
  const count = positive(o.count, 1);
  if (typeof o.fluid === 'string') return { kind: 'fluid', id: o.fluid, count };
  if (typeof o.fluidTag === 'string') return { kind: 'fluid', id: `#${o.fluidTag.replace(/^#/, '')}`, count };
  if (typeof o.tag === 'string') {
    const tag = o.tag.replace(/^#/, '');
    return tag ? { kind: 'tag', id: `#${tag}`, count } : null;
  }
  if (typeof o.item === 'string') return { kind: 'item', id: o.item, count };
  if (typeof o.id === 'string') return { kind: 'item', id: o.id, count };
  for (const key of ['ingredient', 'base', 'template', 'addition', 'input', 'item']) {
    if (o[key] !== undefined && o[key] !== null) {
      const inner = materialOf(o[key]);
      if (inner) return inner;
    }
  }
  if (Array.isArray(o.items)) return materialOf(o.items);
  if (Array.isArray(o.choices)) return materialOf(o.choices);
  return { kind: 'unknown', id: '', count: 1 };
}

/**
 * 从原始 JSON 里扫出全部产物（主产物 + 副产物）。
 *
 * 不复用 `parseRecipe()` 的结果，是因为这里要保住「每个产物几个」的原始数量，
 * 而 describeRecipe 会把多产物当成「改不了」，只留一个 output 字段。
 *
 * @param {object} json
 * @returns {{id:string, count:number}[]}
 */
function scanOutputs(json) {
  const list = [];
  const take = (id, count) => {
    if (typeof id !== 'string' || !id.trim()) return;
    list.push({ id: id.trim(), count: positive(count, 1) });
  };
  const visit = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      take(value, 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object') return;
    const o = value;
    const count = positive(o.count, 1);
    if (typeof o.item === 'string') {
      take(o.item, count);
      return;
    }
    if (typeof o.id === 'string' && !o.tag) {
      take(o.id, count);
      return;
    }
    if (Array.isArray(o.items)) {
      visit(o.items);
      return;
    }
    if (Array.isArray(o.choices)) {
      visit(o.choices);
      return;
    }
    if (o.result !== undefined) visit(o.result);
    if (o.output !== undefined) visit(o.output);
  };
  visit(json?.result);
  visit(json?.results);
  visit(json?.output);
  return list;
}

/** Create 配方偶尔会把流体写在顶层（`fluid` / `fluidTag`），也当成一格材料画出来。 */
function fluidCellOf(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.fluid === 'string') return { kind: 'fluid', id: json.fluid, count: positive(json.fluidAmount, 1) };
  if (typeof json.fluidTag === 'string') {
    return { kind: 'fluid', id: `#${json.fluidTag.replace(/^#/, '')}`, count: positive(json.fluidAmount, 1) };
  }
  return null;
}

// ————————————————————————— 主函数 —————————————————————————

/**
 * 把一条配方整理成「怎么画」的数据。
 *
 * @param {object} desc `describeRecipe()` 的返回（至少要有 kind / output / count / editable / reason）
 * @param {object} rawJson 配方在 jar 里的原始 JSON
 * @param {{itemName?: (id: string) => string}} [opts] 物品 ID → 中文名
 * @returns {object} layout
 */
export function layoutRecipe(desc, rawJson, opts = {}) {
  const d = desc && typeof desc === 'object' ? desc : {};
  const json = rawJson && typeof rawJson === 'object' ? rawJson : {};
  const nameOf = nameGetter(opts);

  const type = typeof json.type === 'string' ? json.type : String(d.type ?? '');
  const kind = d.kind || recipeKindOf(type);
  const machineKind = kind === 'machine' ? String(d.machineKind || type.replace(/^create:/, '')) : '';
  const info = machineKind ? MACHINE_TABLE[machineKind] : null;
  const machineName = machineKind ? (info?.name || machineKind) : '';
  const machineIcon = machineKind ? (info?.icon || '') : '';

  const notes = [];
  const blockers = [];

  // ---- 产物：主产物 + 副产物 + 总产出 ----
  const scanned = scanOutputs(json);
  let primary = { id: '', count: 0 };
  let extras = [];
  if (d.output) {
    primary = { id: String(d.output), count: positive(d.count, 1) };
    const rest = [...scanned];
    const at = rest.findIndex((o) => o.id === primary.id);
    if (at >= 0) rest.splice(at, 1);
    extras = rest;
  } else if (scanned.length) {
    primary = scanned[0];
    extras = scanned.slice(1);
  }
  const output = { id: primary.id, count: primary.count || 0, name: nameOf(primary.id) };
  const extraOutputs = extras.map((o) => ({ id: o.id, count: o.count, name: nameOf(o.id) }));
  const produceTotal = (output.id ? output.count : 0) + extraOutputs.reduce((sum, o) => sum + o.count, 0);
  if (extraOutputs.length) {
    notes.push(`这条配方有 ${extraOutputs.length + 1} 种产物，一次共出 ${produceTotal} 个`);
  }

  // ---- 图案（有序合成 / 机械合成器共用） ----
  const rawPattern = Array.isArray(json.pattern) ? json.pattern.map((s) => String(s)) : [];
  const pattern = rawPattern.length ? rawPattern : (Array.isArray(d.pattern) ? d.pattern.map((s) => String(s)) : []);
  const keyRaw =
    json.key && typeof json.key === 'object' && !Array.isArray(json.key)
      ? json.key
      : (d.keys && typeof d.keys === 'object' ? d.keys : {});

  /** 按图案画格子。返回 {grid, tagCount, unknownCount}。 */
  const gridFromPattern = () => {
    const rows = Math.max(pattern.length, 1);
    const cols = Math.max(widest(pattern), 1);
    const cells = [];
    let tagCount = 0;
    let unknownCount = 0;
    for (let row = 0; row < pattern.length; row += 1) {
      const line = pattern[row];
      for (let col = 0; col < line.length; col += 1) {
        const ch = line[col];
        // 空格和图案里用来占位的字符不算材料 —— 这正是「空格子被跳过」的由来
        if (!ch || ch === ' ') continue;
        const material = materialOf(keyRaw[ch] ?? d.keys?.[ch]);
        if (!material) {
          cells.push({ row, col, kind: 'unknown', id: '', count: 1, name: '看不懂的材料', slotCount: 1 });
          unknownCount += 1;
          continue;
        }
        if (material.kind === 'tag') tagCount += 1;
        if (material.kind === 'unknown') unknownCount += 1;
        cells.push({
          row,
          col,
          kind: material.kind,
          id: material.id,
          count: material.count,
          name: nameOf(material.id),
          slotCount: 1,
        });
      }
    }
    return { grid: { rows, cols, cells }, tagCount, unknownCount };
  };

  /** 把一串材料横排成一行（机器配方用）。 */
  const stripOf = (materials) => {
    const shown = materials.slice(0, MAX_MACHINE_COLS);
    const cells = shown.map((material, col) => ({
      row: 0,
      col,
      kind: material.kind,
      id: material.id,
      count: material.count,
      name: nameOf(material.id),
      slotCount: 1,
    }));
    return {
      rows: 1,
      cols: Math.max(shown.length, 1),
      cells,
      dropped: materials.length - shown.length,
    };
  };

  let grid = { rows: 3, cols: 3, cells: [] };
  let inputs = [];

  if (kind === 'shaped') {
    const built = gridFromPattern();
    grid = built.grid;
    if (pattern.length === 0) {
      blockers.push('这条配方没读到图案，界面上画不出格子');
    } else {
      notes.push(`这是 ${grid.rows}x${grid.cols} 的有序合成`);
    }
    if (built.tagCount) {
      blockers.push(`有 ${built.tagCount} 格用的是标签（例如任意一种木板都行），界面上改不了`);
      notes.push('带标签的格子表示「这类物品任意一种都可以」，不是某一个具体物品');
    }
    if (built.unknownCount) blockers.push('有格子里的材料看不懂，界面上改不了');
    inputs = dedupeInputs(built.grid.cells, nameOf);
  } else if (kind === 'shapeless') {
    const list = Array.isArray(json.ingredients) ? json.ingredients : null;
    const materials = list
      ? list.map(materialOf).filter(Boolean)
      : (Array.isArray(d.inputs) ? d.inputs.map((id) => materialOf(id)).filter(Boolean) : []);
    // 优先 3x3：装得下就九宫格；装不下才往右加列（3x4、3x5…），不往上堆成 4 行
    const cols = materials.length <= 9 ? 3 : Math.ceil(materials.length / 3);
    const rows = 3;
    const cells = materials.map((material, i) => ({
      row: Math.floor(i / cols),
      col: i % cols,
      kind: material.kind,
      id: material.id,
      count: material.count,
      name: nameOf(material.id),
      slotCount: 1,
    }));
    grid = { rows, cols, cells };
    const tagCount = materials.filter((m) => m.kind === 'tag').length;
    const unknownCount = materials.filter((m) => m.kind === 'unknown').length;
    if (tagCount) {
      blockers.push(`有 ${tagCount} 个材料用的是标签（例如任意一种木板都行），界面上改不了`);
      notes.push('带标签的材料表示「这类物品任意一种都可以」，不是某一个具体物品');
    }
    if (unknownCount) blockers.push('有材料列了多种可选物品或写法看不懂，界面上改不了');
    if (materials.length > 9) notes.push(`材料有 ${materials.length} 个，格子扩成了 ${rows}x${cols}`);
    if (materials.length === 0) blockers.push('这条配方没读到材料，界面上画不出格子');
    inputs = dedupeInputs(cells, nameOf);
  } else if (kind === 'machine') {
    const usesPattern = pattern.length > 0 && PATTERN_MACHINES.has(machineKind);
    if (usesPattern) {
      // 机械合成器：按图案真实宽高画，3x5 = 15 格 / 5x5 = 25 格都不压缩
      const built = gridFromPattern();
      grid = built.grid;
      notes.push(`机械合成器是任意格子布局，这里按 ${grid.rows}x${grid.cols} 画（不塞进 9 格）`);
      if (built.tagCount) {
        blockers.push(`有 ${built.tagCount} 格用的是标签（例如任意一种木板都行），界面上改不了`);
        notes.push('带标签的格子表示「这类物品任意一种都可以」，不是某一个具体物品');
      }
      if (built.unknownCount) blockers.push('有格子里的材料看不懂，界面上改不了');
    } else {
      const materials = Array.isArray(json.ingredients)
        ? json.ingredients.map(materialOf).filter(Boolean)
        : (Array.isArray(d.inputs) ? d.inputs.map((id) => materialOf(id)).filter(Boolean) : []);
      const fluid = fluidCellOf(json);
      if (fluid) materials.push(fluid);
      const strip = stripOf(materials);
      grid = { rows: 1, cols: strip.cols, cells: strip.cells };
      if (strip.dropped > 0) notes.push(`材料有 ${materials.length} 种，界面只画前 ${MAX_MACHINE_COLS} 种`);
      const tagCount = materials.filter((m) => m.kind === 'tag').length;
      if (tagCount) {
        blockers.push(`材料里有标签（${tagCount} 个，任意一种都行），界面上改不了`);
        notes.push('带标签的材料表示「这类物品任意一种都可以」，不是某一个具体物品');
      }
      if (materials.length === 0) blockers.push('这条机器配方没读到材料，界面上画不出格子');
    }
    if (machineKind === 'mixing') notes.push('搅拌盆要配一个机械搅拌器（create:mechanical_mixer）才能用');
    if (!info && machineKind) notes.push(`不认识的机器类型 ${machineKind}，图标先用占位方块`);
    inputs = dedupeInputs(grid.cells, nameOf);
  } else {
    // 熔炉、切石机、村民交易……画不出格子但仍可以给个「材料 → 产物」的横排。
    // 注意 `ingredient` 可能是单个对象（熔炉就是），不是数组 —— 别只判 isArray，
    // 否则熔炉的材料会静默消失，界面上只剩一个箭头和一个产物。
    const materials = Array.isArray(json.ingredients)
      ? json.ingredients.map(materialOf).filter(Boolean)
      : [materialOf(json.ingredient)].filter(Boolean);
    const strip = stripOf(materials);
    grid = { rows: 1, cols: strip.cols, cells: strip.cells };
    inputs = dedupeInputs(grid.cells, nameOf);
    notes.push(`这种配方（${type || '未知类型'}）不是格子合成，只能横排显示材料`);
  }

  // ---- 能不能改 ----
  // 沿用 describeRecipe 的判断：它能改我们才说能改；它说不能改就把原因原样带上。
  if (!d.editable) blockers.unshift(String(d.reason || '界面暂时改不了这条配方'));
  const editable = Boolean(d.editable) && blockers.length === 0;

  const rows = Math.max(Number(grid.rows) || 0, 0);
  const cols = Math.max(Number(grid.cols) || 0, 0);

  return {
    kind,
    machineKind,
    machineName,
    machineIcon,
    output,
    extraOutputs,
    grid: {
      rows,
      cols,
      cells: grid.cells.map((cell) => ({
        row: cell.row,
        col: cell.col,
        kind: cell.kind,
        id: cell.id,
        count: cell.count,
        name: cell.name,
        slotCount: cell.slotCount ?? 1,
      })),
    },
    inputs,
    pattern: [...pattern],
    // keys 拍平成「字符 → 物品 ID」，和 describeRecipe 的 keys 同一种形状。
    // 原始 JSON 里是 `{A: {item: 'x'}}` 这种嵌套写法，直接原样吐给界面的话，
    // 每个调用方都得自己再拆一层 —— 这里统一拆好，标签写成 `#tag`。
    keys: flatKeys(keyRaw),
    blockers: dedupeStrings(blockers),
    notes: dedupeStrings(notes),
    editable,
    gridSize: rows && cols ? `${rows}x${cols}` : '',
    produceTotal,
  };
}

/** 图案字符映射拍平：`{A:{item:'x'}}` → `{A:'x'}`，标签写成 `#tag`，认不出的跳过。 */
function flatKeys(keyRaw) {
  const out = {};
  if (!keyRaw || typeof keyRaw !== 'object' || Array.isArray(keyRaw)) return out;
  for (const [ch, value] of Object.entries(keyRaw)) {
    const material = materialOf(value);
    if (!material || !material.id) continue;
    out[String(ch)] = material.id;
  }
  return out;
}

/** 去重后的材料清单（有序配方也保留一份，方便界面做「材料：…」这种一行摘要）。 */
function dedupeInputs(cells, nameOf) {
  const seen = new Set();
  const out = [];
  for (const cell of cells) {
    if (!cell.id) continue;
    const key = `${cell.kind}:${cell.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: cell.id, count: cell.count, name: nameOf(cell.id), kind: cell.kind });
  }
  return out;
}

/** 字符串数组去重，顺序保持原样（界面按这个顺序显示原因）。 */
function dedupeStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = String(item ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}
