// 临时探针：对刚建出来的最小包做 dry-run（不启动进程）。
// 直接调 core 的 launch 模块（插件版的 mc_launch_test 工具层已删）。
import { plan, describePlan, renderCommand } from '../packages/core/launch.js';

const dir = String.raw`D:\Desktop\VibeCoding\dsh-minecraft-modpack-studio\lab\重度机械症 - 实验\versions\最小包`;

const p = plan({ instanceDir: dir });
console.log(describePlan(p).join('\n'));
console.log('---');
console.log('java =', p.java?.path, 'major', p.java?.major, '来源', p.java?.source);
console.log('missing libs =', (p.stats?.missing ?? []).length);
console.log('classpath entries =', p.classpath?.length, 'hasClientJar =', p.hasClientJar);
console.log('missingVars =', p.missingVars);
console.log('command 前 300 字 =', renderCommand(p.argv).slice(0, 300));
