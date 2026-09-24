# 普通任务到编排搜索的真实纵向探针

状态：READY；2026-09-24。此合同在本次 Provider 调用前提交。它只检验新增的普通任务反馈接线及其实际可达边界；不是通用 RSI 收益实验。以往 Workbench seed 11 负结果保持原样，不作为本轮独立样本。

## 冻结设置

- 代码基线：`d16b903`；新建隔离项目 `NExgent-live-search-20260924`，使用普通 `nexgent task` 入口和 `mimo-v2.6-flash`。密钥仅从本机 Manyselves 配置加载到试验进程环境，不写入仓库、项目配置或收据。
- 来源任务：`WorkbenchBenchmark.tasks('development', 13)[0]` 的公开 objective、inputs、deliverables、constraints；不读取或传送 `_evaluation`。允许 `workbench.inspect_sources`、`workbench.validate_delivery` 两项既有工具。普通任务使用 `workbench-rsi` channel，默认 R0 为 `workbench-r0`。
- 来源及 selection／guard 的单 Episode 上限：12 次模型调用、48,000 预留完成 token、24 次工具调用、96 个节点。selection 固定 seed 0，guard 固定 seed 0；晋升门沿用上一轮：质量增量至少 0.01、成功率 1、回归 0、成本比不超过 3，guard 最低分及成功率均为 1。
- 新的 opt-in 编排搜索：最多 2 次候选尝试，首个 development seed 13、最多扫描 8 个 seed，开发集最低均值增量 0；搜索合计最多 24 次模型调用、96,000 预留完成 token、32 次工具调用、240 个节点。每个开发集 Episode 最多 8 次模型调用、32,000 预留完成 token、16 次工具调用、96 个节点。宿主排除与来源任务内容相同的样本。
- R0 仍能自主选择 `package_patch` 或 `orchestration_search`；不强制它走搜索。若选其它路线，照实报告新路径未被本轮激活，不换 seed、不换提示、不补做第二次模型尝试。若走搜索，每次生成、公开开发反馈和修复都按持久搜索收据计入；未知结果不重试。

## 观察和停止

记录来源任务、R0 选择、搜索尝试数及修复输入、开发资格结果、独立 selection、晋升、guard、通道 revision 和后续实际加载。若无合格候选或 selection 不过门，立即停止，不声称 guard 或复用。只有晋升且 guard 通过，才在新进程用预留的 Workbench final_holdout seed 19 验证后续加载；它只作为纵向机制检查，不能作为多任务效果统计。所有 Provider 调用、失败及无法测量的成本都保留，不因负结果修改本合同或晋升门。
