/**
 * SNBT（FTB Quests 存盘用的文本格式）读写。
 *
 * 为什么不是「解析成对象再整体序列化回去」：
 * 任务书文件是人写的，有对齐、有注释、有 `1L` / `-9.5d` 这种后缀写法。整体重写会
 * 打乱排版，也会把 `value: 1L` 写成 `value: 1`，git diff 里全是噪音，作者一看就
 * 不敢合。所以这里走「带位置信息的解析 + 只替换改动的那一小段」，其余字节原样保留。
 *
 * 两个入口：
 *   parseSnbt()    → 纯值，给读用
 *   parseSpans()   → 带 start/end 的节点树，给改写用
 */

const PUNCT = new Set(['{', '}', '[', ']', ',', ':']);
const WS = /\s/;
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?(?:[bBsSlLfFdD])?$/;
const LONG_SUFFIX_RE = /[lL]$/;

/**
 * long 字面量（SNBT 里带 L 后缀的整数）。
 *
 * 为什么需要它：FTB 把数量写成 `count: 8L`，少了 L 游戏会当成 int，超过 2^31 的值还会
 * 直接读不出来（战利品表的 table_id 就是这种十几位的大数）。JS 的 Number 存不下那么大的
 * 整数，所以写的时候用这个类包一层，格式化时原样带上 L。
 */
export class SnbtLong {
  constructor(text) {
    this.text = String(text).replace(LONG_SUFFIX_RE, '');
  }

  toString() {
    return this.text;
  }

  valueOf() {
    return Number(this.text);
  }

  /** JSON 比较（同一份东西判断有没有变）时按原样文本比，别让对象结构骗过去。 */
  toJSON() {
    return this.text;
  }
}

/**
 * 把裸值里的数字读成 JS 值。
 * long 后缀的值如果超出安全整数范围，就用 SnbtLong 保住原样（不然 table_id 会被抹错）。
 */
function numberOf(bare) {
  const suffix = /[bBsSlLfFdD]$/.exec(bare);
  const text = suffix ? bare.slice(0, -1) : bare;
  if (suffix && LONG_SUFFIX_RE.test(suffix[0])) {
    const n = Number(text);
    if (!Number.isSafeInteger(n)) return new SnbtLong(text);
    return n;
  }
  return Number(text);
}

/** 把 SNBT 文本解析成 JS 值（compound→对象，list→数组，数字带后缀会被剥掉）。 */
export function parseSnbt(source, label = 'SNBT') {
  const tokens = tokenize(source, label, false);
  let i = 0;

  const lineAt = (offset) => source.slice(0, offset).split('\n').length;
  const fail = (msg, tok = tokens[i]) => {
    const offset = tok?.offset ?? source.length;
    throw new SyntaxError(`${label}:${lineAt(offset)}: ${msg}`);
  };
  const isPunct = (v) => tokens[i]?.kind === 'punct' && tokens[i].value === v;
  const take = (expect) => {
    const tok = tokens[i];
    if (!tok || (expect !== undefined && !(tok.kind === 'punct' && tok.value === expect))) {
      fail(expect === undefined ? 'unexpected end of input' : `expected '${expect}'`);
    }
    i += 1;
    return tok;
  };

  function parseCompound() {
    take('{');
    const out = {};
    while (!isPunct('}')) {
      if (i >= tokens.length) fail('unterminated compound');
      if (isPunct(',')) { take(','); continue; }
      const key = take();
      if (key.kind === 'punct') fail('expected a key', key);
      if (key.kind === 'bare' && PUNCT.has(key.value)) fail(`bad key '${key.value}'`, key);
      take(':');
      if (Object.hasOwn(out, key.value)) fail(`duplicate key '${key.value}'`, key);
      out[key.value] = parseValue();
    }
    take('}');
    return out;
  }

  function parseList() {
    take('[');
    const out = [];
    while (!isPunct(']')) {
      if (i >= tokens.length) fail('unterminated list');
      if (isPunct(',')) { take(','); continue; }
      out.push(parseValue());
    }
    take(']');
    return out;
  }

  function parseValue() {
    const tok = take();
    if (tok.kind === 'string') return tok.value;
    if (tok.kind === 'punct' && tok.value === '{') { i -= 1; return parseCompound(); }
    if (tok.kind === 'punct' && tok.value === '[') { i -= 1; return parseList(); }
    if (tok.kind === 'punct') fail(`unsupported value '${tok.value}'`, tok);

    // 裸值里可以带冒号：minecraft:coal_ore / create:andesite_alloy 都是这么写的
    let bare = tok.value;
    while (isPunct(':')) {
      take(':');
      const part = take();
      if (part.kind === 'punct') fail('invalid colon in bare value', part);
      bare += `:${part.value}`;
    }
    if (bare === 'true') return true;
    if (bare === 'false') return false;
    if (NUMBER_RE.test(bare)) return numberOf(bare);
    return bare;
  }

  const value = parseValue();
  if (i !== tokens.length) fail('unexpected trailing content');
  return value;
}

/**
 * 带位置区间的解析结果。节点形状：
 *   {kind:'compound', start, end, closeStart, entries:Map<key,{key,node}>}
 *   {kind:'list', start, end, items:[node]}
 *   {kind:'scalar', start, end, value}
 * 每个节点都有 `.value`（普通 JS 值）。
 */
export function parseSpans(source, label = 'SNBT') {
  const tokens = tokenize(source, label, true);
  let i = 0;
  const fail = (msg, tok = tokens[i]) => {
    const offset = tok?.start ?? source.length;
    throw new SyntaxError(`${label}:${source.slice(0, offset).split('\n').length}: ${msg}`);
  };
  const isPunct = (v) => tokens[i]?.kind === 'punct' && tokens[i].value === v;
  const take = (expect) => {
    const tok = tokens[i];
    if (!tok || (expect !== undefined && !(tok.kind === 'punct' && tok.value === expect))) {
      fail(expect === undefined ? 'unexpected end of input' : `expected '${expect}'`);
    }
    i += 1;
    return tok;
  };
  const skipCommas = () => { while (isPunct(',')) take(','); };

  function parseValue() {
    const tok = tokens[i];
    if (!tok) fail('unexpected end of input');
    if (tok.kind === 'punct' && tok.value === '{') {
      const open = take('{');
      const entries = new Map();
      skipCommas();
      while (!isPunct('}')) {
        const key = take();
        if (key.kind === 'punct') fail('expected a key', key);
        take(':');
        if (entries.has(key.value)) fail(`duplicate key '${key.value}'`, key);
        entries.set(key.value, { key, node: parseValue() });
        skipCommas();
      }
      const close = take('}');
      const node = { kind: 'compound', start: open.start, end: close.end, closeStart: close.start, entries };
      node.value = {};
      for (const [k, e] of entries) node.value[k] = e.node.value;
      return node;
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const open = take('[');
      const items = [];
      skipCommas();
      while (!isPunct(']')) {
        items.push(parseValue());
        skipCommas();
      }
      const close = take(']');
      return { kind: 'list', start: open.start, end: close.end, items, value: items.map((n) => n.value) };
    }
    const first = take();
    if (first.kind === 'punct') fail('invalid value', first);
    let raw = first.value;
    let end = first.end;
    if (first.kind !== 'string') {
      while (isPunct(':')) {
        take(':');
        const part = take();
        raw += `:${part.value}`;
        end = part.end;
      }
    }
    let value = raw;
    if (first.kind !== 'string') {
      if (raw === 'true') value = true;
      else if (raw === 'false') value = false;
      else if (NUMBER_RE.test(raw)) value = numberOf(raw);
    }
    return { kind: 'scalar', start: first.start, end, value };
  }

  const root = parseValue();
  if (i !== tokens.length) fail('unexpected trailing content');
  return root;
}

function tokenize(source, label, spans) {
  const out = [];
  let cursor = 0;
  const push = (token) => {
    if (spans) out.push(token);
    else out.push({ kind: token.kind, value: token.value, offset: token.start });
  };
  while (cursor < source.length) {
    const ch = source[cursor];
    if (WS.test(ch) || ch === ',') {
      if (ch === ',') push({ value: ch, start: cursor, end: cursor + 1, kind: 'punct' });
      cursor += 1;
      continue;
    }
    if (ch === '#') {
      while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
      continue;
    }
    if (PUNCT.has(ch) && ch !== ',') {
      push({ value: ch, start: cursor, end: cursor + 1, kind: 'punct' });
      cursor += 1;
      continue;
    }
    if (ch === '"') {
      const start = cursor;
      cursor += 1;
      let escaped = false;
      while (cursor < source.length) {
        const current = source[cursor];
        cursor += 1;
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '"') break;
      }
      if (source[cursor - 1] !== '"') {
        throw new SyntaxError(`${label}:${source.slice(0, start).split('\n').length}: unterminated string`);
      }
      const raw = source.slice(start, cursor);
      let value;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw new SyntaxError(`${label}:${source.slice(0, start).split('\n').length}: invalid escape (${error.message})`);
      }
      push({ value, start, end: cursor, kind: 'string' });
      continue;
    }
    const start = cursor;
    while (cursor < source.length && !/[\s{}[\],:]/.test(source[cursor])) cursor += 1;
    if (cursor === start) throw new SyntaxError(`${label}: cannot tokenize at offset ${cursor}`);
    push({ value: source.slice(start, cursor), start, end: cursor, kind: 'bare' });
  }
  return out;
}

/**
 * 把 JS 值写成 SNBT 字面量。
 * 字符串一律加引号（安全优先）；数字保留小数；布尔照写。
 */
export function formatLiteral(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value instanceof SnbtLong) return `${value.text}L`;
  if (Array.isArray(value)) return `[${value.map(formatLiteral).join(', ')}]`;
  if (value && typeof value === 'object') {
    const body = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${formatKey(k)}: ${formatLiteral(v)}`)
      .join(', ');
    return body ? `{ ${body} }` : '{ }';
  }
  throw new TypeError(`不支持写成 SNBT 的值：${String(value)}`);
}

/**
 * 把对象写成**多行**块（FTB 手工写出来就长这样：缩进对齐、每行一个键）。
 * 只有新建章节/新建任务时才用它，改已有文件始终走 span 替换。
 */
export function formatBlock(value, indentUnit = '\t') {
  const nl = '\n';
  const walk = (v, depth) => {
    const pad = indentUnit.repeat(depth);
    const inner = indentUnit.repeat(depth + 1);
    if (v instanceof SnbtLong) return formatLiteral(v);
    if (Array.isArray(v)) {
      if (!v.length) return '[ ]';
      const items = v.map((x) => `${inner}${walk(x, depth + 1)}`);
      return `[${nl}${items.join(nl)}${nl}${pad}]`;
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      if (!entries.length) return '{ }';
      const items = entries.map(([k, x]) => `${inner}${formatKey(k)}: ${walk(x, depth + 1)}`);
      return `{${nl}${items.join(nl)}${nl}${pad}}`;
    }
    return formatLiteral(v);
  };
  return walk(value, 0);
}

/**
 * 命中文本区间做替换。edits = [{start, end, text}]，互不重叠。
 * 从后往前改，避免前面的替换把后面的位置挪掉。
 */
export function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/**
 * 键名要不要加引号。
 * FTB 的原始文件里键都是裸写的（`chapter.CH1.title:`），只有含空格等特殊字符时才加。
 * 刻意沿用这个习惯，改完的文件才能和原作者排版一致。
 */
function formatKey(key) {
  return /^[A-Za-z0-9_.\-]+$/.test(key) ? key : JSON.stringify(key);
}

/**
 * 按「原值长什么样」来写新值。
 * 真实文件里坐标写作 `-9.5d`、数量写作 `1L`，这些后缀 FTB 是认的，但重新生成时
 * 容易被抹成 `-9.5` / `1`。保持后缀不变能让 diff 只显示真正改了的那几个字符。
 */
export function formatLike(originalText, value) {
  if (typeof value === 'number' && Number.isFinite(value) && typeof originalText === 'string') {
    const m = /[bBsSlLfFdD]$/.exec(originalText.trim());
    if (m) {
      const suffix = m[0];
      // d/f 是浮点，b/s/L 是整数；跟着原来那个走，diff 才只显示数字本身的变化
      if (/[dDfF]/.test(suffix)) {
        return `${Number.isInteger(value) ? value.toFixed(1) : value}${suffix}`;
      }
      if (Number.isInteger(value)) return `${value}${suffix}`;
    }
  }
  return formatLiteral(value);
}

/**
 * 在 compound 尾部插入若干键值，尽量沿用原有缩进和换行风格。
 * 返回 {at, text} 形式的插入编辑（start===end）。
 */
export function insertionEdit(source, compoundNode, additions) {
  const closeLineStart = source.lastIndexOf('\n', compoundNode.closeStart - 1) + 1;
  const closeIndent = source.slice(closeLineStart, compoundNode.closeStart);
  const onOwnLine = /^[\t ]*$/.test(closeIndent);
  const nl = source.includes('\r\n') ? '\r\n' : '\n';

  // 收尾括号和最后一个键在同一行（`{ a: 1 }`），就贴着 } 插
  if (!onOwnLine) {
    const inline = additions.map(([k, v]) => `${formatKey(k)}: ${formatLiteral(v)}`).join(', ');
    return { start: compoundNode.closeStart, end: compoundNode.closeStart, text: `${inline}, ` };
  }

  const firstEntry = compoundNode.entries.values().next().value;
  let indent = '';
  if (firstEntry) {
    const entryLineStart = source.lastIndexOf('\n', firstEntry.key.start - 1) + 1;
    indent = source.slice(entryLineStart, firstEntry.key.start);
  }
  if (!/^[\t ]*$/.test(indent)) indent = `${closeIndent}\t`;

  const body = additions.map(([k, v]) => `${indent}${formatKey(k)}: ${formatLiteral(v)}`).join(nl);
  return { start: closeLineStart, end: closeLineStart, text: `${body}${nl}` };
}
