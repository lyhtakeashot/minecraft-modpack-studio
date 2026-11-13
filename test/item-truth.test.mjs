/**
 * 「游戏真值清单」的单测（2026-11-07 任务③）。
 *
 * 这层的硬规矩：清单**只写软件自己的数据目录**（MCSTUDIO_DATA_DIR），
 * 绝不写进用户的整合包；没导入过就一律返回 null（网格退回「显示全部」）。
 * 所以每条用例都把 MCSTUDIO_DATA_DIR 指到临时目录，用完还原。
 *
 * 这里测的是 lib/host/item-truth.js 的纯逻辑；「导入后 /item-grid 真的少掉
 * 那些假条目」放在 test/host-api.test.mjs 里走完整 Request→Response 链路。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearTruthCache,
  handleItemTruthImport,
  handleItemTruthStatus,
  importTruth,
  statusOf,
  truthInfoOf,
  truthSetOf,
} from '../lib/host/item-truth.js';
import { resolveInstance } from '../packages/core/instance.js';

/** 造一个能被 resolveInstance 认出来的最小假实例目录。 */
function fakeInstance() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-truth-'));
  const dir = path.join(root, 'versions', 'DemoPack');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'DemoPack.json'),
    JSON.stringify({ id: 'DemoPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
    'utf8',
  );
  return { root, dir };
}

/** 造一份「游戏探针 mod 导出的 jeidump.json」。 */
function dump(file, ids) {
  fs.writeFileSync(file, JSON.stringify({ config: {}, registries: { item: ids, block: [] }, types: [] }), 'utf8');
}

/** 每条用例：临时数据目录 + 清内存缓存，finally 全还原，绝不碰真实 .mcstudio/。 */
function withStore(fn) {
  return async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-truth-store-'));
    const prev = process.env.MCSTUDIO_DATA_DIR;
    try {
      process.env.MCSTUDIO_DATA_DIR = store;
      clearTruthCache();
      await fn(store);
    } finally {
      clearTruthCache();
      if (prev === undefined) delete process.env.MCSTUDIO_DATA_DIR;
      else process.env.MCSTUDIO_DATA_DIR = prev;
    }
  };
}

/** 直接造一个能喂给 readParams 的 Request：POST 带 JSON body、GET 带查询串。 */
function req(suffix, payload = {}, method = 'POST') {
  const qs = method === 'POST' ? '' : new URLSearchParams(payload).toString();
  return new Request(`http://localhost${suffix}${qs ? `?${qs}` : ''}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
  });
}

test('没导入过清单：statusOf 说没有、truthSetOf 返回 null（网格退回显示全部）', withStore(async () => {
  const { dir } = fakeInstance();
  assert.deepEqual(statusOf(dir, 'DemoPack'), { has: false, source: '', count: 0 });
  const inst = resolveInstance(dir, 'DemoPack');
  assert.equal(truthInfoOf(inst), null);
  assert.equal(truthSetOf(inst), null);
}));

test('导入 jeidump.json：解析 registries.item、去重、只写软件数据目录', withStore(async (store) => {
  const { root, dir } = fakeInstance();
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const file = path.join(gameDir, 'jeidump.json');
  dump(file, ['minecraft:stone', 'demo:thing_1', 'minecraft:stone', '  demo:thing_2  ', '']);

  const out = importTruth({ dir, id: 'DemoPack', file });
  assert.equal(out.has, true);
  assert.equal(out.count, 3, '去重后应只剩 3 条（空串也要剔掉）');
  assert.equal(out.source, file);

  // 清单只落在软件自己的数据目录，绝不写进整合包。
  assert.ok(fs.existsSync(path.join(store, 'item-truth.json')), '软件数据目录里没有 item-truth.json');
  assert.equal(fs.existsSync(path.join(dir, 'item-truth.json')), false, '不该往整合包目录写清单');
  assert.equal(fs.existsSync(path.join(gameDir, 'item-truth.json')), false);
  const saved = JSON.parse(fs.readFileSync(path.join(store, 'item-truth.json'), 'utf8'));
  assert.equal(Object.keys(saved).length, 1, '按 dir|id 分键只该有一份');

  const info = truthInfoOf(resolveInstance(dir, 'DemoPack'));
  assert.ok(info, '导入后读不到清单');
  assert.deepEqual([...info.set].sort(), ['demo:thing_1', 'demo:thing_2', 'minecraft:stone']);
  assert.equal(info.count, 3);
  assert.equal(info.source, file);
  assert.deepEqual([...truthSetOf(resolveInstance(dir, 'DemoPack'))].length, 3);
  assert.deepEqual(statusOf(dir, 'DemoPack'), { has: true, source: file, count: 3 });
}));

test('选文件夹也能导入：file 传目录时自动拼 jeidump.json（界面走选文件夹对话框）', withStore(async () => {
  const { root, dir } = fakeInstance();
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  dump(path.join(gameDir, 'jeidump.json'), ['minecraft:dirt']);

  const out = importTruth({ dir, id: '', file: gameDir }); // 界面 instanceId 可能是空串
  assert.equal(out.count, 1);
  assert.ok(out.source.endsWith('jeidump.json'));
  // 空 id 导入后，用真实 id 也该读得到（normalize 要补 resolveInstance）。
  assert.equal(statusOf(dir, 'DemoPack').has, true);
  assert.equal(truthSetOf(resolveInstance(dir, '')).size, 1);
}));

test('界面传启动器根目录、网格用解析后的实例目录：两边落在同一个键', withStore(async () => {
  const { root, dir } = fakeInstance();
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  dump(path.join(gameDir, 'jeidump.json'), ['minecraft:stone']);

  // 界面可能拿 <root> 当 dir 传（选目录时连的是启动器根）。
  importTruth({ dir: root, id: '', file: gameDir });
  // 网格侧 truthInfoOf() 用的是 resolveInstance 后的 instanceDir（<root>/versions/DemoPack）。
  const inst = resolveInstance(root, '');
  assert.equal(truthSetOf(inst)?.has('minecraft:stone'), true, 'dir 归一没对齐，导入写键和网格读键对不上');
  assert.equal(statusOf(dir, 'DemoPack').has, true);
}));

test('按 dir|id 分键：两个不同的包互不串清单', withStore(async () => {
  const a = fakeInstance();
  const b = fakeInstance();
  const ga = path.join(a.root, 'game'); fs.mkdirSync(ga, { recursive: true });
  const gb = path.join(b.root, 'game'); fs.mkdirSync(gb, { recursive: true });
  dump(path.join(ga, 'jeidump.json'), ['a:only']);
  dump(path.join(gb, 'jeidump.json'), ['b:only']);
  importTruth({ dir: a.dir, id: 'DemoPack', file: ga });
  importTruth({ dir: b.dir, id: 'DemoPack', file: gb });
  assert.deepEqual([...truthSetOf(resolveInstance(a.dir, 'DemoPack'))], ['a:only']);
  assert.deepEqual([...truthSetOf(resolveInstance(b.dir, 'DemoPack'))], ['b:only']);
  assert.equal(statusOf(a.dir, 'DemoPack').source.endsWith('jeidump.json'), true);
}));

test('坏清单给中文报错：不是 jeidump.json / 空清单 / 没给文件', withStore(async () => {
  const { root, dir } = fakeInstance();
  const notDump = path.join(root, 'random.json');
  fs.writeFileSync(notDump, JSON.stringify({ hello: 1 }), 'utf8');
  assert.throws(() => importTruth({ dir, id: 'DemoPack', file: notDump }), /没有 registries.item 清单/);
  const empty = path.join(root, 'empty.json');
  dump(empty, []);
  assert.throws(() => importTruth({ dir, id: 'DemoPack', file: empty }), /清单里一条物品都没有/);
  assert.throws(() => importTruth({ dir, id: 'DemoPack', file: '' }), /没给清单文件/);
  assert.throws(() => importTruth({ dir: '', id: 'DemoPack', file: empty }), /缺少实例目录/);
  // 文件读不到也要给中文提示（不抛原始 ENOENT 栈）。
  assert.throws(() => importTruth({ dir, id: 'DemoPack', file: path.join(root, 'nope.json') }), /读不了清单文件/);
}));

test('两条 handler：status 只回有没有不回 8000 个 ID；import 走 POST JSON body', withStore(async () => {
  const { root, dir } = fakeInstance();
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  dump(path.join(gameDir, 'jeidump.json'), ['minecraft:stone', 'demo:thing_1']);

  const before = await handleItemTruthStatus(req('/item-truth/status', { dir, id: 'DemoPack' }, 'GET'));
  assert.deepEqual(before, { instance: 'DemoPack', has: false, source: '', count: 0 });

  const imported = await handleItemTruthImport(req('/item-truth/import', { dir, id: 'DemoPack', file: gameDir }));
  assert.equal(imported.has, true);
  assert.equal(imported.count, 2);

  const after = await handleItemTruthStatus(req('/item-truth/status', { dir, id: 'DemoPack' }, 'GET'));
  assert.equal(after.has, true);
  assert.equal(after.count, 2);
  assert.equal(after.ids, undefined, 'status 不该把整份清单回传界面');

  // 缺 dir 的 status 要给中文报错（不能 500 空白）。
  await assert.rejects(
    handleItemTruthStatus(req('/item-truth/status', {}, 'GET')),
    /缺少实例目录/,
  );
}));

test('clearTruthCache 只清内存不动盘：真实数据不该被测试删掉', withStore(async (store) => {
  const { root, dir } = fakeInstance();
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  dump(path.join(gameDir, 'jeidump.json'), ['minecraft:stone']);
  importTruth({ dir, id: 'DemoPack', file: gameDir });
  const saved = fs.readFileSync(path.join(store, 'item-truth.json'), 'utf8');
  clearTruthCache();
  assert.equal(fs.readFileSync(path.join(store, 'item-truth.json'), 'utf8'), saved, '清缓存把磁盘清单改了');
  assert.equal(statusOf(dir, 'DemoPack').has, true, '清缓存后重新读盘仍该看得到清单');
}));
