# Nexgent vNext 重构计划

日期：2026-09-21。状态：P0 设计已固定；P1 任务执行、交付评审与恢复基础已落地并通过确定性合同测试，真实 MiMo 普通任务已形成 schema 合法交付但独立 Workbench 仍失败；P2 独立 OpenFOAM Re=10 smoke 已实现并在真实 WSL2/Foundation 8 环境通过；P3 反馈驱动包演化控制面及内置参考 R0、P4 递归改进器确定性机制闭环已实现；P5 已实现通用预注册 final-holdout 配对执行器。真实 RSI 行为变化、统计效益与正式外部研究尚未建立。

## 1. 产品与执行范围

唯一产品是 **通用 RSI 智能体框架 Nexgent**。它应能组织智能体完成普通任务，并通过独立 benchmark 检验任务能力、持久改进和递归效用。科学发现与 OpenFOAM 都是可选插件/场景；核心不能依赖 CFD 方程、求解器、case、论文五阶段流程或某个 demo 的评分。

当前实现阶段仍遵守该产品边界。定位依据见[设计决策](docs/design/product-and-refactor-decision.md)，接口和执行模型见[架构](docs/design/agent-architecture-vnext.md)，P3 的现行合同见[反馈演化控制面](docs/design/p3-feedback-evolution-control-plane.md)，研究依据与冻结实验见[P3 跨任务 RSI 设计](docs/research/p3-cross-task-rsi-design-20260920.md)。

## 2. 对旧完成判断的修正

此前的“整体重构已完成”仅有源码基础设施、插件解耦、信息窗口和有限机制试验的证据，不能代表用户要求的完整智能体架构已完成。当前应保留：

- 通用 benchmark 注册、实际进程执行、版本身份、模型代理、预算/停止恢复与原始证据；
- 科学与 BBH 插件的独立包装，以及全部正、负、缺测结果；
- 0.8 已验证的 282 项本地测试和四项跨平台 CI，但不将其转移为 vNext 已通过验证。

当前需要重构：四文件包约束、以代数/改源码为中心的控制器、固定初始研究链、仅靠宿主整理历史的记忆路径，以及只能展示这类运行的 UI 投影。具体逐模块判断见架构迁移表。

## 3. 协作责任与共享合同

| 工作线 | 责任 | P0 交付产物 | 下游 |
| --- | --- | --- | --- |
| 产品与整合 | 根代理 | 定位决策、本计划、README、文档入口、PR | 全部工作线 |
| 架构与内部审计 | 架构子智能体 | `docs/design/agent-architecture-vnext.md` | 运行器、编排、界面实现 |
| 外部方法与实验设计 | RSI 子智能体 | `docs/research/agent-orchestration-rsi-synthesis-20260916.md` | 改进方法与实验负责人 |
| 领域场景与环境 | 科学子智能体 | `docs/demos/openfoam-cfd-design.md`、环境记录 | 可选 CFD 插件与验证 |

先完成各自文档，再交叉核查：根代理检查通用边界和交付状态；架构负责人检查插件是否逼迫核心加入领域特例；方法负责人检查实验能否激活候选机制；领域负责人检查物理指标是否真实且可比较。共享对象及字段以架构文档为准；领域信息通过命名空间元数据与工件传递。

后续实现按文件归属分工，不由多名代理同时改同一模块。接口变更先更新合同，再由依赖方接入。子智能体的开发分工本身不计作 Nexgent 产品的多智能体能力。

## 4. 阶段、依赖与出口

### P0：定位、方法与可执行设计（已完成）

已交付定位决策、通用架构、论文到方法的对应、迁移范围、OpenFOAM demo 与只读环境核查，并修正旧文档中的完成状态和范围错误，保留历史结果。

出口已经满足：文档之间的对象和边界一致，现有能力、拟实现能力和未支持的研究假设分开陈述；该阶段历史提交保留在现有 Draft PR。

### P1：任务执行、交付评审与恢复基础（代码已实现，真实模型任务效果未通过）

依赖 P0。当前通用 AgentPackage 已能读取目标与输入，规划工作，调用模型、技能、工具和委派，交接工件，依据失败或交付评审继续修订并交付。普通任务和轻量非 CFD workbench benchmark 共用 `TaskService`；默认 GUI、CLI、持久存储和导出也已接入同一状态。

代码与确定性测试已经覆盖受限子进程、版本化多文件包、模型/工具节点、显式工件、当前记忆快照、树级共享预算、停止恢复、交付 schema 核验、包内 reviewer 修订和冻结 benchmark 评价。简单任务仍可走单体路径，不靠强制增加角色数制造协作证据。

真实 Provider 验证已经登记。Qwen `qwen3.8-flash` 的最小与 Workbench 请求均被阿里云以 400 `Arrearage` 拒绝，本机 Gemini provider 最小探针返回 `APIConnectionError`。MiMo `mimo-v2.5` 的旧 Workbench episode 在 30 次模型调用后失败；2026-09-21 的普通任务资格运行用 3 次调用完成 schema 合法交付，但新的 Workbench development episode 仍在 20 次调用后预算耗尽，评价不可用。完整记录见[验证记录](docs/research/task-runtime-validation-20260920.md)与[增量机器摘要](docs/research/task-runtime-validation-20260921.json)。

实现出口中的共享执行器、核心独立安装、真实状态窗口和受控失败恢复合同已经完成。实际 MiMo 轨迹现在证明普通任务的模型调用、任务内发布、reviewer 路径和 schema 合法交付能够闭合；Workbench 轨迹证明工具与失败反馈被激活，但没有在预算内完成工件验证或独立评价。受控失败恢复、benchmark 成功及反馈后的有效修订仍待验证。P1 的工程底座可供 P2/P3 开发使用，但不能写成完整 RSI 或已验证的自我改进效果。

### P2：独立 OpenFOAM demo 接入（Re=10 smoke 已完成）

依赖 P1。独立 `benchmarks/openfoam` 插件已经注册领域工具与隐藏评价器；核心只新增通用、根 episode 共享且路径受限的工具工作区，不包含 OpenFOAM 命令、Reynolds 数、压力单位、残差阈值或中心线评分。

已完成的冻结切片只有 `split=smoke, seed=0, cavity_re10`：插件从 Foundation 8 官方 cavity 模板做有界常规文件复制，在宿主管理目录内以固定参数运行 `blockMesh`、`checkMesh`、`icoFoam`，限制单命令时间和输出，解析 mesh、求解时间及最新 `U`/`p` 字段，并将交付物绑定到宿主 `run.json` 收据。隐藏评价器要求输入完整性、环境探针、准备、真实求解、公开 smoke 检查与最终验证收据全部匹配。

真实 WSL2 `Ubuntu-20.04` / OpenFOAM Foundation 8 运行已经通过 Re=10、20×20×1 smoke：三个程序实际退出成功，`checkMesh` 报告 `Mesh OK.` 和 400 cells，`icoFoam` 到达模板结束时间，最新 `U`/`p` 内部场可解析且有限，隐藏评价器接受与真实收据一致的交付。真实 `TaskService` 还用固定无模型 AgentPackage 完成了一次合成单次拒绝、重试、求解、工件校验与隐藏评价链。详细证据见[2026-09-20 验证记录](docs/demos/openfoam-smoke-validation-20260920.md)。这只是执行和结构 smoke 及框架恢复证据，不建立模型自主恢复、稳态、Ghia 精度、Re=100、网格/时间收敛、性能或 RSI 结论。

### P3：跨任务持久改进（控制面已实现，效果实验未完成）

依赖 P1。当前实现固定以下闭环：

```text
development Episode
  -> FeedbackBundle
  -> 独立且冻结的 improver R0
  -> BehaviorPatch（只允许 O/M/S）
  -> 不可变 child AgentPackage
  -> 预登记 paired selection + PromotionPolicy
  -> eligible decision
  -> 显式 CAS promotion + package channel
  -> 预登记 guard Episode
  -> monitor / rollback
```

`GenerationService` 只从本地、终态、明确标记为 development 且绑定当前 active 父包的 Episode 捕获有界反馈。独立版本化的 `R0` 通过同一 `TaskService` 运行，只能交付严格的声明式 `BehaviorPatch`；可信宿主验证可修改路径、O/M/S 分类、旧摘要、大小、激活探针和完整 child 包。`R0` 的 improve entry 与执行闭包在 P3 冻结，候选不得修改 evaluator、gate、权限、预算核算或宿主控制代码。

产品默认已经补入领域无关的 `reference-os-v1`，使 `rsi-generate` 无需外部 improver JSON 也能通过配置的模型执行真实 R0。其 v1 capability envelope 只允许一个现有 O/S 文件的单次 `replace`；M、多文件、add/remove 和控制面修改均拒绝。调用方仍可显式传入冻结 improver package，或以 improver channel + expected revision 使用 P4 部署版本。三种入口共享相同 receipt、admission 与 missing 语义。默认 R0 只生成候选，不自动 selection、promotion 或 guard，也不包含任何 demo/benchmark 专用逻辑。

`EvolutionService` 把 paired suite、benchmark/evaluator snapshot、父子顺序、预算、可重算的 execution environment/tool/runtime snapshot 及 PromotionPolicy 在结果产生前冻结。实际 provider/model 身份由逐调用 receipt 证明，并在正式实验中与预登记配置核对；当前计划记录本身不声称已预先完整冻结二者。development decision 不能晋升，final holdout 不能进入演化；selection 缺分、用量不完整、身份不一致和关键回归均 fail closed。选择门的 `cost` 是模型调用、charged completion tokens、工具调用和节点用量形成的 normalized work unit，不是供应商货币费用。eligible 与 promote 分开；只有 `GenerationService` 闭合真实 R0 生成收据的 candidate 有部署权限，受控导入只进入研究/archive；promote 还要求父包仍为 active，并强制绑定预登记 monitor plan。普通任务只在创建时通过 `package_channel` 解析部署包。guard plan 与阈值在晋升前冻结，其完整任务多重集只允许一次执行；缺项、重复项、usage 不完整或 evaluator receipt 不匹配均 fail closed，退化时沿已记录部署边回滚。

当前完成的是工程机制：不可变记录、hash-linked 事件、只读安全投影、普通任务的通道加载、内置参考 R0，以及一个以固定无模型 fixture 执行 feedback → generation → selection → promotion → new Episode → guard → rollback 的确定性闭环和脱敏证据导出。尚未完成的 P3 研究出口包括：内置或冻结 `R0` 从真实模型反馈产生有效候选、候选在独立 selection 上胜过父代、晋升后在新任务中激活所声称行为，以及由重复和对照支持的效应估计。候选未变好时必须报告 rejected/missing；不能把代码路径、模拟测试、candidate 数量、一次模型调用或一次部署写成 RSI 效益。

详细对象、接口和信任边界见[控制面设计](docs/design/p3-feedback-evolution-control-plane.md)。固定编排、匹配额外调用、只积累记忆与 P3 主机制的对照见[研究设计](docs/research/p3-cross-task-rsi-design-20260920.md)。

### P4：改进过程的可更新与递归执行（机制闭环已实现，效果实验未完成）

依赖 P3。当前实现为 R 建立独立 archive、channel 和 hash-linked event chain。active R 通过真实 `TaskService` self-update Episode 交付受限 `ImproverPatch`，形成直接子代；R0/R1 的元比较从同一 A0、同一 FeedbackBundle、相同 task mutation policy、空 memory 起点和等分总预算出发，实际调用 `GenerationService` 产生任务后代，再通过冻结 benchmark adapter 运行和评价。元效用只来自后代质量、成功率、回归与 charged work。

promotion 强制绑定预登记 improver guard。部署后的候选生成通过独立 improver channel 解析 R id/digest/revision，并在运行结束前复核通道未变化。guard 同样经该通道产生真实任务后代，完整覆盖冻结任务多重集；缺测、身份错误、usage 不全或效用低于阈值都 fail closed，并沿确切部署边 CAS rollback。

确定性 pilot 已闭合 `R0→R1`、R0/R1 后代 `0.4/0.8` 元比较、R1 channel 加载、`R1→R2` archive、自注册阈值 `0.9` 触发回滚，以及新 revision 通过 channel 再次实际加载 R0。该 fixture 不使用模型、网络或工具，只证明机制；真实 R 是否能从任务反馈产生更优改进策略仍未建立。

出口分两类：实现上证明新版本能够承担下一次改进任务；研究上比较两版改进策略实际产生后代的效用。前者不等于后者；无需强制每代修改 meta，宿主评分和预算边界保持固定。

### P5：冻结协议、独立研究与产品验收

依赖 P2–P4。通过开发试验选定问题、任务分布、资源和评价后注册正式研究；不得先看最终数据再回写阈值。

- 固定任务 agent、固定改进器的架构搜索、只积累记忆、完整系统和目标机制消融。
- 控制同一模型、任务信息和资源上限；记录实际 tokens、仿真工作和时间。额外调用不能自动归因于架构效果。
- 同起点比较候选；独立任务采用冻结版本并禁用写回，避免把测试反馈当下一次调参输入。
- OpenFOAM 场景变体用于 CFD 域内泛化；非 CFD benchmark 单独检验框架接入和行为迁移，二者不混称跨域。
- 检验任务质量、完成率、成本、失败恢复和退化；若声称递归提升，再补实际后代效用及跨域改进策略对照。

出口：完整任务系统可运行、独立插件成立、改进被后续执行使用；有报告支撑效果结论。结果可以为零或负，但不能以此掩盖未实现的能力，也不能将有限结果写成普适或加速增长的 RSI。

当前已实现 `RSIStudyService`：只接受 final holdout，冻结两个 AgentPackage、宿主私有 benchmark 注册、显式统计单位/来源 cluster、完整任务/seed、provider/model、执行环境摘要、每 Episode 硬预算、随机化调度、工程门和 cluster bootstrap/sign-flip 统计；每个 cell 通过真实 `TaskService` 执行，空 memory 且禁止写回，可恢复但不可选择性重放。模型收据区分请求别名与 provider 实际 model/revision；没有固定 revision 时只允许时间窗口内的局部工程结论。CLI 与 GUI 只投影脱敏计划和报告。它是正式研究的执行底座，不等于外部研究已完成。主矩阵至少需要一个工具/政策任务族、一个新鲜可执行代码任务族和一个私有自托管交互任务族；OpenFOAM 单列为 demo，Workbench/饱和 BBH 只做资格与接口检查。完整协议见[P5 预注册研究](docs/research/p5-preregistered-rsi-study.md)。

## 5. 当前状态

| 项目 | 状态 |
| --- | --- |
| 用户确认的框架定位与独立 demo 边界 | 固定要求 |
| vNext 定位、架构、研究综合、OpenFOAM 设计 | P0 已完成；设计中的正式数值研究仍未执行 |
| 本机 OpenFOAM | 已确认 WSL2 / Ubuntu 20.04 / Foundation 8，并真实运行 Re=10 教程 smoke |
| P1 任务执行、交付评审、工件/记忆、预算与恢复基础 | 0.9 已实现并通过确定性合同测试；真实 MiMo 普通任务交付已通过，Workbench 独立评价仍未形成 |
| OpenFOAM 插件及真实 demo P2 | 独立 smoke 插件已实现并真实通过；正式精度与收敛协议未执行 |
| 跨任务行为更新 P3 | feedback/R0/BehaviorPatch、内置 `reference-os-v1`、显式/通道 R、配对门控、显式晋升、通道加载、guard monitor 与回滚控制面已实现；真实模型独立效果与统计效益待检验 |
| 改进器递归执行 P4 | 独立 R 通道、自更新、真实任务后代元评测、guard/rollback 和恢复加载机制已闭合；真实模型行为与统计递归效益待检验 |
| 冻结正式研究 P5 | 通用 final-holdout 配对执行器、预注册 schema、CLI/信息窗已实现；外部多任务族正式研究待登记与执行 |
| 0.8 的源码机制与历史结果 | 保留；不能替代以上状态 |

### 下一阶段

1. **P1-V 后续真实运行验证**：在修正模型反复请求已完成工具的问题并设置新的冻结预算后，重新检验 normal 多步骤交付；只有 normal 能完成，才运行可隔离验证恢复假设的受控失败场景。保留已有失败 episode，不用重跑覆盖。
2. **P2 数值验证扩展**：在现有 smoke 之外，另行冻结 Re=100、独立参考、网格/时间收敛和稳态判据。没有这些证据时保持 smoke 结论，不把 20×20×1 Re=10 输出与 Ghia 数据比较。
3. **P3 真实行为与效果验证**：先以冻结的内置 `reference-os-v1` 作为可复现实验臂，再加入显式 R 与通道 R 对照；冻结任务序列、可验证执行环境/工具/运行时快照、预算、paired selection 和 guard policy；预登记目标 provider/model，并用逐调用 receipt 核验实际身份与参数；用真实 development 失败产生候选，报告全部 complete/missing generation、完整/缺测配对、行为激活、质量、normalized work unit、原始 usage、可得的实际货币费用和回归。即使没有候选通过也按预登记结束，不降低门槛追求正结果。
4. **P4 真实行为与 P5**：使用已实现的递归控制面冻结真实 R0/R1、共同 A0、任务族、provider/model receipt、资源和 selection/guard；报告全部分支与缺测。最终只用多任务族、重复、合理固定优化器基线和未写回 holdout 决定统计主张。

## 6. 分阶段 PR 与历史提交

继续使用 [Draft PR #1](https://github.com/csxq0605/Nexgent/pull/1)，分支仍为 `refactor/scientific-rsi`；历史分支名不定义产品领域。下表只列已经推送的 0.8 历史提交。P1 实现与本文状态更新仍应在提交时单独说明其确定性测试和真实 episode 证据边界；不得把工作树内容或 PR 合并状态当作运行验收。

| 已推送提交 | 历史内容与解释 |
| --- | --- |
| `36d70a2` | 旧产品退出、初始源码运行与研究系统；其早期科学耦合后来纠正 |
| `1ebc131` | 六组研究及 36 次确认；小幅任务收益不构成元改进 |
| `51fe475` | 核心/插件分离，真实改进器反馈接口 |
| `28bfc83` | 查询合同缺陷修复与重新登记 |
| `5e61906` | 完整证据、安装与窗口验证；5 后代、3 配对零收益，不是本次完整架构验收 |

[原始报告](docs/research/framework-validation-20260916.md)及源数据不改动。上一版计划的历史内容保留在 Git；本计划替代其“整体完成”结论和后续工作顺序。
