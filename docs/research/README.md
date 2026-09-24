# 科研与 RSI 研究索引

Nexgent 是通用、可运行 benchmark 的 RSI 智能体框架。2026-09-23 的[新计划](../../REFACTOR_PLAN.md)以可扩展能力内核、模型工具／插件开发、执行与编排更新、独立验证和递归效用为主线。已有候选选择／晋升和递归控制面具有确定性机制证据；真实模型有部分任务与能力生成证据，但没有正向 RSI 结论。科学发现与 OpenFOAM 只提供独立环境，不能定义核心。

## 当前设计

- [实现、目标与参考来源对照账本](implementation-reference-tracker.md)：每阶段提交更新实际激活证据、未通过出口及固定的参考版本。
- [Stage A1 固定源码对照](kernel-reference-audit-20260923.md)与[同题小样合同](../../experiments/kernel_spike/CONTRACT.md)：内核路径比较和实跑检查项。
- [能力内核与可演化执行系统](../design/rsi-capability-kernel.md)：DeepSeek Harness、AutoSci、ADAS/AFlow、RHI/HSI 的参考机制与待检验问题；目标设计，不是已实现声明。
- [真实任务时编排与技能探针](task-time-self-orchestration-live-20260923.md)：模型图、技能、检查点成功与失败的证据边界。
- [仓库当前计划](../../REFACTOR_PLAN.md)与[旧 P0–P5 快照](../history/refactor-plan-p0-p5-20260923.md)：现行实施顺序与历史交付分开读取。

- [定位与重构决策](../design/product-and-refactor-decision.md)
- [vNext 架构](../design/agent-architecture-vnext.md)
- [编排与 RSI 研究综合](agent-orchestration-rsi-synthesis-20260916.md)：实际方法、采用方式、未完成能力和可证伪实验。
- [P1 任务运行时验证](task-runtime-validation-20260920.md)：真实 episode 的冻结信息、轨迹、评审、恢复和验收记录结构；当前空字段保留为待运行证据。
- [OpenFOAM demo](../demos/openfoam-cfd-design.md)与[环境核查](../demos/openfoam-environment-20260916.md)：独立领域任务与评价。

## 已有任务执行基线与 RSI 研究边界

P1 固定了任务、不可变 AgentPackage、能力准入、工件/记忆引用、调用收据、预算和恢复状态，并在默认包中加入交付评审与修订循环。这些对象让后续研究能够判断“哪个版本在什么输入和预算下做了什么”，但尚未形成跨任务自进化。

真正的 RSI 闭环以版本化行为为修改对象：编排与角色交接、技能和提示协议、记忆写入/检索策略，以及后续的改进策略。反馈来自独立任务质量、评审缺陷、工具与恢复结果、资源成本和回归。候选必须带父版本与触发证据，在隔离任务上实际运行，经过冻结评价器和成本/回归门控后才可晋升；失败候选不部署，已部署候选退化时回到上一通过版本。

[研究综合](agent-orchestration-rsi-synthesis-20260916.md)的核心结论是：持久化、可执行和有效必须分开检查；任务内修订、跨任务积累和元效用也必须分开测。[框架验证](framework-validation-20260916.md)与[v1](framework-mechanism-v1-review.md)/[v2](framework-mechanism-v2-review.md)审查进一步表明，机制未激活、未通过准入的源码、错误父代选择和零增益后代必须如实保留。后续不能再用源码 diff、写入记忆或生成候选的数量代替实际效用。

## 0.8 及更早阶段的材料

以下文献复核、接口和实验文件是历史研究记录，不覆盖新设计的范围。

| 文档 | 用途 |
|---|---|
| [0.8 架构快照](../architecture-0.8.md) | 现有源码执行、插件、探测和归因；完整任务编排目标尚未完成 |
| [0.7 设计记录](design.md) | 历史科学 demo 原型的文献机制与实现；其领域耦合已纠正 |
| [RSI 一手研究复核](reboot-rsi-mechanisms.md) | STOP、DGM、Hyperagents、HGM 等的原文位置、真实机制、成本与反证 |
| [科学协议与失败诊断](reboot-scientific-protocol.md) | 历史逐候选分析、科学任务、强基线、消融和新数值控制 |
| [全仓审计与迁移](reboot-repository-map.md) | 原仓库模块去留、依赖、包布局和运行安全审查 |
| [早期源码接口记录](source-runtime-contract.md) | 历史 source bundle、solver、improver、broker 与数值接口；目录和范围已被后续设计替代 |
| [确认实验登记](confirmation-plan-20260916.json) | 已执行的一次性 split/seed、预算、先冻结各臂程序及禁止确认反馈 |
| [六组研究与独立确认结果](source-batch-results-20260916.md) | 两条独立演化种子的三臂对照、全部失败与成本、一次性确认和 RSI 证据限制 |
| [精简原始证据](source-batch-evidence-20260916.json) | 六研究、36 次确认、逐任务数据、实际用量及去重源码，排除配置和模型请求正文 |
| [科学发现插件](../../benchmarks/scientific_discovery/README.md) | 领域任务、数值工具、强基线、评分与文献的独立安装及方法边界 |
| [公共 CLI 科学 demo 验证](build-validation-scientific-cli-20260916.json) | 通用 evaluate 入口的固定程序、真实源进程、逐任务结果和 0 API 用量回执；不衡量 RSI 效果 |
| [通用框架真实验证](framework-validation-20260916.md) | 框架边界、两次 pilot、跨 benchmark 实际改进器比较、安装与成本证据 |
| [v1 机制审查](framework-mechanism-v1-review.md) | 实际继承、查询接口失败、被拒的伪修复与不完整比较 |
| [v2 机制审查](framework-mechanism-v2-review.md) | 无候选探测、错误 selector、实际后代及独立比较的证据边界 |

论文结果、本地软件检查、实际自修改、任务效果和真实后代生产率分别报告。需要同时保存成功、失败、缺测、模型用量和数值工作；多次迁移复现不能冒充多个独立演化研究。

SCI/SCIE 是索引认证；本研究核对原始期刊和会议身份，没有把出版网页当作 Web of Science 的索引证明。
