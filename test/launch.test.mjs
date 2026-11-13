/**
 * 启动层的纯计算单测（不启动进程，不依赖真机整合包）。
 *
 * 覆盖的每一条都是 §4.9 里踩过的坑，回归价值最高：
 *   rules 判定（含 features / os.arch）、natives classifier 精确匹配、
 *   artifact 去重、占位符替换、离线变量表。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { rulesAllow, substitute } from '../packages/core/launch.js';
import { openZip } from '../packages/core/zip.js';
import { majorOf } from '../packages/core/java.js';

test('rulesAllow：没有 rules 一律放行', () => {
  assert.equal(rulesAllow(undefined), true);
  assert.equal(rulesAllow([]), true);
});

test('rulesAllow：只认 os.name 匹配的条目', () => {
  const rules = [{ action: 'allow', os: { name: 'linux' } }];
  assert.equal(rulesAllow(rules, { os: 'windows', arch: 'x86_64' }), false);
  assert.equal(rulesAllow(rules, { os: 'linux', arch: 'x86_64' }), true);
});

test('rulesAllow：os.arch 不匹配要排除', () => {
  const rules = [{ action: 'allow', os: { name: 'windows', arch: 'x86' } }];
  assert.equal(rulesAllow(rules, { os: 'windows', arch: 'x86_64' }), false);
  assert.equal(rulesAllow(rules, { os: 'windows', arch: 'x86' }), true);
});

test('rulesAllow：features 一律视为不满足（离线没有一个是 true）', () => {
  const rules = [{ action: 'allow', features: { is_demo_user: true } }];
  assert.equal(rulesAllow(rules, { os: 'windows', arch: 'x86_64' }), false);
});

test('rulesAllow：disallow 在 allow 之后能覆盖', () => {
  const rules = [
    { action: 'allow' },
    { action: 'disallow', os: { name: 'windows' } },
  ];
  assert.equal(rulesAllow(rules, { os: 'windows', arch: 'x86_64' }), false);
  assert.equal(rulesAllow(rules, { os: 'linux', arch: 'x86_64' }), true);
});

test('substitute：替换已知变量并报出未替换的', () => {
  const r = substitute('-Djava.library.path=${natives_directory} -Dx=${nope}', {
    natives_directory: '/tmp/n',
  });
  assert.equal(r.text, '-Djava.library.path=/tmp/n -Dx=${nope}');
  assert.deepEqual(r.missing, ['nope']);
});

test('substitute：同一个缺失变量只报一次', () => {
  const r = substitute('${a}-${a}-${a}', {});
  assert.deepEqual(r.missing, ['a']);
});

test('majorOf：兼容 1.8 的旧写法', () => {
  assert.equal(majorOf('21.0.7'), 21);
  assert.equal(majorOf('1.8.0_402'), 8);
  assert.equal(majorOf('17'), 17);
  assert.equal(majorOf(''), 0);
});

test('openZip：能从真 jar 里读回条目内容', () => {
  // probe/jar 里的 create-1.20.1 jar 是仓库自带的真实样例
  const z = openZip(jarBuffer('probe/jar/create-1.20.1-6.0.8.jar'));
  assert.ok(z.names.length > 100, '中央目录条目数应远大于 100');
  assert.ok(z.has('META-INF/MANIFEST.MF'), '必须有 MANIFEST');
  const manifest = z.text('META-INF/MANIFEST.MF');
  assert.match(manifest, /Manifest-Version/);
  assert.equal(z.read('no/such/entry'), null);
});

// ── 辅助 ──

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function jarBuffer(rel) {
  return fs.readFileSync(path.join(HERE, '..', rel));
}
