/** DSH public LLM adapter. The host gateway alone owns provider credentials. */
export const name = 'nexgent-native-model'
export const inject = ['llm']

function textOf(blocks) {
  if (!Array.isArray(blocks) || blocks.some(block => block.type !== 'text')) {
    throw new Error('This native adapter currently supports text and tool content only')
  }
  return blocks.map(block => block.text).join('')
}

function messagesOf(options) {
  const result = options.system ? [{ role: 'system', content: options.system }] : []
  for (const message of options.messages) {
    if (message.role === 'assistant') {
      const calls = message.content.filter(block => block.type === 'tool-call').map(block => ({
        id: String(block.id), type: 'function', function: { name: block.name, arguments: block.arguments },
      }))
      const content = textOf(message.content.filter(block => block.type !== 'tool-call')) || null
      result.push({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) })
    } else if (message.role === 'tool') {
      result.push({ role: 'tool', tool_call_id: String(message.toolCallId), content: textOf(message.content) })
    } else if (message.role === 'system' || message.role === 'user') {
      result.push({ role: message.role, content: textOf(message.content) })
    } else {
      throw new Error('Unsupported native message role')
    }
  }
  return result
}

export function apply(ctx) {
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'Nexgent host model gateway' }),
    providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 0, retryableCodes: [],
      initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
    imageRequestPricing: () => undefined,
    listModels: async () => [{ id: 'nexgent-configured', name: 'Configured Nexgent model',
      contextWindow: 128000, maxTokens: 4000 }],
    async resolveModel(provider, model) {
      if (provider !== 'nexgent-host' || model !== 'nexgent-configured') throw new Error('Invalid native model route')
      return { provider, id: model, name: model, contextWindow: 128000, maxTokens: 4000 }
    },
    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
    },
    async *stream(options) {
      const response = await fetch(process.env.NEXGENT_BRIDGE_URL+'/v1/chat/completions', {
        method: 'POST', signal: options.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+process.env.NEXGENT_BRIDGE_TOKEN },
        body: JSON.stringify({ model: 'nexgent-configured', messages: messagesOf(options),
          tools: (options.tools ?? []).map(tool => ({ type: 'function', function: {
            name: tool.name, description: tool.description, parameters: tool.parameters } })),
          max_completion_tokens: options.maxTokens ?? 4000 }),
      })
      if (!response.ok) throw new Error('Host rejected native model request ('+response.status+')')
      const value = await response.json()
      const choice = value.choices[0]
      let index = 0
      if (choice.message.content) {
        const text = choice.message.content
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text }
        yield { type: 'block-end', index, block: { type: 'text', text } }
        index++
      }
      for (const call of choice.message.tool_calls) {
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: call.id, name: call.function.name, argumentsDelta: call.function.arguments }
        yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id,
          name: call.function.name, arguments: call.function.arguments } }
        index++
      }
      yield { type: 'usage', usage: { inputTokens: value.usage.prompt_tokens,
        outputTokens: value.usage.completion_tokens, totalTokens: value.usage.total_tokens } }
      yield { type: 'finish', reason: { kind: choice.finish_reason === 'tool_calls' ? 'tool-calls' : 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['nexgent-host'], adapter)
}
