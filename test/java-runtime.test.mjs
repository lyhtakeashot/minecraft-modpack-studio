/**
 * 官方 Java 运行时那一层的单元测试（零联网：假索引 + 假清单 + 假 http）。
 *
 * 重点验三件事：
 * 1. 纯函数算得对（平台映射、主版本查表、挑条目、去重、入口路径）；
 * 2. 清单形状怪异时（目录条目、没有下载地址的条目、同一个 sha1 出现两次）不炸；
 * 3. `applyJavaRuntime` 真写盘时：目录建了、去重组只下一次、第二次跑会跳过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COMPONENT_BY_MAJOR,
  JAVA_RUNTIME_INDEX_URL,
  applyJavaRuntime,
  componentForMajor,
  describeJavaRuntime,
  formatBytes,
  loadJavaRuntimePlan,
  pickRuntimeEntry,
  planJavaRuntime,
  platformKey,
  runtimeDir,
} from '../packages/core/java-runtime.js';

// ---------------------------------------------------------------------------
// fixture：假的官方索引（片段，形状照实测抄）
// ---------------------------------------------------------------------------

const GAMMA_MANIFEST_SHA1 = 'a'.repeat(40);
const GAMMA_MANIFEST_URL = `https://piston-meta.mojang.com/v1/packages/${GAMMA_MANIFEST_SHA1}/manifest.json`;

const FAKE_ALL = {
  'windows-x64': {
    'java-runtime-gamma': [
      {
        availability: { group: 0, progress: 100 },
        manifest: { sha1: GAMMA_MANIFEST_SHA1, size: 2600000, url: GAMMA_MANIFEST_URL },
        version: { name: '17.0.15', released: '2025-05-19T08:28:47+00:00' },
      },
      // 同一个组件的旧版本排在后面，应该不会被选中
      {
        availability: { group: 0, progress: 100 },
        manifest: { sha1: 'b'.repeat(40), size: 1, url: 'https://piston-meta.mojang.com/v1/packages/bb/manifest.json' },
        version: { name: '17.0.14', released: '2024-01-01T00:00:00+00:00' },
      },
    ],
    'java-runtime-delta': [
      {
        manifest: { sha1: 'c'.repeat(40), size: 2600001, url: 'https://piston-meta.mojang.com/v1/packages/cc/manifest.json' },
        version: { name: '21.0.7', released: '2025-05-19T08:28:47+00:00' },
      },
    ],
  },
  linux: {
    'jre-legacy': [
      {
        manifest: { sha1: 'e'.repeat(40), size: 500, url: 'https://piston-meta.mojang.com/v1/packages/ee/manifest.json' },
        version: { name: '8u74', released: '2020-01-01T00:00:00+00:00' },
      },
    ],
  },
};

/** 一个假组件的 manifest：目录、同 sha1 的重复条目、带 lzma 的条目、入口、可执行位。 */
const FAKE_MANIFEST = {
  files: {
    bin: { type: 'directory' },
    'bin/java.exe': {
      type: 'file',
      executable: true,
      downloads: {
        raw: { sha1: 'j'.repeat(40), size: 1000, url: `https://piston-data.mojang.com/v1/objects/${'j'.repeat(40)}/java.exe` },
        lzma: { sha1: 'k'.repeat(40), size: 400, url: `https://piston-data.mojang.com/v1/objects/${'k'.repeat(40)}/java.exe` },
      },
    },
    lib: { type: 'directory' },
    'lib/a.jar': {
      type: 'file',
      executable: false,
      downloads: {
        // 带 lzma：只用 raw，lzma 那个地址绝不能出现在 candidates 里
        raw: { sha1: 'd'.repeat(40), size: 200, url: `https://piston-data.mojang.com/v1/objects/${'d'.repeat(40)}/a.jar` },
        lzma: { sha1: 'f'.repeat(40), size: 80, url: `https://piston-data.mojang.com/v1/objects/${'f'.repeat(40)}/a.jar` },
      },
    },
    // 和 lib/a.jar 同一个 sha1 + 大小 → 去重组
    'lib/b.jar': {
      type: 'file',
      downloads: {
        raw: { sha1: 'd'.repeat(40), size: 200, url: `https://piston-data.mojang.com/v1/objects/${'d'.repeat(40)}/b.jar` },
      },
    },
    release: {
      type: 'file',
      downloads: {
        raw: { sha1: 'r'.repeat(40), size: 30, url: `https://piston-data.mojang.com/v1/objects/${'r'.repeat(40)}/release` },
      },
    },
    'legal/java.base/COPYRIGHT': {
      type: 'file',
      downloads: {
        raw: { sha1: 'c'.repeat(40), size: 5, url: `https://piston-data.mojang.com/v1/objects/${'c'.repeat(40)}/COPYRIGHT` },
      },
    },
    // 官方清单里目前没有这种条目，但真碰上也不能整单炸掉
    'weird/link': { type: 'link', target: '../bin/java.exe' },
  },
};

const FAKE_PLAN_ORDER = ['bin', 'bin/java.exe', 'lib', 'lib/a.jar', 'lib/b.jar', 'release', 'legal/java.base/COPYRIGHT'];

function tmpRoot(name = 'java-runtime') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcstudio-${name}-`));
}

/** 假 http：只实现 `json()`，记录被拉过的地址。 */
function fakeJsonHttp(handlers = {}) {
  const calls = [];
  return {
    calls,
    async json(url) {
      calls.push(url);
      if (handlers[url]) return handlers[url];
      throw new Error(`测试里没准备这个地址：${url}`);
    },
  };
}

/** 假 http：只实现 downloader.download()，按 expect.size 写一坨字节。 */
function fakeDownloadHttp({ failOn = '' } = {}) {
  const calls = [];
  return {
    calls,
    downloader: {
      async download(candidates, absPath, expect) {
        calls.push({ candidates, absPath, expect });
        if (failOn && absPath.includes(failOn)) throw new Error('网络断了');
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, 'x'.repeat(expect?.size ?? 1));
        return { bytes: expect?.size ?? 1 };
      },
    },
  };
}

function buildPlan(mcRoot, { platform = 'windows-x64' } = {}) {
  return planJavaRuntime({
    index: FAKE_ALL,
    manifest: FAKE_MANIFEST,
    component: 'java-runtime-gamma',
    mcRoot,
    platform,
    version: '17.0.15',
  });
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('平台映射：Node 的 platform/arch 换成官方清单的平台键', () => {
  assert.equal(platformKey('win32', 'x64'), 'windows-x64');
  assert.equal(platformKey('win32', 'ia32'), 'windows-x86');
  assert.equal(platformKey('win32', 'arm64'), 'windows-arm64');
  assert.equal(platformKey('darwin', 'arm64'), 'mac-os-arm64');
  assert.equal(platformKey('darwin', 'x64'), 'mac-os');
  assert.equal(platformKey('linux', 'x64'), 'linux');
  assert.equal(platformKey('linux', 'ia32'), 'linux-i386');

  // 官方没提供的架构/系统：报错，别下错架构的 JRE
  assert.throws(() => platformKey('win32', 'arm'), /官方运行时清单里没有/);
  assert.throws(() => platformKey('linux', 'arm64'), /Linux ARM/);
  assert.throws(() => platformKey('freebsd', 'x64'), /官方运行时清单里没有/);
  assert.throws(() => platformKey('sunos', 'x64'), (error) => error.code === 'JavaRuntimePlatform');
});

test('主版本查表：认得的给组件名，认不得的给空串', () => {
  assert.equal(componentForMajor(17), 'java-runtime-gamma');
  assert.equal(componentForMajor(21), 'java-runtime-delta');
  assert.equal(componentForMajor(8), 'jre-legacy');
  assert.equal(componentForMajor(16), 'java-runtime-alpha');
  // 字符串也认（版本 json 里有时是字符串）
  assert.equal(componentForMajor('17'), 'java-runtime-gamma');
  assert.equal(componentForMajor(99), '');
  assert.equal(componentForMajor(undefined), '');
  assert.deepEqual(Object.keys(COMPONENT_BY_MAJOR).sort(), ['16', '17', '21', '8']);
});

test('挑运行时条目：取第一个、按平台找、找不到要说人话', () => {
  const hit = pickRuntimeEntry(FAKE_ALL, { component: 'java-runtime-gamma', platform: 'windows-x64' });
  assert.deepEqual(hit, {
    component: 'java-runtime-gamma',
    version: '17.0.15',
    manifestUrl: GAMMA_MANIFEST_URL,
    manifestSha1: GAMMA_MANIFEST_SHA1,
    manifestSize: 2600000,
  });
  // 排第二的旧版本不能被选中
  assert.notEqual(hit.version, '17.0.14');

  // 换个平台照样能挑（Linux 上 1.8 时代的老 JRE）
  const legacy = pickRuntimeEntry(FAKE_ALL, { component: 'jre-legacy', platform: 'linux' });
  assert.equal(legacy.version, '8u74');

  // 组件不存在
  assert.throws(
    () => pickRuntimeEntry(FAKE_ALL, { component: 'java-runtime-epsilon', platform: 'windows-x64' }),
    (error) => {
      assert.match(error.message, /官方运行时清单里没有 java-runtime-epsilon/);
      assert.match(error.hint, /换一个 Java 主版本|手动装 Java/);
      assert.equal(error.code, 'JavaRuntimeMissing');
      return true;
    },
  );

  // 平台不存在（官方清单里没有 mac-os 这一档的 gamma）
  assert.throws(() => pickRuntimeEntry(FAKE_ALL, { component: 'java-runtime-gamma', platform: 'mac-os' }), /官方运行时清单里没有/);

  // 组件名没给
  assert.throws(() => pickRuntimeEntry(FAKE_ALL, { platform: 'windows-x64' }), /没给 Java 运行时组件名/);
});

test('算计划：条目齐全、入口路径对、同 sha1 只算一次下载', () => {
  const root = tmpRoot('plan');
  try {
    const plan = buildPlan(root);

    assert.equal(plan.component, 'java-runtime-gamma');
    assert.equal(plan.version, '17.0.15');
    assert.equal(plan.dir, path.join(root, 'runtime', 'java-runtime-gamma'));
    assert.equal(plan.dir, runtimeDir(root, 'java-runtime-gamma'));
    assert.equal(plan.javaPath, path.join(plan.dir, 'bin', 'java.exe'));

    // 条目：2 个目录 + 5 个文件；没有下载地址的条目（weird/link）不该混进来
    assert.equal(plan.entries.length, 7);
    assert.equal(plan.fileCount, 5);
    assert.equal(plan.dirCount, 2);
    assert.deepEqual(plan.entries.map((entry) => entry.relPath), FAKE_PLAN_ORDER);

    // 目录条目
    const binDir = plan.entries[0];
    assert.equal(binDir.type, 'directory');
    assert.equal(binDir.absPath, path.join(plan.dir, 'bin'));
    assert.deepEqual(binDir.candidates, []);

    // 入口文件：executable 保住了，candidates 只有 raw 那一个地址
    const javaExe = plan.entries.find((entry) => entry.relPath === 'bin/java.exe');
    assert.equal(javaExe.type, 'file');
    assert.equal(javaExe.executable, true);
    assert.equal(javaExe.size, 1000);
    assert.deepEqual(javaExe.candidates, [javaExe.url]);
    assert.equal(javaExe.absPath, plan.javaPath);

    // 带 lzma 的条目：地址必须还是 raw 的，不能拿 lzma 去下
    const aJar = plan.entries.find((entry) => entry.relPath === 'lib/a.jar');
    assert.match(aJar.url, /\/a\.jar$/);
    assert.equal(aJar.sha1, 'd'.repeat(40));
    assert.doesNotMatch(aJar.url, new RegExp('f'.repeat(40)));

    // 去重：lib/a.jar 和 lib/b.jar 内容一样，只真下一次
    assert.equal(plan.dedupeGroups.length, 1);
    assert.equal(plan.dedupeGroups[0].sha1, 'd'.repeat(40));
    assert.equal(plan.dedupeGroups[0].size, 200);
    assert.deepEqual(plan.dedupeGroups[0].relPaths, ['lib/a.jar', 'lib/b.jar']);

    // 字节账：去重前 1000+200+200+30+5，去重后少掉一份 200
    assert.equal(plan.totalBytes, 1435);
    assert.equal(plan.downloadBytes, 1235);
    assert.ok(plan.downloadBytes < plan.totalBytes);
    assert.equal(plan.files.length, plan.fileCount);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('算计划：非 Windows 平台的入口是 bin/java', () => {
  const root = tmpRoot('plan-linux');
  try {
    const plan = buildPlan(root, { platform: 'linux' });
    assert.equal(plan.javaPath, path.join(plan.dir, 'bin', 'java'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('算计划：清单坏了要明确报错，不要装作没事', () => {
  const root = tmpRoot('plan-bad');
  try {
    assert.throws(() => planJavaRuntime({ manifest: null, component: 'java-runtime-gamma', mcRoot: root }), (error) => {
      assert.match(error.message, /没有 files/);
      assert.equal(error.code, 'JavaRuntimeBadManifest');
      return true;
    });
    assert.throws(() => planJavaRuntime({ manifest: {}, component: 'java-runtime-gamma', mcRoot: root }), /没有 files/);
    // 组件名空着 → 装出来会是个空目录名，直接拦掉
    assert.throws(() => planJavaRuntime({ manifest: FAKE_MANIFEST, component: '', mcRoot: root }), /不知道要把 Java 装成哪个目录名/);
    assert.throws(() => runtimeDir('', 'java-runtime-gamma'), /不知道要把 Java 装到哪个目录/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('说明文字：三行中文，带组件名、版本、目录和大小', () => {
  const root = tmpRoot('describe');
  try {
    const plan = buildPlan(root);
    const lines = describeJavaRuntime(plan);
    assert.ok(Array.isArray(lines));
    assert.equal(lines.length, 3);
    assert.match(lines[0], /官方运行时 java-runtime-gamma 17\.0\.15/);
    assert.match(lines[1], /装到：/);
    assert.ok(lines[1].includes(plan.dir));
    // 1435 B → 1.4 KB；去重后 1235 B → 1.2 KB
    assert.match(lines[2], /要下 5 个文件、1\.4 KB（去重后 1\.2 KB）/);

    // 没有重复条目时不该提「去重后」
    const simple = planJavaRuntime({
      manifest: { files: { 'bin/java.exe': { type: 'file', downloads: { raw: { sha1: 'z'.repeat(40), size: 1024, url: 'https://x/java.exe' } } } } },
      component: 'jre-legacy',
      mcRoot: root,
      platform: 'windows-x64',
      version: '',
    });
    const simpleLines = describeJavaRuntime(simple);
    assert.equal(simpleLines.length, 3);
    assert.doesNotMatch(simpleLines[2], /去重后/);
    assert.match(simpleLines[0], /java-runtime-legacy|jre-legacy/);
    assert.doesNotMatch(simpleLines[0], /17\.0\.15/);
    assert.deepEqual(describeJavaRuntime(null), []);
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1435), '1.4 KB');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('联网算计划：先拉索引，再拉组件自己那份清单', async () => {
  const root = tmpRoot('load');
  try {
    const http = fakeJsonHttp({ [JAVA_RUNTIME_INDEX_URL]: FAKE_ALL, [GAMMA_MANIFEST_URL]: FAKE_MANIFEST });
    const plan = await loadJavaRuntimePlan({ http, majorVersion: 17, mcRoot: root, platform: 'windows-x64' });

    assert.deepEqual(http.calls, [JAVA_RUNTIME_INDEX_URL, GAMMA_MANIFEST_URL]);
    assert.equal(plan.component, 'java-runtime-gamma');
    assert.equal(plan.version, '17.0.15');
    assert.equal(plan.javaPath, path.join(root, 'runtime', 'java-runtime-gamma', 'bin', 'java.exe'));

    // 直接给组件名也走同一条路
    const http2 = fakeJsonHttp({ [JAVA_RUNTIME_INDEX_URL]: FAKE_ALL, [GAMMA_MANIFEST_URL]: FAKE_MANIFEST });
    const plan2 = await loadJavaRuntimePlan({ http: http2, component: 'java-runtime-gamma', mcRoot: root, platform: 'windows-x64' });
    assert.equal(plan2.version, '17.0.15');

    // 主版本查不到表、也没给组件名 → 明确报错，别静默挑一个
    await assert.rejects(
      loadJavaRuntimePlan({ http: fakeJsonHttp({}), majorVersion: 99, mcRoot: root }),
      (error) => error.code === 'JavaRuntimeNoComponent',
    );
    await assert.rejects(loadJavaRuntimePlan({ http: null, majorVersion: 17, mcRoot: root }), /没有联网能力/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 真写盘
// ---------------------------------------------------------------------------

test('真装：目录建好、去重组只下一次、第二次跑全部跳过', async () => {
  const root = tmpRoot('apply');
  try {
    const plan = buildPlan(root);
    const http = fakeDownloadHttp();
    const events = [];

    const first = await applyJavaRuntime({ plan, http, onProgress: (event) => events.push(event) });

    assert.equal(first.ok, true, JSON.stringify(first.failed));
    assert.deepEqual(first.failed, []);
    assert.equal(first.version, '17.0.15');
    assert.equal(first.javaPath, plan.javaPath);

    // 5 个文件里 4 个是「组内第一条」，b.jar 靠复制
    assert.equal(first.downloaded.length, 4);
    assert.deepEqual(first.copied, ['lib/b.jar']);
    assert.equal(first.skipped.length, 0);
    assert.equal(http.calls.length, 4);
    assert.equal(first.bytes, 1235);

    // 去重组只真下了一次：
    // bin/java.exe、lib/a.jar、release、legal/.../COPYRIGHT 各一次，b.jar 不在下载列表里
    const downloadedNames = http.calls.map((call) => path.basename(call.absPath));
    assert.equal(downloadedNames.filter((name) => name === 'b.jar').length, 0);
    assert.equal(downloadedNames.filter((name) => name === 'a.jar').length, 1);
    // 每次下载带的校验信息要对
    for (const call of http.calls) {
      assert.ok(call.expect.sha1.length === 40);
      assert.ok(Number.isInteger(call.expect.size));
      assert.ok(Array.isArray(call.candidates) && call.candidates.length === 1);
    }

    // 文件都在，大小对，重复的两个内容一致
    for (const entry of plan.files) {
      const stat = fs.statSync(entry.absPath);
      assert.ok(stat.isFile(), `${entry.relPath} 应该是文件`);
      assert.equal(stat.size, entry.size);
    }
    assert.equal(fs.readFileSync(path.join(plan.dir, 'lib', 'b.jar'), 'utf8'), fs.readFileSync(path.join(plan.dir, 'lib', 'a.jar'), 'utf8'));
    // 可执行位的条目确实被标成了 executable（Windows 上没法比对权限位，只查计划）
    assert.equal(plan.files.find((entry) => entry.relPath === 'bin/java.exe').executable, true);

    // 目录条目建出来了
    for (const dir of plan.entries.filter((entry) => entry.type === 'directory')) {
      assert.ok(fs.statSync(dir.absPath).isDirectory(), `${dir.relPath} 应该是目录`);
    }
    // 父目录没出现在清单里也能建（legal/java.base/COPYRIGHT）
    assert.ok(fs.statSync(path.join(plan.dir, 'legal', 'java.base')).isDirectory());
    // 入口存在
    assert.ok(fs.existsSync(plan.javaPath));

    // 进度：总条数按文件算，最后一次是 5/5
    assert.ok(events.length >= 5);
    assert.equal(events.at(-1).stage, 'progress');
    assert.equal(events.at(-1).total, 5);
    assert.equal(events.at(-1).done, 5);
    assert.equal(typeof events.at(-1).current, 'string');

    // 第二次跑：文件都在 → 一个都不下，只复制一次
    const http2 = fakeDownloadHttp();
    const second = await applyJavaRuntime({ plan, http: http2 });
    assert.equal(second.ok, true);
    assert.equal(second.downloaded.length, 0);
    assert.equal(http2.calls.length, 0);
    // 跳过的是 4 个「组内第一条」；b.jar 是复制的，不算跳过
    assert.deepEqual(
      second.skipped.sort(),
      plan.files.map((entry) => entry.relPath).filter((relPath) => relPath !== 'lib/b.jar').sort(),
    );
    assert.deepEqual(second.copied, ['lib/b.jar']);
    assert.equal(second.bytes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('真装：单个文件下挂了不抛异常，收进 failed 交回上层', async () => {
  const root = tmpRoot('apply-fail');
  try {
    const plan = buildPlan(root);
    const http = fakeDownloadHttp({ failOn: 'java.exe' });
    const result = await applyJavaRuntime({ plan, http });

    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].relPath, 'bin/java.exe');
    assert.match(result.failed[0].error, /网络断了/);
    // 其它文件照下，入口缺失只报这一条，不再叠一条「没有 Java 入口」
    assert.equal(result.downloaded.length, 3);
    assert.deepEqual(result.copied, ['lib/b.jar']);
    assert.equal(fs.existsSync(plan.javaPath), false);

    // 计划/联网对象没给 → 抛 McError（这是调用方写错了，不是网络问题）
    await assert.rejects(applyJavaRuntime({ http }), (error) => error.code === 'JavaRuntimeNoPlan');
    await assert.rejects(applyJavaRuntime({ plan, http: {} }), (error) => error.code === 'JavaRuntimeNoHttp');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});