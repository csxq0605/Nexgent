# Scientific discovery benchmark

这是 Nexgent 通用 RSI 框架的独立科研发现插件。核心框架不依赖本插件，也不预设科学任务、数值模型或评分。插件通过 `nexgent.benchmarks` entry point 注册为 `scientific_discovery`。

## 安装

在仓库根目录、已安装 Nexgent 的同一个 Python 环境中运行：

```sh
python -m pip install -e benchmarks/scientific_discovery
```

NumPy、SciPy 是本插件的依赖。任务工具由核心按 `BenchmarkSpec.toolbox_factory` 绑定到执行进程；插件没有自行调用模型、创建进程或改变核心预算。

## 提供的领域能力

- `task.py` 科研程序的线性起点和静态强基线；后者是默认 `initial_files()`。
- 通用表达式表示、去噪、微分/积分配点回归、模型选择及方程积分工具。
- 私有参考动力系统、带噪可见轨迹、独立初值和更长时间范围的预测评分。
- SINDy、弱形式系统识别和模型选择的既有文献卡，以及科学研究的角色指导。
- 完整工作量和失败回执；数值发散记算法失败，资源无法完成记缺测。

`research_context()` 仅包含公开的任务/工具合同、文献和方法说明，不包含隐藏目标、真实方程或确认结果。`snapshot()` 是供宿主冻结和复现的完整插件源码及依赖/数据生成摘要，不应直接当作任务观察。

## 方法边界

正常路径记录确定性工具工作单位。源进程失败且没有工作收据时，插件保守收取该源的预算上界，并通过 `execution.work_units_status=reserved_upper_bound_actual_usage_unavailable` 标记实际工作未知。该上界影响额度记账，不能被解释成确实完成了相应数量的科学运算；完整报告保留该区别。

当前 demo 恢复人工生成的已知动力系统，不声称发现新的自然规律。积分配点工具不是完整 WSINDy 复现。成功预测不能唯一确定真实机制；任务程序改善也不自动证明改进器的后代生产能力增强。

迁移时 `benchmark.py`、`expressions.py`、`toolbox.py`、`baselines.py` 四个数值文件逐字节保持原算法。新增适配器和领域文献使实现摘要改变，后续研究必须重新登记。2026-09-16 已完成批次的历史证据及一次确认保留在仓库研究文档和历史版本中，不会使用本次插件版本覆盖或重跑该登记。
