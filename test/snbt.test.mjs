/**
 * SNBT 读写单测。每条都对应一个「真数据里长这样」的具体写法。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSnbt, parseSpans, formatLiteral, applyEdits, insertionEdit,
} from '../packages/core/snbt.js';

test('parseSnbt: 无逗号、无引号的裸键 + 冒号值（FTB 主格式）', () => {
  const v = parseSnbt('{ id: "ABC" x: -9.5d y: 1.0d }');
  assert.deepEqual(v, { id: 'ABC', x: -9.5, y: 1 });
});

test('parseSnbt: 数字后缀 b/s/L/f/d 要剥掉', () => {
  assert.equal(parseSnbt('{ a: 1L b: 2b c: 3.5f d: 4.0d e: 5s }').a, 1);
  assert.equal(parseSnbt('{ a: 1L b: 2b c: 3.5f d: 4.0d e: 5s }').c, 3.5);
});

test('parseSnbt: 物品 ID 里的冒号不能被当成键值分隔', () => {
  // 这是 SNBT 最简单也最容易写错的地方：minecraft:coal_ore 是值，不是 id: value
  assert.deepEqual(parseSnbt('{ id: "x" item: c6c:curse_of_timid }').item, 'c6c:curse_of_timid');
  assert.deepEqual(parseSnbt('{ icon: { id: cataclysm:ignitium_helmet } }').icon.id, 'cataclysm:ignitium_helmet');
});

test('parseSnbt: 单行内联数组与嵌套 compound', () => {
  const v = parseSnbt('{ tasks: [{ id: "A" type: "item" item: { count: 1, id: "x:y" } }] }');
  assert.equal(v.tasks.length, 1);
  assert.equal(v.tasks[0].item.id, 'x:y');
});

test('parseSnbt: 注释和空列表', () => {
  const v = parseSnbt('# 这是注释\n{ quest_links: [ ] # 尾注\n }');
  assert.deepEqual(v.quest_links, []);
});

test('parseSnbt: 数组型根节点（lang 文件也是 compound，但 list 根要能解析）', () => {
  assert.deepEqual(parseSnbt('[ { id: "a" } ]'), [{ id: 'a' }]);
});

test('parseSnbt: 转义字符串', () => {
  assert.equal(parseSnbt('{ s: "a\\"b\\n" }').s, 'a"b\n');
});

test('parseSnbt: 语法错误要带行号', () => {
  assert.throws(() => parseSnbt('{\n  a: \n}', 'chapter.snbt'), /chapter\.snbt:3/);
});

test('parseSnbt: 重复键要报错', () => {
  assert.throws(() => parseSnbt('{ a: 1, a: 2 }'), /duplicate key/);
});

test('parseSpans: 每个节点都有精确的 start/end', () => {
  const src = '{ id: "ABC" x: -9.5d }';
  const root = parseSpans(src);
  const idNode = root.entries.get('id').node;
  assert.equal(src.slice(idNode.start, idNode.end), '"ABC"');
  const xNode = root.entries.get('x').node;
  assert.equal(src.slice(xNode.start, xNode.end), '-9.5d');
});

test('parseSpans: 与 parseSnbt 的值必须一致（否则 span 解析就不可信了）', () => {
  const src = '{ a: [ { b: 1L } , { c: x:y } ] }';
  assert.deepEqual(parseSpans(src).value, parseSnbt(src));
});

test('formatLiteral: 字符串加引号、布尔和数字照写', () => {
  assert.equal(formatLiteral('abc'), '"abc"');
  assert.equal(formatLiteral(1.5), '1.5');
  assert.equal(formatLiteral(true), 'true');
  assert.equal(formatLiteral(['a', 'b']), '["a", "b"]');
});

test('applyEdits: 多处替换从后往前做，位置不会串', () => {
  const src = 'aaa bbb ccc';
  assert.equal(applyEdits(src, [{ start: 0, end: 3, text: 'X' }, { start: 8, end: 11, text: 'Y' }]), 'X bbb Y');
});

test('insertionEdit: 多行 compound 沿用原有缩进，键保持裸写', () => {
  const src = '{\n\ta: 1\n}';
  const root = parseSpans(src);
  const edit = insertionEdit(src, root, [['b', 2]]);
  const out = applyEdits(src, [{ start: edit.start, end: edit.end, text: edit.text }]);
  assert.equal(out, '{\n\ta: 1\n\tb: 2\n}');
  assert.deepEqual(parseSnbt(out), { a: 1, b: 2 });
});

test('insertionEdit: 键名含点也裸写（FTB 的语言键就长这样）', () => {
  const src = '{\n\ta: 1\n}';
  const root = parseSpans(src);
  const edit = insertionEdit(src, root, [['quest.ABC.title', 'x']]);
  const out = applyEdits(src, [{ start: edit.start, end: edit.end, text: edit.text }]);
  assert.ok(out.includes('quest.ABC.title: "x"'), `实际：${JSON.stringify(out)}`);
  assert.deepEqual(parseSnbt(out), { a: 1, 'quest.ABC.title': 'x' });
});

test('insertionEdit: 键名含空格才加引号', () => {
  const src = '{\n\ta: 1\n}';
  const root = parseSpans(src);
  const edit = insertionEdit(src, root, [['has space', 1]]);
  const out = applyEdits(src, [{ start: edit.start, end: edit.end, text: edit.text }]);
  assert.ok(out.includes('"has space": 1'), `实际：${JSON.stringify(out)}`);
  assert.deepEqual(parseSnbt(out), { a: 1, 'has space': 1 });
});

test('insertionEdit: 单行 compound 插入后仍是合法 SNBT', () => {
  const src = '{ a: 1 }';
  const root = parseSpans(src);
  const edit = insertionEdit(src, root, [['b', 2]]);
  const out = applyEdits(src, [{ start: edit.start, end: edit.end, text: edit.text }]);
  assert.deepEqual(parseSnbt(out), { a: 1, b: 2 });
});

test('insertionEdit: CRLF 文件插入也用 CRLF', () => {
  const src = '{\r\n\ta: 1\r\n}';
  const root = parseSpans(src);
  const edit = insertionEdit(src, root, [['b', 2]]);
  const out = applyEdits(src, [{ start: edit.start, end: edit.end, text: edit.text }]);
  assert.ok(out.includes('\r\n\tb: 2\r\n'), `实际：${JSON.stringify(out)}`);
});
