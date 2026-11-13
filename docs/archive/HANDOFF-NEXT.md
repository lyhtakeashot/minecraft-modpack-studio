# HANDOFF-NEXT — 下一个会话从这里开始

> 🗄️ **本文件已冻结（2026-11-01）**，只供溯源，不要再往里追加内容。
> 当前施工单是同项目的 [docs/HANDOFF.md](../HANDOFF.md)。


> **⚠️ 如果你是要继续做下去的人：先读 [docs/HANDOFF.md](../HANDOFF.md)。** 那份是 2026-11-01 写的施工单，只管「独立软件剩下的五块按什么顺序接」。本文是**插件侧**的行动清单，降级为资料。

> 这份是**行动文档**：现状 + 还差什么 + 怎么接着干。
> 想查「为什么这么做」的完整证据链，看同目录 `docs/archive/HANDBOFF.md`（≈120 KB，18 章，含全部实测数据）。
> 本文件写于 2026-10-28，作者是上一个会话的 lead；**2026-10-29/30/31 多次增补**（最后更新：联网装 mod + 从零建包 + 打包按钮 + 从零加任务/章节 + 任务书拖拽画布 + 端到端真启动成功 + 照 PCL 抄的高速下载引擎 + **选版本向导（从零装底座）** + 去掉主界面顶栏按钮（只留右侧栏入口）+ **物品图标（jar 直读 86%）+ 高清图标（游戏内 Icon Exporter 导出，100%）** + **1.20.1 Forge 从零装底座打通（含自动装 Java 17 + 沙箱管道 EPERM 收口）** + **蓝图提到最前 + 节点右键编辑（换图标/改依赖/删任务/就地新建）** + **配色按主题 token 重做** + **换图标能打中文搜物品（打开即列一屏、输入法回车不抢）** + **图标三问（悬停简介、传送带不再冒用方块条纹、液体与原版图标补齐）** + **传送带/绳索分清「手持物品 vs 放置出来的方块」（幻影方块去重 + blockstate 兜底取图）**，29 个工具 + 41 条界面接口 + 36 套件 547/547 全绿）。

---

> ## ⚠️ 2026-10-31 方向变更：本项目要转成独立软件
>
> 用户决定：**做成独立的桌面软件（完整工作台 + 工作流），DSH 插件降为次要。**
> 新的主线和迁移计划在 **[`docs/archive/HANDOFF-STANDALONE.md`](HANDOFF-STANDALONE.md)**，**接手先读那一份**。
>
> 本文（和 `docs/archive/HANDBOFF.md`）继续有效，但降级为资料：这里是插件侧"已经做到哪儿、怎么做的、踩过哪些坑"的完整记录。
> 关键结论只有一句：`lib/core`（11961 行）是纯 Node、零 DSH 依赖，可以直接搬走；要重写的是 `lib/client.js`（3345 行）和"工作流"这一层。

---

## 0. 三十秒看懂

这是一个 **DSH 插件**，名叫 `dsh-mc-modpack-studio`，给 Minecraft 整合包做「工作室」：
让用户用自然语言改整合包（改配方、写任务书、写 KubeJS 脚本、打包成 PCL 能装的整合包、真启动验证）。

**现在完成度**：骨架 + 索引 + 任务书读写 + KubeJS + 规划层 + 导出 + 启动验证 + mod 内部体检 + **侧边面板界面层（蓝图在最前）** + **改配方** + **改任务书** + **联网装 mod** + **从零建包** + **打包按钮** + **从零加任务/章节** + **蓝图右键编辑（换图标/改依赖/删任务/就地新建）** + **高速下载引擎（照 PCL 抄的分段并行）** + **选版本向导（从零装底座）** + **物品图标（含游戏内导出的高清图）** + **1.20.1 Forge 从零装底座（含自动装 Java）** + **换图标时的中文物品搜索（可视化下拉）** + **方块模型等轴测渲染（和 JEI 对齐）** + **P0 抽包 / P1 独立本地服务 / P2 浏览器三栏工作台 / 桌面双击启动（方案 A）**，**全部已实现并跑通**，29 个工具 + 41 条界面接口，**41 个套件 598/598 测试通过**。两个目标版本都**真启动到主菜单**：1.21.1 NeoForge 17.2 秒（向导装 17.8 秒）、1.20.1 Forge 47.4.28 **17.3 秒**，证据都是 `Sound engine started`。
**还没做的**：跨工具联动、错误文案统一、locale 双语、正式打包发布、Fabric/Quilt 的从零装底座；高清图标已做完（见 §0「补 15」），Forge 已做完（见 §0「补 16」），蓝图右键编辑已做完（见 §0「补 17」），换图标搜索已做完（见 §0「补 19」），图标三问与 MC百科 兜底已做完（见 §0「补 22 / 补 23」），传送带/绳索图标已做完（见 §0「补 24」），图标只认手持物品形态已做完（见 §0「补 25」），等轴测渲染（和 JEI 对齐）已做完（见 §0「补 26」），P0 抽包 + P1 独立本地服务已做完（见 §0「补 27」），P2 浏览器工作台已做完（第一版见 §0「补 28」，**三栏工作台见 §0「补 29」**，**桌面双击启动见 §0「补 30」**，**拖动即落位见 §0「补 31」**，**连线实时跟随 + 拖动不留黑框见 §0「补 32」**，**多选一起挪 + 画布不再「向左侧吸引」见 §0「补 33」**）。还剩一件小事：**JEI 级图标的一次性导出通道**（写个客户端脚本把图标渲染成 PNG 落盘，之后 `findExportDirs` 直接读；用户还没拍板要做）。

> ⚠️ **独立软件（2026-10-31 补 28 / 补 29 / 补 30 / 补 31 / 补 32 / 补 33）**：`packages/ui/` 是浏览器工作台（**第二版是三栏：选项目页 → 左 mod 列表 / 中任务蓝图 / 右任务检查器**）—— `node packages/server/bin.mjs` 之后浏览器打开 `http://127.0.0.1:7456/` 就能用；**也可以双击项目根目录的 `整合包工作室.lnk`（方案 A，隐藏黑框自动起服务并开页面）**；`packages/server/` 是本地 HTTP 服务；`packages/core/` 是抽出来的领域逻辑。插件侧照旧能用，两边共用同一套 core 和同一张路由表。路线文档是 `docs/archive/HANDOFF-STANDALONE.md`。
>
> ⚠️ **路径变更（2026-10-31 补 27）**：下面所有历史段落里写的 `lib/core/xxx.js`，现在实际位置是 **`packages/core/xxx.js`**。`lib/core/` 目录已经删掉（备份在 `lab/_backup-lib-core/`），全项目只有 `packages/core` 一份。这是为了让 core 能被独立软件直接 import，不受 DSH 影响。看到旧路径时按这个换算，不用去找。

**你接手后的第一件事**：确认用户已经**重启过 DSH**（宿主侧代码不热更新，`lib/index.js`、`lib/host/*` 改了都必须重启），点右侧栏顶部的「+」，确认「整合包工作室」入口出现了、点开能用；然后在面板里连 `lab\重度机械症 - 实验\versions\Mechanomania`，走一遍「搜物品 → 点物品 → 点配方 → 预览 → 写入」，再走一遍「⑥ 任务书 → 读取任务书 → 点一条任务 → 改标题 → 预览 → 写入」。**脚本层两条链路都已验证写入成功，但还没人在真界面上点过**，先确认能用，再照 §5.0 往里加功能。

> 2026-10-29 补：用户第一次重启后报「右侧栏没有显示」。查下来界面文件其实被正常提供了（`/plugins/??<包名>/client.js&rev=<rev>` 返回 200），**真正的原因是没登记 `guide` 引导入口**，面板在右侧栏没有任何可点的地方。已修，详见 §5.0 和 §7 第 25 条。
>
> 2026-10-29 补 2：用户第二次反馈「输路径报 HTTP 404」。根因是 `export const inject = ['tools']`，`apply` 跑的时候 `connection` 服务还没就绪，`ctx.get('connection')` 拿到 `undefined`，**7 条路由一条都没注册**。已改成 `ctx.inject(['connection'], (child) => ...)`，见 §5.0。
>
> 2026-10-29 补 3：新增「选择文件夹」按钮（用户明确要的：只选文件夹、选完自动连接并扫描）。浏览器拿不到绝对路径，所以改成宿主侧弹系统对话框，见 §5.0 和 §7 第 31–34 条。
>
> 2026-10-29 补 4：界面第二块「改配方」做完了。搜物品 → 点物品看它的配方 → 点一条配方 → 改数量/材料 → 预览（只算不写）→ 确认写入（自动备份 + 写完复验，不过就回滚）。共 4 条新接口（3 条 GET + 1 条 POST），见 §5.0 和 §6。
>
> 2026-10-29 补 5（**接手必读**）：上面那条「撞写权限」**已经解决了**，改配方的真写盘链路端到端跑通。用户把实验副本搬进了工作区，路径是 `lab\重度机械症 - 实验`（项目根，**不是** `lib\`）。中间踩了一个大坑：搬进来的目录**照样 `EPERM`**，查下来根因**不是文件权限**，是 **Windows 完整性级别** —— DSH 沙箱进程跑在 Low 完整性，只能写带 Low 标签的位置，而搬进来的目录保留了 Medium。解法：`icacls <目录> /setintegritylevel (OI)(CI)Low /T`。详见 §7 第 41–43 条，判定过程见 §5.0 的「实验副本」小节。
>
> 实测结果（`lab\重度机械症 - 实验\versions\Mechanomania`）：列配方 366ms / 预览 6ms / 写入 877ms 全程成功，生成 `kubejs\server_scripts\dsh_recipes.js`（430 字节），复验通过，影响面 0。**这是第一次真正把配方写进磁盘**。
>
> 2026-10-29 补 6：界面第三块「改任务书」做完了。面板里能读整本书（395 个任务 / 18 章，36ms）→ 按章节或关键词筛 → 点一条任务改标题 / 副标题 / 说明 → 预览（只算不写）→ 确认写入（自动备份 + 写完重读复验，不过就整批回滚）。共 5 条新接口（4 条 GET + 1 条 POST），路由总数 **16** 条，见 §5.0 和 §6。真包上验证过「读 → 预览 → 写 → 备份 → 还原」，实验副本净变化为零。中途又撞了一次同一个坑的不同子树（`config\ftbquests` 的完整性标记没打上），已修，见 §7 第 48 条。
>
> **2026-10-29 补 7（本轮大推进，接手先读这段）**：面板从「七段」扩到「十一段」，四条主线里剩下的三个大坑全填了。
>
> 1. **联网装 mod**（新）：Modrinth 搜索 → 勾选 → 算清单（带依赖闭包、体积、同名冲突）→ 确认下载（sha1 校验、镜像回退、卡住计时）。工具 `mc_mod_search` / `mc_mod_install`，面板 ③④ 段。CurseForge 要用户自填 key。
> 2. **从零建包**（新）：拿本机一个能启动的实例当模板 → 校验包名 → 算计划 → 真建（版本 json / 客户端 jar / 十三个目录 / 空任务书 / 空 kubejs）。工具 `mc_pack_create`，面板「从零建一个包」段。
> 3. **打包按钮**（新）：三形态（只打内容 / 带游戏本体 / 连启动器一起），面板 ⑩ 段。实测 standard 3.1 MB / 9 条目、offline 886.6 MB / 4050 条目 / 23.5 秒，PCL 自检全过。
> 4. **从零加任务 / 加章节**（新）：面板 ⑪ 段 + `mc_quest_add` / `mc_quest_chapter`，写盘前备份、写完复验、出错整批回滚。逻辑抽到了 `lib/core/quest-create.js`，工具和面板共用。
> 5. **端到端真启动成功**（本轮最关键的一条）：建出来的包**真启动到主菜单** —— 空包 17.2 秒；装完 Create + KubeJS + Rhino + Better Advanced Tooltips 四个 mod 后 **24.1 秒**，日志出现 `Sound engine started`，Create 的 58 条列车配置、Flywheel 的 77 个 shader 全部正常加载，零崩溃报告。中间修了一个致命 bug —— `lib/core/launch.js` 只把 natives jar 算进 classpath，**从没解压**，导致 `Failed to locate library: lwjgl.dll` 崩溃。新增 `lib/core/natives.js`（解压 + 拍平子目录 + 跳过 META-INF），现在启动前自动解压。
>
> 现状：**28 个工具 + 36 条界面接口 + 31 个测试套件 432 条测试全绿**。还差：跨工具联动、locale 双语。
>
> 2026-10-29 补 8：补完「从零加章节」在**全新空包**上的两个坑。
>
> 1. **新包没有语言文件**（真 bug）：`emptyQuestBook()` 原来只写 `data.snbt` + `chapter_groups.snbt`，不写 `lang/en_us.snbt`；而 `quest-create.js` 的 `readLangOrThrow` 在文件不存在时直接抛 `QuestNoLang`。结果就是「从零建包 → 从零加第一章节」这条最该顺的路反而断了。已修：`emptyQuestBook()` 多写一个 `lang/en_us.snbt`（内容 `{\n}\n`），`readLangOrThrow` 改成文件不存在时用空 compound 当底子、由 `patchQuestText` 把新键插进去，不再报错。
> 2. **`created` 标志永远 false**（小 bug）：`questPlanPayload()` 里 `created: !fs.existsSync(w.file)` 是在 `commitQuestPlan()` **之后**才调的，文件早写好了，所以面板上永远看不到「（新建）」。已修：apply 的两个 handler 都改成先算 payload 再写盘。
>
> 实测（实验室 `versions\最小包`）：把任务书重置成空书后跑一遍，从零建出「第一章 起步」（`7693B7969D85C905.snbt`，402 B）+ 任务「做一台压片机」（`901977C34864E2FC`，坐标 0,1），`lang/en_us.snbt` 自动补出并写入两条键，两个 `.bak` 备份都在，重读 1 章 / 1 任务。测试新增「包里连语言文件都没有，也能建（自动补一个）」，总数 351 → **352**。
>
> 2026-10-30 补 9（**导出包的最终验收做完了**）：不用 PCL 也能验证「PCL 装完能不能开」——PCL 拖 zip 进去干的事就是解压到 `.minecraft`，所以直接照做再启动，等价且更严格。做法：`[System.IO.Compression.ZipFile]::ExtractToDirectory` 把 `最小包-offline.zip` 解到 `lab\_verify_offline`（7.4 秒 / 4050 文件 / 976.3 MB），再对解出来的 `versions\最小包` 跑 `mc_launch_test apply:true`。
>
> 结果：**14 秒到主菜单**（`14:00:58` ModLauncher 起来 → `14:01:12 Sound engine started`），`missing libs = 0`、`classpath 83 项`、`natives 解压 8 个文件`、**无 crash-reports**、KubeJS 客户端资源重载完成、Create/Flywheel 正常。验证完临时目录已删（976.5 MB 已回收）。探针脚本留作回归：`tools/probe-verify-offline.mjs`（不带参数 = dry-run，带 `apply` = 真启动）。
>
> 顺带纠一个我自己犯的错：`Get-PSDrive D` 在受限沙箱里返回 `Used 0 / Free 0`，`Get-CimInstance Win32_LogicalDisk` 直接「拒绝访问」——**磁盘根本没满**，是查询被沙箱挡了。以后判断空间别信这两个，直接写个文件试。
>
> 2026-10-30 补 10（**任务书拖拽画布做完了**）：用户拍板先做这个。
>
> 新增 `lib/core/quest-move.js`：`snapCoord`（吸附 0.5 格、夹 ±1000）、`planMoveQuests`、`commitMovePlan`、`describeMovePlan`。计划阶段整批校验（空/超 500/缺 ID/重复/任务不存在/坐标非数字 → `MoveEmpty`/`MoveTooMany`/`MoveNoId`/`MoveDuplicate`/`QuestNotFound`/`MoveBadCoord`），按章节文件分组，同文件多次改动**依次叠加**（`patchQuestFields` 内部每次重新 parse，所以 span 偏移不会错位），坐标没变的跳过不写；写盘后重读体检，出新错误整批回滚（`QuestMoveRejected`）。
>
> 宿主三条路由（**总数 28 → 31**）：`GET /quest/canvas`（每章节点 + 坐标 + 依赖边 + 依赖它的下游）、`GET|POST /quest/move/preview`、`POST /quest/move/apply`。工具 `mc_quest_move`（**工具 26 → 27**，`moves` 支持 JSON 字符串或 `questId+x+y` 单任务简写）。
>
> 面板 ⑫ 段：SVG 画布（一格 76px，节点 66×34，坐标居中）、pointer 拖拽（`setPointerCapture`，松手直接按指针位置算坐标、不读 state 免得最后一帧没提交）、依赖箭头连线（`marker` + 跨章节只在可见范围内画）、章节筛选标签、选中卡片（可一键打开该任务的文字）、未保存清单 + 预览/保存/撤销。拖过的节点描边变黄，保存后以磁盘为准重新载入。
>
> 顺手修了一个**影响所有工具**的坑：`refusal()` 会返回 `code` 字段，但 `COMMON` 里没声明它，而 `obj()` 是 `additionalProperties:false` —— 于是「工具失败」这条路会被宿主判成 `value.code is not a declared property`，把真正的报错盖掉（`mc_launch_test` 就踩过）。已在 `lib/tools/shared.js` 的 `COMMON` 里补上 `code`。
>
> 实测（实验室 `最小包`，造了 4 个任务 + 2 条依赖）：canvas 正确返回依赖关系；预览「接上齿轮 (1,2) → (2,2)」；落盘后读回坐标 2,2，备份 `7693B7969D85C905.snbt.bak-1793342064038` 齐全。
>
> 测试：新增 `test/quest-move.test.mjs`（10 条，含 3 条工具层用例）。全量 **25 个套件 362 条全绿**。
>
> 2026-10-30 补 11（**把 PCL 的下载机制搬过来了**）：用户说「把这段下载机制拿过来用吧，先把地基打好，后续的工作才能快起来」。
>
> 为什么值得先做：后面的「选版本向导」要下 400–600 MB 底座（几百个 libraries 小文件 + assets），单连接串行下载会慢到不可用。这是所有后续联网功能的地基。
>
> 新增 `lib/core/downloader.js`（约 640 行），照 `ref\pcl-ce\AdaptiveRangeDownloader.cs` 与 `DownloadResourceManager.cs` 直译：
> - **分段并行**：`SMALL_FILE_THRESHOLD = 4MB`（小于它不分段，省一次 Range 探测往返）、`TARGET_SEGMENT_SIZE = 8MB`、`MAX_SEGMENT_COUNT = 1024`、`MAX_EXPANDED_SEGMENT_COUNT = 2048`。`planSegments()` 是「先算段数再把总长均分」（`count = clamp(ceil(total/8MB),1,1024)`、`size = ceil(total/count)`），**不是每段正好 8 MB** —— PCL 同款，最后一段不会特别小。
> - **乱序写盘**：`fsp.open('w+')` → `truncate(totalSize)` → 每个 worker 用 `handle.write(buffer, 0, take, seg.start + seg.done)` 按偏移写；全部完成后 `handle.sync()`，再整文件读一遍算 sha1（乱序写只能这样校验）。
> - **慢分段分裂**：`isSignificantlySlow()` 是 PCL `IsSignificantlySlow` 的直译 —— 设了限速不判、剩余 <1MB 不判、跑了不到 8 秒不判；取其它分段 2 秒内采样排序，`median = rates[floor(n/2)]`、`fastest = rates[n-1]`；`relativelySlow = median>=128KB/s && own*4<median`、`absolutelySlow = own<50KB/s && fastest>=128KB/s && own*4<fastest`。慢就把剩余一半拆出去重新排队（`SLOW_SPLIT_THRESHOLD = 2MB`、`MAX_SEGMENT_RETRIES = 2`）。这个防抖是为了「线路被源站整体限速时不让所有分段一起反复重启」。
> - **全局连接池** `createConnectionPool({limit, perHostLimit})`：FIFO 排队 + 按 host 计数，`release()` 幂等；`getGlobalPool()` 进程级单例，额度读 `MCSTUDIO_CONNECTIONS`（1–256，默认 64）。**顺序下载也要 acquire** —— 否则几百个小文件并发会绕开全局额度。
> - **多文件并行**：`applyInstallPlan` 从串行 `for...of` 改成 4 路 worker 池（`parallelFiles` 默认 4，clamp 1–8），结果按 `outcomes[index]` 原始顺序归类，保证清单顺序不受谁先下完影响。
> - 新增 `lib/core/net-errors.js`：把 `isNetworkFailure`/`describeNetworkFailure`/`stalledDownload`/`safeHost`/`isLocalWriteFailure`/`asLocalWriteFailure`/`sleep` 从 `mod-fetch.js` 抽出，避免 `mod-fetch.js` ↔ `downloader.js` 循环引用；`mod-fetch.js` 再转出口，所以 tools/host/测试的 import 一行都没改。
>
> 实测（本机 2026-10-30，探针 `tools/probe-download-speed.mjs` / `tools/probe-install-speed.mjs`）：
> - Create 18.2 MB 单连接对照 **2.78 秒 / 6.56 MB/s**；分段 **2.20 秒 / 8.28 MB/s（3 段）**，快约 26%（这条线路本身单连接就有 6.5 MB/s，慢线路上收益更大）。
> - 装 4 个 mod（21.3 MB）**2.67 秒 / 7.98 MB/s**，连接池峰值 6；Create 走 segmented，其余走 sequential。
> - 16 个 2.24 MB 小文件并发：连接池峰值**正好卡在额度 8**，没有超发。
>
> 踩的坑：① `sequential` 的截断检查只能看**真实 `content-length`**，`expect.size` 的比对要留给外层 —— 否则「大小不对」那条测试会拿到错的错误码；② Create 的 Modrinth version id 必须是 `UjX6dr61`（猜的 `8Q1XjJVS` 会 400）。
>
> 测试：新增 `test/downloader.test.mjs` 14 条，其中一条**故意把每段响应错开 1 字节**，靠 sha1 抓出来 —— 专门防「乱序写偏移算错」这种静默 bug。全量 **26 个套件 376 条全绿**。
>
> 2026-10-30 补 12（**选版本向导做完了，四条主线全部走通**）：用户说「可以，开始做吧」。这是面板上最后一个大缺口，也是主线 3 的最后一块。
>
> 架构决策（**实测逼出来的，别改**）：**下载归我们，打补丁归官方安装器**。
> - 安装器的 `--mirror` 参数**对库下载不生效** —— 实测 `java -jar installer.jar --installClient <dir> --mirror https://bmclapi2.bangbang93.com/maven` 照样去连 `maven.neoforged.net` 并全部 `SocketTimeoutException`，最后 `There was an error during installation`。
> - processor 是 Java 程序（installertools ×3、AutoRenamingTool、binarypatcher、jarsplitter），纯 JS 复刻不现实。
> - 所以：先用我们自己的下载引擎（走镜像）把原版 + 加载器依赖全摆好，再让安装器 `--offline --installClient <mcRoot>` 只跑 processor。
>
> 三个新 core：
> - `lib/core/version-manifest.js`（21 导出，纯函数）：Mojang 清单解析、版本挑选、加载器版本列表、**镜像地址换算**。关键：`candidateUrlsFor(url, 'auto')` **按域名判断** —— 加载器域名走 BMCLAPI 镜像（官方直连超时），Mojang 域名走官方（镜像上资源只有 170 KB/s、24 个挂 11 个，官方 7.3 MB/s）。`toMirror` **只映射真有对应路径的六条**，`piston-meta` 不映射（映射过去只会先白等一轮超时）。
> - `lib/core/version-install.js`（16 导出）：`mavenPath`（支持 `:classifier` 与 `@ext`）、`libraryItems`（rules 过滤 + 去重）、`planCore`、`assetItems`、`buildVanillaPlan`、`applyItems`（游标 worker 池，已存在只比大小不逐个算 sha1）、`readInstallerProfile`、`buildLoaderPlan`（三来源合并去重）、`runInstaller`（自动补 `launcher_profiles.json`）、`writeGameVersionJson`（**必须写**，否则 `inheritsFrom` 链找不到原版 json）、`writeInstanceVersionJson`、`copyClientJar`、`locateLoaderVersion`。
> - `lib/core/scaffold.js`（3 导出）：`planScaffold` / `applyScaffold` / `describeScaffold`。安装器缓存目录 `CACHE_DIR = '.dsh-installers'`（相对 mcRoot，别塞进 `versions/` 污染实例列表）。
>
> 工具 `mc_pack_scaffold`（**工具 27 → 28**，默认 apply=false 只算计划）；宿主两条路由（**总数 31 → 33**）：`GET|POST /scaffold/preview`、`POST /scaffold/apply`；面板加「从零装一个底座」段（在「从零建一个包」之后，不占编号，因为它是 1c）。面板明确分成「算计划」和「开始装」两步 —— 这是唯一会真下几百 MB 的按钮。
>
> 实例走 **`inheritsFrom`** 而不是合并 json（`launch.js` 的 `loadVersionJson` 已支持继承链），但 `launch.js:224` 只在实例目录找客户端 jar，所以装完要把原版 client.jar 复制成 `<实例目录>/<实例名>.jar`（26 MB，也跟 PCL 形状一致）。
>
> 实测（本机 2026-10-30，探针 `tools/probe-version-install.mjs` / `tools/probe-scaffold.mjs` / `tools/probe-scaffold-http.mjs` / `tools/probe-scaffold-http-apply.mjs`）：
> - 原版下载：**新下 3636、跳过 348、失败 0，136.6 秒 / 678.9 MB（约 5 MB/s）**；资源最终 3890 个 / 788.2 MB。
> - 加载器依赖：新下 58、跳过 12、失败 0（70 项 / 25.4 MB）。
> - 安装器 `--offline` **28 秒成功** → 产出 `libraries/net/neoforged/neoforge/21.1.228/neoforge-21.1.228-client.jar`（5.4 MB）。
> - 启动计划：主类 `cpw.mods.bootstraplauncher.BootstrapLauncher`、classpath 83 项、**磁盘缺失 0**、natives 8 条。
> - **真启动成功**：17.8 秒到主菜单，`Sound engine started`，`newCrashReports: []`。
> - 面板那条路（`POST /scaffold/apply` 走真实 `registerStudioApi`）也实测装通：27.9 秒、`inheritsFrom: neoforge-21.1.228`、六个阶段全 ok。
>
> 顺手修的两处：
> - **`vanillaFiles` 重复计数**：它本来含资源对象文件，界面上「本体 3984 + 资源 3911」看着像算了两遍。`counts` 里新增 `coreFiles = vanillaFiles - assetFiles`，面板/describe 都用它（现在显示「本体 73、资源 3911」）。
> - **装完步骤全显示「☐ 要装」**：payload 里的 `steps` 是装之前算的计划，apply 完面板整个换成它，看着像什么都没干。改成按 `result.stages` 里 `status==='ok'` 的 key 回填 `done`。
>
> 测试：新增 `test/version-manifest.test.mjs`（17 条）、`test/version-install.test.mjs`（13 条）、`test/client-scaffold-ui.test.mjs`（4 条，含「参数名传错就抓得到」和「没填根目录不许发请求」）。全量 **29 个套件 410 条全绿**。
>
> 踩的坑：① `parseMavenListing` 的返回里版本号本身也是 `type:"DIRECTORY"`，按「排除目录」过滤会一个不剩；② `validatePackName()` 返回 `{ok,error}` 对象不是字符串，直接当字符串用会让 `path.join` 收到对象崩掉；③ `runInstaller` 在默认沙箱里 `spawn EPERM`，必须 `danger-full-access`；④ 后台 job 用 `| Select-Object -Last N` 管道会缓冲卡住不返回，改重定向到文件再读。
>
> 2026-10-30 补 13（**用户真机点验报的三个问题**）：用户原话「1.按键有问题，鼠标挪上去就空白了 2.能拖动任务书节点，但是不能编辑 3.没扫描出测试用的存档」。
>
> 1. **hover 变白（CSS 特异性）**：`.mcstudio-row .mcstudio-tag:hover` 特异性 (0,3,0) 压过 `.mcstudio-tag-on:hover` 的 (0,2,0)，于是选中的小标签（版本通道 / 打包形态 / 章节筛选）悬停时背景被换成浅色填充、`color:#fff` 还在 → 白底白字像空白了。在通用规则**之后**补同特异性两条（靠顺序决胜）：`.mcstudio-row .mcstudio-tag-on:hover` 保持品牌色、`.mcstudio-row .mcstudio-tag-warn:hover` 保持告警色。`test/client-plugin.test.mjs` 有守卫（正则抓这两条规则，断言不含 `fill-l2|fill-l3` 且位置在通用规则之后）。
> 2. **画布节点只能拖不能改**：点中节点后原来只有「打开这个任务的文字」，而它把编辑器渲染在上面的 ⑨ 段 —— 用户停在页面底部，观感就是「点了没反应」。修法：把 ⑨ 的三个输入框抽成组件内的 `questFieldInputs()`，画布选中卡片里就地渲染同一份输入框 + 「预览会改什么」/「确认写入」（复用同一套 handler 和状态）。`test/client-quest-ui.test.mjs` 有守卫（模拟 pointerdown 选中 → 点编辑 → 断言输入框已填原标题、预览参数带新标题）。
> 3. **扫不到 `lab\` 里的实验副本**：`commonRoots()` 原来只列官方启动器 / CurseForge / Prism / HMCL / `process.cwd()` / PCL2 下载目录，且 `expandRoot()` 只往下挖一层；实验副本在 `<插件根>\lab\重度机械症 - 实验\versions\`，比 `process.cwd()` 深两层。修法：用 `import.meta.url` 算出 `PLUGIN_ROOT`（别用 `process.cwd()`，DSH 从别处启动时 cwd 不是插件目录），给 `expandRoot(dir, label, depth = 1)` 加深度参数，新增候选 `{ label: '项目里的 lab（实验副本）', dir: <PLUGIN_ROOT>/lab, depth: 2 }`，其余候选仍是 1 层（别去扫大目录）。实测 `/roots` 能列出 `重度机械症 - 实验` 下 3 个实例（Mechanomania、最小包、路由装出来的包）。
>
> 测试：409 → **411**（client-plugin 8、client-quest-ui 4）。
>
> 2026-10-30 补 14（**物品图标：任务书里能看见物品长什么样**）：用户说「感觉还是不是很好编辑，不是完全的可视化，把物品的图标也带上如何？」并补充「是在选好 mod 之后编辑任务书的时候，需要看到图标」。
>
> 新增 `lib/core/item-icon.js`（不联网、全本机）：`buildTextureIndex(modsDir)` 扫每个 jar 的中央目录建三张表 —— `byId`（`assets/<ns>/textures/<item|block>/<name>.png`）、`byPrefix`（贴图放在子目录里的，按第一段登记，例如 `textures/block/water_wheel/0.png` → `create:water_wheel`）、`modelsById`（`assets/<ns>/models/item/<name>.json`）。`resolveIcons(instance, ids)` 三轮：直接命中 → 模型反查 → 原版资源。缓存三张（索引/图标/原版表，TTL 10 分钟）。
>
> 三个必须知道的实现点：
> 1. **模型必须顺着 parent 链往上追（最多 6 层）**。Create 的 `models/item/shaft.json` 内容只有 `{"parent":"create:block/shaft"}`，贴图写在方块模型里；只读自己那一层，整个 Create 的物品图标会全丢。
> 2. **贴图会放在子目录里**。有些 mod 的贴图叫 `textures/block/water_wheel/0.png`，按完整文件名永远找不到，所以要多一张「第一段」索引。
> 3. **原版物品要有两条路**：先按 `assets/indexes/<id>.json` 的 hash 去 `assets/objects/` 取；这份索引可能不完整（实测有台机器索引里一个 `minecraft/textures/item/` 键都没有），那就退回从 `versions/<ver>/<ver>.jar`（客户端 jar）里直接读。
>
> 宿主一条路由 `/item-icons`（**路由 33 → 34**，GET/POST 都可，一次最多 128 个），返回 `{icons: {id: dataUrl}, missing: [...]}`。面板：⑧ 列表每行、⑨ 详情、⑪ 加任务表单（填了 ID 就出图）、⑫ 画布节点都换成物品格子；画布节点几何从 66×34 改成 **40×40 方形格子 + 图标 24px + 标题挪到下面一行**。取不到图标就显示字母方块（`C` = cogwheel），不报错不卡住。
>
> 实测（本机 Mechanomania，183 个 jar、395 个任务、337 个不同图标物品）：建索引 206 ms，取 128 个 99 ms，**命中 110 个（86%）**，原始字节 119 KB。第一版只有 72/128，加上「子目录索引」与「parent 链」两条后到 109，再加「客户端 jar 兜底」到 110。
>
> 剩下 14% 是同一类：`create:water_wheel`、`create:mechanical_drill` 这些用 `neoforge:obj` 三维模型，压根没有单张 2D 图标（模型里 textures 引的是 `block/spruce_log` 这种原版方块贴图）。
>
> 顺手修了测试替身的一个真问题：`test/client-quest-ui.test.mjs` 的最小 React **不会展开函数组件**，所以 `Kv` / `ItemIcon` 之前根本没被渲染（这也是早前「任务 ID 标签看不到」的根因）。新增 `expand(node)` 把 `type` 是函数的元素调一遍，**并且要把 children 搬进 props**（React 的约定），否则 `Kv` 这种用 `props.children` 拼内容的组件会渲染成空。
>
> 测试：411 → **432**（新增 `test/item-icon.test.mjs` 8 条、host-api 加 2 条到 24、client-quest-ui 加图标断言仍在 4 条）。
>
> 2026-10-30 补 15（**高清图标：让游戏自己导出，替代手写 3D 渲染器 —— ✅ 已完成并实测跑通**）：用户提「直接把 JEI 的渲染功能拿过来用」。
>
> **结论：JEI 不能直接用**（它只是把游戏自己的物品渲染器调到界面上，不产出文件、也没有「给我一张 PNG」的接口）。但这条思路是对的 —— 让游戏来画。已经有人把它做成 mod 了：
>
> - [Icon Exporter](https://modrinth.com/mod/icon-exporter)（Modrinth 工程 `8KCmS7Bd`，slug `icon-exporter`，作者 kroeser，MIT）
> - 1.21.1 NeoForge 版本：`iconexporter-1.21.1-neoforge-1.4.2.jar`（41,406 B，sha1 `12570815bd80639da5f91bd51d9c74b3cdf9c43f`）
> - **前置**：Cyclops Core（工程 `Z9DM0LJ4`，slug `cyclops-core`），1.21.1 NeoForge 版本 `cyclopscore-1.21.1-neoforge-1.30.0.jar`（1,163,177 B）
> - 支持 `1.18.2 → 26.3`，**含我们两个目标版本 1.21.1 NeoForge 与 1.20.1 Forge**
> - 用法：进游戏执行 `/iconexporter export 64`（64 = 图标边长像素）；遍历**所有已注册物品**（含 NBT 变体），输出透明底 PNG
> - 输出目录：**`<实例目录>/icon-exports-x64/`**（实测名字带 `x64` 后缀，不是文档说的 `-64`；代码里按前缀 `icon-exports` 扫，所以尺寸档位换了也能认）
> - 文件名：**`<modid>__<itemid>[__<NBT变体>].png`** —— 只取前两段就能拼出 `modid:itemid`
> - 流体的文件名是 **`fluid__<ns>__<name>.png`**，第一段是字面量 `fluid`，**不是物品**，必须跳过（否则会解出 `fluid:create` 这种假 ID）
> - 可以按 mod 过滤（`/iconexporter export 64 create` 之类），也支持 `exportmetadata`
>
> **实测结果（2026-10-30，实验室「最小包」1.21.1 + NeoForge + Create）**：导出目录 **2150 个 PNG / 3.9 MB**，其中 **1895 个能对上物品 ID**（其余是 1555 个 `minecraft__*` 之外无法解析的流体与 NBT 变体）。之前 jar 直读拿不到的 `create:water_wheel`(5059 B)、`create:mechanical_drill`(3671 B)、`create:fluid_pipe`(1783 B)、`create:large_water_wheel`(6603 B)、`minecraft:copper_ingot`(568 B) 全部有图了，取图**用时 25 ms**（直接读 PNG，完全不碰 jar）。
>
> **怎么启动游戏让它导出（踩过的坑）**：
> - 新增探针 `tools/probe-launch-leave.mjs`：`plan()` → `extractNatives()` → `spawn(java, [...jvmArgs, mainClass, ...gameArgs], {cwd, detached:true, stdio:'ignore'})` + `unref()`，**不判主菜单也不杀进程**（`probe-launch-apply.mjs` 是判到主菜单就 SIGTERM，正好相反）
> - **脚本末尾必须常驻**（`setInterval(()=>{}, 1<<30)` + 监听 `child.on('exit')`）：DSH 的 pwsh 调用一结束就会回收整个进程树，`detached+unref` 也挡不住，游戏会跟着陪葬
> - 以 **background job** 方式跑（前台调用超时后会自己转后台，也行）；必须 `danger-full-access`，沙箱内 spawn 必 EPERM
> - **受限沙箱里 `Get-Process java` 看不到这个游戏进程**（只有 23 个进程可见），判断游戏死活要看 job 是否还 running + `logs/latest.log` 是否在写，别信进程列表
>
> **已落地的代码**：
> 1. 新增 `lib/core/icon-export.js`：`findExportDirs(instance)`（扫实例目录与 mcRoot 下 `icon-exports` 开头的子目录，名字倒序即大图优先）、`parseExportName()`（只取前两段，跳过 `fluid__`）、`buildExportIndex(dirs, {force})`（→ `{dirs, files: Map<id,{file,bytes}>, count, totalBytes, skipped, elapsedMs}`，同物品多变体只留第一个，缓存 TTL 10 分钟）、`readExportedIcons(files, ids)`（→ `{icons: Map<id,{dataUrl,bytes,source}>, missing}`）、`describeExportIndex()`、`resetExportCache()`
> 2. `lib/core/item-icon.js` 的 `resolveIcons()` 加**第 0 轮**：导出目录优先（100% 保真），没有再走 jar 直读（86%）；返回值多一个 `exported: {count, dirs}` 字段
> 3. 宿主 `lib/host/icon-api.js` 加 `handleIconExportStatus`（`GET|POST /icon-export/status`）与 `handleIconExportScan`（`POST /icon-export/scan`，强制重扫）；**路由 34 → 36**
> 4. 面板 ⑧ 段标题下加一行来源说明 + 「重新扫描图标」按钮：有导出目录时显示「图标：游戏导出的高清图 1895 个」，没有时显示「从 mod jar 里直接找（约 86% 有图）」并给安装指引
> 5. 导出完那两个 jar 可以留着也可以删（纯客户端工具）；`mc_mod_install` 只装不删，要移除目前得手动删或另加工具
>
> **顺手修的真 bug（工具层 schema，第二次同类）**：`mc_mod_install` 的 `installed[]` 在输出 schema 里只声明了 4 个字段，但 `result.installed` 实际还带 `sha1` 与 `mode` → 宿主按 `additionalProperties:false` 判成 `value.installed[0].sha1 is not a declared property`，**把成功当失败**（文件其实已经落盘了）。已在 `lib/tools/mod-download.js` 补上这两个字段声明。
> ⚠️ **这类坑会反复出现**：工具返回对象多一个没声明的字段，整条调用就报「invalid output」，而且报错看着像工具坏了。上次是 `lib/tools/shared.js` 的 `COMMON` 少 `code`。**加字段时先改 schema，再改返回值**。
>
> **另一个顺手修的（启动健壮性）**：`lib/core/natives.js` 的 `extractNatives` 原来硬 `fs.rmSync(nativesDir)`，遇到 dll 被占用（上一次游戏没退干净）直接抛 EPERM 中断启动。改成：清空失败只记 `note` 继续；逐文件写入被占用（EPERM/EBUSY/EACCES）收进 `locked[]` 并沿用旧文件（同版本内容一致不影响启动）；`describeNatives` 补「N 个被占用（沿用旧文件）」，`lib/tools/launch.js` 也跟着多打一行。
>
> **测试**：新增 `test/icon-export.test.mjs` 7 条；host-api 24 → **28**（status 认出目录且只把 fluid 记 skipped、没目录时如实说没有、scan 能扫到新丢进去的图、`/item-icons` 优先用导出的并回 `exported`）。全量 431 → **432**。
>
> 2026-10-30 补 16（**1.20.1 Forge 的「从零装底座」打通了 —— 用户硬约束里的另一半**）：用户选了「把 1.20.1 Forge 打通」。之前只验证过 1.21.1 NeoForge，原因很实在：这台机器上**只有 Java 21**，而 1.20.1 Forge 要 **Java 17**，所以「下不了、也起不来」。
>
> **实测结果（全程真联网、真装、真启动）**：
> - 计划：`1.20.1 + Forge 47.4.28`，要下 3665 个原版文件（651.9 MB 资源 + 库 + 客户端 jar）+ 63 个加载器依赖（15.6 MB）+ 403 个 Java 运行时文件（86.9 MB）
> - 实装：**380.1 秒**，`inheritsFrom = 1.20.1-forge-47.4.28`，安装器尾部 `Successfully installed client into launcher`
> - 启动：**17.3 秒到主菜单**，证据 `[Render thread/INFO] [minecraft/SoundEngine]: Sound engine started`，无 crash-reports
> - 全程只用了机器自带的东西，没让用户手装 Java
>
> **这一轮新增/改了什么**：
> 1. **新增 `lib/core/java-runtime.js`（自动装 Java，87 MB）**：不依赖第三方 zip，直接用 Mojang 官方运行时分发 —— `launchermeta.mojang.com/v1/products/java-runtime/<sha>/all.json` 拿组件清单（`windows-x64` 下 `java-runtime-gamma` = Java 17.0.15），再读组件 manifest（486 条：83 目录 + 403 文件），逐个从 `piston-data.mojang.com` 下 raw 到 `<mcRoot>/runtime/<组件>/`，`bin/java.exe` 打上可执行位。导出 `componentForMajor`（8→jre-legacy / 16→alpha / 17→gamma / 21→delta）、`loadJavaRuntimePlan`、`applyJavaRuntime`、`describeJavaRuntime`。
> 2. **`lib/core/scaffold.js` 多了第 5 步「装 Java 运行时」**：`plan.javaMatches`（本机 Java 主版本是否等于版本 json 的 `javaVersion.majorVersion`）为假时，计划里带一份 `javaRuntime`，实装时先把它下下来再用它去打补丁。**这是「版本不写死」的关键一环**：1.20.1 要 17、1.21.1 要 21，同一套代码自己挑。
> 3. **Forge 的版本列表是 XML，不是 JSON**（真 bug）：`maven.minecraftforge.net/.../forge/maven-metadata.xml`，原来走 `parseMavenListing` 解析必然空。新增 `loaderListIsXml()` + `parseMavenMetadataXml()`，`http` 层补了 `text()`（原来是 `jsonOnce` 里写死 `JSON.parse`）。BMCLAPI 的 neoforge 目录接口**不代理 Forge**（404），所以这条只能走官方 + 镜像规则自动改写。
> 4. **Forge 1.20.1 的版本目录名带 mc 前缀**（真 bug）：安装器产出的是 `versions/1.20.1-forge-47.4.28/`，而 `locateLoaderVersion` 原来一律猜 `forge-<版本>`，于是实例 json 的 `inheritsFrom` 指到一个不存在的目录，启动直接报「找不到版本 json」。改成：优先用安装器自己 `version.json` 里的 id（`preferredId`），其次 `<mc>-<loader>-<v>`，最后才是 `<loader>-<v>`，并且**按磁盘上真实存在的目录挑**。
> 5. **下载补一遍（真机逼出来的）**：资源 CDN 在 8 并发下会零星回 429 / `fetch failed`，第一次装就剩 6 个文件没下来，整个底座报废。`applyItems` 加第二轮：失败的降到 **2 并发**、错开 1~2.4 秒再试一次（`retryFailures:false` 可关）。实测那 6 个全部补齐。
> 6. **版本清单也加重试**：BMCLAPI 偶发 `ECONNRESET`、官方偶发 TLS 被掐，`fetchManifest` 从「每个地址一次」改成「每个地址三次 + 1.2 秒间隔」。
> 7. **新增 `lib/core/proc.js`（沙箱硬规矩）**：这台机器的 DSH 沙箱**不给子进程管道** —— `stdio:'pipe'` 一律 `EPERM`。所以 `execFile` 收输出（安装器）、`spawnSync` 收输出（`java -version`、`where java`）、`launch.js` 挂 `child.stdout` 全部是坏的，**而且坏得很安静**：`where java` 状态码非 0 → 明明装了 Java 也说没有。统一改法：`fs.openSync(log,'w')` 建 fd → `stdio:['ignore', fd, fd]` → 跑完 `readFileTail` 读回来。`proc.js` 导出 `captureCommand`（异步，带超时/取消）、`captureCommandSync`、`readFileTail`，7 条测试守着这条底线。
> 8. 面板跟着改：计划卡片多一行「要装 Java：这个版本要 Java 17，会先下官方运行时 java-runtime-gamma（86.9 MB）」，「开始装」的禁用在「本机有 Java **或** 会自动装 Java」时都放开。
>
> **测试基线变了**：32 个套件 → **33 个套件 / 457 条全过 0 挂**（新增 `test/proc.test.mjs` 7 条、`test/java-runtime.test.mjs` 10 条，version-install 14 → 17，界面「从零装底座」4 → 6）。
>
> **还没在这一轮验证的**：面板里的这条新链路没人真点过（脚本层已验证）；Fabric/Quilt 的从零装底座仍然只有列表解析、没有安装流程（它们不用安装器，得直接拼版本 json + 建 `versions/<id>/`）；真 PCL 拖包验收还是没做。

> 2026-10-31 补 26（**自己把方块模型画成等轴测图标，和 JEI 对上**）：用户上一轮问「为什么不直接用 jei 的物品查看功能，应该可以复用的吧」，并在更早授权「继续做吧，我一会儿来验收」。
>
> **为什么不能直接复用 JEI**：JEI 是游戏内的 mod，图标是**运行时用 OpenGL 把模型渲染出来**的，磁盘上没有现成的图；我们这个面板是 DSH 里的网页（Node 宿主 + 浏览器），不启动游戏，只能读 jar 里的静态资源。真能复用的只有「一次性导出」：让客户端把图标渲染成 PNG 落盘，我们再读（`findExportDirs` / `readExportedIcons` 那一轮已经留好了，图在那儿就不做静态解析）。
>
> **这一轮做的事**
> 1. **`lib/core/png-frame.js` 补上像素级读写**：导出 `pngPixels(buf)`（解 IHDR/PLTE/tRNS/IDAT，支持 colorType 0/2/3/4/6、位深 1/2/4/8/16，不支持隔行）与 `encodePng(w,h,rgba)`（8 位 RGBA、滤波 0、`deflateSync(level 9)`）。内部拆出 `splitPng` / `unfilterAll`，共用 `layoutOf` 算的 bpp 与行宽。
> 2. **新文件 `lib/core/model-render.js`**：`project(x,y,z)=[(x-z)·cos30, (x+z)·0.5−y]`（等轴测，y 朝上）；六面法线 + `SHADE`（up 1 / north·south 0.8 / west·east 0.6 / down 0.5，和 MC 自带明暗一致）；`loadModelChain(readJson, startRef, {maxDepth=6})` 顺 parent 链合并（textures 子覆盖父、`elements` 有子层用子层）；`fillTriangle` 屏幕空间重心插值 + 最近邻取样，`alpha<128` 跳过；`renderModelIcon({model, loadTexture, size})` **只画朝相机的三面**（up/south/east），按 `depth=(x1+x2+y1+y2+z1+z2)/2` 升序（画家算法），包围盒等比缩放到 0.94 居中，`drawn===0` 返回 null。**不做 element.rotation、不做 tint、不做光照**。
> 3. **接进 `lib/core/item-icon.js`**：`renderIconFromModel(zip, entry, displayName, fallbackPng)`（模型引用不带命名空间的贴图要按模型自己的 ns 补全，`block/tnt_side` 这种写法很常见）；第 2 轮开头先试渲染，失败才退回「按词根+面积挑一张贴图」；新增 **第 2b 轮**（`blockModelsById` / `blockStateById` → `firstModelOfBlockState` → 模型 → 渲染），**第 1 轮只认 `textures/item`**，平铺的方块贴图退到**第 2c 轮**兜底。
> 4. **新测试 `test/model-render.test.mjs` 6 条**：顶面原色 + 东面 0.6 + 南面 0.8、只有背面 → null、贴图拿不到 → null、没有 `elements` → null、parent 的 elements 被继承、子 textures 覆盖父。
> 5. **`test/item-icon.test.mjs` 20 → 21**：新增「物品模型带 elements 就整张画出来」（`minecraft:render_cube`）；`chain_rope` 那条从「不出图」改成「有 elements 就必须出图」。夹具里补了 `PNG_OPAQUE`（原来那张 1×1 PNG 的 alpha 是 127，渲染器按透明跳过它 —— 会让人误以为渲染器坏了）。
>
> **实测（Mechanomania）**：物品 10386、索引 550ms、**有图 9624 / 缺 762（7.3%）**、其中**等轴测渲染 3445 个**；全量取图 7722ms（比只取贴图的 3139ms 慢，这部分就是渲染开销）。形状体检（`lab/_probe-render-stats.mjs`）按不透明像素占比分桶：0-12% 92、12-25% 378、25-45% 1182、45-80% 1767、**80% 以上 0 个** → 没有「贴满整格」的投影错误；过细的是本来就细的模型（`create:piston_extension_pole` 3%、`copycats:copycat_slope` 7%、平盘食物 9~12%）。
>
> **测试**：全量 **37 套件 / 553 通过 / 0 挂**（新增 model-render 6 条，item-icon 20 → 21）。
>
> 2026-10-31 补 27（**P0 抽包 + P1 本地服务：独立软件的地基**）：用户拍板「① 直接开工 P0+P1」—— 把 core 抽成独立包、再给它套一个本地 HTTP 服务，为独立工作台铺路。
>
> **P0：`lib/core` → `packages/core`（已完成）**
> 1. 整目录复制成 `packages/core/`（36 个 .js），外加新文件 `item-search.js` —— 把 `rankOf` + `searchItems` 从工具层搬进来（约 60 行纯函数）。理由：`lib/tools/*` 依赖 `@deepseek-ai/dsh-tools`，独立后端不该被迫装 DSH SDK。
> 2. 引用迁移 51 个文件：`lib/tools/*.js` 的 `'../core/x.js'` → `'../../packages/core/x.js'`；`test/*.mjs` 的 `'../lib/core/x.js'` → `'../packages/core/x.js'`。脚本是 `lab/_migrate-core-imports.mjs`（默认只算，`--apply` 才写）。
> 3. **删掉 `lib/core`**（先备份到 `lab/_backup-lib-core/`）。两份副本会出真 bug：`lib/host` 从 `packages/core` 抛 `McError`、测试从 `lib/core` 导入 → 两个不同的类，`instanceof` 为假但类名一模一样，报错长这样「应该抛 McError，实际是 McError」，看一眼完全懵。
> 4. `packages/core/package.json`：`"type": "module"`、`exports` 里 `"./*.js": "./*.js"`。
>
> **P1：`packages/server`（基本完成）**
> 5. 从 `lib/host/api.js` 抽出纯派发函数 **`dispatchStudioRequest(request)`**：按 `ROUTES` 匹配路径 → 校验方法 → 调 handler → 包成 `Response`。DSH 插件的 `registerStudioApi` 现在也走它，**插件里点和独立版点是同一套逻辑**，不会分叉。
> 6. `packages/server/server.js` 只做翻译：Node `IncomingMessage` → `{url, method, text(), json()}`；`Response` 写回 `ServerResponse`。请求体只读一次并缓存（handler 可能既读文本又读 JSON）。
> 7. **坑：适配器必须给 url 补 origin**。各 handler 里写的是 `new URL(request.url)`（DSH 传进来的是绝对地址），只给 `/instances?...` 会报 `Invalid URL` —— 这条卡了一轮，12 条接口全 500。
> 8. 跨域/预检放开（服务只监听 `127.0.0.1`）；未知路径 404 + 带出路径名，方法不对 405 + 列出允许的方法。
> 9. **实测**：`lab/_probe-server2.mjs` 起服务打 17 条代表性接口（总览/搜物品/mod 清单/配方详情/配方改动预览/任务书/画布/mod 搜索/打包预览/图标导出/物品图标/装 mod 清单等）**17/17 全通**；新增 `test/server.test.mjs` 7 条守住翻译层。
> 10. 还没做：SSE 进度流、静态文件托管、`mcstudio serve` 命令行入口 —— 这三样跟 P2 前端一起做更顺。
>
> **事故与修复（诚实记录）**：做 P0 时用 PowerShell 批量替换路径，`Rewrite($path, $pairs)` 的数组参数被拍平成字符串，`$p[0]`/`$p[1]` 变成字符串前两个字符，实际执行成了「把所有单引号换成句点」——`lib/tools/*.js`(16)、`test/*.mjs`(37)、`lab/*.mjs`(~90) 全中招，且**没有备份可回滚**。写了词法逆向修复器 `lab/_repair-quotes.mjs`（`lab/_repair-all.mjs` 批量 + `node --check` 校验）修回来，逐轮补上这些误判：路径里的 `/` 提前截断、模板串 `${}` 里的代码、正则字面量里的 `['"]`、`'ab'.repeat` 这种字符串后接属性访问、行首点号、中文句子里的「. 」。最终 **67/67 文件 `node --check` 全过、0 处未判定**，只剩 5 处「双引号串里的单引号」要手修（TOML 夹具、`includes("'")`、`我的人's 文件夹`、kubejs 的 7 处模板串 fixture）。修完 **553 条一条不差** —— 这是修复忠实的证据。留下的工具：`lab/_scan-dots.mjs`（扫疑似被替换的引号，只打印）。
>
> **测试**：全量 **38 套件 / 560 通过 / 0 挂**。
>
> **必须重启 DSH**（core 层改动），然后 Ctrl+F5。
>
> 2026-10-31 补 33（**多选一起挪 + 「向左侧吸引」的真凶**）：用户原话「选中多个任务，没法一起挪动，原因可能是默认向左侧吸引」。
>
> **不是「吸附」**：`snap()` 只是 `Math.round(v*2)/2`（吸半格），没有夹取、也不往左拉。真因两件事叠在一起：
>
> 1. **拖完那一下 `click` 把多选收成了单选**。浏览器 `pointerup` 之后必然补一个 `click`，而节点 `click` 走 `selectQuest()` → `state.selSet = [id]`。于是坐标虽然一起写了，但选择立刻塌回单选，用户接着再拖就只有一个动。修法：`state.suppressClick` 开关（`onUp` 真拖动过就置真，`click` 一进来先消费掉并 return）；顺带加 `Ctrl/Cmd/Shift + 点击` 加选（`toggleSelect()`，之前只能框选）。
> 2. **画布原点跟着包围盒漂**（这才是「向左侧吸引」）。`canvasSvg()` 的原点是「所有节点包围盒左上角」`minX/minY`，把最左边的任务往右挪一格，`minX` +1，**整张图在屏幕上整体左移一格**，没动的节点也在跳。修法：记住 `state.canvasOrigin`，重画时补偿 `state.view.tx += scale * (minX - origin.x) * CELL_X`（`ty` 同理），`connect()` 里置空。**符号第一版写反了**，验算：`minX` 0→1、`rect.x` 少 132，要维持屏幕位置 `tx` 得 `+132`，即 `(1-0)*132`。
>
> **测试**：`ui-app` 10→13 条 —— 「Ctrl+点击 能加选」、「多个选中一起拖完选择还在」、「最左任务往左挪时其他任务的屏幕横坐标不变」（用 `mcs-viewport` 的 `translate` + `rect.x` 算，是原点漂移的回归哨兵）。**测试替身 `dragBy` 现在会在 `pointerup` 后补发一次 `click`**，模拟真实浏览器；不补的话 `suppressClick` 跨用例残留，会把下一个用例的点击吞掉。全量 **41 套件 / 598 通过 / 0 挂**。
>
> **不用重启 DSH**（只改 `packages/ui` 静态页），Ctrl+F5 即可。
>
> 2026-10-31 补 32（**连线实时跟随 + 拖动不留黑框**）：用户原话「1.连接的线不能实时变化 2.在画布上会有黑框出现，要等放置后，黑框才会消失，是刚开始申请的空间大小不够吗」。
>
> **问题 1（连线不动）真因**：拖动为了手感只改节点 `<g>` 的 `transform`、不重渲染；连线是建画布时算好坐标的 `<line>`，不会自己变。修法：建画布时把每条线记成 `{el, fromId, toId, x1, y1, x2, y2}` 存进 `state.edgeEls`，拖动时 `shiftEdges(ids, dx/scale, dy/scale)` —— 只改相连的线，**每次按「原始坐标 + 位移」重算而不是累加**，所以不会越拖越偏；松手 `shiftEdges(ids, 0, 0)` 复位再写盘。**插件面板不用改**（React 状态驱动，`setCanvasPos` 本来就实时重算）。
>
> **问题 2（黑框）真因不是「画布太小」**，是两处渲染层：
> 1. 根 `<svg>` 自己被 `transform` + `will-change: transform` → 浏览器把整个 svg 提成合成层，拖动时旧位置不重绘就留一块纯黑。修法：平移缩放改作用在内层 `<g class="mcs-viewport">`（`state.viewportEl`），`applyView()` 不再碰根 svg，删掉 `will-change`。
> 2. `<image>` 被浏览器当成可拖图片 → 拖出黑方块幽灵。修法：`<image draggable="false">` + `.mcs-canvas{user-select:none;-webkit-user-drag:none}` + `.mcs-canvas image{pointer-events:none}` + svg 上 `dragstart → preventDefault()`。
> 3. 顺带 `.mcs-canvas svg{overflow:visible}`，节点拖出数据范围不会被裁掉。
>
> **测试**：`ui-app` 8→10 条 —— 「拖动时连线跟着走」（先单独选中甲避免多选残留、重画后再找线、`pointermove(132,0)` 不松手、断言起点 +132 而另一端完全不动）+ 「平移缩放落在内层 `<g>` 上」（根 svg 无 transform、viewport 层有、svg 有 dragstart、图标 `draggable === 'false'`，这是黑框的回归哨兵）。全量 **41 套件 / 595 通过 / 0 挂**。
>
> **不用重启 DSH**（只改 `packages/ui` 静态页），Ctrl+F5 即可。
>
> 2026-10-31 补 31（**拖动即落位：蓝图交互对齐 UE，取消「确认挪动」**）：用户原话「我已经测试过蓝图功能了，有点问题，为什么要有确认挪动这种功能，不应该挪完之后就算挪好了吗，我建议你去github上找找蓝图编辑的项目，我觉得ue的蓝图编辑功能是我见过最好用的」。
>
> **核心一句**：**松手即写盘**。原来松手只是「出计划 → 用户再点确认」，用户觉得反直觉，删掉整条 preview 链路。
>
> **改了六件事**
> 1. 拖动松手 → `commitMoves()` → 乐观改本地坐标（视觉立刻落位）→ `POST /quest/move/apply` → 重读画布。不再有 `state.movePlan` / `moveCard()` / `/quest/move/preview`。
> 2. **多选一起挪**：`state.selSet`，拖任一已选节点则全部一起动，一次请求带多条 `moves`。
> 3. **空白处拖动 = 框选**（`.mcs-band`，位移 <6px 不算拖动，纯点空白 = 清空选择）；**中键 = 平移**；**滚轮 = 绕鼠标缩放**（0.35–2.5）；**空白处双击 = 就地新建任务**。
> 4. **撤销/重做**：`undo`/`redo` 栈（上限 30），撤销 = 拿栈顶 from 坐标再发一次 apply（复用同一接口，**后端零改动**）。`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`；右栏 `undoBar()` 常驻。
> 5. 底部一行手势提示。
> 6. **插件面板同步**（`lib/client.js`）：`putNode()` 直接 `commitMove()`，删掉 `canvasPending`/`canvasPreview`/`canvasApply`/`canvasReset`，`canvasDone` 卡加「撤销这次挪动」。
>
> **为什么敢直接写**：`/quest/move/apply` 本来就先备份 → 写 → 重读体检 → 有问题 `restoreFiles` 整体回滚，最坏是整体回滚 + 报错。
>
> **四个坑（都会让人卡半天）**
> 1. `beginBand` 里直接引用 `canvasSvg` 的闭包变量 `byId`/`px`/`py` → `ReferenceError: byId is not defined`。改成第四参传 `{byId,px,py}`。
> 2. **测试假 `fetch` 返回同一个对象引用** → 前端乐观改坐标把假数据也改了，后面用例全被污染（双击坐标 `3.5` 变 `4.5`）。必须每次 `JSON.parse(JSON.stringify(body))` 深拷贝。
> 3. **插件侧撤销状态不能放 `useRef`**：界面要按它决定按钮出不出，`useRef` 改完不重渲染；测试替身的 `useRef` 还每次渲染换新对象。改 `useState`。
> 4. `loadCanvas()` 内部会 `setCanvasDone(null)`，所以 `commitMove` 必须**先 `await loadCanvas()` 再 `setCanvasDone(r)`**，否则「挪好了」提示立刻被抹掉。
>
> **测试**：`ui-app` 4→8 条（拖动直接写盘且不调 preview / 撤销 / 框选多选一起拖 / 空白双击新建）；`client-quest-ui` 13→14 条。全量 **41 套件 / 593 通过 / 0 挂**。
>
> **不用重启 DSH**（`packages/ui` 是静态页，Ctrl+F5 即可）；插件面板那部分改了 `lib/client.js`，也是 Ctrl+F5。

> 2026-10-31 补 30（**桌面双击启动：方案 A 已做完，Electron 留到最后**）：用户问「启动方式能不能做成在桌面上双击应用快捷方式的形式，先回答我，别开始制作」→ 我给了三条路（A 快捷方式+脚本 / B 单 exe+Edge `--app` / C Electron 真 exe）→ 用户拍板「**先做A吧，之后在改成C的形式，这点写到计划里，大概在项目的最后修改形式**」。
>
> **链路**：桌面 `整合包工作室.lnk` → `wscript.exe "packages/server/启动.vbs"` → 隐藏窗口跑 `node packages/server/launch.mjs` → 服务脱离父进程常驻 → 默认浏览器打开 `http://127.0.0.1:7456/`。
>
> **两个新文件**
> - `packages/server/launch.mjs` —— 启动大脑。导出 `argOf/hasFlag/pageUrl/healthUrl/log/probe/isHealthy/waitHealthy/startServer/openBrowser/ensureServer`；开关 `--port`、`--no-browser`、`--dry-run`。逻辑：已健康就直接开页面（**绝不起第二个**）；端口被占但不健康就等 5 秒再报 `McLaunchPortBusy`；否则 spawn 脱离的服务、等健康检查、开浏览器，30 秒超时抛 `McLaunchTimeout`。
> - `packages/server/setup-shortcut.mjs` —— 一次性安装。画 `app.ico`（6 个尺寸 16–256，等轴测立方体 + 圆角底板）、生成 `启动.vbs`（UTF-16LE 带 BOM）、用 PowerShell 建 `.lnk`。**桌面写不进去（沙箱 workspace-write，报 `UnauthorizedAccessException`）→ 自动退到项目根目录，并提示用户自己拖到桌面。**
>
> **三个必须记住的约束**
> 1. `spawn(..., {detached:true})` + `unref()`，否则 VBS 一退出服务就被带走。
> 2. `stdio` 必须 `'ignore'` —— 接管道在这个沙箱必 EPERM（就是 §7 坑 5b，独立版同样成立）。
> 3. **VBS 里的引号一律用 `Chr(34)` 拼**。用 `""` 嵌套必算错，第一次就炸在行 7：`Microsoft VBScript compilation error: Unterminated string constant`。
>
> **另外两个坑**：PowerShell 会往 stdout 混 CLIXML 进度 XML（`runPowerShell` 要按行过滤、只取以 `.lnk` 结尾的那行，否则打印出来的路径是一坨 XML）；`--no-browser` 时日志文案也要跟着改（原来还写「打开页面」）。
>
> **实测**：dry-run 打印计划 exit 0；真启动约 **300ms 就绪**；再跑一次 → 「端口 7471 上已经有服务了，直接开页面」exit 0；`cscript //nologo "packages\server\启动.vbs" --no-browser --port 7472` → exit 0、`/api/mcstudio/roots` 200。图标像素体检：四角 alpha=0、底板 `#1b1e24` 占 70.4%、三个面各 8.1%（面积三等分 = 投影没歪）。
>
> **测试**：新增 `test/desktop-launch.test.mjs` **11 条**（注意别和 `test/launch.test.mjs` 混了 —— 那个测的是**游戏启动**）。全量 **41 套件 / 588 通过 / 0 挂**。
>
> ⚠️ **一条在 DSH 沙箱里测不出来的事**：「服务脱离父进程常驻」这条**在本沙箱里验证不了** —— DSH 用 job 对象管子进程，命令一结束整棵树就被回收，`detached + unref` 也留不住。表现是：同一条命令里启动 → 立刻访问 200；换一条命令再访问 → 连不上。**这不是启动器的 bug**：用户从资源管理器双击 `.lnk` 时不在任何 job 里，服务会正常常驻（下次双击 `isHealthy` 命中就直接复用）。验证办法只有一条 —— 让用户真双击一次，关掉浏览器再双击一次，第二次日志应该写「端口 7456 上已经有服务了，直接开页面」。
>
> **以后换 C（Electron）时**：`packages/ui` 一行不用改（它只是 `fetch('/api/mcstudio/...')` 的静态页）。main 进程起 `createStudioServer`、`BrowserWindow.loadURL(studio.url)`、图标复用 `app.ico`、加单实例锁和端口自选即可。**按用户要求放在项目最后做**，已写进 `docs/archive/HANDOFF-STANDALONE.md` §6 的 P4 行与 §6.5 末尾。

> 2026-10-31 补 29（**工作台重做成三栏：选项目 → 进工作台 → 左 mod / 中蓝图 / 右检查器**）：用户原话「不应该是流水线铺出来，而是页面，选定项目后，进入制作阶段，随后体检。左侧栏是mod列表，可搜索导入整合包，中间是任务书蓝图编辑，右侧栏应该放什么我还没想好」。
>
> **为什么改**：补 28 那一版是「左栏一条八阶段流水线 + 右栏一个面板」，本质还是把侧边栏换了个皮肤 —— 用户要的是**页面**：先挑包，进去就是干活的三个栏位。流水线那套（`packages/ui/stages.js` 的 `stageStatus`）**没删**，7 条单测还在跑，只是界面不再渲染它。
>
> **改成了两个屏幕**（`state.screen = 'pick' | 'studio'`）
> 1. **选项目页**：大标题 + 「先挑一个整合包」+ 按常见位置分组的实例列表（每个 root 并发拉 `/instances`）+ 「手填目录」卡片。没有流水线、没有阶段圆点。
> 2. **工作台三栏**：
>    - **左 268px · Mod 列表** —— `/mods` 结果在前端按 `name + modId` 子串过滤（列表本来就在手里，不走接口），最多渲染 400 条；下面「装新 mod」展开搜索 → `/mod-search` → `/mod-install/preview` → `/mod-install/apply`，装完自动重读。
>    - **中 · 任务书蓝图（占满剩余宽度）** —— `/quest/canvas` 画 SVG。**点**方块 = 选中；**拖** = 只改 DOM 的 `transform`，松手才换算成格子坐标（`snap` 到 0.5 格）→ `/quest/move/preview` → 右栏确认才写；**右键** = 菜单六项（改名/副标题、换图标、改前置依赖、在它后面加一个任务、删掉这个任务）。
>    - **右 340px · 选中任务检查器** —— 用户说「还没想好」，这里放选中对象的详情 + 四个操作 + 所有写操作的**计划卡/结果卡**。理由：中间是蓝图，点一个节点最自然的下一步就是在右边改它，两态卡也需要固定落点。
>
> **一律 plan → apply 两态**：编辑卡（换图标 / 改前置 / 删任务 / 就地新建 / 改名）→「预览会改什么」→ 计划卡（changes / diff / warnings / 会写哪些文件）→「确认写入」→ 结果卡（lines / backups）。
>
> **接口后端一行没改**，全是复用：`/quest/node/preview|apply`、`/quest/node/delete/preview|apply`、`/quest/move/preview|apply`、`/quest/add/preview|apply`、`/quest/preview|apply`、`/mods`、`/mod-search`、`/mod-install/preview|apply`、`/quest/canvas`、`/item-icons`。
>
> **两个 DOM 替身的新坑（以后写界面测试必看）**
> 1. `el()` 里 `class` 是**赋给 `className`** 的，不走 `setAttribute` —— 按 class 找元素要同时看 `node.className` 和 `node.attrs['class']`。踩的时候表现是「菜单明明渲染了，测试找不到菜单项」。
> 2. `post()` 传的是**相对路径**（浏览器自动补 origin），但测试的假 `fetch` 必须 `new URL(String(url), 'http://127.0.0.1:7460')`。不给就抛 `Invalid URL`，被 `run()` 吞成一条界面报错，表现为「点了按钮但接口没被调用」—— 这个最难查，因为界面看起来只是「没反应」。
>
> **测试**：`test/ui-app.test.mjs` 2 → 4 条（选项目页 / 进工作台三栏 / 点方块看详情 / 右键换图标预览+写入，含 payload 与 diff 文案断言）。`test/ui.test.mjs` 里那条 `assert.match(js.text, /stageStatus/)` 改成 `/\/quest\/canvas/`（app.js 不再引用阶段栏）。全量 **40 套件 / 577 通过 / 0 挂**。
>
> **不用重启 DSH**：只改 `packages/ui/*`，刷新页面即可；服务不用重启（静态文件每次请求都从磁盘读）。
>
> **这一版还不能干**（诚实清单）：改配方、从零装底座、从零建包、打包、启动验证都没接（后端接口都在）；左栏还没有「导入整合包」入口（目前靠顶栏「换项目」回选项目页）。

> 2026-10-31 补 28（**P2 第一版：浏览器工作台**）：用户选了「先做浏览器版页面」。这一步换的是**形状**，不是把侧边栏搬过去。
>
> **做出来的东西**
> 1. `packages/ui/stages.js` —— 八阶段的定义 + `stageStatus(facts)` / `nextStep(facts)`，**纯函数**，能直接在 Node 里测。规则：**第一个没做完的阶段就是「当前」**，它后面全算「还没到」，所以顶栏永远有一句「下一步：任务线：读任务书并打开蓝图」。
> 2. `packages/ui/app.js` —— 界面主体：左侧阶段栏 + 8 个面板 + 接口调用。**不引入 React、不引入构建步骤**，直接操作 DOM；改完刷新页面就生效，不用重启服务。
> 3. `packages/ui/index.html` + `style.css` —— 壳和配色。**刻意不用 DSH 主题 token**（那套变量写错会静默失效，插件那边吃过亏），自己定义 7 个变量。
> 4. `packages/server/server.js` 加 `tryStatic()`：只服务 `packages/ui` 下的文件、**只认一层文件名**（正则 `^[A-Za-z0-9._-]+$`），`../` 穿越在拼路径之前就被挡掉；后缀不在白名单里一律 404。
> 5. `packages/server/bin.mjs` 启动提示改成打印**页面地址**（原来只打印接口地址）。
>
> **这一版能干**：连包（常见位置 / 手填 / 列实例）、看体检、搜物品（中文或 ID）、看配方「怎么来的 / 谁在用它」、看配方详情、读任务书、看蓝图（SVG 连线和方块，点方块看任务详情）、查图标导出状态、算打包计划、真打 zip。
>
> **这一版还不能干**（诚实清单）：改配方、改任务（换图标/改依赖/删任务）、拖拽挪位置、从零装底座、启动验证。后端接口全都有，只是界面没接 —— 下一轮就是把这些「写」的动作按 plan → apply 接上。
>
> **测试（新增 2 个套件 15 条）**
> - `test/ui.test.mjs` 13 条：阶段推断 7 条 + 静态服务 6 条（含**路径穿越被挡住、且响应里不能出现源码**）。
> - `test/ui-app.test.mjs` 2 条：**用最小 DOM 替身把 `app.js` 真跑一遍**。为什么必须有它 —— 这个沙箱里起 Edge/Chrome 被拒（Access denied），而「渲染路径里引用了不存在的函数」只有真跑才暴露；开发时漏定义过 `truncate`，浏览器里的表现是整页空白 + 控制台一行红字。
>
> **怎么打开**：`node packages/server/bin.mjs`（默认 7456），浏览器开 `http://127.0.0.1:7456/`。
>
> **测试**：全量 **40 套件 / 575 通过 / 0 挂**。
>
> **不用重启 DSH**：这一轮只加新文件（`packages/ui`）和 `packages/server`，插件侧代码没动。
>
> **顺手做的清理**：批量替换事故当时把 `lab/*.mjs` 那批探针放弃了，86 个里有 78 个语法坏。新写了 `lab/_repair-lab.mjs`（只修「现在 `node --check` 就不通过」的文件，语法本来好的绝不碰——修复器假设所有引号都被换成了句点，对正常代码会误判），修好 74 个；剩下 4 个是 `_patch-doc23.mjs`、`_patch-pits.mjs`、`_patch-route-count.mjs`、`_patch-icon225.mjs`，都是一次性改文档的脚本、改的内容早已落盘，坏着也无所谓。另外 `lab/_run-all.mjs` 也一起修好了，跑全量直接 `node lab/_run-all.mjs`。

> 2026-10-31 补 25（**图标只认「拿在手上的物品」：删掉拿方块外观冒充的几轮**）：用户原话「安山传送带漏斗的图标是错的，我这边需要显示的只有物品的图标，不要放置出去的样子。这里显示的图标应该和jei里显示的差不多，物品类的只需要显示手拿的图标，流体类的先不动。我感觉是你的图标采集流程出了问题」。
>
> **真因（三处，都是「拿方块的样子冒充物品图标」）**
> 1. **第 2.5 轮 blockstate → 模型 → 贴图**（补 24 新加的）：走的是「放置出来的方块」的模型，`create:andesite_belt_funnel` 因此拿到 `textures/block/funnel/andesite_funnel.png` —— 那是**普通安山漏斗**的本体贴图，不是传送带漏斗。
> 2. **第 2 轮的 `models/block/<名字>.json` 兜底**：物品没有 item 模型时直接拿方块模型，出来的就是方块外观。
> 3. **第 1 轮的表被 `textures/block` 占了先**：`byId` 一张表里，`assets/<ns>/textures/block/x.png` 在 jar 条目里排在 `textures/item/x.png` 前面，于是「两个位置都有同名贴图」的方块物品（tnt、熔炉、工作台…）拿到的是方块那张。
>
> **改法（`lib/core/item-icon.js`）**
> - **删掉第 2.5 轮那 76 行**（`BLOCKSTATE_RE`、`blockStatesById`、`firstModelOfBlockState` 一并删掉）。
> - **第 2 轮只认 `models/item/<名字>.json`**，不再回落到 `models/block/`。
> - **新增 `itemTexById` / `itemTexByPrefix` 两张只收 `textures/item` 的表**，第 1 轮先用它们，再退回 `byId` / `byPrefix`。
> - **3D 模型的贴图排序**（`sortTextureRefs`）：先按「贴图路径与物品名共享几个词根」，再按「面片加权面积」（竖面 1.5 倍权重，上下 1 倍）。原来的做法是「模型里第一个存在的贴图」，于是 `create:andesite_funnel` 会拿到 `andesite_block`（搭在漏斗上的那块石头）、`minecraft:tnt` 会拿到 `tnt_bottom`（一张引信图）。
> - **贴图键名优先**：模型里按 `layer0 → all → side → front → base → north → top → end → cross → particle → texture` 的顺序先挑一遍，再全收兜底。`block/cube_bottom_top` 这类模型（tnt / 熔炉 / 工作台）的 `bottom` 原来排第一。
>
> **实测（Mechanomania）**：`create:andesite_funnel` → `funnel/andesite_funnel.png`、`create:brass_funnel` → `funnel/brass_funnel.png`、`minecraft:tnt` → `tnt_side.png`、`minecraft:furnace` → `furnace_side.png`、`minecraft:crafting_table` → `crafting_table_front.png`。代价是**缺图标 702（6.8%）→ 947（9.1%）**：那 245 个在 jar 里只有「放置出来」的模型，现在如实画字母方块，要图就点面板里「没有图标？去 MC百科找」（补 23）。`create:andesite_belt_funnel` / `create:brass_belt_funnel` / `create:rope` 就属于这一类（JEI 是实时渲染 3D，我们是静态图，做不到就别硬凑）。
>
> **测试**：`test/item-icon.test.mjs` 21 → **20**（三条 blockstate 用例合并成「只有 blockstate 上的方块外观也不出图」；新增「item 贴图优先于同名 block 贴图」；`makePack` 里给 `kdoll:doll_vanilla` 补了 `models/item`，跨 jar 那条用例才能继续测）。全量 **36 套件 / 546 通过 / 0 挂**。
>
> **必须重启 DSH**（core 层改动 + 索引缓存），然后 Ctrl+F5。

> 2026-10-31 补 24（**传送带/绳索：分清「拿在手上的物品」和「放置出来的方块」**）：用户原话「传送带和绳索是有独立的能拿到手上的物品的，我之前给你的截图就是传送带的物品，你不要把放置出来的物品和手中的物品搞混了」。
>
> **我上一轮错在哪**：把 `create:belt`（放置出来的方块，只有一条平铺条纹贴图）当成了「传送带」本身，于是用 `isMultipartOnlyBlock` 把它拦掉、还当成正面设计写进了补 22。实际上：
> - 能拿在手上的是 **`create:belt_connector`**，jar 里明明有 `assets/create/textures/item/belt_connector.png`（218 B），第 1 轮就命中了，图标一直是对的。
> - 用户在搜索框里搜「传送带」搜到的是 **`create:belt`**（`block.create.belt` 这个语言键带进物品表的幻影 ID，跟真物品同名）。挑到它 → 没图标 → 「传送带图标用错」。
> - `create:rope`（绳索）同理：jar 里既没有 `models/item/rope.json` 也没有 `textures/block/rope.png`，只有 `blockstates/rope.json` → `models/block/rope_pulley/rope.json` → `textures/block/pulley_rope.png`。
>
> **改动一：幻影方块去重（`lib/core/index.js`）** —— 判据两条都满足才删：① 这个 ID 没有任何「item 形态」证据（既无 `models/item/<名字>.json`，也无 `textures/item/<名字>.png`）；② **同一命名空间内**有同名、且有 item 形态的 ID。只满足「有 blockstate」不删（`minecraft:lava` 这种方块本身还得当图标来源）。`indexJar` 新增 `itemModels` / `itemTextures` / `blockStates` 三张表，`indexInstance` 汇总成 `itemForm` / `blockStates` 后统一去重，返回值新增 `droppedAliases:[{id, aliasOf, name}]` 与 `droppedAlias` 计数。**必须有命名空间这一条**：跨 mod 撞名太多（`irons_spellbooks:voidstone` 和 `cataclysm:void_stone` 都叫「虚空石」），按名字删会误删真物品。
> - 实测 Mechanomania：物品 10405 → **10386**（删掉 19 个幻影：`create:belt`、`create:water_wheel_structure`、`escalated:*_walkway*`、`kaleidoscope_*:tomato_crop` 等，全是「方块与物品同名」那一类）。
>
> **改动二：第 2.5 轮 blockstate → 模型 → 贴图（`lib/core/item-icon.js`）** —— 贴在 `BLOCK_MODEL_RE` 下面新增 `BLOCKSTATE_RE = /^assets\/([^/]+)\/blockstates\/(.+)\.json$/`，`buildTextureIndex` 里登记 `blockStatesById`（`{jar, entry}`），并新增 `firstModelOfBlockState(json)`（递归取第一个 `model`，支持 `variants` 对象/数组与 `multipart[].apply.model`）。对仍缺图的物品：blockstate → 模型 → `textureRefsFromModel` → 逐个试 `zip.has`。
> - **零件贴图怎么挑**：一个方块模型常同时挂着「一块石头 + 漏斗本体」，取第一张就会拿 `andesite_block` 当漏斗图标。改成按「贴图名与物品名共享几个词根」打分：命中词多者优先，一样多时「多出来的词更少」者优先；**一个词根都不共享就不出图**（宁可画字母方块，也不拿石头冒充）。修复后 `create:andesite_belt_funnel` → `textures/block/funnel/andesite_funnel.png`，`create:rope` → `textures/block/pulley_rope.png`。
> - **告示牌别名规则一并放宽**（`signAliasOf`）：不再写死几种正则，改成「去掉名字里的 `_wall_`」——`oak_wall_sign` → `oak_sign`、`white_wall_canvas_sign` → `white_canvas_sign`、`wall_hanging_canvas_sign` → `hanging_canvas_sign`（FarmersDelight 没有颜色前缀的那种，旧正则漏了）。
>
> **实测效果（Mechanomania）**：缺图标 866（8.3%）→ **702（6.8%）**，有图 9684 / 10386；索引 559ms、全量取图 3.6s（分批 120 个，`resolveIcons` 内部 `ICON_LIMIT=128` 会静默截断，探针必须分批）。
> - **剩下 702 个里大部分是刷怪蛋**：`cataclysm:*_spawn_egg` 在游戏里是三维实体渲染，jar 里永远没有 2D 贴图，只能靠 MC百科（补 23 那条）一张一张拿。
>
> **测试**：`test/index.test.mjs` 20 → **23**（同名幻影要删 / 熔岩这种没同名真物品的必须留 / 跨命名空间撞名一个都不能删）；`test/item-icon.test.mjs` 17 → **21**（blockstate 兜底出图 / 零件贴图按词根挑 / 一个词根都不共享就不出图 / 画布告示牌借用）；`item-icon.test.mjs` 里 `makePack` 新增第 4 个 jar `ropey-1.0.jar` 专门放这几种形状，索引 jar 数断言 3 → 4。全量 **36 套件 / 547 通过 / 0 挂**。
>
> **这一轮全是 core 层改动（无新路由）→ 面板刷新即可；但索引结果有缓存，换包/重启 DSH 后才会重新扫。**

> 2026-10-31 补 23（**MC百科 兜底 + 竖排动图裁帧 + 告示牌借用**）：用户原话「1.mc百科里都有，难道是CurseForge里没有显示图标吗。把mc百科也纳入图标搜寻的网址 2.熔岩的图标还是没有，告示牌的也没有，去检查一下」。
>
> **先回答「CurseForge 里为什么没图标」**：CurseForge / Modrinth 的 mod 页面只有 mod 自己的 logo，**没有逐物品图标**这种接口；mcmod 有物品页，但它是网页、有反爬，只能一张一张查。所以策略是「本地优先 + MC百科按需兜底」。
>
> **① 竖排动图裁第一帧（我做的，新增 `lib/core/png-frame.js`）** —— 用户说「熔岩的图标还是没有」的真正原因不是缺贴图：`textures/block/lava_still.png` 是 **16×320 的整条动画**（20 帧竖排），`water_still.png` 是 16×512（32 帧，而且 **4 位调色板**）。原来整条塞进 22px 方框，看起来就是一条橙色细线 = 等于没有。
> - `pngInfo(buf)` / `animatedFrames(buf)`（`height > width`、`height % width === 0`、2 ≤ 帧数 ≤ 64 才算动图）/ `pngFirstFrame(buf)`：自解 PNG（IHDR/PLTE/tRNS/IDAT + inflate + 反滤波 0–4），只留前 `width` 行，重新 deflate 并自算 CRC32。
> - **位深是坑**：`layoutOf(info)` 必须按 `通道数 × 位深 / 8` 算 `bpp`、按 `ceil(width × 通道数 × 位深 / 8)` 算行宽；只按 8 位处理会整片解不出来（`water_still.png` 就是 4 位调色板）。
> - `lib/core/item-icon.js`：`iconFromPng(png, source)` 统一出 data URL（动图自动裁首帧，结果里带 `frames` 字段）。实测 `minecraft:lava` 1302 B / `water` 334 B，都是 16×16。
>
> **② 墙上告示牌借用同名告示牌的图标（我做的）**：`minecraft:oak_wall_sign` 这类在 jar 里压根没有独立贴图（游戏里就是告示牌挂在墙上）。新增第 5 轮兜底 `signAliasOf(id)`：`<ns>:<x>_wall_hanging_sign` → `<x>_hanging_sign`、`<ns>:<x>_wall_sign` → `<x>_sign`，只在仍然缺图时走一次；命中的 `source` 会写「（墙上的告示牌借用 … 的图标）」，别让人以为找到的是它自己的图。
>
> **③ MC百科 按需找图（队友 `icon-web` 做引擎，我接线）**
> - `lib/core/icon-web.js`（新增，≈600 行）：`searchMcmod(keyword)` → `parseSearchHtml` → `pickBestMatch`（**保守**：名字完全一样且唯一才认；只有「包含」关系时要求 mod 名也对得上）→ `parseItemPage` → 下 128×128 的 PNG → 落缓存 `<mcRoot>\.dsh-icon-cache\mcmod`（`index.json` + `<sha1前12位>.png`）。失败**一律不抛**，回 `{ ok:false, reason }` 一句人话。
> - **反爬是真的**：mcmod 按来源 IP 的**总频率**限流，表现为 HTTP 200 + 正文「搜索太频繁」。实测 2.5 秒一次连打四轮正常；350ms 连打十几次就进冷却。所以模块里搜索走单独的 `SEARCH_GAP_MS = 2500` 节流线，详情页/图标 CDN 用 `MIN_INTERVAL_MS = 600`；撞限流后进 **60 秒冷却期**，期间直接回原因、不再发请求。
> - **命中率别抱期待**：对「缺图且有中文名的 299 个」抽样 24 条，搜索有结果 10 条、保守匹配命中 **6 条（25%）**。最值的是**刷怪蛋**（`*_spawn_egg`，游戏里是三维实体、jar 里永远没有 2D 贴图，mcmod 每条都有 128×128 成品图，抽样里 4 个全中）。Create 系通用名方块（「流体管道箱」）基本没戏。
> - 宿主新路由 `GET/POST /item-icon/web`（`lib/host/icon-api.js` 的 `handleWebItemIcon`），参数 `dir`、`id`、`item`、`name`（中文名，搜索关键词）、`mod`、`force`。**返回 `ok:true, found:false, reason`** —— 「没找到」是正常业务结果，不能回 `ok:false`，否则面板的 `apiPost` 会把它当成请求失败、把原因吞成「请求失败（HTTP 200）」（真踩过，界面测试抓到的）。
> - 面板：换图标卡片里多一个 **「没有图标？去 MC百科找」** 按钮，成功显示「拿到了：<标题>」，失败显示「没找到：<原因>」。只做**一张一张点**，不做批量补齐（一次几十张会被限流，25% 命中率也不值得）。
>
> **测试**：新增 `test/png-frame.test.mjs` 3 条（竖排动图裁成方形 / 静态方形不动 / 帧数离谱不当动图）、`test/icon-web.test.mjs` 24 条（解析/匹配/缓存/限流/失败不抛，全用静态 fixture + 假 fetch，不联网）；`test/client-quest-ui.test.mjs` 11 → **13**（MC百科 拿到图后立刻画出来、没找到要把原因说清楚）；`test/host-api.test.mjs` 28 → **29**（`/item-icon/web` 没给 ID 报 `IconNoItem`），路由数 40 → 41。全量 **36 套件 / 540 通过 / 0 挂**。
>
> **这一轮有宿主侧改动（新路由 + `icon-api.js`）→ 必须重启 DSH**；界面改动照旧 Ctrl+F5。
>
> **新增探针**：`_probe-mcmod-icon.mjs`（真连 mcmod 量命中率与耗时）、`_probe-mcmod-pace.mjs`（不同间隔下的限流表现）、`_probe-web-icon.mjs`（走宿主处理器端到端验一张图 + 缓存命中）、`_probe-iconfit.mjs`（改前改后缺图清单对比）。

> 2026-10-31 补 22（**图标三问：悬停简介 / 传送带图标用错 / 液体没图标**）：用户原话「1.需要补充一点，把鼠标挪到图标条目上一定时间后，要显示物品简介，如果没有物品简介就不显示 2.传送带的图标应该用错了 3.液体的图标没有显示出来，不论是原版还是mod」。
>
> **① 悬停简介（我做的，纯界面 + 索引层）**
> - `lib/core/index.js` 新增 `langDescriptions`：只认 `*.tooltip.summary` / `*.tooltip` / `*.desc` / `*.desc<N>` / `*.tip` / `*.guide`，跳过含 `%` 的模板；`tooltip.condition<N>` 与 `tooltip.behaviour<N>` 按序号合成「条件：结果」；`cleanDesc` 去掉 Create 的 `_斜体_` 记号；`joinDesc` 最多 6 行 / 400 字。
> - 简介和名字一样**必须落在物品表里**才留（语言文件里 `item.ns.x.desc` 有一堆对应的是自定义书页/成就文字）；中文优先、没中文退英文。
> - **`lang/default/*.json`、`lang/builtin/*.json` 也要读**：Create 系 mod 把 tooltip 拆到这些文件里（Mechanomania 里 17 个文件 / 311 条 `item.`+`block.` 键，`assets/create/lang/default/tooltips.json` 是最大的一份）。这些文件**只当英文简介来源**，绝不拿来造物品或起名字。实测这个包 305 条键全都有中文对照（所以覆盖数没变），但没有中文翻译的包能靠它补上。
> - `/items` 只有真有简介时才带 `desc` 字段（`idx.describe?.(id)`），界面靠「有没有这个字段」决定弹不弹 —— **没简介就不弹空气泡**。
> - 面板：`startItemHover(event,it)` 600ms 后才弹（划过列表不该一路闪），坐标按窗口宽度夹住；`.mcstudio-tip` 是 `position:fixed` + `pointer-events:none`；`onMouseLeave`/换包都会清计时器。
> - **实测覆盖**：Mechanomania 10405 个物品里 **299 个有简介（2.9%，中文 249 + 英文 50）**。剩下 97% 是真的没有 —— Create 6 把大部分物品说明搬进了 Ponder 场景，语言文件里就是空的；我们**不编简介**，宁可不弹。
>
> **② 传送带图标（队友 `icon-core`）**：`create:belt` 在游戏里不是能拿在手上的物品，blockstate 指向 `create:block/belt/particle`，模型是 `models/block/belt/{middle,start,end,…}.json` 一组，共用同一条 `textures/block/belt.png` 平铺贴图配 UV 子区域 —— 原来拿它当图标，界面上就是一条糊掉的条纹。新增判定 `isMultipartOnlyBlock()`：**只有 `textures/block/<name>.png`、没有 item 贴图、没有 `models/item/<name>.json`、且存在 `models/block/<name>/` 目录形式零件模型** → 认定没有可用物品图标（返回 undefined，界面画字母方块）。影响面审计（`lab/_probe-beltskip.mjs`）：全包 263 个目录形式模型里只有 **3 个**被拦（`create:belt`、`create:copycat_base`、`kaleidoscope_doll:doll`），`minecraft:tnt`、`create:cogwheel`、`create:belt_connector` 都有对照断言不受影响。
>
> **③ 液体 / 原版图标（队友 `icon-core`，`lib/core/item-icon.js`）**
> - `TEXTURE_RE` 加 `textures/fluid/`；新增 `stillById` 表（`<base>_still` 优先 `<base>_flow`），`resolveIcons` 在「原版 objects」之前多了一整轮液体兜底 → `minecraft:water` / `lava`、`create:honey` / `chocolate` 都有图了。
> - `buildTextureIndex(modsDir,{extraJars})` 把**客户端 jar** 也索引（`resolveIcons` 自动用 `instance.clientJar`；缓存键算进 extraJars）→ 原版那 561 个缺的直接消掉。
> - 模型链兜底到 `models/block/<name>.json`（新 `blockModelsById`）；`textureRefsFromModel` 改成返回**候选数组**（layer0 → all → particle → texture → 其余），逐个试，全落空再跨 jar 查。
> - **实测（Mechanomania，10405 物品）缺图标 2869（27.6%）→ 866（8.3%）**；贴图条目 10113 → 11805、item 模型 7896 → 9650、block 模型 0 → 20578、液体表 70 条；索引耗时 2184ms → 3279ms。
> - 顺带纠正一个旧数字：以前报的「1828 个缺」是探针分批（200/批）撞上 `resolveIcons` 的 `ICON_LIMIT=128` 夹取、每批静默少算 72 个造成的。
> - **诚实说清剩下的 866 个**：687 个 jar 里根本没有 item 模型也没有同名 item 贴图（只能靠游戏自己导出的图标那条路）；141 个是 `parent: minecraft:builtin/entity`（实体渲染，没有贴图）；38 个父模型跨命名空间、链断在 jar 边界（能救回约 25–30 个，收益小、要改跨 jar 模型解析，没做）；`minecraft` 还剩 88 个，一半是幽灵 ID（`minecraft:air`、`minecraft:template_bed` 这类），一半是真没有同名贴图（`minecraft:milk` 的贴图叫 `milk_bucket`）。
>
> **测试**：`test/index.test.mjs` 18 → **20**（简介白名单 / 斜体清理 / condition+behaviour 合成 / 幽灵 ID 不留简介 / `%` 跳过 / 中文没有退英文）；`test/item-icon.test.mjs` **17 条**（液体两种、extraJars、block 模型兜底、候选落空继续试、跨 jar、传送带不出图 + `tnt` 对照不放宽）；`test/client-quest-ui.test.mjs` 10 → **11**（悬停 600ms 才弹、移开收起、没简介不弹）。全量 **34 套件 / 510 通过 / 0 挂**。
>
> **这一轮既有宿主侧也有界面侧改动** → **必须重启 DSH**（`lib/core/index.js`、`lib/core/item-icon.js`、`lib/host/api.js` 都动了），重启后强刷页面。
>
> **新增探针**（都在 `lab/`，没动用户整合包）：`_probe-icons{,2,3,4}.mjs`（缺图标分布、belt 贴图、原版模型链、液体贴图名）、`_probe-desc*.mjs`（简介后缀分布与覆盖）、`_probe-langdefault.mjs` / `_probe-defonly.mjs`（拆开的语言文件）、`_probe-iconfit.mjs`（前后对比全量清单）、`_probe-beltskip.mjs`（传送带判定影响面）、`_png-ascii.mjs`（本机没有视觉模型，自己解 PNG 打字符画看贴图）。

> 2026-10-31 补 21（**有些物品的中文是错的 —— 根因：语言文件里的 tooltip / 变体键把正式名盖掉了**）：用户原话「现在有些物品的中文是错的，你先改一下」。
>
> **探针 `lab/_probe-names.mjs`**（扫 Mechanomania 的 183 个 jar / 94 份 `zh_cn.json` / 6546 条 `item.`+`block.` 键）：
> - **296 个物品存在「正式名 + 变体键」冲突，其中 277 个最终名字是垃圾**。
> - 实例：`block.create.flywheel`（飞轮）被 `block.create.flywheel.tooltip.summary`（"使用壮观的黄铜轮子_装饰_…"）盖掉；`create:schematicannon` 显示成一整段「使用_火药_作为燃料…」；`create:clipboard` 显示成「_保留您的笔记_ 并使您看起来更加专业。」
> - 原版也中招：`minecraft:banner` → "黄色顶波纹"、`minecraft:potion` → "蓄风药水"、`minecraft:firework_rocket` → **"%s"**。
>
> **真因（三处，都在 `lib/core/index.js`）**
> 1. `langNames` / `langIds` 都按「段数 > 3 只取第三段」解析，于是 `item.ns.x` 与 `item.ns.x.tooltip.summary` 落到**同一个物品 ID** 上，后出现的把正式名覆盖掉（JSON 顺序靠后就是 tooltip）。
> 2. 带 `%` 的格式化模板（`%s`、`飞行时间：%s`）被当成名字收进来。
> 3. 长键还**造幽灵物品**：`minecraft:banner`、`mynethersdelight:blazier` 这种游戏里不存在的 ID 进入物品表，在选择列表里表现为「一行没有图标的空白项」。
>
> **改法**
> - **只认正名形状**：`item.ns.name` / `block.ns.name`（正好 3 段）才既算物品、又给名字；长键一律不当名字（连兜底都不当）——**宁可显示 ID，也不显示错的中文**。
> - 值里含 `%` 的跳过。
> - 新增模块级 `NAME_DEPTHS = new WeakMap()` + `depthOf(map)`：每张名字表记「这个 ID 的名字来自几段键」。跨语言（zh/en）和跨 jar 合并时**浅者优先**，同深度保留先到的。这样即使将来放宽规则，tooltip 也顶不掉正式名。
> - 原版 `assets/objects` 那一层同样受约束：不再用长键盖掉已有正经名（`ns !== 'minecraft'` 只补空缺的老规矩保留）。
>
> **前后对比（Mechanomania 实测）**：物品 **10450 → 10405**（45 个幽灵 ID 消失）、`_names` **8201 → 8152**、名字可疑（带 `_`/`%`/超长）**277 → 54**（剩下 54 条全是正常的长英文名，如 `Orange Wall Hanging Canvas Sign`）。抽查：`create:flywheel` 飞轮、`create:schematicannon` 蓝图加农炮、`create:clipboard` 剪贴板、`minecraft:potion` 药水、`minecraft:firework_rocket` 烟花火箭；搜「齿轮」56 条（`create:cogwheel` 齿轮 / `create:gearbox` 十字齿轮箱 / `create:large_cogwheel` 大齿轮）。
>
> **测试**：`test/index.test.mjs` 16 → **18** 条，三条老的按新规矩改写（变体键既不造物品也不给名字、tooltip 子键不给名字），新增「变体键不能盖掉正名」「带 `%s` 的值不当名字」。全量 **34 套件 / 510 条全过 0 挂**。
>
> **这是宿主侧改动（`lib/core/index.js`）→ 必须重启 DSH**，重启后索引会重算，面板的候选与 `mc_item_search` 一起变对。

> 2026-10-31 补 20（**下拉列表「看不见」+ 中文输入按回车没反应 —— 两处都是界面侧，后端一直是对的**）：用户原话「1.中文输入没法点击输入结果 2.没有找到下拉图标的列表」。
>
> **先排除后端**（`lab/_probe-cn-search.mjs`，绕开界面直接走 `resolveInstance` + `indexInstance` + `searchItems`）：
> - `lab\_forge1201`（实例 `Forge1201`）：1844 物品 / 1174 配方 105ms，`_names` 1424 条、中文名 1400 条；「钻石」14 命中、「安山岩」7、「铁锭」1、「木板」10、「diamond」75。
> - 用户整合包 `lab\重度机械症 - 实验\versions\Mechanomania`：**10450 物品 / 11503 配方 713ms**，`_names` 8201 条、中文名 6896 条；「钻石」35、「**齿轮 58**（`create:cogwheel` 齿轮 / `create:gearbox` 十字齿轮箱 / `create:large_cogwheel` 大齿轮…）」、「安山岩」29、「铁锭」3、「cogwheel」47。
> - 结论：**中文搜索在索引层完全成立**，用户看到的「搜不到」是界面上根本没内容可点。
>
> **真因两条**
> 1. **列表只在「打了字、且服务器回来的 `q` 与输入框现值完全相等」时才渲染**：卡片刚打开时 `iconPick` 是 `null`，用户看到的是一张只有空输入框的卡 —— 他说的「没有找到下拉图标的列表」就是这个。改法：**一打开就先列一屏**，不等用户打字。
> 2. **中文输入法的回车被我们吞了**：`onKeyDown` 里 `e.key === 'Enter'` 就 `preventDefault` + 选第一条，可输入法拼字时回车是「确认候选词」——用户打 `zuanshi` 回车想上「钻石」，字没上屏就被当成「选第一条」，感觉就是「中文输入没法点击输入结果」。
>
> **改法（都在 `lib/client.js`）**
> - `searchIconItems(keyword)` 重写成 `loadIconCandidates(keyword, namespace)`：`q`/`ns` 都 trim；目录兜底 `dir || summary?.instance?.instanceDir`；`(!q && !ns)` 或没目录就清空；防抖 260ms 后 `apiGet('/items',{dir,id:instanceId,q,ns,limit:40})`，回来 `ensureIcons(...)`。
> - **打开即预载**：`pickNodeAction('icon')` 里读当前图标（如 `create:cogwheel`）→ `loadIconCandidates('', 'create')`；没图标就列 `minecraft`。用户一打开卡片就有一屏带图标的候选。
> - **`iconLoadRef`**：`pickNodeAction` 是 `useCallback`、依赖数组里没有 `dir`/`summary`，直接调 `loadIconCandidates` 会抓到旧闭包 —— 用 `const iconLoadRef = useRef(null); iconLoadRef.current = loadIconCandidates;` 每次渲染刷新，回调里走 `iconLoadRef.current(...)`。
> - 搜索框：`onChange` → 有字全包搜、清空退回列本 mod；新增 `onCompositionEnd` 在输入法选完字后再搜一次；`onKeyDown` 回车前 **`if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return;`**。
> - 卡片多了两个快捷钮「列 `<ns>` 的物品」「列原版物品」、一行状态「搜「X」命中 N 个 / 列 create 的物品，共 N 个」，空列表分「没搜到（试试打 ID 的一部分）」与「先连一个整合包再搜」两种文案，未预载时显示「正在列这个 mod 的物品…」；候选项 `role:'button'` + `title:'点一下就用 <id>'`。
>
> **测试**：`test/client-quest-ui.test.mjs` 那条中文搜索用例插了 1b 段 —— 打开卡片等 320ms 后，必须已经出现 `params.ns === 'demo'` 的 `/items` 调用、`/item-icons` 批量取图标、`.mcstudio-pick` 列表已存在且含「齿轮」。**10 条全过**，全量 **34 套件 / 496 条全过 0 挂**。
>
> **只改 `lib/client.js` + 测试 → 刷新页面即可**；但**必须 Ctrl+F5 强刷**（旧 `client.js` 会被浏览器缓存，普通刷新可能还是老代码）。

> 2026-10-31 补 19（**换图标能搜物品了 —— 要可视化下拉 + 中文搜索**）：用户原话「换图标物品的时候新增一个下拉列表，可视化选择物品，如果是用搜索的方式，就适配一下中文（中文搜索）」。
>
> **先说结论：后端一行没改**。`GET /items?q=…`（`lib/host/api.js:309` `handleItems`）→ `searchItems`（`lib/tools/item-search.js:47`）本来就把**显示名**也拿来比：`rankOf` 先比 ID，再比 `name.toLowerCase()`（相等 4 / 前缀 5 / 包含 6），同分按 ID 长度、再字典序。显示名来自索引期收好的 `_names` 表：mod 用自己 jar 里的 `assets/<ns>/lang/zh_cn.json`，原版用 `<mcRoot>/assets/objects/<hash>`（客户端 jar 里只有 en_us）。**所以直接打「钻石」「齿轮」就能搜到，前提只是面板得把中文原样发过去。**
>
> **面板改了三块**（都在 `lib/client.js`）
> 1. 新状态 `iconPick`（`{q, items, total, busy, error}`）+ `iconPickTimer` ref。搜索结果**不塞进 `nodeDraft`** —— 一个是一次查询的结果，一个是用户手打的 ID，混在一起会出现「列表还是上一个词的、框里已经是新词的」。
> 2. `searchIconItems(keyword)`：空词/没连包 → 直接清空；否则先占位 `busy:true`，**防抖 260ms** 再 `apiGet('/items',{dir,id:instanceId,q,limit:40})`，成功后 `ensureIcons(items.map(it=>it.id))` 把 40 个图标批量取回来（复用 `⑫` 画布那条 `/item-icons` 链路）；`pickIconItem(id)` 只负责把 ID 填进草稿框 + 取那一个图标。
> 3. 「换图标物品」卡片重写：上面是**搜物品输入框**（placeholder 写着「可直接打中文（钻石 / 齿轮 / 安山岩）」），下面是下拉候选 —— 每行 `ItemIcon` 22px + 「中文名（mod:item）」，点一下就把 ID 填到下面那个框里；**回车直接选第一条**；候选为空/加载中/出错/没连包各有对应文案（「没搜到「齿轮」。换个说法试试（比如打「块」「锭」这种后缀）」）。样式复用依赖选择框那套 `.mcstudio-pick`，没加新 CSS。
>
> **测试**：`test/client-quest-ui.test.mjs` 9 → 10 条，新增「右键 → 换图标：可以打中文搜物品，点一下候选就填进 ID」—— 断言中文关键字**原样**发到 `/items` 的 `q`、`limit=40`、候选里中文名和 ID 都在、点完 ID 框变成 `demo:gear`。全量 **34 套件 / 496 条全过 0 挂**。
>
> **只改了 `lib/client.js` + 测试 → 刷新页面就生效**（不用重启 DSH）。

> 2026-10-30 补 18（**配色重做：文字太暗看不清 —— 根因是字段名写错，整片文字掉进兜底色**）：用户原话「文本显示太暗了，根本看不清，调整一下颜色」。
>
> **真因（不是审美问题，是变量名不存在）**：`lib/client.js` 的 CSS 里用了一堆主题**根本没有**的变量 —— `--dsw-alias-fill-l1` / `-fill-l2` / `-fill-l3`、`--dsw-alias-label-tertiary`、`--dsw-alias-fill-brand`、`--dsw-alias-bg-l2`。浏览器拿不到值就退回兜底：`#8a8a8a` 灰、`rgba(255,255,255,.04~.07)` 几乎透明的白。于是所有「说明文字 / 键名 / 次要标签」全糊成一片灰，浅色主题下更是白字配白底。
>
> **主题真正提供的只有 14 个**（`cordis_inspect_query` 的 client/Theme 查出来的）：`--dsw-alias-bg-base`、`-bg-layer-1`、`-bg-layer-2`、`-bg-overlay`、`-border-l1`、`-border-l2`、`-brand-primary`、`-label-primary`、`-label-secondary`、`-state-error-primary`、`-state-idle-primary`、`-state-success-primary`、`-state-warn-primary`、`--dsw-specific-sidebar-fill`。**没有 `fill-*`、没有 `label-tertiary`、没有 `bg-l2`**（是 `bg-layer-2`）。
>
> **改法**
> - 在 `.mcstudio-root` 上立一组自有变量，全部指向真 token：`--mcs-fg`（label-primary）、`--mcs-fg2`（label-secondary）、`--mcs-surface`（bg-layer-1）、`--mcs-surface2`（bg-layer-2）、`--mcs-line`（border-l1）、`--mcs-line2`（border-l2）、`--mcs-brand`（brand-primary）。后面所有规则只用这七个。
> - **面板自带底色** `background:var(--dsw-alias-bg-layer-1,#17191d)`：万一主题变量没解析出来，浅色字也还有深底可站，不会白字配白底。
> - 字号整体提一档：正文 13 → **13.5px**，按钮/输入 12 → **13px**，键名 12 → 12.5px，说明 12 → 12.5px，行高 17 → 18px；键名列宽 66 → 74px。
> - 灰色文字全部换成 `--mcs-fg2`（label-secondary），不再自己调灰；`--mcstudio-pick-c` 那个 `opacity:.55` 也去掉了（半透明 = 浅色主题下直接消失）。
> - 语义色改走 state token：错误 `state-error-primary`、警告 `state-warn-primary`、成功 `state-success-primary`。
> - **SVG 里的颜色必须写在 `style` 里，不能写在 fill 属性上**：presentation 属性不接受 `var()`，写了也不生效。节点底色 `--mcs-surface2`、选中描边 `--mcs-brand` 2px、拖脏描边 `state-warn-primary`、连线 `--mcs-line2`、箭头 `--mcs-fg2`、节点标题 `--mcs-fg` 11.5px、无图标时的字母 `--mcs-fg2`。
> - 右键菜单改用 `--dsw-alias-bg-overlay`，首行标题从「`.72` 透明度 + 11px」改成 12.5px 加粗的 `--mcs-fg2`。
>
> **新守卫测试**：`test/client-plugin.test.mjs` 加一条「样式只用主题里真有的变量」—— 逐个断言那六个幽灵变量名不再出现、正文色必须走 `label-primary`、root 必须自带底色、不许再出现 `color:#8a8a8a` 这类写死的灰。同时原来的两条「白底白字」断言改为匹配 `--mcs-brand`（它们原本匹配的是幽灵变量 `fill-brand`，等于一直在测一个不存在的东西）。
>
> **测试**：34 套件 / **495 通过 / 0 挂**。只改了 `lib/client.js` + 一处测试，宿主没动，**刷新页面即可**，不用重启 DSH。
>
> 2026-10-30 补 17（**蓝图提到最前 + 节点右键就能编辑 —— 用户原话：界面形式不合适、优先该看到蓝图、蓝图不能编辑**）：用户的原话是「你的界面形式不太合适，对使用者来说，优先应该看到的是蓝图编辑的功能，而且你做的蓝图模块无法编辑，不过已经能够看到3D图标了……现在需要加上右键编辑的功能，这样更符合用户直觉」。这一轮就是把「看」变成「改」。
>
> **1. 界面顺序：蓝图从最底下搬到第二块**
> - 原来十四个段落是长滚动列表，画布（原「⑫ 拖拽画布」）排最后，要滚半天才看得到 —— 这就是「形式不合适」的根因。
> - 现在渲染最后做一次重排：`[视图开关, ①连接, 蓝图, …其余]`，**「连接」永远第一段**（不连包什么都没意义），蓝图紧跟其后。Cordis 面板不是路由，段落顺序由这次重排说了算。
> - 视图开关两个值：**「只看蓝图」**（只留连接 + 蓝图，给日常用）/ **「显示全部功能」**（默认，给装包/配包用）。默认「显示全部功能」是有意的：新机器第一步要「从零装底座」，全藏起来会找不到入口。
> - 连上包之后**自动读任务书 + 自动读画布**（`bookAutoRef`/`canvasAutoRef`，换包重置），打开面板直接就有图，不用先点两次按钮。画布段的渲染守卫从 `summary && book` 放宽到 `summary`，任务书没读出来时按钮显示「先读任务书」。
> - 自动读是**安静失败**的（`loadBook(force, quiet)`）：没装 FTB Quests 的包不会一开面板就红一片，原因存进 `bookSkip`，蓝图那段写成「这个包里没读到任务书：<原因>（蓝图要用它…）」；用户自己点「先读任务书」时才把错误甩出来。
>
> **2. 右下键菜单：六件事**
> 在节点上点右键（`<g onContextMenu>`）弹 `position:fixed` 菜单（夹在窗口内，点别处/Esc 收起 —— 注意判 `e.target.closest('.mcstudio-menu')`，否则 click 之前菜单就被摘掉）：
> 改名字/副标题（转去老的文字链路、滚到 ⑨）、换图标物品、改前置依赖、在它后面加一个任务、（分隔线）删掉这个任务。
>
> **3. 右键之后出现的编辑卡**（`nodeEditorCards()`，就在画布下面，不用跳走）
> - **换图标**：输入 `mod:item`，右边 `ItemIcon` 立显 36px 图标（选之前就能看见对不对），预览 → 确认才写。
> - **改前置依赖**：全书任务可勾选（依赖允许跨章节），带过滤框（按 ID/标题/图标子串）+「N 个可选」，每行还有小图标和它所在章节名；写的时候面板把勾选结果转成 **JSON 字符串**发过去（`dependencies: '["AB12","CD34"]'`，测试钉死了这个形状）。
> - **删任务**：先告诉你会连带影响谁（「有 N 个任务本来要先做它」，最多列 6 个 + 「等 N 个」），确认才删。
> - **就地新建**：在节点后面加一个任务（`dependsOn` 自动接上被右键的那个，坐标自动摆到它下面 3 格）。
> - 所有卡都是 **预览（只算）→ 确认写入（真写）** 两态，写完显示改了什么 + 备份文件名。
>
> **4. 底层（这一轮新增的能力，工具和界面共用）**
> - **新增 `lib/core/quest-node.js`**：`planNodeEdit`（改 `icon` / `dependencies`）、`commitNodeEdit`、`planNodeDelete`（删任务 + 全书清掉指向它的依赖，可能跨章节文件）、`commitNodeDelete`、`describeNodeEditPlan`、`describeNodeDeletePlan`、`parseDependencies`。写盘纪律照 `quest-move.js`：`writeFiles` → 重读 → `newErrorsOf` 有错就 `restoreFiles` 回滚并抛错。
> - **`lib/core/quests.js` 新增 `removeQuest(source, questId, label)`**：从 `quests` 列表里精确摘掉一个 compound（按 `id` 匹配），原文件写法（缩进、引号）不动。
> - **宿主四条路由**（`lib/host/api.js:410-413`）：`/quest/node/preview`、`/quest/node/apply`、`/quest/node/delete/preview`、`/quest/node/delete/apply` —— 路由总数 36 → **40**。
> - **工具层**：`mc_quest_patch` 加了 `icon` / `dependencies` 两个参数；新增 **`mc_quest_remove`**（删任务，连带警告影响面）。工具总数 28 → **29**。
> - 界面和模型走的是同一套 `lib/core/*`：右键换图标 = `planNodeEdit` = `mc_quest_patch icon=…`。
>
> **测试基线**：33 套件 / 457 条 → **34 套件 / 494 条全过 0 挂**（新增 `test/quest-node.test.mjs` 20 条；`test/client-quest-ui.test.mjs` 4 → 9 条：蓝图位置、右键换图标、右键改依赖（钉 JSON 字符串）、右键删任务（警告谁受影响）、只看蓝图收起其余段）。
>
> **界面测试替身的一个坑（补记）**：假 `createElement` 把 `key` 塞进 `props`，`element.key` 是 `undefined` —— 所以**不要靠 `element.key` 认元素**；另外 `textOf` 必须递归进函数组件（`node.type({...props, children})`），否则 `Kv` 这类组件的 label 半截文字根本不在树里，断言会假失败。

---

## 1. 环境和怎么跑

### 目录

| 东西 | 路径 |
|---|---|
| 仓库（工作区） | `D:\Desktop\VibeCoding\dsh-minecraft-modpack-studio` |
| **实验副本（唯一可写的那份）** | `D:\Desktop\VibeCoding\dsh-minecraft-modpack-studio\lab\重度机械症 - 实验` —— 用户 2026-10-29 亲手搬进工作区的，10.5 GB / 13633 文件，和原包结构完全一致。**所有写操作只对它**，原包一个字不动 |
| 实验用的实例目录 | `...\lab\重度机械症 - 实验\versions\Mechanomania`（另一个 `Mechanomania-航空学` 也在这层） |
| 主测试实例（NeoForge 1.21.1） | `D:\pcl2\PCL 下载\整合包\重度机械症\versions\Mechanomania` |
| 第二实例（航空学，另一个包） | `D:\pcl2\PCL 下载\整合包\重度机械症\versions\Mechanomania-航空学` |
| ATM10 Sky（Forge 大包，交叉验证用） | `D:\pcl2\PCL 下载\整合包\atm10sky\versions\All the Mods 10：To the Sky   ATM10SKY` |
| Java（本机唯一一个） | `C:\Users\lyh\AppData\Roaming\.minecraft\runtime\java-runtime-delta\bin\java.exe`（OpenJDK 21.0.7+6-LTS Microsoft） |
| PCL 启动器 exe | `D:\pcl2\PCL 正式版 2.10.6\Plain Craft Launcher 2.exe` |

**注意**：本机 `PATH` 里**没有 java**，也没有独立 JDK。Java 探测必须去 `%APPDATA%\.minecraft\runtime\*` 下面找。

### 跑测试（重要）

```powershell
cd "D:\Desktop\VibeCoding\dsh-minecraft-modpack-studio"
node --import ./test/register.mjs test/export.test.mjs
```

**必须这样跑，不能用 `node --test`** —— 沙箱下 `node --test` 会 `Error: spawn EPERM`。
`test/register.mjs` 是自定义 hook，负责把 `@deepseek-ai/dsh-tools` 之类解析到 `test/stub-dsh-tools.mjs`。

全量跑一遍（41 个套件，共 **598** 个测试）：

```powershell
cd "D:\Desktop\VibeCoding\dsh-minecraft-modpack-studio"
# 不设这行，node 打的 UTF-8 中文会被 PowerShell 按 GBK 解码，下面匹配「通过」会静默不命中
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$total=0; $pass=0; $fail=0
foreach ($f in Get-ChildItem test\*.test.mjs) {
  $out = & node --import ./test/register.mjs $f.FullName 2>&1 | Out-String
  if ($f.Name -eq 'kubejs.test.mjs') {
    if ($out -match '(\d+) 通过 / (\d+) 失败') { $p=[int]$Matches[1]; $x=[int]$Matches[2] } else { $p=0; $x=1 }
  } else {
    $p = if ($out -match '(?m)^. pass (\d+)') { [int]$Matches[1] } else { 0 }
    $x = if ($out -match '(?m)^. fail (\d+)') { [int]$Matches[1] } else { 0 }
  }
  $total += ($p+$x); $pass += $p; $fail += $x
  "{0,-28} {1,3} 过 {2,3} 挂" -f $f.Name, $p, $x
}
""
"合计 $pass 过 / $fail 挂 / 共 $total"
```

> ⚠️ `kubejs.test.mjs` 用的是**自定义统计格式**（`N 通过 / N 失败`），不是 node:test 的 `pass`/`fail` 行，聚合时必须单独匹配，否则会统计成 0 过 0 挂。
> ⚠️ 判断分支用 `$f.Name -eq 'kubejs.test.mjs'`，**别用 `$f.BaseName -eq 'kubejs'`** —— `BaseName` 只去掉最后一个扩展名，得到的是 `kubejs.test`。

当前基线（2026-10-31 补 33 之后）：**41 个套件 / 598** 条 —— 在 595 的基础上给 `ui-app.test.mjs` 加了 3 条（Ctrl+点击加选 / 多选拖完选择还在 / 最左任务往左挪时其他任务的屏幕横坐标不变）。上一轮（补 32 之后）：**41 个套件 / 595** 条 —— 在 593 的基础上给 `ui-app.test.mjs` 加了 2 条（拖动时连线实时跟随 / 平移缩放落在内层 `<g>` 上、根 svg 不被 transform）。上一轮（补 31 之后）：**41 个套件 / 593** 条 —— 在 40/577 的基础上新增 `desktop-launch.test.mjs` 11 条（参数解析 2 / 地址 1 / 探活与健康 3 / 超时 1 / dry-run 1 / 已在跑则复用 1 / 图标像素 1 / ICO 结构 1 / VBS 内容 1）；上一轮（P2 第二版之后）是 **40 个套件 / 577** 条 —— 在 40/575 的基础上把 `ui-app.test.mjs` 从 2 条扩到 4 条（三栏工作台：选项目页 / 进工作台 / 点方块看详情 / 右键换图标预览+写入）；再上一轮（P2 第一版之后）是 **40 个套件 / 575** 条 —— 在 38/560 的基础上新增 ui.test.mjs 13 条（阶段推断 7 + 静态服务 6）与 ui-app.test.mjs 2 条（DOM 替身真跑 app.js）；再上一轮（P0/P1 之后）是 **38 个套件 / 560** 条 —— 在上一轮 37/553 的基础上新增 `server.test.mjs` 7 条，并把 `lib/core` 全量搬到 `packages/core`（引用改了 51 个文件、删掉重复副本，条数一条没变，这就是搬迁忠实的证据）；上一轮（补 26 之后）是：**37 个套件 / 553** 条 —— client-plugin 9、client-quest-ui 13、host-api 29、icon-web 24、png-frame 3、**model-render 6**、**item-icon 21**、**index 23**；再上一轮（补 25 之后）是：36 个套件 / **546** 条 —— client-plugin 9、client-quest-ui 13、host-api 29、icon-web 24、png-frame 3、**item-icon 20**、**index 23**；再上一轮（补 24 之后）是：36 个套件 / **547** 条；再上一轮（补 23 之后）是：36 个套件 / 540 条；再往前（补 22 之后）是：client-plugin 9、client-quest-ui 11、item-icon 17、client-scaffold-ui 6、downloader 14、export 15、host-api 28、icon-export 7、index 20、instance 10、item-search 14、java-runtime 10、kubejs 34、launch 9、lossless 10、mod-fetch 15、mod-inspect 13、mod-install 20、mod-source 19、natives 5、overlap 12、pack-create 10、pick-folder 17、plugin 9、proc 7、quest-api 27、quest-move 10、quest-node 20、quests 24、recipe-api 18、recipes 16、snbt 18、version-install 17、version-manifest 19 → **498 过 / 0 挂**（34 个套件）。

### 单个工具手工调试

`test/run-tool.mjs` 可以按名字跑单个工具，参数从 `test/args-*.json` 读：

```powershell
node --import ./test/register.mjs test/run-tool.mjs mc_instance_info test/args-info.json
```

---

## 2. 已经做完的（P0–P6 + P9 全部落地，界面层前三块已通）

### 29 个工具 + 40 条界面接口

> 本轮新增 3 个工具：`mc_mod_search`、`mc_mod_install`、`mc_pack_create`。

| 分类 | 工具名 | 干什么 |
|---|---|---|
| 环境 | `mc_instance_info` | 认实例：MC 版本、加载器、mods 数量、Java 路径、任务书目录 |
| 环境 | `mc_mod_list` | 列 mod：文件名、modId、显示名、版本、各自贡献多少物品 ID 和配方；同时报「没解析出来的」 |
| 环境 | `mc_item_search` | 搜物品 ID：**中英文都能搜**（搜「齿轮」或「cogwheel」都行），也可按命名空间 / 来源 mod 过滤，精确命中排最前；写配方前先查，别凭印象写 |
| 环境 | `mc_mod_inspect` | **拆开一个 mod 的 jar 看内部**：物品+中文名、配方（类型/产物/材料）、标签、掉落表、config 原文。改之前先看清原样 |
| 配方 | `mc_recipe_find` | 按产物 / 材料 / 模组 / 关键字查配方 |
| 配方 | `mc_recipe_path` | 从目标物品往回追几层，看怎么来的 |
| 配方 | `mc_recipe_uses` | 查某物品被哪些配方当材料（删 mod 前看影响面） |
| 配方 | `mc_recipe_impact` | **删一批配方会造成多少断路**（plan 阶段用） |
| 任务书 | `mc_quest_list` | 列章节/任务 |
| 任务书 | `mc_quest_show` | 看一个任务的详情 |
| 任务书 | `mc_quest_search` | 按关键词搜任务 |
| 任务书 | `mc_quest_lint` | 检查任务书（空标题、断链、缺本地化） |
| 任务书 | `mc_quest_patch` | 改一个任务（dry-run / apply） |
| 任务书 | `mc_quest_add` | 加任务（dry-run / apply） |
| 任务书 | `mc_quest_chapter` | 加/改章节 |
| 任务书 | `mc_quest_move` | 挪：把任务节点挪到画布上的新坐标（可一次挪一批，吸附半格） |
| 联网 | `mc_mod_search` | 在 Modrinth / CurseForge 搜 mod，报候选（名字/下载量/支持版本） |
| 联网 | `mc_mod_install` | 按工程名装 mod：自动展开必装前置、算清单（plan）→ 确认后下载 + sha1 校验落 `mods/` |
| 建包 | `mc_pack_create` | 从零建包（**拼装**）：抄本机一个能启动的实例当底座，生成版本 json / 目录 / 空任务书 |
| 建包 | `mc_pack_scaffold` | 从零建包（**真下载**）：选版本 + 加载器，本体/资源/加载器依赖全从网上下，再跑官方安装器打补丁 |
| KubeJS | `mc_kubejs_verify` | **在 node:vm 沙箱里真跑脚本**，报缺物品/缺配方 |
| KubeJS | `mc_kubejs_plan` | 生成脚本代码给你看，不写盘 |
| KubeJS | `mc_kubejs_apply` | 写盘 + 写完自动复验 + 失败回滚 |
| 规划 | `mc_overlap_report` | 同名物品 / 功能重叠报告 |
| 规划 | `mc_progression_check` | 进度曲线（科技树深度分布） |
| 导出 | `mc_export_plan` | 算打包清单，不写盘 |
| 导出 | `mc_export_build` | 真打包 + PCL 兼容自检 |
| 启动 | `mc_launch_test` | 真启动游戏，判到主菜单 |

> **✅ 这个缺口已经补上**：`mc_item_search` 已实现（`lib/tools/item-search.js`），
> 把 `indexInstance()` 的 12,591 个 ID 直接暴露成工具，可按关键字 / 命名空间 / 来源 mod 搜，精确命中排最前。
> 另一个缺口 `mc_mod_inspect`（看 mod 内部配方/tag/掉落/config）也已补上，见 `lib/tools/mod-inspect.js`。

### 代码地图

```
packages/
├─ core/                       ★核心能力层（原 lib/core，2026-10-31 搬过来；零外部依赖，可被独立软件直接 import）
│  ├─ errors.js               McError（带 suggestion / code）
│  ├─ zip.js                  纯 Node 读 zip（零依赖，手写中央目录解析）
│  ├─ zipwrite.js             ★纯 Node 写 zip（流式 + ZIP64，手写 crc32）
│  ├─ write.js                原子写 + 自动备份（.bak-<时间戳>-<序号>）
│  ├─ instance.js             认实例：version json、mods、加载器
│  ├─ java.js                 Java 探测（含 runtime 目录）
│  ├─ index.js                物品 ID 索引（三源合并 + assets 原版中文名）
│  ├─ snbt.js                 SNBT 读写（span-preserving，改字不改格式）
│  ├─ quests.js               FTB Quests 读写 + lint
│  ├─ kubejs.js               KubeJS 沙箱（Proxy 造假事件总线）
│  ├─ kubejs-write.js         生成 KubeJS 脚本代码
│  ├─ recipes.js              配方图：parse / buildGraph / findBreaks
│  ├─ overlap.js              同名物品 / 功能族 / 进度曲线
│  ├─ mod-inspect.js          拆 jar：物品+中文名 / 配方 / 标签 / 掉落 / config
│  ├─ launch.js               启动拼装 + spawn + 日志轮询 + 主菜单判定
│  ├─ natives.js              ★解压 natives（lwjgl.dll 在里面，不解压启动必炸）
│  ├─ export.js               ★导出三形态 + PCL 自检 + PE 解析
│  ├─ mod-source.js           Modrinth / CurseForge 地址与响应解析（不联网）
│  ├─ mod-fetch.js            发请求、重试、镜像回退、下载到 .part 校验 sha1
│  ├─ downloader.js           ★下载引擎：分段并行 + 慢分段分裂 + 全局连接池（照 PCL 抄）
│  ├─ net-errors.js           联网错误分类与「说人话」文案
│  ├─ mod-install.js          依赖闭包 + 装前清单 + 多文件并行落盘
│  ├─ pack-create.js          从零建包（拼装）：校验包名、算计划、建目录与版本文件
│  ├─ version-manifest.js     ★Mojang 版本清单 / 加载器版本列表（NeoForge 走 JSON、Forge 走 XML）/ 镜像地址换算（不联网）
│  ├─ version-install.js      ★原版与加载器依赖清单、批量下载（含失败补一遍）、跑加载器安装器、找加载器版本目录
│  ├─ java-runtime.js         ★自动装 Java：按 javaVersion.component 下 Mojang 官方运行时（1.20.1→gamma 17，1.21.1→delta 21）
│  ├─ proc.js                 ★跑外部程序的唯一正确姿势（沙箱禁管道：fd 重定向收输出 + 超时 + 读日志尾）
│  ├─ scaffold.js             ★从零装底座全流程：下本体 → 下加载器 → 装 Java → 打补丁 → 建实例
│  ├─ quest-create.js         从零加任务 / 加章节：算计划、写盘、出错整批回滚
│  ├─ item-icon.js            ★物品图标：扫 jar 贴图 + 模型等轴测渲染 + 原版资源/jar（不联网）
│  ├─ model-render.js         ★把方块模型按等轴测投影画成 PNG 图标（只画朝相机的三面 + 画家算法）
│  ├─ png-frame.js            ★PNG 像素级读写：动图裁首帧、解码成 rgba、编码回 PNG
│  ├─ icon-export.js          ★高清图标：读游戏导出的 icon-exports 目录（不联网）
│  ├─ quest-move.js           挪任务坐标：吸附半格、批量改一个文件、写完体检回滚
│  └─ quest-node.js           ★蓝图右键编辑：改图标 / 改前置依赖 / 删任务（连带断开下游依赖）
├─ server/                     ★独立版本地 HTTP 服务（2026-10-31 新建）
│  └─ server.js               createStudioServer：Node 请求 → dispatchStudioRequest → JSON
lib/
├─ index.js                   插件入口：注册全部工具 + 挂界面接口（有 connection 才挂）
├─ client.js                  ★界面半边（DSH 侧边面板），手写 __ModuleLoader__ 格式
├─ host/
│  ├─ api.js                  ★宿主接口：41 条 HTTP 路由 + dispatchStudioRequest（插件和独立版共用）
│  ├─ cache.js                ★共享缓存（索引 + 配方图，键=实例目录小写，TTL 10 分钟）
│  ├─ recipe-api.js           ★改配方：搜配方 / 看详情 / 预览（不写）/ 写入（POST）
│  ├─ quest-api.js            ★改任务书：概览 / 列表 / 详情 / 预览（不写）/ 写入（POST）/ 画布 / 挪动
│  ├─ mod-api.js              ★联网装 mod：搜索 / 版本列表 / 清单预览 / 下载写入
│  ├─ pack-api.js             ★从零建包（拼装）：算计划 / 真建
│  ├─ scaffold-api.js         ★从零装底座（选版本向导）：算计划 / 真下载安装
│  ├─ export-api.js           ★打包：算清单 / 真打 zip
│  ├─ icon-api.js             ★物品图标：批量把物品 ID 换成 data URL
│  ├─ params.js               路由参数小工具（合并 query 与 body、asList、boolOr）
│  └─ pick-folder.js          ★弹系统「选文件夹」对话框（Electron → PowerShell 退路）
├─ tools/                     每个工具一个文件（29 个），注册在 registry.js
locale/                       中英文案
test/                         41 个测试套件 + 工具桩（598 个测试）
probe/                        FTB 任务书可视化编辑器（现成可用，但没接进来）
ref/                          参考实现和资料（别删，查证据用）
│  └─ dsh-ui-api/             ★DSH 官方界面插件源码，写面板照它抄
tools/                        一次性探针脚本 + asar-ls.js（asar 解包）
HANDBOFF.md                   完整技术文档（已扩到 §23：右键编辑 §14、配色 §15、物品搜索 §16、下拉与输入法 §17、中文名修正 §18、图标三问 §19、动图与告示牌 §20、手持 vs 放置 §21、只认物品形态 §22、等轴测渲染 §23）
```

### 几个技术亮点（接手时值得知道）

1. **zip 读写都是手写的，零依赖** —— 因为 `adm-zip` 不在仓库里，而且沙箱禁止 spawn 外部进程。
   `zipwrite.js` 用了「先写占位头 → 流式压缩 → 回填 crc/csize」的手法，支持 ZIP64。
   已用 .NET `System.IO.Compression.ZipFile` 独立验证过：1.23 GB 的包能正常读，jar 解出来 SHA256 一致。

2. **KubeJS 沙箱是真跑** —— 用 `node:vm` + `Proxy` 造了假的 `ServerEvents` / `StartupEvents` / `LootJS` / `ItemEvents` 事件总线，脚本能真的执行到 `event.recipes.create.pressing(...)` 这一层，从而提取它引用了哪些物品 ID。

3. **SNBT 是 span-preserving 的** —— 改一个字段只改那几个字节，其余格式（缩进、换行、字段顺序）原样保留。所以 diff 很干净，用户不会看到整个文件被重写。

4. **写入都有自动备份** —— `.bak-<时间戳>-<pid>`，apply 失败会自己还原。

---

## 3. 用户的需求和硬约束（**必须遵守，不要自己改**）

这些是用户在会话里逐字确认过的，写进代码前先看这一节。

### 3.1 产品形态

| 约束 | 用户原话 / 依据 |
|---|---|
| **两种做法，一套底层** | 用户在 m00416 指出：插件要「能图形化修改、能代码修改，能从零开始做整合包、能改已有的整合包」。点界面改和让模型改**必须调同一批 `lib/core/*` 函数**，不能各写一套 |
| **界面形态 = DSH 侧边面板** | 2026-10-29 三选一，用户选了「DSH 侧边面板」（不是独立网页、不是桌面窗口） |
| **讲解要简单，少术语** | m01690：「以后给我讲的时候都尽可能简单点，我对模组开发的结构还不是很会，继续做吧」 |
| **全程用中文** | m00652 原话「用中文回复我，说多少次了，写到记忆里」。已写进仓库根目录 `AGENTS.md` 第一条 |
| 写入必须「先看计划再确认」 | 所有写工具都是 `plan`（不写盘）→ `apply`（写盘）两态 |

### 3.2 技术范围

| 约束 | 说明 |
|---|---|
| **MC 版本不写死** | 1.20.1 Forge 和 1.21.1 NeoForge **都要支持**，不能硬编码版本号 |
| 数据源 | 本地 `mods/*.jar` 解包（真相来源）+ 联网元数据（P8，只做「找 mod / 认版本 / 查前置」） |
| 联网源 | **Modrinth + CurseForge**。CF key 用户同意提供但**至今没给**，缺失时必须静默降级到 `local-only` |
| 配方魔改 | 走 **KubeJS**，不直接改 jar |
| 任务书 | **FTB Quests** 必须支持；Better Questing 以后再说 |
| 导出 | 三形态 `standard` / `offline` / `launcher`，**验收标准就是 PCL2 能装能开** |
| 启动验收线 | **启动到主菜单就算过**（不要求进世界） |

### 3.3 用户的文件（**绝对不能动**）

- 用户的整合包目录、存档、配置，**默认只读**。
- 所有写测试必须在**副本**上做，不许碰真包。
- m03269 用户明确说「别改名字不行吗」→ **不要改用户存档名**。
- 不删用户文件。

### 3.4 插件契约

`package.json` 里的 peerDependencies **必须写宽范围**，写死会被安装器拒：

```json
"@deepseek-ai/dsh-tools": ">=0.1.5-rc.1 <0.3.0"
```

报错长这样：`installation rejected: ... is incompatible with dsh ...`

---

## 4. ✅ 已修复：PE 版本信息解析（2026-10-29）

> **这一节已结案。** 下面「旧记录」保留作踩坑档案，但**其中有一处结论是错的**，以本段为准。

**修好了什么**：`lib/core/export.js` 的 `readPeVersionInfo()` / `looksLikePcl()`。
`test/export.test.mjs` **15/15**（当时全量 150/150，现为 267/267）。真 PCL exe 现在返回
`{ comments: 'Minecraft 启动器' }` → `looksLikePcl` 判 `ok: true`。

**实际根因有两个，旧记录只发现了一个：**

1. **对齐基准错了**（旧记录发现的）：`align4()` 按绝对文件偏移对齐，但 PE 版本块的填充是
   相对**块起点**算的。已改成 `padTo(n, base)`。
2. **读错了块**（旧记录没发现的，这才是关键）：PCL 是 .NET **单文件打包**的 exe，里面内嵌了
   十几个程序集（MeloongCore / NAudio / Json.NET / CacheCow…），**每个程序集各带一份版本资源**。
   实测 2.10.6 的 exe 里有 **14 份 `VS_VERSION_INFO`**，第一份是 CacheCow 的。
   旧代码用 `indexOf` 撞第一份，所以哪怕对齐修对了，读出来也是 `MeloongCore`。
   → 已改成**走 PE 资源目录**取本体自己的 `RT_VERSION`（类型 16），函数是 `peVersionResource()`。

**旧记录里错的那条结论**：它断言真 exe 的 `productName === 'Plain Craft Launcher'`。
**实测不成立** —— 这个版本的 PCL **根本没有 ProductName**，版本资源里只有一个
`Comments = "Minecraft 启动器"`（`CompanyName` 是空串）。
所以 `looksLikePcl()` 的判定放宽成「版本信息任一字段含 启动器 / Launcher 就算」，
同时 **Admin Manager 优先判否**（它的标识里也含 "Plain Craft Launcher"）。

**兜底也重写了**：读不到版本资源时不再「无条件放行」，改成按
`Plain Craft Launcher` 与 `Plain Craft Launcher Admin Manager` 的**出现次数差**判 ——
因为真 PCL 里两种标记都有（实测 163 次 vs 1 次），见到管理员标记就判否会把正版误杀。

**参考依据**：PCL 自己的判定源码在 `ref/PCL2-ModModpack.vb:780-790`，只看 `ProductName`。

---

### 以下是修复前的旧记录（保留作档案，结论已被上面更正）

### 现象

```powershell
node --import ./test/register.mjs test/export.test.mjs
# 14 tests, 13 pass, 1 fail
```

失败的是 `test/export.test.mjs:199`：

```
✖ looksLikePcl: 普通文件判不过，带 UTF-16LE 字样的判过
  AssertionError: Expected values to be strictly equal: true !== false
```

而且对**真 PCL exe** 也是错的：

```
readPeVersionInfo("D:\pcl2\PCL 正式版 2.10.6\Plain Craft Launcher 2.exe") → null
looksLikePcl(...) → { ok: true, detail: "没读到 ProductName，按启发式放行（最终由 PCL 自己判）" }
```

`ok: true` 是**蒙对的**（宽松兜底放行），解析本身完全没工作。

### 为什么重要

`mc_export_build` 的 `launcher` 形态要往包里塞一个 `PCL.exe`，并且必须确认这个 exe 真的是 PCL（不是管理员版）。
现在等于**没校验**，用户随便给个 exe 都能通过。

### 根因（已定位，就差动手）

`lib/core/export.js:380`：

```js
const align4 = (n) => (n + 3) & ~3;
```

`lib/core/export.js:393` 的 `walkVersionBlock(buf, start, end, out)` 用它算子块起点：

```js
const valStart = align4(q + 2);          // 406 行
const childStart = align4(valStart + wValueLength);   // 413 行
```

**问题**：PE 的 `VS_VERSIONINFO` 结构里，填充是**相对块起始位置**对齐的，不是相对文件开头。
而 `align4()` 拿到的是**绝对文件偏移**。

实测证据：真 PCL exe 的根块起始于文件偏移 `2289273`，而 `2289273 % 4 === 1` —— 差 3 个字节。
于是所有子块全部错位，读出来的键名是乱码：

```
期望：StringFileInfo
实读：嘀愀爀䘀椀氠... （UTF-16 错位 3 字节的典型乱码）
```

而且 `wLength` 会在错误偏移读到 0，直接 `break` 掉整个遍历。
（第一次调试时还错位读到了 `CacheCow.Client`，那是 .NET 的 NuGet 包名，纯属巧合撞上。）

### 怎么修

**第一步：让对齐相对块起始**

把 `blockBase` 传下去，填充按块内偏移算：

```js
const padTo = (n, base) => base + (((n - base) + 3) & ~3);

function walkVersionBlock(buf, start, end, out) {
  // ... 读 wLength / wValueLength / wType / 键名（UTF-16LE，以 0x0000 结尾）
  const keyEnd = keyStart + (keyLen + 1) * 2;
  const valStart = padTo(keyEnd, start);              // ← 相对 start
  // 读值：wType === 0 时是 UTF-16LE 文本，wValueLength 是「字符数」
  //       wType === 1 时是二进制，wValueLength 是「字节数」
  const childStart = padTo(valStart + valueBytes, start);   // ← 相对 start
  if (childStart < start + wLength) walkVersionBlock(buf, childStart, start + wLength, out);
}
```

注意三个细节：

1. `wValueLength` 的语义随 `wType` 变：`wType === 0`（文本）时是**字符数**，要乘 2；`wType === 1`（二进制）时是字节数。
2. 块结束边界用 `start + wLength`，不是传进来的 `end`。
3. 键名是 UTF-16LE 且以 `\0\0` 结尾，`keyLen` 不含结尾的 0。

**第二步：兜底启发式要收紧**

`lib/core/export.js:446` 的 `looksLikePcl()`，当前 `productName` 为空时无条件 `ok: true`。
按测试的期望改成：

```js
if (!productName) {
  // 没有版本信息 → 退化成扫 UTF-16LE 标记
  const has = (s) => buf.indexOf(Buffer.from(s, 'utf16le')) >= 0;
  if (has('Plain Craft Launcher Admin Manager')) {
    return { ok: false, detail: '这是管理员版（Admin Manager），PCL 会排除它' };
  }
  if (has('Plain Craft Launcher')) {
    return { ok: true, detail: '按 UTF-16LE 标记判定为 PCL（未读到版本信息）' };
  }
  return { ok: false, detail: '既没有版本信息，也没有 PCL 的标记字符串' };
}
```

**顺序不能反** —— 管理员版的字符串里也包含 `Plain Craft Launcher`，必须先判 `Admin Manager`。
（真 PCL exe 里两段字符串都有，所以只有正确解析出 ProductName 才能区分，兜底只是保命。）

### 验收标准

1. `test/export.test.mjs` **14/14 全绿**
2. 真 exe 上跑：

```powershell
node --input-type=module -e "
import { looksLikePcl, readPeVersionInfo } from './lib/core/export.js';
const exe = 'D:\\\\pcl2\\\\PCL 正式版 2.10.6\\\\Plain Craft Launcher 2.exe';
console.log(readPeVersionInfo(exe));
console.log(looksLikePcl(exe));
"
```

期望 `readPeVersionInfo` 返回对象，`productName === 'Plain Craft Launcher'`，`looksLikePcl` 返回 `ok: true` 且 `detail === 'ok'`。

3. 顺手确认管理员版 exe（如果找得到）返回 `ok: false`。

---

## 5. 接下来还要做什么

按优先级排的。做完一项打一个勾。

### 5.0 【进行中】侧边面板界面层（用户 2026-10-29 拍板的形态）

用户看到 README 里「四条主线」，指出第一条「图形化修改」一行代码都没有，于是拍板做 **DSH 里的侧边面板**（不是独立网页、不是桌面窗口）。现在前三块垂直切片已完成：**① 连接整合包 → 看总览 → 搜物品（中英文都行）**；**② 点物品 → 看它的配方 → 改配方 → 预览 → 确认写入**；**③ 读任务书 → 按章节/关键词筛 → 改一条任务的标题/副标题/说明 → 预览 → 确认写入**。

**已经能用的部分**

| 层 | 文件 | 干什么 |
|---|---|---|
| 界面 | `lib/client.js`（约 2000 行） | 手写 `window.__ModuleLoader__.load` 格式，不需要打包工具。十二段式面板：① 连接整合包（扫描 + 手填 + **选择文件夹按钮**）→ 从零建一个包（挑模板 / 填名 / 算计划 / 真建）→ 从零装一个底座（选版本 + 加载器 / 算计划 / 真下载安装）→ ② 总览 → ③ 装 mod（联网搜 + 勾选）→ ④ 要下的东西（依赖 / 体积 / 冲突 / 确认下载）→ ⑤ 找物品 ID（中英文都能搜）→ ⑥ 一个物品的配方 → ⑦ 改配方表单（预览 / 确认写入）→ ⑧ 任务书（章节标签 + 按词筛 + 任务列表）→ ⑨ 改一条任务（预览 / 确认写入）→ ⑩ 打包发给别人（三形态 / 体积 / 自检）→ ⑪ 从零加任务 / 加章节（预览 / 确认写入）→ ⑫ 拖拽画布（SVG 节点 / 依赖连线 / 暂存保存） |
| 宿主接口 | `lib/host/api.js`（约 380 行） | 用 `connection.fetch.register()` 开 **28 条**带认证的 HTTP 路由，前缀 `/api/mcstudio`。界面直接 `fetch()` 调，**不经过工具层**，直连 `lib/core/*` |
| 共享缓存 | `lib/host/cache.js`（约 40 行） | `indexCache` + `graphCache`，键是实例目录小写，TTL 10 分钟。索引和配方图各值几十兆，界面两个模块都要用，各存一份纯浪费 |
| 改配方接口 | `lib/host/recipe-api.js`（约 430 行） | `/recipes` `/recipe` `/recipe/preview`（GET）+ `/recipe/apply`（**POST**）。处理函数只返回普通对象，包成 HTTP 响应是 `api.js` 的事 —— 这样单测能直接调，不用造 Request |
| 改任务书接口 | `lib/host/quest-api.js`（约 500 行） | `/questbook` `/quests` `/quest` `/quest/preview`（GET）+ `/quest/apply`（**POST**）。任务书缓存 TTL 60 秒（比索引短，因为改完要立刻看到新值） |
| 选文件夹 | `lib/host/pick-folder.js`（约 250 行） | 浏览器拿不到绝对路径，所以在宿主侧弹系统对话框：Electron `dialog.showOpenDialog({properties:['openDirectory']})` 优先，退到 PowerShell 的 `FolderBrowserDialog`，都不行就报错让用户手填 |
| 入口 | `lib/index.js` | 原有工具注册不变，追加 `ctx.inject(['connection'], (child) => { const c = child.get?.('connection') ?? child.connection; if (c) registerStudioApi(c); })` |

**改配方的做法（重要设计决定）**

原配方的 JSON 在 mod 的 jar 里，**不能改**（改完校验和不对、也没法随包更新）。标准做法是在 KubeJS 里「先删再重加」：

```js
ServerEvents.recipes((event) => {
    event.remove({ id: 'create_compressed:cogwheel' })
    event.shapeless('2x create:cogwheel', ['create_compressed:cogwheel_block'])
      .id('kubejs:edit_create_compressed_cogwheel')
})
```

- 新配方 ID 由**原 ID 派生**（`kubejs:edit_<原ID小写化>`），所以反复改同一条永远是同一个脚本条目，不会越改越多。随机 ID 会越改越乱。
- **只认三种配方**：有序合成、无序合成、Create 机器配方。用标签当材料、多产物、熔炉切石机这类 —— 一律 `editable:false` 并给中文原因。假装能改然后写出一段游戏里不生效的代码，比明说改不了糟糕得多。
- **列表里故意不给「能不能改」**：判断要打开 jar 读原始 JSON，几十条全读一遍太慢。列表只报类型（有序合成/无序合成/机器配方），点进去才给结论。宁可多点一下，也不能列表写「可改」点开说改不了。
- **预览和写入走同一个函数** `buildRecipePlan()`，所以「看到的就是会写进去的」。
- 写入三步安全：`checkWritable`（探针）→ `writeFiles`（自动备份成 `.bak-<时间戳>-<序号>`）→ 复验（`runScript` 我们自己那段；再 `verifyScripts` 整个 kubejs 目录但**只回滚我们那份文件**，别人的历史问题只记 warning）。
- 影响面用 `findBreaks`，但**要排除新配方仍然产出的物品**，否则虚报「这些物品会彻底没来源」。

**改任务书的做法（重要设计决定）**

任务书比配方麻烦：**一个任务有两半，存在两个文件里**。

- 标题 / 副标题 / 说明写 **`config/ftbquests/quests/lang/<语言>.snbt`**，键是 `quest.<ID>.title` / `.quest_subtitle` / `.quest_desc`
- 坐标 / 依赖 / 要求写 **`config/ftbquests/quests/chapters/<章节>.snbt`**

所以界面这一版**只动文字那一半**（这是作者最常改、也最不容易改坏的部分；动坐标要连着整张画布一起看，等有画布了再说）。改一次通常只写一个语言文件，`buildQuestPlan()` 返回的 `files` 里就一条。

- **界面默认优先看中文**：`loadQuests()` 默认 `en_us`（工具层要原始最全的），但 `pickLocale()` 在界面没指定语言时，包里有 `zh_cn.snbt` 就用 `zh_cn`。不然中文包在界面里显示一堆英文任务名，用户会以为任务书坏了。
- **预览和写入走同一个函数** `buildQuestPlan()`，和改配方一个套路。
- **`changes[].before/after` 是「给人看的字符串」**：描述是多行文本，用 `\n` 拼。所以 apply 复验时必须把重读出来的数组 `after.description.join('\n')` 再比 —— 直接比数组和字符串永远不相等。
- 写入三步和改配方一样：`checkWritable` → `writeFiles`（自动备份）→ 重读整套任务书复验每个字段，不过就 `restoreFiles` 整批回滚。
- 概览里带体检：重复 ID、悬空依赖、错误数/提醒数（`lintQuests`）。**改之前先看这个**，本来就有问题的书，改完出问题分不清是谁的锅。

**⚠️ 真写盘会撞 DSH 的写权限边界（2026-10-29 已解决，但换机器/换目录会再遇到）**

如果整合包在工作目录外面，会话是 `workspace-write` 时写 `D:\pcl2\...` 必失败：
`EPERM: operation not permitted, open '...\.dsh-write-probe-...'`。
`checkWritable` 会先探一次，失败就抛 `KubejsNotWritable` / `QuestNotWritable` + 中文提示（放开到完全访问，或把包复制到工作目录下）。
→ 现在的实验副本在 `lab\` 里，已经用 `icacls /setintegritylevel` 打好 Low 标记，能正常写。**但 `config\ftbquests` 这棵子树当初被漏掉了，2026-10-29 补打了一次**（见 §7 第 45 条）。换新包时记得逐个子目录用写探针验一遍，别只看根目录。

**⚠️ `connection` 必须用 `ctx.inject` 拿，不能在 `apply` 里 `ctx.get`**

最初写的是 `const connection = ctx.get?.('connection'); if (connection) registerStudioApi(connection);`，
结果 `apply` 跑的时候 `connection` 服务还没就绪，拿到 `undefined` → **7 条路由一条都没注册** → 界面所有请求 404
（用户报的「宿主返回了非 JSON（HTTP 404）」就是这个）。改成条件注入后，服务就绪时才回调；永远不就绪就永远不回调，
正好兼顾「桌面版有 connection、命令行没有」。

**选文件夹为什么要拆成两步接口**

不能让 `/pick-folder` 一个请求挂着等用户选完 —— 用户可能把对话框开着翻半分钟目录，而 Node 的 `server.requestTimeout`
默认是 5 分钟，长请求有被掐断的风险。所以：
`GET /pick-folder` 立刻返回 `{started}`，界面每 350ms 轮询 `GET /pick-folder/status` 拿 `{status, path, canceled, error, hint, code}`，
`status` 取值 `idle | picking | failed`。拿到 `path` 就自动填进输入框并连接。

**怎么接进去的（照抄即可加新面板）**

- `package.json` 要有 `exports["./client"] = "./lib/client.js"` 和 `dsh.client = { inject: [], platform: 'web' }`
- 侧边面板 = 两个插槽 + 一个标签页注册：
  - `ctx.sidebarRightTabs.register({ id, kind, patterns: ['dsh-resource://<kind>/**'], priority: 'builtin', canOpen, title, guide: [...] })`
  - `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key, ... }, 组件))`
  - `ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name, key }, 标题组件))`
  - 打开：`ctx.sidebarRight.openTab('<kind>')`（需要活跃会话）；没有会话时退 `openResource('dsh-resource://<kind>/...')`
- **`guide` 那条是必须的，不是可选的**：DSH 右侧栏顶部那个「+」打开的是「开始」引导页，引导页里的入口框就是用户发现插件面板的唯一入口。只注册类型、不登记 `guide`，面板会**完全没有任何可点的地方**（界面文件照样被正常加载、接口照样能用，就是看不见）。`guide` 每项写 `{ id, order, title(), description() }` 就够，`kind` / `providerId` 由注册表自动补（`sidebar-right/lib/client.js:4734-4738`）。
- 完整可参考的 DSH 官方界面插件源码已解到 **`ref/dsh-ui-api/`**（jobs / deliverables / layout / sidebar / conversation 五个包）。解包工具是 `tools/asar-ls.js`（用法 `node tools/asar-ls.js <asar> ls <前缀>` / `cat <包内路径>` / `grep <前缀> <关键词>`）

**⚠️ 宿主侧代码不会热更新** —— 改完 `lib/index.js`、`lib/host/api.js` 必须**重启 DSH** 才生效。只改 `lib/client.js` 时刷新页面（Ctrl+R）即可，因为界面 bundle 是每次页面加载时按文件 mtime 算 `rev` 重新拉的。

**怎么确认界面文件真的被提供了（不靠猜）**

`dsh-client-modules` 的 URL 形状和 rev 算法都已解出来（见 §7 第 25 条）。用 `lib/client.js` 的 `mtimeMs/ctimeMs/size` 算 rev，然后请求
`GET http://127.0.0.1:<端口>/plugins/??dsh-mc-modpack-studio/client.js&rev=<rev>`
→ 200 + `text/javascript` + 正确字节数，就说明插件行已激活、bundle 已进启动图，问题只可能在浏览器侧或入口可见性。
（对照：`/plugins/<包名>/client.js?rev=` 是 404，只有分块名才走那个形状；`/`、`/api/*` 一律 401，鉴权在路由之前，没法用状态码区分接口是否存在。）


**实验副本（改配方真写盘的地方，2026-10-29 定下来了）**

用户亲手把「重度机械症」复制了一份当实验副本并搬进工作区，位置：

```
D:\Desktop\VibeCoding\dsh-minecraft-modpack-studio\lab\重度机械症 - 实验
```

**是项目根的 `lab\`，不是 `lib\`**（理由见 §7 第 42 条：`files` 里有整个 `lib`，放进去会被打进安装包）。
所有写操作只对它，原包 `D:\pcl2\PCL 下载\整合包\重度机械症` 一个字不动。

搬进来后**照样写不进去**，根因是 Windows 完整性级别而不是文件权限，判定过程见 §7 第 41 条。修复命令：

```powershell
icacls 'D:\Desktop\VibeCoding\dsh-minecraft-modpack-studio\lab\重度机械症 - 实验' /setintegritylevel '(OI)(CI)Low' /T /C /Q
```

**已端到端验证通过**（2026-10-29，第一次真的把配方写进磁盘）：

| 步骤 | 结果 |
|---|---|
| 列 `create:cogwheel` 的配方 | 366ms，生产 5 条 / 消费 32 条 / 库里 11,076 条 |
| 打开 `create_compressed:cogwheel` | `kind=shapeless`、`editable=true`、产物 `create:cogwheel x9`、材料 `create_compressed:cogwheel_block` |
| 预览（改成 2 个） | 6ms，**预览前后目标文件都不存在**（确实没写盘） |
| 真写盘 | 877ms，生成 `...\Mechanomania\kubejs\server_scripts\dsh_recipes.js`（430 字节），复验通过，影响面 0，警告「产物数量从 9 改成了 2」 |
| 备份 | 空 —— 目标文件是新建的，没有旧内容可备份。**改已有文件时会生成 `.bak-<时间戳>-<序号>`** |

客户端复现用的临时探针（`tmp-apply-check.mjs`）已删，需要再跑就照这个顺序手写一个：直接 import `lib/host/recipe-api.js` 的 4 个 handler，用假 request `{ url, method, text }` 调，跑法 `node --import ./test/register.mjs <脚本>`。

**还没做的（按用户优先级）**

- [x] **改配方表单**（2026-10-29 完成）：搜到物品 → 看它有哪些配方 → 改产物数量/材料 → 预览 → 直接生成 KubeJS 脚本并 apply。复用 `lib/core/kubejs-write.js` + `lib/core/kubejs.js`，没另写一套
- [x] **任务书编辑**（2026-10-29 完成）：读整本书 → 按章节/关键词筛 → 点一条任务改标题/副标题/说明 → 预览 → 写入（备份 + 重读复验 + 不过就回滚）。复用 `lib/core/quests.js` 的 `patchQuestText` / `lintQuests`，没另写一套。真包实测：395 个任务 / 18 章，概览 36ms、列表 2ms、预览 6ms、写入含备份还原 88ms
- [x] **打包按钮**（2026-10-29 完成）：面板 ⑩ 段，三形态切换 + 体积预估 + 真打 zip + PCL 自检。实测 offline 886.6 MB / 4050 条目 / 23.5 秒，自检 8 条全过
- [x] **从零建包**（2026-10-29 完成，拼装式）：拿本机能启动的实例当模板 → 校验包名 → 算计划 → 真建。工具 `mc_pack_create` + 面板「从零建一个包」段，共用 `lib/core/pack-create.js`。建出来的包已真启动到主菜单
- [x] **选版本向导**（2026-10-30 完成，真下载）：选版本 + 加载器，游戏本体/资源/加载器依赖全从网上下（本体资源走 Mojang 官方、加载器走 BMCLAPI 镜像），再让官方安装器 `--offline` 打补丁。工具 `mc_pack_scaffold` + 面板「从零装一个底座」段，共用 `lib/core/scaffold.js`。实测 678.9 MB / 136.6 秒 + 安装器 28 秒，装出来的包 17.8 秒到主菜单
- [x] **从零装底座的 1.20.1 Forge 分支**（2026-10-30 完成）：`lib/core/java-runtime.js` 自动下 Mojang 官方 Java（1.20.1 → gamma 17.0.15 / 403 文件 / 86.9 MB），`scaffold.js` 多第 5 步「装 Java」，Forge 版本列表改走 XML，`locateLoaderVersion` 认 `<mc>-forge-<v>` 目录名。实测 380.1 秒装完、**17.3 秒到主菜单**（详见 §0「补 16」）
- [ ] 面板里的错误提示统一走 `McError` 的 `hint` 字段，别把堆栈甩给用户
- [x] **换图标时的物品搜索（可视化下拉 + 中文）**（2026-10-31 完成）：右键「换图标物品」卡片里加搜索框，输入中文（钻石 / 齿轮）或 ID 都能搜，候选每行带图标 + 「中文名（mod:item）」，点一下填进 ID 框；后端一行没改（`/items` 的 `searchItems` 本来就比显示名，中文名来自 mod jar 的 `zh_cn.json` 与原版 `assets/objects`）；防抖 260ms、`limit=40`、图标走 `ensureIcons` 批量取。测试 495→**496**（详见 §0「补 19」）
- [x] **任务书拖拽画布**（2026-10-30 完成）：面板 ⑫ 段（SVG 节点 + pointer 拖拽 + 依赖连线 + 章节筛选 + 暂存/预览/保存），底层 `lib/core/quest-move.js`，模型侧 `mc_quest_move`，两条路共用同一批函数
- [x] **蓝图提到最前 + 节点右键编辑**（2026-10-30 完成）：画布改名「任务蓝图」并排到「连接」后面（默认「显示全部功能」，可切「只看蓝图」），连上包自动读任务书+读画布；节点右键六项（改名/换图标/改前置/在后面加一个/删掉），底层新增 `lib/core/quest-node.js` + `lib/core/quests.js` 的 `removeQuest` + 四条 `/quest/node/*` 路由 + 工具 `mc_quest_remove`（并给 `mc_quest_patch` 加了 `icon`/`dependencies`）。工具 28→29、路由 36→40、测试 33/457→**34/494**（详见 §0「补 17」）
- [x] **方块模型等轴测渲染（和 JEI 对齐）**（2026-10-31 完成）：新增 `lib/core/model-render.js`（等轴测投影 + 只画朝相机的三面 + 画家算法 + 明暗）+ `pngPixels`/`encodePng`，取图标顺序改成「`textures/item` 2D 图 → 模型渲染 → 平铺贴图」。缺图 947（9.1%）→ **762（7.3%）**，渲染 3445 个；测试 36/546→**37/553**（详见 §0「补 26」）
- [x] **连线实时跟随 + 拖动不留黑框**（2026-10-31 完成）：连线建画布时记 `{el, fromId, toId, x1, y1, x2, y2}`，拖动时 `shiftEdges()` 按「原始坐标 + 位移」重算相连的线（不累加、不越拖越偏）；黑框两个真因都堵了 —— 根 `<svg>` 不再被 `transform`/`will-change`（平移缩放改作用在内层 `<g class="mcs-viewport">`）、`<image>` 加 `draggable=false` 且 svg 上拦 `dragstart`，另外 `.mcs-canvas svg{overflow:visible}` 防裁剪。测试 41/593→**41/595**（详见 §0「补 32」）
- [x] **多选一起挪 + 画布不再「向左侧吸引」**（2026-10-31 完成）：真因不是吸附，是①拖完浏览器补的那下 `click` 把多选收成单选（`state.suppressClick` 吞掉它，并新增 Ctrl/Shift+点击加选）②画布原点是「节点包围盒左上角」，最左任务一动整张图就平移（记住 `state.canvasOrigin`，重画时 `tx += scale*(minX-origin.x)*CELL_X` 补偿）。测试 41/595→**41/598**（详见 §0「补 33」）
- [ ] **JEI 级图标的一次性导出通道**：写个客户端脚本（或小 mod）把 1 万多个物品渲染成 PNG 落盘，`findExportDirs` 直接读 —— 这样刷怪蛋/箱子这种实体渲染的物品也能有图（用户尚未拍板）

### 5.1 ✅ 【已完成】修 §4 的 PE 解析 bug

- 已修，见 §4 开头的结案说明
- 验收：`test/export.test.mjs` **15/15**；真 exe 能正确判为 PCL

### 5.2 【P7】打磨（原计划 1 天）

这是「从能用到好用」的阶段，具体做这些：

- [x] **补一个 `mc_item_search` 工具** ✅ 已完成（`lib/tools/item-search.js`，23 个工具，现为 267/267）：按关键字 / 命名空间 / 来源 mod 搜物品 ID，精确命中排最前，命中 0 时列出实例的命名空间帮排查。**2026-10-29 补了中文名搜索**：搜「齿轮」→ `create:cogwheel`、搜「钻石镐」→ `minecraft:diamond_pickaxe`。原版物品的中文名不在 jar 里，是从 `<mcRoot>/assets/objects` 读的（见 §7 第 17 条）
- [x] **补一个 `mc_mod_inspect` 工具** ✅ 已完成（`lib/core/mod-inspect.js` + `lib/tools/mod-inspect.js`，13 个测试）：拆 jar 导出物品+中文名 / 配方（类型·产物·材料）/ 标签 / 掉落表 / config 原文。view 分 summary·items·recipes·tags·loot·config 六档，默认只给概览。实测 Create 6.0.10：801 物品、1884 配方、69 标签、640 掉落表、3 个自有配置，约 100ms
- [ ] **跨工具联动**：`mc_quest_patch` 写任务时如果引用了不存在的物品 ID，要能主动提示「要不要先查一下」；`mc_kubejs_verify` 报缺物品时，要能给出「这些 ID 在 12,591 个里都没有，可能是拼错了」这类可操作建议
- [x] **高清图标（2026-10-30 完成）**：`lib/core/icon-export.js` 读游戏导出的 `icon-exports-x64/`（实测 2150 张 PNG / 1895 个能对上物品 ID），`resolveIcons()` 里加了「导出目录优先」的第 0 轮，两条路由 `/icon-export/status` 与 `/icon-export/scan`，面板 ⑧ 段显示图标来源 + 「重新扫描图标」按钮。取图 25 ms、三维模型物品（Create 水车等）也有真图
- [ ] **错误文案统一**：所有 `McError` 的 `suggestion` 字段检查一遍，确保都是「人话 + 下一步怎么办」，不要甩堆栈
- [x] **README.md** ✅ 已完成：用户向（能干什么、怎么装、怎么用、安全边界）+ 开发者向（目录结构、跑测试）。注意 `node --test` 会 spawn EPERM，必须一个套件一个套件跑
- [ ] **locale 补全**：`locale/zh.json` 和 `locale/en.json` 现在只有 233 / 245 字节，基本是空的。所有工具的输出文案要能双语
- [ ] **真实包端到端回归**：在 `Mechanomania` 的副本上把「改配方 → 写任务书 → 打包 → 真启动」全链路走一遍，确认没有回归
- [ ] **验收清单逐项过**：`docs/archive/HANDBOFF.md` §2.6 那 11 项验收清单，逐条打勾或记录差距

### 5.3 【P8】联网元数据层（原计划 1.5 天）

用户明确要求「更想要联网的 mod 元数据查询」。设计已经写在 `docs/archive/HANDBOFF.md` §4.8 / §4.10，这里是实施要点：

- [ ] 新增 3 个工具：`mc_mod_search`（找 mod）、`mc_mod_meta`（查详情）、`mc_mod_compat`（查版本/前置兼容）
- [ ] **Modrinth v2**（免 key）：`https://api.modrinth.com/v2`
  - 必须带独特的 User-Agent，否则会被限流
  - `/v2/search?facets=[["categories:neoforge"],["versions:1.21.1"]]`
  - loader 映射用 `forge` / `neoforge` / `fabric` / `quilt`
- [ ] **sha1 批量反查**（这是最高性价比的一招）：
  `POST https://api.modrinth.com/v2/version_files`，body `{hashes:[...], algorithm:"sha1"}`
  实测抽 40 个 jar 命中 34 个（85%）。**比解析 updateURL 强得多**（183 个 jar 里只有 6 个能被 Modrinth 正则认出）
- [ ] **CurseForge**（要 key）：`https://api.curseforge.com/v1`，header `x-api-key`
  - key 走环境变量 `CURSEFORGE_API_KEY`，**不要硬编码**
  - **没 key 时必须静默降级**，返回 `source: "local-only"`，不能报错
  - loader 用 `modLoaderType` 数字：1=Forge, 4=Fabric, 5=Quilt, 6=NeoForge
  - 申请步骤见 `docs/archive/HANDBOFF.md` §4.10.1（console.curseforge.com，或走人工表单）
- [ ] **免 key 兜底**：CFWidget `https://api.cfwidget.com/minecraft/mc-mods/<slug>` 实测 200 可用，但没有 dependencies 字段
- [ ] **MC 百科默认关闭**：实测 `search.mcmod.cn` 能抓（无开放 API，只有 HTML），但按用户意思只做可选 enrichment，不进主流程
- [ ] 定位别忘了：**API 只负责「找 mod / 认版本 / 查前置」，配方和物品的真相永远来自 jar**

### 5.4 【发布】打包成能装的插件

- [ ] `package.json` 的 `files` 已经配好（`lib` / `locale` / `icon.svg` / `cordis.patch.yml` / `README.md`）—— 但 README 还不存在，补上
- [ ] 版本号从 `0.1.0` 决定要不要升
- [ ] 本地安装验证：`docs/archive/HANDBOFF.md` §5.4 有步骤
- [ ] 确认 `peerDependencies` 是宽范围（见 §3.4）

### 5.5 【已启动】可视化 UI

原计划是「先只做对话，等引擎稳了再说」。
**2026-10-29 用户改主意了**：看完 README 里四条主线，指出第一条「图形化修改」完全没有，拍板做 **DSH 侧边面板**。
前三块切片已完成（连接/总览/搜物品 → 改配方 → 改任务书），详见 §5.0。还差「打包按钮」和「从零建包向导」。
`probe/ftbqp/` 那个现成的 FTB 任务书可视化编辑器**仍然没接进来**：这一轮的任务书编辑是自己在 `lib/host/quest-api.js` 里按行文本改的（够用，而且备份/复验/回滚都是现成的）。等要做「任务坐标画布」时再考虑接它。

---

## 6. 回归基准数字（改代码后拿这个对）

这些是 2026-10-28 在 `Mechanomania` 上实测的。改动后如果数字大幅偏离，说明有回归。

### 索引（`lib/core/index.js`）

| 指标 | 值 |
|---|---|
| jar 数 | 183 |
| mods 侧物品 ID | **10,123** |
| 原版 jar 净增 | **2,468**（自身并集 2,817，其中 349 被 mods 覆盖） |
| **总计** | **12,591** |
| 物品总数（`_items.size`，界面用的口径） | **10,450** |
| 有显示名的物品（`_names.size`） | **8,201** |
| 其中原版中文名（`assetsNames.zh`） | **1,726** |
| 耗时 | 376–384ms（不含 assets）/ **约 515ms**（含 assets 原版中文名） |

> ⚠️ 如果看到 `12,260`，说明配方正则退化成只匹配复数 `recipes/` 了 —— 1.21.1 的包 10,204 个配方全在**单数** `recipe/` 里。正确正则是 `(?:recipes|recipe)`。
> ⚠️ 如果 `assetsNames` 是 `{zh:0,en:0}` 而实例明明有 `<mcRoot>/assets/objects/`，说明资源索引没读到 —— 搜中文名会只剩 mod 自带的那部分，原版物品退回英文名。

### 界面接口（`lib/host/api.js`，2026-10-29 实测）

| 路由 | 耗时 | 备注 |
|---|---|---|
| `/roots` | 27ms | 扫到 2 个 PCL 下载目录：`atm10sky`（1 实例）、`重度机械症`（2 实例） |
| `/summary` | 370ms（首次）/ 命中缓存约 0 | `Mechanomania`：MC 1.21.1 / neoforge 21.1.228 / mod 183 / 物品 10,450 / 配方 11,503 |
| `/items` | 命中缓存 | 中文名可搜，如「钻石镐」→ `minecraft:diamond_pickaxe` |
| `/pick-folder` | 立即返回 | 只返回 `{started}`，不等用户选完 |
| `/pick-folder/status` | 立即返回 | `{status: idle\|picking\|failed, path, canceled, error, hint, code}` |
| `/recipes?item=` | 354ms（首次，含配方图） | `create:cogwheel` → 生产 5 条 / 消费 32 条 / 库里 11,076 条 |
| `/recipe?recipeId=` | 10ms | 命中缓存后只读一个 jar 里的一个 JSON |
| `/recipe/preview` | 6ms | 只算不写，返回生成的代码 + 影响面 + warnings |
| `POST /recipe/apply` | 877ms（首次真写） | 真写盘；`workspace-write` 下写工作目录外会 `KubejsNotWritable`（预期行为） |
| `/questbook` | 36ms | `Mechanomania`：395 个任务 / 18 章 / 语言 zh_cn / 有显式标题 40 个 / 错误 0、提醒 35 |
| `/quests` | 2ms | 命中缓存；默认 `limit=120`，接口上限 300 |
| `/quest?questId=` | 命中缓存 | 一条任务的文字、要求、奖励、上下游 |
| `/quest/preview` | 6ms | 只算不写，只回传文件元信息（不回传全文，避免大语言文件撑爆响应） |
| `POST /quest/apply` | 88ms（含备份 + 还原） | 写 lang 文件；写完重读整套任务书复验，不过就整批回滚 |

索引缓存 `INDEX_TTL_MS = 10 分钟`，`refresh=1` 强制重扫。缓存住在 `lib/host/cache.js`（索引 + 配方图共用）。
任务书缓存 `BOOK_TTL_MS = 60 秒`（比索引短，改完要立刻看到新值），apply 成功后自动清空。

> 改配方实测（实验副本 `D:\pcl2\PCL 下载\整合包\重度机械症 - 实验\versions\Mechanomania`）：
> `create:cogwheel` 的 5 条生产配方里，3 条因为「材料用了标签」或「9 种产物」被判为改不了，
> `create_compressed:cogwheel` 和 `createadditionallogistics:crafting/kinetics/cogwheel_from_lazy` 可改。
> 选前者改数量 9 → 2，生成代码正确、预览阶段文件确实没被创建。

> 「选文件夹」实测：生成出来的 PowerShell 脚本在真机 `powershell.exe -STA` 下跑通（exit 0，无 stderr），
> `Add-Type System.Windows.Forms`、建隐藏 owner 窗体、建 `FolderBrowserDialog` 都不报错。
> 没在自动化里点「确定」，因为那需要真人操作。

### 配方图（`lib/core/recipes.js`）

| 指标 | 值 |
|---|---|
| 配方总数 | **11,076** |
| 有产物 / 有材料 | 10,851 / 8,852 |
| 删 create 1,909 条配方 | 拿不到 778 个，**真断路 94 个** |
| Top 断路 | `create:andesite_alloy`(**72**)、`minecraft:cobbled_deepslate`(25)、`minecraft:blackstone`(25)、`minecraft:obsidian`(21) |
| 耗时 | 309–355ms |

> `create:andesite_alloy` 被 72 条配方需要 —— **这是最稳定的回归基准**，跟旧探针口径也一致。

### 重叠与进度（`lib/core/overlap.js`）

| 指标 | 值 |
|---|---|
| 同名物品 | **208** 组 |
| 撞车功能族 | **9** 类 |
| 进度可算物品 | **4,502**（算不出 1,638） |
| 最宽第 0 层 | 1,400 个（31.1%） |

### FTB 任务书（`lib/core/quests.js`）

| 指标 | 值 |
|---|---|
| 章节 / 任务 / 分组 | 18 / 395 / 3 |
| 加载耗时 | 25–30ms |
| 本地化单文件 | `lang/zh_cn.snbt` = 1,020,272 B / **5,635 键** |
| 任务级文本非空 | subtitle **1,275**/3,658，description **2,316**/3,658 |

> ⚠️ 旧文档曾断言「单文件只有章节标题，任务文本全在 `zh_cn/chapters/`」，**已被实测推翻**。
> 真相：单文件是**超集**，分章（52 个文件）是它的子集。
> 正确做法：**读优先单文件，缺键再分章补；写时若存在 `<locale>/chapters/` 则两处同步更新。**

### KubeJS（`lib/core/kubejs.js`）

| 指标 | 值 |
|---|---|
| 脚本数 | 24（`server_scripts` 15 个 + 其余） |
| 能跑 / 语法错 / 运行错 | 24 / 0 / 0 |
| 缺物品 / 缺配方 | **0 / 0** |
| 耗时 | 30ms |

> ⚠️ `ServerEvents.tags('item', ...)` 的**第一个参数是标签，不是物品**。
> 早期没区分，误报了 5 个缺失（`kubejs:the_end_helmet` 等全是脚本自己创建的标签）。已修。

### 启动（`lib/core/launch.js`）

| 指标 | 值 |
|---|---|
| libraries 原始条目 | 144（96 非 natives + 48 natives） |
| 规则过滤后 | 93 → 去 11 个重复 artifact → **82 个 classpath jar** |
| classpath 字符串长度 | **7,702** 字符 |
| natives（x64 Windows） | **8 条**（只取 `natives-windows`，必须排除 arm64 / x86 各 8 条） |
| 交给 JVM 的文件总数 | **90**（82 + 8） |
| 参数 | jvm 24 条 / game 32 条 |
| 到主菜单耗时 | **55 秒** |
| 成功判据 | `latest.log` 出现 `Sound engine started` |

> ⚠️ 旧数字 `117 个 jar / 11,227 字符` 是**算错的**（把 arm64/x86 的 natives 和重复 artifact 都算进去了）。
> ⚠️ 沙箱坑：`workspace-write` 模式下 log4j 会报
> `Cannot access RandomAccessFile ... logs\latest.log (拒绝访问。)` 然后 2.4 秒退出 —— **看起来像启动失败，其实是写权限问题**。归因流程第一步必须判 `gameDir\logs` 能不能写。

### 导出（`lib/core/export.js`）

| 形态 | 指标 |
|---|---|
| `standard` | 3,249 文件 / 361.7 MB（只含 mods/config/kubejs/资源包/光影） |
| `offline` | 8,594 文件 / 1.34 GB 计划 → 实际 **8,596 条目 / 1.23 GB / 29.6 秒** |
| `launcher` | 外层 `modpack.zip` + `PCL.exe` + `dsh-export.json` |

> 已用 .NET `ZipFile::OpenRead` 独立验证：8,596 条目可读，抽出的 jar SHA256 与原文件一致。

### 从零装底座（`lib/core/scaffold.js` + `java-runtime.js`）

| 目标 | 计划 | 实装 | 启动 |
|---|---|---|---|
| 1.21.1 + NeoForge 21.1.228 | 678.9 MB | 136.6 秒 + 安装器 28 秒 | 17.8 秒到主菜单 |
| **1.20.1 + Forge 47.4.28** | 3,728 文件 / 751.8 MB（vanilla 3665 / asset 3598 / loader 63 / java 0，本机已有 Java 17） | **380.1 秒**（其中补下 6 个失败文件 247 秒） | **17.3 秒到主菜单** |

1.20.1 启动计划关键数字：版本 id `Forge1201`、主类 `cpw.mods.bootstraplauncher.BootstrapLauncher`、libraries 117 条（rules 跳过 24）、**classpath 73 项**（72 库 jar + 1 客户端 jar，拼串 9,720 字符）、natives 7 条、磁盘缺失 0、JVM 24 条 / game 32 条。

> 没有本机 Java 17 时计划会多出 `javaFiles=403 / java=91,151,764`（86.9 MB，实测补齐 12 秒）。**Java 缺失不是错误**：`scaffold` 会自己下。

---

## 7. 踩过的坑（省你几个小时）

### 沙箱相关

1. **`node --test` 不能用** → `Error: spawn EPERM`。必须 `node --import ./test/register.mjs <file>`。
2. **Node 里 `child_process.execSync` / `spawnSync` 被拦** → `EPERM` on `cmd.exe`。脚本内不要调 PowerShell，改用纯 Node 库，或者用 `pwsh` 工具直跑。
3. **写工作区以外的路径会被拒**（比如 `D:\pcl2\...`）→ 需要 `danger-full-access` 一次性提权。
4. **`Get-PSDrive D` 返回空 `Free:` / `Get-Volume` 报拒绝访问** → 这是沙箱限制，**不是磁盘满**。
5. **PowerShell 显示 UTF-8 中文文件会乱码** → 读文件用 `read` 工具，别用 `Get-Content`。
5b. **⚠️ 沙箱里子进程管道一律 `EPERM`（2026-10-30 新增，最容易静默踩的一条）** —— `spawn/spawnSync/execFile` 只要带 `stdio:'pipe'`（哪怕其中一路是 pipe）就 `spawnSync ... EPERM`。这条能把三种功能一起打死，而且**两种死法都不报错**：
   - `execFile` 收安装器输出 → 直接 EPERM，装不上；
   - `spawnSync(java, ['-version'], {stdio:...pipe})` 收版本号 → EPERM，于是「明明装了 Java 17 也说没有」；
   - `spawnSync(where, ['java'])` 判 `status===0` → **状态码永远不是 0**，PATH 里的 Java 从来没被发现过（`lib/core/java.js` 的老 bug 就是这条）。
   **唯一可用形状**：`const fd = fs.openSync(log, 'w')` → `spawn(exe, args, { stdio: ['ignore', fd, fd] })` → 父进程立刻 `closeSync(fd)`（子进程已继承）→ 跑完读回日志。已封装成 `lib/core/proc.js`：`captureCommand` / `captureCommandSync` / `readFileTail`，`test/proc.test.mjs` 7 条守着。**别再写回 pipe，也别在 `stdio:['ignore',fd,fd]` 下挂 `child.stdout.on('data')`（那是 `null`）** —— `lib/core/launch.js` 用的是「定时增量读日志文件喂 `onChunk`」。
   - 顺带一条：`pwsh` 工具里 `Invoke-WebRequest` 也一律「基础连接已关闭」（TLS 失败），**联网只能走 node 的 fetch**。

### 网络与加载器相关（2026-10-30 新增）

5c. **这台机器的网络会随机掐 TLS，任何单次失败都不等于代码坏** —— `piston-meta.mojang.com`、`resources.download.minecraft.net`、`bmclapi2.bangbang93.com` 都能 1 秒内正常返回 200，也可能连续多次 `ECONNRESET` / `Client network socket disconnected before secure TLS connection was established`，实测失败率约一半且成段抖动（同一 URL 隔 15 秒再试就成功）。所以要：
   - 大批量下载必须有「第二轮补下」（`applyItems` 的 `retryFailures`，2 并发 + 错开 1~2.4 秒）：第一次装 651 MB 资源就剩 6 个没下来（429 / fetch failed），补一轮全齐；
   - 版本清单这种单点请求要「每个地址 3 次 × 1.2 秒间隔」（`fetchManifest`）；
   - 别把失败当成逻辑 bug 去改代码，先重试一次看看。
5d. **Forge 的版本列表是 XML，不是 JSON** —— `https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml`（213 KB）；NeoForge 才是 JSON 目录接口。而且 **BMCLAPI 的 neoforge 目录接口不代理 Forge**（`/neoforge/meta/api/maven/details/releases/net/minecraftforge/forge` → 404），所以 Forge 只能走官方 + 镜像改写规则。`lib/core/version-manifest.js` 里用 `loaderListIsXml()` + `parseMavenMetadataXml()` 分流，`http` 层为此补了 `text()`。
5e. **Forge 1.20.1 装出来的版本目录名带 mc 前缀** —— 不是 `forge-47.4.28`，而是 **`1.20.1-forge-47.4.28`**（NeoForge 1.21.1 才是 `neoforge-21.1.228`）。猜错的话实例 json 的 `inheritsFrom` 指向不存在的目录，启动直接报「找不到版本 json」。正确做法：用安装器自己 `version.json` 里的 `id`（`preferredId`）→ `<mc>-<loader>-<v>` → `<loader>-<v>` 依次试，并且**按磁盘上真实存在的 `versions/<id>/<id>.json` 挑**（`locateLoaderVersion` 已改成这样）。
5f. **Java 不用让用户手装** —— 版本 json 的 `javaVersion.component` 直接对应 Mojang 官方运行时（1.20.1 → `java-runtime-gamma` = 17.0.15，403 个文件 / 86.9 MB；1.21.1 → delta = 21）。`lib/core/java-runtime.js` 就是按这个下的，落到 `<mcRoot>/runtime/<组件>/`，`collectJavaCandidates` 本来就会扫那儿。**别去下 Adoptium 之类第三方包**：官方这套和游戏自更新的目录结构完全一致。

### 数据相关

6. **配方目录单复数**是最致命的坑：1.21.1 全用单数 `recipe/`（10,204 个），复数 `recipes/` 只有 9 个。只匹配复数会**静默失效**（不报错，只是少 676 个 ID 和全部 9,786 份配方）。正则必须 `(?:recipes|recipe)`。
7. **modId 要三种元数据回退**：`META-INF/neoforge.mods.toml` → `META-INF/mods.toml` → `META-INF/fabric.mod.json`。
   而且 toml 里 `modId = 'xxx'` **可能是单引号**，正则要 `['"]` 都认。修好后 181/183 可解析（剩下 2 个是 loader 层，正常）。
8. **进度曲线第 0 层必须包含「没有配方的原材料」** —— 否则铁矿、木头这类物品永远算不出深度，整张图会全是 0。
9. **`findBreaks` 必须先排序再截断** —— 在收集循环里 `break` 会让最重要的断路项（比如 `andesite_alloy`）直接消失。

### 插件相关

10. **`peerDependencies` 写死会被安装器拒** —— 必须 `>=0.1.5-rc.1 <0.3.0`。
11. **仓库不是 git 仓库**（`fatal: not a git repository`），不能用 git 做 diff / 回滚。改之前先备份，或者用 `write.js` 的自动备份。
12. **临时脚本用完就删** —— 上个会话在仓库根目录留了 40 多个 `tmp-*.mjs`，清理很烦。测试用 `test/` 下的文件，探针用完 `Remove-Item`。
13. **读 exe 的版本信息别用 `indexOf('VS_VERSION_INFO')` 撞** —— .NET 单文件打包的 exe 里内嵌十几个程序集，各有版本资源（真 PCL 有 14 份）。必须走 PE 资源目录取 `RT_VERSION`。实现见 `lib/core/export.js` 的 `peVersionResource()`。
14. **别信「PCL 的 ProductName 一定是 Plain Craft Launcher」** —— 实测 2.10.6 的单文件版 ProductName 是空的，只有 `Comments = "Minecraft 启动器"`。
15. **1.21 把三组目录名改成了单数** —— 配方 `recipes/`→`recipe/`、标签 `tags/items/`→`tags/item/`、掉落 `loot_tables/`→`loot_table/`。只写一个就**静默少掉一半数据**，不报错。正则一律写成 `(?:recipes|recipe)` 这种形式。产物字段同理：1.20 是 `{item,count}`，1.21 是 `{id,count}`。
16. **别用「文件名含 modId」认 config** —— `create` 会命中 32 个文件，但其中 29 个是 `create_central_kitchen`、`createdieselgenerators` 这种**别的 mod** 的配置，它们只是名字以 create 开头。真属于 Create 的只有 `create-client/common/server.toml` 三个。判定要用「modId 后面紧跟 `-` `.` `/` 或结尾」，`_` 不算。实现见 `lib/core/mod-inspect.js` 的 `modConfigFiles()`。
17. **原版物品的中文名不在 jar 里** —— 从 1.13 起客户端 jar 只带 `assets/minecraft/lang/en_us.json`，中文是「资源包对象」，放在 `<mcRoot>/assets/objects/<hash前2位>/<hash>`，靠 `<mcRoot>/assets/indexes/<id>.json` 的 `objects` 表反查。不读这层，用户搜「钻石镐」命中 0 个。实现见 `lib/core/index.js` 的 `assetsLang()`（实测读到 1,726 条中文名，索引耗时 370ms → 515ms）。
18. **工具返回值里不能有 `undefined`** —— 宿主会对输出做 JSON 往返校验，一个 `index: undefined` 就让整个工具报 `returned invalid output: value is not lossless JSON`，而且旧测试只看 JS 对象、抓不到。已在 `lib/tools/shared.js` 加 `toLossless()`，`guarded()` 统一洗一遍，并有 `test/lossless.test.mjs` 专门守这条。

### 界面层相关（2026-10-29 新增）

19. **宿主侧插件代码不热更新** —— 改完 `lib/index.js` / `lib/host/api.js` 必须重启 DSH 才生效。界面半边 `lib/client.js` 也一样。
20. **界面调宿主别走工具层** —— 用 `connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', fetch })` 开 HTTP 路由，直接调 `lib/core/*`。走工具层要绕 JSON schema，白白多一层。
21. **界面插件不用打包工具** —— `lib/client.js` 就是手写的 `window.__ModuleLoader__.load({ id, factory })`，`require('react')` 和 `require('react/jsx-runtime')` 现成可用。照着 `ref/dsh-ui-api/` 抄。
22. **`dsh plugin add` 装 link 包** —— 命令是 `dsh plugin --profile desktop add 'link:<绝对路径>'`，它会自动同时写进 profile 的 `dependencies` 和 `dsh.profile.bundles` 两处。要改工作区外的 profile 文件，得 `danger-full-access`。
23. **绝不能用 PowerShell 的 `Get-Content`/`Set-Content` 改含中文的源文件** —— 它按 GBK 读进来再按 UTF-8 写回，整个文件的中文注释会变成 `杈撳叆鍏抽敭瀛楋紝` 这种乱码，而且**没有 git 可回滚**。改代码只用 `edit` / `write` 工具。
24. **测试界面插件要用查询串破 ESM 缓存** —— 同一个 `lib/client.js` 被 import 第二次不会重跑 `factory`，必须 `import('../lib/client.js?load=' + n++)`。
25. **面板必须在 `sidebarRightTabs.register` 里登记 `guide`，否则用户根本看不见** —— 这是最坑的一条，因为**没有任何报错**：界面文件被正常加载、`/plugins` 能吐出 bundle、接口也能用，就是右侧栏没有任何入口。右侧栏顶部「+」打开的是「开始」引导页，引导页里那些入口框**只来自各类型的 `guide` 数组**（`sidebar-right/lib/client.js:4734` 把 `guide` 每项补上 `kind`/`providerId`；`:620` 用 `sidebar.right.tab.guide.entry` 插槽渲染，有默认 fallback，不用自己注册插槽）。所以每个面板类型都要写 `guide: [{ id, order, title(), description() }]`。
26. **`openTab` / `openResource` 都需要活跃会话** —— 两者都先调 `this.require()`，没有会话时会抛。要主动开面板就得 `try openTab(kind) catch → try openResource(address) catch {}`，否则点击是哑的。`placeTab` 只校验 `tabs.get(kind)` 存在（**不要求有 `patterns`**），所以带 patterns 的类型也能 `openTab`。
26b. **别往主界面顶栏（`conversation.session.header.actions`）加入口按钮** —— 曾经加过一个「整合包工作室」按钮，用户直接问「之前不是说这个制作只放在侧栏里面」。已删。现在这个工作室的入口**只有两个，都在右侧栏内部**：① 右侧栏顶部「+」→ 引导页里的卡片（靠第 25 条的 `guide`）；② 开过一次之后右侧栏顶部留下的标签页。`test/client-plugin.test.mjs` 有一条专门守「主界面顶栏不许有按钮」，别再为了「好找」加回去。
27. **界面 bundle 的 URL 形状是 `/plugins/??<id1>,<id2>/client.js&rev=<rev>`** —— 不是 `/plugins/<包名>/client.js`（那个 404）。`rev` 是 `framedHash('plugin-artifact', [mtimeMs, ctimeMs, size])`，即 `sha1('plugin-artifact\0' + 每段 "${byteLength}:${part}")` 取前 12 位十六进制（`@deepseek-ai/dsh-client-modules/lib/index.js:184-200`）。想确认「插件到底加载没有」，用这个算 rev 再请求，比猜 URL 靠谱。
28. **`dsh plugin` 会被陈旧锁卡死** —— 报 `atomic-write: timed out waiting for the writer lock at C:\Users\lyh\.dsh\profiles\desktop\package.json.lock`。那个 6 字节的 `.lock` 是上次异常退出留下的，删掉即可，不是权限问题。
29. **PowerShell 的 `>` 重定向写出来是 UTF-16LE** —— `node x.mjs > out.txt` 之后再读，`read` 工具会报 binary、`Get-Content` 也读不对。要读就用 `readFileSync(p, 'utf16le')`，或者干脆用 `Out-File -Encoding utf8`。
30. **PowerShell 抓 node 输出的中文要设编码** —— 不设 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` 时，node 打的 UTF-8 中文会被按 GBK 解码成乱码，正则匹配 `通过` 之类会**静默不命中**（测试统计会莫名变成 0）。另外 `$f.BaseName` 对 `kubejs.test.mjs` 得到的是 `kubejs.test`，不是 `kubejs`，判断分支别写错。
31. **`connection` 服务要用 `ctx.inject` 等，不能在 `apply` 里 `ctx.get`** —— `apply` 跑的时候 `connection` 还没就绪，`ctx.get('connection')` 返回 `undefined`，路由一条都注册不上，界面全 404，而且**宿主侧不报任何错**。正确写法 `ctx.inject(['connection'], (child) => { ... })`。这是「用户输路径报 HTTP 404」的真正原因。
32. **浏览器里永远拿不到用户选的文件夹绝对路径** —— `<input type="file" webkitdirectory>` 和 File System Access API 的 `showDirectoryPicker()` 都只给文件夹名 + 相对路径（[SO 69236490](https://stackoverflow.com/questions/69236490/how-do-you-get-the-selected-directory-path-from-file-system-access-api-window-sh)）。想拿真路径只能宿主侧弹系统对话框。**DSH 本身也没有任何原生文件夹对话框**（在 `app.asar` 里 grep `showOpenDialog` / `OpenFileDialog` / `FolderBrowserDialog` / `shell.openPath` 全部 0 命中），它自己的「打开文件」就是 `<input type="file">`。
33. **纯 Node 里 `require('electron')` 返回的是可执行文件路径字符串，不是 API 对象** —— 必须检查 `typeof electron.dialog?.showOpenDialog === 'function'` 才算拿到真 API，否则会以为能用、一调就崩。
34. **PowerShell 弹 WinForms 对话框的三个必备条件** —— ① 必须 `-STA`，否则 `FolderBrowserDialog` 直接抛异常；② 必须 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，否则中文路径按 GBK 输出变乱码；③ 要给 `ShowDialog()` 传一个置顶的隐藏 owner 窗体，否则对话框可能藏在 DSH 窗口后面。取消时**不要输出任何东西**，用「输出为空」表示取消最可靠。`-EncodedCommand` 吃的是 UTF-16LE 的 base64。
35. **改按钮悬停样式时，主按钮必须单独写一条 `:hover`** —— 用户报过「鼠标放上去按钮就变白/看不见」。原因：`.mcstudio-btn:hover{background:fill-l2}` 和 `.mcstudio-btn-primary{background:fill-brand;color:#fff}` 特异性相同，而且通用 `:hover` 写在后面就赢，于是品牌色底被换成主题浅色填充，白字配浅底=消失。修法是给主按钮单独写 `.mcstudio-btn-primary:hover:not(:disabled)`，**并且写在通用规则之后**（同特异性靠顺序决胜），只做 `filter:brightness()` 提亮，不换背景色。`test/client-plugin.test.mjs` 有一条专门守这个。**教训**：组件库里只要文字颜色写死（#fff），就不能让通用 `:hover` 改它的背景。
36. **列表里别写「这个能改」** —— 判断一条配方能不能改，必须打开 jar 读原始 JSON（看材料是不是标签、产物是不是多个）。列表里几十条全读一遍要好几秒，所以列表只报类型，点进去才给结论。**我第一版就在列表里写了 `editable: kind !== 'unsupported'`，结果用户点「可改」的那条，点开告诉他「材料里有标签，改不了」** —— 列表里的判断比真实判断松，这种不一致比不标还糟。
37. **新配方 ID 必须由原配方 ID 派生，不能用随机/时间戳** —— 用 `kubejs:edit_<原ID小写化>`，这样反复改同一条永远是同一个脚本条目；随机 ID 会越改越多条，互相打架还查不出是谁覆盖了谁。
38. **真写盘会撞 DSH 的写权限边界** —— 会话是 `workspace-write` 时，写 `D:\pcl2\...`（工作目录外）必失败 `EPERM: operation not permitted, open '...\.dsh-write-probe-...'`。这不是 bug。`checkWritable()` 会在真写之前先探一次并给出中文提示。**（2026-10-29 已不再阻塞：用户把包搬进工作区的 `lab\` 了，见第 41–43 条）**
39. **索引和配方图必须共用一个缓存** —— 两者各值几十兆，界面里搜物品和改配方都要用。第一版我在 `api.js` 里自己建了 `indexCache`，加配方接口时又要建 `graphCache`，等于同一份数据在内存里存两遍。已抽成 `lib/host/cache.js`。
40. **`targetFile(kubejsDir, name)` 自己会加 `dsh_` 前缀** —— 传 `'dsh_recipes'` 得到的是 `dsh_dsh_recipes.js`。默认参数是 `dsh_magic`，所以正常调用传 `'recipes'` 就行。
44. **`client-plugin.test.mjs` 的 React 替身不会重渲染，抓不到「界面传错参数」** —— 那个替身的 `useState` 返回 `[初始值, 空函数]`，所以只能验证「注册了什么」，验证不了「点了按钮之后请求带了哪些参数」。界面这层最容易错的就是参数名和回读字段（错了还不报错，只是界面空着）。为此加了 `test/client-quest-ui.test.mjs`：一个**会重渲染的最小 React**（`useState` 真的存值、setState 触发重渲染）+ 按路径分发的假 `fetch`，把「连包 → 读任务书 → 点任务 → 预览 → 写入」整条链路跑一遍。**以后再往界面加功能，照这个文件抄一套流程测试**。
45. **API 空参数不要随口吞掉** —— `apiGet()` 原来会把 `''` 从查询串里删掉（`if (String(v) !== '') clean[k] = v`）。这在「筛章节」时是对的，但「把副标题清空」就永远存不进去 —— 用户看到输入框空了、点了写入、文件没变，会以为插件坏了。现在只丢 `undefined` / `null`，空字符串照传（宿主侧一律把空串当「没这个参数」处理）。
46. **写入前先想清楚「给人看的字符串」和「存盘的数据结构」不是一回事** —— 任务的 `description` 存盘是**字符串数组**（一行一个元素），但预览里给人看的是**一整段文本**（`join('\n')`）。写完复验时拿数组去比字符串永远不等，会误判成「写坏了」然后白白回滚。`changes[]` 里一律存给人看的字符串，复验时把重读出来的数组按同样方式拼回字符串再比。
47. **界面默认语言要自己定，别跟工具层一样用 `en_us`** —— `loadQuests()` 的默认 locale 是 `en_us`（工具层要原始最全的），但界面是给人看的：中文包装了一本中文任务书，界面却显示一堆英文任务名，用户第一反应是「任务书坏了」。`quest-api.js` 里 `pickLocale()` 在没显式指定时优先 `zh_cn`（包里真有这个语言文件才用）。**加这条之前 7 个测试是红的**。
50. **右键菜单必须在「捕获阶段」判断点击是否落在菜单里** —— `nodeMenu` 出现后给 `document` 挂 `mousedown`（`{capture:true}`）收起菜单，但如果只看「点到了别处」就关，点击菜单项的瞬间菜单先被摘掉，`onClick` 永远执行不到（用户看到的是「点了没反应」）。判据是 `e.target.closest('.mcstudio-menu')`，命中就放过。Esc 也一样收。
51. **别靠 `element.key` 从 `children` 里挑元素** —— 界面测试替身的 `createElement` 把 `key` 塞进 `props`，`element.key` 是 `undefined`。要重排段落就先把那一段存成变量（`canvasSection = h(...)`），最后统一 `children.length = 0; children.push(...ordered)`。
52. **`diff` 是「一句一句人话」的字符串数组，不是 `{label,before,after}` 对象** —— 面板曾经按对象取三个字段渲染，结果界面上每行都显示成「（空） → （空）」，看着像没改动。现在逐句照抄，并在测试里钉住「必须出现那句话、且不能出现『（空） → （空）』」。同理：凡是往 payload 里塞「给人看的对比」，先想清楚是对象还是字符串。
53. **`textOf` 那种「把树拼成文字」的测试辅助，必须递归进函数组件** —— 否则 `Kv` 这类把 label 放在 props 里的组件，label 半截文字根本不在树里，断言「界面上有这句话」会假失败（这个坑让两条界面测试白红了一次）。
54. **主题变量是「写了不报错、只是悄悄不生效」** —— `var(--dsw-alias-fill-l1, rgba(255,255,255,.05))` 这种写法，变量不存在时 CSS 完全合法，只是永远用兜底值。面板整片文字发灰的根因就是这个（用了六个主题里没有的名字）。**动手写样式前先查一遍真名单**：`cordis_inspect_query` → platform `client` / provider `Theme` / method `listTokens`，只有 14 个 token（`bg-base`、`bg-layer-1`、`bg-layer-2`、`bg-overlay`、`border-l1`、`border-l2`、`brand-primary`、`label-primary`、`label-secondary`、`state-error/idle/success/warn-primary`、`specific-sidebar-fill`）。**没有 `fill-*`，也没有 `label-tertiary`；是 `bg-layer-2` 不是 `bg-l2`**。`test/client-plugin.test.mjs` 里那条「样式只用主题里真有的变量」就是这道闸。
55. **SVG 的 `fill=` 属性不接受 `var()`** —— 颜色必须写进 `style: { fill: 'var(--mcs-fg)' }`，写成 presentation 属性会静默失效（看起来像「文字没颜色」）。
56. **「搜索结果是异步的」，别和用户手打的值存进同一份状态** —— 换图标那张卡里，`nodeDraft.value` 是用户填的 ID，`iconPick` 是上一次查询回来的列表，两者分开存；合并成一份必然出现「列表还是上一个词的、输入框已经是新词」。判断列表是否属于当前输入用 `iconPick.q === query.trim()` 对一下。
57. **面板里做防抖（`setTimeout`）要注意测试得真等** —— 界面测试替身不接管计时器，`await tick()`（0ms）等不到 260ms 后的请求；`test/client-quest-ui.test.mjs` 里那条中文搜索就是 `await new Promise(r => setTimeout(r, 340))`。另：换包重置时记得 `clearTimeout` 并把 `iconPick` 清掉，否则旧包的候选会闪一下。
58. **「让用户自己打字才出内容」的列表，用户会当成功能不存在** —— 换图标那张卡第一版要等到 `iconPick` 有值才渲染候选，卡片打开时是空的，用户直接反馈「没有找到下拉图标的列表」。凡是要用户从一堆东西里挑的（物品、任务、章节），**打开就先给一屏**（按命名空间 / 按章节 / 按最近用过），打字只是收窄。按钮同理：能预载就预载。
59. **中文输入法的回车不能抢** —— `onKeyDown` 里 `e.key === 'Enter'` 就 `preventDefault()` 会把输入法的「确认候选词」也吞掉，用拼音打字的人会觉得「中文输入根本没反应」。判据三条**必须同时挡**：`e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229`。另外输入法选完字不会触发 `onChange`（有些浏览器只在 `compositionend` 后才更新），所以 `onCompositionEnd` 也要补一次搜索。
60. **`useCallback` 里调普通函数会抓到旧闭包** —— `pickNodeAction` 是 `useCallback`，依赖数组里没有 `dir`/`summary`，直接在里面对 `apiGet('/items',{dir})` 取值，用的是回调创建那一刻的 `dir`（换包后还是旧目录）。改法：`const iconLoadRef = useRef(null); iconLoadRef.current = loadIconCandidates;` 每次渲染刷新，回调里 `iconLoadRef.current(...)`。**凡是「回调 + 依赖最新 props」的地方都按这个来。**
61. **语言文件里的长键既能当简介、又能污染名字，两件事必须分开处理** —— `item.ns.x.tooltip.summary` 是简介（要收），但绝不能当 `item.ns.x` 的名字（中文错名的根因，见补 21）。反过来 `lang/default/tooltips.json`、`lang/builtin/*.json` 里**全是**长键，只当英文简介来源，不要拿来造物品或起名字，否则会多出一批幽灵 ID。
62. **`indexInstance()` 返回的 `_items` 是 Map（`id → {id, from}`）不是 Set** —— `for (const id of idx._items)` 拿到的是 `[id, value]` 数组，于是「有简介的物品数」会被统计成 0。十进制探针要写 `for (const id of idx._items.keys())`。`_names` / `_descriptions` 也是 Map。
63. **统计「缺多少图标」必须按 `ICON_LIMIT`（128）切批** —— `resolveIcons` 会把单次数量夹到 128，探针按 200/批 切的话每批静默少算 72 个，得出 1828 而真值是 2869（正好差 36%）。这种「少算但不报错」的偏差最容易在汇报数字时坑人。
64. **PNG 的 bpp 和行宽必须按位深算，不能一律当 8 位** —— 裁竖排动图时要解 PNG：`bpp = max(1, 通道数 × 位深 / 8)`、`行宽 = ceil(width × 通道数 × 位深 / 8)`。原版 `water_still.png` 是 **4 位调色板**，按 8 位解出来全是错位彩条。调色板图还要带 PLTE / tRNS，4 位时一个字节两个像素（`(b >> 4) & 0xf` / `b & 0xf`）。
65. **业务层的「没找到」不能回 `ok:false`** —— 面板的 `apiPost`（`lib/client.js:266`）判 `body.ok !== true` 就当请求失败，抛出 `body.error || '请求失败（HTTP <status>）'`。于是「MC百科上没有这条」会显示成「请求失败（HTTP 200）」，原因被吞、看起来像插件坏了。正确形状：`{ ok:true, found:false, reason:'…' }`。这条是界面测试抓到的（假数据回 ok:false 时断言拿不到原因）。
66. **mcmod 是按 IP 的总频率限流，不是按 URL** —— 表现为 HTTP 200 + 正文「搜索太频繁」。实测搜索页 **2.5 秒/次** 连打正常，350ms/次 十几次就进冷却；冷却期发什么都被拒。所以搜索单独一条 2.5s 线、详情页与图标 CDN 600ms，撞限流进 60 秒冷却并直接回原因。**别写批量抓图**，一次几十张必挂，且保守匹配的命中率只有 25%。
67. **「放置出来的方块」和「拿在手上的物品」在 jar 里是两套资源，物品表里还会有同名幻影** —— `create:belt_connector` 才有 `textures/item/belt_connector.png`；`create:belt` 只有 `blockstates/belt.json` + 一条平铺条纹。语言键 `block.create.belt` 会把后者也带进物品表，两条都叫「传送带」，用户搜到没图的那个就以为「图标错了」。**判「能拿在手上」只看两样证据**：`models/item/<名字>.json` 或 `textures/item/<名字>.png`。去重必须加**同命名空间**限制（跨 mod 撞名如「虚空石」删了就是误删真物品）。见补 24 / §21。
68. **贴图只挂在 blockstate 指的模型上时，按「models/block/<名字>.json」永远找不到** —— `create:rope` 的真实链路是 `blockstates/rope.json` → `models/block/rope_pulley/rope.json` → `textures/block/pulley_rope.png`。补一轮 blockstate → 模型 → 贴图即可。**但零件贴图不能取第一张**：同一个方块模型常同时挂 `andesite_block`（一块石头）和 `funnel/andesite_funnel`，要按「贴图名与物品名共享词根数」打分，一个词根都不共享就不出图。
69. **告示牌的别名规则别写死正则** —— 「去掉名字里的 `_wall_`」一条就够，写死 `_wall_sign`/`_wall_hanging_sign` 会漏掉没有颜色前缀的画布告示牌（`wall_hanging_canvas_sign` → `hanging_canvas_sign`）。
70. **「物品图标」只能是物品自己的模型渲染出来的东西，不能拿方块外观顶** —— 判据：只认 `textures/item/<名字>.png` 与 `models/item/<名字>.json`（顺着 parent 追是允许的，JEI 也是这么画的）。`models/block/` 兜底、`blockstates/` 反查这两层都会产出「放置出来的样子」，用户一眼就能看出不对。宁可画字母方块 + MC百科按需兜底。
71. **一个模型里挂一堆贴图时，「第一个存在的」几乎总是错的** —— 要从带 `elements` 的模型里选一张最像的，排序两条判据：① 贴图路径与物品名共享几个词根（`andesite_funnel` 2 个 > `andesite_block` 1 个）；② 面片加权面积（竖面 ×1.5、上下 ×1），因为图标是「从侧面看」。没有 `elements` 的 `cube_bottom_top` 这类模型则按贴图键名优先：`side / front / base` 排在 `bottom` 前面，否则 tnt 的图标会变成一张引信图。
72. **同一张表里同时收 `textures/block` 和 `textures/item` 会静默选错** —— jar 条目顺序里 `textures/block/` 排在 `textures/item/` 前面，「第一个登记的先到」= 方块那张。要分两张表、让 item 那张先查。

73. **模型里的贴图引用常常不写命名空间**（`textures:{all:'block/tnt_side'}`）—— `textureEntryOf('block/tnt_side')` 拼不出 `assets/<ns>/...`，于是整张模型一个像素都画不出来，`drawn===0` 之后静默退回平铺贴图，看起来像「渲染器坏了」。`renderIconFromModel` 里必须按模型自己的命名空间补全：`raw.includes(':') ? raw : \`${m[1]}:${raw}\``。

74. **贴图表的「先到先得」会把渲染流程整个饿死** —— 只要第 1 轮还允许退回 `textures/block/<名字>.png`，方块物品（tnt/熔炉/台阶/机器）就全都走平铺图，后面的等轴测渲染永远轮不到。顺序必须是：**`textures/item`（2D 物品图）→ 模型渲染 → 平铺贴图兜底**，和 JEI 一致。

75. **写图标渲染的测试时，夹具 PNG 的 alpha 必须 ≥128** —— 仓库里原来那张 1×1 PNG 的 alpha 是 127，渲染器按「透明像素不画」跳过，于是「有 `elements` 却画不出来」，很容易误判成投影算法坏了。渲染相关用例统一用 `encodePng(4,4,Buffer.alloc(64,255))`。


### 写权限 / 文件系统相关（2026-10-29 新增，**最费时间的一段**）

41. **搬进工作区的目录照样写不进去，根因是「完整性级别」不是「文件权限」** —— 用户把整合包从 `D:\pcl2` **移动**到工作区后，`EPERM` 依旧。判定过程很有参考价值：
    - 对照试验：工作区根能写、`lib\` 能写、**新建中文目录能写**、深层长路径能写，只有那个搬进来的包不行 → 排除「中文名」「路径长度」「路径开头是点」。
    - 用 skill `diagnose-windows-sandbox-acl` 跑一遍，确认给 6 层目录补上了当前用户的完全控制并验证过，**但重试还是 `EPERM`** → 排除 ACL。
    - 最后用 `icacls` 对比两个目录才看出来：能写的 `lib` 比不能写的包目录**多一行 `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)`**。
    - 原理：DSH 的沙箱进程以 **Low 完整性级别** 运行，Windows 的完整性控制（Mandatory Integrity Control）规定「低级别进程不能写更高级别的对象」。工作区目录被 DSH 打成了 Low，移动进来的目录保留原来源的 Medium，于是**权限全给也对它写不进去**。
    - 修复：`icacls '<目录>' /setintegritylevel '(OI)(CI)Low' /T /C /Q`（实测 13638 个对象 4 秒；`saves` 里 2589 个自带特殊权限的小文件会失败，与改配方无关，忽略）。
    - 还原：同一条把 `Low` 换成 `Medium`。
    - **注意「移动」和「复制」在这一点上不等价**：移动（`Move-Item` 或资源管理器拖动）会**保留源对象**的 ACL 和完整性标签；复制粘贴则让新文件**继承目标目录**的标签。所以搬进来会踩坑，复制进来不踩。
42. **工作区里的实验数据别放在 `lib\` 下** —— `package.json` 的 `files` 里有整个 `"lib"`，放进去的话 `npm pack` 会把 10.5 GB 塞进安装包。约定放项目根的 `lab\`（不在 `files` 清单里）。用户 2026-10-29 已经把包挪到 `lab\重度机械症 - 实验`，挪完写权限正常（移动保留标签）。
43. **PowerShell 的 `-ExecutionPolicy` 会拦住 skill 里的 `.ps1`** —— 直接 `& '<path>.ps1'` 会报「因为在此系统上禁止运行脚本」。改用子进程：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<path>.ps1' -Arg ...`。注意本机跑 `pwsh`（PowerShell 7），但 `.ps1` 用 `powershell.exe`（5.1）跑最稳，WinForms 那类老 API 只在 5.1 上验证过。
48. **完整性标记是按对象存的，包级 `/T` 会零星漏掉子树** —— 第 41 条那次 `icacls /T` 报了「13638 成功 / 2589 失败」，看着像「失败的都是存档里的小文件、无关」，结果 `config\ftbquests` 整棵子树也在失败名单里，改任务书时照样 `EPERM`（`QuestNotWritable`）。补法（**只对小范围补，别一上来就整个包重扫**）：
```powershell
icacls '<实例>\config\ftbquests' /grant "$($env:USERNAME):(OI)(CI)F" /T /C /Q
icacls '<实例>\config\ftbquests' /setintegritylevel '(OI)(CI)Low' /T /C /Q
```
（29 个对象，0 失败，之后写探针 OK）。**`/setintegritylevel` 需要 `WRITE_OWNER`，光有「修改」权限不够**，所以要先 `/grant ...F`，否则会一片 `Access is denied`。
49. **判断「这个目录能不能写」不要看 `icacls` 的文本** —— 受限模式下 `icacls <目录>` 的输出里**可能根本不显示 `Mandatory Label` 那一行**，`Select-String 'Mandatory Label'` 会给你空的，看着像「没问题」其实是没打标签。**最可靠的判定是直接往那个目录写一个探针文件再删掉**。另外 `icacls` 的报错路径是 GBK 编码，中文会乱码（`ضȻе֢`），别拿它做字符串匹配。还有一个坑：`Set-Content` 失败是**非终止错误**，`try/catch` 抓不到，必须看 `$Error` 或加 `-ErrorAction Stop`，否则会误报「OK」。

---

## 8. 文档索引

| 文件 | 内容 |
|---|---|
| **`docs/archive/HANDOFF-NEXT.md`** | 本文件，行动文档 |
| `docs/archive/HANDBOFF.md` | 完整技术文档（≈95 KB / 13 章）。§2 需求、§4 技术底座实测、§5 插件契约、§6 工具清单、§8 分阶段、§9 作战提示、**§13 Java 运行时/沙箱管道/Forge 实装** |
| `probe/ftbqp/README.md` | 那个现成的任务书可视化编辑器（暂不接入） |
| `ref/dsh-tool-modpack.README.md` | 参考实现 1（配方/任务生成） |
| `ref/mc-pack-builder-mcp.README.md` | 参考实现 2（打包） |
| `ref/minecraft-mcp-server.README.md` | 参考实现 3 |
| `ref/PCL2-ModModpack.vb` | PCL2 源码里判断整合包格式的那段（55 KB，查 PCL 兼容规则用） |
| **`ref/dsh-ui-api/`** | DSH 官方界面插件源码（jobs / deliverables / layout / sidebar / conversation 五包），照它写侧边面板。用 `tools/asar-ls.js` 从 `D:\DeepSeek Harness\resources\app.asar` 解的 |
| `tools/asar-ls.js` | asar 解包工具：`node tools/asar-ls.js <asar> ls <前缀>` 列表 / `cat <包内路径>` 导出单个文件 / `grep <前缀> <关键词>` 搜内容 |
| `tools/probe-*.js` | 历史探针脚本，查「某个数字怎么算出来的」时看 |

---

## 9. 建议的接手顺序

1. 跑一遍全量测试，确认 **34 套件 510/510 全绿** → 说明环境对上了（跑法见 §1；`node --test` 会 EPERM）
2. 让用户**重启 DSH**（宿主代码不热更新），确认右侧栏「+」→ 引导页里有「整合包工作室」
3. **在面板里走一遍完整链路**：输入或选 `D:\Desktop\VibeCoding\dsh-minecraft-modpack-studio\lab\重度机械症 - 实验\versions\Mechanomania` → 看总览 → 搜「齿轮」→ 点物品 → 点一条配方 → 改数量 → 预览 → 确认写入；再回到 ⑧ 任务书 →「读取任务书」→ 点一条任务 → 改标题 → 预览 → 确认写入。**这两条链路在脚本层都验证通过了（写成功、复验通过、备份还原正常），但还没人在真界面上点过**，先确认它能用，再往里加东西
4. 读 `docs/archive/HANDBOFF.md` §2（需求）、§9（作战提示）和 **§13（Java 运行时 + 沙箱管道 + Forge 实装，2026-10-30 新增）**，大概 25 分钟
5. 四条主线已全部走通（改配方 / 写 KubeJS / 从零建包含从零装底座 / 打包导出），而且**两个目标版本都从零装出来并真启动到主菜单**（1.21.1 NeoForge 17.8 秒、1.20.1 Forge 17.3 秒）；剩下的都是打磨：跨工具联动、错误文案统一、locale 双语、Fabric/Quilt 从零装底座
6. 让用户在真 PCL 2.10.6 里拖一次导出包 —— 这是唯一还没被自动化覆盖的验收步骤
7. 打包发布（注意 `lab\` 不在 `files` 清单里，不会被带走）

**别做的三件事**：

- 别做独立网页 / 桌面窗口 —— 用户已明确选「DSH 侧边面板」这一种形态
- 别改用户的存档名或删用户文件
- 别把 MC 版本写死
