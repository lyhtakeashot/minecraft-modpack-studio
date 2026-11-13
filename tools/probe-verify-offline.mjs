// 临时探针：验证「解压出来的 offline 包」能不能启动（等价于 PCL 装完再启动）。
// 用法：node tools/probe-verify-offline.mjs [apply]
// 直接调 core 的 launch 模块（插件版的 mc_launch_test 工具层已删）。
import { plan, describePlan, launch } from '../packages/core/launch.js';

const dir = String.raw`D:\Desktop\VibeCoding\minecraft-modpack-studio\lab\_verify_offline\最小包-offline\versions\最小包`;
const apply = process.argv[2] === 'apply';

const p = plan({ instanceDir: dir });
console.log(describePlan(p).join('\n'));
console.log('---');
console.log('java =', p.java?.path, 'major', p.java?.major, '来源', p.java?.source);
console.log('missing libs =', (p.stats?.missing ?? []).length);
console.log('classpath entries =', p.classpath?.length, 'hasClientJar =', p.hasClientJar);
console.log('missingVars =', p.missingVars);

if (apply) {
  const result = await launch(p, { timeoutMs: 480000, settleMs: 5000 });
  console.log('--- verdict ---');
  console.log(JSON.stringify(result.verdict, null, 2));
  console.log('--- tail ---');
  console.log((result.tail ?? []).join('\n'));
}
