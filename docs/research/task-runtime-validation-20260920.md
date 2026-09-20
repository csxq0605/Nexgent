# P1 任务运行时验证记录

日期：2026-09-20
状态：**记录结构已冻结，等待真实模型 episode；下列空字段不是成功证据。**

## 1. 目的与声明边界

本文登记 Nexgent 0.9 P1 的真实运行证据：通用任务是否通过同一运行器完成计划、能力调用、工件交接、交付评审、受控停止与恢复，以及独立 benchmark 是否评价同一条执行路径。

P1 是任务执行、评审和恢复基础，不是完整 RSI。本文不以一次任务成功声称跨任务学习，也不以 reviewer 批准、源码变化、记忆写入或候选数量声称自进化有效。跨任务候选生成、晋升门、部署回滚和改进策略自身更新分别属于 P3、P4。

该边界遵循[编排与 RSI 研究综合](agent-orchestration-rsi-synthesis-20260916.md)的结论：持久化、实际执行和有效必须分别检查；任务内修订、跨任务积累和元效用必须分开测。历史[框架验证](framework-validation-20260916.md)及[v1](framework-mechanism-v1-review.md)/[v2](framework-mechanism-v2-review.md)审查已经出现过机制未激活、契约错误、错误父代选择和实际后代零增益，因此本记录保留失败、缺测和零结果。

## 2. 冻结信息

真实运行前填写，运行后不得用观察结果回写任务、预算或通过条件。

| 字段 | 值 |
| --- | --- |
| Git commit / 工作树说明 | 待填写 |
| Python、OS 与 Nexgent 版本 | 待填写 |
| 模型供应商 / 模型 / 配置摘要 | 待填写；不记录密钥 |
| AgentPackage `id` / `digest` / `parent_id` / `generation` | 待填写 |
| 工具注册表及版本 | 待填写 |
| 任务集与 split / seed | 待填写 |
| `max_model_calls` / `max_completion_tokens` / `max_tool_calls` / `max_nodes` | 待填写 |
| 停止与恢复触发方法 | 待填写 |
| 普通任务成功条件 | 待填写 |
| benchmark evaluator snapshot / digest | 待填写 |

## 3. 最小运行矩阵

| 场景 | 需要观察的行为 | episode ID | 结果 |
| --- | --- | --- | --- |
| 正常多步骤任务 | 模型与工具/技能节点、计划、输入读取、工件交接、reviewer、交付 schema 核验 | 待运行 | 待填写 |
| 评审后修订 | reviewer 给出具体 findings/repairs，任务在同一 episode 采取后续动作后再次提交 | 待运行 | 待填写 |
| 停止与恢复 | 已完成调用不重复；未知外部效果进入 `waiting_input`；可恢复项从持久状态继续 | 待运行 | 待填写 |
| workbench benchmark | 同一 `TaskService` 执行，冻结插件评价器独立给出 `accepted` 与分数 | 待运行 | 待填写 |

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

## 5. Episode 记录模板

每个场景复制一份本节。

### Episode：待填写

| 项目 | 观察 |
| --- | --- |
| 目标与成功条件 | 待填写 |
| episode / package 身份 | 待填写 |
| 实际模型、工具和技能节点 | 待填写 |
| 中间失败或评审反馈 | 待填写 |
| 反馈后的动作变化 | 待填写 |
| 工件与谱系 | 待填写 |
| 停止/恢复行为 | 待填写 |
| 预算声明与实际用量 | 待填写 |
| reviewer 结论 | 待填写；仅是包内 claimed 评审 |
| 宿主 schema / benchmark 结论 | 待填写 |
| 缺测与限制 | 待填写 |

原始导出：待填写相对路径。

复现命令：待填写，移除凭证和私密输入。
结论：待填写。

## 6. P1 验收判断

只有以下证据同时出现，才能报告相应 P1 行为已在真实供应商 episode 中观察到：

1. 冻结身份和预算能定位到唯一 package、任务与 evaluator。
2. 实际收据表明模型及所需工具/技能节点确实执行，不由架构图或配置推断。
3. 多步骤任务的后续动作引用了先前结果；声称“依据反馈修订”时，轨迹中必须同时出现反馈和不同的后续动作。
4. 交付物能追溯到输入和生产节点，并通过宿主 schema；reviewer 批准不能代替独立 benchmark 验收。
5. 恢复不重复已完成的有副作用调用，未知结果不会自动重放。
6. 成功、失败、缺测、未知用量与全部成本均保留。

允许的总结措辞包括“P1 运行时合同通过确定性测试”“在所列 episode 中观察到交付/修订/恢复”。在 P3–P5 完成独立对照前，不使用“系统已经学会”“完成 RSI”“持续提升”或“递归改进有效”。

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
