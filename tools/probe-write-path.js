/**
 * 探针 J：写路径验证（最关键的一步）。
 * 在真实整合包的**副本**上验证：
 *   1) 新建一个 FTB Quests 章节（新文件）+ 注册 chapter_group + 写 lang 中文
 *   2) 用 QuestStore 重新加载 + lint 确认无 error
 *   3) 生成一个 KubeJS 配方脚本，用真实 mods 索引校验引用的物品 ID 是否真实存在
 *
 * 用法：node tools/probe-write-path.js "<versions/<实例> 目录>" [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';

const instanceDir = process.argv[2];
if (!instanceDir) { console.error('用法: node tools/probe-write-path.js "<实例目录>"'); process.exit(1); }
const log = (...a) => console.log(...a);

// ── ZIP / 索引（与 probe-real-pack.js 同源，精简版） ──
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(off) !== 0x02014b50) break;
    const nl = buffer.readUInt16LE(off + 28), el = buffer.readUInt16LE(off + 30), cl = buffer.readUInt16LE(off + 32);
    entries.push({
      name: buffer.slice(off + 46, off + 46 + nl).toString('utf8'),
      method: buffer.readUInt16LE(off + 10),
      cs: buffer.readUInt32LE(off + 20),
      lo: buffer.readUInt32LE(off + 42),
    });
    off += 46 + nl + el + cl;
  }
  return entries;
}
function extract(buffer, e) {
  const o = e.lo, nl = buffer.readUInt16LE(o + 26), el = buffer.readUInt16LE(o + 28);
  const s = o + 30 + nl + el;
  const raw = buffer.slice(s, s + e.cs);
  return e.method === 0 ? raw : zlib.inflateRawSync(raw);
}
function indexJar(file) {
  const buf = fs.readFileSync(file);
  const entries = readZip(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const text = (n) => { const e = byName.get(n); return e ? extract(buf, e).toString('utf8') : null; };
  const items = new Set();
  for (const name of byName.keys()) {
    if (!/^assets\/[^/]+\/lang\/(en_us|zh_cn)\.json$/.test(name)) continue;
    let lang; try { lang = JSON.parse(text(name)); } catch { continue; }
    for (const k of Object.keys(lang)) {
      const m = /^(item|block)\.([a-z0-9_.-]+)\.([a-z0-9_./-]+)$/i.exec(k);
      if (m && !m[3].includes('.')) items.add(`${m[2]}:${m[3]}`);
    }
  }
  for (const name of byName.keys()) {
    const m = /^assets\/([^/]+)\/models\/item\/(.+)\.json$/.exec(name);
    if (m) items.add(`${m[1]}:${m[2]}`);
  }
  for (const name of byName.keys()) {
    // 1.20.1 用 data/<ns>/recipes/，1.21.1 用 data/<ns>/recipe/ —— 两个都要认
    if (!/^data\/[^/]+\/(?:recipes|recipe)\/.+\.json$/.test(name)) continue;
    let r; try { r = JSON.parse(text(name)); } catch { continue; }
    const push = (v) => {
      if (typeof v === 'string') items.add(v);
      else if (v && typeof v === 'object') { if (typeof v.item === 'string') items.add(v.item); else if (typeof v.id === 'string') items.add(v.id); }
    };
    push(r?.result);
    if (Array.isArray(r?.results)) r.results.forEach(push);
  }
  return items;
}

// ── FTB Quests：最小 SNBT 序列化（tab 缩进、无逗号、0.0d） ──
function toSnbt(value, indent = '') {
  const tab = '\t';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = value.map((v) => toSnbt(v, indent + tab)).join('\n');
    return `[\n${inner}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const lines = Object.entries(value).map(([k, v]) => `${indent}${tab}${k}: ${toSnbt(v, indent + tab)}`);
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `${value}.0d` : `${value}d`;
  }
  return JSON.stringify(String(value));
}

// ── KubeJS：沙箱 + ID 采集 ──
function runKubejs(source, filename) {
  const calls = [];
  const chain = (p) => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then' || prop === 'toJSON') return undefined;
      const np = `${p}.${String(prop)}`;
      return (...args) => { calls.push({ path: np, args }); return chain(np); };
    },
    apply() { return chain(p); },
  });
  const event = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'recipes') {
        return new Proxy(function () {}, {
          get(_t2, p2) {
            const np = `event.recipes.${String(p2)}`;
            return new Proxy(function () {}, {
              get(_t3, p3) { const n2 = `${np}.${String(p3)}`; return (...a) => { calls.push({ path: n2, args: a }); return chain(n2); }; },
              apply(_t3, _x, a) { calls.push({ path: np, args: a }); return chain(np); },
            });
          },
        });
      }
      const np = `event.${String(prop)}`;
      return (...args) => { calls.push({ path: np, args }); return chain(np); };
    },
  });
  const sandbox = {
    ServerEvents: new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        return (cb) => { calls.push({ path: `ServerEvents.${String(prop)}`, args: [] }); cb(event); };
      },
    }),
    StartupEvents: { registry: (cb) => cb(event) },
    ClientEvents: { init() {} },
    console: { log() {}, warn() {}, error() {}, info() {} },
    Platform: { isClientEnvironment: () => false, isServerEnvironment: () => true },
    Utils: { id: (ns, p) => `${ns}:${p}`, isEmpty: (v) => !v },
    Item: { of: (id) => ({ id }) },
    Ingredient: { of: (v) => v },
  };
  sandbox.global = sandbox;
  try { new vm.Script(source, { filename }); }
  catch (e) { return { status: 'syntax-error', error: `${e.name}: ${e.message}` }; }
  const ctx = vm.createContext(sandbox);
  try { vm.runInContext(source, ctx, { filename, timeout: 5000 }); }
  catch (e) { return { status: 'runtime-error', error: `${e.name}: ${e.message}`, calls }; }
  return { status: 'ok', calls };
}
function harvestIds(calls) {
  const ids = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = /^(?:\d+x )?([a-z0-9_.-]+:[a-z0-9_./-]+)$/.exec(v);
      if (m) ids.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { walk(k); walk(val); }
  };
  for (const c of calls) walk(c.args);
  return ids;
}

// ═════════════════════════ 主流程 ═════════════════════════
log(`\n### 写路径验证：${instanceDir}\n`);

// 1. 建物品 ID 全集（mods + 原版 jar）
const modsDir = path.join(instanceDir, 'mods');
const t0 = Date.now();
const allItems = new Set();
const jars = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar'));
for (const f of jars) { try { for (const id of indexJar(path.join(modsDir, f))) allItems.add(id); } catch {} }
// 原版 jar（版本目录下的 <实例名>.jar）
const vanillaJar = fs.readdirSync(instanceDir).find((f) => f.toLowerCase().endsWith('.jar'));
let vanillaCount = 0;
if (vanillaJar) {
  const before = allItems.size;
  for (const id of indexJar(path.join(instanceDir, vanillaJar))) allItems.add(id);
  vanillaCount = allItems.size - before;
}
log(`1) 物品 ID 全集：${allItems.size}（mods ${jars.length} 个 jar + 原版 jar 贡献 ${vanillaCount}），耗时 ${Date.now() - t0}ms`);

// 2. 复制 ftbquests 到临时目录，做写入实验
const questDir = path.join(instanceDir, 'config', 'ftbquests', 'quests');
if (!fs.existsSync(questDir)) { log('   [跳过 FTB] 无 config/ftbquests/quests'); process.exit(0); }
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-write-'));
const tmpQuests = path.join(tmpRoot, 'quests');
fs.cpSync(questDir, tmpQuests, { recursive: true });
log(`2) 副本目录：${tmpQuests}`);

const { QuestStore, } = await import('file://' + path.join(process.cwd(), 'probe', 'ftbqp', 'server', 'store.mjs').replace(/\\/g, '/'));
const { lintStore, } = await import('file://' + path.join(process.cwd(), 'probe', 'ftbqp', 'server', 'lint.mjs').replace(/\\/g, '/'));

const before = await QuestStore.load({ questDir: tmpQuests, locale: 'zh_cn' });
const beforeQuests = before.questsById.size;
log(`   写入前：章节 ${before.chapters.length}，任务 ${beforeQuests}`);

// 2a. 新建章节文件
const CH_ID = 'dshsmoke';
const CHAPTER_ID = '5D5A0001';
const chapter = {
  id: CHAPTER_ID,
  group: '',
  icon: 'create:cogwheel',
  default_quest_shape: 'hexagon',
  default_quest_size: 1.0,
  images: [],
  quests: [
    {
      id: '5D5A0010',
      title: '第一台大齿轮',
      icon: 'create:cogwheel',
      x: 0.0,
      y: 0.0,
      tasks: [{ id: '5D5A0011', type: 'item', item: 'create:cogwheel', count: 1 }],
      rewards: [],
    },
    {
      id: '5D5A0012',
      title: '安山岩合金',
      icon: 'create:andesite_alloy',
      x: 1.0,
      y: 0.0,
      dependencies: ['5D5A0010'],
      tasks: [{ id: '5D5A0013', type: 'item', item: 'create:andesite_alloy', count: 1 }],
      rewards: [],
    },
  ],
};

// 章节文件名要点：lint 会检查 chapter-filename-mismatch —— 用 id 小写作为文件名
const chapterFile = path.join(tmpQuests, 'chapters', `${CH_ID}.snbt`);
fs.writeFileSync(chapterFile, toSnbt(chapter) + '\n', 'utf8');
log(`   写出章节：chapters/${CH_ID}.snbt  id=${CHAPTER_ID}（注意：文件名与 id 不一致会触发 lint）`);

// 2b. 注册 chapter_group
const groupFile = path.join(tmpQuests, 'chapter_groups.snbt');
let groupText = fs.existsSync(groupFile) ? fs.readFileSync(groupFile, 'utf8') : '{\n\tchapter_groups: []\n}\n';
const GROUPS = [{ id: '5D5AGROUP0', title: 'DSH 冒烟测试组' }];
// 最小侵入：直接重写 chapter_groups.snbt（该文件很小，且 FTB 容忍重排）
const groups = JSON.parse(JSON.stringify(GROUPS));
fs.writeFileSync(groupFile, toSnbt({ chapter_groups: groups }) + '\n', 'utf8');
log(`   chapter_groups.snbt 写入 1 个分组`);

// 2c. 写 lang 中文
const langDir = path.join(tmpQuests, 'lang', 'zh_cn');
fs.mkdirSync(langDir, { recursive: true });
const langFile = path.join(langDir, CH_ID + '.snbt');
const lang = {
  [`chapter.${CHAPTER_ID}.title`]: 'DSH 冒烟测试',
  [`chapter_group.5D5AGROUP0.title`]: 'DSH 冒烟测试组',
  'quest.5D5A0010.title': '第一台大齿轮',
  'quest.5D5A0010.quest_subtitle': '用安山岩合金做出齿轮',
  'quest.5D5A0012.title': '安山岩合金',
};
fs.writeFileSync(langFile, toSnbt(lang) + '\n', 'utf8');
log(`   lang/zh_cn/${CH_ID}.snbt 写入 ${Object.keys(lang).length} 个键`);

// 3. 重新加载 + lint
const after = await QuestStore.load({ questDir: tmpQuests, locale: 'zh_cn' });
log(`3) 重新加载：章节 ${after.chapters.length}（+${after.chapters.length - before.chapters.length}），任务 ${after.questsById.size}（+${after.questsById.size - beforeQuests}）`);
const ch = after.chapters.find((c) => c.id === CHAPTER_ID || String(c.raw?.id).toLowerCase() === CH_ID);
log(`   新章节命中：${ch ? '✓ ' + (ch.title ?? '(no title)') : '✗ 未命中'}`);
const q1 = after.questsById.get('5D5A0010');
log(`   新任务命中：${q1 ? '✓ ' + (q1.title ?? '(no title)') + ' / 依赖数 ' + (q1.dependencies?.length ?? 0) : '✗ 未命中'}`);

const issues = lintStore(after);
const arr = Array.isArray(issues) ? issues : [];
const errors = arr.filter((i) => i.severity === 'error');
log(`   lint：共 ${arr.length} 条，error ${errors.length} 条`);
for (const i of arr.slice(0, 10)) log(`     [${i.severity}] ${i.code}: ${i.message}`);
if (errors.length === 0) log('   → ✓ 新增章节通过 lint（无 error）');

// 4. KubeJS 生成 + ID 核对
log(`\n4) KubeJS 生成 + 物品 ID 核对`);
const kubejs = `
ServerEvents.recipes(event => {
  // 魔改：把齿轮改成需要安山岩合金围一圈
  event.remove({ id: 'create:crafting/kinetics/cogwheel' })
  event.shaped('create:cogwheel', [
    'ABA',
    'BCB',
    'ABA'
  ], {
    A: 'create:andesite_alloy',
    B: 'minecraft:stick',
    C: 'create:shaft'
  })
})
`;
// 故意加一个不存在的物品做对照
const badKubejs = kubejs.replace("C: 'create:shaft'", "C: 'create:not_a_real_item_xyz'");

for (const [label, src] of [['正确脚本', kubejs], ['含假 ID 的脚本', badKubejs]]) {
  const r = runKubejs(src, `${label}.js`);
  log(`   ${label}: ${r.status}${r.error ? ' :: ' + r.error : ''}`);
  if (r.status === 'ok') {
    const refs = harvestIds(r.calls);
    const unknown = [...refs].filter((id) => !allItems.has(id));
    log(`     引用 ${refs.size} 个 ID，其中未存在于本包 ${unknown.length} 个：${unknown.join(', ') || '（无）'}`);
    log(`     → ${unknown.length === 0 ? '✓ 全部真实存在' : '✗ 拦截到假 ID'}`);
  }
}

if (!process.argv.includes('--keep')) fs.rmSync(tmpRoot, { recursive: true, force: true });
else log(`\n（保留临时目录：${tmpRoot}）`);
log('\n=== 完 ===\n');
