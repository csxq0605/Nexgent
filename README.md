# Nexgent 0.9

**通用 RSI 智能体框架：自主组织任务执行，从反馈中改进技能、协作和工作方式，并能运行 benchmark 检验效果。**

Nexgent 本身是产品。科学发现与 OpenFOAM 是独立 demo，领域工具、任务、数据和评分不能进入核心。OpenFOAM 不成为框架的默认任务定义；同一核心必须能执行非 CFD 任务与 benchmark。

## 定位与当前状态

0.9 完成了 P1 的任务执行、交付评审与恢复基础及产品入口整合，并实现了首个独立 P2 OpenFOAM smoke demo。普通目标和 benchmark 共享 `TaskService`，使用版本化 `AgentPackage`、受限模型/技能/工具能力、显式工件、执行节点、记忆快照、预算、停止恢复和可导出证据。默认 GUI 是任务空间；0.8 研究窗口和原有 CLI 命令继续保留。

P1 已由确定性网关、工具和 benchmark 双件测试覆盖，并会运行真实受限子进程。它建立了后续 RSI 所需的可执行、可评审、可追踪和可恢复底座，**还没有实现跨任务候选生成、独立晋升门、自动回滚或改进策略自身更新**。真实 Provider 验证已经执行：MiMo 跑通模型、usage、工具、重复阻断与恢复入口，但在 30 次模型调用后耗尽预算且没有交付；Qwen 因账户欠费被供应商拒绝，Gemini 最小探针连接失败。仓库不把这些失败记录或 P2 求解器运行写成真实模型任务成功。

| 内容 | 状态 |
| --- | --- |
| P1 通用任务运行器、AgentPackage、交付评审、工具/技能、工件、记忆、预算和恢复 | 0.9 基础已实现并通过确定性合同测试；真实 Provider episode 已运行但未形成可验收交付 |
| P1 普通任务与独立 workbench benchmark 的统一入口 | 0.9 已接入 CLI、默认 GUI 和插件合同 |
| P2 OpenFOAM 方腔 demo | 独立插件与 Re=10、20×20×1 smoke 已实现；真实 WSL2/Foundation 8 求解、U/p 解析、固定无模型 TaskService 受控恢复和隐藏评价已通过 |
| P3 跨任务行为更新 | 待实现与检验 |
| P4 改进过程可更新与递归执行 | 待实现与检验 |
| P5 冻结研究和完整产品验收 | 待实现与检验 |
| 0.8 源码执行、自修改、历史 benchmark 与研究窗口 | 保留；其证据不替代 0.9 P1 或 P2–P5 验收 |

### 设计阅读入口

- [定位与重构决策](docs/design/product-and-refactor-decision.md)：固定用户不变要求和框架边界。
- [vNext 智能体架构](docs/design/agent-architecture-vnext.md)：真实任务执行、技能/编排/记忆和反馈驱动更新。
- [论文方法到设计与实验](docs/research/agent-orchestration-rsi-synthesis-20260916.md)：AutoSci、ADAS、AFlow、DGM、Hyperagents、STOP 的采用方式与边界。
- [P1 真实 Provider 验证](docs/research/task-runtime-validation-20260920.md)：实际 episode、token 与节点用量、供应商失败、重复调用阻断和未通过项。
- [OpenFOAM 独立 demo](docs/demos/openfoam-cfd-design.md)、[本机环境](docs/demos/openfoam-environment-20260916.md)、[真实 smoke 验证](docs/demos/openfoam-smoke-validation-20260920.md)与[机器可读收据摘要](docs/demos/openfoam-smoke-receipt-20260920.json)：任务设计、版本适配、实际执行证据和结论边界。
- [分阶段重构计划](REFACTOR_PLAN.md)：依赖、责任和验收条件。

### 当前 0.9 P1 执行路径

```mermaid
flowchart LR
    T[普通任务 / Benchmark 任务] --> S[TaskService]
    S --> P[版本化 AgentPackage]
    P --> C[模型 / 技能 / 授权工具 / 委派]
    C --> A[工件、节点、收据与记忆]
    A --> O[交付与验收状态]
    D[可选领域插件] --> C
    O --> B[独立 Benchmark 评价]
```

任务窗口展示目标、节点、交付物、失败、调用收据和记忆版本。跨任务行为更新与递归改进属于 P3–P4，未包含在 P1 完成状态中。

### 从任务底座到 RSI

后续自进化的对象是版本化智能体行为，而不是宿主评价器或领域答案：任务编排与角色交接、技能实现和提示协议、记忆写入与检索策略，以及用于诊断和产生改进的策略。真实任务的交付质量、独立 benchmark 分数、评审缺陷、工具错误、恢复结果、回归和资源成本共同构成反馈；代理自评只能作为其中一项有来源的信号。

闭环需要依次留下可核查证据：失败归因形成修改假设；从已冻结父版本生成候选 `AgentPackage`；在隔离的开发任务上执行候选；以独立评价和成本/安全回归作为晋升门；只有通过门控的版本才进入后续任务。未通过的候选保留证据但不部署；已部署版本若在监测任务中退化，则恢复到上一已通过版本。P1 目前提供包身份、谱系、任务轨迹和恢复语义，候选生成、门控、晋升和回滚由 P3–P4 实现。

这个边界来自[编排与 RSI 研究综合](docs/research/agent-orchestration-rsi-synthesis-20260916.md)：持久化、实际执行和有效必须分别检查，且“失败证据 → 候选变化 → 验证 → 后续实际加载 → 结果”缺一不可。0.8 的[框架验证](docs/research/framework-validation-20260916.md)、[v1 机制审查](docs/research/framework-mechanism-v1-review.md)和[v2 机制审查](docs/research/framework-mechanism-v2-review.md)记录过机制未激活、契约错误和实际后代零增益，因此源码变化、记忆写入或候选数量都不能单独作为 RSI 成功证据。P1 实跑记录格式见[任务运行时验证模板](docs/research/task-runtime-validation-20260920.md)。

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
```

本机环境、workbench、openfoam、scientific_discovery、BBH 四项插件和 BBH 数据已准备。模型读取被 Git 忽略的 `models.json` / `.env`；示例见 [models.example.json](models.example.json) 和 [.env.example](.env.example)。凭证留在模型请求宿主，不进入智能体源码进程。

`nexgent gui` 和 `nexgent-gui` 默认打开任务空间。任务创建、恢复、查看和导出使用同一个 `.nexgent` 持久存储：

```powershell
# 默认创建后执行；--input 接受内联 JSON、JSON 文件路径或 @file
.venv\Scripts\python.exe -m nexgent task "整理输入资料并交付结果" --input inputs.json
.venv\Scripts\python.exe -m nexgent task "只登记" --register-only --max-calls 4 --max-completion-tokens 12000

.venv\Scripts\python.exe -m nexgent task-list
.venv\Scripts\python.exe -m nexgent task-show EPISODE_ID
.venv\Scripts\python.exe -m nexgent task-resume EPISODE_ID
.venv\Scripts\python.exe -m nexgent task-export EPISODE_ID --output delivery.json

# workbench 是 P1 的纯 Python 可选插件；此命令仍会使用配置的模型供应商
.venv\Scripts\python.exe -m nexgent task-benchmark workbench --split development --seed 0 --max-calls 20

# OpenFOAM 插件目前只接受冻结的 smoke/seed=0/Re=10 场景；需要本机 Foundation 8
.venv\Scripts\python.exe -m nexgent task-benchmark openfoam_cavity --split smoke --seed 0 --max-calls 20

# 打开保留的 0.8 研究窗口
.venv\Scripts\python.exe -m nexgent gui --legacy-research
```

`--capability` 可重复授予已安装工具；`--package` 接受 AgentPackage JSON。预算选项包括 `--max-calls`、`--max-completion-tokens`、`--max-tool-calls` 和 `--max-nodes`。没有传入时使用运行器的有界默认值。输入、包和任务合同无效时，命令会在执行前失败。

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

插件实现 [Benchmark 合同](src/nexgent/benchmarks/__init__.py)：`spec` 声明领域、任务合同、工具 API、工具类入口与成本单位；`initial_files()` 提供任务基线；`research_context()` 只提供公开领域信息；`snapshot()` 冻结源码/依赖/数据版本；`evaluate(...)` 使用传入运行器执行源码，由宿主持有答案和评分。

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
- [源码机制审查和探测设计](docs/research/source-mechanism-review-20260916.md)
- [六组科学 demo 完整结果](docs/research/source-batch-results-20260916.md)
- [通用框架的真实机制验证与交付](docs/research/framework-validation-20260916.md)
- [v1 源码机制审查](docs/research/framework-mechanism-v1-review.md)、[v2 源码机制审查](docs/research/framework-mechanism-v2-review.md)
- [源码、配对数据与确认收据](docs/research/source-batch-evidence-20260916.json)
- [运行与恢复](docs/operations.md)

```text
src/nexgent/                      通用 RSI 核心与信息窗口
benchmarks/workbench/             P1 工件式数据核对任务与 benchmark 插件
benchmarks/openfoam/              P2 Foundation 8 方腔 smoke 插件
benchmarks/scientific_discovery/   独立科学发现 demo 包
benchmarks/bbh/                    独立公开 benchmark 包
tests/                            核心合同、继承、账本及插件验证
docs/research/                    文献、预登记、结果及失败分析
```

旧产品保留在 Git 历史及本机仓库外快照。vNext 重构继续使用同一个 Draft PR，按阶段更新实际完成状态。
