# Architect 输出上限修正后的普通任务探针

状态：READY；2026-09-24。代码基线 `75377bd`；在 Provider 调用前提交。研究问题：通用自编排 architect 单次额度从 5000 提至 8000、默认网关上限 12000 后，普通任务反馈能否越过此前截断，并走到有效编排候选、development、selection、guard、跨进程复用？这仍是单次开发期机制探针，不估计 RSI 收益。

- 新隔离项目 `NExgent-live-architect-budget-20260924`；普通 `nexgent task`；本机 `mimo-v2.6-flash`。密钥只在进程中读取本机 Manyselves 配置。来源为 Workbench development seed 20 的公开字段，不传 `_evaluation`；允许 `workbench.inspect_sources`、`workbench.validate_delivery`。channel `workbench-rsi`、R0 `workbench-r0`。
- 来源、selection、guard 每 Episode 上限 12 次模型调用、48,000 预留完成 token、24 次工具调用、96 节点。R0 自主选择放弃或可用路由。若选择 O 搜索，最多 2 次尝试，从 development seed 20 起扫描最多 8 个 seed，排除来源同内容，最低 development 均值增量 0；搜索合计上限 24／96,000／32／240，单个 development Episode 8／32,000／16／96。
- selection seed 0、guard seed 0；最低质量增量 0.01、成功率 1、回归 0、成本比至多 3，guard 最低分和成功率 1。仅晋升且 guard 通过后，才在新进程用 final_holdout seed 19 检查加载、实际激活和质量。
- 一次按冻结输入运行，不换题、改提示、增预算或重试挑成功。记录实际模型调用、预留／实耗 token、错误类别、候选图增量、development/selection/guard 状态和 channel revision。基础设施或计量不完整时应按终止失败处理。仓库只存脱敏收据；私有答案、模型原文、凭据不入库。
