#!/usr/bin/env node
/**
 * Manual real-model check for `@nexgent/llm` (never run by the test suite):
 * one tool-calling request to Claude Sonnet 5.5, printing the stream events,
 * the usage and the ledger pair. Requires the package to be built and a key:
 *
 *   NEXGENT_API_KEY=sk-ant-... node packages/llm/scripts/smoke.mjs [--model claude-sonnet-5-5] [--thinking on]
 *
 * `NEXGENT_API_BASE_URL` redirects the request (proxy, fake server). The key
 * is never printed.
 */
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { createProvider } from '../dist/index.js'

const { values } = parseArgs({ options: { model: { type: 'string' }, thinking: { type: 'string', default: 'off' }, effort: { type: 'string' } }, strict: true })

const records = []
const ledger = {
  writeFailures: 0,
  async append(record) {
    const full = { ...record, ts: new Date().toISOString() }
    records.push(full)
    return full
  },
  async *read() {},
}
const credentials = {
  async get(name) { return process.env[name] },
  async describe(name) { return { configured: process.env[name] !== undefined, source: 'env' } },
}

const llm = createProvider({ credentials, ledger })
const request = {
  requestId: randomUUID(),
  model: values.model ?? llm.info.defaultModel,
  thinking: values.thinking === 'on' ? 'on' : 'off',
  ...values.effort === undefined ? {} : { effort: values.effort },
  messages: [
    { role: 'system', content: 'You are a terse assistant. Use the write_file tool to do what the user asks; do not explain.' },
    { role: 'user', content: 'Write the text "hi" to notes.md.' },
  ],
  tools: [{
    name: 'write_file',
    description: 'Write a text file in the project.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  }],
}

console.log(`endpoint ${llm.info.endpoint} model ${request.model} thinking ${request.thinking}`)
const events = []
for await (const event of llm.complete(request, { purpose: 'auxiliary' })) {
  events.push(event)
  if (event.type === 'text.delta') process.stdout.write(event.text)
  else if (event.type === 'reasoning.delta') process.stdout.write(`\x1b[2m${event.text}\x1b[0m`)
  else console.log(`\n[${event.type}] ${JSON.stringify(event)}`)
}
const toolCalls = events.filter(event => event.type === 'tool-call.end')
const done = events.at(-1)
console.log('\n--- summary')
console.log(`terminal: ${JSON.stringify(done)}`)
console.log(`tool calls: ${toolCalls.length}${toolCalls.map(e => ` ${e.call.name}(${e.call.arguments})`).join('')}`)
console.log(`usage: ${JSON.stringify(events.find(event => event.type === 'usage')?.usage ?? 'none')}`)
console.log(`ledger: ${JSON.stringify(records)}`)
const ok = done?.type === 'done' && done.finishReason === 'tool-calls' && toolCalls.length === 1
  && (() => { try { JSON.parse(toolCalls[0].call.arguments); return true } catch { return false } })()
console.log(ok ? 'PASS' : 'FAIL')
process.exitCode = ok ? 0 : 1
