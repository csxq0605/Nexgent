# 数据与文件格式规范

> 步骤 1 章节（目的与范围、目录布局、项目配置、会话 JSONL v1、账本记录、版本与兼容、schema 与测试）已写定；步骤 2 第 1 轮补上会话的七种新记录、材料元数据、成果元数据，并新增反馈、持久目标、压缩三节；`CapabilityBundle` 清单留标题，在步骤 4 填写。步骤 3 第 1 轮补上子会话、团队、工作流的九种新记录与 `session.start.member`、账本的 `team` 形态与 `formsUsed`、成果的成员字段，并新增子会话与成员、团队、工作流、预设、架构图存储五节（决策见 ADR 0004；类型镜像 `collaboration.ts`）。每种格式配 JSON schema 与读写测试，二者与本文同步改。本文的类型镜像在 `packages/kernel/src/contracts/`（`session.ts`、`ledger.ts`、`config.ts`、`workspace.ts`、`credentials.ts`、`tasking.ts`、`context.ts`），两处不一致时以本文为准并提契约修改 PR。来源：计划 4.10 第 1 行；分工见 `docs/plan/step-1-work-partition.md` 与 `docs/plan/step-2-work-partition.md`；loop 中各记录的写入时机见 `agent-hooks.md`。

## 目的与范围

定义 `.nexgent/` 下所有持久化文件的格式，使会话、账本、能力版本、材料与成果能跨进程、跨版本读回；另定义本机凭证文件的位置与形状（它不在项目目录内，但由同一套读写原语处理）。

适用范围：

- `@nexgent/session` 写入与恢复的会话文件；
- `@nexgent/llm` 写入的请求账本，以及 `apps/cli` 在任务结束时写入的 `task.outcome`；
- `@nexgent/kernel` 读取的项目配置文件与凭证文件；
- `@nexgent/workspace` 负责创建与定位的目录布局。

共同约束：

1. **只追加。** 会话与账本文件都是 JSON Lines：一行一个 JSON 对象，UTF-8，无 BOM，行以 `\n` 结束。写入方只在文件尾追加，不改写已有行；唯一的例外是恢复时对损坏尾部的截断（见“追加与截断规则”）。
2. **每行自描述。** 每条记录都带 `type` 与时间戳；会话记录还带 `seq` 与 `sessionId`，任何一行脱离文件都能被归位。
3. **只写 JSON 能表示的值。** `undefined`、函数、`NaN`、循环引用在写入前被拒绝（`isJsonValue`），不会在磁盘上以 `null` 或缺字段的形式悄悄出现。
4. **账本不记内容。** 账本记录的类型里没有提示正文、消息内容、工具参数、工具输出、密钥、带凭证的 URL 的字段，因此写不进去；会话记录记内容，但不记密钥。
5. **只有 v1。** 不迁移 Python 时代的数据（ADR 0001 决策 15），也不为旧格式写读取器。

时间戳统一为 ISO-8601 UTC 字符串（`2026-10-07T08:00:00.000Z`），毫秒精度。标识符（会话 ID、请求 ID、工具调用 ID）为字符串；Nexgent 自己生成的用小写 UUID v4，模型返回的（工具调用 ID）原样保留。

## `.nexgent/` 目录布局

项目根目录下的 `.nexgent/` 是 Nexgent 在该项目中的全部数据。`@nexgent/workspace` 的 `Workspace.ensureLayout()` 在第一次运行时创建它和全部子目录，创建是幂等的；其他包只写自己的子目录。

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
    ├── presets/                          项目预设（用户创建，可选；本文“预设”，步骤 3）
    │   └── <name>.json
    ├── architectures/                    保存的工作流图（本文“架构图存储”，步骤 3）
    │   └── <sha256>.json
    ├── capabilities/                     能力版本（本文“CapabilityBundle 清单”起四节，步骤 4）
    │   ├── <version>/                    一个能力包：manifest.json 与各组件目录
    │   ├── activation/<n>.json           采用历史链
    │   ├── candidates/<candidateId>/     候选：candidate.json 与提出的组件文件
    │   ├── trials/<trialId>.jsonl        门控试验收据（旁路文件 .attempt / .lock / .log 见“候选与门控”）
    │   ├── decisions/<decisionId>.json   采用、拒绝、待批准、回滚的结论
    │   └── drafts/<sessionId>/           会话的草稿组件
    ├── snapshots/                        任务快照与检查（本文“任务快照与检查”，步骤 4）
    │   ├── objects/<sha256>              文件内容，每份一次
    │   ├── trees/<sha256>.json           快照树
    │   ├── tasks/<taskId>[.t<turn>].json 根任务（步骤 5 起每个根轮）开始时的快照记录
    │   └── checks/<taskId>[.t<turn>].json 根任务（步骤 5 起每个根轮）结束时的检查记录
    ├── improvements/                     改进作业（本文“改进作业”，步骤 5；元改进作业见“元改进作业”，步骤 6）
    │   ├── queue.json                    触发队列（已计入的信号；步骤 6 起也记计入元改进的作业）
    │   ├── queue.lock                    改写队列时的独占锁
    │   └── <jobId>/                      一个作业：job.json、diagnosis.json、job.lock、job.json.lock、job.log；
    │                                     元改进作业另有 meta-diagnosis.json、change.json、comparison.json
    └── improvers/                        改进器版本（本文“改进器版本”，步骤 6）
        ├── bundles/<version>.json        一个改进器（规范化文本，SHA-256 即版本号）
        └── activation/<n>.json           改进器采用历史链
```

| 路径 | 内容 | 命名 | 创建者 | 写入者 |
| --- | --- | --- | --- | --- |
| `config.json` | 项目配置 | 固定 | 用户或 `nexgent run` 首次运行（写入默认值） | 用户、桌面应用（步骤 2） |
| `sessions/<sessionId>/` | 一个会话的全部文件 | `sessionId` 为小写 UUID v4 | `SessionStore.create` | `@nexgent/session` |
| `sessions/<sessionId>/session.jsonl` | 会话记录 | 固定 | 同上 | 同上 |
| `sessions/<sessionId>/.lock` | 锁文件 | 固定 | `SessionStore.create` / `lock` | 同上 |
| `ledgers/<yyyy-mm>/requests.jsonl` | 该月（UTC）的全部账本记录 | 月份取记录 `ts` 的 UTC 年月 | 第一次追加时 | `@nexgent/llm`（请求与工具记录）、`apps/cli`（`task.outcome`） |
| `materials/<materialId>/` | 一份资料：元数据与副本 | `materialId` 为小写 UUID v4 | `MaterialStore.add` | `@nexgent/tasking`（宿主），模型只读 |
| `outputs/<deliverableId>/v<n>/` | 一个成果的第 n 版：元数据与快照 | `deliverableId` 为小写 UUID v4，`n` 从 1 起 | `DeliverableStore.present` | `@nexgent/tasking`（宿主），模型只读 |
| `skills/<name>/SKILL.md` | 项目技能 | `name` 见 `agent-hooks.md` §技能 | 用户 | 用户；模型只读 |
| `presets/<name>.json` | 项目预设（步骤 3） | `name` 见“预设” | 用户 | 用户；模型只读 |
| `architectures/<sha256>.json` | 工作流图（步骤 3） | 规范化图的 SHA-256 | 第一次保存时 | `@nexgent/workflow`（宿主）；模型只读 |
| `capabilities/` | 能力包、采用历史、候选、试验、决定、草稿（步骤 4） | 见“CapabilityBundle 清单”起四节 | `ensureLayout` | `@nexgent/capabilities`（宿主）；模型的文件工具读写都拒绝 |
| `snapshots/` | 任务快照与检查（步骤 4） | 内容寻址，见“任务快照与检查” | `ensureLayout` | `@nexgent/capabilities`（宿主）；模型的文件工具读写都拒绝 |
| `improvements/` | 改进作业的队列、作业记录与诊断（步骤 5）；元改进作业的诊断、改动与比较（步骤 6） | `jobId` 为小写 UUID v4，见“改进作业”“元改进作业” | 第一次计入信号或开始作业时 | `@nexgent/evolve`（宿主）；模型的文件工具读写都拒绝 |
| `improvers/` | 改进器版本与采用历史（步骤 6） | 见“改进器版本” | 第一次写入子改进器时（只用内置 `v0` 的项目没有这个目录） | `@nexgent/capabilities` 的 `ImproverStore`（宿主；由 `@nexgent/evolve` 与 `@nexgent/sdk` 调用）；模型的文件工具读写都拒绝 |

规则：

- `.nexgent/` 内部对模型可见的文件工具按子目录区分：`sessions/`、`ledgers/`、`capabilities/`、`snapshots/`、`improvements/`、`improvers/`（步骤 6）读写都拒绝，`materials/`、`outputs/`、`skills/`、`presets/`、`architectures/` 与 `config.json` 只读（`outputs/` 自步骤 2 起改为只读，快照只由宿主写）；规则以 `permissions.md` §路径策略与写入限制为准。
- 所有路径在服务内部以绝对路径处理（`WorkspaceLayout`）；记录里出现的路径（如 `session.start.projectRoot`）也是绝对路径。
- 是否纳入版本控制由项目自己决定；建议忽略 `sessions/`、`ledgers/`、`outputs/`、`snapshots/`，保留 `config.json`；`capabilities/` 是否入库由项目决定（入库后换机器也能用同一能力版本）。
- 本机凭证文件不在项目内：`~/.nexgent/credentials.json`（Windows 为 `%USERPROFILE%\.nexgent\credentials.json`），形状见“项目配置文件”末尾。

## 项目配置文件

文件：`.nexgent/config.json`，一个 JSON 对象。文件不存在等同于 `{}`；每个字段都有默认值。启动时读取一次，运行中不热加载。密钥不写在这里。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `version` | `1` | `1` | 格式版本；只有 1 |
| `model` | string | `"claude-sonnet-5-5"` | 传给端点的模型 ID（ADR 0002） |
| `endpoint` | string | `"https://api.anthropic.com"` | Claude API 的 base URL，不含路径与凭证；环境变量 `NEXGENT_API_BASE_URL` 可覆盖 |
| `thinking` | `"off" \| "on"` | `"on"` | 执行时是否开启 reasoning；`on` 是自适应 thinking，`off` 是 provider 的最低 thinking 设置（ADR 0002 决策 3 的映射；默认值按 ADR 0003 为 `on`） |
| `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | 推理深度（`output_config.effort`） |
| `sandboxMode` | `"read-only" \| "workspace-write" \| "full-access"` | `"workspace-write"` | 新会话的默认沙箱模式；语义见 `permissions.md` |
| `costCaps.perTask` | `CostCap` | 无 | 每任务上限 |
| `costCaps.perProject` | `CostCap` | 无 | 每项目上限 |
| `approvals` | `ApprovalGrant[]` | `[]` | `project` 范围的审批授权；语义见 `permissions.md` |
| `extraReadRoots` | `string[]` | `[]` | 额外可读的绝对目录；语义见 `permissions.md` |
| `autoImprove` | boolean | `true` | 步骤 5：计入的反馈与失败的检查是否自动开始改进作业（ADR 0006；步骤 4 之前默认 `false`，从未生效）；显式“改进”不受它限制；改动它总要审批 |
| `capabilities` | `CapabilitiesConfig` | 见下 | 门控与回滚设置（步骤 4）；改动它总要审批（`permissions.md` §工具审批） |
| `improvement` | `ImprovementConfig` | 见下 | 步骤 5：触发阈值、改进预算、诊断与提案的模型；改动它总要审批 |

`CapabilitiesConfig`（步骤 4，契约 `capabilities.ts`，校验 `assertCapabilitiesConfig`）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `autoTrial` | boolean | `true` | 提出候选的任务结束后自动在独立进程里跑门控（决定 3） |
| `trialBudget` | `{ maxTokens?, maxRequests? }` | `{ maxRequests: 400, maxTokens: 8000000 }` | 一次试验（全部运行与评审）的预算，计法同 `CostCap` |
| `selectionCases` | integer ≥ 2 | `2` | 选择集用例数；历史任务不够时门控等待，不降低要求 |
| `guardCases` | integer ≥ 1 | `1` | 守护集用例数 |
| `repeats` | 1–5 | `2` | 每个用例每个臂的运行次数 |
| `costRatioCap` | 1–10 | `1.2` | 质量打平时，评审偏好候选、且费用比不超过它才采用（ADR 0007：不再限制质量提高） |
| `costApprovalRatio` | 1–10 | `2` | ADR 0007：质量提高但费用比超过它时不自动采用，改为等用户批准 |
| `reviewer` | `{ model, thinking }` | `{ "model": "claude-sonnet-5-5", "thinking": "on" }` | 评审模型，可改为 `claude-opus-5-5`（决定 5）；只在检查打平时起作用 |
| `rollback.windowTasks` | 1–20 | `3` | 采用后观察的根任务数（决定 6） |
| `rollback.consecutiveErrors` | 1–20 | `3` | 新组件连续出错多少次即回滚 |

下限是硬下限：`selectionCases: 1`、`guardCases: 0` 报 `config/invalid`。

`ImprovementConfig`（步骤 5，契约 `improvement.ts`，校验 `assertImprovementConfig`，未知字段报 `config/invalid` 并在 `details.field` 写出字段路径）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `feedbackThreshold` | 1–20 | `3` | 计入多少个信号开始一个作业（计划 4.9 #7） |
| `budget.maxTokens` | integer ≥ 1 | `3000000` | 一个时间窗内全部改进费用的上限，按计费 token 计：`inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`（改进会话以缓存读为主，所以不同于 `CostCap` 只计输入 + 输出）；按 ADR 0002 价目、以缓存读为主的用量约每百万 token 1 美元，默认值约合 3 美元，只是显示用的估算 |
| `budget.windowDays` | 1–365 | `30` | 时间窗天数，按账本记录 `ts` 往前滚动 |
| `model` | string | `"claude-sonnet-5-5"` | 诊断与提案会话的模型，可改为 `claude-opus-5-5`（决定 5）；门控的评审模型仍是 `capabilities.reviewer` |
| `thinking` | `"off" \| "on"` | `"on"` | 诊断与提案会话是否开 thinking；步骤 6 起元诊断与元提案会话也按它 |
| `meta.enabled` | boolean | `false` | 步骤 6：是否每完成 `everyJobs` 个作业自动开始一个元改进作业（ADR 0008 决定 3，产品默认关）；显式元改进（`improvements.runMeta`）不受它限制，但受元改进预算限制 |
| `meta.everyJobs` | 1–20 | `3` | 多少个结束的作业开始一个元改进作业；计入的结局见“元改进作业” |
| `meta.budget.maxTokens` | integer ≥ 1 | `6000000` | 元改进预算，计法同 `budget.maxTokens`；默认约合 6 美元，只是显示用的估算 |
| `meta.budget.windowDays` | 1–365 | `30` | 元改进预算的时间窗 |
| `meta.model` | string | `"claude-sonnet-5-5"` | 元诊断与元提案会话的模型，可改为 `claude-opus-5-5` |

预算是时间窗内创建的全部作业的 `phases` 之和（诊断、提议、该作业所发的门控试验；各阶段由带该作业 `improvementId` 的账本记录求和），用量未知的字段按 0 计，总数因而是下限。用尽时进行中的作业以 `budget-exhausted` 结束，新的作业（含显式“改进”）在时间窗滚出足够余量或用户调高之前不开始（`improvement/budget-exhausted`）。

步骤 6 起两份预算分开计：`budget` 只算能力改进作业（`kind` 缺省或 `capability`，不含比较臂）；`meta.budget` 算时间窗内创建的元改进作业的 `phases`，其中 `compare` 是父子两臂（各自的诊断、提议、试验）之和。元改进预算用尽时进行中的元改进作业以 `budget-exhausted` 结束，比较中断的臂按“未知”算，不采用子改进器。`improvement` 整个对象（含 `meta`）不能由能力组件、改进器或改进作业改写（`permissions.md` §元改进会话与元改进预算）。

`CostCap`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `maxTokens` | number | 输入 + 输出 token 上限；超过时当前轮以 `cost-cap` 取消 |
| `maxRequests` | number | 模型请求次数上限（含失败的请求） |
| `windowDays` | number | 仅 `perProject`：按账本累加的时间窗，默认 30 |

计数方式与达到上限的行为见 `permissions.md` §费用上限。步骤 1 执行 `perTask`；`perProject` 只定格式，产品设置页在步骤 2。

示例：

```json
{
  "version": 1,
  "model": "claude-sonnet-5-5",
  "endpoint": "https://api.anthropic.com",
  "thinking": "on",
  "effort": "medium",
  "sandboxMode": "workspace-write",
  "costCaps": { "perTask": { "maxRequests": 50 } },
  "autoImprove": true,
  "improvement": { "budget": { "maxTokens": 4000000 } }
}
```

读取规则：未知字段报 `config/invalid`（防拼写错误）；类型不符报 `config/invalid`；`version` 不是 1 报 `config/invalid`。缺字段补默认值（`resolveProjectConfig`）。

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
| `session.start` | 创建会话时，必为 `seq: 1` | `version: 1`、`projectRoot`、`model`、`sandboxMode`、`parentSessionId?`、`title?`、`member?`（步骤 3，子会话必有，与 `parentSessionId` 同时出现）、`capabilityVersion?`（步骤 4，会话打开时采用中的能力版本）、`purpose?`（步骤 5，`"task" \| "improvement"`，缺省即 `task`）、`improvement?`（步骤 5，`{ jobId, phase: "diagnose" \| "propose" }`，当且仅当 `purpose` 为 `improvement` 时出现） |
| `turn.start` | 一轮开始（一条用户消息及其触发的全部模型调用与工具调用） | `turn` |
| `user.message` | 用户消息进入会话，或注入的合成上下文，或反馈轮的提示 | `turn`、`content`、`source: "user" \| "inject" \| "feedback"`、`materials?`（步骤 2） |
| `assistant.message` | 一次模型调用的流结束（含被取消的流） | `turn`、`step`、`requestId`、`content`、`toolCalls?`、`usage`、`finishReason`、`interrupted?`、`providerContent?`、`refusal?` |
| `tool.result` | 一次工具调用返回 | `turn`、`step`、`toolCallId`、`name`、`content`、`isError`、`error?`、`meta?`、`durationMs` |
| `turn.end` | 一轮结束 | `turn`、`reason` |
| `checkpoint` | 见“checkpoint” | `coversSeq`、`state` |
| `error` | 不属于某条 `turn.end` / `tool.result` 的失败（如账本写失败、恢复时的截断、费用上限） | `turn?`、`error`、`fatal` |
| `approval.request` | 一次工具调用需要审批 | `turn`、`request: ApprovalRequest` |
| `approval.decision` | 审批得到应答（含超时、取消、非 TTY 拒绝） | `turn`、`decision: ApprovalDecision` |
| `approval.grant` | 用户选择 `session` 范围放行，紧跟对应的 `approval.decision` | `grant: { tool, pattern?, grantedAt }` |
| `material.added`（步骤 2） | 宿主把一份资料复制进 `materials/` 后 | `turn?`、`material: MaterialRef` |
| `deliverable.presented`（步骤 2） | `present` 生成一个成果版本后，在该调用的 `tool.result` 之前 | `turn`、`step`、`toolCallId`、`deliverable: DeliverableVersionRef` |
| `turn.files`（步骤 2） | 每轮 `turn.end` 之前（装了文件追踪时，空列表也写） | `turn`、`changes: FileChange[]`、`omitted?` |
| `feedback`（步骤 2） | 反馈轮的 `turn.start` 之后 | `turn`、`feedback: FeedbackEntry` |
| `goal.set`（步骤 2） | 宿主设定持久目标 | `turn?`、`goal: Goal` |
| `goal.update`（步骤 2） | 宿主更新目标状态或文本 | `turn?`、`goalId`、`status`、`text?`、`note?` |
| `session.title`（步骤 2） | 用户给对话改名（`sessions.rename`） | `turn?`、`title`（非空，宿主已去掉首尾空白） |
| `compaction`（步骤 2） | 压缩成功后、使用压缩历史的那次模型请求之前 | `turn`、`step`、`summary`、`keepMessages`、`compactedMessages`、`requestId`、`usage`、`trigger: { inputTokens, threshold }` |
| `fork.seed`（步骤 3） | fork 子会话创建后，必为 `seq: 2` | `fromSessionId`、`throughSeq`、`messages` |
| `subagent.start`（步骤 3） | 父会话里一次成员运行开始 | `turn`、`toolCallId?`、`childSessionId`、`childTurn`、`name`、`executionForm`、`mode?`、`preset?`、`workflowId?`、`task`（≤500 字符）、`materialIds?` |
| `subagent.end`（步骤 3） | 父会话里一次成员运行结束（恢复时补 `interrupted`） | `turn`、`childSessionId`、`childTurn`、`result: MemberResult` |
| `team.member`（步骤 3） | Lead 会话里队友加入或状态变化 | `turn?`、`member: TeamMember` |
| `team.task`（步骤 3） | Lead 会话里任务板新建或更新一项 | `turn?`、`task: TeamTask` |
| `team.message`（步骤 3） | Lead 会话里一条邮箱消息排队或投递 | `turn?`、`message: TeamMessage` |
| `workflow.start`（步骤 3） | 父会话里 `workflow` 调用开始 | `turn`、`toolCallId`、`workflowId`、`kind: "script" \| "graph"`、`architecture?`、`title?` |
| `workflow.phase`（步骤 3） | 脚本调用 `phase(name)` | `turn`、`workflowId`、`phase` |
| `workflow.end`（步骤 3） | 工作流结束（恢复时补 `interrupted`） | `turn`、`workflowId`、`status`、`members`、`error?` |
| `capability.version`（步骤 4） | 会话的能力版本变化：恢复时记录的版本缺失或校验失败（`unavailable`），或打开时装载失败（`load-failure`） | `turn?`、`version`、`previous`、`reason`、`detail?` |
| `capability.draft`（步骤 4） | `capability_draft` 改动草稿区的一个组件后，在该调用的 `tool.result` 之前 | `turn`、`step`、`toolCallId`、`component: { kind, name }`、`files: CapabilityFile[]`、`revision` |
| `capability.try`（步骤 4） | `capability_try` 把草稿组件装进本会话后 | `turn`、`step`、`toolCallId`、`component`、`revision`、`tools?` |
| `capability.propose`（步骤 4） | 宿主接受 `capability_propose` 提出的候选后 | `turn`、`step`、`toolCallId`、`candidateId`、`proofs: ComponentUseProof[]` |

字段细则：

- `assistant.message.toolCalls[]`：`{ id, name, arguments }`，`arguments` 是模型产出的原始 JSON 文本，不在此处解析。
- `assistant.message.usage`：`LLMUsage`，六个字段 `inputTokens / outputTokens / totalTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens` 每个都是非负整数或字符串 `"unknown"`；provider 没报用量时全为 `"unknown"`，不写 0。`inputTokens` 只是未命中缓存的输入，计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`；`totalTokens` = 输入 + 输出 + 缓存读 + 缓存写。`cacheWriteTokens` 是后加的字段，schema 中为可选：没有它的旧记录读出时按 `"unknown"` 补上，新写入的记录总是带它。
- `assistant.message.finishReason`：`stop | tool-calls | max-tokens | aborted | refusal | pause | error`。`refusal` 时附 `refusal: { category?, explanation? }`，该回复的工具调用不执行。`pause`（步骤 2）对应 Claude 的 `stop_reason: "pause_turn"`：回复照常记录（含 `providerContent`），loop 把它原样带回、再发一次请求让模型接着做，同一轮内的续跑次数有上限，超过时以可读错误结束轮次；账本 `llm.request.end` 的 `status` 为 `ok`、`finishReason` 为 `pause`。
- `assistant.message.providerContent`：provider 返回的内容块原样（JSON），用于回放时保留 thinking 块（ADR 0002 决策 4）；provider 没给则不写。
- `assistant.message.interrupted: true`：该轮在流中被取消，`content` 是已流出的前缀，`toolCalls` 不写（未派发的调用不进入历史）。
- `tool.result.error`：`ErrorInfo = { name, code, message, details? }`，仅当 `isError` 为真；`meta` 是工具私有的 JSON 值（如 diff），原样持久化。
- `max-tokens` 且回复含工具调用时：工具调用记录在案但不执行，轮次以 `{ kind: "max-tokens" }` 结束；下一次请求由历史修复以合成的错误结果答复这些调用。
- `turn.end.reason`：`{ kind: "completed" }`、`{ kind: "cancelled", cause: "user" | "timeout" | "shutdown" | "cost-cap" | "parent" }`（`parent` 是步骤 3 新增：父会话的轮次取消或结束，成员随之取消）、`{ kind: "error", error: ErrorInfo }`、`{ kind: "max-tokens" }`、`{ kind: "interrupted" }`。最后一种只由恢复过程写出，用来关闭上一个进程没来得及关闭的轮次。
- `error.fatal`：为真表示会话不能继续；恢复时遇到最后一条是 fatal 的 `error`，`resume` 仍返回状态，由调用方决定是否继续。
- `user.message.source`（步骤 2 增加 `feedback`）：`user` 是用户输入；`inject` 是合成上下文（资料引用、提供者注入），界面不显示；`feedback` 是反馈轮的提示，正文为 `renderFeedbackPrompt(feedback)`。`materials` 是本条消息引用的资料 ID（仅 `user` / `feedback` 消息），界面据此显示资料标签。
- 步骤 2 记录里的路径一律是项目相对路径、`/` 分隔（`MaterialRef.path`、`DeliverableFile.path`、`FileChange.path`），schema 拒绝含 `\` 的路径；两平台写出的记录可以直接比较。SHA-256 一律小写十六进制 64 位。
- `turn.files.changes`：按 `path` 排序，`change` 为 `added | modified | deleted`；最多 1000 条（`TURN_FILES_LIMIT`），超出部分只计数在 `omitted`。比较范围是项目根下除 `.nexgent/`、`node_modules/`、`.git/` 外的全部文件；同一路径先增后删不列出。
- `goal.update.goalId` 必须是当前目标的 ID；`compaction.keepMessages` 不能超过当时的消息数，且保留段必须以 `user` 消息开始。这两条单条 schema 表达不了，`SessionStore.append` 在写入前用投影检查，不合格的记录抛 `session/invalid-record`、不落盘。

一轮的记录顺序固定为：`turn.start` → `user.message` → （`assistant.message` → `tool.result`×n）×steps → `turn.end`。需要审批的调用在其 `tool.result` 之前插入 `approval.request` → `approval.decision`（→ `approval.grant`）。`ApprovalRequest` / `ApprovalDecision` 的字段见 `permissions.md`。`step` 从 1 起，在轮内递增。

步骤 2 在这条顺序里插入（详见 `agent-hooks.md` §一轮的顺序）：

```text
turn.start → [feedback] → user.message(inject)* → user.message(user|feedback)
  → ( [compaction] → assistant.message → ( [approval.*] → [deliverable.presented] → tool.result )* )*
  → turn.files → turn.end → [checkpoint]
```

`material.added`、`goal.set`、`goal.update`、`session.title` 由宿主写，可以出现在两轮之间，也可以出现在一轮之中（此时带 `turn`）。

步骤 3 的记录归属：`fork.seed` 只由 kernel 在建子会话时写；`subagent.start`、`workflow.start` 由发起它们的工具经 `ToolContext.appendRecord` 写在该调用的 `tool.result` 之前；`subagent.end`、`team.*`、`workflow.phase`、`workflow.end` 既可由工具写，也可由协作包以宿主身份写（队友之间的邮件、恢复时的补记发生在 Lead 的工具调用之外），宿主写时带当时的 `turn`。白名单见契约 `ToolRecordType` / `HostRecordType`。

步骤 4 的记录归属：`capability.draft` / `try` / `propose` 只由对应工具经 `ToolContext.appendRecord` 写（`ToolRecordType`）；`capability.version` 由宿主写（`HostRecordType`）。这四种记录都不改变投影出的消息；投影把 `session.start.capabilityVersion` 与最新一条 `capability.version.version` 放进 `SessionMetadata.capabilityVersion`。`capabilityVersion` 缺省的会话（步骤 3 及以前写出的）按 `baseline` 理解。

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
{"type":"checkpoint","seq":8,"ts":"…","sessionId":"6f1c…","coversSeq":7,"state":{"sessionId":"6f1c…","version":1,"messages":[{"role":"user","content":"把 README 第一行改成 Hello"},{"role":"assistant","content":"","toolCalls":[{"id":"call_1","name":"str_replace","arguments":"{…}"}]},{"role":"tool","toolCallId":"call_1","name":"str_replace","content":"replaced 1 occurrence","isError":false},{"role":"assistant","content":"已改好。"}],"metadata":{"createdAt":"2026-10-07T08:00:00.000Z","projectRoot":"/home/u/proj","model":"claude-sonnet-5-5","sandboxMode":"workspace-write","grants":[],"lastTurn":1,"totalUsage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","cacheWriteTokens":"unknown","reasoningTokens":"unknown"},"lastSeq":7}}}
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
3. 写入前校验：值是 JSON 安全的（`isJsonValue`）、`type` 是已知类型、`seq` 等于上一条 +1。校验失败抛 `session/invalid-record`，不写。

一行**有效**当且仅当同时满足：

- 以 `\n` 结束（文件最后一行没有 `\n` 即无效——这是 `kill -9` 留下半行的典型形态）；
- 能解析为 JSON 对象；
- `type` 是已知类型且专有字段通过 schema；
- `seq` 等于前一有效行的 `seq` + 1（第一行必须是 `seq: 1` 的 `session.start`）；
- `sessionId` 与文件所属会话一致。

恢复（`readAll`）：

1. 从文件头顺序读，逐行校验；
2. 遇到第一条无效行即停止，返回已读到的全部有效记录和 `truncation = { line, byteOffset, reason }`（`line` 为 1 起的行号，`byteOffset` 为该行起始字节）；
3. 无效行之后的内容一律丢弃，即使它们本身能解析——因为 `seq` 已断，后面的记录无法可靠归位；
4. 恢复不崩溃：任何损坏的文件都返回一个（可能为空的）记录列表加截断信息；只有 `session.start` 都读不出时才抛 `session/corrupt`。

截断：持锁的写入者在下一次 `append` 之前把文件截到 `truncation.byteOffset`，然后先追加一条 `error` 记录（`code: "session/corrupt"`，`fatal: false`，`message` 写明丢弃的行号与原因），再追加调用方的记录。这样丢弃的事实留在文件里，`seq` 从最后一条有效记录继续。

### checkpoint

- **触发**：写 `turn.end` 时，若自上一个 checkpoint（或文件头）起已写入 ≥ N 条记录（默认 N=50，可配置），紧接着写一条 `checkpoint`；会话存储关闭时若有新记录也写一条。`turn.end` 与它的 `checkpoint` 之间不会插入其他记录。
- **内容**：`coversSeq` 是它前一条记录的 `seq`（即自身 `seq` − 1）；`state` 是把 `seq ≤ coversSeq` 的全部记录投影得到的完整 `SessionState`。多个 checkpoint 可以共存，最新的有效。
- **大小**：checkpoint 是整份状态的副本，文件会随之增长；步骤 1 接受这一点，不做压缩。

### 恢复算法（`resume`）

1. `readAll`，得到有效记录与可能的截断信息。
2. 找最后一条 `checkpoint`；有则 `state = checkpoint.state`，起点 `seq = coversSeq`；没有则 `state` 为空状态（只有 `session.start` 给出的元数据），起点 `seq = 1`。
3. 按顺序把 `seq` 大于起点的记录投影进 `state`（投影规则见下表）；checkpoint 之前的记录不重放——这是性能测试的上限依据。
4. 若 `state.metadata.openTurn` 有值（上一个进程在轮中死亡）：持锁的调用方追加 `turn.end { kind: "interrupted" }`，再更新状态；只读的调用方只在返回的状态里保留 `openTurn`。
5. 返回 `SessionState`：`messages` 是 LLM 请求形式的历史（`user / assistant / tool` 三种角色；系统提示不存储，由 kernel 每次重新组装），`metadata` 见下。

投影规则：

| 记录 | 对 `messages` | 对 `metadata` |
| --- | --- | --- |
| `session.start` | 无 | `createdAt`、`projectRoot`、`model`、`sandboxMode`、`title`；`lastTurn = 0`；`grants = []`；`totalUsage` 置为全 0（`ZERO_USAGE`，加法单位元） |
| `turn.start` | 无 | `lastTurn = turn`，`openTurn = turn` |
| `user.message` | 追加 `{ role: "user", content }` | 无 |
| `assistant.message` | 追加 `{ role: "assistant", content, toolCalls?, providerContent? }`；`interrupted` 且 `content` 为空时不追加 | `totalUsage = addUsage(totalUsage, usage)`（任一字段 `"unknown"` 则和为 `"unknown"`） |
| `tool.result` | 追加 `{ role: "tool", toolCallId, name, content, isError }` | 无 |
| `turn.end` | 无 | 清除 `openTurn` |
| `checkpoint` | 从头重放时整体替换 `state` | 同左 |
| `error` | 无 | 无 |
| `goal.set`（步骤 2） | 无 | `goal = record.goal`（替换旧目标） |
| `goal.update`（步骤 2） | 无 | `goal.status = status`；给了 `text` 则替换；给了 `note` 则替换；`goal.updatedAt = record.ts` |
| `session.title`（步骤 2） | 无 | `title = record.title`（覆盖 `session.start` 的标题） |
| `compaction`（步骤 2） | `messages = [{ role: "user", content: renderCompactionSummary(summary) }, ...messages 的最后 keepMessages 条]` | `lastCompactionSeq = seq` |
| `material.added`、`deliverable.presented`、`turn.files`、`feedback`（步骤 2） | 无 | 无 |
| 任意记录 | — | `lastSeq = seq` |

`SessionMetadata` 字段：`createdAt`、`projectRoot`、`model`、`sandboxMode`、`grants`、`title?`、`lastTurn`、`openTurn?`、`totalUsage`、`lastSeq`；步骤 2 增加可选的 `goal?`（`Goal`）与 `lastCompactionSeq?`。步骤 1 写出的 checkpoint 没有这两个字段，读出时视为未设置。

### 并发写保护

- 锁文件 `sessions/<sessionId>/.lock`，内容为 JSON：`{ "pid": 12345, "ts": "2026-10-07T08:00:00.000Z", "host": "my-laptop" }`。
- 取锁用独占创建（`open` 带 `wx`）；创建失败时读出现有内容：`host` 相同且 `pid` 不存活视为陈旧锁，覆盖接管；否则抛 `session/locked`（`details` 带现有锁的 `pid`、`ts`）。
- 锁在写入进程的整个生命周期内持有，`release` 删除文件；进程异常退出留下的锁由上述陈旧检测处理。
- `append` 要求调用方持有本进程取得的锁，否则抛 `session/locked`；`readAll` / `latestCheckpoint` / 只读的 `resume` 不需要锁。
- 两个进程对同一会话 `create` / `lock`，恰有一个成功；这是 `@nexgent/session` 的必测项。

## 账本记录

文件：`.nexgent/ledgers/<yyyy-mm>/requests.jsonl`，月份取记录 `ts` 的 UTC 年月（`ledgerMonth`）。步骤 1 的四种记录都追加到这一个文件；按类型拆文件留到有需要时。类型镜像：`packages/kernel/src/contracts/ledger.ts`。

写入：一条记录一行，`fsync` 后返回；写失败抛 `ledger/write-failed` 并使 `Ledger.writeFailures` 加一，**不改变**它所记录的那次请求的结果。`writeFailures` 非零意味着账本不完整，验收摘要必须报告它。

### 公共字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | 记录类型 |
| `ts` | string | 事件时刻，ISO-8601 UTC；由 `Ledger.append` 赋值 |
| `sessionId` | string? | 所属会话；辅助调用可无 |
| `capabilityVersion` | string? | 步骤 4：会话所用的能力版本，`baseline` 或能力包内容哈希（小写十六进制 SHA-256） |
| `trialId` | string? | 步骤 4：门控试验的运行与评审记录所属的试验；普通任务没有 |
| `arm` | `"candidate" \| "baseline"`? | 步骤 4：试验运行的臂；评审请求只带 `trialId`，不带 `arm` |
| `memberId` | string? | 发出记录的成员：根会话为 `main`，子会话为子会话 id（步骤 3） |
| `executionForm` | `"direct" \| "delegated" \| "team" \| "workflow"`? | 发出记录的成员的执行形态（步骤 3 加 `team`） |
| `taskId` | string? | 所属任务树：根会话打开（create / resume）时生成的小写 UUID v4，成员继承 |
| `improvementId` | string? | 步骤 5：费用所属的改进作业 id（`improvements/<jobId>/`）；改进作业的诊断会话、提议会话、该作业所发试验的运行与评审记录都带 |
| `improvementPhase` | `"diagnose" \| "propose" \| "trial" \| "meta-diagnose" \| "meta-propose"`? | 步骤 5：作业阶段；有它就必有 `improvementId`。`improvement.end` 汇总全部阶段，只带 `improvementId`、不带它，其余带 `improvementId` 的记录都带它。步骤 6 加元改进作业的两个阶段；`compare` 只是作业 `phases` 的汇总键，不出现在单条记录上 |
| `improverVersion` | `"v0"` 或 SHA-256? | 步骤 6：发出这条费用的改进器版本；改进作业与元改进作业的记录都带（元改进作业带父改进器） |
| `metaJobId` | string? | 步骤 6：比较臂的记录上：所属的元改进作业 id。比较臂的 `improvementId` 是臂作业自己的 id、`improvementPhase` 是臂作业自己的阶段，所以元改进费用按 `metaJobId` 查，与普通改进作业、普通任务分开 |
| `comparisonArm` | `"parent" \| "child"`? | 步骤 6：比较臂；与 `metaJobId` 同时出现 |

这些字段在所有记录类型上都是可选的（schema 层面）；步骤 1、2 的写入方不写它们。步骤 3 起 kernel 给一个会话写出的每条 `llm.request.*`、`tool.call`、`task.outcome` 都带 `taskId`、`memberId`、`executionForm`（契约 `AgentAttribution`）；步骤 4 起再带 `capabilityVersion`。试验运行的会话在项目的临时副本里，但它们的账本记录写进**真实项目**的账本，带 `trialId` 与 `arm`，所以费用汇总能区分试验与普通任务。

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

读取方以 `requestId` 配对 start 与 end；只有 start 没有 end 的请求按 `status: "unknown"` 计（进程在流中死亡），用量按全 `"unknown"` 计。

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
| `checks` | `TaskCheck[]`? | 宿主做的确定性检查 `{ name, passed, detail?, target? }`；步骤 4 写 `file-exists`、`parses`、`test-command` 三种，`target` 是检查规格的 `id`（路径与命令只在 `snapshots/checks/` 里）；步骤 1 可无 |
| `toolsUsed` | string[] | 实际调用过的工具名，去重；步骤 4 用它证明组件被实际调用 |
| `formsUsed` | `ExecutionForm[]`? | 步骤 3，只在根会话的记录上：整棵任务树实际用到的形态，去重，按 `direct, delegated, team, workflow` 排序 |
| `componentsUsed` | `ComponentUsage[]`? | 步骤 4：本会话实际用到的能力组件 `{ kind, name, version, calls, errors }`，`version` 为能力版本或 `draft`（本会话试用的草稿） |
| `memberCosts` | `MemberCost[]`? | 步骤 4，只在根会话的记录上：每个成员的 `{ memberId, name, executionForm, usage, requestCount, toolCallCount }`；根会话自己的用量仍在 `totalUsage` |

步骤 3：每个成员会话关闭时也写一条自己的 `task.outcome`（`memberId` 为成员会话 id），各条只计本会话的请求与工具调用；整棵树的合计是同一 `taskId` 下全部记录之和，根会话那条不重复计入成员的用量。

**`capability.decision`**（步骤 4）—— 写出一个能力决定（门控结论、批准、回滚）之后。决定文件（`capabilities/decisions/<id>.json`）存证据，这一行让它出现在相关费用旁边。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `decisionId` | string | 决定文件的 id |
| `outcome` | `"adopted" \| "rejected" \| "awaiting-approval" \| "rolled-back"` | 结论 |
| `reason` | `DecisionReason` | 见“候选与门控” |
| `trigger` | `"gate" \| "approval" \| "load-failure" \| "usage-regression" \| "manual"` | 起因 |
| `fromVersion`、`toVersion` | 能力版本 | 决定前后采用中的版本；拒绝与待批准时二者相等 |
| `candidateId` | string? | 涉及的候选 |
| `revision` | number? | 为它写出的采用历史序号 |

**`improvement.end`**（步骤 5）—— 一个改进作业进入终态之后（每个作业一条）。作业文件（`improvements/<jobId>/job.json`）存过程，这一行让作业结局与费用合计出现在账本里。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `jobId` | string | 作业 id（同时写在 `improvementId`） |
| `kind` | `"capability" \| "meta"`? | 步骤 6：作业种类，缺省为 `capability` |
| `trigger` | `"feedback-count" \| "explicit" \| "check-failure" \| "job-count"` | 起因，见“改进作业”；`job-count` 是步骤 6 按结束作业数开始的元改进作业 |
| `status` | `ImprovementStatus` | 终态 |
| `phases` | `{ diagnose?, propose?, trial?, meta-diagnose?, meta-propose?, compare? }` | 每阶段 `{ usage, requestCount }`，同作业记录；没运行过的阶段不写；不写美元 |
| `candidateId` | string? | 提议阶段产生的候选 |
| `decisionId` | string? | 门控或批准写出的决定 |
| `childVersion` | string? | 步骤 6，元改进作业：提出的子改进器版本 |

比较臂作业（步骤 6）在项目副本里结束，它们的 `improvement.end` 写在副本的账本里；真实项目的账本只有元改进作业那一条，其 `phases.compare` 是两臂之和。比较臂发出的请求记录照常写进真实项目的账本（臂会话的账本指向真实项目），带 `metaJobId` 与 `comparisonArm`。

### 示例

```jsonl
{"type":"llm.request.start","ts":"2026-10-07T08:00:01.000Z","sessionId":"6f1c…","requestId":"a0b1…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","purpose":"task","thinking":"off"}
{"type":"llm.request.end","ts":"2026-10-07T08:00:03.200Z","sessionId":"6f1c…","requestId":"a0b1…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","status":"ok","usage":{"inputTokens":812,"outputTokens":37,"totalTokens":849,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0},"latencyMs":2200,"httpStatus":200,"finishReason":"tool-calls"}
{"type":"tool.call","ts":"2026-10-07T08:00:03.210Z","sessionId":"6f1c…","turn":1,"callId":"call_1","name":"str_replace","effects":["write"],"approval":{"required":false,"decision":"auto"},"isError":false,"durationMs":4}
{"type":"llm.request.start","ts":"2026-10-07T08:00:03.300Z","sessionId":"6f1c…","requestId":"c2d3…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","purpose":"task","thinking":"off"}
{"type":"llm.request.end","ts":"2026-10-07T08:00:04.100Z","sessionId":"6f1c…","requestId":"c2d3…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","status":"error","usage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","cacheWriteTokens":"unknown","reasoningTokens":"unknown"},"latencyMs":800,"httpStatus":503,"errorCode":"llm/request-failed"}
{"type":"task.outcome","ts":"2026-10-07T08:00:04.200Z","sessionId":"6f1c…","status":"failed","totalUsage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","cacheWriteTokens":"unknown","reasoningTokens":"unknown"},"requestCount":2,"toolCallCount":1,"turns":1,"toolsUsed":["str_replace"]}
{"type":"capability.decision","ts":"2026-10-07T09:00:00.000Z","decisionId":"0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e","outcome":"adopted","reason":"quality-up","trigger":"gate","fromVersion":"baseline","toVersion":"3f2a9c0e5b7d14a8c6e2f9b0d3a5c7e1f4b8a2d6c0e9f3b5a7d1c4e8f2b6a0d9","candidateId":"5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b","revision":1}
{"type":"llm.request.start","ts":"2026-10-13T08:00:01.000Z","sessionId":"9a8b…","requestId":"e4f5…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","purpose":"task","thinking":"on","improvementId":"7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f","improvementPhase":"diagnose"}
{"type":"improvement.end","ts":"2026-10-13T09:30:00.000Z","jobId":"7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f","trigger":"feedback-count","status":"no-proposal","phases":{"diagnose":{"usage":{"inputTokens":40210,"outputTokens":1830,"totalTokens":42040,"cacheReadTokens":36000,"cacheWriteTokens":2100,"reasoningTokens":900},"requestCount":6}},"improvementId":"7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f"}
{"type":"llm.request.start","ts":"2026-10-14T08:00:01.000Z","sessionId":"b1c2…","requestId":"f6a7…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","purpose":"task","thinking":"on","improvementId":"2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a","improvementPhase":"propose","improverVersion":"v0","metaJobId":"8e9f0a1b-2c3d-4e5f-8a6b-7c8d9e0f1a2b","comparisonArm":"parent"}
```

### 必产生记录的失败路径

`@nexgent/llm` 的完成定义要求下列每种情况各产生一对 start / end：断网（`status: error`，无 `httpStatus`）、连接或流空闲超时（`error`，`errorCode: llm/timeout`）、HTTP 4xx / 5xx（`error`，带 `httpStatus`）、调用方中止（`aborted`）。用量字段在这些情况下全为 `"unknown"`。

## `CapabilityBundle` 清单

步骤 4。能力包是一组组件的完整集合（不是增量），按内容寻址：相同内容只有一个版本。类型镜像 `packages/kernel/src/contracts/capabilities.ts`；schema `packages/session/schema/capabilities.v1.schema.json`。决策见 ADR 0005。

**版本。** 能力版本是字符串 `baseline`（没有任何组件，步骤 3 的行为）或能力包内容哈希：`canonicalManifestText(manifest)` 的 UTF-8 SHA-256，小写十六进制 64 位。`canonicalManifestText` 先 `normalizeManifest`（组件按种类顺序再按名字排序，文件按路径排序），再写成规范 JSON（对象键按 UTF-16 码元排序，无空白）。

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
| `preset` | `preset.json` | 步骤 3 的 `PresetFile` | 与项目预设同用；同名时项目预设优先 |
| `team-template` | `team.json` | `{ formatVersion, name, description, members[] }`，成员 `{ name, task, preset?, persona? }`，1–8 个、不得叫 `lead` | 作为指引进系统提示，由 Lead 自己 `spawn_teammate` |
| `architecture` | `architecture.json` | 步骤 3 的 `ArchitectureFile` | 供 `workflow` 按名引用 |

`context-policy` 的 schema 是封闭的：`approvals`、`costCaps`、`sandboxMode`、`capabilities` 等权限与门控字段在任何组件里都没有位置（H13）。

**上限**（`CAPABILITY_LIMITS`）：每包 64 个组件，每组件 64 个文件，单文件 1 MiB，每包合计 16 MiB，每模块 16 个函数，`instructions` 16 384 字节，`personaSuffix` 4096 字节。

**写入与装载。** 能力包目录先在临时名下写全，校验每个文件的哈希与清单一致后改名发布；目标已存在则读回校验。装载时再校验一次；任何文件缺失或哈希不符，该版本不可用（见“采用历史”的回滚规则）。`assertCapabilityManifest` 检查结构，哈希比对是装载方的事。

## 采用历史

步骤 4。`.nexgent/capabilities/activation/<n>.json` 是一条修订链，链尾就是采用中的版本；没有任何文件时是 `baseline`。移植自 PR #4 的 `architecture-activation.ts`。

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

步骤 4。

**草稿。** `capability_draft` 把组件写进 `.nexgent/capabilities/drafts/<sessionId>/<kind-dir>/<name>/`（宿主代写，模型的文件工具看不见这里），每次改动写一条 `capability.draft`。`capability_try` 把当前草稿装进本会话，写 `capability.try`。

**候选。** `capability_propose` 把试用过的组件提成一个候选：宿主检查每个组件在试用之后至少被成功用过一次（决定 2），把证据写成 `proofs`（`{ kind, name, turn, toolCallId }`），不满足就拒绝调用。接受后写 `.nexgent/capabilities/candidates/<candidateId>/candidate.json` 并复制组件文件到同目录，再写会话记录 `capability.propose`。候选的包 = 会话所用的包 + 提出的组件：同种类同名的组件被替换；一个包至多一个 `context-policy`，所以提出的上下文策略取代基础包里已有的那一个，不论名字。

`candidate.json`：`formatVersion: 1`、`id`（小写 UUID v4）、`proposedAt`、`sessionId`、`taskId`、`turn`、`base`（会话所用的版本）、`version`（`base` 加上这些组件后的能力包版本）、`components`、`proofs`、`requiresApproval`（含 `plugin` 时为真）、`summary?`（≤500 字符）、`origin?`（步骤 5：`"session" \| "improvement"`，缺省即 `session`，用户任务自己的 `capability_propose`）、`jobId?`（步骤 5：`origin` 为 `improvement` 时的改进作业 id）。改进作业的候选同样由提议会话的 `capability_propose` 写出，规则不变（必须在试用后成功用过一次）。

**状态。** 候选的状态由文件推出，不另存：`drafted`（只在草稿区有、尚未提出）→ `proposed`（有 `candidate.json`，没有试验）→ `trialing`（有试验，没有 `trial.end`）→ `awaiting-approval` / `adopted` / `rejected`（看决定）→ `rolled-back`（采用后被回滚）。

**试验收据。** `.nexgent/capabilities/trials/<trialId>.jsonl`，以 `wx` 创建（试验 id 不重用），每行写完 `fsync` 后才开始下一次运行；没有 `trial.end` 的试验是中断的，结论按 `unknown` 处理。

**`trials/` 下的旁路文件**（步骤 4 起由门控写，步骤 5 补入规范）。三种都是宿主的内部文件，不是数据记录，没有 schema：

| 文件 | 内容与写法 | 读者与规则 |
| --- | --- | --- |
| `<candidateId>.attempt` | 空文件，在写第一行收据之前以 `wx` 独占创建 | 存在即“这个候选试过”：一个候选最多试一次（PR #4“试过的候选不再重放”）；两个门控进程同时启动时只有一个创建成功，另一个退出。门控因历史不足等待时不创建 |
| `<trialId>.lock` | 门控进程的 pid 加换行，以 `wx` 创建，试验结束（写完 `trial.end` 或决定）后删除 | 启动时的中断恢复：收据没有 `trial.end`、且没有锁或锁里的进程已不在，就是被杀的试验，写一个 `rejected`（`interrupted`）决定并删除锁 |
| `<candidateId>.log` | 门控进程的 stdout / stderr，追加写（`a`），宿主每次起进程时打开 | 只用于诊断，任何代码都不把它当数据读回；可能含路径与错误信息，不含密钥（密钥不进进程参数与环境之外的任何地方） |

| `type` | 字段 |
| --- | --- |
| `trial.start` | `trialId`、`candidateId`、`candidateVersion`、`baselineVersion`、`plan: TrialPlan`（选择集 ≥2、守护集 ≥1 个 `ReplayCaseRef { caseId, sessionId, tree, checks, throughTurn?, feedbackIds? }`，`repeats`、`costRatioCap`、`reviewer`、`budget`）。步骤 5：`throughTurn` 表示依次回放第 1 至 `throughTurn` 轮的用户消息（缺省只回放第 1 轮，即步骤 4 的行为）；反馈任务取第一条反馈之前的最后一轮，所以反馈内容不会进入回放。`feedbackIds` 是用例携带的反馈，有它的用例每次运行都做一次反馈检查 |
| `trial.run` | `set: selection \| guard`、`caseId`、`arm: candidate \| baseline`、`repeat`、`status: pass \| fail \| unknown`、`reason?`（`unknown` 的原因：`not-run \| cancelled \| error \| timeout \| budget \| interrupted`）、`checks: TaskCheck[]`、`cost`、`durationMs` |
| `trial.review` | `set`、`caseId`、`repeat`、`preference: candidate \| baseline \| tie \| unknown`、`reason`（≤2000 字符）、`model`、`cost` |
| `trial.feedback` | 步骤 5（ADR 0006）：`caseId`、`arm`、`repeat`、`feedbackIds`（≥1）、`status: pass \| fail \| unknown`、`reason`（≤2000 字符）、`model`、`cost`。评审模型读这次运行的成果与反馈原文，回答“反馈指出的问题是否已经解决”；运行本身是 `unknown`、评审失败或回答无法解析时为 `unknown`。与确定性检查（`trial.run.checks`）和偏好评审（`trial.review`）分开记 |
| `trial.end` | `status`、`verdict: TrialVerdict`、`cost: { candidate, baseline, review }`（反馈检查的费用计入 `review`） |

每行都有 `format: 1`、`trialId`、`ts`。`cost` 是 `{ usage, requestCount, estimatedUsd }`；美元是估算，ADR 0007 起用于费用比（见下）。

**采用规则**（`decideTrial(tally, costRatioCap, costApprovalRatio)`，纯函数，ADR 0005 决策 5；步骤 5 由 ADR 0006 修订第 1、3 条，由 ADR 0007 修订费用比与第 3 条）。

费用比：两臂的估算美元（`TrialTally.usd`，含缓存读写）都已知且基线大于 0 时，为候选美元 / 基线美元；否则为 token 比（输入 + 输出）。`TrialVerdict.costBasis` 写明用的是哪种。

按顺序：

1. 预算用尽（`budget-exhausted`）、任何一次运行或反馈检查是 `unknown`、或用量未知（`unknown-runs`）：拒绝。
2. 守护集候选通过次数少于基线：拒绝（`guard-regressed`）。
3. 选择集质量 = 选择集运行的确定性检查结果，加上每臂的反馈检查结果（每个反馈检查算该臂多一次通过或失败）的通过率。候选低：拒绝（`quality-down`）。候选高：费用比 ≤ `costApprovalRatio` 则采用（`quality-up`），否则 `await-approval`（理由仍是 `quality-up`，等用户经 `capabilities.approve` 批准）。ADR 0007 起不再产生 `cost-over-cap`，这个值只留给旧记录。
4. 打平：费用比 < 1 采用（`cost-down`）；否则看评审，候选偏好多于基线且费用比 ≤ `costRatioCap` 采用（`review-preferred`），其他拒绝（`no-improvement`）。
5. 含 `plugin` 的候选，采用结论变为 `await-approval`，理由不变。

`TrialVerdict`：`outcome`、`reason`、`passRate: { candidate, baseline }`（上面第 3 条的质量）、`feedbackPassRate?`（步骤 5：只算反馈检查的通过率，试验有反馈检查时才有，证据里单独显示）、`costRatio`、`costBasis?`（ADR 0007：`usd` 或 `tokens`，之前的记录没有，按 `tokens` 读）、`decidedByReview`。`TrialTally.feedback` 是反馈检查的每臂计数。`TrialPlan.costApprovalRatio?` 是试验开始时冻结的批准倍数（ADR 0007 之前的试验没有）。

`cost.estimatedUsd` 来自 `@nexgent/llm` 的只读价目表（步骤 5，决定 9），模型不在表里或任何用量未知时为 `"unknown"`。ADR 0007 起门控的费用比优先用它（两臂都已知时）；预算与费用上限仍只看 token 与请求数。

**决定。** `.nexgent/capabilities/decisions/<id>.json`，以 `wx` 写一次：`formatVersion: 1`、`id`、`outcome: adopted | rejected | awaiting-approval | rolled-back`、`reason`、`trigger`、`decidedAt`、`candidateId?`、`trialId?`、`fromVersion`、`toVersion`、`revision?`、`verdict?`、`cost?`、`regression?`、`detail`（≤2000 字符）。采用与回滚各写一个修订（`revision`），先发布修订、成功后再写决定，所以链尾被别人抢先时不留 `adopted` 或 `rolled-back` 决定（门控此时写 `rejected`、`interrupted`）；拒绝与待批准不写修订。每个决定同时在账本写一条 `capability.decision`。

**回滚**（决定 6）。三种：装载校验失败时立即回到上一个版本（`load-failure`）；采用后的前 `rollback.windowTasks` 个根任务检查通过率低于门控测得的基线通过率（`usage-regression`），或新组件的调用连续出错 `rollback.consecutiveErrors` 次（`component-errors`），由 `decideUsageRollback` 判断并自动回滚；用户也可手动回滚（`manual`）。回滚写一个 `type: "rollback"` 的修订和一个 `rolled-back` 决定，证据放在 `regression`。

## 任务快照与检查

步骤 4。门控要重放过去的任务，所以从步骤 4 起每个根任务开始时都给工作区拍快照（决定 7）。

- **对象**：`.nexgent/snapshots/objects/<sha256>`，文件原始字节，每份内容只存一次。
- **树**：`.nexgent/snapshots/trees/<sha256>.json`，`{ formatVersion: 1, files: [{ path, sha256, bytes, executable? }] }`，按路径排序，范围与 `turn.files` 相同（不含 `.nexgent/`、`.git/`、`node_modules/`）；文件名是该对象规范 JSON 的 SHA-256。
- **任务快照**：`.nexgent/snapshots/tasks/<taskId>.json`，根任务开始时写：`{ formatVersion: 1, taskId, turn?, sessionId, takenAt, tree, omitted?, capabilityVersion }`。工作区超过 200 MiB（`maxSnapshotBytes`）时 `tree: null`、`omitted: { reason: "too-large", bytes }`，这个任务不能作为重放用例。
- **检查记录**：`.nexgent/snapshots/checks/<taskId>.json`，根任务结束时写：`{ formatVersion: 1, taskId, turn?, sessionId, checkedAt, specs, results }`。`specs` 是 `TaskCheckSpec`：`{ id, name: "file-exists", path }`、`{ id, name: "parses", path, format: json | csv | xlsx }`、`{ id, name: "test-command", command, shell: bash | pwsh }`；`results` 与 `specs` 一一对应，`target` 为 spec 的 `id`。同样的结果写进 `task.outcome.checks`。
- **按轮记（步骤 5，决定 7）。** 同一会话的多轮仍是同一个 `taskId`（反馈轮也是），快照与检查改为每个根轮各一份：`tasks/<taskId>.t<turn>.json` 在第 `turn` 个根轮开始时写，`checks/<taskId>.t<turn>.json` 在该轮结束时写一次，两者都带 `turn`（文件名由 `perTurnFileName(taskId, turn)` 给出）。反馈轮不会覆盖它所针对的那一轮的记录。不带轮号的 `<taskId>.json` 是步骤 4 写的：快照即第 1 轮，检查是当时最后一轮（每轮结束都覆盖）；读取方照旧接受，不迁移。步骤 5 起写入方继续同时写不带轮号的文件（第 1 轮快照、最新一轮检查），使步骤 4 的读取方不变。
- **哪些命令成为 `test-command`（步骤 5，ADR 0006 决策 10）。** 取任务树在项目根目录跑过的 `bash` / `pwsh` 命令里符合测试命令模式（`TEST_COMMAND_PATTERN`：`npm|pnpm|yarn [run] test`、`vitest|jest|mocha`、`pytest`、`python -m pytest|unittest`、`node --test`、`node <文件>.test.<js|mjs|cjs|ts…>`、`go|cargo test`、`make test|check`，命令必须以它们开头）的，**退出码不论成败都算**，只排除表示“没有跑到测试”的退出码：任何命令的 126、127（不可执行、找不到命令），pytest 的 4、5（路径或参数错误、没有收集到测试）。超时或被取消的调用没有退出码，不算。同一命令只保留最近一次，取最近 3 条，在轮末重跑，**以重跑结果为准**：重跑仍失败即一项失败的检查（步骤 4 只取退出码为 0 的命令，失败的测试不留下检查）。`ls`、`cat`、构建与生成脚本等探索性命令不符合模式，无论成败都不成为检查。
- 快照总量上限 200 MiB，超出时按任务时间从旧到新删除不再被任何试验引用的对象。路径一律项目相对、`/` 分隔。

## 改进作业

步骤 5。默认的反馈改进流程：计入的反馈或失败的检查积累到阈值（或用户点“改进”），宿主开始一个改进作业：先诊断，再在快照副本里重做任务产出一个候选，最后交给步骤 4 的门控。决策见 ADR 0006；类型镜像 `packages/kernel/src/contracts/improvement.ts`；schema `packages/session/schema/improvement.v1.schema.json`（`$defs/improvementQueue`、`improvementJob`、`diagnosis`）。`.nexgent/improvements/` 只由宿主（`@nexgent/evolve`）写，模型的文件工具读写都拒绝。

**触发与计数。** 三种触发（`ImprovementTrigger`）：

- `feedback-count`：计入的信号到达 `improvement.feedbackThreshold`。信号有两种：计入的反馈（评分 ≤3，或只有评语没有评分；4–5 分保留在会话里但不计，`isCountedFeedback`），以及根任务一轮结束时 `task.outcome.checks` 有失败项（计 1 个）。一批全是失败检查时触发记为 `check-failure`（`batchTrigger`）。只有 `autoImprove` 为真时才自动开始。
- `explicit`：用户在成果卡片或“改进”页点“改进”（SDK `improvements.run`），立即开始，不看计数，也不看 `autoImprove`，但受预算限制。

**队列**：`.nexgent/improvements/queue.json`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | `1` | |
| `since` | ISO-8601 UTC | 本项目开始计数的时刻（第一次建队列时）；发生在它之前的反馈与检查不计 |
| `counted` | string[] | 计入过的全部信号键（`signalKey`：`feedback:<feedbackId>`、`check:<taskId>:<turn>`）；键在这里就不再计入，重启与并发都不会重计 |
| `pending` | `ImprovementSignal[]` | 已计入、尚未交给作业的信号（下一批），旧的在前，最多 64 个（再多时丢最旧的，`counted` 不丢） |
| `activeJobId` | string? | 占着作业位的作业（状态为 `queued`、`diagnosing`、`proposing`、`trialing` 之一） |

信号：`{ kind: "feedback", feedbackId, sessionId, deliverableId, version?, rating?, at }` 或 `{ kind: "check-failure", taskId, sessionId, turn, failedChecks?, at }`，`at` 是事情发生的时刻（反馈的 `submittedAt`、检查的时刻）。改写队列时先以 `wx` 创建 `queue.lock`（内容为 pid），读、改、写临时文件再 rename，最后删锁；锁里的进程已不在时可以接管。纯函数：`countSignal` 只计数；`takeBatch(queue, threshold)` 在作业位空闲且够数时取走整批（`autoImprove` 为真时才对 `feedback-count` 调用；显式“改进”用 `threshold` 0 带走当前批次，可以为空）；`releaseJobSlot` 释放作业位。同一项目同时只有一个作业（决定 8）：作业位被占时新信号只进 `pending`；作业进入终态或停靠状态时释放作业位，`pending` 够数就立即作为下一批，在同一次加锁更新里建 `queued` 作业并占位。

**作业**：`.nexgent/improvements/<jobId>/job.json`，每次变化都在 `<jobId>/job.json.lock`（`wx` 创建）下读改写，整体替换（临时文件 + rename）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion`、`id` | `1`、小写 UUID v4 | `id` 也是目录名与账本的 `improvementId` |
| `createdAt`、`updatedAt` | ISO-8601 UTC | |
| `trigger` | `ImprovementTrigger` | |
| `status` | `ImprovementStatus` | 见下 |
| `items` | `ImprovementSignal[]` | 它回应的那批信号，旧的在前；`explicit` 作业带走开始时的待处理批次（可空） |
| `request` | `{ sessionId?, deliverableId?, version?, taskId?, note? }`? | 仅 `explicit`：用户点“改进”的会话、成果或任务，`note` 是用户的话（≤2000 字符） |
| `history` | `{ status, at, detail? }[]` | 每次状态变化，至少一条，最后一条等于 `status`；`detail` ≤2000 字符 |
| `phases` | `{ diagnose?, propose?, trial? }` | 每阶段 `PhaseCost { usage, requestCount }`，由带本作业 `improvementId` 的账本记录求和；没运行过的阶段不写；不写美元（显示时按价目表估算） |
| `baseVersion` | 能力版本? | 开始诊断时采用中的版本 |
| `sessions` | `{ diagnose?, propose? }`? | 作业打开的改进会话 id |
| `diagnosed` | `{ at, proposalKind, attempts }`? | 写出 `diagnosis.json` 后设置 |
| `candidateId`、`trialId`、`decisionId` | string? | 候选（`origin: improvement`）、试验与决定都照旧在 `capabilities/` 下，作业只存引用 |
| `firstUse` | `{ taskId, sessionId, at, version }`? | 采用后第一个运行在新版本上、且 `componentsUsed` 出现该组件的根任务 |
| `rolledBack` | `{ decisionId, at }`? | 采用的版本后来被回滚时设置 |
| `detail` | string? | 作业停在当前结果的原因（失败、拒绝、无提议、预算），≤2000 字符 |
| `error` | `ErrorInfo`? | `failed` / `interrupted` 的错误 |

**状态**（`ImprovementStatus`，允许的变化见 `IMPROVEMENT_TRANSITIONS` 与 `canMoveImprovement`）分三组：

- 进行中（占作业位）：`queued → diagnosing → proposing → trialing`；`diagnosing`、`proposing` 可到 `no-proposal`（诊断认为不是能力问题，或提议没有可提的组件）；四者都可到 `budget-exhausted`、`failed`、`interrupted`（作业进程被杀，下次启动时标记，不自动重跑；刚建、还没拿到 `job.lock` 的 `queued` 作业有宽限）、`cancelled`（`improvements.cancel`）。
- 停靠（释放作业位）：`trialing → waiting-history`，门控历史不足时等待，补足后回到 `trialing` 并重新占位，不降低门槛；也可到 `failed`、`interrupted`、`cancelled`。`trialing → awaiting-approval`，候选含插件，等用户在 `capabilities.approve` 里批准，作业随之变为 `adopted` 或 `rejected`。
- 终态：`adopted`、`rejected`、`no-proposal`、`budget-exhausted`、`failed`、`interrupted`、`cancelled`。作业进入终态时在账本写一条 `improvement.end`。

`<jobId>/job.lock`：作业进程的 pid（`wx` 创建，结束时删除），用于判断 `interrupted`；`<jobId>/job.json.lock`：改写 `job.json` 时持有，毫秒级；`<jobId>/job.log`：作业进程的 stdout / stderr，追加写，只用于诊断，与 `trials/<candidateId>.log` 相同。

**诊断。** 作业先打开一个诊断会话（`session.start.purpose: "improvement"`、`improvement: { jobId, phase: "diagnose" }`，模型与 thinking 取 `improvement.model` / `improvement.thinking`）。它不出现在对话列表里，只能在“改进”页打开。这个会话只有四个只读工具（`IMPROVEMENT_DIAGNOSIS_TOOLS`）：`improve_read_session`（某个会话按轮与记录类型的切片）、`improve_read_ledger`（按 `taskId` / `sessionId` / `memberId` / `capabilityVersion` 的账本切片）、`improve_list_feedback`、`improve_report_diagnosis`；切片默认 64 KiB、最多 256 KiB，超出截断并标明。模型用 `improve_report_diagnosis` 交结构化诊断，宿主按 schema 校验并核对证据记录存在，不通过就在工具结果里说明并允许重交，共最多 3 次，仍不通过作业以 `failed` 结束（`improvement/invalid-diagnosis`）。

`<jobId>/diagnosis.json`（接受后写一次）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion`、`jobId`、`createdAt`、`sessionId` | | `sessionId` 是交诊断的会话 |
| `attempts` | 1–3 | 第几次提交被接受 |
| `failureTypes` | `{ category, label, evidence }[]` | MAST 三类：`system-design`（规格与系统设计）、`inter-agent-misalignment`（成员之间不一致）、`task-verification`（任务验证与终止）；`label` ≤200 字符；`evidence` 至少一条 `{ sessionId, seq, turn? }`。宿主另限每份最多 8 类、每类最多 16 条证据 |
| `involved` | `{ members, tools, skills, components }` | 涉及的成员名（根会话写 `main`）、工具、技能、能力组件 `{ kind, name }` |
| `hypothesis` | string | 一句话：缺什么能力导致了反馈，≤500 字符 |
| `proposalKind` | 组件种类或 `"none"` | `none` 时作业以 `no-proposal` 结束 |
| `memberCosts` | `MemberCost[]` | 被诊断任务每个成员的用量，由宿主从账本汇总，根会话写 `executionForm: "direct"`；模型只能引用，不能写 |

**提议。** 诊断给出组件种类后，宿主把反馈任务第一个根轮开始时的快照复制成临时项目，打开提议会话（`improvement: { jobId, phase: "propose" }`），在副本里用原任务的用户消息（到第一条反馈之前的轮）重新执行。提议会话有普通任务工具与 `STEP4_TOOLS`（`capability_draft / try / propose`），没有诊断工具；它的会话文件与候选写在**真实项目**的 `sessions/` 与 `capabilities/candidates/` 下（文件工具的工作区是副本）。一个作业只提一个候选，一个候选只含一个组件，规则与步骤 4 相同。没有提出候选就结束的提议记为 `failed`。

**门控。** 作业的候选照步骤 4 的门控试验，区别只有：选择集必含触发作业的反馈任务（`ReplayCaseRef.throughTurn` 为第一条反馈之前的最后一轮，`feedbackIds` 为该任务的反馈），每次运行多一次反馈检查（`trial.feedback`）；试验的账本记录带 `improvementId` 与 `improvementPhase: "trial"`，费用计入改进预算。采用、拒绝、待批准、回滚的写法不变。

## 改进器版本

步骤 6。改进器是改进作业怎样诊断、提什么、门控时比几个用例的那部分，做成有版本的数据，作为项目级的一条独立版本线，与能力包分开采用、分开回滚。决策见 ADR 0008；类型镜像 `packages/kernel/src/contracts/improver.ts`；schema `packages/session/schema/improvement.v1.schema.json`（`$defs/improverBundle`、`improverRevision`）。`.nexgent/improvers/` 只由宿主写（存储与采用历史在 `@nexgent/capabilities` 的 `ImproverStore`，`@nexgent/evolve` 与 `@nexgent/sdk` 调用它），模型的文件工具读写都拒绝。

**改进器**（`ImproverBundle`）三部分，全是数据，没有代码：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | `1` | |
| `diagnosis.paragraphs` | string[] | 诊断策略：诊断会话第一条消息 `# Policy` 下的段落，按顺序以换行连接；1–16 段，每段一行、非空、≤2000 字符；可用占位符 `{{allowedKinds}}`（`proposal.kinds` 以 `, ` 连接） |
| `proposal.kinds` | 组件种类[] | 提案算子：诊断可以建议的组件种类及优先顺序，至少一种、不重复；`plugin` 永远不在内。诊断给出不在其中的种类时作业以 `failed` 结束（同步骤 5 对插件的处理） |
| `proposal.briefs` | `{ <kind>: string }` | 每种组件的提案简报模板，`kinds` 里每种都要有；非空、≤4000 字符；可用占位符 `{{jobId}}`、`{{hypothesis}}`、`{{failures}}`（诊断前 4 个失败类型，每行 `- <category>: <label>`）、`{{kind}}` |
| `comparison.selectionCases` | 2–4 | 该改进器的作业在门控里用的选择集用例数 |
| `comparison.repeats` | 2–3 | 每个用例每臂的运行次数 |
| `comparison.selection` | `"similarity" \| "recency"` | 反馈任务之外的选择用例怎么挑：按与反馈任务的词重合（步骤 4–5 的做法），或取最近的历史任务；守护集始终取最不相似的任务（属于评价器） |

占位符写作 `{{name}}`，一次替换，替换出的文字不再扫描；一行只有一个占位符且它的值为空时整行去掉（没有失败类型时简报不留空行）。用到未列出的占位符、超出上下限、未知字段，都由 `assertImproverBundle` 拒绝（`improver/invalid`）。项目配置的 `capabilities.selectionCases`、`repeats` 仍是下限：作业实际用两者中较大的值（`effectiveTrialCounts`），改进器只能要求更多证据，不能更少。

**v0。** 内置改进器 `IMPROVER_V0` 是步骤 5 的诊断策略（`@nexgent/evolve` `POLICY` 的 7 段）与提案简报的原文、全部六种可提组件、`{ selectionCases: 2, repeats: 2, selection: "similarity" }`。它的版本号是字面量 `v0`，不存文件；没有改进器采用历史的项目用它。测试固定它与步骤 5 代码的文字逐字一致。

**版本号**（`ImproverVersion`）：`v0`，或规范化文本（`canonicalImproverText`：规范化后的清单按键排序的 JSON）的 UTF-8 小写十六进制 SHA-256；内容等于 v0 的清单就是 `v0`。

**存储**：

| 路径 | 内容 | 写法 |
| --- | --- | --- |
| `improvers/bundles/<version>.json` | 一个改进器的规范化文本 | 元改进作业写出 `change.json` 时以 `wx` 创建；内容相同的版本已存在则不写；从不改写、从不删除 |
| `improvers/activation/<n>.json` | 采用历史的第 n 条（`ImproverRevision`） | 同能力包的 `activation/`：先写临时文件，在第 `n-1` 条仍是末尾时以硬链接独占发布（比较后发布），失败即重读末尾 |

`ImproverRevision`：`{ format: 1, revision, previous, from, version, type, trigger, jobId?, reason?, committedAt }`。`previous` 是上一条文件字节的 SHA-256（第 1 条为 `null`）；`from` 是之前生效的版本（第 1 条为 `v0`），`version` 是之后生效的版本，二者不同。`type: "adopt"` 只由元改进作业写（`trigger: "meta-job"`，必带 `jobId`）；`type: "rollback"` 的 `trigger` 是 `manual`（用户经 SDK `improvers.rollback`）或 `load-failure`（生效的改进器文件读不出或校验不过，宿主回退到上一个可用版本，`reason` 写原因），可以回到 `v0`。纯函数 `isNextImproverRevision` 固定这些条件。读者取末尾为生效版本，没有任何一条时为 `v0`。

**回滚按栈。** 读者从头重放采用历史，维护一个“生效栈”：开始时为 `[v0]`；`adopt` 把新版本压栈；`rollback` 的目标若在栈里（不算栈顶），栈截到它为止，否则（更早生效过、但已被回滚掉的版本）把它压栈。不带目标的回滚回到栈顶的下一项，即当前采用之前生效的版本；`v0` 生效且栈里只有它时没有可回滚的，报 `improver/activation`。带目标的回滚只能回到 `v0` 或采用历史里更早出现过的版本，从未生效过的版本报 `improver/activation`；读取时目标不满足这一条的回滚修订视为链损坏。手动回滚先校验目标能读出。`load-failure` 回滚由宿主读生效的改进器失败时写（不带目标，`reason` 为版本与错误），随后再读新的生效版本，直到读出或退回 `v0`；链本身损坏时不写入，用最后一个有效修订的版本，它也读不出时这次用 `v0`。

**作业固定改进器。** 每个改进作业（含元改进作业与比较臂）开始时读一次生效的改进器，把版本写进 `job.json` 的 `improverVersion`，之后整个作业只用它；作业进行中采用新的改进器不影响它。步骤 5 写出的作业没有这个字段，读作 `v0`。作业的诊断会话、提议会话与试验的账本记录都带 `improverVersion`。

**评价器与纪元。** 评价器是决定“好不好”的部分：采用规则（`decideTrial`、门控的评审与反馈检查提示、`decideImprover`，规则 id `EVALUATOR_RULES = "adr-0008"`）以及项目的 `capabilities.costRatioCap`、`costApprovalRatio`、`guardCases`、`reviewer`。它们不在改进器里，改进器的改动也不能写到它们（`EVALUATOR_FIELDS`）。纪元 id 是 `EvaluatorSettings`（`{ formatVersion: 1, rules, costRatioCap, costApprovalRatio, guardCases, reviewer }`）规范化文本的 SHA-256：用户改了其中任何一项，或新 ADR 换了规则 id，就进入新纪元；`selectionCases`、`repeats`、改进预算、`autoImprove` 不进纪元。步骤 6 起门控把纪元写进 `TrialPlan.epoch`（步骤 4–5 的计划没有它，读出时视为未知纪元，不与有纪元的数据比较）；父子比较的起点与报告也写它。

## 元改进作业

步骤 6。元改进作业改进的是改进器：读历次改进作业，提出一个类型化改动得到子改进器，再让父、子改进器从同一起点各跑一次完整作业，按 `decideImprover` 决定是否采用子改进器。它是 `kind: "meta"` 的 `ImprovementJob`，存放在 `improvements/<jobId>/`，与能力改进作业共用“同一项目同时只有一个作业”的作业位。决策见 ADR 0008；类型镜像 `improvement.ts`、`improver.ts`；schema 同上（`$defs/metaJobState`、`metaDiagnosis`、`improverChangeRecord`、`improverComparison`）。

**触发与计数。** `improvement.meta.enabled` 为真时，每结束一个能力改进作业，宿主在改写队列的同一次加锁里调用 `countFinishedJob`：终态为 `adopted`、`rejected`、`no-proposal`、`failed` 的作业计入（`META_COUNTED_STATUSES`），`cancelled`、`interrupted`、`budget-exhausted`、元改进作业本身与比较臂都不计；作业 id 进 `queue.metaCounted`（计过的不再计）与 `queue.metaPending`。作业位空闲且 `metaPending` 达到 `improvement.meta.everyJobs` 时 `takeMetaBatch` 取走整批，建 `trigger: "job-count"` 的元改进作业。显式元改进（SDK `improvements.runMeta`、CLI `nexgent improve meta`）`trigger: "explicit"`，不看开关与计数，带走当前 `metaPending`（可以为空），但受元改进预算限制。作业位被占时计数照常累积。

队列新增字段：`metaCounted?: string[]`（计入过元改进的全部作业 id）、`metaPending?: string[]`（下一批，旧的在前）。步骤 5 的队列没有它们，读作空。

**作业字段**（在“改进作业”的表之外）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | `"capability" \| "meta"`? | 缺省为 `capability`（步骤 5 的全部作业） |
| `improverVersion` | `ImproverVersion`? | 作业开始时生效的改进器；元改进作业的即父改进器 |
| `arm` | `{ metaJobId, arm: "parent" \| "child" }`? | 只在比较臂作业上（臂作业的 `job.json` 在项目副本里） |
| `meta` | `MetaJobState`? | 只在元改进作业上，见下 |
| `phases` | 见下 | 元改进作业用 `meta-diagnose`、`meta-propose`、`compare` 三个键 |
| `sessions` | `{ meta-diagnose?, meta-propose? }`? | 元改进作业打开的两个会话 |

`MetaJobState`：`{ basis, parentVersion, childVersion?, keepCopies?, diagnosed?, compared?, revision? }`。`basis` 是作业开始时取走的那批作业 id（旧的在前）；`parentVersion` 等于 `improverVersion`；`childVersion` 在写出 `change.json` 后设置；`keepCopies` 只由实验经 `runMeta` 设置；`diagnosed: { at, attempts, proposal }`；`compared: { at, outcome, reason }`；`revision` 是采用子改进器时写出的 `improvers/activation/<n>.json` 序号。

**状态。** 元改进作业走 `queued → meta-diagnosing → meta-proposing → comparing → adopted | rejected`；`meta-diagnosing` 可到 `no-proposal`（元诊断认为改进器没有明显问题）；进行中的三个状态都可到 `budget-exhausted`、`failed`、`interrupted`、`cancelled`。它不进入 `diagnosing`、`proposing`、`trialing`、`waiting-history`、`awaiting-approval`，能力作业也不进入这三个元改进状态（`canMoveJob` 按 `kind` 检查）。`adopted` 在这里指子改进器被采用，`rejected` 指没被采用。终态写一条 `improvement.end`（`kind: "meta"`，有子改进器时带 `childVersion`）。

**元诊断。** 一个只读改进会话（`improvement: { jobId, phase: "meta-diagnose", improverVersion }`，模型 `improvement.meta.model`，thinking 按 `improvement.thinking`），工具只有 `META_DIAGNOSIS_TOOLS`：`improve_list_jobs`、`improve_read_job`、`improve_read_session`、`improve_read_ledger`、`improve_report_meta_diagnosis`。模型交一份元诊断：发现（`{ stage: "diagnose" | "propose" | "trial" | "other", label ≤200 字符, jobIds }`，最多 8 条，每条至少 1、最多 16 个作业 id）、一句假设（≤500 字符）与 `proposal: "change" | "none"`。宿主校验 schema 并核对引用的作业都存在，不通过可重交，共最多 3 次，仍不通过以 `failed` 结束（`improvement/invalid-diagnosis`）。`none` 时以 `no-proposal` 结束。

`<jobId>/meta-diagnosis.json`（接受后写一次）：上述报告加 `formatVersion`、`jobId`、`createdAt`、`sessionId`、`attempts`、`improverVersion`（被诊断的父改进器）、`basis`、`statusCounts`（宿主统计的、项目全部已结束能力作业的终态计数，模型不能写）。

**元提案。** 一个改进会话（`phase: "meta-propose"`），工具只有 `META_PROPOSE_TOOLS`：`improve_read_improver`（读本作业的父改进器，不带参数）、`improve_read_job`、`improve_propose_change`。模型一次只交一个改动（`{ change, rationale }`），宿主用 `checkImproverChange` 校验：

| 改动 `op` | 字段 | 含义 |
| --- | --- | --- |
| `set-diagnosis-paragraph` | `index`、`text` | 改写第 `index` 段诊断策略；`index` 等于现有段数时追加一段 |
| `set-proposal-kinds` | `kinds` | 改允许的组件种类及顺序 |
| `set-proposal-brief` | `kind`、`template` | 改一种组件的简报模板 |
| `set-comparison-param` | `param`、`value` | 在上下限内改 `selectionCases`、`repeats` 或 `selection` |

拒绝的原因（`ImproverChangeRefusal`）：`not-one-change`（一个列表，或多于该算子的字段）、`evaluator-field`（字段名或 `param` 是评价器字段，如 `costRatioCap`、`guardCases`、`reviewer`、`autoImprove`、`improvement`）、`out-of-bounds`、`invalid`（未知算子、缺字段、改完的改进器不合法）、`no-op`（改完和父改进器相同）。拒绝在工具结果里说明，可重交，共最多 3 次，仍不通过以 `failed` 结束（`improver/invalid-change`）。接受后写子改进器到 `improvers/bundles/`，再写 `<jobId>/change.json`：`{ formatVersion, jobId, createdAt, sessionId, attempts, parentVersion, childVersion, change, rationale ≤1000 字符 }`。

**父子比较。** 起点（`ComparisonOrigin`，ADR 0009 取代 ADR 0008 的起点规则）按顺序选：
- `kind: "unresolved"`：元改进作业开始前结束的、由反馈触发的能力作业里，最近一个没能解决反馈的作业（结束于 `rejected`、`failed` 或 `no-proposal`；门控结论里基线已通过全部反馈检查，即 `verdict.feedbackPassRate.baseline` 为 1 的不算；反馈任务不能重放的也不算）。`capabilityVersion` 是它开始时的能力版本：有 `baseVersion` 用它，否则取作业离开 `queued` 时（没有则用创建时）采用历史里生效的版本。
- `kind: "feedback-version"`：没有这样的作业时，取最近一个结束的、由反馈触发的能力作业，`capabilityVersion` 是它的反馈任务在第一次反馈之前运行的版本（`session.start.capabilityVersion`，其后有 `capability.version` 时取最后一条；都没有为 `baseline`）。
- 两种都没有时元改进作业失败。

起点还记 `sourceJobId`、反馈任务快照树（`tree`）、反馈 id（排序后比较）与当前纪元；`kind` 也是起点的一部分，两臂读到的不同即不比较。宿主把起点复制成两份项目副本，在副本里各建一个比较臂作业（`trigger: "explicit"`，带 `arm`，`improverVersion` 分别为父、子），各跑一遍诊断 → 提议 → 门控；门控在副本里再建自己的回放副本，规则不变，采用只发生在副本里，后代候选不带回真实项目。两臂的账本记录写进真实项目的账本，`improvementId` 是臂作业 id，`improvementPhase` 是臂作业自己的阶段，另带 `metaJobId` 与 `comparisonArm`；元改进作业的 `phases.compare` 是两臂之和。

每个臂记下它在自己副本里见到的起点、终态、错误、候选（后代）、门控结论与总费用（估算美元；`ComparisonArmResult`）。`decideImprover(origin, parent, child)` 按顺序：

1. 两臂纪元不同，或与准备的起点纪元不同：不采用（`epoch-mismatch`）；起点其他部分不同：不采用（`origin-mismatch`）。
2. 任一臂未知（`armOutcome`：作业未到终态，或为 `budget-exhausted` / `interrupted` / `cancelled`，或因 `improvement/invalid-diagnosis` 之外的错误失败，或门控结论为 `unknown-runs` / `budget-exhausted`，或费用未知）：不采用（`unknown-arm`）。没提出候选、诊断三次不合格这类失败是改进器自己的结果，不算未知。
3. 子臂没有后代：不采用（`no-offspring`；父臂也没有时同样不采用）。
4. 子臂的后代通过门控（臂作业 `adopted`）而父臂的没有：采用（`gate-passed`）。
5. 只有两臂的后代都通过门控时，才比质量与费用：子的门控质量（候选通过率）更高，采用（`quality-up`）；质量相同且子的总费用 ≤ 父的 0.9 倍（正好低 10% 也算），采用（`cost-down`）。只有父通过、或两者都没通过时，质量与费用不参与判断。
6. 其余不采用（`no-improvement`）。

`<jobId>/comparison.json`（结论出来后写一次）：`{ formatVersion, jobId, createdAt, origin, parent, child, verdict: { outcome, reason, quality?, costRatio? }, kept? }`。采用时宿主随即写 `improvers/activation/<n>.json`（`trigger: "meta-job"`），子改进器从下一个真实改进作业起生效。两份副本默认在结论写出后删除；`keepCopies` 时保留，`kept` 记副本根目录与字节数，供实验在副本里跑 holdout。

**费用与预算。** 元诊断、元提案与两臂的全部费用计入 `improvement.meta.budget`，不计入能力改进预算；用尽时进行中的元改进作业以 `budget-exhausted` 结束，比较中被打断的臂按未知算。

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
| `memberId` | string? | 步骤 3：成员交付时为成员的子会话 id |
| `memberName` | string? | 步骤 3：成员名，界面据此区分“最终成果”与“成员成果” |

规则：

- `deliverable.json` 只写一次，不改写。会话里的 `deliverable.presented` 带同样的 `deliverableId`、`version`、`title`、`summary`、`files`（`DeliverableVersionRef`），二者可以互相核对；列成果以 `outputs/` 下的 `deliverable.json` 为准（工具在写会话记录前失败时，可能有快照而没有会话记录）。
- 版本差异（`DeliverableStore.diff`）：按 `path` 对齐两版的文件，`change` 为 `added | removed | modified | unchanged`（按 `sha256` 判断）；两边都是文本时给出按行的统一差异块（`DiffHunk`，上下文 3 行），否则只报 `change`，`binary: true`。
- 反馈与成果的关联：`feedback` 记录带 `deliverableId` 与 `version`（见下节）；成果文件本身不记录反馈。
- 模型对 `outputs/` 只读；快照只由 `@nexgent/tasking` 写。
- 步骤 3：成员交付的版本带 `memberId`、`memberName`，`deliverable.presented` 的 `DeliverableVersionRef` 带 `memberName`。不给 `deliverableId` 时只在**同一会话**内按主文件路径追加版本，两个会话交同一路径各成一份成果；显式给 `deliverableId` 时照常追加，跨会话也可以（`agent-hooks.md` §步骤 2 工具）。

## 反馈

用户对一个成果版本给出评分与评语，即开始一个**反馈轮**。反馈只存在会话里，不另建文件；它是步骤 5 改进流程的输入。类型镜像：`FeedbackEntry`、`FeedbackListing`。

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

恢复语义：`feedback` 不改变投影；`FeedbackStore.list` 扫描项目内各会话的 `feedback` 记录得到列表（`submittedAt` 取记录的 `ts`）。强杀发生在 `feedback` 之后、轮次结束之前时，恢复按步骤 1 规则补 `turn.end { kind: "interrupted" }`，反馈记录保留，界面仍能列出。

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
| `keepMessages` | integer ≥ 1 | 摘要之后原样保留的末尾消息条数 |
| `compactedMessages` | integer ≥ 1 | 被并入摘要的消息条数（上一次的摘要算一条） |
| `requestId` | string | 产生摘要的辅助请求，与账本 `purpose: "auxiliary"` 的记录相关联 |
| `usage` | `LLMUsage` | 该请求的用量 |
| `trigger` | `{ inputTokens, threshold }` | 触发时的计费输入与阈值 |

投影：`messages` 变为 `[{ role: "user", content: renderCompactionSummary(summary) }]` 加压缩前 `messages` 的最后 `keepMessages` 条；`metadata.lastCompactionSeq` 记下该记录的 `seq`。`renderCompactionSummary` 的文本是契约的一部分：

```text
<conversation-summary>
The earlier part of this conversation was compacted. Summary:

<summary>
</conversation-summary>
```

规则：

- 保留段必须以 `user` 消息开始（一轮或一次注入的边界），工具调用与其结果不会被拆开；不满足时 `SessionStore.append` 拒绝写入（见“字段细则”）。
- **thinking 块**：被压进摘要的助手回复连同其 `providerContent`（thinking 块）一起丢弃，之后的请求不再回放；保留段里的助手回复照常带 `providerContent` 回放（ADR 0002 决策 4、ADR 0003）。
- 恢复：恢复算法从最后一个 checkpoint 起按顺序投影，遇到 `compaction` 就按上式替换，所以重建的历史与强杀前一致；不需要另外“找最后一条 compaction”。多次压缩时，后一次的摘要请求输入里包含前一次的摘要，`compactedMessages` 把它算作一条。
- `compaction` 不改变 `totalUsage`（辅助请求的用量只在账本与该记录的 `usage` 里）。
- 摘要请求失败不写 `compaction`，只写 `error`（`fatal: false`），历史保持原样。

## 子会话与成员

步骤 3 的每个成员（委派对象、队友、工作流节点）都是一个子会话：独立的 `sessions/<id>/session.jsonl` 与锁，可以单独恢复与只读查看。决策见 ADR 0004；类型镜像 `collaboration.ts` 与 `session.ts`。

- **会话头。** 子会话的 `session.start` 带 `parentSessionId`（发起它的会话，深度 1，所以总是根会话）与 `member: { name, executionForm, preset? }`。两者必须同时出现，`SessionStore.create` 拒绝只给一个的输入（`session/invalid-record`）。`name` 匹配 `^[a-z][a-z0-9-]{0,31}$`，`executionForm` 为 `delegated | team | workflow`。投影把二者放进 `SessionMetadata.parentSessionId` / `member`。
- **fork 种子。** fork 模式的子会话在 `session.start` 之后紧接一条 `fork.seed`（`seq: 2`）：`messages` 是父会话投影出的消息，截至父会话上一轮结束（`throughSeq` 为该轮 `turn.end` 的 `seq`），从父会话最近一次压缩之后开始（摘要消息本身保留）；保留的 `providerContent` 原样复制，thinking 块的回放规则与父会话相同。投影时 `messages` 直接成为子会话的初始历史；`fork.seed` 出现在任何消息或轮次之后时写入被拒。fresh 模式没有 `fork.seed`。
- **一次运行。** 成员的一次运行是子会话的一轮。父会话在运行开始时写 `subagent.start`（`childTurn` 为这一轮的编号，`task` 截取任务说明前 500 个字符），结束时写 `subagent.end`（`result: MemberResult`）。委派与工作流成员各只有一次运行。队友每被启动或唤醒一次就是一次运行：首次启动、被邮件唤醒（空闲时收到新邮件）、在下一个 Lead 轮次里续做被 `parent` 取消的工作，各是子会话的一轮，各有一对 `subagent.start` / `subagent.end`，`childSessionId` 不变。所以一个 Lead 轮次里同一队友可以有多对记录（团队包限制每个 Lead 轮次至多 8 次运行）。
- **`MemberResult`。** `{ status, text, deliverables, usage, requestCount, error? }`；`status` 为 `completed | failed | cancelled | budget | interrupted`，`text` 是成员最后一段回复（中断时为已流出的前缀），`deliverables` 是本次运行里 `present` 产出的版本（`DeliverableVersionRef[]`），`error` 只在非 `completed` 时出现。`budget` 表示任务树或成员份额的费用上限挡下了成员的下一次请求。
- **恢复。** 进程在成员运行中死亡时：子会话按步骤 1 规则补 `turn.end { kind: "interrupted" }`；父会话恢复时，对没有 `subagent.end` 的 `subagent.start` 补一条 `status: "interrupted"` 的 `subagent.end`（由协作包以宿主身份写），对没有 `workflow.end` 的 `workflow.start` 补 `status: "interrupted"`。已有 `subagent.end` 的成员不重跑。

## 团队

团队状态全部以记录写在 **Lead 会话**里，强杀后从记录重建；队友各自的会话只记它们自己的对话。类型镜像：`TeamMember`、`TeamTask`、`TeamMessage`。

- **花名册**（`team.member`）：`{ name, sessionId, status: active | idle | stopped, preset?, persona? }`，同名以最新一条为准。`persona` 是 `spawn_teammate` 传入、替换预设人设的那段文字，恢复时据此还原队友的人设。名字在一个 Lead 会话的在册队友中唯一；`lead` 保留给主对话。
- **任务板**（`team.task`）：`{ id, title, description?, status: pending | in_progress | completed | cancelled, owner?, dependsOn, result? }`，同 `id` 以最新一条为准；`id` 由任务板按 `t1`、`t2`… 分配。`dependsOn` 中任一任务未 `completed` 时，该任务不能进入 `in_progress`。上限 256 项。
- **邮箱**（`team.message`）：一条消息写两次，`id` 相同：发送时 `state: "queued"`，注入收件人会话后 `state: "delivered"`。收件人正在运行时，邮件在它下一次模型请求之前经 kernel 的 `Agent.beforeRequest` 注入；收件人空闲时先被唤醒，邮件在新一轮开始时注入；发给 `lead` 的邮件由 `wait_teammates` 的结果交给 Lead（`delivered` 写在该调用里），或在 Lead 下一轮开始时注入。恢复时，只有 `queued` 而没有对应 `delivered` 的消息投递一次，投递后补写 `delivered`；已 `delivered` 的不再投递。每个收件人待投递至多 64 条，单条正文至多 64 KiB（UTF-8）。
- 注入的形式是收件人会话里的一条 `user.message { source: "inject" }`，正文含发件人名；它不出现在 Lead 的消息历史里。

## 工作流

`workflow` 工具在父会话的一次调用里运行一段脚本或一张图（前台）。类型镜像：`WorkflowStartRecord` 等与 `ArchitectureGraph`。

- `workflow.start` 带新生成的 `workflowId`（小写 UUID v4）与 `kind`；图运行另带 `architecture`（保存的图的 SHA-256）。脚本每次调用 `phase(name)` 写一条 `workflow.phase`。每个 `agent()` 成员在父会话里有一对 `subagent.start` / `subagent.end`，`executionForm: "workflow"`，带 `workflowId`。
- `workflow.end.status` 为 `completed | failed | cancelled | interrupted`，`members` 为它建出的子会话数。某个成员失败时整体以 `failed` 结束并带 `error`，已完成成员的成果保留。
- 同时运行的成员至多 4 个，一棵任务树的成员总数至多 16 个，一张图至多 16 个节点（`COLLABORATION_LIMITS`）。

## 预设

预设决定成员的人设、工具范围与模型参数，只填字段、不含代码。类型镜像：`AgentPreset`、`PresetFile`；校验：`assertPresetFile`（schema `PRESET_FILE_SCHEMA`）。

- 文件：`.nexgent/presets/<name>.json`，`name` 字段必须等于文件基名，匹配 `^[a-z][a-z0-9-]{0,63}$`。字段：`formatVersion: 1`、`name`、`description`（一行，给选预设的模型看）、`persona?`（替换系统提示的默认人设段）、`tools?: { allow?, deny? }`、`sandboxMode?`、`model?`、`effort?`、`thinking?`、`maxSteps?`。未知字段与错误类型报 `config/invalid`。
- 内置三份：`read-only-analyst`（只读分析）、`read-only-checker`（只读检查）、`general-executor`（通用执行者，继承父会话的模式）。同名时项目预设覆盖内置预设。
- 预设只能收窄：`tools` 与父会话可见集合求交，`sandboxMode` 宽于父会话时报错（`permissions.md` §子会话继承）。

## 架构图存储

模型交给 `workflow` 的声明式图在执行前规范化并保存，供重放与步骤 4 的采用引用。移植自 PR #4 的 `architecture.ts` / `architecture-store.ts`。

- 文件：`.nexgent/architectures/<sha256>.json`，内容 `{ "format": 1, "architecture": { "nodes": [...] } }`；`<sha256>` 是 `JSON.stringify({ format: 1, nodes })` 的小写十六进制哈希，`nodes` 先规范化（按 `id` 排序，`dependencies` 排序去重，`tools.allow` / `deny` 排序去重）。
- 节点：`{ id, prompt, dependencies, preset?, tools?, model? }`；`id` 是成员名，图内唯一；依赖必须指向已有节点、不得成环，违者在保存前报可读错误，不写文件。
- 写入：先写临时文件，再以硬链接发布到目标名（目标已存在则读回校验哈希）；文件一经写出不改。Windows 上硬链接需在验收中补测。

## 版本与兼容

| 格式 | 版本字段 | 当前 | 升级方式 |
| --- | --- | --- | --- |
| 会话 JSONL | `session.start.version` | 1 | 新版本写新文件名（`session.v2.jsonl`）；读取方按 `session.start.version` 分派 |
| checkpoint 状态 | `state.version` | 1 | 随会话格式 |
| 账本 | 无记录级字段；文件名 `requests.jsonl` 即 v1 | 1 | 新版本写新文件名（`requests.v2.jsonl`） |
| 项目配置 | `version` | 1 | 读取方拒绝未知版本 |
| 凭证文件 | `version` | 1 | 同上 |
| 材料元数据（步骤 2） | `formatVersion` | 1 | 同上 |
| 成果版本元数据（步骤 2） | `formatVersion` | 1 | 同上 |
| 能力包清单、采用修订、候选、试验收据、决定、快照（步骤 4） | `formatVersion` / `format` | 1 | 同上 |
| 改进队列、作业、诊断（步骤 5） | `formatVersion` | 1 | 同上 |
| 改进器、改进器采用修订、元诊断、改动、父子比较（步骤 6） | `formatVersion` / `format` | 1 | 同上 |

兼容规则：

- **同版本内只能加可选字段。** 加必填字段、改字段类型、改记录语义都是新版本。
- **读取方忽略未知的可选字段**（同版本的新写入方可以多写）。
- **会话读取方拒绝未知的 `type`**：未知记录类型意味着投影不再可靠，按无效行处理（截断并报告），不静默跳过。账本读取方对未知 `type` 跳过并计数。
- **不兼容旧 Python 数据**：Python 时代的 Episode、组织 SQLite、PR #4 的 `.nexgent/native/` 不读、不迁移（ADR 0001 决策 15）。
- 步骤 4 的四个预留字段已经在 v1 中是可选字段，启用它们不升版本。
- **步骤 4 的四种会话记录、`session.start.capabilityVersion`、账本的 `capability.decision` 与新可选字段也在 v1 内追加**，理由同步骤 3；步骤 3 写出的会话与账本照常读出。
- **步骤 2 的新记录类型在 v1 内追加**（计划已定：旧文件仍可读）。代价是：只认识步骤 1 记录集的读取方会把第一条步骤 2 记录当作无效行，持锁追加时还会截断其后的内容。步骤 1 没有对外发布的构建，`nexgent-app` 上的读取方与写入方同步升级，所以接受这一点；步骤 2 之后再加记录类型时，先评估是否已有对外发布的读取方，有则升版本。
- **步骤 5 的 `session.start.purpose` / `improvement`、账本的 `improvementId` / `improvementPhase` 与 `improvement.end`、候选的 `origin` / `jobId`、`ReplayCaseRef.throughTurn` / `feedbackIds`、收据 `trial.feedback`、`TrialVerdict.feedbackPassRate`、快照与检查记录的 `turn`，以及 ADR 0007 的 `TrialVerdict.costBasis`、`TrialPlan.costApprovalRatio` 与设置 `capabilities.costApprovalRatio` 都在各自的 v1 内追加**；步骤 4 写出的会话、账本与能力文件照常读出。只认识步骤 4 收据类型的读取方会拒绝含 `trial.feedback` 的收据文件，与读写方同步升级（仍没有对外发布的构建）。`autoImprove` 默认值从 `false` 改为 `true`：没写这个字段的项目在步骤 5 起自动改进开启（ADR 0006）。
- **步骤 6 的 `session.start.improvement.improverVersion` / `metaJobId` / `comparisonArm` 与两个新 `phase` 值、账本的 `improverVersion` / `metaJobId` / `comparisonArm` 与新 `improvementPhase` 值、`improvement.end` 的 `kind` / `childVersion` / `trigger: "job-count"` / 新阶段键、作业的 `kind` / `improverVersion` / `arm` / `meta` 与三个元改进状态、队列的 `metaCounted` / `metaPending`、`TrialPlan.epoch` 都在各自的 v1 内追加**；新文件（`improvers/` 下两种、元改进作业目录下三种）归入 `improvement.v1.schema.json`。步骤 5 写出的会话、账本、改进作业与能力文件照常读出（测试用步骤 5 Linux 第 2 次真实运行的行做夹具）；缺 `improverVersion` 的作业读作 `v0`，缺 `kind` 的读作 `capability`。
- **步骤 3 的九种新记录、`session.start.member` 与成果的成员字段也在 v1 内追加。** 评估结果：仍没有对外发布的构建（`main` 上的步骤 2 只供本仓库验收），读取方与写入方同步升级，所以不升版本；步骤 2 写出的会话照常读出、恢复与续写。

## schema 与读写测试

**schema 存放。** 每种格式一份 JSON Schema（draft 2020-12），放在拥有该格式的包里，与本文和契约类型同步修改：

| 格式 | schema | 拥有包 |
| --- | --- | --- |
| 会话记录（含 checkpoint 状态） | `packages/session/schema/session.v1.schema.json` | `@nexgent/session` |
| 账本记录 | `packages/llm/schema/ledger.v1.schema.json` | `@nexgent/llm` |
| 项目配置、凭证文件、锁文件 | `packages/kernel/schema/config.v1.schema.json`、`credentials.v1.schema.json`、`session-lock.v1.schema.json` | `@nexgent/kernel` |
| 材料元数据、成果版本元数据（步骤 2） | `packages/session/schema/material.v1.schema.json`、`deliverable.v1.schema.json` | 与会话 schema 共用 `@nexgent/session` 的求值器；写入方是 `@nexgent/tasking` |
| 能力文件与快照（步骤 4） | `packages/session/schema/capabilities.v1.schema.json`（按 `$defs/<name>` 校验，`validateCapabilityFile`） | 与会话 schema 共用求值器；写入方是 `@nexgent/capabilities` |
| 改进队列、作业、诊断（步骤 5）；改进器、采用修订、元诊断、改动、父子比较（步骤 6） | `packages/session/schema/improvement.v1.schema.json`（按 `$defs/<name>` 校验，`validateImprovementFile`） | 与会话 schema 共用求值器；写入方是 `@nexgent/evolve`；改进器与采用修订由 `@nexgent/capabilities` 的 `ImproverStore` 写 |

schema 用 `oneOf` 按 `type` 分派记录类型，`additionalProperties: false`（账本记录除外：它允许未知可选字段以便跨版本读取）。会话 schema 的严格校验只用于写入方的追加；读取方按上面的兼容规则放过未知的可选字段，不因此截断。

**必测项。**

会话（`@nexgent/session`）：

1. 往返：每种记录类型各一条，写入后 `readAll` 得到逐字段相等的记录；本文的示例行作为 fixture 必须通过 schema 与往返。
2. 截断：写入 N 条记录后在每个换行边界以及若干行中间字节位置截断文件，`readAll` 返回截断点之前的全部完整记录、`truncation` 指向正确的行号与字节偏移；之后 `append` 先写 `error` 记录再写新记录，`seq` 连续。
3. 中间损坏：把中间某行改成非 JSON，恢复停在该行，其后的有效行被丢弃并报告。
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

步骤 2 新增（`@nexgent/session`）：

1. 七种新记录各一条写入后 `readAll` 逐字段相等，并通过 schema；投影出的 `goal`、`lastCompactionSeq` 与压缩后的 `messages` 符合上面的投影表。
2. 不合格的 `compaction`（保留段越界或不以 `user` 开始）与 `goal.update`（目标 ID 不符）在写入前被拒，文件不变。
3. 步骤 1 写出的真实会话（夹具 `packages/session/tests/fixtures/step1-real-session.jsonl`，取自步骤 1 真实模型验收的第一轮及其 checkpoint）能被读出、恢复，并能在其后追加步骤 2 记录。
4. `material.json` 与 `deliverable.json` 读写往返并通过 schema；含 `\` 的路径、大写或长度不对的 SHA-256 被拒。

步骤 3 新增（`@nexgent/session`）：

1. 九种新记录各一条写入后 `readAll` 逐字段相等并通过 schema；父会话里的这些记录不改变投影出的消息。
2. 子会话的 `session.start.member` 与 `fork.seed` 往返，恢复后 `parentSessionId`、`member` 与 fork 历史一致；`fork.seed` 出现在消息之后、只给 `parentSessionId` 不给 `member` 时写入被拒。
3. 成员名、`executionForm`、`MemberResult.status`、`TeamMessage.state`、`architecture` 哈希的非法值被 schema 拒绝。
4. 步骤 2 写出的真实会话照常读出与恢复（在本地对 Library `validation-raw/step-2-20261011/` 的会话核对；原始 JSONL 不进仓库）。

步骤 4 新增（`@nexgent/session`、`@nexgent/kernel`）：

1. 四种新会话记录各一条写入后逐字段相等并通过 schema，不改变投影出的消息；`session.start.capabilityVersion` 与 `capability.version` 投影到 `metadata.capabilityVersion`；步骤 3 的会话（没有该字段）照常读出与恢复。
2. 十二种能力文件各有合格与不合格样例；`context-policy` 带 `approvals`、`costCaps`、`sandboxMode`、`capabilities` 时被拒（H13）；发布的 `capabilities.v1.schema.json` 与源一致。
3. 账本 `capability.decision` 与 `task.outcome` 的新字段通过 schema；本文账本示例行包含 `capability.decision`。
4. `canonicalManifestText` 与组件、文件顺序无关；`assertCapabilityManifest`、`isNextRevision`、`decideTrial` 每个分支、`decideUsageRollback`、`assertCapabilitiesConfig` 的下限有运行时测试。

步骤 5 新增（`@nexgent/session`、`@nexgent/kernel`、`@nexgent/workspace`、`@nexgent/sdk`）：

1. 三种改进文件各有合格与不合格样例；发布的 `improvement.v1.schema.json` 与源一致。
2. `session.start.purpose` / `improvement` 往返并投影到 `metadata`；只给其一时 `create` 被拒；步骤 4 的会话（没有这两个字段）照常读出。
3. 账本 `improvement.end` 与 `improvementId` / `improvementPhase` 以写入方的严格校验通过；本文账本示例行包含它们。
4. 候选的 `origin` / `jobId`、`trial.feedback`、带 `throughTurn` / `feedbackIds` 的用例、`feedbackPassRate`、带 `turn` 的快照与检查通过 schema，步骤 4 的同类文件不带这些字段也通过。
5. `countSignal`、`takeBatch`、`releaseJobSlot`、`batchTrigger`、`isCountedFeedback`、`canMoveImprovement`、带反馈检查的 `decideTrial`、`perTurnFileName`、`assertImprovementConfig` 有运行时测试；`autoImprove` 默认 `true`，`autoImprove` 与 `improvement` 在 `GUARDED_PROJECT_CONFIG_FIELDS` 里；两个配置读取方都接受并校验 `improvement`。

步骤 6 新增（`@nexgent/session`、`@nexgent/kernel`、`@nexgent/llm`、`@nexgent/evolve`）：

1. 五种新改进文件各有合格与不合格样例；元改进作业、比较臂作业、带 `metaCounted` / `metaPending` 的队列通过 schema；`IMPROVEMENT_FILE_DEFS` 的每个种类都有样例。
2. 账本的元改进阶段、比较臂字段与 `kind: "meta"` 的 `improvement.end` 以写入方的严格校验通过，`compare` 作为单条记录的阶段被拒；手写的 `ledger.v1.schema.json` 的枚举与 kernel 常量逐项相等；本文账本示例行包含比较臂记录。
3. 步骤 5 Linux 第 2 次真实运行的队列、作业、诊断、账本行、会话开头与试验收据（夹具 `packages/session/tests/fixtures/step5-run2/`）照常通过 schema。
4. `IMPROVER_V0` 渲染出的诊断策略与提案简报与 `@nexgent/evolve` 当前的文字逐字相等（0、2、5 个失败类型，每种组件）。
5. `checkImproverChange` 的每种拒绝、`isNextImproverRevision`、`decideImprover` 的每条规则（含“只在两者都通过时比质量与费用”和“正好低 10% 算省”）、`countFinishedJob` / `takeMetaBatch`、`canMoveJob`、`jobPhaseTimes`、纪元随评价器设置变化而与 `selectionCases` / `repeats` 无关、`improvement.meta` 的默认值与校验有运行时测试。

契约层（`packages/kernel/tests/contracts/`）：类型级断言固定记录集合与公共字段，纯函数（`addUsage`、工具限制交集、布局解析、profile 补丁）有运行时测试。
