/**
 * 端到端走一遍「从零加章节 → 往章里加任务」，走的是面板同一批宿主 handler。
 * 用实验室里的「最小包」（任务书是空的），不碰用户的真包。
 *
 * 跑法：node --import ./test/register.mjs tools/probe-quest-new.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  handleChapterAddPreview,
  handleChapterAddApply,
  handleQuestAddPreview,
  handleQuestAddApply,
} from '../lib/host/quest-api.js';
import { loadQuests } from '../packages/core/quests.js';
import { resolveInstance } from '../packages/core/instance.js';

const LAB = String.raw`D:\Desktop\VibeCoding\minecraft-modpack-studio\lab\重度机械症 - 实验`;
const instanceDir = path.join(LAB, 'versions', '最小包');
const instance = resolveInstance(instanceDir);
console.log('实例：', instance.id, instance.mcVersion, instance.loader);

// 假 request：handler 只认 url / method / text() 三样，text 必须是函数
const mkReq = (method, url, body) => ({
  method,
  url,
  text: async () => (body ? JSON.stringify(body) : ''),
});

/** loadQuests 的 quests 可能是数组也可能是 Map，统一转成数组。 */
const questList = (store) => {
  const q = store.quests;
  if (!q) return [];
  return Array.isArray(q) ? q : [...q.values()];
};

const questDir = path.join(instanceDir, 'config', 'ftbquests', 'quests');
const before = loadQuests(questDir);
console.log(`改之前：${before.chapters.length} 章 / ${questList(before).length} 个任务`);

// ① 预览建章节
const cPreview = await handleChapterAddPreview(
  mkReq('POST', '/quest/chapter/preview', {
    dir: instanceDir,
    title: '第一章 起步',
    icon: 'create:cogwheel',
  }),
);
console.log('\n[建章节 预览]', JSON.stringify(cPreview, null, 1).slice(0, 600));

// ② 真建章节
const cApply = await handleChapterAddApply(
  mkReq('POST', '/quest/chapter/apply', {
    dir: instanceDir,
    title: '第一章 起步',
    icon: 'create:cogwheel',
  }),
);
console.log('\n[建章节 写入]', JSON.stringify(cApply, null, 1).slice(0, 800));

const afterChapter = loadQuests(questDir);
console.log(`建完章节：${afterChapter.chapters.length} 章 / ${questList(afterChapter).length} 个任务`);
const chapterId = afterChapter.chapters[0]?.id;
console.log('章节 ID =', chapterId, '标题 =', afterChapter.chapters[0]?.title);

// ③ 预览加任务
const qPreview = await handleQuestAddPreview(
  mkReq('POST', '/quest/add/preview', {
    dir: instanceDir,
    chapter: chapterId,
    title: '做一台压片机',
    taskItem: 'create:mechanical_press',
    taskCount: 1,
  }),
);
console.log('\n[加任务 预览]', JSON.stringify(qPreview, null, 1).slice(0, 800));

// ④ 真加任务
const qApply = await handleQuestAddApply(
  mkReq('POST', '/quest/add/apply', {
    dir: instanceDir,
    chapter: chapterId,
    title: '做一台压片机',
    taskItem: 'create:mechanical_press',
    taskCount: 1,
  }),
);
console.log('\n[加任务 写入]', JSON.stringify(qApply, null, 1).slice(0, 800));

const after = loadQuests(questDir);
console.log(`\n改完：${after.chapters.length} 章 / ${questList(after).length} 个任务`);
for (const q of questList(after)) {
  console.log(`  - ${q.title}  坐标 (${q.x}, ${q.y})  依赖 ${JSON.stringify(q.dependencies ?? [])}`);
}
console.log('\n语言文件：');
for (const f of fs.readdirSync(path.join(questDir, 'lang'))) {
  const p = path.join(questDir, 'lang', f);
  console.log(`  ${f}  ${fs.statSync(p).size} B`);
  console.log(fs.readFileSync(p, 'utf8').split('\n').slice(0, 12).join('\n'));
}
console.log('\n章节文件：');
for (const f of fs.readdirSync(path.join(questDir, 'chapters'))) {
  console.log(`  ${f}  ${fs.statSync(path.join(questDir, 'chapters', f)).size} B`);
}
