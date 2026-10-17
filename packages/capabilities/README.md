# @nexgent/capabilities

能力版本：一个项目的能力包按内容寻址存放、写成即不可变、加载前逐文件校验；采用历史是只追加的修订链（`adopt` / `rollback`），当前采用版本是链尾。会话在草稿区写组件、只在本会话试用、用过后提交为候选；加载器把采用版本与本会话试用的组件交给技能、预设、工作流、上下文与 PTC。

归属：步骤 4 W2「能力版本」（`docs/plan/step-4-work-partition.md`）。格式以契约 `packages/kernel/src/contracts/capabilities.ts`、`step4-tools.ts` 与 `docs/spec/data-formats.md`、`docs/spec/permissions.md` 为准，本文件只说实现。门控（W3）与 kernel 注入（W1）不在本包。运行时依赖：`@nexgent/kernel`、`@nexgent/session`（schema 校验）、`@nexgent/preset`（预设解析）、`@nexgent/ptc`（函数模块的隔离进程）。`src/activation.ts` 移植自 PR #4 的 `runtime/packages/bundle/nexgent-app/src/architecture-activation.ts`（归档分支 `archive/python-host`），改动见文件头注。

## 目录

```text
.nexgent/capabilities/
├── <version>/                         能力包，<version> = 规范化清单的 SHA-256
│   ├── manifest.json
│   └── <kind-dir>/<name>/<file>       functions、plugins、skills、context、presets、teams、architectures
├── activation/<n>.json                采用历史
├── decisions/<uuid>.json              采用、回滚的决定记录
├── candidates/<uuid>/                 candidate.json 与提交的组件副本
└── drafts/<sessionId>/                会话草稿区；.tried/<kind-dir>/<name>/<revision>/ 是试用时冻结的副本
```

`baseline` 是空能力包（等于步骤 3 的行为），不落盘，始终可加载。模型的文件工具读写整个 `.nexgent/capabilities/` 都被拒绝（`workspace` 的路径策略），只有本包的工具经宿主写草稿区。

## 存储与采用历史

- `writeBundle` 先在内存里按契约校验清单（`assertCapabilityManifest`、大小写冲突、文件与目录同名），再在 `.staging-<uuid>/` 写全部文件并 fsync，最后整体改名。版本已存在时只校验不重写。
- `loadBundle` 每次重新校验：清单哈希等于目录名、每个文件大小与 SHA-256 相符、没有清单以外的条目。失败是 `CapabilityIntegrityError`（`session/corrupt`，`reason`：`missing`、`manifest`、`version-mismatch`、`file-missing`、`file-mismatch`、`unexpected-entry`）。
- 修订按契约 `ActivationRevision` 写：`link` 独占发布、发布前比较链尾；每次采用或回滚先校验决定、发布修订（修订带 `decisionId`），修订发布成功后才写决定记录。两个进程同时发布同一修订恰好一个成功，落败的一方不留决定；门控落败时写 `rejected`（`interrupted`）。
- 链在某个文件处损坏时停在最后一个有效修订，`problem` 指出文件与原因，不猜、不修复；此时不能再采用或回滚。

## 改进器版本（`ImproverStore`，步骤 6）

改进器是另一条版本线，与能力包分开采用、分开回滚（ADR 0008 决策 1，`data-formats.md` §改进器版本）。ADR 0012 起它是用户级的：

- `ImproverStore.user({ home? })`（或不带目录的 `new ImproverStore()`）打开 `<NEXGENT_HOME>/improvers/`（`userImproversDir`，默认 `$NEXGENT_HOME` 或 `~/.nexgent`），`scope: 'user'`。同一主目录下的所有项目读到同一个生效的改进器，采用和回滚对它们都生效。
- `ImproverStore.project(layout)` 打开项目里步骤 6 写过的 `.nexgent/improvers/`（`improversDir`），`scope: 'project'`，只读：能查看历史、读出改进器，`write`、`adopt`、`rollback` 都报 `improver/activation`；`resolve` 遇到读不出的改进器不写回滚，返回 `v0` 与 `fallback`。旧数据不迁移，也不会被用户级版本线读成生效版本。
- 直接 `new ImproverStore(dir)` 按给定目录读写（`scope` 默认 `user`）；evolve、sdk 现有调用还在用项目目录，换成用户级由它们各自的工作包完成。

两种作用域的方法相同：

- `write(bundle)`：按 `assertImproverBundle` 与 schema 校验后，把规范化文本以独占创建写到 `bundles/<version>.json`。同一内容得到同一版本（`improverVersionOf`），已存在不重写；内容等于 `v0` 的版本号就是 `v0`，不写文件。
- `load(version)`：`v0` 返回内置 `IMPROVER_V0`；其余每次读都检查 schema、上下限与占位符，并核对内容哈希等于版本号。读不到是 `improver/not-found`，其他问题是 `improver/invalid`。
- `adopt(version, { jobId }, observed?)` 写 `trigger: meta-job` 的修订。`rollback({ trigger, toVersion?, reason? }, observed?)` 不带目标时回到上一个生效的改进器；带目标时只能回到链里更早生效过的版本，`v0` 总可以。回滚是新修订，不删任何文件。两者都用 `activation.ts` 的 `link` 独占发布，并在发布前比较链尾；链尾已变时返回 `null`。两个进程同时采用，恰好一个成功。
- `resolve()`：读出生效的改进器。读不出或校验不过时写 `load-failure` 回滚（`reason` 写原因），再试上一个，直到 `v0`。链本身损坏时停在最后一个有效修订并报告 `problem`，不再写入；如果这个修订的改进器也读不出，就用 `v0`（`fallback`）。
- 读文件与独占发布遇到 Windows 共享冲突时，按 `fs-retry.ts` 重试。

## 加载（`CapabilityService`，`ctx.capabilities`）

- `resolveVersion(recorded?)`：新会话取链尾；校验失败或组件不合格就写 `load-failure` 回滚（`trigger: 'load-failure'`），退回上一可用版本，直到 `baseline`。恢复会话传入记录的版本，仍可用就沿用，否则返回 `switched: { reason: 'unavailable' }` 供宿主写 `capability.version`。链损坏且链尾不可用时按 `baseline` 运行，不写任何修订。
- `status()`：当前版本、修订号、组件与 `problem`（链损坏或校验失败时给用户看的一句话，对应 SDK `CapabilityVersionView.problem`）。
- `bindSession` / `sessionVersion` / `components(sessionId, kind?)`：会话的组件 = 其版本的组件，被本会话试用的同名组件覆盖。其他会话看不到试用的组件。
- `ctx.capabilityHost`（kernel 的步骤 4 接口，`packages/kernel/src/capability-hooks.ts`）：`current` 取链尾（必要时先回滚），`verify` 检查恢复会话记录的版本，`attach` 把版本的组件装进 kernel 交来的 agent 作用域（恢复的根会话同时装回它试用过的非插件草稿），`componentOf` 认出团队模板（按队友名）与工作流图（同一张图）的使用。
- `attach(sessionId)`：把函数模块与插件的工具注册进该会话 agent 的作用域（随会话释放）；`capabilities` 上下文提供者在每轮开始调用它，没有 kernel 接入的宿主也能用。
- `toolComponent(sessionId, tool)`：工具属于哪个组件与版本（供 `componentsUsed`）。

各包的来源入口（只加入口，不改别的行为）：

| 包 | 入口 | 次序（同名时） |
| --- | --- | --- |
| `@nexgent/skill` | 技能列表与 `load_skill` 按会话合并能力包技能；注册 `skill` 组件校验 | 试用 > 项目 > 采用 > 用户 > 内置 |
| `@nexgent/preset`（`delegate`、`spawn_teammate`、工作流成员） | `sessionPresetRegistry(root, sessionId, lookup)` | 试用 > 项目 > 采用 > 内置 |
| `@nexgent/workflow` | 注册 `architecture` 组件校验；图以 `# Learned collaboration` 列给模型，由模型作为 `graph` 传入 | — |
| `@nexgent/context` | 压缩器 `setSessionOverride`：上下文策略的 `compaction` 只作用于该会话 | — |
| `@nexgent/ptc` | 函数模块的每次调用在独立 PTC 进程执行 | — |

团队模板以 `# Team templates` 输出。上下文策略的 `instructions` 与 `personaSuffix` 不再进系统提示（ADR 0018 决策 4），改由经验手册在用户消息之前给出（见下节）。

## 经验手册（`src/handbook/`，重做 V1，ADR 0018 决策 4、8、9）

- 存储：`HandbookLog` 是一个 `ops.jsonl`，用户级在 `<NEXGENT_HOME>/handbook/`，项目级在 `<NEXGENT_HOME>/projects/<projectId>/handbook/`。只追加，`seq` 连续，追加时取 `ops.lock`；锁的进程已经不在时破锁。条目是日志的折叠（契约 `foldHandbook`）。
- `Handbook.open({ projectRoot, home?, projectId?, learning? })` 给出一个项目看到的手册：
  - 读项目的 `learning.useShared` 与 `learning.contribute`。`useShared` 关掉时，不读也不检索用户级条目；`contribute` 关掉时，写到用户级的新条目改记为项目级。
  - `projectId` 取 `.nexgent/project.json`，没有这个文件时取根目录 realpath 的 SHA-256。
- 写入只经过 `apply(changes, { actor, source?, literals? })`，一次一条小操作：
  - `add` 先检查上限，再查重（词项 Jaccard ≥ 0.8 视为重复，不写）和具体数值（`findInstanceLiterals`，给了 `literals` 时；`taskLiteralSources` 收集一个任务的反馈与成果）。
  - `supersedes` 显式取代旧条目，被取代的条目退休；项目级条目不能取代用户级条目。
  - 投票在锁内检查：一个任务（`source.taskId`）对一条条目只投一票，也不能给从自己学来的条目投票（`already-voted`、`own-source`）。投票之后按 `nextHandbookStatus` 追加 `status`（`actor: host`），原因文字可以由调用方的 `statusReason` 给出（用户的语言）。
  - 具体数值：项目级条目里，项目常量（两个以上任务给过的值）可以保留；用户级条目所有项目都会读，所以不豁免。
  - `rollback(scope, toSeq)` 追加补偿操作，恢复文字、关键词与状态；票数不回退。
- 检索：`retrieve(text, { k?, exclude? })` 是 BM25。英文按词切分，`snake_case` 名字也算一个词；中日韩文字只取相邻两字，含“的、了、是、在”等虚词的两字不算。关键词计两次。相关性门槛：任务文字包含条目的某个关键词，或者与条目至少共享 2 个词、且覆盖条目自身得分的 20% 以上，才给出；一条都不过就什么都不给。只检索试用与启用的条目，默认前 5 条。索引按日志末尾缓存，1000 条时单次检索不到 50 ms。
- 注入：kernel 在根会话的用户轮写 `turn.start` 之前调用 `capabilityHost.handbookForTurn`（`HandbookHost.forTurn`），把选中的 id 写进 `turn.start.handbook`，把文字作为 `user.message { source: 'inject' }` 放在这一轮用户消息之前。不进系统提示。
  - 每轮只给这个会话还没给过的条目。
  - 会话所在能力版本的上下文策略：已采用版本的策略先迁成项目级、已启用的条目（`migrateContextPolicies`，每段或每个列表项一条，同一文字只迁一次），之后和其他条目一样检索。
  - 不是条目的策略只给一次：试验副本里的候选版本，或会话试用的草稿。
  - 改进会话只拿到自己试用的草稿策略。
- `handbook_mark`：只能标记本任务给过的条目（成员会话按根会话算）。每个根会话每个条目一票，重复的忽略。票的 `source.sessionId` 是根会话。
- 门控试验副本与比较臂副本（`isTrialCopy`：激活链第 1 条修订是复制时写的那条）只读手册：不迁移，标记不记票。
- 按使用情况下线（`src/handbook/usage.ts`，参照 Codex memories 的 `usage_count` / `last_usage` / `max_unused_days`）：
  - 每个手册目录在 `ops.jsonl` 旁边有 `usage.jsonl`：根任务每轮问手册时记一行 `turn`，检索找到的每条条目记一行 `hit`（`given` 表示给了模型）。“用到了”取 `ops.jsonl` 里的有用票。`Handbook.usage()` 给出每条条目的命中、给出、用到次数与最近时间。
  - `Handbook.retireIdle()` 下线没人用的条目，每条一个 `status: retired`（`actor: host`，原因以 `unused:` 开头）：启用的条目 90 天、试用的条目 60 天没被检索到，并且这段时间里至少跑过 10 个根任务（项目闲着不算没用）；或者试用条目给过 8 个任务都没被说用到。条目被新增、修改、用到、恢复时重新计时。
  - `HandbookHost.forTurn` 每轮先调 `retireIdle()`，检索后调 `recordTurn()`；试验副本和改进会话都不做。记录失败不影响任务。
  - 检索分数相同时，先排“用到次数 / 给出次数”高的，再排最近用到的。
  - `Handbook.restore(entryId)`：用户把下线的条目恢复到下线前的状态（`actor: user`）；被取代的条目不能恢复。
  - 阈值是代码常量（`HANDBOOK_IDLE_DAYS`、`HANDBOOK_IDLE_MIN_TASKS`、`HANDBOOK_UNUSED_GIVEN_LIMIT`），改进器改不到。

## 三个工具

- `capability_draft`：校验全部输入（路径、上限、种类）后才写；返回修订号 = 本会话该组件的第几次草稿。工具说明里写明每种组件入口文件的格式与一个最小示例（`src/formats.ts`，测试保证示例能通过校验）。
- `capability_try`：校验草稿（契约 schema、名字一致、入口文件存在、已注册的种类校验；格式不合时一次列出所有问题并附上期望格式），冻结为该修订，加载进本会话。插件先问用户（`risk: high`，只有“本次允许”），拒绝时不导入、不执行任何代码；加载失败时本会话保留试用前的状态。
- `capability_propose`：每个组件在最近一次试用之后必须有一次成功使用（函数或插件的工具调用、`load_skill`、带该预设的 `delegate` / `spawn_teammate` / 工作流节点、`spawn_teammate`、带图的 `workflow`；上下文策略要求试用之后有一轮正常结束），否则拒绝并列出缺什么。通过后写候选包与 `candidates/<id>/`。
- 改进作业的提议会话里，`capability_propose` 还做具体数值检查（ADR 0013 决定 2，`src/instance-literals.ts`）：把组件的全部文本文件与作业的反馈原文、反馈任务各版本成果的文本文件比较，原题里出现、而在本项目少于两个任务的用户消息里出现的数值或日期（`findInstanceLiterals`）命中即拒绝（`capability/instance-literal`）。工具结果只列出命中的值、所在文件与来源，不给改法；会话可以改后再提。提议会话开在快照副本里，作业、反馈与成果都在真实项目：工具从会话存储的 `sessionsDir`（`@nexgent/sdk` 把它指向真实项目）推出真实项目，在那里与本项目里找作业（`layoutOfSessionsDir`、`findJobLayout`）；两处都读不到作业时拒绝提出（`tool/failed`），不跳过检查。用户自己任务里的提交不做这项检查。门控可以复用 `checkJobLiterals`、`jobLiteralSources`、`projectTaskMessages`。
- 会话所用的能力版本里已有内容完全相同的同名组件时（门控候选侧回放“起草、试用、提交”就是这种情形），`capability_try` 与 `capability_propose` 不报错也不写候选，直接说明“已在当前版本中（版本号）”；内容不同的同名组件照常走试用与提交。
- 三个工具都拒绝成员调用。

## 函数模块与插件的执行边界

- 函数模块：工具名 `cap_<module>_<function>`，effects `['execute', ...声明]`，`selfSandboxed`。每次调用起一个 PTC 进程（空环境变量、Node 权限模型、时限与输出上限），模块源码由宿主读出后以 `data:` URL 导入；函数收到 `(input, host)`，`host` 是 `run_code` 的项目函数，按调用会话的沙箱检查，声明 `write` 才给写函数。模块须是单个自包含 `.mjs`。
- 插件：在宿主进程内以 Cordis 插件加载到该会话的作用域，卸载即释放；声明的工具名不能与会话已有工具重名。

## 门控 `capability_trial`（`src/trial/`）

- 触发：根会话一轮结束后，插件先跑用量退化检查，再为该会话提出、未试过、未决定的候选启动门控进程（`capabilities.autoTrial` 开且行配置有 `trial.entry` 时；SDK 填的是 `@nexgent/sdk` 的 `trial-entry.js`）。进程分离运行，CLI 退出后继续；日志在 `trials/<candidateId>.log`。
- 回放集：有快照树、检查记录（至少一条）与根会话用户消息的历史任务，一个根任务一个用例，回放它的全部用户消息。selection 先放提出候选的任务，再按与它首条消息的词重合度从高到低；guard 取最不相似的，两边不重叠。不够时返回 `waiting`，什么都不写。
- 运行：每个用例每侧 `repeats` 次，候选在前；每次在快照的临时副本里（`autoTrial` 关、`perTask` 上限取剩余试验额度），由宿主的 `TrialRunner` 执行（产品里每次一个 `trial-entry.js replay` 子进程，审批一律 `headless` 拒绝），之后门控自己在副本上跑记录的检查。没跑完的记 `unknown`，不算失败。每次运行前查额度，用尽即停，结论 `budget-exhausted`。
- 判定：`decideTrial`。只有检查打平且费用比不超上限时才问评审模型（`TrialReviewer`，SDK 里是 Claude Platform 上的 `capabilities.reviewer` 模型；ADR 0016 起每对运行按候选在 A、候选在 B 各问一次，两次一致才计票，否则算平局，见下），评审意见单独记 `trial.review`。通过写 `trigger: gate` 的采用修订；含插件的写 `awaiting-approval`；其余写 `rejected`。候选、回执、决定都保留。门控参数只读 `.nexgent/config.json`。
- 一次性与中断：候选首次试验前独占创建 `trials/<candidateId>.attempt`，之后不再试；运行中有 `trials/<trialId>.lock`（进程号）。启动时 `recoverInterruptedTrials` 把没有 `trial.end`、锁对应进程已不在的试验记为 `rejected / interrupted`，不重跑。
- 步骤 5（ADR 0006 决定 6、7）：
  - 有逐轮检查记录（`checks/<taskId>.t<turn>.json`）的任务，回放到首次反馈之前最后一个有检查的轮次（`throughTurn`），按那一轮的检查判定；反馈轮和其后的消息都不回放。步骤 4 的任务（没有逐轮记录）照旧。改进会话（`purpose: improvement`）不是用例。
  - 改进作业的候选（`origin: improvement`）以作业的反馈任务为 selection 首个用例（`selectionAnchor`，读 `improvements/<jobId>/job.json`：首条反馈的会话，否则请求的会话或任务，否则失败检查的任务），不是候选自己的 `taskId`。该任务不能回放时门控返回 `skipped`，手动 `trial` 抛 `tool/invalid-input`。这类候选不由 `startPending` 自动起门控，由作业自己跑（历史不够时作业停在 `waiting-history`，之后再跑）。
  - 反馈任务的每次 selection 运行之后做一次反馈检查（`TrialReviewer.checkFeedback`，SDK 里一次运行一个请求，只看该次运行的产出与反馈原文，不做 A/B 对比），记 `trial.feedback`，计入该侧质量，另给 `feedbackPassRate`。没有检查器、运行 unknown、额度用尽时检查记 `unknown`，候选不被采用（`unknown-runs`）。
  - 作业候选的回放运行带 `improvement.jobId`；SDK 的回放进程里 `ctx.agents.create` 加 `improvement: { jobId, phase: 'trial' }`，评审与反馈检查的账本记录也带 `improvementId` 与 `improvementPhase: trial`。
  - `estimatedUsd` 由运行器与评审给出（SDK 用 `@nexgent/llm` 的 `estimateUsd`），有一项 unknown 则合计 unknown。
- ADR 0007（用户 2026-10-13 选 C）：两臂的美元都已知时，费用比按美元算（含缓存），否则按 token。质量提高时不因费用拒绝，费用比超过 `costApprovalRatio`（默认 2）时改为 `await-approval`，说明文字写明倍数和两臂的美元。打平时规则不变（更省才采用，评审偏好时比值 ≤ `costRatioCap`）。
- 步骤 6（ADR 0008 决策 4、5）：
  - **纪元**：`evaluatorEpoch(capabilities)` 是评价器设置（规则 id、`costRatioCap`、`costApprovalRatio`、`guardCases`、`reviewer`）规范化文本的 SHA-256，`selectionCases`、`repeats` 与预算不在内。门控把它冻结进 `TrialPlan.epoch`；`GateOptions.epoch`（`runGateProcess(…, { epoch })`）与项目纪元不同时什么都不写，抛 `improvement/epoch-mismatch`。`trialEpoch(receipts)` 读出试验的纪元，`assertSameEpoch([...])` 在纪元不同或缺纪元（步骤 4–5 的试验）时抛同一错误码。
  - **项目副本**：`prepareProjectCopy({ layout, origin, version, tempRoot? })` 给比较臂用，内容如下：
    - 工作树取起点快照；
    - 复制 `.nexgent/` 历史，不含 `improvements/`、`capabilities/`、`config.json` 和锁文件；
    - 能力链从起点版本重新开始；
    - 配置里关掉 autoTrial、autoImprove 和元改进，评价器设置不动，并核对副本纪元与项目一致；
    - 副本必须放在项目之外。
    副本里的门控在副本外另建回放副本，采用只发生在副本里。`release({ keep })` 默认删除副本；要求保留时，不超过 `KEEP_COPY_MAX_BYTES`（快照上限）就保留并返回 `{ root, bytes }`，超过则删除并返回 `too-large`。
  - 作业候选的回放请求带 `improvement: JobRunAttribution`（`jobId`、`improverVersion`，比较臂另带 `metaJobId`、`comparisonArm`），来自作业的 `job.json`；SDK 的回放进程与评审把这些写进账本。
- 步骤 6 返工（ADR 0013、0014，纪元 `adr-0014`，ADR 0015 起 `adr-0015`，ADR 0016 起 `adr-0016`），只对改进作业的候选：
  - **具体数值**：核对纪元之后、建回放集之前，`candidateInstanceLiterals`（`src/trial/literals.ts`）用契约 `findInstanceLiterals` 检查提出组件的文本文件。来源是作业的反馈原文与请求 `note`、作业所涉会话的成果各版本文本文件；项目常量按全部根任务会话的用户消息算。命中即占用候选、写 `rejected / instance-literal` 决定（带 `instanceLiterals`），不建试验、不回放，`runGate` 返回 `{ status: 'refused', decision }`。
  - **同类题**（ADR 0014，`src/trial/similar.ts`）：选择集中除反馈原题外、首条消息与它的内容词 Jaccard 重合度 ≥ 0.25 的用例；内容词去掉功能词表 `FUNCTION_WORDS` 与纯数字。它们的确定性检查单独计为 `TrialTally.similar`（没有时为 `'none'`），由 `decideTrial` 判定 `similar-regression` 或 `no-similar-cases`；说明文字写出同类题通过率，待批准时写明“只在原题上验证过”。用户任务自己提出的候选不受影响。
- ADR 0015（纪元 `adr-0015`），对所有候选：`runOutput` 先找出全部改动文件，前 `OUTPUT_FILES` 个给内容，其余与回放中删掉的快照文件只列路径（各至多 `OUTPUT_PATHS` 条），评审不再把列表截断当成没做；作业的反馈原题打平时，`ReviewInput.feedback` 带上反馈原文。反馈检查与评审的提示在 SDK `trial-entry.ts`。
- ADR 0016（纪元 `adr-0016`），对所有候选：评审每对运行问两次（`ReviewInput.candidateFirst`），`bothOrders` 合并，两次一致才计票，否则平局，任一次 `unknown` 整对不计；一对一条回执，理由写两次的回答，费用相加。评审另看到该用例快照里的输入文件（`ReviewInput.inputs`，任务消息点名的在前，前 `OUTPUT_FILES` 个给内容）；宿主给的 `GateOptions.documentText` 把非 UTF-8 文件转成文字（SDK 用 `@nexgent/skill` 读 xlsx、docx、pdf），输入、成果与反馈检查看到的成果都用它。
- ADR 0014，对所有候选：回放后，`file-exists` / `parses` 记录的路径在副本里不存在时，`runCheckSpecs(…, { delivered })` 改查这次运行 `present` 的成果里下一个扩展名相同、不在记录路径上的文件（一文件替一路径，`detail: delivered under another path`）。照反馈改名或换目录不再判为退步；没交付同类文件照旧失败。
- 用量退化：`checkUsageRegression` 在根会话解析版本前和每轮结束后执行，只看 `gate` / `approval` 采用之后、该版本上的非试验记录：新组件工具的 `tool.call` 错误序列与根任务 `task.outcome.checks`（刚结束那一轮用 `turnOutcome()` 补上），交给 `decideUsageRollback`，触发即写 `usage-regression` 回滚。

## 自评与练习题集（`src/learning/`，重做 G1，ADR 0018 决策 2、3，ADR 0019 决策 1、3、6、7）

- `selfEvaluate`：根任务结束时由宿主（`@nexgent/evolve` 的学习队列）调用，每个任务只写一次 `<数据目录>/evaluations/<taskId>.json`。确定性检查 = 内核记下的这一轮检查 + 通用检查（`genericChecks`：回答与文本成果里引用的项目文件存在；末行标为合计的表格各数字列等于上面各行之和）。按 `selfEvalSample` 抽中时，执行模型先只看任务消息与开始时的输入文件写 3–8 条评分要点（`generator: v0`，提示写在本包，改进器改不了），再对照结果打分；思考关闭，提示有字数上限，发请求前按最坏情况估价，单任务不超过 `learning.selfEvalMaxUsd`。结局见契约 `selfEvalOutcome`：有评分要点得分时按它分档。再次调用只合并用户反馈；门控试验副本、子会话和改进会话不评。
- 模型由宿主注入（`SelfEvalModel`，`providerSelfEvalModel` 包装内核 provider），每个请求带 `phase`（账本 `learningPhase`）与 `taskId`。
- 校准：抽中的已打分任务按 `CALIBRATION_SAMPLE_RATE` 再由外部评审（默认 `claude-opus-5-5`，开思考、effort `low`）用同一份要点和检查打分，`agree` = 两边结局相同；预算须够它的最坏花费再加一个单任务上限。`scorerReliabilityOf` 按项目或整个用户目录算一致率。
- 练习题集：项目允许贡献（`learning.contribute`）且有评分要点时，任务进 `<NEXGENT_HOME>/practice/cases/`；相似度键是任务文字里最常见的词，与已有题的键 Jaccard ≥ 0.25 就并入它的簇，同簇同组（`practiceSplit`）。`listPracticeCases` 默认只给学习者 `train` / `selection`；`audience: 'measure'` 才看到 `holdout` 与 `guard`。`loadGenericPracticeCases` 载入测量给的通用防退步题（只收 `generic` / `guard`，已有的不覆盖）。
- 纪元规则骨架（`src/trial/epoch-rules.ts`）：`epochVerdict` 把学到的候选“打平更省”的采用记为 `cost-optimized`；评分器不是 `reliable` 时技能改为等用户批准、框架改动不往下走（`scorer-unreliable`）；用户提出的候选照旧。`evolutionCount` 不把 `cost-optimized` / `cost-down` 计为进化。接入门控是 G2 的事。

## Known Limitations and Deferred Work

- `trials/` 下的 `.attempt`、`.lock`、`.log` 三种旁路文件还没写进 `data-formats.md`。
- `test-command` 检查只认 `TEST_COMMAND_PATTERN` 里的测试命令（`@nexgent/tasking`），`node checks/verify.mjs` 这类脚本不会成为检查。
- 回放只发用户消息，反馈轮的成果修改与审批不重放；`estimatedUsd` 只在价格表有该模型且用量各项已知时是数字。
- 契约 `SkillSource` 没有能力包来源，能力包技能标为 `project`；`workflow` 工具不能按名字引用已采用的图；`personaSuffix` 与 `instructions` 一样作为做法文字给出，没有接到人设段落。
- 恢复的会话不会自动重新加载试用过的插件（重新加载要再问一次用户），需要再次 `capability_try`。
- 能力包目录不设只读属性，完整性只靠加载时校验；Windows 上的硬链接发布与目录改名竞争还没有实跑。
