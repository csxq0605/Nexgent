# @nexgent/team

团队：Lead（主对话）在自己的轮次里组建具名队友（同一进程里的子会话，`executionForm: team`），队友并行工作，通过持久邮箱互相发消息，共用一块带依赖的任务板。全部团队状态以 `team.*` 记录写在 Lead 会话里，强杀后从记录重建。工具名、参数 schema、`effects: ['read']`、`approval: 'never'` 冻结在契约（`packages/kernel/src/contracts/step3-tools.ts` 的 `SPAWN_TEAMMATE_TOOL` 等）；记录格式见 `docs/spec/data-formats.md` §团队，继承规则见 `docs/spec/permissions.md` §子会话继承，决策见 ADR 0004。

归属：步骤 3 W3「团队」（`docs/plan/step-3-work-partition.md`）。运行时依赖：`@nexgent/kernel`、`@nexgent/preset`、`@nexgent/subagent`（复用 `startMember`、`runMemberTurn`、`renderMemberResult` 与文件路径检查）。DSH 的 `experimental/agent-team`、`tool-agent-team` 只参考了设计（花名册、邮箱、任务板的划分），没有复制代码。

## Public API

| Export | What it does |
| --- | --- |
| `TeamPlugin` / `apply` / `name` | 行名 `@nexgent/team`；有 `ctx.tools`、`ctx.agents`、`ctx.session` 时注册 Lead 的六个工具；有 `ctx.context` 时注册邮件注入提供者 `team-mail`；卸载即注销 |
| `recoverTeam(lead, store)` | Lead 会话恢复后、第一轮之前调用（在 `closeInterruptedRuns` 之后）：收件人会话里已经有、却没有 `delivered` 记录的消息补写 `delivered`。幂等 |
| `TeamRegistry`、`Team` | 每个 Lead 会话一个团队，首次使用时从记录重建 |
| `leadTools(options)`、`teammateTools(team, name)` | 工具本身 |
| `reduceTeam`、`applyRecord`、`checkSpawn`、`checkMessage`、`checkTaskCreate`、`checkTaskUpdate`、`renderBoard`、`renderInjectedMessage`、`deliveredIds`、`undeliveredButSeen` | 纯函数 |
| `renderTeammatePrompt`、`WAKE_PROMPT`、`CONTINUE_PROMPT`、`MAX_RUNS_PER_LEAD_TURN` | 队友各轮的输入文本与每轮运行上限 |

## 行为

- **工具。** Lead 有 `spawn_teammate`、`send_message`、`wait_teammates`、`team_task_create`、`team_task_list`、`team_task_update`（全局注册）。队友在自己的 agent 作用域里另有 `send_message`、`team_task_list`、`team_task_update`（遮住全局的同名工具），看不到 `spawn_teammate`、`wait_teammates`、`delegate`、`workflow`（kernel 的 `MEMBER_DENIED_TOOLS`）。全局的六个工具被任何成员调用时都报 `tool/denied`。
- **队友与运行。** `spawn_teammate` 建子会话（预设默认 `general-executor`，`persona` 只替换人设），写 `team.member { active }` 与 `subagent.start`，立即在后台开始第一轮，不等待。一次运行 = 队友会话的一轮，在 Lead 里对应一对 `subagent.start` / `subagent.end`；运行用 `lead.holdTurn` 挂在 Lead 的轮次上。`subagent.start` 是工具记录，所以运行只在 Lead 的团队工具调用里开始：`spawn_teammate`（首轮）、`send_message`（唤醒空闲的收件人）、`wait_teammates`（等待期间持续启动到期的运行）。
- **花名册状态。** 运行完成或被费用上限挡下 → `idle`；以 `parent` 等原因取消 → 仍为 `active`（下一轮继续）；失败 → `stopped`（名字可以再用来建新队友）。名字匹配 `^[a-z][a-z0-9-]{0,31}$`，`lead` 保留，在册（非 stopped）唯一，花名册至多 16 项。
- **并发。** 同时运行的队友至多 4 个（`COLLABORATION_LIMITS.maxConcurrentMembers`，本包自己限）：第 5 个 `spawn_teammate` 报 `tool/denied`，到期的唤醒 / 继续运行排队，有空位时由 `wait_teammates` 启动。
- **邮箱。** `send_message` 先写 `team.message { state: queued }`（都写在 Lead 会话）。收件人下一轮开始时，`team-mail` 提供者把它作为 `user.message { source: inject }` 注入（正文 `<team-message id="…" from="…">…</team-message>`），kernel 写下注入记录后本包写 `delivered`。空闲队友收到邮件后由 Lead 的下一次团队工具调用唤醒（`WAKE_PROMPT`）。给 Lead 的邮件由 `wait_teammates` 在结果里交出并写 `delivered`；Lead 没等就结束轮次时，在 Lead 下一轮开始时注入。每个收件人待投递至多 64 条，单条至多 64 KiB（UTF-8），不能发给自己或不在册的名字。
- **任务板。** `team_task_create` 分配 `t1`、`t2`…，`dependsOn` 只能指向已有任务（因此不会成环），至多 256 项。`team_task_update`：依赖未全部 `completed` 时不能进入 `in_progress`；`completed` / `cancelled` 是终态；队友只能改无人负责或自己负责的任务，认领无主任务时自动成为负责人；Lead 能改任何任务。`team_task_list` 同时列出花名册，`meta` 带 `{ members, tasks }`。
- **等待。** `wait_teammates` 等指定队友（默认所有 `active`、正在运行或有到期运行的）没有运行中、也没有到期的运行，然后返回每人最后一次运行的结果（`renderMemberResult`）、交给 Lead 的邮件与当前任务板；有队友结果不是 `completed` 时工具结果标为错误。
- **轮次边界。** 队友只在 Lead 的轮次里工作。Lead 轮次结束（或被取消）时 kernel 以 `parent` 取消仍在运行的队友，本包在同一轮里写完 `subagent.end` 与花名册状态，此后该轮不再启动新运行；Lead 下一轮的第一次团队工具调用（通常是 `wait_teammates`）以 `CONTINUE_PROMPT` 继续未完成的队友。
- **恢复。** 团队在进程里首次使用时（Lead 的团队工具调用，或 Lead 轮次开始时的提供者）从 Lead 记录重建；`queued` 的消息如果已经出现在收件人会话里（注入的消息，或 Lead 的工具结果），只补写 `delivered`，不再投递；没出现的在收件人下一轮投递一次。宿主恢复 Lead 后应依次调用 `closeInterruptedRuns`（`@nexgent/subagent`）与 `recoverTeam`。队友会话在下次运行时由 `ctx.agents.resume(id, { child, preset })` 重开，kernel 先把中断的那一轮补成 `interrupted`。

## Model Experience

六个工具的描述共约 1.4 千字符。队友首轮消息 = 任务 + 要先读的文件 + 一段团队说明（成员名单、怎么发消息、怎么用任务板、写到 `<name>/` 子目录、用 `present` 交付、最后一段回复写什么）。注入的邮件是一段带发件人的短标签文本，不进 Lead 的历史（除非是发给 Lead 的）。

## Known Limitations and Deferred Work

- **邮件在收件人的下一轮开始时投递，不是下一步之前。** 契约说“在收件人下一步之前注入”，但 kernel 只在轮次开始时调用上下文提供者，没有逐步注入的接口；运行中的队友要等这一轮结束、被唤醒后才收到。要做到逐步注入，需要 kernel 增加每步调用的钩子（已在交接文档里提出）。
- **非团队成员仍看得到 `send_message` 与 `team_task_*`。** 契约的 `MEMBER_DENIED_TOOLS` 只有四个名字，全局注册的 `send_message`、`team_task_create`、`team_task_list`、`team_task_update` 对委派与工作流成员可见（调用会被拒绝）。H15 要求成员看不到团队工具，需要契约把这四个也列入（队友的同名工具在自己作用域里，不受影响）。
- 一个队友在一个 Lead 轮次里至多运行 8 次（`MAX_RUNS_PER_LEAD_TURN`），防止两名队友互相回信无休止；之后的邮件留到下一轮。
- `spawn_teammate` 的 `persona` 只保存在内存里：进程重启后队友按预设名重开，人设回到预设的。
- 插件需要宿主的注册表加载，`recoverTeam` 需要宿主在恢复后调用（SDK 接入归 W6）。
