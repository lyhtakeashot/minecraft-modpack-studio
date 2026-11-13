/**
 * 探针 H：用 ftb-quests-preview 的 QuestStore + lint 直接吃 fixtures，
 * 验证「读现有任务书 → 结构化 → 校验」这条链路能直接跑在 node 里。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'probe', 'ftbqp');
const questDir = path.join(root, 'fixtures', 'quests');

const { QuestStore } = await import('file://' + path.join(root, 'server', 'store.mjs').replace(/\\/g, '/'));
const { lintStore } = await import('file://' + path.join(root, 'server', 'lint.mjs').replace(/\\/g, '/'));

const store = await QuestStore.load({ questDir, locale: 'zh_cn' });
console.log('章节数：', store.chapters.length);
for (const ch of store.chapters) {
  console.log(`  [${ch.id}] ${ch.title} — quests=${ch.quests.length} group=${ch.group || '(无)'}`);
  for (const q of ch.quests) {
    console.log(`      ${q.id} ${q.title} deps=${JSON.stringify(q.dependencies)} tasks=${q.tasks?.length ?? 0}`);
  }
}
console.log('\nquestsById 索引：', store.questsById.size);

console.log('\n=== lint ===');
const issues = lintStore(store);
if (!issues.length) console.log('  无问题');
for (const i of issues) console.log(`  [${i.severity}] ${i.code}: ${i.message}`);

console.log('\n=== 关键：这些都不需要启动游戏 ===');
