/**
 * CFPA 社区汉化包「核心层」的单测 —— 纯逻辑，不碰真网络、不碰真磁盘。
 *
 * 锁住三件最容易悄悄坏掉的事：
 * 1. 只认 `assets/<ns>/lang/zh_cn.json` 里正好 3 段的键，带 `%` 的模板不收；
 * 2. 下载源失败会降级到下一个，200 的 HTML 错误页不能被当成 zip 收下；
 * 3. 同一个 release 给几个 MC 版本出包时，要挑版本号最大的那个。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeZip } from './make-zip.mjs';
import {
  CFPA_LICENSE,
  CFPA_PROXIES,
  CFPA_RELEASE_API,
  fetchCfpaZip,
  parseCfpaZip,
  setCfpaFetch,
} from '../packages/core/cfpa-names.js';

/** 造一份假整包：两份语言文件 + 一堆「不该收」的条目，并撑到 100KB 以上。 */
function langZip() {
  return makeZip({
    'assets/demo/lang/zh_cn.json': JSON.stringify({
      'item.demo.pickaxe': '钻石镐',
      'block.demo.ore': '测试矿石',
      'item.demo.template': '已用 %s 次', // 带 % 的格式化模板，要丢
      'item.demo.pickaxe.desc': '四段键，要丢',
      'item.demo.deep.tooltip': '这也不是名字',
    }),
    'assets/other/lang/zh_cn.json': JSON.stringify({ 'item.other.ingot': '测试锭' }),
    'assets/demo/lang/en_us.json': JSON.stringify({ 'item.demo.pickaxe': 'Diamond Pickaxe' }),
    'assets/demo/lang/zh_cn.json.bak': JSON.stringify({ 'item.demo.ghost': '备份文件' }),
    'pack.mcmeta': '{}',
    'LICENSE': 'CC BY-NC-SA 4.0',
    'padding.bin': 'x'.repeat(120000), // fetchCfpaZip 要求整包 ≥ 100000 字节
  });
}

/** 假的 Response 形状：只实现 fetchCfpaZip 用到的那几样。 */
function reply(body, { ok = true, status = 200, json = null } = {}) {
  return {
    ok,
    status,
    json: json ? async () => json : async () => { throw new Error('不该调 json()'); },
    arrayBuffer: async () => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

/**
 * 假的有流式 body 的 Response（2026-11-06：进度条要靠它）。
 *
 * 浏览器里的 fetch 会给 `body.getReader()`，这样才能一块一块读、
 * 边读边报「已下多少」。老的替身（reply）没有 body，走的是一次性读，
 * 两条路都得通。
 *
 * `total` 传 'auto'（默认）＝按包大小报 content-length；传 null ＝这个源
 * 不报总大小（有些代理就这样）。
 */
function streamReply(buf, { total = 'auto', chunkSize = 4096 } = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  const size = total === 'auto' ? bytes.length : total;
  let at = 0;
  return {
    ok: true,
    status: 200,
    json: async () => { throw new Error('不该调 json()'); },
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-length' && size !== null
        ? String(size)
        : null),
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (at >= bytes.length) return { done: true, value: undefined };
          const end = Math.min(at + chunkSize, bytes.length);
          const value = bytes.subarray(at, end);
          at = end;
          return { done: false, value };
        },
      }),
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const RELEASE = [{
  tag_name: 'Snapshot-20261105000000',
  published_at: '2026-11-05T00:00:00Z',
  assets: [
    { name: 'Minecraft-Mod-Language-Modpack-1-20.zip' },
    { name: 'Minecraft-Mod-Language-Modpack-1-21.zip' },
    { name: '1.21.md5' },
  ],
}];

test('parseCfpaZip 只认 zh_cn.json 里正好 3 段的键，带 % 的模板和四段键都丢掉', () => {
  const { names, files } = parseCfpaZip(langZip());
  assert.equal(files, 2, '只该读两份 zh_cn.json');
  assert.equal(names.get('demo:pickaxe'), '钻石镐');
  assert.equal(names.get('demo:ore'), '测试矿石'); // block 键也算
  assert.equal(names.get('other:ingot'), '测试锭');
  assert.equal(names.size, 3);
  assert.equal(names.has('demo:template'), false, '带 % 的模板被收进来了');
  assert.equal(names.has('demo:pickaxe.desc'), false, '四段键被收进来了');
  assert.equal(names.has('demo:ghost'), false, '.json.bak 不该被认成语言文件');
  assert.equal(names.has('demo:deep'), false);
});

test('parseCfpaZip 单份语言文件坏了不毁整包；空 zip 返回空表', () => {
  const broken = makeZip({
    'assets/demo/lang/zh_cn.json': '{不是合法 json',
    'assets/other/lang/zh_cn.json': JSON.stringify({ 'item.other.ingot': '测试锭' }),
  });
  const { names, files } = parseCfpaZip(broken);
  assert.equal(files, 1); // 坏文件不计入，但另一份照常读出
  assert.equal(names.get('other:ingot'), '测试锭');
  const empty = parseCfpaZip(makeZip({ 'pack.mcmeta': '{}' }));
  assert.equal(empty.names.size, 0);
  assert.equal(empty.files, 0);
});

test('fetchCfpaZip 先问 API 拿 tag，并在多个整包里挑版本大的那个', async () => {
  const urls = [];
  setCfpaFetch(async (url) => {
    urls.push(String(url));
    if (String(url).includes('api.github.com')) return reply(null, { json: RELEASE });
    return reply(langZip());
  });
  try {
    const r = await fetchCfpaZip();
    assert.equal(r.tag, 'Snapshot-20261105000000');
    assert.equal(r.asset, 'Minecraft-Mod-Language-Modpack-1-21.zip', '要挑 1-21 而不是 1-20');
    assert.equal(r.publishedAt, '2026-11-05T00:00:00Z');
    assert.equal(r.source, CFPA_PROXIES[0], '第一个可用源命中就停');
    assert.ok(r.url.includes('1-21.zip'));
    assert.equal(urls[0], CFPA_RELEASE_API);
    assert.equal(urls.length, 2, 'API 一次 + 下载一次，不多发请求');
    assert.equal(r.buffer[0], 0x50);
    assert.equal(r.buffer[1], 0x4b);
  } finally {
    setCfpaFetch(null);
  }
});

test('fetchCfpaZip 遇到 200 的 HTML 错误页会降级到下一个下载源', async () => {
  const tried = [];
  setCfpaFetch(async (url) => {
    const u = String(url);
    if (u.includes('api.github.com')) return reply(null, { json: RELEASE });
    tried.push(u);
    // 第一个源返回 200 的 HTML（字节数也够），后面返回真 zip
    if (tried.length === 1) return reply('<html>proxy error</html>'.padEnd(120000, 'x'));
    return reply(langZip());
  });
  try {
    const r = await fetchCfpaZip();
    assert.equal(tried.length, 2, '第一个源失败后应该换第二个');
    assert.equal(r.source, CFPA_PROXIES[1]);
    assert.equal(r.buffer[0], 0x50);
  } finally {
    setCfpaFetch(null);
  }
});

test('fetchCfpaZip 所有下载源都失败时给出中文错误，不静默返回空', async () => {
  setCfpaFetch(async (url) => {
    if (String(url).includes('api.github.com')) return reply(null, { json: RELEASE });
    throw new Error('连接被重置');
  });
  try {
    await assert.rejects(
      () => fetchCfpaZip(),
      (error) => /汉化包下载失败/.test(error.message) && /连接被重置/.test(error.message),
    );
  } finally {
    setCfpaFetch(null);
  }
});

test('fetchCfpaZip 在 GitHub API 失败时直接报错，不去瞎试下载源', async () => {
  let downloads = 0;
  setCfpaFetch(async (url) => {
    if (String(url).includes('api.github.com')) return reply('', { ok: false, status: 502 });
    downloads += 1;
    return reply(langZip());
  });
  try {
    await assert.rejects(() => fetchCfpaZip(), /GitHub API 返回 502/);
    assert.equal(downloads, 0);
  } finally {
    setCfpaFetch(null);
  }
});

test('许可证常量是 CC BY-NC-SA 4.0（界面署名要用，不能写错）', () => {
  assert.equal(CFPA_LICENSE, 'CC BY-NC-SA 4.0');
  assert.ok(CFPA_RELEASE_API.includes('CFPAOrg'));
  assert.ok(CFPA_PROXIES.length >= 2, '至少要有一个代理 + 直链兜底');
  assert.equal(CFPA_PROXIES[CFPA_PROXIES.length - 1], '', '直链放最后一位');
});

test('下载时按块汇报进度：有流式 body 就一块一块报，拿到总大小才算得出百分比（2026-11-06）', async () => {
  const zip = langZip();
  const seen = [];
  setCfpaFetch(async (url) => {
    if (String(url).includes('api.github.com')) return reply(null, { json: RELEASE });
    // 分成 4 块吐，好看出「进度是递增的」
    return streamReply(zip, { chunkSize: Math.ceil(zip.length / 4) });
  });
  try {
    const r = await fetchCfpaZip({ onProgress: (info) => seen.push({ ...info }) });
    assert.equal(r.buffer.length, zip.length, '流式读出来的字节数要一样');
    assert.equal(r.buffer[0], 0x50);
    assert.equal(r.buffer[1], 0x4b);

    // 换源时先报一次 0，之后每块报一次
    assert.ok(seen.length >= 5, `进度至少要报 5 次（换源 1 次 + 4 块），实际 ${seen.length} 次`);
    assert.deepEqual(
      { loaded: seen[0].loaded, total: seen[0].total },
      { loaded: 0, total: 0 },
      '换源时应该先归零',
    );
    assert.equal(seen[0].source, CFPA_PROXIES[0]);

    // 最后一帧的 loaded 就是整个包的大小，total 是 content-length
    const last = seen[seen.length - 1];
    assert.equal(last.loaded, zip.length, '最后一帧应该是全部下完');
    assert.equal(last.total, zip.length, '有 content-length 时 total 应该等于包大小');

    // 进度必须是递增的（不能来回跳）
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i].loaded >= seen[i - 1].loaded, '进度不能倒退');
    }
    // 中间几帧应该落在 0 和总大小之间
    const mid = seen.find((s) => s.loaded > 0 && s.loaded < zip.length);
    assert.ok(mid, '应该有中间帧');
    assert.ok(mid.total > 0, '有 content-length 时中间帧也该带 total');
  } finally {
    setCfpaFetch(null);
  }
});

test('下载源不报总大小时，progress 的 total 是 0（界面退回「不知道大小」的走动条）（2026-11-06）', async () => {
  const zip = langZip();
  const seen = [];
  setCfpaFetch(async (url) => {
    if (String(url).includes('api.github.com')) return reply(null, { json: RELEASE });
    // content-length 给 null：有些代理就这样
    return streamReply(zip, { total: null });
  });
  try {
    await fetchCfpaZip({ onProgress: (info) => seen.push({ ...info }) });
    assert.ok(seen.length >= 2);
    for (const s of seen) {
      assert.equal(s.total, 0, '没报总大小的时候 total 应该是 0');
    }
    assert.equal(seen[seen.length - 1].loaded, zip.length, '已下载字节数照样要对');
  } finally {
    setCfpaFetch(null);
  }
});

test('没有流式 body 的老环境（只有 arrayBuffer）也能下完，只是进度只报一次终值（2026-11-06）', async () => {
  const zip = langZip();
  const seen = [];
  setCfpaFetch(async (url) => {
    if (String(url).includes('api.github.com')) return reply(null, { json: RELEASE });
    return reply(zip); // 老形状：没有 body，也没有 headers
  });
  try {
    const r = await fetchCfpaZip({ onProgress: (info) => seen.push({ ...info }) });
    assert.equal(r.buffer.length, zip.length, '下载不能坏');
    assert.ok(seen.length >= 1, '至少报一次');
    assert.equal(seen[seen.length - 1].loaded, zip.length, '终值应该是整个包');
    assert.equal(seen[seen.length - 1].total, 0, '没有 content-length 就是 0');
  } finally {
    setCfpaFetch(null);
  }
});
