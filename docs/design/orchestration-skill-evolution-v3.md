# 编排与技能可进化：下一阶段的实现合同

日期：2026-09-23。状态：**设计与验收合同；下面的复合补丁和实证结果尚未实现。**

## 目标和当前断点

Nexgent 是通用、可运行 benchmark 的 RSI 智能体框架。领域插件提供任务、工具与独立评价；核心只处理角色、工作流、技能、记忆、版本和证据。下一阶段的主问题不是单次文件改写能否晋升，而是：**任务反馈能否使多智能体组织与技能协议改变，并在后续未见任务中带来可归因、预算可比的收益。**

manifest v2 已登记 role/workflow/skill/O/M/S component；ExecutablePlan v1 已能执行有界 DAG、并行、join、委派、局部预算、失败路由和预登记 revision。但当前 `BehaviorPatch v2` 的 hypothesis、activation probe、候选、选择、晋升和 guard 都围绕一个 `component_id`。默认 R0 仅可 `replace` 一个现有 O/S 文件。workflow 文件内部可以改节点与边，却不能在同一原子候选中连带增加角色、改变多个技能、替换对应提示资源或删除不再使用的组件。已有 E0 机制不能替代这种复合进化能力。

## 可进化对象

下一版候选的发布单位是**不可变 AgentPackage**，不是某个文件。允许一次候选同时修改以下相互依赖的部分：

| 对象 | 允许的行为变化 | 必须留下的运行证据 |
| --- | --- | --- |
| O：角色组织 | 角色增删、能力分配、交接与委派关系 | 实际 role/component 引用、模型/工具调用、交接工件 |
| O：DAG 与策略 | 控制/工件边、并行宽度、join、辩论/复核/停止、失败路由、局部预算、预登记 revision | 编译后的 plan digest、执行节点、跳过/停止原因、实际成本 |
| S：技能与协议 | 技能实现、提示资源、输入/输出 schema 和使用条件 | 技能调用/提示资源 digest、产出的工件与评审结果 |
| M：记忆 | 选择、保留、检索与消费策略或数据 | 独立 MemoryService release、Episode 快照和消费收据 |

“辩论”应由可执行的角色、工件边和裁决节点组成；不能只在 prompt 中宣称多智能体。预算分配必须作为受总上限约束的局部 policy；候选不能扩大宿主授予的工具、模型、网络或总预算权限。M 与 O/S 的复合发布需要跨 package channel 和 MemoryService release 的原子提交/回滚合同，在该合同实现前只接收纯 M 或纯 O/S 候选，不能部分激活。

## PackagePatch v3：整包原子事务

新增版本化 `PackagePatch` 合同，保留旧 BehaviorPatch v1/v2 的兼容读取，不把旧记录改写成 v3。一个候选包含：

1. `parent_package_digest`、冻结 mutation policy 和可修改组件集合；
2. 有序的组件操作：`add`、`replace`、`remove`，每项声明稳定 `component_id`、class/kind、旧摘要或新引用、文件变更及理由；
3. 对 manifest 注册表的显式差量，覆盖 role、workflow、skill、entry、component 与 orchestrator 引用；
4. 假设：失败证据引用、预期行为、适用范围、反证条件、**全部目标组件**及其依赖关系；
5. 激活计划：哪些任务/节点应加载每项变更、怎样从宿主收据确认，而非由改进器自报。

宿主在一个事务中重建完整 child package，校验所有引用、schema、图无非法环、循环上界、能力 lease、路径与大小限制、父子谱系以及被删除组件没有悬挂引用。新组件 ID 可以增加；旧 ID 不得悄然改变 class/kind/ref 的语义，必要时删除旧 ID 并新建 ID。活跃 R、evaluator、split、gate、权限与隐藏数据不属于补丁面。非法候选保留为失败样本，不进入选择。

选择与部署应绑定**整个 package digest 和变更集合**，并在每个配对 Episode 记录逐组件 `declared → loaded → exercised`。只加载整包但未执行所改节点，不能声称其编排改动得到验证；只改提示而模型没有使用该角色，也不能归因到该提示。未被触发的组件可以作为探索性候选存在，但不能凭其他组件的收益获得该组件的激活结论。晋升仍由宿主掌握，guard 对完整 child package 检查与回滚。

## 任务必须真实经过多智能体执行

首个资格实验使用**领域无关**的多角色 package，接入现有 canonical benchmark `TaskService`；Workbench 可作为开发任务族，BBH 仅用于接口回归，OpenFOAM 是独立工具 demo。预先固定至少三种角色职责：任务执行、独立检查/批评、证据整合或修复；具体图、并行、交接和停止由包内 O/S 表达，不写入 benchmark 核心。每个研究 cell 必须保存：

- 冻结 package/plan/benchmark/evaluator/provider 身份；
- 实际 `model_calls > 0`，且至少两个不同角色的模型调用收据；
- 角色间工件或消息的生产与消费、工具调用及局部/总体用量；
- 完整交付、独立评价，或可归责失败与缺测。

27 条零模型调用的历史轨迹如存在，只能证明适配或程序基线，不能计为多智能体编排实验。一次 MiMo 普通任务已有 task-agent/reviewer 模型调用，但没有独立 benchmark 分数，也不能替代这一验收。

## 预注册对照与因果问题

在相同任务实例、工具权限、模型、总硬预算和盲评价下，至少比较四臂：

| 臂 | 设置 | 排除的替代解释 |
| --- | --- | --- |
| F：固定多智能体编排 | 同一初始 O/S，允许任务内修订，不持久更新 | 多角色本身的贡献 |
| S：等预算单智能体 | 一个执行角色，可用同样总模型调用与工具上限 | 收益只是多用了模型 |
| M：仅积累记忆 | 固定 O/S，只允许有来源的 M 更新 | 收益只是保存经验 |
| E：完整进化系统 | O/S 候选可进化；有 M 时单独登记或在原子复合合同后加入 | 编排/技能更新的增量贡献 |

固定优化器搜索和 R 自更新再作为后续对照，不能在首轮混入 E 臂以致无法归因。报告实际调用、tokens、工具工作量、wall time 和所有失败候选；相同硬上限不意味着实际成本相同。主要比较使用未见过的 selection/holdout，按独立来源 cluster 聚合，而不是把多次调用当独立样本。首先检验 `E−F`、`E−S`、`E−M`；R 的命题另从共同 A0 比较 R0/R1 产生的后代效用。

## 交付顺序与出口

1. **合同与差距测试**：固定 PackagePatch v3、注册表差量、逐组件激活证明与不可修改面；负例涵盖悬挂引用、越权、新旧 ID 混淆和部分提交。
2. **整包原子候选**：实现 O/S 多组件 `add/replace/remove`、完整包重建和不可变 lineage。最小正例同时改变一个 workflow、一个 role prompt 与一个 skill，并让后代实际运行；M 保持独立事务。
3. **真实多角色 benchmark**：同一 canonical adapter 上执行两个以上模型角色、实际交接、完整交付与宿主独立评价；先解决 Workbench 的无效工件引用和预算耗尽问题。
4. **反馈驱动搜索**：R0 接收脱敏失败归因和允许的注册表/图结构，产出多个不同 O/S 候选；archive 记录非法、失败、未胜和获胜候选。候选数、合法率、激活率与效用分开报告。
5. **四臂对照**：预注册同任务、同模型、等预算及来源分组；先做 qualification，再做未见任务的配对研究。只有实际多角色执行、逐组件激活和独立评价同时成立，才评估编排/技能收益。
6. **M 复合与 R 递归**：分别验证纯 M 的后续消费；实现原子复合 release 后再比较 O/S+M；最后以共同 A0 比较 R0/R1 后代，不能以 R 自身源码变化代替效用。

每步只运行受影响的定向测试和必要的真实资格任务；推送一个阶段后再跑完整 CI。所有阶段继续进入同一 Draft PR，负结果和缺测保留。

### 2026-09-23 首个执行切面

固定多角色 AgentPackage 和等调用量单角色包已作为领域无关基线实现；它们都通过同一 canonical benchmark 入口运行并由宿主独立评分。[公开 BBH development 单题资格运行](../../experiments/orchestration_qualification/RESULTS.md)中，MiMo v2.6-flash 的多角色包完成了 3 次模型调用、交接和交付，但得 0 分；单角色 3 次调用得 1 分。它证明“实际运行”路径，不支持多智能体收益。

`package_patch_v3.py` 现有一个宿主侧整包构造器，定向合同测试证明 O/S 的多组件 add/replace/remove 可在一个不可变 child 中重建、实际执行，并拒绝越权、悬挂引用和部分声明。workflow 执行收据也开始记录实际加载的 workflow/role/skill 文件摘要所需路径。**尚未完成**的是把 PackagePatch v3 接入 R0 真实生成、候选入库、逐组件选择/guard、M-only/完整进化臂和统计对照；因此目前不能称为端到端复合 RSI。

## 研究依据与限度

- [AutoSci](https://arxiv.org/html/2605.31468v1) 的 SciDAG/SciEvolve 指向可复用 DAG 模板、技能与记忆组织的版本化更新；它的科研生命周期是 demo 语境，不应硬编码到 Nexgent 核心。
- [AFlow](https://arxiv.org/html/2410.10762v4) 说明 workflow 操作/边/提示可以成为搜索对象；固定优化器是恰当基线。
- [ADAS](https://arxiv.org/html/2408.08435v2) 支持搜索完整可执行 agent 方案、保留候选谱系；仍需单独证明改进器自身是否变强。
- 现有[研究综合](../research/rsi-orchestration-refresh-20260921.md)给出 STOP、DGM 等对应关系与证据等级。论文中的架构动机不是 Nexgent 的实证结果；上述对照和失败记录负责检验这里的设计是否有效。
