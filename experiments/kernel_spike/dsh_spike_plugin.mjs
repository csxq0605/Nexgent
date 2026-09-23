/** Keyless fixed model plus one Agent-scoped Stage A multiply tool. */

const TOOL = 'spike.multiply'
const PROVIDER = 'spike-mock'
const MODEL = 'fixed'
const receiptPath = process.env.DSH_SPIKE_RECEIPT_PATH
const { appendFileSync } = process.getBuiltinModule('node:fs')

function receipt(type, data = {}) {
  if (!receiptPath) throw new Error('DSH_SPIKE_RECEIPT_PATH is required')
  appendFileSync(receiptPath, `${JSON.stringify({ type, at: Date.now(), ...data })}\n`)
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

export const name = 'nexgent-stage-a-dsh-spike'
export const inject = ['agents', 'llm', 'tools']

export function apply(ctx) {
  let primary
  let probeDone = false

  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: [] })
    if (primary !== undefined) return
    primary = agent
    let unload = () => {}
    unload = agent.ctx.tools.register({
      name: TOOL,
      description: 'Multiply two integers in this task scope.',
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
      async execute(args) {
        const value = args.left * args.right
        unload()
        receipt('tool_unloaded', {
          sessionId: String(agent.id),
          tool: TOOL,
          visibleAfter: ctx.tools.schemas(agent).some(schema => schema.name === TOOL),
        })
        return { value }
      },
    })
    receipt('tool_installed', {
      sessionId: String(agent.id),
      tool: TOOL,
      schemas: ctx.tools.schemas(agent).map(schema => schema.name),
    })
  })

  async function proveSiblingScope() {
    if (probeDone) return
    probeDone = true
    const handle = await ctx.agents.create({
      sessionId: 'dsh-spike-other-scope',
      meta: { cwd: process.cwd() },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    try {
      const schemas = ctx.tools.schemas(handle.agent).map(schema => schema.name)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'scope-probe-call',
        name: TOOL,
        arguments: { left: 6, right: 7 },
        agent: handle.agent,
      })
      receipt('scope_probe', {
        sessionId: String(handle.agent.id),
        schemas,
        isError: result.isError,
        content: result.content,
      })
      if (schemas.includes(TOOL) || !result.isError) throw new Error('multiply leaked into sibling Agent scope')
    } finally {
      await handle.dispose()
    }
  }

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
      await proveSiblingScope()
      const tools = (options.tools ?? []).map(tool => tool.name)
      const toolMessages = options.messages.filter(message => message.role === 'tool')
      receipt('model_request', {
        sessionId: String(options.sessionId),
        step: toolMessages.length + 1,
        tools,
        toolErrors: toolMessages.map(message => message.isError),
      })
      let chunks
      if (toolMessages.length === 0) {
        if (tools.length !== 1 || tools[0] !== TOOL) throw new Error('initial request lacks the scoped multiply schema')
        chunks = toolCall('multiply-success-call')
      } else if (toolMessages.length === 1) {
        if (toolMessages[0].isError || !JSON.stringify(toolMessages[0]).includes('{\\"value\\":42}')) {
          throw new Error('first multiply call did not return 42')
        }
        if (tools.includes(TOOL)) throw new Error('multiply remained visible after its disposer ran')
        chunks = toolCall('multiply-after-unload-call')
      } else if (toolMessages.length === 2) {
        if (!toolMessages[1].isError || !JSON.stringify(toolMessages[1]).includes(`unknown tool \\"${TOOL}\\"`)) {
          throw new Error('post-unload multiply call did not fail as unknown')
        }
        chunks = textReply('{"answer":42}')
      } else {
        throw new Error(`unexpected fixed-model step ${toolMessages.length + 1}`)
      }
      for (const chunk of chunks) {
        options.signal?.throwIfAborted()
        yield chunk
      }
    },
  }
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
