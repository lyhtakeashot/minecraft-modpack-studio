// 探针：实测 Modrinth v2 搜索 / 版本 / 下载链接（node tools/probe-modrinth.mjs）
const UA = 'dsh-mc-modpack-studio/0.1.0 (probe; contact=local)';

const facets = [['project_type:mod'], ['categories:neoforge'], ['versions:1.21.1']];
const url = `https://api.modrinth.com/v2/search?limit=3&query=create&facets=${encodeURIComponent(JSON.stringify(facets))}`;
const r = await fetch(url, { headers: { 'User-Agent': UA } });
console.log('search HTTP', r.status, 'len', (await r.clone().text()).length);
const j = await r.json();
console.log('total_hits', j.total_hits);
for (const h of j.hits) console.log(' ', h.project_id, h.slug, '|', h.title, '|', h.downloads);

const slug = j.hits[0].slug;
const r2 = await fetch(`https://api.modrinth.com/v2/project/${slug}/version?include_changelog=false`, { headers: { 'User-Agent': UA } });
const v = await r2.json();
console.log('versions', v.length);
const one = v.find((x) => x.game_versions.includes('1.21.1') && x.loaders.includes('neoforge'));
console.log('pick', one.version_number, one.version_type, one.date_published);
console.log('file', one.files[0].filename, one.files[0].size, one.files[0].hashes.sha1);
console.log('deps', JSON.stringify(one.dependencies));

// 依赖里 VersionId 可能是 null；ProjectId 是字符串
const dep = one.dependencies[0];
if (dep) {
  const pid = dep.project_id;
  const r3 = await fetch(`https://api.modrinth.com/v2/project/${pid}`, { headers: { 'User-Agent': UA } });
  const p = await r3.json();
  console.log('dep project', p.slug, p.title);
}

// 顺带确认镜像站是否可用（不传就当探测，失败不影响）
try {
  const m = await fetch('https://mod.mcimirror.top/modrinth/v2/search?limit=1', { headers: { 'User-Agent': UA } });
  console.log('mirror HTTP', m.status);
} catch (e) {
  console.log('mirror ERR', e.message);
}