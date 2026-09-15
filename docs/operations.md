# 研究运行与恢复

## 项目与模型

GUI、CLI 与 Python API 使用同一个通用控制器，读取当前项目的 `models.json` / `.env`。`NEXGENT_PROJECT_ROOT` 或 CLI `--root` 可指定项目。智能体源码进程不接收凭证。

`nexgent benchmarks` 列出插件及数据错误。`nexgent evaluate --benchmark ID` 执行固定程序；`nexgent research ... --benchmark ID` 执行演化。领域工具、数据和评分分别在独立插件内。

Windows Qt 出现“无法定位程序输入点”属于动态库装载问题。使用本项目 `.venv/Scripts/python.exe`，避免借用其他项目或 Conda 的解释器。`start.ps1` 已指向独立环境和 `src` 包布局。

## 预算

- `max_model_calls`：发送前登记，一次失败请求也占用一次。
- `max_completion_tokens`：声明的输出 token 上限之和，不是已用 token 或费用。
- 已用 token：仅合计 Provider 返回的 usage。未返回用量的调用标为未知。
- `max_evaluations`：benchmark 评价次数。跨研究缓存占相同逻辑额度，同研究同一测量不重复计算。
- 逻辑工作与实际工作分别记录；单位由插件声明，不跨领域直接比较。历史字段 `numeric_work_units` 保留以读取已有记录。
- 外层改进器默认上限 1800 秒、探测内层 600 秒，每次模型请求上限 180 秒。均可停止，没有隐式重试。
- 探测先检查能容纳两组的额度。任务程序经通用工具发出的模型请求也记入同一账本。

## 停止与恢复

窗口“停止”或 Ctrl+C 会终止当前工作进程，保留 SQLite 用量与终止记录。恢复不重发没有提交后代的旧请求；它记录该代中断，在剩余代数和预算中继续。已提交的候选继续评价，完成的研究直接返回原记录。

实现、评价器或模型配置变化后须注册新研究，不能把不同实现混入同一结果。实际元评价独立注册预算；同一登记不重复运行，发生中断时先检查回执。

## 失败与证据

查看 `last_error`、模型回执、任务反例和 `failure_kind`。超时、停止、预算不足表示缺测；无效提交或可测的错误答案表示方法失败，具体评分由插件定义。日志保留安全的异常类型与连接阶段。

`nexgent export STUDY_ID` 导出源程序、事件、调用、完整改进器探测与实验证据。模型接收有节选标记的有界反馈，导出保留完整版本。包含问题与源码，不包含凭证，默认写入被 Git 忽略的 `.nexgent/exports`。
## 独立改进器评测预算

`meta-evaluate` accepts `--arm-max-calls` and `--arm-max-completion-tokens` for
each seed/arm's total allowance, including model requests from task evaluation.
`--generation-max-calls`, `--generation-max-completion-tokens`, and
`--generation-max-experiments` additionally cap each actual `improve` execution.
These values are frozen into the registration; changing a budget creates a
different experiment identity. An incomplete fixed benchmark or meta comparison
returns a nonzero CLI exit code, with the missing results retained in its export.
