/**
 * 探针：把一个实例启动起来，然后**不管它**（不判主菜单、不杀进程）。
 *
 * 和 probe-launch-apply.mjs 的区别：那个是「验证能不能起来」，判到主菜单就 SIGTERM；
 * 这个是为了让人在游戏里操作（比如跑 /iconexporter export 导图标），
 * 所以必须 detached + unref，脚本自己退出，游戏窗口留着。
 *
 * 用法：node --import ./test/register.mjs tools/probe-launch-leave.mjs <实例目录>
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { plan } from '../packages/core/launch.js';
import { extractNatives } from '../packages/core/natives.js';

const instanceDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve('lab', '重度机械症 - 实验', 'versions', '最小包');

const p = plan({ instanceDir });
// natives 必须在 spawn 之前解出来，否则 lwjgl.dll 找不到、窗口都画不出来
const natives = extractNatives(p.natives, p.nativesDir);
console.log('实例：', instanceDir);
console.log('Java：', p.java.path);
console.log('natives：', `${natives.files} 个文件 → ${p.nativesDir}`);
console.log('classpath：', p.classpath.length, '项');

const child = spawn(p.java.path, [...p.jvmArgs, p.mainClass, ...p.gameArgs], {
  cwd: p.gameDir,
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
  env: { ...process.env },
});
child.unref();
console.log('已启动，pid =', child.pid, '（脚本会一直挂着，别关这个任务）');

// ⚠️ 不能这里就退出：宿主会把整个进程树回收掉，游戏跟着陪葬（踩过一次）。
// 挂在这里的意义就是「替游戏挡着」，等外部 job_kill 才收尾。
child.on('exit', (code) => {
  console.log('游戏退出了，code =', code);
  process.exit(0);
});
setInterval(() => {}, 1 << 30);