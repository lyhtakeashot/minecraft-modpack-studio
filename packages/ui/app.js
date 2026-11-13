/**
 * 独立工作台的前端（浏览器版）。
 *
 * 形状是「页面」，不是流水线：
 *   1. 选项目页 —— 先挑一个整合包（或手填目录）
 *   2. 工作台 —— 三栏：
 *        左：Mod 列表（本地搜索 / 联网装新 mod）
 *        中：任务书蓝图编辑（拖动挪位置、右键改任务）
 *        右：选中任务的详情与编辑（改名 / 换图标 / 改依赖 / 删除 / 加后继）
 *
 * 进来就连包、顺手体检（读总览和索引），不用再点一次「体检」。
 *
 * 所有数据都来自本地接口 `/api/mcstudio/*`（桌面版由主进程的协议处理器直接应答，
 * 内置的 MCP 服务器也走同一套路由和 core），
 * 所以这里写的每个调用都等价于「让模型改」时调的那一下；写操作一律「先算 → 再写」两态。
 *
 * 刻意不引入 React、不引入构建步骤：改完 app.js 刷新页面就生效。
 */
import { STAGES, nextStep, stageStatus } from './stages.js';
import { recipeView } from './recipe-view.js';
import { TASK_TYPES, REWARD_TYPES } from '../core/quest-conditions.js';
import { descImageSrcs } from '../core/quest-desc.js';
// 依赖判定（2026-11-12 第二批）：四种依赖方式 + 「至少 N 个」的判定在 core 里，
// 界面只拿它来判断「这个节点现在能不能开工」，别在这里重写一遍。
//
// ★ 必须引 `quest-deps.js` 而**不是** `quests.js`（2026-11-12 16:45 修白屏）：
//   `quests.js` 顶部 import 了 `node:fs` / `node:path`，浏览器加载即抛错，
//   会把整棵模块树拖死 —— 表现就是「窗口开了但一片空白」。
//   界面要用的纯逻辑一律放不带 `node:*` 的文件里。
import { dependencyStatus } from '../core/quest-deps.js';
// 任务级字段的默认值（2026-11-13，照搬 Visual Studio 三条原则）。
// ★ `quest-defaults.js` 是**纯函数、零 Node 依赖**，界面引它安全（同上面的教训）。
//   注意：`specField`（条件/奖励的字段）**不用**这张表 —— 那些字段的默认值
//   在 `quest-conditions.js` 的 TASK_DEFS / REWARD_DEFS 里，两套口径别混。
import { defaultOf as questFieldDefault, isDefault as isQuestFieldDefault } from '../core/quest-defaults.js';

const API = '/api/mcstudio';

/** 全局状态。够用就好，不做状态库。 */
const state = {
  screen: 'pick', // pick | studio
  roots: [],
  instancesByRoot: {},
  // 深度搜索（2026-11-02 用户要的「选一个大概的位置，自动往里面找」）：
  // 只放结果，不自动落地 —— 挖出来的目录要用户点「收进列表」才记住。
  scan: { dir: '', open: false, result: null, error: '' },
  recent: [],
  dir: '',
  instanceId: '',
  summary: null,
  // 左栏
  mods: null,
  modQuery: '',
  modMode: 'local', // local | search
  modSearchQuery: '',
  modSearchResults: null,
  // 勾中的 mod（projectId 或 slug）。以前一次只能选一个，还看不出选没选中。
  modPicked: [],
  modInstallPlan: null,
  modInstalled: null,
  // 装 mod 的整包级状态（切页签不重置，所以别放进 SESSION_KEYS）：
  // modTargetDir = 下载目录（'' = 装到整合包自己的 mods 目录）；
  // modCompat = 整包 mod 体检结果（互斥 / 缺前置 / 版本对不上 / 装了多份）。
  modTargetDir: '',
  modCompat: null,
  // 装 mod 选版本：渠道（正式/测试/开发）＋用户点名的具体版本（工程 key → versionId）。
  // 版本列表按工程展开缓存，别一点就重新联网问一遍。
  modChannel: 'release',
  modVersionPick: {},
  modVersionOpen: '',
  modVersions: {},
  // 检查 mod 更新（整包级，别放进 SESSION_KEYS，切页签会被重置）：
  // modUpdateCheck = 检查结果表；modUpdateSelected = 勾中要升的 key；
  // modUpdatePlan = 算出来的升级清单；modUpdateResult = 升级完的结果。
  modUpdateOpen: false,
  modUpdateChannel: 'release',
  modUpdateCheck: null,
  modUpdateSelected: [],
  modUpdatePlan: null,
  modUpdateResult: null,
  // 安全增强（整包级，同样别放进 SESSION_KEYS）：modUpdateLocks = 这个包锁定的 mod 名单；
  // modUpdateRollbackPlan = 撤回预览；modUpdateRollbackResult = 撤回结果。
  modUpdateLocks: [],
  modUpdateRollbackPlan: null,
  modUpdateRollbackResult: null,
  // 中间
  // 任务书语言：'' = 跟随后端默认（优先中文 / 英文兜底）。选了之后 api()/post()
  // 会把它一路带进每个请求。整包级，别放进 SESSION_KEYS（切页签会被重置）。
  questLocale: '',
  questBook: null,
  canvas: null,
  icons: {},
  sel: '',
  questDetail: null,
  /** 任务描述看到第几页（0 起）。换任务 / 换包时归零，见 `selectQuest()`。 */
  descPage: 0,
  /**
   * 页签栏下面那条「任务书诊断」面板开着没（2026-11-12）。
   * 由「分析 → 任务书诊断」切换；关掉按钮在面板右上角。
   */
  diagOpen: false,
  menu: null, // {x, y, id}
  imageMenu: null, // 装饰图的右键菜单：{x, y, index, image, chapterId}
  // 右栏
  draft: null, // {kind, ...}
  plan: null,
  done: null,
  busy: '',
  error: '',
  note: '',
  // 画布交互（学 UE 蓝图：拖完就是拖完了，不再问一次）
  view: { scale: 1, tx: 0, ty: 0 }, // 平移 / 缩放
  selSet: [], // 多选，数组比 Set 好判断「变了没」
  suppressClick: false, // 刚拖完的那一下 click 要吞掉，否则多选会被收成单选
  suppressContextMenu: false, // 刚用右键平移过，随之而来的右键菜单要吞掉
  band: null, // 框选中正在拖的那个矩形
  nodeEls: {}, // 任务 id → 那个 <g>，一起拖的时候要用
  edgeEls: [], // 连线：{el, fromId, toId, x1, y1, x2, y2}，拖动时按位移实时改
  viewportEl: null, // 承载平移缩放的那一层 <g>
  guideEls: null, // 拖动对齐参考线：{v, h} 两条 <line>，纯视觉 DOM，别进页签快照
  canvasOrigin: null, // 上一次画布原点的 minX/minY，用来抵消「原点变了整张图平移」
  undo: [], // 撤销栈：[{label, moves:[{questId,x,y}]}]
  redo: [],
  flash: '', // 画布底部那行「已挪动 1 个任务」
  // 蓝图式编辑（2026-11-09）：空白右键菜单复用 state.menu（带 blank:true），
  // 下面这组放物品搜索浮层、复制的任务、画布几何与鼠标位置。整包级，别进 SESSION_KEYS。
  itemPicker: null, // {x, y, q, items, busy}：搜物品的小浮层，结果可以拖进画布
  questClipboard: [], // Ctrl+C 记下的任务 id，Ctrl+V 时照原样复制一份
  canvasGeom: null, // {pad, minX, minY}：纯数字，别存 DOM 节点（state 会被打印，循环引用）
  canvasPointer: null, // {clientX, clientY}：鼠标在画布上的最后位置，粘贴时当落点
  /**
   * 「放置模式」：等用户在画布上点一个位置，把新任务放那儿（2026-11-13 用户拍板方案甲）。
   *
   * 为什么要有这个状态：以前「加后继」是算一个写死的偏移量（x+2, y+1），
   * **会盖住右边已有的节点**，而且真实包里 55 处同坐标重叠就是这么来的。
   * 用户的原话是「想做的和 UE 一样」—— UE 和 FTB 本体（`CreateTaskAtMessage.java`：
   * `quest.setX(x); quest.setY(y)`）都是「鼠标松手在哪就放哪」，
   * 没有任何相对偏移规则。所以改成：点按钮 → 进放置模式 → 在画布上点一下定位置。
   *
   * 形状：`{ hint: string, draft: object }`；`draft.at` 会被填上点击处坐标。
   * 为 null 表示没在放置。
   */
  placing: null,
  // ---- 工作流：八阶段进度靠下面这组「已经发生过的事」推出来 ----
  // 规矩：每次请求成功之后往里记一笔，**不要在 render 里现算**。
  // 形状和 packages/ui/stages.js 的 facts 参数一致。
  facts: {
    connected: false,
    instance: null, // /summary 的 instance
    index: null, // /summary 的 index
    questBook: null, // /questbook 的返回
    iconsCovered: 0, // 有图标的物品数
    exportPreview: null, // /export/preview 的返回
    exportDone: null, // /export/build 的返回
    launchResult: null, // /launch/apply 的返回
  },
  // 中栏现在显示哪一块。任务书是「主界面」，其余几块是工具页。
  // quests 任务书蓝图 | content 物品与配方 | pack 打包 | verify 启动验证 | checkup 总览 | mods mod 管理
  panel: 'quests',
  // 画布现在显示哪一章的任务（= 当前激活的章节页签）。章节数据在 /quest/canvas 的 chapters 里。
  canvasChapterId: '',
  // ---- 键盘作用域（2026-11-12）----
  // 用户要求「快捷键在不同位置的生效效果要有区别」：
  //   在画布上（中栏，不含下侧报错栏）→ Ctrl+C/V/Z/Y 操作任务节点
  //   选中文字后（任何一栏）→ 交给浏览器复制粘贴文字
  // 记录「最后点的是哪一块」，因为点画布空白时焦点会落到 body 上，光看 activeElement 判不出来。
  keyScope: '', // '' | 'canvas' | 'other'
  // DOM 替身 / 测试环境没有 window.getSelection，测试可以直接置这个来模拟「选中了文字」。
  // 浏览器里不用管它（真选区由 hasTextSelection() 从 getSelection 读）。
  selectedText: '',
  // 画布观感：edit = 编辑网格（现在的样子）| game = 游戏观感（照 FTB 的贴图画节点）
  // 2026-11-03「任务书成品预览」加的。
  canvasLook: 'edit',
  // ---- 游戏预览窗口（2026-11-12 用户要求）----
  // 用户原话：「预览视角和游戏里看到的效果一样（就是说在画布中心显示一个窗口，
  // 包括翻页，图片，也能打勾完成任务模拟提交和获取）」。
  // 预览态下点节点，就在画布正中弹出这个窗口 —— 长得像游戏里点开任务的界面。
  //   questId：正在看哪个任务（'' = 窗口没开）
  //   page：描述翻到第几页
  //   done：这一轮「模拟完成」了哪些要求（下标数组），只是界面上的打勾，不写盘
  previewQuest: { questId: '', page: 0, done: [] },
  // 游戏观感要用的 FTB 形状贴图（ftbquests:textures/shapes/<形状>/{shape,outline,background}.png）
  // → data URL。走现成的 /quest/images 那条路取，跟章节背景图共用缓存。
  shapeImages: {},
  // ---- 章节页签（VSCode 上面那排）：一章一个页签，最多 8 个 ----
  // 页签只放章节，工具页（配方 / 打包 / 验证 / mod）不进页签，从菜单栏进。
  tabs: [],
  // 每个页签自己的视图状态快照：章节 ID → {view, sel, draft, undo, ...}
  sessions: {},
  menuOpen: '', // 哪个菜单展开了（'' = 都收着）
  // 关页签前的确认：记着「问的是哪一章」（'' = 没在问）
  closeConfirm: '',
  // 左栏章节列表的搜索框
  chapterQuery: '',
  // ---- 改配方（面板 content）----
  // 搜物品 → 看它出现在哪些配方里 → 点一条进编辑表单 → 预览 → 写入
  recipeQuery: '',
  recipeItems: null, // /items 搜出来的物品
  recipeItem: '', // 选中的物品 ID
  recipeHits: null, // /recipes 的返回
  recipeDetail: null, // /recipe 的返回（含 editable / reason）
  recipeView: null, // /recipe/view 的返回（layout 交给 recipe-view.js 画）
  recipeForm: null, // {action, count, inputs[], pattern[], keys{}, fileName}
  recipePlan: null, // /recipe/preview 的返回（含 code / impact）
  recipeDone: null, // /recipe/apply 的返回
  // 批量改配方：中栏列表勾几条 → 一次算清单 → 一次写盘（2026-11-08 加）
  recipePicked: [], // 勾中的配方 ID
  recipeBatchDelta: 1, // 「产出 +N」的步长，默认每条各 +1
  recipeBatchPlan: null, // /recipe/batch/preview 的返回
  recipeBatchDone: null, // /recipe/batch/apply 的返回
  recipeBatchPayload: null, // 预览时的入参；确认写入要逐字复用，别另拼一份
  // ---- 右栏「物品」页签：JEI 那种 9×16 的物品网格（2026-11-05 加）----
  // 页大小完全照抄 JEI 19.x 的默认配置（config/jei/jei-client.ini 里
  // [ingredientList] maxRows=16 / maxColumns=9），一页 144 个。
  grid: {
    q: '', // 搜索框内容（支持 @ # $ - "" | 那套语法）
    page: 1,
    data: null, // /item-grid 的返回
    loading: false,
    error: '',
    seq: 0, // 请求序号：打字太快时只认最后一次的返回
    pick: '', // 当前点中的物品 ID
    field: '', // 上一次聚焦的物品输入框（data-focus 键名），点格子就往这里填
    tip: '', // 悬停中的物品 ID（气泡内容直接改 DOM，不走 render）
    filled: null, // 最近一次「填进某个框」的痕迹 {field, id}，用来给用户一句反馈
    // 「显示全部」开关 + 游戏真值清单状态（2026-11-07 任务③）。
    // 整包级 UI 状态，别放进 SESSION_KEYS（切页签会被重置）。
    showAll: false, // 勾上＝不管有没有清单都显示全部；没清单时后端本来就全显示
    truth: { has: false, source: '' }, // /item-truth/status 的回报
    // 物品数据设置那一组默认收起，只留一条折叠横栏；点开才展开（整包级，别进 SESSION_KEYS）。
    optsOpen: false,
  },
  // 右栏显示哪一页：'detail' 原来的内容 | 'items' 物品网格
  sideTab: 'detail',
  // 中文名补全（CFPA 社区汉化包）：默认完全离线，只有点按钮才联网下载。
  // 整包级状态，别放进 SESSION_KEYS（切页签会被重置）。
  nameFill: {
    busy: false, // 正在下载
    info: null, // /name/preview 的返回：有没有缓存、多少条、许可证
  },
  // ---- 分析页（面板 analysis）：全是只读的体检与分析 ----
  // 这批能力以前只以模型工具的形态存在，插件版删掉后搬到这里。
  analysis: {
    tab: 'overlap', // overlap | progress | mod | path | uses | kubejs
    overlap: null, // /analysis/overlap 的返回
    progress: null, // /analysis/progress 的返回
    mod: null, // /analysis/mod 的返回
    path: null, // /analysis/recipe-path 的返回
    uses: null, // /analysis/recipe-uses 的返回
    kubejs: null, // /analysis/kubejs 的返回
    modKey: '', // 「拆开看 mod」要拆哪个
    modView: 'summary', // summary | items | recipes | tags | loot | config
    item: '', // 「来路 / 谁在用它」查哪个物品
  },
  // ---- 任务书全文搜索（左栏章节列表下面那个框）----
  questQuery: '',
  questHits: null, // /quests?q= 的返回
  // ---- 打包（面板 pack）----
  pack: {
    mode: 'offline',
    packName: '',
    includeSaves: false,
    includeLibraries: true,
    includeAssets: true,
    includeRuntime: false,
    pclExe: '',
    plan: null,
    built: null,
  },
  // ---- 启动验证（面板 verify）----
  launch: { dryRun: null, result: null, timeoutMs: 600000 },
  // ---- 从零装底座（选项目页里的那张卡）----
  scaffold: {
    open: false,
    mcRoot: '',
    name: '',
    mcVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: '',
    javaPath: '',
    plan: null,
    applied: null,
  },
  // ---- 从零建包（抄本机一个能跑的实例当底子，秒级，不下载）----
  packCreate: {
    open: false,
    mcRoot: '',
    name: '',
    templateDir: '',
    withQuestBook: true,
    withKubejs: true,
    plan: null,
    applied: null,
  },
  // ---- 长任务进度（装 mod / 装底座 / 打包）----
  // 后端把一次长任务开成一个「槽」，槽号是 jobId。这里每隔一会儿去问一次，
  // 回来就塞进 progress.job —— 因为 render() 是全量重画，数据在 state 里就够了。
  progress: {
    jobId: '',
    job: null, // /progress 返回的 job
    timer: 0,
    error: '',
  },
  // ---- 通知浮层（2026-11-06 用户要的「告知完就消失」）----
  // 跟 state.note 不一样：note 是状态栏常驻的一句话，toast 是飘在界面上、
  // 过几秒自己没的临时通知。下载汉化包这种「做完了」的回执走这里。
  toast: null, // {text, kind: 'ok'|'error'|'info', until, seq}
  toastSeq: 0, // 通知编号：用来认「是不是我这条」
  toastTimer: 0, // 自动消失的定时器句柄
  // ---- 图标现状（游戏内 Icon Exporter 导出目录的体检结果，任务书顶栏显示一行）----
  iconExport: { status: null, scanning: false },
  // 图标补全引导页的展开/复制两态（纯界面状态，不进 SESSION_KEYS）
  iconGuide: { open: false, copied: false, truthOpen: false },
  // 章节背景图缓存：资源 ID → data URL（跨章共享，connect 时清）
  questImages: {},
  // ---- 让模型帮你改包（MCP）----
  mcp: {
    config: null, // /mcp/config 的返回
    selftest: null, // /mcp/selftest 的返回
    copied: false, // 「复制配置」按过没有
    loading: false,
  },
};

// 形状遮罩的编号器（每画一个遮罩要一个唯一 id）。
// 单独放模块级，不放 state —— 它是渲染过程的临时账，state 快照切换时不该跟着走。
let shapeMaskSeq = 0;

/**
 * 造一个 SVG 元素。
 *
 * 放模块级是因为画形状遮罩的 `drawGameNode` 也要用 —— 它在 canvasSvg 外面，
 * 拿不到 canvasSvg 里那个局部的 `s`。
 */
function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
// --------------------------------------------------------------- 小工具

/** 造一个 DOM 元素。props 里 `on` 开头的是事件、其余能赋值就赋值。 */
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key in node && key !== 'list') {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/** 请求本地接口。params 里空值自动跳过。
 *
 * 2026-11-01 协议化：页面跑在 `mcstudio://app/` 下，`location.origin` 是
 * `mcstudio://app`，相对路径 `/api/mcstudio/...` 会被 `new URL(..., origin)`
 * 解析成 `mcstudio://app/api/mcstudio/...` —— 正好命中主进程注册的协议处理器。
 * 不再需要知道端口号。 */
async function api(path, params = {}) {
  const url = new URL(API + path, location.origin);
  // 选了任务书语言就把它带进每个 GET（后端 openBook 据此读对应的 lang 文件）。
  // 没选（''）时一个字节都不加，行为跟以前完全一样。
  const merged = state.questLocale ? { ...params, locale: state.questLocale } : params;
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `请求失败（HTTP ${res.status}）`);
  return body;
}

/** POST 一条 JSON。写盘类动作都走这个。 */
async function post(path, payload = {}) {
  // 跟 api() 一样：选了语言就带进每个 POST，预览和真装共用这一处，
  // 免得「预览说改 zh_cn、真装写到 en_us」这种静默错。
  const merged = state.questLocale ? { ...payload, locale: state.questLocale } : payload;
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(merged),
  });
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `请求失败（HTTP ${res.status}）`);
  return body;
}

/** 包一层「忙 / 出错」的执行器。 */
async function run(key, fn) {
  state.busy = key;
  state.error = '';
  render();
  try {
    await fn();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.busy = '';
    render();
  }
}

/** 太长就截断（SVG 里没有 CSS 省略号，只能自己切）。 */
function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function kv(pairs) {
  return el(
    'div',
    { class: 'mcs-kv' },
    ...pairs.map(([k, v]) =>
      // v 允许直接给 DOM 节点（比如「图标」行里塞补图按钮）；纯值才字符串化
      el('div', { class: 'mcs-kv-row' }, el('div', { class: 'mcs-k' }, k), el('div', { class: 'mcs-v' }, v instanceof Node ? v : String(v ?? '—'))),
    ),
  );
}

/**
 * 把带样式的片段截断到 max 个字符（画布节点空间有限，FTB 也不显示全名）。
 *
 * 为什么要按片段累加而不是先拼成整句再截：先拼会丢掉「第 N 个字属于哪个颜色」，
 * 截完还得重新对齐颜色，等于把解析又做一遍。这里边走边扣预算，天然对得上。
 *
 * @param {Array<object>|null} spans
 * @param {string} fallback 没有 spans 时用这句（会被截断）
 * @param {number} max
 * @returns {Array<{text: string, color: string, bold: boolean}>}
 */
function svgSpans(spans, fallback, max) {
  const list = Array.isArray(spans) && spans.length
    ? spans
    : [{ text: String(fallback ?? ''), color: '', bold: false }];
  const out = [];
  let budget = max;
  for (const s of list) {
    if (budget <= 0) break;
    const text = String(s.text ?? '');
    if (!text) continue;
    const take = text.slice(0, budget);
    out.push({ text: take, color: s.color || '', bold: Boolean(s.bold) });
    budget -= take.length;
  }
  // 全被截光时给个空段，调用方不用判空
  if (!out.length) out.push({ text: '', color: '', bold: false });
  return out;
}

/**
 * 按 MC 的格式码渲染一段文字（颜色 / 粗体 / 斜体 / 下划线 / 删除线）。
 *
 * 2026-11-11 用户：「把颜色的显示也做出来吧，这样游戏里和这里看的效果一样」。
 * 上一轮只是把 `&6&l` 删掉治乱码，这一轮真的把颜色画出来。
 *
 * 数据形状是 `[{text, color, bold, italic, underline, strike}]`，由
 * `packages/core/quests.js` 的 `parseMcFormatting()` 切好 —— 界面**不重新解析**，
 * 否则格式码的语义（换色会重置样式那套）就要在两边各写一遍、早晚不一致。
 *
 * 纯文字（只有一段、且没有任何样式）时**退化成单个文本节点**，不留多余的 span，
 * 省 DOM 也让 `textOf()` 之类的测试断言照旧能取到整句。
 *
 * @param {Array<object>|null|undefined} spans
 * @param {string} fallback 没有 spans 时显示的纯文字
 * @returns {Node}
 */
function mcText(spans, fallback = '') {
  const list = Array.isArray(spans) ? spans.filter((s) => s && String(s.text ?? '') !== '') : [];
  // 没数据 / 一段纯文字 → 快路径
  if (!list.length) return document.createTextNode(String(fallback ?? ''));
  if (list.length === 1 && !list[0].color && !list[0].bold && !list[0].italic && !list[0].underline && !list[0].strike) {
    return document.createTextNode(String(list[0].text));
  }
  const wrap = el('span', { class: 'mcs-mc-text' });
  for (const s of list) {
    const style = [];
    if (s.color) style.push(`color:${s.color}`);
    // MC 的粗体在游戏里是「字向右加粗一像素」，浏览器 font-weight 够接近了
    if (s.bold) style.push('font-weight:700');
    if (s.italic) style.push('font-style:italic');
    if (s.underline) style.push('text-decoration:underline');
    if (s.strike) style.push('text-decoration:line-through');
    wrap.append(el('span', { style: style.join(';'), text: String(s.text) }));
  }
  return wrap;
}

function card(title, ...kids) {
  return el('div', { class: 'mcs-card' }, title ? el('div', { class: 'mcs-card-t' }, title) : null, ...kids);
}

function row(...kids) {
  return el('div', { class: 'mcs-row' }, ...kids);
}

/**
 * 一个按钮。
 *
 * `opts.focus` 会写成 `data-focus`（2026-11-13 加）：三态字段是三个按钮而不是
 * 一个输入框，测试和无障碍都需要能精确定位到具体某一个。
 */
function btn(label, onClick, opts = {}) {
  return el('button', {
    class: `mcs-btn${opts.primary ? ' mcs-btn-primary' : ''}${opts.danger ? ' mcs-btn-danger' : ''}`,
    text: label,
    disabled: opts.disabled ?? false,
    title: opts.title ?? '',
    'data-focus': opts.focus ?? '',
    onclick: onClick,
  });
}

function iconImg(id, size = 20) {
  const href = state.icons[id];
  if (!href) return el('span', { class: 'mcs-icon-ph', style: `width:${size}px;height:${size}px` });
  return el('img', { class: 'mcs-icon', src: href, width: size, height: size, alt: '' });
}

/** 一次能要多少个图标：后端 ICON_LIMIT 是 128，超过的直接丢掉（不报错，静默少图）。 */
const ICON_BATCH = 128;

/** 批量把图标拿下来（已经有的不重复要）。 */
async function ensureIcons(ids) {
  const want = [...new Set(ids.filter(Boolean))].filter((id) => !state.icons[id]);
  if (want.length === 0) return;
  // 必须分批：物品网格一页 144 格，一次性发过去会被后端按 128 截断，
  // 剩下 16 格永远是空占位符 —— 而且不报错，看起来像「这些物品本来就没图标」。
  for (let i = 0; i < want.length; i += ICON_BATCH) {
    const batch = want.slice(i, i + ICON_BATCH);
    try {
      const r = await post('/item-icons', { dir: state.dir, id: state.instanceId, ids: batch });
      Object.assign(state.icons, r.icons ?? {});
    } catch {
      /* 图标拿不到不影响功能，静默 */
    }
  }
}

/**
 * 去 MC百科 给一个本地查不到贴图的物品补一张图（一次只查一张）。
 *
 * mcmod 的反爬按来源 IP 算总频率（连打就限流），所以这条路只做
 * 「用户盯上某个没图的物品、点一下现查」，不做批量补齐（2026-11-02 用户问
 * 「为什么有些任务没有图标」—— 引擎六轮解析都拿不到的，给个人工兜底入口）。
 * 关键词用中文名：先拿物品 ID 去 /items 搜出中文名再交给后端。
 */
async function fetchWebIcon(itemId) {
  const item = String(itemId ?? '').trim();
  if (!item) return;
  await run(`webicon:${item}`, async () => {
    // /items 用 ID 精确搜，把中文名带出来（mcmod 搜的是中文名，不是 mod:item）
    let name = '';
    let mod = item.includes(':') ? item.split(':')[0] : '';
    try {
      const r = await api('/items', { dir: state.dir, id: state.instanceId, q: item, limit: 5 });
      const hit = (r.items ?? []).find((it) => it.id === item);
      if (hit) {
        name = String(hit.name ?? '').trim();
        if (!mod && hit.modId) mod = String(hit.modId);
      }
    } catch {
      /* 搜不到名字也照查：后端拿空关键词有自己的兜底 */
    }
    const res = await post('/item-icon/web', { dir: state.dir, id: state.instanceId, item, name, mod });
    if (res.found && res.dataUrl) {
      state.icons[item] = res.dataUrl;
      state.note = `补到了「${res.title || item}」的图标`;
    } else {
      state.note = `没补到 ${item} 的图标：${res.reason || 'mcmod 上没找到'}`;
    }
    render();
  });
}

// --------------------------------------------------------------- 动作

/** 连一个整合包：读总览（=体检）→ 再读 mod 列表、任务书、蓝图。 */
async function connect(dir, id = '') {
  state.dir = String(dir ?? '').trim();
  state.instanceId = id;
  await run('connect', async () => {
    const summary = await api('/summary', { dir: state.dir, id: state.instanceId });
    state.summary = summary;
    state.screen = 'studio';
    state.sel = '';
    state.questDetail = null;
    state.menu = null;
    state.draft = null;
    state.plan = null;
    state.done = null;
    state.panel = 'quests';
    state.mods = null;
    state.canvas = null;
    // 换包了：上个包的下载目录和兼容性体检结果都不该留着（不然会装到上一个包的目录）
    state.modTargetDir = '';
    state.modCompat = null;
    // 换包了：上次的更新检查、锁定名单和升级结果也不该带过来
    state.modUpdateOpen = false;
    state.modUpdateChannel = 'release';
    state.modUpdateCheck = null;
    state.modUpdateSelected = [];
    state.modUpdatePlan = null;
    state.modUpdateResult = null;
    state.modUpdateLocks = [];
    state.modUpdateRollbackPlan = null;
    state.modUpdateRollbackResult = null;
    // 每个包的语言文件可能不一样，换包就回到「自动」，别把上个包选的语言带过来
    state.questLocale = '';
    state.canvasChapterId = '';
    // 章节页签跟着整合包走：换包就全清，连上之后再按记住的列表重开
    state.tabs = [];
    state.sessions = {};
    state.closeConfirm = '';
    state.chapterQuery = '';
    state.icons = {};
    state.iconExport = { status: null, scanning: false };
    // 换包＝上一个包的「显示全部」开关和游戏清单状态都归零，连上后重新问一次
    state.grid.showAll = false;
    state.grid.truth = { has: false, source: '' };
    state.grid.optsOpen = false;
    state.questImages = {}; state.shapeImages = {};
    state.selSet = [];
    state.suppressClick = false;
    state.band = null;
    state.nodeEls = {};
    state.edgeEls = [];
    state.viewportEl = null;
    state.guideEls = null;
    state.canvasOrigin = null;
    state.undo = [];
    state.redo = [];
    state.flash = '';
    state.view = { scale: 1, tx: 0, ty: 0 };
    // 换包了：搜物品浮层、复制的任务、画布几何都归零，别把上个包的东西带过来
    state.itemPicker = null;
    state.questClipboard = [];
    state.canvasGeom = null;
    state.canvasPointer = null;
    // 换包了：上个包勾的配方和批量预览/结果都不该留着（不然会写到新包里）
    state.recipePicked = [];
    state.recipeBatchPlan = null;
    state.recipeBatchDone = null;
    state.recipeBatchPayload = null;
    // 重连一次 = 事实全部归零重攒，否则上一次的「打过包」会一直挂着绿灯
    state.facts = {
      connected: false,
      instance: null,
      index: null,
      questBook: null,
      iconsCovered: 0,
      exportPreview: null,
      exportDone: null,
      launchResult: null,
    };
    try {
      localStorage.setItem('mcstudio.instance', JSON.stringify({ dir: state.dir, id: state.instanceId }));
    } catch {
      /* 隐私模式会抛，忽略 */
    }
    // 总览读到了 = 连上了 + 体检过了，这两条事实立刻记下
    state.facts.connected = true;
    state.facts.instance = summary.instance ?? null;
    state.facts.index = summary.index ?? null;
    // 问一句「这个包导过游戏清单没」，决定网格默认精确还是全部显示
    void ensureTruthStatus();
    // mod 列表和任务书是两件独立的事，任一失败都不该挡住另一个
    try {
      const r = await api('/mods', { dir: state.dir, id: state.instanceId });
      state.mods = r.mods ?? [];
    } catch {
      state.mods = [];
    }
    try {
      state.questBook = await api('/questbook', { dir: state.dir, id: state.instanceId });
      state.facts.questBook = state.questBook;
      await refreshCanvas();
      restoreTabs();
    } catch {
      state.questBook = null;
      state.facts.questBook = null;
      state.canvas = null;
    }
  });
}

// --------------------------------------------------------------- 页签持久化

/** 记住的页签存在 localStorage 的哪个键（按整合包分开记）。 */
function tabsStoreKey() {
  return `mcstudio.tabs.${state.dir}|${state.instanceId}`;
}

/** 把现在开着的页签记下（下次进这个包自动开回来）。 */
function saveTabs() {
  try {
    localStorage.setItem(tabsStoreKey(), JSON.stringify({ tabs: state.tabs, active: state.canvasChapterId }));
  } catch {
    /* 隐私模式会抛，忽略 */
  }
}

/**
 * 连上包、读完蓝图之后，把页签还原出来。
 *
 * 优先用上次记着的（还在的章节）；一个都没有就开第一章 —— 用户打开工作台
 * 总得有东西看，不能是一片「左边点一章」的空屏。
 */
function restoreTabs() {
  const chapters = state.canvas?.chapters ?? [];
  if (!chapters.length) return;
  const alive = new Set(chapters.map((c) => c.id));
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(tabsStoreKey()) ?? 'null');
  } catch {
    /* 坏数据当没有 */
  }
  const want = (Array.isArray(saved?.tabs) ? saved.tabs : []).filter((id) => alive.has(id)).slice(0, MAX_TABS);
  if (!want.length) want.push(chapters[0].id);
  state.tabs = [];
  state.sessions = {};
  for (const id of want) {
    state.tabs.push(id);
    state.sessions[id] = freshSession();
  }
  const active = want.includes(saved?.active) ? saved.active : want[0];
  Object.assign(state, state.sessions[active] ?? freshSession());
  state.canvasChapterId = active;
  saveTabs();
  render();
}

/** 读蓝图（画布数据 + 节点图标）。 */
async function refreshCanvas() {
  const r = await api('/quest/canvas', { dir: state.dir, id: state.instanceId });
  state.canvas = r;
  const ids = [];
  for (const chapter of r.chapters ?? []) {
    for (const node of chapter.nodes ?? []) if (node.icon) ids.push(node.icon);
  }
  await ensureIcons(ids);
  state.facts.iconsCovered = Object.keys(state.icons ?? {}).length;
  void ensureIconExportStatus();
  void ensureQuestImages();
  void ensureShapeImages();
}

/** 语言代码 → 界面上给人看的短名。没收录的语言就直接显示代码本身。 */
const LOCALE_LABELS = {
  zh_cn: '中文', zh_tw: '繁中', en_us: '英文', en_gb: '英式',
  ja_jp: '日文', ko_kr: '韩文', de_de: '德文', fr_fr: '法文',
  es_es: '西文', ru_ru: '俄文', pt_br: '葡文',
};

/**
 * 切换任务书语言。整本书要重读一遍（任务名 / 简介都随语言变，光 render 不够）。
 * 这是只读动作，不写盘；选中的语言由 api() / post() 自动带进之后的每个请求。
 * next 传 '' 就是「回到自动」——跟随后端默认（有中文优先中文，否则英文）。
 */
async function setQuestLocale(locale) {
  const next = String(locale ?? '').trim();
  if (next === state.questLocale) return;
  await run('canvas', async () => {
    // 先设再取：api() 会据此把 locale 带进 /questbook 与 /quest/canvas
    state.questLocale = next;
    state.questBook = await api('/questbook', { dir: state.dir, id: state.instanceId });
    state.facts.questBook = state.questBook;
    // 右栏可能还停在旧语言的任务详情 / 未提交的草稿，全部清掉，免得改错语言文件
    state.questDetail = null;
    state.draft = null;
    state.plan = null;
    state.done = null;
    await refreshCanvas();
  });
}

/** 设置菜单里那组语言项（2026-11-09 从画布标题行搬进来）。
 *  一本任务书有几种 lang 文件就出几项，当前项前面打勾；数据源 /questbook 的 locales。
 *  点一下整本书重读（setQuestLocale 会把 locale 带进之后每个 GET / POST）。 */
function localeMenuItems() {
  const list = state.questBook?.locales ?? [];
  if (!list.length) return [];
  const current = state.questLocale; // '' = 自动（跟随后端默认）
  const one = (code, label, hint) => ({
    label: `${current === code ? '✓' : '　'} ${label}`,
    hint,
    disabled: state.busy === 'canvas',
    run: () => void setQuestLocale(code),
  });
  return [
    { sep: true },
    one('', '自动', '跟随后端默认'),
    ...list.map((l) => one(l, LOCALE_LABELS[l] ?? l, `lang/${l}.snbt`)),
  ];
}

/**
 * 任务详情描述里的图片（FTB 的 `{image:…}` 标记）。
 *
 * 用户 2026-11-11 18:06 原话：「有的任务不仅有文字说明还有图片辅助，但是现在这个
 * 软件上还没有」。描述存在 lang 文件里，图是 `{image:ns:path.png width:160 ...}`，
 * 资源解析走和章节背景图**同一条** `/quest/images` 接口，缓存也共用
 * `state.questImages` —— 别新建一份，同一张图存两遍毫无意义。
 *
 * ★ 不去重会死循环：右栏是整页重画的，每次 render 都调这里，
 * 已缓存的必须立刻返回，否则一路 请求 → render → 请求。
 */
async function ensureDescImages() {
  const detail = state.questDetail;
  // 图片可能在任何一页上，所以**所有页**都要扫（不能只扫当前页 ——
  // 用户翻到第 2 页才发现图没取，那一下会卡一下）。
  const srcs = descImageSrcs(detail?.descriptionPages ?? detail?.descriptionBlocks);
  const want = srcs.filter((s) => !state.questImages[s]);
  if (!want.length) return;
  try {
    const r = await post('/quest/images', { dir: state.dir, id: state.instanceId, srcs: want });
    Object.assign(state.questImages, r.images ?? {});
    render();
  } catch {
    /* 取不到就当没有：缺图不是错误，描述文字照常显示 */
  }
}

/**
 * 章节背景图 / 装饰图（FTB Quests 的 images 字段）。
 *
 * 画布数据里每章带着 images（资源 ID + 格子坐标），但资源 ID 不是图 ——
 * 要拿这里按「当前页签那章」批量去后端换 data URL，再画到任务节点下层。
 * 换不到的（mod 没装 / 图不在 jar 里）静默跳过：缺背景图不是错误。
 */
async function ensureQuestImages() {
  const chapter = (state.canvas?.chapters ?? []).find((c) => c.id === state.canvasChapterId);
  // 一章一个页签：没开页签就没有「当前章」，也就不画背景图
  const srcs = [...new Set((chapter?.images ?? []).map((im) => im.image).filter(Boolean))];
  if (!srcs.length) return;
  const want = srcs.filter((s) => !state.questImages[s]);
  if (!want.length) return;
  try {
    const r = await post('/quest/images', { dir: state.dir, id: state.instanceId, srcs: want });
    Object.assign(state.questImages, r.images ?? {});
    render();
  } catch {
    /* 取不到就当没有 */
  }
}

/**
 * FTB 的形状名单。
 *
 * 和 `packages/core/quests.js` 里的 `QUEST_SHAPES` 是同一份（那边是后端体检用的，
 * 这边是画布渲染用的）。实测 FTB jar 里 `assets/ftbquests/textures/shapes/`
 * 下正好这 10 种，每种三层：shape（实心白图形）/ outline（描边环）/ background（半透明白底板）。
 */
const QUEST_SHAPE_IDS = ['circle', 'diamond', 'gear', 'heart', 'hexagon', 'none', 'octagon', 'pentagon', 'rsquare', 'square'];

/** 某个形状某一层的资源 ID（`ftbquests:textures/shapes/gear/shape.png` 这种）。 */
function shapeSrc(shape, layer) {
  return `ftbquests:textures/shapes/${shape}/${layer}.png`;
}

/**
 * 游戏观感要用的 FTB 形状贴图。
 *
 * 贴图全在 ftb-quests 的 jar 里（`assets/ftbquests/textures/shapes/...`），
 * 所以走现成的 /quest/images 那条路换 data URL —— 跟章节背景图同一个接口、同一份缓存。
 * 取不到的（没装 FTB Quests / 名字不对）就静默跳过，那一格节点退回矩形的画法。
 */
async function ensureShapeImages() {
  if (state.canvasLook !== 'game') return;
  const chapter = (state.canvas?.chapters ?? []).find((c) => c.id === state.canvasChapterId);
  const shapes = new Set();
  for (const node of chapter?.nodes ?? []) {
    const s = String(node.shapeEffective || node.shape || '').trim();
    if (s) shapes.add(s);
  }
  if (!shapes.size) shapes.add('circle');
  const want = [];
  for (const s of shapes) {
    for (const layer of ['shape', 'outline', 'background']) {
      const src = shapeSrc(s, layer);
      if (!state.shapeImages[src]) want.push(src);
    }
  }
  if (!want.length) return;
  try {
    const r = await post('/quest/images', { dir: state.dir, id: state.instanceId, srcs: want });
    Object.assign(state.shapeImages, r.images ?? {});
    render();
  } catch {
    /* 取不到就退回矩形画法 */
  }
}

/**
 * 游戏观感：把一个任务节点画成 FTB 游戏里的样子。
 *
 * FTB 每个任务节点是三层贴图叠出来的（实测 ftb-quests jar）：
 * - shape.png      实心白图形（齿轮 / 圆形 / 菱形…），游戏里靠 tint 上色
 * - background.png 半透明白底板
 * - outline.png    1~2 像素的描边环
 *
 * 三张都是「纯白 RGB + alpha」，所以要上色就得拿它当遮罩用：
 * `<mask>` 里放白图，`<rect>` 填颜色，浏览器按遮罩的 alpha 把形状裁出来。
 * 直接 `<image>` 画上去只会是一块白板 —— 那正是之前没做观感模式的原因。
 *
 * 贴图取不到（没装 FTB Quests / 名字对不上）就返回 false，
 * 那一格节点退回矩形的画法 —— 宁可少一点像，也不能整张画布空着。
 */
/**
 * 游戏观感模式下节点的四种状态描边色（2026-11-12 第三批）。
 *
 * 数值照抄 FTB 默认主题 `assets/ftbquests/ftb_quests_theme.txt:62-65`，
 * **格式是 `#AARRGGBB`（alpha 在前），不是常见的 `#RRGGBBAA`** —— 这根筋别拧反。
 */
const QUEST_STATE_COLORS = {
  // 未开始：白 alpha 150
  notStarted: { r: 255, g: 255, b: 255, a: 150 },
  // 已开始：青 alpha 200
  started: { r: 0, g: 255, b: 255, a: 200 },
  // 已完成：绿 alpha 200
  completed: { r: 0x56, g: 0xff, b: 0x56, a: 200 },
  // 锁定：灰 alpha 255
  locked: { r: 0x99, g: 0x99, b: 0x99, a: 255 },
};

/** 把 {r,g,b,a} 拼成 SVG 能吃的 rgba()。 */
const rgbaOf = (c, alphaScale = 1) =>
  `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.max(0, Math.min(1, (c.a / 255) * alphaScale)).toFixed(3)})`;

/**
 * 这个节点该用哪种状态色（2026-11-12 第三批）。
 *
 * ★ 严格照抄 `QuestButton.draw()` 那段分支，但**只判我们真能知道的那部分**：
 *
 *     canStart = isCompleted || isStarted || areDependenciesComplete
 *     if (canStart) { ... } else { outline = LOCKED }
 *     并且 !canStart || !areDependenciesComplete 时还要盖一层黑 alpha=100
 *
 * 其中「已完成 / 已开始」是**玩家的存档进度** —— 编辑器的任务书里压根没有这份数据，
 * 我们也不该瞎编（编出来的绿勾/青边全是假象）。所以这里只算**依赖能不能凑齐**：
 *   - 依赖满足 → 未开始（白边）—— 这是编辑期唯一能笃定的状态
 *   - 依赖不满足 → 锁定（灰边 + 黑遮罩）
 *
 * `min_required_dependencies` 和四种依赖方式都在 `dependencyStatus()` 里算，别在这里重写一遍。
 *
 * 返回 { state, outline, darken, unlocked }：
 *   unlocked 表示依赖齐了（等价于游戏的 areDependenciesComplete）
 */
function questStateOf(node) {
  const deps = Array.isArray(node?.dependencies) ? node.dependencies : [];
  // 「前置指向不存在的任务」不算数 —— 游戏那边 removeInvalidDependencies() 会把它删掉
  const valid = deps.filter((d) => d && d.missing !== true).map((d) => String(d.id ?? d));
  const unlocked = dependencyStatus(
    {
      dependencies: valid,
      dependencyRequirement: node?.dependencyRequirement,
      minRequiredDependencies: node?.minRequiredDependencies,
    },
    // 编辑器里没有任何「前置已完成」的信息，一律按「全都没完成」算 ——
    // 这正是规划阶段要看的东西：这条线现在能不能开工。
    () => false,
  ).ok;
  return {
    state: unlocked ? 'notStarted' : 'locked',
    outline: unlocked ? QUEST_STATE_COLORS.notStarted : QUEST_STATE_COLORS.locked,
    // 锁定要盖黑 alpha=100（游戏里 `!canStart || !areDependenciesComplete` 两个条件都命中）
    darken: !unlocked,
    unlocked,
  };
}

/**
 * 画一个「游戏观感」的任务节点（2026-11-12 第三批按源码真值重写）。
 *
 * 绘制顺序**严格照抄 `QuestButton.draw()`**（:322-419），连「哪一层盖在图标上面」
 * 都不许改 —— 游戏的顺序是：
 *
 *   1. shape.png      填 DARK_GRAY（#212121）
 *   2. background.png 填 白 alpha=150
 *   3. outline.png    填 **状态描边色**（四色，见 QUEST_STATE_COLORS）
 *   4. 图标            居中，边长 = 宽度 × **2/3** × icon_scale
 *   5. 选中高亮        outline + background 叠白，alpha = 190 + sin(t*0.003)*50（呼吸）
 *   6. 锁定遮罩        shape 叠黑 alpha=100   ← **在图标之上**
 *   7. 悬停高亮        shape 叠白 alpha=100   ← 也在图标之上
 *   8. 状态角标        边长 = 宽度 × 3/8，贴**右上角**
 *   9. 隐藏角标        同尺寸，贴**左上角**（编辑模式下不可见时才画）
 *
 * 以前这里图标只有宽度的 0.34（游戏是 2/3，小了近一倍）、描边一律黑、
 * 三层全是白色靠 opacity 调深浅、没有角标也没有锁定遮罩 —— 所以「看着不像游戏」。
 */
function drawGameNode(g, node, cx, cy, defs, selected) {
  const shape = String(node.shapeEffective || node.shape || 'circle').trim() || 'circle';
  // ★ 2026-11-13：用 `sizeEffective`（任务自己写的 → 章节默认 → 1），
  //   不是 `size`。`size` 现在如实反映文件（0 = 没写 = 跟随章节），
  //   直接拿它画会把「跟随章节」的节点画成 0.5 倍（被下面那个 clamp 兜住）。
  const size = Number(node.sizeEffective ?? node.size) || 1;
  // 边长 = 基准尺寸 × 大小倍率。倍率上限 2.8 —— 再大就盖住旁边的节点了，
  // 而 FTB 里 size 也只有 1 / 1.5 / 2 这种档位。
  const side = Math.min(BOX_W, BOX_H) * Math.min(Math.max(size, 0.5), 2.8);
  const x = cx - side / 2;
  const y = cy - side / 2;

  const shapeHref = state.shapeImages[shapeSrc(shape, 'shape')];
  const outlineHref = state.shapeImages[shapeSrc(shape, 'outline')];
  const bgHref = state.shapeImages[shapeSrc(shape, 'background')];
  if (!shapeHref) return false;

  // 一层 = 一个遮罩 + 一个填色的矩形。遮罩区域用 userSpaceOnUse 定死，
  // 不然默认的「对象包围盒 ±10%」会让贴图边缘被裁掉一小圈。
  // 注意：**每次调用都要新建一个 mask**，多个节点共用一个 id 会整块画错。
  const layer = (href, fill, opacity = 1) => {
    const id = `mcs-shape-mask-${(shapeMaskSeq += 1)}`;
    const mask = svgEl('mask', { id, maskUnits: 'userSpaceOnUse', x, y, width: side, height: side });
    mask.append(svgEl('image', { href, x, y, width: side, height: side, preserveAspectRatio: 'none' }));
    defs.append(mask);
    const rect = svgEl('rect', { x, y, width: side, height: side, fill, mask: `url(#${id})`, opacity });
    g.append(rect);
    return rect;
  };

  const st = questStateOf(node);

  // 1~3 层：底板 / 图形 / 描边（描边压在最上面，且是状态色不是黑）
  if (bgHref) layer(bgHref, '#FFFFFF', 0.588); // 白 alpha=150 → 150/255
  layer(shapeHref, '#212121'); // DARK_GRAY
  if (outlineHref) layer(outlineHref, rgbaOf(st.outline));

  // 4. 图标：边长 = 宽度 × 2/3（游戏真值；以前是 0.34，小近一倍）
  const iconSide = side * (2 / 3);
  const iconX = cx - iconSide / 2;
  const iconY = cy - iconSide / 2;
  if (node.icon && state.icons[node.icon]) {
    g.append(svgEl('image', {
      x: iconX, y: iconY, width: iconSide, height: iconSide,
      href: state.icons[node.icon], draggable: 'false',
      // 图标也吃锁定遮罩的暗化 —— 由下面第 6 步统一盖，这里不用单独处理
    }));
  }

  // 5. 选中高亮：outline + background 叠白（游戏里是呼吸的，编辑期静态即可）
  if (selected) {
    const glow = 'rgba(255, 255, 255, 0.85)';
    if (outlineHref) layer(outlineHref, glow);
    if (bgHref) layer(bgHref, glow);
  }

  // 6. 锁定遮罩：shape 叠黑 alpha=100 —— **盖在图标之上**（游戏就是这么画的）
  if (st.darken) layer(shapeHref, '#000000', 100 / 255);

  // 8. 状态角标：边长 = 宽度 × 3/8，贴右上角。
  //    编辑期没有玩家进度，只画「锁定」这一种 —— 这是唯一能笃定的状态标记。
  if (!st.unlocked) {
    drawNodeBadge(g, side, x, y, 'lock');
  }

  // 9. 隐藏角标：贴左上角。`invisible` 字段还没读进模型（第五批才做），先留接口。
  if (node.invisible === true) {
    drawNodeBadge(g, side, x, y, 'hidden', true);
  }

  // ★ 游戏观感模式下**不画标题、不画「N 个要求」**（2026-11-12 用户原话：
  //   「我看到游戏里任务书的表现形式就只有图标，前置、后置、奖励都是点击任务节点后
  //    出现的，你调整一下」）。
  return true;
}

/**
 * 节点角标（2026-11-12 第三批）：边长 = 宽度 × 3/8，右上角（隐藏角标在左上角）。
 *
 * 游戏里四种角标都用主题贴图（check / alert / pin / hidden），
 * 编辑期能用上的只有「锁」和「隐藏」两种，这里用矢量画，不依赖贴图。
 */
function drawNodeBadge(g, side, x, y, kind, topLeft = false) {
  const s = (side * 3) / 8;
  const bx = topLeft ? x : x + side - s;
  const by = y;
  if (kind === 'lock') {
    // 灰色小锁：一个锁体 + 一段锁梁。锁定态本来就是灰的，别用高饱和色抢眼。
    const bodyW = s * 0.62;
    const bodyH = s * 0.48;
    const bx2 = bx + (s - bodyW) / 2;
    const by2 = by + (s - bodyH) / 2 + s * 0.1;
    g.append(svgEl('path', {
      d: `M ${bx2 + bodyW * 0.22} ${by2} v ${-bodyH * 0.32} a ${bodyW * 0.28} ${bodyW * 0.28} 0 0 1 ${bodyW * 0.56} 0 v ${bodyH * 0.32}`,
      fill: 'none',
      stroke: 'rgba(230, 230, 230, 0.9)',
      'stroke-width': Math.max(1, s * 0.09),
      'stroke-linecap': 'round',
    }));
    g.append(svgEl('rect', {
      x: bx2, y: by2, width: bodyW, height: bodyH, rx: s * 0.08,
      fill: 'rgba(230, 230, 230, 0.9)',
    }));
    return;
  }
  if (kind === 'hidden') {
    // 隐藏：一个「眼睛被划掉」的记号，画成一条斜线 + 一个圈
    g.append(svgEl('circle', {
      cx: bx + s / 2, cy: by + s / 2, r: s * 0.26,
      fill: 'none', stroke: 'rgba(255, 220, 120, 0.95)', 'stroke-width': Math.max(1, s * 0.09),
    }));
    g.append(svgEl('line', {
      x1: bx + s * 0.22, y1: by + s * 0.78, x2: bx + s * 0.78, y2: by + s * 0.22,
      stroke: 'rgba(255, 220, 120, 0.95)', 'stroke-width': Math.max(1, s * 0.09), 'stroke-linecap': 'round',
    }));
  }
}

/**
 * 图标现状（任务书顶栏显示一行）：
 * 游戏里的 Icon Exporter mod 可以把所有物品渲成高清图标存进 icon-exports 目录，
 * 后端体检过一次（带 10 分钟缓存），这里把体检结果拿过来显示，让用户知道
 * 自己的包「图标从哪来、有多少张」。失败不吵：这行只是锦上添花。
 */
async function ensureIconExportStatus() {
  if (state.iconExport.status || state.iconExport.scanning) return;
  try {
    state.iconExport.status = await api('/icon-export/status', { dir: state.dir, id: state.instanceId });
  } catch {
    state.iconExport.status = { text: '图标来源未知', hasExport: false, dirs: [] };
  }
  render();
}

/** 点「重扫」：无视缓存强制再体检一遍，结果显示在 note 里。 */
async function iconExportScan() {
  if (state.iconExport.scanning) return;
  state.iconExport.scanning = true;
  await run('iconscan', async () => {
    try {
      const r = await post('/icon-export/scan', { dir: state.dir, id: state.instanceId });
      state.iconExport.status = r;
      state.note = (r.lines ?? []).join('；') || r.text || '扫完了';
    } catch (e) {
      state.note = `重扫失败：${e?.message ?? e}`;
    }
    state.iconExport.scanning = false;
  });
}

/** 选项目页：把每个常见位置下的实例都列出来。 */
async function loadInstancesAll() {
  await run('roots', async () => {
    const r = await api('/roots');
    state.roots = r.roots ?? [];
    const map = {};
    await Promise.all(
      state.roots.map(async (root) => {
        try {
          const res = await api('/instances', { root: root.dir });
          map[root.dir] = res.instances ?? [];
        } catch {
          map[root.dir] = [];
        }
      }),
    );
    state.instancesByRoot = map;
  });
}

// --------------------------------------------------------------- 浏览文件夹
//
// 「识别坏了」修复的第二半（2026-11-02）：自动探测只扫常见位置，用户的包放在
// 别处就看不到。给首屏一个「浏览…」按钮：弹系统对话框选目录 → /roots/add 存进
// 持久化的记住列表 → 重新拉一遍 roots。下次启动还在，不用再选。

/** 轮询 /pick-folder/status，选完（或取消/出错）就返回。 */
async function waitPickFolder() {
  for (;;) {
    // 稍等再问：对话框刚弹出来 status 还是 picking
    await new Promise((resolve) => setTimeout(resolve, 500));
    const s = await api('/pick-folder/status');
    if (s.status !== 'picking') return s;
  }
}

/** 点「浏览…」：选目录 → 存进记住列表 → 刷新首屏列表。 */
async function browseForPack() {
  await run('browse', async () => {
    await api('/pick-folder');
    const s = await waitPickFolder();
    if (s.error) throw new Error(s.hint ? `${s.error}（${s.hint}）` : s.error);
    if (!s.path) return; // 用户点了取消，不算出错
    await post('/roots/add', { dir: s.path });
    state.dir = s.path; // 手填框顺手带上，用户可以直接「打开这个包」
    await loadInstancesAll();
  });
}

/**
 * 「选一个大概的位置，自动往里找」。
 *
 * 和 browseForPack 的分工：
 * - browseForPack：用户**已经知道**包在哪，选到包本身，直接记住；
 * - deepScanAt：用户只记得「大概在这块」，让我们自己往下挖。
 *
 * 挖出来的结果**先不落地**，摆在界面上让用户看/挑；
 * 用户点「收进列表」才写 rememberedRoots，点「只开这一次」直接连上。
 * 这样扫一个大盘（几百个目录）不会顺手把一堆死路径塞进首屏。
 */
async function deepScanAt(dir) {
  const target = String(dir ?? '').trim();
  if (!target) {
    state.scan.error = '先选一个目录，或者在上面填一个。';
    render();
    return;
  }
  await run('scan', async () => {
    state.scan.dir = target;
    state.scan.error = '';
    const r = await api('/roots/scan', { dir: target, depth: 5, maxMs: 8000 });
    state.scan.result = r;
  });
}

/** 把深度搜索结果整批收进记住列表（走已有的 /roots/add，一条都不重复写）。 */
async function rememberScanHits() {
  const hits = state.scan.result?.roots ?? [];
  if (hits.length === 0) return;
  await run('scan-add', async () => {
    for (const hit of hits) {
      await post('/roots/add', { dir: hit.dir });
    }
    await loadInstancesAll();
    state.scan.result = null;
  });
}

/** 深度搜索卡上的「选个目录…」：只选目录填进输入框，不立刻开翻。 */
async function browseForScan() {
  await run('scan-browse', async () => {
    await api('/pick-folder');
    const s = await waitPickFolder();
    if (s.error) throw new Error(s.hint ? `${s.error}（${s.hint}）` : s.error);
    if (!s.path) return; // 取消
    state.scan.dir = s.path;
  });
}

async function loadMods() {
  await run('mods', async () => {
    const r = await api('/mods', { dir: state.dir, id: state.instanceId, refresh: '1' });
    state.mods = r.mods ?? [];
  });
}

async function searchMods() {
  const q = state.modSearchQuery.trim();
  if (!q) return;
  await run('modsearch', async () => {
    const r = await api('/mod-search', { dir: state.dir, id: state.instanceId, q, limit: 12 });
    state.modSearchResults = r.results ?? r.projects ?? [];
    state.modPicked = [];
    state.modInstallPlan = null;
    state.modInstalled = null;
    // 换一批搜索结果，之前展开的版本列表和点名版本都作废，别把上一条的选择带过来
    state.modVersions = {};
    state.modVersionOpen = '';
    state.modVersionPick = {};
  });
}

/**
 * 整包 mod 体检：扫一遍这个整合包现有的 mods 目录，看有没有互斥、缺前置、
 * 版本对不上、装了多份这些毛病。
 *
 * 结果放在整包级状态 state.modCompat 里（切页签不重置）。
 * 后端已经把结论写成「人话」放在 lines 里，界面直接显示，不再自己翻译一遍。
 */
async function loadModCompat() {
  await run('modcompat', async () => {
    const r = await api('/mod-compat', { dir: state.dir, id: state.instanceId });
    state.modCompat = r;
  });
}

// ----------------------------------------------------- 检查 mod 更新

/** 点「检查更新」：联网问一遍谁有新版本。只读，不写盘。 */
async function checkModUpdates() {
  await run('modupdatecheck', async () => {
    const r = await api('/mod-update/check', {
      dir: state.dir, id: state.instanceId, channel: state.modUpdateChannel,
    });
    state.modUpdateCheck = r;
    // 后端顺带回了锁定名单，存下来给「锁定 / 解锁」按钮用
    state.modUpdateLocks = r.locks ?? state.modUpdateLocks;
    // 重新查了，之前勾的、算的清单、升级结果全部作废
    state.modUpdateSelected = [];
    state.modUpdatePlan = null;
    state.modUpdateResult = null;
    state.modUpdateRollbackPlan = null;
    state.modUpdateRollbackResult = null;
    // 网络不通时后端返回「空表 + error 提示」，照样放进结果卡里显示
  });
}

/** 勾/取消一个要升的 mod（按检查结果里的 key，也就是旧 jar 的 sha1）。 */
function toggleUpdatePick(key) {
  if (!key) return;
  const set = new Set(state.modUpdateSelected);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  state.modUpdateSelected = [...set];
  // 选择变了，之前算的清单就作废
  state.modUpdatePlan = null;
  state.modUpdateResult = null;
  render();
}

/** 算升级清单：把检查结果整块回传，省得后端再联网问一遍。不写盘。 */
async function previewModUpdate(selected) {
  const keys = selected ?? state.modUpdateSelected;
  // 走 POST：整块检查结果可能几十 KB，塞进 GET 查询串会超长。
  // 后端 readParams 对 POST 直接读 JSON body，不再拼 URL。
  await run('modupdateplan', async () => {
    const r = await post('/mod-update/preview', {
      dir: state.dir,
      id: state.instanceId,
      channel: state.modUpdateChannel,
      check: JSON.stringify(state.modUpdateCheck ?? {}),
      selected: JSON.stringify(keys),
    });
    state.modUpdatePlan = r;
  });
}

/** 真升级：停用旧 jar（改名，不删）+ 下载新 jar，全程带进度条。 */
async function applyModUpdate() {
  watchKind('mod-update');
  await runWithProgress('modupdateapply', async () => {
    const body = await post('/mod-update/apply', {
      dir: state.dir,
      id: state.instanceId,
      channel: state.modUpdateChannel,
      check: JSON.stringify(state.modUpdateCheck ?? {}),
      selected: JSON.stringify(state.modUpdateSelected),
    });
    state.modUpdateResult = body;
    state.modUpdatePlan = null;
    // 检查结果后端顺带回了锁定名单，存下来给「锁定 / 解锁」按钮用
    state.modUpdateLocks = body.locks ?? state.modUpdateLocks;
    state.modUpdateRollbackPlan = null;
    state.modUpdateRollbackResult = null;
    // 升完刷新一遍本地 mod 列表，让用户马上看到新版本
    const r = await api('/mods', { dir: state.dir, id: state.instanceId, refresh: '1' });
    state.mods = r.mods ?? [];
    return body;
  });
}

/** 这个 mod 是不是已经锁定了（按 modId / 工程 ID / 文件名比对）。 */
function isModUpdateLocked(item) {
  const low = (v) => String(v ?? '').toLowerCase();
  return (state.modUpdateLocks ?? []).some((lock) => {
    return (low(lock.modId) && low(lock.modId) === low(item?.modId))
      || (low(lock.projectId) && low(lock.projectId) === low(item?.projectId))
      || (low(lock.fileName) && low(lock.fileName) === low(item?.fileName));
  });
}

/** 加 / 解 / 清 锁定名单（只写软件自己的数据目录，不碰整合包）。 */
async function changeModUpdateLock(action, item) {
  await run('modupdatelocks', async () => {
    const r = await post('/mod-update/locks', {
      dir: state.dir,
      id: state.instanceId,
      action,
      entry: item ? JSON.stringify(item) : '',
    });
    // 后端写不了数据目录时会给 error 字段（外层 ok() 仍是 true），
    // 这里抛出去交给 run() 统一显示成红字，别自己塞 state.error。
    if (r.error) throw new Error(r.error);
    state.modUpdateLocks = r.locks ?? [];
    state.modUpdateRollbackPlan = null;
    state.modUpdateRollbackResult = null;
  });
}

/** 算撤回清单：把升级结果整块回传，不写盘。 */
async function previewModUpdateRollback() {
  await run('modupdaterollbackplan', async () => {
    const r = await post('/mod-update/rollback/preview', {
      dir: state.dir,
      id: state.instanceId,
      result: JSON.stringify(state.modUpdateResult ?? {}),
    });
    state.modUpdateRollbackPlan = r;
    state.modUpdateRollbackResult = null;
  });
}

/** 真撤回：旧 jar 改回原名、新 jar 改名停用留着，一个文件都不删。 */
async function applyModUpdateRollback() {
  await run('modupdaterollbackapply', async () => {
    const r = await post('/mod-update/rollback/apply', {
      dir: state.dir,
      id: state.instanceId,
      result: JSON.stringify(state.modUpdateResult ?? {}),
    });
    state.modUpdateRollbackResult = r;
    state.modUpdateRollbackPlan = null;
    const mods = await api('/mods', { dir: state.dir, id: state.instanceId, refresh: '1' });
    state.mods = mods.mods ?? [];
  });
}

/**
 * 计划卡里的「选个目录…」：挑一个别的文件夹当下载目录。
 *
 * 复用现成的选目录通路（/pick-folder + 轮询 status），不自己造一套。
 * 选完把路径写进 state.modTargetDir（空串 = 装到整合包自己的 mods 目录）。
 */
async function pickModTargetDir() {
  await run('modtargetdir', async () => {
    await api('/pick-folder');
    const s = await waitPickFolder();
    if (s.error) throw new Error(s.hint ? `${s.error}（${s.hint}）` : s.error);
    if (!s.path) return; // 取消
    state.modTargetDir = s.path;
  });
}

/**
 * 预览和真装共用同一份 body —— 只要有一处漏带 channel / pinned，
 * 就会出现「预览说装 1.0，真装却装了 2.0」这种最难查的错。
 * projects 里只放工程 key，点名的版本单独走 pinned（后端 asList 只认 key）。
 */
function installBody(list) {
  const involved = new Set(list.filter(Boolean));
  for (const item of state.modInstallPlan?.items ?? []) {
    if (item.projectId) involved.add(item.projectId);
    if (item.slug) involved.add(item.slug);
  }
  const pinned = {};
  for (const key of involved) {
    const v = state.modVersionPick[key];
    if (v) pinned[key] = v;
  }
  return {
    dir: state.dir,
    id: state.instanceId,
    projects: JSON.stringify(list),
    channel: state.modChannel,
    pinned: JSON.stringify(pinned),
    // 下载目录：空串 = 装到整合包自己的 mods 目录；填了别的目录 = 文件下到那里。
    // 预览和真装共用这一份 body，少一处就可能「预览装 A 目录、真装装 B 目录」。
    targetDir: state.modTargetDir ?? '',
  };
}

async function previewInstall(projectId) {
  // 单点「只看这个」：把它当成「只选了这一个」，选择条也跟着变成 1 个，
  // 否则会出现「界面说选了 3 个，但要装的是 1 个」这种自相矛盾。
  if (projectId) state.modPicked = [projectId];
  await run('modplan', async () => {
    state.modInstallPlan = await post('/mod-install/preview', installBody([projectId]));
  });
}

/** 展开某个 mod 的版本列表（点「选版本」时才联网问一次）。 */
async function loadModVersions(key) {
  if (state.modVersions[key]) {
    state.modVersionOpen = state.modVersionOpen === key ? '' : key;
    render();
    return;
  }
  await run('modversions', async () => {
    const r = await api('/mod-versions', { dir: state.dir, id: state.instanceId, project: key, channel: state.modChannel });
    state.modVersions[key] = r.versions ?? [];
    state.modVersionOpen = key;
  });
}

/** 点名要装某个具体版本；再点一下同一个＝取消点名，回到自动挑。 */
function pickModVersion(key, versionId) {
  const next = { ...state.modVersionPick };
  if (next[key] === versionId) delete next[key];
  else next[key] = versionId;
  state.modVersionPick = next;
  state.modInstallPlan = null;
  state.modInstalled = null;
  render();
}

/** 勾上 / 取消勾一个 mod。 */
function togglePickMod(key) {
  if (!key) return;
  const set = new Set(state.modPicked);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  state.modPicked = [...set];
  // 选择变了，之前算的清单就作废了 —— 留着会让用户以为装的是旧的
  state.modInstallPlan = null;
  state.modInstalled = null;
  render();
}

/** 一次算多个 mod 的清单（会带上必装前置）。 */
async function previewInstallMany(keys) {
  const list = (keys ?? []).filter(Boolean);
  if (list.length === 0) return;
  await run('modplan', async () => {
    state.modInstallPlan = await post('/mod-install/preview', installBody(list));
  });
}

async function applyInstall() {
  // 先盯上（按 kind 问后端「正在跑的那个」），再发请求 —— 否则头几百毫秒界面是空的。
  // runWithProgress 结束时会把最后那一帧抓回来再停轮询，所以这里不用再收尾。
  watchKind('mod-install');
  await runWithProgress('modapply', async () => {
    // 多选：清单里有几个就装几个（plan 里 projectIds 是算清单时记下的全部）
    const picked = state.modInstallPlan?.projectIds?.length
      ? state.modInstallPlan.projectIds
      : state.modPicked.length
        ? state.modPicked
        : [state.modInstallPlan?.projectId].filter(Boolean);
    const body = await post('/mod-install/apply', installBody(picked));
    state.modInstalled = body;
    state.modInstallPlan = null;
    state.modPicked = [];
    const r = await api('/mods', { dir: state.dir, id: state.instanceId, refresh: '1' });
    state.mods = r.mods ?? [];
    return body;
  });
}

// --------------------------------------------------------------- 任务编辑

function findNode(id) {
  for (const chapter of state.canvas?.chapters ?? []) {
    for (const node of chapter.nodes ?? []) if (node.id === id) return { node, chapter };
  }
  return null;
}

/**
 * 点诊断面板的一行 —— 跳到那条问题对应的任务。
 *
 * 要做的有三件事，少一件用户都觉得「点了没反应」：
 *   1. **切到那个任务所在的章节页签**。任务可能压根不在当前页签的章节里，
 *      这时候光把右栏换掉，画布上还是别的章的节点，看起来就是「没跳」。
 *   2. 选中它（右栏换成这个任务的详情）。
 *   3. **把画布平移过去**，让那个节点出现在可见区域正中。
 *      只换右栏不动画布的跳转是不及格的 —— 用户在诊断列表里点，
 *      想看的就是画布上那个方块在哪。
 *
 * 注意别踩 2026-11-03 那条老坑：不要为了「跳过去」而 render() 整页再指望它定位。
 * 直接改 `state.view` 再重画才稳。这里也是这么做的。
 *
 * @param {{questId?: string, chapterId?: string}} ref 后端问题里的定位信息
 */
async function jumpToIssue(ref) {
  const questId = ref?.questId ?? '';
  const chapterId = ref?.chapterId ?? '';
  if (!questId && !chapterId) return;

  // 任务不在 canvas 里（比如 ID 拼错、或这本书没读到）就别乱跳，
  // 免得把用户从当前页面骗走、结果什么都没选中。
  const hit = questId ? findNode(questId) : null;
  // 兜底顺序（2026-11-12）：canvas 里找到的那章 > 后端给的 chapterId。
  // ★ canvas 一次装**全部章节**的节点，正常情况下 findNode 就该命中；
  //   带 chapterId 是为了「canvas 没读到那一章 / 任务 ID 不在里面」时还能告诉
  //   用户它到底在哪一章，而不是笼统地说「找不到」。实测 ATM10Sky 有 43 条
  //   跨章节前置，改之前后端根本不回 chapterId，出问题时连线索都没有。
  const targetChapter = hit?.chapter?.id
    ?? (state.canvas?.chapters ?? []).find((c) => c.id === chapterId)?.id
    ?? '';
  if (!targetChapter) {
    // 只有章节、没有任务（章节级问题）：切到那一章就够了。
    if (chapterId && state.tabs.includes(chapterId)) {
      switchTab(chapterId);
      return;
    }
    // ★ 以前这里是静默 `return` —— 用户点了毫无反应、也不报错，只会觉得按钮坏了。
    //   （2026-11-12 用户原话：「前置定位的功能有问题」）
    showToast(
      chapterId
        ? `跳不过去：这个任务在别的章节（${chapterId}），当前任务书里没读到它`
        : `跳不过去：这个任务（${questId || '（无）'}）不在当前任务书里，可能已经被删掉了`,
      'error',
    );
    return;
  }

  // 1. 切页签。openChapterTab 会处理「还没开着这个页签」的情况（新开一个）。
  if (state.canvasChapterId !== targetChapter || !state.tabs.includes(targetChapter)) {
    openChapterTab(targetChapter);
  }

  // 2. 选中任务（右栏换成它的详情）
  if (!questId) return;
  if (!hit) {
    // 章节切过去了但没有这个任务 —— 明确说一句，别让用户以为按钮坏了。
    // 用 toast 而不是 state.note：note 是状态栏里那行常驻小字，用户点完
    // 眼睛在画布上，看不见左下角。
    showToast(`这个任务（${questId}）不在当前任务书里，可能已经被删掉了`, 'error');
    return;
  }
  await selectQuest(questId);

  // 3. 画布移到它身上。
  //   ⚠️ 必须等这一帧画完：`state.canvasGeom` 是 canvasSvg() **画的时候**才算出来的，
  //   如果刚做过 switchTab（换到别的章节），此刻它还是上一章的值（甚至是 undefined）——
  //   拿旧几何去算，画布会平移到错的位置，看起来就像「跳歪了」。
  await nextFrame();
  centerOnQuest(questId);
}

/**
 * 等下一帧再往下走（画布几何要等 render 真正跑过一次才有）。
 *
 * 两边都要能跑：桌面版里有 requestAnimationFrame，DOM 替身和 Node 环境里没有 ——
 * 没有就退化成「等一个宏任务」，足够让 render() 的同步部分跑完。
 */
function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * 把画布平移成「这个任务在可见区域正中」。
 *
 * 屏幕坐标的换算是（见 canvasSvg）：
 *   screen = view.tx + (node.x - canvasOrigin.x) * CELL_X * scale
 * 节点在画布坐标系里的落点是 `px(node.x)`，而 `px` 已经把 canvasOrigin 减掉了 ——
 * 所以反解只要 `tx = 容器半宽 - scale * (px(node.x) + BOX_W/2)`。
 *
 * 拿不到容器尺寸（DOM 替身 / 还没布局）就干脆不动 —— 瞎算会把画布推到屏幕外，
 * 比「没居中」严重得多。测试里验的是「有没有选中 + 请求对不对」，
 * 居中效果只能靠真机双击 exe 看。
 */
function centerOnQuest(questId) {
  const hit = findNode(questId);
  // 几何还没算出来（这一章还没画过 / 画布是空的）：宁可不挪，
  // 也不要拿 undefined 去算出一堆 NaN 把画布搞丢。
  if (!hit || !state.canvasGeom) return;
  const { pad, minX, minY } = state.canvasGeom;
  const scale = state.view.scale || 1;
  // 节点中心在画布坐标系里的位置，和 canvasSvg 的 px()/py() 是同一套算法
  const nodeCx = ((hit.node.x ?? 0) - minX) * CELL_X + pad + BOX_W / 2;
  const nodeCy = ((hit.node.y ?? 0) - minY) * CELL_Y + pad + BOX_H / 2;
  const host = canvasHostEl;
  const rect = host?.getBoundingClientRect?.();
  const w = Number(rect?.width ?? 0) || 0;
  const h = Number(rect?.height ?? 0) || 0;
  // 量不到容器尺寸（DOM 替身 / 还没布局）时就不动视图 —— 瞎算只会把画布推到屏幕外
  if (!(w > 0 && h > 0)) return;
  state.view.tx = w / 2 - scale * nodeCx;
  state.view.ty = h / 2 - scale * nodeCy;
  render();
}

/**
 * 点诊断面板里的一条问题。
 * 带 questId / chapterId 的才跳；不带的（比如「章节没有 id」）点了什么也不做 ——
 * 但那行仍然显示，因为这类问题本身是真的。
 */
async function jumpToDiagnostic(index) {
  const problems = state.questBook?.issues?.problems ?? [];
  const p = problems[index];
  if (!p) return;
  if (!p.questId && !p.chapterId) return;
  await jumpToIssue({ questId: p.questId, chapterId: p.chapterId });
}

async function selectQuest(questId) {
  state.sel = questId;
  state.selSet = questId ? [questId] : [];
  state.menu = null;
  state.imageMenu = null;
  state.draft = null;
  state.plan = null;
  state.done = null;
  // 换任务要回到第 1 页，否则看了任务 A 的第 3 页、切到只有 1 页的任务 B，
  // 页号越界会被夹回 0（能工作），但再切回 A 又从第 1 页开始，很别扭。
  state.descPage = 0;
  await run('quest', async () => {
    state.questDetail = await api('/quest', { dir: state.dir, id: state.instanceId, questId });
  });
  // 详情里如果带图片（FTB 的 `{image:…}`），异步换成 data URL 再重画一次。
  // 必须在 run() 之外：run() 内部已经在收尾时 render() 过了，这里补的是「图取回来那次」。
  await ensureDescImages();
}

/**
 * Ctrl / Cmd / Shift + 点击：把这个任务加进选择，或者从选择里去掉。
 * 不用非得用框选，点着加更直观（UE 里也是 Shift 加选）。
 */
function toggleSelect(questId) {
  const set = new Set(state.selSet);
  if (set.has(questId)) set.delete(questId);
  else set.add(questId);
  state.selSet = [...set];
  state.sel = state.selSet.length === 1 ? state.selSet[0] : '';
  state.menu = null;
  state.imageMenu = null;
  state.draft = null;
  state.plan = null;
  state.done = null;
  state.questDetail = null;
  render();
}

function openMenu(event, questId) {
  state.menu = { x: event.clientX ?? 120, y: event.clientY ?? 120, id: questId };
  state.imageMenu = null;
  state.sel = questId;
  if (!state.selSet.includes(questId)) state.selSet = [questId];
  render();
}

// —— 完成条件 / 奖励：类型可换、字段跟着变 ——
// 唯一的类型目录在 packages/core/quest-conditions.js：界面、后端、MCP 共用一份，
// 免得「点界面改」和「让模型改」落出来的文件结构不一样。
function defaultSpecOf(def) {
  const spec = {};
  for (const f of def?.fields ?? []) {
    spec[f.key] = f.def !== undefined ? f.def
      : f.kind === 'bool' ? false
        : f.kind === 'number' ? (f.min ?? 1)
          : '';
  }
  return spec;
}

// 把草稿里的一组条件/奖励翻译成要发给后端的字段：
// 物品类型发老四个字段（兼容性最好），其它类型发一段 spec（JSON 串）。
//
// ★ 2026-11-13：**没选类型 = 这一组不要**，一个字段都不发（返回空对象）。
//   以前 `!type` 会落到物品分支，发出 `taskItem: ''` —— 后端虽然也生成不出条目，
//   但 body 里带着一组「空物品条件」本身就是错的，读日志的人会以为配了条件。
function conditionPayload(draft, kind) {
  const isTask = kind === 'task';
  const type = isTask ? draft.taskType : draft.rewardType;
  if (!type) return {};
  if (type === 'item') {
    const itemKey = isTask ? 'taskItem' : 'rewardItem';
    if (draft[itemKey] === undefined) return {};
    return isTask
      ? { taskItem: draft.taskItem, taskCount: draft.taskCount }
      : { rewardItem: draft.rewardItem, rewardCount: draft.rewardCount };
  }
  const spec = { type, ...(isTask ? draft.taskSpec : draft.rewardSpec) };
  return isTask ? { taskSpec: JSON.stringify(spec) } : { rewardSpec: JSON.stringify(spec) };
}

/**
 * 一个动态字段（非物品类型用）：按字段 kind 出不同的控件。
 *
 * ## 照搬 Visual Studio 原则 2 / 3（2026-11-13）
 *
 * - **原则 2「面板标出哪些改过」**：值不是默认值 ⇒ 整行加 `mcs-field-dirty`，
 *   左边一道品牌色竖条（一眼看出我动过什么）。
 * - **原则 3「一键 Reset」**：改过的时候，标签右边出现一个 ↩，点了回默认。
 *
 * ★ 「默认值」取自**这个字段自己的 `def`**（`quest-conditions.js` 的 TASK_DEFS /
 *   REWARD_DEFS 里每个字段都写了），不是 `quest-defaults.js` 那张表 ——
 *   那张表管的是**任务级**字段（shape / size / optional…），键名完全不同。
 *   两个口径别混：条件字段的默认值由条件类型目录定义，任务级由任务字段表定义。
 */
function specField(d, specKey, f, prefix) {
  const spec = d[specKey] ?? (d[specKey] = {});
  const focus = `${prefix}spec_${f.key}`;
  const write = (v) => { spec[f.key] = v; };

  // 没给过 ⇒ 用这个字段自己的默认值算「默认」，所以刚切到某个类型时
  // 一个字段都不该显示成「已改」。
  const defValue = f.def !== undefined ? f.def : (f.kind === 'bool' ? false : f.kind === 'number' ? (f.min ?? 1) : '');
  const cur = spec[f.key] === undefined ? defValue : spec[f.key];
  const dirty = !sameAsDefault(f, cur, defValue);

  let control;
  if (f.kind === 'bool') {
    control = el('input', {
      type: 'checkbox', checked: !!spec[f.key], 'data-focus': focus,
      onchange: (e) => {
        write(!!e.target.checked);
        // 重画才会更新「已改」标记和 ↩ 按钮（同 conditionEditor 的做法）
        render();
      },
    });
  } else if (f.kind === 'enum') {
    control = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' },
      ...(f.options ?? []).map((o) => btn(o.label, () => {
        write(o.value);
        render();
      }, { primary: spec[f.key] === o.value, title: String(o.value) })));
  } else {
    control = el('input', {
      class: 'mcs-input',
      type: f.kind === 'number' ? 'number' : 'text',
      min: f.min, placeholder: f.placeholder ?? '',
      value: spec[f.key] ?? '', 'data-focus': focus,
      oninput: (e) => { write(f.kind === 'number' ? (Number(e.target.value) || 0) : e.target.value); },
    });
  }

  const labelRow = el('div', { class: 'mcs-field-label mcs-field-label-row' },
    el('span', { text: f.label }),
    // 默认值的灰提示：VS 的属性窗口就是把默认值灰着显示
    dirty ? null : el('span', { class: 'mcs-field-def', text: `默认 ${defaultTextOf(f, defValue)}` }),
    // ↩ 只在改过时出现（默认状态下没有东西可恢复）
    dirty ? el('button', {
      class: 'mcs-field-reset',
      type: 'button',
      text: '↩',
      title: `恢复默认（${defaultTextOf(f, defValue)}）`,
      'data-focus': `${focus}_reset`,
      onclick: () => {
        // ★ 恢复默认 = 把这个键从 spec 里**删掉**，不是写一个等于默认的值。
        //   写盘层看到「没给」就什么都不写，游戏用它自己的默认 —— 这才是 VS 那条原则。
        delete spec[f.key];
        render();
      },
    }) : null);

  return el('div', { class: `mcs-field${dirty ? ' mcs-field-dirty' : ''}` }, labelRow, control);
}

/** 这个值和字段默认值算不算一样。布尔按真假、数字按数值、其余按字符串。 */
function sameAsDefault(f, value, defValue) {
  if (f.kind === 'bool') return !!value === !!defValue;
  if (f.kind === 'number') {
    // 空输入框（用户清空了）也算「没改」—— 它最终会被写成默认值
    if (value === '' || value === null || value === undefined) return true;
    return Number(value) === Number(defValue);
  }
  if (value === null || value === undefined) return true;
  return String(value) === String(defValue);
}

/** 默认值的人话：空串 / 关 这类别显示成空白。 */
function defaultTextOf(f, defValue) {
  if (f.kind === 'bool') return defValue ? '开' : '关';
  if (defValue === '' || defValue === undefined || defValue === null) return '空';
  return String(defValue);
}

// 一组条件/奖励的编辑器：上面一排类型按钮，下面跟着该类型的字段。
function conditionEditor(d, kind) {
  const isTask = kind === 'task';
  const defs = isTask ? TASK_TYPES : REWARD_TYPES;
  const typeKey = isTask ? 'taskType' : 'rewardType';
  const specKey = isTask ? 'taskSpec' : 'rewardSpec';
  // ★ 2026-11-13：不再默认成 'item'。没选类型时一个按钮都不高亮，
  //   也不出任何字段 —— 新建任务默认就是「没有条件 / 没有奖励」（照 FTB 本体）。
  //   以前 `?? 'item'` 会让界面假装已经配好了「物品」类型，用户以为条件填好了。
  const cur = d[typeKey] ?? '';
  const prefix = d.kind === 'new' ? 'new' : 'r';
  const items = [
    el('div', { class: 'mcs-field-label', text: isTask ? '完成条件' : '奖励' }),
  ];
  // 「不要这一组」的按钮：从「已经选了一个类型」回到「一个都没选」。
  // 只在选中状态才出现，免得新建时一进来就有个莫名其妙的按钮。
  const typeButtons = defs.map((def) => btn(def.label, () => {
    d[typeKey] = def.type;
    d[specKey] = defaultSpecOf(def);
    render();
  }, { primary: cur === def.type, title: def.type }));
  if (cur) {
    typeButtons.push(btn('× 不要', () => {
      d[typeKey] = '';
      d[specKey] = {};
      if (isTask) { d.taskItem = ''; d.taskCount = 1; } else { d.rewardItem = ''; d.rewardCount = 1; }
      render();
    }, { title: '这一组不要了（等于没有条件 / 奖励）' }));
  }
  items.push(el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px' }, ...typeButtons));
  if (cur === 'item') {
    // 物品类型原样复用老的四个输入框（focus 键一字不改，网格拖物品照旧能用）。
    const itemKey = `${prefix}${isTask ? 'taskitem' : 'rewarditem'}`;
    const countKey = `${prefix}${isTask ? 'taskcount' : 'rewardcount'}`;
    const itemVal = isTask ? d.taskItem : d.rewardItem;
    const countVal = isTask ? d.taskCount : d.rewardCount;
    items.push(row(
      itemInput(itemKey, itemVal ?? '', isTask ? '物品 ID，如 create:cogwheel' : '奖励物品 ID，可留空', 'mcs-field-half'),
      el('input', {
        class: 'mcs-input mcs-field-half', type: 'number', min: 1, max: 2304,
        placeholder: isTask ? '交几个' : '给几个',
        title: isTask ? '要交几个（默认 1）' : '给几个（默认 1）',
        value: countVal ?? 1, 'data-focus': countKey,
        oninput: (e) => {
          const n = Number(e.target.value) || 1;
          if (isTask) d.taskCount = n; else d.rewardCount = n;
        },
      }),
    ));
  } else {
    const def = defs.find((x) => x.type === cur);
    for (const f of def?.fields ?? []) items.push(specField(d, specKey, f, prefix));
  }
  return items;
}

/**
 * 「新建任务」草稿的**唯一来源**（2026-11-13 抽出来）。
 *
 * 为什么要抽：现在有三条路会新建任务 —— 左栏「＋新任务」、空白右键「新建任务」、
 * 右栏「加后继」。三条路的字段必须一模一样，否则某条路少一个字段就会
 * 「填了东西被丢掉」或「建出来是个空壳」。抽一个工厂，加字段只改这一处。
 *
 * @param {string|null} questId 「加后继」时传当前任务 ID（新任务会依赖它）
 * @param {{x:number,y:number,chapterId?:string}|null} at 放置模式定下的坐标
 */
function newDraft(questId = null, at = null) {
  return {
    kind: 'new', questId, at,
    title: '', subtitle: '', description: '',
    // ★ 2026-11-13 用户拍板「新建任务不需要预填物品类型」（照 FTB 本体）：
    //   这里**不预置** taskType / rewardType / 数量 / spec —— 建出来就是一个
    //   干净的空任务（tasks: []、rewards: []），和游戏里新建任务一模一样。
    //   以前预置成「物品类型 + 数量 1」，界面会显示「完成条件 = 物品、数量 1」
    //   这种假象，用户以为已经配好了条件，其实什么都没有。
    taskItem: '', taskCount: 1,
    rewardItem: '', rewardCount: 1,
    taskType: '', rewardType: '', taskSpec: {}, rewardSpec: {},
  };
}

/**
 * 进入「放置模式」：给当前任务加一个后续任务，位置由用户点画布决定。
 *
 * 2026-11-13 用户原话：「加后继是加在原任务的右侧一定距离吗，这点的实现效果我想做的和 ue 一样」
 * → 选方案甲（照 FTB / UE 的「点哪放哪」）。
 *
 * 改之前的行为：`startDraft('new', questId)` → `newSpot()` 算 `x+2, y+1` —— 固定偏移、
 * 不查重，右边已经有节点时会直接盖住。真包实测 55 处同坐标重叠就是这么来的。
 *
 * 现在的流程：
 *   点「加后续」→ 画布进入放置态（顶部出提示条）→ 用户在画布空白处点一下
 *   → `placeAt()` 记下坐标 → 弹出新建表单（依赖已经预填成当前任务）
 *   → 预览 → 写入。
 *
 * @param {string} questId 当前任务的 ID
 */
function beginPlaceNew(questId) {
  const hit = findNode(questId);
  const name = hit?.node?.title || questId;
  state.menu = null;
  state.imageMenu = null;
  state.plan = null;
  state.done = null;
  state.sel = questId ?? '';
  state.placing = {
    hint: `给「${truncate(String(name), 14)}」加一个后续 —— 在画布上点一下，新任务就放在那儿`,
    draft: newDraft(questId),
  };
  render();
}

/** 退出放置模式（按 Esc、或点提示条上的「取消」）。 */
function cancelPlacing() {
  if (!state.placing) return;
  state.placing = null;
  render();
}

function startDraft(kind, questId, at = null) {
  const hit = findNode(questId);
  const node = hit?.node;
  state.menu = null;
  state.imageMenu = null;
  state.plan = null;
  state.done = null;
  state.sel = questId ?? '';
  if (kind === 'icon') {
    state.draft = { kind, questId, value: node?.icon ?? '', items: null, busy: false };
  } else if (kind === 'deps') {
    const picked = new Set((node?.dependencies ?? []).map((d) => d.id));
    state.draft = { kind, questId, picked, filter: '' };
  } else if (kind === 'delete') {
    state.draft = { kind, questId, title: node?.title ?? questId, dependents: node?.dependents ?? [] };
  } else if (kind === 'new') {
    // 双击空白新建时带坐标；右键「在它后面加一个」时按被点节点算。
    // 字段名跟后端 handleQuestAddPreview / handleQuestAddApply 认的一一对应
    // （taskItem / taskCount / rewardItem / rewardCount），别再叫 item / count ——
    // 那样界面填的东西会被整个丢掉，建出来是个点一下就过的空任务（2026-11-04 修）。
    state.draft = newDraft(questId, at);
  } else if (kind === 'rename') {
    // 「改名」这张卡其实也管完成条件/奖励：把详情里第一条物品预填进来，
    // 用户不动的话预览算出来是「没变化」，后端就不会去碰章节文件。
    // 顺带把副标题也预填 —— 以前留空会把人家写好的副标题清掉。
    const d = state.questDetail?.id === questId ? state.questDetail : null;
    const firstTask = (d?.tasks ?? []).find((t) => t.type === 'item');
    const firstReward = (d?.rewards ?? []).find((r) => r.type === 'item');
    // 真后端会在详情里附上「友好 spec」：不是物品的条件/奖励也能原样预填，
    // 用户不动的话预览仍算「没改动」。老数据（没有 spec）就退回原来的物品预填。
    const tSpec = d?.taskSpecs?.[0];
    const rSpec = d?.rewards?.[0]?.spec;
    const useTaskSpec = !!(tSpec?.type && tSpec.type !== 'item');
    const useRewardSpec = !!(rSpec?.type && rSpec.type !== 'item');
    const taskRest = useTaskSpec ? { ...tSpec } : {};
    delete taskRest.label;
    const rewardRest = useRewardSpec ? { ...rSpec } : {};
    delete rewardRest.label;
    state.draft = {
      kind, questId,
      // ★ 预填用 rawTitle（文件里那个真值），不是 detail.title。
      // detail.title 是「给人看的名字」，没标题的任务在那儿会退回副标题 / 图标名 ——
      // 拿它预填的话，用户一保存就把「Becoming a Network Admin!」写成了正式标题，
      // 悄悄改掉了原文件里「根本没写标题」这个事实。
      // 画布节点同理：`node.rawTitle` 才是文件里那个值。
      title: d?.rawTitle ?? node?.rawTitle ?? node?.title ?? '',
      subtitle: d?.subtitle ?? '',
      taskItem: firstTask?.what ?? '', taskCount: firstTask?.count ?? 1,
      rewardItem: firstReward?.what ?? '', rewardCount: firstReward?.count ?? 1,
      taskType: useTaskSpec ? tSpec.type : 'item',
      rewardType: useRewardSpec ? rSpec.type : 'item',
      taskSpec: taskRest, rewardSpec: rewardRest,
      // 任务级字段（2026-11-13 默认值改造）：按详情现状预填。
      // `fields` 只在**读到详情**时才有 —— 没读到就不带，改名卡上那张
      // 「任务高级设置」卡也不画（宁可少改，也不要拿空值把用户设置抹掉）。
      ...(d ? { fields: questFieldsFromDetail(d) } : {}),
    };
    // 简介：详情里是「一行一段」的数组，输入框要换行文本。只有真读到详情才带上 desc，
    // 没读到就别发 —— 发个空串会把人家写好的简介悄悄清掉。
    if (d) state.draft.desc = (d.description ?? []).join('\n');
  } else if (kind === 'chapter') {
    // 新章节默认排在最后（orderIndex 留空 = 后端自己算）
    state.draft = { kind, title: '', group: '', icon: '', orderIndex: '' };
  } else if (kind === 'image') {
    // 新装饰图：默认 4×3 格贴在这一章的左上角，参数都能在表单里改。
    // 章节 ID 记在草稿里 —— 中途切页签不该把「往哪章加」改掉。
    state.draft = {
      kind, chapterId: state.canvasChapterId, image: '', x: 0, y: 0, width: 4, height: 3, rotation: 0,
    };
  } else if (kind === 'imagemove' || kind === 'imagedelete') {
    // at 里带本张图的现状，表单用它当默认值（也就省得再查一次画布数据）
    state.draft = { kind, chapterId: state.canvasChapterId, index: at?.index ?? 0, ...(at?.image ?? {}) };
  }
  render();
}

/** 搜物品（中文也行），给「换图标」当候选。 */
async function searchIconItems() {
  const draft = state.draft;
  if (!draft) return;
  const q = String(draft.value ?? '').trim();
  draft.busy = true;
  render();
  try {
    const r = await api('/items', { dir: state.dir, id: state.instanceId, q, limit: 40 });
    const items = r.items ?? [];
    await ensureIcons(items.map((it) => it.id));
    draft.items = items;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    draft.items = [];
  } finally {
    draft.busy = false;
    render();
  }
}

async function previewNode() {
  const draft = state.draft;
  if (!draft) return;
  await run('nodeplan', async () => {
    const payload = { dir: state.dir, id: state.instanceId, questId: draft.questId };
    if (draft.kind === 'icon') payload.icon = draft.value;
    if (draft.kind === 'deps') payload.dependencies = JSON.stringify([...draft.picked]);
    state.plan = await post('/quest/node/preview', payload);
  });
}

async function applyNode() {
  const draft = state.draft;
  if (!draft) return;
  await run('nodeapply', async () => {
    const payload = { dir: state.dir, id: state.instanceId, questId: draft.questId };
    if (draft.kind === 'icon') payload.icon = draft.value;
    if (draft.kind === 'deps') payload.dependencies = JSON.stringify([...draft.picked]);
    state.done = await post('/quest/node/apply', payload);
    state.plan = null;
    state.draft = null;
    await refreshCanvas();
  });
}

async function previewDelete() {
  const draft = state.draft;
  if (!draft) return;
  await run('delplan', async () => {
    state.plan = await post('/quest/node/delete/preview', {
      dir: state.dir,
      id: state.instanceId,
      questId: draft.questId,
    });
  });
}

async function applyDelete() {
  const draft = state.draft;
  if (!draft) return;
  await run('delapply', async () => {
    state.done = await post('/quest/node/delete/apply', {
      dir: state.dir,
      id: state.instanceId,
      questId: draft.questId,
    });
    state.plan = null;
    state.draft = null;
    state.sel = '';
    state.questDetail = null;
    await refreshCanvas();
  });
}

/**
 * 「任务高级设置」这张卡的字段定义（2026-11-13 默认值改造）。
 *
 * ## 为什么只放这 5 个
 *
 * FTB 的 `Quest` 有 30+ 个字段，但**界面上有输入口才值得放**。
 * 用户 2026-11-13 定了口径：这一轮只做机制、不补那 20+ 个字段（单独立项）。
 * 这 5 个是**已经在读、只缺写**的（详情接口早就返回了它们），
 * 放上来马上就能用，而且覆盖真包里量最大的那几个（`optional` 633 处、`invisible` 51 处）。
 *
 * `kind` 决定控件和「什么算默认」：
 *   - `tristate` → 三态（是 / 否 / 跟随章节），**必须能表达「没写」**
 *   - `bool`     → 勾选框，不勾就是默认
 *   - `text` / `number` → 输入框，空 = 默认
 *
 * `key` 必须和 core `quest-defaults.js` 里的键名一模一样（就是 snbt 里那个键）。
 */
const QUEST_FIELD_CARDS = [
  {
    key: 'shape', label: '节点形状', kind: 'text',
    hint: '留空 = 跟章节走。可填 circle / diamond / gear / heart / hexagon / none / octagon / pentagon / rsquare / square',
  },
  { key: 'size', label: '节点大小（倍）', kind: 'number', hint: '留空或用 0 = 跟章节走；1 是「明确 1 倍」' },
  { key: 'optional', label: '可选任务', kind: 'bool', hint: '勾上 = 不做也能往下走' },
  { key: 'invisible', label: '对玩家不可见', kind: 'bool', hint: '勾上 = 游戏里完全不显示这个任务' },
  { key: 'can_repeat', label: '可重复完成', kind: 'tristate', hint: '跟随章节 / 可以 / 不可以' },
];

/** 从详情对象里取这几个字段的现状（没读到详情时返回空对象）。 */
function questFieldsFromDetail(d) {
  const out = {};
  if (!d) return out;
  // 只在详情真的带了这个键时才预填 —— 详情老版本没有 canRepeat 之类时，
  // 不能凭空塞一个 null 上去（那会被当成「用户要恢复默认」而删掉用户的设置）。
  if (d.shape !== undefined) out.shape = d.shape;
  if (d.size !== undefined) out.size = d.size;
  if (d.optional !== undefined) out.optional = d.optional === true;
  if (d.invisible !== undefined) out.invisible = d.invisible === true;
  if (Object.hasOwn(d, 'canRepeat')) out.can_repeat = d.canRepeat ?? null;
  return out;
}

/**
 * 「任务高级设置」小卡：每个字段带「改过」标记和 ↩ 恢复默认。
 *
 * ★ 照搬 Visual Studio 原则 2 / 3：
 *   原则 2 —— 改过的字段加 `mcs-field-dirty`（左边一道品牌色竖条）+ 标签后面跟 ↩
 *   原则 3 —— 点 ↩ 就把这个值恢复成默认（写盘时等于默认 ⇒ 键从文件里删掉）
 */
function questFieldCards(d) {
  if (!d.fields) return [];
  const items = [
    el('div', { class: 'mcs-field-label', text: '任务高级设置（照游戏默认，没动过的不会写进文件）' }),
  ];
  for (const f of QUEST_FIELD_CARDS) {
    const cur = d.fields[f.key];
    const dirty = !isQuestFieldDefault(f.key, cur);
    let control;
    if (f.kind === 'bool') {
      control = el('input', {
        type: 'checkbox',
        checked: cur === true,
        'data-focus': `qfield_${f.key}`,
        onchange: (e) => {
          d.fields[f.key] = !!e.target.checked;
          render();
        },
      });
    } else if (f.kind === 'tristate') {
      // 三态必须能表达「没写」—— 所以是三个按钮，不是一个勾选框。
      // ★ 每个按钮都挂 `data-focus`（`qfield_can_repeat` / `_true` / `_false`），
      //   测试和键盘导航都要能定位到具体某一个。
      const options = [
        ['follow', '跟随章节', null],
        ['yes', '可以', true],
        ['no', '不可以', false],
      ];
      control = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' },
        ...options.map(([tag, label, value]) => btn(label, () => {
          d.fields[f.key] = value;
          render();
        }, {
          primary: (cur ?? null) === value,
          title: tag === 'follow' ? '不写这个键，跟章节的设置走' : label,
          // 三态的第一个按钮用字段本名当锚点（测试/无障碍都能按 `qfield_can_repeat` 找到）
          focus: tag === 'follow' ? `qfield_${f.key}` : `qfield_${f.key}_${tag}`,
        })));
    } else {
      control = el('input', {
        class: 'mcs-input',
        type: f.kind === 'number' ? 'number' : 'text',
        value: cur === null || cur === undefined ? '' : cur,
        placeholder: '默认',
        'data-focus': `qfield_${f.key}`,
        title: f.hint,
        oninput: (e) => {
          const raw = e.target.value;
          d.fields[f.key] = f.kind === 'number'
            ? (raw === '' ? 0 : (Number(raw) || 0))
            : raw;
        },
      });
    }
    items.push(el('div', { class: `mcs-field${dirty ? ' mcs-field-dirty' : ''}` },
      el('div', { class: 'mcs-field-label mcs-field-label-row' },
        el('span', { text: f.label }),
        dirty ? null : el('span', { class: 'mcs-field-def', text: `默认 ${questFieldDefaultText(f.key, cur)}` }),
        dirty ? el('button', {
          class: 'mcs-field-reset',
          type: 'button',
          text: '↩',
          title: `恢复默认（${questFieldDefaultText(f.key, cur)}）`,
          'data-focus': `qfield_${f.key}_reset`,
          onclick: () => {
            // 恢复默认 = 让它变回「等于默认值」，写盘时这个键就会被删掉
            d.fields[f.key] = f.kind === 'tristate' ? null : questFieldDefaultHint(f.key);
            render();
          },
        }) : null),
      control));
  }
  return items;
}

/** 某个任务级字段「恢复默认」时该写什么值（写盘层看到默认值就删键）。 */
function questFieldDefaultHint(key) {
  if (key === 'optional' || key === 'invisible') return false;
  if (key === 'size') return 0;
  return ''; // shape
}

/** 任务级字段默认值的人话。 */
function questFieldDefaultText(key, cur) {
  if (key === 'shape') return '跟随章节';
  if (key === 'size') return '跟随章节';
  if (key === 'optional' || key === 'invisible') return '不勾';
  if (key === 'can_repeat') return '跟随章节';
  return String(questFieldDefault(key) ?? '空');
}

/** 条件/奖励两组里有没有「用户动过」的东西（类型选了、spec 里有值）。 */
function conditionDirty(d) {
  if (d.taskType || d.rewardType) return true;
  return Object.keys(d.taskSpec ?? {}).length > 0 || Object.keys(d.rewardSpec ?? {}).length > 0;
}

/** 任务级字段里有没有「不是默认值」的。 */
function questFieldsDirty(d) {
  if (!d.fields) return false;
  return Object.entries(d.fields).some(([key, value]) => !isQuestFieldDefault(key, value));
}

/**
 * 「全部恢复默认」：把这张卡改的一切都退回默认。
 *
 * ★ 注意语义：条件是**整个不要了**（tasks: []），奖励同理 —— 不是「恢复成物品类型 + 数量 1」。
 *   那正是 2026-11-13 用户拍板要改掉的旧行为。
 */
function resetDraftToDefaults(d) {
  d.taskType = ''; d.rewardType = '';
  d.taskSpec = {}; d.rewardSpec = {};
  d.taskItem = ''; d.taskCount = 1;
  d.rewardItem = ''; d.rewardCount = 1;
  if (d.fields) {
    for (const key of Object.keys(d.fields)) {
      d.fields[key] = key === 'can_repeat' ? null : (key === 'optional' || key === 'invisible' ? false : (key === 'size' ? 0 : ''));
    }
  }
  render();
}

/**
 * 「改名 / 改条件」预览与写入共用同一包字段，免得两边各写一份慢慢走样。
 */
function renamePayload(draft) {
  const payload = {
    dir: state.dir,
    id: state.instanceId,
    questId: draft.questId,
    title: draft.title,
    subtitle: draft.subtitle,
  };
  // 草稿里没带条件/奖励字段（比如没查到详情）时，conditionPayload 返回空对象，
  // 就不会顺手把人家配好的条件清空。物品类型发老四字段，其余类型发 spec（JSON 串）。
  Object.assign(payload, conditionPayload(draft, 'task'), conditionPayload(draft, 'reward'));
  // 简介字段名必须是 desc（不是 description）：改已有任务的后端只认 desc，
  // 发 description 会被整条忽略、点了没反应。草稿没带就不发，免得空串清空简介。
  if (draft.desc !== undefined) payload.desc = draft.desc;
  // 任务级字段（2026-11-13）：只发用户在「任务高级设置」里**动过**的，
  // 没动的一律不发 —— 不发 = 后端不碰那个键，用户原来的设置一个字节都不会丢。
  Object.assign(payload, questFieldPayload(draft));
  return payload;
}

/**
 * 「任务高级设置」那张小卡的草稿字段（2026-11-13 默认值改造）。
 *
 * 口径必须和写盘层一致：**等于默认值就不发**（VS 原则 1）。
 * 界面上「没改」的字段也不发 —— 两层保险，免得「打开改名卡什么都没动再保存」
 * 反而把文件改脏。
 */
function questFieldPayload(draft) {
  const out = {};
  const f = draft.fields;
  if (!f) return out;
  for (const [key, value] of Object.entries(f)) {
    if (value === undefined) continue;
    // 等于默认值 ⇒ 显式发 null 让后端删键（原则 3：Reset 之后保存，键要消失）。
    // 后端拿到 null 就知道「这是要恢复正常」，而不是「用户把值设成了 null」。
    out[key] = isQuestFieldDefault(key, value) ? null : value;
  }
  return out;
}

async function previewRename() {
  const draft = state.draft;
  if (!draft) return;
  await run('renameplan', async () => {
    state.plan = await post('/quest/preview', renamePayload(draft));
  });
}

async function applyRename() {
  const draft = state.draft;
  if (!draft) return;
  await run('renameapply', async () => {
    state.done = await post('/quest/apply', renamePayload(draft));
    state.plan = null;
    state.draft = null;
    await refreshCanvas();
  });
}

/**
 * 「新建任务」的坐标和归属章节：双击空白用草稿里带的坐标，右键新建按被点节点算。
 *
 * ★ 2026-11-13 修：`draft.at` 那条分支以前返回 `chapterId: ''` ——
 *   空白处双击 / 右键新建时章节 ID 是空串，后端 `findChapter(store, '')`
 *   找不到章节 → 报 `ChapterNotFound`，**这个功能从 2026-11-09 加进来就是坏的**。
 *   现在退回「当前页签那一章」。
 * ★ 2026-11-13 方案甲：`draft.at` 现在是用户在放置模式里点出来的位置，
 *   已经不是"写死偏移"了；没有 at 的时候（老路径）才按被点节点算偏移。
 */
function newSpot(draft) {
  if (draft.at) {
    return {
      x: draft.at.x,
      y: draft.at.y,
      // 落点属于「当前正在看的这一章」—— 放置模式只允许在当前章里点
      chapterId: draft.at.chapterId || state.canvasChapterId || '',
    };
  }
  const hit = findNode(draft.questId);
  const chapterId = hit?.chapter?.id ?? state.canvasChapterId ?? '';
  // 左栏「＋新任务」走到这里：没有 at、也没有被点的节点（questId 为空）。
  // 以前直接返回 (2, 1) —— 正好压在章里第一个任务上。
  // 现在落到「本章最下方、避开已有节点」（2026-11-13）。
  if (!hit?.node) {
    const spot = freeSpotIn(chapterId);
    return { x: spot.x, y: spot.y, chapterId };
  }
  return {
    x: (hit.node.x ?? 0) + 2,
    y: (hit.node.y ?? 0) + 1,
    chapterId,
  };
}

/**
 * 在本章里找一个没被占的格子：从「最下面那一行再往下」开始，
 * 依次试 (0, y)、(1, y) …，直到不撞已有节点。
 *
 * 为什么要这一步：新建任务如果不选位置，落到已有节点上就会互相遮挡，
 * 用户得自己拖开 —— 而恰好这些重叠是任务书体检会报 `QuestOverlap` 的那种。
 * 不做启发式排版（那要几天），只保证「别压在别人身上」。
 *
 * @param {string} chapterId
 * @returns {{x:number, y:number}}
 */
function freeSpotIn(chapterId) {
  const chapter = (state.canvas?.chapters ?? []).find((c) => c.id === chapterId);
  const nodes = chapter?.nodes ?? [];
  if (!nodes.length) return { x: 0, y: 0 };
  const taken = new Set(nodes.map((n) => `${Math.round((n.x ?? 0) * 2) / 2},${Math.round((n.y ?? 0) * 2) / 2}`));
  const bottom = Math.max(...nodes.map((n) => n.y ?? 0));
  // 从最下面一行往下试 12 行，每行从 x=0 往右试 24 格 —— 够用了
  for (let row = 1; row <= 12; row += 1) {
    const y = Math.round((bottom + row) * 2) / 2;
    for (let col = 0; col < 24; col += 1) {
      const x = col * 1;
      if (!taken.has(`${x},${y}`)) return { x, y };
    }
  }
  return { x: 0, y: Math.round((bottom + 13) * 2) / 2 };
}

async function previewNew() {
  const draft = state.draft;
  if (!draft) return;
  const spot = newSpot(draft);
  await run('newplan', async () => {
    state.plan = await post('/quest/add/preview', {
      ...newQuestPayload(draft, spot),
    });
  });
}

async function applyNew() {
  const draft = state.draft;
  if (!draft) return;
  const spot = newSpot(draft);
  await run('newapply', async () => {
    state.done = await post('/quest/add/apply', {
      ...newQuestPayload(draft, spot),
    });
    state.plan = null;
    state.draft = null;
    await refreshCanvas();
  });
}

/** 新建任务发给后端的那一包字段：预览和写入必须一模一样，别各写一份。
 *  字段名跟 handleQuestAddPreview / handleQuestAddApply 认的完全对齐。 */
function newQuestPayload(draft, spot) {
  const payload = {
    dir: state.dir,
    id: state.instanceId,
    chapter: spot.chapterId,
    title: draft.title,
    subtitle: draft.subtitle,
    description: draft.description,
    dependsOn: draft.questId ? JSON.stringify([draft.questId]) : '[]',
    x: spot.x,
    y: spot.y,
  };
  // 条件 / 奖励：物品类型发老四个字段，其余类型发一段 spec（JSON 串）。
  Object.assign(payload, conditionPayload(draft, 'task'), conditionPayload(draft, 'reward'));
  return payload;
}

/**
 * 新建章节：预览 / 写入走 /quest/chapter/preview|apply（后端一直有，界面 2026-11-02 才给入口）。
 * 入参 title/group/icon/orderIndex 全可空；返回和任务编辑同一套 plan/done 形状，
 * 所以 planCard/doneCard 不用改，加个 kind 分发就行。
 */
async function previewChapter() {
  const draft = state.draft;
  if (!draft) return;
  await run('chapterplan', async () => {
    state.plan = await post('/quest/chapter/preview', {
      dir: state.dir,
      id: state.instanceId,
      title: draft.title,
      group: draft.group,
      icon: draft.icon,
      orderIndex: draft.orderIndex,
    });
  });
}

async function applyChapter() {
  const draft = state.draft;
  if (!draft) return;
  await run('chapterapply', async () => {
    state.done = await post('/quest/chapter/apply', {
      dir: state.dir,
      id: state.instanceId,
      title: draft.title,
      group: draft.group,
      icon: draft.icon,
      orderIndex: draft.orderIndex,
    });
    state.plan = null;
    state.draft = null;
    await refreshCanvas();
    // 新章节写完直接开它的页签 —— 用户刚建的章，总得让他看见。
    // 切页签会把 done 卡清掉（新页签是干净的），所以切完再把它放回去。
    const saved = state.done;
    const newId = saved?.chapterId;
    if (newId && (state.canvas?.chapters ?? []).some((c) => c.id === newId)) {
      openChapterTab(newId);
      state.done = saved;
      render();
    }
  });
}

/**
 * 装饰图（章节 images）的预览 / 写入。
 *
 * 三种动作走同一对接口（/quest/image/preview|apply），靠 action 分：
 * add 加一张、move 改某一张的坐标或大小、remove 删掉某一张。
 * 和拖动一样，挪位置是「拖完立刻写」，所以界面上 move 这条路只给表单兜底用。
 */
async function previewImage() {
  const draft = state.draft;
  if (!draft) return;
  await run('imageplan', async () => {
    state.plan = await post('/quest/image/preview', imagePayload(draft));
  });
}

async function applyImage() {
  const draft = state.draft;
  if (!draft) return;
  await run('imageapply', async () => {
    state.done = await post('/quest/image/apply', imagePayload(draft));
    state.plan = null;
    state.draft = null;
    await refreshCanvas();
  });
}

/** 草稿 → 接口参数。没填的框传空串（后端把空串当「不改」）。 */
function imagePayload(draft) {
  const payload = {
    dir: state.dir,
    id: state.instanceId,
    chapter: draft.chapterId ?? '',
    action: draft.kind === 'image' ? 'add' : (draft.kind === 'imagedelete' ? 'remove' : 'move'),
  };
  if (draft.kind !== 'image') payload.index = draft.index;
  for (const key of ['image', 'x', 'y', 'width', 'height', 'rotation']) {
    const value = draft[key];
    if (value === '' || value === undefined || value === null) continue;
    payload[key] = value;
  }
  return payload;
}

// --------------------------------------------------------------- 拖动

const CELL_X = 132;
const CELL_Y = 108;
const BOX_W = 116;
const BOX_H = 92;
/** 缩放上下限。太小看不清、太大一点内容就撑满屏，两头都没意义。 */
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

function snap(value) {
  return Math.round(Number(value) * 2) / 2;
}

/**
 * 拖动时画「对齐参考线」：被拖的这个任务跟同一章里其它任务比 x / y，
 * 差不到 0.25 格，就把对应的竖线 / 横线亮出来 —— 告诉你松手就跟它对齐了。
 *
 * 纯视觉，四个「绝不」：不 render() 整页重画（会换掉正在被拖的 DOM，
 * pointermove 就收不到了）、不改 state 里的坐标、不写盘、不进撤销栈。
 * 落点仍然由 onUp 的 snap + commitMoves 决定，一行都不碰。
 *
 * gdx / gdy 是「按格子算的位移」，公式跟 onUp 落点完全一致：
 * 屏幕像素 ÷ (CELL_X/Y × scale)。参考线画在 viewport 的 px/py 未缩放坐标系里，
 * 平移缩放交给 viewport 那层的 transform，不用把 clientX 直接当 SVG 的 x。
 */
function updateDragGuides(node, gdx, gdy) {
  const guides = state.guideEls;
  const geom = state.canvasGeom;
  if (!guides || !geom) return;

  // 只比当前页签这一章里、看得见的任务（跟 canvasSvg 的过滤口径一致）；
  // 多选拖动时以「指针下那个节点」为基准，node 就是它。
  const others = [];
  for (const chapter of state.canvas?.chapters ?? []) {
    if (chapter.id !== state.canvasChapterId) continue;
    for (const n of chapter.nodes ?? []) if (n.id !== node.id) others.push(n);
  }

  const nx = (node.x ?? 0) + gdx;
  const ny = (node.y ?? 0) + gdy;
  const THRESHOLD = 0.25;
  // 在阈值里各挑最接近的一条 x / 一条 y；同时记下这一章的范围，好把线画得够长
  let bestDx = THRESHOLD + 1;
  let bestDy = THRESHOLD + 1;
  let alignX = null;
  let alignY = null;
  let minX = nx;
  let maxX = nx;
  let minY = ny;
  let maxY = ny;
  for (const n of others) {
    const ox = n.x ?? 0;
    const oy = n.y ?? 0;
    const ddx = Math.abs(nx - ox);
    if (ddx <= THRESHOLD && ddx < bestDx) { bestDx = ddx; alignX = ox; }
    const ddy = Math.abs(ny - oy);
    if (ddy <= THRESHOLD && ddy < bestDy) { bestDy = ddy; alignY = oy; }
    minX = Math.min(minX, ox); maxX = Math.max(maxX, ox);
    minY = Math.min(minY, oy); maxY = Math.max(maxY, oy);
  }

  const px = (x) => (x - geom.minX) * CELL_X + geom.pad;
  const py = (y) => (y - geom.minY) * CELL_Y + geom.pad;
  if (alignX !== null) {
    const x = px(alignX);
    guides.v.setAttribute('x1', String(x));
    guides.v.setAttribute('x2', String(x));
    guides.v.setAttribute('y1', String(py(minY) - 32));
    guides.v.setAttribute('y2', String(py(maxY) + BOX_H + 32));
    guides.v.setAttribute('style', 'display:block');
  } else guides.v.setAttribute('style', 'display:none');
  if (alignY !== null) {
    const y = py(alignY);
    guides.h.setAttribute('x1', String(px(minX) - 32));
    guides.h.setAttribute('x2', String(px(maxX) + BOX_W + 32));
    guides.h.setAttribute('y1', String(y));
    guides.h.setAttribute('y2', String(y));
    guides.h.setAttribute('style', 'display:block');
  } else guides.h.setAttribute('style', 'display:none');
}

/** 松手时把参考线收起来（只改属性，不重画整页）。 */
function hideDragGuides() {
  const guides = state.guideEls;
  if (!guides) return;
  guides.v.setAttribute('style', 'display:none');
  guides.h.setAttribute('style', 'display:none');
}

/**
 * 拖一个节点：拖动时只动 DOM，松手就直接落位。
 *
 * UE 蓝图的规矩是「拖完就是拖完了」——没有第二个确认框。这里照做：
 * 松手立刻 POST /quest/move/apply（后端会留备份、写完体检、有问题整体回滚），
 * 想反悔就 Ctrl+Z 或者点底部那行的「撤销」。
 *
 * 多选之后拖任意一个，会带着一起动，一次请求写完。
 */
function beginDrag(event, node, group) {
  if (event.button !== 0) return;
  if (typeof document.addEventListener !== 'function') return;
  event.preventDefault?.();
  event.stopPropagation?.();

  // 上一次拖动留下的「吞掉 click」标记先清掉（正常点击时要用）
  state.suppressClick = false;

  // 拖一个没被选中的：先把选择换成它（UE 也是这样，拖动会顺手选中）
  if (!state.selSet.includes(node.id)) {
    state.selSet = [node.id];
    state.sel = node.id;
  }
  const ids = state.selSet.length ? state.selSet.slice() : [node.id];
  const targets = ids.map((id) => findNode(id)).filter(Boolean);
  if (!targets.length) targets.push({ node });
  const groups = ids.map((id) => state.nodeEls[id]).filter(Boolean);

  const startX = event.clientX ?? 0;
  const startY = event.clientY ?? 0;
  let moved = false;

  const onMove = (e) => {
    const dx = (e.clientX ?? 0) - startX;
    const dy = (e.clientY ?? 0) - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
    for (const g of groups) g.setAttribute('transform', `translate(${dx} ${dy})`);
    // 线跟着一起动（dx/dy 是屏幕像素，画布上还没缩放，所以除一下）
    const scale = state.view.scale || 1;
    shiftEdges(ids, dx / scale, dy / scale);
    // 拖动中亮对齐参考线（纯视觉，绝不 render()；gdx/gdy 与松手落点公式一致）
    updateDragGuides(node, dx / (CELL_X * scale), dy / (CELL_Y * scale));
  };
  const onUp = (e) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    for (const g of groups) g.removeAttribute('transform');
    shiftEdges(ids, 0, 0);
    hideDragGuides();
    if (!moved) return;
    // 拖完浏览器还会补一个 click（按下和松开在同一个节点上），
    // 那个 click 会把多选收成单选 —— 吞掉它，多选才能留住。
    state.suppressClick = true;
    const scale = state.view.scale || 1;
    const dx = ((e.clientX ?? 0) - startX) / (CELL_X * scale);
    const dy = ((e.clientY ?? 0) - startY) / (CELL_Y * scale);
    const moves = [];
    for (const t of targets) {
      const nx = snap((t.node.x ?? 0) + dx);
      const ny = snap((t.node.y ?? 0) + dy);
      if (nx === t.node.x && ny === t.node.y) continue;
      moves.push({ questId: t.node.id, x: nx, y: ny });
    }
    if (moves.length) void commitMoves(moves);
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/**
 * 拖一张装饰图（章节背景图 / 说明图）。
 *
 * 和拖任务一个规矩：拖动时只动 DOM，松手立刻写盘，想反悔 Ctrl+Z 也退不了
 * （装饰图的坐标改动不进撤销栈 —— 它不在 moves 那套结构里，撤销栈只认任务）。
 * 所以这里额外做一件事：**写之前先问用户要不要写**——不，不做确认框，
 * 靠「松手位置有明显变化才写」来避免误触（阈值 4 像素，和节点拖动一致）。
 *
 * 换算和节点拖动完全一样：屏幕位移 ÷（CELL_X/Y × scale）→ 吸附半格。
 */
function beginImageDrag(event, ctx) {
  if (event.button !== 0) return;
  if (typeof document.addEventListener !== 'function') return;
  event.preventDefault?.();
  event.stopPropagation?.();

  const { image, index, el: node } = ctx;
  // 图片可能带旋转 transform（底稿），拖动要叠在它上面、松手还原成底稿，
  // 不能像以前那样 removeAttribute 一删了之 —— 那会把旋转永久弄丢。
  const baseTransform = ctx.baseTransform || '';
  const startX = event.clientX ?? 0;
  const startY = event.clientY ?? 0;
  let moved = false;

  const onMove = (e) => {
    const dx = (e.clientX ?? 0) - startX;
    const dy = (e.clientY ?? 0) - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
    node.setAttribute('transform', `translate(${dx} ${dy}) ${baseTransform}`.trim());
  };

  const onUp = (e) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (baseTransform) node.setAttribute('transform', baseTransform);
    else node.removeAttribute('transform');
    if (!moved) return;
    const scale = state.view.scale || 1;
    const nx = snap((image.x ?? 0) + ((e.clientX ?? 0) - startX) / (CELL_X * scale));
    const ny = snap((image.y ?? 0) + ((e.clientY ?? 0) - startY) / (CELL_Y * scale));
    if (nx === image.x && ny === image.y) return;
    void commitImageMove({ index, image, x: nx, y: ny });
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/** 把装饰图的新坐标写下去。先把本地坐标改掉（立刻落位），失败再拉回真相。 */
async function commitImageMove({ index, image, x, y }) {
  image.x = x;
  image.y = y;
  await run('imagemove', async () => {
    const res = await post('/quest/image/apply', {
      dir: state.dir,
      id: state.instanceId,
      chapter: state.canvasChapterId,
      action: 'move',
      index,
      x,
      y,
    });
    state.flash = res.changedCount ? `已挪动装饰图：(${x}, ${y})` : '位置没变';
    await refreshCanvas();
  });
}

/**
 * 把坐标写下去。先把本地坐标改掉（视觉上立刻落位），接口失败再拉回真相。
 */
async function commitMoves(moves) {
  for (const m of moves) {
    const hit = findNode(m.questId);
    if (hit) {
      hit.node.x = m.x;
      hit.node.y = m.y;
    }
  }
  await run('move', async () => {
    const res = await post('/quest/move/apply', {
      dir: state.dir,
      id: state.instanceId,
      moves: JSON.stringify(moves),
    });
    pushUndo(res);
    const n = res.moves?.length ?? moves.length;
    state.flash = `已挪动 ${n} 个任务`;
    await refreshCanvas();
  });
}

/** 记一笔「怎么退回去」：后端返回的 from 就是原坐标。 */
function pushUndo(res) {
  const back = (res.moves ?? []).map((m) => ({ questId: m.questId, x: m.from?.x ?? 0, y: m.from?.y ?? 0 }));
  if (!back.length) return;
  const label = (res.moves ?? []).map((m) => m.title || m.questId).slice(0, 3).join('、');
  state.undo.push({ label, moves: back });
  if (state.undo.length > 30) state.undo.shift();
  state.redo = [];
}

async function undoMove() {
  const entry = state.undo.pop();
  if (!entry) return;
  await run('undo', async () => {
    const res = await post('/quest/move/apply', {
      dir: state.dir,
      id: state.instanceId,
      moves: JSON.stringify(entry.moves),
    });
    const back = (res.moves ?? []).map((m) => ({ questId: m.questId, x: m.from?.x ?? 0, y: m.from?.y ?? 0 }));
    if (back.length) state.redo.push({ label: entry.label, moves: back });
    state.flash = `已撤销：${entry.label}`;
    await refreshCanvas();
  });
}

async function redoMove() {
  const entry = state.redo.pop();
  if (!entry) return;
  await run('redo', async () => {
    const res = await post('/quest/move/apply', {
      dir: state.dir,
      id: state.instanceId,
      moves: JSON.stringify(entry.moves),
    });
    const back = (res.moves ?? []).map((m) => ({ questId: m.questId, x: m.from?.x ?? 0, y: m.from?.y ?? 0 }));
    if (back.length) state.undo.push({ label: entry.label, moves: back });
    state.flash = `已重做：${entry.label}`;
    await refreshCanvas();
  });
}

// --------------------------------------------------------------- 浮层：点外面就关

/**
 * 现在展开着的浮层元素（顶部菜单的弹出层、画布上的右键菜单）。
 *
 * 为什么单独记一份，而不是每次都靠 render() 重画：
 * 「点空白处关掉浮层」有个硬约束 —— 关的时候**不能整页重画**。
 * 一旦 render() 把整个界面重建，正在被点的那个节点就被换掉了，
 * 用户的这一次点击落在旧元素上（点节点选不中、拖节点拖到看不见的东西上）。
 * 所以这里改成「只把浮层那一块从 DOM 里摘掉」，界面其余部分一动不动。
 */
let openMenuEl = null; // 顶部菜单的弹出层（.mcs-menu-pop）
let openMenuBtn = null; // 顶部菜单的标题按钮（用来去掉高亮）
let openCtxEl = null; // 画布上的右键菜单（.mcs-menu）
// 画布容器只留模块级引用：state 会被打印 / 序列化，塞 DOM 节点进去会循环引用。
// 拖物品 / 粘贴任务时要按鼠标位置换算画布坐标，得知道容器在哪。
let canvasHostEl = null;

/**
 * 浮层的 class。判断「这个点是不是点在浮层内部」全靠它们。
 * 注意 mcs-menu-item / mcs-menu-btn 不是浮层本体，是浮层里的零件。
 */
const POPUP_CLASSES = ['mcs-menu-wrap', 'mcs-menu-pop', 'mcs-menu'];
const POPUP_CLASS_RE = POPUP_CLASSES.map((name) => new RegExp(`(^|\\s)${name}(\\s|$)`));

/**
 * 这个点在不在某个浮层里面？
 *
 * 不用 closest / contains：closest 只认现在还挂在文档里的祖先，
 * 而我们这个界面是「点一下就整棵重画」的，节点随时可能被换掉。
 * 自己顺着父链走一遍，哪种 DOM 都行（真 DOM 走 parentElement，替身走 parentNode）。
 */
function insidePopup(node) {
  let cur = node;
  for (let depth = 0; cur && depth < 40; depth += 1) {
    const cls = String(cur.className ?? '');
    for (const re of POPUP_CLASS_RE) {
      if (re.test(cls)) return true;
    }
    cur = cur.parentElement ?? cur.parentNode ?? null;
  }
  return false;
}

/** 收起顶部菜单（不重画界面，只把那一块摘掉）。 */
function closeTopMenu() {
  state.menuOpen = '';
  openMenuEl?.remove?.();
  openMenuEl = null;
  if (openMenuBtn) {
    openMenuBtn.className = String(openMenuBtn.className ?? '')
      .replace(/(^|\s)mcs-menu-btn-on(\s|$)/, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    openMenuBtn = null;
  }
}

/** 收起画布上的右键菜单 / 搜物品浮层（只摘浮层，不整页重画）。 */
function closeCtxMenu() {
  state.menu = null;
  state.imageMenu = null;
  state.itemPicker = null;
  openCtxEl?.remove?.();
  openCtxEl = null;
}

/** 把现在展开着的浮层都收起来。返回「有没有收掉东西」。 */
function dismissPopups() {
  let changed = false;
  if (state.menuOpen) {
    closeTopMenu();
    changed = true;
  }
  if (state.menu || state.imageMenu || state.itemPicker) {
    closeCtxMenu();
    changed = true;
  }
  return changed;
}

/**
 * 点在浮层外面 → 收起来（VSCode 就是这个规矩）。
 *
 * 右键也算：用户原话是「左键/右键点击空白处都要关掉」。
 */
function onPointerDownOutside(event) {
  const target = event?.target ?? null;
  if (!target) return;
  if (insidePopup(target)) return;
  dismissPopups();
}

/** 键盘：Ctrl+Z 撤销、Ctrl+Shift+Z / Ctrl+Y 重做、Ctrl+C/Ctrl+V 复制任务、Esc 关菜单。 */
/**
 * 记下「用户最后点的是哪一块」，给快捷键判断作用域用。
 *
 * 为什么不能只看 document.activeElement：点画布空白（或 svg / div 这种不可聚焦的元素）时
 * 焦点会落到 body 上，这时按 Ctrl+C 到底该复制任务、还是复制文字，
 * 只能靠「上一次点击落在哪个区块」来判断。用户明确要求：
 * 在画布上（中栏，不含下侧报错栏）操作任务节点；选中文字后无论在哪一栏都复制文字。
 *
 * @param {Element} node 挂载的容器
 * @param {'canvas'|'other'} scope 这一块属于哪个作用域
 */
function bindKeyScope(node, scope) {
  node.addEventListener('pointerdown', () => { state.keyScope = scope; }, true);
  // 点击（不只是按下）也要记：键盘用户用 Tab + Enter 进来时没有 pointerdown
  node.addEventListener('focusin', () => { state.keyScope = scope; }, true);
}

/**
 * 焦点现在在哪儿？用来决定快捷键的**作用域**（2026-11-12 用户点名）。
 *
 * 用户原话：「这些快捷键在不同位置的生效效果要有区别，在画布上（中栏不包括下侧报错栏）
 * 是对任务节点的复制粘贴撤销重做，选中文字后（不论是在中栏，侧栏，报错栏），
 * 是对文字进行复制粘贴」。
 *
 * 所以分成三档：
 *   `field`   —— 输入框 / 文本域 / 可编辑区域里。所有快捷键都让给浏览器（打字、复制文字）。
 *   `canvas`  —— 画布本体（中栏**不含**诊断面板 / 报错栏）。Ctrl+C/V/Z/Y 操作任务节点。
 *   `other`   —— 侧栏、报错栏、按钮上等其它地方。Ctrl+C/V 走浏览器的「复制选中的文字」，
 *                撤销重做也不抢（那里没有可撤销的任务操作）。
 *
 * 识别画布的办法：从 document.activeElement 顺父链找有没有 `mcs-canvas`。
 * 光判「焦点在不在输入框」不够 —— 用户点完侧栏再点画布空白处，焦点会落在 body 上，
 * 那时按 Ctrl+C 到底该复制任务还是复制文字，只能靠「最后点的那一块」判断。
 * 所以画布在 pointerdown 时会记一个 `state.keyScope = 'canvas'`，
 * 点侧栏 / 点诊断面板会记成别的（见 bindKeyScope）。
 */
function keyScopeOf() {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  // 1. 在输入框里：无论如何都让给浏览器
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
    || active.isContentEditable === true
    || active.dataset?.focus || active.attrs?.['data-focus'])) {
    return 'field';
  }
  // 2. 焦点元素本身在画布里（不是输入框）→ 画布作用域
  if (active && typeof active.closest === 'function' && active.closest('.mcs-canvas')) return 'canvas';
  // 2b. DOM 替身没有 closest：顺父链自己走
  if (active && active.tagName) {
    for (let n = active; n; n = n.parentNode) {
      if (String(n.className ?? '').split(/\s+/).includes('mcs-canvas')) return 'canvas';
    }
  }
  // 3. 没有焦点元素（点过画布空白后焦点会落到 body）→ 看最后点的是哪一块
  if (!active || active === (typeof document !== 'undefined' ? document.body : null)) {
    return state.keyScope === 'canvas' ? 'canvas' : 'other';
  }
  // 4. 焦点在别处（侧栏按钮 / 报错栏等）
  return 'other';
}

/**
 * 用户选中了文字吗？
 *
 * 「选中文字后（不论是在中栏，侧栏，报错栏），是对文字进行复制粘贴」——
 * 所以只要能拿到一段非空选区，Ctrl+C 就必须交给浏览器，不能拿去复制任务节点。
 *
 * 两个环境的差异都要兜住：
 *   - 浏览器：`window.getSelection()` / 输入框里的 selectionStart≠selectionEnd
 *   - DOM 替身：没有 getSelection，那 `state.selectedText` 由测试显式置位
 */
function hasTextSelection() {
  if (state.selectedText) return true;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    const start = Number(active.selectionStart ?? 0);
    const end = Number(active.selectionEnd ?? 0);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) return true;
  }
  try {
    if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && String(sel.toString() ?? '').trim()) return true;
    }
  } catch {
    /* 拿不到就算了，按「没选中」处理 */
  }
  return false;
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    // 预览窗口开着时，Esc 先关它（最上面那一层）。
    if (state.previewQuest?.questId) {
      closeQuestPreview();
      return;
    }
    if (state.menu || state.imageMenu || state.menuOpen || state.itemPicker) {
      state.menu = null;
      state.imageMenu = null;
      state.menuOpen = '';
      state.itemPicker = null;
      render();
    }
    // 放置模式（2026-11-13）：Esc 取消落点选择。
    // 注意顺序 —— 放在处理浮层之后：浮层优先级更高（用户眼里最上面那层）。
    if (state.placing) cancelPlacing();
    return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = String(event.key ?? '').toLowerCase();

  // Ctrl+S = 提交当前草稿（2026-11-11 用户点名）。
  //
  // 放在 `panel !== 'quests'` 那道门**之前**：草稿只可能在任务书页出现，
  // 但浏览器在别的页面按 Ctrl+S 也会弹「另存为网页」，所以这里要先抢下来
  // 再判有没有草稿。没草稿也拦（不弹浏览器的另存为对话框，也不做任何事）。
  if (key === 's') {
    event.preventDefault?.();
    void saveDraftByShortcut();
    return;
  }

  // 复制 / 粘贴 / 撤销 / 重做的作用域判断（2026-11-12）。
  //
  // 老逻辑是「焦点不在输入框 + 在任务书页」就抢，问题在于：用户在侧栏里
  // 选中一段任务描述想复制，焦点可能不在输入框上（选中文字不改变焦点），
  // Ctrl+C 就被抢去复制任务节点了 —— 用户要的是「选中文字就复制文字」。
  const scope = keyScopeOf();
  // 1. 输入框里：全部让给浏览器（打字、复制粘贴文字、撤销打字）
  if (scope === 'field') return;
  // 2. 选中了文字（任何一栏）：复制 / 粘贴交给浏览器，不碰任务节点
  if (hasTextSelection()) return;
  // 3. 不在画布上（侧栏 / 报错栏 / 别的工具页）：一律不抢
  if (scope !== 'canvas') return;
  if (state.panel !== 'quests') return;

  if (key === 'c') {
    event.preventDefault?.();
    copyQuestSelection();
    return;
  }
  if (key === 'v') {
    event.preventDefault?.();
    void pasteQuestSelection();
    return;
  }
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault?.();
    void undoMove();
  } else if ((key === 'z' && event.shiftKey) || key === 'y') {
    event.preventDefault?.();
    void redoMove();
  }
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', onKeyDown);
  // 点空白处收起浮层（顶部菜单 / 右键菜单）。左键右键都算。
  document.addEventListener('pointerdown', onPointerDownOutside, true);
}

// --------------------------------------------------------------- 选项目页

/** 忘掉一个「上次打开过」的目录：只动软件自己记的小本本，不碰用户任何文件。 */
async function forgetRoot(dir) {
  if (!dir) return;
  await run('forget', async () => {
    // 删的是后端给的「原始记住值」（rememberedDir），不是展开/下钻后的展示路径 ——
    // 拿展示路径去删会返回成功却什么都没删掉（2026-11-04 第 3 批修）。
    await post('/roots/remove', { dir });
    await loadInstancesAll();
  });
}

function pickScreen() {
  // 两层：外层 .mcs-pick 铺满整窗、负责滚动；内层 .mcs-pick-inner 居中限宽。
  // 合成一层的话，滚动条会挂在 980px 居中框自己的右边缘 —— 看起来就是
  // 「界面中间偏右冒出一条滚动条」，右边还空一大片。
  const box = el('div', { class: 'mcs-pick' });
  const inner = el('div', { class: 'mcs-pick-inner' });
  box.append(inner);
  inner.append(
    el('div', { class: 'mcs-pick-hero' },
      el('h1', { class: 'mcs-pick-h1', text: '整合包工作室' }),
      el('p', { class: 'mcs-pick-lead', text: '先挑一个整合包。选定之后直接进工作台，顺手体检。' }),
    ),
  );

  const list = el('div', { class: 'mcs-pick-list' });
  const roots = state.roots ?? [];
  if (roots.length === 0) {
    list.append(el('div', { class: 'mcs-empty', text: '正在找常见位置…' }));
  }
  for (const root of roots) {
    const instances = state.instancesByRoot?.[root.dir] ?? [];
    const group = el('div', { class: 'mcs-pick-group' });
    const head = el('div', { class: 'mcs-pick-root' }, el('span', { text: `${root.label ?? ''} · ${root.dir}` }));
    // 只有「上次打开过」的目录才给 ✕：自动探测出来的常见位置不是用户记的，不该让人删。
    // 按钮挂在组头的 div 里，不是实例行（那是个 button），免得嵌套按钮 + 冒泡连错包。
    if (root.remembered) {
      head.append(btn('✕ 忘掉这个目录', (e) => { e?.stopPropagation?.(); void forgetRoot(root.rememberedDir ?? root.dir); }, { danger: true, disabled: Boolean(state.busy), title: '只从软件的「上次打开过」列表里移除，不会删除你的文件' }));
    }
    group.append(head);
    if (instances.length === 0) {
      group.append(el('div', { class: 'mcs-muted', text: '这里没有找到实例' }));
    }
    for (const inst of instances) {
      group.append(
        el(
          'button',
          {
            class: 'mcs-pick-item',
            onclick: () => connect(root.dir, inst.id),
            disabled: state.busy === 'connect',
          },
          el('span', { class: 'mcs-pick-name', text: inst.id }),
          el('span', { class: 'mcs-pick-meta', text: `${inst.mcVersion ?? '?'} · ${inst.loader ?? '?'}` }),
        ),
      );
    }
    list.append(group);
  }
  box.append(list);

  const input = el('input', {
    class: 'mcs-input',
    placeholder: '也可以直接填整合包目录（versions/<实例名> 或含 mods/ 的目录）',
    value: state.dir,
    'data-focus': 'dir',
    oninput: (e) => {
      state.dir = e.target.value;
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && state.dir.trim()) void connect(state.dir, '');
    },
  });
  inner.append(
    card(
      '没找到你的包？',
      el('div', { class: 'mcs-muted', text: '点「浏览…」选整合包文件夹（比如 PCL 的「整合包」目录），选过一次以后每次启动都在列表里。' }),
      row(
        btn(state.busy === 'browse' ? '等选择窗口…' : '浏览…', () => void browseForPack(), {
          disabled: state.busy === 'browse',
        }),
      ),
      input,
      row(btn(state.busy === 'connect' ? '正在读…' : '打开这个包', () => connect(state.dir, ''), {
        primary: true,
        disabled: state.busy === 'connect' || !state.dir.trim(),
      })),
    ),
  );

  inner.append(deepScanCard());
  inner.append(packCreateCard());
  inner.append(scaffoldCard());
  return box;
}

// --------------------------------------------------------------- 深度搜索

/**
 * 「只记得大概位置」时用：选一个大目录，让工作室自己往下翻。
 *
 * 用户 2026-11-02 的原话是「用户选一个大概的位置，然后自动往里面深度搜索」。
 * 所以这里跟上面那张卡的分工是：
 * - 上面：你知道包在哪 → 选到包本身，直接记住；
 * - 这张：你只知道大概在 D 盘某处 → 让我们翻，翻到再挑。
 *
 * 挖的过程有刹车（层数 / 目录数 / 毫秒），扫整个盘也不会把界面卡死；
 * 停下来时会如实说「没翻完」，而不是假装找全了。
 */
function deepScanCard() {
  const sc = state.scan;
  const result = sc.result;
  const hits = result?.roots ?? [];

  if (!sc.open) {
    return card(
      '不记得包放哪了？让工作室自己翻',
      el('div', {
        class: 'mcs-muted',
        text: '选一个大概的目录（整个 D 盘、下载文件夹、PCL 所在的那个文件夹都行），工作室会自己往下翻几层，把找到的整合包列出来。只是看，不改任何东西。',
      }),
      row(btn('选个大目录翻一翻', () => { sc.open = true; render(); })),
    );
  }

  const box = el('div', { class: 'mcs-card' });
  box.append(el('div', { class: 'mcs-card-t', text: '深度搜索：从一个大目录里找整合包' }));

  box.append(
    el('div', { class: 'mcs-field' },
      el('span', { class: 'mcs-field-k', text: '从哪个目录往下翻' }),
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder: '如 D:\\ 或 D:\\pcl2 或 D:\\下载',
        value: sc.dir,
        'data-focus': 'scandir',
        oninput: (e) => {
          sc.dir = e.target.value;
          sc.result = null;
          sc.error = '';
        },
      }),
    ),
  );

  box.append(
    row(
      btn(state.busy === 'scan' ? '正在翻…' : '开始翻', () => void deepScanAt(sc.dir), {
        primary: true,
        disabled: Boolean(state.busy) || !sc.dir.trim(),
      }),
      btn('选个目录…', () => void browseForScan(), { disabled: Boolean(state.busy) }),
      btn('收起', () => {
        sc.open = false;
        sc.result = null;
        sc.error = '';
        render();
      }),
    ),
  );

  if (sc.error) box.append(el('div', { class: 'mcs-err', text: sc.error }));

  if (result) {
    const stoppedText = result.stopped === 'time'
      ? `翻到 ${((result.ms ?? 0) / 1000).toFixed(1)} 秒就停了（目录太多，没翻完）`
      : result.stopped === 'count'
        ? `翻到 ${result.visited} 个目录就停了（够多了，没翻完）`
        : `翻完了：看了 ${result.visited} 个目录，最深 ${result.depth} 层`;

    if (hits.length === 0) {
      box.append(el('div', { class: 'mcs-muted', text: `${stoppedText}，没找到整合包。换个更靠近它的目录（比如它所在的那个盘或文件夹）再翻一次。` }));
    } else {
      // 翻到的一处可能是「一个包」，也可能是「一个装着好几个包的目录」
      // （PCL 的 versions/ 就是这样）。所以这里不再一行一处，而是**一行一个包**：
      // 用户能直接看见包名，点「打开」也不会再撞上「需要指定 instanceId」。
      const rows = [];
      for (const hit of hits) {
        const list = Array.isArray(hit.list) && hit.list.length > 0 ? hit.list : null;
        if (list) {
          for (const inst of list) {
            rows.push({ dir: hit.dir, id: inst.id, mcVersion: inst.mcVersion, loader: inst.loader, modsCount: inst.modsCount });
          }
        } else {
          // 老后端 / 兜底：只知道这一处有几个实例，没有名字
          rows.push({ dir: hit.dir, id: '', mcVersion: '', loader: '', modsCount: null });
        }
      }

      box.append(el('div', { class: 'mcs-muted', text: `${stoppedText}，找到 ${rows.length} 个包（分布在 ${hits.length} 处）：` }));
      const listBox = el('div', { class: 'mcs-scanlist' });
      for (const r of rows) {
        const meta = [r.mcVersion, r.loader, r.modsCount === null ? '' : `${r.modsCount} 个 mod`]
          .filter(Boolean)
          .join(' · ');
        listBox.append(
          el('div', { class: 'mcs-scanhit' },
            el('span', { class: 'mcs-scanhit-dir', title: r.dir, text: r.id || r.dir }),
            meta ? el('span', { class: 'mcs-scanhit-n', text: meta }) : null,
            btn('打开', () => connect(r.dir, r.id), { disabled: Boolean(state.busy) }),
          ),
        );
        if (r.id) {
          listBox.append(el('div', { class: 'mcs-scanhit-sub', title: r.dir, text: r.dir }));
        }
      }
      box.append(listBox);
      box.append(
        el('div', { class: 'mcs-muted', text: '「收进列表」会把上面这些目录记住，下次启动直接在首屏出现；「打开」只是这一次进去看看。' }),
      );
      box.append(
        row(
          btn(`全部收进列表（${hits.length} 处）`, () => void rememberScanHits(), {
            primary: true,
            disabled: Boolean(state.busy),
          }),
        ),
      );
    }
  }

  return box;
}

// --------------------------------------------------------------- 从零装底座

const MC_VERSIONS = ['1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1'];
const LOADERS = [
  { key: 'neoforge', name: 'NeoForge', hint: '1.20.2 以后的新选择，1.21.1 主流' },
  { key: 'forge', name: 'Forge', hint: '1.20.1 及更早的经典选择' },
];

/** 选项目页最下面那张「从零装底座」卡：默认收起，点开才是表单。 */
function scaffoldCard() {
  const sc = state.scaffold;
  if (!sc.open) {
    return card(
      '没有现成的包？从零装一个',
      el('div', { class: 'mcs-muted', text: '选一个游戏版本和加载器，工作室会联网把游戏本体、资源文件、加载器依赖全下下来，装成一个能直接启动的实例。' }),
      el('div', { class: 'mcs-muted', text: '这一步会下载几百 MB，网速正常要几分钟。装一次之后本机就有这个版本的底座了，以后再建包就直接抄它。' }),
      row(btn('从零装一个', () => { sc.open = true; render(); })),
    );
  }

  const box = el('div', { class: 'mcs-card' });
  box.append(el('div', { class: 'mcs-card-t', text: '从零装底座' }));

  box.append(
    el('div', { class: 'mcs-field' },
      el('span', { class: 'mcs-field-k', text: '装到哪个 Minecraft 根目录' }),
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder: '如 D:\\Minecraft（里面要有 versions/ 和 libraries/）',
        value: sc.mcRoot,
        'data-focus': 'scr',
        oninput: (e) => { sc.mcRoot = e.target.value; sc.plan = null; sc.applied = null; render(); },
      }),
    ),
  );

  box.append(
    el('div', { class: 'mcs-field' },
      el('span', { class: 'mcs-field-k', text: '新包叫什么' }),
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder: '如 MyCreatePack（英文，不要空格）',
        value: sc.name,
        'data-focus': 'scn',
        oninput: (e) => { sc.name = e.target.value; sc.plan = null; sc.applied = null; render(); },
      }),
    ),
  );

  // 版本
  const vseg = el('div', { class: 'mcs-seg mcs-seg-wrap' });
  for (const v of MC_VERSIONS) {
    vseg.append(
      el('div', {
        class: `mcs-seg-item mcs-seg-item-sm${sc.mcVersion === v ? ' mcs-seg-on' : ''}`,
        onclick: () => { sc.mcVersion = v; sc.plan = null; sc.applied = null; render(); },
      }, el('div', { class: 'mcs-seg-name', text: v })),
    );
  }
  box.append(el('div', { class: 'mcs-field-k', text: '游戏版本' }), vseg);

  // 加载器
  const lseg = el('div', { class: 'mcs-seg' });
  for (const l of LOADERS) {
    lseg.append(
      el('div', {
        class: `mcs-seg-item${sc.loader === l.key ? ' mcs-seg-on' : ''}`,
        onclick: () => { sc.loader = l.key; sc.plan = null; sc.applied = null; render(); },
      },
      el('div', { class: 'mcs-seg-name', text: l.name }),
      el('div', { class: 'mcs-seg-blurb', text: l.hint }),
      ),
    );
  }
  box.append(el('div', { class: 'mcs-field-k', text: '加载器（装 mod 要靠它，装好就不能换了）' }), lseg);

  box.append(
    el('div', { class: 'mcs-field' },
      el('span', { class: 'mcs-field-k', text: '加载器版本（留空自动挑最新）' }),
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder: '如 21.1.228',
        value: sc.loaderVersion,
        'data-focus': 'scl',
        oninput: (e) => { sc.loaderVersion = e.target.value; sc.plan = null; sc.applied = null; render(); },
      }),
    ),
  );

  box.append(
    el('div', { class: 'mcs-field' },
      el('span', { class: 'mcs-field-k', text: '用哪个 Java（留空自动找）' }),
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder: '如 C:\\Java\\jdk21\\bin\\java.exe',
        value: sc.javaPath,
        'data-focus': 'scj',
        oninput: (e) => { sc.javaPath = e.target.value; sc.plan = null; sc.applied = null; render(); },
      }),
    ),
  );

  box.append(row(
    btn(state.busy === 'scplan' ? '正在查…' : '先算要下多少', () => scaffoldPreview(), {
      primary: true,
      disabled: state.busy === 'scplan' || !sc.mcRoot.trim() || !sc.name.trim(),
    }),
    btn('收起', () => { sc.open = false; render(); }),
  ));
  if (!sc.mcRoot.trim() || !sc.name.trim()) {
    box.append(el('div', { class: 'mcs-muted', text: '上面两格都得填：装到哪、叫什么。' }));
  }

  if (sc.plan) box.append(scaffoldPlanCard());
  if (sc.applied) box.append(scaffoldDoneCard());
  // 装底座的进度条：这是最慢的一条（几百 MB），所以只要在跑就一直显示
  const installing = progressSlot('scaffold');
  if (installing) box.append(installing);
  return box;
}

/** 算装底座计划（会联网查清单，但不写盘）。 */
async function scaffoldPreview() {
  const sc = state.scaffold;
  await run('scplan', async () => {
    sc.plan = await post('/scaffold/preview', {
      mcRoot: sc.mcRoot,
      name: sc.name,
      mcVersion: sc.mcVersion,
      loader: sc.loader,
      loaderVersion: sc.loaderVersion,
      javaPath: sc.javaPath,
    });
    sc.applied = null;
  });
}

/** 真装。 */
async function scaffoldApply() {
  const sc = state.scaffold;
  // 装底座是这里最慢的一件事：几百 MB、好几分钟。所以进度条是必须的。
  watchKind('scaffold');
  await runWithProgress('scapply', async () => {
    const body = await post('/scaffold/apply', {
      mcRoot: sc.mcRoot,
      name: sc.name,
      mcVersion: sc.mcVersion,
      loader: sc.loader,
      loaderVersion: sc.loaderVersion,
      javaPath: sc.javaPath,
    });
    sc.applied = body;
    sc.plan = null;
    return body;
  });
}

function scaffoldPlanCard() {
  const p = state.scaffold.plan;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: '装底座计划（还没下载）' }));
  wrap.append(
    kv([
      ['新包', p.name],
      ['装到', p.targetDir],
      ['游戏版本', `${p.mcVersion} ${p.loader} ${p.loaderVersion ?? ''}`],
      ['文件总数', `${p.fileCount} 个`],
      ['游戏本体', `${p.vanillaFiles} 个`],
      ['资源文件', `${p.assetFiles} 个`],
      ['加载器', `${p.loaderFiles} 个`],
      ['Java', p.java?.path ? `${p.java.path}（${p.java.version}）` : '没找到'],
      ['需要 Java', p.javaRequiredMajor ? `${p.javaRequiredMajor}` : '未声明'],
      ['Java 够用吗', p.javaMatches ? '够' : '不够，要换 Java'],
      ['总共要下', p.totalText],
    ]),
  );
  if ((p.steps ?? []).length) {
    wrap.append(el('div', { class: 'mcs-field-k', text: '会按这个顺序做' }));
    for (const s of p.steps) wrap.append(el('div', { class: s.done ? 'mcs-ok' : 'mcs-muted', text: `${s.done ? '✓' : '○'} ${s.title}` }));
  }
  for (const w of p.warnings ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `注意：${w}` }));
  for (const c of p.conflicts ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `冲突：${c}` }));
  if (!p.javaMatches) {
    wrap.append(el('div', { class: 'mcs-warn', text: 'Java 版本不够，装了也启动不了。先装对应版本的 Java，或者在上面填一个够用的 java.exe 路径。' }));
  }
  wrap.append(row(
    btn(state.busy === 'scapply' ? '正在下载安装…' : `开始装（下 ${p.totalText}）`, () => scaffoldApply(), {
      primary: true,
      disabled: state.busy === 'scapply' || !p.javaMatches,
    }),
    btn('先不装', () => { state.scaffold.plan = null; render(); }),
  ));
  wrap.append(el('div', { class: 'mcs-muted', text: '这一步会真的下载几百 MB 并写进那个目录。中途别关窗口。' }));
  return wrap;
}

function scaffoldDoneCard() {
  const a = state.scaffold.applied;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: '装好了' }));
  wrap.append(
    kv([
      ['新包', a.name],
      ['位置', a.targetDir],
      ['用了', `${a.seconds ?? '?'} 秒`],
      ['下了', `${a.filesVanilla ?? 0} + ${a.filesLoader ?? 0} + ${a.filesJava ?? 0} 个文件`],
    ]),
  );
  for (const s of a.stages ?? []) wrap.append(el('div', { class: s.done ? 'mcs-ok' : 'mcs-warn', text: `${s.done ? '✓' : '✗'} ${s.title}` }));
  wrap.append(row(
    btn('打开这个新包', () => {
      state.scaffold.open = false;
      state.scaffold.applied = null;
      void connect(a.targetDir, a.name);
    }, { primary: true }),
    btn('知道了', () => { state.scaffold.applied = null; render(); }),
  ));
  return wrap;
}

// ------------------------------------------------------- 从零建包（抄底子）

/** 选项目页的「从零建包」卡：抄本机一个能跑的实例当底子，几秒钟，不下载。 */
function packCreateCard() {
  const pc = state.packCreate;
  if (!pc.open) {
    return card(
      '本机已经有能跑的实例？抄一个',
      el('div', { class: 'mcs-muted', text: '拿一个已经装好、能启动的实例当底子，抄它的版本文件和游戏本体 jar，再配上空的任务书和 KubeJS 目录，几秒钟建出一个新包。不联网、不下载。' }),
      row(btn('抄一个建新包', () => { pc.open = true; render(); })),
    );
  }

  const box = el('div', { class: 'mcs-card' });
  box.append(el('div', { class: 'mcs-card-t', text: '从零建包（抄底子）' }));

  const field = (label, focusKey, placeholder, key) =>
    el('div', { class: 'mcs-field' },
      el('span', { class: 'mcs-field-k', text: label }),
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder,
        value: pc[key],
        'data-focus': focusKey,
        // render() 让「先算要建多大」按钮的可用性跟着输入实时变（data-focus 会自动还焦点）
        oninput: (e) => { pc[key] = e.target.value; pc.plan = null; pc.applied = null; render(); },
      }),
    );

  box.append(field('抄哪个实例（它的目录，里面有 versions.json）', 'pct', '如 D:\\Minecraft\\versions\\Atm10（能启动的实例目录）', 'templateDir'));
  box.append(field('新包建在哪个 Minecraft 根目录', 'pcr', '如 D:\\Minecraft（里面要有 libraries/ 和 assets/）', 'mcRoot'));
  box.append(field('新包叫什么', 'pcn', '如 MyCreatePack（英文，不要空格）', 'name'));

  // 两个可选件
  const check = (label, key) =>
    el('label', { class: 'mcs-detail-item', style: 'cursor:pointer' },
      el('input', {
        type: 'checkbox',
        checked: pc[key],
        onchange: (e) => { pc[key] = Boolean(e.target.checked); pc.plan = null; render(); },
      }),
      el('span', { class: 'mcs-detail-item-name', text: label }),
    );
  box.append(
    el('div', { class: 'mcs-field' },
      el('span', { class: 'mcs-field-k', text: '要带上什么（都能后补）' }),
      check('建一本空任务书（FTB Quests）', 'withQuestBook'),
      check('建 KubeJS 脚本目录（配方魔改用）', 'withKubejs'),
    ),
  );

  box.append(row(
    btn(state.busy === 'packplan' ? '正在算…' : '先算要建多大', () => packCreatePreview(), {
      primary: true,
      disabled: state.busy === 'packplan' || !pc.templateDir.trim() || !pc.mcRoot.trim() || !pc.name.trim(),
    }),
    btn('收起', () => { pc.open = false; render(); }),
  ));
  if (pc.plan) box.append(packCreatePlanCard());
  if (pc.applied) box.append(packCreateDoneCard());
  return box;
}

/** 算建包计划（只算不写）。 */
async function packCreatePreview() {
  const pc = state.packCreate;
  await run('packplan', async () => {
    pc.plan = await post('/pack/preview', {
      mcRoot: pc.mcRoot,
      name: pc.name,
      templateDir: pc.templateDir,
      withQuestBook: pc.withQuestBook,
      withKubejs: pc.withKubejs,
    });
    pc.applied = null;
  });
}

/** 真建。本地复制文件，秒级，不用挂进度条。 */
async function packCreateApply() {
  const pc = state.packCreate;
  await run('packapply', async () => {
    const body = await post('/pack/apply', {
      mcRoot: pc.mcRoot,
      name: pc.name,
      templateDir: pc.templateDir,
      withQuestBook: pc.withQuestBook,
      withKubejs: pc.withKubejs,
    });
    pc.applied = body;
    pc.plan = null;
    return body;
  });
}

function packCreatePlanCard() {
  const p = state.packCreate.plan;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: '建包计划（还没动盘）' }));
  wrap.append(
    kv([
      ['新包', p.name],
      ['建到', p.targetDir],
      ['底子', p.templateId ?? p.templateDir],
      ['游戏版本', `${p.mcVersion ?? '?'} ${p.loader ?? ''} ${p.loaderVersion ?? ''}`],
      ['底子的 mod', p.templateMods != null ? `${p.templateMods} 个（不会抄，要自己装）` : '未知'],
      ['文件总数', `${p.fileCount ?? '?'} 个`],
      ['总共要抄', p.totalText ?? '?'],
      ['空任务书', p.questBook ? '会建' : '不建'],
      ['KubeJS 目录', p.kubejs ? '会建' : '不建'],
    ]),
  );
  for (const w of p.warnings ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `注意：${w}` }));
  wrap.append(row(
    btn(state.busy === 'packapply' ? '正在建…' : `确认建包（抄 ${p.totalText ?? ''}）`, () => packCreateApply(), {
      primary: true,
      disabled: state.busy === 'packapply',
    }),
    btn('先不建', () => { state.packCreate.plan = null; render(); }),
  ));
  wrap.append(el('div', { class: 'mcs-muted', text: '只抄版本文件和游戏本体，不抄 mod 和存档——mod 用「装新 mod」挑着装，存档动了就是别人的世界了。' }));
  return wrap;
}

function packCreateDoneCard() {
  const a = state.packCreate.applied;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: '建好了' }));
  wrap.append(
    kv([
      ['新包', a.name],
      ['位置', a.targetDir],
      ['建了', `${a.createdDirs?.length ?? 0} 个目录 / ${a.createdFiles?.length ?? 0} 个文件`],
    ]),
  );
  for (const l of a.lines ?? []) wrap.append(el('div', { class: 'mcs-muted', text: l }));
  wrap.append(row(
    btn('打开这个新包', () => {
      state.packCreate.open = false;
      state.packCreate.applied = null;
      void connect(a.targetDir, a.name);
    }, { primary: true }),
    btn('知道了', () => { state.packCreate.applied = null; render(); }),
  ));
  return wrap;
}

// --------------------------------------------------------------- 工作台

/**
 * stages.js 里的阶段 key → 该去哪个工具页。
 *
 * 阶段条已经从界面上撤掉了（用户要的是章节页签，不是八个阶段），但
 * stages.js 那套「下一步该干什么」的判断还有用 —— 体检页的「下一步」卡就是它。
 * 这里只负责把阶段翻成面板；任务线（quests）没进映射：它没有独立面板，
 * 打开方式是在左栏点一章，所以那张卡上不给跳转按钮。
 */
const STEP_PANEL = {
  project: 'pick',
  checkup: 'checkup',
  content: 'content',
  assets: 'iconguide',
  pack: 'pack',
  verify: 'verify',
  deliver: 'pack',
};

/**
 * 切到某个工具页（配方 / 打包 / 验证 / 总览 / mod / 任务书）。
 *
 * 工具页不是页签 —— 页签只放章节。所以这里只改 state.panel，
 * 并且把右栏那几张「上一次操作」的卡收掉，免得看着像刚才点的。
 */
/**
 * 任务书诊断面板（2026-11-12 用户点名）。
 *
 * 用户原话：「我想把任务书诊断功能放到顶栏的分析选项下拉列表里。而且点击后是在
 * 标签页下侧出现警告和报错的内容，这点和 vscode 的设计一样」。
 *
 * 所以它**不是一个面板（panel）**，而是挂在页签栏下面的一条可开可关的区域 ——
 * 点「分析 → 任务书诊断」时不切页、不丢当前编辑状态，就在原地展开。
 * 这跟 VSCode 的「问题」面板一个意思：编辑区还在，问题列表挤在下面。
 *
 * 三件事要处理：
 *   1. **没打开时不占位置**（返回 null），不要留一条空白带。
 *   2. **没连包 / 没读过任务书**时要说人话，不能显示成 0 个问题（那是假象）。
 *   3. 列表要能点：点一条跳到那个任务（用 `data-quest` 找节点、点它）。
 */
function diagnosticsPanel() {
  if (!state.diagOpen) return null;
  const problems = state.questBook?.issues?.problems ?? [];
  const errors = problems.filter((p) => p.level === 'error');
  const warns = problems.filter((p) => p.level === 'warn');
  const infos = problems.filter((p) => p.level !== 'error' && p.level !== 'warn');

  const box = el('div', { class: 'mcs-diag' });
  const head = el('div', { class: 'mcs-diag-head' },
    el('span', { class: 'mcs-diag-t', text: '任务书诊断' }),
    el('span', { class: `mcs-diag-n mcs-diag-n-err${errors.length ? '' : ' mcs-diag-zero'}`, text: `错误 ${errors.length}` }),
    el('span', { class: `mcs-diag-n mcs-diag-n-warn${warns.length ? '' : ' mcs-diag-zero'}`, text: `警告 ${warns.length}` }),
    infos.length ? el('span', { class: 'mcs-diag-n mcs-diag-zero', text: `提示 ${infos.length}` }) : null,
    el('span', { class: 'mcs-spacer' }),
    btn(state.busy === 'lint' ? '正在检查…' : '检查一次', () => runQuestLint(), { disabled: Boolean(state.busy) }),
    el('span', {
      class: 'mcs-diag-x',
      text: '×',
      title: '关掉诊断面板',
      onclick: () => { state.diagOpen = false; render(); },
    }),
  );
  box.append(head);

  const state_ = state.questBook;
  const body = el('div', { class: 'mcs-diag-body' });
  if (!state_) {
    // 没读过任务书 ≠ 没问题。如实说，别让人以为诊断过了。
    body.append(el('div', { class: 'mcs-muted', text: '还没读到任务书。先去左边点一个章节，或者点上面的「检查一次」。' }));
  } else if (!problems.length) {
    body.append(el('div', { class: 'mcs-muted', text: '没发现问题。改完文件再点一次「检查一次」就是最新的结果。' }));
  } else {
    for (const [idx, p] of problems.slice(0, 200).entries()) {
      const isErr = p.level === 'error';
      // 能跳的两种：带任务 ID（跳到那个任务 + 画布居中）或只带章节 ID
      // （章节级问题，切到那一章就够了）。
      const canJump = Boolean(p.questId || p.chapterId);
      body.append(el('div', {
        class: `mcs-diag-row mcs-diag-${isErr ? 'err' : p.level === 'warn' ? 'warn' : 'info'}${canJump ? ' mcs-diag-jump' : ''}`,
        // 后端 lintQuests 现在每条都带 `{questId, chapterId}` 定位（2026-11-12 补的）。
        // 以前这里的条件是 `p.questId`，但后端从来不产这个字段 —— 所以点了没反应。
        onclick: canJump ? () => { void jumpToDiagnostic(idx); } : null,
        title: canJump
          ? (p.questId ? '点这条跳到那个任务（会切章节 + 画布移过去）' : '点这条切到那一章')
          : '',
      },
        el('span', { class: 'mcs-diag-tag', text: isErr ? '错误' : p.level === 'warn' ? '警告' : '提示' }),
        el('span', { class: 'mcs-diag-where', text: p.where ?? '' }),
        el('span', { class: 'mcs-diag-msg', text: p.message ?? '' }),
      ));
    }
    if (problems.length > 200) {
      body.append(el('div', { class: 'mcs-muted', text: `…还有 ${problems.length - 200} 条` }));
    }
  }
  box.append(body);
  // 快捷键作用域：点诊断面板（报错栏）不等于点画布 —— 用户明确说过
  // 「中栏**不包括**下侧报错栏」。所以这里标成 other，
  // 否则在报错栏里选中文字按 Ctrl+C 会被抢去复制任务节点。
  bindKeyScope(box, 'other');
  return box;
}

/**
 * 「分析 → 任务书诊断」：展开/收起那条面板，展开时顺手现算一次。
 *
 * ★ 为什么不复用 `gotoPanel('checkup')` 那套：那会**切走当前面板**（画布、配方、
 *   任何正在编辑的东西都没了）。用户要的是 VSCode 那种「问题面板挤在下面、
 *   编辑区还在」，所以这里只动 `state.diagOpen` + 重读一次任务书，不碰 `state.panel`。
 *
 * ★ 展开时**一定重算**：用户点这个菜单就是想看最新的问题，
 *   拿连包时算的旧结果糊弄等于没查。
 */
async function toggleDiagnostics() {
  state.diagOpen = !state.diagOpen;
  state.menuOpen = '';
  if (!state.diagOpen) {
    render();
    return;
  }
  // 先画出来（让人看到面板出现），再去读数据 —— 千 mod 的包读完要一两秒
  render();
  if (!state.dir) return;
  await runQuestLint();
}

function gotoPanel(panel) {
  if (!panel) return;
  if (panel === 'pick') {
    state.screen = 'pick';
    render();
    return;
  }
  state.panel = panel;
  state.draft = null;
  state.plan = null;
  state.done = null;
  state.menu = null;
  state.imageMenu = null;
  state.menuOpen = '';
  state.closeConfirm = '';
  render();
}

/**
 * 顶部菜单栏（文件 / 下载 / 任务书 / 运行 ▶ / debug）。
 *
 * 学 VSCode 的样子：点标题展开一列命令，点命令就干活，点完自动收起。
 * 每个命令都直接调用已有的函数，不新开一套逻辑。
 */
function menuBar() {
  const s = state.summary ?? {};
  const inst = s.instance ?? {};
  const idx = s.index ?? {};
  const bar = el('div', { class: 'mcs-menubar' });
  // 先把上一次的记号清掉，下面遇到展开的那一个再记上（记号只给「点外面关」用）
  openMenuEl = null;
  openMenuBtn = null;
  for (const menu of MENUS) {
    const open = state.menuOpen === menu.key;
    const btn = el('button', {
      class: `mcs-menu-btn${open ? ' mcs-menu-btn-on' : ''}`,
      text: menu.name,
      // 按「现在的状态」算开关，不按这次画出来时的状态 ——
      // 因为「点空白处收菜单」是不重画的，闭包里那份 open 会过期。
      onclick: () => {
        state.menuOpen = state.menuOpen === menu.key ? '' : menu.key;
        render();
      },
    });
    const wrap = el('div', { class: 'mcs-menu-wrap' }, btn);
    if (open) {
      const pop = el('div', { class: 'mcs-menu-pop' });
      for (const item of menu.items()) {
        if (item.sep) {
          pop.append(el('div', { class: 'mcs-menu-sep' }));
          continue;
        }
        pop.append(
          el(
            'div',
            {
              class: `mcs-menu-item${item.disabled ? ' mcs-menu-item-off' : ''}`,
              onclick: item.disabled
                ? undefined
                : () => {
                    // 先把浮层收掉再干活：有的命令自己不重画界面
                    // （比如「把当前状态打到控制台」只打一行日志），
                    // 只置空 state.menuOpen 的话，弹出层还留在屏幕上。
                    closeTopMenu();
                    item.run();
                  },
            },
            el('span', { class: 'mcs-menu-label', text: item.label }),
            item.hint ? el('span', { class: 'mcs-menu-hint', text: item.hint }) : null,
          ),
        );
      }
      wrap.append(pop);
      // 记下这一层浮层，点空白处才知道该把哪一块从页面上摘掉
      openMenuEl = pop;
      openMenuBtn = btn;
    }
    bar.append(wrap);
  }
  // 「预览」＝看游戏里的样子。固定叫预览、文字不变，正在预览时按钮高亮（mcs-menu-btn-on）。
  // 原来挂在画布标题行上（用户嫌位置不对），2026-11-09 挪到顶部菜单栏，跟「设置」并排。
  const previewOn = state.canvasLook === 'game';
  bar.append(el('div', { class: 'mcs-menu-wrap' },
    el('button', {
      class: `mcs-menu-btn${previewOn ? ' mcs-menu-btn-on' : ''}`,
      text: '预览',
      title: previewOn
        ? '切回编辑网格：方框 + 坐标 + 图标 ID，看得清每个数字'
        : '切到游戏观感：按 FTB 的形状贴图画节点，跟游戏里长得像',
      onclick: () => {
        state.canvasLook = state.canvasLook === 'game' ? 'edit' : 'game';
        // 切回编辑态就把预览窗口收掉（编辑态点节点是「改这个任务」，不该还浮着它）
        if (state.canvasLook !== 'game') state.previewQuest = { questId: '', page: 0, done: [] };
        render();
        if (state.canvasLook === 'game') void ensureShapeImages();
      },
    }),
  ));
  bar.append(el('div', { class: 'mcs-top-spacer' }));
  bar.append(
    el('div', {
      class: 'mcs-menubar-sub',
      // 项目名字放右上角，标题栏不再单独占一整行
      text: `${inst.id ?? ''}　${inst.mcVersion ?? '?'} · ${inst.loader ?? '?'} · ${idx.itemCount ?? 0} 个物品 · ${idx.recipeCount ?? 0} 条配方`.trim(),
    }),
  );
  return bar;
}

/**
 * 菜单表。写成函数是因为命令里要用到后面才定义的函数。
 *
 * 只留七项：文件 / mod / 运行 / 编译 / 分析 / 交付 / 设置。
 * 打包和验证合进「交付」—— 那是项目最后才做的事，不该跟任务书页签挤在一起。
 * 「分析」是原先只以模型工具形态存在的那批只读检查。
 */
const MENUS = [
  {
    key: 'file',
    name: '文件',
    items: () => [
      { label: '换一个整合包…', hint: '回到选项目页', run: () => { state.screen = 'pick'; state.summary = null; render(); } },
      { label: '从零装一个整合包…', hint: '下载游戏本体 + 加载器', run: () => { state.screen = 'pick'; state.scaffold.open = true; render(); } },
      { sep: true },
      { label: '重新体检', hint: '重读总览和物品索引', disabled: state.busy === 'connect', run: () => connect(state.dir, state.instanceId) },
      { label: '重读任务书', hint: '从磁盘重新读一遍', disabled: state.busy === 'canvas', run: () => run('canvas', async () => { state.questBook = await api('/questbook', { dir: state.dir, id: state.instanceId }); await refreshCanvas(); }) },
      { sep: true },
      { label: '补全物品图标…', hint: '教游戏自己导出高清图标', run: () => gotoPanel('iconguide') },
    ],
  },
  {
    key: 'mods',
    name: 'mod',
    items: () => [
      { label: '看 mod 列表', hint: '左栏那一堆', run: () => gotoPanel('mods') },
      { label: '装新 mod…', hint: '从 Modrinth 搜', run: () => { state.modMode = 'search'; gotoPanel('mods'); } },
      { sep: true },
      { label: '刷新 mod 列表', disabled: state.busy === 'mods', run: () => loadMods() },
      { label: '从零装底座…', hint: '几百 MB', run: () => { state.screen = 'pick'; state.scaffold.open = true; render(); } },
    ],
  },
  {
    key: 'run',
    name: '运行',
    items: () => [
      { label: '算一遍启动命令行', hint: '不启动，只检查', run: () => gotoPanel('verify') },
      { label: '真启动一次', hint: '跑不到主菜单会告诉你为什么', run: () => gotoPanel('verify') },
    ],
  },
  {
    key: 'compile',
    name: '编译',
    items: () => [
      { label: '改配方（生成 KubeJS 脚本）', hint: '删原配方、换成你改的', run: () => gotoPanel('content') },
      { label: '搜物品、看它用在哪', hint: '改之前先看清楚', run: () => gotoPanel('content') },
      { sep: true },
      { label: '看物品与配方数', hint: '版本 / 加载器 / 索引', run: () => gotoPanel('checkup') },
    ],
  },
  {
    key: 'analysis',
    name: '分析',
    items: () => [
      // 2026-11-12 用户点名：任务书诊断放到这里，点了在**页签栏下面**展开面板
      // （和 VSCode 的「问题」面板一样，不切走当前编辑的东西）。
      {
        label: state.diagOpen ? '任务书诊断（收起）' : '任务书诊断',
        hint: '在页签下面列出警告和报错',
        run: () => { toggleDiagnostics(); },
      },
      { sep: true },
      { label: 'mod 撞车', hint: '几个 mod 在做同一件事', run: () => { state.analysis.tab = 'overlap'; gotoPanel('analysis'); } },
      { label: '进度深度', hint: '加工链是陡还是平', run: () => { state.analysis.tab = 'progress'; gotoPanel('analysis'); } },
      { label: '拆开看 mod', hint: 'jar 里到底装了什么', run: () => { state.analysis.tab = 'mod'; gotoPanel('analysis'); } },
      { sep: true },
      { label: '这个物品怎么来的', hint: '顺着材料往上追', run: () => { state.analysis.tab = 'path'; gotoPanel('analysis'); } },
      { label: '谁在用它', hint: '删之前先看清楚', run: () => { state.analysis.tab = 'uses'; gotoPanel('analysis'); } },
      { label: 'KubeJS 脚本体检', hint: '脚本跑不跑得通', run: () => { state.analysis.tab = 'kubejs'; gotoPanel('analysis'); } },
    ],
  },
  {
    key: 'deliver',
    name: '交付',
    items: () => [
      { label: '打包', hint: 'standard / offline / launcher 三种形态', run: () => gotoPanel('pack') },
      { label: '启动验证', hint: '真跑到主菜单', run: () => gotoPanel('verify') },
      { sep: true },
      { label: '体检总览', hint: '版本 / 物品 / 配方数', run: () => gotoPanel('checkup') },
    ],
  },
  {
    key: 'settings',
    name: '设置',
    items: () => [
      { label: '看这个包的目录和版本', run: () => gotoPanel('checkup') },
      { sep: true },
      {
        label: '让模型帮你改包',
        hint: '把这段配置贴进 DSH，模型就能直接改这个整合包',
        run: () => gotoPanel('mcp'),
      },
      {
        label: '把当前状态打到控制台',
        hint: '排查问题时用',
        run: () => console.log('[mcstudio] state', JSON.parse(JSON.stringify(state, (k, v) => (k === 'nodeEls' || k === 'edgeEls' || k === 'viewportEl' || k === 'guideEls' ? undefined : v)))),
      },
      ...localeMenuItems(),
    ],
  },
];

// --------------------------------------------------------------- 章节页签

/** 一个页签最多开几章。 */
const MAX_TABS = 8;

/**
 * 一个页签「自己的东西」有哪些。
 *
 * 用户要的是：切页签之后画布位置、选中的任务、没提交的表单、撤销栈都各归各位。
 * 做法是把这些字段按章存快照（state.sessions[章节ID]），切页签时整存整取 ——
 * 这样画布 / 拖动 / 框选 / 撤销那几百行代码一行都不用改。
 */
const SESSION_KEYS = [
  'canvasChapterId',
  'view',
  'canvasOrigin',
  'sel',
  'selSet',
  'questDetail',
  'draft',
  'plan',
  'done',
  'undo',
  'redo',
  'flash',
];

/** 从一个对象里挑出指定的键（浅拷贝值）。 */
function pickKeys(source, keys) {
  const out = {};
  for (const key of keys) out[key] = source[key];
  return out;
}

/** 新页签的默认状态：什么都从头来。 */
function freshSession() {
  return {
    view: { scale: 1, tx: 0, ty: 0 },
    canvasOrigin: null,
    sel: '',
    selSet: [],
    questDetail: null,
    draft: null,
    plan: null,
    done: null,
    undo: [],
    redo: [],
    flash: '',
  };
}

/** 这个页签有没有没提交（没写盘、也没点收起）的东西。 */
function hasDraft(id) {
  const s = state.sessions[id];
  if (id === state.canvasChapterId && state.draft) return true;
  return Boolean(s?.draft);
}

/** 开一个章节页签（已经在开着就直接切过去）。 */
function openChapterTab(chapterId) {
  const id = String(chapterId ?? '');
  if (!id) return;
  if (!state.tabs.includes(id) && state.tabs.length >= MAX_TABS) {
    state.error = `一次最多开 ${MAX_TABS} 个章节页签，先关掉一个再开`;
    render();
    return;
  }
  if (!state.tabs.includes(id)) {
    state.tabs.push(id);
    state.sessions[id] = { ...freshSession(), ...(state.sessions[id] ?? {}) };
  }
  switchTab(id);
}

/**
 * 切页签：先把当前页签的状态存起来，再把目标页签的状态装回去。
 *
 * 注意 canvas / icons / questImages 是共享的（18 章的数据一次读全，
 * 切页签不该再请求一次），这里只动 SESSION_KEYS 里的那些。
 */
function switchTab(nextId) {
  const from = state.canvasChapterId;
  if (from && from !== nextId) state.sessions[from] = { ...pickKeys(state, SESSION_KEYS), canvasChapterId: from };
  state.closeConfirm = '';
  state.draft = null;
  state.plan = null;
  state.done = null;
  const saved = state.sessions[nextId] ?? freshSession();
  Object.assign(state, saved);
  state.canvasChapterId = nextId;
  // 点章节页签就是「我要看这一章的画布」—— 哪怕刚才在打包 / mod 页，也切回来
  state.panel = 'quests';
  state.menu = null;
  state.imageMenu = null;
  state.menuOpen = '';
  saveTabs();
  render();
  // 每章装饰图各是各的：切过来得把这一章的图换一遍（换过的不重复请求）
  void ensureQuestImages();
  // 游戏观感模式要的那套形状贴图也按当前章换一遍
  void ensureShapeImages();
}

/** 真要关掉一个页签（确认之后走这里）。 */
function dropTab(id) {
  const idx = state.tabs.indexOf(id);
  if (idx < 0) return;
  state.tabs.splice(idx, 1);
  delete state.sessions[id];
  state.closeConfirm = '';
  if (state.canvasChapterId !== id) {
    render();
    return;
  }
  // 关的是当前这个：跳到左边那个（没有就右边那个）；全关了就是空状态
  const next = state.tabs[Math.max(0, idx - 1)] ?? '';
  if (next) {
    switchTab(next);
    return;
  }
  Object.assign(state, freshSession());
  state.canvasChapterId = '';
  state.draft = null;
  state.plan = null;
  state.done = null;
  saveTabs();
  render();
}

/** 点页签上的 ×。有没提交的草稿就先问一句。 */
function askCloseTab(id) {
  if (hasDraft(id)) {
    state.closeConfirm = id;
    render();
    return;
  }
  dropTab(id);
}

/** 章节页签栏（VSCode 那排）。一章一个，最多 8 个。 */
function tabBar() {
  const chapters = state.canvas?.chapters ?? [];
  const bar = el('div', { class: 'mcs-tabbar' });
  if (!state.tabs.length) {
    bar.append(el('span', { class: 'mcs-tab-empty', text: '左边点一章，就在这里开一个页签' }));
    return bar;
  }
  for (const id of state.tabs) {
    const chapter = chapters.find((c) => c.id === id);
    const on = state.canvasChapterId === id;
    const tab = el(
      'div',
      {
        class: `mcs-tab${on ? ' mcs-tab-on' : ''}`,
        title: chapter ? `「${chapter.title ?? id}」· ${(chapter.nodes ?? []).length} 个任务` : '这一章已经不在了',
        onclick: () => switchTab(id),
      },
      el('span', { class: 'mcs-tab-name', text: chapter?.title ?? id }),
      hasDraft(id) ? el('span', { class: 'mcs-tab-dot', text: '●', title: '有没提交的改动' }) : null,
      el('span', {
        class: 'mcs-tab-x',
        text: '×',
        title: '关掉这个页签',
        onclick: (event) => {
          event?.stopPropagation?.();
          askCloseTab(id);
        },
      }),
    );
    bar.append(tab);
  }
  return bar;
}

/** × 之后的那个「这一章还有没提交的改动，关掉？」小条。 */
function closeConfirmBar() {
  if (!state.closeConfirm) return null;
  const id = state.closeConfirm;
  const chapter = (state.canvas?.chapters ?? []).find((c) => c.id === id);
  return el(
    'div',
    { class: 'mcs-tabconfirm' },
    el('span', { text: `「${chapter?.title ?? id}」这一页还有没提交的改动，关掉就没了。` }),
    el('span', { class: 'mcs-spacer' }),
    el('button', { class: 'mcs-btn mcs-btn-sm mcs-btn-danger', text: '还是关掉', onclick: () => dropTab(id) }),
    el('button', { class: 'mcs-btn mcs-btn-sm', text: '留着', onclick: () => { state.closeConfirm = ''; render(); } }),
  );
}

/**
 * 左侧栏：这一本书有哪些章节。
 *
 * 按分组列出来，点一下就在上面开一个页签。以前这里是 mod 列表 +
 * 最左边一竖排图标 —— 那套是照着「八个阶段」设计的骨架，现在章节页签
 * 才是主线，mod 挪进菜单栏了。
 */
function chapterRail() {
  const rail = el('div', { class: 'mcs-left' });
  const chapters = state.canvas?.chapters ?? [];

  rail.append(
    el('div', { class: 'mcs-left-t' },
      el('span', { text: '章节' }),
      el('span', { class: 'mcs-spacer' }),
      // 照 VSCode 资源管理器：标题行上放小加号。新增章节是并列加一章（不挑页签），
      // 新增任务必须附在当前打开的章节上，没选章节就置灰（2026-11-09 用户点名）。
      el('button', {
        class: 'mcs-left-add',
        text: '＋新章节',
        'data-act': 'add-chapter',
        title: '新增章节（排在最后，不用先选章节）',
        disabled: state.busy === 'chapterplan',
        onclick: () => startDraft('chapter', ''),
      }),
      el('button', {
        class: 'mcs-left-add',
        text: '＋新任务',
        'data-act': 'add-quest',
        title: state.canvasChapterId ? '给当前这一章加一个任务' : '先选一个章节',
        disabled: !state.canvasChapterId || state.busy === 'newplan',
        onclick: () => startDraft('new', ''),
      }),
      el('span', { class: 'mcs-muted', text: `${chapters.length} 章` }),
    ),
  );

  rail.append(
    el('input', {
      class: 'mcs-input mcs-input-sm',
      placeholder: '搜章节（标题）',
      value: state.chapterQuery,
      'data-focus': 'chapq',
      oninput: (e) => {
        state.chapterQuery = e.target.value;
        render();
      },
    }),
  );

  if (state.busy === 'canvas' && !chapters.length) {
    rail.append(el('div', { class: 'mcs-muted', text: '正在读任务书…' }));
    return rail;
  }
  if (!chapters.length) {
    rail.append(el('div', { class: 'mcs-muted', text: state.questBook ? '这本书里还没有章节' : '还没读到任务书' }));
    return rail;
  }

  const q = state.chapterQuery.trim().toLowerCase();
  const shown = q ? chapters.filter((c) => String(c.title ?? '').toLowerCase().includes(q)) : chapters;

  // 按分组归堆，组的顺序按章节在书里的先后，不重新排序
  const groups = [];
  for (const chapter of shown) {
    const key = chapter.group ?? '';
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, title: chapter.groupTitle || '（没分组）', chapters: [] };
      groups.push(group);
    }
    group.chapters.push(chapter);
  }

  const list = el('div', { class: 'mcs-chaprail' });
  for (const group of groups) {
    list.append(el('div', { class: 'mcs-chaprail-group', text: group.title }));
    for (const chapter of group.chapters) {
      const open = state.tabs.includes(chapter.id);
      const on = state.canvasChapterId === chapter.id;
      list.append(
        el(
          'div',
          {
            class: `mcs-chapitem${on ? ' mcs-chapitem-on' : ''}${open ? ' mcs-chapitem-open' : ''}`,
            title: `${chapter.title ?? chapter.id} · ${(chapter.nodes ?? []).length} 个任务${open ? '（已经开着）' : ''}`,
            onclick: () => openChapterTab(chapter.id),
          },
          el('span', { class: 'mcs-chapitem-name' }, mcText(chapter.titleSpans, chapter.title ?? chapter.id)),
          el('span', { class: 'mcs-chapitem-meta', text: String((chapter.nodes ?? []).length) }),
        ),
      );
    }
  }
  if (!shown.length) list.append(el('div', { class: 'mcs-muted', text: '没有匹配的章节' }));
  rail.append(list);

  rail.append(
    el('div', { class: 'mcs-left-count', text: state.tabs.length ? `开着 ${state.tabs.length} / ${MAX_TABS} 个页签` : '点一章开页签' }),
  );

  // 任务书全文搜索：以前只有「按章节找」，现在能按任务名/描述/物品搜。
  rail.append(
    el('div', { class: 'mcs-left-t' },
      el('span', { text: '搜任务' }),
      el('span', { class: 'mcs-spacer' }),
      el('span', { class: 'mcs-muted', text: state.questHits ? `${state.questHits.total} 个命中` : '' }),
    ),
  );
  rail.append(
    el('input', {
      class: 'mcs-input mcs-input-sm',
      placeholder: '任务名 / 描述 / 物品 ID',
      value: state.questQuery,
      'data-focus': 'questq',
      oninput: (e) => {
        state.questQuery = e.target.value;
        render();
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') void searchQuests();
      },
    }),
  );
  rail.append(
    row(
      btn(state.busy === 'questq' ? '搜…' : '搜', () => void searchQuests(), {
        primary: true,
        disabled: state.busy === 'questq',
      }),
      state.questHits
        ? btn('清掉', () => { state.questQuery = ''; state.questHits = null; render(); })
        : null,
    ),
  );
  if (state.questHits) {
    const hits = el('div', { class: 'mcs-chaprail' });
    for (const q of state.questHits.items ?? []) {
      hits.append(
        el(
          'div',
          {
            class: 'mcs-chapitem',
            title: `${q.title ?? q.id} · ${q.chapterTitle ?? ''}`,
            onclick: () => { void openQuestHit(q); },
          },
          el('span', { class: 'mcs-chapitem-name', text: q.title ?? q.id }),
          el('span', { class: 'mcs-chapitem-meta', text: String(q.taskCount ?? 0) }),
        ),
      );
    }
    if (!(state.questHits.items ?? []).length) {
      hits.append(el('div', { class: 'mcs-muted', text: '没有匹配的任务' }));
    }
    rail.append(hits);
  }
  return rail;
}

/** 按关键词搜任务书（/quests?q=）。 */
async function searchQuests() {
  const q = String(state.questQuery ?? '').trim();
  if (!q) {
    state.questHits = null;
    render();
    return;
  }
  await run('questq', async () => {
    state.questHits = await api('/quests', { dir: state.dir, id: state.instanceId, q, limit: 40 });
  });
}

/** 点搜索结果：打开它所在的那一章，再选中这个任务。 */
async function openQuestHit(q) {
  if (q.chapterId) openChapterTab(q.chapterId);
  await selectQuest(q.id);
}


/**
 * 中栏工具页：mod 管理。
 *
 * 以前 mod 列表是常驻左栏（最左边还有一竖排图标切它）。用户要求「mod 和
 * 设置 / 运行 / 编译并列」—— 所以它现在是个独立的工具页，从菜单栏的 mod 进。
 */
function modsPane() {
  const pane = el('div', { class: 'mcs-center' });
  pane.append(
    el('div', { class: 'mcs-center-t' },
      el('span', { text: 'Mod 列表' }),
      el('span', { class: 'mcs-spacer' }),
      btn('刷新', () => loadMods(), { disabled: state.busy === 'mods' }),
      // 「查兼容」：体检这个整合包现有的 mods 有没有互斥 / 缺前置 / 版本对不上 / 装了多份
      btn(state.busy === 'modcompat' ? '正在查兼容…' : '查兼容', () => loadModCompat(), {
        disabled: state.busy === 'modcompat',
        title: '扫一遍这个包现有的 mod，看看有没有互相打架或者缺前置',
      }),
      btn(state.modMode === 'search' ? '收起联网搜索' : '装新 mod', () => {
        state.modMode = state.modMode === 'search' ? 'local' : 'search';
        render();
      }, { primary: state.modMode !== 'search' }),
      // 「检查更新」：问 Modrinth 这个包里哪些 mod 有新版本。只读，不写盘。
      btn(state.modUpdateOpen ? '收起更新检查' : '检查更新', () => {
        state.modUpdateOpen = !state.modUpdateOpen;
        render();
      }, {
        disabled: state.busy === 'modupdatecheck',
        title: '用已装 jar 的哈希问 Modrinth 有没有新版本，不会认错 mod',
      }),
    ),
  );

  // 体检结果：后端已经把结论写成「人话」（lines），这里直接显示，不再自己翻译
  if (state.modCompat) {
    const c = state.modCompat;
    const lines = Array.isArray(c.lines) ? c.lines : [];
    pane.append(
      el('div', { class: 'mcs-subcard' },
        el('div', { class: 'mcs-card-t', text: '兼容性体检' }),
        kv([
          ['扫到 mod', c.count ?? (c.mods ?? []).length],
          ['互斥打架', (c.conflicts ?? []).length],
          ['缺少前置', (c.missing ?? []).length],
          ['版本对不上', (c.versionMismatch ?? []).length],
          ['装了多份', (c.duplicates ?? []).length],
        ]),
        c.modsDir ? el('div', { class: 'mcs-muted', text: `mods 目录：${c.modsDir}` }) : null,
        ...lines.map((line) => el('div', { class: 'mcs-muted', text: line })),
        ...(c.failed ? [el('div', { class: 'mcs-warn', text: `有 ${c.failed} 个 jar 读不出来，已跳过。` })] : []),
      ),
    );
  }

  pane.append(
    el('input', {
      class: 'mcs-input mcs-input-sm',
      placeholder: '搜索 mod（中文名或 modId）',
      value: state.modQuery,
      'data-focus': 'modq',
      oninput: (e) => {
        state.modQuery = e.target.value;
        render();
      },
    }),
  );

  if (state.modMode === 'search') pane.append(modSearchBox());
  if (state.modUpdateOpen) pane.append(modUpdateBox());

  const mods = state.mods ?? [];
  const q = state.modQuery.trim().toLowerCase();
  const shown = q
    ? mods.filter((m) => `${m.name ?? ''} ${m.modId ?? ''}`.toLowerCase().includes(q))
    : mods;

  pane.append(
    el('div', { class: 'mcs-left-count', text: q ? `匹配 ${shown.length} / 共 ${mods.length} 个` : `共 ${mods.length} 个` }),
  );

  const list = el('div', { class: 'mcs-modlist mcs-modlist-wide' });
  for (const mod of shown.slice(0, 400)) {
    list.append(
      el(
        'div',
        { class: 'mcs-mod' },
        el('div', { class: 'mcs-mod-name', text: mod.name || mod.modId }),
        el('div', { class: 'mcs-mod-meta', text: `${mod.version ?? ''} · ${mod.items ?? 0} 物品` }),
      ),
    );
  }
  if (shown.length === 0) list.append(el('div', { class: 'mcs-muted', text: mods.length ? '没有匹配的 mod' : '没读到 mod 列表' }));
  pane.append(list);
  return pane;
}

/**
 * 「检查更新」面板：先问谁有新版，勾中要升的，算一遍清单，再真升。
 *
 * 这里只读地画后端算好的结果（items / lines），自己不判断版本号 ——
 * 「有没有更新」是后端按 jar 的 sha1 问 Modrinth 得出的，界面别再翻译一遍。
 * 升级会把旧 jar 改名成 .jar.disabled 停用而不是删掉，清单里会写清楚。
 */
function modUpdateBox() {
  const box = el('div', { class: 'mcs-card' });
  box.append(el('div', { class: 'mcs-card-t', text: '检查 mod 更新' }));

  // 版本渠道：跟「装新 mod」一样，默认只看正式版。切了要重新查。
  box.append(row(
    el('span', { class: 'mcs-field-label', text: '版本渠道：' }),
    ...[['release', '正式'], ['beta', '测试'], ['alpha', '开发']].map(([value, label]) =>
      btn(label, () => {
        state.modUpdateChannel = value;
        state.modUpdateCheck = null;
        state.modUpdateSelected = [];
        state.modUpdatePlan = null;
        state.modUpdateResult = null;
        state.modUpdateRollbackPlan = null;
        state.modUpdateRollbackResult = null;
        render();
      }, { primary: state.modUpdateChannel === value, disabled: state.busy === 'modupdatecheck' }),
    ),
    btn(state.busy === 'modupdatecheck' ? '正在检查…' : '检查更新', () => checkModUpdates(), {
      primary: true,
      disabled: state.busy === 'modupdatecheck',
      title: '联网问一遍谁有新版本，一个文件都不写',
    }),
  ));

  const chk = state.modUpdateCheck;
  if (chk) {
    // 网络不通时后端给的是「空表 + 提示」，照常画出来，别假装查到了。
    if (chk.error) {
      box.append(
        el('div', { class: 'mcs-subcard' },
          el('div', { class: 'mcs-warn', text: chk.error }),
          ...(chk.hint ? [el('div', { class: 'mcs-muted', text: chk.hint })] : []),
        ),
      );
    }
    const items = Array.isArray(chk.items) ? chk.items : [];
    // 锁定名单是唯一真相源：后端 check 里也会把锁定项标成 locked，界面再按名单兜一层，
    // 这样刚点完「锁定」不用等着重联网查，条目当场就变灰、不再能勾。
    const updatable = items.filter((it) => it.status === 'update' && !isModUpdateLocked(it));
    box.append(
      el('div', { class: 'mcs-subcard' },
        kv([
          ['扫到 mod', chk.scanned ?? items.length],
          ['能升', updatable.length],
          ['已锁定', (state.modUpdateLocks ?? []).length],
          ['已最新', chk.latest ?? 0],
          ['查不到', chk.unknown ?? 0],
        ]),
        el('div', { class: 'mcs-muted', text: `按 ${chk.loader || '当前加载器'} / ${chk.gameVersion || '当前 MC 版本'} / ${chk.channel || '正式'} 匹配` }),
      ),
    );

    // 可升且没锁的可以勾选；最新 / 查不到 / 已锁定的只显示，不让勾。
    for (const it of items.slice(0, 60)) {
      const locked = isModUpdateLocked(it);
      const on = state.modUpdateSelected.includes(it.key);
      const canPick = it.status === 'update' && !locked;
      const label = locked
        ? `${it.name || it.fileName}  🔒 已锁定，不再提示更新`
        : it.status === 'update'
          ? `${it.name || it.fileName}  ${it.currentVersion ? `${it.currentVersion} → ` : ''}${it.latestVersion || '新版本'}`
          : it.status === 'latest'
            ? `${it.name || it.fileName}  已是最新`
            : `${it.name || it.fileName}  查不到（可能不是从 Modrinth 装的，或文件被改过）`;
      box.append(
        el('div', {
          class: `mcs-hit${canPick ? ' mcs-pickable' : ''}${on ? ' mcs-pick-on' : ''}`,
          onclick: canPick ? () => toggleUpdatePick(it.key) : undefined,
        },
          el('div', { class: 'mcs-hit-name' },
            canPick ? el('span', { class: `mcs-tick${on ? ' mcs-tick-on' : ''}`, text: on ? '✓' : '' }) : null,
            el('span', { text: label }),
          ),
          // 锁定 / 解锁：内嵌按钮要掐掉冒泡，否则点它会顺带勾中这一行。
          btn(locked ? '解锁' : '锁定', (e) => {
            e?.stopPropagation?.();
            changeModUpdateLock(locked ? 'remove' : 'add', it);
          }, {
            title: locked
              ? '解锁后，这个 mod 又会正常提示更新'
              : '锁定后，这个 mod 不再提示更新、也不会被升级（适合作者改过或故意锁死旧版的 mod）',
          }),
        ),
      );
    }
    if (items.length > 60) box.append(el('div', { class: 'mcs-muted', text: `只显示前 60 个，共 ${items.length} 个` }));

    // 有能升的才摆按钮行：网络不通 / 全是最新时结果卡已经是空的，
    // 摆一排点不动的「算升级清单（0 个）」只会让人以为还能点。
    // 没勾 = 快捷「全升」（selected 传空，后端全选能升的）。
    if (updatable.length > 0) {
      box.append(row(
        btn(state.busy === 'modupdateplan' ? '正在算…' : `算升级清单（${state.modUpdateSelected.length || updatable.length} 个）`, () => previewModUpdate(), {
          primary: true,
          disabled: state.busy === 'modupdateplan',
        }),
        btn('全不选', () => { state.modUpdateSelected = []; state.modUpdatePlan = null; render(); }, {
          disabled: state.modUpdateSelected.length === 0,
        }),
      ));
    }
    if (Array.isArray(chk.lines)) {
      for (const line of chk.lines.slice(0, 12)) {
        if (line) box.append(el('div', { class: 'mcs-muted', text: line }));
      }
    }
  } else {
    box.append(el('div', { class: 'mcs-muted', text: '点上面的「检查更新」，看看这个包里哪些 mod 有新版本。' }));
  }

  // 升级清单：只算不写。写清楚「旧 jar 会停用、不会删」。
  if (state.modUpdatePlan) {
    const p = state.modUpdatePlan;
    box.append(
      el('div', { class: 'mcs-subcard' },
        el('div', { class: 'mcs-card-t', text: '升级清单（还没动文件）' }),
        kv([
          ['要升', (p.items ?? []).length],
          ['预计下载', `${((Number(p.totalBytes) || 0) / 1024 / 1024).toFixed(1)} MB`],
        ]),
        ...(p.items ?? []).slice(0, 8).map((it) =>
          el('div', { class: 'mcs-muted', text: `${it.name ?? it.fileName}：${it.currentVersion ?? ''} → ${it.latestVersion ?? '新版本'}（停用 ${it.oldName ?? it.fileName} → ${it.disabledName}）` }),
        ),
        ...(p.skipped ?? []).map((s) => el('div', { class: 'mcs-warn', text: `${s.fileName}：${s.message}` })),
        row(btn('就升这些', () => applyModUpdate(), { primary: true, disabled: state.busy === 'modupdateapply' })),
      ),
    );
  }

  // 升级结果 + 升级后的整包体检 + 一键撤回（两态）
  if (state.modUpdateResult) {
    const r = state.modUpdateResult;
    box.append(
      el('div', { class: 'mcs-subcard' },
        el('div', { class: r.ok === false ? 'mcs-err' : 'mcs-ok', text: r.applied === false ? '没有需要升级的 mod' : `升好了 ${(r.installed ?? []).length} 个 mod` }),
        ...(r.failed ?? []).map((f) => el('div', { class: 'mcs-err', text: `${f.name ?? f.fileName ?? ''}：${f.message ?? f.reason ?? '失败'}` })),
        ...(r.lines ?? []).slice(0, 16).map((line) => el('div', { class: 'mcs-muted', text: line })),
        // 真升过才会带 installed[]，这时才给「撤回」按钮。
        // 两态：先算清单（不写盘），再「确认撤回」才真改文件名。
        ...(r.applied !== false && (r.installed ?? []).length > 0
          ? [row(btn(state.busy === 'modupdaterollbackplan' ? '正在算…' : '撤回这次升级', () => previewModUpdateRollback(), {
              danger: true,
              disabled: state.busy === 'modupdaterollbackplan',
              title: '升级后如果不兼容，把旧 jar 改回原名、新 jar 改名停用留着，一个文件都不删',
            }))]
          : []),
      ),
    );

    // 升级后立刻做的整包兼容性体检：只查静态依赖，结果直接写给人看。
    // 注意 r.compat 是 compatReportAsync 的原始返回，干净标志叫 ok（不是 clean）。
    const c = r.compat;
    if (c) {
      const cLines = Array.isArray(c.lines) ? c.lines : [];
      box.append(
        el('div', { class: 'mcs-subcard' },
          el('div', { class: 'mcs-card-t', text: '升级后的兼容性体检' }),
          kv([
            ['扫到 mod', c.count ?? (c.mods ?? []).length],
            ['互斥打架', (c.conflicts ?? []).length],
            ['缺少前置', (c.missing ?? []).length],
            ['版本对不上', (c.versionMismatch ?? []).length],
            ['装了多份', (c.duplicates ?? []).length],
          ]),
          ...cLines.slice(0, 12).map((line) => el('div', { class: 'mcs-muted', text: line })),
          ...(c.failed ? [el('div', { class: 'mcs-warn', text: `有 ${c.failed} 个 jar 读不出来，已跳过。` })] : []),
          ...(cLines.length === 0
            ? [el('div', { class: c.ok === false ? 'mcs-warn' : 'mcs-muted', text: c.ok === false ? '体检发现问题，建议撤回这次升级。' : '没发现版本兼容问题。' })]
            : []),
        ),
      );
    }
  }

  // 撤回清单：只算不写；写清楚「旧 jar 改回原名、新 jar 停用留着，一个文件都不删」。
  if (state.modUpdateRollbackPlan) {
    const p = state.modUpdateRollbackPlan;
    box.append(
      el('div', { class: 'mcs-subcard' },
        el('div', { class: 'mcs-card-t', text: '撤回清单（还没动文件）' }),
        kv([['准备恢复', (p.items ?? []).length]]),
        ...(p.items ?? []).slice(0, 8).map((it) =>
          el('div', { class: 'mcs-muted', text: `${it.name ?? it.oldName}：把 ${it.oldName} 改回来，${it.newName} 改名停用留着` }),
        ),
        ...(p.skipped ?? []).map((s) => el('div', { class: 'mcs-warn', text: `${s.fileName ?? s.oldName}：${s.message}` })),
        // 后端已经把「一个文件都不删」这种人话写好了，直接摆出来，
        // 别让用户以为撤回 = 删文件。
        ...(p.lines ?? []).slice(0, 8).map((line) => el('div', { class: 'mcs-muted', text: line })),
        row(btn(state.busy === 'modupdaterollbackapply' ? '正在撤回…' : '确认撤回', () => applyModUpdateRollback(), {
          danger: true,
          disabled: state.busy === 'modupdaterollbackapply',
        })),
      ),
    );
  }

  if (state.modUpdateRollbackResult) {
    const r = state.modUpdateRollbackResult;
    box.append(
      el('div', { class: 'mcs-subcard' },
        el('div', { class: r.ok === false ? 'mcs-err' : 'mcs-ok', text: r.applied === false ? '没有需要撤回的升级' : `撤回完成，恢复了 ${(r.restored ?? []).length} 个旧版` }),
        ...(r.failed ?? []).map((f) => el('div', { class: 'mcs-err', text: `${f.name ?? f.fileName ?? ''}：${f.message ?? f.reason ?? '失败'}` })),
        ...(r.lines ?? []).slice(0, 16).map((line) => el('div', { class: 'mcs-muted', text: line })),
      ),
    );
  }

  // 进度条贴在面板尾部；计划卡被清掉后这里还得能显示
  const slot = progressSlot('mod-update');
  if (slot) box.append(slot);
  return box;
}

/** 工具页里那块「从 Modrinth 搜并装」。 */
function modSearchBox() {
  const box = el('div', { class: 'mcs-card' });
  box.append(el('div', { class: 'mcs-card-t', text: '联网装 mod' }));
  box.append(
    el('input', {
      class: 'mcs-input mcs-input-sm',
      placeholder: '搜 Modrinth（英文名最准，如 create）',
      value: state.modSearchQuery,
      'data-focus': 'modsearch',
      oninput: (e) => {
        state.modSearchQuery = e.target.value;
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') void searchMods();
      },
    }),
  );
  box.append(row(btn(state.busy === 'modsearch' ? '搜索中…' : '搜索', () => searchMods(), { primary: true, disabled: state.busy === 'modsearch' })));

  // 版本渠道：默认只看正式版。切了之后版本列表要重取，之前算的清单也作废。
  box.append(row(
    el('span', { class: 'mcs-field-label', text: '版本渠道：' }),
    ...[['release', '正式'], ['beta', '测试'], ['alpha', '开发']].map(([value, label]) =>
      btn(label, () => {
        state.modChannel = value;
        state.modVersions = {};
        state.modVersionOpen = '';
        state.modInstallPlan = null;
        render();
      }, { primary: state.modChannel === value, disabled: state.busy === 'modsearch' }),
    ),
  ));

  for (const hit of (state.modSearchResults ?? []).slice(0, 8)) {
    const key = hit.projectId ?? hit.slug;
    const picked = state.modPicked.includes(key);
    const pinnedId = state.modVersionPick[key] ?? '';
    const versions = state.modVersions[key] ?? [];
    const pinnedVersion = versions.find((v) => v.versionId === pinnedId);
    const hitCard = el(
      'div',
      {
        class: `mcs-hit mcs-pickable${picked ? ' mcs-pick-on' : ''}`,
        onclick: () => togglePickMod(key),
      },
      el('div', { class: 'mcs-hit-name' },
        el('span', { class: `mcs-tick${picked ? ' mcs-tick-on' : ''}`, text: picked ? '✓' : '' }),
        el('span', { text: hit.title ?? hit.name ?? hit.slug }),
      ),
      el('div', { class: 'mcs-hit-meta', text: `${hit.slug ?? hit.projectId ?? ''} · ${hit.downloads ?? 0} 下载` }),
      // 点名了具体版本就显出来，免得用户以为还在自动挑最新
      pinnedId ? el('div', { class: 'mcs-ok', text: `已选版本：${pinnedVersion?.versionNumber ?? pinnedId}` }) : null,
      row(
        // 整行 onclick 是「勾选」，内层按钮必须掐断冒泡，否则点一下等于又勾又取消
        btn('只看这个', (e) => { e?.stopPropagation?.(); void previewInstall(key); }, { disabled: state.busy === 'modplan' }),
        btn(state.modVersionOpen === key ? '收起版本' : '选版本', (e) => { e?.stopPropagation?.(); void loadModVersions(key); }, { disabled: state.busy === 'modversions' }),
      ),
    );
    if (state.modVersionOpen === key) {
      const sub = el('div', { class: 'mcs-subcard', onclick: (e) => e?.stopPropagation?.() });
      if (state.busy === 'modversions') {
        sub.append(el('div', { class: 'mcs-muted', text: '正在取版本列表…' }));
      } else if (versions.length === 0) {
        sub.append(el('div', { class: 'mcs-muted', text: '没取到版本（可能网络不通或这个工程没有匹配的版本）' }));
      }
      for (const v of versions.slice(0, 12)) {
        const chosen = v.versionId === pinnedId;
        // 版本类型 · 大小 · 各种「不匹配」的提醒
        const metaParts = [
          v.versionType ?? '',
          v.sizeText ?? '',
          v.compatible === false ? '与当前加载器不匹配' : '',
          v.mcCompatible === false ? '不适合你的 MC 版本' : '',
        ].filter(Boolean);
        // 这个版本适配哪些 MC 版本：只显示前 3 个，多了加个省略号
        const gvs = Array.isArray(v.gameVersions) ? v.gameVersions.filter(Boolean) : [];
        const gvText = gvs.length === 0
          ? ''
          : `适配 ${gvs.slice(0, 3).join('、')}${gvs.length > 3 ? '…' : ''}`;
        sub.append(
          el('button', {
            class: `mcs-pick-item${chosen ? ' mcs-pick-on' : ''}`,
            onclick: (e) => { e?.stopPropagation?.(); pickModVersion(key, v.versionId); },
          },
            // 每一项竖着排三行：版本号（带「推荐」标记）/ 说明 / 适配的 MC 版本
            el('span', { style: 'display:block' },
              el('span', { style: 'display:block' },
                el('span', { class: 'mcs-pick-name', text: `${chosen ? '✓ ' : ''}${v.versionNumber ?? v.versionId}` }),
                // 「推荐」= 后端算出来最适合这个整合包的那条（MC 版本 + 加载器 + 正式版优先）
                v.recommended === true ? el('span', { class: 'mcs-ok', text: ' 推荐' }) : null,
              ),
              el('span', { class: 'mcs-pick-meta', style: 'display:block', text: metaParts.join(' · ') }),
              gvText ? el('span', { class: 'mcs-pick-meta', style: 'display:block', text: gvText }) : null,
            ),
          ),
        );
      }
      hitCard.append(sub);
    }
    box.append(hitCard);
  }

  // 选了几个、一起装。以前只能一个一个点「看要下什么」，点完还看不出选没选中。
  if (state.modPicked.length) {
    const bar = el('div', { class: 'mcs-subcard' },
      el('div', { class: 'mcs-muted', text: `选中了 ${state.modPicked.length} 个：${state.modPicked.join('、')}` }),
      row(
        btn(state.busy === 'modplan' ? '正在算…' : `一起装这 ${state.modPicked.length} 个`, () => previewInstallMany(state.modPicked), { primary: true, disabled: state.busy === 'modplan' }),
        btn('清空选择', () => { state.modPicked = []; render(); }),
      ),
    );
    box.append(bar);
  }

  if (state.modInstallPlan) {
    const p = state.modInstallPlan;
    const pickedList = p.projectIds?.length ? p.projectIds : [p.projectId].filter(Boolean);
    const planCard = el('div', { class: 'mcs-subcard' },
      kv([
        ['要装', pickedList.length > 1 ? `${pickedList.length} 个 mod` : (p.projectId ?? '—')],
        ['文件数', (p.items ?? []).length],
        ['总大小', p.totalText ?? '—'],
      ]),
      ...(pickedList.length > 1 ? [el('div', { class: 'mcs-muted', text: pickedList.join('、') })] : []),
      // 下载目录：留空 = 装到整合包自己的 mods 目录；填别的目录 = 文件下到那里，得自己挪。
      el('div', { class: 'mcs-field-label', text: '下载目录' }),
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder: '留空 = 装到整合包自己的 mods 目录',
        value: state.modTargetDir ?? '',
        'data-focus': 'modtargetdir',
        oninput: (e) => {
          state.modTargetDir = e.target.value;
        },
      }),
      row(
        btn('选个目录…', (e) => { e?.stopPropagation?.(); void pickModTargetDir(); }, { disabled: state.busy === 'modtargetdir' }),
        btn('用默认目录', (e) => {
          e?.stopPropagation?.();
          state.modTargetDir = '';
          render();
        }, { disabled: state.busy === 'modtargetdir' || !state.modTargetDir }),
      ),
      el('div', { class: 'mcs-muted', text: '留空 = 装到整合包自己的 mods 目录；填别的目录 = 文件下到那里，需要你自己挪进 mods 目录。' }),
      // 后端算出来的实际安装位置（有 targetDir 才显示）
      p.targetDir ? el('div', { class: 'mcs-muted', text: `实际会装到：${p.targetDir}` }) : null,
      ...(p.items ?? []).slice(0, 8).map((it) => el('div', { class: 'mcs-muted', text: `${it.name ?? it.file ?? it.fileName ?? it.title ?? ''} · ${it.sizeText ?? ''}` })),
      // 装之前这个包本来就有的毛病（互斥 / 缺前置 / 版本对不上 / 装了多份）
      ...(Array.isArray(p.compat?.lines) && p.compat.lines.length
        ? [
          el('div', { class: 'mcs-field-label', text: '这个包现在已有的兼容问题' }),
          ...p.compat.lines.map((line) => el('div', { class: 'mcs-muted', text: line })),
        ]
        : []),
      row(btn('就装这些', () => applyInstall(), { primary: true, disabled: state.busy === 'modapply' })),
    );
    // 正在下的时候，进度条就贴在这个按钮下面
    const mine = progressSlot('mod-install');
    if (mine) planCard.append(mine);
    box.append(planCard);
  }
  if (state.modInstalled) {
    const r = state.modInstalled;
    box.append(
      el('div', { class: 'mcs-subcard' },
        el('div', { class: 'mcs-ok', text: `装好了 ${(r.installed ?? []).length} 个文件` }),
        ...(r.failed ?? []).map((f) => el('div', { class: 'mcs-err', text: `${f.name ?? ''}：${f.reason ?? '失败'}` })),
      ),
    );
  }
  // 装完之后 box 里也得有进度条 —— 上面那张计划卡已经被 applyInstall 清掉了
  if (!state.modInstallPlan) {
    const slot = progressSlot('mod-install');
    if (slot) box.append(slot);
  }
  return box;
}

/**
 * 中栏工具页：补全物品图标（独立页 + 文件菜单入口）。
 *
 * 后端 / core 一个字不改：体检结果、强制重扫都是现成接口，这一页只是把
 * README 里「让游戏自己画图标」的五步做成能点开、能复制命令的教学卡。
 * 用户包只读 —— mod 要用户自己下、命令在游戏聊天框里打、PNG 是游戏写的。
 */
function iconGuidePane() {
  const g = state.iconGuide;
  const status = state.iconExport.status;
  const scanning = state.iconExport.scanning;
  const box = el('div', { class: 'mcs-center' });
  box.append(el('div', { class: 'mcs-center-t' },
    el('span', { text: '补全物品图标' }),
    el('span', { class: 'mcs-spacer' }),
    btn(scanning ? '正在扫…' : '重新扫描图标', () => iconExportScan(), { primary: true, disabled: scanning, title: '读一遍游戏导出的图标目录（平时有 10 分钟缓存）' }),
  ));
  const body = el('div', { class: 'mcs-pane-body' });

  // 第一张卡：现状 + 为什么需要这一步。文案复用任务书顶栏那一行的口径。
  body.append(card('现在的情况',
    el('div', { class: 'mcs-muted', text: `图标：${status?.text ?? '还没体检'}` }),
    el('div', { class: 'mcs-muted', text: '游戏里每个物品长什么样，是模型、材质和光照一起画出来的；整合包里只有数据，没有画好的图标。想让侧边栏每个格子都有图，最准的办法是让游戏自己画一遍、存成图片，工作室再读。' }),
  ));

  // 第二张卡：默认收起一句话，点开才展开五步（抄 deepScanCard 的两态）。
  if (!g.open) {
    body.append(card('怎么让游戏帮我把图标画出来？',
      el('div', { class: 'mcs-muted', text: '装两个小 mod → 进一次游戏 → 打一条命令，游戏就会把所有物品画成图片存好。全程不联网、不改你的包。' }),
      row(btn('看这五步怎么做', () => { g.open = true; render(); }, { primary: true })),
    ));
  } else {
    const steps = el('div', { class: 'mcs-card' });
    steps.append(el('div', { class: 'mcs-card-t', text: '五步：让游戏自己画出全部图标' }));
    steps.append(el('div', { class: 'mcs-muted', text: '① 自己去 Modrinth 下载 Icon Exporter（工程编号 8KCmS7Bd）和它的前置 Cyclops Core（Z9DM0LJ4），两个都放进整合包的 mods 文件夹。工作室不会替你下载，也不联网。' }));
    steps.append(el('div', { class: 'mcs-muted', text: '② 照常启动游戏，进「单人游戏」→「新建世界」，进到世界里。' }));
    steps.append(el('div', { class: 'mcs-muted', text: '③ 按 T 打开聊天框，输入下面这条命令（64 是图标边长，别改），回车：' }));
    steps.append(el('pre', { class: 'mcs-code mcs-code-sm', text: '/iconexporter export 64' }));
    // 复制按钮只改自己那一小块文字，绝不 render() 整页 —— 否则按钮被换掉，复制结果看不到。
    const copyBtn = btn(g.copied ? '已复制' : '复制命令', async () => {
      try {
        await navigator.clipboard.writeText('/iconexporter export 64');
        g.copied = true;
        copyBtn.textContent = '已复制';
      } catch (err) {
        copyBtn.textContent = '复制不了，手动选中上面那行';
      }
    }, { disabled: g.copied });
    steps.append(row(copyBtn));
    steps.append(el('div', { class: 'mcs-muted', text: '④ 等 1–3 分钟，游戏会把所有物品画成透明底图片，存到整合包目录里一个叫 icon-exports-x64 的文件夹（一张图一个物品，文件名是「mod 名__物品名.png」）。' }));
    steps.append(el('div', { class: 'mcs-muted', text: '⑤ 回到工作室点右上角「重新扫描图标」，上面「现在的情况」就会变成「图标：游戏导出的高清图 XXXX 个」。以后侧边栏优先用这些高清图。' }));
    steps.append(el('div', { class: 'mcs-muted', text: '这一页只教你怎么让游戏导出、以及读游戏导出的图片：不会替你下载 mod、不会改整合包里的任何文件，所有图片都是游戏自己写的。' }));
    body.append(steps);
  }

  // 第三张卡：和图标同一个思路 —— 让游戏自己「报一遍」它到底注册了哪些物品，
  // 网格就能做到 100% 精确（2026-11-07 任务③）。默认收起，点开才展开。
  if (!g.truthOpen) {
    body.append(card('想让物品清单也 100% 精确？',
      el('div', { class: 'mcs-muted', text: '光扫文件会混进游戏里其实没有的东西。同样让游戏自己报一遍，网格就只显示游戏里真有的物品。没做这一步时网格显示全部，不会空白。' }),
      row(btn('看怎么导出游戏清单', () => { g.truthOpen = true; render(); }, { primary: true })),
    ));
  } else {
    const truthSteps = el('div', { class: 'mcs-card' });
    truthSteps.append(el('div', { class: 'mcs-card-t', text: '四步：让游戏自己报一遍物品清单' }));
    truthSteps.append(el('div', { class: 'mcs-muted', text: '① 把工作室项目里那个小探针 mod（jeidump.jar，在 lab/jeidump/build/ 下，需要的话让模型帮你编译一次）放进整合包的 mods 文件夹。它只做一件事：进世界时把游戏里注册过的物品列成一张清单。' }));
    truthSteps.append(el('div', { class: 'mcs-muted', text: '② 照常启动游戏、进一次世界。游戏目录里会生成一个叫 jeidump.json 的文件，那就是游戏亲口报的清单。' }));
    truthSteps.append(el('div', { class: 'mcs-muted', text: '③ 回到工作室，在右栏「物品」页点「导入游戏清单…」，选那个游戏目录（或直接选 jeidump.json）。清单只存进软件自己的数据目录，不写进你的整合包。' }));
    truthSteps.append(el('div', { class: 'mcs-muted', text: '④ 网格会自动切成「只显示游戏里真有的」（100% 精确）。换整合包、或大改 mod 之后，重进一次世界再导一遍就行。想看全部旧数据，点一下「显示全部」开关随时能切回来。' }));
    truthSteps.append(el('div', { class: 'mcs-muted', text: '和上面的图标补全一样：都是让游戏自己产出数据、工作室只读，不联网、不改你的整合包。' }));
    body.append(truthSteps);
  }
  box.append(body);
  return box;
}

/**
 * 中栏总入口：按 state.panel 换内容。
 *
 * 任务书（canvasPane）是主界面；content / pack / verify / checkup / mods
 * 都是工具页，从菜单栏进，不占页签。每个面板自己负责顶上的标题行。
 */
function centerPane() {
  if (state.panel === 'content') return contentPane();
  if (state.panel === 'pack') return packPane();
  if (state.panel === 'verify') return verifyPane();
  if (state.panel === 'checkup') return checkupPane();
  if (state.panel === 'mods') return modsPane();
  if (state.panel === 'analysis') return analysisPane();
  if (state.panel === 'mcp') return mcpPane();
  if (state.panel === 'iconguide') return iconGuidePane();
  return canvasPane();
}

/** 中栏：任务书蓝图编辑（一个页签 = 一章）。 */
function canvasPane() {
  const pane = el('div', { class: 'mcs-center' });

  if (!state.questBook) {
    pane.append(
      el('div', { class: 'mcs-empty mcs-empty-big' },
        el('div', { text: '这个包里没读到任务书。' }),
        el('div', { class: 'mcs-muted', text: '装上 FTB Quests 并做几个任务，这里就会出现蓝图。' }),
      ),
    );
    return pane;
  }
  if (!state.canvas) {
    pane.append(el('div', { class: 'mcs-empty mcs-empty-big', text: state.busy === 'connect' ? '正在读蓝图…' : '蓝图还没读出来' }));
    return pane;
  }

  const chapterId = state.canvasChapterId;
  if (!chapterId) {
    pane.append(
      el('div', { class: 'mcs-empty mcs-empty-big' },
        el('div', { text: '左边点一章，就在这里开一个页签。' }),
        el('div', { class: 'mcs-muted', text: '一章一个页签，最多开 8 个；每章的画布位置、选择、撤销都各管各的。' }),
      ),
    );
    return pane;
  }

  const chapter = (state.canvas.chapters ?? []).find((c) => c.id === chapterId);
  pane.append(
    el('div', { class: 'mcs-center-t' },
      el('span', { text: chapter?.title ?? chapterId }),
      el('span', { class: 'mcs-muted', text: `${(chapter?.nodes ?? []).length} 个任务` }),
      el('span', { class: 'mcs-spacer' }),
      // 新建任务 / 新章节搬到左栏标题行、装饰图搬到空白右键；语言进「设置」菜单、
      // 「预览」搬到顶部菜单栏（2026-11-09 用户点名的四处位置调整）。
      el('span', {
        class: 'mcs-muted',
        text: state.questBook
          ? `${state.questBook.questCount ?? 0} 个任务 · ${state.questBook.chapterCount ?? 0} 章`
          : '没读到任务书',
      }),
      // 图标现状一行：告诉用户物品图标的来源（游戏导出 / mod jar 直取）和数量。
      // 数据在 refreshCanvas 时懒查；没查到前不占位，免得每次渲染都闪。
      state.iconExport.status
        ? el('span', {
            class: 'mcs-muted',
            title: state.iconExport.status.hasExport
              ? `图标来自游戏内 Icon Exporter 的导出目录（${(state.iconExport.status.dirs ?? []).join('、')}）`
              : '没有游戏导出的高清图标，物品图标直接从 mod jar 里取（普通分辨率）',
            text: `图标：${state.iconExport.status.text ?? ''}`,
          })
        : null,
      btn(state.iconExport.scanning ? '正在扫…' : '重扫', () => iconExportScan(), {
        disabled: state.iconExport.scanning,
        title: '强制重新体检图标导出目录（平时有 10 分钟缓存）',
      }),
      btn('重新读', () => run('canvas', async () => { state.questBook = await api('/questbook', { dir: state.dir, id: state.instanceId }); await refreshCanvas(); }), { disabled: state.busy === 'canvas' }),
    ),
  );

  pane.append(canvasSvg());
  // 放置模式提示条（2026-11-13 方案甲）：进放置态后顶栏出一条横幅，
  // 告诉用户「点画布定位置」，并给一个取消入口 —— 否则用户会不知道为什么
  // 点节点没反应了（`beginBand` 在放置态是让位的）。
  if (state.placing) {
    pane.append(
      el('div', { class: 'mcs-placing-bar' },
        el('span', { class: 'mcs-placing-dot' }),
        el('span', { text: state.placing.hint }),
        el('span', { class: 'mcs-spacer' }),
        el('span', { class: 'mcs-muted', text: '按 Esc 也能取消' }),
        btn('取消', () => cancelPlacing()),
      ),
    );
  }
  pane.append(
    el('div', { class: 'mcs-hint', text: '拖动就保存（Ctrl+Z 撤销）· 空白处拖动框选，或 Ctrl/Shift+点击加选，选中的一起拖 · 右键改任务 · 空白处双击新建 · 滚轮缩放 · 中键平移' }),
  );
  return pane;
}

/** 把画布数据画成 SVG（拖动 + 右键）。只画当前页签那一章的节点。 */
function canvasSvg() {
  const chapters = state.canvas?.chapters ?? [];
  // 坐标包围盒只按这一章的节点算 —— 按全部任务算的话，章里只有右上角
  // 几个任务时画布会显得空。（以前还有「全部」视图，现在一章一个页签，没有了。）
  const visibleChapters = chapters.filter((c) => c.id === state.canvasChapterId);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const chapter of visibleChapters) {
    for (const node of chapter.nodes ?? []) {
      minX = Math.min(minX, node.x ?? 0);
      minY = Math.min(minY, node.y ?? 0);
      maxX = Math.max(maxX, node.x ?? 0);
      maxY = Math.max(maxY, node.y ?? 0);
    }
  }
  if (!Number.isFinite(minX)) return el('div', { class: 'mcs-empty mcs-empty-big', text: '这本书里还没有任务' });

  const pad = 48;
  // 节点包围盒是 px/py 的基准，也是反算格子、拖动辅助线的基准，绝不能把大图算进来
  // —— 否则 minX 变负，第一帧节点会被推到屏幕右边去。
  const px = (x) => (x - minX) * CELL_X + pad;
  const py = (y) => (y - minY) * CELL_Y + pad;
  // 另外算一个「内容包围盒」：节点占 [minX, maxX+1] 格，背景图 x/y 是中心、占
  // ±宽/2、±高/2。只用来报出画布内容尺寸（dataset.contentW/H），不影响任何定位。
  let contentMinX = minX;
  let contentMinY = minY;
  let contentMaxX = maxX + 1;
  let contentMaxY = maxY + 1;
  for (const chapter of visibleChapters) {
    for (const im of chapter.images ?? []) {
      contentMinX = Math.min(contentMinX, (im.x ?? 0) - (im.width ?? 0) / 2);
      contentMinY = Math.min(contentMinY, (im.y ?? 0) - (im.height ?? 0) / 2);
      contentMaxX = Math.max(contentMaxX, (im.x ?? 0) + (im.width ?? 0) / 2);
      contentMaxY = Math.max(contentMaxY, (im.y ?? 0) + (im.height ?? 0) / 2);
    }
  }
  const width = (contentMaxX - contentMinX) * CELL_X + pad * 2;
  const height = (contentMaxY - contentMinY) * CELL_Y + pad * 2;
  // 蓝图式编辑：把纯数字几何记下来，拖物品 / 粘贴时按鼠标位置反算「落在哪个节点 / 哪个格子」。
  // 别把 svg / 容器这种 DOM 节点塞进 state —— state 会被打印，循环引用。
  state.canvasGeom = { pad, minX, minY };

  // 画布原点是「所有节点的包围盒左上角」，数据一变（比如把最左边的任务往右挪）
  // 原点就跟着变，整张图会整体平移 —— 看起来像「默认被吸到左边」。
  // 屏幕坐标 screen = tx + (X - minX) * CELL，要让同一个 X 的屏幕位置不动，
  // 就得让 tx 跟着 minX 一起变：tx += (minX - 旧minX) * CELL * scale。
  const origin = state.canvasOrigin;
  if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
    const scale = state.view.scale || 1;
    state.view.tx += scale * (minX - origin.x) * CELL_X;
    state.view.ty += scale * (minY - origin.y) * CELL_Y;
  }
  state.canvasOrigin = { x: minX, y: minY };

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  // svg 铺满容器（100%），不再按内容包围盒定尺寸。
  //
  // 以前是按内容算 width/height：图小的时候 svg 比容器小，鼠标一移出 svg
  // 滚轮就没人收了 —— 这就是「缩放时灵时不灵」。铺满之后整个可见区域都能缩放，
  // 而且内容超出容器也不会被裁掉（没有 viewBox，坐标就是像素，不会被二次缩放）。
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svg.dataset.contentW = String(width);
  svg.dataset.contentH = String(height);

  const s = (tag, attrs = {}, text) => svgEl(tag, attrs, text);

  const byId = new Map();
  // byId 建全量（跨章依赖编辑列表还要用）；但连线只画「两端都在当前视图里」的 ——
  // 按章过滤时画到别的章的线没意义，还会把画布撑大。
  for (const chapter of chapters) for (const node of chapter.nodes ?? []) byId.set(node.id, node);
  const visibleIds = new Set();
  for (const chapter of visibleChapters) for (const node of chapter.nodes ?? []) visibleIds.add(node.id);

  // 平移缩放作用在这一层上，而不是 svg 本身：
  // 直接 transform 根 svg 会让浏览器把它整体提升成合成层，拖动时旧位置
  // 有时不被重绘，屏幕上就留一块黑框（用户反馈过）。套一层 <g> 就没有这个问题。
  const viewport = s('g', { class: 'mcs-viewport' });

  // 章节背景图 / 装饰图压在最底层（任务和连线都画在它上面）。
  // 单章视图才画：images 属于章节，「全部」视图叠在一起会乱。
  // 坐标是任务格单位，跟节点同一套 px/py 换算；半透明融入深色画布。
  const singleChapter = visibleChapters.length === 1 ? visibleChapters[0] : null;
  // 序号要和后端文件里的下标对上：后端按「有 image 且宽高都 > 0」过滤，
  // 所以这里也只给能画出来的那几张编号，别拿循环下标当 index。
  let imageIndex = -1;
  for (const im of singleChapter?.images ?? []) {
    imageIndex += 1;
    const index = imageIndex;
    const href = state.questImages[im.image];
    if (!href) continue;
    const w = im.width * CELL_X;
    const h = im.height * CELL_Y;
    // 游戏里 x/y 是图片「正中心」（FTB Quests QuestPanel.alignWidgets / draw），
    // 以前当左上角画：半宽半高错开，大图铺到右下、节点挤在左上（2026-11-11 修）。
    const left = px(im.x) - w / 2;
    const top = py(im.y) - h / 2;
    const attrs = {
      href,
      x: left,
      y: top,
      width: w,
      height: h,
      class: 'mcs-quest-bg',
      preserveAspectRatio: 'none',
      'data-image-index': index,
    };
    // rotation 绕中心转；corner（alignToCorner=true）时绕图片左上角转。
    // 0 度不挂 transform：真包 9 章和测试替身全是 0 度，行为与旧版完全一致。
    const rotation = Number(im.rotation ?? 0) || 0;
    let baseTransform = '';
    if (rotation) {
      const cx = im.corner ? left : px(im.x);
      const cy = im.corner ? top : py(im.y);
      baseTransform = `rotate(${rotation} ${cx} ${cy})`;
      attrs.transform = baseTransform;
    }
    const img = s('image', attrs);
    // 背景图默认 pointer-events:none（点它等于点画布）。这里单张放开：
    // 要能拖它、右键它，就得让它自己接事件。
    img.addEventListener('pointerdown', (e) => beginImageDrag(e, { el: img, image: im, index, baseTransform }));
    img.addEventListener('contextmenu', (e) => {
      e.preventDefault?.();
      e.stopPropagation?.();
      if (state.suppressContextMenu) {
        state.suppressContextMenu = false;
        return;
      }
      openImageMenu(e, { image: im, index });
    });
    viewport.append(img);
  }

  // 连线先画，压在节点下面。每条线都记下两端是谁、原始坐标，
  // 拖动的时候好按位移实时改（不然线要等松手才动）。
  const edgeEls = [];
  for (const node of byId.values()) {
    if (!visibleIds.has(node.id)) continue;
    for (const dep of node.dependencies ?? []) {
      const from = byId.get(dep.id);
      if (!from || !visibleIds.has(from.id)) continue;
      const geo = {
        x1: px(from.x ?? 0) + BOX_W / 2,
        y1: py(from.y ?? 0) + BOX_H,
        x2: px(node.x ?? 0) + BOX_W / 2,
        y2: py(node.y ?? 0),
      };
      const line = s('line', { ...geo, class: 'mcs-edge' });
      viewport.append(line);
      edgeEls.push({ el: line, fromId: from.id, toId: node.id, ...geo });
    }
  }
  state.edgeEls = edgeEls;

  // 框选用的矩形放在最上层，平时是空的
  const bandRect = s('rect', { class: 'mcs-band', x: 0, y: 0, width: 0, height: 0, style: 'display:none' });

  const nodeEls = {};
  // 游戏观感模式需要一个 <defs> 放形状遮罩（<mask>）。没有它浏览器不认 url(#id)。
  const gameLook = state.canvasLook === 'game';
  const defs = gameLook ? s('defs') : null;
  for (const node of byId.values()) {
    if (!visibleIds.has(node.id)) continue;
    const x = px(node.x ?? 0);
    const y = py(node.y ?? 0);
    const selected = state.selSet.includes(node.id);
    const g = s('g', { class: selected ? 'mcs-node mcs-node-sel' : 'mcs-node', 'data-quest': node.id });
    // 游戏观感：节点画成 FTB 的样子（形状贴图叠三层），画不出来才退回矩形。
    const drewGame = gameLook && drawGameNode(g, node, x + BOX_W / 2, y + BOX_H / 2, defs, selected);
    if (!drewGame) {
      g.append(
        s('rect', {
          x,
          y,
          width: BOX_W,
          height: BOX_H,
          rx: 10,
          class: selected ? 'mcs-box mcs-box-sel' : 'mcs-box',
        }),
      );
      if (node.icon && state.icons[node.icon]) {
        // draggable=false：不然鼠标一拖浏览器会去拖这张图，拖出一个黑方块幽灵
        g.append(s('image', { x: x + 12, y: y + 12, width: 26, height: 26, href: state.icons[node.icon], draggable: 'false' }));
      } else {
        g.append(s('rect', { x: x + 12, y: y + 12, width: 26, height: 26, rx: 5, class: 'mcs-box-ph' }));
      }
      g.append(s('text', { x: x + 46, y: y + 26, class: 'mcs-node-title' }, truncate(node.title || node.id, 9)));
      // 0 个要求就不写这一行（2026-11-11：有的任务只有标题没条件，
      // 画个「0 个要求」纯属噪音，用户明确说这种任务是正常的）
      if ((node.taskCount ?? 0) > 0) {
        g.append(s('text', { x: x + 46, y: y + 42, class: 'mcs-node-sub' }, `${node.taskCount} 个要求`));
      }
      // ★ 2026-11-12 用户：「编辑器视角下也改掉」—— 和游戏观感对齐，
      //   节点上不再写**图标 ID** 和**坐标**这两行纯技术信息。
      //
      //   为什么不是连标题一起删：编辑器视角是拿来改东西的，节点上没名字就
      //   不知道该点哪个。用户说的是「表现形式」（游戏里只有图标），
      //   而这两行（`minecraft:diamond_sword`、`(3, -2)`）游戏里从来没有、
      //   编辑时也很少看 —— 想核对坐标可以点开右栏，那里有准确值。
      //   所以这里保留「标题 + N 个要求」，去掉下面两行。
    }
    g.addEventListener('pointerdown', (e) => beginDrag(e, node, g));
    g.addEventListener('click', (e) => {
      // 拖动结束时浏览器补的那个 click，不能让它把多选收成单选
      if (state.suppressClick) {
        state.suppressClick = false;
        return;
      }
      // Ctrl / Cmd / Shift + 点击 = 加选 / 减选（不用非得框选）
      if (e?.ctrlKey || e?.metaKey || e?.shiftKey) {
        toggleSelect(node.id);
        return;
      }
      // ★ 预览态（游戏观感）下点节点 = 「在游戏里点开这个任务」——
      //   弹出画布正中的预览窗口，看到翻页/图片/打勾那一整套（2026-11-12 用户要求）。
      //   编辑态还是原来的行为（右栏出详情、可以改）。
      if (state.canvasLook === 'game') {
        void openQuestPreview(node.id);
        return;
      }
      void selectQuest(node.id);
    });
    g.addEventListener('contextmenu', (e) => {
      e.preventDefault?.();
      // 别让这次右键冒泡到画布容器，否则空白菜单会把节点菜单盖掉。
      e.stopPropagation?.();
      // 刚用右键拖过画布：这次右键是「平移」不是「叫菜单」
      if (state.suppressContextMenu) {
        state.suppressContextMenu = false;
        return;
      }
      openMenu(e, node.id);
    });
    nodeEls[node.id] = g;
    viewport.append(g);
  }
  viewport.append(bandRect);
  // 拖动对齐参考线：一竖一横两条虚线，平时藏起来，快跟别的任务对齐时才亮。
  // 跟框选矩形一样放在节点上层；画在 viewport 未缩放坐标系，平移缩放由这层 transform 兜着。
  const guideV = s('line', { class: 'mcs-guide', style: 'display:none' });
  const guideH = s('line', { class: 'mcs-guide', style: 'display:none' });
  viewport.append(guideV);
  viewport.append(guideH);
  state.guideEls = { v: guideV, h: guideH };
  // 形状遮罩放在 defs 里（不在 defs 里浏览器不认 url(#id)，形状就整块不见）。
  if (defs) svg.append(defs);
  state.nodeEls = nodeEls;
  state.viewportEl = viewport;
  svg.append(viewport);

  // 视口：平移 + 缩放都靠这一层的 transform
  applyView();

  // ⚠️ 事件要挂在「外层容器」上，不能挂 svg 自己。
  //
  // svg 的宽高是按内容包围盒算出来的（上面 width/height），
  // 一旦缩小到比容器还小，鼠标落在 svg 外面那块空白上就**谁都收不到事件**，
  // 于是「滚轮缩放时灵时不灵」。容器是 flex:1，永远铺满可见区域，挂它才稳。
  const container = el('div', { class: 'mcs-canvas' });
  container.append(svg);
  // 快捷键作用域：点这块 = 「现在在画布上」，Ctrl+C/V/Z/Y 操作任务节点
  bindKeyScope(container, 'canvas');
  // 模块级记一下容器：拖物品 / 粘贴要按鼠标位置算画布坐标。
  canvasHostEl = container;
  // 鼠标在画布上的最后位置，Ctrl+V 粘贴时当落点。
  container.addEventListener('pointermove', (e) => {
    state.canvasPointer = { clientX: e.clientX ?? 0, clientY: e.clientY ?? 0 };
  });

  container.addEventListener('pointerdown', (e) => beginBand(e, container, bandRect, { byId, visibleIds, px, py }));
  container.addEventListener('wheel', (e) => zoomAt(e, container), { passive: false });
  container.addEventListener('dblclick', (e) => onCanvasDoubleClick(e, container, pad, minX, minY));
  // 放置模式：在画布上点一下 = 把新任务放这儿（2026-11-13，方案甲）
  //   ⚠️ 用 click 而不是 pointerdown：pointerdown 会被上面那个 beginBand 和
  //      节点自己的拖动抢走；click 是「按下+松开都在原地」之后才来的，最接近
  //      FTB 里 `CreateTaskAtMessage` 收的「鼠标松手点」。
  container.addEventListener('click', (e) => placeAt(e, container, pad, minX, minY));
  beginRightPan(container);
  // 别让浏览器接管拖拽（否则拖节点会变成拖图片，出现一个黑框幽灵）
  container.addEventListener('dragstart', (e) => e.preventDefault?.());
  // 中键在浏览器里默认是「自动滚动」，会把平移抢走
  container.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault?.();
  });

  // ★ 预览态下点开任务，在**画布正中**浮一个游戏窗口（2026-11-12 用户要求）。
  //   挂在画布容器里而不是整页：这样它天然居中在画布区，也不会盖住左侧章节
  //   列表和右栏 —— 用户上一轮刚要求过「别挡左右两栏」。
  const win = questPreviewWindow();
  if (win) container.append(win);

  return container;
}

/**
 * 右键拖动 = 平移画布（UE 蓝图和 Unity 都是这个规矩）。
 *
 * 为什么要单独一条：左键在画布上是「框选」、在节点上是「拖动」，
 * 这两个才是左键的正经用途；平移这种随时要用的操作得有个不抢东西的键。
 *
 * 细节：
 * - 按下先不记「在平移」，等真移动超过 3 像素才算 —— 否则「右键点一下节点弹菜单」
 *   会被误当成平移；
 * - 真平移过就把 `state.suppressContextMenu` 立起来，松手时把随之而来的菜单吞掉；
 * - 浏览器自己的右键菜单一律拦掉（节点上的菜单是节点自己 pointerdown 之外处理的，
 *   这里只拦空白处的）。
 */
function beginRightPan(host) {
  if (typeof document.addEventListener !== 'function') return;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let tx0 = 0;
  let ty0 = 0;

  // 拦浏览器右键菜单：节点上的 contextmenu 会先拦下来弹自己的菜单；
  // 空白处右键弹「新建任务 / 搜索物品」；刚用右键拖过画布（平移）就什么都不弹。
  host.addEventListener('contextmenu', (event) => {
    event.preventDefault?.();
    const suppress = state.suppressContextMenu;
    state.suppressContextMenu = false;
    if (suppress) return;
    openBlankMenu(event, host);
  });

  host.addEventListener('pointerdown', (event) => {
    if (event.button !== 2) return;
    event.preventDefault?.();
    dragging = false;
    startX = event.clientX ?? 0;
    startY = event.clientY ?? 0;
    tx0 = state.view.tx;
    ty0 = state.view.ty;

    const onMove = (e) => {
      const dx = (e.clientX ?? 0) - startX;
      const dy = (e.clientY ?? 0) - startY;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < 3) return;
      dragging = true;
      host.classList?.add?.('mcs-panning');
      state.view.tx = tx0 + dx;
      state.view.ty = ty0 + dy;
      applyView();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      host.classList?.remove?.('mcs-panning');
      if (dragging) state.suppressContextMenu = true;
      dragging = false;
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

/** 把平移缩放写到画布那一层（<g class="mcs-viewport">）上。 */
function applyView() {
  const group = state.viewportEl;
  if (!group) return;
  const { scale, tx, ty } = state.view;
  group.setAttribute('style', `transform: translate(${tx}px, ${ty}px) scale(${scale}); transform-origin: 0 0;`);
}

/**
 * 拖动过程中把相连的线跟着挪。
 * 每条线都存了原始坐标，所以每次都按「原始坐标 + 位移」重算，不会越拖越偏。
 */
function shiftEdges(draggedIds, dx, dy) {
  const moving = new Set(draggedIds);
  for (const edge of state.edgeEls ?? []) {
    const fromMoving = moving.has(edge.fromId);
    const toMoving = moving.has(edge.toId);
    if (!fromMoving && !toMoving) continue;
    edge.el.setAttribute('x1', String(edge.x1 + (fromMoving ? dx : 0)));
    edge.el.setAttribute('y1', String(edge.y1 + (fromMoving ? dy : 0)));
    edge.el.setAttribute('x2', String(edge.x2 + (toMoving ? dx : 0)));
    edge.el.setAttribute('y2', String(edge.y2 + (toMoving ? dy : 0)));
  }
}

/** 滚轮缩放（围着鼠标那个点缩放，跟 UE 一样）。 */
function zoomAt(event, host) {
  event.preventDefault?.();
  const rect = host?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
  const cx = (event.clientX ?? 0) - (rect.left ?? 0);
  const cy = (event.clientY ?? 0) - (rect.top ?? 0);
  const factor = (event.deltaY ?? 0) > 0 ? 0.9 : 1.1;
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (state.view.scale || 1) * factor));
  const k = next / (state.view.scale || 1);
  state.view.tx = cx - (cx - state.view.tx) * k;
  state.view.ty = cy - (cy - state.view.ty) * k;
  state.view.scale = next;
  applyView();
}

/** 屏幕坐标 → 画布坐标（扣掉平移缩放）。 */
function toCanvasPoint(event, host) {
  const rect = host?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
  const scale = state.view.scale || 1;
  return {
    x: ((event.clientX ?? 0) - (rect.left ?? 0) - state.view.tx) / scale,
    y: ((event.clientY ?? 0) - (rect.top ?? 0) - state.view.ty) / scale,
  };
}

/**
 * 空白处按下：中键平移，左键框选。
 * 点在节点上的时候，节点的 handler 会 stopPropagation，走不到这里。
 */
function beginBand(event, svg, bandRect, ctx) {
  if (typeof document.addEventListener !== 'function') return;

  // 放置模式（2026-11-13）：这次点击是用来「选新任务落点」的，
  // 不能同时开框选 —— 否则松手会把用户刚选的位置又当成一次框选、清掉选择。
  // 真正落地在容器上的 click handler（`placeAt`）里做。
  if (state.placing && event.button === 0) return;

  // 中键：平移
  if (event.button === 1) {
    event.preventDefault?.();
    const sx = event.clientX ?? 0;
    const sy = event.clientY ?? 0;
    const tx0 = state.view.tx;
    const ty0 = state.view.ty;
    const onMove = (e) => {
      state.view.tx = tx0 + ((e.clientX ?? 0) - sx);
      state.view.ty = ty0 + ((e.clientY ?? 0) - sy);
      applyView();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    return;
  }

  if (event.button !== 0) return;
  event.preventDefault?.();

  const start = toCanvasPoint(event, svg);
  let moved = false;
  let last = start;

  const onMove = (e) => {
    const p = toCanvasPoint(e, svg);
    last = p;
    if (!moved && Math.abs(p.x - start.x) + Math.abs(p.y - start.y) < 6) return;
    moved = true;
    bandRect.setAttribute('x', String(Math.min(start.x, p.x)));
    bandRect.setAttribute('y', String(Math.min(start.y, p.y)));
    bandRect.setAttribute('width', String(Math.abs(p.x - start.x)));
    bandRect.setAttribute('height', String(Math.abs(p.y - start.y)));
    bandRect.setAttribute('style', 'display:block');
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    bandRect.setAttribute('style', 'display:none');
    if (!moved) {
      // 空白处点一下 = 取消选择
      if (state.selSet.length || state.sel) {
        state.selSet = [];
        state.sel = '';
        state.questDetail = null;
        render();
      }
      return;
    }
    const box = {
      x1: Math.min(start.x, last.x),
      y1: Math.min(start.y, last.y),
      x2: Math.max(start.x, last.x),
      y2: Math.max(start.y, last.y),
    };
    const picked = [];
    for (const node of ctx.byId.values()) {
      // 只捡当前视图里看得见的节点：按章过滤后，别章节点虽然还在 byId 里
      // （跨章依赖编辑要用），但看不见的节点不该被框选选中（2026-11-02）
      if (!ctx.visibleIds.has(node.id)) continue;
      const nx = ctx.px(node.x ?? 0);
      const ny = ctx.py(node.y ?? 0);
      if (nx < box.x2 && nx + BOX_W > box.x1 && ny < box.y2 && ny + BOX_H > box.y1) picked.push(node.id);
    }
    state.selSet = picked;
    state.sel = picked.length === 1 ? picked[0] : '';
    state.questDetail = null;
    render();
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/** 空白处双击：在那个格子新建一个任务。 */
function onCanvasDoubleClick(event, svg, pad, minX, minY) {
  const p = toCanvasPoint(event, svg);
  const x = snap((p.x - pad) / CELL_X + minX);
  const y = snap((p.y - pad) / CELL_Y + minY);
  startDraft('new', null, { x, y, chapterId: state.canvasChapterId });
}

/**
 * 放置模式落地：用户点了画布某处 → 把待建任务的坐标定在那儿。
 *
 * 为什么要单独一条（2026-11-13 用户拍板「和 UE 一样」）：
 * 「加后继」以前是算写死的偏移（`x+2, y+1`），会盖住右边已有节点；
 * UE 蓝图和 FTB 本体都是「点哪放哪」（`CreateTaskAtMessage.java` 直接把
 * 鼠标坐标 `setX/setY`）。所以这里只负责把屏幕点换算成格子坐标。
 *
 * ★ 命中节点时不要抢：`event.target` 是节点就说明用户想选那个任务，不是要放置。
 *   节点自己会 stopPropagation，但拖动物品框之类的路径也可能冒泡上来，多判一次稳。
 */
function placeAt(event, host, pad, minX, minY) {
  const placing = state.placing;
  if (!placing) return;
  // 点在节点 / 装饰图上 = 用户改主意要选东西，不当作落点
  const target = event?.target;
  const onNode = target?.closest?.('.mcs-node, .mcs-quest-bg');
  if (onNode) return;

  const p = toCanvasPoint(event, host);
  const x = snap((p.x - pad) / CELL_X + minX);
  const y = snap((p.y - pad) / CELL_Y + minY);

  const draft = { ...placing.draft, at: { x, y } };
  state.placing = null;
  state.draft = draft;
  state.sel = draft.questId ?? '';
  state.plan = null;
  state.done = null;
  render();
}

/**
 * 右键装饰图：只给「改参数」「删掉」两件事。
 *
 * 为什么单开一个菜单而不是塞进节点菜单：装饰图不是任务，它没有名字、没有依赖，
 * 强行共用那套菜单会出现一堆点了没反应的项。这里只放真能对它做的事。
 */
function openImageMenu(event, ctx) {
  state.imageMenu = {
    x: event.clientX ?? 120,
    y: event.clientY ?? 120,
    index: ctx.index,
    image: ctx.image,
    chapterId: state.canvasChapterId,
  };
  state.menu = null;
  render();
}

/** 装饰图的右键菜单（形状和 nodeMenu 一致，好让样式复用）。 */
function imageMenu() {
  const menu = state.imageMenu;
  if (!menu) return null;
  const box = el('div', { class: 'mcs-menu', style: `left:${menu.x}px;top:${menu.y}px` });
  box.append(el('div', { class: 'mcs-menu-t', text: `装饰图 #${menu.index + 1}` }));
  box.append(el('div', { class: 'mcs-menu-sep' }));
  for (const [kind, label] of [['imagemove', '改坐标 / 大小'], ['imagedelete', '删掉这张装饰图']]) {
    box.append(
      el('div', {
        class: `mcs-menu-item${kind === 'imagedelete' ? ' mcs-menu-danger' : ''}`,
        text: label,
        onclick: () => startDraft(kind, '', { index: menu.index, image: menu.image }),
      }),
    );
  }
  return box;
}

/** 右键菜单。空白处右键借同一块 state.menu（带 blank:true），走另一套条目。 */
function nodeMenu() {
  const menu = state.menu;
  if (!menu) return null;
  if (menu.blank) return blankMenu(menu);
  const hit = findNode(menu.id);
  const title = hit?.node?.title ?? menu.id;
  const items = [
    ['rename', '改名字 / 副标题'],
    ['icon', '换图标物品'],
    ['deps', '改前置依赖'],
    ['new', '在它后面加一个任务'],
    ['sep', ''],
    ['delete', '删掉这个任务'],
  ];
  const box = el('div', { class: 'mcs-menu', style: `left:${menu.x}px;top:${menu.y}px` });
  box.append(el('div', { class: 'mcs-menu-t', text: truncate(title, 16) }));
  box.append(el('div', { class: 'mcs-menu-sep' }));
  for (const [kind, label] of items) {
    if (kind === 'sep') {
      box.append(el('div', { class: 'mcs-menu-sep' }));
      continue;
    }
    box.append(
      el('div', {
        class: `mcs-menu-item${kind === 'delete' ? ' mcs-menu-danger' : ''}`,
        text: label,
        onclick: () => startDraft(kind, menu.id),
      }),
    );
  }
  return box;
}

// --------------------------------------------------------------- 蓝图式编辑（2026-11-09）
// 空白处右键＝新建任务 / 新章节 / 装饰图 / 搜物品；搜出来的物品是椭圆框，
// 拖进节点＝追加要求，拖到空白＝真的新建一个任务节点；Ctrl+C / Ctrl+V 复制整个任务节点。

/** 空白处右键菜单：新建任务 / 新章节 / 装饰图 / 搜物品（2026-11-09 补后两条）。
 *  新章节是并列加一章；装饰图必须附在当前章，没开章节就置灰。 */
function blankMenu(menu) {
  const box = el('div', { class: 'mcs-menu', style: `left:${menu.x}px;top:${menu.y}px` });
  box.append(el('div', { class: 'mcs-menu-t', text: '在这块空白上' }));
  box.append(el('div', { class: 'mcs-menu-sep' }));
  const item = (label, fn, off = false) => el('div', {
    class: `mcs-menu-item${off ? ' mcs-menu-item-off' : ''}`, text: label,
    onclick: off ? undefined : fn,
  });
  box.append(item('新建任务', () => startDraft('new', null, { x: menu.gx, y: menu.gy, chapterId: state.canvasChapterId })));
  box.append(item('新章节', () => startDraft('chapter', '')));
  box.append(item('装饰图', () => startDraft('image', ''), !state.canvasChapterId));
  box.append(item('搜索物品…', () => openItemPicker(menu.x, menu.y)));
  return box;
}

/** 空白处右键：把鼠标位置换算成格子坐标，存进菜单里等「新建任务」用。 */
function openBlankMenu(event, host) {
  const p = toCanvasPoint(event, host);
  const geom = state.canvasGeom;
  let gx = 0;
  let gy = 0;
  if (geom) {
    gx = snap((p.x - geom.pad) / CELL_X + geom.minX);
    gy = snap((p.y - geom.pad) / CELL_Y + geom.minY);
  }
  state.menu = { x: event.clientX ?? 120, y: event.clientY ?? 120, blank: true, gx, gy };
  state.imageMenu = null;
  state.itemPicker = null;
  render();
}

/** 打开搜物品小浮层。 */
function openItemPicker(x, y) {
  state.menu = null;
  state.imageMenu = null;
  state.itemPicker = { x: x ?? 120, y: y ?? 120, q: '', items: [], busy: false, error: '' };
  render();
}

/** 搜物品浮层：一个输入框 + 一排可拖的椭圆物品框。 */
function itemPickerPanel() {
  const p = state.itemPicker;
  if (!p) return null;
  const box = el('div', { class: 'mcs-menu mcs-item-picker', style: `left:${p.x}px;top:${p.y}px` });
  box.append(el('div', { class: 'mcs-menu-t', text: '搜索物品（拖进画布）' }));
  box.append(el('div', { class: 'mcs-menu-sep' }));
  box.append(el('input', {
    class: 'mcs-input mcs-input-sm',
    placeholder: '中文名 / ID / 拼音',
    value: p.q,
    'data-focus': 'item-picker-q',
    oninput: (e) => { p.q = e.target.value; void searchPickerItems(); },
  }));
  const list = el('div', { class: 'mcs-item-picker-list' });
  if (p.busy) {
    list.append(el('div', { class: 'mcs-muted', text: '正在搜…' }));
  } else if (p.error) {
    list.append(el('div', { class: 'mcs-warn', text: p.error }));
  } else if (!p.items.length) {
    list.append(el('div', { class: 'mcs-muted', text: p.q ? '没找到这个物品' : '输入关键字开始搜' }));
  } else {
    const svg = svgEl('svg', {
      class: 'mcs-item-chip-svg', width: '150', height: String(p.items.length * 34),
    });
    p.items.forEach((it, i) => {
      const chip = svgEl('g', {
        class: 'mcs-item-chip', 'data-item': it.id, transform: `translate(0 ${i * 34})`,
      });
      chip.append(svgEl('ellipse', { cx: 75, cy: 17, rx: 72, ry: 14 }));
      chip.append(svgEl('text', { x: 75, y: 21, 'text-anchor': 'middle' }, it.name || it.id));
      chip.addEventListener('pointerdown', (e) => beginItemDrag(e, it.id));
      svg.append(chip);
    });
    list.append(svg);
  }
  box.append(list);
  return box;
}

/** 搜物品：走现成的 /items（中文名 / ID / 拼音都认）。 */
async function searchPickerItems() {
  const p = state.itemPicker;
  if (!p) return;
  const q = String(p.q ?? '').trim();
  if (!q) {
    p.items = [];
    p.busy = false;
    p.error = '';
    render();
    return;
  }
  p.busy = true;
  p.error = '';
  render();
  try {
    const r = await api('/items', { dir: state.dir, id: state.instanceId, q, limit: 40 });
    if (state.itemPicker !== p) return; // 浮层已经关了 / 换了一个
    p.items = Array.isArray(r.items) ? r.items.slice(0, 8) : [];
  } catch (error) {
    if (state.itemPicker === p) p.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.itemPicker === p) {
      p.busy = false;
      render();
    }
  }
}

/** 拖一个物品框：照 beginDrag 那套「按住 → 移动 → 松手」，≥4px 才算拖。 */
function beginItemDrag(event, itemId) {
  if (event.button !== 0) return;
  if (typeof document.addEventListener !== 'function') return;
  event.preventDefault?.();
  event.stopPropagation?.();
  const startX = event.clientX ?? 0;
  const startY = event.clientY ?? 0;
  let moved = false;
  const onMove = (e) => {
    const dx = (e.clientX ?? 0) - startX;
    const dy = (e.clientY ?? 0) - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
  };
  const onUp = (e) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (!moved) return;
    void commitItemDrop(itemId, e.clientX ?? 0, e.clientY ?? 0);
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/** 把屏幕坐标换算成「落在哪个节点上 / 落在哪个格子」。
 *  不用 elementFromPoint / closest：测试替身没有这些，而且节点位置本来就是纯数字。 */
function blueprintPoint(clientX, clientY) {
  const geom = state.canvasGeom;
  const host = canvasHostEl;
  if (!geom || !host) return null;
  const p = toCanvasPoint({ clientX, clientY }, host);
  const x = snap((p.x - geom.pad) / CELL_X + geom.minX);
  const y = snap((p.y - geom.pad) / CELL_Y + geom.minY);
  const chapters = state.canvas?.chapters ?? [];
  const chapter = chapters.find((c) => c.id === state.canvasChapterId) ?? chapters[0];
  const px = (nx) => (nx - geom.minX) * CELL_X + geom.pad;
  const py = (ny) => (ny - geom.minY) * CELL_Y + geom.pad;
  for (const n of chapter?.nodes ?? []) {
    const left = px(n.x ?? 0);
    const top = py(n.y ?? 0);
    if (p.x >= left && p.x <= left + BOX_W && p.y >= top && p.y <= top + BOX_H) {
      return { questId: n.id, x, y };
    }
  }
  return { questId: null, x, y };
}

/** 松手那一刻：落在节点上＝追加一条要求；落在空白＝新建一个任务节点。 */
async function commitItemDrop(itemId, clientX, clientY) {
  const hit = blueprintPoint(clientX, clientY);
  if (!hit) {
    state.error = '还没打开任务书画布';
    render();
    return;
  }
  await run('itemdrop', async () => {
    if (hit.questId) {
      await post('/quest/node/items/apply', {
        dir: state.dir, id: state.instanceId, questId: hit.questId, item: itemId, count: 1,
      });
      state.flash = `已把「${itemId}」加进那个任务的要求`;
    } else {
      await post('/quest/spawn/apply', {
        dir: state.dir, id: state.instanceId, item: itemId, count: 1,
        x: hit.x, y: hit.y, chapter: state.canvasChapterId,
      });
      state.flash = `已在空白处新建一个交「${itemId}」的任务`;
    }
    state.itemPicker = null;
    await refreshCanvas();
  });
}

/** Ctrl+C：记下选中的任务（没框选就记当前点的那个）。 */
function copyQuestSelection() {
  const ids = state.selSet.length ? state.selSet.slice() : (state.sel ? [state.sel] : []);
  if (!ids.length) {
    state.flash = '先点一个任务，再按 Ctrl+C';
    render();
    return;
  }
  state.questClipboard = ids;
  state.flash = `已复制 ${ids.length} 个任务，按 Ctrl+V 粘贴`;
  render();
}

/** Ctrl+V：把记下的任务原样复制一份（标题 / 图标 / 要求 / 奖励都带过来）。 */
async function pasteQuestSelection() {
  const ids = state.questClipboard || [];
  if (!ids.length) {
    state.flash = '还没复制过任务（先点一个任务，按 Ctrl+C）';
    render();
    return;
  }
  const at = state.canvasPointer
    ? blueprintPoint(state.canvasPointer.clientX, state.canvasPointer.clientY)
    : null;
  await run('paste', async () => {
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
      const payload = {
        dir: state.dir, id: state.instanceId, sourceQuestId: ids[i], chapter: state.canvasChapterId,
      };
      if (at) {
        payload.x = at.x + i * 2;
        payload.y = at.y;
      }
      await post('/quest/clone/apply', payload);
      n++;
    }
    state.flash = `已粘贴 ${n} 个任务`;
    await refreshCanvas();
  });
}

// --------------------------------------------------------------- 面板：物品与配方

/** 中栏：搜物品 → 看它的配方 → 点一条进编辑。 */
function contentPane() {
  const pane = el('div', { class: 'mcs-center' });
  const idx = state.summary?.index;
  pane.append(
    el('div', { class: 'mcs-center-t' },
      el('span', { text: '物品与配方' }),
      el('span', { class: 'mcs-spacer' }),
      el('span', { class: 'mcs-muted', text: idx ? `${idx.itemCount ?? 0} 个物品 · ${idx.recipeCount ?? 0} 条配方` : '还没读总览' }),
    ),
  );

  const input = el('input', {
    class: 'mcs-input mcs-input-sm',
    placeholder: '搜物品：中文名或 ID，比如 齿轮 / cogwheel / create:cogwheel',
    value: state.recipeQuery,
    'data-focus': 'rq',
    oninput: (e) => { state.recipeQuery = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') void searchRecipeItems(); },
  });
  pane.append(
    el('div', { class: 'mcs-rq-row' },
      input,
      btn(state.busy === 'rsearch' ? '搜…' : '搜物品', () => searchRecipeItems(), {
        primary: true,
        disabled: state.busy === 'rsearch',
      }),
    ),
  );

  const body = el('div', { class: 'mcs-pane-body' });

  if (state.recipeItem) {
    body.append(
      el('div', { class: 'mcs-recipe-cur' },
        iconImg(state.recipeItem, 30),
        el('span', { class: 'mcs-recipe-cur-name', text: state.recipeHits?.item ?? state.recipeItem }),
        el('span', { class: 'mcs-muted', text: state.recipeItem }),
        el('span', { class: 'mcs-spacer' }),
        btn('换一个物品', () => {
          state.recipeItem = '';
          state.recipeHits = null;
          state.recipeDetail = null;
          state.recipeForm = null;
          state.recipePlan = null;
          state.recipeDone = null;
          state.recipePicked = [];
          state.recipeBatchPlan = null;
          state.recipeBatchDone = null;
          state.recipeBatchPayload = null;
          render();
        }),
      ),
    );
  }

  if (!state.recipeItems && !state.recipeHits && !state.recipeBatchPlan && !state.recipeBatchDone) {
    body.append(
      el('div', { class: 'mcs-empty mcs-empty-big' },
        el('div', { text: '先搜一个物品' }),
        el('div', { class: 'mcs-muted', text: '比如你想改「齿轮」怎么做，就搜齿轮。中间会列出「谁能做出它」和「它被用在哪些配方里」。' }),
      ),
    );
  }

  // 第一步：挑物品。只在还没选物品的时候显示，免得挡住后面的配方列表
  if (state.recipeItems && !state.recipeItem) {
    const list = el('div', { class: 'mcs-pick-list-sm mcs-pick-list-tall' });
    for (const it of state.recipeItems.slice(0, 60)) {
      list.append(
        el('div', {
          class: 'mcs-pick-row',
          onclick: () => { void openItem(it.id); },
        },
        iconImg(it.id, 22),
        el('span', { text: truncate(it.name || it.id, 26) }),
        el('span', { class: 'mcs-muted', text: it.id })),
      );
    }
    if (state.recipeItems.length === 0) list.append(el('div', { class: 'mcs-empty', text: '没搜到。换个词试试，或者直接填完整 ID（mod:item）。' }));
    body.append(list);
  }

  // 第二步：这个物品的配方
  if (state.recipeHits) {
    const hits = state.recipeHits;
    body.append(recipeGroup('能做出它（改这些 = 改怎么做出来的）', hits.producers, hits.producerTotal));
    body.append(recipeGroup('它被用在哪些配方里', hits.consumers, hits.consumerTotal));
    // 批量改配方：勾几条 → 一次算清单 → 一次写盘（都留在中栏，用户就在中间勾）
    if (state.recipePicked.length) body.append(recipeBatchBar());
  }
  // 预览/结果卡放列表块外面：写入后我们会把 recipeHits 清空，
  // 要是藏在 if (state.recipeHits) 里，「写好了」就永远看不到了。
  if (state.recipeBatchPlan) body.append(recipeBatchPlanCard());
  if (state.recipeBatchDone) body.append(recipeBatchDoneCard());

  pane.append(body);
  return pane;
}

/** 一组配方列表。 */
function recipeGroup(title, list, total) {
  const box = el('div', { class: 'mcs-group' });
  box.append(
    el('div', { class: 'mcs-group-t' },
      el('span', { text: title }),
      el('span', { class: 'mcs-muted', text: list?.length ? `共 ${total ?? list.length} 条` : '' }),
    ),
  );
  if (!list || list.length === 0) {
    box.append(el('div', { class: 'mcs-empty', text: '没有' }));
    return box;
  }
  for (const r of list) {
    const tags = (r.tags ?? []).length ? ` · 用了标签 ${r.tags.join('、')}` : '';
    const picked = state.recipePicked.includes(r.id);
    box.append(
      el('div', {
        class: `mcs-recipe-row mcs-pickable${picked ? ' mcs-pick-on' : ''}`,
        // 点整行还是进单条编辑（老行为不变）；点行首的小勾才切换「批量选中」
        onclick: () => { void openRecipe(r.id); },
      },
      el('div', { class: 'mcs-recipe-out' },
        // 小勾自己掐掉冒泡，免得勾选时把整行的 openRecipe 也带起来
        el('span', {
          class: `mcs-tick${picked ? ' mcs-tick-on' : ''}`,
          text: picked ? '✓' : '',
          onclick: (e) => { e?.stopPropagation?.(); toggleRecipePick(r.id); },
        }),
        (r.outputs ?? []).slice(0, 2).map((o) => iconImg(o.id, 20)),
        el('span', { text: (r.outputs ?? []).map((o) => `${o.id}${o.count > 1 ? ` ×${o.count}` : ''}`).join('、') || '（没读到产物）' }),
      ),
      el('div', { class: 'mcs-recipe-meta', text: `${r.kind || r.type}${tags}` }),
      (r.inputs ?? []).length
        ? el('div', { class: 'mcs-recipe-in', text: `材料：${r.inputs.slice(0, 8).join('、')}${r.inputs.length > 8 ? ' …' : ''}` })
        : null,
      ),
    );
  }
  if ((total ?? 0) > list.length) {
    box.append(el('div', { class: 'mcs-muted', text: `还有 ${total - list.length} 条没列出来（列表最多显示 ${list.length} 条）` }));
  }
  return box;
}

/** 搜物品。 */
async function searchRecipeItems() {
  const q = String(state.recipeQuery ?? '').trim();
  if (!q) return;
  await run('rsearch', async () => {
    const r = await api('/items', { dir: state.dir, id: state.instanceId, q, limit: 60 });
    state.recipeItems = r.items ?? [];
    state.recipeItem = '';
    state.recipeHits = null;
    state.recipeDetail = null;
    state.recipePlan = null;
    state.recipeDone = null;
    state.recipePicked = [];
    state.recipeBatchPlan = null;
    state.recipeBatchDone = null;
    state.recipeBatchPayload = null;
    await ensureIcons(state.recipeItems.map((it) => it.id));
  });
}

/** 选定一个物品，列出它的配方。 */
async function openItem(itemId) {
  state.recipeItem = itemId;
  state.recipeItems = null;
  state.recipeDetail = null;
  state.recipeForm = null;
  state.recipePlan = null;
  state.recipeDone = null;
  // 换物品＝上一批勾选和预览都作废，免得对着旧物品写入
  state.recipePicked = [];
  state.recipeBatchPlan = null;
  state.recipeBatchDone = null;
  state.recipeBatchPayload = null;
  await run('rhits', async () => {
    state.recipeHits = await api('/recipes', { dir: state.dir, id: state.instanceId, item: itemId, limit: 40 });
    const ids = [];
    for (const r of [...(state.recipeHits.producers ?? []), ...(state.recipeHits.consumers ?? [])]) {
      for (const o of r.outputs ?? []) ids.push(o.id);
    }
    await ensureIcons(ids);
  });
}

/** 打开一条配方：读它的表单 + 它的「怎么画」（JEI 那种九宫格）。 */
async function openRecipe(recipeId) {
  state.recipePlan = null;
  state.recipeDone = null;
  state.recipeView = null;
  // 点开单条编辑时，之前那批配方的预览和结果就不该挂着了（勾选本身保留）
  state.recipeBatchPlan = null;
  state.recipeBatchDone = null;
  state.recipeBatchPayload = null;
  await run('rdetail', async () => {
    state.recipeDetail = await api('/recipe', { dir: state.dir, id: state.instanceId, recipeId });
    state.recipeForm = formOf(state.recipeDetail?.recipe);
    const ids = [];
    const out = state.recipeDetail?.recipe?.output;
    if (out) ids.push(out);
    // 合成表要画每一格的材料图标，所以顺手把材料也拉一遍
    for (const i of state.recipeDetail?.recipe?.inputs ?? []) ids.push(i);
    for (const i of state.recipeDetail?.recipe?.tags ?? []) ids.push(i);
    await ensureIcons(ids);
    // 画法由后端算（机器名、格子行列、能不能改都在那边定），前端只负责画
    try {
      state.recipeView = await api('/recipe/view', { dir: state.dir, id: state.instanceId, recipeId });
      const cells = state.recipeView?.layout?.grid?.cells ?? [];
      await ensureIcons(cells.map((c) => c.id).filter(Boolean));
    } catch (error) {
      // 画不出来不能连累编辑表单：编辑那套走的是 /recipe，和这里互相独立
      state.recipeView = { error: String(error?.message ?? error) };
    }
  });
}

/**
 * 从配方详情造一份「可编辑的表单副本」。
 *
 * 表单是**独立的一份**（不直接改 detail），这样点「放弃改动」时能原样还原，
 * 不会把 read-only 的原始数据搞脏。
 */
function formOf(desc) {
  if (!desc) return null;
  return {
    action: 'edit',
    count: desc.count ?? 1,
    // 多产物配方走「照抄原 JSON 只改产物」的改写路径，所以表单里存的是整份产物清单
    outputs: (desc.outputs ?? []).map((o) => ({ id: o.id, count: o.count ?? 1, chance: o.chance })),
    inputs: [...(desc.inputs ?? [])],
    pattern: [...(desc.pattern ?? [])],
    keys: { ...(desc.keys ?? {}) },
    fileName: 'recipes',
    newInput: '', // 加材料时的那一行
    newKey: '', // 加图案字符时的那一行
    newOutput: '', // 加产物时的那一行
  };
}

/**
 * 合成表那张卡：用 JEI 的样子把「什么材料 → 什么产物」摆出来。
 *
 * 画法（几行几列、有没有机器、格子里是什么）全由后端 `packages/core/recipe-layout.js` 算好，
 * 这里只把 layout 递给 `recipe-view.js`，再补两句人话说明。这样以后加 18 格、25 格，
 * 前端一个字都不用改。
 */
function recipeCard() {
  const view = state.recipeView;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: '合成表' }));

  if (!view) {
    wrap.append(el('div', { class: 'mcs-muted', text: '正在算怎么画…' }));
    return wrap;
  }
  if (view.error) {
    wrap.append(el('div', { class: 'mcs-warn', text: `合成表画不出来：${view.error}` }));
    wrap.append(el('div', { class: 'mcs-muted', text: '这不影响下面的表单 —— 改配方还是照常能改。' }));
    return wrap;
  }

  const layout = view.layout ?? {};
  wrap.append(
    recipeView(layout, {
      iconUrl: (id) => state.icons[id] ?? '',
      // 点一格材料 = 去搜那个物品（JEI 里点材料也是这个意思）
      onCellClick: (cell) => {
        if (!cell?.id || String(cell.id).startsWith('#')) return;
        state.recipeQuery = cell.id;
        state.recipeItems = null;
        state.recipeItem = '';
        state.recipeHits = null;
        state.recipeDetail = null;
        state.recipeView = null;
        state.recipeForm = null;
        state.recipePlan = null;
        state.recipeDone = null;
        state.recipePicked = [];
        state.recipeBatchPlan = null;
        state.recipeBatchDone = null;
        state.recipeBatchPayload = null;
        render();
      },
      onOutputClick: (out) => {
        if (out?.id) void openItem(out.id);
      },
      size: 'md',
    }),
  );

  if (layout.machineName) {
    wrap.append(
      el('div', { class: 'mcs-muted', text: `这是在「${layout.machineName}」里做的，材料横着摆进去就行。` }),
    );
  }
  if (layout.gridSize && layout.gridSize !== '3x3') {
    wrap.append(el('div', { class: 'mcs-muted', text: `这张表是 ${layout.gridSize} 的（不是普通九宫格）。` }));
  }
  for (const note of layout.notes ?? []) wrap.append(el('div', { class: 'mcs-muted', text: `· ${note}` }));
  for (const b of layout.blockers ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `· ${b}` }));

  // 原始 JSON 折在下面：界面画不出来的时候还能自己看
  if (view.rawJson) {
    const details = el('div', { class: 'mcs-rv-raw' });
    details.append(
      el('div', {
        class: 'mcs-rv-raw-t',
        text: view.rawJsonTruncated ? '原始 JSON（截断了）' : '原始 JSON',
      }),
    );
    details.append(el('pre', { class: 'mcs-code mcs-code-sm', text: view.rawJson }));
    wrap.append(details);
  }
  return wrap;
}

/** 右栏：改配方的表单 + 预览 + 写入结果。 */
function recipeSide() {
  const right = el('div', { class: 'mcs-right' });
  right.append(el('div', { class: 'mcs-right-t' }, el('span', { text: '改配方' })));
  const detail = state.recipeDetail;
  const desc = detail?.recipe;

  if (!desc) {
    right.append(
      card(
        '还没选中配方',
        el('div', { class: 'mcs-muted', text: '在中间搜一个物品，点开它的一条配方，这里会变成那条配方的编辑表单。' }),
        el('div', { class: 'mcs-muted', text: '改法是生成一段 KubeJS 脚本：把原配方删掉、换成你改的新配方。原文件会留备份。' }),
      ),
    );
    return right;
  }

  right.append(
    card(
      desc.output || desc.id,
      kv([
        ['配方 ID', desc.id],
        ['类型', desc.type],
        ['产物', desc.output ? `${desc.output}${desc.count > 1 ? ` ×${desc.count}` : ''}` : '（读不出）'],
        ['改法', desc.editable ? '界面上能改' : '界面上改不了'],
      ]),
      desc.editable ? null : el('div', { class: 'mcs-warn', text: desc.reason || '这条配方界面上改不了。' }),
      desc.editable ? null : el('div', { class: 'mcs-muted', text: '改不了仍然可以整条删掉（下面的「删掉这条配方」）。' }),
    ),
  );

  right.append(recipeCard());

  const form = state.recipeForm;
  if (form && desc.editable) {
    const box = el('div', { class: 'mcs-card' });
    box.append(el('div', { class: 'mcs-card-t', text: '改成什么' }));

    // 多产物：整份产物清单都能改，材料只读展示
    if (desc.multi) {
      box.append(el('div', { class: 'mcs-field-k', text: `产物（这条配方一次出 ${form.outputs.length} 种）` }));
      box.append(el('div', { class: 'mcs-muted', text: '每行三格：物品 ID · 一次出几个 · 概率（不填＝必出）' }));
      for (let i = 0; i < form.outputs.length; i += 1) {
        const one = form.outputs[i];
        box.append(
          el('div', { class: 'mcs-field' },
            iconImg(one.id, 20),
            el('input', {
              class: 'mcs-input mcs-input-sm',
              value: one.id,
              'data-focus': `rout${i}`,
              oninput: (e) => { one.id = e.target.value; },
            }),
            el('input', {
              class: 'mcs-input mcs-input-sm',
              type: 'number',
              min: 1,
              max: 64,
              value: one.count,
              title: '一次出几个',
              'data-focus': `routc${i}`,
              oninput: (e) => { one.count = Number(e.target.value) || 1; },
            }),
            el('input', {
              class: 'mcs-input mcs-input-sm',
              type: 'number',
              min: 0,
              max: 100,
              step: 5,
              value: one.chance ? Math.round(one.chance * 100) : '',
              placeholder: '概率%',
              title: '概率产物：填 10 就是 10% 的概率出这个（不填＝必出）',
              'data-focus': `routp${i}`,
              oninput: (e) => {
                const v = Number(e.target.value);
                one.chance = Number.isFinite(v) && v > 0 && v < 100 ? v / 100 : undefined;
              },
            }),
            btn('✕', () => { form.outputs.splice(i, 1); render(); }, { danger: true }),
          ),
        );
      }
      box.append(
        el('div', { class: 'mcs-field' },
          el('input', {
            class: 'mcs-input mcs-input-sm',
            placeholder: '加一个产物，如 minecraft:red_dye',
            value: form.newOutput,
            'data-focus': 'rnewout',
            oninput: (e) => { form.newOutput = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') { addOutput(); } },
          }),
          btn('加', () => addOutput(), { disabled: !form.newOutput.trim() }),
        ),
      );
      box.append(el('div', { class: 'mcs-muted', text: '改法：照抄原配方文件，只换产物那几个字（材料、时间、其它设置都不动），写成 kubejs/data 里的同名文件 —— 原文件会留备份。' }));
      if (form.inputs.length) {
        box.append(el('div', { class: 'mcs-field-k', text: `材料（改产物时不动：${form.inputs.join('、')}）` }));
      }
    } else {
    // 产物数量
    box.append(
      el('div', { class: 'mcs-field' },
        el('span', { class: 'mcs-field-k', text: '一次产出几个' }),
        el('input', {
          class: 'mcs-input mcs-input-sm',
          type: 'number',
          min: 1,
          max: 64,
          value: form.count,
          'data-focus': 'rcount',
          oninput: (e) => { form.count = Number(e.target.value) || 1; },
        }),
      ),
    );

    if (desc.kind === 'shaped') {
      box.append(el('div', { class: 'mcs-field-k', text: '图案（每行 1~3 个字符，同一个字符 = 同一种材料）' }));
      for (let i = 0; i < form.pattern.length; i += 1) {
        box.append(
          el('div', { class: 'mcs-field' },
            el('span', { class: 'mcs-field-k', text: `第 ${i + 1} 行` }),
            el('input', {
              class: 'mcs-input mcs-input-sm',
              value: form.pattern[i],
              'data-focus': `rpat${i}`,
              oninput: (e) => { form.pattern[i] = e.target.value; },
            }),
          ),
        );
      }
      box.append(row(
        btn('加一行', () => { if (form.pattern.length < 3) { form.pattern.push(''.padEnd(form.pattern[0]?.length || 1, ' ')); render(); } }, { disabled: form.pattern.length >= 3 }),
        btn('删一行', () => { if (form.pattern.length > 1) { form.pattern.pop(); render(); } }, { disabled: form.pattern.length <= 1 }),
      ));
      box.append(el('div', { class: 'mcs-field-k', text: '字符对应什么物品' }));
      for (const [ch, id] of Object.entries(form.keys)) {
        box.append(
          el('div', { class: 'mcs-field' },
            el('span', { class: 'mcs-field-ch', text: ch }),
            el('input', {
              class: 'mcs-input mcs-input-sm',
              value: id,
              'data-focus': `rkey${ch}`,
              oninput: (e) => { form.keys[ch] = e.target.value; },
            }),
            iconImg(id, 20),
          ),
        );
      }
    } else {
      box.append(el('div', { class: 'mcs-field-k', text: `材料（${desc.kind === 'machine' ? `Create ${desc.machineKind} 配方` : '无序合成'}）` }));
      for (let i = 0; i < form.inputs.length; i += 1) {
        box.append(
          el('div', { class: 'mcs-field' },
            iconImg(form.inputs[i], 20),
            el('input', {
              class: 'mcs-input mcs-input-sm',
              value: form.inputs[i],
              'data-focus': `rin${i}`,
              oninput: (e) => { form.inputs[i] = e.target.value; },
            }),
            btn('✕', () => { form.inputs.splice(i, 1); render(); }, { danger: true }),
          ),
        );
      }
      box.append(
        el('div', { class: 'mcs-field' },
          el('input', {
            class: 'mcs-input mcs-input-sm',
            placeholder: '加一个材料，如 minecraft:iron_ingot',
            value: form.newInput,
            'data-focus': 'rnewin',
            oninput: (e) => { form.newInput = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') { addInput(); } },
          }),
          btn('加', () => addInput(), { disabled: !form.newInput.trim() }),
        ),
      );
    }
    }

    // 多产物走的是「同名覆盖数据包文件」，不写脚本，所以没有「写进哪个脚本」这一项
    if (!desc.multi) {
      box.append(
        el('div', { class: 'mcs-field' },
          el('span', { class: 'mcs-field-k', text: '写进哪个脚本' }),
          el('input', {
            class: 'mcs-input mcs-input-sm',
            value: form.fileName,
            'data-focus': 'rfile',
            oninput: (e) => { form.fileName = e.target.value; },
          }),
        ),
      );
      box.append(el('div', { class: 'mcs-muted', text: '会成为 kubejs/server_scripts/dsh_<这个名字>.js；同名的会被覆盖（先自动备份）。' }));
    }
    box.append(row(
      btn(state.busy === 'rplan' ? '正在算…' : '预览会写什么', () => previewRecipe(), { primary: true, disabled: state.busy === 'rplan' }),
      btn('放弃改动', () => { state.recipeForm = formOf(desc); state.recipePlan = null; render(); }),
    ));
    right.append(box);
  }

  // 删除：不管能不能改都能删
  right.append(
    card(
      '或者整条删掉',
      el('div', { class: 'mcs-muted', text: '删掉之后，这条配方在游戏里就没了。如果只有它产出某个物品，那个物品会彻底拿不到 —— 预览里会列出来。' }),
      row(btn('预览删掉会怎样', () => previewRecipe('remove'), { danger: true, disabled: state.busy === 'rplan' })),
    ),
  );

  if (state.recipePlan) right.append(recipePlanCard());
  if (state.recipeDone) right.append(recipeDoneCard());

  if (detail.usedBy?.count) {
    right.append(
      card(
        `产物还被 ${detail.usedBy.count} 条配方用着`,
        ...(detail.usedBy.recipes ?? []).slice(0, 6).map((r) =>
          el('div', { class: 'mcs-muted', text: `· ${(r.outputs ?? []).map((o) => o.id).join('、') || r.id}` }),
        ),
      ),
    );
  }
  return right;
}

/** 表单里「加一个材料」。 */
function addInput() {
  const form = state.recipeForm;
  if (!form) return;
  const id = String(form.newInput ?? '').trim();
  if (!id) return;
  form.inputs.push(id);
  form.newInput = '';
  render();
}

/** 表单里「加一个产物」（多产物配方用）。 */
function addOutput() {
  const form = state.recipeForm;
  if (!form) return;
  const id = String(form.newOutput ?? '').trim();
  if (!id) return;
  form.outputs.push({ id, count: 1 });
  form.newOutput = '';
  render();
}

/** 预览：算出会写什么代码、会有什么影响。 */
async function previewRecipe(action = 'edit') {
  const detail = state.recipeDetail;
  const form = state.recipeForm;
  if (!detail || !form) return;
  await run('rplan', async () => {
    const payload = {
      dir: state.dir,
      id: state.instanceId,
      recipeId: detail.recipe.id,
      action,
      fileName: form.fileName,
    };
    if (action === 'edit') {
      payload.count = form.count;
      if (detail.recipe.multi) {
        payload.outputs = JSON.stringify(form.outputs);
      } else if (detail.recipe.kind === 'shaped') {
        payload.pattern = JSON.stringify(form.pattern);
        payload.keys = JSON.stringify(form.keys);
      } else {
        payload.inputs = JSON.stringify(form.inputs);
      }
    }
    state.recipePlan = await post('/recipe/preview', payload);
    state.recipeDone = null;
  });
}

/** 写入。 */
async function recipeApply() {
  const detail = state.recipeDetail;
  const form = state.recipeForm;
  const plan = state.recipePlan;
  if (!detail || !form || !plan) return;
  await run('rapply', async () => {
    const payload = {
      dir: state.dir,
      id: state.instanceId,
      recipeId: detail.recipe.id,
      action: plan.action,
      fileName: form.fileName,
    };
    if (plan.action === 'edit') {
      payload.count = form.count;
      if (detail.recipe.multi) {
        payload.outputs = JSON.stringify(form.outputs);
      } else if (detail.recipe.kind === 'shaped') {
        payload.pattern = JSON.stringify(form.pattern);
        payload.keys = JSON.stringify(form.keys);
      } else {
        payload.inputs = JSON.stringify(form.inputs);
      }
    }
    state.recipeDone = await post('/recipe/apply', payload);
    state.recipePlan = null;
    // 改完配方，配方表变了，让它下次自己重读
    state.recipeHits = null;
    state.facts.exportPreview = null;
  });
}

function recipePlanCard() {
  const p = state.recipePlan;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: '这次会改什么（还没写盘）' }));
  wrap.append(el('div', { class: 'mcs-muted', text: p.summary }));
  wrap.append(el('div', { class: 'mcs-muted', text: `会写进：${p.targetPath}` }));
  for (const w of p.warnings ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `注意：${w}` }));
  const critical = p.impact?.critical ?? [];
  const lost = p.impact?.lost ?? [];
  if (critical.length) {
    wrap.append(el('div', { class: 'mcs-warn', text: '这些物品会彻底拿不到，而且还有配方在用它：' }));
    for (const b of critical) wrap.append(el('div', { class: 'mcs-warn', text: `· ${b.item}（${b.usedBy} 条配方要用）` }));
  }
  if (lost.length) {
    wrap.append(el('div', { class: 'mcs-muted', text: `另外还有 ${p.impact.lostTotal ?? lost.length} 个物品会失去来源：` }));
    for (const b of lost.slice(0, 8)) wrap.append(el('div', { class: 'mcs-muted', text: `· ${b.item}` }));
  }
  wrap.append(el('div', { class: 'mcs-field-k', text: '会写进去的代码（可以先看一眼）' }));
  wrap.append(el('pre', { class: 'mcs-code', text: p.code }));
  wrap.append(row(
    btn(state.busy === 'rapply' ? '正在写…' : '确认写入', () => recipeApply(), { primary: true, disabled: state.busy === 'rapply' }),
    btn('先不写', () => { state.recipePlan = null; render(); }),
  ));
  return wrap;
}

function recipeDoneCard() {
  const d = state.recipeDone;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: d.verified ? '写好了，复验通过' : '写好了，但复验有提醒' }));
  wrap.append(el('div', { class: 'mcs-muted', text: d.summary }));
  wrap.append(el('div', { class: 'mcs-muted', text: `文件：${d.targetPath}` }));
  if (d.backup) wrap.append(el('div', { class: 'mcs-muted', text: `备份：${d.backup}` }));
  for (const w of d.warnings ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `注意：${w}` }));
  wrap.append(el('div', { class: 'mcs-muted', text: '进游戏后生效。想反悔就把这个脚本删掉（或改回去）。' }));
  wrap.append(row(btn('知道了', () => { state.recipeDone = null; render(); })));
  return wrap;
}

// --------------------------------------------------------------- 批量改配方
// 一条一条改太慢：在中栏列表里勾几条，一次算清单、一次写盘。
// 单条那套 /recipe/preview + /recipe/apply 一行没动，批量走新接口。

/** 勾 / 取消勾一条配方。选择变了，之前算的清单就作废（跟装 mod 的勾选一个道理）。 */
function toggleRecipePick(id) {
  if (!id) return;
  const set = new Set(state.recipePicked);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  state.recipePicked = [...set];
  state.recipeBatchPlan = null;
  state.recipeBatchDone = null;
  state.recipeBatchPayload = null;
  render();
}

/** 中栏的「选中了 N 条」操作条：两个动作都只算清单、不写盘。 */
function recipeBatchBar() {
  const n = state.recipePicked.length;
  const bar = el('div', { class: 'mcs-subcard' },
    el('div', { class: 'mcs-muted', text: `选中了 ${n} 条配方：${state.recipePicked.join('、')}` }),
    row(
      btn(state.busy === 'rbplan' ? '正在算…' : `预览：删掉选中的 ${n} 条`, () => previewRecipeBatch('remove'), {
        danger: true, disabled: state.busy === 'rbplan',
      }),
      btn(state.busy === 'rbplan' ? '正在算…' : `预览：选中的产出都 +${state.recipeBatchDelta}`, () => previewRecipeBatch('edit'), {
        primary: true, disabled: state.busy === 'rbplan',
      }),
      btn('清空选择', () => {
        state.recipePicked = [];
        state.recipeBatchPlan = null;
        state.recipeBatchDone = null;
        state.recipeBatchPayload = null;
        render();
      }),
    ),
  );
  return bar;
}

/** 算这批会写什么（只算不写）。入参记下来，确认写入时逐字复用。 */
async function previewRecipeBatch(action) {
  const picked = state.recipePicked;
  if (!picked.length) return;
  const payload = {
    dir: state.dir,
    id: state.instanceId,
    items: JSON.stringify(picked.map((rid) => ({ recipeId: rid }))),
    action,
  };
  if (action === 'edit') payload.delta = state.recipeBatchDelta;
  await run('rbplan', async () => {
    state.recipeBatchPayload = payload;
    state.recipeBatchPlan = await post('/recipe/batch/preview', payload);
    state.recipeBatchDone = null;
  });
}

/** 确认写入：直接复用预览时的入参，别另拼一份（apply 后端会重算，参数必须一致）。 */
async function recipeBatchApply() {
  const payload = state.recipeBatchPayload;
  if (!payload) return;
  await run('rbapply', async () => {
    state.recipeBatchDone = await post('/recipe/batch/apply', payload);
    state.recipeBatchPlan = null;
    state.recipeBatchPayload = null;
    state.recipePicked = [];
    // 配方清单可能变了，清掉让它下次重新读；导出预览也作废
    state.recipeHits = null;
    state.facts.exportPreview = null;
  });
}

/** 批量预览卡：summary 是数组、文件是 files[]（每个带 file / content / mode）。 */
function recipeBatchPlanCard() {
  const p = state.recipeBatchPlan;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: `这批 ${p.items?.length ?? 0} 条会改什么（还没写盘）` }));
  for (const s of p.summary ?? []) wrap.append(el('div', { class: 'mcs-muted', text: `· ${s}` }));
  for (const f of p.files ?? []) wrap.append(el('div', { class: 'mcs-muted', text: `会写进：${f.file}` }));
  for (const w of p.warnings ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `注意：${w}` }));
  const critical = p.impact?.critical ?? [];
  const lost = p.impact?.lost ?? [];
  if (critical.length) {
    wrap.append(el('div', { class: 'mcs-warn', text: '这些物品会彻底拿不到，而且还有配方在用它：' }));
    for (const b of critical) wrap.append(el('div', { class: 'mcs-warn', text: `· ${b.item}（${b.usedBy} 条配方要用）` }));
  }
  if (lost.length) {
    wrap.append(el('div', { class: 'mcs-muted', text: `另外还有 ${p.impact.lostTotal ?? lost.length} 个物品会失去来源：` }));
    for (const b of lost.slice(0, 8)) wrap.append(el('div', { class: 'mcs-muted', text: `· ${b.item}` }));
  }
  // 只把脚本内容摊开给人看；多产物 JSON 太杂，列个文件名就够了
  for (const f of (p.files ?? []).filter((f) => f.mode === 'script')) {
    wrap.append(el('div', { class: 'mcs-field-k', text: `${f.file} 里会写进去的代码` }));
    wrap.append(el('pre', { class: 'mcs-code', text: f.content }));
  }
  wrap.append(row(
    btn(state.busy === 'rbapply' ? '正在写…' : '确认批量写入', () => recipeBatchApply(), { primary: true, disabled: state.busy === 'rbapply' }),
    btn('先不写', () => { state.recipeBatchPlan = null; state.recipeBatchPayload = null; render(); }),
  ));
  return wrap;
}

/** 批量写入结果卡：files / backups 都是字符串数组。 */
function recipeBatchDoneCard() {
  const d = state.recipeBatchDone;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: d.verified ? '这批写好了，复验通过' : '这批写好了，但复验有提醒' }));
  for (const s of d.summary ?? []) wrap.append(el('div', { class: 'mcs-muted', text: `· ${s}` }));
  for (const f of d.files ?? []) wrap.append(el('div', { class: 'mcs-muted', text: `文件：${f}` }));
  for (const b of d.backups ?? []) wrap.append(el('div', { class: 'mcs-muted', text: `备份：${b}` }));
  for (const w of d.warnings ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `注意：${w}` }));
  wrap.append(el('div', { class: 'mcs-muted', text: '进游戏后生效。想反悔就把这些文件删掉（或改回去）。' }));
  wrap.append(row(btn('知道了', () => { state.recipeBatchDone = null; render(); })));
  return wrap;
}

// --------------------------------------------------------------- 面板：打包

const PACK_MODES = [
  { key: 'offline', name: '完整实例', blurb: 'PCL 认成游戏实例，最稳。带 libraries/assets，体积大' },
  { key: 'standard', name: '轻量包', blurb: '只要 mods/config/kubejs，体积小，走 PCL 普通整合包流程' },
  { key: 'launcher', name: '带启动器', blurb: '完整实例外面再套一层 PCL 本体' },
];

/** 中栏：打包。 */
function packPane() {
  const pane = el('div', { class: 'mcs-center' });
  const pack = state.pack;
  pane.append(
    el('div', { class: 'mcs-center-t' },
      el('span', { text: '打包' }),
      el('span', { class: 'mcs-spacer' }),
      el('span', { class: 'mcs-muted', text: state.summary?.instance?.id ?? '' }),
    ),
  );

  const body = el('div', { class: 'mcs-pane-body' });

  // 形态
  const seg = el('div', { class: 'mcs-seg' });
  for (const m of PACK_MODES) {
    seg.append(
      el('div', {
        class: `mcs-seg-item${pack.mode === m.key ? ' mcs-seg-on' : ''}`,
        onclick: () => { pack.mode = m.key; pack.plan = null; pack.built = null; render(); },
      },
      el('div', { class: 'mcs-seg-name', text: m.name }),
      el('div', { class: 'mcs-seg-blurb', text: m.blurb }),
      ),
    );
  }
  body.append(seg);

  // 包名
  body.append(
    el('div', { class: 'mcs-field' },
      el('span', { class: 'mcs-field-k', text: '包名（留空自动起）' }),
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder: `${state.summary?.instance?.id ?? '整合包'}-${pack.mode}`,
        value: pack.packName,
        'data-focus': 'packname',
        oninput: (e) => { pack.packName = e.target.value; pack.plan = null; pack.built = null; },
      }),
    ),
  );

  // 选项
  const opts = el('div', { class: 'mcs-checks' });
  const check = (label, key, hint) =>
    el('label', { class: 'mcs-check' },
      el('input', {
        type: 'checkbox',
        checked: Boolean(pack[key]),
        onchange: (e) => { pack[key] = e.target.checked; pack.plan = null; pack.built = null; render(); },
      }),
      el('span', { text: label }),
      el('span', { class: 'mcs-muted', text: hint }),
    );
  if (pack.mode !== 'standard') {
    opts.append(check('带上 libraries（游戏库）', 'includeLibraries', '不带的话 PCL 要自己下，新机器会卡很久'));
    opts.append(check('带上 assets（贴图音效）', 'includeAssets', '同上。完整实例不带这两样基本装不起来'));
    opts.append(check('带上 runtime（Java）', 'includeRuntime', '更省事，但会多几百 MB'));
  }
  opts.append(check('带上存档 saves/', 'includeSaves', '默认不带，避免把存档发出去'));
  body.append(opts);

  if (pack.mode === 'launcher') {
    body.append(
      el('div', { class: 'mcs-field' },
        el('span', { class: 'mcs-field-k', text: '本机 PCL.exe 路径（要套进包里）' }),
        el('input', {
          class: 'mcs-input mcs-input-sm',
          placeholder: 'D:\\PCL\\PCL.exe',
          value: pack.pclExe,
          'data-focus': 'pclpath',
          oninput: (e) => { pack.pclExe = e.target.value; pack.plan = null; pack.built = null; },
        }),
      ),
    );
  }

  body.append(
    row(
      btn(state.busy === 'packplan' ? '正在算…' : '算一下要打多大', () => packPreview(), { primary: true, disabled: state.busy === 'packplan' }),
      state.facts.exportPreview ? btn('重新算', () => packPreview(), { disabled: state.busy === 'packplan' }) : null,
    ),
  );

  if (pack.plan) body.append(packPlanCard());
  if (pack.built) body.append(packBuiltCard());
  // 打包进行中的进度条：打包不像装 mod 有「计划卡」托着，所以在 body 尾部单独占一块
  const packing = progressSlot('export');
  if (packing) body.append(packing);
  if (!pack.plan && !pack.built) {
    body.append(
      el('div', { class: 'mcs-hint', text: '先「算一下」，看清楚要打多大、顶层是什么结构、会不会缺东西；确认没问题再真打包。打包只读你的实例，不会改它。' }),
    );
  }

  pane.append(body);
  return pane;
}

/** 算打包计划（不写盘）。 */
async function packPreview() {
  const pack = state.pack;
  await run('packplan', async () => {
    const plan = await post('/export/preview', {
      dir: state.dir,
      id: state.instanceId,
      mode: pack.mode,
      packName: pack.packName,
      includeSaves: pack.includeSaves,
      includeLibraries: pack.includeLibraries,
      includeAssets: pack.includeAssets,
      includeRuntime: pack.includeRuntime,
      pclExe: pack.pclExe,
    });
    pack.plan = plan;
    pack.built = null;
    state.facts.exportPreview = plan;
  });
}

/** 真打包。 */
async function packBuild() {
  const pack = state.pack;
  // 打包是本地读写，比下载快，但一个包几千个文件也要几秒到几十秒，同样给条。
  watchKind('export');
  await runWithProgress('packbuild', async () => {
    const body = await post('/export/build', {
      dir: state.dir,
      id: state.instanceId,
      mode: pack.mode,
      packName: pack.packName,
      includeSaves: pack.includeSaves,
      includeLibraries: pack.includeLibraries,
      includeAssets: pack.includeAssets,
      includeRuntime: pack.includeRuntime,
      pclExe: pack.pclExe,
    });
    pack.built = body;
    state.facts.exportDone = { file: body.outFile, bytes: body.zipBytes };
    return body;
  });
}

function packPlanCard() {
  const p = state.pack.plan;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: '打包计划（还没写盘）' }));
  wrap.append(
    kv([
      ['形态', `${p.mode}（${PACK_MODES.find((m) => m.key === p.mode)?.name ?? p.mode}）`],
      ['包名', p.packName],
      ['外层目录', p.wrapper],
      ['会打多少文件', `${p.fileCount} 个`],
      ['预计大小', p.totalText],
      ['输出到', p.willWriteTo || p.outDir || '—'],
    ]),
  );
  if ((p.top ?? []).length) {
    wrap.append(el('div', { class: 'mcs-field-k', text: '包里都有些什么' }));
    for (const t of p.top) wrap.append(el('div', { class: 'mcs-muted', text: `· ${t.name} —— ${t.files} 个文件，${t.sizeText}` }));
  }
  for (const w of p.warnings ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `注意：${w}` }));
  wrap.append(row(
    btn(state.busy === 'packbuild' ? '正在打包…' : `真打包（约 ${p.totalText}）`, () => packBuild(), { primary: true, disabled: state.busy === 'packbuild' }),
    btn('先不打包', () => { state.pack.plan = null; render(); }),
  ));
  return wrap;
}

function packBuiltCard() {
  const b = state.pack.built;
  const ok = b.check?.ok;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: ok ? '打好了，自检通过' : '打好了，但自检有问题' }));
  wrap.append(
    kv([
      ['文件', b.outFile],
      ['大小', b.zipText ?? `${b.zipBytes} 字节`],
      ['里面的条目', `${b.entries} 个`],
    ]),
  );
  for (const item of b.check?.items ?? []) {
    wrap.append(el('div', { class: item.ok ? 'mcs-ok' : 'mcs-warn', text: `${item.ok ? '✓' : '✗'} ${item.label ?? item.key}` }));
  }
  for (const f of b.check?.failed ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `没过：${f}` }));
  if (ok) wrap.append(el('div', { class: 'mcs-muted', text: '把这个 zip 拖进 PCL2 就能装。offline 形态会被认成一个游戏实例。' }));
  wrap.append(row(
    btn('再打一次', () => packBuild(), { disabled: state.busy === 'packbuild' }),
    btn('收起', () => { state.pack.built = null; render(); }),
  ));
  return wrap;
}

// --------------------------------------------------------------- 面板：启动验证

/** 中栏：启动验证。 */
function verifyPane() {
  const pane = el('div', { class: 'mcs-center' });
  const launch = state.launch;
  pane.append(
    el('div', { class: 'mcs-center-t' },
      el('span', { text: '启动验证' }),
      el('span', { class: 'mcs-spacer' }),
      el('span', { class: 'mcs-muted', text: '真开一次游戏，看能不能到主菜单' }),
    ),
  );

  const body = el('div', { class: 'mcs-pane-body' });
  body.append(
    el('div', { class: 'mcs-hint' },
      el('div', { text: '先「只算命令行」：它不会启动任何东西，只把启动计划摊开给你看（Java 版本对不对、库文件齐不齐、natives 解到哪）。' }),
      el('div', { text: '真启动会开一个游戏窗口，一般 15~40 秒到主菜单。这期间窗口没反应是正常的，别当成卡死。' }),
    ),
  );
  body.append(
    row(
      btn(state.busy === 'dryrun' ? '正在算…' : '只算命令行（不启动）', () => launchPreview(), { primary: !launch.dryRun, disabled: state.busy === 'dryrun' }),
      btn(state.busy === 'launch' ? '正在启动…' : '真启动一次', () => applyLaunch(), {
        disabled: state.busy === 'launch' || !launch.dryRun || (launch.dryRun.blockers ?? []).length > 0,
      }),
    ),
  );
  if (!launch.dryRun) {
    body.append(el('div', { class: 'mcs-muted', text: '先把命令行算出来，看清没问题，再点真启动。' }));
  }
  for (const b of launch.dryRun?.blockers ?? []) {
    body.append(el('div', { class: 'mcs-warn', text: `现在启动不了：${b}` }));
  }

  if (launch.dryRun) body.append(dryRunCard());
  if (launch.result) body.append(launchResultCard());

  pane.append(body);
  return pane;
}

/** 算启动命令行（纯计算，绝不 spawn）。 */
async function launchPreview() {
  await run('dryrun', async () => {
    state.launch.dryRun = await api('/launch/preview', { dir: state.dir, id: state.instanceId });
    state.launch.result = null;
  });
}

/** 真启动。 */
async function applyLaunch() {
  await run('launch', async () => {
    state.launch.result = await post('/launch/apply', {
      dir: state.dir,
      id: state.instanceId,
      apply: true,
      timeoutMs: state.launch.timeoutMs,
    });
    const r = state.launch.result;
    state.facts.launchResult = { ok: Boolean(r.started), seconds: Math.round((r.durationMs ?? 0) / 1000), status: r.status };
  });
}

function dryRunCard() {
  const d = state.launch.dryRun;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: '启动计划（还没启动任何东西）' }));
  wrap.append(
    kv([
      ['实例', d.instance],
      ['版本 ID', d.versionId],
      ['主类', d.mainClass],
      ['Java', d.java ? `${d.java.path}（${d.java.version}${d.java.warning ? `，${d.java.warning}` : ''}）` : '没找到'],
      ['需要 Java', d.requiredMajor ? `${d.requiredMajor}` : '未声明'],
      ['Java 够用吗', d.javaMatches ? '够' : '不够，启动会失败'],
      ['库文件', `${d.libraries?.found ?? 0} 个齐 / ${(d.libraries?.missing ?? []).length} 个缺`],
      ['客户端 jar', d.classpath?.hasClientJar ? '有' : '缺'],
      ['classpath 条目', `${d.classpath?.entries ?? 0} 条（${d.classpath?.chars ?? 0} 字符）`],
      ['natives', `${d.natives?.count ?? 0} 个 → ${d.natives?.dir ?? '—'}`],
    ]),
  );
  for (const line of d.lines ?? []) wrap.append(el('div', { class: 'mcs-muted', text: String(line) }));
  for (const m of d.missingVars ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `缺变量：${m}` }));
  if ((d.libraries?.missing ?? []).length) {
    wrap.append(el('div', { class: 'mcs-warn', text: `缺 ${d.libraries.missing.length} 个库文件，真启动会被拦下。先用启动器把这个实例跑一次让库下全。` }));
  }
  wrap.append(el('div', { class: 'mcs-field-k', text: '即将执行的命令（太长会截断）' }));
  wrap.append(el('pre', { class: 'mcs-code', text: d.command ?? '' }));
  return wrap;
}

function launchResultCard() {
  const r = state.launch.result;
  const good = r.status === 'ok';
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: `启动结果：${r.status}` }));
  wrap.append(el('div', { class: good ? 'mcs-ok' : 'mcs-warn', text: r.summary }));
  wrap.append(el('div', { class: 'mcs-muted', text: `耗时 ${Math.round((r.durationMs ?? 0) / 1000)} 秒 · 判定依据：${r.evidenceKind ?? '—'}` }));
  if ((r.evidence ?? []).length) {
    for (const line of r.evidence.slice(0, 6)) wrap.append(el('div', { class: 'mcs-muted', text: `· ${line}` }));
  }
  if ((r.suspects ?? []).length) {
    wrap.append(el('div', { class: 'mcs-field-k', text: '可能的原因（按可能性从高到低）' }));
    for (const s of r.suspects) wrap.append(el('div', { class: 'mcs-warn', text: `· ${s}` }));
  }
  if ((r.newCrashReports ?? []).length) {
    wrap.append(el('div', { class: 'mcs-field-k', text: '这次新出现的崩溃报告' }));
    for (const c of r.newCrashReports) wrap.append(el('div', { class: 'mcs-muted', text: `· ${c}` }));
  }
  if ((r.tail ?? []).length) {
    wrap.append(el('div', { class: 'mcs-field-k', text: '日志最后几行' }));
    wrap.append(el('pre', { class: 'mcs-code mcs-code-sm', text: (r.tail ?? []).join('\n') }));
  }
  if (r.logFile) wrap.append(el('div', { class: 'mcs-muted', text: `完整日志：${r.logFile}` }));
  wrap.append(row(btn('知道了', () => { state.launch.result = null; render(); })));
  return wrap;
}

// --------------------------------------------------------------- 面板：总览

/** 中栏：体检总览。 */
function checkupPane() {
  const pane = el('div', { class: 'mcs-center' });
  const s = state.summary ?? {};
  const inst = s.instance ?? {};
  const idx = s.index ?? {};
  pane.append(
    el('div', { class: 'mcs-center-t' },
      el('span', { text: '体检总览' }),
      el('span', { class: 'mcs-spacer' }),
      btn('重新体检', () => connect(state.dir, state.instanceId), { disabled: state.busy === 'connect' }),
    ),
  );
  const body = el('div', { class: 'mcs-pane-body' });
  body.append(
    card(
      inst.id ?? '整合包',
      kv([
        ['目录', inst.instanceDir],
        ['游戏版本', inst.mcVersion],
        ['加载器', `${inst.loader ?? '?'} ${inst.loaderVersion ?? ''}`],
        ['mod 数', `${inst.modsCount ?? 0}（停用 ${inst.disabledModsCount ?? 0}）`],
        ['有这些目录', (inst.presentDirs ?? []).join('、') || '—'],
        ['任务书目录', (inst.questDirs ?? []).join('、') || '这个包没装 FTB Quests'],
      ]),
    ),
  );
  body.append(
    card(
      '物品索引',
      kv([
        ['物品', idx.itemCount ?? 0],
        ['配方', idx.recipeCount ?? 0],
        ['jar 数', `${idx.jarCount ?? 0}（读不出 ${idx.jarFailed ?? 0} 个）`],
        ['命名空间', (idx.namespaces ?? []).slice(0, 10).join('、') || '—'],
        ['读索引花了', `${idx.indexedMs ?? 0} 毫秒`],
      ]),
    ),
  );
  const step = nextStep(state.facts ?? {});
  const jump = STEP_PANEL[step.key];
  body.append(
    card(
      '下一步',
      el('div', { class: 'mcs-muted', text: step.text }),
      row(jump ? btn('去做这一步', () => gotoPanel(jump), { primary: true }) : null),
    ),
  );
  pane.append(body);
  return pane;
}

// --------------------------------------------------------------- 让模型帮你改包（MCP）

/**
 * 中栏：「让模型帮你改包」。
 *
 * 这一页做两件事：
 * ① 给出可以直接贴进 DSH 的配置（桌面版自带一个 MCP 服务器，DSH 连上它，模型就能直接改包）；
 * ② 现场跑一次握手自检，确认这个服务器是好的。
 *
 * 模型调的工具和界面点着改走的是同一套底层函数（lib/host/api.js → packages/core），
 * 所以两边改出来的东西必然一致。
 */
function mcpPane() {
  const pane = el('div', { class: 'mcs-center' });
  const mcp = state.mcp;
  pane.append(
    el('div', { class: 'mcs-center-t' },
      el('span', { text: '让模型帮你改包' }),
      el('span', { class: 'mcs-spacer' }),
      el('span', { class: 'mcs-muted', text: state.summary?.instance?.id ?? '' }),
    ),
  );

  const body = el('div', { class: 'mcs-pane-body' });

  body.append(
    card(
      '这是什么',
      el('div', { class: 'mcs-muted', text: '这个桌面版自带一个 MCP 服务器（就是标准的那套「模型工具接口」）。把下面那段配置贴进 DSH 的 MCP 服务器设置里，DSH 就能连上它；之后在 DSH 里跟模型说「把某个配方改成……」或者「给任务书加一章」，模型就能直接动手改这个整合包了。' }),
      el('div', { class: 'mcs-muted', text: '模型用的工具和你在界面上点的是同一套底层逻辑，改出来的东西一样；而且改文件类工具默认只预览不写盘，模型要写盘得明确说一声。' }),
      el('div', { class: 'mcs-muted', text: '连上以后，在 DSH 里能看到的工具名长这样：mcp__mcstudio__<工具名>（比如 mcp__mcstudio__recipe_edit 改配方、mcp__mcstudio__quest_add 加任务）。看到这些名字就说明接上了。' }),
    ),
  );

  // 配置
  body.append(
    card(
      '贴到 DSH 里的配置',
      mcp.config
        ? el('pre', { class: 'mcs-code', text: mcp.config.yaml })
        : el('div', { class: 'mcs-muted', text: mcp.loading ? '正在生成配置…' : '还没生成。' }),
      row(
        btn(mcp.loading ? '正在生成…' : (mcp.config ? '重新生成' : '生成配置'), () => mcpLoad(), { primary: true, disabled: mcp.loading }),
        mcp.config ? btn(mcp.copied ? '已复制' : '复制配置', () => mcpCopy(), { disabled: mcp.copied }) : null,
      ),
      mcp.config
        ? el('div', { class: 'mcs-muted', text: `服务器脚本：${mcp.config.serverPath}` })
        : null,
      mcp.config && !mcp.config.needsRunAsNode
        ? el('div', { class: 'mcs-muted', text: '注意：现在是开发模式（用 node 直接跑）。打包成 exe 之后会自动带上 ELECTRON_RUN_AS_NODE=1，界面里不用管。' })
        : null,
    ),
  );

  // 自检
  const st = mcp.selftest;
  body.append(
    card(
      '自检',
      el('div', { class: 'mcs-muted', text: '自己跑一次握手，看看这个 MCP 服务器是不是好的。' }),
      row(btn(mcp.loading ? '正在自检…' : '跑一次自检', () => mcpSelfTest(), { disabled: mcp.loading })),
      st
        ? (st.ok
          ? el('div', { class: 'mcs-hint', text: `自检通过：${st.toolCount} 个工具可以用了（协议版本 ${st.protocolVersion ?? '?'}）。` })
          : el('div', { class: 'mcs-status-bad', text: `自检没过：${st.error ?? '原因不明'}` }))
        : null,
      st && st.ok && Array.isArray(st.toolNames)
        ? el('div', { class: 'mcs-muted', text: `工具清单：${st.toolNames.join('、')}` })
        : null,
    ),
  );

  body.append(
    el('div', { class: 'mcs-hint', text: '下一步：复制上面那段配置 → 打开 DSH 的 MCP 服务器设置 → 新建一条 → 把配置粘进去 → 保存。然后在 DSH 里就能让模型直接改这个整合包了。' }),
  );

  pane.append(body);
  return pane;
}

/** 拿一份 MCP 配置（顺便把当前连着的整合包目录写进去，模型就不用每次报路径）。 */
async function mcpLoad() {
  await run('mcp', async () => {
    state.mcp.loading = true;
    state.mcp.copied = false;
    render();
    try {
      state.mcp.config = await api('/mcp/config', { dir: state.dir });
      state.note = '配置生成好了';
    } finally {
      state.mcp.loading = false;
    }
  });
}

/** 跑一次 MCP 握手自检。 */
async function mcpSelfTest() {
  await run('mcp', async () => {
    state.mcp.loading = true;
    render();
    try {
      state.mcp.selftest = await api('/mcp/selftest');
      state.note = state.mcp.selftest?.ok ? '自检通过' : '自检没过';
    } finally {
      state.mcp.loading = false;
    }
  });
}

/** 把配置复制到剪贴板。剪贴板 API 在某些环境不让用，那就提示手动选中。 */
async function mcpCopy() {
  const text = state.mcp.config?.yaml ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    state.mcp.copied = true;
    state.note = '配置已经复制到剪贴板';
  } catch (error) {
    state.mcp.copied = false;
    state.error = `复制不了（${error instanceof Error ? error.message : String(error)}）。请手动选中上面那段文字复制。`;
  }
  render();
}

// --------------------------------------------------------------- 分析页

/** 分析页有哪几块。key 和 state.analysis.tab 对得上。 */
const ANALYSIS_TABS = [
  { key: 'overlap', name: 'mod 撞车', hint: '哪些 mod 在做同一件事' },
  { key: 'progress', name: '进度深度', hint: '加工链是陡还是平' },
  { key: 'mod', name: '拆 mod', hint: '看一个 mod 里有什么' },
  { key: 'path', name: '来路', hint: '这个物品怎么来的' },
  { key: 'uses', name: '谁在用', hint: '谁在用这个物品' },
  { key: 'kubejs', name: '脚本体检', hint: '脚本跑不跑得通' },
];

/**
 * 中栏：分析页（全是只读的分析）。
 *
 * 这批能力以前只以模型工具的形态存在。插件版删掉之后搬到这里 ——
 * core 里的函数一个没改，只是给了它们宿主路由和界面位置。
 */
function analysisPane() {
  const pane = el('div', { class: 'mcs-center' });
  const a = state.analysis;
  pane.append(
    el('div', { class: 'mcs-center-t' },
      el('span', { text: '分析' }),
      el('span', { class: 'mcs-spacer' }),
      el('span', { class: 'mcs-muted', text: '只读：这里的所有检查都不会动你的整合包' }),
    ),
  );

  const tabs = el('div', { class: 'mcs-atabs' });
  for (const t of ANALYSIS_TABS) {
    tabs.append(
      el('button', {
        class: `mcs-atab${a.tab === t.key ? ' mcs-atab-on' : ''}`,
        text: t.name,
        title: t.hint,
        onclick: () => { a.tab = t.key; render(); },
      }),
    );
  }
  pane.append(tabs);

  const body = el('div', { class: 'mcs-pane-body' });
  if (a.tab === 'overlap') body.append(analysisOverlap());
  else if (a.tab === 'progress') body.append(analysisProgress());
  else if (a.tab === 'mod') body.append(analysisMod());
  else if (a.tab === 'path') body.append(analysisPath());
  else if (a.tab === 'uses') body.append(analysisUses());
  else if (a.tab === 'kubejs') body.append(analysisKubejs());
  pane.append(body);
  return pane;
}

/** 分析页的标题行 + 「跑一下」按钮。 */
function analysisHeader(title, subtitle, busyKey, run) {
  return el('div', { class: 'mcs-center-t' },
    el('span', { text: title }),
    el('span', { class: 'mcs-muted', text: subtitle }),
    el('span', { class: 'mcs-spacer' }),
    btn(state.busy === busyKey ? '正在算…' : '跑一下', () => run(), {
      primary: state.busy !== busyKey,
      disabled: state.busy === busyKey,
    }),
  );
}

/** 把后端给的「人能读的清单」摆成一块。 */
function analysisLines(lines) {
  if (!lines || !lines.length) return null;
  return el('pre', { class: 'mcs-code mcs-code-sm', text: lines.join('\n') });
}

/** mod 撞车：同名物品 + 功能族分布。 */
function analysisOverlap() {
  const box = el('div');
  box.append(analysisHeader('mod 撞车', '同一个东西几个 mod 都在做', 'an-overlap', () => void loadAnalysisOverlap()));
  const r = state.analysis.overlap;
  if (!r) {
    box.append(el('div', { class: 'mcs-empty mcs-empty-big' },
      el('div', { text: '点「跑一下」看看这个包' }),
      el('div', { class: 'mcs-muted', text: '同名物品是「同一个路径出现在几个 mod 里」；功能族是按物品名里的词根猜的，只用来提示值得看一眼。' }),
    ));
    return box;
  }
  box.append(analysisLines(r.lines));
  if (r.collisions?.length) {
    const g = el('div', { class: 'mcs-group' });
    g.append(el('div', { class: 'mcs-group-t' },
      el('span', { text: '同名物品' }),
      el('span', { class: 'mcs-muted', text: `共 ${r.collisionCount} 组` }),
    ));
    for (const c of r.collisions) {
      g.append(el('div', { class: 'mcs-recipe-row' },
        el('div', { class: 'mcs-recipe-out' }, el('span', { text: c.path })),
        el('div', { class: 'mcs-recipe-meta', text: `${c.namespaces.join('、')}（${c.count} 个 mod）` }),
      ));
    }
    box.append(g);
  }
  if (r.crowdedFamilies?.length) {
    const g = el('div', { class: 'mcs-group' });
    g.append(el('div', { class: 'mcs-group-t' },
      el('span', { text: '功能撞车（≥2 个 mod 在做同一件事）' }),
      el('span', { class: 'mcs-muted', text: `${r.crowdedFamilies.length} 类` }),
    ));
    for (const f of r.families.filter((x) => x.crowded)) {
      g.append(el('div', { class: 'mcs-recipe-row' },
        el('div', { class: 'mcs-recipe-out' }, el('span', { text: f.family })),
        el('div', { class: 'mcs-recipe-meta', text: f.mods.map((m) => `${m.mod}(${m.items})`).join('、') }),
      ));
    }
    box.append(g);
  }
  if (r.emptyFamilies?.length) {
    box.append(card('一个 mod 都没覆盖的功能', el('div', { class: 'mcs-muted', text: r.emptyFamilies.join('、') })));
  }
  return box;
}

/** 进度深度：按合成链深度分层。 */
function analysisProgress() {
  const box = el('div');
  box.append(analysisHeader('进度深度', '物品挤在第几层', 'an-progress', () => void loadAnalysisProgress()));
  const r = state.analysis.progress;
  if (!r) {
    box.append(el('div', { class: 'mcs-empty mcs-empty-big' },
      el('div', { text: '点「跑一下」算一次' }),
      el('div', { class: 'mcs-muted', text: '第 0 层是基础资源（能采能捡的），越往后说明加工越深。看分布就知道这个包的进度是陡还是平。' }),
    ));
    return box;
  }
  box.append(analysisLines(r.lines));
  const max = Math.max(1, ...(r.buckets ?? []).map((b) => b.items));
  for (const b of r.buckets ?? []) {
    const bar = '█'.repeat(Math.max(0, Math.round((b.items / max) * 30)));
    box.append(el('div', { class: 'mcs-an-bucket' },
      el('span', { class: 'mcs-an-depth', text: `第 ${b.depth} 层` }),
      el('span', { class: 'mcs-an-count', text: `${b.items} 个` }),
      el('span', { class: 'mcs-an-bar', text: bar }),
    ));
    if (b.samples?.length) {
      box.append(el('div', { class: 'mcs-muted mcs-an-samples', text: `例：${b.samples.join('、')}` }));
    }
  }
  box.append(card('一句话结论', el('div', { class: 'mcs-muted', text: (r.lines ?? []).slice(-1)[0] ?? '' })));
  return box;
}

/** 拆开一个 mod 看里面有什么。 */
function analysisMod() {
  const box = el('div');
  const a = state.analysis;
  box.append(analysisHeader('拆开看 mod', 'jar 里到底装了什么', 'an-mod', () => void loadAnalysisMod()));
  box.append(
    el('div', { class: 'mcs-rq-row' },
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder: 'modId 或 jar 文件名，比如 create',
        value: a.modKey,
        'data-focus': 'anmod',
        oninput: (e) => { a.modKey = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') void loadAnalysisMod(); },
      }),
      btn(state.busy === 'an-mod' ? '拆…' : '拆开看', () => void loadAnalysisMod(), {
        primary: true,
        disabled: state.busy === 'an-mod',
      }),
    ),
  );
  const views = el('div', { class: 'mcs-atabs' });
  for (const v of ['summary', 'items', 'recipes', 'tags', 'loot', 'config']) {
    views.append(el('button', {
      class: `mcs-atab${a.modView === v ? ' mcs-atab-on' : ''}`,
      text: { summary: '概览', items: '物品', recipes: '配方', tags: '标签', loot: '掉落', config: '配置' }[v],
      onclick: () => { a.modView = v; render(); void loadAnalysisMod(); },
    }));
  }
  box.append(views);

  const r = a.mod;
  if (!r) {
    box.append(el('div', { class: 'mcs-empty mcs-empty-big', text: '填一个 mod 名，点「拆开看」。' }));
    return box;
  }
  box.append(card(r.name || r.modId || '这个 mod', kv([
    ['modId', r.modId || '—'],
    ['版本', r.version || '—'],
    ['jar', r.jarFile || '—'],
    ['物品', r.counts?.items ?? 0],
    ['配方', r.counts?.recipes ?? 0],
    ['标签', r.counts?.tags ?? 0],
    ['掉落表', r.counts?.loot ?? 0],
    ['配置文件', r.counts?.configs ?? 0],
  ])));
  if (r.notes?.length) box.append(card('说明', el('div', { class: 'mcs-muted', text: r.notes.join('\n') })));
  if (r.items?.length) {
    const g = el('div', { class: 'mcs-group' });
    g.append(el('div', { class: 'mcs-group-t' },
      el('span', { text: '物品' }),
      el('span', { class: 'mcs-muted', text: `共 ${r.itemTotal ?? r.items.length} 个` }),
    ));
    for (const it of r.items) {
      g.append(el('div', { class: 'mcs-recipe-row' },
        el('div', { class: 'mcs-recipe-out' }, iconImg(it.id, 20), el('span', { text: it.name || it.id })),
        el('div', { class: 'mcs-recipe-meta', text: it.id }),
      ));
    }
    box.append(g);
  }
  if (r.recipes?.length) {
    const g = el('div', { class: 'mcs-group' });
    g.append(el('div', { class: 'mcs-group-t' },
      el('span', { text: '配方' }),
      el('span', { class: 'mcs-muted', text: `共 ${r.recipeTotal ?? r.recipes.length} 条` }),
    ));
    for (const rec of r.recipes) {
      g.append(el('div', { class: 'mcs-recipe-row' },
        el('div', { class: 'mcs-recipe-out' },
          rec.result ? el('span', { text: `${rec.result.id}${rec.result.count > 1 ? ` ×${rec.result.count}` : ''}` }) : el('span', { text: '（没读到产物）' }),
        ),
        el('div', { class: 'mcs-recipe-meta', text: rec.type || rec.file }),
        rec.ingredients?.length ? el('div', { class: 'mcs-recipe-in', text: `材料：${rec.ingredients.slice(0, 8).join('、')}` }) : null,
      ));
    }
    box.append(g);
  }
  if (r.tags?.length) {
    const g = el('div', { class: 'mcs-group' });
    g.append(el('div', { class: 'mcs-group-t' },
      el('span', { text: '标签' }),
      el('span', { class: 'mcs-muted', text: `共 ${r.tagTotal ?? r.tags.length} 个` }),
    ));
    for (const t of r.tags) {
      g.append(el('div', { class: 'mcs-recipe-row' },
        el('div', { class: 'mcs-recipe-out' }, el('span', { text: t.tag })),
        el('div', { class: 'mcs-recipe-meta', text: (t.values ?? []).slice(0, 12).join('、') }),
      ));
    }
    box.append(g);
  }
  if (r.loot?.length) {
    const g = el('div', { class: 'mcs-group' });
    g.append(el('div', { class: 'mcs-group-t' },
      el('span', { text: '掉落表' }),
      el('span', { class: 'mcs-muted', text: `共 ${r.lootTotal ?? r.loot.length} 个` }),
    ));
    for (const l of r.loot) {
      g.append(el('div', { class: 'mcs-recipe-row' },
        el('div', { class: 'mcs-recipe-out' }, el('span', { text: l.file })),
        el('div', { class: 'mcs-recipe-meta', text: (l.items ?? []).slice(0, 12).join('、') }),
      ));
    }
    box.append(g);
  }
  if (r.configs?.length) {
    const g = el('div', { class: 'mcs-group' });
    g.append(el('div', { class: 'mcs-group-t' },
      el('span', { text: '配置文件' }),
      el('span', { class: 'mcs-muted', text: `共 ${r.configTotal ?? r.configs.length} 个` }),
    ));
    for (const c of r.configs) {
      g.append(el('div', { class: 'mcs-recipe-row' },
        el('div', { class: 'mcs-recipe-out' }, el('span', { text: c.file })),
        el('div', { class: 'mcs-recipe-meta', text: `${c.size ?? 0} 字节${c.own ? ' · 它自己的' : ''}` }),
        c.text ? el('pre', { class: 'mcs-code mcs-code-sm', text: c.text }) : null,
      ));
    }
    box.append(g);
  }
  return box;
}

/** 「来路 / 谁在用」共用的物品输入框。 */
function analysisItemInput() {
  const a = state.analysis;
  return el('div', { class: 'mcs-rq-row' },
    el('input', {
      class: 'mcs-input mcs-input-sm',
      placeholder: '物品 ID，比如 create:cogwheel',
      value: a.item,
      'data-focus': 'anitem',
      oninput: (e) => { a.item = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') void loadAnalysisPath(); },
    }),
    btn('查来路', () => void loadAnalysisPath(), { primary: true, disabled: state.busy === 'an-path' }),
    btn('查谁在用', () => void loadAnalysisUses(), { disabled: state.busy === 'an-uses' }),
  );
}

/** 来路：这个物品怎么来的（往上追几层）。 */
function analysisPath() {
  const box = el('div');
  box.append(analysisHeader('这个物品怎么来的', '顺着材料往上追', 'an-path', () => void loadAnalysisPath()));
  box.append(analysisItemInput());
  const r = state.analysis.path;
  if (!r) {
    box.append(el('div', { class: 'mcs-empty mcs-empty-big', text: '填一个物品 ID，点「查来路」。' }));
    return box;
  }
  if (!r.levels?.length) {
    box.append(el('div', { class: 'mcs-empty', text: `没有任何配方能做出 ${r.item}（它可能是原矿、木头这类直接采/捡的东西）。` }));
    return box;
  }
  r.levels.forEach((row, i) => {
    const g = el('div', { class: 'mcs-group' });
    g.append(el('div', { class: 'mcs-group-t' },
      el('span', { text: `第 ${i + 1} 层往回追` }),
      el('span', { class: 'mcs-muted', text: `${row.length} 条配方` }),
    ));
    for (const rec of row) {
      g.append(el('div', {
        class: 'mcs-recipe-row',
        onclick: () => { void openRecipe(rec.recipe); },
      },
        el('div', { class: 'mcs-recipe-out' }, el('span', { text: rec.item })),
        el('div', { class: 'mcs-recipe-meta', text: `${rec.type || '未知类型'} · ${rec.recipe}` }),
        rec.from?.length ? el('div', { class: 'mcs-recipe-in', text: `材料：${rec.from.slice(0, 8).join('、')}` }) : null,
      ));
    }
    box.append(g);
  });
  if (r.truncated) box.append(el('div', { class: 'mcs-muted', text: '链条太长，这里只展开了一部分。' }));
  return box;
}

/** 谁在用它。 */
function analysisUses() {
  const box = el('div');
  box.append(analysisHeader('谁在用它', '删之前先看看有没有配方在用', 'an-uses', () => void loadAnalysisUses()));
  box.append(analysisItemInput());
  const r = state.analysis.uses;
  if (!r) {
    box.append(el('div', { class: 'mcs-empty mcs-empty-big', text: '填一个物品 ID，点「查谁在用」。' }));
    return box;
  }
  if (!r.count) {
    box.append(el('div', { class: 'mcs-empty', text: `没有配方在用 ${r.item}。` }));
    return box;
  }
  const g = el('div', { class: 'mcs-group' });
  g.append(el('div', { class: 'mcs-group-t' },
    el('span', { text: '用它的配方' }),
    el('span', { class: 'mcs-muted', text: `共 ${r.count} 条` }),
  ));
  for (const rec of r.recipes) {
    g.append(el('div', {
      class: 'mcs-recipe-row',
      onclick: () => { void openRecipe(rec.id); },
    },
      el('div', { class: 'mcs-recipe-out' }, el('span', { text: (rec.outputs ?? []).join('、') || rec.id })),
      el('div', { class: 'mcs-recipe-meta', text: `${rec.type || '未知类型'} · ${rec.id}` }),
    ));
  }
  box.append(g);
  return box;
}

/** KubeJS 脚本体检。 */
function analysisKubejs() {
  const box = el('div');
  box.append(analysisHeader('KubeJS 脚本体检', '脚本跑不跑得通、引用的东西在不在', 'an-kubejs', () => void loadAnalysisKubejs()));
  const r = state.analysis.kubejs;
  if (!r) {
    box.append(el('div', { class: 'mcs-empty mcs-empty-big' },
      el('div', { text: '点「跑一下」体检一遍' }),
      el('div', { class: 'mcs-muted', text: '会把所有脚本真跑一遍（在自己造的沙箱里跑，不会碰游戏），看语法对不对、运行时会不会报错、引用的物品在不在这个包里。' }),
    ));
    return box;
  }
  box.append(analysisLines(r.lines));
  const bad = (r.scripts ?? []).filter((s) => s.status !== 'ok');
  if (bad.length) {
    const g = el('div', { class: 'mcs-group' });
    g.append(el('div', { class: 'mcs-group-t' }, el('span', { text: '出问题的脚本' })));
    for (const s of bad) {
      g.append(el('div', { class: 'mcs-recipe-row' },
        el('div', { class: 'mcs-recipe-out' }, el('span', { text: s.file })),
        el('div', { class: 'mcs-recipe-meta', text: `${s.status}${s.line ? ` 第 ${s.line} 行` : ''}` }),
        s.error ? el('div', { class: 'mcs-recipe-in', text: s.error }) : null,
      ));
    }
    box.append(g);
  }
  if (r.missingItems?.length) {
    const g = el('div', { class: 'mcs-group' });
    g.append(el('div', { class: 'mcs-group-t' },
      el('span', { text: '引用了不存在的物品' }),
      el('span', { class: 'mcs-muted', text: `${r.missingItems.length} 处` }),
    ));
    for (const m of r.missingItems) {
      g.append(el('div', { class: 'mcs-recipe-row' },
        el('div', { class: 'mcs-recipe-out' }, el('span', { text: m.id })),
        el('div', { class: 'mcs-recipe-meta', text: m.file }),
      ));
    }
    box.append(g);
  }
  return box;
}

/** 跑 mod 撞车。 */
async function loadAnalysisOverlap() {
  await run('an-overlap', async () => {
    state.analysis.overlap = await api('/analysis/overlap', { dir: state.dir, id: state.instanceId });
  });
}

/** 跑进度曲线。 */
async function loadAnalysisProgress() {
  await run('an-progress', async () => {
    state.analysis.progress = await api('/analysis/progress', { dir: state.dir, id: state.instanceId });
  });
}

/** 拆一个 mod。 */
async function loadAnalysisMod() {
  const key = String(state.analysis.modKey ?? '').trim();
  if (!key) return;
  await run('an-mod', async () => {
    state.analysis.mod = await api('/analysis/mod', {
      dir: state.dir,
      id: state.instanceId,
      modId: key,
      view: state.analysis.modView,
    });
  });
}

/** 查来路。 */
async function loadAnalysisPath() {
  const item = String(state.analysis.item ?? '').trim();
  if (!item) return;
  await run('an-path', async () => {
    state.analysis.path = await api('/analysis/recipe-path', { dir: state.dir, id: state.instanceId, item });
  });
}

/** 查谁在用。 */
async function loadAnalysisUses() {
  const item = String(state.analysis.item ?? '').trim();
  if (!item) return;
  await run('an-uses', async () => {
    state.analysis.uses = await api('/analysis/recipe-uses', { dir: state.dir, id: state.instanceId, item });
  });
}

/** 跑 KubeJS 脚本体检。 */
async function loadAnalysisKubejs() {
  await run('an-kubejs', async () => {
    state.analysis.kubejs = await api('/analysis/kubejs', { dir: state.dir, id: state.instanceId });
  });
}

/** 右栏：非蓝图面板的说明卡（蓝图面板才显示任务详情）。 */
function contextSide() {
  const right = el('div', { class: 'mcs-right' });
  if (state.panel === 'content') return recipeSide();
  right.append(el('div', { class: 'mcs-right-t' }, el('span', { text: state.panel === 'pack' ? '打包说明' : state.panel === 'verify' ? '启动说明' : state.panel === 'iconguide' ? '图标说明' : '说明' })));
  if (state.panel === 'pack') {
    right.append(
      card('三种形态怎么选',
        el('div', { class: 'mcs-muted', text: '完整实例（offline）：最稳，PCL 会把它认成一个游戏实例，双击就能玩。缺点是体积大（带 libraries 和 assets）。' }),
        el('div', { class: 'mcs-muted', text: '轻量包（standard）：只带 mods/config/kubejs，体积小，适合发给已经装过 PCL 的朋友。对方要自己下游戏本体。' }),
        el('div', { class: 'mcs-muted', text: '带启动器（launcher）：完整实例外面套一层 PCL.exe，适合完全没装过 Minecraft 的人。' }),
      ),
      card('打完之后', el('div', { class: 'mcs-muted', text: '打完会自动打开 zip 自检（路径字符、包裹层数、versions/<名>/<名>.json 在不在）。自检没过会明确告诉你是哪一条。' })),
    );
    return right;
  }
  if (state.panel === 'verify') {
    right.append(
      card('为什么要先算再启动',
        el('div', { class: 'mcs-muted', text: '启动失败时 JVM 给的报错通常没法看懂。先算一遍能提前拦住最常见两种硬伤：库文件没下全、客户端 jar 缺失 —— 这两种直接启动只会拿到一堆无解的报错。' }),
      ),
      card('看到「没到主菜单」怎么办',
        el('div', { class: 'mcs-muted', text: '结果里的「可能的原因」会按可能性列出方向：写权限、mixin 冲突、natives 没解出来、缺前置、Java 版本不对、内存不足。照着排通常能定位。' }),
      ),
    );
    return right;
  }
  if (state.panel === 'iconguide') {
    right.append(
      card('为什么不让工作室自己画',
        el('div', { class: 'mcs-muted', text: '物品的样子是在游戏里由模型、材质和光照一起画出来的。整合包里只存了配方和数据，没存「一张画好的图标」。离线猜只能是大概，做不到 100% 一样。' }),
        el('div', { class: 'mcs-muted', text: '所以这一步交给游戏自己：让它把每个物品真正画一遍、存成图片，工作室只负责读。' }),
      ),
      card('会不会动我的整合包',
        el('div', { class: 'mcs-muted', text: '不会。工作室这一页只做两件事：教你怎么装导出用的 mod、点「重新扫描图标」去读游戏已经导出的图片。' }),
        el('div', { class: 'mcs-muted', text: '图标文件是游戏写出来的，工作室从头到尾只读不改；也不会替你联网下载任何 mod。' }),
      ),
    );
    return right;
  }
  right.append(card('说明', el('div', { class: 'mcs-muted', text: '左边选一个阶段开始。' })));
  return right;
}

/**
 * 游戏预览窗口 —— 预览态（`canvasLook === 'game'`）下点任务节点，在画布正中弹出。
 *
 * 用户原话（2026-11-12）：「预览视角和游戏里看到的效果一样（就是说在画布中心显示一个窗口，
 * 包括翻页，图片，也能打勾完成任务模拟提交和获取）」。
 *
 * 为什么做成「点节点才弹」而不是让画布本身就是游戏界面：画布上要能看见整章的关系
 * （谁依赖谁），那个是游戏里没有、但做包时必须要看的东西。所以两者并存：
 * 画布 = 地图，这个窗口 = 点开后看到的那一屏。
 *
 * 复刻了游戏里 FTB 任务界面这几样：
 *   1. 顶部形状框 + 图标（和画布节点同一套贴图）
 *   2. 标题 / 副标题（带 `&6` 那种颜色）
 *   3. 描述正文 + **翻页**（`{@pagebreak}`）+ 描述里的图片
 *   4. 要求列表，**每行能打勾**（模拟「提交」）
 *   5. 奖励列表，完成之后显示为可领取（模拟「获取」）
 *
 * ⚠️ 全程**只在界面上模拟**，绝不写盘：这个窗口是「看效果」用的，
 *    勾选状态存在 `state.previewQuest.done` 里，关掉就没了。
 */
function questPreviewWindow() {
  const pq = state.previewQuest;
  if (state.canvasLook !== 'game') return null;
  if (!pq?.questId) return null;
  const detail = state.questDetail;
  // 详情还在路上 / 加载失败：给一句话，别显示空白窗口
  if (!detail || detail.id !== pq.questId) {
    return el('div', { class: 'mcs-game-win' },
      el('div', { class: 'mcs-game-win-t', text: '正在读这个任务…' }),
      el('div', { class: 'mcs-muted', text: pq.questId }),
    );
  }

  const box = el('div', { class: 'mcs-game-win' });

  // —— 顶部：小图标 + 标题（居中）+ 副标题（斜体灰）——
  //
  // 照抄 ViewQuestPanel 的真值（:150-165 / :345-347）：
  //   标题居中、最小宽 150、最大宽 500、行距 9
  //   图标 `iconSize = min(16, titleH + 2)` ⇒ **单行标题时只有 10px**
  //      （以前我们做了个 48px 的大图标排在左边，和游戏完全不是一回事）
  //   副标题 **斜体 + 灰色 #AAAAAA**（源码写死 ITALIC, GRAY）
  const head = el('div', { class: 'mcs-game-win-head' });
  const iconWrap = el('div', { class: 'mcs-game-win-icon' });
  if (detail.icon && state.icons[detail.icon]) {
    iconWrap.append(el('img', { src: state.icons[detail.icon], alt: '', draggable: 'false' }));
  } else {
    iconWrap.append(el('div', { class: 'mcs-game-win-icon-ph' }));
  }
  head.append(iconWrap);
  const titles = el('div', { class: 'mcs-game-win-titles' });
  titles.append(el('div', { class: 'mcs-game-win-title' }, mcText(detail.titleSpans, detail.title || detail.id)));
  if (String(detail.subtitle ?? '').trim()) {
    // 斜体 + 灰（mcs-game-win-sub 的 CSS 负责，这里不加内联样式）
    titles.append(el('div', { class: 'mcs-game-win-sub' }, mcText(detail.subtitleSpans, detail.subtitle)));
  }
  head.append(titles);
  // 右上角关掉
  head.append(el('span', {
    class: 'mcs-game-win-x',
    text: '×',
    title: '关掉预览（Esc）',
    onclick: () => closeQuestPreview(),
  }));
  box.append(head);

  // —— 描述：分页 + 图片 ——
  // `descriptionPages` 是后端按 `{@pagebreak}` 分好的；没有就退回单页。
  const pages = Array.isArray(detail.descriptionPages) && detail.descriptionPages.length
    ? detail.descriptionPages
    : [Array.isArray(detail.descriptionBlocks) ? detail.descriptionBlocks.flat() : []];
  const pageCount = pages.length;
  const page = Math.min(Math.max(Number(pq.page) || 0, 0), Math.max(0, pageCount - 1));

  // —— 要求 / 奖励：**左右两栏并排**（这是和游戏差异最大的一条）——
  //
  // 真值（ViewQuestPanel.java:288-311）：`w2 = w/2`，
  //   任务区  x = 2,      宽 w2 - 3
  //   奖励区  x = w2 + 2, 宽 w2 - 3
  //   中间一条 1px 竖线落在 x = w/2
  // 以前我们是「要求一坨、奖励一坨」上下堆叠，结构就和游戏不一样。
  const cols = el('div', { class: 'mcs-game-win-cols' });
  const tasks = detail.tasks ?? [];
  const rewards = detail.rewards ?? [];
  const doneSet = new Set(pq.done ?? []);
  const allDone = tasks.length > 0 && doneSet.size >= tasks.length;

  // 左栏：任务目标（标题色 #5555FF 蓝）
  const taskCol = el('div', { class: 'mcs-game-win-col mcs-game-win-col-task' });
  taskCol.append(el('div', { class: 'mcs-game-win-col-t', text: '任务目标' }));
  if (tasks.length) {
    for (let i = 0; i < tasks.length; i += 1) {
      const t = tasks[i];
      const what = String(t.what ?? '');
      const shown = String(t.label ?? '') || what || String(t.type ?? '?');
      const count = Number(t.count ?? 1);
      const checked = doneSet.has(i);
      taskCol.append(el('div', {
        class: `mcs-game-win-cell mcs-game-win-cell-task${checked ? ' mcs-game-win-cell-done' : ''}`,
        title: '点一下模拟完成（只是看效果，不会改任务书）',
        onclick: () => {
          if (doneSet.has(i)) doneSet.delete(i);
          else doneSet.add(i);
          pq.done = [...doneSet];
          render();
        },
      },
        // 格子 18×18、图标 16×16（TaskButton 真值）
        iconImg(what, 16),
        // 完成 → 右上角画 8×8 绿对勾；未完成什么都不画
        // （以前用 ✔/☐ 两个文字符号，游戏里根本没有这两个字）
        checked ? el('span', { class: 'mcs-game-win-check' }) : null,
        el('span', { class: 'mcs-game-win-cell-n', text: shown, title: shown !== what ? what : '' }),
        count > 1 ? el('span', { class: 'mcs-game-win-cell-c', text: String(count) }) : null,
      ));
    }
  } else {
    // 非编辑模式且列表空 → 灰色「没有任务」占位（源码真值）
    taskCol.append(el('div', { class: 'mcs-game-win-empty', text: '没有任务' }));
  }
  cols.append(taskCol);

  // 中间竖线
  cols.append(el('div', { class: 'mcs-game-win-divider' }));

  // 右栏：任务奖励（标题色 #FFAA00 橙）
  const rewardCol = el('div', { class: 'mcs-game-win-col mcs-game-win-col-reward' });
  rewardCol.append(el('div', { class: 'mcs-game-win-col-t', text: '任务奖励' }));
  if (rewards.length) {
    for (const r of rewards) {
      const what = String(r.what ?? '');
      const shown = String(r.label ?? '') || what || String(r.type ?? '?');
      const count = Number(r.count ?? 1);
      rewardCol.append(el('div', {
        class: `mcs-game-win-cell mcs-game-win-cell-reward${allDone ? ' mcs-game-win-cell-ready' : ''}`,
      },
        iconImg(what, 16),
        el('span', { class: 'mcs-game-win-cell-n', text: shown, title: shown !== what ? what : '' }),
        count > 1 ? el('span', { class: 'mcs-game-win-cell-c', text: String(count) }) : null,
      ));
    }
  } else {
    rewardCol.append(el('div', { class: 'mcs-game-win-empty', text: '没有奖励' }));
  }
  cols.append(rewardCol);
  box.append(cols);

  // —— 描述放在两栏**下面**（源码：描述区 y = 16 + h + 12）——
  const body = el('div', { class: 'mcs-game-win-body' });
  const pageBlocks = pages[page] ?? [];
  const hasContent = pageBlocks.some((b) => b?.kind === 'image' || String(b?.text ?? '').trim());
  if (hasContent) {
    for (const b of pageBlocks) body.append(descBlockEl(b));
  } else if (page === 0) {
    // 游戏里没有描述就是空白，但空白窗口看着像坏了 —— 说明一句
    body.append(el('div', { class: 'mcs-muted', text: '（这个任务没有描述）' }));
  }
  box.append(body);

  // 翻页：和游戏里一样在描述下方。
  // 真值：页码是 `1/3`（**无空格**）、灰色、只在 size>1 时出现；
  //      上一页只在 cur>0 时**出现**（不是置灰），下一页同理。
  if (pageCount > 1) {
    const pager = el('div', { class: 'mcs-game-win-pager' });
    if (page > 0) {
      pager.append(el('button', {
        class: 'mcs-game-win-pg',
        text: '◀',
        title: '上一页',
        onclick: () => { pq.page = page - 1; render(); },
      }));
    }
    pager.append(el('span', { class: 'mcs-game-win-pgn', text: `${page + 1}/${pageCount}` }));
    if (page < pageCount - 1) {
      pager.append(el('button', {
        class: 'mcs-game-win-pg',
        text: '▶',
        title: '下一页',
        onclick: () => { pq.page = page + 1; render(); },
      }));
    }
    box.append(pager);
  }

  // 底部：一句免责说明，免得用户以为真的提交了
  box.append(el('div', { class: 'mcs-game-win-foot', text: '这是预览：打勾只是看效果，不会改任务书，也不会影响游戏里的进度。' }));
  return box;
}

/** 关掉预览窗口（不动别的状态）。 */
function closeQuestPreview() {
  state.previewQuest = { questId: '', page: 0, done: [] };
  render();
}

/** 打开某个任务的预览窗口（预览态下点节点走这里）。 */
async function openQuestPreview(questId) {
  state.previewQuest = { questId, page: 0, done: [] };
  // 先让窗口出现（带「正在读」），详情回来再重画
  await selectQuest(questId);
}

/**
 * 一行描述 → DOM。文字块和图片块混排，图片块取不到图时留一句占位。
 *
 * 取图走 `state.questImages`（和章节背景图共用同一份缓存），由
 * `ensureDescImages()` 提前换好；这里只负责画，不发请求 ——
 * **绝不能在渲染过程中发请求再 render()**，那是递归。
 */
/**
 * 一个描述块 → DOM（文字块或图片块）。
 *
 * 2026-11-11 改：从「一行一个 div」改成「一块一个 div」，因为分页之后顺序是扁平的
 * （一页里有多块，块之间不再有行边界的概念）。换行靠 `.mcs-detail-desc` 的
 * `white-space: pre-wrap`，`\n` 已经在 core 里还原成真字符了。
 *
 * 占位符（后端换好名字的那些）画成浅色小标签 —— 用户一眼能看出「这是游戏里的名字」，
 * 而不是作者写的字。
 */
function descBlockEl(b) {
  if (b?.kind === 'image') {
    const href = state.questImages[b.src];
    if (href) {
      return el('img', {
        class: 'mcs-desc-img',
        src: href,
        width: Number(b.width) || undefined,
        alt: '',
        // 对齐由 align 决定（FTB 的 left / center / right）
        style: `display:block;margin:6px auto;${b.align === 'left' ? 'margin-left:0;' : b.align === 'right' ? 'margin-right:0;' : ''}`,
      });
    }
    // 取不到图：原样显示资源 ID，方便用户看清楚缺的是哪张（而不是静默消失）
    return el('div', { class: 'mcs-desc-img-missing', text: `（图片取不到：${b.src}）` });
  }
  const spans = Array.isArray(b?.spans) ? b.spans : null;
  const inner = spans && spans.length
    ? [mcText(spans, String(b?.text ?? ''))]
    : [String(b?.text ?? '')];
  // holderName 说明这块原本是 `{item.x}` 占位符，后端已经换成中文名了
  const cls = b?.holderName ? 'mcs-detail-desc mcs-desc-holder' : 'mcs-detail-desc';
  return el('div', { class: cls }, ...inner);
}

/**
 * 一行描述 → DOM（一块列表包一层）。保留给「按行」的调用方（老路径 / 测试）。
 * @param {Array<object>} line
 */
function descLineEl(line) {
  return el('div', { class: 'mcs-desc-line' }, ...(Array.isArray(line) ? line : []).map((b) => descBlockEl(b)));
}

/** 右栏：选中任务的详情 + 编辑卡。 */
/**
 * 任务详情卡的主体：简介、要求、奖励三块。
 *
 * 为什么单独拆出来：后端 /quest 一直返回 description / tasks / rewards，
 * 但界面之前只显示「要求 N 条」一个数字 —— 用户看不见要交什么、能拿什么奖励
 * （2026-11-02 用户反馈）。这三块数据形状不同，不适合塞进 kv() 的行式布局。
 */
/**
 * 「前置」那一栏下面那句补充说明（2026-11-12 第二批）。
 *
 * FTB 的依赖有四种满足方式（源码 `DependencyRequirement.java`），默认的
 * `all_completed`（前置全做完）不用额外解释；另外三种必须说出来，
 * 否则用户看到一串前置会理所当然地当成「与」，而这 44 个任务其实是「或」。
 * `min_required_dependencies > 0` 的优先级最高，连依赖方式都不看 —— 单独一句。
 */
function dependencyNote(detail) {
  const min = Number(detail?.minRequiredDependencies ?? 0) || 0;
  if (min > 0) return `满足其中 ${min} 个就行（这个设置优先于下面的依赖方式）`;
  const req = String(detail?.dependencyRequirement ?? 'all_completed');
  if (req === 'one_completed') return '任意一个做完就行（不是全部）';
  if (req === 'all_started') return '全部「开始」了就行，不用做完';
  if (req === 'one_started') return '任意一个「开始」了就行，不用做完';
  return ''; // all_completed：就是「全部做完」，不用啰嗦
}

function questDetailBody(detail) {
  const parts = [];

  // 简介：lang 里的 quest_desc。
  //
  // 2026-11-11 改成**按页渲染**（用户：「很多任务需要翻页查看」）。三种数据形状依次退：
  //   1. `descriptionPages` —— 后端已经按 `{@pagebreak}` 分好页、占位符也换成中文名了
  //   2. `descriptionBlocks` —— 老后端只有这个（一行一层，没分页）
  //   3. `description` —— 纯字符串数组（最老的形状 / 测试替身）
  // 越往后功能越少，但都保证能显示，不会白屏。
  //
  // ★ **没有描述时整块都不显示**（2026-11-11 用户：「有的任务只有标题没有描述也没有奖励，
  //   意思是标题就能够指引了」）。判断不能只看 `pages.length` —— 后端对没描述的任务
  //   也会回 `[[]]`（一页、零个块），只看长度会渲染出一个空的「简介」标题，
  //   那比不显示更让人迷惑。所以要判「这一页里到底有没有内容」。
  const pages = Array.isArray(detail.descriptionPages) && detail.descriptionPages.length
    ? detail.descriptionPages
    : null;
  const blocks = Array.isArray(detail.descriptionBlocks) ? detail.descriptionBlocks : null;
  /** 这一页有没有真正能显示的东西（空字符串块不算）。 */
  const pageHasContent = (page) => (Array.isArray(page) ? page : []).some((b) => {
    if (!b) return false;
    if (b.kind === 'image') return true;
    return String(b.text ?? '').trim() !== '';
  });

  if (pages && pages.some(pageHasContent)) {
    const total = pages.length;
    // 页号存在 state 里（每个任务一份，切换任务时 reset）
    const page = Math.min(Math.max(Number(state.descPage ?? 0) || 0, 0), total - 1);
    const sec = el('div', { class: 'mcs-detail-sec' });
    sec.append(el('div', { class: 'mcs-detail-sec-t' }, el('span', { text: '简介' }),
      total > 1 ? el('span', { class: 'mcs-muted', text: `　第 ${page + 1} / ${total} 页` }) : null));
    for (const b of pages[page] ?? []) sec.append(descBlockEl(b));
    if (total > 1) {
      sec.append(row(
        btn('← 上一页', () => { state.descPage = Math.max(0, page - 1); render(); }, { disabled: page <= 0 }),
        btn('下一页 →', () => { state.descPage = Math.min(total - 1, page + 1); render(); }, { disabled: page >= total - 1 }),
      ));
    }
    parts.push(sec);
  } else if (blocks && blocks.flat().some((b) => b?.kind === 'image' || String(b?.text ?? '').trim())) {
    parts.push(
      el('div', { class: 'mcs-detail-sec' },
        el('div', { class: 'mcs-detail-sec-t', text: '简介' }),
        ...blocks.flat().map((b) => descBlockEl(b)),
      ),
    );
  } else {
    const desc = Array.isArray(detail.description) ? detail.description.filter((l) => String(l ?? '').trim()) : [];
    if (desc.length) {
      parts.push(
        el('div', { class: 'mcs-detail-sec' },
          el('div', { class: 'mcs-detail-sec-t', text: '简介' }),
          ...desc.map((line) => el('div', { class: 'mcs-detail-desc', text: line })),
        ),
      );
    }
  }

  // 要求：要交什么物品 / 杀什么怪，带图标。旁边追加一句人话类型说明（真后端给 spec 时）。
  const tasks = detail.tasks ?? [];
  if (tasks.length) {
    const list = el('div', { class: 'mcs-detail-sec' },
      el('div', { class: 'mcs-detail-sec-t', text: '要求' }),
    );
    tasks.forEach((t, i) => {
      const what = String(t.what ?? '');
      const count = Number(t.count ?? 1);
      // 显示名（2026-11-12 第五批 B）：优先用 `title` —— 那是**游戏里真会显示的样子**，
      // 带类型前缀和颜色（`访问维度: minecraft:the_nether（下界）` 深绿、`进度: X` 黄）。
      // 没有 title 就退回 label（不带前缀的中文名），再退回原始 ID。
      const shown = String(t.title ?? '') || String(t.label ?? '') || what || String(t.type ?? '?');
      const label = String(detail.taskSpecs?.[i]?.label ?? '');
      // 名字和 ID 不一样时（真翻出了中文名），把 ID 放进 title，鼠标悬停能看到原值。
      // 一样时（这个 mod 没做汉化）就别 tooltip 同一句话了。
      const idTip = shown !== what && what ? what : '';
      // 有 titleParts 就按游戏那样分段上色（前缀白、变量绿/黄）；没有就纯文字
      const nameEl = Array.isArray(t.titleParts) && t.titleParts.length
        ? el('span', {
          class: 'mcs-detail-item-name',
          title: idTip,
        }, ...t.titleParts.map((p) => el('span', { text: String(p?.text ?? ''), style: p?.color ? `color:${p.color}` : '' })))
        : el('span', { class: 'mcs-detail-item-name', text: shown, title: idTip });
      list.append(
        el('div', { class: 'mcs-detail-item' },
          iconImg(what, 18),
          nameEl,
          el('span', { class: 'mcs-muted', text: count > 1 ? `× ${count}` : '' }),
          label ? el('span', { class: 'mcs-muted', text: label }) : null,
        ),
      );
    });
    parts.push(list);
  }

  // 奖励：完成之后给什么（物品 / 经验 / 战利品表）
  const rewards = detail.rewards ?? [];
  if (rewards.length) {
    const list = el('div', { class: 'mcs-detail-sec' },
      el('div', { class: 'mcs-detail-sec-t', text: '奖励' }),
    );
    for (const r of rewards) {
      const what = String(r.what ?? '');
      const count = Number(r.count ?? 1);
      const isItem = what.includes(':');
      const label = String(r.spec?.label ?? '');
      // 同「要求」：后端给的 label 是中文名，查不到时等于原始 ID
      const shown = String(r.label ?? '') || what || String(r.type ?? '?');
      const idTip = shown !== what && what ? what : '';
      list.append(
        el('div', { class: 'mcs-detail-item' },
          isItem ? iconImg(what, 18) : el('span', { class: 'mcs-icon-ph', style: 'width:18px;height:18px' }),
          el('span', { class: 'mcs-detail-item-name', text: shown, title: idTip }),
          el('span', { class: 'mcs-muted', text: `${r.type ?? ''}${count > 1 ? ` × ${count}` : ''}` }),
          label ? el('span', { class: 'mcs-muted', text: label }) : null,
        ),
      );
    }
    parts.push(list);
  }

  // 前置 / 后续（2026-11-12 用户：「前置、后置、奖励都是点击任务节点后出现的」）。
  //
  // 游戏里节点的画面上只有图标，依赖关系要点开任务才看得到；右栏就是这个
  // 「点开之后」的地方 —— 所以这两个列表必须在这里，而不是画在节点旁边。
  // 后端 `/quest` 一直都返回 upstream / downstream（`lib/host/quest-api.js` 的
  // `handleQuestDetail`），以前只是没在界面上用。名字已经由
  // `questDisplayName()` 换成标题了，别拿 id 当显示文本。
  const depsSection = (label, list, empty, note = '') => {
    const items = Array.isArray(list) ? list : [];
    const sec = el('div', { class: 'mcs-detail-sec' },
      el('div', { class: 'mcs-detail-sec-t' }, el('span', { text: label }),
        el('span', { class: 'mcs-muted', text: `　${items.length} 个` })),
    );
    // 依赖方式的补充说明（2026-11-12 第二批）：默认的「全部完成」不用多说，
    // 另外三种不提就等于显示假信息 —— 用户会以为前置是「与」关系。
    if (note) sec.append(el('div', { class: 'mcs-muted mcs-detail-depnote', text: note }));
    if (!items.length) {
      sec.append(el('div', { class: 'mcs-detail-desc mcs-muted', text: empty }));
      return sec;
    }
    for (const d of items) {
      const id = String(d?.id ?? '');
      const gone = d?.exists === false; // 悬空依赖：那个任务 ID 根本不存在
      sec.append(el('div', {
        class: `mcs-detail-item${gone ? ' mcs-detail-item-gone' : ''}${id ? ' mcs-detail-jump' : ''}`,
        // 点一下直接跳到那个任务（和诊断面板同一套跳转）—— 顺着任务书往下看很顺手
        //
        // ★ 2026-11-12 修两处：
        //   ① 必须带 chapterId：跨章节的前置如果只传 questId，jumpToIssue() 得先
        //      `findNode()` 在 canvas 里找 —— 而 canvas 只装着**已打开章节**的节点，
        //      找不到就只能静默 return，用户感觉是「点了没反应」。
        //   ② 十六进制 ID 挪进悬停提示：名字上屏，ID 仍能用来搜 / 定位（不丢信息）。
        title: gone ? '这个任务不存在'
          : [id ? '点一下跳到那个任务' : '', d?.chapterTitle ? `它在「${d.chapterTitle}」` : '']
            .filter(Boolean).join(' · '),
        onclick: gone || !id ? null : () => { void jumpToIssue({ questId: id, chapterId: d?.chapterId }); },
      },
        el('span', { class: 'mcs-detail-item-name', text: String(d?.title ?? id ?? '?') }),
        gone ? el('span', { class: 'mcs-muted', text: '（不存在）' }) : null,
      ));
    }
    return sec;
  };
  parts.push(depsSection('前置', detail.upstream, '没有前置，开局就能做', dependencyNote(detail)));
  parts.push(depsSection('后续', detail.downstream, '没有后续，做完就是一条线的终点'));

  // 三个改变玩家体验的开关（2026-11-12 第五批）。
  // 真包实测 ATM10Sky：可选任务 633 个、对玩家不可见 51 个 —— 这些以前在界面上
  // 完全看不出来，作者配了「可选」也不知道自己配了。
  const flags = [];
  if (detail.optional === true) flags.push('可选任务（不做也能往下走）');
  if (detail.invisible === true) flags.push('对玩家不可见（游戏里根本看不到这个任务）');
  if (detail.canRepeat === true) flags.push('可以重复做');
  else if (detail.canRepeat === false) flags.push('不能重复做');
  // canRepeat === null 表示「跟随章节设置」，不用特意说
  if (flags.length) {
    const sec = el('div', { class: 'mcs-detail-sec' },
      el('div', { class: 'mcs-detail-sec-t' }, el('span', { text: '特殊设置' })));
    for (const f of flags) sec.append(el('div', { class: 'mcs-detail-item' }, el('span', { text: f })));
    parts.push(sec);
  }

  return parts;
}

// --------------------------------------------------------------- 物品网格（JEI 式）

/**
 * 物品输入框 → 「往哪儿填」。
 *
 * 网格点一下要把 ID 填进「你正在编辑的那个框」。但界面是全量重画的，
 * 靠 document.activeElement 记不住（重画之后那个元素已经没了）。
 * 所以每个物品输入框在 onfocus 时把键名记进 `state.grid.field`，
 * 这里再用一张表把键名映射回「改哪个字段」。
 */
const GRID_FILL = {
  // 新建任务
  newtaskitem: (v) => { if (state.draft) state.draft.taskItem = v; },
  newrewarditem: (v) => { if (state.draft) state.draft.rewardItem = v; },
  // 改已有任务
  rtaskitem: (v) => { if (state.draft) state.draft.taskItem = v; },
  rrewarditem: (v) => { if (state.draft) state.draft.rewardItem = v; },
  // 换图标 / 新建章节的图标
  iconvalue: (v) => { if (state.draft) state.draft.value = v; },
  chicon: (v) => { if (state.draft) state.draft.icon = v; },
};

/** 物品输入框：带 data-focus、记焦点、能接拖进来的物品。 */
function itemInput(key, value, placeholder, extraClass = '') {
  return el('input', {
    class: `mcs-input${extraClass ? ` ${extraClass}` : ''}`,
    placeholder,
    value: value ?? '',
    'data-focus': key,
    // 聚焦即「这是我要填的框」—— 网格点一下就往这儿填
    onfocus: () => { state.grid.field = key; },
    oninput: (e) => { GRID_FILL[key]?.(e.target.value); },
    // 拖拽落点：从网格里拖一个物品过来
    ondragover: (e) => { if (e?.preventDefault) e.preventDefault(); },
    ondrop: (e) => {
      if (e?.preventDefault) e.preventDefault();
      const id = String(e?.dataTransfer?.getData?.('text/plain') ?? '').trim();
      if (id) fillItemInto(key, id);
    },
  });
}

/** 那些框在界面上叫什么（填完之后要在状态栏说清填到哪儿去了）。 */
const GRID_LABEL = {
  newtaskitem: '新建任务的完成条件',
  newrewarditem: '新建任务的奖励',
  rtaskitem: '完成条件的物品',
  rrewarditem: '奖励物品',
  iconvalue: '任务图标',
  chicon: '章节图标',
};

/** 把物品 ID 填进某个框（连草稿状态一起改）。 */
function fillItemInto(key, itemId) {
  const set = GRID_FILL[key];
  if (!set) return;
  set(itemId);
  // 同步 DOM 上那个框，否则重画之前用户看到的是旧值
  const node = document.querySelector(`[data-focus="${key}"]`);
  if (node) node.value = itemId;
  state.grid.field = key;
  state.grid.pick = itemId;
  state.grid.filled = { field: key, id: itemId };
  // 右栏这时显示的是网格（那个框在「详情」页签里），所以必须说一句
  // 「填到哪儿去了」，否则用户点完看不出发生了什么。
  state.note = `已把 ${itemId} 填进「${GRID_LABEL[key] ?? key}」`;
  render();
}

/** 读一页物品。打字快的时候只认最后一次请求的结果。 */
async function loadGrid() {
  if (!state.dir) return;
  const seq = (state.grid.seq += 1);
  state.grid.loading = true;
  state.grid.error = '';
  render();
  try {
    const r = await api('/item-grid', {
      dir: state.dir,
      id: state.instanceId,
      q: state.grid.q,
      page: state.grid.page,
      // 空串会被 api() 跳过，不带这个参数时请求逐字等同于改造前
      showAll: state.grid.showAll ? '1' : '',
    });
    if (seq !== state.grid.seq) return; // 有更新的请求在路上了，这份丢掉
    state.grid.data = r;
    state.grid.page = r.page ?? 1;
    await ensureIcons((r.items ?? []).map((it) => it.id));
  } catch (error) {
    if (seq !== state.grid.seq) return;
    state.grid.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (seq === state.grid.seq) {
      state.grid.loading = false;
      render();
    }
  }
}

/** 翻页（会夹在合法范围里）。 */
function gridGo(page) {
  const data = state.grid.data;
  const pages = Math.max(1, data?.pages ?? 1);
  const next = Math.min(Math.max(1, page), pages);
  if (next === state.grid.page && data) return;
  state.grid.page = next;
  void loadGrid();
}

/** 搜一个词（重置到第一页）。 */
function gridSearch() {
  state.grid.page = 1;
  void loadGrid();
}

/** 切换「显示全部」：改完口径页码归 1、立刻重取一页（后端会把越界页码夹回来）。 */
function setGridShowAll(value) {
  state.grid.showAll = !!value;
  state.grid.page = 1;
  void loadGrid();
}

/**
 * 问后端「这个包导过游戏清单没」。只读、不联网。
 * connect() 里连上包后调一次，界面才知道该说「还没导入」还是「100% 精确」。
 */
async function ensureTruthStatus() {
  try {
    const r = await api('/item-truth/status', { dir: state.dir, id: state.instanceId });
    state.grid.truth = { has: !!r.has, source: String(r.source ?? '') };
  } catch {
    state.grid.truth = { has: false, source: '' }; // 拿不到就当没导过，网格照旧全显示
  }
  render();
}

/**
 * 导入游戏导出的 jeidump.json：用现成的「选文件夹」对话框让用户选游戏目录
 * （里面得有 jeidump.json），后端把清单存进软件自己的数据目录，绝不写用户包。
 */
async function importTruth() {
  await run('truth', async () => {
    await api('/pick-folder');
    const s = await waitPickFolder();
    if (s.error) throw new Error(s.hint ? `${s.error}（${s.hint}）` : s.error);
    if (!s.path) return; // 用户点了取消
    await post('/item-truth/import', { dir: state.dir, id: state.instanceId, file: s.path });
    state.grid.truth = { has: true, source: s.path };
    state.grid.showAll = false; // 导完自动切回「照清单显示（100% 精确）」
    state.grid.page = 1;
    state.note = '游戏清单已导入，网格现在只显示游戏里真有的物品';
    await ensureTruthStatus(); // 以 status 接口回报的为准
    void loadGrid();
  });
}

/**
 * 读一下「中文名补全」的本地缓存状态（只读、绝不联网）。
 * 切到物品页时顺手问一次，界面才知道按钮该写「补全」还是「已补全 · 重新下载」。
 */
async function loadNameInfo() {
  const before = state.nameFill.info?.cached === true ? state.nameFill.info.count : 0;
  try {
    state.nameFill.info = await api('/name/preview', { dir: state.dir, id: state.instanceId });
  } catch {
    state.nameFill.info = null; // 拿不到就当没缓存，不弹错（离线是常态）
  }
  // 缓存状态变了才重画：按钮文案要从「补全中文名」变成「重新补全中文名」。
  // 这里只在切页签时触发，render 本身不会再调它，不会循环。
  const after = state.nameFill.info?.cached === true ? state.nameFill.info.count : 0;
  if (state.sideTab === 'items' && after !== before) render();
}

/**
 * 飘一条通知出来，过几秒自己没。
 *
 * 为什么不用 state.note：那是状态栏常驻的一句话，会一直挂到下一次操作覆盖它。
 * 用户要的是「告知一下，告知完信息就消失」—— 下载汉化包做完了这种事，
 * 不该在物品页留一串字，也该在别的页签看不见的地方打扰人。
 *
 * 通知本体只是一个固定定位的小块，点它可以立刻关掉（用户不想等那几秒时）。
 */

/** 通知停留多久（毫秒）。报错的留久一点，让用户来得及读完。 */
const TOAST_MS = 4500;

function showToast(text, kind = 'ok', ms = TOAST_MS) {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = 0;
  }
  // 编号用来认「是不是我这条」：期间又弹过新的，旧的那条定时器不该把它撤掉。
  state.toastSeq = (state.toastSeq ?? 0) + 1;
  const seq = state.toastSeq;
  state.toast = { text: String(text ?? ''), kind, until: Date.now() + ms, seq };
  render();
  // 到点自己消失。注意用 setTimeout 而不是 setInterval：通知只该等一次。
  state.toastTimer = setTimeout(() => {
    state.toastTimer = 0;
    if (state.toast && state.toast.seq === seq) {
      state.toast = null;
      render();
    }
  }, ms);
  // 定时器不该拖住进程（桌面版退出、测试收尾都要干净）
  if (typeof state.toastTimer?.unref === 'function') state.toastTimer.unref();
}

/** 手动关掉通知（点通知本身，或者有新通知顶掉旧的）。 */
function dismissToast() {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = 0;
  }
  if (!state.toast) return;
  state.toast = null;
  render();
}

/**
 * 通知浮层那一小块。没有通知时返回 null。
 *
 * 点它可以立刻关掉 —— 用户不一定想等那几秒。`data-focus="toast"` 是给
 * 测试和将来的键盘操作留的抓手。
 */
function toastEl() {
  const t = state.toast;
  if (!t || !t.text) return null;
  const kind = t.kind === 'error' ? 'error' : t.kind === 'info' ? 'info' : 'ok';
  return el('div', {
    class: `mcs-toast mcs-toast-${kind}`,
    'data-focus': 'toast',
    title: '点一下关掉',
    onclick: () => dismissToast(),
    text: t.text,
  });
}

/**
 * 用户点了「补全中文名」才会走到这里 —— 唯一会联网的入口。
 *
 * 下载完后端会把名字落进软件自己的数据目录，并让已缓存的索引立即重套
 * （不用等 10 分钟 TTL）。这里把网格数据清空重读一遍，用户马上能看到新名字。
 *
 * 下载期间盯一个 `name-fill` 进度槽（和装 mod、导出共用那套），
 * 界面上就能看到「已下 1.2 MB / 共 3.5 MB」。
 */
async function fillNames() {
  if (state.nameFill.busy) return;
  state.nameFill.busy = true;
  dismissToast(); // 上一次的通知先撤，别和新的一条摞在一起
  // 先盯上（按 kind 问后端「正在跑的那个」），再发请求 —— 否则头几百毫秒界面是空的。
  watchKind('name-fill');
  render();
  try {
    const r = await post('/name/apply', { dir: state.dir, id: state.instanceId });
    // 通知先弹：网格重读要几秒（第一次扫全包更久），不能让用户盯着空白等。
    showToast(
      `已补全 ${r.count ?? 0} 条中文名（${r.files ?? 0} 份语言文件），来源 ${r.license ?? 'CC BY-NC-SA 4.0'}`,
      'ok',
    );
    try {
      state.nameFill.info = await api('/name/preview', { dir: state.dir, id: state.instanceId });
      state.grid.data = null; // 让 loadGrid 重新读，名字会立刻变
      await loadGrid();
    } catch {
      /* 名字已经补上了，只是网格没重读出来 —— 别把成功的通知改成失败 */
    }
  } catch (error) {
    showToast(`补全失败：${error instanceof Error ? error.message : String(error)}`, 'error', TOAST_MS * 2);
  } finally {
    // 进度条随下载一起收掉：最后一帧抓一下（免得界面停在半路），然后停轮询。
    const jobId = state.progress.job?.id ?? '';
    if (jobId) {
      try {
        const body = await api('/progress', { jobId });
        state.progress.job = body.found === false ? null : body.job;
      } catch {
        /* 抓不到就算了，下面停轮询就行 */
      }
    }
    stopWatchProgress();
    state.progress.job = null;
    state.nameFill.busy = false;
    render();
  }
}

/**
 * 悬停气泡。
 *
 * 不走 render：鼠标划过一格就整页重画的话，那个格子当场被换掉，
 * 后面的 mouseleave 再也收不到，气泡会永远挂着（2026-11-03 的教训：
 * 「点外面就关浮层」不能靠整页重画）。
 */
let gridTipEl = null;

function showGridTip(anchor, item) {
  if (!gridTipEl) return;
  const lines = [item.name || item.id, item.id];
  // 优先显示 mod 的中文显示名（`来自：机械动力`），拿不到再退回 modId
  const mod = item.mod || (item.mods ?? []).join('、');
  if (mod) lines.push(`来自：${mod}`);
  if (item.desc) lines.push(String(item.desc).split('\n')[0].slice(0, 120));
  gridTipEl.replaceChildren(
    ...lines.map((text, i) => el('div', { class: i === 0 ? 'mcs-tip-name' : 'mcs-tip-line', text })),
  );
  // 气泡挂在网格容器里（position:relative），按格子的相对位置摆
  const box = gridTipEl.parentNode;
  const left = Number(anchor?.offsetLeft ?? 0);
  const top = Number(anchor?.offsetTop ?? 0);
  const width = Number(anchor?.offsetWidth ?? 0);
  gridTipEl.style = `left:${Math.max(0, left - 120)}px;top:${top + width + 4}px;display:block`;
}

function hideGridTip() {
  if (!gridTipEl) return;
  gridTipEl.style = 'display:none';
}

/** 右栏「物品」那一页的全部内容。 */
function itemGridSide() {
  const g = state.grid;
  const data = g.data;
  const out = [];

  // 搜索框：整套 JEI 语法（@模组 #标签 $简介 -排除 "整组" |或）
  out.push(
    el('div', { class: 'mcs-grid-search' },
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder: '搜物品：中文 / ID / 拼音；@模组 #标签 $简介 -排除 "整组" |或',
        value: g.q,
        'data-focus': 'gridq',
        oninput: (e) => { g.q = e.target.value; },
        onkeydown: (e) => {
          if (e.key === 'Enter') gridSearch();
          if (e.key === 'Escape') { g.q = ''; gridSearch(); }
        },
      }),
      btn(g.loading ? '…' : '搜', () => gridSearch(), { primary: true, disabled: g.loading }),
      g.q ? btn('清', () => { g.q = ''; gridSearch(); }, { title: '清空搜索（JEI 里是右键搜索框）' }) : null,
    ),
  );

  // 这一组（中文名补全 + 游戏清单口径）平时用不上，收进一条折叠横栏里，
  // 点一下才展开；默认不占地方，也不挤搜索框下面的网格（2026-11-08）。
  out.push(
    el('button', {
      class: 'mcs-grid-opts-bar',
      text: `${g.optsOpen ? '▾' : '▸'} 物品数据设置 · ${g.showAll ? '显示全部' : '照游戏清单显示'}`,
      title: '展开 / 收起：补全中文名、导入游戏清单、显示口径开关',
      onclick: () => { g.optsOpen = !g.optsOpen; render(); },
    }),
  );

  if (g.optsOpen) {
    // 中文名补全：默认完全离线，只有点这个按钮才联网（下载 CFPA 社区汉化包）。
    // 它是整包级的事，和「当前翻到第几页」无关，展开这一组时才出现。
    const nf = state.nameFill;
    const cached = nf.info?.cached === true;
    out.push(
      el('div', { class: 'mcs-name-fill' },
        btn(nf.busy ? '正在下载…' : (cached ? '重新补全中文名' : '补全中文名'), () => { void fillNames(); }, {
          disabled: nf.busy,
          title: '从 CFPA 社区汉化包下载中文名；只存到软件自己的数据目录，不碰整合包，下载一次之后断网也能用',
        }),
        el('span', { class: 'mcs-name-fill-src', text: `CFPA 汉化包 · ${nf.info?.license ?? 'CC BY-NC-SA 4.0'}` }),
      ),
    );
    if (cached) {
      out.push(el('div', { class: 'mcs-name-fill-note', text: `已缓存 ${nf.info.count ?? 0} 条中文名，离线可用` }));
    }
    // 下载中的进度条：贴在按钮下面，跟着后端那个 name-fill 槽走。
    // 槽里没有这一类进度时返回 null，说明现在没在下载 —— 不占地方。
    const nfSlot = progressSlot('name-fill');
    if (nfSlot) out.push(nfSlot);

    // 游戏真值清单：显示口径（2026-11-07 任务③）。
    // 没导过清单＝默认「显示全部」且明说，不假装精确；导过＝默认「照清单显示」。
    // 开关两态共用一个按钮，切换只改状态 + 重取一页（loadGrid 内部会 render）。
    const truthBar = el('div', { class: 'mcs-grid-truth' });
    truthBar.append(
      btn(
        state.grid.showAll ? '显示全部 ✓' : '只显示游戏里真有的',
        () => setGridShowAll(!state.grid.showAll),
        { title: '开＝全部索引里的都显示（幽灵仍剔除）；关＝只显示游戏真值清单里注册过的物品' },
      ),
    );
    if (!state.grid.truth.has) {
      truthBar.append(
        el('span', { class: 'mcs-muted', text: '还没导入游戏清单，当前显示全部（不保证和游戏里一模一样）' }),
        btn('导入游戏清单…', () => { void importTruth(); }, { title: '选一个游戏目录（里面有 jeidump.json）' }),
        btn('怎么导出？', () => gotoPanel('iconguide'), { title: '看「让游戏自己产出数据」那张教学卡' }),
      );
    } else if (data && data.filter === 'truth' && (data.hiddenCount ?? 0) > 0) {
      truthBar.append(
        el('span', { class: 'mcs-muted', text: `照游戏清单显示（100% 精确），已藏起 ${data.hiddenCount} 条游戏里没有的` }),
      );
    } else if (data && data.filter === 'truth') {
      truthBar.append(el('span', { class: 'mcs-muted', text: '照游戏清单显示（100% 精确）' }));
    } else {
      truthBar.append(el('span', { class: 'mcs-muted', text: '当前显示全部（游戏清单已导入，点开关切回精确）' }));
    }
    out.push(truthBar);
  }

  // 刚刚填过东西：给一条明确的反馈 + 回详情看一眼的入口。
  // 点格子只改状态的话，用户会觉得「点了没反应」（右栏还是网格，框在另一个页签里）。
  if (g.filled) {
    out.push(
      el('div', { class: 'mcs-grid-filled' },
        el('span', { text: `已填入「${GRID_LABEL[g.filled.field] ?? g.filled.field}」：${g.filled.id}` }),
        btn('回详情看', () => { state.sideTab = 'detail'; render(); }),
      ),
    );
  }

  if (g.error) out.push(el('div', { class: 'mcs-warn', text: g.error }));
  if (!data && g.loading) out.push(el('div', { class: 'mcs-empty', text: '正在读物品…（第一次要扫一遍整个包，几秒）' }));
  if (!data && !g.loading) out.push(el('div', { class: 'mcs-empty', text: '还没读到物品。点上面的「搜」或者清空搜索框再回车。' }));

  if (data) {
    // 一页 9×16 = 144 个，页码和总数照 JEI 的习惯放在上面
    out.push(
      el('div', { class: 'mcs-grid-meta' },
        el('span', { text: `${data.total ?? 0} 个` }),
        el('span', { class: 'mcs-muted', text: data.query ? `（全包 ${data.indexTotal ?? 0} 个里搜的）` : '按 mod 分组 · 原版在前' }),
        el('span', { class: 'mcs-spacer' }),
        el('span', { class: 'mcs-muted', text: `第 ${data.page}/${data.pages} 页` }),
      ),
    );
    if (data.queryHint) out.push(el('div', { class: 'mcs-grid-hint', text: data.queryHint }));

    const grid = el('div', { class: 'mcs-grid' });
    gridTipEl = el('div', { class: 'mcs-grid-tip', style: 'display:none' });
    const items = data.items ?? [];
    for (let i = 0; i < (data.cols ?? 9) * (data.rows ?? 16); i += 1) {
      const it = items[i];
      if (!it) {
        // 空格子：JEI 里也是留白，不是画个占位
        grid.append(el('div', { class: 'mcs-cell mcs-cell-empty' }));
        continue;
      }
      const cell = el('div', {
        class: `mcs-cell${g.pick === it.id ? ' mcs-cell-on' : ''}`,
        draggable: 'true',
        title: '', // 自己画气泡，不用原生 tooltip
        onclick: () => {
          // 有正在编辑的框就填进去，否则只是选中
          if (g.field && GRID_FILL[g.field]) fillItemInto(g.field, it.id);
          else { g.pick = it.id; render(); }
        },
        ondblclick: () => openItemFromGrid(it.id),
        onmouseenter: () => showGridTip(cell, it),
        onmouseleave: () => hideGridTip(),
        ondragstart: (e) => {
          // 拖到任务表单的物品框里
          if (e?.dataTransfer) {
            e.dataTransfer.setData('text/plain', it.id);
            if ('effectAllowed' in e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
          }
          g.pick = it.id;
        },
      }, iconImg(it.id, 22));
      grid.append(cell);
    }
    grid.append(gridTipEl);
    // 滚轮翻页（JEI 的默认操作），按住 Shift 不管 —— 留给右栏整体滚动
    grid.addEventListener('wheel', (e) => {
      if (!data.pages || data.pages < 2) return;
      if (e?.shiftKey) return;
      if (e?.preventDefault) e.preventDefault();
      gridGo(state.grid.page + ((e?.deltaY ?? 0) > 0 ? 1 : -1));
    });
    out.push(grid);

    out.push(
      el('div', { class: 'mcs-grid-nav' },
        btn('◀', () => gridGo(1), { disabled: (data.page ?? 1) <= 1, title: '第一页' }),
        btn('上一页', () => gridGo(state.grid.page - 1), { disabled: (data.page ?? 1) <= 1 }),
        el('span', { class: 'mcs-muted', text: `${data.page} / ${data.pages}` }),
        btn('下一页', () => gridGo(state.grid.page + 1), { disabled: (data.page ?? 1) >= (data.pages ?? 1) }),
        btn('▶', () => gridGo(data.pages ?? 1), { disabled: (data.page ?? 1) >= (data.pages ?? 1), title: '最后一页' }),
      ),
    );

    // 选中的物品：显示它是什么 + 三个动作（看配方 / 看用途 / 填进当前的框）
    const picked = (data.items ?? []).find((it) => it.id === g.pick) ?? null;
    if (picked) {
      out.push(
        el('div', { class: 'mcs-grid-pick' },
          iconImg(picked.id, 26),
          el('div', { class: 'mcs-grid-pick-t' },
            el('div', { text: picked.name || picked.id }),
            el('div', { class: 'mcs-muted', text: picked.id }),
          ),
        ),
        el('div', { class: 'mcs-grid-acts' },
          btn('看它的配方', () => openItemFromGrid(picked.id), { primary: true }),
          g.field && GRID_FILL[g.field]
            ? btn('填进当前的框', () => fillItemInto(g.field, picked.id))
            : null,
        ),
        el('div', { class: 'mcs-muted', text: g.field && GRID_FILL[g.field] ? `点格子会直接填进「${g.field}」那个框` : '先点一下要填的输入框，再点格子就能填进去' }),
      );
    }
  }

  return out;
}

/** 从网格跳去「物品与配方」页看这个物品的配方（JEI 的左键 R）。 */
function openItemFromGrid(itemId) {
  state.sideTab = 'detail';
  state.panel = 'content';
  state.draft = null;
  state.plan = null;
  state.done = null;
  state.menuOpen = '';
  render();
  void openItem(itemId);
}

/**
 * 右栏。两种内容互斥（2026-11-05 加）：
 *   「详情」= 原来那一套（任务详情 / 配方编辑 / 各工具页说明）
 *   「物品」= JEI 那种 9×16 的物品网格，点一下把 ID 填进正在编辑的框
 *
 * 为什么做成页签而不是并排：右栏只有 340px，网格一页 144 格已经占满，
 * 和详情并排会两边都看不清。页签切换能保住原来那一套的排版，一行没改。
 */
function inspector() {
  if (state.sideTab === 'items') {
    const right = el('div', { class: 'mcs-right' });
    right.append(sideTabs());
    for (const kid of itemGridSide()) right.append(kid);
    return right;
  }
  const side = state.panel !== 'quests' ? contextSide() : questSide();
  // 页签条插到最前面。各分支原本的第一行就是标题，保持原样不动。
  const kids = [...side.children];
  side.replaceChildren(sideTabs(), ...kids);
  return side;
}

/** 右栏顶部那两个页签。 */
function sideTabs() {
  const make = (key, label) =>
    el('button', {
      class: `mcs-side-tab${state.sideTab === key ? ' mcs-side-tab-on' : ''}`,
      text: label,
      'data-focus': `sidetab-${key}`,
      onclick: () => {
        if (state.sideTab === key) return;
        state.sideTab = key;
        // 第一次切到物品页要先把网格读出来，否则是一片空白
        if (key === 'items') {
          if (!state.grid.data) void loadGrid();
          void loadNameInfo(); // 只读，不联网：看看本地中文名缓存有没有
        }
        render();
      },
    });
  return el('div', { class: 'mcs-side-tabs' }, make('detail', '详情'), make('items', '物品'));
}

/** 右栏「任务详情」那一整页（原来的 inspector 主体，一行没改）。 */
function questSide() {
  const right = el('div', { class: 'mcs-right' });
  right.append(el('div', { class: 'mcs-right-t' }, el('span', { text: '任务详情' })));

  if (state.flash || state.undo.length) right.append(undoBar());
  if (state.draft) right.append(draftCard());
  if (state.plan) right.append(planCard());
  if (state.done) right.append(doneCard());
  // ★ 右栏**不再显示**任务书体检卡（2026-11-12 用户：「右侧栏的任务书诊断不要再显示了，
  //   太影响阅读了」）。诊断全部挪到「分析 → 任务书诊断」那条底部面板里。
  //   这里留注释而不是悄悄删掉，是为了下次有人想加回来时先看到这条理由。

  const detail = state.questDetail;
  if (state.sel && detail) {
    // 图标行：ID 照显；但本地六轮解析都没拿到贴图时（灰块），给一个「补图」按钮
    // 去 MC百科 现查一张 —— 这是 2026-11-02「为什么有些任务没图标」的人工兜底。
    const iconValue = detail.icon
      ? el('span', { class: 'mcs-v' },
          el('span', { text: detail.icon }),
          !state.icons[detail.icon]
            ? el('button', {
                class: 'mcs-btn',
                text: '补图',
                title: '本地找不到这张贴图，去 MC百科 搜一张（用中文名搜，一次查一张）',
                onclick: () => fetchWebIcon(detail.icon),
              })
            : null,
        )
      : '—';
    right.append(
      card(
        // 标题按 MC 格式码上色（2026-11-11 用户要的「和游戏里效果一样」）
        mcText(detail.titleSpans, detail.title || detail.id),
        kv([
          ['ID', detail.id],
          ['章节', detail.chapterTitle],
          ['坐标', `(${detail.x}, ${detail.y})`],
          ['图标', iconValue],
          ['副标题', detail.subtitle ? mcText(detail.subtitleSpans, detail.subtitle) : '—'],
          // 前置 / 后续**不在这张表里**了（2026-11-12）：改成 questDetailBody() 末尾
          // 那两个分节 —— 这里只能显示成一串用「、」连起来的字，既数不清个数、
          // 也不能点。挪过去以后能看数量、能点击跳到那个任务。
        ]),
        ...questDetailBody(detail),
        row(
          btn('改名', () => startDraft('rename', detail.id)),
          btn('换图标', () => startDraft('icon', detail.id)),
        ),
        row(
          btn('改前置', () => startDraft('deps', detail.id)),
          // 2026-11-13 用户拍板方案甲：不再算写死的偏移（会盖住右边节点），
          // 改成「进放置模式 → 在画布上点一下定位置」，和 UE / FTB 本体一致。
          btn('加后续', () => beginPlaceNew(detail.id)),
        ),
        row(btn('删掉这个任务', () => startDraft('delete', detail.id), { danger: true })),
      ),
    );
  } else if (state.sel) {
    right.append(card('正在读任务…', el('div', { class: 'mcs-muted', text: state.sel })));
  } else if (state.selSet.length > 1) {
    right.append(
      card(
        `选中了 ${state.selSet.length} 个任务`,
        el('div', { class: 'mcs-muted', text: '拖其中任意一个，这些会一起挪。右键单个任务还能改它自己的东西。' }),
        row(btn('取消选择', () => { state.selSet = []; state.sel = ''; render(); })),
      ),
    );
  } else {
    right.append(
      card(
        '还没有选中任务',
        el('div', { class: 'mcs-muted', text: '点中间的一个方块看它是什么；右键可以改图标、改前置依赖、删掉它；拖动直接挪位置；空白处双击新建。' }),
      ),
    );
  }
  return right;
}

/**
 * 「刚挪完」那一条：说清挪了什么，给一个撤销按钮。
 * 学 UE 的 undo 提示，但不弹窗、不挡手。
 */
function undoBar() {
  const last = state.undo[state.undo.length - 1];
  const box = el('div', { class: 'mcs-undo' });
  box.append(el('span', { class: 'mcs-undo-t', text: state.flash || `上次挪动：${last?.label ?? ''}` }));
  box.append(
    row(
      btn(state.busy === 'undo' ? '撤销中…' : '撤销', () => undoMove(), { disabled: !last || Boolean(state.busy) }),
      state.redo.length ? btn('重做', () => redoMove(), { disabled: Boolean(state.busy) }) : null,
    ),
  );
  return box;
}

/**
 * 现算一次任务书体检（「检查一次」按钮 / 展开诊断面板时触发）。
 *
 * 为什么要重发 `/questbook` 而不是本地重算：体检规则在 `packages/core` 里，
 * 界面没有那套规则，也不该有第二份（AGENTS.md 硬约束第 7 条）。重发一次
 * 顺便还能把磁盘上刚改的内容读进来 —— 用户改完文件再点检查，看到的就是最新的。
 *
 * 注：原来的 `lintCard()`（右栏那张体检卡）已于 2026-11-12 删除 ——
 * 用户说「右侧栏的任务书诊断不要再显示了，太影响阅读了」，诊断统一走
 * `diagnosticsPanel()`（分析 → 任务书诊断，从底部展开）。
 */
async function runQuestLint() {
  await run('lint', async () => {
    state.questBook = await api('/questbook', { dir: state.dir, id: state.instanceId });
    state.facts.questBook = state.questBook;
  });
}

function draftCard() {
  const d = state.draft;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: draftTitle(d) }));

  if (d.kind === 'icon') {
    wrap.append(
      el('input', {
        class: 'mcs-input',
        placeholder: 'mod:item，如 minecraft:diamond_sword；也可打中文搜',
        value: d.value,
        'data-focus': 'iconvalue',
        onfocus: () => { state.grid.field = 'iconvalue'; },
        oninput: (e) => { d.value = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') void searchIconItems(); },
        ondragover: (e) => { if (e?.preventDefault) e.preventDefault(); },
        ondrop: (e) => {
          if (e?.preventDefault) e.preventDefault();
          const id = String(e?.dataTransfer?.getData?.('text/plain') ?? '').trim();
          if (id) fillItemInto('iconvalue', id);
        },
      }),
    );
    wrap.append(row(
      btn(d.busy ? '搜索中…' : '搜物品', () => searchIconItems(), { primary: true, disabled: d.busy }),
      d.value ? iconImg(d.value, 32) : null,
    ));
    if (d.items) {
      const pick = el('div', { class: 'mcs-pick-list-sm' });
      for (const it of d.items.slice(0, 30)) {
        pick.append(
          el('div', {
            class: 'mcs-pick-row',
            onclick: () => { d.value = it.id; render(); },
          }, iconImg(it.id, 22), el('span', { text: `${it.name || it.id}` }), el('span', { class: 'mcs-muted', text: it.id })),
        );
      }
      if (d.items.length === 0) pick.append(el('div', { class: 'mcs-muted', text: '没搜到' }));
      wrap.append(pick);
    }
  }

  if (d.kind === 'deps') {
    wrap.append(el('div', { class: 'mcs-muted', text: '勾上的任务必须先做完；一个都不勾 = 一开始就能做。' }));
    wrap.append(
      el('input', {
        class: 'mcs-input mcs-input-sm',
        placeholder: '过滤（任务名 / ID）',
        value: d.filter,
        'data-focus': 'depfilter',
        oninput: (e) => { d.filter = e.target.value; render(); },
      }),
    );
    const all = [];
    for (const chapter of state.canvas?.chapters ?? []) {
      for (const node of chapter.nodes ?? []) if (node.id !== d.questId) all.push({ node, chapter });
    }
    const q = d.filter.trim().toLowerCase();
    const shown = q ? all.filter((x) => `${x.node.title ?? ''} ${x.node.id}`.toLowerCase().includes(q)) : all;
    wrap.append(el('div', { class: 'mcs-muted', text: `${shown.length} 个可选` }));
    const pick = el('div', { class: 'mcs-pick-list-sm' });
    for (const x of shown.slice(0, 60)) {
      pick.append(
        el('label', { class: 'mcs-pick-row' },
          el('input', {
            type: 'checkbox',
            checked: d.picked.has(x.node.id),
            onchange: (e) => { if (e.target.checked) d.picked.add(x.node.id); else d.picked.delete(x.node.id); },
          }),
          iconImg(x.node.icon, 20),
          el('span', { text: truncate(x.node.title || x.node.id, 18) }),
          el('span', { class: 'mcs-muted', text: truncate(x.chapter.title ?? '', 8) }),
        ),
      );
    }
    wrap.append(pick);
  }

  if (d.kind === 'delete') {
    wrap.append(el('div', { class: 'mcs-muted', text: '会把这个任务整个从任务书里拿掉，原文件会留备份。' }));
    if ((d.dependents ?? []).length) {
      wrap.append(el('div', { class: 'mcs-warn', text: `注意：有 ${d.dependents.length} 个任务本来要先做它，删掉后它们的前置会一起断开。` }));
    } else {
      wrap.append(el('div', { class: 'mcs-muted', text: '没有别的任务依赖它。' }));
    }
    wrap.append(row(
      btn('预览会改什么', () => previewDelete(), { primary: true, disabled: state.busy === 'delplan' }),
      btn('算了，不删', () => { state.draft = null; render(); }),
    ));
    return wrap;
  }

  if (d.kind === 'new') {
    // 名字 / 副标题 / 简介（文字进语言文件）
    wrap.append(el('input', {
      class: 'mcs-input', placeholder: '新任务的名字', value: d.title, 'data-focus': 'newtitle',
      oninput: (e) => { d.title = e.target.value; },
    }));
    wrap.append(el('input', {
      class: 'mcs-input', placeholder: '副标题（可留空）', value: d.subtitle, 'data-focus': 'newsub',
      oninput: (e) => { d.subtitle = e.target.value; },
    }));
    wrap.append(el('textarea', {
      class: 'mcs-input', placeholder: '简介（可留空，一行一段）', value: d.description,
      'data-focus': 'newdesc', rows: 3,
      oninput: (e) => { d.description = e.target.value; },
    }));

    // 完成条件 / 奖励：类型可换、字段跟着变（packages/core/quest-conditions.js 是唯一目录）
    wrap.append(...conditionEditor(d, 'task'));
    wrap.append(...conditionEditor(d, 'reward'));

    wrap.append(row(
      btn('预览要加什么', () => previewNew(), { primary: true, disabled: state.busy === 'newplan' }),
      btn('取消', () => { state.draft = null; render(); }),
    ));
    return wrap;
  }

  if (d.kind === 'rename') {
    // 名字 / 副标题（文字进语言文件）
    wrap.append(el('input', {
      class: 'mcs-input', placeholder: '标题', value: d.title, 'data-focus': 'rtitle',
      oninput: (e) => { d.title = e.target.value; },
    }));
    wrap.append(el('input', {
      class: 'mcs-input', placeholder: '副标题（可留空）', value: d.subtitle, 'data-focus': 'rsub',
      oninput: (e) => { d.subtitle = e.target.value; },
    }));
    // 简介：一行一段。预填来自详情现状（startDraft 已把数组拼成换行文本），
    // 用户不动的话预览算「没改动」，后端就不会去碰语言文件。
    wrap.append(el('textarea', {
      class: 'mcs-input', placeholder: '简介（可留空，一行一段）', value: d.desc ?? '',
      'data-focus': 'rdesc', rows: 3,
      oninput: (e) => { d.desc = e.target.value; },
    }));

    // 完成条件 / 奖励：类型可换、字段跟着变（packages/core/quest-conditions.js 是唯一目录）
    wrap.append(...conditionEditor(d, 'task'));
    wrap.append(...conditionEditor(d, 'reward'));

    // 任务高级设置（2026-11-13）：形状 / 大小 / 可选 / 不可见 / 可重复。
    // 只改了动过的那几个才发，没动的一个字节都不碰。
    if (d.fields) wrap.append(...questFieldCards(d));

    // 「全部恢复默认」（VS 原则 3 的第二半）：条件/奖励两组 + 任务级字段一起清零。
    // 只在**真的动过东西**时出现 —— 什么都没改的时候这个按钮没有意义。
    const anyDirty = conditionDirty(d) || questFieldsDirty(d);
    if (anyDirty) {
      wrap.append(row(
        btn('全部恢复默认', () => resetDraftToDefaults(d), {
          title: '完成条件、奖励、高级设置全部回到默认（保存后这些键会从文件里消失）',
        }),
      ));
    }

    wrap.append(row(
      btn('预览会改什么', () => previewRename(), { primary: true, disabled: state.busy === 'renameplan' }),
      btn('取消', () => { state.draft = null; render(); }),
    ));
    return wrap;
  }

  if (d.kind === 'chapter') {
    wrap.append(el('div', { class: 'mcs-muted', text: '新建一章任务。除了名字都能留空——图标填物品 ID（如 minecraft:diamond_sword），排序留空就排在最后。' }));
    wrap.append(el('input', {
      class: 'mcs-input', placeholder: '章节名（必填），如「第二章：进阶机械」', value: d.title, 'data-focus': 'chtitle',
      // 要实时控制「预览会加什么」按钮的可用性，必须重画（data-focus 会自动把焦点还回来）
      oninput: (e) => { d.title = e.target.value; render(); },
    }));
    wrap.append(el('input', {
      class: 'mcs-input', placeholder: '分组（可留空，用来把几章归成一摞）', value: d.group, 'data-focus': 'chgroup',
      oninput: (e) => { d.group = e.target.value; },
    }));
    wrap.append(el('input', {
      class: 'mcs-input', placeholder: '章节图标物品 ID（可留空）', value: d.icon, 'data-focus': 'chicon',
      onfocus: () => { state.grid.field = 'chicon'; },
      oninput: (e) => { d.icon = e.target.value; },
      ondragover: (e) => { if (e?.preventDefault) e.preventDefault(); },
      ondrop: (e) => {
        if (e?.preventDefault) e.preventDefault();
        const id = String(e?.dataTransfer?.getData?.('text/plain') ?? '').trim();
        if (id) fillItemInto('chicon', id);
      },
    }));
    wrap.append(el('input', {
      class: 'mcs-input', placeholder: '排序号（可留空，留空 = 排在最后）', value: d.orderIndex, 'data-focus': 'chorder',
      oninput: (e) => { d.orderIndex = e.target.value; },
    }));
    wrap.append(row(
      btn('预览会加什么', () => previewChapter(), { primary: true, disabled: state.busy === 'chapterplan' || !d.title.trim() }),
      btn('取消', () => { state.draft = null; render(); }),
    ));
    return wrap;
  }

  if (d.kind === 'image') {
    wrap.append(el('div', {
      class: 'mcs-muted',
      text: '贴一张图到这一章。路径是「资源 ID」，形如 ftbquests:textures/end_flower_forest.png —— 就是 mod jar / 资源包里那张图的位置。',
    }));
    wrap.append(imageInput(d, 'image', '贴图资源 ID，如 ftbquests:textures/end_flower_forest.png'));
    // 宽高从「格子」而不是像素：1 格 = 画布上一个任务方块那么大，跟游戏里看的一致
    wrap.append(el('div', { class: 'mcs-muted', text: '坐标和大小都用「格子」算：1 格 = 一个任务方块。' }));
    wrap.append(row(
      imageNumberInput(d, 'x', 'X'),
      imageNumberInput(d, 'y', 'Y'),
    ));
    wrap.append(row(
      imageNumberInput(d, 'width', '宽'),
      imageNumberInput(d, 'height', '高'),
    ));
    wrap.append(row(imageNumberInput(d, 'rotation', '旋转角度（度）')));
    wrap.append(el('div', {
      class: 'mcs-warn',
      text: '注意：贴图 ID 这里只做「像不像资源 ID」的检查，不确认图真的存在 —— 写错了游戏里就是一块空白。',
    }));
    wrap.append(row(
      btn('预览会加什么', () => previewImage(), {
        primary: true,
        disabled: state.busy === 'imageplan' || !String(d.image ?? '').trim() || !Number(d.width) || !Number(d.height),
      }),
      btn('取消', () => { state.draft = null; render(); }),
    ));
    return wrap;
  }

  if (d.kind === 'imagemove') {
    wrap.append(el('div', { class: 'mcs-muted', text: `改第 ${d.index + 1} 张装饰图：${d.image ?? ''}` }));
    wrap.append(el('div', { class: 'mcs-muted', text: '画布上直接拖它更快；这里适合精确对齐，或者改大小。留空 = 这一项不动。' }));
    wrap.append(row(
      imageNumberInput(d, 'x', 'X'),
      imageNumberInput(d, 'y', 'Y'),
    ));
    wrap.append(row(
      imageNumberInput(d, 'width', '宽'),
      imageNumberInput(d, 'height', '高'),
    ));
    wrap.append(row(imageNumberInput(d, 'rotation', '旋转角度（度）')));
    wrap.append(row(
      btn('预览会改什么', () => previewImage(), { primary: true, disabled: state.busy === 'imageplan' }),
      btn('取消', () => { state.draft = null; render(); }),
    ));
    return wrap;
  }

  if (d.kind === 'imagedelete') {
    wrap.append(el('div', { class: 'mcs-muted', text: `会从这一章里删掉第 ${d.index + 1} 张装饰图：${d.image ?? ''}` }));
    wrap.append(el('div', { class: 'mcs-muted', text: '只删这一条记录，图文件本身不动（它属于某个 mod，删不掉也不该删）。原文件会留备份。' }));
    wrap.append(row(
      btn('预览会删什么', () => previewImage(), { primary: true, disabled: state.busy === 'imageplan' }),
      btn('算了，不删', () => { state.draft = null; render(); }),
    ));
    return wrap;
  }

  if (d.kind === 'icon' || d.kind === 'deps') {
    wrap.append(row(
      btn('预览会改什么', () => previewNode(), { primary: true, disabled: state.busy === 'nodeplan' }),
      btn('取消', () => { state.draft = null; render(); }),
    ));
  }
  return wrap;
}

/**
 * 装饰图表单里的大输入框。填的是资源 ID，所以给一个宽一点的框 + 等宽字体，
 * 长的 `ns:textures/xxx/yyy.png` 才看得清。
 */
function imageInput(draft, key, placeholder) {
  return el('input', {
    class: 'mcs-input',
    placeholder,
    value: draft[key] ?? '',
    'data-focus': `img${key}`,
    oninput: (e) => {
      draft[key] = e.target.value;
      // 只对「按钮能不能点」有影响的那几项重画，否则每敲一个字光标都要跳
      if (key === 'image') render();
    },
  });
}

/** 装饰图表单里的数字框。空串 = 不改（和后端「空串当没给」对齐）。 */
function imageNumberInput(draft, key, placeholder) {
  return el('input', {
    class: 'mcs-input mcs-input-sm',
    placeholder,
    value: draft[key] ?? '',
    'data-focus': `img${key}`,
    oninput: (e) => { draft[key] = e.target.value; },
  });
}

function draftTitle(d) {
  if (d.kind === 'icon') return '换图标物品';
  if (d.kind === 'deps') return '改前置依赖';
  if (d.kind === 'delete') return '删掉任务';
  if (d.kind === 'new') return d.at ? `在这里新建任务（${d.at.x}, ${d.at.y}）` : '在它后面加一个任务';
  if (d.kind === 'rename') return '改名字 / 副标题 / 简介';
  if (d.kind === 'chapter') return '新建章节';
  if (d.kind === 'image') return '加一张装饰图';
  if (d.kind === 'imagemove') return `改第 ${(d.index ?? 0) + 1} 张装饰图`;
  if (d.kind === 'imagedelete') return `删掉第 ${(d.index ?? 0) + 1} 张装饰图`;
  return '编辑';
}

function planCard() {
  const p = state.plan;
  const changes = p.changes ?? [];
  const diff = p.diff ?? [];
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: '这次会改什么（还没写盘）' }));
  for (const c of changes) {
    wrap.append(el('div', { class: 'mcs-muted', text: `${c.label ?? c.field}：${c.before || '（空）'} → ${c.after || '（空）'}` }));
  }
  for (const d of diff) wrap.append(el('div', { class: 'mcs-muted', text: String(d) }));
  for (const w of p.warnings ?? []) wrap.append(el('div', { class: 'mcs-warn', text: `注意：${w}` }));
  for (const f of p.files ?? []) wrap.append(el('div', { class: 'mcs-muted', text: `会写：${f.path ?? f.name}（${f.bytes ?? 0} 字节）` }));

  const apply = applyForDraft();
  wrap.append(row(
    btn('确认写入', apply, { primary: true, disabled: !(p.files ?? []).length || Boolean(state.busy) }),
    btn('不写，收起', () => { state.plan = null; render(); }),
  ));
  return wrap;
}

function applyForDraft() {
  const kind = state.draft?.kind;
  if (kind === 'delete') return () => applyDelete();
  if (kind === 'new') return () => applyNew();
  if (kind === 'rename') return () => applyRename();
  if (kind === 'chapter') return () => applyChapter();
  if (kind === 'image' || kind === 'imagemove' || kind === 'imagedelete') return () => applyImage();
  return () => applyNode();
}

/** 「先算」那一半，和上面的 applyForDraft 配对。Ctrl+S 要用它。 */
function previewForDraft() {
  const kind = state.draft?.kind;
  if (kind === 'delete') return () => previewDelete();
  if (kind === 'new') return () => previewNew();
  if (kind === 'rename') return () => previewRename();
  if (kind === 'chapter') return () => previewChapter();
  if (kind === 'image' || kind === 'imagemove' || kind === 'imagedelete') return () => previewImage();
  return () => previewNode();
}

/**
 * Ctrl+S：把手上的草稿提交掉（2026-11-11 用户问「ctrl+s 的快速保存做了吗」）。
 *
 * 这个软件本身没有「保存」这个概念 —— 拖节点松手就写盘、改任务走「预览 → 确认写入」。
 * 所以 Ctrl+S 要照着既有规矩来：**仍然守 plan→apply 两态**，不能绕过预览直接写。
 *   - 还没预览过 → 先算一遍（planCard 出来，用户看得见要改什么）
 *   - 已经预览过 → 直接写（等于替用户点了「确认写入」）
 *
 * 没草稿时**什么都不做、也不弹提示**：这个键在没东西可存时按下去本来就该是静的，
 * 弹「已自动保存」反而会让用户以为刚做了什么。
 */
async function saveDraftByShortcut() {
  const draft = state.draft;
  if (!draft || state.busy) return;
  // 正在写别重入：连按两下 Ctrl+S 会发两次写请求
  if (state.plan && (state.plan.files ?? []).length) {
    await applyForDraft()();
    return;
  }
  await previewForDraft()();
}

function doneCard() {
  const d = state.done;
  const wrap = el('div', { class: 'mcs-card' });
  wrap.append(el('div', { class: 'mcs-card-t', text: '写好了' }));
  for (const line of d.lines ?? []) wrap.append(el('div', { class: 'mcs-muted', text: String(line) }));
  if ((d.backups ?? []).length) wrap.append(el('div', { class: 'mcs-muted', text: `备份：${d.backups.join('、')}` }));
  wrap.append(row(btn('知道了', () => { state.done = null; render(); })));
  return wrap;
}

// --------------------------------------------------------------- 长任务进度条
// 照着 PCL 的下载页做：一条总进度条 + 「已下 / 总量」+ 实时速度 + 还剩多久 + 当前文件。
// 为什么要有它：装 mod、从零装底座、打包都是几分钟起步的事，以前点完按钮页面就一直
// 挂着不动，用户不知道是在下还是卡死了。

/** 轮询间隔：PCL 自己也是这个量级，太快没意义，太慢进度条会一顿一顿。 */
const PROGRESS_INTERVAL_MS = 300;

/** 进度条那一小块。job 是 /progress 返回的形状。 */
function progressBar(job) {
  const percent = typeof job.percent === 'number' ? job.percent : null;
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const indeterminate = job.indeterminate === true || percent === null;

  const bar = el('div', { class: 'mcs-pbar' }, el('div', {
    class: indeterminate ? 'mcs-pbar-fill mcs-pbar-fill-unknown' : 'mcs-pbar-fill',
    // 宽度只能走 style —— 没有别的办法表达百分比
    style: indeterminate ? '' : `width:${width}%`,
  }));

  // 右边那串数字：字节任务看「已下 / 总量」，文件任务看「第几个 / 共几个」
  const amount = job.unit === 'bytes'
    ? `${job.doneText || '0 B'} / ${job.totalText || '未知'}`
    : `${job.finished ?? 0} / ${job.count || job.totalText || '?'} 个文件`;

  const facts = [amount];
  if (job.speedText) facts.push(job.speedText);
  if (job.etaText) facts.push(job.etaText);
  else if (job.elapsedText) facts.push(job.elapsedText);

  const rows = [
    el('div', { class: 'mcs-pbar-head' },
      el('div', { class: 'mcs-pbar-title', text: job.name || job.note || '正在处理' }),
      el('div', { class: 'mcs-pbar-pct', text: indeterminate ? '…' : `${percent.toFixed(0)}%` })),
    bar,
    el('div', { class: 'mcs-pbar-foot', text: facts.join(' · ') }),
  ];
  // 当前文件单独一行 —— 长文件名要能看全，不能挤在 foot 里被截断
  const current = job.current && job.current !== job.name ? job.current : '';
  if (current) rows.push(el('div', { class: 'mcs-pbar-file', text: current }));
  if (job.note && current) rows.push(el('div', { class: 'mcs-pbar-note', text: job.note }));
  if (job.error) rows.push(el('div', { class: 'mcs-warn', text: `出错了：${job.error}` }));
  return el('div', { class: 'mcs-pbar-box' }, ...rows);
}

/** 停止轮询，但把最后那一帧留在界面上（用户还要看「下完了 / 没下成」）。 */
function stopWatchProgress() {
  if (state.progress.timer) {
    clearInterval(state.progress.timer);
    state.progress.timer = 0;
  }
}

/**
 * 跑一个长任务并盯着它。
 *
 * task 返回 Promise，且应当在返回体里带 `job: {id}`（三条 apply 接口都会带）。
 * 这里不等进度问完就结束 —— 任务一结束就停轮询，把最后一次结果留在界面上。
 */
async function runWithProgress(key, task) {
  state.busy = key;
  state.error = '';
  state.progress.error = '';
  render();
  let result = null;
  try {
    result = await task();
    return result;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    // 后端在任务开始时就建好槽了，所以这里能拿到 job.id。
    // 拿不到（比如请求在算计划那一步就抛了）就把最后一帧留着 —— 那一帧上通常
    // 已经写着「出错了：…」，比直接清空更有用。下一次动作开始时会自己重置。
    const jobId = result?.job?.id ?? '';
    if (jobId) {
      // 先把最后的状态抓一次，再停 —— 否则进度条会定格在中途
      try {
        const body = await api('/progress', { jobId });
        state.progress.job = body.found === false ? null : body.job;
      } catch {
        /* 抓不到就算了，下面停轮询就行 */
      }
    }
    stopWatchProgress();
    state.busy = '';
    render();
  }
}

/**
 * 长任务开始前先用同一个 jobId 盯上。
 *
 * 麻烦的地方：jobId 只有等 apply 请求「返回」才知道，可是我们想在它「还在跑」
 * 的时候就盯 —— 所以改成按 kind 问最近一个正在跑的。后端 activeJob(kind)
 * 就是为这个准备的：请求一进来槽就建好了，即使响应还没回来也能问到。
 */
function watchKind(kind) {
  stopWatchProgress();
  state.progress.jobId = '';
  state.progress.job = null;
  state.progress.error = '';
  state.progress.kind = kind;
  const tick = async () => {
    if (!state.progress.timer) return;
    try {
      const body = await api('/progress', { kind });
      state.progress.job = body.found === false ? null : body.job;
      state.progress.error = '';
    } catch (error) {
      state.progress.error = error instanceof Error ? error.message : String(error);
    }
    render();
  };
  state.progress.timer = setInterval(tick, PROGRESS_INTERVAL_MS);
  // 别等 300 毫秒才出第一帧：点下按钮就该看到「准备开始」
  tick();
}

/**
 * 「给我这个 kind 的进度条」。
 *
 * kind 用来判断这块该不该出现在这一页：装 mod 的进度条不该出现在打包页里。
 * state.progress.job 是后端的快照，job.kind 就是当初建槽时写的那个。
 * 没有进度、或者进度属于别的任务时，返回 null（调用处直接 append 也不会出错，
 * 但为了 append(...) 不塞 undefined，统一返回 null 并让调用方 if 一下）。
 */
function progressSlot(kind) {
  const job = state.progress.job;
  if (!job) return null;
  if (kind && job.kind !== kind) return null;
  return progressBar(job);
}

function statusBar() {
  const parts = [el('span', { text: `服务：${location.origin}` }), el('span', { text: state.busy ? `正在处理：${state.busy}…` : '空闲' })];
  // 一次性提示（补图结果、重扫结果这类成功/说明性消息；报错走 state.error 红字）
  if (state.note) parts.push(el('span', { class: 'mcs-muted', text: state.note }));
  if (state.error) parts.push(el('span', { class: 'mcs-status-bad', text: state.error }));
  return el('div', { class: 'mcs-status' }, ...parts);
}

// --------------------------------------------------------------- 渲染

function render() {
  const activeEl = document.activeElement;
  const focusKey = activeEl instanceof HTMLElement ? activeEl.dataset?.focus : null;
  const caret = activeEl instanceof HTMLInputElement ? activeEl.selectionStart : null;

  const app = document.getElementById('app');
  if (!app) return;

  if (state.screen === 'pick') {
    app.replaceChildren(pickScreen(), statusBar());
  } else {
    // 外壳照 VSCode 排（2026-11-12 调成和 VSCode 一样的位置关系）：
    //   菜单栏
    //   ├─ 左栏（章节列表，竖着贯到顶）   ┊ 右区 ┬ 章节页签栏
    //   │                                  ┊      ├ 中栏（画布）+ 右栏（详情）
    //   状态栏
    //
    // ★ 为什么页签栏要在左栏**右边**、而不是像以前那样横跨整个宽度：
    //   用户 2026-11-12 原话「vscode 里是资源管理器和右侧标签页的位置并列，
    //   我这边也想做成一样的效果」。VSCode 的左侧资源管理器是整条竖的，
    //   编辑器页签从它的右边缘开始 —— 所以页签栏必须包进右区里。
    const right = el('div', { class: 'mcs-main' });
    right.append(tabBar());
    // ★ 诊断面板现在挂在**中栏那一列的下面**，不再横跨整个右区（2026-11-12 用户：
    //   「任务书诊断不要挡住右侧栏，任务书诊断结果的位置在标签页的底部，
    //    不要挡住左侧栏和右侧栏」）。
    //
    //   以前是 `right.append(diag)`，而 right 里装着「中栏 + 右栏」两列 ——
    //   面板一展开就把右栏的任务详情挤下去，看着像把详情挡没了。
    //   现在把中栏和诊断装进同一个竖向列（`.mcs-editor-col`），诊断只在
    //   **画布正下方**占位：左栏（章节列表）在它左边、右栏（详情）在它右边，
    //   两者都不受影响。位置上仍然在页签栏下面那一块的最底部。
    const editorCol = el('div', { class: 'mcs-editor-col' });
    editorCol.append(centerPane());
    const diag = diagnosticsPanel();
    if (diag) editorCol.append(diag);
    right.append(el('div', { class: 'mcs-panes' }, editorCol, inspector()));
    const kids = [
      menuBar(),
      el('div', { class: 'mcs-body' }, chapterRail(), right),
      statusBar(),
    ];
    const confirm = closeConfirmBar();
    if (confirm) kids.splice(2, 0, confirm);
    const menu = nodeMenu();
    if (menu) kids.push(menu);
    const imgMenu = imageMenu();
    if (imgMenu) kids.push(imgMenu);
    // 搜物品浮层：也是浮层，带 mcs-menu class，点外面会自动收。
    const picker = itemPickerPanel();
    if (picker) kids.push(picker);
    // 通知浮层：飘在右下角，不挡内容。它是临时的，过几秒自己没。
    const toast = toastEl();
    if (toast) kids.push(toast);
    // 记住画布上现在开着哪个右键菜单 / 搜物品浮层，点空白处才知道该摘掉哪一块
    openCtxEl = menu ?? imgMenu ?? picker ?? null;
    app.replaceChildren(...kids);

    // 键盘作用域：**每次重画都要重新绑**（render 会把整棵树换掉，旧元素上的监听器
    // 跟着没了）。画布自己已经绑过 'canvas'；这里把左右两栏标成 'other'，
    // 保证「点过画布 → 点侧栏 → 再按 Ctrl+C」不会还当成在画布上。
    //
    // 为什么统一在这里绑而不是各个面板里各自绑：右栏有好几个不同的构造分支
    // （questSide / contextSide / itemGridSide），漏一个就会出现
    // 「某个页面里 Ctrl+C 还会复制任务节点」这种很难复现的 bug。
    for (const cls of ['mcs-left', 'mcs-right']) {
      for (const n of app.children) {
        const stack = [n];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur) continue;
          if (String(cur.className ?? '').split(/\s+/).includes(cls)) bindKeyScope(cur, 'other');
          for (const kid of cur.children ?? []) stack.push(kid);
        }
      }
    }
  }

  if (focusKey) {
    const node = document.querySelector(`[data-focus="${focusKey}"]`);
    if (node instanceof HTMLInputElement) {
      node.focus();
      if (caret !== null && caret !== undefined) {
        try {
          node.setSelectionRange(caret, caret);
        } catch {
          /* number 类型不支持，忽略 */
        }
      }
    }
  }
}

// --------------------------------------------------------------- 启动

async function boot() {
  render();
  await loadInstancesAll();
  try {
    const saved = JSON.parse(localStorage.getItem('mcstudio.instance') ?? 'null');
    if (saved?.dir) await connect(saved.dir, saved.id ?? '');
  } catch {
    /* 第一次用，或者目录没了 */
  }
}

boot();
