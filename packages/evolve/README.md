# @nexgent/evolve

重做 E1（ADR 0018 第 1 层）起，本包的默认流程是**每次任务后的后台学习**：根任务的每一轮结束后，任务进入项目的学习队列；应用进程里的后台循环一次处理一个任务，读会话记录与自评，找相似但结局不同的历史任务对照，发一次反思请求，把提出的增量操作（新增、修改、赞、踩）交给确定性整理后追加到经验手册日志，再按计数追加状态变化（试用 → 启用 / 下线）。花钱前要用户确认过后台学习说明（`mayLearn`）且学习预算（美元，默认每项目 30 天 3 美元）有余额；应用退出时停止，下次启动继续。

步骤 5/6 的改进作业机制（作业宿主、诊断、提议、交给门控、改进器版本与元改进）仍在：显式“改进”照常开始作业，旧作业记录照常可读；“3 条差评 / 检查失败 → 自动开始作业”的计数路径已退役，只在宿主配置 `legacyCounting: true` 时开启（留给那条路径自己的测试，等「测试与 CI」的 T1 清单决定退役）。

归属：「改进流程」讨论串（`docs/plan/rework-partition.md` E1；步骤 5 的 W2）。运行时依赖：`@nexgent/kernel`、`@nexgent/session`、`@nexgent/tasking`、`@nexgent/capabilities`、`@nexgent/llm`（价格表）。

## 第 1 层学习（`src/learning/`）

| 文件 | 内容 |
| --- | --- |
| `host.ts` | `LearningHost`：`noteTurnEnd` 入队、后台循环、`stop` / `start`、`retrieve`、`status`；手册读写都经 `@nexgent/capabilities` 的 `Handbook`（写入只用 `apply`），项目副本不学 |
| `reflect.ts` | 反思指令 v0（通用、不含任何用例的例子）、请求正文、回答解析 |
| `curate.ts` | 确定性整理：长度与关键词、具体数值（`findInstanceLiterals`）、照抄请求、重复、取代与修改的范围、投票规则、项目级 / 用户级；`statusOps` |
| `queue.ts` | 学习队列 `<项目数据>/learning/queue.json`（迁移前 `.nexgent/learning/`） |
| `budget.ts` | 学习预算：账本里带 `learningPhase` 的记录按价格表折美元，滚动窗口 |
| `run-record.ts` | 会话记录压成反思读的文字（用户消息、步骤、失败、文件、成果、反馈、给到的条目） |
| `text.ts` | 中英文分词（中文二元组）、关键词、相似度、最长公共片段、语言判断 |

给用户看的文字（条目、理由、状态变化原因）按界面语言写：宿主配置 `language`（BCP 47）；没有时按任务首条消息的语言（汉字占字母的五分之一以上为中文）。

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

## 计数与触发（已退役，`legacyCounting`）

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

## 用户级改进器与元改进（步骤 6，ADR 0012）

- 改进器是用户级的：作业开始时从 Nexgent 主目录（`NEXGENT_HOME`，默认 `~/.nexgent`）的 `improvers/` 读生效版本并固定，`job.json` 与 `improvement.end` 记 `improverScope: "user"`（`userImprovers`，`user.ts`）。项目里的 `.nexgent/improvers/` 只读，只有 ADR 0012 之前固定在它上面的作业续跑试验时还会读（`pinnedSource`）。
- 元改进按用户计数：每结束一个能力作业，作业进程在 `<home>/improvements/queue.json`（`queue.lock` 下读改写）里按 `(projectId, jobId)` 计入；比较臂、元改进作业、`improvement.shareImproverEvidence` 为假的项目不计。用户配置 `<home>/config.json` 的 `improvement.meta.enabled` 为真且满 `everyJobs` 个时，在完成这一批的作业所在项目建元改进作业，同一进程接着跑。整个用户同时只有一个元改进作业，它不占项目的作业位。显式元改进（`ctx.improve.runMeta`）建在发起的项目里，带走当前批次。
- 元改进的模型、预算取用户配置；预算按用户队列 `metaJobs` 列出的作业求和。项目配置里的 `improvement.meta` 已弃用，读出后忽略。
- 元诊断只读本批涉及、且仍开着共享的项目：`improve_list_jobs` 每行带 `projectId`，`improve_read_session` / `improve_read_ledger` 必须给 `projectId`，其他项目在工具结果里拒绝。批次为空的显式元改进只读它自己的项目。
- 元提案的改动文字先过具体数值检查（`findInstanceLiterals`）：来源是本批作业的反馈原文与反馈所指成果版本的文本文件，项目常量看本批各项目任务会话里的用户消息（`literals.ts`）；命中即拒绝并列出命中的值。子改进器写进用户级版本线，采用也在用户级。
- 比较起点在本批所有项目里按 ADR 0009、0010 找（`chooseOriginIn`），起点记 `projectId`；两臂在起点项目的副本里跑，账本写进起点项目。臂作业不计数、不碰用户级队列与改进器。
