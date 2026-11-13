/**
 * Java 探测：找到能跑这个实例的 JVM，并读出它的主版本。
 *
 * 本机的真实情况（2026-10-28 实测）：PATH 里没有 java，也没有独立 JDK；
 * 唯一可用的 JVM 是官方启动器下载的
 * `%APPDATA%\.minecraft\runtime\java-runtime-delta\bin\java.exe`（OpenJDK 21.0.7）。
 * 所以探测顺序必须包含 `.minecraft/runtime/*`，否则在这台机器上会一个都找不到。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { captureCommandSync } from './proc.js';

/** Windows 上是 java.exe，其它平台是 bin/java。 */
function javaBin(dir) {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  return path.join(dir, 'bin', exe);
}

/**
 * 读 `<runtime>/release` 里的 JAVA_VERSION，避免为了探测版本去开进程。
 * @returns {string} 例如 "21.0.7"
 */
function readRelease(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'release'), 'utf8');
    const m = /^JAVA_VERSION="?([^"\r\n]+)"?/m.exec(raw);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** "21.0.7" / "1.8.0_402" → 主版本号（8 / 21）。 */
export function majorOf(versionText) {
  const v = String(versionText ?? '').trim();
  const m = /(\d+)(?:\.(\d+))?/.exec(v);
  if (!m) return 0;
  const first = Number(m[1]);
  if (first === 1) return Number(m[2] ?? 0); // 1.8.0_402 → 8
  return first;
}

/**
 * 用 `java -version` 实测一个可执行文件的主版本（release 文件缺失时的兜底）。
 *
 * 走 `captureCommandSync` 而不是 spawnSync 的管道：沙箱里管道会 EPERM，
 * 那样这里会静默返回 0，表现为「明明有 Java 却说找不到」。
 *
 * @returns {number} 0 表示读不出来
 */
function probeMajor(bin) {
  try {
    const r = captureCommandSync(bin, ['-version'], { timeoutMs: 15000, maxBytes: 8192 });
    const m = /version "([^"]+)"/.exec(r.output ?? '');
    return m ? majorOf(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** 列一个目录下的子目录（不存在就返回空数组）。 */
function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * 收集候选 JVM，按可信度排序。
 *
 * @param {object} opts
 * @param {string} [opts.mcRoot] Minecraft 根目录（含 runtime/ 的那种）
 * @param {string} [opts.instanceDir] 实例目录（versions/<名>）
 * @param {number} [opts.requiredMajor] 版本 json 里声明的 javaVersion.majorVersion
 * @param {string[]} [opts.extra] 额外显式路径（config 里配的 javaPath 等）
 * @returns {{path: string, version: string, major: number, source: string, matches: boolean}[]}
 */
export function collectJavaCandidates(opts = {}) {
  const { mcRoot, instanceDir, requiredMajor = 0, extra = [] } = opts;
  const out = [];
  const seen = new Set();
  const push = (bin, source, versionHint = '') => {
    if (!bin) return;
    const key = path.resolve(bin).toLowerCase();
    if (seen.has(key)) return;
    if (!fs.existsSync(bin)) return;
    seen.add(key);
    const version = versionHint || readRelease(path.dirname(path.dirname(bin)));
    const major = majorOf(version) || probeMajor(bin);
    out.push({
      path: bin,
      version: version || (major ? `${major}.?` : '未知'),
      major,
      source,
      matches: requiredMajor ? major === requiredMajor : true,
    });
  };

  // 0) 用户显式指定
  for (const p of extra) {
    push(/[\\/](java|javaw)(\.exe)?$/i.test(p) ? p : javaBin(path.dirname(p)), 'config');
  }

  // 1) JAVA_HOME
  if (process.env.JAVA_HOME) push(javaBin(process.env.JAVA_HOME), 'JAVA_HOME');

  // 2) 官方启动器 / PCL 的 runtime 目录（本机唯一可用来源）
  const runtimeRoots = [];
  if (mcRoot) runtimeRoots.push(path.join(mcRoot, 'runtime'));
  runtimeRoots.push(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft', 'runtime'));
  if (instanceDir) runtimeRoots.push(path.join(instanceDir, 'runtime'));
  for (const root of runtimeRoots) {
    for (const dir of subdirs(root)) {
      push(javaBin(dir), `runtime:${path.basename(dir)}`, readRelease(dir));
    }
  }

  // 3) 实例自带的 jre / java 目录（有些整合包会内嵌）
  if (instanceDir) {
    for (const name of ['jre', 'jdk', 'java']) push(javaBin(path.join(instanceDir, name)), `instance:${name}`);
  }

  // 4) PATH
  const which = captureCommandSync(process.platform === 'win32' ? 'where' : 'which', ['java'], {
    timeoutMs: 10000,
    maxBytes: 8192,
  });
  if (which.ok) {
    for (const line of String(which.output || '').split(/\r?\n/)) {
      if (line.trim()) push(line.trim(), 'PATH');
    }
  }

  // 匹配目标版本的排前面
  out.sort((a, b) => Number(b.matches) - Number(a.matches) || b.major - a.major);
  return out;
}

/**
 * 挑一个 Java。找不到匹配版本时，若 requiredMajor 命中不了就退到主版本最大的那个，
 * 并把「版本不匹配」作为 warning 交给上层（启动可能失败，但别假装没找到）。
 */
export function pickJava(candidates, requiredMajor = 0) {
  if (candidates.length === 0) return null;
  const exact = candidates.find((c) => c.matches && (requiredMajor === 0 || c.major === requiredMajor));
  if (exact) return { ...exact, warning: '' };
  const best = candidates[0];
  const warning = requiredMajor
    ? `没有找到 Java ${requiredMajor}，退用 Java ${best.major}（${best.path}）；Forge/NeoForge 对主版本敏感，很可能启动失败`
    : '';
  return { ...best, warning };
}
