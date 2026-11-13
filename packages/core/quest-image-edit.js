/**
 * 任务书「装饰图」（章节的 images）的算与写：加一张、挪一张、改大小、删一张。
 *
 * 为什么单独开一个文件：改任务坐标有 `quest-move.js`，改任务节点有 `quest-node.js`，
 * 但章节画布上那些**背景图 / 箭头 / 装饰贴图**一直只能读不能改（2026-11-02 用户提出）。
 * 它们是章节根上的 `images: [{ image: "ns:path", x, y, width, height, rotation }]`，
 * 和任务列表完全是两套数据，混进 quest-node 会让那两个函数变难读。
 *
 * 三条硬规矩（和别的写操作一致）：
 * 1. **字段级 span 编辑**，不整体重写 images。FTB 自己会把键按字母序排、给数字加 `d` 后缀，
 *    整体重写等于把别人的排版和未知键全抹掉；只改真正变的那个数字，diff 才只显示那几个字符。
 * 2. **plan 只算不写**，commit 才落盘，写完立刻重读 + 体检，出现新错误整体回滚。
 * 3. 算完先在内存里 parseSnbt 复核一遍「装饰图列表跟预期是否一致」，对不上就不写。
 *
 * 坐标单位跟任务格子一致（一个任务占一格）：x/y 走半格吸附；
 * 宽高不吸附 —— 用户填 21.36 就是 21.36（FTB 原始文件里本来就带小数）。
 */
import path from 'node:path';

import { McError } from './errors.js';
import { loadQuests } from './quests.js';
import { findChapter, newErrorsOf, restoreFiles, writeFiles } from './quest-create.js';
import { applyEdits, formatLike, parseSnbt, parseSpans } from './snbt.js';
import { snapCoord } from './quest-move.js';

/**
 * 贴图资源 ID：`ns:path`，比如 `ftbquests:textures/end_flower_forest.png`。
 * 只认小写（Minecraft 的资源 ID 本来就全小写）—— 大写写进去游戏里认不出来，还不报错。
 */
const IMAGE_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** 一张装饰图最多能有多大（格）。手滑多打两个 0 时先在这里挡住，别把画布撑到看不见。 */
const MAX_SIZE = 200;

/** 一个章节最多挂多少张装饰图。 */
const MAX_IMAGES = 200;

/** 装饰图的字段顺序：跟 FTB 自己写出来的字母序一致，diff 才干净。 */
const IMAGE_KEYS = ['height', 'image', 'rotation', 'width', 'x', 'y'];

const NUM_KEYS = ['x', 'y', 'width', 'height', 'rotation'];

// --------------------------------------------------------------- 小工具

/** 去掉浮点尾巴（0.1+0.2 那种），保留两位小数。 */
function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** 数字 → FTB 的写法：整数补 `.0`，`21.36` 照写（后面统一补 `d`）。 */
function floatText(value) {
  const n = round2(value);
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/** 给人看的坐标/尺寸：`2.5`、`21.36`，整数不补小数位。 */
function plain(value) {
  const n = round2(value);
  return Number.isInteger(n) ? String(n) : String(n);
}

/** 一个装饰图写成人话：`ns:path.png (2, 3)，10×6 格`。 */
function specText(spec) {
  return `${spec.image} (${plain(spec.x)}, ${plain(spec.y)})，${plain(spec.width)}×${plain(spec.height)} 格`
    + (spec.rotation ? `，转了 ${plain(spec.rotation)}°` : '');
}

/** parseSpans 的 compound 节点 → 某个键的值（没有就 undefined）。 */
function valueOf(node, key) {
  return node?.entries?.get(key)?.node?.value;
}

/** 行首到 pos 之间如果全是空白，返回那段空白（缩进）；否则返回 null。 */
function indentAt(source, pos) {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const text = source.slice(lineStart, pos);
  return /^[\t ]*$/.test(text) ? text : null;
}

/**
 * 包含 pos 的那一行**行首有多少空白**（不管 pos 前面还写了什么）。
 *
 * 跟 indentAt 的区别：`\timages: [` 这种写法里，`[` 前面是 `\timages: ` 而不是纯空白，
 * indentAt 会返回 null；但收尾的 `]` 该对齐的正是那一行的行首缩进 \t。
 */
function lineIndent(source, pos) {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const line = source.slice(lineStart, pos);
  const m = /^[\t ]*/.exec(line);
  return m ? m[0] : '';
}

/**
 * 一个 file 里的 image compound 算不算「有效的装饰图」。
 * **必须和 `quests.js` loadQuests 的过滤规则一模一样**（空图、宽高为 0 的丢掉），
 * 否则界面上的「第 N 张」和文件里的「第 N 个」会对不上，删错图。
 */
function validImage(item) {
  if (!item || item.kind !== 'compound') return null;
  const im = {
    image: String(valueOf(item, 'image') ?? ''),
    x: Number(valueOf(item, 'x') ?? 0) || 0,
    y: Number(valueOf(item, 'y') ?? 0) || 0,
    width: Number(valueOf(item, 'width') ?? 0) || 0,
    height: Number(valueOf(item, 'height') ?? 0) || 0,
    rotation: Number(valueOf(item, 'rotation') ?? 0) || 0,
  };
  return im.image && im.width > 0 && im.height > 0 ? im : null;
}

// --------------------------------------------------------------- 读

/**
 * 从章节源码里读出装饰图列表（顺序 = 文件里的顺序，已过滤掉无效项）。
 * @returns {{list: Array<object>, listNode: object|null, items: Array<object>, indexes: number[]}}
 *   items 是文件里原始 compound 节点，indexes[i] 是第 i 张有效图在 items 里的下标
 */
function readImages(source, label) {
  const root = parseSpans(source, label);
  const listNode = root.entries.get('images')?.node ?? null;
  if (!listNode) return { root, listNode: null, list: [], items: [], indexes: [] };
  if (listNode.kind !== 'list') {
    throw new McError(
      `${label} 里的 images 不是列表`,
      'FTB 的装饰图字段应该是 images: [ { image: "ns:path", x, y, width, height } ]',
      'QuestImageBadShape',
    );
  }
  const list = [];
  const items = [];
  const indexes = [];
  for (const [i, item] of listNode.items.entries()) {
    const im = validImage(item);
    if (!im) continue;
    list.push(im);
    items.push(item);
    indexes.push(i);
  }
  return { root, listNode, list, items, indexes };
}

// --------------------------------------------------------------- 写（片段）

/** 一张装饰图排成多行块，缩进跟着文件走。数字一律带 `d` 后缀（FTB 自己就这么写）。 */
function imageBlock(spec, baseIndent, nl) {
  const inner = `${baseIndent}\t`;
  const lines = IMAGE_KEYS.map((key) => {
    const value = key === 'image' ? JSON.stringify(spec.image) : `${floatText(spec[key])}d`;
    return `${inner}${key}: ${value}`;
  });
  return `{${nl}${lines.join(nl)}${nl}${baseIndent}}`;
}

/** 单行写法：文件原来就是一行时跟着它，别凭空拆成多行。 */
function imageInline(spec) {
  const body = IMAGE_KEYS.map((key) => {
    const value = key === 'image' ? JSON.stringify(spec.image) : `${floatText(spec[key])}d`;
    return `${key}: ${value}`;
  });
  return `{ ${body.join(', ')} }`;
}

/**
 * 往 images 列表末尾追加一张。三种排版各走各的：空列表 `[ ]`、多行块、一行压缩。
 */
function appendImageEdit(source, listNode, spec) {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const closeStart = listNode.end - 1; // ']' 的位置
  const items = listNode.items;
  // 列表缩进要取「这一行的行首缩进」，不能用 indentAt：`[` 前面是 `\timages: `，
  // indentAt 会因为不是纯空白而返回 null，回退成空串后收尾的 `]` 就会掉缩进。
  const listIndent = lineIndent(source, listNode.start);

  if (!items.length) {
    const itemIndent = `${listIndent}\t`;
    const text = `${nl}${itemIndent}${imageBlock(spec, itemIndent, nl)}${nl}${listIndent}`;
    return { start: listNode.start + 1, end: closeStart, text };
  }

  const last = items[items.length - 1];
  const tail = source.slice(last.end, closeStart);
  if (tail.includes('\n')) {
    const itemIndent = indentAt(source, last.start) ?? `${listIndent}\t`;
    const text = `,${nl}${itemIndent}${imageBlock(spec, itemIndent, nl)}${nl}${listIndent}`;
    return { start: last.end, end: closeStart, text };
  }
  return { start: last.end, end: closeStart, text: `, ${imageInline(spec)}` };
}

/**
 * 删掉列表里第 index 个元素（连逗号一起收拾干净）。
 *
 * 区间算法跟 `quests.js:441 removeQuest` 同源，但那函数是删任务列表里的元素，
 * 参数和错误文案都是任务口径，不能直接复用（也不该去改它，那是已经稳定跑着的代码）。
 */
function removeItemEdit(source, listNode, index) {
  const items = listNode.items;
  const item = items[index];
  const prev = index > 0 ? items[index - 1] : null;
  const next = index + 1 < items.length ? items[index + 1] : null;

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

  // 末元素后面还挂着逗号（手写文件偶尔有），一并吃掉，别留下 `}, ]`
  if (!next) {
    const tail = source.slice(end, listNode.end - 1);
    const comma = tail.indexOf(',');
    if (comma >= 0 && !tail.slice(0, comma).trim()) end += comma + 1;
  }
  return { start, end, text: '' };
}

/** 改某项的若干字段：已有的键走 span 替换（formatLike 保住 `d` 后缀），缺的键补进去。 */
function patchImageEdits(source, itemNode, fields) {
  const edits = [];
  const additions = [];
  for (const [key, value] of Object.entries(fields)) {
    const entry = itemNode.entries.get(key);
    if (!entry) {
      additions.push([key, value]);
      continue;
    }
    const original = source.slice(entry.node.start, entry.node.end);
    // 缺 `d` 后缀但值确实是个小数型字段时，formatLike 会退回 formatLiteral（写 `3` 而不是 `3.0d`），
    // 所以这里对数字字段自己做一次兜底
    const text = NUM_KEYS.includes(key) ? `${floatText(value)}d` : formatLike(original, value);
    edits.push({ start: entry.node.start, end: entry.node.end, text });
  }
  if (additions.length) edits.push(insertKeysEdit(source, itemNode, additions));
  return edits;
}

/**
 * 往 compound 里插几个键（值按装饰图口径写，数字带 `d`）。
 * 为什么不用 snbt.js 的 insertionEdit：它用 formatLiteral，数字会写成 `3` 而不是 `3.0d`，
 * FTB 里坐标/宽高是 double，缺后缀会被当成 int，读进游戏可能直接报类型错。
 */
function insertKeysEdit(source, node, pairs) {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const text = (key, value) => (key === 'image' ? JSON.stringify(value) : `${floatText(value)}d`);

  const closeLineStart = source.lastIndexOf('\n', node.closeStart - 1) + 1;
  const closeIndent = source.slice(closeLineStart, node.closeStart);
  const onOwnLine = /^[\t ]*$/.test(closeIndent);

  if (!onOwnLine) {
    // 一行写完的 compound（`{ height: 1.0d, ... }`）：贴在 `}` 前面补，注意逗号
    const body = source.slice(0, node.closeStart).replace(/[\t ]+$/, '');
    const needComma = !/[{,]$/.test(body);
    const inline = pairs.map(([k, v]) => `${k}: ${text(k, v)}`).join(', ');
    const at = body.length;
    return { start: at, end: at, text: `${needComma ? ', ' : ' '}${inline} ` };
  }

  const firstEntry = node.entries.values().next().value;
  let indent = '';
  if (firstEntry) {
    const lineStart = source.lastIndexOf('\n', firstEntry.key.start - 1) + 1;
    indent = source.slice(lineStart, firstEntry.key.start);
  }
  if (!/^[\t ]*$/.test(indent)) indent = `${closeIndent}\t`;
  const bodyText = pairs.map(([k, v]) => `${indent}${k}: ${text(k, v)}`).join(nl);
  return { start: closeLineStart, end: closeLineStart, text: `${bodyText}${nl}` };
}

/**
 * 整章还没有 images 这个键时，插一个进去。
 * 位置按字母序找「第一个比 images 大的键」，插在它前面 —— 和 FTB 自己的键序一致。
 */
function insertImagesKeyEdit(source, root, spec) {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const all = [...root.entries.values()];
  const closeLineStart = source.lastIndexOf('\n', root.closeStart - 1) + 1;
  const closeIndent = source.slice(closeLineStart, root.closeStart);
  const onOwnLine = /^[\t ]*$/.test(closeIndent);

  let indent = '';
  if (all.length) {
    const lineStart = source.lastIndexOf('\n', all[0].key.start - 1) + 1;
    indent = source.slice(lineStart, all[0].key.start);
  }
  if (!/^[\t ]*$/.test(indent)) indent = `${onOwnLine ? closeIndent : ''}\t`;

  const itemIndent = `${indent}\t`;
  const block = `images: [${nl}${itemIndent}${imageBlock(spec, itemIndent, nl)}${nl}${indent}]`;

  const later = all.find((e) => e.key.value > 'images');
  if (later && onOwnLine) {
    const lineStart = source.lastIndexOf('\n', later.key.start - 1) + 1;
    return { start: lineStart, end: lineStart, text: `${indent}${block}${nl}` };
  }
  // 一行写完的章节根（少见）或没有比它大的键：贴在 `}` 前面
  const body = source.slice(0, root.closeStart).replace(/[\t ]+$/, '');
  const needComma = !/[{,]$/.test(body);
  const at = body.length;
  const oneLine = `[${imageInline(spec)}]`;
  return { start: at, end: at, text: `${needComma ? ', ' : ' '}images: ${oneLine} ` };
}

// --------------------------------------------------------------- 输入规范化

/** 把界面 / 模型给的一张装饰图收拾成标准形状。宽高必填 —— 宽高为 0 的图在游戏里等于不存在。 */
function normalizeSpec(input, { partial = false } = {}) {
  const out = {};
  const rawImage = input?.image === undefined || input?.image === null ? '' : String(input.image).trim();
  if (rawImage) {
    if (!IMAGE_ID_RE.test(rawImage)) {
      throw new McError(
        `贴图路径不像个资源 ID：${rawImage}`,
        '形如 ftbquests:textures/end_flower_forest.png（小写、带命名空间冒号、带 .png）',
        'QuestBadImageId',
      );
    }
    out.image = rawImage;
  } else if (!partial) {
    throw new McError(
      '没给要挂的贴图',
      '给一张贴图路径，形如 minecraft:textures/block/stone.png',
      'QuestNoImage',
    );
  }

  for (const key of ['x', 'y']) {
    const blank = input?.[key] === undefined || input?.[key] === null || input?.[key] === '';
    if (blank) {
      if (partial) continue;
      out[key] = 0;
      continue;
    }
    const v = snapCoord(input[key]);
    if (v === null) {
      throw new McError(`${key} 不是数字：${input[key]}`, 'x / y 是格子坐标，可以是小数（会吸附到 0.5）', 'QuestBadImageCoord');
    }
    out[key] = v;
  }

  for (const key of ['width', 'height']) {
    const blank = input?.[key] === undefined || input?.[key] === null || input?.[key] === '';
    if (blank) {
      if (partial) continue;
      throw new McError(
        `没给装饰图的${key === 'width' ? '宽' : '高'}`,
        '1 = 一个任务格子那么大。背景图常见 10～25，小图标 1～2',
        'QuestNoImageSize',
      );
    }
    const v = round2(input[key]);
    if (!Number.isFinite(v) || v <= 0) {
      throw new McError(
        `装饰图的${key === 'width' ? '宽' : '高'}必须是正数：${input[key]}`,
        '1 = 一个任务格子那么大',
        'QuestBadImageSize',
      );
    }
    if (v > MAX_SIZE) {
      throw new McError(
        `装饰图太大了：${key === 'width' ? '宽' : '高'} ${v} 格（上限 ${MAX_SIZE}）`,
        '1 = 一个任务格子那么大，整个画布一般也就几十格；确实要这么大就分几张拼',
        'QuestBadImageSize',
      );
    }
    out[key] = v;
  }

  const rotBlank = input?.rotation === undefined || input?.rotation === null || input?.rotation === '';
  if (rotBlank) {
    if (!partial) out.rotation = 0;
  } else {
    const v = round2(input.rotation);
    if (!Number.isFinite(v)) {
      throw new McError(`rotation 不是数字：${input.rotation}`, '角度，0 就是不旋转', 'QuestBadImageCoord');
    }
    out.rotation = v;
  }
  return out;
}

/** 界面和工具都可能把 index 传成字符串。 */
function parseIndex(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new McError(`装饰图序号不对：${value}`, '给 0 开始的整数（第几张）', 'QuestBadImageIndex');
  }
  return n;
}

// --------------------------------------------------------------- 计划

/** 空计划（值本来就一样）：不写盘，界面显示「没有任何改动」。 */
function emptyPlan({ chapter, store, action }) {
  return {
    kind: 'image',
    action,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    chapterFile: chapter.file,
    changedCount: 0,
    changes: [],
    diff: [],
    warnings: [],
    files: [],
    writes: [],
    locale: store.locale,
  };
}

/**
 * 算一份「加 / 挪 / 删装饰图」的计划。不写盘。
 *
 * @param {object} args
 * @param {string} args.questDir
 * @param {object} args.store       loadQuests 的结果
 * @param {string} args.chapter     章节 ID / 标题 / 文件名，三者认一个
 * @param {'add'|'move'|'remove'} args.action
 * @param {number} [args.index]     move / remove 要改第几张（0 开始，按画布上的顺序）
 * @param {string} [args.image]     add 必填；move 时给了就是「顺便换图」
 * @param {number} [args.x] @param {number} [args.y]
 * @param {number} [args.width] @param {number} [args.height] @param {number} [args.rotation]
 */
export function planImageEdit({ questDir, store, chapter: chapterKey, action, ...input }) {
  const act = String(action ?? '').trim() || 'add';
  if (!['add', 'move', 'remove'].includes(act)) {
    throw new McError(`不认识的装饰图操作：${act}`, '只能是 add / move / remove', 'QuestBadImageAction');
  }

  const chapter = findChapter(store, chapterKey)
    // 顺手容忍把文件名连 `.snbt` 一起传进来（findChapter 只认去掉后缀的）
    ?? findChapter(store, String(chapterKey ?? '').replace(/\.snbt$/i, ''));
  if (!chapter) {
    throw new McError(
      `这本书里没有章节「${chapterKey ?? ''}」`,
      '先刷新一下画布，或者用章节 ID / 文件名（不带 .snbt）再试',
      'QuestNoChapter',
    );
  }

  const rel = `chapters/${chapter.file}`;
  const { root, listNode, list, items, indexes } = readImages(chapter.source, rel);

  // 画布上看到的那份和文件里解析出来的必须一模一样，否则「第 3 张」会指错图
  if (chapter.images.length !== list.length) {
    throw new McError(
      `章节「${chapter.title}」的装饰图对不上（画布 ${chapter.images.length} 张，文件 ${list.length} 张）`,
      '先刷新一下任务书（重读），这是缓存和文件不同步',
      'QuestImageStale',
    );
  }

  const changes = [];
  const diff = [];
  const warnings = [];
  let expected;
  let edits = [];

  if (act === 'add') {
    if (list.length >= MAX_IMAGES) {
      throw new McError(
        `这个章节已经有 ${list.length} 张装饰图了（上限 ${MAX_IMAGES}）`,
        '先删掉不用的，或者把装饰图挪到别的章节',
        'QuestImageTooMany',
      );
    }
    const spec = normalizeSpec(input);
    if (list.some((im) => im.image === spec.image)) {
      warnings.push(`这张贴图本章已经有了，会再叠一张 —— 想挪的话请拖原来那张`);
    }
    edits = listNode
      ? [appendImageEdit(chapter.source, listNode, spec)]
      : [insertImagesKeyEdit(chapter.source, root, spec)];
    changes.push({
      field: 'images',
      label: '装饰图',
      before: `${list.length} 张`,
      after: `${list.length + 1} 张`,
    });
    diff.push(`新增装饰图：${specText(spec)}`);
    expected = [...list, spec];
  } else {
    const index = parseIndex(input.index ?? input.imageIndex);
    if (index === null) {
      throw new McError('没说是第几张装饰图', '给 index（0 开始，按画布上看到的顺序）', 'QuestBadImageIndex');
    }
    if (!listNode || index >= list.length) {
      throw new McError(
        `章节「${chapter.title}」只有 ${list.length} 张装饰图，没有第 ${index + 1} 张`,
        '先刷新一下画布，可能这张刚被别处删了',
        'QuestImageNotFound',
      );
    }
    const target = list[index];

    if (act === 'remove') {
      edits = [removeItemEdit(chapter.source, listNode, indexes[index])];
      changes.push({
        field: 'images',
        label: '装饰图',
        before: `${list.length} 张`,
        after: `${list.length - 1} 张`,
      });
      diff.push(`删掉第 ${index + 1} 张装饰图：${specText(target)}`);
      expected = list.filter((_, i) => i !== index);
    } else {
      // move：只认真正变了的字段。空字段 = 不改（不是「清零」）
      const patch = normalizeSpec(input, { partial: true });
      const fields = {};
      for (const key of ['x', 'y', 'width', 'height', 'rotation', 'image']) {
        if (patch[key] === undefined || patch[key] === target[key]) continue;
        fields[key] = patch[key];
      }
      if (!Object.keys(fields).length) return emptyPlan({ chapter, store, action: act });

      edits = patchImageEdits(chapter.source, items[index], fields);
      if (fields.x !== undefined || fields.y !== undefined) {
        diff.push(
          `第 ${index + 1} 张挪位置：(${plain(target.x)}, ${plain(target.y)}) → `
          + `(${plain(fields.x ?? target.x)}, ${plain(fields.y ?? target.y)})`,
        );
      }
      if (fields.width !== undefined || fields.height !== undefined) {
        diff.push(
          `第 ${index + 1} 张改大小：${plain(target.width)}×${plain(target.height)} → `
          + `${plain(fields.width ?? target.width)}×${plain(fields.height ?? target.height)} 格`,
        );
      }
      if (fields.rotation !== undefined) {
        diff.push(`第 ${index + 1} 张旋转：${plain(target.rotation)}° → ${plain(fields.rotation)}°`);
      }
      if (fields.image !== undefined) {
        diff.push(`第 ${index + 1} 张换图：${target.image} → ${fields.image}`);
      }
      const after = { ...target, ...fields };
      changes.push({
        field: 'images',
        label: '装饰图',
        before: specText(target),
        after: specText(after),
      });
      expected = list.map((im, i) => (i === index ? after : im));
    }
  }

  return finish({ chapter, store, action: act, edits, expected, changes, diff, warnings });
}

/**
 * 把算好的编辑套上去、复核、装成计划。
 *
 * 「复核」这一步是这里最不能省的：SNBT 的列表元素之间靠逗号分隔，
 * 少一个/多一个都还是「长得像」的文件，但游戏里整章会读不出来。
 * 所以算完先 parse 一次，再把装饰图列表跟预期逐张对一遍，对不上就当这次没算过。
 */
function finish({ chapter, store, action, edits, expected, changes, diff, warnings }) {
  let out;
  try {
    out = applyEdits(chapter.source, edits);
  } catch (e) {
    throw new McError(`拼不出改完的文件：${e.message}`, '这是软件自身的 bug，什么都没写', 'QuestImageRejected');
  }

  const rel = `chapters/${chapter.file}`;
  try {
    parseSnbt(out, `${rel}(装饰图校验)`);
  } catch (e) {
    throw new McError(
      `改完的章节文件读不出来了，这次没有写：${e.message}`,
      '这是软件自身的 bug，什么都没写；请把这句话反馈给开发者',
      'QuestImageRejected',
    );
  }

  const { list: after } = readImages(out, rel);
  if (after.length !== expected.length) {
    throw new McError(
      `改完数了数，装饰图应该有 ${expected.length} 张，实际 ${after.length} 张，这次没有写`,
      '这是软件自身的 bug；请把这句话反馈给开发者',
      'QuestImageRejected',
    );
  }
  for (const [i, want] of expected.entries()) {
    const got = after[i];
    const bad = ['image', 'x', 'y', 'width', 'height', 'rotation'].filter((k) => got[k] !== want[k]);
    if (bad.length) {
      throw new McError(
        `改完第 ${i + 1} 张装饰图跟预期对不上（${bad.join('/')}），这次没有写`,
        '这是软件自身的 bug；请把这句话反馈给开发者',
        'QuestImageRejected',
      );
    }
  }

  const writes = out === chapter.source ? [] : [{ file: chapter.path, content: out }];
  const changed = writes.length > 0;
  return {
    kind: 'image',
    action,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    chapterFile: chapter.file,
    changedCount: changed ? changes.length : 0,
    changes: changed ? changes : [],
    diff: changed ? diff : [],
    warnings,
    files: writes.map((w) => ({
      name: path.basename(w.file),
      path: w.file,
      bytes: Buffer.byteLength(w.content, 'utf8'),
    })),
    writes,
    locale: store.locale,
  };
}

// --------------------------------------------------------------- 提交

/**
 * 真写盘 + 立刻复查。写完读不回来、或者体检出现新错误，就把这次写的文件整体还原。
 *
 * 注意：装饰图不在 lintQuests 的检查范围里（它只看任务和章节编号），所以
 * 「新错误」主要来自文件被写坏 —— 那种情况 loadQuests 会直接抛。
 */
export function commitImagePlan({ plan, questDir, store }) {
  if (!plan.writes.length) {
    return { backups: [], lines: ['装饰图没变，什么都没写'] };
  }
  const { backups, done } = writeFiles(plan.writes);

  let after;
  try {
    after = loadQuests(questDir, { locale: plan.locale });
  } catch (e) {
    restoreFiles(done);
    throw new McError(`写完读不回来了：${e.message}`, '已回滚，原文件没变', 'QuestBrokenAfterWrite');
  }
  const newErrors = newErrorsOf(store, after);
  if (newErrors.length) {
    restoreFiles(done);
    const detail = newErrors.slice(0, 3).map((e) => `${e.where}：${e.message}`).join('；');
    throw new McError('这次改动会让任务书出问题，已全部回滚', detail, 'QuestImageRejected');
  }

  const chapter = after.chapters.find((c) => c.file === plan.chapterFile);
  const count = chapter?.images?.length ?? 0;
  const verb = plan.action === 'add' ? '加' : (plan.action === 'remove' ? '删' : '改');
  return {
    backups,
    after,
    lines: [
      `已${verb}装饰图（章节「${plan.chapterTitle}」），现在这一章有 ${count} 张`
        + (backups.length ? `，备份：${backups.join('、')}` : ''),
      `复查：${after.chapters.length} 个章节 / ${after.quests.length} 个任务，0 个新错误，正常`,
    ],
  };
}

/** 把计划说成给人看的一串话（面板和工具共用）。 */
export function describeImagePlan(plan, { apply = false } = {}) {
  const mode = apply ? '模式：真正写盘' : '模式：演练（不写盘）';
  const head = `章节：${plan.chapterTitle}（${plan.chapterId}）`;
  if (!plan.changedCount) {
    return [head, mode, '装饰图没有任何改动（值本来就一样）。'];
  }
  const lines = [head, mode, ...plan.diff];
  if (plan.files.length) lines.push(`会写：${plan.files.map((f) => f.name).join('、')}`);
  for (const w of plan.warnings) lines.push(`注意：${w}`);
  return lines;
}
