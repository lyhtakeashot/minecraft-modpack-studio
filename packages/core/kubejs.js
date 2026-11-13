/**
 * KubeJS 脚本：离线沙箱 + 静态校验。
 *
 * 思路：KubeJS 的脚本本质是 JS，靠 `ServerEvents.recipes(event => ...)` 这类
 * 全局回调把「改动意图」交给游戏。我们不需要游戏，只要给这些全局名字套上
 * 记录用的 Proxy，脚本就能在 node:vm 里被**真的执行**一遍，把每次调用连同
 * 参数记录下来 —— 于是「这个脚本想删哪个配方、想加什么、引用了哪些物品 ID」
 * 就全成了可核对的事实。
 *
 * 不做的事：不模拟 KubeJS 的注册表、不真的改游戏。我们只回答两个问题：
 *   1. 这个脚本语法对不对、会不会一加载就抛错；
 *   2. 它引用的物品 ID / 配方 ID 在当前的包里存不存在。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/** 一个 ID 长这样：namespace:path（都不含空格、不以上划线开头）。 */
export const ID_RE = /^[a-z0-9_-]+:[a-z0-9_./-]+$/;

/** 已知是「配方」而不是「物品」的调用名。 */
const RECIPE_CALLS = new Set([
  'shaped', 'shapeless', 'smelting', 'blasting', 'smoking', 'campfire_cooking',
  'stonecutting', 'smithing', 'custom', 'mechanical_crafting',
]);

/** 第一个参数是「产物」的调用（其余参数是材料）。 */
const OUTPUT_FIRST = new Set([...RECIPE_CALLS, 'pressing', 'mixing', 'crushing', 'cutting',
  'filling', 'emptying', 'deploying', 'spouting', 'haunting', 'splashing', 'sandpaper_polishing',
  'sequenced_assembly', 'compacting', 'milling', 'basin']);

/**
 * 从一段物品表达式里抠出真正的 ID。
 * 处理 KubeJS 的几种写法：`2x create:cogwheel`、`minecraft:potion[foo={}]`、`#tag`。
 *
 * @param {string} text
 * @returns {string} 抠出来的 ID，抠不出来给空串
 */
export function idFromExpression(text) {
  if (typeof text !== 'string') return '';
  let s = text.trim();
  if (!s || s.startsWith('#')) return ''; // # 开头是标签，不是物品
  // 去掉数量前缀：KubeJS 里 "2x create:cogwheel" 和 "7xminecraft:ender_pearl"
  // 两种写法都有人用（中间那个空格是可以省的），所以 x 后面不强制要求空格。
  s = s.replace(/^\d+x\s*/i, '');
  const bracket = s.indexOf('[');
  if (bracket > 0) s = s.slice(0, bracket); // 去掉 [组件]
  return ID_RE.test(s) ? s : '';
}

/**
 * 有些参数长得像 ID 但其实不是物品，误报会让人白跑一趟。这里按「谁在用」排除。
 * 实测遇到的三种：属性名（`minecraft:generic.armor`）、战利品表
 * （`minecraft:chests/end_city_treasure`）、配方名（`foo:craft/bar`）。
 */
const NOT_ITEM_CALLS = new Set(['addAttribute', 'modifyAttribute', 'getLootTable', 'getLootTableId',
  'removeAttribute', 'lootTable', 'getAttribute', 'attributeModifier', 'addAttributeModifier']);

/** 属性名固定带个点，物品 ID 里不会有（`generic.armor` / `max_mana` 这种也在这个列表）。 */
const ATTRIBUTE_RE = /^(?:minecraft:)?(?:generic|player|zombie|horse)\.[a-z_]+$/;

function looksLikeAttribute(id) {
  return ATTRIBUTE_RE.test(id);
}

/**
 * 战利品表 ID 和物品 ID 长得几乎一样，区别在于「路径带斜杠，且第一段是这几类」。
 * 实测踩过：`event.create("touhou_little_maid:entities/fairy")` 是新建战利品表，
 * 当成物品就会报「这个包没有 touhou_little_maid:entities/fairy」的假警。
 */
const LOOT_PATH_RE = /^(?:chests|entities|gameplay|blocks|archaeology|equipment|pots|shearing|fishing|dispensers|spawners|cat_variant|villager|hero_of_the_village|ruined_portal|shipwreck|underwater_ruin|buried_treasure|woodland_mansion|stronghold|nether_bridge|bastion|ancient_city|trial_chambers|end_city|desert_pyramid|jungle_temple|igloo|monster_room|simple_dungeon|abandoned_mineshaft|pillager_outpost|ocean_ruin|swamp_hut)\//;

function looksLikeLootTable(id) {
  const slash = id.indexOf('/');
  if (slash < 0) return false;
  return LOOT_PATH_RE.test(id.slice(id.indexOf(':') + 1));
}

/** 把调用参数里所有像 ID 的字符串翻出来（深递归，含对象键）。 */
export function idsInValue(value, out = new Set()) {
  if (typeof value === 'string') {
    const id = idFromExpression(value);
    if (id) out.add(id);
  } else if (Array.isArray(value)) {
    for (const v of value) idsInValue(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const id = idFromExpression(k);
      if (id) out.add(id);
      idsInValue(v, out);
    }
  }
  return out;
}

/**
 * 记录型 Proxy：读属性得函数，调用就记一笔，返回还是它自己（支持链式）。
 * `then` / `toJSON` 必须返回 undefined，否则会被当成 Promise 乱 await。
 */
function recorder(calls, pathName) {
  const self = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then' || prop === 'toJSON' || prop === 'constructor' || prop === Symbol.toPrimitive) return undefined;
      if (typeof prop === 'symbol') return undefined;
      const next = `${pathName}.${String(prop)}`;
      return (...args) => {
        calls.push({ path: next, args });
        return self;
      };
    },
    apply(_t, _this, args) {
      calls.push({ path: pathName, args });
      return self;
    },
    // 让 `x instanceof recorderResult` 成立，脚本里大量 instanceof Java 类
    getPrototypeOf() { return Function.prototype; },
  });
  return self;
}

/**
 * 造一个沙箱上下文。
 *
 * @param {object} opts
 * @param {string} [opts.mcVersion] 让 Platform.getMinecraftVersion() 报对版本
 * @param {Array<{path: string, args: any[]}>} [opts.calls] 外部复用同一个调用表
 * @returns {{context: object, calls: Array}}
 */
export function createSandbox(opts = {}) {
  const calls = opts.calls ?? [];
  const mcVersion = opts.mcVersion ?? '1.21.1';
  const noop = () => {};

  // 每个事件总线都给一个 Proxy：既可以直接当函数用（onEvent 风格），
  // 也可以 get 到方法再调用。这样不管脚本用哪种写法都不会炸。
  const bus = (label) => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then' || prop === 'toJSON') return undefined;
      if (typeof prop === 'symbol') return undefined;
      return (...args) => {
        calls.push({ path: `${label}.${String(prop)}`, args });
        // 回调照跑，让它内部的调用也被记录下来
        for (const a of args) {
          if (typeof a === 'function') {
            try {
              a(recorder(calls, `${label}.${String(prop)}.callback`));
            } catch (e) {
              calls.push({ path: `ERROR:${e && e.message ? e.message : String(e)}`, args: [] });
            }
          }
        }
        return recorder(calls, `${label}.${String(prop)}.result`);
      };
    },
    apply(_t, _this, args) {
      calls.push({ path: label, args });
      return recorder(calls, `${label}.result`);
    },
  });

  // StartupEvents.registry('item', cb) 是「声明新物品」的入口，要单独记下来，
  // 因为这类 ID 在 jar 里根本不存在，属于「游戏启动后才有」的合法 ID。
  const registryBus = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then' || prop === 'toJSON' || typeof prop === 'symbol') return undefined;
      return (...args) => {
        calls.push({ path: `StartupEvents.registry.${String(prop)}`, args: [] });
        const cb = args.find((a) => typeof a === 'function');
        const kind = String(args[0] ?? prop);
        if (cb) {
          try {
            cb(recorder(calls, `registry.${kind}`));
          } catch (e) {
            calls.push({ path: `ERROR:${e && e.message ? e.message : String(e)}`, args: [] });
          }
        }
        return recorder(calls, `registry.${kind}.result`);
      };
    },
  });

  const javaClass = (name) => {
    calls.push({ path: `Java.loadClass(${String(name)})`, args: [name] });
    // 返回一个可被 instanceof 的函数
    return function JavaClass() {};
  };

  const sandbox = {
    ServerEvents: bus('ServerEvents'),
    StartupEvents: registryBus,
    ClientEvents: bus('ClientEvents'),
    LootJS: bus('LootJS'),
    ItemEvents: bus('ItemEvents'),
    BlockEvents: bus('BlockEvents'),
    EntityEvents: bus('EntityEvents'),
    PlayerEvents: bus('PlayerEvents'),
    LevelEvents: bus('LevelEvents'),
    FTBFilterSystemEvents: bus('FTBFilterSystemEvents'),
    FTBQuestsEvents: bus('FTBQuestsEvents'),
    NetworkEvents: bus('NetworkEvents'),
    onEvent: (...args) => {
      calls.push({ path: 'onEvent', args: [] });
      for (const a of args) if (typeof a === 'function') { try { a(recorder(calls, 'onEvent.callback')); } catch { /* 记过就算了 */ } }
    },
    Java: new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        return (...args) => {
          if (prop === 'loadClass') return javaClass(args[0]);
          calls.push({ path: `Java.${String(prop)}`, args });
          return function JavaThing() {};
        };
      },
      apply() { return function JavaThing() {}; },
    }),
    Utils: {
      id: (ns, p) => `${ns}:${p}`,
      isEmpty: (v) => !v,
      getModVersion: () => '1.0',
      getListFromString: (s) => String(s).split(','),
      snakeCase: (s) => String(s),
      toTitleCase: (s) => String(s),
    },
    Platform: {
      isClientEnvironment: () => false,
      isServerEnvironment: () => true,
      isDevelopmentEnvironment: () => false,
      getMinecraftVersion: () => mcVersion,
      getModVersion: () => '1.0',
      getModLoader: () => 'neoforge',
      isLoaded: () => true,
    },
    Item: {
      of: (...args) => {
        calls.push({ path: 'Item.of', args });
        return recorder(calls, 'Item.of.result');
      },
    },
    ItemStack: { of: () => recorder(calls, 'ItemStack') },
    Text: new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        return (...args) => {
          calls.push({ path: `Text.${String(prop)}`, args });
          return recorder(calls, `Text.${String(prop)}.result`);
        };
      },
    }),
    LootEntry: new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        return (...args) => {
          calls.push({ path: `LootEntry.${String(prop)}`, args });
          return recorder(calls, `LootEntry.${String(prop)}.result`);
        };
      },
    }),
    CuriosJSCapabilityBuilder: new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        return (...args) => {
          calls.push({ path: `CuriosJSCapabilityBuilder.${String(prop)}`, args });
          return recorder(calls, `CuriosJSCapabilityBuilder.${String(prop)}.result`);
        };
      },
    }),
    JsonIO: { write: noop, read: () => ({}), writeJson: noop },
    JsonObject: function JsonObject() {},
    fromObject: () => ({}),
    console: {
      log: (...a) => calls.push({ path: 'console.log', args: a }),
      info: (...a) => calls.push({ path: 'console.info', args: a }),
      warn: (...a) => calls.push({ path: 'console.warn', args: a }),
      error: (...a) => calls.push({ path: 'console.error', args: a }),
      debug: noop,
    },
    setTimeout: noop,
    setInterval: noop,
    clearTimeout: noop,
    clearInterval: noop,
  };
  sandbox.global = sandbox;
  sandbox.window = sandbox;

  return { context: vm.createContext(sandbox), calls };
}

/**
 * 跑一个脚本：先编译查语法，再在沙箱里执行。
 *
 * @param {string} source
 * @param {string} filename 报错时要显示的名字（一般给相对路径）
 * @param {object} [opts]
 * @param {string} [opts.mcVersion]
 * @param {number} [opts.timeoutMs] 默认 5000
 * @returns {{status: 'ok'|'syntax-error'|'runtime-error', error: string, line: number, calls: Array}}
 */
export function runScript(source, filename, opts = {}) {
  const { context, calls } = createSandbox({ mcVersion: opts.mcVersion });
  try {
    // vm.Script 只编译不执行，用来把「语法错」和「运行时错」分开
    new vm.Script(source, { filename });
  } catch (e) {
    return {
      status: 'syntax-error',
      error: `${e.name}: ${e.message}`,
      line: lineOf(e, filename),
      calls,
    };
  }
  try {
    vm.runInContext(source, context, { filename, timeout: opts.timeoutMs ?? 5000 });
  } catch (e) {
    const msg = `${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : String(e)}`;
    return { status: 'runtime-error', error: msg, line: lineOf(e, filename), calls };
  }
  return { status: 'ok', error: '', line: 0, calls };
}

/** 从异常栈里挖出脚本自己的行号（vm 的栈格式和文件不同，尽力而为）。 */
function lineOf(error, filename) {
  const stack = String(error && error.stack ? error.stack : '');
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = new RegExp(`${escaped}:(\\d+)`).exec(stack);
  return hit ? Number(hit[1]) : 0;
}

/** 扫出 kubejs 下所有脚本，按加载阶段分组。 */
export function collectScripts(kubejsDir, opts = {}) {
  const includeClient = opts.includeClient !== false;
  const groups = [
    ['startup', 'startup_scripts'],
    ['server', 'server_scripts'],
    ...(includeClient ? [['client', 'client_scripts']] : []),
  ];
  const out = [];
  for (const [stage, dirName] of groups) {
    const root = path.join(kubejsDir, dirName);
    if (!fs.existsSync(root)) continue;
    walk(root);
  }
  return out;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(js|ts)$/i.test(entry.name)) {
        const rel = `kubejs/${path.relative(kubejsDir, full).split(path.sep).join('/')}`;
        out.push({
          file: rel,
          abs: full,
          stage: rel.includes('startup_scripts') ? 'startup' : rel.includes('client_scripts') ? 'client' : 'server',
          size: (() => { try { return fs.statSync(full).size; } catch { return 0; } })(),
        });
      }
    }
  }
}

/**
 * 从调用表里抽出「声明的新 ID」（StartupEvents.registry('item'|'block', e => e.create('x'))）。
 * 这些 ID 是脚本自己造出来的，在 jar 索引里当然找不到，必须单独收。
 */
export function declaredIds(calls) {
  const out = new Set();
  for (const call of calls) {
    const m = /^registry\.([a-z_]+)\.create$/.exec(call.path);
    if (!m) continue;
    const raw = call.args[0];
    if (typeof raw !== 'string') continue;
    const id = raw.includes(':') ? raw : `kubejs:${raw}`;
    if (ID_RE.test(id)) out.add(id);
  }
  return out;
}

/** 声明调用里，只有这三类注册跟「物品」有关（fluid 本身不是物品，但游戏会自动派生一个桶）。 */
const ITEM_KINDS = new Set(['item', 'block', 'fluid']);

/**
 * 从「脚本现造物品」这个真相源里，把游戏启动后才注册出来的物品收齐。
 *
 * 为什么需要它：`packages/core/index.js` 只扫 mods/*.jar，脚本里
 * `StartupEvents.registry('item', e => e.create('x'))` 声明的 ID 在 jar 里根本不存在，
 * 于是网格对照游戏 ITEM 注册表就会「漏」掉这些。实测 Mechanomania 漏 20 个，
 * 其中 19 个是脚本现造（item 8 / block 7 / fluid 派生 4 个桶），另 1 个
 * （mob_weapon_api:laser_gatling）是 Java mod 运行时注册的，脚本方案补不到。
 *
 * 三条实测纪律（别凭印象改）：
 * 1. **只认 item / block / fluid 三种 kind**。`registry.fluid.create` 声明的是流体，
 *    不是物品；游戏会给每个流体自动派生一个 `${id}_bucket` 桶物品，脚本里没有
 *    显式 create，必须替它补上，否则 4 个桶还是漏。别的 kind 一律不算物品。
 * 2. **命名空间按脚本写的来**。脚本会显式写 `create('createages:xxx')` /
 *    `create('c6c:xxx')`，别自作主张全加 `kubejs:` 前缀（只有不带冒号的才补）。
 *    ID_RE 只认小写，别 toLowerCase。
 * 3. **中文名按三段键映射**。kubejs/assets 下每个命名空间的 lang 目录里
 *    （zh_cn.json / en_us.json）的 `item.<ns>.<name>` / `block.<ns>.<name>`
 *    第三段才是物品名，中文优先、英文兜底。
 *    注意键里的 ns 才是真命名空间（`kubejs/lang/zh_cn.json` 里就放着
 *    `item.c6c.utility_belt`），所以按**键**建 id，不按 lang 文件所在的目录名。
 *
 * @param {string} kubejsDir 实例的 kubejs 目录
 * @param {object} [opts]
 * @param {string} [opts.mcVersion] 让沙箱里的 Platform 报对版本
 * @param {boolean} [opts.includeClient]
 * @returns {{items: Array<{id:string,name:string,kind:string,file:string}>, namespaces: Set<string>}}
 */
export function scriptItems(kubejsDir, opts = {}) {
  const scripts = collectScripts(kubejsDir, { includeClient: opts.includeClient });
  const mcVersion = opts.mcVersion ?? '1.21.1';

  // 第一遍：真跑脚本，把 registry.<kind>.create 收成声明。
  // 顺带把紧跟着 create 的 .displayName('X') 当作英文兜底名记下（lang 文件没写时用）。
  const decls = [];
  for (const script of scripts) {
    let source;
    try { source = fs.readFileSync(script.abs, 'utf8'); } catch { continue; }
    const run = runScript(source, script.file, { mcVersion });
    let last = -1; // 最近一次 create 落在 decls 里的下标
    for (const call of run.calls) {
      const m = /^registry\.([a-z_]+)\.create$/.exec(call.path);
      if (m) {
        const kind = m[1];
        if (!ITEM_KINDS.has(kind)) continue;
        const raw = call.args[0];
        if (typeof raw !== 'string') continue;
        const base = raw.includes(':') ? raw : `kubejs:${raw}`;
        if (!ID_RE.test(base)) continue;
        if (kind === 'fluid') {
          // 流体本身不是物品，游戏自动派生桶；脚本里没有 create('..._bucket')。
          const bucket = `${base}_bucket`;
          if (ID_RE.test(bucket)) decls.push({ id: bucket, kind: 'item', file: script.file, displayName: '' });
        } else {
          decls.push({ id: base, kind, file: script.file, displayName: '' });
        }
        last = decls.length - 1;
        continue;
      }
      if (/^registry\.[a-z_]+\.displayName$/.test(call.path) && last >= 0) {
        const value = call.args[0];
        if (typeof value === 'string' && value.trim() && !decls[last].displayName) {
          decls[last].displayName = value.trim();
        }
      }
    }
  }

  // 第二遍：读 kubejs/assets/*/lang/{en_us,zh_cn}.json 的三段键，给每个 ID 配显示名。
  // 中文优先、英文兜底；脚本 .displayName() 再兜底；都没有就留空（界面显示 ID）。
  const names = new Map(); // id -> {zh, en}
  const assetsDir = path.join(kubejsDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    let nsDirs;
    try { nsDirs = fs.readdirSync(assetsDir, { withFileTypes: true }); } catch { nsDirs = []; }
    for (const nsEntry of nsDirs) {
      if (!nsEntry.isDirectory()) continue;
      const langDir = path.join(assetsDir, nsEntry.name, 'lang');
      for (const file of ['en_us.json', 'zh_cn.json']) {
        const full = path.join(langDir, file);
        if (!fs.existsSync(full)) continue;
        let json;
        try { json = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
        const isZh = file === 'zh_cn.json';
        for (const [key, value] of Object.entries(json)) {
          if (typeof value !== 'string' || !value.trim()) continue;
          const parts = key.split('.');
          if (parts.length !== 3) continue;
          const [kind, ns, name] = parts;
          if (kind !== 'item' && kind !== 'block') continue;
          if (!/^[a-z0-9_-]+$/.test(ns) || !/^[a-z0-9_]+$/.test(name)) continue;
          const id = `${ns}:${name}`;
          const slot = names.get(id) ?? { zh: '', en: '' };
          if (isZh) { if (!slot.zh) slot.zh = value.trim(); }
          else if (!slot.en) slot.en = value.trim();
          names.set(id, slot);
        }
      }
    }
  }

  const items = [];
  const namespaces = new Set();
  const seen = new Set();
  for (const d of decls) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const slot = names.get(d.id);
    const name = slot?.zh || slot?.en || d.displayName || '';
    items.push({ id: d.id, name, kind: d.kind, file: d.file });
    namespaces.add(d.id.split(':')[0]);
  }
  return { items, namespaces };
}

/**
 * 把调用表拆成「配方意图」和「引用的 ID」两部分。
 *
 * @param {Array<{path: string, args: any[]}>} calls
 * @returns {{removals: Array, recipes: Array, itemRefs: Set, recipeRefs: Set}}
 */
export function analyzeCalls(calls) {
  const removals = [];
  const recipes = [];
  const itemRefs = new Set();
  const recipeRefs = new Set();
  const lootTables = new Set();
  const attributes = new Set();
  const tags = new Set();

  /** 收一个「像 ID 的字符串」，但按当前上下文判断它到底是物品还是别的东西。 */
  const takeId = (raw, context) => {
    const id = idFromExpression(raw);
    if (!id) return;
    if (context === 'loot-table' || looksLikeLootTable(id)) { lootTables.add(id); return; }
    if (context === 'attribute' || looksLikeAttribute(id)) { attributes.add(id); return; }
    if (context === 'tag') { tags.add(id); return; }
    itemRefs.add(id);
  };
  const takeDeep = (value, context) => {
    for (const id of idsInValue(value)) takeId(id, context);
  };

  for (const call of calls) {
    const p = call.path;
    const args = call.args ?? [];
    const leaf = p.split('.').pop();

    // event.remove({id:'x'}) / event.remove({mod:'y'}) / event.remove({output:'z'})
    if (leaf === 'remove') {
      const filter = args[0];
      if (filter && typeof filter === 'object' && !Array.isArray(filter)) {
        const entry = { raw: filter };
        if (typeof filter.id === 'string') {
          entry.id = filter.id;
          recipeRefs.add(filter.id);
        }
        if (typeof filter.mod === 'string') entry.mod = filter.mod;
        if (typeof filter.type === 'string') entry.type = filter.type;
        if (filter.output !== undefined) {
          const ids = [...idsInValue(filter.output)];
          entry.output = ids;
          for (const id of ids) takeId(id, 'item');
        }
        removals.push(entry);
      } else if (typeof filter === 'string') {
        removals.push({ id: filter });
        recipeRefs.add(filter);
      }
      continue;
    }

    // .id('kubejs:foo') —— 给刚加的配方指定 ID
    if (leaf === 'id' && args.length === 1 && typeof args[0] === 'string' && args[0].includes(':')) {
      if (!args[0].startsWith('#') && ID_RE.test(args[0])) recipeRefs.add(args[0]);
      continue;
    }

    // ServerEvents.tags('item', event => { event.add('我的:标签', '物品') })
    // 第一个参数是**标签**不是物品。实测踩过：这行会被当成「引用了不存在的物品」，
    // 而那个标签正是这几行自己建出来的，白跑一趟。
    if (leaf === 'add' && /(^|\.)tags(\.|$)/.test(p)) {
      const [tag, ...items] = args;
      if (typeof tag === 'string') {
        const tagId = tag.startsWith('#') ? tag.slice(1) : tag;
        if (ID_RE.test(tagId)) tags.add(tagId);
      } else if (tag !== undefined) {
        for (const id of idsInValue(tag)) tags.add(id);
      }
      for (const item of items) takeDeep(item, 'item');
      continue;
    }

    // StartupEvents.registry(...).create(...) 已经在 declaredIds 里处理
    if (/^registry\./.test(p)) continue;

    // 战利品表 / 属性这类参数长得像 ID，其实不是物品，单独收
    if (leaf === 'getLootTable' || leaf === 'getLootTableId' || leaf === 'lootTable') {
      for (const arg of args) takeDeep(arg, 'loot-table');
      continue;
    }
    if (leaf === 'addAttribute' || leaf === 'modifyAttribute' || leaf === 'removeAttribute'
      || leaf === 'addAttributeModifier' || leaf === 'attributeModifier') {
      for (const arg of args) takeDeep(arg, 'attribute');
      continue;
    }

    // replaceInput / replaceOutput(filter, 旧, 新)：第一个参数是「找哪条配方」，
    // 里面的 id 是配方 ID 不是物品，后两个才是物品。
    if (leaf === 'replaceInput' || leaf === 'replaceOutput') {
      const filter = args[0];
      if (filter && typeof filter === 'object' && !Array.isArray(filter)) {
        const entry = { kind: leaf, filter };
        if (typeof filter.id === 'string') recipeRefs.add(filter.id);
        for (const id of idsInValue(filter.output ?? [])) entry.output = [...(entry.output ?? []), id];
        removals.push(entry);
      }
      for (let i = 1; i < args.length; i += 1) takeDeep(args[i], 'item');
      continue;
    }

    // 配方类调用：第一个参数是产物，其余是材料
    const isRecipe = p.startsWith('event.recipes.') || RECIPE_CALLS.has(leaf) || OUTPUT_FIRST.has(leaf);
    if (isRecipe) {
      // `event.recipes.create.pressing` 的 kind 取最后一段（pressing），
      // 前面那截是 mod 名，对「这是什么配方」没意义。
      const kind = leaf;
      const entry = { kind, path: p, output: '', inputs: [], extra: [] };
      if (typeof args[0] === 'string') entry.output = idFromExpression(args[0]);
      for (let i = 1; i < args.length; i += 1) {
        const ids = idsInValue(args[i]);
        for (const id of ids) {
          if (!ID_RE.test(id)) continue;
          entry.inputs.push(id);
          takeId(id, 'item');
        }
      }
      if (entry.output) takeId(entry.output, 'item');
      recipes.push(entry);
      continue;
    }

    // 其余调用（LootEntry.of / Item.of / replaceInput ...）参数里默认当物品
    for (const arg of args) takeDeep(arg, 'item');
  }

  return { removals, recipes, itemRefs, recipeRefs, lootTables, attributes, tags };
}

/**
 * 校验整个 kubejs 目录。
 *
 * @param {string} kubejsDir
 * @param {object} [opts]
 * @param {Set<string>|((id: string) => boolean)} [opts.knownItems] 已知存在的物品 ID
 * @param {Set<string>|((id: string) => boolean)} [opts.knownRecipes] 已知存在的配方 ID
 * @param {string} [opts.mcVersion]
 * @param {boolean} [opts.includeClient]
 * @returns {object}
 */
export function verifyScripts(kubejsDir, opts = {}) {
  const started = Date.now();
  const scripts = collectScripts(kubejsDir, { includeClient: opts.includeClient });
  if (!scripts.length) {
    return {
      ok: true, kubejsDir, scriptCount: 0, scripts: [], declared: [],
      missingItems: [], missingRecipes: [], breakdown: {}, elapsedMs: Date.now() - started, lines: [],
    };
  }
  const hasItems = typeof opts.knownItems === 'function' ? null : opts.knownItems;
  const hasItemsFn = typeof opts.knownItems === 'function' ? opts.knownItems : null;
  const hasRecipes = typeof opts.knownRecipes === 'function' ? null : opts.knownRecipes;
  const hasRecipesFn = typeof opts.knownRecipes === 'function' ? opts.knownRecipes : null;

  // 第一遍：只跑 startup 脚本，收「脚本自己声明的 ID」
  const declared = new Set();
  const runs = [];
  for (const script of scripts) {
    let source;
    try {
      source = fs.readFileSync(script.abs, 'utf8');
    } catch (e) {
      runs.push({ ...script, status: 'read-error', error: String(e && e.message ? e.message : e), line: 0, calls: [], itemRefs: new Set(), recipeRefs: new Set(), removals: [], recipes: [] });
      continue;
    }
    const result = runScript(source, script.file, { mcVersion: opts.mcVersion });
    if (script.stage === 'startup') for (const id of declaredIds(result.calls)) declared.add(id);
    runs.push({ ...script, ...result });
  }

  // 第二遍：把声明出来的 ID 也当作已知，再判断「缺不缺」
  const existsItem = (id) => {
    if (declared.has(id)) return true;
    if (hasItemsFn) return hasItemsFn(id);
    if (hasItems) return hasItems.has(id);
    return true; // 没给索引就不判
  };
  const existsRecipe = (id) => {
    if (hasRecipesFn) return hasRecipesFn(id);
    if (hasRecipes) return hasRecipes.has(id);
    return true;
  };

  const missingItems = [];
  const missingRecipes = [];
  const byModule = new Map();
  const breakdown = { ok: 0, 'syntax-error': 0, 'runtime-error': 0, 'read-error': 0 };
  const outScripts = [];

  for (const run of runs) {
    breakdown[run.status] = (breakdown[run.status] ?? 0) + 1;
    if (run.status !== 'ok') {
      outScripts.push({
        file: run.file, stage: run.stage, status: run.status, error: run.error, line: run.line,
        recipes: 0, removals: 0,
      });
      continue;
    }
    const analysis = analyzeCalls(run.calls);
    const missingItemHere = [...analysis.itemRefs].filter((id) => !existsItem(id));
    const missingRecipeHere = [...analysis.recipeRefs].filter((id) => !existsRecipe(id));
    for (const id of missingItemHere) missingItems.push({ id, file: run.file });
    for (const id of missingRecipeHere) missingRecipes.push({ id, file: run.file });

    // 按名字前缀猜模块，方便用户看「哪个 mod 的 ID 对不上」
    for (const id of missingItemHere) {
      const ns = id.split(':')[0];
      byModule.set(ns, (byModule.get(ns) ?? 0) + 1);
    }

    outScripts.push({
      file: run.file, stage: run.stage, status: run.status, error: '', line: 0,
      recipes: analysis.recipes.length, removals: analysis.removals.length,
      itemRefs: analysis.itemRefs.size, recipeRefs: analysis.recipeRefs.size,
      missingItems: missingItemHere.length, missingRecipes: missingRecipeHere.length,
    });
  }

  return {
    ok: true,
    kubejsDir,
    scriptCount: scripts.length,
    breakdown,
    declared: [...declared].sort(),
    missingItems,
    missingRecipes,
    byModule: [...byModule.entries()].sort((a, b) => b[1] - a[1]).map(([namespace, count]) => ({ namespace, count })),
    scripts: outScripts,
    elapsedMs: Date.now() - started,
  };
}

/** 把 verifyScripts 的结果写成给人看的中文清单。 */
export function describeVerify(report, limit = 15) {
  const lines = [];
  if (!report.scriptCount) {
    lines.push(`没找到 KubeJS 脚本（目录：${report.kubejsDir}）`);
    lines.push('提示：这个包可能没装 KubeJS，或者脚本不在 kubejs/ 下');
    return lines;
  }
  const b = report.breakdown;
  lines.push(`脚本 ${report.scriptCount} 个（启动 ${report.scripts.filter((s) => s.stage === 'startup').length} / 服务端 ${report.scripts.filter((s) => s.stage === 'server').length} / 客户端 ${report.scripts.filter((s) => s.stage === 'client').length}），用时 ${report.elapsedMs}ms`);
  lines.push(`能正常跑：${b.ok ?? 0} 个；语法错：${b['syntax-error'] ?? 0} 个；一跑就报错：${b['runtime-error'] ?? 0} 个`);

  const broken = report.scripts.filter((s) => s.status !== 'ok');
  if (broken.length) {
    lines.push('');
    lines.push('出问题的脚本：');
    for (const s of broken.slice(0, limit)) {
      lines.push(`  ${s.file}${s.line ? ` 第 ${s.line} 行` : ''}：${s.error}`);
    }
    if (broken.length > limit) lines.push(`  …… 还有 ${broken.length - limit} 个`);
  }

  if (report.declared.length) {
    lines.push('');
    lines.push(`脚本自己新建的 ID ${report.declared.length} 个（这些在 jar 里当然没有，属正常）：`);
    lines.push(`  ${report.declared.slice(0, limit).join('、')}${report.declared.length > limit ? ' ……' : ''}`);
  }

  if (report.missingItems.length) {
    lines.push('');
    lines.push(`引用了包不存在的物品 ${report.missingItems.length} 处：`);
    for (const m of report.missingItems.slice(0, limit)) lines.push(`  ${m.id}    ← ${m.file}`);
    if (report.missingItems.length > limit) lines.push(`  …… 还有 ${report.missingItems.length - limit} 处`);
    if (report.byModule.length) {
      lines.push(`  按命名空间：${report.byModule.slice(0, 8).map((m) => `${m.namespace}(${m.count})`).join('、')}`);
    }
  } else {
    lines.push('');
    lines.push('没有引用到不存在的物品 ID。');
  }

  if (report.missingRecipes.length) {
    lines.push('');
    lines.push(`要删的配方不存在 ${report.missingRecipes.length} 处（多半是配方 ID 写错了，或者那个 mod 没装）：`);
    for (const m of report.missingRecipes.slice(0, limit)) lines.push(`  ${m.id}    ← ${m.file}`);
    if (report.missingRecipes.length > limit) lines.push(`  …… 还有 ${report.missingRecipes.length - limit} 处`);
  }

  return lines;
}
