# 外部执行后端与 Nexgent 证据合同（A2 诊断版）

日期：2026-09-23。此合同来自[同题小样](../../experiments/kernel_spike/CONTRACT.md)和[实跑记录](../../experiments/kernel_spike/RESULTS.md)，**尚未决定采用外部执行后端**。它防止把一次 DeepSeek session 的成功输出误记为 Nexgent 已准入、计费和完成的 Episode。

## 两种身份必须分开

1. **原执行**：DeepSeek Harness session，持久事件中的 session id、seq、请求 header、模型消息、工具调用／结果、turn end 和原始日志摘要是其来源身份。插件 side receipt 另存实际 handler／schema／依赖／作用域的摘要与装卸时刻。上游 JSONL 没有 Nexgent 的预算预留与 evaluator 冻结身份。
2. **诊断投影**：独立的 Nexgent Episode 可以把上述日志作为输入，由可信校验 package 重新读取、检查、发布 `result` 和 `external_evidence`，再接受一个仅针对这份投影的 BenchmarkAdapter 评分。这个 Episode 的 `completed` 只表示**投影程序完成**，不能继承为原 DeepSeek 运行的状态。

投影至少拒绝：session id 不一致、seq 缺口、工具 call/result 不成对、首个 schema 与处理器摘要不符、卸载后仍可调用、另一作用域可见、最终结果与持久消息不一致、side receipt 或源文件摘要改变。诊断必须同时保留负结果，不能只保存 `summary.json` 的布尔值。日志里可能有任务上下文与模型内容；产品桥接需要受限工件访问和脱敏投影，不能把整份原始日志直接展示在 Main。

## 生产执行所需的线性化点

若选择外部后端，Nexgent 宿主必须在模型或工具**实际分发之前**原子地登记请求身份、预算、能力版本与授权结果，再把调用交给后端。后端返回或失败后登记对应结算；进程中断时若外部结果未知，先查询同一调用身份的状态，不得静默重放。仅在已核对交付工件和持久轨迹后，宿主通过公开 finalize 接口将原 Episode 标记完成，并交给冻结的 BenchmarkAdapter。事后读 JSONL 再补一条 reservation 不能满足这一合同。

现有 `TaskService` 还没有公开的外部执行／finalize 接口；`capabilities` 在 Episode 创建时冻结，`ToolRegistry` 没有任务级卸载；默认 evaluator 的 execution view 只接收已登记工具事件与用量，不自动看到外部 session。阶段 A3 应把这些接口成本与 DeepSeek 的作用域／持久事件优势一起计入技术选择。阶段 B 需要选择**一个**生产执行主路径，不能长期把两个宿主的独立预算账都说成 Nexgent 的同一证据链。
