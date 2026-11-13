/**
 * 启动痕迹与安全模式标记（纯 Node，不碰 electron，可直接单测）。
 *
 * ## 为什么单独拎出来（2026-11-02 第十次排查「快捷方式打不开」）
 *
 * `main.mjs` 一加载就 `require('electron')`，普通 Node 里没有这个内建模块，
 * 直接抛 —— 所以主进程那层没法写单测（`test/desktop.test.mjs` 顶部就写了这条）。
 * 于是凡是「值得测的判断」都从主进程里搬到这里，主进程只留接线。
 *
 * 这里管三个文件（都放在 exe 旁边的目录里，用户数据目录此刻还没选出来）：
 *
 * - `boot.pending` —— 「这次启动还没走到页面加载完成」的痕迹。
 *   下次启动发现它还在，就说明上次崩了 → 自动改走安全模式。
 * - `safe-mode.stamp` —— 这台机器普通模式崩过、安全模式成功过。
 * - 安全模式逃生门：`--no-safe-mode` 强制按普通模式起（见 main.mjs）。
 *
 * ## 关键约定：痕迹只由「真正要开窗口的那个进程」写
 *
 * 拿不到单实例锁的进程（用户又双击了一次）**不许**写痕迹 —— 否则它一声不响
 * 退出后留下的痕迹还在原地，用户下次双击会被误判成「上次崩过」，白白进安全模式。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 安全模式标记文件：存在 = 这台机器普通模式崩过、安全模式成功过。 */
export function safeModeStampPath(execDir) {
  return path.join(execDir, 'safe-mode.stamp');
}

/** 「这次启动还没走到加载完成」的痕迹文件。 */
export function bootPendingPath(execDir) {
  return path.join(execDir, 'boot.pending');
}

/**
 * 写下「这次启动开始了」。加载成功后会被删掉。
 *
 * @param {string} execDir exe 所在目录
 * @param {{safe?: boolean}} options safe=true 表示这次按安全模式起（写进内容里，方便事后看）
 * @returns {boolean} 写成功返回 true
 */
export function markBootStarted(execDir, options = {}) {
  const safe = options.safe === true;
  try {
    fs.writeFileSync(
      bootPendingPath(execDir),
      `${new Date().toISOString()} ${safe ? 'safe' : 'plain'}\r\n`,
      'utf8',
    );
    return true;
  } catch {
    // 写不了就算了（目录只读什么的），不能因此不让程序起来
    return false;
  }
}

/** 删掉痕迹：页面加载成功 = 这次启动是活的。 */
export function clearBootStarted(execDir) {
  try {
    fs.rmSync(bootPendingPath(execDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 读当前状态：上次有没有崩过、这台机器是不是只吃安全模式。 */
export function readBootState(execDir) {
  return {
    pending: fs.existsSync(bootPendingPath(execDir)),
    safeStamp: fs.existsSync(safeModeStampPath(execDir)),
  };
}

/** 记一笔「这台机器普通模式崩过、安全模式成功过」。 */
export function markSafeModeWorks(execDir, when = new Date()) {
  try {
    fs.writeFileSync(
      safeModeStampPath(execDir),
      `安全模式于 ${when.toISOString()} 成功加载过页面\r\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动策略：拿到锁的才是「主角」。
 *
 * ## 为什么不弹「已经在运行了」的框（2026-11-02 第十次排查）
 *
 * 原来第二个进程拿不到锁时会弹一个模态框，告诉用户「已经开着一个了」。
 * 但这一版的做法是：**让已有实例自己把窗口顶到前面**（见 main.mjs 的
 * second-instance 处理器）。这时再弹框，等于在用户眼前抢走焦点、
 * 把刚顶出来的窗口又压到后面 —— 比不弹更糟。
 *
 * 所以第二个进程安静退出就行。它唯一该做的是**别写启动痕迹**
 * （见本文件顶部说明）。
 *
 * @param {{selfCheck: boolean, gotLock: boolean}} input
 * @returns {{mode: 'self-check'|'secondary'|'primary', markTrace: boolean, notifyAlreadyRunning: boolean}}
 */
export function planStartup(input = {}) {
  const selfCheck = input.selfCheck === true;
  const gotLock = input.gotLock === true;
  if (selfCheck) {
    // 自检要抢在单实例锁前面跑（用户可能正开着软件），所以这里没有锁的概念
    return { mode: 'self-check', markTrace: false, notifyAlreadyRunning: false };
  }
  if (!gotLock) {
    return { mode: 'secondary', markTrace: false, notifyAlreadyRunning: false };
  }
  return { mode: 'primary', markTrace: true, notifyAlreadyRunning: false };
}
