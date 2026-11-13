/**
 * 测试期的模块替身注册器。
 *
 * 插件在真机上从 DSH 安装目录解析 `@deepseek-ai/dsh-tools`；在仓库里跑单测时
 * 没有那条解析链，于是用 Node 的 module hook 把这些裸包名指到本地替身。
 * 只在 `node --import ./test/register.mjs ...` 下生效，绝不影响真实运行。
 *
 * 用替身而不是往 node_modules 里塞假包：本地目录安装会把整个仓库链进 profile，
 * 假的 node_modules 可能反过来遮住真包。
 */
import { register } from 'node:module';

register(new URL('./resolve-hook.mjs', import.meta.url).href);
