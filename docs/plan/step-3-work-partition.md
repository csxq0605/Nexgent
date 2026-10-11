# 步骤 3 分工表：迁移已有能力，补齐灵活协作

来源：计划 [4.3](../research/pr4-review-and-plan-2026-10/README.md) 与 4.7 的退出门槛；步骤 2 验收记录 [`step-2-20261011.md`](../validation/step-2-20261011.md)；草稿 PR #50 的调研结论（第三部分对步骤 3 的建议）；对 `refactor/dsh-application`（PR #4 分支，`fd0b2f42`）上 Python 宿主与 `runtime/` 的盘点；对 DSH 子模块中 subagent、agent-team、workflow、ptc-runtime、preset、skill-filesystem、web、mcp 的阅读。本表在步骤 3 开工前定稿，回答：旧资产各自去哪、委派和子任务怎么共享资料与返回成果、做哪些工作包、谁依赖谁、每轮开哪几个讨论串（每轮最多 3 个）、`accept-step3` 检查什么、真实模型验收怎么做和花多少钱、Python 什么时候删。格式沿用 [`step-2-work-partition.md`](step-2-work-partition.md)。

计划 4.7 估计步骤 3 为 3 周；按本表排下来是 5 轮，关键路径是 kernel 的子会话支持 → 委派 → 工作流接线。周数是范围估计，不是承诺。

## 目标与退出门槛

步骤 3 对应产品目标 ②：灵活的任务组织，不固定角色与阶段。用户原话（计划 4.3）：将已有文件处理、表格、计算、技能和协作资产迁入新的服务与工具体系；按任务决定是否委派，子任务共享必要资料并返回实际成果；删除被替代的重复代码，避免长期维护两套执行系统。

**四种执行形态**（计划 4.3 第 2 项原文）：

| 形态 | 含义 | 账本 `executionForm` |
| --- | --- | --- |
| 直接执行（默认） | 主会话自己完成 | `direct` |
| 委派 | 主会话把一个子任务交给子智能体（fresh：只带任务说明与资料；fork：带上主会话已有历史），等它返回结果 | `delegated` |
| 团队 | Lead + 具名队友 + 持久邮箱 + 共享任务板，队友并行工作、互相发消息 | `team`（契约新增） |
| 工作流 / 代码策略 | 模型写脚本或声明式图，用 `agent() / parallel() / pipeline()` 编排多个成员；同一运行时也承载 PTC（模型写程序调用宿主函数） | `workflow` |

退出门槛（计划 4.7 原文“四种形态各完成一次；Python 与 `runtime/` 删除；CI 绿”，按用户 2026-10-11 的 CI 规则改写口径）：

1. **四种形态各完成一次**：同一个真实任务，从主对话分别以四种形态完成，各自有实际成果（`present` 的文件），由隐藏脚本判定；外加一个不指定形态的运行，记录模型自己选了哪种。
2. **旧任务在原生路径复现**：organization-loop 的 Excel 补货任务（读 `inventory.xlsx`，写带公式的 `purchase.xlsx`，再按反馈改库存出新版本）在 Nexgent 原生路径完成并通过判定。
3. **Python 与 `runtime/` 删除**：`nexgent-app` 上不再有 Python 文件与旧目录（见“Python 删除”一节）；归档分支 `archive/python-host` 建好。
4. **“CI 绿”的新口径**：合并前在云端会话本地跑改动包及依赖方的测试与类型检查；`accept-step3` 无界面层与桌面层在 Linux 本地通过；合入 `main` 前手动触发一次 Windows 工作流并通过（用户 2026-10-11 12:59“跑 win 再合并”）。工作流仍只能手动触发。
5. 验收记录 `docs/validation/step-3-<日期>.md` 经用户认可；合入 `main` 要用户另行同意。

## 旧资产盘点与去向

### 先纠正一个事实

计划 4.3 第 4 项要删的 `src/`、`tests/`（Python）、`benchmarks/*` Python 插件、`scripts/*.py`、`pyproject.toml`、`requirements-*.txt`、`runtime/` subtree，**都不在 `nexgent-app` / `main` 上**，只在 `refactor/dsh-application`（PR #4，已关闭）及其祖先 `feature/organization-loop` 上。`nexgent-app` 上剩下的 Python 是旧 PyQt Harness：`nexgent/`（196 个文件）、`stage-0…8/`（16 个文件）、`tests/`（3 个文件）、`config.py`，内容与 `archive/harness-gui` 完全相同（`git diff` 为空）。仓库里没有任何构建、测试、工作流引用它们。

所以步骤 3 的“删除 Python”是两件事：在 `nexgent-app` 上删掉这四处旧目录；把 Python 宿主所在的 `refactor/dsh-application` 顶端归档为 `archive/python-host`。要迁移的能力从后者读取。

### Python 宿主（`refactor/dsh-application:src/nexgent`，94 个文件约 4.4 万行）

| 资产 | 规模 | 去向 | 理由 |
| --- | --- | --- | --- |
| `organization_spreadsheets.py`：读 xlsx、算公式、写带公式与缓存值的 xlsx；拒绝 `=1/0`、外部引用、未知函数；单区域 2000、单簿 20000 单元格上限 | 163 行 + 测试 220 行 | **迁移** → `@nexgent/tool-spreadsheet` | 读取已在 `@nexgent/skill` 的 `xlsx.ts`；缺的是写入公式、计算缓存值、上限与拒绝规则。按 Python 测试用例写 TS 测试 |
| `organization_tools.py` 的 `query_csv` / `query_spreadsheet`（SQLite 查询，200 行上限） | 287 行中的一部分 | **改写** → 用 PTC 写代码查询 | 计划原文“查询用 PTC 函数”；不再引入 SQL 方言 |
| `organization_tools.py` 的 `run_python`（AST 限制，只预载 `math`） | 同上 | **迁移** → `@nexgent/ptc`（Node 后端） | 计划原文；限制语义照搬：独立进程、空环境变量、文件访问按调用方沙箱、超时 |
| `organization_tools.py` 的 `fetch_url`（公开网页，分页，`public_url` 防内网） | 同上 + 测试 98 行 | **迁移** → `@nexgent/web` 的 `web_fetch` | 计划原文；SSRF 防护照搬并加测试 |
| `organization_tools.py` 的 `list_files` / `read_text` / `write_artifact` | 同上 | **丢弃** | 已被 `@nexgent/workspace` 文件工具与 `present` 替代 |
| 计算技能（组织保存的至多 4 段可复用 `run_python` 代码） | 同上 | **丢弃，作为步骤 4 设计输入** | 可复用代码属于 `CapabilityBundle` 的“PTC 函数模块”，步骤 4 再做 |
| `organization.py`：Lead 分派、成员并行、独立评价、改进器、门控；`INITIAL_ORGANIZATION`（analyst、checker 两名成员） | 799 行 | **协作部分改写** → `@nexgent/team` 与内置预设；**门控部分作为步骤 4–5 设计输入** | 协作语义由 team / subagent 承担；两名初始成员改成两份预设 JSON（只读分析、只读检查），不作为固定角色 |
| `tasks/` 的 members、dynamic_roles、member_adoption | 约 0.5k 行 | **作为设计输入**：预设 + 团队模板的字段；步骤 5 的采用规则 | 不迁移代码 |
| `tasks/` 的 task_skill_compiler / adoption / repair（把技能编译成 Python 子包） | 约 1.1k 行 | **丢弃** | Python 侧没有 SKILL.md 资产可转换；`@nexgent/skill` 已做 SKILL.md 发现。计划“技能 → SKILL.md 目录发现”一行的实际工作量为零，只补发现根目录（见 W5） |
| `tasks/` 的 evolution、generation、guards、cycles、recursive_cycles、patches、feedback_trigger、evidence、studies、four_arm_*、orchestration_*、improvers、packages、capability_* | 约 2.9 万行 | **作为步骤 4–6 设计输入**，不迁移代码 | 计划原文 |
| `tasks/` 的 runtime、store、workflows、tools、costs、outcomes、memory | 约 1 万行 | **丢弃**；`workflows.py` 的图语义作为 `@nexgent/workflow` 的参考 | 已被 kernel / session / tasking / context 替代 |
| `delivery.py`、`project_improvement.py`、`evolution/`、`benchmarks/evaluation.py` | 约 2.4k 行 | **作为步骤 5–6 设计输入** | — |
| `application.py`、`cli.py`、`workspace.py`、`kernel/`、`models/`、`ui/`、`agents/broker.py`、`research/` | 约 7k 行 | **丢弃** | 已被 sdk、cli、workspace、kernel、llm、desktop 替代；MiMo 网关不再用（ADR 0002） |
| `benchmarks/{bbh,workbench,scientific_discovery,openfoam}` Python 插件 | 26 个文件 | **步骤 3 不迁移**，留在归档分支 | 步骤 6 的任务族已定为表格 / 数据 + 多文件代码（计划 4.9 #8），这四个都不在其中；需要时从归档取数据重写 |
| `tests/`（125 个 Python 测试）、`scripts/*.py`、`experiments/`、`docs/`、`pyproject.toml`、`requirements-*.txt`、`start.ps1`、`run.ps1` | — | **丢弃**；三份测试（spreadsheets、tools、web）的用例改写为 TS 测试 | — |

### PR #4 写的 TypeScript（`refactor/dsh-application:runtime/packages/…`）

| 文件 | 行数 | 去向 |
| --- | --- | --- |
| `workflow/tool-workflow/src/architecture.ts`（声明式图：节点、依赖、环检测、内容版本号，编译成调用 `agent()` 的脚本） | 134 | **步骤 3 移植**到 `@nexgent/workflow`；纯函数，只需 JSON schema 校验与 `ToolRestriction` 类型 |
| `workflow/tool-workflow/src/architecture-store.ts`（内容寻址存储） | 58 | **步骤 3 移植**；Windows 上硬链接要补测 |
| `core/tools/src/tool-restriction.ts` | 33 | **步骤 3 移植**到 kernel 契约 |
| `workflow-ptc` 的 persona / toolFilter 透传 | 约 20 行（所在包 1.3k 行） | 在新 `@nexgent/workflow` 上**重写**，原包整体依赖 DSH 引擎，不能直接搬 |
| `bundle/nexgent-app/src/architecture-activation.ts` | 109 | **留到步骤 4**（采用与回滚） |
| `execution-ledger.ts`、`architecture-trials.ts` | 145、458 | **不搬**：前者已被 `@nexgent/llm` 账本覆盖；后者是 DSH 插件，作为步骤 4–5 设计输入 |

以上移植的文件按仓库规则加头注、登记 `THIRD_PARTY_NOTICES.md` 与 `docs/reference-map.md`（它们是 Nexgent 自己写的，但所在包从 DSH 改写而来，按“从 DSH 改写”处理更稳妥）。

### 旧 PyQt Harness（`nexgent-app` 上的 `nexgent/`、`stage-*`、`tests/`、`config.py`）

全部**删除**，归档已有（`archive/harness-gui`）。其中 `stage-5/code-review-skill/SKILL.md` 与 `nexgent/demo-project/.nexgent/skills/demo.md` 是仅有的 Markdown 技能，内容是旧 Harness 的演示，不迁移。

### organization-loop 的 Excel / 订单任务

旧分支没有提交任何 `.xlsx` / `.csv` 夹具，数据只写在测试与 `docs/organization-loop.md`（约第 395–410、495–510、529–567 行）里。步骤 3 按文档描述重建夹具，期望值由判定脚本从新夹具独立计算，不抄旧的模型运行数字：

- Excel 补货：`inventory.xlsx`（Inputs 表：6 个 SKU 的现有库存、周需求、提前期、安全库存、单价）→ 生成 `purchase.xlsx`（Plan 表用跨表公式算目标库存、向上取整的补货量与金额，Summary 表求和）→ 反馈“P01 库存从 14 改为 20” → 新版本。
- 订单汇总：`orders.csv`（订单版本去重、排除取消单、保留退款负数），作为备用任务，不进门槛。

## 委派与子任务的资料共享、成果返回

这是步骤 3 的核心设计，W0 把它写成 ADR 0004 与契约，下面是定稿前的方案。

**子任务是子会话。** 每个成员（委派对象、队友、工作流节点）都是一个独立会话，`session.start.parentSessionId` 指向发起它的会话（字段步骤 1 已预留，现在没人写）。子会话在同一进程内由 `ctx.agents.create` 建出，各有会话锁与 JSONL，可以单独恢复与查看。

**资料怎么共享：**

1. 资料按 id 传：委派工具的参数里带 `materialIds`，子会话首轮的 `TurnInput.materialIds` 用它们，由现有的 `materialsProvider` 注入引用（小文本内联、大文件与二进制给路径）。资料目录对所有会话只读，不复制。
2. 文件按项目内路径传：所有成员共用同一个项目工作目录，委派说明里列出要读的文件路径；不给成员单独的工作区副本。
3. fork 带历史：fork 把父会话到上一轮结束为止的记录复制进子会话文件（重新编号，持久化），所以子会话强杀后恢复不丢上下文；fresh 只带任务说明与资料。
4. 父会话不把自己的系统提示整体给子会话；子会话用预设决定人设、工具范围与模型参数。

**成果怎么返回：**

1. 成员用 `present` 交付实际文件，成果版本元数据带上成员的会话 id 与成员名。
2. 委派工具的结果返回给父会话：成员最后一段回复、它交付的成果 id / 版本 / 文件列表、费用与状态（completed / failed / cancelled / budget）。父会话读文件后自己汇总，并用自己的 `present` 给用户最终成果。
3. 父会话写 `subagent.start` / `subagent.end` 记录（子会话 id、形态、成员名、成果引用、结果摘要），重启后靠它们重建“谁做了什么”。
4. 现在 `present` 在不给 `deliverableId` 时按主路径追加版本，两个成员交同名文件会互相追加。改为：跨会话的同路径默认新建成果，只有显式给 id 才追加；工作流与团队的系统提示要求成员写到各自子目录。

**继承与边界：**

| 项 | 规则 |
| --- | --- |
| 沙箱 | 子会话的沙箱模式不得宽于父会话（只读 < 工作区写 < 完全访问），预设只能收窄 |
| 工具范围 | 预设的 `allow` / `deny` 用 scoped `restrict()` 实现；成员默认没有委派、团队、工作流工具（深度 1） |
| 审批 | 子会话的审批请求进同一个审批入口，带成员名与子会话 id，桌面与 CLI 照常询问用户；没有交互界面应答审批时（与父会话的现行规则相同）按拒绝处理。见“需要用户决定”第 4 项 |
| 费用 | 一个用户任务的父子会话共享同一个 `taskId`；`perTask` 上限按整棵任务树计（子会话从父会话剩余额度里拿），`perProject` 照旧按账本 |
| 取消 | 父会话取消时子会话以新原因 `parent` 取消；子会话要在工具取消宽限期内收尾 |
| 并发 | kernel 现在顺序执行同一步里的多个工具调用；并行只通过工作流的 `parallel()` 与团队实现，并发上限默认 4，单任务成员总数上限默认 16 |
| 账本 | 每个请求、工具调用与 `task.outcome` 都带 `taskId`、`memberId`、`executionForm`（字段步骤 1 已预留，kernel 现在没有写） |

**形态选择：** 系统提示只写选择原则（默认直接执行；子任务能独立完成且有可检查的产出时再委派；多个可并行、需要互相沟通时用团队；步骤固定、可批量时用工作流），不写固定角色和阶段。`packages/kernel/src/system-prompt.ts` 在步骤 1 收尾时删掉的“直接执行、委派或工作流”一句，在步骤 3 以选择原则的形式恢复。

## 范围

**做：**

1. kernel 支持子会话：`CreateAgentOptions` 增加父会话、预设（人设、工具范围、模型参数）、归属字段、fork 种子、费用额度；账本归属写入；取消原因 `parent`；子会话审批标注。
2. `@nexgent/subagent`：`delegate` 工具（fresh / fork，前台等待，一次性）；`@nexgent/preset`：预设 JSON 与内置两份（只读分析、只读检查）加一份通用执行者。
3. `@nexgent/team`：队友、邮箱、任务板，状态以记录写在 Lead 会话里，强杀后可恢复；队友只在 Lead 的轮次内工作，不做轮次结束后的后台运行。
4. `@nexgent/workflow`：脚本运行时 `agent() / parallel() / pipeline() / phase() / log()`（只前台）+ 移植的声明式图编译器与存储；`@nexgent/ptc`：Node 后端，模型写 JS 调用宿主函数。
5. 能力迁移：`@nexgent/tool-spreadsheet`、`@nexgent/web`（`web_fetch`）、技能发现补用户级根目录。
6. SDK、CLI、桌面接入：子会话列表与查看、委派 / 队友 / 工作流的进度事件、成员成果显示。
7. 删除旧 PyQt 目录、建 `archive/python-host`；README、CLAUDE.md、`docs/reference-map.md` 同步。
8. `accept-step3` 三层与真实模型验收、验收记录。

**不做：** MCP 客户端（计划“只在有真实需求时实现”，目前没有）；网页搜索提供方（需要额外密钥）；CPython 的 PTC 后端；子智能体的后台 / 可续聊模式与轮次结束后的队友后台运行；多层委派；Claude Code / Codex 等外部子智能体提供方；能力版本与采用（步骤 4）；benchmark 插件迁移；旧数据迁移（计划 4.9 #10）；Python SDK；安装包签名与自动更新。

## 总览

| 工作包 | 职责一句话 | 依赖 | 可并行 |
| --- | --- | --- | --- |
| W0 契约与规范 | 子会话、归属、团队 / 工作流记录、SDK 新事件的契约；两份规范的步骤 3 章节；ADR 0004 | 步骤 2 契约 | 与 W5、W8 并行；W1–W4、W6 等它冻结 |
| W1 kernel 维护 | 实现 W0 的子会话支持、归属写入、费用树、取消传播、审批标注、`present` 跨会话规则 | W0 | W4（PTC 部分）、W5 |
| W2 `@nexgent/subagent` + `@nexgent/preset` | `delegate` 工具、fresh / fork、资料与成果传递、预设 | W0、W1 | W3 |
| W3 `@nexgent/team` | 队友、邮箱、任务板及其持久化与恢复 | W0、W1、W2 的子会话运行器 | W2（接口先行） |
| W4 `@nexgent/workflow` + `@nexgent/ptc` | 工作流脚本运行时、声明式图移植、PTC Node 后端 | W0；`agent()` 接线依赖 W2 | PTC 与图编译器可在第 2 轮先做 |
| W5 能力迁移 | `tool-spreadsheet`、`web`、技能根目录 | 步骤 2 的 tools 与 skill | 全部 |
| W6 SDK、CLI 与桌面接入 | 子会话与成员进度进 SDK 事件；桌面显示 | W0；接真实后端依赖 W2–W4 | 对假事件先写 |
| W7 删除 Python 与归档 | 删四处旧目录、建 `archive/python-host`、文档同步 | 用户同意 | 全部 |
| W8 测试与 CI（固定讨论串） | 脚本化 provider 多会话路由、`accept-step3`、真实任务夹具与判定、Windows 手动运行、验收记录 | 各包按需 | 全部；贯穿五轮 |

依赖顺序（箭头指向被依赖方）：

```text
desktop / sdk (W6) ──► workflow (W4) ──┐
        │              team (W3) ──────┼──► subagent + preset (W2) ──► kernel 子会话 (W1) ──► 契约 (W0)
        │                              │
        └──► tool-spreadsheet / web / skill 根目录 (W5) ──► 步骤 2 的 tools、skill
accept-step3 (W8) ◄── 各包测试；W7 独立
```

## 轮次安排（每轮最多 3 个讨论串）

「测试与 CI」是固定讨论串，每轮都在；它独占 `.github/workflows/`、`packages/test-support/**`、`scripts/accept-step3.mjs`、`scripts/accept-common/step3-*`、`scripts/real-task/step3-*`。W7 也交给它（步骤 2 的归档与 `main` 合并就是它做的）。其余讨论串按轮开，同领域的后续工作发回原讨论串。

| 轮 | 讨论串（≤3） | 本轮交付 | 进入下一轮的条件 |
| --- | --- | --- | --- |
| 1 | 「步骤三契约」(W0)；「能力迁移」(W5)；「测试与 CI」(W8 + W7) | 契约、规范章节、ADR 0004、SDK 接口增量冻结；`tool-spreadsheet` 与 `web` 合入；脚本化 provider 能按会话路由多个并发会话；`accept-step3` 骨架（未接通时退出码 2）；经用户同意后删旧目录、建 `archive/python-host` | 契约 PR 合入；本地测试通过 |
| 2 | 「kernel 维护」(W1)；「工作流与代码」(W4 的 PTC、图编译器、脚本运行时对假子会话运行器)；「测试与 CI」 | kernel 子会话、归属、费用树、取消传播；`@nexgent/ptc` 与 `@nexgent/workflow` 的运行时部分；Excel 补货任务夹具与判定脚本 | kernel PR 合入；中期检查点第 1 项满足 |
| 3 | 「委派」(W2)；「团队」(W3)；「测试与 CI」 | `delegate` 与预设；团队三件套；无界面层委派、团队相关检查接通 | 中期检查点第 2–4 项满足 |
| 4 | 「工作流与代码」（`agent()` 接真实子会话）；「SDK 与桌面」(W6)；「测试与 CI」 | 工作流用真实成员跑通；SDK 事件与桌面显示；`accept-step3` 无界面层、桌面层 Linux 本地全过 | `accept-step3` 两层 Linux 本地全过 |
| 5 | 「测试与 CI」（真实模型验收、Windows 手动运行、验收记录、README）；其余按缺口开 | 真实模型层通过；Windows 一次通过；`docs/validation/step-3-<日期>.md` | 用户认可验收记录；问用户是否合入 `main` |

第 4 轮的「SDK 与桌面」可以复用步骤 2 的「桌面界面」或「SDK 与 CLI」讨论串（上下文相关），由协调者按复用优先原则决定。

## 共享文件与根目录的归属

| 路径 | 归属 | 说明 |
| --- | --- | --- |
| `package.json`、`pnpm-workspace.yaml`、`tsconfig*.json`、`vitest.config.ts`、`.gitignore` | 集成者（「步骤三契约」） | 新增包时在 PR 描述里列出要加的引用，由集成者一并改；`.gitignore` 的 Python 行由 W7 删 |
| `pnpm-lock.yaml` | 谁加依赖谁改 | 同一时间只允许一个未合入的 PR 改 lockfile；后合入的一方合并基线后用 `pnpm install` 重新生成 |
| `.github/workflows/**` | 「测试与 CI」 | 只能手动触发，不加 push / pull_request 触发 |
| `packages/kernel/src/contracts/**`、`packages/sdk/src/api.ts` | 「步骤三契约」 | 冻结后只能通过修改 PR 变更，PR 描述点名受影响的包；契约变更要同步全部测试里的类型断言并跑测试类型检查 |
| `packages/kernel/src/**`（契约以外）、`packages/session/**`、`packages/llm/**`、`packages/workspace/**`、`packages/tasking/**` | 「kernel 维护」 | `present` 跨会话规则在 tasking 里改，也归它 |
| `packages/subagent/**`、`packages/preset/**` | 「委派」 | |
| `packages/team/**` | 「团队」 | |
| `packages/workflow/**`、`packages/ptc/**` | 「工作流与代码」 | |
| `packages/tool-spreadsheet/**`、`packages/web/**`、`packages/skill/**` | 「能力迁移」 | |
| `packages/sdk/src/**`（`api.ts` 以外）、`apps/cli/**`、`apps/desktop/**` | 「SDK 与桌面」 | |
| `docs/spec/*.md`、`docs/adr/0004-*.md` | 「步骤三契约」 | 冻结后按章节改，每个 PR 只动一个章节 |
| `docs/reference-map.md`、`THIRD_PARTY_NOTICES.md` | 各包负责人只改自己包的行 | |
| 删除 `nexgent/`、`stage-*`、`tests/`、`config.py`；`README.md`、`CLAUDE.md` | 「测试与 CI」（W7） | README 只写有验收记录的能力 |

## 各工作包

### W0 契约与规范（「步骤三契约」）

- **职责：**
  - kernel 契约：`CreateAgentOptions` 增加 `parentSessionId`、`preset`（人设文本、`ToolRestriction`、模型 / effort / thinking）、`attribution`（`taskId`、`memberId`、`executionForm`）、`seed`（fork 的历史来源）、`budget`（从父任务分得的额度）；移植 `ToolRestriction` 与 `assertToolRestriction`；`TurnCancelCause` 加 `parent`；`ApprovalRequest` 加成员名与父会话；`LedgerAttribution.executionForm` 加 `team`；工具上下文能找到发起它的 Agent（或给出等价的服务查询方式）。
  - 会话记录（v1 内追加）：`subagent.start` / `subagent.end`；`team.member`、`team.task`、`team.message`（queued / delivered）；`workflow.start` / `workflow.phase` / `workflow.end`。逐个写字段、写入时机和恢复语义；`ToolRecordType` 白名单同步。
  - 成果元数据加 `memberId` 与 `sessionId` 的展示规则；`present` 跨会话同路径的新规则写进 `data-formats.md`。
  - `data-formats.md`：子会话、团队、工作流、预设 JSON、架构图存储（`.nexgent/architectures/`）各一节；`permissions.md`：子会话继承（沙箱、工具、审批、费用、取消）、`web_fetch` 的网络规则与 SSRF、PTC 进程的隔离与上限。
  - `packages/sdk/src/api.ts`：`SessionSummary.parentSessionId`、子会话列表与查看方法、成员进度事件（`member.start` / `member.end` / `workflow.phase` / `team.message`），IPC 白名单同步。
  - ADR 0004：四种执行形态、深度 1、费用树、审批路由、团队只在 Lead 轮次内工作；并说明计划 4.3 删除清单与实际仓库不符的勘误（见上文“先纠正一个事实”）。
  - 系统提示的步骤 3 增量：形态选择原则，由 W1 落进 `system-prompt.ts`。
- **DSH 参考包：** `subagent/subagent`（`child-agent.ts` 的继承规则）、`experimental/agent-team` 的事件划分、`workflow/workflow` 的请求与事件、`ptc-runtime/ptc-runtime` 的绑定类型。
- **完成标准：** 契约与 SDK 接口通过 `tsc -b` 与测试类型检查；每种新记录有 schema 与读写往返测试；步骤 2 写出的会话（Library `validation-raw/step-2-20261011/` 的会话取需要的行做夹具）仍能读出并恢复；ADR 0004 合入；派工消息引用的接口在中期检查点前不再变。

### W1 kernel 维护（「kernel 维护」）

- **职责：** 实现 W0：子会话创建与 fork 种子持久化；归属字段写进每个请求、工具调用和 `task.outcome`；`perTask` 按任务树计费；父取消传播；子会话审批标注；预设的工具范围用 scoped `restrict()`，沙箱只能收窄；`present` 跨会话同路径规则；系统提示加形态选择原则；修正 CLAUDE.md 里已过时的“Job Object 未做、`perProject` 未执行”描述（交 W7 改文件，W1 只在交接里列出）。
- **文件归属：** 见上表。
- **完成标准：** 父子会话各自强杀后能恢复，子会话 `parentSessionId` 与 fork 历史在恢复后一致；账本每条记录归属齐全；子会话请求宽于父沙箱时报错；`perTask` 在子会话花费后正确拦截父会话的下一次请求；父取消后子会话在宽限期内以 `parent` 结束且无残留进程；步骤 2 全部测试与 `accept-step2` 无界面层继续通过。

### W2 `@nexgent/subagent` + `@nexgent/preset`（「委派」）

- **职责：** `delegate` 工具（参数：任务说明、`mode: fresh | fork`、预设名或临时人设、`materialIds`、要读的文件路径、期望产出的一句话）；前台运行子会话直到结束，返回结果摘要、成果引用、费用与状态；写 `subagent.start` / `subagent.end`；预设注册表（内置 + 项目 `.nexgent/presets/*.json`），内置“只读分析”“只读检查”“通用执行者”三份，字段只填不写代码；成员不得再委派。
- **DSH 参考包：** `subagent-spawn-in-process`、`subagent-fork-in-process`、`subagent-in-process-driver`、`tool-subagent`（只取前台一次性部分）、`agent-preset`、`persona`（只参考，不搬 Cordis 作用域挂载的注册表）。
- **完成标准：** fresh 与 fork 各有脚本化测试，fork 的子会话请求含父历史、fresh 不含；资料经 id 传入后出现在子会话首轮请求；子会话 `present` 的成果出现在工具结果里，父会话能读到文件；子会话失败、取消、超额度三种结局都有可读结果；预设 JSON 有 schema 与错误提示；Windows 路径测试。

### W3 `@nexgent/team`（「团队」）

- **职责：** 工具 `spawn_teammate`、`send_message`、`wait_teammates`、`team_task_create / list / update`；队友是子会话，按名字寻址；邮箱有 queued / delivered 两态，投递在队友的下一步之前注入；任务板带依赖与状态；全部状态以 `team.*` 记录写在 Lead 会话里，强杀后从记录重建；Lead 轮次结束时未完成的队友以 `parent` 取消，状态保留，下一轮可继续。上限沿用 DSH 的量级（成员 16、任务 256、每成员待投递 64 条、单条 64 KB）。
- **DSH 参考包：** `experimental/agent-team`（roster、mailbox、task board、journal、projection）、`tool-agent-team`；去掉 experimental 的兼容层与冷恢复路径以外的部分。
- **完成标准：** 邮箱投递恰好一次（强杀在 queued 与 delivered 之间时，恢复后不丢不重）；任务板依赖未满足时不能开始；两名队友并发写不同文件互不干扰；Lead 取消后队友全部结束、无残留进程；恢复后 `team_task_list` 与强杀前一致。

### W4 `@nexgent/workflow` + `@nexgent/ptc`（「工作流与代码」）

- **职责：**
  - `@nexgent/ptc`：每次调用起一个独立 Node 进程，环境变量为空，文件访问按调用方沙箱，宿主函数经 IPC 绑定（读写工作区文件、读表格、调用 `tool-spreadsheet`），输出与时长有上限；模型工具 `run_code`。
  - `@nexgent/workflow`：`workflow` 工具（前台），脚本在 PTC 运行时里执行，宿主提供 `agent(prompt, { preset, materialIds, files })`、`parallel`、`pipeline`、`phase`、`log`；每个 `agent()` 用 W2 的子会话运行器；写 `workflow.*` 记录；并发上限 4、成员总数上限 16。移植 `architecture.ts` 与 `architecture-store.ts`：模型也可以只交一张声明式图（节点、依赖、预设、工具范围），由编译器生成脚本。
- **DSH 参考包：** `workflow/workflow`、`workflow/workflow-ptc`（不含 Python realm）、`workflow/tool-workflow`（只前台）、`ptc-runtime/ptc-runtime`、`ptc-runtime/ptc-runtime-node`。
- **完成标准：** PTC 读不到宿主环境变量与沙箱外文件、超时被终止且无残留进程（两平台）；图编译器的环检测、未知依赖、重复 id 测试（从 PR #4 的 spec 改写）；`parallel` 的成员确实并发且受上限约束；工作流中某成员失败时整体以可读错误结束，已完成成员的成果保留；工作流强杀后恢复时，已完成成员不重跑、未完成的标为 interrupted。

### W5 能力迁移（「能力迁移」）

- **职责：**
  - `@nexgent/tool-spreadsheet`：`read_spreadsheet`（复用 skill 的读取）、`write_spreadsheet`（单元格值与公式，写入时计算并写缓存值，拒绝外部引用、未知函数、除零与超上限）；纯 JS、许可证为 MIT / Apache 一类（HyperFormula 是 GPL，不用）；选型写进 PR。
  - `@nexgent/web`：`web_fetch`（HTTP GET，HTML 转 Markdown，分页，大小上限），拒绝私网、回环、链路本地地址与重定向到这些地址，`network` 效果按 `permissions.md` 走审批。
  - `@nexgent/skill`：发现根目录加用户级 `~/.nexgent/skills/`，项目优先于用户、用户优先于内置；`SkillSource` 加 `user`（契约改动由 W0 一并冻结）。
- **DSH 参考包：** `web/web`、`web/tool-web`、`web/web-fetch-http`（`network.ts`、`policy.ts`）；`skill/skill-filesystem` 的根目录次序。
- **完成标准：** Python 三份测试（spreadsheets 220 行、tools 108 行、web 98 行）的用例都有 TS 对应；Excel 补货任务的公式在写出的文件里能被 `read_spreadsheet` 读出正确缓存值；SSRF 用例（`127.0.0.1`、`169.254.169.254`、`[::1]`、DNS 解析到私网、重定向到私网）全部拒绝；两平台测试通过。

### W6 SDK、CLI 与桌面接入（「SDK 与桌面」）

- **职责：** SDK 跟踪子会话（由工具建出的 Agent 也要进 SDK 的事件与取消路径），发成员进度事件；`sessions.list` 默认只列顶层会话，带子会话计数；`sessions.open` 能只读查看子会话。CLI 的 `run` 输出里显示成员开始、结束与成果。桌面：对话中栏把委派 / 工作流 / 团队显示为可折叠的成员块（成员名、状态、费用、成果链接），点开只读查看子会话；右栏成果列表区分“最终成果”和“成员成果”；审批对话框显示是哪个成员在请求。
- **完成标准：** 组件测试覆盖成员块、子会话只读视图、成员审批提示；强杀主进程后重启，成员块与子会话仍在；窗口 1024 宽不溢出；`accept-step2` 桌面层继续通过。

### W7 删除 Python 与归档（交「测试与 CI」）

- **职责：** 经用户同意后：从 `refactor/dsh-application` 顶端 `fd0b2f42` 建 `archive/python-host`；`nexgent-app` 上删除 `nexgent/`、`stage-*`、`tests/`、`config.py` 与 `.gitignore` 的 Python 行；README、`docs/README.md`、`docs/reference-map.md`、CLAUDE.md 的旧目录描述改为指向两个归档分支；不删除、不改写任何旧分支。
- **完成标准：** `git ls-files '*.py'` 为空；`pnpm build`、`pnpm test`、`accept-step2` 无界面层照样通过；两个归档分支可检出。

### W8 测试与 CI（固定讨论串「测试与 CI」）

- **职责：** 脚本化 provider 增加按会话路由（现在是一个全局队列，按请求顺序应答，并发子会话时不确定）：剧本按成员名或会话标记分队列；`scripts/accept-step3.mjs` 沿用 step2 的结构（`step3-checks / headless / judges / real`，复用 `harness.mjs`）；Excel 补货与订单任务的确定性夹具生成器与隐藏判定；真实模型运行脚本与费用闸门；合入 `main` 前的 Windows 手动运行；验收记录与 README。
- **完成标准：** 每个检查项有能失败的反例测试；没有接通的项报 `not-implemented`、退出码 2，不伪造通过；真实模型脚本在没有密钥时退出码 2。

## 中期检查点（第 2 轮末到第 3 轮末）

必须工作的内容（脚本化 provider，Linux 本地）：

1. kernel：父会话经测试工具建出子会话，子会话强杀后恢复，归属字段进账本，父取消传播到子会话；
2. 委派：fresh 与 fork 各跑通“传资料 → 子会话 present → 父会话读成果并 present 汇总”；
3. 团队：两名队友并发、互发一条消息、任务板依赖生效，强杀 Lead 后恢复；
4. PTC 与表格：模型经 `run_code` 读 `inventory.xlsx`、经 `write_spreadsheet` 写出带公式的 `purchase.xlsx`，缓存值正确。

判定：四项满足则第 4 轮接工作流与界面；第 2 项不满足时「工作流与代码」继续对假运行器开发，「委派」延长一轮，不开新串。

## `accept-step3` 检查项清单

所有判定由脚本从文件、会话、账本和进程状态得出，不看模型或界面的自述。

### 无界面层（脚本化 provider，经 SDK）

| ID | 检查 |
| --- | --- |
| H01 | 直接执行：一轮完成并 present，账本 `executionForm: direct`，无子会话 |
| H02 | 委派 fresh：子会话 `parentSessionId` 正确；子会话首轮请求含传入资料的引用、不含父历史 |
| H03 | 委派 fork：子会话请求含父会话上一轮为止的历史；强杀后恢复，fork 历史仍在 |
| H04 | 委派返回：子会话 present 的成果出现在父会话的工具结果与 `subagent.end` 中；父会话随后 present 的最终成果引用了子会话产出的文件 |
| H05 | 团队：两名队友并发工作，邮箱消息投递恰好一次，任务板依赖生效，各自 present |
| H06 | 团队恢复：在消息 queued 与 delivered 之间强杀 Lead 进程，恢复后不丢不重，任务板与强杀前一致 |
| H07 | 工作流脚本：`parallel` 两个成员 + `pipeline` 一个汇总成员，并发数不超上限，汇总成员 present 最终成果 |
| H08 | 声明式图：一张三节点图编译执行；含环的图被拒并给出可读错误 |
| H09 | 工作流恢复：强杀后恢复，已完成成员不重跑，未完成成员标为 interrupted |
| H10 | 归属：每个请求、工具调用、`task.outcome` 都有 `taskId`、`memberId`、`executionForm`，与实际形态一致 |
| H11 | 费用树：`perTask` 上限按整棵任务树计，子会话花费后父会话被拦截，记录为 `budget/exhausted` |
| H12 | 沙箱继承：只读父会话下，子会话请求更宽模式被拒；预设的 `deny` 工具对成员不可见 |
| H13 | 取消传播：父会话取消，子会话、队友、工作流成员都以 `parent` 结束，无残留子孙进程 |
| H14 | 成员审批：子会话写 `.env` 时审批请求带成员名与子会话 id；拒绝后文件不变 |
| H15 | 成员不能再委派：成员的工具列表里没有 `delegate`、团队、工作流工具 |
| H16 | 同名成果：两个成员 present 同一路径时各成一份成果，不互相追加版本 |
| H17 | PTC：`run_code` 读写工作区文件成功；读环境变量为空；读沙箱外文件被拒；超时终止且无残留进程 |
| H18 | 表格：`write_spreadsheet` 写出的公式与缓存值正确；外部引用、未知函数、除零、超上限各被拒 |
| H19 | 网页：本地测试服务器上的页面经 `web_fetch` 转成 Markdown；私网、回环、重定向到私网被拒 |
| H20 | 技能：用户级技能被发现；同名时项目级优先 |
| H21 | 恢复后经 SDK 查询：父会话、子会话列表、成员成果、团队状态、工作流状态全部可见 |
| H22 | 会话 `seq` 连续、全部记录通过 schema（含新记录类型）；`.nexgent/` 与 `export` 产物中搜不到测试密钥 |
| H23 | 仓库里没有 Python 文件，没有 `nexgent/`、`stage-*`、`tests/`、`config.py`、`runtime/` |

### 桌面层（脚本化 provider，Playwright 驱动 Electron）

| ID | 检查 |
| --- | --- |
| D11 | 委派时中栏出现成员块（名称、状态），结束后显示成果链接 |
| D12 | 点开成员块进入子会话只读视图，可返回 |
| D13 | 成员发起的审批对话框显示成员名，选择后继续 |
| D14 | 强杀主进程后重启，成员块、子会话与成员成果仍在 |

步骤 2 的 D01–D10 继续跑，作为回归。

### 真实模型层（`--real`，手动）

| ID | 检查 |
| --- | --- |
| R01 | Excel 补货任务直接执行：隐藏判定通过（Plan 公式、补货量、金额、Summary 合计；反馈改库存后新版本数值正确） |
| R02 | 同一任务用户要求委派：至少一个子会话，有子会话 present 的文件，最终成果通过判定 |
| R03 | 同一任务用户要求团队：至少两名队友、至少一条邮箱消息，最终成果通过判定 |
| R04 | 同一任务用户要求工作流：工作流记录与至少两个成员，最终成果通过判定 |
| R05 | 不指定形态：记录模型选择的形态与理由，任务通过判定（选择本身不进门槛） |
| R06 | 同等预算对照：R02–R04 每种形态的费用、请求数、成功与否与 R01 并列写入摘要；不据此宣称协作有收益 |
| R07 | 每次运行的请求数、token、unknown 数、估算费用写进摘要；累计费用不超过上限 |
| R08 | （可选，不进门槛）Windows 上 R01–R04 |

## 真实模型验收

**任务。** organization-loop 的 Excel 补货任务，素材由 `scripts/real-task/step3-restock/` 确定性生成：`inventory.xlsx`（6 个 SKU，部分不需要补货）。第 1 轮：“根据库存表生成采购计划 `purchase.xlsx`：Plan 表用公式计算目标库存、补货量（向上取整）和金额，Summary 表汇总，完成后交给我。”第 2 轮（反馈）：“P01 的现有库存应为 20，请更新。”判定脚本从夹具独立算期望值，检查公式存在（不是写死数值）且缓存值正确、两版成果都在、v1 快照未变。

**运行方案。** Linux 云端会话，开 thinking，用环境变量 `NEXGENT_API_KEY`。R01–R05 各一次，共 5 次运行；R08 可选，在 Windows 手动工作流上跑。

**预估费用。** 步骤 2 的真实任务每次约 0.15–0.22 美元（16 次请求左右）。估计直接执行与委派每次 0.2–0.4 美元，团队与工作流每次 0.4–0.8 美元（成员各有自己的上下文），5 次合计约 2–3 美元；修复后重跑按最多两轮算，不超过约 8 美元。建议预算上限 **15 美元**，由脚本设置 `costCaps.perTask` 并在累计估算超过上限时拒绝开始新运行。这是估算，不是账单。

## Python 删除

| 时机 | 做什么 | 理由 |
| --- | --- | --- |
| 第 1 轮（推荐） | 建 `archive/python-host`（`fd0b2f42`）；删 `nexgent-app` 上的四处旧目录 | 这些目录没人引用、与 `archive/harness-gui` 完全相同；早删可以让后续讨论串不必再绕开它们，H23 从第 1 轮起就能检查 |
| 备选：第 5 轮 | 验收前统一删 | 风险更小一点，但没有实际收益 |

两件事都需要用户先同意（删除内容、动归档分支）。

## 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 脚本化 provider 按全局顺序应答，并发子会话时测试不确定 | 委派、团队、工作流的测试偶发失败 | W8 第 1 轮先做按会话路由 |
| 子会话由工具建出，绕过 SDK 的事件、取消和 `task.outcome` 路径 | 界面看不到成员、取消漏掉、结果记录重复 | W0 定义“子会话也经 SDK 跟踪”的接口，W1 / W6 实现，H13、H21 检查 |
| fork 复制父历史，thinking 块与压缩边界在子会话里回放出错 | 真实模型下子会话请求 400 | 复用步骤 2 的回放规则，fork 从最后一次压缩之后开始；R02 用 fork 时专门观察 |
| 多成员共用一个工作目录，并发写同一文件 | 成果互相覆盖 | `write_file` 只能新建；提示要求成员写各自子目录；H16 检查同名成果 |
| 团队形态在 DSH 里仍是 experimental | 邮箱与任务板语义不稳 | 只做 Lead 轮次内的同步队友，状态全部落在会话记录，用 H05、H06 固定 |
| 公式计算库的覆盖面与许可证 | 补货任务公式算不对，或许可证不合规 | 只支持补货任务与 Python 测试用到的函数集，超出时拒绝并给出错误；PR 写明许可证 |
| `web_fetch` 的 SSRF 绕过（DNS 重绑定、重定向） | 访问内网 | 解析后按 IP 判定，每跳重定向重新判定；H19 覆盖 |
| 协作形态比直接执行更贵且不更好 | 用户误以为协作有收益 | R06 并列记录，验收记录只写“能运行”，不宣称收益（PR #50 建议） |
| 真实模型在被要求团队 / 工作流时仍自己直接做 | R03、R04 失败 | 如实记为失败，回 W1 调系统提示与工具描述后重跑，不改判定标准 |
| Windows 上子进程（PTC、成员的 shell）在取消或强杀后残留 | 锁不释放、重启被挡（步骤 2 已有同类风险） | PTC 进程纳入 Job Object；H13、H17 在 Windows 手动运行里跑 |

## 需要用户决定

1. **Python 删除的范围与时机**：在第 1 轮把 `refactor/dsh-application` 顶端建成 `archive/python-host`，并删掉 `nexgent-app` 上的 `nexgent/`、`stage-*`、`tests/`、`config.py`；旧分支都不删。推荐：同意。
2. **benchmark 插件**：bbh、workbench、scientific_discovery、openfoam 步骤 3 不迁移，留在归档分支，步骤 6 需要时再取。推荐：同意。
3. **表格的公式与查询**：写入时用纯 JS 计算缓存值（许可证限 MIT / Apache 一类）；旧的 SQL 查询不迁移，改由 `run_code` 写代码查询。推荐：同意。
4. **成员的审批**：A 照常弹给用户并标明是哪个成员（推荐，用户在场时不丢操作）；B 像 DSH 一样一律自动拒绝。
5. **委派深度**：只允许一层，成员不能再委派。推荐：同意。
6. **真实模型验收**：Excel 补货任务按四种形态 + 不指定形态共 5 次，Linux 开 thinking，预估 2–3 美元，上限 15 美元；Windows 一次可选。推荐：同意。
