/**
 * 启动验证接口（lib/host/launch-api.js）的单测。
 *
 * 铁律：**这个套件里绝对不能真的启动 JVM**。
 * 真启动一次要几十秒、还会弹游戏窗口，沙箱里更是直接没法跑。
 * 所以只覆盖三条安全路径：
 *   1. /launch/preview 能算出计划、回人话报告和命令行，且不产生任何进程/文件；
 *   2. /launch/apply 不传 apply:true 时被拒绝（这是安全线，必须有人守着）；
 *   3. launchResultPayload 对「没启动成功」的处理 —— ok 仍是 true，归因方向不丢。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { API_BASE, registerStudioApi, resetStudioApiCache } from '../lib/host/api.js';
import { launchResultPayload } from '../lib/host/launch-api.js';

/** 假 connection：只实现 fetch.register，把路由收进一张表（同 host-api.test.mjs:17）。 */
function fakeConnection() {
  const routes = new Map();
  return {
    routes,
    fetch: {
      register({ path: p, methods, fetch }) {
        routes.set(p, { methods, fetch });
      },
    },
  };
}

/** 发一个请求并解出 JSON。 */
async function call(conn, suffix, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `http://localhost${API_BASE}${suffix}${qs ? `?${qs}` : ''}`;
  const route = conn.routes.get(API_BASE + suffix);
  assert.ok(route, `路由没注册：${API_BASE}${suffix}`);
  const res = await route.fetch(new Request(url));
  return { status: res.status, body: await res.json() };
}

/** 用 POST body 发一个请求（参数放 body，和面板真启动时一样）。 */
async function post(conn, suffix, body) {
  const route = conn.routes.get(API_BASE + suffix);
  assert.ok(route, `路由没注册：${API_BASE}${suffix}`);
  const res = await route.fetch(new Request(`http://localhost${API_BASE}${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

/**
 * 造一个最小的假实例目录（照 host-api.test.mjs:40 的 makeFakeInstance）。
 *
 * 只有版本 json，没有 libraries、没有客户端 jar —— 这正是「真启动前会被拦」的情形，
 * 顺便保证就算有人误改了测试也不会真的把 JVM 拉起来。
 */
function makeFakeInstance() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-launch-'));
  const dir = path.join(root, 'versions', 'DemoPack');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'DemoPack.json'),
    JSON.stringify({ id: 'DemoPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
    'utf8',
  );
  return { root, dir };
}

test('/launch/preview 返回 ok:true，带命令行和人话报告，不启动任何进程', async () => {
  resetStudioApiCache();
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);

  const { status, body } = await call(conn, '/launch/preview', { dir });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.instance, 'DemoPack');
  assert.equal(body.versionId, 'DemoPack');
  assert.equal(body.mainClass, 'net.minecraft.client.main.Main');
  // 人话报告是一行一行的数组，界面直接铺出来
  assert.ok(Array.isArray(body.lines));
  assert.ok(body.lines.length > 0, 'preview 必须给出人话报告');
  assert.ok(body.lines.some((l) => l.includes('实例')), '报告里要能看出是哪个实例');
  // 命令行要么是可复制的完整命令，要么是「没找到 Java」的说明，不能是空串
  assert.equal(typeof body.command, 'string');
  assert.ok(body.command.length > 0, 'preview 必须给出命令行或说明');
  assert.equal(typeof body.commandTruncated, 'boolean');
  // 统计字段的形状（界面要按这个渲染）
  assert.equal(body.classpath.hasClientJar, false, '假实例没有客户端 jar');
  assert.ok(Array.isArray(body.libraries.missing), 'missing 必须是数组，即使为空');
  assert.equal(body.libraries.total, 0);
  // 界面（packages/ui/app.js:2164）读的是 found：「几个齐 / 几个缺」两个数都得有
  assert.equal(typeof body.libraries.found, 'number', 'libraries.found 必须是数字');
  assert.equal(body.libraries.found, 0, '一个库都没有，齐的自然是 0');
  assert.equal(typeof body.javaMatches, 'boolean');
  // 假实例没有客户端 jar、也没有库，所以真启动一定被拦 —— 界面靠这个禁用按钮
  assert.ok(body.blockers.some((b) => b.includes('客户端 jar')), `blockers 没提到缺客户端 jar：${JSON.stringify(body.blockers)}`);
});

test('/launch/preview 不写盘、不启动进程：实例目录前后文件数一致', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const before = fs.readdirSync(dir).sort();
  const { body } = await call(conn, '/launch/preview', { dir });
  assert.equal(body.ok, true);
  // preview 只读版本 json，不该在实例目录里落任何东西（natives 目录是 launch 才建的）
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'preview 不写盘');
  assert.equal(fs.existsSync(path.join(dir, 'logs')), false, 'preview 不该建 logs');
  assert.equal(fs.existsSync(path.join(dir, 'DemoPack-natives')), false, 'preview 不该解压 natives');
});

test('/launch/preview 缺实例目录时返回 400 和中文提示', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/launch/preview');
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /缺少整合包目录/);
  assert.match(body.hint, /连一个整合包/);
});

test('/launch/apply 没传 apply:true 时被拒绝，并给出中文 hint（绝不启动进程）', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);

  const { status, body } = await post(conn, '/launch/apply', { dir });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'LaunchNeedApply');
  assert.match(body.error, /没有真的启动/);
  assert.match(body.hint, /apply: true/);
  // 被拒绝就等于什么都没发生
  assert.equal(fs.existsSync(path.join(dir, 'logs')), false, '被拒绝时不该建 logs');
  assert.equal(fs.existsSync(path.join(dir, 'DemoPack-natives')), false, '被拒绝时不该解压 natives');
});

test('/launch/apply 传 apply:false 也照样被拒绝（预设值不能糊弄过去）', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);

  const { status, body } = await post(conn, '/launch/apply', { dir, apply: false });
  assert.equal(status, 400);
  assert.equal(body.code, 'LaunchNeedApply');
});

test('/launch/apply 传了 apply:true 但有硬伤时，拦在真启动之前且不建任何东西', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);

  // 假实例没有客户端 jar、没有 libraries —— 真启动前必须先被拦下。
  // 这一步不依赖本机装没装 Java（那是第一道拦，命中哪个都算合格），
  // 所以断言只要求「落在三种前置硬伤之一」，跨机器都稳。
  const { status, body } = await post(conn, '/launch/apply', { dir, apply: true });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.ok(
    ['LaunchNoJava', 'LaunchLibMissing', 'LaunchNoClientJar'].includes(body.code),
    `应该是启动前的硬伤拦截，实际 code=${body.code}（${body.error}）`,
  );
  // 中文 message + 中文 hint 是硬要求：界面把这两行直接铺给用户
  assert.ok(body.error.length > 0);
  assert.ok(body.hint.length > 0);
  // 被拦住就等于什么都没发生：没建 logs、没解压 natives
  assert.equal(fs.existsSync(path.join(dir, 'logs')), false, '被拦住时不该建 logs');
  assert.equal(fs.existsSync(path.join(dir, 'DemoPack-natives')), false, '被拦住时不该解压 natives');
});

test('/launch/apply 用 GET 打不通（真启动只能 POST）', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/launch/apply', { apply: 'true' });
  assert.equal(status, 405);
  assert.equal(body.ok, false);
  assert.match(body.error, /只接受 POST/);
});

test('launchResultPayload：启动失败也是 ok:true，归因方向原样带回', () => {
  // 造一个「进程退出但没到主菜单」的假结果（真跑一次要几十秒，测试里不跑）
  const r = {
    tail: 'first line\nSecond line\n\nThird line',
    exitCode: 1,
    signal: null,
    durationMs: 4321,
    timeoutHit: false,
    logFile: 'D:\\demo\\logs\\latest.log',
    captureFile: 'D:\\demo\\logs\\dsh-launch.log',
    newCrashReports: ['crash-2026-11-01.txt'],
    natives: { files: [], locked: [] },
    evidence: '',
    evidenceKind: '',
    verdict: {
      status: 'crashed',
      summary: '进程退出但没到主菜单（exit=1, signal=null）',
      suspects: ['目录写权限（本轮最大嫌疑）', '缺少前置 mod'],
    },
  };
  const payload = launchResultPayload(r, { planLines: ['实例      D:\\demo'], extraLines: ['natives 已解压：3 个文件'] });

  // 这条是整件事的核心：界面 api() 见到 ok:false 就抛异常，抛了 suspects 就全丢了
  assert.equal(payload.ok, true, '业务上的「没起来」不能回 ok:false');
  assert.equal(payload.started, false);
  assert.equal(payload.status, 'crashed');
  assert.equal(payload.summary, r.verdict.summary);
  assert.deepEqual(payload.suspects, ['目录写权限（本轮最大嫌疑）', '缺少前置 mod']);
  assert.equal(payload.durationMs, 4321);
  assert.equal(payload.exitCode, 1);
  // 空行被过滤掉，尾部按行给界面
  assert.deepEqual(payload.tail, ['first line', 'Second line', 'Third line']);
  assert.deepEqual(payload.newCrashReports, ['crash-2026-11-01.txt']);
  // 没到主菜单就没有证据行 —— 必须是空数组，界面靠 .length 判断要不要铺这一段
  assert.deepEqual(payload.evidence, []);
  assert.equal(payload.evidenceLine, '');
  // 人话报告里既有计划也有结论和归因
  assert.ok(payload.lines.includes('结论：进程退出但没到主菜单（exit=1, signal=null）'));
  assert.ok(payload.lines.some((l) => l.startsWith('归因方向：')));
  assert.ok(payload.lines.some((l) => l.includes('natives 已解压：3 个文件')));
});

test('launchResultPayload：启动到主菜单时 started:true 且 suspects 为空', () => {
  const payload = launchResultPayload({
    tail: '[Render thread] Sound engine started',
    exitCode: null,
    signal: 'SIGTERM',
    durationMs: 17200,
    timeoutHit: false,
    logFile: 'D:\\demo\\logs\\latest.log',
    newCrashReports: [],
    // core 的 evidence 是一个字符串；接口层要转成数组给界面逐行铺
    evidence: '[Render thread] Sound engine started',
    evidenceKind: 'Sound engine started',
    verdict: {
      status: 'ok',
      summary: '启动到主菜单，用时 17.2s（证据：Sound engine started）',
      suspects: [],
    },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.started, true);
  assert.equal(payload.status, 'ok');
  assert.deepEqual(payload.suspects, []);
  // 界面（packages/ui/app.js:2187-2188）按数组用 .slice(0,6) —— 给字符串会被拆成单字
  assert.deepEqual(payload.evidence, ['[Render thread] Sound engine started']);
  assert.equal(payload.evidenceLine, '[Render thread] Sound engine started');
  assert.equal(payload.evidenceKind, 'Sound engine started');
  // 进程被我们主动 kill 掉时 exitCode 是 null，界面要能直接显示，不能是 undefined
  assert.equal(payload.exitCode, -1);
  assert.ok(payload.lines[payload.lines.length - 1].includes('Sound engine started'), '日志尾部要带上证据行');
});

test('launchResultPayload：超时也按业务结论回 ok:true 并给出可调项', () => {
  const payload = launchResultPayload({
    tail: '',
    exitCode: null,
    durationMs: 600000,
    timeoutHit: true,
    logFile: '',
    newCrashReports: [],
    verdict: {
      status: 'timeout',
      summary: '超时未到主菜单（600s）',
      suspects: ['首次启动要下资源，可加大 timeoutMs'],
    },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.started, false);
  assert.equal(payload.status, 'timeout');
  assert.equal(payload.timeoutHit, true);
  assert.ok(payload.suspects.length > 0);
  // 没日志时不该冒出空白行
  assert.deepEqual(payload.tail, []);
});
