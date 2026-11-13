/**
 * 探针 G：KubeJS 脚本的「离线静态校验 + 干跑」可行性。
 * 思路：用 node:vm 在沙箱里提供伪造的 ServerEvents 等全局对象，
 * 真的执行脚本，把 event.recipes.* 的调用记录下来 → 得到「脚本想做什么」的事实。
 * 收益：不需要启动游戏就能验证语法、API 用法、以及收集配方意图。
 */
import vm from 'node:vm';

// 一份典型的 KubeJS 1.20.1 (KubeJS 2001.6.x) 服务端脚本
const script = `
ServerEvents.recipes(event => {
  // 魔改：移除原版安山岩配方
  event.remove({ id: 'create:andesite_alloy_from_crafting' })

  // 新增有序配方
  event.shaped('create:cogwheel', [
    'ABA',
    'BCB',
    'ABA'
  ], {
    A: 'minecraft:oak_planks',
    B: 'create:andesite_alloy',
    C: 'create:shaft'
  })

  // 无序配方
  event.shapeless('2x create:andesite_alloy', [
    'minecraft:iron_nugget',
    'minecraft:andesite'
  ])

  // 自定义机器配方（Create 压型）
  event.recipes.create.pressing('create:iron_sheet', 'minecraft:iron_ingot')

  // 熔炼
  event.smelting('minecraft:glass', 'minecraft:sand').xp(0.35).cookingTime(100)
})
`;

// ── 沙箱：记录所有调用 ────────────────────────────────────────────────────────
const calls = [];
function recorder(path = 'event') {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      const next = `${path}.${String(prop)}`;
      return recorder(next);
    },
    apply(_t, _this, args) {
      calls.push({ path, args });
      // 返回链式对象（.xp()/.cookingTime() 等）
      const chain = new Proxy(function () {}, {
        get(_t2, prop2) {
          if (prop2 === 'then') return undefined;
          return (...a) => { calls.push({ path: `${path}.${String(prop2)}`, args: a }); return chain; };
        },
      });
      return chain;
    },
  });
}

const sandbox = {
  ServerEvents: {
    recipes: (cb) => { calls.push({ path: 'ServerEvents.recipes', args: [] }); cb(recorder('event')); },
    tags: (cb) => cb(recorder('tags')),
    itemTags: (cb) => cb(recorder('itemTags')),
  },
  console: { log: (...a) => calls.push({ path: 'console.log', args: a }), warn() {}, error() {} },
  Platform: { isClientEnvironment: () => false, isServerEnvironment: () => true, getMinecraftVersion: () => '1.20.1' },
  Java: { loadClass: () => { throw new Error('Java 类不可用（离线沙箱）'); } },
  Utils: { id: (ns, p) => `${ns}:${p}`, isEmpty: (v) => !v },
  Item: { of: (id) => ({ id }) },
};

const ctx = vm.createContext(sandbox);

console.log('=== A. 语法检查（编译，不执行）===');
try {
  new vm.Script(script, { filename: 'server_scripts/recipes.js' });
  console.log('  编译通过');
} catch (e) {
  console.log('  编译失败：', e.message);
}

console.log('\n=== B. 在沙箱里真实执行 ===');
try {
  vm.runInContext(script, ctx, { filename: 'server_scripts/recipes.js', timeout: 3000 });
  console.log(`  执行成功，捕获 ${calls.length} 次调用`);
} catch (e) {
  console.log('  执行失败：', e.message);
}

console.log('\n=== C. 捕获到的调用序列（这就是「配方意图」）===');
for (const c of calls) {
  const preview = JSON.stringify(c.args, (k, v) => (v === undefined ? undefined : v)).slice(0, 150);
  console.log(`  ${c.path}(${preview})`);
}

console.log('\n=== D. 能否识别出「引用了不存在的物品 ID」？ ===');
// 我们手上已有 create 的真实 ID 集合（探针 B 产出），这里手工放几个演示
const knownIds = new Set(['create:cogwheel', 'create:andesite_alloy', 'create:shaft', 'minecraft:oak_planks',
  'minecraft:iron_nugget', 'minecraft:andesite', 'minecraft:iron_ingot', 'minecraft:sand', 'minecraft:glass',
  'create:iron_sheet', '2x create:andesite_alloy']);
const ids = new Set();
const walk = (v) => {
  if (typeof v === 'string' && /^(\d+x )?[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(v)) ids.add(v);
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
};
for (const c of calls) walk(c.args);
console.log('  脚本引用到的 ID：', [...ids]);
console.log('  不在已知集合里的：', [...ids].filter((i) => !knownIds.has(i)));

console.log('\n=== E. 语法错误能否定位到行号 ===');
const broken = `ServerEvents.recipes(event => {
  event.shaped('create:cogwheel', ['ABA'
})`;
try { new vm.Script(broken, { filename: 'bad.js' }); } catch (e) {
  console.log('  ', e.name, '|', e.message);
  console.log('  stack 首行：', String(e.stack).split('\n')[0]);
}

console.log('\n=== F. 用错 API（KubeJS 没有的方法）能否被发现 ===');
const wrongApi = `ServerEvents.recipes(event => {
  event.shapedd('create:cogwheel', ['A'], { A: 'minecraft:oak_planks' })
})`;
try {
  vm.runInContext(wrongApi, ctx, { filename: 'wrong-api.js' });
  console.log('  没报错 —— 但我们的 recorder 会记下 event.shapedd，可与白名单比对');
  const last = calls[calls.length - 1];
  console.log('  最后一条调用：', last.path);
} catch (e) {
  console.log('  执行报错：', e.message);
}
