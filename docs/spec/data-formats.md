# 数据与文件格式规范

> 字段名以 `packages/kernel/src/contracts/` 为准，JSON Schema 在 `packages/session/schema/` 与 `packages/llm/schema/`。现行设计见 [产品与设计定位](../PROJECT_POSITIONING.md)。已删除功能留下的旧格式见“旧格式（只为读旧项目）”。

## 目的与范围

定义 `.nexgent/` 下所有持久化文件的格式，使会话、账本、能力版本、材料与成果能跨进程、跨版本读回；另定义本机凭证文件的位置与形状（它不在项目目录内，但由同一套读写原语处理）。

适用范围：

- `@nexgent/session` 写入与恢复的会话文件；
- `@nexgent/llm` 写入的请求账本，以及 `apps/cli` 在任务结束时写入的 `task.outcome`；
- `@nexgent/kernel` 读取的项目配置文件与凭证文件；
- `@nexgent/workspace` 负责创建与定位的目录布局。

共同约束：

1. **只追加。** 会话与账本文件都是 JSON Lines：一行一个 JSON 对象，UTF-8，无 BOM，行以 `\n` 结束。写入方只在文件尾追加，不改写已有行；唯一的例外是恢复时对被撕裂的最后一行的截断（见“追加与截断规则”）。
2. **每行自描述。** 每条记录都带 `type` 与时间戳；会话记录还带 `seq` 与 `sessionId`，任何一行脱离文件都能被归位。
3. **只写 JSON 能表示的值。** `undefined`、函数、`NaN`、循环引用在写入前被拒绝（`isJsonValue`），不会在磁盘上以 `null` 或缺字段的形式悄悄出现。
4. **账本不记内容。** 账本记录的类型里没有提示正文、消息内容、工具参数、工具输出、密钥、带凭证的 URL 的字段，因此写不进去；会话记录记内容，但不记密钥。
5. **只有 v1。** 不迁移 Python 时代的数据，也不为旧格式写读取器。

时间戳统一为 ISO-8601 UTC 字符串（`2026-10-07T08:00:00.000Z`），毫秒精度。标识符（会话 ID、请求 ID、工具调用 ID）为字符串；Nexgent 自己生成的用小写 UUID v4，模型返回的（工具调用 ID）原样保留。

## `.nexgent/` 目录布局

新项目与迁移完成的项目的数据在用户数据目录（见下一节）。本节的项目内布局只用于迁移前的旧项目和临时副本，子目录的内部布局两处相同。`@nexgent/workspace` 的 `Workspace.ensureLayout()` 在第一次运行时创建 `.nexgent/` 和全部子目录，创建是幂等的；其他包只写自己的子目录。

```text
<project>/
└── .nexgent/
    ├── config.json                       项目配置（本文“项目配置文件”）
    ├── sessions/
    │   └── <sessionId>/
    │       ├── session.jsonl             会话记录（本文“会话 JSONL v1”）
    │       └── .lock                     单写者锁，仅在有进程写入时存在
    ├── ledgers/
    │   └── <yyyy-mm>/
    │       └── requests.jsonl            账本（本文“账本记录”）
    ├── materials/
    │   └── <materialId>/
    │       ├── material.json             材料元数据（本文“材料元数据”）
    │       └── <storedName>              资料副本
    ├── outputs/
    │   └── <deliverableId>/
    │       └── v<n>/
    │           ├── deliverable.json      成果版本元数据（本文“成果元数据”）
    │           └── files/<path>          第 n 版的快照副本，保持项目内相对路径
    ├── skills/                           项目技能（用户创建，可选；agent-hooks.md §技能）
    │   └── <name>/SKILL.md
    ├── presets/                          项目预设（用户创建，可选；本文“预设”）
    │   └── <name>.json
    ├── architectures/                    保存的工作流图（本文“架构图存储”）
    │   └── <sha256>.json
    ├── capabilities/                     能力版本（本文“CapabilityBundle 清单”起三节；功能默认关闭）
    │   ├── <version>/                    一个能力包：manifest.json 与各组件目录
    │   ├── activation/<n>.json           采用历史链
    │   ├── candidates/<candidateId>/     候选：candidate.json 与提出的组件文件
    │   ├── trials/<trialId>.jsonl        门控试验收据（旁路文件 .attempt / .lock / .log 见“候选与门控”）
    │   ├── decisions/<decisionId>.json   采用、拒绝、回滚的结论
    │   └── drafts/<sessionId>/           会话的草稿组件
    └── snapshots/                        任务快照与检查（本文“任务快照与检查”）
        ├── objects/<sha256>              文件内容，每份一次
        ├── trees/<sha256>.json           快照树
        ├── tasks/<taskId>[.t<turn>].json 每个根轮开始时的快照记录
        └── checks/<taskId>[.t<turn>].json 每个根轮结束时的检查记录
```

本机凭证、用户级配置和用户数据目录放在 Nexgent 主目录 `<NEXGENT_HOME>`（环境变量 `NEXGENT_HOME`，默认 `~/.nexgent`，Windows 为 `%USERPROFILE%\.nexgent`），同一主目录下的所有项目共用，布局见下一节。

| 路径 | 内容 | 命名 | 创建者 | 写入者 |
| --- | --- | --- | --- | --- |
| `config.json` | 项目配置 | 固定 | 用户或 `nexgent run` 首次运行（写入默认值） | 用户、桌面应用 |
| `coordinator.json` | 协调者：项目常驻对话 `{ sessionId }` | 固定 | SDK `sessions.coordinator` 首次调用 | `@nexgent/sdk` |
| `coordinator-notes.md` | 总对话的项目笔记（纯文本，至多 8000 字符，`THREAD_LIMITS.notesChars`） | 固定 | 总对话调用 `update_project_notes`（整份替换：先写临时文件再改名） | `@nexgent/sdk` |
| `sessions/<sessionId>/` | 一个会话的全部文件 | `sessionId` 为小写 UUID v4 | `SessionStore.create` | `@nexgent/session` |
| `sessions/<sessionId>/session.jsonl` | 会话记录 | 固定 | 同上 | 同上 |
| `sessions/<sessionId>/.lock` | 锁文件 | 固定 | `SessionStore.create` / `lock` | 同上 |
| `ledgers/<yyyy-mm>/requests.jsonl` | 该月（UTC）的全部账本记录 | 月份取记录 `ts` 的 UTC 年月 | 第一次追加时 | `@nexgent/llm`（请求与工具记录）、`apps/cli`（`task.outcome`） |
| `materials/<materialId>/` | 一份资料：元数据与副本 | `materialId` 为小写 UUID v4 | `MaterialStore.add` | `@nexgent/tasking`（宿主），模型只读 |
| `outputs/<deliverableId>/v<n>/` | 一个成果的第 n 版：元数据与快照 | `deliverableId` 为小写 UUID v4，`n` 从 1 起 | `DeliverableStore.present` | `@nexgent/tasking`（宿主），模型只读 |
| `skills/<name>/SKILL.md` | 项目技能 | `name` 见 `agent-hooks.md` §技能 | 用户 | 用户；模型只读 |
| `presets/<name>.json` | 项目预设 | `name` 见“预设” | 用户 | 用户；模型只读 |
| `architectures/<sha256>.json` | 工作流图 | 规范化图的 SHA-256 | 第一次保存时 | `@nexgent/workflow`（宿主）；模型只读 |
| `capabilities/` | 能力包、采用历史、候选、试验、决定、草稿 | 见“CapabilityBundle 清单”起四节 | `ensureLayout` | `@nexgent/capabilities`（宿主）；模型的文件工具读写都拒绝 |
| `snapshots/` | 任务快照与检查 | 内容寻址，见“任务快照与检查” | `ensureLayout` | `@nexgent/capabilities`（宿主）；模型的文件工具读写都拒绝 |

规则：

- `.nexgent/` 内部对模型可见的文件工具按子目录区分：`sessions/`、`ledgers/`、`capabilities/`、`snapshots/` 读写都拒绝，`materials/`、`outputs/`、`skills/`、`presets/`、`architectures/` 与 `config.json` 只读（快照只由宿主写）；规则以 `permissions.md` §路径策略与写入限制为准。
- 所有路径在服务内部以绝对路径处理（`WorkspaceLayout`）；记录里出现的路径（如 `session.start.projectRoot`）也是绝对路径。
- 是否纳入版本控制由项目自己决定；建议忽略 `sessions/`、`ledgers/`、`outputs/`、`snapshots/`，保留 `config.json`；`capabilities/` 是否入库由项目决定（入库后换机器也能用同一能力版本）。
- 本机凭证文件不在项目内：`~/.nexgent/credentials.json`（Windows 为 `%USERPROFILE%\.nexgent\credentials.json`），形状见“项目配置文件”末尾。
- `<NEXGENT_HOME>/` 下的文件只由宿主写（`@nexgent/sdk` 的设置页、`@nexgent/capabilities`、`@nexgent/evolve`）；它们在每个项目之外，模型的文件工具本来就够不到（`permissions.md` §路径策略与写入限制）。

### 用户数据目录

会话、账本、快照、资料副本、成果快照、能力记录和“在本项目始终允许”的授权放在用户数据目录 `<NEXGENT_HOME>/projects/<projectId>/`；项目里的 `.nexgent/` 只留可以和同事共享的文件（`SHARED_PROJECT_ENTRIES`）。上面的项目内布局仍然有效：迁移没完成的项目照旧在项目内读写（`resolveDataLocation`，见“迁移”）。契约 `data-layout.ts`；路径由纯函数 `resolveUserDataLayout(home)`、`resolveProjectDataLayout(home, projectId)` 算出。

```text
<project>/.nexgent/                       可以入库的部分
├── project.json                          项目身份（ProjectIdentity）
├── config.json                           项目配置；迁移后不再含 approvals
├── .gitignore                            Nexgent 写入，只放行下面这些（projectGitignoreText）
└── skills/  presets/  architectures/     同上
<NEXGENT_HOME>/
├── credentials.json  config.json  recent-projects.json
├── skills/                               用户技能（用户自己写的）
├── skill-library/                        学来的技能（本文“技能库”，默认关闭）
├── organizations/runs.jsonl              组织库（本文“组织库”）
├── handbook/ops.jsonl                    用户级经验手册（本文“经验手册”；旁边的 usage.jsonl 是使用记录）
├── practice/cases/<caseId>.json          练习题（本文“练习题集”）
└── projects/<projectId>/
    ├── project.json                      最近一次打开的位置（ProjectDataIndex）
    ├── grants.json                       project 范围授权（ProjectGrantsFile）
    ├── migration.json                    迁移记录（MigrationRecord；迁移过才有）
    ├── coordinator.json                  总对话 { sessionId }（本文“讨论串”）
    ├── coordinator-notes.md              总对话的项目笔记
    ├── sessions/ ledgers/ snapshots/ materials/ outputs/ capabilities/
    │                                     内部布局与上面项目内的同名目录相同（PROJECT_DATA_SUBDIRS）
    ├── handbook/ops.jsonl                项目级经验手册
    ├── learning/queue.json  learning/skills.json   后台学习队列与技能归纳记录
    └── evaluations/<taskId>.json         自评（本文“自评”）
```

| 文件 | 字段 | 说明 |
| --- | --- | --- |
| `.nexgent/project.json` | `formatVersion: 1`、`projectId`、`createdAt`、`name?`（≤200 字符） | 第一次打开项目时写一次，此后只改 `name`。`projectId` 是 64 位小写十六进制：创建时取项目根 realpath 的 SHA-256，之后固定，移动或改名目录不换 id、不丢数据。不含路径、授权与密钥 |
| `<home>/projects/<id>/project.json` | `formatVersion: 1`、`projectId`、`root`、`lastOpenedAt` | 每次打开时重写，供不打开项目就能列出与清理用户数据 |
| `<home>/projects/<id>/grants.json` | `formatVersion: 1`、`approvals: ApprovalGrant[]` | `project` 范围授权（之前在 `config.json.approvals`）；永远不在项目里，所以克隆别人的项目不会带来别人的授权 |

规则：

- 同一台机器上两个目录带同一个 `projectId`（复制了整个 `.nexgent/`）时，宿主发现 `ProjectDataIndex.root` 指向另一个仍然存在、身份相同的目录，就给后打开的目录生成新 id（新根 realpath 的 SHA-256）并改写它的 `project.json`，两份数据不混。
- `.nexgent/.gitignore` 的内容是 `projectGitignoreText()`：先 `*`，再放行 `.gitignore`、`project.json`、`config.json` 与 `skills/`、`presets/`、`architectures/` 及其内容。旧数据还在项目里时（迁移前，或用户选择保留）它让 git 不收这些数据；迁移后无害。宿主不改项目根的 `.gitignore`。
- 用户数据目录在项目之外，文件工具与 `run_code` 读写都拒绝（`permissions.md` §路径策略与写入限制）；只有宿主写。例外：数据在用户数据目录时，`materials/` 与 `outputs/` 作为只读根加给文件工具，模型按资料给出的绝对路径读资料副本。
- 实现：路径由 kernel 的 `locateProjectData` / `resolveProjectLayout(root, { home })` 同步算出（读 `.nexgent/project.json`、`migration.json`，看 `.nexgent/` 里有没有旧数据），`WorkspaceLayout` 的 `dataDir` 与各数据子目录随之指向用户数据目录，`configFile` 仍在项目里；`location`、`projectId`、`grantsFile` 说明数据在哪。工作区服务打开项目时（`prepareProjectData`）第一次写 `project.json` 与 `.nexgent/.gitignore`，每次重写 `ProjectDataIndex`，有旧数据时迁移。从数据目录反查项目用 `layoutOfDataDir`（读索引的 `root`）。
- 记录里的数据路径（如资料元数据的 `path`、会话记录里的资料引用）仍写成项目相对的逻辑路径 `.nexgent/materials/<id>/<storedName>`；读取方用 `resolveDataPath(layout, path)` 换算到当前位置，所以迁移不必改写任何记录。
- 数据在用户数据目录时，`project` 范围授权只读写 `grants.json`，`config.json.approvals` 不再生效。
- 临时副本（门控重放）在 `.nexgent/` 放空文件 `local-data`（`LOCAL_DATA_MARKER_FILE`）：数据留在副本里，随副本删除，不进用户数据目录；副本里即使带着旧布局的数据也不迁移。

## 项目配置文件

文件：`.nexgent/config.json`，一个 JSON 对象。文件不存在等同于 `{}`；每个字段都有默认值。启动时读取一次，运行中不热加载。密钥不写在这里。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `version` | `1` | `1` | 格式版本；只有 1 |
| `model` | string | `"claude-sonnet-5-5"` | 传给端点的模型 ID |
| `endpoint` | string | `"https://api.anthropic.com"` | Claude API 的 base URL，不含路径与凭证；环境变量 `NEXGENT_API_BASE_URL` 可覆盖 |
| `thinking` | `"off" \| "on"` | `"on"` | 执行时是否开启 reasoning；`on` 是自适应 thinking，`off` 是 provider 的最低 thinking 设置 |
| `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | 推理深度（`output_config.effort`） |
| `sandboxMode` | `"read-only" \| "workspace-write" \| "full-access"` | `"workspace-write"` | 新会话的默认沙箱模式；语义见 `permissions.md` |
| `costCaps.perTask` | `CostCap` | 无 | 每任务上限（整棵任务树） |
| `costCaps.perConversation` | `CostCap` | 无 | 每个对话（会话的全部轮）上限 |
| `costCaps.perProject` | `CostCap` | 无 | 每项目上限 |
| `approvals` | `ApprovalGrant[]` | `[]` | `project` 范围的审批授权；语义见 `permissions.md`。迁移后移到用户数据目录的 `grants.json`，迁移没完成的项目仍在这里读写 |
| `extraReadRoots` | `string[]` | `[]` | 额外可读的绝对目录；语义见 `permissions.md`；改动它总要审批 |
| `extraWriteRoots` | `string[]` | `[]` | 额外可写的绝对目录（文件工具与命令沙箱）；改动它总要审批 |
| `commands.network` | boolean | `true` | 命令能否联网（有系统沙箱的平台上生效）；改动 `commands` 总要审批 |
| `commands.systemSandbox` | `"auto" \| "required" \| "off"` | `"auto"` | 命令的系统沙箱；`required` 时没有沙箱就不执行命令，`off` 由用户关；语义见 `permissions.md` §命令策略 |
| `autoImprove` | boolean | `true` | `learning.enabled` 的旧名：没写 `learning.enabled` 时取它的值；设置页改其中一个时两个保持相等；改动它总要审批 |
| `capabilities` | `CapabilitiesConfig` | 见下 | 能力门控与回滚设置（功能默认关闭）；改动它总要审批（`permissions.md` §工具审批） |
| `improvement` | `ImprovementConfig` | 见下 | 反思与技能归纳用的模型与 thinking，另有 `shareImproverEvidence`；其余字段只为读旧文件；改动它总要审批 |
| `checkRetries` | integer 0–5 | 2 | 根轮里本轮的确定性检查（本轮跑过的测试命令最近一次退出码非 0、本轮交付的文件缺失或解析不了）失败时，内核把失败项（截断到 2000 字符，开头 `[Nexgent] Automatic check`）作为一条 `user.message { source: "inject" }` 发回模型，在同一轮里接着做，最多这么多次；模型对重试说明只回了文字、没调用工具时（已说明检查为什么过不了，或在问用户）不再重试；重试的模型调用计入这一轮的步数与费用上限，用户停止立即结束；0 关闭；成员不重试；改动它总要审批 |
| `checkCommands` | string[]（≤ 5 条，每条 ≤ 500 字符） | `[]` | 项目自己的完成检查命令。根轮改动过项目（有可能写入或执行的调用成功过）时，在轮末检查前于项目根目录依次运行，经注册的 `bash`（Windows 为 `pwsh`）工具，沙箱与命令策略同模型的命令；需要审批的命令不运行，算失败。每条成为一个 id 为 `check-<n>` 的 `test-command` 检查，退出码 0 为通过；失败时和其他检查一样触发自动重试，重试说明里带输出末尾（≤ 600 字符）。每次重试前后的检查写一条账本 `check.retry`。改动它总要审批 |
| `maxStepsPerTurn` | integer ≥ 1 | 无（用 `agents.maxSteps`，400） | 一轮最多的模型调用次数；到了上限这一轮以 `cancelled`、`cause: "step-limit"` 结束，再发一条消息接着做；成员预设的 `maxSteps` 优先；改动它总要审批 |
| `learning` | `LearningConfig` | 见下 | 后台学习开关、美元预算、单任务自评上限、共享两个方向、技能库开关；改动它总要审批 |

`CapabilitiesConfig`（契约 `capabilities.ts`，校验 `assertCapabilitiesConfig`）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `autoTrial` | boolean | `false` | 提出候选的任务结束后自动在独立进程里跑门控 |
| `trialBudget` | `{ maxTokens?, maxRequests? }` | `{ maxRequests: 400, maxTokens: 8000000 }` | 一次试验（全部运行与评审）的预算，计法同 `CostCap` |
| `selectionCases` | integer ≥ 2 | `2` | 选择集用例数；历史任务不够时门控等待，不降低要求 |
| `guardCases` | integer ≥ 1 | `1` | 守护集用例数 |
| `repeats` | 1–5 | `2` | 每个用例每个臂的运行次数 |
| `costRatioCap` | 1–10 | `1.2` | 质量打平时，评审偏好候选、且费用比不超过它才采用 |
| `costApprovalRatio` | 1–10 | `2` | 质量提高但费用比超过它时不采用（记为拒绝） |
| `reviewer` | `{ model, thinking }` | `{ "model": "claude-sonnet-5-5", "thinking": "on" }` | 评审模型，可改为 `claude-opus-5-5`；只在检查打平时起作用 |
| `rollback.windowTasks` | 1–20 | `3` | 采用后观察的根任务数 |
| `rollback.consecutiveErrors` | 1–20 | `3` | 新组件连续出错多少次即回滚 |

下限是硬下限：`selectionCases: 1`、`guardCases: 0` 报 `config/invalid`。

`ImprovementConfig`（契约 `improvement.ts`，校验 `assertImprovementConfig`，未知字段报 `config/invalid` 并在 `details.field` 写出字段路径）。现在只有下面三个字段有代码读它们：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `model` | string | `"claude-sonnet-5-5"` | 反思与技能归纳请求的模型，可改为 `claude-opus-5-5`；门控的评审模型是 `capabilities.reviewer` |
| `thinking` | `"off" \| "on"` | `"on"` | 这些请求是否开 thinking |
| `shareImproverEvidence` | boolean | `true` | 没写 `learning.contribute` 时它的默认值 |

`feedbackThreshold`、`budget`、`meta` 仍通过校验，但没有代码读它们，见“旧格式（只为读旧项目）”。`improvement` 整个对象与用户级配置都不能由能力组件改写（`permissions.md`）。

`LearningConfig`（契约 `learning.ts`，校验 `assertLearningConfig`，补默认值 `resolveLearningConfig`；未知字段报 `config/invalid`，`details.field` 写 `learning.…`）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true`（没写时取旧字段 `autoImprove`） | 本项目是否自评并在后台学习。用户级通知没确认之前，开着也不花钱（`mayLearn`，见“用户级配置文件”） |
| `budget.maxUsd` | 0–1000 | `3` | 后台学习（含自评、校准）的估算美元上限；按价目表估算、含缓存；0 表示一分不花 |
| `budget.windowDays` | 1–365 | `30` | 时间窗天数，按账本 `ts` 往前滚动 |
| `selfEvalMaxUsd` | 0–5 | `0.05` | 一个任务的自评（生成评分要点加打分）上限 |
| `useShared` | boolean | `true` | 使用用户级共享的手册条目与技能 |
| `contribute` | boolean | `true`（没写时取 `improvement.shareImproverEvidence`） | 把本项目的条目、技能与练习题贡献到用户级 |
| `skills` | boolean | `false` | 开着时才从成功任务归纳、记录并评估技能（第 2 层） |

学习的花费是带 `learningPhase` 的账本记录之和（见“账本记录”），只计入 `learning.budget`，不计入任务的费用上限。

`CostCap`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `maxUsd` | number 0–100000 | 估算美元上限，按价目表、含缓存读写；用量里有估算值时照样计入并标明是估算。主字段，产品设置页只给它 |
| `maxTokens` | integer | 输入 + 输出 token 上限；超过时当前轮以 `cost-cap` 取消 |
| `maxRequests` | integer | 模型请求次数上限（含失败的请求） |
| `windowDays` | integer | 仅 `perProject`：按账本累加的时间窗，默认 30 |

几个字段同时给出时，先达到的那个生效（`costCapLevel`）；任一字段达到 80%（`COST_WARNING_RATIO`）时写一次 `cost.warning`。旧文件只有 `maxTokens` / `maxRequests` 时照常读出、照常执行。两个配置读取方都用 `checkCostCaps` 校验，所以接受同样的文件。计数方式与达到上限的行为见 `permissions.md` §费用上限。

示例：

```json
{
  "version": 1,
  "model": "claude-sonnet-5-5",
  "endpoint": "https://api.anthropic.com",
  "thinking": "on",
  "effort": "medium",
  "sandboxMode": "workspace-write",
  "costCaps": { "perTask": { "maxUsd": 2 }, "perConversation": { "maxUsd": 10 } },
  "learning": { "budget": { "maxUsd": 3, "windowDays": 30 }, "useShared": true }
}
```

读取规则：未知字段报 `config/invalid`（防拼写错误）；类型不符报 `config/invalid`；`version` 不是 1 报 `config/invalid`。缺字段补默认值（`resolveProjectConfig`）。

**用户级配置文件**（契约 `config.ts` 的 `UserConfig`，校验 `assertUserConfig`，补默认值 `resolveUserConfig`）。文件 `<NEXGENT_HOME>/config.json`，一个 JSON 对象；不存在等同于 `{}`；未知字段、类型不符、`version` 不是 1 报 `config/invalid`，`details.field` 写字段路径（如 `learning.noticeAcknowledgedAt`）。同一主目录下的所有项目共用它。密钥不写在这里。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `version` | `1` | `1` | 格式版本；只有 1 |
| `learning.noticeAcknowledgedAt` | ISO-8601 UTC? | 无 | 用户确认“Nexgent 会在后台用你的任务学习、每项目每月最多花费 X 美元”的时刻。没有它，任何项目的后台学习都不花钱（`mayLearn`）；SDK `learning.acknowledge` 写入，再次确认保留第一次的时刻 |
| `language` | BCP 47 语言标签? | 无 | 界面语言，即 Nexgent 写给用户看的文字（经验条目、状态原因、学习理由）用的语言，例如 `zh-CN`、`en`；没有时按每个任务第一条消息的语言。格式 `^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$`。设置页（SDK `userSettings.update` 的 `language`，`null` 删除）写入，后台学习每次反思前读取 |

受保护字段（`GUARDED_USER_CONFIG_FIELDS`）：`improvement`（旧文件里的 `improvement.meta` 仍通过校验，但被忽略）。审批规则同项目级的受保护字段：模型或组件请求改动总要审批，设置页（SDK `userSettings.update`）是用户自己的操作，不弹审批；文件在项目之外，文件工具够不到。

**应用 profile 行。** kernel 从 YAML profile 装载插件，profile 是有序的行列表，补丁文件（PR #4 `cordis.patch.yml` 的形式）按条目修改它。这两种文件是应用内部文件，不放在 `.nexgent/` 下，这里只定其行与补丁的语义：

| 形式 | 字段 | 语义 |
| --- | --- | --- |
| 行 `AppProfileRow` | `id`、`name`、`config?`、`disabled?` | `id` 在 profile 内唯一；`name` 是插件名；`config` 由该插件的 schemastery `Config` 校验 |
| 插入 `{ insert: [row, …] }` | — | 追加新行；`id` 已存在报 `config/profile-patch` |
| 补丁 `{ id, name?, config?, disabled? }` | — | 按 `id` 找行；`id` 不存在报 `config/profile-patch`；`config` 深合并（对象递归合并，数组与标量整体替换），`name`、`disabled` 给出时替换 |

补丁按文件顺序应用，纯函数 `applyProfilePatches` 固定这一语义。

**本机凭证文件。** `~/.nexgent/credentials.json`，权限 `0600`：

```json
{ "version": 1, "credentials": { "NEXGENT_API_KEY": "sk-…" } }
```

读取顺序：先环境变量（同名），再这个文件；空字符串视为未设置；不缓存。该文件只被 `Credentials` 服务读取，值只交给模型 provider。

## 会话 JSONL v1

文件：`.nexgent/sessions/<sessionId>/session.jsonl`。一个会话一个文件，一行一条记录。类型镜像：`packages/kernel/src/contracts/session.ts`。

### 公共字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | 记录类型，下表之一 |
| `seq` | number | 从 1 开始、每条 +1 的序号；恢复的游标 |
| `ts` | string | 追加时刻，ISO-8601 UTC |
| `sessionId` | string | 所属会话 |

`seq`、`ts`、`sessionId` 由 `SessionStore.append` 赋值，调用方传 `SessionRecordInput`（去掉这三个字段的记录）。

### 记录类型

| `type` | 何时写 | 专有字段 |
| --- | --- | --- |
| `session.start` | 创建会话时，必为 `seq: 1` | `version: 1`、`projectRoot`、`model`、`sandboxMode`、`parentSessionId?`、`title?`、`member?`（子会话必有，与 `parentSessionId` 同时出现）、`capabilityVersion?`（会话打开时采用中的能力版本）、`plan?`（`true` 表示以计划模式开始）、`commandSandbox?`（`{ kind: "active", platform }` \| `{ kind: "none", reason }` \| `{ kind: "off" }`：本会话的命令是否在系统沙箱里跑）、`thread?`（`{ coordinatorSessionId, title }`：本会话是总对话起的讨论串，见 §讨论串）。旧改进作业的会话另有 `purpose?`、`improvement?`，见“旧格式（只为读旧项目）” |
| `turn.start` | 一轮开始（一条用户消息及其触发的全部模型调用与工具调用） | `turn`、`handbook?`（这一轮注入的经验手册条目 id，按检索顺序，至多 `HANDBOOK_TOP_K` 个；没注入时不写）、`organization?`（这一轮是否用成员，`{ decision: "solo" \| "team", chosenBy: "size" \| "control" \| "default" \| "memory" \| "retry", suggested?: OrganizationName, change? }`；只在根会话、装了 `ctx.organizer` 时写，见 §工作流“按任务组队”；`retry` 只出现在旧记录里；`change` 是协调者复盘给这一轮的改动说明 `OrganizationChangeNote`，见 §组织库“协调者复盘”） |
| `user.message` | 用户消息进入会话，或注入的合成上下文，或反馈轮的提示，或对话与讨论串之间的消息 | `turn`、`content`、`source: "user" \| "inject" \| "feedback" \| "thread"`、`materials?` |
| `assistant.message` | 一次模型调用的流结束（含被取消的流） | `turn`、`step`、`requestId`、`content`、`toolCalls?`、`usage`、`finishReason`、`interrupted?`、`providerContent?`、`refusal?` |
| `tool.result` | 一次工具调用返回 | `turn`、`step`、`toolCallId`、`name`、`content`、`isError`、`error?`、`meta?`、`durationMs` |
| `turn.end` | 一轮结束 | `turn`、`reason` |
| `checkpoint` | 见“checkpoint” | `coversSeq`、`state` |
| `error` | 不属于某条 `turn.end` / `tool.result` 的失败（如账本写失败、恢复时的截断、费用上限） | `turn?`、`error`、`fatal` |
| `approval.request` | 一次工具调用需要审批 | `turn`、`request: ApprovalRequest` |
| `approval.decision` | 审批得到应答（含超时、取消、非 TTY 拒绝） | `turn`、`decision: ApprovalDecision` |
| `approval.grant` | 用户选择 `session` 范围放行，紧跟对应的 `approval.decision` | `grant: { tool, pattern?, grantedAt }` |
| `material.added` | 宿主把一份资料复制进 `materials/` 后 | `turn?`、`material: MaterialRef` |
| `turn.rewind` | 宿主经 `sessions.rewind` 把文件退回某一轮开始前之后，两轮之间 | `toTurn`、`restored`（写回原内容的文件）、`deleted`（删掉的文件）、`cause?`（只出现在旧记录里：`retry`、`retry-undo`；不带是用户撤回文件改动）；不带 `turn`。写下后模型的下一次请求带一条 `<context>` 包裹的简短说明，写明哪些文件被撤回，并提醒先读文件再下结论；带 `cause` 的记录不进时间线 |
| `session.mode` | 会话中途换模式：宿主切换（`sessions.setMode`），或用户经 `exit_plan` 批准计划 | `sandboxMode`（此后的执行模式）、`plan`（计划模式是否还开着）、`reason: "host" \| "plan-approved"`；从下一次工具调用起生效 |
| `deliverable.presented` | `present` 生成一个成果版本后，在该调用的 `tool.result` 之前 | `turn`、`step`、`toolCallId`、`deliverable: DeliverableVersionRef` |
| `turn.files` | 每轮 `turn.end` 之前（装了文件追踪时，空列表也写） | `turn`、`changes: FileChange[]`、`omitted?` |
| `feedback` | 反馈轮的 `turn.start` 之后 | `turn`、`feedback: FeedbackEntry` |
| `goal.set` | 宿主设定持久目标 | `turn?`、`goal: Goal` |
| `goal.update` | 宿主更新目标状态或文本 | `turn?`、`goalId`、`status`、`text?`、`note?` |
| `session.title` | 用户给对话改名（`sessions.rename`）；桌面应用在第一轮正常结束后、对话还没有标题时，用执行模型一次短请求（`purpose: auxiliary`，带 `sessionId`，计入账本与 `perProject`）生成的标题 | `turn?`、`title`（非空，宿主已去掉首尾空白） |
| `compaction` | 压缩成功后、使用压缩历史的那次模型请求之前 | `turn`、`step`、`summary`、`keepMessages`、`compactedMessages`、`requestId`、`usage`、`trigger: { inputTokens, threshold }` |
| `fork.seed` | fork 子会话创建后，必为 `seq: 2` | `fromSessionId`、`throughSeq`、`messages` |
| `subagent.start` | 父会话里一次成员运行开始 | `turn`、`toolCallId?`、`childSessionId`、`childTurn`、`name`、`executionForm`、`mode?`、`preset?`、`workflowId?`、`task`（≤500 字符）、`materialIds?`、`queuedMs?`（协调者：开始前排队等空位的毫秒数，有等待时写） |
| `subagent.end` | 父会话里一次成员运行结束（恢复时补 `interrupted`） | `turn`、`childSessionId`、`childTurn`、`result: MemberResult` |
| `team.member` | 旧会话：Lead 会话里队友加入或状态变化（不再写入） | `turn?`、`member: TeamMember` |
| `team.task` | 旧会话：Lead 会话里任务板新建或更新一项（不再写入） | `turn?`、`task: TeamTask` |
| `team.message` | 旧会话：Lead 会话里一条邮箱消息排队或投递（不再写入） | `turn?`、`message: TeamMessage` |
| `workflow.start` | 父会话里 `workflow` 调用开始 | `turn`、`toolCallId`、`workflowId`、`kind: "script" \| "graph"`、`architecture?`、`title?` |
| `workflow.phase` | 脚本调用 `phase(name)` | `turn`、`workflowId`、`phase` |
| `workflow.end` | 工作流结束（恢复时补 `interrupted`） | `turn`、`workflowId`、`status`、`members`、`error?` |
| `organization` | `organize` 调用开始运行一个分工，在它的 `workflow.start` 之前 | `turn`、`toolCallId`、`organizationId`、`name: OrganizationName`、`roles: { name, kind, after }[]`、`workflowId`、`replaces?`（被换掉的上一个分工）、`reason?`（换分工的原因）、`change?`（这一轮第一个分工上的 `OrganizationChangeNote`：`{ status: trying \| kept \| reverted, action, target, next? }`，小组卡据此显示一行） |
| `capability.version` | 会话的能力版本变化：恢复时记录的版本缺失或校验失败（`unavailable`），或打开时装载失败（`load-failure`） | `turn?`、`version`、`previous`、`reason`、`detail?` |
| `capability.draft` | `capability_draft` 改动草稿区的一个组件后，在该调用的 `tool.result` 之前 | `turn`、`step`、`toolCallId`、`component: { kind, name }`、`files: CapabilityFile[]`、`revision` |
| `capability.try` | `capability_try` 把草稿组件装进本会话后 | `turn`、`step`、`toolCallId`、`component`、`revision`、`tools?` |
| `capability.propose` | 宿主接受 `capability_propose` 提出的候选后 | `turn`、`step`、`toolCallId`、`candidateId`、`proofs: ComponentUseProof[]` |

字段细则：

- `assistant.message.toolCalls[]`：`{ id, name, arguments }`，`arguments` 是模型产出的原始 JSON 文本，不在此处解析。
- `assistant.message.usage`：`LLMUsage`，六个字段 `inputTokens / outputTokens / totalTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens` 每个都是非负整数或字符串 `"unknown"`；provider 没报用量时全为 `"unknown"`，不写 0。`inputTokens` 只是未命中缓存的输入，计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`；`totalTokens` = 输入 + 输出 + 缓存读 + 缓存写。`cacheWriteTokens` 是后加的字段，schema 中为可选：没有它的旧记录读出时按 `"unknown"` 补上，新写入的记录总是带它。
- `assistant.message.finishReason`：`stop | tool-calls | max-tokens | aborted | refusal | pause | error`。`refusal` 时附 `refusal: { category?, explanation? }`，该回复的工具调用不执行。`pause`对应 Claude 的 `stop_reason: "pause_turn"`：回复照常记录（含 `providerContent`），loop 把它原样带回、再发一次请求让模型接着做，同一轮内的续跑次数有上限，超过时以可读错误结束轮次；账本 `llm.request.end` 的 `status` 为 `ok`、`finishReason` 为 `pause`。
- `assistant.message.providerContent`：provider 返回的内容块原样（JSON），用于回放时保留 thinking 块；provider 没给则不写。
- `assistant.message.interrupted: true`：该轮在流中被取消，`content` 是已流出的前缀，`toolCalls` 不写（未派发的调用不进入历史）。
- `tool.result.error`：`ErrorInfo = { name, code, message, details? }`，仅当 `isError` 为真；`meta` 是工具私有的 JSON 值（如 diff），原样持久化。
- `max-tokens` 且回复含工具调用时：工具调用记录在案但不执行，轮次以 `{ kind: "max-tokens" }` 结束；下一次请求由历史修复以合成的错误结果答复这些调用。
- `turn.end.reason`：`{ kind: "completed" }`、`{ kind: "cancelled", cause: "user" | "timeout" | "shutdown" | "cost-cap" | "parent" | "step-limit" }`（`parent`：父会话的轮次取消或结束，成员随之取消；`step-limit`：这一轮用完了模型调用次数上限，历史完整，下一条用户消息接着做）、`{ kind: "error", error: ErrorInfo }`、`{ kind: "max-tokens" }`、`{ kind: "interrupted" }`。最后一种只由恢复过程写出，用来关闭上一个进程没来得及关闭的轮次。
- `error.fatal`：为真表示会话不能继续；恢复时遇到最后一条是 fatal 的 `error`，`resume` 仍返回状态，由调用方决定是否继续。
- `user.message.source`：`user` 是用户输入；`inject` 是合成上下文（资料引用、提供者注入），界面不显示；`feedback` 是反馈轮的提示，正文为 `renderFeedbackPrompt(feedback)`；`thread` 是对话与讨论串之间的消息：在协调者里是讨论串一轮结束时叫醒它的短讯（`threadWakeNote`），在讨论串里是协调者交代的任务或消息。`thread` 消息不是用户原话，压缩时不按用户原话保留，也不用来学项目规则。`materials` 是本条消息引用的资料 ID（仅 `user` / `feedback` 消息），界面据此显示资料标签。
- 记录里的路径一律是项目相对路径、`/` 分隔（`MaterialRef.path`、`DeliverableFile.path`、`FileChange.path`），schema 拒绝含 `\` 的路径；两平台写出的记录可以直接比较。SHA-256 一律小写十六进制 64 位。
- `turn.files.changes`：按 `path` 排序，`change` 为 `added | modified | deleted`；最多 1000 条（`TURN_FILES_LIMIT`），超出部分只计数在 `omitted`。比较范围是项目根下除 `.nexgent/`、`node_modules/`、`.git/` 与 `.gitignore` 忽略的路径外的全部文件；同一路径先增后删不列出。不在轮首全量扫描：文件工具报告的路径直接记入；本轮跑过 `execute` 效果的工具（shell、代码执行）时，轮末做一次按 `.gitignore` 剪枝、只看大小与修改时间的扫描，找出它们的改动（删除以最近一次快照索引为基线，没有基线时不报告 shell 造成的删除）。同一项目里几个对话同时进行时，文件工具报告的路径只归报告它的对话；没人报告的 shell 改动归这段时间里跑过 shell 的对话。
- `goal.update.goalId` 必须是当前目标的 ID；`compaction.keepMessages` 不能超过当时的消息数，且保留段不能以工具结果（`tool`）开始（也可以以当前轮的 `assistant` 回复开始）。这两条单条 schema 表达不了，`SessionStore.append` 在写入前用投影检查，不合格的记录抛 `session/invalid-record`、不落盘。

一轮的记录顺序固定为：`turn.start` → `user.message` → （`assistant.message` → `tool.result`×n）×steps → `turn.end`。需要审批的调用在其 `tool.result` 之前插入 `approval.request` → `approval.decision`（→ `approval.grant`）。`ApprovalRequest` / `ApprovalDecision` 的字段见 `permissions.md`。`step` 从 1 起，在轮内递增。

完整的一轮还可以包含（详见 `agent-hooks.md` §一轮的顺序）：

```text
turn.start → [feedback] → user.message(inject)* → user.message(user|feedback)
  → ( [compaction] → assistant.message → ( [approval.*] → [deliverable.presented] → tool.result )* )*
  → turn.files → turn.end → [checkpoint]
```

`material.added`、`goal.set`、`goal.update`、`session.title` 由宿主写，可以出现在两轮之间，也可以出现在一轮之中（此时带 `turn`）。`session.mode` 不带 `turn`：宿主切换可以在两轮之间或一轮之中，`exit_plan` 批准时在该调用的 `tool.result` 之前。

记录归属：`fork.seed` 只由 kernel 在建子会话时写；`subagent.start`、`workflow.start` 由发起它们的工具经 `ToolContext.appendRecord` 写在该调用的 `tool.result` 之前；`subagent.end`、`workflow.phase`、`workflow.end` 既可由工具写，也可由协作包以宿主身份写（恢复时的补记发生在工具调用之外），宿主写时带当时的 `turn`。白名单见契约 `ToolRecordType` / `HostRecordType`（`team.*` 仍在白名单里，只为读旧会话）。

`capability.draft` / `try` / `propose` 只由对应工具经 `ToolContext.appendRecord` 写（`ToolRecordType`）；`capability.version` 由宿主写（`HostRecordType`）。这四种记录都不改变投影出的消息；投影把 `session.start.capabilityVersion` 与最新一条 `capability.version.version` 放进 `SessionMetadata.capabilityVersion`。`capabilityVersion` 缺省的会话按 `baseline` 理解。

### 示例

一次“写文件”任务的完整会话（为可读省略了部分 `ts`）：

```jsonl
{"type":"session.start","seq":1,"ts":"2026-10-07T08:00:00.000Z","sessionId":"6f1c…","version":1,"projectRoot":"/home/u/proj","model":"claude-sonnet-5-5","sandboxMode":"workspace-write"}
{"type":"turn.start","seq":2,"ts":"…","sessionId":"6f1c…","turn":1}
{"type":"user.message","seq":3,"ts":"…","sessionId":"6f1c…","turn":1,"content":"把 README 第一行改成 Hello","source":"user"}
{"type":"assistant.message","seq":4,"ts":"…","sessionId":"6f1c…","turn":1,"step":1,"requestId":"a0b1…","content":"","toolCalls":[{"id":"call_1","name":"str_replace","arguments":"{\"path\":\"README.md\",\"old\":\"# Hi\",\"new\":\"# Hello\"}"}],"usage":{"inputTokens":812,"outputTokens":37,"totalTokens":849,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0},"finishReason":"tool-calls"}
{"type":"tool.result","seq":5,"ts":"…","sessionId":"6f1c…","turn":1,"step":1,"toolCallId":"call_1","name":"str_replace","content":"replaced 1 occurrence","isError":false,"durationMs":4}
{"type":"assistant.message","seq":6,"ts":"…","sessionId":"6f1c…","turn":1,"step":2,"requestId":"c2d3…","content":"已改好。","usage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","cacheWriteTokens":"unknown","reasoningTokens":"unknown"},"finishReason":"stop"}
{"type":"turn.end","seq":7,"ts":"…","sessionId":"6f1c…","turn":1,"reason":{"kind":"completed"}}
{"type":"checkpoint","seq":8,"ts":"…","sessionId":"6f1c…","coversSeq":7,"state":{"sessionId":"6f1c…","version":1,"messages":[{"role":"user","content":"把 README 第一行改成 Hello"},{"role":"assistant","content":"","toolCalls":[{"id":"call_1","name":"str_replace","arguments":"{…}"}]},{"role":"tool","toolCallId":"call_1","name":"str_replace","content":"replaced 1 occurrence","isError":false},{"role":"assistant","content":"已改好。"}],"metadata":{"createdAt":"2026-10-07T08:00:00.000Z","projectRoot":"/home/u/proj","model":"claude-sonnet-5-5","sandboxMode":"workspace-write","grants":[],"lastTurn":1,"totalUsage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","cacheWriteTokens":"unknown","reasoningTokens":"unknown"},"lastSeq":7,"lastUsage":{"inputTokens":812,"outputTokens":37,"totalTokens":849,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0}}}}
```

被取消的一轮：

```jsonl
{"type":"turn.start","seq":9,"ts":"…","sessionId":"6f1c…","turn":2}
{"type":"user.message","seq":10,"ts":"…","sessionId":"6f1c…","turn":2,"content":"再写一段介绍","source":"user"}
{"type":"assistant.message","seq":11,"ts":"…","sessionId":"6f1c…","turn":2,"step":1,"requestId":"e4f5…","content":"Nexgent 是","usage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","cacheWriteTokens":"unknown","reasoningTokens":"unknown"},"finishReason":"aborted","interrupted":true}
{"type":"turn.end","seq":12,"ts":"…","sessionId":"6f1c…","turn":2,"reason":{"kind":"cancelled","cause":"user"}}
```

### 追加与截断规则

写入：

1. 一条记录 = `JSON.stringify(record) + "\n"`，一次 `write` 调用写入整行；不拆行写。
2. `turn.end` 与 `checkpoint` 之后 `fsync`；其他记录由实现决定是否每条 `fsync`（默认每条）。
3. 写入前校验：值是 JSON 安全的（`isJsonValue`）、`type` 是已知类型、`seq` 等于文件里出现过的最大 `seq` +1（含被跳过、但仍在合理范围内的行，见下）。校验失败抛 `session/invalid-record`，不写。

一行**有效**当且仅当同时满足：

- 以 `\n` 结束（文件最后一行没有 `\n` 即无效——这是 `kill -9` 留下半行的典型形态）；
- 能解析为 JSON 对象；
- `type` 是已知类型且专有字段通过 schema；
- `seq` 落在 `(上一有效行的 seq, 上一有效行的 seq + 1 + 其后被跳过的行数]` 之内（第一行必须是 `seq: 1` 的 `session.start`）；
- `sessionId` 与文件所属会话一致。

恢复（`readAll`）：

1. 从文件头顺序读，逐行校验；
2. 以 `\n` 结束、但无效的行（坏行、更新版本写的未知记录类型）**跳过并报告**，继续往下读：结果带 `skipped = [{ line, byteOffset, reason }]`（`line` 为 1 起的行号，`byteOffset` 为该行起始字节）。跳过的行留在文件里，读取方从不删除或改写它；
3. 只有最后一行没有 `\n`（被撕裂的尾行）才是 `truncation = { line, byteOffset, reason }`；
4. 恢复不崩溃：任何损坏的文件都返回一个（可能为空的）记录列表加跳过与截断信息；只有 `session.start` 都读不出时才抛 `session/corrupt`。

截断：持锁的写入者在下一次 `append` 之前把文件截到 `truncation.byteOffset`（只去掉撕裂的尾行），然后先追加一条 `error` 记录（`code: "session/corrupt"`，`fatal: false`，`message` 写明丢弃的行号与原因），再追加调用方的记录。新记录的 `seq` 是文件里出现过的最大 `seq` + 1，所以不会与被跳过的行重号。

### checkpoint

- **触发**：写 `turn.end` 时，若自上一个 checkpoint（或文件头）起已写入 ≥ N 条记录（默认 N=50，可配置），紧接着写一条 `checkpoint`；会话存储关闭时若有新记录也写一条。`turn.end` 与它的 `checkpoint` 之间不会插入其他记录。
- **内容**：`coversSeq` 是它前一条记录的 `seq`（即自身 `seq` − 1）；`state` 是把 `seq ≤ coversSeq` 的全部记录投影得到的 `SessionState`。多个 checkpoint 可以共存，最新的可用者有效。
- **增量**：checkpoint 可带 `base`（之前一个可用 checkpoint 的 `seq`）与 `keep`（保留 base 完整状态的前几条消息），此时 `state.messages` 只含其后的消息，`state.metadata` 总是完整的；完整消息 = base 的完整消息前 `keep` 条 + `state.messages`。下列情况写完整 checkpoint：会话的第一个、紧跟 `compaction` 或 `fork.seed` 之后、base 为空、或增量链已达 `MAX_CHECKPOINT_CHAIN`（256）。`base` 与 `keep` 必须同时出现，`base < coversSeq`；base 不可用（被跳过、`keep` 超过 base 的消息数）的增量 checkpoint 也不可用，恢复退到更早的可用者。实现：`@nexgent/session` 的 `resolveLatestCheckpoint`。
- **大小**：增量 checkpoint 只写新增的消息，长会话的文件不再随每个 checkpoint 复制整段历史。

### 恢复算法（`resume`）

1. `readAll`，得到有效记录与可能的截断信息。
2. 找最后一条可用的 `checkpoint`（增量的按上节还原为完整状态）；有则 `state` 为它的完整状态，起点 `seq = coversSeq`；没有则 `state` 为空状态（只有 `session.start` 给出的元数据），起点 `seq = 1`。
3. 按顺序把 `seq` 大于起点的记录投影进 `state`（投影规则见下表）；checkpoint 之前的记录不重放——这是性能测试的上限依据。
4. 若 `state.metadata.openTurn` 有值（上一个进程在轮中死亡）：持锁的调用方先为这一轮每个还没有结果的工具调用如实追加一条 `tool.result`（`isError: true`，`content: "Error: the call was interrupted before it returned a result."`，`error.code: "tool/aborted"`，`durationMs: 0`），再追加 `turn.end { kind: "interrupted" }`，然后更新状态；只读的调用方只在返回的状态里保留 `openTurn`。这样下一轮的请求里每个工具调用都有结果，不会因缺 `tool_result` 被拒。
5. 返回 `SessionState`：`messages` 是 LLM 请求形式的历史（`user / assistant / tool` 三种角色；系统提示不存储，由 kernel 每次重新组装），`metadata` 见下。

投影规则：

| 记录 | 对 `messages` | 对 `metadata` |
| --- | --- | --- |
| `session.start` | 无 | `createdAt`、`projectRoot`、`model`、`sandboxMode`、`title`；`plan = true`（仅当记录的 `plan` 为 `true`）；`lastTurn = 0`；`grants = []`；`totalUsage` 置为全 0（`ZERO_USAGE`，加法单位元） |
| `turn.start` | 无 | `lastTurn = turn`，`openTurn = turn` |
| `user.message` | 追加 `{ role: "user", content }` | 无 |
| `assistant.message` | 追加 `{ role: "assistant", content, toolCalls?, providerContent? }`；`interrupted` 且 `content` 为空时不追加 | `totalUsage = addUsage(totalUsage, usage)`（任一字段 `"unknown"` 则和为 `"unknown"`）；`usage` 的计费输入（`inputTokens + cacheReadTokens + cacheWriteTokens`）已知时 `lastUsage = usage` |
| `tool.result` | 追加 `{ role: "tool", toolCallId, name, content, isError }` | 无 |
| `turn.end` | 无 | 清除 `openTurn` |
| `checkpoint` | 从头重放时整体替换 `state` | 同左 |
| `error` | 无 | 无 |
| `goal.set` | 无 | `goal = record.goal`（替换旧目标） |
| `goal.update` | 无 | `goal.status = status`；给了 `text` 则替换；给了 `note` 则替换；`goal.updatedAt = record.ts` |
| `session.title` | 无 | `title = record.title`（覆盖 `session.start` 的标题） |
| `turn.rewind` | 无 | 历史与元数据不变；投影里带上同一条给模型的说明，恢复后下一次请求仍会收到 |
| `session.mode` | 无 | `sandboxMode = record.sandboxMode`；`plan` 为 `true` 时设 `plan = true`，否则删除 `plan` |
| `compaction` | `messages = [{ role: "user", content: renderCompactionSummary(summary) }, ...messages 的最后 keepMessages 条]` | `lastCompactionSeq = seq`；删除 `lastUsage` |
| `material.added`、`deliverable.presented`、`turn.files`、`feedback` | 无 | 无 |
| 任意记录 | — | `lastSeq = seq` |

`SessionMetadata` 字段：`createdAt`、`projectRoot`、`model`、`sandboxMode`、`grants`、`title?`、`lastTurn`、`openTurn?`、`totalUsage`、`lastSeq`，以及可选的 `goal?`、`lastCompactionSeq?`、`plan?`（计划模式还开着）、`lastUsage?`（最近一次压缩之后、计费输入已知的最后一条回复的用量：重开会话时压缩触发从它起算，没有它时按整段历史估计）、`parentSessionId?`、`member?`、`capabilityVersion?`、`thread?`。较早写出的 checkpoint 没有这些可选字段时，读出时视为未设置。

### 并发写保护

- 锁文件 `sessions/<sessionId>/.lock`，内容为 JSON：`{ "pid": 12345, "ts": "2026-10-07T08:00:00.000Z", "host": "my-laptop", "startedAt": "2026-10-07T07:59:58.000Z" }`。`startedAt`（可选）是持锁进程的启动时间：Linux 读 `/proc`，macOS 用 `ps -o lstart=`，Windows 不写。
- 取锁用独占创建（`open` 带 `wx`）；创建失败时读出现有内容：`host` 相同且 `pid` 不存活，或 `pid` 存活但它的启动时间与 `startedAt` 相差超过 5 秒（pid 已被别的进程复用），视为陈旧锁，覆盖接管；否则抛 `session/locked`（`details` 带现有锁的 `pid`、`ts`）。
- 锁在写入进程的整个生命周期内持有，`release` 删除文件；进程异常退出留下的锁由上述陈旧检测处理。
- `append` 要求调用方持有本进程取得的锁，否则抛 `session/locked`；`readAll` / `latestCheckpoint` / 只读的 `resume` 不需要锁。
- 两个进程对同一会话 `create` / `lock`，恰有一个成功；这是 `@nexgent/session` 的必测项。

### 会话列表索引

`sessions/<sessionId>/summary.json` 是对话列表用的派生缓存，写入方关闭会话（或写完一轮）时以临时文件加改名整体替换：`{ "version": 1, "source": { "size", "mtimeMs", "lastSeq" }, "entry": { "sessionId", "title?", "firstMessage?", "createdAt", "updatedAt", "lastTurn", "interrupted", "goal?", "parentSessionId?", "member?", "thread?", "improvement" } }`。读取方（`readSessionSummary`）在 `session.jsonl` 的大小与修改时间都等于 `source` 时直接用 `entry`，否则扫描文件重算并顺手重写缓存。缓存坏了或缺了都只是退回扫描，不影响会话本身；迁移与复制可以带上它，也可以丢掉。

## 账本记录

文件：`.nexgent/ledgers/<yyyy-mm>/requests.jsonl`，月份取记录 `ts` 的 UTC 年月（`ledgerMonth`）。各类记录都追加到这一个文件。类型镜像：`packages/kernel/src/contracts/ledger.ts`。

写入：一条记录一行，`fsync` 后返回；写失败抛 `ledger/write-failed` 并使 `Ledger.writeFailures` 加一，**不改变**它所记录的那次请求的结果。`writeFailures` 非零意味着账本不完整，验收摘要必须报告它。

### 公共字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | 记录类型 |
| `ts` | string | 事件时刻，ISO-8601 UTC；由 `Ledger.append` 赋值 |
| `sessionId` | string? | 所属会话；辅助调用可无 |
| `capabilityVersion` | string? | 会话所用的能力版本，`baseline` 或能力包内容哈希（小写十六进制 SHA-256） |
| `trialId` | string? | 门控试验的运行与评审记录所属的试验；普通任务没有 |
| `arm` | `"candidate" \| "baseline"`? | 试验运行的臂；评审请求只带 `trialId`，不带 `arm` |
| `memberId` | string? | 发出记录的成员：根会话为 `main`，子会话为子会话 id |
| `executionForm` | `"direct" \| "delegated" \| "team" \| "workflow" \| "thread"`? | 发出记录的成员的执行形态（`team` 只出现在旧记录里） |
| `taskId` | string? | 所属任务树：根会话打开（create / resume）时生成的小写 UUID v4，成员继承 |
| `learningPhase` | `"self-eval" \| "calibrate" \| "reflect" \| "curate" \| "induce"`? | 后台学习的记录（自评、外部评审校准、反思、整理、技能归纳）上的阶段；`taskId` 写被学习的任务。这些费用只计入 `learning.budget` |

这些字段在所有记录类型上都是可选的（schema 层面）。kernel 给一个会话写出的每条 `llm.request.*`、`tool.call`、`task.outcome` 都带 `taskId`、`memberId`、`executionForm`（契约 `AgentAttribution`）和 `capabilityVersion`。门控试验的运行会话在项目的临时副本里，但它们的账本记录写进**真实项目**的账本，带 `trialId` 与 `arm`，所以费用汇总能区分试验与普通任务。旧改进作业留下的 `improvement*`、`improver*` 等字段见“旧格式（只为读旧项目）”。

### 记录类型

**`llm.request.start`** —— 一次模型请求已发出。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `requestId` | string | 与 `llm.request.end`、会话的 `assistant.message.requestId` 相关联 |
| `provider` | string | 路由键，如 `anthropic` |
| `endpoint` | string | base URL，不含凭证 |
| `model` | string | 模型 ID |
| `purpose` | `"task" \| "auxiliary"` | 任务请求或辅助请求 |
| `thinking` | `"off" \| "on"` | 是否请求了 reasoning |
| `attempt` | integer ≥ 1? | provider 重试这次请求时的第几次尝试，缺省为 1（第一次尝试不写）。每次尝试各有一对 start / end，`requestId` 相同，都算一次请求、都计费 |

**`llm.request.end`** —— 一次模型请求已结束（成功、失败、中止都写）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `requestId`、`provider`、`endpoint`、`model` | 同上 | 重复写，使一行自足 |
| `status` | `"ok" \| "error" \| "aborted" \| "unknown"` | `ok` ← 流以 `done`（stop / tool-calls / max-tokens）结束；`aborted` ← `done` 且 `finishReason: aborted`；`error` ← 流以 `error` 事件结束；`unknown` 只由读取方推断（见下） |
| `usage` | `LLMUsage` | provider 未报或请求早期失败时六个字段全为 `"unknown"`，不写 0 |
| `latencyMs` | number | 从发出到终止事件的毫秒数 |
| `httpStatus` | number? | 收到 HTTP 响应时的状态码（含 4xx / 5xx） |
| `finishReason` | string? | `ok` / `aborted` 时的结束原因 |
| `errorCode` | string? | `error` 时的错误码（`NexgentErrorCode`），**不写错误消息** |
| `attempt` | integer ≥ 1? | 与对应的 start 相同 |
| `usageEstimated` | `true`? | `usage` 是宿主估算的（provider 没报，如流中断），不是报告的；费用合计计入它并标明含估算 |

读取方以 `requestId` 加 `attempt`（缺省为 1）配对 start 与 end；重试的每次尝试都算一次请求；只有 start 没有 end 的请求按 `status: "unknown"` 计（进程在流中死亡），用量按全 `"unknown"` 计。

**`tool.call`** —— 一次工具调用执行（或被拒绝）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string | 必填 |
| `turn` | number | 轮次 |
| `callId` | string | 模型给出的调用 ID |
| `name` | string | 工具名 |
| `effects` | `("read" \| "write" \| "execute" \| "network")[]` | 工具声明的效果 |
| `approval` | `ToolCallApproval` | `{ required, decision: "allow" \| "deny" \| "timeout" \| "cancel" \| "auto", scope?, requestId? }`；`auto` 表示无需提问（工具 `never` 或命中已有授权） |
| `isError` | boolean | 调用是否失败（被拒也算失败） |
| `durationMs` | number | 处理器耗时；被拒为 0 |

没有参数和输出的字段。

**`task.outcome`** —— 一个任务结束；`nexgent run` 结束时由 `apps/cli` 写一条。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string | 必填 |
| `status` | `"completed" \| "cancelled" \| "failed"` | 任务结局 |
| `totalUsage` | `LLMUsage` | 任务内全部请求用量之和（`addUsage` 语义） |
| `requestCount` | number | 模型请求次数（含失败） |
| `toolCallCount` | number | 工具调用次数 |
| `turns` | number | 跨越的轮数 |
| `checks` | `TaskCheck[]`? | 宿主做的确定性检查 `{ name, passed, detail?, target? }`；写 `file-exists`、`parses`、`test-command` 三种，`target` 是检查规格的 `id`（路径与命令只在 `snapshots/checks/` 里）；步骤 1 可无 |
| `toolsUsed` | string[] | 实际调用过的工具名，去重；用它证明组件被实际调用 |
| `formsUsed` | `ExecutionForm[]`? | 只在根会话的记录上：整棵任务树实际用到的形态，去重，按 `direct, delegated, team, workflow, thread` 排序 |
| `componentsUsed` | `ComponentUsage[]`? | 本会话实际用到的能力组件 `{ kind, name, version, calls, errors }`，`version` 为能力版本或 `draft`（本会话试用的草稿） |
| `memberCosts` | `MemberCost[]`? | 只在根会话的记录上：每个成员的 `{ memberId, name, executionForm, usage, requestCount, toolCallCount }`；根会话自己的用量仍在 `totalUsage` |
| `organization` | `OrganizationUse`? | 只在根会话的记录上：`{ decision, chosenBy, name?, roles?, reorganizations, corrections }`，`name` / `roles` 是最后一个分工的名字与角色数，`reorganizations` 是本任务换分工的次数，`corrections` 是用户在运行中插话的次数，另有 `change?`（协调者复盘给这一轮的改动说明） |

每个成员会话关闭时也写一条自己的 `task.outcome`（`memberId` 为成员会话 id），各条只计本会话的请求与工具调用；整棵树的合计是同一 `taskId` 下全部记录之和，根会话那条不重复计入成员的用量。

**`capability.decision`** —— 写出一个能力决定（门控结论、批准、回滚）之后。决定文件（`capabilities/decisions/<id>.json`）存证据，这一行让它出现在相关费用旁边。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `decisionId` | string | 决定文件的 id |
| `outcome` | `"adopted" \| "rejected" \| "awaiting-approval" \| "rolled-back"` | 结论 |
| `reason` | `DecisionReason` | 见“候选与门控” |
| `trigger` | `"gate" \| "approval" \| "load-failure" \| "usage-regression" \| "manual"` | 起因 |
| `fromVersion`、`toVersion` | 能力版本 | 决定前后采用中的版本；拒绝与待批准时二者相等 |
| `candidateId` | string? | 涉及的候选 |
| `revision` | number? | 为它写出的采用历史序号 |

**`cost.warning`** —— 花费达到某个上限的 80%（`level: "warning"`，每个上限实例一次）或达到上限（`level: "reached"`，在本轮以 `cost-cap` 取消之前写）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `scope` | `"perTask" \| "perConversation" \| "perProject"` | 哪个上限 |
| `level` | `"warning" \| "reached"` | 80% 提醒或已达到 |
| `limit` | `"maxUsd" \| "maxTokens" \| "maxRequests"` | 越线的字段；同时越线时按此顺序取第一个 |
| `used` | number | 到此为止的花费，单位同 `limit`（美元、token、次数） |
| `cap` | number | 该字段的值 |
| `estimated` | boolean | `used` 是否含估算用量 |

**`check.retry`** —— 一次自动重试前后的检查结果，成对记下：`before` 是让模型回去改的那次检查，`after` 是模型再次停下后同一任务的检查。只记录，不在这里判断好坏；学习与经验手册的证据可以读它。和 `task.outcome.checks` 一样，每项检查用 `target`（规格 id）指代，不写命令原文与文件内容。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string | 根会话 |
| `taskId` | string | 任务 |
| `turn` | integer ≥ 1 | 哪一轮 |
| `retry` | integer ≥ 1 | 第几次重试 |
| `max` | integer ≥ 1 | 当时的 `checkRetries` |
| `before` | `TaskCheck[]` | 重试前的检查 |
| `after` | `TaskCheck[]` | 重试后的检查 |

### 示例

```jsonl
{"type":"llm.request.start","ts":"2026-10-07T08:00:01.000Z","sessionId":"6f1c…","requestId":"a0b1…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","purpose":"task","thinking":"off"}
{"type":"llm.request.end","ts":"2026-10-07T08:00:03.200Z","sessionId":"6f1c…","requestId":"a0b1…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","status":"ok","usage":{"inputTokens":812,"outputTokens":37,"totalTokens":849,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0},"latencyMs":2200,"httpStatus":200,"finishReason":"tool-calls"}
{"type":"tool.call","ts":"2026-10-07T08:00:03.210Z","sessionId":"6f1c…","turn":1,"callId":"call_1","name":"str_replace","effects":["write"],"approval":{"required":false,"decision":"auto"},"isError":false,"durationMs":4}
{"type":"llm.request.start","ts":"2026-10-07T08:00:03.300Z","sessionId":"6f1c…","requestId":"c2d3…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","purpose":"task","thinking":"off"}
{"type":"llm.request.end","ts":"2026-10-07T08:00:04.100Z","sessionId":"6f1c…","requestId":"c2d3…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","status":"error","usage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","cacheWriteTokens":"unknown","reasoningTokens":"unknown"},"latencyMs":800,"httpStatus":503,"errorCode":"llm/request-failed"}
{"type":"task.outcome","ts":"2026-10-07T08:00:04.200Z","sessionId":"6f1c…","status":"failed","totalUsage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","cacheWriteTokens":"unknown","reasoningTokens":"unknown"},"requestCount":2,"toolCallCount":1,"turns":1,"toolsUsed":["str_replace"]}
{"type":"capability.decision","ts":"2026-10-07T09:00:00.000Z","decisionId":"0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e","outcome":"adopted","reason":"quality-up","trigger":"gate","fromVersion":"baseline","toVersion":"3f2a9c0e5b7d14a8c6e2f9b0d3a5c7e1f4b8a2d6c0e9f3b5a7d1c4e8f2b6a0d9","candidateId":"5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b","revision":1}
{"type":"llm.request.start","ts":"2026-10-16T08:00:01.000Z","sessionId":"c3d4…","requestId":"a8b9…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","purpose":"auxiliary","thinking":"on","taskId":"5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d","learningPhase":"self-eval","attempt":2}
{"type":"check.retry","ts":"2026-10-19T08:00:00.000Z","sessionId":"c3d4…","taskId":"5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d","turn":1,"retry":1,"max":2,"before":[{"name":"test-command","passed":false,"detail":"the project check command, exit code 1","target":"check-1"}],"after":[{"name":"test-command","passed":true,"detail":"the project check command, exit code 0","target":"check-1"}]}
{"type":"cost.warning","ts":"2026-10-16T08:10:00.000Z","sessionId":"c3d4…","taskId":"5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d","scope":"perTask","level":"warning","limit":"maxUsd","used":1.62,"cap":2,"estimated":false}
```

### 必产生记录的失败路径

`@nexgent/llm` 的完成定义要求下列每种情况各产生一对 start / end：断网（`status: error`，无 `httpStatus`）、连接或流空闲超时（`error`，`errorCode: llm/timeout`）、HTTP 4xx / 5xx（`error`，带 `httpStatus`）、调用方中止（`aborted`）。用量字段在这些情况下全为 `"unknown"`。

## `CapabilityBundle` 清单

能力包是一组组件的完整集合（不是增量），按内容寻址：相同内容只有一个版本。能力功能（门控与采用）默认关闭、界面不显示，格式保留，已有数据照常读出。类型镜像 `packages/kernel/src/contracts/capabilities.ts`；schema `packages/session/schema/capabilities.v1.schema.json`。

**版本。** 能力版本是字符串 `baseline`（没有任何组件）或能力包内容哈希：`canonicalManifestText(manifest)` 的 UTF-8 SHA-256，小写十六进制 64 位。`canonicalManifestText` 先 `normalizeManifest`（组件按种类顺序再按名字排序，文件按路径排序），再写成规范 JSON（对象键按 UTF-16 码元排序，无空白）。

**目录。** `.nexgent/capabilities/<version>/`：

```text
<version>/
├── manifest.json
├── functions/<name>/functions.json + 模块文件
├── plugins/<name>/plugin.json + 模块文件
├── skills/<name>/SKILL.md + 附带文件
├── context/<name>/policy.json
├── presets/<name>/preset.json
├── teams/<name>/team.json
└── architectures/<name>/architecture.json
```

**`manifest.json`：** `{ formatVersion: 1, components: CapabilityComponent[] }`，只含内容，不写来源（来源在候选与决定里）。

| 字段 | 说明 |
| --- | --- |
| `components[].kind` | `function-module \| plugin \| skill \| context-policy \| preset \| team-template \| architecture` |
| `components[].name` | 匹配 `^[a-z][a-z0-9-]{0,63}$`；同种类内唯一 |
| `components[].files[]` | `{ path, sha256, bytes }`，`path` 相对组件目录、`/` 分隔、不含 `.`/`..` 段与 `\`；必须含该种类的入口文件 |

组件分四类：工具（`function-module`、`plugin`）、技能（`skill`）、上下文策略（`context-policy`，一个包至多一个）、协作方式（`preset`、`team-template`、`architecture`）。

| 种类 | 入口文件 | 内容 | 生效方式 |
| --- | --- | --- | --- |
| `function-module` | `functions.json` | `{ formatVersion, name, description, entry?, functions[] }`，每个函数 `{ name, description, inputSchema, effects }`，`effects` 取 `read \| write \| network` | 每个函数成为模型工具 `cap_<module>_<function>`（≤64 字符；是工具名通用规则 `^[a-z][a-z0-9_]*$` 之外唯一允许的形式，kernel `isValidToolName`），在与 `run_code` 同类的隔离 Node 进程里执行 |
| `plugin` | `plugin.json` | `{ formatVersion, name, description, entry?, permissions, tools? }` | 宿主进程内装载的 Nexgent 插件；试用与采用各需一次审批 |
| `skill` | `SKILL.md` | 与项目技能同格式（`agent-hooks.md` §技能） | 加入技能列表 |
| `context-policy` | `policy.json` | 白名单字段 `formatVersion, name, description, instructions?, personaSuffix?, compaction?` | `instructions` 作为系统提示的 `# Learned practices` 段；`personaSuffix` 接在人设尾段后；`compaction` 覆盖压缩阈值（10 000–1 000 000）与保留轮数（1–10） |
| `preset` | `preset.json` | `PresetFile`（见“预设”） | 与项目预设同用；同名时项目预设优先 |
| `team-template` | `team.json` | `{ formatVersion, name, description, members[] }`，成员 `{ name, task, preset?, persona? }`，1–8 个、不得叫 `lead` | 作为 `Team templates` 一节进系统提示，模型据此用 `organize` 按名字起成员 |
| `architecture` | `architecture.json` | `ArchitectureFile`（见“架构图存储”） | 供 `workflow` 按名引用 |

`context-policy` 的 schema 是封闭的：`approvals`、`costCaps`、`sandboxMode`、`capabilities` 等权限与门控字段在任何组件里都没有位置（H13）。

**上限**（`CAPABILITY_LIMITS`）：每包 64 个组件，每组件 64 个文件，单文件 1 MiB，每包合计 16 MiB，每模块 16 个函数，`instructions` 16 384 字节，`personaSuffix` 4096 字节。

**写入与装载。** 能力包目录先在临时名下写全，校验每个文件的哈希与清单一致后改名发布；目标已存在则读回校验。装载时再校验一次；任何文件缺失或哈希不符，该版本不可用（见“采用历史”的回滚规则）。`assertCapabilityManifest` 检查结构，哈希比对是装载方的事。

## 采用历史

`.nexgent/capabilities/activation/<n>.json` 是一条修订链，链尾就是采用中的版本；没有任何文件时是 `baseline`。

| 字段 | 说明 |
| --- | --- |
| `format` | `1` |
| `revision` | 1、2、…，等于文件基名 |
| `previous` | 上一个修订文件**原始字节**的 SHA-256；第 1 个为 `null` |
| `from`、`version` | 修订前后的能力版本，二者不同 |
| `type` | `adopt \| rollback` |
| `trigger` | `gate \| approval \| load-failure \| usage-regression \| manual` |
| `decisionId` | 支撑这次修订的决定 |
| `committedAt` | ISO-8601 UTC |

读取：从 1 起顺序读，每个文件用 `isNextRevision` 检查它能接在当前状态后（序号、`previous` 摘要、`from`），断链或损坏时停在最后一个有效修订并报告，不猜。写入：写临时文件，再以 `link` 独占发布为 `<n+1>.json`（目标已存在说明有并发写入者，读回后重试或放弃），文件一经写出不改。项目内同时只有一个修订写入者（门控进程与回滚都经同一个函数）。

会话打开时读一次链尾，把版本写进 `session.start.capabilityVersion`，整个会话用这一个版本，运行中的采用不影响已打开的会话。恢复时用记录的版本；它缺失或校验失败时改用当前链尾并写 `capability.version { reason: "unavailable" }`。

## 候选与门控

**草稿。** `capability_draft` 把组件写进 `.nexgent/capabilities/drafts/<sessionId>/<kind-dir>/<name>/`（宿主代写，模型的文件工具看不见这里），每次改动写一条 `capability.draft`。`capability_try` 把当前草稿装进本会话，写 `capability.try`。

**候选。** `capability_propose` 把试用过的组件提成一个候选：宿主检查每个组件在试用之后至少被成功用过一次，把证据写成 `proofs`（`{ kind, name, turn, toolCallId }`），不满足就拒绝调用。接受后写 `.nexgent/capabilities/candidates/<candidateId>/candidate.json` 并复制组件文件到同目录，再写会话记录 `capability.propose`。候选的包 = 会话所用的包 + 提出的组件：同种类同名的组件被替换；一个包至多一个 `context-policy`，所以提出的上下文策略取代基础包里已有的那一个，不论名字。

`candidate.json`：`formatVersion: 1`、`id`（小写 UUID v4）、`proposedAt`、`sessionId`、`taskId`、`turn`、`base`（会话所用的版本）、`version`（`base` 加上这些组件后的能力包版本）、`components`、`proofs`、`requiresApproval`（含 `plugin` 时为真）、`summary?`（≤500 字符）、`origin?`（`"session" \| "improvement"`，缺省即 `session`）、`jobId?`（`origin` 为 `improvement` 时的旧作业 id）。

**状态。** 候选的状态由文件推出，不另存：`drafted`（只在草稿区有、尚未提出）→ `proposed`（有 `candidate.json`，没有试验）→ `trialing`（有试验，没有 `trial.end`）→ `adopted` / `rejected`（看决定）→ `rolled-back`（采用后被回滚）。旧数据里还有 `awaiting-approval`。

**试验收据。** `.nexgent/capabilities/trials/<trialId>.jsonl`，以 `wx` 创建（试验 id 不重用），每行写完 `fsync` 后才开始下一次运行；没有 `trial.end` 的试验是中断的，结论按 `unknown` 处理。

**`trials/` 下的旁路文件**：三种都是宿主的内部文件，不是数据记录，没有 schema：

| 文件 | 内容与写法 | 读者与规则 |
| --- | --- | --- |
| `<candidateId>.attempt` | 空文件，在写第一行收据之前以 `wx` 独占创建 | 存在即“这个候选试过”：一个候选最多试一次；两个门控进程同时启动时只有一个创建成功，另一个退出。门控因历史不足等待时不创建 |
| `<trialId>.lock` | 门控进程的 pid 加换行，以 `wx` 创建，试验结束（写完 `trial.end` 或决定）后删除 | 启动时的中断恢复：收据没有 `trial.end`、且没有锁或锁里的进程已不在，就是被杀的试验，写一个 `rejected`（`interrupted`）决定并删除锁 |
| `<candidateId>.log` | 门控进程的 stdout / stderr，追加写（`a`），宿主每次起进程时打开 | 只用于诊断，任何代码都不把它当数据读回；可能含路径与错误信息，不含密钥（密钥不进进程参数与环境之外的任何地方） |

| `type` | 字段 |
| --- | --- |
| `trial.start` | `trialId`、`candidateId`、`candidateVersion`、`baselineVersion`、`plan: TrialPlan`（选择集 ≥2、守护集 ≥1 个 `ReplayCaseRef { caseId, sessionId, tree, checks, throughTurn?, feedbackIds? }`，`repeats`、`costRatioCap`、`reviewer`、`budget`）。`throughTurn` 表示依次回放第 1 至 `throughTurn` 轮的用户消息（缺省只回放第 1 轮）；`feedbackIds` 只在旧改进作业的用例上有 |
| `trial.run` | `set: selection \| guard`、`caseId`、`arm: candidate \| baseline`、`repeat`、`status: pass \| fail \| unknown`、`reason?`（`unknown` 的原因：`not-run \| cancelled \| error \| timeout \| budget \| interrupted`）、`checks: TaskCheck[]`、`cost`、`durationMs` |
| `trial.review` | `set`、`caseId`、`repeat`、`preference: candidate \| baseline \| tie \| unknown`、`reason`（≤2000 字符）、`model`、`cost`。一条回执是一对运行的两次评审：候选在 A、候选在 B 各问一次，两次偏好相同才记该偏好，任一次 `unknown` 记 `unknown`，其余记 `tie`；`reason` 依次写两次的回答，`cost` 是两次之和。评审看到每臂的成果：前 12 个改动文件的内容（每个至多 6000 字符），其余改动文件与被删掉的快照文件只列路径（各至多 200 条，超出写条数）；另看到该用例快照里的输入文件（任务消息点名的在前，前 12 个给内容，其余只列路径），xlsx、docx、pdf 以文字呈现，成果里的这类文件也一样 |
| `trial.feedback` | 只出现在旧改进作业的试验里：`caseId`、`arm`、`repeat`、`feedbackIds`（≥1）、`status: pass \| fail \| unknown`、`reason`（≤2000 字符）、`model`、`cost`。评审模型读这次运行的成果与反馈原文，判断反馈指出的问题是否已经解决；与确定性检查（`trial.run.checks`）和偏好评审（`trial.review`）分开记 |
| `trial.end` | `status`、`verdict: TrialVerdict`、`cost: { candidate, baseline, review }`（反馈检查的费用计入 `review`） |

每行都有 `format: 1`、`trialId`、`ts`。`cost` 是 `{ usage, requestCount, estimatedUsd }`；美元是估算，用于费用比（见下）。

**采用规则**（`decideTrial(tally, costRatioCap, costApprovalRatio)`，纯函数）。

费用比：两臂的估算美元（`TrialTally.usd`，含缓存读写）都已知且基线大于 0 时，为候选美元 / 基线美元；否则为 token 比（输入 + 输出）。`TrialVerdict.costBasis` 写明用的是哪种。

按顺序：

1. 预算用尽（`budget-exhausted`）、任何一次运行是 `unknown`、或用量未知（`unknown-runs`）：拒绝。
2. 守护集候选通过次数少于基线：拒绝（`guard-regressed`）。
3. 选择集质量 = 选择集运行的确定性检查结果的通过率。候选低：拒绝（`quality-down`）。候选高：费用比 ≤ `costApprovalRatio` 则采用（`quality-up`），否则记为拒绝（理由仍是 `quality-up`；门控不再等用户批准）。
4. 打平：费用比 < 1 采用（`cost-down`）；否则看评审，候选偏好多于基线且费用比 ≤ `costRatioCap` 采用（`review-preferred`），其他拒绝（`no-improvement`）。
5. 含 `plugin` 的候选，采用结论变为拒绝，理由不变。

质量的定义见“自评”的得分组合。

**回放中的成果路径**。门控在回放副本里重跑记录的检查。`file-exists` / `parses` 记录的路径在副本里不存在时，改查这次回放运行 `present` 的成果文件（各成果最新版本，按交付顺序）中下一个扩展名相同、不在任何记录路径上、也没替过别的路径的文件；同一路径的两条检查用同一个替代文件，通过时 `detail` 为 `delivered under another path`。没有交付同类文件时照旧失败。`test-command` 不变。

**具体数值检查**（纯函数 `findInstanceLiterals(componentTexts, sources, projectMessages)`，契约 `instance-literals.ts`）用在经验手册与技能库的整理里（见对应小节）：条目或技能里不能带某个任务的具体数值。词元是带小数点的数（`\d+.\d+`）、三位及以上的整数、日期 `yyyy-mm-dd` 与年月 `yyyy-mm`；前面紧挨字母、数字、`_` 或 `.` 的不算，后面紧挨数字、`_`、`.数字` 或 `-数字` 的不算（所以 `sha256`、`v1.2.3`、`x86_64`、`col_100` 不产生词元，`2384.13USD` 与 `2026-10-05T08:00` 的日期产生）；千位分隔逗号先去掉（`2,384.13` 读作 `2384.13`）；按写出的字面比较（`2384.1` 与 `2384.10` 不同）。文本里的词元同时出现在某个来源里、而在项目历史里出现它的用户消息所属的不同根任务少于 2 个（`PROJECT_CONSTANT_MIN_TASKS`）时命中；两个及以上任务都出现的是项目常量。名字、列名、文件命名规则不检查。命中项 `InstanceLiteralHit`：`{ value, kind: "decimal" | "integer" | "date", path, source }`，一个值在一个文件里只报一次。

`TrialVerdict`：`outcome`、`reason`、`passRate: { candidate, baseline }`（上面第 3 条的质量）、`costRatio`、`costBasis?`（`usd` 或 `tokens`，没有时按 `tokens` 读）、`decidedByReview`；旧改进作业的试验另有 `feedbackPassRate?`、`similarPassRate?`。`TrialPlan.costApprovalRatio?` 是试验开始时冻结的批准倍数。

`cost.estimatedUsd` 来自 `@nexgent/llm` 的只读价目表，模型不在表里或任何用量未知时为 `"unknown"`。门控的费用比优先用它（两臂都已知时）；预算与费用上限仍只看 token 与请求数。

**决定。** `.nexgent/capabilities/decisions/<id>.json`，以 `wx` 写一次：`formatVersion: 1`、`id`、`outcome: adopted | rejected | awaiting-approval | rolled-back`、`reason`、`trigger`、`decidedAt`、`candidateId?`、`trialId?`、`fromVersion`、`toVersion`、`revision?`、`verdict?`、`cost?`、`regression?`、`instanceLiterals?`（`instance-literal` 决定的命中项，只在旧决定里）、`detail`（≤2000 字符）。采用与回滚各写一个修订（`revision`），先发布修订、成功后再写决定，所以链尾被别人抢先时不留 `adopted` 或 `rolled-back` 决定（门控此时写 `rejected`、`interrupted`）；拒绝不写修订（`awaiting-approval` 只在旧决定里出现）。每个决定同时在账本写一条 `capability.decision`。

**回滚**。三种：装载校验失败时立即回到上一个版本（`load-failure`）；采用后的前 `rollback.windowTasks` 个根任务检查通过率低于门控测得的基线通过率（`usage-regression`），或新组件的调用连续出错 `rollback.consecutiveErrors` 次（`component-errors`），由 `decideUsageRollback` 判断并自动回滚；用户也可手动回滚（`manual`）。回滚写一个 `type: "rollback"` 的修订和一个 `rolled-back` 决定，证据放在 `regression`。

## 任务快照与检查

门控要重放过去的任务，所以每个根轮开始时都给工作区拍快照（也是回退的来源，见下文“回退”）。轮末不再拍；快照在这一轮第一次请求的回复开始到达时才开始（不和发出请求争文件系统），在后台进行；只有可能改项目的工具调用（效果不只是 `read` / `network`）之前等它完成，只读工具不等；轮末写检查之前也等它。

- **对象**：`.nexgent/snapshots/objects/<sha256>`，文件原始字节，每份内容只存一次。
- **树**：`.nexgent/snapshots/trees/<sha256>.json`，`{ formatVersion: 1, files: [{ path, sha256, bytes, executable? }] }`，按路径排序，范围与 `turn.files` 相同（不含 `.nexgent/`、`.git/`、`node_modules/`，也不含项目 `.gitignore`、子目录 `.gitignore` 与 `.git/info/exclude` 忽略的路径；被忽略的目录不进入）；文件名是该对象规范 JSON 的 SHA-256。
- **索引**：`snapshots/index.json`，`{ formatVersion: 1, writtenAtMs, prunedAtMs?, files: { <path>: { size, mtimeMs, sha256 } } }`。下一次快照对大小与修改时间都没变、且对象仍在的文件直接用记下的哈希，不再读内容；索引写入前 2 秒内改过的文件重读一次。索引只是缓存，缺了或坏了只多一次全量读取。实现：`@nexgent/tasking` 的 `LocalTaskRecorder`。
- **任务快照**：`.nexgent/snapshots/tasks/<taskId>.json`，根任务开始时写：`{ formatVersion: 1, taskId, turn?, sessionId, takenAt, tree, omitted?, capabilityVersion }`。工作区超过 200 MiB（`maxSnapshotBytes`）时 `tree: null`、`omitted: { reason: "too-large", bytes }`，这个任务不能作为重放用例。
- **检查记录**：`.nexgent/snapshots/checks/<taskId>.json`，根任务结束时写：`{ formatVersion: 1, taskId, turn?, sessionId, checkedAt, specs, results }`。`specs` 是 `TaskCheckSpec`：`{ id, name: "file-exists", path }`、`{ id, name: "parses", path, format: json | csv | xlsx }`、`{ id, name: "test-command", command, shell: bash | pwsh }`；`results` 与 `specs` 一一对应，`target` 为 spec 的 `id`。同样的结果写进 `task.outcome.checks`。
- **按轮记。** 同一会话的多轮仍是同一个 `taskId`（反馈轮也是），快照与检查每个根轮各一份：`tasks/<taskId>.t<turn>.json` 在第 `turn` 个根轮开始时写，`checks/<taskId>.t<turn>.json` 在该轮结束时写一次，两者都带 `turn`（文件名由 `perTurnFileName(taskId, turn)` 给出）。反馈轮不会覆盖它所针对的那一轮的记录。不带轮号的 `<taskId>.json` 是早期写法（快照即第 1 轮，检查是最后一轮），读取方照旧接受，写入方继续同时写。
- **哪些命令成为 `test-command`。** 取任务树在项目根目录跑过的 `bash` / `pwsh` 命令里符合测试命令模式（`TEST_COMMAND_PATTERN`：`npm|pnpm|yarn [run] test`、`vitest|jest|mocha`、`pytest`、`python -m pytest|unittest`、`node --test`、`node <文件>.test.<js|mjs|cjs|ts…>`、`go|cargo test`、`make test|check`，命令必须以它们开头）的，**退出码不论成败都算**，只排除表示“没有跑到测试”的退出码：任何命令的 126、127（不可执行、找不到命令），pytest 的 4、5（路径或参数错误、没有收集到测试）。超时或被取消的调用没有退出码，不算。同一命令只保留最近一次，取最近 3 条。**不在轮末重跑**：检查结果就是模型自己那次运行的退出码（`detail` 写 `the model's own run, exit code N`），退出码非 0 即一项失败的检查。需要独立复核时在门控的后台副本里跑，不在用户的任务里跑。`ls`、`cat`、构建与生成脚本等探索性命令不符合模式，无论成败都不成为检查。
- **回退**：SDK 的 `sessions.rewind({ projectId, sessionId, turn, apply? })` 把这个会话在第 `turn` 轮及以后改过的文件（取各轮 `turn.files` 列出的路径）恢复成第 `turn` 轮开始时快照里的样子：快照里有的写回原内容与可执行位，快照里没有的（之后新建的）删除，其余文件不动。不带 `apply` 只列出会改哪些文件（`changes`）和已经一致的文件（`unchanged`），供宿主先问用户；`apply: true` 才写，并在会话里记一条 `turn.rewind`。对话历史不删，之后照常继续。轮次进行中拒绝（`session/locked`）；那一轮没有快照（过了保留期、项目过大）报 `session/not-found`。实现：`@nexgent/tasking` 的 `planRewind` / `applyRewind`。
- **保留**：每次快照后清理：先删超过 30 天（`retentionMs`）的任务快照，再在对象总量超过 200 MiB（`maxStoreBytes`）时从旧到新删不在保留名单里的任务快照（保留名单由调用方给出，如练习题集与试验引用的任务；当前任务总是保留），最后删没有任何剩余快照引用的树与对象；1 小时内新写的对象不删。总量统计每 10 分钟一次（或一次快照写入超过 8 MiB 时）。路径一律项目相对、`/` 分隔。

## 材料元数据

资料是用户交给任务的文件。`MaterialStore.add` 把源文件**复制**到 `.nexgent/materials/<materialId>/`，源文件不移动、不修改；复制完成后写元数据，并由 SDK 在会话里写一条 `material.added`。类型镜像：`MaterialMetadata`、`MaterialRef`（`packages/kernel/src/contracts/tasking.ts`）。

目录：

```text
.nexgent/materials/<materialId>/
├── material.json      元数据
└── <storedName>       副本
```

- `materialId`：小写 UUID v4。
- `storedName`：原文件名去掉路径、把 `/ \ : * ? " < > |` 与控制字符换成 `_`、去掉结尾的点和空格；为空或是 Windows 设备名（`CON`、`NUL` 等）时用 `material` 加原扩展名。一个目录只放一份资料，所以不会重名。
- 写入顺序：先在 `materials/.tmp-<uuid>/` 里复制并计算 SHA-256、写 `material.json`，再把目录整体改名为 `materials/<materialId>/`。半途中断留下的 `.tmp-*` 目录不被列出，下次启动时删除。

`material.json`（schema：`packages/session/schema/material.v1.schema.json`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | `1` | 格式版本 |
| `id` | string | 即 `materialId` |
| `originalName` | string | 用户选择的文件名（只含基名，原样，供显示） |
| `path` | string | 副本的项目相对路径，`/` 分隔：`.nexgent/materials/<id>/<storedName>` |
| `size` | integer | 副本字节数 |
| `sha256` | string | 副本的 SHA-256（小写十六进制）；复制时与源文件相同 |
| `mediaType` | string | 按扩展名推断的 IANA 媒体类型，未知为 `application/octet-stream` |
| `text` | boolean | 是否按文本处理：能按 UTF-8 解码且不是已知二进制类型 |
| `addedAt` | string | 复制完成的时刻 |
| `sessionId` | string? | 从哪个会话添加；会话外添加时没有 |
| `status` | `"active" \| "removed"` | 移除只改这个字段 |
| `removedAt` | string? | `status` 为 `removed` 时的移除时刻 |

```json
{
  "formatVersion": 1,
  "id": "0f0e0d0c-0b0a-4908-8706-050403020100",
  "originalName": "orders.csv",
  "path": ".nexgent/materials/0f0e0d0c-0b0a-4908-8706-050403020100/orders.csv",
  "size": 18234,
  "sha256": "9f2c…（64 位）",
  "mediaType": "text/csv",
  "text": true,
  "addedAt": "2026-10-11T08:00:00.000Z",
  "sessionId": "6f1c…",
  "status": "active"
}
```

规则：

- `material.json` 是资料状态的唯一来源；`material.added` 只记录“这个会话添加过它”，移除不写会话记录。改 `status` 用原子写（临时文件 + fsync + rename），这是 `material.json` 唯一允许的改写。
- 移除不删文件。删除副本需要用户在界面上确认，由 SDK 删除整个目录；删除后会话里的 `material.added` 仍在，列资料时按目录是否存在判断。
- 引用方式：用户在消息里引用资料（`SendMessageInput.materialIds`）时，`materials` 提供者写一条 `inject` 消息列出每份资料的 `originalName`、`path`、`size`、`mediaType`；`text` 为真且不超过内联上限（`@nexgent/context` 的配置，默认 32 KiB）的资料把全文附在后面，其他资料只给路径，由模型用 `read_file` / `read_document` 读取。
- 模型对 `materials/` 只读（`permissions.md` §路径策略与写入限制）。

## 成果元数据

成果是 `present` 工具声明交付的一组文件。每次 `present` 生成该成果的一个新版本：把文件**快照**复制进 `.nexgent/outputs/<deliverableId>/v<n>/files/`，写 `deliverable.json`，并在会话里写 `deliverable.presented`。快照一经写出不再改变；工作区里的文件之后怎么改都不影响旧版本。类型镜像：`DeliverableVersion`、`DeliverableVersionRef`、`DeliverableFile`、`DeliverableDiff`。

目录：

```text
.nexgent/outputs/<deliverableId>/
├── v1/
│   ├── deliverable.json
│   └── files/report/summary.csv     快照，保持项目内相对路径
└── v2/
    ├── deliverable.json
    └── files/…
```

- `deliverableId`：小写 UUID v4，跨版本不变。`n` 从 1 起，每次 `present` 加 1，没有空号。
- 写入顺序：先在 `outputs/<deliverableId>/.tmp-<uuid>/` 写快照与 `deliverable.json`，再改名为 `v<n>/`；改名时发现 `v<n>` 已存在（并发）则重取 `n`。中断留下的 `.tmp-*` 不被列出。
- 同一成果的判定见 `agent-hooks.md` §步骤 2 工具。

`deliverable.json`（schema：`packages/session/schema/deliverable.v1.schema.json`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | `1` | 格式版本 |
| `deliverableId` | string | 成果 ID |
| `version` | integer | 版本号 n |
| `title` | string | 显示名；`present` 没给时取主文件的基名 |
| `summary` | string | `present` 的一句话说明 |
| `files` | `DeliverableFile[]` | 至少一项，按 `present` 的顺序，第一项是主文件；每项 `{ path, size, sha256, mediaType }`，`path` 是该文件在项目中的相对路径（`/` 分隔），`sha256` 是快照的哈希 |
| `presentedAt` | string | 快照完成的时刻 |
| `sessionId` | string | 产生它的会话 |
| `turn` | integer | 产生它的轮次 |
| `toolCallId` | string | 产生它的 `present` 调用 |
| `memberId` | string? | 成员交付时为成员的子会话 id |
| `memberName` | string? | 成员名，界面据此区分“最终成果”与“成员成果” |

规则：

- `deliverable.json` 只写一次，不改写。会话里的 `deliverable.presented` 带同样的 `deliverableId`、`version`、`title`、`summary`、`files`（`DeliverableVersionRef`），二者可以互相核对；列成果以 `outputs/` 下的 `deliverable.json` 为准（工具在写会话记录前失败时，可能有快照而没有会话记录）。
- 版本差异（`DeliverableStore.diff`）：按 `path` 对齐两版的文件，`change` 为 `added | removed | modified | unchanged`（按 `sha256` 判断）；两边都是文本时给出按行的统一差异块（`DiffHunk`，上下文 3 行），否则只报 `change`，`binary: true`。
- 反馈与成果的关联：`feedback` 记录带 `deliverableId` 与 `version`（见下节）；成果文件本身不记录反馈。
- 模型对 `outputs/` 只读；快照只由 `@nexgent/tasking` 写。
- 成员交付的版本带 `memberId`、`memberName`，`deliverable.presented` 的 `DeliverableVersionRef` 带 `memberName`。不给 `deliverableId` 时只在**同一会话**内按主文件路径追加版本，两个会话交同一路径各成一份成果；显式给 `deliverableId` 时照常追加，跨会话也可以（`agent-hooks.md` §步骤 2 工具）。

## 反馈

用户对一个成果版本给出评分与评语，即开始一个**反馈轮**。反馈只存在会话里，不另建文件；它是后台学习的输入之一。类型镜像：`FeedbackEntry`、`FeedbackListing`。

记录（`feedback`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `turn` | integer | 反馈开启的轮次 |
| `feedback.id` | string | 小写 UUID v4 |
| `feedback.deliverableId` | string | 被评价的成果 |
| `feedback.version` | integer | 被评价的版本 |
| `feedback.rating` | `1`–`5`? | 评分，可不给 |
| `feedback.comment` | string | 评语，可为空串 |

顺序：`turn.start` → `feedback` → （注入）→ `user.message { source: "feedback", content: renderFeedbackPrompt(feedback) }` → 正常的步骤。`renderFeedbackPrompt` 的文本是契约的一部分（`Feedback on deliverable <id> version <n>. Rating: <r>/5.` 加空行加评语；没有评分时省略评分句）。

```jsonl
{"type":"turn.start","seq":40,"ts":"…","sessionId":"6f1c…","turn":2}
{"type":"feedback","seq":41,"ts":"…","sessionId":"6f1c…","turn":2,"feedback":{"id":"5b1e…","deliverableId":"aa0e…","version":1,"rating":3,"comment":"地区要用对照表里的中文名"}}
{"type":"user.message","seq":42,"ts":"…","sessionId":"6f1c…","turn":2,"content":"Feedback on deliverable aa0e… version 1. Rating: 3/5.\n\n地区要用对照表里的中文名","source":"feedback"}
```

恢复语义：`feedback` 不改变投影；`FeedbackStore.list` 扫描项目内各会话的 `feedback` 记录得到列表（`submittedAt` 取记录的 `ts`）。强杀发生在 `feedback` 之后、轮次结束之前时，恢复按上文规则补 `turn.end { kind: "interrupted" }`，反馈记录保留，界面仍能列出。

## 持久目标

一个会话至多有一个当前目标，跨重启保持；目标文本在每轮开始由目标提供者放进系统提示（`agent-hooks.md`）。类型镜像：`Goal`、`GoalStatus`。

记录：

| 记录 | 字段 | 说明 |
| --- | --- | --- |
| `goal.set` | `turn?`、`goal: { id, text, status, setAt, updatedAt, note? }` | 设定新目标，替换旧目标；新目标 `status` 一般为 `active`，`updatedAt` 等于 `setAt` |
| `goal.update` | `turn?`、`goalId`、`status: "active" \| "completed" \| "abandoned"`、`text?`、`note?` | 改状态（完成、放弃、重新激活）或改文本；`goalId` 必须是当前目标 |

两种记录都由宿主（SDK）写，可在轮外或轮中。投影把当前目标放在 `SessionMetadata.goal`（见“恢复算法”的投影表），因此恢复后不必再扫描记录就能显示目标；`goal.update` 把 `updatedAt` 设为该记录的 `ts`。目标提供者只在 `status` 为 `active` 时注入。

## 压缩

长对话的输入超过阈值时，较早的历史被替换为摘要。何时触发、保留多少由 `@nexgent/context` 决定（`agent-hooks.md` §压缩）；本节固定记录格式与恢复语义。类型镜像：`CompactionRecord`、`renderCompactionSummary`。

记录（`compaction`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `turn` / `step` | integer | 压缩发生在第 `turn` 轮第 `step` 次模型请求之前 |
| `summary` | string | 摘要正文（非空） |
| `keepMessages` | integer ≥ 1 | 摘要之后保留的末尾消息条数 |
| `compactedMessages` | integer ≥ 1 | 被并入摘要的消息条数（上一次的摘要算一条） |
| `requestId` | string | 产生摘要的辅助请求，与账本 `purpose: "auxiliary"` 的记录相关联 |
| `usage` | `LLMUsage` | 该请求的用量 |
| `trigger` | `{ inputTokens, threshold }` | 触发时的计费输入与阈值 |

投影：`messages` 变为 `[{ role: "user", content: renderCompactionSummary(summary) }]` 加 `compactionTail(压缩前 messages, keepMessages)`，即最后 `keepMessages` 条，其中的助手回复去掉 `providerContent`；`metadata.lastCompactionSeq` 记下该记录的 `seq`。`renderCompactionSummary` 的文本是契约的一部分：

```text
<conversation-summary>
The earlier part of this conversation was compacted. Summary:

<summary>
</conversation-summary>
```

规则：

- 保留段以 `user` 消息开始（一轮或一次注入的边界），或者在当前轮被切开时以这一轮的某条 `assistant` 回复开始，从不以工具结果开始，所以工具调用与其结果不会被拆开；不满足时 `SessionStore.append` 拒绝写入（见“字段细则”）。当前轮被切开时，摘要末尾带“## Current request (verbatim; …)”一节，原文写出这一轮的请求。
- **用户原话**：kernel 在压缩器给的摘要之后接一节 `## The user's own words (verbatim, oldest first)`（`renderUserWords`），逐字写出会话里所有来源为 `user` 或 `feedback`、且不在保留段里的 `user.message`，每条前标 `[turn N]`，按时间先后排列。总长超过 `USER_WORDS_MAX_CHARS`（60 000 字符）时保留最新的，最早保留的一条可能从开头截断，并注明省略了几条。这一节写在 `summary` 里，所以恢复照常投影，不另加字段。
- **thinking 块**：被压进摘要的助手回复连同其 `providerContent`（thinking 块）一起丢弃；保留段里的助手回复也去掉 `providerContent`，只回放文字与工具调用——这些 thinking 块绑定的是压缩前的历史，保留 thinking 校验会拒绝或丢弃它们。
- 恢复：恢复算法从最后一个 checkpoint 起按顺序投影，遇到 `compaction` 就按上式替换，所以重建的历史与强杀前一致；不需要另外“找最后一条 compaction”。多次压缩时，后一次的摘要请求输入里包含前一次的摘要，`compactedMessages` 把它算作一条。
- `compaction` 不改变 `totalUsage`（辅助请求的用量只在账本与该记录的 `usage` 里）。
- 摘要请求失败不写 `compaction`，只写 `error`（`fatal: false`），历史保持原样。

## 子会话与成员

每个成员（委派对象、工作流节点、组织里的角色）都是一个子会话：独立的 `sessions/<id>/session.jsonl` 与锁，可以单独恢复与只读查看。类型镜像 `collaboration.ts` 与 `session.ts`。

- **会话头。** 子会话的 `session.start` 带 `parentSessionId`（发起它的会话，深度 1，所以总是根会话）与 `member: { name, executionForm, preset? }`。两者必须同时出现，`SessionStore.create` 拒绝只给一个的输入（`session/invalid-record`）。`name` 匹配 `^[a-z][a-z0-9-]{0,31}$`，`executionForm` 为 `delegated | team | workflow`（`team` 只出现在旧会话里；`thread` 只出现在父会话的 `subagent.*` 记录里，讨论串不是子会话）。投影把二者放进 `SessionMetadata.parentSessionId` / `member`。
- **fork 种子。** fork 模式的子会话在 `session.start` 之后紧接一条 `fork.seed`（`seq: 2`）：`messages` 是父会话投影出的消息，从父会话最近一次压缩之后开始。父会话不在轮次中时截至上一轮结束（`throughSeq` 为该轮 `turn.end` 的 `seq`）；在轮次中（成员由本轮的 `delegate` 发起，这是常见情况）时包含本轮到目前为止的内容：本轮的用户消息与已有结果的工具调用，正在运行的那条回复只保留文字与已有结果的调用（发起 fork 的 `delegate` 等仍在运行的调用不带，这条回复的 `providerContent` 也不带；没有文字也没有保留的调用时用占位文字 `(Handing a sub-task to a member.)`），`throughSeq` 为写种子时父会话最后一条记录的 `seq`（摘要消息本身保留）；保留的 `providerContent` 原样复制，thinking 块的回放规则与父会话相同。投影时 `messages` 直接成为子会话的初始历史；`fork.seed` 出现在任何消息或轮次之后时写入被拒。fresh 模式没有 `fork.seed`。
- **一次运行。** 成员的一次运行是子会话的一轮。父会话在运行开始时写 `subagent.start`（`childTurn` 为这一轮的编号，`task` 截取任务说明前 500 个字符），结束时写 `subagent.end`（`result: MemberResult`）。委派与工作流成员各有一次运行；父会话之后可以用 `delegate` 的 `continue`（成员 id，即子会话 id）给同一个成员续一轮，这是同一子会话的下一轮，父会话里另写一对 `subagent.start` / `subagent.end`，`childTurn` 递增、`childSessionId` 不变，`subagent.start` 不带 `mode`。续聊只接受本会话发起的委派或工作流成员，且 `name` 必须与该成员的名字一致。
- **`MemberResult`。** `{ status, text, deliverables, usage, requestCount, error?, merge? }`；`status` 为 `completed | failed | cancelled | budget | interrupted`，`text` 是成员最后一段回复（中断时为已流出的前缀），`deliverables` 是本次运行里 `present` 产出的版本（`DeliverableVersionRef[]`），`error` 只在非 `completed` 时出现。`budget` 表示任务树或成员份额的费用上限挡下了成员的下一次请求，或成员用完了自己的请求次数上限（`delegate` / 工作流 `agent()` 的 `maxRequests`，即 `BudgetShare.maxRequests`，按每次运行计）。
- **成员的工作副本**：可写的成员（模式不是 `read-only`）在自己的项目副本里工作，同时运行的成员互不覆盖文件。
  - 位置：`<系统临时目录>/nexgent-workdirs/<项目键>/<成员会话 id>/`，项目键是项目真实路径的 sha256 前 16 位。副本按快照扫描的规则复制项目文件（遵守 `.gitignore`，不含 `.git/` 与根目录 `.nexgent/`）；跳过的 `node_modules/`、`.venv/`、`venv/` 以链接放进副本（Windows 用 junction），命令能找到已装的依赖；符号链接照样复制成链接（Windows 不复制），不参与合并。项目超过 200 MiB 或 20 000 个文件时不建副本，成员照旧在项目目录里工作。副本的基准内容按 sha256 存在同一目录的 `objects/`，供三方合并。
  - 成员的文件工具、命令的工作目录与系统沙箱的可写根都换成副本；项目本身对它只读。系统提示里的工作目录是副本，并说明轮末会合回。
  - 成员每轮开始时，把项目里在上次同步后变化、而成员没动过的文件带进副本。每轮结束时（在根轮快照完成之后）逐个文件合回项目，基准是副本上次同步时的项目：只有成员改了的，写进项目（或删除）；双方都改了且都是文本（不超过 1 MiB、UTF-8、无 NUL）、改动的行不重叠也不相邻的，逐行合并后写进项目和副本；其余算冲突，项目保留自己的版本，成员的版本存到 `conflicts/<成员会话 id>/<n>/<路径>`，父会话可以读。同一项目的合并依次进行。
  - 合并结果写在 `MemberResult.merge`：`{ applied, merged, conflicts, held? }`；以 `error` 结束的一轮不合并，写 `{ applied: [], merged: [], conflicts: [], held: true }`：半成品留在它自己的副本里，等它之后某一轮正常结束时一起合入；`applied` 是已进入项目的路径，`merged` 是其中逐行合并的，`conflicts` 每项 `{ path, kind: both-changed | deleted-in-project | deleted-by-member, copy? }`（`copy` 是成员版本的绝对路径，成员删除文件时没有）。`delegate`、`workflow` 与 `organize` 的工具结果列出合入的文件与冲突。成员在项目目录里工作时没有 `merge`。
  - 成员关闭时删除副本，冲突副本保留；超过 7 天没动的副本与冲突副本在下次建副本时清理。成员的 `present` 从副本读文件。
- **成员回复在父会话里的显示**：`delegate`、`workflow` 与 `organize` 的工具结果显示每个成员的最后回复，一次结果里所有成员合计至多 20 000 字符，平均分给结果里的成员，每人至少 1 500 字符（`COLLABORATION_LIMITS.memberRepliesShownChars` / `minMemberReplyChars`，`memberReplyShare`）；超出的部分截掉，并注明还有多少字符没显示、可以用 `delegate` 的 `continue` 追问或读成员写的文件（`memberReplyExcerpt`）。`subagent.end.result.text` 存完整回复，不截。结果里每个成员都标出成员 id。图形式工作流的结果不再重复最后节点的回复。
- **恢复。** 进程在成员运行中死亡时：子会话按“恢复算法”的规则补 `turn.end { kind: "interrupted" }`；父会话恢复时，对没有 `subagent.end` 的 `subagent.start` 补一条 `status: "interrupted"` 的 `subagent.end`（由协作包以宿主身份写），对没有 `workflow.end` 的 `workflow.start` 补 `status: "interrupted"`。已有 `subagent.end` 的成员不重跑。

## 讨论串

类型镜像 `contracts/threads.ts`。讨论串是协调者交出去的每一块活的**根会话**（协调者不直接派成员）：用户能打开、直接跟它说话，它自己做或在内部组队。

- **会话头。** `session.start.thread: { coordinatorSessionId, title }`（`title` 1–60 字符）。投影放进 `SessionMetadata.thread`，`summary.json` 的 `entry` 带 `thread?`。讨论串没有 `parentSessionId`，不受成员深度与数量限制，`sessions.list` 照常列出它（带 `thread`）。
- **工作副本。** 讨论串和可写成员一样在自己的项目副本里工作（§子会话与成员“成员的工作副本”），每一轮结束时合回项目。讨论串内部派的成员从讨论串的副本建自己的副本（位置按讨论串副本的真实路径算项目键），每轮结束合回讨论串的副本，不直接合进项目；讨论串在自己这一轮结束时再一起合回项目。
- **工具。** 根会话（不是讨论串、不是成员）有 `start_thread`、`message_thread`、`read_thread`、`list_threads`（`THREAD_TOOLS`，宿主 SDK 的 `@nexgent/threads` 行提供 `ctx.threads` 并注册它们）。同时运行至多 3 个，一个对话至多 12 个（`THREAD_LIMITS`），超出时 `tool/denied`。讨论串的系统提示要求每次回复以 `Done:`、`Not done:`、`Checks:`、`Blockers:` 四行结尾。
- **一次运行。** 协调者交代的一轮（`start_thread` 的首轮，或 `message_thread` 时讨论串空闲而开始的一轮）在讨论串里以 `user.message { source: "thread" }` 开始，在协调者里记一对成员运行：调用工具的那一轮写 `subagent.start { executionForm: "thread", childSessionId: <讨论串 id>, childTurn, name, task }`（宿主记录；`name` 是标题的 ASCII 短名，没有时为 `thread-<n>`），讨论串这一轮结束时写 `subagent.end`，`turn` 仍是发起它的那一轮（协调者那时可能在跑后面的轮，内核允许这条记录指向更早的轮），`result` 同成员（`merge` 是合回项目的结果）。`message_thread` 时讨论串正在跑，消息并进它正在跑的那一轮（`source: "thread"`），不另记运行。用户自己在讨论串里开始的轮不记。
- **叫醒。** 协调者交代的一轮结束（关机、用户停下与费用上限取消的除外，即 `cancelled` 的 `cause` 为 `shutdown`、`user`、`cost-cap`；这几种仍照常记 `subagent.end` 并复盘）后，宿主给协调者一条 `user.message { source: "thread" }`：协调者正在跑就并进那一轮，否则以它开始新的一轮（这一轮不问组织者，不算新任务）。正文为 `threadWakeNote`：`Thread "<title>" (<id>) finished its turn | stopped with a question or blocker | failed | was stopped. Its last reply:` 加最后回复（至多 6000 字符；更长时留开头和最后 1500 字符，即四行汇报所在处，中间写明删了多少字，并要求协调者自己调 `read_thread` 读全文、不要问用户）；再加 `renderWorkdirMerge` 的几行（合入的文件、冲突，或失败没合入）；这一轮合入了文件、协调者没有还在跑的讨论串、且自用户上一条消息以来至少 2 个讨论串合入过文件时，再加一句：每个讨论串只查了自己的副本，报告完成前让一个讨论串检查整个项目。
- **状态**（`ThreadStatus`）：有轮在跑是 `running`；否则看最后一轮：正常结束且 `Blockers:` 不是 `none` 是 `waiting`（`blocker` 为那一行），正常结束是 `done`，出错或输出到上限是 `failed`，取消、中断或没有轮是 `stopped`。`running` 时讨论串或它的成员有一个审批请求还没答，`ThreadInfo.needsApproval` 为 `true`（只在内存里，不写记录；用户在那个讨论串里答，`approvals.respond` 的 `sessionId` 用讨论串 id）。SDK 方法 `threads.list { projectId, sessionId }` 返回 `ThreadInfo[]`；事件 `thread.message { turn, text }` 对应每条 `source: "thread"` 的消息。
- **总对话的提示与笔记**。项目的总对话（`coordinator.json` 里那个）每轮开头多两段系统提示（不存进记录）：`Coordinating this project`（`COORDINATOR_PROMPT`：怎么维护笔记、派讨论串写清目标 / 输入 / 完成标准 / 不许做的事、讨论串短讯到了先汇总再决定下一步）与 `Project notes`（`coordinator-notes.md` 的全文，没有时为 `(none yet)`）。只有它有 `update_project_notes { notes }`（`COORDINATOR_TOOL_NAMES`；创建或恢复它时 SDK 传 `coordinator: true`，其他根会话、讨论串和成员都看不到）。
- **恢复。** 进程在讨论串运行中退出时，讨论串按“恢复算法”的规则补 `turn.end { interrupted }`；协调者再打开时对没有 `subagent.end` 的讨论串运行补 `status: "interrupted"`（同成员）。讨论串不会自己续上。

## 工作流

`workflow` 工具在父会话的一次调用里运行一段脚本或一张图（前台）。类型镜像：`WorkflowStartRecord` 等与 `ArchitectureGraph`。

- `workflow.start` 带新生成的 `workflowId`（小写 UUID v4）与 `kind`；图运行另带 `architecture`（保存的图的 SHA-256）。脚本每次调用 `phase(name)` 写一条 `workflow.phase`。每个 `agent()` 成员在父会话里有一对 `subagent.start` / `subagent.end`，`executionForm: "workflow"`，带 `workflowId`。
- `workflow.end.status` 为 `completed | failed | cancelled | interrupted`，`members` 为它建出的子会话数。成员没完成时，它的 `agent()` 调用抛错，由脚本决定怎么办：脚本捕获了，工作流仍可 `completed`（该成员自己的 `subagent.end` 记录失败）；没捕获，或成员在脚本结束后才结束（脚本没看到），工作流以 `failed` 结束并带该成员的 `error`。已完成成员的成果都保留。图形式的工作流（`graph`）仍是任一节点失败即 `failed`。
- 同时运行的成员至多 4 个，一棵任务树的成员总数至多 16 个，一张图至多 16 个节点（`COLLABORATION_LIMITS`）。

### 按任务组队

类型镜像 `contracts/organization.ts`。

- 根会话每轮开始前，kernel 问 `ctx.organizer.decide(...)` 这一轮是否用成员，结果写进 `turn.start.organization`，并给本轮系统提示加一节 `How this task is organized`。默认实现（workflow 包 `defaultOrganizer`）：没有资料、至多 1 行、至多 40 个单位（汉字逐字计、其他按词计）的任务是小任务，自己做（`size`）；其余任务按 20% 的概率自己做作对照（`control`），否则组队（`default`）；组队的轮用提示里点名的分工（同类任务记录选出的），没有点名时至少用 `lead-checker`（自己做完后由成员独立检查：有能运行的就用测试成员，审查成员只能读文件），不许不用成员直接回答。
- 组队的轮里，模型用 `organize` 工具给出分工：`organization`（`lead-checker`、`plan-build-review`、`explore-then-build`、`custom`）与 1–6 个角色 `{ name, kind, task, after? }`，`kind` 为 `plan`、`explore`、`implement`、`test`、`review`，分别用预设 `read-only-analyst`、`explorer`、`general-executor`、`general-executor`、`read-only-checker`。分工编成一张图，按 `after` 先后、能并行的并行运行（`workflow.start.kind: "graph"`，`title` 为分工名）；每个成员在回复末尾写四行进展（Done / Not done / Checks / Blockers），工具结果按它汇总“n 个角色里几个完成”。
- 装了 `ctx.organizations`（capabilities 包的 `OrganizationLibrary`）时，非小任务的用户轮不再按固定 20% 抽签，而由组织库决定，见 §组织库。
- 同一轮再调用 `organize` 就是换分工：必须给 `reason`，与刚运行的分工完全相同时拒绝；新的 `organization` 记录带 `replaces`。自己做的轮里调用 `organize` 被拒绝。成员看不到 `organize`。

## 组织库

用户级、只追加：`<NEXGENT_HOME>/organizations/runs.jsonl`，每行一条，类型镜像 `OrganizationRun`（`contracts/organization.ts`）。不发模型请求，不重放旧任务。

- `{ type: "run", id, at, classId, key, sessionId, turn, level?, decision, control, organization?, reorganizations, corrections, checks?, completed, usd, traits?, projectRoot?, outputs?, deleted? }`：组织者决定过的一个根用户轮结束时写。`key` 是任务文字的相似词（至多 16 个，同练习题集），`organization` 是这一轮最后运行的分工（名字与角色的 `name`、`kind`、`after`，不含各角色的任务文字），`checks` 是通过数与总数，`usd` 是整棵任务树这一轮的花费；`traits` 是这一轮做了什么（新增或改动文件的扩展名 `ext:`、调用的工具 `tool:`（协作工具除外）、检查 `check:`），`outputs` / `deleted` 是交付且没删的文件与删掉的文件（相对 `projectRoot`）。`profile?` 是这一轮的组织画像，`change?` 是这一轮试的改动的 id（见下“协调者复盘”）。`level?: "coordinator"`（`OrganizationLevel`）：总对话的轮，它的组织是拆成讨论串的方式；没有时是讨论串或其他对话的轮，组织是成员分工。两层的运行分开归类（`suggest` 带 `level`，只看同层的运行；`record` 按特征找类也只找同层），所以分开复盘；讨论串做协调者交代的一轮照常问组织者、照常记成成员层的运行，花费同时作为一块算进协调者那一轮的画像。`OrganizationClassSummary.level?` 同义。`waiting?: true` 表示这一轮起了讨论串，画像要等它们都结束后再量一次；在那之前不复盘这一轮。项目的测试副本不写。
- `{ type: "rework", sessionId, runId?, at }`：用户要求返工，标在该会话此前最后一条 `run` 上（带 `runId` 时标那一条）。三种来源：同一会话之后的反馈轮没有评分或评分 ≤3；同一会话之后的用户消息第一句说结果不对或要重做、撤销（`asksRedo`：中文“重做、不对、错了、改回、撤销……”与英文 “redo、undo、revert、that's wrong……”只认开头，“不是我要的、改回去、doesn't work”等整句里出现也算）；某条 `run` 交付的文件全部不见了、且之后没有 Nexgent 的轮删过它们（下一个记录的轮结束时检查本项目最近 50 条，带 `runId`）。反馈轮本身不记为新的 `run`。
- `{ type: "review", sessionId, turn, score, at }`：结局评审给这一轮的外部评审分数（0–1）。没有测试也没有用户信号的轮以 0.3 的比例请评审，其他轮 0.1，比例不可设置；有评审且分数低于 0.7 的运行不算顺利。
- 同类任务：新任务的词与某条记录的 Jaccard 重合 ≥ 0.25 时归入其中最像的那类。词对不上任何类的轮，记录时按 `traits`（至少 3 项）找做法最像的一条，重合 ≥ 0.6 就归入它的类，否则成新类；这样说法不同、做法相同的任务落在同一类，之后两种说法的任务都能按词找到它。开始一轮时词对不上任何类，先按同一 `projectRoot` 最近一条带 `traits` 的记录用同样的规则找类（`projectClass`），找到就用这一类的建议与改法，记录时也留在这一类，这一轮试的改动因此能被判定。
- 一次运行“顺利”：轮次正常完成，没有失败的检查，用户中途没有纠正，之后没有返工；有 `review` 行时分数不低于 0.7。
- 结论：同类里组队与单独做各至少 5 次后，一方顺利率的 90% 区间下限（Wilson）高于另一方的顺利率，就是那一方更好；否则还在比较。
- 选择：用更好的一方（没有结论时是组队）；另一方作对照，没有结论时占 1/5，有结论后占 1/10，对照的轮记 `control: true`、`chosenBy: "control"`。组队时从三种内置分工与本类里顺利过的 `custom` 分工中按汤普森抽样挑一个，比本类组队平均花费每多 100% 扣 0.1；建议带上它在本类最近一次顺利运行的角色（任务中改出来的分工也算），写进本轮“How this task is organized”一节，并记为 `turn.start.organization.suggested`。本类已有记录时 `chosenBy` 为 `memory`。
- 界面：SDK `learning.status.organizations` 按类给出 `OrganizationClassSummary`（关键词、两边次数、结论、常用分工、两边顺利率、花费变化；同类组队且有画像的运行满 4 次时另有 `sinceStart { costChange, timeChange, qualityHeld }`，最近与最初各至多 3 次的中位数比较；`changesKept?`、`changesReverted?`），能力页标题下一句话说运行最多的那类。

### 协调者复盘

每条组队的 `run` 写下后，组织库不发模型请求，只按规则复盘这一类（`packages/capabilities/src/organizations/reflection.ts`）。

- **组织画像**（`OrganizationProfile { usd, ms, tokens, parts }`，workflow 包 `buildOrganizationProfile`，只读这一轮的会话记录）：`parts` 第一项是协调者（`kind: "coordinator"`），之后每个成员名一项（组织里的角色用角色的 `kind`，委派的成员是 `member`，讨论串是 `thread`）。`ms` 是这一轮开始到这一轮结束或最后一个讨论串运行结束，取较晚的。每项 `{ name, kind, tokens, share, usd, ms, failures, retries, idleMs, wasted, redoneBy? }`：`tokens` 按输入 1、写缓存 1.25、读缓存 0.1、输出 5 加权；`share` 是花费份额（有价格时按价格，否则按加权 token），`usd = share × 这一轮总花费`；协调者的 `idleMs` 是等 `organize` / `delegate` / `workflow` 结果的时间（重叠只算一次），`ms` 是这一轮时长减去它；协调者的 `failures` 是出错的非成员工具结果，`retries` 是完成检查的自动重试次数；成员的 `ms` 是各次运行时长之和，`retries` 是运行次数减 1，`failures` 是没完成的运行、被拒的调用、合并冲突与子会话里出错的工具结果之和，`idleMs` 是 `queuedMs` 之和；`wasted` 指它合并进项目的文件后来全被整份重写（`write_file`）或删掉，`redoneBy` 是最后重写它的一方。
- **热点**（`OrganizationHotspot { part, kind, cause, value }`；画像里除协调者外没有别的部分，即这一轮没分工时，不找热点，只判它带着的改动）：失败加重做 ≥ 2（`failures`）；活全白做（`wasted`）；花费或耗时占比 ≥ 0.4 且高于本类此前同 `kind` 的中位数（`cost`、`time`，此前没有时只看占比）；成员排队超过自己时长的 0.3（`idle`，协调者不算）。按超出阈值的倍数取最热的一项，同样热时按 failures、wasted、cost、time、idle 的顺序。
- **改动**（`{ type: "change", change: OrganizationChange, at }`）：按热点列出六种 `action`（`narrow-reading`、`split`、`merge`、`parallelize`、`sequence`、`full-handoff`）里适用且没被退回过的（以 `kind:cause:action` 为键），按固定顺序排。适用的至少两种、且装了模型时，组织库在后台请模型（这次运行的模型，`purpose: auxiliary`，thinking 开、effort `low`）读热点那一处的运行记录（协调者这一轮，或同名成员 / 讨论串的每次运行，至多 12000 字符），回 `{ cause, action, reason }`：`action` 在列表里、`cause` 与 `reason` 非空时用它（`chosenBy: "model"`，`cause`、`reason` 各至多 400 字符，`instruction` 末尾加 `(Found cause: …)`）；否则取列表第一种（`chosenBy: "rule"`；旧行没有 `chosenBy`，即 `rule`）。后台请求不拖慢这一轮结束；`suggest`、`record`、`noteProfile` 先等它写完。`baseline` 是改之前本类各次同 `kind` 的目标值中位数，`baselineUsd` 是整个任务花费的中位数，`instruction` 是写进下一次同类组队任务“How this task is organized”的一句英文。同一类同时只试一个改动。留还是退只看数据（下条），与谁选的无关。
- **讨论串的画像**（`{ type: "profile", sessionId, turn, profile, at }`）：带 `waiting` 的运行，在它这一轮起的讨论串运行都结束、这一轮也结束后，SDK 用协调者与各讨论串的记录重新算画像，交给 `OrganizationMemory.noteProfile`（`addUsd` 是讨论串运行的花费，含它们的成员）。组织库把这行的画像与 `usd`（原花费加 `addUsd`）替换进那条运行、去掉 `waiting`，各部分 `usd` 按份额重算，协调者的 `retries` 取两次画像里大的，然后复盘到这条运行为止。不在 `waiting` 的运行不接受这行。
- **判定**（`{ type: "verdict", classId, changeId, verdict: "kept" | "reverted" | "unfollowed", at }`）：带这个改动的最近一次运行的分工没照改法做（只看分工看得出的：拆分要这一种角色的部分变多，协调者自己的活要有别的部分接手；合并要变少；并行开始要这一种角色不再等同种角色；先后做要等别人的角色变多；只读相关文件、交完整结果和讨论串的先后看不出，算照做。协调者层的运行只按拆分判，不按形式：拆分要协调者之外的部分比找到改法的那次多，合并要少，其余算照做；它的 `instruction` 写成拆分，如 `Split this task into 3 threads: divide the part of "x" between two threads …; the other parts as before.`，`layoutInstruction`），不算一次试验，记 `unfollowed`：这条改法作废，不算“试过没用”，以后还能再给。带这个改动的运行里有一次除用户中途纠正外不顺利（纠正只是一个信号，不单独让改动退回）、或花费超过 `baselineUsd × 1.2`，立刻退回；试满 2 次且每次目标值都不高于 `baseline × 0.8`（`wasted` 要求为 0）就留下，否则退回。留下的改动以后同类组队都带上（最近的至多 3 条）；判定写下的那次运行之后，复盘再找下一个热点。

## 预设

预设决定成员的人设、工具范围与模型参数，只填字段、不含代码。类型镜像：`AgentPreset`、`PresetFile`；校验：`assertPresetFile`（schema `PRESET_FILE_SCHEMA`）。

- 文件：`.nexgent/presets/<name>.json`，`name` 字段必须等于文件基名，匹配 `^[a-z][a-z0-9-]{0,63}$`。字段：`formatVersion: 1`、`name`、`description`（一行，给选预设的模型看）、`persona?`（替换系统提示的默认人设段）、`tools?: { allow?, deny? }`、`sandboxMode?`、`model?`、`effort?`、`thinking?`、`maxSteps?`。未知字段与错误类型报 `config/invalid`。
- 内置四份：`read-only-analyst`（只读分析）、`read-only-checker`（只读检查）、`general-executor`（通用执行者，继承父会话的模式）、`explorer`（快速、低成本的只读搜索，`read-only`、effort `low`、thinking 关、`maxSteps` 24）。同名时项目预设覆盖内置预设。
- 预设只能收窄：`tools` 与父会话可见集合求交，`sandboxMode` 宽于父会话时报错（`permissions.md` §子会话继承）。

## 架构图存储

模型交给 `workflow` 的声明式图在执行前规范化并保存，供重放引用。

- 文件：`.nexgent/architectures/<sha256>.json`，内容 `{ "format": 1, "architecture": { "nodes": [...] } }`；`<sha256>` 是 `JSON.stringify({ format: 1, nodes })` 的小写十六进制哈希，`nodes` 先规范化（按 `id` 排序，`dependencies` 排序去重，`tools.allow` / `deny` 排序去重）。
- 节点：`{ id, prompt, dependencies, preset?, tools?, model? }`；`id` 是成员名，图内唯一；依赖必须指向已有节点、不得成环，违者在保存前报可读错误，不写文件。
- 写入：先写临时文件，再以硬链接发布到目标名（目标已存在则读回校验哈希）；文件一经写出不改。Windows 上硬链接需在验收中补测。

## 迁移

已有项目内数据（`.nexgent/` 下 `PROJECT_DATA_SUBDIRS` 中任一目录非空，或 `config.json` 有 `approvals`）的项目，由宿主一次性复制到用户数据目录。契约 `data-layout.ts` 的 `MigrationRecord`，文件 `<home>/projects/<projectId>/migration.json`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | `1` | |
| `projectId` | string | 64 位小写十六进制 |
| `from` | string | 旧 `.nexgent/` 的绝对路径 |
| `status` | `"copying" \| "done" \| "failed"` | 进行中、复制并核对完成、放弃 |
| `startedAt`、`finishedAt?` | 时间戳 | `finishedAt` 在 `done` / `failed` 时写 |
| `entries` | `{ name, files, bytes }[]` | 每个复制过的子目录（`name` 取自 `PROJECT_DATA_SUBDIRS`） |
| `grantsMoved` | integer | 从 `config.json.approvals` 移到 `grants.json` 的条数 |
| `oldDataKept` | `true` | 迁移从不删除旧数据，写出时恒为 `true` |
| `oldDataRemovedAt?` | 时间戳 | 用户批准删除旧数据、删除完成的时刻 |
| `error?` | `ErrorInfo` | `failed` 的原因 |

规则：

1. 先写 `status: "copying"`，再逐目录复制；复制完逐文件比较大小与内容哈希，全部一致才写 `done`。
2. 只有 `done` 之后读写才转到用户数据目录（`resolveDataLocation`）；`copying` 或 `failed` 时项目照旧用旧 `.nexgent/`，下次打开重试，不会把用户困住。
3. `done` 之后在旧 `.nexgent/` 留 `MOVED.txt`（`MIGRATION_NOTICE_FILE`，说明数据去了哪里），写 `.gitignore`（见“用户数据目录”），把 `config.json.approvals` 移到 `grants.json` 后从 `config.json` 去掉该字段。
4. 旧数据只在用户明确同意后删除，删除后写 `oldDataRemovedAt`。
5. 迁移期间会话锁照常生效：有会话正在写的项目不开始迁移（任一 `sessions/<id>/.lock` 的进程还活着，或锁读不出），不写记录，下次打开再试。
6. 复制跳过 `.lock` 文件；核对逐文件比较大小与 SHA-256，有一个不同即 `failed`。实现：`@nexgent/workspace` 的 `prepareProjectData` / `migrateProjectData`。

## 自评

每个根任务结束后有一份自评。先做确定性检查（不花模型费用，学习开着就总做），再按冻结的评分要点由执行模型打分；用户自己的评分权重最高。契约 `learning.ts` 的 `SelfEvaluation`，文件 `<projectdata>/evaluations/<taskId>.json`（迁移前的项目写在 `.nexgent/evaluations/`）。检查、评分要点与分数只写一次；`feedback`、`outcome`、`calibration` 可以之后补（用户后来评了分、抽中了校准）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | `1` | |
| `rules` | `"adr-0019"` | `LEARNING_RULES`，等于 `EVALUATOR_RULES`；不同版本规则下的自评不混用 |
| `projectId`、`taskId`、`sessionId` | string | `sessionId` 是根会话 |
| `turn` | integer ≥ 1 | 评到的最后一个根轮 |
| `createdAt` | 时间戳 | |
| `checks` | `TaskCheck[]` | 确定性检查，同 `task.outcome.checks` |
| `sample` | `"user-feedback" \| "check-failed" \| "random" \| "not-sampled" \| "budget-exhausted" \| "learning-off"` | 为什么打了分（或没打）：`selfEvalSample` |
| `rubric?` | `Rubric` | 打了分才有：`{ items: { id: "r1"…, text ≤300 字符, weight?: 1–3 }[] (1–12 项), model, createdAt, generator }`。任务结束时由任务文字与输入生成一次后冻结，宿主与任何学习者都不改；`generator` 是生成指令的版本（C2 之前为 `v0`） |
| `scores?` | `{ itemId, score: 0 \| 0.5 \| 1, note? }[]` | 每项得分（不满足、部分满足、满足） |
| `scorer?` | string | 打分的模型，默认执行模型 |
| `feedback?` | `{ feedbackIds, rating?: 1–5 }` | 用户对这个任务成果的反馈，最后一次评分 |
| `score?` | number 0–1 | `combineScore` 的结果 |
| `outcome` | `"success" \| "mixed" \| "failure" \| "unknown"` | `selfEvalOutcome` 的结果 |
| `cost` | `LearningCost` | 生成要点与打分的花费 `{ usage, requestCount, estimatedUsd \| "unknown" }`，计入学习预算 |
| `calibration?` | `{ model, score, agree, at, cost }` | 外部评审（默认 `claude-opus-5-5`）用同样的要点与检查打的分，`agree` 表示两边得出同样的结局（不计用户评分时的 `selfEvalOutcome`） |

**得分组合**（纯函数 `combineScore`）：确定性检查通过率与加权评分要点得分（`rubricScore`，权重缺省 1）的平均；只有其一时取其一；都没有时没有得分。

**结局**（`selfEvalOutcome`）：有用户评分时按评分（4–5 成功，3 一般，1–2 失败）；否则有检查失败即失败；没有评分要点得分时为 `unknown`（只过了检查不能证明做好了）；否则按得分分档：有评分要点得分时按评分要点得分（`rubricScore`）分档，不用与检查通过率平均后的综合得分，免得全部通过的检查把漏了要点的结果抬成成功；≥ 0.8 成功（`SUCCESS_SCORE`），< 0.5 失败（`FAILURE_SCORE`），其间一般（`scoreBand`）。

**抽样**（`selfEvalSample`）：学习关闭为 `learning-off`；预算余额不到一个任务上限为 `budget-exhausted`；余额宽裕（≥ 10 个任务上限，`SELF_EVAL_COMFORT_FACTOR`）时每个任务都打分（记 `random`）；余额紧张时依次给有用户反馈的、有检查失败的任务打分，其余按 25%（`SELF_EVAL_RANDOM_RATE`）抽取，没抽中记 `not-sampled`。

**评分器可靠性**（`scorerReliability`）：按项目与总体统计带 `calibration` 的自评，一致率 = `agree` 的比例。少于 10 次校准（`MIN_CALIBRATION_SAMPLES`）为 `insufficient`，一致率 < 80%（`SCORER_AGREEMENT_THRESHOLD`）为 `unreliable`，否则 `reliable`。`insufficient` 与 `unreliable` 一样：技能不自动启用，界面写明原因。默认校准抽样比例 10%（`CALIBRATION_SAMPLE_RATE`），花费计入学习预算（`learningPhase: "calibrate"`）。

## 练习题集

做完的任务变成练习题，按相似任务成簇划分为训练、选择、留出；学习者只能看训练与选择。契约 `learning.ts` 的 `PracticeCase`，文件 `<NEXGENT_HOME>/practice/cases/<caseId>.json`（用户级；只收 `learning.contribute` 开着的项目的任务，和 Nexgent 自带的少量通用题）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | `1` | |
| `id` | string | 小写 UUID v4 |
| `source` | `"task" \| "generic"` | 用户任务，或自带的通用题 |
| `createdAt` | 时间戳 | |
| `prompt` | string 1–20000 字符 | 任务文字：根任务的第一条用户消息；覆盖多轮时加上到所评那轮为止的后续消息 |
| `input?` | `{ projectId, tree }` | 任务题：输入快照在 `<projectdata>/snapshots/trees/<tree>.json`；有题引用时快照不回收 |
| `projectId?`、`taskId?`、`sessionId?` | string | 来源 |
| `similarityKey` | string[] | 任务的小写关键词（≤16 个，每个 ≤40 字符），相似度计算用 |
| `clusterId` | string | 同簇是相似任务，总在同一个划分里 |
| `split` | `"train" \| "selection" \| "holdout" \| "guard"` | 划分 |
| `rubric?` | `Rubric` | 从自评复制的冻结评分要点 |
| `outcome?`、`score?` | 同自评 | 原始运行的结局与得分 |

划分（纯函数 `practiceSplit(clusterId, source)`，稳定）：按簇 id 的 FNV-1a 哈希模 10，0–5 训练、6–7 选择、8–9 留出，约 60/20/20，所以相似任务不会一半在留出、一半在别处；通用题恒为 `guard`，只用来防退化。反思、归纳与提案只读 `train` 与 `selection`（`isVisibleToLearners`）；`holdout` 与 `guard` 只用于测量。

## 经验手册

一个条目是一条可复用的做法，带计数；它只通过追加到日志的小操作改变（新增、修改、赞、踩、状态），从不由模型整本重写。当前手册是日志的折叠（`foldHandbook`），所以回到任意时刻就是折叠一个前缀。契约 `handbook.ts`。

文件：用户级 `<NEXGENT_HOME>/handbook/ops.jsonl`，项目级 `<projectdata>/handbook/ops.jsonl`；JSON Lines，只追加，`seq` 从 1 起连续。每行一个操作，公共字段 `formatVersion: 1`、`seq`、`at`、`entryId`（小写 UUID v4）、`actor`（`reflection` / `execution` / `user` / `host` / `migration`）、`source?`（`{ projectId?, taskId, sessionId? }`）、`reason?`（≤200 字符，用户的语言）：

| `op` | 专有字段 | 说明 |
| --- | --- | --- |
| `add` | `text`（≤600 字符）、`keywords`（≤12 个小写词，每个 ≤40 字符）、`scope: "user" \| "project"`、`projectId?`、`status?: "trial" \| "active"`、`supersedes?`、`kind?: "practice" \| "rule"`、`appliesTo?`（≤120 字符）、`pending?` | 新条目，缺省 `trial`；从上下文策略迁来的条目直接 `active`。`supersedes` 列出被取代的条目，它们随之退休。`kind: "rule"` 是项目规则，必须 `scope: "project"`；`appliesTo` 与 `pending` 只属于规则 |
| `edit` | `text?`、`keywords?` | 改措辞或关键词；计数与状态不变 |
| `upvote` / `downvote` | 无 | 一票有用 / 有害 |
| `status` | `status: "trial" \| "active" \| "retired"` | 宿主按 `nextHandbookStatus` 追加，或用户改 |

条目（折叠结果）字段：`id`、`text`、`keywords`、`scope`、`projectId?`、`status`、`kind?`、`appliesTo?`、`pending?`、`helpful`、`harmful`、`sources`、`supersedes`、`supersededBy?`、`createdAt`、`updatedAt`。用户（`actor: "user"`）对一条 `pending` 规则追加的 `status` 操作同时去掉 `pending`。

规则：

- 状态（`handbookStatusFromEvidence`，契约 `handbook-evidence.ts`）：只按下文“随机注入对照”的证据定。试用条目在给与不给两组各有至少 3 个结局已知的任务、且给的那组均分不低于不给的那组时启用；给的那组出现用户的负面信号，或给的那组至少 4 个任务、均分比不给的那组低 0.1 以上，或被取代时下线；执行模型或反思说某条启用的条目误导了它，只能把它退回试用。票（`upvote` / `downvote`，折叠为 `helpful` / `harmful`）从此读作“用到了” / “说它误导”，不能让条目启用。
- 项目规则（`isRuleInForce`）：用户在任务或反馈里说成以后都要遵守的约定，保留具体的单位、格式、命名与数值，记在项目级，`appliesTo` 是用户说的范围（整个项目，或某个目录、模块、某类文件；没说时记为这次任务改到的那部分）。规则不按任务文字检索、不抽签：本项目每个根任务的第一轮都在手册注入的最前面给全部生效的规则（`HANDBOOK_RULES_HEADER`，每行带范围），任务本身的要求与规则冲突时以任务为准；id 同样写进 `turn.start.handbook`。规则不受随机注入对照与按使用下线的影响，只有用户停用或被新规则取代时退休。规则行之后总跟一句 `RULE_CONFLICT_NOTE`：范围内已有的测试或代码与规则不符时两边都不改，用一句话问用户以哪个为准（README、注释、示例照规则改）。本项目里还没给过别的根会话的规则（看 `usage.jsonl` 里有没有别的会话给出它的 `hit`）在 id 后标 `(new)`（`RULE_NEW_MARK`），并加一句 `NEW_RULES_NOTE`，要模型先找与它不符的已有测试或代码。给过规则的任务，自动检查失败时重试说明后加 `RULE_CONFLICT_AFTER_CHECKS_NOTE`。反思拿不准是不是长期规则时写成 `pending`（`status: trial`），不注入，等用户在“能力”页确认（`status: active`）或拒绝（`status: retired`）。
- 检索：试用与启用的条目可被检索（`isRetrievable`；规则除外），每个任务至多 5 条（`HANDBOOK_TOP_K`）；项目级条目只给本项目，用户级条目在 `learning.useShared` 开着时给所有项目。注入的条目 id 写在 `turn.start.handbook`。
- 执行中的模型用 `handbook_mark`（只读、不审批、可并发）说一条注入的条目帮了忙还是带偏了；每个任务每个条目一票，重复的忽略。
- 条目文字用用户的界面语言；不得含某个任务的具体数值（沿用“候选与门控”的具体数值检查）。
- 使用记录与按使用下线：每个手册目录在 `ops.jsonl` 旁边有 `usage.jsonl`，JSON Lines，只追加，不取锁，读取方跳过解析不了的行。它只是记账，不属于条目的历史。每行公共字段 `formatVersion: 1`、`at`、`kind`、`projectId`、`sessionId`（根会话）：`kind: "turn"` 是根任务的一轮问了手册（用户级文件在 `useShared` 开着时也记）；`kind: "hit"` 另带 `entryId`、`given`（是否给了模型），记在条目所在的那一份。“用到了”取 `ops.jsonl` 里的有用票。宿主每轮检索前下线没人用的条目，追加 `status: retired`（`actor: host`，`reason` 以 `unused:` 开头）：启用的条目 90 天、试用的条目 60 天没被检索到，并且其间至少有 10 个根会话问过这份手册；或者试用条目自上次被用到（或新增、恢复）以来给过 8 个根会话都没得到有用票。计时从条目新增、修改、用到、用户改状态或最近一次命中中最晚的那个算起。用户可以把它恢复到下线前的状态（`status` 操作，`actor: user`）；被取代的条目不能这样恢复。门控的项目副本不写这个文件。检索分数相同的条目，先按用到次数与给出次数之比，再按最近用到时间排序。
- 随机注入对照（契约 `handbook-evidence.ts`，常量 `HANDBOOK_EVIDENCE`）：
  - **抽签：** 根任务检索到、并且通过相关性门槛的试用条目，按概率 0.5 决定给不给模型，每个任务至多抽 1 条。启用的条目每个任务至多给 4 条，每条按 0.9 的概率给。
  - **展示记录：** 抽签结果写在 `hit` 行上，可选字段有：
    - `draw: "shown" | "held-back"`，此时 `given` 等于 `draw === "shown"`；
    - `showProbability`（0.5 或 0.9）；
    - `status: "trial" | "active"`；
    - `taskId`。
  - **不算对照证据的行：** 没有 `draw` 的 `hit` 行，包括更早写的行，以及因每任务条数上限没参与抽签的条目，以及给出的项目规则（`given: true`、`status: "active"`）。
  - **结局记录：** `kind: "outcome"` 行，另带 `taskId`、`score`（0–1）、`evidence`、`userNegative?`。
    - `evidence` 至少一项，取值为 `user-rating`、`user-comment`、`user-revert`、`check`、`external-review`。同模型自评与模型的票不是结局来源。
    - `userNegative?` 表示用户明确否定了成果。
    - 结局写进这个根会话有抽签记录的每一份 `usage.jsonl`；同一会话有多行时，后写的那行算数（用户评分可能晚于检查到来）。
    - 写入方是 `@nexgent/evolve` 的学习宿主：每处理一轮，在自评之后、反思请求之前，按 `taskOutcome` 算出结局，经 `Handbook.recordOutcome` 写入，然后调 `Handbook.applyEvidence`。分数按下面的顺序取，前面的优先：
      - 用户删掉了任务交出的全部成果文件（`revertedTasks`）：`user-revert`，0 分，记 `userNegative`。删除判定：这些文件都不在项目里，且之后没有任何任务轮删过它们。在处理后面的任务、并且队列里没有别的任务在等时检查，每个任务只记一次。
      - 最近一次反馈只有评语、没有评分：`user-comment`，0.5 分，按中间评分算，与改进流程计入的反馈（`isCountedFeedback`）一致。不记 `userNegative`，因为评语可能只是对好结果提个小改动。
      - 用户评分：`(评分 − 1) / 4`，评分 ≤ 2 记 `userNegative`。
      - 都没有时：确定性检查通过率与外部评审分（自评校准抽样里有才有）的平均，只有一项就用那一项；都没有就不写。
      - 自评的评分要点得分不进结局。
  - **计算（`handbookExposureEvidence`）：** 每个会话按它第一次抽签计一次；没有结局的会话不计。
  - `ops.jsonl` 不因此新增操作。

**反思与整理**（`@nexgent/evolve` 的 `LearningHost`）：每个根任务轮结束后（`turn.end` 之后，内核调用可选的 `ctx.improve.noteTurnEnd`；用户、关机或父会话取消的轮不学），任务进入项目的学习队列；应用进程里的后台循环一次处理一个任务：先调 `selfEvaluate`（`@nexgent/capabilities`，见 §自评；每个任务只评一次，之后的轮只并入用户反馈；请求记 `learningPhase: "self-eval"` 或 `"calibrate"`，与反思共用学习预算），再读整段任务的会话记录与这份自评（自评失败或项目副本没有自评时，由本轮确定性检查与用户最后一次评分按 `selfEvalOutcome` 推出；这个结局只给反思参考），接着写本任务的对照结局（见下），找本项目历史里最相似、结局不同的一个任务作对照，发一次反思请求（`purpose: "auxiliary"`、`learningPhase: "reflect"`、`taskId` 为被学习的任务，不带 `sessionId`），把回答里的操作交给确定性整理，通过的经 `Handbook.apply`（`@nexgent/capabilities`，`actor: "reflection"`）写入，`apply` 在日志锁内再查一遍；反思的票只记“用到了 / 说它误导”，不能让条目启用。门控的项目副本（`isTrialCopy`）不入队、不学。整理规则（任何任务都成立）：反思写的条目文字 1–300 字符（一条做法，不是清单）；关键词小写、去重、至多 12 个，缺省时从文字取；含任务具体数值的条目拒绝（`findInstanceLiterals`，项目级条目允许项目常量，用户级不允许）；与任务的用户消息或反馈评论共享 24 个以上连续字符、或用引号引用其中原话的条目，视为照抄一次性要求，拒绝（反馈里对某个成果的偏好不是规则）；反思对同一条目至多改写 2 次；与可见条目文字相似度 ≥ 0.6 且未声明取代的新条目视为重复，拒绝；`supersedes` 与 `edit` 只能指向同一份日志里未退休的条目；投票只能投给本任务被给到的条目（`turn.start.handbook`；没有注入记录时为按任务文字检索到的前 5 条），每个任务每个条目一票，与结局是否已知无关；`learning.contribute` 关着时新条目一律记为项目级；文字里有本项目任务消息中出现过的文件名（`name.ext`）或路径（`a/b`）时，新条目记为项目级（名字只在本项目有意义），给用户级条目的 `edit` 带进这类名字时拒绝；一次反思至多新增 3 条、写 10 个操作（规则计入新增条数）。规则（反思的 `rule` 操作）另按：用户原话里与它最像的那句（任务、运行中插话、反馈都算）只说“这次、这里、先别、暂时、for now、this time”这类一次性说法、没有“一律、以后、每次、项目里、always、from now on”这类长期说法的，拒绝（`one-off`）；两类说法都没有的，即使反思说确定也写成 `pending`；只能带用户在任务消息或反馈里亲口给出的数值，其他任务数值照样拒绝；仍须用自己的话重述（共享 24 个以上连续字符拒绝）；与已有生效规则相似度 ≥ 0.6 且未声明取代的视为重复；`supersedes` 只能指向本项目未退休的规则；确定的规则直接 `active`，拿不准的写成 `pending`；反思对规则的投票与 `edit` 一律以 `rule-locked` 拒绝。自评从本任务第一轮的注入里读出给到的规则（`givenRules`），写进评分标准与打分请求，规则压过项目旧文件、只有任务自己的消息能压过规则。执行中的模型经 `handbook_mark` 记票（`actor: "execution"`）；同一任务已投过的条目，反思不再投。

**学习队列** `<项目数据>/learning/queue.json`（迁移前在 `.nexgent/learning/`，在 `queue.lock` 下原子重写；处理它的进程持有 `worker.lock`，别的进程只入队）：`{ formatVersion: 1, items, history }`。`items[]`：`{ taskId, sessionId, fromTurn, turn, checks, enqueuedAt, status: "pending" | "running" | "waiting-budget", attempts, detail? }`，同一任务的新一轮替换它等待中的那项，反思覆盖自上次学到的轮之后的所有轮；至多 50 项。`history[]`：`{ taskId, sessionId, fromTurn, throughTurn, finishedAt, status: "done" | "skipped" | "failed", outcome, task（≤500 字符）, keywords, approach（≤600 字符）, ops, rejected, added, usd?, detail?, outputs?, deleted?, reverted? }`（`outputs` 是任务交出、且自己没删的成果文件，至多 50 个；`deleted` 是任务轮删掉的文件，至多 200 个；`reverted` 表示已记过用户删除成果），至多 500 项，供找对照任务。花钱前检查 `mayLearn` 与学习预算：没确认说明时项留在队列里；预算余额不足 0.1 美元（`REFLECTION_RESERVE_USD`）时项标为 `waiting-budget`，等之后某轮结束或应用重启时窗口有余额再跑；应用退出时中止正在进行的请求，那一项回到 `pending`（本次不计入尝试次数），下次启动继续；请求失败重试，3 次后记为 `failed`。

## 技能库

一个学来的技能是一份 `SKILL.md`（`name`、`description`、`when_to_use`、正文），由至少 2 个相似的成功任务归纳出来，存在用户数据目录，按版本只追加。默认关闭（`learning.skills`），界面不显示。契约 `packages/kernel/src/contracts/skill-library.ts`，存放与给用在 `@nexgent/capabilities`（`SkillLibrary`、`SkillLibraryHost`），归纳在 `@nexgent/evolve`（`induceSkills`）。

```text
<NEXGENT_HOME>/skill-library/
├── log.jsonl                    操作日志（log.lock 下追加）
├── skills/<name>/v<n>/SKILL.md  每个版本一份，写入后不再改
├── usage.jsonl                  抽签与结局（与经验手册的 usage.jsonl 同格式）
└── rejected.jsonl               被拒的候选
```

**`log.jsonl`**：JSON Lines，每行公共字段 `formatVersion: 1`、`seq`（从 1 递增）、`at`、`skillId`（`<name>@v<n>`）、`actor: "induction" | "host" | "user"`、`reason?`（≤200 字符）。

| `op` | 专有字段 | 说明 |
| --- | --- | --- |
| `add` | `name`（`^[a-z0-9]+(-[a-z0-9]+)*$`，≤64 字符）、`version`（同名最高版本加 1）、`description`（1–1024 字符）、`whenToUse?`（≤1024 字符）、`replaces?`（要取代的版本 id）、`sources`（来源任务 `{ projectId, taskId, sessionId }`，至少一个） | 新版本，`SKILL.md` 先写好；起始为试用 |
| `status` | `status: "trial" \| "active" \| "retired"` | 宿主按证据追加，或用户改 |

技能版本（折叠结果，`foldSkillLibrary`）字段：`id`、`name`、`version`、`description`、`whenToUse?`、`status`、`replaces?`、`supersededBy?`、`sources`、`createdAt`、`updatedAt`。一个版本变为启用时，同名的其他未退休版本与它 `replaces` 的版本退休，`supersededBy` 记为它。折叠日志前缀就是回滚。

**`SKILL.md`**：`---` 之间的 YAML（`name`、`description`、`when_to_use`，后两者写成 JSON 字符串），之后是正文（1–8000 字符）。v1 只有说明，没有脚本（模型的文件工具不能读用户数据目录）。

**给用**（`SkillLibraryHost`，与手册在同一个 `handbookForTurn` 里）：根任务的用户轮里，用手册的 BM25 与相关性门槛按任务文字检索未退休的版本（文档是 `description` 加 `when_to_use`，名字拆成词作关键词），同名只取一个版本，这个会话已抽过的不再抽。启用的版本每个任务至多抽 2 个、各按 0.9 的概率给；试用的版本每个任务至多抽 1 个、按 0.5 的概率给（`HANDBOOK_EVIDENCE` 的概率）。抽签写进 `usage.jsonl`：本轮一行 `turn`，每个检索到的版本一行 `hit`（`entryId` 为版本 id，带 `given`、`status`、`taskId`、抽过签时带 `draw` 与 `showProbability`）。给出的版本加进这个会话的技能列表（`@nexgent/skill` 经 `ctx.capabilities.learnedSkills` 读，同名时排在所有其他来源之下，`source: "user"`），手册注入消息之后加一行 `LEARNED_SKILLS_HEADER` 与每个技能的名字和描述（试用的标“on trial”）。成员会话用根会话的抽签结果。`learning.useShared` 关着、成员与反馈轮不抽；门控的项目副本不抽签、不记账，直接给检索到的版本。

**结局与状态**：`LearningHost` 写手册的对照结局时，同一个 `outcome` 行也写进技能库的 `usage.jsonl`（只写给在这里有抽签记录的会话；删除成果的回退同样写），随后 `SkillLibrary.applyEvidence` 按 `handbookStatusFromEvidence` 启用或下线，条件与“经验手册”的“随机注入对照”相同。

**归纳**（`LearningHost` 学完一个任务之后，在同一把工作锁下）：
- 只在项目 `learning.useShared` 与 `learning.contribute` 都开着、`mayLearn`、学习预算余额至少 0.1 美元时进行。
- 成功任务：学习队列 `history[]` 里 `status: "done"`、没有 `reverted`、`externalScore ≥ 0.8` 的任务。`externalScore` 是 `history[]` 新增的可选字段，即写进 `usage.jsonl` 的对照结局分（来自用户、确定性检查或外部评审；没有这些信号时缺省）。
- 分组（`inductionGroupFor`）：刚学完的任务成功、从没被归纳用过，并且至少还有 1 个成功任务与它的任务文字（加关键词）相似度 ≥ 0.25；组内取最新的至多 4 个。
- 库里已有未退休的版本能按这个任务的文字检索到时，不发请求，只记一次运行。
- 请求：`purpose: "auxiliary"`、`learningPhase: "induce"`、`taskId` 为刚学完的任务，模型与 thinking 用项目的 `improvement` 设置，输出上限 8000 token（开 thinking 时加倍）。输入是各任务的运行记录（`renderTaskRun`，每个至多 6000 字符）与结局分、在用的版本、其他技能占用的名字、相关手册条目、最近 10 个被拒候选。回答是 `{ "skills": [{ name, description, when_to_use?, body, replaces? }] }`，至多 2 个。
- 整理（`curateInduction`，失败即拒，理由写进 `rejected.jsonl`）：名字格式与长度；不与内置、用户、项目技能重名；与在用的学来技能重名时必须 `replaces` 它的一个版本；描述 1–1024 字符且不含 `<` `>`，`when_to_use` ≤1024 字符，正文 1–8000 字符；任何字段不含这些任务的具体数值（`findInstanceLiterals`，无项目常量豁免）或本项目任务里出现过的文件名、路径；正文不与任务消息或反馈评论共享 24 个以上连续字符，任何字段不引用其中原话；描述加使用时机与未被取代的在用版本或同批候选相似度 ≥ 0.6 时算重复。
- 通过的候选以 `actor: "induction"` 写成试用版本，`sources` 为组内各任务。

**`rejected.jsonl`**：每行 `{ formatVersion: 1, at, projectId, group（刚学完的任务 id）, name?, description?, reason, detail }`，`reason` 为 `malformed`、`invalid-name`、`name-taken`、`too-long`、`instance-literal`、`project-name`、`copied-request`、`duplicate`、`unknown-replaces`、`too-many` 之一。

**归纳记录** `<项目数据>/learning/skills.json`（原子重写）：`{ formatVersion: 1, used: { [taskId]: at }, runs: [{ at, seedTaskId, taskIds, added, rejected, usd?, detail? }] }`，`runs` 至多 50 条。被一次归纳用过的任务记进 `used`，不再触发；请求失败也记一次运行（`detail` 写原因），不重试同一个任务。

## 旧格式（只为读旧项目）

下列功能已删除，代码在归档分支 `archive/offline-evolve`，完整的旧格式文本在归档仓库 `csxq0605/Nexgent-archive`。契约（`improvement.ts`、`improver.ts`、`offline-evolution.ts`）与 `improvement.v1.schema.json` 还在，只让旧项目的数据读得出。当前代码不再写下面这些文件和字段。

- **改进作业、改进器与元改进、离线进化。**
  - 项目目录：`.nexgent/improvements/`（`queue.json`、`<jobId>/job.json`、`diagnosis.json`、`comparison.json` 等）与 `.nexgent/improvers/`（`bundles/`、`activation/`）。用户数据目录的 `projects/<projectId>/` 下也可能有这两个目录；`PROJECT_DATA_SUBDIRS` 仍列出它们，迁移旧项目时照常复制。
  - 主目录：`<NEXGENT_HOME>/improvements/`、`improvers/`、`offline-runs/`（`<runId>/run.json`、`applied.json`）。
  - 会话：`session.start.purpose: "improvement"` 与 `improvement: { jobId, phase, … }`（旧诊断、提议会话，不出现在对话列表里），以及投影出的 `SessionMetadata.purpose` / `improvement` 和 `summary.json` 的 `improvement`。
  - 账本：`improvementId`、`improvementPhase`、`improverVersion`、`improverScope`、`metaJobId`、`comparisonArm` 字段，以及 `improvement.end` 记录。
  - 配置：项目配置 `improvement` 里的 `feedbackThreshold`、`budget`、`meta`，用户级配置的 `improvement.meta`。它们仍通过校验，但没有代码读它们。`autoImprove` 现在只是 `learning.enabled` 的旧名。
  - 能力门控：候选的 `origin: "improvement"` 与 `jobId`，试验的 `feedbackIds`、`trial.feedback` 与 `TrialVerdict.feedbackPassRate` / `similarPassRate`，决定的 `instanceLiterals`，决定原因 `similar-regression`、`no-similar-cases`、`instance-literal`、`cost-optimized`、`scorer-unreliable`。
- **“换个做法再试”。** `<数据目录>/retries/<id>.json`；项目副本里的 `.nexgent/retry-organization.json`；`turn.start.organization.chosenBy: "retry"`；`turn.rewind.cause: "retry" | "retry-undo"`。契约里已没有 `RetryOrganization`。
- **队友工具。** `spawn_teammate`、`send_message`、`wait_teammates`、`wait_for_message`、`team_task_*` 已删。旧会话里还有 `team.member`（花名册）、`team.task`（任务板）、`team.message`（邮箱，先 `queued` 后 `delivered`）记录和 `executionForm: "team"`，投影与读取照旧接受。`packages/team` 只留邮箱与任务板从这些记录重建状态的纯代码。
- **门控的批准环节。** 含插件的候选，或质量提高但费用比超过 `costApprovalRatio` 的候选，现在记为 `rejected`；`awaiting-approval` 与 `cost-over-cap` 只出现在旧决定里。

## 版本与兼容

| 格式 | 版本字段 | 当前 | 升级方式 |
| --- | --- | --- | --- |
| 会话 JSONL | `session.start.version` | 1 | 新版本写新文件名（`session.v2.jsonl`）；读取方按 `session.start.version` 分派 |
| checkpoint 状态 | `state.version` | 1 | 随会话格式 |
| 账本 | 无记录级字段；文件名 `requests.jsonl` 即 v1 | 1 | 新版本写新文件名（`requests.v2.jsonl`） |
| 项目配置、用户级配置 | `version` | 1 | 读取方拒绝未知版本 |
| 凭证文件 | `version` | 1 | 同上 |
| 材料元数据、成果版本元数据 | `formatVersion` | 1 | 同上 |
| 能力包清单、采用修订、候选、试验收据、决定、快照 | `formatVersion` / `format` | 1 | 同上 |
| 项目身份、用户数据目录索引、授权、迁移记录、自评、练习题、手册操作、手册使用记录 | `formatVersion` | 1 | 同上 |

兼容规则：

- **同版本内只能加可选字段和新记录类型。** 加必填字段、改字段类型、改记录语义都是新版本。
- **读取方忽略未知的可选字段**（同版本的新写入方可以多写）。
- **会话读取方跳过未知的 `type`**：未知记录类型按无效的完整行处理，跳过并在 `skipped` 里报告，行留在文件里，不截断其后的内容；投影可能少了这条记录的作用，读取方据 `skipped` 告诉用户。账本读取方对未知 `type` 跳过并计数。
- **较早写出的数据照常读出。** 缺 `capabilityVersion` 的会话按 `baseline` 理解；只有 token 或次数上限的费用上限照常执行；没有 `learning` 的配置取 `autoImprove` 与 `improvement.shareImproverEvidence` 作默认值；项目内 `.nexgent/` 的数据在迁移完成前照旧在原处读写；已删除功能留下的数据见“旧格式（只为读旧项目）”。
- **不兼容旧 Python 数据**：Python 时代的 Episode、组织 SQLite、PR #4 的 `.nexgent/native/` 不读、不迁移。

## schema 与读写测试

**schema 存放。** 每种格式一份 JSON Schema（draft 2020-12），放在拥有该格式的包里，与本文和契约类型同步修改。项目配置、用户级配置、凭证文件与锁文件没有单独的 schema 文件，由 `@nexgent/kernel` 的校验函数检查（`assertCapabilitiesConfig`、`assertLearningConfig`、`assertUserConfig` 等）。

| 格式 | schema | 拥有包 |
| --- | --- | --- |
| 会话记录（含 checkpoint 状态） | `packages/session/schema/session.v1.schema.json` | `@nexgent/session` |
| 账本记录 | `packages/llm/schema/ledger.v1.schema.json` | `@nexgent/llm` |
| 材料元数据、成果版本元数据 | `packages/session/schema/material.v1.schema.json`、`deliverable.v1.schema.json` | 与会话 schema 共用 `@nexgent/session` 的求值器；写入方是 `@nexgent/tasking` |
| 能力文件与快照 | `packages/session/schema/capabilities.v1.schema.json`（按 `$defs/<name>` 校验，`validateCapabilityFile`） | 与会话 schema 共用求值器；写入方是 `@nexgent/capabilities` |
| 项目身份、用户数据目录索引、授权、迁移记录、自评、练习题、手册操作、手册使用记录 | `packages/session/schema/learning.v1.schema.json`（按 `$defs/<name>` 校验，`validateLearningFile`，种类见 `LEARNING_FILE_DEFS`） | 与会话 schema 共用求值器 |
| 旧改进文件（只读） | `packages/session/schema/improvement.v1.schema.json`（`validateImprovementFile`） | 不再有写入方，见“旧格式（只为读旧项目）” |

schema 用 `oneOf` 按 `type` 分派记录类型，`additionalProperties: false`（账本记录除外：它允许未知可选字段以便跨版本读取）。会话 schema 的严格校验只用于写入方的追加；读取方按上面的兼容规则放过未知的可选字段，不因此截断。

**必测项。**

会话（`@nexgent/session`）：

1. 往返：每种记录类型各一条，写入后 `readAll` 得到逐字段相等的记录；本文的示例行作为 fixture 必须通过 schema 与往返。
2. 截断：写入 N 条记录后在每个换行边界以及若干行中间字节位置截断文件，`readAll` 返回截断点之前的全部完整记录、`truncation` 指向正确的行号与字节偏移；之后 `append` 先写 `error` 记录再写新记录，`seq` 连续。
3. 中间损坏：把中间某行改成非 JSON，该行被跳过并报告，其后的有效行照常读出。
4. checkpoint：写入 M 轮后 `resume` 只重放最后一个 checkpoint 之后的记录（以记录读取计数或时间上限断言）；checkpoint 的 `state` 与从头投影的结果相等。
5. 并发：两个进程（或两个独立的存储实例）对同一会话 `create` / `lock`，恰有一个成功，另一个得到 `session/locked`；陈旧锁（pid 不存活）可被接管。
6. 跨平台：以上在 Linux 与 Windows 上通过，文件使用 `\n` 行尾，路径用 `WorkspaceLayout`。

账本（`@nexgent/llm`）：

1. 每条写出的记录通过 schema；本文示例行作为 fixture。
2. 成功、断网、超时、4xx、5xx、中止各产生恰好一对 start / end，字段符合“必产生记录的失败路径”。
3. 写失败（目录不可写）不改变请求结果，`writeFailures` 递增。
4. `read` 按 `from / to / types / sessionId` 过滤，跨月目录读取顺序正确。

配置与凭证（`@nexgent/kernel`）：

1. 缺文件得默认值；部分字段得补全；未知字段、错误类型、错误版本报 `config/invalid`。
2. profile 补丁的插入、深合并、未知 id、重复 id 四种情形。
3. 凭证读取顺序：环境变量优先于文件；空字符串视为未设置。

资料、成果、目标、压缩记录（`@nexgent/session`）：

1. 这些记录各一条写入后 `readAll` 逐字段相等，并通过 schema；投影出的 `goal`、`lastCompactionSeq` 与压缩后的 `messages` 符合上面的投影表。
2. 不合格的 `compaction`（保留段越界或以工具结果开始）与 `goal.update`（目标 ID 不符）在写入前被拒，文件不变。
3. 早期写出的真实会话（夹具 `packages/session/tests/fixtures/step1-real-session.jsonl`）能被读出、恢复，并能在其后追加新记录。
4. `material.json` 与 `deliverable.json` 读写往返并通过 schema；含 `\` 的路径、大写或长度不对的 SHA-256 被拒。

成员与工作流记录（`@nexgent/session`）：

1. `subagent.*`、`workflow.*`、`fork.seed` 各一条写入后 `readAll` 逐字段相等并通过 schema；父会话里的这些记录不改变投影出的消息。
2. 子会话的 `session.start.member` 与 `fork.seed` 往返，恢复后 `parentSessionId`、`member` 与 fork 历史一致；`fork.seed` 出现在消息之后、只给 `parentSessionId` 不给 `member` 时写入被拒。
3. 成员名、`executionForm`、`MemberResult.status`、`architecture` 哈希的非法值被 schema 拒绝。

能力记录与文件（`@nexgent/session`、`@nexgent/kernel`）：

1. `capability.*` 会话记录各一条写入后逐字段相等并通过 schema，不改变投影出的消息；`session.start.capabilityVersion` 与 `capability.version` 投影到 `metadata.capabilityVersion`；没有该字段的旧会话照常读出与恢复。
2. 十二种能力文件各有合格与不合格样例；`context-policy` 带 `approvals`、`costCaps`、`sandboxMode`、`capabilities` 时被拒；发布的 `capabilities.v1.schema.json` 与源一致。
3. 账本 `capability.decision` 与 `task.outcome` 的新字段通过 schema；本文账本示例行包含 `capability.decision`。
4. `canonicalManifestText` 与组件、文件顺序无关；`assertCapabilityManifest`、`isNextRevision`、`decideTrial` 每个分支、`decideUsageRollback`、`assertCapabilitiesConfig` 的下限有运行时测试。

学习与费用（`@nexgent/session`、`@nexgent/kernel`、`@nexgent/llm`、`@nexgent/workspace`、`@nexgent/sdk`）：

1. `learning.v1.schema.json` 的各种文件有合格与不合格样例（`usage.jsonl` 行含没有抽签记录的旧行，结局来源不收自评），发布的文件与源一致；每个枚举与 kernel 常量逐项相等；手册日志的五种操作往返并折叠。
2. `cost.warning`、`learningPhase`、`attempt`、`usageEstimated` 以写入方的严格校验通过；手写 `ledger.v1.schema.json` 的 `learningPhase`、决定原因、`cost.warning` 枚举与 kernel 常量相等；本文账本示例行包含 `cost.warning` 与学习记录；`turn.start.handbook` 往返，旧的 `turn.start` 照常通过。
3. 旧数据：只有 token 上限的配置、只有 `autoImprove` / `shareImproverEvidence` 的配置、没有迁移记录的项目（`resolveDataLocation`）照常读出；两个配置读取方接受并校验 `learning`、`perConversation`、`maxUsd`。
4. `costCapLevel`、`combineScore`、`selfEvalOutcome`、`selfEvalSample`、`scorerReliability`、`practiceSplit`、`foldHandbook`、`applyTextEdits`、`numberLines`、`isConcurrentTool`、`scheduleToolCalls` 有运行时测试。

契约层（`packages/kernel/tests/contracts/`）：类型级断言固定记录集合与公共字段，纯函数（`addUsage`、工具限制交集、布局解析、profile 补丁）有运行时测试。

