# 普通任务反馈到跨任务能力采用：实施合同 v1

日期：2026-09-24。本文固定 E3-B.2 的实施边界；它不是已实现功能。Nexgent 的普通任务、benchmark 和后续任务使用同一 AgentPackage／TaskService 执行合同，科学发现及 OpenFOAM 仅提供可插拔任务与独立评价器。

## 已有链与实际断点

`GenerationService.capture_feedback` 能冻结开发 split 的终态 Episode；`TaskCapabilityAdoptionService` 能从实际用过的工具／服务 Definition 构造候选；`TaskSkillAdoptionService` 能从任务生成的工作流构造 O/S 候选；`EvolutionService` 已有配对评价、晋升、guard 和回滚；`RSICycleService` 持久协调手动创建的生成—评价—guard 流程。新任务可从晋升后的包通道读取工具／服务。

但普通任务结束时没有触发这些服务的持久工作项。现有采用调用只出现在测试与实验脚本中，使用者仍要人工给出 Definition、Episode、反馈、版本和假设的 ID。任务内 `context.feedback` 已记录内容，但 FeedbackBundle 当前仅暴露事件摘要，改进器无法读取经过筛选的失败说明。普通 CLI 任务未注册开发 split／包通道；Main 已注册开发 split，但没有自动入队。没有独立 BenchmarkAdapter 的任意用户任务不能由系统自行打分晋升。

## 目标状态机

新增宿主协调器 `AutoEvolutionService`，工作项唯一键为 `(channel, parent_revision, source_episode_id)`。通道策略预先冻结允许的候选类型、BenchmarkAdapter／任务切分、资源预算、权限、改进器身份、PromotionPolicy 和 guard。状态依次为：

`observed → feedback_captured → development_planned → development_run → candidate_ready → paired_assessed → promoted → guard_assessed → completed / rejected / rolled_back / deferred`。

每个跨进程步骤先持久记录意图与输入摘要，再开始模型或外部调用；重启后以工作项 ID 查找已提交的 Episode、候选和评价，不重新执行结果未知的调用。`TaskService.run` 不负责跑评价；协调器扫描已有终态事件，在任务完成后或应用／CLI 重启时继续，避免任务终态与入队之间的崩溃窗口。

1. 仅从具有冻结包通道和开发角色的终态普通 Episode 创建工作项。未配置通道策略、无独立评价器或冻结父版本已变化时，明确记为 `deferred`，不自行评价或晋升。
2. FeedbackBundle 提供有界、脱敏的公开 outcome／evaluation／调用成本，以及 `context.feedback` 的安全投影；私有评分答案、凭据、模型原文和未授权工件不得进入开发 Episode。
3. 后续能力开发本身是同一 AgentPackage 的受限普通 Episode。它从反馈判断 `tool`、`service_provider`、`orchestration` 或 `no_change`，提交一次版本化的候选意图与可证伪假设。宿主根据实际创建／使用／编译收据反查模型声称的对象 ID；单工作项最多一个候选，防止复合晋升失去因果归因。
4. 已用工具／服务走 `TaskCapabilityAdoptionService`；任务生成的工作流走 `TaskSkillAdoptionService`；通用 O 补丁走现有 `GenerationService`。候选生成完成后，交给 `RSICycleService` 从候选进入配对评价及 guard，沿用同预算、独立评分、激活证据、CAS 晋升与回滚。
5. 晋升后新普通 Episode 自动读取包通道新版本；只有它的实际 `activated_components` 或 `active_strategy` 匹配晋升组件时，才能记录 `reuse_observed`。晋升事件本身不等于后续复用，更不等于多任务净收益。

## 分片验收

- **E3-B.2a 反馈与触发。** 有界反馈正文进入公开 Bundle；普通任务终态后与重启扫描均只生成同一持久工作项。无通道／无评价器明确 defer。
- **E3-B.2b 自主开发。** 真正的模型在开发 Episode 中判断能力缺口、创建或拒绝候选；宿主用已有实际使用／编译收据验证它。未知远端调用恢复不重发。
- **E3-B.2c 采用与再用。** 候选经独立配对、晋升、guard，在新任务中自动加载并留下行为激活；失败可拒绝／回滚且不影响原任务结果。
- **E3-B.2d 效果。** 冻结任务族、单智能体／固定编排／仅记忆等对照和外层开发成本；跨任务聚合质量、失败率、时延与成本，负结果原样报告。

此合同借鉴 [AutoSci 的图／技能反馈更新](https://arxiv.org/html/2605.31468v1)、[ADAS 的可执行候选档案](https://arxiv.org/html/2408.08435v2)及 [AFlow 的外层搜索评价](https://arxiv.org/html/2410.10762v4)，但这些论文不替 Nexgent 提供任务内副作用恢复和跨进程采用证据。DeepSeek Harness 的[持久事件与运行事件分离](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/docs/architecture.md)对应此处的持久工作项与短命执行 worker。所有新增阶段都必须给出真实行为收据，不能用子智能体写的代码或确定性 fixture 代替产品内自主进化。
