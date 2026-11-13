// 极简 asar 读取器（Electron 打包格式）：列出 / 取出 / 搜索 .asar 里的文件。
//
// 用法：
//   node tools/asar-ls.js <asar> ls <路径前缀> [条数上限]
//   node tools/asar-ls.js <asar> cat <包内路径> [> 输出文件]
//   node tools/asar-ls.js <asar> grep <路径前缀> <关键词> [条数上限]
//
// grep 只在「路径以给定前缀开头、且体积小于 8 MB」的文件里找，
// 避免把整个 182 MB 的包读进内存。
import fs from 'node:fs';

const file = process.argv[2];
const cmd = process.argv[3] || 'ls';
const arg = process.argv[4] || '';

const fd = fs.openSync(file, 'r');
const pre = Buffer.alloc(16);
fs.readSync(fd, pre, 0, 16, 0);
// 0..4 = pickle 载荷大小，4..8 = 整个头部块大小，12..16 = JSON 字符串长度
const jsonLen = pre.readUInt32LE(12);
const headerStart = 16;
const headerBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, headerBuf, 0, jsonLen, headerStart);
const header = JSON.parse(headerBuf.toString('utf8'));
const dataStart = Math.ceil((headerStart + jsonLen) / 4) * 4;

/** 递归收集所有文件条目。 */
function walk(node, path, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = path ? path + '/' + name : name;
    if (child.files) walk(child, p, out);
    else out.push({ path: p, size: child.size, offset: child.offset, unpacked: child.unpacked });
  }
}

/** 读出包内一个文件的全部字节。 */
function readEntry(entry) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
  return buf;
}

const all = [];
walk(header, '', all);

if (cmd === 'ls') {
  const limit = parseInt(process.argv[6] || '200', 10);
  const hits = all.filter((f) => f.path.startsWith(arg));
  hits.slice(0, limit).forEach((f) => console.log(f.size + (f.unpacked ? '\t[unpacked]' : '') + '\t' + f.path));
  console.log('--- total matches: ' + hits.length + ' / all files: ' + all.length);
} else if (cmd === 'cat') {
  const f = all.find((x) => x.path === arg);
  if (!f) {
    console.error('not found: ' + arg);
    process.exit(2);
  }
  process.stdout.write(readEntry(f));
} else if (cmd === 'grep') {
  const keyword = process.argv[5] || '';
  const limit = parseInt(process.argv[6] || '20', 10);
  const MAX = 8 * 1024 * 1024;
  let shown = 0;
  let scanned = 0;
  for (const f of all) {
    if (!f.path.startsWith(arg)) continue;
    if (!f.size || f.size > MAX) continue;
    if (!/\.(js|mjs|cjs|json|html|css)$/i.test(f.path)) continue;
    scanned += 1;
    let text;
    try {
      text = readEntry(f).toString('utf8');
    } catch {
      continue;
    }
    const at = text.indexOf(keyword);
    if (at < 0) continue;
    shown += 1;
    const from = Math.max(0, at - 160);
    const snippet = text.slice(from, at + 220).replace(/\s+/g, ' ');
    console.log('=== ' + f.path + ' @' + at);
    console.log('    ' + snippet);
    if (shown >= limit) break;
  }
  console.log('--- hits: ' + shown + ' / scanned: ' + scanned);
}
fs.closeSync(fd);
