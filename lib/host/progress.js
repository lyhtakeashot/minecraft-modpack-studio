/**
 * 进度总线：给「一次要跑几分钟的长任务」开一个带编号的槽，界面隔一会儿来问一次。
 *
 * 为什么需要它：装 mod、从零装底座、打包都是「一个 HTTP 请求阻塞到底」。
 * 一个请求只能有一个响应，中途没办法把字节数塞回去。所以在这里用进程内的
 * 一张表当通道 —— 处理函数开始干活前建槽，干活时往槽里写，界面拿槽号轮询。
 *
 * 字段照着 PCL 的下载页来：
 *   done / total    已处理 / 一共要处理（单位看 unit：bytes 还是 files）
 *   finished / count 已完成的文件数 / 总文件数
 *   speed           最近 2 秒的滑动平均（字节/秒），和 PCL 的 DownloadSpeed 一个思路
 *   etaSeconds      按当前速度还要多久
 *   current         当前正在弄的那个文件
 *   note            一句人话，比如「下载游戏本体」「打离线包：3 / 12 个文件」
 */

/** 最多留这么多个槽，再多就把最老的已结束的挤掉。 */
const KEEP_JOBS = 20;
/** 速度用多长的窗口算。太短会抖，太长反应慢。 */
const WINDOW_MS = 2000;
/** 结束超过这么久的槽就清掉。 */
const STALE_MS = 10 * 60 * 1000;

const jobs = new Map();
let nextId = 1;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 清掉太老的槽，别让这张表无限长。正在跑的永远不删。 */
function prune(now) {
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - job.createdAt > STALE_MS) jobs.delete(id);
  }
  while (jobs.size > KEEP_JOBS) {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [id, job] of jobs) {
      if (job.status === 'running') continue;
      if (job.createdAt < oldestAt) {
        oldestAt = job.createdAt;
        oldestId = id;
      }
    }
    if (oldestId === null) break;
    jobs.delete(oldestId);
  }
}

function formatBytes(bytes) {
  const n = Math.max(0, Math.round(Number(bytes) || 0));
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function formatSpeed(bytesPerSecond) {
  const n = Math.max(0, Math.round(Number(bytesPerSecond) || 0));
  return n > 0 ? `${formatBytes(n)}/s` : '';
}

function formatEta(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 1) return '不到 1 秒';
  if (s < 60) return `还剩 ${Math.round(s)} 秒`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `还剩 ${minutes} 分 ${Math.round(s % 60)} 秒`;
  return `还剩 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 开一个槽。kind 是任务类型（mod-install / scaffold / export），name 给人看。 */
export function createJob(options = {}) {
  const now = Date.now();
  prune(now);
  const job = {
    id: `job${nextId++}`,
    kind: String(options.kind ?? 'task'),
    name: String(options.name ?? ''),
    unit: options.unit === 'files' ? 'files' : 'bytes',
    status: 'running',
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    finishedAt: 0,
    done: num(options.done),
    total: num(options.total),
    count: num(options.count),
    finished: num(options.finished),
    current: '',
    note: String(options.note ?? ''),
    error: '',
    indeterminate: Boolean(options.indeterminate),
    speed: 0,
    etaSeconds: null,
    samples: [{ at: now, value: num(options.done) }],
  };
  jobs.set(job.id, job);
  return job;
}

/** 按 id 或对象取槽。 */
export function getJob(idOrJob) {
  if (!idOrJob) return null;
  if (typeof idOrJob === 'object') return idOrJob;
  return jobs.get(String(idOrJob)) ?? null;
}

/**
 * 正在跑的那个（同 kind 里最新的一个）。
 *
 * 这里不比较 createdAt，直接一路走到底取最后一个：Map 天然是插入顺序，
 * 后开的一定在后面。用时间戳比较会在「同一毫秒开了两个槽」时选错（测试里就是这样）。
 */
export function activeJob(kind) {
  let best = null;
  for (const job of jobs.values()) {
    if (kind && job.kind !== kind) continue;
    if (job.status !== 'running') continue;
    best = job;
  }
  return best;
}

/** 最新的那个，不管是跑着还是跑完了。同样按插入顺序取最后一个。 */
export function latestJob(kind) {
  let best = null;
  for (const job of jobs.values()) {
    if (kind && job.kind !== kind) continue;
    best = job;
  }
  return best;
}

/** 算一下速度和剩余时间。只在「这一趟确实在涨」的时候才有意义。 */
function touchSpeed(job, now) {
  const samples = job.samples;
  const value = job.done;
  if (samples.length === 0 || samples[samples.length - 1].value !== value) {
    samples.push({ at: now, value });
  } else {
    samples[samples.length - 1].at = now;
  }
  while (samples.length > 2 && now - samples[0].at > WINDOW_MS) samples.shift();
  if (samples.length < 2) {
    job.speed = 0;
    job.etaSeconds = null;
    return;
  }
  const first = samples[0];
  const elapsedMs = now - first.at;
  const gained = value - first.value;
  if (elapsedMs <= 0 || gained <= 0) {
    job.speed = 0;
    job.etaSeconds = null;
    return;
  }
  job.speed = Math.round((gained * 1000) / elapsedMs);
  const remaining = job.total - job.done;
  job.etaSeconds = job.total > 0 && remaining > 0 ? Math.round(remaining / job.speed) : remaining <= 0 ? 0 : null;
}

/** 往槽里写一次。只认下面这些字段，别的忽略。 */
export function updateJob(idOrJob, patch = {}) {
  const job = getJob(idOrJob);
  if (!job) return null;
  if (patch.done !== undefined) job.done = num(patch.done);
  if (patch.total !== undefined) job.total = num(patch.total);
  if (patch.count !== undefined) job.count = num(patch.count);
  if (patch.finished !== undefined) job.finished = num(patch.finished);
  if (patch.unit !== undefined) job.unit = patch.unit === 'files' ? 'files' : 'bytes';
  if (patch.current !== undefined) job.current = String(patch.current ?? '');
  if (patch.note !== undefined) job.note = String(patch.note ?? '');
  if (patch.name !== undefined) job.name = String(patch.name ?? '');
  if (patch.error !== undefined) job.error = String(patch.error ?? '');
  if (patch.indeterminate !== undefined) job.indeterminate = Boolean(patch.indeterminate);
  if (patch.status !== undefined) job.status = String(patch.status);
  job.updatedAt = Date.now();
  touchSpeed(job, job.updatedAt);
  return job;
}

/** 正常收尾。done 默认拉满，否则界面会停在 99%。 */
export function finishJob(idOrJob, patch = {}) {
  const job = getJob(idOrJob);
  if (!job) return null;
  const next = { ...patch };
  if (next.status === undefined) next.status = 'done';
  if (next.total === undefined) next.total = job.total;
  if (next.done === undefined) next.done = job.total || job.done;
  if (next.indeterminate === undefined) next.indeterminate = false;
  const applied = updateJob(job, next);
  applied.finishedAt = Date.now();
  applied.speed = 0;
  applied.etaSeconds = 0;
  return applied;
}

/** 出错了。留一条错误信息在槽里，界面能直接显示。 */
export function failJob(idOrJob, error, patch = {}) {
  const job = getJob(idOrJob);
  if (!job) return null;
  job.status = 'failed';
  job.error = error instanceof Error ? error.message : String(error ?? '出错了');
  job.finishedAt = Date.now();
  job.speed = 0;
  job.etaSeconds = null;
  updateJob(job, { ...patch, status: 'failed', indeterminate: false });
  return job;
}

/** 转成能直接 JSON 出去的样子（去掉内部的采样点）。 */
export function snapshotOf(idOrJob) {
  const job = getJob(idOrJob);
  if (!job) return null;
  const pct = (part, whole) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 1000) / 10) : null);
  const elapsedMs = (job.finishedAt || Date.now()) - job.startedAt;
  const isBytes = job.unit === 'bytes';
  return {
    id: job.id,
    kind: job.kind,
    name: job.name,
    status: job.status,
    unit: job.unit,
    done: job.done,
    total: job.total,
    count: job.count,
    finished: job.finished,
    percent: pct(job.done, job.total),
    speed: job.speed,
    speedText: isBytes ? formatSpeed(job.speed) : '',
    etaSeconds: job.etaSeconds,
    etaText: isBytes ? formatEta(job.etaSeconds) : '',
    doneText: isBytes ? formatBytes(job.done) : String(job.finished),
    totalText: isBytes ? formatBytes(job.total) : String(job.count),
    current: job.current,
    note: job.note,
    error: job.error,
    indeterminate: job.indeterminate,
    elapsedMs,
    elapsedText: formatEta(elapsedMs / 1000).replace('还剩', '已用'),
    updatedAt: job.updatedAt,
  };
}

/** 清空所有槽。只在测试里用得到。 */
export function resetJobs() {
  jobs.clear();
  nextId = 1;
}

/**
 * 把 `applyInstallPlan` 的进度事件翻成「全局多少字节、几个文件」。
 *
 * core 给三类事件：file-start（开始下一个）、progress（单个文件下了多少）、
 * file-done（这个文件成了 / 跳过了 / 失败了）。这里按文件序号累加。
 * 跳过和失败的文件也按它的大小算进「已处理」—— 不然进度条永远差一截。
 */
export function modInstallReporter(idOrJob) {
  const bytes = new Map();
  const sizes = new Map();
  let count = 0;
  let finished = 0;

  const sum = (map) => {
    let total = 0;
    for (const value of map.values()) total += value;
    return total;
  };

  /** 把当前的累计值写进槽里。字节总量知道就用字节，不知道就退回文件数。 */
  const flush = (extra = {}) => {
    const totalBytes = sum(sizes);
    const useBytes = totalBytes > 0;
    updateJob(idOrJob, {
      unit: useBytes ? 'bytes' : 'files',
      total: useBytes ? totalBytes : count,
      done: useBytes ? sum(bytes) : finished,
      count,
      finished,
      ...extra,
    });
  };

  return (event) => {
    if (!event) return;
    const index = Number.isInteger(event.index) ? event.index : null;
    if (event.stage === 'file-start') {
      if (event.count) count = event.count;
      if (index !== null) {
        if (!bytes.has(index)) bytes.set(index, 0);
        if (event.size) sizes.set(index, Number(event.size) || 0);
      }
      flush({ current: event.title || event.fileName || '', indeterminate: false, note: '' });
      return;
    }
    if (event.stage === 'file-done') {
      finished += 1;
      if (index !== null) {
        const size = Number(event.bytes) || sizes.get(index) || 0;
        if (size) sizes.set(index, size);
        bytes.set(index, size);
      }
      flush({ current: event.title || event.fileName || '' });
      return;
    }
    if (event.stage === 'progress') {
      if (index !== null) {
        bytes.set(index, Number(event.received) || 0);
        if (event.total) sizes.set(index, Number(event.total) || 0);
      }
      flush({});
      return;
    }
    if (event.stage === 'download') {
      updateJob(idOrJob, { current: event.title || event.fileName || '' });
    }
  };
}

/** 装底座那几个阶段的中文名。 */
const SCAFFOLD_STEP_NAMES = {
  installer: '下载加载器安装器',
  gameJson: '写入游戏版本信息',
  vanilla: '下载游戏本体和资源',
  loader: '下载加载器依赖',
  java: '下载 Java 运行时',
  patch: '给客户端打加载器补丁',
};

/** 每个文件阶段算总量时该把哪几块字节加进去。 */
const SCAFFOLD_PHASE_BYTES = {
  vanilla: ['vanilla', 'assets'],
  loader: ['loader'],
  java: ['java'],
};

/**
 * 把 `applyScaffold` 的进度事件翻成全局进度。
 *
 * 阶段是串行跑的，所以「已经跑完的阶段」的字节数当一个基准垫着，
 * 当前阶段的字节往上加，这样总进度条是单调往上走的。
 */
export function scaffoldReporter(idOrJob, plan) {
  const bytesOf = plan?.bytes ?? {};
  const countsOf = plan?.counts ?? {};
  const totalBytes = Number(bytesOf.total) || 0;
  const totalFiles = Number(countsOf.totalFiles) || 0;
  const weightOf = (phase) => (SCAFFOLD_PHASE_BYTES[phase] ?? []).reduce((sum, key) => sum + (Number(bytesOf[key]) || 0), 0);
  let base = 0;

  return (event) => {
    if (!event) return;
    if (event.stage === 'step') {
      const name = SCAFFOLD_STEP_NAMES[event.key] ?? event.key;
      if (event.status === 'ok') {
        base += weightOf(event.key);
        updateJob(idOrJob, {
          note: `${name}（完成）`,
          current: event.detail || '',
          indeterminate: false,
          done: totalBytes > 0 ? base : num(0),
          total: totalBytes > 0 ? totalBytes : totalFiles,
          unit: totalBytes > 0 ? 'bytes' : 'files',
        });
        return;
      }
      updateJob(idOrJob, { note: name, current: event.detail || '', indeterminate: true });
      return;
    }
    if (event.stage === 'files') {
      const useBytes = totalBytes > 0;
      updateJob(idOrJob, {
        unit: useBytes ? 'bytes' : 'files',
        total: useBytes ? totalBytes : totalFiles,
        done: useBytes ? base + (Number(event.bytes) || 0) : Number(event.done) || 0,
        count: totalFiles,
        finished: Number(event.done) || 0,
        current: event.current || '',
        note: SCAFFOLD_STEP_NAMES[event.phase] ?? event.phase,
        indeterminate: false,
      });
    }
  };
}

/**
 * 把 `buildExport` 的进度事件翻成全局进度。
 *
 * 打包是本地读写，速度快、但条目可能上千，所以按「文件数」报。
 * launcher 形态要打两遍（内层离线包 + 外层外壳），内层用真实的条目数，
 * 外层只有 3 个条目 —— 两段各报各的，别互相覆盖。
 */
export function exportReporter(idOrJob) {
  let innerTotal = 0;
  return (event) => {
    if (!event) return;
    const phase = event.phase ?? 'main';
    const done = num(event.done);
    const total = num(event.total);
    if (phase === 'inner') {
      innerTotal = total || innerTotal;
      updateJob(idOrJob, {
        unit: 'files',
        done,
        total: innerTotal,
        count: innerTotal,
        finished: done,
        indeterminate: false,
        note: `打离线包：${done} / ${innerTotal} 个文件`,
      });
      return;
    }
    updateJob(idOrJob, {
      unit: 'files',
      done,
      total,
      count: total,
      finished: done,
      indeterminate: false,
      // 外层三个文件（modpack.zip / PCL.exe / dsh-export.json）各自有名字，得显示出来
      current: event.name ? String(event.name) : '',
      note: phase === 'outer' ? `装启动器外壳：${done} / ${total} 个文件` : `打包：${done} / ${total} 个文件`,
    });
  };
}
