# Nexgent 架构入口

**Nexgent 是通用 RSI 智能体框架；demo 提供独立验证环境，不能定义核心架构。**

2026-09-16 重新固定定位：主路径是完整智能体组织与执行任务，并从任务反馈中改进后续工作方式。现有 0.8 是可复用的源码执行和评测基础，尚未完成该目标。vNext 当前仅为设计，OpenFOAM 插件、任务编排和新的记忆/技能演化协议尚未实现。

## 当前有效设计

1. [定位与重构决策](design/product-and-refactor-decision.md)：不变要求、三层改进、产品边界、重构判断与验收层次。
2. [vNext 智能体架构](design/agent-architecture-vnext.md)：任务、技能、编排、工件、记忆、反馈、可继承行为包与执行边界。
3. [编排与 RSI 研究综合](research/agent-orchestration-rsi-synthesis-20260916.md)：论文实际方法、采用的机制、竞争解释与证伪实验。
4. [OpenFOAM 独立 demo](demos/openfoam-cfd-design.md)：Foundation 8 方腔任务、领域插件、物理验证与框架改进证据。
5. [本机环境核查](demos/openfoam-environment-20260916.md)：只读确认的运行环境，以及尚未运行的项目。
6. [分阶段重构计划](../REFACTOR_PLAN.md)：文件责任、依赖和具体出口。

## 现有实现与历史证据

- [0.8 架构快照](architecture-0.8.md)描述现有四文件源码协议与公共评测接口；它不限制 vNext 的可演化范围。
- [0.8 操作说明](operations.md)仍对应现有命令，不包含尚未实现的 OpenFOAM 运行命令。
- [0.8 机制与实验报告](research/framework-validation-20260916.md)保留真实负结果。软件检查、源码变化和任务改进分别解释，不能替代编排架构或递归效用的证据。

实现状态以代码和实际执行记录为准。设计中的新对象及接口不应被写成已交付能力。
