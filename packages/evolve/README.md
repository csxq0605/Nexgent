# @nexgent/evolve

默认的反馈改进流程（步骤 5，W2）：反馈计数、三种触发、改进作业目录与状态机、作业宿主（分离进程、锁、恢复、取消）、改进预算闸门（第 1 轮）；诊断会话与四个只读诊断工具、在反馈任务的快照副本里重做任务提出候选、交给门控、记录采用后的“首次被使用”与回滚（第 2 轮）。

归属：「改进流程」讨论串（`docs/plan/step-5-work-partition.md` W2）。作业、队列、诊断的类型与纯函数都来自 `@nexgent/kernel` 的步骤 5 契约（`contracts/improvement.ts`），`src/types.ts` 只做再导出与旧名别名。运行时依赖：`@nexgent/kernel`、`@nexgent/session`（校验与账本）、`@nexgent/tasking`（反馈读取）、`@nexgent/capabilities`（回放任务、快照副本、候选）。

本包不启动 SDK（SDK 依赖本包）。真正的会话由宿主入口注入：`ImprovementSessionRunner`（开会话、逐条发消息、关会话）与 `TrialStarter`（门控）。没有注入时作业用 `PENDING_STAGES`，一律以 `failed` 结束并写明原因（未知结果不算成功）。

## 目录

```text
.nexgent/improvements/
├── queue.json        计数：已计入的条目 id 集合、待处理批次、占用作业位的作业
├── queue.lock        改 queue.json 时持有（进程号，毫秒级）
└── <jobId>/
    ├── job.json      一个作业：触发原因、引用的反馈与检查失败、状态与历史、各阶段花费、候选 / 试验 / 决定的引用
    ├── job.lock      运行作业的进程号
    ├── job.json.lock 写 job.json 时持有
    ├── diagnosis.json 接受的诊断（只写一次）
    └── job.log       作业进程的诊断输出（宿主数据）
```

## 计数与触发

- 计入的反馈：评分 ≤ 3，或只有评语没有评分（决定 2）；4–5 分不计入，反馈本身照常留在会话里。
- 检查失败：根任务某一轮的检查有失败项，按 `check:<taskId>:<turn>` 计 1 条（kernel 发信号，调 `ctx.improve.noteCheckFailure`）。
- 计数存的是“已计入的 id 集合”，在 `queue.lock` 下读改写：同一反馈重复提交、桌面与 CLI 两个进程同时提交、重启后再同步，都不会重计或漏计。`since` 之前的反馈（本包开始计数之前）不计。
- 满 3 条（项目设置 `improvement.feedbackThreshold`，默认 3）且 `autoImprove` 开、宿主配置了入口时，在同一次加锁更新里建 `queued` 作业、把这批条目移进作业、占用作业位。`autoImprove` 关或没有入口时，条目留在批次里。
- 显式“改进”（`ctx.improve.run`）立即开始，不看计数，也不受 `autoImprove` 限制（受预算限制），并带走当前批次；已有作业在跑时拒绝（`improvement/busy`），预算用尽时拒绝（`improvement/budget-exhausted`）。
- 一批里全是检查失败时触发记为 `check-failure`，否则为 `feedback-count`（契约的 `batchTrigger`）。
- 同一项目同时只有一个作业（决定 8）；作业进行中计入的条目组成下一批。作业结束（或停在 `waiting-history` / `awaiting-approval`）时释放作业位，若下一批已满，同一进程接着跑下一个作业。
- 插件在每轮开始时（反馈提交会开一轮）后台同步该会话的反馈，再续跑历史已够的 `waiting-history` 作业、记录首次被使用；一次只跑一轮这样的后台整理，不阻塞这一轮。

## 作业

状态：`queued → diagnosing → proposing → trialing → adopted | rejected | awaiting-approval | no-proposal | waiting-history | budget-exhausted | failed | interrupted | cancelled`，允许的转移见契约的 `IMPROVEMENT_TRANSITIONS`（别名 `JOB_TRANSITIONS`），每次转移在 `job.json.lock` 下按契约 schema 校验后写，并追加历史。作业进入终态时在账本写一条 `improvement.end`。

- 宿主照步骤 4 门控的做法起分离进程：`node <entry> improve <projectRoot> <jobId>`，入口调用 `runImprovementJob`。宿主一起子进程就把子进程号写进 `job.lock`；子进程自己也独占创建（或认领写着自己进程号的）锁。
- 启动时（`ctx.improve.start` / `recover`）把运行态、但锁不存在或指向已死进程的作业标为 `interrupted`，删掉锁、释放作业位，不自动重跑；刚建、还没拿到锁的 `queued` 作业有 60 秒宽限。
- 取消（`ctx.improve.cancel`）：运行中或 `waiting-history` 的作业记 `cancelled`，给作业进程发 SIGTERM，释放作业位；作业进程在下一阶段前读到就停。
- 预算（决定 6）：每个阶段开始前检查滚动窗口内本项目全部作业的计费 token（输入、输出、缓存读写），额度来自项目设置 `improvement.budget`（默认 300 万 token、30 天）；用尽即停，记 `budget-exhausted`。usage 为 `unknown` 的字段不计入，该阶段记在 `unknownPhases` 里，总数是下限。

## 诊断（`diagnosis.ts`）

- 诊断会话只有四个工具：`improve_read_session`、`improve_read_ledger`、`improve_list_feedback`（只读，由宿主读 `.nexgent/`，结果按字节上限截断并标注）和 `improve_report_diagnosis`。
- 报告按契约 schema、条数与长度上限检查，每条证据（会话 id + 记录 seq，可带轮次）必须真的存在；不合格时告诉模型改哪里。最多 3 次（一轮结束却没报告也算一次），用完记 `failed`，错误码 `improvement/invalid-diagnosis`。
- 接受的报告加上宿主从账本算出的 `memberCosts`，独占写入 `<jobId>/diagnosis.json`。
- `proposalKind: none`（例如用户改了需求）→ 作业 `no-proposal`；`plugin` → `failed`（无人值守时不能请求插件批准）。
- 模型与 thinking 取项目设置 `improvement.model` / `improvement.thinking`（默认 `claude-sonnet-5-5`、开）。

## 提案（`propose.ts`）

- 重做的任务：第一条反馈所在会话（否则显式请求的会话，否则检查失败的会话），须是有快照与检查记录的可回放任务，否则 `failed`（`improvement/not-found`）。
- 回放第一条反馈之前的用户消息；第一条前面加作业简报（诊断假设、建议的组件类型、“草拟、试用、实际用上、再提出唯一一个组件”），简报以 `# The task` 结尾，后接原话。
- 在 `prepareReplayProject` 做的快照副本里跑（采用中的版本，剩余改进预算作单任务上限），沙箱取原任务与 `workspace-write` 中较窄的一个，结束后删副本。
- 候选：恰好一个、只含一个组件、不是插件。会话把候选写进真实项目时须已带 `origin: improvement` 和本作业 id（`capability_propose` 在 `session.start.purpose === 'improvement'` 时会写上）；写在副本里时由本包导入真实项目并标上。没有候选记 `failed`。

## 门控与采用之后（`trial.ts`、`first-use.ts`）

- 门控由注入的 `TrialStarter` 跑；`waiting` → `waiting-history`（作业位释放，历史够了由宿主重新占位只跑试验），`skipped` → `failed`，决定 → `adopted` / `rejected` / `awaiting-approval`。试验阶段花费按账本里该 `trialId` 的模型请求汇总。
- 采用后，宿主在启动和每轮开始时找：采用版本上第一个真的调用了该组件的根任务（排除试验与改进会话）记为 `firstUse`；该版本之后被回滚记为 `rolledBack`。

## 接入（之后的工作包）

- SDK（W4）：实现 `ImprovementSessionRunner`（会话与账本在真实项目里，`session.start.purpose: improvement` 与 `improvement: { jobId, phase }`，账本带 `improvementId` / `improvementPhase`；诊断会话只给四个工具；提案会话的文件工具工作区是副本，插件批准一律拒绝）；用 `runGate` 提供 `TrialStarter`；入口脚本加 `improve` 模式调 `runImprovementJob(layout, jobId, { stages: createImprovementStages({ runner, startTrial }) })`；装上 `EvolvePlugin`；`improvements.list / show / run / cancel` 调宿主同名方法。
- kernel（W1）：根任务检查失败时调 `ctx.improve.noteCheckFailure`；创建会话支持 `purpose: improvement`。
- 门控（W3）：选择集必含作业的反馈任务（候选的 `taskId` 是提案会话的任务，反馈任务从作业的信号找）。
