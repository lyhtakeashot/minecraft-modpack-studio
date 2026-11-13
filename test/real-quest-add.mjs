/**
 * 在真实任务书的副本上验证「加任务 / 加章节」两个写能力。
 * 原包绝不能动。
 *
 * 现在直接调 packages/core/ 里的底层函数（界面那条线走的也是它们）：
 *   planAddQuest / planAddChapter → commitQuestPlan
 *
 * 用法：node test/real-quest-add.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitQuestPlan, describeQuestPlan, planAddChapter, planAddQuest } from '../packages/core/quest-create.js';
import { loadQuests, lintQuests } from '../packages/core/quests.js';

const SRC = 'D:\\pcl2\\PCL 下载\\整合包\\重度机械症\\versions\\Mechanomania\\config\\ftbquests\\quests';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-add-'));
const questDir = path.join(tmp, 'quests');
fs.cpSync(SRC, questDir, { recursive: true });
console.log(`副本：${questDir}`);

const before = loadQuests(questDir, { locale: 'zh_cn' });
const beforeErrors = lintQuests(before).filter((i) => i.level === 'error').length;
console.log(`起始：${before.quests.length} 任务 / ${before.chapters.length} 章节 / ${beforeErrors} 错误`);

const target = before.chapters.find((c) => c.file === 'create1.snbt');

// ——— 1) 演练：加任务（只算不写） ———
const draft = planAddQuest({
  questDir, store: before, chapter: target.id,
  title: '测试：做一个齿轮', description: ['先做齿轮', '再谈别的'],
  taskItem: 'create:cogwheel', taskCount: 2,
  rewardItem: 'minecraft:iron_ingot', rewardCount: 4,
});
console.log(`\n[演练加任务]\n${describeQuestPlan(draft).join('\n')}`);
const afterTarget = loadQuests(questDir, { locale: 'zh_cn' });
if (afterTarget.quests.length !== before.quests.length) throw new Error('演练居然改了文件');

// ——— 2) 真写：加任务 ———
const questPlan = planAddQuest({
  questDir, store: before, chapter: target.id,
  title: '测试：做一个齿轮', description: ['先做齿轮', '再谈别的'],
  taskItem: 'create:cogwheel', taskCount: 2,
  rewardItem: 'minecraft:iron_ingot', rewardCount: 4,
});
const done = commitQuestPlan({ plan: questPlan, questDir, store: before });
console.log(`\n[真写加任务] questId=${questPlan.questId}`);
console.log(done.lines.join('\n'));

const after1 = loadQuests(questDir, { locale: 'zh_cn' });
console.log(`\n重读：${after1.quests.length} 任务（原 ${before.quests.length}）`);
if (after1.quests.length !== before.quests.length + 1) throw new Error('任务数没 +1');
const created = after1.questsById.get(questPlan.questId);
if (!created) throw new Error('新任务读不到');
if (created.title !== '测试：做一个齿轮') throw new Error(`标题不对：${created.title}`);
if (created.titleSource !== 'lang') throw new Error(`标题来源不对：${created.titleSource}`);
if (created.description.length !== 2) throw new Error(`描述不对：${JSON.stringify(created.description)}`);
if (created.taskSummary[0]?.what !== 'create:cogwheel') throw new Error('任务条件不对');
console.log(`新任务：${created.title} / 条件 ${JSON.stringify(created.taskSummary)} / 位置 (${created.x}, ${created.y})`);

// ——— 3) 加带依赖的任务 ———
const plan2 = planAddQuest({
  questDir, store: after1, chapter: target.id,
  title: '测试：依赖上一个', taskItem: 'create:shaft',
  dependsOn: [questPlan.questId],
});
const done2 = commitQuestPlan({ plan: plan2, questDir, store: after1 });
const after2 = loadQuests(questDir, { locale: 'zh_cn' });
const q2 = after2.questsById.get(plan2.questId);
if (!q2) throw new Error('带依赖的任务读不到');
if (q2.dependencies[0] !== questPlan.questId) throw new Error('依赖没写进去');
console.log(`带依赖的任务：${q2.title} 依赖 ${q2.dependencies.join(',')} ✓`);

// ——— 4) 依赖不存在的任务必须被拒 ———
let rejected = null;
try {
  planAddQuest({
    questDir, store: after2, chapter: target.id, title: '坏依赖', dependsOn: ['NOT_A_REAL_ID'],
  });
} catch (e) {
  rejected = { error: String(e?.message ?? e), code: e?.code ?? '' };
}
console.log(`\n[假依赖应被拒] ${rejected ? `code=${rejected.code}` : '❌ 居然通过了'}`);
if (!rejected) throw new Error('假依赖居然通过了');
console.log(`   拒绝原因：${rejected.error}`);

// ——— 5) 演练：加章节 ———
const chapterDraft = planAddChapter({
  questDir, store: after2, title: '测试章节', icon: 'create:cogwheel',
});
console.log(`\n[演练加章节]\n${describeQuestPlan(chapterDraft).join('\n')}`);
const afterDraft = loadQuests(questDir, { locale: 'zh_cn' });
if (afterDraft.chapters.length !== after2.chapters.length) throw new Error('演练居然改了文件');

// ——— 6) 真写：加章节 ———
const chapterPlan = planAddChapter({
  questDir, store: after2, title: '测试章节', icon: 'create:cogwheel',
});
const chapterDone = commitQuestPlan({ plan: chapterPlan, questDir, store: after2 });
console.log(`\n[真写加章节] id=${chapterPlan.chapterId}`);
console.log(chapterDone.lines.join('\n'));

const after3 = loadQuests(questDir, { locale: 'zh_cn' });
if (after3.chapters.length !== after2.chapters.length + 1) throw new Error('章节数没 +1');
const newChapter = after3.chapters.find((c) => c.id === chapterPlan.chapterId);
if (!newChapter) throw new Error('新章节读不到');
if (newChapter.title !== '测试章节') throw new Error(`章节标题不对：${newChapter.title}`);
console.log(`新章节：${newChapter.title} / 文件 ${newChapter.file} / 分组 ${newChapter.group || '无'} ✓`);

// ——— 7) 体检不能变差 ———
const afterErrors = lintQuests(after3).filter((i) => i.level === 'error').length;
console.log(`\n体检错误：原 ${beforeErrors} → 现有 ${afterErrors}`);
if (afterErrors > beforeErrors) throw new Error('引入了新错误');

// ——— 8) 原包未动 ———
const origFiles = fs.readdirSync(path.join(SRC, 'chapters')).sort();
const copyFiles = fs.readdirSync(path.join(questDir, 'chapters')).filter((n) => !n.includes('.bak-')).sort();
console.log(`原包 chapters 文件数 ${origFiles.length}，副本现 ${copyFiles.length}（应 +1）`);
if (copyFiles.length !== origFiles.length + 1) throw new Error('文件数不对');

// 原包的文件必须一个字节都没变（章节文件和语言文件都查）
for (const name of origFiles) {
  const a = fs.readFileSync(path.join(SRC, 'chapters', name));
  const b = fs.readFileSync(path.join(questDir, 'chapters', name));
  if (!a.equals(b)) throw new Error(`❌ 原包章节文件被改动：${name}`);
}
for (const name of fs.readdirSync(path.join(SRC, 'lang'))) {
  const a = fs.readFileSync(path.join(SRC, 'lang', name));
  const b = fs.readFileSync(path.join(questDir, 'lang', name));
  if (!a.equals(b)) throw new Error(`❌ 原包 lang 被改动：${name}`);
}
console.log('原包未动 ✓');

// ——— 9) 看一眼生成的新章节文件长什么样 ———
console.log(`\n新章节文件内容（前 800 字）：\n${fs.readFileSync(path.join(questDir, 'chapters', newChapter.file), 'utf8').slice(0, 800)}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n全部通过，副本已清理。');
