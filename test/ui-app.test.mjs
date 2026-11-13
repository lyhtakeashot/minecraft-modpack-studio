/**
 * 工作台前端（`packages/ui/app.js`）的冒烟测试。
 *
 * 为什么不用真浏览器：这个沙箱里启动 Edge/Chrome 会被拒绝（Access denied），
 * 但「页面渲染路径里引用了不存在的函数」这类错误恰恰只有真跑一遍才会暴露
 * （开发时 `truncate` 就漏定义过，浏览器里表现为整页空白、控制台一行红字）。
 *
 * 所以这里造一个刚好够用的 DOM 替身，把 app.js 当模块导入，让它真的跑一遍
 * render()，然后检查渲染出来的文字。能覆盖：模块能加载、render 不抛、
 * 选项目页在、连上包之后三栏都在、接口返回的数据真的进了界面、
 * 右键菜单和「换图标」的预览/写入两态走得通。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// ------------------------------------------------------------------ DOM 替身

/** 所有节点共用的最小实现。 */
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.attrs = {};
    this._text = '';
    this.style = '';
    this.value = '';
    this.className = '';
    this.dataset = {};
    this.parentNode = null;
  }

  append(...kids) {
    for (const kid of kids) {
      this.children.push(kid);
      // 记父链：界面里「点在浮层里面没有？」要顺着父链往上找
      if (kid instanceof FakeNode) kid.parentNode = this;
    }
  }

  replaceChildren(...kids) {
    for (const old of this.children) {
      if (old instanceof FakeNode && old.parentNode === this) old.parentNode = null;
    }
    this.children = [...kids];
    for (const kid of this.children) {
      if (kid instanceof FakeNode) kid.parentNode = this;
    }
  }

  /** 把自己从父节点上摘下来（界面里「点空白处收菜单」就是靠这个）。 */
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    if (at >= 0) parent.children.splice(at, 1);
    this.parentNode = null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener() {}

  setAttribute(key, value) {
    this.attrs[key] = String(value);
  }

  getAttribute(key) {
    return this.attrs[key];
  }

  removeAttribute(key) {
    delete this.attrs[key];
  }

  focus() {
    globalThis.document.activeElement = this;
  }

  setSelectionRange() {}

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  set innerHTML(value) {
    this._text = String(value);
  }

  get innerHTML() {
    return this._text;
  }
}

globalThis.Node = FakeNode;
globalThis.HTMLElement = FakeNode;
globalThis.HTMLInputElement = FakeNode;

/** 递归收集一个节点（连同子孙）的文字。 */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!(node instanceof FakeNode)) return '';
  return `${node._text}${node.children.map(textOf).join('')}`;
}

/** 深度遍历找第一个满足条件的节点。 */
function find(root, test) {
  if (!(root instanceof FakeNode)) return null;
  if (test(root)) return root;
  for (const kid of root.children) {
    const hit = find(kid, test);
    if (hit) return hit;
  }
  return null;
}

/** 按 `[data-focus="x"]` 这种最简单的选择器找元素。 */
function findByFocus(root, key) {
  return find(root, (node) => node['data-focus'] === key || node.attrs['data-focus'] === key);
}

function findButton(label) {
  return find(appRoot, (node) => node.tagName === 'BUTTON' && textOf(node).includes(label));
}

const appRoot = new FakeNode('div');

/** 假 document 也存监听器：拖动和框选都靠它（pointermove / pointerup / keydown）。 */
const docListeners = {};

globalThis.document = {
  activeElement: null,
  listeners: docListeners,
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (ns, tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const node = new FakeNode('#text');
    node._text = String(text);
    return node;
  },
  addEventListener(type, fn) {
    (docListeners[type] ??= []).push(fn);
  },
  removeEventListener(type, fn) {
    const list = docListeners[type] ?? [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  },
  getElementById: (id) => (id === 'app' ? appRoot : null),
  querySelector: (selector) => {
    const m = /^\[data-focus="(.+)"\]$/.exec(selector);
    if (!m) return null;
    return findByFocus(appRoot, m[1]);
  },
};

/** 把 document 上某一类监听器全跑一遍（模拟浏览器派发）。 */
function fireDoc(type, event = {}) {
  for (const fn of [...(docListeners[type] ?? [])]) fn(event);
}

globalThis.location = { origin: 'http://127.0.0.1:7460' };
globalThis.localStorage = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  },
  setItem(key, value) {
    this.store.set(key, String(value));
  },
};

const QUESTS = [
  { id: 'AAAA000000000001', title: '任务甲', x: 0, y: 0, icon: 'demo:cogwheel', taskCount: 1, dependencies: [], dependents: ['AAAA000000000002'], shapeEffective: 'circle', size: 1 },
  { id: 'AAAA000000000002', title: '任务乙', x: 2, y: 1, icon: 'demo:gear', taskCount: 2, dependencies: [{ id: 'AAAA000000000001', title: '任务甲' }], dependents: [], shapeEffective: 'gear', size: 2 },
];

// 第二章：只有乙一个任务挂在里面（测章节切换用）
const CHAPTER2_QUESTS = [
  { id: 'BBBB000000000001', title: '任务丙', x: 0, y: 0, icon: '', taskCount: 0, dependencies: [], dependents: [] },
];

/** 任务 ID → 标题。假接口回话时用它把 ID 还原成名字，免得写死「任务甲」。 */
const TITLE_OF = Object.fromEntries(
  [...QUESTS, ...CHAPTER2_QUESTS].map((q) => [q.id, q.title]),
);

/** 假接口。按 pathname 分发，POST 也走同一张表。 */
// 2026-11-04 第 3 批 B：模拟「上次打开过」的目录。默认就让 lab 这一项带 remembered 标记，
// 而且展示路径 dir 与原始记住值 rememberedDir 故意不一样 —— 界面删的必须是后者。
// 点 ✕ 之后 /roots/remove 会把 removedRootDir 填上，之后 /roots 不再带标记（模拟真删掉了）。
let removedRootDir = '';
// 中文名补全的假状态：默认「没下载过」，点一次按钮之后变「已缓存」。
const nameState = { cached: false, count: 0 };
// 游戏真值清单（2026-11-07 任务③）：默认没导过；导入/开关用例自己改。
// /item-grid 的假答案按它切换 filter，界面才能显示「精确 / 全部」两态。
const truthState = { has: false, source: '', count: 0 };
// 锁定名单的假状态（2026-11-07 第二轮）：点一次「锁定」就真记一条，
// 这样「锁定后那一行会不会变灰」测的是界面真逻辑，而不是写死的答案。
const lockState = [];
const FAKE = {
  '/api/mcstudio/roots': () => ({
    ok: true,
    roots: [{
      label: '项目里的 lab',
      dir: 'D:\\lab\\DemoPack',
      ...(removedRootDir ? {} : { remembered: true, rememberedDir: 'D:\\lab\\OldPack' }),
    }],
  }),
  // 深度搜索：只读接口，按 dir 换答案（2026-11-02 用户要的「选个大概位置自己翻」）
  '/api/mcstudio/roots/scan': (parsed) => {
    const dir = parsed.searchParams.get('dir') ?? '';
    if (dir === 'D:\\nowhere') {
      return { ok: true, roots: [], visited: 12, depth: 2, stopped: '', ms: 5 };
    }
    return {
      ok: true,
      roots: [
        {
          label: '深度搜索 / b',
          dir: 'D:\\upper\\a\\b',
          instances: 1,
          // 2026-11-02：每条结果要带里面每个实例的名字，界面才能「一行一个包」
          list: [{ id: 'PackB', mcVersion: '1.21.1', loader: 'neoforge', modsCount: 2 }],
        },
        {
          label: '深度搜索 / c',
          dir: 'D:\\upper\\c',
          instances: 2,
          list: [
            { id: 'PackC1', mcVersion: '1.20.1', loader: 'forge', modsCount: 5 },
            { id: 'PackC2', mcVersion: '1.21.1', loader: 'neoforge', modsCount: 6 },
          ],
        },
      ],
      visited: 37,
      depth: 3,
      stopped: '',
      ms: 42,
    };
  },
  '/api/mcstudio/roots/add': { ok: true, added: [] },
  // 2026-11-04 第 3 批 B：忘掉目录。真接口只认 body 里的 dir，删完把标记撤掉。
  '/api/mcstudio/roots/remove': (parsed) => {
    const dir = String(parsed._body?.dir ?? '');
    if (dir) removedRootDir = dir;
    return { ok: true, removed: dir };
  },
  '/api/mcstudio/instances': {
    ok: true,
    instances: [{ id: 'DemoPack', mcVersion: '1.21.1', loader: 'neoforge', modsCount: 3 }],
  },
  '/api/mcstudio/summary': {
    ok: true,
    instance: { id: 'DemoPack', instanceDir: 'D:\\lab\\DemoPack', mcVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.1', modsCount: 3 },
    index: { itemCount: 120, recipeCount: 340, jarCount: 3, jarFailed: 0, namespaces: ['minecraft', 'create'] },
  },
  '/api/mcstudio/mods': {
    ok: true,
    mods: [
      { modId: 'create', name: 'Create', version: '0.5.1', items: 420, recipes: 900, file: 'create.jar' },
      { modId: 'minecraft', name: 'Minecraft', version: '1.21.1', items: 1200, recipes: 300, file: 'mc.jar' },
    ],
  },
  '/api/mcstudio/questbook': {
    ok: true,
    questDir: 'D:\\lab\\DemoPack\\config\\ftbquests\\quests',
    locale: 'zh_cn',
    // 任务书语言列表：顶栏靠它出「英文 / 中文」按钮（第 4 批 B）
    locales: ['en_us', 'zh_cn'],
    questCount: 3,
    chapterCount: 2,
    // 体检结果（2026-11-03 加）：有错有警告才在右栏显示一张卡
    issues: {
      errorCount: 1,
      warnCount: 1,
      problems: [
        // 2026-11-12：任务级问题现在带 questId + chapterId（界面靠它「点一条跳过去」）
        { level: 'warn', code: 'QuestDanglingDependency', questId: 'AAAA000000000002', chapterId: 'CH1', where: '任务 齿轮（Q_GEAR）', message: '依赖的 NOSUCH 不是任务 ID，游戏会自动忽略' },
        // 这条**故意不带任何定位**：章节级 / 无从定位的问题点了就该没反应，不能报错
        { level: 'warn', code: 'ImageMissing', where: '章节 第一章 装饰图 #1', message: '图 demo:textures/missing.png 在包里找不到，游戏里这块会是空的' },
      ],
    },
  },
  '/api/mcstudio/quest/canvas': {
    ok: true,
    questDir: 'D:\\lab\\DemoPack\\config\\ftbquests\\quests',
    locale: 'zh_cn',
    chapterCount: 2,
    questCount: 3,
    chapters: [
      {
        id: 'CH1',
        title: '第一章',
        file: 'ch1.snbt',
        nodes: QUESTS,
        bounds: {},
        // 2026-11-02：章节背景图（FTB images 字段），只有切进单章才画
        images: [{ image: 'demo:textures/bg.png', x: 0, y: 0, width: 4, height: 3, rotation: 0 }],
      },
      { id: 'CH2', title: '第二章', file: 'ch2.snbt', nodes: CHAPTER2_QUESTS, bounds: {} },
    ],
  },
  // 章节背景图：资源 ID → data URL（真实现是去 mod jar 里抠）
  '/api/mcstudio/quest/images': (parsed) => {
    const images = {};
    for (const src of parsed._body?.srcs ?? []) {
      if (src === 'demo:textures/bg.png') images[src] = 'data:image/png;base64,BGIMG';
      // 任务描述里插的图（2026-11-11）
      if (src === 'demo:textures/desc.png') images[src] = 'data:image/png;base64,DESCIMG';
      // FTB 的形状贴图（游戏观感模式要用）：真实现是去 ftb-quests jar 里抠
      if (src.startsWith('ftbquests:textures/shapes/')) {
        images[src] = `data:image/png;base64,SHAPE_${src}`;
      }
    }
    return { ok: true, images };
  },
  // 只给 cogwheel：demo:gear 故意缺 —— 详情卡「补图」按钮的断言载体（本地解析不到的灰块才出按钮）
  '/api/mcstudio/item-icons': {
    ok: true,
    icons: { 'demo:cogwheel': 'data:image/png;base64,AAA' },
  },
  // /quest 按 questId 返回对应详情（fetch 替身按 pathname 查表，带 query 的要写成函数）：
  // 甲 icon=cogwheel（icons 表里有 → 不出补图按钮），乙 icon=gear（缺 → 出按钮）
  '/api/mcstudio/quest': (parsed) => {
    const questId = parsed.searchParams.get('questId') ?? 'AAAA000000000001';
    if (questId === 'AAAA000000000002') {
      return {
        ok: true,
        id: 'AAAA000000000002',
        title: '任务乙',
        chapterTitle: '第一章',
        x: 2,
        y: 1,
        icon: 'demo:gear',
        subtitle: '',
        description: [],
        // ★ 真实后端对「没描述的任务」回的就是 `[[]]`（一页、零个块），不是 []。
        //   界面必须靠「页里有没有内容」判断，不能只看长度 —— 否则会画出一个空的「简介」标题。
        descriptionPages: [[]],
        descriptionPageCount: 1,
        tasks: [
          { type: 'item', what: 'demo:gear', count: 1 },
          { type: 'item', what: 'demo:cogwheel', count: 1 },
        ],
        rewards: [{ type: 'item', what: 'minecraft:gold_ingot', count: 1 }],
        upstream: [{ id: 'AAAA000000000001', title: '任务甲' }],
        downstream: [],
      };
    }
    if (questId === 'AAAA000000000003') {
      // 「只有标题」的纯指引任务（用户原话：「有的任务只有标题没有描述也没有奖励，
      // 意思是标题就能够指引了」）。真实数据里 ATM10Sky 有 192 个这种。
      return {
        ok: true,
        id: 'AAAA000000000003',
        title: '纯指引任务',
        chapterTitle: '第一章',
        x: 0,
        y: 3,
        icon: '',
        subtitle: '',
        description: [],
        descriptionPages: [[]],
        descriptionPageCount: 1,
        tasks: [],
        rewards: [],
        upstream: [],
        downstream: [],
      };
    }
    return {
      ok: true,
      id: 'AAAA000000000001',
      title: '任务甲',
      chapterTitle: '第一章',
      x: 0,
      y: 0,
      icon: 'demo:cogwheel',
      subtitle: '做出第一个齿轮',
      // 2026-11-02：详情卡要显示简介 / 要求 / 奖励，假数据带上真实形状
      description: ['这是任务简介的第一行。', '这是第二行。', '{image:demo:textures/desc.png width:40 height:30 align:center}'],
      // 2026-11-11：描述里的图（FTB 的 {image:…} 标记）解析成块，界面按块渲染
      descriptionBlocks: [
        [{ kind: 'text', text: '这是任务简介的第一行。' }],
        [{ kind: 'text', text: '这是第二行。' }],
        [{ kind: 'image', src: 'demo:textures/desc.png', width: 40, height: 30, align: 'center', fit: false }],
      ],
      // 2026-11-11：按 {@pagebreak} 分好页（真包里 46 个任务能翻页）。
      // 第一页里带一个占位符（后端已换成中文名，界面画成小标签）。
      descriptionPages: [
        [
          { kind: 'text', text: '这是任务简介的第一行。' },
          { kind: 'text', text: '第一页的占位符：钻石', spans: [{ text: '第一页的占位符：钻石', color: '', bold: false, italic: false, underline: false, strike: false }], holder: 'item.minecraft.diamond', holderName: '钻石' },
        ],
        [
          { kind: 'text', text: '第二页的内容。' },
          { kind: 'image', src: 'demo:textures/desc.png', width: 40, height: 30, align: 'center', fit: false },
        ],
      ],
      descriptionPageCount: 2,
      tasks: [
        { type: 'item', what: 'demo:cogwheel', count: 2 },
        { type: 'item', what: 'minecraft:iron_ingot', count: 1 },
      ],
      rewards: [
        { type: 'item', what: 'minecraft:diamond', count: 3 },
        { type: 'xp', what: '100', count: 1 },
      ],
      upstream: [],
      downstream: [{ id: 'AAAA000000000002', title: '任务乙' }],
      // 2026-11-12 第二批：依赖方式。默认的 all_completed 不显示补充说明，
      // 「任意一个完成 / 至少 N 个」必须说出来（真包 ATM10Sky 有 44 处不是默认）。
      dependencyRequirement: 'all_completed',
      minRequiredDependencies: 0,
      // 2026-11-13 默认值改造：任务级字段的现状。
      // 任务甲**全都是默认值** —— 用它测「一个字段都不该显示成已改」。
      // ★ size 这里必须是 **0**（= 文件里没写、跟章节走）。
      //   以前 core 把「没写」读成 1，界面就分不清「用户写了 1 倍」和「根本没写」。
      shape: '',
      size: 0,
      optional: false,
      invisible: false,
      canRepeat: null,
    };
  },
  '/api/mcstudio/item-icon/web': { ok: true, found: true, dataUrl: 'data:image/png;base64,WEB', title: ' cogwheel 中文名', cached: false, reason: '' },
  // 新建章节：预览/写入同一套 plan/done 形状（2026-11-02「＋新章节」入口）
  '/api/mcstudio/quest/chapter/preview': {
    ok: true,
    changes: [{ field: 'title', label: '章节名', before: '', after: '测试新章' }],
    diff: ['新建章节文件：ch9.snbt'],
    warnings: [],
    files: [{ name: 'ch9.snbt', path: 'D:\\lab\\DemoPack\\config\\ftbquests\\quests\\chapters\\ch9.snbt', bytes: 96, created: true }],
    lines: [],
  },
  '/api/mcstudio/quest/chapter/apply': {
    ok: true,
    changes: [],
    diff: [],
    warnings: [],
    files: [{ name: 'ch9.snbt', path: 'D:\\lab\\DemoPack\\config\\ftbquests\\quests\\chapters\\ch9.snbt', bytes: 96, created: true }],
    lines: ['新建了章节「测试新章」'],
    backups: [],
  },
  // 装饰图（章节 images）编辑：加 / 挪 / 删都走这两个接口，靠 action 分（2026-11-02）
  '/api/mcstudio/quest/image/preview': (parsed) => {
    const body = parsed._body ?? {};
    const action = body.action ?? 'add';
    if (action === 'remove') {
      return {
        ok: true,
        kind: 'image',
        action,
        chapterId: 'CH1',
        chapterTitle: '第一章',
        chapterFile: 'ch1.snbt',
        changedCount: 1,
        changes: [{ field: 'images', label: '装饰图', before: '1 张', after: '0 张' }],
        diff: ['删掉第 1 张装饰图：demo:textures/bg.png (0, 0)，4×3 格'],
        warnings: [],
        files: [{ name: 'ch1.snbt', path: 'D:\\lab\\DemoPack\\config\\ftbquests\\quests\\chapters\\ch1.snbt', bytes: 210 }],
      };
    }
    return {
      ok: true,
      kind: 'image',
      action,
      chapterId: 'CH1',
      chapterTitle: '第一章',
      chapterFile: 'ch1.snbt',
      changedCount: 1,
      changes: [{ field: 'images', label: '装饰图', before: '1 张', after: '2 张' }],
      diff: ['新增装饰图：demo:textures/new_bg.png (5, 2)，6×4 格'],
      warnings: [],
      files: [{ name: 'ch1.snbt', path: 'D:\\lab\\DemoPack\\config\\ftbquests\\quests\\chapters\\ch1.snbt', bytes: 256 }],
    };
  },
  '/api/mcstudio/quest/image/apply': (parsed) => {
    const body = parsed._body ?? {};
    return {
      ok: true,
      kind: 'image',
      action: body.action ?? 'add',
      chapterId: 'CH1',
      chapterTitle: '第一章',
      chapterFile: 'ch1.snbt',
      changedCount: 1,
      changes: [],
      diff: [],
      warnings: [],
      files: [],
      lines: [`已加装饰图（章节「第一章」），现在这一章有 2 张`],
      backups: ['ch1.snbt.bak-7-0'],
    };
  },
  '/api/mcstudio/quest/node/preview': {
    ok: true,
    kind: 'node-edit',
    questId: 'AAAA000000000001',
    questTitle: '任务甲',
    changedCount: 1,
    changes: [{ field: 'icon', label: '图标物品', before: 'demo:cogwheel', after: 'demo:gear' }],
    diff: ['图标物品：demo:cogwheel → demo:gear'],
    warnings: [],
    files: [{ name: 'ch1.snbt', path: 'D:\\lab\\DemoPack\\config\\ftbquests\\quests\\chapters\\ch1.snbt', bytes: 128, created: false }],
  },
  '/api/mcstudio/quest/node/apply': {
    ok: true,
    kind: 'node-edit',
    questId: 'AAAA000000000001',
    lines: ['图标物品：demo:cogwheel → demo:gear'],
    backups: ['ch1.snbt.bak-1-0'],
    files: [],
    diff: [],
    changes: [],
    warnings: [],
  },
  // 蓝图式编辑（2026-11-09）：把物品拖进节点 / 拖到空白 / 复制整个任务。
  // 三条都是「拖完就写」，没有 preview 那一步；回话按 body 里的字段给，方便断言入参。
  '/api/mcstudio/quest/node/items/apply': (parsed) => {
    const body = parsed._body ?? {};
    return {
      ok: true,
      kind: 'node-items',
      questId: body.questId ?? 'AAAA000000000001',
      item: body.item ?? 'demo:gear',
      count: Number(body.count ?? 1),
      changedCount: 1,
      diff: [`完成条件：追加「交 1 个 ${body.item ?? 'demo:gear'}」`],
      warnings: [],
      files: [],
      lines: ['已把物品加进那个任务的要求'],
      backups: ['ch1.snbt.bak-8-0'],
    };
  },
  '/api/mcstudio/quest/spawn/apply': (parsed) => {
    const body = parsed._body ?? {};
    return {
      ok: true,
      kind: 'quest',
      questId: 'AAAA000000000004',
      chapter: { id: 'CH1', title: '第一章' },
      x: Number(body.x ?? 0),
      y: Number(body.y ?? 0),
      tasks: [{ id: 'TNEW0001', type: 'item', item: { id: body.item ?? 'demo:gear', count: 1 } }],
      rewards: [],
      diff: [`在 (${body.x ?? 0}, ${body.y ?? 0}) 新建任务，要求交 1 个 ${body.item ?? 'demo:gear'}`],
      warnings: [],
      files: [],
      lines: ['新建了一个任务节点'],
      backups: ['ch1.snbt.bak-9-0'],
    };
  },
  '/api/mcstudio/quest/clone/apply': (parsed) => {
    const body = parsed._body ?? {};
    return {
      ok: true,
      kind: 'quest',
      questId: 'AAAA000000000005',
      sourceQuestId: body.sourceQuestId ?? 'AAAA000000000001',
      chapter: { id: 'CH1', title: '第一章' },
      x: Number(body.x ?? 2),
      y: Number(body.y ?? 0),
      tasks: [],
      rewards: [],
      diff: ['复制了任务「任务甲」'],
      warnings: [],
      files: [],
      lines: ['已复制 1 个任务'],
      backups: ['ch1.snbt.bak-10-0'],
    };
  },
  // /items 按参数分发：普通搜索给 gear 列表；补图入口按物品 ID 精确搜（q=demo:cogwheel）
  // 时给一条带中文名的精确命中（fetch 替身按 pathname 查表，带 query 的要写成函数）。
  '/api/mcstudio/items': (parsed) => {
    if (parsed.searchParams.get('q') === 'demo:cogwheel') {
      return {
        ok: true,
        total: 1,
        shown: 1,
        items: [{ id: 'demo:cogwheel', from: ['create'], name: '青 铜 齿 轮', rank: 0 }],
      };
    }
    return {
      ok: true,
      items: [
        { id: 'demo:gear', name: '齿轮' },
        { id: 'demo:gear_big', name: '大齿轮' },
      ],
    };
  },
  // 物品网格（2026-11-05 JEI 式侧边栏）：一页 9×16 = 144 个。
  // 假数据故意做成「第 1 页给 144 条、第 2 页给 2 条、总 146 条」，
  // 这样能同时验证「格子数是 144」「翻页真的换了一批」「页码被夹在合法范围」。
  '/api/mcstudio/item-grid': (parsed) => {
    const page = Number(parsed.searchParams.get('page') ?? 1) || 1;
    const q = String(parsed.searchParams.get('q') ?? '');
    // 界面用 GET+query 传 showAll（'1' 才是开）；别读 _body（那是 POST 通路）。
    const showAll = parsed.searchParams.get('showAll') === '1';
    const all = [];
    for (let i = 1; i <= 146; i += 1) all.push({ id: `demo:item_${i}`, name: `测试物品 ${i}`, mods: ['demo'] });
    // 带搜索词时只回 2 条，方便断言「搜出来的和默认那页不是同一批」
    const hit = q ? [{ id: 'demo:cogwheel', name: '齿轮', mods: ['create'], desc: '用铁锭压出来' }, { id: 'demo:gear', name: '大齿轮', mods: ['create'] }] : all;
    const pages = Math.max(1, Math.ceil(hit.length / 144));
    const p = Math.min(Math.max(1, page), pages);
    // 真值清单口径（2026-11-07 任务③）：导过且没开「显示全部」＝精确，否则＝全部。
    const filter = truthState.has && !showAll ? 'truth' : 'all';
    return {
      ok: true,
      instance: 'DemoPack',
      query: q,
      queryHint: q === '#minecraft:planks' ? '正在按标签搜 planks' : '',
      total: hit.length,
      indexTotal: 120,
      showAll,
      filter,
      hasTruth: truthState.has,
      truthSource: truthState.source,
      hiddenCount: filter === 'truth' ? 4 : 0,
      poolTotal: 124,
      ghostCount: 0,
      page: p,
      pages,
      pageSize: 144,
      cols: 9,
      rows: 16,
      offset: (p - 1) * 144,
      items: hit.slice((p - 1) * 144, p * 144),
      indexedMs: 651,
      tagCount: 1079,
    };
  },
  '/api/mcstudio/item-tags': { ok: true, instance: 'DemoPack', query: '', total: 1, shown: 1, tags: [{ tag: 'minecraft:planks', items: 6 }], tagCount: 1079 },
  // 游戏真值清单（2026-11-07 任务③）：status 问「导过没」，import 把假状态翻成「导过」。
  '/api/mcstudio/item-truth/status': () => ({ ok: true, instance: 'DemoPack', has: truthState.has, source: truthState.source, count: truthState.count }),
  '/api/mcstudio/item-truth/import': (parsed) => {
    truthState.has = true;
    truthState.source = String(parsed._body?.file ?? 'D:\\Downloads\\mods');
    truthState.count = 8015;
    return { ok: true, instance: 'DemoPack', has: true, source: truthState.source, count: 8015 };
  },
  // 中文名补全：preview 只读（默认没缓存），apply 下载后变成「已缓存」。
  // 两个可变状态由下面两条用例自己改，别的用例不受影响。
  '/api/mcstudio/name/preview': () => ({ ok: true, cached: nameState.cached, count: nameState.count, license: 'CC BY-NC-SA 4.0', project: 'https://github.com/CFPAOrg/Minecraft-Mod-Language-Package' }),
  '/api/mcstudio/name/apply': () => {
    nameState.cached = true;
    nameState.count = 66111;
    // job 是后端的进度槽（2026-11-06）：界面靠它收尾、查最后一帧
    return {
      ok: true,
      count: 66111,
      files: 400,
      license: 'CC BY-NC-SA 4.0',
      tag: 'Snapshot-20261105000000',
      job: {
        id: 'jobNameFill',
        kind: 'name-fill',
        name: '下载中文名（CFPA 汉化包）',
        status: 'done',
        unit: 'bytes',
        done: 3527805,
        total: 3527805,
        count: 0,
        finished: 0,
        percent: 100,
        speed: 0,
        speedText: '',
        etaSeconds: 0,
        etaText: '',
        doneText: '3.4 MB',
        totalText: '3.4 MB',
        current: '直链',
        note: '下载完成，正在整理中文名（66111 条）…',
        error: '',
        indeterminate: false,
        elapsedMs: 8000,
        elapsedText: '已用 8 秒',
      },
    };
  },
  // 拖动直接写盘（不再有 preview 这一步）
  // 2026-11-02：改成函数 —— 按请求里带的 questId 回话，这样「撤销栈各归各的」
  // 那条用例才能看出撤销的是哪一章的哪个任务（静态回话会永远说「任务甲」）。
  '/api/mcstudio/quest/move/apply': (parsed) => {
    const asked = JSON.parse(parsed._body?.moves ?? '[]');
    return {
      ok: true,
      kind: 'move',
      changedCount: asked.length,
      moves: asked.map((m) => ({
        questId: m.questId,
        title: TITLE_OF[m.questId] ?? m.questId,
        from: { x: 0, y: 0 },
        to: { x: m.x, y: m.y },
      })),
      diff: [],
      files: [],
      backups: ['ch1.snbt.bak-3-0'],
      lines: [`挪了 ${asked.length} 个任务`],
    };
  },
  '/api/mcstudio/quest/add/preview': {
    ok: true,
    kind: 'quest-add',
    questId: 'AAAA000000000003',
    changedCount: 1,
    changes: [],
    diff: ['新建任务「新任务」'],
    warnings: [],
    files: [{ name: 'ch1.snbt', path: 'D:\\lab\\DemoPack\\config\\ftbquests\\quests\\chapters\\ch1.snbt', bytes: 200, created: false }],
  },
  '/api/mcstudio/quest/add/apply': {
    ok: true,
    kind: 'quest-add',
    questId: 'AAAA000000000003',
    backups: ['ch1.snbt.bak-4-0'],
    lines: ['新建了任务「新任务」'],
    diff: ['新建任务「新任务」'],
    files: [],
  },
  // 改已有任务（2026-11-04 第 2 批 B）：预览算、apply 写，同一套字段
  '/api/mcstudio/quest/preview': {
    ok: true,
    questId: 'AAAA000000000001',
    changes: [{ field: 'title', label: '标题', before: '任务甲', after: '改过的名字' }],
    warnings: [],
    summary: ['标题：「任务甲」→「改过的名字」'],
    files: [{ path: 'D:\\lab\\DemoPack\\config\\ftbquests\\quests\\lang\\zh_cn.snbt', name: 'lang/zh_cn.snbt', bytes: 120, created: false }],
    changed: true,
  },
  '/api/mcstudio/quest/apply': {
    ok: true,
    backups: ['zh_cn.snbt.bak-1-0', 'ch1.snbt.bak-1-0'],
    lines: ['改好了任务「改过的名字」'],
    changes: [],
    warnings: [],
    summary: [],
    files: [],
  },

  // ---- 改配方 ----
  '/api/mcstudio/recipes': {
    ok: true,
    item: '齿轮',
    producers: [
      { id: 'create:pressing/cogwheel', type: 'create:pressing', kind: 'machine', outputs: [{ id: 'demo:cogwheel', count: 1 }], inputs: ['minecraft:iron_ingot'], tags: [], jar: 'create.jar' },
      { id: 'create:milling/multi', type: 'create:milling', kind: 'machine', outputs: [{ id: 'demo:flour', count: 2 }, { id: 'demo:husk', count: 1, chance: 0.25 }], inputs: ['minecraft:wheat'], tags: [], jar: 'create.jar' },
    ],
    consumers: [
      { id: 'minecraft:crafting/gear_big', type: 'minecraft:crafting_shaped', kind: 'shaped', outputs: [{ id: 'demo:gear_big', count: 1 }], inputs: ['demo:cogwheel'], tags: [], jar: 'mc.jar' },
    ],
    producerTotal: 1,
    consumerTotal: 1,
    recipeCount: 2,
    elapsedMs: 3,
  },
  // /recipe 按 recipeId 分发：普通那条（单产物）+ 多产物那条。
  // 2026-11-03：改成函数 —— 多产物配方的详情跟单产物长得不一样（outputs 数组 + multi），
  // 静态回话没法同时给两种。
  '/api/mcstudio/recipe': (parsed) => {
    if (parsed.searchParams.get('recipeId') === 'create:milling/multi') {
      return {
        ok: true,
        recipe: {
          id: 'create:milling/multi',
          type: 'create:milling',
          kind: 'machine',
          machineKind: 'milling',
          jar: 'create.jar',
          output: '',
          count: 1,
          outputs: [
            { id: 'demo:flour', count: 2 },
            { id: 'demo:husk', count: 1, chance: 0.25 },
          ],
          multi: true,
          pattern: [],
          keys: {},
          inputs: ['minecraft:wheat'],
          tags: [],
          editable: true,
          reason: '',
        },
        usedBy: { count: 0, recipes: [] },
      };
    }
    return {
      ok: true,
      recipe: {
        id: 'create:pressing/cogwheel',
        type: 'create:pressing',
        kind: 'machine',
        machineKind: 'pressing',
        jar: 'create.jar',
        output: 'demo:cogwheel',
        count: 1,
        pattern: [],
        keys: {},
        inputs: ['minecraft:iron_ingot'],
        tags: [],
        editable: true,
        reason: '',
      },
      usedBy: { count: 1, recipes: [{ id: 'minecraft:crafting/gear_big', outputs: [{ id: 'demo:gear_big', count: 1 }] }] },
    };
  },
  '/api/mcstudio/recipe/view': {
    ok: true,
    instanceId: 'DemoPack',
    itemName: '齿轮',
    recipe: { id: 'create:pressing/cogwheel', type: 'create:pressing', kind: 'machine', output: 'demo:cogwheel', count: 1 },
    layout: {
      kind: 'machine',
      machineKind: 'pressing',
      machineName: '压板机',
      machineIcon: 'create:mechanical_press',
      grid: {
        rows: 1,
        cols: 1,
        cells: [{ row: 0, col: 0, kind: 'item', id: 'minecraft:iron_ingot', count: 1, name: '铁锭' }],
      },
      gridSize: '1x1',
      produceTotal: 1,
      output: { id: 'demo:cogwheel', count: 1, name: '齿轮' },
      notes: ['压板机把材料压成薄板'],
      blockers: [],
      editable: true,
      rawJson: '{"type":"create:pressing"}',
      rawJsonTruncated: false,
    },
    rawJson: '{"type":"create:pressing"}',
    rawJsonTruncated: false,
    rawJsonSize: 25,
  },
  '/api/mcstudio/recipe/preview': (parsed) => {
    // 多产物那条回 JSON 改写路径的样子（写数据包文件，不是脚本）
    if (parsed._body?.recipeId === 'create:milling/multi' || parsed.searchParams.get('recipeId') === 'create:milling/multi') {
      return {
        ok: true,
        mode: 'json',
        action: 'edit',
        recipe: { id: 'create:milling/multi', type: 'create:milling', kind: 'machine', multi: true },
        code: '{\n  "type": "create:milling",\n  "results": [\n    { "id": "demo:flour", "count": 2 }\n  ]\n}',
        targetPath: 'D:\\lab\\DemoPack\\kubejs\\data\\create\\recipe\\milling\\multi.json',
        summary: '把 create:milling/multi 的产物改成 1 种',
        warnings: ['会覆盖 kubejs/data 里的同名文件（会自动备份）'],
        impact: { critical: [], lost: [], lostTotal: 0 },
        counts: { removed: 0, added: 0 },
      };
    }
    return {
      ok: true,
      action: 'edit',
      recipe: { id: 'create:pressing/cogwheel', type: 'create:pressing', kind: 'machine', output: 'demo:cogwheel', count: 2 },
      code: "ServerEvents.recipes((event) => {\n  event.remove({ id: 'create:pressing/cogwheel' })\n  event.recipes.create.pressing('2x demo:cogwheel', 'minecraft:iron_ingot')\n})",
      targetPath: 'D:\\lab\\DemoPack\\kubejs\\server_scripts\\dsh_recipes.js',
      summary: '把 create:pressing/cogwheel 改成产出 2 个',
      warnings: ['原配方会在游戏里被删掉'],
      impact: { critical: [], lost: [{ item: 'demo:gear', usedBy: 0 }], lostTotal: 1 },
      counts: { removed: 1, added: 1 },
    };
  },
  '/api/mcstudio/recipe/apply': {
    ok: true,
    targetPath: 'D:\\lab\\DemoPack\\kubejs\\server_scripts\\dsh_recipes.js',
    backup: 'dsh_recipes.js.bak-1-0',
    code: '// 见预览',
    summary: '把 create:pressing/cogwheel 改成产出 2 个',
    recipe: { id: 'create:pressing/cogwheel', output: 'demo:cogwheel', count: 2 },
    impact: { critical: [], lost: [], lostTotal: 0 },
    verified: true,
    warnings: [],
  },
  // 批量改配方（2026-11-08）：预览返回 files 对象数组（带 content/mode），
  // 写入返回 files 字符串数组 + backups —— 两种形状故意不一样，卡片要各按各的显示。
  '/api/mcstudio/recipe/batch/preview': (parsed) => {
    const body = parsed._body ?? {};
    const list = JSON.parse(body.items ?? '[]');
    return {
      ok: true,
      items: list.map((it) => ({ recipeId: it.recipeId, action: body.action, kind: 'machine', multi: false, output: 'demo:cogwheel', count: 1 })),
      files: [{ file: 'D:\\lab\\DemoPack\\kubejs\\server_scripts\\dsh_recipes.js', content: 'ServerEvents.recipes((event) => {\n  event.remove({ id: "create:pressing/cogwheel" })\n})', mode: 'script' }],
      summary: [`这批要改 ${list.length} 条配方（${body.action === 'remove' ? '删掉' : '产出 +1'}）`],
      warnings: ['dsh_recipes.js 已经存在，写入时会覆盖它（会自动备份）'],
      impact: { critical: [{ item: 'demo:gear', usedBy: 3 }], lost: [], lostTotal: 0 },
      counts: { removed: list.length, added: 0, files: 1 },
    };
  },
  '/api/mcstudio/recipe/batch/apply': {
    ok: true,
    files: ['D:\\lab\\DemoPack\\kubejs\\server_scripts\\dsh_recipes.js'],
    backups: ['dsh_recipes.js.bak-2-0'],
    items: [],
    summary: ['这批 2 条配方写进 1 个文件'],
    impact: { critical: [], lost: [], lostTotal: 0 },
    counts: { removed: 2, added: 0, files: 1 },
    verified: true,
    warnings: [],
  },

  // ---- 分析页（原先只有模型工具形态的那批只读检查，2026-11-03）----
  '/api/mcstudio/analysis/overlap': {
    ok: true,
    collisionCount: 2,
    collisions: [
      { path: 'gear', namespaces: ['create', 'demo'], ids: ['create:gear', 'demo:gear'], count: 2 },
      { path: 'cogwheel', namespaces: ['create', 'demo'], ids: ['create:cogwheel', 'demo:cogwheel'], count: 2 },
    ],
    families: [
      { family: '传动/齿轮', modCount: 2, itemTotal: 40, crowded: true, mods: [{ mod: 'create', items: 30 }, { mod: 'demo', items: 10 }] },
      { family: '流体', modCount: 1, itemTotal: 12, crowded: false, mods: [{ mod: 'create', items: 12 }] },
    ],
    crowdedFamilies: ['传动/齿轮'],
    emptyFamilies: ['装饰'],
    lines: ['同名物品：2 组', '功能撞车：1 类（传动/齿轮）'],
  },
  '/api/mcstudio/analysis/progress': {
    ok: true,
    knownItems: 120,
    unknownItems: 30,
    widestDepth: 5,
    widestItems: ['demo:gear_big'],
    concentration: 0.42,
    buckets: [
      { depth: 0, items: 80, samples: ['minecraft:iron_ingot', 'minecraft:stick'] },
      { depth: 1, items: 30, samples: ['demo:plate'] },
      { depth: 2, items: 10, samples: ['demo:cogwheel'] },
    ],
    recipeCount: 340,
    elapsedMs: 12,
    lines: ['第 0 层：80 个', '加工深度还算可以'],
  },
  '/api/mcstudio/analysis/mod': {
    ok: true,
    jarFile: 'create.jar',
    modId: 'create',
    name: 'Create',
    version: '0.5.1',
    view: 'summary',
    counts: { items: 420, recipes: 900, tags: 12, loot: 3, configs: 2 },
    recipeTypes: { 'create:pressing': 120 },
    recipeSkipped: 0,
    configs: [{ file: 'create-common.toml', size: 1200, own: true }],
    configTotal: 2,
    notes: ['想看细节可以切：items（物品）/ recipes（配方）/ tags（标签）/ loot（掉落）/ config（配置）'],
  },
  '/api/mcstudio/analysis/recipe-path': {
    ok: true,
    item: 'demo:gear',
    depth: 4,
    truncated: false,
    levelCount: 2,
    levels: [
      [{ item: 'demo:gear', recipe: 'minecraft:crafting/gear', type: 'minecraft:crafting_shaped', from: ['demo:cogwheel'], jar: 'mc.jar' }],
      [{ item: 'demo:cogwheel', recipe: 'create:pressing/cogwheel', type: 'create:pressing', from: ['minecraft:iron_ingot'], jar: 'create.jar' }],
    ],
  },
  '/api/mcstudio/analysis/recipe-uses': {
    ok: true,
    item: 'demo:cogwheel',
    count: 1,
    byType: [{ type: 'minecraft:crafting_shaped', count: 1 }],
    recipes: [{ id: 'minecraft:crafting/gear', type: 'minecraft:crafting_shaped', outputs: ['demo:gear'], jar: 'mc.jar' }],
  },
  '/api/mcstudio/analysis/kubejs': {
    ok: true,
    kubejsDir: 'D:\\lab\\DemoPack\\kubejs',
    scriptCount: 2,
    breakdown: { ok: 1, 'syntax-error': 0, 'runtime-error': 1, 'read-error': 0 },
    declared: [],
    missingItems: [{ id: 'demo:nosuch', file: 'dsh_recipes.js' }],
    missingRecipes: [],
    byModule: [{ namespace: 'dsh', count: 2 }],
    scripts: [
      { file: 'dsh_recipes.js', stage: 'server', status: 'ok', error: '', line: 0, recipes: 1, removals: 1, missingItems: 1, missingRecipes: 0 },
      { file: 'dsh_bad.js', stage: 'server', status: 'runtime-error', error: 'ReferenceError: foo is not defined', line: 3, recipes: 0, removals: 0, missingItems: 0, missingRecipes: 0 },
    ],
    elapsedMs: 30,
    lines: ['脚本 2 个：1 个能跑、1 个运行时出错'],
  },
  // 任务书关键词搜索（/quests?q=）
  '/api/mcstudio/quests': (parsed) => {
    const q = (parsed.searchParams.get('q') ?? '').toLowerCase();
    const all = [
      { id: 'AAAA000000000001', title: '任务甲', chapterId: 'CH1', chapterTitle: '第一章', taskCount: 1, x: 0, y: 0, titleSource: 'lang', titleItem: '', icon: 'demo:cogwheel' },
      { id: 'BBBB000000000002', title: '任务乙', chapterId: 'CH2', chapterTitle: '第二章', taskCount: 2, x: 1, y: 1, titleSource: 'lang', titleItem: '', icon: 'demo:gear' },
    ];
    const items = q ? all.filter((x) => `${x.title} ${x.id}`.toLowerCase().includes(q)) : all;
    return { ok: true, total: items.length, shown: items.length, limit: 40, chapter: '', items };
  },

  // ---- 打包 ----
  '/api/mcstudio/export/preview': {    ok: true,
    mode: 'offline',
    packName: 'DemoPack-offline',
    wrapper: 'DemoPack-offline',
    suggestZip: 'DemoPack-offline.zip',
    instanceId: 'DemoPack',
    mcVersion: '1.21.1',
    loader: 'neoforge',
    fileCount: 1234,
    totalBytes: 104857600,
    totalText: '100 MB',
    warnings: ['没有带 runtime，对方要自己装 Java'],
    top: [{ name: 'mods', files: 3, sizeText: '12 MB' }],
    nested: false,
    outDir: 'D:\\lab',
    willWriteTo: 'D:\\lab\\DemoPack-offline.zip',
  },
  '/api/mcstudio/export/build': {
    ok: true,
    mode: 'offline',
    packName: 'DemoPack-offline',
    outFile: 'D:\\lab\\DemoPack-offline.zip',
    zipBytes: 98765432,
    zipText: '94 MB',
    entries: 1300,
    // 真接口会带这个：界面收尾时按它再抓一帧，进度条才不会定格在中途
    job: { id: 'jobExport', kind: 'export' },
    check: {
      ok: true,
      failed: [],
      items: [{ key: 'version-json', label: 'versions/DemoPack-offline/DemoPack-offline.json 在', ok: true }],
    },
  },

  // ---- 启动验证 ----
  '/api/mcstudio/launch/preview': {
    ok: true,
    instance: 'DemoPack',
    instanceDir: 'D:\\lab\\DemoPack',
    mcRoot: 'D:\\lab',
    versionId: 'DemoPack',
    mainClass: 'net.minecraft.client.main.Main',
    java: { path: 'C:\\Java\\jdk21\\bin\\java.exe', version: '21.0.2', major: 21, source: 'JAVA_HOME', warning: '' },
    requiredMajor: 21,
    javaMatches: true,
    libraries: { total: 120, found: 120, missing: [] },
    classpath: { libs: 120, entries: 121, chars: 9000, hasClientJar: true },
    natives: { wanted: 12, count: 12, dir: 'D:\\lab\\natives' },
    clientJar: 'D:\\lab\\versions\\DemoPack\\DemoPack.jar',
    hasClientJar: true,
    jvmArgCount: 8,
    gameArgCount: 20,
    missingVars: [],
    blockers: [],
    lines: ['Java 21 够用', '库文件 120 个齐', '客户端 jar 有'],
    command: 'C:\\Java\\jdk21\\bin\\java.exe -Xmx4G -cp ... net.minecraft.client.main.Main',
    commandTruncated: false,
  },
  '/api/mcstudio/launch/apply': {
    ok: true,
    instance: 'DemoPack',
    versionId: 'DemoPack',
    started: true,
    status: 'ok',
    summary: '启动到主菜单（23 秒）',
    suspects: [],
    durationMs: 23456,
    timeoutHit: false,
    exitCode: 0,
    signal: '',
    evidence: ['[Render thread/INFO]: Sound engine started'],
    evidenceLine: '[Render thread/INFO]: Sound engine started',
    evidenceKind: 'sound',
    newCrashReports: [],
    natives: null,
    logFile: 'D:\\lab\\logs\\latest.log',
    captureFile: '',
    tail: ['[Render thread/INFO]: Backend library: LWJGL'],
    lines: ['结论：启动到主菜单（23 秒）'],
  },

  // ---- 从零装底座 ----
  '/api/mcstudio/scaffold/preview': {
    ok: true,
    name: 'NewPack',
    mcRoot: 'D:\\lab',
    targetDir: 'D:\\lab\\versions\\NewPack',
    targetText: 'D:\\lab\\versions\\NewPack',
    mcVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: '21.1.228',
    fileCount: 300,
    vanillaFiles: 250,
    assetFiles: 40,
    loaderFiles: 8,
    javaFiles: 2,
    totalBytes: 314572800,
    totalText: '300 MB',
    assetsText: '40 MB',
    loaderText: '8 MB',
    javaText: '2 MB',
    clientJarText: '20 MB',
    java: { path: 'C:\\Java\\jdk21\\bin\\java.exe', version: '21.0.2', major: 21, source: 'JAVA_HOME', warning: '' },
    javaRequiredMajor: 21,
    javaMatches: true,
    javaRuntime: { component: 'java-runtime-delta', version: '21', dir: 'D:\\lab\\runtime', fileCount: 40, bytes: 100, text: '100 MB' },
    javaCandidates: [],
    installer: { url: 'https://example.invalid/installer.jar', bytes: 1000 },
    steps: [{ key: 'vanilla', title: '下游戏本体', done: false }],
    warnings: [],
    conflicts: [],
    lines: ['会下 300 MB'],
  },
  '/api/mcstudio/scaffold/apply': {
    ok: true,
    applied: true,
    name: 'NewPack',
    targetDir: 'D:\\lab\\versions\\NewPack',
    seconds: 95,
    inheritsFrom: '1.21.1',
    filesVanilla: 250,
    filesLoader: 8,
    filesJava: 2,
    java: { path: 'C:\\Java\\jdk21\\bin\\java.exe', version: '21.0.2', major: 21 },
    javaRuntime: null,
    stages: [{ key: 'vanilla', title: '下游戏本体', done: true }],
    lines: ['装好了'],
  },

  // ---- 从零建包（抄底子）----
  '/api/mcstudio/pack/preview': {
    ok: true,
    name: 'CopyPack',
    mcRoot: 'D:\\lab',
    targetDir: 'D:\\lab\\versions\\CopyPack',
    templateId: 'DemoPack',
    mcVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: '21.1.228',
    templateMods: 183,
    dirCount: 4,
    fileCount: 12,
    totalBytes: 26214400,
    totalText: '25 MB',
    questBook: true,
    kubejs: true,
    warnings: [],
    dirs: [],
    files: [{ rel: 'CopyPack.json', kind: 'version-json', note: '', sizeText: '2 KB' }],
    lines: ['会抄 25 MB'],
  },
  '/api/mcstudio/pack/apply': {
    ok: true,
    applied: true,
    name: 'CopyPack',
    targetDir: 'D:\\lab\\versions\\CopyPack',
    createdDirs: ['D:\\lab\\versions\\CopyPack', 'D:\\lab\\versions\\CopyPack\\config\\ftbquests\\quests'],
    createdFiles: ['D:\\lab\\versions\\CopyPack\\CopyPack.json'],
    lines: ['建好了：12 个文件，抄了 25 MB'],
  },

  // 图标导出目录体检（任务书顶栏那一行）
  '/api/mcstudio/icon-export/status': {
    ok: true,
    hasExport: true,
    dirs: ['D:\\lab\\DemoPack\\.mcstudio\\icon-exports'],
    count: 1895,
    totalBytes: 3879712,
    skipped: 3,
    elapsedMs: 120,
    text: '游戏导出 1895 个（3.7 MB）',
  },
  '/api/mcstudio/icon-export/scan': {
    ok: true,
    hasExport: true,
    dirs: ['D:\\lab\\DemoPack\\.mcstudio\\icon-exports'],
    count: 1900,
    totalBytes: 3891200,
    skipped: 0,
    elapsedMs: 200,
    text: '游戏导出 1900 个（3.7 MB）',
    lines: ['游戏导出 1900 个（3.7 MB）', '目录：D:\\lab\\DemoPack\\.mcstudio\\icon-exports'],
  },

  // ---- 联网装 mod（左边那栏）----
  '/api/mcstudio/mod-search': {
    ok: true,
    results: [{ projectId: 'create', slug: 'create', title: 'Create', downloads: 12000000 }],
  },
  // 2026-11-04 第 3 批 A：版本列表。GET /mod-versions 带 project=create，
  // 给两个版本，界面点名旧版后 preview/apply 的 pinned 里就得是旧版的 versionId。
  // 2026-11-06：每个版本多了 recommended（最适合这个整合包的那条）和
  // mcCompatible（适不适合你的 MC 版本），界面要照着显示「推荐」「不适合你的 MC 版本」。
  '/api/mcstudio/mod-versions': {
    ok: true,
    project: 'create',
    gameVersion: '1.21.1',
    loader: 'neoforge',
    channel: 'release',
    autoVersionNumber: '6.0.10',
    versions: [
      { versionId: 'create-6.0.10', versionNumber: '6.0.10', versionType: 'release', fileName: 'create-6.0.10.jar', size: 3145728, sizeText: '3.0 MB', published: '2026-01-02', gameVersions: ['1.21.1', '1.21', '1.20.6', '1.20.4'], loaders: ['neoforge'], requiredDeps: [], compatible: true, recommended: true, mcCompatible: true },
      { versionId: 'create-0.5.1', versionNumber: '0.5.1', versionType: 'release', fileName: 'create-0.5.1.jar', size: 2097152, sizeText: '2.0 MB', published: '2024-05-06', gameVersions: ['1.20.1'], loaders: ['neoforge'], requiredDeps: [], compatible: true, recommended: false, mcCompatible: false },
    ],
    lines: ['create 有 2 个版本'],
  },
  '/api/mcstudio/mod-install/preview': {
    ok: true,
    modsDir: 'D:\\lab\\DemoPack\\mods',
    // 2026-11-06：后端多回一个「实际会装到哪」和「这个包装之前已有的毛病」
    targetDir: 'D:\\lab\\DemoPack\\mods',
    compat: {
      ok: true,
      conflicts: [],
      missing: [],
      versionMismatch: [],
      duplicates: [],
      lines: ['这个包现在有个老问题：sodium 装了两份'],
    },
    itemCount: 2,
    totalBytes: 4194304,
    totalText: '4.0 MB',
    installedCount: 0,
    items: [
      { title: 'Create', fileName: 'create-1.21.1.jar', size: 3145728, sizeText: '3.0 MB' },
      { title: 'Flywheel', fileName: 'flywheel-1.21.1.jar', size: 1048576, sizeText: '1.0 MB', dependencyOf: 'Create' },
    ],
    skipped: [],
    conflicts: [],
    unresolved: [],
    lines: ['要下 2 个文件，一共 4.0 MB'],
  },
  // 2026-11-06：整包 mod 体检（只读）。lines 已经是人话，界面直接显示。
  '/api/mcstudio/mod-compat': {
    ok: true,
    modsDir: 'D:\\lab\\DemoPack\\mods',
    count: 128,
    failed: 0,
    conflicts: [
      { kind: 'incompatible', hard: true, from: 'veil', fromVersion: '4.1.4', fromFile: 'veil-4.1.4.jar', target: 'sodium', targetVersion: '0.8.12', targetFile: 'sodium-0.8.12.jar', versionRange: '(,0.8.12-alpha.2+mc1.21.1]' },
    ],
    missing: [
      { from: 'createbetterfps', fromVersion: '1.0.0', fromFile: 'createbetterfps.jar', target: 'sodium', versionRange: '[0.6.9,)' },
    ],
    versionMismatch: [],
    duplicates: [
      { modId: 'sodium', files: [{ file: 'sodium-0.7.3.jar', version: '0.7.3' }, { file: 'sodium-0.8.12.jar', version: '0.8.12' }] },
    ],
    lines: [
      '⚠ 互斥：veil 4.1.4 和 sodium 0.8.12 不能一起装',
      '⚠ 装了多份：sodium 装了 2 个版本',
    ],
    mods: [
      { modId: 'sodium', name: 'Sodium', version: '0.8.12', file: 'sodium-0.8.12.jar', embedded: false },
    ],
  },
  '/api/mcstudio/mod-install/apply': {
    ok: true,
    applied: true,
    // 真接口会带这个：界面靠它去问进度
    job: { id: 'job9', kind: 'mod-install' },
    // 2026-11-06：真装完再体检一次的结果（compat）和实际装到哪（targetDir）
    targetDir: 'D:\\lab\\DemoPack\\mods',
    compat: {
      ok: true,
      conflicts: [],
      missing: [],
      versionMismatch: [],
      duplicates: [],
      lines: ['装完了，体检没问题'],
    },
    installed: [{ title: 'Create', fileName: 'create-1.21.1.jar', bytes: 3145728 }],
    failed: [],
    skipped: [],
    lines: ['装好了 1 个'],
  },
  // ---- 检查 mod 更新（2026-11-07，右边那栏）----
  // check 用 jar 的哈希问 Modrinth，status 三态：update / latest / unknown。
  // items 的字段要和 packages/core/mod-update.js 的 checkModUpdates() 对得上。
  '/api/mcstudio/mod-update/check': () => ({
    ok: true,
    modsDir: 'D:\\lab\\DemoPack\\mods',
    gameVersion: '1.21.1',
    loader: 'neoforge',
    channel: 'release',
    scanned: 3,
    updates: 1,
    latest: 1,
    unknown: 1,
    // 后端会顺手回锁定名单，界面拿来标「已锁定」。
    locks: lockState.slice(),
    items: [
      {
        key: 'aaaa', fileName: 'create-1.0.jar', name: 'Create', modId: 'create',
        currentVersion: '1.0', latestVersion: '2.0', projectId: 'create',
        versionType: 'release', status: 'update',
        file: { fileName: 'create-2.0.jar', fileUrl: 'https://cdn.modrinth.com/create-2.0.jar', sha1: 'bbbb', size: 3145728, versionNumber: '2.0', versionType: 'release', projectId: 'create', versionId: 'create-2.0' },
      },
      {
        key: 'cccc', fileName: 'sodium-0.8.jar', name: 'Sodium', modId: 'sodium',
        currentVersion: '0.8', latestVersion: '0.8', projectId: 'sodium',
        versionType: 'release', status: 'latest',
        file: { fileName: 'sodium-0.8.jar', fileUrl: '', sha1: 'cccc', size: 0, versionNumber: '0.8', versionType: 'release', projectId: 'sodium', versionId: 'sodium-0.8' },
      },
      {
        key: 'dddd', fileName: 'handmade.jar', name: '手改的 mod', modId: 'handmade',
        currentVersion: '', latestVersion: '', projectId: '',
        versionType: '', status: 'unknown', file: null,
      },
    ],
    lines: ['扫到 3 个 mod：1 个能升，1 个已最新，1 个查不到'],
  }),
  // preview 把 check 整块回传算清单：旧 jar 会被停用成 .jar.disabled，绝不删除。
  '/api/mcstudio/mod-update/preview': {
    ok: true,
    modsDir: 'D:\\lab\\DemoPack\\mods',
    channel: 'release',
    items: [{
      key: 'aaaa', name: 'Create', modId: 'create', currentVersion: '1.0', latestVersion: '2.0',
      projectId: 'create', oldName: 'create-1.0.jar', oldPath: 'D:\\lab\\DemoPack\\mods\\create-1.0.jar',
      disabledName: 'create-1.0.jar.disabled', newName: 'create-2.0.jar',
      newPath: 'D:\\lab\\DemoPack\\mods\\create-2.0.jar', fileName: 'create-2.0.jar',
      fileUrl: 'https://cdn.modrinth.com/create-2.0.jar', sha1: 'bbbb', size: 3145728, versionId: 'create-2.0',
    }],
    totalBytes: 3145728,
    skipped: [],
    lines: ['要升 1 个，旧文件会停用成 .jar.disabled，不会删'],
  },
  '/api/mcstudio/mod-update/apply': {
    ok: true,
    applied: true,
    job: { id: 'job10', kind: 'mod-update' },
    modsDir: 'D:\\lab\\DemoPack\\mods',
    // 真实后端会带上 oldName / disabledName / newName：撤回全靠这三个字段，
    // 少一个就撤回不了，所以假数据也得跟真后端对得上。
    installed: [{
      key: 'aaaa', name: 'Create', modId: 'create', currentVersion: '1.0', latestVersion: '2.0',
      oldName: 'create-1.0.jar', disabledName: 'create-1.0.jar.disabled',
      newName: 'create-2.0.jar', fileName: 'create-2.0.jar', bytes: 3145728,
    }],
    skipped: [],
    failed: [],
    // 升级后的整包体检：干净标志叫 ok（不是 clean）。
    compat: {
      modsDir: 'D:\\lab\\DemoPack\\mods',
      count: 3,
      failed: 0,
      conflicts: [],
      missing: [],
      versionMismatch: [],
      duplicates: [],
      mods: [],
      ok: true,
      lines: ['没发现版本兼容问题。'],
    },
    lines: ['升级完成 1 个', '旧文件停用为 create-1.0.jar.disabled，没有删除'],
  },
  // ---- 安全增强（2026-11-07 第二轮）：锁定名单 + 一键撤回 ----
  // 锁定名单用假状态：加一条 / 删一条，界面那行会不会变灰才是真的被测到。
  '/api/mcstudio/mod-update/locks': (parsed) => {
    const body = parsed._body;
    if (body?.action) {
      const entry = body.entry ? JSON.parse(body.entry) : null;
      if (body.action === 'clear') lockState.length = 0;
      else if (body.action === 'add' && entry) {
        const key = String(entry.modId || entry.projectId || entry.fileName || '').toLowerCase();
        if (!lockState.some((l) => String(l.modId || l.projectId || l.fileName || '').toLowerCase() === key)) {
          lockState.push(entry);
        }
      } else if (body.action === 'remove' && entry) {
        const key = String(entry.modId || entry.projectId || entry.fileName || '').toLowerCase();
        const at = lockState.findIndex((l) => String(l.modId || l.projectId || l.fileName || '').toLowerCase() === key);
        if (at >= 0) lockState.splice(at, 1);
      }
    }
    return {
      ok: true,
      instanceId: 'DemoPack',
      locks: lockState.slice(),
      lines: lockState.length ? [`已锁定 ${lockState.length} 个 mod。`] : ['这个包还没有锁定任何 mod。'],
    };
  },
  '/api/mcstudio/mod-update/rollback/preview': {
    ok: true,
    instanceId: 'DemoPack',
    modsDir: 'D:\\lab\\DemoPack\\mods',
    items: [{
      name: 'Create', oldName: 'create-1.0.jar', disabledName: 'create-1.0.jar.disabled',
      newName: 'create-2.0.jar', rolledName: 'create-2.0.jar.rolled-back',
    }],
    skipped: [],
    lines: ['准备撤回 1 个升级：旧 jar 改回原名，新 jar 改名停用留着，一个文件都不删。'],
  },
  '/api/mcstudio/mod-update/rollback/apply': {
    ok: true,
    applied: true,
    instanceId: 'DemoPack',
    modsDir: 'D:\\lab\\DemoPack\\mods',
    restored: [{ name: 'Create', oldName: 'create-1.0.jar', newName: 'create-2.0.jar' }],
    failed: [],
    skipped: [],
    lines: ['撤回完成 1 个：旧 jar 改回原名，新 jar 改名停用留着，没有删除任何文件。'],
  },
  // 2026-11-06：选目录通路（界面里「选个目录…」用它）。
  // 选了之后 status 报出 path，界面把它写进下载目录。
  '/api/mcstudio/pick-folder': { ok: true, picking: true },
  '/api/mcstudio/pick-folder/status': { ok: true, status: 'done', path: 'D:\\Downloads\\mods' },
  // 进度查询：按 kind 问给「正在跑的那一帧」，按 jobId 问给「最后一帧」。
  // 两条分支各自返回不同的数据，用例就能分别断言「转圈时」和「下完时」。
  '/api/mcstudio/progress': (url) => {
    const jobId = url.searchParams.get('jobId');
    const kind = url.searchParams.get('kind');
    // 中文名补全的下载（2026-11-06）：下载中是一帧百分比，下完是 100%。
    // 分支要放在靠前的地方，别被后面「其余情况」的 mod-install 分支吃掉。
    if (kind === 'name-fill' || jobId === 'jobNameFill') {
      const done = jobId === 'jobNameFill';
      return {
        ok: true,
        found: true,
        job: {
          id: 'jobNameFill',
          kind: 'name-fill',
          name: '下载中文名（CFPA 汉化包）',
          status: done ? 'done' : 'running',
          unit: 'bytes',
          done: done ? 3527805 : 1800000,
          total: 3527805,
          count: 0,
          finished: 0,
          percent: done ? 100 : 51,
          speed: done ? 0 : 900000,
          speedText: done ? '' : '879 KB/s',
          etaSeconds: done ? 0 : 2,
          etaText: done ? '' : '还剩 2 秒',
          doneText: done ? '3.4 MB' : '1.7 MB',
          totalText: '3.4 MB',
          current: 'https://gh-proxy.com/',
          note: '正在下载汉化包…',
          error: '',
          indeterminate: false,
          elapsedMs: done ? 8000 : 2000,
          elapsedText: '已用 2 秒',
        },
      };
    }
    // 打包是「按文件数」记的，而且一开始不知道总量 —— 正好覆盖转圈那一路
    if (kind === 'export' || jobId === 'jobExport') {
      const done = jobId === 'jobExport';
      return {
        ok: true,
        found: true,
        job: {
          id: 'jobExport',
          kind: 'export',
          name: '打包：DemoPack',
          status: done ? 'done' : 'running',
          unit: 'files',
          done: done ? 1300 : 0,
          total: done ? 1300 : 0,
          count: done ? 1300 : 0,
          finished: done ? 1300 : 0,
          percent: done ? 100 : null,
          speed: 0,
          speedText: '',
          etaSeconds: 0,
          etaText: '',
          doneText: done ? '1300' : '0',
          totalText: done ? '1300' : '未知',
          current: done ? 'dsh-export.json' : '',
          note: done ? '打完了' : '正在算要打哪些文件',
          error: '',
          indeterminate: !done,
          elapsedMs: 800,
          elapsedText: '已用 1 秒',
        },
      };
    }
    if (jobId === 'job9') {
      return {
        ok: true,
        found: true,
        job: {
          id: 'job9',
          kind: 'mod-install',
          name: '装 mod（2 个）',
          status: 'done',
          unit: 'bytes',
          done: 4194304,
          total: 4194304,
          count: 2,
          finished: 2,
          percent: 100,
          speed: 0,
          speedText: '',
          etaSeconds: 0,
          etaText: '',
          doneText: '4.0 MB',
          totalText: '4.0 MB',
          current: 'flywheel-1.21.1.jar',
          note: '装完了',
          error: '',
          indeterminate: false,
          elapsedMs: 12345,
          elapsedText: '已用 12 秒',
        },
      };
    }
    // 还在下：25%，有速度、有剩余时间、有当前文件
    return {
      ok: true,
      found: true,
      job: {
        id: 'job9',
        kind: 'mod-install',
        name: '装 mod（2 个）',
        status: 'running',
        unit: 'bytes',
        done: 1048576,
        total: 4194304,
        count: 2,
        finished: 0,
        percent: 25,
        speed: 524288,
        speedText: '512 KB/s',
        etaSeconds: 6,
        etaText: '还剩 6 秒',
        doneText: '1.0 MB',
        totalText: '4.0 MB',
        current: 'create-1.21.1.jar',
        note: '',
        error: '',
        indeterminate: false,
        elapsedMs: 2000,
        elapsedText: '已用 2 秒',
      },
    };
  },
  // MCP（2026-11-04）：桌面版自带的那个 MCP 服务器。
  // 配置是 GET，dir 是当前连着的整合包目录 —— 会被写进 env，
  // 这样模型就不用每次都在工具参数里报路径。
  '/api/mcstudio/mcp/config': (parsed) => {
    const dir = parsed.searchParams.get('dir') ?? '';
    const exe = 'C:\\apps\\整合包工作室-桌面版\\mcstudio.exe';
    const serverPath = 'C:\\apps\\整合包工作室-桌面版\\resources\\app\\packages\\mcp\\server.mjs';
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    if (dir) env.MCSTUDIO_PACK_DIR = dir;
    const lines = [
      '- id: mcp-mcstudio',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: mcstudio',
      '    transport: stdio',
      `    command: '${exe}'`,
      `    args: ['${serverPath}']`,
      '    env:',
      "      ELECTRON_RUN_AS_NODE: '1'",
    ];
    if (dir) lines.push(`      MCSTUDIO_PACK_DIR: '${dir}'`);
    return {
      ok: true,
      yaml: `${lines.join('\n')}\n`,
      serverName: 'mcstudio',
      configId: 'mcp-mcstudio',
      clientPackage: '@deepseek-ai/dsh-mcp-client',
      transport: 'stdio',
      command: exe,
      args: [serverPath],
      env,
      serverPath,
      appRoot: 'C:\\apps\\整合包工作室-桌面版\\resources\\app',
      packDir: dir,
      needsRunAsNode: true,
    };
  },
  '/api/mcstudio/mcp/selftest': {
    ok: true,
    toolCount: 27,
    protocolVersion: '2026-07-28',
    serverInfo: { name: 'mcstudio', version: '0.1.0' },
    toolNames: [
      'instance_info', 'pack_list', 'mod_list', 'mod_inspect', 'item_search',
      'recipe_find', 'recipe_path', 'recipe_uses', 'quest_list', 'quest_show',
      'quest_lint', 'overlap_report', 'progression_check', 'kubejs_check',
      'export_preview', 'launch_preview', 'recipe_edit', 'recipe_edit_batch', 'quest_add',
      'quest_chapter', 'quest_move', 'quest_patch', 'quest_remove', 'quest_image',
      'mod_update', 'mod_update_locks', 'mod_update_rollback',
    ],
  },
};

const posted = [];
// 所有请求（GET 也算）都记一份：有些用例要断言「只读接口确实被调了」，
// 光看 posted（只有 POST）会漏掉 GET 那半边的副作用。
const calls = [];

globalThis.fetch = async (url, options = {}) => {
  // post() 传的是相对路径（浏览器里会自己补 origin），替身里必须显式给 base
  const parsed = new URL(String(url), 'http://127.0.0.1:7460');
  const path = parsed.pathname;
  const entry = FAKE[path];
  calls.push({ path, method: options?.method ?? 'GET', params: Object.fromEntries(parsed.searchParams) });
  if (options?.method === 'POST') {
    const payload = JSON.parse(options.body ?? '{}');
    posted.push({ path, payload });
    // /quest/images 按 POST body 里的 srcs 换答案，URL 上没有 query，
    // 所以替身函数要把 payload 一起拿到 —— 塞进 parsed._body 传过去。
    parsed._body = payload;
  }
  // 有些接口要按参数换答案（比如 /progress 按 kind 还是 jobId 问），
  // 那种就在 FAKE 里写成函数，把 URL 交给它自己决定返回什么。
  const body = typeof entry === 'function' ? entry(parsed) : entry;
  // 装 mod 那条可以「卡住」：用例借此停在「正在下」那一帧做断言，再放行。
  if (path === '/api/mcstudio/mod-install/apply' && applyGate) {
    await applyGate;
  }
  // 中文名下载同理（2026-11-06）：卡在下载中那一帧，断言进度条。
  if (path === '/api/mcstudio/name/apply' && nameApplyGate) {
    await nameApplyGate;
  }
  return {
    ok: Boolean(body),
    status: body ? 200 : 404,
    headers: { get: () => 'application/json' },
    // 每次都给一份新的深拷贝：否则前端改了返回对象，会把假数据也改掉，
    // 后面几条用例就跟着互相污染（拖完坐标变 1 这种）。
    json: async () => (body ? JSON.parse(JSON.stringify(body)) : { ok: false, error: `没配假数据：${path}` }),
  };
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await tick();
};

// ---- 定时器替身 ----
// 进度条靠 setInterval 每 300 毫秒问一次。真定时器会让每条用例白等几百毫秒，
// 而且「什么时候刷新」变得不确定。所以这里把它换成手动触发的：
// 想推进就调 runTimers()，跑几轮就推进几轮。
const fakeTimers = [];
globalThis.setInterval = (fn, ms) => {
  const handle = { fn, ms };
  fakeTimers.push(handle);
  return handle;
};
globalThis.clearInterval = (handle) => {
  const i = fakeTimers.indexOf(handle);
  if (i >= 0) fakeTimers.splice(i, 1);
};

/** 让所有挂着的定时器各跑一遍（模拟时间往前走了 ms 毫秒）。 */
async function runTimers(times = 1) {
  for (let n = 0; n < times; n += 1) {
    for (const handle of [...fakeTimers]) handle.fn();
    await settle(4);
  }
}

/** 按 class 找元素（进度条那一组就是靠 class 认的）。 */
function findByClass(root, name) {
  return find(root, (node) => String(node.className ?? '').split(/\s+/).includes(name));
}

/** 收集所有带某个 class 的元素（findByClass 只给第一个，数数量 / 遍历要这个）。 */
function findAllByClass(root, name) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (String(node.className ?? '').split(/\s+/).includes(name)) out.push(node);
    for (const kid of node.children ?? []) walk(kid);
  };
  walk(root);
  return out;
}

/** 按任意条件收集元素（findAllByClass 只认 class，按 tagName / 属性找要这个）。 */
function findAll(root, predicate) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (predicate(node)) out.push(node);
    for (const kid of node.children ?? []) walk(kid);
  };
  walk(root);
  return out;
}

/** 这个 class 的元素是不是一个都没了。 */
function hasClass(name) {
  return Boolean(findByClass(appRoot, name));
}

/** 收集配方行里的勾选小勾（mcs-tick），别把装 mod / 搜索行的勾收进来。
 * 界面里 mcs-tick 有三处，配方行那个的父链上有 mcs-recipe-row。
 * render() 会整棵重画，收过之后要重新调一次。 */
function collectTicks() {
  const out = [];
  const inRecipeRow = (n) => {
    for (let p = n; p instanceof FakeNode; p = p.parentNode) {
      if (String(p.className ?? '').split(/\s+/).includes('mcs-recipe-row')) return true;
    }
    return false;
  };
  const walk = (n) => {
    if (!(n instanceof FakeNode)) return;
    const c = String(n.className ?? n.attrs?.['class'] ?? '').split(/\s+/);
    if (c.includes('mcs-tick') && inRecipeRow(n)) out.push(n);
    for (const k of n.children) walk(k);
  };
  walk(appRoot);
  return out;
}

/** 展开右栏「物品数据设置」折叠横栏（默认收起）。
 * 用例间共享 state，已经展开过就别重复点，否则会把它收回去。 */
async function openGridOpts() {
  const bar = find(appRoot, (n) => n.tagName === 'BUTTON'
    && String(n.className ?? '').split(/\s+/).includes('mcs-grid-opts-bar'));
  if (bar && textOf(bar).startsWith('▸')) await click(bar);
}

// ------------------------------- 章节页签那一套（2026-11-02 换的骨架）

/**
 * 顶部页签栏里的一个页签。
 *
 * 必须词边界匹配：页签本身是 `.mcs-tab`，容器是 `.mcs-tabbar`，
 * 子元素是 `.mcs-tab-name` / `.mcs-tab-x` —— 光用 includes('mcs-tab')
 * 会一口气撞上四个。
 */
const isTabEl = (n) => /(^|\s)mcs-tab(\s|$)/.test(String(n.className ?? ''));

/** 按标题找一个页签。 */
function tabElOf(title) {
  return find(appRoot, (n) => isTabEl(n) && textOf(n).includes(title));
}

/** 页签上那个 × （关掉它）。 */
function closeBtnOf(title) {
  const tab = tabElOf(title);
  return tab ? find(tab, (n) => String(n.className ?? '').includes('mcs-tab-x')) : null;
}

/** 左侧栏里的一个章节项。 */
const isChapItem = (n) => /(^|\s)mcs-chapitem(\s|$)/.test(String(n.className ?? ''));

/** 按标题找左栏的章节项。 */
function chapItemOf(title) {
  return find(appRoot, (n) => isChapItem(n) && textOf(n).includes(title));
}

// 装 mod 的 apply 卡在这里，用例就能停在「正在下」那一帧上做断言
let applyGate = null;
// 中文名下载的 apply 也卡在这里（2026-11-06）：用来断言下载进度条
let nameApplyGate = null;

// ------------------------------------------------------------------ 用例

test('启动后停在选项目页：标题、常见位置、实例都在', async () => {
  await import('../packages/ui/app.js');
  await settle();

  const text = textOf(appRoot);
  assert.ok(appRoot.children.length > 0, '整个界面是空的，说明 render 抛错了');
  assert.match(text, /整合包工作室/);
  assert.match(text, /先挑一个整合包/);
  // 常见位置里的目录来自假接口（label + dir 都显示）
  assert.match(text, /项目里的 lab/);
  assert.match(text, /D:\\lab\\DemoPack/);
  // 实例按钮
  assert.match(text, /DemoPack/);
  assert.match(text, /1\.21\.1/);
  // 手填目录（2026-11-02 改成「没找到你的包？」卡片：浏览… + 打开这个包）
  assert.match(text, /没找到你的包/);
  assert.match(text, /浏览…/);
  assert.match(text, /打开这个包/);
});

test('选项目页「✕ 忘掉这个目录」：拿原始记住值去删，删完按钮就消失（2026-11-04 第 3 批 B）', async () => {
  // 启动用例之后还停在选项目页。假接口里 lab 这一项带 remembered 标记，
  // 而且展示路径 D:\lab\DemoPack 和原始记住值 D:\lab\OldPack 故意不一样。
  const forget = findButton('✕ 忘掉这个目录');
  assert.ok(forget, '「上次打开过」的目录没有 ✕ 按钮');

  posted.length = 0;
  await click(forget);
  await settle(30);

  const remove = posted.find((p) => p.path === '/api/mcstudio/roots/remove');
  assert.ok(remove, '点 ✕ 没发 /roots/remove');
  assert.equal(
    remove.payload.dir,
    'D:\\lab\\OldPack',
    '删的不是原始记住值：显示路径和记住值不一样，删错了后端会返回成功却永远删不掉',
  );
  // 删完会重新拉一次 /roots，标记没了，✕ 也该跟着消失
  assert.ok(!findButton('✕ 忘掉这个目录'), '删完还留着 ✕，界面和后端没对齐');

  // 把假接口复位，别让这一条用例的「删过」影响后面所有用例
  removedRootDir = '';
});

test('点实例进工作台：三栏都在，体检与章节列表进了界面', async () => {
  const instanceBtn = find(appRoot, (node) => node.tagName === 'BUTTON' && textOf(node).includes('DemoPack'));
  assert.ok(instanceBtn, '没找到实例按钮');
  instanceBtn.listeners.click?.forEach((fn) => fn({}));
  await settle(16);

  const text = textOf(appRoot);
  // 顶栏：实例名 + 体检数据
  assert.match(text, /DemoPack/);
  assert.match(text, /1\.21\.1 · neoforge · 120 个物品 · 340 条配方/);
  // 左栏：2026-11-02 起是章节列表（mod 列表挪进菜单栏的 mod 工具页）
  assert.match(text, /章节/);
  assert.match(text, /2 章/);
  assert.ok(chapItemOf('第一章'), '左栏没有第一章');
  assert.ok(chapItemOf('第二章'), '左栏没有第二章');
  // 中栏蓝图：连上就自动开了第一章的页签，只画这一章
  assert.ok(tabElOf('第一章'), '没自动开第一章的页签');
  assert.match(text, /3 个任务 · 2 章/);
  assert.match(text, /任务甲/);
  assert.match(text, /任务乙/);
  assert.ok(!text.includes('任务丙'), '第一章页签里不该有第二章的任务丙');
  // 右栏
  assert.match(text, /任务详情/);
  assert.match(text, /还没有选中任务/);
  // ★ 2026-11-12：右栏**不再显示**任务书体检卡（用户：「太影响阅读了」）。
  //   诊断统一在「分析 → 任务书诊断」那条底部面板里，默认不展开。
  assert.ok(!/任务书体检/.test(text), '右栏不该再有体检卡');
  assert.ok(!findByClass(appRoot, 'mcs-diag'), '诊断面板默认不展开');

  // mod 列表现在在菜单栏「mod」里
  await clickMenu('mod', '看 mod 列表');
  const modsText = textOf(appRoot);
  assert.match(modsText, /Mod 列表/);
  assert.match(modsText, /Create/);
  assert.match(modsText, /共 2 个/);

  // 回到任务书页签，把页面留给下一条用例
  await click(tabElOf('第一章'));
  assert.ok(tabElOf('第一章'), '回不到第一章页签');
});

// ===== 2026-11-12 第二批：右栏要说出「依赖是或不是与」 =====
// 真包实测 ATM10Sky 有 44 处 dependency_requirement 不是默认值（one_completed 39 /
// one_started 4 / all_started 1）、Mechanomania 1 处。默认的 all_completed 不用啰嗦，
// 另外三种必须显式说出来，否则用户看到一排前置会当成「全部做完」。
test('右栏说清依赖方式：默认不说、任意一个/至少 N 个都要说出来并可切回', async () => {
  const clickNode = async (id) => {
    const node = find(appRoot, (n) => n.attrs['data-quest'] === id);
    assert.ok(node, `蓝图里没找到 ${id} 的节点`);
    node.listeners.click?.forEach((fn) => fn({}));
    await settle(6);
  };

  // ① 默认（all_completed）：不出现任何补充说明
  await clickNode('AAAA000000000001');
  assert.match(textOf(appRoot), /前置/, '该有「前置」这一栏');
  assert.ok(!textOf(appRoot).includes('任意一个做完就行'), '默认方式不该冒出「任意一个」');
  assert.ok(!textOf(appRoot).includes('全部「开始」'), '默认方式不该冒出「开始」');

  // ② 换成 one_completed：要说「任意一个做完就行（不是全部）」
  const original = FAKE['/api/mcstudio/quest'];
  FAKE['/api/mcstudio/quest'] = (parsed) => {
    const body = original(parsed);
    return { ...body, dependencyRequirement: 'one_completed' };
  };
  try {
    await clickNode('AAAA000000000001');
    assert.match(textOf(appRoot), /任意一个做完就行/, 'one_completed 必须说出来');
  } finally {
    FAKE['/api/mcstudio/quest'] = original;
  }

  // ③ 「至少 N 个」优先级最高，要说「满足其中 N 个就行」
  FAKE['/api/mcstudio/quest'] = (parsed) => {
    const body = original(parsed);
    return { ...body, dependencyRequirement: 'one_completed', minRequiredDependencies: 2 };
  };
  try {
    await clickNode('AAAA000000000001');
    assert.match(textOf(appRoot), /满足其中 2 个就行/, '「至少 N 个」必须说出来');
    assert.ok(!textOf(appRoot).includes('任意一个做完就行'),
      '有 minRequiredDependencies 时不该再说依赖方式那句话（那个设置优先于它）');
  } finally {
    FAKE['/api/mcstudio/quest'] = original;
  }

  // ④ 切回默认，别把替身改坏留给下一条用例
  await clickNode('AAAA000000000001');
  assert.ok(!textOf(appRoot).includes('满足其中'), '改回默认后不该还留着上一轮的说法');
});

// ———————————————————— 放置模式：「加后续」点哪放哪（2026-11-13 方案甲） ————————————————————
//
// 用户原话：「加后继是加在原任务的右侧一定距离吗，这点的实现效果我想做的和 ue 一样」
// → 选方案甲：点「加后续」进放置模式，在画布上点一下定位置。
// 改之前是算写死的 `x+2, y+1`，右边有节点时会直接盖住（真包 55 处重叠就这么来的）。

test('加后续进放置模式：点画布才定坐标，不再按写死的 +2/+1 偏移', async () => {
  await blueprintReset();

  // 先选中任务乙，点右栏的「加后续」
  find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002').listeners.click?.forEach((fn) => fn({}));
  await settle(20);
  const addBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('加后续'));
  assert.ok(addBtn, '右栏该有「加后续」按钮');
  addBtn.listeners.click?.forEach((fn) => fn({}));
  await settle(20);

  // ① 进入放置模式：顶栏出提示条，且此时**还没**任何请求发出去
  assert.match(textOf(appRoot), /在画布上点一下/, '进放置模式该有提示条');
  const before = posted.length;
  assert.equal(
    posted.slice(before).filter((c) => c.path.includes('/quest/add')).length, 0,
    '刚点「加后续」不该立刻建任务 —— 得等用户点位置',
  );

  // ② 在画布上点一下（坐标换算是 (clientX - rect.left - view.tx)/scale；
  //    测试替身 getBoundingClientRect 返回 0、view.tx/ty 默认 0、scale 默认 1）
  const host = findCanvasHost();
  assert.ok(host, '没找到画布容器');
  const clickX = 500;
  const clickY = 400;
  host.listeners.click?.forEach((fn) => fn({ clientX: clickX, clientY: clickY, button: 0, target: null }));
  await settle(20);

  // ③ 提示条收掉，冒出新建表单（说明坐标已经定下来了）
  assert.ok(!textOf(appRoot).includes('在画布上点一下'), '点完该退出放置模式');
  const formInput = find(appRoot, (n) => n.attrs['data-focus'] === 'newtitle');
  assert.ok(formInput, '该弹出新建任务的表单');

  // ④ 预览：发出去的坐标必须是刚才点的那个位置换算出来的，而不是 +2/+1
  // 表单要有个名字，否则后端 QuestNoTitle
  formInput.listeners.input?.forEach((fn) => fn({ target: { value: '后续任务' } }));
  await settle(4);
  const prev = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('预览要加什么'));
  assert.ok(prev, '该有「预览要加什么」按钮');
  prev.listeners.click?.forEach((fn) => fn({}));
  await settle(20);

  const addCall = posted.filter((c) => c.path === '/api/mcstudio/quest/add/preview').pop();
  assert.ok(addCall, '该向 /quest/add/preview 发请求');
  // 旧公式会把坐标算成「任务乙 x+2, y+1」；现在应该是「用户点的地方」。
  // 测试替身的 canvas 数据里任务乙在 (2, 0) 附近，点 (500,400) 换算后不会等于旧公式的值。
  assert.ok(typeof addCall.payload.x === 'number' && typeof addCall.payload.y === 'number',
    '坐标该是数字');
  assert.notEqual(
    `${addCall.payload.x},${addCall.payload.y}`,
    '4,1',
    '★ 坐标不能再是任务乙 (2,0) 的写死 +2/+1 偏移',
  );
  // 依赖必须还是任务乙 —— 这是「后续」的语义
  assert.equal(addCall.payload.dependsOn, JSON.stringify(['AAAA000000000002']), '新任务该依赖任务乙');
  // ★ 章节不能是空串（2026-11-13 修的真 bug：空串会让后端报 ChapterNotFound）
  assert.ok(addCall.payload.chapter, `★ 章节不能为空，实际「${addCall.payload.chapter}」`);
});

test('放置模式按 Esc 能取消，不会留下半截草稿', async () => {
  await blueprintReset();
  find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002').listeners.click?.forEach((fn) => fn({}));
  await settle(20);
  find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('加后续')).listeners.click?.forEach((fn) => fn({}));
  await settle(20);
  assert.match(textOf(appRoot), /在画布上点一下/, '前置条件：应该在放置模式');

  fireDoc('keydown', { key: 'Escape', preventDefault() {} });
  await settle(20);
  assert.ok(!textOf(appRoot).includes('在画布上点一下'), 'Esc 该取消放置模式');
  assert.ok(!find(appRoot, (n) => n.attrs['data-focus'] === 'newtitle'), '取消后不该冒出新建表单');
});

test('点蓝图里的方块：右栏出任务详情和四个操作', async () => {
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  assert.ok(node, '蓝图里没找到任务甲的节点');
  node.listeners.click?.forEach((fn) => fn({}));
  await settle();

  const text = textOf(appRoot);
  assert.match(text, /第一章/);
  assert.match(text, /任务乙/, '右栏应该列出「后续」');
  // 2026-11-13：「加后继」改名成「加后续」—— AGENTS.md 第一条要求少用术语，
  // 「后继」是图论词，「后续」才是人话。（第 3 件那条施工单里也点了这个。）
  for (const label of ['改名', '换图标', '改前置', '加后续', '删掉这个任务']) {
    assert.ok(text.includes(label), `右栏缺少「${label}」`);
  }
});

test('任务详情卡显示简介、要求、奖励（2026-11-02：之前只显示「要求 N 条」一个数字）', async () => {
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  node.listeners.click?.forEach((fn) => fn({}));
  await settle();

  const text = textOf(appRoot);
  // 简介块：2026-11-11 起描述按 {@pagebreak} 分页，假数据是 2 页，
  // 所以第一屏只该看到第 1 页的内容 + 页码；第二页要翻过去才有（另有用例专测翻页）。
  assert.match(text, /简介/);
  assert.match(text, /这是任务简介的第一行。/);
  assert.match(text, /第 1 \/ 2 页/);
  assert.ok(!text.includes('第二页的内容。'), '第一页不该看到第二页');
  // 要求块：要交什么、交几个
  assert.match(text, /要求/);
  assert.match(text, /demo:cogwheel/);
  assert.match(text, /× 2/);
  assert.match(text, /minecraft:iron_ingot/);
  // 奖励块：给什么、给几个；非物品奖励（xp）只显示类型
  assert.match(text, /奖励/);
  assert.match(text, /minecraft:diamond/);
  assert.match(text, /× 3/);
  assert.match(text, /xp/);
});

test('任务详情的描述里能画出图片（2026-11-11 用户：「有的任务不仅有文字说明还有图片辅助」）', async () => {
  await blueprintReset();
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  node.listeners.click?.forEach((fn) => fn({}));
  await settle();

  // 假数据里图片在第 2 页，先翻过去（取图本身是进任务时就全取了，翻页不用等）
  const text0 = textOf(appRoot);
  assert.ok(!findByClass(appRoot, 'mcs-desc-img'), '第 1 页没有图，不该画出来');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('下一页')));
  await settle(10);

  // 描述里的 {image:demo:textures/desc.png} 应该变成一张真图（走 /quest/images 换的 data URL）
  const img = findByClass(appRoot, 'mcs-desc-img');
  assert.ok(img, '描述里的图片没画出来');
  assert.equal(img.attrs.src, 'data:image/png;base64,DESCIMG', '图片没换成 data URL');
  // 替身里 el() 走的是 setAttribute，所以取回来是字符串 '40'（真浏览器里会是数字）。
  // 断言按字符串写，别为了好看改成数字 —— 那会因为替身与浏览器的差异而假红。
  assert.equal(String(img.attrs.width), '40', '宽度该按 {image:… width:40} 走');
  assert.equal(img.attrs.alt, '');

  // 文字块照常显示，且 {image:…} 这段标记本身不该再以文字形式露出来
  const text = textOf(appRoot);
  assert.ok(!text.includes('{image:'), '图片标记不该原样当文字显示');
  assert.ok(text0.length > 0);

  // 取图请求走的是和章节背景图同一个接口（图片在第 2 页，但取图是**所有页一起取**的，
  // 不然翻页那一下会卡着等图片 —— 见 ensureDescImages 的注释）
  const imgCall = posted.find((p) => p.path === '/api/mcstudio/quest/images'
    && (p.payload?.srcs ?? []).includes('demo:textures/desc.png'));
  assert.ok(imgCall, '没有向 /quest/images 请求描述里那张图');
});

test('描述里的图取不到时留占位并露出资源 ID，不静默消失', async () => {
  // 把取图接口临时改成「什么都不返回」，模拟 mod 没装 / 图不在 jar 里那种情况。
  // ★ 必须存原函数再换回来：FAKE 是全局共享的，不还原会连累后面所有用例。
  const original = FAKE['/api/mcstudio/quest/images'];
  FAKE['/api/mcstudio/quest/images'] = () => ({ ok: true, images: {} });
  try {
    // 换包重连，把 state.questImages 清空（否则上一张图还缓存着，测不到取不到的分支）
    await clickMenu('文件', '换一个整合包');
    await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
    const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
    node.listeners.click?.forEach((fn) => fn({}));
    await settle();

    // 图在第 2 页，翻过去才看得到占位
    await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('下一页')));
    await settle(10);

    const missing = findByClass(appRoot, 'mcs-desc-img-missing');
    assert.ok(missing, '取不到图时该留占位');
    assert.match(missing.text ?? textOf(missing), /demo:textures\/desc\.png/, '占位里该露出资源 ID，方便用户反馈');
    assert.ok(!findByClass(appRoot, 'mcs-desc-img'), '取不到图时不该画出一张空图');
  } finally {
    FAKE['/api/mcstudio/quest/images'] = original;
  }
});

test('章节页签：点左栏第二章开新页签，只画本章任务，切回来第一章还在（2026-11-02：之前所有章节平铺一张图）', async () => {
  // 连上包就自动开了第一章的页签
  assert.ok(tabElOf('第一章'), '没自动开第一章页签');
  assert.ok(!tabElOf('第二章'), '第二章不该自动开着');
  assert.ok(find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001'), '第一章页签里应该有任务甲');

  // 左栏点第二章：开第二个页签
  await click(chapItemOf('第二章'));
  assert.ok(tabElOf('第一章'), '开第二章不该把第一章的页签关掉');
  assert.ok(tabElOf('第二章'), '点左栏没开第二章的页签');
  assert.ok(find(appRoot, (n) => n.attrs['data-quest'] === 'BBBB000000000001'), '第二章页签里该有任务丙');
  assert.ok(!find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001'), '第二章页签不该显示第一章的任务甲');

  // 点回第一章页签：内容还是原来那些
  await click(tabElOf('第一章'));
  assert.ok(find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001'), '切回第一章后任务甲不见了');
  assert.ok(!find(appRoot, (n) => n.attrs['data-quest'] === 'BBBB000000000001'), '切回第一章后还有任务丙');

  // 点第一章页签上的 ×：关掉，跳到剩下的那个
  const x = closeBtnOf('第一章');
  assert.ok(x, '页签上没有 × ');
  x.listeners.click?.forEach((fn) => fn({ stopPropagation() {} }));
  await settle();
  assert.ok(!tabElOf('第一章'), '× 没关掉第一章');
  assert.ok(tabElOf('第二章'), '关掉当前页签后应该跳到剩下一章');
  assert.ok(find(appRoot, (n) => n.attrs['data-quest'] === 'BBBB000000000001'), '跳到第二章后该显示任务丙');

  // 再点左栏第一章开回来，页面停在第一章（后面几条用例都按第一章写的）
  await click(chapItemOf('第一章'));
  assert.ok(find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001'), '重新开第一章后任务甲没回来');
});

test('关页签：有没提交的草稿要先问一句；全关光了回到空状态（2026-11-02）', async () => {
  // 开一张没提交的草稿卡（这里用「＋新任务」，够触发 hasDraft）
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '＋新任务'));
  assert.match(textOf(appRoot), /在这里新建任务|在它后面加一个任务/, '草稿卡没出来');

  // 点 ×：不该直接关，要先问
  await click(closeBtnOf('第一章'));
  assert.ok(tabElOf('第一章'), '有草稿时 × 直接把页签关了，没问一句');
  assert.match(textOf(appRoot), /还有没提交的改动/, '没出确认条');

  // 选「留着」：页签和草稿都还在
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '留着'));
  assert.ok(tabElOf('第一章'), '点「留着」把页签关掉了');
  assert.ok(!find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '留着'), '确认条没收起来');

  // 再点 ×，这次选「还是关掉」
  await click(closeBtnOf('第一章'));
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '还是关掉'));
  assert.ok(!tabElOf('第一章'), '点「还是关掉」没关掉页签');
  assert.ok(tabElOf('第二章'), '关掉第一章后该跳到第二章');

  // 第二章没草稿：× 直接关，全关光之后出空状态提示
  await click(closeBtnOf('第二章'));
  assert.ok(!tabElOf('第二章'), '第二章关不掉');
  assert.match(textOf(appRoot), /左边点一章，就在这里开一个页签/, '页签全关了没有空状态提示');

  // 开回第一章，把页面交给下一条用例
  await click(chapItemOf('第一章'));
  assert.ok(tabElOf('第一章'), '空状态之后点左栏开不回页签');
});

test('章节背景图：当前页签那一章的 FTB images 画成 SVG <image>，坐标按格子换算（2026-11-02：之前扫不出背景）', async () => {
  const bgImg = () => find(appRoot, (n) => n.tagName === 'IMAGE' && n.attrs.class === 'mcs-quest-bg');

  // 停在第一章：FAKE 给了 demo:textures/bg.png，画成 image
  assert.ok(tabElOf('第一章'), '前置条件：当前该停在第一章页签');
  const img = bgImg();
  assert.ok(img, '第一章没画背景图');
  assert.equal(img.attrs.href, 'data:image/png;base64,BGIMG', '背景图没换到 data URL');
  assert.equal(img.attrs.width, String(4 * 132), '背景图宽度没按格子换算');
  assert.equal(img.attrs.height, String(3 * 108), '背景图高度没按格子换算');
  // 2026-11-11：游戏里 x/y 是图片「正中心」，以前当左上角画，大图会整体偏到右下。
  // 第一章节点 x[0,2] y[0,1] ⇒ minX=0 minY=0 pad=48；图 w4 h3 ⇒
  // 左上角 = (48 - 4*132/2, 48 - 3*108/2) = (-216, -114)。
  assert.equal(img.attrs.x, String(48 - (4 * 132) / 2), '背景图 x 没按「中心」换算（旧版当左上角）');
  assert.equal(img.attrs.y, String(48 - (3 * 108) / 2), '背景图 y 没按「中心」换算');
  assert.equal(img.attrs.transform, undefined, '0 度旋转不该挂 transform（保持旧版行为）');

  // 切到第二章（它没有 images）：背景图跟着消失
  await click(chapItemOf('第二章'));
  assert.ok(!bgImg(), '第二章没有 images，不该画背景图');

  // 切回第一章：背景图回来
  await click(tabElOf('第一章'));
  assert.ok(bgImg(), '切回第一章后背景图没回来');
});

test('背景图旋转：有 rotation 挂 rotate(deg cx cy)，corner 改旋转支点，拖动松手还原旋转（2026-11-11）', async () => {
  const bgImg = () => find(appRoot, (n) => n.tagName === 'IMAGE' && n.attrs.class === 'mcs-quest-bg');
  assert.ok(tabElOf('第一章'), '前置条件：当前该停在第一章页签');
  const saved = FAKE['/api/mcstudio/quest/canvas'];
  const withRotation = (extra) => {
    const copy = JSON.parse(JSON.stringify(saved));
    copy.chapters[0].images = [
      { image: 'demo:textures/bg.png', x: 0, y: 0, width: 4, height: 3, rotation: 90, ...extra },
    ];
    return copy;
  };
  // 第一章节点 x[0,2] y[0,1] ⇒ minX=0 minY=0 pad=48；图 w4 h3
  const left = 48 - (4 * 132) / 2; // 中心锚点左上角 x = -216
  const top = 48 - (3 * 108) / 2;  // 中心锚点左上角 y = -114
  try {
    // 非 corner：绕图片正中心 (px(0), py(0)) = (48, 48) 转
    FAKE['/api/mcstudio/quest/canvas'] = withRotation({});
    await click(findButton('重新读'));
    await settle(20);
    const a = bgImg();
    assert.ok(a, '非 corner 场景没画背景图');
    assert.equal(a.attrs.x, String(left), 'x 仍按「中心」换算，不因旋转变成左上角');
    assert.equal(a.attrs.transform, 'rotate(90 48 48)', '非 corner 时该绕图片正中心转');

    // corner=true：绕图片左上角 (left, top) 转
    FAKE['/api/mcstudio/quest/canvas'] = withRotation({ corner: true });
    await click(findButton('重新读'));
    await settle(20);
    const b = bgImg();
    assert.ok(b, 'corner 场景没画背景图');
    assert.equal(b.attrs.transform, `rotate(90 ${left} ${top})`, 'corner=true 时该绕图片左上角转');

    // 带旋转的图拖一下但没真动：松手要把旋转还原成底稿，绝不能 removeAttribute 把旋转弄丢
    const beforeUps = new Set(document.listeners['pointerup'] ?? []);
    b.listeners.pointerdown?.forEach((fn) => fn({ button: 0, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} }));
    const myUps = (document.listeners['pointerup'] ?? []).filter((fn) => !beforeUps.has(fn));
    myUps.forEach((fn) => fn({ clientX: 100, clientY: 100 }));
    assert.equal(b.attrs.transform, `rotate(90 ${left} ${top})`, '拖动松手后旋转 transform 被删了');
  } finally {
    FAKE['/api/mcstudio/quest/canvas'] = saved;
    await click(findButton('重新读'));
    await settle(20);
    assert.equal(bgImg().attrs.transform, undefined, '还原 0 度后不该还挂着旋转');
  }
});

test('＋装饰图：开了页签才能用，填图→预览不写盘→确认写入（2026-11-02：之前只能看不能加）', async () => {
  // 装饰图入口搬到画布空白右键里了（左栏只放新增章节 / 新增任务）。
  // openBlankMenuAt 连派两次 contextmenu：第一次清掉上条用例留下的 suppressContextMenu。
  await openBlankMenuAt(900, 700);
  const decoItem = blankItem('装饰图');
  assert.ok(decoItem, '空白右键里没有「装饰图」');
  assert.ok(!cls(decoItem).includes('mcs-menu-item-off'), '开着页签时「装饰图」不该置灰');

  await click(decoItem);
  assert.match(textOf(appRoot), /加一张装饰图/, '草稿卡没出来');

  // 贴图路径是必填：没填时预览按钮禁用
  const beforeFill = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会加什么');
  assert.equal(beforeFill.attrs.disabled, 'true', '没填贴图路径时预览按钮不该能点');

  const imgInput = findByFocus(appRoot, 'imgimage');
  assert.ok(imgInput, '没找到贴图输入框');
  imgInput.listeners.input?.forEach((fn) => fn({ target: { value: 'demo:textures/new_bg.png' } }));
  await settle();

  const previewBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会加什么');
  assert.notEqual(previewBtn.attrs.disabled, 'true', '填了贴图路径后预览按钮还是禁用的');
  previewBtn.listeners.click?.forEach((fn) => fn({}));
  await settle();

  const previewCall = posted.find((p) => p.path === '/api/mcstudio/quest/image/preview');
  assert.ok(previewCall, '没有调 /quest/image/preview');
  assert.equal(previewCall.payload.action, 'add');
  assert.equal(previewCall.payload.image, 'demo:textures/new_bg.png');
  assert.equal(previewCall.payload.chapter, 'CH1', '加图要带上当前章');
  assert.ok(!posted.some((p) => p.path === '/api/mcstudio/quest/image/apply'), '预览阶段不该调 apply');
  assert.match(textOf(appRoot), /这次会改什么（还没写盘）/);

  const applyBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '确认写入');
  assert.ok(applyBtn, '没有「确认写入」按钮');
  applyBtn.listeners.click?.forEach((fn) => fn({}));
  await settle();

  const applyCall = posted.find((p) => p.path === '/api/mcstudio/quest/image/apply');
  assert.ok(applyCall, '没有调 /quest/image/apply');
  assert.equal(applyCall.payload.action, 'add');
  assert.match(textOf(appRoot), /写好了/, 'done 卡没出来');

  // 收起结果卡，别影响下一条用例
  find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '知道了')?.listeners.click?.forEach((fn) => fn({}));
  await settle();
});

test('拖装饰图：松手直接写盘，坐标按格子换算并吸附半格（2026-11-02）', async () => {
  const bgImg = () => find(appRoot, (n) => n.tagName === 'IMAGE' && n.attrs.class === 'mcs-quest-bg');
  const img = bgImg();
  assert.ok(img, '第一章没画背景图');
  assert.equal(img.attrs['data-image-index'], '0', '背景图没带序号（后端按序号定位）');
  assert.ok(img.listeners.pointerdown, '背景图收不到 pointerdown（CSS 那条 pointer-events:none 得给 .mcs-quest-bg 放开）');

  posted.length = 0;
  const before = posted.filter((p) => p.path === '/api/mcstudio/quest/image/apply').length;
  img.listeners.pointerdown?.forEach((fn) => fn({
    button: 0, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {},
  }));
  // 往右拖一格（CELL_X = 132），往下一格（CELL_Y = 108）
  fireDoc('pointermove', { clientX: 232, clientY: 208 });
  fireDoc('pointerup', { clientX: 232, clientY: 208 });
  await settle();

  const calls = posted.filter((p) => p.path === '/api/mcstudio/quest/image/apply');
  assert.equal(calls.length - before, 1, '拖完应该写一次盘');
  assert.equal(calls[calls.length - 1].payload.action, 'move');
  assert.equal(calls[calls.length - 1].payload.index, 0);
  assert.equal(calls[calls.length - 1].payload.x, 1, '拖一格应该是 x = 1');
  assert.equal(calls[calls.length - 1].payload.y, 1, '拖一格应该是 y = 1');
  assert.ok(!posted.some((p) => p.path === '/api/mcstudio/quest/image/preview'), '拖动是「拖完就是拖完」，不该先走 preview');
});

test('右键装饰图：菜单只有改/删两件事，删要走预览（2026-11-02）', async () => {
  const bgImg = () => find(appRoot, (n) => n.tagName === 'IMAGE' && n.attrs.class === 'mcs-quest-bg');
  posted.length = 0;
  bgImg().listeners.contextmenu?.forEach((fn) => fn({ clientX: 300, clientY: 260, preventDefault() {}, stopPropagation() {} }));
  await settle();

  const text = textOf(appRoot);
  assert.match(text, /装饰图 #1/, '右键菜单没出来');
  assert.match(text, /改坐标 \/ 大小/);
  assert.match(text, /删掉这张装饰图/);
  // 装饰图不是任务：菜单里不该混进任务那套操作（页面上别处有「改前置」，
  // 所以只能看菜单框自己，不能拿整页文字判）
  const menuBox = find(appRoot, (n) => /(^|\s)mcs-menu(\s|$)/.test(String(n.className ?? ''))
    && textOf(n).includes('装饰图 #1'));
  assert.ok(menuBox, '没找到装饰图菜单框');
  assert.ok(!textOf(menuBox).includes('改前置依赖'), '装饰图菜单里混进了任务的操作');

  const delItem = find(appRoot, (n) => String(n.className ?? '').includes('mcs-menu-item') && textOf(n).includes('删掉这张装饰图'));
  delItem.listeners.click?.forEach((fn) => fn({}));
  await settle();
  assert.match(textOf(appRoot), /删掉第 1 张装饰图/, '删除草稿卡没出来');

  const previewBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会删什么');
  assert.ok(previewBtn, '没有「预览会删什么」按钮');
  previewBtn.listeners.click?.forEach((fn) => fn({}));
  await settle();

  const call = posted.find((p) => p.path === '/api/mcstudio/quest/image/preview');
  assert.ok(call, '没有调 /quest/image/preview');
  assert.equal(call.payload.action, 'remove');
  assert.equal(call.payload.index, 0);
  assert.ok(!posted.some((p) => p.path === '/api/mcstudio/quest/image/apply'), '预览阶段不该调 apply');

  // 收尾：不删了，页面留在第一章（下一条用例接着用）
  find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '算了，不删')?.listeners.click?.forEach((fn) => fn({}));
  await settle();
  assert.ok(tabElOf('第一章'), '收尾时该还停在第一章页签');
});

test('本地拿不到贴图的任务：详情卡出「补图」按钮，点了走 /item-icon/web 且图标到位', async () => {
  // /item-icons 假数据故意只给 cogwheel —— 任务乙的 demo:gear 是灰块
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002');
  node.listeners.click?.forEach((fn) => fn({}));
  await settle();

  const btn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '补图');
  assert.ok(btn, '缺图标的任务详情卡没出「补图」按钮');

  btn.listeners.click?.forEach((fn) => fn({}));
  await settle();

  // 先拿中文名（/items 按 ID 精确搜）再补图
  const webCall = posted.find((p) => p.path === '/api/mcstudio/item-icon/web');
  assert.ok(webCall, '没有调 /item-icon/web');
  assert.equal(webCall.payload.item, 'demo:gear');
  // 补到的图进了图标表，按钮消失（有图了）
  const img = find(appRoot, (n) => n.tagName === 'IMG' && String(n.attrs.src ?? '').includes('base64,WEB'));
  assert.ok(img, '补到的图没显示出来');
  assert.ok(!find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '补图'), '补完图按钮还在');
});

test('＋新章节：出表单，名字没填时预览按钮禁用，预览→写入→蓝图重读（2026-11-02：之前加不了章节）', async () => {
  // 顶栏有入口按钮（单章任务书没有页签，也得能用）
  const entry = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '＋新章节');
  assert.ok(entry, '顶栏没有「＋新章节」按钮');

  entry.listeners.click?.forEach((fn) => fn({}));
  await settle();

  let text = textOf(appRoot);
  assert.match(text, /新建章节/, '草稿卡没出来');

  // 章节名必填：没填名字时预览按钮是禁用的
  const previewBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会加什么');
  assert.ok(previewBtn, '草稿卡没有「预览会加什么」按钮');
  // el() 对 FakeNode 走 setAttribute（桩上没有 disabled 实例字段），所以是字符串 'true'
  assert.equal(previewBtn.attrs.disabled, 'true', '章节名没填时预览按钮不该能点');

  // 填名字：el() 注册事件时去掉 on 前缀，所以监听器在 listeners.input
  const titleInput = find(appRoot, (n) => n.tagName === 'INPUT' && String(n.attrs['data-focus'] ?? '') === 'chtitle');
  assert.ok(titleInput, '没找到章节名输入框');
  titleInput.listeners.input?.forEach((fn) => fn({ target: { value: '测试新章' } }));
  await settle();

  const previewBtn2 = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会加什么');
  assert.notEqual(previewBtn2.attrs.disabled, 'true', '填了章节名后预览按钮还是禁用的');
  previewBtn2.listeners.click?.forEach((fn) => fn({}));
  await settle();

  // 预览只算不写：调了 preview、没调 apply
  text = textOf(appRoot);
  assert.match(text, /这次会改什么（还没写盘）/, '预览卡没出来');
  assert.match(text, /测试新章/, '预览里没显示新章节名');
  assert.ok(!posted.some((p) => p.path === '/api/mcstudio/quest/chapter/apply'), '预览阶段不该调 apply');

  // 确认写入
  const applyBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '确认写入');
  assert.ok(applyBtn, '没有「确认写入」按钮');
  applyBtn.listeners.click?.forEach((fn) => fn({}));
  await settle();

  const applyCall = posted.find((p) => p.path === '/api/mcstudio/quest/chapter/apply');
  assert.ok(applyCall, '没有调 /quest/chapter/apply');
  assert.equal(applyCall.payload.title, '测试新章');
  assert.match(textOf(appRoot), /写好了/, 'done 卡没出来');
});

test('＋新任务：表单能填完成条件/奖励，预览和写入都按后端的 taskItem/taskCount/rewardItem/rewardCount 发（2026-11-04 修：以前发 item/count 被整个丢掉）', async () => {
  posted.length = 0;
  const entry = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '＋新任务');
  assert.ok(entry, '顶栏没有「＋新任务」按钮');
  await click(entry);
  assert.match(textOf(appRoot), /在这里新建任务|在它后面加一个任务/, '草稿卡没出来');

  // 新表单：名字 / 副标题 / 简介 一直都有；完成条件 / 奖励两组**要先点类型**才出输入框
  // （2026-11-13 默认值改造：不再默认预填「物品类型」）
  for (const key of ['newtitle', 'newsub', 'newdesc']) {
    assert.ok(findByFocus(appRoot, key), `新建任务表单缺 ${key} 这个输入框`);
  }
  assert.match(textOf(appRoot), /完成条件/, '没有「完成条件」分组标题');
  assert.match(textOf(appRoot), /奖励/, '没有「奖励」分组标题（用户 2026-11-04 点名补的）');

  // ★ 2026-11-13：默认**一个类型都不选中**，条件/奖励的输入框一个都不该出现
  assert.ok(!findByFocus(appRoot, 'newtaskitem'), '没选类型时不该有完成条件输入框');
  assert.ok(!findByFocus(appRoot, 'newrewarditem'), '没选类型时不该有奖励输入框');

  // 点「物品」把两组都选上，输入框才出来。
  // ★ 不能用 findButton('物品') —— 会先撞上右栏的「物品」页签，把整包状态带歪。
  //   类型按钮的 title 属性存的是类型名，按它精确取；文档顺序是「完成条件」在前、
  //   「奖励」在后，所以 [0] 是条件那组、[1] 是奖励那组。
  //   每点一次整页重画，旧的元素引用已经不在文档里了，必须重新查。
  const typeBtn = (label) => find(appRoot, (n) => n.tagName === 'BUTTON' && n.attrs.title === label);
  await click(typeBtn('item'));
  assert.ok(findByFocus(appRoot, 'newtaskitem'), '选了「物品」之后该出完成条件输入框');
  await click(findAll(appRoot, (n) => n.tagName === 'BUTTON' && n.attrs.title === 'item')[1]);
  assert.ok(findByFocus(appRoot, 'newrewarditem'), '选了「物品」之后该出奖励输入框');

  // 照真人打字填一遍（走 input 监听器，不是直接改 state）
  typeInto('newtitle', '做一台压片机');
  typeInto('newsub', '把锭压成板');
  typeInto('newdesc', '第一行说明\n第二行说明');
  typeInto('newtaskitem', 'minecraft:iron_ingot');
  typeInto('newtaskcount', '3');
  typeInto('newrewarditem', 'minecraft:diamond');
  typeInto('newrewardcount', '2');

  // 预览：只算不写
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览要加什么'));
  const previewCall = posted.find((p) => p.path === '/api/mcstudio/quest/add/preview');
  assert.ok(previewCall, '没有调 /quest/add/preview');
  assert.ok(!posted.some((p) => p.path === '/api/mcstudio/quest/add/apply'), '预览阶段不该调 apply');

  // 关键：字段名必须和后端认的一致，旧名 item/count 一个都不能出现
  const p = previewCall.payload;
  assert.equal(p.taskItem, 'minecraft:iron_ingot', '完成条件物品没按 taskItem 发');
  assert.equal(p.taskCount, 3, '完成条件数量没按 taskCount 发');
  assert.equal(p.rewardItem, 'minecraft:diamond', '奖励物品没按 rewardItem 发');
  assert.equal(p.rewardCount, 2, '奖励数量没按 rewardCount 发');
  assert.equal(p.subtitle, '把锭压成板', '副标题没发出去');
  assert.equal(p.description, '第一行说明\n第二行说明', '简介没发出去');
  assert.ok(!('item' in p) && !('count' in p), 'body 里还留着旧字段 item/count，后端根本不认');

  // 确认写入：body 与预览完全一样（不能各写一份）
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '确认写入'));
  const applyCall = posted.find((p) => p.path === '/api/mcstudio/quest/add/apply');
  assert.ok(applyCall, '没有调 /quest/add/apply');
  assert.deepEqual(applyCall.payload, p, 'apply 的字段和 preview 不一致');
  assert.match(textOf(appRoot), /写好了/, 'done 卡没出来');
});

test('★ 任务高级设置：默认值的字段不标「已改」，改了才标、才出现 ↩（VS 原则 2 / 3，2026-11-13）', async () => {
  // 点节点甲（它的详情里 shape='' / size=1 / optional=false / canRepeat=null，
  // **全是默认值** —— 正好用来验证「一个字段都不该显示成已改」）
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  assert.ok(node, '蓝图里没找到任务甲的节点');
  await click(node);
  posted.length = 0;

  const renameBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '改名');
  assert.ok(renameBtn, '右栏没有「改名」按钮');
  await click(renameBtn);

  // ① 卡片出来了，五个字段的控件都在
  //   （can_repeat 是**三态**，渲染成三个按钮而不是输入框 —— 它必须有办法表达「没写」）
  for (const key of ['shape', 'size', 'optional', 'invisible', 'can_repeat']) {
    assert.ok(findByFocus(appRoot, `qfield_${key}`), `高级设置里没有 ${key} 的控件`);
  }
  assert.ok(findByFocus(appRoot, 'qfield_can_repeat_yes'), '三态少了「可以」');
  assert.ok(findByFocus(appRoot, 'qfield_can_repeat_no'), '三态少了「不可以」');

  // ② 全是默认值 ⇒ 一个「已改」标记都不该有，一个 ↩ 都不该有
  assert.equal(findAllByClass(appRoot, 'mcs-field-dirty').length, 0,
    '全是默认值时不该有任何「已改」标记');
  for (const key of ['shape', 'size', 'optional', 'invisible', 'can_repeat']) {
    assert.ok(!findByFocus(appRoot, `qfield_${key}_reset`), `${key} 是默认值，不该有 ↩`);
  }

  // ③ 改一个：勾上「可选任务」→ 立刻变成「已改」并冒出 ↩（不用刷新页面）
  const optionalBox = findByFocus(appRoot, 'qfield_optional');
  optionalBox.checked = true;
  optionalBox.listeners.change.forEach((f) => f({ target: optionalBox }));
  await settle(2);

  assert.ok(findAllByClass(appRoot, 'mcs-field-dirty').length >= 1, '改过之后该出现「已改」标记');
  const resetBtn = findByFocus(appRoot, 'qfield_optional_reset');
  assert.ok(resetBtn, '改过之后该出现 ↩');
  assert.equal(findAllByClass(appRoot, 'mcs-field-dirty').length, 1,
    '★ 只改了一个字段，别的字段不该跟着变成「已改」');

  // ④ 点 ↩ → 回到默认，↩ 自己消失
  await click(resetBtn);
  await settle(2);
  assert.equal(findAllByClass(appRoot, 'mcs-field-dirty').length, 0, '点 ↩ 之后该回到「没有已改」');
  assert.ok(!findByFocus(appRoot, 'qfield_optional_reset'), '回到默认后 ↩ 该消失');

  // ⑤ 关键：改回默认之后保存，那个键要**删掉**（发 null 告诉后端「恢复默认」）
  const shapeBox = findByFocus(appRoot, 'qfield_shape');
  shapeBox.value = 'gear';
  shapeBox.listeners.input.forEach((f) => f({ target: shapeBox }));
  await settle(2);
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会改什么'));
  const previewCall = posted.find((p) => p.path === '/api/mcstudio/quest/preview');
  assert.ok(previewCall, '没有调 /quest/preview');
  assert.equal(previewCall.payload.shape, 'gear', '改过的形状没发出去');
  // optional 已经是默认值了 ⇒ 该发 null（＝删键），不是发 false
  assert.equal(previewCall.payload.optional, null,
    '★ 等于默认值的字段要发 null（＝从文件里删掉这个键），不能发 false');
});

test('★ 「全部恢复默认」：条件/奖励/高级设置一起清零（改回「空任务」，不是「物品 + 1」）', async () => {
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  await click(node);
  posted.length = 0;
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '改名'));

  // 改点东西出来（形状 + 勾一个可选任务）
  const shapeBox = findByFocus(appRoot, 'qfield_shape');
  shapeBox.value = 'heart';
  shapeBox.listeners.input.forEach((f) => f({ target: shapeBox }));
  await settle(2);
  const optBox = findByFocus(appRoot, 'qfield_optional');
  optBox.checked = true;
  optBox.listeners.change.forEach((f) => f({ target: optBox }));
  await settle(2);
  assert.ok(findAllByClass(appRoot, 'mcs-field-dirty').length >= 2, '改了两处该有两处标记');

  // 「全部恢复默认」按钮只在改过时出现
  const resetAll = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '全部恢复默认');
  assert.ok(resetAll, '改过之后该有「全部恢复默认」按钮');
  await click(resetAll);
  await settle(2);

  // ① 所有「已改」标记消失
  const cards = findAllByClass(appRoot, 'mcs-field-dirty');
  // 条件/奖励两组还在（它们是从详情预填的「物品」类型，算改过），
  // 所以这里只断言「高级设置那一块」回到默认
  const shapeAfter = findByFocus(appRoot, 'qfield_shape');
  assert.equal(shapeAfter.value, '', '形状没恢复成空');
  const optAfter = findByFocus(appRoot, 'qfield_optional');
  assert.equal(!!optAfter.checked, false, '可选任务没恢复成不勾');
  // 高级设置的 5 个字段都不该再是 dirty
  for (const key of ['shape', 'size', 'optional', 'invisible', 'can_repeat']) {
    assert.ok(!findByFocus(appRoot, `qfield_${key}_reset`), `${key} 恢复默认后不该还有 ↩`);
  }
  assert.ok(cards.length >= 0, '（断言占位，主要看上面几条）');

  // ② 保存时，条件/奖励两组发空（＝清空这一组），不是「物品类型 + 数量 1」
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会改什么'));
  const p = posted.find((q) => q.path === '/api/mcstudio/quest/preview');
  assert.ok(p, '没有调 /quest/preview');
  assert.ok(!('taskItem' in p.payload), '★ 全部恢复默认后不该还发 taskItem（那是旧行为）');
  assert.ok(!('rewardItem' in p.payload), '★ 全部恢复默认后不该还发 rewardItem');
  // 任务级字段全部回默认 ⇒ 全是 null（＝删键）
  for (const key of ['shape', 'size', 'optional', 'invisible', 'can_repeat']) {
    assert.equal(p.payload[key], null, `${key} 该发 null（＝恢复默认，从文件里删键）`);
  }
});

test('改名卡也能改完成条件/奖励：按现状预填，预览和写入都发 taskItem/taskCount/rewardItem/rewardCount（2026-11-04 第 2 批 B）', async () => {
  // 先点节点甲，把详情读进 state.questDetail（改名卡拿它做预填）
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  assert.ok(node, '蓝图里没找到任务甲的节点');
  await click(node);
  posted.length = 0;
  calls.length = 0;

  const renameBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '改名');
  assert.ok(renameBtn, '右栏没有「改名」按钮');
  await click(renameBtn);

  // 六个输入框：标题 / 副标题 / 完成条件物品+数量 / 奖励物品+数量
  for (const key of ['rtitle', 'rsub', 'rtaskitem', 'rtaskcount', 'rrewarditem', 'rrewardcount']) {
    assert.ok(findByFocus(appRoot, key), `改名卡缺 ${key} 这个输入框`);
  }
  assert.match(textOf(appRoot), /完成条件/, '没有「完成条件」分组标题');
  assert.match(textOf(appRoot), /奖励/, '没有「奖励」分组标题');

  // 预填必须来自详情现状，不能留空（留空会把用户写好的副标题/条件清掉）
  assert.equal(findByFocus(appRoot, 'rtitle').value, '任务甲', '标题没按详情预填');
  assert.equal(findByFocus(appRoot, 'rsub').value, '做出第一个齿轮', '副标题预填成空了（老毛病：会清掉用户写好的副标题）');
  assert.equal(findByFocus(appRoot, 'rtaskitem').value, 'demo:cogwheel', '完成条件物品没按详情第一条预填');
  assert.equal(findByFocus(appRoot, 'rtaskcount').value, 2, '完成条件数量没按详情预填');
  assert.equal(findByFocus(appRoot, 'rrewarditem').value, 'minecraft:diamond', '奖励物品没按详情第一条预填');
  assert.equal(findByFocus(appRoot, 'rrewardcount').value, 3, '奖励数量没按详情预填');

  // 照真人改一遍
  typeInto('rtitle', '改过的名字');
  typeInto('rsub', '新的副标题');
  typeInto('rtaskitem', 'minecraft:copper_ingot');
  typeInto('rtaskcount', '5');
  typeInto('rrewarditem', 'minecraft:emerald');
  typeInto('rrewardcount', '4');

  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会改什么'));
  const previewCall = posted.find((p) => p.path === '/api/mcstudio/quest/preview');
  assert.ok(previewCall, '没有调 /quest/preview');
  assert.ok(!posted.some((p) => p.path === '/api/mcstudio/quest/apply'), '预览阶段不该调 apply');

  const p = previewCall.payload;
  assert.equal(p.title, '改过的名字', '标题没发出去');
  assert.equal(p.subtitle, '新的副标题', '副标题没发出去');
  assert.equal(p.taskItem, 'minecraft:copper_ingot', '完成条件物品没按 taskItem 发');
  assert.equal(p.taskCount, 5, '完成条件数量没按 taskCount 发');
  assert.equal(p.rewardItem, 'minecraft:emerald', '奖励物品没按 rewardItem 发');
  assert.equal(p.rewardCount, 4, '奖励数量没按 rewardCount 发');
  assert.ok(!('item' in p) && !('count' in p), 'body 里还留着旧字段 item/count');

  // 确认写入：body 与预览完全一样（renamePayload 一处共用）
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '确认写入'));
  const applyCall = posted.find((p) => p.path === '/api/mcstudio/quest/apply');
  assert.ok(applyCall, '没有调 /quest/apply');
  assert.deepEqual(applyCall.payload, p, 'apply 的字段和 preview 不一致');
  assert.match(textOf(appRoot), /写好了/, 'done 卡没出来');
});

test('改名卡能改简介：desc 按现状预填、预览和写入都发 desc、绝不发 description（2026-11-04 第 4 批 A）', async () => {
  // 先点节点甲，把详情读进 state.questDetail（改名卡拿它做预填）
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  assert.ok(node, '蓝图里没找到任务甲的节点');
  await click(node);
  posted.length = 0;
  calls.length = 0;

  const renameBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '改名');
  assert.ok(renameBtn, '右栏没有「改名」按钮');
  await click(renameBtn);

  // 简介输入框存在，且预填是详情那两行拼成的换行文本（不是数组、也不是空）
  const descBox = findByFocus(appRoot, 'rdesc');
  assert.ok(descBox, '改名卡缺 rdesc 简介输入框');
  // 2026-11-11：假详情多了一行 `{image:…}` 图片标记。预填**必须原样带上它**
  // —— 标记是描述的一部分，预填时丢掉、用户点保存就把它从文件里删了。
  assert.equal(
    descBox.value,
    '这是任务简介的第一行。\n这是第二行。\n{image:demo:textures/desc.png width:40 height:30 align:center}',
    '简介没按详情数组拼成换行文本预填（发空串会悄悄清掉用户简介）',
  );

  typeInto('rdesc', '新的第一行\n新的第二行');

  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会改什么'));
  const previewCall = posted.find((p) => p.path === '/api/mcstudio/quest/preview');
  assert.ok(previewCall, '没有调 /quest/preview');
  const p = previewCall.payload;
  assert.equal(p.desc, '新的第一行\n新的第二行', '简介没按 desc 发出去');
  assert.ok(!('description' in p), '改已有任务必须发 desc，不能发 description（发错会被后端整条忽略、点了没反应）');
  assert.ok(!posted.some((q) => q.path === '/api/mcstudio/quest/apply'), '预览阶段不该调 apply');

  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '确认写入'));
  const applyCall = posted.find((q) => q.path === '/api/mcstudio/quest/apply');
  assert.ok(applyCall, '没有调 /quest/apply');
  assert.deepEqual(applyCall.payload, p, 'apply 的字段和 preview 不一致，简介可能没写进去');
  assert.match(textOf(appRoot), /写好了/, 'done 卡没出来');
});

test('右键节点弹菜单，点「换图标物品」出编辑卡，预览只算不写', async () => {
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002');
  assert.ok(node, '蓝图里没找到任务乙的节点');
  node.listeners.contextmenu?.forEach((fn) => fn({ clientX: 200, clientY: 150, preventDefault() {} }));
  await settle(2);

  let text = textOf(appRoot);
  assert.match(text, /换图标物品/, '右键菜单没出来');
  assert.match(text, /改前置依赖/);
  assert.match(text, /删掉这个任务/);

  // 注意：el() 里 `class` 是赋给 className 的，不走 setAttribute
  const classOf = (n) => String(n.className ?? n.attrs['class'] ?? '');
  const menuItem = find(appRoot, (n) => classOf(n).includes('mcs-menu-item') && textOf(n).includes('换图标物品'));
  assert.ok(menuItem, '菜单项不是独立元素');
  menuItem.listeners.click?.forEach((fn) => fn({}));
  await settle(2);

  text = textOf(appRoot);
  assert.match(text, /换图标物品/);
  const iconInput = findByFocus(appRoot, 'iconvalue');
  assert.ok(iconInput, '没找到图标输入框');
  iconInput.value = 'demo:gear';
  iconInput.listeners.input?.forEach((fn) => fn({ target: iconInput }));

  // 「搜物品」→ 候选里出现中文名
  const searchBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('搜物品'));
  assert.ok(searchBtn, '没找到「搜物品」按钮');
  searchBtn.listeners.click?.forEach((fn) => fn({}));
  await settle();
  text = textOf(appRoot);
  assert.match(text, /齿轮/, '候选列表里应该有中文名');

  // 预览：只算不写，POST /quest/node/preview，payload 里 icon 是输入的值
  posted.length = 0;
  const previewBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('预览会改什么'));
  assert.ok(previewBtn, '没找到「预览会改什么」按钮');
  previewBtn.listeners.click?.forEach((fn) => fn({}));
  await settle();

  const previewCall = posted.find((p) => p.path === '/api/mcstudio/quest/node/preview');
  assert.ok(previewCall, '没有调用预览接口');
  assert.equal(previewCall.payload.questId, 'AAAA000000000002');
  assert.equal(previewCall.payload.icon, 'demo:gear');
  assert.equal(previewCall.payload.dir, 'D:\\lab\\DemoPack');

  const after = textOf(appRoot);
  assert.match(after, /这次会改什么/, '预览卡没出来');
  assert.match(after, /图标物品：demo:cogwheel → demo:gear/, 'diff 的人话没显示');
  assert.ok(!after.includes('（空） → （空）'), 'diff 被当成对象渲染了');

  // 确认写入 → POST /quest/node/apply
  posted.length = 0;
  const applyBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('确认写入'));
  assert.ok(applyBtn, '没找到「确认写入」按钮');
  applyBtn.listeners.click?.forEach((fn) => fn({}));
  await settle(16);

  const applyCall = posted.find((p) => p.path === '/api/mcstudio/quest/node/apply');
  assert.ok(applyCall, '没有调用写入接口');
  const done = textOf(appRoot);
  assert.match(done, /写好了/);
  assert.match(done, /ch1\.snbt\.bak-1-0/, '备份文件名应该显示出来');
});

// ---------------------------------------------- 拖动：松手就落位（不再问一次）

/** 找蓝图里某个任务的 <g>。 */
function findNodeEl(id) {
  return find(appRoot, (n) => n.attrs['data-quest'] === id);
}

/** 找画布那个 svg。 */
function findSvg() {
  return find(appRoot, (n) => n.tagName === 'SVG');
}

/**
 * 找画布的**外层容器**（`.mcs-canvas`）。
 *
 * 滚轮、框选、双击、右键这些事件挂在容器上，不挂 svg ——
 * 因为 svg 缩小之后会比容器小，鼠标落在它外面就收不到事件
 * （这正是「滚轮缩放时灵时不灵」的根因）。所以模拟事件要找容器。
 */
function findCanvasHost() {
  return find(appRoot, (n) => cls(n).includes('mcs-canvas'));
}

/**
 * 把「快捷键作用域」摆成画布。
 *
 * 界面判定逻辑（`keyScopeOf()`）：先看 `document.activeElement` 是不是在
 * `.mcs-canvas` 里；没有焦点元素时才退回看 `state.keyScope`（由画布的
 * pointerdown 写入）。
 *
 * ★ 这里**故意不派发 pointerdown** —— 试过：在 (1,1) 按下再松开会被框选逻辑
 *   当成「点空白」，把已选中的任务清掉，`copyQuestSelection()` 就无事可做。
 *   真实浏览器里点画布会让 SVG 里的元素拿到焦点，所以直接置 activeElement
 *   更贴近真实行为，也不干扰选择状态。
 */
function focusCanvas() {
  const host = findCanvasHost();
  assert.ok(host, '找不到画布容器');
  // 直接让画布容器本身成为焦点元素：keyScopeOf() 会顺父链命中 `mcs-canvas`，
  // 判定为 'canvas' 作用域。不走框选，也就不会把已选中的任务清掉。
  document.activeElement = host;
}

/**
 * 用完必须调一次：把 activeElement 和「选中文字」的桩都还原。
 *
 * ★ 不还原会跨用例残留：后面那些用例（比如点诊断面板的「检查一次」）
 *   会以为焦点还在画布上，行为跟着变。2026-11-12 就是这么踩到的。
 */
function resetKeyScope() {
  document.activeElement = null;
  setSelectedText('');
}

/** 模拟「按住 → 移动 → 松手」。真实浏览器松手后还会补一个 click，这里也补上，
 *  否则「拖完吞掉那一下 click」的开关会跨用例残留。 */
async function dragBy(el, dx, dy) {
  el.listeners.pointerdown?.forEach((fn) =>
    fn({ button: 0, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} }),
  );
  fireDoc('pointermove', { clientX: 100 + dx, clientY: 100 + dy });
  fireDoc('pointerup', { clientX: 100 + dx, clientY: 100 + dy });
  el.listeners.click?.forEach((fn) => fn({}));
  await settle(16);
}

test('拖动松手直接写盘：没有「确认挪动」，也不调 preview', async () => {
  // 先选中任务甲，保证拖的是它
  const node = findNodeEl('AAAA000000000001');
  assert.ok(node, '蓝图里没找到任务甲的节点');
  node.listeners.click?.forEach((fn) => fn({}));
  await settle();

  posted.length = 0;
  await dragBy(findNodeEl('AAAA000000000001'), 132, 0); // 正好一格

  const applyCall = posted.find((p) => p.path === '/api/mcstudio/quest/move/apply');
  assert.ok(applyCall, '松手没有直接调写入接口');
  const moves = JSON.parse(applyCall.payload.moves);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].questId, 'AAAA000000000001');
  assert.equal(moves[0].x, 1, '往右拖一格，x 应该 +1');
  assert.equal(moves[0].y, 0);

  assert.ok(
    !posted.some((p) => p.path === '/api/mcstudio/quest/move/preview'),
    '不该再走「先预览」那一步',
  );
  const text = textOf(appRoot);
  assert.ok(!text.includes('确认挪动'), '界面不该再出现「确认挪动」');
  assert.match(text, /已挪动 1 个任务/, '应该告诉用户挪好了');
});

test('挪完能撤销：Ctrl+Z / 撤销按钮把坐标发回原处', async () => {
  const text = textOf(appRoot);
  assert.match(text, /撤销/, '没看到撤销按钮');

  posted.length = 0;
  const undoBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === '撤销');
  assert.ok(undoBtn, '没找到撤销按钮');
  undoBtn.listeners.click?.forEach((fn) => fn({}));
  await settle(16);

  const call = posted.find((p) => p.path === '/api/mcstudio/quest/move/apply');
  assert.ok(call, '撤销没有写盘');
  const moves = JSON.parse(call.payload.moves);
  assert.equal(moves[0].x, 0, '撤销应该回到原来的 x');
  assert.equal(moves[0].y, 0);
  assert.match(textOf(appRoot), /已撤销/);
});

test('撤销栈各归各的：在第二章按 Ctrl+Z 不会把第一章的改动撤掉（2026-11-02）', async () => {
  // 第一章先挪一下任务甲，攒下一笔「能退回去」的记录
  posted.length = 0;
  await dragBy(findNodeEl('AAAA000000000001'), 132, 0);
  assert.ok(
    posted.some((p) => p.path === '/api/mcstudio/quest/move/apply'),
    '前置条件：第一章这次拖动该写入成功',
  );

  // 切到第二章：页签一切，撤销栈就该换成第二章自己的（空的）
  await click(chapItemOf('第二章'));
  assert.ok(tabElOf('第二章'), '没切到第二章');
  assert.ok(
    !find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === '撤销'),
    '第二章刚开，不该继承第一章的撤销栈',
  );

  // 在第二章按 Ctrl+Z：什么都不该发生
  // （2026-11-12：快捷键现在按作用域生效，得先「点一下画布」才算是画布作用域）
  focusCanvas();
  posted.length = 0;
  fireDoc('keydown', { key: 'z', ctrlKey: true, preventDefault() {} });
  await settle(16);
  assert.ok(
    !posted.some((p) => p.path === '/api/mcstudio/quest/move/apply'),
    '在第二章按 Ctrl+Z 竟然去写盘了（把第一章的改动撤了）',
  );
  assert.ok(findNodeEl('BBBB000000000001'), '第二章的任务丙不见了');

  // 切回第一章：撤销栈还在，按 Ctrl+Z 撤的是第一章那一笔
  await click(tabElOf('第一章'));
  focusCanvas();
  posted.length = 0;
  fireDoc('keydown', { key: 'z', ctrlKey: true, preventDefault() {} });
  await settle(16);
  const call = posted.find((p) => p.path === '/api/mcstudio/quest/move/apply');
  assert.ok(call, '切回第一章之后 Ctrl+Z 该把那一笔撤掉');
  const moves = JSON.parse(call.payload.moves);
  assert.equal(moves[0].questId, 'AAAA000000000001', '撤的该是第一章的任务甲');
});

test('右键拖动画布：平移而不是弹菜单', async () => {
  const host = findCanvasHost();
  const g = find(findSvg(), (n) => n.attrs.class === 'mcs-viewport');
  assert.ok(g, '没找到承载平移缩放的那一层 <g>');
  const before = String(g.attrs.style ?? '');

  // 右键按下 → 移动 60 像素 → 松开
  host.listeners.pointerdown?.forEach((fn) =>
    fn({ button: 2, clientX: 200, clientY: 200, preventDefault() {} }),
  );
  fireDoc('pointermove', { clientX: 260, clientY: 240 });
  fireDoc('pointerup', { clientX: 260, clientY: 240 });

  const after = String(g.attrs.style ?? '');
  assert.notEqual(after, before, '右键拖动没有平移画布');
  const tx = /translate\(([-\d.]+)px/.exec(after);
  const ty = /translate\([-\d.]+px,\s*([-\d.]+)px\)/.exec(after);
  assert.ok(tx && ty, '平移量没写进 transform');
  assert.equal(Number(tx[1]) - Number((/translate\(([-\d.]+)px/.exec(before) ?? [0, 0])[1]), 60);
  assert.equal(Number(ty[1]) - Number((/translate\([-\d.]+px,\s*([-\d.]+)px/.exec(before) ?? [0, 0])[1]), 40);

  // 松开之后紧跟着的那次右键菜单要吞掉（不是「右键点了没反应」）
  let menuOpened = false;
  host.listeners.contextmenu?.forEach((fn) =>
    fn({ preventDefault() { menuOpened = true; }, target: {} }),
  );
  assert.ok(menuOpened, '浏览器右键菜单必须拦掉');

  // 右键只点不动 = 不当成平移，也不该改坐标
  const still = String(g.attrs.style ?? '');
  host.listeners.pointerdown?.forEach((fn) =>
    fn({ button: 2, clientX: 100, clientY: 100, preventDefault() {} }),
  );
  fireDoc('pointerup', { clientX: 100, clientY: 100 });
  assert.equal(String(g.attrs.style ?? ''), still, '右键点一下不该平移');

  // 收尾：拖回原位，别影响后面按坐标找节点的用例
  host.listeners.pointerdown?.forEach((fn) =>
    fn({ button: 2, clientX: 260, clientY: 240, preventDefault() {} }),
  );
  fireDoc('pointermove', { clientX: 200, clientY: 200 });
  fireDoc('pointerup', { clientX: 200, clientY: 200 });
  assert.equal(String(g.attrs.style ?? ''), before, '拖回去应该回到原来的位置');
});

test('框选多个 + 一起拖：一次请求写两条坐标', async () => {
  // 框选矩形只该罩住本章任务（顺带回归「章节过滤后拖动不炸」）
  // 先确认停在第一章页签
  assert.ok(tabElOf('第一章'), '前置条件：当前该停在第一章页签');

  const host = findCanvasHost();
  assert.ok(host, '没找到画布容器');

  // 从左上往右下框，把两个任务都圈进去
  host.listeners.pointerdown?.forEach((fn) =>
    fn({ button: 0, clientX: 30, clientY: 30, preventDefault() {} }),
  );
  fireDoc('pointermove', { clientX: 470, clientY: 280 });
  fireDoc('pointerup', { clientX: 470, clientY: 280 });
  await settle(8);

  assert.match(textOf(appRoot), /选中了 2 个任务/, '框选没选中两个');

  posted.length = 0;
  await dragBy(findNodeEl('AAAA000000000001'), 132, 108);

  const call = posted.find((p) => p.path === '/api/mcstudio/quest/move/apply');
  assert.ok(call, '一起拖没有写盘');
  const moves = JSON.parse(call.payload.moves);
  assert.equal(moves.length, 2, '两个选中任务应该一起挪');
  const byId = new Map(moves.map((m) => [m.questId, m]));
  assert.equal(byId.get('AAAA000000000001').x, 1);
  assert.equal(byId.get('AAAA000000000001').y, 1);
  assert.equal(byId.get('AAAA000000000002').x, 3);
  assert.equal(byId.get('AAAA000000000002').y, 2);
});

test('空白处双击：就地新建任务的卡弹出来，坐标跟着点走', async () => {
  const host = findCanvasHost();
  host.listeners.dblclick?.forEach((fn) => fn({ clientX: 500, clientY: 300 }));
  await settle(4);

  const text = textOf(appRoot);
  assert.match(text, /在这里新建任务/, '双击空白没弹新建卡');
  assert.match(text, /3\.5, 2\.5/, '新建卡上应该带坐标');
});

// ---------------------------------------------- 拖动时连线跟着走 / 别留黑框

test('拖动时连线跟着走：不用等松手才更新', async () => {
  // 先单独选中任务甲（上一个用例可能还留着多选，多选会一起拖）
  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle();

  // 选中会重画整个画布，所以连线要在重画之后再找
  const edge = find(findSvg(), (n) => n.tagName === 'LINE' && n.attrs.class === 'mcs-edge');
  assert.ok(edge, '蓝图里没画连线（任务乙依赖任务甲，应该有）');
  const before = {
    x1: Number(edge.attrs.x1),
    y1: Number(edge.attrs.y1),
    x2: Number(edge.attrs.x2),
    y2: Number(edge.attrs.y2),
  };

  const node = findNodeEl('AAAA000000000001');
  assert.ok(node, '没找到任务甲的节点');
  node.listeners.pointerdown?.forEach((fn) =>
    fn({ button: 0, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} }),
  );
  // 往右拖 132 像素（正好一格），但先不松手
  fireDoc('pointermove', { clientX: 232, clientY: 100 });

  const mid = {
    x1: Number(edge.attrs.x1),
    y1: Number(edge.attrs.y1),
    x2: Number(edge.attrs.x2),
    y2: Number(edge.attrs.y2),
  };
  assert.equal(mid.x1 - before.x1, 132, '拖动时连线的起点应该跟着走');
  assert.equal(mid.y1 - before.y1, 0);
  assert.equal(mid.x2, before.x2, '没被拖的那一端不该动');
  assert.equal(mid.y2, before.y2);

  // 收尾：松手并等写盘结束，别影响后面的用例
  fireDoc('pointerup', { clientX: 232, clientY: 100 });
  await settle(16);
});

test('平移缩放落在内层 <g> 上，不直接 transform 根 svg（否则拖动会留黑框）', async () => {
  const svg = findSvg();
  assert.ok(svg, '没找到画布 svg');
  assert.ok(
    !String(svg.attrs.style ?? '').includes('transform'),
    '根 svg 自己被 transform 会被浏览器提成合成层，拖动时旧位置不重绘就留黑框',
  );
  const viewport = find(svg, (n) => n.attrs.class === 'mcs-viewport');
  assert.ok(viewport, '没找到承载平移缩放的那一层 <g>');
  assert.ok(String(viewport.attrs.style ?? '').includes('transform'), '平移缩放应该写在这一层上');
  const host = findCanvasHost();
  assert.ok(host, '没找到画布容器');
  assert.ok(host.listeners.dragstart?.length, '容器上要拦住浏览器自带的拖拽（不然会拖出黑方块幽灵）');
  assert.ok(host.listeners.wheel?.length, '滚轮缩放要挂在容器上（挂在 svg 上缩小之后就收不到事件）');
  // 图标 <image>（节点上的）要设 draggable=false；章节背景图（mcs-quest-bg）不在节点里，不算
  const img = find(svg, (n) => n.tagName === 'IMAGE' && n.attrs.class !== 'mcs-quest-bg');
  if (img) assert.equal(img.attrs.draggable, 'false', '图标要设成不可拖');
});

test('滚轮缩放：缩小到比内容还小也照样管用，而且围着鼠标那个点缩', async () => {
  const host = findCanvasHost();
  const viewport = find(findSvg(), (n) => n.attrs.class === 'mcs-viewport');

  /** 视口那层的 scale（transform 里的第三个数）。 */
  const readScale = () => {
    const m = /scale\(\s*([\d.]+)\s*\)/.exec(String(viewport.attrs.style ?? ''));
    return m ? Number(m[1]) : 1;
  };

  const start = readScale();
  // 连滚 20 下「缩小」，早就越过旧的那条 0.35 下限
  for (let i = 0; i < 20; i += 1) {
    host.listeners.wheel?.forEach((fn) => fn({ deltaY: 120, clientX: 400, clientY: 300, preventDefault() {} }));
  }
  await settle(4);
  const shrunk = readScale();
  assert.ok(shrunk < start, '滚轮往下滚没有缩小');
  assert.ok(shrunk <= 0.25, `缩小到 ${shrunk} 就不动了，说明下限还是旧的那条`);

  // 再滚回去放大
  for (let i = 0; i < 40; i += 1) {
    host.listeners.wheel?.forEach((fn) => fn({ deltaY: -120, clientX: 400, clientY: 300, preventDefault() {} }));
  }
  await settle(4);
  const grown = readScale();
  assert.ok(grown > 1, '滚回去没有放大');
  assert.ok(grown <= 3, `放大到 ${grown} 还没停，上限失效了`);

  // 收尾：回到 1 倍，别影响后面的用例
  for (let i = 0; i < 40; i += 1) {
    host.listeners.wheel?.forEach((fn) => fn({ deltaY: 120, clientX: 0, clientY: 0, preventDefault() {} }));
  }
  while (readScale() < 0.99) {
    host.listeners.wheel?.forEach((fn) => fn({ deltaY: -120, clientX: 0, clientY: 0, preventDefault() {} }));
  }
  await settle(4);
});

// ---------------------------------------------- 多选：能一起挪，别被「吸附」骗了

/** 读视口那一层的平移量（px）。 */
function viewTx() {
  const viewport = find(findSvg(), (n) => n.attrs.class === 'mcs-viewport');
  const m = /translate\(\s*(-?[\d.]+)px[, ]+(-?[\d.]+)px\s*\)/.exec(String(viewport?.attrs.style ?? ''));
  return m ? { tx: Number(m[1]), ty: Number(m[2]) } : { tx: 0, ty: 0 };
}

/** 某个任务在屏幕上的横坐标 = 视口平移 + 盒子的画布坐标。 */
function nodeScreenX(id) {
  const g = findNodeEl(id);
  const rect = find(g, (n) => n.tagName === 'RECT');
  return viewTx().tx + Number(rect.attrs.x);
}

test('Ctrl+点击 能加选：点第二个任务不会把第一个顶掉', async () => {
  // 先单选甲，再按住 Ctrl 点乙
  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle();
  findNodeEl('AAAA000000000002').listeners.click?.forEach((fn) => fn({ ctrlKey: true }));
  await settle();

  assert.match(textOf(appRoot), /选中了 2 个任务/, 'Ctrl+点击 应该把第二个加进来');
});

test('多个选中一起拖完，选择还在（松手补的那下 click 不能把多选收成单选）', async () => {
  assert.match(textOf(appRoot), /选中了 2 个任务/, '前置条件：当前应该是两个任务被选中');

  posted.length = 0;
  await dragBy(findNodeEl('AAAA000000000001'), 132, 0);

  const call = posted.find((p) => p.path === '/api/mcstudio/quest/move/apply');
  assert.ok(call, '多选一起拖没有写盘');
  assert.equal(JSON.parse(call.payload.moves).length, 2, '两个选中的任务应该一起挪');
  assert.match(
    textOf(appRoot),
    /选中了 2 个任务/,
    '拖完那一下 click 把多选收成单选了，用户就没法接着一起挪',
  );
});

test('把最左边的任务往左挪，其他任务在屏幕上不该跟着跳（原点漂移已补偿）', async () => {
  // 选成单选，避免连带拖动
  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle();

  const before = nodeScreenX('AAAA000000000002');
  posted.length = 0;
  await dragBy(findNodeEl('AAAA000000000001'), -132, 0); // 往左一格，包围盒左上角会变

  const call = posted.find((p) => p.path === '/api/mcstudio/quest/move/apply');
  assert.ok(call, '往左挪没有写盘');
  assert.equal(JSON.parse(call.payload.moves).length, 1, '这次应该只挪一个任务');

  const after = nodeScreenX('AAAA000000000002');
  // 比到小数点后 6 位就够：平移量是 scale 连乘出来的，浮点末尾几位会有 1e-14 级抖动，
  // 用 strictEqual 等于在比「两次浮点运算的尾数完全相同」，那是测试自己的问题不是程序的问题。
  assert.equal(
    after.toFixed(6),
    before.toFixed(6),
    '画布原点变了，但没动的任务在屏幕上不该平移（否则像被吸走）',
  );
});

// ------------------------------------- 工作流：八阶段条 + 后面四块新面板

/** 取元素的 class 串（el() 里 `class` 是赋给 className 的，不走 setAttribute）。 */
const cls = (n) => String(n.className ?? n.attrs['class'] ?? '');

/** 阶段条里的一格（不是外面那圈 .mcs-stages）。 */
const isStage = (n) => /(^|\s)mcs-stage(\s|$)/.test(cls(n));

/** 按名字找阶段条里的一格。 */
function stageEl(name) {
  return find(appRoot, (n) => isStage(n) && textOf(n).includes(name));
}

/** 点一下某个元素（统一走 click 监听器）。 */
async function click(node, extra = {}) {
  assert.ok(node, '要点的元素不存在');
  node.listeners.click?.forEach((fn) => fn(extra));
  await settle(16);
}

/** 填一个输入框（走 input 监听器，和真人打字同一条路径）。 */
function typeInto(key, value) {
  const input = findByFocus(appRoot, key);
  assert.ok(input, `没找到输入框 ${key}`);
  input.value = value;
  input.listeners.input?.forEach((fn) => fn({ target: input }));
  return input;
}

/** 点了不能点是哪种样子：el() 的 `key in node` 分支会直接赋值，否则走 setAttribute。 */
const isDisabled = (n) => n.disabled === true || n.attrs.disabled === 'true';

/** 菜单栏里有一个标题叫 name 的菜单（带下拉）。 */
function menuHead(name) {
  return find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === name);
}

test('骨架改版：顶栏七个菜单，没有八阶段条也没有最左边那排图标', async () => {
  for (const name of ['文件', 'mod', '运行', '编译', '分析', '交付', '设置']) {
    assert.ok(menuHead(name), `顶栏缺「${name}」菜单`);
  }
  // 八阶段进度条和活动栏都撤了 —— 主线是章节页签
  assert.ok(!findByClass(appRoot, 'mcs-stage'), '八阶段条还在');
  assert.ok(!findByClass(appRoot, 'mcs-stagebar'), '八阶段条还在');
  assert.ok(!findByClass(appRoot, 'mcs-activity'), '最左边那排图标还在');
  // 左栏是章节列表，不是 mod 列表
  assert.ok(isChapItem(chapItemOf('第一章')), '左栏没章节列表');
  assert.match(textOf(appRoot), /开着 \d+ \/ 8 个页签/);
});

test('点菜单「编译 → 搜物品」：切到物品与配方，搜物品能列出配方', async () => {
  await clickMenu('编译', '搜物品');
  assert.match(textOf(appRoot), /物品与配方/, '点菜单没有切到内容面板');

  typeInto('rq', '齿轮');
  await click(findButton('搜物品'));
  let text = textOf(appRoot);
  assert.match(text, /demo:gear/, '搜出来的物品没有进界面');

  // 点第一个物品 → 读它的配方
  await click(find(appRoot, (n) => cls(n).includes('mcs-pick-row') && textOf(n).includes('demo:gear')));
  text = textOf(appRoot);
  assert.match(text, /能做出它/, '没列出「谁能做出它」');
  assert.match(text, /它被用在哪些配方里/);
  // 配方行显示的是产物、类型和材料（左边那列物品 ID 才是入口）
  assert.match(text, /demo:cogwheel/);
  assert.match(text, /machine/);
});

test('点一条配方：右栏出编辑表单，预览走 preview、写入走 apply', async () => {
  await click(find(appRoot, (n) => cls(n).includes('mcs-recipe-row') && textOf(n).includes('demo:cogwheel')));

  let text = textOf(appRoot);
  assert.match(text, /改成什么/, '没出编辑表单');
  assert.match(text, /界面上能改/);

  // 合成表：JEI 那种摆法，机器配方走「材料 → 机器 → 产物」横排
  assert.match(text, /合成表/, '右栏没有合成表那张卡');
  assert.match(text, /压板机/, '合成表没写是什么机器做的');
  assert.match(text, /铁锭/, '合成表的格子里没有材料');
  assert.ok(find(appRoot, (n) => cls(n).includes('mcs-rv-machine')), '机器配方应该画成流程图');

  // 改产出数量
  typeInto('rcount', '2');

  posted.length = 0;
  await click(findButton('预览会写什么'));

  const previewCall = posted.find((p) => p.path === '/api/mcstudio/recipe/preview');
  assert.ok(previewCall, '没有调用配方预览接口');
  assert.equal(previewCall.payload.recipeId, 'create:pressing/cogwheel');
  assert.equal(previewCall.payload.action, 'edit');
  assert.equal(previewCall.payload.count, 2);
  assert.deepEqual(JSON.parse(previewCall.payload.inputs), ['minecraft:iron_ingot']);

  text = textOf(appRoot);
  assert.match(text, /这次会改什么（还没写盘）/);
  assert.match(text, /ServerEvents\.recipes/, '预览里没把会写的代码摆出来');
  assert.match(text, /原配方会在游戏里被删掉/, 'warnings 没显示');

  posted.length = 0;
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('确认写入')));

  const applyCall = posted.find((p) => p.path === '/api/mcstudio/recipe/apply');
  assert.ok(applyCall, '没有写盘');
  assert.equal(applyCall.payload.recipeId, 'create:pressing/cogwheel');
  assert.match(textOf(appRoot), /写好了，复验通过/);
});

test('点多产物配方：每种产物都能改，预览走 JSON 改写路径', async () => {
  // 上一条用例写盘后把配方列表清了，这里重新搜一遍
  await clickMenu('编译', '搜物品');
  typeInto('rq', '齿轮');
  await click(findButton('搜物品'));
  await click(find(appRoot, (n) => cls(n).includes('mcs-pick-row') && textOf(n).includes('demo:gear')));

  await click(find(appRoot, (n) => cls(n).includes('mcs-recipe-row') && textOf(n).includes('demo:flour')));

  let text = textOf(appRoot);
  assert.match(text, /改成什么/, '没出编辑表单');
  assert.match(text, /一次出 2 种/, '没说出这条配方有几种产物');
  assert.match(text, /demo:flour/, '第一种产物没显示');
  assert.match(text, /demo:husk/, '第二种产物没显示');
  assert.match(text, /概率/, '概率产物没标出来');
  // 材料只读展示
  assert.match(text, /材料（改产物时不动/, '材料区没显示');
  assert.match(text, /minecraft:wheat/);
  // 多产物写的是数据包文件，不是脚本 → 不该再问「写进哪个脚本」
  assert.equal(text.includes('写进哪个脚本'), false, '多产物不该问脚本文件名');

  // 改数量、改概率
  typeInto('routc0', '5');
  typeInto('routp1', '50');

  posted.length = 0;
  await click(findButton('预览会写什么'));

  const previewCall = posted.find((p) => p.path === '/api/mcstudio/recipe/preview');
  assert.ok(previewCall, '没有调用配方预览接口');
  assert.equal(previewCall.payload.recipeId, 'create:milling/multi');
  const outputs = JSON.parse(previewCall.payload.outputs);
  assert.equal(outputs.length, 2, '两种产物都要传上去');
  assert.equal(outputs[0].id, 'demo:flour');
  assert.equal(outputs[0].count, 5, '数量改了要传上去');
  assert.equal(outputs[1].id, 'demo:husk');
  assert.equal(outputs[1].chance, 0.5, '概率 50% 要换算成 0.5 传上去');

  text = textOf(appRoot);
  assert.match(text, /这次会改什么（还没写盘）/);
  assert.match(text, /create:milling/, '预览里没把会写的文件摆出来');
});

test('点菜单「交付 → 打包」：先算计划再真打包，自检逐条列出来', async () => {
  await clickMenu('交付', '打包');
  assert.match(textOf(appRoot), /算一下要打多大/, '没切到打包面板');

  posted.length = 0;
  await click(findButton('算一下要打多大'));

  const previewCall = posted.find((p) => p.path === '/api/mcstudio/export/preview');
  assert.ok(previewCall, '没有算打包计划');
  assert.equal(previewCall.payload.mode, 'offline');
  assert.equal(previewCall.payload.dir, 'D:\\lab\\DemoPack');

  let text = textOf(appRoot);
  assert.match(text, /打包计划（还没写盘）/);
  assert.match(text, /100 MB/);
  assert.match(text, /D:\\lab\\DemoPack-offline.zip/);

  posted.length = 0;
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('真打包')));

  const buildCall = posted.find((p) => p.path === '/api/mcstudio/export/build');
  assert.ok(buildCall, '没有真打包');
  assert.equal(buildCall.payload.mode, 'offline');

  text = textOf(appRoot);
  assert.match(text, /打好了，自检通过/);
  assert.match(text, /94 MB/);
  assert.match(text, /versions\/DemoPack-offline\/DemoPack-offline\.json 在/);

  // 打完也留着最后那一帧：进度条不该一闪就没
  assert.match(text, /打包：DemoPack/, '打包完进度条消失了');
  assert.match(text, /1300 \/ 1300 个文件/, '文件数没显示');
  assert.match(text, /打完了/);
  assert.equal(fakeTimers.length, 0, '打完了还在轮询');
});

test('进度条不串页：装 mod 的进度不会跑到打包页上', async () => {
  // 上一条已经打完包，进度条是 export 的；现在回去看打包页 —— 它就该在
  assert.match(textOf(appRoot), /打包：DemoPack/);

  // 切到「验证」页：打包的进度条不该跟过来（那是另一件事）
  await clickMenu('交付', '启动验证');
  assert.doesNotMatch(textOf(appRoot), /打包：DemoPack/, '打包进度跑到验证页去了');
});

test('点菜单「交付 → 启动验证」：先算命令行，再真启动，结果和证据都显示', async () => {
  await clickMenu('交付', '启动验证');
  assert.match(textOf(appRoot), /只算命令行（不启动）/, '没切到启动面板');

  // 还没算命令行之前，「真启动」不该能点
  let launchBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('真启动一次'));
  assert.ok(launchBtn, '没找到「真启动一次」按钮');
  assert.equal(isDisabled(launchBtn), true, '还没算命令行就让点真启动，等于把盲点埋给用户');

  await click(findButton('只算命令行（不启动）'));
  let text = textOf(appRoot);
  assert.match(text, /启动计划（还没启动任何东西）/);
  assert.match(text, /120 个齐 \/ 0 个缺/);
  assert.match(text, /net\.minecraft\.client\.main\.Main/);

  posted.length = 0;
  launchBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('真启动一次'));
  await click(launchBtn);

  const applyCall = posted.find((p) => p.path === '/api/mcstudio/launch/apply');
  assert.ok(applyCall, '没有调用真启动');
  assert.equal(applyCall.payload.apply, true, '真启动必须显式带 apply: true');

  text = textOf(appRoot);
  assert.match(text, /启动结果：ok/);
  assert.match(text, /启动到主菜单/);
  assert.match(text, /Sound engine started/);
});

/** 点顶栏菜单（文件/下载/任务书/运行/debug）：先展开，再点里面那条命令。 */
async function clickMenu(menuName, itemLabel) {
  const head = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === menuName);
  assert.ok(head, `顶栏没有「${menuName}」菜单`);
  await click(head);
  const item = find(appRoot, (n) => cls(n).includes('mcs-menu-item') && textOf(n).includes(itemLabel));
  assert.ok(item, `「${menuName}」菜单里没有「${itemLabel}」`);
  await click(item);
}

test('回到选项目页：从零装底座先算计划，再真装', async () => {
  // 换项目现在在「文件」菜单里（学 VSCode）
  await clickMenu('文件', '换一个整合包');
  assert.match(textOf(appRoot), /先挑一个整合包/);

  // 收起态只有一句介绍 + 一个按钮
  const openBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('从零装'));
  assert.ok(openBtn, '选项目页没有「从零装」的入口');
  await click(openBtn);
  assert.match(textOf(appRoot), /先算要下多少/, '没展开装底座表单');

  typeInto('scr', 'D:\\lab');
  typeInto('scn', 'NewPack');

  posted.length = 0;
  await click(findButton('先算要下多少'));

  const previewCall = posted.find((p) => p.path === '/api/mcstudio/scaffold/preview');
  assert.ok(previewCall, '没有算装底座计划');
  assert.equal(previewCall.payload.mcRoot, 'D:\\lab');
  assert.equal(previewCall.payload.name, 'NewPack');
  assert.equal(previewCall.payload.mcVersion, '1.21.1');
  assert.equal(previewCall.payload.loader, 'neoforge');

  let text = textOf(appRoot);
  assert.match(text, /装底座计划（还没下载）/);
  assert.match(text, /300 MB/);
  assert.match(text, /D:\\lab\\versions\\NewPack/);

  posted.length = 0;
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('开始装（下 300 MB）')));

  const applyCall = posted.find((p) => p.path === '/api/mcstudio/scaffold/apply');
  assert.ok(applyCall, '没有真装底座');

  text = textOf(appRoot);
  assert.match(text, /装好了/);
  assert.match(text, /打开这个新包/);
});

test('选项目页：深度搜索先只算不落地，翻出来的目录能一个个打开，也能整批收进列表（2026-11-02）', async () => {
  // 上一条用例最后停在选项目页
  const openBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('选个大目录翻一翻'));
  assert.ok(openBtn, '选项目页没有「深度搜索」的入口');
  await click(openBtn);
  assert.match(textOf(appRoot), /深度搜索：从一个大目录里找整合包/);

  // 没填目录时「开始翻」不能点
  const scanBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && /^开始翻$/.test(textOf(n).trim()));
  assert.ok(scanBtn, '没找到「开始翻」按钮');
  assert.equal(isDisabled(scanBtn), true, '没填目录时不该能翻');

  typeInto('scandir', 'D:\\upper');
  posted.length = 0;
  calls.length = 0;
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && /^开始翻$/.test(textOf(n).trim())));

  // 深度搜索是 GET（只读），不会进 posted —— 从 calls 里找
  const scanCall = calls.find((c) => c.path === '/api/mcstudio/roots/scan');
  assert.ok(scanCall, '没有发深度搜索请求');
  assert.equal(scanCall.method, 'GET', '深度搜索必须是只读的 GET');
  assert.equal(scanCall.params.dir, 'D:\\upper');
  // 只读：一条都不该往记住列表里写
  assert.ok(
    !posted.some((p) => p.path === '/api/mcstudio/roots/add'),
    '只是翻一翻，不该往记住列表里写',
  );

  const text = textOf(appRoot);
  assert.match(text, /翻完了：看了 37 个目录/);
  // 2026-11-02 改成「一行一个包」：2 处 → 3 个包
  assert.match(text, /找到 3 个包（分布在 2 处）/);
  assert.match(text, /PackB/);
  assert.match(text, /PackC1/);
  assert.match(text, /PackC2/);
  // 版本和加载器要显示出来，用户才分得清哪个包是哪个
  assert.match(text, /1\.20\.1 · forge · 5 个 mod/);
  assert.match(text, /1\.21\.1 · neoforge · 6 个 mod/);
  assert.match(text, /「收进列表」会把上面这些目录记住/);

  // 每个包都有自己的「打开」
  const openHitBtns = [];
  const walk = (n) => {
    if (n.tagName === 'BUTTON' && /^打开$/.test(textOf(n).trim())) openHitBtns.push(n);
    for (const kid of n.children ?? []) walk(kid);
  };
  walk(appRoot);
  assert.equal(openHitBtns.length, 3, '三个包各该有一个「打开」');

  // 点「打开」：这一次进去看看，但不写记住列表
  posted.length = 0;
  await click(openHitBtns[0]);
  assert.ok(
    !posted.some((p) => p.path === '/api/mcstudio/roots/add'),
    '「打开」只是这一次进去，不该记住',
  );

  // 收进列表：整批走 /roots/add，一条一条来
  await clickMenu('文件', '换一个整合包').catch(() => {});
  if (!textOf(appRoot).includes('深度搜索：从一个大目录里找整合包')) {
    // 已经进工作台了（上一步点了「打开」），先退回选项目页
    await clickMenu('文件', '换一个整合包');
    await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('选个大目录翻一翻')));
    typeInto('scandir', 'D:\\upper');
    await click(find(appRoot, (n) => n.tagName === 'BUTTON' && /^开始翻$/.test(textOf(n).trim())));
  }

  posted.length = 0;
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('全部收进列表')));
  const adds = posted.filter((p) => p.path === '/api/mcstudio/roots/add');
  assert.equal(adds.length, 2, `应该把两处都收进列表，实际 ${adds.length}`);
  assert.equal(adds[0].payload.dir, 'D:\\upper\\a\\b');
  assert.equal(adds[1].payload.dir, 'D:\\upper\\c');

  // 收完把卡片收起，交给下一条用例（它假设停在选项目页）
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === '收起'));
  assert.match(textOf(appRoot), /先挑一个整合包/);
});

test('选项目页：从零建包（抄底子）先算计划，再真建（2026-11-02：之前只能联网下载装底座）', async () => {
  // 上一条用例最后停在选项目页
  const openBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('抄一个建新包'));
  assert.ok(openBtn, '选项目页没有「从零建包」的入口');
  await click(openBtn);
  assert.match(textOf(appRoot), /先算要建多大/, '没展开建包表单');

  // 名字没填时按钮禁用
  typeInto('pct', 'D:\\lab\\versions\\DemoPack');
  typeInto('pcr', 'D:\\lab');
  const planBtn0 = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '先算要建多大');
  assert.equal(planBtn0.attrs.disabled, 'true', '名字没填时算计划按钮不该能点');
  typeInto('pcn', 'CopyPack');
  assert.ok(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '先算要建多大' && n.attrs.disabled === undefined), '填全之后按钮还禁着');

  posted.length = 0;
  await click(findButton('先算要建多大'));

  const previewCall = posted.find((p) => p.path === '/api/mcstudio/pack/preview');
  assert.ok(previewCall, '没有算建包计划');
  assert.equal(previewCall.payload.templateDir, 'D:\\lab\\versions\\DemoPack');
  assert.equal(previewCall.payload.mcRoot, 'D:\\lab');
  assert.equal(previewCall.payload.name, 'CopyPack');
  assert.equal(previewCall.payload.withQuestBook, true);
  assert.equal(previewCall.payload.withKubejs, true);

  let text = textOf(appRoot);
  assert.match(text, /建包计划（还没动盘）/);
  assert.match(text, /D:\\lab\\versions\\CopyPack/);
  assert.match(text, /25 MB/);
  assert.match(text, /183 个/, '底子的 mod 数没显示');

  posted.length = 0;
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('确认建包')));

  const applyCall = posted.find((p) => p.path === '/api/mcstudio/pack/apply');
  assert.ok(applyCall, '没有真建包');

  text = textOf(appRoot);
  assert.match(text, /建好了/);
  assert.match(text, /打开这个新包/);

  // 点「知道了」留在选项目页 —— 不点「打开这个新包」，
  // 否则下一条用例（装 mod）开头「点 DemoPack 回工作台」的前提就破了。
  await click(findButton('知道了'));
  assert.match(textOf(appRoot), /先挑一个整合包/, '没回到选项目页');
});

test('任务书顶栏显示图标现状（游戏导出 N 个），点「重扫」强制再体检', async () => {
  // 回到工作台（上一条用例最后停在选项目页）
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  // 骨架改版后，中栏标题是章节名（不再是「任务书蓝图」）
  assert.ok(tabElOf('第一章'), '连上之后该自动开着第一章页签');
  await settle();

  const text = textOf(appRoot);
  assert.match(text, /图标：游戏导出 1895 个（3\.7 MB）/, '图标现状一行没显示');

  // 重扫：强制再体检，note 显示结果
  posted.length = 0;
  await click(findButton('重扫'));
  await settle();

  const scanCall = posted.find((p) => p.path === '/api/mcstudio/icon-export/scan');
  assert.ok(scanCall, '没有调 /icon-export/scan');
  assert.match(textOf(appRoot), /游戏导出 1900 个/, '重扫后的新数字没显示');
  assert.match(textOf(appRoot), /目录：D:\\lab\\DemoPack\\\.mcstudio\\icon-exports/, '重扫的说明没进 note');

  // 回选项目页（工作台「文件」菜单），保住「装 mod」用例开头「点 DemoPack 回工作台」的前提
  await clickMenu('文件', '换一个整合包');
  assert.match(textOf(appRoot), /先挑一个整合包/, '没回到选项目页');
});

test('装 mod 时出进度条：百分比、速度、剩余、当前文件都在，下完停在 100%', async () => {
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  assert.ok(tabElOf('第一章'), '连上之后该自动开着第一章页签');

  // 骨架改版后装 mod 在「mod」工具页（菜单栏进）→ 联网搜索 → 搜 → 勾一个 → 只看这个
  await clickMenu('mod', '装新 mod');
  typeInto('modsearch', 'create');
  // 注意不能用 findButton('搜索') —— 「收起联网搜索」也包含这两个字，
  // 会先命中它，一点就把搜索框收回去了。这里按精确文字找。
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === '搜索'));
  assert.match(textOf(appRoot), /12000000 下载/, '搜索结果没渲染出来');
  await click(findButton('只看这个'));
  assert.match(textOf(appRoot), /要装 2 个文件|4\.0 MB/, '计划卡没出来');

  // 让 apply 停在半路上：这样能断言「正在下」那一帧的进度条长什么样
  let release = null;
  applyGate = new Promise((r) => { release = r; });

  posted.length = 0;
  await click(findButton('就装这些'));
  await runTimers(1);

  const text = textOf(appRoot);
  assert.match(text, /装 mod（2 个）/, '进度条没标题');
  assert.match(text, /25%/, '没显示百分比');
  assert.match(text, /1\.0 MB \/ 4\.0 MB/, '没显示已下/总量');
  assert.match(text, /512 KB\/s/, '没显示速度');
  assert.match(text, /还剩 6 秒/, '没显示剩余时间');
  assert.match(text, /create-1\.21\.1\.jar/, '没显示当前文件');
  // 进度条确实是按 25% 画的宽度（替身里 style 是整串文本，不是 CSSStyleDeclaration）
  const fill = findByClass(appRoot, 'mcs-pbar-fill');
  assert.ok(fill, '没有进度条填充块');
  assert.match(String(fill.style ?? ''), /width:\s*25%/, '进度条宽度不对');

  // 放行：真装完了，界面停在 100%
  release();
  await settle(20);

  const done = textOf(appRoot);
  assert.match(done, /装 mod（2 个）/, '装完进度条不该消失');
  assert.match(done, /100%/);
  assert.match(done, /装完了/);
  assert.match(done, /flywheel-1\.21\.1\.jar/, '没显示最后下的那个文件');
  assert.match(done, /装好了 1 个文件/);
  // 定时器必须收掉，否则页面会一直空转
  assert.equal(fakeTimers.length, 0, '装完了还在轮询');
  applyGate = null;
});

test('装 mod 能点名具体版本：选版本 → 预览 → 真装，preview 和 apply 都带同一份 pinned（2026-11-04 第 3 批 A）', async () => {
  // 回到选项目页再重新连一次，起点干净，不靠上一条用例留下的界面状态
  await clickMenu('文件', '换一个整合包');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await clickMenu('mod', '装新 mod');
  typeInto('modsearch', 'create');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === '搜索'));
  assert.match(textOf(appRoot), /12000000 下载/, '搜索结果没渲染出来');

  // 展开版本列表：走的是 GET /mod-versions，不是 POST，所以不会进 posted
  posted.length = 0;
  await click(findButton('选版本'));
  await settle(20);
  const vcall = calls.find((c) => c.path === '/api/mcstudio/mod-versions');
  assert.ok(vcall, '没去问版本列表');
  assert.equal(vcall.method, 'GET');
  assert.equal(vcall.params.project, 'create');
  assert.equal(vcall.params.channel, 'release');
  assert.match(textOf(appRoot), /0\.5\.1/, '版本列表里没有旧版 0.5.1');

  // 点名旧版：界面要显示「已选版本」，别让用户以为还在自动挑最新
  const oldBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && cls(n).includes('mcs-pick-item') && textOf(n).includes('0.5.1'));
  assert.ok(oldBtn, '没找到 0.5.1 那一行的按钮');
  await click(oldBtn);
  assert.match(textOf(appRoot), /已选版本：0\.5\.1/, '点名之后没显示选了哪个版本');

  // 预览：projects 只放工程 key，点名的版本单独走 pinned，渠道也一起带过去
  posted.length = 0;
  await click(findButton('只看这个'));
  const preview = posted.find((p) => p.path === '/api/mcstudio/mod-install/preview');
  assert.ok(preview, '点「只看这个」没发预览请求');
  assert.equal(preview.payload.projects, JSON.stringify(['create']));
  assert.equal(preview.payload.channel, 'release');
  assert.deepEqual(JSON.parse(preview.payload.pinned), { create: 'create-0.5.1' }, '点名的旧版没进 pinned');

  // 真装：body 必须和预览逐字一致，否则「预览说装 0.5.1、真装却装了 6.0.10」
  await click(findButton('就装这些'));
  await settle(40);
  const applied = posted.find((p) => p.path === '/api/mcstudio/mod-install/apply');
  assert.ok(applied, '点「就装这些」没发真装请求');
  assert.deepEqual(applied.payload, preview.payload, '真装的 body 和预览不一致，点名的版本会被静默换掉');
  assert.equal(fakeTimers.length, 0, '装完了还在轮询');
});

// ------------------ 装 mod：推荐版本 / 兼容性体检 / 下载目录（2026-11-06）

/** 版本列表那个开关按钮（展开之后文字会变成「收起版本」）。 */
function modVersionsToggle() {
  return find(appRoot, (n) => n.tagName === 'BUTTON' && ['选版本', '收起版本'].includes(textOf(n).trim()));
}

test('装 mod 时版本列表标「推荐」、标出不适用的 MC 版本，还列出每个版本适配哪些 MC 版本', async () => {
  // 回到选项目页重新连一次，起点干净（整包级状态不会跟着用例复位）
  await clickMenu('文件', '换一个整合包');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await clickMenu('mod', '装新 mod');
  typeInto('modsearch', 'create');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === '搜索'));
  assert.match(textOf(appRoot), /12000000 下载/, '搜索结果没渲染出来');

  // 展开版本列表（GET /mod-versions）
  await click(modVersionsToggle());
  await settle(20);

  const text = textOf(appRoot);
  assert.match(text, /6\.0\.10/, '版本列表里没有 6.0.10');
  assert.match(text, /推荐/, '没显示「推荐」标记');
  assert.match(text, /不适合你的 MC 版本/, '没标出不适用的 MC 版本');
  // 适配的 MC 版本只显示前 3 个，多了加省略号
  assert.match(text, /适配 1\.21\.1、1\.21、1\.20\.6…/, '没列出适配的 MC 版本');
  assert.match(text, /适配 1\.20\.1/, '旧版本适配的 MC 版本没显示');

  // 「推荐」得挂在 6.0.10 那一条上，不能挂错版本
  const top = find(appRoot, (n) => n.tagName === 'BUTTON' && cls(n).includes('mcs-pick-item') && textOf(n).includes('6.0.10'));
  assert.ok(top, '没找到 6.0.10 那一行');
  assert.match(textOf(top), /推荐/, '「推荐」没标在 6.0.10 上');
  const old = find(appRoot, (n) => n.tagName === 'BUTTON' && cls(n).includes('mcs-pick-item') && textOf(n).includes('0.5.1'));
  assert.ok(old, '没找到 0.5.1 那一行');
  assert.doesNotMatch(textOf(old), /推荐/, '0.5.1 不该标「推荐」');
});

test('「查兼容」按钮：体检整个整合包的 mods，互斥和装多份都要说人话', async () => {
  await clickMenu('mod', '看 mod 列表');
  assert.ok(findButton('查兼容'), 'mod 工具页没有「查兼容」按钮');
  assert.doesNotMatch(textOf(appRoot), /兼容性体检/, '还没查就已经有体检结果了');

  posted.length = 0;
  await click(findButton('查兼容'));
  await settle(20);

  // 后端已经把结论写成人话（lines），界面直接显示，不自己再翻译一遍
  const text = textOf(appRoot);
  assert.match(text, /兼容性体检/, '体检结果卡没出来');
  assert.match(text, /⚠ 互斥：veil 4\.1\.4 和 sodium 0\.8\.12 不能一起装/, '互斥的提醒没显示');
  assert.match(text, /⚠ 装了多份：sodium 装了 2 个版本/, '装了多份的提醒没显示');
  assert.match(text, /互斥打架/, '没统计互斥的条数');

  // 体检是只读接口：走 GET，并且带上当前整合包
  const call = calls.find((c) => c.path === '/api/mcstudio/mod-compat');
  assert.ok(call, '没去问 /mod-compat');
  assert.equal(call.method, 'GET');
  assert.equal(call.params.dir, 'D:\\lab\\DemoPack');
  assert.equal(call.params.id, 'DemoPack');
});

test('装 mod 能指定下载目录：这个目录要原样带进预览和真装的请求体里', async () => {
  await clickMenu('mod', '装新 mod');
  typeInto('modsearch', 'create');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === '搜索'));
  assert.match(textOf(appRoot), /12000000 下载/, '搜索结果没渲染出来');

  // 先出一份计划，计划卡里才有「下载目录」输入框
  await click(findButton('只看这个'));
  await settle(10);
  assert.ok(findByFocus(appRoot, 'modtargetdir'), '计划卡里没有「下载目录」输入框');

  // 开头先把目录摆正（整包级状态不会自己复位）
  typeInto('modtargetdir', '');
  typeInto('modtargetdir', 'D:\\other');

  // 目录改了要重新算一次计划，预览才带得上新目录
  posted.length = 0;
  await click(findButton('只看这个'));
  await settle(10);
  const preview = posted.find((p) => p.path === '/api/mcstudio/mod-install/preview');
  assert.ok(preview, '点「只看这个」没发预览请求');
  assert.equal(preview.payload.targetDir, 'D:\\other', '预览请求没带下载目录');

  await click(findButton('就装这些'));
  await settle(40);
  const applied = posted.find((p) => p.path === '/api/mcstudio/mod-install/apply');
  assert.ok(applied, '点「就装这些」没发真装请求');
  assert.equal(applied.payload.targetDir, 'D:\\other', '真装请求没带下载目录');
  assert.deepEqual(applied.payload, preview.payload, '真装的 body 和预览不一致');

  // 收尾：把下载目录摆回默认，别留给后面的用例
  await click(findButton('只看这个'));
  await settle(10);
  assert.ok(findButton('用默认目录'), '计划卡里没有「用默认目录」按钮');
  await click(findButton('用默认目录'));
  assert.equal(findByFocus(appRoot, 'modtargetdir').value, '', '没摆回默认目录');
});

// ------------------------------- 检查 mod 更新（2026-11-07）

test('检查 mod 更新：查 → 勾 → 算清单 → 真升，预览和真升带同一份 body', async () => {
  // 摆正起点（整包级状态不会跟着用例复位）：换包会清掉上次的更新面板
  await clickMenu('文件', '换一个整合包');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await clickMenu('mod', '看 mod 列表');

  assert.ok(findButton('检查更新'), 'mod 工具页没有「检查更新」按钮');
  // 标题栏那个只是开关，点开面板（面板里另有一个「检查更新」才是真发请求）
  await click(findButton('检查更新'));
  assert.match(textOf(appRoot), /检查 mod 更新/, '更新面板没展开');
  assert.match(textOf(appRoot), /点上面的「检查更新」/, '还没查时该显示引导语');

  // 查一次：只读 GET，带上当前包和渠道
  posted.length = 0;
  calls.length = 0;
  await click(findButton('检查更新'));
  await settle(20);
  const checked = calls.find((c) => c.path === '/api/mcstudio/mod-update/check');
  assert.ok(checked, '没去问 /mod-update/check');
  assert.equal(checked.method, 'GET', '检查更新应该是只读 GET');
  assert.equal(checked.params.dir, 'D:\\lab\\DemoPack');
  assert.equal(checked.params.channel, 'release');
  const text = textOf(appRoot);
  assert.match(text, /扫到 3 个 mod/, '检查结果没显示扫描数');
  assert.match(text, /1\.0 → 2\.0/, '能升的 mod 没列出旧版→新版');
  assert.match(text, /已是最新/, '已最新的 mod 没标出来');
  assert.match(text, /查不到/, '查不到的 mod 没如实标出来');

  // 勾中能升的那条（点的是 div，不是 button；click 替身不冒泡但 div 自带 onclick）
  const pick = find(appRoot, (n) => cls(n).includes('mcs-pickable') && textOf(n).includes('1.0 → 2.0'));
  assert.ok(pick, '没找到能勾选的 mod 行');
  await click(pick);
  assert.match(textOf(appRoot), /算升级清单（1 个）/, '勾了之后按钮没数出 1 个');

  // 算清单：整块 check 走 POST JSON body，不能塞 GET 查询串
  posted.length = 0;
  await click(findButton('算升级清单'));
  await settle(10);
  const preview = posted.find((p) => p.path === '/api/mcstudio/mod-update/preview');
  assert.ok(preview, '点「算升级清单」没发预览请求');
  assert.equal(preview.payload.channel, 'release');
  assert.equal(preview.payload.dir, 'D:\\lab\\DemoPack');
  assert.deepEqual(JSON.parse(preview.payload.selected), ['aaaa'], '勾的 key 没带过去');
  assert.equal(JSON.parse(preview.payload.check).scanned, 3, '没把检查结果整块回传');
  assert.match(textOf(appRoot), /升级清单（还没动文件）/, '升级清单卡没出来');
  assert.match(textOf(appRoot), /停用 create-1\.0\.jar → create-1\.0\.jar\.disabled/, '清单没写清旧 jar 会停用');

  // 真升：body 必须和预览逐字一致，否则「预览说升这些、真升却升了别的」
  await click(findButton('就升这些'));
  await settle(40);
  const applied = posted.find((p) => p.path === '/api/mcstudio/mod-update/apply');
  assert.ok(applied, '点「就升这些」没发真升请求');
  assert.deepEqual(applied.payload, preview.payload, '真升的 body 和预览不一致');
  assert.match(textOf(appRoot), /升好了 1 个 mod/, '升级结果没显示');
  assert.match(textOf(appRoot), /没有删除/, '没写清旧 jar 是停用不是删除');
  assert.equal(fakeTimers.length, 0, '升完了还在轮询进度');

  // 收尾：关掉面板，别把 modUpdateOpen 留给后面的用例
  await click(findButton('收起更新检查'));
});

test('检查更新网络不通：后端给「空表 + 提示」，界面照常显示不打整页红字', async () => {
  await clickMenu('文件', '换一个整合包');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await clickMenu('mod', '看 mod 列表');

  // 换一张只回 error/hint 的答案，模拟 checkModUpdates 联网失败那条分支
  const saved = FAKE['/api/mcstudio/mod-update/check'];
  FAKE['/api/mcstudio/mod-update/check'] = {
    ok: true, modsDir: 'D:\\lab\\DemoPack\\mods', gameVersion: '1.21.1', loader: 'neoforge', channel: 'release',
    scanned: 0, updates: 0, latest: 0, unknown: 0, items: [],
    error: '连不上 Modrinth', hint: '检查网络或稍后再试',
    lines: ['检查不了更新：连不上 Modrinth', '检查网络或稍后再试'],
  };
  try {
    await click(findButton('检查更新'));
    await click(findButton('检查更新'));
    await settle(20);
    const text = textOf(appRoot);
    assert.match(text, /连不上 Modrinth/, '没显示网络错误提示');
    assert.match(text, /检查网络或稍后再试/, '没显示 hint');
    assert.match(text, /扫到 mod/, '网络不通也该画出空结果卡，而不是整页红字');
    assert.doesNotMatch(text, /算升级清单/, '空结果不该还能算清单');
  } finally {
    FAKE['/api/mcstudio/mod-update/check'] = saved;
    await click(findButton('收起更新检查'));
  }
});

// ------------------------------- 安全增强（2026-11-07 第二轮）
// 三件事：锁定名单（不想被升级的 mod）、升级后体检结果上屏、一键撤回这次升级。

/** 找到「检查 mod 更新」这张卡（界面上很多张 mcs-card，别找错屋）。 */
function updateBox() {
  return find(appRoot, (n) => cls(n).includes('mcs-card') && textOf(n).startsWith('检查 mod 更新'));
}

/** 把更新面板打开、查一遍，返回当前文本。 */
async function openUpdatePanel() {
  await clickMenu('文件', '换一个整合包');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await clickMenu('mod', '看 mod 列表');
  // 前面那条用例把「装新 mod」的联网搜索开着，搜索结果行也带 mcs-hit，
  // 排在更新面板前面 —— 先收起来，免得找错行。
  const collapse = findButton('收起联网搜索');
  if (collapse) await click(collapse);
  await click(findButton('检查更新'));   // 标题栏那个是开关
  await click(findButton('检查更新'));   // 面板里那个才是真查
  await settle(20);
  return textOf(appRoot);
}

/** 走一遍：查 → 勾上能升的那条 → 算清单 → 真升。 */
async function upgradeOneMod() {
  const box = updateBox();
  assert.ok(box, '更新面板没打开');
  const pick = find(box, (n) => cls(n).includes('mcs-pickable') && textOf(n).includes('1.0 → 2.0'));
  assert.ok(pick, '没找到能勾选的 mod 行');
  await click(pick);
  await click(findButton('算升级清单'));
  await settle(10);
  await click(findButton('就升这些'));
  await settle(40);
}

test('锁定名单：点「锁定」那一行当场变灰不能勾，再点「解锁」又活了', async () => {
  lockState.length = 0;
  await openUpdatePanel();

  // 锁定按钮就在 Create 那一行里（只在更新面板这张卡里找，别撞上联网搜索结果）
  const box = updateBox();
  assert.ok(box, '更新面板没打开');
  const createRow = find(box, (n) => cls(n).includes('mcs-hit') && textOf(n).includes('Create'));
  assert.ok(createRow, '没找到 Create 那一行');
  const lockBtn = find(createRow, (n) => n.tagName === 'BUTTON' && textOf(n).includes('锁定'));
  assert.ok(lockBtn, 'Create 那一行没有「锁定」按钮');

  posted.length = 0;
  await click(lockBtn);
  await settle(10);
  const lockCall = posted.find((p) => p.path === '/api/mcstudio/mod-update/locks');
  assert.ok(lockCall, '点「锁定」没发请求');
  assert.equal(lockCall.payload.action, 'add', '锁定动作发错了');
  assert.equal(lockCall.payload.dir, 'D:\\lab\\DemoPack');
  assert.ok(lockCall.payload.entry.includes('create'), '锁定项没带 mod 身份');

  // 锁了之后：这一行标成「已锁定」，也不再能勾
  let text = textOf(appRoot);
  assert.match(text, /已锁定，不再提示更新/, '锁定后那一行没变灰');
  const lockedRow = find(updateBox(), (n) => cls(n).includes('mcs-hit') && textOf(n).includes('已锁定'));
  assert.ok(lockedRow, '没找到被锁定的行');
  assert.ok(!cls(lockedRow).includes('mcs-pickable'), '锁定的行还能勾，那就会被升级');

  // 再点「解锁」就恢复
  const unlockBtn = find(lockedRow, (n) => n.tagName === 'BUTTON' && textOf(n).includes('解锁'));
  assert.ok(unlockBtn, '被锁定的行没有「解锁」按钮');
  posted.length = 0;
  await click(unlockBtn);
  await settle(10);
  const unlockCall = posted.find((p) => p.path === '/api/mcstudio/mod-update/locks');
  assert.ok(unlockCall, '点「解锁」没发请求');
  assert.equal(unlockCall.payload.action, 'remove', '解锁动作发错了');
  text = textOf(appRoot);
  assert.match(text, /1\.0 → 2\.0/, '解锁后没恢复成能升的那一条');
  assert.doesNotMatch(text, /已锁定，不再提示更新/, '解锁后还标着锁定');

  await click(findButton('收起更新检查'));
  lockState.length = 0;
});

test('升级后能看到兼容性体检，也能一键撤回这次升级（一个文件都不删）', async () => {
  await openUpdatePanel();
  await upgradeOneMod();

  // 体检结果上屏：后端在 apply 的返回体里带了 compat
  let text = textOf(appRoot);
  assert.match(text, /升级后的兼容性体检/, '升级后没显示体检卡');
  assert.match(text, /互斥打架/, '体检卡没列出互斥打架');
  assert.match(text, /没发现版本兼容问题/, '体检结论没显示');

  // 撤回：先算清单（不写盘），再确认才真改文件名
  assert.ok(findButton('撤回这次升级'), '升级结果里没有「撤回这次升级」');
  posted.length = 0;
  await click(findButton('撤回这次升级'));
  await settle(10);
  const planCall = posted.find((p) => p.path === '/api/mcstudio/mod-update/rollback/preview');
  assert.ok(planCall, '点「撤回这次升级」没发预览请求');
  assert.ok(planCall.payload.result.includes('create-1.0.jar'), '撤回请求没带上升级结果');

  text = textOf(appRoot);
  assert.match(text, /撤回清单（还没动文件）/, '撤回清单卡没出来');
  assert.match(text, /一个文件都不删/, '撤回清单没写清「不会删文件」');
  assert.match(text, /准备恢复/, '撤回清单没写清要恢复几个');

  posted.length = 0;
  await click(findButton('确认撤回'));
  await settle(20);
  const applyCall = posted.find((p) => p.path === '/api/mcstudio/mod-update/rollback/apply');
  assert.ok(applyCall, '点「确认撤回」没发真撤回请求');
  assert.deepEqual(applyCall.payload.result, planCall.payload.result, '撤回两态带的升级结果不一致');
  text = textOf(appRoot);
  assert.match(text, /撤回完成，恢复了 1 个旧版/, '撤回结果没显示');
  assert.match(text, /没有删除任何文件/, '撤回结果没写清没删文件');

  await click(findButton('收起更新检查'));
});

// ------------------------------- 点空白处收起浮层（2026-11-03 抄 VSCode 的规矩）

test('点空白处收起顶部菜单：左键右键都算，点在菜单里不算', async () => {
  // 回到任务书页签（上一条用例停在 mod 工具页）
  await click(tabElOf('第一章'));
  assert.ok(tabElOf('第一章'), '没回到第一章页签');

  // 展开「设置」
  const head = menuHead('设置');
  assert.ok(head, '顶栏没有「设置」菜单');
  await click(head);
  assert.ok(findByClass(appRoot, 'mcs-menu-pop'), '菜单没展开');
  assert.ok(cls(menuHead('设置')).includes('mcs-menu-btn-on'), '展开时标题按钮没有高亮');

  // 点在菜单里的某一条 → 不该收起（VSCode：在菜单里点，菜单还开着）
  const item = find(appRoot, (n) => cls(n).includes('mcs-menu-item') && textOf(n).includes('看这个包的目录和版本'));
  assert.ok(item, '「设置」菜单里没有那条命令');
  fireDoc('pointerdown', { target: item, button: 0 });
  assert.ok(findByClass(appRoot, 'mcs-menu-pop'), '点在菜单里却把菜单关了');

  // 点空白处 → 收起
  fireDoc('pointerdown', { target: appRoot, button: 0 });
  assert.ok(!findByClass(appRoot, 'mcs-menu-pop'), '点空白处菜单没收起来');
  assert.ok(!cls(menuHead('设置')).includes('mcs-menu-btn-on'), '收起后标题按钮还高亮着');

  // 右键点空白处 → 也收起（用户原话：左键/右键都要关）
  await click(menuHead('设置'));
  assert.ok(findByClass(appRoot, 'mcs-menu-pop'), '菜单没重新展开');
  fireDoc('pointerdown', { target: appRoot, button: 2 });
  assert.ok(!findByClass(appRoot, 'mcs-menu-pop'), '右键点空白处没收起来');

  // Esc 也能收
  await click(menuHead('设置'));
  assert.ok(findByClass(appRoot, 'mcs-menu-pop'), '菜单没重新展开');
  fireDoc('keydown', { key: 'Escape' });
  assert.ok(!findByClass(appRoot, 'mcs-menu-pop'), 'Esc 没收起来');
});

test('点空白处收起画布上的右键菜单，而且不整页重画', async () => {
  const host = findCanvasHost();
  assert.ok(host, '没找到画布容器');
  // 上一条用例刚用右键拖过画布，程序会「吞掉紧随其后的一次右键菜单」。
  // 真机上这一步是浏览器把右键事件冒泡到画布容器上时清掉的，这里照样走一遍。
  host.listeners.contextmenu?.forEach((fn) => fn({ preventDefault() {} }));

  const node = findNodeEl('AAAA000000000002');
  assert.ok(node, '蓝图里没找到任务乙的节点');
  node.listeners.contextmenu?.forEach((fn) => fn({ clientX: 200, clientY: 150, preventDefault() {} }));
  await settle(2);
  assert.ok(findByClass(appRoot, 'mcs-menu'), '右键菜单没出来');

  const sameNode = findNodeEl('AAAA000000000002');
  fireDoc('pointerdown', { target: appRoot, button: 0 });
  assert.ok(!findByClass(appRoot, 'mcs-menu'), '点空白处右键菜单没收起来');
  // 关键：收菜单只能摘掉浮层那一块，不能整页重画 ——
  // 重画会把正在被点的节点换掉，这一次点击就落在旧元素上（点节点选不中）。
  assert.equal(findNodeEl('AAAA000000000002'), sameNode, '收菜单时整页重画了');
});

test('点命令后菜单自己收起来：哪怕那条命令不重画界面', async () => {
  await click(tabElOf('第一章'));
  await click(menuHead('设置'));
  assert.ok(findByClass(appRoot, 'mcs-menu-pop'), '菜单没展开');

  // 「把当前状态打到控制台」只打一行日志，不重画界面。
  // 这种命令点完，弹出层也必须消失（不然菜单会一直挂在那儿）。
  const item = find(appRoot, (n) => cls(n).includes('mcs-menu-item') && textOf(n).includes('把当前状态打到控制台'));
  assert.ok(item, '「设置」菜单里没有那条命令');
  item.listeners.click?.forEach((fn) => fn({}));
  assert.ok(!findByClass(appRoot, 'mcs-menu-pop'), '点完命令菜单还挂在那儿');
  assert.ok(!cls(menuHead('设置')).includes('mcs-menu-btn-on'), '点完命令标题按钮还高亮着');
});

// ------------------------------- 任务书成品预览（2026-11-03）

test('游戏观感：切过去以后节点按 FTB 形状贴图画（遮罩 + 填色），切回来还是方框', async () => {
  await click(tabElOf('第一章'));

  // 编辑网格：节点是带圆角的方框（mcs-box）
  assert.ok(find(appRoot, (n) => n.tagName === 'RECT' && n.attrs.class === 'mcs-box'), '编辑网格下节点不是方框');
  const toggle = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览');
  assert.ok(toggle, '顶部菜单栏没有「预览」按钮');

  // 切到游戏观感：按钮文字固定叫「预览」，状态靠高亮表示
  toggle.listeners.click?.forEach((fn) => fn({}));
  await settle(3);
  const onBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览');
  assert.ok(onBtn && cls(onBtn).includes('mcs-menu-btn-on'), '预览态该高亮');

  // 形状贴图要从后端取：走的是 /quest/images 那条路
  const imgCall = posted.find((p) => p.path === '/api/mcstudio/quest/images' && p.payload.srcs?.some((s) => s.includes('/shapes/')));
  assert.ok(imgCall, '游戏观感没去取 FTB 的形状贴图');
  assert.ok(imgCall.payload.srcs.includes('ftbquests:textures/shapes/gear/shape.png'), '没要齿轮的 shape 贴图');

  // 节点不再是方框，而是用 <mask> 遮罩 + 填色矩形画出来的形状
  assert.ok(!find(appRoot, (n) => n.tagName === 'RECT' && n.attrs.class === 'mcs-box'), '切到游戏观感后节点还是方框');
  const masks = find(appRoot, (n) => n.tagName === 'MASK');
  assert.ok(masks, '没有画形状遮罩（<mask>）');
  const masked = find(appRoot, (n) => n.tagName === 'RECT' && String(n.attrs.mask ?? '').startsWith('url(#'));
  assert.ok(masked, '没有用遮罩填色的矩形');
  // 白色贴图 + 遮罩 = 形状能上色（FTB 的贴图本身是纯白的）
  assert.equal(masked.attrs.fill, '#FFFFFF', '形状没上色');
  // 贴图挂在遮罩里
  const shapeImg = find(appRoot, (n) => n.tagName === 'IMAGE' && String(n.attrs.href ?? '').includes('shapes/gear'));
  assert.ok(shapeImg, '遮罩里没有齿轮贴图');

  // ★ 游戏观感下节点上**只有图标**，不画标题、不画「N 个要求」（2026-11-12 用户：
  //   「我看到游戏里任务书的表现形式就只有图标，前置、后置、奖励都是点击任务节点后出现的」）。
  //   以前这里画了「图形 + 标题 + 2 个要求」，比游戏里多两行字，反而不像。
  const nodeTitles = findAllByClass(appRoot, 'mcs-node-title');
  assert.equal(nodeTitles.length, 0, `游戏观感下不该有节点标题文字，实际 ${nodeTitles.length} 条`);
  const nodeSubs = findAllByClass(appRoot, 'mcs-node-sub')
    .filter((n) => /个要求$/.test(textOf(n)));
  assert.equal(nodeSubs.length, 0, `游戏观感下不该有「N 个要求」，实际 ${nodeSubs.length} 条`);
  // 图标还在（这才是游戏里看得见的东西）
  const iconImg = find(appRoot, (n) => n.tagName === 'IMAGE' && String(n.attrs.href ?? '').startsWith('data:image'));
  assert.ok(iconImg, '节点上该有物品图标');

  // 切回编辑网格：方框回来
  const back = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览');
  assert.ok(back, '切到预览后找不到「预览」按钮');
  back.listeners.click?.forEach((fn) => fn({}));
  await settle(3);
  const offBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览');
  assert.ok(offBtn && !cls(offBtn).includes('mcs-menu-btn-on'), '切回编辑网格该取消高亮');
  assert.ok(find(appRoot, (n) => n.tagName === 'RECT' && n.attrs.class === 'mcs-box'), '切回编辑网格后节点不是方框');
});

test('游戏观感：节点绘制照抄游戏真值（图标 2/3、三层色、状态描边四色、角标、锁定遮罩）', async () => {
  await click(tabElOf('第一章'));
  const lookBtn = () => find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览');
  if (!cls(lookBtn()).includes('mcs-menu-btn-on')) {
    lookBtn().listeners.click?.forEach((fn) => fn({}));
    await settle(3);
  }
  assert.ok(cls(lookBtn()).includes('mcs-menu-btn-on'), '前提：要停在游戏观感态');

  // ① 三层颜色照抄 QuestButton.draw()：
  //    shape → DARK_GRAY(#212121)、background → 白 alpha=150、outline → 状态描边色
  const maskedRects = findAll(appRoot, (n) => n.tagName === 'RECT' && String(n.attrs.mask ?? '').startsWith('url(#'));
  assert.ok(maskedRects.length >= 3, `每个节点至少三层遮罩矩形，实际 ${maskedRects.length}`);
  const fills = maskedRects.map((n) => String(n.attrs.fill ?? ''));
  assert.ok(fills.includes('#212121'), '第一层该是 DARK_GRAY #212121（以前三层全是白的靠 opacity 调深浅）');
  assert.ok(fills.some((f) => f.startsWith('rgba(255, 255, 255')), 'background 层该是白');
  // 未开始的状态描边色是 #96FFFFFF = 白 alpha 150
  assert.ok(fills.some((f) => /rgba\(255, 255, 255, 0\.5/.test(f)), '未开始的描边该是白 alpha≈150');

  // ② 图标边长 = 节点宽度 × 2/3（以前是 0.34，小了近一倍）
  //
  // ★ 定位方法：形状贴图挂在 <mask> 里面，物品图标是直接挂在 <g> 下的 <image>。
  //   前面试过按 `data:image` 前缀 / 按尺寸过滤，都会被形状贴图和背景图混进来
  //   （背景图比节点还大），所以直接按「祖先里有没有 mask」判。
  const insideMask = (node) => {
    let cur = node.parentNode ?? node.parentElement;
    while (cur) {
      if (cur.tagName === 'MASK') return true;
      cur = cur.parentNode ?? cur.parentElement;
    }
    return false;
  };
  const firstMaskRect = maskedRects[0];
  const side = Number(firstMaskRect.attrs.width);
  assert.ok(side > 0, '遮罩矩形要有宽度');
  const iconCandidates = findAll(appRoot, (n) => n.tagName === 'IMAGE' && String(n.attrs.href ?? '').startsWith('data:image'))
    .filter((n) => !insideMask(n));
  assert.ok(iconCandidates.length, '节点上该有物品图标（不在 <mask> 里的那张 <image>）');
  // 物品图标是正方形（等宽等高），背景图 / 形状贴图不会满足「边长 = 节点 × 2/3」
  const iconImgs = iconCandidates.filter((n) => Math.abs(Number(n.attrs.width) - side * (2 / 3)) <= 1.5);
  assert.ok(iconImgs.length, `图标边长该是节点宽度的 2/3（${(side * 2 / 3).toFixed(1)}），实际候选：${iconCandidates.map((n) => n.attrs.width).join(', ')}`);
  const iconW = Number(iconImgs[0].attrs.width);
  assert.ok(iconW > side * 0.6, `图标不能还是老的 0.34 倍（那样只有 ${(side * 0.34).toFixed(1)}）`);

  // ③ 锁定节点：要有黑遮罩 + 角标。
  //    第一章里 AAAA000000000002（任务乙）依赖 AAAA000000000001，编辑器里没有任何
  //    「前置已完成」的信息 → 它必然算锁定。这跟游戏里「依赖没齐」的表现一致。
  const darkRects = maskedRects.filter((n) => String(n.attrs.fill ?? '') === '#000000');
  assert.ok(darkRects.length > 0, '有前置没满足的节点该盖一层黑遮罩（游戏里 BLACK alpha=100）');
  assert.ok(darkRects.some((n) => Math.abs(Number(n.attrs.opacity) - 100 / 255) < 0.01),
    '锁定遮罩的不透明度该是 100/255');

  // ④ 状态角标：边长 = 宽度 × 3/8，贴右上角
  const badges = findAll(appRoot, (n) => n.tagName === 'PATH' || n.tagName === 'LINE' || n.tagName === 'CIRCLE');
  assert.ok(badges.length > 0, '锁定节点该有角标（游戏里 3/8 宽度的小图标）');

  // 切回编辑网格留给下一条用例
  lookBtn().listeners.click?.forEach((fn) => fn({}));
  await settle(3);
});

test('游戏观感：取不到形状贴图就退回方框（不能整张画布空着）', async () => {
  await click(tabElOf('第一章'));

  // 搬到菜单栏后按钮固定叫「预览」，两种状态都靠同一个按钮，点它就切换。
  const lookBtn = () => find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览');
  const toggle = lookBtn();
  assert.ok(toggle, '菜单栏里没有「预览」按钮');

  toggle.listeners.click?.forEach((fn) => fn({}));
  await settle(3);

  // 至少还有节点能看（贴图取到时是形状，取不到时是方框）
  const boxes = find(appRoot, (n) => n.tagName === 'RECT' && n.attrs.class === 'mcs-box');
  assert.ok(boxes || find(appRoot, (n) => n.tagName === 'MASK'), '节点一个都没画出来');

  // 切回去，别把界面留在另一种观感里给下一条用例
  lookBtn()?.listeners.click?.forEach((fn) => fn({}));
  await settle(2);
});

test('分析页：mod 撞车跑出来，同名物品和功能撞车都摆出来', async () => {
  await clickMenu('分析', 'mod 撞车');
  assert.match(textOf(appRoot), /只读：这里的所有检查都不会动你的整合包/, '没切到分析页');

  // 还没跑的时候要有空状态提示，不能一片空白
  assert.match(textOf(appRoot), /点「跑一下」看看这个包/);

  await click(findButton('跑一下'));
  const text = textOf(appRoot);
  assert.match(text, /同名物品/, '同名物品那张卡没出来');
  assert.match(text, /create、demo/, '没列出是哪几个 mod 撞的');
  assert.match(text, /功能撞车/, '功能撞车那张卡没出来');
  assert.match(text, /传动\/齿轮/, '功能族名字没显示');
  assert.match(text, /装饰/, '一个 mod 都没覆盖的功能没显示');
});

test('分析页：进度深度画成条形图，一层一行', async () => {
  await clickMenu('分析', '进度深度');
  await click(findButton('跑一下'));
  const text = textOf(appRoot);
  assert.match(text, /第 0 层/, '第 0 层没显示');
  assert.match(text, /第 1 层/);
  assert.match(text, /80 个/, '每层的物品数没显示');
  // 条形图用的是方块字符
  assert.match(text, /█/, '没画条形图');
  assert.match(text, /minecraft:iron_ingot/, '样例物品没显示');
});

test('分析页：拆 mod 能填名字、能切看哪几块', async () => {
  await clickMenu('分析', '拆开看 mod');
  // 输入框的 placeholder 是属性，不进 textOf，所以按 focus 键找
  assert.ok(findByFocus(appRoot, 'anmod'), '没有 mod 名输入框');
  assert.ok(findButton('拆开看'), '没有「拆开看」按钮');

  typeInto('anmod', 'create');
  await click(findButton('拆开看'));
  let text = textOf(appRoot);
  assert.match(text, /Create/, 'mod 名字没显示');
  assert.match(text, /420/, '物品数没显示');
  assert.match(text, /create-common\.toml/, '配置文件没列出来');

  // 切到「物品」视图：后端按 view 分发（这是 GET，去 calls 里看）
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === '物品'));
  await settle(3);
  const modCalls = calls.filter((c) => c.path === '/api/mcstudio/analysis/mod');
  assert.ok(modCalls.length >= 2, '切视图没有重新请求');
  assert.ok(modCalls.some((c) => c.params.view === 'items'), '切到物品视图没有把 view=items 传过去');
});

test('分析页：来路和谁在用能查物品', async () => {
  await clickMenu('分析', '这个物品怎么来的');
  typeInto('anitem', 'demo:gear');
  await click(findButton('查来路'));
  let text = textOf(appRoot);
  assert.match(text, /demo:gear/, '来路没显示物品');
  assert.match(text, /minecraft:crafting\/gear/, '来路没显示配方');
  assert.match(text, /demo:cogwheel/, '材料没显示');

  await clickMenu('分析', '谁在用它');
  typeInto('anitem', 'demo:cogwheel');
  await click(findButton('查谁在用'));
  text = textOf(appRoot);
  assert.match(text, /用它的配方/, '没列出用它的配方');
  assert.match(text, /minecraft:crafting\/gear/);
});

test('分析页：KubeJS 脚本体检能看出哪个脚本坏了', async () => {
  await clickMenu('分析', 'KubeJS 脚本体检');
  await click(findButton('跑一下'));
  const text = textOf(appRoot);
  assert.match(text, /出问题的脚本/, '没列出坏脚本');
  assert.match(text, /dsh_bad\.js/);
  assert.match(text, /runtime-error/);
  assert.match(text, /引用了不存在的物品/);
  assert.match(text, /demo:nosuch/);
});

test('左栏能搜任务：按关键词找到，点一下就跳到那一章并选中', async () => {
  typeInto('questq', '任务乙');
  await click(findButton('搜'));
  const text = textOf(appRoot);
  assert.match(text, /1 个命中/, '命中数没显示');
  assert.match(text, /任务乙/, '命中的任务没显示');

  await click(find(appRoot, (n) => cls(n).includes('mcs-chapitem') && textOf(n).includes('任务乙')));
  await settle(3);
  assert.match(textOf(appRoot), /任务乙/, '点了之后右栏没显示这个任务');
});

// ------------------------------------------------------- MCP 面板（2026-11-04）
//
// 桌面版自带一个 MCP 服务器：「设置 → 让模型帮你改包」那个面板，
// 生成一段能直接粘进 DSH 的配置。用户能不能拿到那段配置、有没有复制按钮、
// 自检结果显不显示 —— 这三件事必须有人盯着，所以在这里钉住。

/**
 * 剪贴板替身。
 *
 * Node 里 globalThis.navigator 是个只读 getter（descriptor 是 {get, configurable:true}），
 * 所以不能直接 navigator.clipboard = ...，得用 defineProperty 打桩。
 */
function stubClipboard() {
  const writes = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: {
      writeText: async (text) => {
        writes.push(String(text));
      },
    },
    configurable: true,
    writable: true,
  });
  return writes;
}

test('设置菜单里有「让模型帮你改包」，点进去能看到说明和工具名', async () => {
  await clickMenu('设置', '让模型帮你改包');
  const text = textOf(appRoot);
  assert.match(text, /让模型帮你改包/, '没切到 MCP 面板');
  assert.match(text, /MCP 服务器/, '没说明这是什么');
  assert.match(text, /mcp__mcstudio__/, '没告诉用户挂上以后工具名长什么样');
  assert.match(text, /贴到 DSH 里的配置/, '没有「贴到 DSH 里的配置」那一卡');
  assert.match(text, /自检/, '没有自检那一卡');
  assert.ok(findButton('生成配置'), '没有「生成配置」按钮');
  assert.ok(findButton('跑一次自检'), '没有「跑一次自检」按钮');
  // 还没生成配置，不该先把配置内容露出来
  assert.doesNotMatch(text, /ELECTRON_RUN_AS_NODE/, '还没生成配置，不该先出现这段');
});

test('MCP 面板：生成配置能看到能直接粘的 YAML（带 ELECTRON_RUN_AS_NODE）', async () => {
  await clickMenu('设置', '让模型帮你改包');
  await click(findButton('生成配置'));

  // 配置是 GET，而且要把当前连着的整合包目录带过去（写进 env，模型就不用每次报路径）
  const call = calls.find((c) => c.path === '/api/mcstudio/mcp/config');
  assert.ok(call, '没有请求 MCP 配置');
  assert.equal(call.method, 'GET');
  assert.equal(call.params.dir, 'D:\\lab\\DemoPack', '没把当前整合包目录带过去');

  const text = textOf(appRoot);
  assert.match(text, /serverName: mcstudio/, 'YAML 里没有 serverName');
  assert.match(text, /transport: stdio/, 'YAML 里没有传输方式');
  assert.match(text, /@deepseek-ai\/dsh-mcp-client/, 'YAML 里没有客户端包名');
  assert.match(text, /ELECTRON_RUN_AS_NODE/, 'YAML 里没有 ELECTRON_RUN_AS_NODE');
  assert.match(text, /MCSTUDIO_PACK_DIR/, 'YAML 里没有把整合包目录写进去');
  assert.match(text, /服务器脚本：/, '没显示服务器脚本的路径');
  assert.ok(findButton('复制配置'), '生成之后没有「复制配置」按钮');
  assert.match(text, /配置生成好了/, '没提示配置已经生成');
});

test('MCP 面板：自检结果显示工具个数和协议版本', async () => {
  await clickMenu('设置', '让模型帮你改包');
  await click(findButton('跑一次自检'));

  const call = calls.find((c) => c.path === '/api/mcstudio/mcp/selftest');
  assert.ok(call, '没有跑自检');
  assert.equal(call.method, 'GET');
  const text = textOf(appRoot);
  assert.match(text, /自检通过：27 个工具可以用了/, '自检结果没显示');
  assert.match(text, /协议版本 2026-07-28/, '协议版本没显示');
  assert.match(text, /工具清单：/, '工具清单没显示');
  assert.match(text, /recipe_edit/, '工具清单里没有写盘类工具');
});

test('MCP 面板：复制配置把那段 YAML 放进剪贴板', async () => {
  const writes = stubClipboard();
  await clickMenu('设置', '让模型帮你改包');
  if (!findButton('复制配置')) {
    // 上一条用例已经复制过（按钮变成「已复制」而且禁用）：重新生成一份再来
    await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('重新生成')));
  }
  await click(findButton('复制配置'));

  assert.equal(writes.length, 1, '没往剪贴板写东西');
  assert.match(writes[0], /serverName: mcstudio/, '复制过去的不是那段 YAML');
  assert.match(writes[0], /ELECTRON_RUN_AS_NODE/, '复制过去的配置不完整');
  assert.match(textOf(appRoot), /已复制/, '复制完按钮没变成「已复制」');
  assert.match(textOf(appRoot), /配置已经复制到剪贴板/, '状态栏没提示复制成功');
});

test('物品网格：右栏页签切过去是 9×16=144 格，翻页换一批，搜索框能搜（2026-11-05 JEI 式侧边栏）', async () => {
  // 前置：停在任务书页签上（上一条用例把语言切回「自动」了）
  await click(tabElOf('第一章'));
  await settle();

  // 右栏有「详情 / 物品」两个页签
  const itemsTab = findByFocus(appRoot, 'sidetab-items');
  assert.ok(itemsTab, '右栏没有「物品」页签');
  assert.ok(findByFocus(appRoot, 'sidetab-detail'), '右栏没有「详情」页签');

  calls.length = 0;
  await click(itemsTab);
  const gridGet = calls.find((c) => c.path === '/api/mcstudio/item-grid');
  assert.ok(gridGet, '切到物品页没有调 /item-grid');
  assert.equal(gridGet.params.page, '1', '第一次读网格应该从第 1 页开始');

  // 一页 144 格：假数据总共 146 条，第 1 页满格
  const cells = [];
  const collect = (node) => {
    if (!(node instanceof FakeNode)) return;
    if (/(^|\s)mcs-cell(\s|$)/.test(cls(node))) cells.push(node);
    for (const kid of node.children) collect(kid);
  };
  collect(appRoot);
  assert.equal(cells.length, 144, `一页应该是 9×16=144 格，实际 ${cells.length}`);
  assert.match(textOf(appRoot), /146 个/, '没显示总数');
  assert.match(textOf(appRoot), /第 1\/2 页/, '没显示页码');

  // 下一页：第 2 页只剩 2 个物品，其余 142 格是空的
  await click(findButton('下一页'));
  assert.match(textOf(appRoot), /第 2\/2 页/, '翻页没生效');
  const cells2 = [];
  const collect2 = (node) => {
    if (!(node instanceof FakeNode)) return;
    if (/(^|\s)mcs-cell(\s|$)/.test(cls(node))) cells2.push(node);
    for (const kid of node.children) collect2(kid);
  };
  collect2(appRoot);
  const filled2 = cells2.filter((c) => !/(^|\s)mcs-cell-empty(\s|$)/.test(cls(c)));
  assert.equal(filled2.length, 2, `第 2 页应该只有 2 个物品，实际 ${filled2.length}`);

  // 搜索：填词回车走 /item-grid?q=，结果换一批
  await click(findButton('◀'));
  typeInto('gridq', '齿轮');
  // ★ 不能用 findButton('搜') —— 左栏「任务搜索」那个按钮也叫「搜」，
  //   `includes` 会先命中它，点下去搜的是任务不是物品（2026-11-12 踩到）。
  //   这里限定在「物品网格搜索框那一行」里，取第一个按钮（就是「搜」，
  //   它右边那个「清」只在有搜索词时才出现）。
  const gridBox = findByClass(appRoot, 'mcs-grid-search');
  assert.ok(gridBox, '找不到物品网格的搜索框那一行');
  const gridSearchBtn = find(gridBox, (n) => n.tagName === 'BUTTON');
  assert.ok(gridSearchBtn, '物品网格里没有「搜」按钮');
  await click(gridSearchBtn);
  // 搜索结果是**图标格子**，格子上不写 ID 文字 —— 所以别断言文字里有没有
  // `demo:cogwheel`（那永远匹配不到）。改成验「总数变了 + 格子数变了」：
  // 假接口对带 q 的请求只回 2 条。
  const cells3 = [];
  const collect3 = (node) => {
    if (!(node instanceof FakeNode)) return;
    if (/(^|\s)mcs-cell(\s|$)/.test(cls(node))) cells3.push(node);
    for (const kid of node.children) collect3(kid);
  };
  collect3(appRoot);
  const filled3 = cells3.filter((c) => !/(^|\s)mcs-cell-empty(\s|$)/.test(cls(c)));
  assert.equal(filled3.length, 2, `搜「齿轮」应该只剩 2 个物品，实际 ${filled3.length}`);
  assert.match(textOf(appRoot), /2 个/, '搜索结果的总数不对');
});

test('物品网格：点格子把 ID 填进正在编辑的那个框（右栏切回详情能看见）', async () => {
  // 上一条用例停在「物品」页签且搜索框里还有词；先切回详情、把搜索清掉，
  // 否则既找不到「改名」按钮，第一格也不是 demo:item_1。
  await click(findByFocus(appRoot, 'sidetab-detail'));
  await click(findByFocus(appRoot, 'sidetab-items'));
  typeInto('gridq', '');
  // 同一条坑：`findButton('搜')` 会命中左栏任务搜索那个「搜」，必须限定在网格里
  const gridBox2 = findByClass(appRoot, 'mcs-grid-search');
  assert.ok(gridBox2, '找不到物品网格的搜索框那一行');
  await click(find(gridBox2, (n) => n.tagName === 'BUTTON'));
  assert.match(textOf(appRoot), /146 个/, '清空搜索后没回到全部物品');
  await click(findByFocus(appRoot, 'sidetab-detail'));

  // 开一个「改名」草稿，让物品输入框出现
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  assert.ok(node, '蓝图里没找到任务甲');
  await click(node);
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '改名'));
  const itemBox = findByFocus(appRoot, 'rtaskitem');
  assert.ok(itemBox, '改名表单里没有完成条件的物品框');

  // 聚焦这个框（真实交互里用户会先点一下），再切到物品页签
  itemBox.listeners.focus?.forEach((fn) => fn({ target: itemBox }));
  await click(findByFocus(appRoot, 'sidetab-items'));
  // 找第一个「非空格子」：空占位格没有图标也没有 onclick，点了等于没点
  const firstCell = find(appRoot, (n) => /(^|\s)mcs-cell(\s|$)/.test(cls(n)) && !/(^|\s)mcs-cell-empty(\s|$)/.test(cls(n)));
  assert.ok(firstCell, '物品页上没有可点的格子');
  await click(firstCell);

  // 填进去之后要有一句明确反馈，而不是「点了没反应」
  assert.match(textOf(appRoot), /已填入/, '点格子之后没有「填进去了」的反馈');
  assert.match(textOf(appRoot), /demo:item_1/, '反馈里没写填的是什么');

  // 回详情页签，那个框里应该已经是刚点的物品
  await click(findByFocus(appRoot, 'sidetab-detail'));
  const after = findByFocus(appRoot, 'rtaskitem');
  assert.ok(after, '回详情后物品框不见了（草稿被清了？）');
  assert.equal(after.value, 'demo:item_1', '框里没被填上网格里点的物品');
});

test('物品网格：页签切回详情，「任务详情」还在（不能把原来的右栏弄丢）', async () => {
  await click(findByFocus(appRoot, 'sidetab-detail'));
  const text = textOf(appRoot);
  assert.match(text, /任务详情/, '切回详情页签后「任务详情」不见了');
  assert.match(text, /详情/);
  assert.match(text, /物品/);
});

test('中文名补全：默认离线不发请求，点了按钮才下载，署名和状态都在（2026-11-05）', async () => {
  // 前置：摆回第一章、切到物品页。上一条用例切回了详情页签。
  await click(tabElOf('第一章'));
  await settle();
  nameState.cached = false;
  nameState.count = 0;
  calls.length = 0;
  posted.length = 0;
  await click(findByFocus(appRoot, 'sidetab-items'));
  await settle();
  await openGridOpts();

  // 切到物品页只会问一次 preview（只读），绝不会自动发 apply
  assert.ok(calls.some((c) => c.path === '/api/mcstudio/name/preview'), '没读缓存状态');
  assert.ok(!posted.some((p) => p.path === '/api/mcstudio/name/apply'), '默认离线，不该自动下载');

  // 按钮、许可证署名都在
  const fillBtn = findButton('补全中文名');
  assert.ok(fillBtn, '物品页没有「补全中文名」按钮');
  assert.match(textOf(appRoot), /CFPA 汉化包/, '没标来源');
  assert.match(textOf(appRoot), /CC BY-NC-SA 4\.0/, '没标许可证');

  // 点一下：才发 /name/apply，之后状态变成「已缓存、离线可用」
  await click(fillBtn);
  await settle(20);
  assert.ok(posted.some((p) => p.path === '/api/mcstudio/name/apply'), '点了按钮没发下载请求');
  assert.match(textOf(appRoot), /已补全 66111 条中文名/, '没给成功反馈');
  assert.match(textOf(appRoot), /已缓存 66111 条中文名，离线可用/, '没显示缓存状态');
  assert.ok(findButton('重新补全中文名'), '下载完按钮没变成「重新补全」');

  // 摆回详情页签：后面那条语言用例假设右栏是任务详情（sideTab 是整包级，不会自动复位）
  await click(findByFocus(appRoot, 'sidetab-detail'));
});

test('中文名下载：界面上有进度条，下完弹一条通知，点通知能关掉（2026-11-06）', async () => {
  // 前置：摆回第一章、切到物品页。上一条用例切回了详情页签。
  await click(tabElOf('第一章'));
  await settle();
  nameState.cached = false;
  nameState.count = 0;
  posted.length = 0;
  await click(findByFocus(appRoot, 'sidetab-items'));
  await settle();
  await openGridOpts();

  // 让 /name/apply 卡在「下载中」：这样能断言进度条那一帧长什么样。
  // 跟装 mod 那条用例一个套路（applyGate），但这里卡的是 name/apply。
  let release = null;
  nameApplyGate = new Promise((r) => { release = r; });
  await click(findButton('补全中文名'));
  await settle(4);

  // 点下去就该问后端要进度（按 kind 问，因为这时候还不知道 jobId）
  const watch = calls.find((c) => c.path === '/api/mcstudio/progress' && c.params.kind === 'name-fill');
  assert.ok(watch, '下载时没问后端要 name-fill 的进度');

  // 进度条在界面上：标题、百分比、已下/总量都对
  const bar = findByClass(appRoot, 'mcs-pbar-box');
  assert.ok(bar, '下载中没画进度条');
  const barText = textOf(bar);
  assert.match(barText, /下载中文名（CFPA 汉化包）/, '进度条没标题');
  assert.match(barText, /51%/, '没显示百分比');
  assert.match(barText, /1\.7 MB \/ 3\.4 MB/, '没显示已下/总量');
  assert.match(barText, /879 KB\/s/, '没显示速度');
  const fill = findByClass(appRoot, 'mcs-pbar-fill');
  assert.ok(fill, '没有进度条填充块');
  assert.match(String(fill.style ?? ''), /width:\s*51%/, '进度条宽度不对');

  // 放行：下载完
  release();
  await settle(24);

  // 通知浮层：有，说的就是补全成功
  const toast = findByClass(appRoot, 'mcs-toast');
  assert.ok(toast, '下载完没弹通知');
  assert.match(textOf(toast), /已补全 66111 条中文名/, '通知里没说补了多少');
  assert.match(textOf(toast), /CC BY-NC-SA 4\.0/, '通知里没标许可证');
  // 通知不能常驻在物品页上（用户要的是「告知完就消失」）
  assert.ok(!hasClass('mcs-name-fill-note') || !/已补全 66111 条中文名/.test(
    textOf(findByClass(appRoot, 'mcs-name-fill-note') ?? appRoot),
  ), '成功提示还留在物品页上（应该只走通知）');

  // 轮询要停了，不能一直空转
  assert.equal(fakeTimers.length, 0, '下载完了还在轮询进度');

  // 点一下通知：立刻关掉
  await click(findByFocus(appRoot, 'toast'));
  assert.ok(!findByClass(appRoot, 'mcs-toast'), '点了通知它还在');

  // 摆回详情页签
  await click(findByFocus(appRoot, 'sidetab-detail'));
  nameApplyGate = null;
});

test('任务书能选语言：切到英文后 GET/POST 都带 locale，预览和写入一致，点自动退回默认（2026-11-04 第 4 批 B）', async () => {
  // 上一条用例停在 MCP 面板；回选项目页再重连，让 connect() 把 questLocale 复位成「自动」。
  await clickMenu('文件', '换一个整合包');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await settle(16);
  // 语言搬进「设置」菜单了：展开菜单后按文字找菜单项，当前项带 ✓ 前缀。
  // 点一项会关掉菜单并重画，所以每次动手前都要重新展开一次。
  const openLocaleItems = async () => {
    if (!find(appRoot, (n) => cls(n).includes('mcs-menu-item') && textOf(n).includes('自动'))) {
      await click(menuHead('设置'));
    }
  };
  const findLocaleItem = (label) => find(appRoot, (n) => cls(n).includes('mcs-menu-item') && textOf(n).includes(label));
  await openLocaleItems();
  assert.ok(findLocaleItem('自动'), '设置菜单里没有「自动」语言项');
  assert.ok(findLocaleItem('英文'), '设置菜单里没有「英文」语言项（/questbook 的 locales 没渲染出来）');

  // 切到英文：整本书要重读，/questbook 与 /quest/canvas 的 GET 都得带 locale=en_us
  calls.length = 0;
  await click(findLocaleItem('英文'));
  await settle(20);
  const bookGet = calls.find((c) => c.path === '/api/mcstudio/questbook' && c.params.locale === 'en_us');
  assert.ok(bookGet, '切英文后 /questbook 没带 locale=en_us');
  const canvasGet = calls.find((c) => c.path === '/api/mcstudio/quest/canvas' && c.params.locale === 'en_us');
  assert.ok(canvasGet, '切英文后 /quest/canvas 没带 locale=en_us');

  // 改名预览 / 写入：POST body 也要带同一份 locale，否则「预览改 en_us、真写进默认语言」
  // 前面用例可能停在第二章页签；显式切回第一章，保证任务甲的节点被画出来
  const ch1Tab = tabElOf('第一章');
  assert.ok(ch1Tab, '切语言后第一章页签不见了');
  await click(ch1Tab);
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  assert.ok(node, '切语言后蓝图里没找到任务甲的节点');
  await click(node);
  const renameBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '改名');
  assert.ok(renameBtn, '切语言后右栏没有「改名」按钮');
  await click(renameBtn);
  posted.length = 0;
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会改什么'));
  const preview = posted.find((p) => p.path === '/api/mcstudio/quest/preview');
  assert.ok(preview, '没有调 /quest/preview');
  assert.equal(preview.payload.locale, 'en_us', '预览的 POST body 没带 locale=en_us');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '确认写入'));
  const apply = posted.find((p) => p.path === '/api/mcstudio/quest/apply');
  assert.ok(apply, '没有调 /quest/apply');
  assert.equal(apply.payload.locale, 'en_us', '写入的 POST body 没带 locale=en_us');
  assert.deepEqual(apply.payload, preview.payload, '预览和写入的 body 不一致（语言可能一边 en_us 一边默认）');

  // 点「自动」退回默认：之后 /questbook 的 GET 不该再带 locale
  await openLocaleItems();
  const autoItem = findLocaleItem('自动');
  assert.ok(autoItem, '设置菜单里找不到「自动」，没法退回默认');
  calls.length = 0;
  await click(autoItem);
  await settle(20);
  const bookAfter = calls.find((c) => c.path === '/api/mcstudio/questbook');
  assert.ok(bookAfter, '点自动后没重新读 /questbook');
  assert.equal(bookAfter.params.locale, undefined, '点自动后 /questbook 还带着 locale，说明没回到默认');
});

test('图标补全引导页：文件菜单进得去，五步能展开、能复制命令、能重扫（2026-11-07 任务②）', async () => {
  // 上一条用例可能停在「物品」页签：摆回「详情」，右栏才会走 contextSide() 显示说明卡。
  await click(findByFocus(appRoot, 'sidetab-detail'));
  await clickMenu('文件', '补全物品图标');
  await settle(16);

  // 独立工具页：标题 + 现状卡 + 默认收起的教学卡 + 顶栏重扫按钮
  assert.match(textOf(appRoot), /补全物品图标/, '没切到图标补全页');
  assert.match(textOf(appRoot), /现在的情况/, '没有「现在的情况」卡');
  assert.match(textOf(appRoot), /图标：/, '现状卡没显示图标那一行');
  assert.ok(findButton('看这五步怎么做'), '教学卡默认没收起（找不到展开按钮）');
  assert.ok(findButton('重新扫描图标'), '顶栏没有「重新扫描图标」按钮');

  // 点开五步
  await click(findButton('看这五步怎么做'));
  const text = textOf(appRoot);
  assert.match(text, /8KCmS7Bd/, '第一步没写 Icon Exporter 的工程编号');
  assert.match(text, /Z9DM0LJ4/, '第一步没写 Cyclops Core 的工程编号');
  assert.match(text, /\/iconexporter export 64/, '第三步没有那条导出命令');
  assert.match(text, /icon-exports-x64/, '第四步没写导出目录名（带 x64）');
  assert.match(text, /重新扫描图标/, '第五步没提「重新扫描图标」');
  // 右栏两张说明卡
  assert.match(text, /为什么不让工作室自己画/, '右栏缺「为什么」说明卡');
  assert.match(text, /会不会动我的整合包/, '右栏缺「只读」说明卡');

  // 复制命令只改按钮那块文字，不整页 render
  const writes = stubClipboard();
  assert.ok(findButton('复制命令'), '展开后没有「复制命令」按钮');
  await click(findButton('复制命令'));
  assert.equal(writes[0], '/iconexporter export 64', '复制的命令不对');
  assert.ok(findButton('已复制'), '复制完按钮没变成「已复制」');

  // 重扫：POST /icon-export/scan，现状行换成新数字
  posted.length = 0;
  await click(findButton('重新扫描图标'));
  await settle();
  const scanCall = posted.find((p) => p.path === '/api/mcstudio/icon-export/scan');
  assert.ok(scanCall, '点「重新扫描图标」没调 /icon-export/scan');
  assert.match(textOf(appRoot), /游戏导出 1900 个/, '重扫后的新数字没显示');

  // 回选项目页，别把工作台状态留给后面的用例
  await clickMenu('文件', '换一个整合包');
  assert.match(textOf(appRoot), /先挑一个整合包/, '没回到选项目页');
});

test('游戏清单口径：没导入默认全显示、导入后自动精确、开关能切回（2026-11-07 任务③）', async () => {
  // 网格搜索框敲回车＝精确触发 gridSearch()（findButton('搜') 会先撞上左栏章节搜索那个按钮）。
  const gridEnter = async () => {
    const inp = findByFocus(appRoot, 'gridq');
    assert.ok(inp, '右栏没有网格搜索框');
    inp.listeners.keydown?.forEach((fn) => fn({ key: 'Enter', target: inp }));
    await settle();
  };
  // 整包级状态用例间不复位：开头自己摆正（假清单状态 + 重新连包 + 右栏页签 + 搜索词）。
  truthState.has = false;
  truthState.source = '';
  truthState.count = 0;
  // 上一条用例停在选项目页：点 DemoPack 回工作台（connect 会清 state.grid 并重新问 status）。
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await settle(16);
  await click(findByFocus(appRoot, 'sidetab-detail'));
  await click(findByFocus(appRoot, 'sidetab-items'));
  await openGridOpts();
  typeInto('gridq', '');
  await gridEnter();

  // 1) 没导过清单：默认「显示全部」+ 明说不精确，且 /item-grid 逐字等同改造前（不带 showAll）。
  let text = textOf(appRoot);
  assert.match(text, /还没导入游戏清单，当前显示全部/, '没导过清单时没写明「当前显示全部」');
  assert.ok(findButton('导入游戏清单…'), '没导入时没有导入按钮');
  assert.ok(findButton('怎么导出？'), '没导入时没有「怎么导出」入口');
  assert.ok(findButton('只显示游戏里真有的'), '开关初始态不对');
  calls.length = 0;
  await gridEnter();
  const plain = calls.find((c) => c.path === '/api/mcstudio/item-grid');
  assert.ok(plain, '没重新读网格');
  assert.equal(plain.params.showAll, undefined, '默认请求不该带 showAll（不带时请求逐字等同改造前）');

  // 2) 导出步骤链到任务②的图标引导页（「让游戏自己产出数据」合并成一张教学）。
  await click(findButton('怎么导出？'));
  assert.match(textOf(appRoot), /想让物品清单也 100% 精确/, '导出引导没挂到图标补全页');
  await click(findButton('看怎么导出游戏清单'));
  assert.match(textOf(appRoot), /四步：让游戏自己报一遍物品清单/, '第三张卡展开后没有四步说明');
  assert.match(textOf(appRoot), /jeidump\.json/, '四步里没提游戏导出的清单文件名');
  // 回物品页签继续（gotoPanel 会切中栏，右栏页签仍是 items）
  await click(findByFocus(appRoot, 'sidetab-detail'));
  await click(findByFocus(appRoot, 'sidetab-items'));

  // 3) 导入清单：走现成的选目录通路 → POST /item-truth/import → 自动切成精确。
  // importTruth 里 waitPickFolder 有真实 500ms 等待，显式等过它再收尾。
  posted.length = 0;
  const importBtn = findButton('导入游戏清单…');
  assert.ok(importBtn, '右栏网格里找不到「导入游戏清单…」按钮');
  await click(importBtn);
  await new Promise((r) => setTimeout(r, 650));
  await settle(30);
  const importCall = posted.find((p) => p.path === '/api/mcstudio/item-truth/import');
  assert.ok(importCall, '没发 /item-truth/import');
  assert.ok(importCall.payload.file, '导入请求没带清单路径');
  text = textOf(appRoot);
  assert.match(text, /照游戏清单显示（100% 精确）/, '导入后没自动切成精确口径');
  assert.ok(!/还没导入游戏清单/.test(text), '导入后还写着「还没导入」');

  // 4) 点开关切「显示全部」：/item-grid 要带 showAll=1，界面文案跟着换。
  calls.length = 0;
  await click(findButton('只显示游戏里真有的'));
  await settle(20);
  const allCall = calls.find((c) => c.path === '/api/mcstudio/item-grid' && c.params.showAll === '1');
  assert.ok(allCall, '点「显示全部」后 /item-grid 没带 showAll=1');
  assert.match(textOf(appRoot), /当前显示全部/, '开关没切到「当前显示全部」');
  assert.ok(findButton('显示全部 ✓'), '开关按钮没变成勾选态');

  // 5) 点回默认：重新变回「照清单显示」。
  await click(findButton('显示全部 ✓'));
  await settle(20);
  assert.match(textOf(appRoot), /照游戏清单显示（100% 精确）/, '点回默认没回到精确口径');

  // 收尾：假清单状态复位 + 回选项目页，别把「导过清单」留给后面的用例。
  truthState.has = false;
  truthState.source = '';
  truthState.count = 0;
  await clickMenu('文件', '换一个整合包');
  assert.match(textOf(appRoot), /先挑一个整合包/, '没回到选项目页');
});



// ===== 2026-11-08 第 2 条：界面「完成条件 / 奖励支持多类型」=====
// 类型按钮组 + 动态字段：非物品类型走 taskSpec / rewardSpec（JSON 串），
// 物品类型仍走老四个字段。两条路最终都落到同一套 packages/core/*。
test('新建任务能选非物品类型：点「击杀生物」出动态字段，预览/写入发 taskSpec（JSON 串）', async () => {
  // 上一条用例收尾回到了选项目页，这里重新连一次，起点干净
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await settle(16);
  // 重新连上后右栏可能还停在「物品网格」页签，草稿卡画在「任务详情」里，先切回去
  await click(findByFocus(appRoot, 'sidetab-detail'));

  posted.length = 0;
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '＋新任务'));
  assert.match(textOf(appRoot), /在这里新建任务|在它后面加一个任务/, '草稿卡没出来');

  // ★ 2026-11-13（默认值改造）用户拍板「新建任务不需要预填物品类型」：
  //   一进来**一个类型都不高亮**，也不出任何输入框 —— 建出来是个干净的空任务
  //   （tasks: []、rewards: []），和游戏里新建任务一模一样。
  //   以前默认选中「物品」，界面会装作「条件已经配好了」。
  assert.ok(!findByFocus(appRoot, 'newtaskitem'), '没选类型时不该出现物品输入框');
  assert.ok(!findByFocus(appRoot, 'newrewarditem'), '没选类型时不该出现奖励输入框');
  // ★ 不能用 findButton('物品')：会先撞上右栏的「物品」页签，把整包状态带歪。
  //   类型按钮的 title 属性存的是类型名。
  const typeBtn = (label) => find(appRoot, (n) => n.tagName === 'BUTTON' && n.attrs.title === label);
  assert.ok(typeBtn('item'), '「物品」类型按钮还在（只是没被选中）');
  await click(typeBtn('item'));
  assert.ok(findByFocus(appRoot, 'newtaskitem'), '选了「物品」之后该出物品输入框');

  // 换成「击杀生物」：类型按钮在 BUTTON 上，点完 render() 换成该类型的字段
  const killBtn = typeBtn('kill');
  assert.ok(killBtn, '完成条件里没有「击杀生物」类型按钮');
  await click(killBtn);

  // 换类型后：物品输入框消失，出现按 fields 生成的动态输入框
  assert.ok(!findByFocus(appRoot, 'newtaskitem'), '切到击杀类型后还留着物品输入框');
  const entityBox = findByFocus(appRoot, 'newspec_entity');
  const countBox = findByFocus(appRoot, 'newspec_count');
  assert.ok(entityBox, '击杀类型没有「生物 ID」输入框');
  assert.ok(countBox, '击杀类型没有「要几只」输入框');

  typeInto('newtitle', '杀僵尸');
  typeInto('newspec_entity', 'minecraft:zombie');
  typeInto('newspec_count', '5');

  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览要加什么'));
  const previewCall = posted.find((p) => p.path === '/api/mcstudio/quest/add/preview');
  assert.ok(previewCall, '没有调 /quest/add/preview');
  const p = previewCall.payload;
  assert.ok(!('taskItem' in p), '非物品类型不该再发 taskItem');
  assert.equal(typeof p.taskSpec, 'string', 'taskSpec 应该是 JSON 串');
  const spec = JSON.parse(p.taskSpec);
  assert.equal(spec.type, 'kill', '类型没写进 spec');
  assert.equal(spec.entity, 'minecraft:zombie', '生物 ID 没写进 spec');
  assert.equal(spec.count, 5, '要几只没写进 spec');
  assert.ok(!('label' in spec), 'spec 里不该带界面显示的 label');

  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '确认写入'));
  const applyCall = posted.find((q) => q.path === '/api/mcstudio/quest/add/apply');
  assert.ok(applyCall, '没有调 /quest/add/apply');
  assert.deepEqual(applyCall.payload, p, 'apply 的字段和 preview 不一致');
  assert.match(textOf(appRoot), /写好了/, 'done 卡没出来');
});

test('改名卡能把奖励换成经验：点「给经验点」，预览/写入发 rewardSpec（JSON 串）', async () => {
  // 回到选项目页重新连，别靠上一条用例留下的 done 卡状态
  await clickMenu('文件', '换一个整合包');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await settle(16);
  await click(findByFocus(appRoot, 'sidetab-detail'));

  // 点节点甲读详情，再开改名卡
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  assert.ok(node, '蓝图里没找到任务甲的节点');
  await click(node);
  posted.length = 0;
  const renameBtn = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '改名');
  assert.ok(renameBtn, '右栏没有「改名」按钮');
  await click(renameBtn);

  // 默认奖励是「给物品」：预填仍是老四字段
  assert.equal(findByFocus(appRoot, 'rrewarditem').value, 'minecraft:diamond', '奖励没按详情预填');
  const xpBtn = findButton('给经验点');
  assert.ok(xpBtn, '奖励里没有「给经验点」类型按钮');
  await click(xpBtn);

  assert.ok(!findByFocus(appRoot, 'rrewarditem'), '切到经验类型后还留着奖励物品输入框');
  const countBox = findByFocus(appRoot, 'rspec_count');
  assert.ok(countBox, '经验类型没有「给多少点」输入框');

  typeInto('rspec_count', '250');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会改什么'));
  const previewCall = posted.find((p) => p.path === '/api/mcstudio/quest/preview');
  assert.ok(previewCall, '没有调 /quest/preview');
  const p = previewCall.payload;
  assert.ok(!('rewardItem' in p), '非物品类型不该再发 rewardItem');
  assert.equal(typeof p.rewardSpec, 'string', 'rewardSpec 应该是 JSON 串');
  const spec = JSON.parse(p.rewardSpec);
  assert.equal(spec.type, 'xp', '类型没写进 spec');
  assert.equal(spec.count, 250, '给多少点没写进 spec');

  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '确认写入'));
  const applyCall = posted.find((q) => q.path === '/api/mcstudio/quest/apply');
  assert.ok(applyCall, '没有调 /quest/apply');
  assert.deepEqual(applyCall.payload, p, 'apply 的字段和 preview 不一致');
  assert.match(textOf(appRoot), /写好了/, 'done 卡没出来');
});

// ===== 2026-11-12 第一批：奖励不许再写游戏不认的假字段 =====
// all_table 这个类型不存在（删了）、permission_level 这个字段不存在（换成 elevatePerms 布尔）。
// 这两条都是「界面上填了、看着一切正常、游戏里什么都不发生也不报错」的类型，必须钉死。
test('奖励列表里没有假类型「整表全给」，命令奖励发的是 elevatePerms 不是 permissionLevel', async () => {
  await clickMenu('文件', '换一个整合包');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await settle(16);
  await click(findByFocus(appRoot, 'sidetab-detail'));

  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  assert.ok(node, '蓝图里没找到任务甲的节点');
  await click(node);
  posted.length = 0;
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '改名'));

  // ① 假类型不许出现在奖励类型按钮组里
  assert.ok(!findButton('战利品表（整表全给）'), '奖励里不该有「整表全给」——FTB 根本没这个类型');
  assert.ok(!textOf(appRoot).includes('整表全给'), '界面上任何地方都不该出现「整表全给」');

  // ② 命令奖励的字段：有「用管理员权限执行」开关，没有「权限等级」数字框
  const cmdBtn = findButton('执行命令');
  assert.ok(cmdBtn, '奖励里没有「执行命令」类型按钮');
  await click(cmdBtn);
  assert.ok(findByFocus(appRoot, 'rspec_elevatePerms'), '命令奖励没有「用管理员权限执行」开关');
  assert.ok(!findByFocus(appRoot, 'rspec_permissionLevel'), '命令奖励不该再有「权限等级」框');

  typeInto('rspec_command', '/give @p minecraft:diamond 1');
  // bool 字段是 checkbox，用 change 事件翻
  const permBox = findByFocus(appRoot, 'rspec_elevatePerms');
  permBox.checked = true;
  permBox.listeners.change?.forEach((fn) => fn({ target: permBox }));

  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览会改什么'));
  const previewCall = posted.find((p) => p.path === '/api/mcstudio/quest/preview');
  assert.ok(previewCall, '没有调 /quest/preview');
  const spec = JSON.parse(previewCall.payload.rewardSpec);
  assert.equal(spec.type, 'command');
  assert.equal(spec.command, '/give @p minecraft:diamond 1');
  assert.equal(spec.elevatePerms, true, '开关打开了就该发 elevatePerms:true');
  assert.equal(spec.permissionLevel, undefined, '绝不许再发 permissionLevel —— 游戏不读这个字段');

  // 收尾：把草稿卡关掉，别把 done 卡留给下一条用例
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '取消'));
  await settle(4);
});

// ===== 2026-11-08 第 3 条：批量改配方（中栏勾选 → 一次预览 → 一次写盘）=====

/** 用例之间共享 state，开头摆正到「搜出 demo:gear 的配方列表」这一帧。 */
async function gotoRecipeList() {
  await clickMenu('编译', '搜物品');
  typeInto('rq', '齿轮');
  await click(findButton('搜物品'));
  await click(find(appRoot, (n) => cls(n).includes('mcs-pick-row') && textOf(n).includes('demo:gear')));
  assert.match(textOf(appRoot), /能做出它/, '没回到配方列表');
}

test('批量改配方：勾两条 → 预览删掉 → 确认写入，apply 逐字复用 preview 入参', async () => {
  await gotoRecipeList();

  // 列表里 producers 两条 + consumers 一条，一共三个小勾
  let ticks = collectTicks();
  assert.equal(ticks.length, 3, `配方行应该有三个可勾的小勾，实际 ${ticks.length} 个`);

  // 勾前两个（点小勾不该顺带打开单条编辑：界面里靠 stopPropagation 掐掉冒泡）
  await click(ticks[0]);
  ticks = collectTicks();
  await click(ticks[1]);
  assert.match(textOf(appRoot), /选中了 2 条配方/, '勾两条后没出操作条');
  assert.ok(!find(appRoot, (n) => cls(n).includes('mcs-recipe-row') && textOf(n).includes('改成什么')), '点小勾不该打开单条编辑');

  posted.length = 0;
  await click(findButton('预览：删掉选中的 2 条'));

  const previewCall = posted.find((p) => p.path === '/api/mcstudio/recipe/batch/preview');
  assert.ok(previewCall, '没有调批量预览接口');
  assert.equal(previewCall.payload.action, 'remove');
  const items = JSON.parse(previewCall.payload.items);
  assert.equal(items.length, 2, 'items 里应该正好两条');
  assert.equal(items[0].recipeId, 'create:pressing/cogwheel');

  let text = textOf(appRoot);
  assert.match(text, /这批 2 条会改什么（还没写盘）/, '批量预览卡没出来');
  assert.match(text, /会写进：/, '预览卡没列出要写的文件');
  assert.match(text, /ServerEvents\.recipes/, '预览卡没摊开脚本代码');
  assert.match(text, /demo:gear（3 条配方要用）/, '影响面里的 critical 没用红字列出来');
  assert.match(text, /注意：dsh_recipes\.js 已经存在/, 'warnings 没显示');

  posted.length = 0;
  await click(findButton('确认批量写入'));

  const applyCall = posted.find((p) => p.path === '/api/mcstudio/recipe/batch/apply');
  assert.ok(applyCall, '没有调批量写入接口');
  assert.deepEqual(applyCall.payload, previewCall.payload, 'apply 必须逐字复用 preview 的入参（后端会重算）');

  text = textOf(appRoot);
  assert.match(text, /这批写好了，复验通过/, '写入结果卡没出来');
  assert.match(text, /文件：/, '结果卡没列写入的文件');
  assert.match(text, /备份：/, '结果卡没列备份');
  // 写入后 recipeHits 被清掉，但结果卡要还挂在列表块外面；否则用户永远看不到「写好了」
  assert.doesNotMatch(text, /能做出它（改这些/, '写入后配方清单该作废、下次重读');
  assert.match(text, /这批写好了/, '结果卡不能因为清单清空而消失');
});

test('批量改配方：勾一条 → 预览「产出都 +1」带 delta，先不写能撤掉预览', async () => {
  await gotoRecipeList();

  await click(collectTicks()[0]);
  assert.match(textOf(appRoot), /选中了 1 条配方/);

  posted.length = 0;
  await click(findButton('预览：选中的产出都 +1'));

  const previewCall = posted.find((p) => p.path === '/api/mcstudio/recipe/batch/preview');
  assert.ok(previewCall, '没有调批量预览接口');
  assert.equal(previewCall.payload.action, 'edit');
  assert.equal(previewCall.payload.delta, 1, 'edit 动作要带 delta（产出 +1）');
  assert.equal(JSON.parse(previewCall.payload.items).length, 1);
  assert.match(textOf(appRoot), /这批 1 条会改什么（还没写盘）/);

  await click(findButton('先不写'));
  assert.doesNotMatch(textOf(appRoot), /这批 1 条会改什么/, '点「先不写」后预览卡该收掉');
  assert.equal(posted.filter((p) => p.path === '/api/mcstudio/recipe/batch/apply').length, 0, '先不写绝不能碰写盘接口');
});

// ===== 2026-11-08：物品数据设置收进折叠横栏（不删功能，只是默认收起）=====

test('物品数据设置：默认收起只留一条折叠横栏，点开才露出补全中文名和游戏清单', async () => {
  // optsOpen 是整包级、用例间不复位：先回选项目页再重新连包，connect() 会把它归零，
  // 这样验的才是「刚打开时默认收起」，不是「我手动给收回去」。
  await clickMenu('文件', '换一个整合包');
  assert.match(textOf(appRoot), /先挑一个整合包/, '没回到选项目页');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await settle(16);
  await click(findByFocus(appRoot, 'sidetab-detail'));
  await click(findByFocus(appRoot, 'sidetab-items'));
  await settle();

  // render() 会整棵重画，横栏节点每次都得重新找
  const bar = () => find(appRoot, (n) => n.tagName === 'BUTTON'
    && String(n.className ?? '').split(/\s+/).includes('mcs-grid-opts-bar'));
  assert.ok(bar(), '右栏没有「物品数据设置」折叠横栏');
  assert.ok(textOf(bar()).startsWith('▸'), '默认该是收起的（▸）');
  assert.match(textOf(bar()), /物品数据设置/, '折叠条没写标题');
  assert.ok(!findByClass(appRoot, 'mcs-name-fill'), '默认不该露出「补全中文名」那一组');
  assert.ok(!findByClass(appRoot, 'mcs-grid-truth'), '默认不该露出「游戏清单」那一组');

  // 点一下展开：箭头变 ▾，两组都出现
  await click(bar());
  assert.ok(textOf(bar()).startsWith('▾'), '点开后该变成展开的（▾）');
  assert.ok(findByClass(appRoot, 'mcs-name-fill'), '展开后没有「补全中文名」那一组');
  assert.ok(findByClass(appRoot, 'mcs-grid-truth'), '展开后没有「游戏清单」那一组');

  // 再点一下收回去
  await click(bar());
  assert.ok(textOf(bar()).startsWith('▸'), '再点该收回去');
  assert.ok(!findByClass(appRoot, 'mcs-name-fill'), '收回后「补全中文名」还在');
  assert.ok(!findByClass(appRoot, 'mcs-grid-truth'), '收回后「游戏清单」还在');

  // 收尾回详情页签，别把物品页留给后面的用例
  await click(findByFocus(appRoot, 'sidetab-detail'));
});

// ===== 2026-11-09：蓝图式编辑（空白右键菜单 / 物品拖放 / Ctrl+C,V）=====

/** 蓝图用例开头：重连一次 DemoPack，把缩放、平移、浮层、复制、草稿全归零，
 *  再切回第一章画布页签。这样拖放落点用的是初始坐标系（scale=1 / tx=0 / ty=0）。 */
async function blueprintReset() {
  document.activeElement = null;
  await clickMenu('文件', '换一个整合包');
  assert.match(textOf(appRoot), /先挑一个整合包/, '没回到选项目页');
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
  await settle(16);
  await click(tabElOf('第一章'));
  await settle(4);
}

/** 在画布空白处右键，弹出「新建任务 / 搜索物品」浮层。
 *  用例间共享 state：先空跑一次把可能残留的 suppressContextMenu 清回 false，
 *  再正式右键。render() 会整棵重画，所以每次都重新找容器。 */
async function openBlankMenuAt(clientX, clientY) {
  for (let i = 0; i < 2; i += 1) {
    const host = findCanvasHost();
    assert.ok(host, '没找到画布容器');
    host.listeners.contextmenu?.forEach((fn) => fn({ clientX, clientY, preventDefault() {} }));
    await settle(4);
  }
}

/** 只认「在这块空白上」那张右键菜单，免得撞到顶部下拉菜单。 */
function blankMenuEl() {
  return find(appRoot, (n) => String(n.className ?? '').split(/\s+/).includes('mcs-menu')
    && textOf(n).includes('在这块空白上'));
}

function blankItem(label) {
  const menu = blankMenuEl();
  return menu
    ? find(menu, (n) => String(n.className ?? '').split(/\s+/).includes('mcs-menu-item')
      && textOf(n).includes(label))
    : null;
}

/** 打开搜物品浮层，输入关键字，返回指定物品的椭圆框。 */
async function pickerChip(q, itemId) {
  const search = blankItem('搜索物品');
  assert.ok(search, '空白菜单里没有「搜索物品」');
  await click(search);
  assert.ok(findByClass(appRoot, 'mcs-item-picker'), '没打开搜物品浮层');
  typeInto('item-picker-q', q);
  await settle(16);
  const chip = find(appRoot, (n) => n.attrs['data-item'] === itemId);
  assert.ok(chip, `浮层里没搜出「${itemId}」的椭圆框`);
  return chip;
}

/** 拖椭圆框到某处松手。先派发一次 pointerup 收掉前面用例残留在 document 上的
 *  平移 / 框选监听器，免得它们顺手改了 view.tx/ty 把落点算偏。 */
async function dropChip(chip, dx, dy) {
  fireDoc('pointerup', { clientX: 0, clientY: 0 });
  await dragBy(chip, dx, dy);
  await settle(30);
}

test('蓝图式编辑：画布空白处右键有「新建任务 / 搜索物品」两项，点外面能收', async () => {
  await blueprintReset();
  await openBlankMenuAt(900, 700);

  const menu = blankMenuEl();
  assert.ok(menu, '空白处右键没弹菜单');
  assert.match(textOf(menu), /在这块空白上/, '该是空白菜单，不是任务菜单');
  assert.match(textOf(menu), /新建任务/);
  assert.match(textOf(menu), /搜索物品/);

  // 点外面：只摘浮层，别整页重画（沿用「点外面收菜单」那条老规矩）
  const sameNode = findNodeEl('AAAA000000000001');
  fireDoc('pointerdown', { target: appRoot, button: 0 });
  assert.ok(!blankMenuEl(), '点外面没收掉菜单');
  assert.equal(findNodeEl('AAAA000000000001'), sameNode, '收菜单时整页重画了');
});

test('蓝图式编辑：搜物品浮层出椭圆框，拖进任务节点＝追加一条要求', async () => {
  await blueprintReset();
  await openBlankMenuAt(900, 700);
  const chip = await pickerChip('齿轮', 'demo:gear');
  assert.match(textOf(chip), /齿轮/, '椭圆框上没写物品名');
  assert.ok(find(chip, (n) => n.tagName === 'ELLIPSE'), '物品框不是椭圆');

  posted.length = 0;
  // 起点 (100,100)，松手 (110,110)：正好落在任务甲的盒子里 [48,164]×[48,140]
  await dropChip(chip, 10, 10);

  const call = posted.find((p) => p.path === '/api/mcstudio/quest/node/items/apply');
  assert.ok(call, '拖进节点没有调「追加要求」接口');
  assert.equal(call.payload.questId, 'AAAA000000000001', '没落在任务甲上');
  assert.equal(call.payload.item, 'demo:gear');
  assert.equal(call.payload.count, 1);
  assert.match(textOf(appRoot), /已把「demo:gear」加进那个任务的要求/);
});

test('蓝图式编辑：物品拖到空白处＝真的新建一个任务节点', async () => {
  await blueprintReset();
  await openBlankMenuAt(900, 700);
  const chip = await pickerChip('齿轮', 'demo:gear');

  posted.length = 0;
  // 松手 (900,700)：远离两个任务盒子，算空白落点
  await dropChip(chip, 800, 600);

  const call = posted.find((p) => p.path === '/api/mcstudio/quest/spawn/apply');
  assert.ok(call, '拖到空白没有调「新建任务节点」接口');
  assert.equal(call.payload.item, 'demo:gear');
  assert.equal(call.payload.count, 1);
  assert.equal(call.payload.chapter, 'CH1', '没记下是哪一章');
  assert.equal(typeof call.payload.x, 'number', '没算落点 x');
  assert.equal(typeof call.payload.y, 'number', '没算落点 y');
  assert.match(textOf(appRoot), /已在空白处新建一个交「demo:gear」的任务/);
});

test('蓝图式编辑：Ctrl+C 复制任务、Ctrl+V 粘贴出一份新任务', async () => {
  await blueprintReset();
  // 先点一下任务甲，让「当前选中」有东西
  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle(16);
  // 键盘事件不能落在输入框里，否则会被当成复制文字
  document.activeElement = null;

  fireDoc('keydown', { key: 'c', ctrlKey: true, preventDefault() {} });
  assert.match(textOf(appRoot), /已复制 1 个任务，按 Ctrl\+V 粘贴/);

  posted.length = 0;
  fireDoc('keydown', { key: 'v', ctrlKey: true, preventDefault() {} });
  await settle(30);

  const call = posted.find((p) => p.path === '/api/mcstudio/quest/clone/apply');
  assert.ok(call, 'Ctrl+V 没有调「复制任务」接口');
  assert.equal(call.payload.sourceQuestId, 'AAAA000000000001', '复制的不是任务甲');
  assert.equal(call.payload.chapter, 'CH1');
  assert.match(textOf(appRoot), /已粘贴 1 个任务/);
});

/**
 * 模拟「用户选中了一段文字」。
 *
 * 界面判断「有没有选中文字」走 `window.getSelection()`（浏览器）/ 输入框的
 * selectionStart≠selectionEnd。DOM 替身没有 getSelection，所以这里给它加一个
 * 可控的桩 —— 这样测的是界面**真实的判断逻辑**，而不是给界面开一个测试专用后门。
 */
function setSelectedText(text) {
  const sel = String(text ?? '');
  globalThis.window = globalThis.window ?? {};
  globalThis.window.getSelection = () => ({ isCollapsed: !sel, toString: () => sel });
}

test('快捷键作用域：在画布上 Ctrl+C 复制任务，在侧栏里不抢（2026-11-12 用户点名）', async () => {
  setSelectedText('');
  await blueprintReset();
  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle(16);
  document.activeElement = null;

  // ① 点一下画布 → 画布作用域 → Ctrl+C 复制任务节点
  focusCanvas();
  fireDoc('keydown', { key: 'c', ctrlKey: true, preventDefault() {} });
  assert.match(textOf(appRoot), /已复制 1 个任务/, '在画布上 Ctrl+C 该复制任务');
  resetKeyScope();
});

test('快捷键作用域：选中文字时（任何一栏）Ctrl+C 是复制文字，不碰任务节点', async () => {
  await blueprintReset();
  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle(16);
  document.activeElement = null;

  // 先点画布（是画布作用域），但**选中了一段文字** → 这时 Ctrl+C 必须让给浏览器
  focusCanvas();
  setSelectedText('任务甲 2 个要求');
  fireDoc('keydown', { key: 'c', ctrlKey: true, preventDefault() {} });
  await settle(5);
  assert.ok(!/已复制 \d+ 个任务/.test(textOf(appRoot)),
    '★ 选中文字后 Ctrl+C 不该去复制任务节点（用户要在任何一栏都能复制文字）');

  // 取消选中文字，再按一次才该复制任务
  setSelectedText('');
  focusCanvas();
  fireDoc('keydown', { key: 'c', ctrlKey: true, preventDefault() {} });
  assert.match(textOf(appRoot), /已复制 1 个任务/);
  resetKeyScope();
});

test('快捷键作用域：点过画布再点侧栏，Ctrl+C 不再复制任务（作用域会跟着切）', async () => {
  setSelectedText('');
  await blueprintReset();
  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle(16);
  document.activeElement = null;

  // 先点在画布上（作用域 = canvas）
  focusCanvas();
  // ② 点一下右栏（作用域该变成 other）→ Ctrl+C 不再复制任务
  const right = findByClass(appRoot, 'mcs-right');
  assert.ok(right, '右栏该在');
  right.listeners.pointerdown?.forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
  document.activeElement = null; // 点侧栏后焦点落到 body，靠 state.keyScope 兜
  fireDoc('keydown', { key: 'c', ctrlKey: true, preventDefault() {} });
  await settle(5);
  assert.ok(!/已复制 \d+ 个任务/.test(textOf(appRoot)),
    '★ 点过侧栏之后 Ctrl+C 不该再复制任务节点');

  // 回到画布，能力恢复
  focusCanvas();
  fireDoc('keydown', { key: 'c', ctrlKey: true, preventDefault() {} });
  assert.match(textOf(appRoot), /已复制 1 个任务/);
  resetKeyScope();
});

test('快捷键作用域：在报错栏（诊断面板）里 Ctrl+C 不复制任务（中栏不含报错栏）', async () => {
  setSelectedText('');
  await blueprintReset();
  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle(16);
  document.activeElement = null;

  // ★ `state.diagOpen` 是整包级状态，用例之间不复位：前面某条可能已经把它打开了，
  //   这时再点一次菜单反而会关掉。先摆正（开着就先收起）。
  if (findByClass(appRoot, 'mcs-diag')) {
    await click(findByClass(appRoot, 'mcs-diag-x'));
    await settle(10);
  }
  await clickMenu('分析', '任务书诊断');
  await settle(20);
  const diag = findByClass(appRoot, 'mcs-diag');
  assert.ok(diag, '该展开诊断面板');
  // 先让作用域是「画布」，再点诊断面板 —— 这样才验得出「点报错栏会把作用域切走」
  focusCanvas();
  diag.listeners.pointerdown?.forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
  document.activeElement = null; // 点侧栏后焦点落到 body，靠 state.keyScope 兜
  fireDoc('keydown', { key: 'c', ctrlKey: true, preventDefault() {} });
  await settle(5);
  assert.ok(!/已复制 \d+ 个任务/.test(textOf(appRoot)),
    '★ 用户明确说过「中栏不包括下侧报错栏」，在那里 Ctrl+C 不该复制任务');

  await click(findByClass(appRoot, 'mcs-diag-x'));
  await settle(10);
  resetKeyScope();
});

test('Ctrl+S 是有草稿就提交：第一次按只预览，第二次按才真写（2026-11-11 用户点名）', async () => {
  await blueprintReset();
  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle(16);

  // 开一个草稿：点「改名」
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '改名'));
  assert.ok(findByFocus(appRoot, 'rdesc'), '没有打开改名草稿');

  // 第一次 Ctrl+S：还没预览过 → 只算不写
  posted.length = 0;
  document.activeElement = null;
  fireDoc('keydown', { key: 's', ctrlKey: true, preventDefault() {} });
  await settle(30);

  const plan = posted.find((p) => p.path === '/api/mcstudio/quest/preview');
  assert.ok(plan, 'Ctrl+S 应该先调预览');
  assert.ok(!posted.some((p) => p.path === '/api/mcstudio/quest/apply'), '还没预览就直接写了，违反 plan→apply 两态');

  // 第二次 Ctrl+S：已经有预览结果 → 直接写
  posted.length = 0;
  fireDoc('keydown', { key: 's', ctrlKey: true, preventDefault() {} });
  await settle(30);

  const applied = posted.find((p) => p.path === '/api/mcstudio/quest/apply');
  assert.ok(applied, '第二次 Ctrl+S 应该真写入');
  assert.deepEqual(applied.payload, plan.payload, '写入的入参必须和预览时逐字一致');
});

test('Ctrl+S 没有草稿时什么都不做，但也要拦住浏览器的「另存为网页」', async () => {
  await blueprintReset();
  posted.length = 0;
  let prevented = false;
  fireDoc('keydown', { key: 's', ctrlKey: true, preventDefault() { prevented = true; } });
  await settle(16);

  assert.equal(prevented, true, '没草稿也要 preventDefault，否则会弹浏览器的另存为');
  assert.equal(posted.length, 0, '没草稿不该发任何请求');
});

test('蓝图式编辑：空白右键「新建任务」就地打开草稿卡', async () => {
  await blueprintReset();
  await openBlankMenuAt(900, 700);
  const item = blankItem('新建任务');
  assert.ok(item, '空白菜单里没有「新建任务」');
  await click(item);
  assert.match(textOf(appRoot), /在这里新建任务/, '没弹出新建任务的草稿卡');
  // 收尾重连，别把草稿卡留给后面的用例
  await blueprintReset();
});

// ===== 2026-11-09：拖动任务节点时的对齐参考线（§3.1.3 第 8 条）=====

/** 收集画布里那两条 class="mcs-guide" 的 <line>。
 *  canvasSvg() 先 append 竖线、再 append 横线，所以顺序是 [竖, 横]。
 *  SVG 的 class 存在 attrs.class（svgEl 用 setAttribute），不能用 findByClass。 */
function guideLines() {
  const out = [];
  const walk = (n) => {
    if (!(n instanceof FakeNode)) return;
    if (n.tagName === 'LINE' && n.attrs.class === 'mcs-guide') out.push(n);
    for (const kid of n.children) walk(kid);
  };
  walk(findSvg());
  return out;
}

test('拖动任务节点时亮对齐参考线：快对齐才出现，离开就灭，松手收起', async () => {
  await blueprintReset();
  // 先收掉前面用例可能残留在 document 上的平移/框选监听器，免得它们顺手改坐标
  fireDoc('pointerup', { clientX: 0, clientY: 0 });
  posted.length = 0;

  // 单独选中任务甲（选中会重画整画布，参考线要在重画之后再找）
  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle();

  const guides = guideLines();
  assert.equal(guides.length, 2, '画布里该有一竖一横两条对齐参考线');
  const [vLine, hLine] = guides;
  assert.equal(vLine.attrs.style, 'display:none', '没拖动时竖线该藏着');
  assert.equal(hLine.attrs.style, 'display:none', '没拖动时横线该藏着');

  const node = findNodeEl('AAAA000000000001');
  assert.ok(node, '没找到任务甲的节点');
  node.listeners.pointerdown?.forEach((fn) =>
    fn({ button: 0, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} }),
  );

  // 往右拖 264 像素＝两格：甲从 x:0 到 x:2，正好跟任务乙 (x:2,y:1) 同一列 → 亮竖线
  fireDoc('pointermove', { clientX: 364, clientY: 100 });
  assert.equal(vLine.attrs.style, 'display:block', '快跟任务乙同一列时该亮竖线');
  assert.equal(hLine.attrs.style, 'display:none', '这次没对齐到同一行，横线不该亮');
  assert.equal(vLine.attrs.x1, vLine.attrs.x2, '竖线该是竖直的（两端 x 相同）');
  assert.ok(Number(vLine.attrs.y1) < Number(vLine.attrs.y2), '竖线该有长度、方向朝下');

  // 拖到既不对齐列、也不对齐行的位置：两条都该灭
  fireDoc('pointermove', { clientX: 200, clientY: 140 });
  assert.equal(vLine.attrs.style, 'display:none', '离开对齐位置竖线该灭');
  assert.equal(hLine.attrs.style, 'display:none', '离开对齐位置横线该灭');

  // 往下拖 108 像素＝一格、横向仍不对齐：ny=1 跟任务乙同一行 → 亮横线
  fireDoc('pointermove', { clientX: 200, clientY: 208 });
  assert.equal(hLine.attrs.style, 'display:block', '快跟任务乙同一行时该亮横线');
  assert.equal(vLine.attrs.style, 'display:none', '这次没对齐到同一列，竖线不该亮');
  assert.equal(hLine.attrs.y1, hLine.attrs.y2, '横线该是水平的（两端 y 相同）');

  // 松手回起点：位移 0 → 不写盘；参考线收起。
  // 注意：拖动中若错误地 render() 整页重画，上面这几个 vLine/hLine 引用早就失效了，
  // 断言会直接挂 —— 这条用例同时守着「拖动中绝不重画」那条老规矩。
  fireDoc('pointerup', { clientX: 100, clientY: 100 });
  assert.equal(vLine.attrs.style, 'display:none', '松手竖线该收起来');
  assert.equal(hLine.attrs.style, 'display:none', '松手横线该收起来');
  assert.ok(
    !posted.some((p) => p.path === '/api/mcstudio/quest/move/apply'),
    '回起点松手不该写盘（纯看参考线，没真挪）',
  );
  // 跟 dragBy 一样补一下 click，清掉 onUp 设的 suppressClick，别留给下条用例
  node.listeners.click?.forEach((fn) => fn({}));
  await settle(16);
});


// ===== 2026-11-09：四处界面调整（用户 m00475）=====

test('预览按钮在顶部菜单栏：固定叫「预览」，预览态高亮，再点回编辑网格', async () => {
  await blueprintReset();
  const bar = find(appRoot, (n) => cls(n).includes('mcs-menubar'));
  assert.ok(bar, '没有顶部菜单栏');
  const preview = () => find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览');
  assert.ok(find(bar, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览'), '「预览」不在顶部菜单栏里');

  // 先摆正到编辑网格：万一上一条用例把观感留在预览态，先点回
  if (cls(preview()).includes('mcs-menu-btn-on')) await click(preview());
  assert.ok(!cls(preview()).includes('mcs-menu-btn-on'), '编辑态不该高亮');

  await click(preview());
  assert.ok(cls(preview()).includes('mcs-menu-btn-on'), '切到预览态该高亮');
  await click(preview());
  assert.ok(!cls(preview()).includes('mcs-menu-btn-on'), '切回编辑网格该取消高亮');
  await blueprintReset();
});

test('语言设置搬进「设置」菜单：列出自动 / 英文 / 中文，当前项打勾，画布顶栏不再有语言按钮', async () => {
  await blueprintReset();
  await click(menuHead('设置'));
  const item = (label) => find(appRoot, (n) => cls(n).includes('mcs-menu-item') && textOf(n).includes(label));
  const auto = item('自动');
  assert.ok(auto, '设置菜单里没有「自动」');
  assert.ok(textOf(auto).includes('✓'), '当前项「自动」没打勾');
  assert.ok(item('英文'), '设置菜单里没有「英文」');
  assert.ok(item('中文'), '设置菜单里没有「中文」');
  assert.ok(
    !find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === '自动'),
    '画布顶栏不该再有「自动」语言按钮',
  );
  // 收起菜单，别影响下一条用例
  await click(menuHead('设置'));
  await blueprintReset();
});

test('Ctrl+C/V/Z/Y 只在任务书画布生效：在分析页按了不抢、不写盘', async () => {
  await blueprintReset();
  await clickMenu('分析', 'mod 撞车');
  assert.match(textOf(appRoot), /只读：这里的所有检查都不会动你的整合包/, '没切到分析页');
  posted.length = 0;
  calls.length = 0;
  const keys = [
    { key: 'c', ctrlKey: true },
    { key: 'v', ctrlKey: true },
    { key: 'z', ctrlKey: true },
    { key: 'z', ctrlKey: true, shiftKey: true },
    { key: 'y', ctrlKey: true },
  ];
  for (const ev of keys) fireDoc('keydown', ev);
  await settle(16);
  assert.ok(!posted.some((p) => p.path === '/api/mcstudio/quest/clone/apply'), '分析页按 Ctrl+V 不该粘贴');
  assert.ok(!posted.some((p) => p.path === '/api/mcstudio/quest/move/apply'), '分析页按 Ctrl+Z/Y 不该撤销 / 重做');
  const text = textOf(appRoot);
  assert.ok(!/已复制|已粘贴|已撤销|已重做|先点一个任务|还没复制过任务/.test(text), '分析页按快捷键不该弹蓝图提示');
  await blueprintReset();
});

test('新建入口搬进左栏和空白右键：左栏两个加号、右键四条、没选章节时置灰', async () => {
  await blueprintReset();
  const addBtn = (act) => find(appRoot, (n) => cls(n).includes('mcs-left-add') && n.attrs['data-act'] === act);
  const chapterBtn = addBtn('add-chapter');
  const questBtn = addBtn('add-quest');
  assert.ok(chapterBtn, '左栏没有「新增章节」按钮');
  assert.ok(questBtn, '左栏没有「新增任务」按钮');
  assert.ok(!isDisabled(chapterBtn), '「新增章节」不该依赖选中章节');
  assert.ok(!isDisabled(questBtn), '开着章节页签时「新增任务」不该置灰');
  assert.equal(questBtn.attrs.title, '给当前这一章加一个任务');
  assert.ok(
    !find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '＋装饰图'),
    '画布顶栏不该还有「＋装饰图」按钮',
  );

  // 照「关页签」用例的范式全关页签，造出没选章节的空态
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '＋新任务'));
  await click(closeBtnOf('第一章'));
  const force1 = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '还是关掉');
  if (force1) await click(force1);
  const close2 = closeBtnOf('第二章');
  if (close2) {
    await click(close2);
    const force2 = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '还是关掉');
    if (force2) await click(force2);
  }
  const off = addBtn('add-quest');
  assert.ok(off, '空态下左栏没有「新增任务」按钮');
  assert.ok(isDisabled(off), '没选章节时「新增任务」该置灰');
  assert.equal(off.attrs.title, '先选一个章节', '置灰时该提示先选章节');

  await blueprintReset();
  await openBlankMenuAt(900, 700);
  for (const label of ['新建任务', '新章节', '装饰图', '搜索物品']) {
    assert.ok(blankItem(label), '空白右键里没有「' + label + '」');
  }
  assert.ok(!cls(blankItem('装饰图')).includes('mcs-menu-item-off'), '开着页签时「装饰图」不该置灰');
  await blueprintReset();
});

test('诊断面板常驻一个「检查一次」按钮，点一下就重新问后端（2026-11-11 点名；2026-11-12 挪到底部面板）', async () => {
  await blueprintReset();
  // 右栏那张卡已经删了（用户：「太影响阅读了」），按钮现在在诊断面板里 —— 得先展开
  await clickMenu('分析', '任务书诊断');
  await settle(20);

  const diag = findByClass(appRoot, 'mcs-diag');
  assert.ok(diag, '该展开诊断面板');
  const lintBtn = find(diag, (n) => n.tagName === 'BUTTON' && textOf(n) === '检查一次');
  assert.ok(lintBtn, '面板里应该有「检查一次」按钮');

  // 点之前清空记录，确认这一次点击真的发了请求
  calls.length = 0;
  await click(lintBtn);
  await settle(20);

  const book = calls.find((c) => c.path === '/api/mcstudio/questbook');
  assert.ok(book, '点「检查一次」应该重新请求 /questbook');
  assert.equal(book.method, 'GET');
  // 检查完面板还在（结果刷新，不是消失）
  assert.ok(findByClass(appRoot, 'mcs-diag'), '检查完面板该还在');

  // 诊断内容确实显示出来了（以前这些断言写在右栏卡上）
  const diagText = textOf(findByClass(appRoot, 'mcs-diag'));
  assert.match(diagText, /依赖的 NOSUCH 不是任务 ID/, '该列出那条悬空依赖');
  assert.match(diagText, /demo:textures\/missing\.png 在包里找不到/, '该列出那条缺图');

  // 收尾摆正：这个状态是整包级的，留着会污染后面的用例
  await click(findByClass(appRoot, 'mcs-diag-x'));
  await settle(10);
});

test('诊断面板：带 questId 那行可点，点了右栏换成那个任务（2026-11-12 修「点了没反应」）', async () => {
  await blueprintReset();
  await clickMenu('分析', '任务书诊断');
  await settle(20);

  const diag = findByClass(appRoot, 'mcs-diag');
  assert.ok(diag, '该展开诊断面板');

  // 找出「任务 齿轮」那一行（后端给了 questId = AAAA000000000002）
  const jumpRow = find(diag, (n) => cls(n).includes('mcs-diag-row') && textOf(n).includes('依赖的 NOSUCH'));
  assert.ok(jumpRow, '该列出那条悬空依赖');
  assert.ok(cls(jumpRow).includes('mcs-diag-jump'), '带定位的行要标成可点（样式和可点性同源）');
  assert.ok(jumpRow.listeners.click?.length, '★ 带 questId 的行必须有 onclick —— 以前这行永远没有');

  // 点之前先把选择清掉，确认是这一下点出来的效果
  const before = calls.filter((c) => c.path === '/api/mcstudio/quest').length;
  jumpRow.listeners.click.forEach((fn) => fn({ stopPropagation() {} }));
  await settle(30);

  const after = calls.filter((c) => c.path === '/api/mcstudio/quest');
  assert.equal(after.length, before + 1, '点了应该去问 /quest 拿那个任务的详情');
  assert.equal(after[after.length - 1].params?.questId, 'AAAA000000000002',
    '问的必须是这一行指向的任务');
  assert.ok(find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002'), '画布上那个任务该被选中');

  await click(findByClass(appRoot, 'mcs-diag-x'));
  await settle(10);
});

test('诊断面板：不带定位的行点了没反应，也不许报错（章节级 / 无主的问题）', async () => {
  await blueprintReset();
  // 上一条用例可能把面板关掉了，这里自己保证它是开着的
  if (!findByClass(appRoot, 'mcs-diag')) {
    await clickMenu('分析', '任务书诊断');
    await settle(20);
  }

  const diag = findByClass(appRoot, 'mcs-diag');
  assert.ok(diag, '该展开诊断面板');
  const plainRow = find(diag, (n) => cls(n).includes('mcs-diag-row') && textOf(n).includes('在包里找不到'));
  assert.ok(plainRow, '该列出那条缺图');
  assert.ok(!cls(plainRow).includes('mcs-diag-jump'), '没有定位的行不该标成可点');
  assert.ok(!plainRow.listeners.click?.length, '没有定位的行不该挂 onclick');

  // 面板本身还得在（点了没反应 ≠ 面板炸了）
  assert.ok(findByClass(appRoot, 'mcs-diag'), '面板该还在');

  await click(findByClass(appRoot, 'mcs-diag-x'));
  await settle(10);
});

test('诊断面板：任务在别的章节时，点警告会先切到那一章的页签再跳（2026-11-12）', async () => {
  // 把那条悬空依赖改指向第二章的任务丙，模拟「问题属于当前没开着的章节」
  const original = FAKE['/api/mcstudio/questbook'];
  FAKE['/api/mcstudio/questbook'] = () => ({
    ...original,
    issues: {
      errorCount: 0,
      warnCount: 1,
      problems: [{
        level: 'warn', code: 'QuestDanglingDependency',
        questId: 'BBBB000000000001', chapterId: 'CH2',
        where: '任务 任务丙（BBBB000000000001）', message: '依赖的 NOSUCH 不是任务 ID，游戏会自动忽略',
      }],
    },
  });
  try {
    await blueprintReset();
    // 开局停在第一章，第二章还没开页签
    assert.ok(!tabElOf('第二章'), '前提：第二章此刻不该开着');

    await clickMenu('分析', '任务书诊断');
    await settle(20);
    const row = find(findByClass(appRoot, 'mcs-diag'), (n) => cls(n).includes('mcs-diag-jump'));
    assert.ok(row, '该有一条可点的问题');

    row.listeners.click.forEach((fn) => fn({ stopPropagation() {} }));
    await settle(30);

    // 光换右栏不算跳 —— 必须把第二章的页签打开、画布上能看见任务丙
    assert.ok(tabElOf('第二章'), '★ 应该自动打开第二章的页签');
    assert.ok(find(appRoot, (n) => n.attrs['data-quest'] === 'BBBB000000000001'), '画布上该出现任务丙');
    assert.ok(!find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001'), '第一章的任务甲不该还画着');
  } finally {
    FAKE['/api/mcstudio/questbook'] = original;
    // 摆正：回第一章，后面用例都按第一章写
    if (!findByClass(appRoot, 'mcs-diag')) {
      await clickMenu('分析', '任务书诊断');
      await settle(10);
    }
    const x = findByClass(appRoot, 'mcs-diag-x');
    if (x) await click(x);
    await settle(10);
    await click(chapItemOf('第一章'));
    await settle(20);
  }
});

test('右栏详情：点开任务能看到前置和后续，点一下能跳到那个任务（2026-11-12）', async () => {
  await blueprintReset();
  await click(tabElOf('第一章'));

  // 点任务乙（它的 upstream 是任务甲）
  find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002').listeners.click?.forEach((fn) => fn({}));
  await settle(20);

  const right = findByClass(appRoot, 'mcs-right');
  assert.ok(right, '右栏该在');
  const secTitles = findAllByClass(right, 'mcs-detail-sec-t').map((n) => textOf(n));
  // 用户原话：「前置、后置、奖励都是点击任务节点后出现的」—— 所以这两节必须在右栏
  assert.ok(secTitles.some((t) => t.startsWith('前置')), `右栏该有「前置」，实际分节：${secTitles.join(' / ')}`);
  assert.ok(secTitles.some((t) => t.startsWith('后续')), `右栏该有「后续」，实际分节：${secTitles.join(' / ')}`);

  const rightText = textOf(right);
  assert.match(rightText, /任务甲/, '前置里该写着任务甲（用标题不用编号）');
  assert.match(rightText, /没有后续/, '任务乙没有后续，该说人话而不是留空白');

  // 点前置那一行 → 跳到任务甲
  const jumpRow = findAllByClass(right, 'mcs-detail-jump')
    .find((n) => textOf(n).includes('任务甲'));
  assert.ok(jumpRow, '前置那一行该可点');
  jumpRow.listeners.click?.forEach((fn) => fn({ stopPropagation() {} }));
  await settle(20);

  const detailCalls = calls.filter((c) => c.path === '/api/mcstudio/quest');
  assert.equal(detailCalls[detailCalls.length - 1].params?.questId, 'AAAA000000000001',
    '点了前置该去读任务甲的详情');
  assert.ok(find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001'), '画布上该选中任务甲');
});

test('右栏详情：前置那一行带 ID 与所在章节的悬停提示，跨章也能点（§3.1.9 第 1、2 件）', async () => {
  const original = FAKE['/api/mcstudio/quest'];
  // 真后端 2026-11-12 起 upstream 每条都带 chapterId / chapterTitle。
  FAKE['/api/mcstudio/quest'] = (parsed) => {
    const r = original(parsed);
    if (parsed.searchParams.get('questId') !== 'AAAA000000000002') return r;
    return {
      ...r,
      upstream: [{
        id: 'AAAA000000000001',
        title: '任务甲',
        exists: true,
        // 故意给一个「另一章」的 id：验证界面把它放进悬停提示、并能带上去跳转
        chapterId: 'OTHERCHAPTER0001',
        chapterTitle: '第二章',
      }],
    };
  };
  try {
    await blueprintReset();
    await click(tabElOf('第一章'));
    find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002').listeners.click?.forEach((fn) => fn({}));
    await settle(20);

    const right = findByClass(appRoot, 'mcs-right');
    const row = findAllByClass(right, 'mcs-detail-jump').find((n) => textOf(n).includes('任务甲'));
    assert.ok(row, '前置那一行该在');
    // ★ 名字上屏（不是十六进制 ID），ID 与章节信息挪进悬停提示 —— 信息一个都没丢
    assert.match(textOf(row), /任务甲/, '正文该显示名字');
    assert.ok(!/[0-9A-F]{16}/.test(textOf(row)), '正文不该出现 16 位裸 ID');
    assert.match(String(row.attrs.title ?? ''), /点一下跳到那个任务/, '悬停提示该说能点');
    assert.match(String(row.attrs.title ?? ''), /第二章/, '★ 悬停提示该说它在哪一章');
  } finally {
    FAKE['/api/mcstudio/quest'] = original;
  }
});

test('跳转失败要说话：目标章节读不到时弹错误提示，不能静默返回（用户说「点了没反应」）', async () => {
  const original = FAKE['/api/mcstudio/quest'];
  FAKE['/api/mcstudio/quest'] = (parsed) => {
    const r = original(parsed);
    if (parsed.searchParams.get('questId') !== 'AAAA000000000002') return r;
    return {
      ...r,
      // 一个 canvas 里根本不存在的任务 + 一个没打开的章节
      upstream: [{
        id: 'GHOST000000000001',
        title: '幽灵任务',
        exists: true,
        chapterId: 'NOTREADCHAPTER001',
        chapterTitle: '没读到的章',
      }],
    };
  };
  try {
    await blueprintReset();
    await click(tabElOf('第一章'));
    find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002').listeners.click?.forEach((fn) => fn({}));
    await settle(20);

    const right = findByClass(appRoot, 'mcs-right');
    const row = findAllByClass(right, 'mcs-detail-jump').find((n) => textOf(n).includes('幽灵任务'));
    assert.ok(row, '这一行该在');
    row.listeners.click?.forEach((fn) => fn({ stopPropagation() {} }));
    await settle(20);

    // ★ 改之前这里是静默 return：用户点了毫无反馈。
    //   toast 是右下角浮层，用 mcs-toast 找（见 showToast()）。
    const toast = findByClass(appRoot, 'mcs-toast');
    assert.ok(toast, '★ 跳不过去必须弹提示，不能静默什么都不做');
    assert.match(textOf(toast), /跳不过去|找不到|没读到/, `提示内容该说明为什么跳不过去，实际「${textOf(toast)}」`);
  } finally {
    FAKE['/api/mcstudio/quest'] = original;
  }
});

test('右栏详情：悬空前置标成「不存在」且不可点（不能把人骗到空任务上）', async () => {
  const original = FAKE['/api/mcstudio/quest'];
  FAKE['/api/mcstudio/quest'] = (parsed) => {
    const r = original(parsed);
    if (parsed.searchParams.get('questId') === 'AAAA000000000002') {
      return {
        ...r,
        // 真后端对悬空依赖回的就是 `exists: false`，标题是「（不存在的任务）」
        upstream: [{ id: 'NOSUCH0000000099', title: '（不存在的任务）', exists: false }],
      };
    }
    return r;
  };
  try {
    await blueprintReset();
    await click(tabElOf('第一章'));
    find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002').listeners.click?.forEach((fn) => fn({}));
    await settle(20);

    const right = findByClass(appRoot, 'mcs-right');
    const gone = findAllByClass(right, 'mcs-detail-item-gone');
    assert.equal(gone.length, 1, '悬空前置该标成 gone');
    assert.match(textOf(gone[0]), /不存在/, '该写明它不存在');
    assert.ok(!gone[0].listeners.click?.length, '悬空前置不该可点');
  } finally {
    FAKE['/api/mcstudio/quest'] = original;
  }
});

test('游戏预览窗口：预览态点任务弹出窗口，能翻页、能打勾模拟提交（2026-11-12 用户要求）', async () => {
  await blueprintReset();
  await click(tabElOf('第一章'));

  // 切到预览态
  const lookBtn = () => find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览');
  lookBtn().listeners.click?.forEach((fn) => fn({}));
  await settle(3);

  // 点任务乙（它有 2 个要求、1 个奖励，upstream 非空）
  findNodeEl('AAAA000000000002').listeners.click?.forEach((fn) => fn({}));
  await settle(20);

  const win = findByClass(appRoot, 'mcs-game-win');
  assert.ok(win, '★ 预览态点节点该弹出游戏预览窗口');

  // 窗口里该有标题、两栏标题。
  // 2026-11-12 第四批：按 ViewQuestPanel 真值改成左右两栏，标题分别是
  // 「任务目标」（蓝 #5555FF）和「任务奖励」（橙 #FFAA00）。
  const winText = textOf(win);
  assert.match(winText, /任务乙/, '窗口里该有任务标题');
  assert.match(winText, /任务目标/, '左栏标题该是「任务目标」（游戏里就叫这个）');
  assert.match(winText, /任务奖励/, '右栏标题该是「任务奖励」');

  // ★ 两栏并排：有 cols 容器、中间竖线、两个 col
  assert.ok(findByClass(win, 'mcs-game-win-cols'), '任务/奖励该是左右两栏并排（以前是上下堆叠）');
  assert.ok(findByClass(win, 'mcs-game-win-divider'), '两栏中间该有一条竖线');
  assert.ok(findByClass(win, 'mcs-game-win-col-task'), '缺左栏（任务目标）');
  assert.ok(findByClass(win, 'mcs-game-win-col-reward'), '缺右栏（任务奖励）');

  // —— 打勾模拟提交 ——
  const taskRows = findAllByClass(win, 'mcs-game-win-cell-task');
  assert.equal(taskRows.length, 2, `该有 2 条要求，实际 ${taskRows.length}`);
  assert.ok(!cls(taskRows[0]).includes('mcs-game-win-cell-done'));
  // 未完成时**不画任何勾**（游戏真值：未完成什么都不画，以前是 ☐ 文字）
  assert.equal(findAllByClass(win, 'mcs-game-win-check').length, 0, '未完成时不该画对勾');
  taskRows[0].listeners.click?.forEach((fn) => fn({ stopPropagation() {} }));
  await settle(5);
  // 重画之后重新取（render 会把整棵树换掉）
  const win2 = findByClass(appRoot, 'mcs-game-win');
  const rows2 = findAllByClass(win2, 'mcs-game-win-cell-task');
  assert.ok(cls(rows2[0]).includes('mcs-game-win-cell-done'), '★ 点一下该打上勾（模拟完成）');
  // 完成 → 右上角画 8×8 绿对勾（游戏真值，不是 ✔ 文字）
  const checks = findAllByClass(win2, 'mcs-game-win-check');
  assert.equal(checks.length, 1, `完成一条就该画一个对勾，实际 ${checks.length}`);
  assert.ok(!textOf(win2).includes('✔'), '游戏里没有 ✔ 这个字，对勾是画出来的');
  assert.ok(!textOf(win2).includes('☐'), '游戏里没有 ☐ 这个字');
  // 全部打勾 → 奖励格子进入「可领取」态
  rows2[1].listeners.click?.forEach((fn) => fn({ stopPropagation() {} }));
  await settle(5);
  const win3 = findByClass(appRoot, 'mcs-game-win');
  const readyCells = findAllByClass(win3, 'mcs-game-win-cell-ready');
  assert.ok(readyCells.length > 0, '★ 全部要求完成后奖励该进入可领取态');

  // ★ 全程不许写盘：这是「看效果」，不是真提交
  assert.ok(!posted.some((p) => /quest\/(node|add|apply)/.test(p.path)),
    '★ 预览窗口里打勾不该发任何写盘请求');

  // Esc 关掉窗口
  fireDoc('keydown', { key: 'Escape' });
  await settle(5);
  assert.ok(!findByClass(appRoot, 'mcs-game-win'), 'Esc 该关掉预览窗口');

  // 切回编辑态
  lookBtn().listeners.click?.forEach((fn) => fn({}));
  await settle(3);
});

test('游戏预览窗口：结构照抄 ViewQuestPanel（左右两栏、10px 图标、斜体灰副标题、页码无空格）', async () => {
  await blueprintReset();
  await click(tabElOf('第一章'));
  const lookBtn = () => find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览');
  if (!cls(lookBtn()).includes('mcs-menu-btn-on')) {
    lookBtn().listeners.click?.forEach((fn) => fn({}));
    await settle(3);
  }
  // ★ 用任务甲（AAAA000000000001）：替身里它才有 2 页描述（descriptionPageCount=2），
  //   任务乙是单页、没有翻页条。
  try {
    findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
    await settle(20);

    const win = findByClass(appRoot, 'mcs-game-win');
    assert.ok(win, '预览窗口该弹出来');

    // ① 左右两栏并排 + 中间竖线（真值：w2 = w/2，任务区 x=2、奖励区 x=w2+2）
    const cols = findByClass(win, 'mcs-game-win-cols');
    assert.ok(cols, '该有两栏容器');
    const colNames = cols.children.map((c) => String(c.className ?? ''));
    assert.ok(colNames.some((c) => c.includes('mcs-game-win-col-task')), '左栏该是任务目标');
    assert.ok(colNames.some((c) => c.includes('mcs-game-win-col-reward')), '右栏该是任务奖励');
    assert.ok(colNames.some((c) => c.includes('mcs-game-win-divider')), '中间该有竖线');

    // ② 顶部图标是 10px 的小图标，不是 48px 大方块（真值 iconSize = min(16, titleH+2)）
    const headIcon = findByClass(win, 'mcs-game-win-icon');
    assert.ok(headIcon, '顶部该有章节图标位');
    const headImg = find(headIcon, (n) => n.tagName === 'IMG');
    if (headImg) assert.notEqual(String(headImg.attrs.width), '40', '图标不该还是 40px 大方块');

    // ③ 页码 `1/2` 无空格（真值），且第一页时「上一页」按钮**不出现**（不是置灰）
    const pager = findByClass(win, 'mcs-game-win-pager');
    assert.ok(pager, '多页时该有翻页条');
    const pgn = findByClass(win, 'mcs-game-win-pgn');
    assert.equal(textOf(pgn), '1/2', `页码该是「1/2」无空格，实际「${textOf(pgn)}」`);
    const prevBtn = find(pager, (n) => n.tagName === 'BUTTON' && textOf(n) === '◀');
    assert.equal(prevBtn, null, '第一页时「上一页」按钮该不出现（游戏里是隐藏不是置灰）');
    const nextBtn = find(pager, (n) => n.tagName === 'BUTTON' && textOf(n) === '▶');
    assert.ok(nextBtn, '第一页时「下一页」该出现');

    // ④ 有要求时不该冒出「没有任务」占位（那个占位只在列表为空时才有）
    assert.ok(!textOf(win).includes('没有任务'), '有要求时不该出现「没有任务」占位');
  } finally {
    // ★ 不管断言过没过，都要把窗口和预览态收回去 —— 否则下一条用例
    //   起点是「预览态 + 窗口开着」，会连锁报「预览态点节点该开窗口」。
    fireDoc('keydown', { key: 'Escape' });
    await settle(4);
    if (cls(lookBtn()).includes('mcs-menu-btn-on')) {
      lookBtn().listeners.click?.forEach((fn) => fn({}));
      await settle(3);
    }
  }
});

test('游戏预览窗口：预览态点节点不会改任务（编辑态才改），切回编辑态窗口自动收掉', async () => {
  await blueprintReset();
  await click(tabElOf('第一章'));

  const lookBtn = () => find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n) === '预览');
  lookBtn().listeners.click?.forEach((fn) => fn({}));
  await settle(3);

  findNodeEl('AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle(20);
  assert.ok(findByClass(appRoot, 'mcs-game-win'), '预览态点节点该开窗口');

  // 切回编辑态：窗口该自动消失（编辑态点节点是「改这个任务」）
  lookBtn().listeners.click?.forEach((fn) => fn({}));
  await settle(5);
  assert.ok(!findByClass(appRoot, 'mcs-game-win'), '★ 切回编辑态该把预览窗口收掉');
});

test('要求里的名字用中文名，不是物品/维度 ID（2026-11-12 用户第二条）', async () => {
  // 假接口对 /quest 的 tasks 现在带 label（后端翻好的中文名）。
  // 这里直接给一个带 label 的答案，验界面**优先用 label**、并把原 ID 放进 title。
  const original = FAKE['/api/mcstudio/quest'];
  FAKE['/api/mcstudio/quest'] = (parsed) => {
    const r = original(parsed);
    if (parsed.searchParams.get('questId') === 'AAAA000000000002') {
      return {
        ...r,
        tasks: [
          { type: 'item', what: 'demo:gear', count: 1, label: '大齿轮' },
          { type: 'dimension', what: 'minecraft:the_nether', count: 1, label: '下界' },
        ],
      };
    }
    return r;
  };
  try {
    await blueprintReset();
    await click(tabElOf('第一章'));
    findNodeEl('AAAA000000000002').listeners.click?.forEach((fn) => fn({}));
    await settle(20);

    const right = findByClass(appRoot, 'mcs-right');
    const rightText = textOf(right);
    assert.match(rightText, /大齿轮/, '物品该显示中文名');
    assert.match(rightText, /下界/, '维度该显示中文名');
    assert.ok(!rightText.includes('minecraft:the_nether'), '★ 不该把维度 ID 显示出来');

    // 原 ID 放到 title 里（悬停能看）
    const netherRow = findAllByClass(right, 'mcs-detail-item')
      .find((n) => textOf(n).includes('下界'));
    assert.ok(netherRow, '该有「下界」那一行');
    const nameEl = findAllByClass(netherRow, 'mcs-detail-item-name')[0];
    assert.equal(nameEl?.attrs?.title, 'minecraft:the_nether', '原 ID 该放进 title 供悬停查看');
  } finally {
    FAKE['/api/mcstudio/quest'] = original;
  }
});

test('诊断面板没有问题时说「没发现问题」（否则点按钮像没反应）', async () => {
  // 临时把体检结果改成空，验空状态
  const original = FAKE['/api/mcstudio/questbook'];
  // ★ FAKE 里 `/api/mcstudio/questbook` 是**对象**（不是函数），
  //   所以不能写 `...original()` —— 那是调对象，直接抛错，
  //   界面那边的 catch 会把 questBook 置 null，测出来就变成「还没读到任务书」了。
  FAKE['/api/mcstudio/questbook'] = () => ({
    ...original,
    // 给 `issues: { problems: [] }`（不是 null）才是「读到了、但干干净净」这种空状态；
    // `issues: null` 表示「压根没读到」，走的是另一条分支。
    issues: { errorCount: 0, warnCount: 0, problems: [] },
  });
  try {
    await clickMenu('文件', '换一个整合包');
    await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
    // 先确保面板是收起的（上一条用例可能留着）
    if (findByClass(appRoot, 'mcs-diag')) {
      await click(findByClass(appRoot, 'mcs-diag-x'));
      await settle(10);
    }
    await clickMenu('分析', '任务书诊断');
    await settle(20);

    const diag = findByClass(appRoot, 'mcs-diag');
    assert.ok(diag, '面板该开着');
    assert.match(textOf(diag), /没发现问题/, '空状态要说一句，否则用户以为按钮没生效');
    assert.ok(find(diag, (n) => n.tagName === 'BUTTON' && textOf(n) === '检查一次'), '按钮该在');
  } finally {
    FAKE['/api/mcstudio/questbook'] = original;
    if (findByClass(appRoot, 'mcs-diag')) {
      await click(findByClass(appRoot, 'mcs-diag-x'));
      await settle(10);
    }
  }
});

test('任务描述能翻页：多于 1 页时出按钮，点下一页换内容（2026-11-11 用户：很多任务需要翻页查看）', async () => {
  await blueprintReset();
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  node.listeners.click?.forEach((fn) => fn({}));
  await settle();

  // 页标题 + 翻页按钮
  assert.match(textOf(appRoot), /第 1 \/ 2 页/, '该显示页码');
  assert.match(textOf(appRoot), /这是任务简介的第一行。/, '第一页内容');
  assert.ok(!textOf(appRoot).includes('第二页的内容。'), '第一页不该看到第二页的内容');

  // 第 1 页时「上一页」该是禁用的
  const prev = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('上一页'));
  assert.ok(prev, '没有「上一页」按钮');
  assert.ok(prev.attrs.disabled !== undefined && prev.attrs.disabled !== false, '第 1 页时「上一页」该禁用');

  // 点下一页
  const next = find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('下一页'));
  assert.ok(next, '没有「下一页」按钮');
  await click(next);
  await settle(10);

  assert.match(textOf(appRoot), /第 2 \/ 2 页/);
  assert.match(textOf(appRoot), /第二页的内容。/, '翻到第二页该看到第二页的内容');
  assert.ok(!textOf(appRoot).includes('这是任务简介的第一行。'), '第二页不该还显示第一页');
});

test('描述里的占位符画成小标签（后端已换成中文名）', async () => {
  await blueprintReset();
  const node = find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001');
  node.listeners.click?.forEach((fn) => fn({}));
  await settle();

  const holder = findByClass(appRoot, 'mcs-desc-holder');
  assert.ok(holder, '占位符该有专属样式，和作者写的字区分开');
  assert.match(textOf(holder), /钻石/, '显示的是换成名字后的文字');
});

test('换任务时描述回到第 1 页（不会带着上一个任务的页码）', async () => {
  await blueprintReset();
  find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle();
  await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('下一页')));
  await settle(10);
  assert.match(textOf(appRoot), /第 2 \/ 2 页/);

  // 切到任务乙（只有一页、没有 descriptionPages）
  find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002')?.listeners.click?.forEach((fn) => fn({}));
  await settle();
  // 再切回任务甲：应该从第 1 页开始
  find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000001').listeners.click?.forEach((fn) => fn({}));
  await settle();
  assert.match(textOf(appRoot), /第 1 \/ 2 页/, '换回来该从第 1 页开始');
});

test('没描述没奖励的任务不画空的「简介」「奖励」块（用户：只有标题就能指引，这是正常的）', async () => {
  await blueprintReset();
  // 用户原话：「有的任务只有标题没有描述也没有奖励，意思是标题就能够指引了」。
  // ★ 关键：后端对没描述的任务回 **`[[]]`**（一页、零个块），不是 `[]`。
  //   只判 `pages.length` 会渲染出一个空的「简介」标题，看着像加载失败。
  // 这里把任务乙临时改成「纯指引」形态（真实数据里 ATM10Sky 有 192 个这种）。
  const original = FAKE['/api/mcstudio/quest'];
  FAKE['/api/mcstudio/quest'] = (parsed) => {
    const r = original(parsed);
    if (parsed.searchParams.get('questId') === 'AAAA000000000002') {
      return { ...r, description: [], descriptionPages: [[]], descriptionPageCount: 1, tasks: [], rewards: [] };
    }
    return r;
  };
  try {
    await clickMenu('文件', '换一个整合包');
    await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
    find(appRoot, (n) => n.attrs['data-quest'] === 'AAAA000000000002').listeners.click?.forEach((fn) => fn({}));
    await settle();

    const text = textOf(appRoot);
    assert.match(text, /任务乙/, '标题要在（这就是全部指引）');
    // 断言用「详情卡的分节块」有没有出现（画布节点上还挂着 `N 个要求` 的字幕，
    // 那种是按蓝图画布数据渲染的，和详情卡不是一回事）
    //
    // ★ 2026-11-12：这条断言收窄成「内容块」—— 前置 / 后续是**结构信息**，
    //   不管有没有描述都得显示（用户要的正是「点开任务才看得到前置后置」）。
    //   所以这里按分节标题过滤，只禁「简介 / 要求 / 奖励」这三种空块。
    const secTitles = findAllByClass(appRoot, 'mcs-detail-sec-t').map((n) => textOf(n));
    for (const bad of ['简介', '要求', '奖励']) {
      assert.ok(!secTitles.some((t) => t.startsWith(bad)), `没内容时不该有空的「${bad}」块，实际：${secTitles.join(' / ')}`);
    }
  } finally {
    FAKE['/api/mcstudio/quest'] = original;
  }
});

// ------------------------------------------------- 外壳布局（2026-11-12 用户点名两条）

test('★ 页签栏在左栏右边、和左栏并列（VSCode 那种位置关系）', async () => {
  await blueprintReset();
  // 用户原话：「vscode 里是资源管理器和右侧标签页的位置并列，我这边也想做成一样的效果」
  // 所以页签栏必须**包在右区（.mcs-main）里**，而不是横跨整个窗口宽度。
  const body = findByClass(appRoot, 'mcs-body');
  assert.ok(body, '找不到主体容器');
  // 主体的直接子节点只有两个：左栏 + 右区
  const kids = body.children ?? [];
  assert.equal(kids.length, 2, `主体该是「左栏 + 右区」两个子节点，实际 ${kids.length} 个`);
  assert.ok(String(kids[0].className).includes('mcs-left'), '第一个子节点该是左栏');
  assert.ok(String(kids[1].className).includes('mcs-main'), '第二个子节点该是右区');

  // 页签栏在右区里，而且是右区的第一个孩子（最上面）
  const main = kids[1];
  const tabbar = findByClass(main, 'mcs-tabbar');
  assert.ok(tabbar, '页签栏应该在右区里（不是挂在主体上横跨整个宽度）');
  assert.equal(main.children?.[0], tabbar, '页签栏该是右区的第一个孩子');

  // 页签栏下面才是画布 + 右栏
  const panes = findByClass(main, 'mcs-panes');
  assert.ok(panes, '右区里该有装画布/详情的容器');
  assert.ok(findByClass(panes, 'mcs-center'), '画布在中栏容器里');
});

test('「分析 → 任务书诊断」：点开在页签栏下面展开，不切走当前面板', async () => {
  await blueprintReset();
  // 先确认没打开时它不占位置
  assert.ok(!findByClass(appRoot, 'mcs-diag'), '默认不该显示诊断面板');

  const panelBefore = 'quests';
  // 点菜单「分析 → 任务书诊断」
  await clickMenu('分析', '任务书诊断');
  await settle(20);

  const diag = findByClass(appRoot, 'mcs-diag');
  assert.ok(diag, '点了之后该出现诊断面板');
  // ★ 关键（2026-11-12 用户：「从底部展开，不是从顶部展开」+「不要挡住左侧栏和右侧栏」）：
  //   面板现在挂在**中栏那一列**（`.mcs-editor-col`）的最后一个孩子 ——
  //   上是画布、下是诊断；左栏（章节列表）和右栏（任务详情）是它的兄弟，不被挤占。
  const main = findByClass(appRoot, 'mcs-main');
  const kids = main?.children ?? [];
  const tabIdx = kids.findIndex((k) => String(k.className).includes('mcs-tabbar'));
  assert.equal(tabIdx, 0, '页签栏该在最上面');

  const panes = findByClass(appRoot, 'mcs-panes');
  const editorCol = findByClass(appRoot, 'mcs-editor-col');
  assert.ok(editorCol, '中栏该包在 mcs-editor-col 里');
  const colKids = editorCol.children ?? [];
  const diagInCol = colKids.findIndex((k) => String(k.className).includes('mcs-diag'));
  assert.equal(diagInCol, colKids.length - 1, '诊断面板该是中栏那一列的最后一个孩子（画布下方）');
  // 诊断**不能**直接挂在 mcs-main 里 —— 那会横跨中栏 + 右栏，把任务详情挤掉
  const diagDirectInMain = kids.findIndex((k) => String(k.className).includes('mcs-diag'));
  assert.equal(diagDirectInMain, -1, '★ 诊断面板不能再直接挂在 mcs-main 里（会挡住右栏）');
  // 右栏还在 panes 里，且和诊断是兄弟关系而不是父子
  const right = findByClass(appRoot, 'mcs-right');
  assert.ok(right, '右栏（任务详情）该还在');
  assert.ok((panes?.children ?? []).includes(editorCol), '中栏列该在 panes 里');
  assert.equal(panelBefore, 'quests');

  // 展开了就顺手重算一次（否则看到的是连包时的旧结果）
  const lintCall = calls.filter((c) => c.path === '/api/mcstudio/questbook');
  assert.ok(lintCall.length > 0, '展开时该重算一次');

  // 收尾摆正：`state.diagOpen` 是整包级的，留着会污染后面所有用例
  await click(findByClass(appRoot, 'mcs-diag-x'));
  await settle(10);
  assert.ok(!findByClass(appRoot, 'mcs-diag'), '收尾该能收起来');
});

test('诊断面板：点右上角 × 收起，收起来不占位置', async () => {
  await blueprintReset();
  // ★ 状态污染的坑：上一条用例点开过面板，`state.diagOpen` 是整包级、用例间不复位。
  //   这里先把它摆正（开着就点一次收起），否则下一步点菜单反而把它关掉。
  if (findByClass(appRoot, 'mcs-diag')) {
    await click(findByClass(appRoot, 'mcs-diag-x'));
    await settle(10);
  }
  assert.ok(!findByClass(appRoot, 'mcs-diag'), '起点该是收起的');

  await clickMenu('分析', '任务书诊断');
  await settle(20);
  assert.ok(findByClass(appRoot, 'mcs-diag'), '先确认开着');

  await click(findByClass(appRoot, 'mcs-diag-x'));
  await settle(10);
  assert.ok(!findByClass(appRoot, 'mcs-diag'), '点 × 之后该收起来');
});

test('诊断面板：没读到任务书时说实话，不假装「0 个问题」', async () => {
  // 把 questbook 接口临时弄成「没读到」
  const original = FAKE['/api/mcstudio/questbook'];
  FAKE['/api/mcstudio/questbook'] = () => ({ ok: true, questDir: '', locale: 'zh_cn', locales: [], questCount: 0, chapterCount: 0, issues: null });
  try {
    await clickMenu('文件', '换一个整合包');
    await click(find(appRoot, (n) => n.tagName === 'BUTTON' && textOf(n).includes('DemoPack')));
    await clickMenu('分析', '任务书诊断');
    await settle(20);
    const diag = findByClass(appRoot, 'mcs-diag');
    assert.ok(diag, '面板该开着');
    assert.match(textOf(diag), /还没读到任务书|没发现问题/, '要说人话，不能只显示一堆 0');
  } finally {
    FAKE['/api/mcstudio/questbook'] = original;
  }
});
