# agent loop 挂点、步骤 2 工具与系统提示增量

> 字段名以 `packages/kernel/src/contracts/` 为准。文中的“ADR 00xx”“步骤 n”是原来的决定编号和开发阶段，现行决定见 [设计决定](../decisions.md)（每条末尾括号里注明原 ADR 编号）。

## 目的与范围

步骤 1 的 agent loop 只有“组装请求 → 流式调用 → 执行工具 → 写记录”。步骤 2 要在不改变这条主线的前提下接入：每轮开始时的上下文注入、每次模型调用前的压缩检查、每次工具调用后的文件变更收集、`present` 工具写成果记录、宿主在轮次之外写资料与目标记录。本文固定这些挂点的**位置、顺序、失败语义**，以及步骤 2 新工具的名字与参数、系统提示的增量文本。

## 服务

三个可选的 Cordis 服务；没有装载时 loop 的行为与步骤 1 完全相同（这是步骤 1 测试与 `accept-step1` 继续通过的前提）。

| 服务 | 契约 | 提供者 | loop 用它做什么 |
| --- | --- | --- | --- |
| `ctx.context` | `ContextService` | `@nexgent/context` | 轮次开始时依次调用 `providers` 的 `beginTurn`；每次模型调用前问 `compactor` |
| `ctx.tasking` | `TaskingService` | `@nexgent/tasking` | 轮次开始与结束调用 `files`（`TurnFileTracker`）；每次工具调用后 `files.observe` |
| `ctx.skills` | `SkillRegistry` | `@nexgent/skill` | loop 不直接调用；`@nexgent/skill` 向 `ctx.context` 注册技能清单提供者，并注册 `load_skill`、`read_document` 工具 |

其他包向 `ctx.context.register(provider)` 注册自己的提供者：`@nexgent/tasking` 注册目标提供者（`id: 'goal'`），`@nexgent/skill` 注册技能清单提供者（`id: 'skills'`），`@nexgent/context` 自带说明文件提供者（`id: 'workspace-instructions'`）与资料引用提供者（`id: 'materials'`）。调用顺序固定为：`workspace-instructions`、`goal`、`skills`、`materials`，其余按注册顺序排在后面。

## 一轮的顺序

带 `*` 的是步骤 2 新增；括号内是写出的会话记录。

1. 写 `turn.start`。新方向第二步：根会话写之前先调 `ctx.organizer.decide(...)`（可选，见 §宿主接口），决定写进 `turn.start.organization`，返回的提示节在本轮每次请求里渲染进系统提示（在提供者的节之后，不写会话）；出错时当作没有决定。
2. \* 反馈轮：写 `feedback`（SDK 的 `feedback.submit` 发起；普通轮没有这一步）。
3. \* `ctx.tasking.files.beginTurn(sessionId, turn)`：记录工作区的“轮前”状态。
4. \* 依次调用每个 `ContextProvider.beginTurn(input)`，收集 `ContextContribution`：
   - `systemSections` 在本轮的每次请求里渲染进系统提示（见“系统提示的组装”），**不写会话**；
   - `inject` 的每一段写一条 `user.message { source: 'inject' }`，按提供者顺序，在用户消息**之前**。
5. 写用户消息 `user.message { source: 'user' | 'feedback', materials? }`。`materials` 是本条消息引用的资料 ID（`SendMessageInput.materialIds`），资料引用的正文由 `materials` 提供者在第 4 步作为 `inject` 写出。
6. 步骤循环，每一步：
   1. 取消检查、费用上限检查（步骤 1 不变）；调用次数检查：本轮已用满 `maxSteps` 次调用时以 `cancelled`、`cause: 'step-limit'` 结束本轮（ADR 0021；此前是 `internal` 错误），用满前的最后一次调用（`maxSteps` ≥ 4 时）先注入一条收尾提示 `user.message { source: 'inject' }`；
   2. \* 压缩检查：有 `compactor` 且本轮还没有失败过压缩时调用 `shouldCompact(input)`；为真则 `compact(input, signal)`，成功后写 `compaction` 并按投影规则替换内存中的历史；
   3. 步骤 3：逐次注入：在压缩检查之后、模型请求之前，按登记顺序调用 agent 上的 `beforeRequest` 注入器（kernel 接口 `Agent.beforeRequest`，不是契约，见 §宿主接口；`@nexgent/team` 用它在运行中的队友下一步之前投递邮件），返回的每段写一条 `user.message { source: 'inject' }` 并随本次请求发出（每一步都调用，包括第 1 步，此时注入记录在用户消息之后）；续接 `pause_turn` 回复的那次请求之前不调用；注入器抛错时本次请求跳过它，写 `error`（`fatal: false`）；
   3a. 新方向第一步：运行中插话（`Agent.steer(text, { materialIds? })`；带资料时，消息之后由 `materials` 上下文提供者照轮开始的方式写一条 `user.message { source: 'inject' }` 的资料引用，消息记录带 `materials`）。用户在轮次进行中发的消息（`Agent.steer`，见 §宿主接口）先排队，在逐次注入之前各写一条 `user.message { source: 'user' }` 并随本次请求发出；续接 `pause_turn` 回复的那次请求之前不写。回复没有工具调用、但有消息在排队时，本轮不结束，继续下一步回答它。
   4. 模型请求，写 `assistant.message`（步骤 1 不变）；provider 重试可重试的失败时 loop 发 `request.retry` 事件，不写会话记录（账本里每次尝试各有一对记录）。请求因提示超过上下文窗口失败（`details.contextOverflow`）时，写 `error`（`fatal: false`），不经 `shouldCompact` 直接压缩一次并重发，每轮一次（ADR 0021）。回复因输出上限停下（`max-tokens`）时，它的工具调用不执行，各写一条错误 `tool.result`，再注入一条“接着写”的提示并继续；连续超过 `maxOutputContinuations`（默认 3）次才以 `max-tokens` 结束本轮；
   5. 执行工具：每个调用写（`approval.*`）→ \*（工具通过 `appendRecord` 追加的记录，如 `deliverable.presented`）→ `tool.result`；\* 每个 `tool.result` 之后调用 `files.observe(...)`。
6a. 步骤循环结束（含检查重试）后不再接收插话；本轮没来得及回答的插话（轮次被停止、出错或用满调用次数）照样写成 `user.message { source: 'user' }`，留在历史里给下一轮。
7. \* `ctx.tasking.files.endTurn(sessionId, turn, signal)`，写 `turn.files`（列表为空也写）。
8. 写 `turn.end`；按步骤 1 规则写 `checkpoint`。

完整的一轮记录顺序因此是：

```text
turn.start → [feedback] → user.message(inject)* → user.message(user|feedback)
  → ( [compaction] → user.message(inject)* → assistant.message → ( [approval.*] → [deliverable.presented] → tool.result )* )*
  → turn.files → turn.end → [checkpoint]
```

轮次之外，宿主（SDK）经持锁的 agent 追加 `material.added`、`goal.set`、`goal.update`（契约 `HostRecordType`）；它们可以出现在两轮之间，也可以出现在一轮之中（此时带 `turn`）。只读的调用方不能写记录。

## 失败语义

| 挂点 | 失败时 |
| --- | --- |
| `ContextProvider.beginTurn` 抛错 | 跳过这个提供者，写一条 `error`（`fatal: false`，`code` 取错误自身的，非 Nexgent 错误为 `internal`），本轮照常进行 |
| `Compactor.compact` 抛错或被中止 | 写 `error`（`fatal: false`）；保留未压缩的历史；本轮不再尝试压缩（`CompactionCheckInput.failedThisTurn` 为真）；摘要请求本身照常在账本里有 `llm.request.start/end`（`purpose: 'auxiliary'`） |
| 压缩结果不合法（`keepMessages` 越界、保留段以工具结果开头） | 等同 `compact` 失败；`SessionStore.append` 在写入前用投影检查它，不会落盘 |
| `TurnFileTracker.observe` 抛错 | 吞掉，不影响工具结果 |
| `TurnFileTracker.endTurn` 抛错 | 写 `error`（`fatal: false`），不写 `turn.files`，照常写 `turn.end` |
| 工具的 `appendRecord` 失败 | 该工具调用以错误结束（`tool/failed`），模型拿到错误；已写入的快照文件留在 `outputs/`，但没有会话记录指向它（列成果时按 `deliverable.json` 列出，见 `data-formats.md` §成果元数据） |
| 进程在轮中死亡 | 没有 `turn.files`；恢复时按步骤 1 规则补 `turn.end { kind: 'interrupted' }` |

取消（用户、超时、关闭、费用上限）时第 7 步照常执行，`endTurn` 的 `signal` 给 5 秒上限；上限到了就报告已比较到的部分。

## 系统提示的组装

每次请求的系统提示按以下顺序拼接，节之间空一行；同一轮内各次请求的系统提示逐字节相同（缓存前缀稳定）：

1. 步骤 1 的人格段与 `# Environment`（`renderSystemPrompt`，不变）；
2. ~~步骤 1 的 `# Tools` 列表~~（K2 去掉：工具定义随请求的 `tools` 发送，提示里再列一遍是重复）；
3. \* `# Working with files`（见下节，已由 PR #8 落进 `system-prompt.ts`）；
4. \* 本轮各提供者的 `systemSections`，每节渲染为 `# <title>` + 换行 + `body`，按提供者顺序、同一提供者内按 `id` 排序；
5. 步骤 1 的结尾行（`suffix`）。

提供者的建议内容（由各包实现，不是契约）：说明文件提供者输出 `# Project instructions`（项目根 `AGENTS.md`，没有则 `NEXGENT.md`，大小上限与截断规则写在 `@nexgent/context` 的 README）。**会变的内容不进系统提示**（K2，审查 P28：系统提示一变，缓存前缀就失效）：目标提供者在有 `active` 目标、且模型看到的历史里还没有当前目标时，以 `inject` 注入一条 `# Current goal`（目标设定或修改后的第一轮，以及压缩之后）；技能提供者在技能列表与这个会话上次注入的不同时，以 `inject` 注入技能列表（名称、一行描述、触发说明，并说明用 `load_skill` 读全文）。

## 系统提示增量

`# Working with files` 一节由 `packages/kernel/src/system-prompt.ts` 的 `fileGuidance` 生成（PR #8，W7），每一条只在对应工具可见时出现，所以提示里不会出现模型调不了的工具。必须表达的内容（措辞以代码为准，改动需同时更新本节）：

1、2、2a. **（K2 去掉，ADR 0017 第 1 条）** 原来这里写“改已有文件用 `str_replace`，多处修改分多次调用”“`write_file` 只新建”“不经 shell 新建或修改文件”。前两条与工具描述重复；第三条来自步骤 2 R02 一次运行的模型习惯，属于用例特化。K2 起编辑工具本身放宽（`write_file` 可覆盖本会话读过的文件或带 `overwrite: true`，`str_replace` 支持 `replace_all` 与一次多处编辑，`read_file` 带行号，见 `permissions.md` §路径策略与写入限制），怎么写改文件只由工具描述说明；`bash` / `pwsh` 的描述只留一句“改文件优先用 write_file / str_replace”。
3. 结果就绪时用 `present` 声明交付，每次修订后再次声明；再次声明时带上 `present` 返回的 `deliverableId`，使之成为同一成果的新版本。——已实现。
3a. **成果提醒**（2026-10-13 加，K1 去掉）：原来根会话在一次带 `write` 效果的工具调用成功、本轮还没有交付时，下一次请求前注入 `PRESENT_REMINDER`，每 `PRESENT_REMINDER_EVERY`（8）步至多一次；第 3 条也要求“改了项目文件（包括改代码）就用 `present` 声明”。这让 `present` 成了每个改文件任务的闸门（系统设计审查 P21）。K1 起不再注入提醒；第 3 条改为“用户要的成果文件（报告、文档、表格、图）用 `present` 声明；普通的代码修改不需要 `present`，改动过的文件本来就会展示给用户”。轮内改了哪些文件由 `turn.files` 给出，桌面应用在这一轮下面列出“本轮改动的文件”（已有）。——已实现。
4. 用户附加的资料是只读副本，按随资料给出的路径读取，结果写进项目（K1 起资料在用户数据目录里，路径是绝对路径；数据还在项目里的旧项目仍是 `.nexgent/materials/` 下的相对路径）。只在项目有资料（`ctx.tasking.materials.list()` 非空，轮次开始时检查）时出现。——已实现。

第 3 条对应链路里的 present / v2。

## 步骤 2 工具

名字、参数 schema、`effects` 与 `approval` 冻结在 `step2-tools.ts`；描述文字由实现包写，可以改。

| 工具 | 实现包 | 参数 | effects / approval | 行为要点 |
| --- | --- | --- | --- | --- |
| `present` | tasking | `paths: string[]`（1–50，第一项是主文件）、`summary: string`、`title?`、`deliverableId?` | `['read']` / `never` | 校验每个路径在项目内、存在、是文件、不在 `.nexgent/` 下；生成新版本快照；经 `ToolContext.appendRecord` 写 `deliverable.presented`；工具结果文本给出 `deliverableId` 与版本号；`read-only` 模式下也可用（快照由宿主写） |
| `todo_write` | tasking | `todos: {text, status: pending\|in_progress\|done}[]`（≤30 项，每项 ≤200 字） | `['read']` / `never` | 每次调用替换整份计划；结果文本是清单（`[ ]` / `[~]` / `[x]`），`meta.todos` 带整份列表，界面据此显示计划（K2） |
| `load_skill` | skill | `name: string` | `['read']` / `never` | 返回技能正文；未知名字返回工具错误 `tool/not-found` |
| `read_document` | skill | `path: string`、`sheet?`、`maxRows?`（默认 500）、`pages?` | `['read']` / `never` | `.docx` 转文本，`.xlsx` 转表格（逐 sheet，CSV 式文本），`.pdf` 转文本；损坏文件返回工具错误而不是崩溃；路径按读策略检查（`materials/` 可读）；不写任何文件 |

`present` 的路径匹配规则（同一成果的后续版本）：给了 `deliverableId` 就追加到它（不存在则报错，跨会话也可以）；没给时，若某个成果最新版本的主文件路径与本次 `paths[0]` 相同、**且该版本由同一会话交付**（步骤 3 补充），则追加为它的新版本；否则新建成果。成员（子会话）交付时，`PresentInput.member` 把成员 id 与成员名写进版本元数据。

## 步骤 3 工具

协作与 PTC 工具的名字、参数 schema、`effects` 与 `approval` 冻结在 `step3-tools.ts`；`web_fetch`、`read_spreadsheet`、`write_spreadsheet` 只冻结名字、`effects` 与 `approval`（`STEP3_MIGRATED_TOOLS`），参数归实现包。描述文字由实现包写。启动成员的工具只声明 `['read']`：成员自己的每次工具调用按成员的沙箱与审批规则逐一检查。

| 工具 | 实现包 | 参数 | effects / approval | 行为要点 |
| --- | --- | --- | --- | --- |
| `delegate` | subagent | `name`、`task`、`mode?: fresh \| fork`、`preset?`、`persona?`、`materialIds?`、`files?`、`expectedOutput?`、`continue?`、`maxRequests?` | `['read']` / `never` | 建子会话（`executionForm: delegated`；给了 `continue` 时改为续聊本会话的那个委派或工作流成员，不能与 fork 同用；`maxRequests` 是这次运行的请求次数上限，用完结果为 `budget`），把 `task`、要读的文件与期望产出拼成成员首轮的用户消息，`materialIds` 作为该轮的资料；前台等成员这一轮结束；写 `subagent.start` / `subagent.end`；工具结果是 `MemberResult` 的文本形式（状态、最后回复、成果 id / 版本 / 文件、费用） |
| `spawn_teammate` | team | `name`、`task`、`preset?`、`persona?`、`materialIds?`、`files?` | `['read']` / `never` | 建队友子会话（`team`），写 `team.member` 与 `subagent.start`，队友开始运行；不等待 |
| `send_message` | team | `to`、`text` | `['read']` / `never` | 写 `team.message { state: queued }`；收件人正在运行时，在它下一次模型请求前经 `beforeRequest` 注入并写 `delivered`；收件人空闲时唤醒它跑一轮（新的一对 `subagent.start` / `end`），邮件在那一轮开始时注入；Lead 发的邮件立即唤醒，队友之间的邮件在 Lead 下一次调用团队工具或 `wait_teammates` 时唤醒。一个队友在一个 Lead 轮次里至多运行 8 次（`MAX_RUNS_PER_LEAD_TURN`，团队包内常量），更多的邮件留到下一轮。发给 `lead` 的邮件由 `wait_teammates` 交给 Lead，或在 Lead 下一轮开始时注入 |
| `wait_teammates` | team | `names?`、`until?: mail-or-idle \| idle` | `['read']` / `never` | 等指定（默认全部活跃）队友本轮停下；默认（`mail-or-idle`）有发给 `lead` 的邮件时提前返回，仍在工作的队友标为还在工作；返回各自的 `MemberResult` 与发给 `lead` 的邮件 |
| `wait_for_message` | team（只给队友） | `teammates?`、`timeoutSeconds?`（1–600，默认 120） | `['read']` / `never` | 不发模型请求地等待：有给自己的邮件（下一步前注入）、所列队友之一当前没有运行、或超时，三者先到者返回（重做 K4，审查 D7） |
| `team_task_create` / `team_task_list` / `team_task_update` | team | 见契约 | `['read']` / `never` | 任务板；依赖未完成的任务不能开始 |
| `workflow` | workflow | `script` 与 `graph` 恰给一个；`title?`、`args?` | `['read']` / `never` | 写 `workflow.start` / `phase` / `end`；每个 `agent()` 是一个 `workflow` 成员；图先保存到 `.nexgent/architectures/` 再编译执行 |
| `run_code` | ptc | `code`、`timeoutMs?`（1–300 s，默认 60 s） | `['read','write','execute']` / `never` | 独立 Node 进程、空环境变量；文件经宿主函数按调用方沙箱检查（`permissions.md` §代码执行进程） |

新方向第二步：`organize`（workflow 包，`ORGANIZE_TOOL`，`['read']` / `never`）按一个分工启动成员，规则见 `data-formats.md` §按任务组队；写 `organization`，再写这张图的 `workflow.*` 与成员的 `subagent.*`。

成员看不到 `delegate`、`spawn_teammate`、`wait_teammates`、`workflow`、`organize`、`send_message`、`wait_for_message`、`team_task_create`、`team_task_list`、`team_task_update`（`MEMBER_DENIED_TOOLS`，即除 `run_code` 外的全部协作工具）。队友另由团队包在自己的作用域注册 `send_message`、`team_task_list`、`team_task_update`、`wait_for_message`（`TEAMMATE_TOOLS`）；作用域的遮罩不隐藏同一作用域自己注册的工具，所以只有队友能看到这四个，委派对象与工作流节点看不到任何团队工具。

## 步骤 4 工具

名字、参数 schema、`effects` 与 `approval` 冻结在 `step4-tools.ts`（`STEP4_TOOLS`），描述文字由 `@nexgent/capabilities` 写。三个工具都只在根会话可见（`MEMBER_DENIED_TOOLS`）。

| 工具 | 参数 | effects / approval | 行为要点 |
| --- | --- | --- | --- |
| `capability_draft` | `kind`、`name`、`files?: { path, content }[]`、`remove?: string[]` | `['write']` / `never` | 宿主在 `.nexgent/capabilities/drafts/<sessionId>/<kind-dir>/<name>/` 写入或删除文件（路径相对组件目录，规则同清单 `path`）；改完后入口文件必须存在、单文件与组件上限不超（`CAPABILITY_LIMITS`）；写 `capability.draft`（`files` 为改后全部文件的哈希，`revision` 递增） |
| `capability_try` | `kind`、`name` | `['read']` / `never` | 校验草稿（清单与对应入口文件的 schema），只在本会话装载：技能进技能列表，函数模块的函数成为本会话工具 `cap_<module>_<fn>`，预设 / 团队模板 / 架构图供本会话的协作工具使用，上下文策略从下一次请求起生效；写 `capability.try`。试用 `plugin` 先问用户（`permissions.md` §插件安装审批） |
| `capability_propose` | `components: { kind, name }[]`（1–16）、`summary?`（≤500 字符） | `['read']` / `never` | 每个组件必须试用过，且试用之后至少有一次 `isError: false` 的使用（函数模块与插件为其工具调用，技能为 `load_skill`，协作组件为引用它的协作工具调用），否则报 `tool/failed` 说明哪个组件缺证据；接受后写 `candidates/<id>/`、`capability.propose`，任务结束后自动门控 |

## 重做 K3 工具（ADR 0022）

文件工具与命令工具由 `@nexgent/workspace` 实现，`exit_plan` 由 kernel 在计划模式的会话里注册到该会话自己的作用域；权限语义见 `permissions.md`。

| 工具 | 参数（新增部分） | effects / approval | 行为要点 |
| --- | --- | --- | --- |
| `bash` / `pwsh` | `run_in_background?: boolean`、`sandbox?: boolean` | `['execute', 'write', 'network']` / `never` | 在系统沙箱里运行（Linux / macOS，`workspace-write`、`read-only` 与计划模式）；`sandbox: false` 每次审批后在沙箱外重跑；后台运行立即返回编号；结果约 30 000 字符、保留头尾，完整输出在会话临时目录；`readOnlyCall` 判断只读命令，`read-only` 下照常执行 |
| `shell_output` | `id: string` | `['read']` / `never` | 读后台进程上次读取之后的输出，以及是否还在运行、退出码 |
| `shell_kill` | `id: string` | `['execute']` / `never` | 结束后台进程及其启动的一切 |
| `exit_plan` | `plan: string` | `['read']` / `always` | 只在计划模式下出现；审批详情是计划全文（`approvalText`）；批准后会话切到执行模式并写 `session.mode`，工具随之消失 |
| `search_text` | `outputMode?: "content" \| "files_with_matches" \| "count"`、`before?`、`after?`、`context?`、`multiline?`、`literal?`、`ignoreCase?`、`limit?`（`maxResults` 为别名）、`offset?`、`includeIgnored?`、`glob?` | `['read']` / `never` | 按 ripgrep 语义：读 `.gitignore`，大文件流式搜索，敏感文件列在结果末尾而不静默跳过；项目外目录先问一次 |
| `list_files` | `limit?`（`maxResults` 为别名）、`offset?`、`includeIgnored?` | `['read']` / `never` | 读 `.gitignore`；敏感文件标出；项目外目录先问一次 |

## 步骤 5 工具（改进会话）

名字、参数 schema、`effects` 与 `approval` 冻结在 `improvement.ts`（`IMPROVEMENT_DIAGNOSIS_TOOLS`），描述文字由 `@nexgent/evolve` 写。四个工具只注册在改进作业的诊断会话（`session.start.purpose: improvement`、`improvement.phase: diagnose`）的作用域里，那个会话也只有这四个工具；用户任务、提议会话与成员都看不到（`MEMBER_DENIED_TOOLS`）。

| 工具 | 参数 | effects / approval | 行为要点 |
| --- | --- | --- | --- |
| `improve_read_session` | `sessionId`、`fromTurn?`、`toTurn?`、`types?: string[]`、`maxBytes?`（≤262144） | `['read']` / `never` | 返回该会话按轮与记录类型筛过的记录（带 `seq`，诊断的证据引用它），超出 `maxBytes`（默认 65536）截断并标明 |
| `improve_read_ledger` | `taskId?`、`sessionId?`、`memberId?`、`capabilityVersion?`、`types?`、`maxBytes?` | `['read']` / `never` | 返回项目账本按归属字段筛过的记录，上限同上 |
| `improve_list_feedback` | `sessionId?`、`deliverableId?` | `['read']` / `never` | 列出反馈（同 SDK `feedback.list`），带是否计入 |
| `improve_report_diagnosis` | `failureTypes`、`involved`、`hypothesis`、`proposalKind`（`DiagnosisReport`） | `['read']` / `never` | 宿主按 schema 校验并核对每条证据的会话与 `seq` 存在；不通过时工具结果说明要改什么（`isError: true`），共最多 3 次；通过后写 `diagnosis.json`（宿主补 `memberCosts`），本轮结束 |

提议会话用普通任务工具加 `STEP4_TOOLS`，在反馈任务快照的副本里运行（`permissions.md` §改进会话与改进预算）；`capability_propose` 写出的候选带 `origin: improvement` 与 `jobId`，规则同步骤 4。

## 步骤 3 系统提示增量

由「kernel 维护」落进 `system-prompt.ts`；措辞以代码为准，必须表达的内容：

1. **形态选择原则**（只在 `delegate`、`spawn_teammate` 或 `workflow` 之一可见时出现，节名 `# Working with others`）：默认自己直接做；子任务能独立完成、有可检查的产出时再委派（fresh 写清目标、输入、产出与位置；需要当前对话上下文时用 fork，fork 看得到本轮到目前为止的内容）；多个子任务可以并行且需要互相沟通时组队；步骤固定、可批量时用工作流；成员共用项目目录，写明每个成员可以改哪些文件，同时运行的两个成员不给同一个文件（重做 K4：不再要求写到各自的子目录；装了 `ctx.workdirs` 时改为：可写的成员各在自己的项目副本里工作，轮末合回，两边都改过的文件作为冲突交给主对话处理，仍要给每个成员分好各自的部分），最终由自己读成员成果并用 `present` 交付。不写固定角色与阶段。
2. **成员标识**（只在子会话出现）：系统提示的人设段之后单独一行，正文为 `renderMemberPromptLine(member)`，即 `Member: <name> (<executionForm>)`，逐字节固定（脚本化测试按它把请求路由到成员；fork 子会话首轮的用户消息与父会话相同，只能靠这一行区分）。随后一句说明：你是一个更大任务里的成员，只做交给你的部分，完成后用 `present` 交付文件并简要回复结果。
3. 成员的人设段来自预设的 `persona`（没有则用默认人设）；父会话的系统提示不整体给成员。根会话没有成员标识行。

## 技能

- 发现：内置目录（`@nexgent/skill` 包内）、用户目录 `~/.nexgent/skills/<name>/SKILL.md`（步骤 3；`NEXGENT_HOME` 可改 `~/.nexgent`，契约 `USER_SKILLS_DIR`、`SkillSource: 'user'`）与项目 `.nexgent/skills/<name>/SKILL.md`。`SKILL.md` 以 YAML front matter 开头，字段 `name`（`^[a-z0-9][a-z0-9-]{0,63}$`）、`description`（必填，一行）、`when_to_use`（可选）、`tools`（可选，字符串数组）。
- 同名时项目技能覆盖用户技能，用户技能覆盖内置技能；front matter 错误的文件进 `SkillCatalog.problems`，不影响其他技能。
- 技能清单在每轮开始由技能提供者生成；轮中新增的技能下一轮可见。
- 内置的 Office 读取技能说明何时用 `read_document`、各格式的限制；它只读，不执行宏。

## 压缩

- 触发（`@nexgent/context` 的实现约定，不是 loop 的规则）：下一次请求的估计输入达到阈值。估计 = 最近一次请求的计费输入 + 它的输出 + 之后新加消息的估计（约 3 字符一个 token）；用量未知时（恢复后、压缩后）按整段历史估计（ADR 0021；此前只看计费输入，未知时不触发）。阈值在 `@nexgent/context` 的 profile 行配置 `compaction.thresholdTokens`（默认 160 000），可由环境变量 `NEXGENT_COMPACTION_THRESHOLD` 覆盖（验收脚本与真实模型补验用它把阈值调低），并且不超过模型上下文窗口的 75%；`compaction.keepRecentTurns`（默认 2）决定保留几轮完整轮次。
- 保留段从某个 `user` 消息开始（轮或注入的边界）；保留段估计仍超过阈值的 30% 时，当前轮也被切开，保留段从这一轮的某条回复开始（至少保留最后一步及其工具结果），这一轮的请求原文附在摘要末尾。保留段从不以工具结果开始，因此工具调用与结果不会被拆开。保留的回复只回放文字与工具调用，不回放 thinking 块（`compactionTail`）。
- 摘要请求：`purpose: 'auxiliary'`，模型与 thinking 沿用项目配置，不带工具，输出上限 32 000；请求内容是被压缩的消息转写（总长不超过 40 万字符，超过时先收紧单条上限、再截中间）加一段固定的摘要指令（由 W1 写进包内并有快照测试）。
- 记录与恢复规则见 `data-formats.md` §压缩。

## 宿主接口（W7 实现，W4 调用）

kernel 的 `Agent` 在步骤 2 增加（形状由 W7 定，语义在此固定）：

- 轮次输入带 `source: 'user' | 'feedback'`、`materialIds?`，反馈轮另带 `FeedbackEntry`（`feedback` 记录在 `turn.start` 之后、注入之前写出；用户消息文本为 `renderFeedbackPrompt(entry)`）；
- 一个写宿主记录的方法，类型为 `HostRecordSink`，只接受 `HostRecordInput`；轮次进行中调用时记录带当前 `turn`；
- `KernelToolContext.appendRecord` 只接受 `ToolRecordInput`，并校验 `turn`、`step`、`toolCallId` 与当前调用一致。

线路层（`@nexgent/llm`）：注入消息与用户消息、摘要与其后的用户消息会形成相邻的 `user` 消息；`toWireMessages` 应把相邻的 `user` 消息合并为一个 `user` 轮（文本块依次排列），而不是依赖 API 自动合并。这一条由 W7 实现并加测试。

步骤 3 增加（「kernel 维护」实现，形状在契约固定）：

- `ctx.agents.create({ child: ChildAgentOptions })` 建子会话：父会话必须是本进程里打开的根会话；沙箱用 `childSandboxMode` 收窄；`mode: 'fork'` 时在 `session.start` 之后写 `fork.seed`；成员作用域上 `restrict()` 预设的 `tools` 与 `MEMBER_DENIED_TOOLS`；系统提示加成员标识行。`ctx.agents.resume(id, { child: ResumeChildOptions, preset? })` 在父会话仍打开时重开成员（队友的后续轮次）；会话头只存预设名，调用方再传一次 `preset`，成员才得到同样的人设、工具范围、effort、thinking 与 `maxSteps`，沙箱重新与父会话比较。
- 错误：父会话不在本进程打开报 `session/not-found`；父会话本身是成员（深度 1）或一棵任务树超过 16 个成员报 `tool/denied`；不带 `child` 恢复成员会话、或 `child.parentSessionId` 不是它的父会话报 `tool/denied`；对根会话传 `child` 报 `tool/denied`。
- 每个会话的 `AgentAttribution`（`taskId`、`memberId`、`executionForm`）写进它的每条账本记录，并经 `ToolContext.attribution` / `member` 交给工具；协作工具用 `ctx.agents.get(context.sessionId)` 找到父 Agent。
- 父会话的轮次取消或结束时以 `parent` 取消仍在运行的成员；成员的审批请求带 `ApprovalRequest.member`。
- `KernelToolContext.appendRecord` 与宿主写记录的方法按步骤 3 的 `ToolRecordType` / `HostRecordType` 放宽，只接受契约白名单里的类型。轮次之间写的 `subagent.end` / `workflow.end`（例如成员在父会话轮次结束的宽限期之后才收尾）带它所属的那一轮的 `turn`，可能小于父会话当前的轮号。
- `project` 范围的审批授权由整棵任务树共享：用户在成员的提示里选 `project`，主对话与其他成员此后也按它放行；`session` 范围只属于提出请求的那个会话。
- `Agent.beforeRequest(injector: StepInjector): () => void` 登记逐请求注入器，返回值用来注销。`StepInjector` 收到 `StepInjectionInput { sessionId, turn, step, signal }`（`step` 从 1 起，是紧接着要发的那次请求），返回字符串数组（可为 Promise）；每段写一条 `user.message { source: 'inject' }`。调用时机与出错规则见 §轮次流程第 6.3 步。注入器不跨进程，宿主在恢复会话后要重新登记。
- `Agent.steer(text: string): boolean`（新方向第一步）：轮次进行中用户发来的消息。还在接收时排队并返回 `true`，时机见 §轮次流程第 6.3a 步；同时转给此刻正在运行的成员（递归），成员收到的是 `relayedUserNote(text)`，写成 `user.message { source: 'inject' }`。没有轮次在跑、或轮次已在收尾时返回 `false`，调用方另起一轮。SDK 的 `turns.send` 在会话有轮次运行时先调用它，成功时返回 `{ sessionId, turn, steered: true }`（`turn` 是正在运行的那一轮）；返回 `false` 时等那一轮结束再开新的一轮。
- `Agent.holdTurn(work: Promise<unknown>)` 让正在运行的轮次等 `work` 落定再结束，协作包借此把成员运行的 `subagent.end` 写在它所属的轮次里。轮次的循环结束后，agent 以 `parent` 取消仍在运行的成员，并最多等 `toolAbortGraceMs` 再写 `turn.end`。没有运行中的轮次时调用报 `internal`。
- `ToolRegistryService.inherit(parent: ToolScope): () => void`：成员作用域此后服从 `parent` 作用域现在与以后的全部 `restrict()`，所以成员在继承来的工具里最多看到父会话看得到的；各作用域自己注册的工具仍然私有。只能在有作用域的（agent）上下文调用，不能继承自己，否则报 `config/invalid`。
- `JsonlLedger.setStamp(stamp | undefined)`（`@nexgent/session`）：设置或清除写入前加上的归属戳，让 agent 循环以外的写入方（SDK 写的 `task.outcome`、压缩器的辅助请求）也带上该会话打开的 agent 的 `taskId`、`memberId`、`executionForm`。

步骤 4 增加（实现归步骤 4 分工表里对应的工作包，形状在契约固定）：

- 会话打开时读采用历史链尾，经 `SessionInit.capabilityVersion` 写进 `session.start`；kernel 给该会话的每条账本记录加 `capabilityVersion`（与 `AgentAttribution` 一起，`JsonlLedger.setStamp` 同样带上）。恢复时版本不可用写 `capability.version`（宿主记录）。
- `ToolRecordType` 增加 `capability.draft` / `try` / `propose`，`HostRecordType` 增加 `capability.version`；kernel 的运行时白名单（`agent.ts` 的 `TOOL_RECORD_TYPES` / `HOST_RECORD_TYPES`）随之放宽。
- `Workspace.ensureLayout` 创建 `.nexgent/snapshots/`；路径策略把 `.nexgent/snapshots/` 加入读写都拒绝的子目录。
- 新方向第三步：`TurnOrganizer.noteTurnEnd?`：组织者决定过的根轮在 `turn.end` 之后收到 `{ sessionId, turn, reason, checks?, use, organization?, usd, projectRoot, tools, changes, presented }`（失败忽略；`tools` 是根会话这一轮调用过的工具，`changes` 是 `turn.files` 的改动（至多 200），`presented` 是这一轮交付的文件）；`decide` 的输入多了反馈轮的 `rating?`。`ctx.organizations`（`OrganizationMemory`，capabilities 包提供，可选）：`suggest`、`record`、`noteRework`、`noteReverts`、`summary`，见 `data-formats.md` §组织库；workflow 包的组织者有它时按它决定并记录。
- 新方向第二步：`ctx.organizer`（`TurnOrganizer`，workflow 包提供，可选）：`decide({ sessionId, turn, text, source, materialIds })` 返回 `{ decision, section }` 或 `undefined`。只在根会话、非改进会话调用。本轮已运行过分工、检查失败要重试时，重试提示末尾加 `REORGANIZE_AFTER_CHECKS_NOTE`（分工有问题就带原因再调 `organize`，否则自己修）。根会话关闭时 `task.outcome.organization` 取 `Agent.organizationUse()`。
- 重做 K4（审查 D4）：`ctx.workdirs`（`MemberWorkdirs`，tasking 提供，可选）。kernel 建或恢复可写成员时调用 `open`，拿到副本就把成员的 `ToolContext.workspace` 换成以副本为根的视图（数据目录不变），成员每轮开始调 `refresh`，轮末在根轮快照完成后调 `merge`，结果放进 `TurnResult.merge`，成员关闭时调 `close`。没有副本的成员可能改项目的工具调用也先等根轮快照（`TaskTree.snapshot`）。
- 根任务开始时拍快照、结束时写检查记录与 `task.outcome.checks` / `componentsUsed` / `memberCosts`（`data-formats.md` §任务快照与检查）。K1 起：快照只在项目开启学习（`learning.enabled`）时拍；它在第一次请求的回复开始到达时开始、在后台进行；可能改项目的工具调用（效果不只是 `read` / `network`）与轮末先等它完成，只读工具不等，所以一轮的开始不再等待扫描项目；检查只记录，不重跑命令（见下）。

步骤 5 增加（实现归步骤 5 分工表里对应的工作包，形状在契约固定）：

- `SessionInit.purpose` / `improvement` 写进 `session.start`（只给其一时 `create` 报 `session/invalid-record`）；改进会话的每条账本记录带 `improvementId` 与 `improvementPhase`（`LedgerAttribution`，`JsonlLedger.setStamp` 同样带上）；该作业的门控试验记录带 `improvementPhase: trial`。
- 快照与检查按根轮记（`perTurnFileName`，`data-formats.md` §任务快照与检查“按轮记”），根轮结束时检查有失败项即向改进队列计一个 `check-failure` 信号（失败的测试命令也成为检查，ADR 0006 决策 10；kernel 把项目根目录里有退出码的 `bash` / `pwsh` 命令连同 `exitCode` 交给记录器，由记录器判定哪些是测试命令；K1 起检查结果就是模型那次运行的退出码，轮末不再重跑）（只在 `autoImprove` 为真时自动开始作业）。
- 路径策略把 `.nexgent/improvements/` 加入读写都拒绝的子目录（`@nexgent/workspace` `DENIED_PATTERNS`）。

## 测试

| 挂点 | 用例（所属包） |
| --- | --- |
| 未装载步骤 2 服务 | 步骤 1 的全部测试与 `accept-step1` 不改脚本通过（kernel） |
| 上下文注入 | 两个提供者各给一节系统提示与一段注入：系统提示顺序正确；注入记录在用户消息之前；同一轮两次请求的系统提示逐字节相同；提供者抛错时有 `error` 记录且轮次完成（kernel） |
| 压缩 | 脚本化 provider 报告超过阈值的输入后，下一次请求只含摘要与保留段；`compact` 失败时历史不变、同一轮不再尝试、账本有辅助请求记录；压缩后强杀再恢复，重建的历史与强杀前一致（context + kernel） |
| 文件变更 | 文件工具与 `bash` / `pwsh` 各改一个文件，`turn.files` 与实际一致；`.nexgent/`、`node_modules/` 被忽略；取消的轮也有 `turn.files`（tasking + kernel） |
| `present` | 不存在、项目外、`.nexgent/` 内的路径各被拒；`deliverable.presented` 在 `tool.result` 之前；v2 不改 v1 快照（tasking） |
| `todo_write` | 结果文本与 `meta.todos` 一致；非法状态、超过上限返回工具错误（tasking） |
| 宿主记录 | 轮外写 `goal.set`、轮中写 `material.added` 都能恢复；非宿主类型被拒（kernel） |
