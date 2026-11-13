/**
 * 自定义协议层：把 `mcstudio://app/...` 请求翻译成 dispatchStudioRequest 能处理的形状。
 *
 * ## 为什么要有它（2026-11-01 用户拍板「不用做插件模式和 web 模式了」）
 *
 * 桌面版原来靠一个本地 HTTP 服务（`packages/server/server.js`）供页面和接口：
 * 窗口加载 `http://127.0.0.1:7457/`。这条路能用，但带着一串包袱 ——
 * 端口被占要回退、防火墙可能提示、浏览器兜底要维护、退出要记得关服务。
 * 用户明确说只留桌面版，所以整层换成 Electron 的自定义协议：
 * 界面从 `mcstudio://app/` 读，接口还是原来那套 `dispatchStudioRequest`，
 * **业务逻辑一行不动**（界面和工具走同一套底层这条原则不破）。
 *
 * 为什么单独一个文件：protocol 处理器本质是「把 Electron 的 Request 翻译成
 * lib/host/api.js 认识的形状」——这段跟窗口、跟 Electron 生命周期都没关系，
 * 是纯逻辑，抽出来才能在普通 Node 测试里跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchStudioRequest, API_BASE } from '../../lib/host/api.js';

/** 协议名。窗口地址就是 `mcstudio://app/`。 */
export const SCHEME = 'mcstudio';
/** 协议的 host 段。自定义协议要 standard:true 才有合法 origin，host 必须有值。 */
export const HOST = 'app';

/**
 * 协议要注册的特权。
 *
 * - `standard: true` —— 有了它 `mcstudio://app/x` 才是「合法 URL」，
 *   `location.origin` 才有值，相对路径（`/api/...`）才解析得出来。
 * - `supportFetchAPI: true` —— 页面里的 `fetch()` 才能发到这个协议上。
 * - `secure: true` —— 当成安全上下文，避免某些 Web API 静默不可用。
 * - `corsEnabled: true` —— 允许页面跨到这个协议上取资源。
 *
 * **必须在 app ready 之前调 registerSchemesAsPrivileged**，晚了静默无效。
 */
export const SCHEME_PRIVILEGES = {
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};

/** UI 静态文件的目录（源码里和打包后都是「本文件上两级 / packages / ui」）。 */
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
/** 核心逻辑静态文件的目录（与 ui 平级，界面 import ../core/ 时就落到这里）。 */
const CORE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core');

/** 静态文件的白名单后缀 → content-type。 */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** 一个假 origin：dispatchStudioRequest 里的处理函数会用 `new URL(request.url)`。 */
const FAKE_ORIGIN = 'http://mcstudio.local';

/** 统一的 404 响应（静态文件没找到 / 后缀不在白名单 / 路径非法）。 */
function static404(pathname) {
  return Response.json(
    { ok: false, error: `没有这个文件：${pathname}`, code: 'McNoStatic' },
    { status: 404 },
  );
}

/**
 * 找一个静态文件。返回 `{status, type, body}` 或 null（不是静态请求）。
 *
 * 只认一层文件名（和 server.js 一样）：`/` → index.html，`/ui/xxx` → xxx，
 * `/core/xxx` → xxx（基准目录换成 CORE_DIR，安全校验与 /ui/ 完全相同）。
 * `../` 穿越在正则这一关就被挡掉，不需要额外规范化比较。
 *
 * @param {string} pathname 不带查询串的路径
 * @returns {{status: number, type: string, body: Buffer}|null}
 */
export function resolveStatic(pathname) {
  let rel = null;
  let base = UI_DIR;
  if (pathname === '/') rel = 'index.html';
  else if (pathname.startsWith('/ui/')) rel = pathname.slice('/ui/'.length);
  else if (pathname.startsWith('/core/')) {
    rel = pathname.slice('/core/'.length);
    base = CORE_DIR;
  }
  if (rel === null) return null;

  const type = TYPES[path.extname(rel).toLowerCase()];
  if (!type) return { status: 404, type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ ok: false, error: `没有这个文件：${pathname}`, code: 'McNoStatic' })) };
  if (!/^[A-Za-z0-9._-]+$/.test(rel) || rel.includes('..')) {
    return { status: 404, type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ ok: false, error: `没有这个文件：${pathname}`, code: 'McNoStatic' })) };
  }

  try {
    const data = fs.readFileSync(path.join(base, rel));
    return { status: 200, type, body: data };
  } catch {
    return { status: 404, type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ ok: false, error: `没有这个文件：${pathname}`, code: 'McNoStatic' })) };
  }
}

/**
 * 把 Electron 的 protocol Request 翻译成 dispatchStudioRequest 要的形状。
 *
 * 关键点：
 * - Electron 的 Request 没有 json() 帮手，请求体要自己读 —— 这里只缓存一次，
 *   文本和 JSON 各取所需（和 server.js 的 adapt 一个思路）。
 * - url 会被换成假 origin 下的同路径：协议处理函数里的业务代码只看路径，
 *   不关心协议本身是什么。
 *
 * @param {Request} request protocol.handle 给的 Request（fetch API 形状）
 * @returns {Promise<object>} dispatchStudioRequest 认的 request
 */
export async function adaptProtocolRequest(request) {
  const incoming = new URL(request.url);
  // 接口路径要带 API_BASE 前缀（dispatchStudioRequest 会把它剥掉）；
  // 协议 URL 里的路径就是 `/api/mcstudio/...`，原样接上假 origin 即可。
  const url = FAKE_ORIGIN + incoming.pathname + incoming.search;

  const text = async () => {
    try {
      return await request.text();
    } catch {
      return '';
    }
  };

  return {
    url,
    method: request.method ?? 'GET',
    headers: Object.fromEntries(request.headers?.entries?.() ?? []),
    text,
    json: async () => {
      const raw = await text();
      if (!raw.trim()) return {};
      return JSON.parse(raw);
    },
  };
}

/**
 * protocol.handle 要挂的处理器。
 *
 * 结构和 server.js 的 http 回调一样：先静态，再接口，最后兜 500。
 * 区别只是返回值从「写 ServerResponse」变成「直接 return Response」——
 * protocol.handle 认的就是这个。
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleProtocolRequest(request) {
  try {
    const incoming = new URL(request.url);
    const pathname = incoming.pathname;

    // 不是接口路径，先看是不是工作台自己的页面 / 脚本
    if (!pathname.startsWith(API_BASE)) {
      const hit = resolveStatic(pathname);
      if (hit) {
        return new Response(hit.body, {
          status: hit.status,
          headers: { 'content-type': hit.type, 'cache-control': 'no-cache' },
        });
      }
      return static404(pathname);
    }

    const adapted = await adaptProtocolRequest(request);
    const response = await dispatchStudioRequest(adapted);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { ok: false, error: message, hint: '', code: 'McServerCrash' },
      { status: 500 },
    );
  }
}

/** 窗口要加载的首页地址。 */
export function appUrl() {
  return `${SCHEME}://${HOST}/`;
}
