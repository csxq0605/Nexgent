# Nexgent 0.9

**面向任务的 RSI Agent 系统：组织成员完成工作，获取独立反馈，并将通过门控的组织和策略改进用于后续任务。**

当前可运行主线是任务与组织闭环。模型网关、工具注册和配置复用 PR #1 的已有实现，
按照 PR #2 的纠偏先完成产品流程。科学发现与 OpenFOAM 保留为独立插件／demo。

## 当前主线：Main 组织闭环

2026-09-29 按 PR #2 纠偏：默认 Main 和 `nexgent run "任务"` 共用新的组织服务。
负责人按任务选择或临时创建成员并分派工作，无依赖成员并行工作，有依赖成员使用前序成果；必要时互评，负责人汇总。独立评价产生反馈，改进者
可修改成员和工作规则。候选重跑并通过开发门控后保存，后续任务自动加载。
多轮对话、成果、运行过程、评价与组织版本保存在工作区。用户可以续聊修改已有成果。
Main 顶部可切换已保存的对话；CLI 用 `run-list` 查找任务或对话ID，`run-show RUN_ID`
读取成果、评价和该任务的全部用户反馈，这些查看操作不调用模型。

```bash
nexgent run "根据给定材料完成任务"
nexgent-gui
```

配置沿用 `models.json` 和 `.env`。CLI 的 `--root` / GUI 的 `--project` 指定工作区；
`--model-root` 可从另一目录读取模型配置。详见[组织闭环说明](docs/organization-loop.md)。
当前成员支持分析、写作、项目文件读取、公开网页资料读取、CSV SQL 计算、受限 Python 算法执行和成果文件生成。网页读取复用 requests 与 Beautiful Soup，返回实际来源 URL、标题和可分页正文；支持 HTML、文本与 JSON。工具复用现有 ToolRegistry 和 AgentPackage 进程执行器；Main 与 CLI 使用同一执行循环，评价读取实际工具证据；未通过时自动修订一次并按原要求复验，保留草稿与修订成果。Python 支持内置数据结构与 math，不支持导入库、文件或网络操作。外部应用操作尚未接入。

交付后可在 Main 输入意见并点击“提交本轮反馈”，或使用 `nexgent feedback RUN_ID "反馈内容"`。反馈持久保存，同对话后续任务会参考意见，改进者还会结合历史反馈提出可复用修改；反馈本身不会直接改写组织，候选仍须试跑并通过门控。

要立即依据反馈改进，可点击 Main 的“按反馈改进组织”（输入框的意见会先保存），
或执行 `nexgent learn RUN_ID`。系统按原任务的输入、上下文和验收要求重新运行，
比较当前组织与候选，并在存在不同历史任务时检查回归。每项比较都必须满足质量和
成本限制，至少一项有实测改善才可采纳；新组织用于后续任务。学习是新的运行记录，
原任务和成果保留；Main 显示当前及历史任务的调用比较与门控结论。

模型连接失败或停止后，可点击 Main 的“恢复未完成任务”，或执行 `nexgent run-resume RUN_ID`。恢复沿用任务和验收要求，复用已完成成员的成果，继续未完成的分工；中断前用量仍计入整轮成本。旧研究入口的 `resume STUDY_ID` 保留。
长期组织修改还须由独立评价确认角色和工作规则可用于后续不同任务，不能把本次主题、答案或文件名保存为通用角色。本阶段门控是开发复评，不构成 held-out 或通用 RSI 收益证明。

## PR #1 的历史资产与缺口

下列记录描述旧内核路径。旧 `task` / `rsi-*` 命令和高级控制台保留，
不再是默认 Main 的实现，也不能把其历史“测试通过”当作当前分支的验收。

以 `4722cf7` 为本次计划的实现基线。已有工程资产包括 TaskService、AgentPackage manifest v2、ExecutablePlan、工件与调用账本、停止恢复、benchmark SDK，以及候选选择／晋升／回滚控制面。

| 能力 | 当前证据 | 尚未完成 |
| --- | --- | --- |
| 普通任务与编排 | Main 使用任务时规划包；真实 MiMo 设计并完成过一个 7 节点、多角色 DAG；确定性测试覆盖反馈修订与恢复 | 真实任务内反馈后的第二次改图、可替换执行循环和稳定自主协作 |
| 任务内技能 | 模型真实生成并修复过可运行技能；代码由手工诊断子任务验证；确定性测试覆盖自主委派 | 真实父任务自主创建、调用并交付；通用工具／插件开发不能由受限技能代替 |
| 工具／插件内核 | ToolRegistry 加载已安装宿主工具 | 模型开发、试装和发现新的工具／服务插件；隔离执行与生命周期 |
| 跨任务更新 | 普通 Main／CLI 可由项目策略自动触发反馈、模型规划、候选与独立配对；首次 MiMo 普通入口候选被正确拒绝；确定性测试覆盖晋升、guard 与复用 | 真实模型晋升后的 guard／跨任务复用、净收益和 O/S/M 一致版本组合 |
| 递归与研究 | R0/R1 后代比较、guard 和 study 服务有确定性机制 | 真实递归效用、正式多任务族研究 |
| 界面与 demo | Main 与高级任务／证据窗口；独立 OpenFOAM Re=10 smoke 真实跑通 | 持久多轮与附件、插件／能力视图及 RSI Lab 的完整运行接入 |

真实 MiMo v2.6-flash 已从普通任务自动走到公开反馈、模型规划、编排候选和独立 selection；该候选被拒绝。先前 O/S 资格 selection 未达到晋升门，纯 M 尝试 abstain；任务自建 planner 的真实探针也未成功编译新图。**当前没有正向 RSI 或递归收益证据。**

旧 Main 在未配置自动进化的项目中使用 `nexgent-main-capabilities-v2` 包 channel，初始版本为 `self_orchestration_package()`。这些通道属于旧内核；新的默认 Main 使用独立的组织版本。底层 `TaskService.create()` 未指定包时仍使用兼容默认。内核当前不支持模型直接热装宿主插件，受限 Python worker 也不等同于 OS 容器。

## 实施与阅读入口

当前实现与运行说明优先看 [Main 组织闭环](docs/organization-loop.md)。以下设计与研究链接保留历史背景，尚未实现的目标不代表当前产品能力。

- [仓库计划](REFACTOR_PLAN.md)：当前基线、每阶段交付／验收、迁移、协作及立即执行队列。
- [RSI 能力内核](docs/design/rsi-capability-kernel.md)：目标对象、插件开发、执行策略、证据和信任边界；不是当前能力声明。
- [产品决策](docs/design/product-and-refactor-decision.md)：通用框架、独立 demo 和 Main 入口的不变要求。
- [普通任务自动改进配置](docs/guides/ordinary-auto-evolution.md)与[首次真实负结果](experiments/ordinary_feedback_live/RESULTS.md)：项目级评价策略、实际入口和证据边界。
- [架构导航](docs/architecture.md)：当前目标与已有 0.9 合同的关系。
- [研究索引](docs/research/README.md)：方法来源、实际探针、失败记录与历史研究。
- [真实自编排／技能探针](docs/research/task-time-self-orchestration-live-20260923.md)、[候选资格结果](experiments/orchestration_qualification/RESULTS.md)、[记忆资格结果](experiments/memory_qualification/README.md)：成功、失败与缺测各自的结论边界。
- [OpenFOAM 真实 smoke](docs/demos/openfoam-smoke-validation-20260920.md)：求解器与插件执行证据，不证明模型或 RSI 效益。
- [旧 P0–P5 计划快照](docs/history/refactor-plan-p0-p5-20260923.md)：保存历史交付状态，不定义当前进度。

## 0.9 安装与任务入口

Python 3.11+；本机使用独立 Python 3.12 环境。Windows 使用本项目解释器，避免其他项目的 Qt/Conda 动态库混用。

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e '.[dev]'

# 选择安装所需 demo / benchmark
.venv\Scripts\python.exe -m pip install -e benchmarks/workbench
.venv\Scripts\python.exe -m pip install -e benchmarks/openfoam
.venv\Scripts\python.exe -m pip install -e benchmarks/scientific_discovery
.venv\Scripts\python.exe -m pip install -e benchmarks/bbh
.venv\Scripts\nexgent-bbh-download.exe --destination .nexgent/benchmarks/bbh

.\start.ps1
# 任务工作区和模型配置可以使用不同目录
.\start.ps1 -Project ./my-project -ModelRoot ./configured-models
```

本机环境、workbench、openfoam、scientific_discovery、BBH 四项插件和 BBH 数据已准备。模型读取被 Git 忽略的 `models.json` / `.env`；示例见 [models.example.json](models.example.json) 和 [.env.example](.env.example)。凭证留在模型请求宿主，不进入智能体源码进程。

`nexgent gui` 和 `nexgent-gui` 默认打开 Main。自然语言任务经组织服务执行、评价、
修订与改进；已通过评价的成果立即展示，用户无需等完组织候选比较。
CLI 用同一个服务：

```powershell
.venv\Scripts\python.exe -m nexgent --root ./my-project run "读取 sales.csv，生成销售汇总报告 report.md"
.venv\Scripts\python.exe -m nexgent --root ./my-project run "修改上一份报告，补充说明" --conversation CONVERSATION_ID
```

组织主线只需模型配置，不要求先安装 benchmark 或设置旧通道策略。

### 保留的高级内核入口

以下 `task` / `rsi-*` 命令使用旧内核；`--task-console` 打开对应高级界面。
其自动进化配置见[旧项目配置指南](docs/guides/ordinary-auto-evolution.md)。

```powershell
# 默认创建后执行；--input 接受内联 JSON、JSON 文件路径或 @file
.venv\Scripts\python.exe -m nexgent task "整理输入资料并交付结果" --input inputs.json
.venv\Scripts\python.exe -m nexgent task "只登记" --register-only --max-calls 4 --max-completion-tokens 12000

.venv\Scripts\python.exe -m nexgent task-list
.venv\Scripts\python.exe -m nexgent task-show EPISODE_ID
.venv\Scripts\python.exe -m nexgent task-resume EPISODE_ID
.venv\Scripts\python.exe -m nexgent task-export EPISODE_ID --output delivery.json

# 让普通任务或 benchmark 使用通道当前已晋升包；不能同时传 --package
.venv\Scripts\python.exe -m nexgent task "执行后续任务" --package-channel general
.venv\Scripts\python.exe -m nexgent task-benchmark workbench --split selection --seed 19 --package-channel general

# 只读查看通道当前版本与字段过滤后的审计事件
.venv\Scripts\python.exe -m nexgent rsi-status general
.venv\Scripts\python.exe -m nexgent rsi-events general --limit 50
.venv\Scripts\python.exe -m nexgent rsi-improver-status recursive
.venv\Scripts\python.exe -m nexgent rsi-improver-events recursive --limit 50
.venv\Scripts\python.exe -m nexgent rsi-study-list --limit 20

# 显式、分阶段执行 P3 闭环；每一步输出下一步所需的不可变 ID/digest
.venv\Scripts\python.exe -m nexgent rsi-register general --package parent-package.json
.venv\Scripts\python.exe -m nexgent rsi-feedback general EPISODE_ID --expected-revision 0
# 默认 reference R0 根据父包自动选择 legacy path v1 或 manifest component v2 合同
.venv\Scripts\python.exe -m nexgent rsi-generate general FEEDBACK_ID --mutation-policy examples/rsi/reference-os-mutation-policy.json --expected-revision 0
# 可选：显式冻结包，或从独立 R channel 解析已部署版本
.venv\Scripts\python.exe -m nexgent rsi-generate general FEEDBACK_ID --improver-package improver.json --mutation-policy mutation-policy.json --expected-revision 0
.venv\Scripts\python.exe -m nexgent rsi-generate general FEEDBACK_ID --improver-channel recursive --expected-improver-revision 0 --mutation-policy mutation-policy.json --expected-revision 0
.venv\Scripts\python.exe -m nexgent rsi-plan CANDIDATE_ID workbench --split selection --seed 19 --policy promotion-policy.json
.venv\Scripts\python.exe -m nexgent rsi-run-plan PLAN_ID workbench
.venv\Scripts\python.exe -m nexgent rsi-assess TRIAL_ID
.venv\Scripts\python.exe -m nexgent rsi-plan-monitor CANDIDATE_ID workbench --split guard --seed 23
.venv\Scripts\python.exe -m nexgent rsi-promote CANDIDATE_ID DECISION_ID MONITOR_PLAN_ID
.venv\Scripts\python.exe -m nexgent rsi-run-monitor general workbench
.venv\Scripts\python.exe -m nexgent rsi-monitor general GUARD_EPISODE_ID

# 产品化 cycle：一次冻结并推进同样的 feedback→selection→promotion→guard 门控
.venv\Scripts\python.exe -m nexgent rsi-cycle-start general workbench DEVELOPMENT_EPISODE_ID --expected-revision 0 --mutation-policy examples/rsi/reference-os-mutation-policy.json
# 可选：让已部署的递归改进器 R 承担本轮候选生成，并冻结其 revision
.venv\Scripts\python.exe -m nexgent rsi-cycle-start general workbench DEVELOPMENT_EPISODE_ID --expected-revision 0 --improver-channel recursive --expected-improver-revision 0 --mutation-policy mutation-policy.json
.venv\Scripts\python.exe -m nexgent rsi-cycle-show RSI_CYCLE_ID
.venv\Scripts\python.exe -m nexgent rsi-cycle-resume RSI_CYCLE_ID

# P4 可恢复递归改进器 cycle；spec 冻结 R/A0、feedback、任务集、预算、模型和门槛
.venv\Scripts\python.exe -m nexgent rsi-improver-cycle-start workbench --spec recursive-cycle.json --register-only
.venv\Scripts\python.exe -m nexgent rsi-improver-cycle-resume RECURSIVE_CYCLE_ID workbench
.venv\Scripts\python.exe -m nexgent rsi-improver-cycle-show RECURSIVE_CYCLE_ID workbench
.venv\Scripts\python.exe -m nexgent rsi-improver-cycle-recover RECURSIVE_CYCLE_ID workbench

# workbench 是 P1 的纯 Python 可选插件；此命令仍会使用配置的模型供应商
.venv\Scripts\python.exe -m nexgent task-benchmark workbench --split development --seed 0 --max-calls 20

# OpenFOAM 插件目前只接受冻结的 smoke/seed=0/Re=10 场景；需要本机 Foundation 8
.venv\Scripts\python.exe -m nexgent task-benchmark openfoam_cavity --split smoke --seed 0 --max-calls 20

# 打开保留的 0.8 研究窗口
.venv\Scripts\python.exe -m nexgent gui --legacy-research
```

`--capability` 可重复授予已安装工具；`--package` 接受 AgentPackage JSON，`--package-channel` 在任务创建时原子解析当前 active 包，两者互斥。预算选项包括 `--max-calls`、`--max-completion-tokens`、`--max-tool-calls`、`--max-tool-work-units` 和 `--max-nodes`。没有传入时使用运行器的有界默认值；工具工作量默认上限为 0，使用带正预留的数值或外部工具时必须显式授权。输入、包和任务合同无效时，命令会在执行前失败。

工具可在输入 JSON Schema 中用 `x-nexgent-artifact-ref: true` 声明工件引用。运行器只接受宿主提供或先前动作实际返回的 `artifact-…` 身份，并在调用工具前核验该工件对当前 Episode 可见；`pending` 等占位符会以协议错误失败，且不会消耗工具调用预算。这个合同属于通用核心，Workbench 与 OpenFOAM 只是使用它的独立插件。

正式 final-holdout 比较使用 `rsi-study-plan` 冻结两个包、宿主私有 benchmark snapshot、显式统计单位/来源 cluster、seed、provider/model revision、执行环境、完整预算与统计政策，再依次执行 `rsi-study-run` 和 `rsi-study-assess`。统计检验按独立 cluster 聚合；模型供应商只返回滚动别名时，报告保持时间窗口内的 benchmark 局部结论。`rsi-study-list` 与 GUI 只显示脱敏摘要。当前没有外部多任务族正式结果；确定性 study pilot 只验证研究控制面。

内置 reference R0 是通用改进器，不包含科学发现、OpenFOAM 或任何 benchmark 的答案与评分逻辑。它用独立 `execute` 入口规划公开反馈，用 `improve` 入口按宿主归一化的 `mutation_policy.targeting` 选择旧 BehaviorPatch v1/v2 或多组件 PackagePatch v3；v3 允许 O/S 多文件与注册表 add/replace/remove，模型只需交付更紧凑的注册表差量，R0 据冻结父 manifest 组装完整子包提案，宿主重新构造并校验。旧 v1/v2 保持原单文件约束。模型返回 abstain、非法 patch、调用失败或预算耗尽时，generation 持久记录为 missing。手动 `rsi-generate` 不会单独部署候选；配置了自动进化的普通任务则由宿主继续进行 selection、晋升与 guard。真实 MiMo v2.6-flash 的首次普通入口样本在 selection 被拒绝，见[运行收据](experiments/ordinary_feedback_live/RESULTS.md)。

P3 的每个写操作都有独立 CLI 和 Python API。P4 既保留显式服务 API，也提供 `rsi-improver-cycle-start/resume/show/recover`；cycle 仍逐步形成 meta feedback、R self-generation、meta trial/decision、guard plan 和 promotion，不能跳过门控。GUI 的“RSI 与版本”页保持只读。`rsi-*` 输出不暴露 AgentPackage 源文件、私有任务内容或 evaluator 实现。操作顺序见[运行与恢复](docs/operations.md)，完整合同见[P3 控制面设计](docs/design/p3-feedback-evolution-control-plane.md)与[P4 递归控制面](docs/design/p4-recursive-improver-control-plane.md)。

`RSICycleService` 把一次任务智能体改进的 feedback、generation、paired selection、guard plan、promotion 与 monitor 串成持久状态机。CLI 提供 `rsi-cycle-start/resume/show/recover`，默认使用内置参考 R0，也可冻结并执行独立 R channel 的指定 revision；信息窗口可按 cycle ID 查看脱敏状态。R channel 在 Episode 创建前和真正启动前都会重新核验，漂移时不会发起模型调用。它减少调用方手工传递记录 ID，但不会跳过独立评价或自动放宽晋升条件；硬中断中无法确定外部动作是否提交时会进入 `recovery_required`，CLI 返回非零。合同见[可恢复 RSI Cycle 服务](docs/design/rsi-cycle-service.md)。

## 保留的 0.8 benchmark 与源码研究接口

```powershell
.venv\Scripts\python.exe -m nexgent benchmarks

# 固定程序跑 benchmark；省略 --program 时使用插件的强基线，不执行 improve
.venv\Scripts\python.exe -m nexgent evaluate --benchmark bbh --seeds 101 202
.venv\Scripts\python.exe -m nexgent evaluate --benchmark scientific_discovery --seeds 101

# 通用研究程序在指定 benchmark 上演化
.venv\Scripts\python.exe -m nexgent research '改善实际后代效用与研究组织' --benchmark scientific_discovery --generations 2 --seed 43
.venv\Scripts\python.exe -m nexgent research '检验程序改进与成本' --benchmark bbh --generations 2 --seed 43

# 冻结两版实际改进器，从相同任务起点生成后代
.venv\Scripts\python.exe -m nexgent meta-evaluate STUDY_ID --seeds 401 502 --k 1

# 将两版改进器迁到另一 benchmark 的共同任务起点
.venv\Scripts\python.exe -m nexgent meta-evaluate STUDY_ID --benchmark bbh --seeds 401 --k 1

.venv\Scripts\python.exe -m nexgent list
.venv\Scripts\python.exe -m nexgent show STUDY_ID
.venv\Scripts\python.exe -m nexgent resume STUDY_ID
.venv\Scripts\python.exe -m nexgent export STUDY_ID
```

`full` 允许全部源码演化并探索档案；`task_only` 冻结非任务文件；`greedy` 仍允许全部文件变化，但只扩展当前部署程序。没有不同可执行改进器时，不付费比较同一程序的两次随机抽样。

## 0.8 已实现的源码自修改循环

源码包包含 `task.py`、`meta.py` 和可选 `workflow.py`、`roles.json`。算法、函数、控制流、角色分工及父代选择均可修改，不从固定策略表选参数；模型权重保持固定。

初始通用研究程序读取领域合同、自身源码、实际开发结果和有来源的失败。遇到停滞时，可以提出改进程序变更，通过 `broker.probe_improver` 从共同任务起点实际运行参考/候选 `improve`、生成并评价后代，再使用开发证据继续研究。每次外层执行最多一次探测，内层不能再次探测，所有请求与实验计入同一账本。

探测后再修改的改进程序不能继承旧测量的效力。源码自述与宿主核实的证据状态分开。部署冠军和探索版本分别保存，未晋升的改进程序仍可被后代实际执行。

独立评测冻结两版改进器，保持共同任务起点与预算；开发选择后才打开迁移数据。跨 benchmark 迁移替换任务基线和领域合同，保留被测改进器源码。这检验具体程序、任务分布和预算下的能力，不自动证明通用或持续加速的 RSI。

## 0.8 benchmark 接口

插件实现 [Benchmark 合同](src/nexgent/benchmarks/__init__.py)：`spec` 声明领域、任务合同、工具 API、工具类入口与成本单位；`initial_files()` 提供任务基线；`research_context()` 只提供公开领域信息；`snapshot()` 冻结源码/依赖/数据版本；`evaluate(...)` 使用传入运行器执行源码，由宿主持有答案和评分。scientific-discovery 的这一 legacy 入口仍保留；其 canonical 入口把每个 synthetic case 作为一个 `TaskSpec`/Episode，并以项目私有 release key 的 HMAC 派生隐藏生成 seed 和不透明来源 cluster。历史 confirmation 分布虽在 canonical API 中命名为 `final_holdout`，但只供迁移 regression/golden 检查，不构成新的研究证据；固定 reference AgentPackage 只是无模型 control。

参考：[科学发现插件](benchmarks/scientific_discovery/README.md)、[BBH 插件](benchmarks/bbh/README.md)。BBH 仅覆盖 boolean_expressions 和 word_sorting，不称为完整 23 任务成绩。

## 0.8 历史证据与结论边界

0.8 基线通过 282 项本地检查，配置 Windows/Ubuntu × Python 3.11/3.12 四项 CI（[当前检查](https://github.com/csxq0605/Nexgent/pull/1/checks)）；独立核心安装无需科学依赖，也能运行窗口和通用源码。实际模型研究、两个插件的独立改进器比较与完整成本见 [框架验证报告](docs/research/framework-validation-20260916.md)。

本轮先后登记的两次机制 pilot 与独立比较共 44 次模型请求。原轮观察到改变后的改进器继承执行，同时暴露并修复了长查询接口缺陷。修复轮的独立比较实际生成并评测 5 个任务后代，3 个配对效应均为 0；**尚无改进器能力增强的证据**。错误父代选择、未通过源码准入的提议和无效修订均保留，不能用源码 diff 或生成槽位数代替成功后代。

六组科学 demo 研究和 36 次独立确认全部保留。一个任务程序获得确认平均增益 +0.012351；两个 full 组均未改变改进程序，**该批没有建立改进器能力增强的证据**。这些反例用于后续机制设计，不能改称框架已完成 RSI 验收。

官方 BBH 两任务固定强基线通过 500/500 例，0 模型调用。这验证接入、实际执行与评分，也说明准确率已饱和；它不是演化成果。

执行边界为能力受限 Python、独立进程、审计钩子和内存/指令/工具/请求预算，不是完整操作系统容器。领域工作单位只在同一 benchmark 内解释；模型 tokens、缓存与实际工作分别记录。停止和缺测保留收据，不自动重试付费请求。

## 开发与研究材料

安装 workbench、openfoam、scientific_discovery 和 BBH 四项插件后运行 `.venv\Scripts\python.exe -m pytest tests -q`。默认测试验证 OpenFOAM 插件合同并使用模拟进程；真实求解器测试必须显式设置 `NEXGENT_OPENFOAM_REAL_TEST=1`，且只在已配置的 Foundation 8 环境运行。

- [分阶段协作计划与 PR](REFACTOR_PLAN.md)
- [当前设计与历史实现的架构入口](docs/architecture.md)
- [RSI 一手文献与实现判断](docs/research/reboot-rsi-mechanisms.md)
- [P3 反馈演化控制面](docs/design/p3-feedback-evolution-control-plane.md)
- [P3 跨任务 RSI 研究设计](docs/research/p3-cross-task-rsi-design-20260920.md)
- [RSI orchestration research refresh](docs/research/rsi-orchestration-refresh-20260921.md)
- [源码机制审查和探测设计](docs/research/source-mechanism-review-20260916.md)
- [六组科学 demo 完整结果](docs/research/source-batch-results-20260916.md)
- [通用框架的真实机制验证与交付](docs/research/framework-validation-20260916.md)
- [v1 源码机制审查](docs/research/framework-mechanism-v1-review.md)、[v2 源码机制审查](docs/research/framework-mechanism-v2-review.md)
- [源码、配对数据与确认收据](docs/research/source-batch-evidence-20260916.json)
- [运行与恢复](docs/operations.md)

```text
src/nexgent/                      通用 RSI 核心、P3 包演化控制面与信息窗口
benchmarks/workbench/             P1 工件式数据核对任务与 benchmark 插件
benchmarks/openfoam/              P2 Foundation 8 方腔 smoke 插件
benchmarks/scientific_discovery/   独立科学发现 demo 包
benchmarks/bbh/                    独立公开 benchmark 包
tests/                            核心合同、继承、账本及插件验证
docs/research/                    文献、预登记、结果及失败分析
```

旧产品保留在 Git 历史及本机仓库外快照。vNext 重构继续使用同一个 Draft PR，按阶段更新实际完成状态。
