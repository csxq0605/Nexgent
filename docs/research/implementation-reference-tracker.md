# Nexgent 实现与目标／来源对照账本

日期：2026-09-23。每个阶段提交更新本表，按**目标合同 → 实际代码和运行收据 → 论文／参考源码的机制 → 未通过的出口**记录。状态只用“目标已定义”“实现中”“确定性通过”“真实任务通过”“独立效果通过”，不凭文件存在判完成。正式验收以[当前计划](../../REFACTOR_PLAN.md)各阶段出口为准；旧实验的成功与失败保留在[研究索引](README.md)。

| 阶段 | 目标与来源 | 当前实际证据 | 出口状态／下一项 |
| --- | --- | --- | --- |
| A 内核选型 | [同题小样](../../experiments/kernel_spike/CONTRACT.md)；[DeepSeek 架构](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/docs/architecture.md)服务／provider／工具分离 | [A1 固定源码对照](kernel-reference-audit-20260923.md)；[A2 运行记录](../../experiments/kernel_spike/RESULTS.md)：Python 预先授权路径通过、任务内装入拒绝；DeepSeek 固定模型同题 headless 两次通过 Agent 作用域工具处理器注册／释放、模型接口、主 session 持久调用与最终交付；profile 级插件仍预装，第二 Agent 拒绝仅在 side receipt，尚无 Episode 桥接 | A1 已完成，A2 实现中；补评价投影、重启恢复、任务内插件生命周期和真实模型检查，再提交 ADR |
| B 能力内核 | DeepSeek scoped registry、可替换 loop；Nexgent 自有 Episode 和权限账本 | 已安装 DomainPack 工具；`ToolRegistry` 只有注册，没有任务作用域装入／卸载 | 未开始；依赖 A 选型 |
| C 自主能力开发 | DeepSeek Creator 的发现／管理入口；通用工具与服务插件双对象 | `develop_skill` 受限技能的局部实证；无通用插件运行 | 未开始；需真实模型开发并使用两种插件能力 |
| D 执行与编排 | [AutoSci](https://arxiv.org/abs/2605.31468v1)技能／图更新、[ADAS](https://arxiv.org/abs/2408.08435v2)代码 Agent、[AFlow](https://arxiv.org/abs/2410.10762v4)工作流搜索 | 真实模型完成 7 节点 DAG；反馈后的第二版图未完成 | 未达新出口；需非 DAG 后端与真实中途策略修改 |
| E 持续进化 | AutoSci SciEvolve、Nexgent 候选／评价／guard 合同 | 图候选确定性采用复用；真实 O/S 未晋升、M abstain | 未达新出口；需任务来源的工具／服务插件在独立任务采用和调用 |
| F 效果与递归 | [RHI](https://arxiv.org/abs/2607.15524v1)信息流、[HSI](https://arxiv.org/abs/2608.08466v1)三级更新及后代评价 | 确定性研究执行器；无真实跨任务净收益／递归收益 | 未开始正式研究；先完成 C–E 实际路径 |
| G 产品 | Main 展示同一任务／版本／能力身份 | Main 早期界面和高级控制台；无插件树及完整演化投影 | 未达出口；最小视图随 B–E 接入 |

更新规则：每条新“已实现”要附代码和定向运行证据；“效果改善”另附独立任务、父子对照、成本与失败。上游参考固定 SHA／论文版本；确需升级时注明迁移影响。负结果和基础设施问题也追加，不删除前一次结论。子智能体审查、手写小样及模型替身均不能替代 Nexgent 产品的自动执行证据。
