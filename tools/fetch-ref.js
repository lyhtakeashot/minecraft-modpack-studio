// 抓取参考材料到 ref/ 目录（node tools/fetch-ref.js）
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '..', 'ref');
fs.mkdirSync(dir, { recursive: true });

const jobs = [
  ['dsh-tool-modpack.README.md', 'https://raw.githubusercontent.com/cyy13045/dsh-tool-modpack/main/README.md'],
  ['dsh-tool-modpack.package.json', 'https://raw.githubusercontent.com/cyy13045/dsh-tool-modpack/main/package.json'],
  ['dsh-minecraft-agent.npm.json', 'https://registry.npmjs.org/dsh-minecraft-agent'],
  ['dsh-minecraft.npm.json', 'https://registry.npmjs.org/dsh-minecraft'],
  ['dsh-minecraft-ui.npm.json', 'https://registry.npmjs.org/dsh-minecraft-ui'],
  ['minecraft-mcp-server.README.md', 'https://raw.githubusercontent.com/dcd887/minecraft-mcp-server/main/README.md'],
  ['mc-pack-builder-mcp.README.md', 'https://raw.githubusercontent.com/dcd887/mc-pack-builder-mcp/main/README.md'],
];

const get = async (url) => {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'dsh-mc-modpack-research' } });
    if (!r.ok) return `HTTP ${r.status}`;
    return await r.text();
  } catch (e) {
    return `ERR ${e.message}`;
  }
};

for (const [name, url] of jobs) {
  const text = await get(url);
  fs.writeFileSync(path.join(dir, name), text, 'utf8');
  console.log(name, text.length, 'bytes', text.startsWith('HTTP') || text.startsWith('ERR') ? text.slice(0, 40) : 'ok');
}
