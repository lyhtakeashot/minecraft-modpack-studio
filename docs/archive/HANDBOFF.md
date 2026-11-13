# HANDBOFF — dsh-mc-modpack-studio 插件开发转接文档

> 🗄️ **本文件已冻结（2026-11-01）**，只供溯源，不要再往里追加内容。
> 当前施工单是同项目的 [docs/HANDOFF.md](../HANDOFF.md)。


> 交付对象：下一个在 **cordis 预设（创造模式）** 里干活的 agent
> 作者：lead（调研 agent）
> 日期：2026-10-28
> 工作目录：`D:\Desktop\VibeCoding\dsh-minecraft-modpack-studio`
> 状态：需求已确认到 ~90%（2026-10-28 三轮核对后自评，见 §12），技术底座已全部实测通过，**可以开工**；**2026-10-31 现状**：29 个工具 + 41 条界面接口 + 侧边面板已全部落地（蓝图排在最前、节点右键即可编辑、配色已按主题 token 重做、换图标能打中文搜物品且**一打开就列一屏**、输入法回车不再被抢），1.21.1 NeoForge 与 1.20.1 Forge 两个版本都能从零装出包并真启动到主菜单，测试 **41 套件 / 598 条全绿**；**core 已抽成独立包 `packages/core`（`lib/core` 已删），并加了独立版本地 HTTP 服务 `packages/server`，浏览器端已重做成三栏工作台**（选项目页 → 左 mod 列表 / 中任务蓝图 / 右任务检查器，见 §25 / §26，方向见 `docs/archive/HANDOFF-STANDALONE.md`），**桌面双击启动（方案 A）已做完（§27），蓝图拖动改成「松手即落位」并加了框选/缩放/撤销（§28），拖动时连线实时跟随、拖动不再留黑框（§29），多选能一起挪、画布不再「向左侧吸引」（§30）**。本章之后的变化见 §13–§31；图标按「2D 物品图 → 模型等轴测渲染 → 平铺贴图」的顺序取，见 §23。
> 核对记录：原文（"lead" 第一稿）里若干数字在 2026-10-28 被重跑探针推翻并已改正，改动都在文中用 **⚠️ 2026-10-28** 标出，**以标注后的为准**。
>
> 📌 **开工前先读 `docs/archive/HANDOFF-NEXT.md`**（同目录，约 60 KB）。那份是**行动文档**：现在做到哪一步、哪些工具已能用、接下来具体做什么。本文件是**证据文档**（为什么这么做、数字怎么测出来的），写代码时可以按需回来查。
>
> ⚠️ **2026-10-31 方向变更**：用户决定把本项目做成**独立桌面软件（完整工作台 + 工作流）**，DSH 插件降为次要。新的主线与迁移计划在 **`docs/archive/HANDOFF-STANDALONE.md`**，**接手先读那一份**。本文件继续有效——它是"为什么这么做"的完整证据链，独立软件的后端（`lib/core` 11961 行）就是从这里长出来的。
>
> 🧭 **2026-11-01 施工单**：独立软件剩下的五块（工作流层 / 改配方 / 打包 / 从零装底座 / 启动验证）按什么顺序接、动哪个文件的哪一行、接口签名长什么样，全写在 **`docs/HANDOFF.md`**。要动代码就先读那份，本文件按需回来查证据。

---

## 0. 一句话任务

在 DSH 里做一个名为 **`dsh-mc-modpack-studio`** 的插件，把「我的世界整合包制作」的全链路（选题 → 选 mod → 魔改配方 → 写任务书 → 校验 → 打包成懒人包）做成模型可调用的工具，让用户**用一句话就能让 Agent 干活，关键步停下来问**。

---

## 1. 用户的原始需求（m00001 原话，逐字）

> 我现在想要将我的世界整合包制作的全链路在dsh上通过插件打通，有什么好的建议吗？制作的整合包里会有任务书的制作、合成表的魔改等任务，我现在找到两个现成的插件但都无法完全做到链路打通，一个是dsh-tool-modpack，另一个是minecraft-mod-mcp-server。如果你能找到更好的插件参考也可以告诉我，先调查一下，向我明确任务需求，直到90%理解我的需求，写转接文档交给下一个agent在创造模式里制作插件

拆出的三件事：
1. **调查** → 已完成（见 §3）
2. **确认需求到 90%** → 已完成（见 §2）
3. **写转接文档给下一个 agent 在创造模式做插件** → 本文档

---

## 2. 已确认的需求（全部来自用户实际回答，不是我的推测）

### 2.1 环境与版本

| 项 | 用户确认 | 备注 |
|---|---|---|
| MC 版本 + 加载器 | **两者都支持，不写死** | 第一轮用户选了 1.20.1 Forge；但我扫他的真实整合包发现**都是 1.21.1 + NeoForge**。用户最终选择「两者都支持，不写死」 |
| 数据来源 | **本地解包（配方/物品真相） + 联网元数据（找 mod/版本/依赖）双层** | ~~原为「只解包、否决 Modrinth API」。2026-10-28 用户改口：想要联网查 mod 元数据。详见 §2.8 / §4.8~~ |
| Java / 启动 | **必须真启动一次，验收线 = 主菜单** | ~~原为「先不管启动」。2026-10-28 用户改口。详见 §2.8 / §4.9~~ |

**真实整合包实测事实（重要，架构必须适配）：**

```
D:\pcl2\PCL 下载\整合包\atm10sky\        ← 包 A
  ├─ assets\  libraries\  versions\  launcher_profiles.json  PCL.ini
  ├─ .minecraft\global\
  └─ versions\All the Mods 10：To the Sky   ATM10SKY\
       ├─ All the Mods 10：To the Sky   ATM10SKY.json   (75,633 B)
       ├─ All the Mods 10：To the Sky   ATM10SKY.jar    (26,836,906 B ← 原版客户端 jar)
       ├─ mods\          (326 个 jar)
       ├─ config\ftbquests\quests\   (52 章节 / 3658 任务 / 4 分组)
       │    ├─ chapters\*.snbt   chapter_groups.snbt   data.snbt   reward_tables\
       │    └─ lang\{en_us,zh_cn,pt_br,ru_ru,es_es}\  (zh_cn.snbt 1,020,272 B)
       ├─ kubejs\server_scripts\      (74 个 .js)
       └─ 中英对照版任务\             ← 非标准目录，用户手工放的

D:\pcl2\PCL 下载\整合包\重度机械症\      ← 包 B
  └─ versions\Mechanomania\  (183 jar, 18 章节 / 395 任务 / 3 分组, 17 个 .js)
       └─ versions\Mechanomania-航空学\  (187 jar，与主线存档不兼容)
```

- 两个包的 `<实例>.json` 都是：`mainClass = cpw.mods.bootstraplauncher.BootstrapLauncher`、`javaVersion.majorVersion = 21`、`assetIndex.id = 17`、`libraries` 144 项、**`inheritsFrom` 为空**（即版本文件是完整的，不依赖父版本）
- `<实例>.jar` 是原版客户端 jar（26.8 MB，SHA256 前缀 `499F6897D183`，两个包完全相同）
- **mods 绝大多数是 NeoForge，但读取不能只认一种文件**（2026-10-28 实测修正，原写「100% 是 `neoforge.mods.toml`」过于绝对）：183 个 jar 里 **181 个有 `META-INF/neoforge.mods.toml`、10 个有旧的 `META-INF/mods.toml`、7 个有 `fabric.mod.json`、2 个三种都没有**（`connector-2.0.0-beta.14+1.21.1-full.jar`、`kotlinforforge-5.11.0-all.jar`，属 loader 层不是内容 mod）。**modId 提取必须按 `neoforge.mods.toml` → `mods.toml` → `fabric.mod.json` 顺序回退**，只读 `mods.toml` 会掉到 12/183，两种 toml 都读实测可解析 **181/183**（剩 2 个无元数据属正常）。`tools/probe-real-pack.js` 当前只读 `mods.toml`，是**已知待修的探针缺陷**，实现时不要照抄。
- 关键 mod 版本：`kubejs-neoforge-2101.7.2-build.348`、`ftb-quests-neoforge-2101.1.21`、`rhino-2101.2.7-build.81`、`create-1.21.1-6.0.10`
- 用户说：「文件放置的逻辑有点混乱，**暂时先不要整理**」→ 工具必须能容错、不能假设标准 CurseForge 布局

### 2.2 工具栈锁定

| 项 | 用户确认 |
|---|---|
| 配方魔改 | **KubeJS**（脚本，热重载方便） |
| 任务书 | **FTB Quests**（SNBT 格式） |
| 交互方式 | **自然语言说需求，Agent 自动干活，但关键步停下来问我** |
| 工具粒度 | **混合**：读用**小颗粒**（细粒度查询），写用**「计划 → dry-run → apply」大颗粒**（一次调用完成一整步，但必须先给 diff） |
| 交付形态 | **先做本地插件**，用户后续自己 git 到 GitHub |

### 2.3 工作起点：两种都要（完整全链路）

- **`mode: 'new'`** 从零新建：选题 → 选 mod → 拉 jar → 建目录结构 → 写任务书 → 导出
- **`mode: 'edit'`** 在已有包上魔改：读取 → 改 KubeJS 配方 / 加任务章节 / 校验 ID → 导出新包

### 2.4 导出：三种形态都要，导出时选

用户原话：「我不清楚pcl是怎么打包的，最终的产物是一个能直接交给pcl解压运行的懒人包」+「而且要能直接把 java 和我的世界一起打包进去，就像 pcl 一样」，最终选「三种都支持，导出时选」。

**PCL2 源码实测（`ref/PCL2-ModModpack.vb`，55,402 B / 866 行，`ModpackInstall` 在 :31-115）：**

PCL 按包根（或一级目录）的哨兵文件判型：

| PackType | 哨兵文件 | 含义 |
|---|---|---|
| 0 | `manifest.json` 且**无** `addons` 键 | CurseForge |
| 1 | `modpack.json` | HMCL |
| 2 | `mmc-pack.json` | MMC / Prism |
| 3 | `mcbbs.packmeta`，**或** `manifest.json` 含 `addons` 键 | MCBBS（此时 `ArchiveBaseFolder` 强制 `overrides/`） |
| 4 | `modrinth.index.json` | Modrinth |
| **9** | `modpack.zip` 或 `modpack.mrpack` | **带启动器的压缩包** |
| Else | 都没有 | **普通压缩包** |

所以三种导出形态：

**A. `standard` — 纯 modpack 标准包（最小）**
只出 `manifest.json` + `overrides/`（CurseForge）或 `modrinth.index.json` + `overrides/`（Modrinth）。PCL 会走 0/4 分支，**需要联网下载 mod**。

**B. `offline` — 离线整包（推荐，最接近「懒人包」）**
外层 zip 里就是**完整 `.minecraft/`**：
```
<任意包裹文件夹>\          ← 最多一层
  ├─ PCL2\                 (可选，PCL 配置/皮肤)
  ├─ versions\<实例>\<实例>.json   ← 必须！这是 PCL 定位 .minecraft 根的哨兵
  ├─ versions\<实例>\<实例>.jar
  ├─ versions\<实例>\mods\  config\  kubejs\  ftbquests 相关...
  ├─ libraries\   assets\
  ├─ runtime\java-runtime-delta\   ← 用户要的「把 java 一起打包」
  └─ launcher_profiles.json  options.txt
```
PCL 走 `InstallPackCompress`（:826-859）：正则 `^.*\/(?=versions\/(?<ver>[^\/]+)\/(\k<ver>)\.json$)` 在 zip 条目里**逐条扫**定位 `.minecraft` 根 → 要求选**空文件夹** → 整包解压 → `PageSelectLeft.AddFolder(...)` 加进实例列表。**不下载任何东西，完全离线。**

⚠️ 硬限制：`TargetFolder.Contains("!") || TargetFolder.Contains(";")` 直接拒绝（:38、:844）；**不支持 rar**（:81-82）。

**C. `launcher` — PCL 官方推荐的启动器懒人包（带 UI 主题）**
```
外层.zip
  ├─ Plain Craft Launcher 2.exe    ← ProductName 必须 = "Plain Craft Launcher"
  ├─ PCL\  (主题/背景/音乐)
  └─ modpack.zip                    ← 真正的整合包包体（可以是 A 或 B 格式）
```
PCL 走 PackType 9 分支 `InstallPackLauncherPack`（:764-823）：选空文件夹 → 整包解压 → `DirectoryUtils.EnumerateFiles(TargetFolder, "*.exe")` 逐个读 `FileVersionInfo.ProductName`（等于 `"Plain Craft Launcher"` 优先；含 `Launcher`/`启动` 且 ≠ `"Plain Craft Launcher Admin Manager"` 次选）→ 弹窗「整合包里似乎自带了启动器，是否换用它继续安装？」→ 选「换用」则 `StartProcess(Launcher, "--wait")` 然后**当前 PCL 自杀** → 否则 `DirectoryUtils.Create(TargetFolder & ".minecraft\")` + `AddFolder(TargetFolder & ".minecraft\" & ArchiveBaseFolder...)` → 找 `DirectoryUtils.EnumerateFiles(TargetFolder, True, "modpack.*").First` 递归找 `modpack.*` 继续 `ModpackInstall`。

**Java 打包策略**（用户要求「像 PCL 一样」）：
- PCL 的做法不是打包 Java，而是**按版本自动下载**。我们要么拷本机 runtime，要么调 Adoptium API 拉 JRE。
- 本机现成可用：`C:\Users\lyh\AppData\Roaming\.minecraft\runtime\java-runtime-delta\`（含 `bin/conf/legal/lib/release`）
- 打包时放 `runtime\java-runtime-delta\`，并在 `PCL\Setup.ini` 里写 Java 路径，或让 PCL 自己扫（PCL 会搜 `runtime\`）
- Adoptium API：`https://api.adoptium.net/v3/binary/latest/{major}/ga/windows/x64/jre/hotspot/normal/eclipse`（major = 21 / 17 / 8）

### 2.5 规划层：三样都要「真算出来」

用户明确说「规划层要更重」，并且勾选了三项全部要真算：

1. **配方平衡：检测开环/断路**（删了配方但没补新路径）
2. **模组重叠度分析**（功能重叠/冗余检测）
3. **进度曲线**（任务数/难度按章节递增的数值约束）

### 2.6 验收清单（用户 6 项全选 + 5 项追加，全都要过）

| # | 验收项 | 怎么验 |
|---|---|---|
| 1 | SNBT 能被 FTB Quests 正常加载，开游戏不报错 | 用我们的 parser 双解析 + 结构等价断言，**并真启动一次到主菜单**（见 §2.8） |
| 2 | KubeJS 脚本无报错、配方生效 | node:vm 沙箱执行 + API 白名单 + 语法错误定位 |
| 3 | **所有引用的物品 ID 真实存在于 mods 里** | 三源索引 + 引用核对（已实测可行，见 §4.2） |
| 4 | 任务书依赖图无环、无悬空节点 | 图算法 + lint（已有可用实现，见 §4.3） |
| 5 | 整合包能一键导出成 zip / CurseForge 格式 | §2.4 三种形态 |
| 6 | **「我能用一句话让 Agent 新建一章 10 个任务的章节」** | 端到端自然语言测试 |
| 7 | 任务完成 → 解锁配方的联动（KubeJS 读 FTB 进度） | FTB XMod Compat 的 `FTBQuestsEvents` |
| 8 | 任务书文案润色（副标题/描述自动写） | 写 `lang` 的 `quest.<id>.quest_subtitle` / `quest_desc` |
| 9 | 「一句话改一个配方」的自然语言编译 | LLM → KubeJS AST → 校验 |
| 10 | 模组重叠度报告（真算） | §4.5 |
| 11 | 配方断路/开环检测（真算） | §4.5 |

### 2.7 命名与分发

- 插件名：**`dsh-mc-modpack-studio`**
- 先本地装（`dsh plugin add <path>` 或直接写 profile patch），后续用户自己 git 到 GitHub

### 2.8 第二轮核对结论（用户 2026-10-28 回答，覆盖文档旧假设）

| # | 议题 | 用户选择 | 对旧文档的影响 |
|---|---|---|---|
| 1 | 数据源 | **本地解包 + 联网元数据查询都要** | **推翻 §4 原「只解包本地 jar、否决 Modrinth API」** → 改双层设计，见 §4.8 |
| 2 | 版本/加载器 | 1.20.1 Forge + 1.21.1 NeoForge，**不写死** | 与原文一致，成本确认 1.5 天 |
| 3 | 写入粒度 | plan → dry-run → apply，**每步人工确认** | 与原文一致 |
| 4 | 任务书 | **FTB Quests 必须有，Better Questing 以后再说** | 范围收窄，P2/P3 不变 |
| 5 | 导出目标 | **只要 PCL2 能吃** | 与原文一致，§6.5 九条自检保持 |
| 6 | 验证方式 | **必须真启动一次**，验收线 = **进到主菜单** | **推翻原文「启动游戏先不管」** → 新增 P9，见 §4.9 |

**工期影响**：原文写的 8.5 天是算错的（P0~P7 逐项相加就是 9.5 天）。**实际：9.5 天 → 11.5 天**（联网层 +1.5、启动链路 +0.5——后者因 2026-10-28 已手工跑通而减半）。

---

## 3. 调研结论：为什么必须自研

### 3.1 `dsh-tool-modpack`（cyy13045/dsh-tool-modpack，npm `dsh-tool-modpack@0.1.1`，MIT）

**它是什么**：22 个 `modpack_*` 工具，7 阶段（规划 → 模组管理 → 配置内容 → 界面生图 → 本地化 → 测试 → 打包发布）。源码 `src/index.ts` 196,835 B（全在一个文件）、`ui-pack.ts` 36,903、`image-gen.ts` 35,786、`tester.ts` 30,515、`quest-gen.ts` 22,269。

**三个致命缺口（决定我们必须自研）：**

1. **没有「读取你实际整合包里有什么」的能力**。不扫 `mods/*.jar` 注册表、不解析已有配方、不做物品 ID 真实性核对 → 直接满足不了验收项 #3。
2. **quest-gen 是「从大纲生成」而非「编辑现有任务书」**。无 SNBT 反序列化回读、无增量增删改章节/任务、无依赖图校验。它 README 自己警告「发布后不要随意改任务标题或坐标，否则玩家进度会重置」——正因为它是整树重写。
3. **KubeJS 完全缺失**。22 个工具里没有任何 KubeJS 生成/校验；配方魔改只有 config-gen 的 snbt 深合并，覆盖不到 `ServerEvents.recipes`。

**但它有可以照抄的东西**：
- 插件骨架（`ref/dsh-tool-modpack/index.ts:122-133`）
- `cordis.patch.yml` 写法（全文 3 行，见 §5.1）
- peerDependencies 的宽范围写法（见 §5.2，**这是必踩的坑**）
- FTB Quests SNBT 的 ID 派生思路（内容确定性派生 16-bit hex）
- Modrinth 搜索/依赖解析（`resolver.ts` BFS + 环检测，最大深度 50）

### 3.2 `minecraft-mod-mcp-server`（实为 dcd887/minecraft-mcp-server）

**它是什么**：Cloudflare Workers MCP server，线上 `https://minecraft-mcp.mcjj.workers.dev/mcp`，14 个工具，纯算法离线生成，MIT。

**根本局限**：**只生成文本/代码，不读写磁盘、不碰真实整合包项目**。工具是 `generate_quest_chapter` / `generate_kubejs_shaped_recipe` / `validate_snbt` / `check_kubejs_errors` 这类纯字符串进出。

**可以抄的**：
- `generate_quest_chapter` 的 SNBT 模板形状（tasks/dependencies/rewards 三件套）
- `check_kubejs_errors` 的弃用 API / Rhino 兼容检查清单
- `generate_item_texture_path` 的 `assets/<ns>/textures/item/<path>.png` 规则
- 49 个离线单测的组织方式

同作者的 `mc-pack-builder-mcp`（本地 stdio，8 工具）依赖 Modrinth API，**没有 add/remove mod 的能力**，也不碰 KubeJS/FTB。

### 3.3 生态里其它参考（全部实测确认存在）

| 项目 | 价值 | 用法 |
|---|---|---|
| **`ftb-quests-preview@0.1.2`**（MIT，零依赖） | ★★★★★ **最有价值**。`server/snbt-edit.mjs` 的 **span-preserving 编辑**（只改目标 span，注释/格式/字段顺序原样保留）；`server/lint.mjs` 335 行完整 lint；`server/schema.mjs` 全字段表 | **直接抄思路 + 抄 schema + 抄 lint 规则**（本地已有一份在 `probe/ftbqp/`） |
| `ftbq-nbt@1.4.1` | 零依赖 NBT 编解码，`parse(text, {skipComma:true, useBoolean:true})` | **只用作只读快照/交叉校验**，不用来写（整树重写风险高） |
| `west3436/ftbquests-mcp` | 「live-server bridge mod + Claude Code 伴生插件」 | 未来做「游戏内实测」时的参考 |
| `dssh-minecraft-agent`（npm `dsh-minecraft-agent@1.1.0`） | 客户端桥路线：Forge mod `mcbridge-mod/` → `dsh-mc-bridge-1.0.0.jar`（33KB）→ 客户端内开 localhost:25577，写 `<gameDir>/dsh-bridge/status.json`。实测 207 jar / 247 mod id 的包能返回 `create:cogwheel`、`ae2:controller` 等真实注册名 | **未来「自动启动游戏实测」的现成参考**，它证明客户端桥可行 |
| `questspec@0.1.0` | Questbooks-as-code，deps 含 `@statelyai/graph` | 依赖图建模参考 |
| `minecraft-developing-mcp@0.1.15` | MCP stdio，覆盖 Java/KubeJS/datapack/resourcepack/Gradle | 边缘参考 |

**同名混淆警告（别搞错）**：`M1r0er/dsh-modpack`、`KERBALMans/dsh-modpack`、`@sakikoTGW/pack-agent`、`YuMo-233/dsh-kubejs`、`TFboy1/dsh-minecraft-ui`（DSHcraft UI 美化）——**全都与 MC 整合包制作无关**。

### 3.4 结论

> **DSH 插件生态里不存在现成的 MC 整合包制作插件，必须自研。**
> 在 26,083 条 dsh.so 注册表条目里 grep `minecraft|modpack|kubejs|ftb` 只有 1 条命中，还是同名比喻。

---

## 4. 技术底座：已实测通过的关键能力

> 全部有可运行的探针脚本，都在 `tools/`，**下个 agent 先跑一遍再写代码**。

### 4.1 ZIP 读取：纯 Node，零依赖，够快

`tools/probe-jar.js`（7,594 B）手写 ZIP 中央目录解析（找 EOCD `0x06054b50` → 遍历 central directory header `0x02014b50` → 读 local header 偏移 → `zlib.inflateRawSync`）。

**实测（真实整合包，2026-10-28 三次复跑取区间）**：
- `Mechanomania`：183 jar / 335 MB / 141,264 条目；**仅扫中央目录 117–125ms**；**跑完整三源索引（读 lang + models + 配方 JSON）236–255ms（配方正则修正前）/ 376–384ms（修正后，因为多解了 1 万个单数 `recipe/` 文件）**；RSS 177 MB。原文写「671ms（3.7ms/jar）/ RSS 128 MB」偏保守，实测更快，不影响结论。
- `create-1.20.1-6.0.8.jar`（18.3MB / 12,338 条目）：read 5ms + zip 8ms + scan 2ms = **15ms**

→ **200 jar 的整合包全量索引约 0.4 秒，完全可接受，不需要缓存层（但建议加，因为 §4.2 的三源合并还要解 JSON）**。

**坑**：不能依赖 `adm-zip` / `yauzl`（用户要求减少依赖；实测手写只需 ~40 行）。

### 4.2 物品 ID 索引：三源合并，无需启动游戏 ★核心

`tools/probe-id-coverage.js`、`tools/probe-id-precision.js`、`tools/probe-real-pack.js`

**三个证据源（Create 6.0.8 实测数据）：**

| 源 | 规则 | Create 命中 | 精度 |
|---|---|---|---|
| **A. lang** | `assets/<ns>/lang/{en_us,zh_cn}.json` 里键形如 `item.<ns>.<path>` / `block.<ns>.<path>`，**path 必须恰好 1 段**（不能含 `.`） | item 99 + block 643 = **742** | 排除 tooltip 子键 163 个（形如 `block.create.clipboard.tooltip.summary`）——不按 1 段过滤会严重污染 |
| **B. 物品模型** | `assets/<ns>/models/item/<path>.json` | **775** | 高（有模型基本就有物品） |
| **C. 配方产物** | `data/<ns>/recipe(s)/**/*.json` 的 `result` / `result.item` / `result.id` / `results[]` | 1766 份配方 → 去重 **550** | 中（541/550 被 A/B 佐证，9 个仅配方证据且都是 `minecraft:`） |

- **并集 839**（A 唯一 740 / B 775 / C 550；A∪B 已 830，C 只净增 9）；实测 `create:cogwheel` / `shaft` / `andesite_alloy` / `crushing_wheel` / `zinc_ingot` 三源全命中；`create:not_a_real_item` 三源全不命中。
- **必须把原版 jar 也索引进去**：`versions/<实例>/<实例>.jar` 提供 `assets/minecraft/lang/*.json`、`models/item/*.json`（1754 个）、`data/minecraft/recipe(s)/*`。实测（修正配方正则后）原版 jar 自身并集 2,817，其中 **2,468 个是 mods 侧没有的新 ID**（349 个被 mods 侧覆盖）。不索引原版 jar 会出现大面积 `minecraft:stick` / `minecraft:lava` / `minecraft:elytra` 假阳性。
- **实测总量（2026-10-28 修正后口径）**：`Mechanomania` = mods **10,123**（A lang 7,815 / B models 7,896 / C 配方 4,735；A∪B 已 9,447，配方净补 676）+ 原版净增 **2,468** = **12,591**，耗时 384ms。
  - ⚠️ **原文写的「mods 9,447 + 原版 2,813 = 12,260」是用带 bug 的探针算出来的**（只匹配复数 `recipes/`，在 1.21.1 上源 C 完全没生效）。修正后应是 12,591。这两个数字都要记住：**12,260 = 旧探针口径，12,591 = 正确口径**。

**⚠️ 1.21.1 的目录名是单数 `recipe`，1.20.1 是复数 `recipes`！**
```
1.20.1: data/<ns>/recipes/**/*.json
1.21.1: data/<ns>/recipe/**/*.json     ← create-1.21.1-6.0.10.jar 实测确认（1990 个在 recipe/）
```
正则必须写成 `data\/[^/]+\/(?:recipes|recipe)\/`。**这是本项目最容易踩的坑之一。**

> **⚠️ 2026-10-28 复核：这条坑确实踩到了，已修。**
> `tools/probe-real-pack.js` 和 `tools/probe-write-path.js` 原本只匹配复数 `recipes/`。在 `Mechanomania`（1.21.1）上实测：**单数 `recipe/` 有 10,204 个文件、复数 `recipes/` 只有 9 个**。后果是**源 C（配方产物）净贡献 0 个新 ID**——mods 侧 9,447 全部来自 A(lang 7,815) ∪ B(models 7,896)，配方完全没被用上。修正为 `(?:recipes|recipe)` 后：mods 侧 A∪B∪C = **10,123**（配方净补 676），原版净增 2,468，**全集 12,591**。
> `tools/probe-real-pack.js:121` / `tools/probe-write-path.js:68` 已改为 `(?:recipes|recipe)`；`tools/probe-planning.js:112` 和 `tools/probe-jar.js:118` 本来写法就对。

**⚠️ class 反编译路线已证伪**：扫 `*.class` 常量池抽 `namespace:path` 只能得 18 个（全是 UI 字面量）。**不要在 class 上浪费时间。**

### 4.3 FTB Quests 读写：读能直接跑，写要自研 span-preserving ★核心

`tools/probe-ftbqp-store.js`、`tools/probe-write-path.js`

**读**：`ftb-quests-preview@0.1.2` 的 `QuestStore.load({questDir, locale})` 可直接用（本地已有一份在 `probe/ftbqp/server/`）。实测：
- `Mechanomania`：18 章节 / 395 任务 / **25–30ms**
- `atm10sky`：52 章节 / 3658 任务 / **372ms**

它建的索引：`questsById` / `duplicateQuestIds` / `duplicateObjectIds` / `dependantsById`；`revisionHash(bytes)` 做乐观锁；章节标题回退 `chapter.<id>.title` → `raw.title` → `id`。

**写**：**它的 `patch` 只支持 x/y/title/subtitle/description，不能建章节、不能加任务、不能改 tasks/rewards/dependencies。必须自研。**

自研方向：**span-preserving 编辑**（抄 `server/snbt-edit.mjs` 的 `parseSnbtDocument` + `applyEdits`）：
- 每个节点记 `start / end / closeStart / entries: Map`
- 只替换目标 span，其余字节原样保留
- 末尾用 `JSON.stringify(root.value) !== JSON.stringify(parsed)` 做**双解析一致性断言**
- `applyEdits` 从后往前替换（避免偏移错乱）
- `insertion()` 推断缩进：取首个子键的行首空白，否则 `closeIndent + '\t'`

**为什么不能用整树重写（ftbq-nbt 路线）**：FTB Quests 警告「发布后改任务坐标/标题会让玩家进度重置/不可达」，整树重写会重排字段顺序、丢注释、可能在 diff 里制造大量噪音 → 玩家进度风险。

**⚠️ SNBT 格式真相（实测）**：
- **省略逗号**，靠换行分隔
- `#` 后整行是注释
- bare 值支持 `a:b` 冒号拼接（所以 `create:cogwheel` 不进引号也能解析）
- 数字后缀：`0.0d`（double）、`4L`（long）、`1b`、`2s`、`3.5f`
- tab 缩进
- **重复 key 直接 fail**（parser 会报错）
- `ftbq-nbt` 的 parse 必须传 `{ skipComma: true, useBoolean: true }`，否则报 `Error: Unexpected character t at position 27`
- `ftbq-nbt` 的 stringify 要传 `{ skipComma:true, useBoolean:true, pretty:true, tab:'\t', typePostfix:{L:'L',D:'d',B:'b',S:'s',F:'f'}, breakLength:1 }` 才像 FTB 风格
- `ftbq-nbt` 的 ESM 构建用无扩展名 import，直接 import 会 `ERR_MODULE_NOT_FOUND` → **必须走 CJS 构建 `lib/cjs/index.js` + `createRequire`**

**⚠️ 本地化真相（写中文的正确姿势）**：
FTB Quests 从 `lang/<locale>.snbt` 读文本，键名固定：
```
chapter.<章节ID>.title
chapter.<章节ID>.chapter_subtitle
chapter_group.<分组ID>.title
quest.<任务ID>.title
quest.<任务ID>.quest_subtitle
quest.<任务ID>.quest_desc        ← 数组，每项一行
```
`atm10sky` 的 `lang/zh_cn.snbt` 有 **1,020,272 B**（52 章节 × 3658 任务），`lang/` 下还有 `en_us / pt_br / ru_ru / es_es` 子目录 + **每个 locale 下还有 `chapters/` 子目录**（52 个分章文件！）。

**⚠️ 分章目录实测细节（2026-10-28 复测，**修正原文错误**）：**
- **原文说「单文件里只有章节标题、任务级文本全在分章文件」——这是错的。** 实测 `lang/zh_cn.snbt` 单文件里有 **5635 个键**，其中 `quest.quest_desc` 2380、`quest.title` 1825、`quest.quest_subtitle` 1304、`chapter.title` 62、`chapter_group.title` 15、`reward_table.title` 46。任务级文本**单文件里全都有**。
- `lang/zh_cn/chapters/*.snbt`（52 个文件）里的键集是单文件的**子集**：两者重叠 **5415** 个键；只在单文件里的 **220** 个（138 title + 60 quest_desc + 19 quest_subtitle + 3 chapter_subtitle）；只在分章里的 **5** 个。**即分章目录是单文件的删减版拷贝，不是超集。**
- 因此「`ftb-quests-preview` 的 subtitle 全为空」**不成立**。实测 `QuestStore.load({questDir})`：52 章节 / 3658 任务，`subtitle` 非空 **1275/3658**、`description` 非空 **2316/3658**、`titleSource` = `{locale:1807, id:1851}`。zh_cn 与 en_us 两 locale 数字几乎一致（1285/1275）。**单文件读取就够了。**
- 分章文件内容形如：
  ```
  {
  	quest.0B19BF090C21FDB9.quest_desc: ["..."],
  	quest.0B19BF090C21FDB9.quest_subtitle: "动物刷怪蛋",
  	quest.0D6D45DBA64E612D.title: "最大刷怪延迟",
  ```
- 分章文件与 `chapters/*.snbt` **同名对应**（`apotheosis_2.snbt` ↔ 章节文件 `apotheosis_2.snbt`）
- 分章由 mod **`ftbquestslangsplitter-1.0.5.jar`**（`dev.uncandango.ftbquestslangsplitter`，含 `LangSplitterCommands` + `TranslationManagerMixin`，共 28 个 zip 条目）生成，是可选的第三方 mod，不是 FTB 官方行为
- **对实现的真实要求（比原文宽松）**：读 → **优先单文件**，单文件缺的键再从分章目录补。写 → **检测到存在 `<locale>/chapters/` 子目录就同时更新两处（单文件 + 对应分章文件）**，否则 splitter 下次运行会以分章为准把单文件的改动冲掉。**不要**再假设「任务文本只在分章里」。

**写入可行性已实测（`tools/probe-write-path.js`）**：
```
1) 物品 ID 全集：12591（mods 10123 + 原版净增 2468），384ms
2) 岗位副本 → 新建 chapters/dshsmoke.snbt（id=5D5A0001，2 个任务，含 dependencies）
   重写 chapter_groups.snbt（1 个分组）
   写 lang/zh_cn/dshsmoke.snbt（5 个键）
3) 重新加载：章节 18→19（+1），任务 395→397（+2）
   新章节命中 ✓   新任务命中 ✓ 第一台大齿轮
   lint：0 条，error 0 条  → ✓ 通过
4) KubeJS 沙箱执行 + ID 核对：
   正确脚本 → 引用 5 个 ID，未命中 1 个（create:crafting/kinetics/cogwheel ← 这是配方 ID，不是物品）
   含假 ID 脚本 → 未命中 2 个（多出 create:not_a_real_item_xyz）→ ✓ 拦截成功
```
→ **「新建章节 + 写中文 + lint + KubeJS 校验」整条写路径已跑通。**

### 4.4 KubeJS 沙箱：能在 node:vm 里真跑 ★★最大技术突破

`tools/probe-kubejs-sandbox.js`、`tools/probe-real-pack.js`

**做法**：用 `vm.createContext` + Proxy 伪造 KubeJS 全局（`ServerEvents` / `StartupEvents` / `ClientEvents` / `event.recipes.*`），recorder 记下每次调用。

**实测捕获（8 次调用，全部正确）**：
```js
event.remove({"id":"create:andesite_alloy_from_crafting"})
event.shaped("create:cogwheel",["ABA","BCB","ABA"],{A:...,B:...,C:...})
event.shapeless("2x create:andesite_alloy",[...])
event.recipes.create.pressing("create:iron_sheet","minecraft:iron_ingot")
event.smelting(...)  →  链式 .xp(0.35) / .cookingTime(100)
```

**能做的四件事**：
1. **语法校验**：`new vm.Script(source, {filename})`，报错带行号（`SyntaxError | Unexpected token '}'` + `bad.js:3`）
2. **API 白名单校验**：用错 API（`event.shapedd`）不抛错，但 recorder 记录 `event.shapedd` → 与白名单比对即发现
3. **配方意图提取**：从 recorder 的 `calls[].args` 里 `harvestIds()` 抽所有 `ns:path` 形状的字符串
4. **物品 ID 引用核对**：`harvestIds()` ∩ 索引全集

**真实脚本实测结果：**

| 包 | 脚本数 | ok | syntax-error | runtime-error |
|---|---|---|---|---|
| `Mechanomania` | 17 | 14 | **0** | 3（全是 `LootJS is not defined`） |
| `atm10sky` | 74 | 64 | **0** | 10（`LootJS` / `PlayerEvents` / `BlockEvents` / `FTBFilterSystemEvents` / `config` / `Java` 离线） |

→ **真脚本语法 0 错误说明沙箱足够兼容；runtime-error 全部是「未伪造的第三方事件总线」，这是预期行为，不是 bug。** 解决方式：把 `LootJS` / `PlayerEvents` / `BlockEvents` / `FTBFilterSystemEvents` / `ItemEvents` / `EntityEvents` / `BlockEvents` / `LevelEvents` / `ServerEvents` 全部加入 Proxy 白名单（返回可链式的 recorder），并且 `Java` 不要 throw 而是返回 recorder（我们的 `probe-real-pack.js` 里 `Java` 是 `throw new Error('offline')`，导致 4 个脚本被误判）。

**⚠️ ID 引用核对的假阳性必须处理**：
- 配方 ID（`create:crafting/kinetics/cogwheel`）不是物品 ID，但形状一样 → 用启发式 `_from_|_to_|crafting|smelting|pressing|mixing|cutting|blasting` 过滤
- 事件 ID / 结构 ID（`occultism:ritual`、`productivebees:block_conversion`、`kubejs:ritual_dummy/...`）也不是物品
- **正确做法**：不要靠正则猜，而是**让 `harvestIds` 记录「这个 ID 出现在哪个参数位置」**（`event.shaped(输出ID, ...)` 的第 0 参 = 物品；`event.remove({id: ...})` = 配方 ID），按调用签名分类后再核对。这才是零假阳性的路线。

**实测规模**（2026-10-28 修正配方正则后复跑）：`Mechanomania` 脚本引用 234 个 ID（81 未命中，19 疑似配方 ID，62 疑似物品）；`atm10sky` 引用 1,102 个 ID（485 未命中，70 疑似配方 ID，415 疑似物品）—— 这 415 里绝大多数是上面说的「事件/结构 ID」假阳性，正是要靠签名分类解决。注意即使索引修正到 12,591，`minecraft:light` / `minecraft:totem_of_undying` / `minecraft:leather_boots` 这类原版物品仍报未命中，说明**原版 jar 的 `models/item` 覆盖不全**，源 C 也补不上——这是下一步要专门处理的（建议对 `minecraft:` 命名空间放宽：凡是原版已知物品直接信，或补一份原版注册表兜底）。

### 4.5 规划层：配方图 + 重叠度，已实测可行

`tools/probe-planning.js`

**A. 配方图（断路/开环检测）**
- 从每份 `recipe/*.json` 抽 `ins` / `outs`：`result` / `result.item` / `result.id` / `results[]`；输入走 `ingredients` / `key` / `ingredient` / `input` / `base` / `addition` / `template` / `inputs` / `input_a` / `input_b`；tag 记成 `#tag`
- 建 `produces: item → [recipeId]` 与 `consumes: item → [recipeId]`
- **断路判定**：模拟删除某 mod 的全部配方 → 某物品 `produces` 全空 **但** `consumes` 仍非空 = **断路**
- **实测**：`Mechanomania` 解析 **9,786 份配方 / 339ms**，4,735 个有产物物品、2,974 个有消耗物品。模拟删掉 create 的 1,884 份配方 → 检出 **106 个断路物品**，Top 是 `create:andesite_alloy`（被 72 份配方需要）、`minecraft:item_frame`（30）、`create:display_board`（19）、`minecraft:obsidian`（18）、`create:zinc_ingot`（17）… **数值全部合理，可交付。**

**B. 模组重叠度（离线启发式）**
- 启发式 1「同名物品」：不同命名空间、相同 path → `Mechanomania` 检出 **137 组**，Top：`basin ← barbequesdelight, create`、`canister ← bhc, createdieselgenerators`、`vodka ← brewinandchewin, creategearsandtavern, kaleidoscope_tavern`、`copycat_* ← copycats, create_connected`（11 个）
- 启发式 2「功能族覆盖」：按物品 path 词根归组（齿轮/传动、矿石处理、存储、流体、能源、任务进度），统计每个 mod 在该族的物品数 ≥5 的
  - 齿轮/传动：`create(11), create_compressed(8), create_connected(9), createadditionallogistics(23)`
  - 矿石处理：8 个 mod，`create(83), create_compressed(46), createdeco(28)`
  - 存储：7 个 mod，`fxntstorage(36), cratedelight(26)`
  - 流体：4 个 mod，`create_mechanical_spawner(28), create(9)`
  - 能源：0（本包确实没有能源类 mod，说明规则工作正常，不是全命中）
- **注意**：这两个都是启发式，报告里必须标注置信度，不能当硬结论。

**C. 进度曲线**
- 从 `QuestStore` 读章节 → 任务数、依赖深度（BFS 最长路径）、奖励价值
- 约束检查：`任务总数在 [N-10%, N+10%]`、`每章任务数单调不减`、`依赖深度递增`
- 实现简单，无需额外探针（数据已在 QuestStore 里）

### 4.6 网络（已恢复，但有讲究）

VPN 关掉后：
- node 原生 `fetch` 全通：`api.github.com` 200、`api.modrinth.com/v2` 200、`raw.githubusercontent.com` 200
- **`pwsh` 的 `Invoke-RestMethod` 仍然失败**（"基础连接已经关闭: 接收时发生错误"）→ **必须用 node fetch，不要用 pwsh 直连外网**
- `curseforge api` 403（需 key）
- 首连偶发超时 → `AbortSignal.timeout(20000)` + 最多 4 次重试

**工具链限制（写进文档给下个 agent，别重复踩）：**
- `web_fetch` / `read_page` 对 `github.com` 被 VPN fake-IP 解析成 `127.0.0.1` → "Blocked private network target"
- `ftbwiki.org` 被 Anubis 工作量证明拦截
- `docs.modrinth.com/docs/modpacks/format_definition/` 404（路径已变）

### 4.7 运行时可用性

- `C:\Program Files\nodejs\node.exe` **v24.18.1** 可正常跑 `node -e`
- PowerShell 里 `npm.ps1` 被执行策略拦住 → 用 `powershell -NoProfile -ExecutionPolicy Bypass` 或直调 node
- `dsh` 命令可用

### 4.8 联网元数据层（用户 2026-10-28 新增要求，取代原文「否决 API」）

**定位：只做「找 mod / 认版本 / 查前置依赖 / 算兼容」，不碰配方内容。**
配方、标签、物品的真实数据仍然只能从 `mods/*.jar` 解包得到——API 没有这些。两层是互补，不是替代。

- **Modrinth API v2**（免 key）：`https://api.modrinth.com/v2`，必须带独特 `User-Agent`，否则被限流。§4.6 已实测 200。
- **CurseForge API**（需 key）：`https://api.curseforge.com/v1`，header `x-api-key`。**key 由用户提供**，未配置时该源静默降级，只走 Modrinth。取 key 的流程见 §4.10。
- **loader 枚举映射表**（关键坑）：Modrinth 用 `forge` / `neoforge` / `fabric` / `quilt`；CF 用数字 `modLoaderType`（1=Forge, 4=Fabric, 5=Quilt, 6=NeoForge）。两边对 `1.21.1 + NeoForge` 的可用性判断会不一致，必须以**本地实际安装的 jar 为准**，API 只做候选建议。
- **降级契约**：任何网络失败 → 返回 `source: "local-only"` 并注明原因，工具**不得**因此报错中断。
- 新增工具：`mc_mod_search`（跨源搜索）、`mc_mod_meta`（版本/依赖/兼容矩阵）、`mc_mod_compat`（对当前包算「能不能装」）。
- **sha1 反查是本层最高性价比的一招**（2026-10-28 实测）：`POST /v2/version_files`，body `{hashes:[sha1...], algorithm:"sha1"}`，可**批量**把本地 jar 换回 project_id + version_number。抽样 40 个 jar **命中 34/40（85%）**。命中率比解析 `mods.toml` 的 updateURL 高得多——该包 183 个 jar 里只有 129 个带 URL、其中能被 Modrinth 正则认出的仅 6 个。**所以顺序应该是：sha1 批量反查优先，updateURL 只做兜底。**

### 4.10 其他 mod 元数据源（2026-10-28 实测可用性）
用户问「有没有其他途径，比如 MC百科」。答案是**有，但只能当补充**。全部实测过：

| 源 | 端点 | 实测结果 | 能不能用 |
|---|---|---|---|
| **Modrinth** | `api.modrinth.com/v2` | 200；`/search` 支持 facets；`/project/{id}/version` 支持 `game_versions`+`loaders` 过滤；`/version_files` 支持 sha1 批量反查 | ✅ **主力**，免 key，含依赖关系 |
| **CurseForge 官方** | `api.curseforge.com/v1` | 无 key **403** `API Key missing or invalid` | ✅ 需 key，见 §4.10.1 |
| **CFWidget**（第三方） | `api.cfwidget.com/minecraft/mc-mods/<slug>`，或 `api.cfwidget.com/<projectId>` | **200，无需 key**。返回 title/summary/description/thumbnail/categories **/ 全部 files**（每个含 `id` `name` `display` `versions:["1.21.1","NeoForge"]` `filesize` `downloads` `uploaded_at`）/ `download`（最新文件）/ `urls` / `downloads.total` | ✅ **强烈建议加**。这是绕开 CF key 的合法途径，能做「查最新版本 / 按 loader+MC 版本筛文件」，**但没有依赖关系**（无 `dependencies` 字段） |
| **curse.tools** | `api.curse.tools/v1/cf/...` | **403**（Cloudflare 拦截） | ❌ 不可用 |
| **MCIM / lss233 等 CF 镜像** | — | DNS 直接失败 | ❌ 不可用 |
| **MC百科**（`www.mcmod.cn`） | `search.mcmod.cn/s?key=xxx`；`www.mcmod.cn/class/<id>.html`；`/item/<id>.html` | 搜索 **200**，返回 `找到约 7734 条结果`，结果块 `.result-item` 里含 `<a href=".../class/2021.html">机械动力 (Create)</a>` + 摘要 + `快照时间`；class 页 200（312 KB）；item 页 200（109 KB，`<title>煤矿石 (Coal Ore) - [MC]我的世界原版 (Minecraft)</title>`） | ⚠️ **能抓，但不该当 API 用**。没有开放 API（`/openapi/` 和 `/api/` 都 404）；robots.txt 只禁了 `/class/add|edit/`、`/item/add|edit/` 这类写路径，读路径没禁；但它是**HTML 抓取 + 中文名/简介**，拿不到结构化版本矩阵和依赖。定位：**给中文名、简介、教程链接做 enrichment**，且必须缓存 + 限速，绝不进关键路径 |
| **中文 Minecraft Wiki** | `zh.minecraft.wiki` / `minecraft.fandom.com` | 两者 **403 或 fetch failed**（Cloudflare / DNS） | ❌ 不可用 |
| **模组中文名/汉化** | **本地 jar 内 `assets/<ns>/lang/zh_cn.json`** | 183 个 jar 里 **94 个自带 zh_cn.json**，`item.*`+`block.*` 键合计 **6,546**；原版 jar 只有 `en_us.json`（无 zh_cn） | ✅ **这才是中文名的第一来源**，离线、精确、无网络依赖。原版中文名需另找（见下） |
| **NeoForge Maven** | `maven.neoforged.net`（直连） | **fetch failed**（10.6s）；**`bmclapi2.bangbang93.com/maven/...` 200**（68 KB，最新 `26.3.0.99`） | ⚠️ 直连不通、**镜像通**，要用镜像 |
| **Forge promotions** | `files.minecraftforge.net/.../promotions_slim.json` | **200**（4,153 B） | ✅ 1.20.1 Forge 侧版本推荐可用 |

**结论（写进实现）**：联网层按 **Modrinth → CFWidget（免 key 兜底）→ CurseForge 官方（有 key 才启用）** 三档回退；**MC百科只做中文 enrichment 且默认关闭**；中文名永远优先读本地 jar 的 `zh_cn.json`。

### 4.10.1 CurseForge API Key 怎么拿（给用户的操作步骤）
1. 打开 <https://console.curseforge.com/>，用 **Google 账号**登录（就是 CurseForge 账号体系，纯邮箱账号可能要先绑 Google）。
2. 首次进入会要求**创建一个 organization**（个人开发者随便填名字即可）。
3. 在 Console 里进 **API Keys** 页 → **Create API Key**，生成一串 32 位十六进制字符串，只显示一次，**当场复制保存**。
4. 如果 Console 里建不出 key 或 key 被平台判定无效，走**人工申请通道**：填 <https://forms.monday.com/forms/dce5ccb7afda9a1c21dab1a1aa1d84eb?r=use1>（官方支持文档 9000208346 指定的表单），需同意 3rd Party API Terms；Overwolf 人工审核后邮件发 key。**审核看三点**：是否影响作者收益、对 CF 服务器/CDN 的压力、如何尊重作者对第三方分发的授权 —— 我们的用途（本地整合包分析工具、只读元数据、不重分发 jar）属于最容易过的那类，如实写即可。
5. 拿到后**不要硬编码**：走环境变量 `CURSEFORGE_API_KEY` 或 DSH 插件配置项；缺失时降级（见 §4.8 降级契约）。
6. 注意：CF 的文件下载 CDN（`edge.forgecdn.net`）也认证，header 同样是 `x-api-key`。
7. **不着急**：在 key 到手前，§4.8 的 Modrinth + CFWidget 两档已经能覆盖「搜 mod / 认版本 / 看兼容」的绝大多数场景，只有「依赖关系」和「精确文件 hash」需要官方 API。**所以 P8 不必等 key**。


### 4.9 启动验证层（用户 2026-10-28 新增要求，取代原文「先不管」）

**验收线已明确：启动到主菜单就算过**，不要求进世界。

**已实测（2026-10-28，对 `Mechanomania` 实例真跑）：**
- `versions\Mechanomania\Mechanomania.json`：`id=Mechanomania`，`mainClass=cpw.mods.bootstraplauncher.BootstrapLauncher`，`assetIndex=17`，`javaVersion={component:"java-runtime-delta", majorVersion:21}`，`libraries` **144 条**，`inheritsFrom` 为空，用 `arguments.game` 而非 `minecraftArguments`。
- **classpath 能自己算**（2026-10-28 修正过头一版的算法，以下为复核后准确值）：
  - `libraries` 共 144 条 = 96 条非 natives + 48 条 natives（natives 分布在 `natives-linux` 8 / `natives-macos` 7 / `natives-macos-arm64` 8 / `natives-macos-patch` 1 / `natives-windows` 8 / `natives-windows-arm64` 8 / `natives-windows-x86` 8）。
  - 按 `rules` 筛出**在 windows/x86_64 上生效**的非 natives = **93 条条目**，但其中 **11 条 artifact 路径重复**（gson、guava、failureaccess、commons-io、commons-lang3、jopt-simple、log4j-api/core/slf4j2-impl、slf4j-api、mojang logging —— NeoForge 与 MC 各声明一次，指同一个 jar）→ **classpath 实际 82 个 jar**，拼接后 **7,702 字符**。
  - natives 取 `natives-windows`（x64）**8 条**，解压到 `${natives_directory}` 并设 `-Djava.library.path`。`natives-windows-arm64` / `natives-windows-x86` 在 x64 上**必须排除**（原稿把它们算进去了，才得出 117/109 这种数）。
  - **缺 0 个**：真正会缺的只有 3 条非 windows 条目（`java-objc-bridge`→osx、两个 `netty-transport-native-epoll`→linux），本就不该在 windows 上加载。
  - ✅ 不需要第三方启动器。
- **Java 找到了**：`C:\Users\<user>\AppData\Roaming\.minecraft\runtime\java-runtime-delta\bin\java.exe` = **OpenJDK 21.0.7 LTS**（微软构建）。该路径由 PCL 日志明文给出（`PCL\Log1.txt` 第 14-15 行，`[ModJava] 共有 1 个可用的 Java`）。**本机没有独立 JDK，PATH 里也没有 java** → 探测顺序必须包含 `%APPDATA%\.minecraft\runtime\*`。
- `assets\indexes\17.json` **存在** ✅ 且 **objects 全部齐全**：索引 3,910 个 object，磁盘 `assets\objects\<前2位>\<hash>` **3,910 个全在，缺 0** → 首次启动**不需要**再下 assets。整个实例 10,766 MB。

**✅ 2026-10-28 真启动实测成功（这是本层最重要的证据）：**

用户原话「目前的确还没有起过一个 NeoForge 的包」。本轮**已经真的起了一次**，用的就是上面自己算出来的 classpath，**没有借任何第三方启动器**：

- 命令 = `java-runtime-delta\bin\java.exe` + 23 条 JVM 参数 + `-cp`（82 jar）+ `BootstrapLauncher` + 32 条 game 参数，共 60 个 argv。
- **55 秒**到主菜单（判据 `latest.log` 出现 `Sound engine started`），期间窗口正常创建、无 crash-report 生成。
- 日志时间线：`Backend library: LWJGL version 3.3.3+5`（约 30s）→ `OpenAL initialized` → `Sound engine started`（55s）→ `Created: 8192x4096x4 minecraft:textures/atlas/blocks.png-atlas`（主菜单贴图集已加载）。
- 只有一个前置条件：**必须以 `apply`/真实权限运行**。第一次在 workspace-write 沙箱里跑，log4j 无法创建 `logs/latest.log`（`RandomAccessFile ... 拒绝访问`）→ 启动立即失败。**这不是启动链的问题，是文件写权限的问题**，实现时要把这条写进错误归因（"logs 不可写" ≠ "启动失败"）。


**关键坑（实测发现，别踩）：**
1. **natives 有两种写法**。老版本用 `libraries[].natives` map；这个 NeoForge 包是**独立条目带 classifier**（`org.lwjgl:lwjgl-glfw:3.3.3:natives-windows`），natives 条目共 **48 条**（7 个 classifier × 各 6-8 个库），而 `libraries[].natives` 字段为 **0 条**、`downloads.classifiers` 也为 **0 条**。两种写法都要认，否则 `${natives_directory}` 会算空 → 启动即崩。
   - **重点：要按当前 OS+arch 精确选 classifier**。x64 Windows 上只取 `natives-windows`（**8 条**），必须排除 `natives-windows-arm64` 和 `natives-windows-x86` —— 这两组各 8 条会被 `"os":{"name":"windows"}` 规则放行，粗暴筛会混进来（这就是原稿算出 24 条 / 117 个 jar 的原因）。
2. `rules` 里有 `features` 的一律当不满足。**实测这个包 0 条 lib 带 features 规则**，但实现要写，别的包会有（`has_custom_resolution` / `is_demo_user` 等）。
3. `arguments.jvm` 是**对象数组**（`{rules, value}`）与纯字符串混排，不能直接 `join(" ")`。
4. 变量替换至少要有（**这个包实测出现的全部 17 个占位符**）：`${classpath}` `${classpath_separator}` `${library_directory}` `${natives_directory}` `${launcher_name}` `${launcher_version}` `${auth_player_name}` `${auth_uuid}` `${auth_access_token}` `${auth_xuid}` `${clientid}` `${user_type}` `${version_name}` `${version_type}` `${game_directory}` `${assets_root}` `${assets_index_name}`。（`${resolution_width}` / `${resolution_height}` 这个包没用，但别的实例会有，一并支持。）
5. **NeoForge 专有坑（本轮实测，最容易漏）**：`arguments.jvm` 里还有两个非标准占位符 —— **`${library_directory}` 和 `${classpath_separator}`**，出现在 `-DlibraryDirectory=` 和 `-p`（module path）参数里。不替换就会把一个含 `${}` 的坏路径传给 JVM，**启动直接失败**。`library_directory` = `<root>\libraries`，`classpath_separator` = `;`。
6. `--clientId` / `--xuid` 的占位符 `${clientid}` / `${auth_xuid}` 在离线模式无值，**必须替换成空字符串**而不是留着原样。
7. dry-run 实测结果（复核后）：`Mechanomania` 上 classpath **82 个 jar**（7,702 字符）+ **8 个 `natives-windows`** 解压到 natives 目录 = 交给 JVM 的共 90 个文件；`arguments.jvm` 原始 26 条 → 按 rules 展开后 **24 条**、`arguments.game` 原始 38 条 → 展开后 **32 条**；替换全部 17 个占位符后 argv 可完整拼出。原稿写的「109 / 117 个 jar」「jvm 24 / game 32」中的 jvm/game 条数是对的，classpath 数偏大（把 arm64/x86 natives 与重复 artifact 算进去了）。

- **进程管理**：spawn → 抓 stdout/stderr → 同时轮询 `logs/latest.log`。
- **成功判定（已用真启动验证过优先级）**：
  1. **`latest.log` 出现 `Sound engine started`（实测最可靠，55s 命中）** —— 这是主菜单音效初始化完成的标志，不需要读窗口、不需要桌面 API，沙箱里也能轮询。
  2. `OpenAL initialized` / `Backend library: LWJGL version 3.3.3+5` —— 更早的中间信号，说明已进渲染初始化（约 30s）。
  3. 进程存活且主窗口标题可读（`Get-Process | Select MainWindowTitle`）—— 直观但依赖桌面会话，**当辅助证据**。
  4. 弱信号：无 `FATAL` / `Exception in thread "main"` 且存活 ≥ 30s。
  - 实测 55 秒到主菜单；**目标达成延迟 = 55s**，所以超时默认 180s 够用，但首次启动要下 assets，建议默认 600s 可配。
- **失败归因**：读 `crash-reports/crash-*.txt` 头部 `Description:` + `-- System Details --`，映射成「缺前置 mod / Java 版本错 / 显存不足 / 配方解析炸」。
- **错误归因必须先排除"写权限"**：实测在只读/受限沙箱下，log4j 建不了 `logs/latest.log`（`RandomAccessFile ... 拒绝访问`）会**伪装成启动失败**。所以判定流程第一步应该是「`gameDir\logs` 可写吗」，不可写就直接报「权限问题」而不是「启动失败」。
- **硬约束**：客户端**需要窗口**，无头环境跑不了。必须在有桌面会话的机器上执行。
- 新增工具：`mc_launch_test`（dry-run 只出命令，`apply: true` 才真启动）。

### 4.11 从零起一个 NeoForge 包的最小链路（回答用户「还在想怎么实现」）
用户说没起过 NeoForge 包、在思考完整链路。下面这条是**本轮已经跑通并验证过的**顺序，可以直接照抄：

1. **定版本三元组**：MC 版本（1.21.1）+ loader（NeoForge 21.1.228）+ Java（21）。三个都不能猜，NeoForge 版本必须和 MC 版本对得上（`--fml.neoForgeVersion` 和 `--fml.neoFormVersion` 是两个不同的值，都从 `versions/<名>/<名>.json` 的 `arguments.game` 里读，别自己拼）。
2. **拿一份 `version.json`**：不用自己生成。要么用官方安装器产出的，要么抄 PCL2 已装实例的 `versions/<名>/<名>.json`——里面 144 条 `libraries` 已经把 NeoForge/MC/所有前置依赖全列好了。
3. **算 classpath**：按 `rules` 筛（os + arch + features），取 `downloads.artifact.path`，**按路径去重**（实测 93 条 → 82 个 jar），排除所有 `natives-*`。
4. **选 natives**：只取 `natives-windows`（x64）那 8 条，解压到 natives 目录，同时设 `-Djava.library.path` 和 `-Dorg.lwjgl.librarypath`。
5. **替换占位符**：17 个，其中 `${library_directory}`、`${classpath_separator}` 是 NeoForge 专有，最容易漏；`${clientid}`/`${auth_xuid}` 离线填空串。
6. **`-p` module path 不要动**：`arguments.jvm` 里的 `-p` 已经带了 NeoForge 的模块化启动器，手工删会起不来。
7. **补 assets**：`assets\indexes\<assetIndex>.json` 的 objects 全部落到 `assets\objects\<前2位>\<hash>`。实测索引 3,910 个、磁盘齐全、启动即用。**首次要下的话，用 BMCLAPI 镜像**（官方 `piston-*` 直连在本机不通，见 §4.6）。
8. **起进程 + 判成功**：见上面 §4.9 的判定链。
9. **失败先看两件事**：`crash-reports/` 有没有新文件；`logs/latest.log` 里 `FATAL` 前 20 行。NeoForge 的典型炸法就是 mixin/前置 mod 冲突（本机历史上就有 `iris` + `sodium` 的 mixin attach 失败记录）。

### 4.12 已实现工具清单与实测口径（2026-10-28 第五轮）

代码在 `lib/`，纯 ESM 无构建（**本机没有 tsc，也不该为它引入构建链**）。19 个工具，`lib/tools/registry.js` 是唯一登记表。

| 阶段 | 工具 | 状态 |
|---|---|---|
| P0 实例 | `mc_instance_info`、`mc_mod_list` | ✅ 真机 |
| P2 任务书读 | `mc_quest_list`、`mc_quest_show`、`mc_quest_search`、`mc_quest_lint` | ✅ 真机 |
| P2 任务书写 | `mc_quest_patch`、`mc_quest_add`、`mc_quest_chapter` | ✅ 副本端到端（含「新建一章 10 个任务」） |
| P4 KubeJS | `mc_kubejs_verify`、`mc_kubejs_plan`、`mc_kubejs_apply` | ✅ 真机 + 副本写 |
| P5 规划 | `mc_recipe_find`、`mc_recipe_path`、`mc_recipe_uses`、`mc_recipe_impact`、`mc_overlap_report`、`mc_progression_check` | ✅ 真机 |
| P9 启动 | `mc_launch_test` | ✅ 真机真启动 |

**数字口径要分清**（都和本文前面几轮的旧数不同，因为索引变宽了）：

| 指标 | 旧口径（`tools/probe-planning.js`） | 当前实现（`lib/core/recipes.js`） | 差别原因 |
|---|---|---|---|
| 配方总数 | 9,786 | **11,076** | 现在同时吃单数 `recipe/` + 复数 `recipes/`，且把原版 jar 的配方也算进来 |
| 删 create 后「拿不到」 | — | **778** 个物品 | 只要没有存活配方产出就算 |
| 删 create 后「真断路」 | 106 | **94** | 本口径要求「还被别的存活配方当材料」；数字更低是因为索引更宽，有些物品找到了别的来源 |
| 同名物品组 | 137 | **208** | 物品表从 10,450 起算，覆盖面更大 |
| 撞车功能族 | 4 | **9** | 功能族表从 6 类扩到 10 类 |
| 进度分层可算出 | — | **4,502** 个物品（另 1,638 算不出） | 第 0 层现在包含「没有配方的原材料」，否则全员卡在 0 层 |

`mc_recipe_impact` 的 Top 命中与旧口径一致：`create:andesite_alloy` 被 **72** 条配方需要 —— 这条可以当回归基准。

**单测**：9 个套件 135 个用例全绿（launch 9 / instance 10 / index 11 / plugin 7 / snbt 18 / quests 18 / recipes 16 / overlap 12 / kubejs 34）。跑法必须是 `node --import ./test/register.mjs test/<x>.test.mjs`，**不能用 `node --test`**（沙箱下报 `Error: spawn EPERM`）。

---

## 5. DSH 插件契约（实测确认）

### 5.1 插件本体骨架

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-mc-modpack-studio'
export const inject = ['tools'] as const

export function apply(ctx: Context, _config?: unknown): void {
  ctx.effect(
    () => ctx.tools.register(defineTool({ /* name, description, parameters, execute */ })),
    `tool:${definition.name}`,
  )
}
```

要点（来自 `ref/dsh-tool-modpack/index.ts:122-133`）：
- `export const name` / `export const inject = ['tools'] as const` / `export function apply(ctx, config)`
- `ctx.effect(() => ctx.tools.register(defineTool({...})), 'tool:<name>')` —— 每个工具一个 effect，用于热卸载
- `execute` **只返回一个 canonical 值**，故障直接 `throw`（不要返回 `{error}`）

### 5.2 `cordis.patch.yml`（全文就这么短）

```yaml
- insert:
    - id: dsh-mc-modpack-studio
      name: dsh-mc-modpack-studio
```

`package.json` 里：`"dsh": { "bundle": { "patch": "cordis.patch.yml" } }`

### 5.3 peerDependencies 必须写宽范围 ★必踩的坑

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.2",
  "@deepseek-ai/dsh-tools": ">=0.1.5-rc.1 <0.3.0"
}
```

**为什么**：DSH 安装器用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 校验插件 peerDeps 里所有 `@deepseek-ai/dsh*` 范围，不匹配直接**拒绝安装**并报：
```
installation rejected: ... is incompatible with dsh ...
```
写死 `^0.2.1-rc.3`（像 `dsh-tool-fs` 那样）**会被拒**。

当前运行时：`@deepseek-ai/dsh-desktop` **0.2.1-rc.3**，`dshBuildCommit = be72761ee1a6736ebcdf4f3739363b083ae53c98`

其它 package.json 约定（照 `ref/dsh-tool-modpack/package.json`）：
```json
{
  "type": "module",
  "main": "lib/index.js",
  "engines": { "node": ">=20.18.1" },
  "dependencies": {},          // 尽量零依赖
  "devDependencies": { "typescript": "^5", "@types/node": "^22" }
}
```

### 5.4 本地安装 / 调试

- profile 目录：`C:\Users\lyh\.dsh\profiles\desktop\`（当前 GUI 用的就是这个，`package.json` 有 30 个 bundles，`patchReload: live`）
- 用户 profile patch：`C:\Users\lyh\.dsh\profiles\desktop\cordis.patch.yml`（1268 行）——**已插入的 preset 是最好的写法范本**（`preset-openwrite-0-2-21` 在 id 行 42，`preset-openwrite-0-2-23` 在行 321）
- 也可以用 `dsh` 的 `tool-plugin-manager` / `tool-plugin-market`（cordis 预设自带）
- Web GUI：`http://127.0.0.1:53533`

### 5.5 「创造模式」= `preset-cordis`

用户已确认（m00424 原话「对，就是 cordis 预设」）。

内置 preset 只有 4 个（来自 `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/`，由 `dsh.bundle.patch` 数组加载）：
- `preset-standard`（order 1）
- `preset-ptc`（order 2）
- `preset-minimal`（order 3）
- **`preset-cordis`（order 4）← 这个**

cordis 预设的 plugins 含：`persona` / `agent-instructions` / `time-context` / `tool-bash`（win32 禁用）/ `tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-jobs` / `tool-schedule` / `command-goal` / `tool-goal` / `planning`(plan-mode) / `compaction` / `tool-subagent*` / `workflow-ptc` / `tool-workflow` / `tool-ask-user` / `tool-todo` / `tool-web`(含 fetch) / `tool-cordis` / `skill-filesystem` / `tool-skill` / `present` / `tool-plugin-manager` / `tool-plugin-market`

### 5.6 环境断裂警告

`C:\Users\lyh\.dsh\profiles\node_modules\@deepseek-ai\*` 是一堆 **Junction**，Target 指向**已不存在**的 `D:\DeepseekHarness\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\...`（旧安装路径）。→ **插件依赖解析要留意这条断裂链，优先零依赖设计。**

DSH 真实安装位置：`D:\DeepSeek Harness\resources\app.asar`（182 MB / 18,188 文件），所有 `@deepseek-ai/*` 包在 asar 内 `dsh/node_modules/@deepseek-ai/<pkg>/`，只有 `lib/index.js` + `package.json` + `README*.md` + `locale/*.json`，**没有 src/ 和 docs/**。用 `tools/asar-ls.js` 读：
```bash
node tools/asar-ls.js "D:\DeepSeek Harness\resources\app.asar" ls dsh/node_modules/@deepseek-ai 50
node tools/asar-ls.js "D:\DeepSeek Harness\resources\app.asar" cat dsh/node_modules/@deepseek-ai/dsh-tool-fs/README.zh.md
```
（asar 头格式：偏移 4..8 = header 块长度，12..16 = JSON 字符串长度，JSON 从 16 开始，数据区 = `ceil((16+jsonLen)/4)*4`）

---

## 6. 建议的工具清单

> 粒度原则（用户选定）：**读用小颗粒，写用「计划 → dry-run → apply」大颗粒**。
> 所有写工具**默认 dry-run**，返回 unified diff + 受影响文件清单；`apply: true` 才落盘；落盘前自动备份到 `.dsh-studio-backups/<ISO时间戳>-<随机6位>/`。

### 6.1 环境与索引（读，小颗粒）

| 工具 | 做什么 |
|---|---|
| `mc_pack_detect` | 探测一个目录是不是整合包，识别布局（PCL / Prism / 官方 / 裸 `.minecraft` / 单实例目录）、MC 版本、加载器（Forge/NeoForge/Fabric/Quilt）、Java 主版本、mod 数、是否有 KubeJS / FTB Quests |
| `mc_pack_index` | 全量索引 `mods/*.jar` + 原版 jar → 物品 ID 全集、mod 清单（modId/version/依赖）、配方表。带缓存（按文件 mtime+size 做 key） |
| `mc_item_lookup` | 查一个物品 ID 是否真实存在、来自哪个 mod、三源证据分别命中哪个、有没有同名物品（重叠告警） |
| `mc_item_search` | 按关键词/模组/功能族搜物品（`"齿轮"` → `create:cogwheel`、`create_connected:*`） |
| `mc_mod_list` | 列 mod 及其版本/依赖/被谁依赖 |
| `mc_mod_search` | **联网**：跨 Modrinth + CurseForge 搜 mod，按 MC 版本 + 加载器过滤（§4.8） |
| `mc_mod_meta` | **联网**：单个 mod 的版本列表、依赖前置、支持的 MC/loader 矩阵 |
| `mc_mod_compat` | **联网 + 本地**：给定 mod 与当前包，算「能不能装」并列出缺失前置 |

### 6.2 规划（读 + 算，中颗粒）

| 工具 | 做什么 |
|---|---|
| `mc_plan_outline` | 从主题出发出大纲：章节结构、里程碑、模组候选、风险清单。写入 `.mcstudio/plan.json`（**不碰游戏文件**） |
| `mc_recipe_graph` | 建配方图，返回统计 + 可按物品/模组查询路径 |
| `mc_balance_check` | **断路/开环检测**：给定「要删的配方集合」，返回会断路的物品清单（含被哪些配方需要）。已实测可行，见 §4.5 |
| `mc_overlap_report` | **模组重叠度报告**：同名物品组 + 功能族覆盖矩阵，带置信度标注 |
| `mc_progression_check` | **进度曲线检查**：每章任务数、依赖深度、奖励价值，对照约束返回违规项 |

### 6.3 任务书（写，大颗粒 + dry-run）

| 工具 | 做什么 |
|---|---|
| `mc_quest_read` | 读任务书全文（章节/任务/依赖/lang），可 JSON 输出 |
| `mc_quest_plan` | **一句话 → 任务书计划**：用户说「新建一章叫『机械入门』，10 个任务，从齿轮到动力合成器」，输出结构化 plan + 预估 diff，**不动盘** |
| `mc_quest_apply` | 把 plan 落盘：新建/修改 `chapters/*.snbt`、`chapter_groups.snbt`、`lang/zh_cn/*`。返回 diff + lint 结果。**带 `apply: false` 时只返回 diff** |
| `mc_quest_lint` | 依赖图环检测 / 悬空节点 / 重复 ID / 章节文件名不匹配 / group 缺失 / 未知 shape / 空章节。**`probe/ftbqp/server/lint.mjs` 已有 37 处 `add()` 覆盖 31 个 code，含 `dependency-cycle`（lint.mjs:297-324，三色 DFS，报完整 path）和 `duplicate-coordinate`，可以直接抄**；我们要**新增**的只有三项：① 任务/奖励引用的物品 ID 真实性核对 ② `lang` 分章目录（`zh_cn/chapters/*.snbt`）与单文件一致性 ③ 章节 `filename` 与实际文件名跨语言比对 |
| `mc_quest_rewrite_text` | 文案润色：给既有任务自动写 `quest_subtitle` / `quest_desc`，或改写既有文案 |

### 6.4 KubeJS（写，大颗粒 + dry-run）

| 工具 | 做什么 |
|---|---|
| `mc_kubejs_read` | 读 `kubejs/server_scripts/**`，返回文件清单 + 每个文件里 recorder 捕获的配方意图 |
| `mc_kubejs_plan` | **一句话 → KubeJS 脚本计划**：「把 Create 的齿轮改成需要安山岩合金围一圈」→ 输出脚本草稿 + 会动哪些文件 + 会引用哪些 ID |
| `mc_kubejs_apply` | 落盘 + 三件套校验（语法 / API 白名单 / 物品 ID 真实性） |
| `mc_kubejs_verify` | 只校验现有脚本：语法错误带行号、未伪造事件总线告警、ID 引用核对（**必须按调用签名分类，避免假阳性**，见 §4.4） |
| `mc_kubejs_progress_link` | **任务完成 → 解锁配方**。走 FTB XMod Compat 的 `FTBQuestsEvents.completed(...)`。参考：https://kubejs.com/wiki/addons/ftb-xmod-compat |

### 6.5 导出（写，大颗粒）

| 工具 | 做什么 |
|---|---|
| `mc_export_plan` | 给三种形态的预估体积/文件数/需要下载的东西，让用户选 |
| `mc_export_build` | 出 zip：`standard`（CurseForge/Modrinth manifest + overrides）/ `offline`（完整 `.minecraft` + 可选 runtime Java）/ `launcher`（exe + modpack.zip）。**必须做 PCL 兼容性自检**（见下） |

**PCL 兼容性自检清单（`mc_export_build` 里必须跑）：**
- [ ] 路径不含 `!` 和 `;`（PCL :38、:844 直接拒绝）
- [ ] 输出是 zip，不是 rar（PCL :81-82 不支持 rar）
- [ ] `offline` 型：zip 里存在 `.../versions/<名>/<名>.json`（正则 `^.*\/(?=versions\/(?<ver>[^\/]+)\/(\k<ver>)\.json$)` 要能命中，PCL :829）
- [ ] `offline` 型：包裹文件夹**最多一层**（PCL 从一级目录判断类型，:58-77）
- [ ] `launcher` 型：exe 的 `FileVersionInfo.ProductName` 等于 `"Plain Craft Launcher"`（或含 `Launcher`/`启动` 且 ≠ `"Plain Craft Launcher Admin Manager"`，PCL :782-792）
- [ ] `launcher` 型：包根有一级目录下的 `modpack.zip` 或 `modpack.mrpack`（PCL :56、:76）
- [ ] 没有 `manifest.json` + `modrinth.index.json` 同时存在于根（会抢判型，:47-54）
- [ ] 版本隔离：写 `PCL/Setup.ini` 的 `VersionArgumentIndie=1` + `VersionArgumentIndieV2=True`（PCL :140-147）
- [ ] 若打包 Java：`runtime/java-runtime-delta/` 且 `bin/java.exe` 存在

### 6.6 环境（读）

| 工具 | 做什么 |
|---|---|
| `mc_env_probe` | 本机：PCL 路径、`.minecraft` 路径、java 路径/版本、可用 instance 列表 |
| `mc_java_provision` | 按主版本从 Adoptium 下载 JRE（`https://api.adoptium.net/v3/binary/latest/{major}/ga/windows/x64/jre/hotspot/normal/eclipse`），或直接拷本机 `runtime\` |
| `mc_launch_test` | **启动验证**（§4.9）：dry-run 出启动命令；`apply: true` 真启动并判到主菜单/失败归因 |

---

## 7. 建议的代码结构

```
dsh-mc-modpack-studio/
├─ package.json                  ← peerDeps 宽范围（§5.3）
├─ cordis.patch.yml              ← §5.2
├─ tsconfig.json
├─ src/
│  ├─ index.ts                   ← 注册所有工具（apply）
│  ├─ tools/
│  │  ├─ detect.ts
│  │  ├─ index-jars.ts
│  │  ├─ item-*.ts
│  │  ├─ plan-*.ts
│  │  ├─ quest-*.ts
│  │  ├─ kubejs-*.ts
│  │  └─ export-*.ts
│  ├─ core/
│  │  ├─ zip.ts                  ← 手写 ZIP 读取（抄 tools/probe-jar.js）
│  │  ├─ jar-index.ts            ← 三源物品索引（抄 tools/probe-real-pack.js）
│  │  ├─ recipe-graph.ts         ← 配方图 + 断路（抄 tools/probe-planning.js）
│  │  ├─ overlap.ts              ← 重叠度（抄 tools/probe-planning.js）
│  │  ├─ snbt/
│  │  │  ├─ parse.ts             ← span 树（抄 probe/ftbqp/server/snbt-edit.mjs）
│  │  │  ├─ edit.ts              ← applyEdits 从后往前
│  │  │  ├─ serialize.ts         ← tab / 无逗号 / 0.0d
│  │  │  └─ schema.ts            ← 字段表（抄 probe/ftbqp/server/schema.mjs）
│  │  ├─ quest-store.ts          ← 读（抄 store.mjs）+ 我们自己的写
│  │  ├─ quest-lint.ts           ← 抄 lint.mjs 全部 31 个 code + 新增三项
│  │  ├─ kubejs-sandbox.ts       ← node:vm + Proxy（抄 tools/probe-kubejs-sandbox.js）
│  │  ├─ kubejs-verify.ts        ← 语法 + API 白名单 + ID 核对（按签名分类）
│  │  ├─ pcl-export.ts           ← 三种形态 + 自检清单
│  │  └─ backup.ts               ← .dsh-studio-backups/<ISO>-<rand6>/
│  └─ util/
│     ├─ fetch.ts                ← node fetch + AbortSignal.timeout(20000) + 4 次重试
│     └─ diff.ts                 ← unified diff
├─ tools/                        ← 已有的探针，保留作为回归基准
├─ ref/                          ← 已有的调研材料
└─ test/
   ├─ fixtures/                  ← 小 jar + 小 quests 目录（从真实包裁剪）
   └─ *.test.ts
```

**零外部依赖目标**：ZIP、SNBT、lint、沙箱全部手写（已有可用实现），唯一可能需要的是 `unified diff` 生成（也可以手写 ~30 行）。

---

## 8. 分阶段任务拆分（建议顺序，每阶段可独立验收）

### P0 — 骨架（0.5 天）
- [ ] `package.json` + `cordis.patch.yml` + `tsconfig.json`
- [ ] `src/index.ts` 注册 1 个 `mc_pack_detect` 工具
- [ ] 装到 `C:\Users\lyh\.dsh\profiles\desktop\`，确认 GUI 里能看见工具、能调用
- **验收**：让 Agent 调 `mc_pack_detect` 报出 `D:\pcl2\PCL 下载\整合包\重度机械症\versions\Mechanomania` 的版本/加载器/mod 数

### P1 — 索引（1 天）
- [x] `core/zip.ts`（移植 `tools/probe-jar.js`）
- [x] `core/jar-index.ts`（三源 + 原版 jar + **`recipes|recipe` 双目录**）
- [x] `mc_pack_index` / `mc_item_lookup` / `mc_item_search` / `mc_mod_list`
- [ ] 缓存层（按 mtime+size）
- **验收**：对 `Mechanomania` 索引出 **12,591** 个 ID（旧探针口径是 12,260，差别在配方正则），耗时 < 2s（含原版 jar）；`mc_item_lookup create:cogwheel` 返回三源证据

### P2 — FTB Quests 读 + lint（1.5 天）
- [x] `core/snbt/*`（span 树 + edit + serialize）
- [x] `core/quest-store.ts`（读 chapters / lang / data / chapter_groups）
- [x] `core/quest-lint.ts`（**抄 `probe/ftbqp/server/lint.mjs` 全部 31 个 code**，含已有的 `dependency-cycle` + `duplicate-coordinate`；新增物品 ID 真实性、lang 分章一致性）+ 物品 ID 真实性 + 坐标重叠
- [x] `mc_quest_read` / `mc_quest_lint`
- **验收**：对 `atm10sky` 读 52 章节 / 3658 任务 < 1s；lint 对真实包输出 0 error（已实测基线）

### P3 — FTB Quests 写（1.5 天）
- [x] `mc_quest_plan`（一句话 → 结构化 plan）
- [x] `mc_quest_apply`（新建章节 / 加任务 / 加依赖 / 写 lang，span-preserving）
- [x] 备份 + dry-run + diff
- **验收**：**「新建一章 10 个任务的章节」端到端跑通**（这是用户验收项 #6）；在 `Mechanomania` 副本上写完后 lint 0 error + 用 `QuestStore` 重载能读到（已实测可行）

### P4 — KubeJS（1.5 天）
- [x] `core/kubejs-sandbox.ts`（**所有事件总线都 Proxy 化**，含 LootJS/PlayerEvents/BlockEvents/FTBFilterSystemEvents/ItemEvents/EntityEvents/LevelEvents；`Java` 返回 recorder 不 throw）
- [x] `core/kubejs-verify.ts`（语法 + API 白名单 + **按调用签名分类的 ID 核对**）
- [x] `mc_kubejs_read` / `mc_kubejs_plan` / `mc_kubejs_apply` / `mc_kubejs_verify`
- **验收**：对 `Mechanomania` 的 17 个脚本，`mc_kubejs_verify` 报 syntax-error 0 个；`LootJS is not defined` 不再出现；「把齿轮配方改成需要安山岩合金」能生成并通过校验、假 ID 被拦截（已实测基线）

### P5 — 规划层（1.5 天）
- [x] `core/recipe-graph.ts` + `mc_recipe_graph` + `mc_balance_check`（断路）
- [x] `core/overlap.ts` + `mc_overlap_report`（同名 + 功能族，带置信度）
- [x] `mc_progression_check`（进度曲线）
- [ ] `mc_plan_outline`（选题 → 大纲 → `.mcstudio/plan.json`）
- **验收**：`Mechanomania` 上 9,786 份配方 / 339ms；删 create 配方后报 106 个断路；重叠报告出 137 组同名 + 4 个功能族

### P6 — 导出（1 天）
- [ ] `core/pcl-export.ts` 的 `standard` / `offline` / `launcher` 三种形态
- [ ] PCL 兼容性自检清单（§6.5 的 9 条）
- [ ] Java 打包（拷 runtime 或 Adoptium 下载）
- [ ] `mc_export_plan` / `mc_export_build`
- **验收**：导出的 `offline` 包拖进真实 PCL2（`D:\pcl2\PCL 正式版 2.10.6\Plain Craft Launcher 2.exe`）能识别并安装

### P7 — 联动 + 文案 + 打磨（1 天）
- [ ] `mc_kubejs_progress_link`（FTBQuestsEvents.completed → 解锁配方）
- [ ] `mc_quest_rewrite_text`（文案润色）
- [ ] 端到端回归：对 `Mechanomania` 跑一遍「读取 → 加 1 章 → 改 1 个配方 → 校验 → 导出」

### P8 — 联网元数据（1.5 天，用户 2026-10-28 新增）
- [ ] `core/modrinth.ts`（免 key）+ `core/cfwidget.ts`（免 key 兜底）+ `core/curseforge.ts`（key 从 `~/.dsh-studio/credentials.json` 或环境变量读）
- [ ] 三档回退链：Modrinth → CFWidget → CurseForge 官方（有 key 才启用）
- [ ] sha1 批量反查（`POST /v2/version_files`，实测 40 个 jar 命中 34 个）作为「本地 jar → 联网身份」的主路径，updateURL 只做兜底
- [ ] loader 枚举映射表 + 双向归一
- [ ] `mc_mod_search` / `mc_mod_meta` / `mc_mod_compat`
- [ ] 降级：任一源失败 → `source: "local-only"`，不中断
- **前置依赖**：~~用户提供 CurseForge API key~~ **不阻塞**（CFWidget 已能覆盖，见 §4.10）；key 到手后只需补 `core/curseforge.ts` 一档
- **验收**：对 `Mechanomania` 能用一句话「帮我找 1.20.1 Forge 的存储 mod」拿回候选，且 `mc_mod_compat` 能正确报出前置缺失

### P9 — 启动验证（0.5 天，用户 2026-10-28 新增；**因已实测跑通，从 1.5 天降为 0.5 天**）
- [x] `core/launch.ts`：Java 探测 → 参数拼装 → spawn → 日志轮询（**算法已验证，照 §4.9 / §4.11 写即可**）
- [x] 主菜单判定（`Sound engine started`）+ 超时 600s（可配）+ 崩溃归因
- [x] 「logs 不可写」要先于「启动失败」判定（§4.9 新坑）
- [x] `mc_launch_test`（dry-run / apply 两态）
- **验收**：在 `Mechanomania` 上真启动一次，判定「到达主菜单」，并故意塞一个坏 mod 验证能正确报崩溃原因
- **已提前完成的验证**：2026-10-28 已手工跑通一次（55s 到主菜单），剩的是把这段代码化 + 补崩溃归因

**合计：0.5+1+1.5+1.5+1.5+1.5+1+1+1.5+**0.5** = 11.5 天**
（注：① 原文写的「合计约 8.5 天」本身算错——P0~P7 逐项相加已是 9.5 天。② P9 因已实测跑通从 1.5 天降为 0.5 天，故 12.5 → **11.5 天**。以本行为准。）

---

## 9. 给下一个 agent 的作战提示

1. **先跑探针，再写代码**。`tools/` 下 9 个脚本全部可直接运行，是活的技术规范：
   ```bash
   cd "D:\Desktop\VibeCoding\dsh-minecraft-modpack-studio"
   node tools/probe-real-pack.js   "D:\pcl2\PCL 下载\整合包\重度机械症\versions\Mechanomania"
   node tools/probe-write-path.js  "D:\pcl2\PCL 下载\整合包\重度机械症\versions\Mechanomania"
   node tools/probe-planning.js    "D:\pcl2\PCL 下载\整合包\重度机械症\versions\Mechanomania"
   ```
   跑通了再动代码，能省掉 80% 的返工。

2. **不要重新调研**。§3 已经把生态扫完了（26,083 条 dsh.so 条目），结论是必须自研。

3. **不要碰 class 反编译**（§4.2 已证伪）。

4. **不要整树重写 SNBT**（§4.3 说了为什么）。

5. **注意 `recipe` vs `recipes`**（§4.2）—— **这是最容易致命的坑**。1.21.1 的包 10,204 个配方文件全在单数 `recipe/`，只写复数 `recipes/` 会让整个配方源静默失效（不报错，只是少 676 个 ID 和全部 9,786 份配方）。探针已修，写新代码时照 `(?:recipes|recipe)` 写。
5b. **modId 解析要三种元数据回退 + 单双引号都认**（§2.1）：`neoforge.mods.toml` → `mods.toml` → `fabric.mod.json`；TOML 里 `modId = 'xxx'` 单引号写法真实存在（如 `DnT-ancient-city-overhaul-v2 [NeoForge].jar`），只匹配双引号会漏。修好后 181/183 可解析，剩 2 个是 `connector` / `kotlinforforge` 这类 loader 层 jar，无元数据属正常。

6. **注意 peerDeps 宽范围**（§5.3，装不上就是这条）。

7. **写操作一律 dry-run 优先 + 自动备份**，因为用户在玩这两个真实包，**弄坏了就是真实损失**。所有写测试都在副本上做（`fs.cpSync(questDir, tmp, {recursive:true})` 后操作）。

8. **用户偏好**：自然语言驱动 + 关键步确认。别做成一堆 CLI 参数，要做成「说人话 → Agent 翻译成工具调用 → 停下来给 diff → 用户点头 → 落盘」。

9. **不要整理用户的 `D:\pcl2`**（用户 m00428 原话：「文件放置的逻辑有点混乱，暂时先不要整理」）。

10. **验收要能看见**。每个阶段结束时，给用户看一个具体的数字或 diff，别只说"已完成"。

---

## 10. 参考材料索引（`ref/` 目录）

| 文件 | 大小 | 内容 |
|---|---|---|
| `PCL2-ModModpack.vb` | 55,402 B / 866 行 | PCL2 整合包安装源码全文。**读 `:31-115`（判型）、`:764-823`（PackType 9）、`:826-859`（普通压缩包）** |
| `dsh-tool-modpack/index.ts` | 196,835 B | 22 个 `modpack_*` 工具全在一个文件。参考骨架 `:122-133`、Modrinth 解析、SNBT 模板 |
| `dsh-tool-modpack/quest-gen.ts` | 22,269 B | FTB Quests SNBT 生成（整树重写思路，**反面教材**） |
| `dsh-tool-modpack/tester.ts` | 30,515 B | 七类校验（含凭据泄漏检测） |
| `dsh-tool-modpack/package.json` | 2,553 B | **peerDeps 宽范围写法范本** |
| `dsh-tool-modpack/cordis.patch.yml` | 334 B | patch 写法范本 |
| `dsh-tool-modpack.README.md` | 22,228 B | 22 个工具完整文档 + 「peer 版本校验」警告 |
| `dsh-tool-fs.README.zh.md` | 19,737 B | 如何基于 `ctx.fs` 接缝写模型可见工具（官方中文） |
| `dsh-tool-fs.package.json` | 2,625 B | 官方包结构（注意它的 peerDeps 是写死的，**别抄**） |
| `minecraft-mcp-server.README.md` | 6,389 B | 14 工具清单 |
| `mc-pack-builder-mcp.README.md` | 7,572 B | 8 工具清单 + 缺口说明 |
| `dsh-minecraft-agent.npm.json` | 17,529 B | 客户端桥路线参考 |
| `dsh-minecraft.npm.json` | 21,713 B | Mineflayer 驱动参考 |
| `dsh-minecraft-ui.npm.json` | 3,564 B | UI 美化（无关） |

**本地已解包的第三方源码（可参考，注意 LICENSE）：**
- `probe/ftbqp/` — `ftb-quests-preview@0.1.2` 全文（MIT）。重点：`server/snbt-edit.mjs`（8,218 B）、`server/lint.mjs`（14,502 B）、`server/schema.mjs`（8,658 B）、`server/store.mjs`（15,390 B）、`parse-snbt.mjs`（4,516 B）、`cli.mjs`（26,267 B）、`AGENTS.md`
- `probe/ftbq-nbt/` — `ftbq-nbt@1.4.1`（零依赖）
- `probe/jar/create-1.20.1-6.0.8.jar` — 18.3 MB 的测试样本

---

## 11. 未决 / 待用户后续确认（不阻塞开工）

1. **`dsh-tool-modpack` 是否要直接复用**？我倾向「借骨架和思路，业务逻辑全部重写」，因为它的三个缺口正好是本项目的核心。若用户想省事，可以让新插件 `optionalDependencies` 它，把 `modpack_search_mods` / `modpack_export` 转发过去。
2. ~~**P7 的「自动启动游戏实测」**~~ **已解决（用户 2026-10-28 明确要真启动，验收线=主菜单，见 §4.9 / P9）**。`dssh-minecraft-agent` 的客户端桥方案（`dsh-mc-bridge-1.0.0.jar` + localhost:25577 + `dsh-bridge/status.json`）不作为本期方案——它走的是游戏内桥接，而我们只需要判进程到主菜单，直接读 `latest.log` 更省。
3. **`dsh.so` 发布**：用户说「先做本地插件，我后续会 git 到 github 上」，所以本次不做上架流程。
4. **`中英对照版任务\` 这种非标准目录怎么处理**：`atm10sky` 里有，是用户手工放的。建议 `mc_pack_detect` 只报告「发现未知目录」，不主动处理。
5. **CurseForge API key**：用户已同意提供，但**尚未给出**。**已不阻塞**：§4.10 实测出 CFWidget 免 key 通道可覆盖「查最新版本 / 按 loader+MC 版本筛文件」，只有「依赖关系」和「精确 hash 反查」需要官方 API。取 key 的步骤见 §4.10.1。P8 可以直接开工，key 到位后再启用第三档。
6. **MC百科要不要接**：实测能抓（搜索/class/item 三页都 200），但无开放 API、只能抓 HTML。建议**默认关闭**，做成可选的「中文名/简介 enrichment」，且必须缓存+限速。用户若明确要，再打开。

---

## 12. 需求理解度自评（user 2026-10-28 复核后）

| 维度 | 理解度 | 依据 |
|---|---|---|
| 目标与边界 | 97% | 全链路 + 三种导出 + 两种起点 + **联网元数据 + 真启动验证**，全部用户本轮确认 |
| 技术栈 | 100% | KubeJS + FTB Quests + 本地 jar 索引 + Modrinth/CF API，用户明确选择 |
| 版本/加载器 | 90% | 「两者都支持不写死」，但 1.20.1 我只验证过 Create 单 jar，未在完整 1.20.1 包上跑过 |
| 规划层深度 | 85% | 三项都要真算，但**「进度曲线的数值约束具体是什么」用户没给具体阈值** —— 建议做成可配置，默认「任务数单调不减 + 总任务数 ±10%」 |
| 交互体验 | 90% | 自然语言 + 关键步确认，但**「什么算关键步」没定义** —— 建议默认：所有写盘操作都算关键步 |
| 导出形态 | 95% | 三种都做，PCL 兼容细节已从源码逆向 |
| 工具粒度 | 85% | 混合，但**具体每个工具的参数形状需要下个 agent 自己拍** |
| 联网层 | 92% | 源定了（Modrinth + CF + **CFWidget 免 key 兜底**），三档回退与降级契约明确；**CF key 仍未到位但不阻塞**（CFWidget 实测可替代大部分场景）；sha1 批量反查命中率实测 85% |
| 启动验证 | 98% | 验收线定了（主菜单），**2026-10-28 已真启动成功一次：55 秒到主菜单，自算 classpath、零第三方启动器、无 crash-report** |

**综合 ~94%**。剩下 6% 是：CF key 未到位（有 CFWidget 兜底，已不阻塞）、1.20.1 Forge 侧未在完整包上跑过、阈值与参数默认值待定。

> **2026-10-28 第三轮复核（探针实测）补充**：本轮把 `tools/` 里的探针全部重跑了一遍，发现并修掉了两个**会静默失效**的实现缺陷：① `recipes/` 单复数只匹配了一个（1.21.1 上配方源完全没生效）；② modId 只认双引号 TOML。修完后 `Mechanomania` 的物品 ID 全集由 **12,260 → 12,591**（+331，配方净补 676、原版净增口径变化）。这印证了「探针是活的技术规范」——但**探针本身也要先验证**，不能直接当真理抄。

> **2026-10-28 第四轮补充（回答用户三问 + 真启动验证）**：用户提出「CF key 怎么拿 / 有没有别的源比如 MC百科 / 我还没起过 NeoForge 包」。本轮全部实测作答并写进文档：新增 **§4.10**（八个源的逐个可用性实测表 + **§4.10.1 CF key 申请步骤**）、**§4.11**（从零起一个 NeoForge 包的最小链路，9 步）、**§4.8 补 sha1 批量反查**（实测命中 85%，远高于 updateURL 解析）。最重要的一条：**当场真启动了一次 `Mechanomania` 并成功进主菜单（55 秒）**，彻底解决了「本机能否真起 NeoForge 包」这个悬了两轮的硬缺口。顺带发现一条新坑：**受限沙箱下 log4j 建不了 `logs/latest.log` 会伪装成启动失败**，错误归因必须先排除写权限。


---

## 13. 2026-10-30 追加：Java 运行时自动获取 + 沙箱进程管道收口 + 1.20.1 Forge 实装

> 本章回答一个此前一直悬着的问题：**用户硬约束要求 1.20.1 Forge 与 1.21.1 NeoForge 都能跑，但本机只有 Java 21**。结论：不需要用户手装 Java，也不需要第三方 JRE 包 —— 用 Mojang 官方的「运行时分发」下就行，且下载目录结构和游戏自更新的完全一致。

### 13.1 Mojang 官方 Java 运行时分发（实测可用）

| 步骤 | 地址 / 形状 | 实测 |
|---|---|---|
| 平台清单 | `https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json` | 200；顶层键是平台：`gamecore, linux, linux-i386, mac-os, mac-os-arm64, windows-arm64, windows-x64, windows-x86` |
| 挑组件 | `all.json["windows-x64"]["java-runtime-gamma"]` | `{availability, manifest:{sha1,size,url}, version:{name:"17.0.15",released}}`；`windows-x64` 下组件有 `java-runtime-alpha/beta/delta/epsilon/gamma/gamma-snapshot, jre-legacy, minecraft-java-exe` |
| 组件 manifest | `https://piston-meta.mojang.com/v1/packages/<sha1>/manifest.json` | `{files:{"<相对路径>":...}}`，gamma 实测 **486 条 = 83 个 directory + 403 个 file**，raw 合计 **86.9 MB** |
| 单文件 | `file.downloads.raw = {sha1,size,url}`，url 形如 `https://piston-data.mojang.com/v1/objects/<sha1>/java.exe` | 需要落的绝对路径 = `<mcRoot>/runtime/<组件>/<相对路径>`；`bin/java.exe` 是入口 |

**组件 ↔ Java 大版本映射**（写死在 `lib/core/java-runtime.js` 的 `COMPONENT_BY_MAJOR`）：

| Java | 组件 |
|---|---|
| 8 | `jre-legacy` |
| 16 | `java-runtime-alpha` |
| **17** | **`java-runtime-gamma`**（1.20.1 要的就是它，实测 17.0.15 LTS / Microsoft build） |
| 21 | `java-runtime-delta`（1.21.1 要的） |

**这条链路为什么比 Adoptium 好**：① 不用挑平台包、不用解压、不用改权限位；② 目录结构就是 `<mcRoot>/runtime/<组件>/`，而 `collectJavaCandidates()` 本来就会扫 `<mcRoot>/runtime` 和 `%APPDATA%\.minecraft\runtime` —— 下完直接就被认出来，不需要额外登记；③ 版本 json 里 `javaVersion.component` 直接给了组件名，不用自己推。Adoptium 的 JRE17 zip 是 43.7 MB（比 86.9 MB 小），但要处理解压与平台判断，**没有采用**。

**实测**：403 个文件并发 8 下 174 秒，其中 3 个失败（`bin/server/jvm.dll`、`bin/jsvml.dll`、`lib/modules` 停在 55.1 MB 的 `.part`）；换 `concurrency: 4` 重跑 **12.1 秒补齐**（新下 3 / 复制 208 / 跳过 192 / 失败 0，复制是因为同一 sha1 的 URL 变体已经下过）。

### 13.2 沙箱不给子进程管道（EPERM）—— 影响三个模块

**现象**：`spawn/spawnSync/execFile` 只要 `stdio` 里有 `'pipe'` 就 `EPERM`（`spawnSync ... EPERM`）。**可用形状**只有文件描述符：`fs.openSync(log,'w')` → `stdio:['ignore', fd, fd]` → 父进程立刻 `closeSync(fd)` → 跑完读日志。

**它此前悄悄打断了三处**：

1. `lib/core/version-install.js` 的 `runInstaller`（原 `execFile` + `maxBuffer`）→ 安装器根本跑不起来；
2. `lib/core/java.js` 的 `probeMajor`（原 `spawnSync` 收 `-version`）→ Java 装了也判不出来；
3. `lib/core/java.js` 的 PATH 探测（原 `spawnSync(where,['java'])` 判 `status===0`）→ **`where` 自己 spawn 失败，状态码非 0，于是 PATH 里的 Java 从来没被发现**（这条最阴，因为「找不到 Java」看起来像正常的探测结果）；
4. `lib/core/launch.js` 的 `spawn`（原来挂 `child.stdout.on('data')` 喂日志）→ 在 fd 模式下 `child.stdout` 是 `null`，必须改成「定时增量读日志文件」。

**收口**：新增 `lib/core/proc.js`（`captureCommand` / `captureCommandSync` / `readFileTail`），三处全改过去，`test/proc.test.mjs` 7 条守着（含超时强杀、`maxBytes` 只留尾、程序不存在不抛）。

### 13.3 Forge 的版本列表是 XML，且 BMCLAPI 不代理它

- 正确地址：`https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml`（213 KB，官方 0.9 s / BMCLAPI 镜像 3.3 s）
- **NeoForge 才是 JSON 目录接口**（`bmclapi2.bangbang93.com/neoforge/meta/api/maven/details/releases/net/neoforged/neoforge` 200、1859 条）
- **BMCLAPI 的 neoforge 目录接口不代理 Forge**：`.../net/minecraftforge/forge` → **404**。所以 Forge 只能走官方地址 + 镜像改写规则（`MIRROR_RULES` 里已有 `maven.minecraftforge.net → bmclapi2/maven`）
- 推荐版本查 `https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json`（4 KB，`1.20.1-recommended = 47.4.28`）
- 实现：`http.text()` 拿原文 + `parseMavenMetadataXml()` 正则抽 `<version>`（不取 `<latest>`/`<release>`，因为 Forge 的 latest 是给新 MC 用的）

### 13.4 Forge 1.20.1 装出来的版本目录带 mc 前缀

安装器 `--installClient` 之后磁盘上出现三个版本目录：`versions/1.20.1`、`versions/1.20.1-forge-47.4.28`、`versions/Forge1201`（最后一个是安装器按 `profile` 字段建的空壳）。而 `install_profile.json` 的 `profile` 是 `forge`、`version.json` 的 **`id` 是 `1.20.1-forge-47.4.28`**。

NeoForge 1.21.1 的规则是 `neoforge-21.1.228`（无 mc 前缀），所以原来「一律 `<loader>-<版本>`」的猜测在 Forge 上必然错，表现是实例 json 的 `inheritsFrom` 指向不存在目录 → 启动报「找不到版本 json」。

**现在的规则**（`locateLoaderVersion`）：`preferredId`（用安装器自己 version.json 的 `id`）→ `<mc>-<loader>-<v>` → `<loader>-<v>`，且**按磁盘上真实存在的 `versions/<id>/<id>.json` 挑**，都不存在才退回第一个候选。

### 13.5 下载要能补第二遍（真机逼出来的）

资源 CDN 在 8 并发下会零星 `429` / `fetch failed`：第一次装 1.20.1 时 **651 MB 资源下完仍剩 6 个文件**，`VanillaIncomplete` 直接让整个底座报废。`applyItems` 现在有两轮：失败的降到 **2 并发**、按 `1000 + index%3*700` 毫秒错开再试（`retryFailures:false` 可关）。实测那 6 个全部补齐。

清单类请求同理：BMCLAPI 偶发 `ECONNRESET`、官方偶发 TLS 被掐，`fetchManifest` 改成「每个地址 3 次 × 1.2 秒间隔」。

**网络实况记录**：`piston-meta.mojang.com`、`resources.download.minecraft.net`、`bmclapi2.bangbang93.com` 都能 1 秒内返回 200，也可能连续多次 `Client network socket disconnected before secure TLS connection was established`，失败率约一半且成段抖动（同一 URL 隔 15 秒再试就成功）。**别把单次网络失败当代码 bug。** 另外 `pwsh` 里的 `Invoke-WebRequest` 一律 TLS 失败，联网只能走 node 的 `fetch`。

### 13.6 1.20.1 Forge 47.4.28 实装与启动实测

| 阶段 | 数据 |
|---|---|
| 计划 | 3,728 文件 / 751.8 MB（vanilla 3665、asset 3598、core 67、loader 63、java 0 —— 本机已有 Java 17 所以不需要下） |
| 安装器 | `forge-1.20.1-47.4.28-installer.jar` 8.4 MB，参数 `--installClient <mcRoot> --offline`（`--help` 确认支持带目录） |
| 实装 | **380.1 秒**（其中补下那 6 个文件 247 秒），`files={vanilla:6, vanillaSkipped:3659, loader:62, loaderSkipped:1}`，客户端 jar 23,028,853 B 复制成功，尾部 `Successfully installed client into launcher.` |
| 启动计划 | 版本 `Forge1201`、主类 **`cpw.mods.bootstraplauncher.BootstrapLauncher`**、libraries 117（rules 跳过 24）、classpath **73 项**（72 库 + 1 客户端 jar，9,720 字符）、natives 7 条、磁盘缺失 0、JVM 24 / game 32 |
| 启动 | **17.3 秒到主菜单**，判据 `[Render thread/INFO] [minecraft/SoundEngine]: Sound engine started`，无 crash-reports |

实验产物在 `lab\_forge1201`（mcRoot，含 `runtime\java-runtime-gamma`、`versions\{1.20.1,1.20.1-forge-47.4.28,Forge1201}`）与 `lab\_forge1201-run`（gameDir，日志在 `logs\`）。探针脚本 `lab\_apply-forge2.mjs`（外层 5 次重试，`applyScaffold` 可反复跑）、`lab\_launch-forge.mjs`（`describePlan` + `launch`）、`lab\_probe-profile.mjs`（打印安装器产出的 profile/version json）、`lab\_probe-host-plan.mjs`（直接打面板用的 `/scaffold/preview` 处理器，检查字段有没有 `undefined`、JSON 往返后 `javaRuntime` 还在不在）。

**面板这一层还没人真点过**：界面与宿主的接缝靠两套测试守着（`test/client-scaffold-ui.test.mjs` 6 条：会用真重渲染的最小 React 走「填根目录 → 填包名 → 算计划 → 开始装 → 连上新包」，并断言「本机 Java 版本不对时计划卡要说明会先下官方 Java」「本机一个 Java 都没有时『开始装』不能是灰的」；`test/host-api.test.mjs` 守路由形状）。复验时注意：那个测试替身的 `textOf` 必须**展开自定义组件**（`Kv` 这类把 label 放在 props 里的组件，不展开就只剩值、断言「界面上有这句话」会假失败）。

### 13.7 测试基线变化

| 阶段 | 套件 | 条数 |
|---|---|---|
| 本章之前 | 31 | 432 |
| 本章之后 | **33** | **457**（+proc 7、+java-runtime 10、+version-install 4、+locate 1、+界面「从零装底座」2） |

---

## 14. 2026-10-30 追加：蓝图提到最前 + 任务节点右键编辑（界面对模型/用户都开放）

用户这一轮的原话（m00759，逐字）：「你的界面形式不太合适，对使用者来说，优先应该看到的是蓝图编辑的功能，而且你做的蓝图模块无法编辑，不过已经能够看到3D图标了，值得肯定。现在需要加上右键编辑的功能，这样更符合用户直觉」。要点三条：**① 蓝图优先；② 蓝图要能改；③ 用右键，符合直觉**。

### 14.1 界面结构的改动（`lib/client.js`）

- **段落重排**：面板不是路由，十四个 section 依次 `children.push`，画布原来排最后（原「⑫ 拖拽画布」，2383–2648 行）。现在渲染末尾统一重排：
  ```js
  const restEls = children.slice();
  const lead = restEls.slice(0, 1);          // 「① 连接整合包」永远第一段
  const others = restEls.slice(1);
  const shownOthers = viewMode === 'canvas' ? [] : others;
  const ordered = [viewToggle, ...lead, ...(canvasSection ? [canvasSection] : []), ...shownOthers];
  children.length = 0; children.push(...ordered);
  ```
  画布段必须**先存成 `canvasSection = h(...)`**，不能靠 `element.key` 事后挑出来 —— 界面测试替身的 `createElement` 把 `key` 塞进 `props`，`element.key` 永远是 `undefined`。
- **两种视图**：`viewMode` = `'all'`（默认）/ `'canvas'`。默认 `'all'` 是有意的：`'canvas'` 会把「从零装底座」等段落藏起来，新用户第一步就找不到入口；日常改任务的人自己点「只看蓝图」。
- **自动读取**：连上包 → 自动 `loadBook(false, true)`（读任务书，quiet 安静失败）→ 有 book 后自动 `loadCanvas()`。两个 `useRef` 守卫（`bookAutoRef` / `canvasAutoRef`，换包时 `[dir, instanceId]` 重置），免得 effect 里反复打请求。画布段守卫从 `if (summary && book)` 放宽成 `if (summary)`，任务书还没读出来时按钮文字是「先读任务书」。
- **安静失败**：自动读任务书失败时**不** `setError`（没装 FTB Quests 的包不该一开面板就红一片），原因存进 `bookSkip`，蓝图那段显示「这个包里没读到任务书：<原因>」；用户自己点「先读任务书」时才是非 quiet、会把真错误甩出来。`loadBook` 签名因此是 `(force, quiet)`。
- **界面测试替身的局限（要知道）**：`test/client-quest-ui.test.mjs` 的最小 React 里 `useEffect: () => { cursor++ }` —— **effect 不执行**，所以「连上包自动读任务书/自动读画布」这条只能在真界面上验证；测试里一律显式点按钮（`loadCanvas(box)` 内部先点「先读任务书」再点「载入画布」）。想让替身真跑 effect 也不行：`useCallback` 在替身里每次渲染返回新函数，dep 比对失效，容易死循环。
- 段标题「⑫ 拖拽画布」→ **「任务蓝图」**；说明三句：连线 = 要先做完 / 拖动 = 挪位置（松手只暂存黄框，点「保存这次挪动」才写）/ 右键 = 改这个任务。

### 14.2 右键菜单（用起来的部分）

- 触发：节点 `<g onContextMenu={(e) => openNodeMenu(e, node.id)}>`；菜单 `position:fixed`，坐标夹到窗口内（`Math.min(max(8, x), innerWidth - w - 8)`）。
- 收起：`nodeMenu` 为真时给 `document` 挂 `mousedown`（**捕获阶段**）+ `keydown`（Esc）。**坑**：判断 `e.target.closest('.mcstudio-menu')` —— 不判的话点菜单项的瞬间菜单就被摘掉了，click 永远到不了。
- 六项：改名字/副标题（转去 ⑨ 的老文字链路）、换图标物品、改前置依赖、在它后面加一个任务、（分隔线）删掉这个任务（danger 样式）。
- 右键之后的编辑卡（`nodeEditorCards()`）就在画布正下方：换图标（输入 `mod:item` + 36px 图标即时预览）、改依赖（全书任务可勾选、带过滤框、跨章节允许、每行带小图标和章节名）、删任务（先列出会被连带断掉的 dependents）、就地新建（`dependsOn` 自动接被右键的那个，坐标自动摆到下面 3 格）。统一 **预览（只算）→ 确认写入（真写）** 两态，写完以磁盘为准 `loadCanvas()` 刷新。

### 14.3 `lib/core/quest-node.js`（新文件，398 行）

导出：`parseDependencies`、`planNodeEdit({questDir, store, questId, icon, dependencies})`、`commitNodeEdit({plan, questDir, store})`、`planNodeDelete({questDir, store, questId})`、`commitNodeDelete({plan, questDir, store})`、`describeNodeEditPlan(plan,{apply})`、`describeNodeDeletePlan(plan,{apply})`。

- `parseDependencies` 三态：`undefined` = 不改；`[]` / `'[]'` = **清空**（真写出 `dependencies: []`）；数组或 JSON 字符串或逗号分隔串 = 设置。校验：存在性、非自依赖、最多 200 个。
- 错误码：`QuestBadItemId` / `QuestDepSelf` / `QuestDepMissing` / `QuestDepTooMany` / `QuestBadDependency` / `QuestNotFound` / `QuestNoChapter` / `QuestNodeRejected`（删完发现任务还在，回滚）/ `QuestBrokenAfterWrite`（写完读不回来，回滚）。
- 写盘纪律照抄 `lib/core/quest-move.js`：`writeFiles(plan.writes)` → `loadQuests` 重读 → `newErrorsOf` 有新增错误 → `restoreFiles(done)` 回滚并抛错。`writes` 为空时不建备份，直接返回 `{backups: [], lines: ['什么都没写…']}`。
- 删除**连带清掉全书对它的依赖**（可跨章节文件），返回 `dependents: [{id,title}]`、`affectedCount`。

### 14.4 `removeQuest`（加在 `lib/core/quests.js` 的 `patchQuestFields` 之后）

`removeQuest(source, questId, label = 'chapter.snbt')` → `{changed, source, index}`。按 `questsNode.items[i]` 的 start/end 算区间：有下一个元素就删到下一个开头，是最后一个就从前一个末尾删到它末尾；**尾逗号要额外补删**（SNBT 列表元素之间的逗号不在 span 里，`skipCommas` 跳过了）；删完 `parseSnbt` 自校验。删第一个 / 中间 / 最后一个 / 只剩一个都有测试。

### 14.5 四条新路由（`lib/host/api.js:410-413`，总数 36 → 40）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/quest/node/preview` | GET / POST | 改图标、改依赖：只算 |
| `/quest/node/apply` | POST | 真写（备份 + 复查 + 回滚） |
| `/quest/node/delete/preview` | GET / POST | 删任务：只算，带 `dependents` 警告 |
| `/quest/node/delete/apply` | POST | 真删（连同下游依赖） |

参数：`{dir, id, questId, locale, icon, dependencies}`。**`dependencies` 面板传的是 JSON 字符串**（`'"["AB12"]"'`），解析规则只有 core 里那份 `parseDependencies`。返回**不透文件正文**（只有 `files[{name,path,bytes,created}]`）：

```js
// 改图标/改依赖
{ kind:'node-edit', questDir, locale, questId, questTitle, changedCount,
  changes:[{field,label,before,after}],   // before/after 字符串；dependencies 这条是数组
  diff:['图标：（空） → minecraft:diamond', …],  // 一句一句人话，字符串数组
  warnings:[…], files:[…] }
// 删任务
{ kind:'node-delete', questDir, locale, questId, questTitle, chapterId, chapterTitle,
  dependents:[{id,title}], affectedCount, changedCount /* = affected+1 */,
  warnings:[…], diff:[…], files:[…] }   // 注意：删除这条没有 changes 字段
// apply 额外：backups:[…], lines:[…]
```

### 14.6 工具层（总数 28 → 29）

- `mc_quest_patch`（`lib/tools/quests.js`）新增 `icon`、`dependencies` 两个参数，和 title/subtitle/x/y 一起合并成**一次写盘、一套备份、一次复验**；它**不走** `commitNodeEdit`（走 core 的 commit 会写两遍盘）。输出多 `changedCount`。
- 新增 `mc_quest_remove`（`lib/tools/quest-write.js`）→ 输出 `{ok, action, apply, changed, questId, dependents（字符串，如「齿轮（BBBB0002）」）, files, diff, backup, lines}`。
- `lib/tools/registry.js` 注册。`test/plugin.test.mjs` 用 `TOOL_FACTORIES.length` 断言，数字自动跟上；只有 `test/host-api.test.mjs` 的路由数 36 是硬编码，已改 40。

### 14.7 一个真弄错的地方：`diff` 是字符串数组，不是对象

面板原来（`lib/client.js` 早期版本）对 `diff` 每一项取 `d.label / d.before / d.after` 渲染，而契约里 `diff` 是**人话字符串数组**，于是界面上每行都显示成「（空） → （空）」。已改成逐句照抄（`h('span',{…}, String(d))`），并在 `test/client-quest-ui.test.mjs` 里加了断言：必须出现 `图标物品：demo:cogwheel → demo:gear`、**且不能出现 `（空） → （空）`**。以后凡是往 payload 里塞「给人看的对比」，先想清楚是对象还是字符串。

### 14.8 测试基线

| 阶段 | 套件 | 条数 |
|---|---|---|
| §13 之后 | 33 | 457 |
| §14 之后 | **34** | **494**（+`test/quest-node.test.mjs` 20、`client-quest-ui` 4→9、`quests` +6、`quest-api` +6、`host-api` 24→28、`plugin` 路由数 36→40） |
| §15 之后 | 34 | 495（+`client-plugin` 配色守卫 1 条） |
| §16 之后 | 34 | **496**（+`client-quest-ui` 中文搜索 1 条） |
| §17 之后 | 34 | **496**（条数不变：同一条用例里加了「打开即列一屏」的断言） |
| §18 之后 | 34 | **498**（index 16→18：变体键不造物品/不给名字、不盖正名、%s 不当名字） |
| §19 之后 | 34 | **510**（index 18→20 简介解析；item-icon 10→17 液体/客户端 jar/block 模型兜底/传送带不出图；client-quest-ui 10→11 悬停简介） |
| §20 之后 | **36** | **540**（新增 png-frame 3、icon-web 24；client-quest-ui 11→13 MC百科 成功/失败；host-api 28→29 `/item-icon/web`；plugin 路由 40→41） |

### 14.9 还没验证的

- **真界面上没人点过**右键链路（脚本 + 界面测试替身都过了，但没有人在真实 GUI 里点一次）。
- 蓝图在**大包**（重度机械症 13633 文件 / 上千任务）上的首次渲染性能没测 —— 现在是一次性拿全书节点，`ensureIcons` 批量取图标。
- 删除任务**不会**顺手调整其它任务坐标，删完画布可能出现空洞。
- `mc_quest_remove` **不在** `mc_quest_patch` 的备份体系里，各自一套（都是 `.bak-<时间戳>`）。

---

*本文档所有数字均来自本机实测或源码阅读，无推测。探针脚本在 `tools/` 与 `lab/`，参考材料在 `ref/`。*

> 2026-10-31 补记：§20.3 里那段 `signAliasOf` 代码已被 **§21.4** 的写法取代（旧正则漏掉没有颜色前缀的画布告示牌）；图标相关的基线以 **§21.7**（36 套件 / 547 通过）为准。
*§2.8 / §4.8 / §4.9 / P8 / P9 为 2026-10-28 用户第二轮核对后追加，已覆盖原文冲突假设。*
*§4.1 / §4.2 / §4.4 / §9-5 的修正为 2026-10-28 第三轮探针复核后追加（单复数配方目录、modId 三种回退、计时实测）。*
*§4.8（sha1 反查）/ §4.10（八源实测 + CF key 步骤）/ §4.11（起包最小链路）/ §12（自评 90%→94%）为 2026-10-28 第四轮追加，同日已真启动 `Mechanomania` 成功进主菜单（55s）。*
*§4.12（已实现工具清单与实测口径）为 2026-10-28 第五轮追加，对应 P0–P5 + P9 的代码落地。*
*§13（Java 运行时自动获取 / 沙箱管道 EPERM / Forge 版本列表与目录名 / 下载补遍 / 1.20.1 Forge 实装与启动）为 2026-10-30 追加，同日 1.20.1 Forge 47.4.28 从零装完并 17.3 秒启动到主菜单，测试基线 33 套件 / 457 条。*
*§14（蓝图提到最前 + 任务节点右键编辑 / `lib/core/quest-node.js` / `removeQuest` / 四条 node 路由 / `mc_quest_remove`）为 2026-10-30 追加，测试基线 34 套件 / 494 条。*

## 15. 2026-10-30 追加：面板配色重做（主题变量只有 14 个，写错就整片发灰）

### 15.1 症状与真因
用户：「文本显示太暗了，根本看不清」。看上去像审美问题，实际是**变量名写错**：主题里拿不到值，CSS 就一路退到兜底，而兜底正是 `#8a8a8a` 这类灰和 `rgba(255,255,255,.04~.07)` 这种几乎透明的白。

写错的名字（全部不存在）：`--dsw-alias-fill-l1`、`--dsw-alias-fill-l2`、`--dsw-alias-fill-l3`、`--dsw-alias-label-tertiary`、`--dsw-alias-fill-brand`、`--dsw-alias-bg-l2`。

**关键认知：`var(--不存在, 兜底)` 是完全合法的 CSS**，不报错、不警告、控制台一行都没有。所以「样式看起来生效了一部分」是最典型的误判来源 —— 命中的永远是兜底值。

### 15.2 真名单（唯一权威来源）
`cordis_inspect_query` → platform `client` / provider `Theme` / method `listTokens`，返回 14 个 token，每个都标了 `requiresLightAndDark: true`（插件必须自己在明暗两套下都成立）：

| 变量 | 用途 |
| --- | --- |
| `--dsw-alias-bg-base` / `-bg-layer-1` / `-bg-layer-2` / `-bg-overlay` | 底 / 一级面板 / 二级嵌套面 / 浮层（菜单用它） |
| `--dsw-alias-border-l1` / `-border-l2` | 细边框 / 强调边框 |
| `--dsw-alias-brand-primary` | 品牌色（**不是** `fill-brand`） |
| `--dsw-alias-label-primary` / `-label-secondary` | 正文 / 次要文字（**没有** tertiary） |
| `--dsw-alias-state-error-primary` / `-idle-primary` / `-success-primary` / `-warn-primary` | 语义色 |
| `--dsw-specific-sidebar-fill` | 侧栏底色 |

### 15.3 落地方式
在 `.mcstudio-root` 上把真 token 收进七个自有变量，后面所有规则只认这七个，改主题只要改这一处：

```css
.mcstudio-root{
  background:var(--dsw-alias-bg-layer-1,#17191d);      /* 自带底色：变量没解析也不会白字配白底 */
  color:var(--dsw-alias-label-primary,#eceef2);
  --mcs-fg:var(--dsw-alias-label-primary,#eceef2);
  --mcs-fg2:var(--dsw-alias-label-secondary,#b9bcc6);
  --mcs-surface:var(--dsw-alias-bg-layer-1,#1a1c20);
  --mcs-surface2:var(--dsw-alias-bg-layer-2,#23262c);
  --mcs-line:var(--dsw-alias-border-l1,#3c404a);
  --mcs-line2:var(--dsw-alias-border-l2,#565b67);
  --mcs-brand:var(--dsw-alias-brand-primary,#3d6dfa)}
```

配套的尺度调整（都是「看不清」的一部分，不只是颜色）：

- 正文 13 → **13.5px**、行高 17 → 18px；按钮/输入 12 → **13px**；说明与键名 12 → 12.5px；键名列宽 66 → 74px。10~11px 的小字在侧栏里基本属于「能看出有字、读不出内容」。
- 一切灰字改 `--mcs-fg2`，不再自己调灰；`opacity:.55` 的章节名标签直接去掉透明度（半透明在浅色主题下等于消失）。
- 语义块错误/警告/成功改走 `state-*-primary`，底色仍用留一点透明度的同色，保证浅色主题下也有边界。
- 右键菜单底色改 `--dsw-alias-bg-overlay`（浮层专用），标题行从「`.72` 透明 + 11px」改成 12.5px 加粗 `--mcs-fg2`。

### 15.4 SVG 的特殊性（踩过）
蓝图节点是手写 SVG。**presentation 属性不接受 `var()`** —— `h('rect',{fill:'var(--mcs-fg)'})` 生成的 `fill="var(...)"` 不会被解析，颜色静默失效。必须写成 `style:{ fill:'var(--mcs-fg)' }`。本次改的位置：

- 节点底 `--mcs-surface2`、选中 `--mcs-surface` + 描边 `--mcs-brand` 2px、拖动未存 `state-warn-primary` 2px、默认描边 `--mcs-line2`；
- 连线 `--mcs-line2`、箭头 `--mcs-fg2`；
- 节点标题 `--mcs-fg` 11.5px、无图标时的字母方块 `--mcs-fg2`。

### 15.5 守卫测试
`test/client-plugin.test.mjs` 新增「样式只用主题里真有的变量」：六个幽灵变量名逐个断言不出现、正文色必须 `label-primary`、`.mcstudio-root` 必须自带 `bg-layer-1` 底色、字号不许退回 12px、不许出现写死的 `color:#8a8a8a` 与半透明白文字。原先那两条「白底白字」断言匹配的正是幽灵变量 `fill-brand`，等于一直在验证一个不存在的东西，这次一并改成 `--mcs-brand`。

### 15.6 基线
34 套件 / **495 通过 / 0 挂**（比 §14 多 1 条配色守卫）。本轮只动 `lib/client.js` 与一份测试，宿主无改动 → **刷新页面即可，不用重启 DSH**。
*§15（面板配色重做 / 主题只有 14 个 token / ar() 静默失效 / SVG 必须用 style）为 2026-10-30 追加，测试基线 34 套件 / 495 条。*

## 16. 2026-10-31 追加：换图标时的物品搜索（可视化下拉 + 中文）

### 16.1 需求与结论
用户原话：「换图标物品的时候新增一个下拉列表，可视化选择物品，如果是用搜索的方式，就适配一下中文（中文搜索）」。
**后端零改动。** `/items` 早就比显示名了，缺的只是面板给用户一个能看见、能点的入口。

### 16.2 中文搜索为什么本来就成立
- 路由：`GET /items?dir=&id=&q=&ns=&mod=&limit=` → `lib/host/api.js:309` `handleItems`，返回 `{total, shown, items:[{id,name,from,rank}], indexedMs}`。`q` 为空时不扫 jar，直接回 hint。
- 匹配：`searchItems(entries,{query,namespace,modId,limit,names})`（`lib/tools/item-search.js:47`）。`rankOf` 先比 ID，再比 `name.toLowerCase()`：**相等 4 / 前缀 5 / 包含 6**；同分按 ID 长度、再按字典序。所以「钻石」这种中文子串命中走的就是包含匹配。
- 名字从哪来（`lib/core/index.js`）：mod 读自己 jar 里的 `assets/<ns>/lang/en_us.json` 与 `zh_cn.json`（`langNames`，`zhNames` 优先）；原版读 `<mcRoot>/assets/objects/<hash前2位>/<hash>` 的语言文件（`assetsLang`；客户端 jar 里其实只有 `en_us`，中文要靠资源包那层）。索引期整理成 `_names` 表（物品 ID → 显示名），`/items` 每条就带 `name`。
- 结论：**只要面板把中文原样塞进 `q`，就能搜到**；不需要分词、不需要拼音、不需要另建中文索引。

### 16.3 面板实现（`lib/client.js`）
1. 状态分开存：`iconPick = {q, items, total, busy, error}` 与 `iconPickTimer`（ref）。**不能和 `nodeDraft.value` 混成一个状态** —— 一个是查询结果，一个是用户输入的 ID；混了就出现「列表是上一个词的、框里是新词的」。渲染时用 `iconPick.q === nodeDraft.query.trim()` 判断这份列表是否属于当前输入。
2. `searchIconItems(keyword)`：空词或没连包 → 清空；否则先占位 `busy:true`，**防抖 260ms** 后 `apiGet('/items',{dir,id:instanceId,q,limit:40})`；成功后把 40 个 ID 交给 `ensureIcons` 批量取图标（复用画布那条 `/item-icons` 链路，`itemIcons` 是全局缓存表）。
3. `pickIconItem(id)`：只做两件事 —— 把 ID 写进 `nodeDraft.value`、取那一个图标。
4. 卡片结构：搜索框（回车 = 选第一条）→ 候选 `.mcstudio-pick` 列表（每行 `ItemIcon` 22px + 「中文名（mod:item）」，`title` 给完整 ID）→ 原来的 ID 输入框 + 36px 预览图标。列表复用依赖选择框那套样式，没新增 CSS。
5. 文案分支：加载中「搜…」、出错 `.mcstudio-err`、没结果「换个说法试试（比如打「块」「锭」这种后缀）」、没连包「先连一个整合包再搜」、超过 40 条「共 N 个，只列了前 40 个」。

### 16.4 测试
`test/client-quest-ui.test.mjs` 9 → 10 条：新增「右键 → 换图标：可以打中文搜物品，点一下候选就填进 ID」。假宿主加了 `/api/mcstudio/items`（`{id:'demo:gear',name:'齿轮'}`、`{id:'demo:gear_big',name:'大齿轮'}`），断言：`q` 是**原样中文**「齿轮」、`limit=40`、候选里中文名和 ID 都在、点完 ID 框变成 `demo:gear`。
两个测试上的注意点：**防抖要真等**（`await new Promise(r => setTimeout(r, 340))`，替身不接管计时器）；**换包重置要 `clearTimeout` + 清 `iconPick`**，否则旧包候选会闪一下。

### 16.5 基线
34 套件 / **496 通过 / 0 挂**（比 §15 多 1 条）。本轮只动 `lib/client.js` 与一份测试，宿主无改动 → **刷新页面即可**。
## 17. 2026-10-31 追加：下拉列表看不见 + 中文输入回车被吞（两处界面侧真因）

### 17.1 症状与排查路径
用户反馈两条：「1.中文输入没法点击输入结果 2.没有找到下拉图标的列表」。
先怀疑后端（§16 刚说中文搜索本来就成立，所以更可能是索引/名字没进来），于是写探针 `lab/_probe-cn-search.mjs`：绕开界面，直接 `resolveInstance` → `indexInstance` → `searchItems`，把命中条数与前几条 ID/名字打出来。**结论是后端一直正常**，问题全在面板。顺手试了直接从宿主抓浏览器那份 `client.js`（`/plugins/??dsh-mc-modpack-studio/client.js`）比对新旧，结果 **404**，`/` 与 `/api/health` 都是 **401**（鉴权在路由之前）——**没法从外部确认浏览器拿到的是哪一版，只能让用户 Ctrl+F5 强刷**。

### 17.2 实测数字（探针，`node --import ./test/register.mjs lab/_probe-cn-search.mjs <实例目录> [instanceId]`）
| 实例 | 物品 / 配方 | 索引耗时 | `_names` | 中文名 | 典型命中 |
| --- | --- | --- | --- | --- | --- |
| `lab\_forge1201`（`Forge1201`） | 1844 / 1174 | 105ms | 1424 | 1400 | 「钻石」14、「安山岩」7、「铁锭」1、「木板」10、「diamond」75 |
| `Mechanomania` | 10450 / 11503 | 713ms | 8201 | 6896 | 「钻石」35、「齿轮」58、「安山岩」29、「铁锭」3、「cogwheel」47 |

「齿轮」在 Mechanomania 里能列出 `create:cogwheel`（齿轮）/ `create:gearbox`（十字齿轮箱）/ `create:large_cogwheel`（大齿轮）等 58 条 —— 中文名与 ID 全都对得上，说明 `assets/<ns>/lang/zh_cn.json` 这条链路是通的。

### 17.3 两处真因
1. **列表的渲染条件把「刚打开」排除了**：第一版只在 `iconPick` 有值、且 `iconPick.q === 输入框现值` 时渲染候选。可卡片刚打开时 `iconPick` 是 `null`，渲染出来就是一张只有空输入框的卡 → 用户看到「根本没有下拉列表」。**教训：让用户从一堆东西里挑的控件，打开就必须有内容，不能等用户先打字。**
2. **输入法的回车被当成「选第一条」**：`onKeyDown` 里 `if (e.key === 'Enter') { e.preventDefault(); 选第一条 }`。中文输入法拼字时回车是「确认候选词」，`preventDefault()` 把它废掉，用户打 `zuanshi` 回车 → 字上不了屏，体感就是「中文输入没法用 / 点了没反应」。

### 17.4 代码改动（`lib/client.js`）
- `searchIconItems(keyword)` → `loadIconCandidates(keyword, namespace)`：`q`/`ns` 都 `trim`；目录兜底 `dir || summary?.instance?.instanceDir`；`(!q && !ns) || !target` 就清空；防抖 260ms 后 `apiGet('/items',{dir:target,id:instanceId,q,ns,limit:40})`，成功 `setIconPick({q,ns,items,total,busy:false,error:'',dir:target})` + `ensureIcons(...)`。
- **打开即预载**：`pickNodeAction('icon')` 里读当前图标 `create:cogwheel` → `loadIconCandidates('', 'create')`；节点没有图标就列 `minecraft`。命名空间搜索会走 `searchItems` 里 `q` 为空、只按 `ns` 过滤的分支（`rankOf` 在 `q` 为空时返回 8 = 全收，再按同分规则排序），所以「只给 ns」也能列一屏。
- **`iconLoadRef` 解决旧闭包**：`pickNodeAction` 是 `useCallback`、依赖数组里没有 `dir`/`summary`，直接调用 `loadIconCandidates` 拿到的是回调创建那一刻的闭包（换包后还是旧目录）。用 `const iconLoadRef = useRef(null); iconLoadRef.current = loadIconCandidates;` 每次渲染刷新，回调里走 `iconLoadRef.current(...)`。
- 搜索框：`onChange` → 有字全包搜、清空退回「列本 mod」；`onCompositionEnd` 再搜一次（有的浏览器输入法选完字不触发 `onChange`）；`onKeyDown` 回车前先挡输入法：`if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return;`。
- 卡片补充：两个快捷钮「列 `<ns>` 的物品」「列原版物品」、状态行「搜「X」命中 N 个 / 列 create 的物品，共 N 个」、空列表区分「没搜到（试试打 ID 的一部分）」与「先连一个整合包再搜」、未预载时「正在列这个 mod 的物品…」；候选项加 `role:'button'` 与 `title:'点一下就用 <id>'`。

### 17.5 测试
`test/client-quest-ui.test.mjs` 仍是 10 条，但在「右键 → 换图标：可以打中文搜物品」里插了 1b 段：打开卡片后等 320ms，断言**已经**出现 `params.ns === 'demo'` 的 `/items` 调用、`/item-icons` 批量取图标的调用、以及 `.mcstudio-pick` 列表存在且文本含「齿轮」。这条断言守的就是「打开即一屏」，改回「等用户打字」会立刻挂。

### 17.6 基线
34 套件 / **496 通过 / 0 挂**（测试条数没变，是同一批用例里加了断言）。只动 `lib/client.js` 与测试，宿主无改动 → **刷新页面即可**，但**要 Ctrl+F5 强刷**（旧 `client.js` 会被浏览器缓存）。

## 18. 2026-10-31 追加：有些中文名是错的（变体键把正式名盖掉了）

### 18.1 症状与探针
用户反馈：「现在有些物品的中文是错的，你先改一下」。
探针 `lab/_probe-names.mjs` 干三件事：扫每个 jar 的 `assets/<ns>/lang/zh_cn.json` → 把 `item.` / `block.` 键按「段数」分成「正名（3 段）」与「变体（>3 段）」→ 统计同一物品 ID 同时存在两类键、以及我们最终会取到哪个值。
`lab/_probe-names2.mjs` 则直接 `indexInstance` 后抽查具体物品的最终名字、统计「没名字」和「名字可疑（带 `_` / `%` / 超长）」的条数。

Mechanomania 实测：183 个 jar、94 份 `zh_cn.json`、6546 条 `item.`+`block.` 键 → **296 个物品存在冲突，277 个最终名字是垃圾**。

### 18.2 三处真因（都在 `lib/core/index.js`）
1. **`langNames` / `langIds` 按「段数 > 3 只取第三段」解析**，于是 `item.ns.x` 与 `item.ns.x.tooltip.summary` 落到同一个物品 ID 上，JSON 里靠后的 tooltip 覆盖掉正式名：
   - `block.create.flywheel` = 飞轮，被 `block.create.flywheel.tooltip.summary` = 「使用壮观的黄铜轮子_装饰_你的_机器_。」盖掉；
   - `create:clipboard` → 「_保留您的笔记_ 并使您看起来更加专业。」；
   - 原版同样中招：`minecraft:banner` → 「黄色顶波纹」、`minecraft:potion` → 「蓄风药水」、`minecraft:firework_rocket` → **「%s」**。
2. **带 `%` 的格式化模板被当名字**：`%s`、`飞行时间：%s` 直接显示出来。
3. **长键还造幽灵物品**：`minecraft:banner`、`mynethersdelight:blazier`（真物品是 `blazier_block`）这种游戏里不存在的 ID 进了物品表，在候选列表里表现为「一行没有图标的空白项」。

### 18.3 改法
- `langIds` / `langNames` 都改成**只认正好 3 段的键**（`item.ns.name` / `block.ns.name`）：长键既不算物品，也不当名字，连兜底都不当。**宁可界面显示 ID，也不显示错的中文。**
- 值里含 `%` 的跳过。
- 新增模块级 `const NAME_DEPTHS = new WeakMap()` + `function depthOf(into)`：每张名字表（`zhNames` / `enNames` / 汇总的 `names`）各记一份「该 ID 的名字来自几段键」。用途：
  - `indexJar` 里 zh 与 en 合并：**浅者优先，同深度才中文优先**（避免「中文只有 5 段说明文字、英文有 3 段正名」时选中那段说明）；
  - `indexInstance` 里跨 jar 合并：以前是「先到先得」，现在「名字更正经（段数更浅）的赢」，否则先扫到的 jar 里一句 tooltip 就能顶掉后扫到的正经译名；
  - `assetsLang` 那一层同样受约束，不再用长键盖掉已有正经名（`ns !== 'minecraft'` 只补空缺的老规矩保留）。
- 因为 `depthOf` 用 WeakMap 以名字表本身为 key，调用方签名不用改，也不会泄漏内存。

### 18.4 前后对比（Mechanomania 实测）
| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 物品总数 | 10450 | **10405**（45 个幽灵 ID 消失） |
| `_names` 条数 | 8201 | 8152 |
| 名字可疑（带 `_` / `%` / 超长） | 277 | **54**（剩下全是正常的长英文名，如 `Orange Wall Hanging Canvas Sign`） |

抽查（改后）：`create:flywheel` 飞轮、`create:schematicannon` 蓝图加农炮、`create:schematic_table` 蓝图桌、`create:clipboard` 剪贴板、`create:brass_funnel` 黄铜漏斗、`create:crushing_wheel` 粉碎轮、`minecraft:potion` 药水、`minecraft:firework_rocket` 烟花火箭、`minecraft:filled_map` 地图；搜「齿轮」56 条（`create:cogwheel` 齿轮 / `create:gearbox` 十字齿轮箱 / `create:large_cogwheel` 大齿轮）。

### 18.5 测试
`test/index.test.mjs` 16 → **18** 条：
- 老的三条按新规矩改写：变体键**既不造物品也不给名字**、tooltip 子键不给名字；
- 新增「变体键不能盖掉正名」（`block.create.flywheel` 与 `...tooltip.summary` 同 jar 出现，断言取「飞轮」且不含 `_`）；
- 新增「带 `%s` 的值不当名字」（中文是 `%s`、英文是正名 → 取英文）。
全量 **34 套件 / 498 条全过 0 挂**。

### 18.6 基线
34 套件 / **498 通过 / 0 挂**。宿主侧改动（`lib/core/index.js`）→ **必须重启 DSH**，重启后索引重算，面板候选与 `mc_item_search` 一起变对。

---

## 19. 2026-10-31 追加：图标三问（悬停简介 / 传送带图标 / 液体图标）

用户原话（m01860）：「1.需要补充一点，把鼠标挪到图标条目上一定时间后，要显示物品简介，如果没有物品简介就不显示 2.传送带的图标应该用错了 3.液体的图标没有显示出来，不论是原版还是mod」。

### 19.1 悬停简介：索引层从哪拿、界面在哪弹

简介的来源是**语言文件里的长键**，不是物品名。实测 Mechanomania 的 94 份 `zh_cn.json` 里，长键按后缀分布如下（`lab/_probe-desc.mjs`）：

| 后缀 | 条数 | 说明 |
|---|---|---|
| `tooltip.summary` | 137 | Create 系的「一句话说明」 |
| `tooltip.behaviour<N>` | 104 | 「右击时 / 潜行时」的结果半句 |
| `tooltip.condition<N>` | 104 | 与 behaviour 同序号的「条件」半句 |
| `desc` | 104 | 通用说明 |
| `tip` | 35 | 工具/附魔类短句 |
| `tooltip` | 19 | 老写法 |
| `desc<N>` / `guide` | 12 / 10 | 多段说明 / 图鉴 |

不是简介的长键要排除：`effect.*`（药水变体名）、`generation.*`（世界生成）、`page_*`（Patchouli 书页正文）。

`lib/core/index.js` 的落地：

- `DESC_PLAIN = new Set(['tooltip.summary','tooltip','desc','tip','guide'])`、`DESC_NUMBERED = /^desc\d+$/`、`DESC_PAIRED = /^tooltip\.(condition|behaviour)(\d+)$/`；
- `cleanDesc(text)` 去掉 Create 的 `_斜体_` 记号并压空白；
- `langDescriptions(lang, into)`：`%` 值跳过、`condition<N>`+`behaviour<N>` 合成「条件：结果」；
- `joinDesc(lines)`：最多 `DESC_MAX_LINES=6` 行 / `DESC_MAX_CHARS=400` 字，超了加省略号；
- **只有落在物品表里的 ID 才留简介**（语言文件里 `item.ns.x.desc` 有一堆对应的是自定义书页、成就文字）；中文优先、没中文退英文。

**`lang/default/*.json` 与 `lang/builtin/*.json` 也要读**：Create 系 mod 把 tooltip 拆进这些文件（`assets/create/lang/default/tooltips.json` 是最大的一份；Mechanomania 里 17 个文件 / 311 条 `item.`+`block.` 键）。用 `LANG_SPLIT_RE = /^assets\/[^/]+\/lang\/(?:default|builtin)\/[^/]+\.json$/` 匹配，**只当英文简介来源**，绝不用来造物品或起名字（这些文件里全是长键，拿来造物品会造一堆幽灵 ID）。

宿主：`handleItems`（`lib/host/api.js`）只在真有简介时给条目加 `desc` 字段 —— 界面靠「有没有这个字段」判断该不该弹。

界面（`lib/client.js`）：`hoverTip` 状态 + `hoverTimer` ref；`startItemHover(event, it)` **没有 `it.desc` 直接 return**，600ms 后才弹（划过列表不该一路闪）；坐标按 `Math.min(clientX, innerWidth - 340)` 夹住；`endItemHover()` 清定时器收气泡；`.mcstudio-tip` 是 `position:fixed` + `pointer-events:none`（气泡自己不能挡住下一次悬停）。换包时同时清状态与计时器。

**实测覆盖：10405 个物品里 299 个有简介（2.9%，中文 249 + 英文 50）。** 剩下 97% 是真的没有 —— Create 6 把大部分物品说明搬进了 Ponder 场景，语言文件里就是空的。**不编简介**：没简介的条目移上去不会有任何反应。

### 19.2 传送带：它不是物品，别拿方块条纹冒充图标

`create:belt` 在游戏里拿不到手上：blockstate 指向 `create:block/belt/particle`，模型是 `models/block/belt/{middle,start,end,…}.json` 一组，共用同一条 `textures/block/belt.png` 平铺贴图配 UV 子区域。原来按「同名 block 贴图」取到那条 16×16 的表面条纹当图标，看着就是错的（`lab/_png-ascii.mjs` 打出来是一排小结 + 中间近黑，不是图标的样子）。

新增判定 `isMultipartOnlyBlock()`：**有 `textures/block/<name>.png`、没有 item 贴图、没有 `models/item/<name>.json`、且存在 `models/block/<name>/` 这种目录形式的多部件模型** → 没有可用物品图标（返回 undefined，界面画字母方块）。

影响面审计（`lab/_probe-beltskip.mjs`）：全包 263 个「目录形式零件模型」里只有 **3 个**被拦（`create:belt`、`create:copycat_base`、`kaleidoscope_doll:doll`）；对照组 `minecraft:tnt`（有 item 模型）、`create:cogwheel`（有同名 block 模型）、`create:belt_connector`（走 item 贴图）都不受影响。

顺带一提：`create:belt_connector` 的中文名也叫「传送带」，所以列表里会出现两个「传送带」——一个是有图标的连接器（真物品），一个是没有图标的方块（拿不到手上）。

### 19.3 液体与原版图标：客户端 jar 也要索引

`lib/core/item-icon.js` 四处改动：

1. `TEXTURE_RE` 加 `textures/fluid/`，捕获组拆成「命名空间 / 种类 / 相对路径」；
2. `stillById` 表：`<base>_still` 优先于 `<base>_flow`，`resolveIcons` 在「原版 objects」之前多一轮液体兜底 → `minecraft:water` → `textures/block/water_still.png`、`minecraft:lava` → `lava_still.png`、`create:honey`/`chocolate` → `textures/fluid/*_still.png`；
3. `buildTextureIndex(modsDir, {extraJars})` 把**客户端 jar** 也索引（`resolveIcons` 自动取 `instance.clientJar`；缓存键 `indexCacheKey()` 算进 extraJars）→ 原版那 561 个「模型有、贴图找不到」的直接消掉；
4. 模型链兜底到 `models/block/<name>.json`（新 `blockModelsById` 表）；`textureRefsFromModel` 改成返回**候选数组**（layer0 → all → particle → texture → 其余字符串值），逐个试、全落空再跨 jar 查。

**前后对比（Mechanomania，10405 个物品）**：缺图标 **2869（27.6%）→ 866（8.3%）**；贴图条目 10113 → 11805；item 模型 7896 → 9650；block 模型 0 → 20578；液体表 70 条；索引耗时 2184ms → 3279ms。

⚠️ 旧数字勘误：以前报的「1828 个缺」是探针按 200/批 切，而 `resolveIcons` 的 `ICON_LIMIT=128` 会把每批静默截断（每批少算 72 个，1828/2869 ≈ 63.7% 正好对上）。以后统计缺图标必须按 `ICON_LIMIT` 切批。

**剩下的 866 个（诚实清单）**
- 687 个：jar 里既没有 item 模型、也没有同名 item 贴图 —— 只能靠「游戏自己导出的图标」那条路（`findExportDirs`）。
- 141 个：`parent: minecraft:builtin/entity`，游戏用实体渲染器画，罐里没有贴图（`cataclysm:wrath_of_the_desert` 这类）。
- 38 个：父模型跨命名空间、链断在 jar 边界（`cataclysm:ender_guardian_spawn_egg` → `minecraft:item/template_spawn_egg`）。实测能救回约 25–30 个，要改跨 jar 模型解析，收益小风险高，**没做**。
- `minecraft:` 还剩 88 个：一半是幽灵 ID（`minecraft:air`、`minecraft:handheld_rod`、`minecraft:template_bed`、`minecraft:generated` —— lang 键和模型父名漏进物品表的，属 `index.js` 侧），一半是真没有同名贴图（`minecraft:milk` 的贴图叫 `milk_bucket`；墙上告示牌这类只有 block 模型）。

### 19.4 测试

- `test/index.test.mjs` 18 → **20**：简介白名单（summary/desc/tip）/ 去 markdown 斜体 / condition+behaviour 合成 / 幽灵 ID 不留简介 / `%` 跳过 / 中文没有退英文。
- `test/item-icon.test.mjs` **17 条**：液体两种入口、`extraJars` 客户端 jar、block 模型兜底、候选落空继续试、跨 jar 取贴图、传送带不出图（+ `minecraft:tnt` 对照证明规则没做宽）、什么都没有进 `missing`。
- `test/client-quest-ui.test.mjs` 10 → **11**：悬停 600ms 才弹 / 移开收起 / 没简介不弹。

### 19.5 基线

**34 套件 / 510 通过 / 0 挂**。这一轮 `lib/core/index.js`、`lib/core/item-icon.js`、`lib/host/api.js`、`lib/client.js` 全都动了 → **必须重启 DSH**（重启后强刷页面）。

---

## 20. 2026-10-31 追加：竖排动图裁帧 + 墙上告示牌借用 + MC百科 按需兜底

> 起于用户第二轮反馈（m02626）：「1.mc百科里都有，难道是CurseForge里没有显示图标吗。把mc百科也纳入图标搜寻的网址 2.熔岩的图标还是没有，告示牌的也没有，去检查一下」。
> 上一轮（§19）已经解决了「液体贴图有没有被找到」，这一轮解决的是「找到了但画出来是错的」和「jar 里压根没有」。

### 20.1 三个症状与真因

| 症状 | 真因 | 改法 |
| --- | --- | --- |
| 熔岩/水/蜂蜜的图标看起来「没有」 | 贴图找到了，但 `textures/block/lava_still.png` 是 **16×320 的整条竖排动画**（20 帧），`water_still.png` 是 16×512（32 帧）。整条塞进 22px 的方框后只剩一条橙色细线 | `lib/core/png-frame.js` 裁第一帧 |
| 告示牌没有图标 | `minecraft:oak_wall_sign` 在 jar 里**没有独立贴图**（游戏里就是告示牌挂墙上，用同一张） | `signAliasOf(id)` 借用同名非墙版本 |
| 一堆物品压根没图（尤其刷怪蛋） | jar 里只有实体渲染或三维生成，没有 2D 图标；CurseForge/Modrinth 也**没有逐物品图标接口** | 按需去 MC百科 找（一张一张点） |

**关于「CurseForge 里是不是没有图标」**：CurseForge（`edge.forgecdn.net`）与 Modrinth 的 CDN 只提供**包/文件**本身和 mod 的 logo，没有「某物品的图标」这种资源；Modrinth 的 `/v2/project/<id>/icon` 是**模组**图标。所以「上网找物品图标」只有 mcmod 这条路（它有逐物品页、有 128×128 成品图），而且只能按需、单张。

### 20.2 `lib/core/png-frame.js`（我写的）

- `pngInfo(buf)` → `{ width, height, bitDepth, colorType, lineBytes, sections }`，只解析到 IHDR（13 字节：w/h/bitDepth/colorType/compression/filter/interlace）。
- `animatedFrames(buf)` → 帧数或 0：`height > width` && `height % width === 0` && `2 ≤ 帧数 ≤ 64` 才算动图（Minecraft 的液体/火焰是这种竖排格式；普通的 32×32 贴图 luckily 不会满足）。
- `pngFirstFrame(buf)` → 新的 PNG Buffer，只含前 `rows = width` 行：
  1. 按 `layoutOf(info)` 把每行解成 RGBA：**`bpp = max(1, 通道数 × 位深 / 8)`、行宽 `lineBytes = ceil(width × 通道数 × 位深 / 8)`**；
  2. 逐行反滤波（None / Sub / Up / Average / Paeth）；
  3. 只保留前 `width` 行，重新 `deflateSync`（level 9），自算 CRC32 拼出新的 IDAT；
  4. 调色板（colorType 3）要带上原 PLTE / tRNS。
- **踩过的坑**：`water_still.png` 是 **位深 4 的调色板图**，一开始按「一律 8 位」算行宽和 bpp，解出来的像素全是错位的彩条；按位深算才对。调色板索引在 4 位深时是「一个字节两个像素」，取值要 `(byte >> 4) & 0x0f` / `byte & 0x0f`。
- 实测：`lava_still.png` 16×320（20 帧）→ 16×16 / 1302 B；`water_still.png` 16×512（32 帧）→ 16×16 / 334 B。两者都是 `Mechanomania.jar → assets/minecraft/textures/block/…`。

### 20.3 墙上告示牌借用（`lib/core/item-icon.js`）

```js
function signAliasOf(id) {
  const m = /^([^:]+):(.+)_wall_hanging_sign$/.exec(id) ?? /^([^:]+):(.+)_wall_sign$/.exec(id);
  if (!m) return '';
  return /hanging/.test(id) ? `${m[1]}:${m[2]}_hanging_sign` : `${m[1]}:${m[2]}_sign`;
}
```

- 只有**前 4 轮全落空**时才走这一轮（第 5 轮），命中后 `source` 追加「（墙上的告示牌借用 `minecraft:oak_sign` 的图标）」，别让人误以为是自己的图。
- `iconFromPng(png, source)` 是把「PNG 字节 → data URL」统一收口的地方：动图调用 `pngFirstFrame`，返回里带 `frames`（方便以后做帧动画，现在只用第一帧）。

### 20.4 `lib/core/icon-web.js`（队友 `icon-web` 交付，我改节流）

- 接口面：`MCMOD`（`searchUrl(key)` 形如 `https://search.mcmod.cn/s?key=<encodeURIComponent>`、`itemUrl(id)` 形如 `https://www.mcmod.cn/item/<id>.html`）、`parseSearchHtml(html)` → `[{id, title, sub, modName, href}]`、`parseItemPage(html)` → `{id, title, modName, iconUrl, cover}`、`pickBestMatch(candidates, {name, modName})`、`cacheDir(mcRoot)` = `<mcRoot>\.dsh-icon-cache\mcmod`、`readWebCache` / `writeWebCache`、`resolveWebIcon({itemId, name, modName, mcRoot, fetchImpl, force})`、`searchMcmod(keyword)`、`resetCooldown()`。
- **图标地址要补协议**：页面里是 `//i.mcmod.cn/item/icon/32x32/6/67335.png` 这种协议相对 URL。实测 **只有 `128x128` 目录真实存在**（`32x32` / `64x64` 都 404），所以把路径里的尺寸段换成 `128x128`。
- **匹配必须保守**：搜「熔岩」的第一条是「熔岩风蛇 (熔岩風蛇) [魔法金属]」，直接取就是错的。规则是「标题完全等于中文名」且候选唯一；只有「包含」关系时还要求 mod 名也对得上。宁可不给，也不给错。
- **反爬是总频率限流**：`search.mcmod.cn` 连打十几次后返回 HTTP 200 + 正文「搜索太频繁」，之后一段时间全都这样。实测 **2.5 秒一次**连打四轮正常；350ms 不行。所以：
  - `SEARCH_GAP_MS = 2500`（搜索页单独一条线，`serialGet(url, { gap })`）；
  - `MIN_INTERVAL_MS = 600`（详情页 + 图标 CDN）；
  - 一旦撞到「太频繁」→ 进 **60 秒冷却**，期间 `resolveWebIcon` 直接回原因、不发请求。
- **缓存**：`<mcRoot>\.dsh-icon-cache\mcmod\index.json`（关键词/物品 ID → 结果与时间戳）+ `<sha1前12位>.png`。命中缓存 3ms，未命中首次 ≈1200ms。

### 20.5 新路由与「别用 ok:false 表达没找到」

`GET/POST /item-icon/web`（`lib/host/icon-api.js` 的 `handleWebItemIcon`）

| 参数 | 说明 |
| --- | --- |
| `dir` | 整合包实例目录（必填，走 `resolveInstance`） |
| `id` | 实例 id（多实例时必填） |
| `item` | 物品 ID，如 `minecraft:lava` |
| `name` | 中文名，作为搜索关键词（面板会从当前候选列表里取） |
| `mod` | mod 名，用于匹配时校验 |
| `force` | 跳过缓存重新查 |

返回 `{ ok:true, found:boolean, instance, item, name, source, title, dataUrl, cached, size, reason }`。

**为什么不是「没找到就 `ok:false`」**：面板的 `apiPost`（`lib/client.js:266`）判 `body.ok !== true` 就当请求失败、抛出 `body.error || '请求失败（HTTP <status>）'`。于是「mcmod 上没这条」会变成界面上的一句「请求失败（HTTP 200）」——原因被吞掉，用户以为插件坏了。界面测试抓到这条：假数据回 `ok:false` 时断言拿不到「没找到：…」。**结论：业务层的空结果永远 `ok:true` + `found:false` + `reason`，`ok:false` 只留给真的出错。**

### 20.6 测试

- 新增 `test/png-frame.test.mjs` **3 条**：竖排动图裁成方形（含 4 位调色板样例）、静态方形原样不动、帧数超过 64 不当动图。
- `test/icon-web.test.mjs` **24 条**（队友写）：搜索页解析、详情页解析、协议相对图标地址补全、`128x128` 替换、保守匹配（不认「熔岩风蛇」）、缓存读写、限流后退避、网络失败回 `{ok:false, reason}` 不抛。
- `test/client-quest-ui.test.mjs` 11 → **13**：MC百科 拿到图后立刻画进图标表；没找到必须把原因显示出来（用 `found:true` / `found:false` 两组假数据）。
- `test/host-api.test.mjs` 28 → **29**：`/item-icon/web` 没给 `item` 报 `IconNoItem`（这条不联网）。
- `test/plugin.test.mjs`：路由期望清单 40 → **41**（清单是**排序后**比对，`/item-icon/web` 排在 `/item-icons` 之前，插错位置就挂）。

### 20.7 基线

**36 套件 / 540 通过 / 0 挂**。这一轮动了 `lib/host/icon-api.js`、`lib/host/api.js`、`lib/core/item-icon.js`、`lib/core/png-frame.js`、`lib/client.js` → **必须重启 DSH**（新路由要重新注册），重启后 Ctrl+F5 强刷页面。

**仍未做（诚实列出）**：mcmod 批量补齐（会触发限流，命中率 25%，收益不值）；跨 jar 父模型解析（能救回 25–30 个图标）；`models/item/` 变体模型造出的幽灵 ID 清理（`minecraft:bow_pulling_1` 这类，属索引层）。

---

## 21. 2026-10-31 追加：传送带/绳索 —— 「拿在手上的物品」与「放置出来的方块」是两回事

> 起于用户纠正（m02963）：「传送带和绳索是有独立的能拿到手上的物品的，我之前给你的截图就是传送带的物品，你不要把放置出来的物品和手中的物品搞混了」。
> 这一章修正的是 §19 里一条**方向错了**的设计：当时把 `create:belt`（放置出来的方块）当成传送带本身，用 `isMultipartOnlyBlock` 拦掉它，还写成了「正面设计」。

### 21.1 实测：jar 里到底有什么

| 物品 ID | 是什么 | jar 里的证据 |
| --- | --- | --- |
| `create:belt_connector` | **能拿在手上**的传送带 | `assets/create/textures/item/belt_connector.png`（218 B）+ `models/item/belt_connector.json` |
| `create:belt` | **放置出来**的传送带方块 | 只有 `blockstates/belt.json` + `models/block/belt/*.json` + `textures/block/belt.png`（一条平铺条纹） |
| `create:rope` | 绳索 | 只有 `blockstates/rope.json` → `models/block/rope_pulley/rope.json` → `textures/block/pulley_rope.png` |
| `farmersdelight:rope` | 绳子 | `textures/block/rope.png`（第 1 轮就命中） |

- **「传送带图标用错」的真因不是图标算法，是物品表里有两条都叫「传送带」的记录**：`block.create.belt` 这个语言键被 `langIds` 当成物品，造出 `create:belt`，它跟真物品 `create:belt_connector` 同名。用户在搜索框里挑到前者 → 没图标 → 看起来就像「传送带的图标错了」。
- 也就是说：**手持物品那一半一直是对的**；错的是「同名幻影多出来一条」。

### 21.2 改动一：幻影方块去重（`lib/core/index.js`）

`indexJar` 新增三张集合，全部顺手在扫条目时填：

| 字段 | 来源条目 | 含义 |
| --- | --- | --- |
| `itemModels` | `assets/<ns>/models/item/<名字>.json` | 有物品模型 = 能拿在手上 |
| `itemTextures` | `assets/<ns>/textures/item/<名字>.png` | 同上，另一种证据 |
| `blockStates` | `assets/<ns>/blockstates/<名字>.json` | 放置出来的方块 |

`indexInstance` 把各 jar 的这三张表汇总成 `itemForm`（有 item 形态）与 `blockStates`，然后在原版中文名合并之后、`namespaces` 统计之前做去重：

```js
// 判据（两条都满足才删）：
// 1. 没有任何 item 形态证据（既无 models/item/<名字>.json，也无 textures/item/<名字>.png）；
// 2. **同一命名空间内**有同名、且有 item 形态的 ID。
// 只满足「有 blockstate」不删 —— `minecraft:lava` 这种方块本身还得当图标来源。
```

- **命名空间这一条是实测踩出来的**：`irons_spellbooks:voidstone` 与 `cataclysm:void_stone` 中文名都叫「虚空石」，按名字去重会把一个真物品删掉。收紧后 Mechanomania 只删 19 条（宽松时 50 条，多删的跨 mod 同名全是误删）。
- 返回值新增 `droppedAliases: [{ id, aliasOf, name }]` 与计数 `droppedAlias`，探针直接打印它（`lab/_probe-drop.mjs`）。
- 实测删除清单：`create:belt`（保留 `create:belt_connector`）、`create:water_wheel_structure`（保留 `create:large_water_wheel`）、`escalated:{metal,wooden}_*_walkway*`（保留 `*_walkway_steps`）、`kaleidoscope_cookery:tomato_crop`（保留 `:tomato`）、`minecraft:carrots/beetroots/potatoes`（保留 `carrot/beetroot/potato`）等。
- 物品总数 10405 → **10386**。

### 21.3 改动二：第 2.5 轮 blockstate → 模型 → 贴图（`lib/core/item-icon.js`）

前两轮（`textures/item` 直取、`models/item` 反查）都找不到时，`create:rope` 这类**贴图只挂在 blockstate 指的模型上**的物品仍然没图。新增：

1. `BLOCKSTATE_RE = /^assets\/([^/]+)\/blockstates\/(.+)\.json$/`，`buildTextureIndex` 里登记 `blockStatesById: Map<id, {jar, entry}>`（索引返回对象里多一个字段）。
2. `firstModelOfBlockState(json)`：递归取第一个 `model` 字符串，支持 `variants`（对象或数组里的 `{model}`）与 `multipart[].apply.model`。
3. 第 2.5 轮：`blockstate → models/<path>.json → textureRefsFromModel → 逐个试 zip.has → extract`。

**零件贴图要打分挑，不能取第一张**：一个方块模型常同时引用「一块石头 + 漏斗本体」（`andesite_block` + `funnel/andesite_funnel`），取第一张就会把石头当漏斗图标。规则：

- 把物品名按 `_` 切词（如 `andesite_belt_funnel` → `{andesite, belt, funnel}`），贴图基名同样切词；
- 命中词数多者优先；一样多时「多出来的词更少」者优先（`andesite_funnel` 命中 2 个且无多余词，胜过 `andesite_block` 的 1 命中 + 1 多余词）；
- **一个词根都不共享就不出图** —— 宁可画字母方块，也不拿石头冒充。

效果：`create:rope` → `textures/block/pulley_rope.png`；`create:andesite_belt_funnel` → `textures/block/funnel/andesite_funnel.png`；`create:brass_belt_funnel` 同理。

### 21.4 顺带：告示牌别名规则放宽（取代 §20.3 的旧写法）

§20.3 那段写死的正则漏了「没有颜色前缀」的画布告示牌（`farmersdelight:wall_hanging_canvas_sign`）。现在只保留一条规则：**把名字里的 `_wall_` 去掉**。

```js
function signAliasOf(id) {
  const colon = id.indexOf(':');
  if (colon <= 0) return null;
  const ns = id.slice(0, colon);
  const name = id.slice(colon + 1);
  if (!name.endsWith('sign')) return null;
  if (name.includes('_wall_')) return `${ns}:${name.replace('_wall_', '_')}`;
  if (name.startsWith('wall_')) return `${ns}:${name.slice('wall_'.length)}`;
  return null;
}
```

- `oak_wall_sign` → `oak_sign`、`white_wall_canvas_sign` → `white_canvas_sign`、`wall_hanging_canvas_sign` → `hanging_canvas_sign`。
- 别名不存在就没图，不会乱借（第 5 轮只在仍然缺图时才走一次）。

### 21.5 效果（Mechanomania 实测）

| 指标 | 补 22 之后 | 补 24 之后 |
| --- | --- | --- |
| 物品条数 | 10405 | **10386**（删掉 19 个幻影方块） |
| 缺图标 | 866（8.3%） | **702（6.8%）** |
| 索引耗时 | 3279ms | **559ms**（去重让物品表变小，取图更快） |
| 全量取图（分批 120） | — | 3.6s |

- 剩下的 702 个**大部分是刷怪蛋**（`cataclysm:*_spawn_egg` 等）：游戏里是三维实体渲染，jar 里根本没有 2D 贴图，只能按需走 MC百科（§20）。
- 探针注意：`resolveIcons` 内部 `ICON_LIMIT = 128` 会**静默截断**，一次丢一万个只会算前 128 个 —— 统计缺图率必须分批（见 `lab/_probe-missing.mjs`）。

### 21.6 测试

- `test/index.test.mjs` 20 → **23**：同名幻影要删（`create:belt` vs `create:belt_connector`）、熔岩这种没有同名真物品的必须留、跨命名空间撞名一个都不能删。
- `test/item-icon.test.mjs` 17 → **21**：blockstate 兜底出图、零件贴图按词根挑、一个词根都不共享就不出图、画布告示牌借用。`makePack` 新增第 4 个 jar `ropey-1.0.jar`（索引 jar 数断言 3 → 4）。
- **36 套件 / 547 通过 / 0 挂**。

### 21.7 基线

这一轮只动 core（`lib/core/index.js`、`lib/core/item-icon.js`）与两个测试文件，**没有新路由** → 面板刷新即可；但索引结果会缓存，换包/重启 DSH 后才会重新扫。

---

## 22. 图标只认「拿在手上的物品」（2026-10-31）

### 22.1 用户的原话与要求

> 安山传送带漏斗的图标是错的，我这边需要显示的只有物品的图标，不要放置出去的样子。这里显示的图标应该和jei里显示的差不多，物品类的只需要显示手拿的图标，流体类的先不动。我感觉是你的图标采集流程出了问题

拆成三条硬要求：
1. 物品类**只显示手持物品的图标**，不许用「放置出来的方块」的样子。
2. 尽量接近 JEI —— JEI 显示的是物品自己模型的渲染结果。
3. 流体类先不动（液体的 `_still` 那张就是对的）。

### 22.2 三处「拿方块外观冒充」的来源

| 来源 | 代码位置 | 后果 |
| --- | --- | --- |
| 第 2.5 轮 blockstate → 模型 → 贴图 | 补 24 新增的 76 行 | `create:andesite_belt_funnel` 拿到 `funnel/andesite_funnel.png`（**普通安山漏斗**的本体图） |
| 第 2 轮 `models/block/<名字>.json` 兜底 | `resolveIcons` 内 | 没有 item 模型的物品直接用方块模型，出来就是方块外观 |
| 第 1 轮 `byId` 一张表兼收 item / block | `buildTextureIndex` | jar 条目顺序里 `textures/block/` 在前，方块物品（tnt / 熔炉 / 工作台）拿到方块那张 |

第三处最隐蔽：**同一个物品在 `textures/item/` 和 `textures/block/` 里各有一张，谁先登记谁赢**，而 zip 条目是按字母序的，`block` 永远在 `item` 前面。

### 22.3 改动清单（`lib/core/item-icon.js`）

1. **删掉第 2.5 轮**：连带删 `BLOCKSTATE_RE`、`blockStatesById`、`firstModelOfBlockState`（grep 确认无残留）。`BLOCK_MODEL_RE` 保留，只用于「有没有方块形态」的判断，不再拿来出图标。
2. **第 2 轮只认 `models/item/<名字>.json`**（顺着 parent 追到 block 模型里的贴图仍然允许 —— JEI 也是这么画的）。
3. **新增 `itemTexById` / `itemTexByPrefix`**：只收 `assets/<ns>/textures/item/**`，第 1 轮先查这两张表，再退回 `byId` / `byPrefix`。
4. **3D 模型的贴图排序 `sortTextureRefs(refs, words)`**：
   - 判据一：贴图路径与物品名共享几个词根（`split(/[:/]/).join('_').split('_')` 去重计数）；
   - 判据二：`elements` 的面片面积之和，**竖面（east/west/north/south）×1.5、上下 ×1**；
   - 面积累计必须**跨 parent 层累加**到 `out.scores` 上、最后统一排 —— item 模型常常只有 `textures`，`elements` 在父模型里，在父层就地排序只能挪动父层新加的引用。
5. **贴图键名优先**：`layer0 → all → side → front → base → north → top → end → cross → particle → texture` 先挑一遍，再全收兜底（`cube_bottom_top` 的 `bottom` 原来排第一）。

### 22.4 前后对照（Mechanomania 实测）

| 物品 | 改前 | 改后 |
| --- | --- | --- |
| `create:andesite_funnel` | `block/andesite_block.png`（一块石头） | `block/funnel/andesite_funnel.png` |
| `create:brass_funnel` | `block/brass_block.png` | `block/funnel/brass_funnel.png` |
| `minecraft:tnt` | `block/tnt_bottom.png`（引信图） | `block/tnt_side.png` |
| `minecraft:furnace` | `block/furnace_front.png` | `block/furnace_side.png`（front 也挑得了，两者都对） |
| `create:andesite_belt_funnel` | `funnel/andesite_funnel.png`（**错**：那是普通漏斗） | **无图标（字母方块）** |
| `create:rope` | `block/pulley_rope.png`（方块外观） | **无图标** |

代价：**缺图标 702（6.8%）→ 947（9.1%）**。那 245 个在 jar 里只有「放置出来」的模型，按用户要求一律不猜，要图就点面板里「没有图标？去 MC百科找」（补 23）。

`minecraft:chest` 仍然是 `oak_planks.png` —— 原版箱子是实体渲染（`BlockEntityWithoutLevelRenderer`），模型里只有 `particle`，静态图取不到箱面。这是「不渲染 3D」这条路线本身的边界。

### 22.5 测试

- `test/item-icon.test.mjs` 21 → **20**：
  - 「block 模型兜底」→ 改成「方块外观不当物品图标：没有 item 模型的物品如实进 missing」；
  - 三条 blockstate 用例合并成「只有 blockstate 上的方块外观也不出图」；
  - 新增「item 贴图优先于同名 block 贴图（jar 里 block 条目排在前面）」；
  - `makePack` 里给 `kdoll:doll_vanilla` 补 `models/item`，跨 jar 那条用例才继续有效。
- 全量 **36 套件 / 546 通过 / 0 挂**。

### 22.6 基线

只改 core（`lib/core/item-icon.js`）与一个测试文件，**没有新路由**；但图标索引有 10 分钟 TTL 缓存且按进程存，**必须重启 DSH** 才看得到新结果（刷新页面不够）。

## 23. 等轴测渲染：自己把方块模型画成图标（2026-10-31）

### 23.1 为什么不能直接复用 JEI

JEI 是**游戏内 mod**：它在客户端进程里调用 Minecraft 的模型渲染器，用 OpenGL 当场把物品画出来。那些图标是**运行时渲染结果**，磁盘上不存在现成的图。

我们的面板是 DSH 里的网页（Node 宿主 + 浏览器），**不启动游戏**，只能按下述顺序找图：

1. `textures/item/<名字>.png` —— 2D 手绘物品图（JEI 里也是这张）
2. `models/item/<名字>.json` → parent 链 → 模型 → **等轴测渲染**（§23.2）
3. `blockstates/<名字>.json` / `models/block/<名字>.json` → 有 `elements` 就渲染
4. 同名平铺贴图（`textures/block`）兜底
5. 液体 still、原版 `assets/objects`、导出目录、MC百科 按需

真能「复用 JEI」的只有一条：**让客户端把图标渲染成 PNG 落盘，我们再读**。`findExportDirs` / `readExportedIcons` 那一轮已经在读导出目录（优先级最高），缺的只是一个导出脚本（用户尚未拍板）。

### 23.2 `lib/core/png-frame.js`：像素级读写

| 导出 | 作用 |
| --- | --- |
| `pngPixels(buf)` | → `{width,height,rgba}`。解 IHDR/PLTE/tRNS/IDAT，支持 colorType 0/2/3/4/6、位深 1/2/4/8/16；**不支持隔行**（interlace≠0 返回 null） |
| `encodePng(w,h,rgba)` | → Buffer。8 位 RGBA、滤波 0、`zlib.deflateSync(level 9)` |
| `pngFirstFrame` / `animatedFrames` | 竖排动图裁第一帧（§20） |

内部拆出 `splitPng` / `unfilterAll`，两者共用 `layoutOf(info)` 算出的 bpp 与行宽（`通道数×位深/8`），这是 4 位调色板图（`water_still.png`）能解的前提。

### 23.3 `lib/core/model-render.js`（新，约 400 行）

- 投影：`project(x,y,z) = [(x-z)·cos30, (x+z)·0.5 − y]`（等轴测，y 朝上、输出 y 朝下）
- 明暗：`up 1 / down 0.5 / north·south 0.8 / west·east 0.6`（与 Minecraft 自带一致）
- `loadModelChain(readJson, startRef, {maxDepth=6})`：顺 parent 链合并，textures 子覆盖父，`elements` 只要有子层就用子层
- `renderModelIcon({model, loadTexture, size})`：
  - **只画朝相机的三面**（法线·(1,1,1) > 0，即 up/south/east），背面剔除
  - 面按 `depth=(x1+x2+y1+y2+z1+z2)/2` **升序**画（画家算法，远的先画）
  - `fillTriangle` 屏幕空间重心插值 + 最近邻取样，`alpha < 128` 跳过（透明处留给后面的面）
  - 包围盒等比缩放到 `spec*0.94` 居中；`drawn===0` 返回 null
  - **不做**：`element.rotation`、tint、光照
- 六个面各自的默认 UV 按 MC 规则（`defaultUv`），`#变量` 最多解 6 层

### 23.4 接进 `lib/core/item-icon.js` 的三处

1. `renderIconFromModel(zip, entry, displayName, fallbackPng)`：解析模型 → `loadModelChain` → `renderModelIcon({size:48})` → `iconFromPng`，source 写成 `<id> → <entry>（等轴测渲染）`。
   - **贴图引用不带命名空间时要补**（`textures:{all:'block/tnt_side'}` 很常见），否则整张模型 `drawn===0`，静默退回平铺图 —— 这是本轮最难查的一个 bug。
2. 第 2 轮开头先试渲染，失败才退回「按词根+面积挑一张贴图」。
3. 新增**第 2b 轮**：`blockModelsById` / `blockStateById` → `firstModelOfBlockState` → 模型 → 渲染。
4. 新增**第 2c 轮**（在液体轮之前）：同名平铺贴图兜底，仍带 `isMultipartOnlyBlock` 排除传送带。
5. **第 1 轮只认 `textures/item`**（原来还会退回平铺贴图，导致渲染流程永远轮不到）。

### 23.5 效果（Mechanomania 实测）

| 指标 | 补 25（只贴图） | 补 26（渲染） |
| --- | --- | --- |
| 物品总数 | 10386 | 10386 |
| 有图标 | 9439（90.9%） | **9624（92.7%）** |
| 缺图标 | 947（9.1%） | **762（7.3%）** |
| 等轴测渲染 | 0 | **3445 个** |
| 全量取图耗时 | 3139ms | 7722ms |
| 索引耗时 | 550ms | 550ms |

形状体检（`lab/_probe-render-stats.mjs`，按不透明像素占比分桶）：0-12% 92 个、12-25% 378、25-45% 1182、45-80% 1767、**80-95% 与 95%+ 都是 0** —— 说明没有「投影算错、把整张贴图糊满整格」的情况。过细的都是本来就很细的模型（`create:piston_extension_pole` 3%、`copycats:copycat_slope` 7.2%、平盘食物 9~12%）。

渲染产物可以直接看：`lab/_probe-render.mjs` 会把示例图写到 `lab/_render-out/*.png`。

### 23.6 测试

- 新增 `test/model-render.test.mjs` **6 条**：顶面原色 + 东面 0.6 + 南面 0.8（用纯色贴图渲染后验色）、只有背面 → null、贴图拿不到 → null、没有 `elements` → null、parent 的 `elements` 被继承、子 `textures` 覆盖父。
- `test/item-icon.test.mjs` 20 → **21**：新增「物品模型带 elements 就整张画出来」（`minecraft:render_cube`）；`chain_rope` 从「不出图」改成「有 elements 必须出图」；夹具里补 `PNG_OPAQUE`（原夹具 PNG alpha=127，渲染器按透明跳过，会让人误判渲染器坏了）。
- 全量 **37 套件 / 553 通过 / 0 挂**。

### 23.7 基线与本轮遗留

只改 core，**没有新路由**；图标索引按进程缓存 → **必须重启 DSH**，然后 Ctrl+F5。

遗留：JEI 级图标的一次性导出通道（客户端渲染 PNG → `findExportDirs` 直接读）、`element.rotation` 与 tint 尚未实现（旋转方块会画成正的）。

---

## 24. P0 抽包 + P1 独立本地服务（2026-10-31）

这一章记录「从 DSH 插件转向独立软件」的头两步。方向文档是 `docs/archive/HANDOFF-STANDALONE.md`，这里只写技术细节。

### 24.1 为什么要抽 core

`lib/core`（36 个文件、约 12000 行）**没有任何 DSH 依赖**：只 import `node:` 内置模块和相对路径。这是整个项目最值钱的资产 —— 它是纯 Node 的领域逻辑，不碰界面、不碰 DSH 运行时。

抽出去之后，独立软件（Electron / 纯 Node 后端）可以直接 `import`，不用假装自己是个 DSH 插件。插件侧继续用同一份代码，两边不会分叉。

### 24.2 抽包的实际步骤

| 步骤 | 动作 | 注意 |
| --- | --- | --- |
| 1 | 整目录复制成 `packages/core/` | 36 个 .js |
| 2 | 新增 `packages/core/item-search.js` | 把 `rankOf` + `searchItems` 从 `lib/tools/item-search.js` 搬进来（约 60 行纯函数）。`tools/` 依赖 `@deepseek-ai/dsh-tools`，独立后端不该被迫装它 |
| 3 | 改 51 个文件的 import | `lib/tools/*.js`：`'../core/x.js'` → `'../../packages/core/x.js'`；`test/*.mjs`：`'../lib/core/x.js'` → `'../packages/core/x.js'`。脚本 `lab/_migrate-core-imports.mjs`（默认 dry-run） |
| 4 | 加 `packages/core/package.json` | `"type": "module"`、`exports: {"./*.js": "./*.js"}` |
| 5 | **删掉 `lib/core`** | 先备份到 `lab/_backup-lib-core/` |

### 24.3 为什么必须删掉旧的（一个真踩到的坑）

留着两份副本会制造**同一个类名、两个不同的类**：

- `lib/host/*.js` 从 `packages/core/errors.js` 抛 `McError`
- `test/*.mjs` 从 `lib/core/errors.js` 导入 `McError`
- 两个模块各自定义了一次 `class McError`，`instanceof` 判定为 **false**
- 但 `error.name` / 报错文案里类名一样，于是错误信息长这样：**「应该抛 McError，实际是 McError」**

看到这种错会浪费很久。删掉旧目录后全项目只有一个 `McError` 类，问题消失。

### 24.4 `dispatchStudioRequest`：插件和独立版共用一条派发

在 `lib/host/api.js` 里抽出：

```js
export async function dispatchStudioRequest(request) {
  // 1. 解析 pathname（允许带 /api/mcstudio 前缀、允许尾部斜杠）
  // 2. 在 ROUTES 表里找匹配项
  // 3. 校验方法（GET/POST）
  // 4. 调 handler，普通对象包成 ok()，Response 原样返回
  // 5. 异常交给 failure()（McError → 400 + code，其它 → 500）
}
```

`registerStudioApi(connection)` 现在只是把每条路由注册到 `connection.fetch`，`fetch` 里调 `dispatchStudioRequest`。独立版直接调同一个函数。

**好处**：路由表、参数校验、错误结构、plan/apply 语义全都只有一份实现。

### 24.5 `packages/server/server.js`

只做协议翻译：

| 方向 | 做什么 |
| --- | --- |
| 进 | `IncomingMessage` → `{url, method, headers, text(), json()}` |
| 出 | `Response` → `res.writeHead(status, headers)` + body |

三个细节：

1. **请求体只读一次并缓存** —— handler 可能既 `await request.text()` 又 `await request.json()`，重新读流会拿到空字符串。
2. **url 必须补 origin**：各 handler 里写的是 `new URL(request.url)`（DSH 传进来的是绝对地址），适配器只给 `/instances?...` 会抛 `Invalid URL`，表现为 12 条接口全部 500。改成 `http://localhost${req.url}` 后立刻正常。
3. **OPTIONS 直接 204** + 放开 `access-control-allow-*`：服务只监听 `127.0.0.1`，是本地页面在调。

### 24.6 验收

- `lab/_probe-server2.mjs`：起服务，打 17 条代表性接口 → **17/17 全通**（总览 518ms、搜物品 17ms、配方详情 14ms、任务书 22ms、画布 18ms、mod 搜索 559ms、打包预览 168ms、物品图标 266ms、装 mod 清单 2090ms）。
- `test/server.test.mjs` **7 条**：能起来 / 前缀有无都认 / 404 带路径名 / 405 列出允许方法 / POST 体能读到（用「建章节缺标题」反证 body 被读到）/ OPTIONS 204 + 跨域头 / 关掉后端口拒连。
- 全量 **38 套件 / 560 通过 / 0 挂**。

### 24.7 本轮遗留

1. SSE 进度流（长任务实时进度）—— 现在所有接口都是一问一答。
2. 静态文件托管（服务顺手把前端页面也发出去）。
3. `mcstudio serve` 命令行入口。
4. `lib/host` 仍留在 `lib/` 下（逻辑上属于 `packages/server`），P2 再搬，避免一次动太多。

### 24.8 一次批量替换事故（教训）

做 P0 时想批量改 import 路径，写了 PowerShell 函数 `Rewrite($path, $pairs)`，调用时传了「只含一个内层数组」的 `@(, @(@('a','b')))`。PowerShell 把它拍平成字符串数组，`$p[0]` / `$p[1]` 取到的是**字符串的前两个字符**，于是实际执行的是 `.Replace("'", ".")` —— **把单引号全换成了句点**。

受影响：`lib/tools/*.js`(16)、`test/*.mjs`(37)、`lab/*.mjs`(~90)。没有 git、没有备份可回滚。

修法：写词法逆向修复器 `lab/_repair-quotes.mjs` —— 按 JS 词法判断每个「点」到底是原来的点还是原来的引号。需要处理的边界：

- 字符串里的 `/` 会让「路径闭合」判断提前触发（`'../../core/x.js'`）
- 模板串 `${}` 内部是代码，要递归
- 正则字面量里的 `['"]` 会被误当引号（级联错的根源）→ 必须先扫出正则区间原样跳过
- `'ab'.repeat(3)` 这种「字符串后接属性访问」
- 行首的点：只有「链式调用」（后面紧跟 `(`）才是属性访问
- 中文句子里「. 」后面的点不是闭合

结果：**67/67 文件 `node --check` 全过、0 处未判定**，剩 5 处「双引号串里的单引号」手修，最后 **553 条测试一条不差** —— 这是修复忠实的证据。

**教训**：这个项目不是 git 仓库。任何批量替换前，先把文件复制到 `lab/_backup-*`，或者写「默认 dry-run、`--apply` 才写」的脚本。后者更省事，也已经成了本项目的习惯。

---

*§24 记于 2026-10-31：P0 抽包 + P1 本地服务完成，基线 38 套件 / 560 条。下一步 P2 前端（`packages/ui`），方向见 `docs/archive/HANDOFF-STANDALONE.md` §6。*

---

## 25. P2 第一版：浏览器工作台（2026-10-31 深夜）

### 25.1 换了什么形状

插件面板是「右侧栏里一列卡片，从上往下滚」。独立版要的是「左边一条流水线，右边一整块主界面」。

具体三处：

1. **阶段栏**：八步（建立项目 / 体检 / 内容 / 任务线 / 资源 / 打包 / 验证 / 交付），每步一个圆点：绿=做完、青=当前、灰=还没到。
2. **顶栏永远有一句「下一步：…」**，取自第一个没做完的阶段。
3. **主界面占满右侧**，不再是挤在窄栏里。

### 25.2 阶段状态怎么算（`packages/ui/stages.js`）

纯函数，不碰 DOM、不碰网络 —— 这是它能在 Node 里被测试的原因。

```js
stageStatus(facts) → [{ key, name, status, detail, action }]
nextStep(facts)    → { key, text }
```

判据表（`done` 条件）：

| 阶段 | 条件 |
| --- | --- |
| 建立项目 | `facts.connected` |
| 体检 | `facts.instance && facts.index` |
| 内容 | `index.itemCount > 0` |
| 任务线 | `facts.questBook`（0 个任务也算通） |
| 资源 | `iconsCovered > 0` |
| 打包 | `facts.exportPreview` |
| 验证 | `facts.launchResult` |
| 交付 | `facts.exportDone` |

然后是这条规则：**按顺序扫，第一个 `!done` 的标 `current`，它后面的一律 `todo`**。所以界面不需要维护「当前步骤」这个状态 —— 它完全由事实推出来，不可能和事实打架。

`detailOf()` 给每个阶段一句人话，比如任务线：`12 个任务、3 章`；体检：`1.21.1 neoforge，120 个物品、340 条配方`。

### 25.3 为什么不用 React / 不用构建

- 只有 8 个面板，元素总量在几百个量级，整体重建（`replaceChildren`）比 diff 更不容易错。
- 没有构建步骤 → 改完 `app.js` 刷新页面就生效，不用重启服务、不用等打包。这在「一边看效果一边改」时差别很大。
- 插件侧的 `client.js` 是 React 写的，但那套依赖 DSH 注入的 `react`；独立版要用就得自己带一份 React 运行时，属于「为了复用而引入一个更大的依赖」。

代价：输入框在重建时会丢焦点。处理办法是画完把焦点按 `data-focus` 还回去，并恢复光标位置：

```js
const focusKey = activeEl instanceof HTMLElement ? activeEl.dataset?.focus : null;
const caret = activeEl instanceof HTMLInputElement ? activeEl.selectionStart : null;
// …重建…
if (focusKey) { node.focus(); node.setSelectionRange(caret, caret); }
```

### 25.4 静态文件托管的穿越防护

`packages/server/server.js` 的 `tryStatic()`：

```js
let rel = pathname === '/' ? 'index.html' : null;
if (rel === null && pathname.startsWith('/ui/')) rel = pathname.slice('/ui/'.length);
if (!/^[A-Za-z0-9._-]+$/.test(rel) || rel.includes('..')) → 404
```

**关键设计**：只认「一层文件名」，所以 `../` 在拼路径之前就不合法，不需要做「解析后比较是否还在目录内」这种容易写错的检查。后缀还必须在内置白名单里（html/js/css/json/svg/png/ico）。

测试里专门断言了「响应体里不能出现源码内容」——因为 404 的 JSON 也可能不小心带上路径信息。

### 25.5 用 DOM 替身真跑一遍前端（`test/ui-app.test.mjs`）

这是这一轮最有价值的测试决定。

**问题**：这个沙箱里启动 Edge/Chrome 被拒（`Access denied`，浏览器要起子进程 + 写 profile）。所以「页面能不能跑」没法用真浏览器验。

**但**「渲染路径里引用了不存在的函数」只有真跑才暴露 —— 开发这一版时确实漏定义了 `truncate()`，浏览器里的表现是**整页空白 + 控制台一行红字**，很难从代码上看出来。

**做法**：写一个最小 DOM 替身（`FakeNode` + `document` + `location` + `localStorage` + 假 `fetch`），把 `app.js` 当模块 `import`，让它真的跑一次 `boot()` 和 `render()`，然后递归收集文字做断言。

覆盖到的：模块能加载、`render` 不抛、八个阶段名字都在、假接口的数据进了界面（`项目里的 lab`）、点「连接」后顶栏变成实例名。

**替身的两个坑**（记下来，下次写类似测试直接用）：

1. `el()` 里判断 `key in node`，而替身上没有 `data-focus` 这种属性名 → 会走 `setAttribute`。所以按 `[data-focus="x"]` 找元素时要**同时看属性和 `attrs`**。
2. `el()` 里 `kid instanceof Node` 要求替身挂在 `globalThis.Node` 上，且 `FakeNode` 要真的 `extends` 它，否则子节点会被当成文本 `String()` 掉。

### 25.6 基线

| 项 | 数字 |
| --- | --- |
| 套件 | **40**（新增 `ui.test.mjs` 13 条、`ui-app.test.mjs` 2 条） |
| 用例 | **575** 通过 / 0 挂 |
| 上一轮（P1 结束） | 38 / 560 |

### 25.7 这一版还没接的（下一轮）

改配方、改任务（换图标/改依赖/删任务）、拖拽挪位置、从零装底座、启动验证。

后端接口全都在（`/recipe/preview|apply`、`/quest/node/*`、`/quest/move/*`、`/scaffold/*`、`/export/*`），缺的只是界面按 plan → apply 两态把这些按钮接上。

---

## 26. P2 第二版：三栏工作台（2026-10-31 深夜，按用户要求重做）

### 26.1 用户为什么要重做

用户原话：

> 不应该是流水线铺出来，而是页面，选定项目后，进入制作阶段，随后体检。左侧栏是mod列表，可搜索导入整合包，中间是任务书蓝图编辑，右侧栏应该放什么我还没想好

拆成三条要求：

1. **「不应该是流水线铺出来，而是页面」** —— §25 那一版左栏是一条八阶段流水线，用户看着像流程图，不像一个干活的软件。
2. **「选定项目后，进入制作阶段，随后体检」** —— 项目选择必须是**独立的一屏**，不是顶栏里一个下拉框；进去以后先跑体检（读总览），这是进入工作台的第一个动作。
3. **「左侧栏是 mod 列表」「中间是任务书蓝图编辑」** —— 栏位是定死的；右栏用户明确说「还没想好」，留给我决定。

### 26.2 定下来的形状

**两个屏幕**，`state.screen = 'pick' | 'studio'`：

```
【屏幕一：选项目】
        整合包工作室
        先挑一个整合包
  ┌ 项目里的 lab ────────────────┐
  │ Mechanomania   1.21.1 neoforge │
  │ 最小包          1.20.1 forge   │
  └───────────────────────────────┘
  ┌ 手填目录 ─────────────────────┐
  │ [D:\...\versions\Mechanomania] [打开这个包] │
  └───────────────────────────────┘

【屏幕二：工作台】（占满整屏）
┌──────────────────────────────────────────────────────────────┐
│ Mechanomania · 1.21.1 · neoforge · 120 个物品 · 340 条配方    │
│                                        [重新体检] [换项目]    │
├──────────────┬────────────────────────────┬──────────────────┤
│ Mod 列表     │ 任务书蓝图（SVG，可拖可右键）│ 选中任务检查器   │
│ [搜索框]     │                            │ 详情 / 操作      │
│ 共 N 个      │  ┌──┐      ┌──┐            │ 计划卡 / 结果卡  │
│ Create       │  │甲│─────▶│乙│            │                  │
│ ...          │  └──┘      └──┘            │                  │
│ [刷新][装新mod]│                           │                  │
└──────────────┴────────────────────────────┴──────────────────┘
```

**右栏为什么放「选中任务检查器」**（用户把决定权留给了我，理由要写清楚）：中间是蓝图，用户点一个方块，最自然的下一步就是「改它」；而且所有写操作都是 plan → apply 两态，需要一个固定的地方放「计划卡」（改了哪几处、会写哪些文件）和「结果卡」（写了什么、备份在哪）。放在左栏会挤掉 mod 列表，做成弹窗会遮住蓝图 —— 右栏是最合适的落点。

### 26.3 `packages/ui/app.js` 的结构

全量重写，约 1050 行。保留 §25 的底层工具函数（`el()` / `api()` / `post()` / `run()` / `truncate()` / `kv()` / `card()` / `row()` / `btn()` / `iconImg()` / `ensureIcons()`），其余按三栏重排。

**状态**（`state`）关键字段：

| 字段 | 作用 |
| --- | --- |
| `screen` | `'pick'` 或 `'studio'` |
| `dir` / `id` | 当前项目（实例目录 / 实例名），写 `localStorage['mcstudio.instance']` |
| `summary` | `/summary` 的结果（= 体检），顶栏显示版本/加载器/物品数/配方数 |
| `mods` | `/mods` 的结果，左栏列表 |
| `book` | `/questbook` 的结果 |
| `canvas` | `/quest/canvas` 的结果，中栏蓝图 |
| `icons` | `id → dataUrl` 缓存，`ensureIcons()` 批量补 |
| `sel` | 当前选中的任务 ID |
| `draft` | 正在编辑的草稿（`kind`: `icon`/`deps`/`delete`/`new`/`rename`） |
| `plan` / `done` | 编辑的计划卡 / 结果卡 |
| `movePlan` | 拖拽的计划（确认才写） |
| `menu` | 右键菜单（`x` / `y` / `id`） |

**进工作台的顺序**（`connect(dir, id)`）：读 `/summary`（体检）→ 切 `screen='studio'` → 清空上一次的残留状态 → 写 localStorage → **并发**读 `/mods` 和 `/questbook`（任一失败不影响另一个）→ 有任务书就 `refreshCanvas()`。`refreshCanvas()` 拿 `/quest/canvas` 后把节点图标 ID 一次性丢给 `ensureIcons()`。

**左栏 `modRail()`**：`/mods` 的结果按 `name + modId` 做前端子串过滤（列表本来就在内存里，不必再打接口），**最多渲染 400 条**（几千个 mod 的包也不卡）。下半「装新 mod」展开搜索框：`/mod-search` → 每条一个「看要下什么」→ `/mod-install/preview` → 「就装这些」→ `/mod-install/apply` → 装完自动重读 mod 列表。

**中栏 `canvasSvg()`**：`CELL_X 132` / `CELL_Y 108` / `BOX_W 116` / `BOX_H 92`，四周留 48。连线画 `line.mcs-edge`，节点画 `g` + `rect.mcs-box`（选中 `mcs-box-sel`）+ `image`（图标）+ 三行 `text`。**配色全部走 CSS 类，不在 SVG 里写 `fill="var(--x)"`** —— presentation 属性不接受 `var()`，会静默失效（插件侧 §15.4 踩过同一个坑）。

**三种交互**：

1. **点** → `selectQuest(id)` → `/quest` 取详情 → 右栏出详情卡。
2. **拖** → `beginDrag()`：拖动期间**只改 DOM**（`group.setAttribute('transform', 'translate(dx,dy)')`），松手才把像素位移换算成格子坐标（`dx / CELL_X`、`dy / CELL_Y`，再 `snap(v) = Math.round(v*2)/2`），然后打 `/quest/move/preview` 出计划 —— **不是拖完就写盘**，右栏出「确认挪动 / 算了」，确认才走 `/quest/move/apply`。
3. **右键** → `openMenu()` 记 `clientX/clientY`，渲染 `position:fixed` 菜单六项：改名字/副标题、换图标物品、改前置依赖、在它后面加一个任务、（分隔）删掉这个任务。

**右栏 `inspector()`** 的渲染顺序：拖拽计划卡 → 编辑草稿卡 → 编辑计划卡 → 编辑结果卡 → 任务详情卡。详情卡给五个入口：改名、换图标、改前置、加后继、删掉这个任务。

**四种编辑草稿**（`draftCard()`）：

| kind | 内容 | 提交到 |
| --- | --- | --- |
| `icon` | 物品 ID 输入框 + 「搜物品」（走 `/items?q=`，支持中文）+ 候选列表（图标 + 中文名） | `/quest/node/preview` → `apply` |
| `deps` | 过滤框 + 跨章节勾选列表（排除自己） | 同上，`dependencies` 传 JSON 字符串 |
| `delete` | 先显示 `dependents` 警告（哪些任务本来依赖它） | `/quest/node/delete/preview` → `apply` |
| `new` | 标题 + 物品 + 数量 | `/quest/add/preview` → `apply`，`dependsOn` 是当前节点 |
| `rename` | 标题 + 副标题 | `/quest/preview` → `apply` |

**一律 plan → apply**：草稿卡 →「预览会改什么」→ 计划卡（`changes` / `diff` / `warnings` / `files`）→「确认写入」→ 结果卡（`lines` / `backups`）。

**这一轮后端一行没改**，全部复用：`/quest/node/preview|apply`、`/quest/node/delete/preview|apply`、`/quest/move/preview|apply`、`/quest/add/preview|apply`、`/quest/preview|apply`、`/mods`、`/mod-search`、`/mod-install/preview|apply`、`/quest/canvas`、`/item-icons`。**这是 P0 抽包带来的好处第一次兑现**：界面要什么，后端都已经有了。

### 26.4 `packages/ui/style.css`

约 620 行，全量重写。仍然**自己定义变量**、不碰 DSH 主题 token（理由见 §15）。变量表：

```
--bg #14161a   --surface #1b1e24   --surface2 #232830
--line #2f353f --line2 #3c4450
--fg #e8eaee   --fg2 #a8b0bd      --fg3 #7d8794
--brand #3fc8d0 --brand-dim #1f5f63
--ok #4bbf73   --warn #d9a13b     --error #e0664f
```

三栏布局：`.mcs-left` 固定 268px、`.mcs-center` `flex: 1`、`.mcs-right` 固定 340px。删掉了 §25 的 `.mcs-rail*` / `.mcs-dot` / `.mcs-main` / `.mcs-h1` / `.mcs-lead` / `.mcs-card-title` / `.mcs-list*`（流水线那套的样式）。

### 26.5 测试：DOM 替身的两个新坑

`test/ui-app.test.mjs` 从 2 条扩到 4 条：

1. 启动停在选项目页（标题、常见位置、实例、手填目录）。
2. 点实例进工作台（顶栏体检数字、左栏 mod 列表、中栏两个任务、右栏「还没有选中任务」）。
3. 点蓝图里的方块 → 右栏出详情和四个操作。
4. 右键 → 菜单 → 换图标 → 搜物品出「齿轮」→ 预览 POST `/quest/node/preview`（断言 payload）→ 卡里出现 `图标物品：demo:cogwheel → demo:gear` → 确认写入 POST `/quest/node/apply` → 显示备份名。

**两个坑（写界面测试必看）**：

1. **`el()` 里 `class` 是赋给 `className` 的**，不走 `setAttribute`。所以按 class 找元素要同时看 `node.className` 和 `node.attrs['class']`。踩的时候表现是「菜单明明渲染出来了，测试死活找不到菜单项」。
2. **`post()` 传的是相对路径**（`/api/mcstudio/...`）。浏览器里会自动补 origin，但测试里的假 `fetch` 必须显式给 base：`new URL(String(url), 'http://127.0.0.1:7460')`。不给就抛 `Invalid URL`，而这个异常会被 `run()` 吞成一条界面报错 —— 表现是「点了按钮，界面没反应，接口也没被调用」，最难查的一类。

另外 `test/ui.test.mjs` 里那条 `assert.match(js.text, /stageStatus/)` 改成了 `/\/quest\/canvas/` —— `app.js` 不再引用阶段栏了，但 `packages/ui/stages.js` 和它的 7 条单测**保留**（阶段推断逻辑没错，只是这一版界面不渲染它，将来做「工作流引擎」时还能用）。

### 26.6 基线

| 项 | 数字 |
| --- | --- |
| 套件 | **40** |
| 用例 | **577** 通过 / 0 挂（`ui-app` 2 → 4） |
| 上一轮（P2 第一版） | 40 / 575 |

实测 HTTP（`node packages/server/bin.mjs --port 7462`）：首页 200 / 341 字节、`/ui/app.js` 200 / 37957 字节、`/ui/style.css` 200 / 9472 字节、`/api/mcstudio/roots` 200 / 897 字节。

### 26.7 这一版还没接的

改配方（`/recipe/preview|apply`）、从零装底座（`/scaffold/*`）、从零建包（`/pack/*`）、打包（`/export/*`）、启动验证（插件侧才有）。

左栏也还没有「导入整合包」的入口 —— 目前靠顶栏「换项目」回到选项目页。用户提的「可搜索导入整合包」还差这一半。

---

## 27. 桌面双击启动（方案 A，2026-10-31 晚）

### 27.1 用户要什么、为什么是这个方案

用户原话：「启动方式能不能做成在桌面上双击应用快捷方式的形式，先回答我，别开始制作」。给了三条路对比后，用户拍板：「**先做A吧，之后在改成C的形式，这点写到计划里，大概在项目的最后修改形式**」。

| 方案 | 做法 | 代价 | 结论 |
| --- | --- | --- | --- |
| **A 快捷方式 + 脚本** | 桌面 `.lnk` → 隐藏窗口的 VBS → `launch.mjs` 起服务 + 开浏览器 | 十几分钟，依赖本机 Node，关掉浏览器后服务仍在 | **本轮做了** |
| B 单 exe 后端 + Edge `--app` | 打包一个后端 exe，用 Edge 的无地址栏窗口当外壳 | 半天，仍依赖 Edge | **不做** —— 既没有 A 简单，也没有 C 干净 |
| C Electron 真 exe | `packages/desktop`，`BrowserWindow.loadURL(studio.url)` | 半天到一天，150–200MB | **留到最后**（用户明确要求） |

### 27.2 链路

```
桌面 整合包工作室.lnk
  → wscript.exe "packages/server/启动.vbs"        （隐藏黑框）
    → node packages/server/launch.mjs              （探端口 / 起服务 / 等就绪）
      → node packages/server/bin.mjs --port 7456   （detached，脱离父进程常驻）
      → 默认浏览器 http://127.0.0.1:7456/
```

### 27.3 `packages/server/launch.mjs`（启动大脑）

| 导出 | 作用 |
| --- | --- |
| `argOf(argv, key, fallback)` | 认 `--key value` 与 `--key=value` |
| `hasFlag(argv, key)` | 认 `--key`、`--key=true`；`--key=false` 算没开 |
| `pageUrl(port)` / `healthUrl(port)` | `http://127.0.0.1:<port>/` 与 `/api/mcstudio/roots` |
| `log(message)` | 追加到 `packages/server/launch.log`（`MCSTUDIO_LOG` 可覆盖） |
| `probe(port)` | TCP 能不能连上 |
| `isHealthy(port)` | GET 健康检查且 `body.ok === true` |
| `waitHealthy(port, {timeoutMs, intervalMs})` | 轮询到健康或超时返回 false |
| `startServer(port)` | `spawn(detached:true, stdio:'ignore', windowsHide:true)` + `unref()`，返回 pid |
| `openBrowser(url)` | `cmd.exe /c start "" <url>`（mac/linux 另有分支） |
| `ensureServer({port, noBrowser, dryRun, timeoutMs})` | 主流程，见下 |

`ensureServer` 的判断顺序（**顺序本身就是设计**）：

1. `isHealthy` → 已经在跑，直接开页面，返回 `{started:false, alreadyRunning:true}`。**绝不起第二个**。
2. `probe` 通但不健康 → 可能是别人占端口，也可能是自己正卡在半启动；`waitHealthy` 给 5 秒，好了就当已有；不好就抛 `McLaunchPortBusy`（提示换端口）。
3. `dryRun` → 只打印计划，**不 spawn**。
4. 真起 → `waitHealthy(30s)`，超时抛 `McLaunchTimeout`（提示看 `launch.log` 或手工跑 `bin.mjs`）。

`launch.mjs` 被 import 时零副作用：

```js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
```

这条是测试能直接 import 这些函数的前提，别删。

### 27.4 `packages/server/setup-shortcut.mjs`（一次性安装）

| 导出 | 作用 |
| --- | --- |
| `renderIcon(size)` | 画图标：3 倍超采样 + 圆角底板 + 等轴测立方体三面，预乘 alpha 下采样 |
| `buildIco(sizes)` | PNG-in-ICO（256 的宽高字段写 0，这是 ICO 规范的老约定） |
| `vbsSource()` | 生成 `启动.vbs` 的内容 |
| `shortcutScript({name, vbs, ico, workdir, dir})` | 生成建 `.lnk` 的 PowerShell 脚本 |
| `runPowerShell(script)` | `-EncodedCommand`（base64 UTF-16LE）避开中文编码坑；**输出按行过滤，只认以 `.lnk` 结尾的那行** |
| `writeAssets()` | 落 `app.ico` + `启动.vbs` |

命令行：`node packages/server/setup-shortcut.mjs [--name 名字] [--out 目录]`。

**桌面写不进去**：沙箱是 workspace-write，PowerShell 建 `D:\Desktop\整合包工作室.lnk` 报 `UnauthorizedAccessException: Unable to save shortcut`。所以脚本按「桌面 → 项目根目录」两个候选依次试，落到项目根目录时打印提示让用户自己拖到桌面。这是环境限制，不是 bug。

### 27.5 三个必须记住的约束

1. **服务必须脱离父进程**：`detached:true` + `unref()`。否则 VBS 一退出（它 `sh.Run(..., 0, True)` 是等子进程结束），服务就被一起带走，浏览器打开时页面已经 404。
2. **`stdio` 必须 `'ignore'`**：这个环境给子进程接管道会 EPERM（就是 HANDOFF-NEXT 坑 5b）。独立版同样成立，不是插件侧特有。
3. **VBS 的引号一律用 `Chr(34)` 拼**。VBS 字符串转义是「两个双引号」，`"node ""path""""` 这种嵌套必算错。第一次就是炸在这儿：

```
Microsoft VBScript compilation error: Unterminated string constant
D:\...\packages\server\启动.vbs(7, 99)
```

正确写法：`target = "node " & Chr(34) & "<绝对路径>" & Chr(34)`。

### 27.6 另外两个坑

| 现象 | 真因 | 改法 |
| --- | --- | --- |
| 打印出来的快捷方式路径是一坨 XML（`<Objs Version="1.1.0.1"…>`） | PowerShell 往 stdout 混 CLIXML 进度信息 | `runPowerShell` 按行过滤、只取以 `.lnk` 结尾的那行 |
| `--no-browser` 时日志还说「打开页面」 | 文案没跟着开关走 | 分开写「服务就绪（按要求没开浏览器）」 |

### 27.7 实测

| 项 | 结果 |
| --- | --- |
| `launch.mjs --dry-run --port 7471` | `{"started":false,"alreadyRunning":false,"port":7471,"page":"http://127.0.0.1:7471/"}`，exit 0 |
| 真启动 | 约 **300ms 就绪**，`/api/mcstudio/roots` 200 |
| 再跑一次 | 日志「端口 7471 上已经有服务了，直接开页面」，exit 0（没起第二个） |
| `cscript //nologo "packages\server\启动.vbs" --no-browser --port 7472` | exit 0，`/api/mcstudio/roots` 200（897 字节） |
| `app.ico` | 5870 字节，6 个尺寸（16/32/48/64/128/256），偏移 102/371/810/1381/2097/3420 |
| 图标像素体检（256） | 四角 alpha=0（圆角）；底板 `#1b1e24` 占 70.4%；三个面各占 **8.1%**（`#2b8f97` / `#3fc8d0` / `#7ae7ef`）—— 面积三等分，说明等轴测投影没歪 |
| `.lnk` 属性 | Target `C:\WINDOWS\system32\wscript.exe`、Args `"…\packages\server\启动.vbs"`、WorkDir 仓库根、Icon `…\app.ico,0` |

### 27.8 测试

新增 `test/desktop-launch.test.mjs` **11 条**（注意别和 `test/launch.test.mjs` 混 —— 那个测的是**游戏启动** `packages/core/launch.js`，这个测的是**工作台自己怎么被启动**）：

1. 参数解析两种写法都认、缺省用默认值
2. 开关标志只认全名（`--key` / `--key=true`，`--key=false` 算没开）
3. 页面地址与健康检查地址同端口
4. 没人监听的端口：探不通、也不健康
5. 服务真起来后：探得通、健康检查通过
6. `waitHealthy` 对永远不健康的目标会超时返回 false（不会挂死）
7. `dry-run` 只算不启动：**端口跑完仍然是空的**
8. 服务已在跑：直接复用，`started:false` / `alreadyRunning:true`
9. 图标：四角透明、底板占最多面积、三个面面积互差不到 2 倍
10. ICO：头合法、6 个尺寸、每张都是 PNG 签名、偏移不越界
11. VBS：`Chr(34)` 拼引号、指向 `launch.mjs`、转发 `WScript.Arguments`、`sh.Run(target,0,True)`、出错弹 MsgBox 且提到 `launch.log`

### 27.9 基线

| 项 | 数字 |
| --- | --- |
| 套件 | **41** |
| 用例 | **588** 通过 / 0 挂（新增 `desktop-launch` 11 条） |
| 上一轮（P2 第二版） | 40 / 577 |

### 27.10 一条在这个沙箱里测不出来的事（重要）

「服务脱离父进程常驻」这条**在本沙箱里验证不了**。

现象：同一条命令里 `node launch.mjs --no-browser --port 7475` → 立刻 `Invoke-WebRequest` 返回 200；换下一条命令再访问 → 连不上，`Get-Process node` 也空了。

真因：**DSH 用 Windows job 对象管子进程**，命令一结束整棵树被回收，`detached:true` + `unref()` 也留不住（job 对象不放开的话 breakaway 也不生效）。这是沙箱行为，不是启动器的 bug。

为什么用户那边没事：用户从**资源管理器**双击 `.lnk`，`wscript.exe` 不在任何 job 里，`spawn` 出来的 `bin.mjs` 会正常常驻；下次双击 `isHealthy` 命中就直接复用。

怎么验：让用户真双击一次 → 浏览器打开页面 → **关掉浏览器** → 再双击一次 → 日志应该写「端口 7456 上已经有服务了，直接开页面」（而不是又起一个）。

### 27.11 以后换 C（Electron）怎么做

`packages/ui` **一行不用改** —— 它只是 `fetch('/api/mcstudio/...')` 的静态页面，不认宿主是谁。Electron 里要做的是：

1. main 进程里 `await createStudioServer({port})`；
2. `new BrowserWindow({...}).loadURL(studio.url)`；
3. 图标复用 `packages/server/app.ico`（`buildIco()` 已经在，`nativeImage` 也能直接吃）；
4. 加单实例锁（`app.requestSingleInstanceLock()`）和端口自选（`port: 0` 拿随机端口）；
5. 打包用 electron-builder，`packages/ui` 作为静态资源塞进 `extraResources`。

**按用户要求，这一步放在项目最后做。**

---

## 28. 拖动即落位：把蓝图交互对齐 UE（2026-10-31 晚）

### 28.1 用户为什么否掉上一版

原话：「我已经测试过蓝图功能了，有点问题，为什么要有确认挪动这种功能，不应该挪完之后就算挪好了吗，我建议你去github上找找蓝图编辑的项目，我觉得ue的蓝图编辑功能是我见过最好用的」

上一版（§26）的拖动是「松手 → `/quest/move/preview` → 右栏『确认挪动 / 算了』→ 才写」。技术上是标准的 plan→apply 两态，但**拖动这个手势本身就已经表达了意图**，再让用户点一次确认是多余的。UE 蓝图、Blender 节点、Figma 都是松手即生效。

### 28.2 参考了什么（一个库都没引入）

| 参考 | 借的范式 |
| --- | --- |
| [xyflow/xyflow](https://github.com/xyflow/xyflow) | 节点编辑器的事实标准：拖动/框选/缩放平移/右键菜单的职责划分 |
| [joakimsandqvistdev/ionodes](https://github.com/joakimsandqvistdev/ionodes) | 明确声明「视觉灵感来自 UE Blueprints」的实现 |
| [node-based-ui topic](https://github.com/topics/node-based-ui) | 同类项目的常见交互集合 |
| [Blueprint Editor Tips and Tricks](https://www.unrealengine.com/blog/blueprint-editor-tips-tricks) | 官方对「什么操作该即时生效」的取向 |

`packages/ui` 是零构建零依赖的 vanilla DOM，引库就得引构建链，代价远大于收益。所以只抄范式。

### 28.3 改成了什么

**一句话：松手即写盘。**

```
拖动中          → 只改 DOM：group.setAttribute('transform', translate(dx,dy))
松手            → 像素位移 / (CELL_X*scale) → snap() 到 0.5 格
                → 乐观改本地坐标（视觉立刻落位）
                → POST /quest/move/apply
                → refreshCanvas() 以磁盘为准重画
```

| 交互 | 实现 |
| --- | --- |
| 拖一个 | `beginDrag` → `commitMoves([{questId,x,y}])` |
| 拖多个 | `state.selSet` 全部一起 `setAttribute`；松手一次请求带多条 `moves` |
| 框选 | 空白处 `pointerdown` → `.mcs-band` 虚线框 → 松手算矩形相交；位移 <6px 不算拖动 |
| 点空白 | `selSet=[]; sel=''; questDetail=null` |
| 中键 | 平移画布（`state.view.tx/ty`） |
| 滚轮 | 绕鼠标点缩放，夹在 `0.35–2.5` |
| 空白双击 | 反算格子坐标 → `startDraft('new', null, {x,y})` |
| 撤销 | `undo` 栈（上限 30）：拿栈顶的 `from` 坐标再发一次 apply |
| 重做 | `redo` 栈；撤销时把反向操作压进 redo |
| 快捷键 | `Ctrl+Z` 撤销、`Ctrl+Shift+Z` / `Ctrl+Y` 重做、`Esc` 关菜单 |

**撤销为什么不新增后端**：`/quest/move/apply` 本来就是「给一批 `{questId,x,y}` 就写」，撤销只是同一批坐标换个值。`pushUndo(res)` 用返回的 `res.moves[].from` 反推回去。

### 28.4 为什么敢「松手就写」

`commitMovePlan` 的写盘纪律（`packages/core/quest-move.js`）：先备份所有要动的文件 → 写 → `loadQuests` 重读 → `newErrorsOf` 比对 → **有任何新错误就 `restoreFiles(done)` 整体回滚并抛 `QuestMoveRejected`**。所以最坏结果是「什么都没变 + 一条报错」，不会留下半改的文件。

这是能省掉确认步骤的前提。**如果哪天写盘变成不可回滚的（比如调外部工具），这条就不成立了，必须退回两态。**

### 28.5 插件面板同步改

`lib/client.js` 原来有 `canvasPending` 攒清单 + 卡片「还没保存的挪动 / 预览 / 保存这次挪动 / 撤销」。

改成：`putNode()` 里 `void commitMove([{questId: node.id, x: nx, y: ny}])`，`commitMove` 直接打 `/quest/move/apply`。

删掉：`canvasPending` state、`canvasPreview`、`canvasApply`、`canvasReset`、「还没保存的挪动」整张卡。
加上：`undoMoves` state + `canvasDone` 卡里的「撤销这次挪动」按钮。

### 28.6 四个坑

1. **闭包变量没传进去**：`beginBand` 里直接写 `byId` / `px` / `py`（它们是 `canvasSvg` 里的局部变量），运行时报 `ReferenceError: byId is not defined`。改成 `beginBand(event, svg, bandRect, ctx)`，用 `ctx.byId`。
2. **测试假 `fetch` 返回同一个对象引用**：前端乐观改 `hit.node.x` 时把假数据也改了，后面的用例拿到被污染的坐标（表现为「双击新建的位置从 3.5 变成 4.5」）。假 `fetch` 必须 `JSON.parse(JSON.stringify(body))`。
3. **插件侧撤销状态不能放 `useRef`**：按钮出不出要看它，`useRef` 改了不触发重渲染；而且测试替身的 `useRef` 每次渲染返回新对象（`useRef: (value) => { cursor++; return { current: value }; }`），读到永远是初始值。改 `useState`。
4. **`loadCanvas()` 会 `setCanvasDone(null)`**：所以 `commitMove` 里必须**先 `await loadCanvas()`、再 `setCanvasDone(r)`**。反过来写，界面会显示「挪好了」然后立刻消失（看起来像没写成功）。

### 28.7 测试

| 套件 | 变化 |
| --- | --- |
| `test/ui-app.test.mjs` | 4 → 8 条：拖动直接写盘且**不调 preview** / 挪完能撤销 / 框选多个一起拖（一次请求两条坐标）/ 空白处双击新建 |
| `test/client-quest-ui.test.mjs` | 13 → 14 条：插件侧「松手就落位」，断言 body 的 `moves` 是 `[{questId,x:1,y:0}]`、没有 preview、有「撤销这次挪动」 |

**基线**：41 套件 / **593** 通过 / 0 挂。

### 28.8 还没做的

- 拖动的**对齐吸附线**（UE 里有，现在只有 0.5 格 snap）。
- 撤销栈**不跨刷新**（`refreshCanvas()` 后 `flash` 还在，但栈在内存里，刷新页面就没了）。
- 批量编辑（框选后一次改多个任务的图标/依赖）。

---

## 29. 连线实时跟随 + 拖动不留黑框（2026-10-31 深夜）

### 29.1 用户报的两个现象

原话：「1.连接的线不能实时变化 2.在画布上会有黑框出现，要等放置后，黑框才会消失，是刚开始申请的空间大小不够吗」

第二个问题用户的猜测（「空间申请不够」）**方向不对**，真因是浏览器渲染层，见 29.3。记下来，免得下次照着「加大画布」去改。

### 29.2 连线不跟随：DOM 拖动不重渲染

「拖动即落位」那一版为了手感，拖动过程中只改节点 `<g>` 的 `transform`，**不重新渲染**。但连线是建画布时按坐标算好的一批 `<line>`，坐标写死在属性上，不会跟着变。所以拖动时线纹丝不动，松手 `commitMoves` → `refreshCanvas()` 才跳到位。

修法（`packages/ui/app.js`）：建画布时把每条线的「两端是谁 + 原始坐标」存进 `state.edgeEls`：

```js
const edgeEls = [];
for (const node of byId.values()) {
  for (const dep of node.dependencies ?? []) {
    const from = byId.get(dep.id);
    if (!from) continue;
    const geo = { x1: px(from.x ?? 0) + BOX_W / 2, y1: py(from.y ?? 0) + BOX_H,
                  x2: px(node.x ?? 0) + BOX_W / 2, y2: py(node.y ?? 0) };
    const line = s('line', { ...geo, class: 'mcs-edge' });
    viewport.append(line);
    edgeEls.push({ el: line, fromId: from.id, toId: node.id, ...geo });
  }
}
state.edgeEls = edgeEls;
```

拖动中调 `shiftEdges(ids, dx / scale, dy / scale)`：只改和拖动节点相连的线，而且**每次按「原始坐标 + 位移」重算**（不是累加，所以不会越拖越偏）：

```js
function shiftEdges(draggedIds, dx, dy) {
  const moving = new Set(draggedIds);
  for (const edge of state.edgeEls ?? []) {
    const fromMoving = moving.has(edge.fromId);
    const toMoving = moving.has(edge.toId);
    if (!fromMoving && !toMoving) continue;
    edge.el.setAttribute('x1', String(edge.x1 + (fromMoving ? dx : 0)));
    edge.el.setAttribute('y1', String(edge.y1 + (fromMoving ? dy : 0)));
    edge.el.setAttribute('x2', String(edge.x2 + (toMoving ? dx : 0)));
    edge.el.setAttribute('y2', String(edge.y2 + (toMoving ? dy : 0)));
  }
}
```

`beginDrag` 的 `onUp` 先 `shiftEdges(ids, 0, 0)` 复位，再走原来的写盘。

**插件面板不受影响**：`lib/client.js` 的画布是 React 状态驱动，`onPointerMove` 里 `setCanvasPos(...)` 会触发重渲染，连线本来就是实时重算的。

### 29.3 黑框：两个渲染层问题，都不是「画布太小」

**（1）根 `<svg>` 自己被 transform + `will-change: transform`。**
原代码 `applyView(svg)` 把 `transform` 直接写在根 svg 的 `style` 上，CSS 还有 `.mcs-canvas svg { will-change: transform; }`。这会让浏览器把整个 svg 提升成合成层；拖动子元素时旧位置的失效区域有时不被重绘，屏幕上留一块**纯黑**。松手后 `refreshCanvas()` 整棵树重建，黑块才消失 —— 正好对上「要等放置后黑框才消失」。

修法：套一层 `<g class="mcs-viewport">`，平移缩放改作用在它身上：

```js
const viewport = s('g', { class: 'mcs-viewport' });
// …连线、节点、框选矩形都 append 到 viewport…
state.viewportEl = viewport;
svg.append(viewport);
applyView();

function applyView() {
  const group = state.viewportEl;
  if (!group) return;
  const { scale, tx, ty } = state.view;
  group.setAttribute('style', `transform: translate(${tx}px, ${ty}px) scale(${scale}); transform-origin: 0 0;`);
}
```

同时删掉 `.mcs-canvas svg` 上的 `will-change`。

**（2）`<image>` 被浏览器当成可拖图片。**
SVG 里的 `<image>` 默认参与原生 HTML5 拖拽，按住节点一拖可能起一个「拖图片」的幽灵，在深色画布上就是一块黑方块，松手才没。四处一起上：

- `<image>` 加 `draggable="false"`；
- `.mcs-canvas` 加 `user-select:none; -webkit-user-select:none; -webkit-user-drag:none;`；
- `.mcs-canvas image { -webkit-user-drag:none; pointer-events:none; }`（`pointer-events:none` 顺带让「点图标」等于「点节点」）；
- `svg.addEventListener('dragstart', (e) => e.preventDefault?.())`。

**（3）节点拖出数据范围会被 svg 裁掉。**
svg 的 `width/height` 是「所有节点包围盒 + 48px 边距」，拖出去就超出、被 svg viewport 裁掉，看起来也像「凭空少一块」。加 `.mcs-canvas svg { overflow: visible; }`；容器 `.mcs-canvas` 仍是 `overflow:hidden`，所以不会溢到画布外。

### 29.4 测试

`test/ui-app.test.mjs` 8 → **10 条**：

- **「拖动时连线跟着走：不用等松手才更新」**：先点一下任务甲（**必须单独选中** —— 上一个用例「框选多个」会留下 `selSet=[甲,乙]`，多选会一起拖，两端都动，断言看起来像「方向反了」）→ 选中会重画整个画布，**连线要在重画之后重新找** → 记下 `x1/y1/x2/y2` → `pointerdown` + `pointermove(132, 0)`（不松手）→ 断言起点 `x1` 正好 `+132`、`y1` 不变、另一端 `x2/y2` 完全不动 → `pointerup` 收尾。
- **「平移缩放落在内层 `<g>` 上，不直接 transform 根 svg」**：断言根 svg 的 `style` 不含 `transform`、`mcs-viewport` 层含 `transform`、svg 上挂了 `dragstart`、图标 `draggable === 'false'`。这条是「黑框」的回归哨兵 —— 以后谁再把 transform 写回根 svg，测试会红。

**基线**：41 套件 / **595** 通过 / 0 挂。静态资源实测 `app.js` 200 / 52787 B、`style.css` 200 / 11190 B。

### 29.5 还没验证的

- 黑框是否**彻底**消失只在推理层面确认（两个成因都堵了），没有真机截图对比 —— 要用户刷新后确认。
- 连线跟随用的是直线（`<line>`），拖动后不会重排成折线/曲线；UE 里是贝塞尔曲线。


## 30. 多选一起挪 + 「向左侧吸引」的真凶（2026-10-31 更晚）

### 30.1 用户报的现象

原话：「选中多个任务，没法一起挪动，原因可能是默认向左侧吸引」

用户的猜测（「默认向左侧吸引 / 吸附」）**方向不对**：`snap()` 只是 `Math.round(Number(v) * 2) / 2`，把坐标吸到半格，既没有夹取、也没有任何「往左拉」的逻辑。真因是两个独立问题叠在一起，见 30.2 / 30.3。

### 30.2 拖完那一下 `click` 把多选收成了单选

浏览器的事件顺序是 `pointerdown → pointermove… → pointerup → click`。`pointerup` 时我们写盘、重读画布，紧接着浏览器补一个 `click`，而节点的 `click` 处理是：

```js
g.addEventListener('click', (e) => { void selectQuest(node.id); });
```

`selectQuest`（`packages/ui/app.js:314`）里有一行 `state.selSet = questId ? [questId] : []` —— 于是「多选 → 拖其中一个 → 松手」的结果是：坐标确实一起写了，但**选择立刻塌回单选**，用户接着再拖就只有那一个动，主观感受就是「没法一起挪」。

修法：加一个「刚拖完，这一下 click 要吞掉」的开关：

```js
// onUp 里，确实拖动过之后
state.suppressClick = true;

// 节点 click 里
g.addEventListener('click', (e) => {
  if (state.suppressClick) { state.suppressClick = false; return; }
  if (e?.ctrlKey || e?.metaKey || e?.shiftKey) { toggleSelect(node.id); return; }
  void selectQuest(node.id);
});
```

`beginDrag` 开头还会 `state.suppressClick = false` 复位（防御性：万一某个浏览器不补 click，开关不会永久卡住）。

**顺带加了 Ctrl / Cmd / Shift + 点击加选**（`toggleSelect(questId)`：用 `Set` 增删 `state.selSet`，长度正好 1 时同步 `state.sel`，并清掉 menu / draft / plan / done / questDetail）。之前只能靠「空白处拖动框选」，在节点稀疏的地方很难框准。

### 30.3 画布原点跟着包围盒漂 —— 这才是「向左侧吸引」

`canvasSvg()` 的坐标原点是**所有节点包围盒的左上角**：

```js
const px = (x) => (x - minX) * CELL_X + pad;
```

`minX/minY` 每次都从当前数据重算。于是把**最左边**那个任务往右挪一格，`minX` 就从 `0` 变成 `1`，**整张图在屏幕上整体左移一格**（没动的节点也跳）—— 看起来正是「被吸到左边」。反过来往左挪、或挪最上面那个，同理。

修法：记住上一次的原点，重画时把视口平移量补回来。推导（`screen = tx + (X - minX) * CELL`，要让同一个 `X` 的屏幕位置不变）：

```js
const origin = state.canvasOrigin;
if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
  const scale = state.view.scale || 1;
  state.view.tx += scale * (minX - origin.x) * CELL_X;
  state.view.ty += scale * (minY - origin.y) * CELL_Y;
}
state.canvasOrigin = { x: minX, y: minY };
```

**符号踩过一次**：第一版写成 `(origin.x - minX)`，方向反了 —— 那样会让跳得更厉害。验算：`minX` 从 0 变 1（内容右移一格），`rect.x` 少 132，要维持屏幕位置 `tx` 就得 `+132`，即 `tx += (1 - 0) * 132`。切换项目时 `connect()` 里把 `state.canvasOrigin` 置空。

### 30.4 测试

`test/ui-app.test.mjs` 10 → **13 条**：

- **「Ctrl+点击 能加选」**：单选甲 → `click({ ctrlKey: true })` 点乙 → 右栏出现「选中了 2 个任务」。
- **「多个选中一起拖完，选择还在」**：`dragBy` 一次 → 断言请求里两条坐标 + 「选中了 2 个任务」仍在。
- **「把最左边的任务往左挪，其他任务在屏幕上不该跟着跳」**：用 `viewTx()`（正则抠 `mcs-viewport` 的 `translate(...)`）＋节点 `rect.x` 算屏幕横坐标，拖前拖后必须相等。这条是原点漂移的回归哨兵。

**测试替身必须补 click**：`dragBy` 现在在 `pointerup` 之后**补发一次 `click`**，模拟真实浏览器。不补的话 `suppressClick` 会跨用例残留，把下一个用例的点击吞掉，表现为「莫名其妙选不中」。

**基线**：41 套件 / **598** 通过 / 0 挂。

### 30.5 还没做的

- 撤销栈仍只在内存里，刷新页面就没了。
- 多选目前只能一起**挪位置**；批量改图标 / 批量改依赖还没做。
- 拖动时没有「对齐吸附线」（UE 那种蓝色参考线）。


---

## 31. 文档索引与基线

- `docs/archive/HANDOFF-NEXT.md`：插件侧行动清单（补 1–补 33）。
- `docs/archive/HANDOFF-STANDALONE.md`：独立软件侧的迁移计划与已完成项（§6.1–§6.8）。
- 本文：技术档案，§13–§31 是 2026-10-30 之后的增量。

**当前基线**：`41 个套件 / 598 条全过`（`node lab/_run-all.mjs`）。


