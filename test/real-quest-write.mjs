/**
 * 在真实任务书的**副本**上做一次完整写盘验证。
 * 绝不碰原包 —— 只有副本改了才算通过。
 *
 * 用法：node test/real-quest-write.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadQuests, lintQuests, describeLint } from '../packages/core/quests.js';
import { parseSnbt } from '../packages/core/snbt.js';

const SRC = 'D:\\pcl2\\PCL 下载\\整合包\\重度机械症\\versions\\Mechanomania\\config\\ftbquests\\quests';
const LOCALE = 'zh_cn';

// 1) 复制到临时目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmc-write-'));
const copy = path.join(tmp, 'quests');
fs.cpSync(SRC, copy, { recursive: true });
console.log(`副本：${copy}`);

const before = loadQuests(copy, { locale: LOCALE });
console.log(`读入 ${before.quests.length} 任务 / ${before.chapters.length} 章节`);

// 2) 挑一个 lang 里有显式标题的任务
const sample = before.quests.find((q) => q.titleSource === 'lang');
if (!sample) throw new Error('没有带显式标题的任务');
console.log(`\n目标：${sample.title}（${sample.id}）`);

const langPath = path.join(copy, 'lang', `${LOCALE}.snbt`);
const langBefore = fs.readFileSync(langPath, 'utf8');

// 3) 走正式工具的补丁逻辑（直接调 core，等价于 apply 时的行为）
const { patchQuestText, patchQuestFields } = await import('../packages/core/quests.js');
const newTitle = `${sample.title}·已改`;
const r = patchQuestText(langBefore, sample.id, { title: newTitle }, `lang/${LOCALE}.snbt`);
if (!r.changed) throw new Error('补丁没有生效');

// 4) 真写（模拟工具里的备份 + 写入）
const backup = `${langPath}.bak-test`;
fs.copyFileSync(langPath, backup);
fs.writeFileSync(langPath, r.source, 'utf8');
console.log(`\n已写入 lang/${LOCALE}.snbt`);
console.log(`  字节变化 ${Buffer.byteLength(r.source) - Buffer.byteLength(langBefore)}（备份 ${path.basename(backup)}）`);

// 5) 重读：任务数不变、标题变了、其它任务一个没动
const after = loadQuests(copy, { locale: LOCALE });
const changed = after.questsById.get(sample.id);
if (changed.title !== newTitle) throw new Error(`标题没改成功：${changed.title}`);
if (after.quests.length !== before.quests.length) throw new Error('任务数变了');
let touched = 0;
for (const q of before.quests) {
  if (q.id === sample.id) continue;
  const now = after.questsById.get(q.id);
  if (!now || now.title !== q.title || JSON.stringify(now.taskSummary) !== JSON.stringify(q.taskSummary)) touched += 1;
}
console.log(`  重读：${after.quests.length} 任务，标题已变 ✓，其它任务被改动 ${touched} 个（应为 0）`);
if (touched !== 0) throw new Error('改一个标题影响了别的任务');

// 6) 再验证：别的语言文件不能被碰
for (const other of ['en_us', 'th_th']) {
  const p = path.join(copy, 'lang', `${other}.snbt`);
  if (!fs.existsSync(p)) continue;
  const a = fs.readFileSync(path.join(SRC, 'lang', `${other}.snbt`), 'utf8');
  const b = fs.readFileSync(p, 'utf8');
  if (a !== b) throw new Error(`${other}.snbt 被误改了`);
}
console.log('  其它语言文件原样未动 ✓');

// 7) 改写后仍能体检通过（错误数不增加）
const issuesBefore = lintQuests(before).filter((i) => i.level === 'error').length;
const issuesAfter = lintQuests(after).filter((i) => i.level === 'error').length;
console.log(`\n体检错误数：改写前 ${issuesBefore} → 改写后 ${issuesAfter}`);
if (issuesAfter > issuesBefore) throw new Error('改写引入了新错误');

// 8) 原包必须一个字节都没动
const origLang = fs.readFileSync(path.join(SRC, 'lang', `${LOCALE}.snbt`), 'utf8');
if (origLang !== langBefore) throw new Error('❌ 原包被改动了！');
console.log('原包未被改动 ✓');

// 9) 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n全部通过，临时副本已清理。');
