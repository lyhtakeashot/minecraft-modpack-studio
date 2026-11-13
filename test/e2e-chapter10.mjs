/**
 * 端到端验收（用户验收项 #6）：在副本上「新建一章 10 个任务的章节」，跑通全链路。
 * 原包不动。
 *
 * 现在直接调 packages/core/ 里的底层函数（面板那条线走的也是它们）：
 *   planAddChapter / planAddQuest → commitQuestPlan → lintQuests / loadQuests
 *
 * 用法：node --import ./test/register.mjs test/e2e-chapter10.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitQuestPlan, describeQuestPlan, planAddChapter, planAddQuest } from '../packages/core/quest-create.js';
import { describeLint, lintQuests, loadQuests } from '../packages/core/quests.js';

const SRC = 'D:\\pcl2\\PCL 下载\\整合包\\重度机械症\\versions\\Mechanomania\\config\\ftbquests\\quests';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-e2e-'));
const questDir = path.join(tmp, 'quests');
fs.cpSync(SRC, questDir, { recursive: true });

const before = loadQuests(questDir, { locale: 'zh_cn' });
console.log(`起始：${before.chapters.length} 章节 / ${before.quests.length} 任务`);

// 1) 建章节：先算（只算不写），再真写
let store = before;
const chapterPlan = planAddChapter({
  questDir,
  store,
  title: '我的第一段任务线',
  icon: 'create:cogwheel',
  group: '主世界-养老生活',
});
console.log(`\n[演练建章节]\n${describeQuestPlan(chapterPlan).join('\n')}`);
const chapterDone = commitQuestPlan({ plan: chapterPlan, questDir, store });
console.log(`\n[真写建章节]\n${chapterDone.lines.join('\n')}`);
store = chapterDone.after;

// 2) 连加 10 个任务，每个接在上一个后面
const chain = [
  ['先挖点安山岩', 'minecraft:andesite', 16],
  ['做几个齿轮', 'create:cogwheel', 2],
  ['造个动力辊压机', 'create:mechanical_press', 1],
  ['做传动轴', 'create:shaft', 8],
  ['来点应力', 'create:water_wheel', 1],
  ['做个磨石', 'create:millstone', 1],
  ['筛矿', 'create:crushing_wheel', 1],
  ['搞点黄铜', 'create:brass_ingot', 4],
  ['做个机械手', 'create:deployer', 1],
  ['最后来个安山机壳', 'create:andesite_casing', 4],
];

let prev = null;
for (const [i, [title, item, count]] of chain.entries()) {
  const plan = planAddQuest({
    questDir,
    store,
    chapter: chapterPlan.chapterId,
    title,
    taskItem: item,
    taskCount: count,
    dependsOn: prev ? [prev] : undefined,
    description: [`第 ${i + 1} 步：弄到 ${item}`],
  });
  const done = commitQuestPlan({ plan, questDir, store });
  store = done.after;
  prev = plan.questId;
  if (i === 0 || i === chain.length - 1) console.log(`  任务 ${i + 1}：${title}（${plan.questId}）✓`);
}
console.log(`\n已加 ${chain.length} 个任务，链尾 ${prev}`);

// 3) 重读 + 体检
const after = loadQuests(questDir, { locale: 'zh_cn' });
const chapter = after.chapters.find((c) => c.id === chapterPlan.chapterId);
console.log(`重读：${after.chapters.length} 章节 / ${after.quests.length} 任务；新章节 ${chapter.quests.length} 个任务`);
if (chapter.quests.length !== 10) throw new Error(`新章节应有 10 个任务，实际 ${chapter.quests.length}`);

// 依赖链必须首尾相连
let cursor = chapter.quests.find((q) => !q.dependencies.length);
let hops = 0;
while (cursor) {
  hops += 1;
  const nextId = chapter.quests.find((q) => q.dependencies.includes(cursor.id));
  if (!nextId) break;
  cursor = nextId;
}
console.log(`依赖链长度：${hops}（应为 10）`);
if (hops !== 10) throw new Error('依赖链断了');

// 4) 体检
const issues = lintQuests(after);
const errs = issues.filter((i) => i.level === 'error');
console.log(`\n${describeLint(issues).join('\n')}`);
if (errs.length) throw new Error('体检有错误');

// 5) 列章节能看见新章
const listed = after.chapters.find((c) => c.id === chapterPlan.chapterId);
console.log(`章节列表里：${listed.title} / ${listed.quests.length} 个任务 / 分组 ${listed.group}`);
if (listed.quests.length !== 10) throw new Error('列表任务数不对');

// 6) 原包必须没动
const origList = loadQuests(SRC, { locale: 'zh_cn' });
console.log(`\n原包仍为 ${origList.chapters.length} 章节 / ${origList.quests.length} 任务（未受影响）`);
if (origList.chapters.length !== before.chapters.length) throw new Error('❌ 原包被改了');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✅ 端到端通过：新建一章 10 个任务，依赖成链，体检 0 错误，原包未动。');
