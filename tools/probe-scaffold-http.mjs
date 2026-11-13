/**
 * 探针：通过真实的 registerStudioApi 路由层调一次 /scaffold/preview，
 * 确认面板读的字段（targetText / fileCount / totalText / java / installer / steps）
 * 一个都不缺。
 *
 * 只算计划，不下载、不写盘。用法：
 *   node --import ./test/register.mjs tools/probe-scaffold-http.mjs
 */
import { registerStudioApi } from '../lib/host/api.js';

const API_BASE = '/api/mcstudio';
const MC_ROOT = 'lab\\_scaffold\\mcroot';

function fakeConnection() {
  const routes = new Map();
  return {
    routes,
    fetch: {
      register(def) {
        routes.set(def.path, def);
      },
    },
  };
}

const conn = fakeConnection();
registerStudioApi(conn);
console.log('注册路由数：', conn.routes.size);

const route = conn.routes.get(`${API_BASE}/scaffold/preview`);
if (!route) {
  console.error('没有 /scaffold/preview 这条路由');
  process.exit(1);
}

const url = `http://localhost${API_BASE}/scaffold/preview`
  + `?mcRoot=${encodeURIComponent(MC_ROOT)}`
  + `&name=${encodeURIComponent('探针包')}`
  + `&mcVersion=1.21.1`
  + '&loader=neoforge';

const started = Date.now();
const res = await route.fetch(new Request(url));
const body = await res.json();
console.log('用时', ((Date.now() - started) / 1000).toFixed(1), '秒；HTTP', res.status);

if (!body.ok) {
  console.error('失败：', body.error, body.hint ?? '');
  process.exit(1);
}

// 面板实际会读的字段，一个都不能缺
const wanted = [
  'name', 'mcRoot', 'targetDir', 'targetText', 'mcVersion', 'loader', 'loaderVersion',
  'fileCount', 'vanillaFiles', 'assetFiles', 'loaderFiles',
  'totalBytes', 'totalText', 'java', 'installer', 'steps', 'warnings',
];
const missing = wanted.filter((k) => body[k] === undefined);
console.log('缺字段：', missing.length ? missing.join(', ') : '无');
console.log('目标：', body.targetText);
console.log('要下：', body.fileCount, '个文件 /', body.totalText,
  `（本体 ${body.vanillaFiles}、资源 ${body.assetFiles}、加载器 ${body.loaderFiles}）`);
console.log('Java：', body.java ? `${body.java.path}（${body.java.version}）` : '没找到');
console.log('安装器：', body.installer?.fileName ?? '不用');
console.log('步骤：', body.steps.map((s) => `${s.done ? '[已有]' : '[要装]'} ${s.title}`).join(' | '));
console.log('提醒：', body.warnings.length ? body.warnings.join('；') : '无');

if (missing.length) process.exit(1);
console.log('\n面板要的字段全齐。');
