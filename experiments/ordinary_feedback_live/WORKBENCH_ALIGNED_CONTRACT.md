# 同任务族普通入口 RSI 探针合同

状态：READY；2026-09-24。此合同在 Provider 调用前固定。目标是检验普通入口能否把 Workbench 开发任务的反馈变成跨任务候选，并在同一任务族的独立 selection／guard 中保留有效版本。它是一次工程机制探针，不是统计效益研究。

## 冻结设置

- 模型：本机已配置的 `mimo-v2.6-flash`，密钥仅从本机 Manyselves 配置注入进程；仓库不保存凭据。
- 独立插件：已安装 `workbench` BenchmarkAdapter。源任务为 `WorkbenchBenchmark.tasks('development', 11)[0]` 的公开字段，从普通 `nexgent task` 入口提交；不得从宿主私有 `_evaluation` 读取预期答案。
- 通道：`workbench-rsi`；首次缺失时注册通用 self-orchestration 包。改进器通道：`workbench-r0`，首次缺失时注册通用双入口 R0。唯一评价器 `workbench`；selection 为 seed 0，guard 为 seed 0。
- 源 Episode 与每个评价臂上限：8 次模型调用、32,000 预留完成 token、12 次工具调用、48 个节点。开发／候选生成各自沿用项目策略预算。模型请求、计划和预算由实际 Episode 收据计量。
- 晋升门：`min_quality_delta=0.01`、`min_success_rate=1`、`max_regressions=0`、`max_cost_ratio=3`、`max_absolute_cost_when_parent_zero=100000`；guard 需 `monitor_min_score=1`、`monitor_min_success_rate=1`。不得因结果不佳而放宽。
- 单次尝试，不自动重试未知外部结果，不更换 seed，不手工替模型指定候选。结果必须保留 `no_change`、rejected、deferred、rolled_back 等负路径。

## 观测与判断

记录源任务、公开反馈、R0 规划、候选、配对计划／两臂报告、各晋升 gate、guard、通道 revision 与模型用量的 ID／摘要，不存凭据和隐藏答案。若没有候选，结论停在开发阶段。若 selection 不满足所有 gate，结论为拒绝；不运行 guard。若晋升且 guard 通过，再用 `workbench` final_holdout seed 19 的同一任务运行时检查新包实际加载；这仍只是一条工程样本。后续普通任务的 `reuse_observed` 与多 seed、固定编排／等预算单智能体／仅记忆对照另行评价，不由本次单样本推断。

成功的最小机制条件：源任务有真实模型调用；R0 返回可证伪候选；candidate 在独立 selection 中完成并产生真实行为激活，质量从父 0 提升到候选 1；guard 无回退；后续 holdout Episode 冻结到新 revision 并加载相关组件。任何未到达的环节都明确报告，不以测试替身补齐。
