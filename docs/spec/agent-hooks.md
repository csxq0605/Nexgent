# agent loop 挂点、步骤 2 工具与系统提示增量

> 步骤 2 第 1 轮由 W0（「步骤二契约」）冻结。类型镜像：`packages/kernel/src/contracts/context.ts`、`tasking.ts`、`skill.ts`、`step2-tools.ts`（工具名与参数），以及 `session.ts` 的步骤 2 记录与 `tools.ts` 的 `ToolContext.appendRecord`。挂点的实现归「kernel 维护」（W7）；提供者与工具的实现归 W1（`@nexgent/context`）、W2（`@nexgent/tasking`）、W3（`@nexgent/skill`）。冻结后的修改走契约修改 PR，并在 PR 描述里点名受影响的包。记录格式以 `data-formats.md` 为准，权限以 `permissions.md` 为准。

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

1. 写 `turn.start`。
2. \* 反馈轮：写 `feedback`（SDK 的 `feedback.submit` 发起；普通轮没有这一步）。
3. \* `ctx.tasking.files.beginTurn(sessionId, turn)`：记录工作区的“轮前”状态。
4. \* 依次调用每个 `ContextProvider.beginTurn(input)`，收集 `ContextContribution`：
   - `systemSections` 在本轮的每次请求里渲染进系统提示（见“系统提示的组装”），**不写会话**；
   - `inject` 的每一段写一条 `user.message { source: 'inject' }`，按提供者顺序，在用户消息**之前**。
5. 写用户消息 `user.message { source: 'user' | 'feedback', materials? }`。`materials` 是本条消息引用的资料 ID（`SendMessageInput.materialIds`），资料引用的正文由 `materials` 提供者在第 4 步作为 `inject` 写出。
6. 步骤循环，每一步：
   1. 取消检查、费用上限检查（步骤 1 不变）；
   2. \* 压缩检查：有 `compactor` 且本轮还没有失败过压缩时调用 `shouldCompact(input)`；为真则 `compact(input, signal)`，成功后写 `compaction` 并按投影规则替换内存中的历史；
   3. 模型请求，写 `assistant.message`（步骤 1 不变）；
   4. 执行工具：每个调用写（`approval.*`）→ \*（工具通过 `appendRecord` 追加的记录，如 `deliverable.presented`）→ `tool.result`；\* 每个 `tool.result` 之后调用 `files.observe(...)`。
7. \* `ctx.tasking.files.endTurn(sessionId, turn, signal)`，写 `turn.files`（列表为空也写）。
8. 写 `turn.end`；按步骤 1 规则写 `checkpoint`。

完整的一轮记录顺序因此是：

```text
turn.start → [feedback] → user.message(inject)* → user.message(user|feedback)
  → ( [compaction] → assistant.message → ( [approval.*] → [deliverable.presented] → tool.result )* )*
  → turn.files → turn.end → [checkpoint]
```

轮次之外，宿主（SDK）经持锁的 agent 追加 `material.added`、`goal.set`、`goal.update`（契约 `HostRecordType`）；它们可以出现在两轮之间，也可以出现在一轮之中（此时带 `turn`）。只读的调用方不能写记录。

## 失败语义

| 挂点 | 失败时 |
| --- | --- |
| `ContextProvider.beginTurn` 抛错 | 跳过这个提供者，写一条 `error`（`fatal: false`，`code` 取错误自身的，非 Nexgent 错误为 `internal`），本轮照常进行 |
| `Compactor.compact` 抛错或被中止 | 写 `error`（`fatal: false`）；保留未压缩的历史；本轮不再尝试压缩（`CompactionCheckInput.failedThisTurn` 为真）；摘要请求本身照常在账本里有 `llm.request.start/end`（`purpose: 'auxiliary'`） |
| 压缩结果不合法（`keepMessages` 越界、保留段不以 `user` 开头） | 等同 `compact` 失败；`SessionStore.append` 在写入前用投影检查它，不会落盘 |
| `TurnFileTracker.observe` 抛错 | 吞掉，不影响工具结果 |
| `TurnFileTracker.endTurn` 抛错 | 写 `error`（`fatal: false`），不写 `turn.files`，照常写 `turn.end` |
| 工具的 `appendRecord` 失败 | 该工具调用以错误结束（`tool/failed`），模型拿到错误；已写入的快照文件留在 `outputs/`，但没有会话记录指向它（列成果时按 `deliverable.json` 列出，见 `data-formats.md` §成果元数据） |
| 进程在轮中死亡 | 没有 `turn.files`；恢复时按步骤 1 规则补 `turn.end { kind: 'interrupted' }` |

取消（用户、超时、关闭、费用上限）时第 7 步照常执行，`endTurn` 的 `signal` 给 5 秒上限；上限到了就报告已比较到的部分。

## 系统提示的组装

每次请求的系统提示按以下顺序拼接，节之间空一行；同一轮内各次请求的系统提示逐字节相同（缓存前缀稳定）：

1. 步骤 1 的人格段与 `# Environment`（`renderSystemPrompt`，不变）；
2. 步骤 1 的 `# Tools` 列表（不变）；
3. \* `# Working with files`（见下节，已由 PR #8 落进 `system-prompt.ts`）；
4. \* 本轮各提供者的 `systemSections`，每节渲染为 `# <title>` + 换行 + `body`，按提供者顺序、同一提供者内按 `id` 排序；
5. 步骤 1 的结尾行（`suffix`）。

提供者的建议内容（由各包实现，不是契约）：说明文件提供者输出 `# Project instructions`（项目根 `AGENTS.md`，没有则 `NEXGENT.md`，大小上限与截断规则写在 `@nexgent/context` 的 README）；目标提供者在有 `active` 目标时输出 `# Current goal`；技能提供者在有技能时输出 `# Skills`（名称、一行描述、触发说明，并说明用 `load_skill` 读全文）。

## 系统提示增量

`# Working with files` 一节由 `packages/kernel/src/system-prompt.ts` 的 `fileGuidance` 生成（PR #8，W7），每一条只在对应工具可见时出现，所以提示里不会出现模型调不了的工具。必须表达的内容（措辞以代码为准，改动需同时更新本节）：

1. 修改已有文件用 `str_replace`（有 `read_file` 时先读）；有 shell 工具时不要用 shell 命令（heredoc、sed、内联脚本）改文件。——已实现。
2. 新建或整体替换文件用 `write_file`。——已实现。
3. 结果就绪时用 `present` 声明交付，每次修订后再次声明；再次声明时带上 `present` 返回的 `deliverableId`，使之成为同一成果的新版本。——已实现。
4. `.nexgent/materials/` 下的资料只读，结果写进项目。只在项目有资料（`ctx.tasking.materials.list()` 非空，轮次开始时检查）时出现。——已实现。

前三条对应真实模型补验的 R02（修改轮里对已有文件的修改走 `str_replace`）与链路里的 present / v2。

## 步骤 2 工具

名字、参数 schema、`effects` 与 `approval` 冻结在 `step2-tools.ts`；描述文字由实现包写，可以改。

| 工具 | 实现包 | 参数 | effects / approval | 行为要点 |
| --- | --- | --- | --- | --- |
| `present` | tasking | `paths: string[]`（1–50，第一项是主文件）、`summary: string`、`title?`、`deliverableId?` | `['read']` / `never` | 校验每个路径在项目内、存在、是文件、不在 `.nexgent/` 下；生成新版本快照；经 `ToolContext.appendRecord` 写 `deliverable.presented`；工具结果文本给出 `deliverableId` 与版本号；`read-only` 模式下也可用（快照由宿主写） |
| `load_skill` | skill | `name: string` | `['read']` / `never` | 返回技能正文；未知名字返回工具错误 `tool/not-found` |
| `read_document` | skill | `path: string`、`sheet?`、`maxRows?`（默认 500）、`pages?` | `['read']` / `never` | `.docx` 转文本，`.xlsx` 转表格（逐 sheet，CSV 式文本），`.pdf` 转文本；损坏文件返回工具错误而不是崩溃；路径按读策略检查（`materials/` 可读）；不写任何文件 |

`present` 的路径匹配规则（同一成果的后续版本）：给了 `deliverableId` 就追加到它（不存在则报错）；没给时，若某个成果最新版本的主文件路径与本次 `paths[0]` 相同，则追加为它的新版本；否则新建成果。

## 技能

- 发现：内置目录（`@nexgent/skill` 包内）与项目 `.nexgent/skills/<name>/SKILL.md`。`SKILL.md` 以 YAML front matter 开头，字段 `name`（`^[a-z0-9][a-z0-9-]{0,63}$`）、`description`（必填，一行）、`when_to_use`（可选）、`tools`（可选，字符串数组）。
- 同名时项目技能覆盖内置技能；front matter 错误的文件进 `SkillCatalog.problems`，不影响其他技能。
- 技能清单在每轮开始由技能提供者生成；轮中新增的技能下一轮可见。
- 内置的 Office 读取技能说明何时用 `read_document`、各格式的限制；它只读，不执行宏。

## 压缩

- 触发（`@nexgent/context` 的实现约定，不是 loop 的规则）：本会话最近一次请求的计费输入（`billedInputTokens(lastUsage)`，任一部分为 `unknown` 时不触发）达到阈值。阈值在 `@nexgent/context` 的 profile 行配置 `compaction.thresholdTokens`（默认 160 000），可由环境变量 `NEXGENT_COMPACTION_THRESHOLD` 覆盖（验收脚本与真实模型补验用它把阈值调低）；`compaction.keepRecentTurns`（默认 2）决定保留几轮完整轮次。不新增 `config.json` 字段。
- 保留段从某个 `user` 消息开始（轮或注入的边界），因此工具调用与结果不会被拆开；当前轮总是完整保留。
- 摘要请求：`purpose: 'auxiliary'`，模型与 thinking 沿用项目配置，不带工具；请求内容是被压缩的消息加一段固定的摘要指令（由 W1 写进包内并有快照测试）。
- 记录与恢复规则见 `data-formats.md` §压缩。

## 宿主接口（W7 实现，W4 调用）

kernel 的 `Agent` 在步骤 2 增加（形状由 W7 定，语义在此固定）：

- 轮次输入带 `source: 'user' | 'feedback'`、`materialIds?`，反馈轮另带 `FeedbackEntry`（`feedback` 记录在 `turn.start` 之后、注入之前写出；用户消息文本为 `renderFeedbackPrompt(entry)`）；
- 一个写宿主记录的方法，类型为 `HostRecordSink`，只接受 `HostRecordInput`；轮次进行中调用时记录带当前 `turn`；
- `KernelToolContext.appendRecord` 只接受 `ToolRecordInput`，并校验 `turn`、`step`、`toolCallId` 与当前调用一致。

线路层（`@nexgent/llm`）：注入消息与用户消息、摘要与其后的用户消息会形成相邻的 `user` 消息；`toWireMessages` 应把相邻的 `user` 消息合并为一个 `user` 轮（文本块依次排列），而不是依赖 API 自动合并。这一条由 W7 实现并加测试。

## 测试

| 挂点 | 用例（所属包） |
| --- | --- |
| 未装载步骤 2 服务 | 步骤 1 的全部测试与 `accept-step1` 不改脚本通过（kernel） |
| 上下文注入 | 两个提供者各给一节系统提示与一段注入：系统提示顺序正确；注入记录在用户消息之前；同一轮两次请求的系统提示逐字节相同；提供者抛错时有 `error` 记录且轮次完成（kernel） |
| 压缩 | 脚本化 provider 报告超过阈值的输入后，下一次请求只含摘要与保留段；`compact` 失败时历史不变、同一轮不再尝试、账本有辅助请求记录；压缩后强杀再恢复，重建的历史与强杀前一致（context + kernel） |
| 文件变更 | 文件工具与 `bash` / `pwsh` 各改一个文件，`turn.files` 与实际一致；`.nexgent/`、`node_modules/` 被忽略；取消的轮也有 `turn.files`（tasking + kernel） |
| `present` | 不存在、项目外、`.nexgent/` 内的路径各被拒；`deliverable.presented` 在 `tool.result` 之前；v2 不改 v1 快照（tasking） |
| 宿主记录 | 轮外写 `goal.set`、轮中写 `material.added` 都能恢复；非宿主类型被拒（kernel） |
