# 已计量 JSON 格式修复后的普通任务探针

状态：READY；2026-09-24。代码基线 `790d89f`；在本轮 Provider 调用前提交。研究问题：两阶段严格 JSON 格式恢复和图静态预检是否允许真实普通任务反馈越过此前上游失败，形成可执行候选并进入独立 selection／guard／跨进程复用？单次开发期机制探针，不估计 RSI 净收益。

- 新隔离项目 `NExgent-live-metered-repair-20260924`；普通 `nexgent task`；本机已授权 `mimo-v2.6-flash`。密钥只在进程中读本机 Manyselves 配置。来源为 Workbench development seed 18 的公开 objective、inputs、deliverables、constraints；不传 `_evaluation`。允许 `workbench.inspect_sources`、`workbench.validate_delivery`；channel `workbench-rsi`，R0 `workbench-r0`。
- 来源、selection、guard 每 Episode 上限 12 次模型调用／48,000 预留完成 token／24 次工具调用／96 节点。R0 可放弃或选择任一可用路由，不强制搜索。若选择 O 搜索，最多 2 次尝试，从 development seed 18 起扫描最多 8 个 seed，排除与来源同内容的题，最低均值增量 0；搜索总额 24／96,000／32／240，单个 development Episode 上限 8／32,000／16／96。
- selection seed 0，guard seed 0；最小质量增量 0.01、成功率 1、回归 0、成本比至多 3，guard 最低分和成功率 1。格式恢复最多增加一次模型调用，两次分别计费；首调用计量不完整或状态未知时不得再发。静态预检拒绝的候选不得消耗 development 配对。
- 只有候选晋升且 guard 通过，才由**新进程**用 final_holdout seed 19 检查后续包加载、组件激活和质量。其余情况按实际原因终止，不改题、提示、预算或重试挑选成功。记录来源、R0、候选、development、selection、guard 与复用的状态及实际计量；仓库收据不包含密钥、原始模型输出、私有答案或工件正文。负结果原样报告。
