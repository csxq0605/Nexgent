# 数据与文件格式规范

> 步骤 1 章节（目的与范围、目录布局、项目配置、会话 JSONL v1、账本记录、版本与兼容、schema 与测试）已写定；`CapabilityBundle` 清单、材料元数据、成果元数据留标题，在对应步骤填写。每种格式配 JSON schema 与读写测试，二者与本文同步改。本文的类型镜像在 `packages/kernel/src/contracts/`（`session.ts`、`ledger.ts`、`config.ts`、`workspace.ts`、`credentials.ts`），两处不一致时以本文为准并提契约修改 PR。来源：计划 4.10 第 1 行；分工见 `docs/plan/step-1-work-partition.md`。

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
    ├── materials/                        资料（步骤 2 填）
    ├── outputs/                          成果快照（步骤 2 填）
    └── capabilities/                     能力版本（步骤 4 填）
```

| 路径 | 内容 | 命名 | 创建者 | 写入者 |
| --- | --- | --- | --- | --- |
| `config.json` | 项目配置 | 固定 | 用户或 `nexgent run` 首次运行（写入默认值） | 用户、桌面应用（步骤 2） |
| `sessions/<sessionId>/` | 一个会话的全部文件 | `sessionId` 为小写 UUID v4 | `SessionStore.create` | `@nexgent/session` |
| `sessions/<sessionId>/session.jsonl` | 会话记录 | 固定 | 同上 | 同上 |
| `sessions/<sessionId>/.lock` | 锁文件 | 固定 | `SessionStore.create` / `lock` | 同上 |
| `ledgers/<yyyy-mm>/requests.jsonl` | 该月（UTC）的全部账本记录 | 月份取记录 `ts` 的 UTC 年月 | 第一次追加时 | `@nexgent/llm`（请求与工具记录）、`apps/cli`（`task.outcome`） |
| `materials/` | 资料 | 步骤 2 | `ensureLayout` | 步骤 2 |
| `outputs/` | 成果快照 | 步骤 2 | `ensureLayout` | 步骤 2 |
| `capabilities/` | 能力版本 | 步骤 4 | `ensureLayout` | 步骤 4 |

规则：

- `.nexgent/` 内部对模型可见的文件工具按子目录区分：`sessions/`、`ledgers/`、`capabilities/` 读写都拒绝，`materials/` 与 `config.json` 只读，`outputs/` 可读写；规则以 `permissions.md` §路径策略与写入限制为准。
- 所有路径在服务内部以绝对路径处理（`WorkspaceLayout`）；记录里出现的路径（如 `session.start.projectRoot`）也是绝对路径。
- 是否纳入版本控制由项目自己决定；建议忽略 `sessions/`、`ledgers/`、`outputs/`，保留 `config.json`。
- 本机凭证文件不在项目内：`~/.nexgent/credentials.json`（Windows 为 `%USERPROFILE%\.nexgent\credentials.json`），形状见“项目配置文件”末尾。

## 项目配置文件

文件：`.nexgent/config.json`，一个 JSON 对象。文件不存在等同于 `{}`；每个字段都有默认值。启动时读取一次，运行中不热加载。密钥不写在这里。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `version` | `1` | `1` | 格式版本；只有 1 |
| `model` | string | `"claude-sonnet-5-5"` | 传给端点的模型 ID（ADR 0002） |
| `endpoint` | string | `"https://api.anthropic.com"` | Claude API 的 base URL，不含路径与凭证；环境变量 `NEXGENT_API_BASE_URL` 可覆盖 |
| `thinking` | `"off" \| "on"` | `"off"` | 执行时是否开启 reasoning；`off` 是 provider 的最低 thinking 设置（ADR 0002 决策 3） |
| `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | 推理深度（`output_config.effort`） |
| `sandboxMode` | `"read-only" \| "workspace-write" \| "full-access"` | `"workspace-write"` | 新会话的默认沙箱模式；语义见 `permissions.md` |
| `costCaps.perTask` | `CostCap` | 无 | 每任务上限 |
| `costCaps.perProject` | `CostCap` | 无 | 每项目上限 |
| `approvals` | `ApprovalGrant[]` | `[]` | `project` 范围的审批授权；语义见 `permissions.md` |
| `extraReadRoots` | `string[]` | `[]` | 额外可读的绝对目录；语义见 `permissions.md` |
| `autoImprove` | boolean | `false` | 反馈触发的自动改进（步骤 5）开关 |

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
  "thinking": "off",
  "effort": "medium",
  "sandboxMode": "workspace-write",
  "costCaps": { "perTask": { "maxRequests": 50 } },
  "autoImprove": false
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
| `session.start` | 创建会话时，必为 `seq: 1` | `version: 1`、`projectRoot`、`model`、`sandboxMode`、`parentSessionId?`、`title?` |
| `turn.start` | 一轮开始（一条用户消息及其触发的全部模型调用与工具调用） | `turn` |
| `user.message` | 用户消息进入会话，或注入的合成上下文 | `turn`、`content`、`source: "user" \| "inject"` |
| `assistant.message` | 一次模型调用的流结束（含被取消的流） | `turn`、`step`、`requestId`、`content`、`toolCalls?`、`usage`、`finishReason`、`interrupted?`、`providerContent?`、`refusal?` |
| `tool.result` | 一次工具调用返回 | `turn`、`step`、`toolCallId`、`name`、`content`、`isError`、`error?`、`meta?`、`durationMs` |
| `turn.end` | 一轮结束 | `turn`、`reason` |
| `checkpoint` | 见“checkpoint” | `coversSeq`、`state` |
| `error` | 不属于某条 `turn.end` / `tool.result` 的失败（如账本写失败、恢复时的截断、费用上限） | `turn?`、`error`、`fatal` |
| `approval.request` | 一次工具调用需要审批 | `turn`、`request: ApprovalRequest` |
| `approval.decision` | 审批得到应答（含超时、取消、非 TTY 拒绝） | `turn`、`decision: ApprovalDecision` |
| `approval.grant` | 用户选择 `session` 范围放行，紧跟对应的 `approval.decision` | `grant: { tool, pattern?, grantedAt }` |

字段细则：

- `assistant.message.toolCalls[]`：`{ id, name, arguments }`，`arguments` 是模型产出的原始 JSON 文本，不在此处解析。
- `assistant.message.usage`：`LLMUsage`，五个字段 `inputTokens / outputTokens / totalTokens / cacheReadTokens / reasoningTokens` 每个都是非负整数或字符串 `"unknown"`；provider 没报用量时全为 `"unknown"`，不写 0。
- `assistant.message.finishReason`：`stop | tool-calls | max-tokens | aborted | refusal | error`。`refusal` 时附 `refusal: { category?, explanation? }`，该回复的工具调用不执行。
- `assistant.message.providerContent`：provider 返回的内容块原样（JSON），用于回放时保留 thinking 块（ADR 0002 决策 4）；provider 没给则不写。
- `assistant.message.interrupted: true`：该轮在流中被取消，`content` 是已流出的前缀，`toolCalls` 不写（未派发的调用不进入历史）。
- `tool.result.error`：`ErrorInfo = { name, code, message, details? }`，仅当 `isError` 为真；`meta` 是工具私有的 JSON 值（如 diff），原样持久化。
- `max-tokens` 且回复含工具调用时：工具调用记录在案但不执行，轮次以 `{ kind: "max-tokens" }` 结束；下一次请求由历史修复以合成的错误结果答复这些调用。
- `turn.end.reason`：`{ kind: "completed" }`、`{ kind: "cancelled", cause: "user" | "timeout" | "shutdown" | "cost-cap" }`、`{ kind: "error", error: ErrorInfo }`、`{ kind: "max-tokens" }`、`{ kind: "interrupted" }`。最后一种只由恢复过程写出，用来关闭上一个进程没来得及关闭的轮次。
- `error.fatal`：为真表示会话不能继续；恢复时遇到最后一条是 fatal 的 `error`，`resume` 仍返回状态，由调用方决定是否继续。

一轮的记录顺序固定为：`turn.start` → `user.message` → （`assistant.message` → `tool.result`×n）×steps → `turn.end`。需要审批的调用在其 `tool.result` 之前插入 `approval.request` → `approval.decision`（→ `approval.grant`）。`ApprovalRequest` / `ApprovalDecision` 的字段见 `permissions.md`。`step` 从 1 起，在轮内递增。

### 示例

一次“写文件”任务的完整会话（为可读省略了部分 `ts`）：

```jsonl
{"type":"session.start","seq":1,"ts":"2026-10-07T08:00:00.000Z","sessionId":"6f1c…","version":1,"projectRoot":"/home/u/proj","model":"claude-sonnet-5-5","sandboxMode":"workspace-write"}
{"type":"turn.start","seq":2,"ts":"…","sessionId":"6f1c…","turn":1}
{"type":"user.message","seq":3,"ts":"…","sessionId":"6f1c…","turn":1,"content":"把 README 第一行改成 Hello","source":"user"}
{"type":"assistant.message","seq":4,"ts":"…","sessionId":"6f1c…","turn":1,"step":1,"requestId":"a0b1…","content":"","toolCalls":[{"id":"call_1","name":"str_replace","arguments":"{\"path\":\"README.md\",\"old\":\"# Hi\",\"new\":\"# Hello\"}"}],"usage":{"inputTokens":812,"outputTokens":37,"totalTokens":849,"cacheReadTokens":0,"reasoningTokens":0},"finishReason":"tool-calls"}
{"type":"tool.result","seq":5,"ts":"…","sessionId":"6f1c…","turn":1,"step":1,"toolCallId":"call_1","name":"str_replace","content":"replaced 1 occurrence","isError":false,"durationMs":4}
{"type":"assistant.message","seq":6,"ts":"…","sessionId":"6f1c…","turn":1,"step":2,"requestId":"c2d3…","content":"已改好。","usage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","reasoningTokens":"unknown"},"finishReason":"stop"}
{"type":"turn.end","seq":7,"ts":"…","sessionId":"6f1c…","turn":1,"reason":{"kind":"completed"}}
{"type":"checkpoint","seq":8,"ts":"…","sessionId":"6f1c…","coversSeq":7,"state":{"sessionId":"6f1c…","version":1,"messages":[{"role":"user","content":"把 README 第一行改成 Hello"},{"role":"assistant","content":"","toolCalls":[{"id":"call_1","name":"str_replace","arguments":"{…}"}]},{"role":"tool","toolCallId":"call_1","name":"str_replace","content":"replaced 1 occurrence","isError":false},{"role":"assistant","content":"已改好。"}],"metadata":{"createdAt":"2026-10-07T08:00:00.000Z","projectRoot":"/home/u/proj","model":"claude-sonnet-5-5","sandboxMode":"workspace-write","grants":[],"lastTurn":1,"totalUsage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","reasoningTokens":"unknown"},"lastSeq":7}}}
```

被取消的一轮：

```jsonl
{"type":"turn.start","seq":9,"ts":"…","sessionId":"6f1c…","turn":2}
{"type":"user.message","seq":10,"ts":"…","sessionId":"6f1c…","turn":2,"content":"再写一段介绍","source":"user"}
{"type":"assistant.message","seq":11,"ts":"…","sessionId":"6f1c…","turn":2,"step":1,"requestId":"e4f5…","content":"Nexgent 是","usage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","reasoningTokens":"unknown"},"finishReason":"aborted","interrupted":true}
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
| 任意记录 | — | `lastSeq = seq` |

`SessionMetadata` 字段：`createdAt`、`projectRoot`、`model`、`sandboxMode`、`grants`、`title?`、`lastTurn`、`openTurn?`、`totalUsage`、`lastSeq`。

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
| `capabilityVersion` | string? | 预留（步骤 4）：采用中的能力版本的内容哈希 |
| `memberId` | string? | 预留（步骤 3/4）：发出请求的团队成员 |
| `executionForm` | `"direct" \| "delegated" \| "workflow"`? | 预留（步骤 4）：执行形态 |
| `taskId` | string? | 预留（步骤 4）：所属任务，一条 `task.outcome` 收尾 |

四个预留字段在所有记录类型上都是可选的；步骤 1 的写入方不写它们，读取方忽略它们。

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
| `usage` | `LLMUsage` | provider 未报或请求早期失败时五个字段全为 `"unknown"`，不写 0 |
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
| `checks` | `TaskCheck[]`? | 宿主做的确定性检查 `{ name, passed, detail? }`；步骤 1 可无 |
| `toolsUsed` | string[] | 实际调用过的工具名，去重；步骤 4 用它证明组件被实际调用 |

### 示例

```jsonl
{"type":"llm.request.start","ts":"2026-10-07T08:00:01.000Z","sessionId":"6f1c…","requestId":"a0b1…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","purpose":"task","thinking":"off"}
{"type":"llm.request.end","ts":"2026-10-07T08:00:03.200Z","sessionId":"6f1c…","requestId":"a0b1…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","status":"ok","usage":{"inputTokens":812,"outputTokens":37,"totalTokens":849,"cacheReadTokens":0,"reasoningTokens":0},"latencyMs":2200,"httpStatus":200,"finishReason":"tool-calls"}
{"type":"tool.call","ts":"2026-10-07T08:00:03.210Z","sessionId":"6f1c…","turn":1,"callId":"call_1","name":"str_replace","effects":["write"],"approval":{"required":false,"decision":"auto"},"isError":false,"durationMs":4}
{"type":"llm.request.start","ts":"2026-10-07T08:00:03.300Z","sessionId":"6f1c…","requestId":"c2d3…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","purpose":"task","thinking":"off"}
{"type":"llm.request.end","ts":"2026-10-07T08:00:04.100Z","sessionId":"6f1c…","requestId":"c2d3…","provider":"anthropic","endpoint":"https://api.anthropic.com","model":"claude-sonnet-5-5","status":"error","usage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","reasoningTokens":"unknown"},"latencyMs":800,"httpStatus":503,"errorCode":"llm/request-failed"}
{"type":"task.outcome","ts":"2026-10-07T08:00:04.200Z","sessionId":"6f1c…","status":"failed","totalUsage":{"inputTokens":"unknown","outputTokens":"unknown","totalTokens":"unknown","cacheReadTokens":"unknown","reasoningTokens":"unknown"},"requestCount":2,"toolCallCount":1,"turns":1,"toolsUsed":["str_replace"]}
```

### 必产生记录的失败路径

`@nexgent/llm` 的完成定义要求下列每种情况各产生一对 start / end：断网（`status: error`，无 `httpStatus`）、连接或流空闲超时（`error`，`errorCode: llm/timeout`）、HTTP 4xx / 5xx（`error`，带 `httpStatus`）、调用方中止（`aborted`）。用量字段在这些情况下全为 `"unknown"`。

## `CapabilityBundle` 清单

一句话（步骤 4 填）：内容寻址的能力集清单，含工具、技能、上下文策略、协作方式四类组件及采用状态。

## 材料元数据

一句话（步骤 2 填）：`materials/<id>/` 的来源、类型、添加时间与引用方式。

## 成果元数据

一句话（步骤 2 填）：`outputs/` 每轮快照与 `present` 声明的对应关系、版本号与反馈关联。

## 版本与兼容

| 格式 | 版本字段 | 当前 | 升级方式 |
| --- | --- | --- | --- |
| 会话 JSONL | `session.start.version` | 1 | 新版本写新文件名（`session.v2.jsonl`）；读取方按 `session.start.version` 分派 |
| checkpoint 状态 | `state.version` | 1 | 随会话格式 |
| 账本 | 无记录级字段；文件名 `requests.jsonl` 即 v1 | 1 | 新版本写新文件名（`requests.v2.jsonl`） |
| 项目配置 | `version` | 1 | 读取方拒绝未知版本 |
| 凭证文件 | `version` | 1 | 同上 |

兼容规则：

- **同版本内只能加可选字段。** 加必填字段、改字段类型、改记录语义都是新版本。
- **读取方忽略未知的可选字段**（同版本的新写入方可以多写）。
- **会话读取方拒绝未知的 `type`**：未知记录类型意味着投影不再可靠，按无效行处理（截断并报告），不静默跳过。账本读取方对未知 `type` 跳过并计数。
- **不兼容旧 Python 数据**：Python 时代的 Episode、组织 SQLite、PR #4 的 `.nexgent/native/` 不读、不迁移（ADR 0001 决策 15）。
- 步骤 4 的四个预留字段已经在 v1 中是可选字段，启用它们不升版本。

## schema 与读写测试

**schema 存放。** 每种格式一份 JSON Schema（draft 2020-12），放在拥有该格式的包里，与本文和契约类型同步修改：

| 格式 | schema | 拥有包 |
| --- | --- | --- |
| 会话记录（含 checkpoint 状态） | `packages/session/schema/session.v1.schema.json` | `@nexgent/session` |
| 账本记录 | `packages/llm/schema/ledger.v1.schema.json` | `@nexgent/llm` |
| 项目配置、凭证文件、锁文件 | `packages/kernel/schema/config.v1.schema.json`、`credentials.v1.schema.json`、`session-lock.v1.schema.json` | `@nexgent/kernel` |

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

契约层（`packages/kernel/tests/contracts/`）：类型级断言固定记录集合与公共字段，纯函数（`addUsage`、工具限制交集、布局解析、profile 补丁）有运行时测试。
