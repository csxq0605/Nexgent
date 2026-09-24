# 固定补丁错误码后的普通任务搜索复测

状态：READY；2026-09-24；任何本轮 Provider 调用前提交。上一轮[真实搜索负结果](WORKBENCH_SEARCH_FLOW_RESULTS.md)不重写。本轮只检验 `0f77f62` 的宿主固定错误码和默认 R0 提示能否让真实搜索从“生成无效补丁”推进到可执行候选及开发资格评估。重复 Workbench development seed 13 是机制复测，不算独立任务或 RSI 效益样本。

## 冻结设置

- 新隔离项目 `NExgent-live-search-repair-20260924`；普通 `nexgent task`；模型 `mimo-v2.6-flash`。密钥仅由本机 Manyselves 配置在进程内加载，不写入仓库、项目配置或收据。
- 来源、工具、单 Episode 限额、channel／R0、selection／guard seed、晋升门与[上一轮合同](WORKBENCH_SEARCH_FLOW_CONTRACT.md)完全相同：来源为 Workbench development seed 13 的公开字段，每 Episode 最多 12 次模型调用、48,000 预留完成 token、24 次工具调用、96 个节点。
- 搜索仍最多 2 次候选尝试，首个 development seed 13、最多扫描 8 个 seed，最低均值增量 0；合计限额为 24 次模型调用、96,000 预留完成 token、32 次工具调用、240 个节点，每开发 Episode 限 8／32,000／16／96。R0 可自主选直接补丁、编排搜索或放弃，不强制其选择。重复来源样本须由宿主排除。
- 此次代码变化仅为固定补丁验证错误枚举、明确拒绝 replacement 中的多余 `path`、默认 R0 对该合同的提示。原始异常、模型输出、隐藏评价数据均不得进入 repair brief；未知错误退回粗粒度类名。

## 判定与停止

记录 R0 路由、每次生成的固定错误码及修复输入、候选的真实执行图变化、开发资格评估、独立 selection、guard、revision 和后续加载。若未选搜索或无合格候选，照实停止；不换 seed、提示、预算或增加第三次尝试。若 selection 不通过，不运行 guard 或复用。只有晋升且 guard 通过，才在新进程以 Workbench final_holdout seed 19 作纵向加载检查。不得把这次重复题机制复测用作独立统计收益证据。
