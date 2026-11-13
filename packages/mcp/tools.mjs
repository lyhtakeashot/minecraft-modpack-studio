/**
 * MCP 工具清单：让模型直接操作整合包的那 27 个动作。
 *
 * 三条铁规矩（别改）：
 * ① 所有工具内部都调 `lib/host/api.js` 的 dispatchStudioRequest ——
 *    「点界面改」和「让模型改」必须落在同一套底层函数上，不能另写一套业务逻辑。
 * ② 写盘类工具一律「先预览、后写入」：apply 缺省 false 时只算不写，
 *    apply=true 才真落盘（和界面上的「预览 / 写入」两态一一对应）。
 * ③ 只用 Node 内置模块，不引任何第三方依赖（成品目录里没有 node_modules）。
 *
 * 参数名用模型读得懂的名字（dir / instance_id / quest_id …），
 * 内部再翻译成宿主接口认识的参数名（dir / id / questId …）。
 */

import { McError } from '../../packages/core/errors.js';
import { dispatchStudioRequest } from '../../lib/host/api.js';

const API_BASE = '/api/mcstudio';

// ————————————————————————— 公共片段 —————————————————————————

/** 所有「关于某个整合包」的工具都要的目录参数。 */
const DIR_PARAM = {
  dir: {
    type: 'string',
    description: '整合包实例目录的绝对路径（就是 ...\\versions\\<实例名> 这一层）。',
  },
};

/** 实例名：一个目录里有多个实例时必填。 */
const INSTANCE_PARAM = {
  instance_id: {
    type: 'string',
    description: '实例名；同一个目录里有多个实例时必填，填错会报错。',
  },
};

/** 写盘开关：默认 false = 只预览不写盘。 */
const APPLY_PARAM = {
  apply: {
    type: 'boolean',
    default: false,
    description: 'true 才会真的改文件；默认 false，只算一遍给你看，不写盘。',
  },
};

const DIR_ONLY = { type: 'object', properties: { ...DIR_PARAM }, required: ['dir'] };
const DIR_AND_INSTANCE = {
  type: 'object',
  properties: { ...DIR_PARAM, ...INSTANCE_PARAM },
  required: ['dir'],
};

// ————————————————————————— 小工具 —————————————————————————

/** 取整合包目录（模型偶尔会写成 pack_dir / instance_dir，也认环境变量里预设的那个）。 */
function dirOf(args) {
  const dir = String(
    args.dir ?? args.pack_dir ?? args.instance_dir ?? process.env.MCSTUDIO_PACK_DIR ?? '',
  ).trim();
  if (!dir) {
    throw new McError('缺少整合包目录', 'dir 要填整合包实例目录的绝对路径', 'McBadArgs');
  }
  return dir;
}

/** 取实例名（可以不给）。 */
function idOf(args) {
  return String(args.instance_id ?? args.instanceId ?? args.id ?? '').trim();
}

/** 「关于某个包」的基础参数。 */
function baseOf(args) {
  const out = { dir: dirOf(args) };
  const id = idOf(args);
  if (id) out.id = id;
  return out;
}

/**
 * 调一条宿主接口。
 *
 * GET 的参数拼在 query 上（数组/对象序列化成 JSON 串，宿主那边认），
 * POST 的参数放 JSON body（数组保持数组）。
 */
async function callRoute(route, params, method = 'GET') {
  const url = new URL(API_BASE + route, 'http://localhost');
  if (method === 'GET') {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  const request = { url: url.toString(), method };
  if (method === 'POST') {
    request.text = async () => JSON.stringify(params);
  }
  const res = await dispatchStudioRequest(request);
  const body = await res.json();
  if (!body || body.ok === false) {
    throw new McError(
      body?.error ?? `请求失败（HTTP ${res.status}）`,
      body?.hint ?? '',
      body?.code ?? 'McError',
    );
  }
  return body;
}

/** 把模型给的参数摊平成宿主接口的参数（去掉 undefined / 空串）。 */
function clean(params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (value === '' && key !== 'description' && key !== 'desc') continue;
    out[key] = value;
  }
  return out;
}

/** 列表取前 N 条拼成一行行文字。 */
function lines(list, max = 8, fmt = (x) => String(x)) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return '（没有）';
  return arr.slice(0, max).map(fmt).join('\n');
}

/** 数字参数（模型偶尔给字符串）。 */
function numOf(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 完成条件 / 奖励的「友好 spec」JSON 串。
 *
 * 原样交给后端去解析，MCP 这层不碰里面的内容 ——
 * 类型名和字段名以 packages/core/quest-conditions.js 为准，MCP 这层再抄一份就会走偏。
 * 模型偶尔把 JSON 当成对象塞进来，这里只负责「变成一个字符串」，不做任何解析。
 */
function specOf(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// ————————————————————————— 只读工具 —————————————————————————

const READ_TOOLS = [
  {
    name: 'instance_info',
    description:
      '看这个整合包是什么：实例名、Minecraft 版本、加载器、装了几个 mod、索引到多少物品和配方。只读，不改任何文件。'
      + '需要参数 dir（整合包实例目录的绝对路径）；一个目录里有多个实例时再加 instance_id。',
    inputSchema: DIR_AND_INSTANCE,
    async run(args) {
      const body = await callRoute('/summary', baseOf(args));
      const inst = body.instance ?? {};
      const idx = body.index ?? {};
      const summary =
        `这个包：${inst.id ?? '（名字没读出来）'}｜MC ${inst.mcVersion ?? '?'}｜加载器 ${inst.loader ?? '?'}`
        + `｜mod ${inst.modsCount ?? 0} 个（停用 ${inst.disabledModsCount ?? 0} 个）`
        + `｜物品 ${idx.itemCount ?? 0} 个、配方 ${idx.recipeCount ?? 0} 条`
        + `｜任务书目录：${(inst.questDirs ?? []).join('、') || '（没找到）'}`;
      return { summary, data: body };
    },
  },
  {
    name: 'pack_list',
    description:
      '列出本机常见的整合包位置（官方启动器、CurseForge、HMCL、PCL 下载目录等），用来找「要改的包在哪」。只读。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const body = await callRoute('/roots', {});
      const roots = body.roots ?? [];
      const summary = roots.length
        ? `本机这些位置下可能有整合包（挨个看看）：\n${lines(roots, 12, (r) => String(r?.dir ?? r))}`
        : '没找到常见的整合包目录。';
      return { summary, data: body };
    },
  },
  {
    name: 'mod_list',
    description:
      '列出这个包里的 mod：每个 mod 的 ID、名字、版本、含多少物品和配方。只读。'
      + '需要参数 dir；一个目录里有多个实例时再加 instance_id。',
    inputSchema: DIR_AND_INSTANCE,
    async run(args) {
      const body = await callRoute('/mods', baseOf(args));
      const mods = body.mods ?? [];
      const summary = mods.length
        ? `这个包里有 ${mods.length} 个 mod：\n${lines(mods, 12, (m) => `${m.modId}（${m.name ?? '?'} ${m.version ?? ''}）物品 ${m.items ?? 0} 配方 ${m.recipes ?? 0}`)}`
        : '这个包里没读到 mod。';
      return { summary, data: body };
    },
  },
  {
    name: 'mod_inspect',
    description:
      '拆开看某一个 mod 的 jar：默认看概览，view 可以选 items（它提供的物品）、recipes（它的配方）、tags（标签）、loot（战利品表）、config（配置文件）。只读。'
      + '需要参数 dir、mod_id。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        mod_id: { type: 'string', description: 'mod 的 ID（modId），比如 create、minecraft。' },
        view: {
          type: 'string',
          enum: ['summary', 'items', 'recipes', 'tags', 'loot', 'config'],
          description: '要看哪一块，默认 summary。',
        },
        limit: { type: 'number', description: '最多返回多少条，默认 60。' },
        item: { type: 'string', description: '只看某个物品（view=items 时用）。' },
      },
      required: ['dir', 'mod_id'],
    },
    async run(args) {
      const body = await callRoute('/analysis/mod', {
        ...baseOf(args),
        modId: String(args.mod_id ?? '').trim(),
        view: args.view ?? 'summary',
        limit: numOf(args.limit),
        item: args.item,
      });
      const summary = `mod ${body.modId ?? '?'}（${body.name ?? '?'} ${body.version ?? ''}）：`
        + `物品 ${body.counts?.items ?? 0}、配方 ${body.counts?.recipes ?? 0}、标签 ${body.counts?.tags ?? 0}、战利品 ${body.counts?.loot ?? 0}、配置 ${body.counts?.configs ?? 0}。`;
      return { summary, data: body };
    },
  },
  {
    name: 'item_search',
    description:
      '搜物品：按名字或 ID 找这个包里有什么东西。可以按 namespace（命名空间）或 mod 过滤。只读。'
      + '需要参数 dir；q、ns、mod 至少给一个，不然搜不出东西。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        q: { type: 'string', description: '关键字（物品 ID 或名字的一部分）。' },
        ns: { type: 'string', description: '只搜某个命名空间，比如 minecraft、create。' },
        mod: { type: 'string', description: '只搜某个 mod 提供的物品。' },
        limit: { type: 'number', description: '最多返回多少条，默认 40，最多 200。' },
      },
      required: ['dir'],
    },
    async run(args) {
      const body = await callRoute('/items', {
        ...baseOf(args),
        q: args.q,
        ns: args.ns,
        mod: args.mod,
        limit: numOf(args.limit),
      });
      const items = body.items ?? [];
      const summary = body.hint
        ? body.hint
        : `搜到 ${body.total ?? items.length} 个物品（返回 ${body.shown ?? items.length} 条）：\n`
          + lines(items, 12, (it) => String(it?.id ?? it?.name ?? JSON.stringify(it)));
      return { summary, data: body };
    },
  },
  {
    name: 'recipe_find',
    description:
      '查一个物品的配方：谁能做出来（producers）、谁要用它（consumers）。只读。'
      + '需要参数 dir、item（物品 ID，比如 testmod:cogwheel）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        item: { type: 'string', description: '物品 ID，命名空间:id 形式。' },
        limit: { type: 'number', description: '每边最多返回多少条，默认 20，最多 60。' },
      },
      required: ['dir', 'item'],
    },
    async run(args) {
      const body = await callRoute('/recipes', {
        ...baseOf(args),
        item: String(args.item ?? '').trim(),
        limit: numOf(args.limit),
      });
      const summary = `${body.item}：能做出来 ${body.producerTotal ?? 0} 条、用到它 ${body.consumerTotal ?? 0} 条。\n`
        + `做出来：\n${lines(body.producers, 8, (r) => `${r.id}（${r.type ?? r.kind ?? '?'}）产物 ${(r.outputs ?? []).map((o) => `${o.id}x${o.count ?? 1}`).join('、')}`)}\n`
        + `被用：\n${lines(body.consumers, 8, (r) => `${r.id}（${r.type ?? r.kind ?? '?'}）`)}`;
      return { summary, data: body };
    },
  },
  {
    name: 'recipe_path',
    description:
      '顺着材料往上追：看一个物品要经过几层加工才能做出来（第一层是基础材料）。只读。'
      + '需要参数 dir、item；depth 默认 4 层，最多 8 层。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        item: { type: 'string', description: '物品 ID。' },
        depth: { type: 'number', description: '追几层，默认 4，最多 8。' },
      },
      required: ['dir', 'item'],
    },
    async run(args) {
      const body = await callRoute('/analysis/recipe-path', {
        ...baseOf(args),
        item: String(args.item ?? '').trim(),
        depth: numOf(args.depth),
      });
      const summary = `${body.item} 的加工链共 ${body.levelCount ?? 0} 层`
        + `${body.truncated ? '（已截断）' : ''}：\n${lines(body.levels, 10, (l) => `${l.items?.join?.('、') ?? JSON.stringify(l)}`)}`;
      return { summary, data: body };
    },
  },
  {
    name: 'recipe_uses',
    description:
      '看谁在用一个物品：哪些配方把它当材料、哪些配方直接产出它。只读。'
      + '需要参数 dir、item；limit 默认 40，最多 200。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        item: { type: 'string', description: '物品 ID。' },
        limit: { type: 'number', description: '最多返回多少条，默认 40，最多 200。' },
      },
      required: ['dir', 'item'],
    },
    async run(args) {
      const body = await callRoute('/analysis/recipe-uses', {
        ...baseOf(args),
        item: String(args.item ?? '').trim(),
        limit: numOf(args.limit),
      });
      const summary = `${body.item} 被 ${body.count ?? 0} 处用到：\n${lines(body.recipes, 10, (r) => `${r.id}（${r.type ?? '?'}）`)}`;
      return { summary, data: body };
    },
  },
  {
    name: 'quest_list',
    description:
      '列出任务书里的任务。可以给 q（关键词，匹配标题、描述、任务 ID、物品）、chapter（章节标题或 ID）、limit（默认 80，最多 300）。只读。'
      + '需要参数 dir；这个包必须装了 FTB Quests。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        q: { type: 'string', description: '关键词过滤：标题、描述、任务 ID、物品都算。' },
        chapter: { type: 'string', description: '只看某一章（章节标题或章节 ID）。' },
        limit: { type: 'number', description: '最多返回多少条，默认 80，最多 300。' },
      },
      required: ['dir'],
    },
    async run(args) {
      const body = await callRoute('/quests', {
        ...baseOf(args),
        q: args.q,
        chapter: args.chapter,
        limit: numOf(args.limit),
      });
      const items = body.items ?? [];
      const summary = items.length
        ? `一共 ${body.total ?? items.length} 个任务（返回 ${body.shown ?? items.length} 条）：\n`
          + lines(items, 12, (q) => `${q.id}｜${q.title ?? q.titleItem ?? '（没标题）'}｜${q.chapterTitle ?? q.chapterId ?? ''}`)
        : '没找到符合条件的任务。';
      return { summary, data: body };
    },
  },
  {
    name: 'quest_show',
    description:
      '看一个任务的详情：标题、副标题、描述、所在章节、坐标、完成条件、奖励、前置和后续任务。只读。'
      + '需要参数 dir、quest_id（任务 ID）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        quest_id: { type: 'string', description: '任务 ID，比如 A1B2C3D4。' },
      },
      required: ['dir', 'quest_id'],
    },
    async run(args) {
      const body = await callRoute('/quest', {
        ...baseOf(args),
        questId: String(args.quest_id ?? '').trim(),
      });
      const desc = Array.isArray(body.description) ? body.description.join('\n') : (body.description ?? '');
      const summary = `${body.id}｜${body.title ?? body.titleItem ?? '（没标题）'}`
        + `｜章节 ${body.chapterTitle ?? body.chapterId ?? '?'}｜坐标 (${body.x ?? '?'}, ${body.y ?? '?'})`
        + `\n${desc || '（没写描述）'}\n`
        + `完成条件：${lines(body.tasks, 5, (t) => `${t.type ?? ''} ${t.item?.id ?? ''} x${t.item?.count ?? t.count ?? 1}`)}\n`
        + `奖励：${lines(body.rewards, 5, (r) => `${r.type ?? ''} ${r.item?.id ?? r.what ?? ''} x${r.item?.count ?? r.count ?? 1}`)}`;
      return { summary, data: body };
    },
  },
  {
    name: 'quest_lint',
    description:
      '给任务书做体检：重复的任务 ID、指向不存在任务的依赖、坏了的章节等。只读，一个文件都不写。'
      + '需要参数 dir；这个包必须装了 FTB Quests。',
    inputSchema: DIR_AND_INSTANCE,
    async run(args) {
      const body = await callRoute('/questbook', baseOf(args));
      const issues = body.issues ?? {};
      const problems = issues.problems ?? [];
      const summary = `任务书体检：${body.questCount ?? 0} 个任务、${body.chapterCount ?? 0} 章；`
        + `问题 ${issues.errorCount ?? 0} 个错误、${issues.warnCount ?? 0} 个警告、`
        + `重复 ID ${issues.duplicateCount ?? 0} 个、悬空依赖 ${issues.danglingCount ?? 0} 个。\n`
        + (problems.length ? lines(problems, 12, (p) => `【${p.level ?? '?'}】${p.where ?? ''} ${p.message ?? p}`) : '没发现问题。');
      return { summary, data: body };
    },
  },
  {
    name: 'overlap_report',
    description:
      '查 mod 撞车：几个 mod 在提供同名物品（高置信）、哪些功能族挤在一起（中低置信）。只读。'
      + '需要参数 dir；min_namespaces 默认 2、min_items 默认 5、limit 默认 20。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        min_namespaces: { type: 'number', description: '几个 mod 提供同名物品算撞车，默认 2。' },
        min_items: { type: 'number', description: '一个功能族至少几个物品，默认 5。' },
        limit: { type: 'number', description: '最多列多少条，默认 20。' },
      },
      required: ['dir'],
    },
    async run(args) {
      const body = await callRoute('/analysis/overlap', {
        ...baseOf(args),
        minNamespaces: numOf(args.min_namespaces),
        minItems: numOf(args.min_items),
        limit: numOf(args.limit),
      });
      const summary = `撞车检查：${body.collisionCount ?? 0} 处同名物品冲突，`
        + `${(body.crowdedFamilies ?? []).length} 个功能族挤在一起。\n`
        + lines(body.lines ?? [], 12, (l) => String(l));
      return { summary, data: body };
    },
  },
  {
    name: 'progression_check',
    description:
      '看进度形状：按合成链深度给物品分层，判断这个包的流程是「陡」（一下子能做全套）还是「平」（一层层爬）。只读。'
      + '需要参数 dir；max_depth 默认 6，最多 12。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        max_depth: { type: 'number', description: '算几层，默认 6，最多 12。' },
      },
      required: ['dir'],
    },
    async run(args) {
      const body = await callRoute('/analysis/progress', {
        ...baseOf(args),
        maxDepth: numOf(args.max_depth),
      });
      const summary = `进度曲线（${body.recipeCount ?? 0} 条配方）：\n${lines(body.lines ?? [], 12, (l) => String(l))}`;
      return { summary, data: body };
    },
  },
  {
    name: 'kubejs_check',
    description:
      '给 KubeJS 脚本做体检：脚本能不能跑通、脚本里提到但包里没有的物品和配方。只读。'
      + '需要参数 dir；limit 默认 15。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        limit: { type: 'number', description: '最多列多少个脚本，默认 15，最多 100。' },
      },
      required: ['dir'],
    },
    async run(args) {
      const body = await callRoute('/analysis/kubejs', {
        ...baseOf(args),
        limit: numOf(args.limit),
      });
      const summary = `KubeJS 体检：${body.scriptCount ?? 0} 个脚本；`
        + `缺物品 ${(body.missingItems ?? []).length} 个、缺配方 ${(body.missingRecipes ?? []).length} 个。\n`
        + lines(body.lines ?? [], 12, (l) => String(l));
      return { summary, data: body };
    },
  },
  {
    name: 'export_preview',
    description:
      '算一下打包会得到什么：多少文件、多大、顶层结构、会不会缺东西。只算，不打包、不写盘。'
      + '需要参数 dir；mode 默认 offline，可选 standard（轻量包）、offline（离线包）、launcher（带启动器）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        mode: { type: 'string', enum: ['standard', 'offline', 'launcher'], description: '打包形态，默认 offline。' },
        pack_name: { type: 'string', description: '包名，留空自动起。' },
        include_saves: { type: 'boolean', description: '带上存档，默认不带。' },
        include_libraries: { type: 'boolean', description: '带上游戏库，默认带。' },
        include_assets: { type: 'boolean', description: '带上贴图音效，默认带。' },
        include_runtime: { type: 'boolean', description: '带上 Java 运行环境，默认不带。' },
        pcl_exe: { type: 'string', description: 'mode=launcher 时要套进去的 PCL.exe 路径。' },
      },
      required: ['dir'],
    },
    async run(args) {
      const body = await callRoute('/export/preview', {
        ...baseOf(args),
        mode: args.mode,
        packName: args.pack_name,
        includeSaves: args.include_saves,
        includeLibraries: args.include_libraries,
        includeAssets: args.include_assets,
        includeRuntime: args.include_runtime,
        pclExe: args.pcl_exe,
      });
      const summary = `打包预览（${body.mode ?? '?'}｜${body.packName ?? ''}）：${body.fileCount ?? 0} 个文件、`
        + `${Math.round((body.totalBytes ?? 0) / 1024)} KB，输出到 ${body.outDir ?? '?'}\n`
        + lines(body.warnings ?? [], 8, (w) => String(w));
      return { summary, data: body };
    },
  },
  {
    name: 'launch_preview',
    description:
      '算一遍启动这个包要用的命令行，检查有没有明显问题（缺客户端 jar、缺 Java、缺库）。只算，不真启动。'
      + '需要参数 dir；可以顺带给 mc_root（客户端目录）、java_path、username。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        mc_root: { type: 'string', description: 'Minecraft 客户端根目录（放着 versions 的那一层）。' },
        java_path: { type: 'string', description: 'java.exe 的完整路径。' },
        username: { type: 'string', description: '玩家名，默认 Player。' },
      },
      required: ['dir'],
    },
    async run(args) {
      const body = await callRoute('/launch/preview', {
        ...baseOf(args),
        mcRoot: args.mc_root,
        javaPath: args.java_path,
        username: args.username,
      });
      const summary = `启动预览：版本 ${body.versionId ?? '?'}｜Java ${body.java ?? '?'}\n`
        + (body.blockers?.length
          ? `有 ${body.blockers.length} 个问题：\n${lines(body.blockers, 8, (b) => String(b))}`
          : '没发现明显问题。')
        + `\n命令行：${body.command ?? '（没算出来）'}`;
      return { summary, data: body };
    },
  },
];

// ————————————————————————— 写盘工具 —————————————————————————

const WRITE_TOOLS = [
  {
    name: 'recipe_edit',
    description:
      '改或删一条配方：删掉原来的，再按你给的样子写一条新的（走 KubeJS 脚本或多产物数据包）。'
      + '默认只预览不写盘，把 apply 设为 true 才会真的改文件。'
      + '需要参数 dir、recipe_id；改的话还要 count 加上 inputs（无序）或 pattern+keys（有序）；多产物用 outputs。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        recipe_id: { type: 'string', description: '要改的配方 ID。' },
        action: { type: 'string', enum: ['edit', 'remove'], description: '改还是删，默认 edit。' },
        count: { type: 'number', description: '产物数量（1~64）。' },
        inputs: { type: 'array', items: { type: 'string' }, description: '材料列表（无序合成）。' },
        pattern: { type: 'array', items: { type: 'string' }, description: '有序合成的图案，比如 ["AA","AA"]。' },
        keys: { type: 'object', description: '图案字符对应哪个物品，比如 {"A":"minecraft:iron_ingot"}。' },
        outputs: {
          type: 'array',
          description: '多产物用：[{id, count, chance}]，chance 是 0~1 之间的概率。',
          items: { type: 'object' },
        },
        file_name: { type: 'string', description: '生成的脚本文件名，默认 recipes。' },
        ...APPLY_PARAM,
      },
      required: ['dir', 'recipe_id'],
    },
    async run(args) {
      const action = String(args.action ?? 'edit').toLowerCase() === 'remove' ? 'remove' : 'edit';
      const params = clean({
        ...baseOf(args),
        recipeId: String(args.recipe_id ?? '').trim(),
        action,
        count: numOf(args.count),
        inputs: args.inputs,
        pattern: args.pattern,
        keys: args.keys,
        outputs: args.outputs,
        fileName: args.file_name,
      });
      const body = await callRoute(
        args.apply === true ? '/recipe/apply' : '/recipe/preview',
        params,
        args.apply === true ? 'POST' : 'GET',
      );
      const summary = args.apply === true
        ? `配方已经改好并写盘：${body.targetPath ?? ''}\n${lines(body.summary ?? [], 6, (s) => String(s))}`
        : `配方改完会这样（还没写盘，apply=true 才落盘）：\n`
          + `${body.targetPath ?? ''}\n${lines(body.summary ?? [], 6, (s) => String(s))}`
          + (body.warnings?.length ? `\n注意：\n${lines(body.warnings, 6, (w) => String(w))}` : '');
      return { summary, data: body };
    },
  },
  {
    name: 'recipe_edit_batch',
    description:
      '一次改或删好几条配方：把所有改动合成一份 KubeJS 脚本一次写盘（循环调单条会互相覆盖）。'
      + '默认只预览不写盘，把 apply 设为 true 才会真的改文件。'
      + '需要参数 dir、recipes（数组，每项至少 recipe_id，可带各自的 action / count / delta / inputs / pattern / keys / outputs）；'
      + '外层 action（edit / remove）、delta（给所有选中条统一「产出 +N」）、file_name 是统一值，逐条没给时用它们。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        recipes: {
          type: 'array',
          description: '要改的配方数组，每项至少 {recipe_id}，可带各自的 action / count / delta / inputs / pattern / keys / outputs。',
          items: { type: 'object' },
        },
        action: { type: 'string', enum: ['edit', 'remove'], description: '统一动作：改还是删，默认 edit。' },
        delta: { type: 'number', description: '给所有选中条统一「产出 +N」（在各自原数量上加），只 edit 用得上。' },
        file_name: { type: 'string', description: '生成的脚本文件名，默认 recipes。' },
        ...APPLY_PARAM,
      },
      required: ['dir', 'recipes'],
    },
    async run(args) {
      // 模型给的是 recipe_id，宿主接口认 recipeId；数组整体传过去，别拆成字符串。
      const items = (Array.isArray(args.recipes) ? args.recipes : []).map((one) => clean({
        recipeId: String(one.recipe_id ?? one.recipeId ?? '').trim(),
        action: one.action,
        count: numOf(one.count),
        delta: numOf(one.delta),
        inputs: one.inputs,
        pattern: one.pattern,
        keys: one.keys,
        outputs: one.outputs,
      }));
      const params = clean({
        ...baseOf(args),
        items,
        action: args.action,
        delta: numOf(args.delta),
        fileName: args.file_name,
      });
      // 批量预览也走 POST：items 是数组，放 body 比拼在 query 上稳；
      // /recipe/batch/preview 登记了 GET+POST，/recipe/batch/apply 只收 POST。
      const body = await callRoute(
        args.apply === true ? '/recipe/batch/apply' : '/recipe/batch/preview',
        params,
        'POST',
      );
      const fileLines = args.apply === true
        ? lines(body.files ?? [], 8, (f) => String(f))
        : lines((body.files ?? []).map((f) => f.file ?? f), 8, (f) => String(f));
      const impact = body.impact?.critical?.length
        ? `\n注意：${lines(body.impact.critical, 5, (b) => `${b.item}（${b.usedBy} 条配方要用）`)}`
        : '';
      const summary = args.apply === true
        ? `这批配方已经改好并写盘（${body.counts?.files ?? 0} 个文件）：\n${fileLines}\n${lines(body.summary ?? [], 6, (s) => String(s))}`
        : `这批 ${body.items?.length ?? 0} 条改完会这样（还没写盘，apply=true 才落盘）：\n${fileLines}\n${lines(body.summary ?? [], 6, (s) => String(s))}`
          + (body.warnings?.length ? `\n注意：\n${lines(body.warnings, 6, (w) => String(w))}` : '') + impact;
      return { summary, data: body };
    },
  },
  {
    name: 'quest_add',
    description:
      '在任务书里新建一个任务：标题、描述、完成条件、奖励、前置任务、坐标。'
      + '完成条件不只「交东西」：可以是交物品、杀怪、到某个维度、攒经验、完成进度、到群系、找到结构……；奖励也不只给物品，还能给经验、给等级、给进度、执行命令、弹提示、按战利品表给。'
      + '两种写法二选一：简单情况用 task_item / task_count / reward_item / reward_count（只管「物品」这一类）；'
      + '要别的类型就用 task_spec / reward_spec（JSON 串，能指定任意类型）。'
      + '默认只预览不写盘，把 apply 设为 true 才会真的写文件。'
      + '需要参数 dir、chapter（章节标题或 ID）、title；这个包必须装了 FTB Quests。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        chapter: { type: 'string', description: '放到哪一章（章节标题或章节 ID）。' },
        title: { type: 'string', description: '任务标题，必填。' },
        subtitle: { type: 'string', description: '副标题。' },
        description: { type: 'array', items: { type: 'string' }, description: '描述，一行一条。' },
        depends_on: { type: 'array', items: { type: 'string' }, description: '前置任务 ID 列表。' },
        task_item: { type: 'string', description: '完成条件要交的物品 ID（只对 item 类型有效）。要别的类型用 task_spec。' },
        task_count: { type: 'number', description: '要交多少个，默认 1（配合 task_item 用）。' },
        task_spec: {
          type: 'string',
          description:
            '完成条件的 JSON 串，形如 {"type":"kill","entity":"minecraft:zombie","count":5}；'
            + '可用的 type 有 kill / advancement / dimension / xp / stat / biome / structure / observation / gamestage / checkmark / item。'
            + '和 task_item 同时给时以 task_spec 为准。',
        },
        reward_item: { type: 'string', description: '奖励物品 ID（只对 item 类型有效）。要别的类型用 reward_spec。' },
        reward_count: { type: 'number', description: '奖励多少个，默认 1（配合 reward_item 用）。' },
        reward_spec: {
          type: 'string',
          description:
            '奖励的 JSON 串，形如 {"type":"xp","count":100}；'
            + '可用的 type 有 kill / advancement / dimension / xp / stat / biome / structure / observation / gamestage / checkmark / item。'
            + '奖励那一套的类型是 item / xp / xp_levels / advancement / toast / command / choice / random / loot，'
            + '两边别混。和 reward_item 同时给时以 reward_spec 为准。',
        },
        x: { type: 'number', description: '画布横坐标，留空自动排。' },
        y: { type: 'number', description: '画布纵坐标，留空自动排。' },
        ...APPLY_PARAM,
      },
      required: ['dir', 'chapter', 'title'],
    },
    async run(args) {
      const params = clean({
        ...baseOf(args),
        chapter: args.chapter,
        title: args.title,
        subtitle: args.subtitle,
        description: args.description,
        dependsOn: args.depends_on,
        taskItem: args.task_item,
        taskCount: numOf(args.task_count),
        taskSpec: specOf(args.task_spec),
        rewardItem: args.reward_item,
        rewardCount: numOf(args.reward_count),
        rewardSpec: specOf(args.reward_spec),
        x: numOf(args.x),
        y: numOf(args.y),
      });
      const body = await callRoute(
        args.apply === true ? '/quest/add/apply' : '/quest/add/preview',
        params,
        'POST',
      );
      const summary = args.apply === true
        ? `新任务已经写进去：${body.questId ?? ''}（${body.title ?? ''}）\n${lines(body.diff ?? [], 8, (d) => String(d))}`
        : `新任务会是这样（还没写盘，apply=true 才落盘）：${body.questId ?? ''}（${body.title ?? ''}）\n`
          + lines(body.diff ?? [], 8, (d) => String(d));
      return { summary, data: body };
    },
  },
  {
    name: 'quest_chapter',
    description:
      '在任务书里新建一个章节：标题、所属分组、图标、排序。'
      + '默认只预览不写盘，把 apply 设为 true 才会真的写文件。'
      + '需要参数 dir、title；这个包必须装了 FTB Quests。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        title: { type: 'string', description: '章节标题，必填。' },
        group: { type: 'string', description: '挂在哪个分组下（分组标题或 ID）；不挂就别填。' },
        icon: { type: 'string', description: '章节图标物品 ID。' },
        order_index: { type: 'number', description: '排序号，留空自动排到后面。' },
        ...APPLY_PARAM,
      },
      required: ['dir', 'title'],
    },
    async run(args) {
      const params = clean({
        ...baseOf(args),
        title: args.title,
        group: args.group,
        icon: args.icon,
        orderIndex: numOf(args.order_index),
      });
      const body = await callRoute(
        args.apply === true ? '/quest/chapter/apply' : '/quest/chapter/preview',
        params,
        args.apply === true ? 'POST' : 'GET',
      );
      const summary = args.apply === true
        ? `新章节已经写进去：${body.chapterId ?? ''}（${body.title ?? ''}）\n${lines(body.diff ?? [], 8, (d) => String(d))}`
        : `新章节会是这样（还没写盘，apply=true 才落盘）：${body.chapterId ?? ''}（${body.title ?? ''}）\n`
          + lines(body.diff ?? [], 8, (d) => String(d));
      return { summary, data: body };
    },
  },
  {
    name: 'quest_move',
    description:
      '挪任务在画布上的位置（坐标）。可以一次挪多个：moves 传 [{quest_id, x, y}]。'
      + '默认只预览不写盘，把 apply 设为 true 才会真的写文件。'
      + '需要参数 dir、moves。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        moves: {
          type: 'array',
          description: '要挪的任务：[{quest_id, x, y}]。',
          items: { type: 'object' },
        },
        quest_id: { type: 'string', description: '只挪一个时的简写：任务 ID（配合 x、y）。' },
        x: { type: 'number', description: '横坐标（配合 quest_id）。' },
        y: { type: 'number', description: '纵坐标（配合 quest_id）。' },
        ...APPLY_PARAM,
      },
      required: ['dir'],
    },
    async run(args) {
      const moves = Array.isArray(args.moves)
        ? args.moves.map((m) => ({ questId: m?.quest_id ?? m?.questId, x: m?.x, y: m?.y }))
        : undefined;
      const params = clean({
        ...baseOf(args),
        moves,
        questId: args.quest_id,
        x: numOf(args.x),
        y: numOf(args.y),
      });
      const body = await callRoute(
        args.apply === true ? '/quest/move/apply' : '/quest/move/preview',
        params,
        'POST',
      );
      const summary = args.apply === true
        ? `坐标已经写进去，一共挪了 ${body.changedCount ?? 0} 个任务。`
        : `坐标会变成这样（还没写盘，apply=true 才落盘），一共 ${body.changedCount ?? 0} 个任务：\n`
          + lines(body.diff ?? [], 10, (d) => String(d));
      return { summary, data: body };
    },
  },
  {
    name: 'quest_patch',
    description:
      '改一个已有任务：标题、副标题、描述、坐标、完成条件、奖励。只想改哪项就只给哪项，没给的都不动。'
      + '完成条件和奖励支持多种类型：可以是交物品、杀怪、到某个维度、攒经验、完成进度、到群系、找到结构……；'
      + '奖励还能给经验、给等级、给进度、执行命令、弹提示、按战利品表给。'
      + '两种写法二选一：task_item / reward_item 只表示「物品」这一类（配 task_count / reward_count 说数量）；'
      + '要别的类型就用 task_spec / reward_spec（JSON 串，能指定任意类型）。'
      + '两种写法都不给，这一组就完全不碰 —— 免得把人家配好的条件抹掉。'
      + '默认只预览不写盘，把 apply 设为 true 才会真的写文件。需要参数 dir、quest_id。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        quest_id: { type: 'string', description: '要改的任务 ID。' },
        title: { type: 'string', description: '新标题。' },
        subtitle: { type: 'string', description: '新副标题。' },
        description: { type: 'array', items: { type: 'string' }, description: '新描述，一行一条。' },
        x: { type: 'number', description: '新横坐标。' },
        y: { type: 'number', description: '新纵坐标。' },
        task_item: { type: 'string', description: '完成条件要交的物品 ID；只对 item 类型有效，要别的类型用 task_spec。不给就不动这一组。' },
        task_count: { type: 'number', description: '完成条件要交几个（默认 1），要连 task_item 一起给。' },
        task_spec: {
          type: 'string',
          description:
            '完成条件的 JSON 串，形如 {"type":"kill","entity":"minecraft:zombie","count":5}；'
            + '可用的 type 有 kill / advancement / dimension / xp / stat / biome / structure / observation / gamestage / checkmark / item。'
            + '和 task_item 同时给时以 task_spec 为准；不给就不动这一组。',
        },
        reward_item: { type: 'string', description: '完成后给的物品 ID；只对 item 类型有效，要别的类型用 reward_spec。不给就不动这一组。' },
        reward_count: { type: 'number', description: '奖励给几个（默认 1），要连 reward_item 一起给。' },
        reward_spec: {
          type: 'string',
          description:
            '奖励的 JSON 串，形如 {"type":"xp","count":100}；'
            + '可用的 type 有 kill / advancement / dimension / xp / stat / biome / structure / observation / gamestage / checkmark / item。'
            + '奖励那一套的类型是 item / xp / xp_levels / advancement / toast / command / choice / random / loot，'
            + '两边别混。和 reward_item 同时给时以 reward_spec 为准；不给就不动这一组。',
        },
        ...APPLY_PARAM,
      },
      required: ['dir', 'quest_id'],
    },
    async run(args) {
      const apply = args.apply === true;
      const common = {
        ...baseOf(args),
        questId: String(args.quest_id ?? '').trim(),
        title: args.title,
        subtitle: args.subtitle,
        x: numOf(args.x),
        y: numOf(args.y),
        taskItem: args.task_item,
        taskCount: numOf(args.task_count),
        taskSpec: specOf(args.task_spec),
        rewardItem: args.reward_item,
        rewardCount: numOf(args.reward_count),
        rewardSpec: specOf(args.reward_spec),
      };
      // 预览那条路由只收 GET，描述只能拼成多行文本；写入那条是 POST，可以直接送数组。
      const descValue = Array.isArray(args.description)
        ? (apply ? args.description : args.description.join('\n'))
        : args.description;
      const params = clean({ ...common, desc: descValue });
      const body = await callRoute(
        apply ? '/quest/apply' : '/quest/preview',
        params,
        apply ? 'POST' : 'GET',
      );
      const summary = apply
        ? `任务已经改好并写盘：${body.questId ?? ''}\n${lines(body.summary ?? [], 8, (s) => String(s))}`
        : `任务会改成这样（还没写盘，apply=true 才落盘）：\n${lines(body.summary ?? [], 8, (s) => String(s))}`
          + (body.warnings?.length ? `\n注意：\n${lines(body.warnings, 6, (w) => String(w))}` : '');
      return { summary, data: body };
    },
  },
  {
    name: 'quest_remove',
    description:
      '删掉一个任务（连带处理指向它的前置依赖）。会先告诉你会动哪些文件、影响几个任务。'
      + '默认只预览不写盘，把 apply 设为 true 才会真的删。'
      + '需要参数 dir、quest_id。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        quest_id: { type: 'string', description: '要删的任务 ID。' },
        ...APPLY_PARAM,
      },
      required: ['dir', 'quest_id'],
    },
    async run(args) {
      const params = clean({
        ...baseOf(args),
        questId: String(args.quest_id ?? '').trim(),
      });
      const body = await callRoute(
        args.apply === true ? '/quest/node/delete/apply' : '/quest/node/delete/preview',
        params,
        args.apply === true ? 'POST' : 'GET',
      );
      const summary = args.apply === true
        ? `任务已经删掉：${body.questId ?? ''}（${body.questTitle ?? ''}），连带改了 ${body.affectedCount ?? 0} 处。`
        : `删掉 ${body.questId ?? ''}（${body.questTitle ?? ''}）会连带改 ${body.affectedCount ?? 0} 处`
          + `（还没写盘，apply=true 才落盘）：\n${lines(body.diff ?? [], 10, (d) => String(d))}`;
      return { summary, data: body };
    },
  },
  {
    name: 'quest_image',
    description:
      '改章节画布上的装饰图（背景贴图）：action=add 加一张、move 挪一张、remove 删一张。'
      + '默认只预览不写盘，把 apply 设为 true 才会真的写文件。'
      + '需要参数 dir、chapter；add 时给 image（资源 ID），move/remove 时给 index。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        chapter: { type: 'string', description: '章节标题或章节 ID。' },
        action: { type: 'string', enum: ['add', 'move', 'remove'], description: '加 / 挪 / 删，默认 add。' },
        index: { type: 'number', description: '第几张图（从 0 开始），move 和 remove 用。' },
        image: { type: 'string', description: '图片资源 ID，比如 minecraft:textures/gui/…（add 用）。' },
        x: { type: 'number', description: '图片横坐标。' },
        y: { type: 'number', description: '图片纵坐标。' },
        width: { type: 'number', description: '图片宽度。' },
        height: { type: 'number', description: '图片高度。' },
        rotation: { type: 'number', description: '旋转角度。' },
        ...APPLY_PARAM,
      },
      required: ['dir', 'chapter'],
    },
    async run(args) {
      const params = clean({
        ...baseOf(args),
        chapter: args.chapter,
        action: args.action,
        index: numOf(args.index),
        image: args.image,
        x: numOf(args.x),
        y: numOf(args.y),
        width: numOf(args.width),
        height: numOf(args.height),
        rotation: numOf(args.rotation),
      });
      const body = await callRoute(
        args.apply === true ? '/quest/image/apply' : '/quest/image/preview',
        params,
        args.apply === true ? 'POST' : 'GET',
      );
      const summary = args.apply === true
        ? `装饰图已经写进去：${body.changedCount ?? 0} 处改动。`
        : `装饰图会这样改（还没写盘，apply=true 才落盘）：${body.changedCount ?? 0} 处改动\n`
          + lines(body.changes ?? body.diff ?? [], 8, (c) => String(c));
      return { summary, data: body };
    },
  },
  {
    name: 'mod_update',
    description:
      '检查整合包里已装的 mod 有没有新版本，并把选中的升级到最新版。'
      + '认 mod 用的是 jar 文件的哈希，不会认错工程；查不到（比如只在 CurseForge 发布、或手改过的 jar）会如实标出来。'
      + '不删旧文件：旧 jar 改名为 .jar.disabled 停用，新 jar 下载进来；下载失败会自动把旧 jar 改回来。'
      + '默认 apply=false 只列清单（谁有更新、会停用哪些旧文件、要下多大），apply=true 才真的下载升级。'
      + '需要参数 dir；channel 选发布渠道（release/beta/alpha），selected 选要升哪几个（留空＝全部能升的），'
      + 'check 可把上次返回的整块 check 用 JSON.stringify 成字符串回传，省得再联网问一次。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        channel: { type: 'string', enum: ['release', 'beta', 'alpha'], description: '发布渠道，默认 release（只认正式版）。' },
        selected: {
          type: 'array',
          items: { type: 'string' },
          description: '只升哪几个：填检查结果里的 key（sha1）或文件名。留空＝全部能升的。',
        },
        check: {
          type: 'string',
          description: '可选。把上次返回的 check 整块 JSON.stringify 成字符串回传，省一次联网。',
        },
        ...APPLY_PARAM,
      },
      required: ['dir'],
    },
    async run(args) {
      const params = clean({
        ...baseOf(args),
        channel: String(args.channel ?? '').trim(),
        selected: args.selected,
        check: args.check,
      });
      // 预览也走 POST：整块 check 可能很长，塞进 GET 查询串会超长。
      const body = await callRoute(
        args.apply === true ? '/mod-update/apply' : '/mod-update/preview',
        params,
        'POST',
      );
      const summary = args.apply === true
        ? `${body.ok ? '升级完成' : '升级有没成功的'}：装好 ${body.installed?.length ?? 0} 个，`
          + `跳过 ${body.skipped?.length ?? 0} 个，失败 ${body.failed?.length ?? 0} 个。\n`
          + lines(body.lines ?? [], 12)
        : `扫了 ${body.check?.scanned ?? 0} 个 jar，其中 ${body.check?.updates ?? 0} 个有新版本`
          + `（已是最新 ${body.check?.latest ?? 0} 个，查不到 ${body.check?.unknown ?? 0} 个，已锁定 ${body.check?.locked ?? 0} 个）。\n`
          + `${lines(body.check?.lines ?? [], 12)}\n\n`
          + `升级清单（还没写盘，apply=true 才下载）：\n${lines(body.lines ?? [], 12)}`;
      return { summary, data: body };
    },
  },
  {
    name: 'mod_update_locks',
    description:
      '管理这个整合包的「mod 更新锁定名单」：被锁定的 mod 以后检查更新时不再提示有新版本，'
      + '也绝不会被升级（适合作者手工改过、或故意锁死旧版的 mod）。'
      + '名单写在软件自己的数据目录，绝不改用户整合包里的任何文件。'
      + '默认 apply=false 只读，列出当前锁定了哪些；apply=true 才真的改名单，'
      + '配合 action（add 加一条 / remove 解一条 / clear 清空）和 entry（哪个 mod）用。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        action: { type: 'string', enum: ['add', 'remove', 'clear'], description: 'apply=true 时要做的动作，默认 add。' },
        entry: {
          type: 'string',
          description: 'apply=true 且 action 为 add/remove 时给：把检查更新结果里那一项用 JSON.stringify 成字符串传进来（含 modId / projectId / fileName / name）。',
        },
        ...APPLY_PARAM,
      },
      required: ['dir'],
    },
    async run(args) {
      if (args.apply !== true) {
        // 只读：把名单列给你看，一个字都不写。
        const body = await callRoute('/mod-update/locks', clean(baseOf(args)), 'GET');
        return {
          summary: `这个包锁定了 ${body.locks?.length ?? 0} 个 mod。\n${lines(body.lines ?? [], 8)}`,
          data: body,
        };
      }
      // 写入：只收 POST。entry 是 JSON 串，后端会再解析成对象。
      const params = clean({
        ...baseOf(args),
        action: String(args.action ?? 'add').trim() || 'add',
        entry: args.entry,
      });
      const body = await callRoute('/mod-update/locks', params, 'POST');
      return {
        summary: `${body.error ? `改不了：${body.error}` : '锁定名单已更新'}。\n${lines(body.lines ?? [], 8)}`,
        data: body,
      };
    },
  },
  {
    name: 'mod_update_rollback',
    description:
      '把刚做的一次 mod 升级「撤回」：新下载的 jar 改名停用留着，旧 jar 从 .jar.disabled 改回原名，'
      + '全程一个文件都不删。用于升级后出现兼容问题、想立刻退回旧版。'
      + '默认 apply=false 只列撤回清单，apply=true 才真的改文件名。'
      + '需要把上次 mod_update（apply=true）返回的整块结果用 JSON.stringify 成字符串填进 result —— '
      + '里面有记录下来的实际停用名，不能自己硬拼 .jar.disabled。',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIR_PARAM,
        ...INSTANCE_PARAM,
        result: { type: 'string', description: '把升级结果的整块对象 JSON.stringify 成字符串回传（含 installed[] 与其中的 oldName / disabledName / newName）。' },
        ...APPLY_PARAM,
      },
      required: ['dir', 'result'],
    },
    async run(args) {
      const params = clean({ ...baseOf(args), result: args.result });
      const body = await callRoute(
        args.apply === true ? '/mod-update/rollback/apply' : '/mod-update/rollback/preview',
        params,
        'POST',
      );
      const summary = args.apply === true
        ? `${body.ok ? '撤回完成' : '撤回有没成功的'}：恢复 ${body.restored?.length ?? 0} 个，失败 ${body.failed?.length ?? 0} 个。\n`
          + lines(body.lines ?? [], 12)
        : `撤回清单（还没动文件，apply=true 才改）：\n${lines(body.lines ?? [], 12)}`;
      return { summary, data: body };
    },
  },
];

// ————————————————————————— 对外接口 —————————————————————————

/** 全部工具（给 tools/list 用）。 */
export const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

/** 会写盘的那些工具（界面上的测试要拿这个名单核对 apply 参数）。 */
export const WRITE_TOOL_NAMES = WRITE_TOOLS.map((t) => t.name);

/** 工具名 → 定义。 */
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** 只要工具清单（name / description / inputSchema），不含实现。 */
export function toolManifest() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * 调一个工具。
 *
 * 成功：content 里放一段人话摘要，structuredContent 里放接口返回的完整 JSON。
 * 失败：isError=true，content 里既有人话说明，也有 error/hint/code 的 JSON。
 */
export async function callTool(name, args = {}) {
  const tool = BY_NAME.get(name);
  if (!tool) {
    const text = `没有这个工具：${name}\n可用工具：${TOOLS.map((t) => t.name).join('、')}`;
    return {
      content: [{ type: 'text', text }],
      structuredContent: { ok: false, error: `没有这个工具：${name}`, code: 'McNoTool' },
      isError: true,
    };
  }
  try {
    const { summary, data } = await tool.run(args ?? {});
    return {
      content: [{ type: 'text', text: String(summary ?? '') }],
      structuredContent: data ?? {},
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = error instanceof McError ? error.hint : '';
    const code = error instanceof McError ? error.code : 'McError';
    const detail = { error: message, hint, code };
    return {
      content: [
        {
          type: 'text',
          text: `出了点问题，这一步没做成：\n${message}\n${hint ? `可以这样：${hint}\n` : ''}（错误码 ${code}）\n\n`
            + JSON.stringify(detail, null, 2),
        },
      ],
      structuredContent: { ok: false, ...detail },
      isError: true,
    };
  }
}
