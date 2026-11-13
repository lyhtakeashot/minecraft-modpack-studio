/**
 * 工作台界面的测试。
 *
 * 分两块：
 *   1. 阶段推断（`packages/ui/stages.js`）—— 纯函数，直接测「什么时候算做完」。
 *   2. 界面文件分发 —— 首页、脚本、样式能不能拿到，路径穿越能不能挡住。
 *
 * 界面本身的 DOM 行为不在这里测：那需要真浏览器。这里的定位是
 * 「文件能取到、状态算得对」，把最容易静默坏掉的两件事钉住。
 *
 * 2026-11-01 协议化：本地 HTTP 服务已退役，静态分发改走
 * `packages/desktop/protocol.js` 的 `handleProtocolRequest`（mcstudio://app/），
 * 测试也跟着换 —— 直接调协议处理器，不起任何服务、不占端口。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { STAGES, stageStatus, nextStep } from '../packages/ui/stages.js';
import { handleProtocolRequest, appUrl } from '../packages/desktop/protocol.js';

/** 走协议处理器取一个路径，返回和原来 HTTP 版一样的形状。 */
async function get(path) {
  const url = new URL(path, appUrl()).href;
  const res = await handleProtocolRequest(new Request(url));
  return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
}

// ------------------------------------------------------------------ 阶段推断

test('八个阶段的名字和顺序是固定的', () => {
  assert.equal(STAGES.length, 8);
  assert.deepEqual(
    STAGES.map((s) => s.key),
    ['project', 'checkup', 'content', 'quests', 'assets', 'pack', 'verify', 'deliver'],
  );
});

test('什么都没连的时候，第一个阶段是「当前」，后面全是「还没到」', () => {
  const list = stageStatus({});
  assert.equal(list[0].status, 'current');
  assert.equal(list[0].detail, '还没连上整合包');
  for (const item of list.slice(1)) assert.equal(item.status, 'todo');
});

test('连上包之后，「建立项目」变成已完成，体检变成当前', () => {
  const list = stageStatus({ connected: true, instance: { id: 'DemoPack' }, index: null });
  assert.equal(list[0].status, 'done');
  assert.equal(list[0].detail, '已连接：DemoPack');
  assert.equal(list[1].status, 'current');
  assert.equal(list[1].detail, '正在读总览…');
});

test('总览读到了，体检就完成，并且详情里带版本和数量', () => {
  const list = stageStatus({
    connected: true,
    instance: { id: 'DemoPack', mcVersion: '1.21.1', loader: 'neoforge' },
    index: { itemCount: 120, recipeCount: 340 },
  });
  assert.equal(list[1].status, 'done');
  assert.match(list[1].detail, /1\.21\.1 neoforge/);
  assert.match(list[1].detail, /120 个物品/);
  // 有物品就说明「内容」这一步也通了（能搜能看配方），当前卡在任务线
  assert.equal(list[2].status, 'done');
  assert.equal(list[3].status, 'current');
});

test('物品数是 0 时，「内容」不算完成（空索引不该假装能搜东西）', () => {
  const list = stageStatus({ connected: true, instance: { id: 'X' }, index: { itemCount: 0, recipeCount: 0 } });
  assert.equal(list[2].status, 'current');
});

test('任务书读到了，「任务线」就完成，详情显示任务数和章节数', () => {
  const list = stageStatus({
    connected: true,
    instance: { id: 'X' },
    index: { itemCount: 10, recipeCount: 20 },
    questBook: { questCount: 12, chapterCount: 3 },
  });
  assert.equal(list[3].status, 'done');
  assert.equal(list[3].detail, '12 个任务、3 章');
});

test('八个阶段都做完时，nextStep 说可以交付了', () => {
  const allDone = {
    connected: true,
    instance: { id: 'X' },
    index: { itemCount: 1, recipeCount: 1 },
    questBook: { questCount: 1, chapterCount: 1 },
    iconsCovered: 1,
    exportPreview: { sizeText: '10 MB' },
    launchResult: { ok: true, seconds: 17 },
    exportDone: { file: 'x.zip' },
  };
  const list = stageStatus(allDone);
  for (const item of list) assert.equal(item.status, 'done');
  assert.equal(nextStep(allDone).text, '八个阶段都通了，可以交付了');
});

test('nextStep 指向第一个没做完的阶段，并带上该干什么', () => {
  const next = nextStep({ connected: true, instance: { id: 'X' }, index: { itemCount: 5, recipeCount: 5 } });
  assert.equal(next.key, 'quests');
  assert.match(next.text, /任务线/);
});

// ------------------------------------------------------------------ 界面文件分发

test('首页返回工作台 HTML', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.text, /整合包工作室/);
  assert.match(r.text, /\/ui\/app\.js/);
});

test('脚本和样式都能拿到，类型对', async () => {
  const js = await get('/ui/app.js');
  assert.equal(js.status, 200);
  assert.match(js.type, /javascript/);
  // 首页要能引到它，脚本里要真的在调接口
  assert.match(js.text, /\/api\/mcstudio/);
  // 这一版 app.js 不再用阶段栏（改成三栏工作台），但蓝图接口必须还在
  assert.match(js.text, /\/quest\/canvas/);

  const css = await get('/ui/style.css');
  assert.equal(css.status, 200);
  assert.match(css.type, /text\/css/);

  const stages = await get('/ui/stages.js');
  assert.equal(stages.status, 200);
  assert.match(stages.text, /export function stageStatus/);
});

test('接口和静态文件互不干扰：/api/mcstudio/roots 还是走接口', async () => {
  const r = await get('/api/mcstudio/roots');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.roots));
});

test('路径穿越被挡住，不会把源码之类的东西发出去', async () => {
  for (const bad of ['/ui/../protocol.js', '/ui/..%2Fprotocol.js', '/ui/package.json', '/nope.js']) {
    const r = await get(bad);
    assert.equal(r.status, 404, `${bad} 应该 404，实际 ${r.status}`);
    // 静态层自己挡掉是 McNoStatic；被 URL 规范化成别的路径、落到接口层是 McNoRoute。
    // 两种都算「没发出去文件」，断言只要求是这两种之一。
    assert.match(r.text, /McNoStatic|McNoRoute/);
    // 最关键的一条：响应里绝不能出现源码内容
    assert.ok(!r.text.includes('handleProtocolRequest'), `${bad} 把源码发出去了`);
  }
});

test('不认识的后缀也不服务', async () => {
  const r = await get('/ui/app.txt');
  assert.equal(r.status, 404);
});
