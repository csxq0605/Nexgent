# 任务运行与恢复

> 适用版本：0.9。P1 任务运行器已经实现；P2 OpenFOAM 独立 Re=10 smoke 已实现并真实通过；P3 跨任务行为更新、P4 递归改进和 P5 冻结研究仍未完成。0.8 研究接口保留在本文末尾。

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
python -m nexgent task-benchmark openfoam_cavity --split smoke --seed 0
```

`--input` 接受内联 JSON 对象、JSON 文件路径或 `@file`。`--capability` 可重复授予工具；`--package` 读取 AgentPackage JSON。任务和 benchmark 都可设置 `--max-calls`、`--max-completion-tokens`、`--max-tool-calls` 与 `--max-nodes`。workbench 和 openfoam_cavity 的 `--controlled-failure` 请求各插件提供的确定性一次性故障场景，用于恢复合同验证；它不是生产故障模拟。

## OpenFOAM smoke 运行

先安装可选包：

```powershell
python -m pip install -e benchmarks/openfoam
```

当前插件只接受 `openfoam_cavity` 的 `split=smoke`、`seed=0`、`cavity_re10`。宿主探测本机 Foundation 8；Windows 只使用固定的 WSL2 `Ubuntu-20.04`、`/opt/openfoam8/etc/bashrc` 和官方 cavity 路径。它将模板有界复制到 `.nexgent/tool-workspaces/openfoam/<root-episode>/jobs/<digest>`，再以固定参数依次运行 `blockMesh`、`checkMesh`、`icoFoam`。任务输入不能提供路径、命令或 shell 片段。

每个命令的默认上限是 60 秒和 64 KiB 保留输出。完整输出摘要、退出码、时长、是否超时、case 前后摘要、mesh 结果、求解结束时间及最新 `U`/`p` 字段摘要进入收据；`icoFoam` 输出超过保留窗口时，预览会截断，但完整流的 SHA-256 和总字节数仍保存。`validate_delivery` 将两个最终工件与宿主管理的 `run.json` 逐值核对，隐藏评价器还要求环境、准备、真实运行及验证收据彼此绑定。

2026-09-20 的真实 WSL2/Foundation 8 smoke 已通过：400 cells、`Mesh OK.`、`icoFoam` 到 0.5 s、最新 `U`/`p` 各 400 个有限内部值，隐藏评价器 `accepted=true`。最初 normal test 直接调用 domain/evaluator；后续 `episode-6ef65a0b81754ce3` 又由真实 `TaskService` 执行固定无模型 AgentPackage，观察一次 `synthetic_once_only_rejection` 后重试，完成真实求解、两个最终工件、校验和隐藏评价。命令、摘要、失败修复与结论范围见[验证记录](demos/openfoam-smoke-validation-20260920.md)和[机器可读收据摘要](demos/openfoam-smoke-receipt-20260920.json)。两条路径都是 0 模型调用，不构成模型自主恢复或 RSI 证据。

开发测试默认使用模拟进程，不启动 WSL。真实 provider 测试需要显式选择：

```powershell
$env:NEXGENT_OPENFOAM_REAL_TEST = '1'
python -m pytest tests/test_openfoam_plugin.py::test_real_openfoam_smoke_is_explicitly_opt_in -q
```

环境不可见时该测试会 skip。一次 skip 只说明当前测试进程没有发现所需运行时，不能覆盖或反证已有真实收据。正式数值验证仍需另行冻结 Re=100、独立参考、稳态判据和网格/时间收敛协议。

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

P1 的确定性合同测试不调用真实模型供应商，也不构成真实任务成功、统计效果或 RSI 改进的证据。2026-09-20 的真实 Provider 验证已执行并登记：Qwen 请求因供应商账户欠费返回 400 `Arrearage`，Gemini 最小探针连接失败；MiMo normal Workbench 真实运行 30 次模型调用和 1 次工具调用，记录了 usage、已完成工具的重复调用阻断及 `recover` 入口，但最终耗尽预算且未发布交付，评价不可用。P2 的真实 OpenFOAM 求解器 smoke 也不能替代真实模型任务效果。

真实运行按[任务运行时验证记录](research/task-runtime-validation-20260920.md)登记。至少保存 package/episode 身份、冻结任务合同、计划和节点、评审与修订、模型及工具收据、工件谱系、停止/恢复状态、预算用量和最终验收。未观察到的字段保持缺测，不能用确定性测试结果代填；调用 `recover` 也不能在没有最终交付时写成恢复成功。

## P1 之后的版本变更与回滚边界

P1 只会执行登记的不可变 `AgentPackage`，不会根据一次任务反馈自动生成或部署新包。P3 才会把跨任务失败归因到编排、技能、提示协议或记忆策略，产生带父版本和触发证据的候选；候选先在隔离开发任务上运行，再由独立质量、成本和回归检查决定是否晋升。未晋升候选保持可审计但不进入默认任务。若已晋升版本在监测任务上触发预登记退化条件，部署指针恢复到最近一个已通过门控的包，失败 episode 和候选谱系继续保留。

P4 才允许候选生成、实验选择或预算分配等改进策略本身成为被更新对象。评价器、预算核算、权限准入和回滚记录保持在可信宿主侧，候选不能修改自己的通过标准。研究依据和所需对照见[编排与 RSI 研究综合](research/agent-orchestration-rsi-synthesis-20260916.md)。

## 保留的 0.8 研究接口

`nexgent benchmarks`、`evaluate`、`research`、`resume`、`show`、`list`、`export` 和 `meta-evaluate` 保持原名和 0.8 语义。`nexgent gui --legacy-research` 打开旧研究窗口。[0.8 架构快照](architecture-0.8.md)记录其接口边界；这些历史研究结果不作为 0.9 P1 或 P2–P5 的完成证据。

旧研究控制器仍使用 `max_evaluations`、领域工作单位、探测预算和独立元评价预算。相应运行应继续遵守已登记预算及原报告的证据边界。
