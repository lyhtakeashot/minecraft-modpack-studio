/**
 * 面板接口（lib/host/api.js）的单测。
 *
 * 这层的风险不是算错数，而是「界面调不通」——路由没注册上、路径写错、
 * 异常没兜住变成 500 空白页。所以用一个假的 connection 把注册下来的
 * fetch 函数真的调用一遍，走完整的 Request → Response 链路。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { API_BASE, registerStudioApi, resetStudioApiCache } from '../lib/host/api.js';
import { handleNameClear } from '../lib/host/name-completion.js';
import { clearLocksCache } from '../lib/host/mod-update-locks.js';
import { setCfpaFetch } from '../packages/core/cfpa-names.js';
import { makeZip } from './make-zip.mjs';

/** 假 connection：只实现 fetch.register，把路由收进一张表。 */
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

/** 发一个请求并解出 JSON。method 可指定 POST（带 query 参数，简化测试写法）。 */
async function call(conn, suffix, params = {}, method = 'GET') {
  const qs = new URLSearchParams(params).toString();
  const url = `http://localhost${API_BASE}${suffix}${qs ? `?${qs}` : ''}`;
  const route = conn.routes.get(API_BASE + suffix);
  assert.ok(route, `路由没注册：${API_BASE}${suffix}`);
  const res = await route.fetch(new Request(url, { method }));
  return { status: res.status, body: await res.json() };
}

/**
 * 真正按界面那样发：POST + JSON body（参数**不在**查询串里）。
 *
 * ## 为什么要有这个（2026-11-02 用户报「全部收进列表 → 左下角显示没有目录」）
 *
 * 界面的 `post()` 走的是 JSON body，而后端原来只读 URL 查询串 ——
 * 两侧永远对不上，于是「收进列表」「浏览…」全都报「缺少目录」。
 * 而之前的测试一律把参数塞进查询串（见上面的 call()），**测试和界面走的不是一条路**，
 * 所以一百条用例全绿也照样有 bug。
 *
 * 这个助手的意义就是：**让测试用界面那种方式发请求**。
 */
async function postJson(conn, suffix, payload = {}) {
  const route = conn.routes.get(API_BASE + suffix);
  assert.ok(route, `路由没注册：${API_BASE}${suffix}`);
  const url = `http://localhost${API_BASE}${suffix}`;
  const res = await route.fetch(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
  return { status: res.status, body: await res.json() };
}

/** 造一个最小的假实例目录（只有版本 json，没有 mods）。 */
function makeFakeInstance() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-api-'));
  const dir = path.join(root, 'versions', 'DemoPack');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'DemoPack.json'),
    JSON.stringify({ id: 'DemoPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
    'utf8',
  );
  return { root, dir };
}

/**
 * 造一个装着**多个**实例的根目录（versions/ 里躺两个包）。
 *
 * 用来复现用户报的那个错：「这个目录下有 3 个实例，需要指定 instanceId」。
 * 这类目录必须能被界面展开成「一行一个包」，所以 /roots/scan 得把每个实例的
 * 名字、版本、加载器一起带回来。
 */
function makeFakeMultiInstance() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-multi-'));
  for (const id of ['PackOne', 'PackTwo']) {
    const dir = path.join(root, 'versions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({ id, mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
      'utf8',
    );
  }
  return { root };
}

test('注册 81 条路由，全部挂在 /api/mcstudio 下', () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  assert.equal(conn.routes.size, 81);
  for (const p of conn.routes.keys()) {
    assert.ok(p.startsWith(`${API_BASE}/`), `路径前缀不对：${p}`);
  }
  // 选文件夹的两条路由必须在，否则界面上那个按钮点了没反应
  assert.ok(conn.routes.has(`${API_BASE}/pick-folder`));
  assert.ok(conn.routes.has(`${API_BASE}/pick-folder/status`));
  // 手动添加 / 移除整合包目录的两条（2026-11-02「识别坏了」修复）
  assert.ok(conn.routes.has(`${API_BASE}/roots/add`), '缺路由 /roots/add');
  assert.ok(conn.routes.has(`${API_BASE}/roots/remove`), '缺路由 /roots/remove');
  // 深度搜索（2026-11-02：用户选一个大目录，自动往下找整合包）
  assert.ok(conn.routes.has(`${API_BASE}/roots/scan`), '缺路由 /roots/scan');
  // 改配方的六条（含 2026-11-08 加的批量预览 / 批量写入）
  for (const suffix of [
    '/recipes', '/recipe', '/recipe/preview', '/recipe/apply',
    '/recipe/batch/preview', '/recipe/batch/apply',
  ]) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  // 任务书的二十五条（含从零建任务 / 建章节 / 拖拽画布 / 右键编辑节点 / 装饰图 / 条件类型目录
  // 以及 2026-11-09 蓝图式编辑的「追加物品要求 / 复制节点 / 空白处生成节点」六条）
  for (const suffix of [
    '/questbook', '/quests', '/quest', '/quest/condition-types', '/quest/preview', '/quest/apply',
    '/quest/add/preview', '/quest/add/apply', '/quest/chapter/preview', '/quest/chapter/apply',
    '/quest/canvas', '/quest/move/preview', '/quest/move/apply',
    '/quest/node/preview', '/quest/node/apply', '/quest/node/delete/preview', '/quest/node/delete/apply',
    '/quest/node/items/preview', '/quest/node/items/apply',
    '/quest/clone/preview', '/quest/clone/apply',
    '/quest/spawn/preview', '/quest/spawn/apply',
    '/quest/image/preview', '/quest/image/apply',
  ]) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  // 找 mod / 装 mod 的四条
  for (const suffix of ['/mod-search', '/mod-versions', '/mod-install/preview', '/mod-install/apply']) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  // 整包兼容性体检（2026-11-06）：只读
  assert.ok(conn.routes.has(`${API_BASE}/mod-compat`), '缺路由 /mod-compat');
  // 检查 mod 更新（2026-11-07）：检查 / 算清单 / 真升级三条
  for (const suffix of ['/mod-update/check', '/mod-update/preview', '/mod-update/apply']) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  assert.deepEqual(conn.routes.get(`${API_BASE}/mod-update/check`).methods, ['GET', 'POST']);
  assert.deepEqual(conn.routes.get(`${API_BASE}/mod-update/preview`).methods, ['GET', 'POST']);
  assert.deepEqual(conn.routes.get(`${API_BASE}/mod-update/apply`).methods, ['POST']);
  // 安全增强（2026-11-07 第二轮）：锁定名单 + 一键撤回
  for (const suffix of ['/mod-update/locks', '/mod-update/rollback/preview', '/mod-update/rollback/apply']) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  assert.deepEqual(conn.routes.get(`${API_BASE}/mod-update/locks`).methods, ['GET', 'POST']);
  assert.deepEqual(conn.routes.get(`${API_BASE}/mod-update/rollback/preview`).methods, ['GET', 'POST']);
  assert.deepEqual(conn.routes.get(`${API_BASE}/mod-update/rollback/apply`).methods, ['POST']);
  // 从零建包的两条
  for (const suffix of ['/pack/preview', '/pack/apply']) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  // 从零装底座（选版本向导）的两条
  for (const suffix of ['/scaffold/preview', '/scaffold/apply']) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  // 打包的两条
  for (const suffix of ['/export/preview', '/export/build']) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  // 物品图标一条（画布/列表/加任务表单都靠它）
  assert.ok(conn.routes.has(`${API_BASE}/item-icons`), '缺路由 /item-icons');
  // 物品网格（2026-11-05）：JEI 那种 9×16 翻页面板 + 标签清单
  assert.ok(conn.routes.has(`${API_BASE}/item-grid`), '缺路由 /item-grid');
  assert.ok(conn.routes.has(`${API_BASE}/item-tags`), '缺路由 /item-tags');
  assert.deepEqual(conn.routes.get(`${API_BASE}/item-grid`).methods, ['GET', 'POST']);
  // 游戏真值清单（2026-11-07 任务③）：status 只读、import 写软件数据目录只收 POST
  assert.ok(conn.routes.has(`${API_BASE}/item-truth/status`), '缺路由 /item-truth/status');
  assert.ok(conn.routes.has(`${API_BASE}/item-truth/import`), '缺路由 /item-truth/import');
  assert.deepEqual(conn.routes.get(`${API_BASE}/item-truth/status`).methods, ['GET']);
  assert.deepEqual(conn.routes.get(`${API_BASE}/item-truth/import`).methods, ['POST']);
  // 中文名补全（2026-11-05）：preview 只读不联网，apply 只收 POST
  assert.ok(conn.routes.has(`${API_BASE}/name/preview`), '缺路由 /name/preview');
  assert.ok(conn.routes.has(`${API_BASE}/name/apply`), '缺路由 /name/apply');
  assert.deepEqual(conn.routes.get(`${API_BASE}/name/preview`).methods, ['GET', 'POST']);
  assert.deepEqual(conn.routes.get(`${API_BASE}/name/apply`).methods, ['POST']);
  // 图标来源的两条（游戏导出的高清图标）
  for (const suffix of ['/icon-export/status', '/icon-export/scan']) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  // 去 MC百科 找单张图标的一条（本地 jar 里没有贴图时的兜底）
  assert.ok(conn.routes.has(API_BASE + '/item-icon/web'), '缺路由 /item-icon/web');
  // 启动验证的两条（第 42、43 条）：preview 绝不启动进程，apply 必须显式 apply:true
  for (const suffix of ['/launch/preview', '/launch/apply']) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  assert.deepEqual(conn.routes.get(`${API_BASE}/launch/preview`).methods, ['GET', 'POST']);
  assert.deepEqual(conn.routes.get(`${API_BASE}/launch/apply`).methods, ['POST']);
  // 第 44 条：进度查询（只读，GET/POST 都收 —— 参数少时 GET 更方便）
  assert.ok(conn.routes.has(`${API_BASE}/progress`), '缺路由 /progress');
  assert.deepEqual(conn.routes.get(`${API_BASE}/progress`).methods, ['GET', 'POST']);
  // 第 45 条：看配方长什么样（JEI 那种合成表，只读，GET/POST 都收）
  assert.ok(conn.routes.has(`${API_BASE}/recipe/view`), '缺路由 /recipe/view');
  assert.deepEqual(conn.routes.get(`${API_BASE}/recipe/view`).methods, ['GET', 'POST']);
  // 分析类的六条（2026-11-03：从插件版的模型工具搬过来的那批只读检查）
  for (const suffix of [
    '/analysis/overlap', '/analysis/progress', '/analysis/mod',
    '/analysis/recipe-path', '/analysis/recipe-uses', '/analysis/kubejs',
  ]) {
    assert.ok(conn.routes.has(API_BASE + suffix), `缺路由 ${suffix}`);
  }
  // 内置 MCP 服务器的两条（2026-11-04）：给模型改包用的那条通路
  assert.ok(conn.routes.has(`${API_BASE}/mcp/config`), '缺路由 /mcp/config');
  assert.ok(conn.routes.has(`${API_BASE}/mcp/selftest`), '缺路由 /mcp/selftest');
});

test('真写盘的是 POST；算清单的 preview 收发都行；其余都是 GET', () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const posts = new Set([
    `${API_BASE}/recipe/apply`,
    // 批量写入：真把多条改动一次写盘，只收 POST
    `${API_BASE}/recipe/batch/apply`,
    // 手动添加 / 移除整合包目录：会写持久化的记住列表
    `${API_BASE}/roots/add`,
    `${API_BASE}/roots/remove`,
    `${API_BASE}/quest/apply`,
    `${API_BASE}/quest/add/apply`,
    `${API_BASE}/quest/chapter/apply`,
    `${API_BASE}/quest/move/apply`,
    `${API_BASE}/quest/node/apply`,
    `${API_BASE}/quest/node/delete/apply`,
    // 蓝图式编辑：三条真写盘（追加物品要求 / 复制节点 / 空白处生成节点）
    `${API_BASE}/quest/node/items/apply`,
    `${API_BASE}/quest/clone/apply`,
    `${API_BASE}/quest/spawn/apply`,
    `${API_BASE}/quest/image/apply`,
    `${API_BASE}/mod-install/apply`,
    // 真升级 mod：停用旧 jar + 下载新 jar，只收 POST
    `${API_BASE}/mod-update/apply`,
    // 安全增强：真撤回只收 POST（撤回也绝不删文件）
    `${API_BASE}/mod-update/rollback/apply`,
    `${API_BASE}/pack/apply`,
    `${API_BASE}/scaffold/apply`,
    `${API_BASE}/export/build`,
    `${API_BASE}/icon-export/scan`,
    // 真启动 JVM 的那一条：只收 POST，且 handler 里还要求显式 apply:true
    `${API_BASE}/launch/apply`,
    // 中文名补全：只有 apply（POST）才真下载落盘
    `${API_BASE}/name/apply`,
    // 导入游戏真值清单：写软件自己的数据目录（item-truth.json），只收 POST
    `${API_BASE}/item-truth/import`,
  ]);
  const both = new Set([
    // 改已有任务的预览：界面用 POST 发 body，之前只登记 GET 会 405（第 4 批 B 修）
    `${API_BASE}/quest/preview`,
    // 改配方预览：界面 previewRecipe() 用 post() 发 JSON body，之前只登记 GET 会 405（2026-11-08 修）
    `${API_BASE}/recipe/preview`,
    // 批量预览：只算不写，界面走 POST body，GET 也照收（参数少时好调试）
    `${API_BASE}/recipe/batch/preview`,
    `${API_BASE}/mod-install/preview`, `${API_BASE}/pack/preview`, `${API_BASE}/scaffold/preview`, `${API_BASE}/export/preview`,
    `${API_BASE}/quest/add/preview`, `${API_BASE}/quest/chapter/preview`, `${API_BASE}/quest/move/preview`,
    `${API_BASE}/quest/node/preview`, `${API_BASE}/quest/node/delete/preview`,
    // 蓝图式编辑的三条预览：只算不写，界面走 POST body，GET 也照收
    `${API_BASE}/quest/node/items/preview`,
    `${API_BASE}/quest/clone/preview`,
    `${API_BASE}/quest/spawn/preview`,
    // 装饰图的预览：只算不写，参数少时 GET 也照收
    `${API_BASE}/quest/image/preview`,
    // 一次可能问几十上百个物品，参数放 body 更省 URL 长度；小批量时 GET 也照收
    `${API_BASE}/item-icons`,
    // 一章的背景图资源 ID 一批发过来，POST 为主；GET 好调试
    `${API_BASE}/quest/images`,
    `${API_BASE}/icon-export/status`,
    `${API_BASE}/item-icon/web`,
    // 启动计划只是读版本 json + 扫磁盘，GET 也行；参数一多就 POST
    `${API_BASE}/launch/preview`,
    // 进度查询只读，GET/POST 都收
    `${API_BASE}/progress`,
    // 看配方长什么样只是读 jar 里的原始 JSON，不写盘；GET 好调试，POST 也不拦
    `${API_BASE}/recipe/view`,
    // 分析类的六条全是只读，GET/POST 都收
    `${API_BASE}/analysis/overlap`, `${API_BASE}/analysis/progress`, `${API_BASE}/analysis/mod`,
    `${API_BASE}/analysis/recipe-path`, `${API_BASE}/analysis/recipe-uses`, `${API_BASE}/analysis/kubejs`,
    // 物品网格与标签清单（2026-11-05 JEI 式侧边栏）：都是只读。
    // 网格要带 q/page，界面走 GET；标签清单参数多时可能改 POST，两边都收。
    `${API_BASE}/item-grid`, `${API_BASE}/item-tags`,
    // 中文名补全的 preview 只读不联网，GET/POST 都收
    `${API_BASE}/name/preview`,
    // 整包兼容性体检（2026-11-06）：只读，一个文件都不写；GET/POST 都收
    `${API_BASE}/mod-compat`,
    // 检查更新只读联网、算清单只算不写；整块 check 可能很长，POST 为主，GET 也照收
    `${API_BASE}/mod-update/check`, `${API_BASE}/mod-update/preview`,
    // 锁定名单：GET 只读、POST 才写软件数据目录；撤回清单只算不写
    `${API_BASE}/mod-update/locks`, `${API_BASE}/mod-update/rollback/preview`,
  ]);
  for (const [p, def] of conn.routes) {
    const expected = both.has(p) ? ['GET', 'POST'] : posts.has(p) ? ['POST'] : ['GET'];
    assert.deepEqual(def.methods, expected, `${p} 的方法不对`);
  }
});

test('/quest/preview 界面用 POST 发 JSON body 不再 405：真能算出改动（2026-11-04 第 4 批 B 修）', async () => {
  // 界面 previewRename() 一直是 post('/quest/preview', …)，而路由以前只登记 GET，
  // 真机会 405 McBadMethod；UI 替身不校验 method，所以之前全绿也测不出。
  // 这里造一套最小任务书，走完整「注册路由 → POST JSON body → handler」链路。
  const questDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-preview-'));
  fs.mkdirSync(path.join(questDir, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(questDir, 'lang'), { recursive: true });
  fs.writeFileSync(
    path.join(questDir, 'chapters', 'ch1.snbt'),
    '{\n\tid: "AAAA0001"\n\tquests: [ { id: "BBBB0001" x: 0d y: 0d } ]\n}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(questDir, 'lang', 'zh_cn.snbt'),
    '{\n\t"quest.BBBB0001.title": "打铁"\n}\n',
    'utf8',
  );
  try {
    const conn = fakeConnection();
    registerStudioApi(conn);
    const body = { questDir, questId: 'BBBB0001', title: '打铁改名' };
    const post = await postJson(conn, '/quest/preview', body);
    assert.equal(post.status, 200, `POST 预览被拦了：${JSON.stringify(post.body)}`);
    assert.equal(post.body.ok, true);
    assert.equal(post.body.locale, 'zh_cn', '没显式给语言时应优先中文');
    const title = (post.body.changes ?? []).find((c) => c.field === 'title');
    assert.ok(title, '预览里没有标题改动');
    assert.equal(title.before, '打铁');
    assert.equal(title.after, '打铁改名');
    assert.equal(post.body.changed, true);
    // 预览绝不写盘：语言文件一个字节都没变
    assert.match(fs.readFileSync(path.join(questDir, 'lang', 'zh_cn.snbt'), 'utf8'), /打铁"/);
    // 注册成 GET/POST 双收后，老的 GET 调试方式也不能被弄坏
    const get = await call(conn, '/quest/preview', body);
    assert.equal(get.status, 200);
    assert.equal(get.body.ok, true);
  } finally {
    fs.rmSync(questDir, { recursive: true, force: true });
  }
});

test('/pick-folder/status 没开过对话框时是 idle，不报错', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/pick-folder/status');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'idle');
  assert.equal(body.path, '');
});

test('/roots 返回 ok 且带 roots 数组', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/roots');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.roots));
});

test('/roots/add 缺 dir 返回 400', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/roots/add', {}, 'POST');
  assert.equal(status, 400);
  assert.match(body.error, /缺少目录/);
});

test('/roots/add 对不存在的目录返回 400 并带路径', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const nope = path.join(os.tmpdir(), 'mcstudio-nope-xyz');
  const { status, body } = await call(conn, '/roots/add', { dir: nope }, 'POST');
  assert.equal(status, 400);
  assert.match(body.error, /目录不存在/);
});

test('/roots/add 目录里扫不出实例时返回 400', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-empty-'));
  const { status, body } = await call(conn, '/roots/add', { dir: empty }, 'POST');
  assert.equal(status, 400);
  assert.match(body.error, /找不到 Minecraft 实例/);
});

test('/roots/add 收下假实例的根目录，重启（新连接）后 /roots 还能看到', async () => {
  // 存储位置指到临时目录，不碰 PLUGIN_ROOT/.mcstudio
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-store-'));
  process.env.MCSTUDIO_DATA_DIR = store;
  try {
    const { root } = makeFakeInstance();
    resetStudioApiCache();
    const conn = fakeConnection();
    registerStudioApi(conn);
    const add = await call(conn, '/roots/add', { dir: root }, 'POST');
    assert.equal(add.status, 200);
    assert.equal(add.body.ok, true);
    assert.equal(add.body.added.length, 1);
    assert.equal(add.body.added[0].instances, 1);
    // 存储文件真的落了盘
    const saved = JSON.parse(fs.readFileSync(path.join(store, 'remembered-roots.json'), 'utf8'));
    assert.deepEqual(saved.roots, [root]);
    // 模拟重启：清内存缓存（clearRememberedRoots 会删文件，所以先备份再还原）
    const disk = fs.readFileSync(path.join(store, 'remembered-roots.json'), 'utf8');
    resetStudioApiCache();
    fs.writeFileSync(path.join(store, 'remembered-roots.json'), disk, 'utf8');
    const conn2 = fakeConnection();
    registerStudioApi(conn2);
    const roots = await call(conn2, '/roots');
    const hit = roots.body.roots.find((r) => r.dir === root);
    assert.ok(hit, `重启后 /roots 里找不到 ${root}`);
    assert.equal(hit.instances, 1);
  } finally {
    delete process.env.MCSTUDIO_DATA_DIR;
    resetStudioApiCache();
  }
});

test('/roots/remove 把目录从记住列表里拿掉', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-store-'));
  process.env.MCSTUDIO_DATA_DIR = store;
  try {
    const { root } = makeFakeInstance();
    resetStudioApiCache();
    const conn = fakeConnection();
    registerStudioApi(conn);
    await call(conn, '/roots/add', { dir: root }, 'POST');
    const del = await call(conn, '/roots/remove', { dir: root }, 'POST');
    assert.equal(del.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(store, 'remembered-roots.json'), 'utf8'));
    assert.deepEqual(saved.roots, []);
    const roots = await call(conn, '/roots');
    assert.ok(!roots.body.roots.some((r) => r.dir === root), '移除后 /roots 不该再出现');
  } finally {
    delete process.env.MCSTUDIO_DATA_DIR;
    resetStudioApiCache();
  }
});

test('/roots 给「上次打开过」的目录带 remembered 标记和原始记住值；下钻后按展示路径删不掉，按 rememberedDir 才删得掉（2026-11-04 第 3 批 B）', async () => {
  // 造「记住的上层目录本身扫不出实例，要往下钻一层才扫到」的布局：
  //   outer/PackA/versions/DemoPack —— 记住的是 outer，展示出来的是 outer/PackA。
  // 这正是以前「点 ✕ 返回 200 却没删掉」的根因。
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-store-'));
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-outer-'));
  const pack = path.join(outer, 'PackA', 'versions', 'DemoPack');
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(
    path.join(pack, 'DemoPack.json'),
    JSON.stringify({ id: 'DemoPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
    'utf8',
  );
  process.env.MCSTUDIO_DATA_DIR = store;
  try {
    resetStudioApiCache(); // 清内存 + 删掉存储文件
    // 直接落一份「记住了 outer」的记录，模拟用户上次手填路径记下来的
    fs.writeFileSync(path.join(store, 'remembered-roots.json'), JSON.stringify({ roots: [outer] }), 'utf8');
    const conn = fakeConnection();
    registerStudioApi(conn);

    const roots = await call(conn, '/roots');
    assert.equal(roots.status, 200);
    const hit = roots.body.roots.find((r) => r.rememberedDir === outer);
    assert.ok(hit, '/roots 没把记住的目录标出来');
    assert.equal(hit.remembered, true);
    assert.equal(hit.dir, path.join(outer, 'PackA'), '展示出来的是下钻后的子目录');
    assert.notEqual(hit.dir, outer, '这个用例必须真的发生下钻，否则测不到点子上');

    // 旧界面干的蠢事：拿展示路径去删 —— 后端精确匹配，删不掉（返回 200 但没生效）
    const wrong = await postJson(conn, '/roots/remove', { dir: hit.dir });
    assert.equal(wrong.status, 200);
    let saved = JSON.parse(fs.readFileSync(path.join(store, 'remembered-roots.json'), 'utf8'));
    assert.deepEqual(saved.roots, [outer], '拿展示路径本不该删掉，说明这个坑没复现出来');

    // 新界面发 rememberedDir（原始记住值）—— 一发即中
    const right = await postJson(conn, '/roots/remove', { dir: hit.rememberedDir });
    assert.equal(right.status, 200);
    saved = JSON.parse(fs.readFileSync(path.join(store, 'remembered-roots.json'), 'utf8'));
    assert.deepEqual(saved.roots, [], '按 rememberedDir 应该真的删掉');
  } finally {
    delete process.env.MCSTUDIO_DATA_DIR;
    resetStudioApiCache();
  }
});

test('/roots 自动探测出来的常见位置不带 remembered 标记（只有用户记的才给 ✕）', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { body } = await call(conn, '/roots');
  for (const r of body.roots) {
    if (r.rememberedDir) continue;
    assert.notEqual(r.remembered, true, `自动项 ${r.dir} 不该被标成记住的`);
  }
});

test('/roots/scan 缺 dir 返回 400', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/roots/scan', {});
  assert.equal(status, 400);
  assert.match(body.error, /缺少目录/);
});

test('/roots/scan 目录不存在时返回 400 并带路径', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const nope = path.join(os.tmpdir(), 'mcstudio-nope-scan-xyz');
  const { status, body } = await call(conn, '/roots/scan', { dir: nope });
  assert.equal(status, 400);
  assert.match(body.error, /目录不存在/);
});

test('/roots/scan 从一个大目录往下翻几层，把埋着的假实例找出来（2026-11-02 用户要的「选个大概位置」）', async () => {
  // 造一个三层嵌套：upper/a/b/versions/DemoPack —— expandRoot 只挖两层，翻不到
  const upper = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-deep-'));
  const deep = path.join(upper, 'a', 'b');
  const dir = path.join(deep, 'versions', 'DemoPack');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'DemoPack.json'),
    JSON.stringify({ id: 'DemoPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
    'utf8',
  );

  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/roots/scan', { dir: upper });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.roots));
  assert.equal(body.roots.length, 1, `应该只找到 1 处，实际 ${body.roots.length}`);
  assert.equal(body.roots[0].dir, deep);
  assert.equal(body.roots[0].instances, 1);
  // 三条刹车都要有回执，界面靠它告诉用户「没翻完」还是「翻完了」
  assert.equal(body.stopped, '');
  assert.ok(body.visited > 0);
  assert.ok(typeof body.ms === 'number');
});

test('/roots/scan 只读：翻完不往记住列表里写一个字', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-store-'));
  process.env.MCSTUDIO_DATA_DIR = store;
  try {
    const { root } = makeFakeInstance();
    resetStudioApiCache();
    const conn = fakeConnection();
    registerStudioApi(conn);
    const scan = await call(conn, '/roots/scan', { dir: root });
    assert.equal(scan.status, 200);
    assert.equal(scan.body.roots.length, 1);
    // 扫描不该落盘 —— 用户点「收进列表」才该写
    assert.ok(
      !fs.existsSync(path.join(store, 'remembered-roots.json')),
      '深度搜索不该写 remembered-roots.json',
    );
  } finally {
    delete process.env.MCSTUDIO_DATA_DIR;
    resetStudioApiCache();
  }
});

test('/roots/scan 挖到的目录能立刻用 /roots/add 收进列表', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-store-'));
  process.env.MCSTUDIO_DATA_DIR = store;
  try {
    const upper = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-deep2-'));
    const deep = path.join(upper, 'x', 'y');
    const dir = path.join(deep, 'versions', 'DemoPack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'DemoPack.json'),
      JSON.stringify({ id: 'DemoPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
      'utf8',
    );

    resetStudioApiCache();
    const conn = fakeConnection();
    registerStudioApi(conn);
    const scan = await call(conn, '/roots/scan', { dir: upper });
    const hit = scan.body.roots[0];
    assert.ok(hit, '深度搜索没找到东西');

    const add = await call(conn, '/roots/add', { dir: hit.dir }, 'POST');
    assert.equal(add.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(store, 'remembered-roots.json'), 'utf8'));
    assert.ok(saved.roots.includes(hit.dir), `记住列表里应该有 ${hit.dir}`);
  } finally {
    delete process.env.MCSTUDIO_DATA_DIR;
    resetStudioApiCache();
  }
});

// ------------------------------------------------------------------
// 2026-11-02 用户报障修完后的回归：请求方式必须和界面一样。
// ------------------------------------------------------------------

test('/roots/add 用界面那种 POST body 也能收下（原来只读查询串 → 报「没有目录」）', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-store-'));
  process.env.MCSTUDIO_DATA_DIR = store;
  try {
    const { root } = makeFakeInstance();
    resetStudioApiCache();
    const conn = fakeConnection();
    registerStudioApi(conn);

    const add = await postJson(conn, '/roots/add', { dir: root });
    assert.equal(add.status, 200, `POST body 形式被拒了：${JSON.stringify(add.body)}`);
    assert.equal(add.body.ok, true);
    assert.equal(add.body.added.length, 1);

    const saved = JSON.parse(fs.readFileSync(path.join(store, 'remembered-roots.json'), 'utf8'));
    assert.deepEqual(saved.roots, [root]);
  } finally {
    delete process.env.MCSTUDIO_DATA_DIR;
    resetStudioApiCache();
  }
});

test('/roots/add 用 POST body 时缺 dir 依然报「缺少目录」（而不是别的怪错）', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await postJson(conn, '/roots/add', {});
  assert.equal(status, 400);
  assert.match(body.error, /缺少目录/);
});

test('/roots/remove 用界面那种 POST body 也能移除', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-store-'));
  process.env.MCSTUDIO_DATA_DIR = store;
  try {
    const { root } = makeFakeInstance();
    resetStudioApiCache();
    const conn = fakeConnection();
    registerStudioApi(conn);
    await postJson(conn, '/roots/add', { dir: root });
    const del = await postJson(conn, '/roots/remove', { dir: root });
    assert.equal(del.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(store, 'remembered-roots.json'), 'utf8'));
    assert.deepEqual(saved.roots, []);
  } finally {
    delete process.env.MCSTUDIO_DATA_DIR;
    resetStudioApiCache();
  }
});

test('/roots/scan 每个结果都带着里面每个实例的名字（界面要靠它一行一个包）', async () => {
  const { root } = makeFakeMultiInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/roots/scan', { dir: root });

  assert.equal(status, 200);
  assert.equal(body.roots.length, 1);
  const hit = body.roots[0];
  assert.equal(hit.instances, 2);
  assert.ok(Array.isArray(hit.list), '结果里得有 list，界面靠它展开');
  assert.equal(hit.list.length, 2);
  assert.deepEqual(hit.list.map((i) => i.id).sort(), ['PackOne', 'PackTwo']);
  // 每个实例还得带得上版本和加载器，界面上要显示「1.21.1 · neoforge」
  for (const inst of hit.list) {
    assert.ok(inst.id, '实例得有名字');
    assert.ok('mcVersion' in inst, '实例得有 mcVersion');
    assert.ok('loader' in inst, '实例得有 loader');
  }
});

test('/roots/scan 挖到多实例目录时，每一行都能按 instanceId 直接打开（不再报「需要指定 instanceId」）', async () => {
  const { root } = makeFakeMultiInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const scan = await call(conn, '/roots/scan', { dir: root });
  const hit = scan.body.roots[0];
  assert.ok(hit.list.length >= 2, '这个用例要一个装着多个包的目录');

  // 界面的「打开」按钮就是拿 (dir, id) 去连 —— 必须能连上
  for (const inst of hit.list) {
    const summary = await call(conn, '/summary', { dir: root, id: inst.id });
    assert.equal(summary.status, 200, `${inst.id} 连不上：${JSON.stringify(summary.body)}`);
    assert.equal(summary.body.ok, true);
  }
});

test('/roots/scan 用界面那种 GET 查询串也能扫（读参数要认查询串这一路）', async () => {
  const { root } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/roots/scan', { dir: root });
  assert.equal(status, 200);
  assert.equal(body.roots.length, 1);
  assert.equal(body.roots[0].instances, 1);
});

test('/instances 能列出假实例', async () => {
  const { root } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/instances', { root });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.instances.length, 1);
  assert.equal(body.instances[0].id, 'DemoPack');
});

test('/instances 缺 root 返回 400 且提示是中文', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/instances');
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /缺少目录/);
});

test('/summary 缺 dir 返回 400，不是 500', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/summary');
  assert.equal(status, 400);
  assert.match(body.error, /缺少实例目录/);
});

test('/summary 对空实例返回 0 物品 0 配方', async () => {
  resetStudioApiCache();
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/summary', { dir });
  assert.equal(status, 200);
  assert.equal(body.instance.id, 'DemoPack');
  assert.equal(body.index.itemCount, 0);
  assert.equal(body.index.recipeCount, 0);
});

test('/items 没给关键字时直接返回空，不报错', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/items', { dir: 'D:\\does\\not\\matter' });
  assert.equal(status, 200);
  assert.equal(body.total, 0);
  assert.match(body.hint, /关键字/);
});

test('/items 对不存在的实例返回 400 并带路径', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/items', { dir: path.join(os.tmpdir(), 'mcstudio-nope-xyz'), q: 'diamond' });
  assert.equal(status, 400);
  assert.match(body.error, /目录不存在/);
});

// ---- 物品网格（2026-11-05：JEI 那种 9×16 翻页面板）----

/** 造一个装着 150 个物品 + 一个标签的假实例，够网格翻页和 `#` 搜索用。 */
function makeGridInstance() {
  const { root, dir } = makeFakeInstance();
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const lang = {};
  const tagValues = [];
  for (let i = 1; i <= 150; i++) {
    const key = `item.demo.thing_${i}`;
    lang[key] = i === 1 ? '钻石镐' : `测试物品${i}`;
    if (i <= 3) tagValues.push(`demo:thing_${i}`);
  }
  fs.writeFileSync(
    path.join(modsDir, 'demo.jar'),
    makeZip({
      'META-INF/mods.toml': 'modId="demo"\ndisplayName="演示模组"\nversion="1.0"\n',
      'assets/demo/lang/en_us.json': JSON.stringify(lang),
      'data/demo/tags/item/special.json': JSON.stringify({ values: tagValues }),
    }),
  );
  return { root, dir };
}

/**
 * 造一个「原版 + 两个 mod」的假实例，专门验网格的排序分组。
 *
 * 原版物品借一个 jar 里的 `assets/minecraft/lang`（真实包里由客户端 jar 提供），
 * 两个 mod 的显示名故意让字母序和命名空间顺序不同，好确认排序用的是 mod 名。
 */
function makeOrderInstance() {
  const { root, dir } = makeFakeInstance();
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(
    path.join(modsDir, 'vanilla-lang.jar'),
    makeZip({
      'assets/minecraft/lang/en_us.json': JSON.stringify({
        'item.minecraft.stone': '石头',
        'item.minecraft.dirt': '泥土',
      }),
    }),
  );
  fs.writeFileSync(
    path.join(modsDir, 'zeta.jar'),
    makeZip({
      'META-INF/mods.toml': 'modId="zeta"\ndisplayName="Zeta 模组"\nversion="1.0"\n',
      'assets/zeta/lang/en_us.json': JSON.stringify({ 'item.zeta.far': 'Zeta 物品' }),
    }),
  );
  fs.writeFileSync(
    path.join(modsDir, 'alpha.jar'),
    makeZip({
      'META-INF/mods.toml': 'modId="alpha"\ndisplayName="Alpha 模组"\nversion="1.0"\n',
      'assets/alpha/lang/en_us.json': JSON.stringify({ 'item.alpha.zzz': 'Alpha 物品' }),
    }),
  );
  return { root, dir };
}

test('/item-grid 不搜索时按 mod 分组，原版排在最前面（用户报「顺序奇怪」「原版没找齐」）', async () => {
  resetStudioApiCache();
  const { dir } = makeOrderInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await postJson(conn, '/item-grid', { dir });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.items.map((it) => it.id),
    ['minecraft:dirt', 'minecraft:stone', 'alpha:zzz', 'zeta:far'],
    '顺序该是：原版最前 → 各 mod 按显示名 → 组内按中文名',
  );
  assert.equal(body.items[0].mod, 'minecraft', '原版那条该标 minecraft');
  assert.equal(body.items[2].mod, 'Alpha 模组', '该标 mod 的显示名');
  // 同一个 mod 的物品必须连成一片，不能被别的 mod 拆开
  const seen = new Set();
  let prev = '';
  for (const it of body.items) {
    if (it.mod === prev) continue;
    assert.ok(!seen.has(it.mod), `mod「${it.mod}」被拆成了两段`);
    seen.add(it.mod);
    prev = it.mod;
  }
});

test('/item-grid 带了关键字就不重排（搜索结果按相关度）', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { dir } = makeGridInstance();
  const { body } = await postJson(conn, '/item-grid', { dir, q: '钻石镐' });
  assert.equal(body.items[0].id, 'demo:thing_1');
});

test('/item-grid 不带关键字也返回一页（JEI 不搜索时就是列全部）', async () => {
  resetStudioApiCache();
  const { dir } = makeGridInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await postJson(conn, '/item-grid', { dir });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.cols, 9, '列数没照 JEI 的 9');
  assert.equal(body.rows, 16, '行数没照 JEI 的 16');
  assert.equal(body.pageSize, 144, '一页不是 144');
  assert.equal(body.total, 150);
  assert.equal(body.pages, 2, '150 个物品该是 2 页');
  assert.equal(body.page, 1);
  assert.equal(body.items.length, 144, '第一页该满 144 格');
});

test('/item-grid 翻到第 2 页只剩剩下那几个', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { dir } = makeGridInstance();
  const { body } = await postJson(conn, '/item-grid', { dir, page: 2 });
  assert.equal(body.page, 2);
  assert.equal(body.items.length, 6, '150 - 144 = 6');
  assert.equal(body.offset, 144);
});

test('/item-grid 页码越界会被夹回来（停在第 5 页搜出 2 页的结果不能是空白）', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { dir } = makeGridInstance();
  const { body } = await postJson(conn, '/item-grid', { dir, page: 99 });
  assert.equal(body.page, 2, '页码没夹到最后一页');
  assert.ok(body.items.length > 0, '夹回来了却还是空页');
});

test('/item-grid 每个物品带 ID 和中文名，没有简介就不带 desc 字段', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { dir } = makeGridInstance();
  const { body } = await postJson(conn, '/item-grid', { dir, q: '钻石镐' });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].id, 'demo:thing_1');
  assert.equal(body.items[0].name, '钻石镐');
  assert.equal('desc' in body.items[0], false, '没简介却带了 desc 字段');
});

test('/item-grid 的 # 按标签搜能用（界面那个 # 符号）', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { dir } = makeGridInstance();
  const { body } = await postJson(conn, '/item-grid', { dir, q: '#special' });
  assert.equal(body.total, 3);
  assert.match(body.queryHint, /标签「special」/, '没告诉用户正在按标签搜');
});

test('/item-grid 的 @ 按 mod 搜能用', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { dir } = makeGridInstance();
  const { body } = await postJson(conn, '/item-grid', { dir, q: '@demo' });
  assert.equal(body.total, 150);
});

test('/item-grid 的拼音搜索能用（zuanshigao → 钻石镐）', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { dir } = makeGridInstance();
  const { body } = await postJson(conn, '/item-grid', { dir, q: 'zuanshigao' });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].id, 'demo:thing_1');
});

test('/item-grid 缺 dir 返回 400 且提示是中文', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await postJson(conn, '/item-grid', {});
  assert.equal(status, 400);
  assert.match(body.error, /目录/);
});

/** 造一个带 KubeJS 脚本现造物品的假实例（任务①：验证脚本物品真的进网格）。 */
function makeScriptGridInstance() {
  const { root, dir } = makeFakeInstance();
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(
    path.join(modsDir, 'demo.jar'),
    makeZip({
      'META-INF/mods.toml': 'modId="demo"\ndisplayName="演示模组"\nversion="1.0"\n',
      'assets/demo/lang/en_us.json': JSON.stringify({
        'item.demo.one': '一号物品',
        'item.demo.two': '二号物品',
      }),
    }),
  );
  const put = (rel, body) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  put('kubejs/startup_scripts/main.js', `
StartupEvents.registry('item', event => {
  event.create('script_ingot');
  event.create('createages:script_machine');
});
`);
  put('kubejs/assets/kubejs/lang/zh_cn.json', JSON.stringify({
    'item.kubejs.script_ingot': '脚本锭',
    'item.createages.script_machine': '脚本机械',
  }));
  return { root, dir };
}

test('/item-grid 把 KubeJS 脚本现造物品一起显示（补 19 个的界面口径）', async () => {
  resetStudioApiCache();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { dir } = makeScriptGridInstance();
  const { status, body } = await postJson(conn, '/item-grid', { dir });
  assert.equal(status, 200, JSON.stringify(body));
  const byId = new Map(body.items.map((it) => [it.id, it]));
  assert.ok(byId.has('kubejs:script_ingot'), '脚本 item 要进网格');
  assert.ok(byId.has('createages:script_machine'), '别的命名空间的脚本物品也要进网格');
  assert.equal(byId.get('kubejs:script_ingot').name, '脚本锭', '中文名从 kubejs lang 读到');
  assert.equal(byId.get('createages:script_machine').name, '脚本机械');
  // 2 个 jar 物品 + 2 个脚本物品 = 4，脚本物品一个都没被幽灵过滤掉
  assert.equal(body.total, 4);
  assert.equal(body.indexTotal, 4, 'indexTotal 要把脚本物品算进去');
  assert.equal(body.ghostCount, 0, 'createages / kubejs 命名空间由脚本认领，不该被标幽灵');
});

// ---- 游戏真值清单（2026-11-07 任务③：用户要「100% 精确」）----

/** 造一份探针 mod 导出的 jeidump.json（registries.item 只列游戏里真注册的一部分）。 */
function writeJeidump(dir, ids) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'jeidump.json');
  fs.writeFileSync(file, JSON.stringify({ config: {}, registries: { item: ids, block: [] }, types: [] }), 'utf8');
  return file;
}

/** 造一个「有幽灵物品」的假实例：ghost_ns 命名空间没 jar 认领、也没资源。 */
function makeGhostInstance() {
  const { root, dir } = makeFakeInstance();
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(
    path.join(modsDir, 'demo.jar'),
    makeZip({
      'META-INF/mods.toml': 'modId="demo"\ndisplayName="演示模组"\nversion="1.0"\n',
      'assets/demo/lang/en_us.json': JSON.stringify({ 'item.demo.real': '真物品' }),
      // 配方里提到一个没装 mod 的 ID → 幽灵（索引里有，游戏里不存在）
      'data/demo/recipe/x.json': JSON.stringify({ result: 'ghostmod:ghost_ingot' }),
    }),
  );
  return { root, dir };
}

/**
 * 任务③的核心回归：清单存软件自己的数据目录，按 dir|id 分键；
 * 用 POST JSON body 走界面那条路（GET+query 另有一条用例）。
 * 每条用例独立临时目录，finally 还原环境变量 + 清缓存，绝不碰真实 .mcstudio/。
 */
async function withTruthStore(fn) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-truth-api-'));
  const prev = process.env.MCSTUDIO_DATA_DIR;
  try {
    process.env.MCSTUDIO_DATA_DIR = store;
    resetStudioApiCache();
    await fn(store);
  } finally {
    if (prev === undefined) delete process.env.MCSTUDIO_DATA_DIR;
    else process.env.MCSTUDIO_DATA_DIR = prev;
    resetStudioApiCache();
  }
}

test('/item-grid 没导入游戏清单 → 默认「显示全部」、不假装精确（POST JSON body 这条界面路）', async () => {
  await withTruthStore(async () => {
    const { dir } = makeGridInstance();
    const conn = fakeConnection();
    registerStudioApi(conn);
    const { status, body } = await postJson(conn, '/item-grid', { dir });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.filter, 'all', '没导入清单时不该假装精确');
    assert.equal(body.hasTruth, false);
    assert.equal(body.showAll, false, '界面没带 showAll 时后端默认 false（有清单才会精确）');
    assert.equal(body.truthSource, '');
    assert.equal(body.hiddenCount, 0);
    assert.equal(body.total, 150, '没清单要退回老行为：150 个全显示');
    assert.equal(body.poolTotal, 150);
    assert.equal(body.indexTotal, 150);
    // 状态接口也要说「没有」，界面才好显示那句「还没导入游戏清单，当前显示全部」
    const st = await call(conn, '/item-truth/status', { dir });
    assert.equal(st.status, 200);
    assert.deepEqual(
      { has: st.body.has, source: st.body.source, count: st.body.count },
      { has: false, source: '', count: 0 },
    );
  });
});

test('/item-grid 导入游戏清单后 → 默认只显示清单里真有的、假条目 0、幽灵仍不显示', async () => {
  await withTruthStore(async (store) => {
    const { root, dir } = makeGhostInstance();
    const dump = writeJeidump(path.join(root, 'game'), ['demo:real']);
    const conn = fakeConnection();
    registerStudioApi(conn);

    const imported = await postJson(conn, '/item-truth/import', { dir, id: 'DemoPack', file: dump });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.has, true);
    assert.equal(imported.body.count, 1);
    assert.ok(fs.existsSync(path.join(store, 'item-truth.json')), '清单没落到软件数据目录');
    assert.equal(fs.existsSync(path.join(dir, 'item-truth.json')), false, '清单绝不能写进用户整合包');

    const { body } = await postJson(conn, '/item-grid', { dir });
    assert.equal(body.filter, 'truth', '导入清单后默认该切成 100% 精确');
    assert.equal(body.hasTruth, true);
    assert.ok(body.truthSource.endsWith('jeidump.json'), '要回报清单来自哪个文件');
    assert.equal(body.total, 1, '只该显示清单里那条真物品');
    assert.equal(body.items[0].id, 'demo:real');
    // 幽灵（ghostmod:ghost_ingot）本来就不在索引的非幽灵池里，精确口径更不能冒出来
    assert.ok(!body.items.some((it) => it.id.startsWith('ghostmod:')), '幽灵物品冒出来了');
    assert.equal(body.hiddenCount, 0, '索引里没有别的假条目，这里该是 0');
    assert.equal(body.poolTotal, 1, '幽灵在精确口径之前就已经被硬过滤掉了');

    // 状态接口：只回报有没有 / 来自哪 / 多少条，不回传整份清单
    const st = await call(conn, '/item-truth/status', { dir, id: 'DemoPack' });
    assert.equal(st.body.has, true);
    assert.equal(st.body.count, 1);
    assert.equal(st.body.ids, undefined);
  });
});

test('/item-grid 导入清单后 showAll=1 → total 回到 indexTotal、filter 回 all，幽灵仍不显示', async () => {
  await withTruthStore(async () => {
    const { root, dir } = makeGhostInstance();
    const dump = writeJeidump(path.join(root, 'game'), ['demo:real']);
    const conn = fakeConnection();
    registerStudioApi(conn);
    await postJson(conn, '/item-truth/import', { dir, id: 'DemoPack', file: dump });

    // 界面那条路：GET + query（loadGrid 用 api() 发 GET，参数在查询串里）
    const { body } = await call(conn, '/item-grid', { dir, id: 'DemoPack', showAll: '1' });
    assert.equal(body.showAll, true);
    assert.equal(body.filter, 'all', '勾了「显示全部」就该切回全索引');
    assert.equal(body.total, body.indexTotal, '总数要回到全索引口径');
    assert.equal(body.hiddenCount, 0);
    assert.ok(!body.items.some((it) => it.id.startsWith('ghostmod:')), '全部模式也不该放进幽灵');

    // POST JSON body 那条路（host-api 其它用例都这么发）也必须认 showAll
    const post = await postJson(conn, '/item-grid', { dir, id: 'DemoPack', showAll: '1' });
    assert.equal(post.body.filter, 'all');
    assert.equal(post.body.total, post.body.indexTotal);
  });
});

test('/item-grid 换包没重导清单 → 默认退回「显示全部」，不空白也不假装精确', async () => {
  await withTruthStore(async () => {
    const a = makeGridInstance();
    const b = makeGridInstance();
    const dump = writeJeidump(path.join(a.root, 'game'), ['demo:thing_1']);
    const conn = fakeConnection();
    registerStudioApi(conn);
    await postJson(conn, '/item-truth/import', { dir: a.dir, id: 'DemoPack', file: dump });

    // 给 A 导入了清单；切到 B（没导入）必须退回全显示，不能拿 A 的清单套 B
    const onA = await postJson(conn, '/item-grid', { dir: a.dir });
    assert.equal(onA.body.filter, 'truth');
    assert.equal(onA.body.total, 1);
    const onB = await postJson(conn, '/item-grid', { dir: b.dir });
    assert.equal(onB.body.filter, 'all', 'B 没导入清单，不该被 A 的清单影响');
    assert.equal(onB.body.hasTruth, false);
    assert.equal(onB.body.total, 150, '没清单就退回老行为（150 个全显示），绝不空白');
  });
});

test('/item-grid 导入清单后 q/@/#/拼音命中数不变、page 越界夹回、原版仍在前（逐条回归）', async () => {
  await withTruthStore(async () => {
    const { root, dir } = makeGridInstance();
    // 清单里放全部 150 个（真实包里游戏注册表该涵盖索引里的真物品）：
    // 这一组验证「精确口径不改变搜索/排序/分页语义」。
    const ids = Array.from({ length: 150 }, (_, i) => `demo:thing_${i + 1}`);
    const dump = writeJeidump(path.join(root, 'game'), ids);
    const conn = fakeConnection();
    registerStudioApi(conn);
    await postJson(conn, '/item-truth/import', { dir, id: 'DemoPack', file: dump });

    const diamond = await postJson(conn, '/item-grid', { dir, q: '钻石镐' });
    assert.equal(diamond.body.filter, 'truth');
    assert.equal(diamond.body.total, 1);
    assert.equal(diamond.body.items[0].id, 'demo:thing_1');

    const at = await postJson(conn, '/item-grid', { dir, q: '@demo' });
    assert.equal(at.body.total, 150, '@demo 该还是 150 条');

    const tag = await postJson(conn, '/item-grid', { dir, q: '#special' });
    assert.equal(tag.body.total, 3, '#special 该还是 3 条');

    const pinyin = await postJson(conn, '/item-grid', { dir, q: 'zuanshigao' });
    assert.equal(pinyin.body.total, 1);
    assert.equal(pinyin.body.items[0].id, 'demo:thing_1');

    const p2 = await postJson(conn, '/item-grid', { dir, page: 2 });
    assert.equal(p2.body.page, 2);
    assert.equal(p2.body.items.length, 6);

    const over = await postJson(conn, '/item-grid', { dir, page: 99 });
    assert.equal(over.body.page, 2, '页码越界还是夹回最后一页');
    assert.ok(over.body.items.length > 0);

    // 无关键字仍按相关度外的「mod 分组」排；这里只有 demo，一条不少即可。
    const all = await postJson(conn, '/item-grid', { dir });
    assert.equal(all.body.total, 150);
    assert.equal(all.body.filter, 'truth');
  });
});

test('/item-grid 假清单（空 registries.item）给 400 中文报错，不悄悄显示全部', async () => {
  await withTruthStore(async () => {
    const { root, dir } = makeGridInstance();
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ hello: 1 }), 'utf8');
    const conn = fakeConnection();
    registerStudioApi(conn);
    const { status, body } = await postJson(conn, '/item-truth/import', { dir, id: 'DemoPack', file: bad });
    assert.equal(status, 400);
    assert.match(body.error, /registries\.item/);
    assert.ok(body.hint, '要给一句下一步该怎么做的提示');
    // 导入失败后网格仍按「没清单」处理，不空白
    const grid = await postJson(conn, '/item-grid', { dir });
    assert.equal(grid.body.filter, 'all');
    assert.equal(grid.body.total, 150);
  });
});

test('/item-tags 列出标签，方块标签不混进来', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { dir } = makeGridInstance();
  const { status, body } = await postJson(conn, '/item-tags', { dir });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.tags.some((t) => t.tag === 'demo:special'), '没列出物品标签');
  assert.ok(!body.tags.some((t) => t.tag.startsWith('block:')), '方块标签混进来了');
  assert.equal(body.tags.find((t) => t.tag === 'demo:special').items, 3);
});

test('/item-tags 能按名字过滤（打几个字提示有哪些标签）', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { dir } = makeGridInstance();
  const { body } = await postJson(conn, '/item-tags', { dir, q: 'spec' });
  assert.ok(body.tags.every((t) => t.tag.includes('spec')));
  assert.ok(body.tags.length >= 1);
});

// ---- 中文名补全（2026-11-05：默认完全离线，只有点按钮才联网）----

/**
 * 造一份「假 CFPA 整包」：两份 zh_cn.json。
 * thing_1/2 补英文名、thing_3 补「完全没名字」、thing_4 自带中文名不该被覆盖；
 * 另混进带 % 的模板、四段键、别的命名空间、非语言文件，验证解析只认该认的。
 */
function fakeCfpaZip() {
  return makeZip({
    'assets/demo/lang/zh_cn.json': JSON.stringify({
      'item.demo.thing_1': '钻石镐',
      'item.demo.thing_2': '橡木箱',
      'block.demo.thing_3': '测试方块三',
      'item.demo.thing_4': '不该覆盖这个名字',
      'item.demo.bad': '带%的模板不要', // 带 % 的格式化模板要丢掉
      'item.demo.thing_1.too_long': '四段键不要', // 只认正好 3 段
    }),
    'assets/other/lang/zh_cn.json': JSON.stringify({ 'item.other.unused': '别的模组' }),
    'pack.mcmeta': '{}', // 不是语言文件，应该被跳过
    // fetchCfpaZip 会校验「整包 ≥ 100000 字节」，假包太小会被当成 HTML 错误页丢掉。
    // 用一个 zip 内的 store 条目撑大文件（不能往 zip 尾部追加裸字节，openZip 靠 EOCD 定位）。
    'padding.bin': 'x'.repeat(120000),
  });
}

/**
 * 造一个专门验中文名补全的假实例：
 * - thing_1 / thing_2 只有英文名（用户要的「有英文名的替换成中文」）；
 * - thing_3 连语言键都没有，靠模型文件进索引（用户要的「完全没名字的也补」）；
 * - thing_4 自带中文名，不该被覆盖。
 */
function makeNameInstance() {
  const { root, dir } = makeFakeInstance();
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(
    path.join(modsDir, 'demo.jar'),
    makeZip({
      'META-INF/mods.toml': 'modId="demo"\ndisplayName="演示模组"\nversion="1.0"\n',
      'assets/demo/lang/en_us.json': JSON.stringify({
        'item.demo.thing_1': 'Diamond Pickaxe',
        'item.demo.thing_2': 'Oak Crate',
        'item.demo.thing_4': '自带中文名',
      }),
      'assets/demo/models/item/thing_3.json': '{"parent":"minecraft:item/generated"}',
    }),
  );
  return { root, dir };
}

/** 造一个假 fetch：GitHub API 返回 tag/附件名，下载源返回整包字节。 */
function fakeCfpaFetch(zipBuffer) {
  return async (url) => {
    if (String(url).includes('api.github.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ([{
          tag_name: 'Snapshot-20261105000000',
          published_at: '2026-11-05T00:00:00Z',
          assets: [
            { name: 'Minecraft-Mod-Language-Modpack-1-21.zip' },
            { name: 'Minecraft-Mod-Language-Modpack-1-20.zip' },
          ],
        }]),
      };
    }
    return {
      ok: true,
      status: 200,
      // 真实的下载响应会带 content-length，界面靠它算百分比
      headers: {
        get: (name) => (String(name).toLowerCase() === 'content-length'
          ? String(zipBuffer.length)
          : null),
      },
      arrayBuffer: async () => zipBuffer.buffer.slice(
        zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength,
      ),
    };
  };
}

test('/name/preview 没下载过时只读、不带缓存、不联网也能答', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-name-'));
  const prev = process.env.MCSTUDIO_DATA_DIR;
  try {
    process.env.MCSTUDIO_DATA_DIR = store;
    handleNameClear(); // 确保这份临时目录是干净的
    setCfpaFetch(async () => { throw new Error('preview 绝不该联网'); });
    const conn = fakeConnection();
    registerStudioApi(conn);
    const { status, body } = await postJson(conn, '/name/preview', {});
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.cached, false);
    assert.equal(body.count, 0);
    assert.equal(body.license, 'CC BY-NC-SA 4.0');
    assert.match(body.project, /CFPAOrg/);
  } finally {
    setCfpaFetch(null);
    if (prev === undefined) delete process.env.MCSTUDIO_DATA_DIR;
    else process.env.MCSTUDIO_DATA_DIR = prev;
  }
});

test('/name/apply 下载整包→落盘→/item-grid 里的名字立刻变中文（已有中文名不覆盖）', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-name-'));
  const prev = process.env.MCSTUDIO_DATA_DIR;
  const zip = fakeCfpaZip();
  try {
    process.env.MCSTUDIO_DATA_DIR = store;
    handleNameClear();
    resetStudioApiCache();
    setCfpaFetch(fakeCfpaFetch(zip));

    const { dir } = makeNameInstance();
    const conn = fakeConnection();
    registerStudioApi(conn);

    // 不带关键字拉全部 4 条（都在第 1 页），按 ID 做映射，别依赖返回顺序。
    const before = await postJson(conn, '/item-grid', { dir });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    const beforeNames = Object.fromEntries(before.body.items.map((it) => [it.id, it.name]));
    assert.equal(beforeNames['demo:thing_1'], 'Diamond Pickaxe'); // 纯英文
    assert.equal(beforeNames['demo:thing_2'], 'Oak Crate'); // 纯英文
    assert.equal(beforeNames['demo:thing_3'], ''); // 完全没名字
    assert.equal(beforeNames['demo:thing_4'], '自带中文名'); // 已有中文

    // 下载：只有这一步会联网（被假 fetch 接住），并把名字落进软件数据目录
    const applied = await postJson(conn, '/name/apply', { dir });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.count, 5, '整包里应该解出 5 个可用名字（demo 四个 + other 一个）');
    assert.equal(applied.body.files, 2);
    assert.equal(applied.body.asset, 'Minecraft-Mod-Language-Modpack-1-21.zip', '要挑版本大的那个包');
    assert.equal(applied.body.license, 'CC BY-NC-SA 4.0');
    assert.ok(fs.existsSync(path.join(store, 'cfpa-zh-names.json')), '缓存没落到软件数据目录');

    // 下载进度槽（2026-11-06）：界面的进度条就靠它。
    assert.ok(applied.body.job, 'apply 的返回体里应该带 job（界面要靠它收尾）');
    assert.equal(applied.body.job.kind, 'name-fill');
    assert.equal(applied.body.job.status, 'done', '下载完的槽应该是 done');
    assert.equal(applied.body.job.name, '下载中文名（CFPA 汉化包）');
    assert.ok(applied.body.job.total > 0, '假包有 content-length 时总量该是字节数');

    // 按 kind 也能查到这个槽（界面轮询时只认得 kind）
    const progress = await postJson(conn, '/progress', { kind: 'name-fill' });
    assert.equal(progress.status, 200, JSON.stringify(progress.body));
    assert.equal(progress.body.found, true, '按 kind 查不到 name-fill 的槽');
    assert.equal(progress.body.job.kind, 'name-fill');
    assert.equal(progress.body.job.status, 'done');
    assert.equal(progress.body.job.percent, 100, '下载完了进度该是 100%');

    // 缓存状态：preview 立刻能看到
    const preview = await postJson(conn, '/name/preview', {});
    assert.equal(preview.body.cached, true);
    assert.equal(preview.body.count, 5);

    // 关键：已缓存的索引不用等 10 分钟 TTL，下一请求就套上新名字
    const after = await postJson(conn, '/item-grid', { dir });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    const byId = Object.fromEntries(after.body.items.map((it) => [it.id, it.name]));
    assert.equal(byId['demo:thing_1'], '钻石镐', '纯英文名没替换成中文'); // 纯英文 → 中文
    assert.equal(byId['demo:thing_2'], '橡木箱', '纯英文名没替换成中文');
    assert.equal(byId['demo:thing_3'], '测试方块三', '完全没名字的没补上'); // 无名 → 补
    assert.equal(byId['demo:thing_4'], '自带中文名', '已有中文名被覆盖了'); // 已有中文 → 不覆盖
  } finally {
    setCfpaFetch(null);
    handleNameClear();
    if (prev === undefined) delete process.env.MCSTUDIO_DATA_DIR;
    else process.env.MCSTUDIO_DATA_DIR = prev;
    resetStudioApiCache();
  }
});

test('/mods 对空实例返回空清单', async () => {
  resetStudioApiCache();
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/mods', { dir });
  assert.equal(status, 200);
  assert.deepEqual(body.mods, []);
});

// 下面这几条只走「不发请求就能判错」的分支，测试不该依赖外网。
test('/mod-search 没给搜索词直接 400，不发网络请求', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/mod-search');
  assert.equal(status, 400);
  assert.match(body.error, /没给搜索词/);
});

test('/mod-versions 没给工程 ID 直接 400', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/mod-versions');
  assert.equal(status, 400);
  assert.match(body.error, /缺少工程 ID/);
});

test('/mod-install/preview 缺 dir 返回 400 并提示先连包', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/mod-install/preview', { projects: '["create"]' });
  assert.equal(status, 400);
  assert.match(body.error, /缺少实例目录/);
});

test('/mod-install/preview 给了包但没给 mod 清单，返回 400 而不是空清单', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/mod-install/preview', { dir });
  assert.equal(status, 400);
  assert.match(body.error, /没说要装哪个 mod/);
});

// ————————— 检查 mod 更新（2026-11-07）：三条新接口 —————————
// 这些用例都不发外网：空实例扫不到 jar，check 直接回空表；
// preview / apply 把检查表整块回传，走的是「不再联网」那条路。

test('/mod-update/check 缺 dir 返回 400 并提示先连包', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/mod-update/check');
  assert.equal(status, 400);
  assert.match(body.error, /缺少实例目录/);
});

test('/mod-update/check 空实例不联网，返回一张空表', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/mod-update/check', { dir });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.scanned, 0);
  assert.deepEqual(body.items, []);
});

test('/mod-update/preview 界面用 POST 回传检查表，算出升级清单（不发外网也不写盘）', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const check = {
    modsDir: path.join(dir, 'mods'),
    gameVersion: '1.21.1', loader: 'neoforge', channel: 'release',
    scanned: 1, updates: 1, latest: 0, unknown: 0, lines: [],
    items: [{
      key: 'deadbeef', fileName: 'create.jar', name: 'Create', modId: 'create',
      currentVersion: '1.0', latestVersion: '2.0', projectId: 'create',
      versionType: 'release', status: 'update',
      file: {
        fileName: 'create-2.0.jar', fileUrl: 'https://cdn.modrinth.com/create-2.0.jar',
        sha1: 'cafebabe', size: 1024, versionNumber: '2.0',
        versionType: 'release', projectId: 'create', versionId: 'create-2.0',
      },
    }],
  };
  // 界面 previewModUpdate() 走的是 post()，参数全在 JSON body 里（不是查询串）
  const { status, body } = await postJson(conn, '/mod-update/preview', {
    dir, channel: 'release', check: JSON.stringify(check), selected: '[]',
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].oldName, 'create.jar');
  assert.equal(body.items[0].disabledName, 'create.jar.disabled');
  assert.ok(body.lines.some((line) => line.includes('不会删')));
  // 只算清单，一个文件都不该写
  assert.equal(fs.existsSync(path.join(dir, 'mods', 'create.jar.disabled')), false);
});

test('/mod-update/preview 缺 dir 返回 400', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await postJson(conn, '/mod-update/preview', {
    check: JSON.stringify({ modsDir: '', items: [] }),
  });
  assert.equal(status, 400);
  assert.match(body.error, /缺少实例目录/);
});

test('/mod-update/apply 缺 dir 返回 400', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await postJson(conn, '/mod-update/apply', {});
  assert.equal(status, 400);
  assert.match(body.error, /缺少实例目录/);
});

test('/mod-update/apply 空清单不写盘：applied:false，绝不会瞎下载', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await postJson(conn, '/mod-update/apply', {
    dir,
    check: JSON.stringify({ modsDir: path.join(dir, 'mods'), items: [], channel: 'release' }),
    selected: '[]',
  });
  assert.equal(status, 200);
  assert.equal(body.applied, false);
  assert.deepEqual(body.installed, []);
  assert.deepEqual(body.failed, []);
});

// ————————— 安全增强（2026-11-07 第二轮）：锁定名单 + 一键撤回 —————————
// 锁定名单写在软件自己的数据目录（MCSTUDIO_DATA_DIR），绝不碰整合包；
// 撤回只改文件名，一个文件都不删。

/** 给一条用例临时准备一个软件数据目录，结束后还原环境变量、清缓存。 */
async function withLocksStore(fn) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-locks-api-'));
  const prev = process.env.MCSTUDIO_DATA_DIR;
  try {
    process.env.MCSTUDIO_DATA_DIR = store;
    clearLocksCache();
    await fn(store);
  } finally {
    if (prev === undefined) delete process.env.MCSTUDIO_DATA_DIR;
    else process.env.MCSTUDIO_DATA_DIR = prev;
    clearLocksCache();
  }
}

test('/mod-update/locks GET 只读：没锁过时是空名单，不写任何文件', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  await withLocksStore(async (store) => {
    const { status, body } = await call(conn, '/mod-update/locks', { dir });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.locks, []);
    assert.ok(body.lines.some((line) => line.includes('还没有锁定')));
    // 只读，不该在数据目录里造出文件
    assert.equal(fs.existsSync(path.join(store, 'mod-update-locks.json')), false);
  });
});

test('/mod-update/locks POST 能加能删：名单只写软件数据目录，不进整合包', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  await withLocksStore(async (store) => {
    const entry = { modId: 'create', projectId: 'create', fileName: 'create-1.0.jar', name: 'Create' };
    const added = await postJson(conn, '/mod-update/locks', { dir, action: 'add', entry: JSON.stringify(entry) });
    assert.equal(added.status, 200);
    assert.equal(added.body.ok, true);
    assert.equal(added.body.locks.length, 1);
    assert.equal(added.body.locks[0].modId, 'create');
    assert.ok(added.body.lines.some((line) => line.includes('已锁定')));

    // 名单写在软件数据目录，不在整合包里
    const file = path.join(store, 'mod-update-locks.json');
    assert.equal(fs.existsSync(file), true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.keys(raw).length, 1);
    assert.equal(raw[Object.keys(raw)[0]].length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'mod-update-locks.json')), false);

    // 再读一次应该是同一份（走的是缓存后的路径）
    const again = await call(conn, '/mod-update/locks', { dir });
    assert.equal(again.body.locks.length, 1);

    // 解锁
    const removed = await postJson(conn, '/mod-update/locks', { dir, action: 'remove', entry: JSON.stringify(entry) });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.locks, []);
    assert.ok(removed.body.lines.some((line) => line.includes('已解除锁定')));
  });
});

test('/mod-update/locks POST action=clear 清空整个名单', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  await withLocksStore(async () => {
    const entry = { modId: 'create', fileName: 'create.jar' };
    await postJson(conn, '/mod-update/locks', { dir, action: 'add', entry: JSON.stringify(entry) });
    const cleared = await postJson(conn, '/mod-update/locks', { dir, action: 'clear' });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.locks, []);
    assert.ok(cleared.body.lines.some((line) => line.includes('已清空')));
  });
});

test('/mod-update/locks 缺 dir 返回 400', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/mod-update/locks');
  assert.equal(status, 400);
  assert.match(body.error, /缺少实例目录/);
});

test('/mod-update/rollback/preview 缺 dir 返回 400', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await postJson(conn, '/mod-update/rollback/preview', { result: '{}' });
  assert.equal(status, 400);
  assert.match(body.error, /缺少实例目录/);
});

test('/mod-update/rollback/preview 缺升级结果返回 400，不自己瞎拼 .jar.disabled', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await postJson(conn, '/mod-update/rollback/preview', { dir });
  assert.equal(status, 400);
  assert.match(body.error, /没有升级结果/);
});

test('/mod-update/rollback/preview 算清单但不写盘：旧 jar 还在停用名上', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  // 真实升级后的样子：旧 jar 已经被改名成 .jar.disabled，原名是空的
  fs.writeFileSync(path.join(modsDir, 'create-1.0.jar.disabled'), 'old', 'utf8');
  fs.writeFileSync(path.join(modsDir, 'create-2.0.jar'), 'new', 'utf8');
  const result = {
    installed: [{
      key: 'aaaa', name: 'Create', modId: 'create',
      oldName: 'create-1.0.jar', disabledName: 'create-1.0.jar.disabled',
      newName: 'create-2.0.jar', newPath: path.join(modsDir, 'create-2.0.jar'),
    }],
  };
  const { status, body } = await postJson(conn, '/mod-update/rollback/preview', {
    dir, result: JSON.stringify(result),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].oldName, 'create-1.0.jar');
  assert.ok(body.lines.some((line) => line.includes('都不删')), '撤回清单得说清一个文件都不删');
  // 只算不写：两个文件都还在原位，没有多出 .rolled-back
  assert.equal(fs.existsSync(path.join(modsDir, 'create-1.0.jar.disabled')), true);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-2.0.jar')), true);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-2.0.jar.rolled-back')), false);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-1.0.jar')), false);
});

test('/mod-update/rollback/preview 旧名被别的文件占了就跳过，绝不覆盖', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'create-1.0.jar'), '别人的文件', 'utf8');
  fs.writeFileSync(path.join(modsDir, 'create-1.0.jar.disabled'), 'old', 'utf8');
  fs.writeFileSync(path.join(modsDir, 'create-2.0.jar'), 'new', 'utf8');
  const result = {
    installed: [{
      key: 'aaaa', name: 'Create', modId: 'create',
      oldName: 'create-1.0.jar', disabledName: 'create-1.0.jar.disabled',
      newName: 'create-2.0.jar', newPath: path.join(modsDir, 'create-2.0.jar'),
    }],
  };
  const { status, body } = await postJson(conn, '/mod-update/rollback/preview', {
    dir, result: JSON.stringify(result),
  });
  assert.equal(status, 200);
  assert.equal(body.items.length, 0);
  assert.equal(body.skipped.length, 1);
  assert.equal(body.skipped[0].reason, 'old-name-taken');
  // 三个文件一个都没动
  assert.equal(fs.existsSync(path.join(modsDir, 'create-1.0.jar')), true);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-1.0.jar.disabled')), true);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-2.0.jar')), true);
});

test('/mod-update/rollback/apply 缺 dir 返回 400', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await postJson(conn, '/mod-update/rollback/apply', { result: '{}' });
  assert.equal(status, 400);
  assert.match(body.error, /缺少实例目录/);
});

test('/mod-update/rollback/apply 真撤回：旧 jar 改回原名，新 jar 改名停用，一个都不删', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'create-1.0.jar.disabled'), 'old', 'utf8');
  fs.writeFileSync(path.join(modsDir, 'create-2.0.jar'), 'new', 'utf8');
  const result = {
    installed: [{
      key: 'aaaa', name: 'Create', modId: 'create',
      oldName: 'create-1.0.jar', disabledName: 'create-1.0.jar.disabled',
      newName: 'create-2.0.jar', newPath: path.join(modsDir, 'create-2.0.jar'),
    }],
  };
  const { status, body } = await postJson(conn, '/mod-update/rollback/apply', {
    dir, result: JSON.stringify(result),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.applied, true);
  assert.equal(body.restored.length, 1);
  // 旧 jar 回到原名，新 jar 改名停用，磁盘上还是三个文件（一个都没删）
  assert.equal(fs.existsSync(path.join(modsDir, 'create-1.0.jar')), true);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-1.0.jar.disabled')), false);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-2.0.jar')), false);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-2.0.jar.rolled-back')), true);
  assert.ok(body.lines.some((line) => line.includes('撤回完成')));
});

test('/mod-update/rollback/apply 旧 jar 不在了就跳过，不会凭空造文件', async () => {
  const { dir } = makeFakeInstance();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'create-2.0.jar'), 'new', 'utf8');
  const result = {
    installed: [{
      key: 'aaaa', name: 'Create', modId: 'create',
      oldName: 'create-1.0.jar', disabledName: 'create-1.0.jar.disabled',
      newName: 'create-2.0.jar', newPath: path.join(modsDir, 'create-2.0.jar'),
    }],
  };
  const { status, body } = await postJson(conn, '/mod-update/rollback/apply', {
    dir, result: JSON.stringify(result),
  });
  assert.equal(status, 200);
  assert.equal(body.applied, false);
  assert.deepEqual(body.restored, []);
  assert.equal(body.skipped.length, 1);
  assert.equal(body.skipped[0].reason, 'old-missing');
  // 没得撤回就别动新 jar
  assert.equal(fs.existsSync(path.join(modsDir, 'create-2.0.jar')), true);
  assert.equal(fs.existsSync(path.join(modsDir, 'create-2.0.jar.rolled-back')), false);
});

/** 造一个能建包的根目录：有 libraries/，也有一个模板实例。 */
function makePackRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-packroot-'));
  fs.mkdirSync(path.join(root, 'libraries'), { recursive: true });
  const dir = path.join(root, 'versions', 'DemoPack');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'DemoPack.json'),
    JSON.stringify({ id: 'DemoPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'DemoPack.jar'), 'fake-jar', 'utf8');
  return { root, dir };
}

test('/pack/preview 缺 mcRoot 返回 400', async () => {
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/pack/preview', { name: 'X' });
  assert.equal(status, 400);
  assert.match(body.error, /根目录/);
});

test('/pack/preview 包名非法时把原因说清楚', async () => {
  const { root, dir } = makePackRoot();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/pack/preview', { mcRoot: root, dir, name: 'a/b' });
  assert.equal(status, 400);
  assert.match(body.error, /包名/);
});

test('/pack/preview 正常算出计划，而且不写盘', async () => {
  const { root, dir } = makePackRoot();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/pack/preview', { mcRoot: root, dir, name: '新包' });
  assert.equal(status, 200);
  assert.equal(body.name, '新包');
  assert.equal(body.targetDir, path.join(root, 'versions', '新包'));
  assert.ok(body.dirCount > 0);
  assert.ok(body.questBook);
  assert.equal(fs.existsSync(body.targetDir), false, '预览不该建目录');
});

test('/pack/apply 真建，第二次拒绝覆盖', async () => {
  const { root, dir } = makePackRoot();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const url = `http://localhost${API_BASE}/pack/apply`;
  const route = conn.routes.get(API_BASE + '/pack/apply');
  const send = () => route.fetch(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mcRoot: root, dir, name: '建成包' }),
  }));

  const first = await send();
  const body = await first.json();
  assert.equal(first.status, 200);
  assert.equal(body.applied, true);
  assert.ok(fs.existsSync(path.join(body.targetDir, '建成包.json')));
  assert.ok(body.createdDirs.length > 0);

  const second = await send();
  assert.equal(second.status, 400);
  assert.match((await second.json()).error, /已经存在|不为空/);
});

/** 造一个能打包的根：有 libraries/、assets/，实例里有 mods/ 与客户端 jar。 */
function makeExportRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcstudio-export-'));
  fs.mkdirSync(path.join(root, 'libraries', 'org', 'lwjgl'), { recursive: true });
  fs.writeFileSync(path.join(root, 'libraries', 'org', 'lwjgl', 'a.jar'), 'lib', 'utf8');
  fs.mkdirSync(path.join(root, 'assets', 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'indexes', '21.json'), '{}', 'utf8');
  const dir = path.join(root, 'versions', 'ExpPack');
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'ExpPack.json'),
    JSON.stringify({ id: 'ExpPack', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: {} }),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'ExpPack.jar'), 'jar', 'utf8');
  fs.writeFileSync(path.join(dir, 'mods', 'a.jar'), 'mod', 'utf8');
  return { root, dir };
}

test('/export/preview 算清单但不写盘', async () => {
  const { dir } = makeExportRoot();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/export/preview', { dir, mode: 'offline', packName: '测试包' });
  assert.equal(status, 200);
  assert.equal(body.mode, 'offline');
  assert.match(body.willWriteTo, /测试包\.zip$/);
  assert.ok(body.fileCount > 0);
  // 所有内容都在包裹目录里（PCL 靠这一层判断包里是什么）
  assert.deepEqual(body.top.map((t) => t.name), [body.wrapper]);
  assert.equal(fs.existsSync(body.willWriteTo), false, '预览不该产出 zip');
});

test('/export/preview 不认识的形态要给出可选值', async () => {
  const { dir } = makeExportRoot();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/export/preview', { dir, mode: 'huge' });
  assert.equal(status, 400);
  assert.match(body.error, /不认识/);
});

test('/export/build 真打 zip，并通过 PCL 自检', async () => {
  const { dir } = makeExportRoot();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const route = conn.routes.get(API_BASE + '/export/build');
  const res = await route.fetch(new Request(`http://localhost${API_BASE}/export/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir, mode: 'standard', packName: '轻量测试' }),
  }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.built, true);
  assert.ok(fs.existsSync(body.outFile), `zip 应该真的躺在那：${body.outFile}`);
  assert.ok(body.zipBytes > 0);
  assert.equal(body.check.ok, true, `自检没过：${JSON.stringify(body.check.failed)}`);
  assert.ok(body.check.items.length > 0);
});

/** 造一个带「一个能出图标的 mod」的实例，给 /item-icons 用。 */
function makeIconRoot() {
  const { root, dir } = makeFakeInstance();
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  // 1x1 透明 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  fs.writeFileSync(path.join(modsDir, 'demo-1.0.jar'), makeZip({
    'META-INF/mods.toml': 'modId="demo"\ndisplayName="Demo"\nversion="1.0"\n',
    'assets/demo/textures/item/cogwheel.png': png,
  }));
  return { root, dir };
}

test('/item-icons 把一批物品 ID 换成图标 data URL', async () => {
  resetStudioApiCache();
  const { dir } = makeIconRoot();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const route = conn.routes.get(API_BASE + '/item-icons');
  const res = await route.fetch(new Request(`http://localhost${API_BASE}/item-icons`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir, ids: ['demo:cogwheel', 'demo:not_here'] }),
  }));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.count, 1, '一个该找到、一个该找不到');
  assert.match(body.icons['demo:cogwheel'], /^data:image\/png;base64,/);
  assert.deepEqual(body.missing, ['demo:not_here'], '找不到的要如实列出来，别编一个');
});

test('/item-icons 没给物品要明确报错，而不是回空', async () => {
  resetStudioApiCache();
  const { dir } = makeIconRoot();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/item-icons', { dir });
  assert.equal(status, 400);
  assert.match(body.error, /没给要取图标的物品/);
});

test('/item-icon/web 没给物品 ID 要明确报错（这条不联网）', async () => {
  resetStudioApiCache();
  const { dir } = makeIconRoot();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/item-icon/web', { dir });
  assert.equal(status, 400);
  assert.match(body.error, /没给要查的物品 ID/);
  assert.equal(body.code, 'IconNoItem');
});

/** 1x1 透明 PNG 字节，几个用例共用。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** 在实例目录下造一个「游戏导出的图标目录」。 */
function makeExportDir(dir, files) {
  const out = path.join(dir, 'icon-exports-x64');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(out, name), body ?? PNG_1PX);
  }
  return out;
}

test('/icon-export/status 认得出游戏导出的图标目录', async () => {
  resetStudioApiCache();
  const { dir } = makeIconRoot();
  makeExportDir(dir, {
    'demo__cogwheel.png': PNG_1PX,
    'demo__cogwheel__{nbt__1}.png': PNG_1PX, // NBT 变体，不该多算一个
    'fluid__demo__water.png': PNG_1PX, // 流体，要跳过
    'readme.txt': 'not a png',
  });
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/icon-export/status', { dir });

  assert.equal(status, 200);
  assert.equal(body.hasExport, true);
  assert.equal(body.count, 1, '同一个物品的两个变体只算一个，流体和 txt 不算');
  // 只有「是 png 但解不出物品 ID」的才算 skipped（这里就是 fluid 那张）；
  // readme.txt 压根不是 png，连看都不看，不该算进来
  assert.equal(body.skipped, 1, `skipped 应该只记 fluid，实际 ${body.skipped}`);
  assert.match(body.text, /游戏导出的图标/);
  assert.equal(body.dirs.length, 1);
});

test('/icon-export/status 没导出目录时如实说没有，不报错', async () => {
  resetStudioApiCache();
  const { dir } = makeIconRoot();
  const conn = fakeConnection();
  registerStudioApi(conn);
  const { status, body } = await call(conn, '/icon-export/status', { dir });
  assert.equal(status, 200);
  assert.equal(body.hasExport, false);
  assert.equal(body.count, 0);
  assert.match(body.text, /还没有游戏导出的图标/);
});

test('/icon-export/scan 强制重扫，新导出的图标立刻能看到', async () => {
  resetStudioApiCache();
  const { dir } = makeIconRoot();
  makeExportDir(dir, { 'demo__cogwheel.png': PNG_1PX });
  const conn = fakeConnection();
  registerStudioApi(conn);

  // 先问一次，把缓存坐实
  const first = await call(conn, '/icon-export/status', { dir });
  assert.equal(first.body.count, 1);

  // 再往目录里丢一个新图标 —— 缓存没过期，status 还看不到
  fs.writeFileSync(path.join(dir, 'icon-exports-x64', 'demo__shaft.png'), PNG_1PX);
  const cached = await call(conn, '/icon-export/status', { dir });
  assert.equal(cached.body.count, 1, '10 分钟内走缓存，这是预期行为');

  // scan 是 POST 且强制重扫
  const route = conn.routes.get(API_BASE + '/icon-export/scan');
  const res = await route.fetch(new Request(`http://localhost${API_BASE}/icon-export/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir }),
  }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.count, 2, '强制重扫后应该看到新丢进去那张');
  assert.ok(body.lines.length > 0, '扫描结果要给人读的一行摘要');
});

test('/item-icons 优先用游戏导出的图标（三维模型物品只有它画得对）', async () => {
  resetStudioApiCache();
  const { dir } = makeIconRoot();
  // 这个物品在 jar 里也有贴图，但导出目录里的才是游戏渲染出来的
  const exportOut = makeExportDir(dir, { 'demo__cogwheel.png': PNG_1PX });
  const conn = fakeConnection();
  registerStudioApi(conn);
  const route = conn.routes.get(API_BASE + '/item-icons');
  const res = await route.fetch(new Request(`http://localhost${API_BASE}/item-icons`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir, ids: ['demo:cogwheel'] }),
  }));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.count, 1);
  assert.ok(body.exported, '结果里要说清导出目录的情况');
  assert.equal(body.exported.count, 1);
  assert.ok(body.exported.dirs.includes(exportOut));
});
