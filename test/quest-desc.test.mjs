/**
 * 任务描述富文本标记解析（`packages/core/quest-desc.js`）的单测。
 *
 * 用例全部来自**真实数据**：2026-11-11 实测本地「重度机械症」包的
 * `config/ftbquests/quests/lang/en_us.snbt`，里面就有下面这几种写法。
 * 语法本身是从 ftb-library 与 ftb-quests 的 jar 字节码里挖出来的
 * （`ImageComponent.class` / `ViewQuestPanel.class`），不是猜的。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseImageBody, parseDescLine, parseDescLines, descImageSrcs,
  parseMcFormatting, unescapeFtbText, groupPageLines, parseDescPages, parsePlaceholder, resolveHolders,
} from '../packages/core/quest-desc.js';

test('真包那条 {image:…} 能解析出资源 ID 与尺寸', () => {
  // 原文：lang/en_us.snbt:882
  const line = '{image:ftbquests:textures/nvpujitian.png width:160 height:120 align:center}';
  const blocks = parseDescLine(line);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    kind: 'image',
    src: 'ftbquests:textures/nvpujitian.png',
    width: 160,
    height: 120,
    align: 'center',
    fit: false,
  });
});

test('资源 ID 自带冒号时不能被当成参数切掉', () => {
  // ★ 这是最容易写错的一条：`ftbquests:` 里的冒号会被「任意 key:value」正则
  //   误认成参数，src 被切空 → 整张图静默消失（不报错）。实测踩过这个坑。
  const spec = parseImageBody('ftbquests:textures/nvpujitian.png width:64');
  assert.equal(spec.src, 'ftbquests:textures/nvpujitian.png');
  assert.equal(spec.width, 64);
});

test('参数顺序乱、只写一部分，也能认出来', () => {
  const spec = parseImageBody('minecraft:textures/a.png fit:true align:left width:99');
  assert.equal(spec.src, 'minecraft:textures/a.png');
  assert.equal(spec.fit, true);
  assert.equal(spec.align, 'left');
  assert.equal(spec.width, 99);
});

test('只写资源 ID、一个参数都不给时用默认值', () => {
  const spec = parseImageBody('ns:textures/x.png');
  assert.equal(spec.src, 'ns:textures/x.png');
  assert.equal(spec.width, 160);
  assert.equal(spec.height, 0); // 0 = 按比例自适应，交给 CSS
  assert.equal(spec.align, 'center');
  assert.equal(spec.fit, false);
});

test('文字与图混在一行时切成多块，顺序不变', () => {
  const blocks = parseDescLine('看图 {image:ns:a.png width:8} 然后是说明');
  assert.equal(blocks.length, 3);
  // 文字块现在多带一个 spans（颜色片段），断言只比结构和文字
  assert.equal(blocks[0].kind, 'text');
  assert.equal(blocks[0].text, '看图 ');
  assert.equal(blocks[1].kind, 'image');
  assert.equal(blocks[1].src, 'ns:a.png');
  assert.equal(blocks[2].kind, 'text');
  assert.equal(blocks[2].text, ' 然后是说明');
});

test('坏数据 {image:} 原样留在文字里，不吐空图', () => {
  const blocks = parseDescLine('{image:}');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'text');
  assert.equal(blocks[0].text, '{image:}');
});

test('还没做的标记原样保留（翻页 / 变量占位符）；颜色码现在会切成分段', () => {
  // 真包里实际存在的标记，分两类：
  //   ▶ 这一轮仍然不解析的：{@pagebreak} 分页、{dimension.x} 这类变量占位符
  //   ▶ 已经解析了的：&d / &l 这类颜色码 —— 2026-11-11 用户要求「颜色能精确到几个字」
  //     之后，它们不再原样露出，而是变成带样式的片段（文本本身不变）。
  for (const line of ['{@pagebreak}', '{dimension.minecraft.the_end}']) {
    const blocks = parseDescLine(line);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, line, `${line} 应原样保留`);
  }

  // 颜色码：文本变干净（颜色码不留在 text 里，否则搜索/体检会拿它去匹配），
  // 同时切成带颜色的片段供界面上色。`&r` 后面是空字符串，不产生空段。
  const colored = parseDescLine('&dhostility&r');
  assert.equal(colored.length, 1);
  assert.equal(colored[0].text, 'hostility', 'text 必须是干净的文字（搜索要靠它）');
  assert.equal(colored[0].spans.length, 1, '&r 之后没有内容，不该多出空段');
  assert.equal(colored[0].spans[0].text, 'hostility');
  assert.equal(colored[0].spans[0].color, '#ff55ff', '&d 是浅紫');

  // 两段不同颜色的文字 → 两个片段
  const two = parseDescLine('&6橙色&2绿色');
  assert.equal(two[0].text, '橙色绿色', 'text 是拼起来的干净文本');
  assert.equal(two[0].spans.length, 2);
  assert.equal(two[0].spans[0].color, '#ffaa00');
  assert.equal(two[0].spans[1].color, '#00aa00');
});

test('空行给一个空文字块，保证「一行至少一块」', () => {
  const blocks = parseDescLine('');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'text');
  assert.equal(blocks[0].text, '');
});

test('parseDescLines 保留「行」这一层', () => {
  const blocks = parseDescLines(['第一行', '{image:ns:a.png}', '第三行']);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0][0].text, '第一行');
  assert.equal(blocks[1][0].kind, 'image');
  assert.equal(blocks[2][0].text, '第三行');
});

test('parseDescLines 收到非数组时给空数组，不抛', () => {
  assert.deepEqual(parseDescLines(null), []);
  assert.deepEqual(parseDescLines(undefined), []);
});

test('descImageSrcs 挑出全部图片资源 ID 并去重', () => {
  const blocks = parseDescLines([
    '{image:ns:a.png}',
    '中间一行文字',
    '{image:ns:b.png width:10}',
    '{image:ns:a.png}', // 重复
  ]);
  assert.deepEqual(descImageSrcs(blocks), ['ns:a.png', 'ns:b.png']);
});

test('descImageSrcs 对没有图的描述返回空数组', () => {
  const blocks = parseDescLines(['纯文字', '{@pagebreak}']);
  assert.deepEqual(descImageSrcs(blocks), []);
});

// ------------------------------------------------- 描述正文上色 + 换行（2026-11-11 追加）

test('unescapeFtbText：字面的 \\n 还原成真换行（实测 1235 行有这个）', () => {
  // 真数据：任务 2FE4B7B70D90A455 的描述里就是 `... contributor&r for use...\n\nAs all ...`
  assert.equal(unescapeFtbText('第一段\\n\\n第二段'), '第一段\n\n第二段');
  assert.equal(unescapeFtbText('单行没有换行'), '单行没有换行');
  assert.equal(unescapeFtbText(''), '');
});

test('unescapeFtbText：★ 反斜杠的转义顺序要对（别把 \\\\n 当换行）', () => {
  // `"a\\\\nb"` 在文件里表示 a\ 后面接 nb（一个反斜杠，不是换行）
  assert.equal(unescapeFtbText('a\\\\nb'), 'a\\nb');
  // 单个 \\ 还原成反斜杠本身
  assert.equal(unescapeFtbText('C:\\\\path'), 'C:\\path');
});

test('描述文字块带 spans，且 text 是去掉颜色码的干净文本', () => {
  // 真数据形态：lang 里写着 `&6AllTheMods Staff&r`，界面要显示成橙色
  const blocks = parseDescLine('by &6AllTheMods Staff&r, or a &2Community contributor&r');
  assert.equal(blocks.length, 1);
  const b = blocks[0];
  assert.equal(b.kind, 'text');
  assert.equal(b.text, 'by AllTheMods Staff, or a Community contributor',
    'text 必须干净 —— 搜索、体检、导出都读它，带颜色码就搜不到了');
  assert.equal(b.spans.length, 4);
  assert.equal(b.spans[0].text, 'by ');
  assert.equal(b.spans[0].color, '');
  assert.equal(b.spans[1].text, 'AllTheMods Staff');
  assert.equal(b.spans[1].color, '#ffaa00', '&6 是金色');
  assert.equal(b.spans[3].text, 'Community contributor');
  assert.equal(b.spans[3].color, '#00aa00', '&2 是深绿');
});

test('图片与彩色文字混在一行时，两种块各自保留', () => {
  const blocks = parseDescLine('看 &6这张图&r {image:ns:a.png width:8} 完事');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].kind, 'text');
  assert.equal(blocks[0].text, '看 这张图 ');
  assert.equal(blocks[0].spans.some((s) => s.color === '#ffaa00'), true, '文字块要带颜色');
  assert.equal(blocks[1].kind, 'image');
  assert.equal(blocks[2].text, ' 完事');
});

test('块的 text 与 spans 拼起来始终一致（两者不能各说各话）', () => {
  for (const line of [
    '&6橙色&2绿色',
    'by &6AllTheMods Staff&r, or a &2Community contributor&r',
    '&l粗体&r普通',
    'Ludicrite \\& Ridiculite',
    '纯文字没有颜色',
    '&#ff8800自定义色',
  ]) {
    const b = parseDescLine(line)[0];
    assert.equal(b.text, b.spans.map((s) => s.text).join(''), line);
  }
});

// ------------------------------------------------- 分页 + 变量占位符（2026-11-11 用户点名两条）

test('groupPageLines：{@pagebreak} 单独占一行时切成两页', () => {
  // 真包全这种形态：行内容就是 "{@pagebreak}"
  const pages = groupPageLines(['第一页a', '第一页b', '{@pagebreak}', '第二页a']);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0], ['第一页a', '第一页b']);
  assert.deepEqual(pages[1], ['第二页a']);
});

test('groupPageLines：分页标记前后的空行要去掉（真包它前面常有一行空串）', () => {
  const pages = groupPageLines(['内容a', '', '{@pagebreak}', '', '内容b']);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0], ['内容a'], '分页前那个空行不该留着，否则两页之间凭空多一段空白');
  assert.deepEqual(pages[1], ['内容b'], '分页后那个空行同理');
});

test('groupPageLines：★ 只有整行等于 {@pagebreak} 才切页，行内夹着的不切（2026-11-12 第五批照源码改）', () => {
  // 源码实证 Quest.java:1103：`rawDescription.get(l2).equals(PAGEBREAK_CODE)` —— 是 equals 不是 contains。
  // 以前我们用 includes()，那是**超集**：行内夹着标记也切，会误报「这个任务能翻页」，
  // 翻过去发现两页内容对不上（游戏里根本不分页）。
  const inline = groupPageLines(['前半{@pagebreak}后半']);
  assert.equal(inline.length, 1, '行内夹着标记不该切页（游戏里也不切）');
  assert.deepEqual(inline[0], ['前半{@pagebreak}后半'], '整行原样留在同一页里');

  // 结尾带空格的也不算（游戏是严格 equals）
  const trailing = groupPageLines(['第一页', '{@pagebreak} ', '第二页']);
  assert.equal(trailing.length, 1, '标记后面多一个空格，游戏也不认，我们跟着不认');

  // 整行恰好等于标记 → 正常切
  const exact = groupPageLines(['第一页', '{@pagebreak}', '第二页']);
  assert.equal(exact.length, 2);
  assert.deepEqual(exact.map((p) => p[0]), ['第一页', '第二页']);
});

test('groupPageLines：没有分页标记时只有一页（界面不用特判）', () => {
  const pages = groupPageLines(['只有一行']);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0], ['只有一行']);
});

test('groupPageLines：多个分页标记能切出多页', () => {
  const pages = groupPageLines(['a', '{@pagebreak}', 'b', '{@pagebreak}', 'c']);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((p) => p[0]), ['a', 'b', 'c']);
});

test('parseDescPages：每页是块数组，页内块顺序不变', () => {
  const pages = parseDescPages(['第一页 &6金色', '{@pagebreak}', '第二页 {image:ns:a.png}']);
  assert.equal(pages.length, 2);
  assert.equal(pages[0][0].text, '第一页 金色');
  assert.equal(pages[0][0].spans.some((s) => s.color === '#ffaa00'), true);
  assert.equal(pages[1].some((b) => b.kind === 'image'), true);
});

test('parsePlaceholder：切出类型 / 命名空间 / 路径', () => {
  assert.deepEqual(parsePlaceholder('item.minecraft.diamond'),
    { type: 'item', ns: 'minecraft', path: 'diamond', id: 'minecraft:diamond' });
  assert.deepEqual(parsePlaceholder('dimension.minecraft.the_end'),
    { type: 'dimension', ns: 'minecraft', path: 'the_end', id: 'minecraft:the_end' });
  // ★ 路径可以有很多段（药水变体），只切前两段
  const potion = parsePlaceholder('item.minecraft.potion.effect.apothic_attributes.flying');
  assert.equal(potion.ns, 'minecraft');
  assert.equal(potion.path, 'potion.effect.apothic_attributes.flying');
  // 段数不够的不是占位符
  assert.equal(parsePlaceholder('item.nope'), null);
});

test('★ 长得像占位符但不是的东西不能被误认（真包踩过）', () => {
  // ATM10Sky 里有 `{"action":"open_url","value":"https://…"}` —— 是代码示例原文（含引号）
  const json = parseDescLine('{"action":"open_url","value":"https://youtu.be/x"}');
  assert.equal(json.some((b) => b.holder), false, 'JSON 不是占位符');
  // 作者拿花括号当强调：`{End Ice Spikes}` `{Create Mod}`（含空格、没点号）
  const emph = parseDescLine('去 {End Ice Spikes} 那个地方');
  assert.equal(emph.some((b) => b.holder), false, '含空格的不是占位符');
});

test('占位符单独标出来，resolver 查不到时原样保留', () => {
  const blocks = parseDescLine('得到 {item.minecraft.diamond} 与 {item.nope.missing}');
  const holders = blocks.filter((b) => b.holder);
  assert.equal(holders.length, 2);
  assert.equal(holders[0].holder, 'item.minecraft.diamond');

  // 只认得钻石，另一个查不到
  const out = resolveHolders(blocks, (h) => (h === 'item.minecraft.diamond' ? '钻石' : ''));
  assert.equal(out.find((b) => b.holder === 'item.minecraft.diamond').text, '钻石');
  const missing = out.find((b) => b.holder === 'item.nope.missing');
  assert.equal(missing.text, '{item.nope.missing}', '查不到必须原样保留，不能换成空串');
  assert.equal(missing.holderName, undefined, '没换成名字就不该有 holderName');
});

test('resolver 抛异常时也不能把描述搞坏', () => {
  const blocks = parseDescLine('看看 {item.a.b}');
  const out = resolveHolders(blocks, () => { throw new Error('查表炸了'); });
  assert.equal(out.find((b) => b.holder)?.text, '{item.a.b}', 'resolver 抛异常时原样保留');
});
