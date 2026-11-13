// 临时探针：真启动「向导装好的包」，等它到主菜单。
// 直接调 core 的 launch 模块（插件版的 mc_launch_test 工具层已删）。
import { plan, describePlan, launch } from '../packages/core/launch.js';

const dir = String.raw`D:\Desktop\VibeCoding\minecraft-modpack-studio\lab\_scaffold\mcroot\versions\向导装好的包`;

const p = plan({ instanceDir: dir });
console.log(describePlan(p).join('\n'));
console.log('--- result ---');

const result = await launch(p, { timeoutMs: 480000, settleMs: 5000 });
console.log(JSON.stringify(result.verdict, null, 2));
console.log('--- evidence ---');
console.log(result.evidenceKind, '|', result.evidence);
