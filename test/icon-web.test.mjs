/**
 * 「MC百科联网图标」核心逻辑测试。
 *
 * 全程**不联网**：搜索页 / 详情页用 `test/fixtures/mcmod/` 下从真实页面切出来的 HTML，
 * 图标二进制和网络响应都靠假 fetch 喂。这一点是硬要求 —— 测试联网就成了「今天能过明天不能过」。
 *
 * 重点覆盖三件事（都是真踩过的坑）：
 *   1. 搜索页每条结果里 `/item/` 链接出现两次，只能取 head 里那个标题链接；
 *   2. 详情页塞满相关物品/变体的缩略图，只能认「路径末尾数字 == 本页物品 ID」的那张；
 *   3. 匹配宁可漏不给错：名字对不上、mod 对不上、两个同等候选，一律 null。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MCMOD,
  cacheDir,
  cleanText,
  parseItemPage,
  parseSearchHtml,
  pickBestMatch,
  pngSize,
  readWebCache,
  resetCooldown,
  resolveWebIcon,
  searchMcmod,
  writeWebCache,
} from '../packages/core/icon-web.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'mcmod');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** 造一个「合法到 pngSize 能读」的 PNG：签名 + IHDR 尺寸，后面不补像素数据（我们只读头）。 */
function png(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR 长度
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** 假 Response：够 resolveWebIcon 用（ok/status/text/arrayBuffer）。 */
function response(status, body) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return raw.toString('utf8');
    },
    async arrayBuffer() {
      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    },
  };
}

/**
 * 假 fetch：按「完整 URL → 响应（或函数）」路由，并把每次调用记进 log（查串行/节流用）。
 * 没配路由的一律 404 —— 让「不该发出的请求」立刻现形。
 */
function makeFetch(routes, log = []) {
  return async function fakeFetch(url) {
    log.push({ url: String(url), at: Date.now() });
    const hit = routes[String(url)];
    if (typeof hit === 'function') return hit(url);
    return hit ?? response(404, 'fixture: 没有配置这个地址');
  };
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcstudio-iconweb-${tag}-`));
}

// ---------------------------------------------------------------------------
// 常量与地址
// ---------------------------------------------------------------------------

test('MCMOD：搜索地址必须带 filter=3（不带的话头一页全是模组，抽不到物品）', () => {
  const url = MCMOD.searchUrl('熔岩');
  assert.match(url, /^https:\/\/search\.mcmod\.cn\/s\?key=/);
  assert.ok(url.includes(encodeURIComponent('熔岩')), '搜索词要 encodeURIComponent');
  assert.ok(url.includes('filter=3'), 'filter=3 是「资料」分类，缺了会拿到模组列表');
  assert.equal(MCMOD.itemUrl('524057'), 'https://www.mcmod.cn/item/524057.html');
  assert.equal(MCMOD.iconHost, 'https://i.mcmod.cn');
});

test('cleanText：<em> 高亮不能变成空格（否则「熔岩风蛇」会变「熔岩 风蛇」）', () => {
  assert.equal(cleanText('<em>熔岩</em>风蛇 (熔岩風蛇)'), '熔岩风蛇 (熔岩風蛇)');
  assert.equal(cleanText('  <b>a</b>&amp;<i>b</i>  '), 'a&b');
  assert.equal(cleanText('&nbsp;x'), 'x');
});

// ---------------------------------------------------------------------------
// 搜索页解析
// ---------------------------------------------------------------------------

test('parseSearchHtml：从真实搜索页里抽出 12 条结果，标题不是网址', () => {
  const results = parseSearchHtml(fixture('search-items.html'));
  assert.equal(results.length, 12, 'fixture 里正好 12 条');

  const first = results[0];
  assert.equal(first.itemId, '652240');
  assert.equal(first.pageUrl, 'https://www.mcmod.cn/item/652240.html');
  assert.equal(first.title, '熔岩风蛇 (熔岩風蛇)', 'head 里的 <em> 要去干净，且不能留假空格');
  assert.equal(first.modName, '魔法金属 (ManaMetalMod)', 'mod 简称 [M3] 要去掉');
  assert.equal(first.category, '生物/实体', '分类在 <a> 外面，要单独抽');

  // foot 里那个「地址」链接不能顶掉标题（这是最容易写错的一处）
  assert.ok(
    results.every((r) => !/^https?:|^www\.|\.html$/.test(r.title)),
    '标题不该是网址',
  );
  // itemId 去重
  assert.equal(new Set(results.map((r) => r.itemId)).size, results.length, '同一物品不该重复出现');
});

test('parseSearchHtml：空串 / 垃圾 HTML 返回空数组，不抛', () => {
  assert.deepEqual(parseSearchHtml(''), []);
  assert.deepEqual(parseSearchHtml(null), []);
  assert.deepEqual(parseSearchHtml('<html><body>什么也没有</body></html>'), []);
  // 有链接但没有可见标题的块要丢掉（没法做保守匹配）
  assert.deepEqual(parseSearchHtml('<div class="result-item"><div class="head"><a href="/item/1.html"></a></div></div>'), []);
});

// ---------------------------------------------------------------------------
// 详情页解析
// ---------------------------------------------------------------------------

test('parseItemPage：认「自己的」图标，取 128x128 那档并补成 https', () => {
  const page = parseItemPage(fixture('item-own-icon.html'));
  assert.equal(page.title, '改良无线虚能节点 (Improved Wireless Imag Node)');
  assert.equal(page.iconUrl, 'https://i.mcmod.cn/item/icon/128x128/1/11742.png', '必须选大尺寸那一档');
  assert.equal(page.size, 128);
});

test('parseItemPage：本物品没图时返回 null，绝不拿页面上的变体缩略图凑', () => {
  const page = parseItemPage(fixture('item-no-icon.html'));
  assert.match(page.title, /熔岩地狱方块/);
  assert.equal(page.iconUrl, null, '524057 页面有 16 张变体缩略图，但本物品自己没图');
  assert.equal(page.size, 0);
});

test('parseItemPage：没有自身图标地址时退回 og:image', () => {
  const page = parseItemPage(fixture('item-og.html'));
  assert.equal(page.title, '安山传送带漏斗 (Andesite Belt Funnel)');
  assert.equal(page.iconUrl, 'https://i.mcmod.cn/item/icon/128x128/77/777001.png', '协议相对地址要补 https:');
  assert.equal(page.size, 128, '尺寸从地址里读出来');
});

test('parseItemPage：外部传入 itemId 时以它为准（搜索结果的 id 比页面推断更可信）', () => {
  const html = `<div class="itemname"><h5>某物品 (Something)</h5></div>
    <img src="//i.mcmod.cn/item/icon/32x32/1/111.png"><img src="//i.mcmod.cn/item/icon/128x128/2/222.png">`;
  const page = parseItemPage(html, { itemId: '222' });
  assert.equal(page.iconUrl, 'https://i.mcmod.cn/item/icon/128x128/2/222.png');
  assert.equal(page.size, 128);
  // 页面里读不到本页 ID、也没 og:image 时，宁可 null 也不猜
  assert.equal(parseItemPage(html).iconUrl, null);
});

test('pngSize：读 IHDR 的真实宽高，非 PNG 返回 null', () => {
  assert.deepEqual(pngSize(png(32, 32)), { w: 32, h: 32 });
  assert.deepEqual(pngSize(png(128, 128)), { w: 128, h: 128 });
  assert.equal(pngSize(Buffer.from('<html>不是图</html>')), null);
  assert.equal(pngSize(null), null);
});

// ---------------------------------------------------------------------------
// 保守匹配
// ---------------------------------------------------------------------------

test('pickBestMatch：标准化后完全相等 → 命中（含全角括号差异）', () => {
  const results = parseSearchHtml(fixture('search-items.html'));
  // 1027179「熔岩 (Lave)」、360852「熔岩 (Lava)」两条主名都是「熔岩」
  const byMod = pickBestMatch(results, { name: '熔岩', modName: '夸克' });
  assert.ok(byMod, '给了 mod 名就该能收窄到唯一一条');
  assert.equal(byMod.itemId, '360852');
  assert.equal(byMod.match, 'exact');
});

test('pickBestMatch：同名多条且没给 mod 名 → null（不赌）', () => {
  const results = parseSearchHtml(fixture('search-items.html'));
  assert.equal(pickBestMatch(results, { name: '熔岩' }), null, '两条「熔岩」同等级，宁可不给');
});

test('pickBestMatch：只有「包含」关系时，mod 对不上必须拒绝', () => {
  const results = parseSearchHtml(fixture('search-items.html'));
  // 「地狱方块」只是被「熔岩地狱方块」包含；mod 是魔法金属，不是机械动力 → 拒绝
  assert.equal(pickBestMatch(results, { name: '地狱方块', modName: '机械动力' }), null);
  // mod 对得上就命中
  const hit = pickBestMatch(results, { name: '地狱方块', modName: '魔法金属' });
  assert.equal(hit?.itemId, '524057');
  assert.equal(hit?.match, 'contains');
});

test('pickBestMatch：名字完全一样且唯一 → 不看 mod 也命中（mcmod 的 mod 字段是中文全名，硬套会误伤）', () => {
  // 实测里的真实案例：配方是「配料盆」，mcmod 那条叫「配料盆 (Ingredients Basin)」，
  // 但调用方手里只有命名空间 barbequesdelight，跟 mcmod 的中文 mod 名永远对不上。
  const results = [
    { pageUrl: 'https://www.mcmod.cn/item/900001.html', itemId: '900001', title: '配料盆 (Ingredients Basin)', rawTitle: '配料盆 (Ingredients Basin) - [BD]烧烤乐事 (Barbeque\.s Delight)', modName: '烧烤乐事 (Barbeque\.s Delight)' },
  ];
  const hit = pickBestMatch(results, { name: '配料盆', modName: 'barbequesdelight' });
  assert.equal(hit?.itemId, '900001', '名字完全一样且只有一条，就该认');
  assert.equal(hit?.match, 'exact');
});

test('pickBestMatch：只是「包含」但 mod 对得上 → 命中（contains）', () => {
  const results = parseSearchHtml(fixture('search-items.html'));
  // 「巨大熔岩」被「巨大熔岩碎块」包含，mod 也是魔法金属 → 唯一，命中
  const hit = pickBestMatch(results, { name: '巨大熔岩', modName: '魔法金属' });
  assert.equal(hit?.itemId, '527273');
  assert.equal(hit?.match, 'contains');
});

test('pickBestMatch：拿不到名字 / 名字对不上 / 包含候选不止一条 → 一律 null', () => {
  const results = parseSearchHtml(fixture('search-items.html'));
  assert.equal(pickBestMatch(results, {}), null);
  assert.equal(pickBestMatch(results, { name: '钻石剑' }), null);
  assert.equal(pickBestMatch([], { name: '熔岩' }), null);
  // 「风蛇」能被两条标题包含（熔岩风蛇 / 熔岩风蛇灵魂蛋）→ 不唯一，放弃
  assert.equal(pickBestMatch(results, { name: '风蛇', modName: '魔法金属' }), null);
});

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

test('cacheDir：落在 <mcRoot>/.dsh-icon-cache/mcmod 下', () => {
  const dir = cacheDir(path.join(tmpDir('root'), 'minecraft'));
  assert.ok(dir.endsWith(path.join('.dsh-icon-cache', 'mcmod')), dir);
  assert.ok(dir.includes('minecraft'));
});

test('readWebCache / writeWebCache：写得进读得出，坏文件当空', () => {
  const dir = path.join(tmpDir('cache'), 'mcmod');
  assert.deepEqual(readWebCache(dir), {}, '目录不存在时当空');

  const map = { 'minecraft:lava': { file: 'abc123.png', title: '熔岩', source: 'https://www.mcmod.cn/item/1.html', at: 1690000000000 } };
  assert.equal(writeWebCache(dir, map), true);
  assert.deepEqual(readWebCache(dir), map);

  // 坏 JSON：当空，不抛
  fs.writeFileSync(path.join(dir, 'index.json'), '{ 这不是 json');
  assert.deepEqual(readWebCache(dir), {});

  // 形状不对的条目要过滤；文件名带路径的要丢掉（防止索引被改写后越界读盘）
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      'demo:ok': { file: 'x.png', title: '好条目', source: 's', at: 1 },
      'demo:evil': { file: '../outside.png', title: '坏条目', source: 's', at: 1 },
      'demo:no-file': { title: '没有文件名' },
      'demo:junk': 'not-an-object',
    }),
  );
  const read = readWebCache(dir);
  assert.deepEqual(Object.keys(read), ['demo:ok']);
});

// ---------------------------------------------------------------------------
// 搜索（联网入口，但用假 fetch）
// ---------------------------------------------------------------------------

test('searchMcmod：正常返回结果；空白关键词不发请求', async () => {
  const log = [];
  const fetchImpl = makeFetch({ [MCMOD.searchUrl('熔岩')]: response(200, fixture('search-items.html')) }, log);
  const r = await searchMcmod('熔岩', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 12);
  assert.equal(log.length, 1);

  const empty = await searchMcmod('  ', { fetchImpl });
  assert.equal(empty.ok, false);
  assert.equal(log.length, 1, '空关键词不该发请求');
});

test('searchMcmod：限流文案要单独认出来，不能当成「没有结果」', async () => {
  resetCooldown();
  const log = [];
  const fetchImpl = makeFetch({ [MCMOD.searchUrl('齿轮')]: response(200, fixture('search-limited.html')) }, log);
  const r = await searchMcmod('齿轮', { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /搜索太频繁/);

  // 撞限流后进入冷却期：再搜直接返回原因，一个请求都不发（继续硬发只会把封禁拖长）
  const again = await searchMcmod('齿轮', { fetchImpl });
  assert.equal(again.ok, false);
  assert.match(again.reason, /搜索太频繁.*秒后可再试/);
  assert.equal(log.length, 1, '冷却期内不该再发请求');

  resetCooldown();
});

test('searchMcmod：非 200 / 网络异常 / 超时都折成 ok:false，不抛', async () => {
  const http500 = await searchMcmod('x', { fetchImpl: makeFetch({ [MCMOD.searchUrl('x')]: response(500, 'boom') }) });
  assert.equal(http500.ok, false);
  assert.match(http500.reason, /HTTP 500/);

  const aborted = await searchMcmod('y', {
    fetchImpl: async () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  assert.equal(aborted.ok, false);
  assert.match(aborted.reason, /超时/);

  const boom = await searchMcmod('z', {
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND search.mcmod.cn');
    },
  });
  assert.equal(boom.ok, false);
  assert.match(boom.reason, /ENOTFOUND/);
});

// ---------------------------------------------------------------------------
// resolveWebIcon：失败路径
// ---------------------------------------------------------------------------

test('resolveWebIcon：各种失败都返回 ok:false 且带中文原因，绝不抛', async () => {
  resetCooldown();
  // 1) 没有物品 ID
  let r = await resolveWebIcon({ name: '熔岩' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有物品 ID/);

  // 2) 有 ID 没名字（没法搜）
  r = await resolveWebIcon({ itemId: 'minecraft:lava' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有中文名/);

  // 3) 被限流
  r = await resolveWebIcon({
    itemId: 'demo:a',
    name: '齿轮',
    fetchImpl: makeFetch({ [MCMOD.searchUrl('齿轮')]: response(200, fixture('search-limited.html')) }),
  });
  assert.match(r.reason, /搜索太频繁/);
  resetCooldown(); // 后面的用例还要联网（用假 fetch），别被冷却期挡住

  // 4) 搜索 HTTP 失败
  r = await resolveWebIcon({ itemId: 'demo:b', name: 'x', fetchImpl: makeFetch({}) });
  assert.match(r.reason, /搜索请求失败：HTTP 404/);

  // 5) 搜到东西但名字对不上（保守 → 拒绝）
  r = await resolveWebIcon({
    itemId: 'demo:c',
    name: '钻石剑',
    fetchImpl: makeFetch({ [MCMOD.searchUrl('钻石剑')]: response(200, fixture('search-items.html')) }),
  });
  assert.match(r.reason, /没有标题完全匹配/);

  // 6) 详情页 500
  r = await resolveWebIcon({
    itemId: 'demo:d',
    name: '熔岩地狱方块',
    modName: '魔法金属',
    fetchImpl: makeFetch({
      [MCMOD.searchUrl('熔岩地狱方块')]: response(200, fixture('search-items.html')),
      [MCMOD.itemUrl('524057')]: response(500, 'boom'),
    }),
  });
  assert.match(r.reason, /详情页读取失败：HTTP 500/);

  // 7) 详情页确实没图（mcmod 自己也没有）
  r = await resolveWebIcon({
    itemId: 'demo:e',
    name: '熔岩地狱方块',
    modName: '魔法金属',
    fetchImpl: makeFetch({
      [MCMOD.searchUrl('熔岩地狱方块')]: response(200, fixture('search-items.html')),
      [MCMOD.itemUrl('524057')]: response(200, fixture('item-no-icon.html')),
    }),
  });
  assert.match(r.reason, /详情页没有物品图标/);

  // 8) 图标地址回来的是错误页而不是 PNG
  r = await resolveWebIcon({
    itemId: 'demo:f',
    name: '安山传送带漏斗',
    fetchImpl: makeFetch({
      [MCMOD.searchUrl('安山传送带漏斗')]: response(200, minimalSearchPage('安山传送带漏斗', '777001')),
      [MCMOD.itemUrl('777001')]: response(200, fixture('item-og.html')),
      'https://i.mcmod.cn/item/icon/128x128/77/777001.png': response(200, '<html>403 forbidden</html>'),
    }),
  });
  assert.match(r.reason, /图标下载失败|不是 PNG/);

  // 9) fetch 直接抛异常（DNS / 断网）
  r = await resolveWebIcon({
    itemId: 'demo:g',
    name: '齿轮',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND search.mcmod.cn');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /搜索请求失败：getaddrinfo/);
});

// ---------------------------------------------------------------------------
// resolveWebIcon：成功路径 + 缓存 + 节流
// ---------------------------------------------------------------------------

/** 造一条「只有一条结果、名字完全相等」的搜索页。 */
function minimalSearchPage(title, id, mod = '[C]示范模组 (DemoMod)') {
  return `<html><body><div class="search-result-list"><div class="result-item">
    <div class="head">(物品/方块) <a target="_blank" href="https://www.mcmod.cn/item/${id}.html">${title} - ${mod}</a></div>
    <div class="body">摘要</div>
    <div class="foot">地址：<a href="https://www.mcmod.cn/item/${id}.html">www.mcmod.cn/item/${id}.html</a></div>
  </div></div></body></html>`;
}

test('resolveWebIcon：搜索 → 详情页 → 下载 → 落缓存 → 二次调用直接命中缓存', async () => {
  const mcRoot = path.join(tmpDir('resolve'), 'minecraft');
  const icon = png(128, 128);
  const log = [];

  const routes = {
    [MCMOD.searchUrl('安山传送带漏斗')]: response(200, minimalSearchPage('安山传送带漏斗', '777001')),
    [MCMOD.itemUrl('777001')]: response(200, fixture('item-og.html')),
    'https://i.mcmod.cn/item/icon/128x128/77/777001.png': response(200, icon),
  };
  const fetchImpl = makeFetch(routes, log);

  const first = await resolveWebIcon({ itemId: 'create:andesite_belt_funnel', name: '安山传送带漏斗', modName: '示范模组', mcRoot, fetchImpl });
  assert.equal(first.ok, true, first.reason);
  assert.match(first.dataUrl, /^data:image\/png;base64,/);
  assert.equal(first.cached, false);
  assert.equal(first.size, 128, '尺寸以 PNG 头为准');
  assert.equal(first.title, '安山传送带漏斗 (Andesite Belt Funnel)');
  assert.equal(first.source, 'https://www.mcmod.cn/item/777001.html');

  // 缓存落盘：index.json 一条，文件是 12 位 sha1
  const dir = cacheDir(mcRoot);
  const index = readWebCache(dir);
  const entry = index['create:andesite_belt_funnel'];
  assert.ok(entry, 'index.json 里要有这条');
  assert.match(entry.file, /^[0-9a-f]{12}\.png$/);
  assert.equal(entry.source, 'https://www.mcmod.cn/item/777001.html');
  assert.ok(fs.readFileSync(path.join(dir, entry.file)).equals(icon), '缓存文件字节要和下载的一致');

  // 三个请求串行且间隔 ≥ 350ms
  assert.equal(log.length, 3, '搜索 + 详情 + 图标');
  for (let i = 1; i < log.length; i += 1) {
    assert.ok(log[i].at - log[i - 1].at >= 340, `第 ${i} 个请求离上一次太近：${log[i].at - log[i - 1].at}ms`);
  }

  // 二次调用：走缓存，一个请求都不发
  const log2 = [];
  const second = await resolveWebIcon({ itemId: 'create:andesite_belt_funnel', name: '安山传送带漏斗', modName: '示范模组', mcRoot, fetchImpl: makeFetch(routes, log2) });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(second.dataUrl, first.dataUrl);
  assert.equal(log2.length, 0, '缓存命中不该联网');

  // force：无视缓存重新抓
  const third = await resolveWebIcon({ itemId: 'create:andesite_belt_funnel', name: '安山传送带漏斗', modName: '示范模组', mcRoot, fetchImpl: makeFetch(routes, []), force: true });
  assert.equal(third.ok, true);
  assert.equal(third.cached, false, 'force 要重新联网');
});

test('resolveWebIcon：缓存索引还在但文件坏了 → 当未命中，重新联网而不是报错', async () => {
  const mcRoot = tmpDir('badcache');
  const dir = cacheDir(mcRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.png'), '<html>半个文件</html>');
  writeWebCache(dir, { 'demo:thing': { file: 'broken.png', title: '旧标题', source: 's', at: 1 } });

  const icon = png(32, 32);
  const fetchImpl = makeFetch({
    [MCMOD.searchUrl('安山传送带漏斗')]: response(200, minimalSearchPage('安山传送带漏斗', '777001')),
    [MCMOD.itemUrl('777001')]: response(200, fixture('item-og.html')),
    'https://i.mcmod.cn/item/icon/128x128/77/777001.png': response(200, icon),
  });
  const r = await resolveWebIcon({ itemId: 'demo:thing', name: '安山传送带漏斗', mcRoot, fetchImpl });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.cached, false, '坏缓存不算命中');
  assert.equal(r.size, 32);
});

test('resolveWebIcon：32x32 那档会往 128x128 升档（实测 128 才是真图）', async () => {
  const mcRoot = tmpDir('upscale');
  const html = `<div class="itemname"><h5>小图物品 (Tiny)</h5></div>
    <a href="/item/edit/888001/">编辑</a>
    <img src="//i.mcmod.cn/item/icon/32x32/88/888001.png">`;
  const big = png(128, 128);
  const log = [];
  const fetchImpl = makeFetch(
    {
      [MCMOD.searchUrl('小图物品')]: response(200, minimalSearchPage('小图物品', '888001')),
      [MCMOD.itemUrl('888001')]: response(200, html),
      'https://i.mcmod.cn/item/icon/32x32/88/888001.png': response(404, 'nf'),
      'https://i.mcmod.cn/item/icon/128x128/88/888001.png': response(200, big),
    },
    log,
  );
  const r = await resolveWebIcon({ itemId: 'demo:tiny', name: '小图物品', mcRoot, fetchImpl });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.size, 128);
  assert.equal(r.iconUrl, 'https://i.mcmod.cn/item/icon/128x128/88/888001.png');
  assert.equal(log.length, 4, '搜索 + 详情 + 32x32(404) + 128x128');
});