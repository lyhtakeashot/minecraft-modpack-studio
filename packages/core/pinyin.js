/**
 * 拼音匹配：让用户打 `zuanshi` / `zsg` 也能找到「钻石」「钻石镐」。
 *
 * 为什么需要：整合包里绝大多数物品只有中文名（10386 个物品里 8133 个有名字，
 * 大部分是中文），不熟英文 ID 的人只能打中文；但中文输入法切换麻烦，
 * 拼音是最自然的输入方式。JEI 本身没有拼音搜索，这是我们对中文用户补的一层。
 *
 * 数据在 pinyin-data.js（21132 个字、413 个音节，从 pinyin-pro 反查而来）。
 * 这里只做「查表 + 匹配」，不含任何数据。
 *
 * 多音字的处理：一个字可能有多个读音（「镐」= gao / hao），匹配时**每个读音都试**。
 * 只用第一个读音会漏 —— 「钻石镐」的「镐」第一读音是 hao（镐京），
 * 用户打 zuanshigao 就搜不到了。
 */

import { PINYIN_TABLE } from './pinyin-data.js';

/** 汉字 → 读音数组。第一次用到时才解析（模块加载时解析会让启动慢 10ms 左右）。 */
let table = null;

function charTable() {
  if (table) return table;
  const byChar = new Map();
  for (const line of PINYIN_TABLE.split('\n')) {
    const at = line.indexOf('|');
    if (at <= 0) continue;
    const py = line.slice(0, at);
    // 逐码点遍历：有些汉字在增补平面，按 UTF-16 索引切会切坏
    for (const ch of line.slice(at + 1)) {
      const list = byChar.get(ch);
      if (!list) byChar.set(ch, [py]);
      else if (!list.includes(py)) list.push(py);
    }
  }
  table = byChar;
  return table;
}

/** 一个字的全部读音（没有就返回空数组）。 */
export function pinyinOf(ch) {
  return charTable().get(ch) ?? [];
}

/** 表里一共有多少个汉字。 */
export function pinyinCharCount() {
  return charTable().size;
}

/** 汉字基本区 + 扩展 A + 兼容区。用来判断「这段文字需不需要拼音匹配」。 */
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 字符串里有没有汉字。 */
export function hasHan(text) {
  return HAN_RE.test(String(text ?? ''));
}

/** 查询串是不是纯字母（拼音只可能是字母）。 */
export function isPinyinQuery(text) {
  return /^[a-z]+$/.test(String(text ?? ''));
}

/**
 * 每个字在匹配时可以选择「吃掉」哪些查询串片段。
 *
 * 汉字：全部读音 + 每个读音的首字母（所以 `zs` 和 `zuan` 都能匹配「钻」）。
 * 非汉字（空格、括号、标点、拉丁字母）：只认空串，等于跳过 ——
 * 名字里常有「钻石 镐」「齿轮（小）」这种，不能让标点把拼音链切断。
 * 拉丁字母也跳过：`钻石 Pickaxe` 里那段英文由普通文本匹配负责，拼音不该管。
 */
function optionsOf(ch) {
  const pys = charTable().get(ch);
  if (!pys) return [''];
  const out = [];
  for (const py of pys) {
    out.push(py);
    const initial = py[0];
    if (initial && initial !== py) out.push(initial);
  }
  return out;
}

/**
 * 从 `start` 这个字开始，query 能不能被完整吃掉？返回吃到的最后一个字的下标，否则 -1。
 *
 * 用集合做状态推进（不用递归）：每读一个字，记住「query 已经被吃掉了多少」的所有可能位置。
 * 状态数最多是 query 长度 + 1，所以再多的多音字组合也不会炸。
 */
function consume(chars, opts, query, start) {
  let reach = new Set([0]);
  for (let i = start; i < chars.length; i++) {
    const next = new Set();
    for (const pos of reach) {
      for (const opt of opts[i]) {
        if (opt === '') next.add(pos);
        else if (query.startsWith(opt, pos)) next.add(pos + opt.length);
      }
    }
    if (next.size === 0) return -1;
    reach = next;
    if (reach.has(query.length)) return i;
  }
  return -1;
}

/**
 * 拼音匹配。返回排序权重（越小越靠前），不命中返回 -1。
 *
 * 0 = 整名全拼（打 zuanshigao 命中「钻石镐」）
 * 1 = 名前缀（打 zuanshi 命中「钻石镐」）
 * 2 = 名里任意位置命中（打 gao 命中「钻石镐」）
 *
 * @param {string} name 物品显示名（可以含非汉字）
 * @param {string} query 用户输入（应当已经小写、只含字母）
 */
export function matchPinyin(name, query) {
  const q = String(query ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!q) return -1;
  const text = String(name ?? '');
  if (!hasHan(text)) return -1;

  const chars = [...text];
  const opts = chars.map(optionsOf);

  // 先试「从头开始」：能吃到整名就是 0，只吃到一半就是 1
  const fromHead = consume(chars, opts, q, 0);
  if (fromHead >= 0) return fromHead === chars.length - 1 ? 0 : 1;
  // 再试中间任意起点：只在名字中间命中
  for (let start = 1; start < chars.length; start++) {
    if (consume(chars, opts, q, start) >= 0) return 2;
  }
  return -1;
}

/**
 * 把一个中文名转成拼音串。
 *
 * **只在测试和调试里用** —— 搜索本身走 matchPinyin（它要试全部读音）。
 *
 * 多音字取字典里排第一的读音，那个读音**不一定**是常用义：
 * 「石」排第一的是 `dan`（一石粮），「钻石」会拼成 `zuandan`。
 * 所以这个函数不能拿来做匹配，也不能拿它的结果给用户看 —— 只适合排查「这字到底收了没」。
 */
export function toPinyin(text, { initials = false } = {}) {
  const out = [];
  for (const ch of String(text ?? '')) {
    const pys = charTable().get(ch);
    if (!pys || pys.length === 0) {
      // 非汉字原样保留（英文、数字），方便和拼音混着看
      if (/[a-zA-Z0-9]/.test(ch)) out.push(ch.toLowerCase());
      continue;
    }
    out.push(initials ? pys[0][0] : pys[0]);
  }
  return out.join('');
}
