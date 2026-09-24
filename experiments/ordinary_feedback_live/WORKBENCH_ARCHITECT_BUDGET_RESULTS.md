# Architect 输出上限修正后的普通任务结果

状态：负结果；2026-09-24。按 [冻结合同](WORKBENCH_ARCHITECT_BUDGET_CONTRACT.md)只运行一次，项目为 `NExgent-live-architect-budget-20260924`，使用 `mimo-v2.6-flash`。本记录只保留状态、错误类别和计量，不保存模型原文、私有评价或凭据。

| 阶段 | 观察 |
| --- | --- |
| 来源普通任务 | Episode `episode-cde312a3e3c7446e` 在 2 次模型调用、1 次工具调用后失败；`publish_ledger` 的记录带有 schema 不允许的 `deleted` 字段。首个 architect 调用已越过上一探针的 5000 token 截断，不能因此认定任务成功。 |
| 默认 R0 | Episode `episode-0819423ce37546b7` 完成，选择有界 O 搜索。 |
| 候选 1 | Episode `episode-5053b38671a14ad5` 完成；生成记录 `generation-63fb97a32adf427d` 因 `replace` 操作带 `path` 被 PackagePatch 合同拒绝。错误码 `replacement_forbids_path` 进入第二次修复输入。 |
| 候选 2 | Episode `episode-d96bf4a1a9cb4130` 失败；Provider worker 达到 180 秒 wall-time，远端是否完成未知，计量不完整。生成记录 `generation-1088fefe5066491b` 为 `ModelTransportError`。 |
| 决策 | 搜索累计已知 2 次模型调用、12,000 完成 token 预留、14 节点；第二次作为 `GenerationInfrastructureFailure` 终止，`retry_safe=false`，`qualified_count=0`。反馈工作 `feedback-work-34dff6b40c91d55cb31c2763` 被拒绝；channel `workbench-rsi` 仍为 revision 0。没有 development 配对、selection、guard 或新进程复用。 |

**判定：** 提高 architect 单次上限消除了上一探针的直接截断，却没有接通真实模型闭环。这一运行不能判断候选修复是否有效，也不能据此宣称编排改善；第二次调用属于远端结果未知，禁止重放该调用来补一个成功样本。下一阶段先保证模型生成的候选能够进入开发配对，再观察真实 selection、guard 和后续任务激活；每个失败保留为独立记录。
