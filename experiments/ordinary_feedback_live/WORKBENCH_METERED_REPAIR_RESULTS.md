# 已计量格式修复后的普通任务探针结果

按先推送的 [READY 合同](WORKBENCH_METERED_REPAIR_CONTRACT.md)，新隔离项目用 `mimo-v2.6-flash` 从普通 CLI 入口执行 Workbench development seed 18 的公开任务。[脱敏收据](workbench-metered-repair-receipt-20260924.json)只保留状态、调用、计量完整性及固定错误码；原始 Episode 和搜索账本位于本机 `E:/PKU/program/2026/Aug/te/NExgent-live-metered-repair-20260924/.nexgent`。

**结果仍为负。** 来源任务首次 architect 调用耗尽自身 5000-token 输出上限，1 次调用后以 agent-domain `ModelBudgetError` 结束，计量完整。R0 另用 1 次调用完成开发规划，选择 O 搜索。第一次候选生成用 1 次调用，补丁缺 `hypothesis.component_ids`，收到固定错误码 `missing_hypothesis_component_ids`；第二次用 1 次调用遇到 Provider 传输故障，计费／使用量不完整。没有有效候选、development 配对或 selection；guard 与新进程复用均未运行，channel revision 为 0。两阶段 JSON 格式修复这次没有触发，图静态预检也没有获得候选，因此本轮不能评价两项新机制的真实效果。

该次代码基线把第二次基础设施故障当普通生成失败，最终记成 `orchestration_search_exhausted`。这是**新发现的归因错误**，不是模型质量或编排质量证据。随后修复搜索器：生成 Episode 为基础设施失败或生成使用量不完整时，按已知使用量记账并以不可重试的 generation 失败终止，不再构造修复提示或报告普通搜索耗尽。30 项搜索定向测试通过。修复不重写本轮历史状态；真实普通任务仍未完成合格候选→selection→guard→复用。

来源首次 architect 调用以 `finish_reason=length` 达到恰好 5000 token 的固定上限。随后将通用自编排种子的 architect 单次输出额度从 5000 提到 8000，并把默认宿主网关上限提到 12000；仍受 Episode 总模型调用和 token 预算约束。14 项自编排／动态图定向测试通过。这是对观测到的输出截断作资源修正，并未证明更高额度会改善任务质量；本轮仍按原 5000 上限解释。
