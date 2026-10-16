# @nexgent/context

每轮请求在存储的历史之外附带的上下文，以及长对话的基本压缩。实现 kernel 契约
`packages/kernel/src/contracts/context.ts` 的 `ContextProvider`、`Compactor` 与 `ContextService`；挂点的位置、
顺序与失败语义见 `docs/spec/agent-hooks.md`，`compaction` 记录与恢复语义见 `docs/spec/data-formats.md` §压缩，
资料元数据见同文 §材料元数据。

归属：步骤 2 W1（`docs/plan/step-2-work-partition.md`）。运行时依赖：Node 内置模块、`@nexgent/kernel`、
`@nexgent/session`（只用 `material.json` 的 schema 校验）。

## Public API

| Export | Contract | What it does |
| --- | --- | --- |
| `ContextPlugin` / `apply` / `name` | Cordis plugin | 行名 `@nexgent/context`；`inject: ['workspace', 'llm']`，`ctx.provide('context')`：自带 `workspace-instructions` 与 `materials` 两个提供者，默认装上 `BasicCompactor` |
| `createContextService(ctx, config)` → `ContextRegistry` | `ContextService` | 不经 Cordis 的工厂 |
| `ContextRegistry` / `orderProviders` | `ContextService` | 提供者顺序固定为 `workspace-instructions`、`goal`、`skills`、`materials`，其余按注册顺序；同 id 重复注册 → `config/invalid`；`register` 返回幂等的注销函数 |
| `workspaceInstructionsProvider(options)` / `loadInstructions` / `renderInstructionsBody` | `ContextProvider` | 见下“说明文件” |
| `materialsProvider(options)` / `planMaterialReferences` / `renderMaterialReferences` / `readMaterialMetadata` | `ContextProvider` | 见下“资料引用” |
| `BasicCompactor(options)` | `Compactor` | 见下“压缩” |
| 纯函数 | — | `planCompaction` `segmentStarts` `applyCompaction` `isCompactionSummary` `renderTranscript` `resolveCompactionThreshold` `truncateUtf8` `fenceFor` `clip` |

## 插件配置（profile 行 `@nexgent/context`）

```yaml
- id: context
  name: '@nexgent/context'
  config:
    instructions: { maxBytes: 32768 }
    materials: { inlineMaxBytes: 32768, inlineTotalMaxBytes: 98304 }
    compaction:
      enabled: true            # false: 不装压缩器（loop 不压缩）
      thresholdTokens: 160000  # 环境变量 NEXGENT_COMPACTION_THRESHOLD 覆盖
      keepRecentTurns: 2
      maxTokens: 32000         # 摘要请求的输出上限
      # timeoutMs / thinking / effort 可选；thinking、effort 缺省时取 .nexgent/config.json，再缺省取 DEFAULT_PROJECT_CONFIG（thinking on）
```

顶层未知字段 → `config/invalid`；非法数值（非正整数等）在启动时报 `config/invalid`。不新增 `config.json` 字段。

## 说明文件（`workspace-instructions`）

- 每轮开始读项目根的 `AGENTS.md`；**不存在**时读 `NEXGENT.md`。`AGENTS.md` 存在但为空白时视为没有说明，不回退。同名目录视为不存在。
- 输出一节系统提示 `# Project instructions`（`id: workspace-instructions`），不写会话；文件改动从下一轮起生效。
- 上限 `maxBytes`（默认 32 KiB）。超出时在 UTF-8 字符边界截断，若截断点前 20% 内有换行则截在换行处，末尾附
  `[<文件> is <大小>; only the beginning is shown here. Read the file for the rest.]`。
- 读文件出错（不是“不存在”）时抛 `internal`，loop 跳过本提供者并写非致命 `error`。

## 资料引用（`materials`）

- 只在本轮用户消息带 `materialIds` 时工作，输出一段 `inject` 文本（loop 写成 `user.message { source: 'inject' }`，在用户消息之前）。
- 元数据来自 `.nexgent/materials/<id>/material.json`（唯一来源），读取时用 `@nexgent/session` 的 schema 校验；不合法 → `session/corrupt`（本轮跳过提供者）。
- 文本开头说明资料是 `.nexgent/materials/` 下的只读副本、结果写到项目别处；每份资料列出 `originalName`、`path`、字节数、`mediaType`。
- 内联：`text` 为真、不超过 `inlineMaxBytes`（默认 32 KiB）、累计不超过 `inlineTotalMaxBytes`（默认 96 KiB）、
  路径确实在 `.nexgent/materials/<id>/` 下、且副本大小与 SHA-256 与元数据一致时，全文附在列表后，用比内容中最长反引号串更长的围栏包住。
- 不内联时写明原因（binary / too large / budget / could not be read / no longer matches）和读法：`.docx` `.xlsx` `.pdf` 用 `read_document`，其他文本用 `read_file`。
- 已移除的资料写 “removed by the user; do not use it”；未知 id 写 “not found”；重复 id 只列一次。

## 压缩

- **触发**（`shouldCompact`）：本轮还没有失败过压缩；`lastUsage` 的计费输入（`input + cacheRead + cacheWrite`，任一为 `unknown` 不触发）≥ 阈值；且存在可行的切分。
- **切分**（`planCompaction`）：一串连续的 `user` 消息（本轮的注入 + 用户消息）开启一个“轮段”；开头的旧摘要单独算一段。
  保留最后 `keepRecentTurns` 段（默认 2；当前轮是最后一段，总是完整保留），保留段因此以 `user` 消息开头，工具调用与结果不会拆开。
  若这样没有可压的内容，就少保留几段，最少只保留当前轮；只剩当前轮、或可压的只有一条旧摘要时不压缩。
- **摘要请求**：一次 `ctx.llm.complete`，`purpose: 'auxiliary'`、带 `sessionId`（账本里有 `llm.request.start/end`，成功失败都有）；
  模型取 loop 给的 `model`，thinking / effort 取项目配置；不带工具。内容是一条固定的系统提示 + 一条用户消息：
  `<conversation>` 包住的被压部分纯文本转录（工具参数与结果各截到 8 000 字符，头尾保留）+ 固定摘要指令（`SUMMARY_INSTRUCTION`，测试里有内联快照）。
- **失败**：错误事件、被中止、`finishReason` 不是 `stop`（如 `max-tokens`）或摘要为空时 reject（`llm/*` 错误码）；loop 写非致命 `error`、保留原历史、本轮不再尝试。
- **thinking 块**：转录不含 `providerContent`，所以被压轮次的 thinking 块与签名不会发往任何请求；写入 `compaction` 后，投影丢掉被压的回复，保留段里的回复照常带 thinking 块回放。
- **恢复**：`applyCompaction(messages, summary, keepMessages)` 与会话投影的结果逐项相同；测试在压缩后用 SIGKILL 杀掉写入进程，新进程 `resume` 得到的历史与被杀前进程内存里的历史相等。

## 测试

`tests/`：说明文件（存在 / 不存在 / 回退 / 空白 / 超长截断）、资料（文本内联、超大文本与二进制只给路径、预算、移除、未知、内容被改、伪造路径不读、schema 不合法）、
压缩切分与触发、摘要请求的形状与失败、经真实 `@nexgent/llm` + 脚本化模型服务器的账本记录、强杀后恢复（子进程 `tests/fixtures/compact-then-hang.mjs`）、插件装载与提供者顺序。
