# @nexgent/llm

MiMo 单路由：OpenAI 兼容流式请求、工具调用解析、用量计量与请求账本。实现 kernel 契约 `LLMProvider`（`packages/kernel/src/contracts/llm.ts`），并为每次请求写一对 `llm.request.start` / `llm.request.end`（`ledger.ts`、`docs/spec/data-formats.md` §账本记录）。

归属：计划步骤 1；分工与完成定义见 `docs/plan/step-1-work-partition.md`。

## 公共 API

| 导出 | 说明 |
| --- | --- |
| `OpenAICompatibleProvider` / `createProvider(options)` | 单路由 provider。`options.credentials`、`options.ledger` 必填；其余见下表 |
| `LLMPlugin`（默认导出）、`apply`、`validateLLMPluginConfig` | Cordis 插件：`inject: ['credentials', 'ledger']`，`ctx.provide('llm', provider)` |
| `normalizeUsage`、`ChunkAssembler`、`mapFinishReason`、`readSseData`、`buildRequestBody` | 解析与组包的纯函数部件 |
| `resolveProxyPolicy`、`proxyForUrl`、`createTransport`、`createProxyTransport` | 代理策略与传输层接缝 |
| `redactSecrets`、`sanitizeUrl` | 密钥与 URL 脱敏 |
| `schema/ledger.v1.schema.json` | 账本记录 JSON Schema（draft 2020-12，按 `type` 的 `oneOf`，允许未知可选字段） |

### 选项（`OpenAICompatibleProviderOptions`）

插件 config 接受 kernel 默认 profile（`packages/kernel/profiles/nexgent.yml`）里 `llm` 行的形状：`provider`（= `id`）、`apiKeyCredential`（= `apiKeyName`）、`model`、`maxTokens`、`compat.thinkingFormat`（`deepseek` / `zai` → `thinking: { type }`，`qwen` → `enable_thinking`，`none` → 不发）、`compat.maxTokensField`；`displayName`、`thinking`、`contextWindow` 与 `compat.supports*` 只做校验不改行为。未知键报错。映射见 `providerOptionsFromConfig`。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `id` | `mimo` | 路由键，写入账本 `provider` |
| `endpoint` | `DEFAULT_PROJECT_CONFIG.endpoint` | 环境变量 `NEXGENT_API_BASE_URL` 优先于它 |
| `defaultModel`（插件：`model`） | `mimo-v2.6-pro` | 请求 `model` 为空串时使用 |
| `apiKeyName` | `NEXGENT_API_KEY` | 经 `Credentials.get` 每次请求读取，不缓存 |
| `timeoutMs` / `streamIdleTimeoutMs` | 180000 / 180000 | 每次调用的 `LLMCompleteOptions` 可覆盖 |
| `maxRetries` | `0` | 只接受 0；provider 内部从不重试 |
| `thinkingParams` | `{ off: { thinking: { type: 'disabled' } }, on: { thinking: { type: 'enabled' } } }` | 按 `request.thinking` 合并进请求体；别的路由可改成 `{ enable_thinking: false }` 等 |
| `maxTokensField` | `max_tokens` | 或 `max_completion_tokens` |
| `defaultMaxTokens`（插件：`maxTokens`） | 无 | 请求未设 `maxTokens` 时使用的输出上限 |
| `toolMessageName` | `false` | `tool` 消息是否带 `name` |
| `proxy` | `'env'` | `'env'`、`'none'` 或显式 `ProxyPolicy` |
| `attribution` | 无 | 步骤 4 归因字段；每次调用的 `CompleteOptions`（契约选项 + `LedgerAttribution`）可覆盖 |
| `transport` | 内置 | 替换 HTTP 发送（测试或自定义） |

## 行为

- **请求**：`POST {endpoint}/chat/completions`，`stream: true`、`stream_options.include_usage: true`，`Authorization: Bearer <key>`。`complete()` 是惰性的、只能迭代一次：开始迭代时才写 start 记录并发请求；`break` 会中止请求。
- **事件**：`text.delta`、`reasoning.delta`（`reasoning_content` / `reasoning`）、`tool-call.start/delta/end`（按 wire `index` 区分并行调用，参数跨 chunk 拼接；`id` 与 `name` 都到齐才发 start，之前的参数先缓冲）、`usage`（至多一次，在终止事件前）、`done{finishReason}` 或 `error{error, httpStatus?, providerRequestId?}`。请求级失败只产出 `error` 事件，不抛出。
- **finish_reason 映射**：`stop`→`stop`，`tool_calls`/`function_call`→`tool-calls`，`length`→`max-tokens`，`content_filter` 与未知值→`stop`；有工具调用而上游报 `stop` 时记为 `tool-calls`。
- **用量**：`inputTokens = prompt_tokens − cached`（cached 取 `prompt_tokens_details.cached_tokens` 或 `prompt_cache_hit_tokens`）；路由完全不报缓存拆分时 `cacheReadTokens: 'unknown'`、`inputTokens = prompt_tokens`。`reasoningTokens` 取 `completion_tokens_details.reasoning_tokens`。未报字段一律 `'unknown'`，不写 0；没有 usage 时不发 `usage` 事件，账本记 `UNKNOWN_USAGE`。
- **失败与错误码**：HTTP 非 2xx → `llm/request-failed` + `httpStatus`；断网 / 连接被拒 / 中途断流 → `llm/request-failed`（`details.cause` 为 errno 码，无 `httpStatus`）；整体超时或流空闲超时 → `llm/timeout`（`details.timeout: 'request' | 'idle'`）；坏 chunk → `llm/invalid-response`；缺密钥 → `credentials/missing`（不发请求）；调用方中止 / 提前 `break` → `done{finishReason: 'aborted'}`。
- **账本**：任何结局都恰好一对 start / end；`error` / `aborted` 的用量全为 `'unknown'`；`errorCode` 只写码不写消息；`endpoint` 去掉凭证、query、fragment。`Ledger.append` 失败被吞掉（由 ledger 自己计 `writeFailures`），不改变请求结果。
- **脱敏**：密钥只进 `Authorization` 头；错误消息与 details 经 `redactSecrets`（去掉密钥原文、`Bearer …`、`sk-…`）；代理 URL 中的用户名密码不进消息。
- **代理**：`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`（大小写皆可，小写优先），环回地址永远直连，SOCKS 被拒并给出诊断。直连走全局 `fetch`；需要代理时走内置 node:http 隧道（`http:` 目标用绝对 URI，`https:` 目标用 `CONNECT` + TLS，支持 `user:pass@` 的 Basic 代理认证），无需 `undici` 依赖。进程以 `NODE_USE_ENV_PROXY=1` 启动时由 Node 自带 `fetch` 处理代理，内置隧道让路。

## 与 DSH 参考的对应

| DSH 包 | 本包 |
| --- | --- |
| `util/http-proxy`（`src/policy.ts`） | `src/proxy/policy.ts`（改写，带出处头）；`install.ts` 的 undici dispatcher 换成 `src/proxy/transport.ts` 的内置隧道 |
| `llm/llm`（流式事件、assembler 思路） | `src/assembler.ts`、`src/provider.ts`（按 Nexgent 契约重写） |
| `llm/llm-pi-ai`（OpenAI completions 路由、compat 选项如 `thinkingFormat`、`maxTokensField`） | `src/wire.ts`、`src/provider.ts`（单路由重写，无 catalog / discovery） |
| `llm/token-meter`（usage 归一、unknown 语义） | `src/usage.ts`（重写） |
| PR #4 `execution-ledger.ts` 的请求记录部分 | `src/provider.ts` 的 start / end 写入（改为契约 `Ledger`） |

不采用：`llm-retry`、`llm-deepseek`。

## 测试

`pnpm exec vitest run --project @nexgent/llm`。测试对本包内的 node:http SSE 假服务（`tests/helpers/fake-openai.ts`）回放 `tests/fixtures/*.sse` 录制片段；覆盖流式文本、单工具调用、并行工具调用、有 / 无 usage、4xx / 5xx、连接被拒、超时（整体与空闲）、中途中止与提前 `break`、坏 chunk、断流丢弃未完成工具调用、缺密钥、账本写失败、密钥脱敏、代理（绝对 URI、CONNECT+TLS、CONNECT 被拒、NO_PROXY）、Cordis 插件装载，以及账本记录对 `schema/ledger.v1.schema.json` 和 spec 示例行的校验。`tests/fixtures/tls/` 是仅供测试的自签证书（`fake-upstream.test`）。

`recordSse(url, key, body, file)`（`tests/helpers/fake-openai.ts`）可把一次真实流式响应录成新 fixture（只写响应，不写请求和密钥）；测试套件本身从不访问真实端点。

## 真实 MiMo 手动检查（由集成方执行）

1. 准备密钥：`export NEXGENT_API_KEY=...`（Windows：`$env:NEXGENT_API_KEY = '...'`），或写入 `~/.nexgent/credentials.json`。需要代理时设置 `HTTPS_PROXY`。不要把密钥写进命令历史以外的任何文件或日志。
2. `pnpm exec tsc -b packages/llm`，然后在仓库根目录用一个临时脚本（不提交）运行：

   ```js
   import { createProvider } from './packages/llm/dist/index.js'
   const records = []
   const ledger = { writeFailures: 0, async append(r) { const x = { ...r, ts: new Date().toISOString() }; records.push(x); return x }, async *read() {} }
   const credentials = { async get(n) { return process.env[n] }, async describe() { return { configured: true } } }
   const llm = createProvider({ credentials, ledger })
   const events = []
   for await (const e of llm.complete({
     requestId: crypto.randomUUID(), model: 'mimo-v2.6-pro', thinking: 'off',
     messages: [{ role: 'system', content: 'Use the tool.' }, { role: 'user', content: 'Write "hi" to notes.md.' }],
     tools: [{ name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }],
   })) events.push(e)
   console.log(JSON.stringify({ events, records }, null, 2))
   ```

3. 通过标准：恰有一个 `tool-call.end`，其 `arguments` 能 `JSON.parse`；终止事件是 `done`、`finishReason: 'tool-calls'`；`records` 为一对 start / end，end 的 `status: 'ok'`、`httpStatus: 200`，`usage` 的 `inputTokens` / `outputTokens` 为数字；输出中没有 `reasoning.delta`（thinking 关闭生效）；输出里搜不到密钥。
4. 若返回 400 且提到 `thinking` 参数，说明该路由关闭推理的字段不同：用 `thinkingParams` 调整（例如 `{ off: { enable_thinking: false }, on: { enable_thinking: true } }`）后重试，并把结论写进验收记录。
5. 可选：用 `recordSse` 录下这次响应作为新 fixture，提交前检查其中没有密钥。

## 尚未完成

- 真实 MiMo 调用由集成方按上节执行；MiMo 关闭 thinking 的确切字段（默认 `thinking: { type: 'disabled' }`，对应 PR #4 的 `thinkingFormat: deepseek`）需在那次运行中确认。
- 代理隧道不支持 SOCKS 与 PAC；`NO_PROXY` 不支持 CIDR。
- 本包的假服务待 `@nexgent/test-support` 的共享假服务就绪后可迁移过去。
