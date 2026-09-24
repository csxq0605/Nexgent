# 静态预检机制探针结果

按[预先推送的 READY 合同](WORKBENCH_PREFLIGHT_CONTRACT.md)，在隔离项目对 Workbench development seed 15 的公开任务运行一次普通 CLI 入口，模型 `mimo-v2.6-flash`。[脱敏收据](workbench-preflight-receipt-20260924.json)保留终态、身份、计量及错误类别。**本轮没有检验到候选静态预检。**

来源 Episode 的第一次模型调用在 DNS 解析阶段失败，计费状态未知，`failure_domain=infrastructure`、`usage_complete=false`。旧反馈入口仍将它当作普通任务失败：R0 用 1 次调用选择 O 搜索；两次候选生成各用 1 次调用，分别因工作流 JSON 无效、紧凑 PackagePatch 含未知字段而失败。没有形成候选，也就没有预检、开发资格评估、selection、guard 或复用；channel revision 仍为 0。此轮不能说明 `0308b3c` 的真实模型效果。

真实运行暴露了更上游的控制错误：**基础设施故障和计量不完整的来源不该进入 RSI 改进。** 随后在普通反馈捕获前新增 fail-closed 门：`failure_domain=infrastructure` 或 `usage_complete` 不为 true 时，工作项转为 deferred，不构建 FeedbackBundle、运行 R0 或生成候选。16 项触发器定向测试通过，覆盖两种入口条件。此修正不会重写本轮已发生的 Provider 调用或负结果。下一轮应先确认该入口门在真实配置下生效，再挑选有完整反馈的来源检验候选预检；本次不追加重试。
