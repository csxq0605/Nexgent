# 任务运行与恢复

> 适用版本：0.9。P1 任务运行器已经实现；P2 OpenFOAM、P3 跨任务行为更新、P4 递归改进和 P5 冻结研究仍未完成。0.8 研究接口保留在本文末尾。

## 项目、模型与入口

任务 GUI、CLI 与 Python API 使用同一个 `TaskService`，读取当前项目的 `models.json` / `.env`。`NEXGENT_PROJECT_ROOT` 或 CLI `--root` 可指定项目。受限 AgentPackage 子进程不接收凭证；模型和工具调用由宿主准入并记账。

`nexgent gui` 默认打开任务窗口。`nexgent task` 登记并执行普通目标；`task-resume`、`task-show`、`task-list` 和 `task-export` 操作持久化任务。`task-benchmark workbench` 将同一运行器接到独立任务与评分插件。领域工具、数据和评分留在插件内。

```powershell
python -m nexgent task "生成所需交付物" --input '{"brief":"..."}' --max-calls 8
python -m nexgent task "登记后稍后执行" --input task-input.json --register-only
python -m nexgent task-resume EPISODE_ID
python -m nexgent task-show EPISODE_ID
python -m nexgent task-list
python -m nexgent task-export EPISODE_ID --output task-evidence.json
python -m nexgent task-benchmark workbench --split development --seed 0
```

`--input` 接受内联 JSON 对象、JSON 文件路径或 `@file`。`--capability` 可重复授予工具；`--package` 读取 AgentPackage JSON。任务和 benchmark 都可设置 `--max-calls`、`--max-completion-tokens`、`--max-tool-calls` 与 `--max-nodes`。workbench 的 `--controlled-failure` 请求插件提供的确定性一次性故障场景，用于恢复验证；它不是生产故障模拟。

Windows Qt 出现“无法定位程序输入点”通常是动态库装载问题。使用本项目 `.venv/Scripts/python.exe`，避免借用其他项目或 Conda 的解释器。`start.ps1` 指向独立环境和 `src` 包布局。

## P1 预算

- `max_model_calls`：发送前登记，一次失败请求也占用一次。
- `max_completion_tokens`：声明的输出 token 上限之和，不是已用 token 或费用。
- 已用 token：仅合计 Provider 返回的 usage；未返回用量的调用标为未知。
- `max_tool_calls`：宿主准入的工具调用上限。
- `max_nodes`：任务树共享的执行节点上限。
- 委派子任务与父任务共享根预算；工件引用不会转移额外权限。

## 停止与恢复

窗口“停止”或 Ctrl+C 设置协作停止信号，等待已准入调用收尾并保存。已完成且有收据的能力调用可在恢复时复用；结果未知的外部调用进入 `waiting_input`，不会自动重复。已完成任务直接返回原记录，取消的任务需要新身份。

benchmark 登记冻结任务引用和评价器快照。恢复执行后验收状态会重新核实，评价器身份变化时拒绝混用结果。

## 失败、验收与导出

查看 `status`、`last_error`、节点、模型/工具收据和工件。`paused` 可恢复；`waiting_input` 表示宿主无法安全判断某次调用是否已经生效；`failed` 表示任务合同或执行失败。benchmark 只有在任务完成且独立评价器返回结果时才产生通过或失败结论。

默认 AgentPackage 在提交前调用独立的 `task_reviewer` 角色；拒绝意见会回到同一 episode 继续修订。该评审是任务包内部的模型判断，模型收据只能证明它实际被调用，不能变成宿主独立验收。宿主随后核验必需交付物、工件引用和 JSON Schema，普通任务由此得到 `delivered/not_evaluated`；benchmark 还必须由冻结的插件评价器给出 `passed` 或 `failed`。这三层不能合并成同一个“成功”标记。

`nexgent task-export EPISODE_ID` 导出任务、版本身份、计划、节点、调用、工件、记忆检索、用量、结果与验收状态。默认写入被 Git 忽略的 `.nexgent/exports`。导出可能包含用户输入和交付内容，不包含模型凭证。

P1 的确定性合同测试不调用真实模型供应商，也不构成真实任务成功、统计效果或 RSI 改进的证据。需要这类结论时，须单独记录供应商、模型、预算、任务分布、实际收据和验收结果。

真实运行按[任务运行时验证模板](research/task-runtime-validation-20260920.md)登记。至少保存 package/episode 身份、冻结任务合同、计划和节点、评审与修订、模型及工具收据、工件谱系、停止/恢复状态、预算用量和最终验收。模板中的空字段表示尚未获得证据，不能用确定性测试结果代填。

## P1 之后的版本变更与回滚边界

P1 只会执行登记的不可变 `AgentPackage`，不会根据一次任务反馈自动生成或部署新包。P3 才会把跨任务失败归因到编排、技能、提示协议或记忆策略，产生带父版本和触发证据的候选；候选先在隔离开发任务上运行，再由独立质量、成本和回归检查决定是否晋升。未晋升候选保持可审计但不进入默认任务。若已晋升版本在监测任务上触发预登记退化条件，部署指针恢复到最近一个已通过门控的包，失败 episode 和候选谱系继续保留。

P4 才允许候选生成、实验选择或预算分配等改进策略本身成为被更新对象。评价器、预算核算、权限准入和回滚记录保持在可信宿主侧，候选不能修改自己的通过标准。研究依据和所需对照见[编排与 RSI 研究综合](research/agent-orchestration-rsi-synthesis-20260916.md)。

## 保留的 0.8 研究接口

`nexgent benchmarks`、`evaluate`、`research`、`resume`、`show`、`list`、`export` 和 `meta-evaluate` 保持原名和 0.8 语义。`nexgent gui --legacy-research` 打开旧研究窗口。[0.8 架构快照](architecture-0.8.md)记录其接口边界；这些历史研究结果不作为 0.9 P1 或 P2–P5 的完成证据。

旧研究控制器仍使用 `max_evaluations`、领域工作单位、探测预算和独立元评价预算。相应运行应继续遵守已登记预算及原报告的证据边界。
