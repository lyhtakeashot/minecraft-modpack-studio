/**
 * 桌面版启动前的环境预检 + 启动日志。
 *
 * ## 为什么需要这个文件（2026-11-01 用户报「双击打不开」）
 *
 * 排查出来的第一个硬伤：**Electron 的用户数据目录写不进去时，它不报错，直接崩**
 * （实测 `%APPDATA%\整合包工作室` 建不出来 → 进程以 `0xC0000005` 访问冲突退掉，
 *  连一行输出都没有）。用户那边看到的自然就是「双击没反应，什么也没发生」。
 *
 * 第二个硬伤：**崩得太早，日志都没地方写**。所以这里的第一件事不是写日志，
 * 而是先找到一个真能写的目录 —— 找不到就退到临时目录，实在不行整个预检
 * 只保留内存里的记录，绝不因为「日志写不出去」把启动搞崩。
 *
 * 这个文件刻意**不 import electron**：纯 Node 逻辑，能单独测（见 test/desktop.test.mjs）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 日志文件名。放在选出来的可写目录里。 */
export const LOG_NAME = '启动日志.txt';

/**
 * 按优先级列出候选的用户数据目录。
 *
 * 1. `%APPDATA%\mcstudio` —— Electron 的常规位置。
 *    **刻意用纯英文名**，不用产品中文名：某些系统/安全软件对中文目录名处理有问题，
 *    而这里本来也没必要为了好看去冒风险（用户在资源管理器里几乎看不到它）。
 * 2. exe 同级的 `用户数据\` —— 绿色软件常见做法，U 盘拷走也能用
 * 3. 系统临时目录 —— 最后兜底，至少能启动
 */
export function userDataCandidates({ appData, appDir, tmpdir, name = 'mcstudio' } = {}) {
  const list = [];
  if (appData) list.push(path.join(appData, name));
  if (appDir) list.push(path.join(appDir, '用户数据'));
  if (tmpdir) list.push(path.join(tmpdir, `${name}-userdata`));
  return list;
}

/**
 * 从候选里挑第一个真能写的目录。
 *
 * 「能写」不是 `existsSync` 就算 —— 目录存在也可能只读（Program Files 就是）。
 * 所以真的建一个探针文件、写进去、再删掉。
 *
 * @returns {{dir: string, tried: Array<{dir: string, ok: boolean, reason: string}>}}
 *   `dir` 是空字符串表示一个都不行。
 */
export function pickWritableDir(candidates, { fsImpl = fs, pathImpl = path } = {}) {
  const tried = [];

  for (const dir of candidates ?? []) {
    if (!dir || typeof dir !== 'string') {
      tried.push({ dir: String(dir ?? ''), ok: false, reason: '路径是空的' });
      continue;
    }
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      const probe = pathImpl.join(dir, '.probe-能不能写');
      fsImpl.writeFileSync(probe, 'ok');
      fsImpl.unlinkSync(probe);
      tried.push({ dir, ok: true, reason: '' });
      return { dir, tried };
    } catch (error) {
      tried.push({ dir, ok: false, reason: error?.message ?? String(error) });
    }
  }

  return { dir: '', tried };
}

/** 把「试过哪些、为什么不行」写成人话。 */
export function describeTried(tried) {
  return (tried ?? [])
    .map((item) => `${item.dir}${item.ok ? '（能用）' : `（不行：${item.reason}）`}`)
    .join('；');
}

/**
 * 启动日志。
 *
 * 为什么不用 `console.log`：打包后的 exe 双击运行时**没有控制台**，
 * `console.log` 写进虚空，用户和我们两边的信息都归零。
 * 所以必须落文件，而且落在一个用户能自己找到的地方（软件目录或 %APPDATA%）。
 *
 * ## 为什么可能同时写两份（2026-11-01 第二次排查的教训）
 *
 * 用户说「启动日志没有新信息」—— 查下来不是没写，是**写到别处去了**：
 * 日志跟着选出的用户数据目录走，那台机器 `%APPDATA%` 能写、我的沙箱不能写，
 * 同一份代码在两边把日志落在完全不同的地方。用户盯着 exe 旁边那份，自然看不到新内容。
 *
 * 所以现在支持 `mirrorDir`：**除了正式位置，永远在 exe 旁边再留一份**。
 * 用户只要会双击，就找得到那一份。两份内容一模一样。
 */
export function createBootLog(dir, options = {}) {
  const {
    fsImpl = fs,
    pathImpl = path,
    name = LOG_NAME,
    now = () => new Date(),
    mirrorDir = '',
  } = options;

  const file = dir ? pathImpl.join(dir, name) : '';
  // 镜像：exe 旁边那份。和正式位置相同时不重复写。
  const mirror = mirrorDir && pathImpl.resolve(mirrorDir) !== pathImpl.resolve(dir || '/')
    ? pathImpl.join(mirrorDir, name)
    : '';
  const lines = [];
  let wrote = false;

  const writeOne = (target) => {
    if (!target) return false;
    try {
      fsImpl.mkdirSync(pathImpl.dirname(target), { recursive: true });
      fsImpl.writeFileSync(target, lines.join('\r\n') + '\r\n', 'utf8');
      return true;
    } catch {
      // 日志写不出去绝不能连累启动：静静地放进内存，最后退回控制台
      return false;
    }
  };

  const write = () => {
    if (!file && !mirror) return;
    const a = writeOne(file);
    const b = writeOne(mirror);
    wrote = a || b;
  };

  // 每记一行就立刻整份重写落盘。
  //
  // ## 为什么（2026-11-01 用户第四次报「还是没有打开成功」）
  //
  // 原来是攒在内存里等下一个时机才写文件 —— 结果进程在早期崩溃时（实测：
  // mojo 命名管道被环境禁掉，0x80000003 秒崩）**一行日志都没留下来**，
  // 排查时完全不知道用户那次双击跑到了哪一步。日志的意义就是崩溃后能看，
  // 所以宁可多写几次盘，也要保证每一行都真实落了地。
  const flush = write;

  return {
    file,
    /** exe 旁边那份的路径（没配就是空）。 */
    mirrorFile: mirror,
    /** 记一行（带时间戳）。 */
    step(message) {
      const t = now();
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      const line = `[${hh}:${mm}:${ss}] ${message}`;
      lines.push(line);
      // 打包后没有控制台，这行只在开发期（源码跑）有意义
      console.log(`[mcstudio] ${message}`);
      write();
      return line;
    },
    /** 出错时多记一段堆栈。 */
    error(message, error) {
      const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error ?? '');
      const head = message ? `${message}：` : '';
      lines.push(`         ${head}${detail.split('\n').join('\n         ')}`);
      write();
      return detail;
    },
    /** 全部内容（诊断时一次性看）。 */
    all() {
      return lines.join('\r\n');
    },
    /** 到底写没写进文件。 */
    get persisted() {
      return wrote;
    },
  };
}

/**
 * 一次性做完「选目录 + 开日志」，主进程只要调这一个。
 *
 * @param {{appData?: string, appDir?: string, tmpdir?: string, name?: string, fsImpl?: object}} options
 * @returns {{userDataDir: string, log: object, picked: {dir: string, tried: Array}}}
 */
export function prepareEnvironment(options = {}) {
  const {
    appData = process.env.APPDATA || '',
    appDir = '',
    tmpdir = os.tmpdir(),
    name = 'mcstudio',
    fsImpl = fs,
  } = options;

  const picked = pickWritableDir(userDataCandidates({ appData, appDir, tmpdir, name }), { fsImpl });
  // 镜像位置固定是 exe 旁边 —— 不管用户数据目录最后选到了哪儿，
  // 用户只要会双击 exe，就找得到这份日志。
  const log = createBootLog(picked.dir, { fsImpl, mirrorDir: appDir });

  log.step(`预检：用户数据目录 ${picked.dir ? `用 ${picked.dir}` : '一个都没建成（会退回 Electron 默认值，可能崩）'}`);
  if (picked.tried.length > 1 || !picked.dir) {
    log.step(`  依次试过：${describeTried(picked.tried)}`);
  }
  log.step(`系统：${os.type()} ${os.release()}（${process.arch}），Node ${process.versions.node}`);
  if (log.mirrorFile) log.step(`这份日志同时写在：${log.mirrorFile}`);

  return { userDataDir: picked.dir, log, picked };
}
