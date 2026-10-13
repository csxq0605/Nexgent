# ADR 0006：改进作业、诊断、提议与门控的反馈检查

- **状态**：已接受
- **日期**：2026-10-13
- **依据**：计划 [4.5](../research/pr4-review-and-plan-2026-10/README.md) 与 4.9；步骤 5 分工表 [`docs/plan/step-5-work-partition.md`](../plan/step-5-work-partition.md)（“设计要点”与“已定的决定”10 项，用户 2026-10-13 回复“按推荐认可”）；ADR 0005。
- **替代**：ADR 0005 决策 5 中“质量 = 确定性检查通过率”与“任何 `unknown` 即拒绝”两句，改为下文决策 6 的写法；ADR 0005 其余部分不变。ADR 0005“不做”里的“`autoImprove` 仍关”由决策 1 取代。

## 背景

步骤 5 对应产品目标 ③ 的后半：能力不只在模型自己想到时才沉淀，用户的反馈默认就会变成改进。步骤 4 留下了完整的门控与回滚，但候选只来自用户任务里模型主动调用的 `capability_propose`，真实运行里模型几乎不会自发这样做；门控也只用确定性检查与费用判断，采用理由大多只能是“更省”，证明不了“更准”。步骤 5 要补的是：谁来发起改进、怎样从反馈找到缺的能力、怎样把“反馈指出的问题是否解决”算进门控。

## 决策

1. **默认开。** `autoImprove` 默认 `true`（决定 1）：计入的反馈与失败的检查积累到阈值就自动开始改进作业；设置页可关。显式“改进”不看这个开关。`autoImprove` 与新的 `improvement` 设置都加入 `GUARDED_PROJECT_CONFIG_FIELDS`，模型写它们总要审批（决定 6）。
2. **三种触发，持久计数。** 计入的信号是评分 ≤3 或只有评语没有评分的反馈，以及根任务一轮结束时检查有失败项（各计 1 个，决定 2）；4–5 分的反馈保留但不计。信号到 `improvement.feedbackThreshold`（默认 3，计划 4.9 #7）开始一个作业。用户点“改进”立即开始（`explicit`）。计数存在 `.nexgent/improvements/queue.json`，记录已计入的信号键而不是一个数字，在独占锁下读改写，重启与并发都不重计、不漏计。同一项目同时只有一个作业，作业进行中到达的信号进下一批（决定 8）。
3. **作业是独立进程里的三段：诊断、提议、门控。** 作业记录 `.nexgent/improvements/<jobId>/job.json` 存状态、引用与各段费用；候选、试验、决定仍写在 `.nexgent/capabilities/` 下，作业只存 id。作业进程被杀，下次启动标为 `interrupted`，不自动重跑。门控历史不足时停在 `waiting-history`，补足后继续，不降低门槛（计划 4.5）；含插件的候选停在 `awaiting-approval`，随用户的批准变为 `adopted` 或 `rejected`。停靠的作业释放作业位，下一批可以先跑。
4. **诊断在只读的改进会话里。** 改进会话（`session.start.purpose: improvement`）不出现在对话列表里。诊断会话只有四个只读工具：读会话切片、读账本切片、列反馈、交诊断。诊断是结构化的：MAST 三类失败标签（每条附会话记录证据）、涉及的成员 / 工具 / 技能 / 组件、一句话假设、建议的组件种类或 `none`；按成员的费用由宿主从账本汇总，模型只能引用。宿主校验 schema 与证据，不通过可重交，共最多 3 次。`none` 表示不是能力问题（例如需求变了），作业以 `no-proposal` 结束。模型默认 `claude-sonnet-5-5`、thinking 开，可改为 `claude-opus-5-5`（决定 5）。
5. **提议是在快照副本里重做任务。** 宿主把反馈任务开始时的快照复制成临时项目，提议会话在里面用原任务到第一条反馈之前的用户消息重新执行，用 `capability_draft / try / propose` 产出一个候选，沿用步骤 4“试用后必须成功用过一次”的规则（决定 3）。候选带 `origin: improvement` 与 `jobId`。一个作业一个候选，一个候选一个组件。提议会话里需要审批的调用不向用户提问而直接拒绝，所以改进作业产不出插件候选，插件的两次审批不变。
6. **门控加“反馈检查”，计入质量（取代 ADR 0005 决策 5 的相应部分）。** 作业的候选照步骤 4 的门控试验，选择集必含反馈任务，回放到第一条反馈之前的轮（`ReplayCaseRef.throughTurn`），这样候选侧要在没有被提醒的情况下做对。带反馈的用例每次运行后，评审模型读该侧成果与反馈原文，判断“反馈指出的问题是否已经解决”，写一行 `trial.feedback`（`pass / fail / unknown`），与确定性检查、偏好评审分开记（决定 4）。采用规则改为：
   - 质量 = 选择集运行的确定性检查结果与每臂反馈检查结果合在一起的通过率（每个反馈检查算该臂多一次通过或失败）；
   - 任何一次运行或反馈检查是 `unknown`、或用量未知，即拒绝；
   - 守护集不得退步、质量提高且 token 不超过基线 `costRatioCap` 倍才采用、打平时的成本与评审规则、插件的 `await-approval`，都与 ADR 0005 相同。
   `TrialVerdict.feedbackPassRate` 单独给出反馈检查的通过率，证据里能看出采用是因为“解决了反馈的问题”还是只因为“更省”。没有反馈检查的试验（用户任务自己提出的候选）结果与步骤 4 完全相同。纯函数 `decideTrial` 固定这一规则。
7. **任务边界按轮。** 同一会话的多轮仍是同一个 `taskId`，快照与检查改为每个根轮各一份（`<taskId>.t<turn>.json`），反馈轮不覆盖它所针对的轮（决定 7）。步骤 4 不带轮号的文件照旧读出，不迁移。
8. **改进预算与归属。** 改进费用按项目、在滚动的 30 天时间窗内按计费 token（输入 + 缓存读 + 缓存写 + 输出）计，覆盖诊断、提议与该作业的门控，默认 300 万 token（按 ADR 0002 价目、以缓存读为主的用量约每百万 token 1 美元，即约 3 美元，决定 6）；每个阶段开始前检查，用尽时作业以 `budget-exhausted` 结束，新作业不开始。改进会话与它的试验的账本记录带 `improvementId` 与 `improvementPhase`，与普通任务、普通门控分开统计（ADR 0001 决策 5）；每个作业结束写一条 `improvement.end`。显示用的美元估算来自 `@nexgent/llm` 的只读价目表，判断只用 token 与请求数（决定 9）。
9. **采用之后可追溯。** 作业记录追加“首次被使用”（采用后第一个运行在新版本上、且用到该组件的根任务）与“已回滚”；SDK 的 `improvements.show` 按 id 串起反馈、诊断、候选、试验、决定与首次使用。回滚规则沿用 ADR 0005 决策 6。

## 后果

- **契约**：新增 `improvement.ts`（触发、队列、作业与状态、诊断、四个诊断工具、`ImprovementConfig`）；`capabilities.ts`（`CandidateRecord.origin / jobId`、`ReplayCaseRef.throughTurn / feedbackIds`、`trial.feedback`、`TrialTally.feedback`、`TrialVerdict.feedbackPassRate`、`decideTrial`、按轮的快照与检查）、`session.ts`（`purpose`、`improvement`）、`ledger.ts`（`improvementId`、`improvementPhase`、`improvement.end`）、`config.ts`（`autoImprove` 默认 `true`、`improvement`、`GUARDED_PROJECT_CONFIG_FIELDS`）、`errors.ts`（`capability/*`、`improvement/*`）、`collaboration.ts`（`MEMBER_DENIED_TOOLS`）与 `packages/sdk/src/api.ts`（API 版本 5，`improvements.*` 方法、`improvement.job` 事件、设置页的 `autoImprove` 与 `improvement`）同步修改。SDK 的 `improvements.*` 在实现落地前报 `internal`。
- **格式**：新字段与新记录在会话 JSONL v1、账本 v1 与能力文件 v1 内追加，步骤 4 的数据照常读出；改进文件的 schema 是 `packages/session/schema/improvement.v1.schema.json`。规范：`data-formats.md` §改进作业、`permissions.md` §改进会话与改进预算、`agent-hooks.md` §步骤 5 工具。
- **默认行为变化**：没有写 `autoImprove` 的已有项目从步骤 5 起自动改进开启；费用受改进预算约束，用户可在设置页关闭或调低。
- **实现分工**：按步骤 5 分工表；作业、诊断与提议归 `@nexgent/evolve`，反馈检查与回放截断归门控，按轮快照归 kernel 一侧。
- **不做**：跨项目的改进；同一项目并行多个作业；从改进作业产出插件；统计意义上的“改进有效”结论（步骤 6）。
