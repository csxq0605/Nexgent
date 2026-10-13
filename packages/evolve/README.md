# @nexgent/evolve

默认的反馈改进流程（步骤 5）。本轮（W2 第一部分）实现反馈计数、三种触发、改进作业目录与状态机、作业宿主（分离进程、锁、恢复）和改进预算闸门；诊断与提案是第 2 轮，在那之前作业用 `PENDING_STAGES`，一律以 `failed` 结束并写明“诊断尚未实现”（未知结果不算成功）。

归属：「改进流程」讨论串（`docs/plan/step-5-work-partition.md` W2）。本包的作业类型暂时定义在 `src/types.ts`；步骤 5 契约（W0，`@nexgent/kernel` 的 `improvement.ts`）合入后改为从 kernel 引入，字段名以契约为准。运行时依赖只有 `@nexgent/kernel`。

## 目录

```text
.nexgent/improvements/
├── queue.json        计数：已计入的条目 id 集合、待处理批次、占用作业位的作业
├── queue.lock        改 queue.json 时持有（进程号，毫秒级）
└── <jobId>/
    ├── job.json      一个作业：触发原因、引用的反馈与检查失败、状态与历史、各阶段花费、候选 / 试验 / 决定的引用
    ├── job.lock      运行作业的进程号
    ├── job.json.lock 写 job.json 时持有
    └── job.log       作业进程的诊断输出（宿主数据）
```

## 计数与触发

- 计入的反馈：评分 ≤ 3，或只有评语没有评分（决定 2）；4–5 分不计入，反馈本身照常留在会话里。
- 检查失败：根任务某一轮的检查有失败项，按 `check:<taskId>:<turn>` 计 1 条（kernel 发信号，调 `ctx.improve.noteCheckFailure`）。
- 计数存的是“已计入的 id 集合”，在 `queue.lock` 下读改写：同一反馈重复提交、桌面与 CLI 两个进程同时提交、重启后再同步，都不会重计或漏计。`since` 之前的反馈（本包开始计数之前）不计。
- 满 3 条（`threshold`）且 `autoImprove` 开、宿主配置了入口时，在同一次加锁更新里建 `queued` 作业、把这批条目移进作业、占用作业位。`autoImprove` 关或没有入口时，条目留在批次里。
- 显式“改进”（`ctx.improve.run`）立即开始，不看计数，也不受 `autoImprove` 限制（受预算限制），并带走当前批次；已有作业在跑时拒绝（`tool/invalid-input`）。
- 同一项目同时只有一个作业（决定 8）；作业进行中计入的条目组成下一批。作业结束（或停在 `waiting-history` / `awaiting-approval`）时释放作业位，若下一批已满，同一进程接着跑下一个作业。
- 插件在每轮开始时（反馈提交会开一轮）后台同步该会话的反馈，不阻塞这一轮。

## 作业

状态：`queued → diagnosing → proposing → trialing → adopted | rejected | awaiting-approval | no-proposal | waiting-history | budget-exhausted | failed | interrupted`，允许的转移见 `JOB_TRANSITIONS`，每次转移在 `job.json.lock` 下写并追加历史。

- 宿主照步骤 4 门控的做法起分离进程：`node <entry> improve <projectRoot> <jobId>`，入口调用 `runImprovementJob`。宿主一起子进程就把子进程号写进 `job.lock`；子进程自己也独占创建（或认领写着自己进程号的）锁。
- 启动时（`ctx.improve.start` / `recover`）把运行态、但锁不存在或指向已死进程的作业标为 `interrupted`，删掉锁、释放作业位，不自动重跑；刚建、还没拿到锁的 `queued` 作业有 60 秒宽限。
- 预算（决定 6）：每个阶段开始前检查滚动窗口（默认 30 天）内本项目全部作业的计费 token（输入、输出、缓存读写）；用尽即停，记 `budget-exhausted`。usage 为 `unknown` 的字段不计入，该阶段记在 `unknownPhases` 里，总数是下限。契约里的预算字段落地前，预算来自插件配置 `budget`，默认 100 万 token（约合 3 美元的量级，待契约定稿）。

## 接入（之后的工作包）

- SDK：`submitFeedback` 后可直接调 `ctx.improve.noteFeedback`（插件的每轮同步已经覆盖）；`improvements.list / show / run` 调 `list / show / run`；入口脚本（`trial-entry.ts`）加 `improve` 模式调用 `runImprovementJob`，由「SDK 与桌面」改。
- kernel：根任务检查失败时调 `ctx.improve.noteCheckFailure`。
- 第 2 轮：`ImprovementStages` 的诊断、提案与交给门控。
