# ADR 0021：长任务不中途断——请求重试、调用上限、输出截断与轮内压缩

- **状态**：已接受
- **日期**：2026-10-16
- **依据**：系统设计审查（资料库 `docs/handoff/system-design-audit.md`）P1–P4 与条目 A1、A3、A4、A6、B1、B2、B6、E10；用户 2026-10-16 “你自己看着按推荐和想法来，要综合”，授权按审查建议修。重试这一条的决定在 [ADR 0017](0017-audit-revised-rules.md) 第 2 条，本 ADR 写它的实现细节。
- **替代**：`agents.maxSteps` 默认 64 与“超出时报 `internal`”的行为；单次输出默认 16000 token；`data-formats.md` §压缩 中“保留段必须以 `user` 开始、保留的回复照常回放 thinking 块”。“`maxRetries: 0`”已由 ADR 0017 第 2 条取代。

## 背景

验收任务都很短，长任务从没测过。审查找出四处会让长任务中途断掉的地方：

1. 模型请求零重试：一次 429、529 或断网就结束整轮，用户只看到“请求失败”。
2. 每轮最多 64 次模型调用，超出时以 `internal` 错误硬停，不先收尾。
3. 单次输出上限 16000 token（thinking 也算在内）；被截断后整轮结束，不续写；被截断的工具调用还留在历史里，下一轮回放时可能缺 `tool_result`。
4. 压缩只按轮切，当前这一轮再长也不切；阈值固定 160k，与模型窗口无关；提示超长时没有“先压缩再重试”。

## 决策

1. **请求重试在 provider 里做，只在回复内容到来之前（ADR 0017 第 2 条的实现）。** `AnthropicProvider` 对可重试的失败重发同一请求：HTTP 408/409/429/500/502/503/504/529，provider 错误类型 `overloaded_error`、`rate_limit_error`、`api_error`、`timeout_error`，连接失败或断开（没有错误状态码），以及流空闲超时（`llm/timeout`，`timeout: 'idle'`）。loop 自己的空闲时限比 provider 的多等一点（至多 15 秒），好让 provider 先重试。整个请求的时限、400 类请求错误、鉴权错误、响应格式错误不重试。已经产出正文或工具调用（`text.delta`、`tool-call.*`）之后的失败不重试，只有 thinking 流过的可以。
   - 等待：服务端给了 `retry-after-ms` / `retry-after` 就用它，否则 1 秒 × 2^(n−1)，取上半区间的随机值；单次等待不超过 60 秒。默认最多重试 6 次（`llm.maxRetries`，0 关闭）。等待可被取消。
   - 每次尝试各写一对 `llm.request.start` / `llm.request.end`，`requestId` 相同，第 2 次起带 `attempt`（1 起，缺省为 1）。重做 C1 的契约注释原写“每次尝试有自己的 `requestId`”；用同一个 `requestId` 是为了让 `assistant.message.requestId` 直接对上账本里成功的那次尝试，读取方按 `requestId` 加 `attempt` 配对，本 ADR 以此为准。流里在重发前给一个 `retry` 事件（`attempt`、`delayMs`、`error`），loop 转成 `request.retry` 事件，CLI 显示“n 秒后重试”。最终仍失败的错误在 `details` 里带 `attempts` 与 `retryable`。
   - SDK 自己的重试仍关闭（`maxRetries: 0` 构造客户端），这样每次尝试都进账本。
2. **调用上限可配置，到了上限不是错误。** `agents.maxSteps` 默认改为 400；项目配置新增 `maxStepsPerTurn`（正整数，改它要审批），优先于 profile 行；成员预设的 `maxSteps` 仍优先。上限前的最后一次调用（上限 ≥ 4 时）附一条隐藏提示，让模型收尾、说明做完了什么、还剩什么。超过上限时这一轮以 `cancelled`、cause `step-limit` 结束，历史完整，用户再发一条消息就接着做。桌面显示“本轮模型调用次数到上限了，工作还没丢；发一句“继续”就接着做”。
3. **输出被截断时续写。** 单次输出默认改为 64000 token（Claude Sonnet 5.5 上限 128K 的一半）；请求整体时限随之放宽（llm 1200 秒，loop 1800 秒，含重试），流空闲时限仍 180 秒。回复因输出上限停下（`max-tokens`）时：
   - 只有文字：附一条隐藏提示“接着写，不要重复”，自动续一次；
   - 带工具调用：这些调用不执行，各写一条错误结果，说明被长度截断、请拆成更小的写入；provider 内容里有、但流里没收完的 `tool_use` 也补进调用列表，保证每个 `tool_use` 都有结果；然后附提示继续。
   - 连续截断超过 `agents.maxOutputContinuations`（默认 3）次才以 `max-tokens` 结束这一轮。
4. **压缩按审查建议修。**
   - 阈值不超过模型窗口的 75%（当前 Claude 模型 1M，较早或未知的模型按 200K 算）；默认仍是 160k，成本不变。
   - 触发看“下一次请求的估计输入”：上一次请求的计费输入 + 它的输出 + 之后新加的消息（工具结果、注入内容）的估计；重开会话时从会话记录里最近一条计费输入已知的回复的用量起算（投影成 `SessionMetadata.lastUsage`，压缩时清除）；压缩后还没有回复、或旧 checkpoint 没有这个字段时，按整段历史估计。
   - 保留段估计超过阈值的 30% 时，当前这一轮也切：保留从某个回复开始的最近几步（至少最后一步及其工具结果），前面的步骤进摘要；这一轮的请求（含注入的上下文）原文附在摘要末尾。保留段因此可以以 `assistant` 开始，但永远不以工具结果开始。
   - 请求因提示超过上下文窗口失败（400/413 且信息指向上下文长度，provider 标 `contextOverflow`）时，loop 强制压缩一次并重发；每轮一次。
   - 摘要请求的转写设总长度预算（40 万字符，先逐步收紧单条上限，再截中间）；摘要请求输出上限改为 32000，给 thinking 留出余量。
   - 保留下来的回复不再回放 `providerContent`（thinking 块）：它们绑定的是压缩前的历史，Claude Sonnet 5.5 的保留 thinking 校验会拒绝或丢弃它们。只发文字与工具调用。投影（`compactionTail`）与 loop 用同一函数。

## 后果

- **契约**：`LLMStreamEvent` 加 `RetryEvent`；账本两种请求记录的可选 `attempt`（重做 C1 已加）按上面的写法填；`TurnCancelCause` 加 `step-limit`；`ProjectConfig` 加可选 `maxStepsPerTurn`（在 `GUARDED_PROJECT_CONFIG_FIELDS` 里）；`compactionTail` 成为契约函数；`AgentEvent` 加 `request.retry`；`SessionMetadata` 加可选 `lastUsage`。JSON schema 与 `data-formats.md` 同步。
- **账本**：重试的每次尝试都算一次请求（`perProject.maxRequests` 照常计）；失败的尝试用量未知，不计 token。
- **费用**：输出上限提高只在模型确实写得长时多花；调用上限提高后，单轮最多花的钱变多，仍受 `costCaps` 约束（默认不设上限，见审查 P16，不在本 ADR 范围）。
- **不做**：压缩失败后改为“清空旧工具结果”的回退（审查 B6 的最后一条）——这是对前缀的改写，会让后面所有 thinking 块失效，留待服务端上下文编辑接入时再做；流中途断开且已有正文时的续传；按模型查询窗口的 Models API 调用（用静态表）。
