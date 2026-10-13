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
- 修订按契约 `ActivationRevision` 写：`link` 独占发布、发布前比较链尾；每次采用或回滚先写决定记录，再发布修订（修订带 `decisionId`）。两个进程同时发布同一修订恰好一个成功。
- 链在某个文件处损坏时停在最后一个有效修订，`problem` 指出文件与原因，不猜、不修复；此时不能再采用或回滚。

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

上下文策略的 `instructions` 与 `personaSuffix` 以 `# Learned practices` 输出，团队模板以 `# Team templates` 输出。

## 三个工具

- `capability_draft`：校验全部输入（路径、上限、种类）后才写；返回修订号 = 本会话该组件的第几次草稿。工具说明里写明每种组件入口文件的格式与一个最小示例（`src/formats.ts`，测试保证示例能通过校验）。
- `capability_try`：校验草稿（契约 schema、名字一致、入口文件存在、已注册的种类校验；格式不合时一次列出所有问题并附上期望格式），冻结为该修订，加载进本会话。插件先问用户（`risk: high`，只有“本次允许”），拒绝时不导入、不执行任何代码；加载失败时本会话保留试用前的状态。
- `capability_propose`：每个组件在最近一次试用之后必须有一次成功使用（函数或插件的工具调用、`load_skill`、带该预设的 `delegate` / `spawn_teammate` / 工作流节点、`spawn_teammate`、带图的 `workflow`；上下文策略要求试用之后有一轮正常结束），否则拒绝并列出缺什么。通过后写候选包与 `candidates/<id>/`。
- 会话所用的能力版本里已有内容完全相同的同名组件时（门控候选侧回放“起草、试用、提交”就是这种情形），`capability_try` 与 `capability_propose` 不报错也不写候选，直接说明“已在当前版本中（版本号）”；内容不同的同名组件照常走试用与提交。
- 三个工具都拒绝成员调用。

## 函数模块与插件的执行边界

- 函数模块：工具名 `cap_<module>_<function>`，effects `['execute', ...声明]`，`selfSandboxed`。每次调用起一个 PTC 进程（空环境变量、Node 权限模型、时限与输出上限），模块源码由宿主读出后以 `data:` URL 导入；函数收到 `(input, host)`，`host` 是 `run_code` 的项目函数，按调用会话的沙箱检查，声明 `write` 才给写函数。模块须是单个自包含 `.mjs`。
- 插件：在宿主进程内以 Cordis 插件加载到该会话的作用域，卸载即释放；声明的工具名不能与会话已有工具重名。

## 门控 `capability_trial`（`src/trial/`）

- 触发：根会话一轮结束后，插件先跑用量退化检查，再为该会话提出、未试过、未决定的候选启动门控进程（`capabilities.autoTrial` 开且行配置有 `trial.entry` 时；SDK 填的是 `@nexgent/sdk` 的 `trial-entry.js`）。进程分离运行，CLI 退出后继续；日志在 `trials/<candidateId>.log`。
- 回放集：有快照树、检查记录（至少一条）与根会话用户消息的历史任务，一个根任务一个用例，回放它的全部用户消息。selection 先放提出候选的任务，再按与它首条消息的词重合度从高到低；guard 取最不相似的，两边不重叠。不够时返回 `waiting`，什么都不写。
- 运行：每个用例每侧 `repeats` 次，候选在前；每次在快照的临时副本里（`autoTrial` 关、`perTask` 上限取剩余试验额度），由宿主的 `TrialRunner` 执行（产品里每次一个 `trial-entry.js replay` 子进程，审批一律 `headless` 拒绝），之后门控自己在副本上跑记录的检查。没跑完的记 `unknown`，不算失败。每次运行前查额度，用尽即停，结论 `budget-exhausted`。
- 判定：`decideTrial`。只有检查打平且费用比不超上限时才问评审模型（`TrialReviewer`，SDK 里是 Claude Platform 上的 `capabilities.reviewer` 模型，A/B 位置按轮次交换），评审意见单独记 `trial.review`。通过写 `trigger: gate` 的采用修订；含插件的写 `awaiting-approval`；其余写 `rejected`。候选、回执、决定都保留。门控参数只读 `.nexgent/config.json`。
- 一次性与中断：候选首次试验前独占创建 `trials/<candidateId>.attempt`，之后不再试；运行中有 `trials/<trialId>.lock`（进程号）。启动时 `recoverInterruptedTrials` 把没有 `trial.end`、锁对应进程已不在的试验记为 `rejected / interrupted`，不重跑。
- 步骤 5（ADR 0006 决定 6、7）：
  - 有逐轮检查记录（`checks/<taskId>.t<turn>.json`）的任务，回放到首次反馈之前最后一个有检查的轮次（`throughTurn`），按那一轮的检查判定；反馈轮和其后的消息都不回放。步骤 4 的任务（没有逐轮记录）照旧。改进会话（`purpose: improvement`）不是用例。
  - 改进作业的候选（`origin: improvement`）以作业的反馈任务为 selection 首个用例（`selectionAnchor`，读 `improvements/<jobId>/job.json`：首条反馈的会话，否则请求的会话或任务，否则失败检查的任务），不是候选自己的 `taskId`。该任务不能回放时门控返回 `skipped`，手动 `trial` 抛 `tool/invalid-input`。这类候选不由 `startPending` 自动起门控，由作业自己跑（历史不够时作业停在 `waiting-history`，之后再跑）。
  - 反馈任务的每次 selection 运行之后做一次反馈检查（`TrialReviewer.checkFeedback`，SDK 里一次运行一个请求，只看该次运行的产出与反馈原文，不做 A/B 对比），记 `trial.feedback`，计入该侧质量，另给 `feedbackPassRate`。没有检查器、运行 unknown、额度用尽时检查记 `unknown`，候选不被采用（`unknown-runs`）。
  - 作业候选的回放运行带 `improvement.jobId`；SDK 的回放进程里 `ctx.agents.create` 加 `improvement: { jobId, phase: 'trial' }`，评审与反馈检查的账本记录也带 `improvementId` 与 `improvementPhase: trial`。
  - `estimatedUsd` 由运行器与评审给出（SDK 用 `@nexgent/llm` 的 `estimateUsd`，只作显示），有一项 unknown 则合计 unknown。
- 用量退化：`checkUsageRegression` 在根会话解析版本前和每轮结束后执行，只看 `gate` / `approval` 采用之后、该版本上的非试验记录：新组件工具的 `tool.call` 错误序列与根任务 `task.outcome.checks`（刚结束那一轮用 `turnOutcome()` 补上），交给 `decideUsageRollback`，触发即写 `usage-regression` 回滚。

## Known Limitations and Deferred Work

- `trials/` 下的 `.attempt`、`.lock`、`.log` 三种旁路文件还没写进 `data-formats.md`。
- `test-command` 检查只认 `TEST_COMMAND_PATTERN` 里的测试命令（`@nexgent/tasking`），`node checks/verify.mjs` 这类脚本不会成为检查。
- 回放只发用户消息，反馈轮的成果修改与审批不重放；`estimatedUsd` 只在价格表有该模型且用量各项已知时是数字。
- 契约 `SkillSource` 没有能力包来源，能力包技能标为 `project`；`workflow` 工具不能按名字引用已采用的图；`personaSuffix` 输出在 `# Learned practices` 节，没有接到人设段落。
- 恢复的会话不会自动重新加载试用过的插件（重新加载要再问一次用户），需要再次 `capability_try`。
- 能力包目录不设只读属性，完整性只靠加载时校验；Windows 上的硬链接发布与目录改名竞争还没有实跑。
