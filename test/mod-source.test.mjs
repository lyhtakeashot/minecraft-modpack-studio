/**
 * 联网找 mod 的纯逻辑层单测：拼地址、解析、挑版本、文件名消毒。
 * 一个字节都不出去 —— 真联网的部分在 mod-fetch.test.mjs。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CF_LOADER_TYPE, allowedChannels, cfFileUrl, cfSearchUrl, formatDownloads, formatSize,
  mrProjectsUrl, mrSearchUrl, mrVersionsUrl, normalizeLoader, parseMrSearch, parseMrProject,
  parseMrVersions, pickMrVersion, rankCandidates, sanitizeModFileName, toMirror,
} from '../packages/core/mod-source.js';

test('normalizeLoader 认得各种写法', () => {
  assert.equal(normalizeLoader('NeoForge'), 'neoforge');
  assert.equal(normalizeLoader('neoforge'), 'neoforge');
  assert.equal(normalizeLoader('neo'), 'neoforge');
  assert.equal(normalizeLoader('Forge'), 'forge');
  assert.equal(normalizeLoader('Fabric'), 'fabric');
  assert.equal(normalizeLoader('quilt'), 'quilt');
  assert.equal(normalizeLoader(''), '');
  assert.equal(normalizeLoader('vanilla'), '');
  assert.equal(normalizeLoader(undefined), '');
  assert.equal(normalizeLoader('Paper'), '');
  // .neoforge. 里含 forge，顺序写反就会归一成 forge —— 这条就是防它。
  assert.equal(normalizeLoader('neoforge'), 'neoforge');
});

test('mrSearchUrl 的 facets 是「数组套数组」，且不加引号', () => {
  const url = mrSearchUrl({ query: 'create', gameVersion: '1.21.1', loader: 'neoforge', limit: 5, sort: 'downloads' });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/v2/search');
  assert.equal(parsed.searchParams.get('limit'), '5');
  assert.equal(parsed.searchParams.get('index'), 'downloads');
  assert.equal(parsed.searchParams.get('query'), 'create');
  const facets = JSON.parse(parsed.searchParams.get('facets'));
  assert.deepEqual(facets, [['project_type:mod'], ['categories:neoforge'], ['versions:1.21.1']]);
  // PCL 那份源码在 facets 里裹了单引号，我们不带（实测不带也能查到）。
  assert.ok(!parsed.searchParams.get('facets').includes("'"));
});

test('mrSearchUrl 没给版本/加载器时只有 project_type 一个 facet', () => {
  const facets = JSON.parse(new URL(mrSearchUrl({ query: 'kubejs' })).searchParams.get('facets'));
  assert.deepEqual(facets, [['project_type:mod']]);
});

test('limit 会被夹在 1..100 之间，乱给的用默认 20', () => {
  assert.equal(new URL(mrSearchUrl({ limit: 500 })).searchParams.get('limit'), '100');
  assert.equal(new URL(mrSearchUrl({ limit: 5 })).searchParams.get('limit'), '5');
  // 0 / 负数 / 没给 = 用默认 20
  assert.equal(new URL(mrSearchUrl({ limit: 0 })).searchParams.get('limit'), '20');
  assert.equal(new URL(mrSearchUrl({ limit: -5 })).searchParams.get('limit'), '20');
});

test('mrVersionsUrl / mrProjectsUrl 组成正确的批量查询', () => {
  assert.match(mrVersionsUrl('create'), /\/v2\/project\/create\/version\?include_changelog=false$/);
  const url = mrProjectsUrl(['a', 'b', 'a']);
  assert.match(url, /ids=/);
  assert.deepEqual(JSON.parse(decodeURIComponent(new URL(url).searchParams.get('ids'))), ['a', 'b']);
});

test('cfSearchUrl 带上 gameId/classId/modLoaderType', () => {
  const parsed = new URL(cfSearchUrl({ query: 'jei', gameVersion: '1.21.1', loader: 'neoforge', limit: 10 }));
  assert.equal(parsed.pathname, '/v1/mods/search');
  assert.equal(parsed.searchParams.get('gameId'), '432');
  assert.equal(parsed.searchParams.get('classId'), '6');
  assert.equal(parsed.searchParams.get('modLoaderType'), String(CF_LOADER_TYPE.neoforge));
  assert.equal(parsed.searchParams.get('gameVersion'), '1.21.1');
  assert.equal(parsed.searchParams.get('searchFilter'), 'jei');
});

test('cfFileUrl 按文件 ID 前 4 位拼 CDN 路径', () => {
  assert.equal(cfFileUrl(1234567, 'a b.jar'), 'https://edge.forgecdn.net/files/1234/567/a%20b.jar');
  assert.equal(cfFileUrl('', 'x.jar'), '');
  assert.equal(cfFileUrl('12', 'x.jar'), '');
});

test('toMirror 只做前缀替换，四类域名都认', () => {
  assert.equal(toMirror('https://api.modrinth.com/v2/search'), 'https://mod.mcimirror.top/modrinth/v2/search');
  assert.equal(toMirror('https://api.curseforge.com/v1/mods/1'), 'https://mod.mcimirror.top/curseforge/v1/mods/1');
  assert.equal(toMirror('https://cdn.modrinth.com/data/x.jar'), 'https://mod.mcimirror.top/data/x.jar');
  assert.equal(toMirror('https://edge.forgecdn.net/files/1/2/x.jar'), 'https://mod.mcimirror.top/files/1/2/x.jar');
  // 别的域名原样返回。
  assert.equal(toMirror('https://example.com/a'), 'https://example.com/a');
});

test('parseMrSearch 把返回改写成驼峰，并认出加载器', () => {
  const parsed = parseMrSearch({
    total_hits: 1785,
    hits: [{
      project_id: 'LNytGWDc', slug: 'create', title: 'Create', description: '机械动力',
      author: 'simibubi', downloads: 28495125, follows: 12000, date_modified: '2026-09-01T00:00:00Z',
      categories: ['technology', 'neoforge'], versions: ['1.21.1', '1.20.1'],
      project_type: 'mod', icon_url: 'https://cdn.modrinth.com/x.png',
    }],
  });
  assert.equal(parsed.total, 1785);
  assert.equal(parsed.results.length, 1);
  const hit = parsed.results[0];
  assert.equal(hit.projectId, 'LNytGWDc');
  assert.equal(hit.slug, 'create');
  assert.deepEqual(hit.loaders, ['neoforge']);
  assert.equal(hit.pageUrl, 'https://modrinth.com/mod/create');
  assert.equal(hit.downloads, 28495125);
});

test('parseMrProject 保留 game_versions / loaders', () => {
  const project = parseMrProject({ id: 'abc', slug: 'kubejs', title: 'KubeJS', game_versions: ['1.21.1'], loaders: ['neoforge'] });
  assert.equal(project.projectId, 'abc');
  assert.deepEqual(project.gameVersions, ['1.21.1']);
  assert.deepEqual(project.loaders, ['neoforge']);
});

test('parseMrVersions 取主文件、映射依赖、丢掉 embedded', () => {
  const versions = parseMrVersions([{
    id: 'v1', project_id: 'p1', name: 'Create 6.0.10', version_number: '6.0.10+mc1.21.1',
    version_type: 'release', date_published: '2026-09-01T00:00:00Z', downloads: 999,
    game_versions: ['1.21.1'], loaders: ['neoforge'],
    files: [
      { filename: 'extra.jar', url: 'https://cdn/x', size: 1, primary: false, hashes: { sha1: 'ff' } },
      { filename: 'create.jar', url: 'https://cdn/create', size: 19123767, primary: true, hashes: { sha1: '0e97' } },
    ],
    dependencies: [
      { project_id: 'dep1', version_id: 'vv', dependency_type: 'required' },
      { project_id: 'dep2', dependency_type: 'optional' },
      { project_id: 'dep3', dependency_type: 'embedded' },
    ],
  }]);
  const v = versions[0];
  assert.equal(v.fileName, 'create.jar');
  assert.equal(v.size, 19123767);
  assert.equal(v.sha1, '0e97');
  assert.equal(v.versionType, 'release');
  assert.deepEqual(v.dependencies.map((d) => d.projectId), ['dep1', 'dep2']);
  assert.equal(v.dependencies[0].type, 'required');
});

test('allowedChannels 三档', () => {
  assert.deepEqual(allowedChannels('release'), ['release']);
  assert.deepEqual(allowedChannels('beta'), ['release', 'beta']);
  assert.deepEqual(allowedChannels('alpha'), ['release', 'beta', 'alpha']);
  assert.deepEqual(allowedChannels(undefined), ['release']);
});

function version(overrides = {}) {
  return {
    id: `v-${overrides.versionNumber ?? 'x'}`,
    projectId: 'p1',
    name: '',
    versionNumber: '1.0',
    versionType: 'release',
    published: '2026-01-01T00:00:00Z',
    downloads: 0,
    gameVersions: ['1.21.1'],
    loaders: ['neoforge'],
    fileName: 'a.jar',
    fileUrl: 'https://cdn/a.jar',
    sha1: 'aa',
    size: 100,
    dependencies: [],
    ...overrides,
  };
}

test('pickMrVersion 优先正式版，其次发布时间最新', () => {
  const picked = pickMrVersion([
    version({ versionNumber: '2.0-beta', versionType: 'beta', published: '2026-09-01T00:00:00Z' }),
    version({ versionNumber: '1.5', published: '2026-08-01T00:00:00Z' }),
    version({ versionNumber: '1.6', published: '2026-08-20T00:00:00Z' }),
  ], { gameVersion: '1.21.1', loader: 'neoforge' });
  assert.equal(picked.versionNumber, '1.6');
});

test('pickMrVersion 按游戏版本和加载器过滤', () => {
  const list = [
    version({ versionNumber: '1.20', gameVersions: ['1.20.1'] }),
    version({ versionNumber: 'fabric', loaders: ['fabric'] }),
    version({ versionNumber: 'ok', gameVersions: ['1.21.1'], loaders: ['neoforge'] }),
  ];
  assert.equal(pickMrVersion(list, { gameVersion: '1.21.1', loader: 'neoforge' }).versionNumber, 'ok');
});

test('pickMrVersion 没有合适的返回 null', () => {
  assert.equal(pickMrVersion([version({ gameVersions: ['1.20.1'] })], { gameVersion: '1.21.1' }), null);
  assert.equal(pickMrVersion([], { gameVersion: '1.21.1' }), null);
  assert.equal(pickMrVersion([version({ versionType: 'beta' })], { gameVersion: '1.21.1', channel: 'release' }), null);
  assert.ok(pickMrVersion([version({ versionType: 'beta' })], { gameVersion: '1.21.1', channel: 'beta' }));
});

test('pickMrVersion 跳过没有文件地址的版本', () => {
  assert.equal(pickMrVersion([version({ fileUrl: '' })], { gameVersion: '1.21.1' }), null);
});

test('sanitizeModFileName 挡住路径穿越和非法字符', () => {
  assert.equal(sanitizeModFileName('create.jar'), 'create.jar');
  assert.equal(sanitizeModFileName('..\\..\\evil.jar'), 'evil.jar');
  assert.equal(sanitizeModFileName('../../evil'), 'evil.jar');
  assert.equal(sanitizeModFileName('a:b?.jar'), 'a_b_.jar');
  assert.equal(sanitizeModFileName(''), 'mod.jar');
  assert.equal(sanitizeModFileName('...'), 'mod.jar');
  assert.equal(sanitizeModFileName('noext'), 'noext.jar');
  // 大写扩展名别重复加。
  assert.equal(sanitizeModFileName('X.JAR'), 'X.JAR');
});

test('rankCandidates 按工程去重并按下载量排', () => {
  const ranked = rankCandidates([
    { projectId: 'a', slug: 'a', title: 'A', downloads: 5 },
    { projectId: 'b', slug: 'b', title: 'B', downloads: 50 },
    { projectId: 'a', slug: 'a', title: 'A dup', downloads: 5 },
  ]);
  assert.deepEqual(ranked.map((r) => r.projectId), ['b', 'a']);
});

test('formatDownloads / formatSize 口语化', () => {
  assert.equal(formatDownloads(28495125), '2850 万');
  assert.equal(formatDownloads(120), '120');
  assert.equal(formatDownloads(0), '0');
  assert.equal(formatSize(19123767), '18.2 MB');
  assert.equal(formatSize(2048), '2 KB');
  assert.equal(formatSize(0), '未知');
});