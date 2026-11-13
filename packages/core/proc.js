/**
 * 跑外部程序并把输出收回来。
 *
 * 为什么要单独写一个：DSH 的 Windows 沙箱**不放过管道**这种 IPC 面
 * （实测跑 `java -version` 用 `stdio: ['ignore','pipe','pipe']` 直接 EPERM），
 * 但**把 stdout/stderr 重定向到文件描述符是放行的**。
 *
 * 所以这里的统一做法是：开一个文件，把子进程的 stdout 和 stderr 都指到它上面，
 * 跑完再把文件读回来。副作用是输出顺序按写入顺序保存（比分开两个管道更贴近真实顺序），
 * 而且产物天然落成一份日志，出问题能直接给人看。
 *
 * 别改回 `execFile` / `stdio: 'pipe'` —— 在沙箱里那就是必挂。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** 临时输出文件的默认位置（显式给了 logFile 就用给的）。 */
function defaultLogFile() {
  return path.join(os.tmpdir(), `dsh-proc-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`);
}

/** 读一个文件的尾部（最多 maxBytes），文件不存在就当空。 */
export function readFileTail(file, maxBytes = 64 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return '';
    const want = Math.min(stat.size, Math.max(1024, Number(maxBytes) || 64 * 1024));
    const start = Math.max(0, stat.size - want);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(want);
      const read = fs.readSync(fd, buf, 0, want, start);
      return buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * 同步跑一个程序并拿回输出。
 *
 * @param {string} exe
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, maxBytes?: number, env?: object, logFile?: string}} [opts]
 * @returns {{ok: boolean, status: number|null, output: string, logFile: string, error?: Error}}
 */
export function captureCommandSync(exe, args, opts = {}) {
  const logFile = opts.logFile ? path.resolve(opts.logFile) : defaultLogFile();
  const maxBytes = Number(opts.maxBytes ?? 4 * 1024 * 1024);
  let fd = -1;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fd = fs.openSync(logFile, 'w');
  } catch (error) {
    return { ok: false, status: null, output: '', logFile: '', error };
  }
  try {
    const result = spawnSync(exe, args, {
      cwd: opts.cwd,
      timeout: Number(opts.timeoutMs ?? 60_000),
      windowsHide: true,
      env: opts.env ?? process.env,
      stdio: ['ignore', fd, fd],
    });
    const output = readFileTail(logFile, maxBytes);
    if (result.error) return { ok: false, status: null, output, logFile, error: result.error };
    return { ok: result.status === 0, status: result.status ?? null, output, logFile };
  } finally {
    try {
      if (fd >= 0) fs.closeSync(fd);
    } catch {
      /* 已经关了 */
    }
  }
}

/**
 * 异步跑一个程序并拿回输出（长任务用这个，能设超时、能取消）。
 *
 * 失败不抛异常：把 `ok: false` 和 `output` 交给上层决定怎么说人话。
 *
 * @param {string} exe
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, maxBytes?: number, env?: object, logFile?: string, signal?: AbortSignal}} [opts]
 * @returns {Promise<{ok: boolean, code: number|null, signal: string|null, output: string, logFile: string, timedOut: boolean, error?: Error}>}
 */
export function captureCommand(exe, args, opts = {}) {
  const logFile = opts.logFile ? path.resolve(opts.logFile) : defaultLogFile();
  const maxBytes = Number(opts.maxBytes ?? 4 * 1024 * 1024);
  const timeoutMs = Number(opts.timeoutMs ?? 120_000);

  return new Promise((resolve) => {
    let fd = -1;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fd = fs.openSync(logFile, 'w');
    } catch (error) {
      resolve({ ok: false, code: null, signal: null, output: '', logFile: '', timedOut: false, error });
      return;
    }

    let child;
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        windowsHide: true,
        env: opts.env ?? process.env,
        stdio: ['ignore', fd, fd],
      });
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      resolve({ ok: false, code: null, signal: null, output: '', logFile: '', timedOut: false, error });
      return;
    }
    // 子进程已经继承了自己的副本，父进程这份可以关掉
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }

    let timedOut = false;
    let settled = false;
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener?.('abort', onAbort);
      const output = readFileTail(logFile, maxBytes);
      resolve({
        ok: !error && code === 0,
        code: code ?? null,
        signal: signal ?? null,
        output,
        logFile,
        timedOut,
        ...(error ? { error } : {}),
      });
    };

    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* 已经退出 */
        }
      }, timeoutMs)
      : null;

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener?.('abort', onAbort, { once: true });
    }

    child.on('error', (error) => finish(null, null, error));
    child.on('exit', (code, signal) => finish(code, signal, null));
  });
}