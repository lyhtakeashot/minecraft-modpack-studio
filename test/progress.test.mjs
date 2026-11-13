/**
 * 进度总线（lib/host/progress.js + progress-api.js）的单测。
 *
 * 这块东西不难，但它错了会很难看：进度条卡在 99%、速度永远是 0、
 * 任务结束了界面还在转圈。所以下面按真实事件序列跑一遍，断言数字对得上。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeJob,
  createJob,
  exportReporter,
  failJob,
  finishJob,
  getJob,
  latestJob,
  modInstallReporter,
  resetJobs,
  scaffoldReporter,
  snapshotOf,
  updateJob,
} from '../lib/host/progress.js';
import { handleProgress } from '../lib/host/progress-api.js';

/** 造一个能喂给 readParams 的假请求（GET 带 query）。 */
function fakeGet(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return { url: `http://localhost/api/mcstudio/progress?${qs}`, method: 'GET', headers: new Headers(), json: async () => ({}) };
}

test('新建的槽：跑着、0%、没有速度', () => {
  resetJobs();
  const job = createJob({ kind: 'mod-install', name: '装 mod（3 个）', unit: 'bytes', total: 1000, count: 3 });
  const s = snapshotOf(job);
  assert.equal(s.id, 'job1');
  assert.equal(s.kind, 'mod-install');
  assert.equal(s.status, 'running');
  assert.equal(s.percent, 0);
  assert.equal(s.totalText, '1000 B');
  assert.equal(s.doneText, '0 B');
  assert.equal(s.speedText, '');
  assert.equal(s.indeterminate, false);
});

test('写进去多少就是多少，百分比按字节算', () => {
  resetJobs();
  const job = createJob({ kind: 'mod-install', total: 2000 });
  updateJob(job, { done: 500 });
  assert.equal(snapshotOf(job).percent, 25);
  updateJob(job, { done: 2000 });
  assert.equal(snapshotOf(job).percent, 100);
});

test('总量未知时 percent 是 null，界面据此画「来回跑」的条', () => {
  resetJobs();
  const job = createJob({ kind: 'export', unit: 'files', indeterminate: true });
  assert.equal(snapshotOf(job).percent, null);
  assert.equal(snapshotOf(job).indeterminate, true);
});

test('收尾时 done 自动拉满，否则界面会停在 99%', () => {
  resetJobs();
  const job = createJob({ kind: 'scaffold', total: 900, done: 850 });
  finishJob(job);
  const s = snapshotOf(job);
  assert.equal(s.status, 'done');
  assert.equal(s.done, 900);
  assert.equal(s.percent, 100);
  assert.equal(s.speed, 0);
});

test('出错：状态变 failed，错误原文留在槽里给界面看', () => {
  resetJobs();
  const job = createJob({ kind: 'scaffold', total: 900, done: 100 });
  failJob(job, new Error('连不上服务器'));
  const s = snapshotOf(job);
  assert.equal(s.status, 'failed');
  assert.equal(s.error, '连不上服务器');
  assert.equal(s.indeterminate, false);
});

test('activeJob 只认还在跑的；latestJob 跑完的也算', () => {
  resetJobs();
  const a = createJob({ kind: 'mod-install' });
  finishJob(a);
  const b = createJob({ kind: 'mod-install' });
  assert.equal(activeJob('mod-install').id, b.id);
  assert.equal(latestJob('mod-install').id, b.id);
  finishJob(b);
  assert.equal(activeJob('mod-install'), null, '都跑完了就不该再有「正在跑」');
  assert.equal(latestJob('mod-install').id, b.id);
  // 不同 kind 不会互相串
  assert.equal(latestJob('export'), null);
});

test('速度：涨上去才有，停下就清零', async () => {
  resetJobs();
  const job = createJob({ kind: 'mod-install', total: 100000 });
  updateJob(job, { done: 0 });
  await new Promise((r) => setTimeout(r, 60));
  updateJob(job, { done: 6000 });
  const s = snapshotOf(job);
  assert.ok(s.speed > 0, `应该有速度，实际 ${s.speed}`);
  assert.ok(s.speedText.endsWith('/s'));
  // 剩余时间按「还差多少 / 速度」估
  assert.ok(typeof s.etaSeconds === 'number' && s.etaSeconds > 0);
  assert.ok(s.etaText.includes('还剩'));
});

test('modInstallReporter：按文件序号累加，跳过和失败也算「已处理」', () => {
  resetJobs();
  const job = createJob({ kind: 'mod-install', unit: 'bytes', total: 300, count: 3 });
  const report = modInstallReporter(job);

  // 第 1 个：100 字节，下完了
  report({ stage: 'file-start', index: 0, count: 3, title: 'A', size: 100 });
  assert.equal(snapshotOf(job).current, 'A');
  assert.equal(snapshotOf(job).finished, 0);
  report({ stage: 'progress', index: 0, count: 3, received: 50, total: 100 });
  assert.equal(snapshotOf(job).done, 50);
  report({ stage: 'file-done', index: 0, count: 3, title: 'A', bytes: 100, kind: 'installed' });
  assert.equal(snapshotOf(job).done, 100);
  assert.equal(snapshotOf(job).finished, 1);

  // 第 2 个：跳过（已经装过了）
  report({ stage: 'file-done', index: 1, count: 3, title: 'B', bytes: 100, kind: 'skipped' });

  // 第 3 个：失败
  report({ stage: 'file-done', index: 2, count: 3, title: 'C', bytes: 100, kind: 'failed' });

  const s = snapshotOf(job);
  assert.equal(s.finished, 3, '三个都处理过了');
  assert.equal(s.done, 300);
  assert.equal(s.percent, 100);
});

test('modInstallReporter：一个文件都没有大小时退回按文件数报', () => {
  resetJobs();
  const job = createJob({ kind: 'mod-install', total: 0, count: 2 });
  const report = modInstallReporter(job);
  report({ stage: 'file-start', index: 0, count: 2, title: 'A', size: 0 });
  assert.equal(snapshotOf(job).unit, 'files');
  report({ stage: 'file-done', index: 0, count: 2, title: 'A', bytes: 0, kind: 'installed' });
  const s = snapshotOf(job);
  assert.equal(s.finished, 1);
  assert.equal(s.percent, 50);
});

test('scaffoldReporter：阶段名字讲人话，已完成阶段的字节当基准', () => {
  resetJobs();
  const plan = { bytes: { vanilla: 100, assets: 100, loader: 100, java: 0, total: 300 }, counts: { totalFiles: 30 } };
  const job = createJob({ kind: 'scaffold', unit: 'bytes', total: 300 });
  const report = scaffoldReporter(job, plan);

  report({ stage: 'step', key: 'installer', status: 'running' });
  assert.ok(snapshotOf(job).note.includes('加载器'), `note 应该是人话，实际 ${snapshotOf(job).note}`);
  assert.equal(snapshotOf(job).indeterminate, true, '只知道在做哪一步时不能装成有进度');

  report({ stage: 'step', key: 'installer', status: 'ok' });
  report({ stage: 'step', key: 'vanilla', status: 'running' });
  report({ stage: 'files', phase: 'vanilla', done: 5, total: 10, bytes: 50, current: 'assets/foo' });
  const mid = snapshotOf(job);
  assert.equal(mid.indeterminate, false);
  assert.equal(mid.current, 'assets/foo');
  assert.ok(mid.done >= 50);

  // 原版下完了，进 loader 阶段：已经拿到的 200 字节要当基准，不能从 0 重来
  report({ stage: 'step', key: 'vanilla', status: 'ok' });
  report({ stage: 'step', key: 'loader', status: 'running' });
  const afterVanilla = snapshotOf(job);
  assert.ok(afterVanilla.done >= 200, `进下一阶段时基准该保留，实际 ${afterVanilla.done}`);
  report({ stage: 'files', phase: 'loader', done: 3, total: 6, bytes: 30, current: 'libs/x.jar' });
  assert.ok(snapshotOf(job).done >= 230, 'loader 阶段的字节要加在基准上');
});

test('exportReporter：普通形态按文件数，launcher 形态内层外层不打架', () => {
  resetJobs();
  const job = createJob({ kind: 'export', unit: 'files', indeterminate: true });
  const report = exportReporter(job);

  report({ done: 40, total: 100, bytes: 0 });
  let s = snapshotOf(job);
  assert.equal(s.indeterminate, false, '一收到真实总量就不再是「不知道」');
  assert.equal(s.finished, 40);
  assert.equal(s.count, 100);
  assert.equal(s.percent, 40);

  // launcher：内层是离线包那一次（100 个文件），外层只有 3 个。
  // 两段各自从 0 数，不能把内层的 100 和外层的 3 加在一起。
  report({ done: 100, total: 100, bytes: 0, phase: 'inner' });
  report({ done: 1, total: 3, bytes: 0, phase: 'outer', name: 'modpack.zip' });
  s = snapshotOf(job);
  assert.equal(s.current, 'modpack.zip');
  assert.ok(s.count === 3 || s.count === 100, `总数应该属于某一段，实际 ${s.count}`);
});

test('/progress：给 jobId 就精确取，没给就取正在跑的那个', async () => {
  resetJobs();
  const job = createJob({ kind: 'scaffold', name: '装底座', total: 100, done: 10 });
  const byId = await handleProgress(fakeGet({ jobId: job.id }));
  assert.equal(byId.found, true);
  assert.equal(byId.job.id, job.id);
  assert.equal(byId.job.percent, 10);

  const byKind = await handleProgress(fakeGet({ kind: 'scaffold' }));
  assert.equal(byKind.found, true);
  assert.equal(byKind.job.kind, 'scaffold');
});

test('/progress：一个都没有时 found:false，不报错', async () => {
  resetJobs();
  const body = await handleProgress(fakeGet({}));
  assert.equal(body.ok, true);
  assert.equal(body.found, false);
  assert.equal(body.job, null);
  // 问一个不存在的 jobId 也一样，不能抛
  const missing = await handleProgress(fakeGet({ jobId: 'job999' }));
  assert.equal(missing.found, false);
});

test('/progress：只读 —— 问多少次都不改槽', async () => {
  resetJobs();
  const job = createJob({ kind: 'mod-install', total: 100, done: 30 });
  // elapsedMs 是算出来的（按当前时间减开始时间），本来就会自己走，
  // 所以比「槽里的东西」而不是整个快照字符串。
  const pick = (s) => {
    const { elapsedMs, ...rest } = s;
    return rest;
  };
  const before = JSON.stringify(pick(snapshotOf(job)));
  await handleProgress(fakeGet({ jobId: job.id }));
  await handleProgress(fakeGet({ jobId: job.id }));
  assert.equal(JSON.stringify(pick(snapshotOf(job))), before);
  assert.equal(job.updatedAt, JSON.parse(before).updatedAt, 'updatedAt 也不该被问话改掉');
});

test('槽不会无限堆积：老的自己会被清掉', () => {
  resetJobs();
  const ids = [];
  for (let i = 0; i < 40; i += 1) {
    const job = createJob({ kind: 'export', name: `第 ${i} 次` });
    finishJob(job);
    ids.push(job.id);
  }
  // KEEP_JOBS 是 20，最早的应该已经被扔了
  assert.equal(getJob(ids[0]), null, '太老的槽该被扔掉');
  assert.ok(getJob(ids[ids.length - 1]), '最近的一定在');
});
