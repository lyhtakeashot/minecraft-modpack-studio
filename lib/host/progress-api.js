/**
 * 进度查询接口：`GET /progress?jobId=job3`，或者 `?kind=mod-install` 取最近一个。
 *
 * 为什么单开一条接口而不是让 apply 自己吐进度：一个 HTTP 请求只能有一个响应，
 * 装底座动辄几百 MB、好几分钟，中途没法把字节数塞回去。所以 apply 一进来就先
 * 建一个槽、把槽号放进响应，界面拿这个号隔 300 毫秒来问一次。
 *
 * 这个接口只读，绝不改任何东西。
 */
import { activeJob, getJob, latestJob, snapshotOf } from './progress.js';
import { readParams } from './params.js';

export async function handleProgress(request) {
  const params = await readParams(request);
  const jobId = params.jobId ?? params.id;
  const kind = params.kind ? String(params.kind) : '';

  let job = null;
  if (jobId) {
    job = getJob(String(jobId));
  } else {
    // 没给槽号：优先给「正在跑的那个」，没有再给最近一个 —— 界面刷新后还能接上
    job = activeJob(kind || undefined) ?? latestJob(kind || undefined);
  }

  if (!job) {
    return { ok: true, found: false, job: null };
  }
  return { ok: true, found: true, job: snapshotOf(job) };
}
