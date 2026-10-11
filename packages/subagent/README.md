# @nexgent/subagent

委派：`delegate` 工具把一个子任务交给一个成员（同一进程里的子会话，`executionForm: delegated`），前台等它这一轮结束，把结果摘要、成果引用、用量与状态返回给父会话。另外提供成员运行器（团队、工作流复用）与恢复时补写未结束运行的函数。名字、参数 schema、`effects: ['read']`、`approval: 'never'` 冻结在契约 `DELEGATE_TOOL`（`packages/kernel/src/contracts/step3-tools.ts`）；记录格式见 `docs/spec/data-formats.md` §子会话与成员，继承规则见 `docs/spec/permissions.md` §子会话继承，决策见 ADR 0004。

归属：步骤 3 W2「委派」（`docs/plan/step-3-work-partition.md`）。运行时依赖：Node 内置模块、`@nexgent/kernel`、`@nexgent/preset`。DSH 的 `subagent-spawn-in-process`、`subagent-fork-in-process`、`subagent-in-process-driver`、`tool-subagent` 只参考了设计（前台一次性部分），没有复制代码。

## Public API

| Export | What it does |
| --- | --- |
| `SubagentPlugin` / `apply` / `name` | 行名 `@nexgent/subagent`；有 `ctx.tools` 与 `ctx.agents` 时注册 `delegate`（有 `ctx.tasking` 时先核对资料 id），卸载即注销 |
| `delegateTool({ agents, tasking? })` | 工具本身 |
| `runMember(options)` | 建成员 → 写 `subagent.start` → 跑一轮 → 写 `subagent.end` → 关闭成员；记录写到调用方给的 `record`（工具调用的 `appendRecord`，或 Lead 的 `appendHostRecord`） |
| `startMember(options)`、`runMemberTurn(member, input, { signal })`、`toMemberResult(turn, facts)` | 运行器的三段，给团队（同一成员多轮）和工作流（`agent()`）分开用 |
| `closeInterruptedRuns(parent, store)`、`openRuns(records)`、`interruptedResult(records, turn)` | 根会话恢复后、第一轮之前调用：给没有 `subagent.end` 的 `subagent.start` 补一条 `interrupted` |
| `normalizeMemberFiles(root, files, flavor?)`、`assertFilesExist`、`parseDelegateInput`、`renderDelegatePrompt`、`renderMemberResult` | 纯函数与检查 |

## 行为

- **参数。** `name`（成员名，`^[a-z][a-z0-9-]{0,31}$`）、`task`、`mode: fresh | fork`（默认 fresh）、`preset`（默认 `general-executor`）、`persona`（替换预设人设，不放宽工具与沙箱）、`materialIds`（去重）、`files`（要先读的项目路径）、`expectedOutput`。
- **启动前检查**，任何一项不过都不建成员、不写记录，工具结果为错误：成员调用 `delegate` 报 `tool/denied`（深度 1；成员本来也看不到这个工具）；参数不合法、预设不存在（列出可用的）、资料 id 不存在或已移除、文件在项目外或不存在报 `tool/invalid-input`；预设文件无效报 `config/invalid`；沙箱宽于父会话报 `sandbox/denied`、超过 16 个成员报 `tool/denied`（kernel 判定）。
- **文件路径。** 相对项目根或项目内的绝对路径都接受；Windows 上 `\` 与 `/` 都当分隔符，盘符不分大小写；统一成项目相对、`/` 分隔的形式写进成员首轮消息。
- **成员首轮消息** = 任务说明 + “先读这些项目文件”列表 + “期望产出” + 一句交回方式（用 `present` 交文件，最后一段回复写做了什么、产出在哪、还有什么没解决）。`materialIds` 作为这一轮的资料，由 `@nexgent/context` 的资料提供者注入引用。fresh 不带父会话历史；fork 由 kernel 写 `fork.seed`，带父会话到上一轮结束为止的历史。
- **记录。** 父会话在本次工具调用里写 `subagent.start`（`task` 截前 500 字符、`mode`、`preset`、`materialIds`）与 `subagent.end`（`result: MemberResult`），二者都在该调用的 `tool.result` 之前。成员关闭时写它自己的 `task.outcome`。
- **结局。** `completed`；`failed`（模型请求失败、轮次出错、超出输出上限，带原错误）；`cancelled`（父会话取消时成员以 `parent` 原因结束，`error.code: tool/aborted`、`details.cause`）；`budget`（任务树 `perTask` 或成员份额挡下成员的下一次请求，带 kernel 记下的 `budget/exhausted` 错误）；`interrupted`（只由恢复补写）。除 `completed` 外工具结果都标为错误，但内容照样是可读的结果文本。
- **工具结果文本**：一行状态与成员会话 id，一行请求数与 token 用量，可选的错误行，成果列表（标题、成果 id、版本、文件路径、摘要），最后是成员的最后一段回复。`meta` 带 `{ childSessionId, childTurn, name, result }`。父会话要自己读成员写的文件，再用自己的 `present` 交最终成果。
- **恢复。** 进程在成员运行中死亡时，成员会话由 kernel 补 `turn.end interrupted`；父会话恢复后由宿主（SDK）调用 `closeInterruptedRuns`，从成员会话里取那一轮最后的回复、已交的成果与用量，写 `status: interrupted` 的 `subagent.end`（带原来的轮号）。已有 `subagent.end` 的运行不重跑。

## Model Experience

`delegate` 的描述约 900 字符，列出三份内置预设；成员的系统提示由 kernel 组装（预设人设 + 成员标识行），不含父会话的系统提示。fork 会把父会话的历史整段复制进成员的首个请求，token 与父会话相当；fresh 只有任务说明与资料引用。工具结果是一段短文本，成员的中间步骤不进入父会话上下文。

## Known Limitations and Deferred Work

- 只有前台一次性委派；后台运行、可续聊的委派按计划不做。
- 同一轮里的多个 `delegate` 调用由 kernel 顺序执行；并行成员走工作流的 `parallel()` 或团队。
- `closeInterruptedRuns` 需要宿主在恢复根会话后调用；SDK 接入（W6）时接上。插件目前也要由宿主的注册表加载（SDK 与 CLI 的 profile 接入归 W6）。
- 结果只报请求数与 token，不折算成美元。
