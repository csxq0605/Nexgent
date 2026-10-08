/**
 * The OpenAI-compatible `/chat/completions` request body built from a
 * contract {@link LLMRequest}.
 */
import type { JsonObject, JsonValue, LLMMessage, LLMRequest, ThinkingMode } from '@nexgent/kernel'

/** Route-specific request quirks. */
export interface WireOptions {
  /**
   * Extra body fields merged per thinking mode. The MiMo route takes
   * `thinking: { type: 'disabled' | 'enabled' }`; another route may need
   * e.g. `{ enable_thinking: false }` or `{ reasoning_effort: 'none' }`.
   */
  readonly thinkingParams: Readonly<Record<ThinkingMode, JsonObject>>
  /** Body field for the output cap: `max_tokens` (default) or `max_completion_tokens`. */
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens'
  /** Whether `tool` messages repeat the tool name as `name`. */
  readonly toolMessageName: boolean
}

/** Defaults for the MiMo route. */
export const DEFAULT_WIRE_OPTIONS: WireOptions = Object.freeze({
  thinkingParams: Object.freeze({
    off: Object.freeze({ thinking: Object.freeze({ type: 'disabled' }) }),
    on: Object.freeze({ thinking: Object.freeze({ type: 'enabled' }) }),
  }),
  maxTokensField: 'max_tokens',
  toolMessageName: false,
}) as WireOptions

function toWireMessage(message: LLMMessage, options: WireOptions): JsonObject {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content }
    case 'assistant': {
      if (message.toolCalls === undefined || message.toolCalls.length === 0) {
        return { role: 'assistant', content: message.content }
      }
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      }
    }
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        ...options.toolMessageName ? { name: message.name } : {},
        content: message.content,
      }
  }
}

/**
 * Build the streaming request body.
 * @param request - the contract request.
 * @param model - the model id to send (request model or the provider default).
 * @param options - route quirks.
 */
export function buildRequestBody(request: LLMRequest, model: string, options: WireOptions = DEFAULT_WIRE_OPTIONS): JsonObject {
  const body: Record<string, JsonValue> = {
    model,
    messages: request.messages.map(message => toWireMessage(message, options)),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body['tools'] = request.tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  if (request.maxTokens !== undefined) body[options.maxTokensField] = request.maxTokens
  if (request.temperature !== undefined) body['temperature'] = request.temperature
  Object.assign(body, options.thinkingParams[request.thinking])
  return body
}
