/**
 * The Anthropic Messages API request built from a contract {@link LLMRequest}:
 * message conversion (incl. preserved-thinking replay and tool-result
 * merging), tool definitions, thinking / effort mapping and prompt caching.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { Effort, JsonValue, LLMMessage, LLMRequest, ThinkingMode } from '@nexgent/kernel'

/** Beta header enabling server-side refusal fallbacks (`fallbacks: 'default'`). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** Settings the provider applies to every request. */
export interface WireOptions {
  /** `output_config.effort` when the request names none. */
  readonly effort: Effort
  /** `max_tokens` when the request names none. */
  readonly maxTokens: number
}

/** Defaults of {@link WireOptions} (ADR 0002). */
export const DEFAULT_WIRE_OPTIONS: WireOptions = Object.freeze({ effort: 'medium', maxTokens: 16000 }) as WireOptions

/** The request body before the SDK adds `stream: true` (and, on the beta route, `betas` / `fallbacks`). */
export type MessageParams = Anthropic.MessageStreamParams

/**
 * The `thinking` parameter for a mode and effort. `'off'` is `between_tools`
 * (the lowest setting on Claude Sonnet 5.5), which the API only accepts at
 * effort `high` or below; at `xhigh` / `max` the parameter is omitted, which
 * means adaptive thinking. `'on'` is adaptive with summarized display. Never
 * `disabled` and never `budget_tokens` (both are rejected with 400).
 * @param mode - the request's thinking mode.
 * @param effort - the effective effort level.
 */
export function thinkingParam(mode: ThinkingMode, effort: Effort): Anthropic.ThinkingConfigParam | undefined {
  if (mode === 'on') return { type: 'adaptive', display: 'summarized' }
  return effort === 'xhigh' || effort === 'max' ? undefined : { type: 'between_tools' }
}

/** Parse tool-call arguments for replay; unparsable text becomes `{}` (the API wants an object). */
function parseInput(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function assistantContent(message: Extract<LLMMessage, { role: 'assistant' }>): Anthropic.ContentBlockParam[] {
  if (Array.isArray(message.providerContent)) {
    // Preserved thinking: the reply's own blocks (thinking + signature, text, tool_use), verbatim.
    return message.providerContent as unknown as Anthropic.ContentBlockParam[]
  }
  const blocks: Anthropic.ContentBlockParam[] = []
  if (message.content !== '') blocks.push({ type: 'text', text: message.content })
  for (const call of message.toolCalls ?? []) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseInput(call.arguments) })
  }
  return blocks
}

/**
 * Convert contract messages to the wire form. `system` becomes the top-level
 * system prompt (the last one wins; the loop sends exactly one). Consecutive
 * `tool` messages merge into one `user` turn of `tool_result` blocks, as the
 * API requires every `tool_use` of a turn to be answered in the next single
 * user message. Order is kept as given; nothing is reordered.
 * @param messages - the request's messages.
 */
export function toWireMessages(messages: readonly LLMMessage[]): { system: string | undefined; messages: Anthropic.MessageParam[] } {
  let system: string | undefined
  const out: Anthropic.MessageParam[] = []
  let results: Anthropic.ToolResultBlockParam[] | undefined
  for (const message of messages) {
    if (message.role === 'tool') {
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
        ...message.isError ? { is_error: true } : {},
      }
      if (results === undefined) {
        results = [block]
        out.push({ role: 'user', content: results })
      } else {
        results.push(block)
      }
      continue
    }
    results = undefined
    switch (message.role) {
      case 'system':
        system = message.content
        break
      case 'user':
        out.push({ role: 'user', content: message.content })
        break
      case 'assistant': {
        const content = assistantContent(message)
        // The API rejects an empty assistant turn; keep the turn with an empty text block.
        out.push({ role: 'assistant', content: content.length === 0 ? [{ type: 'text', text: '' }] : content })
        break
      }
    }
  }
  return { system, messages: out }
}

/**
 * Build the Messages API parameters for one request. `temperature` (and
 * every other sampling parameter) is never sent — Claude Sonnet 5.5 rejects
 * non-default values — and no `tool_choice` is forced. Top-level
 * `cache_control` auto-caches the last cacheable block of the prompt.
 * @param request - the contract request.
 * @param model - the model id to send (request model or the provider default).
 * @param options - provider defaults for effort and `max_tokens`.
 */
export function buildMessageParams(request: LLMRequest, model: string, options: WireOptions = DEFAULT_WIRE_OPTIONS): MessageParams {
  const effort = request.effort ?? options.effort
  const { system, messages } = toWireMessages(request.messages)
  const thinking = thinkingParam(request.thinking, effort)
  const params: MessageParams = {
    model,
    max_tokens: request.maxTokens ?? options.maxTokens,
    messages,
    ...system === undefined ? {} : { system },
    ...thinking === undefined ? {} : { thinking },
    output_config: { effort },
    cache_control: { type: 'ephemeral' },
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    params.tools = request.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
      eager_input_streaming: true,
    }))
  }
  return params
}

/** Deep-copy a value into plain JSON (drops `undefined` members and prototypes). */
export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
