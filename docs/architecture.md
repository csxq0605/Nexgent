# Nexgent 架构入口

Nexgent 是能够在任务中开发和改进能力、并在独立任务上检验效果的通用 RSI 智能体框架。工具、插件、技能、执行循环、编排和记忆策略均在目标范围内；DAG 只是执行表示之一。科学发现与 OpenFOAM 是可选环境。

2026-09-23 重新制定实施计划。新的能力内核和模型插件开发尚未实现；已有 TaskService、版本化包、图编译、技能子包和演化控制面是迁移资产，不能据此宣布完整 RSI 已完成。

## 当前目标与实施

1. [仓库计划](../REFACTOR_PLAN.md)：基线、A–G 阶段、依赖、验收、资产迁移和协作责任。
2. [RSI 能力内核](design/rsi-capability-kernel.md)：服务／插件、可替换执行策略、开发与采用循环、研究问题；后端待实测选型。
3. [产品决策](design/product-and-refactor-decision.md)：通用框架、领域隔离和 Main 入口的不变要求。
4. [研究索引](research/README.md)：来源、实验与证据边界。

## 已有执行合同与专题

- [0.9 AgentPackage／任务架构](design/agent-architecture-vnext.md)及[ExecutablePlan v1](design/executable-plan-v1.md)。
- [任务时 DAG](design/task-time-self-orchestration.md)、[受控技能开发](design/task-time-skill-invention.md)、[无状态边界](design/stateless-kernel-and-self-designed-teams.md)。
- [反馈与采用控制面](design/p3-feedback-evolution-control-plane.md)、[递归控制面](design/p4-recursive-improver-control-plane.md)、[MemoryService](design/memory-service-lifecycle.md)。
- [Benchmark SDK](design/benchmark-sdk.md)、[Main 信息窗](design/main-conversation-interface.md)。

这些合同描述已有路径或局部目标。它们的固定枚举、旧默认和阶段编号不定义新能力内核的范围。

## 运行与历史

- [真实任务时探针](research/task-time-self-orchestration-live-20260923.md)：图执行、技能生成、反馈规划尝试与失败；没有正向 RSI 结论。
- [OpenFOAM smoke](demos/openfoam-smoke-validation-20260920.md)：已实际运行；精度、收敛和模型自主效果需另测。
- [旧 P0–P5 计划](history/refactor-plan-p0-p5-20260923.md)、[0.8 架构快照](architecture-0.8.md)及[历史研究](research/framework-validation-20260916.md)：保持当时事实与结论边界。
