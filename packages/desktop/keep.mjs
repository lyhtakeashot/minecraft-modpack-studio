/**
 * 重打包时「保住用户数据」的那段逻辑。
 *
 * ## 为什么要单独拎出来
 *
 * 用户 2026-11-02 第二次报「快捷方式还是打不开」。查下来第一层是快捷方式指错了
 * 地方（指向早就删掉的 packages/server/启动.vbs），第二层才是真要命的：
 * `dist/desktop/` 每次打包都被整个删掉重建，于是
 *
 *   - `safe-mode.stamp`：主进程在「安全模式成功加载过页面」时写下的标记，
 *     下次启动看到它就自动按安全模式起。用户的机器普通模式必崩
 *     （0x80000003，GPU 硬件加速不兼容），只有安全模式能活 ——
 *     也就是说这个文件就是「这台机器能用」本身，删了就等于又打不开了。
 *   - `boot.pending`：「上次启动没走到加载完成」的痕迹，下次启动据此自愈。
 *   - `用户数据/`：Electron 的 userData 目录，里面有记住的整合包目录。
 *
 * 这段逻辑放在 build.mjs 里就跟那 325 MB 的复制绑在一起没法单测，
 * 所以单独放到这里，`test/desktop.test.mjs` 能用几个空目录直接验。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 打包时必须原样留住的顶层文件（相对 OUT_DIR）。 */
export const KEEP_FILES = ['safe-mode.stamp', 'boot.pending'];

/** 打包时必须原样留住的顶层目录（相对 OUT_DIR）。 */
export const KEEP_DIRS = ['用户数据'];

/** 递归复制目录（overwrite 语义：目标已存在就覆盖同名文件）。 */
export function copyTree(from, to) {
  const st = fs.statSync(from);
  if (!st.isDirectory()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    copyTree(path.join(from, entry.name), path.join(to, entry.name));
  }
}

/**
 * 把 OUT_DIR 里该留住的用户数据拷到临时暂存目录。
 *
 * @param {string} outDir 打包输出目录（不存在时返回 savedRoot=''）
 * @param {string} tmpRoot 临时目录，用它建暂存子目录
 * @returns {{savedRoot: string, files: string[], dirs: string[]}}
 */
export function stashUserData(outDir, tmpRoot) {
  if (!fs.existsSync(outDir)) return { savedRoot: '', files: [], dirs: [] };
  const savedRoot = fs.mkdtempSync(path.join(tmpRoot, 'mcstudio-keep-'));
  const files = [];
  const dirs = [];
  for (const name of KEEP_FILES) {
    const from = path.join(outDir, name);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(savedRoot, name));
      files.push(name);
    }
  }
  for (const name of KEEP_DIRS) {
    const from = path.join(outDir, name);
    if (fs.existsSync(from)) {
      copyTree(from, path.join(savedRoot, name));
      dirs.push(name);
    }
  }
  return { savedRoot, files, dirs };
}

/**
 * 把暂存目录里的东西放回 OUT_DIR，然后清掉暂存目录。
 *
 * 放不回去只记 warn，不抛：打包本身是成功的，用户数据丢了确实难受，
 * 但为这个让整个打包失败更糟（用户会以为包坏了）。
 *
 * @param {{savedRoot: string, files: string[], dirs: string[]}} saved
 * @param {string} outDir
 * @returns {{restored: string[], failed: {name: string, message: string}[]}}
 */
export function restoreUserData(saved, outDir) {
  const restored = [];
  const failed = [];
  if (!saved || !saved.savedRoot) return { restored, failed };
  for (const name of saved.files) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(path.join(saved.savedRoot, name), path.join(outDir, name));
      restored.push(name);
    } catch (error) {
      failed.push({ name, message: error?.message ?? String(error) });
    }
  }
  for (const name of saved.dirs) {
    try {
      copyTree(path.join(saved.savedRoot, name), path.join(outDir, name));
      restored.push(name);
    } catch (error) {
      failed.push({ name, message: error?.message ?? String(error) });
    }
  }
  try {
    fs.rmSync(saved.savedRoot, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不碍事 */
  }
  return { restored, failed };
}
