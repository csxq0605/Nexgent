# 可执行编排预检探针结果

按先推送的 [READY 合同](WORKBENCH_GRAPH_PREFLIGHT_CONTRACT.md)，从新隔离项目运行一次 Workbench development seed 17 的公开普通任务，模型 `mimo-v2.6-flash`。[脱敏收据](workbench-graph-preflight-receipt-20260924.json)不含密钥、原始模型输出、私有答案或工件正文；本机原始账本位于 `E:/PKU/program/2026/Aug/te/NExgent-live-graph-preflight-20260924/.nexgent`。

**结果为负，未检验到图预检。** 来源任务用了 4 次模型调用、3 次工具调用，以 `KeyError` 协议失败，使用量完整。普通反馈随即启动默认 R0 的开发规划 Episode。MiMo 用 1 次调用返回了完整 JSON 对象后又追加文本，严格网关以 `ModelError` 拒绝；解析错误类别为 `extra_data_after_complete_object`。系统把反馈工作项记为 `development_episode_incomplete` 并停止。没有候选生成、预检、development 配对、selection、guard 或新任务复用，channel revision 仍为 0。

不能把这一轮算作上一轮图预检修复成功或失败。它指出更上游的格式鲁棒性缺口：一次已计量、已返回的模型输出因多余尾随文本终止整个普通反馈工作。下一步需在明确记账和有界预算内处理这种可归因的格式失败，同时维持严格单对象合同；不能偷偷截取 JSON 前缀、吞掉尾随内容或重发计费未知的请求。旧负结果保留，新机制要先定向验证再冻结新探针。
