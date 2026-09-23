/** Keyless fixed model and durable failpoints for the A3 recovery spike. */

const TOOL = 'spike.recovery_multiply'
const PROVIDER = 'spike-recovery-mock'
const MODEL = 'fixed'
const scenario = process.env.DSH_RECOVERY_SCENARIO
const phase = process.env.DSH_RECOVERY_PHASE
const markerPath = process.env.DSH_RECOVERY_MARKER_PATH
const ledgerPath = process.env.DSH_RECOVERY_LEDGER_PATH
const receiptPath = process.env.DSH_RECOVERY_RECEIPT_PATH
const { closeSync, fsyncSync, openSync, writeSync } = process.getBuiltinModule('node:fs')

if (scenario !== 'completed' && scenario !== 'unknown') {
  throw new Error('DSH_RECOVERY_SCENARIO must be completed or unknown')
}
if (phase !== 'crash' && phase !== 'resume') {
  throw new Error('DSH_RECOVERY_PHASE must be crash or resume')
}
for (const [name, value] of Object.entries({ markerPath, ledgerPath, receiptPath })) {
  if (!value) throw new Error(`${name} is required`)
}

function appendDurable(path, value) {
  const fd = openSync(path, 'a')
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function receipt(type, data = {}) {
  appendDurable(receiptPath, { type, scenario, phase, at: Date.now(), ...data })
}

function publishMarker(value) {
  receipt('failpoint', { value })
  const fd = openSync(markerPath, 'w')
  try {
    writeSync(fd, value)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function waitForCrash() {
  return new Promise(() => { setInterval(() => {}, 60_000) })
}

function toolCall(id) {
  const args = JSON.stringify({ left: 6, right: 7 })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: TOOL, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: TOOL, arguments: args } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textReply(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function callIdOf(message) {
  return String(message.toolCallId ?? message.source?.callId ?? '')
}

function toolMessagesFor(options, callId) {
  return options.messages.filter(message => message.role === 'tool' && callIdOf(message) === callId)
}

export const name = 'nexgent-a3-recovery-spike'
export const inject = ['agents', 'llm', 'tools']

export function apply(ctx) {
  ctx.on('agent/created', ({ agent, source }) => {
    agent.ctx.tools.restrict({ allow: [] })
    agent.ctx.tools.register({
      name: TOOL,
      description: 'Multiply two integers while recording an external execution ledger.',
      parameters: {
        type: 'object',
        properties: { left: { type: 'integer' }, right: { type: 'integer' } },
        required: ['left', 'right'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { value: { type: 'integer' } },
          required: ['value'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        appendDurable(ledgerPath, {
          scenario,
          phase,
          callId: String(exec.callId),
          tool: TOOL,
          arguments: args,
          enteredAt: Date.now(),
        })
        receipt('tool_entered', { sessionId: String(agent.id), callId: String(exec.callId) })
        if (scenario === 'unknown' && phase === 'crash') {
          publishMarker('unknown-tool-entered')
          return waitForCrash()
        }
        return { value: args.left * args.right }
      },
    })
    receipt('tool_registered', {
      sessionId: String(agent.id),
      source,
      schemas: ctx.tools.schemas(agent).map(schema => schema.name),
    })
  })

  const adapter = {
    providerInfo(provider) { return { id: provider, name: provider } },
    providerRetryPolicy() { return undefined },
    imageRequestPricing() { return undefined },
    listModels() { return Promise.resolve([{ id: MODEL, name: MODEL }]) },
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) },
    async prepareCall(provider, model, signal) {
      return {
        model: await this.resolveModel(provider, model, signal),
        stream: options => this.stream(options),
      }
    },
    async * stream(options) {
      const callId = scenario === 'completed' ? 'a3-completed-call' : 'a3-unknown-call'
      const messages = toolMessagesFor(options, callId)
      receipt('model_request', {
        sessionId: String(options.sessionId),
        callId,
        matchingToolMessages: messages.map(message => ({
          isError: message.isError === true,
          content: message.content,
        })),
        visibleTools: (options.tools ?? []).map(tool => tool.name),
      })

      let chunks
      if (phase === 'crash' && messages.length === 0) {
        chunks = toolCall(callId)
      } else if (scenario === 'completed' && phase === 'crash') {
        if (messages.length !== 1 || messages[0].isError === true || !JSON.stringify(messages[0]).includes('42')) {
          throw new Error('completed failpoint did not observe exactly one successful result containing 42')
        }
        publishMarker('completed-result-durable')
        await waitForCrash()
        return
      } else if (scenario === 'completed' && phase === 'resume') {
        if (messages.length !== 1 || messages[0].isError === true || !JSON.stringify(messages[0]).includes('42')) {
          throw new Error('resume did not receive exactly one completed result containing 42')
        }
        chunks = textReply('{"answer":42}')
      } else if (scenario === 'unknown' && phase === 'resume') {
        const text = JSON.stringify(messages)
        if (messages.length !== 1 || messages[0].isError !== true
          || !text.includes('outcome is unknown') || !text.includes('Do not retry blindly')) {
          throw new Error('resume did not receive exactly one unknown-outcome repair result')
        }
        chunks = textReply('{"status":"unknown","action":"verify_external_state"}')
      } else {
        throw new Error(`unexpected recovery state: ${scenario}/${phase} with ${messages.length} matching tool messages`)
      }

      for (const chunk of chunks) {
        options.signal?.throwIfAborted()
        yield chunk
      }
    },
  }
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
