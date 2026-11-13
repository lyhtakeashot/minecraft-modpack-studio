/**
 * 从零建一个整合包 —— 拼装式。
 *
 * 为什么是「拼装」而不是「下载」：一个能启动的实例 = 原版 jar + 加载器那一堆
 * libraries + assets + 一份版本 json。真正难搞的是 libraries/assets（几百兆、
 * 上百个文件、还带 hash 校验），而这台机器上已经有装好的同版本实例，直接借它的
 * 目录结构和仓库就是最稳的路子：
 *
 *   - 新的版本 json：抄模板的，只把 id 改成新包名；
 *   - 新的客户端 jar：抄模板的那份（重名文件，不共享，免得一个删了另一个坏）；
 *   - mods/、config/、kubejs/：新建空的，mod 交给联网层一个个装；
 *   - 任务书：建一本空书（data.snbt + chapter_groups.snbt + chapters/），
 *     章节和任务再往里加。
 *
 * 底线：这里只往「新目录」里写，一个字都不碰模板包。目标目录已存在且非空就报错，
 * 绝不覆盖别人的包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { McError } from './errors.js';
import { resolveInstance } from './instance.js';

/** 包名上限。太长启动器列表里显示不下，而且 PCL 的路径处理也会出问题。 */
export const PACK_NAME_MAX = 48;

/** Windows 上不能出现在文件名里的字符。 */
const ILLEGAL_NAME = /[\\/:*?"<>|]/;

/** Windows 保留设备名，拿来当目录名会创建失败。 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * 任务书数据的版本号。
 *
 * 这个数不是我们说了算，是 FTB Quests 自己写进 data.snbt 的：1.21.1 那一代是 13。
 * 写高了老版本会提示「数据来自更新的版本」，写低了会被自动迁移 —— 都能读，
 * 但既然是 1.21.1 为准，就跟它对齐。
 */
export const QUEST_DATA_VERSION = 13;

/** 新包里要有的空目录。缺了游戏会自己建，但提前建好面板就能直接往里放东西。 */
export const PACK_DIRS = [
  'mods',
  'config',
  'kubejs/server_scripts',
  'kubejs/client_scripts',
  'kubejs/startup_scripts',
  'kubejs/assets',
  'kubejs/data',
  'logs',
  'saves',
  'resourcepacks',
  'shaderpacks',
  'config/ftbquests/quests/chapters',
  'config/ftbquests/quests/lang',
];

/** 校验包名。返回 {ok, error}；ok 为 true 时 name 是修剪过的名字。 */
export function validatePackName(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return { ok: false, error: '包名不能是空的' };
  if (clean.length > PACK_NAME_MAX) return { ok: false, error: `包名最多 ${PACK_NAME_MAX} 个字符（现在是 ${clean.length} 个）` };
  if (ILLEGAL_NAME.test(clean)) return { ok: false, error: '包名里不能有 \\ / : * ? " < > | 这些字符' };
  if (clean === '.' || clean === '..') return { ok: false, error: '包名不能是 . 或 ..' };
  if (/[. ]$/.test(clean)) return { ok: false, error: '包名结尾不能是空格或点（Windows 会当成非法名字）' };
  if (RESERVED_NAMES.has(clean.toLowerCase())) return { ok: false, error: `「${clean}」是 Windows 的保留名字，换一个` };
  return { ok: true, name: clean };
}

/**
 * 空任务书必备的三个文件。
 *
 * 只有 data.snbt 和 chapter_groups.snbt 是「书」本身，chapters/ 是空章节目录。
 * 不预置章节：新包里第一页该叫什么，用户自己决定；预置一个「第一章」反而像垃圾。
 */
export function emptyQuestBook() {
  return {
    'config/ftbquests/quests/data.snbt': [
      '{',
      '\tdefault_quest_shape: "circle"',
      '\tdefault_consume_items: false',
      '\tdisable_gui: false',
      '\tdrop_book_on_death: false',
      '\tgrid_scale: 0.5d',
      '\tlock_message: ""',
      '\tpause_game: false',
      '\tprogression_mode: "flexible"',
      `\tversion: ${QUEST_DATA_VERSION}`,
      '}',
      '',
    ].join('\n'),
    'config/ftbquests/quests/chapter_groups.snbt': [
      '{',
      '\tchapter_groups: [',
      '\t]',
      '}',
      '',
    ].join('\n'),
    // 语言文件也要有，哪怕先空着。FTB 自己第一次保存时才生成，
    // 但我们「从零加章节」是要往里写标题的，没有这个文件就没地方落。
    'config/ftbquests/quests/lang/en_us.snbt': '{\n}\n',
  };
}

/**
 * 算一份建包计划：要建哪些目录、抄哪个文件、写哪些内容。不写盘。
 *
 * @param {object} opts
 * @param {string} opts.mcRoot  Minecraft 根目录（含 versions/ 和 libraries/）
 * @param {string} opts.name    新包名
 * @param {string} opts.templateDir 拿来当模板的实例目录（versions/<id>）
 * @param {string} [opts.templateId] 模板目录里有多个实例时用来精确指定
 * @param {boolean} [opts.withQuestBook] 是否建空任务书（默认 true）
 * @param {boolean} [opts.withKubejs] 是否建 kubejs 目录（默认 true）
 */
export function buildPackPlan(opts = {}) {
  const checked = validatePackName(opts.name);
  if (!checked.ok) throw new McError(`包名不能用：${checked.error}`, '换一个名字再试', 'McBadPackName');
  const name = checked.name;

  const mcRoot = path.resolve(String(opts.mcRoot ?? '').trim() || '.');
  if (!String(opts.mcRoot ?? '').trim()) {
    throw new McError('没给 Minecraft 根目录', '传一个已经装过整合包的根目录（里面有 versions/ 和 libraries/）', 'McBadArgs');
  }
  if (!fs.existsSync(mcRoot)) throw new McError(`目录不存在：${mcRoot}`, '传 Minecraft 根目录（里面要有 versions/ 和 libraries/）');
  if (!fs.existsSync(path.join(mcRoot, 'libraries'))) {
    throw new McError(
      `${mcRoot} 下没有 libraries/，在这建包启动不了`,
      '要选一个已经装过整合包的 Minecraft 根目录（这样加载器需要的库都在），比如 D:\\pcl2\\...\\Minecraft',
    );
  }

  const template = resolveInstance(opts.templateDir, opts.templateId ?? '');
  if (path.resolve(template.mcRoot).toLowerCase() !== mcRoot.toLowerCase()) {
    throw new McError(
      `模板包不在这个根目录下：模板在 ${template.mcRoot}，要建包的根目录是 ${mcRoot}`,
      '新包只能建在模板包所在的 Minecraft 根目录里，这样它要的 libraries 和 assets 才都在',
    );
  }
  if (!template.clientJar) {
    throw new McError(`模板包 ${template.id} 里没有客户端 jar`, '换一个能正常启动的实例当模板', 'McNoClientJar');
  }

  const versionsDir = path.join(mcRoot, 'versions');
  const targetDir = path.join(versionsDir, name);
  if (name.toLowerCase() === String(template.id).toLowerCase()) {
    throw new McError(`新包不能和模板同名（都是 ${name}）`, '换个名字；模板包要留着当底子');
  }
  if (fs.existsSync(targetDir)) {
    const entries = fs.readdirSync(targetDir);
    if (entries.length > 0) {
      throw new McError(
        `${targetDir} 已经存在而且里面还有东西（${entries.length} 项）`,
        '换个包名；这里不会覆盖已有的包',
        'McPackExists',
      );
    }
  }

  const jsonFile = `${name}.json`;
  const jarFile = `${name}.jar`;
  const questBook = opts.withQuestBook === false ? {} : emptyQuestBook();
  const dirs = (opts.withKubejs === false ? PACK_DIRS.filter((d) => !d.startsWith('kubejs/')) : PACK_DIRS).slice();

  // 任务书目录也归 withQuestBook 管：不建书就不该留空的 ftbquests 目录
  const finalDirs = opts.withQuestBook === false
    ? dirs.filter((d) => !d.startsWith('config/ftbquests/'))
    : dirs;

  const files = [];
  files.push({
    rel: jsonFile,
    kind: 'version-json',
    from: template.versionJsonFile,
    bytes: safeSize(template.versionJsonFile),
    note: `抄模板 ${template.id} 的版本 json，把 id 改成 ${name}`,
  });
  files.push({
    rel: jarFile,
    kind: 'client-jar',
    from: template.clientJar,
    bytes: safeSize(template.clientJar),
    note: `抄模板的客户端 jar（${(safeSize(template.clientJar) / 1048576).toFixed(1)} MB）`,
  });
  for (const [rel, content] of Object.entries(questBook)) {
    files.push({ rel, kind: 'quest', bytes: Buffer.byteLength(content, 'utf8'), note: '空任务书' });
  }

  const totalBytes = files.reduce((sum, f) => sum + (f.bytes || 0), 0);

  return {
    ok: true,
    name,
    mcRoot,
    versionsDir,
    targetDir,
    exists: fs.existsSync(targetDir) ? 'empty-dir' : 'no',
    template: {
      id: template.id,
      dir: template.instanceDir,
      mcVersion: template.mcVersion,
      loader: template.loader,
      loaderVersion: template.loaderVersion,
      modsCount: template.modsCount,
    },
    dirs: finalDirs,
    files,
    questBook: Object.keys(questBook).length > 0,
    kubejs: opts.withKubejs !== false,
    totalBytes,
    warnings: buildWarnings(template),
  };
}

/** 计划里的提醒：不致命，但用户最好知道。 */
function buildWarnings(template) {
  const warnings = [];
  if (!template.loader) {
    warnings.push('模板包没识别出加载器（可能是原版实例）；新包也会是原版，想装 mod 得换成带加载器的模板。');
  }
  if (template.modsCount === 0) {
    warnings.push('模板里一个 mod 都没有，新包会是纯原版 + 加载器，能启动但没有 mod。');
  }
  return warnings;
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 把计划落到磁盘。返回建成了什么、跳过了什么。 */
export function applyPackPlan(plan) {
  if (!plan || plan.ok === false) throw new McError('计划无效，不能写盘', '先算一次计划再确认');

  const created = { dirs: [], files: [] };
  if (fs.existsSync(plan.targetDir)) {
    const entries = fs.readdirSync(plan.targetDir);
    if (entries.length > 0) {
      throw new McError(`${plan.targetDir} 不为空，拒绝覆盖`, '换个包名', 'McPackExists');
    }
  }
  fs.mkdirSync(plan.targetDir, { recursive: true });

  for (const rel of plan.dirs) {
    const dir = path.join(plan.targetDir, rel);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.dirs.push(rel);
    }
  }

  const quest = emptyQuestBook();
  for (const file of plan.files) {
    const dest = resolveInside(plan.targetDir, file.rel);
    if (file.kind === 'version-json') {
      const raw = JSON.parse(fs.readFileSync(file.from, 'utf8'));
      raw.id = plan.name;
      fs.writeFileSync(dest, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    } else if (file.kind === 'client-jar') {
      fs.copyFileSync(file.from, dest);
    } else if (file.kind === 'quest') {
      fs.writeFileSync(dest, quest[file.rel] ?? '', 'utf8');
    } else {
      throw new McError(`不认识的计划项目：${file.kind}`, '', 'McBadPlanItem');
    }
    created.files.push(file.rel);
  }

  return { ok: true, targetDir: plan.targetDir, created };
}

/** 把相对路径钉在实例目录里面，别让计划里的路径跑出去。 */
function resolveInside(base, rel) {
  const abs = path.resolve(base, rel);
  const root = path.resolve(base);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new McError(`计划里的路径跑到实例外面了：${rel}`, '', 'McPathEscape');
  }
  return abs;
}

/** 给人看的一段话。 */
export function describePackPlan(plan) {
  const lines = [];
  lines.push(`准备在 ${plan.versionsDir} 里新建整合包 ${plan.name}`);
  lines.push(`  底子：${plan.template.id}（${plan.template.mcVersion} · ${plan.template.loader || '原版'} ${plan.template.loaderVersion || ''}）`.trimEnd());
  lines.push(`  要建 ${plan.dirs.length} 个目录、${plan.files.length} 个文件，合计 ${(plan.totalBytes / 1048576).toFixed(1)} MB`);
  if (plan.template.modsCount === 0) lines.push('  注意：模板里没有 mod，新包启动后是纯原版。');
  for (const w of plan.warnings) lines.push(`  注意：${w}`);
  lines.push('确认后才会真写盘；模板包一个字都不会动。');
  return lines;
}

/** 写完之后的一段话。 */
export function describePackResult(result, plan) {
  return [
    `建好了：${result.targetDir}`,
    `  目录 ${result.created.dirs.length} 个，文件 ${result.created.files.length} 个`,
    '下一步可以从两件里挑一件：',
    '  ① 装 mod：搜索 Create / JEI 这些，勾上再算清单，确认后下进 mods/',
    '  ② 直接启动：让启动器加载这个实例，能进主菜单就说明骨架没问题',
    plan.questBook ? '  任务书已经是空书了，可以在面板里加章节和任务。' : '',
  ].filter(Boolean);
}