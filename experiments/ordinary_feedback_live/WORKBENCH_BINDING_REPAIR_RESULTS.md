# 图绑定修复后的普通入口真实结果

按预先推送的 [READY 合同](WORKBENCH_BINDING_REPAIR_CONTRACT.md)运行一次隔离项目中的普通 `nexgent task`，模型为 `mimo-v2.6-flash`，来源是 Workbench development seed 11 的公开任务字段。原始 Episode 和评价记录保存在本机 `E:/PKU/program/2026/Aug/te/NExgent-live-workbench-binding-20260924/.nexgent`；[脱敏收据](workbench-binding-repair-receipt-20260924.json)只列身份、状态、计量、失败类别和门槛，不含凭据、私有答案或工件内容。

**结果仍为负。** 来源任务用了 4 次模型调用；通用编译器两次拒绝不可能的绑定并将诊断交给模型修复，因此越过了上一轮的 `inspect.result` 早期故障。最终图执行了 1 次真实工具调用，但 `publish_report` 因模型交付的 `input_digest` 为 `PENDING_DIGEST` 而失败，没有产出合格报告。R0 用 1 次模型调用选择 `orchestration / package_patch`，生成候选并修改 `architect-role`。独立 selection 的父臂用 4 次模型调用，因 ledger 缺少必需的 `revision` 失败；候选臂用 3 次模型调用，因下游绑定不存在的 `ledger` 字段失败。两臂得分均为 0；`behavior_activated`、`candidate_completed`、`quality`、`success_rate` 门未过。宿主正确拒绝晋升，通道 revision 仍为 0；没有 guard 或后续复用。

本次证明真实普通入口中的**静态绑定预检和模型编译修复确实运行了**，也证明单次 R0 包补丁没有解决来源问题。扩大预算后仍没有合格任务交付，不能把预算视为唯一根因；新旧尝试预算不同，也不能做等资源效果比较。下一步先把真实失败的结构化诊断接入可恢复的开发期候选修复／qualification，而不是反复在独立 selection 上试单个猜测补丁；同时避免默认通道把无关任务送往固定评价器。原独立晋升门保持不变。多任务 RSI 收益、guard 正例、后续真实复用仍未证明。
