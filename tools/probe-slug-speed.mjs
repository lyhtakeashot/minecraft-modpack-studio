/**
 * 探针：FTB Quests 在 Modrinth 上的真实 slug / 工程 ID，
 * 以及官方 CDN 与镜像谁快（中国网络下 cdn.modrinth.com 常常很慢）。
 */
const UA = { 'User-Agent': 'DSH-MCModpackStudio/0.1 (Minecraft modpack studio plugin)' };

async function json(url) {
  const r = await fetch(url, { headers: UA });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const facets = JSON.stringify([['project_type:mod'], ['versions:1.21.1']]);
const s = await json(`https://api.modrinth.com/v2/search?limit=8&query=${encodeURIComponent('FTB Quests')}&facets=${encodeURIComponent(facets)}`);
console.log('搜索状态', s.status);
for (const h of s.body?.hits ?? []) {
  console.log(`  ${h.project_id}  ${h.slug}  ${h.title}  loaders=${(h.loaders ?? h.categories ?? []).join(',')}`);
}

for (const slug of ['ftb-quests', 'ftb-quests-forge', 'ftb-quests-legacy']) {
  const r = await json(`https://api.modrinth.com/v2/project/${slug}`);
  console.log(`project/${slug} →`, r.status, r.body?.title ?? r.body?.description ?? '');
}

/** 量一下「下 1 MB 要多久」，超时就认怂。 */
async function speed(url, label) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) { console.log(label, 'HTTP', r.status); return; }
    let got = 0;
    for await (const chunk of r.body) {
      got += chunk.length;
      if (got >= 1024 * 1024) break;
    }
    console.log(`${label}: ${(got / 1024).toFixed(0)} KB / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(label, '失败：', e.name, e.message);
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

const fileUrl = 'https://cdn.modrinth.com/data/LNytGWDc/versions/QvO9cRML/create-1.21.1-6.0.10.jar';
const mirrorUrl = fileUrl.replace('https://cdn.modrinth.com', 'https://mod.mcimirror.top');
await speed(mirrorUrl, '镜像 create jar 首 1MB');
await speed(fileUrl, '官方 create jar 首 1MB');