# 科研与 RSI 研究索引

Nexgent 的目标是通用任务执行与反馈驱动自改进的智能体架构，能够运行 benchmark。科学发现与 OpenFOAM 是独立 demo，不能定义核心。2026-09-16 的重新设计以下列文档为准；vNext 尚未实现，旧实验仍按当时协议解释。

## 当前设计

- [定位与重构决策](../design/product-and-refactor-decision.md)
- [vNext 架构](../design/agent-architecture-vnext.md)
- [编排与 RSI 研究综合](agent-orchestration-rsi-synthesis-20260916.md)：实际方法、采用方式、未完成能力和可证伪实验。
- [OpenFOAM demo](../demos/openfoam-cfd-design.md)与[环境核查](../demos/openfoam-environment-20260916.md)：独立领域任务与评价。

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
