# RSI orchestration research refresh · 2026-09-21

## 结论

Nexgent 继续定位为通用 RSI 智能体框架。科学发现、OpenFOAM、BBH 和
Workbench 是可替换的 benchmark 或 demo，不是核心编排。当前
`O/M/S/R + TaskService + FeedbackBundle + paired gate + guard/rollback`
和相关一手工作的方法边界一致；现在同时缺少**真实效用证据**和目标架构所需的**复合编排/技能修改面**。当前单组件 replace 可以测试一个局部机制，却不足以检验角色组织、DAG、技能协议的联合进化；修改范围及对照的下一阶段合同见[编排与技能可进化 v3](../design/orchestration-skill-evolution-v3.md)。

下一阶段先扩充复合 O/S 候选及真实多角色 benchmark，再闭合两条可证伪链：

1. `FeedbackBundle → BehaviorPatch → child AgentPackage → selection 激活
   → paired gain → channel 后续复用`；
2. `R1 → 从共同 A0 与反馈生成后代 → 未见 selection tasks 上的后代效用
   高于 R0`。

第一条完成前，只称“反馈驱动的持久行为更新控制面”或“RSI research
framework”。第二条即使阳性，也只支持受限 agent-system recursive
improvement。多代改进速度增加还需要比较代际效用增长的二阶项。

## 一手方法到框架对象

| 方法 | 对 Nexgent 的直接映射 | 采用 | 证据边界 |
| --- | --- | --- | --- |
| [AutoSci v1](https://arxiv.org/html/2605.31468v1) / [固定实现标签](https://github.com/skyllwt/AutoSci/tree/arxiv-v1) | SciMem → M；SciFlow/SciDAG → S/O；evolution signals → FeedbackBundle；Trust Guard → admission/gate | 版本化行为资产、来源绑定反馈、记忆/技能/编排分开更新 | 两个端到端案例没有隔离 SciEvolve 的因果贡献；可支持对象设计，不能证明 Nexgent 已有 RSI 效益 |
| [ADAS / Meta Agent Search](https://arxiv.org/html/2408.08435v2) / [代码](https://github.com/ShengranHu/ADAS) | 完整 agent forward code → O/S candidate；validation feedback → paired trial；archive → research archive | 搜索完整可执行 agent，而不是只调参数 | Meta Agent Search 本身固定；更强后代不等于 R 变强 |
| [AFlow v4](https://arxiv.org/html/2410.10762v4) / [代码](https://github.com/FoundationAgents/AFlow) | workflow code/edges/prompts → O/S；execution feedback → measurements；MCTS experience → archive | 作为固定 workflow optimizer 和 P5 C3 基线 | optimizer 不自更新，不能映射成 R 改进 |
| [Darwin Gödel Machine v3](https://arxiv.org/html/2505.22954v3) / [代码](https://github.com/jennyzzt/dgm) | self-modifying coding agent → O/S 与部分 R；lineage archive → immutable package archive；benchmark logs → FeedbackBundle | 保留合法但未胜出的谱系节点；实际执行、sandbox、收据和跨 benchmark 检验 | archive maintenance 与 parent selection 仍固定；coding gain 代表 self-modification gain 是代理假设，不能推出通用 RSI |
| [STOP](https://arxiv.org/pdf/2310.02304) / [代码](https://github.com/microsoft/stop) | downstream meta-utility → MetaEvaluationService；共同初始解 → 共同 A0；improver 版本 → R0/R1 | R 必须以实际产生的后代效用评价 | 作者明确不称 full RSI；模型权重不变且弱模型递归可能退化 |
| [Self-Refine](https://arxiv.org/html/2303.17651) / [代码](https://github.com/madaan/self-refine) | generate-feedback-refine → 单 Episode 内 review/revise | 作为预算匹配 C1 基线 | 没有持久 AgentPackage、后续任务复用或 R 更新 |
| [Reflexion](https://arxiv.org/html/2303.11366) / [代码](https://github.com/noahshinn/reflexion) | verbal reflection → M candidate；环境反馈 → FeedbackBundle；消费 → memory receipt | 反思必须有失败信号、选择和实际消费证据 | 有限语言记忆不是已验证的长期系统改进 |
| [SWE-agent](https://arxiv.org/html/2405.15793) / [代码](https://github.com/SWE-agent/SWE-agent) | ACI、短 observation、lint feedback → S 与工具合同；trajectory → FeedbackBundle | 工具反馈应短、具体、可恢复；保存 action/observation/test receipt | ACI 是固定且人工设计的接口，不是 agent 自更新 |
| [SWE-bench](https://arxiv.org/abs/2310.06770) / [harness](https://github.com/SWE-bench/SWE-bench) | repository task/container/test verdict → benchmark adapter 与 host evaluator | 预测与评价分离、每实例轨迹、隔离执行 | benchmark 本身没有改进机制；排行榜差值不能替代改进过程证据 |

## 采用后的设计约束

- `TaskService` 只认识目标、artifact contract、capability、预算和通用执行状态。
- `GenerationService` 只接受声明式 O/M/S patch；核心不出现
  `scientific_discovery`、OpenFOAM 或某种固定科研流程分支。
- `FeedbackBundle` 只含公开指标、失败类型、artifact refs、usage 和脱敏 trace；
  不含隐藏答案、方程、forecast、评分器源码或可反推出目标的标识。
- `R` 与任务 AgentPackage 分通道版本化。候选生成、选择、晋升和部署是不同动作。
- paired selection、guard 和 final holdout 使用同一 outcome policy；missing 不能变成
  数值 0，attributable agent/protocol failure 才是 observed zero。
- final holdout 不生成 feedback、不写 memory、不触发 candidate generation。
- DomainPack 拥有领域工具，benchmark adapter 拥有任务采样和隐藏评价；两种权限不合并。
- 科学结果是一组 Episode、tool、evaluator receipts。恢复已知动力系统或单次分数提高
  不能升级为“发现新规律”或“RSI 已实现”。

## 证据等级

| 等级 | 可支持的结论 |
| --- | --- |
| E0 | 控制面、恢复和审计机制闭合 |
| E1 | 真实反馈产生的版本在后续任务实际加载并改变行为 |
| E2/E3 | 固定 R 下存在持久、跨任务或跨域收益 |
| E4 | R1 比 R0 更会产生有效后代 |
| E6 | 多代改进速度增加 |

源码 diff、候选数量、记忆写入、单次晋升或单 demo 正收益最多是机制材料，
不能单独升级证据等级。

## 最小实验 1：真实 P3 持久行为链

- 冻结 A0、内置 R0、provider/model revision、mutation policy、预算和一种通用失败机制。
- 用多个 development Episodes 形成真实 FeedbackBundle，保留所有 missing、abstention
  和非法 patch。
- 在未见 selection tasks 上比较 A0、预算匹配的 review/revise 基线和激活后的 A1。
- 主要判据：组件确实加载并改变预期步骤；paired quality/success 改善；成本不越界；
  guard 后续不回滚。
- 否证：没有合法候选、行为未激活、selection 无优势、优势只来自更多调用或 guard 回滚。

阳性只支持一个真实、持久、可复用的行为改进实例。

## 最小实验 2：失败归因是否改善 R 的后代生产能力

- R0-control 读取相同脱敏 trace，允许通用自由改写。
- R1-attribution 必须把 evidence refs 映射到 failure mechanism、目标 O/M/S、
  expected behavior、applicability 和 falsifier。
- 两臂使用共同 A0、FeedbackBundle、模型、outer budget、mutation surface 和相同后代数。
- development 只用于臂内选优；最佳后代在未反馈给 R 的 selection tasks 上成对比较。
- 主要判据：合法后代率、行为激活率、最佳后代 paired utility、关键回归和完整成本。
- 否证：R1 无优势、去掉归因结构结果不变、收益来自更多 token 或目标组件未激活。

首轮只做多个独立 feedback origins 的机制 pilot，报告 effect estimate 和全部失败。
稳定信号出现后，再按 P5 登记来源 cluster、重复数、holdout 和统计检验。

## 当前 scientific-discovery 迁移的结论上限

Canonical 迁移只验证：

- legacy `nexgent.benchmarks` 入口、历史命令和记录仍保留；canonical 路径把一个
  synthetic case 对应到一个 TaskSpec/Episode，两代 ID 不互认；
- 隐藏 forecast 不进入 agent payload；
- 项目私有 release key 通过 HMAC 派生隐藏生成 seed、统计单元 ID 和不透明 family
  cluster，公开 seed 本身不暴露这些身份；
- 固定 reference AgentPackage 是无模型 control，并在 legacy/canonical 评分器上数值一致；
- DomainPack 数值工具由宿主可信计量，返回值中的工作单位只作诊断；
- observed zero、missing、暂停恢复和 evaluator identity 符合通用合同。

canonical `final_holdout` 映射到已使用过的历史 confirmation 分布；历史 scientific
数据和 seeds 只能做迁移 golden/regression，不能作为新的科学或 RSI 证据。正式研究需要新鲜
host-private holdout release、更多独立来源 cluster、独立 evolution repeats、固定控制臂、
真实 provider 收据、多任务族矩阵和独立复现。
