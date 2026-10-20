# @nexgent/workflow

工作流：`workflow` 工具在前台编排多个成员（子会话，`executionForm: workflow`），等全部结束后把每个成员的状态、回复、成果与脚本的返回值交回父会话。编排写成脚本（`agent()`、`parallel()`、`pipeline()`、`phase()`、`log()`、`args`）或声明式图；脚本跑在 `@nexgent/ptc` 的隔离进程里，并发与成员数上限由宿主执行。名字与 schema 冻结在契约 `WORKFLOW_TOOL`（`packages/kernel/src/contracts/step3-tools.ts`）；记录格式见 `docs/spec/data-formats.md` §工作流、§子会话与成员。

运行时依赖：Node 内置模块、`@nexgent/kernel`、`@nexgent/preset`、`@nexgent/ptc`、`@nexgent/subagent`。`src/architecture.ts` 与 `src/architecture-store.ts` 改写自 DSH `packages/workflow/tool-workflow`（经 PR #4，`refactor/dsh-application` `fd0b2f42`），见头注与 `THIRD_PARTY_NOTICES.md`；其余只参考了设计。

## Public API

| Export | What it does |
| --- | --- |
| `WorkflowPlugin` / `apply` / `name` | 行名 `@nexgent/workflow`；有 `ctx.tools` 与 `ctx.agents` 时注册 `workflow`，成员经 `agentsMemberRunner` 跑 |
| `workflowTool({ runner, ptc?, maxConcurrentMembers?, maxMembers? })` | 工具本身 |
| `runWorkflow(options)`、`WORKFLOW_PRELUDE` | 运行一段工作流脚本，写 `workflow.*` 记录 |
| `agentsMemberRunner(agents)`、`WorkflowMemberRunner`、`renderWorkflowMemberPrompt`、`memberPreset` | 成员运行器：`@nexgent/subagent` 的 `runMember` |
| `normalizeArchitecture`、`compileArchitecture`、`prepareArchitecture`、`architectureVersion` | 图的检查、编译为脚本、内容版本（sha256） |
| `saveArchitecture`、`loadArchitecture` | 按版本存取图（`.nexgent/architectures/<version>.json`） |
| `recoverWorkflows(parent, store)`、`planWorkflowRecovery` | 根会话恢复后、第一轮之前调用 |
| `defaultOrganizer`、`organizeTool`、`turnProfile` | 组织者：决定这一轮自己做还是组队，`organize` 工具；轮末算组织画像交给组织库。总对话（`coordinator`）的分工说明是交给一个讨论串或拆给几个讨论串，记录带 `level: "coordinator"`；讨论串的轮照常决定、照常记成成员层的运行 |
| `buildOrganizationProfile`、`usageTokens`、`unionMs`、`USAGE_WEIGHTS` | 协调者：只从会话记录算出一轮里协调者和每个成员（讨论串也算一个部分）的花费份额、耗时、失败、重做、空等与白做（`docs/spec/data-formats.md` §协调者复盘） |
| `threadRunCount`、`openThreadRuns` | 协调者第二步：一轮起了几个讨论串运行、还有几个没结束；起过讨论串的轮记进组织库时带 `waiting` |

## 行为

- **参数。** `title`，`script` 与 `graph` 恰好给一个，可选 `args`（JSON，脚本里为 `args`）。成员调用 `workflow` 报 `tool/denied`（深度 1）。
- **`agent(prompt, opts)`。** `opts` 只接受 `name`、`preset`、`materialIds`、`files`、`tools`、`model`、`maxRequests`（重做 K4：该成员至多发几次模型请求）；同名自动加 `-2`、`-3` 后缀。返回 `{ name, status, text, deliverables, usage, … }`；成员没有完成时抛出可读错误（`member <name> <status>: <message>`），已完成成员的结果保留在工具结果里。
- **上限。** 同时运行的成员最多 4 个（多的排队，排队时间记为 `subagent.start.queuedMs`），一次工作流最多 16 个成员（第 17 个 `agent()` 报 `tool/denied`）；工作流整体超时 2 小时。`phase(name)` 写 `workflow.phase`（名字最长 200 字符），`log()` 进工具结果的日志段。
- **图。** 节点字段 `id`、`prompt`、`dependencies`、`preset`、`tools`、`model`，最多 16 个；环、未知依赖、重复 id、自依赖报 `tool/invalid-input`（`graph: …`）。每个节点在依赖完成后立即启动，提示附上依赖的回复与成果文件；任一节点失败，依赖它的节点不启动。图按内容版本存进 `.nexgent/architectures/`，结果里给出版本。
- **记录。** 父会话在本次工具调用里写 `workflow.start`、`workflow.phase`、各成员的 `subagent.start` / `subagent.end`（`executionForm: workflow`、`workflowId`）、`workflow.end`（`status`、`members`）。
- **结局。** 所有成员完成且脚本正常返回为 `completed`；任一成员未完成或脚本抛错为 `failed`；父会话取消时为 `cancelled`（正在运行的成员以 `parent` 原因结束）。
- **恢复。** 进程在工作流运行中死亡时，宿主恢复根会话后调用 `recoverWorkflows`：先由 `closeInterruptedRuns` 给未结束的成员补 `interrupted`，再给未结束的工作流补 `workflow.end interrupted`。已完成的成员不重跑。

## Model Experience

`workflow` 描述约 1 240 字符，说明脚本可用的函数、上限、父会话自己 `present` 最终成果，以及之后可用 `delegate` 的 `continue` 追问某个成员（重做 K4）。工具结果是每个成员一段（状态、成员 id、成果、最后回复，回复按 `memberReplyShare` 截取，与 `delegate` 同一口径）加日志与返回值，成员的中间步骤不进入父会话上下文。

## Known Limitations and Deferred Work

- 只有前台运行；后台工作流、续跑（重调时跳过已完成成员）不做。
- 任一成员未完成，整个工作流就是 `failed`，即使脚本捕获了错误。
- 插件要由宿主加载，`recoverWorkflows` 要由宿主在恢复时调用（W6 接入）。
- Windows 上图存储的硬链接发布与 PTC 进程未实测。
