/**
 * 桌面壳的冒烟检查 —— **不依赖 Electron 的窗口**。
 *
 * 为什么不做真窗口：这个开发环境把子进程的命名管道（mojo）挡了，Electron 起窗口时会
 * `FATAL: platform_channel.cc: Check failed ... 拒绝访问`，窗口根本起不来。
 * 那是环境的限制，不是代码的问题。所以这里退一步，把「窗口里会用到的东西」全验一遍。
 *
 * ## 2026-11-01 协议化之后
 *
 * 界面不再走本地 HTTP 服务，改走 `mcstudio://app/` 自定义协议。
 * 协议处理器（`protocol.js`）是纯逻辑 —— 不 import electron，普通 Node 就能跑：
 *
 *   1. `/` 返回工作台页面（HTML 里确实引了 app.js / style.css / recipe-view.css）
 *   2. 四个静态资源都能取到，而且 content-type 对
 *   3. 页面要调的接口（`/api/mcstudio/roots`）通
 *   4. 不存在的文件给 404、目录穿越被挡住
 *
 * 结论写进 `lab/desktop-smoke.json`，跑完读文件就行。
 *
 * 跑法：`node packages/desktop/smoke.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleProtocolRequest, appUrl } from './protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'lab', 'desktop-smoke.json');

/** 结果攒在这里，最后一次性写盘。 */
const result = { ok: false, steps: [], checks: [], error: '' };

/** 记一步。 */
function step(name, extra) {
  result.steps.push(extra === undefined ? name : `${name}：${extra}`);
}

/** 记一条检查结论。失败不抛，先记完所有能记的。 */
function check(name, pass, detail) {
  result.checks.push({ name, pass: Boolean(pass), detail: String(detail ?? '') });
}

/** 按协议处理器的入口发一个请求，返回状态码、content-type 和正文。 */
async function grab(url, init) {
  const res = await handleProtocolRequest(new Request(url, init));
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  return { status: res.status, type, text };
}

async function main() {
  const base = appUrl();
  step('协议地址', base);

  try {
    // ---- 1. 首页是工作台页面
    const page = await grab(base);
    step('取到首页', `${page.status}，${page.text.length} 字节`);
    check('首页 200', page.status === 200, String(page.status));
    check('首页是 HTML', page.type.includes('text/html'), page.type);
    check('引了 app.js', /\/ui\/app\.js/.test(page.text), '');
    check('引了 style.css', /\/ui\/style\.css/.test(page.text), '');
    check('引了 recipe-view.css', /\/ui\/recipe-view\.css/.test(page.text), '');
    check('有 #app 容器', /id="app"/.test(page.text), '');

    // ---- 2. 四个静态资源都取得到
    for (const [file, wanted] of [
      ['app.js', 'text/javascript'],
      ['style.css', 'text/css'],
      ['recipe-view.css', 'text/css'],
      ['recipe-view.js', 'text/javascript'],
    ]) {
      const asset = await grab(new URL(`/ui/${file}`, base).href);
      check(`${file} 能取到`, asset.status === 200 && asset.text.length > 0, `${asset.status}，${asset.text.length} 字节`);
      check(`${file} 的类型对`, asset.type.includes(wanted), asset.type);
    }

    // ---- 3. 接口通 —— 这是页面加载后第一个真正的请求
    const api = await grab(new URL('/api/mcstudio/roots', base).href);
    let body = null;
    try {
      body = JSON.parse(api.text);
    } catch {
      body = null;
    }
    step('调了一次接口', `${api.status}，${api.text.slice(0, 80)}`);
    check('接口 200', api.status === 200, String(api.status));
    check('接口返回 JSON 且 ok', Boolean(body?.ok), api.text.slice(0, 120));
    check('接口认得根目录', Array.isArray(body?.roots), JSON.stringify(Object.keys(body ?? {})));

    // ---- 4. 不存在的静态文件要给 404，不能把别的文件吐出来
    const missing = await grab(new URL('/ui/不存在.js', base).href);
    check('不存在的文件是 404', missing.status === 404, String(missing.status));

    // ---- 5. 目录穿越要挡住
    const escape = await grab(new URL('/ui/..%2f..%2fpackage.json', base).href);
    check('禁止目录穿越', escape.status === 404, `${escape.status}`);

    result.ok = result.checks.every((item) => item.pass);
  } catch (error) {
    result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  }
}

await main();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
process.exit(result.ok ? 0 : 1);
