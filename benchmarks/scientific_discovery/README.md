# Scientific discovery benchmark

这是 Nexgent 通用 RSI 框架的独立科研发现插件。科学发现只是可替换的 benchmark/demo；核心框架不依赖本插件，也不预设科学任务、数值模型或评分。插件保留 `nexgent.benchmarks` 的 legacy `scientific_discovery` 入口，同时通过 `nexgent.task_benchmarks` 和 `nexgent.domains` 提供 canonical TaskService adapter 与 DomainPack。

## 安装

在仓库根目录、已安装 Nexgent 的同一个 Python 环境中运行：

```sh
python -m pip install -e benchmarks/scientific_discovery
```

NumPy、SciPy 是本插件的依赖。legacy 工具仍由核心按 `BenchmarkSpec.toolbox_factory` 绑定到执行进程；canonical DomainPack 的数值工具由宿主安装并可信计量。插件没有自行调用模型、创建进程或改变核心预算。

## Canonical TaskService 路径

- 每个 synthetic case 形成一个独立 `TaskSpec` 和 Episode；隐藏 future forecast 只留在宿主评价器，不进入 agent payload。
- 项目私有 release key 通过 HMAC 派生隐藏的生成 seed、统计单元 ID 和不透明 family cluster。公开 seed 只是 suite 级配对键；复现同一 release 需要同一私有 key，key 本身不进入 benchmark 证据。
- `development` 映射到历史 development 分布；`final_holdout` 映射到已使用过的历史 confirmation 分布。因此这里的 `final_holdout` 只用于迁移 regression/golden 等价检查，不是新的 holdout，也不能作为新研究证据。
- canonical reference AgentPackage 是确定性的无模型线性 control，用于验证执行、计量和 legacy/canonical 评分等价；它不是模型智能体，也不构成研究效果证据。
- legacy 入口、命令、记录与恢复语义继续保留；legacy measurement/study ID 不会被重新解释成 canonical Episode 证据。

## 提供的领域能力

- `task.py` 科研程序的线性起点和静态强基线；后者是默认 `initial_files()`。
- 通用表达式表示、去噪、微分/积分配点回归、模型选择及方程积分工具。
- 私有参考动力系统、带噪可见轨迹、独立初值和更长时间范围的预测评分。
- SINDy、弱形式系统识别和模型选择的既有文献卡，以及科学研究的角色指导。
- 完整工作量和失败回执；数值发散记算法失败，资源无法完成记缺测。

`research_context()` 仅包含公开的任务/工具合同、文献和方法说明，不包含隐藏目标、真实方程或确认结果。`snapshot()` 是供宿主冻结和复现的完整插件源码及依赖/数据生成摘要，不应直接当作任务观察。

## 方法边界

legacy 正常路径记录确定性工具工作单位。源进程失败且没有工作收据时，插件保守收取该源的预算上界，并通过 `execution.work_units_status=reserved_upper_bound_actual_usage_unavailable` 标记实际工作未知。canonical 路径则由 DomainPack 的可信 handler 在数值批次边界向根 Episode 账本计量；工具返回的 `work_units` 仅是诊断信息，不能自行结算成本。这些单位影响额度记账，但都不等同于 FLOPs、时间或费用。

当前 demo 恢复人工生成的已知动力系统，不声称发现新的自然规律。积分配点工具不是完整 WSINDy 复现。成功预测不能唯一确定真实机制；任务程序改善也不自动证明改进器的后代生产能力增强。

迁移时 `benchmark.py`、`expressions.py`、`toolbox.py`、`baselines.py` 四个数值文件逐字节保持原算法。新增适配器和领域文献使实现摘要改变，后续研究必须用新鲜 host-private release 重新登记。2026-09-16 已完成批次的历史证据及一次确认保留在仓库研究文档和历史版本中，不会使用本次插件版本覆盖或重跑该登记。研究依据、最小后续实验和结论上限见 [RSI orchestration research refresh](../../docs/research/rsi-orchestration-refresh-20260921.md)。
