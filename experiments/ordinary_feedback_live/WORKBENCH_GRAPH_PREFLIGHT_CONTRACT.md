# 可执行编排预检的普通任务机制探针

状态：READY；2026-09-24。代码基线 `90aae8f`；在本轮任何 Provider 调用前提交。检验上一轮新增的 `ask` 参数与无效根图字段预检能否把真实候选的结构失败反馈给第二次生成，并观察真实任务来源是否走到 development、selection、guard 和新任务复用。这是单次开发期机制探针，不估计 RSI 净收益。

- 新隔离项目 `NExgent-live-graph-preflight-20260924`；普通 `nexgent task`；本机 `mimo-v2.6-flash`。API 密钥只在进程中从本机 Manyselves 配置读取。来源为 Workbench development seed 17 的公开 objective、inputs、deliverables、constraints，不传 `_evaluation`；沿用 `workbench.inspect_sources`、`workbench.validate_delivery`。channel `workbench-rsi`、R0 `workbench-r0`。
- 来源、selection、guard 每 Episode 上限 12 次模型调用／48,000 预留完成 token／24 次工具调用／96 节点。R0 可放弃或选择已支持的任一路由，不强制搜索。若进入 O 搜索，最多 2 次尝试，从 development seed 17 起扫描最多 8 个 seed 并排除同内容来源，最低均值增量 0；搜索总额 24／96,000／32／240；单个 development Episode 上限 8／32,000／16／96。
- selection seed 0、guard seed 0；质量增量至少 0.01、成功率 1、回归 0、成本比至多 3，guard 最低分和成功率 1。预检失败的候选不得消耗 development 配对。只有晋升且 guard 通过，才由新进程用 final_holdout seed 19 检查加载和激活。
- 按实际决策与预算一次运行，不换题、提示、预算或重试挑选结果。记录每次生成状态、固定失败码、development/selection/guard 状态、使用量、channel revision；基础设施或计量不完整即停并记录未知成本。仓库收据不得包含密钥、模型原文、私有答案或工件正文。负结果原样报告。
