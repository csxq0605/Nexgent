# Nexgent 实现与目标／来源对照账本

日期：2026-09-24。每个阶段提交更新本表，按**目标合同 → 实际代码和运行收据 → 论文／参考源码的机制 → 未通过的出口**记录。状态只用“目标已定义”“实现中”“确定性通过”“真实任务通过”“独立效果通过”，不凭文件存在判完成。正式验收以[当前计划](../../REFACTOR_PLAN.md)各阶段出口为准；旧实验的成功与失败保留在[研究索引](README.md)。

| 阶段 | 目标与来源 | 当前实际证据 | 出口状态／下一项 |
| --- | --- | --- | --- |
| A 内核选型 | [同题小样](../../experiments/kernel_spike/CONTRACT.md)；[DeepSeek 架构](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/docs/architecture.md)服务／provider／工具分离 | [A1 固定源码对照](kernel-reference-audit-20260923.md)；[A2/A3 运行记录](../../experiments/kernel_spike/RESULTS.md)：Python 真实 MiMo 与已安装工具的任务级租约已在同一 Episode 完成，含挂载、预算、调用、交付和释放；委派约束与重启漂移拒绝另有确定性测试。DeepSeek Agent 作用域处理器通过，真实 MiMo 原生 tool call 与工具结果通过但 final JSON 解码失败；外部原执行未受 Nexgent 准入／计费。两组 Windows 固定 adapter 进程终止恢复通过 | [ADR 001](../design/adr-001-python-episode-kernel.md)选 Python Episode 单一生产边界；A 选型出口完成，负结果保留；真正任务中插件开发属于 C，未完成 |
| B 能力内核 | [固定 DeepSeek scoped registry 源码](kernel-reference-audit-20260923.md)、可替换 loop；[新名称授权合同](../design/task-time-capability-authority.md) | 已安装工具的 Episode 租约；新增冻结 EpisodeAuthority、内容寻址 tool Definition、Episode-local Instance、动态 inventory、释放和重启身份核对。确定性纵向任务创建未知名称工具并调用，收据绑定定义、实例、授权和 worker；只允许无凭据、无外部依赖的 `local_compute`。受控 worker 每次限 20 万 trace 事件，收据记实际事件数；现有 `tool_work_units=0` 不代表零计算成本 | 工具子路径确定性通过；B 整体出口未过：没有服务／provider 三层、依赖解析、实际清理和可替换执行策略 |
| C 自主能力开发 | DeepSeek Creator 的发现／管理入口；通用工具与服务插件双对象 | [一次限额真实 MiMo 运行](../../experiments/kernel_spike/evidence-python-dynamic-tool-live-20260924.json)：空清单起步，模型写 `multiply_integers` 源码／schema，Nexgent stage/mount、重新发现、调用，结果 42；同一 Episode 模型 2 次、工具 1 次、7 节点，零重试。确定性任务另验证释放旧 Definition、同名开发新版本并实际调用。通用默认 TaskService 包也已接入开发动作和动态 inventory，确定性网关完成 `develop_tool → tool → publish → done`；**Main 界面仍采用另一图编排种子，未接入**。实验程序预设开发路线，未测模型自主判断是否需要开发 | **C1 工具切片真实任务通过**；C 完整出口未过：服务／策略插件尚未在任务中开发激活；跨任务采用、独立效果、RSI 净收益均未证明 |
| D 执行与编排 | [AutoSci](https://arxiv.org/abs/2605.31468v1)技能／图更新、[ADAS](https://arxiv.org/abs/2408.08435v2)代码 Agent、[AFlow](https://arxiv.org/abs/2410.10762v4)工作流搜索 | 真实模型完成 7 节点 DAG；反馈后的第二版图未完成 | 未达新出口；需非 DAG 后端与真实中途策略修改 |
| E 持续进化 | AutoSci SciEvolve、Nexgent 候选／评价／guard 合同 | 图候选确定性采用复用；真实 O/S 未晋升、M abstain | 未达新出口；需任务来源的工具／服务插件在独立任务采用和调用 |
| F 效果与递归 | [RHI](https://arxiv.org/abs/2607.15524v1)信息流、[HSI](https://arxiv.org/abs/2608.08466v1)三级更新及后代评价 | 确定性研究执行器；无真实跨任务净收益／递归收益 | 未开始正式研究；先完成 C–E 实际路径 |
| G 产品 | Main 展示同一任务／版本／能力身份 | Main 早期界面和高级控制台；无插件树及完整演化投影 | 未达出口；最小视图随 B–E 接入 |

更新规则：每条新“已实现”要附代码和定向运行证据；“效果改善”另附独立任务、父子对照、成本与失败。上游参考固定 SHA／论文版本；确需升级时注明迁移影响。负结果和基础设施问题也追加，不删除前一次结论。子智能体审查、手写小样及模型替身均不能替代 Nexgent 产品的自动执行证据。
