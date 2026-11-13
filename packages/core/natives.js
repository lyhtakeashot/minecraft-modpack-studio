/**
 * 把 natives jar 解压到实例目录，供 JVM 的 java.library.path 找到。
 *
 * 为什么必须有这一步：
 *   版本 json 里 `natives-windows` 那些条目是**独立的 jar**（lwjgl.dll / glfw.dll
 *   就在里面），它们不进 classpath。官方启动器会把它们解压到
 *   `versions/<id>/<id>-natives/`，再用 `-Djava.library.path=` 指过去。
 *   少了这一步，NeoForge 刚开始画窗口就炸：
 *   `java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll`
 *   —— 进程秒退，看起来像崩溃，其实一个库文件都没解出来。
 *
 * 两条约束（都是从官方启动器行为里抄的）：
 *   - 跳过 `META-INF/`：里面的签名/清单不是库文件。
 *   - **拍平到同一层**：java.library.path 不递归子目录，jar 里哪怕写成
 *     `windows/x64/lwjgl.dll` 也必须落在 natives 目录根部。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from './zip.js';

/** 解压时跳过的目录前缀。 */
const SKIP_PREFIXES = ['META-INF/'];

/**
 * 解压 natives。
 *
 * @param {string[]} jarPaths natives jar 的绝对路径（来自启动计划的 p.natives）
 * @param {string} nativesDir 目标目录（会被先清空）
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] true 时只算不写
 * @returns {{dir: string, jars: number, missingJars: number, files: string[], bytes: number, skipped: string[], dryRun: boolean}}
 */
export function extractNatives(jarPaths, nativesDir, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const all = (jarPaths ?? []).filter(Boolean);
  const jars = all.filter((p) => fs.existsSync(p));
  const skipped = [];
  const locked = [];
  let note = '';

  if (!dryRun) {
    // 清空旧目录是为了防止上一个版本残留的 dll 被误加载。
    // 但这一步**不能硬失败**：有 dll 正被别的进程映射着时（前一次游戏没退干净、
    // 或者杀毒软件正在扫），Windows 会直接给 EPERM / EBUSY，整个启动就废了。
    // 那种情况下面的逐文件写入会跳过被占用的，剩下的照常更新 —— 能启动就别拦。
    try {
      fs.rmSync(nativesDir, { recursive: true, force: true });
    } catch (e) {
      note = `旧 dll 清不掉（${e.code ?? 'ERROR'}），会就地覆盖能覆盖的`;
    }
    fs.mkdirSync(nativesDir, { recursive: true });
  }

  const written = new Map();
  let bytes = 0;

  for (const jar of jars) {
    const zip = openZip(fs.readFileSync(jar));
    for (const name of zip.names) {
      if (name.endsWith('/')) continue;
      if (SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;
      const base = path.posix.basename(name);
      // 防目录穿越：zip 里真出现过 `..` 这种名字的恶意样本
      if (!base || base === '.' || base === '..') {
        skipped.push(name);
        continue;
      }
      const buf = zip.read(name);
      if (!buf) continue;
      if (!dryRun) {
        try {
          fs.writeFileSync(path.join(nativesDir, base), buf);
        } catch (e) {
          // 被占用就留着旧的那份（同版本的 dll 内容一致，不影响启动）
          if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') {
            locked.push(base);
            continue;
          }
          throw e;
        }
      }
      written.set(base, buf.length);
      bytes += buf.length;
    }
  }

  return {
    dir: nativesDir,
    jars: jars.length,
    missingJars: all.length - jars.length,
    files: [...written.keys()].sort(),
    bytes,
    skipped,
    locked,
    note,
    dryRun,
  };
}

/** 人读的一行摘要。 */
export function describeNatives(result) {
  if (result.jars === 0) return 'natives：没有可解压的 jar（版本 json 里没有 natives 条目）';
  let head = `natives：解压 ${result.jars} 个 jar → ${result.files.length} 个文件（${(result.bytes / 1048576).toFixed(1)} MB）`;
  if (result.missingJars > 0) head += `，缺 ${result.missingJars} 个 jar`;
  if (result.locked && result.locked.length) head += `，${result.locked.length} 个被占用（沿用旧文件）`;
  return head;
}