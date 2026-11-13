/**
 * 八个阶段的状态推断 —— 纯函数，不碰 DOM、不碰网络。
 *
 * 为什么单独一个文件：界面要「看得见的状态」（哪步做完了、卡在哪、下一步该干什么），
 * 这套判断逻辑必须能被测试直接调用。放在 app.js 里就只能靠肉眼看界面猜。
 *
 * 输入是「事实」facts，由界面从各个接口的返回里攒出来：
 *   { connected, instance, index, questBook, questCount, recipeCount, modsCount,
 *     exportPreview, launchResult, iconsCovered }
 * 输出是每个阶段一条 { key, status, detail, action }。
 */

/** 阶段状态：done 已完成 / current 现在该做 / todo 还没到 / blocked 卡住了。 */
export const STAGES = [
  {
    key: 'project',
    name: '建立项目',
    blurb: '选一个整合包目录，或者从零装一个底座',
    action: '选目录并连接',
  },
  {
    key: 'checkup',
    name: '体检',
    blurb: '看清版本、加载器、mod 数量、物品和配方各有多少',
    action: '读一次总览',
  },
  {
    key: 'content',
    name: '内容',
    blurb: '搜物品、看配方、改配方（走 KubeJS）',
    action: '搜一个物品试试',
  },
  {
    key: 'quests',
    name: '任务线',
    blurb: '在蓝图里加任务、改依赖、换图标',
    action: '读任务书并打开蓝图',
  },
  {
    key: 'assets',
    name: '资源',
    blurb: '图标覆盖情况、导出图标',
    action: '看一眼图标覆盖',
  },
  {
    key: 'pack',
    name: '打包',
    blurb: 'standard / offline / launcher 三种形态',
    action: '先算一次打包计划',
  },
  {
    key: 'verify',
    name: '验证',
    blurb: '真启动到主菜单，看日志和耗时',
    action: '跑一次启动测试',
  },
  {
    key: 'deliver',
    name: '交付',
    blurb: '记录这一版改了什么，把 zip 交出去',
    action: '打包并记录',
  },
];

/** 阶段顺序，供「上一步 / 下一步」用。 */
export const STAGE_KEYS = STAGES.map((s) => s.key);

/**
 * 算出每个阶段现在是什么状态。
 *
 * 规则很简单，但顺序很重要：**第一个没做完的阶段就是「当前」**，
 * 它后面的都是「还没到」。这样用户永远知道该往哪儿走。
 *
 * @param {object} facts 见文件头
 * @returns {Array<{key: string, name: string, status: string, detail: string, action: string}>}
 */
export function stageStatus(facts = {}) {
  const done = {
    project: Boolean(facts.connected),
    // 体检 = 已经拿到总览（有版本号和物品数）
    checkup: Boolean(facts.instance && facts.index),
    // 内容 = 索引里有物品，说明能搜能看配方
    content: Number(facts.index?.itemCount ?? 0) > 0,
    // 任务线 = 读到了任务书（哪怕 0 个任务，也算这一步通了）
    quests: Boolean(facts.questBook),
    // 资源 = 至少有一张图标（覆盖率不是 0）
    assets: Number(facts.iconsCovered ?? 0) > 0,
    // 打包 = 算过打包计划（真打包是下一步的事）
    pack: Boolean(facts.exportPreview),
    // 验证 = 跑过启动测试
    verify: Boolean(facts.launchResult),
    // 交付 = 真打过包
    deliver: Boolean(facts.exportDone),
  };

  let currentFound = false;
  return STAGES.map((stage) => {
    const isDone = done[stage.key];
    let status;
    if (isDone) {
      status = 'done';
    } else if (!currentFound) {
      status = 'current';
      currentFound = true;
    } else {
      status = 'todo';
    }
    return {
      key: stage.key,
      name: stage.name,
      status,
      detail: detailOf(stage.key, facts, isDone),
      action: stage.action,
    };
  });
}

/** 每个阶段的「现在是什么情况」一句话。 */
function detailOf(key, facts, isDone) {
  switch (key) {
    case 'project':
      if (!facts.connected) return '还没连上整合包';
      return facts.instance?.id ? `已连接：${facts.instance.id}` : '已连接';
    case 'checkup':
      if (!facts.instance) return '连上包之后自动读';
      if (!facts.index) return '正在读总览…';
      return `${facts.instance.mcVersion ?? '?'} ${facts.instance.loader ?? ''}，${facts.index.itemCount ?? 0} 个物品、${facts.index.recipeCount ?? 0} 条配方`;
    case 'content':
      if (!facts.index) return '需要先读总览';
      return `${facts.index.itemCount ?? 0} 个物品可以搜，${facts.index.recipeCount ?? 0} 条配方可以看`;
    case 'quests':
      if (!facts.questBook) return '这个包可能没装 FTB Quests，或者任务书读不出来';
      return `${facts.questBook.questCount ?? 0} 个任务、${facts.questBook.chapterCount ?? 0} 章`;
    case 'assets':
      if (!facts.iconsCovered) return '还没统计过图标';
      return `已覆盖 ${facts.iconsCovered} 个物品的图标`;
    case 'pack':
      if (!facts.exportPreview) return '还没算过打包计划';
      return facts.exportPreview.sizeText ? `预计 ${facts.exportPreview.sizeText}` : '计划已算出';
    case 'verify':
      if (!facts.launchResult) return '还没启动过';
      return facts.launchResult.ok ? `已到主菜单（${facts.launchResult.seconds ?? '?'} 秒）` : '启动失败，看日志';
    case 'deliver':
      if (!facts.exportDone) return '打完包才会有交付物';
      return facts.exportDone.file ? `已产出 ${facts.exportDone.file}` : '已产出';
    default:
      return isDone ? '已完成' : '';
  }
}

/**
 * 「下一步该做什么」—— 取第一个没做完的阶段。
 *
 * 用户打开工作台，最上面永远有一句话告诉他现在该干什么。
 */
export function nextStep(facts = {}) {
  const list = stageStatus(facts);
  const hit = list.find((s) => s.status === 'current');
  if (!hit) return { key: null, text: '八个阶段都通了，可以交付了' };
  return { key: hit.key, text: `${hit.name}：${hit.action}` };
}
