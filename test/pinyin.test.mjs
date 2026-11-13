/**
 * 拼音表的单测 —— 锁的是「多音字不能只留一个读音」这个真实踩过的坑。
 *
 * 背景：第一版生成脚本只取字典里第一个读音，结果「镐」→ `hao`（镐京），
 * 用户打 `zuanshigao` 搜不到「钻石镐」。所以这里必须把多音字单独测。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pinyinOf, pinyinCharCount, hasHan, isPinyinQuery, matchPinyin, toPinyin } from '../packages/core/pinyin.js';

test('字库规模对得上（21132 个 CJK 基本区汉字）', () => {
  assert.equal(pinyinCharCount(), 21132);
});

test('常用字读音正确', () => {
  assert.deepEqual(pinyinOf('钻'), ['zuan']);
  assert.deepEqual(pinyinOf('铁'), ['tie']);
  assert.deepEqual(pinyinOf('锭'), ['ding']);
  assert.deepEqual(pinyinOf('黄'), ['huang']);
  assert.deepEqual(pinyinOf('铜'), ['tong']);
});

test('多音字保留全部读音（只留第一个会搜不到东西）', () => {
  // 镐：gao（镐头）/ hao（镐京）—— 只留 hao 就搜不到「钻石镐」
  assert.ok(pinyinOf('镐').includes('gao'), '「镐」丢了 gao 这个读音');
  assert.ok(pinyinOf('镐').includes('hao'), '「镐」丢了 hao 这个读音');
  // 石：shi（石头）/ dan（一石粮）
  assert.ok(pinyinOf('石').includes('shi'));
  assert.ok(pinyinOf('石').includes('dan'));
  // 壳：ke（贝壳）/ qiao（地壳）
  assert.ok(pinyinOf('壳').includes('ke'));
  assert.ok(pinyinOf('壳').includes('qiao'));
});

test('非汉字返回空数组', () => {
  assert.deepEqual(pinyinOf('a'), []);
  assert.deepEqual(pinyinOf('，'), []);
  assert.deepEqual(pinyinOf(''), []);
  assert.deepEqual(pinyinOf('1'), []);
});

test('hasHan 认汉字', () => {
  assert.equal(hasHan('钻石镐'), true);
  assert.equal(hasHan('diamond'), false);
  assert.equal(hasHan('钻石 diamond'), true);
  assert.equal(hasHan(''), false);
});

test('isPinyinQuery 只认纯小写字母', () => {
  assert.equal(isPinyinQuery('zuanshi'), true);
  assert.equal(isPinyinQuery('zs'), true);
  assert.equal(isPinyinQuery('zuan shi'), false, '带空格不该当拼音');
  assert.equal(isPinyinQuery('钻石'), false);
  assert.equal(isPinyinQuery('zuan2'), false);
  assert.equal(isPinyinQuery(''), false);
});

test('全拼命中整名 = 0', () => {
  assert.equal(matchPinyin('钻石镐', 'zuanshigao'), 0);
});

test('首字母缩写命中整名 = 0', () => {
  assert.equal(matchPinyin('钻石镐', 'zsg'), 0);
});

test('全拼只命中名字前缀 = 1', () => {
  assert.equal(matchPinyin('钻石镐', 'zuanshi'), 1);
});

test('只命中中间某一段 = 2', () => {
  // 「镐」的另一个读音 gao 出现在名字末尾
  assert.equal(matchPinyin('钻石镐', 'gao'), 2);
});

test('拼不上返回 -1', () => {
  assert.equal(matchPinyin('钻石镐', 'xyz'), -1);
  assert.equal(matchPinyin('钻石镐', 'tieding'), -1);
});

test('标点和空格不会切断拼音链（「钻石 镐」也要能搜）', () => {
  assert.equal(matchPinyin('钻石 镐', 'zuanshigao'), 0);
  assert.equal(matchPinyin('钻石-镐', 'zuanshigao'), 0);
});

test('名字里混着英文时英文当跳过', () => {
  assert.equal(matchPinyin('钻石 Pickaxe', 'zuanshi'), 1);
});

test('toPinyin 拼整串（多音字取第一个读音，只给调试看）', () => {
  assert.equal(toPinyin('钻石'), 'zuandan', '「石」的第一读音是 dan（一石粮），不是 shi');
  assert.equal(toPinyin('钻石', { initials: true }), 'zd');
  assert.equal(toPinyin('齿轮'), 'chilun');
  // 这条是关键：toPinyin 拼错了不代表搜不到，匹配走 matchPinyin 会试全部读音
  assert.equal(matchPinyin('钻石', 'zuanshi'), 0);
});

test('空串和纯标点不炸', () => {
  assert.equal(matchPinyin('', 'zuanshi'), -1);
  assert.equal(toPinyin(''), '');
  assert.equal(toPinyin('，。'), '');
});
