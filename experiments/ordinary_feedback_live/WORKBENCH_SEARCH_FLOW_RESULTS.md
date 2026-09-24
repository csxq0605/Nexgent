# 普通任务到编排搜索的真实纵向结果

按[预先推送的 READY 合同](WORKBENCH_SEARCH_FLOW_CONTRACT.md)在隔离项目 `E:/PKU/program/2026/Aug/te/NExgent-live-search-20260924` 运行一次普通 CLI 任务；模型为 `mimo-v2.6-flash`，来源是 Workbench development seed 13 的公开字段。[脱敏收据](workbench-search-flow-receipt-20260924.json)只保留身份、状态、计量和公开接口错误类别。首次 CLI 启动在 Provider 调用前暴露项目配置二次规范化缺陷；修复并推送 `0760175`、更新合同基线后才运行该次模型探针。未更换来源、预算或晋升门。

**结果：搜索真实激活，但没有生成合格候选。** 来源 Episode 进行了 3 次 MiMo 调用、1 次工具调用，因 `ledger/conflicts/0/revision` 必填字段缺失而失败。R0 用 1 次 MiMo 调用选择 `orchestration_search`。搜索第 1 次生成用 1 次模型调用，补丁缺少 `hypothesis.component_ids`，包合同拒绝；第 2 次亦用 1 次模型调用，替换内容违反 PackagePatch 合同，继续拒绝。两次均未产生候选，故开发资格评估、独立 selection、guard 和后续复用均未运行；工作状态为 `orchestration_search_exhausted`，通道 revision 仍为 0。

这次证明“普通任务反馈 → R0 路由 → 有界两轮生成／修复 → 持久拒绝”的真实模型路径可达，不能证明候选改进或 RSI 效果。第 1 次的可公开 schema 路径没有进入第 2 次修复输入；修复器只收到 `generation_PackageError`。下一步应把**宿主验证器产生的、脱敏且有界的结构化补丁错误**投影给后续尝试，并定向验证候选可进入开发资格评估；不修改旧结果，不放宽独立晋升门。
