# P1 任务运行时验证记录

日期：2026-09-20
状态：**已完成三条真实 Provider 路径探测和一条运行至预算停止条件的 Workbench episode；结果均未形成可验收交付。本文将已观察机制、失败原因和缺测项分开记录。**

## 1. 目的与声明边界

本文登记 Nexgent 0.9 P1 的真实运行证据：通用任务是否通过同一运行器完成计划、能力调用、工件交接、交付评审、受控停止与恢复，以及独立 benchmark 是否评价同一条执行路径。

P1 是任务执行、评审和恢复基础，不是完整 RSI。本文不以一次任务成功声称跨任务学习，也不以 reviewer 批准、源码变化、记忆写入或候选数量声称自进化有效。跨任务候选生成、晋升门、部署回滚和改进策略自身更新分别属于 P3、P4。

该边界遵循[编排与 RSI 研究综合](agent-orchestration-rsi-synthesis-20260916.md)的结论：持久化、实际执行和有效必须分别检查；任务内修订、跨任务积累和元效用必须分开测。历史[框架验证](framework-validation-20260916.md)及[v1](framework-mechanism-v1-review.md)/[v2](framework-mechanism-v2-review.md)审查已经出现过机制未激活、契约错误、错误父代选择和实际后代零增益，因此本记录保留失败、缺测和零结果。

## 2. 运行范围与冻结信息

验证在 `refactor/scientific-rsi` 分支的 0.9 P1 运行时上进行。Workbench 使用同一 `TaskService`、已登记 AgentPackage、工具注册表和冻结评价路径；凭证、API base 和请求正文不进入本文。

| 供应商配置 | 模型 | 运行范围 | 结果 |
| --- | --- | --- | --- |
| `custom-1788598424262` | `qwen3.8-flash` | 最小请求；完整 Workbench 请求 | 两次均由阿里云返回 HTTP 400 `Arrearage`；请求未进入任务工具阶段 |
| `preset-anthropic-xiaomi-mimo-token-plan-china` | `mimo-v2.5` | 最小请求；完整 normal Workbench episode | 最小请求成功；Workbench 实际执行 30 次模型调用和 1 次工具调用，随后因预算耗尽失败 |
| 本机 Gemini provider | 本机配置所指模型 | 最小连接探针 | `APIConnectionError`；未建立可用调用 |

完整 Workbench 运行的 package digest 为 `dd684d6dbb2ff8059a2a95986759a8d76916f588a6f38820ad3c82e6ab7eb2cd`。本轮没有在观察结果出现后回写任务成功条件或评价标准。未在下文列出的冻结字段不从日志外推，按缺测处理。

## 3. 最小运行矩阵

| 场景 | 需要观察的行为 | episode ID | 结果 |
| --- | --- | --- | --- |
| 正常多步骤任务 | 模型与工具/技能节点、计划、输入读取、工件交接、reviewer、交付 schema 核验 | `episode-8547f2485c6245b7` | 真实模型和工具路径已执行；未发布交付，最终 `BudgetExhausted`，不能记为成功 |
| 评审后修订 | reviewer 给出具体 findings/repairs，任务在同一 episode 采取后续动作后再次提交 | 同上 | 未到达可验收的交付/评审修订闭环，缺测 |
| 停止与恢复 | 已完成调用不重复；未知外部效果进入 `waiting_input`；可恢复项从持久状态继续 | 同上 | 重复 `inspect_sources` 请求被运行时阻止并触发 `recover`；没有恢复到交付，不能声称恢复成功 |
| workbench benchmark | 同一 `TaskService` 执行，冻结插件评价器独立给出 `accepted` 与分数 | `episode-2269ea53758b44e7`；`episode-8547f2485c6245b7` | 两条 episode 均未形成可评价交付，`evaluation unavailable` |

如果真实任务没有自然触发评审拒绝或未知外部效果，应将该格标为“机制未激活”，另登记能激活该分支的任务；不能用未走过分支的成功 episode 证明恢复或修订有效。

## 4. 每个 episode 的必填字段

以下字段从 `task-show` 或 `task-export` 的原始记录摘录。长内容可用 digest 和工件引用代替，但原始导出须保留。

### 4.1 身份与任务合同

- `id`、`root_episode_id`、`parent_episode_id`、`revision`
- `package_id`、`package_digest`
- `task.objective`、输入工件引用、deliverable 名称与 schema
- `task.constraints`、`task.capabilities`、`task.context` 的信息边界
- benchmark 场景的 `benchmark_registration.task_ref` 与冻结 `snapshot`

### 4.2 执行与反馈轨迹

- `status`、`last_error`、开始/结束时间与恢复次数
- 已提交 `plan` 及其后续变化
- `nodes` 的 method、状态、输入引用、结果或错误
- `events` 中的 `episode_started/finished`、模型、工具、工件、feedback、评审相关证据
- 默认包的 reviewer verdict、findings、repairs，以及任务随后实际采取的动作
- 委派子 episode 及其共享根预算关系

### 4.3 工件、记忆与资源

- `artifacts` 的 producer、attempt、package digest、`input_refs`、schema validation
- `input_refs`、`output_refs` 与最终交付内容摘要
- `memory_snapshot_id`、`memory_retrievals`；写入项的 evidence refs 与 candidate 状态
- 模型 `calls` 的请求身份、状态、token usage；工具收据和幂等键
- `usage` 的模型调用、声明 completion tokens、实际 tokens（若供应商返回）、工具调用与节点数

### 4.4 验收与恢复

- `outcome.delivery_status`、`schema_validation`、`acceptance_status`、summary、limitations
- benchmark 的 `evaluation.status`、`score_available`、`accepted`、评分与 evaluator snapshot
- 停止时已经准入的调用怎样收尾
- 恢复时哪些 RPC 被复用，哪些因结果未知进入 `waiting_input`
- 最终为 completed / paused / waiting_input / failed；失败属于合同、方法、环境、预算还是缺测

## 5. 实际运行记录

### 5.1 Qwen：供应商在执行前拒绝

| 项目 | 观察 |
| --- | --- |
| 目标与成功条件 | 先做最小 Provider 请求，再执行 normal Workbench 任务并产生可供冻结评价器验收的交付 |
| episode / package 身份 | `episode-2269ea53758b44e7`；package digest `dd684d6dbb2ff8059a2a95986759a8d76916f588a6f38820ad3c82e6ab7eb2cd` |
| Provider | 配置 `custom-1788598424262`；模型 `qwen3.8-flash` |
| 实际节点 | 1 次模型调用、0 次工具调用、3 个节点 |
| 中间失败 | 最小请求和 Workbench 请求都收到阿里云 HTTP 400 `Arrearage`，运行时记录为 Provider `BadRequest` |
| 工件、reviewer 与恢复 | 未进入工具、工件、reviewer 或可验证恢复阶段 |
| 宿主 / benchmark 结论 | `evaluation unavailable` |
| 缺测与限制 | 账户欠费在模型响应前阻断运行，因此不能检验任务质量、交付、评审或恢复 |

结论：这条记录验证了 Provider 错误被真实请求路径捕获并落入 episode，但没有验证模型行为。`Arrearage` 是供应商账户状态错误，不是请求格式错误。

### 5.2 MiMo：真实多步运行在预算内未完成交付

| 项目 | 观察 |
| --- | --- |
| 目标与成功条件 | normal Workbench 任务；读取输入来源、形成规定交付，并由冻结评价器验收 |
| episode / package 身份 | `episode-8547f2485c6245b7`；package digest `dd684d6dbb2ff8059a2a95986759a8d76916f588a6f38820ad3c82e6ab7eb2cd` |
| Provider | 配置 `preset-anthropic-xiaomi-mimo-token-plan-china`；模型 `mimo-v2.5` |
| 最小探针 | 成功；25 input tokens、10 output tokens |
| 实际模型、工具和节点 | 30 次真实模型调用、1 次真实工具调用、35 个节点；`inspect_sources` 已成功执行一次 |
| 中间反馈与运行时动作 | 模型随后反复请求已成功的 `inspect_sources`；运行时阻止重复调用并调用 `recover` |
| 反馈后的动作变化 | 模型没有转入发布交付的有效路径；重复阻断和 `recover` 没有产生最终工件 |
| 工件与 reviewer | 未发布规定交付，未到达可验收 reviewer/宿主 schema 闭环 |
| 预算与实际用量 | 146,764 prompt tokens、4,313 completion tokens；charged reserved completion tokens 为 64,800；最终 `BudgetExhausted` |
| 宿主 / benchmark 结论 | `evaluation unavailable`；没有 `accepted` 或分数 |
| 缺测与限制 | 证明真实 Provider、usage 记账、工具执行、重复阻断和恢复入口被激活；没有证明正常任务成功、评审修订成功或恢复成功 |

结论：该 episode 是有价值的失败证据。框架确实运行了模型—工具—反馈路径，并在重复工具请求时采取了宿主动作；模型仍未在预算内完成交付，因此不能把“调用了 `recover`”写成“恢复成功”。

### 5.3 Gemini：最小连接探针失败

本机 Gemini provider 的最小探针返回 `APIConnectionError`。没有建立模型调用、Workbench episode、工具节点或评价结果；该记录只能说明当前本机配置的连接路径不可用。

### 5.4 为什么未继续受控失败 Workbench

normal Workbench 已在 MiMo 上耗尽 30 次真实模型调用而未产生交付。此时继续运行受控失败场景会继续产生供应商消耗，却不能隔离验证“收到一次可恢复失败后完成任务”这一假设，因此本轮停止。受控失败恢复仍是 P1-V 的未完成验证项。

## 6. P1 验收判断

只有以下证据同时出现，才能报告相应 P1 行为已在真实供应商 episode 中观察到：

1. 冻结身份和预算能定位到唯一 package、任务与 evaluator。
2. 实际收据表明模型及所需工具/技能节点确实执行，不由架构图或配置推断。
3. 多步骤任务的后续动作引用了先前结果；声称“依据反馈修订”时，轨迹中必须同时出现反馈和不同的后续动作。
4. 交付物能追溯到输入和生产节点，并通过宿主 schema；reviewer 批准不能代替独立 benchmark 验收。
5. 恢复不重复已完成的有副作用调用，未知结果不会自动重放。
6. 成功、失败、缺测、未知用量与全部成本均保留。

本轮可报告的结论是：P1 运行时合同通过确定性测试；真实 MiMo episode 观察到模型调用、usage、一次工具执行、重复调用阻断和 `recover` 入口；Qwen 与 Gemini 分别留下账户状态和连接失败证据。真实 episode 没有交付，评价均不可用，任务成功、评审修订和恢复成功仍未通过验证。在 P3–P5 完成独立对照前，不使用“系统已经学会”“完成 RSI”“持续提升”或“递归改进有效”。

## 7. 后续 RSI 证据链

P3–P4 应在本文的 episode 证据之上另行登记以下闭环：

```text
任务质量 / reviewer 缺陷 / 工具错误 / 恢复结果 / 成本与回归
  → 有来源的失败归因
  → 修改编排、技能/提示协议或记忆策略的候选 AgentPackage
  → 隔离开发任务中的实际执行
  → 冻结评价器的质量、成本、安全与回归门控
  → 晋升并由后续任务实际加载，或拒绝并保留证据
  → 已晋升版本触发退化条件时回到上一通过版本
```

当候选生成、实验选择或预算分配策略本身成为修改对象时，还需从共同任务系统起点比较更新前后策略实际产生的后代效用。宿主评价器、权限准入、预算核算和回滚日志保持冻结，不能由被评候选修改。
