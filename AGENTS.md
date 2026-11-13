# 给接手的人（和 AI）看的工作约定

## 最重要的一条：全程用中文

**跟用户说的每一句话都用中文**，包括解释、计划、进度、结论、报错说明。
用户已经反复强调过很多次（最近一次：2026-10-29）。

- 不要写英文段落、英文标题、英文小标题。
- 代码注释也用中文。
- 代码标识符（变量名、函数名、文件名、API 名、工具名）保持英文，这是代码，不用翻。
- 例外：用户明确要英文内容时（例如帮写英文邮件）才写英文。

判断标准：用户打开对话，看到的应该是通顺的中文，偶尔夹几个必须保留的英文技术名词。

## 用户是谁

不熟悉 Minecraft mod 和整合包的制作流程。所以：

- 少用术语。必须用术语时，先用一句大白话解释。
- 不要假设用户知道「加载器」「命名空间」「配方类型」「数据包」是什么。
- 讲结果先讲「你现在能干什么」，再讲「怎么做到的」。

## 这个项目在做什么

桌面应用 `minecraft-modpack-studio`（独立 Electron 软件）：给 Minecraft 整合包做「工作室」。
四条主线（用户亲自定的验收标准）：

1. **图形化修改** —— 在软件界面里点着改。
2. **代码修改** —— 让模型写 KubeJS / 改文件（通过软件内置的 MCP 服务器）。
3. **从零做整合包** —— 从选版本开始搭出一个能玩的包。
4. **改已有整合包** —— 读现有的包，改配方、任务书、打包。

代码结构：`packages/core/` 是核心能力（纯函数，好测）、`packages/ui/` 是界面、
`packages/desktop/` 是 Electron 外壳、`lib/host/` 是界面与核心之间的接口层。

## 硬约束（不能违反）

- 用户的整合包、存档、配置**默认只读**。要写测试就复制一份到临时目录再动。
- 不删用户文件，不改存档名。
- MC 版本不写死：1.20.1 Forge 和 1.21.1 NeoForge 都要能跑。
- 配方魔改走 KubeJS；任务书用 FTB Quests。
- 导出三形态：standard / offline / launcher，验收标准 = PCL2 能装能开，启动到主菜单。
- 所有写操作的工具一律 **plan（只算不写）→ apply（真写）** 两态。
- 「点界面改」和「让模型改」必须走同一套底层函数（`packages/core/*`），不能各写一套。

## 怎么跑测试

```powershell
node --import ./test/register.mjs test/<套件>.test.mjs
```

**必须**带 `--import ./test/register.mjs`：
- 它把 `@deepseek-ai/dsh-tools` 解析到 `test/stub-dsh-tools.mjs`（否则模块找不到）。
- 不要用 `node --test`，在这个沙箱里会 `spawn EPERM`。

`test/kubejs.test.mjs` 用的是自定义统计格式（`N 通过 / N 失败`），聚合结果时要单独匹配。

## 其它注意

- 这个目录 **2026-11-13 起已经是 git 仓库**（`git log` 有历史、`git diff` 能看改动）。
  但初始提交只有一次快照，别指望 `git checkout` 能救回一整轮改坏的东西 ——
  大改之前先 commit，别攒一堆改动再一起提交。
- PowerShell 直接 `Get-Content` 读 UTF-8 中文会乱码，读文件用编辑器/read 工具。
- `npm` 在 PowerShell 下被 ExecutionPolicy 拦；`npm pack` 又因缓存目录在工作区外报 EPERM。发布前用 `Test-Path` 手工核对 `package.json` 的 `files`。
- **接手先读 `docs/HANDOFF.md`**（写给新会话的施工单：按什么顺序做、动哪个文件的哪一行、接口长什么样）。
- 历史档案在 `docs/archive/`，**已冻结、不要再续写**：`HANDBOFF.md`（32 章技术细节）、`HANDOFF-NEXT.md`（插件侧行动清单，已作废）、`HANDOFF-STANDALONE.md`（独立软件方向与来历）。
- **文档规矩**：每轮只维护 `docs/HANDOFF.md` 一份——做完的事压成几行写进它的 §11 历史纪要，待办更新 §3。**不要新建 `HANDOFF-V3.md`，也不要往 `docs/archive/` 里追加。**
