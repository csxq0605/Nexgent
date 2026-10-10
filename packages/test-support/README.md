# @nexgent/test-support

Test helpers shared by the Nexgent packages and the step acceptance scripts:

- `scriptedProvider` — an in-process `LLMProvider` (kernel contract `packages/kernel/src/contracts/llm.ts`) that replays a script as contract stream events and records every request;
- `scriptedModelServer` — a loopback HTTP server speaking the Anthropic Messages API (`POST /v1/messages`, SSE and plain JSON), driven by the same script format, with wire-level faults;
- fault injection — file truncation (`kill -9` mid-write), process-tree kill, deadlines, an unreachable endpoint (network down);
- the cross-process acceptance harness — `spawnNode`, output / file waits, session and ledger readers, and the acceptance summary builder + schema + validator.

Runtime dependencies: `@nexgent/kernel` (contract types and a few constants) and Node built-ins.

Entry points:

| Import | Contents |
| --- | --- |
| `@nexgent/test-support` | everything |
| `@nexgent/test-support/acceptance` | the harness, records, summary and fault helpers only (no model fakes); intended for `scripts/accept-step1.mjs` |

Both are ESM and need the package built (`tsc -b packages/test-support`) before plain `.mjs` scripts import them.

## 仿真规范（simulation spec）

This section is normative for both fakes. One **script** is an array of entries; each model request consumes the next entry, in order. An entry is a `ScriptedTurn` or a function `(request, index) => ScriptedTurn` (`request` is the `LLMRequest` for the provider and the parsed JSON body for the server; `index` is 0-based).

### Script format

```ts
interface ScriptedTurn {
  content?: string | string[]          // visible text; a string is one chunk, an array gives the chunks
  reasoning?: string                   // one reasoning chunk, before content
  toolCalls?: ScriptedToolCall[]       // after the text, in order
  interleaveToolCalls?: boolean        // server only: round-robin argument chunks across calls
  usage?: Partial<LLMUsage-as-numbers> // omitted → no usage reported (see "unknown usage")
  finishReason?: 'stop' | 'tool-calls' | 'max-tokens' | 'refusal' // default: tool-calls if toolCalls, else stop
  stopDetails?: { category?: string; explanation?: string }       // with finishReason 'refusal'
  chunkDelayMs?: number                // delay before each chunk
  fault?: ScriptedFault | 'timeout' | 'disconnect' | 'http-500' | 'malformed-json'
}
```

Example:

```ts
const provider = scriptedProvider([
  { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'hi' } }], usage: { inputTokens: 812, outputTokens: 37 } },
  { content: '已改好。' },                       // no usage → unknown
  { fault: { kind: 'http-error', status: 503 } },
])
```

An exhausted script is a test bug: the provider yields an `error` event with code `internal`; the server answers HTTP 500 (`error.type: script_exhausted`). `assertConsumed()` on either throws if entries remain.

### Tool-call representation

```ts
interface ScriptedToolCall {
  id?: string             // default `call_<request#>_<index>` (request# 1-based, index 0-based)
  name: string
  arguments?: unknown     // string → sent verbatim as raw JSON text (may be invalid on purpose); other → JSON.stringify; absent → '{}'
  argumentChunks?: number // split the raw text into this many chunks (default 2)
}
```

- **Provider events** (per call, sequentially): `tool-call.start { index, id, name }` → `tool-call.delta { index, argumentsDelta }` × chunks → `tool-call.end { index, call: { id, name, arguments } }`, where `arguments` is the concatenated raw text. Event order of a whole turn: `reasoning.delta` → `text.delta`* → tool calls → `usage`? → `done` (`done` carries `refusal: stopDetails` when `finishReason` is `refusal`).
- **Server wire** (Messages API streaming, `event: <type>\ndata: <json>\n\n` per event): `message_start` (with `message.usage` = input / cache counts), then per content block `content_block_start` / `content_block_delta`* / `content_block_stop`, then `message_delta` (`delta.stop_reason`, `delta.stop_details` on refusal, `usage.output_tokens`) and `message_stop`. Block order: `thinking` (one `thinking_delta` with the reasoning text, then a `signature_delta`), `text` (one `text_delta` per content chunk), then one `tool_use` block per call (`content_block` = `{ type: 'tool_use', id, name, input: {} }`, each argument chunk an `input_json_delta { partial_json }`). Several calls in one turn are "parallel" tool calls; with `interleaveToolCalls` all tool blocks start first and argument fragments alternate by block index (unlike the real API, which closes one block before opening the next). `stop_reason`: `end_turn` / `tool_use` / `max_tokens` / `refusal`.

### Unknown usage representation

- Turn has **no `usage`**: the provider emits **no** `usage` event (contract invariant 2: the consumer then records `UNKNOWN_USAGE`); the server sends **no** usage chunk / field.
- Turn has a **partial `usage`**: the provider emits one `usage` event where every missing field is the string `'unknown'` (never 0); the server sends only the wire fields it can derive.
- Wire mapping (contract → Messages API): `message_start.message.usage.input_tokens = inputTokens`, `…cache_read_input_tokens = cacheReadTokens`, `message_delta.usage.output_tokens = outputTokens`; `totalTokens` and `reasoningTokens` have no wire field. Both usage objects are `{}` when the turn has no `usage` (the client then sees every count as unknown).

### Faults

| Fault | `scriptedProvider` | `scriptedModelServer` |
| --- | --- | --- |
| `{ kind: 'timeout', afterChunks = 0 }` | emits `afterChunks` body events, then hangs until `request.signal` aborts (→ `done/aborted`) or `min(options.timeoutMs, options.streamIdleTimeoutMs)` elapses (→ `error` `llm/timeout`); with neither it hangs forever | `afterChunks = 0`: never sends anything (not even headers); otherwise sends headers + chunks and stalls the open stream |
| `{ kind: 'disconnect', afterChunks = 1 }` | emits `afterChunks` body events, then `error` `llm/request-failed` | sends `afterChunks` SSE events then destroys the socket; `0` resets before any response |
| `{ kind: 'http-error', status, message?, headers? }` / `'http-500'` | `error` `llm/request-failed` with `httpStatus` | responds `status` with `{ type: 'error', error: { type: 'scripted_error', message } }` and the extra headers |
| `{ kind: 'malformed-json', afterChunks = 0 }` | `error` `llm/invalid-response` (after `afterChunks` events) | `afterChunks` good events, then a `content_block_delta` whose `data:` does not parse, then ends without `message_stop` |

"Body events" / "SSE events" count everything before the terminal event (reasoning, text, tool-call start / delta / end for the provider; every `data:` line for the server). Network down: point the client at `await closedPortUrl()` (connection refused).

### Abort and other contract behaviour (provider)

- Lazy and single-use: the request is recorded and the entry consumed when iteration starts; iterating the same stream twice throws.
- `request.signal` is checked before every event and during delays / hangs; abort ends the stream with `done { finishReason: 'aborted' }`; events already yielded stay valid. An already-aborted signal yields only `done/aborted`.
- Exactly one terminal event; request-level failures are `error` events, never throws.

## Public API

### Model fakes

```ts
scriptedProvider(script?: ScriptEntry<LLMRequest>[], options?: { info?: Partial<LLMProviderInfo>; chunkDelayMs?: number }): ScriptedProvider
// ScriptedProvider extends LLMProvider:
//   calls: { index, request, options, events }[]; requests: LLMRequest[]; remaining: number
//   push(...entries); assertConsumed()

scriptedModelServer(options?: { script?: ScriptEntry<MessagesRequestBody>[]; port?: number; host?: string; chunkDelayMs?: number }): Promise<ScriptedModelServer>
// ScriptedModelServer: baseUrl ('http://127.0.0.1:<port>', the bare origin for the SDK baseURL / NEXGENT_API_BASE_URL),
//   port, requests: RecordedModelRequest[], remaining, push(...), waitForRequests(count, timeoutMs?), assertConsumed(), close()
// RecordedModelRequest: { index, method, path ('/v1/messages', query stripped), headers (x-api-key → '[redacted]',
//   authorization → '<scheme> [redacted]'), hasApiKey, body (parsed JSON | undefined), rawBody, chunksSent, outcome }
// MessagesRequestBody: { model?, max_tokens?, system?, messages?, tools?, thinking?, output_config?, stream?, ... }
```

Only `POST /v1/messages` (any query string, e.g. `?beta=true`) consumes the script; other paths get 404. `"stream": true` → SSE; otherwise one `message` JSON body (`content` blocks, `stop_reason`, `stop_details`, `usage`). The `anthropic-version` and `x-api-key` headers are recorded (key redacted) but not required.

### Fault injection

```ts
truncateFile(path, { atByte } | { dropLastBytes }): Promise<{ originalSize, newSize }>
appendPartialLine(path, text): Promise<void>       // unterminated tail line
killProcessTree(pid, signal = 'SIGKILL'): Promise<void> // win32: taskkill /PID /T /F; POSIX: ps-walk, children first
descendantPids(pid): Promise<number[]>; isProcessAlive(pid): boolean
withTimeout(promise, ms, label?): Promise<T>        // rejects with TimeoutError
deadline(ms): { signal, remainingMs(), expired(), race(promise, label?), clear() }
waitFor(predicate, { timeoutMs?, intervalMs?, label? }): Promise<T>
closedPortUrl(path = '/v1'): Promise<string>       // network down (pass '' for a bare origin)
```

### Cross-process harness

```ts
spawnNode(args, { cwd?, env?, cleanEnv?, stdin?, nodeArgs? }): NodeProcessHandle
// handle: pid, child, stdout, stderr, exited, exit: Promise<{ code, signal, stdout, stderr, durationMs }>
//   waitForOutput(RegExp | (text) => boolean, timeoutMs = 10000, stream = 'both'): Promise<{ text, match }>
//   waitForFile(path, timeoutMs = 10000, predicate?): Promise<string>
//   kill(signal = 'SIGKILL', { tree = true }): Promise<ProcessExit>
killAllSpawned(): Promise<void>                    // afterEach cleanup
waitForFile(path, { timeoutMs?, intervalMs?, predicate?, signal? }): Promise<string>

readSessionRecords(projectRoot, sessionId): Promise<JsonlReadResult<SessionRecord>>
readLedgerRecords(projectRoot, { month? }): Promise<{ records: LedgerRecord[]; files: JsonlReadResult<LedgerRecord>[] }>
readJsonlFile(path): Promise<JsonlReadResult>; listSessionIds(projectRoot); sessionFilePath(projectRoot, sessionId)
ledgerStats(records): LedgerStats                  // start/end paired by requestId; unpaired = unknown
// JsonlReadResult: { path, exists, records, truncation?: { line, byteOffset, reason, ignoredLines } }
```

The readers follow the layout of `docs/spec/data-formats.md` (`.nexgent/sessions/<id>/session.jsonl`, `.nexgent/ledgers/<yyyy-mm>/requests.jsonl`) and stop at the first unterminated or unparseable line, reporting it — they do not re-run the session store's schema / `seq` validation.

### Acceptance summary

```ts
const summary = acceptanceSummary({ step: 1, name: '…', exitCriteria: [...], script: 'scripts/accept-step1.mjs', simulated: '…' })
await summary.run('run writes the file', async () => { … })   // timed check; throw = failed check (rethrown)
summary.check('resume continues', true).fault('kill').fault('truncate').ledger(records, ledger.writeFailures)
summary.proves('…').doesNotProve('…').untested('…').knownIssue('…').set({ realModel: {…}, raw: {…} })
await summary.write('docs/validation/step-1/linux.json')       // validates, then writes
validateAcceptanceSummary(json): { valid, errors }              // ACCEPTANCE_SUMMARY_SCHEMA (JSON Schema 2020-12)
```

The summary's sections mirror `docs/validation/TEMPLATE.md`: `step` (步骤), `date` (日期), `source` (分支与提交), `environment` (环境, this platform), `scripted` (脚本化 provider 结果), `realModel` (真实模型结果), `checks`, `ledger` (incl. `writeFailures`), `failures` (失败与缺测), `conclusion` (结论边界), `raw` (原始记录位置与 manifest). "None" is `[]` / `null`; "don't know" is `'unknown'`. `result` is `pass` iff there is at least one check and all passed; the validator enforces that. Branch / commit / CI run URL come from GitHub Actions env vars, else `git`, else `'unknown'`.

## Mapping to deepseek-harness (design reference only, rewritten)

| Nexgent | DSH (`reference/deepseek-harness`, 46a7f68b) |
| --- | --- |
| `src/provider.ts` | `packages/test-support/agent-loop-testkit`, `packages/test-support/llm-replay` (scripted turns, recorded requests) |
| `src/server.ts` | `packages/test-support/llm-mock-server` (request-scoped behaviours, captured requests, chunk counting); rewritten for the Anthropic Messages API SSE wire |
| `src/process.ts` | `packages/test-support/session-snapshot/src/launcher.ts` (spawn / wait / kill idea) |

No file is a substantial adaptation, so none carries an `Adapted from` header.

## Not done yet

- No record / replay of real provider traffic (DSH `llm-replay` cassettes); scripts are hand-written.
- The session reader does not validate record schemas or `seq` continuity (that is `@nexgent/session`'s job).
- POSIX tree kill walks `ps` output; a process that re-parents (double fork / daemonize) before the walk escapes it.
