/**
 * 合成表的渲染层：把 `layoutRecipe()` 算出来的布局画成 JEI 那种样子。
 *
 * 为什么单独一个文件：`packages/ui/app.js` 现在几千行，再往里塞一套格子渲染
 * 会让它更难读；而且合成表这种东西是「给我数据我就画」的无状态组件，
 * 拆出来既能被 app.js 用，也能被将来的独立页面用。
 *
 * 三条自我约束：
 *   1. **不引入任何框架、不加构建步骤**。全是普通函数 + `document.createElement`。
 *   2. **不用 innerHTML**。物品 ID 是外面传进来的字符串，拼 HTML 迟早被转义问题咬。
 *   3. **不发任何请求**。图标从 `opts.iconUrl(id)` 里拿，调用方自己决定去哪儿要图；
 *      没给就画一个占位方块 + 物品 ID 文字，绝不显示空白 —— 空白会让人以为坏了。
 *
 * 机器配方（Create）走的是另一条分支：机器图标在中间、材料横排在左、产物在右，
 * 就是用户说的「流程图样子的合成」。
 */

// --------------------------------------------------------------- 造节点的小工具

/**
 * 造一个 DOM 元素。
 *
 * 这是 `packages/ui/app.js` 里 `el()` 的精简复制版 —— app.js 的 `el` 是模块私有的，
 * 不同模块之间不共享，所以这里自带一份，不 import（app.js 也没导出它）。
 * 保持和原版同一套规则：`on` 开头的是事件、`class` 写 className、`text` 写 textContent、
 * 能直接赋值的属性才赋值（`node.style = '...'` 这种），其余走 setAttribute。
 *
 * @param {string} tag
 * @param {object} [props]
 * @param {...unknown} kids
 * @returns {object} DOM 节点
 */
function elEl(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'title') {
      // title 走 setAttribute：有些元素把它当只读属性，直接赋值会静默丢掉悬停提示
      node.setAttribute('title', String(value));
    } else if (key in node && key !== 'list') {
      // style 也走这条：浏览器里 `node.style = '...'` 等价于写 cssText（PutForwards），
      // 测试替身里 style 就是普通字符串，两边都能用
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendKids(node, kids);
  return node;
}

/** 把子节点挂上去：字符串变成文本节点，空值直接跳过（方便写 `cond ? x : null`）。 */
function appendKids(node, kids) {
  for (const kid of kids.flat(6)) {
    if (kid === null || kid === undefined || kid === false || kid === '') continue;
    // 对象一律当成节点（这里只可能传节点或字符串）；不能用 `instanceof Node`，
    // 因为测试用的 DOM 替身不是继承自真 Node，那样判断会把节点当字符串拼成 [object Object]
    if (typeof kid === 'object') {
      node.append(kid);
      continue;
    }
    node.append(document.createTextNode(String(kid)));
  }
}

/** 名字太长就截断（格子里放不下整串）。 */
function shortName(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 一格显示什么字：有中文名用中文名，没有就退回物品 ID 的最后一段。 */
function labelOf(cell) {
  if (cell?.name) return String(cell.name);
  const id = String(cell?.id ?? '');
  if (!id) return '';
  const tail = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return tail.replace(/_/g, ' ');
}

// --------------------------------------------------------------- 图标

/**
 * 一个图标节点。
 *
 * @param {object} item `{id, name, count}` 或格子 `{id, name, kind}`
 * @param {object} opts 带 iconUrl 的选项
 * @param {number} size 像素
 * @returns {object} DOM 节点
 */
function iconNode(item, opts, size) {
  const id = String(item?.id ?? '');
  const url = id && typeof opts.iconUrl === 'function' ? safeIconUrl(opts.iconUrl, id) : '';
  if (url) {
    return elEl('img', {
      class: 'mcs-rv-icon',
      src: url,
      width: size,
      height: size,
      alt: '',
      draggable: 'false',
    });
  }
  // 占位：一个方块 + 首字母，比空白更让人踏实
  const label = labelOf(item);
  return elEl(
    'span',
    {
      class: 'mcs-rv-icon-ph',
      style: `width:${size}px;height:${size}px`,
      title: id || label,
    },
    elEl('span', { class: 'mcs-rv-icon-ph-t', text: shortName(label || '?', 3) }),
  );
}

/** 调 iconUrl 时兜住异常：一张图取不到不该让整块合成表画不出来。 */
function safeIconUrl(fn, id) {
  try {
    const url = fn(id);
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

// --------------------------------------------------------------- 格子

/** 格子里的那个物品图标 + 数量角标。 */
function cellInner(cell, opts, size) {
  const kids = [iconNode(cell, opts, size)];
  const count = Number(cell?.count) || 0;
  if (count > 1) kids.push(elEl('span', { class: 'mcs-rv-count', text: `×${count}` }));
  if (cell?.kind === 'tag') kids.push(elEl('span', { class: 'mcs-rv-tag', text: '#' }));
  if (cell?.kind === 'fluid') kids.push(elEl('span', { class: 'mcs-rv-tag', text: '液' }));
  return kids;
}

/**
 * 画一块格子区。
 *
 * 空格子也要占位（`.mcs-rv-cell-empty` 的暗色凹槽），所以按 rows×cols 铺满，
 * 再把有物品的格子按 `{row, col}` 塞进对应位置。这样 3x5 的机械合成器
 * 和图里那个凹槽形状就是游戏里真正的样子。
 *
 * @param {object} grid `layout.grid`
 * @param {object} opts
 * @param {number} size 单格像素
 * @returns {object} DOM 节点
 */
function gridNode(grid, opts, size) {
  const rows = Math.max(Number(grid?.rows) || 1, 1);
  const cols = Math.max(Number(grid?.cols) || 1, 1);
  const filled = new Map();
  for (const cell of grid?.cells ?? []) {
    const row = Number(cell?.row);
    const col = Number(cell?.col);
    if (!Number.isFinite(row) || !Number.isFinite(col)) continue;
    filled.set(`${row},${col}`, cell);
  }

  const node = elEl('div', {
    class: 'mcs-rv-grid',
    style: `grid-template-columns:repeat(${cols},${size}px);grid-template-rows:repeat(${rows},${size}px);--rv-cell:${size}px`,
    'data-rows': rows,
    'data-cols': cols,
  });
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cell = filled.get(`${row},${col}`);
      if (!cell) {
        node.append(elEl('div', { class: 'mcs-rv-cell mcs-rv-cell-empty', 'data-row': row, 'data-col': col }));
        continue;
      }
      const clickable = typeof opts.onCellClick === 'function';
      const cls = `mcs-rv-cell mcs-rv-cell-${cell.kind || 'item'}${clickable ? ' mcs-rv-clickable' : ''}`;
      node.append(
        elEl(
          'div',
          {
            class: cls,
            'data-row': row,
            'data-col': col,
            'data-id': cell.id || '',
            title: cell.id ? `${cell.id}${cell.name ? `（${cell.name}）` : ''}` : '',
            onclick: clickable ? () => opts.onCellClick(cell) : undefined,
          },
          ...cellInner(cell, opts, size),
        ),
      );
    }
  }
  return node;
}

/** 一行横排的材料（机器配方用，没有空格子）。 */
function stripNode(grid, opts, size) {
  const cols = Math.max(Number(grid?.cols) || 1, 1);
  const node = elEl('div', {
    class: 'mcs-rv-grid mcs-rv-strip',
    style: `grid-template-columns:repeat(${cols},${size}px);grid-template-rows:repeat(1,${size}px);--rv-cell:${size}px`,
    'data-rows': 1,
    'data-cols': cols,
  });
  const cells = [...(grid?.cells ?? [])].sort((a, b) => (Number(a.col) || 0) - (Number(b.col) || 0));
  for (const cell of cells) {
    const clickable = typeof opts.onCellClick === 'function';
    node.append(
      elEl(
        'div',
        {
          class: `mcs-rv-cell mcs-rv-cell-${cell.kind || 'item'}${clickable ? ' mcs-rv-clickable' : ''}`,
          'data-row': 0,
          'data-col': Number(cell.col) || 0,
          'data-id': cell.id || '',
          title: cell.id ? `${cell.id}${cell.name ? `（${cell.name}）` : ''}` : '',
          onclick: clickable ? () => opts.onCellClick(cell) : undefined,
        },
        ...cellInner(cell, opts, size),
      ),
    );
  }
  return node;
}

// --------------------------------------------------------------- 产物

/** 产物块：图标放大一号 + ×N。多产物就并排几个。 */
function outputNode(layout, opts, size) {
  const box = elEl('div', { class: 'mcs-rv-out' });
  const out = layout?.output;
  const clickable = typeof opts.onOutputClick === 'function';
  const items = [];
  if (out && out.id) items.push(out);
  for (const extra of layout?.extraOutputs ?? []) if (extra?.id) items.push(extra);

  if (items.length === 0) {
    box.append(elEl('div', { class: 'mcs-rv-out-empty', text: '（没读到产物）' }));
    return box;
  }

  for (const item of items) {
    const kids = [iconNode(item, opts, size + 6)];
    const count = Number(item.count) || 0;
    if (count > 1) kids.push(elEl('span', { class: 'mcs-rv-out-count', text: `×${count}` }));
    box.append(
      elEl(
        'div',
        {
          class: 'mcs-rv-out-item',
          'data-id': item.id,
          title: `${item.id}${item.name ? `（${item.name}）` : ''}`,
          onclick: clickable ? () => opts.onOutputClick(item) : undefined,
        },
        ...kids,
      ),
    );
  }
  return box;
}

/** 中间那个箭头：纯 CSS 画的，不用 emoji（emoji 在不同系统上粗细颜色都不一样）。 */
function arrowNode() {
  return elEl('div', { class: 'mcs-rv-arrow' }, elEl('div', { class: 'mcs-rv-arrow-line' }), elEl('div', { class: 'mcs-rv-arrow-head' }));
}

// --------------------------------------------------------------- 主入口

/**
 * 把一份布局画出来。
 *
 * @param {object} layout `layoutRecipe()` 的返回
 * @param {object} [opts]
 * @param {(cell: object) => void} [opts.onCellClick] 点格子里的材料
 * @param {(item: object) => void} [opts.onOutputClick] 点产物
 * @param {(id: string) => string} [opts.iconUrl] 物品 ID → 图片地址；不给就画占位方块
 * @param {'sm'|'md'} [opts.size] 小号 / 中号
 * @returns {object} DOM 节点
 */
export function recipeView(layout, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const mode = options.size === 'sm' ? 'sm' : 'md';
  const cellSize = mode === 'sm' ? 30 : 40;
  const grid = layout?.grid ?? { rows: 0, cols: 0, cells: [] };
  const isMachine = layout?.kind === 'machine';

  const root = elEl('div', { class: `mcs-rv mcs-rv-${mode} mcs-rv-kind-${layout?.kind || 'unknown'}` });

  // ---- 顶部一行小字：几乘几 + 机器名 ----
  const head = elEl('div', { class: 'mcs-rv-head' });
  if (layout?.gridSize) head.append(elEl('span', { class: 'mcs-rv-size', text: layout.gridSize }));
  if (isMachine && layout?.machineName) {
    head.append(elEl('span', { class: 'mcs-rv-machine-name', text: layout.machineName }));
  }
  if (Number(layout?.produceTotal) > 0) {
    head.append(elEl('span', { class: 'mcs-rv-total', text: `一次出 ${layout.produceTotal} 个` }));
  }
  if (head.children.length) root.append(head);

  // ---- 中间：格子 + 箭头 + 产物 ----
  if (isMachine) {
    // 流程图：材料横排在左 → 机器 → 产物在右
    const flow = elEl('div', { class: 'mcs-rv-machine' });
    flow.append(elEl('div', { class: 'mcs-rv-machine-in' }, stripNode(grid, options, cellSize)));
    flow.append(arrowNode());
    flow.append(
      elEl(
        'div',
        { class: 'mcs-rv-machine-box', title: layout.machineIcon || layout.machineName || '' },
        iconNode({ id: layout.machineIcon || '', name: layout.machineName || '' }, options, cellSize + 4),
        elEl('div', { class: 'mcs-rv-machine-label', text: layout.machineName || layout.machineKind || '机器' }),
      ),
    );
    flow.append(arrowNode());
    flow.append(outputNode(layout, options, cellSize));
    root.append(flow);
  } else {
    const flow = elEl('div', { class: 'mcs-rv-flow' });
    // 只有一行的配方（熔炉之类）也用横排，别画成一个大方块
    const single = Number(grid.rows) <= 1;
    flow.append(single ? stripNode(grid, options, cellSize) : gridNode(grid, options, cellSize));
    flow.append(arrowNode());
    flow.append(outputNode(layout, options, cellSize));
    root.append(flow);
  }

  // ---- 底部：提示与「改不了」的原因 ----
  const notes = Array.isArray(layout?.notes) ? layout.notes : [];
  const blockers = Array.isArray(layout?.blockers) ? layout.blockers : [];
  if (notes.length) {
    const box = elEl('div', { class: 'mcs-rv-notes' });
    for (const note of notes) box.append(elEl('div', { class: 'mcs-rv-note', text: `· ${note}` }));
    root.append(box);
  }
  if (blockers.length) {
    const box = elEl('div', { class: 'mcs-rv-blockers' });
    for (const blocker of blockers) box.append(elEl('div', { class: 'mcs-rv-blocker', text: blocker }));
    root.append(box);
  }

  return root;
}

export default recipeView;
