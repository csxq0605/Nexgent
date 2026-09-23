/** Trusted, single-task MiMo adapter for the Stage A3 live connectivity smoke. */

const { createHash, randomUUID } = process.getBuiltinModule('node:crypto')
const {
  closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync,
} = process.getBuiltinModule('node:fs')
const { join, resolve } = process.getBuiltinModule('node:path')
const { pathToFileURL } = process.getBuiltinModule('node:url')

const PROVIDER = 'nexgent-mimo-local'
const MODEL = 'mimo-v2.6-flash'
const TOOL = 'spike.multiply'
const CREDENTIAL_REF = 'NEXGENT_API_KEY'
const MAX_COMPLETION_TOKENS = 256
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 90_000
const receiptPath = process.env.DSH_MIMO_RECEIPT_PATH
const modelProject = process.env.DSH_MIMO_MODEL_PROJECT
const llmEntry = process.env.DSH_MIMO_LLM_ENTRY

if (!receiptPath || !modelProject || !llmEntry) {
  throw new Error('dsh-mimo: required host paths are missing')
}

let receiptSequence = 0
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
  appendDurable(receiptPath, {
    type,
    seq: receiptSequence++,
    at: Date.now(),
    ...data,
  })
}

class SafeFailure extends Error {
  constructor(failureClass, stage, message, remoteOutcomeUnknown = false, details = {}) {
    super(message)
    this.name = 'DshMimoSmokeFailure'
    this.failureClass = failureClass
    this.stage = stage
    this.remoteOutcomeUnknown = remoteOutcomeUnknown
    this.details = details
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function boundedRead(path, limit, label) {
  const size = statSync(path).size
  if (!Number.isSafeInteger(size) || size < 1 || size > limit) {
    throw new SafeFailure('config_preflight', 'config_read', `${label} is missing, empty, or too large`)
  }
  return readFileSync(path, 'utf8')
}

function parseDotEnvValue(text, name) {
  let found
  for (const raw of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    line = line.replace(/^export\s+/u, '')
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const candidate = line.slice(0, separator).trim()
    if (candidate !== name) continue
    if (found !== undefined) {
      throw new SafeFailure('config_preflight', 'credential_resolve', 'credential reference is defined more than once')
    }
    let value = line.slice(separator + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1)
    }
    found = value
  }
  if (typeof found !== 'string' || found.trim() === '') {
    throw new SafeFailure('config_preflight', 'credential_resolve', 'credential reference is not configured')
  }
  return found
}

function normalizeBaseUrl(raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new SafeFailure('config_preflight', 'endpoint_validation', 'configured provider endpoint is invalid')
  }
  const allowed = new Set(['token-plan-cn.xiaomimimo.com', 'api.xiaomimimo.com'])
  if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !/^\/v1\/?$/u.test(parsed.pathname)) {
    throw new SafeFailure('config_preflight', 'endpoint_validation', 'configured provider endpoint is outside the fixed MiMo allowlist')
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`
}

function loadProfile() {
  const root = resolve(modelProject)
  const modelsPath = join(root, 'models.json')
  const dotenvPath = join(root, '.env')
  const modelsText = boundedRead(modelsPath, 64 * 1024, 'models.json')
  let data
  try {
    data = JSON.parse(modelsText)
  } catch {
    throw new SafeFailure('config_preflight', 'config_parse', 'models.json is not valid JSON')
  }
  const provider = data?.providers?.mimo
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new SafeFailure('config_preflight', 'config_schema', 'models.json has no mimo provider object')
  }
  if (provider.api_key !== `\${${CREDENTIAL_REF}}`) {
    throw new SafeFailure('config_preflight', 'credential_reference', 'mimo provider must use the fixed credential reference')
  }
  const models = provider.models
  const configuredModels = Array.isArray(models)
    ? models.flatMap(item => typeof item === 'string' ? [item]
      : item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : [])
    : models !== null && typeof models === 'object' && !Array.isArray(models) ? Object.keys(models) : []
  if (!configuredModels.includes('mimo-v2.5')) {
    throw new SafeFailure('config_preflight', 'config_schema', 'mimo-v2.5 source catalog entry is missing')
  }
  const baseUrl = normalizeBaseUrl(provider.base_url)
  const apiKey = parseDotEnvValue(boundedRead(dotenvPath, 64 * 1024, '.env'), CREDENTIAL_REF)
  const profileIdentity = {
    provider: 'mimo',
    base_url: baseUrl,
    model: MODEL,
    credential_ref: CREDENTIAL_REF,
    models_json_sha256: sha256(Buffer.from(modelsText, 'utf8')),
  }
  return {
    apiKey,
    baseUrl,
    configuredModels,
    profileIdentity,
    profileDigest: sha256(Buffer.from(canonical(profileIdentity), 'utf8')),
  }
}

let profile
try {
  profile = loadProfile()
  receipt('profile_loaded', {
    profile_identity: profile.profileIdentity,
    profile_digest: profile.profileDigest,
    credential_configured: true,
    source_catalog_contains_target: profile.configuredModels.includes(MODEL),
    target_model_override: !profile.configuredModels.includes(MODEL),
  })
} catch (error) {
  const failure = error instanceof SafeFailure ? error
    : new SafeFailure('config_preflight', 'config_load', 'local model configuration could not be loaded')
  receipt('adapter_failure', {
    failure_class: failure.failureClass,
    stage: failure.stage,
    remote_outcome_unknown: failure.remoteOutcomeUnknown,
  })
  throw failure
}

let attributionHeaders
try {
  const imported = await import(pathToFileURL(resolve(llmEntry)).href)
  if (typeof imported.attributionHeaders !== 'function') throw new Error('missing export')
  attributionHeaders = imported.attributionHeaders
} catch {
  const failure = new SafeFailure('config_preflight', 'adapter_attribution', 'fixed DSH attribution helper could not be loaded')
  receipt('adapter_failure', {
    failure_class: failure.failureClass,
    stage: failure.stage,
    remote_outcome_unknown: false,
    profile_digest: profile.profileDigest,
  })
  throw failure
}

function textOf(content) {
  if (!Array.isArray(content)) throw new SafeFailure('provider_protocol', 'request_serialize', 'message content is not an array')
  const texts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block?.type !== 'reasoning' && block?.type !== 'tool-call') {
      throw new SafeFailure('provider_protocol', 'request_serialize', 'unsupported message content reached the live adapter')
    }
  }
  return texts.join('')
}

function serializeMessages(options) {
  const result = []
  if (typeof options.system === 'string' && options.system) result.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    if (message.role === 'system' || message.role === 'user') {
      result.push({ role: message.role, content: textOf(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const toolCalls = message.content.filter(block => block?.type === 'tool-call').map(block => ({
        id: String(block.id),
        type: 'function',
        function: { name: block.name, arguments: block.arguments },
      }))
      const text = textOf(message.content)
      result.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    if (message.role === 'tool') {
      result.push({ role: 'tool', tool_call_id: String(message.toolCallId), content: textOf(message.content) })
      continue
    }
    throw new SafeFailure('provider_protocol', 'request_serialize', 'unsupported message role reached the live adapter')
  }
  return result
}

function usageOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeFailure('provider_protocol', 'response_usage', 'provider response has no usage object')
  }
  const inputTokens = value.prompt_tokens
  const outputTokens = value.completion_tokens
  const totalTokens = value.total_tokens
  if (![inputTokens, outputTokens, totalTokens].every(item => Number.isSafeInteger(item) && item >= 0)) {
    throw new SafeFailure('provider_protocol', 'response_usage', 'provider usage counters are missing or invalid')
  }
  return { inputTokens, outputTokens, totalTokens }
}

async function boundedResponseText(body) {
  if (body === null) throw new SafeFailure('provider_protocol', 'response_read', 'provider response has no body')
  const reader = body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        throw new SafeFailure('provider_protocol', 'response_read', 'provider response exceeded the fixed byte limit')
      }
      chunks.push(next.value)
    }
  } finally {
    try { await reader.cancel() } catch {}
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

const requestCounts = new Map()
async function providerCompletion(options) {
  if (options.provider !== PROVIDER || options.model !== MODEL || options.purpose !== undefined) {
    throw new SafeFailure('admission_budget', 'route_admission', 'request does not match the fixed live-smoke route')
  }
  const sessionId = String(options.sessionId ?? '')
  if (!sessionId) throw new SafeFailure('admission_budget', 'route_admission', 'request has no durable session identity')
  const ordinal = (requestCounts.get(sessionId) ?? 0) + 1
  if (ordinal > 2) throw new SafeFailure('admission_budget', 'request_count', 'provider request count exceeded the fixed limit')
  requestCounts.set(sessionId, ordinal)

  const toolResults = options.messages.filter(message => message.role === 'tool'
    && String(message.toolCallId) !== '')
  if (ordinal === 1 && toolResults.length !== 0) {
    throw new SafeFailure('provider_protocol', 'request_history', 'first provider request already contains a tool result')
  }
  if (ordinal === 2 && toolResults.length !== 1) {
    throw new SafeFailure('provider_protocol', 'request_history', 'second provider request does not contain exactly one tool result')
  }
  if (!Array.isArray(options.tools) || options.tools.length !== 1 || options.tools[0]?.name !== TOOL) {
    throw new SafeFailure('tool_contract', 'tool_schema', 'request did not expose exactly the diagnostic multiply tool')
  }
  const schema = options.tools[0]
  const body = {
    model: MODEL,
    messages: serializeMessages(options),
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    thinking: { type: 'disabled' },
    tools: [{
      type: 'function',
      function: { name: schema.name, description: schema.description, parameters: schema.parameters },
    }],
    tool_choice: ordinal === 1
      ? { type: 'function', function: { name: TOOL } }
      : 'none',
    ...(ordinal === 2 ? { response_format: { type: 'json_object' } } : {}),
  }
  const encoded = Buffer.from(JSON.stringify(body), 'utf8')
  if (encoded.byteLength > MAX_REQUEST_BYTES) {
    throw new SafeFailure('admission_budget', 'request_size', 'provider request exceeded the fixed byte limit')
  }
  const requestId = `mimo-smoke-${randomUUID()}`
  receipt('provider_request_started', {
    request_id: requestId,
    session_id: sessionId,
    ordinal,
    configured_model: MODEL,
    profile_digest: profile.profileDigest,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    request_body_sha256: sha256(encoded),
    tool_choice: ordinal === 1 ? 'required_exact_function' : 'none',
  })

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response
  try {
    response = await fetch(`${profile.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        ...attributionHeaders(),
        authorization: `Bearer ${profile.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: encoded,
    })
  } catch {
    throw new SafeFailure('transport', 'provider_request', 'provider request did not return an HTTP response', true)
  }
  let responseText
  try {
    responseText = await boundedResponseText(response.body)
  } catch (error) {
    if (error instanceof SafeFailure) throw error
    throw new SafeFailure('transport', 'response_read', 'provider response ended before a bounded body was read', true)
  }
  if (!response.ok) {
    const failureClass = response.status === 401 || response.status === 403 ? 'provider_auth'
      : response.status === 429 ? 'provider_rate_or_quota'
        : response.status >= 500 ? 'provider_server' : 'provider_http'
    throw new SafeFailure(failureClass, 'provider_http', `provider returned HTTP ${response.status}`)
  }
  let payload
  try {
    payload = JSON.parse(responseText)
  } catch {
    throw new SafeFailure('provider_protocol', 'response_decode', 'provider returned non-JSON content')
  }
  if (payload?.model !== MODEL) {
    throw new SafeFailure('model_identity_mismatch', 'response_identity', 'provider observed model differs from the fixed target')
  }
  const choice = Array.isArray(payload.choices) && payload.choices.length === 1 ? payload.choices[0] : undefined
  const message = choice?.message
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new SafeFailure('provider_protocol', 'response_choice', 'provider response has no unique assistant message')
  }
  const usage = usageOf(payload.usage)
  const common = {
    request_id: requestId,
    session_id: sessionId,
    ordinal,
    response_id: typeof payload.id === 'string' ? payload.id.slice(0, 500) : null,
    configured_model: MODEL,
    observed_model: payload.model,
    finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason.slice(0, 100) : null,
    usage,
    profile_digest: profile.profileDigest,
  }
  const contentKind = message.content === null ? 'null'
    : Array.isArray(message.content) ? 'array' : typeof message.content
  receipt('provider_response_observed', {
    ...common,
    message_content_kind: contentKind,
    message_content_bytes: typeof message.content === 'string'
      ? Buffer.byteLength(message.content, 'utf8') : null,
    provider_content_sha256: typeof message.content === 'string'
      ? sha256(Buffer.from(message.content, 'utf8')) : null,
    native_tool_call_count: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
  })

  if (ordinal === 1) {
    const toolCalls = message.tool_calls
    if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
      throw new SafeFailure('provider_protocol', 'tool_call_decode', 'provider did not return exactly one native tool call')
    }
    const call = toolCalls[0]
    const callId = call?.id
    const name = call?.function?.name
    const argumentsText = call?.function?.arguments
    let args
    try { args = JSON.parse(argumentsText) } catch {
      throw new SafeFailure('provider_protocol', 'tool_call_decode', 'provider tool arguments are not JSON')
    }
    if (typeof callId !== 'string' || !callId || name !== TOOL
      || args === null || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).sort().join(',') !== 'left,right' || args.left !== 6 || args.right !== 7) {
      throw new SafeFailure('provider_protocol', 'tool_call_contract', 'provider native tool call differs from the fixed task')
    }
    receipt('provider_response_received', {
      ...common,
      outcome: 'native_tool_call',
      tool_call_id: callId,
      tool_name: name,
      tool_arguments: args,
    })
    return { ordinal, usage, callId, argumentsText }
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    throw new SafeFailure('provider_protocol', 'final_decode', 'second provider response attempted another tool call')
  }
  const content = message.content
  let final
  try { final = JSON.parse(typeof content === 'string' ? content.trim() : '') } catch {
    throw new SafeFailure('provider_protocol', 'final_decode', 'provider final is not a JSON object', false, {
      message_content_kind: contentKind,
      message_content_bytes: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : null,
      provider_content_sha256: typeof content === 'string' ? sha256(Buffer.from(content, 'utf8')) : null,
      finish_reason: common.finish_reason,
      usage,
    })
  }
  if (final === null || typeof final !== 'object' || Array.isArray(final)
    || Object.keys(final).join(',') !== 'answer' || final.answer !== 42) {
    throw new SafeFailure('final_semantics', 'final_validate', 'provider final differs from the fixed answer')
  }
  const finalText = JSON.stringify(final)
  receipt('provider_response_received', {
    ...common,
    outcome: 'final_json',
    provider_content_sha256: sha256(Buffer.from(content, 'utf8')),
    final: finalText,
  })
  return { ordinal, usage, finalText }
}

export const name = 'nexgent-a3-mimo-live-smoke'
export const inject = ['agents', 'llm', 'tools']

export function apply(ctx) {
  ctx.on('agent/created', ({ agent, source }) => {
    agent.ctx.tools.restrict({ allow: [] })
    agent.ctx.tools.register({
      name: TOOL,
      description: 'Multiply two integers for a fixed diagnostic connectivity task.',
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
        if (args.left !== 6 || args.right !== 7) {
          throw new SafeFailure('tool_contract', 'tool_execute', 'diagnostic multiply arguments differ from the fixed task')
        }
        const value = args.left * args.right
        receipt('tool_executed', {
          session_id: String(agent.id),
          call_id: String(exec.callId),
          tool: TOOL,
          arguments: { left: args.left, right: args.right },
          result: { value },
        })
        return { value }
      },
    })
    receipt('tool_registered', {
      session_id: String(agent.id),
      source,
      tool: TOOL,
      visible_tools: ctx.tools.schemas(agent).map(schema => schema.name),
    })
  })

  const adapter = {
    providerInfo(provider) { return { id: provider, name: 'Local MiMo live smoke' } },
    providerRetryPolicy() {
      return {
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: [],
        initialDelayMs: 1,
        maxDelayMs: 1,
        jitterRatio: 0,
      }
    },
    imageRequestPricing() { return undefined },
    listModels() { return Promise.resolve([{ id: MODEL, name: MODEL, contextWindow: 128000, maxTokens: MAX_COMPLETION_TOKENS }]) },
    resolveModel(provider, model) {
      if (provider !== PROVIDER || model !== MODEL) {
        return Promise.reject(new SafeFailure('admission_budget', 'model_resolve', 'model route differs from the fixed live target'))
      }
      return Promise.resolve({ provider, id: model, name: model, contextWindow: 128000, maxTokens: MAX_COMPLETION_TOKENS })
    },
    async prepareCall(provider, model, signal) {
      return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) }
    },
    async * stream(options) {
      try {
        const result = await providerCompletion(options)
        if (result.ordinal === 1) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: result.callId, name: TOOL, argumentsDelta: result.argumentsText }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: result.callId, name: TOOL, arguments: result.argumentsText } }
          yield { type: 'usage', usage: result.usage }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: result.finalText }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: result.finalText } }
          yield { type: 'usage', usage: result.usage }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      } catch (error) {
        const failure = error instanceof SafeFailure ? error
          : new SafeFailure('provider_protocol', 'adapter_stream', 'live adapter failed without a classified result')
        receipt('adapter_failure', {
          failure_class: failure.failureClass,
          stage: failure.stage,
          remote_outcome_unknown: failure.remoteOutcomeUnknown,
          profile_digest: profile.profileDigest,
          session_id: String(options.sessionId ?? ''),
          ordinal: requestCounts.get(String(options.sessionId ?? '')) ?? 0,
          details: failure.details,
        })
        throw failure
      }
    },
  }
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
