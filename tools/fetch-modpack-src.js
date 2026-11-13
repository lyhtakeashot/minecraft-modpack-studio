// 下载 dsh-tool-modpack 关键源码用于能力比对（node tools/fetch-modpack-src.js）
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '..', 'ref', 'dsh-tool-modpack');
fs.mkdirSync(dir, { recursive: true });

const base = 'https://raw.githubusercontent.com/cyy13045/dsh-tool-modpack/main/';
const files = ['src/index.ts', 'src/quest-gen.ts', 'src/config-gen.ts', 'src/tester.ts', 'src/packer.ts', 'src/resolver.ts', 'cordis.patch.yml'];

for (const f of files) {
  const r = await fetch(base + f, { headers: { 'User-Agent': 'dsh-mc-modpack-research' } });
  const text = await r.text();
  const out = path.join(dir, path.basename(f));
  fs.writeFileSync(out, text, 'utf8');
  console.log(path.basename(f), text.length, 'bytes', r.ok ? 'ok' : 'HTTP ' + r.status);
}
