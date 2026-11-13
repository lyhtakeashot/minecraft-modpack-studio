/**
 * 拿第二个真实整合包（ATM10 Sky，1.20.1 Forge 系）验一遍，
 * 确认工具不是只为某一个包写的。
 * 用法：node test/real-quests-atm.mjs
 */
import { loadQuests, describeQuests, lintQuests, describeLint, findQuests } from '../packages/core/quests.js';

const dir = 'D:\\pcl2\\PCL 下载\\整合包\\atm10sky\\versions\\All the Mods 10：To the Sky   ATM10SKY\\config\\ftbquests\\quests';

const t0 = Date.now();
const store = loadQuests(dir, { locale: 'zh_cn' });
const ms = Date.now() - t0;

console.log(`加载 ${store.quests.length} 个任务 / ${store.chapters.length} 个章节 / ${store.chapterGroups.length} 个分组，${ms}ms`);
const bySource = {};
for (const q of store.quests) bySource[q.titleSource] = (bySource[q.titleSource] ?? 0) + 1;
console.log(`标题来源分布：${JSON.stringify(bySource)}`);
console.log(`可用语言：${store.locales.join('、')}`);

const issues = lintQuests(store);
const byLevel = { error: 0, warn: 0, info: 0 };
for (const i of issues) byLevel[i.level] += 1;
console.log(`\n体检：${byLevel.error} 错误 / ${byLevel.warn} 警告 / ${byLevel.info} 提示`);
for (const i of issues.filter((x) => x.level === 'error').slice(0, 10)) {
  console.log(`  [错误] ${i.where}：${i.message}`);
}

const hits = findQuests(store, 'diamond', 3);
console.log(`\n搜 "diamond" 命中 ${hits.length} 条`);
for (const h of hits) console.log(`  ${h.title} —— ${h.chapterTitle}`);

// 章节最大的几个
const top = [...store.chapters].sort((a, b) => b.quests.length - a.quests.length).slice(0, 5);
console.log('\n任务最多的 5 个章节：');
for (const c of top) console.log(`  ${c.title} —— ${c.quests.length} 个任务`);
