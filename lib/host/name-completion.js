/**
 * 中文名补全：接口层（host）。
 *
 * ## 这一层管什么
 *
 * 用户 2026-11-05 提的：「为什么很多都没有中文名标记，这个项目该有一些基础的
 * 联网功能去查中文名吧」。整合包里有些 mod 只带 en_us.json（英文），有些物品连
 * 语言键都没有，界面只能显示 `createdeco:oak_crate` 这种 ID。
 *
 * 核心的「下载 + 解包」在 `packages/core/cfpa-names.js`（纯逻辑、可单测）；
 * 这一层只管三件事：
 *   1. 把补到的名字缓存到**软件自己的数据目录**（绝不碰用户的整合包）；
 *   2. 把名字套到物品索引上（已有中文名的不覆盖）；
 *   3. 给界面两条路由：preview 只读、不联网；apply 才真下载。
 *
 * ## 三条硬约束（用户拍板的）
 *
 * - **默认完全离线**：不点按钮绝不发请求。名字缓存落盘后，软件重启也会自动
 *   读回来套用（`cachedIndex` 每次调 `applyCompletion`），断网照常用；
 * - **整合包默认只读**：缓存文件写进 `MCSTUDIO_DATA_DIR`（桌面版主进程设好的
 *   软件数据目录），和 `remembered-roots.json` 同一处，不往实例目录里写一个字；
 * - **许可证**：CFPA 汉化包是 CC BY-NC-SA 4.0，**不打包进安装程序**，只运行时
 *   下载，界面必须标注来源与许可证。
 *
 * ## 为什么 apply 之后不用清缓存
 *
 * `lib/host/cache.js` 的 `cachedIndex()` 每次（含命中缓存）都会调 `applyCompletion()`。
 * 本模块用一个版本号给套用过的索引打标记，下载成功后版本号 +1，索引下次被拿到时
 * 会重新套一遍 —— 不必 `resetCaches()`，也不必让用户等 10 分钟 TTL 过期。
 * 本模块**不 import cache.js**，避免循环依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McError } from '../../packages/core/errors.js';
import {
  CFPA_LICENSE,
  CFPA_PROJECT,
  fetchCfpaZip,
  parseCfpaZip,
} from '../../packages/core/cfpa-names.js';
import { readParams } from './params.js';
import { createJob, failJob, finishJob, snapshotOf, updateJob } from './progress.js';

/** 和 lib/host/api.js 的 PLUGIN_ROOT 同算法：lib/host/ → 项目根。 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORE_FILE = 'cfpa-zh-names.json';

/** 每次都重算环境变量：测试里会换，桌面版主进程也可能晚设。 */
function storeFile() {
  const base = process.env.MCSTUDIO_DATA_DIR || path.join(PROJECT_ROOT, '.mcstudio');
  return path.join(base, STORE_FILE);
}

/**
 * 磁盘缓存的模块内镜像：`{ file, names: Map, meta }`。
 * 只在「文件路径变了」时重读 —— 正常情况下每个进程只读一次盘。
 */
let cache = null;
/** 每下载/清空一次 +1，让已缓存的索引知道该重套了。 */
let version = 0;
const APPLIED = Symbol('mcsCompletionVersion');

function loadStore() {
  const file = storeFile();
  if (cache && cache.file === file) return cache;
  const names = new Map();
  let meta = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw.names === 'object' && raw.names) {
      for (const [id, name] of Object.entries(raw.names)) {
        if (typeof id === 'string' && typeof name === 'string' && name.trim()) names.set(id, name);
      }
    }
    meta = {
      tag: String(raw?.tag ?? ''),
      publishedAt: String(raw?.publishedAt ?? ''),
      asset: String(raw?.asset ?? ''),
      fetchedAt: String(raw?.fetchedAt ?? ''),
    };
  } catch {
    // 没下载过 / 内容坏了：当空表，界面点一下按钮就能重建。
  }
  cache = { file, names, meta };
  return cache;
}

/**
 * 把补全表套到一份索引上。
 *
 * - **只补这个包里真有的物品**：遍历 `idx._items`（约 1 万个）去查表，而不是遍历
 *   整张 6.6 万条的汉化表往里塞 —— 后者会往 `_names` 里塞 5 万多个用不到的键；
 * - **已有中文名不覆盖**：mod 自带 `zh_cn.json` 的译名优先（一般更贴切）；纯英文名
 *   和完全没名字的都补上，正是用户要的「两类都尽量补」；
 * - **找不到就保持原样**：绝不拿 ID 硬编一个名字出来。
 *
 * @returns {number} 实际补了几个名字
 */
export function applyNamesToIndex(idx, map) {
  const items = idx?._items;
  const names = idx?._names;
  if (!(items instanceof Map) || !(names instanceof Map) || !map?.size) return 0;
  let changed = 0;
  for (const id of items.keys()) {
    const zh = map.get(id);
    if (typeof zh !== 'string' || !zh.trim()) continue;
    const old = names.get(id);
    // 已有中文名（自带 zh_cn.json）不动：只补「纯英文」和「完全没名字」两类。
    if (typeof old === 'string' && /[\u4e00-\u9fff]/.test(old)) continue;
    names.set(id, zh);
    changed += 1;
  }
  return changed;
}

/**
 * 给 `cachedIndex()` 用：每次拿索引都套一次。
 * 同一版本在同一份索引上只套一遍（打个 Symbol 标记），开销可忽略。
 */
export function applyCompletion(idx) {
  const store = loadStore();
  if (!idx || !store.names.size) return idx;
  if (idx[APPLIED] === version) return idx;
  applyNamesToIndex(idx, store.names);
  idx[APPLIED] = version;
  return idx;
}

/**
 * preview：**完全只读、绝不联网**。
 * 只报告「本地缓存里现在有没有、有多少、哪来的」，给界面显示状态用。
 */
export async function handleNamePreview(request) {
  await readParams(request);
  const store = loadStore();
  return {
    cached: store.names.size > 0,
    count: store.names.size,
    tag: store.meta.tag,
    publishedAt: store.meta.publishedAt,
    fetchedAt: store.meta.fetchedAt,
    license: CFPA_LICENSE,
    project: CFPA_PROJECT,
  };
}

/**
 * apply：界面上点了按钮才会走到这里 —— 真下载、真落盘。
 *
 * 下载走 `fetchCfpaZip()`（多来源自动降级），解开走 `parseCfpaZip()`。
 * 落盘失败不影响用户已有的东西，但会明确报错，不静默假装成功。
 *
 * **下载进度**：开一个 `name-fill` 进度槽（和装 mod、导出那一套共用），
 * 界面按 kind 轮询 `/progress` 就能看到「已下 1.2 MB / 共 3.5 MB」。
 * 代理不一定报 `content-length`，那就退成「不知道大小」的走动条。
 *
 * 测试注入：用 `setCfpaFetch()`（core 层导出的）换掉底层 fetch。
 */
export async function handleNameApply(request) {
  await readParams(request);
  const job = createJob({
    kind: 'name-fill',
    name: '下载中文名（CFPA 汉化包）',
    unit: 'bytes',
    done: 0,
    total: 0,
    indeterminate: true,
    note: '正在连接下载源…',
  });
  try {
    const fetched = await fetchCfpaZip({
      onProgress: ({ loaded, total, source }) => {
        updateJob(job, {
          done: loaded,
          total,
          unit: 'bytes',
          // 代理不给总大小的时候，就显示一条「不知道下到哪」的走动条
          indeterminate: !(total > 0),
          current: source,
          note: total > 0 ? '正在下载汉化包…' : '正在下载汉化包（这个下载源没报总大小）…',
        });
      },
    });
    const { names, files } = parseCfpaZip(fetched.buffer);
    if (!names.size) {
      throw new McError(
        '汉化包里没解析出可用的中文名',
        '可能整包格式变了，过几天再试；没下载成功前界面保持原样',
        'McBadData',
      );
    }

    const file = storeFile();
    const fetchedAt = new Date().toISOString();
    const onDisk = {
      tag: fetched.tag,
      publishedAt: fetched.publishedAt,
      asset: fetched.asset,
      source: fetched.source,
      license: CFPA_LICENSE,
      project: CFPA_PROJECT,
      fetchedAt,
      names: Object.fromEntries(names),
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(onDisk), 'utf8');
    } catch (error) {
      throw new McError(
        `中文名缓存写不进去：${error?.message ?? error}`,
        '检查软件数据目录是否可写；下载到的名字这次用得上，重启后需重新下载',
        'McWriteFail',
      );
    }

    cache = {
      file,
      names: new Map(names),
      meta: {
        tag: fetched.tag,
        publishedAt: fetched.publishedAt,
        asset: fetched.asset,
        fetchedAt,
      },
    };
    version += 1;
    finishJob(job, { note: `下载完成，正在整理中文名（${names.size} 条）…` });
    return {
      count: names.size,
      files,
      tag: fetched.tag,
      publishedAt: fetched.publishedAt,
      asset: fetched.asset,
      source: fetched.source,
      license: CFPA_LICENSE,
      project: CFPA_PROJECT,
      job: snapshotOf(job),
    };
  } catch (error) {
    failJob(job, error);
    throw error;
  }
}

/**
 * 清掉本地缓存（导出备用，暂不挂路由 —— 界面没这个按钮，少一条路由少一处文档同步）。
 * 清完版本号 +1，但已写进 `_names` 的名字要等索引重建才会退回原样；正常用法不需要它。
 */
export function handleNameClear() {
  const file = storeFile();
  try {
    fs.unlinkSync(file);
  } catch {
    /* 本来就没有，不用管 */
  }
  cache = { file, names: new Map(), meta: {} };
  version += 1;
  return { count: 0 };
}
