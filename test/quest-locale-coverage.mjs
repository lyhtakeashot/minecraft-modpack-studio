/**
 * 看 zh_cn 里到底有多少任务的标题是中文写的，顺便找出几个能用来冒烟的例子。
 * 用法：node test/quest-locale-coverage.mjs
 */
import { loadQuests } from '../packages/core/quests.js';

const dir = 'D:\\pcl2\\PCL 下载\\整合包\\重度机械症\\versions\\Mechanomania\\config\\ftbquests\\quests';

for (const locale of ['zh_cn', 'en_us']) {
  const store = loadQuests(dir, { locale });
  const bySource = {};
  for (const q of store.quests) bySource[q.titleSource] = (bySource[q.titleSource] ?? 0) + 1;
  console.log(`${locale}: 共 ${store.quests.length} 任务，标题来源 ${JSON.stringify(bySource)}`);
  const titled = store.quests.filter((q) => q.titleSource === 'lang');
  console.log(`  显式标题样例：${titled.slice(0, 5).map((q) => q.title).join(' / ')}`);
  const withDesc = store.quests.filter((q) => q.description.length);
  console.log(`  有描述的任务：${withDesc.length}`);
}
