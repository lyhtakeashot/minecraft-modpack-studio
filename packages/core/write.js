/**
 * 带备份 + 自动回滚的批量写盘。
 *
 * 所有会改文件的地方都走这里，原因只有一个：**写完发现不对要能立刻还原**。
 * 实测最有价值的一次是任务书写完重读体检，发现新错误就把两个文件一起回滚，
 * 用户完全看不到中间态。
 */
import fs from 'node:fs';
import path from 'node:path';
import { McError } from './errors.js';

/**
 * 写一批文件，每个先备份成 `<名>.bak-<时间戳>`。
 *
 * @param {Array<{file: string, content: string}>} writes
 * @param {string} [action] 出错时显示的动作名
 * @returns {{backups: string[], done: Array<{file: string, backup: string|null}>}}
 */
export function writeFiles(writes, action = '写盘') {
  const backups = [];
  const done = [];
  const stamp = Date.now();
  try {
    for (const [i, w] of writes.entries()) {
      const existed = fs.existsSync(w.file);
      // 同一毫秒写多个文件时时间戳会撞，加序号保证备份名唯一
      const backup = existed ? `${w.file}.bak-${stamp}-${i}` : null;
      if (backup) {
        fs.copyFileSync(w.file, backup);
        backups.push(path.basename(backup));
      }
      fs.mkdirSync(path.dirname(w.file), { recursive: true });
      fs.writeFileSync(w.file, w.content, 'utf8');
      done.push({ file: w.file, backup });
    }
  } catch (e) {
    restoreFiles(done);
    throw new McError(`${action}失败：${e && e.message ? e.message : String(e)}`, '已回滚，原文件没变', 'WriteFailed');
  }
  return { backups, done };
}

/** 把已经写过的文件还原（有备份覆盖回去，没备份就是新建的，直接删）。 */
export function restoreFiles(done) {
  for (const d of [...done].reverse()) {
    try {
      if (d.backup) fs.copyFileSync(d.backup, d.file);
      else if (fs.existsSync(d.file)) fs.unlinkSync(d.file);
    } catch {
      /* 回滚尽力而为，不在这里再抛错 */
    }
  }
}

/**
 * 试写一个临时文件，确认真能写盘。
 *
 * 为什么要单独做：在只读沙箱里写盘失败的表现和「游戏崩溃」几乎一样
 * （log4j 报 `Cannot access RandomAccessFile ... 拒绝访问` 然后秒退），
 * 不先探一下很容易把权限问题当成程序 bug 查半天。
 *
 * @param {string} dir
 * @returns {{ok: boolean, error: string}}
 */
export function checkWritable(dir) {
  const probe = path.join(dir, `.dsh-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: `${e && e.code ? e.code : 'ERROR'}: ${e && e.message ? e.message : String(e)}` };
  }
}
