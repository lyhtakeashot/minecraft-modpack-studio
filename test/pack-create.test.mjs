/**
 * 从零建包（lib/core/pack-create.js）的单测。
 *
 * 这一层的风险是「建出来的包启动不了」和「手滑把模板包写坏」，
 * 所以断言三件事：目录/文件齐不齐、版本 json 的 id 改没改对、
 * 模板目录有没有被动过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyPackPlan,
  buildPackPlan,
  emptyQuestBook,
  validatePackName,
  PACK_DIRS,
  QUEST_DATA_VERSION,
} from '../packages/core/pack-create.js';
import { parseSnbt } from '../packages/core/snbt.js';

/** 造一个「已经装好的」Minecraft 根目录 + 一个模板实例。 */
function makeRoot(templateId = 'Template') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-pack-'));
  fs.mkdirSync(path.join(root, 'libraries'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  const dir = path.join(root, 'versions', templateId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${templateId}.json`), JSON.stringify({
    id: templateId,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assetIndex: { id: '17' },
    libraries: [{ name: 'net.minecraft:client:1.21.1' }],
    arguments: { game: ['--version', '1.21.1'] },
  }), 'utf8');
  fs.writeFileSync(path.join(dir, `${templateId}.jar`), 'fake-jar-bytes', 'utf8');
  fs.mkdirSync(path.join(dir, 'mods'));
  return { root, templateDir: dir };
}

test('包名校验：正常名字能过，非法的不行', () => {
  assert.equal(validatePackName('我的整合包').ok, true);
  assert.equal(validatePackName('MyCreatePack 1.0').ok, true);
  assert.equal(validatePackName('  Python 之梦  ').name, 'Python 之梦', '两头空格要修剪掉');

  for (const bad of ['', '   ', 'a/b', 'a\\b', 'a:b', 'a*?', 'a|b', 'con', 'COM1', 'a.', '.']) {
    assert.equal(validatePackName(bad).ok, false, `「${bad}」应该被拒`);
  }
  assert.equal(validatePackName('x'.repeat(49)).ok, false, '太长要拒');
});

test('计划：目录、文件、体积都算出来了，而且没写盘', () => {
  const { root, templateDir } = makeRoot();
  const plan = buildPackPlan({ mcRoot: root, name: '新包', templateDir });

  assert.equal(plan.name, '新包');
  assert.equal(plan.targetDir, path.join(root, 'versions', '新包'));
  assert.ok(plan.dirs.includes('mods'));
  assert.ok(plan.dirs.includes('kubejs/server_scripts'));
  assert.ok(plan.files.some((f) => f.rel === '新包.json' && f.kind === 'version-json'));
  assert.ok(plan.files.some((f) => f.rel === '新包.jar' && f.kind === 'client-jar'));
  assert.ok(plan.files.some((f) => f.rel.endsWith('data.snbt')));
  assert.ok(plan.totalBytes > 0);
  assert.equal(plan.questBook, true);

  // 算计划不许造出任何东西
  assert.equal(fs.existsSync(plan.targetDir), false, '只算计划时不该建目录');
});

test('不要任务书 / 不要 kubejs 时，相应的目录和文件都不出现', () => {
  const { root, templateDir } = makeRoot();
  const plan = buildPackPlan({ mcRoot: root, name: 'NoQuest', templateDir, withQuestBook: false, withKubejs: false });
  assert.equal(plan.questBook, false);
  assert.equal(plan.kubejs, false);
  assert.equal(plan.dirs.some((d) => d.startsWith('config/ftbquests')), false);
  assert.equal(plan.dirs.some((d) => d.startsWith('kubejs/')), false);
  assert.equal(plan.files.some((f) => f.kind === 'quest'), false);
});

test('模板里一个 mod 都没有时会提醒', () => {
  const { root, templateDir } = makeRoot();
  const plan = buildPackPlan({ mcRoot: root, name: 'NoMods', templateDir });
  assert.ok(plan.warnings.some((w) => w.includes('一个 mod 都没有')));
});

test('跟模板同名、目标已存在、跟模板不在同一个根目录，统统报错', () => {
  const { root, templateDir } = makeRoot();
  assert.throws(() => buildPackPlan({ mcRoot: root, name: 'Template', templateDir }), /不能和模板同名/);

  const target = path.join(root, 'versions', '已存在');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
  assert.throws(() => buildPackPlan({ mcRoot: root, name: '已存在', templateDir }), /已经存在/);

  // 空目录可以复用
  fs.mkdirSync(path.join(root, 'versions', '空目录'));
  const plan = buildPackPlan({ mcRoot: root, name: '空目录', templateDir });
  assert.equal(plan.exists, 'empty-dir');

  const other = makeRoot('OtherTemplate');
  assert.throws(
    () => buildPackPlan({ mcRoot: root, name: '跨根', templateDir: other.templateDir }),
    /库都在|不在这个根目录下/,
  );
});

test('根目录里没有 libraries/ 就拒绝建包（建了也启动不了）', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-bare-'));
  const { templateDir } = makeRoot();
  assert.throws(() => buildPackPlan({ mcRoot: bare, name: 'X', templateDir }), /没有 libraries/);
});

test('apply：真建出来，版本 json 的 id 改对，模板没被动过', () => {
  const { root, templateDir } = makeRoot();
  const plan = buildPackPlan({ mcRoot: root, name: '成品包', templateDir });
  const result = applyPackPlan(plan);

  assert.equal(result.ok, true);
  const targetDir = plan.targetDir;
  assert.ok(fs.existsSync(path.join(targetDir, 'mods')));
  assert.ok(fs.existsSync(path.join(targetDir, 'kubejs', 'server_scripts')));
  assert.ok(fs.existsSync(path.join(targetDir, 'config', 'ftbquests', 'quests', 'chapters')));

  const json = JSON.parse(fs.readFileSync(path.join(targetDir, '成品包.json'), 'utf8'));
  assert.equal(json.id, '成品包', 'id 必须和目录名一致，否则启动器认不出来');
  assert.equal(json.mainClass, 'net.minecraft.client.main.Main');
  assert.ok(fs.readFileSync(path.join(targetDir, '成品包.jar'), 'utf8').includes('fake-jar'));

  // 任务书三个文件都要是能解析的 SNBT
  const bookFiles = emptyQuestBook();
  for (const rel of Object.keys(bookFiles)) {
    const text = fs.readFileSync(path.join(targetDir, rel), 'utf8');
    assert.doesNotThrow(() => parseSnbt(text, rel), `${rel} 应该能被解析`);
  }
  const data = parseSnbt(fs.readFileSync(path.join(targetDir, 'config/ftbquests/quests/data.snbt'), 'utf8'));
  assert.equal(data.version, QUEST_DATA_VERSION);

  // 模板一个字都不能变
  assert.deepEqual(fs.readdirSync(path.join(templateDir, 'mods')), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(templateDir, 'Template.json'), 'utf8')).id, 'Template');
  assert.equal(fs.readFileSync(path.join(templateDir, 'Template.jar'), 'utf8'), 'fake-jar-bytes');
});

test('apply 两次：第二次拒绝覆盖', () => {
  const { root, templateDir } = makeRoot();
  const plan = buildPackPlan({ mcRoot: root, name: '重复建', templateDir });
  applyPackPlan(plan);
  assert.throws(() => applyPackPlan(plan), /不为空|拒绝覆盖/);
});

test('计划里塞一个跑出实例目录的路径会被拦下', () => {
  const { root, templateDir } = makeRoot();
  const plan = buildPackPlan({ mcRoot: root, name: '越界', templateDir });
  fs.mkdirSync(plan.targetDir, { recursive: true });
  plan.files = [{ rel: '..\\..\\evil.txt', kind: 'quest', bytes: 1 }];
  assert.throws(() => applyPackPlan(plan), /跑到实例外面了/);
});

test('PACK_DIRS 里没有重复项，也不带反斜杠（打包和 Linux 都能用）', () => {
  assert.equal(new Set(PACK_DIRS).size, PACK_DIRS.length);
  for (const d of PACK_DIRS) assert.equal(d.includes('\\'), false, `${d} 里不该有反斜杠`);
});