# D1-C 真实 MiMo 检查点探针结果

2026-09-24，预注册合同 [`CONTRACT.md`](CONTRACT.md) 修订 `2026-09-24/D1-C.2`，attempt `d1c-live-20260924a`。四条件离线预检先通过，随后在干净提交 `8486897` 上冻结 [run manifest](receipts/d1c-live-20260924a/run_manifest.json)，按固定顺序运行四个 Episode。使用真实 `mimo-v2.6-flash`，每次 provider attempt 为 1，SDK 自动重试为 0。原始 [evidence](receipts/d1c-live-20260924a/evidence.json) 与 [四行结果](receipts/d1c-live-20260924a/results.jsonl) 保留；本页不替换预注册判据。

## 结论

**D1-C 本次真实模型机制探针失败。** 四个 Episode 均执行了初始 DAG 的一次模型草稿和一次宿主 validator 调用，但草稿不满足冻结的 base-policy 完整交付前提。Validator 因而在进入中途策略选择前给出 `precondition_failure`。四行均无 selector 收据、无后端切换、无 handoff 消费，最终质量未通过；H1 不成立，H2–H5 所要求的真实切换、修复和恢复不能据此判为通过。此前 D1-B 的真实负结果不受本次结果改变。

| 条件 | 模型调用 | validator verdict | selector | 切换 / handoff | 最终质量 |
| --- | ---: | --- | ---: | --- | --- |
| D1C-SWITCH-PRIMARY | 1 | `precondition_failure` | 0 | 无 / 无 | 失败 |
| D1C-NO-GAP | 1 | `precondition_failure` | 0 | 无 / 无 | 失败 |
| D1C-INFRA-CONTROL | 1 | `precondition_failure` | 0 | 无 / 无 | 失败 |
| D1C-SWITCH-RECOVERY | 1 | `precondition_failure` | 0 | 无 / 无 | 失败 |

合计 4 次模型调用、14,000 completion-token reservations、4 次本地 validator 调用；批次及各 Episode 预算没有超限，deadline 身份保持稳定。每行的 `checkpoint_action=continue_without_selector` 是 **前提失败时不准入 selector 的保护行为**，不能解释成模型选择了继续。恢复条件没有到达故障注入点，因此也没有得到真实恢复证据。

## 失败归因

四份草稿都给出了六项检查与 `hold` 结论，并识别 borealis 的 sev2 和 cygnus 的 rollback 问题；但 base 前提的证据引用均不符合版本 1 输入，两个 blocker 使用自然语言描述而非冻结 evaluator 所要求的字段名。宿主只按合同机械归一化 `policy_revision` 和首项政策引用，没有改写实质判断；因此 base 仍失败。更新政策下也缺少 material update 后 borealis / cygnus 的 coverage blocker。原始逐项检查和草稿内容见 evidence；这不是 Provider 连接或 JSON 解析失败。

这也暴露了实验设计张力：任务要求的是“仅由输入支持的 blockers”，模型给出的自然语言理由在语义上有依据；当前 validator 却要求字段名完全相等。严苛的 base 前提在本次阻断了原本要研究的编排切换。**不能在已冻结 attempt 中放宽评分、删掉失败行或补做模型修复。** 下一次应先另行修订合同：把语义正确性与规范字段编码分开评分，公开并冻结可机器检查的 blocker 表示；或者允许预注册的同预算草稿修复步骤，再研究检查点。新尝试必须用新 ID、manifest 和原始收据，并以固定 DAG、固定 entry、同预算单智能体作后续效果对照。领域例题只属于实验包，核心运行时不应为发布审查特化。
