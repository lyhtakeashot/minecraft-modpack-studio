/**
 * 探针：通过真实的 registerStudioApi 路由层真跑一次 /scaffold/apply。
 *
 * 走的是面板点「开始装」时那条路：POST → planScaffold → applyScaffold
 * → 下安装器 → 下原版/加载器依赖 → 跑安装器打补丁 → 建实例。
 *
 * 需要能拉起 Java（安装器那一步），所以在默认沙箱里会 spawn EPERM，
 * 得用 danger-full-access 跑。
 *
 * 用法：node --import ./test/register.mjs tools/probe-scaffold-http-apply.mjs [包名]
 */
import { registerStudioApi } from '../lib/host/api.js';

const API_BASE = '/api/mcstudio';
const MC_ROOT = 'lab\\_scaffold\\mcroot';
const NAME = process.argv[2] ?? '路由装出来的包';

function fakeConnection() {
  const routes = new Map();
  return { routes, fetch: { register(def) { routes.set(def.path, def); } } };
}

const conn = fakeConnection();
registerStudioApi(conn);

const route = conn.routes.get(`${API_BASE}/scaffold/apply`);
if (!route) {
  console.error('没有 /scaffold/apply 这条路由');
  process.exit(1);
}

const started = Date.now();
const res = await route.fetch(new Request(`http://localhost${API_BASE}/scaffold/apply`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    mcRoot: MC_ROOT,
    name: NAME,
    mcVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: '21.1.228',
  }),
}));
const body = await res.json();
console.log('用时', ((Date.now() - started) / 1000).toFixed(1), '秒；HTTP', res.status);

if (!body.ok) {
  console.error('失败：', body.error);
  if (body.hint) console.error('提示：', body.hint);
  process.exit(1);
}

console.log('装好了：', body.targetDir);
console.log('继承自：', body.inheritsFrom);
console.log('用时（宿主内部）：', body.seconds?.toFixed?.(1), '秒');
console.log('原版新下：', body.filesVanilla, '个；加载器新下：', body.filesLoader, '个');
console.log('步骤：');
for (const s of body.steps ?? []) console.log(`  ${s.done ? '[已有]' : '[要装]'} ${s.title}`);
console.log('阶段：');
for (const s of body.stages ?? []) console.log(`  ${s.key}: ${s.status} ${s.detail ?? ''}`);
