/**
 * 窗口「顶到前面」的动作编排（纯 Node，不碰 electron，可直接单测）。
 *
 * ## 为什么要有（2026-11-02 第十次排查「快捷方式打不开」）
 *
 * 用户双击快捷方式时的真实场景不是「程序起不来」，而是：
 *
 * 1. 上一次那个实例**进程还在**，但窗口被最小化到屏幕外了
 *    （实测 `iconic=True`、窗口矩形 `-21333,-21333`）—— 用户完全看不见它；
 * 2. 用户再双击 → 第二个进程拿不到单实例锁。
 *
 * 原来第二个进程弹一个「已经在运行了」的框，然后退出。用户点掉框，屏幕还是空的。
 * 而真正能救场的是**已有那个实例**：它得把窗口拉回来。
 *
 * Electron 的 `second-instance` 事件只在**拿到锁的进程**里注册，拿不到锁的进程
 * 收不到它。所以本文件的职责是把「该做哪几个动作」算清楚，
 * 由 main.mjs 在两个分支里分别执行。
 *
 * ## 为什么要算成纯函数（而不是直接调窗口 API）
 *
 * 窗口 API 在本机没法验证（沙箱拦 mojo 命名管道，Chromium 系全起不来）。
 * 但「什么情况下该做什么动作」是可以确定的：把它写成纯函数，
 * 就能用单测锁住行为，不用真开窗口。
 */

/**
 * @typedef {object} WindowState
 * @property {boolean} destroyed 窗口对象是不是已经销毁
 * @property {boolean} visible 窗口是不是可见
 * @property {boolean} minimized 窗口是不是最小化了
 * @property {boolean} onScreen 窗口是不是还落在某块屏幕的可见范围内
 */

/**
 * 算出「把窗口顶到前面」要做哪些动作。
 *
 * @param {WindowState} state
 * @returns {{actions: string[], focus: boolean, reason: string}}
 */
export function planWindowReveal(state = {}) {
  const destroyed = state.destroyed === true;
  const visible = state.visible !== false;
  const minimized = state.minimized === true;
  const onScreen = state.onScreen !== false;

  if (destroyed) {
    return { actions: [], focus: false, reason: '窗口已经没了' };
  }

  const actions = [];
  let reason = '窗口本来就是好的';

  if (!visible) {
    actions.push('show');
    reason = '窗口藏起来了';
  }
  if (minimized) {
    actions.push('restore');
    if (reason === '窗口本来就是好的') reason = '窗口最小化了';
  }
  if (!onScreen) {
    // 最小化到屏幕外（rect = -21333,-21333）这一类，必须硬拉回主屏
    actions.push('center');
    reason = '窗口跑到屏幕外了';
  }
  if (actions.length > 0) {
    actions.push('focus');
  }

  return { actions, focus: actions.includes('focus'), reason };
}

/**
 * 窗口矩形是否还落在某块屏幕的可见范围内。
 *
 * 最小化/隐藏的窗口在 Windows 上会拿到 `-21333,-21333` 这种坐标 ——
 * 那是「被系统挪到虚拟桌面外」的经典值，肉眼看不见但进程活着。
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {Array<{workArea:{x:number,y:number,width:number,height:number}}>} displays
 * @returns {boolean}
 */
export function boundsOnScreen(bounds, displays = []) {
  if (!bounds || !Array.isArray(displays) || displays.length === 0) return true;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return true;
  return displays.some((d) => {
    const a = d?.workArea;
    if (!a) return false;
    return x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + height > a.y;
  });
}
