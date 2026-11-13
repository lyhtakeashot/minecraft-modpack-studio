/**
 * 跑外部程序那一层（`lib/core/proc.js`）。
 *
 * 这里的重点不是「能不能跑」，而是「沙箱里能不能把输出收回来」：
 * 管道（stdio:.pipe.）在这台机器的 DSH 沙箱里是 EPERM 的，所以 proc.js 一律
 * 用文件描述符重定向。这些用例就是守住这条底线——谁把它改回 execFile，
 * 这里会挂。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { captureCommand, captureCommandSync, readFileTail } from '../packages/core/proc.js';

const node = process.execPath;

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proc-test-'));
  return path.join(dir, name);
}

test('同步跑程序：能拿回 stdout', () => {
  const logFile = tmpFile('out.log');
  const r = captureCommandSync(node, ['-e', 'console.log("你好 proc")'], { logFile, timeoutMs: 30000 });
  assert.equal(r.ok, true, `没跑起来：${r.error?.message ?? ''}`);
  assert.equal(r.status, 0);
  assert.match(r.output, /你好 proc/);
  assert.ok(fs.existsSync(logFile), '输出文件应该留着当日志');
});

test('同步跑程序：非零退出要如实报', () => {
  const logFile = tmpFile('bad.log');
  const r = captureCommandSync(node, ['-e', 'console.error("炸了"); process.exit(3)'], { logFile, timeoutMs: 30000 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 3);
  // stderr 也被重定向到同一个文件，所以能在 output 里看到
  assert.match(r.output, /炸了/);
});

test('同步跑程序：程序不存在不要抛异常', () => {
  const r = captureCommandSync(path.join(os.tmpdir(), '绝对不存在的程序-xyz.exe'), [], { timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.ok(r.error || r.status === null);
});

test('异步跑程序：能拿回输出', async () => {
  const logFile = tmpFile('async.log');
  const r = await captureCommand(node, ['-e', 'console.log("异步也行")'], { logFile, timeoutMs: 30000 });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.match(r.output, /异步也行/);
});

test('异步跑程序：超时要强杀并标记', async () => {
  const logFile = tmpFile('hang.log');
  const t0 = Date.now();
  const r = await captureCommand(node, ['-e', 'setTimeout(() => {}, 30000)'], { logFile, timeoutMs: 800 });
  const cost = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.ok(cost < 15000, `应该很快被杀掉，实际 ${cost}ms`);
});

test('输出超过上限时只留尾部', async () => {
  const logFile = tmpFile('big.log');
  const code = 'for (let i = 0; i < 4000; i += 1) console.log("行" + i);';
  const r = await captureCommand(node, ['-e', code], { logFile, timeoutMs: 30000, maxBytes: 1024 });
  assert.equal(r.ok, true);
  assert.ok(r.output.length <= 1024, `output 应该被截断，实际 ${r.output.length}`);
  // 尾巴里必须有最后一行
  assert.match(r.output, /行3999/);
});

test('readFileTail：文件不存在给空串', () => {
  assert.equal(readFileTail(path.join(os.tmpdir(), '绝对不存在-tail.log'), 100), '');
  assert.equal(readFileTail(os.tmpdir(), 100), ''); // 目录也当读不出来
});