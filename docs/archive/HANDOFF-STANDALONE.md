# 转接文档：从 DSH 插件 → 独立工作台

> 🗄️ **本文件已冻结（2026-11-01）**，只供溯源，不要再往里追加内容。
> 当前施工单是同项目的 [docs/HANDOFF.md](../HANDOFF.md)。


> 写于 2026-10-31。作者是插件这一轮的 lead。
> **这是方向变更后的新主线文档。** 之前两份仍然有效，但降级为"资料"：
> - `docs/archive/HANDBOFF.md`（≈150 KB，23 章）= 技术档案，所有实测数据、坑、错误码都在里面；
> - `docs/archive/HANDOFF-NEXT.md`（≈170 KB）= **插件侧**的行动清单，29 工具 / 41 接口 / 41 套件 598 条全绿的状态就记在那儿。
>
> 本文回答四件事：**为什么转、转成什么、怎么转、转的时候必须继承哪些坑。**
>
> **进度（2026-10-31 深夜，第二版）**：P0 抽包、P1 本地服务、P2 浏览器工作台都已做完并验过，见 §6.1 / §6.2 / §6.3 / §6.4。**界面形状已按用户要求重做成「选项目页 → 三栏工作台」**（左 mod 列表 / 中 蓝图编辑 / 右 任务详情），见 §6.4。蓝图交互已对齐 UE：拖动即落位（§6.6）、连线实时跟随 + 不留黑框（§6.7）、多选一起挪（§6.8）。
>
> **下一步（2026-11-01 早上定，施工单在 `docs/HANDOFF.md`）**：P2 第三轮 —— 按顺序接五块：① 工作流层（`packages/ui/stages.js` 已写好但 `app.js` 没 import）→ ② 改配方 → ③ 打包 → ④ 从零装底座 → ⑤ 启动验证（唯一要新加路由的一块）。

---

## 1. 一句话结论

用户决定：**做成独立的桌面软件（完整工作台 + 工作流），DSH 插件降为次要。**

好消息是这件事比听起来轻：现有代码里 **11961 行 `lib/core` 是纯 Node、零 DSH 依赖**，可以直接搬走复用；真正要重写的是**界面**（`lib/client.js` 3345 行，写死在 DSH 的插件格式里）和**工作流这一层**（现在根本没有——所有动作都是"点一下 → 一次 HTTP 请求"）。

用户原话（m04012）：

> 等一下，这个插件做在dsh里是不是不太方便，如果需要成为一个完整的工作台，应该有工作流的效果吧。我现在的想法是做成独立的软件，dsh上的插件是次要的。写转接文档吧

---

## 2. 现状盘点（这些数字是 2026-10-31 实测）

### 2.1 分层与规模

| 层 | 文件 | 行数 | 依赖 DSH？ | 迁移动作 |
|---|---|---|---|---|
| `packages/core/`（原 `lib/core/`） | 37 | **≈12000** | **否**（纯 Node + 内置模块） | **已搬完**：`lib/core` 已删，备份在 `lab/_backup-lib-core/` |
| `lib/host/` | 12 | 2465 | 只有 `registerStudioApi()` 用了 `connection.fetch.register` | **已换**：抽出 `dispatchStudioRequest`，`packages/server` 复用它 |
| `lib/tools/` | 16 | 3331 | **是**（每个文件 `import { defineTool } from '@deepseek-ai/dsh-tools'`） | 留在插件侧；core 不依赖它 |
| `lib/client.js` | 1 | **3345** | **是**（`window.__ModuleLoader__`、`slots`、`sidebarRightTabs`、DSH 主题 token） | **重写**（逻辑可抄，框架必须换） |
| `test/` | 38 个套件 | ≈9900 | 否（`test/register.mjs` 把 `dsh-tools` 换成桩） | **直接搬**，继续当后端回归 |
| `packages/server/` | 2 | ≈150 | 否（`node:http`） | **已建**：`createStudioServer()` |
| 文档 | 3 | ≈320 KB | — | 保留，本文新增 |

依赖方向是干净的：`core ← host ← tools`，界面只通过 HTTP 访问 host。

**原来那处破口已经修好**：`searchItems` 已搬进 `packages/core/item-search.js`（纯函数），`lib/host/api.js` 从那里 import，`lib/tools/item-search.js` 改成 re-export。独立后端不再被迫装 DSH SDK。

### 2.2 已经能用的能力（不用重做，只需接界面）

- **实例探测与索引**：Mechanomania 实测 **10386 个物品 / 11503 条配方，索引 550ms**；中文名 8152 条；简介 299 条。
- **物品图标**：**92.7% 有图**（9624/10386），其中 3445 个是等轴测模型渲染出来的；缺 762 个（刷怪蛋、箱子这类实体渲染物品），可单张去 MC百科 要。
- **配方**：读、改、预览、写入（KubeJS），写完复验、失败回滚、自动备份。
- **任务书**：395 个任务 / 18 章，读、改、增删任务与章节、拖拽画布、右键编辑（换图标/改依赖/删任务）。
- **打包**：standard / offline / launcher 三形态，PCL2 自检全过。
- **从零装底座**：1.21.1 NeoForge（678.9 MB / 136.6s）与 1.20.1 Forge 47.4.28（751.8 MB / 380.1s，含自动下 Java 17）都实测成功。
- **启动验证**：两个版本都真启动到主菜单，17.2s / 17.3s，判据是日志里的 `Sound engine started`。
- **测试**：37 套件 / **553 条全绿**。

### 2.3 现有目录（迁移时按这个搬）

```
lib/core/*.js        ← 后端引擎（实例、索引、图标、配方、任务书、KubeJS、打包、启动、下载、Java）
lib/host/*.js        ← HTTP 处理器（41 条路由）
lib/tools/*.js       ← 29 个模型工具（插件专属）
lib/client.js        ← 侧边面板（DSH 专属，要重写）
test/*.test.mjs      ← 37 个套件
locale/{zh,en}.json  ← 工具文案
cordis.patch.yml     ← DSH 插件挂载描述
```

---

## 3. 为什么在 DSH 里"不太方便"（把用户的直觉翻译成具体限制）

1. **空间**：面板是聊天界面右侧的一条窄栏（约 400px 宽），蓝图、配方网格、打包表格都挤不下。工作台需要三栏 + 底部任务条。
2. **没有"项目"概念**：DSH 的会话一换，上下文就散了；整合包这种要连续做几天的东西，需要一个持久的项目对象。
3. **没有工作流**：现在每个动作都是"点一下 → 一个请求 → 立刻返回"。下载 380 MB、索引 1 万个物品、打包 886 MB、启动游戏这些长任务，只能干等，关掉面板就断。
4. **发布形态**：要让别的玩家用，得先装 DSH、再挂插件、再重启。独立软件是双击 exe。
5. **宿主 API 不稳**：这一轮已经踩了两次——主题 token 名字写错会**静默失效**（配色整片发灰）、`ctx.get('connection')` 在 apply 阶段拿到 `undefined` 导致 7 条路由一条没注册。依赖越少越稳。

---

## 4. 目标形态：工作台 = 项目 + 阶段流水线

### 4.1 "工作流的效果"具体是四件事

用户说的"工作流"，落到可验收的四条：

- **看得见的状态**：每个阶段有"未开始 / 进行中 / 完成 / 失败"，有进度百分比，不是黑盒。
- **可断点**：长任务在后台跑，关掉界面再打开，进度还在，能接着跑。
- **可回滚**：每次写盘前备份、写后有事务日志，能一键撤销上一次改动。
- **有产出物**：每个阶段产出文件或报告（体检报告、diff、zip、启动日志），能打开、能对比。

### 4.2 八个阶段

| 阶段 | 输入 | 动作 | 产出 | 校验 | 回滚点 |
|---|---|---|---|---|---|
| **S1 建立项目** | 一个整合包目录 / 一个版本号 | 导入已有包、从零装底座、从零建包 | `project.json` | 版本+加载器识别成功 | 删除项目（只删自己建的） |
| **S2 体检** | 项目 | 扫 mod、查前置缺失、冲突、Java、内存建议 | 体检报告 | 无致命项才能往下 | 只读 |
| **S3 内容** | 项目 | 浏览物品/配方；改配方（KubeJS） | diff + `kubejs/server_scripts/*.js` | 脚本沙箱试跑通过 | 备份文件 |
| **S4 任务线** | 项目 | 蓝图编辑：增删改任务、依赖、图标、拖拽 | `config/ftbquests/**` + lang | 写完重读复验 | 备份文件 |
| **S5 资源** | 项目 | 图标导出、汉化补全、配置微调 | 资源包/缓存 | 图标覆盖率统计 | 只读或备份 |
| **S6 打包** | 项目 | standard / offline / launcher | zip | PCL 兼容自检 | 删 zip |
| **S7 验证** | 包 | 真启动到主菜单 | 启动日志 + 耗时 | 出现 `Sound engine started` | 只读 |
| **S8 交付** | 包 | 版本记录、变更清单、分享路径 | `release.md` + zip | 用户确认 | 只读 |

关键点：**每个阶段的"写"动作都走现有的 plan → apply 双态**（这是插件里已经验证过的模式），所以"预览 / 执行 / 撤销"三件套天然成立。

### 4.3 数据模型（全部落盘，JSON）

```
<项目根>/
  project.json          { id, name, root, mcVersion, loader, createdAt, lastOpenedAt }
  .mcstudio/
    index-cache/        索引缓存（按 jar 的 mtime+size 判失效）
    icon-cache/         图标缓存（png 文件 + 索引）
    runs/<runId>/       { plan.json, log.ndjson, artifacts/ }
    backups/            每次写盘的备份（可撤销）
```

Job 模型（后台任务）：

```js
{
  id, kind,            // 'index' | 'download' | 'pack' | 'launch' | 'icon-export' | ...
  params,              // 入参，可重放
  state,               // 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  progress,            // 0..1 + message
  startedAt, endedAt, error,
  artifacts: [],       // 产出文件
  undo: null | { files: [...] }   // 撤销凭据
}
```

事件通道：`GET /events`（SSE）推 `{ jobId, state, progress, message }`。前端只订阅，不轮询。

### 4.4 界面信息架构

```
┌──────────┬───────────────────────────────┬──────────────┐
│ 左栏      │ 中间工作区                     │ 右栏检查器    │
│ 项目名    │ （当前阶段的主界面）             │ 选中对象的详情 │
│ ① 建立   │  S3：物品表 + 配方网格          │ diff / 属性   │
│ ② 体检 ✓ │  S4：任务蓝图（SVG 画布）        │ 日志流        │
│ ③ 内容   │  S6：打包表单 + 进度            │              │
│ ④ 任务线 │                               │              │
│ ⑤ 资源   │                               │              │
│ ⑥ 打包   │                               │              │
│ ⑦ 验证   │                               │              │
│ ⑧ 交付   │                               │              │
├──────────┴───────────────────────────────┴──────────────┤
│ 底部任务条：运行中的 job + 进度 + 取消                        │
└─────────────────────────────────────────────────────────┘
```

---

## 5. 技术选型

| 方案 | 形态 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A 本地服务 + 浏览器** | `mcstudio serve` → `http://127.0.0.1:7xxx` | 后端零改动、一周内可用、调试方便 | 不像"软件"、要自己开浏览器 | **第一步先做这个** |
| **B Electron 壳** | 双击 exe，内部加载 A | 直接复用 A 的全部代码；Node 原生可用（下载/启动 Java 都是子进程）；打包简单 | 体积约 150 MB；内存占用高 | **最终形态（推荐）** |
| **C Tauri + Node sidecar** | 双击 exe，Rust 壳 + 外部 Node | 体积小（~15 MB） | 要 Rust 工具链 + sidecar 生命周期管理；子进程权限更绕 | 不推荐（省下的体积不值这些麻烦） |

**推荐路线：先 A 后 B，同一套前端代码，Electron 只是加个壳。**

前端：**Vite + React 18 + TypeScript**。
- 为什么 TS：现有面板逻辑 3345 行，涉及大量 `{questId, changedCount, dependents}` 这类结构，没类型保护很容易重犯"字段名写错、界面显示（空）→（空）"的 bug（这轮真踩过）。
- 为什么不用现成组件库：面板的视觉密度很高（物品表、配方网格、蓝图），通用库反而要覆盖样式；自己写 CSS 变量 + 少量组件更省。
- 蓝图继续用 **SVG**（现有画布几何、吸附、拖拽逻辑可以直接抄，`CELL=76`、`snapCoord` 到 0.5 这些常量已在插件里验证过）。

---

## 6. 迁移路线（每个阶段都能交付可用物）

| 阶段 | 内容 | 估时 | 交付物 | 状态 |
|---|---|---|---|---|
| **P0 抽包** | `lib/core` → `packages/core`；修 `searchItems` 破口；37 套件 553 条在新位置跑绿 | 0.5 天 | 可被任意 Node 项目 import 的 core 包 | **已完成（2026-10-31）** |
| **P1 本地服务** | `packages/server`：`node:http` + 41 条路由适配器 + SSE + 静态文件；`mcstudio serve` 命令 | 2–3 天 | `curl` 能打全部接口；浏览器能打开一个临时页面 | **基本完成**：41 条路由全通，SSE/静态文件/命令行未做 |
| **P2 前端重写** | `packages/ui`：三栏工作台（左 mod 列表、中任务蓝图、右选中任务检查器）；一律 plan/apply | 1–2 周 | 能连包、能看、能改的网页版 | **第二版已完成**：三栏 + 蓝图右键编辑 + 拖动改位置 + 改配方/改任务两态全接上（见 §6.4） |
| **P2.5 桌面快捷方式（方案 A）** | 桌面 `.lnk` → 隐藏窗口的 `启动.vbs` → `launch.mjs` 起服务并开浏览器 | 0.5 天 | 双击图标就能用 | **已完成（2026-10-31）**，见 §6.5 |
| **P3 工作流引擎** | job 队列、进度事件、事务日志、撤销、断点续跑 | 3–5 天 | 长任务可关窗口；每步可撤销 | 未开始 |
| **P4 桌面壳（方案 C）** | `packages/desktop`：Electron 打包 exe、拖目录/zip 进窗口、单实例、端口自选 | 2–3 天 | 双击即用的安装包 | **未开始 —— 用户明确要求放在项目最后阶段做**（先把 A 用起来，最后再换成 C；界面代码一行不用改，见 §6.5 末尾） |
| **P5 插件瘦身** | DSH 插件只保留 tools + "打开工作台"入口，共用 `packages/core` | 1 天 | 两边同源，不分叉 | 未开始 |

### 6.1 P0 实际怎么做的（照这个继续，别重来）

1. `packages/core/` = 原 `lib/core/` 的完整复制（**36 个 .js**），外加新文件 `item-search.js`（把 `rankOf` + `searchItems` 从工具层搬进来，纯函数、零外部依赖）。整包只依赖 `node:` 内置模块，没有任何第三方包 —— 这是它能被独立后端直接 import 的前提。
2. 引用迁移：`lib/tools/*.js`（14 个文件）的 `'../core/x.js'` → `'../../packages/core/x.js'`；`test/*.mjs`（37 个文件）的 `'../lib/core/x.js'` → `'../packages/core/x.js'`。脚本 `lab/_migrate-core-imports.mjs` 干的这件事，带 `--apply` 才写盘。
3. **删掉 `lib/core`**（先备份到 `lab/_backup-lib-core/`）。留着两份副本会出真 bug：`lib/host` 从 `packages/core` 抛 `McError`、测试从 `lib/core` 导入，就成了两个不同的类，`instanceof` 为假但类名一样，报错长这样 ——「应该抛 McError，实际是 McError」。这种错看一眼完全懵。
4. `packages/core/package.json`：`"type": "module"`、`exports` 里 `"./*.js": "./*.js"`，这样 `import ... from '@mcstudio/core/quests.js'` 和相对路径都能用。

### 6.2 P1 实际怎么做的

1. **抽出一个纯派发函数** `dispatchStudioRequest(request)`（在 `lib/host/api.js`）。它干的事：按 `ROUTES` 表匹配路径 → 校验方法 → 调 handler → 包成 `Response`。DSH 插件的 `registerStudioApi` 现在也走它，所以「插件里点」和「独立版点」是同一套逻辑，不会分叉。
2. `packages/server/server.js` 只做翻译：Node `IncomingMessage` → `{url, method, text(), json()}`，回来的 `Response` 写回 `ServerResponse`。请求体只读一次并缓存（handler 可能既读文本又读 JSON）。
3. **必须给 url 补 origin**：各 handler 里写的是 `new URL(request.url)`（DSH 传进来的是绝对地址），适配器如果只给 `/instances?...` 就报 `Invalid URL`。这一条卡了一轮。
4. 跨域和预检（OPTIONS → 204 + `access-control-allow-*`）都放开，因为服务只监听 `127.0.0.1`，是本地页面在调。
5. 实测：`lab/_probe-server2.mjs` 起服务打 17 条代表性接口（覆盖读数据、改配方预览、任务书、画布、mod 搜索、打包预览、图标、装 mod 清单）**17/17 全通**；`test/server.test.mjs` 7 条守住翻译层（起得来 / 前缀有无都认 / 404 带路径 / 405 列方法 / POST 体能读到 / 预检 / 关掉后端口拒连）。
6. 还没做：SSE 进度流、静态文件托管、`mcstudio serve` 命令行入口。这三样属于 P2 一起做更顺（静态托管和命令行入口已经在 P2 补上了，见 §6.3）。

### 6.3 P2 第一版：浏览器工作台（2026-10-31 深夜）

> **注意：这一节的「左栏八阶段流水线」形状已被 §6.4 取代**（用户反馈「不应该是流水线铺出来，而是页面」）。下面保留的是第一版的做法与它踩到的坑，仍然有用的部分是：为什么不用 React、静态文件托管怎么写、DOM 替身测试怎么搭。

**目标**：先把「完整工作台长什么样」摆出来 —— 左边一条八阶段流水线，右边是当前阶段的主界面，占满整屏，不再是侧边栏里挤一列。

**做法**：不引入 React / 不引入构建步骤，直接操作 DOM。理由：这一版只有 8 个面板，整体重建最不容易出错；而且改完 `app.js` 刷新页面就生效，不用重启服务、不用打包。

四个文件：

| 文件 | 干什么 |
| --- | --- |
| `packages/ui/stages.js` | 八阶段的定义 + `stageStatus(facts)` / `nextStep(facts)`。**纯函数**，所以能直接在 Node 里测 |
| `packages/ui/app.js` | 界面主体：阶段栏、8 个面板、接口调用 |
| `packages/ui/index.html` | 壳（只引 css 和 app.js） |
| `packages/ui/style.css` | 自己的配色变量，**不依赖 DSH 主题 token** |

**阶段状态怎么算**（这是「工作流效果」的核心）：`stageStatus` 拿一份 facts，判断每个阶段做完了没有，然后**第一个没做完的就是「当前」**，它后面的都是「还没到」。所以顶栏永远有一句「下一步：任务线：读任务书并打开蓝图」。

| 阶段 | 算「做完」的判据 |
| --- | --- |
| 建立项目 | 连上了（有 summary） |
| 体检 | 有 instance + index |
| 内容 | `itemCount > 0`（空索引不算能搜东西） |
| 任务线 | 读到了任务书（哪怕 0 个任务也算通了） |
| 资源 | 至少拿到 1 张图标 |
| 打包 | 算过打包计划 |
| 验证 | 跑过启动测试 |
| 交付 | 真打过包 |

**这一版能干什么**：连包（常见位置 / 手填 / 列实例）、看体检、搜物品（中文或 ID）、看配方「怎么来的 / 谁在用它」、看配方详情、读任务书、看蓝图（SVG，连线和方块，点方块看任务详情）、查图标导出状态、算打包计划、真打 zip。

**这一版还不能干什么**（诚实清单）：改配方、改任务（换图标/改依赖/删任务）、拖拽挪位置、从零装底座、启动验证。这些接口后端全都有（`/recipe/preview|apply`、`/quest/node/*`、`/quest/move/*`、`/scaffold/*`），只是界面还没接 —— 下一轮就是把这些「写」的动作按 plan → apply 两态接上。

**静态文件托管**：`packages/server/server.js` 加了 `tryStatic()`。只服务 `packages/ui` 下的文件、**只认一层文件名**（正则 `^[A-Za-z0-9._-]+$`），所以 `../` 穿越在拼路径之前就被挡掉；后缀不在白名单里的一律 404。

**测试**（新增 2 个套件 15 条）：

- `test/ui.test.mjs`（13 条）：阶段推断 7 条（没连包时第一个是当前、连上后体检变当前、空索引不算能搜、都做完时 nextStep 说可以交付…）+ 静态服务 6 条（首页 / 脚本样式类型 / 接口不受影响 / 路径穿越挡住且响应里不能出现源码 / 不认识的后缀不服务）。
- `test/ui-app.test.mjs`（2 条）：**用一个最小 DOM 替身把 `app.js` 真跑一遍**。为什么需要它：这个沙箱里起 Edge/Chrome 会被拒（Access denied），而「渲染路径里引用了不存在的函数」只有真跑才暴露 —— 开发时就漏定义过 `truncate`，浏览器里表现为整页空白 + 控制台一行红字。这条测试覆盖「模块能加载 / render 不抛 / 八个阶段都在 / 假接口的数据真的进了界面 / 点连接后顶栏变成实例名」。

**全量基线**：**40 套件 / 575 条全绿**（P1 结束时是 38/560）。

**怎么打开**：`node packages/server/bin.mjs`（默认 `127.0.0.1:7456`），浏览器开 `http://127.0.0.1:7456/`。

### 6.4 P2 第二版：三栏工作台（2026-10-31 深夜，按用户要求重做）

**用户原话（这一节的验收标准）**：「不应该是流水线铺出来，而是页面，选定项目后，进入制作阶段，随后体检。左侧栏是mod列表，可搜索导入整合包，中间是任务书蓝图编辑，右侧栏应该放什么我还没想好」

**改成了什么**：

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：实例名 · 版本 · 加载器 · 物品数 · 配方数  [重新体检][换项目] │
├──────────────┬────────────────────────────┬──────────────────┤
│ 左 268px     │ 中 flex（占满剩余）        │ 右 340px         │
│ Mod 列表     │ 任务书蓝图（SVG）          │ 任务详情 + 编辑  │
│ 搜索框       │ 拖动 = 挪位置              │ 改名/换图标/     │
│ 计数         │ 右键 = 改任务              │ 改前置/加后继/   │
│ 列表(限 400) │ 点 = 选中                  │ 删除             │
│ [刷新][装新mod]│                           │ 计划卡 / 结果卡  │
└──────────────┴────────────────────────────┴──────────────────┘
```

**两个屏幕**：`state.screen = 'pick' | 'studio'`。

1. **选项目页**：大标题 + 「先挑一个整合包」+ 按常见位置分组列出实例（每个 root 一次 `/instances`，并发拉）+ 「手填目录」卡片。**没有任何流水线、没有阶段圆点。**
2. **工作台**：点一个实例（或填目录回车）→ `connect()` → 先读 `/summary`（= 体检，这就是用户说的「随后体检」），再并发读 `/mods` 与 `/questbook` → 有任务书就 `refreshCanvas()` 读蓝图 + 批量取节点图标。**进来直接就能看到蓝图，不用点按钮。**

**左栏（mod 列表）**：本地 `/mods` 结果按 `name + modId` 子串过滤（前端过滤，不走接口，因为列表本来就在手里）；最多渲染 400 条（包大到几千个 mod 时不卡）。下半「装新 mod」展开 `modSearchBox()`：`/mod-search` 搜 Modrinth → 每个命中一个「看要下什么」→ `/mod-install/preview` 出清单 → 「就装这些」→ `/mod-install/apply` → 装完自动 `refresh=1` 重读 mod 列表。

**中栏（蓝图编辑）**：

- **点方块** → `selectQuest(id)` → `/quest` 取详情，右栏出详情卡。
- **拖动方块** → `beginDrag()`：拖动期间**只改 DOM**（`group.setAttribute('transform', translate(dx,dy))`），松手把像素位移换算成格子坐标（`/ CELL_X`、`/ CELL_Y`，再 `snap()` 到 0.5 格）后**直接写盘** —— 这一版最初是「松手 → 出计划 → 用户点确认」，被用户否掉了，改成拖动即落位，详见 §6.6。
- **右键方块** → `openMenu()` 记住屏幕坐标（`clientX/clientY`），渲染 `position:fixed` 菜单：改名字/副标题、换图标物品、改前置依赖、在它后面加一个任务、（分隔）删掉这个任务。
- 节点/连线/标题的配色全部走 CSS 类（`.mcs-box`、`.mcs-edge`、`.mcs-node-title`），**不在 SVG 里写 `fill="var(...)"`**（presentation 属性不吃 `var()`，插件那边踩过，必须用 `style` 或 class）。

**右栏（任务详情 + 编辑）** —— 用户说「还没想好」，这里放的是**选中对象的检查器**，理由：中间是蓝图编辑，点一个节点最自然的下一步就是「在右边改它」，而且写操作的两态卡（计划/结果）也需要一个固定的落点。

- 详情：ID / 章节 / 坐标 / 图标 / 副标题 / 要求数 / 前置 / 后续。
- 五个操作按钮：改名、换图标、改前置、加后继、删掉这个任务。
- 四种编辑卡（`state.draft.kind`）：`icon`（输入框 + 「搜物品」中文搜索 + 候选列表带图标）、`deps`（过滤框 + 勾选列表，可跨章节，排除自己）、`delete`（先看 `dependents` 警告）、`new`（标题 + 物品 + 数量）、`rename`（标题 + 副标题）。
- **一律两态**：编辑卡 → 「预览会改什么」→ 计划卡（changes / diff / warnings / 会写哪些文件）→ 「确认写入」→ 结果卡（lines / backups）。

**接口全部复用现成的**（这一轮后端一行没改）：`/quest/node/preview|apply`、`/quest/node/delete/preview|apply`、`/quest/move/preview|apply`、`/quest/add/preview|apply`、`/quest/preview|apply`、`/mods`、`/mod-search`、`/mod-install/preview|apply`、`/quest/canvas`、`/item-icons`。

**测试**：`test/ui-app.test.mjs` 从 2 条扩到 4 条，覆盖「选项目页 → 点实例进工作台 → 点方块看详情 → 右键换图标预览+写入」。**DOM 替身两个新坑**：

1. `el()` 里 `class` 是**赋给 `className`** 的，不走 `setAttribute` —— 所以按 class 找元素要同时看 `node.className` 和 `node.attrs['class']`（这次先踩了，菜单项找不到）。
2. `post()` 传的是**相对路径**（`/api/mcstudio/...`），浏览器里会自动补 origin，但测试里的假 `fetch` 必须显式给 base：`new URL(String(url), 'http://127.0.0.1:7460')`。不给就抛 `Invalid URL`，而 `run()` 会把它吞成一条界面报错，表现为「点了按钮但接口没被调用」。

**全量基线**：**40 套件 / 577 条全绿**（第一版是 575，`ui-app` 多了 2 条）；补 30 之后是 **41 套件 / 588**；拖动重做之后是 **41 套件 / 593**；连线实时跟随 + 黑框修复之后是 **41 套件 / 595**；多选一起挪修复之后是 **41 套件 / 598**。

**还没接的**（诚实清单）：改配方（`/recipe/preview|apply`）、从零装底座（`/scaffold/*`）、从零建包（`/pack/*`）、打包（`/export/*`）、启动验证（插件侧才有）。左栏也还没有「导入整合包」的入口（目前靠顶栏「换项目」回选项目页）。

### 6.5 桌面双击启动（方案 A，2026-10-31 晚）

**用户要什么**（原话）：「启动方式能不能做成在桌面上双击应用快捷方式的形式」→ 后来又拍板「先做A吧，之后在改成C的形式，这点写到计划里，大概在项目的最后修改形式」。

**为什么先 A 不直接 C**：A 十几分钟能做完，当天就能用；C（Electron）要打包 150–200MB、还要处理 native 依赖，属于「最后一步再换外壳」的事。中间不要停在 B（单个 exe + Edge `--app` 窗口）——它既没有 A 的简单，也没有 C 的干净。

**链路**：桌面 `整合包工作室.lnk` → `wscript.exe "packages/server/启动.vbs"` → 隐藏窗口跑 `node packages/server/launch.mjs` → 服务在后台常驻（脱离父进程）→ 默认浏览器打开 `http://127.0.0.1:7456/`。

| 文件 | 干什么 |
| --- | --- |
| `packages/server/launch.mjs` | 启动「大脑」：探端口 → 已在跑就直接开页面 → 没跑就 spawn 一个脱离的服务 → 等健康检查 → 开浏览器。`--port` / `--no-browser` / `--dry-run` 三个开关 |
| `packages/server/setup-shortcut.mjs` | 一次性安装：画图标（`app.ico`）、生成 `启动.vbs`、用 PowerShell 建 `.lnk` |
| `packages/server/app.ico` | 5870 字节，6 个尺寸（16/32/48/64/128/256），等轴测立方体 + 圆角底板 |
| `packages/server/启动.vbs` | UTF-16LE 带 BOM；`sh.Run(target, 0, True)` 隐藏黑框；参数原样转发给 launch.mjs；出错弹中文 MsgBox 并指向 `launch.log` |

**关键设计**

1. **服务必须脱离父进程**：`spawn(..., {detached:true})` + `unref()`，否则 VBS 一退出服务就被带走，浏览器打开时页面已经没了。
2. **`stdio` 必须 `'ignore'`**：这个环境给子进程接管道会 EPERM（HANDOFF-NEXT 坑 5b 的老问题，换到独立版一样成立）。
3. **「已经在跑就别再起第二个」**：`isHealthy()` 用 `/api/mcstudio/roots` 返回 `ok:true` 判定，端口被别的程序占着（能连但不健康）会等 5 秒再报 `McLaunchPortBusy`，而不是傻起第二个。
4. **日志落到 `packages/server/launch.log`**：双击场景没有控制台，出问题只能靠它（可用 `MCSTUDIO_LOG` 覆盖路径）。
5. **`launch.mjs` 被 import 时零副作用**：`if (process.argv[1] && path.resolve(...) === path.resolve(fileURLToPath(import.meta.url))) main();` —— 这样测试能直接 import 里面的函数。
6. **VBS 引号一律用 `Chr(34)` 拼**：VBS 的字符串转义是「两个双引号」，`"node ""path""""` 这种层层嵌套必算错，第一次就是这么炸的（`Microsoft VBScript compilation error: Unterminated string constant`，行 7）。

**踩到的坑**

| 现象 | 真因 | 改法 |
| --- | --- | --- |
| `cscript 启动.vbs` 报 `Unterminated string constant`（行 7） | 模板里 `"node ""${path}""""` 多出一个引号 | 改成 `"node " & Chr(34) & "路径" & Chr(34)` |
| 打印出来的快捷方式路径是一坨 XML | PowerShell 往 stdout 混 CLIXML 进度信息 | `runPowerShell` 按行过滤，只取以 `.lnk` 结尾的那行 |
| 快捷方式建不出来 | 沙箱是 workspace-write，写 `D:\Desktop\*.lnk` 报 `UnauthorizedAccessException` | 自动退到项目根目录建，并提示用户自己拖到桌面 |
| `--no-browser` 时日志还说「打开页面」 | 文案没跟着开关走 | 分开写「服务就绪（按要求没开浏览器）」 |

**实测**

- `node packages/server/launch.mjs --dry-run --port 7471` → `{"started":false,"alreadyRunning":false,"port":7471,"page":"http://127.0.0.1:7471/"}`，exit 0。
- 真启动：约 **300ms 就绪**；再跑一次 → 日志「端口 7471 上已经有服务了，直接开页面」，exit 0（没起第二个）。
- `cscript //nologo "packages\server\启动.vbs" --no-browser --port 7472` → exit 0，`/api/mcstudio/roots` 200（897 字节）。
- 图标像素体检：四角 alpha=0（圆角），底板 `#1b1e24` 占 70.4%，三个面各占 8.1%（`#2b8f97` / `#3fc8d0` / `#7ae7ef`）—— 面积三等都一样，说明等轴测投影没歪。
- `test/desktop-launch.test.mjs` **11 条全过**（参数解析 / 开关 / 地址 / 探活 / 健康检查 / 超时 / dry-run 不起进程 / 已在跑则复用 / 图标像素 / ICO 结构 / VBS 内容）。

**怎么用**

1. 双击项目根目录的 `整合包工作室.lnk`（沙箱不让写桌面，所以放在项目根目录 —— 拖到桌面即可）。
2. 之后要重新安装或改名字：`node packages/server/setup-shortcut.mjs [--name 名字] [--out 目录]`。

> ⚠️ **一条在 DSH 沙箱里测不出来的事**：DSH 用 Windows job 对象管子进程，命令一结束整棵树就被回收，`detached + unref` 也留不住。所以「服务常驻」这条只能在**资源管理器双击**的场景下验证 —— 用户双击时不在任何 job 里，服务会正常常驻。验证办法：双击一次 → 关掉浏览器 → 再双击一次 → 日志应写「端口 7456 上已经有服务了，直接开页面」。

**换成 C（Electron）时要注意什么**：`packages/ui` 一行不用改 —— 它只是 `fetch('/api/mcstudio/...')` 的静态页面。Electron 里要做的是：把 `createStudioServer` 起在 main 进程、`BrowserWindow.loadURL(studio.url)`、图标复用 `app.ico`、单实例锁、端口自选。**这一步按用户要求放到项目最后做。**

合计约 **4 周**（一个人，含调试）。P0+P1 是硬骨头里最确定的部分，建议第一天就做。

建议的仓库结构：

```
mcstudio/
  packages/core/        ← 已就位：原 lib/core（36 个）+ item-search.js，零外部依赖
  packages/server/      ← 已就位：http 适配器（createStudioServer），复用 lib/host 的派发
  lib/host/             ← 现在的 41 条接口实现（暂时留在这儿，P2 时可搬进 packages/server）
  lib/tools/            ← DSH 工具层（插件侧）
  packages/ui/          ← 已就位：三栏工作台（stages.js + app.js + index.html + style.css），零构建
  packages/desktop/     ← 待建：Electron 壳
  test/                 ← 现在的 41 个套件（后端回归 + 界面逻辑，598 条）
```

### 6.6 拖动即落位：把蓝图交互对齐 UE（2026-10-31 晚）

**用户原话**：「我已经测试过蓝图功能了，有点问题，为什么要有确认挪动这种功能，不应该挪完之后就算挪好了吗，我建议你去github上找找蓝图编辑的项目，我觉得ue的蓝图编辑功能是我见过最好用的」

**去看了什么**（只借交互范式，**一个库都没引入**，`packages/ui` 仍然是零构建零依赖的 vanilla DOM）：

| 参考 | 借了什么 |
|---|---|
| [xyflow/xyflow](https://github.com/xyflow/xyflow)（React Flow / Svelte Flow） | 节点编辑器的通用范式：拖动、框选、缩放平移、右键菜单的分工 |
| [joakimsandqvistdev/ionodes](https://github.com/joakimsandqvistdev/ionodes) | 明确说「视觉灵感来自 Unreal Engine Blueprints」的一个具体实现 |
| [node-based-ui topic](https://github.com/topics/node-based-ui) | 这类界面还有什么常见做法 |
| [Blueprint Editor Tips and Tricks](https://www.unrealengine.com/blog/blueprint-editor-tips-tricks) | 官方对「什么操作该即时生效」的取向 |

**改成了什么**（核心就一句：**松手即写盘**）：

1. **删掉「确认挪动」整条链路**：不再调 `/quest/move/preview`，不再有 `state.movePlan`、`moveCard()`。松手 → `commitMoves(moves)` → 乐观改本地坐标（视觉立刻落位）→ `POST /quest/move/apply` → 重新读画布。
2. **多选一起挪**：`selSet` 数组。拖任意一个已选中的节点，所有选中的节点一起动，松手一次请求带多条坐标（`/quest/move/apply` 的 `moves` 本来就支持数组）。
3. **空白处拖动 = 框选**（`.mcs-band` 虚线框，位移 < 6 像素不算拖动，纯点击空白 = 清空选择）；**中键拖动 = 平移画布**；**滚轮 = 绕鼠标点缩放**（`0.35–2.5`）；**空白处双击 = 在那个位置新建任务**（坐标由鼠标位置反算）。
4. **撤销 / 重做**：`undo` / `redo` 两个栈（上限 30）。撤销就是「拿栈顶那批 from 坐标再发一次 apply」—— 复用同一个写接口，不新增后端。快捷键 `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`，右栏有一条 `undoBar()` 常驻显示「上次挪动：…」+ 撤销按钮。
5. 底部一行提示把六个手势写清楚，用户不用猜。

**后端一行没改**：`/quest/move/apply` 本来就接受多条、先备份再写、写完重读体检、有问题 `restoreFiles` 整体回滚 —— 所以「松手就写」是安全的，最坏情况是整体回滚 + 弹错误。

**插件面板同步改了**（`lib/client.js`）：原来攒 `canvasPending` + 卡片「保存这次挪动」，改成 `putNode()` 里直接 `commitMove([...])`，`canvasPending` / `canvasPreview` / `canvasApply` / `canvasReset` 全部删掉；`canvasDone` 卡里加「撤销这次挪动」。

**踩到的三个坑**：

1. **`beginBand` 里直接引用 `canvasSvg` 的闭包变量 `byId`/`px`/`py` → `ReferenceError: byId is not defined`**。改成把 `{ byId, px, py }` 当第四参传进去（`ctx.byId` 等）。
2. **测试假 `fetch` 返回同一个对象引用**：前端乐观改坐标把假数据也改了，后面的用例全被污染（表现为双击坐标从 `3.5` 变 `4.5`）。假 `fetch` 必须每次 `JSON.parse(JSON.stringify(body))` 深拷贝。
3. **插件侧 `undo` 不能放 `useRef`**：界面要根据它决定「撤销」按钮出不出，而 `useRef` 改了不触发重渲染；测试替身的 `useRef` 更是每次渲染返回新对象，直接读到空。改成 `useState`。
4. 另外 `loadCanvas()` 内部会 `setCanvasDone(null)`，所以 `commitMove` 里必须**先 `await loadCanvas()`、再 `setCanvasDone(r)`**，顺序反了「挪好了」的提示会被立刻抹掉。

**测试**：`test/ui-app.test.mjs` 4 → 8 条（拖动直接写盘且不调 preview / 挪完能撤销 / 框选多个一起拖 / 空白处双击新建）；`test/client-quest-ui.test.mjs` 13 → 14 条（插件侧同样的「松手就落位」）。全量 **41 套件 / 593 条全绿**。

### 6.7 连线实时跟随 + 拖动不留黑框（2026-10-31 深夜）

**用户原话**：「1.连接的线不能实时变化 2.在画布上会有黑框出现，要等放置后，黑框才会消失，是刚开始申请的空间大小不够吗」

**问题 1：连线不跟着动。** 原因是拖动只改了节点 `<g>` 的 `transform`（纯 DOM 操作，不重渲染），而连线是建画布时按坐标算好的 `<line>`，坐标不会自己变，所以整条线要等松手、重新读画布才更新。

修法：建画布时把每条线的「两端是谁 + 原始坐标」存进 `state.edgeEls`（`{el, fromId, toId, x1, y1, x2, y2}`）；拖动时调 `shiftEdges(ids, dx/scale, dy/scale)`，只改和拖动节点相连的线，而且**每次都按「原始坐标 + 位移」重算**（不是累加），所以不会越拖越偏。松手时 `shiftEdges(ids, 0, 0)` 复位，紧接着 `commitMoves` 重新读画布，画出来的就是磁盘真值。

**问题 2：黑框。** 不是「空间申请不够」，是两个渲染层的毛病：

1. **根 `<svg>` 自己被 `transform` + `will-change: transform`**：浏览器会把整个 svg 提升成合成层，拖动时旧位置有时不被重绘，屏幕上就留一块黑。修法：平移缩放**改作用在内层 `<g class="mcs-viewport">`**（`state.viewportEl`），`applyView()` 不再碰根 svg，并删掉 `.mcs-canvas svg` 上的 `will-change`。
2. **SVG 里的 `<image>` 会被浏览器当成可拖的图片**：一拖就起原生拖拽，拖出一个黑方块幽灵，松手才消失。修法：`<image>` 加 `draggable="false"`、CSS 给 `.mcs-canvas` 加 `user-select:none` / `-webkit-user-drag:none`、给 `.mcs-canvas image` 加 `pointer-events:none`（点图标等于点节点），并在 svg 上挂 `dragstart → preventDefault()`。
3. 顺带：`.mcs-canvas svg` 加 `overflow: visible`，节点拖出画布数据范围时不会被 svg 自己裁掉（裁掉看起来也像「凭空少一块」）。

**测试**：`test/ui-app.test.mjs` 8 → 10 条。新增两条钉死这两件事：

- 「拖动时连线跟着走」：选中任务甲（先点一下，避免上一个用例的多选残留一起拖）→ 重画后再找 `line.mcs-edge` → 记下四个坐标 → `pointerdown` + `pointermove(132, 0)`（**先不松手**）→ 断言起点 `x1` 正好 +132、`y1` 不动、另一端 `x2/y2` 完全不变。
- 「平移缩放落在内层 `<g>` 上」：断言根 svg 的 `style` 里**没有** `transform`、`mcs-viewport` 层上有 `transform`、svg 上挂了 `dragstart`、图标 `draggable === 'false'`。

**全量**：`node lab/_run-all.mjs` → **41 套件 / 595 通过 / 0 挂**。静态资源实测 `app.js` 200 / 52787 B、`style.css` 200 / 11190 B。

**插件面板不用改**：`lib/client.js` 的画布是 React 状态驱动，`onPointerMove` 里 `setCanvasPos` 会触发重渲染，连线本来就是实时重算的。


### 6.8 多选一起挪 + 「向左侧吸引」的真凶（2026-10-31 更晚）

**用户原话**：「选中多个任务，没法一起挪动，原因可能是默认向左侧吸引」

**不是「吸附」**。`snap()` 只是 `Math.round(v * 2) / 2`（吸到半格），没有夹取、也不往左拉。真凶是两件事叠在一起：

1. **拖完那一下 `click` 把多选收成了单选。** 浏览器在 `pointerup` 之后必然补一个 `click`，而 `click` 的处理是 `selectQuest(id)` → `state.selSet = [id]`。于是「拖完松手 → 选择只剩一个 → 再拖就只有一个动」。修法：`state.suppressClick` 开关，`onUp` 里真拖动过就置真，`click` 一进来先消费掉这个开关并直接 return；按住 Ctrl / Cmd / Shift 点击则走新的 `toggleSelect(id)` 加选/减选。
2. **画布原点跟着包围盒漂。** `canvasSvg()` 的坐标原点是「所有节点包围盒的左上角」（`minX/minY`）。把最左边的任务往右挪一格，`minX` 就 +1，于是**整张图在屏幕上整体左移一格** —— 看起来就是「被吸到左边」，而且是没动的那些任务在跳。修法：记住上一次的 `state.canvasOrigin`，重画时按 `screen = tx + (X - minX) * CELL` 反解出补偿量 `tx += scale * (minX - origin.x) * CELL_X`（`ty` 同理），再更新 `canvasOrigin`。切换项目时（`connect()`）置空。

**顺带加的**：底部提示补「或 Ctrl/Shift+点击加选」；`beginDrag` 开头把 `suppressClick` 复位（防御性）。

**测试**：`test/ui-app.test.mjs` 10 → 13 条：

- 「Ctrl+点击 能加选」：单选甲 → `click({ctrlKey:true})` 点乙 → 右栏出现「选中了 2 个任务」。
- 「多个选中一起拖完，选择还在」：拖完 `dragBy` 会补发一次 `click`（**测试替身必须模拟真实浏览器的这个行为**，否则 `suppressClick` 跨用例残留、把下一个用例的点击吞掉）→ 断言一次请求两条坐标、且「选中了 2 个任务」还在。
- 「把最左边的任务往左挪，其他任务在屏幕上不该跟着跳」：读 `mcs-viewport` 的 `translate` 与节点 `rect.x`，算出未移动节点的屏幕横坐标，拖前后必须相等。

**全量**：`node lab/_run-all.mjs` → **41 套件 / 598 通过 / 0 挂**。


---

## 7. 关键设计决策（每条都带理由）
1. **后端不重写**：`core` 11961 行是纯 Node，这是这个项目最贵的资产。重写等于把 553 条测试和 23 章踩坑记录全部作废。
2. **前端重写、不硬搬**：`client.js` 用 `window.__ModuleLoader__` 注册、靠 DSH 的 `slots` 挂载、用 DSH 主题 token 上色。把 DSH 运行时一起塞进独立软件，等于给自己造一个更差的宿主。
3. **写操作永远 plan → apply**：预览只算不写、apply 才落盘，且 apply 前自动备份、写完复验、失败整批回滚。这套在插件里已经验证（`write.js` / `restoreFiles` / `newErrorsOf`），直接继承。
4. **长任务一律 job 化**：下载、索引、打包、启动、图标导出都进队列，UI 只订阅事件。这样"关窗口不丢进度"是免费的。
5. **缓存分层落盘**：索引缓存（按 jar 的 mtime+size 判失效）、图标缓存（data URL 落成 png）、MC百科缓存。Mechanomania 索引 550ms 还能接受，但取全量图标要 7.7 秒，必须缓存。
6. **图标策略分五级**：`textures/item` 直读 → 方块模型等轴测渲染 → 平铺贴图兜底 → MC百科按需单张 → 游戏内导出（可选，覆盖率最高但要求进游戏跑一次）。
7. **不启动游戏也能干活**：除了 S7 验证，其余全部静态解析。要明确告诉用户"启动验证会开一个游戏窗口，约 20 秒"。
8. **不假设管理员权限**：写盘前检查目标目录可写（Windows 上还要看完整性级别，见 §8 第 3 条）。

---

## 8. 必须继承的坑（从 HANDBOFF 提炼，按"会让人卡半天"排序）

1. **子进程管道会 EPERM**（Windows 沙箱/受限进程）：`execFile` 收安装器输出、`spawnSync java -version`、`where java` 判状态，三种写法都会静默死。唯一可用形状：`fs.openSync(log, 'w')` → `stdio: ['ignore', fd, fd]` → 结束后 `readFileTail`。**别挂 `child.stdout`。**
2. **Forge 版本列表是 XML**，不是 JSON；BMCLAPI 不代理 Forge 的 maven。
3. **Windows 完整性级别**：目录从别处搬进来会保留 Medium，而受限进程只能写 Low 标签的目录 → `EPERM`。解法 `icacls <dir> /setintegritylevel (OI)(CI)Low /T`。
4. **样式变量写错不报错、只静默失效**（这一轮的配色事故）。独立软件用自己的 CSS 变量，但**仍要写守卫测试**：断言用到的变量都在定义表里。
5. **SVG 的 presentation 属性不吃 `var()`**（`fill="var(--x)"` 静默无效），必须 `style={{ fill: 'var(--x)' }}`。
6. **PNG 位深/通道**：行宽 = `ceil(width * channels * bitDepth / 8)`，bpp = `channels*bitDepth/8`；4 位调色板图（`water_still.png`）按 8 位算会整张错位。
7. **动图（竖排）必须裁首帧**：`height > width && height % width === 0` 判动图，只留前 `width` 行。不裁就是"熔岩图标被压扁"那个 bug。
8. **模型贴图引用可能不带命名空间**（`textures: { all: 'block/tnt_side' }`），要补当前命名空间，否则整张模型画不出来。
9. **平铺贴图会抢在模型渲染之前命中**：先只认 `textures/item`，再模型渲染，最后才平铺兜底。
10. **只有 `elements` 才能渲染**：blockstate 只是指路牌（`variants` / `multipart[].apply` → 第一个 `model`），模型链要顺 `parent` 合并。
11. **FTB 任务书 lang 键只认正好 3 段**（`item.ns.name` / `block.ns.name`）：变体键（tooltip、`%s` 模板）会盖掉正名，还造幽灵物品。
12. **中文名来源**：mod jar 的 `assets/<ns>/lang/zh_cn.json` + 原版 `<mcRoot>/assets/objects/<hash>`（客户端 jar 里只有英文）。
13. **Java 用 Mojang 官方运行时分发**：`all.json` → `java-runtime-gamma`（17.0.15，403 文件 86.9 MB）；别下 Adoptium。
14. **下载要补遍 + 清单重试**：网络会随机掐 TLS；`retry` 与 `resume` 都要有。
15. **打包的 PCL 兼容三条**：路径字符不能有怪符号、包裹层数只能一层、`versions/<名>/<名>.json` 必须存在。
16. **KubeJS 脚本先沙箱试跑再落盘**，别写完才发现语法错。
17. **索引要缓存**：10386 物品 550ms，每次请求重建会卡死界面。
18. **MC百科有反爬**：请求间隔 600ms、搜索单独 2.5s、撞频率限制进 60 秒冷却；结果必须落盘缓存。
19. **DSH 沙箱用 job 对象管子进程**：命令一结束整棵树被回收，`detached + unref` 也留不住。所以「服务常驻」在这沙箱里验证不了 —— 用户从资源管理器双击时不在 job 里，那才是真实场景。
20. **VBS 的字符串转义是「两个双引号」**：`"node ""path""""` 这种嵌套必算错（报 `Unterminated string constant`），一律用 `Chr(34)` 拼。

（完整的 60+ 条在 `docs/archive/HANDBOFF.md` §7 / `docs/archive/HANDOFF-NEXT.md` §7，按坑号查。）

---

## 9. 验收标准（独立软件版）

- [ ] 双击 exe → 3 秒内出窗口；不需要用户装 Node，Java 由软件自己下。
  - 阶段性状态（2026-10-31）：**双击 `.lnk` 已经能用了**（方案 A，隐藏黑框 + 自动开浏览器，实测约 300ms 就绪），但仍需要本机装 Node；「不用装 Node + 3 秒出窗口」要等方案 C（Electron）。
- [ ] 拖一个整合包目录进窗口 → 10 秒内出体检报告（版本、加载器、mod 数、缺前置、冲突）。
- [ ] 改一条配方：预览 → 写入 → 撤销，三步都能看到 diff 和备份。
- [ ] 蓝图：拖动、右键、增删任务，行为与游戏里的 FTB 编辑器一致。
- [ ] 打包三形态，PCL2 真装真启动到主菜单（这是硬标准，插件里已经过了，别退步）。
- [ ] 长任务（下载 / 打包 / 索引）可以关窗口，重开后进度还在。
- [ ] 断网、路径不存在、jar 损坏这些情况给中文人话错误，不白屏、不弹"未知错误"。

---

## 10. 风险与取舍

| 风险 | 影响 | 应对 |
|---|---|---|
| 前端重写是最大工作量 | 3345 行逻辑 + 交互细节，估 1–2 周 | 先做只读浏览（S2/S3 只读），再做写操作；蓝图逻辑直接抄现有几何与吸附 |
| Electron 体积 ~150 MB | 用户可能觉得大 | 可先发"本地服务 + 浏览器"版，再补壳 |
| 启动验证涉及子进程/内存 | 在 Electron 里要管理 Java 生命周期 | 沿用 `proc.js` 的 `stdio:['ignore',fd,fd]` 形状，日志落文件再读 |
| 前端没有测试体系 | 回归全靠手点 | 引入 Playwright 跑三条主链路（连包/改配方/打包） |
| 两条线分叉（插件 + 独立） | 修一个 bug 要改两处 | **强制共享 `packages/core`**；插件侧只留 tools 薄壳 |
| 磁盘占用（offline 包 886 MB） | 用户磁盘吃紧 | 打包前显示预估体积，默认 standard |

---

## 11. 需要拍板的三个决定

1. **壳**：Electron（推荐，最省事）还是 Tauri（体积小但复杂）还是先只做浏览器版？
2. **前端语言**：TypeScript（推荐）还是沿用现在的 JS？
3. **DSH 插件去留**：保留成"工具入口 + 打开工作台"（推荐，模型仍能在对话里改包）还是冻结不再维护？

---

## 12. 交接清单（新会话从这里开始）

**先读**（按顺序，别通读 150 KB）：
1. 本文（你正在读的）；
2. `docs/archive/HANDBOFF.md` 的目录 + §1（总体设计）+ §2（模块地图）；
3. 要动图标就看 §20–§23；要动 Java/启动就看 §13。

**先跑**：
```powershell
# 全量回归（41 套件 / 598 条）
node lab/_run-all.mjs

# 起独立服务、打一遍代表性接口（17 条）
node lab/_probe-server2.mjs
```
（不要用 `node --test`，这个沙箱里会 `spawn EPERM`。）

**第一批动作（建议按这个顺序，别跳）**：
1. ~~P0：把 `lib/core` 搬成 `packages/core`，修掉 `searchItems` 破口，确认 553 条在新位置跑绿~~ —— **已完成**，见 §6.1；
2. ~~P1：写 40 行 HTTP 适配器替换 `connection.fetch.register`，`curl` 打通 41 条接口~~ —— **已完成**（17 条代表性接口实测全通，7 条单测），见 §6.2；
3. ~~P2：前端「连包 → 体检 → 物品表 + 图标」~~ —— **已完成并重做成三栏工作台**（见 §6.4），写操作（改配方/改任务/拖位置）也都接上了；
4. ~~P2.5：桌面双击启动（方案 A）~~ —— **已完成**，见 §6.5；
5. **接下来**：补 P2 还没接的五块（改配方、从零装底座、从零建包、打包、启动验证进 `packages/ui`），然后 P3 工作流引擎；
6. **最后**：P4 桌面壳（Electron），把方案 A 换成方案 C。

**当前基线（2026-10-31 收尾）**：`41 个套件 / 598 条全过`。跑法见 §12。

**下一步从哪开始**：`packages/ui/app.js` 里给「内容」和「打包」补两个面板（后端接口 `/recipe/preview|apply`、`/export/preview|build` 都已经在），照 `draftCard()` / `planCard()` 那套两态卡写。图标接口是 `/item-icons`（POST，`{dir, ids}`），一次最多几十个 ID。

**别做的事**：
- 别重写 `lib/core`（553 条测试和 23 章坑都在里面）；
- 别把 DSH 运行时塞进 Electron（`__ModuleLoader__`、slots、主题 token 全都不要）；
- 别在没有备份机制的情况下加任何写操作。
