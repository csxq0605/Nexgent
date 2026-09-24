# 普通任务候选修复闭环探针

状态：READY；2026-09-24。代码基线 `f8fbbab`。在任何本轮 Provider 调用前提交本合同。研究问题是：完整普通任务反馈能否通过默认 R0 产生可执行编排候选，在独立 development 上接收有界宿主错误码、修复，随后进入 selection、guard、晋升和新任务复用？本轮是单次开发期机制探针，不估计多任务 RSI 收益。

## 冻结输入与资源

- 新隔离项目 `NExgent-live-candidate-repair-20260924`；普通 `nexgent task` CLI 入口；本机已授权的 `mimo-v2.6-flash`。API 密钥只在进程中从本机 Manyselves 配置读取。
- 来源为 Workbench development seed 16 的公开 objective、inputs、deliverables、constraints；不传 `_evaluation`。允许既有 `workbench.inspect_sources`、`workbench.validate_delivery`。channel `workbench-rsi`，默认 R0 `workbench-r0`。来源、selection、guard 每 Episode 上限 12 次模型调用、48,000 预留完成 token、24 次工具调用、96 节点。
- R0 可选择直接 O/S 补丁、O 搜索、能力采用或放弃；不强制搜索。若选择搜索：最多 2 次候选尝试，首个 development seed 16，最多扫描 8 个 seed，来源同内容必须排除，最低 development 均值增量 0；搜索总额 24 次模型调用、96,000 预留完成 token、32 次工具调用、240 节点；单个 development Episode 上限 8／32,000／16／96。
- 独立 selection seed 0、guard seed 0；最小质量增量 0.01、成功率 1、回归 0、成本比不超过 3，guard 最低分和成功率 1。沿用既有通道门槛，不因结果放宽。

## 观察与停止

记录来源/R0/生成/预检/配对 development/selection/guard 的状态、宿主固定错误码、实际模型调用和使用量、channel revision。基础设施或不完整使用量必须停止并留存未知计费；候选预检拒绝不得启动配对。若两次搜索没有合格候选或 R0 选择其他路径，按真实决策停止，不改题、提示或预算重试。只有成功晋升且 guard 通过，才在**新进程**用 Workbench final_holdout seed 19 检查后续包加载和实际激活；否则不碰 final holdout。私有答案、原始模型内容和密钥均不进入仓库收据。结果可为负，不从一次运行推断编排收益。
