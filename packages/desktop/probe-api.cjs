/**
 * 探一下：为什么 `require('electron')` 在这个进程里找不到模块。
 *
 * Electron 主进程里它本该是内建模块。既然报「Cannot find module」，
 * 就得先搞清楚我们到底在不在主进程、内建模块表里有没有 electron。
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const OUT = path.join(__dirname, '..', '..', 'lab', 'desktop-api-probe4.json');

const result = {
  processType: process.type ?? '(未定义)',
  isMainFrame: typeof process.mainModule,
  argv: process.argv.slice(0, 5),
  execPath: process.execPath,
  builtinsHasElectron: Array.isArray(Module.builtinModules) ? Module.builtinModules.includes('electron') : null,
  builtinsSample: Array.isArray(Module.builtinModules) ? Module.builtinModules.slice(0, 8) : [],
  electronVersion: process.versions.electron ?? '',
  requirePaths: [],
  tries: {},
};

// 试几个不同的取法，把每个的报错原样记下来
for (const name of ['electron', 'node:electron', 'original-fs']) {
  try {
    const got = require(name);
    result.tries[name] = { ok: true, type: typeof got, keys: got && typeof got === 'object' ? Object.keys(got).slice(0, 20) : [] };
  } catch (error) {
    result.tries[name] = { ok: false, error: String(error && error.message ? error.message.split('\n')[0] : error) };
  }
}

// 用 Module._resolveFilename 试试内建解析路径
try {
  result.resolved = Module._resolveFilename('electron', module);
} catch (error) {
  result.resolveError = String(error && error.message ? error.message.split('\n')[0] : error);
}

// 直接找全局有没有挂东西
result.globalKeys = Object.keys(globalThis).filter((k) => /electron|app|Browser/i.test(k)).slice(0, 20);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
process.exit(0);
