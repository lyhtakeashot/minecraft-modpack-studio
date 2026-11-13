/**
 * 桌面壳测：协议层 + 冒烟。
 *
 * ## 2026-11-01 协议化之后
 *
 * 界面不再走本地 HTTP 服务（port.js / server.js 那套已经退役），
 * 改走 `mcstudio://app/` 自定义协议。协议处理器 `packages/desktop/protocol.js`
 * 是纯逻辑（不 import electron），普通 Node 就能直接调 ——
 * 所以这里能测：静态文件解析、目录穿越防护、接口分发、协议 URL 形状。
 *
 * 为什么不能在测试里 import `main.mjs`：它加载第一件事就是 `require('electron')`，
 * 普通 Node 里没有这个内建模块，直接抛。所以主进程那层只能靠自检/打包后验。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { SCHEME, HOST, SCHEME_PRIVILEGES, resolveStatic, handleProtocolRequest, adaptProtocolRequest, appUrl } from '../packages/desktop/protocol.js';
import { KEEP_DIRS, KEEP_FILES, stashUserData, restoreUserData } from '../packages/desktop/keep.mjs';
import {
  bootPendingPath,
  clearBootStarted,
  markBootStarted,
  markSafeModeWorks,
  planStartup,
  readBootState,
  safeModeStampPath,
} from '../packages/desktop/boot-state.js';
import { boundsOnScreen, planWindowReveal } from '../packages/desktop/window-focus.js';
import {
  LAUNCH_ATTEMPTS,
  SHORTCUT_ARGS,
  buildLaunchCmd,
  buildShortcutScript,
  isAsciiOnly,
  shortcutSpawnPlan,
} from '../packages/desktop/launch-plan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

test('协议地址：就是 mcstudio://app/', () => {
  assert.equal(appUrl(), `${SCHEME}://${HOST}/`);
  assert.equal(appUrl(), 'mcstudio://app/');
});

test('协议特权：standard + supportFetchAPI 必须开着，不然页面 fetch 全废', () => {
  assert.equal(SCHEME_PRIVILEGES.scheme, 'mcstudio');
  assert.equal(SCHEME_PRIVILEGES.privileges.standard, true, 'standard:true 才有合法 origin');
  assert.equal(SCHEME_PRIVILEGES.privileges.supportFetchAPI, true, '没有它 fetch() 发不出去');
  assert.equal(SCHEME_PRIVILEGES.privileges.secure, true);
  assert.equal(SCHEME_PRIVILEGES.privileges.corsEnabled, true);
});

test('静态解析：/ 就是 index.html', () => {
  const hit = resolveStatic('/');
  assert.equal(hit.status, 200);
  assert.ok(hit.type.includes('text/html'), hit.type);
  assert.ok(hit.body.length > 0);
  assert.ok(/id="app"/.test(hit.body.toString('utf8')), '首页要有 #app 容器');
});

test('静态解析：/ui/app.js 四个资源都能取到且类型对', () => {
  for (const [file, wanted] of [
    ['app.js', 'text/javascript'],
    ['style.css', 'text/css'],
    ['recipe-view.css', 'text/css'],
    ['recipe-view.js', 'text/javascript'],
  ]) {
    const hit = resolveStatic(`/ui/${file}`);
    assert.equal(hit.status, 200, `${file} 该取得到`);
    assert.ok(hit.type.includes(wanted), `${file} 的类型该是 ${wanted}，实际 ${hit.type}`);
    assert.ok(hit.body.length > 0, `${file} 不该是空的`);
  }
});

test('静态解析：/ui/mcstudio-pixel.ttf 点阵字体能取到且类型是 font/ttf', () => {
  const hit = resolveStatic('/ui/mcstudio-pixel.ttf');
  assert.equal(hit.status, 200, '字体文件该取得到');
  assert.ok(hit.type.includes('font/ttf'), `类型该是 font/ttf，实际 ${hit.type}`);
  assert.ok(hit.body.length > 0, '字体不该是空的');
  assert.equal(hit.body.readUInt32BE(0), 0x00010000, '开头该是 sfnt 版本 1.0（真 TTF，不是占位文件）');
  // 补字体后缀不该顺手削弱目录穿越防护
  assert.equal(resolveStatic('/ui/..%2f..%2fpackage.json').status, 404, '目录穿越照样得挡住');
});

test('静态解析：白名单外的后缀不给服务', () => {
  const hit = resolveStatic('/ui/package.json');
  assert.equal(hit.status, 404, '.json 虽在白名单但 ui 下没有这个文件，也该 404');
  // 真正的敏感文件在项目根，不在 ui/ 下 —— 穿越请求必须拿不到
  const escape = resolveStatic('/ui/..%2f..%2fpackage.json');
  assert.equal(escape.status, 404, '目录穿越该被挡住');
});

test('静态解析：子路径一律不存在（只认一层文件名）', () => {
  assert.equal(resolveStatic('/ui/sub/dir.js')?.status ?? 404, 404);
  assert.equal(resolveStatic('/ui/a/b/c.css')?.status ?? 404, 404);
});

test('静态解析：/core/quest-conditions.js 能服务（界面 import ../core/ 用）', () => {
  const hit = resolveStatic('/core/quest-conditions.js');
  assert.equal(hit.status, 200, 'core 下的 .js 该取得到');
  assert.ok(hit.type.includes('text/javascript'), hit.type);
  assert.ok(hit.body.length > 0, '不该是空的');
  assert.match(hit.body.toString('utf8'), /export const TASK_TYPES/, '读到的该是 core 那份类型目录');
});

test('静态解析：/core/ 的目录穿越与子路径照样被挡住', () => {
  for (const bad of ['/core/../package.json', '/core/..%2f..%2fpackage.json', '/core/sub/dir.js']) {
    const hit = resolveStatic(bad);
    assert.equal(hit.status, 404, bad + ' 该 404');
    assert.equal(JSON.parse(hit.body.toString('utf8')).code, 'McNoStatic', bad + ' 该走静态 404');
  }
});

test('静态解析：不是静态路径返回 null（让给接口层）', () => {
  assert.equal(resolveStatic('/api/mcstudio/roots'), null);
  assert.equal(resolveStatic('/完全不认识'), null);
});

test('协议适配：URL 换成假 origin、方法与头原样带上', async () => {
  const request = new Request('mcstudio://app/api/mcstudio/roots?x=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ a: 1 }),
  });
  const adapted = await adaptProtocolRequest(request);
  assert.equal(adapted.method, 'POST');
  assert.ok(adapted.url.startsWith('http://mcstudio.local/api/mcstudio/roots'), adapted.url);
  assert.ok(adapted.url.endsWith('?x=1'), '查询串要保留');
  assert.equal(adapted.headers['content-type'], 'application/json');
  assert.deepEqual(await adapted.json(), { a: 1 });
});

test('协议适配：空请求体的 json() 返回空对象，不抛', async () => {
  const adapted = await adaptProtocolRequest(new Request('mcstudio://app/api/mcstudio/roots'));
  assert.deepEqual(await adapted.json(), {});
});

test('协议处理器：接口真通（roots 返回 ok + 数组）', async () => {
  const res = await handleProtocolRequest(new Request('mcstudio://app/api/mcstudio/roots'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.roots), 'roots 该是数组');
});

test('协议处理器：不认识的接口给 404 JSON', async () => {
  const res = await handleProtocolRequest(new Request('mcstudio://app/api/mcstudio/没有这个接口'));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /没有这个接口/);
});

test('协议处理器：静态首页整条链（按窗口实际会发请求的形状）', async () => {
  const res = await handleProtocolRequest(new Request(appUrl()));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/html'));
  const html = await res.text();
  assert.ok(/\/ui\/app\.js/.test(html), '首页要引 app.js');
});

test('冒烟：桌面版要走的那条链路真能跑通', async () => {
  // 跑真正的 smoke.mjs —— 它直接调协议处理器：取页面、取静态资源、调接口
  const outFile = path.join(ROOT, 'lab', 'desktop-smoke.json');
  fs.rmSync(outFile, { force: true });

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'packages', 'desktop', 'smoke.mjs')], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('exit', (value) => resolve(value));
    child.on('error', () => resolve(-1));
  });

  assert.equal(code, 0, 'smoke.mjs 应该以 0 退出');
  assert.ok(fs.existsSync(outFile), 'smoke.mjs 应该写出结果文件');

  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(report.error, '', `冒烟过程中不该有错误：${report.error}`);
  assert.ok(report.checks.length >= 15, `检查项太少：${report.checks.length}`);

  const failed = report.checks.filter((item) => !item.pass);
  assert.deepEqual(failed, [], `这些检查没过：${JSON.stringify(failed)}`);
  assert.equal(report.ok, true);
});

/**
 * 找本机有没有 Electron 运行时。
 *
 * 没有就跳过下面那条「真跑一遍入口链」的用例 —— 没装 Electron 的机器上
 * 不该因为它而红一片。返回 dist 目录（`electron.exe` 所在那层）。
 */
function findElectronExe() {
  const candidates = [
    path.join(ROOT, '.tools', 'electron-probe', 'node_modules', 'electron', 'dist'),
    path.join(ROOT, 'node_modules', 'electron', 'dist'),
  ];
  for (const dir of candidates) {
    const exe = path.join(dir, 'electron.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

test('自检：打包产物里那套入口链真能起来（不需要开窗口）', async (t) => {
  const electronExe = findElectronExe();
  const appDir = path.join(ROOT, 'dist', 'desktop', 'resources', 'app');

  if (!electronExe) {
    t.skip('本机没装 Electron，跳过');
    return;
  }
  if (!fs.existsSync(path.join(appDir, 'packages', 'desktop', 'main.mjs'))) {
    t.skip('还没打包过（dist/desktop 不存在），先跑 node packages/desktop/build.mjs');
    return;
  }

  const outFile = path.join(ROOT, 'lab', 'desktop-selfcheck.json');
  fs.rmSync(outFile, { force: true });

  // 用独立的 user-data-dir：默认那个可能被别的 Electron 进程占着
  const userData = path.join(ROOT, 'lab', '_selfcheck-ud');
  fs.rmSync(userData, { recursive: true, force: true });

  // ELECTRON_RUN_AS_NODE 会把 electron 降级成普通 node，那样 require('electron') 直接失败。
  // 注意要 delete 掉而不是设成空字符串 —— Electron 判断的是这个变量**存不存在**，
  // 存在且为空也算数（实测退出码 9）。
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

  const code = await new Promise((resolve) => {
    const child = spawn(
      electronExe,
      [
        // 这个沙箱里 chromium 的沙箱起不来，必须关掉，否则进程活不到能输出
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${userData}`,
        appDir,
        '--self-check',
        `--out=${outFile}`,
      ],
      {
        cwd: ROOT,
        // 输出接到 ignore：沙箱里管道会被拦（EPERM），这里也不需要看输出
        stdio: 'ignore',
        windowsHide: true,
        env: childEnv,
      },
    );

    // 硬超时。
    //
    // 为什么要：这个开发环境拦了 chromium 的 mojo 命名管道，Electron 走到
    // `platform_channel.cc: Check failed` 之后**不一定干净退出** —— 有时是
    // FATAL 崩溃（能收到 exit），有时是卡在 crashpad 上报那一步收不到。
    // 但自检结果在崩溃之前就已经写盘了，所以「进程还活着」不代表「没验成」。
    // 不设超时的话，一次收不到 exit 就会把整个测试跑挂死。
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退了 */
      }
      resolve('timeout');
    }, 45_000);

    child.on('exit', (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(-1);
    });
  });

  assert.ok(
    fs.existsSync(outFile),
    `自检没写出结果文件（退出码 ${code}）。这通常说明进程在入口就崩了。`,
  );

  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(report.error, '', `自检过程中报错：${report.error}`);

  const failed = report.checks.filter((item) => !item.pass);
  assert.deepEqual(failed, [], `这些检查没过：${JSON.stringify(failed)}`);
  assert.equal(report.ok, true, `自检没过，步骤：${JSON.stringify(report.steps)}`);

  // 关键几步必须在里面 —— 少一步说明流程被改坏过
  const names = report.checks.map((item) => item.name);
  assert.ok(names.some((n) => n.includes('app 可用')), '自检该验过 Electron API');
  assert.ok(names.some((n) => n.includes('首页')), '自检该验过页面');
  assert.ok(names.some((n) => n.includes('接口')), '自检该验过接口');

  fs.rmSync(userData, { recursive: true, force: true });
});

// --------------------------------------------------------------- 重打包要保住用户数据

/**
 * 这一组测的是「重打包会不会把用户数据抹掉」。
 *
 * 背景（2026-11-02 用户第二次报「快捷方式还是打不开」）：build.mjs 每次打包
 * 都 `rmSync(dist/desktop)` 整个重建，把 `safe-mode.stamp` 一起删了 ——
 * 而那个文件正是「这台机器普通模式会崩、要用安全模式」的唯一凭据。
 * 结果就是每打包一次，用户双击就必崩一次，且看起来和代码改动毫无关系。
 */
test('保住用户数据：safe-mode.stamp / boot.pending / 用户数据 三个都在清单里', () => {
  assert.deepEqual(KEEP_FILES, ['safe-mode.stamp', 'boot.pending']);
  assert.deepEqual(KEEP_DIRS, ['用户数据']);
});

test('保住用户数据：清空目录前先拷走，放回来时一个字节不差', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-keeptest-'));
  try {
    const outDir = path.join(tmp, 'desktop');
    fs.mkdirSync(path.join(outDir, '用户数据', 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'safe-mode.stamp'), '安全模式于 2026-11-02T12:00:00.000Z 成功加载过页面\r\n', 'utf8');
    fs.writeFileSync(path.join(outDir, 'boot.pending'), '2026-11-02T12:00:00.000Z plain\r\n', 'utf8');
    fs.writeFileSync(path.join(outDir, '用户数据', 'Local Storage', '记住的包.txt'), 'D:\\pcl2\\PCL 下载\\整合包\r\n', 'utf8');

    const saved = stashUserData(outDir, tmp);
    assert.deepEqual(saved.files.sort(), ['boot.pending', 'safe-mode.stamp']);
    assert.deepEqual(saved.dirs, ['用户数据']);
    assert.ok(saved.savedRoot, '该建了暂存目录');

    // 模拟 build.mjs：整个目录删掉重建（新的 exe 之类）
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'mcstudio.exe'), 'fake-exe', 'utf8');

    const { restored, failed } = restoreUserData(saved, outDir);
    assert.deepEqual(failed, [], '不该有放不回去的');
    assert.deepEqual(restored.sort(), ['boot.pending', 'safe-mode.stamp', '用户数据']);

    // 内容逐字对比，不是「文件在就算」
    assert.match(fs.readFileSync(path.join(outDir, 'safe-mode.stamp'), 'utf8'), /成功加载过页面/);
    assert.match(fs.readFileSync(path.join(outDir, 'boot.pending'), 'utf8'), /plain/);
    assert.equal(
      fs.readFileSync(path.join(outDir, '用户数据', 'Local Storage', '记住的包.txt'), 'utf8'),
      'D:\\pcl2\\PCL 下载\\整合包\r\n',
    );
    // 打包产物自己也在（放回去是「补」，不是「替换整目录」）
    assert.equal(fs.readFileSync(path.join(outDir, 'mcstudio.exe'), 'utf8'), 'fake-exe');
    // 暂存目录用完要清掉，别在临时目录里堆垃圾
    assert.equal(fs.existsSync(saved.savedRoot), false, '暂存目录该被删掉');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('保住用户数据：目录里本来就没有这些东西时，什么都不做也不报错', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-keeptest-'));
  try {
    const outDir = path.join(tmp, 'desktop');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'mcstudio.exe'), 'fake-exe', 'utf8');

    const saved = stashUserData(outDir, tmp);
    assert.deepEqual(saved.files, []);
    assert.deepEqual(saved.dirs, []);

    const { restored, failed } = restoreUserData(saved, outDir);
    assert.deepEqual(restored, []);
    assert.deepEqual(failed, []);
    assert.equal(fs.existsSync(path.join(outDir, 'mcstudio.exe')), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- 启动痕迹与安全模式标记

/**
 * 这一组测的是「主进程怎么决定这次是主角还是配角」。
 *
 * 背景（2026-11-02 第十次排查「快捷方式打不开」）：第二个进程拿不到单实例锁，
 * 原来的做法是弹一个「已经在运行了」的模态框。但已有实例这时正要把窗口顶到
 * 前面，弹框等于把刚顶出来的窗口又压回后面 —— 比不弹更糟。
 *
 * 而且配角**不能**写 `boot.pending`：它一声不响退出后痕迹还留在原地，
 * 用户下次双击会被误判成「上次崩过」，白白进安全模式。
 *
 * 这些逻辑必须能测，所以从 main.mjs 里搬到了 `boot-state.js`（纯 Node）。
 */
test('启动角色：拿到锁的才是主角，主角才写启动痕迹', () => {
  const primary = planStartup({ selfCheck: false, gotLock: true });
  assert.equal(primary.mode, 'primary');
  assert.equal(primary.markTrace, true);

  const secondary = planStartup({ selfCheck: false, gotLock: false });
  assert.equal(secondary.mode, 'secondary');
  assert.equal(secondary.markTrace, false, '配角不许写痕迹，否则下次双击被误判成崩过');
  assert.equal(secondary.notifyAlreadyRunning, false, '配角不许弹框抢焦点');
});

test('启动角色：自检不写痕迹，也不跟谁抢锁', () => {
  const selfCheck = planStartup({ selfCheck: true, gotLock: false });
  assert.equal(selfCheck.mode, 'self-check');
  assert.equal(selfCheck.markTrace, false);
  assert.equal(selfCheck.notifyAlreadyRunning, false);
});

test('启动痕迹：写出来就是「上次没开成」，加载成功后删掉', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-bootstate-'));
  try {
    assert.deepEqual(readBootState(tmp), { pending: false, safeStamp: false });

    assert.equal(markBootStarted(tmp, { safe: true }), true);
    assert.equal(fs.existsSync(bootPendingPath(tmp)), true, '痕迹该写出来');
    assert.match(fs.readFileSync(bootPendingPath(tmp), 'utf8'), /safe/);

    // 痕迹在 = 下次启动会自动改走安全模式
    assert.equal(readBootState(tmp).pending, true);

    assert.equal(clearBootStarted(tmp), true);
    assert.equal(readBootState(tmp).pending, false, '加载成功后痕迹该删掉');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('安全模式标记：安全模式成功加载过一次就写下来，下次直接按安全模式起', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-bootstate-'));
  try {
    assert.equal(markSafeModeWorks(tmp, new Date('2026-11-02T12:00:00.000Z')), true);
    assert.equal(fs.existsSync(safeModeStampPath(tmp)), true);
    assert.match(fs.readFileSync(safeModeStampPath(tmp), 'utf8'), /2026-11-02T12:00:00\.000Z/);
    assert.equal(readBootState(tmp).safeStamp, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('启动痕迹：目录写不了时不能因此不让程序起来', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-bootstate-'));
  try {
    // 拿一个不存在的目录当 exe 目录：写文件必然失败
    const bad = path.join(tmp, 'no-such-dir');
    assert.equal(markBootStarted(bad, { safe: false }), false, '写不下就该老实说失败');
    assert.equal(markSafeModeWorks(bad), false);
    // 清痕迹用的是 rmSync(force)，文件本来就不在时也不报错，算「已经清了」
    assert.equal(clearBootStarted(bad), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- 窗口「顶到前面」

/**
 * 这一组测的是「窗口该做哪几个动作」。
 *
 * 背景（2026-11-02 第十次排查）：实测有个实例进程还活着，但窗口被最小化到
 * 屏幕外了（`iconic=True`、窗口矩形 `-21333,-21333`）—— 用户在屏幕上什么都
 * 看不见，任务栏里却有个图标。这种状态下光 `focus()` 没用，必须先把它拉回
 * 主屏。
 *
 * 窗口 API 在本机没法验（沙箱拦 mojo 命名管道），但「什么情况做什么动作」
 * 可以确定，所以拆成纯函数来测。
 */
test('顶窗口：一切正常时不动它', () => {
  const plan = planWindowReveal({ destroyed: false, visible: true, minimized: false, onScreen: true });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.focus, false);
});

test('顶窗口：窗口藏起来了要 show，然后 focus', () => {
  const plan = planWindowReveal({ destroyed: false, visible: false, minimized: false, onScreen: true });
  assert.deepEqual(plan.actions, ['show', 'focus']);
  assert.equal(plan.focus, true);
});

test('顶窗口：最小化了要 restore', () => {
  const plan = planWindowReveal({ destroyed: false, visible: true, minimized: true, onScreen: true });
  assert.deepEqual(plan.actions, ['restore', 'focus']);
});

test('顶窗口：跑到屏幕外（-21333,-21333 那一类）要 center 拉回主屏', () => {
  const plan = planWindowReveal({ destroyed: false, visible: true, minimized: false, onScreen: false });
  assert.deepEqual(plan.actions, ['center', 'focus']);
  assert.match(plan.reason, /屏幕外/);
});

test('顶窗口：又藏又最小化又不在屏上，三个动作都要', () => {
  const plan = planWindowReveal({ destroyed: false, visible: false, minimized: true, onScreen: false });
  assert.deepEqual(plan.actions, ['show', 'restore', 'center', 'focus']);
});

test('顶窗口：窗口已经销毁了就什么都不做', () => {
  const plan = planWindowReveal({ destroyed: true, visible: false, minimized: true, onScreen: false });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.focus, false);
});

test('顶窗口：在不在屏幕上，按窗口矩形和屏幕工作区有没有交集来判', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  // 正常位置
  assert.equal(boundsOnScreen({ x: 100, y: 100, width: 1200, height: 800 }, displays), true);
  // 被系统挪到虚拟桌面外
  assert.equal(boundsOnScreen({ x: -21333, y: -21333, width: 1200, height: 800 }, displays), false);
  // 数值不对时保守处理（当在屏上，不乱动用户窗口）
  assert.equal(boundsOnScreen({ x: NaN, y: 0, width: 100, height: 100 }, displays), true);
  // 拿不到屏幕信息时也保守处理
  assert.equal(boundsOnScreen({ x: -21333, y: -21333, width: 100, height: 100 }, []), true);
});

// --------------------------------------------------------------- 启动方式

/**
 * 这一组测的是「怎么把程序叫起来」。
 *
 * 背景（2026-11-02 第十一次排查，用户第三次报「快捷方式打不开」）：
 * 实测这台机器上不带 `--no-sandbox` 启动 Electron **必崩 0x80000003，而且崩在
 * 我们的 JS 之前** —— 日志一行都没写。所以 `main.mjs` 里那句
 * `appendSwitch('no-sandbox')` 救不了场，**命令行层面就得把参数带全**。
 */
test('启动参数：快捷方式必须带 --safe-mode 和 --no-sandbox', () => {
  assert.match(SHORTCUT_ARGS, /--safe-mode/);
  assert.match(SHORTCUT_ARGS, /--no-sandbox/);
});

test('启动降级链：从最保守的兜底档到最激进的普通档，一档比一档保守', () => {
  assert.equal(LAUNCH_ATTEMPTS.length, 3);
  assert.deepEqual(LAUNCH_ATTEMPTS[0].flags, [], '第一档是普通模式（什么都不加）');
  assert.ok(LAUNCH_ATTEMPTS[1].flags.includes('--no-sandbox'), '第二档必须关 sandbox');
  assert.ok(LAUNCH_ATTEMPTS[2].flags.includes('--single-process'), '第三档再加单进程');
  // 每一档都不能比上一档更激进：普通模式那档绝对不能出现 no-sandbox 以外的强制开关
  assert.deepEqual(LAUNCH_ATTEMPTS[0].flags, []);
});

test('启动.cmd：内容必须纯 ASCII（cmd.exe 按 GBK 读，混进中文就乱码）', () => {
  const cmd = buildLaunchCmd();
  assert.equal(isAsciiOnly(cmd), true);
  assert.match(cmd, /set ELECTRON_RUN_AS_NODE=/, '得先清掉这个变量，否则 exe 当普通 Node 跑');
  assert.match(cmd, /for %%f in \("\*\.exe"\)/, 'exe 名字用通配符抓，不写死（中文名 exe cmd 会静默拒绝执行）');
  assert.match(cmd, /cmd-trace\.txt/, '要有痕迹文件，不然用户报障我们看不到');
});

test('启动.cmd：降级链每一档都要出现，且第一档不带参数', () => {
  const cmd = buildLaunchCmd();
  assert.match(cmd, /if "%ATTEMPT%"=="1" set "FLAGS="/);
  assert.match(cmd, /if "%ATTEMPT%"=="2" set "FLAGS=--safe-mode --no-sandbox"/);
  assert.match(cmd, /if "%ATTEMPT%"=="3" set "FLAGS=--safe-mode --no-sandbox --single-process --in-process-gpu"/);
  assert.match(cmd, /goto :retry/);
});

test('启动.cmd：混进中文时自检要能抓住', () => {
  assert.equal(isAsciiOnly('hello'), true);
  assert.equal(isAsciiOnly('整合包工作室'), false);
});

test('快捷方式脚本：正文纯 ASCII，中文路径靠 base64 传（PowerShell 读 UTF-8 会乱码）', () => {
  const script = buildShortcutScript({
    linkPath: 'D:\\桌面\\整合包工作室.lnk',
    targetPath: 'D:\\程序\\dist\\desktop\\mcstudio.exe',
    args: SHORTCUT_ARGS,
    iconPath: 'D:\\程序\\dist\\desktop\\resources\\app\\packages\\desktop\\app.ico',
    workingDir: 'D:\\程序\\dist\\desktop',
  });
  assert.equal(isAsciiOnly(script), true, '脚本正文里不能有中文');
  assert.match(script, /CreateShortcut/);
  assert.match(script, /\$link\.Save\(\)/);
  assert.match(script, /FromBase64String/, '路径要走 base64');
  // 目标路径的中文应该出现在 base64 里，而不是明文
  const b64 = Buffer.from('D:\\程序\\dist\\desktop\\mcstudio.exe', 'utf8').toString('base64');
  assert.ok(script.includes(b64), '目标路径的 base64 该在脚本里');
});

test('快捷方式脚本：参数要原样带上去（少了 --no-sandbox 就是必崩那一档）', () => {
  const script = buildShortcutScript({
    linkPath: 'C:\\a.lnk',
    targetPath: 'C:\\mcstudio.exe',
    args: SHORTCUT_ARGS,
  });
  const b64 = Buffer.from(SHORTCUT_ARGS, 'utf8').toString('base64');
  assert.ok(script.includes(b64), '参数得写进去');
});

test('快捷方式脚本：跑法用 -EncodedCommand，绕开引号转义', () => {
  const plan = shortcutSpawnPlan('Write-Host 1');
  assert.equal(plan.file, 'powershell');
  assert.ok(plan.args.includes('-EncodedCommand'));
  // 解回来应该还是原文
  const decoded = Buffer.from(plan.args[plan.args.length - 1], 'base64').toString('utf16le');
  assert.equal(decoded, 'Write-Host 1');
});
