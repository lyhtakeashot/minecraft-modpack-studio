/**
 * 任务书的真实数据体检：把 18 个章节 + 3 个语言文件读一遍，跑 lint，
 * 再验一次「改文字 / 挪坐标」只动该动的那几个字节。
 *
 * 用法：node test/real-quests.mjs [questDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadQuests, describeQuests, describeLint, lintQuests, findQuests, relateQuest,
  patchQuestText, patchQuestFields,
} from '../packages/core/quests.js';
import { parseSnbt } from '../packages/core/snbt.js';

const dir = process.argv[2]
  ?? 'D:\\pcl2\\PCL 下载\\整合包\\重度机械症\\versions\\Mechanomania\\config\\ftbquests\\quests';

const t0 = Date.now();
const store = loadQuests(dir);
const ms = Date.now() - t0;

console.log(`加载 ${store.quests.length} 个任务 / ${store.chapters.length} 个章节 / ${store.chapterGroups.length} 个分组，${ms}ms\n`);
console.log(describeQuests(store).join('\n'));

console.log('\n— 体检 —');
const t1 = Date.now();
const issues = lintQuests(store);
console.log(describeLint(issues).join('\n'));
console.log(`（体检耗时 ${Date.now() - t1}ms）`);

// 搜索冒烟
const hits = findQuests(store, 'create', 5);
console.log(`\n— 搜索 "create" 命中 ${hits.length} 条 —`);
for (const h of hits) console.log(`  ${h.title}（${h.chapterTitle}）`);

// 关系冒烟：挑一个有下游的任务
const withDown = store.quests.find((q) => store.quests.some((o) => o.dependencies.includes(q.id)));
if (withDown) {
  const rel = relateQuest(store, withDown.id);
  console.log(`\n— 关系：${rel.quest.title} —`);
  console.log(`  上游：${rel.upstream.map((u) => u.title).join('、') || '（无，是起点）'}`);
  console.log(`  下游：${rel.downstream.map((d) => d.title).join('、') || '（无，是终点）'}`);
}

// ——— 改写冒烟：改标题，必须只动 lang 文件里那一处 ———
const langFile = path.join(dir, 'lang', `${store.locale}.snbt`);
const langSource = fs.readFileSync(langFile, 'utf8');
// 必须挑一个 lang 里**真的有** title 键的任务，才是「替换」；否则测的是「新增」
const sample = store.quests.find((q) => q.titleSource === 'lang' && q.title && q.title !== q.id);
if (!sample) throw new Error('没找到带 lang 标题的任务，冒烟没法测替换');
if (sample) {
  const nextTitle = `${sample.title}（测试）`;
  const r = patchQuestText(langSource, sample.id, { title: nextTitle }, `lang/${store.locale}.snbt`);
  if (!r.changed) throw new Error('应该要改但没改');
  const reparsed = parseSnbt(r.source);
  const key = `quest.${sample.id}.title`;
  if (reparsed[key] !== nextTitle) throw new Error(`改完读回来不对：${reparsed[key]}`);
  const delta = Buffer.byteLength(r.source) - Buffer.byteLength(langSource);
  const expect = Buffer.byteLength(nextTitle) - Buffer.byteLength(String(sample.title));
  console.log(`\n— 改标题冒烟（替换）—`);
  console.log(`  「${sample.title}」→「${nextTitle}」`);
  console.log(`  文件长度变化 ${delta} B，预期 ${expect} B ${delta === expect ? '✓' : '✗'}`);
  console.log(`  其它键数量不变：${Object.keys(reparsed).length === Object.keys(parseSnbt(langSource)).length ? '✓' : '✗'}`);
  if (delta !== expect) throw new Error('字节变化与预期不符，说明改到了别的地方');
}

// ——— 改写冒烟②：给「本来没标题」的任务补标题，必须是新增一个键 ———
const noTitle = store.quests.find((q) => q.titleSource === 'item');
if (noTitle) {
  const key = `quest.${noTitle.id}.title`;
  if (Object.hasOwn(parseSnbt(langSource), key)) throw new Error('这个任务已经有标题键了，测不了新增');
  const r = patchQuestText(langSource, noTitle.id, { title: '补上的标题' }, `lang/${store.locale}.snbt`);
  const reparsed = parseSnbt(r.source);
  if (reparsed[key] !== '补上的标题') throw new Error('新增标题没写进去');
  const keyCount = Object.keys(reparsed).length - Object.keys(parseSnbt(langSource)).length;
  console.log(`\n— 补标题冒烟（新增）—`);
  console.log(`  任务 ${noTitle.id} 原本靠物品名显示「${noTitle.title}」`);
  console.log(`  新增 1 个键：${keyCount === 1 ? '✓' : `✗（实际 ${keyCount}）`}`);
  const before = Object.keys(parseSnbt(langSource));
  const after = Object.keys(reparsed);
  const lost = before.filter((k) => !after.includes(k));
  console.log(`  原有键一个没丢：${lost.length === 0 ? '✓' : `✗ 丢了 ${lost.slice(0, 3).join('、')}`}`);
  if (keyCount !== 1 || lost.length) throw new Error('新增模式把已有键弄坏了');
}

// ——— 改写冒烟：挪坐标，必须只动 chapter 文件里那一处 ———
const chapter = store.chapters.find((c) => c.quests.length > 2);
if (chapter) {
  const chapterSource = fs.readFileSync(chapter.path, 'utf8');
  const quest = chapter.quests[0];
  const r = patchQuestFields(chapterSource, quest.id, { x: quest.x + 3 }, `chapters/${chapter.file}`);
  if (!r.changed) throw new Error('坐标应该要改');
  const reparsed = parseSnbt(r.source);
  const target = reparsed.quests.find((q) => q.id === quest.id);
  if (!target) throw new Error('改完找不到该任务了');
  if (target.x !== quest.x + 3) throw new Error(`坐标没改成：${target.x}`);
  const before = parseSnbt(chapterSource);
  console.log(`\n— 挪坐标冒烟 —`);
  console.log(`  ${quest.title}：x ${quest.x} → ${target.x}，仍可解析 ✓`);
  console.log(`  任务数量 ${before.quests.length} → ${reparsed.quests.length}（应不变）${before.quests.length === reparsed.quests.length ? '✓' : '✗'}`);
  // 其它任务的坐标不能被碰
  let touched = 0;
  for (const q of before.quests) {
    if (q.id === quest.id) continue;
    const after = reparsed.quests.find((o) => o.id === q.id);
    if (JSON.stringify(after) !== JSON.stringify(q)) touched += 1;
  }
  console.log(`  其它任务被改动数量：${touched}（应为 0）${touched === 0 ? '✓' : '✗'}`);
  if (touched !== 0) throw new Error('改一个任务时把别的任务也改了');
}

console.log('\n全部冒烟通过。');
