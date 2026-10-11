# ADR 0004：四种执行形态、子会话与成员规则

- **状态**：已接受
- **日期**：2026-10-11
- **依据**：计划 [4.3](../research/pr4-review-and-plan-2026-10/README.md) 与 4.7；步骤 3 分工表 [`docs/plan/step-3-work-partition.md`](../plan/step-3-work-partition.md)（“委派与子任务的资料共享、成果返回”与“已定的决定”）；用户 2026-10-11 15:20–15:24 的决定（委派与团队只做一层；成员与主对话用同一套审批规则，询问时标明成员）。
- **替代**：无。本 ADR 补充 ADR 0001 的执行形态部分，并勘误计划 4.3 第 4 项的删除清单（见“勘误”）。

## 背景

步骤 3 对应产品目标 ②：按任务决定是否委派，子任务共享必要资料并返回实际成果，不固定角色与阶段。DSH 的 subagent、agent-team、workflow、ptc-runtime 给出了参考，但它们各有自己的会话、事件与持久化模型；Nexgent 已经有会话 JSONL v1、账本、`present` 与审批代理，步骤 3 要把协作建在这些已有机制上，而不是再引入一套执行系统。

## 决策

1. **四种执行形态。** `direct`（主对话自己做，默认）、`delegated`（主对话把一个子任务交给一个成员，前台等待结果；`fresh` 只带任务说明与资料，`fork` 另带主对话到上一轮结束为止的历史）、`team`（Lead 加具名队友、邮箱、任务板）、`workflow`（模型写脚本或交一张声明式图，用 `agent() / parallel() / pipeline()` 编排成员；同一运行时承载 PTC）。契约类型 `ExecutionForm`；账本 `executionForm` 增加 `team`。
2. **每个成员是一个子会话。** 委派对象、队友、工作流节点都是同一进程内由 `ctx.agents.create({ child })` 建出的独立会话：有自己的锁与 `session.jsonl`，`session.start` 带 `parentSessionId` 与 `member`，可以单独恢复与只读查看。父会话写 `subagent.start` / `subagent.end`（每次成员运行一对），团队与工作流另写 `team.*` / `workflow.*` 记录，重启后靠它们重建“谁做了什么”。
3. **深度 1。** 只有根会话能启动成员；成员的工具列表里没有 `delegate`、`spawn_teammate`、`wait_teammates`、`workflow`（`MEMBER_DENIED_TOOLS`），队友保留 `send_message`、`team_task_list`、`team_task_update`。kernel 拒绝以子会话为父会话创建子会话。
4. **资料按 id、文件按路径、成果经 `present`。** 资料按 `materialIds` 传给成员首轮，由现有的资料提供者注入引用，资料目录只读、不复制；所有成员共用同一个项目工作目录，不建副本；成员用 `present` 交付文件，成果元数据带 `memberId` 与 `memberName`。不给 `deliverableId` 时，只有**同一会话**里主文件路径相同才追加版本，两个成员交同名文件各成一份成果。父会话读成员成果后自己汇总，并用自己的 `present` 给用户最终成果。
5. **继承只收窄。** 成员的沙箱模式不得宽于父会话（宽了报 `sandbox/denied`，不悄悄降级）；预设的工具范围用 scoped `restrict()` 与父会话可见集合求交；模型、effort、thinking 可由预设改写。父会话的系统提示不整体给成员，成员的人设来自预设，系统提示里有一行固定的成员标识（`renderMemberPromptLine`）。
6. **审批：与主对话同一套规则。** 成员的审批请求进同一个审批代理，`ApprovalRequest.member` 标明成员名、形态与根会话；宿主照常询问用户并在提示里写明是哪个成员；项目审批设置放宽时主对话与成员一起生效；成员不单独自动批准，也不单独自动拒绝；没有交互界面应答时与主对话的现行规则相同。
7. **费用按任务树计。** 根会话打开（create 或 resume）时生成 `taskId`，成员继承；`costCaps.perTask` 按整棵树的请求数与 token 累计，成员花的钱算进父会话的额度；`BudgetShare` 只能再压低某个成员的份额。`perProject` 照旧按账本。每个成员会话关闭时写自己的 `task.outcome`（`memberId` 为成员会话 id），根会话的 `task.outcome` 带 `formsUsed`。
8. **取消向下传播。** 父会话的轮次被取消或结束时，仍在运行的成员以新原因 `parent` 取消（`TurnCancelCause` 增加 `parent`），在工具取消宽限期内收尾；团队队友只在 Lead 的轮次内工作，Lead 轮次结束时未完成的队友以 `parent` 取消，状态保留，下一轮可继续（`ctx.agents.resume(id, { child })`）。不做轮次结束后的后台运行。
9. **并发与上限。** kernel 仍顺序执行同一步里的多个工具调用；并行只来自工作流的 `parallel()` 与团队。默认同时运行的成员最多 4 个，一棵任务树的成员总数最多 16 个；团队任务板 256 项、每个队友待投递消息 64 条、单条 64 KiB；一张图最多 16 个节点（`COLLABORATION_LIMITS`）。
10. **形态选择只写原则。** 系统提示写选择原则（默认直接执行；子任务能独立完成且有可检查的产出时再委派；多个可并行、需要互相沟通时用团队；步骤固定、可批量时用工作流），不写固定角色和阶段（`agent-hooks.md` §步骤 3 系统提示增量）。

## 勘误

计划 4.3 第 4 项列出的 `src/`、Python `tests/`、benchmark Python 插件、`scripts/*.py`、`pyproject.toml`、`requirements-*.txt`、`runtime/` 从未在 `nexgent-app` / `main` 上，它们只在 `refactor/dsh-application`（PR #4 分支）及其祖先上。步骤 3 的“删除 Python”因此是：在 `nexgent-app` 上删掉旧 PyQt 的 `nexgent/`、`stage-*`、`tests/`、`config.py`（与 `archive/harness-gui` 相同），并把 `refactor/dsh-application` 顶端归档为 `archive/python-host`。这两件事已由「测试与 CI」在 PR #54 完成。

以下两条按步骤 3 的实现勘误（2026-10-11，契约修改随 PR 同步），不改上面的决策编号与原文：

- **第 3 项的成员禁用工具。** `MEMBER_DENIED_TOOLS` 应为除 `run_code` 外的全部协作工具：`delegate`、`spawn_teammate`、`wait_teammates`、`workflow`、`send_message`、`team_task_create`、`team_task_list`、`team_task_update`。原文只列了前四个，委派对象与工作流节点因此能看到团队工具。队友保留 `send_message`、`team_task_list`、`team_task_update` 的方式不变：团队包在队友自己的作用域注册它们，作用域遮罩不隐藏同一作用域自己注册的工具。
- **第 2、8 项的“每次成员运行”。** 队友不是每个 Lead 轮次一次运行：首次启动、空闲时被新邮件唤醒、下一轮续做被 `parent` 取消的工作，各是子会话的一轮，各有一对 `subagent.start` / `subagent.end`，同一 Lead 轮次里可以有多对（团队包限制每轮至多 8 次）。运行中的队友经 kernel 的 `Agent.beforeRequest` 在下一次模型请求前收到邮件。第 8 项“队友只在 Lead 的轮次内工作”不变。

同时，审批策略对 `read-only` 下 `run_code` 的豁免改为契约字段 `ToolDefinition.selfSandboxed`（`permissions.md` §工具审批），不再按工具名判断。

## 后果

- **契约**：`packages/kernel/src/contracts/collaboration.ts`、`step3-tools.ts` 为新增；`session.ts`（九种记录、`session.start.member`、取消原因 `parent`）、`approvals.ts`（`member`）、`ledger.ts`（`team`、`formsUsed`）、`tasking.ts`（成员成果、`present` 同会话规则）、`tools.ts`（`attribution`、`member`）、`skill.ts`（`user` 来源）、`agents.ts`（`CreateAgentOptions.child`、`ResumeAgentOptions.child`）与 `packages/sdk/src/api.ts`（API 版本 3）同步修改。kernel 在实现落地前对 `child` 选项报 `internal`。
- **会话格式**：新记录在 v1 内追加；步骤 2 写出的会话照常读出与续写。仍没有对外发布的读取方，理由同步骤 2（`data-formats.md` §版本与兼容）。
- **实现分工**：kernel（子会话、归属、费用树、取消、审批标注、`present` 规则、系统提示）归「kernel 维护」；`delegate` 与预设归「委派」；团队归「团队」；工作流与 PTC 归「工作流与代码」；SDK 与桌面归「SDK 与桌面」。
- **不做**：多层委派；子智能体的后台 / 可续聊模式；外部子智能体提供方（Claude Code、Codex 等）；MCP 客户端；协作形态的收益宣称（验收只记录“能运行”与并列费用）。
