# Nexgent vNext 重构计划

日期：2026-09-21。状态：P0 设计已固定；P1 任务执行、交付评审与恢复基础已落地，AgentPackage manifest v2 与 ExecutablePlan v1 已把 role/workflow/orchestrator/O-M-S component 接到真实 runtime、revision 和宿主账本恢复。P2 独立 OpenFOAM Re=10 smoke 已在真实 WSL2/Foundation 8 环境通过。P3 的稳定 component-id O/S 演化链与双合同 reference R0 已实现；P4 已有 durable-claim 可恢复 cycle；P5 已实现通用预注册 final-holdout 配对执行器。当前 RSI 证据上限仍是 E0 工程合同；真实 E1 generation activation、M route 和正式外部多任务研究尚未完成。

## 1. 产品与执行范围

唯一产品是 **通用 RSI 智能体框架 Nexgent**。它应能组织智能体完成普通任务，并通过独立 benchmark 检验任务能力、持久改进和递归效用。科学发现与 OpenFOAM 都是可选插件/场景；核心不能依赖 CFD 方程、求解器、case、论文五阶段流程或某个 demo 的评分。

当前实现阶段仍遵守该产品边界。定位依据见[设计决策](docs/design/product-and-refactor-decision.md)，接口和执行模型见[架构](docs/design/agent-architecture-vnext.md)与[ExecutablePlan v1 / manifest v2](docs/design/executable-plan-v1.md)，P3 的现行合同见[反馈演化控制面](docs/design/p3-feedback-evolution-control-plane.md)，研究依据与冻结实验见[P3 跨任务 RSI 设计](docs/research/p3-cross-task-rsi-design-20260920.md)及[RSI orchestration research refresh](docs/research/rsi-orchestration-refresh-20260921.md)。

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

依赖 P0。当前通用 AgentPackage 已能读取目标与输入，规划工作，调用模型、技能、工具和委派，交接工件，依据失败或交付评审继续修订并交付。普通任务和轻量非 CFD workbench benchmark 共用 `TaskService`；Main 对话、CLI、持久存储和导出也已接入同一状态，高级任务/证据控制台保留完整字段和 RSI 只读投影。

AgentPackage manifest v2 新增显式 role、workflow、component 与 orchestrator 注册。component 以稳定 id 绑定 O/M/S 分类和 role/workflow/skill/entry/resource 引用；v2 谱系不能降级到 v1，也不能让同一稳定 component id 悄然改变 class/kind/ref。O 类 workflow orchestrator 的冻结 JSON workflow 会在执行边界编译为 `nexgent.executable-plan.v1`，由宿主核验角色能力、组件引用、Episode 工具 lease、控制/工件边、join、局部上限、失败路由和 revision 规则，再通过真实模型、技能、工具、委派与发布路径运行。

计划 revision 只允许切换到同一不可变 AgentPackage 内已注册的 workflow，并只能替换尚未开始的子图；运行中和终态节点及其收据不可改写。恢复时持久计划只是投影，宿主 RPC journal、工件可见性和节点收据才是权威证据：已完成节点通过交叉核验后复用，已 admission 却没有持久 outcome 的 running 节点进入 `recovery_required`，不盲目重放外部副作用。该纵切面证明声明、执行、修订和恢复合同已连通，不证明模型会生成优质计划或在反馈后选择有效修订。详见[ExecutablePlan v1 与 manifest v2](docs/design/executable-plan-v1.md)。

代码与确定性测试已经覆盖受限子进程、版本化多文件包、模型/工具节点、显式工件、当前记忆快照、树级共享预算、停止恢复、交付 schema 核验、包内 reviewer 修订和冻结 benchmark 评价。简单任务仍可走单体路径，不靠强制增加角色数制造协作证据。

P1-V 已将跨工具工件交接收紧为核心 JSON Schema 合同：插件以 `x-nexgent-artifact-ref: true` 标记输入位置，运行器按完整 Draft 2020-12 applicator 语义验证真实 `artifact-…` 身份和 Episode 可见性，再登记工具调用。普通数据中的同名属性不会被误判；输出 schema 不允许声明该标记。Workbench 与 OpenFOAM 只消费这个通用合同，不在核心写入领域流程。

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

产品默认 reference R0 使 `rsi-generate` 无需外部 improver JSON 也能通过配置模型执行真实 generation。它按宿主归一化 policy 支持 legacy path-v1 和 manifest component-id-v2；v2 强制 hypothesis/operation/probe 使用同一 id，调用者与模型都不能提供权威 path/class。两条合同都只允许一个现有 O/S 文件的单次 `replace`，拒绝 M、多文件、add/remove 和控制面修改。调用方仍可显式传入冻结 improver package，或以 improver channel + expected revision 使用 P4 部署版本。默认 R0 只生成候选，不自动 selection、promotion 或 guard，也不包含 demo/benchmark 专用逻辑。

`EvolutionService` 把 paired suite、benchmark/evaluator snapshot、父子顺序、预算、可重算的 execution environment/tool/runtime snapshot 及 PromotionPolicy 在结果产生前冻结。实际 provider/model 身份由逐调用 receipt 证明，并在正式实验中与预登记配置核对；当前计划记录本身不声称已预先完整冻结二者。development decision 不能晋升，final holdout 不能进入演化；selection 缺分、用量不完整、身份不一致和关键回归均 fail closed。选择门的 `cost` 是模型调用、charged completion tokens、工具调用和节点用量形成的 normalized work unit，不是供应商货币费用。eligible 与 promote 分开；只有 `GenerationService` 闭合真实 R0 生成收据的 candidate 有部署权限，受控导入只进入研究/archive；promote 还要求父包仍为 active，并强制绑定预登记 monitor plan。普通任务只在创建时通过 `package_channel` 解析部署包。guard plan 与阈值在晋升前冻结，其完整任务多重集只允许一次执行；缺项、重复项、usage 不完整或 evaluator receipt 不匹配均 fail closed，退化时沿已记录部署边回滚。

当前完成的是工程机制：不可变记录、hash-linked 事件、只读安全投影、普通任务的通道加载、内置参考 R0，以及一个以固定无模型 fixture 执行 feedback → generation → selection → promotion → new Episode → guard → rollback 的确定性闭环和脱敏证据导出。尚未完成的 P3 研究出口包括：内置或冻结 `R0` 从真实模型反馈产生有效候选、候选在独立 selection 上胜过父代、晋升后在新任务中激活所声称行为，以及由重复和对照支持的效应估计。候选未变好时必须报告 rejected/missing；不能把代码路径、模拟测试、candidate 数量、一次模型调用或一次部署写成 RSI 效益。

通用 `RSICycleService` 已将上述 P3 步骤组织成可恢复持久状态机：创建时冻结 task channel revision、improver、selection/guard adapter snapshot、预算、seed 与 policy；运行时逐阶段保存已有不可变证据引用。paired/monitor 单次 claim 可在“run record 已写入、claim 尚未完成”的中断窗口唯一关联并原子收口；promotion 后的 guard 和 rollback 绑定预期 revision/package/monitor plan，通道漂移 fail closed。`rsi-cycle-start/resume/show/recover` 消除了正常路径的手工 ID 串接，默认信息窗口可查询脱敏 cycle 状态。Cycle 还可冻结独立 recursive improver channel 的 revision/package/digest，让已部署 R 承担下一轮 generation；可信宿主在 Episode 创建和启动边界重新核验登记，避免 R channel 漂移后错误执行旧包或产生模型费用。

详细对象、接口和信任边界见[控制面设计](docs/design/p3-feedback-evolution-control-plane.md)。固定编排、匹配额外调用、只积累记忆与 P3 主机制的对照见[研究设计](docs/research/p3-cross-task-rsi-design-20260920.md)。

### P4：改进过程的可更新与递归执行（机制闭环已实现，效果实验未完成）

依赖 P3。当前实现为 R 建立独立 archive、channel 和 hash-linked event chain。active R 通过真实 `TaskService` self-update Episode 交付受限 `ImproverPatch`，形成直接子代；R0/R1 的元比较从同一 A0、同一 FeedbackBundle、相同 task mutation policy、空 memory 起点和等分总预算出发，实际调用 `GenerationService` 产生任务后代，再通过冻结 benchmark adapter 运行和评价。元效用只来自后代质量、成功率、回归与 charged work。

promotion 强制绑定预登记 improver guard。部署后的候选生成通过独立 improver channel 解析 R id/digest/revision，并在运行结束前复核通道未变化。guard 同样经该通道产生真实任务后代，完整覆盖冻结任务多重集；缺测、身份错误、usage 不全或效用低于阈值都 fail closed，并沿确切部署边 CAS rollback。

确定性 pilot 已闭合 `R0→R1`、R0/R1 后代 `0.4/0.8` 元比较、R1 channel 加载、`R1→R2` archive、自注册阈值 `0.9` 触发回滚，以及新 revision 通过 channel 再次实际加载 R0。该 fixture 不使用模型、网络或工具，只证明机制；真实 R 是否能从任务反馈产生更优改进策略仍未建立。

`RecursiveImproverCycleService` 已把 feedback、R self-generation、meta plan/run/assessment、decision、guard plan、promotion、guard 与 rollback 组织为持久状态机。action 与 generation invocation claim 在同一事务预留；terminal generation、claim 与事件原子闭合；R/A0 在 generation create/run 和 evaluation create/run/evaluate 前重验。控制面漂移抛出独立 `AdmissionConflict`，不会被写成性能失败或触发错误回滚。CLI 提供 start/resume/show/recover，公开投影按字段和类型过滤。它仍只证明恢复与门控机制，不证明模型能递归提高 R。

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

TaskService benchmark 的 SDK 已收敛为显式 descriptor/protocol、隔离 registry、有限 JSON 合同和独立 host runtime 指纹；Workbench、OpenFOAM、BBH 两任务与 scientific-discovery adapter 已接入。scientific-discovery 的一个 synthetic case 对应一个 TaskSpec/Episode，隐藏 forecast 留在宿主评价器，项目私有 release key 通过 HMAC 派生隐藏生成 seed、统计单元和不透明 family cluster，并提供确定性的无模型 reference AgentPackage。它与 BBH 都保留 legacy 入口和历史记录，且不把 legacy ID 与 Episode ID 互认。P3 paired selection/guard 与 P5 study 冻结同一 outcome policy：只有 `failed + agent/protocol` 属可测的 observed zero，cancelled、paused、waiting、基础设施故障和 evaluator unavailable 均保持 missing。完整边界见[Task benchmark SDK](docs/design/benchmark-sdk.md)。

TaskService 现将工具调用次数与数值/外部工作量分开核算。`ToolSpec` 声明调用前固定预留，可信 handler 经 `ToolContext` 在实际工作边界持久计费，root Episode 对并行和委派共享原子预算；崩溃或未知结算保留预留且使 usage 不完整。P3/P4/P5 的成本门统一读取宿主 `charged_tool_work_units`，历史记录按显式零基线只读兼容。框架不能自动推断任意求解器的 FLOPs；scientific-discovery DomainPack 已在数值批次边界接入宿主可信计量，返回值中的 `work_units` 只作诊断。完整合同见[工具工作量计量](docs/design/tool-work-accounting.md)。

P3 现有一个独立的正向 E1 exporter 与领域中立 qualification runner。它只接受仓库当前 immutable reference R0 的单一 `rsi_improver` 模型输出；现有 qualification fixture 仍使用 legacy path-v1 目标。runner 要求输出摘要等于入库 patch、usage/模型身份完整、paired quality 或 success 严格改善、独立 guard 通过，并由未参与 development/selection/guard 的冻结统计单元在晋升后再次加载同一 package revision。attempt 在模型调用前持久化且不可覆盖。该 runner 尚未执行真实 MiMo generation：自动外发审查要求用户明确授权把脱敏 FeedbackBundle、目标 component 内容和 mutation policy 发往已配置的 MiMo endpoint。合同和运行方式见 [P3 E1 qualification pilot](experiments/p3_e1/README.md)。

scientific-discovery 的 canonical `final_holdout` 只是历史 confirmation 分布的兼容名称，仅用于迁移 regression/golden 等价检查。它不是新鲜 holdout，也不支持新的科学发现、模型效果或 RSI 结论；正式研究仍需新的 host-private release、独立来源 cluster、重复、控制臂和真实 provider 收据。

## 5. 当前状态

| 项目 | 状态 |
| --- | --- |
| 用户确认的框架定位与独立 demo 边界 | 固定要求 |
| vNext 定位、架构、研究综合、OpenFOAM 设计 | P0 已完成；设计中的正式数值研究仍未执行 |
| 本机 OpenFOAM | 已确认 WSL2 / Ubuntu 20.04 / Foundation 8，并真实运行 Re=10 教程 smoke |
| P1 任务执行、交付评审、工件/记忆、预算与恢复基础 | 0.9 已实现，含 manifest v2、ExecutablePlan v1、pending 子图 revision 与 root 共享宿主账本恢复；定向证据为 E0 工程合同，真实 MiMo 普通任务交付已通过，Workbench 独立评价仍未形成 |
| Main 对话与信息窗口 | 默认入口已切换为自然语言 Main；运行、成果、证据在右侧信息窗，高级任务控制台仍可打开；项目级消息历史、附件上下文和澄清回合仍待后续切片 |
| Task benchmark SDK 与失败测量 | 0.9 canonical descriptor/registry、插件隔离、host runtime 指纹及 P3/P5 共享 outcome policy 已实现；BBH 两任务与 scientific-discovery 已迁移并保留 legacy 兼容入口；科学历史 holdout 仅作迁移回归材料 |
| OpenFOAM 插件及真实 demo P2 | 独立 smoke 插件已实现并真实通过；正式精度与收敛协议未执行 |
| 跨任务行为更新 P3 | manifest-v2 component id 已贯穿 feedback、BehaviorPatch v2、加载摘要、selection、promotion、guard 与 evidence；默认 R0 同时支持 legacy v1；M route 与真实模型效果待检验 |
| 改进器递归执行 P4 | 独立 R 通道、自更新、真实后代元评测、guard/rollback、durable invocation claim、逐副作用 admission 与 recoverable cycle 已闭合；真实模型/统计递归效益待完成 |
| 冻结正式研究 P5 | 通用 final-holdout 配对执行器、预注册 schema、CLI/信息窗已实现；外部多任务族正式研究待登记与执行 |
| 0.8 的源码机制与历史结果 | 保留；不能替代以上状态 |

### 下一阶段

本阶段优先解决**编排和技能的实际可进化范围，以及模型驱动的多智能体 benchmark**，不把当前单组件 E1 pilot 当作最终框架的替代验收。完整合同、逐组件激活证据与四臂对照见[编排与技能可进化 v3](docs/design/orchestration-skill-evolution-v3.md)。

1. **收尾工作树**：审查并提交纯 M 路由、benchmark suite role、独立来源 cluster、evaluator identity 和 CLI 投影的现有未提交实现；只报告相应定向测试及推送后的 CI。纯 M 进入 MemoryService 独立 release/snapshot；O/S+M 在原子复合合同前整体拒绝。
2. **扩大 O/S 候选单位**：从单组件 replace 扩展为整包原子 PackagePatch，支持相互依赖的 role、workflow、skill、prompt 与 manifest 注册表的多组件 add/replace/remove。每个操作要有稳定身份、旧/新摘要、引用校验和不可变 lineage；宿主权限、评价、R 活跃实现与隐藏数据不可变。
3. **模型驱动的多角色 benchmark**：在同一个 TaskService/canonical adapter 上观察至少两个模型角色、真实工件交接、交付和独立评价；零模型调用的程序适配路径只作 control，不计作编排证据。先用 Workbench 开发任务定位无效工件引用与预算耗尽，再扩展外部任务族。
4. **反馈搜索与对照**：R0 从来源绑定的失败反馈提出多个 O/S 候选，逐组件证明实际加载和执行；预注册固定多智能体编排、等预算单智能体、memory-only、完整进化四臂，在未见任务上按来源 cluster 比较质量和实际成本。
5. **E1 与后续研究**：在上述完整目标面上闭合真实 provider 候选的 generation、selection、promotion、guard 和后续复用；旧的单组件 qualification pilot 仍可作为兼容回归，但不代表目标架构验收。然后做多 benchmark/seed 聚合、M 的独立因果检验、原子 O/S+M 复合发布和 R0/R1 后代效用比较。
6. **产品与 demo**：Main 完成持久多轮、附件、澄清、Benchmark/RSI Lab 信息视图；OpenFOAM 的 Re=100/收敛/参考解作为后置独立 demo 扩展。

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
