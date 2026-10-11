// Child of resume.spec.ts: writes two finished turns and the start of a third
// (replies carry thinking blocks), compacts the history with the real
// BasicCompactor (scripted model), appends the compaction record and one more
// reply, prints the in-memory history as the live loop would hold it, then
// waits to be killed.
import { BasicCompactor, applyCompaction } from '@nexgent/context'
import { JsonlSessionStore } from '@nexgent/session'
import { scriptedProvider } from '@nexgent/test-support'

const [sessionsDir, sessionId, projectRoot] = process.argv.slice(2)
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const thinking = tag => [{ type: 'thinking', thinking: `secret reasoning ${tag}`, signature: `sig-${tag}` }]

const store = new JsonlSessionStore({ sessionsDir })
await store.create({ sessionId, projectRoot, model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write' })
let memory = []

async function user(turn, content, source = 'user') {
  await store.append(sessionId, { type: 'user.message', turn, content, source })
  memory.push({ role: 'user', content })
}
async function reply(turn, step, content, toolCall) {
  const providerContent = thinking(`${turn}-${step}`)
  await store.append(sessionId, {
    type: 'assistant.message', turn, step, requestId: `req-${turn}-${step}`, content,
    ...(toolCall ? { toolCalls: [toolCall] } : {}), providerContent, usage, finishReason: toolCall ? 'tool-calls' : 'stop',
  })
  memory.push({ role: 'assistant', content, ...(toolCall ? { toolCalls: [toolCall] } : {}), providerContent })
}
async function result(turn, step, call, content) {
  await store.append(sessionId, { type: 'tool.result', turn, step, toolCallId: call.id, name: call.name, content, isError: false, durationMs: 3 })
  memory.push({ role: 'tool', toolCallId: call.id, name: call.name, content, isError: false })
}
async function fullTurn(turn) {
  await store.append(sessionId, { type: 'turn.start', turn })
  if (turn === 2) await user(turn, 'The user attached these materials: orders.csv', 'inject')
  await user(turn, `request ${turn}`)
  const call = { id: `call_${turn}`, name: 'read_file', arguments: `{"path":"f${turn}.txt"}` }
  await reply(turn, 1, '', call)
  await result(turn, 1, call, `contents ${turn}`)
  await reply(turn, 2, `answer ${turn}`)
  await store.append(sessionId, { type: 'turn.end', turn, reason: { kind: 'completed' } })
}

await fullTurn(1)
await fullTurn(2)
await store.append(sessionId, { type: 'turn.start', turn: 3 })
await user(3, 'request 3')
const call = { id: 'call_3', name: 'read_file', arguments: '{"path":"f3.txt"}' }
await reply(3, 1, '', call)
await result(3, 1, call, 'contents 3')

const compactor = new BasicCompactor({ llm: scriptedProvider([{ content: 'Summary of turn 1.', usage: { inputTokens: 300, outputTokens: 20 } }]), thresholdTokens: 100, env: {} })
const check = { sessionId, turn: 3, step: 2, model: 'claude-sonnet-5-5', messages: memory, lastUsage: { ...usage, inputTokens: 500 }, failedThisTurn: false }
if (!compactor.shouldCompact(check)) throw new Error('expected a compaction')
const done = await compactor.compact(check, new AbortController().signal)
await store.append(sessionId, { type: 'compaction', turn: 3, step: 2, ...done })
memory = applyCompaction(memory, done.summary, done.keepMessages)
await reply(3, 2, 'still working')

process.stdout.write(`${JSON.stringify({ memory, compactedMessages: done.compactedMessages, keepMessages: done.keepMessages })}\n`)
setInterval(() => {}, 1000)
