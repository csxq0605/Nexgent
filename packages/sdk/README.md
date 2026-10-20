# @nexgent/sdk

进程内 TypeScript SDK：CLI 与桌面应用共用的项目、会话、轮次与事件、审批、资料、成果、反馈、目标、设置与导出接口。桌面应用的主进程持有一个实例，渲染进程经 IPC 按 `SdkMethods` 的方法名调用（白名单与令牌规则见 `docs/spec/permissions.md` §本地 IPC 与访问令牌）。

归属：计划步骤 2。接口 `src/api.ts` 由 W0（「步骤二契约」）在第 1 轮冻结，只有类型与方法名清单；实现由 W4（「SDK 与 CLI」）在第 3 轮完成。冻结后改接口走契约修改 PR，并在 PR 描述里点名受影响的包（`apps/desktop`、`apps/cli`）。

约束：

- 不 import Electron，可在纯 Node 下运行；
- 所有参数与结果都是 JSON 安全的，原样跨 IPC；错误以 `NexgentError` 拒绝，跨 IPC 时传 `toErrorInfo` 的投影；
- 任何方法都不返回密钥值，只返回 `CredentialInfo`（`configured`、`source`）；
- 每个轮次的事件流以且仅以一个 `turn.end` 收尾，取消、审批超时、强杀恢复时也一样。

## 实现（W4，步骤 2 第 3 轮）

入口：`createSdk(options)` 返回 `LocalNexgentSdk`，实现 `NexgentSdk`（`call` / `subscribe` / `dispose`）。

- **装载**：每个打开的项目一个 Cordis 应用（`src/boot.ts`）：kernel 默认 profile，加 `@nexgent/context`、`@nexgent/skill`、`@nexgent/tasking` 三行（profile 的 `insert` 补丁，不改 `packages/kernel/profiles/nexgent.yml`）。`env` 交给 llm provider 和凭证服务；`NEXGENT_COMPACTION_THRESHOLD` 写进 context 行的 `compaction.thresholdTokens`。
- **项目**：`projects.open` 不存在且 `create: true` 时建目录；总会建好 `.nexgent/` 并在缺失时写默认 `config.json`。最近项目存在 `<home>/recent-projects.json`（`{ version: 1, projects: [{ root, lastOpenedAt }] }`，新到旧，最多 20 条；文件坏了按空处理）。`projectId` 在一个 SDK 实例内对同一根目录不变。
- **会话**：每个打开的会话一个 kernel agent，持有会话锁。`turns.send`、`materials.add`（带 `sessionId`）、`goals.set/update` 遇到未打开的会话会自动打开。`sessions.open` 发现上个进程在轮中死掉时，由 kernel 写 `turn.end { interrupted }`，SDK 同时发一个 `turn.end` 事件。`sessions.list` 扫描 `.nexgent/sessions/*/session.jsonl`，读不出的会话跳过。`sessions.coordinator` 返回项目的常驻协调者对话（`<数据目录>/coordinator.json` 记它的 id，第一次调用时新建；列表里带 `coordinator: true`），桌面应用把它置顶。
- **讨论串**（协调者第二步，`src/threads.ts`）：协调者把每一块活都交给讨论串（它没有 `organize`、`delegate`、`workflow`，讨论串在内部派成员）。每个项目的应用多一行 `@nexgent/threads`，提供 `ctx.threads`（`SdkThreadHost`）并注册 `start_thread`、`message_thread`、`read_thread`、`list_threads`。讨论串是根会话（`session.start.thread`），在后台开始它的轮（`startTurn({ source: 'thread' })`），协调者那边写 `subagent.start` / `subagent.end`（`executionForm: thread`）；这一轮结束后叫醒协调者（并进正在跑的一轮，否则开始新的一轮），这一轮起的讨论串都结束后重新算画像交给 `ctx.organizations.noteProfile`。项目关闭时不再叫醒。`threads.list` 返回一个对话的讨论串和状态，事件 `thread.message` 对应对话与讨论串之间的每条消息，`SessionSummary.thread` 标出讨论串。规则见 `docs/spec/data-formats.md` §讨论串。
- **总对话的提示与笔记**（协调者第三轮，同一文件）：同一行还注册 `update_project_notes`（只有总对话看得到；SDK 创建和恢复总对话时传 `coordinator: true`），笔记存 `<dataDir>/coordinator-notes.md`；上下文提供者 `coordinator` 只给总对话加 `Coordinating this project` 与 `Project notes` 两段系统提示。讨论串或它的成员有审批没答时，`threads.list` 的那一项带 `needsApproval: true`。
- **事件**：kernel 事件映射成 `SdkEvent`，`eventSeq` 按会话从 1 递增（同一 SDK 实例内关了再开也接着数）。`deliverable.presented`、`turn.files`、`compaction` 来自会话记录；`material.added` 和 `goal` 由写它们的 SDK 方法发（带完整元数据和目标）。每轮恰好一个 `turn.end`：正常结束、取消、审批超时、强杀恢复都是；agent 根本跑不起来时 SDK 自己补一个 `turn.end { error }`。
- **轮次结束后的收尾**：`turn.end` 事件发出后，SDK 还要写 checkpoint 和账本；这期间再 `turns.send` 会等收尾完成，而不是拒绝。轮次真正在跑时再发才拒绝（`session/locked`）。
- **账本**：每轮一条 `task.outcome`（`turns: 1`，本轮的请求数、用量、工具调用），状态映射与 CLI 相同；费用上限停下的轮由 kernel 写，SDK 不重复写。关闭 agent 时用 `skipOutcome`。
- **审批**：默认由 `approval.request` 事件 + `approvals.respond` 应答（`decidedBy: 'user'`；迟到或重复的应答返回 `false`）。`approvalTimeoutMs` 设了就超时拒绝（`decidedBy: 'timeout'`）。宿主可传 `approvalResponder` 自己问（CLI 的 TTY 提示）。
- **资料、成果、反馈、目标**：直接调用 `ctx.tasking`。`deliverables.readText` 只读该版本列出的文件，上限 1 MiB，含 NUL 或不是 UTF-8 的拒绝（`tool/invalid-input`）；`.xlsx`、`.docx`、`.pdf`（上限 20 MiB）返回抽出的文字，表格每个工作表一段 `## Sheet:` 加 CSV 行。`deliverables.reveal` 需要宿主传 `reveal`，否则 `internal`。
- **设置**：`settings.update` 只接受 `model`、`thinking`、`effort`、`sandboxMode`、`costCaps`；把补丁合进磁盘上的 `config.json`（保留 `approvals`、`extraReadRoots` 等），整份校验通过后才原子写入。`settings.setApiKey` 写 `<home>/credentials.json`（0600），空字符串删除该项；只返回 `{ configured, source }`。密钥判断顺序：`NEXGENT_API_KEY`（环境变量，再文件），再 `ANTHROPIC_API_KEY` 环境变量。
- **导出**：`sessions.export` 写到 `outDir`（必须不存在或为空）：`session.jsonl`（原样）、`ledger.jsonl`（该会话的账本行）、`materials.json`、`deliverables.json`（该会话加过或引用的资料、该会话 present 的版本）、`manifest.json`（格式版本、会话 id、项目名、时间、版本、计数、`redactions`）。写之前在每个文件里搜当前生效的全部密钥值（及其 JSON 转义形式），命中替换为 `[REDACTED]`。

### 步骤 3（W6）：成员与协作

- **装载**：`step3ProfileRows()` 在步骤 2 的三行之后加 `@nexgent/tool-spreadsheet`、`@nexgent/web`、`@nexgent/ptc`、`@nexgent/subagent`、`@nexgent/workflow` 五行。技能行传 `userDir: <home>/skills`，用户技能目录跟着 SDK 的 `home` 走。
- **恢复**：打开根会话（`agents.resume`）后、第一轮之前依次跑 `ROOT_SESSION_RECOVERIES`：`recoverWorkflows`（内部先 `closeInterruptedRuns`，把没有 `subagent.end` 的成员运行补成 `interrupted`，再补工作流的 `workflow.end`）。某一步失败只发一个非致命 `error` 事件，会话照常可用。
- **跟踪成员**：父会话写 `subagent.start` 时成员已在 kernel 里打开，SDK 当即订阅它，此后成员的全部事件带 `parentSessionId` 发出（`eventSeq` 按成员会话自己计）。成员关闭（`closed`）后取消订阅。成员不由 SDK 打开或关闭，也不写 SDK 的 `task.outcome`（kernel 在成员关闭时写它自己的）。
- **成员进度事件**（发在父会话上）：`subagent.start` → `member.start`（`status: running`）；`subagent.end` → `member.end`（结局、成果、用量、错误）；`workflow.phase` → `workflow.phase`。
- **只读**：`turns.send`、`sessions.rename`、`goals.*`、`materials.add` 遇到成员会话报 `tool/denied`；`sessions.open` 打开成员时返回只读视图（不加锁）；`sessions.close` 对成员不做任何事。`turns.cancel` 对成员会取消它正在跑的那一轮（父会话的工具按 `cancelled` 收尾）；取消父会话时 kernel 以 `parent` 取消成员。
- **列表与视图**：`sessions.list` 默认只列根会话并带 `childCount`，每项带 `firstMessage`（用户输入的第一条消息，截到 200 字，界面在没有标题和目标时用它作列表标题），`includeChildren: true` 时成员也列出（带 `parentSessionId`、`member`）；`sessions.children` 按创建时间列某会话的成员；`sessions.view` 不加锁读任何会话；`sessions.collaboration` 从父会话记录折叠出成员运行和工作流。历史里 `member`、`workflow` 项放在开始的位置，显示最新状态。
- **审批**：成员的 `approval.request` 事件发在成员会话上（带 `parentSessionId`，请求带 `member`）；`approvals.respond` 用成员会话 id 或父会话 id 都能应答。

进程内扩展（不经 IPC，CLI 用）：`onAgentEvent`（原始 kernel 事件）、`createSession({ model })`、`openSession({ sandboxMode })`、`cancelTurn({ cause })`、`startTurn`（返回 `done`，在 `task.outcome` 写完后 settle）、`isRunning`、`apiKeyInfo`。

测试：`tests/members.spec.ts`（步骤 3：插件装载后工具齐全、委派成员从开始到成果的事件与列表 / 视图 / 协作视图、成员只读、取消父会话传到成员、子进程强杀后打开父会话补 `interrupted`、工作流历史折叠、成员审批由成员会话发出、可用父会话 id 应答）；`tests/sdk.spec.ts`（项目、两个项目同时各跑一轮、事件、取消、关闭、审批的拒绝 / 批准 / 超时、设置、密钥、导出脱敏、不依赖 Electron）；`tests/checkpoint.spec.ts` 是中期检查点第 4 项：子进程只用 SDK 跑“资料（csv + xlsx）→ 读表技能 → 写文件 → present v1 → 反馈 → str_replace → v2 → 第 3 轮流式输出到一半 SIGKILL”，本进程新建 SDK 恢复会话、核对资料 / 成果 / 反馈 / 目标都在、续聊（请求里带完整历史），最后导出。
