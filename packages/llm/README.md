# @nexgent/llm

Claude Platform 单路由：经官方 `@anthropic-ai/sdk` 调用 Anthropic Messages API（`POST /v1/messages`，流式），默认模型 `claude-sonnet-5-5`（ADR 0002）。实现 kernel 契约 `LLMProvider`（`packages/kernel/src/contracts/llm.ts`），并为每次请求写一对 `llm.request.start` / `llm.request.end`（`ledger.ts`、`docs/spec/data-formats.md` §账本记录）。

归属：计划步骤 1；分工与完成定义见 `docs/plan/step-1-work-partition.md`。

## 公共 API

| 导出 | 说明 |
| --- | --- |
| `AnthropicProvider` / `createProvider(options)` | 单路由 provider。`options.credentials`、`options.ledger` 必填；其余见下表 |
| `LLMPlugin`（默认导出）、`apply`、`validateLLMPluginConfig`、`providerOptionsFromConfig` | Cordis 插件：`inject: ['credentials', 'ledger']`，`ctx.provide('llm', provider)` |
| `buildMessageParams`、`toWireMessages`、`thinkingParam`、`mapStopReason`、`normalizeUsage` | 组包与映射的纯函数部件 |
| `redactSecrets`、`sanitizeUrl` | 密钥与 URL 脱敏 |
| `NEXGENT_API_BASE_URL`、`ANTHROPIC_API_KEY`、`CLAUDE_API_HOST`、`FALLBACK_BETA` | 常量 |
| `schema/ledger.v1.schema.json` | 账本记录 JSON Schema（draft 2020-12，按 `type` 的 `oneOf`，允许未知可选字段；`finishReason` 含 `refusal`） |

### 插件 config（profile `llm` 行）

```yaml
- id: llm
  name: '@nexgent/llm'
  config:
    provider: anthropic
    endpoint: https://api.anthropic.com
    model: claude-sonnet-5-5
    apiKeyCredential: NEXGENT_API_KEY
    thinking: 'off'
    effort: medium
    maxTokens: 16000
    timeoutMs: 180000
    streamIdleTimeoutMs: 180000
    maxRetries: 0
    fallbacks: default
```

未知键报错（旧的 `compat.*`、`contextWindow`、`displayName`、`thinkingParams` 等不再接受）。`thinking` 只做校验：每个请求自带 `thinking`。映射见 `providerOptionsFromConfig`。

### 选项（`AnthropicProviderOptions`）

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `id`（插件：`provider`） | `anthropic` | 路由键，写入账本 `provider` |
| `endpoint` | `https://api.anthropic.com` | SDK `baseURL`（不含路径）；环境变量 `NEXGENT_API_BASE_URL` 优先于它（验收脚本用它指向假服务） |
| `defaultModel`（插件：`model`） | `claude-sonnet-5-5` | 请求 `model` 为空串时使用；模型 ID 不带日期后缀 |
| `apiKeyName`（插件：`apiKeyCredential`） | `NEXGENT_API_KEY` | 经 `Credentials.get` 每次请求读取，不缓存；未设置时回退到环境变量 `ANTHROPIC_API_KEY` |
| `effort` | `medium` | 请求未带 `effort` 时的 `output_config.effort` |
| `maxTokens` | `16000` | 请求未带 `maxTokens` 时的 `max_tokens` |
| `timeoutMs` / `streamIdleTimeoutMs` | 180000 / 180000 | 每次调用的 `LLMCompleteOptions` 可覆盖；`timeoutMs` 同时作为 SDK 的单请求 `timeout` |
| `maxRetries` | `0` | 只接受 0；SDK 也以 `maxRetries: 0` 构造 |
| `fallbacks` | `'default'` | 服务端拒答回退；见下 |
| `env` | `process.env` | 读 `NEXGENT_API_BASE_URL` 与 `ANTHROPIC_API_KEY` |
| `attribution` | 无 | 步骤 4 归因字段；每次调用的 `CompleteOptions`（契约选项 + `LedgerAttribution`）可覆盖 |
| `fetch` | 全局 `fetch` | 替换 SDK 的 `fetch`（自定义代理、测试） |

## 请求形状

每次 `complete()` 发送（`stream: true` 由 SDK 加上）：

```json
{
  "model": "claude-sonnet-5-5",
  "max_tokens": 16000,
  "system": "<system 消息文本>",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": [{ "type": "thinking", "thinking": "...", "signature": "..." }, { "type": "text", "text": "..." }, { "type": "tool_use", "id": "toolu_1", "name": "read_file", "input": { "path": "a" } }] },
    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "...", "is_error": true }] }
  ],
  "tools": [{ "name": "read_file", "description": "...", "input_schema": { "type": "object" }, "eager_input_streaming": true }],
  "thinking": { "type": "between_tools" },
  "output_config": { "effort": "medium" },
  "cache_control": { "type": "ephemeral" }
}
```

- **消息**：`system` → 顶层 `system`；`user` → 文本；`assistant` 带 `providerContent` 时原样发送该数组（保留 thinking：含 `signature` 的 `thinking` 块、`text`、`tool_use` 一字不改），否则由 `content` / `toolCalls` 组成 `[text?, tool_use*]`（`arguments` 解析为 `input`，解析失败发 `{}`）；连续的 `tool` 消息合并为**一条** `user` 消息的 `tool_result` 块（API 要求同一轮的每个 `tool_use` 在下一条 user 消息里一并回答）。顺序只追加不重排。
- **thinking / effort**：`thinking: 'off'` → `{ type: 'between_tools' }`（Sonnet 5.5 的最低设置；只在 effort ≤ `high` 时有效，`xhigh` / `max` 时省略 `thinking`，即自适应）；`thinking: 'on'` → `{ type: 'adaptive', display: 'summarized' }`。从不发送 `disabled` 或 `budget_tokens`。`effort` 取请求的 `effort`，否则插件默认 `medium`。
- **不发送**：`temperature` / `top_p`（该模型拒绝非默认值；忽略 `request.temperature`）、强制 `tool_choice`。
- **缓存**：顶层 `cache_control: { type: 'ephemeral' }`，自动缓存最后一个可缓存块。
- **回退**：`fallbacks: 'default'` 时，且端点主机是 `api.anthropic.com`，走 `client.beta.messages.stream`，带 `betas: ['server-side-fallback-2026-07-01']`、`fallbacks: 'default'`；端点是假服务或代理时自动不发（这些主机不认识该参数）。`fallbacks: 'off'` 关闭。

## 事件映射

| 线上事件 | 契约事件 |
| --- | --- |
| `content_block_delta` / `text_delta` | `text.delta` |
| `content_block_delta` / `thinking_delta`（`between_tools` 为简短进度说明；自适应为摘要或空文本，空文本不发） | `reasoning.delta` |
| `content_block_start` / `tool_use` | `tool-call.start { index, id, name }`（`index` 为本回复内 tool_use 块的 0 基计数，不是内容块下标；`id` = `tool_use.id`） |
| `content_block_delta` / `input_json_delta` | `tool-call.delta { index, argumentsDelta: partial_json }` |
| `content_block_stop`（tool_use 块） | `tool-call.end { index, call }`；`arguments` = 拼接的原始 `partial_json`（未收到任何片段时为 `{}`），由 kernel 校验解析 |
| `message_start.usage` + `message_delta.usage` | `usage`（合并；见下） |
| `message_delta.stop_reason` | `done{finishReason}`：`end_turn`→`stop`，`tool_use`→`tool-calls`，`max_tokens` / `model_context_window_exceeded`→`max-tokens`，`refusal`→`refusal` 并附 `refusal: { category?, explanation? }`（取 `stop_details`；kernel 不执行该回复的工具调用），`stop_sequence`→`stop`，`pause_turn`→`stop`（当作结束，不自动续跑） |
| 最终 `message.content` | `done.providerContent`（整个内容块数组的 JSON，供下一次请求原样回放） |
| `signature_delta`、`ping` | 忽略（签名进入 `providerContent`） |

- **用量**：`input_tokens`→`inputTokens`（API 的计数已不含缓存命中）、`output_tokens`→`outputTokens`、`cache_read_input_tokens`→`cacheReadTokens`、`cache_creation_input_tokens` 忽略（契约无字段）、`reasoningTokens` 恒为 `'unknown'`；`totalTokens` = 三者之和（任一未知则 `'unknown'`）。未报字段一律 `'unknown'`，不写 0；全部未知时不发 `usage` 事件，账本记 `UNKNOWN_USAGE`。
- **失败与错误码**：HTTP 非 2xx → `llm/request-failed` + `httpStatus`（`APIError.status`）+ `providerRequestId`（`request-id` 头）；连接被拒 / 断网 / 中途断流 → `llm/request-failed`（`details.cause` 为 errno 码）；整体超时（自有 deadline 或 SDK `APIConnectionTimeoutError`）/ 流空闲超时 → `llm/timeout`（`details.timeout: 'request' | 'idle'`）；坏事件 / 工具输入 JSON 无法解析（SDK 解析抛出的非 API 错误）→ `llm/invalid-response`；流在 `message_delta` 前结束 → `llm/request-failed`；缺密钥 → `credentials/missing`（不发请求）；调用方中止 / 提前 `break` → `done{finishReason: 'aborted'}`（开始前与流中皆然，不发 `error`）。
- **账本**：任何结局都恰好一对 start / end；`error` / `aborted` 的用量全为 `'unknown'`；`errorCode` 只写码不写消息；`endpoint` 去掉凭证、query、fragment；`refusal` 记为 `status: 'ok'`、`finishReason: 'refusal'`。`Ledger.append` 失败被吞掉（由 ledger 自己计 `writeFailures`），不改变请求结果。契约无"实际服务模型"字段，故回退后的 `message.model` 不入账本。
- **脱敏**：密钥只交给 SDK（`x-api-key` 头），每次请求重新从 `Credentials` 读取、不留在 provider 状态；错误消息与 details 经 `redactSecrets`（去掉密钥原文、`Bearer …`、`x-api-key: …`、`sk-…`）。
- **代理**：本包不再内置隧道。设置 `HTTPS_PROXY` / `NO_PROXY` 后以 `NODE_USE_ENV_PROXY=1` 启动 Node（22.x 自带 `fetch` 即走代理），或通过 `createProvider({ fetch })` 传入自定义 `fetch`（例如 undici 的 `EnvHttpProxyAgent` dispatcher）。

## 与 DSH 参考的对应

| DSH 包 | 本包 |
| --- | --- |
| `llm/llm`（流式事件思路） | `src/provider.ts`（按 Nexgent 契约重写，SDK 流事件 → 契约事件） |
| `llm/llm-pi-ai` | 不再对应（OpenAI 兼容路由已删除） |
| `llm/token-meter`（usage 归一、unknown 语义） | `src/usage.ts`（重写） |
| `util/http-proxy` | **已删除**（`src/proxy/policy.ts` 的改写件随之移除；`THIRD_PARTY_NOTICES.md` 与 `docs/reference-map.md` 需同步去掉该行） |
| PR #4 `execution-ledger.ts` 的请求记录部分 | `src/provider.ts` 的 start / end 写入（改为契约 `Ledger`） |

不采用：`llm-retry`、`llm-deepseek`。

## 测试

`pnpm exec vitest run --project @nexgent/llm`。测试对本包内的 node:http 假服务（`tests/helpers/fake-anthropic.ts`，`POST /v1/messages`）回放 `tests/fixtures/*.sse`（Anthropic 事件格式）；覆盖流式文本、thinking 块 → `reasoning.delta` 与 `providerContent` 往返（回放的 assistant 轮含原 `signature`）、单工具调用、并行工具调用、tool 结果合并为一条 user 消息、有 / 无 usage（含 cache_read）、400 / 429 / 529（一对账本、用量 unknown、不重试）、连接被拒、整体超时与空闲超时、开始前 / 流中中止与提前 `break`、坏事件 → `llm/invalid-response`、拒答 → `done{refusal}`、thinking / effort 映射（`between_tools`、`xhigh` 省略、adaptive）、`output_config.effort`、`eager_input_streaming`、`cache_control`、回退参数只对真实主机发送、密钥脱敏与 `NEXGENT_API_BASE_URL` 覆盖、Cordis 插件装载，以及账本记录对 `schema/ledger.v1.schema.json` 和 spec 示例行的校验。

`recordSse(baseUrl, key, body, file)`（`tests/helpers/fake-anthropic.ts`）可把一次真实流式响应录成新 fixture（只写响应，不写请求和密钥）；测试套件本身从不访问真实端点。

## 真实模型手动检查（由集成方执行）

1. 准备密钥：`export NEXGENT_API_KEY=sk-ant-...`（Windows：`$env:NEXGENT_API_KEY = 'sk-ant-...'`），或写入 `~/.nexgent/credentials.json`；也接受 `ANTHROPIC_API_KEY`。需要代理时设置 `HTTPS_PROXY` 并加 `NODE_USE_ENV_PROXY=1`。不要把密钥写进命令历史以外的任何文件或日志。
2. `pnpm exec tsc -b packages/llm`，然后：

   ```sh
   node packages/llm/scripts/smoke.mjs                 # thinking off, effort medium
   node packages/llm/scripts/smoke.mjs --thinking on   # 自适应 thinking，应看到 reasoning.delta
   ```

   脚本发一次带 `write_file` 工具的请求，打印事件、用量与账本对，最后打印 `PASS` / `FAIL`（退出码 0 / 1）。
3. 通过标准：恰有一个 `tool-call.end`，其 `arguments` 能 `JSON.parse`；终止事件是 `done`、`finishReason: 'tool-calls'`，`providerContent` 含 `tool_use` 块；账本为一对 start / end，end 的 `status: 'ok'`、`httpStatus: 200`，`usage` 的 `inputTokens` / `outputTokens` 为数字；thinking 关闭时 `reasoning.delta` 为空或只有简短进度说明；输出里搜不到密钥。
4. 若返回 400 且提到 `thinking` / `output_config`，把完整错误消息记进验收记录（映射见本文"请求形状"）。
5. 可选：用 `recordSse` 录下这次响应作为新 fixture，提交前检查其中没有密钥。

## 尚未完成

- 真实 Claude Sonnet 5.5 调用由集成方按上节执行并记入 `docs/validation/`。
- `pause_turn` 当作 `stop`，不自动续跑；服务端回退后实际服务的模型不入账本（契约无字段）。
- 图片 / 文件输入、结构化输出、服务端工具不在步骤 1 范围。
