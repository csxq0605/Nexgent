# D1-C 真实 MiMo 检查点探针结果

2026-09-24，合同草案 [`CONTRACT.md`](CONTRACT.md) 修订 `2026-09-24/D1-C.2`，attempt `d1c-live-20260924a`。四条件离线预检先通过，随后在干净提交 `8486897` 上冻结 [run manifest](receipts/d1c-live-20260924a/run_manifest.json)，按固定顺序运行四个 Episode。使用真实 `mimo-v2.6-flash`，每次 provider attempt 为 1，SDK 自动重试为 0。原始 [evidence](receipts/d1c-live-20260924a/evidence.json) 与 [四行结果](receipts/d1c-live-20260924a/results.jsonl) 保留。

**研究状态勘误：这不是正式预注册确认实验。** Manifest 冻结的合同首页仍写着“草案；不得运行”，而本次已经发起 Provider 请求；离线预检成功不能替代合同状态核准。本次按原条件无挑选保留为**探索性失败尝试**，不能作为预注册机制假设的确认或否定证据。前一版结果页误称“预注册合同”，本段公开更正；原 manifest、合同及四行原始数据不回写。

## 结论

**D1-C 本次探索性真实模型尝试未触及待测切换机制。** 四个 Episode 均执行了初始 DAG 的一次模型草稿和一次宿主 validator 调用，但草稿不满足当时 validator 的 base-policy 完整交付门槛。Validator 因而在进入中途策略选择前给出 `precondition_failure`。四行均无 selector 收据、无后端切换、无 handoff 消费，最终质量未通过；按原草案判据 H1 不成立，H2–H4 未实际检验，H5 只看到控制行未调用 selector，却因质量门失败不能支持。此前 D1-B 的真实负结果不受本次结果改变。

| 条件 | 模型调用 | validator verdict | selector | 切换 / handoff | 最终质量 |
| --- | ---: | --- | ---: | --- | --- |
| D1C-SWITCH-PRIMARY | 1 | `precondition_failure` | 0 | 无 / 无 | 失败 |
| D1C-NO-GAP | 1 | `precondition_failure` | 0 | 无 / 无 | 失败 |
| D1C-INFRA-CONTROL | 1 | `precondition_failure` | 0 | 无 / 无 | 失败 |
| D1C-SWITCH-RECOVERY | 1 | `precondition_failure` | 0 | 无 / 无 | 失败 |

合计 4 次模型调用、14,000 completion-token reservations、4 次本地 validator 调用；批次及各 Episode 预算没有超限，deadline 身份保持稳定。每行的 `checkpoint_action=continue_without_selector` 是 **前提失败时不准入 selector 的保护行为**，不能解释成模型选择了继续。恢复条件没有到达故障注入点，因此也没有得到真实恢复证据。

## 失败归因

四份草稿都给出了六项检查与 `hold` 结论，并识别 borealis 的 sev2 和 cygnus 的 rollback 问题；但 base 前提的证据引用均不符合 evaluator 要求，两个 blocker 使用自然语言描述而非 evaluator 所要求的字段名。宿主只按草案机械归一化 `policy_revision` 和首项政策引用，没有改写实质判断；因此 base 仍失败。更新政策下也缺少 material update 后 borealis / cygnus 的 coverage blocker。原始逐项检查和草稿内容见 evidence；这不是 Provider 连接或 JSON 解析失败。

这也暴露了**实验接口与评价合同不一致**：公开 schema 把 `blockers` 定义成任意字符串，模型因此返回有依据的自然语言理由，evaluator 却要求字段名完全相等；drafter 输入使用 `service_reports.atlas` 等键，模型准确引用这些可见路径，evaluator 却要求未明确暴露给 drafter 的 `atlas_report.json` 等工件名。独立复核还发现 summary 的邻近正则可能把后文 borealis 的 `fail` 错归给 atlas，造成 PRIMARY 的一项假阴性。严苛且不一致的 base 门槛阻断了原本要研究的编排切换。**不能在已运行的 attempt 中放宽评分、删掉失败行或补做模型修复。** 下一次须先提交标记 `READY` 的新合同和新 attempt，再生成 manifest；让结构化 blocker 字段与稳定工件 ID 在模型输入和 evaluator 中一致，并为 summary 评分补顺序置换／同义表达测试。应分开报告任务语义、输出协议、编排机制；先用保证 base-valid 的草稿隔离检验真实 selector / handoff，再跑端到端模型草稿，最后做固定 DAG、固定 entry、同预算单智能体对照。领域例题只属于实验包，核心运行时不应为发布审查特化。
