/**
 * 任务「完成条件」和「奖励」的类型目录。
 *
 * 为什么要单独一个文件：FTB Quests 的条件/奖励有十几种类型，每种的字段名都不一样
 * （kill 写 entity/value、xp 写 value、choice 写 table_id……），连数字类型都不一样
 * （物品条件的 count 是 long，物品奖励的 count 是 int）。
 * 这些名字是照着 FTB-Quests 源码的 writeData 抄的（97f4f399 / 2101.1.9 / MC 1.21.1），
 * 抄错一个字母游戏就认不出来 —— 所以只在这里存一份，核心层、宿主层、界面、MCP 都从这里取，
 * 谁也不许自己抄一份。
 *
 * 三种表示，别搞混：
 * - 友好 spec：{ type: 'kill', entity: 'minecraft:zombie', count: 5 } —— 界面和 MCP 用的
 * - FTB 条目：{ id, type: 'kill', entity: 'minecraft:zombie', value: 5 } —— 文件里存的
 * - 人话：'杀 5 只 minecraft:zombie' —— 预览和「写完再读一遍」复验用的
 *
 * 一个关键坑：**「要几个」写在顶层 `count`，不是物品里的 `count`**。
 * FTB 的 ItemTask.readData 只读顶层 count，物品里的 count 是那一摞物品自己的堆叠数。
 * 所以这里写物品时是 `item: { id, count: 1 }` + 顶层 `count: N`。
 */

import { SnbtLong } from './snbt.js';
import { McError } from './errors.js';

/** 观察目标的样子（FTB 里 observe_type 是序号，不是名字）。 */
const OBSERVE_TYPES = [
  { value: 0, label: '方块' },
  { value: 1, label: '方块标签' },
  { value: 2, label: '方块状态' },
  { value: 3, label: '方块实体' },
  { value: 4, label: '方块实体类型' },
  { value: 5, label: '实体类型' },
  { value: 6, label: '实体类型标签' },
];

/**
 * 战利品表那几种奖励：字段完全一样，只有 type 不同。
 *
 * ⚠️ 这里**只有三种**，别再加第四种。2026-11-12 查 FTB-Quests-2001.4.9 源码
 * （`quest/reward/RewardTypes.java` 的注册表）确认：战利品表相关的奖励只有
 * `choice` / `random` / `loot` 三个。曾经这里还有个 `all_table`（「整表全给」），
 * 那是我们自己编的类型名 —— 源码全树 grep `all_table` **0 命中**、两个真实整合包里
 * 也是 **0 命中**。写成 `all_table` 游戏不认识，会退化成 `CustomReward`，
 * 结果是**奖励什么都不给，还不报错**。
 */
const TABLE_REWARD_TYPES = [
  { type: 'choice', label: '战利品表（自选一件）', describe: (id) => `从战利品表 ${id} 里自选一件` },
  { type: 'random', label: '战利品表（按权重随机）', describe: (id) => `按战利品表 ${id} 的权重随机给` },
  { type: 'loot', label: '战利品表（抽取，可能抽空）', describe: (id) => `按战利品表 ${id} 抽取（会算空奖励权重）` },
];

/** 十六进制表 ID（FTB 的 reward_tables/xxx.snbt 里那个 id）→ 十进制 long。 */
function tableIdToLong(hex) {
  const text = String(hex ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,16}$/.test(text)) return null;
  return BigInt(`0x${text}`).toString(10);
}

/** 十进制 long → 十六进制表 ID（给界面看，和文件名对得上）。 */
function tableIdToHex(value) {
  if (value === undefined || value === null || value === '') return '';
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return text;
  try {
    return BigInt(text).toString(16).toUpperCase();
  } catch {
    return text;
  }
}

/** 数字字段归一：不是数就当没填。 */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 数量字段归一：至少 1（FTB 也是 Math.max(count,1)）。 */
function countOf(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

/** 文本字段归一。 */
function str(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * 从 FTB 的 `item` 字段里取出物品 ID（2026-11-12 第五批）。
 *
 * ★ `item` 有**两种形态**，源码 `NBTUtils.java:19-44` 实证：
 *   - String：`item: "minecraft:iron_ingot"`
 *   - Compound：`item: { id: "minecraft:iron_ingot", count: 1 }`
 * 以前我们三处都写的是 `entry?.item?.id` —— 遇到**字符串形态**时
 * `.id` 是 undefined，物品 ID 会变**空字符串**（界面显示成「（没填物品）」，
 * 写回去还会把用户原来填的东西弄丢）。
 *
 * 真包实测：ATM10Sky 的 6440 处全是复合形态、0 处字符串，**所以一直没爆**；
 * 但换个包（或者别的作者手写）就会中招 —— 修它只要一行。
 */
function itemIdOf(item) {
  if (typeof item === 'string') return str(item);
  return str(item?.id);
}

/** 物品堆自己的 count（字符串形态时没有，按 1 算）。 */
function itemCountOf(item) {
  return typeof item === 'object' && item !== null ? item.count : undefined;
}

// ————————————————————————— 条件类型 —————————————————————————

/**
 * 每种条件类型的定义。
 *
 * fields 里每一项是界面上要填的一个框：
 *   kind: 'item' 物品 ID（能从右边的物品网格里点）、'text' 文本、'number' 数字、'bool' 开关、'enum' 下拉
 *   key : 友好 spec 里的键名
 * build() 把友好 spec 变成 FTB 条目；extract() 反过来。
 */
const TASK_DEFS = [
  {
    type: 'item',
    label: '交物品',
    fields: [
      { key: 'item', label: '物品 ID', kind: 'item', placeholder: 'minecraft:iron_ingot' },
      { key: 'count', label: '要几个', kind: 'number', def: 1, min: 1 },
    ],
    build(spec) {
      const out = { type: 'item', item: { id: str(spec.item), count: 1 } };
      const n = countOf(spec.count);
      // 顶层 count 是 long（FTB 的 ItemTask.readData 用 getLong 读）—— 不带 L 游戏读不到
      if (n > 1) out.count = new SnbtLong(String(n));
      return out;
    },
    extract(entry) {
      return {
        type: 'item',
        item: itemIdOf(entry?.item),
        count: countOf(entry?.count ?? entry?.item?.count),
      };
    },
    describe(spec) {
      return `交 ${countOf(spec.count)} 个 ${str(spec.item) || '（没填物品）'}`;
    },
  },
  {
    type: 'checkmark',
    label: '手动打勾（点了就过）',
    fields: [],
    build() {
      return { type: 'checkmark' };
    },
    extract() {
      return { type: 'checkmark' };
    },
    describe() {
      return '点了就过（手动打勾）';
    },
  },
  {
    type: 'kill',
    label: '击杀生物',
    fields: [
      { key: 'entity', label: '生物 ID', kind: 'text', placeholder: 'minecraft:zombie' },
      { key: 'count', label: '要几只', kind: 'number', def: 1, min: 1 },
    ],
    build(spec) {
      // value 是 long（FTB 的 KillTask.writeData 用 putLong），不带 L 游戏读不到
      return { type: 'kill', entity: str(spec.entity), value: new SnbtLong(String(countOf(spec.count))) };
    },
    extract(entry) {
      return { type: 'kill', entity: str(entry?.entity), count: countOf(entry?.value, 100) };
    },
    describe(spec) {
      return `杀 ${countOf(spec.count)} 只 ${str(spec.entity) || '（没填生物）'}`;
    },
  },
  {
    type: 'advancement',
    label: '完成进度',
    fields: [
      { key: 'advancement', label: '进度 ID', kind: 'text', placeholder: 'minecraft:story/root' },
      { key: 'criterion', label: '哪一条（可留空）', kind: 'text' },
    ],
    build(spec) {
      return { type: 'advancement', advancement: str(spec.advancement), criterion: str(spec.criterion) };
    },
    extract(entry) {
      return { type: 'advancement', advancement: str(entry?.advancement), criterion: str(entry?.criterion) };
    },
    describe(spec) {
      const adv = str(spec.advancement) || '（没填进度）';
      const crit = str(spec.criterion);
      return crit ? `完成进度 ${adv} 的「${crit}」` : `完成进度 ${adv}`;
    },
  },
  {
    type: 'dimension',
    label: '到达维度',
    fields: [{ key: 'dimension', label: '维度 ID', kind: 'text', placeholder: 'minecraft:the_nether' }],
    build(spec) {
      return { type: 'dimension', dimension: str(spec.dimension) };
    },
    extract(entry) {
      return { type: 'dimension', dimension: str(entry?.dimension) };
    },
    describe(spec) {
      return `到达维度 ${str(spec.dimension) || '（没填维度）'}`;
    },
  },
  {
    type: 'xp',
    label: '攒够经验',
    fields: [
      { key: 'count', label: '要多少经验', kind: 'number', def: 1, min: 1 },
      { key: 'points', label: '按经验点算（不按等级）', kind: 'bool', def: false },
    ],
    build(spec) {
      // value 是 long（FTB 的 XPTask.writeData 用 putLong），不带 L 游戏读不到
      return { type: 'xp', value: new SnbtLong(String(countOf(spec.count))), points: !!spec.points };
    },
    extract(entry) {
      return { type: 'xp', count: countOf(entry?.value), points: !!entry?.points };
    },
    describe(spec) {
      return spec.points ? `攒 ${countOf(spec.count)} 点经验` : `升到 ${countOf(spec.count)} 级`;
    },
  },
  {
    type: 'stat',
    label: '统计达到',
    fields: [
      { key: 'stat', label: '统计名', kind: 'text', placeholder: 'minecraft:custom:mobs_killed' },
      { key: 'count', label: '要达到多少', kind: 'number', def: 1, min: 0 },
    ],
    build(spec) {
      return { type: 'stat', stat: str(spec.stat), value: Math.max(0, Math.floor(num(spec.count, 1))) };
    },
    extract(entry) {
      return { type: 'stat', stat: str(entry?.stat), count: Math.max(0, Math.floor(num(entry?.value, 1))) };
    },
    describe(spec) {
      return `统计 ${str(spec.stat) || '（没填统计名）'} 达到 ${Math.max(0, Math.floor(num(spec.count, 1)))}`;
    },
  },
  {
    type: 'biome',
    label: '到达生物群系',
    fields: [{ key: 'biome', label: '群系 ID', kind: 'text', placeholder: 'minecraft:plains' }],
    build(spec) {
      return { type: 'biome', biome: str(spec.biome) };
    },
    extract(entry) {
      return { type: 'biome', biome: str(entry?.biome) };
    },
    describe(spec) {
      return `到达群系 ${str(spec.biome) || '（没填群系）'}`;
    },
  },
  {
    type: 'structure',
    label: '找到结构',
    fields: [{ key: 'structure', label: '结构 ID', kind: 'text', placeholder: 'minecraft:village_plains' }],
    build(spec) {
      return { type: 'structure', structure: str(spec.structure) };
    },
    extract(entry) {
      return { type: 'structure', structure: str(entry?.structure) };
    },
    describe(spec) {
      return `找到结构 ${str(spec.structure) || '（没填结构）'}`;
    },
  },
  {
    type: 'observation',
    label: '观察到',
    fields: [
      { key: 'toObserve', label: '要观察什么', kind: 'text', placeholder: 'minecraft:crafting_table' },
      { key: 'observeType', label: '观察哪种', kind: 'enum', def: 0, options: OBSERVE_TYPES },
      { key: 'timer', label: '要观察多久（秒）', kind: 'number', def: 0, min: 0 },
    ],
    build(spec) {
      return {
        type: 'observation',
        to_observe: str(spec.toObserve),
        observe_type: Math.max(0, Math.floor(num(spec.observeType, 0))),
        timer: new SnbtLong(String(Math.max(0, Math.floor(num(spec.timer, 0))))), // FTB 写 long
      };
    },
    extract(entry) {
      return {
        type: 'observation',
        toObserve: str(entry?.to_observe),
        observeType: Math.max(0, Math.floor(num(entry?.observe_type, 0))),
        timer: Math.max(0, Math.floor(num(entry?.timer, 0))),
      };
    },
    describe(spec) {
      const kind = OBSERVE_TYPES.find((o) => o.value === Math.floor(num(spec.observeType, 0)))?.label ?? '东西';
      const timer = Math.max(0, Math.floor(num(spec.timer, 0)));
      const what = str(spec.toObserve) || '（没填东西）';
      return timer > 0 ? `观察 ${what}（${kind}，${timer} 秒）` : `观察 ${what}（${kind}）`;
    },
  },
  {
    type: 'gamestage',
    label: '游戏阶段',
    fields: [{ key: 'stage', label: '阶段 ID', kind: 'text', placeholder: 'examplemod:stage_1' }],
    build(spec) {
      return { type: 'gamestage', stage: str(spec.stage) };
    },
    extract(entry) {
      return { type: 'gamestage', stage: str(entry?.stage) };
    },
    describe(spec) {
      return `进入阶段 ${str(spec.stage) || '（没填阶段）'}`;
    },
  },
  {
    type: 'fluid',
    label: '收集流体',
    fields: [
      { key: 'fluid', label: '流体 ID', kind: 'text', placeholder: 'minecraft:water' },
      { key: 'amount', label: '要多少毫桶（mB）', kind: 'number', def: 1000, min: 1 },
    ],
    // 源码 FluidTask.java:81-89：`putString("fluid", …)` + `putLong("amount", …)`，
    // NBT 存在 `nbt` 键里（**不是 `fluid_nbt`** —— 这点 §3.1.7 专门警告过）。
    build(spec) {
      return {
        type: 'fluid',
        fluid: str(spec.fluid),
        amount: new SnbtLong(String(countOf(spec.amount, 1000))),
      };
    },
    extract(entry) {
      return {
        type: 'fluid',
        fluid: str(entry?.fluid),
        amount: countOf(entry?.amount, 1000),
      };
    },
    describe(spec) {
      return `收集 ${countOf(spec.amount, 1000)} mB 的 ${str(spec.fluid) || '（没填流体）'}`;
    },
  },
  {
    type: 'custom',
    label: '自定义（原样保留）',
    // 自定义任务没有固定字段 —— 整条 NBT 是作者自己写的，我们**只读不改**。
    // 放到这里是为了让「界面上认得出这是自定义任务」，而不是显示成「认不出的类型」。
    fields: [],
    build(spec) {
      return { type: 'custom', ...(spec?.raw && typeof spec.raw === 'object' ? spec.raw : {}) };
    },
    extract(entry) {
      return { type: 'custom' };
    },
    describe() {
      return '自定义任务（内容由作者手写，界面不改它）';
    },
  },
];

// ————————————————————————— 奖励类型 —————————————————————————

const REWARD_DEFS = [
  {
    type: 'item',
    label: '给物品',
    fields: [
      { key: 'item', label: '物品 ID', kind: 'item', placeholder: 'minecraft:diamond' },
      { key: 'count', label: '给几个', kind: 'number', def: 1, min: 1 },
    ],
    build(spec) {
      const out = { type: 'item', item: { id: str(spec.item), count: 1 } };
      const n = countOf(spec.count);
      if (n > 1) out.count = n;
      return out;
    },
    extract(entry) {
      return { type: 'item', item: itemIdOf(entry?.item), count: countOf(entry?.count ?? itemCountOf(entry?.item)) };
    },
    describe(spec) {
      return `给 ${countOf(spec.count)} 个 ${str(spec.item) || '（没填物品）'}`;
    },
  },
  {
    type: 'xp',
    label: '给经验点',
    fields: [{ key: 'count', label: '给多少点', kind: 'number', def: 100, min: 1 }],
    build(spec) {
      return { type: 'xp', xp: Math.max(1, Math.floor(num(spec.count, 100))) };
    },
    extract(entry) {
      return { type: 'xp', count: Math.max(1, Math.floor(num(entry?.xp, 100))) };
    },
    describe(spec) {
      return `给 ${Math.max(1, Math.floor(num(spec.count, 100)))} 点经验`;
    },
  },
  {
    type: 'xp_levels',
    label: '给等级',
    fields: [{ key: 'count', label: '给几级', kind: 'number', def: 5, min: 1 }],
    build(spec) {
      return { type: 'xp_levels', xp_levels: Math.max(1, Math.floor(num(spec.count, 5))) };
    },
    extract(entry) {
      return { type: 'xp_levels', count: Math.max(1, Math.floor(num(entry?.xp_levels, 5))) };
    },
    describe(spec) {
      return `给 ${Math.max(1, Math.floor(num(spec.count, 5)))} 级`;
    },
  },
  {
    type: 'command',
    label: '执行命令',
    fields: [
      { key: 'command', label: '命令', kind: 'text', placeholder: '/say 恭喜完成' },
      // ⚠️ 这里是「给不给管理员权限」的开关，不是权限等级。
      // FTB 源码（CommandReward.java:29/47/56）只有一个布尔字段 `elevate_perms`，
      // 提权时等级写死 2（:111 `source.withPermission(2)`）。
      // 以前这里是个「权限等级」数字框、写 `permission_level` —— 那个字段源码 0 命中、
      // 两个真实整合包也 0 命中，游戏根本不读，用户填了没效果也不报错。
      { key: 'elevatePerms', label: '用管理员权限执行', kind: 'bool', def: false },
      { key: 'silent', label: '不显示回执', kind: 'bool', def: false },
    ],
    build(spec) {
      const out = { type: 'command', command: str(spec.command) };
      if (spec.elevatePerms) out.elevate_perms = true;
      if (spec.silent) out.silent = true;
      return out;
    },
    extract(entry) {
      return {
        type: 'command',
        command: str(entry?.command),
        elevatePerms: !!entry?.elevate_perms,
        silent: !!entry?.silent,
      };
    },
    describe(spec) {
      return `执行命令 ${str(spec.command) || '（没填命令）'}`;
    },
  },
  {
    type: 'advancement',
    label: '给进度',
    fields: [
      { key: 'advancement', label: '进度 ID', kind: 'text', placeholder: 'minecraft:story/root' },
      { key: 'criterion', label: '哪一条（可留空）', kind: 'text' },
    ],
    build(spec) {
      return { type: 'advancement', advancement: str(spec.advancement), criterion: str(spec.criterion) };
    },
    extract(entry) {
      return { type: 'advancement', advancement: str(entry?.advancement), criterion: str(entry?.criterion) };
    },
    describe(spec) {
      const adv = str(spec.advancement) || '（没填进度）';
      const crit = str(spec.criterion);
      return crit ? `给进度 ${adv} 的「${crit}」` : `给进度 ${adv}`;
    },
  },
  {
    type: 'toast',
    label: '弹一句提示',
    fields: [{ key: 'description', label: '提示文字', kind: 'text', placeholder: '恭喜完成！' }],
    build(spec) {
      return { type: 'toast', description: str(spec.description) };
    },
    extract(entry) {
      return { type: 'toast', description: str(entry?.description) };
    },
    describe(spec) {
      return `弹一句提示「${str(spec.description) || '（没填文字）'}」`;
    },
  },
  ...TABLE_REWARD_TYPES.map((t) => ({
    type: t.type,
    label: t.label,
    fields: [{ key: 'tableId', label: '战利品表 ID', kind: 'text', placeholder: '0DA6727500F2701E' }],
    build(spec) {
      const decimal = tableIdToLong(spec.tableId);
      const out = { type: t.type, table_id: new SnbtLong(decimal ?? '0') };
      // 「一键领取全部」时跳不跳过这一条 —— 三种类型的默认值**不一样**，照抄游戏别统一：
      //   choice → true  (ChoiceReward.java:50  override 成 return true)
      //   random → false (RandomReward.java:157 override 成 return false)
      //   loot   → true  (LootReward.java:60   override 成 return true)
      // 注意别被 RewardTypes.java:22/24/26 那三个 setExcludeFromListRewards(true) 骗了 ——
      // 那只是字段默认值（Reward.java:46 用它初始化），子类 override 的方法才是实际生效的那个，
      // ClaimAllRewardsMessage.java:38 过滤时调的是 getExcludeFromClaimAll()。
      // 真实包实测印证：ATM10Sky 的 random 807 处写了 / 41 处没写（=false 不写），
      // loot 274 处、choice 119 处**全是写的**（0 处没写）。
      // 游戏写盘时只有 true 才写（Reward.java:89），false 就是不写这个键。
      if (t.type !== 'random') out.exclude_from_claim_all = true;
      return out;
    },
    extract(entry) {
      return { type: t.type, tableId: tableIdToHex(entry?.table_id) };
    },
    describe(spec) {
      return t.describe(str(spec.tableId) || '（没填表 ID）');
    },
  })),
];

// ————————————————————————— 对外接口 —————————————————————————

/** 全部条件类型（界面下拉用）。 */
export const TASK_TYPES = TASK_DEFS.map((d) => ({ type: d.type, label: d.label, fields: d.fields }));
/** 全部奖励类型（界面下拉用）。 */
export const REWARD_TYPES = REWARD_DEFS.map((d) => ({ type: d.type, label: d.label, fields: d.fields }));

function findDef(defs, type) {
  const wanted = String(type ?? 'item').trim() || 'item';
  return defs.find((d) => d.type === wanted) ?? null;
}

/** 找条件类型定义；不认识返回 null（这类条目界面改不了，原样留着）。 */
export function taskDef(type) {
  return findDef(TASK_DEFS, type);
}

/** 找奖励类型定义；不认识返回 null。 */
export function rewardDef(type) {
  return findDef(REWARD_DEFS, type);
}

/** 类型的中文名；不认识就返回原样（界面上还能看出是个什么类型）。 */
export function typeLabel(kind, type) {
  const def = kind === 'reward' ? rewardDef(type) : taskDef(type);
  return def ? def.label : String(type ?? '?');
}

/** 友好 spec → FTB 条目（不含 id，id 由调用方给）。 */
export function buildTask(spec) {
  const def = taskDef(spec?.type);
  if (!def) return null;
  return def.build(spec);
}

/** 友好 spec → FTB 条目（不含 id）。 */
export function buildReward(spec) {
  const def = rewardDef(spec?.type);
  if (!def) return null;
  return def.build(spec);
}

/**
 * FTB 条目 → 友好 spec；类型不认识返回 null。
 *
 * spec 里带一个 label（人话），界面上直接摆出来就行，不用自己在浏览器里拼一遍。
 */
export function specFromTask(entry) {
  const def = taskDef(entry?.type ?? 'item');
  if (!def) return null;
  const spec = def.extract(entry);
  return { ...spec, label: def.describe(spec) };
}

/** FTB 条目 → 友好 spec；类型不认识返回 null。 */
export function specFromReward(entry) {
  const def = rewardDef(entry?.type);
  if (!def) return null;
  const spec = def.extract(entry);
  return { ...spec, label: def.describe(spec) };
}

/** 两个友好 spec 是不是一回事（比较时字段按类型归一）。 */
export function sameSpec(a, b) {
  if (!a || !b) return false;
  if (String(a.type ?? '') !== String(b.type ?? '')) return false;
  const def = taskDef(a.type) ?? rewardDef(a.type);
  if (!def) return JSON.stringify(a) === JSON.stringify(b);
  for (const field of def.fields) {
    const x = a[field.key];
    const y = b[field.key];
    if (field.kind === 'number' || field.kind === 'enum') {
      if (Number(x ?? field.def ?? 0) !== Number(y ?? field.def ?? 0)) return false;
    } else if (field.kind === 'bool') {
      if (!!x !== !!y) return false;
    } else if (String(x ?? '') !== String(y ?? '')) {
      return false;
    }
  }
  return true;
}

/** 友好 spec → 人话。 */
export function describeSpec(kind, spec) {
  const def = kind === 'reward' ? rewardDef(spec?.type) : taskDef(spec?.type);
  if (!def) return String(spec?.type ?? '?');
  return def.describe(spec);
}

/**
 * 把一次操作里传来的 spec 参数归一成对象。
 *
 * 界面和 MCP 传的是 JSON 串（模型偶尔也会直接塞一个对象），
 * 这里两种都收；空值当「没给」，格式不对就明说，别闷着当没这回事。
 */
export function parseSpecValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* 下面统一报错 */ }
    throw new McError(
      '完成条件 / 奖励的格式不对',
      '这里要填一段 JSON，比如 {"type":"item","item":"minecraft:iron_ingot","count":3}',
      'McBadArgs',
    );
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return undefined;
}

/**
 * 从一次操作的参数里取出「友好 spec」。
 *
 * 优先看新字段 taskSpec / rewardSpec（JSON 串或对象，能指定任意类型）；
 * 没有就退回老字段 taskItem / taskCount（rewardItem / rewardCount）—— 就是物品类型。
 * 两种都没有返回 undefined，表示「这一组不用动」。
 *
 * 新建任务、改已有任务、界面、MCP 全走这一个函数，免得四条路各写一套慢慢走偏。
 */
export function specFromParams(params, kind) {
  const prefix = kind === 'reward' ? 'reward' : 'task';
  const parsed = parseSpecValue(params?.[`${prefix}Spec`]);
  if (parsed !== undefined) return parsed;
  const itemKey = `${prefix}Item`;
  if (!params || !Object.hasOwn(params, itemKey)) return undefined;
  const rawCount = Number(params[`${prefix}Count`]);
  return {
    type: 'item',
    item: params[itemKey] === undefined || params[itemKey] === null ? '' : String(params[itemKey]).trim(),
    count: Number.isFinite(rawCount) && rawCount >= 1 ? Math.floor(rawCount) : 1,
  };
}

/**
 * FTB 条目 → 汇总视图（界面上显示用）。
 * `spec` 是友好 spec（能改的才有），`label` 是人话，`what` 是主要标识，`count` 是数量。
 */
export function summarizeTask(entry) {
  const spec = specFromTask(entry);
  const type = String(entry?.type ?? 'item') || 'item';
  return {
    type,
    label: spec ? describeSpec('task', spec) : `${type}（界面还改不了）`,
    what: whatOf(entry, type),
    count: countOf(entry?.count ?? entry?.item?.count ?? entry?.value, 1),
    spec,
  };
}

/** 奖励条目的汇总视图。 */
export function summarizeReward(entry) {
  const spec = specFromReward(entry);
  const type = String(entry?.type ?? 'item') || 'item';
  return {
    type,
    label: spec ? describeSpec('reward', spec) : `${type}（界面还改不了）`,
    what: whatOf(entry, type),
    count: countOf(entry?.count ?? entry?.item?.count ?? entry?.value, 1),
    spec,
  };
}

/** 条目里「主要标识是什么」：物品 id、生物 id、进度 id、维度、群系…… */
function whatOf(entry, type) {
  const map = {
    item: itemIdOf(entry?.item),
    kill: entry?.entity,
    advancement: entry?.advancement,
    dimension: entry?.dimension,
    biome: entry?.biome,
    structure: entry?.structure,
    stat: entry?.stat,
    gamestage: entry?.stage,
    observation: entry?.to_observe,
    command: entry?.command,
    toast: entry?.description,
    // 任务的经验写在 value 里，奖励的经验写在 xp 里；两者都叫 type:'xp'
    xp: entry?.xp ?? entry?.value,
    xp_levels: entry?.xp_levels,
  };
  if (type === 'choice' || type === 'random' || type === 'loot') {
    return tableIdToHex(entry?.table_id);
  }
  const value = map[type];
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 我们**曾经**自己发明、游戏根本不认的字段名。
 *
 * 改造旧条目时要把它们清掉 —— 否则「用户以前用旧版界面填过权限等级」这种脏数据
 * 会被 `{ ...oldEntry, ...fresh }` 原样带出去，游戏继续不认、继续不报错。
 *
 * ⚠️ 这份名单只放**已经用源码 + 真实包双重证伪**的字段，别往里随手加。
 * 其它不认识的字段一律保留：那可能是 FTB 自己的新字段、或者用户手写的高级配置。
 */
const BOGUS_FIELDS = ['permission_level', 'permissionLevel'];

/** 把已知假字段从条目里去掉（就地删，返回同一个对象）。 */
function stripBogus(entry) {
  for (const key of BOGUS_FIELDS) delete entry[key];
  return entry;
}

/**
 * 友好 spec + 旧条目 → 新的 FTB 条目。
 *
 * 三件事必须同时顾上：
 * 1. 沿用旧条目的 id —— 换了 id，玩家已经交过的进度就没了；
 * 2. 沿用旧条目的其它字段（比如 icon、tags）—— 那是用户自己配的，别抹；
 * 3. 数量写在**顶层 count** —— FTB 的 ItemTask.readData 只读顶层 count，
 *    物品堆里那个 count 只是那一摞物品自己的堆叠数。旧文件里两种写法都有
 *    （真实包里嵌套和顶层并存），这里一律规整成顶层：不然界面显示 8 个、
 *    游戏只当 1 个，那就对不上了。
 *
 * @param {'task'|'reward'} kind
 * @param {object} spec 友好 spec
 * @param {object|null} oldEntry 旧条目（改已有任务时传，新建的传 null）
 * @param {() => string} newId 新条目的 id 工厂（新建时用）
 */
export function buildEntry(kind, spec, oldEntry, newId) {
  const build = kind === 'reward' ? buildReward : buildTask;
  const fresh = build(spec);
  if (!fresh) return null;
  const id = oldEntry?.id ?? newId();
  if (!oldEntry) return { id, ...fresh };

  const oldType = String(oldEntry.type ?? 'item');
  const newType = String(fresh.type ?? 'item');
  if (oldType !== newType) {
    // 换类型了：旧类型专属的字段不能留着（原来配了物品，换成击杀后还挂着 item 就乱了），
    // 但图标和标签是用户自己配的，跟类型无关，留着。
    const kept = {};
    if (oldEntry.icon) kept.icon = oldEntry.icon;
    if (oldEntry.tags) kept.tags = oldEntry.tags;
    return { id, ...kept, ...fresh };
  }

  const out = stripBogus({ ...oldEntry, ...fresh, id });
  if (newType === 'item') {
    // 数量写在**顶层 count** —— FTB 的 ItemTask.readData 只读顶层，物品堆里那个 count 是备胎。
    // 旧文件里也有把数量塞在 item 里的写法（真实包两种都有），这种一并规整成顶层，
    // 不然游戏里只会当 1 个 —— 界面显示几个、游戏要几个，得对上。
    // 任务条件的顶层 count 是 long（带 L），奖励的是 int（不带 L），别写反。
    const want = countOf(spec?.count);
    out.item = { ...(oldEntry?.item ?? {}), id: fresh.item?.id ?? '', count: 1 };
    if (want > 1) out.count = kind === 'task' ? new SnbtLong(String(want)) : want;
    else delete out.count;
  }
  return out;
}

/**
 * 这一种类型里哪些字段必须填。
 *
 * 文本和物品 ID 类的框都要填才有意义；'criterion' 是例外 ——
 * FTB 里它表示「进度里的哪一条」，留空表示整条进度都算，所以可以空。
 */
const OPTIONAL_FIELDS = new Set(['criterion']);

/** 必填字段名（返回友好 spec 里的键名）。类型不认识就返回空数组。 */
export function requiredFields(kind, type) {
  const def = kind === 'reward' ? rewardDef(type) : taskDef(type);
  if (!def) return [];
  return def.fields
    .filter((f) => (f.kind === 'text' || f.kind === 'item') && !OPTIONAL_FIELDS.has(f.key))
    .map((f) => f.key);
}

/** 这一条缺了哪些必填的东西（返回缺字段名，没缺就空数组）。 */
export function missingFields(kind, entry) {
  const spec = kind === 'reward' ? specFromReward(entry) : specFromTask(entry);
  if (!spec) return [];
  return requiredFields(kind, entry?.type).filter((key) => !String(spec[key] ?? '').trim());
}

/**
 * 条目里「主要标识是什么」：物品 id、生物 id、进度 id、维度、群系……
 * 界面上显示图标、判断要不要画物品图标都靠它。
 */
export function entryWhat(entry) {
  return whatOf(entry, String(entry?.type ?? 'item') || 'item');
}

/**
 * 条目里「要几个」。
 * 顺序要紧：FTB 把数量写在顶层 count（ItemTask.readData 只读顶层），
 * 物品堆自己的 count 只是备胎。
 */
export function entryCount(entry) {
  return countOf(entry?.count ?? entry?.item?.count ?? entry?.value, 1);
}

/**
 * 友好 spec → 一条**全新**的 FTB 条目（不带 id，新建任务时由调用方补）。
 *
 * 类型不认识 / 必填没填都直接报错，别闷着写出一个玩家永远完不成的任务；
 * 物品类型没填 ID 则视为「这一组留空」，返回 null（和界面上清空输入框一个意思）。
 */
export function entryFromSpec(spec, kind) {
  if (!spec) return null;
  const type = String(spec.type ?? 'item').trim() || 'item';
  const def = kind === 'reward' ? rewardDef(type) : taskDef(type);
  if (!def) {
    throw new McError(
      `${kind === 'reward' ? '奖励' : '完成条件'}的类型「${type}」还不认识`,
      '换个支持的类型（物品 / 击杀 / 到达维度 / 攒经验 / 完成进度……），或者直接改文件。',
      'QuestUnsupportedCondition',
    );
  }
  if (type === 'item' && !String(spec.item ?? '').trim()) return null;
  const missing = requiredFields(kind, type).filter((key) => !String(spec[key] ?? '').trim());
  if (missing.length) {
    throw new McError(
      `${kind === 'reward' ? '奖励' : '完成条件'}少了必填项：${missing.join('、')}`,
      '把这几个框填全再提交。',
      'QuestMissingField',
    );
  }
  return kind === 'reward' ? buildReward(spec) : buildTask(spec);
}
