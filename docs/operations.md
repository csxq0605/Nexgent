# 任务运行与恢复

> 适用版本：0.9。P1 任务运行器已经实现；P2 OpenFOAM 独立 Re=10 smoke 已实现并真实通过；P3 反馈驱动包演化控制面已实现，真实模型效果与统计 RSI 效益仍未建立；P4 递归改进和 P5 冻结研究尚未完成。0.8 研究接口保留在本文末尾。

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

## P3 反馈演化控制面

P3 管理通用 `AgentPackage` 的行为版本，不理解 OpenFOAM、科学发现或 WorkBench 的领域语义。插件只提供任务、工具、数据和 evaluator；核心只处理身份、反馈边界、候选、冻结评测、部署通道和回滚。

标准顺序为：

1. 用当前 channel 包运行明确标记为 `development` 的任务，留下终态 Episode；
2. `GenerationService.capture_feedback(...)` 将实际 episode/package/memory/evaluation/usage/artifact 摘要冻结成 `FeedbackBundle`，私有 evaluator 内容只保留 digest；
3. `GenerationService.generate(...)` 通过同一任务运行器执行独立、版本化且冻结的 improver `R0`；它只能返回严格 `BehaviorPatch`，由宿主将 O/M/S 改动应用为不可变 child 包；
4. `EvolutionService.plan_pair(...)` 在结果产生前冻结 selection suite、父子顺序、benchmark/evaluator snapshot、可重算的 execution environment/tool/runtime snapshot 和 `PromotionPolicy`，再由 `run_pair(...)` 实际执行；逐调用 receipt 会保留实际 provider/model，当前 P3 gate 只检查用量收据完整性，不把尚未实现的 provider/model 目标预登记核验写成已完成能力；
5. `assess(...)` 对完整配对 fail closed；只有 selection decision 可以 eligible，且 eligible 不会自动部署；
6. 只有 `GenerationService` 生成且具有完整 feedback、R0 execution 和 patch receipt 的 candidate 能部署；`propose(origin="imported")` 只供合同测试和研究 archive。晋升前必须用 `plan_monitor(...)` 冻结 guard 任务和阈值；`promote(...)` 强制接收该 plan，并以 compare-and-swap 检查父包仍 active 后移动 channel；
7. 后续任务通过 `--package-channel` 加载新版本；`run_monitor(...)` 只能一次性消费完整 guard task 多重集并产生实际 Episode，`monitor(...)` 核验当前部署、逐项任务登记、usage 完整性和 evaluator receipt。缺项、额外重复或缺测都 fail closed，达到退化条件时沿部署边 `rollback(...)`。

Python API 与 CLI 都保留分步对象，调用方必须显式保存每个 immutable record。GUI 提供安全只读信息；CLI 提供同样受门控的逐步操作：

```powershell
# --package 与 --package-channel 互斥
python -m nexgent task "执行已部署版本" --package-channel general
python -m nexgent task-benchmark workbench --split selection --seed 19 --package-channel general

# 当前 active package/revision/promotion 摘要
python -m nexgent rsi-status general

# 最近 50 条经过字段白名单过滤的 hash-linked 审计事件
python -m nexgent rsi-events general --limit 50

# 注册、捕获开发反馈并执行冻结 R0
python -m nexgent rsi-register general --package parent-package.json
python -m nexgent rsi-feedback general EPISODE_ID --expected-revision 0
python -m nexgent rsi-generate general FEEDBACK_ID --improver-package improver.json --mutation-policy mutation-policy.json --expected-revision 0

# 先冻结 selection policy/任务，再运行与决策
python -m nexgent rsi-plan CANDIDATE_ID workbench --split selection --seed 19 --policy promotion-policy.json
python -m nexgent rsi-run-plan PLAN_ID workbench
python -m nexgent rsi-assess TRIAL_ID

# 晋升前冻结 guard；晋升、运行监控并按预登记阈值判断回滚
python -m nexgent rsi-plan-monitor CANDIDATE_ID workbench --split guard --seed 23
python -m nexgent rsi-promote CANDIDATE_ID DECISION_ID MONITOR_PLAN_ID
python -m nexgent rsi-run-monitor general workbench
python -m nexgent rsi-monitor general GUARD_EPISODE_ID
```

默认任务窗口的“RSI 与版本”页输入 channel 后刷新同一只读投影。页面和 CLI 输出不会返回包源文件、FeedbackBundle 正文、私有任务 payload、evaluator 诊断或隐藏答案。CLI 也不提供“一键晋升”；部署必须经过 selection decision、预登记 monitor plan 和显式 `rsi-promote`。

安全边界如下：

- 反馈 Episode 必须在本地、终态、development-only，并绑定当前 active 父包；selection、guard 和 final holdout 不能被回灌为候选反馈；
- mutable policy 只允许声明为 O（编排）、M（记忆策略）或 S（技能/提示协议）的包内路径；improve entry、R0 执行闭包、evaluator、gate、权限、manifest 和宿主代码不可修改；
- paired plan 和 monitor plan 在执行前冻结；计划保存的是可验证的 execution environment/tool/runtime snapshot，provider/model 实际值保留在逐调用 receipt 中。当前 gate 会拒绝用量不完整，但正式真实模型实验还必须预登记目标 provider/model/参数，并另行核验 receipt；缺分数、用量不完整、snapshot 变化、已实现的身份错配和 required regression 不能被当作零损失或从聚合中省略；
- `eligible` 只是 decision，`promote` 是单独 CAS 操作；在途 Episode 继续绑定创建时版本，新 Episode 才读取新 channel revision；
- imported candidate 没有 deployment authority；promotion 必须能反查不可变 generation record、FeedbackBundle 和实际 R0 执行收据；
- monitor plan 是 promotion 的必填项，其完整任务多重集只能消费一次；monitor 只接受真实、usage-complete、evaluator-bound Episode，不接受调用方伪造的分数字典；rollback 只移动指针，保留候选、trial、decision、Episode 和事件链；
- selection gate 中的 `cost` 是按模型调用、charged completion tokens、工具调用和节点计算的 normalized work unit，不是货币。原始 usage 继续保留；如需比较实际费用，必须另外记录供应商账单口径。

确定性测试验证这些合同，只构成 **mechanism proof**。真实 `R0` 生成候选并在新 Episode 激活，才构成 **真实模型行为证据**；在预登记任务族上有重复、对照、完整缺测报告和效应估计，才构成 **统计 RSI 效益证据**。当前不能越级使用后两种表述。完整数据对象和 P3/P4 边界见[P3 控制面设计](design/p3-feedback-evolution-control-plane.md)，实验协议见[P3 跨任务 RSI 研究设计](research/p3-cross-task-rsi-design-20260920.md)。

`build_rsi_mechanism_evidence(...)` / `export_rsi_mechanism_evidence(...)` 可在 Python 中核验一条已经完成的闭环并导出 `nexgent.rsi-mechanism-evidence.v1`。导出只含 package/episode/record identity、digest、usage、gate、聚合测量和事件链引用，不含包源码或 evaluator 私有内容。当前确定性 pilot 使用固定无模型 fixture 覆盖了生成、selection、晋升、后续通道加载、guard 退化、回滚和回滚后加载；它的 claim 固定为 `deterministic_mechanism_closure_only`。

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

## P3 与 P4 的版本边界

P3 的 `R0` 是冻结实验装置：候选只能改变任务 agent 的 O/M/S 行为面。P4 才允许诊断、候选生成、实验选择、父代选择或预算分配等改进策略 `R` 自身成为被测更新对象。即使进入 P4，评价器、预算核算、权限准入、promotion/rollback 记录和最终比较规则仍留在可信宿主侧；被测 R 不能改写自己的通过标准。研究依据和所需对照见[编排与 RSI 研究综合](research/agent-orchestration-rsi-synthesis-20260916.md)与[P3 研究设计](research/p3-cross-task-rsi-design-20260920.md)。

## 保留的 0.8 研究接口

`nexgent benchmarks`、`evaluate`、`research`、`resume`、`show`、`list`、`export` 和 `meta-evaluate` 保持原名和 0.8 语义。`nexgent gui --legacy-research` 打开旧研究窗口。[0.8 架构快照](architecture-0.8.md)记录其接口边界；这些历史研究结果不作为 0.9 P1 或 P2–P5 的完成证据。

旧研究控制器仍使用 `max_evaluations`、领域工作单位、探测预算和独立元评价预算。相应运行应继续遵守已登记预算及原报告的证据边界。
