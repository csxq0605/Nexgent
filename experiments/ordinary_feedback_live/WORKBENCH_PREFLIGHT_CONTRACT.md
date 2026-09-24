# 编排候选静态预检的真实机制探针

状态：READY；2026-09-24；本合同在本轮 Provider 调用前提交。代码基线 `0308b3c`。上一轮[同题搜索复测](WORKBENCH_SEARCH_REPAIR_RESULTS.md)发现候选 `ask` 参数不合法，但仍进入配对评价并浪费父臂调用；这轮检验宿主预检和公开错误码是否把该失败移到评价前。它是开发期机制探针，不是 RSI 收益确认。

## 冻结设置

- 新隔离项目 `NExgent-live-preflight-20260924`，普通 `nexgent task`，`mimo-v2.6-flash`；密钥只在进程中从本机 Manyselves 配置读取。
- 来源 Workbench development seed 15 的公开 objective／inputs／deliverables／constraints，不传 `_evaluation`。允许既有 `workbench.inspect_sources` 与 `workbench.validate_delivery`。channel `workbench-rsi`；默认 R0 `workbench-r0`。来源与 selection／guard 各 Episode 上限 12 次模型调用、48,000 预留完成 token、24 次工具调用、96 个节点。
- R0 可选择直接 O/S 补丁、O 搜索、能力采用或放弃，不强制路由。若选择搜索，最多 2 次尝试，首个 development seed 15、最多扫描 8 个 seed，最低均值增量 0；搜索合计 24 次模型调用、96,000 预留完成 token、32 次工具调用、240 个节点，每开发 Episode 限 8／32,000／16／96。与来源内容相同的开发样本须排除。
- 独立 selection seed 0，guard seed 0；质量增量至少 0.01、成功率 1、回归 0、成本比不超过 3，guard 最低分和成功率为 1，与前轮晋升门相同。

## 观察和停止

记录来源／R0 调用、候选生成、静态预检是否拒绝及其固定错误码、每个开发配对的真实调用和资格结果、后续 selection／guard／revision。预检拒绝的候选不得启动父或候选 Episode；下一尝试只能接收有界固定反馈。若 R0 未选搜索或两次尝试无合格候选，如实停止且不换题／预算／提示。只有 selection 晋升并通过 guard，才在新进程用 Workbench final_holdout seed 19 检查后续加载。该开发期结果不计入独立多任务效果统计。
