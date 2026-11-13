/**
 * 桌面版启动预检的测试。
 *
 * 为什么这几条值得单独测：这套逻辑存在的唯一理由是「Electron 在用户数据目录
 * 写不进去时会静默崩掉」—— 也就是说，它一旦出错，用户看到的就是「双击没反应」，
 * 连报错都没有。这种东西不能靠人肉试。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  userDataCandidates,
  pickWritableDir,
  describeTried,
  createBootLog,
  prepareEnvironment,
  LOG_NAME,
} from '../packages/desktop/preflight.js';

/** 造一个临时目录，测完删掉。 */
function tempDir(tag = 'preflight') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcstudio-${tag}-`));
}

test('候选目录按「AppData → 软件目录 → 临时目录」排，名字是纯英文', () => {
  const list = userDataCandidates({
    appData: 'C:\\Users\\x\\AppData\\Roaming',
    appDir: 'D:\\soft',
    tmpdir: 'C:\\Temp',
  });
  assert.equal(list.length, 3);
  assert.ok(list[0].endsWith(path.join('AppData', 'Roaming', 'mcstudio')), list[0]);
  assert.ok(list[1].endsWith(path.join('soft', '用户数据')), list[1]);
  assert.ok(list[2].includes('mcstudio-userdata'), list[2]);
  // 名字里别有中文：某些安全软件/老系统对中文目录名处理有问题
  assert.ok(/mcstudio/.test(path.basename(list[0])));
  assert.equal(/[\u4e00-\u9fa5]/.test(path.basename(list[0])), false);
});

test('一个都不给时返回空数组（让调用方退回 Electron 默认值）', () => {
  assert.deepEqual(userDataCandidates({}), []);
});

test('挑第一个真能写的：写不进去的跳过，能写的留下', () => {
  const ok = tempDir('ok');
  const bad = path.join(tempDir('bad'), '不能写');
  const fakeFs = {
    mkdirSync(dir) {
      // 模拟「建不出来」：这就是实测里 %APPDATA% 的表现
      if (dir === bad) throw new Error('EPERM: operation not permitted, mkdir');
      fs.mkdirSync(dir, { recursive: true });
    },
    writeFileSync: (file, data) => fs.writeFileSync(file, data),
    unlinkSync: (file) => fs.unlinkSync(file),
  };

  const result = pickWritableDir([bad, ok], { fsImpl: fakeFs });
  assert.equal(result.dir, ok);
  assert.equal(result.tried.length, 2);
  assert.equal(result.tried[0].ok, false);
  assert.match(result.tried[0].reason, /EPERM/);
  assert.equal(result.tried[1].ok, true);
});

test('目录存在但只读也算不行（不能只靠 existsSync 判断）', () => {
  const dir = tempDir('readonly');
  const fakeFs = {
    mkdirSync: () => {}, // 目录已经有了，mkdir 不报错
    writeFileSync: () => {
      throw new Error('EACCES: permission denied');
    },
    unlinkSync: () => {},
  };
  const result = pickWritableDir([dir], { fsImpl: fakeFs });
  assert.equal(result.dir, '');
  assert.match(result.tried[0].reason, /EACCES/);
});

test('空路径和非法值直接跳过，不抛异常', () => {
  const ok = tempDir('last');
  const result = pickWritableDir([null, undefined, '', 42, ok]);
  assert.equal(result.dir, ok);
  assert.ok(result.tried.length >= 4);
  assert.ok(result.tried.slice(0, 3).every((item) => !item.ok));
});

test('全都不行时返回空字符串，并把原因都记下来', () => {
  const result = pickWritableDir(['a', 'b'], {
    fsImpl: {
      mkdirSync: () => {
        throw new Error('拒绝访问');
      },
    },
  });
  assert.equal(result.dir, '');
  assert.equal(result.tried.length, 2);
  assert.match(describeTried(result.tried), /拒绝访问/);
});

test('启动日志：写进文件、带时间戳、能读回来', () => {
  const dir = tempDir('log');
  const fixed = new Date(2026, 10, 1, 9, 5, 7);
  const log = createBootLog(dir, { now: () => fixed });

  log.step('第一步');
  log.step('第二步');

  assert.equal(log.file, path.join(dir, LOG_NAME));
  assert.equal(log.persisted, true);
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /\[09:05:07\] 第一步/);
  assert.match(text, /第二步/);
  // 中文必须原样存下去（这个项目被编码问题坑过一次）
  assert.ok(text.includes('第一步'));
});

test('日志：出错时把堆栈也写进去', () => {
  const dir = tempDir('logerr');
  const log = createBootLog(dir);
  log.step('准备崩');
  log.error('炸了', new Error('模拟错误'));

  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /炸了/);
  assert.match(text, /模拟错误/);
});

test('日志：目录写不进去也不能抛（崩在日志上最蠢）', () => {
  const log = createBootLog('C:\\根本不\\存在\\的\\目录', {
    fsImpl: {
      writeFileSync: () => {
        throw new Error('EPERM');
      },
    },
  });
  assert.doesNotThrow(() => log.step('这一步不该炸'));
  assert.equal(log.persisted, false);
  assert.match(log.all(), /这一步不该炸/);
});

test('日志：没给目录时不写文件，只留内存记录', () => {
  const log = createBootLog('');
  log.step('只有内存');
  assert.equal(log.file, '');
  assert.equal(log.persisted, false);
  assert.match(log.all(), /只有内存/);
});

test('prepareEnvironment：一路通到底，日志里能看出选了哪个目录', () => {
  const appData = tempDir('appdata');
  const appDir = tempDir('appdir');
  const { userDataDir, log } = prepareEnvironment({ appData, appDir, tmpdir: os.tmpdir() });

  assert.equal(userDataDir, path.join(appData, 'mcstudio'));
  assert.ok(fs.existsSync(userDataDir));
  assert.ok(fs.existsSync(log.file));

  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /预检：用户数据目录 用 /);
  assert.match(text, /系统：/);
});

test('prepareEnvironment：AppData 不行就退到软件目录（就是这次的实际情况）', () => {
  const appDir = tempDir('fallback');
  const noWrite = path.join(appDir, '不能写的AppData');
  const fakeFs = {
    mkdirSync(dir, opts) {
      // 只让「AppData 那条」失败 —— 注意别用 includes('AppData')，
      // 临时目录本身就长在 C:\Users\x\AppData\Local\Temp 下，会误伤
      if (dir.startsWith(noWrite)) throw new Error('EPERM: operation not permitted, mkdir');
      return fs.mkdirSync(dir, opts);
    },
    writeFileSync: (file, data, enc) => fs.writeFileSync(file, data, enc),
    unlinkSync: (file) => fs.unlinkSync(file),
  };
  const { userDataDir, log, picked } = prepareEnvironment({
    appData: noWrite,
    appDir,
    tmpdir: path.join(appDir, 'tmp'),
    fsImpl: fakeFs,
  });

  assert.equal(userDataDir, path.join(appDir, '用户数据'));
  assert.equal(picked.tried[0].ok, false);
  // 日志要把「为什么没用 AppData」记下来，否则下次还得重新查一遍
  assert.match(fs.readFileSync(log.file, 'utf8'), /依次试过.*EPERM/);
});

test('日志永远在 exe 旁边留一份（用户盯的就是那儿）', () => {
  // 2026-11-01 用户说「启动日志没有新信息」，查下来不是没写、是写到 %APPDATA% 去了。
  // 这条用例把「exe 旁边必须有一份」钉死，改回去就挂。
  const appData = tempDir('mirror-appdata');
  const appDir = tempDir('mirror-appdir');
  const { userDataDir, log } = prepareEnvironment({ appData, appDir, tmpdir: os.tmpdir() });

  // 用户数据目录选的是 AppData 那条（能写），日志正式位置也在那儿
  assert.equal(userDataDir, path.join(appData, 'mcstudio'));
  assert.equal(log.file, path.join(appData, 'mcstudio', LOG_NAME));

  // 但 exe 旁边同样有一份，内容一模一样
  assert.equal(log.mirrorFile, path.join(appDir, LOG_NAME));
  assert.ok(fs.existsSync(log.mirrorFile), 'exe 旁边必须能找到启动日志');
  assert.equal(fs.readFileSync(log.mirrorFile, 'utf8'), fs.readFileSync(log.file, 'utf8'));

  // 两份里都写明了「同时在哪儿」，用户看一眼就知道另一份在哪
  assert.match(fs.readFileSync(log.mirrorFile, 'utf8'), /这份日志同时写在：/);
});

test('用户数据目录就是 exe 目录时，不会把同一份日志写两遍', () => {
  const appDir = tempDir('same-dir');
  const log = createBootLog(appDir, { mirrorDir: appDir });
  assert.equal(log.file, path.join(appDir, LOG_NAME));
  assert.equal(log.mirrorFile, '');
  log.step('就一行');
  assert.equal(fs.readFileSync(log.file, 'utf8').match(/就一行/g).length, 1);
});
