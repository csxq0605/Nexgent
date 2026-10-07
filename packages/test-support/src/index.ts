/**
 * `@nexgent/test-support` — helpers shared by Nexgent test suites.
 *
 * Step 0 ships only the signature of the scripted model server. Step 1 of the
 * plan (section 4.1, "脚本化 provider") implements it as a local HTTP server
 * that speaks the OpenAI-compatible chat API and replays a scripted sequence
 * of model turns, so kernel / llm / session tests run without a real model.
 */

/** One scripted model reply, matched in order against incoming requests. */
export interface ScriptedTurn {
  /** Text content streamed back to the client. */
  content?: string
  /** Tool calls the "model" emits in this turn. */
  toolCalls?: Array<{ name: string; arguments: unknown }>
  /** Optional fault to inject instead of a reply (step 1 fault injection). */
  fault?: 'timeout' | 'disconnect' | 'http-500'
}

export interface ScriptedModelServerOptions {
  /** Replies in the order the server should produce them. */
  script: ScriptedTurn[]
  /** Port to listen on; `0` (default) picks a free port. */
  port?: number
}

export interface ScriptedModelServer {
  /** Base URL to point the OpenAI-compatible client at. */
  readonly baseUrl: string
  /** Requests received so far, in order. */
  readonly requests: readonly unknown[]
  close(): Promise<void>
}

/**
 * Start a scripted OpenAI-compatible model server.
 *
 * TODO(step 1): implement. See the plan, section 4.1 (`@nexgent/llm` tests use
 * a scripted provider) and section 4.10 ("测试策略" row). Until then this
 * factory only documents the intended contract and throws when called.
 */
export function scriptedModelServer(_options: ScriptedModelServerOptions): Promise<ScriptedModelServer> {
  return Promise.reject(new Error('scriptedModelServer is not implemented yet (plan step 1)'))
}
