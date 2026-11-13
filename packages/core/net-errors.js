/**
 * 网络层的「公共语言」：错误怎么认、怎么翻译成人话、URL 怎么取 host。
 *
 * 单独拆出来是为了避免循环引用：`mod-fetch.js`（发请求）和 `downloader.js`（下文件）
 * 都要用这几个函数，谁也不能 import 谁。
 */

import { McError } from './errors.js';

/** 判断一个错误是不是「网络层没通」。 */
export function isNetworkFailure(error) {
  if (!error) return false;
  if (error instanceof McError) return error.code === 'McNetwork' || error.code === 'McTimeout';
  const code = String(error.code ?? '');
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return true;
  }
  return error.name === 'TimeoutError' || error.name === 'AbortError';
}

/** 把底层错误翻译成一句人话 + 一句下一步怎么办。 */
export function describeNetworkFailure(error) {
  if (error instanceof McError) return error;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new McError(
      '联网超时了（等太久没有响应）',
      '可能是网络不稳、站点被墙，或者文件太大下到一半断了。可以重试一次；仍然不行就手动把 jar 放进 mods 目录，软件照样能读。',
      'McTimeout',
    );
  }
  return new McError(
    `联网失败：${error?.message ?? error}`,
    '现在这台机器可能连不上 Modrinth / CurseForge。可以改用镜像、或手动下载 jar 放进 mods 目录。',
    'McNetwork',
  );
}

/** 下载中途卡住（一段时间没有新字节）时的错误：和「一上来就连不上」不是一回事。 */
export function stalledDownload(url, idleMs) {
  return new McError(
    `下载卡住了：${Math.round(idleMs / 1000)} 秒没有新数据（${safeHost(url) || url}）`,
    '网速太慢或线路断了。可以重试；也可以换官方/镜像，或手动下载这个 jar。',
    'McTimeout',
  );
}

/** 取 URL 的 host（小写）；解析不了的返回空串。 */
export function safeHost(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return '';
  }
}

/** 判断一个错误是不是「本地写不进去」——这种重试和换地址都没用。 */
export function isLocalWriteFailure(error) {
  if (error instanceof McError) return error.code === 'McLocalWrite';
  return Boolean(error?.syscall) || ['ENOSPC', 'EACCES', 'EPERM', 'EBUSY', 'EROFS'].includes(String(error?.code ?? ''));
}

/** 把本地写失败包成能看懂的 McError。 */
export function asLocalWriteFailure(error) {
  if (error instanceof McError) return error;
  return new McError(
    `写入文件失败：${error?.message ?? error}`,
    '目标目录可能没有写权限，或被别的程序锁住了。',
    'McLocalWrite',
  );
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
